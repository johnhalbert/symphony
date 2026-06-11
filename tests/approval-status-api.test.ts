import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StatusServer } from "../src/app/http.js";
import { resolveStatusMutationToken } from "../src/app/RuntimeDependencies.js";
import {
  CompletionReportService,
  PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON,
  PUBLICATION_APPROVAL_SETUP_INCOMPLETE_REASON,
  type CompletionReportPullRequestPublication,
  type CompletionReportPullRequestPublicationInput,
  type CompletionReportPullRequestPublisher,
} from "../src/core/CompletionReportService.js";
import {
  FileOperatorApprovalStore,
  OPERATOR_REJECTED_PUBLICATION_ERROR,
  OperatorApprovalService,
  type OperatorApprovalAction,
  type OperatorApprovalRecord,
} from "../src/core/approval/OperatorApprovalService.js";
import type { ProjectContextResolution } from "../src/core/config/ProjectContexts.js";
import { parseServiceConfig, type ServiceConfig } from "../src/core/config/Config.js";
import { SymphonyError } from "../src/core/errors.js";
import type { AgentEvent, AgentHarness, AgentRunContext } from "../src/core/harness/AgentHarness.js";
import { FakeHarness } from "../src/core/harness/FakeHarness.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import { Orchestrator } from "../src/core/orchestrator/Orchestrator.js";
import { FileIssueLifecycleStore } from "../src/core/persistence/IssueLifecycleStore.js";
import { FileRunTranscriptStore, type RunRecord } from "../src/core/persistence/RunTranscriptStore.js";
import type { TrackerClient } from "../src/core/tracker/TrackerClient.js";
import type { TrackerCommentInput, TrackerTransitionInput, TrackerWriteResult, TrackerWriter } from "../src/core/tracker/TrackerWriter.js";
import type { Issue } from "../src/core/types.js";
import { FileWritebackOutboxStore, WritebackProcessor } from "../src/core/writeback/WritebackOutbox.js";
import { WorkspaceManager } from "../src/core/workspace/WorkspaceManager.js";
import { CursorWorkspaceOpener } from "../cursor/src/CursorWorkspaceOpener.js";
import { issue, multiProjectWorkflowConfig, projectContextFixture, testConfig } from "./helpers.js";

describe("approval status API", () => {
  let root: string;
  let config: ServiceConfig;
  let runStore: FileRunTranscriptStore;
  let lifecycleStore: FileIssueLifecycleStore;
  let store: FileOperatorApprovalStore;
  let service: OperatorApprovalService;

  const docsProjectContext: ProjectContextResolution = {
    projectContextId: "docs",
    projectContextLabel: "Documentation Site",
    linearProjectSlug: "DOCS",
    routingSource: "operator_request",
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-approval-api-"));
    config = testConfig(root);
    config.github.publishPullRequests = true;
    config.github.operatorApproval!.requiredForPublication = true;
    config.github.operatorApproval!.rejectPolicy = "cancel";
    runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    store = new FileOperatorApprovalStore(config.workspace.stateDir);
    service = new OperatorApprovalService({ config, store, runStore });
    await runStore.startRun({
      runId: "run-1",
      sessionId: "session-1",
      agentId: "agent-1",
      role: "worker",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      attempt: null,
      turnNumber: 1,
      prompt: "work",
      workspaceKey: "TEST-1",
      workspacePath: path.join(root, "workspace"),
    });
  });

  afterEach(async () => {
    await rmWithRetry(root);
  });

  it("requires the mutation token and approves pending requests", async () => {
    const pending = await createPending("idem-1");
    const resumed: OperatorApprovalRecord[] = [];
    const server = statusServer({ resumed });
    const address = await server.start();
    try {
      const baseUrl = `http://${address.host}:${address.port}`;
      const denied = await fetch(`${baseUrl}/api/v1/approval-requests/${pending.requestId}`, {
        method: "POST",
        body: JSON.stringify({ decision: "approve" }),
      });
      const wrongToken = await fetch(`${baseUrl}/api/v1/approval-requests/${pending.requestId}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-symphony-token": "wrong" },
        body: JSON.stringify({ decision: "approve" }),
      });
      const approved = await fetch(`${baseUrl}/api/v1/approval-requests/${pending.requestId}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-symphony-token": "secret" },
        body: JSON.stringify({ decision: "approve" }),
      });
      const issueResponse = await fetch(`${baseUrl}/api/v1/issues/TEST-1`);
      const approvedBody = (await approved.json()) as { request: { status: string } };
      const issueBody = (await issueResponse.json()) as { capabilities: { pendingApproval: { active: boolean } } };

      expect(denied.status).toBe(401);
      expect(wrongToken.status).toBe(401);
      expect(approved.status).toBe(200);
      expect(approvedBody.request.status).toBe("approved");
      expect(issueBody.capabilities.pendingApproval.active).toBe(false);
      expect(resumed).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  it("uses the approval request project context for HTTP approval payloads and token enforcement", async () => {
    configureMultiProjectApprovalConfig({
      topLevelGithub: {
        publish_pull_requests: false,
        operator_approval: {
          required_for_publication: false,
          reject_policy: "cancel",
          poll_interval_ms: 5,
        },
      },
      docsGithub: {
        publish_pull_requests: true,
        operator_approval: {
          required_for_publication: true,
          reject_policy: "fail",
          poll_interval_ms: 5,
        },
      },
      topLevelCredentialProfiles: {
        profiles: {
          "open-workspace": {
            value: "$DEFAULT_OPEN_WORKSPACE_TOKEN",
            capabilities: ["server.open_workspace"],
          },
        },
        roles: {
          worker: {
            "server.open_workspace": "open-workspace",
          },
        },
      },
      docsCredentialProfiles: {
        profiles: {
          "open-workspace": {
            value: "$DOCS_OPEN_WORKSPACE_TOKEN",
            capabilities: ["server.open_workspace"],
          },
        },
        roles: {
          worker: {
            "server.open_workspace": "open-workspace",
          },
        },
      },
    });
    const pending = await createPending("idem-docs-required", null, docsProjectContext);
    const resumed: OperatorApprovalRecord[] = [];
    const defaultToken = resolveStatusMutationToken(config);
    const docsToken = resolveStatusMutationToken(config, docsProjectContext.projectContextId);
    const server = statusServer({
      resumed,
      openWorkspaceToken: defaultToken,
      resolveOpenWorkspaceToken: (projectContextId) => resolveStatusMutationToken(config, projectContextId),
    });
    const address = await server.start();
    try {
      const baseUrl = `http://${address.host}:${address.port}`;
      const approvalResponseRaw = await fetch(`${baseUrl}/api/v1/approval-requests/${pending.requestId}`);
      const issueResponse = await fetch(`${baseUrl}/api/v1/issues/TEST-1`);
      const denied = await fetch(`${baseUrl}/api/v1/approval-requests/${pending.requestId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve" }),
      });
      const wrongContextToken = await fetch(`${baseUrl}/api/v1/approval-requests/${pending.requestId}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-symphony-token": defaultToken ?? "missing-default-token" },
        body: JSON.stringify({ decision: "approve" }),
      });
      const approved = await fetch(`${baseUrl}/api/v1/approval-requests/${pending.requestId}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-symphony-token": docsToken ?? "missing-docs-token" },
        body: JSON.stringify({ decision: "approve" }),
      });
      const approvalBody = (await approvalResponseRaw.json()) as { capabilities: { enabled: boolean } };
      const issueBody = (await issueResponse.json()) as {
        capabilities: {
          pendingApproval: { active: boolean; enabled: boolean; requiresToken: boolean };
        };
        pendingApproval: { capabilities: { enabled: boolean } } | null;
      };
      const approvedBody = (await approved.json()) as {
        request: { status: string; capabilities: { enabled: boolean } };
      };

      expect(defaultToken).toBe("default-open-secret");
      expect(docsToken).toBe("docs-open-secret");
      expect(approvalResponseRaw.status).toBe(200);
      expect(approvalBody.capabilities.enabled).toBe(true);
      expect(issueResponse.status).toBe(200);
      expect(issueBody.capabilities.pendingApproval).toMatchObject({
        active: true,
        enabled: true,
        requiresToken: true,
      });
      expect(issueBody.pendingApproval).toMatchObject({
        capabilities: { enabled: true },
      });
      expect(denied.status).toBe(401);
      expect(wrongContextToken.status).toBe(401);
      expect(approved.status).toBe(200);
      expect(approvedBody.request).toMatchObject({
        status: "approved",
        capabilities: { enabled: true },
      });
      expect(resumed).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  it("uses the approval request project context reject policy for rejection side effects", async () => {
    configureMultiProjectApprovalConfig({
      topLevelGithub: {
        publish_pull_requests: true,
        operator_approval: {
          required_for_publication: true,
          reject_policy: "cancel",
          poll_interval_ms: 5,
        },
      },
      docsGithub: {
        publish_pull_requests: true,
        operator_approval: {
          required_for_publication: true,
          reject_policy: "fail",
          poll_interval_ms: 5,
        },
      },
    });
    const pending = await createPending("idem-docs-fail", null, docsProjectContext);
    const cancelled: string[] = [];
    const server = statusServer({ cancelled });
    const address = await server.start();
    try {
      const response = await fetch(`http://${address.host}:${address.port}/api/v1/approval-requests/${pending.requestId}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-symphony-token": "secret" },
        body: JSON.stringify({ decision: "reject" }),
      });
      const body = (await response.json()) as {
        request: { status: string; capabilities: { enabled: boolean } };
        replayed: boolean;
      };

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        replayed: false,
        request: {
          status: "rejected",
          capabilities: { enabled: true },
        },
      });
      expect(cancelled).toEqual([]);
      await expect(store.get(pending.requestId)).resolves.toMatchObject({
        status: "rejected",
        projectContext: docsProjectContext,
      });
      await expect(runStore.getRun("run-1")).resolves.toMatchObject({
        status: "failed",
        completedAt: expect.any(String),
        error: OPERATOR_REJECTED_PUBLICATION_ERROR,
        pendingApprovalRequestId: null,
      });
      await expect(runStore.getRun("run-1")).resolves.not.toMatchObject({
        status: "cancelled",
        error: "Operator cancelled issue",
      });
      const transcript = await runStore.readTranscript("run-1");
      expect(transcript.events.at(-1)).toMatchObject({
        eventType: "approval_resolved",
        payload: { status: "rejected", rejectPolicy: "fail" },
      });
    } finally {
      await server.stop();
    }
  });

  it("redacts command-policy metadata from public run status responses", async () => {
    await runStore.updateRun("run-1", {
      metadata: {
        commandPolicy: {
          decisionCount: 1,
          malformedEventCount: 0,
          lastDecisionAt: "2026-01-01T00:00:02.000Z",
          lastMalformedAt: null,
          decisions: [
            {
              sequence: 2,
              at: "2026-01-01T00:00:02.000Z",
              source: "harness",
              decisionId: "decision-status-redaction",
              attemptId: "attempt-status-redaction",
              activityId: "command-policy:decision-status-redaction",
              runId: "run-1",
              issueId: "issue-1",
              surface: "terminal_execute",
              role: "worker",
              phase: "implementation",
              outcome: "deny",
              reasonKind: "upstream_github",
              commandClass: "direct_upstream_git_operation",
              message: "Blocked worker/reviewer upstream GitHub activity.",
              upstreamContactAttempted: false,
              redacted: true,
              requiresUserOrServiceFix: true,
              normalizedCommand: {
                executable: "git",
                executableKind: "git",
                argumentsPreview: "push https://user:SECRET_STATUS_PASSWORD@github.com/owner/repo.git HEAD",
                gitSubcommand: "push",
                targetHosts: ["github.com"],
                hasNestedCommand: false,
                hasInlineEnvironment: true,
                hasUnsafeGitConfig: true,
              },
              audit: {
                redacted: true,
                surface: "terminal_execute",
                role: "worker",
                phase: "implementation",
                outcome: "deny",
                reasonKind: "upstream_github",
                commandClass: "direct_upstream_git_operation",
                rawInputPreview: "GIT_ASKPASS=/tmp/secret-askpass git push https://user:SECRET_STATUS_PASSWORD@github.com/owner/repo.git HEAD",
                rawInputPreviewRedacted: true,
                commandPreview: "git push https://user:SECRET_STATUS_PASSWORD@github.com/owner/repo.git HEAD",
                inheritedEnvironmentKeys: ["HOME", "PATH"],
                inlineEnvironmentKeys: ["GIT_ASKPASS"],
                unsafeConfigCategories: ["credential_helper"],
                helperPath: "/tmp/secret-credential-helper",
                upstreamContactAttempted: false,
              },
            },
          ],
          malformedEvents: [],
        },
      },
    });

    const server = statusServer();
    const address = await server.start();
    try {
      const response = await fetch(`http://${address.host}:${address.port}/api/v1/runs/run-1`);
      const body = (await response.json()) as { commandPolicy: { decisions: Array<Record<string, unknown>> } };
      const serialized = JSON.stringify(body);
      const decision = body.commandPolicy.decisions[0]!;
      const audit = decision.audit as Record<string, unknown>;
      const normalizedCommand = decision.normalizedCommand as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(decision).toMatchObject({ outcome: "deny", reasonKind: "upstream_github", commandClass: "direct_upstream_git_operation" });
      expect(audit).toMatchObject({
        rawInputPreview: "[redacted command payload]",
        rawInputPreviewRedacted: true,
        commandPreview: "[redacted command payload]",
        helperPath: "[redacted helper path]",
      });
      expect(normalizedCommand.argumentsPreview).toBe("[redacted command payload]");
      expect(serialized).not.toContain("SECRET_");
      expect(serialized).not.toContain("git push");
      expect(serialized).not.toContain("/tmp/secret");
      expect(serialized).not.toContain("user:SECRET_STATUS_PASSWORD");
    } finally {
      await server.stop();
    }
  });

  it.each([
    ["false", false],
    ["null", null],
  ] as const)("returns conflict when approved publication resume returns %s", async (_label, resumeResult) => {
    const pending = await createPending(`idem-resume-${_label}`);
    const resumed: OperatorApprovalRecord[] = [];
    const server = statusServer({ resumed, resumeResult });
    const address = await server.start();
    try {
      const response = await fetch(`http://${address.host}:${address.port}/api/v1/approval-requests/${pending.requestId}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-symphony-token": "secret" },
        body: JSON.stringify({ decision: "approve" }),
      });
      const body = (await response.json()) as { error: { code: string; message: string } };

      expect(response.status).toBe(409);
      expect(body.error).toMatchObject({
        code: "conflict",
        message: "Approved publication could not be resumed from a pending completion report",
      });
      expect(resumed).toHaveLength(1);
      await expect(store.get(pending.requestId)).resolves.toMatchObject({ status: "approved" });
    } finally {
      await server.stop();
    }
  });

  it("does not expose approval controls for setup-incomplete pending publication records", async () => {
    const pending = await createPending("idem-setup-incomplete");
    await lifecycleStore.ensureIssue(issue({ state: "Blocked", branchName: "symphony/TEST-1" }), {
      phase: "blocked",
      blockedReason: PUBLICATION_APPROVAL_SETUP_INCOMPLETE_REASON,
    });
    const resumed: OperatorApprovalRecord[] = [];
    const terminalRecords: OperatorApprovalRecord[] = [];
    const server = statusServer({ resumed, terminalRecords });
    const address = await server.start();
    try {
      const baseUrl = `http://${address.host}:${address.port}`;
      const issueResponse = await fetch(`${baseUrl}/api/v1/issues/TEST-1`);
      const issueBody = (await issueResponse.json()) as {
        capabilities: {
          pendingApproval: { active: boolean; requestId: string | null; status: string | null };
          humanRequired: { active: boolean; reason: string | null; continuationSummaryRecommended: boolean };
        };
        pendingApproval: unknown;
      };
      const approvalPost = await fetch(`${baseUrl}/api/v1/approval-requests/${pending.requestId}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-symphony-token": "secret" },
        body: JSON.stringify({ decision: "approve" }),
      });
      const approvalBody = (await approvalPost.json()) as { error: { code: string; message: string } };

      expect(issueResponse.status).toBe(200);
      expect(issueBody.pendingApproval).toBeNull();
      expect(issueBody.capabilities.pendingApproval).toMatchObject({
        active: false,
        requestId: null,
        status: null,
      });
      expect(issueBody.capabilities.humanRequired).toMatchObject({
        active: true,
        reason: PUBLICATION_APPROVAL_SETUP_INCOMPLETE_REASON,
        continuationSummaryRecommended: true,
      });
      expect(approvalPost.status).toBe(409);
      expect(approvalBody.error).toMatchObject({
        code: "conflict",
        message: "Approval request is not current pending publication approval",
      });
      expect(resumed).toEqual([]);
      expect(terminalRecords).toEqual([]);
      await expect(store.get(pending.requestId)).resolves.toMatchObject({ status: "pending" });
      await expect(runStore.getRun("run-1")).resolves.toMatchObject({
        pendingApprovalRequestId: pending.requestId,
      });
    } finally {
      await server.stop();
    }
  });

  it("fails closed when approving a non-current pending publication approval request", async () => {
    const oldPending = await createPending("idem-old");
    const currentPending = await createPending("idem-current");
    const resumed: OperatorApprovalRecord[] = [];
    const server = statusServer({ resumed });
    const address = await server.start();
    try {
      const response = await fetch(`http://${address.host}:${address.port}/api/v1/approval-requests/${oldPending.requestId}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-symphony-token": "secret" },
        body: JSON.stringify({ decision: "approve" }),
      });
      const body = (await response.json()) as { error: { code: string; message: string } };

      expect(response.status).toBe(409);
      expect(body.error).toMatchObject({
        code: "conflict",
        message: "Approval request is not current pending publication approval",
      });
      expect(resumed).toEqual([]);
      await expect(store.get(oldPending.requestId)).resolves.toMatchObject({ status: "pending" });
      await expect(store.get(currentPending.requestId)).resolves.toMatchObject({ status: "pending" });
      await expect(runStore.getRun("run-1")).resolves.toMatchObject({
        pendingApprovalRequestId: currentPending.requestId,
      });
    } finally {
      await server.stop();
    }
  });

  it.each([
    ["null", null],
    ["empty", ""],
    ["whitespace", "   "],
  ] as const)("fails closed when approval is required and the server token is %s", async (label, openWorkspaceToken) => {
    const pending = await createPending(`idem-token-${label}`);
    const server = statusServer({ openWorkspaceToken });
    const address = await server.start();
    try {
      const baseUrl = `http://${address.host}:${address.port}`;
      const getResponse = await fetch(`${baseUrl}/api/v1/approval-requests/${pending.requestId}`);
      const issueResponse = await fetch(`${baseUrl}/api/v1/issues/TEST-1`);
      const denied = await fetch(`${baseUrl}/api/v1/approval-requests/${pending.requestId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve" }),
      });
      const wrongToken = await fetch(`${baseUrl}/api/v1/approval-requests/${pending.requestId}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-symphony-token": "secret" },
        body: JSON.stringify({ decision: "reject" }),
      });
      const issueBody = (await issueResponse.json()) as {
        capabilities: { pendingApproval: { active: boolean; requiresToken: boolean } };
      };

      expect(getResponse.status).toBe(200);
      expect(issueResponse.status).toBe(200);
      expect(issueBody.capabilities.pendingApproval).toMatchObject({ active: true, requiresToken: true });
      expect(denied.status).toBe(401);
      expect(wrongToken.status).toBe(401);
      await expect(store.get(pending.requestId)).resolves.toMatchObject({ status: "pending" });
      await expect(runStore.getRun("run-1")).resolves.toMatchObject({
        status: "running",
        pendingApprovalRequestId: pending.requestId,
      });
    } finally {
      await server.stop();
    }
  });

  it("keeps approval POST optional-token behavior when approval is not required", async () => {
    config.github.operatorApproval!.requiredForPublication = false;
    const pending = await createPending("idem-gates-off");
    const server = statusServer({ openWorkspaceToken: null });
    const address = await server.start();
    try {
      const issueResponse = await fetch(`http://${address.host}:${address.port}/api/v1/issues/TEST-1`);
      const response = await fetch(`http://${address.host}:${address.port}/api/v1/approval-requests/${pending.requestId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve" }),
      });
      const body = (await response.json()) as { request: { status: string } };
      const issueBody = (await issueResponse.json()) as {
        capabilities: { pendingApproval: { active: boolean; requiresToken: boolean } };
      };

      expect(issueResponse.status).toBe(200);
      expect(issueBody.capabilities.pendingApproval).toMatchObject({ active: true, requiresToken: false });
      expect(response.status, JSON.stringify(body)).toBe(200);
      expect(body.request.status).toBe("approved");
    } finally {
      await server.stop();
    }
  });

  it("rejects pending requests and invokes orchestrator cancellation", async () => {
    const pending = await createPending("idem-2");
    const cancelled: string[] = [];
    const server = statusServer({ cancelled });
    const address = await server.start();
    try {
      const response = await fetch(`http://${address.host}:${address.port}/api/v1/approval-requests/${pending.requestId}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-symphony-token": "secret" },
        body: JSON.stringify({ decision: "reject" }),
      });

      expect(response.status).toBe(200);
      expect(cancelled).toEqual(["issue-1"]);
      await expect(store.get(pending.requestId)).resolves.toMatchObject({ status: "rejected" });
      await expect(runStore.getRun("run-1")).resolves.toMatchObject({
        status: "cancelled",
        completedAt: expect.any(String),
        error: "Operator cancelled issue",
        pendingApprovalRequestId: null,
      });
      await expect(runStore.getRun("run-1")).resolves.not.toMatchObject({
        status: "failed",
        error: OPERATOR_REJECTED_PUBLICATION_ERROR,
      });
    } finally {
      await server.stop();
    }
  });

  it("rejects pending requests without cancelling the issue when reject policy is fail", async () => {
    config.github.operatorApproval!.rejectPolicy = "fail";
    config.github.operatorApproval!.pollIntervalMs = 5;

    const evidenceCursor = "idem-fail";
    const wait = service.waitForPublicationApproval({
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      runId: "run-1",
      evidenceCursor,
      action: action(evidenceCursor),
    });
    const pending = await waitForPending();
    const waiterError = wait.catch((error: unknown) => error);
    const cancelled: string[] = [];
    const server = statusServer({ cancelled });
    const address = await server.start();
    try {
      const response = await fetch(`http://${address.host}:${address.port}/api/v1/approval-requests/${pending.requestId}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-symphony-token": "secret" },
        body: JSON.stringify({ decision: "reject" }),
      });
      const body = (await response.json()) as { request: { status: string }; replayed: boolean };

      expect(response.status).toBe(200);
      expect(body.request.status).toBe("rejected");
      expect(body.replayed).toBe(false);
      expect(cancelled).toEqual([]);
      await expect(store.get(pending.requestId)).resolves.toMatchObject({ status: "rejected" });
      await expect(waiterError).resolves.toMatchObject({ code: "invalid_request" });
      const failedRun = await runStore.getRun("run-1");
      expect(failedRun).toMatchObject({
        status: "failed",
        completedAt: expect.any(String),
        error: OPERATOR_REJECTED_PUBLICATION_ERROR,
        pendingApprovalRequestId: null,
      });
      expect(failedRun?.status).not.toBe("cancelled");
      expect(failedRun?.cancellationRequestedAt ?? null).toBeNull();

      const transcript = await runStore.readTranscript("run-1");
      expect(transcript.events.at(-1)).toMatchObject({
        eventType: "approval_resolved",
        payload: { status: "rejected", rejectPolicy: "fail" },
      });
    } finally {
      await server.stop();
    }
  });

  it.each([
    ["cancel", "cancelled", "Operator cancelled issue"],
    ["fail", "failed", OPERATOR_REJECTED_PUBLICATION_ERROR],
  ] as const)("does not repeat reject side effects on %s policy replay", async (rejectPolicy, expectedStatus, expectedError) => {
    config.github.operatorApproval!.rejectPolicy = rejectPolicy;
    const pending = await createPending(`idem-replay-${rejectPolicy}`);
    const cancelled: string[] = [];
    const terminalRecords: OperatorApprovalRecord[] = [];
    const server = statusServer({ cancelled, terminalRecords });
    const address = await server.start();
    try {
      const url = `http://${address.host}:${address.port}/api/v1/approval-requests/${pending.requestId}`;
      const first = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-symphony-token": "secret" },
        body: JSON.stringify({ decision: "reject" }),
      });
      const firstBody = (await first.json()) as { replayed: boolean };
      const firstRun = await runStore.getRun("run-1");
      const firstResolvedEvents = (await runStore.readTranscript("run-1")).events.filter(
        (event) => event.eventType === "approval_resolved",
      ).length;

      const replay = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-symphony-token": "secret" },
        body: JSON.stringify({ decision: "reject" }),
      });
      const replayBody = (await replay.json()) as { replayed: boolean };
      const replayRun = await runStore.getRun("run-1");
      const replayResolvedEvents = (await runStore.readTranscript("run-1")).events.filter(
        (event) => event.eventType === "approval_resolved",
      ).length;

      expect(first.status).toBe(200);
      expect(firstBody.replayed).toBe(false);
      expect(replay.status).toBe(200);
      expect(replayBody.replayed).toBe(true);
      expect(replayRun).toMatchObject({
        status: expectedStatus,
        completedAt: firstRun?.completedAt,
        error: expectedError,
        pendingApprovalRequestId: null,
      });
      expect(replayResolvedEvents).toBe(firstResolvedEvents);
      expect(cancelled).toHaveLength(rejectPolicy === "cancel" ? 1 : 0);
      expect(terminalRecords.map((record) => record.status)).toEqual(["rejected"]);
    } finally {
      await server.stop();
    }
  });

  it("rejects publication approval through a real orchestrator without reconciling pending reports as success", async () => {
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.writeback.dispatchState = "Todo";
    config.reviewLoop.blockedStates = ["Blocked"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.tracker.handoffStates = ["In Review"];
    config.github.owner = "acme";
    config.github.repo = "symphony";
    config.github.token = "github-token";
    config.github.operatorApproval!.pollIntervalMs = 5;
    config.workspace.source.baseRef = "main";
    const candidate = issue({ state: "Todo", labels: ["dogfood-ready"], branchName: "symphony/TEST-1" });
    let currentState = "Todo";
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [{ ...candidate, state: currentState }];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [{ ...candidate, state: currentState }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const outboxStore = new FileWritebackOutboxStore(config.workspace.stateDir);
    const writer = new StateChangingWriter((state) => {
      currentState = state;
    });
    const writeback = new WritebackProcessor(outboxStore, writer, logger, 300_000);
    const publisher = new FakeCompletionReportPublisher({
      action: "created",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "idem-live",
    });
    const harness = new LiveCompletionReportHarness(lifecycleStore, outboxStore, runStore, publisher, service, writeback);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
      writeback,
    });
    const server = new StatusServer({
      orchestrator,
      workspaceManager,
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      runStore,
      lifecycleStore,
      writebackOutbox: outboxStore,
      operatorApproval: service,
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: "secret",
      trackerStateLists: {
        activeStates: ["Todo", "In Progress"],
        handoffStates: ["In Review"],
        reviewStates: ["In Review"],
        blockedStates: ["Blocked"],
        terminalStates: ["Done"],
      },
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      await orchestrator.refreshNow();
      const pending = await waitForPendingRun(store, "live-report-run");
      expect(writer.comments.some((comment) => comment.body.includes("Publication Approval Setup Incomplete"))).toBe(true);
      expect(writer.transitions.map((transition) => transition.toState)).toEqual(["Todo", "Blocked"]);

      const url = `http://${address.host}:${address.port}/api/v1/approval-requests/${pending.requestId}`;
      const first = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-symphony-token": "secret" },
        body: JSON.stringify({ decision: "reject" }),
      });
      const firstBody = (await first.json()) as { replayed: boolean; request: { status: string } };
      expect([200, 409]).toContain(first.status);
      if (first.status !== 200) return;
      expect(firstBody).toMatchObject({ replayed: false, request: { status: "rejected" } });
      await waitFor(() => orchestrator.snapshot().counts.running === 0, "live approval rejection", 10_000);
      const firstRun = await waitForTerminalRun(runStore, "live-report-run");

      const replay = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-symphony-token": "secret" },
        body: JSON.stringify({ decision: "reject" }),
      });
      const replayBody = (await replay.json()) as { replayed: boolean; request: { status: string } };
      const replayRun = await waitForTerminalRun(runStore, "live-report-run");

      expect([200, 409]).toContain(replay.status);
      if (replay.status === 200) expect(replayBody).toMatchObject({ replayed: true, request: { status: "rejected" } });
      expect(replayRun).toMatchObject({
        status: "cancelled",
        completedAt: firstRun.completedAt,
        pendingApprovalRequestId: null,
      });
      expect(replayRun.status).not.toBe("succeeded");
      expect(publisher.inputs).toEqual([]);
      expect(writer.comments.filter((comment) => comment.body.includes("Status: rejected")).length).toBeLessThanOrEqual(1);
      expect(writer.comments.some((comment) => comment.dedupeKey === "live-report-run:completion-report:idem-live")).toBe(false);
      expect(writer.transitions.map((transition) => transition.toState)).toEqual(["Todo", "Blocked"]);
      await expect(lifecycleStore.get(candidate.identifier)).resolves.toMatchObject({
        phase: "blocked",
        blockedReason: "publication approval rejected",
        incompleteTurnCount: 0,
        completionReports: [
          {
            runId: "live-report-run",
            idempotencyKey: "idem-live",
            writebackOperationKeys: [],
          },
        ],
      });
      await orchestrator.refreshNow();
      expect(harness.prompts).toHaveLength(1);
      expect(orchestrator.snapshot().counts.retrying).toBe(0);
    } finally {
      await server.stop();
      await orchestrator.stop();
    }
  }, 30_000);

  it("approves live pending publication after a Blocked reconciliation tick without cancelling the worker", async () => {
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.writeback.dispatchState = "Todo";
    config.reviewLoop.blockedStates = ["Blocked"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.tracker.handoffStates = ["In Review"];
    config.github.owner = "acme";
    config.github.repo = "symphony";
    config.github.token = "github-token";
    config.github.operatorApproval!.pollIntervalMs = 5;
    config.workspace.source.baseRef = "main";
    const candidate = issue({ state: "Todo", labels: ["dogfood-ready"], branchName: "symphony/TEST-1" });
    let currentState = "Todo";
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [{ ...candidate, state: currentState }];
      },
      async fetchIssuesByStates(states) {
        return states.includes(currentState) ? [{ ...candidate, state: currentState }] : [];
      },
      async fetchIssueStatesByIds() {
        return [{ ...candidate, state: currentState }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const outboxStore = new FileWritebackOutboxStore(config.workspace.stateDir);
    const writer = new StateChangingWriter((state) => {
      currentState = state;
    });
    const writeback = new WritebackProcessor(outboxStore, writer, logger, 300_000);
    const publisher = new FakeCompletionReportPublisher({
      action: "created",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "idem-live",
    });
    const harness = new LiveCompletionReportHarness(lifecycleStore, outboxStore, runStore, publisher, service, writeback);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
      writeback,
      completionReportPublisher: publisher,
    });
    const server = new StatusServer({
      orchestrator,
      workspaceManager,
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      runStore,
      lifecycleStore,
      writebackOutbox: outboxStore,
      operatorApproval: service,
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: "secret",
      trackerStateLists: {
        activeStates: ["Todo", "In Progress"],
        handoffStates: ["In Review"],
        reviewStates: ["In Review"],
        blockedStates: ["Blocked"],
        terminalStates: ["Done"],
      },
      staleThresholdMs: 300_000,
    });
    const address = await server.start();
    try {
      await orchestrator.refreshNow();
      const pending = await waitForPendingRun(store, "live-report-run");
      expect(writer.transitions.map((transition) => transition.toState)).toEqual(["Todo", "Blocked"]);
      expect(orchestrator.snapshot().counts.running).toBe(1);

      await orchestrator.refreshNow();
      expect(orchestrator.snapshot().counts.running).toBe(1);
      const runningRun = await waitForRunMatch(
        runStore,
        "live-report-run",
        (run) => run.status === "running" && run.pendingApprovalRequestId === pending.requestId,
        "live pending publication approval metadata",
      );
      expect(runningRun).toMatchObject({ status: "running", pendingApprovalRequestId: pending.requestId });
      expect(runningRun.cancellationRequestedAt ?? null).toBeNull();
      await waitFor(async () => {
        const lifecycle = await lifecycleStore.get(candidate.id);
        return lifecycle?.blockedReason === PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON;
      }, "pending approval lifecycle recovery");
      await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
        phase: "blocked",
        blockedReason: PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON,
        incompleteTurnCount: 0,
      });

      const response = await fetch(`http://${address.host}:${address.port}/api/v1/approval-requests/${pending.requestId}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-symphony-token": "secret" },
        body: JSON.stringify({ decision: "approve" }),
      });
      const body = (await response.json()) as { replayed: boolean; request: { status: string } };

      expect(response.status, JSON.stringify(body)).toBe(200);
      expect(body).toMatchObject({ replayed: false, request: { status: "approved" } });
      await waitFor(() => publisher.inputs.length === 1, "service-owned live publication");
      await waitFor(() => orchestrator.snapshot().counts.running === 0, "live worker approval exit");
      expect(publisher.inputs[0]).toMatchObject({
        branchName: "symphony/TEST-1",
        baseBranch: "main",
        evidenceCursor: "idem-live",
      });
      const transitionStates = writer.transitions.map((transition) => transition.toState);
      expect(transitionStates.slice(0, 2)).toEqual(["Todo", "Blocked"]);
      expect(transitionStates).toContain("In Review");
      await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
        phase: "review",
        blockedReason: null,
        incompleteTurnCount: 0,
        completionReports: [
          expect.objectContaining({
            runId: "live-report-run",
            idempotencyKey: "idem-live",
            pullRequest: {
              url: "https://github.com/acme/symphony/pull/42",
              number: 42,
              headSha: "abc123",
              branch: "symphony/TEST-1",
            },
          }),
        ],
      });
      const completedRun = await waitForRunMatch(
        runStore,
        "live-report-run",
        (run) => run.status === "succeeded" && run.prHeadSha === "abc123",
        "live approval PR metadata",
      );
      expect(completedRun).toMatchObject({
        status: "succeeded",
        pendingApprovalRequestId: null,
        prUrl: "https://github.com/acme/symphony/pull/42",
        prNumber: 42,
        prHeadSha: "abc123",
        prBranch: "symphony/TEST-1",
      });

      await orchestrator.refreshNow();
      expect(harness.roles.filter((role) => role === "worker")).toHaveLength(1);
      expect(orchestrator.snapshot().counts.retrying).toBe(0);
    } finally {
      await server.stop();
      await orchestrator.stop();
    }
  }, 30_000);

  it("preserves a live worker when pending audit writeback partially fails after Blocked transition", async () => {
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.writeback.dispatchState = "Todo";
    config.reviewLoop.blockedStates = ["Blocked"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.tracker.handoffStates = ["In Review"];
    config.github.owner = "acme";
    config.github.repo = "symphony";
    config.github.token = "github-token";
    config.github.operatorApproval!.pollIntervalMs = 5;
    config.workspace.source.baseRef = "main";
    const candidate = issue({ state: "Todo", labels: ["dogfood-ready"], branchName: "symphony/TEST-1" });
    let currentState = "Todo";
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [{ ...candidate, state: currentState }];
      },
      async fetchIssuesByStates(states) {
        return states.includes(currentState) ? [{ ...candidate, state: currentState }] : [];
      },
      async fetchIssueStatesByIds() {
        return [{ ...candidate, state: currentState }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const outboxStore = new FileWritebackOutboxStore(config.workspace.stateDir);
    const writer = new FailingCommentWriter((state) => {
      currentState = state;
    });
    const writeback = new WritebackProcessor(outboxStore, writer, logger, 300_000);
    let releaseGatedProcessDue: () => void = () => undefined;
    let gatedProcessDueCompleted = false;
    const gatedProcessDue = new Promise<void>((resolve) => {
      releaseGatedProcessDue = resolve;
    });
    const completionReportWriteback = {
      async processDue() {
        await writeback.processDue();
        gatedProcessDueCompleted = true;
        await gatedProcessDue;
      },
    };
    const publisher = new FakeCompletionReportPublisher({
      action: "created",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "idem-live",
    });
    const harness = new LiveCompletionReportHarness(
      lifecycleStore,
      outboxStore,
      runStore,
      publisher,
      service,
      completionReportWriteback,
    );
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
      writeback,
      completionReportPublisher: publisher,
    });
    try {
      await orchestrator.refreshNow();
      await waitFor(() => currentState === "Blocked" && gatedProcessDueCompleted, "partial pending audit writeback");
      await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
        phase: "blocked",
        blockedReason: PUBLICATION_APPROVAL_SETUP_INCOMPLETE_REASON,
        incompleteTurnCount: 0,
        completionReports: [
          expect.objectContaining({
            runId: "live-report-run",
            idempotencyKey: "idem-live",
            writebackOperationKeys: [],
          }),
        ],
      });
      await expect(store.findPendingForRun("live-report-run")).resolves.toBeNull();

      await (
        orchestrator as unknown as {
          reconcileRunningIssues(): Promise<void>;
        }
      ).reconcileRunningIssues();

      expect(orchestrator.snapshot().counts.running).toBe(1);
      const runningRun = await runStore.getRun("live-report-run");
      expect(runningRun).toMatchObject({ status: "running" });
      expect(runningRun?.pendingApprovalRequestId ?? null).toBeNull();
      expect(runningRun?.cancellationRequestedAt ?? null).toBeNull();
      expect(writer.transitions.map((transition) => transition.toState)).toEqual(["Todo", "Blocked"]);
    } finally {
      releaseGatedProcessDue();
      await waitFor(() => orchestrator.snapshot().counts.running === 0, "partial failure worker exit").catch(() => undefined);
      await orchestrator.stop();
    }
  });

  it("approves persisted publication through a real orchestrator after the worker exits", async () => {
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.writeback.dispatchState = "Todo";
    config.reviewLoop.blockedStates = ["Blocked"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.tracker.handoffStates = ["In Review"];
    config.github.owner = "acme";
    config.github.repo = "symphony";
    config.github.token = "github-token";
    config.github.operatorApproval!.pollIntervalMs = 5;
    config.workspace.source.baseRef = "main";

    const runId = "run-1";
    const evidenceCursor = "idem-1";
    const workspacePath = path.join(root, "workspace");
    const reportSummary = "Implemented the requested change.";
    const pullRequestUrl = "https://github.com/acme/symphony/pull/42";
    const candidate = issue({ state: "Todo", labels: ["dogfood-ready"], branchName: "symphony/TEST-1" });
    let currentState = "Todo";
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates(states) {
        return states.includes(currentState) ? [{ ...candidate, state: currentState }] : [];
      },
      async fetchIssueStatesByIds() {
        return [{ ...candidate, state: currentState }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const outboxStore = new FileWritebackOutboxStore(config.workspace.stateDir);
    const writer = new StateChangingWriter((state) => {
      currentState = state;
    });
    const writeback = new WritebackProcessor(outboxStore, writer, logger, 300_000);
    const publisher = new FakeCompletionReportPublisher({
      action: "created",
      url: pullRequestUrl,
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor,
    });
    const harness = new FakeHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
      writeback,
      completionReportPublisher: publisher,
      operatorApproval: service,
    });
    const server = new StatusServer({
      orchestrator,
      workspaceManager,
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      runStore,
      lifecycleStore,
      writebackOutbox: outboxStore,
      operatorApproval: service,
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: "secret",
      trackerStateLists: {
        activeStates: ["Todo", "In Progress"],
        handoffStates: ["In Review"],
        reviewStates: ["In Review"],
        blockedStates: ["Blocked"],
        terminalStates: ["Done"],
      },
      staleThresholdMs: 300_000,
    });

    await runStore.updateRun(runId, {
      status: "succeeded",
      completedAt: "2026-01-01T00:00:00.000Z",
      metadata: {
        gitBranchName: "symphony/TEST-1",
        repoPath: root,
        baseRef: "main",
      },
    });
    const preApprovalRun = await runStore.getRun(runId);
    expect(preApprovalRun).toMatchObject({
      status: "succeeded",
      workspacePath,
      gitBranchName: "symphony/TEST-1",
      repoPath: root,
      baseRef: "main",
    });
    expect(preApprovalRun?.status).not.toBe("running");

    await lifecycleStore.ensureIssue(candidate, {
      phase: "blocked",
      blockedReason: PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON,
      lastCompletionReportId: `completion-report:${candidate.id}:${evidenceCursor}`,
      completionReports: [
        {
          id: `completion-report:${candidate.id}:${evidenceCursor}`,
          idempotencyKey: evidenceCursor,
          runId,
          issueId: candidate.id,
          issueIdentifier: candidate.identifier,
          summary: reportSummary,
          validationEvidence: ["npm test -- orchestrator"],
          acceptanceChecklist: [
            {
              text: "Reviewer dispatch is covered.",
              satisfied: true,
              evidence: "Approval status API integration test",
            },
          ],
          changedFiles: ["src/core/orchestrator/Orchestrator.ts"],
          branchName: candidate.branchName,
          pullRequest: null,
          risks: [],
          acceptedAt: "2026-01-01T00:00:00.000Z",
          writebackOperationKeys: [],
        },
      ],
      summaryPointers: {
        workspaceKey: candidate.identifier,
        workspacePath,
        branchName: candidate.branchName,
        gitBranchName: candidate.branchName,
        repoPath: root,
        baseRef: "main",
        lastRunId: runId,
      },
    });
    await orchestrator.refreshNow();
    const pending = await waitForPendingRun(store, runId);
    await orchestrator.refreshNow();

    await expect(store.findPendingForRun(runId)).resolves.toMatchObject({
      status: "pending",
      runId,
      evidenceCursor,
    });
    expect((await store.list()).filter((approval) => approval.runId === runId)).toHaveLength(1);
    await expect(runStore.getRun(runId)).resolves.toMatchObject({
      status: "succeeded",
      pendingApprovalRequestId: pending.requestId,
      pendingApprovalRequestedAt: expect.any(String),
    });
    await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
      phase: "blocked",
      blockedReason: PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON,
      completionReports: [
        expect.objectContaining({
          runId,
          idempotencyKey: evidenceCursor,
          summary: reportSummary,
          pullRequest: null,
          writebackOperationKeys: [],
        }),
      ],
    });
    expect(publisher.inputs).toEqual([]);
    expect(orchestrator.snapshot().counts.running).toBe(0);
    expect(harness.runs).toEqual([]);
    const preApprovalTranscript = await runStore.readTranscript(runId);
    expect(preApprovalTranscript.events.filter((event) => event.eventType === "approval_request")).toHaveLength(1);
    const pendingAuditOperations = (await outboxStore.list()).filter((operation) =>
      operation.idempotencyKey.includes("publication-approval-pending"),
    );
    expect(pendingAuditOperations).toHaveLength(2);
    expect(pendingAuditOperations.map((operation) => operation.status)).toEqual(["succeeded", "succeeded"]);

    const address = await server.start();
    try {
      const baseUrl = `http://${address.host}:${address.port}`;
      const approve = await fetch(`${baseUrl}/api/v1/approval-requests/${pending.requestId}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-symphony-token": "secret" },
        body: JSON.stringify({ decision: "approve" }),
      });
      const approveBody = (await approve.json()) as { request: { status: string }; replayed: boolean };
      const issueResponse = await fetch(`${baseUrl}/api/v1/issues/TEST-1`);
      const issueBody = (await issueResponse.json()) as {
        capabilities: { pendingApproval: { active: boolean } };
        issueDetails: { pullRequest: { url: string | null; number: number | null; headSha: string | null; branch: string | null } };
      };

      expect(approve.status).toBe(200);
      expect(approveBody).toMatchObject({ request: { status: "approved" }, replayed: false });
      expect(issueBody.capabilities.pendingApproval.active).toBe(false);
      expect(issueBody.issueDetails.pullRequest).toMatchObject({
        url: pullRequestUrl,
        number: 42,
        headSha: "abc123",
        branch: "symphony/TEST-1",
      });
      await expect(store.get(pending.requestId)).resolves.toMatchObject({ status: "approved" });

      expect(publisher.inputs).toHaveLength(1);
      expect(publisher.inputs[0]).toMatchObject({
        workspacePath,
        branchName: "symphony/TEST-1",
        baseBranch: "main",
        evidenceCursor,
      });
      const acceptedComments = writer.comments.filter((comment) => comment.body.includes("## Symphony Completion Report"));
      expect(acceptedComments).toHaveLength(1);
      expect(acceptedComments[0]?.body).toContain("Status: accepted");
      expect(writer.comments.filter((comment) => comment.body.includes("## Symphony Publication Approval Setup Incomplete"))).toHaveLength(1);
      expect(writer.transitions.filter((transition) => transition.toState === "Blocked")).toHaveLength(1);
      const reviewTransitions = writer.transitions.filter((transition) => transition.toState === "In Review");
      expect(reviewTransitions).toHaveLength(1);
      expect(currentState).toBe("In Review");

      await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
        phase: "review",
        blockedReason: null,
        completionReports: [
          expect.objectContaining({
            runId,
            idempotencyKey: evidenceCursor,
            pullRequest: {
              url: pullRequestUrl,
              number: 42,
              headSha: "abc123",
              branch: "symphony/TEST-1",
            },
            writebackOperationKeys: [
              "comment:issue-1:run-1:completion-report:idem-1",
              "transition:issue-1:run-1:completion-report:idem-1:In Review",
            ],
          }),
        ],
      });
      await expect(runStore.getRun(runId)).resolves.toMatchObject({
        status: "succeeded",
        pendingApprovalRequestId: null,
        prUrl: pullRequestUrl,
        prNumber: 42,
        prHeadSha: "abc123",
        prBranch: "symphony/TEST-1",
      });

      await orchestrator.refreshNow();
      await waitFor(
        () =>
          harness.runs.filter((run) => run.ctx.role === "reviewer").length === 1 &&
          harness.runs.filter((run) => run.ctx.role === "worker").length === 0,
        "reviewer dispatch from stored completion report",
      );
      const workerRuns = harness.runs.filter((run) => run.ctx.role === "worker");
      const reviewerRuns = harness.runs.filter((run) => run.ctx.role === "reviewer");
      expect(workerRuns).toHaveLength(0);
      expect(reviewerRuns).toHaveLength(1);
      expect(reviewerRuns[0]?.prompt).toContain(reportSummary);
      expect(reviewerRuns[0]?.prompt).toContain(`Pull request: ${pullRequestUrl}`);

      await waitFor(() => orchestrator.snapshot().counts.running === 0, "post-approve reviewer quiescence");

      // Approve replays still enter the publication resume hook; finalized report state must keep that path idempotent.
      const approvedCommentBeforeReplay = writer.comments.find((comment) => comment.body.includes("Status: accepted"));
      const approvedTransitionBeforeReplay = writer.transitions.find((transition) => transition.toState === "In Review");
      const lifecycleBeforeReplay = await lifecycleStore.get(candidate.id);
      const completionReportBeforeReplay = lifecycleBeforeReplay?.completionReports.find(
        (report) => report.idempotencyKey === evidenceCursor,
      );
      const workerRunBeforeReplay = await runStore.getRun(runId);
      const run1TranscriptBeforeReplay = await runStore.readTranscript(runId);
      const approvalRequestCountBeforeReplay = run1TranscriptBeforeReplay.events.filter(
        (event) => event.eventType === "approval_request",
      ).length;
      const approvalResolvedCountBeforeReplay = run1TranscriptBeforeReplay.events.filter(
        (event) => event.eventType === "approval_resolved",
      ).length;
      const prOpenedCountBeforeReplay = run1TranscriptBeforeReplay.events.filter(
        (event) => event.eventType === "pr_opened",
      ).length;
      const prUpdatedCountBeforeReplay = run1TranscriptBeforeReplay.events.filter(
        (event) => event.eventType === "pr_updated",
      ).length;
      const replayBaseline = {
        publisherCallCount: publisher.inputs.length,
        commentCount: writer.comments.length,
        transitionCount: writer.transitions.length,
        acceptedWriteback: {
          commentBodyIncludesStatusAccepted: approvedCommentBeforeReplay?.body.includes("Status: accepted") ?? false,
          commentDedupeKey: approvedCommentBeforeReplay?.dedupeKey ?? null,
          transitionToState: approvedTransitionBeforeReplay?.toState ?? null,
        },
        currentState,
        lifecycle: {
          phase: lifecycleBeforeReplay?.phase,
          blockedReason: lifecycleBeforeReplay?.blockedReason,
          lastPushedAt: lifecycleBeforeReplay?.summaryPointers.lastPushedAt,
          lastEvidenceCursor: lifecycleBeforeReplay?.summaryPointers.lastEvidenceCursor,
          pullRequest: completionReportBeforeReplay?.pullRequest ?? null,
          writebackOperationKeys: completionReportBeforeReplay?.writebackOperationKeys ?? [],
        },
        workerRun: {
          status: workerRunBeforeReplay?.status,
          completedAt: workerRunBeforeReplay?.completedAt,
          pendingApprovalRequestId: workerRunBeforeReplay?.pendingApprovalRequestId,
          prUrl: workerRunBeforeReplay?.prUrl,
          prNumber: workerRunBeforeReplay?.prNumber,
          prHeadSha: workerRunBeforeReplay?.prHeadSha,
          prBranch: workerRunBeforeReplay?.prBranch,
          lastPushedAt: workerRunBeforeReplay?.lastPushedAt,
          lastEvidenceCursor: workerRunBeforeReplay?.lastEvidenceCursor,
        },
        workerRunCount: harness.runs.filter((run) => run.ctx.role === "worker").length,
        reviewerRunCount: harness.runs.filter((run) => run.ctx.role === "reviewer").length,
        persistedRunCount: (await runStore.listRunsForIssue(candidate.id)).length,
        approvalRequestCount: approvalRequestCountBeforeReplay,
        approvalResolvedCount: approvalResolvedCountBeforeReplay,
        prOpenedCount: prOpenedCountBeforeReplay,
        prUpdatedCount: prUpdatedCountBeforeReplay,
      };
      expect(replayBaseline.lifecycle.lastPushedAt).toBe("2026-01-01T00:00:01Z");
      expect(replayBaseline.lifecycle.lastEvidenceCursor).toBe(evidenceCursor);
      expect(replayBaseline.workerRun.lastPushedAt).toBe("2026-01-01T00:00:01Z");
      expect(replayBaseline.workerRun.lastEvidenceCursor).toBe(evidenceCursor);
      expect(replayBaseline.approvalRequestCount).toBe(1);
      expect(replayBaseline.approvalResolvedCount).toBe(1);
      expect(replayBaseline.prOpenedCount).toBe(1);
      expect(replayBaseline.prUpdatedCount).toBe(0);

      const replay = await fetch(`${baseUrl}/api/v1/approval-requests/${pending.requestId}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-symphony-token": "secret" },
        body: JSON.stringify({ decision: "approve" }),
      });
      const replayBody = (await replay.json()) as { request: { status: string }; replayed: boolean };

      expect(replay.status).toBe(200);
      expect(replayBody).toMatchObject({ request: { status: "approved" }, replayed: true });
      const replayIssueResponse = await fetch(`${baseUrl}/api/v1/issues/TEST-1`);
      const replayIssueBody = (await replayIssueResponse.json()) as {
        issueDetails: { pullRequest: { url: string | null; number: number | null; headSha: string | null; branch: string | null } };
      };
      expect(replayIssueBody.issueDetails.pullRequest).toEqual(issueBody.issueDetails.pullRequest);
      expect(publisher.inputs).toHaveLength(replayBaseline.publisherCallCount);
      expect(writer.comments).toHaveLength(replayBaseline.commentCount);
      expect(writer.transitions).toHaveLength(replayBaseline.transitionCount);
      const approvedCommentAfterReplay = writer.comments.find((comment) => comment.body.includes("Status: accepted"));
      const approvedTransitionAfterReplay = writer.transitions.find((transition) => transition.toState === "In Review");
      expect({
        commentBodyIncludesStatusAccepted: approvedCommentAfterReplay?.body.includes("Status: accepted") ?? false,
        commentDedupeKey: approvedCommentAfterReplay?.dedupeKey ?? null,
        transitionToState: approvedTransitionAfterReplay?.toState ?? null,
      }).toEqual(replayBaseline.acceptedWriteback);
      expect(approvedCommentAfterReplay?.dedupeKey).toBe(`${runId}:completion-report:${evidenceCursor}`);
      expect(approvedTransitionAfterReplay).toMatchObject({ toState: "In Review" });
      expect(currentState).toBe(replayBaseline.currentState);

      const lifecycleAfterReplay = await lifecycleStore.get(candidate.id);
      const completionReportAfterReplay = lifecycleAfterReplay?.completionReports.find(
        (report) => report.idempotencyKey === evidenceCursor,
      );
      expect({
        phase: lifecycleAfterReplay?.phase,
        blockedReason: lifecycleAfterReplay?.blockedReason,
        lastPushedAt: lifecycleAfterReplay?.summaryPointers.lastPushedAt,
        lastEvidenceCursor: lifecycleAfterReplay?.summaryPointers.lastEvidenceCursor,
        pullRequest: completionReportAfterReplay?.pullRequest ?? null,
        writebackOperationKeys: completionReportAfterReplay?.writebackOperationKeys ?? [],
      }).toEqual(replayBaseline.lifecycle);

      const workerRunAfterReplay = await runStore.getRun(runId);
      expect({
        status: workerRunAfterReplay?.status,
        completedAt: workerRunAfterReplay?.completedAt,
        pendingApprovalRequestId: workerRunAfterReplay?.pendingApprovalRequestId,
        prUrl: workerRunAfterReplay?.prUrl,
        prNumber: workerRunAfterReplay?.prNumber,
        prHeadSha: workerRunAfterReplay?.prHeadSha,
        prBranch: workerRunAfterReplay?.prBranch,
        lastPushedAt: workerRunAfterReplay?.lastPushedAt,
        lastEvidenceCursor: workerRunAfterReplay?.lastEvidenceCursor,
      }).toEqual(replayBaseline.workerRun);

      const run1TranscriptAfterReplay = await runStore.readTranscript(runId);
      expect(run1TranscriptAfterReplay.events.filter((event) => event.eventType === "approval_request")).toHaveLength(
        replayBaseline.approvalRequestCount,
      );
      expect(run1TranscriptAfterReplay.events.filter((event) => event.eventType === "approval_request")).toHaveLength(
        1,
      );
      expect(run1TranscriptAfterReplay.events.filter((event) => event.eventType === "approval_resolved")).toHaveLength(
        replayBaseline.approvalResolvedCount,
      );
      expect(run1TranscriptAfterReplay.events.filter((event) => event.eventType === "approval_resolved")).toHaveLength(
        1,
      );
      expect(run1TranscriptAfterReplay.events.filter((event) => event.eventType === "pr_opened")).toHaveLength(
        replayBaseline.prOpenedCount,
      );
      expect(run1TranscriptAfterReplay.events.filter((event) => event.eventType === "pr_updated")).toHaveLength(
        replayBaseline.prUpdatedCount,
      );
      expect(
        run1TranscriptAfterReplay.events.filter((event) => ["pr_opened", "pr_updated"].includes(event.eventType)),
      ).toHaveLength(1);
      expect(harness.runs.filter((run) => run.ctx.role === "worker")).toHaveLength(replayBaseline.workerRunCount);
      expect(harness.runs.filter((run) => run.ctx.role === "reviewer")).toHaveLength(replayBaseline.reviewerRunCount);
      await expect(runStore.listRunsForIssue(candidate.id)).resolves.toHaveLength(replayBaseline.persistedRunCount);
    } finally {
      await server.stop();
      await orchestrator.stop();
    }
  });

  it("records terminal recovery when pending requests expire during status API resolution after worker exit", async () => {
    const pending = await createPending("idem-expired", -1);
    await runStore.updateRun("run-1", { status: "succeeded", completedAt: "2026-01-01T00:00:00.000Z" });
    const cancelled: string[] = [];
    const resumed: OperatorApprovalRecord[] = [];
    const terminalRecords: OperatorApprovalRecord[] = [];
    const server = statusServer({ cancelled, resumed, terminalRecords });
    const address = await server.start();
    try {
      const response = await fetch(`http://${address.host}:${address.port}/api/v1/approval-requests/${pending.requestId}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-symphony-token": "secret" },
        body: JSON.stringify({ decision: "reject" }),
      });
      const body = (await response.json()) as { error: { code: string; message: string } };

      expect(response.status).toBe(409);
      expect(body.error).toMatchObject({ code: "conflict", message: "Approval request is expired" });
      expect(cancelled).toEqual([]);
      expect(resumed).toEqual([]);
      expect(terminalRecords).toHaveLength(1);
      expect(terminalRecords[0]).toMatchObject({
        requestId: pending.requestId,
        status: "expired",
        staleReason: "approval request expired",
      });
      await expect(store.get(pending.requestId)).resolves.toMatchObject({
        status: "expired",
        resolvedBy: "system",
        decision: null,
        staleReason: "approval request expired",
      });
      await expect(runStore.getRun("run-1")).resolves.toMatchObject({ pendingApprovalRequestId: null });

      const transcript = await runStore.readTranscript("run-1");
      expect(transcript.events.at(-1)).toMatchObject({
        eventType: "approval_resolved",
        payload: { status: "expired", staleReason: "approval request expired" },
      });
    } finally {
      await server.stop();
    }
  });

  it("records terminal recovery when pending requests become stale during status API resolution after worker exit", async () => {
    const pending = await createPending("idem-stale");
    await runStore.updateRun("run-1", {
      status: "succeeded",
      completedAt: "2026-01-01T00:00:00.000Z",
      metadata: {
        cancellationRequestedAt: "2026-01-01T00:00:01.000Z",
        cancellationSource: "operator",
        cancellationReason: "operator cancelled publication after worker exit",
      },
    });
    const cancelled: string[] = [];
    const resumed: OperatorApprovalRecord[] = [];
    const terminalRecords: OperatorApprovalRecord[] = [];
    const server = statusServer({ cancelled, resumed, terminalRecords });
    const address = await server.start();
    try {
      const response = await fetch(`http://${address.host}:${address.port}/api/v1/approval-requests/${pending.requestId}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-symphony-token": "secret" },
        body: JSON.stringify({ decision: "reject" }),
      });
      const body = (await response.json()) as { error: { code: string; message: string } };

      expect(response.status).toBe(409);
      expect(body.error).toMatchObject({
        code: "conflict",
        message: "Approval request is stale: run cancellation has been requested",
      });
      expect(cancelled).toEqual([]);
      expect(resumed).toEqual([]);
      expect(terminalRecords).toHaveLength(1);
      expect(terminalRecords[0]).toMatchObject({
        requestId: pending.requestId,
        status: "stale",
        staleReason: "run cancellation has been requested",
      });
      await expect(store.get(pending.requestId)).resolves.toMatchObject({
        status: "stale",
        resolvedBy: "system",
        decision: null,
        staleReason: "run cancellation has been requested",
      });
      await expect(runStore.getRun("run-1")).resolves.toMatchObject({ pendingApprovalRequestId: null });
    } finally {
      await server.stop();
    }
  });

  it("recovers already-terminal approval conflicts by refetching the approval record", async () => {
    const pending = await createPending("idem-terminal-before-post");
    const expired = await store.markExpired(pending.requestId);
    const cancelled: string[] = [];
    const resumed: OperatorApprovalRecord[] = [];
    const terminalRecords: OperatorApprovalRecord[] = [];
    const server = statusServer({ cancelled, resumed, terminalRecords });
    const address = await server.start();
    try {
      const response = await fetch(`http://${address.host}:${address.port}/api/v1/approval-requests/${pending.requestId}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-symphony-token": "secret" },
        body: JSON.stringify({ decision: "approve" }),
      });
      const body = (await response.json()) as { error: { code: string; message: string } };

      expect(response.status).toBe(409);
      expect(body.error).toMatchObject({ code: "conflict", message: "Approval request is expired" });
      expect(cancelled).toEqual([]);
      expect(resumed).toEqual([]);
      expect(terminalRecords).toHaveLength(1);
      expect(terminalRecords[0]).toMatchObject({ requestId: expired.requestId, status: "expired" });
    } finally {
      await server.stop();
    }
  });

  it("preserves the original conflict response when terminal recovery writeback fails", async () => {
    const pending = await createPending("idem-terminal-recorder-fails", -1);
    const cancelled: string[] = [];
    const resumed: OperatorApprovalRecord[] = [];
    const terminalRecords: OperatorApprovalRecord[] = [];
    const server = statusServer({
      cancelled,
      resumed,
      terminalRecords,
      terminalError: new Error("writeback failed"),
    });
    const address = await server.start();
    try {
      const response = await fetch(`http://${address.host}:${address.port}/api/v1/approval-requests/${pending.requestId}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-symphony-token": "secret" },
        body: JSON.stringify({ decision: "reject" }),
      });
      const body = (await response.json()) as { error: { code: string; message: string } };

      expect(response.status).toBe(409);
      expect(body.error).toMatchObject({ code: "conflict", message: "Approval request is expired" });
      expect(cancelled).toEqual([]);
      expect(resumed).toEqual([]);
      expect(terminalRecords).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  it("preserves the original conflict response when fallback approval lookup fails", async () => {
    const cancelled: string[] = [];
    const resumed: OperatorApprovalRecord[] = [];
    const terminalRecords: OperatorApprovalRecord[] = [];
    const server = statusServer({
      cancelled,
      resumed,
      terminalRecords,
      operatorApproval: {
        rejectPolicy: "cancel",
        isRequired: () => true,
        async get() {
          throw new Error("approval store read failed");
        },
        async resolve() {
          throw new SymphonyError("conflict", "Approval request is stale");
        },
        async findPendingForIssue() {
          return null;
        },
        async findPendingForRun() {
          return null;
        },
      },
    });
    const address = await server.start();
    try {
      const response = await fetch(`http://${address.host}:${address.port}/api/v1/approval-requests/request-without-details`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-symphony-token": "secret" },
        body: JSON.stringify({ decision: "approve" }),
      });
      const body = (await response.json()) as { error: { code: string; message: string } };

      expect(response.status).toBe(409);
      expect(body.error).toMatchObject({ code: "conflict", message: "Approval request is stale" });
      expect(cancelled).toEqual([]);
      expect(resumed).toEqual([]);
      expect(terminalRecords).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  function configureMultiProjectApprovalConfig(input: {
    topLevelGithub?: Record<string, unknown>;
    docsGithub?: Record<string, unknown>;
    topLevelServer?: Record<string, unknown>;
    topLevelCredentialProfiles?: Record<string, unknown>;
    docsCredentialProfiles?: Record<string, unknown>;
  } = {}) {
    const parsed = parseServiceConfig(
      multiProjectWorkflowConfig({
        topLevel: {
          tracker: {
            project_slug: "TEST",
            active_states: ["Todo", "In Progress"],
            handoff_states: ["In Review"],
          },
          workspace: {
            root: config.workspace.root,
            state_dir: config.workspace.stateDir,
            source: {
              kind: "git_worktree",
              repository: root,
              base_ref: "main",
              branch_template: "symphony/{{ issue.identifier }}",
              cleanup: "refuse_dirty",
            },
          },
          ...(input.topLevelServer === undefined ? {} : { server: input.topLevelServer }),
          ...(input.topLevelCredentialProfiles === undefined
            ? {}
            : { credential_profiles: input.topLevelCredentialProfiles }),
          github: {
            owner: "acme",
            repo: "symphony",
            token: "github-token",
            api_base_url: "https://api.github.test",
            publish_pull_requests: false,
            pr_handoff: { enabled: false },
            operator_approval: {
              required_for_publication: false,
              reject_policy: "cancel",
              poll_interval_ms: 5,
            },
            ...input.topLevelGithub,
          },
        },
        projectContexts: [
          projectContextFixture({
            id: "symphony",
            label: "Symphony",
            projectSlug: "TEST",
            workspaceRoot: config.workspace.root,
            stateDir: config.workspace.stateDir,
            repository: root,
            baseRef: "main",
            branchTemplate: "symphony/{{ issue.identifier }}",
          }),
          projectContextFixture({
            id: docsProjectContext.projectContextId,
            label: docsProjectContext.projectContextLabel,
            projectSlug: docsProjectContext.linearProjectSlug,
            workspaceRoot: config.workspace.root,
            stateDir: config.workspace.stateDir,
            repository: root,
            baseRef: "main",
            branchTemplate: "symphony/{{ issue.identifier }}",
            github: {
              owner: "acme",
              repo: "docs-site",
              token: "docs-github-token",
              api_base_url: "https://api.github.test",
              publish_pull_requests: true,
              pr_handoff: { enabled: false },
              operator_approval: {
                required_for_publication: true,
                reject_policy: "fail",
                poll_interval_ms: 5,
              },
              ...input.docsGithub,
            },
            ...(input.docsCredentialProfiles === undefined
              ? {}
              : { credential_profiles: input.docsCredentialProfiles }),
          }),
        ],
      }),
      path.join(root, "WORKFLOW.md"),
      {
        LINEAR_API_KEY: "linear-test-key",
        DEFAULT_OPEN_WORKSPACE_TOKEN: "default-open-secret",
        DOCS_OPEN_WORKSPACE_TOKEN: "docs-open-secret",
      },
    );

    config = {
      ...config,
      server: parsed.server,
      github: parsed.github,
      credentialProfiles: parsed.credentialProfiles,
      credentialProfileRegistries: parsed.credentialProfileRegistries,
      projectContexts: parsed.projectContexts,
    };
    service = new OperatorApprovalService({ config, store, runStore });
  }

  async function createPending(
    evidenceCursor: string,
    timeoutMs: number | null = null,
    projectContext?: ProjectContextResolution,
  ) {
    const { record } = await store.requestOrGetPending(
      {
        issueId: "issue-1",
        issueIdentifier: "TEST-1",
        runId: "run-1",
        evidenceCursor,
        action: action(evidenceCursor),
        ...(projectContext === undefined ? {} : { projectContext }),
      },
      timeoutMs,
    );
    await runStore.updateRun("run-1", {
      metadata: { pendingApprovalRequestId: record.requestId, pendingApprovalRequestedAt: record.requestedAt },
    });
    await lifecycleStore.ensureIssue(issue({ state: "Blocked", branchName: "symphony/TEST-1" }), {
      phase: "blocked",
      blockedReason: PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON,
      lastCompletionReportId: `completion-report:issue-1:${evidenceCursor}`,
      completionReports: [
        {
          id: `completion-report:issue-1:${evidenceCursor}`,
          idempotencyKey: evidenceCursor,
          runId: "run-1",
          issueId: "issue-1",
          issueIdentifier: "TEST-1",
          summary: "Implemented the service contract.",
          validationEvidence: ["npm test -- approval-status-api"],
          acceptanceChecklist: [
            {
              text: "Approval controls are linked to the pending report.",
              satisfied: true,
              evidence: "approval status API test",
            },
          ],
          changedFiles: ["src/core/CompletionReportService.ts"],
          branchName: "symphony/TEST-1",
          pullRequest: null,
          risks: [],
          acceptedAt: "2026-01-01T00:00:00.000Z",
          writebackOperationKeys: [],
        },
      ],
      summaryPointers: {
        workspacePath: path.join(root, "workspace"),
        branchName: "symphony/TEST-1",
        gitBranchName: "symphony/TEST-1",
        repoPath: root,
        baseRef: "main",
      },
    });
    return record;
  }

  async function waitForPending() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const pending = await store.findPendingForRun("run-1");
      if (pending) {
        await lifecycleStore.ensureIssue(issue({ state: "Blocked", branchName: "symphony/TEST-1" }), {
          phase: "blocked",
          blockedReason: PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON,
          lastCompletionReportId: `completion-report:issue-1:${pending.evidenceCursor}`,
          completionReports: [
            {
              id: `completion-report:issue-1:${pending.evidenceCursor}`,
              idempotencyKey: pending.evidenceCursor,
              runId: "run-1",
              issueId: "issue-1",
              issueIdentifier: "TEST-1",
              summary: "Implemented the service contract.",
              validationEvidence: ["npm test -- approval-status-api"],
              acceptanceChecklist: [
                {
                  text: "Approval controls are linked to the pending report.",
                  satisfied: true,
                  evidence: "approval status API test",
                },
              ],
              changedFiles: ["src/core/CompletionReportService.ts"],
              branchName: "symphony/TEST-1",
              pullRequest: null,
              risks: [],
              acceptedAt: "2026-01-01T00:00:00.000Z",
              writebackOperationKeys: [],
            },
          ],
          summaryPointers: {
            workspacePath: path.join(root, "workspace"),
            branchName: "symphony/TEST-1",
            gitBranchName: "symphony/TEST-1",
            repoPath: root,
            baseRef: "main",
          },
        });
        return pending;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("pending approval was not created");
  }

  async function waitForPendingRun(approvalStore: FileOperatorApprovalStore, runId: string, timeoutMs = 5_000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const pending = await approvalStore.findPendingForRun(runId);
      if (pending) return pending;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`pending approval was not created for ${runId}`);
  }

  async function waitForRun(transcriptStore: FileRunTranscriptStore, runId: string, timeoutMs = 5_000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const run = await transcriptStore.getRun(runId);
      if (run) return run;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`run was not recorded: ${runId}`);
  }

  async function waitForTerminalRun(transcriptStore: FileRunTranscriptStore, runId: string, timeoutMs = 5_000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      let run;
      try {
        run = await transcriptStore.getRun(runId);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
      if (run && run.status !== "running") return run;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`run did not become terminal: ${runId}`);
  }

  async function waitForRunMatch(
    transcriptStore: FileRunTranscriptStore,
    runId: string,
    predicate: (run: RunRecord) => boolean,
    description: string,
    timeoutMs = 5_000,
  ) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const run = await transcriptStore.getRun(runId);
      if (run && predicate(run)) return run;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`run did not match ${description}: ${runId}`);
  }

  async function waitFor(predicate: () => boolean | Promise<boolean>, description: string, timeoutMs = 5_000): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(await predicate(), `Timed out waiting for ${description}`).toBe(true);
  }

  async function rmWithRetry(target: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await rm(target, { recursive: true, force: true });
        return;
      } catch (error) {
        if (attempt === 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  function statusServer(
    options: {
      cancelled?: string[];
      resumed?: OperatorApprovalRecord[];
      terminalRecords?: OperatorApprovalRecord[];
      terminalError?: Error;
      openWorkspaceToken?: string | null;
      resolveOpenWorkspaceToken?: (projectContextId?: string | null) => string | null;
      operatorApproval?: ConstructorParameters<typeof StatusServer>[0]["operatorApproval"];
      resumeResult?: boolean | null;
    } = {},
  ) {
    const cancelled = options.cancelled ?? [];
    const resumed = options.resumed ?? [];
    const terminalRecords = options.terminalRecords ?? [];
    return new StatusServer({
      orchestrator: fakeOrchestrator(
        cancelled,
        async () => {
          await runStore.updateRun("run-1", {
            status: "cancelled",
            completedAt: new Date().toISOString(),
            error: "Operator cancelled issue",
          });
        },
        resumed,
        terminalRecords,
        options.terminalError,
        options.resumeResult,
      ),
      workspaceManager: new WorkspaceManager({
        workspace: config.workspace,
        hooks: config.hooks,
        logger: new StructuredLogger(() => undefined),
      }),
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      runStore,
      lifecycleStore,
      operatorApproval: options.operatorApproval ?? service,
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: options.openWorkspaceToken === undefined ? "secret" : options.openWorkspaceToken,
      ...(options.resolveOpenWorkspaceToken === undefined
        ? {}
        : { resolveOpenWorkspaceToken: options.resolveOpenWorkspaceToken }),
      trackerStateLists: {
        activeStates: ["Todo", "In Progress"],
        handoffStates: ["In Review"],
        reviewStates: ["In Review"],
        blockedStates: ["Blocked"],
        terminalStates: ["Done"],
      },
      staleThresholdMs: 300_000,
    });
  }
});

function action(evidenceCursor: string): OperatorApprovalAction {
  return {
    kind: "push_and_pr",
    branchName: "symphony/TEST-1",
    baseBranch: "main",
    workspacePath: "/tmp/workspace",
    title: "TEST-1: Do work",
    evidenceCursor,
    summaryPreview: "Implemented the service contract.",
    changedFiles: ["src/core/CompletionReportService.ts"],
    plannedOperations: ["commit_if_needed", "git_push", "pull_request_create_or_reuse"],
  };
}

function fakeOrchestrator(
  cancelled: string[],
  onCancel?: (issueId: string) => Promise<void>,
  resumed: OperatorApprovalRecord[] = [],
  terminalRecords: OperatorApprovalRecord[] = [],
  terminalError?: Error,
  resumeResult: boolean | null = true,
): Orchestrator {
  return {
    snapshot() {
      return {
        generatedAt: "2026-01-01T00:10:00.000Z",
        counts: { running: 0, retrying: 0, paused: 0 },
        running: [],
        retrying: [],
        paused: [],
        totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
        rateLimits: null,
      };
    },
    getIssueDetails() {
      return null;
    },
    async refreshNow() {
      return undefined;
    },
    pauseIssue() {
      return undefined;
    },
    resumeIssue() {
      return undefined;
    },
    async cancelIssue(issueId: string) {
      cancelled.push(issueId);
      await onCancel?.(issueId);
    },
    async resumeApprovedPublication(request: OperatorApprovalRecord) {
      resumed.push(request);
      return resumeResult as boolean;
    },
    async recordPublicationApprovalTerminal(request: OperatorApprovalRecord) {
      terminalRecords.push(request);
      if (terminalError) throw terminalError;
      return false;
    },
    async createContinuationSummary() {
      throw new Error("not implemented");
    },
  } as unknown as Orchestrator;
}

class LiveCompletionReportHarness implements AgentHarness {
  readonly id = "live-completion-report";
  readonly prompts: string[] = [];
  readonly roles: string[] = [];

  constructor(
    private readonly lifecycleStore: FileIssueLifecycleStore,
    private readonly outboxStore: FileWritebackOutboxStore,
    private readonly runStore: FileRunTranscriptStore,
    private readonly publisher: CompletionReportPullRequestPublisher,
    private readonly operatorApproval: OperatorApprovalService,
    private readonly writebackProcessor: Pick<WritebackProcessor, "processDue">,
  ) {}

  async *run(ctx: AgentRunContext, prompt: string): AsyncIterable<AgentEvent> {
    this.prompts.push(prompt);
    this.roles.push(ctx.role);
    if (ctx.role === "reviewer") {
      yield { type: "session_started", sessionId: "live-review-session", runId: "live-review-run" };
      yield { type: "completed" };
      return;
    }
    yield { type: "session_started", sessionId: "live-report-session", runId: "live-report-run" };
    const report = new CompletionReportService({
      config: ctx.config,
      lifecycleStore: this.lifecycleStore,
      writebackOutbox: this.outboxStore,
      writebackProcessor: this.writebackProcessor,
      runStore: this.runStore,
      pullRequestPublisher: this.publisher,
      operatorApproval: this.operatorApproval,
    }).submitCompletionReport(
      {
        runId: "live-report-run",
        issueId: ctx.issue.id,
        summary: "Implemented the requested handoff.",
        validationEvidence: ["npm test"],
        acceptanceChecklist: [
          {
            text: "Completion report handoff is live.",
            satisfied: true,
            evidence: "Approval status API integration test",
          },
        ],
        changedFiles: ["src/core/CompletionReportService.ts"],
        branchName: ctx.workspace.gitBranchName ?? ctx.issue.branchName,
        pullRequest: null,
        risks: [],
        idempotencyKey: "idem-live",
      },
      {
        issue: ctx.issue,
        activeRunId: "live-report-run",
        role: "worker",
        sessionId: "live-report-session",
        workspacePath: ctx.workspace.path,
        workspace: ctx.workspace,
        phase: "implementation",
      },
    );
    const aborted = new Promise<"aborted">((resolve) => {
      if (ctx.abortSignal.aborted) {
        resolve("aborted");
        return;
      }
      ctx.abortSignal.addEventListener("abort", () => resolve("aborted"), { once: true });
    });
    const terminalRecord = (async () => {
      while (!ctx.abortSignal.aborted) {
        const run = await this.runStore.getRun("live-report-run");
        if (run?.status === "cancelled") return "cancelled" as const;
        if (run?.status === "failed") return "failed" as const;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return "aborted" as const;
    })();
    const outcome = await Promise.race([report.then(() => "reported" as const), aborted, terminalRecord]);
    if (outcome === "cancelled" || outcome === "aborted") {
      yield { type: "cancelled" };
      return;
    }
    if (outcome === "failed") {
      yield { type: "failed", error: OPERATOR_REJECTED_PUBLICATION_ERROR };
      return;
    }
    yield { type: "completed" };
  }
}

class FakeCompletionReportPublisher implements CompletionReportPullRequestPublisher {
  readonly inputs: CompletionReportPullRequestPublicationInput[] = [];

  constructor(private readonly publication: CompletionReportPullRequestPublication) {}

  async publishPullRequest(
    input: CompletionReportPullRequestPublicationInput,
  ): Promise<CompletionReportPullRequestPublication> {
    this.inputs.push(input);
    return this.publication;
  }
}

class StateChangingWriter implements TrackerWriter {
  readonly transitions: TrackerTransitionInput[] = [];
  readonly comments: TrackerCommentInput[] = [];

  constructor(private readonly setState: (state: string) => void) {}

  async transitionIssueState(input: TrackerTransitionInput): Promise<TrackerWriteResult> {
    this.transitions.push(input);
    this.setState(input.toState);
    return { status: "applied" };
  }

  async createIssueComment(input: TrackerCommentInput): Promise<TrackerWriteResult> {
    this.comments.push(input);
    return { status: "applied" };
  }
}

class FailingCommentWriter extends StateChangingWriter {
  async createIssueComment(_input: TrackerCommentInput): Promise<TrackerWriteResult> {
    throw new Error("linear comment failed");
  }
}

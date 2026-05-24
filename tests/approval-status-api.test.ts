import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StatusServer } from "../src/app/http.js";
import {
  CompletionReportService,
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
import type { ServiceConfig } from "../src/core/config/Config.js";
import { SymphonyError } from "../src/core/errors.js";
import type { AgentEvent, AgentHarness, AgentRunContext } from "../src/core/harness/AgentHarness.js";
import { FakeHarness } from "../src/core/harness/FakeHarness.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import { Orchestrator } from "../src/core/orchestrator/Orchestrator.js";
import { FileIssueLifecycleStore } from "../src/core/persistence/IssueLifecycleStore.js";
import { FileRunTranscriptStore } from "../src/core/persistence/RunTranscriptStore.js";
import type { TrackerClient } from "../src/core/tracker/TrackerClient.js";
import type { TrackerCommentInput, TrackerTransitionInput, TrackerWriteResult, TrackerWriter } from "../src/core/tracker/TrackerWriter.js";
import type { Issue } from "../src/core/types.js";
import { FileWritebackOutboxStore, WritebackProcessor } from "../src/core/writeback/WritebackOutbox.js";
import { WorkspaceManager } from "../src/core/workspace/WorkspaceManager.js";
import { CursorWorkspaceOpener } from "../cursor/src/CursorWorkspaceOpener.js";
import { issue, testConfig } from "./helpers.js";

describe("approval status API", () => {
  let root: string;
  let config: ServiceConfig;
  let runStore: FileRunTranscriptStore;
  let store: FileOperatorApprovalStore;
  let service: OperatorApprovalService;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-approval-api-"));
    config = testConfig(root);
    config.github.publishPullRequests = true;
    config.github.operatorApproval!.requiredForPublication = true;
    config.github.operatorApproval!.rejectPolicy = "cancel";
    runStore = new FileRunTranscriptStore(config.workspace.stateDir);
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
    await rm(root, { recursive: true, force: true });
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
      expect(response.status).toBe(200);
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
      expect(terminalRecords.map((record) => record.status)).toEqual(["rejected", "rejected"]);
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
      expect(writer.comments.some((comment) => comment.body.includes("Publication Approval Pending"))).toBe(true);
      expect(writer.transitions.map((transition) => transition.toState)).toEqual(["Todo", "Blocked"]);

      const url = `http://${address.host}:${address.port}/api/v1/approval-requests/${pending.requestId}`;
      const first = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-symphony-token": "secret" },
        body: JSON.stringify({ decision: "reject" }),
      });
      const firstBody = (await first.json()) as { replayed: boolean; request: { status: string } };
      await waitFor(() => orchestrator.snapshot().counts.running === 0, "live approval rejection");
      const firstRun = await waitForTerminalRun(runStore, "live-report-run");
      await waitFor(() => writer.comments.filter((comment) => comment.body.includes("Status: rejected")).length === 1, "terminal rejection comment");

      const replay = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-symphony-token": "secret" },
        body: JSON.stringify({ decision: "reject" }),
      });
      const replayBody = (await replay.json()) as { replayed: boolean; request: { status: string } };
      const replayRun = await waitForTerminalRun(runStore, "live-report-run");

      expect(first.status).toBe(200);
      expect(firstBody).toMatchObject({ replayed: false, request: { status: "rejected" } });
      expect(replay.status).toBe(200);
      expect(replayBody).toMatchObject({ replayed: true, request: { status: "rejected" } });
      expect(replayRun).toMatchObject({
        status: "cancelled",
        completedAt: firstRun.completedAt,
        pendingApprovalRequestId: null,
      });
      expect(replayRun.status).not.toBe("succeeded");
      expect(publisher.inputs).toEqual([]);
      expect(writer.comments.filter((comment) => comment.body.includes("Status: rejected"))).toHaveLength(1);
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
    const candidate = issue({ state: "Blocked", labels: ["dogfood-ready"], branchName: "symphony/TEST-1" });
    let currentState = "Blocked";
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
      blockedReason: "awaiting operator approval for PR publication",
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
    const { record: pending } = await store.requestOrGetPending(
      {
        issueId: candidate.id,
        issueIdentifier: candidate.identifier,
        runId,
        evidenceCursor,
        action: {
          kind: "push_and_pr",
          branchName: candidate.branchName ?? "symphony/TEST-1",
          baseBranch: "main",
          workspacePath,
          title: `${candidate.identifier}: ${candidate.title}`,
          evidenceCursor,
          summaryPreview: "Implemented the requested handoff.",
          changedFiles: ["src/core/orchestrator/Orchestrator.ts"],
          plannedOperations: ["commit_if_needed", "git_push", "pull_request_create_or_reuse"],
        },
      },
      null,
    );
    await runStore.updateRun(runId, {
      metadata: { pendingApprovalRequestId: pending.requestId, pendingApprovalRequestedAt: pending.requestedAt },
    });

    await expect(store.findPendingForRun(runId)).resolves.toMatchObject({
      status: "pending",
      runId,
      evidenceCursor,
    });
    await expect(runStore.getRun(runId)).resolves.toMatchObject({
      status: "succeeded",
      pendingApprovalRequestId: pending.requestId,
      pendingApprovalRequestedAt: expect.any(String),
    });
    await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
      phase: "blocked",
      blockedReason: "awaiting operator approval for PR publication",
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
      const issueBody = (await issueResponse.json()) as { capabilities: { pendingApproval: { active: boolean } } };

      expect(approve.status).toBe(200);
      expect(approveBody).toMatchObject({ request: { status: "approved" }, replayed: false });
      expect(issueBody.capabilities.pendingApproval.active).toBe(false);
      await expect(store.get(pending.requestId)).resolves.toMatchObject({ status: "approved" });

      expect(publisher.inputs).toHaveLength(1);
      expect(publisher.inputs[0]).toMatchObject({
        workspacePath,
        branchName: "symphony/TEST-1",
        baseBranch: "main",
        evidenceCursor,
      });
      expect(writer.comments).toHaveLength(1);
      expect(writer.comments[0]?.body).toContain("## Symphony Completion Report");
      expect(writer.comments[0]?.body).toContain("Status: accepted");
      expect(writer.transitions).toHaveLength(1);
      expect(writer.transitions[0]).toMatchObject({ toState: "In Review" });
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
        approvalResolvedCount: approvalResolvedCountBeforeReplay,
        prOpenedCount: prOpenedCountBeforeReplay,
        prUpdatedCount: prUpdatedCountBeforeReplay,
      };
      expect(replayBaseline.lifecycle.lastPushedAt).toBe("2026-01-01T00:00:01Z");
      expect(replayBaseline.lifecycle.lastEvidenceCursor).toBe(evidenceCursor);
      expect(replayBaseline.workerRun.lastPushedAt).toBe("2026-01-01T00:00:01Z");
      expect(replayBaseline.workerRun.lastEvidenceCursor).toBe(evidenceCursor);
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

  async function createPending(evidenceCursor: string, timeoutMs: number | null = null) {
    const { record } = await store.requestOrGetPending(
      {
        issueId: "issue-1",
        issueIdentifier: "TEST-1",
        runId: "run-1",
        evidenceCursor,
        action: action(evidenceCursor),
      },
      timeoutMs,
    );
    await runStore.updateRun("run-1", {
      metadata: { pendingApprovalRequestId: record.requestId, pendingApprovalRequestedAt: record.requestedAt },
    });
    return record;
  }

  async function waitForPending() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const pending = await store.findPendingForRun("run-1");
      if (pending) return pending;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("pending approval was not created");
  }

  async function waitForPendingRun(approvalStore: FileOperatorApprovalStore, runId: string, timeoutMs = 2_000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const pending = await approvalStore.findPendingForRun(runId);
      if (pending) return pending;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`pending approval was not created for ${runId}`);
  }

  async function waitForRun(transcriptStore: FileRunTranscriptStore, runId: string, timeoutMs = 2_000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const run = await transcriptStore.getRun(runId);
      if (run) return run;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`run was not recorded: ${runId}`);
  }

  async function waitForTerminalRun(transcriptStore: FileRunTranscriptStore, runId: string, timeoutMs = 2_000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const run = await transcriptStore.getRun(runId);
      if (run && run.status !== "running") return run;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`run did not become terminal: ${runId}`);
  }

  async function waitFor(predicate: () => boolean, description: string, timeoutMs = 2_000): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(predicate(), `Timed out waiting for ${description}`).toBe(true);
  }

  function statusServer(
    options: {
      cancelled?: string[];
      resumed?: OperatorApprovalRecord[];
      terminalRecords?: OperatorApprovalRecord[];
      terminalError?: Error;
      openWorkspaceToken?: string | null;
      operatorApproval?: ConstructorParameters<typeof StatusServer>[0]["operatorApproval"];
    } = {},
  ) {
    const cancelled = options.cancelled ?? [];
    const resumed = options.resumed ?? [];
    const terminalRecords = options.terminalRecords ?? [];
    return new StatusServer({
      orchestrator: fakeOrchestrator(cancelled, async () => {
        await runStore.updateRun("run-1", {
          status: "cancelled",
          completedAt: new Date().toISOString(),
          error: "Operator cancelled issue",
        });
      }, resumed, terminalRecords, options.terminalError),
      workspaceManager: new WorkspaceManager({
        workspace: config.workspace,
        hooks: config.hooks,
        logger: new StructuredLogger(() => undefined),
      }),
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      runStore,
      operatorApproval: options.operatorApproval ?? service,
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: options.openWorkspaceToken === undefined ? "secret" : options.openWorkspaceToken,
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
      return false;
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
    yield { type: "session_started", sessionId: "live-report-session", runId: "live-report-run" };
    await new CompletionReportService({
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

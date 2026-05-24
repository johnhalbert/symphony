import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StatusServer } from "../src/app/http.js";
import {
  FileOperatorApprovalStore,
  OPERATOR_REJECTED_PUBLICATION_ERROR,
  OperatorApprovalService,
  type OperatorApprovalAction,
} from "../src/core/approval/OperatorApprovalService.js";
import type { ServiceConfig } from "../src/core/config/Config.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import type { Orchestrator } from "../src/core/orchestrator/Orchestrator.js";
import { FileRunTranscriptStore } from "../src/core/persistence/RunTranscriptStore.js";
import { WorkspaceManager } from "../src/core/workspace/WorkspaceManager.js";
import { CursorWorkspaceOpener } from "../cursor/src/CursorWorkspaceOpener.js";
import { testConfig } from "./helpers.js";

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
    const server = statusServer();
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
    const server = statusServer({ cancelled });
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
    } finally {
      await server.stop();
    }
  });

  it("expires pending requests before status API rejection can resolve them", async () => {
    const pending = await createPending("idem-expired", -1);
    const cancelled: string[] = [];
    const server = statusServer({ cancelled });
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

  function statusServer(options: { cancelled?: string[]; openWorkspaceToken?: string | null } = {}) {
    const cancelled = options.cancelled ?? [];
    return new StatusServer({
      orchestrator: fakeOrchestrator(cancelled, async () => {
        await runStore.updateRun("run-1", {
          status: "cancelled",
          completedAt: new Date().toISOString(),
          error: "Operator cancelled issue",
        });
      }),
      workspaceManager: new WorkspaceManager({
        workspace: config.workspace,
        hooks: config.hooks,
        logger: new StructuredLogger(() => undefined),
      }),
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      runStore,
      operatorApproval: service,
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

function fakeOrchestrator(cancelled: string[], onCancel?: (issueId: string) => Promise<void>): Orchestrator {
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
    async createContinuationSummary() {
      throw new Error("not implemented");
    },
  } as unknown as Orchestrator;
}

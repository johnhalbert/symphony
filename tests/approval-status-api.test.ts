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
  type OperatorApprovalRecord,
} from "../src/core/approval/OperatorApprovalService.js";
import type { ServiceConfig } from "../src/core/config/Config.js";
import { SymphonyError } from "../src/core/errors.js";
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

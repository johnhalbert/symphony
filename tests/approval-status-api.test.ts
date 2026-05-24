import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StatusServer } from "../src/app/http.js";
import { FileOperatorApprovalStore, OperatorApprovalService, type OperatorApprovalAction } from "../src/core/approval/OperatorApprovalService.js";
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
      const approved = await fetch(`${baseUrl}/api/v1/approval-requests/${pending.requestId}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-symphony-token": "secret" },
        body: JSON.stringify({ decision: "approve" }),
      });
      const issueResponse = await fetch(`${baseUrl}/api/v1/issues/TEST-1`);
      const approvedBody = (await approved.json()) as { request: { status: string } };
      const issueBody = (await issueResponse.json()) as { capabilities: { pendingApproval: { active: boolean } } };

      expect(denied.status).toBe(401);
      expect(approved.status).toBe(200);
      expect(approvedBody.request.status).toBe("approved");
      expect(issueBody.capabilities.pendingApproval.active).toBe(false);
    } finally {
      await server.stop();
    }
  });

  it("rejects pending requests and invokes orchestrator cancellation", async () => {
    const pending = await createPending("idem-2");
    const cancelled: string[] = [];
    const server = statusServer(cancelled);
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
    const cancelled: string[] = [];
    const server = statusServer(cancelled);
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
      await expect(wait).rejects.toMatchObject({ code: "invalid_request" });
      await expect(runStore.getRun("run-1")).resolves.toMatchObject({ pendingApprovalRequestId: null });

      const transcript = await runStore.readTranscript("run-1");
      expect(transcript.events.at(-1)).toMatchObject({
        eventType: "approval_resolved",
        payload: { status: "rejected", rejectPolicy: "fail" },
      });
    } finally {
      await server.stop();
    }
  });

  async function createPending(evidenceCursor: string) {
    const { record } = await store.requestOrGetPending(
      {
        issueId: "issue-1",
        issueIdentifier: "TEST-1",
        runId: "run-1",
        evidenceCursor,
        action: action(evidenceCursor),
      },
      null,
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

  function statusServer(cancelled: string[] = []) {
    return new StatusServer({
      orchestrator: fakeOrchestrator(cancelled),
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

function fakeOrchestrator(cancelled: string[]): Orchestrator {
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
    },
    async createContinuationSummary() {
      throw new Error("not implemented");
    },
  } as unknown as Orchestrator;
}

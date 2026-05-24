import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FileOperatorApprovalStore,
  OPERATOR_REJECTED_PUBLICATION_ERROR,
  OperatorApprovalService,
  type OperatorApprovalAction,
} from "../src/core/approval/OperatorApprovalService.js";
import { FileRunTranscriptStore } from "../src/core/persistence/RunTranscriptStore.js";
import { testConfig } from "./helpers.js";

describe("OperatorApprovalService", () => {
  let root: string;
  let config: ReturnType<typeof testConfig>;
  let runStore: FileRunTranscriptStore;
  let store: FileOperatorApprovalStore;
  let service: OperatorApprovalService;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-operator-approval-"));
    config = testConfig(root);
    config.github.publishPullRequests = true;
    config.github.operatorApproval!.requiredForPublication = true;
    config.github.operatorApproval!.pollIntervalMs = 5;
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
      workspacePath: "/tmp/workspace",
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("emits a structured approval request and proceeds after approval", async () => {
    const wait = service.waitForPublicationApproval(request());
    const pending = await waitForPending();

    expect(pending.action).toMatchObject({
      kind: "push_and_pr",
      branchName: "symphony/TEST-1",
      plannedOperations: ["commit_if_needed", "git_push", "pull_request_create_or_reuse"],
    });

    await service.resolve(pending.requestId, "approve");
    await expect(wait).resolves.toMatchObject({ status: "approved" });

    const transcript = await runStore.readTranscript("run-1");
    expect(transcript.events.map((event) => event.eventType)).toEqual(["approval_request", "approval_resolved"]);
    expect(transcript.events[0]?.payload).toMatchObject({
      requestId: pending.requestId,
      action: { kind: "push_and_pr", branchName: "symphony/TEST-1" },
      resolve: { method: "POST", header: "X-Symphony-Token" },
    });
    await expect(runStore.getRun("run-1")).resolves.toMatchObject({ pendingApprovalRequestId: null });
  });

  it("dedupes pending approvals by run and evidence cursor", async () => {
    const first = service.waitForPublicationApproval(request());
    const pending = await waitForPending();
    const second = service.waitForPublicationApproval(request());

    await service.resolve(pending.requestId, "approve");
    await Promise.all([first, second]);

    const transcript = await runStore.readTranscript("run-1");
    expect(transcript.events.filter((event) => event.eventType === "approval_request")).toHaveLength(1);
  });

  it("fails the waiter when the operator rejects publication", async () => {
    config.github.operatorApproval!.rejectPolicy = "fail";
    const wait = service.waitForPublicationApproval(request());
    const pending = await waitForPending();
    const waiterError = wait.catch((error: unknown) => error);

    await service.resolve(pending.requestId, "reject");

    await expect(waiterError).resolves.toMatchObject({ code: "invalid_request" });
    await expect(runStore.getRun("run-1")).resolves.toMatchObject({
      status: "failed",
      completedAt: expect.any(String),
      error: OPERATOR_REJECTED_PUBLICATION_ERROR,
      pendingApprovalRequestId: null,
    });
    const transcript = await runStore.readTranscript("run-1");
    expect(transcript.events.at(-1)).toMatchObject({ eventType: "approval_resolved" });
  });

  it("marks approvals stale when the run is no longer active", async () => {
    const wait = service.waitForPublicationApproval(request());
    const pending = await waitForPending();
    const waiterError = wait.catch((error: unknown) => error);
    await runStore.updateRun("run-1", { status: "failed", completedAt: "2026-01-01T00:00:00Z" });

    await expect(service.resolve(pending.requestId, "approve")).rejects.toMatchObject({ code: "conflict" });
    await expect(waiterError).resolves.toMatchObject({ code: "invalid_request" });
    await expect(store.get(pending.requestId)).resolves.toMatchObject({ status: "stale" });
  });

  async function waitForPending() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const pending = await store.findPendingForRun("run-1");
      if (pending) return pending;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("pending approval was not created");
  }
});

function request() {
  return {
    issueId: "issue-1",
    issueIdentifier: "TEST-1",
    runId: "run-1",
    evidenceCursor: "idem-1",
    action: action(),
  };
}

function action(): OperatorApprovalAction {
  return {
    kind: "push_and_pr",
    branchName: "symphony/TEST-1",
    baseBranch: "main",
    workspacePath: "/tmp/workspace",
    title: "TEST-1: Do work",
    evidenceCursor: "idem-1",
    summaryPreview: "Implemented the service contract.",
    changedFiles: ["src/core/CompletionReportService.ts"],
    plannedOperations: ["commit_if_needed", "git_push", "pull_request_create_or_reuse"],
  };
}

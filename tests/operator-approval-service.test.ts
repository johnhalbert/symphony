import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      projectContext: {
        projectContextId: "docs",
        projectContextLabel: "Documentation Site",
        linearProjectSlug: "DOCS",
        routingSource: "candidate_poll",
      },
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
      projectContext: {
        projectContextId: "docs",
        projectContextLabel: "Documentation Site",
        linearProjectSlug: "DOCS",
        routingSource: "candidate_poll",
      },
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

  it("repairs run metadata when reusing an existing pending approval", async () => {
    const pending = await service.requestPublicationApproval(request());
    await runStore.updateRun("run-1", {
      metadata: {
        pendingApprovalRequestId: null,
        pendingApprovalRequestedAt: null,
      },
    });

    const reused = await service.requestPublicationApproval(request());

    expect(reused.requestId).toBe(pending.requestId);
    await expect(runStore.getRun("run-1")).resolves.toMatchObject({
      pendingApprovalRequestId: pending.requestId,
      pendingApprovalRequestedAt: pending.requestedAt,
    });
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

  it("allows approvals to be resolved after the worker run exits", async () => {
    const wait = service.waitForPublicationApproval(request());
    const pending = await waitForPending();
    await runStore.updateRun("run-1", { status: "succeeded", completedAt: "2026-01-01T00:00:00Z" });

    await expect(service.resolve(pending.requestId, "approve")).resolves.toMatchObject({
      request: { status: "approved" },
    });
    await expect(wait).resolves.toMatchObject({ status: "approved" });
    await expect(store.get(pending.requestId)).resolves.toMatchObject({ status: "approved" });
  });


  it("derives project context from the run and backfills legacy approval records", async () => {
    const pending = await service.requestPublicationApproval({ ...request(), evidenceCursor: "idem-project-context" });
    expect(pending).toMatchObject({
      projectContext: {
        projectContextId: "docs",
        projectContextLabel: "Documentation Site",
        linearProjectSlug: "DOCS",
        routingSource: "candidate_poll",
      },
    });

    const transcript = await runStore.readTranscript("run-1");
    expect(transcript.events[0]?.payload).toMatchObject({
      projectContext: {
        projectContextId: "docs",
        projectContextLabel: "Documentation Site",
        linearProjectSlug: "DOCS",
        routingSource: "candidate_poll",
      },
    });

    const approvalDir = path.join(config.workspace.stateDir, "approval-requests");
    await mkdir(approvalDir, { recursive: true });
    await writeFile(
      path.join(approvalDir, "approval_legacy.json"),
      `${JSON.stringify(
        {
          requestId: "approval_legacy",
          status: "pending",
          issueId: "issue-legacy-1",
          issueIdentifier: "LEGACY-1",
          runId: "run-1",
          evidenceCursor: "legacy-cursor",
          dedupeKey: "run-1:legacy-cursor:push_and_pr",
          action: action(),
          requestedAt: "2026-01-01T00:00:00.000Z",
          expiresAt: null,
          resolvedAt: null,
          resolvedBy: null,
          decision: null,
          staleReason: null,
        },
        null,
        2,
      )}
`,
      "utf8",
    );

    await expect(store.get("approval_legacy")).resolves.toMatchObject({
      projectContext: {
        projectContextId: "default",
        projectContextLabel: "Default",
        linearProjectSlug: null,
        routingSource: "legacy_default",
      },
    });
  });

  it("backfills project context when reusing a legacy pending approval request", async () => {
    const pending = await service.requestPublicationApproval({ ...request(), evidenceCursor: "idem-project-context-replay" });
    const approvalPath = path.join(config.workspace.stateDir, "approval-requests", `${pending.requestId}.json`);
    const legacyRecord = JSON.parse(await readFile(approvalPath, "utf8")) as Record<string, unknown>;
    delete legacyRecord.projectContext;
    await writeFile(approvalPath, `${JSON.stringify(legacyRecord, null, 2)}
`, "utf8");

    const replayed = await service.requestPublicationApproval({ ...request(), evidenceCursor: "idem-project-context-replay" });

    expect(replayed).toMatchObject({
      requestId: pending.requestId,
      projectContext: {
        projectContextId: "docs",
        projectContextLabel: "Documentation Site",
        linearProjectSlug: "DOCS",
        routingSource: "candidate_poll",
      },
    });
    await expect(store.get(pending.requestId)).resolves.toMatchObject({
      projectContext: {
        projectContextId: "docs",
        projectContextLabel: "Documentation Site",
        linearProjectSlug: "DOCS",
        routingSource: "candidate_poll",
      },
    });
    const transcript = await runStore.readTranscript("run-1");
    expect(transcript.events.filter((event) => event.eventType === "approval_request")).toHaveLength(1);
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

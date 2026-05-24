import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CompletionReportService,
  PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON,
  PUBLICATION_APPROVAL_SETUP_INCOMPLETE_REASON,
  type CompletionReportActiveContext,
  type CompletionReportInput,
} from "../src/core/CompletionReportService.js";
import { SymphonyError } from "../src/core/errors.js";
import { FileIssueLifecycleStore } from "../src/core/persistence/IssueLifecycleStore.js";
import { FileRunTranscriptStore } from "../src/core/persistence/RunTranscriptStore.js";
import {
  FileWritebackOutboxStore,
  WritebackProcessor,
  type NewWritebackOperation,
  type WritebackOperation,
} from "../src/core/writeback/WritebackOutbox.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import type { TrackerCommentInput, TrackerTransitionInput, TrackerWriteResult, TrackerWriter } from "../src/core/tracker/TrackerWriter.js";
import { issue, testConfig } from "./helpers.js";
import type { OperatorApprovalRecord, OperatorApprovalRequestInput, OperatorApprovalStatus } from "../src/core/approval/OperatorApprovalService.js";
import type {
  CompletionReportPullRequestPublication,
  CompletionReportPullRequestPublicationInput,
  CompletionReportPullRequestPublisher,
} from "../src/core/CompletionReportService.js";

describe("CompletionReportService", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-completion-report-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("accepts a worker completion report, records it, and enqueues review writebacks", async () => {
    const { service, lifecycleStore, outbox } = fixture();

    const result = await service.submit_completion_report(report(), context());

    expect(result.replayed).toBe(false);
    expect(result.writebackOperations).toHaveLength(2);
    const lifecycle = await lifecycleStore.get("issue-1");
    expect(lifecycle).toMatchObject({
      phase: "review",
      lastCompletionReportId: "completion-report:issue-1:idem-1",
      incompleteTurnCount: 0,
      completionReports: [
        {
          id: "completion-report:issue-1:idem-1",
          idempotencyKey: "idem-1",
          runId: "run-1",
          issueId: "issue-1",
          issueIdentifier: "TEST-1",
          summary: "Implemented the service contract.",
          changedFiles: ["src/core/CompletionReportService.ts"],
          branchName: "symphony/TEST-1",
          pullRequest: null,
          risks: ["Reviewer handler remains out of scope."],
        },
      ],
    });
    const operations = await outbox.list();
    const commentOperation = operations.find((operation) => operation.kind === "comment");
    const transitionOperation = operations.find((operation) => operation.kind === "transition");
    expect(operations).toHaveLength(2);
    expect(commentOperation).toMatchObject({
      kind: "comment",
      idempotencyKey: "comment:issue-1:run-1:completion-report:idem-1",
      payload: {
        dedupeKey: "run-1:completion-report:idem-1",
      },
    });
    expect(commentOperation?.kind === "comment" ? commentOperation.payload.body : "").toContain("Completion report:");
    expect(transitionOperation).toMatchObject({
      kind: "transition",
      idempotencyKey: "transition:issue-1:run-1:completion-report:idem-1:In Review",
      payload: {
        fromStates: ["In Progress"],
        toState: "In Review",
      },
    });
  });

  it("replays duplicate reports without new lifecycle or writeback side effects", async () => {
    const { service, lifecycleStore, outbox } = fixture();

    const first = await service.submitCompletionReport(report(), context());
    const second = await service.submitCompletionReport(report({ summary: "Changed summary on replay." }), context());

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.report.summary).toBe("Implemented the service contract.");
    expect((await lifecycleStore.get("issue-1"))?.completionReports).toHaveLength(1);
    expect(await outbox.list()).toHaveLength(2);
  });

  it("publishes a new service-owned PR before accepting a completion report", async () => {
    const publisher = new FakePublisher({
      action: "created",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "idem-1",
    });
    const { service, lifecycleStore, outbox, runStore } = fixture({ publisher });
    await startRun(runStore);

    const result = await service.submitCompletionReport(report(), contextWithWorkspace());

    expect(result.report.pullRequest).toEqual({
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headSha: "abc123",
      branch: "symphony/TEST-1",
    });
    expect(publisher.inputs).toHaveLength(1);
    expect(publisher.inputs[0]).toMatchObject({
      workspacePath: "/tmp/workspace",
      branchName: "symphony/TEST-1",
      baseBranch: "main",
      evidenceCursor: "idem-1",
    });
    const comment = (await outbox.list()).find((operation) => operation.kind === "comment");
    expect(comment?.kind === "comment" ? comment.payload.body : "").toContain("https://github.com/acme/symphony/pull/42");
    expect(comment?.kind === "comment" ? comment.payload.body : "").toContain("PR head SHA: abc123");
    await expect(runStore.getRun("run-1")).resolves.toMatchObject({
      prUrl: "https://github.com/acme/symphony/pull/42",
      prNumber: 42,
      prHeadSha: "abc123",
      prBranch: "symphony/TEST-1",
      lastEvidenceCursor: "idem-1",
    });
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      phase: "review",
      summaryPointers: {
        prUrl: "https://github.com/acme/symphony/pull/42",
        prNumber: 42,
        prHeadSha: "abc123",
        prBranch: "symphony/TEST-1",
        lastEvidenceCursor: "idem-1",
      },
    });
  });

  it("persists a pending completion report and Linear audit before waiting for service-owned publication approval", async () => {
    const publisher = new FakePublisher({
      action: "created",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "idem-1",
    });
    const operatorApproval = new DeferredOperatorApproval();
    const { service, lifecycleStore, outbox, runStore, writer } = fixture({
      publisher,
      operatorApproval,
      requirePublicationApproval: true,
    });
    operatorApproval.onRequest = async () => {
      await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
        phase: "blocked",
        blockedReason: PUBLICATION_APPROVAL_SETUP_INCOMPLETE_REASON,
        lastCompletionReportId: "completion-report:issue-1:idem-1",
        completionReports: [
          {
            id: "completion-report:issue-1:idem-1",
            idempotencyKey: "idem-1",
            runId: "run-1",
            writebackOperationKeys: [],
          },
        ],
      });
    };
    await startRun(runStore);

    const submission = service.submitCompletionReport(report(), contextWithWorkspace());
    const approvalRequest = await operatorApproval.waitForRequest();
    await operatorApproval.waitForWaiter();

    expect(approvalRequest.action).toMatchObject({
      kind: "push_and_pr",
      branchName: "symphony/TEST-1",
      plannedOperations: ["commit_if_needed", "git_push", "pull_request_create_or_reuse"],
    });
    expect(publisher.inputs).toHaveLength(0);
    const pendingOperations = await outbox.list();
    const pendingComment = pendingOperations.find((operation) => operation.kind === "comment");
    const pendingTransition = pendingOperations.find((operation) => operation.kind === "transition");
    expect(pendingOperations).toHaveLength(2);
    expect(pendingOperations.map((operation) => operation.status)).toEqual(["succeeded", "succeeded"]);
    expect(writer.comments).toHaveLength(1);
    expect(writer.comments[0]?.body).toContain("Symphony Publication Approval Setup Incomplete");
    expect(writer.transitions.map((transition) => transition.toState)).toEqual(["Blocked"]);
    expect(pendingComment?.kind === "comment" ? pendingComment.payload.body : "").toContain(
      "Status: worker completion report persisted; Symphony is preparing",
    );
    expect(pendingComment?.kind === "comment" ? pendingComment.payload.body : "").not.toContain(
      "Approve the pending operator request",
    );
    expect(pendingTransition).toMatchObject({
      kind: "transition",
      payload: {
        toState: "Blocked",
      },
    });
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      phase: "blocked",
      blockedReason: PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON,
      lastCompletionReportId: "completion-report:issue-1:idem-1",
      completionReports: [
        {
          id: "completion-report:issue-1:idem-1",
          idempotencyKey: "idem-1",
          runId: "run-1",
          pullRequest: null,
          writebackOperationKeys: [],
        },
      ],
    });

    operatorApproval.approve();
    const result = await submission;

    expect(result.replayed).toBe(false);
    expect(result.report).toMatchObject({
      id: "completion-report:issue-1:idem-1",
      pullRequest: null,
      writebackOperationKeys: [],
    });
    expect(publisher.inputs).toHaveLength(0);
    expect(await outbox.list()).toHaveLength(2);
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      phase: "blocked",
      blockedReason: PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON,
      completionReports: [
        {
          id: "completion-report:issue-1:idem-1",
          pullRequest: null,
          writebackOperationKeys: [],
        },
      ],
    });
  });

  it("keeps the pending lifecycle guard without creating approval when pending Linear audit writeback fails", async () => {
    const operatorApproval = new DeferredOperatorApproval();
    const { service, lifecycleStore, outbox, runStore } = fixture({
      operatorApproval,
      requirePublicationApproval: true,
      writer: new FailingWriter(),
    });
    await startRun(runStore);

    await expect(service.submitCompletionReport(report(), contextWithWorkspace())).rejects.toMatchObject({
      code: "tracker_error",
    });

    const operations = await outbox.list();
    expect(operations).toHaveLength(2);
    expect(operations.map((operation) => operation.status)).toEqual(["retrying", "retrying"]);
    expect(operatorApproval.requests).toHaveLength(0);
    expect((await runStore.getRun("run-1"))?.pendingApprovalRequestId ?? null).toBeNull();
    const lifecycle = await lifecycleStore.get("issue-1");
    expect(lifecycle).toMatchObject({
      phase: "blocked",
      blockedReason: PUBLICATION_APPROVAL_SETUP_INCOMPLETE_REASON,
      lastCompletionReportId: "completion-report:issue-1:idem-1",
      incompleteTurnCount: 0,
      completionReports: [
        {
          id: "completion-report:issue-1:idem-1",
          idempotencyKey: "idem-1",
          runId: "run-1",
          writebackOperationKeys: [],
        },
      ],
    });
  });

  it.each([
    ["comment fails after Blocked transition succeeds", () => new CommentFailingWriter()],
    ["Blocked transition fails after comment succeeds", () => new TransitionFailingWriter()],
  ])("recovers pending publication approval after partial audit writeback failure: %s", async (_name, writerFactory) => {
    const operatorApproval = new DeferredOperatorApproval();
    const { service, lifecycleStore, outbox, runStore, config } = fixture({
      operatorApproval,
      requirePublicationApproval: true,
      writer: writerFactory(),
      maxBackoffMs: 0,
    });
    await startRun(runStore);

    await expect(service.submitCompletionReport(report(), contextWithWorkspace())).rejects.toMatchObject({
      code: "tracker_error",
    });
    expect(operatorApproval.requests).toHaveLength(0);
    expect((await runStore.getRun("run-1"))?.pendingApprovalRequestId ?? null).toBeNull();
    expect((await outbox.list()).map((operation) => operation.status)).toContain("retrying");

    const healthyWriter = new StateChangingWriter();
    const recoveryService = new CompletionReportService({
      config,
      lifecycleStore,
      writebackOutbox: outbox,
      writebackProcessor: new WritebackProcessor(
        outbox,
        healthyWriter,
        new StructuredLogger(() => undefined),
        config.writeback.maxBackoffMs,
      ),
      runStore,
      operatorApproval,
    });

    const recovered = await recoveryService.recoverPendingPublicationApproval({
      issue: issue({ state: "Blocked", branchName: "symphony/TEST-1" }),
    });

    expect(recovered).toMatchObject({ recovered: true });
    expect(operatorApproval.requests).toHaveLength(1);
    expect(operatorApproval.requests[0]).toMatchObject({
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      runId: "run-1",
      evidenceCursor: "idem-1",
      action: {
        branchName: "symphony/TEST-1",
        baseBranch: "main",
        workspacePath: "/tmp/workspace",
      },
    });
    expect((await outbox.list()).map((operation) => operation.status)).toEqual(["succeeded", "succeeded"]);
  });

  it("does not recover an awaiting publication approval lifecycle with a valid linked pending approval", async () => {
    const operatorApproval = new DeferredOperatorApproval();
    operatorApproval.records.push(approvalRecord("pending"));
    const { service, lifecycleStore, outbox, runStore, writer } = fixture({
      operatorApproval,
      requirePublicationApproval: true,
    });
    await startRun(runStore);
    await runStore.updateRun("run-1", {
      status: "succeeded",
      completedAt: "2026-01-01T00:00:00.000Z",
      metadata: {
        pendingApprovalRequestId: "approval-1",
        pendingApprovalRequestedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    await lifecycleStore.ensureIssue(issue({ state: "Blocked", branchName: "symphony/TEST-1" }), {
      phase: "blocked",
      blockedReason: PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON,
      lastCompletionReportId: "completion-report:issue-1:idem-1",
      completionReports: [pendingReportRecord()],
    });
    const lifecycleBefore = await lifecycleStore.get("issue-1");

    const recovered = await service.recoverPendingPublicationApproval({
      issue: issue({ state: "Blocked", branchName: "symphony/TEST-1" }),
    });

    expect(recovered).toMatchObject({ recovered: false, reason: "approval_already_pending" });
    expect(operatorApproval.requests).toHaveLength(0);
    expect(await outbox.list()).toEqual([]);
    expect(writer.comments).toEqual([]);
    expect(writer.transitions).toEqual([]);
    await expect(lifecycleStore.get("issue-1")).resolves.toEqual(lifecycleBefore);
    await expect(runStore.getRun("run-1")).resolves.toMatchObject({
      pendingApprovalRequestId: "approval-1",
    });
  });

  it("returns missing_run recovery without creating approval or finalizing lifecycle", async () => {
    const operatorApproval = new DeferredOperatorApproval();
    const { service, lifecycleStore, outbox } = fixture({
      operatorApproval,
      requirePublicationApproval: true,
    });
    await lifecycleStore.ensureIssue(issue({ state: "Blocked", branchName: "symphony/TEST-1" }), {
      phase: "blocked",
      blockedReason: PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON,
      lastCompletionReportId: "completion-report:issue-1:idem-1",
      completionReports: [pendingReportRecord()],
    });
    const lifecycleBefore = await lifecycleStore.get("issue-1");

    const recovered = await service.recoverPendingPublicationApproval({
      issue: issue({ state: "Blocked", branchName: "symphony/TEST-1" }),
    });

    expect(recovered).toMatchObject({ recovered: false, reason: "missing_run" });
    expect(operatorApproval.requests).toHaveLength(0);
    expect(await outbox.list()).toEqual([]);
    await expect(lifecycleStore.get("issue-1")).resolves.toEqual(lifecycleBefore);
  });

  it("returns audit_not_settled recovery without duplicate approval or finalization", async () => {
    const operatorApproval = new DeferredOperatorApproval();
    const { service, lifecycleStore, outbox, runStore } = fixture({
      operatorApproval,
      requirePublicationApproval: true,
      writer: new FailingWriter(),
      maxBackoffMs: 0,
    });
    await startRun(runStore);
    await runStore.updateRun("run-1", { status: "succeeded", completedAt: "2026-01-01T00:00:00.000Z" });
    await lifecycleStore.ensureIssue(issue({ state: "Blocked", branchName: "symphony/TEST-1" }), {
      phase: "blocked",
      blockedReason: PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON,
      lastCompletionReportId: "completion-report:issue-1:idem-1",
      completionReports: [pendingReportRecord()],
      summaryPointers: {
        workspacePath: "/tmp/workspace",
        branchName: "symphony/TEST-1",
        gitBranchName: "symphony/TEST-1",
        repoPath: "/repo",
        baseRef: "main",
      },
    });

    const recovered = await service.recoverPendingPublicationApproval({
      issue: issue({ state: "Blocked", branchName: "symphony/TEST-1" }),
    });

    expect(recovered).toMatchObject({ recovered: false, reason: "audit_not_settled" });
    expect(operatorApproval.requests).toHaveLength(0);
    expect((await outbox.list()).map((operation) => operation.status)).toEqual(["retrying", "retrying"]);
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      phase: "blocked",
      blockedReason: PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON,
      completionReports: [
        expect.objectContaining({
          idempotencyKey: "idem-1",
          pullRequest: null,
          writebackOperationKeys: [],
        }),
      ],
    });
    expect((await runStore.getRun("run-1"))?.pendingApprovalRequestId ?? null).toBeNull();
  });

  it("repairs an awaiting publication approval lifecycle with only a deduped pending approval", async () => {
    const operatorApproval = new DeferredOperatorApproval();
    operatorApproval.records.push(approvalRecord("pending"));
    const { service, lifecycleStore, outbox, runStore } = fixture({
      operatorApproval,
      requirePublicationApproval: true,
    });
    await startRun(runStore);
    await runStore.updateRun("run-1", {
      status: "succeeded",
      completedAt: "2026-01-01T00:00:00.000Z",
    });
    await lifecycleStore.ensureIssue(issue({ state: "Blocked", branchName: "symphony/TEST-1" }), {
      phase: "blocked",
      blockedReason: PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON,
      lastCompletionReportId: "completion-report:issue-1:idem-1",
      completionReports: [pendingReportRecord()],
      summaryPointers: {
        workspacePath: "/tmp/workspace",
        branchName: "symphony/TEST-1",
        gitBranchName: "symphony/TEST-1",
        repoPath: "/repo",
        baseRef: "main",
      },
    });

    const recovered = await service.recoverPendingPublicationApproval({
      issue: issue({ state: "Blocked", branchName: "symphony/TEST-1" }),
    });

    expect(recovered).toMatchObject({ recovered: true, outcome: "pending" });
    expect(operatorApproval.requests).toHaveLength(0);
    expect((await outbox.list()).map((operation) => operation.status)).toEqual(["succeeded", "succeeded"]);
    await expect(runStore.getRun("run-1")).resolves.toMatchObject({
      pendingApprovalRequestId: "approval-1",
    });
  });

  it("recovers a pre-approved publication approval from a stored pending report", async () => {
    const publisher = new FakePublisher({
      action: "created",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "idem-1",
    });
    const operatorApproval = new DeferredOperatorApproval();
    operatorApproval.records.push(approvalRecord("approved"));
    const { service, lifecycleStore, outbox, runStore, writer } = fixture({
      publisher,
      operatorApproval,
      requirePublicationApproval: true,
    });
    await startRun(runStore);
    await runStore.updateRun("run-1", { status: "succeeded", completedAt: "2026-01-01T00:00:00.000Z" });
    await lifecycleStore.ensureIssue(issue({ state: "Blocked", branchName: "symphony/TEST-1" }), {
      phase: "blocked",
      blockedReason: PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON,
      lastCompletionReportId: "completion-report:issue-1:idem-1",
      completionReports: [pendingReportRecord()],
      summaryPointers: {
        workspacePath: "/tmp/workspace",
        branchName: "symphony/TEST-1",
        gitBranchName: "symphony/TEST-1",
        repoPath: "/repo",
        baseRef: "main",
      },
    });

    const recovered = await service.recoverPendingPublicationApproval({
      issue: issue({ state: "Blocked", branchName: "symphony/TEST-1" }),
    });

    expect(recovered).toMatchObject({ recovered: true, outcome: "approved" });
    expect(operatorApproval.requests).toHaveLength(0);
    expect(operatorApproval.records).toHaveLength(1);
    expect(publisher.inputs).toHaveLength(1);
    expect((await outbox.list()).map((operation) => operation.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect(writer.comments.some((comment) => comment.body.includes("Status: accepted"))).toBe(true);
    expect(writer.transitions.map((transition) => transition.toState)).toContain("In Review");
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      phase: "review",
      blockedReason: null,
      completionReports: [
        expect.objectContaining({
          idempotencyKey: "idem-1",
          pullRequest: {
            url: "https://github.com/acme/symphony/pull/42",
            number: 42,
            headSha: "abc123",
            branch: "symphony/TEST-1",
          },
        }),
      ],
    });
  });

  it("recovers a terminal publication approval from a stored pending report", async () => {
    const publisher = new FakePublisher({
      action: "created",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "idem-1",
    });
    const operatorApproval = new DeferredOperatorApproval();
    operatorApproval.records.push(approvalRecord("cancelled"));
    const { service, lifecycleStore, outbox, runStore, writer } = fixture({
      publisher,
      operatorApproval,
      requirePublicationApproval: true,
    });
    await startRun(runStore);
    await runStore.updateRun("run-1", { status: "succeeded", completedAt: "2026-01-01T00:00:00.000Z" });
    await lifecycleStore.ensureIssue(issue({ state: "Blocked", branchName: "symphony/TEST-1" }), {
      phase: "blocked",
      blockedReason: PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON,
      lastCompletionReportId: "completion-report:issue-1:idem-1",
      completionReports: [pendingReportRecord()],
      summaryPointers: {
        workspacePath: "/tmp/workspace",
        branchName: "symphony/TEST-1",
        gitBranchName: "symphony/TEST-1",
        repoPath: "/repo",
        baseRef: "main",
      },
    });

    const recovered = await service.recoverPendingPublicationApproval({
      issue: issue({ state: "Blocked", branchName: "symphony/TEST-1" }),
    });

    expect(recovered).toMatchObject({ recovered: true, outcome: "terminal" });
    expect(operatorApproval.requests).toHaveLength(0);
    expect(operatorApproval.records).toHaveLength(1);
    expect(publisher.inputs).toHaveLength(0);
    expect((await outbox.list()).map((operation) => operation.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect(writer.comments.some((comment) => comment.body.includes("Status: cancelled"))).toBe(true);
    expect(writer.comments.some((comment) => comment.body.includes("Status: accepted"))).toBe(false);
    expect(writer.transitions.map((transition) => transition.toState)).not.toContain("In Review");
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      phase: "blocked",
      blockedReason: "publication approval cancelled",
      completionReports: [
        expect.objectContaining({
          idempotencyKey: "idem-1",
          pullRequest: null,
          writebackOperationKeys: [],
        }),
      ],
    });
  });

  it("resumes approved publication from a stored pending report after the worker run exits", async () => {
    const publisher = new FakePublisher({
      action: "created",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "idem-1",
    });
    const { service, lifecycleStore, outbox, runStore } = fixture({
      publisher,
      requirePublicationApproval: true,
    });
    await startRun(runStore);
    await runStore.updateRun("run-1", { status: "succeeded", completedAt: "2026-01-01T00:00:00.000Z" });
    await lifecycleStore.ensureIssue(issue({ state: "Blocked", branchName: "symphony/TEST-1" }), {
      phase: "blocked",
      blockedReason: PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON,
      lastCompletionReportId: "completion-report:issue-1:idem-1",
      completionReports: [pendingReportRecord()],
      summaryPointers: {
        workspacePath: "/tmp/workspace",
        branchName: "symphony/TEST-1",
        gitBranchName: "symphony/TEST-1",
        repoPath: "/repo",
        baseRef: "main",
      },
    });

    const result = await service.resumeApprovedPublication({
      approval: approvalRecord("approved"),
      issue: issue({ state: "Blocked", branchName: "symphony/TEST-1" }),
    });

    expect(result?.replayed).toBe(false);
    expect(publisher.inputs).toHaveLength(1);
    expect(publisher.inputs[0]).toMatchObject({
      workspacePath: "/tmp/workspace",
      branchName: "symphony/TEST-1",
      baseBranch: "main",
      evidenceCursor: "idem-1",
    });
    expect(await outbox.list()).toHaveLength(2);
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      phase: "review",
      blockedReason: null,
      completionReports: [
        {
          idempotencyKey: "idem-1",
          pullRequest: {
            url: "https://github.com/acme/symphony/pull/42",
            number: 42,
            headSha: "abc123",
            branch: "symphony/TEST-1",
          },
          writebackOperationKeys: [
            "comment:issue-1:run-1:completion-report:idem-1",
            "transition:issue-1:run-1:completion-report:idem-1:In Review",
          ],
        },
      ],
    });
    await expect(runStore.getRun("run-1")).resolves.toMatchObject({
      prUrl: "https://github.com/acme/symphony/pull/42",
      prNumber: 42,
      prHeadSha: "abc123",
      prBranch: "symphony/TEST-1",
    });
  });

  it("records rejection guidance from a stored pending report after the worker run exits", async () => {
    const { service, lifecycleStore, outbox, runStore } = fixture({ requirePublicationApproval: true });
    await startRun(runStore);
    await runStore.updateRun("run-1", { status: "succeeded", completedAt: "2026-01-01T00:00:00.000Z" });
    await lifecycleStore.ensureIssue(issue({ state: "Blocked", branchName: "symphony/TEST-1" }), {
      phase: "blocked",
      blockedReason: PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON,
      lastCompletionReportId: "completion-report:issue-1:idem-1",
      completionReports: [pendingReportRecord()],
      summaryPointers: {
        workspacePath: "/tmp/workspace",
        branchName: "symphony/TEST-1",
        gitBranchName: "symphony/TEST-1",
        repoPath: "/repo",
        baseRef: "main",
      },
    });

    await expect(
      service.recordPublicationApprovalTerminal({
        approval: approvalRecord("rejected"),
        issue: issue({ state: "Blocked", branchName: "symphony/TEST-1" }),
      }),
    ).resolves.toBe(true);

    const operations = await outbox.list();
    expect(operations).toHaveLength(1);
    expect(operations[0]?.kind === "comment" ? operations[0].payload.body : "").toContain("Status: rejected");
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      phase: "blocked",
      blockedReason: "publication approval rejected",
    });
  });

  it.each(["rejected", "cancelled"] as const)(
    "records retry guidance when publication approval is %s",
    async (status) => {
      const publisher = new FakePublisher({
        action: "created",
        url: "https://github.com/acme/symphony/pull/42",
        number: 42,
        headBranch: "symphony/TEST-1",
        headSha: "abc123",
        lastPushedAt: "2026-01-01T00:00:01Z",
        evidenceCursor: "idem-1",
      });
      const operatorApproval = new DeferredOperatorApproval();
      const { service, lifecycleStore, outbox, runStore } = fixture({
        publisher,
        operatorApproval,
        requirePublicationApproval: true,
      });
      await startRun(runStore);

      const submission = service.submitCompletionReport(report(), contextWithWorkspace());
      await operatorApproval.waitForRequest();
      await operatorApproval.waitForWaiter();
      operatorApproval.terminal(status);

      await expect(submission).rejects.toMatchObject({ code: "invalid_request" });
      expect(publisher.inputs).toHaveLength(0);
      const operations = await outbox.list();
      const terminalComment = operations.find(
        (operation) =>
          operation.kind === "comment" &&
          operation.idempotencyKey === `comment:issue-1:run-1:completion-report:idem-1:publication-approval-${status}`,
      );
      expect(terminalComment?.kind === "comment" ? terminalComment.payload.body : "").toContain(`Status: ${status}`);
      expect(terminalComment?.kind === "comment" ? terminalComment.payload.body : "").toContain("Recovery:");
      await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
        phase: "blocked",
        blockedReason: `publication approval ${status}`,
      });
    },
  );

  it("reuses a service-discovered PR and prevents duplicate publication on replay", async () => {
    const publisher = new FakePublisher({
      action: "reused",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "idem-1",
    });
    const { service, runStore, outbox } = fixture({ publisher });
    await startRun(runStore);

    const first = await service.submitCompletionReport(report(), contextWithWorkspace());
    const second = await service.submitCompletionReport(report({ summary: "Changed on replay." }), contextWithWorkspace());
    const transcript = await runStore.readTranscript("run-1");

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(publisher.inputs).toHaveLength(1);
    expect(await outbox.list()).toHaveLength(2);
    expect(transcript.events.filter((event) => event.eventType === "pr_opened")).toHaveLength(1);
  });

  it("rejects completion handoff when service-owned PR publication fails", async () => {
    const publisher = new FakePublisher(null, new SymphonyError("tracker_error", "GitHub branch push failed"));
    const { service, lifecycleStore, outbox } = fixture({ publisher });

    await expect(service.submitCompletionReport(report(), contextWithWorkspace())).rejects.toMatchObject({
      code: "tracker_error",
    });

    expect(await lifecycleStore.get("issue-1")).toBeNull();
    expect(await outbox.list()).toHaveLength(0);
  });

  it("does not durably accept a report when enqueueing writebacks fails", async () => {
    const config = testConfig(root);
    config.writeback.enabled = true;
    config.writeback.dispatchState = "In Progress";
    config.reviewLoop.reviewStates = ["In Review"];
    const lifecycleStore = new FileIssueLifecycleStore(root);
    const failingOutbox = new FailingOutbox();
    const failingService = new CompletionReportService({ config, lifecycleStore, writebackOutbox: failingOutbox });

    await expect(failingService.submitCompletionReport(report(), context())).rejects.toThrow("enqueue failed");

    const afterFailure = await lifecycleStore.get("issue-1");
    expect(afterFailure?.phase).toBe("implementation");
    expect(afterFailure?.lastCompletionReportId).toBeNull();
    expect(afterFailure?.completionReports).toHaveLength(0);
    expect(failingOutbox.attempted).toBeGreaterThan(0);

    const outbox = new FileWritebackOutboxStore(root);
    const retryService = new CompletionReportService({ config, lifecycleStore, writebackOutbox: outbox });
    const retry = await retryService.submitCompletionReport(report(), context());

    expect(retry.replayed).toBe(false);
    expect(retry.writebackOperations).toHaveLength(2);
    expect((await lifecycleStore.get("issue-1"))?.completionReports).toHaveLength(1);
  });

  it("rejects reports for a different active run", async () => {
    const { service } = fixture();

    await expect(service.submitCompletionReport(report({ runId: "run-2" }), context())).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("rejects reports outside the implementation state and phase", async () => {
    const { service, lifecycleStore } = fixture();
    await lifecycleStore.ensureIssue(issue({ state: "In Review" }), { phase: "review" });

    await expect(
      service.submitCompletionReport(report(), context({ issue: issue({ state: "In Review" }), phase: "review" })),
    ).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("rejects invalid role and token context", async () => {
    const { service } = fixture();

    await expect(service.submitCompletionReport(report(), context({ role: "reviewer" }))).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(service.submitCompletionReport(report(), context({ token: "wrong-token" }))).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("rejects missing required report fields", async () => {
    const { service } = fixture();
    const { summary: _summary, ...missingSummary } = report();

    await expect(service.submitCompletionReport(missingSummary, context())).rejects.toBeInstanceOf(SymphonyError);
    await expect(service.submitCompletionReport(missingSummary, context())).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  function fixture(
    options: {
      publisher?: CompletionReportPullRequestPublisher;
      operatorApproval?: Pick<DeferredOperatorApproval, "requestPublicationApproval" | "waitForPublicationApprovalRequest">;
      requirePublicationApproval?: boolean;
      writer?: TrackerWriter;
      maxBackoffMs?: number;
    } = {},
  ) {
    const config = testConfig(root);
    config.writeback.enabled = true;
    config.writeback.dispatchState = "In Progress";
    if (options.maxBackoffMs !== undefined) {
      config.writeback.maxBackoffMs = options.maxBackoffMs;
    }
    config.reviewLoop.reviewStates = ["In Review"];
    if (options.publisher) {
      config.github.publishPullRequests = true;
      config.github.owner = "acme";
      config.github.repo = "symphony";
      config.github.token = "github-token";
    }
    if (options.requirePublicationApproval) {
      config.github.operatorApproval!.requiredForPublication = true;
      config.github.publishPullRequests = true;
      config.reviewLoop.blockedStates = ["Blocked"];
    }
    const lifecycleStore = new FileIssueLifecycleStore(root);
    const runStore = new FileRunTranscriptStore(root);
    const outbox = new FileWritebackOutboxStore(root);
    const stateWriter = new StateChangingWriter();
    const writer = options.writer ?? stateWriter;
    const writebackProcessor = new WritebackProcessor(
      outbox,
      writer,
      new StructuredLogger(() => undefined),
      config.writeback.maxBackoffMs,
    );
    const service = new CompletionReportService({
      config,
      lifecycleStore,
      writebackOutbox: outbox,
      ...(options.requirePublicationApproval ? { writebackProcessor } : {}),
      runStore,
      ...(options.publisher === undefined ? {} : { pullRequestPublisher: options.publisher }),
      ...(options.operatorApproval === undefined ? {} : { operatorApproval: options.operatorApproval }),
    });
    return { service, lifecycleStore, outbox, runStore, writer: stateWriter, config };
  }
});

function report(overrides: Partial<CompletionReportInput> = {}): CompletionReportInput {
  return {
    runId: "run-1",
    issueId: "issue-1",
    summary: "Implemented the service contract.",
    validationEvidence: ["npm run typecheck", "npm test"],
    acceptanceChecklist: [
      {
        text: "Completion reports are persisted.",
        satisfied: true,
        evidence: "Lifecycle store records completionReports.",
      },
    ],
    changedFiles: ["src/core/CompletionReportService.ts"],
    branchName: "symphony/TEST-1",
    pullRequest: null,
    risks: ["Reviewer handler remains out of scope."],
    idempotencyKey: "idem-1",
    ...overrides,
  };
}

function pendingReportRecord() {
  return {
    id: "completion-report:issue-1:idem-1",
    idempotencyKey: "idem-1",
    runId: "run-1",
    issueId: "issue-1",
    issueIdentifier: "TEST-1",
    summary: "Implemented the service contract.",
    validationEvidence: ["npm run typecheck", "npm test"],
    acceptanceChecklist: [
      {
        text: "Completion reports are persisted.",
        satisfied: true,
        evidence: "Lifecycle store records completionReports.",
      },
    ],
    changedFiles: ["src/core/CompletionReportService.ts"],
    branchName: "symphony/TEST-1",
    pullRequest: null,
    risks: ["Reviewer handler remains out of scope."],
    acceptedAt: "2026-01-01T00:00:00.000Z",
    writebackOperationKeys: [],
  };
}

function approvalRecord(status: OperatorApprovalStatus): OperatorApprovalRecord {
  return {
    requestId: "approval-1",
    status,
    issueId: "issue-1",
    issueIdentifier: "TEST-1",
    runId: "run-1",
    evidenceCursor: "idem-1",
    dedupeKey: "run-1:idem-1:push_and_pr",
    action: {
      kind: "push_and_pr",
      branchName: "symphony/TEST-1",
      baseBranch: "main",
      workspacePath: "/tmp/workspace",
      title: "TEST-1: Do work",
      evidenceCursor: "idem-1",
      summaryPreview: "Implemented the service contract.",
      changedFiles: ["src/core/CompletionReportService.ts"],
      plannedOperations: ["commit_if_needed", "git_push", "pull_request_create_or_reuse"],
    },
    requestedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    resolvedAt: status === "pending" ? null : "2026-01-01T00:00:01.000Z",
    resolvedBy: status === "pending" ? null : "operator",
    decision: status === "approved" ? "approve" : status === "rejected" ? "reject" : null,
    staleReason: status === "cancelled" ? "operator cancelled publication" : null,
  };
}

function context(overrides: Partial<CompletionReportActiveContext> = {}): CompletionReportActiveContext {
  return {
    issue: issue({ state: "In Progress", branchName: "symphony/TEST-1" }),
    activeRunId: "run-1",
    role: "worker",
    token: "worker-token",
    expectedToken: "worker-token",
    sessionId: "session-1",
    workspacePath: "/tmp/workspace",
    phase: "implementation",
    ...overrides,
  };
}

function contextWithWorkspace(overrides: Partial<CompletionReportActiveContext> = {}): CompletionReportActiveContext {
  return context({
    workspace: {
      path: "/tmp/workspace",
      workspaceKey: "TEST-1",
      createdNow: false,
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      gitBranchName: "symphony/TEST-1",
      repoPath: "/repo",
      baseRef: "main",
    },
    ...overrides,
  });
}

async function startRun(runStore: FileRunTranscriptStore): Promise<void> {
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
    gitBranchName: "symphony/TEST-1",
    repoPath: "/repo",
    baseRef: "main",
  });
}

class FailingOutbox {
  attempted = 0;

  async enqueueOnce(_operation: NewWritebackOperation): Promise<WritebackOperation> {
    this.attempted += 1;
    throw new Error("enqueue failed");
  }

  async get(_idempotencyKey: string): Promise<WritebackOperation | null> {
    return null;
  }
}

class FakePublisher implements CompletionReportPullRequestPublisher {
  readonly inputs: CompletionReportPullRequestPublicationInput[] = [];

  constructor(
    private readonly publication: CompletionReportPullRequestPublication | null,
    private readonly failure: Error | null = null,
  ) {}

  async publishPullRequest(
    input: CompletionReportPullRequestPublicationInput,
  ): Promise<CompletionReportPullRequestPublication> {
    this.inputs.push(input);
    if (this.failure) throw this.failure;
    if (!this.publication) throw new Error("missing fake publication");
    return this.publication;
  }
}

class DeferredOperatorApproval {
  readonly requests: OperatorApprovalRequestInput[] = [];
  readonly records: OperatorApprovalRecord[] = [];
  onRequest: ((input: OperatorApprovalRequestInput) => Promise<void> | void) | null = null;
  private readonly requestSeen: Promise<void>;
  private readonly waitSeen: Promise<void>;
  private markRequestSeen: (() => void) | null = null;
  private markWaitSeen: (() => void) | null = null;
  private resolveApproval: ((record: OperatorApprovalRecord) => void) | null = null;
  private rejectApproval: ((error: Error) => void) | null = null;

  constructor() {
    this.requestSeen = new Promise((resolve) => {
      this.markRequestSeen = resolve;
    });
    this.waitSeen = new Promise((resolve) => {
      this.markWaitSeen = resolve;
    });
  }

  async requestPublicationApproval(input: OperatorApprovalRequestInput): Promise<OperatorApprovalRecord> {
    await this.onRequest?.(input);
    this.requests.push(input);
    const record = approvalRecord("pending");
    this.records.push(record);
    this.markRequestSeen?.();
    return record;
  }

  waitForPublicationApprovalRequest(_record: OperatorApprovalRecord): Promise<OperatorApprovalRecord> {
    this.markWaitSeen?.();
    return new Promise((resolve, reject) => {
      this.resolveApproval = resolve;
      this.rejectApproval = reject;
    });
  }

  async get(requestId: string): Promise<OperatorApprovalRecord | null> {
    return this.records.find((record) => record.requestId === requestId) ?? null;
  }

  async getByDedupe(runId: string, evidenceCursor: string): Promise<OperatorApprovalRecord | null> {
    return this.records.find((record) => record.runId === runId && record.evidenceCursor === evidenceCursor) ?? null;
  }

  async waitForRequest(): Promise<OperatorApprovalRequestInput> {
    await this.requestSeen;
    const request = this.requests[0];
    if (!request) throw new Error("approval request was not captured");
    return request;
  }

  async waitForWaiter(): Promise<void> {
    await this.waitSeen;
  }

  approve(): void {
    const request = this.requests[0];
    if (!request || !this.resolveApproval) throw new Error("approval request is not pending");
    this.resolveApproval(approvalRecord("approved"));
  }

  terminal(status: "rejected" | "cancelled" | "stale" | "expired"): void {
    if (!this.requests[0] || !this.rejectApproval) throw new Error("approval request is not pending");
    this.rejectApproval(new SymphonyError("invalid_request", `Approval request is ${status}`, approvalRecord(status)));
  }
}

class StateChangingWriter implements TrackerWriter {
  readonly transitions: TrackerTransitionInput[] = [];
  readonly comments: TrackerCommentInput[] = [];

  async transitionIssueState(input: TrackerTransitionInput): Promise<TrackerWriteResult> {
    this.transitions.push(input);
    return { status: "applied" };
  }

  async createIssueComment(input: TrackerCommentInput): Promise<TrackerWriteResult> {
    this.comments.push(input);
    return { status: "applied" };
  }
}

class FailingWriter implements TrackerWriter {
  async transitionIssueState(_input: TrackerTransitionInput): Promise<TrackerWriteResult> {
    throw new Error("linear transition failed");
  }

  async createIssueComment(_input: TrackerCommentInput): Promise<TrackerWriteResult> {
    throw new Error("linear comment failed");
  }
}

class CommentFailingWriter extends StateChangingWriter {
  override async createIssueComment(_input: TrackerCommentInput): Promise<TrackerWriteResult> {
    throw new Error("linear comment failed");
  }
}

class TransitionFailingWriter extends StateChangingWriter {
  override async transitionIssueState(_input: TrackerTransitionInput): Promise<TrackerWriteResult> {
    throw new Error("linear transition failed");
  }
}

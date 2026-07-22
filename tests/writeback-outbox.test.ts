import { promises as nodeFs } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceConfig } from "../src/core/config/Config.js";
import {
  planIssueBreakdownApplicationWritebacks,
  planIssueBreakdownFinalizationWritebacks,
} from "../src/core/IssueBreakdownPlanApplyService.js";
import {
  issueBreakdownConfigFingerprint,
  issueContentFingerprint,
  IssueBreakdownPlanService,
} from "../src/core/IssueBreakdownPlanService.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import {
  FileIssueLifecycleStore,
  type IssueBreakdownCreatedIssueRef,
  type IssueBreakdownPlanRecord,
  type IssueLifecycleRecord,
} from "../src/core/persistence/IssueLifecycleStore.js";
import type {
  TrackerCommentInput,
  TrackerIssueCreateInput,
  TrackerIssueRelationInput,
  TrackerTransitionInput,
  TrackerWriteResult,
  TrackerWriter,
} from "../src/core/tracker/TrackerWriter.js";
import type { Issue } from "../src/core/types.js";
import type { IssueBreakdownFreshnessGuard } from "../src/core/writeback/WritebackOutbox.js";
import {
  ACCEPTED_ARTIFACT_WRITEBACK_NOT_CURRENT_REASON,
  FileWritebackOutboxStore,
  ISSUE_BREAKDOWN_FINALIZATION_PENDING_REASON,
  ISSUE_BREAKDOWN_PLAN_STALE_REASON,
  SqliteWritebackOutboxStore,
  WRITEBACK_IN_FLIGHT_LEASE_MS,
  WritebackProcessor,
} from "../src/core/writeback/WritebackOutbox.js";
import type { NewWritebackOperation } from "../src/core/writeback/WritebackOutbox.js";
import { agentEligibleIssueContract, issue, testConfig } from "./helpers.js";

type IssueCreateWriteback = Extract<NewWritebackOperation, { kind: "issue_create" }>;
type IssueRelationWriteback = Extract<NewWritebackOperation, { kind: "issue_relation" }>;
type CommentWriteback = Extract<NewWritebackOperation, { kind: "comment" }>;

describe("FileWritebackOutboxStore", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-writeback-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("enqueues idempotently and processes due operations", async () => {
    const store = new FileWritebackOutboxStore(root);
    const writer = new FakeWriter();
    const processor = new WritebackProcessor(store, writer, new StructuredLogger(() => undefined), 300_000);

    await processor.enqueueAndProcess({
      idempotencyKey: "transition:issue-1:dispatch",
      kind: "transition",
      issueId: "issue-1",
      payload: { fromStates: ["Todo"], toState: "In Progress" },
    });
    await processor.enqueueAndProcess({
      idempotencyKey: "transition:issue-1:dispatch",
      kind: "transition",
      issueId: "issue-1",
      payload: { fromStates: ["Todo"], toState: "In Progress" },
    });

    const records = await store.list();
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe("succeeded");
    expect(writer.transitions).toHaveLength(1);
  });

  it("retries the exact registered operation without regenerating its intent", async () => {
    const store = new FileWritebackOutboxStore(root);
    const writerOptions: { transitionStatus?: TrackerWriteResult["status"] } = {
      transitionStatus: "skipped",
    };
    const writer = new FakeWriter(writerOptions);
    const processor = new WritebackProcessor(
      store,
      writer,
      new StructuredLogger(() => undefined),
      300_000,
    );
    const operation: NewWritebackOperation = {
      idempotencyKey: "transition:issue-1:registered-retry",
      kind: "transition",
      issueId: "issue-1",
      payload: {
        fromStates: ["Ready to Merge"],
        toState: "In Progress",
        reason: "Persisted immutable intent",
      },
    };

    await expect(processor.enqueueAndProcess(operation)).resolves.toMatchObject({
      status: "skipped",
    });
    writerOptions.transitionStatus = "applied";

    await expect(
      processor.retryRegistered([operation.idempotencyKey], {
        retrySkipped: true,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        idempotencyKey: operation.idempotencyKey,
        status: "succeeded",
        payload: operation.payload,
      }),
    ]);
    expect(writer.transitions).toEqual([
      { issueId: operation.issueId, ...operation.payload },
      { issueId: operation.issueId, ...operation.payload },
    ]);
    await expect(
      processor.retryRegistered(["transition:issue-1:missing"], {
        retrySkipped: true,
      }),
    ).rejects.toThrow(/Registered writeback does not exist/);
  });

  it("rejects reuse of an idempotency key with different writeback intent", async () => {
    const store = new FileWritebackOutboxStore(root);
    await store.enqueueOnce({
      idempotencyKey: "comment:issue-1:final-disposition",
      kind: "comment",
      issueId: "issue-1",
      payload: { body: "Original full disposition", dedupeKey: "disposition" },
    });

    await expect(
      store.enqueueOnce({
        idempotencyKey: "comment:issue-1:final-disposition",
        kind: "comment",
        issueId: "issue-1",
        payload: { body: "Different disposition", dedupeKey: "disposition" },
      }),
    ).rejects.toThrow(/different intent/);
  });

  it("waits for the exact lifecycle owner before executing a bound writeback", async () => {
    const store = new FileWritebackOutboxStore(root);
    const writer = new FakeWriter();
    let lifecycle: IssueLifecycleRecord | null = null;
    const processor = new WritebackProcessor(
      store,
      writer,
      new StructuredLogger(() => undefined),
      0,
      { get: async () => lifecycle },
    );
    const operation: NewWritebackOperation = {
      idempotencyKey: "comment:issue-1:completion-report:report-1",
      kind: "comment",
      issueId: "issue-1",
      lifecycleBinding: { kind: "completion_report", recordId: "report-1" },
      payload: { body: "Full disposition", dedupeKey: "report-1" },
    };

    await expect(processor.enqueueAndProcess(operation)).resolves.toMatchObject({
      status: "retrying",
    });
    expect(writer.comments).toHaveLength(0);

    lifecycle = {
      completionReports: [
        { id: "report-1", writebackOperationKeys: [operation.idempotencyKey] },
      ],
    } as unknown as IssueLifecycleRecord;
    await processor.processDue();

    await expect(store.get(operation.idempotencyKey)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(writer.comments).toHaveLength(1);
  });

  it("terminally skips a retrying review-verdict comment after its owner is superseded", async () => {
    const store = new FileWritebackOutboxStore(root);
    const writer = new FakeWriter();
    const operation: NewWritebackOperation = {
      idempotencyKey: "comment:issue-1:review-verdict:verdict-1",
      kind: "comment",
      issueId: "issue-1",
      lifecycleBinding: { kind: "review_verdict", recordId: "verdict-1" },
      payload: { body: "Stale failed review", dedupeKey: "verdict-1" },
    };
    let lifecycle = {
      lastReviewVerdictId: "verdict-1",
      reviewVerdicts: [
        {
          id: "verdict-1",
          writebackOperationKeys: [operation.idempotencyKey],
          supersededAt: null,
        },
      ],
    } as unknown as IssueLifecycleRecord;
    const processor = new WritebackProcessor(
      store,
      writer,
      new StructuredLogger(() => undefined),
      0,
      { get: async () => lifecycle },
    );
    await store.markRetry(
      await store.enqueueOnce(operation),
      "transient tracker failure",
      new Date().toISOString(),
    );

    lifecycle = {
      ...lifecycle,
      lastReviewVerdictId: "verdict-2",
      reviewVerdicts: [
        {
          id: "verdict-1",
          writebackOperationKeys: [operation.idempotencyKey],
          supersededAt: "2026-01-01T00:00:01.000Z",
        },
        {
          id: "verdict-2",
          writebackOperationKeys: [],
          supersededAt: null,
        },
      ],
    } as unknown as IssueLifecycleRecord;
    await processor.processDue();

    await expect(store.get(operation.idempotencyKey)).resolves.toMatchObject({
      status: "skipped",
      lastError: "review-verdict writeback owner has been superseded",
    });
    expect(writer.comments).toHaveLength(0);
  });

  it("delivers a delayed historical review-verdict comment after a newer verdict becomes current", async () => {
    const store = new FileWritebackOutboxStore(root);
    const writer = new FakeWriter();
    const operation: NewWritebackOperation = {
      idempotencyKey: "comment:issue-1:review-verdict:verdict-1:not-current",
      kind: "comment",
      issueId: "issue-1",
      lifecycleBinding: { kind: "review_verdict", recordId: "verdict-1" },
      payload: { body: "Old review", dedupeKey: "verdict-1:not-current" },
    };
    let lifecycle = {
      lastReviewVerdictId: "verdict-1",
      reviewVerdicts: [
        {
          id: "verdict-1",
          writebackOperationKeys: [operation.idempotencyKey],
          supersededAt: null,
        },
      ],
    } as unknown as IssueLifecycleRecord;
    const processor = new WritebackProcessor(
      store,
      writer,
      new StructuredLogger(() => undefined),
      0,
      { get: async () => lifecycle },
    );
    await store.markRetry(
      await store.enqueueOnce(operation),
      "transient tracker failure",
      new Date().toISOString(),
    );

    lifecycle = {
      ...lifecycle,
      lastReviewVerdictId: "verdict-2",
      reviewVerdicts: [
        ...lifecycle.reviewVerdicts,
        {
          id: "verdict-2",
          writebackOperationKeys: [],
          supersededAt: null,
        },
      ],
    } as unknown as IssueLifecycleRecord;
    await processor.processDue();

    await expect(store.get(operation.idempotencyKey)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(writer.comments).toEqual([
      expect.objectContaining({ body: "Old review", dedupeKey: "verdict-1:not-current" }),
    ]);
  });

  it("terminally skips a retrying bound report comment after its owner is superseded", async () => {
    const store = new FileWritebackOutboxStore(root);
    const writer = new FakeWriter();
    const operation: NewWritebackOperation = {
      idempotencyKey: "comment:issue-1:triage:report-1",
      kind: "comment",
      issueId: "issue-1",
      lifecycleBinding: { kind: "issue_triage_report", recordId: "report-1" },
      payload: { body: "Stale triage", dedupeKey: "report-1" },
    };
    const lifecycle = {
      issueTriageReports: [
        {
          id: "report-1",
          writebackOperationKeys: [operation.idempotencyKey],
          supersededAt: "2026-01-01T00:00:01.000Z",
        },
      ],
    } as unknown as IssueLifecycleRecord;
    const processor = new WritebackProcessor(
      store,
      writer,
      new StructuredLogger(() => undefined),
      0,
      { get: async () => lifecycle },
    );
    await store.markRetry(
      await store.enqueueOnce(operation),
      "transient tracker failure",
      new Date().toISOString(),
    );

    await processor.processDue();

    await expect(store.get(operation.idempotencyKey)).resolves.toMatchObject({
      status: "skipped",
      lastError: "issue-triage-report writeback owner has been superseded",
    });
    expect(writer.comments).toHaveLength(0);
  });

  it("waits for the full triage report comment before executing its recovery transition", async () => {
    const store = new FileWritebackOutboxStore(root);
    const writer = new FakeWriter();
    const commentKey = "comment:issue-1:triage:report-1";
    const transitionKey = "transition:issue-1:triage:report-1:In Progress";
    const lifecycle = {
      issueTriageReports: [
        {
          id: "report-1",
          writebackOperationKeys: [commentKey, transitionKey],
          supersededAt: null,
        },
      ],
    } as unknown as IssueLifecycleRecord;
    const processor = new WritebackProcessor(
      store,
      writer,
      new StructuredLogger(() => undefined),
      0,
      { get: async () => lifecycle },
    );
    await store.enqueueOnce({
      idempotencyKey: commentKey,
      kind: "comment",
      issueId: "issue-1",
      lifecycleBinding: { kind: "issue_triage_report", recordId: "report-1" },
      payload: { body: "Full triage disposition", dedupeKey: "report-1" },
    });
    await store.enqueueOnce({
      idempotencyKey: transitionKey,
      kind: "transition",
      issueId: "issue-1",
      lifecycleBinding: { kind: "issue_triage_report", recordId: "report-1" },
      payload: { fromStates: ["In Review"], toState: "In Progress" },
    });

    await processor.processDue({ idempotencyKeys: [transitionKey] });

    await expect(store.get(transitionKey)).resolves.toMatchObject({
      status: "retrying",
      lastError: expect.stringContaining("waiting for report writeback"),
    });
    expect(writer.transitions).toHaveLength(0);

    const comment = await store.get(commentKey);
    if (!comment) throw new Error("missing triage report comment fixture");
    await store.markSucceeded(comment, { status: "applied" });
    await makeWritebackDue(store, transitionKey);
    await processor.processDue({ idempotencyKeys: [transitionKey] });

    await expect(store.get(transitionKey)).resolves.toMatchObject({ status: "succeeded" });
    expect(writer.transitions).toHaveLength(1);
  });

  it("waits for the full review verdict comment before executing its bound transition", async () => {
    const store = new FileWritebackOutboxStore(root);
    const writer = new FakeWriter();
    const commentKey = "comment:issue-1:review-verdict:verdict-1";
    const transitionKey = "transition:issue-1:review-verdict:verdict-1:Ready to Merge";
    const lifecycle = {
      lastReviewVerdictId: "verdict-1",
      reviewVerdicts: [
        {
          id: "verdict-1",
          writebackOperationKeys: [commentKey, transitionKey],
          supersededAt: null,
        },
      ],
    } as unknown as IssueLifecycleRecord;
    const processor = new WritebackProcessor(
      store,
      writer,
      new StructuredLogger(() => undefined),
      0,
      { get: async () => lifecycle },
    );
    await store.enqueueOnce({
      idempotencyKey: commentKey,
      kind: "comment",
      issueId: "issue-1",
      lifecycleBinding: { kind: "review_verdict", recordId: "verdict-1" },
      payload: { body: "Full review disposition", dedupeKey: "verdict-1" },
    });
    await store.enqueueOnce({
      idempotencyKey: transitionKey,
      kind: "transition",
      issueId: "issue-1",
      lifecycleBinding: { kind: "review_verdict", recordId: "verdict-1" },
      payload: { fromStates: ["In Review"], toState: "Ready to Merge" },
    });

    await processor.processDue({ idempotencyKeys: [transitionKey] });

    await expect(store.get(transitionKey)).resolves.toMatchObject({
      status: "retrying",
      lastError: expect.stringContaining("waiting for report writeback"),
    });
    expect(writer.transitions).toHaveLength(0);

    const comment = await store.get(commentKey);
    if (!comment) throw new Error("missing review verdict comment fixture");
    await store.markSucceeded(comment, { status: "applied" });
    await makeWritebackDue(store, transitionKey);
    await processor.processDue({ idempotencyKeys: [transitionKey] });

    await expect(store.get(transitionKey)).resolves.toMatchObject({ status: "succeeded" });
    expect(writer.transitions).toHaveLength(1);
  });

  it("waits for the full completion report comment before executing its bound transition", async () => {
    const store = new FileWritebackOutboxStore(root);
    const writer = new FakeWriter();
    const commentKey = "comment:issue-1:completion-report:report-1";
    const transitionKey = "transition:issue-1:completion-report:report-1:In Review";
    const lifecycle = {
      completionReports: [
        {
          id: "report-1",
          writebackOperationKeys: [commentKey, transitionKey],
          supersededAt: null,
        },
      ],
    } as unknown as IssueLifecycleRecord;
    const processor = new WritebackProcessor(
      store,
      writer,
      new StructuredLogger(() => undefined),
      0,
      { get: async () => lifecycle },
    );
    await store.enqueueOnce({
      idempotencyKey: commentKey,
      kind: "comment",
      issueId: "issue-1",
      lifecycleBinding: { kind: "completion_report", recordId: "report-1" },
      payload: { body: "Full completion disposition", dedupeKey: "report-1" },
    });
    await store.enqueueOnce({
      idempotencyKey: transitionKey,
      kind: "transition",
      issueId: "issue-1",
      lifecycleBinding: { kind: "completion_report", recordId: "report-1" },
      payload: { fromStates: ["In Progress"], toState: "In Review" },
    });

    await processor.processDue({ idempotencyKeys: [transitionKey] });

    await expect(store.get(transitionKey)).resolves.toMatchObject({
      status: "retrying",
      lastError: expect.stringContaining("waiting for report writeback"),
    });
    expect(writer.transitions).toHaveLength(0);

    const comment = await store.get(commentKey);
    if (!comment) throw new Error("missing completion report comment fixture");
    await store.markSucceeded(comment, { status: "applied" });
    await makeWritebackDue(store, transitionKey);
    await processor.processDue({ idempotencyKeys: [transitionKey] });

    await expect(store.get(transitionKey)).resolves.toMatchObject({ status: "succeeded" });
    expect(writer.transitions).toHaveLength(1);
  });

  it("executes only writebacks registered on the current completed accepted artifact", async () => {
    const store = new FileWritebackOutboxStore(root);
    const writer = new FakeWriter();
    const artifact = {
      id: "accepted-artifact-current",
      status: "completed_unmerged",
      commentOperationKey: "comment:issue-1:artifact-current",
      doneTransitionOperationKey: "transition:issue-1:artifact-current:Done",
    };
    const processor = new WritebackProcessor(
      store,
      writer,
      new StructuredLogger(() => undefined),
      300_000,
      { get: async () => ({ acceptedArtifact: artifact }) as unknown as IssueLifecycleRecord },
    );

    const stale = await processor.enqueueAndProcess({
      idempotencyKey: "transition:issue-1:artifact-stale:Done",
      kind: "transition",
      issueId: "issue-1",
      payload: {
        acceptedArtifactId: "accepted-artifact-stale",
        fromStates: ["In Review"],
        toState: "Done",
      },
    });
    const current = await processor.enqueueAndProcess({
      idempotencyKey: artifact.doneTransitionOperationKey,
      kind: "transition",
      issueId: "issue-1",
      payload: {
        acceptedArtifactId: artifact.id,
        fromStates: ["In Review"],
        toState: "Done",
      },
    });

    expect(stale).toMatchObject({ status: "skipped", lastError: ACCEPTED_ARTIFACT_WRITEBACK_NOT_CURRENT_REASON });
    expect(current.status).toBe("succeeded");
    expect(writer.transitions).toHaveLength(1);

    const supersededStore = new FileWritebackOutboxStore(
      path.join(root, "superseded-artifact"),
    );
    const supersededProcessor = new WritebackProcessor(
      supersededStore,
      writer,
      new StructuredLogger(() => undefined),
      300_000,
      {
        get: async () =>
          ({
            acceptedArtifact: {
              ...artifact,
              supersededAt: "2026-07-14T00:00:00.000Z",
              supersededBy: "fresh-review",
              supersededReason: "head drift",
            },
          }) as unknown as IssueLifecycleRecord,
      },
    );
    const superseded = await supersededProcessor.enqueueAndProcess(
      {
        idempotencyKey: artifact.doneTransitionOperationKey,
        kind: "transition",
        issueId: "issue-1",
        payload: {
          acceptedArtifactId: artifact.id,
          fromStates: ["In Review"],
          toState: "Done",
        },
      },
      { retrySkipped: true },
    );
    expect(superseded).toMatchObject({
      status: "skipped",
      lastError: ACCEPTED_ARTIFACT_WRITEBACK_NOT_CURRENT_REASON,
    });
    expect(writer.transitions).toHaveLength(1);

    const racingStore = new FileWritebackOutboxStore(
      path.join(root, "racing-artifact"),
    );
    const racingWriter = new FakeWriter();
    let lifecycleReads = 0;
    const racingProcessor = new WritebackProcessor(
      racingStore,
      racingWriter,
      new StructuredLogger(() => undefined),
      300_000,
      {
        get: async () => {
          lifecycleReads += 1;
          return {
            acceptedArtifact:
              lifecycleReads === 1
                ? artifact
                : {
                    ...artifact,
                    supersededAt: "2026-07-14T00:01:00.000Z",
                    supersededBy: "source_reopened",
                    supersededReason: "Source reopened before transition execution",
                  },
          } as unknown as IssueLifecycleRecord;
        },
      },
    );
    const raced = await racingProcessor.enqueueAndProcess({
      idempotencyKey: artifact.doneTransitionOperationKey,
      kind: "transition",
      issueId: "issue-1",
      payload: {
        acceptedArtifactId: artifact.id,
        fromStates: ["In Review"],
        toState: "Done",
      },
    });

    expect(raced).toMatchObject({
      status: "skipped",
      lastError: ACCEPTED_ARTIFACT_WRITEBACK_NOT_CURRENT_REASON,
    });
    expect(lifecycleReads).toBe(2);
    expect(racingWriter.transitions).toHaveLength(0);
  });


  it("tracks projection revisions for successful outbox writes only", async () => {
    const store = new FileWritebackOutboxStore(root);
    const events: Array<{ source: string; revision: number }> = [];
    store.onProjectionChanged(() => {
      throw new Error("listener failure must not affect durable writes");
    });
    const unsubscribe = store.onProjectionChanged((event) => events.push(event));
    const operation: NewWritebackOperation = {
      idempotencyKey: "transition:issue-1:dispatch",
      kind: "transition",
      issueId: "issue-1",
      payload: { fromStates: ["Todo"], toState: "In Progress" },
    };

    expect(store.projectionRevision()).toBe(0);
    await expect(store.get("missing")).resolves.toBeNull();
    await expect(store.list()).resolves.toEqual([]);
    await expect(store.claimDue(new Date("9999-01-01T00:00:00.000Z"))).resolves.toEqual([]);
    expect(store.projectionRevision()).toBe(0);
    expect(events).toEqual([]);

    const enqueued = await store.enqueueOnce(operation);
    await store.enqueueOnce(operation);
    await expect(store.get(operation.idempotencyKey)).resolves.toMatchObject({ status: "pending" });
    await expect(store.list()).resolves.toHaveLength(1);
    expect(store.projectionRevision()).toBe(1);
    expect(events).toEqual([{ source: "writeback", revision: 1 }]);

    const [claimed] = await store.claimDue(new Date("9999-01-01T00:00:00.000Z"));
    expect(claimed).toMatchObject({ idempotencyKey: enqueued.idempotencyKey, status: "in_flight" });
    const succeeded = await store.markSucceeded(claimed!);

    const skippedBase = await store.enqueueOnce({
      idempotencyKey: "comment:issue-1:skip",
      kind: "comment",
      issueId: "issue-1",
      payload: { body: "skip", dedupeKey: "skip" },
    });
    const skipped = await store.markSkipped(skippedBase, "skip reason");
    const pending = await store.requeueSkipped(skipped);
    const retrying = await store.markRetry(pending, "retry reason", "9999-01-01T00:00:00.000Z");
    const dead = await store.markDeadLetter(retrying, "dead reason");
    await expect(store.requeueSkipped(dead)).resolves.toBe(dead);

    expect(succeeded.status).toBe("succeeded");
    expect(store.projectionRevision()).toBe(8);
    expect(events).toEqual(Array.from({ length: 8 }, (_, index) => ({ source: "writeback", revision: index + 1 })));

    unsubscribe();
    await store.enqueueOnce({
      idempotencyKey: "comment:issue-1:after-unsubscribe",
      kind: "comment",
      issueId: "issue-1",
      payload: { body: "after unsubscribe", dedupeKey: "after-unsubscribe" },
    });
    expect(store.projectionRevision()).toBe(9);
    expect(events).toHaveLength(8);
  });

  it("does not advance projection revisions when outbox writes fail", async () => {
    const store = new FileWritebackOutboxStore(root);
    const events: Array<{ source: string; revision: number }> = [];
    store.onProjectionChanged((event) => events.push(event));
    vi.spyOn(nodeFs, "writeFile").mockRejectedValueOnce(new Error("outbox disk full"));

    await expect(
      store.enqueueOnce({
        idempotencyKey: "comment:issue-1:fail",
        kind: "comment",
        issueId: "issue-1",
        payload: { body: "fail", dedupeKey: "fail" },
      }),
    ).rejects.toThrow("outbox disk full");
    expect(store.projectionRevision()).toBe(0);
    expect(events).toEqual([]);
  });

  it("uses collision-resistant temp files for concurrent record updates", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_779_817_298_603);
    const store = new FileWritebackOutboxStore(root);
    const record = await store.enqueueOnce({
      idempotencyKey: "comment:issue-1:report-run-1:completion-report:idem-1:publication-approval-rejected",
      kind: "comment",
      issueId: "issue-1",
      payload: {
        body: "Publication approval was rejected.",
        dedupeKey: "report-run-1:publication-approval-rejected",
      },
    });

    await Promise.all([
      store.markRetry(record, "retryable", new Date().toISOString()),
      store.markDeadLetter(record, "terminal"),
    ]);

    const persisted = await store.get(record.idempotencyKey);
    expect(persisted?.status).toMatch(/retrying|dead_letter/);
  });

  it("stores long idempotency keys under short deterministic filenames", async () => {
    const store = new FileWritebackOutboxStore(root);
    const longKey = [
      "comment",
      "issue-long",
      "merge-gate",
      "merge-gate_issue-long_pr-75_31e279aac50f866d209abbd451de787b508dd681",
      "repair",
      "31e279aac50f866d209abbd451de787b508dd681",
      "Typecheck_and_test_missing",
      "mergeability_dirty_Pull_request_has_merge_conflicts_with_the_base_branch",
      "r1",
      "extra".repeat(80),
    ].join(":");

    await store.enqueueOnce({
      idempotencyKey: longKey,
      kind: "comment",
      issueId: "issue-long",
      payload: { body: "Merge repair required.", dedupeKey: "merge-gate-repair" },
    });

    await expect(store.get(longKey)).resolves.toMatchObject({ idempotencyKey: longKey });
    const files = await readdir(path.join(root, "writeback"));
    expect(files).toHaveLength(1);
    expect(files[0]?.length).toBeLessThan(100);
    expect(files[0]).toMatch(/^wb_comment_issue-long_[a-f0-9]{20}\.json$/);
  });

  it("ignores oversized legacy cleanup paths after writing a short filename", async () => {
    const store = new FileWritebackOutboxStore(root);
    const realRm = nodeFs.rm.bind(nodeFs);
    vi.spyOn(nodeFs, "rm").mockImplementation(async (...args: Parameters<typeof nodeFs.rm>) => {
      const target = String(args[0]);
      if (path.basename(target).length > 255) {
        const error = new Error("name too long") as NodeJS.ErrnoException;
        error.code = "ENAMETOOLONG";
        throw error;
      }
      await realRm(...args);
    });
    const longKey = [
      "comment",
      "issue-long",
      "merge-gate",
      "merge-gate_issue-long_pr-75_31e279aac50f866d209abbd451de787b508dd681",
      "repair",
      "extra".repeat(80),
    ].join(":");

    await expect(
      store.enqueueOnce({
        idempotencyKey: longKey,
        kind: "comment",
        issueId: "issue-long",
        payload: { body: "Merge repair required.", dedupeKey: "merge-gate-repair" },
      }),
    ).resolves.toMatchObject({ idempotencyKey: longKey });

    await expect(store.get(longKey)).resolves.toMatchObject({ idempotencyKey: longKey });
  });

  it("reads legacy full-key filenames and migrates them on write", async () => {
    const store = new FileWritebackOutboxStore(root);
    const idempotencyKey = "comment:issue-legacy:merge-gate:legacy-repair";
    const legacyFileName = `${idempotencyKey.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
    const writebackDir = path.join(root, "writeback");
    await mkdir(writebackDir, { recursive: true });
    await writeFile(
      path.join(writebackDir, legacyFileName),
      `${JSON.stringify(
        {
          idempotencyKey,
          kind: "comment",
          issueId: "issue-legacy",
          status: "pending",
          attempt: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          nextAttemptAt: "2026-01-01T00:00:00.000Z",
          lastError: null,
          resultStatus: null,
          resultMessage: null,
          resultEvidence: null,
          payload: { body: "Legacy record.", dedupeKey: "legacy" },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const legacyRecord = await store.get(idempotencyKey);
    expect(legacyRecord).toMatchObject({ idempotencyKey, status: "pending" });
    await store.markSucceeded(legacyRecord!);

    const files = await readdir(writebackDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^wb_comment_issue-legacy_[a-f0-9]{20}\.json$/);
    expect(files).not.toContain(legacyFileName);
    await expect(store.get(idempotencyKey)).resolves.toMatchObject({ status: "succeeded" });
  });

  it("claims the same due record only once across concurrent processors", async () => {
    const store = new FileWritebackOutboxStore(root);
    const writer = new FakeWriter({ commentDelayMs: 20 });
    const processor = new WritebackProcessor(store, writer, new StructuredLogger(() => undefined), 300_000);
    const operation = {
      idempotencyKey: "comment:issue-1:publication-approval-rejected",
      kind: "comment" as const,
      issueId: "issue-1",
      payload: {
        body: "Status: rejected",
        dedupeKey: "publication-approval-rejected",
      },
    };
    await store.enqueueOnce(operation);

    await Promise.all([
      processor.processDue({ idempotencyKeys: [operation.idempotencyKey] }),
      processor.processDue({ idempotencyKeys: [operation.idempotencyKey] }),
    ]);

    expect(writer.comments).toHaveLength(1);
    await expect(store.get(operation.idempotencyKey)).resolves.toMatchObject({ status: "succeeded" });
  });

  it("marks verified writeback results as succeeded", async () => {
    const store = new FileWritebackOutboxStore(root);
    const writer = new FakeWriter({ transitionStatus: "verified" });
    const processor = new WritebackProcessor(store, writer, new StructuredLogger(() => undefined), 300_000);

    const result = await processor.enqueueAndProcess({
      idempotencyKey: "transition:issue-1:done",
      kind: "transition",
      issueId: "issue-1",
      payload: { fromStates: ["Ready to Merge"], toState: "Done" },
    });

    expect(result.status).toBe("succeeded");
  });

  it("does not mark skipped writeback results as succeeded", async () => {
    const store = new FileWritebackOutboxStore(root);
    const writer = new FakeWriter({ transitionStatus: "skipped" });
    const processor = new WritebackProcessor(store, writer, new StructuredLogger(() => undefined), 300_000);

    const result = await processor.enqueueAndProcess({
      idempotencyKey: "transition:issue-1:done",
      kind: "transition",
      issueId: "issue-1",
      payload: { fromStates: ["Ready to Merge"], toState: "Done" },
    });

    expect(result.status).toBe("skipped");
    expect(result.lastError).toBe("fake skipped");
  });

  it("does not mark dry-run writeback results as succeeded", async () => {
    const store = new FileWritebackOutboxStore(root);
    const writer = new FakeWriter({ transitionStatus: "dry_run" });
    const processor = new WritebackProcessor(store, writer, new StructuredLogger(() => undefined), 300_000);

    const result = await processor.enqueueAndProcess({
      idempotencyKey: "transition:issue-1:done",
      kind: "transition",
      issueId: "issue-1",
      payload: { fromStates: ["Ready to Merge"], toState: "Done" },
    });

    expect(result.status).toBe("skipped");
    expect(result.lastError).toBe("Writeback dry_run");
  });

  it("skips PR handoff writebacks without durable accepted report evidence", async () => {
    const store = new FileWritebackOutboxStore(root);
    const writer = new FakeWriter();
    const lifecycleStore = { get: async () => null };
    const processor = new WritebackProcessor(store, writer, new StructuredLogger(() => undefined), 300_000, lifecycleStore);

    await processor.enqueueAndProcess({
      idempotencyKey: "transition:issue-1:pull-request-handoff:pr-42:abc123:Human Review",
      kind: "transition",
      issueId: "issue-1",
      payload: { fromStates: ["In Progress"], toState: "Human Review" },
    });

    const records = await store.list();
    expect(records[0]?.status).toBe("skipped");
    expect(records[0]?.lastError).toContain("durable accepted completion report");
    expect(writer.transitions).toHaveLength(0);
  });

  it("processes PR handoff writebacks with latest accepted report evidence", async () => {
    const store = new FileWritebackOutboxStore(root);
    const writer = new FakeWriter();
    const operationKey = "transition:issue-1:pull-request-handoff:pr-42:abc123:Human Review";
    const lifecycleStore = {
      get: async () =>
        lifecycleWithReports({
          lastCompletionReportId: "report-latest",
          completionReports: [
            completionReport({
              id: "report-latest",
              writebackOperationKeys: [operationKey],
              pullRequest: { url: "https://github.test/acme/symphony/pull/42", number: 42, headSha: "abc123", branch: "eng-13" },
            }),
          ],
        }),
    };
    const processor = new WritebackProcessor(store, writer, new StructuredLogger(() => undefined), 300_000, lifecycleStore);

    await processor.enqueueAndProcess({
      idempotencyKey: operationKey,
      kind: "transition",
      issueId: "issue-1",
      payload: { fromStates: ["In Progress"], toState: "Human Review" },
    });

    const records = await store.list();
    expect(records[0]?.status).toBe("succeeded");
    expect(writer.transitions).toHaveLength(1);
  });

  it("skips PR handoff writebacks when only stale report evidence matches", async () => {
    const store = new FileWritebackOutboxStore(root);
    const writer = new FakeWriter();
    const operationKey = "transition:issue-1:pull-request-handoff:pr-42:abc123:Human Review";
    const lifecycleStore = {
      get: async () =>
        lifecycleWithReports({
          lastCompletionReportId: "report-latest",
          completionReports: [
            completionReport({
              id: "report-stale",
              writebackOperationKeys: [operationKey],
              pullRequest: { url: "https://github.test/acme/symphony/pull/42", number: 42, headSha: "abc123", branch: "eng-13" },
            }),
            completionReport({ id: "report-latest", writebackOperationKeys: [], pullRequest: null }),
          ],
        }),
    };
    const processor = new WritebackProcessor(store, writer, new StructuredLogger(() => undefined), 300_000, lifecycleStore);

    await processor.enqueueAndProcess({
      idempotencyKey: operationKey,
      kind: "transition",
      issueId: "issue-1",
      payload: { fromStates: ["In Progress"], toState: "Human Review" },
    });

    const records = await store.list();
    expect(records[0]?.status).toBe("skipped");
    expect(records[0]?.lastError).toContain("durable accepted completion report");
    expect(writer.transitions).toHaveLength(0);
  });

  it("skips PR handoff writebacks when latest report lacks PR evidence", async () => {
    const store = new FileWritebackOutboxStore(root);
    const writer = new FakeWriter();
    const operationKey = "transition:issue-1:pull-request-handoff:pr-42:abc123:Human Review";
    const lifecycleStore = {
      get: async () =>
        lifecycleWithReports({
          lastCompletionReportId: "report-latest",
          completionReports: [completionReport({ id: "report-latest", writebackOperationKeys: [operationKey], pullRequest: null })],
        }),
    };
    const processor = new WritebackProcessor(store, writer, new StructuredLogger(() => undefined), 300_000, lifecycleStore);

    await processor.enqueueAndProcess({
      idempotencyKey: operationKey,
      kind: "transition",
      issueId: "issue-1",
      payload: { fromStates: ["In Progress"], toState: "Human Review" },
    });

    const records = await store.list();
    expect(records[0]?.status).toBe("skipped");
    expect(records[0]?.lastError).toContain("durable accepted completion report");
    expect(writer.transitions).toHaveLength(0);
  });

  it("can explicitly requeue an exact skipped operation for recovery", async () => {
    const store = new FileWritebackOutboxStore(root);
    const operation = {
      idempotencyKey: "transition:issue-1:merge:issue-1:head-sha-1:Done",
      kind: "transition" as const,
      issueId: "issue-1",
      payload: { fromStates: ["Ready to Merge"], toState: "Done", reason: "Symphony reviewer-approved merge completed" },
    };
    const skippedProcessor = new WritebackProcessor(
      store,
      new FakeWriter({ transitionStatus: "skipped" }),
      new StructuredLogger(() => undefined),
      300_000,
    );

    await expect(skippedProcessor.enqueueAndProcess(operation)).resolves.toMatchObject({ status: "skipped" });

    const writer = new FakeWriter();
    const recoveryProcessor = new WritebackProcessor(store, writer, new StructuredLogger(() => undefined), 300_000);
    await expect(recoveryProcessor.enqueueAndProcess(operation, { retrySkipped: true })).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(writer.transitions).toHaveLength(1);
  });

  it("fails closed when a skipped operation is replayed with different intent", async () => {
    const store = new FileWritebackOutboxStore(root);
    const operation = {
      idempotencyKey: "transition:issue-1:merge:issue-1:head-sha-1:Done",
      kind: "transition" as const,
      issueId: "issue-1",
      payload: { fromStates: ["Ready to Merge"], toState: "Done" },
    };
    const skippedProcessor = new WritebackProcessor(
      store,
      new FakeWriter({ transitionStatus: "skipped" }),
      new StructuredLogger(() => undefined),
      300_000,
    );
    await skippedProcessor.enqueueAndProcess(operation);

    const writer = new FakeWriter();
    const recoveryProcessor = new WritebackProcessor(store, writer, new StructuredLogger(() => undefined), 300_000);
    await expect(
      recoveryProcessor.enqueueAndProcess(
        {
          ...operation,
          payload: { fromStates: ["Ready to Merge"], toState: "Finished" },
        },
        { retrySkipped: true },
      ),
    ).rejects.toThrow(/different intent/);
    expect(writer.transitions).toHaveLength(0);
  });

  it("can requeue skipped operations only when an allowed reason matches", async () => {
    const store = new FileWritebackOutboxStore(root);
    const operation = {
      idempotencyKey: "transition:issue-1:issue-breakdown-recovery",
      kind: "transition" as const,
      issueId: "issue-1",
      payload: { fromStates: ["Todo"], toState: "In Progress" },
    };
    const skipped = await store.enqueueOnce(operation);
    await store.markSkipped(skipped, ISSUE_BREAKDOWN_PLAN_STALE_REASON);

    const writer = new FakeWriter();
    const recoveryProcessor = new WritebackProcessor(store, writer, new StructuredLogger(() => undefined), 300_000);
    await expect(
      recoveryProcessor.enqueueAndProcess(operation, {
        retrySkipped: true,
        retrySkippedMessages: [ISSUE_BREAKDOWN_PLAN_STALE_REASON],
      }),
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(writer.transitions).toHaveLength(1);
  });

  it("does not requeue skipped operations when the allowed reason does not match", async () => {
    const store = new FileWritebackOutboxStore(root);
    const operation = {
      idempotencyKey: "transition:issue-1:issue-breakdown-recovery",
      kind: "transition" as const,
      issueId: "issue-1",
      payload: { fromStates: ["Todo"], toState: "In Progress" },
    };
    const skipped = await store.enqueueOnce(operation);
    await store.markSkipped(skipped, "unrelated skipped reason");

    const writer = new FakeWriter();
    const recoveryProcessor = new WritebackProcessor(store, writer, new StructuredLogger(() => undefined), 300_000);
    await expect(
      recoveryProcessor.enqueueAndProcess(operation, {
        retrySkipped: true,
        retrySkippedMessages: [ISSUE_BREAKDOWN_PLAN_STALE_REASON],
      }),
    ).resolves.toMatchObject({ status: "skipped" });
    expect(writer.transitions).toHaveLength(0);
  });

  it("fails closed when a skipped comment is replayed with a different plan binding", async () => {
    const store = new FileWritebackOutboxStore(root);
    const operation = {
      idempotencyKey: "comment:issue-1:issue-breakdown:plan-1:children",
      kind: "comment" as const,
      issueId: "issue-1",
      runId: "run-plan-1",
      payload: {
        body: "Created child issues",
        dedupeKey: "issue-breakdown-children:plan-1",
        issueBreakdownPlanId: "plan-1",
      },
    };
    const skipped = await store.enqueueOnce(operation);
    await store.markSkipped(skipped, ISSUE_BREAKDOWN_PLAN_STALE_REASON);

    const writer = new FakeWriter();
    const recoveryProcessor = new WritebackProcessor(store, writer, new StructuredLogger(() => undefined), 300_000);
    await expect(
      recoveryProcessor.enqueueAndProcess(
        {
          ...operation,
          payload: { ...operation.payload, issueBreakdownPlanId: "plan-2" },
        },
        {
          retrySkipped: true,
          retrySkippedMessages: [ISSUE_BREAKDOWN_PLAN_STALE_REASON],
        },
      ),
    ).rejects.toThrow(/different intent/);
    expect(writer.comments).toHaveLength(0);
  });

  it("processes issue creation writebacks and persists child issue evidence", async () => {
    const store = new FileWritebackOutboxStore(root);
    const writer = new FakeWriter();
    const config = testConfig(root);
    const parentIssue = issue({ identifier: "ENG-1", labels: ["planning"], updatedAt: "2026-01-01T00:00:00.000Z" });
    const operationKey = "issue-create:issue-1:plan-1:0:hash";
    const lifecycleStore = {
      get: async () => lifecycleWithIssueBreakdownPlan({ operationKeys: [operationKey], issue: parentIssue, config }),
    };
    const processor = new WritebackProcessor(
      store,
      writer,
      new StructuredLogger(() => undefined),
      300_000,
      lifecycleStore,
      false,
      freshnessGuard(parentIssue, config),
    );

    const result = await processor.enqueueAndProcess({
      idempotencyKey: operationKey,
      kind: "issue_create",
      issueId: "issue-1",
      runId: "run-plan-1",
      payload: {
        parentIssueId: "issue-1",
        title: "Child issue",
        description: agentEligibleIssueContract(),
        acceptanceCriteria: ["Done"],
        requestedLabels: ["planning"],
        dependencies: [],
        dedupeKey: "issue-breakdown:plan-1:0:hash",
        payloadHash: "hash",
        planId: "plan-1",
        proposedIssueIndex: 0,
      },
    });

    expect(result.status).toBe("succeeded");
    expect(result.resultEvidence).toMatchObject({
      kind: "issue_create",
      issueCreateStatus: "created",
      issue: { id: "child-1", identifier: "TEST-2" },
    });
    expect(writer.issueCreates).toHaveLength(1);
  });

  it("skips issue breakdown writebacks that are not registered on the current plan", async () => {
    const store = new FileWritebackOutboxStore(root);
    const writer = new FakeWriter();
    const config = testConfig(root);
    const parentIssue = issue({ identifier: "ENG-1", labels: ["planning"], updatedAt: "2026-01-01T00:00:00.000Z" });
    const lifecycleStore = { get: async () => lifecycleWithIssueBreakdownPlan({ operationKeys: [], issue: parentIssue, config }) };
    const processor = new WritebackProcessor(store, writer, new StructuredLogger(() => undefined), 300_000, lifecycleStore);

    const result = await processor.enqueueAndProcess({
      idempotencyKey: "issue-create:issue-1:plan-1:0:hash",
      kind: "issue_create",
      issueId: "issue-1",
      runId: "run-plan-1",
      payload: {
        parentIssueId: "issue-1",
        title: "Child issue",
        description: agentEligibleIssueContract(),
        acceptanceCriteria: ["Done"],
        requestedLabels: ["planning"],
        dependencies: [],
        dedupeKey: "issue-breakdown:plan-1:0:hash",
        payloadHash: "hash",
        planId: "plan-1",
        proposedIssueIndex: 0,
      },
    });

    expect(result.status).toBe("skipped");
    expect(result.lastError).toBe("issue breakdown writeback is not registered on the current plan");
    expect(writer.issueCreates).toEqual([]);
  });

  it("skips superseded issue breakdown replay work before tracker writes", async () => {
    const config = testConfig(root);
    config.issueBreakdown.applyToLinear.enabled = true;
    config.writeback.enabled = true;
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const store = new FileWritebackOutboxStore(config.workspace.stateDir);
    const parentIssue = issue({ identifier: "ENG-1", labels: ["planning"], updatedAt: "2026-01-01T00:00:00.000Z" });
    const seeded = await seedSupersededIssueBreakdownWork(config, lifecycleStore, store, parentIssue);
    const writer = new FakeWriter();
    const processor = new WritebackProcessor(
      store,
      writer,
      new StructuredLogger(() => undefined),
      300_000,
      lifecycleStore,
      false,
      freshnessGuard(parentIssue, config),
    );

    await processor.processDue();
    const lifecycle = await lifecycleStore.get(parentIssue.id);

    for (const key of seeded.replayOperationKeys) {
      await expect(store.get(key)).resolves.toMatchObject({
        status: "skipped",
        lastError: "issue breakdown writeback is not bound to the current plan",
      });
    }
    expect(writer.issueCreates).toEqual([]);
    expect(writer.issueRelations).toEqual([]);
    expect(writer.comments).toEqual([]);
    expect(lifecycle?.lastIssueBreakdownPlanId).toBe(seeded.currentPlan.id);
    expect(lifecycle?.issueBreakdownPlans.find((plan) => plan.id === seeded.supersededPlan.id)).toMatchObject({
      applicationStatus: "pending",
      applicationBlockedReason: null,
    });
  });

  it("skips issue breakdown writebacks that are no longer fresh", async () => {
    const store = new FileWritebackOutboxStore(root);
    const writer = new FakeWriter();
    const config = testConfig(root);
    const originalIssue = issue({ identifier: "ENG-1", labels: ["planning"], title: "Original title", updatedAt: "2026-01-01T00:00:00.000Z" });
    const driftedIssue = { ...originalIssue, title: "Changed title", updatedAt: "2026-01-02T00:00:00.000Z" };
    const operationKey = "issue-create:issue-1:plan-1:0:hash";
    const lifecycleStore = {
      get: async () => lifecycleWithIssueBreakdownPlan({ operationKeys: [operationKey], issue: originalIssue, config }),
    };
    const processor = new WritebackProcessor(
      store,
      writer,
      new StructuredLogger(() => undefined),
      300_000,
      lifecycleStore,
      false,
      freshnessGuard(driftedIssue, config),
    );

    const result = await processor.enqueueAndProcess(issueCreateOperation(operationKey));

    expect(result.status).toBe("skipped");
    expect(result.lastError).toBe(ISSUE_BREAKDOWN_PLAN_STALE_REASON);
    expect(writer.issueCreates).toEqual([]);
  });

  it("skips issue breakdown writebacks when issue-breakdown config changes", async () => {
    const store = new FileWritebackOutboxStore(root);
    const writer = new FakeWriter();
    const acceptedConfig = testConfig(root);
    const currentConfig = testConfig(root);
    currentConfig.issueBreakdown.planningLabels = ["changed-planning-label"];
    const parentIssue = issue({ identifier: "ENG-1", labels: ["planning"], updatedAt: "2026-01-01T00:00:00.000Z" });
    const operationKey = "issue-create:issue-1:plan-1:0:hash";
    const lifecycleStore = {
      get: async () => lifecycleWithIssueBreakdownPlan({ operationKeys: [operationKey], issue: parentIssue, config: acceptedConfig }),
    };
    const processor = new WritebackProcessor(
      store,
      writer,
      new StructuredLogger(() => undefined),
      300_000,
      lifecycleStore,
      false,
      freshnessGuard(parentIssue, currentConfig),
    );

    const result = await processor.enqueueAndProcess(issueCreateOperation(operationKey));

    expect(result.status).toBe("skipped");
    expect(result.lastError).toBe(ISSUE_BREAKDOWN_PLAN_STALE_REASON);
    expect(writer.issueCreates).toEqual([]);
  });

  it("retries issue breakdown writebacks when freshness lookup is transient", async () => {
    const store = new FileWritebackOutboxStore(root);
    const writer = new FakeWriter();
    const config = testConfig(root);
    const parentIssue = issue({ identifier: "ENG-1", labels: ["planning"], updatedAt: "2026-01-01T00:00:00.000Z" });
    const operationKey = "issue-create:issue-1:plan-1:0:hash";
    const lifecycleStore = {
      get: async () => lifecycleWithIssueBreakdownPlan({ operationKeys: [operationKey], issue: parentIssue, config }),
    };
    const processor = new WritebackProcessor(
      store,
      writer,
      new StructuredLogger(() => undefined),
      300_000,
      lifecycleStore,
      false,
      { getConfig: () => config, resolveIssue: async () => ({ status: "transient_error", message: "temporary outage" }) },
    );

    const result = await processor.enqueueAndProcess(issueCreateOperation(operationKey));

    expect(result.status).toBe("retrying");
    expect(result.lastError).toContain("temporary outage");
    expect(writer.issueCreates).toEqual([]);
  });

  it("fails closed for issue breakdown writebacks without a freshness guard", async () => {
    const store = new FileWritebackOutboxStore(root);
    const writer = new FakeWriter();
    const config = testConfig(root);
    const parentIssue = issue({ identifier: "ENG-1", labels: ["planning"], updatedAt: "2026-01-01T00:00:00.000Z" });
    const operationKey = "issue-create:issue-1:plan-1:0:hash";
    const lifecycleStore = {
      get: async () => lifecycleWithIssueBreakdownPlan({ operationKeys: [operationKey], issue: parentIssue, config }),
    };
    const processor = new WritebackProcessor(store, writer, new StructuredLogger(() => undefined), 300_000, lifecycleStore);

    const result = await processor.enqueueAndProcess(issueCreateOperation(operationKey));

    expect(result.status).toBe("skipped");
    expect(result.lastError).toContain("freshness guard");
    expect(writer.issueCreates).toEqual([]);
  });

  it("scopes processDue to requested idempotency keys without consuming sibling issue breakdown work", async () => {
    const store = new FileWritebackOutboxStore(root);
    const writer = new FakeWriter();
    const transitionKey = "transition:issue-1:publication-approval-pending:Blocked";
    const issueCreateKey = "issue-create:issue-1:plan-1:0:hash";
    await store.enqueueOnce(issueCreateOperation(issueCreateKey));
    await store.enqueueOnce({
      idempotencyKey: transitionKey,
      kind: "transition",
      issueId: "issue-1",
      payload: { fromStates: ["In Progress"], toState: "Blocked" },
    });
    const processor = new WritebackProcessor(store, writer, new StructuredLogger(() => undefined), 300_000);

    await processor.processDue({ idempotencyKeys: [transitionKey] });

    await expect(store.get(transitionKey)).resolves.toMatchObject({ status: "succeeded" });
    await expect(store.get(issueCreateKey)).resolves.toMatchObject({ status: "pending" });
    expect(writer.transitions).toHaveLength(1);
    expect(writer.issueCreates).toHaveLength(0);
  });

  it("skips stale legacy issue breakdown parent comments without posting them", async () => {
    const store = new FileWritebackOutboxStore(root);
    const writer = new FakeWriter();
    const config = testConfig(root);
    const originalIssue = issue({ identifier: "ENG-1", title: "Original title", updatedAt: "2026-01-01T00:00:00.000Z" });
    const driftedIssue = { ...originalIssue, title: "Changed title", updatedAt: "2026-01-02T00:00:00.000Z" };
    const operationKey = "comment:issue-1:issue-breakdown:plan-1:children";
    const lifecycleStore = {
      get: async () =>
        lifecycleWithIssueBreakdownPlan({
          operationKeys: [operationKey],
          issue: originalIssue,
          config,
          createdIssueRefs: [createdIssueRef()],
        }),
    };
    const processor = new WritebackProcessor(
      store,
      writer,
      new StructuredLogger(() => undefined),
      300_000,
      lifecycleStore,
      false,
      freshnessGuard(driftedIssue, config),
    );

    const result = await processor.enqueueAndProcess(legacyParentCommentOperation(operationKey));

    expect(result.status).toBe("skipped");
    expect(result.lastError).toBe(ISSUE_BREAKDOWN_PLAN_STALE_REASON);
    expect(writer.comments).toHaveLength(0);
  });

  it("processes fresh legacy issue breakdown parent comments", async () => {
    const store = new FileWritebackOutboxStore(root);
    const writer = new FakeWriter();
    const config = testConfig(root);
    const parentIssue = issue({ identifier: "ENG-1", labels: ["planning"], updatedAt: "2026-01-01T00:00:00.000Z" });
    const operationKey = "comment:issue-1:issue-breakdown:plan-1:children";
    const lifecycleStore = {
      get: async () =>
        lifecycleWithIssueBreakdownPlan({
          operationKeys: [operationKey],
          issue: parentIssue,
          config,
          createdIssueRefs: [createdIssueRef()],
        }),
    };
    const processor = new WritebackProcessor(
      store,
      writer,
      new StructuredLogger(() => undefined),
      300_000,
      lifecycleStore,
      false,
      freshnessGuard(parentIssue, config),
    );

    const result = await processor.enqueueAndProcess(legacyParentCommentOperation(operationKey));

    expect(result.status).toBe("succeeded");
    expect(writer.comments).toHaveLength(1);
  });

  it("holds an already-enqueued legacy parent transition until relation and comment finalization succeeds", async () => {
    const store = new FileWritebackOutboxStore(root);
    const writer = new FakeWriter();
    const config = testConfig(root);
    const parentIssue = issue({ identifier: "ENG-1", labels: ["planning"], updatedAt: "2026-01-01T00:00:00.000Z" });
    const planId = "issue-breakdown-plan:issue-1:legacy-plan-v1";
    const relationKey = `issue-relation:issue-1:${planId}:0:parent`;
    const commentKey = `comment:issue-1:issue-breakdown:${planId}:children`;
    const transitionKey = `transition:issue-1:issue-breakdown:${planId}:In Review`;
    const lifecycleStore = {
      get: async () =>
        lifecycleWithIssueBreakdownPlan({
          planId,
          operationKeys: [relationKey, commentKey, transitionKey],
          issue: parentIssue,
          config,
          createdIssueRefs: [createdIssueRef()],
        }),
    };
    await store.enqueueOnce({
      idempotencyKey: relationKey,
      kind: "issue_relation",
      issueId: "issue-1",
      runId: "run-plan-1",
      payload: {
        planId,
        sourceIssueId: "child-1",
        sourceIssueIdentifier: "TEST-2",
        targetIssueId: "issue-1",
        targetIssueIdentifier: "ENG-1",
        type: "blocks",
        dependency: "Blocks parent issue ENG-1",
        dedupeKey: `issue-breakdown-parent-relation:${planId}:0`,
        sourceProposedIssueIndex: 0,
        targetProposedIssueIndex: -1,
      },
    });
    await store.enqueueOnce({
      idempotencyKey: commentKey,
      kind: "comment",
      issueId: "issue-1",
      runId: "run-plan-1",
      payload: {
        body: "Created child issues",
        dedupeKey: `issue-breakdown-children:${planId}`,
        issueBreakdownPlanId: planId,
      },
    });
    await store.enqueueOnce({
      idempotencyKey: transitionKey,
      kind: "transition",
      issueId: "issue-1",
      runId: "run-plan-1",
      payload: {
        fromStates: ["In Progress"],
        toState: "In Review",
        reason: "Legacy transition without explicit plan metadata",
      },
    });
    const processor = new WritebackProcessor(
      store,
      writer,
      new StructuredLogger(() => undefined),
      300_000,
      lifecycleStore,
      false,
      freshnessGuard(parentIssue, config),
    );

    await processor.processDue({ idempotencyKeys: [transitionKey] });

    await expect(store.get(transitionKey)).resolves.toMatchObject({
      status: "retrying",
      lastError: expect.stringContaining(ISSUE_BREAKDOWN_FINALIZATION_PENDING_REASON),
    });
    expect(writer.transitions).toEqual([]);

    const relation = await store.get(relationKey);
    if (!relation) throw new Error("missing relation fixture");
    await store.markSucceeded(relation, { status: "applied" });
    await makeWritebackDue(store, transitionKey);
    await processor.processDue({ idempotencyKeys: [transitionKey] });

    await expect(store.get(transitionKey)).resolves.toMatchObject({
      status: "retrying",
      lastError: expect.stringContaining(commentKey),
    });
    expect(writer.transitions).toEqual([]);

    const comment = await store.get(commentKey);
    if (!comment) throw new Error("missing comment fixture");
    await store.markSucceeded(comment, { status: "applied" });
    await makeWritebackDue(store, transitionKey);
    await processor.processDue({ idempotencyKeys: [transitionKey] });

    await expect(store.get(transitionKey)).resolves.toMatchObject({ status: "succeeded" });
    expect(writer.transitions).toHaveLength(1);
  });

  it("does not treat ordinary comments as issue breakdown parent comments", async () => {
    const store = new FileWritebackOutboxStore(root);
    const writer = new FakeWriter();
    const processor = new WritebackProcessor(store, writer, new StructuredLogger(() => undefined), 300_000);

    const result = await processor.enqueueAndProcess({
      idempotencyKey: "comment:issue-1:run-1:completion-report:idem-1:publication-approval-pending",
      kind: "comment",
      issueId: "issue-1",
      runId: "run-1",
      payload: {
        body: "Publication approval pending",
        dedupeKey: "run-1:completion-report:idem-1:publication-approval-pending",
      },
    });

    expect(result.status).toBe("succeeded");
    expect(writer.comments).toHaveLength(1);
  });

  it("skips ambiguous legacy issue breakdown parent comment bindings", async () => {
    const store = new FileWritebackOutboxStore(root);
    const writer = new FakeWriter();
    const processor = new WritebackProcessor(store, writer, new StructuredLogger(() => undefined), 300_000);

    const result = await processor.enqueueAndProcess({
      idempotencyKey: "comment:issue-1:issue-breakdown:plan-from-key:children",
      kind: "comment",
      issueId: "issue-1",
      runId: "run-plan-1",
      payload: {
        body: "Created child issues",
        dedupeKey: "issue-breakdown-children:plan-from-dedupe",
      },
    });

    expect(result.status).toBe("skipped");
    expect(result.lastError).toContain("ambiguous");
    expect(writer.comments).toHaveLength(0);
  });
});

describe("SqliteWritebackOutboxStore", () => {
  let root: string;
  let stores: SqliteWritebackOutboxStore[];

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-writeback-sqlite-"));
    stores = [];
  });

  afterEach(async () => {
    await Promise.all(stores.map((store) => store.close()));
    await rm(root, { recursive: true, force: true });
  });

  function track(store: SqliteWritebackOutboxStore): SqliteWritebackOutboxStore {
    stores.push(store);
    return store;
  }

  it("persists processed operations across store instances", async () => {
    const operation: NewWritebackOperation = {
      idempotencyKey: "transition:issue-1:done",
      kind: "transition",
      issueId: "issue-1",
      payload: { fromStates: ["Ready to Merge"], toState: "Done" },
    };
    const firstStore = track(new SqliteWritebackOutboxStore(root));
    const writer = new FakeWriter();
    const firstProcessor = new WritebackProcessor(firstStore, writer, new StructuredLogger(() => undefined), 300_000);

    await expect(firstProcessor.enqueueAndProcess(operation)).resolves.toMatchObject({ status: "succeeded" });
    expect(writer.transitions).toHaveLength(1);
    await firstStore.close();

    const secondStore = track(new SqliteWritebackOutboxStore(root));
    await expect(secondStore.get(operation.idempotencyKey)).resolves.toMatchObject({ status: "succeeded" });
    const secondWriter = new FakeWriter();
    const secondProcessor = new WritebackProcessor(secondStore, secondWriter, new StructuredLogger(() => undefined), 300_000);

    await expect(secondProcessor.enqueueAndProcess(operation)).resolves.toMatchObject({ status: "succeeded" });
    expect(secondWriter.transitions).toHaveLength(0);
  });

  it("persists lifecycle bindings and rejects changed intent", async () => {
    const store = track(new SqliteWritebackOutboxStore(root));
    const operation: NewWritebackOperation = {
      idempotencyKey: "comment:issue-1:bound-report",
      kind: "comment",
      issueId: "issue-1",
      lifecycleBinding: { kind: "completion_report", recordId: "report-1" },
      payload: { body: "Original full disposition", dedupeKey: "bound-report" },
    };
    await store.enqueueOnce(operation);

    await expect(store.get(operation.idempotencyKey)).resolves.toMatchObject({
      lifecycleBinding: operation.lifecycleBinding,
    });
    await expect(
      store.enqueueOnce({
        ...operation,
        payload: { ...operation.payload, body: "Changed disposition" },
      }),
    ).rejects.toThrow(/different intent/);
  });

  it("imports legacy file outbox records on first open", async () => {
    const legacyStore = new FileWritebackOutboxStore(root);
    const operation: NewWritebackOperation = {
      idempotencyKey: "comment:issue-1:legacy",
      kind: "comment",
      issueId: "issue-1",
      payload: { body: "Legacy writeback", dedupeKey: "legacy" },
    };
    await legacyStore.enqueueOnce(operation);

    const store = track(new SqliteWritebackOutboxStore(root));

    await expect(store.get(operation.idempotencyKey)).resolves.toMatchObject({
      idempotencyKey: operation.idempotencyKey,
      status: "pending",
    });
    await expect(store.claimDue(new Date("9999-01-01T00:00:00.000Z"))).resolves.toMatchObject([
      { idempotencyKey: operation.idempotencyKey, status: "in_flight" },
    ]);
    await expect(readdir(path.join(root, "writeback"))).resolves.toHaveLength(1);
  });

  it("claims one due record once across concurrent store instances", async () => {
    const operation: NewWritebackOperation = {
      idempotencyKey: "comment:issue-1:concurrent",
      kind: "comment",
      issueId: "issue-1",
      payload: { body: "Concurrent writeback", dedupeKey: "concurrent" },
    };
    const seedStore = track(new SqliteWritebackOutboxStore(root));
    await seedStore.enqueueOnce(operation);
    const storeA = track(new SqliteWritebackOutboxStore(root));
    const storeB = track(new SqliteWritebackOutboxStore(root));

    const claims = await Promise.all([
      storeA.claimDue(new Date("9999-01-01T00:00:00.000Z")),
      storeB.claimDue(new Date("9999-01-01T00:00:00.000Z")),
    ]);

    expect(claims.flat()).toHaveLength(1);
    expect(claims.flat()[0]).toMatchObject({ idempotencyKey: operation.idempotencyKey, status: "in_flight" });
    await expect(seedStore.get(operation.idempotencyKey)).resolves.toMatchObject({ status: "in_flight" });
  });

  it("recovers expired in-flight triage writebacks after a processor restart without stealing a live claim", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const commentKey = "comment:issue-1:triage:restart-report";
      const transitionKey =
        "transition:issue-1:triage:restart-report:In Progress";
      const lifecycle = {
        issueTriageReports: [
          {
            id: "restart-report",
            writebackOperationKeys: [commentKey, transitionKey],
            supersededAt: null,
          },
        ],
      } as unknown as IssueLifecycleRecord;
      const seedStore = track(new SqliteWritebackOutboxStore(root));
      await seedStore.enqueueOnce({
        idempotencyKey: commentKey,
        kind: "comment",
        issueId: "issue-1",
        lifecycleBinding: {
          kind: "issue_triage_report",
          recordId: "restart-report",
        },
        payload: {
          body: "Full triage disposition after restart",
          dedupeKey: "restart-report",
        },
      });
      await seedStore.enqueueOnce({
        idempotencyKey: transitionKey,
        kind: "transition",
        issueId: "issue-1",
        lifecycleBinding: {
          kind: "issue_triage_report",
          recordId: "restart-report",
        },
        payload: {
          fromStates: ["In Review"],
          toState: "In Progress",
        },
      });
      await expect(seedStore.claimDue()).resolves.toHaveLength(2);

      const recoveryStore = track(new SqliteWritebackOutboxStore(root));
      const writer = new FakeWriter();
      const processor = new WritebackProcessor(
        recoveryStore,
        writer,
        new StructuredLogger(() => undefined),
        300_000,
        { get: async () => lifecycle },
      );

      await processor.processDue();

      await expect(recoveryStore.get(commentKey)).resolves.toMatchObject({
        status: "in_flight",
      });
      await expect(recoveryStore.get(transitionKey)).resolves.toMatchObject({
        status: "in_flight",
      });
      expect(writer.comments).toHaveLength(0);
      expect(writer.transitions).toHaveLength(0);

      vi.advanceTimersByTime(WRITEBACK_IN_FLIGHT_LEASE_MS + 1);
      await processor.processDue();

      await expect(recoveryStore.get(commentKey)).resolves.toMatchObject({
        status: "succeeded",
        attempt: 1,
      });
      await expect(recoveryStore.get(transitionKey)).resolves.toMatchObject({
        status: "succeeded",
        attempt: 1,
      });
      expect(writer.comments).toHaveLength(1);
      expect(writer.transitions).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers an expired in-flight breakdown child creation through its durable plan guard", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const config = testConfig(root);
      const parentIssue = issue({
        identifier: "ENG-1",
        labels: ["planning"],
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      const operationKey = "issue-create:issue-1:plan-1:0:restart-hash";
      const operation: NewWritebackOperation = {
        idempotencyKey: operationKey,
        kind: "issue_create",
        issueId: "issue-1",
        runId: "run-plan-1",
        payload: {
          parentIssueId: "issue-1",
          title: "Recovered child issue",
          description: agentEligibleIssueContract(),
          acceptanceCriteria: ["Done"],
          requestedLabels: ["planning"],
          dependencies: [],
          dedupeKey: "issue-breakdown:plan-1:0:restart-hash",
          payloadHash: "restart-hash",
          planId: "plan-1",
          proposedIssueIndex: 0,
        },
      };
      const lifecycleStore = {
        get: async () =>
          lifecycleWithIssueBreakdownPlan({
            operationKeys: [operationKey],
            issue: parentIssue,
            config,
          }),
      };
      const seedStore = track(new SqliteWritebackOutboxStore(root));
      await seedStore.enqueueOnce(operation);
      await expect(seedStore.claimDue()).resolves.toMatchObject([
        { idempotencyKey: operationKey, status: "in_flight" },
      ]);

      vi.advanceTimersByTime(WRITEBACK_IN_FLIGHT_LEASE_MS + 1);
      const recoveryStore = track(new SqliteWritebackOutboxStore(root));
      const writer = new FakeWriter();
      const processor = new WritebackProcessor(
        recoveryStore,
        writer,
        new StructuredLogger(() => undefined),
        300_000,
        lifecycleStore,
        false,
        freshnessGuard(parentIssue, config),
      );

      await processor.processDue();

      await expect(recoveryStore.get(operationKey)).resolves.toMatchObject({
        status: "succeeded",
        attempt: 1,
        resultEvidence: {
          kind: "issue_create",
          issueCreateStatus: "created",
          issue: { id: "child-1", identifier: "TEST-2" },
        },
      });
      expect(writer.issueCreates).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes the backing store through WritebackProcessor", async () => {
    const store = track(new SqliteWritebackOutboxStore(root));
    const processor = new WritebackProcessor(store, new FakeWriter(), new StructuredLogger(() => undefined), 300_000);

    await processor.close();
    await expect(store.list()).resolves.toEqual([]);
  });
});

class FakeWriter implements TrackerWriter {
  readonly transitions: TrackerTransitionInput[] = [];
  readonly comments: TrackerCommentInput[] = [];
  readonly issueCreates: TrackerIssueCreateInput[] = [];
  readonly issueRelations: TrackerIssueRelationInput[] = [];

  constructor(private readonly options: { transitionStatus?: TrackerWriteResult["status"]; commentDelayMs?: number } = {}) {}

  async transitionIssueState(input: TrackerTransitionInput): Promise<TrackerWriteResult> {
    this.transitions.push(input);
    const status = this.options.transitionStatus ?? "applied";
    return status === "skipped" ? { status, message: "fake skipped" } : { status };
  }

  async createIssueComment(input: TrackerCommentInput): Promise<TrackerWriteResult> {
    if (this.options.commentDelayMs) await new Promise((resolve) => setTimeout(resolve, this.options.commentDelayMs));
    this.comments.push(input);
    return { status: "applied" };
  }

  async createIssueFromPlan(input: TrackerIssueCreateInput): Promise<TrackerWriteResult> {
    this.issueCreates.push(input);
    return {
      status: "applied",
      evidence: {
        kind: "issue_create",
        issue: { id: "child-1", identifier: "TEST-2", url: "https://linear.test/TEST-2" },
        issueCreateStatus: "created",
        parentIssueId: input.parentIssueId,
        dedupeKey: input.dedupeKey,
        payloadHash: input.payloadHash,
        unresolvedLabelNames: [],
      },
    };
  }

  async createIssueRelation(input: TrackerIssueRelationInput): Promise<TrackerWriteResult> {
    this.issueRelations.push(input);
    return { status: "applied" };
  }
}

function completionReport(overrides: {
  id: string;
  writebackOperationKeys: string[];
  pullRequest: { url: string; number: number; headSha: string; branch: string } | null;
}) {
  return {
    id: overrides.id,
    idempotencyKey: overrides.id,
    runId: "run-1",
    issueId: "issue-1",
    issueIdentifier: "ENG-1",
    summary: "Done",
    validationEvidence: ["tests"],
    acceptanceChecklist: [{ text: "implemented", satisfied: true, evidence: "tests" }],
    changedFiles: ["src/example.ts"],
    branchName: "eng-13",
    pullRequest: overrides.pullRequest,
    risks: [],
    acceptedAt: "2026-01-01T00:00:00.000Z",
    writebackOperationKeys: overrides.writebackOperationKeys,
  };
}

function lifecycleWithReports(overrides: { lastCompletionReportId: string; completionReports: ReturnType<typeof completionReport>[] }): IssueLifecycleRecord {
  const summaryPointers = {
    workspaceKey: null,
    workspacePath: null,
    branchName: null,
    gitBranchName: null,
    repoPath: null,
    baseRef: null,
    lastRunId: null,
    prUrl: null,
    prNumber: null,
    prHeadSha: null,
    prBranch: null,
    ciStatus: null,
    lastPushedAt: null,
    lastEvidenceCursor: null,
  };

  return {
    issueId: "issue-1",
    issueIdentifier: "ENG-1",
    phase: "review",
    reviewRound: 0,
    incompleteTurnCount: 0,
    lastIssueBreakdownPlanId: null,
    planningFailureCount: 0,
    planningDispatchRetryCount: 0,
    lastPlanningFailureRunId: null,
    lastPlanningFailureAt: null,
    lastIssueTriageReportId: null,
    lastPostMortemReportId: null,
    lastCompletionReportId: overrides.lastCompletionReportId,
    lastCompletionReportRejectionId: null,
    lastReviewVerdictId: null,
    blockedReason: null,
    summaryPointers,
    summaryReferences: [],
    issueBreakdownPlans: [],
    completionReports: overrides.completionReports,
    completionReportRejections: [],
    reviewVerdicts: [],
    reviewFeedback: [],
    issueTriageReports: [],
    postMortemReports: [],
    reviewEvidence: {
      pullRequest: null,
      lastIngestedCursor: null,
      lastWorkerEvidenceCursor: null,
      items: [],
      updatedAt: null,
    },
    merge: null,
    mergeConflict: null,
    mergeConflictResolutionReports: [],
    handoff: {
      version: 1,
      memo: {
        version: 1,
        issueId: "issue-1",
        issueIdentifier: "ENG-1",
        updatedAt: "2026-01-01T00:00:00.000Z",
        reviewRound: 0,
        incompleteTurnCount: 0,
        sizeChars: 0,
        entries: [],
        openFindings: [],
        pointers: summaryPointers,
        lastWorkerRunId: null,
        lastReviewerRunId: null,
      },
      lastWorkerOutput: null,
      lastReviewerOutput: null,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

async function seedSupersededIssueBreakdownWork(
  config: ServiceConfig,
  lifecycleStore: FileIssueLifecycleStore,
  store: FileWritebackOutboxStore,
  parentIssue: Issue,
): Promise<{
  supersededPlan: IssueBreakdownPlanRecord;
  currentPlan: IssueBreakdownPlanRecord;
  replayOperationKeys: string[];
}> {
  const planA = await submitTwoChildPlan(config, lifecycleStore, parentIssue, "plan-a", "run-plan-a");
  const childOperations = planIssueBreakdownApplicationWritebacks(parentIssue, planA) as IssueCreateWriteback[];
  const planAWithRefs = {
    ...planA,
    createdIssueRefs: childOperations.map((operation) => createdIssueRefForOperation(operation)),
  };
  const finalOperations = planIssueBreakdownFinalizationWritebacks(parentIssue, planAWithRefs);
  const relationOperation = finalOperations.find((operation): operation is IssueRelationWriteback => operation.kind === "issue_relation");
  const parentCommentOperation = finalOperations.find((operation): operation is CommentWriteback => operation.kind === "comment");
  if (!relationOperation || !parentCommentOperation) throw new Error("expected relation and parent comment writebacks");

  const registeredOperationKeys = [
    ...childOperations.map((operation) => operation.idempotencyKey),
    ...finalOperations.map((operation) => operation.idempotencyKey),
  ];
  const lifecycle = await lifecycleStore.get(parentIssue.id);
  await lifecycleStore.updateIssue(parentIssue, {
    issueBreakdownPlans: (lifecycle?.issueBreakdownPlans ?? []).map((plan) =>
      plan.id === planA.id
        ? {
            ...planAWithRefs,
            applicationStatus: "pending",
            applicationOperationKeys: registeredOperationKeys,
            applicationBlockedReason: null,
          }
        : plan,
    ),
    lastIssueBreakdownPlanId: planA.id,
  });

  await store.enqueueOnce(childOperations[0]!);
  await store.markRetry(await store.enqueueOnce(relationOperation), "transient relation failure", "2026-01-01T00:00:00.000Z");
  await store.enqueueOnce(parentCommentOperation);

  const planB = await submitTwoChildPlan(config, lifecycleStore, parentIssue, "plan-b", "run-plan-b");
  return {
    supersededPlan: planA,
    currentPlan: planB,
    replayOperationKeys: [childOperations[0]!.idempotencyKey, relationOperation.idempotencyKey, parentCommentOperation.idempotencyKey],
  };
}

async function submitTwoChildPlan(
  config: ServiceConfig,
  lifecycleStore: FileIssueLifecycleStore,
  parentIssue: Issue,
  idempotencyKey: string,
  runId: string,
): Promise<IssueBreakdownPlanRecord> {
  const result = await new IssueBreakdownPlanService({ config, lifecycleStore }).submit_issue_breakdown_plan(
    {
      runId,
      issueId: parentIssue.id,
      finalDisposition: "Split the work into two dependency-ordered child issues.",
      summary: "Split into child issues.",
      proposedIssues: [
        {
          title: "Build child",
          description: agentEligibleIssueContract(),
          acceptanceCriteria: ["Done"],
          dependencies: [],
          labels: ["planning"],
        },
        {
          title: "Build dependent child",
          description: agentEligibleIssueContract(),
          acceptanceCriteria: ["Done"],
          dependencies: ["Build child"],
          labels: ["planning"],
        },
      ],
      idempotencyKey,
    },
    { issue: parentIssue, activeRunId: runId, role: "worker", phase: "issue_breakdown" },
  );
  return result.plan;
}

function createdIssueRefForOperation(operation: IssueCreateWriteback): IssueBreakdownCreatedIssueRef {
  const childNumber = operation.payload.proposedIssueIndex + 1;
  return {
    proposedIssueIndex: operation.payload.proposedIssueIndex,
    operationKey: operation.idempotencyKey,
    status: "created",
    id: `child-${childNumber}`,
    identifier: `TEST-${childNumber + 1}`,
    url: `https://linear.test/TEST-${childNumber + 1}`,
  };
}

function lifecycleWithIssueBreakdownPlan(overrides: {
  planId?: string;
  operationKeys: string[];
  issue: Issue;
  config: ServiceConfig;
  applicationStatus?: IssueLifecycleRecord["issueBreakdownPlans"][number]["applicationStatus"];
  createdIssueRefs?: IssueBreakdownCreatedIssueRef[];
}): IssueLifecycleRecord {
  const lifecycle = lifecycleWithReports({ lastCompletionReportId: "report-1", completionReports: [] });
  const planId = overrides.planId ?? "plan-1";
  return {
    ...lifecycle,
    phase: "implementation",
    lastCompletionReportId: null,
    lastIssueBreakdownPlanId: planId,
    issueBreakdownPlans: [
      {
        id: planId,
        idempotencyKey: "plan-key",
        requestHash: "request-hash",
        runId: "run-plan-1",
        issueId: "issue-1",
        issueIdentifier: "ENG-1",
        summary: "Split issue",
        proposedIssues: [
          {
            title: "Child issue",
            description: agentEligibleIssueContract(),
            acceptanceCriteria: ["Done"],
            dependencies: [],
            labels: ["planning"],
          },
        ],
        transcriptPointers: [],
        statusApiPointers: [],
        issueUpdatedAt: overrides.issue.updatedAt,
        issueContentFingerprint: issueContentFingerprint(overrides.issue),
        configFingerprint: issueBreakdownConfigFingerprint(overrides.config),
        cursorMode: "plan",
        acceptedAt: "2026-01-01T00:00:00.000Z",
        applicationStatus: overrides.applicationStatus ?? "pending",
        applicationOperationKeys: overrides.operationKeys,
        createdIssueRefs: overrides.createdIssueRefs ?? [],
        appliedAt: null,
        applicationBlockedReason: null,
      },
    ],
  };
}

function freshnessGuard(parentIssue: Issue, config: ServiceConfig): IssueBreakdownFreshnessGuard {
  return {
    getConfig: () => config,
    resolveIssue: async () => ({ status: "ok", issue: parentIssue }),
  };
}

function issueCreateOperation(idempotencyKey: string) {
  return {
    idempotencyKey,
    kind: "issue_create" as const,
    issueId: "issue-1",
    runId: "run-plan-1",
    payload: {
      parentIssueId: "issue-1",
      title: "Child issue",
      description: agentEligibleIssueContract(),
      acceptanceCriteria: ["Done"],
      requestedLabels: ["planning"],
      dependencies: [],
      dedupeKey: "issue-breakdown:plan-1:0:hash",
      payloadHash: "hash",
      planId: "plan-1",
      proposedIssueIndex: 0,
    },
  };
}

function legacyParentCommentOperation(idempotencyKey: string) {
  return {
    idempotencyKey,
    kind: "comment" as const,
    issueId: "issue-1",
    runId: "run-plan-1",
    payload: {
      body: "Created child issues",
      dedupeKey: "issue-breakdown-children:plan-1",
    },
  };
}

function createdIssueRef(): IssueBreakdownCreatedIssueRef {
  return {
    proposedIssueIndex: 0,
    operationKey: "issue-create:issue-1:plan-1:0:hash",
    status: "created",
    id: "child-1",
    identifier: "TEST-2",
    url: "https://linear.test/TEST-2",
  };
}

async function makeWritebackDue(store: FileWritebackOutboxStore, idempotencyKey: string): Promise<void> {
  const record = await store.get(idempotencyKey);
  if (!record) throw new Error(`missing writeback fixture ${idempotencyKey}`);
  await store.markRetry(record, record.lastError ?? "waiting for prerequisite", "2000-01-01T00:00:00.000Z");
}

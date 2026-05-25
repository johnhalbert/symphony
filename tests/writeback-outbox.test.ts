import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import type { IssueLifecycleRecord } from "../src/core/persistence/IssueLifecycleStore.js";
import type { TrackerCommentInput, TrackerTransitionInput, TrackerWriteResult, TrackerWriter } from "../src/core/tracker/TrackerWriter.js";
import { FileWritebackOutboxStore, WritebackProcessor } from "../src/core/writeback/WritebackOutbox.js";

describe("FileWritebackOutboxStore", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-writeback-"));
  });

  afterEach(async () => {
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

  it("does not requeue a skipped operation when the recovery payload does not match", async () => {
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
    ).resolves.toMatchObject({ status: "skipped" });
    expect(writer.transitions).toHaveLength(0);
  });
});

class FakeWriter implements TrackerWriter {
  readonly transitions: TrackerTransitionInput[] = [];
  readonly comments: TrackerCommentInput[] = [];

  constructor(private readonly options: { transitionStatus?: TrackerWriteResult["status"] } = {}) {}

  async transitionIssueState(input: TrackerTransitionInput): Promise<TrackerWriteResult> {
    this.transitions.push(input);
    const status = this.options.transitionStatus ?? "applied";
    return status === "skipped" ? { status, message: "fake skipped" } : { status };
  }

  async createIssueComment(input: TrackerCommentInput): Promise<TrackerWriteResult> {
    this.comments.push(input);
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
    lastCompletionReportId: overrides.lastCompletionReportId,
    lastReviewVerdictId: null,
    blockedReason: null,
    summaryPointers,
    summaryReferences: [],
    completionReports: overrides.completionReports,
    reviewVerdicts: [],
    reviewFeedback: [],
    reviewEvidence: {
      pullRequest: null,
      lastIngestedCursor: null,
      lastWorkerEvidenceCursor: null,
      items: [],
      updatedAt: null,
    },
    merge: null,
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

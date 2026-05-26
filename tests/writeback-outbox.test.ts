import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  FileWritebackOutboxStore,
  ISSUE_BREAKDOWN_PLAN_STALE_REASON,
  WritebackProcessor,
} from "../src/core/writeback/WritebackOutbox.js";
import type { NewWritebackOperation } from "../src/core/writeback/WritebackOutbox.js";
import { issue, testConfig } from "./helpers.js";

type IssueCreateWriteback = Extract<NewWritebackOperation, { kind: "issue_create" }>;
type IssueRelationWriteback = Extract<NewWritebackOperation, { kind: "issue_relation" }>;
type CommentWriteback = Extract<NewWritebackOperation, { kind: "comment" }>;

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

  it("does not requeue a skipped comment when the explicit issue breakdown plan binding differs", async () => {
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
    ).resolves.toMatchObject({ status: "skipped" });
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
        description: "Description",
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
        description: "Description",
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

class FakeWriter implements TrackerWriter {
  readonly transitions: TrackerTransitionInput[] = [];
  readonly comments: TrackerCommentInput[] = [];
  readonly issueCreates: TrackerIssueCreateInput[] = [];
  readonly issueRelations: TrackerIssueRelationInput[] = [];

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
    lastCompletionReportId: overrides.lastCompletionReportId,
    lastReviewVerdictId: null,
    blockedReason: null,
    summaryPointers,
    summaryReferences: [],
    issueBreakdownPlans: [],
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
      summary: "Split into child issues.",
      proposedIssues: [
        {
          title: "Build child",
          description: "Implement the child issue.",
          acceptanceCriteria: ["Done"],
          dependencies: [],
          labels: ["planning"],
        },
        {
          title: "Build dependent child",
          description: "Implement the dependent child issue.",
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
  operationKeys: string[];
  issue: Issue;
  config: ServiceConfig;
  applicationStatus?: IssueLifecycleRecord["issueBreakdownPlans"][number]["applicationStatus"];
  createdIssueRefs?: IssueBreakdownCreatedIssueRef[];
}): IssueLifecycleRecord {
  const lifecycle = lifecycleWithReports({ lastCompletionReportId: "report-1", completionReports: [] });
  return {
    ...lifecycle,
    phase: "implementation",
    lastCompletionReportId: null,
    lastIssueBreakdownPlanId: "plan-1",
    issueBreakdownPlans: [
      {
        id: "plan-1",
        idempotencyKey: "plan-key",
        requestHash: "request-hash",
        runId: "run-plan-1",
        issueId: "issue-1",
        issueIdentifier: "ENG-1",
        summary: "Split issue",
        proposedIssues: [
          {
            title: "Child issue",
            description: "Description",
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
      description: "Description",
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

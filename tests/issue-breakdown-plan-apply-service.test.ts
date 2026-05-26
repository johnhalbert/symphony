import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import {
  IssueBreakdownPlanApplyService,
  planIssueBreakdownApplicationWritebacks,
} from "../src/core/IssueBreakdownPlanApplyService.js";
import { IssueBreakdownPlanService } from "../src/core/IssueBreakdownPlanService.js";
import { FileIssueLifecycleStore } from "../src/core/persistence/IssueLifecycleStore.js";
import type {
  TrackerCommentInput,
  TrackerIssueCreateInput,
  TrackerTransitionInput,
  TrackerWriteResult,
  TrackerWriter,
} from "../src/core/tracker/TrackerWriter.js";
import { FileWritebackOutboxStore, WritebackProcessor } from "../src/core/writeback/WritebackOutbox.js";
import type { WritebackOperation, WritebackProcessor as WritebackProcessorType } from "../src/core/writeback/WritebackOutbox.js";
import type { NewWritebackOperation } from "../src/core/writeback/WritebackOutbox.js";
import { ISSUE_BREAKDOWN_PLAN_STALE_REASON } from "../src/core/writeback/WritebackOutbox.js";
import type { Issue } from "../src/core/types.js";
import type { ServiceConfig } from "../src/core/config/Config.js";
import { issue, testConfig } from "./helpers.js";

describe("IssueBreakdownPlanApplyService", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-breakdown-apply-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("applies fresh accepted plans through idempotent issue create writebacks", async () => {
    const config = testConfig(root);
    config.issueBreakdown.applyToLinear.enabled = true;
    config.writeback.enabled = true;
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const candidate = issue({ labels: ["planning"], updatedAt: "2026-01-02T00:00:00Z" });
    await new IssueBreakdownPlanService({ config, lifecycleStore }).submit_issue_breakdown_plan(
      {
        runId: "run-plan-1",
        issueId: candidate.id,
        summary: "Split into child issues.",
        proposedIssues: [
          {
            title: "Build child",
            description: "Implement the child issue.",
            acceptanceCriteria: ["Done"],
            dependencies: [],
            labels: ["planning"],
          },
        ],
        idempotencyKey: "plan-1",
      },
      { issue: candidate, activeRunId: "run-plan-1", role: "worker", phase: "issue_breakdown" },
    );
    const writeback = new CapturingWriteback();

    const result = await new IssueBreakdownPlanApplyService({ config, lifecycleStore, writeback }).applyLatestFreshPlan(candidate);
    const lifecycle = await lifecycleStore.get(candidate.id);

    expect(result.status).toBe("applied");
    expect(writeback.operations[0]).toMatchObject({
      kind: "issue_create",
      issueId: candidate.id,
      payload: { title: "Build child", parentIssueId: candidate.id, planId: expect.any(String) },
    });
    expect(writeback.operations[1]).toMatchObject({
      kind: "comment",
      issueId: candidate.id,
      payload: { body: expect.stringContaining("TEST-2"), issueBreakdownPlanId: expect.any(String) },
    });
    expect(lifecycle?.issueBreakdownPlans[0]?.applicationStatus).toBe("applied");
    expect(lifecycle?.issueBreakdownPlans[0]?.createdIssueRefs[0]).toMatchObject({
      id: "child-1",
      identifier: "TEST-2",
      status: "created",
    });
  });

  it("leaves local planning behavior unchanged when apply is disabled", async () => {
    const config = testConfig(root);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const candidate = issue({ updatedAt: "2026-01-02T00:00:00Z" });
    const result = await new IssueBreakdownPlanApplyService({ config, lifecycleStore }).applyLatestFreshPlan(candidate);

    expect(result.status).toBe("not_required");
  });

  it("previews fresh plans without enqueueing writebacks", async () => {
    const config = testConfig(root);
    config.issueBreakdown.applyToLinear.enabled = true;
    config.writeback.enabled = true;
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const candidate = issue({ labels: ["planning"], updatedAt: "2026-01-02T00:00:00Z" });
    await new IssueBreakdownPlanService({ config, lifecycleStore }).submit_issue_breakdown_plan(
      {
        runId: "run-plan-1",
        issueId: candidate.id,
        summary: "Split into child issues.",
        proposedIssues: [
          { title: "Build child", description: "Implement.", acceptanceCriteria: ["Done"], dependencies: [], labels: [] },
        ],
        idempotencyKey: "plan-1",
      },
      { issue: candidate, activeRunId: "run-plan-1", role: "worker", phase: "issue_breakdown" },
    );
    const writeback = new CapturingWriteback();

    const result = await new IssueBreakdownPlanApplyService({ config, lifecycleStore, writeback }).previewLatestFreshPlan(candidate);
    const lifecycle = await lifecycleStore.get(candidate.id);

    expect(result.status).toBe("preview");
    expect(writeback.operations).toEqual([]);
    expect(lifecycle?.issueBreakdownPlans[0]?.applicationStatus).toBe("not_requested");
  });

  it("durably blocks unresolved dependency references before enqueueing writebacks", async () => {
    const config = testConfig(root);
    config.issueBreakdown.applyToLinear.enabled = true;
    config.writeback.enabled = true;
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const candidate = issue({ labels: ["planning"], updatedAt: "2026-01-02T00:00:00Z" });
    await new IssueBreakdownPlanService({ config, lifecycleStore }).submit_issue_breakdown_plan(
      {
        runId: "run-plan-1",
        issueId: candidate.id,
        summary: "Split into child issues.",
        proposedIssues: [
          { title: "Build child", description: "Implement.", acceptanceCriteria: ["Done"], dependencies: ["Missing"], labels: [] },
        ],
        idempotencyKey: "plan-1",
      },
      { issue: candidate, activeRunId: "run-plan-1", role: "worker", phase: "issue_breakdown" },
    );
    const writeback = new CapturingWriteback();

    const result = await new IssueBreakdownPlanApplyService({ config, lifecycleStore, writeback }).applyLatestFreshPlan(candidate);
    const lifecycle = await lifecycleStore.get(candidate.id);

    expect(result.status).toBe("blocked");
    expect(writeback.operations).toEqual([]);
    expect(lifecycle?.issueBreakdownPlans[0]?.applicationStatus).toBe("blocked");
    expect(lifecycle?.issueBreakdownPlans[0]?.applicationBlockedReason).toContain("Missing");
  });

  it("re-applies blocked dry_run writebacks live without duplicating issue creation", async () => {
    const config = testConfig(root);
    config.issueBreakdown.applyToLinear.enabled = true;
    config.writeback.enabled = true;
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const candidate = issue({ labels: ["planning"], updatedAt: "2026-01-02T00:00:00Z" });
    await new IssueBreakdownPlanService({ config, lifecycleStore }).submit_issue_breakdown_plan(
      {
        runId: "run-plan-1",
        issueId: candidate.id,
        summary: "Split into child issues.",
        proposedIssues: [
          {
            title: "Build child",
            description: "Implement the child issue.",
            acceptanceCriteria: ["Done"],
            dependencies: [],
            labels: ["planning"],
          },
        ],
        idempotencyKey: "plan-1",
      },
      { issue: candidate, activeRunId: "run-plan-1", role: "worker", phase: "issue_breakdown" },
    );

    const store = new FileWritebackOutboxStore(config.workspace.stateDir);
    const logger = new StructuredLogger(() => undefined);
    const dryRunWriter = new FakeWriter();
    const dryRunProcessor = new WritebackProcessor(
      store,
      dryRunWriter,
      logger,
      300_000,
      lifecycleStore,
      true,
      freshnessGuard(candidate, config),
    );
    const dryResult = await new IssueBreakdownPlanApplyService({
      config,
      lifecycleStore,
      writeback: dryRunProcessor,
    }).applyLatestFreshPlan(candidate);
    const lifecycleAfterDryRun = await lifecycleStore.get(candidate.id);
    const dryRunPlan = lifecycleAfterDryRun?.issueBreakdownPlans[0];
    const dryRunRecords = await store.list();
    const childRecord = dryRunRecords.find((record) => record.kind === "issue_create");

    expect(dryResult).toMatchObject({ status: "blocked", reason: "Writeback dry_run" });
    expect(dryRunPlan?.applicationStatus).toBe("blocked");
    expect(dryRunPlan?.applicationBlockedReason).toBe("Writeback dry_run");
    expect(dryRunPlan?.applicationOperationKeys).toHaveLength(1);
    expect(dryRunPlan?.applicationOperationKeys[0]).toBe(childRecord?.idempotencyKey);
    expect(dryRunPlan?.createdIssueRefs).toEqual([]);
    expect(childRecord?.status).toBe("skipped");
    expect(childRecord?.lastError).toBe("Writeback dry_run");
    expect(dryRunRecords.filter((record) => record.kind === "issue_create")).toHaveLength(1);
    expect(dryRunWriter.issueCreates).toHaveLength(0);

    const writer = new FakeWriter();
    const liveProcessor = new WritebackProcessor(
      store,
      writer,
      logger,
      300_000,
      lifecycleStore,
      false,
      freshnessGuard(candidate, config),
    );
    const liveResult = await new IssueBreakdownPlanApplyService({
      config,
      lifecycleStore,
      writeback: liveProcessor,
    }).applyLatestFreshPlan(candidate);
    const lifecycleAfterLive = await lifecycleStore.get(candidate.id);
    const liveRecords = await store.list();
    const liveChildRecord = liveRecords.find((record) => record.kind === "issue_create");
    const parentComment = liveRecords.find((record) => record.kind === "comment");

    expect(liveResult.status).toBe("applied");
    expect(liveChildRecord?.idempotencyKey).toBe(childRecord?.idempotencyKey);
    expect(liveChildRecord?.status).toBe("succeeded");
    expect(liveRecords.filter((record) => record.kind === "issue_create")).toHaveLength(1);
    expect(writer.issueCreates).toHaveLength(1);
    expect(parentComment?.status).toBe("succeeded");
    expect(writer.comments).toHaveLength(1);
    expect(writer.comments[0]?.body).toContain("TEST-2");
    expect(lifecycleAfterLive?.issueBreakdownPlans[0]?.applicationStatus).toBe("applied");
    expect(lifecycleAfterLive?.issueBreakdownPlans[0]?.createdIssueRefs[0]).toMatchObject({
      id: "child-1",
      identifier: "TEST-2",
      status: "created",
    });
  });

  it("does not mutate lifecycle when previewing a drifted pending plan", async () => {
    const config = testConfig(root);
    config.issueBreakdown.applyToLinear.enabled = true;
    config.writeback.enabled = true;
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const candidate = issue({ labels: ["planning"], title: "Original title", updatedAt: "2026-01-02T00:00:00Z" });
    const plan = await submitSingleChildPlan(config, lifecycleStore, candidate);
    const operation = planIssueBreakdownApplicationWritebacks(candidate, plan)[0]!;
    await lifecycleStore.updateIssue(candidate, {
      issueBreakdownPlans: [{ ...plan, applicationStatus: "pending", applicationOperationKeys: [operation.idempotencyKey] }],
      lastIssueBreakdownPlanId: plan.id,
    });
    const before = await lifecycleStore.get(candidate.id);
    const drifted = { ...candidate, title: "Changed title", updatedAt: "2026-01-03T00:00:00Z" };

    const result = await new IssueBreakdownPlanApplyService({ config, lifecycleStore }).previewLatestFreshPlan(drifted);
    const after = await lifecycleStore.get(candidate.id);

    expect(result.status).toBe("no_fresh_plan");
    expect(after?.issueBreakdownPlans[0]?.applicationStatus).toBe("pending");
    expect(after?.issueBreakdownPlans[0]?.applicationBlockedReason).toBeNull();
    expect(after?.issueBreakdownPlans[0]).toEqual(before?.issueBreakdownPlans[0]);
  });

  it("blocks stale pending outbox work after parent drift without tracker writes", async () => {
    const config = testConfig(root);
    config.issueBreakdown.applyToLinear.enabled = true;
    config.writeback.enabled = true;
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const candidate = issue({ labels: ["planning"], title: "Original title", updatedAt: "2026-01-02T00:00:00Z" });
    const plan = await submitSingleChildPlan(config, lifecycleStore, candidate);
    const operation = planIssueBreakdownApplicationWritebacks(candidate, plan)[0]!;
    await lifecycleStore.updateIssue(candidate, {
      issueBreakdownPlans: [{ ...plan, applicationStatus: "pending", applicationOperationKeys: [operation.idempotencyKey] }],
      lastIssueBreakdownPlanId: plan.id,
    });
    const store = new FileWritebackOutboxStore(config.workspace.stateDir);
    await store.enqueueOnce(operation);
    const drifted = { ...candidate, title: "Changed title", updatedAt: "2026-01-03T00:00:00Z" };

    const applyResult = await new IssueBreakdownPlanApplyService({ config, lifecycleStore }).applyLatestFreshPlan(drifted);
    const writer = new FakeWriter();
    await new WritebackProcessor(
      store,
      writer,
      new StructuredLogger(() => undefined),
      300_000,
      lifecycleStore,
      false,
      freshnessGuard(drifted, config),
    ).processDue();
    const lifecycle = await lifecycleStore.get(candidate.id);
    const records = await store.list();

    expect(applyResult.status).toBe("no_fresh_plan");
    expect(writer.issueCreates).toEqual([]);
    expect(writer.comments).toEqual([]);
    expect(records[0]).toMatchObject({ status: "skipped", lastError: ISSUE_BREAKDOWN_PLAN_STALE_REASON });
    expect(lifecycle?.issueBreakdownPlans[0]).toMatchObject({
      applicationStatus: "stale",
      applicationBlockedReason: ISSUE_BREAKDOWN_PLAN_STALE_REASON,
      applicationOperationKeys: [operation.idempotencyKey],
      createdIssueRefs: [],
    });
  });
});

class CapturingWriteback implements Pick<WritebackProcessorType, "enqueueAndProcess"> {
  readonly operations: NewWritebackOperation[] = [];

  async enqueueAndProcess(operation: NewWritebackOperation): Promise<WritebackOperation> {
    this.operations.push(operation);
    if (operation.kind !== "issue_create") {
      return {
        ...operation,
        status: "succeeded",
        attempt: 0,
        createdAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        nextAttemptAt: "2026-01-02T00:00:00.000Z",
        lastError: null,
        resultStatus: "applied",
        resultMessage: null,
        resultEvidence: null,
      };
    }
    return {
      ...operation,
      status: "succeeded",
      attempt: 0,
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      nextAttemptAt: "2026-01-02T00:00:00.000Z",
      lastError: null,
      resultStatus: "applied",
      resultMessage: null,
      resultEvidence: {
        kind: "issue_create",
        issue: { id: "child-1", identifier: "TEST-2", url: "https://linear.test/TEST-2" },
        issueCreateStatus: "created",
        parentIssueId: operation.payload.parentIssueId,
        dedupeKey: operation.payload.dedupeKey,
        payloadHash: operation.payload.payloadHash,
        unresolvedLabelNames: [],
      },
    };
  }
}

class FakeWriter implements TrackerWriter {
  readonly transitions: TrackerTransitionInput[] = [];
  readonly comments: TrackerCommentInput[] = [];
  readonly issueCreates: TrackerIssueCreateInput[] = [];

  async transitionIssueState(input: TrackerTransitionInput): Promise<TrackerWriteResult> {
    this.transitions.push(input);
    return { status: "applied" };
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
}

async function submitSingleChildPlan(config: ServiceConfig, lifecycleStore: FileIssueLifecycleStore, candidate: Issue) {
  const result = await new IssueBreakdownPlanService({ config, lifecycleStore }).submit_issue_breakdown_plan(
    {
      runId: "run-plan-1",
      issueId: candidate.id,
      summary: "Split into child issues.",
      proposedIssues: [
        {
          title: "Build child",
          description: "Implement the child issue.",
          acceptanceCriteria: ["Done"],
          dependencies: [],
          labels: ["planning"],
        },
      ],
      idempotencyKey: "plan-1",
    },
    { issue: candidate, activeRunId: "run-plan-1", role: "worker", phase: "issue_breakdown" },
  );
  return result.plan;
}

function freshnessGuard(parentIssue: Issue, config: ServiceConfig) {
  return {
    getConfig: () => config,
    resolveIssue: async () => ({ status: "ok" as const, issue: parentIssue }),
  };
}

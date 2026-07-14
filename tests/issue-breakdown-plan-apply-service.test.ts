import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import {
  IssueBreakdownPlanApplyService,
  planIssueBreakdownApplicationWritebacks,
  planIssueBreakdownFinalizationWritebacks,
} from "../src/core/IssueBreakdownPlanApplyService.js";
import { IssueBreakdownPlanService, issueBreakdownPlanRequestHash } from "../src/core/IssueBreakdownPlanService.js";
import { FileIssueLifecycleStore } from "../src/core/persistence/IssueLifecycleStore.js";
import type { IssueBreakdownCreatedIssueRef } from "../src/core/persistence/IssueLifecycleStore.js";
import type {
  TrackerCommentInput,
  TrackerIssueCreateInput,
  TrackerIssueRelationInput,
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
import { agentEligibleIssueContract, issue, testConfig } from "./helpers.js";

type IssueCreateWriteback = Extract<NewWritebackOperation, { kind: "issue_create" }>;

describe("IssueBreakdownPlanApplyService", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-breakdown-apply-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("refuses direct application of a plan for an accepted expected-red artifact", async () => {
    const config = testConfig(root);
    config.issueBreakdown.applyToLinear.enabled = true;
    config.writeback.enabled = true;
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const candidate = issue({
      labels: ["planning"],
      description: agentEligibleIssueContract({
        issueContractDelivery: {
          mode: "accepted_artifact",
          artifact: "expected_red_tests",
        },
      }),
      updatedAt: "2026-01-02T00:00:00Z",
    });
    await submitSingleChildPlan(config, lifecycleStore, candidate);
    const writeback = new CapturingWriteback();
    const service = new IssueBreakdownPlanApplyService({
      config,
      lifecycleStore,
      writeback,
    });

    await expect(service.previewLatestFreshPlan(candidate)).resolves.toEqual({
      status: "no_fresh_plan",
      reason: "accepted_artifact_contract_cannot_be_decomposed",
    });
    await expect(service.applyLatestFreshPlan(candidate)).resolves.toEqual({
      status: "no_fresh_plan",
      reason: "accepted_artifact_contract_cannot_be_decomposed",
    });
    expect(writeback.operations).toHaveLength(0);
    await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
      issueBreakdownPlans: [
        expect.objectContaining({ applicationStatus: "not_requested" }),
      ],
    });
  });

  it("applies fresh accepted plans through idempotent issue create writebacks", async () => {
    const config = testConfig(root);
    config.issueBreakdown.applyToLinear.enabled = true;
    config.writeback.enabled = true;
    config.reviewLoop.reviewStates = ["In Review"];
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
            description: agentEligibleIssueContract(),
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
      kind: "issue_relation",
      issueId: candidate.id,
      payload: { sourceIssueId: "child-1", targetIssueId: candidate.id, type: "blocks" },
    });
    expect(writeback.operations.find((operation) => operation.kind === "comment")).toMatchObject({
      kind: "comment",
      issueId: candidate.id,
      payload: { body: expect.stringContaining("TEST-2"), issueBreakdownPlanId: expect.any(String) },
    });
    expect(writeback.operations.find((operation) => operation.kind === "transition")).toMatchObject({
      kind: "transition",
      issueId: candidate.id,
      payload: { toState: "In Review", issueBreakdownPlanId: expect.any(String) },
    });
    expect(lifecycle?.issueBreakdownPlans[0]?.applicationStatus).toBe("applied");
    expect(lifecycle?.issueBreakdownPlans[0]?.createdIssueRefs[0]).toMatchObject({
      id: "child-1",
      identifier: "TEST-2",
      status: "created",
    });
  });

  it("keeps a plan fresh while its own child blocker relations are applied", async () => {
    const config = testConfig(root);
    config.issueBreakdown.applyToLinear.enabled = true;
    config.writeback.enabled = true;
    config.reviewLoop.reviewStates = ["In Review"];
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const candidate = issue({ labels: ["planning"], updatedAt: "2026-01-02T00:00:00Z" });
    await submitTwoChildPlan(config, lifecycleStore, candidate);
    let liveIssue = candidate;
    const writer = new FakeWriter();
    const mutatingWriter = trackerWriterWithRelationEffect(writer, (input) => {
      if (input.targetIssueId !== candidate.id) return;
      liveIssue = {
        ...liveIssue,
        blockedBy: [
          ...liveIssue.blockedBy,
          { id: input.sourceIssueId, identifier: null, state: "Backlog" },
        ],
      };
    });
    const store = new FileWritebackOutboxStore(config.workspace.stateDir);
    const processor = new WritebackProcessor(
      store,
      mutatingWriter,
      new StructuredLogger(() => undefined),
      300_000,
      lifecycleStore,
      false,
      dynamicFreshnessGuard(() => liveIssue, config),
    );

    const result = await new IssueBreakdownPlanApplyService({ config, lifecycleStore, writeback: processor }).applyLatestFreshPlan(
      candidate,
    );
    const lifecycle = await lifecycleStore.get(candidate.id);
    const records = await store.list();

    expect(result.status).toBe("applied");
    expect(lifecycle?.issueBreakdownPlans[0]?.applicationStatus).toBe("applied");
    expect(writer.issueCreates).toHaveLength(2);
    expect(writer.issueRelations).toHaveLength(3);
    expect(writer.comments).toHaveLength(1);
    expect(writer.transitions).toHaveLength(1);
    expect(records.every((record) => record.status === "succeeded")).toBe(true);
  });

  it("blocks all remaining finalization writes including transition after external parent drift", async () => {
    const config = testConfig(root);
    config.issueBreakdown.applyToLinear.enabled = true;
    config.writeback.enabled = true;
    config.reviewLoop.reviewStates = ["In Review"];
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const candidate = issue({ labels: ["planning"], updatedAt: "2026-01-02T00:00:00Z" });
    await submitTwoChildPlan(config, lifecycleStore, candidate);
    let liveIssue = candidate;
    let relationWrites = 0;
    const writer = new FakeWriter();
    const mutatingWriter = trackerWriterWithRelationEffect(writer, () => {
      relationWrites += 1;
      if (relationWrites !== 1) return;
      liveIssue = {
        ...liveIssue,
        blockedBy: [
          ...liveIssue.blockedBy,
          { id: "external-blocker", identifier: "TEST-99", state: "In Progress" },
        ],
      };
    });
    const store = new FileWritebackOutboxStore(config.workspace.stateDir);
    const processor = new WritebackProcessor(
      store,
      mutatingWriter,
      new StructuredLogger(() => undefined),
      300_000,
      lifecycleStore,
      false,
      dynamicFreshnessGuard(() => liveIssue, config),
    );

    const result = await new IssueBreakdownPlanApplyService({ config, lifecycleStore, writeback: processor }).applyLatestFreshPlan(
      candidate,
    );
    const records = await store.list();

    expect(result).toMatchObject({ status: "blocked", reason: ISSUE_BREAKDOWN_PLAN_STALE_REASON });
    expect(writer.issueRelations).toHaveLength(1);
    expect(writer.comments).toHaveLength(0);
    expect(writer.transitions).toHaveLength(0);
    expect(records.find((record) => record.kind === "transition")).toMatchObject({
      status: "skipped",
      lastError: ISSUE_BREAKDOWN_PLAN_STALE_REASON,
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
          { title: "Build child", description: agentEligibleIssueContract(), acceptanceCriteria: ["Done"], dependencies: [], labels: [] },
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

  it("does not apply a superseded plan even when its fingerprints match", async () => {
    const config = testConfig(root);
    config.issueBreakdown.applyToLinear.enabled = true;
    config.writeback.enabled = true;
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const original = issue({ labels: ["planning"], title: "Original title", updatedAt: "2026-01-02T00:00:00Z" });
    const changed = issue({ ...original, title: "Changed title", updatedAt: "2026-01-02T00:05:00Z" });
    const planA = await submitSingleChildPlan(config, lifecycleStore, original, {
      idempotencyKey: "plan-a",
      runId: "run-plan-a",
    });
    const planB = await submitSingleChildPlan(config, lifecycleStore, changed, {
      idempotencyKey: "plan-b",
      runId: "run-plan-b",
    });
    const seeded = await lifecycleStore.get(original.id);
    await lifecycleStore.updateIssue(changed, {
      issueBreakdownPlans:
        seeded?.issueBreakdownPlans.map((plan) => (plan.id === planA.id ? { ...plan, applicationStatus: "pending" } : plan)) ?? [],
      lastIssueBreakdownPlanId: planB.id,
    });
    const writeback = new CapturingWriteback();

    const result = await new IssueBreakdownPlanApplyService({ config, lifecycleStore, writeback }).applyLatestFreshPlan(original);
    const lifecycle = await lifecycleStore.get(original.id);

    expect(result).toMatchObject({ status: "no_fresh_plan", reason: "no_fresh_plan" });
    expect(writeback.operations).toEqual([]);
    expect(lifecycle?.lastIssueBreakdownPlanId).toBe(planB.id);
    expect(lifecycle?.issueBreakdownPlans.find((plan) => plan.id === planA.id)?.applicationStatus).toBe("pending");
  });

  it("does not mutate lifecycle when previewing a current plan with a superseded pending plan", async () => {
    const config = testConfig(root);
    config.issueBreakdown.applyToLinear.enabled = true;
    config.writeback.enabled = true;
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const candidate = issue({ labels: ["planning"], updatedAt: "2026-01-02T00:00:00Z" });
    const planA = await submitSingleChildPlan(config, lifecycleStore, candidate, {
      idempotencyKey: "plan-a",
      runId: "run-plan-a",
    });
    const planB = await submitSingleChildPlan(config, lifecycleStore, candidate, {
      idempotencyKey: "plan-b",
      runId: "run-plan-b",
    });
    const seeded = await lifecycleStore.get(candidate.id);
    await lifecycleStore.updateIssue(candidate, {
      issueBreakdownPlans:
        seeded?.issueBreakdownPlans.map((plan) => (plan.id === planA.id ? { ...plan, applicationStatus: "pending" } : plan)) ?? [],
      lastIssueBreakdownPlanId: planB.id,
    });
    const before = await lifecycleStore.get(candidate.id);

    const result = await new IssueBreakdownPlanApplyService({ config, lifecycleStore }).previewLatestFreshPlan(candidate);
    const after = await lifecycleStore.get(candidate.id);

    expect(result).toMatchObject({ status: "preview", plan: { id: planB.id } });
    expect(after?.issueBreakdownPlans).toEqual(before?.issueBreakdownPlans);
    expect(after?.lastIssueBreakdownPlanId).toBe(planB.id);
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
          { title: "Build child", description: agentEligibleIssueContract(), acceptanceCriteria: ["Done"], dependencies: ["Missing"], labels: [] },
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
            description: agentEligibleIssueContract(),
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

  it("returns no_fresh_plan when previewing a legacy plan that fails current proposed-issue validation", async () => {
    const config = testConfig(root);
    config.issueBreakdown.applyToLinear.enabled = true;
    config.writeback.enabled = true;
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const candidate = issue({ labels: ["planning"], updatedAt: "2026-01-02T00:00:00Z" });
    await seedLegacyValidationDriftPlan(config, lifecycleStore, candidate);
    const before = await lifecycleStore.get(candidate.id);

    const result = await new IssueBreakdownPlanApplyService({ config, lifecycleStore }).previewLatestFreshPlan(candidate);
    const after = await lifecycleStore.get(candidate.id);

    expect(result).toMatchObject({ status: "no_fresh_plan", reason: "no_fresh_plan" });
    expect(after?.issueBreakdownPlans).toEqual(before?.issueBreakdownPlans);
    expect(after?.lastIssueBreakdownPlanId).toBe(before?.lastIssueBreakdownPlanId ?? null);
  });

  it("marks pending legacy plans stale when live apply encounters validation drift", async () => {
    const config = testConfig(root);
    config.issueBreakdown.applyToLinear.enabled = true;
    config.writeback.enabled = true;
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const candidate = issue({ labels: ["planning"], updatedAt: "2026-01-02T00:00:00Z" });
    const seeded = await seedLegacyValidationDriftPlan(config, lifecycleStore, candidate);
    const operation = planIssueBreakdownApplicationWritebacks(candidate, seeded.plan)[0]!;
    await lifecycleStore.updateIssue(candidate, {
      issueBreakdownPlans: [
        {
          ...seeded.plan,
          applicationStatus: "pending",
          applicationOperationKeys: [operation.idempotencyKey],
          applicationBlockedReason: null,
        },
      ],
      lastIssueBreakdownPlanId: seeded.plan.id,
    });

    const result = await new IssueBreakdownPlanApplyService({ config, lifecycleStore }).applyLatestFreshPlan(candidate);
    const lifecycle = await lifecycleStore.get(candidate.id);

    expect(result).toMatchObject({ status: "no_fresh_plan", reason: ISSUE_BREAKDOWN_PLAN_STALE_REASON });
    expect(lifecycle?.issueBreakdownPlans[0]).toMatchObject({
      applicationStatus: "stale",
      applicationBlockedReason: ISSUE_BREAKDOWN_PLAN_STALE_REASON,
      applicationOperationKeys: [operation.idempotencyKey],
    });
  });

  it("preserves a null current plan pointer when marking drifted legacy work stale", async () => {
    const config = testConfig(root);
    config.issueBreakdown.applyToLinear.enabled = true;
    config.writeback.enabled = true;
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const original = issue({ labels: ["planning"], title: "Original title", updatedAt: "2026-01-02T00:00:00Z" });
    const plan = await submitSingleChildPlan(config, lifecycleStore, original);
    const operation = planIssueBreakdownApplicationWritebacks(original, plan)[0]!;
    await lifecycleStore.updateIssue(original, {
      issueBreakdownPlans: [{ ...plan, applicationStatus: "pending", applicationOperationKeys: [operation.idempotencyKey] }],
      lastIssueBreakdownPlanId: null,
    });
    const drifted = { ...original, title: "Changed title", updatedAt: "2026-01-03T00:00:00Z" };

    const result = await new IssueBreakdownPlanApplyService({ config, lifecycleStore }).applyLatestFreshPlan(drifted);
    const lifecycle = await lifecycleStore.get(original.id);

    expect(result).toMatchObject({ status: "no_fresh_plan", reason: ISSUE_BREAKDOWN_PLAN_STALE_REASON });
    expect(lifecycle?.lastIssueBreakdownPlanId).toBeNull();
    expect(lifecycle?.issueBreakdownPlans[0]).toMatchObject({
      applicationStatus: "stale",
      applicationBlockedReason: ISSUE_BREAKDOWN_PLAN_STALE_REASON,
    });
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

    expect(applyResult).toMatchObject({ status: "no_fresh_plan", reason: ISSUE_BREAKDOWN_PLAN_STALE_REASON });
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

  it("recovers stale-skipped child writebacks on a fresh live apply without duplicating succeeded children", async () => {
    const config = testConfig(root);
    config.issueBreakdown.applyToLinear.enabled = true;
    config.writeback.enabled = true;
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const candidate = issue({ labels: ["planning"], updatedAt: "2026-01-02T00:00:00Z" });
    const plan = await submitTwoChildPlan(config, lifecycleStore, candidate);
    const childOperations = planIssueBreakdownApplicationWritebacks(candidate, plan) as IssueCreateWriteback[];
    const firstChild = childOperations[0]!;
    const secondChild = childOperations[1]!;
    await lifecycleStore.updateIssue(candidate, {
      issueBreakdownPlans: [
        {
          ...plan,
          applicationStatus: "pending",
          applicationOperationKeys: childOperations.map((operation) => operation.idempotencyKey),
          createdIssueRefs: [createdIssueRef(firstChild)],
        },
      ],
      lastIssueBreakdownPlanId: plan.id,
    });
    const store = new FileWritebackOutboxStore(config.workspace.stateDir);
    await store.markSucceeded(await store.enqueueOnce(firstChild), issueCreateResult(firstChild));
    await store.markSkipped(await store.enqueueOnce(secondChild), ISSUE_BREAKDOWN_PLAN_STALE_REASON);
    const writer = new FakeWriter();
    const processor = new WritebackProcessor(
      store,
      writer,
      new StructuredLogger(() => undefined),
      300_000,
      lifecycleStore,
      false,
      freshnessGuard(candidate, config),
    );

    const result = await new IssueBreakdownPlanApplyService({ config, lifecycleStore, writeback: processor }).applyLatestFreshPlan(
      candidate,
    );
    const records = await store.list();
    const lifecycle = await lifecycleStore.get(candidate.id);

    expect(result.status).toBe("applied");
    expect(writer.issueCreates).toHaveLength(1);
    expect(writer.issueCreates[0]?.title).toBe("Build dependent child");
    expect(writer.issueRelations).toHaveLength(3);
    expect(writer.issueRelations.filter((relation) => relation.targetIssueId === candidate.id)).toHaveLength(2);
    expect(writer.issueRelations.some((relation) => relation.targetIssueId !== candidate.id)).toBe(true);
    expect(writer.comments).toHaveLength(1);
    expect(records.filter((record) => record.kind === "issue_create")).toHaveLength(2);
    await expect(store.get(firstChild.idempotencyKey)).resolves.toMatchObject({ status: "succeeded" });
    await expect(store.get(secondChild.idempotencyKey)).resolves.toMatchObject({ status: "succeeded" });
    expect(lifecycle?.issueBreakdownPlans[0]?.applicationStatus).toBe("applied");
    expect(lifecycle?.issueBreakdownPlans[0]?.createdIssueRefs).toHaveLength(2);
  });

  it("recovers stale-skipped relation and parent comment writebacks after child refs are durable", async () => {
    const config = testConfig(root);
    config.issueBreakdown.applyToLinear.enabled = true;
    config.writeback.enabled = true;
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const candidate = issue({ labels: ["planning"], updatedAt: "2026-01-02T00:00:00Z" });
    const plan = await submitTwoChildPlan(config, lifecycleStore, candidate);
    const childOperations = planIssueBreakdownApplicationWritebacks(candidate, plan) as IssueCreateWriteback[];
    const planWithRefs = {
      ...plan,
      createdIssueRefs: childOperations.map((operation) => createdIssueRef(operation)),
    };
    const finalOperations = planIssueBreakdownFinalizationWritebacks(candidate, planWithRefs);
    await lifecycleStore.updateIssue(candidate, {
      issueBreakdownPlans: [
        {
          ...planWithRefs,
          applicationStatus: "pending",
          applicationOperationKeys: [
            ...childOperations.map((operation) => operation.idempotencyKey),
            ...finalOperations.map((operation) => operation.idempotencyKey),
          ],
        },
      ],
      lastIssueBreakdownPlanId: plan.id,
    });
    const store = new FileWritebackOutboxStore(config.workspace.stateDir);
    for (const operation of childOperations) {
      await store.markSucceeded(await store.enqueueOnce(operation), issueCreateResult(operation));
    }
    for (const operation of finalOperations) {
      await store.markSkipped(await store.enqueueOnce(operation), ISSUE_BREAKDOWN_PLAN_STALE_REASON);
    }
    const writer = new FakeWriter();
    const processor = new WritebackProcessor(
      store,
      writer,
      new StructuredLogger(() => undefined),
      300_000,
      lifecycleStore,
      false,
      freshnessGuard(candidate, config),
    );

    const result = await new IssueBreakdownPlanApplyService({ config, lifecycleStore, writeback: processor }).applyLatestFreshPlan(
      candidate,
    );
    const lifecycle = await lifecycleStore.get(candidate.id);

    expect(result.status).toBe("applied");
    expect(writer.issueCreates).toHaveLength(0);
    expect(writer.issueRelations).toHaveLength(3);
    expect(writer.issueRelations.filter((relation) => relation.targetIssueId === candidate.id)).toHaveLength(2);
    expect(writer.issueRelations.some((relation) => relation.targetIssueId !== candidate.id)).toBe(true);
    expect(writer.comments).toHaveLength(1);
    for (const operation of finalOperations) {
      await expect(store.get(operation.idempotencyKey)).resolves.toMatchObject({ status: "succeeded" });
    }
    expect(lifecycle?.issueBreakdownPlans[0]?.applicationStatus).toBe("applied");
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
  readonly issueRelations: TrackerIssueRelationInput[] = [];

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
    const childNumber = (input.proposedIssueIndex ?? this.issueCreates.length - 1) + 1;
    return {
      status: "applied",
      evidence: {
        kind: "issue_create",
        issue: { id: `child-${childNumber}`, identifier: `TEST-${childNumber + 1}`, url: `https://linear.test/TEST-${childNumber + 1}` },
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

async function submitSingleChildPlan(
  config: ServiceConfig,
  lifecycleStore: FileIssueLifecycleStore,
  candidate: Issue,
  options: { idempotencyKey?: string; runId?: string } = {},
) {
  const runId = options.runId ?? "run-plan-1";
  const result = await new IssueBreakdownPlanService({ config, lifecycleStore }).submit_issue_breakdown_plan(
    {
      runId,
      issueId: candidate.id,
      summary: "Split into child issues.",
      proposedIssues: [
        {
          title: "Build child",
          description: agentEligibleIssueContract(),
          acceptanceCriteria: ["Done"],
          dependencies: [],
          labels: ["planning"],
        },
      ],
      idempotencyKey: options.idempotencyKey ?? "plan-1",
    },
    { issue: candidate, activeRunId: runId, role: "worker", phase: "issue_breakdown" },
  );
  return result.plan;
}

async function seedLegacyValidationDriftPlan(
  config: ServiceConfig,
  lifecycleStore: FileIssueLifecycleStore,
  candidate: Issue,
) {
  const runId = "run-plan-validation-drift";
  const idempotencyKey = "plan-validation-drift";
  const plan = await submitSingleChildPlan(config, lifecycleStore, candidate, { runId, idempotencyKey });
  const legacyInput = {
    runId,
    issueId: candidate.id,
    summary: "Split into child issues.",
    proposedIssues: [
      {
        title: "Build child",
        description: ["## Problem / Goal", "Legacy proposal missing current contract headings."].join("\n"),
        acceptanceCriteria: ["Done"],
        dependencies: [],
        labels: ["planning"],
      },
    ],
    idempotencyKey,
  };
  const lifecycle = await lifecycleStore.get(candidate.id);
  const updatedPlan = {
    ...plan,
    requestHash: issueBreakdownPlanRequestHash(legacyInput),
    proposedIssues: legacyInput.proposedIssues,
  };
  await lifecycleStore.updateIssue(candidate, {
    issueBreakdownPlans:
      lifecycle?.issueBreakdownPlans.map((existingPlan) =>
        existingPlan.id === plan.id ? updatedPlan : existingPlan,
      ) ?? [],
    lastIssueBreakdownPlanId: plan.id,
  });
  return { plan: updatedPlan, legacyInput };
}

async function submitTwoChildPlan(config: ServiceConfig, lifecycleStore: FileIssueLifecycleStore, candidate: Issue) {
  const result = await new IssueBreakdownPlanService({ config, lifecycleStore }).submit_issue_breakdown_plan(
    {
      runId: "run-plan-1",
      issueId: candidate.id,
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
      idempotencyKey: "plan-1",
    },
    { issue: candidate, activeRunId: "run-plan-1", role: "worker", phase: "issue_breakdown" },
  );
  return result.plan;
}

function createdIssueRef(operation: IssueCreateWriteback): IssueBreakdownCreatedIssueRef {
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

function issueCreateResult(operation: IssueCreateWriteback): TrackerWriteResult {
  const ref = createdIssueRef(operation);
  return {
    status: "applied",
    evidence: {
      kind: "issue_create",
      issue: { id: ref.id, identifier: ref.identifier, url: ref.url },
      issueCreateStatus: ref.status,
      parentIssueId: operation.payload.parentIssueId,
      dedupeKey: operation.payload.dedupeKey,
      payloadHash: operation.payload.payloadHash,
      unresolvedLabelNames: [],
    },
  };
}

function trackerWriterWithRelationEffect(
  writer: FakeWriter,
  onRelation: (input: TrackerIssueRelationInput) => void,
): TrackerWriter {
  return {
    transitionIssueState: (input) => writer.transitionIssueState(input),
    createIssueComment: (input) => writer.createIssueComment(input),
    createIssueFromPlan: (input) => writer.createIssueFromPlan(input),
    createIssueRelation: async (input) => {
      const result = await writer.createIssueRelation(input);
      onRelation(input);
      return result;
    },
  };
}

function dynamicFreshnessGuard(resolve: () => Issue, config: ServiceConfig) {
  return {
    getConfig: () => config,
    resolveIssue: async () => ({ status: "ok" as const, issue: resolve() }),
  };
}

function freshnessGuard(parentIssue: Issue, config: ServiceConfig) {
  return {
    getConfig: () => config,
    resolveIssue: async () => ({ status: "ok" as const, issue: parentIssue }),
  };
}

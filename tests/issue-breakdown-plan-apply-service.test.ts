import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import {
  ISSUE_BREAKDOWN_TRIAGE_PROVENANCE_INVALID_REASON,
  IssueBreakdownPlanApplyService,
  planIssueBreakdownApplicationWritebacks,
  planIssueBreakdownDispositionWriteback,
  planIssueBreakdownFinalizationWritebacks,
} from "../src/core/IssueBreakdownPlanApplyService.js";
import { IssueBreakdownPlanService, issueBreakdownPlanRequestHash } from "../src/core/IssueBreakdownPlanService.js";
import { parseIssueContract } from "../src/core/IssueContractLint.js";
import { issueTriageTriggerFingerprint } from "../src/core/IssueTriageService.js";
import { FileIssueLifecycleStore } from "../src/core/persistence/IssueLifecycleStore.js";
import type {
  IssueBreakdownCreatedIssueRef,
  IssueTriageReportRecord,
} from "../src/core/persistence/IssueLifecycleStore.js";
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
import {
  agentEligibleIssueContract,
  issue as baseIssue,
  testConfig,
} from "./helpers.js";

type IssueCreateWriteback = Extract<NewWritebackOperation, { kind: "issue_create" }>;
type IssueContractRelationshipsInput = NonNullable<
  NonNullable<
    Parameters<typeof agentEligibleIssueContract>[0]
  >["issueContractRelationships"]
>;
type IssueContractSuccessionInput = NonNullable<
  IssueContractRelationshipsInput["succession"]
>;

const FINAL_DISPOSITION =
  "Created a bounded implementation child with an explicit contract and validation plan.\n\nNo proposed issue, dependency, or planning caveat has been omitted.";
const FULL_FINAL_DISPOSITION = [
  FINAL_DISPOSITION,
  "",
  ...Array.from(
    { length: 300 },
    (_, index) => `Evidence ${index + 1}: the complete proposed scope and dependency analysis is preserved verbatim.`,
  ),
].join("\n");

function issue(overrides: Partial<Issue> = {}): Issue {
  return baseIssue({
    description: agentEligibleIssueContract(),
    ...overrides,
  });
}

function proposedIssueContract(
  parentIdentifier: string,
  options: {
    dependentTitles?: string[];
    dependencyTitles?: string[];
    expectedRed?: boolean;
    succession?: IssueContractSuccessionInput;
  } = {},
): string {
  return agentEligibleIssueContract({
    ...(options.expectedRed === true
      ? {
          issueContractDelivery: {
            mode: "accepted_artifact" as const,
            artifact: "expected_red_tests" as const,
          },
        }
      : {}),
    issueContractRelationships: {
      blocks: [
        parentIdentifier,
        ...(options.dependentTitles ?? []),
      ],
      blockedBy: [...(options.dependencyTitles ?? [])],
      ...(options.succession === undefined
        ? {}
        : { succession: options.succession }),
    },
  });
}

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
    expect(writeback.operations).toHaveLength(1);
    expect(writeback.operations[0]?.kind).toBe("comment");
    expectExactDisposition(commentBody(writeback.operations[0]!), FINAL_DISPOSITION);
    await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
      issueBreakdownPlans: [
        expect.objectContaining({ applicationStatus: "not_requested" }),
      ],
    });
  });

  it.each([
    {
      name: "the source report was cleared before initial application",
      mutate: (report: IssueTriageReportRecord) => ({
        report,
        lastIssueTriageReportId: null,
      }),
    },
    {
      name: "the source report is no longer current",
      mutate: (report: IssueTriageReportRecord) => ({
        report,
        lastIssueTriageReportId: "issue-triage-report:issue-1:newer-report",
      }),
    },
    {
      name: "the source report belongs to an older trigger",
      mutate: (report: IssueTriageReportRecord) => ({
        report: { ...report, triggerFingerprint: "stale-trigger" },
        lastIssueTriageReportId: report.id,
      }),
    },
    {
      name: "the recovery route is not an automated planner route",
      mutate: (report: IssueTriageReportRecord) => ({
        report: {
          ...report,
          recoveryDisposition: {
            ...report.recoveryDisposition!,
            nextActor: "worker" as const,
          },
        },
        lastIssueTriageReportId: report.id,
      }),
    },
    {
      name: "the recovery transition has not succeeded",
      mutate: (report: IssueTriageReportRecord) => ({
        report: {
          ...report,
          recoveryDisposition: {
            ...report.recoveryDisposition!,
            transitionStatus: "pending" as const,
          },
        },
        lastIssueTriageReportId: report.id,
      }),
    },
  ])(
    "blocks a triage-linked plan before writeback when $name",
    async ({ mutate }) => {
      const config = testConfig(root);
      config.issueBreakdown.applyToLinear.enabled = true;
      config.writeback.enabled = true;
      config.writeback.dispatchState = "In Progress";
      const lifecycleStore = new FileIssueLifecycleStore(
        config.workspace.stateDir,
      );
      const candidate = issue({
        state: "In Progress",
        labels: ["planning"],
        updatedAt: "2026-01-02T00:00:00Z",
      });
      const report = await seedAutomatedPlannerTriageReport(
        lifecycleStore,
        candidate,
      );
      await submitSingleChildPlan(config, lifecycleStore, candidate, {
        sourceIssueTriageReportId: report.id,
      });
      const mutated = mutate(report);
      const lifecycle = await lifecycleStore.get(candidate.id);
      await lifecycleStore.updateIssue(candidate, {
        lastIssueTriageReportId: mutated.lastIssueTriageReportId,
        issueTriageReports: (lifecycle?.issueTriageReports ?? []).map(
          (existing) => (existing.id === report.id ? mutated.report : existing),
        ),
      });
      const writeback = new CapturingWriteback();

      const result = await new IssueBreakdownPlanApplyService({
        config,
        lifecycleStore,
        writeback,
      }).applyLatestFreshPlan(candidate);

      expect(result).toMatchObject({
        status: "blocked",
        reason: ISSUE_BREAKDOWN_TRIAGE_PROVENANCE_INVALID_REASON,
        operations: [],
      });
      expect(writeback.operations).toEqual([]);
      await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
        issueBreakdownPlans: [
          expect.objectContaining({
            sourceIssueTriageReportId: report.id,
            applicationStatus: "blocked",
            applicationBlockedReason:
              ISSUE_BREAKDOWN_TRIAGE_PROVENANCE_INVALID_REASON,
          }),
        ],
      });
    },
  );

  it("applies a triage-linked plan only after its exact automated planner route succeeds", async () => {
    const config = testConfig(root);
    config.issueBreakdown.applyToLinear.enabled = true;
    config.writeback.enabled = true;
    config.writeback.dispatchState = "In Progress";
    const lifecycleStore = new FileIssueLifecycleStore(
      config.workspace.stateDir,
    );
    const candidate = issue({
      state: "In Progress",
      labels: ["planning"],
      updatedAt: "2026-01-02T00:00:00Z",
    });
    const report = await seedAutomatedPlannerTriageReport(
      lifecycleStore,
      candidate,
    );
    await submitSingleChildPlan(config, lifecycleStore, candidate, {
      sourceIssueTriageReportId: report.id,
    });
    const writeback = new CapturingWriteback();

    const result = await new IssueBreakdownPlanApplyService({
      config,
      lifecycleStore,
      writeback,
    }).applyLatestFreshPlan(candidate);

    expect(result.status).toBe("applied");
    expect(writeback.operations.length).toBeGreaterThan(0);
    await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
      issueBreakdownPlans: [
        expect.objectContaining({
          sourceIssueTriageReportId: report.id,
          applicationStatus: "applied",
        }),
      ],
    });
  });

  it("reconciles an applied triage-linked plan after its parent reaches review", async () => {
    const config = testConfig(root);
    config.issueBreakdown.applyToLinear.enabled = true;
    config.writeback.enabled = true;
    config.writeback.dispatchState = "In Progress";
    config.reviewLoop.reviewStates = ["In Review"];
    const lifecycleStore = new FileIssueLifecycleStore(
      config.workspace.stateDir,
    );
    const candidate = issue({
      state: "In Progress",
      labels: ["planning"],
      updatedAt: "2026-01-02T00:00:00Z",
    });
    const report = await seedAutomatedPlannerTriageReport(
      lifecycleStore,
      candidate,
    );
    await submitSingleChildPlan(config, lifecycleStore, candidate, {
      sourceIssueTriageReportId: report.id,
    });
    const writeback = new CapturingWriteback();
    const service = new IssueBreakdownPlanApplyService({
      config,
      lifecycleStore,
      writeback,
    });
    await expect(service.applyLatestFreshPlan(candidate)).resolves.toMatchObject({
      status: "applied",
    });
    const operationCount = writeback.operations.length;

    await expect(
      service.applyLatestFreshPlan({ ...candidate, state: "In Review" }),
    ).resolves.toMatchObject({ status: "applied" });

    expect(writeback.operations).toHaveLength(operationCount);
    await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
      issueBreakdownPlans: [
        expect.objectContaining({
          sourceIssueTriageReportId: report.id,
          applicationStatus: "applied",
          applicationBlockedReason: null,
        }),
      ],
    });
  });

  it("reconciles an applied triage-linked plan after its source report is consumed", async () => {
    const config = testConfig(root);
    config.issueBreakdown.applyToLinear.enabled = true;
    config.writeback.enabled = true;
    config.writeback.dispatchState = "In Progress";
    config.reviewLoop.reviewStates = ["In Review"];
    const lifecycleStore = new FileIssueLifecycleStore(
      config.workspace.stateDir,
    );
    const candidate = issue({
      state: "In Progress",
      labels: ["planning"],
      updatedAt: "2026-01-02T00:00:00Z",
    });
    const report = await seedAutomatedPlannerTriageReport(
      lifecycleStore,
      candidate,
    );
    await submitSingleChildPlan(config, lifecycleStore, candidate, {
      sourceIssueTriageReportId: report.id,
    });
    const writeback = new CapturingWriteback();
    const service = new IssueBreakdownPlanApplyService({
      config,
      lifecycleStore,
      writeback,
    });
    await expect(service.applyLatestFreshPlan(candidate)).resolves.toMatchObject({
      status: "applied",
    });
    const operationCount = writeback.operations.length;
    await lifecycleStore.updateIssue(candidate, {
      phase: "review",
      reviewRound: 0,
      incompleteTurnCount: 0,
      blockedReason: null,
      lastIssueTriageReportId: null,
    });

    await expect(
      service.applyLatestFreshPlan({ ...candidate, state: "In Progress" }),
    ).resolves.toMatchObject({ status: "applied" });

    expect(writeback.operations).toHaveLength(operationCount);
    await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
      lastIssueTriageReportId: null,
      issueBreakdownPlans: [
        expect.objectContaining({
          sourceIssueTriageReportId: report.id,
          applicationStatus: "applied",
          applicationBlockedReason: null,
        }),
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
        finalDisposition: FINAL_DISPOSITION,
        summary: "Split into child issues.",
        proposedIssues: [
          {
            title: "Build child",
            description: proposedIssueContract(candidate.identifier),
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
      kind: "comment",
      issueId: candidate.id,
      payload: { issueBreakdownPlanId: expect.any(String) },
    });
    expectExactDisposition(commentBody(writeback.operations[0]!), FINAL_DISPOSITION);
    expect(writeback.operations[1]).toMatchObject({
      kind: "issue_create",
      issueId: candidate.id,
      payload: { title: "Build child", parentIssueId: candidate.id, planId: expect.any(String) },
    });
    expect(writeback.operations.find((operation) => operation.kind === "issue_relation")).toMatchObject({
      kind: "issue_relation",
      issueId: candidate.id,
      payload: { sourceIssueId: "child-1", targetIssueId: candidate.id, type: "blocks" },
    });
    expect(writeback.operations.find((operation) => operation.kind === "comment")).toMatchObject({
      kind: "comment",
      issueId: candidate.id,
      payload: {
        body: expect.stringContaining(FINAL_DISPOSITION),
        issueBreakdownPlanId: expect.any(String),
      },
    });
    const finalComment = writeback.operations
      .filter((operation) => operation.kind === "comment")
      .find((operation) => operation.payload.dedupeKey.includes("issue-breakdown-children"));
    expect(finalComment?.kind === "comment" ? finalComment.payload.body : "").not.toContain("Agent final disposition:");
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
    expect(writer.descriptionUpdates).toHaveLength(3);
    expect(
      parsedRelationships(
        writer.descriptionUpdates.find(
          (update) => update.issueId === "child-1",
        )?.description,
      ),
    ).toEqual({
      blocks: ["TEST-1", "TEST-3"],
      blockedBy: [],
    });
    expect(
      parsedRelationships(
        writer.descriptionUpdates.find(
          (update) => update.issueId === "child-2",
        )?.description,
      ),
    ).toEqual({
      blocks: ["TEST-1"],
      blockedBy: ["TEST-2"],
    });
    expect(
      parsedRelationships(
        writer.descriptionUpdates.find(
          (update) => update.issueId === candidate.id,
        )?.description,
      ),
    ).toEqual({
      blocks: [],
      blockedBy: ["TEST-2", "TEST-3"],
    });
    expect(writer.comments).toHaveLength(2);
    expect(writer.transitions).toHaveLength(1);
    expect(records.every((record) => record.status === "succeeded")).toBe(true);
  });

  it("rewrites reciprocal structured succession endpoints to assigned Linear identifiers", async () => {
    const config = testConfig(root);
    config.issueBreakdown.applyToLinear.enabled = true;
    config.writeback.enabled = true;
    const lifecycleStore = new FileIssueLifecycleStore(
      config.workspace.stateDir,
    );
    const candidate = issue({
      labels: ["planning"],
      updatedAt: "2026-01-02T00:00:00Z",
    });
    const successionId = "expected-red-to-implementation";
    await new IssueBreakdownPlanService({
      config,
      lifecycleStore,
    }).submit_issue_breakdown_plan(
      {
        runId: "run-plan-succession-rewrite",
        issueId: candidate.id,
        finalDisposition: FINAL_DISPOSITION,
        summary:
          "Create an expected-red artifact and its explicit implementation successor.",
        proposedIssues: [
          {
            title: "Land expected-red tests",
            description: proposedIssueContract(candidate.identifier, {
              dependentTitles: ["Implement expected behavior"],
              expectedRed: true,
              succession: {
                id: successionId,
                purpose: "expected_red_implementation",
                successor: { issue: "Implement expected behavior" },
              },
            }),
            acceptanceCriteria: ["Expected-red tests are reviewed."],
            dependencies: [],
            labels: ["planning"],
          },
          {
            title: "Implement expected behavior",
            description: proposedIssueContract(candidate.identifier, {
              dependencyTitles: ["Land expected-red tests"],
              succession: {
                id: successionId,
                purpose: "expected_red_implementation",
                succeeds: { issue: "Land expected-red tests" },
              },
            }),
            acceptanceCriteria: ["The inherited tests pass."],
            dependencies: ["Land expected-red tests"],
            labels: ["planning"],
          },
        ],
        idempotencyKey: "plan-succession-rewrite",
      },
      {
        issue: candidate,
        activeRunId: "run-plan-succession-rewrite",
        role: "worker",
        phase: "issue_breakdown",
      },
    );
    const writeback = new CapturingWriteback();

    const result = await new IssueBreakdownPlanApplyService({
      config,
      lifecycleStore,
      writeback,
    }).applyLatestFreshPlan(candidate);

    expect(result.status).toBe("applied");
    expect(
      parsedRelationships(
        writeback.descriptionUpdates.find(
          (update) => update.issueId === "child-1",
        )?.description,
      ),
    ).toEqual({
      blocks: ["TEST-1", "TEST-3"],
      blockedBy: [],
      succession: {
        id: successionId,
        purpose: "expected_red_implementation",
        successor: { issue: "TEST-3" },
      },
    });
    expect(
      parsedRelationships(
        writeback.descriptionUpdates.find(
          (update) => update.issueId === "child-2",
        )?.description,
      ),
    ).toEqual({
      blocks: ["TEST-1"],
      blockedBy: ["TEST-2"],
      succession: {
        id: successionId,
        purpose: "expected_red_implementation",
        succeeds: { issue: "TEST-2" },
      },
    });
    expect(
      writeback.operations.filter(
        (operation) =>
          operation.kind === "issue_relation" &&
          operation.payload.sourceIssueId === "child-1" &&
          operation.payload.targetIssueId === "child-2",
      ),
    ).toHaveLength(1);
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
    expect(writer.comments).toHaveLength(1);
    expectExactDisposition(writer.comments[0]?.body ?? "", FINAL_DISPOSITION);
    expect(writer.transitions).toHaveLength(0);
    expect(records.find((record) => record.kind === "transition")).toBeUndefined();
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
        finalDisposition: FINAL_DISPOSITION,
        summary: "Split into child issues.",
        proposedIssues: [
          { title: "Build child", description: proposedIssueContract(candidate.identifier), acceptanceCriteria: ["Done"], dependencies: [], labels: [] },
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
    expect(writeback.operations).toHaveLength(1);
    expect(writeback.operations[0]?.kind).toBe("comment");
    expectExactDisposition(commentBody(writeback.operations[0]!), FINAL_DISPOSITION);
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

  it("rejects unresolved dependencies before persistence or application writebacks", async () => {
    const config = testConfig(root);
    config.issueBreakdown.applyToLinear.enabled = true;
    config.writeback.enabled = true;
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const candidate = issue({ labels: ["planning"], updatedAt: "2026-01-02T00:00:00Z" });
    const writeback = new CapturingWriteback();

    await expect(
      new IssueBreakdownPlanService({
        config,
        lifecycleStore,
      }).submit_issue_breakdown_plan(
        {
          runId: "run-plan-1",
          issueId: candidate.id,
          finalDisposition: FULL_FINAL_DISPOSITION,
          summary: "Split into child issues.",
          proposedIssues: [
            {
              title: "Build child",
              description: proposedIssueContract(candidate.identifier, {
                dependencyTitles: ["Missing"],
              }),
              acceptanceCriteria: ["Done"],
              dependencies: ["Missing"],
              labels: [],
            },
          ],
          idempotencyKey: "plan-1",
        },
        {
          issue: candidate,
          activeRunId: "run-plan-1",
          role: "worker",
          phase: "issue_breakdown",
        },
      ),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining(
        "dependencies must name proposed issue titles: Missing",
      ),
    });

    const result = await new IssueBreakdownPlanApplyService({
      config,
      lifecycleStore,
      writeback,
    }).applyLatestFreshPlan(candidate);

    expect(FULL_FINAL_DISPOSITION.length).toBeGreaterThan(10_000);
    expect(result).toMatchObject({
      status: "no_fresh_plan",
      reason: "no_fresh_plan",
    });
    expect(writeback.operations).toEqual([]);
    await expect(lifecycleStore.get(candidate.id)).resolves.toBeNull();
  });

  it("keeps the full disposition durable when partial child creation blocks application", async () => {
    const config = testConfig(root);
    config.issueBreakdown.applyToLinear.enabled = true;
    config.writeback.enabled = true;
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const candidate = issue({ labels: ["planning"], updatedAt: "2026-01-02T00:00:00Z" });
    await submitTwoChildPlan(config, lifecycleStore, candidate, {
      finalDisposition: FULL_FINAL_DISPOSITION,
    });
    const writeback = new CapturingWriteback({ failIssueCreateIndex: 1 });

    const result = await new IssueBreakdownPlanApplyService({ config, lifecycleStore, writeback }).applyLatestFreshPlan(candidate);
    const lifecycle = await lifecycleStore.get(candidate.id);
    const comments = writeback.operations.filter((operation) => operation.kind === "comment");
    const issueCreates = writeback.operations.filter((operation) => operation.kind === "issue_create");

    expect(result.status).toBe("blocked");
    expect(writeback.operations[0]?.kind).toBe("comment");
    expectExactDisposition(commentBody(writeback.operations[0]!), FULL_FINAL_DISPOSITION);
    expect(comments).toHaveLength(1);
    expect(issueCreates).toHaveLength(2);
    expect(lifecycle?.issueBreakdownPlans[0]).toMatchObject({
      applicationStatus: "blocked",
      createdIssueRefs: [expect.objectContaining({ proposedIssueIndex: 0 })],
    });
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
        finalDisposition: FINAL_DISPOSITION,
        summary: "Split into child issues.",
        proposedIssues: [
          {
            title: "Build child",
            description: proposedIssueContract(candidate.identifier),
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
    const dispositionRecord = dryRunRecords.find((record) => record.kind === "comment");

    expect(dryResult).toMatchObject({ status: "blocked", reason: "Writeback dry_run" });
    expect(dryRunPlan?.applicationStatus).toBe("blocked");
    expect(dryRunPlan?.applicationBlockedReason).toBe("Writeback dry_run");
    expect(dryRunPlan?.applicationOperationKeys).toHaveLength(1);
    expect(dryRunPlan?.applicationOperationKeys[0]).toBe(dispositionRecord?.idempotencyKey);
    expect(dryRunPlan?.createdIssueRefs).toEqual([]);
    expect(dispositionRecord?.status).toBe("skipped");
    expect(dispositionRecord?.lastError).toBe("Writeback dry_run");
    expect(dryRunRecords.filter((record) => record.kind === "issue_create")).toHaveLength(0);
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
    const parentComment = liveRecords.find(
      (record) => record.kind === "comment" && record.payload.dedupeKey.includes("issue-breakdown-children"),
    );

    expect(liveResult.status).toBe("applied");
    expect(liveChildRecord?.status).toBe("succeeded");
    expect(liveRecords.filter((record) => record.kind === "issue_create")).toHaveLength(1);
    expect(writer.issueCreates).toHaveLength(1);
    expect(parentComment?.status).toBe("succeeded");
    expect(writer.comments).toHaveLength(2);
    expect(writer.comments.some((comment) => comment.body.includes("TEST-2"))).toBe(true);
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

  it("writes the full disposition but blocks stale child work after parent drift", async () => {
    const config = testConfig(root);
    config.issueBreakdown.applyToLinear.enabled = true;
    config.writeback.enabled = true;
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const candidate = issue({ labels: ["planning"], title: "Original title", updatedAt: "2026-01-02T00:00:00Z" });
    const plan = await submitSingleChildPlan(config, lifecycleStore, candidate, {
      finalDisposition: FULL_FINAL_DISPOSITION,
    });
    const operation = planIssueBreakdownApplicationWritebacks(candidate, plan)[0]!;
    await lifecycleStore.updateIssue(candidate, {
      issueBreakdownPlans: [{ ...plan, applicationStatus: "pending", applicationOperationKeys: [operation.idempotencyKey] }],
      lastIssueBreakdownPlanId: plan.id,
    });
    const store = new FileWritebackOutboxStore(config.workspace.stateDir);
    await store.enqueueOnce(operation);
    const drifted = { ...candidate, title: "Changed title", updatedAt: "2026-01-03T00:00:00Z" };
    const writer = new FakeWriter();
    const processor = new WritebackProcessor(
      store,
      writer,
      new StructuredLogger(() => undefined),
      300_000,
      lifecycleStore,
      false,
      freshnessGuard(drifted, config),
    );

    const applyResult = await new IssueBreakdownPlanApplyService({
      config,
      lifecycleStore,
      writeback: processor,
    }).applyLatestFreshPlan(drifted);
    await processor.processDue();
    const lifecycle = await lifecycleStore.get(candidate.id);
    const records = await store.list();
    const childRecord = records.find((record) => record.kind === "issue_create");
    const dispositionRecord = records.find(
      (record) => record.kind === "comment" && record.payload.dedupeKey.includes("issue-breakdown-disposition"),
    );

    expect(applyResult).toMatchObject({ status: "no_fresh_plan", reason: ISSUE_BREAKDOWN_PLAN_STALE_REASON });
    expect(writer.issueCreates).toEqual([]);
    expect(writer.comments).toHaveLength(1);
    expectExactDisposition(writer.comments[0]?.body ?? "", FULL_FINAL_DISPOSITION);
    expect(childRecord).toMatchObject({ status: "skipped", lastError: ISSUE_BREAKDOWN_PLAN_STALE_REASON });
    expect(dispositionRecord).toMatchObject({ status: "succeeded" });
    expect(lifecycle?.issueBreakdownPlans[0]).toMatchObject({
      applicationStatus: "stale",
      applicationBlockedReason: ISSUE_BREAKDOWN_PLAN_STALE_REASON,
      applicationOperationKeys: expect.arrayContaining([operation.idempotencyKey, dispositionRecord?.idempotencyKey]),
      createdIssueRefs: [],
    });
  });

  it("hydrates missing child refs from registered succeeded writebacks before checking freshness", async () => {
    const config = testConfig(root);
    config.issueBreakdown.applyToLinear.enabled = true;
    config.writeback.enabled = true;
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const candidate = issue({ labels: ["planning"], updatedAt: "2026-01-02T00:00:00Z" });
    const plan = await submitTwoChildPlan(config, lifecycleStore, candidate);
    const childOperations = planIssueBreakdownApplicationWritebacks(candidate, plan) as IssueCreateWriteback[];
    const firstChild = childOperations[0]!;
    const lifecycle = await lifecycleStore.get(candidate.id);
    await lifecycleStore.updateIssue(candidate, {
      issueBreakdownPlans:
        lifecycle?.issueBreakdownPlans.map((existing) =>
          existing.id === plan.id
            ? {
                ...existing,
                applicationStatus: "pending",
                applicationOperationKeys: childOperations.map(
                  (operation) => operation.idempotencyKey,
                ),
                createdIssueRefs: [],
              }
            : existing,
        ) ?? [],
      lastIssueBreakdownPlanId: plan.id,
    });
    const store = new FileWritebackOutboxStore(config.workspace.stateDir);
    await store.markSucceeded(
      await store.enqueueOnce(firstChild),
      issueCreateResult(firstChild),
    );
    const liveCandidate = {
      ...candidate,
      blockedBy: [
        { id: "child-1", identifier: "TEST-2", state: "Todo" },
      ],
      hasChildren: true,
    };
    const writer = new FakeWriter();
    const processor = new WritebackProcessor(
      store,
      writer,
      new StructuredLogger(() => undefined),
      300_000,
      lifecycleStore,
      false,
      freshnessGuard(liveCandidate, config),
    );

    const result = await new IssueBreakdownPlanApplyService({
      config,
      lifecycleStore,
      writeback: processor,
    }).applyLatestFreshPlan(liveCandidate);
    const recovered = await lifecycleStore.get(candidate.id);

    expect(result.status).toBe("applied");
    expect(writer.issueCreates).toHaveLength(1);
    expect(writer.issueCreates[0]?.proposedIssueIndex).toBe(1);
    expect(recovered?.issueBreakdownPlans[0]).toMatchObject({
      applicationStatus: "applied",
      applicationBlockedReason: null,
      createdIssueRefs: [
        expect.objectContaining({ proposedIssueIndex: 0, id: "child-1" }),
        expect.objectContaining({ proposedIssueIndex: 1, id: "child-2" }),
      ],
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
    expect(writer.comments).toHaveLength(2);
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
    const dispositionOperation = planIssueBreakdownDispositionWriteback(candidate, planWithRefs);
    const planWithDisposition = {
      ...planWithRefs,
      applicationOperationKeys: [
        ...childOperations.map((operation) => operation.idempotencyKey),
        dispositionOperation.idempotencyKey,
      ],
    };
    const finalOperations = planIssueBreakdownFinalizationWritebacks(candidate, planWithDisposition);
    await lifecycleStore.updateIssue(candidate, {
      issueBreakdownPlans: [
        {
          ...planWithDisposition,
          applicationStatus: "pending",
          applicationOperationKeys: [
            ...planWithDisposition.applicationOperationKeys,
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
    await store.markSucceeded(await store.enqueueOnce(dispositionOperation), {
      status: "applied",
      message: "Comment written",
    });
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

  it("retries arbitrary skipped plan writebacks only after explicit operator resume", async () => {
    const config = testConfig(root);
    config.issueBreakdown.applyToLinear.enabled = true;
    config.writeback.enabled = true;
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const candidate = issue({ labels: ["planning"], updatedAt: "2026-01-02T00:00:00Z" });
    const plan = await submitSingleChildPlan(config, lifecycleStore, candidate);
    const childOperation = planIssueBreakdownApplicationWritebacks(
      candidate,
      plan,
    )[0] as IssueCreateWriteback;
    const planWithRef = {
      ...plan,
      createdIssueRefs: [createdIssueRef(childOperation)],
    };
    const dispositionOperation = planIssueBreakdownDispositionWriteback(
      candidate,
      planWithRef,
    );
    const finalOperations = planIssueBreakdownFinalizationWritebacks(
      candidate,
      planWithRef,
    );
    const relationOperation = finalOperations.find(
      (operation) => operation.kind === "issue_relation",
    );
    if (!relationOperation) throw new Error("Expected parent relation writeback");
    const skippedReason = "operator-fixable relation precondition failed";
    await lifecycleStore.updateIssue(candidate, {
      issueBreakdownPlans: [
        {
          ...planWithRef,
          applicationStatus: "blocked",
          applicationOperationKeys: [
            childOperation.idempotencyKey,
            dispositionOperation.idempotencyKey,
            ...finalOperations.map((operation) => operation.idempotencyKey),
          ],
          applicationBlockedReason: skippedReason,
        },
      ],
      lastIssueBreakdownPlanId: plan.id,
    });
    const store = new FileWritebackOutboxStore(config.workspace.stateDir);
    await store.markSucceeded(
      await store.enqueueOnce(childOperation),
      issueCreateResult(childOperation),
    );
    await store.markSucceeded(await store.enqueueOnce(dispositionOperation), {
      status: "applied",
      message: "Comment written",
    });
    await store.markSkipped(
      await store.enqueueOnce(relationOperation),
      skippedReason,
    );
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
    const service = new IssueBreakdownPlanApplyService({
      config,
      lifecycleStore,
      writeback: processor,
    });

    const automatic = await service.applyLatestFreshPlan(candidate);

    expect(automatic).toMatchObject({ status: "blocked", reason: skippedReason });
    expect(writer.issueRelations).toEqual([]);
    await expect(store.get(relationOperation.idempotencyKey)).resolves.toMatchObject({
      status: "skipped",
      lastError: skippedReason,
    });

    const resumed = await service.applyLatestFreshPlan(candidate, {
      retrySkippedAfterOperatorResume: true,
    });

    expect(resumed.status).toBe("applied");
    expect(writer.issueCreates).toEqual([]);
    expect(writer.issueRelations).toHaveLength(1);
    await expect(store.get(relationOperation.idempotencyKey)).resolves.toMatchObject({
      status: "succeeded",
    });
    await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
      issueBreakdownPlans: [
        expect.objectContaining({
          applicationStatus: "applied",
          applicationBlockedReason: null,
        }),
      ],
    });
  });
});

class CapturingWriteback
  implements
    Pick<
      WritebackProcessorType,
      "enqueueAndProcess" | "updateIssueDescription"
    >
{
  readonly operations: NewWritebackOperation[] = [];
  readonly descriptionUpdates: Array<{
    issueId: string;
    description: string;
    dedupeKey: string;
  }> = [];
  private issueCreateIndex = 0;

  constructor(private readonly options: { failIssueCreateIndex?: number } = {}) {}

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
    const issueCreateIndex = this.issueCreateIndex++;
    if (issueCreateIndex === this.options.failIssueCreateIndex) {
      return {
        ...operation,
        status: "dead_letter",
        attempt: 1,
        createdAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        nextAttemptAt: "2026-01-02T00:00:00.000Z",
        lastError: "child creation failed",
        resultStatus: null,
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
        issue: {
          id: `child-${issueCreateIndex + 1}`,
          identifier: `TEST-${issueCreateIndex + 2}`,
          url: `https://linear.test/TEST-${issueCreateIndex + 2}`,
        },
        issueCreateStatus: "created",
        parentIssueId: operation.payload.parentIssueId,
        dedupeKey: operation.payload.dedupeKey,
        payloadHash: operation.payload.payloadHash,
        unresolvedLabelNames: [],
      },
    };
  }

  async updateIssueDescription(input: {
    issueId: string;
    description: string;
    dedupeKey: string;
  }) {
    this.descriptionUpdates.push(input);
    return { status: "applied" as const };
  }
}

class FakeWriter implements TrackerWriter {
  readonly transitions: TrackerTransitionInput[] = [];
  readonly comments: TrackerCommentInput[] = [];
  readonly issueCreates: TrackerIssueCreateInput[] = [];
  readonly issueRelations: TrackerIssueRelationInput[] = [];
  readonly descriptionUpdates: Array<{ issueId: string; description: string }> = [];

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

  async updateIssueDescription(input: {
    issueId: string;
    description: string;
    dedupeKey: string;
  }): Promise<TrackerWriteResult> {
    this.descriptionUpdates.push(input);
    return { status: "applied" };
  }
}

async function submitSingleChildPlan(
  config: ServiceConfig,
  lifecycleStore: FileIssueLifecycleStore,
  candidate: Issue,
  options: {
    idempotencyKey?: string;
    runId?: string;
    finalDisposition?: string;
    sourceIssueTriageReportId?: string | null;
  } = {},
) {
  const runId = options.runId ?? "run-plan-1";
  const result = await new IssueBreakdownPlanService({ config, lifecycleStore }).submit_issue_breakdown_plan(
    {
      runId,
      issueId: candidate.id,
      finalDisposition: options.finalDisposition ?? FINAL_DISPOSITION,
      summary: "Split into child issues.",
      proposedIssues: [
        {
          title: "Build child",
          description: proposedIssueContract(candidate.identifier),
          acceptanceCriteria: ["Done"],
          dependencies: [],
          labels: ["planning"],
        },
      ],
      idempotencyKey: options.idempotencyKey ?? "plan-1",
    },
    {
      issue: candidate,
      activeRunId: runId,
      role:
        options.sourceIssueTriageReportId ? "planner" : "worker",
      phase: "issue_breakdown",
      sourceIssueTriageReportId:
        options.sourceIssueTriageReportId ?? null,
    },
  );
  return result.plan;
}

async function seedAutomatedPlannerTriageReport(
  lifecycleStore: FileIssueLifecycleStore,
  candidate: Issue,
): Promise<IssueTriageReportRecord> {
  const lifecycle = await lifecycleStore.ensureIssue(candidate, {
    phase: "blocked",
    reviewRound: 3,
    blockedReason: "max reviewer failures reached (3/3)",
  });
  const reportId = `issue-triage-report:${candidate.id}:triage-planner`;
  const transitionOperationKey = `transition:${candidate.id}:issue-triage:triage-planner:automated-recovery:In_Progress`;
  const report: IssueTriageReportRecord = {
    id: reportId,
    idempotencyKey: "triage-planner",
    requestHash: "triage-planner-hash",
    runId: "triage-run-1",
    issueId: candidate.id,
    issueIdentifier: candidate.identifier,
    triggerFingerprint: issueTriageTriggerFingerprint(lifecycle),
    disposition: "decompose_issue",
    confidence: "high",
    summary: "The issue requires a bounded automated planner breakdown.",
    evidence: ["The current blocker is under-specified."],
    recommendedAction: "Create and apply a bounded child plan.",
    blockers: [
      {
        kind: "under_specified_needs_decomposition",
        status: "active",
        nextActor: "planner",
        confidence: "high",
        summary: "The issue requires a bounded planner breakdown.",
        evidence: ["The current blocker is under-specified."],
        recommendedAction: "Create and apply a bounded child plan.",
      },
    ],
    recoveryDisposition: {
      mode: "automated",
      nextActor: "planner",
      targetState: "In Progress",
      reportWritebackStatus: "applied",
      transitionOperationKey,
      transitionStatus: "applied",
      reason: "machine-owned recovery routed to planner",
    },
    submittedAt: "2026-01-02T00:00:00.000Z",
    writebackOperationKeys: [
      `comment:${candidate.id}:issue-triage:triage-planner`,
      transitionOperationKey,
    ],
  };
  await lifecycleStore.updateIssue(candidate, {
    lastIssueTriageReportId: report.id,
    issueTriageReports: [report],
  });
  return report;
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
    finalDisposition: "Split into child issues.",
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

async function submitTwoChildPlan(
  config: ServiceConfig,
  lifecycleStore: FileIssueLifecycleStore,
  candidate: Issue,
  options: { finalDisposition?: string } = {},
) {
  const result = await new IssueBreakdownPlanService({ config, lifecycleStore }).submit_issue_breakdown_plan(
    {
      runId: "run-plan-1",
      issueId: candidate.id,
      finalDisposition: options.finalDisposition ?? FINAL_DISPOSITION,
      summary: "Split into child issues.",
      proposedIssues: [
        {
          title: "Build child",
          description: proposedIssueContract(candidate.identifier, {
            dependentTitles: ["Build dependent child"],
          }),
          acceptanceCriteria: ["Done"],
          dependencies: [],
          labels: ["planning"],
        },
        {
          title: "Build dependent child",
          description: proposedIssueContract(candidate.identifier, {
            dependencyTitles: ["Build child"],
          }),
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

function commentBody(operation: NewWritebackOperation): string {
  if (operation.kind !== "comment") throw new Error("Expected comment operation");
  return operation.payload.body;
}

function expectExactDisposition(body: string, expected: string): void {
  const marker = "Agent final disposition:\n";
  const markerIndex = body.indexOf(marker);
  expect(markerIndex).toBeGreaterThanOrEqual(0);
  expect(body.slice(markerIndex + marker.length)).toBe(expected);
}

function parsedRelationships(description: string | undefined) {
  const parsed = parseIssueContract(description);
  if (!parsed.valid || parsed.contract.schemaVersion !== 2) {
    throw new Error("Expected a valid schema-v2 Issue Contract");
  }
  return parsed.contract.relationships;
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
    updateIssueDescription: (input) =>
      writer.updateIssueDescription(input),
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

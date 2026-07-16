import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planIssueBreakdownFinalizationWritebacks } from "../src/core/IssueBreakdownPlanApplyService.js";
import { IssueTriageService, issueTriageTriggerFingerprint } from "../src/core/IssueTriageService.js";
import { completionReportInputSchema } from "../src/core/harness/CompletionReportMcpServer.js";
import { issueBreakdownPlanInputSchema } from "../src/core/harness/IssueBreakdownPlanMcpServer.js";
import { issuePostMortemReportInputSchema } from "../src/core/harness/IssuePostMortemMcpServer.js";
import { issueTriageReportInputSchema } from "../src/core/harness/IssueTriageMcpServer.js";
import { mergeConflictResolutionInputSchema } from "../src/core/harness/MergeConflictResolutionMcpServer.js";
import { reviewVerdictInputSchema } from "../src/core/harness/ReviewVerdictMcpServer.js";
import {
  FileIssueLifecycleStore,
  type IssueBreakdownPlanRecord,
  type IssueMergeConflictResolutionReportRecord,
  type IssuePostMortemReportRecord,
  type IssueTriageReportRecord,
} from "../src/core/persistence/IssueLifecycleStore.js";
import {
  FileWritebackOutboxStore,
  type NewWritebackOperation,
  type WritebackOperation,
} from "../src/core/writeback/WritebackOutbox.js";
import {
  planCompletionReportAcceptedWritebacks,
  planIssuePostMortemReportWritebacks,
  planIssueTriageReportWritebacks,
  planMergeConflictResolvedWritebacks,
  planReviewFailWritebacks,
} from "../src/core/writeback/TransitionPolicy.js";
import { issue, testConfig } from "./helpers.js";

const LARGE_FINAL_DISPOSITION = [
  "Complete agent disposition.",
  "",
  "Evidence:",
  ...Array.from({ length: 850 }, (_, index) => `- Finding ${index}: ${"full evidence ".repeat(3)}`),
  "",
  "End of complete disposition.",
].join("\n");

describe("complete agent final disposition contract", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("requires finalDisposition in every agent handoff MCP schema", () => {
    const schemas = [
      completionReportInputSchema(),
      reviewVerdictInputSchema(),
      issueBreakdownPlanInputSchema(),
      issueTriageReportInputSchema(),
      issuePostMortemReportInputSchema(),
      mergeConflictResolutionInputSchema(),
    ];

    for (const schema of schemas) {
      expect(schema.required).toEqual(expect.arrayContaining(["finalDisposition"]));
      expect((schema.properties as Record<string, unknown>).finalDisposition).toMatchObject({
        type: "string",
        minLength: 1,
      });
    }
  });

  it("writes the same untruncated disposition in every role-specific Linear comment", () => {
    expect(LARGE_FINAL_DISPOSITION.length).toBeGreaterThan(10_000);
    const config = testConfig("/tmp/symphony-final-disposition-policy");
    config.writeback.enabled = true;
    config.reviewLoop.reviewStates = ["In Review"];
    config.reviewLoop.blockedStates = ["Blocked"];
    config.writeback.dispatchState = "In Progress";

    const worker = planCompletionReportAcceptedWritebacks(
      runContext("In Progress", "worker-run"),
      config,
      {
        reportId: "report-1",
        idempotencyKey: "completion-1",
        finalDisposition: LARGE_FINAL_DISPOSITION,
        summary: "Implemented the issue.",
        validationEvidence: ["npm test"],
        acceptanceChecklist: [{ text: "REQ-1", satisfied: true, evidence: "passing test" }],
        changedFiles: ["src/index.ts"],
        branchName: "symphony/TEST-1",
        pullRequest: null,
        risks: [],
      },
    );
    const reviewer = planReviewFailWritebacks(
      { issue: issue({ state: "In Review" }), runId: "review-run", reviewer: "reviewer" },
      config,
      {
        idempotencyKey: "review-1",
        finalDisposition: LARGE_FINAL_DISPOSITION,
        acceptanceResults: [{ text: "REQ-1", satisfied: false, evidence: "failure" }],
        findings: ["REQ-1 failed"],
        gateFindings: [],
        discoveryFindings: [],
        evidence: ["test output"],
      },
    );
    const planner = planIssueBreakdownFinalizationWritebacks(
      issue(),
      breakdownPlan(LARGE_FINAL_DISPOSITION),
      config,
    );
    const triage = planIssueTriageReportWritebacks(
      { issue: issue({ state: "Blocked" }), report: triageReport(LARGE_FINAL_DISPOSITION), blockedReason: "review blocked" },
      config,
    );
    const postMortem = planIssuePostMortemReportWritebacks(
      { issue: issue({ state: "Done" }), report: postMortemReport(LARGE_FINAL_DISPOSITION) },
      config,
    );
    const conflict = planMergeConflictResolvedWritebacks(
      {
        issue: issue({ state: "Conflict Repair" }),
        report: conflictReport(LARGE_FINAL_DISPOSITION),
        fromState: "Conflict Repair",
        conflictsState: "Conflict Repair",
      },
      config,
    );

    for (const operations of [worker, reviewer, planner, triage, postMortem, conflict]) {
      const body = commentBody(operations);
      expect(body).toContain(LARGE_FINAL_DISPOSITION);
      expect(body).not.toContain("...[truncated]");
      expect(body.slice(body.indexOf(LARGE_FINAL_DISPOSITION), body.indexOf(LARGE_FINAL_DISPOSITION) + LARGE_FINAL_DISPOSITION.length))
        .toBe(LARGE_FINAL_DISPOSITION);
    }
  });

  it("persists a greater-than-10k disposition byte-for-byte and enqueues the same Linear body", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-final-disposition-"));
    roots.push(root);
    const config = testConfig(root);
    config.issueTriage.enabled = true;
    config.writeback.enabled = true;
    const candidate = issue({ state: "Blocked" });
    const lifecycleStore = new FileIssueLifecycleStore(root);
    const outbox = new FileWritebackOutboxStore(root);
    const lifecycle = await lifecycleStore.ensureIssue(candidate, {
      phase: "blocked",
      blockedReason: "max reviewer failures reached (3/3)",
      reviewRound: 3,
    });
    const service = new IssueTriageService({ config, lifecycleStore, writebackOutbox: outbox });

    const result = await service.submitIssueTriageReport(
      {
        runId: "triage-large-run",
        issueId: candidate.id,
        triggerFingerprint: issueTriageTriggerFingerprint(lifecycle),
        finalDisposition: LARGE_FINAL_DISPOSITION,
        summary: "A complete large disposition was submitted.",
        blockers: [
          {
            kind: "manual_decision",
            status: "active",
            nextActor: "operator",
            confidence: "high",
            summary: "Operator input is required.",
            evidence: ["The issue contract names an operator-owned choice."],
            recommendedAction: "Choose the intended policy.",
          },
        ],
        idempotencyKey: "triage-large-1",
      },
      { issue: candidate, activeRunId: "triage-large-run", role: "triage", phase: "issue_triage" },
    );

    expect(result.report.finalDisposition).toBe(LARGE_FINAL_DISPOSITION);
    expect((await lifecycleStore.get(candidate.id))?.issueTriageReports[0]?.finalDisposition).toBe(LARGE_FINAL_DISPOSITION);
    const body = commentBody(await outbox.list());
    expect(body).toContain(LARGE_FINAL_DISPOSITION);
    expect(body).not.toContain("...[truncated]");
  });

  it("preserves a legacy missing disposition without synthesizing an excerpt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-legacy-disposition-"));
    roots.push(root);
    const candidate = issue();
    const legacyPlan = breakdownPlan("temporary");
    delete legacyPlan.finalDisposition;
    const lifecycleStore = new FileIssueLifecycleStore(root);

    await lifecycleStore.ensureIssue(candidate, {
      issueBreakdownPlans: [legacyPlan],
      lastIssueBreakdownPlanId: legacyPlan.id,
    });

    const reloaded = await lifecycleStore.get(candidate.id);
    expect(reloaded?.issueBreakdownPlans[0]).not.toHaveProperty("finalDisposition");

    const config = testConfig(root);
    config.writeback.enabled = true;
    const body = commentBody(
      planIssueBreakdownFinalizationWritebacks(candidate, reloaded!.issueBreakdownPlans[0]!, config),
    );
    expect(body).not.toContain("Agent final disposition:");
    expect(body).not.toContain(legacyPlan.summary);
  });
});

function runContext(state: string, runId: string) {
  return {
    issue: issue({ state }),
    runId,
    sessionId: null,
    workspacePath: null,
  };
}

function commentBody(operations: readonly (NewWritebackOperation | WritebackOperation)[]): string {
  const comment = operations.find((operation) => operation.kind === "comment");
  if (!comment || comment.kind !== "comment") throw new Error("Expected comment writeback");
  return comment.payload.body;
}

function breakdownPlan(finalDisposition: string): IssueBreakdownPlanRecord {
  return {
    id: "plan-1",
    idempotencyKey: "plan-1",
    requestHash: "request-hash",
    runId: "planner-run",
    issueId: "issue-1",
    issueIdentifier: "TEST-1",
    finalDisposition,
    summary: "Created one child.",
    proposedIssues: [
      { title: "Child", description: "Description", acceptanceCriteria: ["Done"], dependencies: [], labels: [] },
    ],
    transcriptPointers: [],
    statusApiPointers: [],
    issueUpdatedAt: null,
    issueContentFingerprint: "content",
    configFingerprint: "config",
    cursorMode: "plan",
    acceptedAt: "2026-01-01T00:00:00.000Z",
    applicationStatus: "applied",
    applicationOperationKeys: [],
    createdIssueRefs: [
      { proposedIssueIndex: 0, operationKey: "create-1", status: "created", id: "child-1", identifier: "TEST-2", url: null },
    ],
    appliedAt: "2026-01-01T00:01:00.000Z",
    applicationBlockedReason: null,
  } as IssueBreakdownPlanRecord;
}

function triageReport(finalDisposition: string): IssueTriageReportRecord {
  return {
    id: "triage-1",
    idempotencyKey: "triage-1",
    requestHash: "request-hash",
    runId: "triage-run",
    issueId: "issue-1",
    issueIdentifier: "TEST-1",
    triggerFingerprint: "trigger",
    finalDisposition,
    disposition: "manual_decision",
    confidence: "high",
    summary: "Operator input is required.",
    evidence: ["contract"],
    recommendedAction: "Choose the policy.",
    blockers: [
      {
        kind: "manual_decision",
        status: "active",
        nextActor: "operator",
        confidence: "high",
        summary: "Operator input is required.",
        evidence: ["contract"],
        recommendedAction: "Choose the policy.",
      },
    ],
    submittedAt: "2026-01-01T00:00:00.000Z",
    writebackOperationKeys: [],
  } as IssueTriageReportRecord;
}

function postMortemReport(finalDisposition: string): IssuePostMortemReportRecord {
  return {
    id: "post-1",
    idempotencyKey: "post-1",
    requestHash: "request-hash",
    runId: "post-run",
    issueId: "issue-1",
    issueIdentifier: "TEST-1",
    triggerFingerprint: "trigger",
    finalDisposition,
    summary: "Done is valid.",
    completionJudgment: { status: "valid_done", rationale: "All evidence passed." },
    specificationAssessment: {
      quality: "strong",
      classifications: ["well_scoped"],
      missingContractAreas: [],
      speckitRecommended: false,
      speckitRationale: "No follow-up specification is needed.",
    },
    reviewAssessment: { gateDecisionLooksValid: true, missedGateFindings: [], missedDiscoveryFindings: [] },
    followUpCandidates: [],
    processLessons: [],
    submittedAt: "2026-01-01T00:00:00.000Z",
    writebackOperationKeys: [],
  } as IssuePostMortemReportRecord;
}

function conflictReport(finalDisposition: string): IssueMergeConflictResolutionReportRecord {
  return {
    id: "conflict-1",
    idempotencyKey: "conflict-1",
    runId: "conflict-run",
    issueId: "issue-1",
    issueIdentifier: "TEST-1",
    finalDisposition,
    resolutionStatus: "resolved",
    summary: "Resolved conflicts.",
    validationEvidence: ["npm test"],
    changedFiles: ["src/index.ts"],
    pullRequest: { url: null, number: 1, headSha: "head-2", branch: "symphony/TEST-1" },
    previousHeadSha: "head-1",
    newHeadSha: "head-2",
    baseBranch: "main",
    baseHeadSha: "base-1",
    blockedReason: null,
    risks: [],
    submittedAt: "2026-01-01T00:00:00.000Z",
    writebackOperationKeys: [],
  } as IssueMergeConflictResolutionReportRecord;
}

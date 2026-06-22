import { describe, expect, it } from "vitest";
import { IssueOrchestrationEngine } from "../src/core/orchestration/IssueOrchestrationEngine.js";
import {
  createIssueSnapshotId,
  type IssueCurrentStateSnapshot,
} from "../src/core/orchestration/IssueOrchestrationState.js";

describe("IssueOrchestrationEngine", () => {
  it("evaluates rulesets by priority and stops at the first transition request", () => {
    const calls: string[] = [];
    const engine = new IssueOrchestrationEngine([
      {
        id: "later",
        priority: 20,
        evaluate() {
          calls.push("later");
          return { transitionKind: "noop", reason: "later" };
        },
      },
      {
        id: "first",
        priority: 10,
        evaluate() {
          calls.push("first");
          return { transitionKind: "dispatch_worker", role: "worker", runPhase: "implementation" };
        },
      },
    ]);

    const decided = engine.decide(snapshot(), []);

    expect(calls).toEqual(["first"]);
    expect(decided).toMatchObject({
      transitionKind: "dispatch_worker",
      rulesetId: "first",
      rulesetVersion: "unversioned",
      rulesetFingerprint: "first@unversioned:10",
      rulesetPriority: 10,
      role: "worker",
      runPhase: "implementation",
      actions: [],
      errors: [],
    });
    expect(decided).not.toHaveProperty("current");
    expect(decided).not.toHaveProperty("transitionRequest");
  });

  it("rejects nested transition requests", () => {
    const engine = new IssueOrchestrationEngine([
      {
        id: "bad",
        priority: 1,
        evaluate() {
          return { transitionKind: "noop", transitionRequest: { reason: "nested" } };
        },
      },
    ]);

    expect(() => engine.decide(snapshot(), [])).toThrow(/flattened/);
  });

  it("replays persisted snapshots against the registered rulesets", () => {
    const engine = new IssueOrchestrationEngine([
      {
        id: "dispatch.worker",
        priority: 10,
        evaluate() {
          return { transitionKind: "dispatch_worker", role: "worker", runPhase: "implementation", reason: "worker_dispatch" };
        },
      },
    ]);
    const decided = engine.decide(snapshot(), []);
    expect(decided).not.toBeNull();

    expect(engine.replay([decided!])).toEqual([
      expect.objectContaining({
        historySnapshotId: decided!.historySnapshotId,
        matched: true,
        replayable: true,
        expectedTransitionKind: "dispatch_worker",
        expectedRulesetId: "dispatch.worker",
        expectedRulesetVersion: "unversioned",
        expectedRulesetFingerprint: "dispatch.worker@unversioned:10",
        actualTransitionKind: "dispatch_worker",
        actualRulesetId: "dispatch.worker",
        actualRulesetVersion: "unversioned",
        actualRulesetFingerprint: "dispatch.worker@unversioned:10",
      }),
    ]);
  });

  it("keeps evidence snapshots in history without replaying them as transition decisions", () => {
    const engine = new IssueOrchestrationEngine([
      {
        id: "evidence.run",
        priority: 900,
        evaluate() {
          return {
            transitionKind: "record_evidence",
            reason: "run_started",
            evidenceKind: "run",
            evidenceEventType: "run_started",
            evidenceSourceId: "run-1",
            evidencePayload: { runId: "run-1" },
          };
        },
      },
    ]);
    const decided = engine.decide(snapshot(), []);
    expect(decided).toMatchObject({
      snapshotKind: "evidence",
      transitionKind: "record_evidence",
      evidenceKind: "run",
      evidenceEventType: "run_started",
      evidenceSourceId: "run-1",
      evidencePayload: { runId: "run-1" },
    });

    expect(engine.replay([decided!])).toEqual([
      expect.objectContaining({
        historySnapshotId: decided!.historySnapshotId,
        matched: true,
        replayable: false,
        expectedTransitionKind: "record_evidence",
        expectedRulesetId: "evidence.run",
        actualTransitionKind: null,
        actualRulesetId: null,
      }),
    ]);
  });
});

function snapshot(): IssueCurrentStateSnapshot {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    version: 1,
    issueId: "issue-1",
    issueIdentifier: "TEST-1",
    title: "Test issue",
    description: "Body",
    priority: 1,
    trackerState: "Todo",
    branchName: null,
    trackerUrl: null,
    assigneeId: null,
    delegateId: null,
    assignedToWorker: true,
    labels: [],
    blockedBy: [],
    hasChildren: false,
    trackerCreatedAt: now,
    trackerUpdatedAt: now,
    phase: "implementation",
    reviewRound: 0,
    incompleteTurnCount: 0,
    planningFailureCount: 0,
    planningDispatchRetryCount: 0,
    lastPlanningFailureAt: null,
    planningRetryDueAt: null,
    blockedReason: null,
    lastIssueBreakdownPlanId: null,
    lastIssueBreakdownPlanApplicationStatus: null,
    lastIssueBreakdownPlanIssueContentFingerprint: null,
    lastIssueBreakdownPlanConfigFingerprint: null,
    lastIssueBreakdownPlanSatisfiesCurrentValidation: false,
    currentIssueContentFingerprint: "issue-fingerprint",
    currentIssueBreakdownConfigFingerprint: "config-fingerprint",
    lastIssueTriageReportId: null,
    lastIssueTriageReportTriggerFingerprint: null,
    lastIssueTriageReportWritebackOperationKeys: null,
    currentIssueTriageTriggerFingerprint: null,
    issueTriageCurrentTriggerReportIds: [],
    latestIssueTriageReportBlockers: [],
    lastPostMortemReportId: null,
    lastPostMortemReportTriggerFingerprint: null,
    lastPostMortemReportWritebackOperationKeys: null,
    currentPostMortemTriggerFingerprint: null,
    postMortemCurrentTriggerReportIds: [],
    lastCompletionReportId: null,
    lastCompletionReportRejectionId: null,
    lastReviewVerdictId: null,
    lastMergeGateResultId: null,
    latestCompletionReport: null,
    latestApprovalPassVerdict: null,
    mergeGate: null,
    mergeConflict: null,
    lifecycleSummaryCiStatus: null,
    mergePolicyMode: "manual",
    mergePolicySourceStates: [],
    mergePolicyDoneState: null,
    mergePolicyConflictsState: null,
    mergePolicyRequiredChecks: [],
    mergePolicyMaxMergeGateFailures: 0,
    mergePolicyConfigFingerprint: "merge-policy-config",
    currentMergePolicyObservationInputFingerprint: null,
    lastMergePolicyObservationFingerprint: null,
    lastMergePolicyObservationStatus: null,
    lastMergePolicyObservation: null,
    mergePolicyMerge: null,
    mergePolicyMergeGate: null,
    mergePolicyMergeGateResults: [],
    mergePolicyMergeConflict: null,
    mergePolicyLatestCompletionReport: null,
    mergePolicyLatestApprovalVerdict: null,
    mergePolicyReviewFeedback: [],
    mergePolicyLatestCompletionRun: null,
    pendingPublicationApprovalRunId: null,
    pendingPublicationApprovalReportId: null,
    pendingPublicationApprovalReason: null,
    latestRunId: null,
    latestRunStatus: null,
    latestRunRole: null,
    latestRunPhase: null,
    latestRunKind: null,
    latestRunCompletedAt: null,
    latestRunError: null,
    latestPrUrl: null,
    latestPrNumber: null,
    latestPrHeadSha: null,
    latestPrBranch: null,
    latestWorkspaceKey: null,
    latestWorkspacePath: null,
    latestGitBranchName: null,
    running: false,
    runningRole: null,
    runningRunPhase: null,
    runningRunKind: null,
    runningManualDispatchStage: null,
    runningManualIgnoreState: false,
    runningHasPendingPublicationApproval: false,
    runningCancellationRequested: false,
    claimed: false,
    paused: false,
    retrying: false,
    consecutiveSdkErrorFailures: 0,
    consecutiveInfraFailures: 0,
    recordCreatedAt: now,
    recordUpdatedAt: now,
    snapshotId: createIssueSnapshotId(),
    snapshotAt: now,
    triggerType: "orchestrator.tick",
    triggerId: "tick-1",
    triggerAt: now,
    triggerSource: "orchestrator",
    candidateSource: "test",
    transitionRequestContext: null,
    availableSlots: 1,
    providerDispatchGateActive: false,
    stateSlotAvailable: true,
    allowExistingClaim: false,
    manualStage: null,
    manualForceLabels: false,
    manualIgnoreState: false,
  };
}

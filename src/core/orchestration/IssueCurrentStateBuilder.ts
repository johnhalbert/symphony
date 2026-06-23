import { createHash, randomUUID } from "node:crypto";
import type { ServiceConfig } from "../config/Config.js";
import { errorMessage } from "../errors.js";
import type { Logger } from "../logging/StructuredLogger.js";
import {
  pendingPublicationHandoffForRun,
} from "../CompletionReportService.js";
import { OPERATOR_REJECTED_PUBLICATION_ERROR } from "../approval/OperatorApprovalService.js";
import {
  issueBreakdownConfigFingerprint,
  issueBreakdownPlanSatisfiesCurrentValidation,
  issueContentFingerprint,
} from "../IssueBreakdownPlanService.js";
import {
  activeIssueTriageBlockers,
  issueTriageTriggerFingerprint,
  latestIssueTriageReport,
  latestIssueTriageReportForFingerprint,
} from "../IssueTriageService.js";
import {
  issuePostMortemTriggerFingerprint,
  latestIssuePostMortemReportForFingerprint,
} from "../IssuePostMortemService.js";
import {
  isSupersededLifecycleRecord,
  latestCurrentApprovalPassVerdict,
  phaseForIssueState,
  type IssueCompletionReportRecord,
  type IssueLifecycleRecord,
  type IssueLifecycleStore,
  type IssueReviewVerdictRecord,
} from "../persistence/IssueLifecycleStore.js";
import {
  compareRunChronology,
  type RunRecord,
  type RunTranscriptStore,
} from "../persistence/RunTranscriptStore.js";
import { runKindForPhase, type AgentRunPhase, type AgentRunRole, type Issue } from "../types.js";
import type {
  IssueCurrentStateSnapshot,
  IssueCurrentFields,
  IssueHistorySnapshot,
  IssueStateStore,
  IssueTransitionRequestContext,
  IssueTriggerSource,
  IssueTriggerType,
} from "./IssueOrchestrationState.js";
import {
  createIssueSnapshotId,
  immutableIssueSnapshot,
} from "./IssueOrchestrationState.js";
import { mergePolicyObservationFromUnknown } from "../merge/MergePolicyDecision.js";
import type { MergePolicyObservation } from "../merge/MergePolicyService.js";

export interface IssueCurrentStateRuntimeEntry {
  role: AgentRunRole;
  runPhase: AgentRunPhase;
  runId: string | null;
  activeRunId: string | null;
  manualDispatch: {
    stage: string;
    ignoreState: boolean;
  } | null;
  cancellationRequestedAt: Date | null;
}

export interface IssueCurrentStateRuntimeState {
  runningEntry: IssueCurrentStateRuntimeEntry | null;
  running: boolean;
  claimed: boolean;
  paused: boolean;
  retrying: boolean;
}

export interface IssueCurrentStateSnapshotBuildInput {
  triggerType: IssueTriggerType;
  triggerSource: IssueTriggerSource;
  candidateSource: string;
  transitionRequestContext: IssueTransitionRequestContext | null;
  availableSlots: number;
  providerDispatchGateActive: boolean;
  stateSlotAvailable: boolean;
  allowExistingClaim: boolean;
  manualStage: string | null;
  manualForceLabels: boolean;
  manualIgnoreState: boolean;
  snapshotPatch?: Partial<IssueCurrentStateSnapshot>;
}

export interface IssueCurrentStateBuilderOptions {
  config: ServiceConfig;
  lifecycleStore: IssueLifecycleStore | undefined;
  runStore: RunTranscriptStore | undefined;
  issueStateStore: IssueStateStore;
  logger: Pick<Logger, "warn">;
}

export class IssueCurrentStateBuilder {
  constructor(private readonly options: IssueCurrentStateBuilderOptions) {}

  async build(issue: Issue, runtime: IssueCurrentStateRuntimeState): Promise<IssueCurrentFields> {
    const lifecycle = (await this.options.lifecycleStore?.get(issue.id)) ?? null;
    const runningEntry = runtime.runningEntry;
    let latestRun: RunRecord | null = null;
    let runs: RunRecord[] = [];
    try {
      runs = (await this.options.runStore?.listRunsForIssue(issue.id)) ?? [];
      latestRun = [...runs].sort(compareRunChronology).at(-1) ?? null;
    } catch (error) {
      this.options.logger.warn("issue current-state latest run lookup failed", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        error: errorMessage(error),
      });
    }
    const pointers = lifecycle?.summaryPointers ?? null;
    const latestPrNumber = pointers?.prNumber ?? latestRun?.prNumber ?? null;
    const lastIssueBreakdownPlan =
      lifecycle?.lastIssueBreakdownPlanId === undefined || lifecycle.lastIssueBreakdownPlanId === null
        ? null
        : lifecycle.issueBreakdownPlans.find((plan) => plan.id === lifecycle.lastIssueBreakdownPlanId) ?? null;
    const currentIssueFingerprint = issueContentFingerprint(issue);
    const currentIssueBreakdownFingerprint = issueBreakdownConfigFingerprint(this.options.config);
    const currentIssueTriageFingerprint = lifecycle === null ? null : issueTriageTriggerFingerprint(lifecycle);
    const issueTriageCurrentTriggerReports =
      lifecycle === null || currentIssueTriageFingerprint === null
        ? []
        : lifecycle.issueTriageReports.filter(
            (report) => report.triggerFingerprint === currentIssueTriageFingerprint && !isSupersededLifecycleRecord(report),
          );
    const lastIssueTriageReport =
      lifecycle === null || currentIssueTriageFingerprint === null
        ? null
        : latestIssueTriageReportForFingerprint(lifecycle, currentIssueTriageFingerprint);
    const latestAnyIssueTriageReport = latestIssueTriageReport(lifecycle);
    const currentPostMortemFingerprint = lifecycle === null ? null : issuePostMortemTriggerFingerprint(lifecycle, issue);
    const postMortemCurrentTriggerReports =
      lifecycle === null || currentPostMortemFingerprint === null
        ? []
        : lifecycle.postMortemReports.filter((report) => report.triggerFingerprint === currentPostMortemFingerprint);
    const lastPostMortemReport =
      lifecycle === null || currentPostMortemFingerprint === null
        ? null
        : latestIssuePostMortemReportForFingerprint(lifecycle, currentPostMortemFingerprint);
    const mergePolicyConfigHash = mergePolicyConfigFingerprint(this.options.config);
    const mergePolicyLatestCompletionReport = lifecycle === null ? null : latestLifecycleCompletionReport(lifecycle);
    const mergePolicyLatestApprovalVerdict = lifecycle === null ? null : latestCurrentApprovalPassVerdict(lifecycle);
    const mergePolicyObservationFingerprint = mergePolicyObservationInputFingerprint({
      issue,
      lifecycle,
      report: mergePolicyLatestCompletionReport,
      verdict: mergePolicyLatestApprovalVerdict,
      configFingerprint: mergePolicyConfigHash,
    });
    const existingIssueState = await this.options.issueStateStore.get(issue.id).catch(() => null);
    const lastMergePolicyObservation = latestMergePolicyObservationForFingerprint(
      existingIssueState?.history ?? [],
      mergePolicyObservationFingerprint,
    );
    const mergePolicyLatestCompletionRun =
      mergePolicyLatestCompletionReport === null
        ? null
        : runs.find((run) => run.runId === mergePolicyLatestCompletionReport.runId) ??
          (await this.options.runStore?.getRun(mergePolicyLatestCompletionReport.runId).catch(() => null)) ??
          null;
    const runningRunId = runningEntry?.activeRunId ?? runningEntry?.runId ?? null;
    const pendingPublication =
      runningRunId === null
        ? pendingPublicationHandoffForRun(lifecycle)
        : pendingPublicationHandoffForRun(lifecycle, { runId: runningRunId }) ?? pendingPublicationHandoffForRun(lifecycle);
    const runningRunPhase = runningEntry?.runPhase ?? null;
    return {
      version: 1,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      priority: issue.priority,
      trackerState: issue.state,
      branchName: issue.branchName,
      trackerUrl: issue.url,
      assigneeId: issue.assigneeId,
      delegateId: issue.delegateId,
      assignedToWorker: issue.assignedToWorker,
      labels: [...issue.labels],
      blockedBy: issue.blockedBy.map((blocker) => ({ ...blocker })),
      hasChildren: issue.hasChildren === true,
      trackerCreatedAt: issue.createdAt,
      trackerUpdatedAt: issue.updatedAt,
      phase: lifecycle?.phase ?? phaseForIssueState(issue.state, this.options.config),
      reviewRound: lifecycle?.reviewRound ?? 0,
      incompleteTurnCount: lifecycle?.incompleteTurnCount ?? 0,
      planningFailureCount: lifecycle?.planningFailureCount ?? 0,
      planningDispatchRetryCount: lifecycle?.planningDispatchRetryCount ?? 0,
      lastPlanningFailureAt: lifecycle?.lastPlanningFailureAt ?? null,
      planningRetryDueAt: lifecycle === null ? null : planningRetryDueAtIso(lifecycle, this.options.config),
      blockedReason: lifecycle?.blockedReason ?? null,
      lastIssueBreakdownPlanId: lifecycle?.lastIssueBreakdownPlanId ?? null,
      lastIssueBreakdownPlanApplicationStatus: lastIssueBreakdownPlan?.applicationStatus ?? null,
      lastIssueBreakdownPlanIssueContentFingerprint: lastIssueBreakdownPlan?.issueContentFingerprint ?? null,
      lastIssueBreakdownPlanConfigFingerprint: lastIssueBreakdownPlan?.configFingerprint ?? null,
      lastIssueBreakdownPlanSatisfiesCurrentValidation:
        lastIssueBreakdownPlan === null ? false : issueBreakdownPlanSatisfiesCurrentValidation(lastIssueBreakdownPlan, this.options.config),
      currentIssueContentFingerprint: currentIssueFingerprint,
      currentIssueBreakdownConfigFingerprint: currentIssueBreakdownFingerprint,
      lastIssueTriageReportId: lastIssueTriageReport?.id ?? lifecycle?.lastIssueTriageReportId ?? null,
      lastIssueTriageReportTriggerFingerprint: lastIssueTriageReport?.triggerFingerprint ?? null,
      lastIssueTriageReportWritebackOperationKeys: lastIssueTriageReport?.writebackOperationKeys ?? null,
      currentIssueTriageTriggerFingerprint: currentIssueTriageFingerprint,
      issueTriageCurrentTriggerReportIds: issueTriageCurrentTriggerReports.map((report) => report.id),
      latestIssueTriageReportBlockers: activeIssueTriageBlockers(latestAnyIssueTriageReport).map((blocker) => ({
        ...blocker,
        evidence: [...blocker.evidence],
      })),
      lastPostMortemReportId: lastPostMortemReport?.id ?? lifecycle?.lastPostMortemReportId ?? null,
      lastPostMortemReportTriggerFingerprint: lastPostMortemReport?.triggerFingerprint ?? null,
      lastPostMortemReportWritebackOperationKeys: lastPostMortemReport?.writebackOperationKeys ?? null,
      currentPostMortemTriggerFingerprint: currentPostMortemFingerprint,
      postMortemCurrentTriggerReportIds: postMortemCurrentTriggerReports.map((report) => report.id),
      lastCompletionReportId: lifecycle?.lastCompletionReportId ?? null,
      lastCompletionReportRejectionId: lifecycle?.lastCompletionReportRejectionId ?? null,
      lastReviewVerdictId: lifecycle?.lastReviewVerdictId ?? null,
      lastMergeGateResultId: lifecycle?.lastMergeGateResultId ?? null,
      latestCompletionReport: mergePolicyLatestCompletionReport,
      latestApprovalPassVerdict: mergePolicyLatestApprovalVerdict,
      mergeGate: lifecycle?.mergeGate ?? null,
      mergeConflict: lifecycle?.mergeConflict ?? null,
      lifecycleSummaryCiStatus: lifecycle?.summaryPointers.ciStatus ?? null,
      mergePolicyMode: this.options.config.mergePolicy.mode,
      mergePolicySourceStates: [...this.options.config.mergePolicy.sourceStates],
      mergePolicyDoneState: this.options.config.mergePolicy.doneState,
      mergePolicyConflictsState: this.options.config.mergePolicy.conflictsState,
      mergePolicyRequiredChecks: [...this.options.config.mergePolicy.requiredChecks],
      mergePolicyMaxMergeGateFailures: this.options.config.reviewLoop.failureLimits.mergeGateFailures,
      mergePolicyConfigFingerprint: mergePolicyConfigHash,
      currentMergePolicyObservationInputFingerprint: mergePolicyObservationFingerprint,
      lastMergePolicyObservationFingerprint: lastMergePolicyObservation?.inputFingerprint ?? null,
      lastMergePolicyObservationStatus: lastMergePolicyObservation?.status ?? null,
      lastMergePolicyObservation,
      mergePolicyMerge: lifecycle?.merge ?? null,
      mergePolicyMergeGate: lifecycle?.mergeGate ?? null,
      mergePolicyMergeGateResults: lifecycle?.mergeGateResults ?? [],
      mergePolicyMergeConflict: lifecycle?.mergeConflict ?? null,
      mergePolicyLatestCompletionReport: mergePolicyLatestCompletionReport,
      mergePolicyLatestApprovalVerdict: mergePolicyLatestApprovalVerdict,
      mergePolicyReviewFeedback: lifecycle?.reviewFeedback ?? [],
      mergePolicyLatestCompletionRun,
      pendingPublicationApprovalRunId: pendingPublication?.pendingReport.runId ?? null,
      pendingPublicationApprovalReportId: pendingPublication?.pendingReport.id ?? null,
      pendingPublicationApprovalReason: pendingPublication === null ? null : lifecycle?.blockedReason ?? null,
      latestRunId: latestRun?.runId ?? pointers?.lastRunId ?? null,
      latestRunStatus: latestRun?.status ?? null,
      latestRunRole: latestRun?.role ?? null,
      latestRunPhase: latestRun?.runPhase ?? null,
      latestRunKind: latestRun?.runKind ?? null,
      latestRunCompletedAt: latestRun?.completedAt ?? null,
      latestRunError: latestRun?.error ?? null,
      latestPrUrl: pointers?.prUrl ?? latestRun?.prUrl ?? null,
      latestPrNumber: typeof latestPrNumber === "number" ? latestPrNumber : null,
      latestPrHeadSha: pointers?.prHeadSha ?? latestRun?.prHeadSha ?? null,
      latestPrBranch: pointers?.prBranch ?? latestRun?.prBranch ?? null,
      latestWorkspaceKey: pointers?.workspaceKey ?? latestRun?.workspaceKey ?? null,
      latestWorkspacePath: pointers?.workspacePath ?? latestRun?.workspacePath ?? null,
      latestGitBranchName: pointers?.gitBranchName ?? pointers?.branchName ?? latestRun?.gitBranchName ?? issue.branchName,
      running: runtime.running,
      runningRole: runningEntry?.role ?? null,
      runningRunPhase,
      runningRunKind: runningRunPhase === null ? null : runKindForPhase(runningRunPhase),
      runningManualDispatchStage: runningEntry?.manualDispatch?.stage ?? null,
      runningManualIgnoreState: runningEntry?.manualDispatch?.ignoreState === true,
      runningHasPendingPublicationApproval: pendingPublication !== null,
      runningCancellationRequested: runningEntry !== null && runningEntry.cancellationRequestedAt !== null,
      claimed: runtime.claimed,
      paused: runtime.paused,
      retrying: runtime.retrying,
      consecutiveSdkErrorFailures: countConsecutiveWorkerRuns(runs, isCountedSdkWaitErrorFailure),
      consecutiveInfraFailures: countConsecutiveWorkerRuns(runs, isCountedInfraFailure),
      recordCreatedAt: new Date().toISOString(),
      recordUpdatedAt: new Date().toISOString(),
    };
  }

  async buildSnapshot(
    issue: Issue,
    runtime: IssueCurrentStateRuntimeState,
    input: IssueCurrentStateSnapshotBuildInput,
  ): Promise<IssueCurrentStateSnapshot> {
    const current = await this.build(issue, runtime);
    const now = new Date().toISOString();
    return immutableIssueSnapshot({
      ...current,
      snapshotId: createIssueSnapshotId(),
      snapshotAt: now,
      triggerType: input.triggerType,
      triggerId: `${input.triggerType}:${randomUUID()}`,
      triggerAt: now,
      triggerSource: input.triggerSource,
      candidateSource: input.candidateSource,
      transitionRequestContext: input.transitionRequestContext,
      availableSlots: input.availableSlots,
      providerDispatchGateActive: input.providerDispatchGateActive,
      stateSlotAvailable: input.stateSlotAvailable,
      allowExistingClaim: input.allowExistingClaim,
      manualStage: input.manualStage,
      manualForceLabels: input.manualForceLabels,
      manualIgnoreState: input.manualIgnoreState,
      ...(input.snapshotPatch ?? {}),
    } satisfies IssueCurrentStateSnapshot);
  }
}

function latestLifecycleCompletionReport(lifecycle: IssueLifecycleRecord): IssueCompletionReportRecord | null {
  if (lifecycle.lastCompletionReportId) {
    const exact = lifecycle.completionReports.find((report) => report.id === lifecycle.lastCompletionReportId);
    if (exact) return exact;
  }
  return lifecycle.completionReports[lifecycle.completionReports.length - 1] ?? null;
}

function mergePolicyConfigFingerprint(config: ServiceConfig): string {
  return sha256Short(
    stableJson({
      mode: config.mergePolicy.mode,
      sourceStates: config.mergePolicy.sourceStates,
      doneState: config.mergePolicy.doneState,
      conflictsState: config.mergePolicy.conflictsState,
      requiredChecks: config.mergePolicy.requiredChecks,
      mergeMethod: config.mergePolicy.mergeMethod,
      noCiAllowed: config.mergePolicy.noCiAllowed,
      noCiEvidence: config.mergePolicy.noCiEvidence,
      missingCheckStabilizationMs: config.mergePolicy.missingCheckStabilizationMs,
      maxConflictFixTurns: config.mergePolicy.maxConflictFixTurns,
      mergeGateFailures: config.reviewLoop.failureLimits.mergeGateFailures,
    }),
  );
}

function mergePolicyObservationInputFingerprint(input: {
  issue: Issue;
  lifecycle: IssueLifecycleRecord | null;
  report: IssueCompletionReportRecord | null;
  verdict: IssueReviewVerdictRecord | null;
  configFingerprint: string;
}): string | null {
  if (input.lifecycle === null) return null;
  return sha256Short(
    stableJson({
      configFingerprint: input.configFingerprint,
      issueId: input.issue.id,
      trackerState: input.issue.state,
      trackerUpdatedAt: input.issue.updatedAt,
      lifecycleUpdatedAt: input.lifecycle.updatedAt,
      phase: input.lifecycle.phase,
      blockedReason: input.lifecycle.blockedReason,
      lastCompletionReportId: input.lifecycle.lastCompletionReportId,
      lastReviewVerdictId: input.lifecycle.lastReviewVerdictId,
      lastMergeGateResultId: input.lifecycle.lastMergeGateResultId ?? null,
      report: input.report
        ? {
            id: input.report.id,
            runId: input.report.runId,
            acceptedAt: input.report.acceptedAt,
            pullRequest: input.report.pullRequest,
          }
        : null,
      verdict: input.verdict
        ? {
            id: input.verdict.id,
            runId: input.verdict.runId,
            verdict: input.verdict.verdict,
            submittedAt: input.verdict.submittedAt,
          }
        : null,
      merge: input.lifecycle.merge,
      mergeGate: input.lifecycle.mergeGate,
      mergeGateResults: input.lifecycle.mergeGateResults ?? [],
      mergeConflict: input.lifecycle.mergeConflict,
      reviewFeedback: input.lifecycle.reviewFeedback,
      summaryPointers: input.lifecycle.summaryPointers,
    }),
  );
}

function latestMergePolicyObservationForFingerprint(
  history: readonly IssueHistorySnapshot[],
  fingerprint: string | null,
): MergePolicyObservation | null {
  if (fingerprint === null) return null;
  for (const snapshot of history.slice().reverse()) {
    if (snapshot.transitionKind !== "merge_policy_observe") continue;
    for (const action of snapshot.actions.slice().reverse()) {
      if (action.actionType !== "record_merge_policy_observation" || action.status !== "succeeded") continue;
      const observation = mergePolicyObservationFromUnknown(action.details);
      if (observation?.inputFingerprint === fingerprint) return observation;
    }
  }
  return null;
}

function planningRetryDueAtIso(lifecycle: IssueLifecycleRecord, config: ServiceConfig): string | null {
  if (lifecycle.planningFailureCount <= 0 || lifecycle.lastPlanningFailureAt === null) return null;
  const failedAtMs = Date.parse(lifecycle.lastPlanningFailureAt);
  if (!Number.isFinite(failedAtMs)) return null;
  return new Date(failedAtMs + planningRetryDelayMs(lifecycle.planningFailureCount, config)).toISOString();
}

function planningBackoffRemainingMs(lifecycle: IssueLifecycleRecord, config: ServiceConfig, nowMs = Date.now()): number {
  if (lifecycle.planningFailureCount <= 0 || lifecycle.lastPlanningFailureAt === null) return 0;
  const lastFailureMs = Date.parse(lifecycle.lastPlanningFailureAt);
  if (!Number.isFinite(lastFailureMs)) return 0;
  const dueMs = lastFailureMs + planningRetryDelayMs(lifecycle.planningFailureCount, config);
  return Math.max(dueMs - nowMs, 0);
}

function planningRetryDelayMs(failureCount: number, config: ServiceConfig): number {
  return Math.min(
    config.issueBreakdown.planningRetryBaseMs * 2 ** Math.max(failureCount - 1, 0),
    config.issueBreakdown.planningRetryMaxMs,
  );
}

function countConsecutiveWorkerRuns(runs: RunRecord[], predicate: (run: RunRecord) => boolean): number {
  const seen = new Set<string>();
  const workerRuns = runs
    .filter((run) => run.role === "worker" && !seen.has(run.runId) && seen.add(run.runId))
    .sort(compareRunChronology);
  let count = 0;
  for (const run of workerRuns.slice().reverse()) {
    if (!predicate(run)) break;
    count += 1;
  }
  return count;
}

function isCountedSdkWaitErrorFailure(run: RunRecord): boolean {
  return (
    run.role === "worker" &&
    run.status === "failed" &&
    run.completedAt !== null &&
    run.sdkRunStatus === "error" &&
    run.sdkRunStatusSource === "wait" &&
    run.cancellationRequestedAt == null &&
    (run.cancellationOutcome ?? "none") === "none" &&
    run.cancelFailed !== true &&
    run.error !== OPERATOR_REJECTED_PUBLICATION_ERROR
  );
}

const INFRA_FAILURE_DIAGNOSTIC_CODES = new Set([
  "hermes_gateway_exit",
  "hermes_run_error",
  "hermes_gateway_start_timeout",
  "hermes_gateway_protocol_error",
  "hermes_gateway_error",
  "hermes_acp_run_error",
]);

function isCountedInfraFailure(run: RunRecord): boolean {
  return (
    run.role === "worker" &&
    run.status === "failed" &&
    run.completedAt !== null &&
    run.cancellationRequestedAt == null &&
    (run.cancellationOutcome ?? "none") === "none" &&
    run.cancelFailed !== true &&
    run.error !== OPERATOR_REJECTED_PUBLICATION_ERROR &&
    run.failureKind === "harness_diagnostic" &&
    isInfraFailureDiagnosticCode(run.failureDiagnosticCode)
  );
}

function isInfraFailureDiagnosticCode(code: string | null | undefined): boolean {
  return typeof code === "string" && INFRA_FAILURE_DIAGNOSTIC_CODES.has(code);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Short(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

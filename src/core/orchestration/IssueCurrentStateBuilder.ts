import { createHash, randomUUID } from "node:crypto";
import type { ServiceConfig } from "../config/Config.js";
import type { IssueBaseRefObservation } from "../BaseRefVerification.js";
import { errorMessage } from "../errors.js";
import type { Logger } from "../logging/StructuredLogger.js";
import { pendingPublicationHandoffForRun } from "../CompletionReportService.js";
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
  type IssueMergeConflictMetadata,
  type IssueMergeGateResultRecord,
  type IssueMergeGateState,
  type IssueMergeMetadata,
  type IssuePreservedWorktreeStash,
  type IssueReviewFeedbackRecord,
  type IssueReviewVerdictRecord,
} from "../persistence/IssueLifecycleStore.js";
import {
  compareRunChronology,
  type RunRecord,
  type RunTranscriptStore,
} from "../persistence/RunTranscriptStore.js";
import {
  runKindForPhase,
  type AgentRunKind,
  type AgentRunPhase,
  type AgentRunRole,
  type Issue,
  type TokenCounts,
} from "../types.js";
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
  retryDueAt?: string | null;
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
  historyBackedFieldGroups?: readonly IssueCurrentStateHistoryFieldGroup[];
  compareHistoryBackedFieldGroups?: readonly IssueCurrentStateHistoryFieldGroup[];
}

export type IssueCurrentStateHistoryFieldGroup =
  | "tracker"
  | "runSummary"
  | "lifecycleCore"
  | "lifecycleReports"
  | "lifecyclePublication"
  | "lifecycleMergePolicy"
  | "lifecycleBreakdown"
  | "lifecycleTriage"
  | "lifecyclePostMortem"
  | "mergePolicyCompletionRun"
  | "runtimeControl";

export const HISTORY_BACKED_FIELD_GROUPS: readonly IssueCurrentStateHistoryFieldGroup[] =
  [
    "tracker",
    "runSummary",
    "mergePolicyCompletionRun",
    "lifecycleCore",
    "lifecycleReports",
    "lifecyclePublication",
    "lifecycleMergePolicy",
    "lifecycleBreakdown",
    "lifecycleTriage",
    "lifecyclePostMortem",
    "runtimeControl",
  ];

export interface IssueCurrentStateHistoryRebuildResult {
  fields: Partial<IssueCurrentFields>;
  incompleteGroups: IssueCurrentStateHistoryFieldGroup[];
  sourceSnapshotIds: string[];
  sourceSnapshotIdsByGroup: Partial<
    Record<IssueCurrentStateHistoryFieldGroup, string[]>
  >;
}

type IssueBreakdownPlan = IssueLifecycleRecord["issueBreakdownPlans"][number];
type IssueTriageReport = IssueLifecycleRecord["issueTriageReports"][number];
type IssuePostMortemReport = IssueLifecycleRecord["postMortemReports"][number];
type PendingPublicationHandoff = ReturnType<
  typeof pendingPublicationHandoffForRun
>;

type TrackerFields = Pick<
  IssueCurrentFields,
  | "issueId"
  | "issueIdentifier"
  | "title"
  | "description"
  | "priority"
  | "trackerState"
  | "branchName"
  | "trackerUrl"
  | "assigneeId"
  | "delegateId"
  | "assignedToWorker"
  | "labels"
  | "blockedBy"
  | "hasChildren"
  | "trackerCreatedAt"
  | "trackerUpdatedAt"
  | "currentIssueContentFingerprint"
>;

type LifecycleFields = Pick<
  IssueCurrentFields,
  | "phase"
  | "reviewRound"
  | "incompleteTurnCount"
  | "planningFailureCount"
  | "planningDispatchRetryCount"
  | "lastPlanningFailureAt"
  | "planningRetryDueAt"
  | "blockedReason"
  | "lastIssueBreakdownPlanId"
  | "lastIssueBreakdownPlanApplicationStatus"
  | "lastIssueBreakdownPlanIssueContentFingerprint"
  | "lastIssueBreakdownPlanConfigFingerprint"
  | "lastIssueBreakdownPlanSatisfiesCurrentValidation"
  | "lastIssueTriageReportId"
  | "lastIssueTriageReportTriggerFingerprint"
  | "lastIssueTriageReportWritebackOperationKeys"
  | "currentIssueTriageTriggerFingerprint"
  | "issueTriageCurrentTriggerReportIds"
  | "latestIssueTriageReportBlockers"
  | "lastPostMortemReportId"
  | "lastPostMortemReportTriggerFingerprint"
  | "lastPostMortemReportWritebackOperationKeys"
  | "currentPostMortemTriggerFingerprint"
  | "postMortemCurrentTriggerReportIds"
  | "lastCompletionReportId"
  | "lastCompletionReportRejectionId"
  | "lastReviewVerdictId"
  | "lastMergeGateResultId"
  | "latestCompletionReport"
  | "latestApprovalPassVerdict"
  | "mergeGate"
  | "mergeConflict"
  | "lifecycleSummaryCiStatus"
  | "activePreservedWorktreeStashes"
  | "mergePolicyMerge"
  | "mergePolicyMergeGate"
  | "mergePolicyMergeGateResults"
  | "mergePolicyMergeConflict"
  | "mergePolicyLatestCompletionReport"
  | "mergePolicyLatestApprovalVerdict"
  | "mergePolicyReviewFeedback"
  | "pendingPublicationApprovalRunId"
  | "pendingPublicationApprovalReportId"
  | "pendingPublicationApprovalReason"
>;

type LifecycleCoreFields = Pick<
  LifecycleFields,
  | "phase"
  | "reviewRound"
  | "incompleteTurnCount"
  | "planningFailureCount"
  | "planningDispatchRetryCount"
  | "lastPlanningFailureAt"
  | "planningRetryDueAt"
  | "blockedReason"
  | "lastCompletionReportId"
  | "lastReviewVerdictId"
  | "lastMergeGateResultId"
  | "lifecycleSummaryCiStatus"
>;

type LifecycleReportFields = Pick<
  LifecycleFields,
  | "lastCompletionReportRejectionId"
  | "latestCompletionReport"
  | "latestApprovalPassVerdict"
  | "mergePolicyLatestCompletionReport"
  | "mergePolicyLatestApprovalVerdict"
>;

type LifecyclePublicationFields = Pick<
  LifecycleFields,
  | "pendingPublicationApprovalRunId"
  | "pendingPublicationApprovalReportId"
  | "pendingPublicationApprovalReason"
>;

type LifecycleMergePolicyFields = Pick<
  LifecycleFields,
  | "mergeGate"
  | "mergeConflict"
  | "mergePolicyMerge"
  | "mergePolicyMergeGate"
  | "mergePolicyMergeGateResults"
  | "mergePolicyMergeConflict"
  | "activePreservedWorktreeStashes"
  | "mergePolicyReviewFeedback"
>;

type LifecycleBreakdownFields = Pick<
  LifecycleFields,
  | "lastIssueBreakdownPlanId"
  | "lastIssueBreakdownPlanApplicationStatus"
  | "lastIssueBreakdownPlanIssueContentFingerprint"
  | "lastIssueBreakdownPlanConfigFingerprint"
  | "lastIssueBreakdownPlanSatisfiesCurrentValidation"
>;

type LifecycleTriageFields = Pick<
  LifecycleFields,
  | "lastIssueTriageReportId"
  | "lastIssueTriageReportTriggerFingerprint"
  | "lastIssueTriageReportWritebackOperationKeys"
  | "currentIssueTriageTriggerFingerprint"
  | "issueTriageCurrentTriggerReportIds"
  | "latestIssueTriageReportBlockers"
>;

type LifecyclePostMortemFields = Pick<
  LifecycleFields,
  | "lastPostMortemReportId"
  | "lastPostMortemReportTriggerFingerprint"
  | "lastPostMortemReportWritebackOperationKeys"
  | "currentPostMortemTriggerFingerprint"
  | "postMortemCurrentTriggerReportIds"
>;

type ConfigFields = Pick<
  IssueCurrentFields,
  | "currentIssueBreakdownConfigFingerprint"
  | "lifecyclePersistenceAvailable"
  | "mergePolicyMode"
  | "mergePolicySourceStates"
  | "mergePolicyDoneState"
  | "mergePolicyConflictsState"
  | "mergePolicyRequiredChecks"
  | "mergePolicyMaxMergeGateFailures"
  | "mergePolicyConfigFingerprint"
>;

type HistoryFields = Pick<
  IssueCurrentFields,
  | "currentMergePolicyObservationInputFingerprint"
  | "lastMergePolicyObservationFingerprint"
  | "lastMergePolicyObservationStatus"
  | "lastMergePolicyObservation"
  | "latestBaseRef"
  | "lastBaseRefObservationFingerprint"
  | "lastBaseRefObservationClassification"
  | "lastBaseRefObservation"
>;

type RunFields = Pick<
  IssueCurrentFields,
  | "mergePolicyLatestCompletionRun"
  | "latestRunId"
  | "latestRunStatus"
  | "latestRunRole"
  | "latestRunPhase"
  | "latestRunKind"
  | "latestRunCompletedAt"
  | "latestRunError"
  | "latestPrUrl"
  | "latestPrNumber"
  | "latestPrHeadSha"
  | "latestPrBranch"
  | "latestWorkspaceKey"
  | "latestWorkspacePath"
  | "latestGitBranchName"
  | "consecutiveSdkErrorFailures"
  | "consecutiveInfraFailures"
>;
type RunSummaryFields = Omit<RunFields, "mergePolicyLatestCompletionRun">;
type MergePolicyCompletionRunFields = Pick<
  RunFields,
  "mergePolicyLatestCompletionRun"
>;

type RuntimeFields = Pick<
  IssueCurrentFields,
  | "running"
  | "runningRole"
  | "runningRunPhase"
  | "runningRunKind"
  | "runningManualDispatchStage"
  | "runningManualIgnoreState"
  | "runningHasPendingPublicationApproval"
  | "runningCancellationRequested"
  | "claimed"
  | "paused"
  | "retrying"
  | "runtimeRetryDueAt"
>;

type TriggerFields = Omit<IssueCurrentStateSnapshot, keyof IssueCurrentFields>;

interface IssueCurrentStateBuildContext {
  issue: Issue;
  runtime: IssueCurrentStateRuntimeState;
  lifecycle: IssueLifecycleRecord | null;
  runs: RunRecord[];
  latestRun: RunRecord | null;
  pointers: IssueLifecycleRecord["summaryPointers"] | null;
  lastIssueBreakdownPlan: IssueBreakdownPlan | null;
  currentIssueFingerprint: string;
  currentIssueBreakdownFingerprint: string;
  currentIssueTriageFingerprint: string | null;
  issueTriageCurrentTriggerReports: IssueTriageReport[];
  lastIssueTriageReport: IssueTriageReport | null;
  latestAnyIssueTriageReport: IssueTriageReport | null;
  currentPostMortemFingerprint: string | null;
  postMortemCurrentTriggerReports: IssuePostMortemReport[];
  lastPostMortemReport: IssuePostMortemReport | null;
  mergePolicyConfigHash: string;
  mergePolicyLatestCompletionReport: IssueCompletionReportRecord | null;
  mergePolicyLatestApprovalVerdict: IssueReviewVerdictRecord | null;
  mergePolicyObservationFingerprint: string | null;
  lastMergePolicyObservation: MergePolicyObservation | null;
  mergePolicyLatestCompletionRun: RunRecord | null;
  pendingPublication: PendingPublicationHandoff;
  runningEntry: IssueCurrentStateRuntimeEntry | null;
  runningRunPhase: AgentRunPhase | null;
  history: IssueHistorySnapshot[];
}

interface IssueHistoryEvidenceBuildContext {
  history: IssueHistorySnapshot[];
  issue: Issue | null;
  lifecycle: IssueLifecycleRecord | null;
  freshness: IssueHistoryEvidenceFreshnessContext;
  runtime: IssueCurrentStateRuntimeState | null;
  runningEntry: IssueCurrentStateRuntimeEntry | null;
  mergePolicyLatestCompletionReport: IssueCompletionReportRecord | null;
  mergePolicyLatestApprovalVerdict: IssueReviewVerdictRecord | null;
  pendingPublication: PendingPublicationHandoff;
  currentIssueTriageFingerprint: string | null;
  currentPostMortemFingerprint: string | null;
}

interface IssueHistoryEvidenceFreshnessContext {
  issueId: string | null;
  issueUpdatedAt: string | null;
  lifecycleUpdatedAt: string | null;
  latestRunId: string | null;
  runningHasPendingPublicationApproval: boolean | null;
}

interface HistoryBackedGroupFields {
  tracker?: TrackerFields;
  runSummary?: RunSummaryFields;
  lifecycleCore?: LifecycleCoreFields;
  lifecycleReports?: LifecycleReportFields;
  lifecyclePublication?: LifecyclePublicationFields;
  lifecycleMergePolicy?: LifecycleMergePolicyFields;
  lifecycleBreakdown?: LifecycleBreakdownFields;
  lifecycleTriage?: LifecycleTriageFields;
  lifecyclePostMortem?: LifecyclePostMortemFields;
  mergePolicyCompletionRun?: MergePolicyCompletionRunFields;
  runtimeControl?: RuntimeFields;
}

interface HistoryBackedGroupResult {
  fields: HistoryBackedGroupFields;
  incompleteGroups: IssueCurrentStateHistoryFieldGroup[];
  sourceSnapshotIds: string[];
  sourceSnapshotIdsByGroup: Partial<
    Record<IssueCurrentStateHistoryFieldGroup, string[]>
  >;
}

interface HistoryRunSummary {
  runId: string;
  sequence: number;
  sourceSnapshotIds: string[];
  status: string | null;
  role: string | null;
  runPhase: string | null;
  runKind: string | null;
  completedAt: string | null;
  error: string | null;
  prUrl: string | null;
  prNumber: number | null;
  prHeadSha: string | null;
  prBranch: string | null;
  workspaceKey: string | null;
  workspacePath: string | null;
  gitBranchName: string | null;
  sdkRunStatus: string | null;
  sdkRunStatusSource: string | null;
  cancellationRequestedAt: string | null;
  cancellationOutcome: string | null;
  cancelFailed: boolean;
  failureKind: string | null;
  failureDiagnosticCode: string | null;
  sessionId: string | null;
  agentId: string | null;
  prompt: string | null;
  promptCharCount: number | null;
  startedAt: string | null;
  updatedAt: string | null;
  tokens: TokenCounts | null;
  attempt: number | null;
  turnNumber: number | null;
  harnessId: string | null;
  promptTemplateKeys: string[] | null;
}

interface HistoryRuntimeControlSummary {
  sourceSnapshotIds: string[];
  running: boolean;
  runningRole: AgentRunRole | null;
  runningRunPhase: AgentRunPhase | null;
  runningManualDispatchStage: string | null;
  runningManualIgnoreState: boolean;
  runningCancellationRequested: boolean;
  claimed: boolean;
  paused: boolean;
  retrying: boolean;
  runtimeRetryDueAt: string | null;
}

export class IssueCurrentStateBuilder {
  constructor(private readonly options: IssueCurrentStateBuilderOptions) {}

  async build(
    issue: Issue,
    runtime: IssueCurrentStateRuntimeState,
  ): Promise<IssueCurrentFields> {
    const useHistoryBackedFields = this.shouldUseHistoryBackedFields();
    const context = await this.loadBuildContext(issue, runtime, {
      includeHistory: useHistoryBackedFields,
    });
    const now = new Date().toISOString();
    const storeBuilt = this.buildFromStores(context, now);
    if (!useHistoryBackedFields) return storeBuilt;
    const historyBuilt = this.buildFromHistory(context);
    this.compareHistoryBackedFields(storeBuilt, historyBuilt);
    return this.applyHistoryBackedFields(storeBuilt, historyBuilt);
  }

  async rebuildHistoryBackedFields(
    issue: Issue,
    runtime: IssueCurrentStateRuntimeState,
    groups: readonly IssueCurrentStateHistoryFieldGroup[] = HISTORY_BACKED_FIELD_GROUPS,
  ): Promise<IssueCurrentStateHistoryRebuildResult> {
    const context = await this.loadBuildContext(issue, runtime, {
      includeHistory: true,
    });
    const historyBuilt = this.buildFromHistory(context);
    return selectHistoryBackedGroups(historyBuilt, groups);
  }

  private shouldUseHistoryBackedFields(): boolean {
    return (
      (this.options.historyBackedFieldGroups?.length ?? 0) > 0 ||
      (this.options.compareHistoryBackedFieldGroups?.length ?? 0) > 0
    );
  }

  async rebuildHistoryBackedFieldsFromStoredHistory(
    issueIdOrIdentifier: string,
    groups: readonly IssueCurrentStateHistoryFieldGroup[] = HISTORY_BACKED_FIELD_GROUPS,
  ): Promise<IssueCurrentStateHistoryRebuildResult> {
    const history =
      (await this.options.issueStateStore
        .getHistory(issueIdOrIdentifier)
        .catch(() => null)) ?? [];
    const historyBuilt = this.buildFromHistoryEvidence(
      buildHistoryEvidenceContext(history),
    );
    return selectHistoryBackedGroups(historyBuilt, groups);
  }

  private buildFromStores(
    context: IssueCurrentStateBuildContext,
    now: string,
  ): IssueCurrentFields {
    return {
      version: 1,
      ...this.buildTrackerFields(context),
      ...this.buildLifecycleFields(context),
      ...this.buildConfigFields(context),
      ...this.buildHistoryFields(context),
      ...this.buildRunFields(context),
      ...this.buildRuntimeFields(context),
      recordCreatedAt: now,
      recordUpdatedAt: now,
    } satisfies IssueCurrentFields;
  }

  private buildFromHistory(
    context: IssueCurrentStateBuildContext,
  ): HistoryBackedGroupResult {
    return this.buildFromHistoryEvidence(
      buildHistoryEvidenceContext(context.history, {
        issue: context.issue,
        lifecycle: context.lifecycle,
        latestRunId:
          context.latestRun?.runId ?? context.pointers?.lastRunId ?? null,
        runningHasPendingPublicationApproval:
          context.pendingPublication !== null,
        runtime: context.runtime,
        runningEntry: context.runningEntry,
      }),
    );
  }

  private buildFromHistoryEvidence(
    context: IssueHistoryEvidenceBuildContext,
  ): HistoryBackedGroupResult {
    const tracker = this.buildTrackerFieldsFromHistory(context);
    const runSummary = this.buildRunSummaryFieldsFromHistory(context);
    const mergePolicyCompletionRun =
      this.buildMergePolicyCompletionRunFieldsFromHistory(context);
    const lifecycleCore = this.buildLifecycleCoreFieldsFromHistory(context);
    const lifecycleReports =
      this.buildLifecycleReportFieldsFromHistory(context);
    const lifecyclePublication =
      this.buildLifecyclePublicationFieldsFromHistory(context);
    const lifecycleMergePolicy =
      this.buildLifecycleMergePolicyFieldsFromHistory(context);
    const lifecycleBreakdown =
      this.buildLifecycleBreakdownFieldsFromHistory(context);
    const lifecycleTriage = this.buildLifecycleTriageFieldsFromHistory(context);
    const lifecyclePostMortem =
      this.buildLifecyclePostMortemFieldsFromHistory(context);
    const runtimeControl = this.buildRuntimeControlFieldsFromHistory(context);
    const trackerSourceSnapshotIds =
      tracker.sourceSnapshotId === null ? [] : [tracker.sourceSnapshotId];
    const mergePolicyCompletionRunSourceSnapshotIds =
      mergePolicyCompletionRun.sourceSnapshotIds;
    const lifecycleCoreSourceSnapshotIds =
      lifecycleCore.sourceSnapshotId === null
        ? []
        : [lifecycleCore.sourceSnapshotId];
    const lifecycleReportSourceSnapshotIds =
      lifecycleReports.sourceSnapshotId === null
        ? []
        : [lifecycleReports.sourceSnapshotId];
    const lifecyclePublicationSourceSnapshotIds =
      lifecyclePublication.sourceSnapshotId === null
        ? []
        : [lifecyclePublication.sourceSnapshotId];
    const lifecycleMergePolicySourceSnapshotIds =
      lifecycleMergePolicy.sourceSnapshotId === null
        ? []
        : [lifecycleMergePolicy.sourceSnapshotId];
    const lifecycleBreakdownSourceSnapshotIds =
      lifecycleBreakdown.sourceSnapshotId === null
        ? []
        : [lifecycleBreakdown.sourceSnapshotId];
    const lifecycleTriageSourceSnapshotIds =
      lifecycleTriage.sourceSnapshotId === null
        ? []
        : [lifecycleTriage.sourceSnapshotId];
    const lifecyclePostMortemSourceSnapshotIds =
      lifecyclePostMortem.sourceSnapshotId === null
        ? []
        : [lifecyclePostMortem.sourceSnapshotId];
    const runtimeControlSourceSnapshotIds = runtimeControl.sourceSnapshotIds;
    return {
      fields: {
        ...(tracker.fields === null ? {} : { tracker: tracker.fields }),
        ...(runSummary.fields === null
          ? {}
          : { runSummary: runSummary.fields }),
        ...(mergePolicyCompletionRun.fields === null
          ? {}
          : { mergePolicyCompletionRun: mergePolicyCompletionRun.fields }),
        ...(lifecycleCore.fields === null
          ? {}
          : { lifecycleCore: lifecycleCore.fields }),
        ...(lifecycleReports.fields === null
          ? {}
          : { lifecycleReports: lifecycleReports.fields }),
        ...(lifecyclePublication.fields === null
          ? {}
          : { lifecyclePublication: lifecyclePublication.fields }),
        ...(lifecycleMergePolicy.fields === null
          ? {}
          : { lifecycleMergePolicy: lifecycleMergePolicy.fields }),
        ...(lifecycleBreakdown.fields === null
          ? {}
          : { lifecycleBreakdown: lifecycleBreakdown.fields }),
        ...(lifecycleTriage.fields === null
          ? {}
          : { lifecycleTriage: lifecycleTriage.fields }),
        ...(lifecyclePostMortem.fields === null
          ? {}
          : { lifecyclePostMortem: lifecyclePostMortem.fields }),
        ...(runtimeControl.fields === null
          ? {}
          : { runtimeControl: runtimeControl.fields }),
      },
      incompleteGroups: [
        ...(tracker.complete ? [] : (["tracker"] as const)),
        ...(runSummary.complete ? [] : (["runSummary"] as const)),
        ...(mergePolicyCompletionRun.complete
          ? []
          : (["mergePolicyCompletionRun"] as const)),
        ...(lifecycleCore.complete ? [] : (["lifecycleCore"] as const)),
        ...(lifecycleReports.complete ? [] : (["lifecycleReports"] as const)),
        ...(lifecyclePublication.complete
          ? []
          : (["lifecyclePublication"] as const)),
        ...(lifecycleMergePolicy.complete
          ? []
          : (["lifecycleMergePolicy"] as const)),
        ...(lifecycleBreakdown.complete
          ? []
          : (["lifecycleBreakdown"] as const)),
        ...(lifecycleTriage.complete ? [] : (["lifecycleTriage"] as const)),
        ...(lifecyclePostMortem.complete
          ? []
          : (["lifecyclePostMortem"] as const)),
        ...(runtimeControl.complete ? [] : (["runtimeControl"] as const)),
      ],
      sourceSnapshotIds: [
        ...trackerSourceSnapshotIds,
        ...runSummary.sourceSnapshotIds,
        ...mergePolicyCompletionRunSourceSnapshotIds,
        ...lifecycleCoreSourceSnapshotIds,
        ...lifecycleReportSourceSnapshotIds,
        ...lifecyclePublicationSourceSnapshotIds,
        ...lifecycleMergePolicySourceSnapshotIds,
        ...lifecycleBreakdownSourceSnapshotIds,
        ...lifecycleTriageSourceSnapshotIds,
        ...lifecyclePostMortemSourceSnapshotIds,
        ...runtimeControlSourceSnapshotIds,
      ],
      sourceSnapshotIdsByGroup: {
        tracker: trackerSourceSnapshotIds,
        runSummary: runSummary.sourceSnapshotIds,
        mergePolicyCompletionRun: mergePolicyCompletionRunSourceSnapshotIds,
        lifecycleCore: lifecycleCoreSourceSnapshotIds,
        lifecycleReports: lifecycleReportSourceSnapshotIds,
        lifecyclePublication: lifecyclePublicationSourceSnapshotIds,
        lifecycleMergePolicy: lifecycleMergePolicySourceSnapshotIds,
        lifecycleBreakdown: lifecycleBreakdownSourceSnapshotIds,
        lifecycleTriage: lifecycleTriageSourceSnapshotIds,
        lifecyclePostMortem: lifecyclePostMortemSourceSnapshotIds,
        runtimeControl: runtimeControlSourceSnapshotIds,
      },
    };
  }

  private buildTrackerFieldsFromHistory(
    context: IssueHistoryEvidenceBuildContext,
  ):
    | { complete: true; fields: TrackerFields; sourceSnapshotId: string }
    | { complete: false; fields: null; sourceSnapshotId: string | null } {
    const snapshot = latestTrackerObservationSnapshot(context.history);
    if (snapshot === null) {
      return { complete: false, fields: null, sourceSnapshotId: null };
    }
    if (!historyTrackerObservationFresh(context, snapshot)) {
      return {
        complete: false,
        fields: null,
        sourceSnapshotId: snapshot.historySnapshotId,
      };
    }
    const issue = issueFromTrackerObservationSnapshot(snapshot);
    if (issue === null) {
      return {
        complete: false,
        fields: null,
        sourceSnapshotId: snapshot.historySnapshotId,
      };
    }
    return {
      complete: true,
      sourceSnapshotId: snapshot.historySnapshotId,
      fields: {
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
        currentIssueContentFingerprint: issueContentFingerprint(issue),
      },
    };
  }

  private buildRunSummaryFieldsFromHistory(
    context: IssueHistoryEvidenceBuildContext,
  ):
    | {
        complete: true;
        fields: RunSummaryFields;
        sourceSnapshotIds: string[];
      }
    | { complete: false; fields: null; sourceSnapshotIds: string[] } {
    const runs = buildRunSummariesFromHistory(context.history);
    const latestRun = runs.at(-1) ?? null;
    if (latestRun === null) {
      return { complete: false, fields: null, sourceSnapshotIds: [] };
    }
    if (
      context.freshness.latestRunId !== null &&
      latestRun.runId !== context.freshness.latestRunId
    ) {
      return {
        complete: false,
        fields: null,
        sourceSnapshotIds: latestRun.sourceSnapshotIds,
      };
    }
    return {
      complete: true,
      sourceSnapshotIds: latestRun.sourceSnapshotIds,
      fields: {
        latestRunId: latestRun.runId,
        latestRunStatus: latestRun.status,
        latestRunRole: latestRun.role,
        latestRunPhase: latestRun.runPhase,
        latestRunKind: latestRun.runKind,
        latestRunCompletedAt: latestRun.completedAt,
        latestRunError: latestRun.error,
        latestPrUrl: latestRun.prUrl,
        latestPrNumber: latestRun.prNumber,
        latestPrHeadSha: latestRun.prHeadSha,
        latestPrBranch: latestRun.prBranch,
        latestWorkspaceKey: latestRun.workspaceKey,
        latestWorkspacePath: latestRun.workspacePath,
        latestGitBranchName:
          latestRun.gitBranchName ??
          latestRun.prBranch ??
          context.issue?.branchName ??
          null,
        consecutiveSdkErrorFailures: countConsecutiveHistoryWorkerRuns(
          runs,
          isCountedHistorySdkWaitErrorFailure,
        ),
        consecutiveInfraFailures: countConsecutiveHistoryWorkerRuns(
          runs,
          isCountedHistoryInfraFailure,
        ),
      },
    };
  }

  private buildMergePolicyCompletionRunFieldsFromHistory(
    context: IssueHistoryEvidenceBuildContext,
  ):
    | {
        complete: true;
        fields: MergePolicyCompletionRunFields;
        sourceSnapshotIds: string[];
      }
    | { complete: false; fields: null; sourceSnapshotIds: string[] } {
    const lifecycleSnapshot = latestLifecycleMutationSnapshot(context.history);
    if (!historyLifecycleMutationFresh(context, lifecycleSnapshot)) {
      return {
        complete: false,
        fields: null,
        sourceSnapshotIds:
          lifecycleSnapshot === null
            ? []
            : [lifecycleSnapshot.historySnapshotId],
      };
    }
    const report = context.mergePolicyLatestCompletionReport;
    if (report === null) {
      return {
        complete: true,
        fields: { mergePolicyLatestCompletionRun: null },
        sourceSnapshotIds: [],
      };
    }
    const runs = buildRunSummariesFromHistory(context.history);
    const run = runs.find((candidate) => candidate.runId === report.runId);
    if (run === undefined) {
      return { complete: false, fields: null, sourceSnapshotIds: [] };
    }
    const record = runRecordFromHistorySummary(
      context.issue ?? {
        id: report.issueId,
        identifier: report.issueIdentifier,
      },
      run,
    );
    if (record === null) {
      return {
        complete: false,
        fields: null,
        sourceSnapshotIds: run.sourceSnapshotIds,
      };
    }
    return {
      complete: true,
      sourceSnapshotIds: run.sourceSnapshotIds,
      fields: { mergePolicyLatestCompletionRun: record },
    };
  }

  private buildLifecycleCoreFieldsFromHistory(
    context: IssueHistoryEvidenceBuildContext,
  ):
    | {
        complete: true;
        fields: LifecycleCoreFields;
        sourceSnapshotId: string;
      }
    | { complete: false; fields: null; sourceSnapshotId: string | null } {
    const snapshot = latestLifecycleMutationSnapshot(context.history);
    if (snapshot === null) {
      return { complete: false, fields: null, sourceSnapshotId: null };
    }
    if (!historyLifecycleMutationFresh(context, snapshot)) {
      return {
        complete: false,
        fields: null,
        sourceSnapshotId: snapshot.historySnapshotId,
      };
    }
    const phase = stringFromUnknown(snapshot.lifecyclePhase);
    const reviewRound = numberFromUnknown(snapshot.lifecycleReviewRound);
    const incompleteTurnCount = numberFromUnknown(
      snapshot.lifecycleIncompleteTurnCount,
    );
    const planningFailureCount = numberFromUnknown(
      snapshot.lifecyclePlanningFailureCount,
    );
    const planningDispatchRetryCount = numberFromUnknown(
      snapshot.lifecyclePlanningDispatchRetryCount,
    );
    if (
      phase === null ||
      reviewRound === null ||
      incompleteTurnCount === null ||
      planningFailureCount === null ||
      planningDispatchRetryCount === null
    ) {
      return {
        complete: false,
        fields: null,
        sourceSnapshotId: snapshot.historySnapshotId,
      };
    }
    const lastPlanningFailureAt = stringFromUnknown(
      snapshot.lifecycleLastPlanningFailureAt,
    );
    return {
      complete: true,
      sourceSnapshotId: snapshot.historySnapshotId,
      fields: {
        phase,
        reviewRound,
        incompleteTurnCount,
        planningFailureCount,
        planningDispatchRetryCount,
        lastPlanningFailureAt,
        planningRetryDueAt: planningRetryDueAtIsoForValues(
          planningFailureCount,
          lastPlanningFailureAt,
          this.options.config,
        ),
        blockedReason: stringFromUnknown(snapshot.lifecycleBlockedReason),
        lastCompletionReportId: stringFromUnknown(
          snapshot.lifecycleLastCompletionReportId,
        ),
        lastReviewVerdictId: stringFromUnknown(
          snapshot.lifecycleLastReviewVerdictId,
        ),
        lastMergeGateResultId: stringFromUnknown(
          snapshot.lifecycleLastMergeGateResultId,
        ),
        lifecycleSummaryCiStatus: stringFromUnknown(
          snapshot.lifecycleSummaryCiStatus,
        ),
      },
    };
  }

  private buildLifecycleReportFieldsFromHistory(
    context: IssueHistoryEvidenceBuildContext,
  ):
    | {
        complete: true;
        fields: LifecycleReportFields;
        sourceSnapshotId: string;
      }
    | { complete: false; fields: null; sourceSnapshotId: string | null } {
    const snapshot = latestLifecycleMutationSnapshot(context.history);
    if (snapshot === null) {
      return { complete: false, fields: null, sourceSnapshotId: null };
    }
    if (!historyLifecycleMutationFresh(context, snapshot)) {
      return {
        complete: false,
        fields: null,
        sourceSnapshotId: snapshot.historySnapshotId,
      };
    }
    const lastCompletionReportRejectionId = stringFromUnknown(
      snapshot.lifecycleLastCompletionReportRejectionId,
    );
    const latestCompletionReport =
      recordFromUnknown<IssueCompletionReportRecord>(
        snapshot.lifecycleLatestCompletionReport,
      );
    const latestApprovalPassVerdict =
      recordFromUnknown<IssueReviewVerdictRecord>(
        snapshot.lifecycleLatestApprovalPassVerdict,
      );
    return {
      complete: true,
      sourceSnapshotId: snapshot.historySnapshotId,
      fields: {
        lastCompletionReportRejectionId,
        latestCompletionReport,
        latestApprovalPassVerdict,
        mergePolicyLatestCompletionReport: latestCompletionReport,
        mergePolicyLatestApprovalVerdict: latestApprovalPassVerdict,
      },
    };
  }

  private buildLifecyclePublicationFieldsFromHistory(
    context: IssueHistoryEvidenceBuildContext,
  ):
    | {
        complete: true;
        fields: LifecyclePublicationFields;
        sourceSnapshotId: string;
      }
    | { complete: false; fields: null; sourceSnapshotId: string | null } {
    const snapshot = latestLifecycleMutationSnapshot(context.history);
    if (snapshot === null) {
      return { complete: false, fields: null, sourceSnapshotId: null };
    }
    if (!historyLifecycleMutationFresh(context, snapshot)) {
      return {
        complete: false,
        fields: null,
        sourceSnapshotId: snapshot.historySnapshotId,
      };
    }
    const pendingPublicationApprovalRunId = stringFromUnknown(
      snapshot.lifecyclePendingPublicationApprovalRunId,
    );
    const pendingPublicationApprovalReportId = stringFromUnknown(
      snapshot.lifecyclePendingPublicationApprovalReportId,
    );
    const pendingPublicationApprovalReason = stringFromUnknown(
      snapshot.lifecyclePendingPublicationApprovalReason,
    );
    return {
      complete: true,
      sourceSnapshotId: snapshot.historySnapshotId,
      fields: {
        pendingPublicationApprovalRunId,
        pendingPublicationApprovalReportId,
        pendingPublicationApprovalReason,
      },
    };
  }

  private buildLifecycleMergePolicyFieldsFromHistory(
    context: IssueHistoryEvidenceBuildContext,
  ):
    | {
        complete: true;
        fields: LifecycleMergePolicyFields;
        sourceSnapshotId: string;
      }
    | { complete: false; fields: null; sourceSnapshotId: string | null } {
    const snapshot = latestLifecycleMutationSnapshot(context.history);
    if (snapshot === null) {
      return { complete: false, fields: null, sourceSnapshotId: null };
    }
    if (!historyLifecycleMutationFresh(context, snapshot)) {
      return {
        complete: false,
        fields: null,
        sourceSnapshotId: snapshot.historySnapshotId,
      };
    }
    const merge = recordFromUnknown<IssueMergeMetadata>(
      snapshot.lifecycleMerge,
    );
    const mergeGate = recordFromUnknown<IssueMergeGateState>(
      snapshot.lifecycleMergeGate,
    );
    const mergeGateResults = recordArrayFromUnknown<IssueMergeGateResultRecord>(
      snapshot.lifecycleMergeGateResults,
    );
    const mergeConflict = recordFromUnknown<IssueMergeConflictMetadata>(
      snapshot.lifecycleMergeConflict,
    );
    const reviewFeedback = recordArrayFromUnknown<IssueReviewFeedbackRecord>(
      snapshot.lifecycleReviewFeedback,
    );
    const preservedWorktreeStashes =
      recordArrayFromUnknown<IssuePreservedWorktreeStash>(
        snapshot.lifecyclePreservedWorktreeStashes,
      ) ?? [];
    if (mergeGateResults === null || reviewFeedback === null) {
      return {
        complete: false,
        fields: null,
        sourceSnapshotId: snapshot.historySnapshotId,
      };
    }
    return {
      complete: true,
      sourceSnapshotId: snapshot.historySnapshotId,
      fields: {
        mergeGate,
        mergeConflict,
        mergePolicyMerge: merge,
        mergePolicyMergeGate: mergeGate,
        mergePolicyMergeGateResults: mergeGateResults,
        mergePolicyMergeConflict: mergeConflict,
        activePreservedWorktreeStashes:
          activePreservedWorktreeStashesOfArray(preservedWorktreeStashes),
        mergePolicyReviewFeedback: reviewFeedback,
      },
    };
  }

  private buildLifecycleBreakdownFieldsFromHistory(
    context: IssueHistoryEvidenceBuildContext,
  ):
    | {
        complete: true;
        fields: LifecycleBreakdownFields;
        sourceSnapshotId: string;
      }
    | { complete: false; fields: null; sourceSnapshotId: string | null } {
    const snapshot = latestLifecycleMutationSnapshot(context.history);
    if (snapshot === null) {
      return { complete: false, fields: null, sourceSnapshotId: null };
    }
    if (!historyLifecycleMutationFresh(context, snapshot)) {
      return {
        complete: false,
        fields: null,
        sourceSnapshotId: snapshot.historySnapshotId,
      };
    }
    const lastIssueBreakdownPlanId = stringFromUnknown(
      snapshot.lifecycleLastIssueBreakdownPlanId,
    );
    const issueBreakdownPlans = recordArrayFromUnknown<IssueBreakdownPlan>(
      snapshot.lifecycleIssueBreakdownPlans,
    );
    if (issueBreakdownPlans === null) {
      return {
        complete: false,
        fields: null,
        sourceSnapshotId: snapshot.historySnapshotId,
      };
    }
    const lastIssueBreakdownPlan =
      lastIssueBreakdownPlanId === null
        ? null
        : (issueBreakdownPlans.find(
            (plan) => plan.id === lastIssueBreakdownPlanId,
          ) ?? null);
    if (lastIssueBreakdownPlanId !== null && lastIssueBreakdownPlan === null) {
      return {
        complete: false,
        fields: null,
        sourceSnapshotId: snapshot.historySnapshotId,
      };
    }
    return {
      complete: true,
      sourceSnapshotId: snapshot.historySnapshotId,
      fields: {
        lastIssueBreakdownPlanId,
        lastIssueBreakdownPlanApplicationStatus:
          lastIssueBreakdownPlan?.applicationStatus ?? null,
        lastIssueBreakdownPlanIssueContentFingerprint:
          lastIssueBreakdownPlan?.issueContentFingerprint ?? null,
        lastIssueBreakdownPlanConfigFingerprint:
          lastIssueBreakdownPlan?.configFingerprint ?? null,
        lastIssueBreakdownPlanSatisfiesCurrentValidation:
          lastIssueBreakdownPlan === null
            ? false
            : issueBreakdownPlanSatisfiesCurrentValidation(
                lastIssueBreakdownPlan,
                this.options.config,
              ),
      },
    };
  }

  private buildLifecycleTriageFieldsFromHistory(
    context: IssueHistoryEvidenceBuildContext,
  ):
    | {
        complete: true;
        fields: LifecycleTriageFields;
        sourceSnapshotId: string;
      }
    | { complete: false; fields: null; sourceSnapshotId: string | null } {
    const snapshot = latestLifecycleMutationSnapshot(context.history);
    if (snapshot === null) {
      return { complete: false, fields: null, sourceSnapshotId: null };
    }
    if (!historyLifecycleMutationFresh(context, snapshot)) {
      return {
        complete: false,
        fields: null,
        sourceSnapshotId: snapshot.historySnapshotId,
      };
    }
    const lastIssueTriageReportId = stringFromUnknown(
      snapshot.lifecycleLastIssueTriageReportId,
    );
    const issueTriageReports = recordArrayFromUnknown<IssueTriageReport>(
      snapshot.lifecycleIssueTriageReports,
    );
    if (issueTriageReports === null) {
      return {
        complete: false,
        fields: null,
        sourceSnapshotId: snapshot.historySnapshotId,
      };
    }
    const currentFingerprint = context.currentIssueTriageFingerprint;
    const currentTriggerReports =
      currentFingerprint === null
        ? []
        : issueTriageReports.filter(
            (report) =>
              report.triggerFingerprint === currentFingerprint &&
              !isSupersededLifecycleRecord(report),
          );
    const lastReport =
      currentFingerprint === null
        ? null
        : latestIssueTriageReportForFingerprintFromReports(
            issueTriageReports,
            currentFingerprint,
          );
    const latestAnyReport = latestIssueTriageReportFromReports(
      issueTriageReports,
      lastIssueTriageReportId,
    );
    return {
      complete: true,
      sourceSnapshotId: snapshot.historySnapshotId,
      fields: {
        lastIssueTriageReportId:
          lastReport?.id ?? lastIssueTriageReportId ?? null,
        lastIssueTriageReportTriggerFingerprint:
          lastReport?.triggerFingerprint ?? null,
        lastIssueTriageReportWritebackOperationKeys:
          lastReport?.writebackOperationKeys ?? null,
        currentIssueTriageTriggerFingerprint: currentFingerprint,
        issueTriageCurrentTriggerReportIds: currentTriggerReports.map(
          (report) => report.id,
        ),
        latestIssueTriageReportBlockers: activeIssueTriageBlockers(
          latestAnyReport,
        ).map((blocker) => ({
          ...blocker,
          evidence: [...blocker.evidence],
        })),
      },
    };
  }

  private buildLifecyclePostMortemFieldsFromHistory(
    context: IssueHistoryEvidenceBuildContext,
  ):
    | {
        complete: true;
        fields: LifecyclePostMortemFields;
        sourceSnapshotId: string;
      }
    | { complete: false; fields: null; sourceSnapshotId: string | null } {
    const snapshot = latestLifecycleMutationSnapshot(context.history);
    if (snapshot === null) {
      return { complete: false, fields: null, sourceSnapshotId: null };
    }
    if (
      !historyLifecycleMutationFresh(context, snapshot) ||
      !historyIssueEvidenceFresh(context)
    ) {
      return {
        complete: false,
        fields: null,
        sourceSnapshotId: snapshot.historySnapshotId,
      };
    }
    const lastPostMortemReportId = stringFromUnknown(
      snapshot.lifecycleLastPostMortemReportId,
    );
    const postMortemReports = recordArrayFromUnknown<IssuePostMortemReport>(
      snapshot.lifecyclePostMortemReports,
    );
    if (postMortemReports === null) {
      return {
        complete: false,
        fields: null,
        sourceSnapshotId: snapshot.historySnapshotId,
      };
    }
    const currentFingerprint = context.currentPostMortemFingerprint;
    const currentTriggerReports =
      currentFingerprint === null
        ? []
        : postMortemReports.filter(
            (report) => report.triggerFingerprint === currentFingerprint,
          );
    const lastReport =
      currentFingerprint === null
        ? null
        : latestIssuePostMortemReportForFingerprintFromReports(
            postMortemReports,
            currentFingerprint,
          );
    return {
      complete: true,
      sourceSnapshotId: snapshot.historySnapshotId,
      fields: {
        lastPostMortemReportId: lastReport?.id ?? lastPostMortemReportId,
        lastPostMortemReportTriggerFingerprint:
          lastReport?.triggerFingerprint ?? null,
        lastPostMortemReportWritebackOperationKeys:
          lastReport?.writebackOperationKeys ?? null,
        currentPostMortemTriggerFingerprint: currentFingerprint,
        postMortemCurrentTriggerReportIds: currentTriggerReports.map(
          (report) => report.id,
        ),
      },
    };
  }

  private compareHistoryBackedFields(
    storeBuilt: IssueCurrentFields,
    historyBuilt: HistoryBackedGroupResult,
  ): void {
    const groups = new Set(this.options.compareHistoryBackedFieldGroups ?? []);
    if (groups.size === 0) return;
    for (const group of groups) {
      const fields = historyBuilt.fields[group];
      if (fields === undefined) {
        this.options.logger.warn(
          "issue current-state history group incomplete",
          {
            issue_id: storeBuilt.issueId,
            issue_identifier: storeBuilt.issueIdentifier,
            field_group: group,
          },
        );
        continue;
      }
      const mismatches = compareFieldGroup(storeBuilt, fields);
      if (mismatches.length === 0) continue;
      this.options.logger.warn("issue current-state history mismatch", {
        issue_id: storeBuilt.issueId,
        issue_identifier: storeBuilt.issueIdentifier,
        field_group: group,
        mismatches,
        source_snapshot_ids: historyBuilt.sourceSnapshotIdsByGroup[group] ?? [],
      });
    }
  }

  private applyHistoryBackedFields(
    storeBuilt: IssueCurrentFields,
    historyBuilt: HistoryBackedGroupResult,
  ): IssueCurrentFields {
    let next = storeBuilt;
    for (const group of this.options.historyBackedFieldGroups ?? []) {
      const fields = historyBuilt.fields[group];
      if (fields === undefined) {
        this.warnHistoryBackedFallback(storeBuilt, group, historyBuilt);
        continue;
      }
      next = { ...next, ...fields };
    }
    return next;
  }

  private warnHistoryBackedFallback(
    storeBuilt: IssueCurrentFields,
    group: IssueCurrentStateHistoryFieldGroup,
    historyBuilt: HistoryBackedGroupResult,
  ): void {
    const sourceSnapshotIds =
      historyBuilt.sourceSnapshotIdsByGroup[group] ?? [];
    if (sourceSnapshotIds.length === 0) return;
    this.options.logger.warn(
      "issue current-state history-backed field group fallback",
      {
        issue_id: storeBuilt.issueId,
        issue_identifier: storeBuilt.issueIdentifier,
        field_group: group,
        incomplete_groups: historyBuilt.incompleteGroups,
        source_snapshot_ids: sourceSnapshotIds,
      },
    );
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
      ...this.buildTriggerFields(input, now),
      ...(input.snapshotPatch ?? {}),
    } satisfies IssueCurrentStateSnapshot);
  }

  private async loadBuildContext(
    issue: Issue,
    runtime: IssueCurrentStateRuntimeState,
    options: { includeHistory: boolean },
  ): Promise<IssueCurrentStateBuildContext> {
    const lifecycle =
      (await this.options.lifecycleStore?.get(issue.id)) ?? null;
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
      lifecycle?.lastIssueBreakdownPlanId === undefined ||
      lifecycle.lastIssueBreakdownPlanId === null
        ? null
        : (lifecycle.issueBreakdownPlans.find(
            (plan) => plan.id === lifecycle.lastIssueBreakdownPlanId,
          ) ?? null);
    const currentIssueFingerprint = issueContentFingerprint(issue);
    const currentIssueBreakdownFingerprint = issueBreakdownConfigFingerprint(
      this.options.config,
    );
    const currentIssueTriageFingerprint =
      lifecycle === null ? null : issueTriageTriggerFingerprint(lifecycle);
    const issueTriageCurrentTriggerReports =
      lifecycle === null || currentIssueTriageFingerprint === null
        ? []
        : lifecycle.issueTriageReports.filter(
            (report) =>
              report.triggerFingerprint === currentIssueTriageFingerprint &&
              !isSupersededLifecycleRecord(report),
          );
    const lastIssueTriageReport =
      lifecycle === null || currentIssueTriageFingerprint === null
        ? null
        : latestIssueTriageReportForFingerprint(
            lifecycle,
            currentIssueTriageFingerprint,
          );
    const latestAnyIssueTriageReport = latestIssueTriageReport(lifecycle);
    const currentPostMortemFingerprint =
      lifecycle === null
        ? null
        : issuePostMortemTriggerFingerprint(lifecycle, issue);
    const postMortemCurrentTriggerReports =
      lifecycle === null || currentPostMortemFingerprint === null
        ? []
        : lifecycle.postMortemReports.filter(
            (report) =>
              report.triggerFingerprint === currentPostMortemFingerprint,
          );
    const lastPostMortemReport =
      lifecycle === null || currentPostMortemFingerprint === null
        ? null
        : latestIssuePostMortemReportForFingerprint(
            lifecycle,
            currentPostMortemFingerprint,
          );
    const mergePolicyConfigHash = mergePolicyConfigFingerprint(
      this.options.config,
    );
    const mergePolicyLatestCompletionReport =
      lifecycle === null ? null : latestLifecycleCompletionReport(lifecycle);
    const mergePolicyLatestApprovalVerdict =
      lifecycle === null ? null : latestCurrentApprovalPassVerdict(lifecycle);
    const mergePolicyObservationFingerprint =
      mergePolicyObservationInputFingerprint({
        issue,
        lifecycle,
        report: mergePolicyLatestCompletionReport,
        verdict: mergePolicyLatestApprovalVerdict,
        configFingerprint: mergePolicyConfigHash,
      });
    const currentProjection =
      (await this.options.issueStateStore
        .getCurrent(issue.id)
        .catch(() => null)) ?? null;
    const projectedMergePolicyObservation = mergePolicyObservationFromUnknown(
      currentProjection?.lastMergePolicyObservation,
    );
    const lastMergePolicyObservation =
      projectedMergePolicyObservation !== null &&
      projectedMergePolicyObservation.inputFingerprint ===
        mergePolicyObservationFingerprint
        ? projectedMergePolicyObservation
        : null;
    const history = options.includeHistory
      ? ((await this.options.issueStateStore
          .getHistory(issue.id)
          .catch(() => null)) ?? [])
      : [];
    const mergePolicyLatestCompletionRun =
      mergePolicyLatestCompletionReport === null
        ? null
        : (runs.find(
            (run) => run.runId === mergePolicyLatestCompletionReport.runId,
          ) ??
          (await this.options.runStore
            ?.getRun(mergePolicyLatestCompletionReport.runId)
            .catch(() => null)) ??
          null);
    const runningRunId =
      runningEntry?.activeRunId ?? runningEntry?.runId ?? null;
    const pendingPublication =
      runningRunId === null
        ? pendingPublicationHandoffForRun(lifecycle)
        : (pendingPublicationHandoffForRun(lifecycle, {
            runId: runningRunId,
          }) ?? pendingPublicationHandoffForRun(lifecycle));
    const runningRunPhase = runningEntry?.runPhase ?? null;
    return {
      issue,
      runtime,
      lifecycle,
      runs,
      latestRun,
      pointers,
      lastIssueBreakdownPlan,
      currentIssueFingerprint,
      currentIssueBreakdownFingerprint,
      currentIssueTriageFingerprint,
      issueTriageCurrentTriggerReports,
      lastIssueTriageReport,
      latestAnyIssueTriageReport,
      currentPostMortemFingerprint,
      postMortemCurrentTriggerReports,
      lastPostMortemReport,
      mergePolicyConfigHash,
      mergePolicyLatestCompletionReport,
      mergePolicyLatestApprovalVerdict,
      mergePolicyObservationFingerprint,
      lastMergePolicyObservation,
      mergePolicyLatestCompletionRun,
      pendingPublication,
      runningEntry,
      runningRunPhase,
      history,
    };
  }

  private buildTrackerFields(
    context: IssueCurrentStateBuildContext,
  ): TrackerFields {
    const { issue } = context;
    return {
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
      currentIssueContentFingerprint: context.currentIssueFingerprint,
    };
  }

  private buildLifecycleFields(
    context: IssueCurrentStateBuildContext,
  ): LifecycleFields {
    const { issue, lifecycle } = context;
    return {
      phase:
        lifecycle?.phase ??
        phaseForIssueState(issue.state, this.options.config),
      reviewRound: lifecycle?.reviewRound ?? 0,
      incompleteTurnCount: lifecycle?.incompleteTurnCount ?? 0,
      planningFailureCount: lifecycle?.planningFailureCount ?? 0,
      planningDispatchRetryCount: lifecycle?.planningDispatchRetryCount ?? 0,
      lastPlanningFailureAt: lifecycle?.lastPlanningFailureAt ?? null,
      planningRetryDueAt:
        lifecycle === null
          ? null
          : planningRetryDueAtIso(lifecycle, this.options.config),
      blockedReason: lifecycle?.blockedReason ?? null,
      lastIssueBreakdownPlanId: lifecycle?.lastIssueBreakdownPlanId ?? null,
      lastIssueBreakdownPlanApplicationStatus:
        context.lastIssueBreakdownPlan?.applicationStatus ?? null,
      lastIssueBreakdownPlanIssueContentFingerprint:
        context.lastIssueBreakdownPlan?.issueContentFingerprint ?? null,
      lastIssueBreakdownPlanConfigFingerprint:
        context.lastIssueBreakdownPlan?.configFingerprint ?? null,
      lastIssueBreakdownPlanSatisfiesCurrentValidation:
        context.lastIssueBreakdownPlan === null
          ? false
          : issueBreakdownPlanSatisfiesCurrentValidation(
              context.lastIssueBreakdownPlan,
              this.options.config,
            ),
      lastIssueTriageReportId:
        context.lastIssueTriageReport?.id ??
        lifecycle?.lastIssueTriageReportId ??
        null,
      lastIssueTriageReportTriggerFingerprint:
        context.lastIssueTriageReport?.triggerFingerprint ?? null,
      lastIssueTriageReportWritebackOperationKeys:
        context.lastIssueTriageReport?.writebackOperationKeys ?? null,
      currentIssueTriageTriggerFingerprint:
        context.currentIssueTriageFingerprint,
      issueTriageCurrentTriggerReportIds:
        context.issueTriageCurrentTriggerReports.map((report) => report.id),
      latestIssueTriageReportBlockers: activeIssueTriageBlockers(
        context.latestAnyIssueTriageReport,
      ).map((blocker) => ({
        ...blocker,
        evidence: [...blocker.evidence],
      })),
      lastPostMortemReportId:
        context.lastPostMortemReport?.id ??
        lifecycle?.lastPostMortemReportId ??
        null,
      lastPostMortemReportTriggerFingerprint:
        context.lastPostMortemReport?.triggerFingerprint ?? null,
      lastPostMortemReportWritebackOperationKeys:
        context.lastPostMortemReport?.writebackOperationKeys ?? null,
      currentPostMortemTriggerFingerprint: context.currentPostMortemFingerprint,
      postMortemCurrentTriggerReportIds:
        context.postMortemCurrentTriggerReports.map((report) => report.id),
      lastCompletionReportId: lifecycle?.lastCompletionReportId ?? null,
      lastCompletionReportRejectionId:
        lifecycle?.lastCompletionReportRejectionId ?? null,
      lastReviewVerdictId: lifecycle?.lastReviewVerdictId ?? null,
      lastMergeGateResultId: lifecycle?.lastMergeGateResultId ?? null,
      latestCompletionReport: context.mergePolicyLatestCompletionReport,
      latestApprovalPassVerdict: context.mergePolicyLatestApprovalVerdict,
      mergeGate: lifecycle?.mergeGate ?? null,
      mergeConflict: lifecycle?.mergeConflict ?? null,
      lifecycleSummaryCiStatus: lifecycle?.summaryPointers.ciStatus ?? null,
      mergePolicyMerge: lifecycle?.merge ?? null,
      mergePolicyMergeGate: lifecycle?.mergeGate ?? null,
      mergePolicyMergeGateResults: lifecycle?.mergeGateResults ?? [],
      mergePolicyMergeConflict: lifecycle?.mergeConflict ?? null,
      activePreservedWorktreeStashes:
        activePreservedWorktreeStashesOf(lifecycle),
      mergePolicyLatestCompletionReport:
        context.mergePolicyLatestCompletionReport,
      mergePolicyLatestApprovalVerdict:
        context.mergePolicyLatestApprovalVerdict,
      mergePolicyReviewFeedback: lifecycle?.reviewFeedback ?? [],
      pendingPublicationApprovalRunId:
        context.pendingPublication?.pendingReport.runId ?? null,
      pendingPublicationApprovalReportId:
        context.pendingPublication?.pendingReport.id ?? null,
      pendingPublicationApprovalReason:
        context.pendingPublication === null
          ? null
          : (lifecycle?.blockedReason ?? null),
    };
  }

  private buildConfigFields(
    context: IssueCurrentStateBuildContext,
  ): ConfigFields {
    return {
      currentIssueBreakdownConfigFingerprint:
        context.currentIssueBreakdownFingerprint,
      lifecyclePersistenceAvailable: this.options.lifecycleStore !== undefined,
      mergePolicyMode: this.options.config.mergePolicy.mode,
      mergePolicySourceStates: [
        ...this.options.config.mergePolicy.sourceStates,
      ],
      mergePolicyDoneState: this.options.config.mergePolicy.doneState,
      mergePolicyConflictsState: this.options.config.mergePolicy.conflictsState,
      mergePolicyRequiredChecks: [
        ...this.options.config.mergePolicy.requiredChecks,
      ],
      mergePolicyMaxMergeGateFailures:
        this.options.config.reviewLoop.failureLimits.mergeGateFailures,
      mergePolicyConfigFingerprint: context.mergePolicyConfigHash,
    };
  }

  private buildHistoryFields(
    context: IssueCurrentStateBuildContext,
  ): HistoryFields {
    return {
      currentMergePolicyObservationInputFingerprint:
        context.mergePolicyObservationFingerprint,
      lastMergePolicyObservationFingerprint:
        context.lastMergePolicyObservation?.inputFingerprint ?? null,
      lastMergePolicyObservationStatus:
        context.lastMergePolicyObservation?.status ?? null,
      lastMergePolicyObservation: context.lastMergePolicyObservation,
      latestBaseRef: context.pointers?.baseRef ?? null,
      lastBaseRefObservationFingerprint:
        context.lifecycle?.baseRefObservation?.inputFingerprint ?? null,
      lastBaseRefObservationClassification:
        context.lifecycle?.baseRefObservation?.classification ?? null,
      lastBaseRefObservation: context.lifecycle?.baseRefObservation ?? null,
    };
  }

  private buildRunFields(context: IssueCurrentStateBuildContext): RunFields {
    const { issue, latestRun, pointers } = context;
    const latestPrNumber = pointers?.prNumber ?? latestRun?.prNumber ?? null;
    return {
      mergePolicyLatestCompletionRun: context.mergePolicyLatestCompletionRun,
      latestRunId: latestRun?.runId ?? pointers?.lastRunId ?? null,
      latestRunStatus: latestRun?.status ?? null,
      latestRunRole: latestRun?.role ?? null,
      latestRunPhase: latestRun?.runPhase ?? null,
      latestRunKind: latestRun?.runKind ?? null,
      latestRunCompletedAt: latestRun?.completedAt ?? null,
      latestRunError: latestRun?.error ?? null,
      latestPrUrl: pointers?.prUrl ?? latestRun?.prUrl ?? null,
      latestPrNumber:
        typeof latestPrNumber === "number" ? latestPrNumber : null,
      latestPrHeadSha: pointers?.prHeadSha ?? latestRun?.prHeadSha ?? null,
      latestPrBranch: pointers?.prBranch ?? latestRun?.prBranch ?? null,
      latestWorkspaceKey:
        pointers?.workspaceKey ?? latestRun?.workspaceKey ?? null,
      latestWorkspacePath:
        pointers?.workspacePath ?? latestRun?.workspacePath ?? null,
      latestGitBranchName:
        pointers?.gitBranchName ??
        pointers?.branchName ??
        latestRun?.gitBranchName ??
        issue.branchName,
      consecutiveSdkErrorFailures: countConsecutiveWorkerRuns(
        context.runs,
        isCountedSdkWaitErrorFailure,
      ),
      consecutiveInfraFailures: countConsecutiveWorkerRuns(
        context.runs,
        isCountedInfraFailure,
      ),
    };
  }

  private buildRuntimeFields(
    context: IssueCurrentStateBuildContext,
  ): RuntimeFields {
    return {
      running: context.runtime.running,
      runningRole: context.runningEntry?.role ?? null,
      runningRunPhase: context.runningRunPhase,
      runningRunKind:
        context.runningRunPhase === null
          ? null
          : runKindForPhase(context.runningRunPhase),
      runningManualDispatchStage:
        context.runningEntry?.manualDispatch?.stage ?? null,
      runningManualIgnoreState:
        context.runningEntry?.manualDispatch?.ignoreState === true,
      runningHasPendingPublicationApproval: context.pendingPublication !== null,
      runningCancellationRequested:
        context.runningEntry !== null &&
        context.runningEntry.cancellationRequestedAt !== null,
      claimed: context.runtime.claimed,
      paused: context.runtime.paused,
      retrying: context.runtime.retrying,
      runtimeRetryDueAt: context.runtime.retryDueAt ?? null,
    };
  }

  private buildRuntimeControlFieldsFromHistory(
    context: IssueHistoryEvidenceBuildContext,
  ):
    | {
        complete: true;
        fields: RuntimeFields;
        sourceSnapshotIds: string[];
      }
    | { complete: false; fields: null; sourceSnapshotIds: string[] } {
    const summary = buildRuntimeControlSummaryFromHistory(context.history);
    if (!historyPendingPublicationStateFresh(context)) {
      return {
        complete: false,
        fields: null,
        sourceSnapshotIds: summary.sourceSnapshotIds,
      };
    }
    if (summary.sourceSnapshotIds.length === 0) {
      if (
        context.runtime?.running ||
        context.runtime?.claimed ||
        context.runtime?.paused ||
        context.runtime?.retrying ||
        context.runningEntry !== null
      ) {
        return { complete: false, fields: null, sourceSnapshotIds: [] };
      }
      return {
        complete: true,
        sourceSnapshotIds: [],
        fields: {
          running: false,
          runningRole: null,
          runningRunPhase: null,
          runningRunKind: null,
          runningManualDispatchStage: null,
          runningManualIgnoreState: false,
          runningHasPendingPublicationApproval:
            context.pendingPublication !== null,
          runningCancellationRequested: false,
          claimed: false,
          paused: false,
          retrying: false,
          runtimeRetryDueAt: null,
        },
      };
    }
    return {
      complete: true,
      sourceSnapshotIds: summary.sourceSnapshotIds,
      fields: {
        running: summary.running,
        runningRole: summary.runningRole,
        runningRunPhase: summary.runningRunPhase,
        runningRunKind:
          summary.runningRunPhase === null
            ? null
            : runKindForPhase(summary.runningRunPhase),
        runningManualDispatchStage: summary.runningManualDispatchStage,
        runningManualIgnoreState: summary.runningManualIgnoreState,
        runningHasPendingPublicationApproval: context.pendingPublication !== null,
        runningCancellationRequested: summary.runningCancellationRequested,
        claimed: summary.claimed,
        paused: summary.paused,
        retrying: summary.retrying,
        runtimeRetryDueAt: summary.runtimeRetryDueAt,
      },
    };
  }

  private buildTriggerFields(
    input: IssueCurrentStateSnapshotBuildInput,
    now: string,
  ): TriggerFields {
    return {
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
    };
  }
}

function latestTrackerObservationSnapshot(
  history: readonly IssueHistorySnapshot[],
): IssueHistorySnapshot | null {
  for (const snapshot of history.slice().reverse()) {
    if (
      snapshot.snapshotKind === "evidence" &&
      snapshot.evidenceKind === "tracker" &&
      snapshot.evidenceEventType === "tracker_issue_observed"
    ) {
      return snapshot;
    }
  }
  return null;
}

function historyTrackerObservationFresh(
  context: IssueHistoryEvidenceBuildContext,
  snapshot: IssueHistorySnapshot | null,
): boolean {
  if (
    context.freshness.issueId === null &&
    context.freshness.issueUpdatedAt === null
  ) {
    return true;
  }
  return (
    snapshot !== null &&
    snapshot.issueId === context.freshness.issueId &&
    stringFromUnknown(snapshot.observedTrackerUpdatedAt) ===
      context.freshness.issueUpdatedAt
  );
}

function historyIssueEvidenceFresh(
  context: IssueHistoryEvidenceBuildContext,
): boolean {
  return historyTrackerObservationFresh(
    context,
    latestTrackerObservationSnapshot(context.history),
  );
}

function historyLifecycleMutationFresh(
  context: IssueHistoryEvidenceBuildContext,
  snapshot: IssueHistorySnapshot | null,
): boolean {
  if (context.freshness.lifecycleUpdatedAt === null) return true;
  return (
    snapshot !== null &&
    stringFromUnknown(snapshot.lifecycleUpdatedAt) ===
      context.freshness.lifecycleUpdatedAt
  );
}

function historyPendingPublicationStateFresh(
  context: IssueHistoryEvidenceBuildContext,
): boolean {
  return (
    context.freshness.runningHasPendingPublicationApproval === null ||
    context.freshness.runningHasPendingPublicationApproval ===
      (context.pendingPublication !== null)
  );
}

function buildHistoryEvidenceContext(
  history: readonly IssueHistorySnapshot[],
  live: {
    issue?: Issue | null;
    lifecycle?: IssueLifecycleRecord | null;
    latestRunId?: string | null;
    runningHasPendingPublicationApproval?: boolean | null;
    runtime?: IssueCurrentStateRuntimeState | null;
    runningEntry?: IssueCurrentStateRuntimeEntry | null;
  } = {},
): IssueHistoryEvidenceBuildContext {
  const trackerSnapshot = latestTrackerObservationSnapshot(history);
  const lifecycleSnapshot = latestLifecycleMutationSnapshot(history);
  const issue =
    trackerSnapshot === null
      ? null
      : issueFromTrackerObservationSnapshot(trackerSnapshot);
  const lifecycle =
    lifecycleSnapshot === null
      ? null
      : lifecycleRecordFromHistorySnapshot(lifecycleSnapshot);
  const mergePolicyLatestCompletionReport =
    lifecycleSnapshot === null
      ? null
      : recordFromUnknown<IssueCompletionReportRecord>(
          lifecycleSnapshot.lifecycleLatestCompletionReport,
        );
  const mergePolicyLatestApprovalVerdict =
    lifecycleSnapshot === null
      ? null
      : recordFromUnknown<IssueReviewVerdictRecord>(
          lifecycleSnapshot.lifecycleLatestApprovalPassVerdict,
        );
  const pendingPublication = pendingPublicationHandoffForRun(lifecycle);
  const currentIssueTriageFingerprint =
    lifecycle === null ? null : issueTriageTriggerFingerprint(lifecycle);
  const currentPostMortemFingerprint =
    lifecycle === null || issue === null
      ? null
      : issuePostMortemTriggerFingerprint(lifecycle, issue);
  return {
    history: [...history],
    issue,
    lifecycle,
    freshness: {
      issueId: live.issue?.id ?? null,
      issueUpdatedAt: live.issue?.updatedAt ?? null,
      lifecycleUpdatedAt: live.lifecycle?.updatedAt ?? null,
      latestRunId: live.latestRunId ?? null,
      runningHasPendingPublicationApproval:
        live.runningHasPendingPublicationApproval ?? null,
    },
    runtime: live.runtime ?? null,
    runningEntry: live.runningEntry ?? null,
    mergePolicyLatestCompletionReport,
    mergePolicyLatestApprovalVerdict,
    pendingPublication,
    currentIssueTriageFingerprint,
    currentPostMortemFingerprint,
  };
}

function issueFromTrackerObservationSnapshot(
  snapshot: IssueHistorySnapshot,
): Issue | null {
  if (
    snapshot.snapshotKind !== "evidence" ||
    snapshot.evidenceKind !== "tracker" ||
    snapshot.evidenceEventType !== "tracker_issue_observed"
  ) {
    return null;
  }
  const title = stringFromUnknown(snapshot.observedTitle);
  const state = stringFromUnknown(snapshot.observedTrackerState);
  const labels = stringArrayFromUnknown(snapshot.observedLabels);
  const blockedBy = issueBlockersFromUnknown(snapshot.observedBlockedBy);
  if (title === null || state === null || labels === null || blockedBy === null)
    return null;
  return {
    id: snapshot.issueId,
    identifier: snapshot.issueIdentifier,
    title,
    description: stringFromUnknown(snapshot.observedDescription),
    priority: numberFromUnknown(snapshot.observedPriority),
    state,
    branchName: stringFromUnknown(snapshot.observedBranchName),
    url: stringFromUnknown(snapshot.observedTrackerUrl),
    assigneeId: stringFromUnknown(snapshot.observedAssigneeId),
    delegateId: stringFromUnknown(snapshot.observedDelegateId),
    assignedToWorker: snapshot.observedAssignedToWorker === true,
    labels,
    blockedBy,
    hasChildren: snapshot.observedHasChildren === true,
    createdAt: stringFromUnknown(snapshot.observedTrackerCreatedAt),
    updatedAt: stringFromUnknown(snapshot.observedTrackerUpdatedAt),
  };
}

function lifecycleRecordFromHistorySnapshot(
  snapshot: IssueHistorySnapshot,
): IssueLifecycleRecord | null {
  if (
    snapshot.snapshotKind !== "evidence" ||
    snapshot.evidenceKind !== "lifecycle"
  ) {
    return null;
  }
  const phase = stringFromUnknown(snapshot.lifecyclePhase);
  const reviewRound = numberFromUnknown(snapshot.lifecycleReviewRound);
  const incompleteTurnCount = numberFromUnknown(
    snapshot.lifecycleIncompleteTurnCount,
  );
  const planningFailureCount = numberFromUnknown(
    snapshot.lifecyclePlanningFailureCount,
  );
  const planningDispatchRetryCount = numberFromUnknown(
    snapshot.lifecyclePlanningDispatchRetryCount,
  );
  if (
    phase === null ||
    reviewRound === null ||
    incompleteTurnCount === null ||
    planningFailureCount === null ||
    planningDispatchRetryCount === null
  ) {
    return null;
  }
  const summaryPointers = lifecycleSummaryPointersFromUnknown(
    snapshot.lifecycleSummaryPointers,
  );
  const latestCompletionReport =
    recordFromUnknown<IssueCompletionReportRecord>(
      snapshot.lifecycleLatestCompletionReport,
    );
  const latestApprovalPassVerdict =
    recordFromUnknown<IssueReviewVerdictRecord>(
      snapshot.lifecycleLatestApprovalPassVerdict,
    );
  const issueBreakdownPlans =
    recordArrayFromUnknown<IssueBreakdownPlan>(
      snapshot.lifecycleIssueBreakdownPlans,
    ) ?? [];
  const issueTriageReports =
    recordArrayFromUnknown<IssueTriageReport>(
      snapshot.lifecycleIssueTriageReports,
    ) ?? [];
  const postMortemReports =
    recordArrayFromUnknown<IssuePostMortemReport>(
      snapshot.lifecyclePostMortemReports,
    ) ?? [];
  const mergeGateResults =
    recordArrayFromUnknown<IssueMergeGateResultRecord>(
      snapshot.lifecycleMergeGateResults,
    ) ?? [];
  const reviewFeedback =
    recordArrayFromUnknown<IssueReviewFeedbackRecord>(
      snapshot.lifecycleReviewFeedback,
    ) ?? [];
  const preservedWorktreeStashes =
    recordArrayFromUnknown<IssuePreservedWorktreeStash>(
      snapshot.lifecyclePreservedWorktreeStashes,
    ) ?? [];
  const lifecycle: Omit<IssueLifecycleRecord, "handoff"> = {
    issueId: snapshot.issueId,
    issueIdentifier: snapshot.issueIdentifier,
    phase: phase as IssueLifecycleRecord["phase"],
    reviewRound,
    incompleteTurnCount,
    lastIssueBreakdownPlanId: stringFromUnknown(
      snapshot.lifecycleLastIssueBreakdownPlanId,
    ),
    planningFailureCount,
    planningDispatchRetryCount,
    lastPlanningFailureRunId: null,
    lastPlanningFailureAt: stringFromUnknown(
      snapshot.lifecycleLastPlanningFailureAt,
    ),
    lastIssueTriageReportId: stringFromUnknown(
      snapshot.lifecycleLastIssueTriageReportId,
    ),
    lastPostMortemReportId: stringFromUnknown(
      snapshot.lifecycleLastPostMortemReportId,
    ),
    lastCompletionReportId: stringFromUnknown(
      snapshot.lifecycleLastCompletionReportId,
    ),
    lastCompletionReportRejectionId: stringFromUnknown(
      snapshot.lifecycleLastCompletionReportRejectionId,
    ),
    lastReviewVerdictId: stringFromUnknown(
      snapshot.lifecycleLastReviewVerdictId,
    ),
    lastMergeGateResultId: stringFromUnknown(
      snapshot.lifecycleLastMergeGateResultId,
    ),
    blockedReason: stringFromUnknown(snapshot.lifecycleBlockedReason),
    summaryPointers,
    summaryReferences: [],
    issueBreakdownPlans,
    completionReports:
      latestCompletionReport === null ? [] : [latestCompletionReport],
    completionReportRejections: [],
    reviewVerdicts:
      latestApprovalPassVerdict === null ? [] : [latestApprovalPassVerdict],
    mergeGateResults,
    reviewFeedback,
    preservedWorktreeStashes,
    issueTriageReports,
    postMortemReports,
    reviewEvidence: emptyHistoryReviewEvidence(),
    baseRefObservation: baseRefObservationFromUnknown(
      snapshot.lifecycleBaseRefObservation,
    ),
    mergeGate: recordFromUnknown<IssueMergeGateState>(
      snapshot.lifecycleMergeGate,
    ),
    merge: recordFromUnknown<IssueMergeMetadata>(snapshot.lifecycleMerge),
    mergeConflict: recordFromUnknown<IssueMergeConflictMetadata>(
      snapshot.lifecycleMergeConflict,
    ),
    mergeConflictResolutionReports: [],
    createdAt: snapshot.snapshotAt,
    updatedAt:
      stringFromUnknown(snapshot.lifecycleUpdatedAt) ?? snapshot.snapshotAt,
  };
  return {
    ...lifecycle,
    handoff: emptyHistoryHandoff(lifecycle),
  };
}

function lifecycleSummaryPointersFromUnknown(
  value: unknown,
): IssueLifecycleRecord["summaryPointers"] {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    workspaceKey: stringFromUnknown(record.workspaceKey),
    workspacePath: stringFromUnknown(record.workspacePath),
    branchName: stringFromUnknown(record.branchName),
    gitBranchName: stringFromUnknown(record.gitBranchName),
    repoPath: stringFromUnknown(record.repoPath),
    baseRef: stringFromUnknown(record.baseRef),
    lastRunId: stringFromUnknown(record.lastRunId),
    prUrl: stringFromUnknown(record.prUrl),
    prNumber: numberFromUnknown(record.prNumber),
    prHeadSha: stringFromUnknown(record.prHeadSha),
    prBranch: stringFromUnknown(record.prBranch),
    ciStatus: stringFromUnknown(record.ciStatus),
    lastPushedAt: stringFromUnknown(record.lastPushedAt),
    lastEvidenceCursor: stringFromUnknown(record.lastEvidenceCursor),
  };
}

function emptyHistoryReviewEvidence(): IssueLifecycleRecord["reviewEvidence"] {
  return {
    pullRequest: null,
    lastIngestedCursor: null,
    lastWorkerEvidenceCursor: null,
    items: [],
    updatedAt: null,
  };
}

function emptyHistoryHandoff(
  lifecycle: Omit<IssueLifecycleRecord, "handoff">,
): IssueLifecycleRecord["handoff"] {
  const memo: IssueLifecycleRecord["handoff"]["memo"] = {
    version: 1,
    issueId: lifecycle.issueId,
    issueIdentifier: lifecycle.issueIdentifier,
    updatedAt: lifecycle.updatedAt,
    reviewRound: lifecycle.reviewRound,
    incompleteTurnCount: lifecycle.incompleteTurnCount,
    sizeChars: 0,
    entries: [],
    openFindings: [],
    pointers: lifecycle.summaryPointers,
    lastWorkerRunId: null,
    lastReviewerRunId: null,
  };
  return {
    version: 1,
    memo: {
      ...memo,
      sizeChars: JSON.stringify(memo).length,
    },
    lastWorkerOutput: null,
    lastReviewerOutput: null,
  };
}

function buildRuntimeControlSummaryFromHistory(
  history: readonly IssueHistorySnapshot[],
): HistoryRuntimeControlSummary {
  const summary: HistoryRuntimeControlSummary = {
    sourceSnapshotIds: [],
    running: false,
    runningRole: null,
    runningRunPhase: null,
    runningManualDispatchStage: null,
    runningManualIgnoreState: false,
    runningCancellationRequested: false,
    claimed: false,
    paused: false,
    retrying: false,
    runtimeRetryDueAt: null,
  };
  for (const snapshot of history) {
    if (snapshot.snapshotKind !== "evidence") continue;
    if (snapshot.evidenceKind === "runtime") {
      summary.sourceSnapshotIds.push(snapshot.historySnapshotId);
      applyRuntimeControlEvidenceSnapshot(summary, snapshot);
      continue;
    }
    if (
      snapshot.evidenceKind === "harness" &&
      (snapshot.evidenceEventType === "retry_scheduled" ||
        snapshot.evidenceEventType === "retry_fired" ||
        snapshot.evidenceEventType === "retry_cleared")
    ) {
      summary.sourceSnapshotIds.push(snapshot.historySnapshotId);
      applyRuntimeRetryEvent(
        summary,
        snapshot.evidenceEventType,
        stringFromUnknown(snapshot.retryDueAt),
      );
    }
  }
  return summary;
}

function applyRuntimeControlEvidenceSnapshot(
  summary: HistoryRuntimeControlSummary,
  snapshot: IssueHistorySnapshot,
): void {
  const eventType = stringFromUnknown(snapshot.evidenceEventType);
  switch (eventType) {
    case "running_entry_created":
      summary.running = booleanFromUnknown(snapshot.runtimeRunning) ?? true;
      summary.runningRole =
        agentRunRoleFromUnknown(snapshot.runtimeRole) ??
        agentRunRoleFromUnknown(snapshot.role) ??
        summary.runningRole;
      summary.runningRunPhase =
        agentRunPhaseFromUnknown(snapshot.runtimeRunPhase) ??
        agentRunPhaseFromUnknown(snapshot.runPhase) ??
        summary.runningRunPhase;
      summary.runningManualDispatchStage =
        stringFromUnknown(snapshot.runtimeManualDispatchStage) ??
        summary.runningManualDispatchStage;
      summary.runningManualIgnoreState =
        booleanFromUnknown(snapshot.runtimeManualIgnoreState) ??
        summary.runningManualIgnoreState;
      summary.runningCancellationRequested =
        stringFromUnknown(snapshot.runtimeCancellationRequestedAt) !== null;
      break;
    case "running_entry_released":
      summary.running = false;
      summary.runningRole = null;
      summary.runningRunPhase = null;
      summary.runningManualDispatchStage = null;
      summary.runningManualIgnoreState = false;
      summary.runningCancellationRequested = false;
      break;
    case "claim_acquired":
      summary.claimed = booleanFromUnknown(snapshot.runtimeClaimed) ?? true;
      break;
    case "claim_released":
      summary.claimed = booleanFromUnknown(snapshot.runtimeClaimed) ?? false;
      break;
    case "pause_requested":
      summary.paused = booleanFromUnknown(snapshot.runtimePaused) ?? true;
      break;
    case "pause_cleared":
      summary.paused = booleanFromUnknown(snapshot.runtimePaused) ?? false;
      break;
    case "cancellation_requested":
      summary.runningCancellationRequested = true;
      break;
    case "retry_scheduled":
    case "retry_fired":
    case "retry_cleared":
      applyRuntimeRetryEvent(
        summary,
        eventType,
        stringFromUnknown(snapshot.retryDueAt),
      );
      break;
  }
  summary.running =
    booleanFromUnknown(snapshot.runtimeRunning) ?? summary.running;
  summary.claimed =
    booleanFromUnknown(snapshot.runtimeClaimed) ?? summary.claimed;
  summary.paused = booleanFromUnknown(snapshot.runtimePaused) ?? summary.paused;
  const explicitRetrying = booleanFromUnknown(snapshot.runtimeRetrying);
  if (explicitRetrying !== null) {
    summary.retrying = explicitRetrying;
    if (!explicitRetrying) summary.runtimeRetryDueAt = null;
  }
}

function applyRuntimeRetryEvent(
  summary: HistoryRuntimeControlSummary,
  eventType: string,
  retryDueAt: string | null = null,
): void {
  if (eventType === "retry_scheduled") {
    summary.retrying = true;
    summary.runtimeRetryDueAt = retryDueAt;
    return;
  }
  if (eventType === "retry_fired" || eventType === "retry_cleared") {
    summary.retrying = false;
    summary.runtimeRetryDueAt = null;
  }
}

function selectHistoryBackedGroups(
  historyBuilt: HistoryBackedGroupResult,
  groups: readonly IssueCurrentStateHistoryFieldGroup[],
): IssueCurrentStateHistoryRebuildResult {
  const fields: Partial<IssueCurrentFields> = {};
  const incompleteGroups: IssueCurrentStateHistoryFieldGroup[] = [];
  const sourceSnapshotIds: string[] = [];
  const sourceSnapshotIdsByGroup: Partial<
    Record<IssueCurrentStateHistoryFieldGroup, string[]>
  > = {};
  for (const group of groups) {
    const groupSourceSnapshotIds =
      historyBuilt.sourceSnapshotIdsByGroup[group] ?? [];
    sourceSnapshotIdsByGroup[group] = groupSourceSnapshotIds;
    sourceSnapshotIds.push(...groupSourceSnapshotIds);
    const groupFields = historyBuilt.fields[group];
    if (groupFields === undefined) {
      incompleteGroups.push(group);
      continue;
    }
    Object.assign(fields, groupFields);
  }
  return {
    fields,
    incompleteGroups,
    sourceSnapshotIds: [...new Set(sourceSnapshotIds)],
    sourceSnapshotIdsByGroup,
  };
}

function latestLifecycleMutationSnapshot(
  history: readonly IssueHistorySnapshot[],
): IssueHistorySnapshot | null {
  for (const snapshot of history.slice().reverse()) {
    if (
      snapshot.snapshotKind === "evidence" &&
      snapshot.evidenceKind === "lifecycle"
    ) {
      return snapshot;
    }
  }
  return null;
}

function latestIssueTriageReportForFingerprintFromReports(
  reports: readonly IssueTriageReport[],
  triggerFingerprint: string,
): IssueTriageReport | null {
  for (let index = reports.length - 1; index >= 0; index -= 1) {
    const report = reports[index];
    if (
      report?.triggerFingerprint === triggerFingerprint &&
      !isSupersededLifecycleRecord(report)
    ) {
      return report;
    }
  }
  return null;
}

function latestIssueTriageReportFromReports(
  reports: readonly IssueTriageReport[],
  lastReportId: string | null,
): IssueTriageReport | null {
  if (lastReportId !== null) {
    const exact = reports.find((report) => report.id === lastReportId);
    if (exact && !isSupersededLifecycleRecord(exact)) return exact;
  }
  for (const report of reports.slice().reverse()) {
    if (!isSupersededLifecycleRecord(report)) return report;
  }
  return null;
}

function latestIssuePostMortemReportForFingerprintFromReports(
  reports: readonly IssuePostMortemReport[],
  triggerFingerprint: string,
): IssuePostMortemReport | null {
  for (let index = reports.length - 1; index >= 0; index -= 1) {
    const report = reports[index];
    if (report?.triggerFingerprint === triggerFingerprint) return report;
  }
  return null;
}

function stringArrayFromUnknown(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? [...value]
    : null;
}

function issueBlockersFromUnknown(value: unknown): Issue["blockedBy"] | null {
  if (!Array.isArray(value)) return null;
  const blockers: Issue["blockedBy"] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    blockers.push({
      id: typeof record.id === "string" ? record.id : null,
      identifier:
        typeof record.identifier === "string" ? record.identifier : null,
      state: typeof record.state === "string" ? record.state : null,
    });
  }
  return blockers;
}

function buildRunSummariesFromHistory(
  history: readonly IssueHistorySnapshot[],
): HistoryRunSummary[] {
  const runs = new Map<string, HistoryRunSummary>();
  history.forEach((snapshot, index) => {
    if (
      snapshot.snapshotKind !== "evidence" ||
      snapshot.evidenceKind !== "run"
    ) {
      return;
    }
    const runId =
      stringFromUnknown(snapshot.runId) ??
      stringFromUnknown(snapshot.evidenceSourceId);
    if (runId === null) return;
    const summary = ensureHistoryRunSummary(runs, runId);
    summary.sequence = index;
    summary.sourceSnapshotIds.push(snapshot.historySnapshotId);

    summary.sessionId =
      stringFromUnknown(snapshot.runSessionId) ?? summary.sessionId;
    summary.agentId = stringFromUnknown(snapshot.runAgentId) ?? summary.agentId;
    summary.role = stringFromUnknown(snapshot.role) ?? summary.role;
    summary.runPhase = stringFromUnknown(snapshot.runPhase) ?? summary.runPhase;
    summary.runKind = stringFromUnknown(snapshot.runKind) ?? summary.runKind;
    summary.attempt = numberFromUnknown(snapshot.runAttempt) ?? summary.attempt;
    summary.turnNumber =
      numberFromUnknown(snapshot.runTurnNumber) ?? summary.turnNumber;
    summary.harnessId =
      stringFromUnknown(snapshot.runHarnessId) ?? summary.harnessId;
    summary.promptTemplateKeys =
      stringArrayFromUnknown(snapshot.runPromptTemplateKeys) ??
      summary.promptTemplateKeys;
    summary.workspaceKey =
      stringFromUnknown(snapshot.runWorkspaceKey) ?? summary.workspaceKey;
    summary.workspacePath =
      stringFromUnknown(snapshot.runWorkspacePath) ?? summary.workspacePath;
    summary.gitBranchName =
      stringFromUnknown(snapshot.runGitBranchName) ?? summary.gitBranchName;

    if (snapshot.evidenceEventType === "run_started") {
      summary.status = stringFromUnknown(snapshot.runStatus) ?? "running";
      summary.prompt = stringFromUnknown(snapshot.runPrompt) ?? summary.prompt;
      summary.promptCharCount =
        numberFromUnknown(snapshot.runPromptCharCount) ??
        summary.promptCharCount;
      summary.startedAt =
        stringFromUnknown(snapshot.runStartedAt) ?? summary.startedAt;
      summary.updatedAt =
        stringFromUnknown(snapshot.runUpdatedAt) ?? summary.updatedAt;
      summary.tokens =
        tokenCountsFromUnknown(snapshot.runTokens) ?? summary.tokens;
    }

    if (snapshot.evidenceEventType === "run_terminal_state_updated") {
      summary.status = stringFromUnknown(snapshot.runStatus) ?? summary.status;
      summary.updatedAt =
        stringFromUnknown(snapshot.runUpdatedAt) ?? summary.updatedAt;
      summary.completedAt =
        stringFromUnknown(snapshot.runCompletedAt) ?? summary.completedAt;
      summary.error = stringFromUnknown(snapshot.runError) ?? summary.error;
      summary.tokens =
        tokenCountsFromUnknown(snapshot.runTokens) ?? summary.tokens;
      summary.sdkRunStatus =
        stringFromUnknown(snapshot.runSdkStatus) ?? summary.sdkRunStatus;
      summary.sdkRunStatusSource =
        stringFromUnknown(snapshot.runSdkStatusSource) ??
        summary.sdkRunStatusSource;
      summary.cancellationRequestedAt =
        stringFromUnknown(snapshot.runCancellationRequestedAt) ??
        summary.cancellationRequestedAt;
      summary.cancellationOutcome =
        stringFromUnknown(snapshot.runCancellationOutcome) ??
        summary.cancellationOutcome;
      summary.cancelFailed =
        booleanFromUnknown(snapshot.runCancelFailed) ?? summary.cancelFailed;
      summary.failureKind =
        stringFromUnknown(snapshot.runFailureKind) ?? summary.failureKind;
      summary.failureDiagnosticCode =
        stringFromUnknown(snapshot.runFailureDiagnosticCode) ??
        summary.failureDiagnosticCode;
    }

    if (snapshot.evidenceEventType === "run_pull_request_updated") {
      summary.prUrl = stringFromUnknown(snapshot.runPrUrl) ?? summary.prUrl;
      summary.prNumber =
        numberFromUnknown(snapshot.runPrNumber) ?? summary.prNumber;
      summary.prHeadSha =
        stringFromUnknown(snapshot.runPrHeadSha) ?? summary.prHeadSha;
      summary.prBranch =
        stringFromUnknown(snapshot.runPrBranch) ?? summary.prBranch;
      summary.gitBranchName =
        stringFromUnknown(snapshot.runGitBranchName) ?? summary.gitBranchName;
    }
  });
  return [...runs.values()].sort(
    (left, right) => left.sequence - right.sequence,
  );
}

function ensureHistoryRunSummary(
  runs: Map<string, HistoryRunSummary>,
  runId: string,
): HistoryRunSummary {
  const existing = runs.get(runId);
  if (existing) return existing;
  const summary: HistoryRunSummary = {
    runId,
    sequence: -1,
    sourceSnapshotIds: [],
    status: null,
    role: null,
    runPhase: null,
    runKind: null,
    completedAt: null,
    error: null,
    prUrl: null,
    prNumber: null,
    prHeadSha: null,
    prBranch: null,
    workspaceKey: null,
    workspacePath: null,
    gitBranchName: null,
    sdkRunStatus: null,
    sdkRunStatusSource: null,
    cancellationRequestedAt: null,
    cancellationOutcome: null,
    cancelFailed: false,
    failureKind: null,
    failureDiagnosticCode: null,
    sessionId: null,
    agentId: null,
    prompt: null,
    promptCharCount: null,
    startedAt: null,
    updatedAt: null,
    tokens: null,
    attempt: null,
    turnNumber: null,
    harnessId: null,
    promptTemplateKeys: null,
  };
  runs.set(runId, summary);
  return summary;
}

function countConsecutiveHistoryWorkerRuns(
  runs: HistoryRunSummary[],
  predicate: (run: HistoryRunSummary) => boolean,
): number {
  let count = 0;
  for (const run of runs.slice().reverse()) {
    if (run.role !== "worker") continue;
    if (!predicate(run)) break;
    count += 1;
  }
  return count;
}

function runRecordFromHistorySummary(
  issue: Pick<Issue, "id" | "identifier">,
  run: HistoryRunSummary,
): RunRecord | null {
  if (
    run.status === null ||
    run.role === null ||
    run.prompt === null ||
    run.startedAt === null ||
    run.updatedAt === null ||
    run.tokens === null ||
    run.workspaceKey === null ||
    run.workspacePath === null ||
    run.turnNumber === null
  ) {
    return null;
  }
  return {
    runId: run.runId,
    sessionId: run.sessionId,
    agentId: run.agentId,
    role: run.role as RunRecord["role"],
    ...(run.runPhase === null
      ? {}
      : { runPhase: run.runPhase as AgentRunPhase }),
    ...(run.runKind === null ? {} : { runKind: run.runKind as AgentRunKind }),
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    attempt: run.attempt,
    turnNumber: run.turnNumber,
    prompt: run.prompt,
    ...(run.promptCharCount === null
      ? {}
      : { promptCharCount: run.promptCharCount }),
    ...(run.promptTemplateKeys === null
      ? {}
      : { promptTemplateKeys: [...run.promptTemplateKeys] }),
    ...(run.harnessId === null ? {} : { harnessId: run.harnessId }),
    workspaceKey: run.workspaceKey,
    workspacePath: run.workspacePath,
    ...(run.gitBranchName === null ? {} : { gitBranchName: run.gitBranchName }),
    status: run.status as RunRecord["status"],
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    error: run.error,
    tokens: run.tokens,
    ...(run.prUrl === null ? {} : { prUrl: run.prUrl }),
    ...(run.prNumber === null ? {} : { prNumber: run.prNumber }),
    ...(run.prHeadSha === null ? {} : { prHeadSha: run.prHeadSha }),
    ...(run.prBranch === null ? {} : { prBranch: run.prBranch }),
    ...(run.sdkRunStatus === null
      ? {}
      : {
          sdkRunStatus: run.sdkRunStatus as NonNullable<
            RunRecord["sdkRunStatus"]
          >,
        }),
    ...(run.sdkRunStatusSource === null
      ? {}
      : {
          sdkRunStatusSource: run.sdkRunStatusSource as NonNullable<
            RunRecord["sdkRunStatusSource"]
          >,
        }),
    ...(run.cancellationRequestedAt === null
      ? {}
      : { cancellationRequestedAt: run.cancellationRequestedAt }),
    ...(run.cancellationOutcome === null
      ? {}
      : {
          cancellationOutcome: run.cancellationOutcome as NonNullable<
            RunRecord["cancellationOutcome"]
          >,
        }),
    cancelFailed: run.cancelFailed,
    ...(run.failureKind === null ? {} : { failureKind: run.failureKind }),
    ...(run.failureDiagnosticCode === null
      ? {}
      : { failureDiagnosticCode: run.failureDiagnosticCode }),
  };
}

function isCountedHistorySdkWaitErrorFailure(run: HistoryRunSummary): boolean {
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

function isCountedHistoryInfraFailure(run: HistoryRunSummary): boolean {
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

function stringFromUnknown(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberFromUnknown(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanFromUnknown(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function agentRunRoleFromUnknown(value: unknown): AgentRunRole | null {
  return value === "worker" ||
    value === "reviewer" ||
    value === "triage" ||
    value === "planner" ||
    value === "post_mortem"
    ? value
    : null;
}

function agentRunPhaseFromUnknown(value: unknown): AgentRunPhase | null {
  return value === "issue_breakdown" ||
    value === "implementation" ||
    value === "merge_conflict_resolution" ||
    value === "review" ||
    value === "issue_triage" ||
    value === "post_mortem"
    ? value
    : null;
}

function tokenCountsFromUnknown(value: unknown): TokenCounts | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<TokenCounts>;
  return typeof record.inputTokens === "number" &&
    Number.isFinite(record.inputTokens) &&
    typeof record.outputTokens === "number" &&
    Number.isFinite(record.outputTokens) &&
    typeof record.totalTokens === "number" &&
    Number.isFinite(record.totalTokens)
    ? {
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        totalTokens: record.totalTokens,
      }
    : null;
}

function recordFromUnknown<T extends { id: string }>(value: unknown): T | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<T>;
  return typeof record.id === "string" ? (record as T) : null;
}

function baseRefObservationFromUnknown(value: unknown): IssueBaseRefObservation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<IssueBaseRefObservation>;
  return record.version === 1 &&
    typeof record.inputFingerprint === "string" &&
    typeof record.classification === "string" &&
    typeof record.operation === "string"
    ? (record as IssueBaseRefObservation)
    : null;
}

function recordArrayFromUnknown<T extends { id: string }>(
  value: unknown,
): T[] | null {
  if (!Array.isArray(value)) return null;
  const records: T[] = [];
  for (const item of value) {
    const record = recordFromUnknown<T>(item);
    if (record === null) return null;
    records.push(record);
  }
  return records;
}

function activePreservedWorktreeStashesOf(
  lifecycle: Pick<IssueLifecycleRecord, "preservedWorktreeStashes"> | null,
): IssuePreservedWorktreeStash[] {
  return activePreservedWorktreeStashesOfArray(
    lifecycle?.preservedWorktreeStashes ?? [],
  );
}

function activePreservedWorktreeStashesOfArray(
  stashes: readonly IssuePreservedWorktreeStash[],
): IssuePreservedWorktreeStash[] {
  return stashes
    .filter((stash) => stash.status !== "dropped")
    .map((stash) => ({
      ...stash,
      dirtyFiles: [...stash.dirtyFiles],
      conflictedFiles: [...stash.conflictedFiles],
    }));
}

function compareFieldGroup(
  storeBuilt: IssueCurrentFields,
  historyFields: Partial<IssueCurrentFields>,
): Array<{
  field: string;
  storeValue: unknown;
  historyValue: unknown;
}> {
  const mismatches: Array<{
    field: string;
    storeValue: unknown;
    historyValue: unknown;
  }> = [];
  for (const [field, historyValue] of Object.entries(historyFields)) {
    const storeValue = storeBuilt[field as keyof IssueCurrentFields];
    if (stableJson(storeValue) === stableJson(historyValue)) continue;
    mismatches.push({ field, storeValue, historyValue });
  }
  return mismatches;
}

function latestLifecycleCompletionReport(
  lifecycle: IssueLifecycleRecord,
): IssueCompletionReportRecord | null {
  if (lifecycle.lastCompletionReportId) {
    const exact = lifecycle.completionReports.find(
      (report) => report.id === lifecycle.lastCompletionReportId,
    );
    if (exact) return exact;
  }
  return (
    lifecycle.completionReports[lifecycle.completionReports.length - 1] ?? null
  );
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
      missingCheckStabilizationMs:
        config.mergePolicy.missingCheckStabilizationMs,
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
    stableJson(
      mergePolicyDecisionInput({ ...input, lifecycle: input.lifecycle }),
    ),
  );
}

function mergePolicyDecisionInput(input: {
  issue: Issue;
  lifecycle: IssueLifecycleRecord;
  report: IssueCompletionReportRecord | null;
  verdict: IssueReviewVerdictRecord | null;
  configFingerprint: string;
}) {
  const pointers = input.lifecycle.summaryPointers;
  // This hash is a semantic merge-policy freshness invariant. Evidence-only
  // lifecycle writes, such as base-ref observations, must not invalidate an
  // otherwise reusable merge-policy observation.
  return {
    configFingerprint: input.configFingerprint,
    issueId: input.issue.id,
    trackerState: input.issue.state,
    trackerUpdatedAt: input.issue.updatedAt,
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
    routingPointers: {
      workspaceKey: pointers.workspaceKey,
      workspacePath: pointers.workspacePath,
      branchName: pointers.branchName,
      gitBranchName: pointers.gitBranchName,
      repoPath: pointers.repoPath,
      baseRef: pointers.baseRef,
      prUrl: pointers.prUrl,
      prNumber: pointers.prNumber,
      prHeadSha: pointers.prHeadSha,
      prBranch: pointers.prBranch,
    },
  };
}

function latestMergePolicyObservationForFingerprint(
  history: readonly IssueHistorySnapshot[],
  fingerprint: string | null,
): MergePolicyObservation | null {
  if (fingerprint === null) return null;
  for (const snapshot of history.slice().reverse()) {
    if (snapshot.transitionKind !== "merge_policy_observe") continue;
    for (const action of snapshot.actions.slice().reverse()) {
      if (
        action.actionType !== "record_merge_policy_observation" ||
        action.status !== "succeeded"
      )
        continue;
      const observation = mergePolicyObservationFromUnknown(action.details);
      if (observation?.inputFingerprint === fingerprint) return observation;
    }
  }
  return null;
}

function planningRetryDueAtIso(
  lifecycle: IssueLifecycleRecord,
  config: ServiceConfig,
): string | null {
  return planningRetryDueAtIsoForValues(
    lifecycle.planningFailureCount,
    lifecycle.lastPlanningFailureAt,
    config,
  );
}

function planningRetryDueAtIsoForValues(
  planningFailureCount: number,
  lastPlanningFailureAt: string | null,
  config: ServiceConfig,
): string | null {
  if (planningFailureCount <= 0 || lastPlanningFailureAt === null) return null;
  const failedAtMs = Date.parse(lastPlanningFailureAt);
  if (!Number.isFinite(failedAtMs)) return null;
  return new Date(
    failedAtMs + planningRetryDelayMs(planningFailureCount, config),
  ).toISOString();
}

function planningBackoffRemainingMs(
  lifecycle: IssueLifecycleRecord,
  config: ServiceConfig,
  nowMs = Date.now(),
): number {
  if (
    lifecycle.planningFailureCount <= 0 ||
    lifecycle.lastPlanningFailureAt === null
  )
    return 0;
  const lastFailureMs = Date.parse(lifecycle.lastPlanningFailureAt);
  if (!Number.isFinite(lastFailureMs)) return 0;
  const dueMs =
    lastFailureMs +
    planningRetryDelayMs(lifecycle.planningFailureCount, config);
  return Math.max(dueMs - nowMs, 0);
}

function planningRetryDelayMs(
  failureCount: number,
  config: ServiceConfig,
): number {
  return Math.min(
    config.issueBreakdown.planningRetryBaseMs *
      2 ** Math.max(failureCount - 1, 0),
    config.issueBreakdown.planningRetryMaxMs,
  );
}

function countConsecutiveWorkerRuns(
  runs: RunRecord[],
  predicate: (run: RunRecord) => boolean,
): number {
  const seen = new Set<string>();
  const workerRuns = runs
    .filter(
      (run) =>
        run.role === "worker" && !seen.has(run.runId) && seen.add(run.runId),
    )
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

function isInfraFailureDiagnosticCode(
  code: string | null | undefined,
): boolean {
  return typeof code === "string" && INFRA_FAILURE_DIAGNOSTIC_CODES.has(code);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
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

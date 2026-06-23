import { createHash, randomUUID } from "node:crypto";
import type { ServiceConfig } from "../config/Config.js";
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
  type IssueReviewVerdictRecord,
} from "../persistence/IssueLifecycleStore.js";
import {
  compareRunChronology,
  type RunRecord,
  type RunTranscriptStore,
} from "../persistence/RunTranscriptStore.js";
import {
  runKindForPhase,
  type AgentRunPhase,
  type AgentRunRole,
  type Issue,
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
  | "lifecycleReports";

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

interface HistoryBackedGroupFields {
  tracker?: TrackerFields;
  runSummary?: RunSummaryFields;
  lifecycleCore?: LifecycleCoreFields;
  lifecycleReports?: LifecycleReportFields;
}

interface HistoryBackedGroupResult {
  fields: HistoryBackedGroupFields;
  incompleteGroups: IssueCurrentStateHistoryFieldGroup[];
  sourceSnapshotIds: string[];
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
}

export class IssueCurrentStateBuilder {
  constructor(private readonly options: IssueCurrentStateBuilderOptions) {}

  async build(
    issue: Issue,
    runtime: IssueCurrentStateRuntimeState,
  ): Promise<IssueCurrentFields> {
    const context = await this.loadBuildContext(issue, runtime);
    const now = new Date().toISOString();
    const storeBuilt = this.buildFromStores(context, now);
    const historyBuilt = this.buildFromHistory(context);
    this.compareHistoryBackedFields(storeBuilt, historyBuilt);
    return this.applyHistoryBackedFields(storeBuilt, historyBuilt);
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
    const tracker = this.buildTrackerFieldsFromHistory(context);
    const runSummary = this.buildRunSummaryFieldsFromHistory(context);
    const lifecycleCore = this.buildLifecycleCoreFieldsFromHistory(context);
    const lifecycleReports =
      this.buildLifecycleReportFieldsFromHistory(context);
    return {
      fields: {
        ...(tracker.fields === null ? {} : { tracker: tracker.fields }),
        ...(runSummary.fields === null
          ? {}
          : { runSummary: runSummary.fields }),
        ...(lifecycleCore.fields === null
          ? {}
          : { lifecycleCore: lifecycleCore.fields }),
        ...(lifecycleReports.fields === null
          ? {}
          : { lifecycleReports: lifecycleReports.fields }),
      },
      incompleteGroups: [
        ...(tracker.complete ? [] : (["tracker"] as const)),
        ...(runSummary.complete ? [] : (["runSummary"] as const)),
        ...(lifecycleCore.complete ? [] : (["lifecycleCore"] as const)),
        ...(lifecycleReports.complete ? [] : (["lifecycleReports"] as const)),
      ],
      sourceSnapshotIds: [
        ...(tracker.sourceSnapshotId ? [tracker.sourceSnapshotId] : []),
        ...runSummary.sourceSnapshotIds,
        ...(lifecycleCore.sourceSnapshotId
          ? [lifecycleCore.sourceSnapshotId]
          : []),
        ...(lifecycleReports.sourceSnapshotId
          ? [lifecycleReports.sourceSnapshotId]
          : []),
      ],
    };
  }

  private buildTrackerFieldsFromHistory(
    context: IssueCurrentStateBuildContext,
  ):
    | { complete: true; fields: TrackerFields; sourceSnapshotId: string }
    | { complete: false; fields: null; sourceSnapshotId: null } {
    const snapshot = latestTrackerObservationSnapshot(context.history);
    if (snapshot === null) {
      return { complete: false, fields: null, sourceSnapshotId: null };
    }
    if (
      snapshot.issueId !== context.issue.id ||
      snapshot.observedTrackerUpdatedAt !== context.issue.updatedAt
    ) {
      return { complete: false, fields: null, sourceSnapshotId: null };
    }
    const title =
      typeof snapshot.observedTitle === "string"
        ? snapshot.observedTitle
        : null;
    const state =
      typeof snapshot.observedTrackerState === "string"
        ? snapshot.observedTrackerState
        : null;
    const labels = stringArrayFromUnknown(snapshot.observedLabels);
    const blockedBy = issueBlockersFromUnknown(snapshot.observedBlockedBy);
    if (
      title === null ||
      state === null ||
      labels === null ||
      blockedBy === null
    )
      return { complete: false, fields: null, sourceSnapshotId: null };
    const issue: Issue = {
      id: snapshot.issueId,
      identifier: snapshot.issueIdentifier,
      title,
      description:
        typeof snapshot.observedDescription === "string"
          ? snapshot.observedDescription
          : null,
      priority:
        typeof snapshot.observedPriority === "number"
          ? snapshot.observedPriority
          : null,
      state,
      branchName:
        typeof snapshot.observedBranchName === "string"
          ? snapshot.observedBranchName
          : null,
      url:
        typeof snapshot.observedTrackerUrl === "string"
          ? snapshot.observedTrackerUrl
          : null,
      assigneeId:
        typeof snapshot.observedAssigneeId === "string"
          ? snapshot.observedAssigneeId
          : null,
      delegateId:
        typeof snapshot.observedDelegateId === "string"
          ? snapshot.observedDelegateId
          : null,
      assignedToWorker: snapshot.observedAssignedToWorker === true,
      labels,
      blockedBy,
      hasChildren: snapshot.observedHasChildren === true,
      createdAt:
        typeof snapshot.observedTrackerCreatedAt === "string"
          ? snapshot.observedTrackerCreatedAt
          : null,
      updatedAt:
        typeof snapshot.observedTrackerUpdatedAt === "string"
          ? snapshot.observedTrackerUpdatedAt
          : null,
    };
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
    context: IssueCurrentStateBuildContext,
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
    if (!historyRunSummaryMatchesKnownStoreState(context, latestRun)) {
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
          context.issue.branchName,
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

  private buildLifecycleCoreFieldsFromHistory(
    context: IssueCurrentStateBuildContext,
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
    if (
      context.lifecycle === null ||
      stringFromUnknown(snapshot.lifecycleUpdatedAt) !==
        context.lifecycle.updatedAt
    ) {
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
    context: IssueCurrentStateBuildContext,
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
    if (
      context.lifecycle === null ||
      stringFromUnknown(snapshot.lifecycleUpdatedAt) !==
        context.lifecycle.updatedAt
    ) {
      return {
        complete: false,
        fields: null,
        sourceSnapshotId: snapshot.historySnapshotId,
      };
    }
    const lastCompletionReportRejectionId = stringFromUnknown(
      snapshot.lifecycleLastCompletionReportRejectionId,
    );
    if (
      !historyStringMatchesKnown(
        lastCompletionReportRejectionId,
        context.lifecycle.lastCompletionReportRejectionId,
      )
    ) {
      return {
        complete: false,
        fields: null,
        sourceSnapshotId: snapshot.historySnapshotId,
      };
    }
    const latestCompletionReport =
      recordFromUnknown<IssueCompletionReportRecord>(
        snapshot.lifecycleLatestCompletionReport,
      );
    if (
      !historyRecordIdMatchesKnown(
        latestCompletionReport,
        context.mergePolicyLatestCompletionReport?.id,
      )
    ) {
      return {
        complete: false,
        fields: null,
        sourceSnapshotId: snapshot.historySnapshotId,
      };
    }
    const latestApprovalPassVerdict =
      recordFromUnknown<IssueReviewVerdictRecord>(
        snapshot.lifecycleLatestApprovalPassVerdict,
      );
    if (
      !historyRecordIdMatchesKnown(
        latestApprovalPassVerdict,
        context.mergePolicyLatestApprovalVerdict?.id,
      )
    ) {
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
        lastCompletionReportRejectionId,
        latestCompletionReport,
        latestApprovalPassVerdict,
        mergePolicyLatestCompletionReport: latestCompletionReport,
        mergePolicyLatestApprovalVerdict: latestApprovalPassVerdict,
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
        source_snapshot_ids: historyBuilt.sourceSnapshotIds,
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
      if (fields === undefined) continue;
      next = { ...next, ...fields };
    }
    return next;
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
    const existingIssueState = await this.options.issueStateStore
      .get(issue.id)
      .catch(() => null);
    const history = existingIssueState?.history ?? [];
    const lastMergePolicyObservation =
      latestMergePolicyObservationForFingerprint(
        history,
        mergePolicyObservationFingerprint,
      );
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

    summary.role = stringFromUnknown(snapshot.role) ?? summary.role;
    summary.runPhase = stringFromUnknown(snapshot.runPhase) ?? summary.runPhase;
    summary.runKind = stringFromUnknown(snapshot.runKind) ?? summary.runKind;
    summary.workspaceKey =
      stringFromUnknown(snapshot.runWorkspaceKey) ?? summary.workspaceKey;
    summary.workspacePath =
      stringFromUnknown(snapshot.runWorkspacePath) ?? summary.workspacePath;
    summary.gitBranchName =
      stringFromUnknown(snapshot.runGitBranchName) ?? summary.gitBranchName;

    if (snapshot.evidenceEventType === "run_started") {
      summary.status = stringFromUnknown(snapshot.runStatus) ?? "running";
    }

    if (snapshot.evidenceEventType === "run_terminal_state_updated") {
      summary.status = stringFromUnknown(snapshot.runStatus) ?? summary.status;
      summary.completedAt =
        stringFromUnknown(snapshot.runCompletedAt) ?? summary.completedAt;
      summary.error = stringFromUnknown(snapshot.runError) ?? summary.error;
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

function historyRunSummaryMatchesKnownStoreState(
  context: IssueCurrentStateBuildContext,
  latestRun: HistoryRunSummary,
): boolean {
  const expectedRunId = context.latestRun?.runId ?? context.pointers?.lastRunId;
  if (expectedRunId && latestRun.runId !== expectedRunId) return false;
  if (!historyStringMatchesKnown(latestRun.prUrl, context.pointers?.prUrl))
    return false;
  if (
    !historyNumberMatchesKnown(latestRun.prNumber, context.pointers?.prNumber)
  )
    return false;
  if (
    !historyStringMatchesKnown(latestRun.prHeadSha, context.pointers?.prHeadSha)
  )
    return false;
  if (
    !historyStringMatchesKnown(latestRun.prBranch, context.pointers?.prBranch)
  )
    return false;
  if (
    !historyStringMatchesKnown(
      latestRun.workspaceKey,
      context.pointers?.workspaceKey,
    )
  )
    return false;
  if (
    !historyStringMatchesKnown(
      latestRun.workspacePath,
      context.pointers?.workspacePath,
    )
  )
    return false;
  if (
    !historyStringMatchesKnown(
      latestRun.gitBranchName,
      context.pointers?.gitBranchName ?? context.pointers?.branchName,
    )
  )
    return false;
  if (!historyStringMatchesKnown(latestRun.prUrl, context.latestRun?.prUrl))
    return false;
  if (
    !historyNumberMatchesKnown(latestRun.prNumber, context.latestRun?.prNumber)
  )
    return false;
  if (
    !historyStringMatchesKnown(
      latestRun.prHeadSha,
      context.latestRun?.prHeadSha,
    )
  )
    return false;
  if (
    !historyStringMatchesKnown(latestRun.prBranch, context.latestRun?.prBranch)
  )
    return false;
  return true;
}

function historyStringMatchesKnown(
  historyValue: string | null,
  knownValue: string | null | undefined,
): boolean {
  return knownValue == null || historyValue === knownValue;
}

function historyNumberMatchesKnown(
  historyValue: number | null,
  knownValue: number | null | undefined,
): boolean {
  return knownValue == null || historyValue === knownValue;
}

function historyRecordIdMatchesKnown(
  historyRecord: { id: string } | null,
  knownId: string | null | undefined,
): boolean {
  return knownId == null || historyRecord?.id === knownId;
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

function recordFromUnknown<T extends { id: string }>(value: unknown): T | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<T>;
  return typeof record.id === "string" ? (record as T) : null;
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

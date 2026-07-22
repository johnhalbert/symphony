import { randomUUID } from "node:crypto";

import type { AgentHandoffRepairKind } from "../harness/AgentHarness.js";
import type { IssueBaseRefObservation } from "../BaseRefVerification.js";
import type { MergePolicyObservation } from "../merge/MergePolicyService.js";
import type {
  IssueBreakdownPlanRecord,
  IssueBreakdownPlanApplicationStatus,
  IssueAcceptedArtifactRecord,
  IssueBlockerProvenanceRecord,
  IssueCompletionReportRecord,
  IssueLifecyclePatch,
  IssueMergeConflictMetadata,
  IssueMergeGateResultRecord,
  IssueMergeGateState,
  IssueMergeMetadata,
  IssuePostMortemReportRecord,
  IssuePreservedWorktreeStash,
  IssueReviewFeedbackRecord,
  IssueReviewVerdictRecord,
  IssueTriageRecoveryDispositionRecord,
  IssueTriageReportRecord,
  IssueTriageBlockerRecord,
  IssueWorkspaceSeedRecord,
} from "../persistence/IssueLifecycleStore.js";
import type { RunRecord } from "../persistence/RunTranscriptStore.js";
import type {
  AgentRunPhase,
  AgentRunKind,
  AgentRunRole,
  Issue,
  TokenCounts,
} from "../types.js";

export type IssueTriggerType =
  | "orchestrator.tick"
  | "manual.cli_agent_run"
  | "manual.cli_admin_action"
  | "runtime.requested";
export type IssueTriggerSource = "orchestrator" | "manual_cli" | "transition";

export type IssueTransitionKind =
  | "record_evidence"
  | "merge_queue_claim"
  | "base_ref_observe"
  | "base_ref_repair"
  | "base_ref_block"
  | "preserved_stash_restore"
  | "dispatch_worker"
  | "dispatch_planner"
  | "dispatch_reviewer"
  | "dispatch_triage"
  | "dispatch_post_mortem"
  | "handoff_repair"
  | "merge_policy"
  | "merge_policy_observe"
  | "merge_policy_reset_operator_resume"
  | "merge_policy_write_done_state"
  | "merge_policy_retire_stale_gate"
  | "merge_policy_mark_head_superseded"
  | "merge_policy_wait_conflict_state"
  | "merge_policy_refresh_conflict_base"
  | "merge_policy_wait_active_blocked_gate"
  | "merge_policy_wait_repair_clearance"
  | "merge_policy_refresh_same_gate_blocker"
  | "merge_policy_observe_checks_pending"
  | "merge_policy_auto_resolve_gate"
  | "merge_policy_prepare_conflict"
  | "merge_policy_dispatch_repair"
  | "merge_policy_block_failure"
  | "merge_policy_merge_pull_request"
  | "merge_policy_recover_already_merged_pull_request"
  | "complete_organizational_parent"
  | "reconcile_issue_triage_report_writeback"
  | "reconcile_issue_breakdown_plan_application"
  | "reconcile_post_mortem_report_writeback"
  | "reconcile_completion_report_handoff"
  | "reconcile_completion_report_rejection"
  | "reconcile_merge_conflict_resolution_handoff"
  | "reconcile_issue_breakdown_plan_handoff"
  | "reconcile_issue_triage_report_handoff"
  | "reconcile_issue_post_mortem_handoff"
  | "reconcile_review_verdict_handoff"
  | "reconcile_completed_accepted_artifact"
  | "supersede_reopened_accepted_artifact"
  | "complete_accepted_artifact"
  | "reset_lifecycle_after_operator_resume"
  | "reset_merge_conflict_after_operator_resume"
  | "block_merge_conflict_attempt_limit"
  | "recover_merge_gate_head_supersession"
  | "rebound_issue_triage_blocked"
  | "recover_publication_approval"
  | "terminate_running"
  | "block_issue"
  | "retry_run"
  | "noop";

export type IssueHistorySnapshotKind = "transition" | "evidence";
export type IssueEvidenceKind =
  | "run"
  | "lifecycle"
  | "writeback"
  | "approval"
  | "workspace"
  | "tracker"
  | "runtime"
  | "harness";

export interface TransitionRequestContextEnvelope<K extends string, P> {
  kind: K;
  requestId: string;
  requestedAt: string;
  parentHistorySnapshotId: string | null;
  parentTransitionKind: IssueTransitionKind | null;
  payload: P;
}

export type MergePolicyChainTransitionRequestContext =
  TransitionRequestContextEnvelope<
    "merge_policy_chain",
    {
      chainId: string;
      iteration: number;
      maxIterations: number;
    }
  >;

export type HandoffRepairTransitionRequestContext =
  TransitionRequestContextEnvelope<
    "handoff_repair",
    {
      sourceRunId: string;
      kind: AgentHandoffRepairKind;
      repairAttempt: number;
      turnNumber: number;
      role: AgentRunRole;
      runPhase: AgentRunPhase;
      runKind: AgentRunKind;
    }
  >;

export type HandoffReconciliationTransitionRequestContext =
  TransitionRequestContextEnvelope<
    "handoff_reconciliation",
    {
      runId: string;
      handoffKind: AgentHandoffRepairKind;
      role: AgentRunRole;
      runPhase: AgentRunPhase;
      runKind: AgentRunKind;
    }
  >;

export type CompletionReportRejectionTransitionRequestContext =
  TransitionRequestContextEnvelope<
    "completion_report_rejection",
    {
      runId: string;
      role: AgentRunRole;
      runPhase: AgentRunPhase;
      runKind: AgentRunKind;
    }
  >;

export type BaseRefChainTransitionRequestContext =
  TransitionRequestContextEnvelope<
    "base_ref_chain",
    {
      targetTransitionKind: IssueTransitionKind;
      targetRequest: IssueTransitionRequest;
      chainId: string;
      iteration: number;
      maxIterations: number;
    }
  >;

export type IssueTransitionRequestContext =
  | MergePolicyChainTransitionRequestContext
  | BaseRefChainTransitionRequestContext
  | HandoffRepairTransitionRequestContext
  | HandoffReconciliationTransitionRequestContext
  | CompletionReportRejectionTransitionRequestContext;

export interface IssueCurrentFields {
  version: 1;
  issueId: string;
  issueIdentifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  trackerState: string;
  branchName: string | null;
  trackerUrl: string | null;
  assigneeId: string | null;
  delegateId: string | null;
  assignedToWorker: boolean;
  labels: string[];
  blockedBy: Issue["blockedBy"];
  hasChildren: boolean;
  children?: NonNullable<Issue["children"]>;
  childrenTruncated?: boolean;
  trackerCreatedAt: string | null;
  trackerUpdatedAt: string | null;
  phase: string;
  reviewRound: number;
  incompleteTurnCount: number;
  planningFailureCount: number;
  planningDispatchRetryCount: number;
  lastPlanningFailureAt: string | null;
  planningRetryDueAt: string | null;
  blockedReason: string | null;
  lastIssueBreakdownPlanId: string | null;
  lastIssueBreakdownPlanApplicationStatus:
    | IssueBreakdownPlanApplicationStatus
    | null;
  lastIssueBreakdownPlanSourceIssueTriageReportId: string | null;
  lastIssueBreakdownPlanIssueContentFingerprint: string | null;
  lastIssueBreakdownPlanConfigFingerprint: string | null;
  lastIssueBreakdownPlanSatisfiesCurrentValidation: boolean;
  currentIssueContentFingerprint: string;
  currentIssueBreakdownConfigFingerprint: string;
  lastIssueTriageReportId: string | null;
  lastIssueTriageReportTriggerFingerprint: string | null;
  lastIssueTriageReportWritebackOperationKeys: string[] | null;
  lastIssueTriageRecoveryDisposition: IssueTriageRecoveryDispositionRecord | null;
  currentIssueTriageTriggerFingerprint: string | null;
  issueTriageCurrentTriggerReportIds: string[];
  latestIssueTriageReportBlockers: IssueTriageBlockerRecord[];
  latestPersistedIssueTriageReportBlockers?: IssueTriageBlockerRecord[];
  lastPostMortemReportId: string | null;
  lastPostMortemReportTriggerFingerprint: string | null;
  lastPostMortemReportWritebackOperationKeys: string[] | null;
  currentPostMortemTriggerFingerprint: string | null;
  postMortemCurrentTriggerReportIds: string[];
  lastCompletionReportId: string | null;
  lastCompletionReportRejectionId: string | null;
  lastReviewVerdictId: string | null;
  lastMergeGateResultId: string | null;
  latestCompletionReport: IssueCompletionReportRecord | null;
  latestApprovalPassVerdict: IssueReviewVerdictRecord | null;
  acceptedArtifact: IssueAcceptedArtifactRecord | null;
  workspaceSeed: IssueWorkspaceSeedRecord | null;
  mergeGate: IssueMergeGateState | null;
  mergeConflict: IssueMergeConflictMetadata | null;
  lifecycleSummaryCiStatus: string | null;
  lifecyclePersistenceAvailable: boolean;
  mergePolicyMode: string;
  mergePolicySourceStates: string[];
  mergePolicyDoneState: string | null;
  mergePolicyConflictsState: string | null;
  mergePolicyRequiredChecks: string[];
  mergePolicyMaxMergeGateFailures: number;
  mergePolicyConfigFingerprint: string;
  currentMergePolicyObservationInputFingerprint: string | null;
  lastMergePolicyObservationFingerprint: string | null;
  lastMergePolicyObservationStatus: string | null;
  lastMergePolicyObservation: MergePolicyObservation | null;
  latestBaseRef?: string | null;
  lastBaseRefObservationFingerprint?: string | null;
  lastBaseRefObservationClassification?: IssueBaseRefObservation["classification"] | null;
  lastBaseRefObservation?: IssueBaseRefObservation | null;
  activeBlockerProvenance?: IssueBlockerProvenanceRecord | null;
  activePreservedWorktreeStashes: IssuePreservedWorktreeStash[];
  mergePolicyMerge: IssueMergeMetadata | null;
  mergePolicyMergeGate: IssueMergeGateState | null;
  mergePolicyMergeGateResults: IssueMergeGateResultRecord[];
  mergePolicyMergeConflict: IssueMergeConflictMetadata | null;
  mergePolicyLatestCompletionReport: IssueCompletionReportRecord | null;
  mergePolicyLatestApprovalVerdict: IssueReviewVerdictRecord | null;
  mergePolicyReviewFeedback: IssueReviewFeedbackRecord[];
  mergePolicyLatestCompletionRun: RunRecord | null;
  pendingPublicationApprovalRunId: string | null;
  pendingPublicationApprovalReportId: string | null;
  pendingPublicationApprovalReason: string | null;
  latestRunId: string | null;
  latestRunStatus: string | null;
  latestRunRole: string | null;
  latestRunPhase: string | null;
  latestRunKind: string | null;
  latestRunCompletedAt: string | null;
  latestRunError: string | null;
  latestPrUrl: string | null;
  latestPrNumber: number | null;
  latestPrHeadSha: string | null;
  latestPrBranch: string | null;
  latestWorkspaceKey: string | null;
  latestWorkspacePath: string | null;
  latestGitBranchName: string | null;
  running: boolean;
  runningRole: AgentRunRole | null;
  runningRunPhase: AgentRunPhase | null;
  runningRunKind: AgentRunKind | null;
  runningManualDispatchStage: string | null;
  runningManualIgnoreState: boolean;
  runningHasPendingPublicationApproval: boolean;
  runningCancellationRequested: boolean;
  claimed: boolean;
  paused: boolean;
  retrying: boolean;
  runtimeRetryDueAt: string | null;
  consecutiveSdkErrorFailures: number;
  consecutiveInfraFailures: number;
  recordCreatedAt: string;
  recordUpdatedAt: string;
}

export interface IssueStateRecord extends IssueCurrentFields {
  history: IssueHistorySnapshot[];
}

export interface IssueCurrentStateSnapshot extends IssueCurrentFields {
  snapshotId: string;
  snapshotAt: string;
  triggerType: IssueTriggerType;
  triggerId: string;
  triggerAt: string;
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
  lastReviewVerdictDispositionWritebackStatus?:
    | "not_required"
    | "pending"
    | "applied"
    | "failed";
  lastCompletionReportDispositionWritebackStatus?:
    | "not_required"
    | "pending"
    | "applied"
    | "failed";
  triggerRunId?: string | null;
  triggerReason?: string | null;
  retryAttempt?: number | null;
  retryDelayMs?: number | null;
  retryError?: string | null;
  mergeQueueActiveIssueId?: string | null;
  mergeQueueActiveIssueIdentifier?: string | null;
  mergeQueueLeaseId?: string | null;
  mergeQueueStatus?:
    | "inactive"
    | "active_current_issue"
    | "active_other_issue";
}

export interface IssueTransitionRequest {
  transitionKind: IssueTransitionKind;
  transitionId?: string;
  reason?: string | null;
  role?: AgentRunRole | null;
  runPhase?: AgentRunPhase | null;
  runKind?: AgentRunKind | null;
  promptScenario?: string | null;
  userTemplateKey?: string | null;
  systemTemplateKey?: string | null;
  handoffRepairKind?: AgentHandoffRepairKind | null;
  handoffRepairSourceRunId?: string | null;
  handoffRepairAttempt?: number | null;
  reportKind?: "issue_triage" | "post_mortem" | null;
  runId?: string | null;
  cleanupWorkspace?: boolean | null;
  terminationReason?: string | null;
  retryAttempt?: number | null;
  retryDelayMs?: number | null;
  retryError?: string | null;
  evidenceKind?: IssueEvidenceKind | null;
  evidenceEventType?: string | null;
  evidenceSourceId?: string | null;
  evidencePayload?: unknown;
  [key: string]: unknown;
}

export interface TransitionActionRecord {
  actionId: string;
  actionType: string;
  status: "pending" | "succeeded" | "failed" | "skipped";
  startedAt: string;
  completedAt: string | null;
  message: string | null;
  details: unknown;
}

export type TransitionActionExecutionResult =
  | boolean
  | void
  | {
      status?: "succeeded" | "skipped";
      message?: string | null;
      details?: unknown;
      stop?: boolean;
    };

export interface TransitionErrorRecord {
  errorId: string;
  errorType: "runtime" | "domain";
  actionId: string | null;
  message: string;
  stack: string | null;
  code: string | null;
  cause: string | null;
  details: unknown;
  recordedAt: string;
}

export interface IssueHistorySnapshot extends IssueCurrentStateSnapshot {
  snapshotKind: IssueHistorySnapshotKind;
  historySnapshotId: string;
  transitionKind: IssueTransitionKind;
  transitionId: string;
  rulesetId: string;
  rulesetVersion: string;
  rulesetFingerprint: string;
  rulesetPriority: number;
  reason: string | null;
  actions: TransitionActionRecord[];
  errors: TransitionErrorRecord[];
  role?: AgentRunRole | null;
  runPhase?: AgentRunPhase | null;
  runKind?: AgentRunKind | null;
  promptScenario?: string | null;
  userTemplateKey?: string | null;
  systemTemplateKey?: string | null;
  handoffRepairKind?: AgentHandoffRepairKind | null;
  handoffRepairSourceRunId?: string | null;
  handoffRepairAttempt?: number | null;
  reportKind?: "issue_triage" | "post_mortem" | null;
  runId?: string | null;
  cleanupWorkspace?: boolean | null;
  terminationReason?: string | null;
  retryAttempt?: number | null;
  retryDelayMs?: number | null;
  retryError?: string | null;
  evidenceKind?: IssueEvidenceKind | null;
  evidenceEventType?: string | null;
  evidenceSourceId?: string | null;
  evidencePayload?: unknown;
  [key: string]: unknown;
}

export interface IssueEvidenceHistorySnapshot<
  K extends IssueEvidenceKind = IssueEvidenceKind,
  E extends string = string,
> extends IssueHistorySnapshot {
  snapshotKind: "evidence";
  transitionKind: "record_evidence";
  evidenceKind: K;
  evidenceEventType: E;
  evidenceSourceId: string | null;
}

export interface TrackerObservedIssueSnapshot extends IssueEvidenceHistorySnapshot<
  "tracker",
  "tracker_issue_observed"
> {
  observedTitle: string;
  observedDescription: string | null;
  observedTrackerState: string;
  observedLabels: string[];
  observedBranchName: string | null;
  observedTrackerUrl: string | null;
  observedPriority: number | null;
  observedAssigneeId: string | null;
  observedDelegateId: string | null;
  observedAssignedToWorker: boolean;
  observedBlockedBy: Issue["blockedBy"];
  observedHasChildren: boolean;
  observedChildren?: NonNullable<Issue["children"]>;
  observedChildrenTruncated?: boolean;
  observedTrackerCreatedAt: string | null;
  observedTrackerUpdatedAt: string | null;
}

export interface LifecycleMutationEvidenceSnapshot extends IssueEvidenceHistorySnapshot<
  "lifecycle",
  string
> {
  lifecyclePatch: IssueLifecyclePatch | Record<string, unknown> | null;
  lifecycleUpdatedAt: string | null;
  lifecyclePhase: string | null;
  lifecycleBlockedReason: string | null;
  lifecycleReviewRound: number | null;
  lifecycleIncompleteTurnCount: number | null;
  lifecyclePlanningFailureCount: number | null;
  lifecyclePlanningDispatchRetryCount: number | null;
  lifecycleLastPlanningFailureAt: string | null;
  lifecycleLastIssueBreakdownPlanId: string | null;
  lifecycleIssueBreakdownPlans: IssueBreakdownPlanRecord[] | null;
  lifecycleLastIssueTriageReportId: string | null;
  lifecycleIssueTriageReports: IssueTriageReportRecord[] | null;
  lifecycleLastPostMortemReportId: string | null;
  lifecyclePostMortemReports: IssuePostMortemReportRecord[] | null;
  lifecycleLastCompletionReportId: string | null;
  lifecycleLastCompletionReportRejectionId: string | null;
  lifecycleLastReviewVerdictId: string | null;
  lifecycleLastMergeGateResultId: string | null;
  lifecyclePendingPublicationApprovalRunId: string | null;
  lifecyclePendingPublicationApprovalReportId: string | null;
  lifecyclePendingPublicationApprovalReason: string | null;
  lifecycleLatestCompletionReport: IssueCompletionReportRecord | null;
  lifecycleLatestApprovalPassVerdict: IssueReviewVerdictRecord | null;
  lifecycleAcceptedArtifact: IssueAcceptedArtifactRecord | null;
  lifecycleWorkspaceSeed: IssueWorkspaceSeedRecord | null;
  lifecycleMerge: IssueMergeMetadata | null;
  lifecycleMergeGate: IssueMergeGateState | null;
  lifecycleMergeGateResults: IssueMergeGateResultRecord[] | null;
  lifecycleMergeConflict: IssueMergeConflictMetadata | null;
  lifecycleReviewFeedback: IssueReviewFeedbackRecord[] | null;
  lifecycleBaseRefObservation: IssueBaseRefObservation | null;
  lifecycleBlockerProvenances?: IssueBlockerProvenanceRecord[] | null;
  lifecycleActiveBlockerProvenanceId?: string | null;
  lifecyclePreservedWorktreeStashes: IssuePreservedWorktreeStash[] | null;
  lifecycleSummaryCiStatus: string | null;
  lifecycleSummaryPointers: unknown;
}

export interface RunEvidenceSnapshot extends IssueEvidenceHistorySnapshot<
  "run",
  string
> {
  runId: string | null;
  runAgentId: string | null;
  role: AgentRunRole | null;
  runPhase: AgentRunPhase | null;
  runKind: AgentRunKind | null;
  runStatus: string | null;
  runSessionId: string | null;
  runPrompt: string | null;
  runPromptCharCount: number | null;
  runStartedAt: string | null;
  runUpdatedAt: string | null;
  runCompletedAt: string | null;
  runError: string | null;
  runTokens: TokenCounts | null;
  runAttempt: number | null;
  runTurnNumber: number | null;
  runHarnessId: string | null;
  runWorkspaceKey: string | null;
  runWorkspacePath: string | null;
  runGitBranchName: string | null;
  runPrUrl: string | null;
  runPrNumber: number | null;
  runPrHeadSha: string | null;
  runPrBranch: string | null;
  runSdkStatus: string | null;
  runSdkStatusSource: string | null;
  runCancellationRequestedAt: string | null;
  runCancellationOutcome: string | null;
  runCancelFailed: boolean | null;
  runFailureKind: string | null;
  runFailureDiagnosticCode: string | null;
  runPromptTemplateKeys: string[] | null;
}

export interface WritebackEvidenceSnapshot extends IssueEvidenceHistorySnapshot<
  "writeback",
  string
> {
  writebackIdempotencyKey: string | null;
  writebackKind: string | null;
  writebackIssueId: string | null;
  writebackRunId: string | null;
  writebackStatus: string | null;
  writebackResultStatus: string | null;
  writebackResultMessage: string | null;
  writebackLastError: string | null;
}

export interface ApprovalEvidenceSnapshot extends IssueEvidenceHistorySnapshot<
  "approval",
  string
> {
  approvalRequestId: string | null;
  approvalIssueId: string | null;
  approvalIssueIdentifier: string | null;
  approvalStatus: string | null;
  approvalRunId: string | null;
  approvalEvidenceCursor: string | null;
  approvalAction: string | null;
}

export interface WorkspaceEvidenceSnapshot extends IssueEvidenceHistorySnapshot<
  "workspace",
  string
> {
  workspaceKey: string | null;
  workspacePath: string | null;
  workspaceGitBranchName: string | null;
  workspaceRepoPath: string | null;
  workspaceBaseRef: string | null;
  role: AgentRunRole | null;
  runPhase: AgentRunPhase | null;
  runKind: AgentRunKind | null;
}

export type RuntimeControlEvidenceEventType =
  | "running_entry_created"
  | "running_entry_released"
  | "claim_acquired"
  | "claim_released"
  | "pause_requested"
  | "pause_cleared"
  | "cancellation_requested"
  | "retry_scheduled"
  | "retry_fired"
  | "retry_cleared";

export interface RuntimeControlEvidenceSnapshot extends IssueEvidenceHistorySnapshot<
  "runtime",
  RuntimeControlEvidenceEventType
> {
  runtimeRunning: boolean | null;
  runtimeRole: AgentRunRole | null;
  runtimeRunPhase: AgentRunPhase | null;
  runtimeRunKind: AgentRunKind | null;
  runtimeRunId: string | null;
  runtimeActiveRunId: string | null;
  runtimeManualDispatchStage: string | null;
  runtimeManualIgnoreState: boolean | null;
  runtimeCancellationRequestedAt: string | null;
  runtimeClaimed: boolean | null;
  runtimePaused: boolean | null;
  runtimeRetrying: boolean | null;
  retryAttempt: number | null;
  retryDelayMs: number | null;
  retryError: string | null;
  retryDueAt: string | null;
}

export interface RuntimeRetryEvidenceSnapshot extends IssueEvidenceHistorySnapshot<
  "harness",
  "retry_scheduled" | "retry_fired" | "retry_cleared"
> {
  retryAttempt: number | null;
  retryDelayMs: number | null;
  retryError: string | null;
  retryDueAt: string | null;
}

export type IssueTypedEvidenceSnapshot =
  | TrackerObservedIssueSnapshot
  | LifecycleMutationEvidenceSnapshot
  | RunEvidenceSnapshot
  | WritebackEvidenceSnapshot
  | ApprovalEvidenceSnapshot
  | WorkspaceEvidenceSnapshot
  | RuntimeControlEvidenceSnapshot
  | RuntimeRetryEvidenceSnapshot;

export function normalizeIssueHistorySnapshotEvidenceFields(
  snapshot: IssueHistorySnapshot,
): IssueHistorySnapshot {
  if (snapshot.transitionKind !== "record_evidence") return snapshot;
  const payload = recordPayload(snapshot.evidencePayload);
  switch (snapshot.evidenceKind) {
    case "tracker":
      return copyMissingEvidenceFields(snapshot, {
        observedTitle: stringField(payload, "title") ?? snapshot.title,
        observedDescription:
          stringField(payload, "description") ?? snapshot.description,
        observedTrackerState:
          stringField(payload, "state") ?? snapshot.trackerState,
        observedLabels: stringArrayField(payload, "labels") ?? snapshot.labels,
        observedBranchName:
          stringField(payload, "branchName") ?? snapshot.branchName,
        observedTrackerUrl: stringField(payload, "url") ?? snapshot.trackerUrl,
        observedPriority: numberField(payload, "priority") ?? snapshot.priority,
        observedAssigneeId:
          stringField(payload, "assigneeId") ?? snapshot.assigneeId,
        observedDelegateId:
          stringField(payload, "delegateId") ?? snapshot.delegateId,
        observedAssignedToWorker:
          booleanField(payload, "assignedToWorker") ??
          snapshot.assignedToWorker,
        observedBlockedBy:
          arrayField(payload, "blockedBy") ?? snapshot.blockedBy,
        observedHasChildren:
          booleanField(payload, "hasChildren") ?? snapshot.hasChildren,
        observedChildren:
          issueChildrenField(payload, "children") ?? snapshot.children ?? [],
        observedChildrenTruncated:
          booleanField(payload, "childrenTruncated") ??
          snapshot.childrenTruncated ??
          false,
        observedTrackerCreatedAt:
          stringField(payload, "createdAt") ?? snapshot.trackerCreatedAt,
        observedTrackerUpdatedAt:
          stringField(payload, "updatedAt") ?? snapshot.trackerUpdatedAt,
      });
    case "lifecycle":
      return copyMissingEvidenceFields(snapshot, {
        lifecyclePatch: payload?.patch ?? null,
        lifecycleUpdatedAt: stringField(payload, "updatedAt"),
        lifecyclePhase: stringField(payload, "phase"),
        lifecycleBlockedReason: stringField(payload, "blockedReason"),
        lifecycleReviewRound: numberField(payload, "reviewRound"),
        lifecycleIncompleteTurnCount: numberField(
          payload,
          "incompleteTurnCount",
        ),
        lifecyclePlanningFailureCount: numberField(
          payload,
          "planningFailureCount",
        ),
        lifecyclePlanningDispatchRetryCount: numberField(
          payload,
          "planningDispatchRetryCount",
        ),
        lifecycleLastPlanningFailureAt: stringField(
          payload,
          "lastPlanningFailureAt",
        ),
        lifecycleLastIssueBreakdownPlanId: stringField(
          payload,
          "lastIssueBreakdownPlanId",
        ),
        lifecycleIssueBreakdownPlans:
          recordArrayField<IssueBreakdownPlanRecord>(
            payload,
            "issueBreakdownPlans",
          ),
        lifecycleLastIssueTriageReportId: stringField(
          payload,
          "lastIssueTriageReportId",
        ),
        lifecycleIssueTriageReports: recordArrayField<IssueTriageReportRecord>(
          payload,
          "issueTriageReports",
        ),
        lifecycleLastPostMortemReportId: stringField(
          payload,
          "lastPostMortemReportId",
        ),
        lifecyclePostMortemReports:
          recordArrayField<IssuePostMortemReportRecord>(
            payload,
            "postMortemReports",
          ),
        lifecycleLastCompletionReportId: stringField(
          payload,
          "lastCompletionReportId",
        ),
        lifecycleLastCompletionReportRejectionId: stringField(
          payload,
          "lastCompletionReportRejectionId",
        ),
        lifecycleLastReviewVerdictId: stringField(
          payload,
          "lastReviewVerdictId",
        ),
        lifecycleLastMergeGateResultId: stringField(
          payload,
          "lastMergeGateResultId",
        ),
        lifecyclePendingPublicationApprovalRunId: stringField(
          payload,
          "pendingPublicationApprovalRunId",
        ),
        lifecyclePendingPublicationApprovalReportId: stringField(
          payload,
          "pendingPublicationApprovalReportId",
        ),
        lifecyclePendingPublicationApprovalReason: stringField(
          payload,
          "pendingPublicationApprovalReason",
        ),
        lifecycleLatestCompletionReport:
          recordField<IssueCompletionReportRecord>(
            payload,
            "latestCompletionReport",
          ),
        lifecycleLatestApprovalPassVerdict:
          recordField<IssueReviewVerdictRecord>(
            payload,
            "latestApprovalPassVerdict",
          ),
        lifecycleAcceptedArtifact: recordField<IssueAcceptedArtifactRecord>(
          payload,
          "acceptedArtifact",
        ),
        lifecycleWorkspaceSeed: recordField<IssueWorkspaceSeedRecord>(
          payload,
          "workspaceSeed",
        ),
        lifecycleMerge: recordField<IssueMergeMetadata>(payload, "merge"),
        lifecycleMergeGate: recordField<IssueMergeGateState>(
          payload,
          "mergeGate",
        ),
        lifecycleMergeGateResults: recordArrayField<IssueMergeGateResultRecord>(
          payload,
          "mergeGateResults",
        ),
        lifecycleMergeConflict: recordField<IssueMergeConflictMetadata>(
          payload,
          "mergeConflict",
        ),
        lifecycleReviewFeedback: recordArrayField<IssueReviewFeedbackRecord>(
          payload,
          "reviewFeedback",
        ),
        lifecycleBaseRefObservation: recordField<IssueBaseRefObservation>(
          payload,
          "baseRefObservation",
        ),
        lifecycleBlockerProvenances:
          recordArrayField<IssueBlockerProvenanceRecord>(
            payload,
            "blockerProvenances",
          ),
        lifecycleActiveBlockerProvenanceId: stringField(
          payload,
          "activeBlockerProvenanceId",
        ),
        lifecyclePreservedWorktreeStashes:
          recordArrayField<IssuePreservedWorktreeStash>(
            payload,
            "preservedWorktreeStashes",
          ),
        lifecycleSummaryCiStatus: stringField(
          recordPayload(payload?.summaryPointers),
          "ciStatus",
        ),
        lifecycleSummaryPointers: payload?.summaryPointers ?? null,
      });
    case "run":
      return copyMissingEvidenceFields(snapshot, {
        runId: stringField(payload, "runId") ?? snapshot.runId ?? null,
        runAgentId: stringField(payload, "agentId"),
        role: stringField(payload, "role") ?? snapshot.role ?? null,
        runPhase: stringField(payload, "runPhase") ?? snapshot.runPhase ?? null,
        runKind: stringField(payload, "runKind") ?? snapshot.runKind ?? null,
        runStatus: stringField(payload, "status"),
        runSessionId: stringField(payload, "sessionId"),
        runPrompt: stringField(payload, "prompt"),
        runPromptCharCount: numberField(payload, "promptCharCount"),
        runStartedAt: stringField(payload, "startedAt"),
        runUpdatedAt: stringField(payload, "updatedAt"),
        runCompletedAt: stringField(payload, "completedAt"),
        runError: stringField(payload, "error"),
        runTokens: tokenCountsField(payload, "tokens"),
        runAttempt: numberField(payload, "attempt"),
        runTurnNumber: numberField(payload, "turnNumber"),
        runHarnessId: stringField(payload, "harnessId"),
        runWorkspaceKey: stringField(payload, "workspaceKey"),
        runWorkspacePath: stringField(payload, "workspacePath"),
        runGitBranchName: stringField(payload, "gitBranchName"),
        runPrUrl: stringField(payload, "prUrl"),
        runPrNumber: numberField(payload, "prNumber"),
        runPrHeadSha: stringField(payload, "prHeadSha"),
        runPrBranch: stringField(payload, "prBranch"),
        runSdkStatus:
          stringField(payload, "sdkRunStatus") ??
          stringField(recordPayload(payload?.metadata), "sdkRunStatus"),
        runSdkStatusSource:
          stringField(payload, "sdkRunStatusSource") ??
          stringField(recordPayload(payload?.metadata), "sdkRunStatusSource"),
        runCancellationRequestedAt:
          stringField(payload, "cancellationRequestedAt") ??
          stringField(
            recordPayload(payload?.metadata),
            "cancellationRequestedAt",
          ),
        runCancellationOutcome:
          stringField(payload, "cancellationOutcome") ??
          stringField(recordPayload(payload?.metadata), "cancellationOutcome"),
        runCancelFailed:
          booleanField(payload, "cancelFailed") ??
          booleanField(recordPayload(payload?.metadata), "cancelFailed"),
        runFailureKind:
          stringField(payload, "failureKind") ??
          stringField(recordPayload(payload?.metadata), "failureKind"),
        runFailureDiagnosticCode:
          stringField(payload, "failureDiagnosticCode") ??
          stringField(
            recordPayload(payload?.metadata),
            "failureDiagnosticCode",
          ),
        runPromptTemplateKeys: stringArrayField(payload, "promptTemplateKeys"),
      });
    case "writeback":
      return copyMissingEvidenceFields(snapshot, {
        writebackIdempotencyKey: stringField(payload, "idempotencyKey"),
        writebackKind: stringField(payload, "kind"),
        writebackIssueId: stringField(payload, "issueId"),
        writebackRunId: stringField(payload, "runId"),
        writebackStatus: stringField(payload, "status"),
        writebackResultStatus: stringField(payload, "resultStatus"),
        writebackResultMessage: stringField(payload, "resultMessage"),
        writebackLastError: stringField(payload, "lastError"),
      });
    case "approval":
      return copyMissingEvidenceFields(snapshot, {
        approvalRequestId: stringField(payload, "requestId"),
        approvalIssueId: stringField(payload, "issueId"),
        approvalIssueIdentifier: stringField(payload, "issueIdentifier"),
        approvalStatus: stringField(payload, "status"),
        approvalRunId: stringField(payload, "runId"),
        approvalEvidenceCursor: stringField(payload, "evidenceCursor"),
        approvalAction: stringField(payload, "action"),
      });
    case "workspace":
      return copyMissingEvidenceFields(snapshot, {
        workspaceKey: stringField(payload, "workspaceKey"),
        workspacePath: stringField(payload, "workspacePath"),
        workspaceGitBranchName: stringField(payload, "gitBranchName"),
        workspaceRepoPath: stringField(payload, "repoPath"),
        workspaceBaseRef: stringField(payload, "baseRef"),
        role: stringField(payload, "role") ?? snapshot.role ?? null,
        runPhase: stringField(payload, "runPhase") ?? snapshot.runPhase ?? null,
        runKind: stringField(payload, "runKind") ?? snapshot.runKind ?? null,
      });
    case "runtime":
      return copyMissingEvidenceFields(snapshot, {
        runtimeRunning: booleanField(payload, "running"),
        runtimeRole:
          stringField(payload, "role") ?? stringField(payload, "runtimeRole"),
        runtimeRunPhase:
          stringField(payload, "runPhase") ??
          stringField(payload, "runtimeRunPhase"),
        runtimeRunKind:
          stringField(payload, "runKind") ??
          stringField(payload, "runtimeRunKind"),
        runtimeRunId:
          stringField(payload, "runId") ?? stringField(payload, "runtimeRunId"),
        runtimeActiveRunId:
          stringField(payload, "activeRunId") ??
          stringField(payload, "runtimeActiveRunId"),
        runtimeManualDispatchStage:
          stringField(payload, "manualDispatchStage") ??
          stringField(payload, "runtimeManualDispatchStage"),
        runtimeManualIgnoreState:
          booleanField(payload, "manualIgnoreState") ??
          booleanField(payload, "runtimeManualIgnoreState"),
        runtimeCancellationRequestedAt:
          stringField(payload, "cancellationRequestedAt") ??
          stringField(payload, "runtimeCancellationRequestedAt"),
        runtimeClaimed: booleanField(payload, "claimed"),
        runtimePaused: booleanField(payload, "paused"),
        runtimeRetrying: booleanField(payload, "retrying"),
        retryAttempt:
          numberField(payload, "attempt") ?? snapshot.retryAttempt ?? null,
        retryDelayMs:
          numberField(payload, "delayMs") ?? snapshot.retryDelayMs ?? null,
        retryError:
          stringField(payload, "error") ?? snapshot.retryError ?? null,
        retryDueAt: stringField(payload, "dueAt"),
      });
    case "harness":
      if (
        snapshot.evidenceEventType !== "retry_scheduled" &&
        snapshot.evidenceEventType !== "retry_fired" &&
        snapshot.evidenceEventType !== "retry_cleared"
      ) {
        return snapshot;
      }
      return copyMissingEvidenceFields(snapshot, {
        retryAttempt:
          numberField(payload, "attempt") ?? snapshot.retryAttempt ?? null,
        retryDelayMs:
          numberField(payload, "delayMs") ?? snapshot.retryDelayMs ?? null,
        retryError:
          stringField(payload, "error") ?? snapshot.retryError ?? null,
        retryDueAt: stringField(payload, "dueAt"),
      });
    default:
      return snapshot;
  }
}

function copyMissingEvidenceFields(
  snapshot: IssueHistorySnapshot,
  fields: Record<string, unknown>,
): IssueHistorySnapshot {
  const next: IssueHistorySnapshot = { ...snapshot };
  for (const [key, value] of Object.entries(fields)) {
    if (next[key] === undefined) next[key] = value;
  }
  return next;
}

function recordPayload(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function recordField<T extends object>(
  payload: Record<string, unknown> | null,
  key: string,
): T | null {
  const value = payload?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as T)
    : null;
}

function recordArrayField<T extends object>(
  payload: Record<string, unknown> | null,
  key: string,
): T[] | null {
  const value = payload?.[key];
  return Array.isArray(value) &&
    value.every((item) => item && typeof item === "object")
    ? (value as T[])
    : null;
}

function stringField(
  payload: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = payload?.[key];
  return typeof value === "string" ? value : null;
}

function numberField(
  payload: Record<string, unknown> | null,
  key: string,
): number | null {
  const value = payload?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanField(
  payload: Record<string, unknown> | null,
  key: string,
): boolean | null {
  const value = payload?.[key];
  return typeof value === "boolean" ? value : null;
}

function arrayField(
  payload: Record<string, unknown> | null,
  key: string,
): unknown[] | null {
  const value = payload?.[key];
  return Array.isArray(value) ? value : null;
}

function issueChildrenField(
  payload: Record<string, unknown> | null,
  key: string,
): NonNullable<Issue["children"]> | null {
  const value = payload?.[key];
  if (!Array.isArray(value)) return null;
  const children: NonNullable<Issue["children"]> = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    const id = record.id;
    const identifier = record.identifier;
    const state = record.state;
    if (
      id !== null &&
      id !== undefined &&
      typeof id !== "string"
    )
      return null;
    if (
      identifier !== null &&
      identifier !== undefined &&
      typeof identifier !== "string"
    )
      return null;
    if (
      state !== null &&
      state !== undefined &&
      typeof state !== "string"
    )
      return null;
    children.push({
      id: typeof id === "string" ? id : null,
      identifier: typeof identifier === "string" ? identifier : null,
      state: typeof state === "string" ? state : null,
    });
  }
  return children;
}

function stringArrayField(
  payload: Record<string, unknown> | null,
  key: string,
): string[] | null {
  const value = payload?.[key];
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : null;
}

function tokenCountsField(
  payload: Record<string, unknown> | null,
  key: string,
): TokenCounts | null {
  const value = payload?.[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const inputTokens = numberField(record, "inputTokens");
  const outputTokens = numberField(record, "outputTokens");
  const totalTokens = numberField(record, "totalTokens");
  return inputTokens === null || outputTokens === null || totalTokens === null
    ? null
    : { inputTokens, outputTokens, totalTokens };
}

export interface TransitionRuleset {
  id: string;
  priority: number;
  version?: string;
  fingerprint?: string;
  evaluate(
    snapshot: IssueCurrentStateSnapshot,
    history: readonly IssueHistorySnapshot[],
  ): IssueTransitionRequest | null;
}

export interface IssueTransitionAction<Context> {
  id: string;
  shouldExecute?(context: Context): boolean | Promise<boolean>;
  execute(context: Context): Promise<TransitionActionExecutionResult>;
}

export interface IssueTransition<Context> {
  kind: IssueTransitionKind;
  actions: readonly IssueTransitionAction<Context>[];
}

export interface IssueStateStore {
  close?(): Promise<void>;
  get(issueIdOrIdentifier: string): Promise<IssueStateRecord | null>;
  getCurrent(issueIdOrIdentifier: string): Promise<IssueCurrentFields | null>;
  getHistory(issueIdOrIdentifier: string): Promise<IssueHistorySnapshot[] | null>;
  listCurrent?(): Promise<IssueCurrentFields[]>;
  list(): Promise<IssueStateRecord[]>;
  ensureIssue(current: IssueCurrentFields): Promise<IssueStateRecord>;
  ensureCurrent(current: IssueCurrentFields): Promise<IssueCurrentFields>;
  updateCurrent(
    issue: Pick<Issue, "id" | "identifier">,
    patch: Partial<IssueCurrentFields>,
  ): Promise<IssueStateRecord>;
  patchCurrent(
    issue: Pick<Issue, "id" | "identifier">,
    patch: Partial<IssueCurrentFields>,
  ): Promise<IssueCurrentFields>;
  appendSnapshot(
    issue: Pick<Issue, "id" | "identifier">,
    snapshot: IssueHistorySnapshot,
  ): Promise<IssueStateRecord>;
  appendSnapshotOnly(
    issue: Pick<Issue, "id" | "identifier">,
    snapshot: IssueHistorySnapshot,
  ): Promise<void>;
  updateSnapshotActions(
    issue: Pick<Issue, "id" | "identifier">,
    historySnapshotId: string,
    patch: {
      actions?: readonly TransitionActionRecord[];
      errors?: readonly TransitionErrorRecord[];
    },
  ): Promise<IssueStateRecord | null>;
  updateSnapshotActionsOnly(
    issue: Pick<Issue, "id" | "identifier">,
    historySnapshotId: string,
    patch: {
      actions?: readonly TransitionActionRecord[];
      errors?: readonly TransitionErrorRecord[];
    },
  ): Promise<boolean>;
  appendSnapshotAction(
    issue: Pick<Issue, "id" | "identifier">,
    historySnapshotId: string,
    action: TransitionActionRecord,
  ): Promise<IssueStateRecord | null>;
  appendSnapshotActionOnly(
    issue: Pick<Issue, "id" | "identifier">,
    historySnapshotId: string,
    action: TransitionActionRecord,
  ): Promise<boolean>;
  appendSnapshotError(
    issue: Pick<Issue, "id" | "identifier">,
    historySnapshotId: string,
    error: TransitionErrorRecord,
  ): Promise<IssueStateRecord | null>;
  appendSnapshotErrorOnly(
    issue: Pick<Issue, "id" | "identifier">,
    historySnapshotId: string,
    error: TransitionErrorRecord,
  ): Promise<boolean>;
}

export function createIssueSnapshotId(): string {
  return `issue-snapshot:${randomUUID()}`;
}

export function createIssueHistorySnapshotId(): string {
  return `issue-history:${randomUUID()}`;
}

export function createTransitionId(kind: IssueTransitionKind): string {
  return `transition:${kind}:${randomUUID()}`;
}

export function transitionAction(input: {
  actionId?: string;
  actionType: string;
  status?: TransitionActionRecord["status"];
  startedAt?: string;
  completedAt?: string | null;
  message?: string | null;
  details?: unknown;
}): TransitionActionRecord {
  const now = new Date().toISOString();
  return {
    actionId: input.actionId ?? `action:${randomUUID()}`,
    actionType: input.actionType,
    status: input.status ?? "succeeded",
    startedAt: input.startedAt ?? now,
    completedAt: input.completedAt === undefined ? now : input.completedAt,
    message: input.message ?? null,
    details: input.details ?? null,
  };
}

export function transitionErrorFromUnknown(
  error: unknown,
  input: {
    errorType?: TransitionErrorRecord["errorType"];
    actionId?: string | null;
    details?: unknown;
  } = {},
): TransitionErrorRecord {
  const record = error instanceof Error ? error : null;
  return {
    errorId: `error:${randomUUID()}`,
    errorType: input.errorType ?? "runtime",
    actionId: input.actionId ?? null,
    message: record?.message ?? String(error),
    stack: record?.stack ?? null,
    code:
      typeof (error as { code?: unknown })?.code === "string"
        ? (error as { code: string }).code
        : null,
    cause:
      record?.cause instanceof Error
        ? record.cause.message
        : record?.cause === undefined
          ? null
          : String(record.cause),
    details: input.details ?? null,
    recordedAt: new Date().toISOString(),
  };
}

export function immutableIssueSnapshot(
  snapshot: IssueCurrentStateSnapshot,
): IssueCurrentStateSnapshot {
  return deepFreeze(
    JSON.parse(JSON.stringify(snapshot)) as IssueCurrentStateSnapshot,
  );
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}

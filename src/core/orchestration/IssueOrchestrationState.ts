import { randomUUID } from "node:crypto";

import type { AgentHandoffRepairKind } from "../harness/AgentHarness.js";
import type { MergePolicyObservation } from "../merge/MergePolicyService.js";
import type {
  IssueCompletionReportRecord,
  IssueMergeConflictMetadata,
  IssueMergeGateResultRecord,
  IssueMergeGateState,
  IssueMergeMetadata,
  IssueReviewFeedbackRecord,
  IssueReviewVerdictRecord,
  IssueTriageBlockerRecord,
} from "../persistence/IssueLifecycleStore.js";
import type { RunRecord } from "../persistence/RunTranscriptStore.js";
import type { AgentRunPhase, AgentRunKind, AgentRunRole, Issue, TokenCounts } from "../types.js";

export type IssueTriggerType = "orchestrator.tick" | "manual.cli_agent_run" | "runtime.requested";
export type IssueTriggerSource = "orchestrator" | "manual_cli" | "transition";

export type IssueTransitionKind =
  | "record_evidence"
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
  | "reconcile_issue_triage_report_writeback"
  | "reconcile_post_mortem_report_writeback"
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
export type IssueEvidenceKind = "run" | "lifecycle" | "writeback" | "approval" | "workspace" | "tracker" | "harness";

export interface TransitionRequestContextEnvelope<K extends string, P> {
  kind: K;
  requestId: string;
  requestedAt: string;
  parentHistorySnapshotId: string | null;
  parentTransitionKind: IssueTransitionKind | null;
  payload: P;
}

export type MergePolicyChainTransitionRequestContext = TransitionRequestContextEnvelope<
  "merge_policy_chain",
  {
    chainId: string;
    iteration: number;
    maxIterations: number;
  }
>;

export type IssueTransitionRequestContext = MergePolicyChainTransitionRequestContext;

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
  lastIssueBreakdownPlanApplicationStatus: string | null;
  lastIssueBreakdownPlanIssueContentFingerprint: string | null;
  lastIssueBreakdownPlanConfigFingerprint: string | null;
  lastIssueBreakdownPlanSatisfiesCurrentValidation: boolean;
  currentIssueContentFingerprint: string;
  currentIssueBreakdownConfigFingerprint: string;
  lastIssueTriageReportId: string | null;
  lastIssueTriageReportTriggerFingerprint: string | null;
  lastIssueTriageReportWritebackOperationKeys: string[] | null;
  currentIssueTriageTriggerFingerprint: string | null;
  issueTriageCurrentTriggerReportIds: string[];
  latestIssueTriageReportBlockers: IssueTriageBlockerRecord[];
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
  mergeGate: IssueMergeGateState | null;
  mergeConflict: IssueMergeConflictMetadata | null;
  lifecycleSummaryCiStatus: string | null;
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
  triggerRunId?: string | null;
  triggerReason?: string | null;
  retryAttempt?: number | null;
  retryDelayMs?: number | null;
  retryError?: string | null;
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
  list(): Promise<IssueStateRecord[]>;
  ensureIssue(current: IssueCurrentFields): Promise<IssueStateRecord>;
  updateCurrent(issue: Pick<Issue, "id" | "identifier">, patch: Partial<IssueCurrentFields>): Promise<IssueStateRecord>;
  appendSnapshot(issue: Pick<Issue, "id" | "identifier">, snapshot: IssueHistorySnapshot): Promise<IssueStateRecord>;
  updateSnapshotActions(
    issue: Pick<Issue, "id" | "identifier">,
    historySnapshotId: string,
    patch: {
      actions?: readonly TransitionActionRecord[];
      errors?: readonly TransitionErrorRecord[];
    },
  ): Promise<IssueStateRecord | null>;
  appendSnapshotAction(
    issue: Pick<Issue, "id" | "identifier">,
    historySnapshotId: string,
    action: TransitionActionRecord,
  ): Promise<IssueStateRecord | null>;
  appendSnapshotError(
    issue: Pick<Issue, "id" | "identifier">,
    historySnapshotId: string,
    error: TransitionErrorRecord,
  ): Promise<IssueStateRecord | null>;
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
    code: typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : null,
    cause: record?.cause instanceof Error ? record.cause.message : record?.cause === undefined ? null : String(record.cause),
    details: input.details ?? null,
    recordedAt: new Date().toISOString(),
  };
}

export function immutableIssueSnapshot(snapshot: IssueCurrentStateSnapshot): IssueCurrentStateSnapshot {
  return deepFreeze(JSON.parse(JSON.stringify(snapshot)) as IssueCurrentStateSnapshot);
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

import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ServiceConfig } from "../config/Config.js";
import {
  BaseRefVerifier,
  baseRefBlockedReason,
  baseRefObservationInputFingerprint,
  type IssueBaseRefObservation,
} from "../BaseRefVerification.js";
import { SymphonyError, errorMessage } from "../errors.js";
import type {
  AgentActivitySource,
  AgentEvent,
  AgentHandoffRepairKind,
  AgentHarness,
  AgentHermesResumeContext,
  AgentPromptBundle,
  AgentRunSdkStatus,
  OperatorChatRunContext,
} from "../harness/AgentHarness.js";
import {
  harnessSupportsContinuation,
  harnessSupportsMcpHandoff,
  renderCompletionMcpHandoffPrompt,
  renderIssueBreakdownMcpHandoffPrompt,
  renderIssuePostMortemMcpHandoffPrompt,
  renderIssueTriageMcpHandoffPrompt,
  renderMergeConflictResolutionMcpHandoffPrompt,
  renderOperatorChatMcpPrompt,
  renderReviewMcpHandoffPrompt,
} from "../harness/HandoffMcp.js";
import type { Logger } from "../logging/StructuredLogger.js";
import type {
  TrackerClient,
  TrackerIssueCandidateFilterBranch,
  TrackerIssueCandidateFilterInput,
  TrackerIssueCandidatePage,
} from "../tracker/TrackerClient.js";
import {
  runKindForPhase,
  toIssueStatusView,
  type AgentRunPhase,
  type AgentRunKind,
  type AgentRunRole,
  type Issue,
  type IssueStatusView,
  type RuntimeTotals,
  type TokenCounts,
  type Workspace,
} from "../types.js";
import type {
  IssueWorkspaceRecord,
  WorkspaceManager,
} from "../workspace/WorkspaceManager.js";
import {
  CompletionReportService,
  isFinalizedCompletionReport,
  isPendingPublicationApprovalReason,
  pendingPublicationHandoffForRun,
  type CompletionReportPullRequestPublisher,
} from "../CompletionReportService.js";
import {
  latestFreshIssueBreakdownPlan,
  renderIssueBreakdownPlanSummary,
} from "../IssueBreakdownPlanService.js";
import { IssueBreakdownPlanApplyService } from "../IssueBreakdownPlanApplyService.js";
import {
  activeIssueTriageBlockers,
  activeWorkerOwnedIssueTriageBlockers,
  ISSUE_TRIAGE_BLOCKER_KINDS,
  ISSUE_TRIAGE_BLOCKER_NEXT_ACTORS,
  ISSUE_TRIAGE_BLOCKER_STATUSES,
  issueTriageTriggerFingerprint,
  isIssueTriageBlockedReason,
  isReviewerBlockedTriageReason,
  latestIssueTriageReport,
  latestIssueTriageReportForFingerprint,
  shouldIssueTriageManualRun,
  shouldIssueTriageRun,
  sortIssueTriageBlockers,
} from "../IssueTriageService.js";
import { LifecycleReconciliationService } from "../LifecycleReconciliationService.js";
import { RunTranscriptCleanupService } from "../RunTranscriptCleanupService.js";
import {
  issuePostMortemTriggerFingerprint,
  latestIssuePostMortemReportForFingerprint,
  shouldIssuePostMortemManualRun,
  shouldIssuePostMortemRun,
} from "../IssuePostMortemService.js";
import { PromptRenderer } from "../workflow/PromptRenderer.js";
import { summarizeIssueContractForPrompt } from "../IssueContractLint.js";
import {
  DEFAULT_REVIEWER_REVIEW_LOOP_GUIDANCE,
  DEFAULT_WORKER_INVARIANT_REPAIR_GUIDANCE,
  formatGeneralScenarioMatrix,
  formatPromptExtensions,
} from "../workflow/ReviewLoopPromptGuidance.js";
import {
  compareRunChronology,
  type RunActivitySnapshot,
  type RunMetadata,
  type RunRecord,
  type RunTranscriptStore,
  type StartRunInput,
  type TranscriptEvent,
  type UpdateRunInput,
} from "../persistence/RunTranscriptStore.js";
import type {
  OrchestratorConversationMessage,
  OrchestratorConversationStore,
} from "../persistence/OrchestratorConversationStore.js";
import {
  FileProviderGateStore,
  type ProviderGateStore,
} from "../persistence/ProviderGateStore.js";
import { SqliteIssueStateStore } from "../orchestration/SqliteIssueStateStore.js";
import {
  SqliteMergeQueueStore,
  type MergeQueueReleaseResult,
  type MergeQueueSnapshot,
  type MergeQueueStore,
} from "../orchestration/SqliteMergeQueueStore.js";
import {
  IssueCurrentStateBuilder,
  type IssueCurrentStateRuntimeState,
} from "../orchestration/IssueCurrentStateBuilder.js";
import {
  IssueOrchestrationEngine,
  type IssueHistoryReplayResult,
} from "../orchestration/IssueOrchestrationEngine.js";
import {
  transitionAction,
  transitionErrorFromUnknown,
  type IssueCurrentFields,
  type IssueCurrentStateSnapshot,
  type IssueEvidenceKind,
  type IssueHistorySnapshot,
  type IssueStateRecord,
  type IssueStateStore,
  type IssueTransition,
  type IssueTransitionKind,
  type IssueTransitionRequest,
  type IssueTransitionRequestContext,
  type IssueTriggerSource,
  type IssueTriggerType,
  type TransitionActionRecord,
  type TransitionRuleset,
} from "../orchestration/IssueOrchestrationState.js";
import {
  normalizeProviderLimitSignal,
  providerLimitDelayMs,
  type ProviderLimitSignal,
  type RuntimeProviderGate,
} from "../provider/ProviderLimits.js";
import { mapAgentEventToRunActivityEvent } from "../transcript/RunActivityEventMapper.js";
import { sanitizeAgentEventForPublicOutput } from "../transcript/TranscriptProjection.js";
import { appendLaneMemoTelemetry } from "../persistence/LaneMemoTelemetry.js";
import {
  buildWorkerHandoffPacket,
  isSupersededLifecycleRecord,
  latestCurrentApprovalPassVerdict,
  phaseForIssueState,
  type IssueBreakdownPlanRecord,
  type IssueCompletionReportRejectionRecord,
  type IssueCompletionReportRecord,
  type IssueLifecyclePatch,
  type IssueLifecycleRecord,
  type IssueLifecycleSummaryReference,
  type IssueLifecycleStore,
  type IssueMergeConflictMetadata,
  type IssueMergeConflictResolutionReportRecord,
  type IssueMergeGateState,
  type IssuePostMortemReportRecord,
  type IssueReviewerOutputContract,
  type IssueReviewVerdictRecord,
  type IssueReviewVerdictSubmissionRecord,
  type IssueTriageBlockerKind,
  type IssueTriageBlockerRecord,
  type IssueTriageReportRecord,
} from "../persistence/IssueLifecycleStore.js";
import {
  isMergeGateVerdict,
  MergePolicyService,
  type MergePolicyConflictPreparationExecution,
  type MergePolicyConflictPreparationPlan,
  type MergePolicyConflictWritebackPlan,
  type MergePolicyDoneWritebackPlan,
  type MergePolicyGateFailurePlan,
  type MergePolicyGitHubClient,
  type MergePolicyHeadSupersessionPlan,
  type MergePolicyMergePlan,
  type MergePolicyObservation,
  type MergePolicyRecordedMerge,
  type MergePolicyResult,
} from "../merge/MergePolicyService.js";
import {
  mergePolicyObservationFromUnknown,
  mergePolicyTransitionRequestFromObservation,
} from "../merge/MergePolicyDecision.js";
import {
  sanitizeStaleMergeGateLifecycle,
  staleMergeGateLifecyclePatch,
} from "../merge/MergeGateLifecycle.js";
import {
  formatWorkerReviewEvidencePrompt,
  isActiveReviewEvidenceItem,
  PullRequestReviewEvidenceService,
  type PullRequestReviewEvidenceClient,
} from "../review/PullRequestReviewEvidenceService.js";
import {
  formatWorkerMergeGatePromptResult,
  formatWorkerReviewVerdictPrompt,
  planReviewVerdictSubmissionApplication,
  type WorkerMergeGatePromptResult,
} from "../ReviewVerdictService.js";
import {
  PlaceholderContinuationSummarizer,
  type ContinuationSummarizer,
} from "../summarization/ContinuationSummarizer.js";
import {
  SqliteWritebackOutboxStore,
  type WritebackProcessor,
} from "../writeback/WritebackOutbox.js";
import type { NewWritebackOperation } from "../writeback/WritebackOutbox.js";
import {
  planBlockedEscalationWritebacks,
  planDispatchWriteback,
  planIssuePostMortemReportWritebacks,
  planIssueTriageBlockedReboundWriteback,
  planIssueTriageReportWritebacks,
  planMergeGateHeadSupersessionRecoveryWritebacks,
  planRunCancelledComment,
  planRunFailedComment,
  planRunStartedComment,
  planRunSucceededWritebacks,
} from "../writeback/TransitionPolicy.js";
import { createGitHubPullRequestClientForCapability } from "../../integrations/github/GitHubCredentialResolver.js";
import type { PullRequestMergeResult } from "../../integrations/github/GitHubPullRequestClient.js";
import {
  OPERATOR_REJECTED_PUBLICATION_ERROR,
  type OperatorApprovalRecord,
  type OperatorApprovalService,
} from "../approval/OperatorApprovalService.js";
import type {
  OrchestratorChatCommand,
  OrchestratorChatCommandResult,
} from "./OrchestratorChatCommand.js";
import {
  runShutdownAction,
  type ShutdownProgressObserver,
} from "../shutdown/ShutdownProgress.js";

export interface OrchestratorOptions {
  config: ServiceConfig;
  tracker: TrackerClient;
  workspaceManager: WorkspaceManager;
  harness: AgentHarness;
  logger: Logger;
  promptTemplate: string;
  runStore?: RunTranscriptStore;
  lifecycleStore?: IssueLifecycleStore;
  writeback?: WritebackProcessor;
  pullRequestClient?: PullRequestDiscoveryClient;
  pullRequestReviewClient?: PullRequestReviewEvidenceClient;
  pullRequestMergeClient?: MergePolicyGitHubClient;
  completionReportPublisher?: CompletionReportPullRequestPublisher;
  operatorApproval?: Pick<
    OperatorApprovalService,
    "requestPublicationApproval" | "waitForPublicationApprovalRequest"
  > &
    Partial<Pick<OperatorApprovalService, "get" | "getByDedupe">>;
  providerGateStore?: ProviderGateStore;
  issueStateStore?: IssueStateStore;
  mergeQueueStore?: MergeQueueStore;
  orchestratorConversationStore?: OrchestratorConversationStore;
  statusServerBaseUrl?: () => string | null;
  statusMutationToken?: string | null;
}

export interface OrchestratorStopOptions {
  progress?: ShutdownProgressObserver | undefined;
}

export interface IssueHistoryInspectionResult {
  found: boolean;
  issueIdOrIdentifier: string;
  record: IssueStateRecord | null;
  replay: IssueHistoryReplayResult[];
  replayMatched: boolean;
}

export interface PullRequestDiscoveryClient {
  findOpenPullRequestByBranch(input: {
    branchName: string;
  }): Promise<DiscoveredPullRequest | null>;
}

export interface DiscoveredPullRequest {
  url: string;
  number: number;
  headBranch: string;
  headSha: string | null;
  lastPushedAt: string | null;
  draft?: boolean;
}

export interface ContinuationSummaryCreationResult {
  summaryReference: IssueLifecycleSummaryReference;
  lifecycle: IssueLifecycleRecord;
}

export interface PromptPreviewOptions {
  state?: string;
  role?: AgentRunRole | "auto";
  phase?: AgentRunPhase | "auto";
  force?: boolean;
}

export type ManualAgentRunStage =
  | "worker"
  | "reviewer"
  | "triage"
  | "planner"
  | "post_mortem"
  | "merge_conflict";

export interface ManualAgentRunOptions {
  stage: ManualAgentRunStage;
  forceLabels?: boolean;
  ignoreState?: boolean;
}

export interface ManualAgentEligibilityOptions {
  stage: ManualAgentRunStage;
  forceLabels?: boolean;
  ignoreState?: boolean;
}

export type ManualAgentRunResult =
  | {
      status: "completed";
      issue: Issue;
      role: AgentRunRole;
      runPhase: AgentRunPhase;
      runKind: AgentRunKind;
      runId: string | null;
      sessionId: string | null;
      finalStatus: "succeeded" | "failed" | "cancelled" | "unknown";
      error: string | null;
      lifecycle: IssueLifecycleRecord | null;
    }
  | {
      status: "not_dispatched";
      issue: Issue | null;
      role: AgentRunRole;
      runPhase: AgentRunPhase;
      runKind: AgentRunKind;
      reason: string;
    };

export interface ManualAgentEligibilityResult {
  issue: Issue | null;
  role: AgentRunRole;
  runPhase: AgentRunPhase;
  runKind: AgentRunKind;
  eligible: boolean;
  reason: string | null;
  explanation: string | null;
}

export type PromptPreviewResult =
  | {
      status: "rendered";
      issue: Issue;
      role: AgentRunRole;
      runPhase: AgentRunPhase;
      runKind: AgentRunKind;
      promptBundle: AgentPromptBundle;
      prompt: string;
      userPrompt: string;
      ephemeralSystemPrompt: string;
      metadata: PromptPreviewMetadata;
    }
  | {
      status: "no_prompt";
      issue: Issue;
      reason: string;
      metadata: PromptPreviewMetadata;
    };

export interface PromptPreviewMetadata {
  simulatedState: string | null;
  selectedRole: AgentRunRole | null;
  selectedPhase: AgentRunPhase | null;
  selectedRunKind: AgentRunKind | null;
  dispatchDecision: "would_dispatch" | "forced" | "no_prompt";
  promptBundle?: AgentPromptBundle["metadata"];
  warnings: string[];
}

export interface RunningEntry {
  issue: Issue;
  role: AgentRunRole;
  runPhase: AgentRunPhase;
  workspacePath: string | null;
  workspace: Workspace | null;
  sessionId: string | null;
  runId: string | null;
  activeRunId: string | null;
  issueHistorySnapshotId: string | null;
  lifecycle: IssueLifecycleRecord | null;
  worker: Promise<void>;
  abortController: AbortController;
  startedAt: Date;
  lastEventAt: Date | null;
  lastEvent: string | null;
  lastMessage: string | null;
  sdkRunStatus: AgentRunSdkStatus | null;
  sdkRunStatusUpdatedAt: Date | null;
  sdkRunStatusSource: "initial" | "onDidChangeStatus" | "wait" | null;
  failureKind: string | null;
  failureDiagnosticCode: string | null;
  failureDiagnosticMessage: string | null;
  failureDiagnosticAt: Date | null;
  failureDiagnosticPayload: unknown;
  turnCount: number;
  retryAttempt: number;
  tokens: TokenCounts;
  activeRunTokens: TokenCounts;
  cleanupWorkspaceOnExit: boolean;
  suppressRetryOnExit: boolean;
  completionReportAccepted: boolean;
  mergeConflictResolutionAccepted: boolean;
  issueBreakdownPlanAccepted: boolean;
  issueTriageReportAccepted: boolean;
  issuePostMortemReportAccepted: boolean;
  pullRequestHandoffAccepted: boolean;
  reviewVerdictAccepted: boolean;
  reviewEvidence: ReviewerDispatchEvidence | null;
  manualDispatch: {
    stage: ManualAgentRunStage;
    forceLabels: boolean;
    ignoreState: boolean;
  } | null;
  handoffRepair: {
    sourceRunId: string;
    kind: AgentHandoffRepairKind;
    attempt: number;
  } | null;
  hermesResume: AgentHermesResumeContext | null;
  cancellationRequestedAt: Date | null;
  cancellationSource: RunCancellationSource | null;
  cancellationReason: string | null;
  abortSignalledAt: Date | null;
  harnessStopRequestedAt: Date | null;
  harnessStopFailedAt: Date | null;
  harnessStopFailedReason: string | null;
  lastStreamActivityAt: Date | null;
  lastDeltaOrToolActivityAt: Date | null;
  lastToolActivityAt: Date | null;
  providerLimitSignal: ProviderLimitSignal | null;
}

interface ReviewerDispatchEvidence {
  lifecycle: IssueLifecycleRecord;
  completionReport: IssueCompletionReportRecord;
  workerRun: RunRecord | null;
  runDigest: string[];
}

type WorkerDispatchDecision =
  | { action: "dispatch"; runPhase: AgentRunPhase }
  | { action: "skip"; reason: string };

interface DispatchGateOptions {
  ignoreExcludeLabels?: boolean;
  ignoreState?: boolean;
}

export interface RetryEntry {
  issueId: string;
  identifier: string;
  attempt: number;
  delayMs: number;
  dueAtMs: number;
  timer: NodeJS.Timeout;
  error: string | null;
  runPhase: AgentRunPhase;
}

interface OrchestratorTransitionContext {
  issue: Issue;
  transition: IssueHistorySnapshot;
  attempt: number | null;
  allowExistingClaim: boolean;
  dispatch: DispatchTransitionScratch;
  baseRef: BaseRefTransitionScratch;
  reportWriteback: ReportWritebackTransitionScratch;
  publicationApproval: PublicationApprovalTransitionScratch;
  termination: TerminationTransitionScratch;
  retry: RetryTransitionScratch;
  blockIssue: BlockIssueTransitionScratch;
  lifecycleReset: LifecycleResetTransitionScratch;
  mergeConflictBlock: MergeConflictBlockTransitionScratch;
  headSupersessionRecovery: HeadSupersessionRecoveryTransitionScratch;
  triageRebound: TriageReboundTransitionScratch;
  mergePolicy: MergePolicyTransitionScratch;
  handoffRepair: HandoffRepairTransitionScratch;
  handoffReconciliation: HandoffReconciliationTransitionScratch;
}

interface DispatchTransitionScratch {
  issue?: Issue;
  reviewEvidence?: ReviewerDispatchEvidence | null;
  dispatchWriteback?: NewWritebackOperation | null;
  entry?: RunningEntry;
}

interface BaseRefTransitionScratch {
  observation?: IssueBaseRefObservation;
  repairResult?: MergePolicyResult;
}

interface ReportWritebackTransitionScratch {
  lifecycle?: IssueLifecycleRecord;
  issueTriageReport?: IssueTriageReportRecord;
  postMortemReport?: IssuePostMortemReportRecord;
  operations?: NewWritebackOperation[];
  operationKeys?: string[];
}

interface PublicationApprovalTransitionScratch {
  lifecycle?: IssueLifecycleRecord;
  writebackOutbox?: SqliteWritebackOutboxStore;
  service?: CompletionReportService;
  result?: unknown;
}

interface TerminationTransitionScratch {
  entry?: RunningEntry;
  reason?: string;
  cleanupWorkspace?: boolean;
}

interface RetryTransitionScratch {
  attempt?: number;
  delayMs?: number;
  dueAtMs?: number;
  error?: string | null;
  runPhase?: AgentRunPhase;
}

interface BlockIssueTransitionScratch {
  lifecycle?: IssueLifecycleRecord;
  blockedLifecycle?: IssueLifecycleRecord;
  reason?: string;
  runId?: string;
}

interface LifecycleResetTransitionScratch {
  lifecycle?: IssueLifecycleRecord;
}

interface MergeConflictBlockTransitionScratch {
  lifecycle?: IssueLifecycleRecord;
  conflict?: IssueMergeConflictMetadata;
  runId?: string;
  reason?: string;
}

interface HeadSupersessionRecoveryTransitionScratch {
  lifecycle?: IssueLifecycleRecord;
  report?: IssueCompletionReportRecord;
  verdict?: IssueReviewVerdictRecord;
  operations?: NewWritebackOperation[];
}

interface TriageReboundTransitionScratch {
  lifecycle?: IssueLifecycleRecord;
  report?: IssueTriageReportRecord;
  reason?: string;
  operation?: NewWritebackOperation | null;
}

interface MergePolicyTransitionScratch {
  service?: MergePolicyService;
  observation?: MergePolicyObservation;
  result?: unknown;
  doneWritebackPlan?: MergePolicyDoneWritebackPlan;
  mergePlan?: MergePolicyMergePlan;
  mergeResult?: PullRequestMergeResult;
  recordedMerge?: MergePolicyRecordedMerge;
  gateFailurePlan?: MergePolicyGateFailurePlan;
  headSupersessionPlan?: MergePolicyHeadSupersessionPlan;
  conflictPreparationPlan?: MergePolicyConflictPreparationPlan;
  conflictPreparationExecution?: MergePolicyConflictPreparationExecution;
  conflictWritebackPlan?: MergePolicyConflictWritebackPlan;
}

interface HandoffRepairTransitionScratch {
  entry?: RunningEntry;
  workspace?: Workspace;
  sourceRunId?: string;
  kind?: RepairableHandoffKind;
  repairAttempt?: number;
  turnNumber?: number;
  resume?: AgentHermesResumeContext;
  promptBundle?: AgentPromptBundle;
  accepted?: boolean;
}

interface HandoffReconciliationTransitionScratch {
  entry?: RunningEntry;
  runId?: string;
  lifecycle?: IssueLifecycleRecord;
  completionReport?: IssueCompletionReportRecord;
  completionReportRejection?: IssueCompletionReportRejectionRecord;
  mergeConflictResolutionReport?: IssueMergeConflictResolutionReportRecord;
  issueBreakdownPlan?: IssueBreakdownPlanRecord;
  issueTriageReport?: IssueTriageReportRecord;
  postMortemReport?: IssuePostMortemReportRecord;
  reviewVerdict?: IssueReviewVerdictRecord;
  reviewVerdictSubmission?: IssueReviewVerdictSubmissionRecord;
}

interface IssueTransitionEventInput {
  issue: Issue;
  triggerType: IssueTriggerType;
  triggerSource: IssueTriggerSource;
  candidateSource: string;
  manualStage?: ManualAgentRunStage | null;
  manualForceLabels?: boolean;
  manualIgnoreState?: boolean;
  snapshotPatch?: Partial<IssueCurrentStateSnapshot>;
  transitionPatch?: Partial<IssueTransitionRequest>;
  attempt?: number | null;
  allowExistingClaim?: boolean;
}

interface RequestedIssueTransitionInput {
  issue: Issue;
  candidateSource: string;
  context: IssueTransitionRequestContext;
  snapshotPatch?: Partial<IssueCurrentStateSnapshot>;
  transitionPatch?: Partial<IssueTransitionRequest>;
  attempt?: number | null;
  allowExistingClaim?: boolean;
}

interface IssueTransitionEventResult {
  transition: IssueHistorySnapshot | null;
  acted: boolean;
}

interface IssueEvidenceSnapshotInput {
  issue: Issue;
  evidenceKind: IssueEvidenceKind;
  eventType: string;
  sourceId?: string | null;
  payload?: unknown;
  reason?: string | null;
  triggerType?: IssueTriggerType;
  triggerSource?: IssueTriggerSource;
}

interface LifecycleEvidenceInput {
  issue: Issue;
  lifecycle: IssueLifecycleRecord;
  patch: IssueLifecyclePatch;
  sourceId?: string | null;
  reason?: string | null;
  eventType?: string;
}

type TerminalRunPatch = Pick<
  UpdateRunInput,
  "status" | "completedAt" | "error" | "tokens" | "metadata"
>;
type TerminalUpdateResult =
  | { updated: true; record: RunRecord | null }
  | { updated: false; record: RunRecord | null };
type AcceptedHandoffKind =
  | "completion_report"
  | "pull_request_handoff"
  | "issue_breakdown_plan"
  | "issue_triage_report"
  | "issue_post_mortem_report"
  | "merge_conflict_resolution";
type RepairableHandoffKind = AgentHandoffRepairKind;

interface OperatorChatQueueEntry {
  conversationId: string;
  messageId: string;
  command: OrchestratorChatCommand;
  abortController: AbortController;
  worker: Promise<void>;
  runId: string | null;
  sessionId: string | null;
  startedAt: Date;
  tokens: TokenCounts;
}

const PLANNING_NO_PLAN_ERROR =
  "Planning run completed without submit_issue_breakdown_plan";
const PLANNING_FAILURE_DIAGNOSTIC_CODE = "planning_run_failed";
const TRIAGE_NO_REPORT_ERROR =
  "Issue triage run completed without submit_issue_triage_report";
const POST_MORTEM_NO_REPORT_ERROR =
  "Issue post-mortem run completed without submit_issue_post_mortem_report";

export interface RuntimeSnapshot {
  generatedAt: string;
  counts: {
    running: number;
    retrying: number;
    paused: number;
    providerGates: number;
  };
  providerGates: RuntimeProviderGate[];
  providerGateCounts: {
    active: number;
    manual: number;
    autoResume: number;
  };
  running: Array<{
    issueId: string;
    issueIdentifier: string;
    role: AgentRunRole;
    runPhase: AgentRunPhase;
    runKind: AgentRunKind;
    state: string;
    workspacePath: string | null;
    sessionId: string | null;
    runId: string | null;
    turnCount: number;
    lastEvent: string | null;
    lastMessage: string | null;
    startedAt: string;
    lastEventAt: string | null;
    liveness: RunLivenessState;
    cancellation: RunCancellationState;
    activity?: RunActivityState;
    tokens: TokenCounts;
    lifecycle: IssueLifecycleRecord | null;
    metadata: IssueRunMetadata;
    issueDetails: IssueStatusView;
  }>;
  retrying: Array<{
    issueId: string;
    issueIdentifier: string;
    attempt: number;
    dueAt: string;
    error: string | null;
  }>;
  paused: string[];
  totals: RuntimeTotals;
  rateLimits: unknown;
}

export type RunLivenessStatus =
  | "starting"
  | "active"
  | "terminal_pending"
  | "stalled"
  | "cancelling";

export interface RunIdleAlertState {
  active: boolean;
  thresholdMs: number | null;
  lastActivityAt: string;
  secondsSinceLastActivity: number;
  reason: "observe_only" | "suppressed" | null;
}

export interface RunLivenessState {
  status: RunLivenessStatus;
  activeRunId: string | null;
  lastActivityAt: string;
  secondsSinceLastActivity: number;
  stallTimeoutMs: number | null;
  sdkRunStatus?: AgentRunSdkStatus | null;
  sdkRunStatusUpdatedAt?: string | null;
  sdkRunStatusSource?: "initial" | "onDidChangeStatus" | "wait" | null;
  idleAlert?: RunIdleAlertState;
}

export type RunCancellationSource =
  | "operator"
  | "state_change"
  | "stalled"
  | "service_stop";

export interface RunCancellationState {
  requested: boolean;
  requestedAt: string | null;
  source: RunCancellationSource | null;
  reason: string | null;
  abortSignalled: boolean;
  harnessStopRequestedAt: string | null;
  harnessStopFailedAt?: string | null;
  harnessStopFailedReason?: string | null;
  cancelFailed?: CancelFailedState;
  suppressRetryOnExit: boolean;
}

export interface RunActivityState extends RunActivitySnapshot {
  unavailable: string[];
}

export interface CancelFailedState {
  tracked: true;
  active: boolean;
  phase:
    | "none"
    | "requested"
    | "failed"
    | "resolved_cancelled"
    | "resolved_failed";
  at: string | null;
  reason: string | null;
  source: "harness_stop" | "cancel_ignored" | null;
}

export interface IssueRunMetadata {
  prUrl: string | null;
  prNumber: number | null;
  prHeadSha: string | null;
  prBranch: string | null;
  ciStatus: string | null;
  lastPushedAt: string | null;
  lastEvidenceCursor: string | null;
  branchName: string | null;
  gitBranchName: string | null;
  repoPath: string | null;
  baseRef: string | null;
}

const PROJECT_REVIEWER_PROMPT_EXTENSIONS_MARKER =
  "[[SYMPHONY_PROJECT_REVIEWER_PROMPT_EXTENSIONS]]";
const EPHEMERAL_SYSTEM_PROMPT_MAX_CHARS = 12_000;
const PROMPT_SUMMARY_BLOCK_MAX_CHARS = 1_600;
const ORCHESTRATOR_RULESET_VERSION = "2026-06-21.issue-history-v1";
const STARTUP_TERMINAL_CLEANUP_CONCURRENCY = 4;

const DEFAULT_EPHEMERAL_SYSTEM_PROMPT_TEMPLATE = `
# Symphony Current Run Directive

## Role / Phase
{{ rolePhase }}

## Current Objective
{{ currentObjective }}

## Pinned Issue Contract
{{ pinnedIssueContract }}

## Active Findings Or Triage Recommendation
{{ activeDirective }}

## Success Conditions
{{ successConditions }}

## Scope Guards
{{ scopeGuards }}

## Required Handoff
{{ requiredHandoff }}
`.trim();

const DEFAULT_REVIEWER_PROMPT_TEMPLATE = `
You are a reviewer agent for {{ issue.identifier }}.

Inspect only. Do not modify files, create commits, push branches, comment on Linear, transition Linear state, or otherwise change workspace or lifecycle state directly.

Use the linked GitHub pull request as the primary detailed review surface. Call the submit_pull_request_review_feedback MCP tool before any verdict submission to leave concrete feedback directly on the lifecycle-bound PR by submitting a GitHub PR review and/or posting PR review comments. A pass verdict requires a prior whole-PR review with kind "review" and event "APPROVE" in this reviewer run. Requested changes should use kind "review" with event "REQUEST_CHANGES" when PR feedback is submitted, and must point to the relevant files, lines, or threads on GitHub.

After submit_pull_request_review_feedback succeeds, pass the returned reviewUrl/commentUrls/urls into submit_review_verdict.evidence. Then call the submit_review_verdict MCP tool before ending the run. Use verdict "fail" only for worker-owned, contract-entitled gate findings; use verdict "blocked" when review cannot complete because required validation, tooling, credentials, or service-owned evidence is unavailable to worker/reviewer roles; use verdict "pass" when all written acceptance criteria are satisfied, even if non-gating discovery findings remain. The MCP servers supply the active run, issue, and lifecycle-bound PR context; include runId, issueId, PR number, repository, token, or commit identity only if a tool explicitly asks for it.

${DEFAULT_REVIEWER_REVIEW_LOOP_GUIDANCE}

${formatGeneralScenarioMatrix()}

${PROJECT_REVIEWER_PROMPT_EXTENSIONS_MARKER}

Tool payload guidance:
- acceptanceResults: one entry per acceptance criterion with satisfied true/false and concrete evidence.
- gateFindings: blocking worker-owned contract defects only. A fail verdict requires at least one gate finding, and every gate finding must include requirementIds, contractAnchor, scenario, scenarioEntitlement, observedFailure, currentIssueOwnership, boundedRepair, and evidence. Do not use gateFindings for a blocked verdict.
- discoveryFindings: non-gating discovered scope, adjacent sibling scenarios, hidden matrix axes, sibling issue scope, future hardening, or out-of-scope concerns. A pass verdict may include discovery findings.
- findings: compact summaries; for fail verdicts this equals gateFindings[].summary, for blocked verdicts this names the non-worker-owned blocker, and for pass verdicts this is empty.
- evidence: PR review/comment URLs or other durable review evidence.
- idempotencyKey: a stable unique key for this reviewer verdict.

Feedback tool payload guidance:
- Never call submit_pull_request_review_feedback with {}. The MCP server supplies the active PR context only; you must still provide the feedback payload.
- Minimal pass approval payload: {"kind":"review","event":"APPROVE","body":"...","idempotencyKey":"..."}.
- Minimal requested-changes payload: {"kind":"review","event":"REQUEST_CHANGES","body":"...","idempotencyKey":"..."}.
- For a pass verdict, first use kind "review" with event "APPROVE" for whole-PR approval feedback; include inline comments when helpful.
- For a fail verdict, use kind "review" with event "REQUEST_CHANGES" when submitting whole-PR review feedback; include inline comments when helpful.
- Use kind "review_comment" for a single inline comment or reply, and "issue_comment" only for supplemental high-level PR comments. These supplemental comments do not satisfy pass approval.
- Use a stable idempotencyKey; reuse returned URLs as verdict evidence on retry.

Report a verdict in this format:
VERDICT: pass | fail | blocked
SUMMARY:
EVIDENCE:
REQUESTED REVISIONS:

Original issue:
{{ issue.identifier }} - {{ issue.title }}
State: {{ issue.state }}
URL: {{ issue.url }}

Description:
{{ issue.description }}

Acceptance criteria:
{% for item in acceptanceCriteria %}- {{ item }}
{% else %}- No acceptance criteria were supplied.
{% endfor %}

Worker completion report:
Report: {{ completionReport.id }}
Worker run: {{ completionReport.runId }}
Summary: {{ completionReport.summary }}
Changed files:
{% for file in completionReport.changedFiles %}- {{ file }}
{% else %}- No changed files supplied.
{% endfor %}
Risks:
{% for risk in completionReport.risks %}- {{ risk }}
{% else %}- No known risks supplied.
{% endfor %}

Validation evidence:
{% for item in validationEvidence %}- {{ item }}
{% else %}- No validation evidence supplied.
{% endfor %}

Git and workspace evidence:
{% for item in workspaceEvidence %}- {{ item }}
{% else %}- No workspace evidence supplied.
{% endfor %}

Relevant worker run digest:
{% for item in runDigest %}- {{ item }}
{% else %}- No run digest is available.
{% endfor %}
`;

interface TickIssueCandidateLane {
  id: string;
  branch: TrackerIssueCandidateFilterBranch;
  requiresAgentSlot: boolean;
}

interface StartupTerminalCleanupTarget {
  issue: Issue;
  workspace: IssueWorkspaceRecord;
}

interface StartupTerminalCleanupResult {
  workspaceRemoved: boolean;
  workspaceFailed: boolean;
  transcriptsDeleted: number;
  transcriptBytesRemoved: number;
  transcriptFailed: boolean;
}

export class Orchestrator {
  private config: ServiceConfig;
  private promptTemplate: string;
  private readonly promptRenderer = new PromptRenderer();
  private pollTimer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;
  private endedRuntimeSeconds = 0;
  private readonly running = new Map<string, RunningEntry>();
  private readonly activeWorkers = new Set<Promise<void>>();
  private readonly activeRetryWorkers = new Set<Promise<void>>();
  private readonly claimed = new Set<string>();
  private readonly completed = new Set<string>();
  private readonly pausedIssues = new Set<string>();
  private readonly retryAttempts = new Map<string, RetryEntry>();
  private readonly operatorChatQueues = new Map<string, Promise<void>>();
  private readonly operatorChatRuns = new Map<string, OperatorChatQueueEntry>();
  private readonly totals: TokenCounts = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  private readonly providerGateStore: ProviderGateStore;
  private readonly issueStateStore: IssueStateStore;
  private readonly mergeQueueStore: MergeQueueStore;
  private readonly issueCurrentStateBuilder: IssueCurrentStateBuilder;
  private readonly transitionRulesets: TransitionRuleset[];
  private readonly transitionEngine: IssueOrchestrationEngine;
  private readonly transitions: Map<
    IssueTransitionKind,
    IssueTransition<OrchestratorTransitionContext>
  >;
  private activeProviderGates: RuntimeProviderGate[] = [];
  private rateLimits: unknown = null;

  constructor(private readonly options: OrchestratorOptions) {
    this.config = options.config;
    this.promptTemplate = options.promptTemplate;
    this.providerGateStore =
      options.providerGateStore ??
      new FileProviderGateStore(options.config.workspace.stateDir);
    this.issueStateStore =
      options.issueStateStore ??
      new SqliteIssueStateStore(options.config.workspace.stateDir);
    this.mergeQueueStore =
      options.mergeQueueStore ??
      new SqliteMergeQueueStore(options.config.workspace.stateDir);
    this.issueCurrentStateBuilder = new IssueCurrentStateBuilder({
      config: this.config,
      lifecycleStore: options.lifecycleStore,
      runStore: options.runStore,
      issueStateStore: this.issueStateStore,
      logger: options.logger,
    });
    this.transitionRulesets = this.createTransitionRulesets();
    this.transitionEngine = new IssueOrchestrationEngine(
      this.transitionRulesets,
    );
    this.transitions = new Map(
      this.createTransitions().map((transition) => [
        transition.kind,
        transition,
      ]),
    );
  }

  registeredTransitionRulesets(): readonly TransitionRuleset[] {
    return this.transitionEngine.registeredRulesets();
  }

  async inspectIssueHistory(
    issueIdOrIdentifier: string,
  ): Promise<IssueHistoryInspectionResult> {
    const record = await this.issueStateStore.get(issueIdOrIdentifier);
    if (record === null) {
      return {
        found: false,
        issueIdOrIdentifier,
        record: null,
        replay: [],
        replayMatched: false,
      };
    }
    const replay = this.transitionEngine.replay(record.history);
    return {
      found: true,
      issueIdOrIdentifier,
      record,
      replay,
      replayMatched: replay.every((entry) => entry.matched),
    };
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.refreshProviderGates();
    await this.options.writeback?.processDue();
    await this.startupCleanup();
    await this.cleanupOrphanedRunningRuns();
    await this.restoreRuntimeControlFromIssueHistory();
    this.scheduleTick(0);
  }

  async stop(options: OrchestratorStopOptions = {}): Promise<void> {
    const progress = options.progress;
    this.stopped = true;
    if (this.pollTimer) {
      const timer = this.pollTimer;
      await runShutdownAction({
        logger: this.options.logger,
        progress,
        action: {
          id: "orchestrator.poll_timer.clear",
          label: "clearing orchestrator poll timer",
          component: "orchestrator",
        },
        run: () => {
          clearTimeout(timer);
          this.pollTimer = null;
        },
      });
    }
    const retries = [...this.retryAttempts.values()];
    for (const [index, retry] of retries.entries()) {
      await runShutdownAction({
        logger: this.options.logger,
        progress,
        action: {
          id: `orchestrator.retry_timer.clear.${retry.issueId}.${retry.attempt}.${index}`,
          label: `clearing retry timer ${index + 1}/${retries.length} for ${retry.identifier}`,
          component: "orchestrator",
          fields: {
            index: index + 1,
            total: retries.length,
            issue_id: retry.issueId,
            issue_identifier: retry.identifier,
            attempt: retry.attempt,
            run_phase: retry.runPhase,
            delay_ms: retry.delayMs,
          },
        },
        run: () => clearTimeout(retry.timer),
      });
    }
    const operatorChats = [...this.operatorChatRuns.values()];
    for (const [index, entry] of operatorChats.entries()) {
      await runShutdownAction({
        logger: this.options.logger,
        progress,
        action: {
          id: `orchestrator.operator_chat.abort.${entry.conversationId}.${entry.messageId}.${index}`,
          label: `aborting operator chat ${index + 1}/${operatorChats.length} for ${entry.conversationId}`,
          component: "orchestrator",
          fields: {
            index: index + 1,
            total: operatorChats.length,
            conversation_id: entry.conversationId,
            message_id: entry.messageId,
            run_id: entry.runId,
            session_id: entry.sessionId,
          },
        },
        run: () => entry.abortController.abort(),
      });
      const stopRunId = entry.runId;
      if (stopRunId) {
        await runShutdownAction({
          logger: this.options.logger,
          progress,
          action: {
            id: `orchestrator.operator_chat.harness_stop.${stopRunId}`,
            label: `requesting harness stop for operator chat ${index + 1}/${operatorChats.length} (${stopRunId})`,
            component: "orchestrator",
            fields: {
              index: index + 1,
              total: operatorChats.length,
              conversation_id: entry.conversationId,
              message_id: entry.messageId,
              run_id: stopRunId,
              session_id: entry.sessionId,
            },
          },
          run: async () => {
            await this.options.harness.stop?.(stopRunId).catch((error: unknown) => {
              this.options.logger.warn("operator chat harness stop failed", {
                run_id: stopRunId,
                conversation_id: entry.conversationId,
                error: errorMessage(error),
              });
            });
          },
        });
      }
    }
    const runningEntries = [...this.running.entries()];
    for (const [index, [issueId, running]] of runningEntries.entries()) {
      running.suppressRetryOnExit = true;
      const stopRunId = this.harnessStopRunId(running);
      await runShutdownAction({
        logger: this.options.logger,
        progress,
        action: {
          id: `orchestrator.run.abort.${issueId}.${index}`,
          label: `aborting run ${index + 1}/${runningEntries.length} for ${running.issue.identifier}`,
          component: "orchestrator",
          fields: {
            index: index + 1,
            total: runningEntries.length,
            issue_id: issueId,
            issue_identifier: running.issue.identifier,
            run_id: running.runId,
            active_run_id: running.activeRunId,
            session_id: running.sessionId,
            role: running.role,
            run_phase: running.runPhase,
          },
        },
        run: () => {
          this.markCancellationRequested(running, {
            source: "service_stop",
            reason: "orchestrator stop",
            abortSignalled: true,
            harnessStopRequested: stopRunId !== null,
          });
          running.abortController.abort();
        },
      });
      if (stopRunId !== null) {
        await runShutdownAction({
          logger: this.options.logger,
          progress,
          action: {
            id: `orchestrator.run.harness_stop.${issueId}.${stopRunId}`,
            label: `requesting harness stop for run ${index + 1}/${runningEntries.length} (${running.issue.identifier})`,
            component: "orchestrator",
            fields: {
              index: index + 1,
              total: runningEntries.length,
              issue_id: issueId,
              issue_identifier: running.issue.identifier,
              run_id: running.runId,
              active_run_id: running.activeRunId,
              stop_run_id: stopRunId,
              session_id: running.sessionId,
              role: running.role,
              run_phase: running.runPhase,
            },
          },
          run: () => this.requestHarnessStop(running, stopRunId),
        });
      }
    }
    const workers = new Set([
      ...this.activeWorkers,
      ...this.activeRetryWorkers,
      ...[...this.running.values()].map((entry) => entry.worker),
      ...[...this.operatorChatRuns.values()].map((entry) => entry.worker),
      ...this.operatorChatQueues.values(),
    ]);
    await runShutdownAction({
      logger: this.options.logger,
      progress,
      action: {
        id: "orchestrator.workers.wait",
        label: `waiting for ${workers.size} orchestrator worker(s) to settle`,
        component: "orchestrator",
        fields: {
          total: workers.size,
          active_workers: this.activeWorkers.size,
          active_retry_workers: this.activeRetryWorkers.size,
          running_entries: this.running.size,
          operator_chat_runs: this.operatorChatRuns.size,
          operator_chat_queues: this.operatorChatQueues.size,
        },
      },
      run: () => Promise.allSettled([...workers]),
    });
    await runShutdownAction({
      logger: this.options.logger,
      progress,
      action: {
        id: "orchestrator.issue_state_store.close",
        label: "closing issue state store",
        component: "orchestrator",
      },
      run: () => this.issueStateStore.close?.(),
    });
    await runShutdownAction({
      logger: this.options.logger,
      progress,
      action: {
        id: "orchestrator.merge_queue_store.close",
        label: "closing merge queue store",
        component: "orchestrator",
      },
      run: () => this.mergeQueueStore.close?.(),
    });
  }

  updateConfig(config: ServiceConfig, promptTemplate: string): void {
    this.config = config;
    this.promptTemplate = promptTemplate;
  }

  async refreshNow(): Promise<void> {
    await this.tick();
  }

  async dispatchOrchestratorChatCommand(
    command: OrchestratorChatCommand,
  ): Promise<OrchestratorChatCommandResult> {
    if (this.stopped) {
      return { status: "disabled", reason: "orchestrator_stopped" };
    }
    if (!this.options.orchestratorConversationStore) {
      return {
        status: "unavailable",
        reason: "orchestrator_conversation_store_unavailable",
      };
    }
    if (typeof this.options.harness.runOperatorChat !== "function") {
      return {
        status: "unavailable",
        reason: `harness_${this.options.harness.id}_does_not_support_operator_chat`,
      };
    }
    this.options.logger.info("orchestrator chat command accepted", {
      action: command.action,
      conversation_id: command.conversationId,
      message_id: command.messageId,
      source: command.source,
    });
    const acceptedAt = new Date().toISOString();
    const previous = this.operatorChatQueues.get(command.conversationId);
    const queued = Boolean(previous);
    const abortController = new AbortController();
    const worker = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.runOperatorChatCommand(command, abortController));
    const entry: OperatorChatQueueEntry = {
      conversationId: command.conversationId,
      messageId: command.messageId,
      command,
      abortController,
      worker,
      runId: null,
      sessionId: null,
      startedAt: new Date(acceptedAt),
      tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
    this.operatorChatRuns.set(command.messageId, entry);
    this.operatorChatQueues.set(command.conversationId, worker);
    void worker.finally(() => {
      this.operatorChatRuns.delete(command.messageId);
      if (this.operatorChatQueues.get(command.conversationId) === worker) {
        this.operatorChatQueues.delete(command.conversationId);
      }
    });
    return {
      status: "accepted",
      reason: queued ? "queued" : "accepted",
      acceptedAt,
      metadata: {
        conversationId: command.conversationId,
        messageId: command.messageId,
        queued,
        role: "planner",
        runKind: "planning",
        harnessId: this.options.harness.id,
        model: runtimeModelForHarness(this.options.harness.id, this.config),
      },
    };
  }

  private async runOperatorChatCommand(
    command: OrchestratorChatCommand,
    abortController: AbortController,
  ): Promise<void> {
    const store = this.options.orchestratorConversationStore;
    const runOperatorChat = this.options.harness.runOperatorChat?.bind(
      this.options.harness,
    );
    if (!store || !runOperatorChat) return;

    const queueEntry = this.operatorChatRuns.get(command.messageId) ?? null;
    const workspace = await this.operatorChatWorkspace();
    const messages = await store.listMessages(command.conversationId);
    const turnNumber = Math.max(
      1,
      messages.filter((message) => message.role === "user").length,
    );
    const context: OperatorChatRunContext = {
      conversationId: command.conversationId,
      messageId: command.messageId,
      workspace,
      config: this.config,
      turnNumber,
      abortSignal: abortController.signal,
      logger: this.options.logger,
      statusServer: this.operatorChatStatusServer() ?? null,
    };
    const prompt = await this.renderOperatorChatPrompt(command, messages);
    let assistant: OrchestratorConversationMessage | null = null;
    let assistantText = "";
    let runId: string | null = null;
    let sessionId: string | null = null;
    let tokens: TokenCounts = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    let terminalStatus: "succeeded" | "failed" | "cancelled" = "succeeded";
    let terminalError: string | null = null;

    try {
      await store.updateMessage({
        conversationId: command.conversationId,
        messageId: command.messageId,
        status: "completed",
        metadata: {
          dispatch: {
            status: "running",
            role: "planner",
            harnessId: this.options.harness.id,
            startedAt: new Date().toISOString(),
          },
        },
      });
    } catch (error) {
      this.options.logger.warn(
        "operator chat user message status update failed",
        {
          conversation_id: command.conversationId,
          message_id: command.messageId,
          error: errorMessage(error),
        },
      );
    }

    try {
      for await (const event of runOperatorChat(context, prompt)) {
        if (event.type === "session_started") {
          runId = event.runId ?? event.sessionId;
          sessionId = event.sessionId;
          if (queueEntry) {
            queueEntry.runId = runId;
            queueEntry.sessionId = sessionId;
          }
          const runtimeAllowLargeContext = runtimeAllowLargeContextForHarness(
            this.options.harness.id,
            this.config,
          );
          await this.options.runStore?.startRun({
            runId,
            sessionId,
            agentId: event.threadId ?? null,
            role: "planner",
            runPhase: "issue_breakdown",
            runKind: "planning",
            issueId: operatorChatIssueId(command.conversationId),
            issueIdentifier: "OPERATOR",
            attempt: null,
            turnNumber,
            prompt,
            harnessId: this.options.harness.id,
            runtimeModel:
              event.model ??
              runtimeModelForHarness(this.options.harness.id, this.config),
            runtimeModelParams: runtimeModelParamsForHarness(
              this.options.harness.id,
              this.config,
            ),
            runtimeSettingSources: runtimeSettingSourcesForHarness(
              this.options.harness.id,
              this.config,
            ),
            runtimeMode: runtimeModeForHarness(
              this.options.harness.id,
              this.config,
            ),
            ...(runtimeAllowLargeContext === undefined
              ? {}
              : { runtimeAllowLargeContext }),
            runtimeAgentLifecycle: "reuse_by_conversation",
            cursorModel: this.config.cursor.model,
            cursorModelParams: this.config.cursor.modelParams,
            cursorSettingSources: this.config.cursor.settingSources,
            cursorMode: this.config.cursor.mode,
            cursorAllowLargeContext: this.config.cursor.allowLargeContext,
            cursorWorkerAgentLifecycle: this.config.cursor.workerAgentLifecycle,
            workspaceKey: workspace.workspaceKey,
            workspacePath: workspace.path,
            ...(workspace.gitBranchName === undefined
              ? {}
              : { gitBranchName: workspace.gitBranchName }),
            ...(workspace.repoPath === undefined
              ? {}
              : { repoPath: workspace.repoPath }),
            ...(workspace.baseRef === undefined
              ? {}
              : { baseRef: workspace.baseRef }),
          });
          assistant = await store.appendMessage({
            conversationId: command.conversationId,
            role: "assistant",
            body: "Starting operator session...",
            status: "streaming",
            metadata: operatorAssistantMetadata({
              command,
              event,
              harnessId: this.options.harness.id,
              model:
                event.model ??
                runtimeModelForHarness(this.options.harness.id, this.config),
            }),
            transcriptLinks: [{ runId, eventType: "session_started" }],
          });
          await this.persistOperatorHarnessEvent(runId, event);
          continue;
        }

        if (event.type === "tokens") {
          tokens = mergeTokenCounts(tokens, event.tokens);
          if (queueEntry) queueEntry.tokens = tokens;
        }
        if (runId) await this.persistOperatorHarnessEvent(runId, event);

        if (event.type === "progress") {
          if (event.activitySource === "tool") {
            await store.appendMessage({
              conversationId: command.conversationId,
              role: "server",
              body: event.message,
              status: "completed",
              metadata: {
                source: "operator_chat_tool",
                runId,
                sessionId,
                harnessId: this.options.harness.id,
              },
              transcriptLinks: runId ? [{ runId, eventType: "tool" }] : [],
            });
            continue;
          }
          assistantText = mergeOperatorAssistantText(
            assistantText,
            event.message,
            event.activitySource,
          );
          assistant = await this.upsertOperatorAssistantMessage(
            store,
            command,
            assistant,
            assistantText,
            "streaming",
            {
              runId,
              sessionId,
              eventType: "progress",
            },
          );
          continue;
        }

        if (event.type === "provider_limit") {
          terminalStatus = "failed";
          terminalError = event.signal.message;
          assistantText = mergeOperatorAssistantText(
            assistantText,
            event.signal.message,
            "stream",
          );
          continue;
        }

        if (event.type === "completed") {
          terminalStatus = "succeeded";
          if (event.message && event.message.trim().length > 0) {
            assistantText = mergeOperatorAssistantText(
              assistantText,
              event.message,
              "stream",
            );
          }
          continue;
        }

        if (event.type === "failed") {
          terminalStatus = "failed";
          terminalError = event.error;
          assistantText =
            assistantText.trim().length > 0 ? assistantText : event.error;
          continue;
        }

        if (event.type === "cancelled") {
          terminalStatus = "cancelled";
          terminalError = "Operator chat run was cancelled";
          assistantText =
            assistantText.trim().length > 0 ? assistantText : terminalError;
        }
      }
    } catch (error) {
      terminalStatus = abortController.signal.aborted ? "cancelled" : "failed";
      terminalError = errorMessage(error);
      assistantText =
        assistantText.trim().length > 0
          ? assistantText
          : `Operator chat failed: ${terminalError}`;
      if (runId) {
        await this.options.runStore?.appendEvent({
          runId,
          at: new Date().toISOString(),
          source: "orchestrator",
          eventType: "operator_chat_error",
          message: terminalError,
          payload: {
            conversationId: command.conversationId,
            messageId: command.messageId,
          },
        });
      }
    } finally {
      const completedAt = new Date().toISOString();
      const finalStatus =
        terminalStatus === "succeeded" ? "completed" : "failed";
      assistant = await this.upsertOperatorAssistantMessage(
        store,
        command,
        assistant,
        assistantText.trim().length > 0
          ? assistantText
          : "Operator run completed.",
        finalStatus,
        {
          runId,
          sessionId,
          eventType: terminalStatus,
          completedAt,
          error: terminalError,
        },
      );
      if (runId) {
        await this.options.runStore?.updateRun(runId, {
          status: terminalStatus,
          completedAt,
          error: terminalError,
          tokens,
          metadata: {
            activitySnapshot: {
              lastHarnessActivityAt: completedAt,
              lastStreamActivityAt: completedAt,
              lastDeltaOrToolActivityAt: completedAt,
              lastToolActivityAt: null,
            },
          },
        });
      }
    }
  }

  private async upsertOperatorAssistantMessage(
    store: OrchestratorConversationStore,
    command: OrchestratorChatCommand,
    existing: OrchestratorConversationMessage | null,
    body: string,
    status: "streaming" | "completed" | "failed",
    metadata: Record<string, unknown>,
  ): Promise<OrchestratorConversationMessage> {
    if (existing) {
      return store.updateMessage({
        conversationId: command.conversationId,
        messageId: existing.id,
        body,
        status,
        metadata: { operatorRun: metadata },
        ...(typeof metadata.runId === "string" && metadata.runId.length > 0
          ? {
              transcriptLinks: [
                {
                  runId: metadata.runId,
                  eventType:
                    typeof metadata.eventType === "string"
                      ? metadata.eventType
                      : null,
                },
              ],
            }
          : {}),
      });
    }
    return store.appendMessage({
      conversationId: command.conversationId,
      role: "assistant",
      body,
      status,
      metadata: {
        source: "operator_chat",
        commandMessageId: command.messageId,
        operatorRun: metadata,
      },
      transcriptLinks:
        typeof metadata.runId === "string" && metadata.runId.length > 0
          ? [
              {
                runId: metadata.runId,
                eventType:
                  typeof metadata.eventType === "string"
                    ? metadata.eventType
                    : null,
              },
            ]
          : [],
    });
  }

  private async persistOperatorHarnessEvent(
    runId: string,
    event: AgentEvent,
  ): Promise<void> {
    await this.options.runStore?.appendEvent({
      runId: event.type === "run_status" ? event.runId : runId,
      at: new Date(event.at ?? Date.now()).toISOString(),
      source: "harness",
      ...mapAgentEventToRunActivityEvent(event),
    });
  }

  private async operatorChatWorkspace(): Promise<Workspace> {
    const configuredPath = this.config.workspace.source.path;
    const workspacePath =
      configuredPath && (await existingDirectory(configuredPath))
        ? configuredPath
        : this.config.workflowDir;
    await fs.mkdir(workspacePath, { recursive: true });
    return {
      path: workspacePath,
      workspaceKey: "operator-chat",
      createdNow: false,
      issueId: "operator-chat",
      issueIdentifier: "OPERATOR",
      sourceKind: "operator_chat",
      ...(configuredPath === undefined || workspacePath !== configuredPath
        ? {}
        : { repoPath: configuredPath }),
      ...(this.config.workspace.source.baseRef === undefined
        ? {}
        : { baseRef: this.config.workspace.source.baseRef }),
    };
  }

  private operatorChatStatusServer(): OperatorChatRunContext["statusServer"] {
    const baseUrl = this.options.statusServerBaseUrl?.() ?? null;
    return baseUrl
      ? { baseUrl, mutationToken: this.options.statusMutationToken ?? null }
      : null;
  }

  private async renderOperatorChatPrompt(
    command: OrchestratorChatCommand,
    messages: readonly OrchestratorConversationMessage[],
  ): Promise<string> {
    const recentMessages = messages.slice(-20).map((message) => {
      const speaker =
        message.role === "user"
          ? "User"
          : message.role === "assistant"
            ? "Assistant"
            : "System";
      return `${speaker}: ${message.body}`;
    });
    return [
      "You are the persistent Symphony dashboard operator agent.",
      "",
      "You can inspect and operate Symphony through the provided service-owned MCP tools. Use those tools instead of asking for raw credentials or direct access.",
      "When you take an action, be explicit about what you did and cite the tool result. Preserve useful formatting in your response.",
      "",
      "Current user message:",
      command.input,
      "",
      "Recent conversation:",
      recentMessages.length > 0
        ? recentMessages.join("\n\n")
        : "No prior messages.",
      renderOperatorChatMcpPrompt({
        conversationId: command.conversationId,
        statusBaseUrl: this.options.statusServerBaseUrl?.() ?? null,
      }),
    ].join("\n");
  }

  async pauseIssue(issueId: string): Promise<void> {
    this.pausedIssues.add(issueId);
    await this.recordRuntimeControlEvidenceForIssueId(issueId, "pause_requested", {
      paused: true,
    });
    await this.clearIssueRetryById(issueId, "pause_cleared_retry");
  }

  async resumeIssue(issueId: string): Promise<void> {
    this.pausedIssues.delete(issueId);
    await this.recordRuntimeControlEvidenceForIssueId(issueId, "pause_cleared", {
      paused: false,
    });
    this.scheduleTick(0);
  }

  async clearProviderGate(gateId: string): Promise<RuntimeProviderGate | null> {
    const cleared = await this.providerGateStore.clear(gateId);
    await this.refreshProviderGates();
    this.scheduleTick(0);
    return cleared;
  }

  async cancelIssue(issueId: string): Promise<void> {
    await this.clearIssueRetryById(issueId, "cancel_cleared_retry");
    await this.releaseIssueClaimById(issueId, "cancel_released_claim");
    const running = this.running.get(issueId);
    if (!running) return;
    running.suppressRetryOnExit = true;
    const stopRunId = this.harnessStopRunId(running);
    this.markCancellationRequested(running, {
      source: "operator",
      reason: "operator request",
      abortSignalled: true,
      harnessStopRequested: stopRunId !== null,
    });
    await this.recordRuntimeControlEvidenceSnapshot({
      issue: running.issue,
      eventType: "cancellation_requested",
      sourceId: stopRunId ?? running.activeRunId ?? running.runId ?? issueId,
      reason: "operator_cancel_requested",
      entry: running,
    });
    running.abortController.abort();
    if (stopRunId !== null) await this.requestHarnessStop(running, stopRunId);
  }

  async requestIssueBreakdown(
    issueIdOrIdentifier: string,
  ): Promise<{ queued: boolean; issue: Issue; reason: string }> {
    const gate = await this.activeProviderDispatchGate();
    if (gate) {
      throw new SymphonyError(
        "conflict",
        providerGateDispatchBlockedMessage(gate),
      );
    }
    if (!this.config.issueBreakdown.enabled) {
      throw new SymphonyError(
        "invalid_request",
        "Issue breakdown planning is disabled",
      );
    }
    if (!this.options.lifecycleStore) {
      throw new SymphonyError(
        "invalid_request",
        "Issue breakdown planning requires a lifecycle store",
      );
    }
    if (this.availableSlots() <= 0) {
      throw new SymphonyError(
        "conflict",
        "No agent slots are available for issue breakdown planning",
      );
    }
    const refreshed = await this.options.tracker.fetchIssueStatesByIds([
      issueIdOrIdentifier,
    ]);
    const issue = refreshed[0];
    if (!issue)
      throw new SymphonyError(
        "not_found",
        `Issue not found: ${issueIdOrIdentifier}`,
      );
    if (this.running.has(issue.id))
      throw new SymphonyError(
        "conflict",
        "Issue already has a running Symphony agent",
      );
    if (this.isMergeConflictState(issue.state)) {
      throw new SymphonyError(
        "conflict",
        "Merge conflict states are only eligible for conflict-fix workers",
      );
    }
    if (!this.shouldDispatchPlanner(issue, false)) {
      throw new SymphonyError(
        "conflict",
        "Issue is not currently eligible for planner dispatch",
      );
    }
    const lifecycleGate = await this.lifecycleDispatchInspection(
      issue,
      "planner",
      "issue_breakdown",
    );
    if (lifecycleGate.blocked) {
      throw new SymphonyError(
        "conflict",
        "Issue lifecycle does not currently allow issue breakdown planning",
      );
    }
    const lifecycle = await this.options.lifecycleStore.get(issue.id);
    if (latestFreshIssueBreakdownPlan(lifecycle, issue, this.config) !== null) {
      return { queued: false, issue, reason: "fresh_plan_exists" };
    }
    await this.recordTrackerObservationSnapshot({
      issue,
      triggerType: "manual.cli_agent_run",
      triggerSource: "manual_cli",
      candidateSource: "request_issue_breakdown",
    });
    let transition = await this.decideIssueTransition({
      issue,
      triggerType: "manual.cli_agent_run",
      triggerSource: "manual_cli",
      candidateSource: "request_issue_breakdown",
      manualStage: "planner",
      manualForceLabels: false,
      manualIgnoreState: false,
    });
    if (transition !== null && isManualPreDispatchResetTransition(transition)) {
      await this.executeIssueTransition(issue, transition, {
        attempt: null,
        allowExistingClaim: false,
      });
      transition = await this.decideIssueTransition({
        issue,
        triggerType: "manual.cli_agent_run",
        triggerSource: "manual_cli",
        candidateSource: "request_issue_breakdown",
        manualStage: "planner",
        manualForceLabels: false,
        manualIgnoreState: false,
      });
    }
    if (transition?.transitionKind !== "dispatch_planner") {
      return { queued: false, issue, reason: "transition_ruleset_not_matched" };
    }
    const acted = await this.executeIssueTransition(issue, transition, {
      attempt: null,
      allowExistingClaim: false,
    });
    return {
      queued: acted,
      issue,
      reason: acted ? "explicit_request" : "transition_execution_failed",
    };
  }

  async applyIssueBreakdownPlan(
    issueIdOrIdentifier: string,
    options: { dryRun?: boolean } = {},
  ) {
    if (
      !this.config.issueBreakdown.enabled ||
      !this.config.issueBreakdown.applyToLinear.enabled
    ) {
      throw new SymphonyError(
        "invalid_request",
        "Issue breakdown Linear application is disabled",
      );
    }
    if (!this.options.lifecycleStore) {
      throw new SymphonyError(
        "invalid_request",
        "Issue breakdown Linear application requires a lifecycle store",
      );
    }
    const refreshed = await this.options.tracker.fetchIssueStatesByIds([
      issueIdOrIdentifier,
    ]);
    const issue = refreshed[0];
    if (!issue)
      throw new SymphonyError(
        "not_found",
        `Issue not found: ${issueIdOrIdentifier}`,
      );
    const service = new IssueBreakdownPlanApplyService({
      config: this.config,
      lifecycleStore: this.options.lifecycleStore,
      writeback: this.options.writeback,
    });
    return options.dryRun === true
      ? service.previewLatestFreshPlan(issue)
      : service.applyLatestFreshPlan(issue);
  }

  async renderPromptPreview(
    issueIdOrIdentifier: string,
    options: PromptPreviewOptions = {},
  ): Promise<PromptPreviewResult> {
    const refreshed = await this.options.tracker.fetchIssueStatesByIds([
      issueIdOrIdentifier,
    ]);
    const found = refreshed[0];
    if (!found)
      throw new SymphonyError(
        "not_found",
        `Issue not found: ${issueIdOrIdentifier}`,
      );
    const issue: Issue =
      options.state === undefined ? found : { ...found, state: options.state };
    await this.reconcileLifecycleBeforeIssueWork(issue);
    const lifecycle =
      (await this.options.lifecycleStore?.get(issue.id)) ?? null;
    const selection = await this.selectPromptPreviewRun(
      issue,
      lifecycle,
      options,
    );
    const metadataBase: Omit<PromptPreviewMetadata, "dispatchDecision"> = {
      simulatedState: options.state ?? null,
      selectedRole: selection.role,
      selectedPhase: selection.runPhase,
      selectedRunKind:
        selection.runPhase === null
          ? null
          : runKindForPhase(selection.runPhase),
      warnings:
        options.state === undefined
          ? []
          : [
              `rendered with simulated state ${options.state}; tracker state is ${found.state}`,
            ],
    };
    if (selection.status === "no_prompt") {
      return {
        status: "no_prompt",
        issue,
        reason: selection.reason,
        metadata: { ...metadataBase, dispatchDecision: "no_prompt" },
      };
    }
    const workspace = this.previewWorkspaceFor(issue, selection.runPhase);
    const entry = this.promptPreviewEntry(
      issue,
      lifecycle,
      selection.role,
      selection.runPhase,
      workspace,
    );
    const promptBundle = await this.renderPromptBundleForPreview(
      entry,
      workspace,
    );
    return {
      status: "rendered",
      issue,
      role: selection.role,
      runPhase: selection.runPhase,
      runKind: runKindForPhase(selection.runPhase),
      promptBundle,
      prompt: promptBundle.userPrompt,
      userPrompt: promptBundle.userPrompt,
      ephemeralSystemPrompt: promptBundle.ephemeralSystemPrompt,
      metadata: {
        ...metadataBase,
        promptBundle: promptBundle.metadata,
        dispatchDecision: options.force ? "forced" : "would_dispatch",
      },
    };
  }

  async runManualAgent(
    issueIdOrIdentifier: string,
    options: ManualAgentRunOptions,
  ): Promise<ManualAgentRunResult> {
    const target = manualAgentRunTarget(options.stage);
    const issue = await this.fetchSingleIssue(issueIdOrIdentifier);
    if (!issue)
      return manualAgentNotDispatched(null, target, "issue_not_found");
    if (options.ignoreState === true && options.forceLabels !== true) {
      return manualAgentNotDispatched(
        issue,
        target,
        "ignore_state_requires_force",
      );
    }

    const gateOptions: DispatchGateOptions = {
      ignoreExcludeLabels: options.forceLabels === true,
      ignoreState: options.ignoreState === true,
    };
    let dispatchIssue = issue;
    let reviewEvidence: ReviewerDispatchEvidence | null = null;

    const preflightReason = await this.manualDispatchBlockReason(
      dispatchIssue,
      target,
      gateOptions,
    );
    if (preflightReason !== null)
      return manualAgentNotDispatched(dispatchIssue, target, preflightReason);

    if (target.role === "reviewer") {
      reviewEvidence = await this.loadReviewerDispatchEvidence(dispatchIssue);
      if (!reviewEvidence)
        return manualAgentNotDispatched(
          dispatchIssue,
          target,
          "review_evidence_unavailable",
        );
    }

    if (
      target.role === "worker" &&
      target.runPhase === "implementation" &&
      options.ignoreState !== true
    ) {
      const dispatchWriteback = planDispatchWriteback(
        dispatchIssue,
        this.config,
      );
      if (
        !(await this.applyWriteback(
          dispatchWriteback,
          "manual dispatch",
          dispatchIssue,
        ))
      ) {
        return manualAgentNotDispatched(
          dispatchIssue,
          target,
          "dispatch_writeback_failed",
        );
      }
      if (dispatchWriteback) {
        const refreshed = await this.fetchSingleIssue(dispatchIssue.id);
        if (!refreshed)
          return manualAgentNotDispatched(
            dispatchIssue,
            target,
            "issue_not_found_after_dispatch_writeback",
          );
        dispatchIssue = refreshed;
        const postWritebackReason = await this.manualDispatchBlockReason(
          dispatchIssue,
          target,
          gateOptions,
        );
        if (postWritebackReason !== null)
          return manualAgentNotDispatched(
            dispatchIssue,
            target,
            postWritebackReason,
          );
      }
    }

    const manualDispatch = {
      stage: options.stage,
      forceLabels: options.forceLabels === true,
      ignoreState: options.ignoreState === true,
    };
    await this.recordTrackerObservationSnapshot({
      issue: dispatchIssue,
      triggerType: "manual.cli_agent_run",
      triggerSource: "manual_cli",
      candidateSource: `manual.${options.stage}`,
    });
    let transition = await this.decideIssueTransition({
      issue: dispatchIssue,
      triggerType: "manual.cli_agent_run",
      triggerSource: "manual_cli",
      candidateSource: `manual.${options.stage}`,
      manualStage: options.stage,
      manualForceLabels: manualDispatch.forceLabels,
      manualIgnoreState: manualDispatch.ignoreState,
    });
    if (transition !== null && isManualPreDispatchResetTransition(transition)) {
      await this.executeIssueTransition(dispatchIssue, transition, {
        attempt: null,
        allowExistingClaim: false,
      });
      transition = await this.decideIssueTransition({
        issue: dispatchIssue,
        triggerType: "manual.cli_agent_run",
        triggerSource: "manual_cli",
        candidateSource: `manual.${options.stage}`,
        manualStage: options.stage,
        manualForceLabels: manualDispatch.forceLabels,
        manualIgnoreState: manualDispatch.ignoreState,
      });
    }
    if (
      transition === null ||
      !isDispatchTransitionForTarget(transition, target)
    ) {
      return manualAgentNotDispatched(
        dispatchIssue,
        target,
        "transition_ruleset_not_matched",
      );
    }
    await this.executeIssueTransition(dispatchIssue, transition, {
      attempt: null,
      allowExistingClaim: false,
    });
    const entry = this.running.get(dispatchIssue.id);
    if (!entry)
      return manualAgentNotDispatched(
        dispatchIssue,
        target,
        "transition_execution_failed",
      );
    await entry.worker;
    const runId = entry.activeRunId ?? entry.runId;
    const run =
      runId && this.options.runStore
        ? await this.options.runStore.getRun(runId)
        : null;
    const lifecycle =
      (await this.options.lifecycleStore?.get(dispatchIssue.id)) ??
      entry.lifecycle ??
      null;
    return {
      status: "completed",
      issue: dispatchIssue,
      role: target.role,
      runPhase: target.runPhase,
      runKind: runKindForPhase(target.runPhase),
      runId,
      sessionId: entry.sessionId,
      finalStatus: terminalManualRunStatus(run?.status),
      error: run?.error ?? null,
      lifecycle,
    };
  }

  async inspectManualAgentEligibility(
    issueIdOrIdentifier: string,
    options: ManualAgentEligibilityOptions,
  ): Promise<ManualAgentEligibilityResult> {
    const target = manualAgentRunTarget(options.stage);
    const issue = await this.fetchSingleIssue(issueIdOrIdentifier);
    if (!issue) {
      return manualAgentEligibility(null, target, "issue_not_found", null);
    }
    return this.inspectManualAgentEligibilityForIssue(issue, options);
  }

  async inspectManualAgentEligibilityForIssue(
    issue: Issue,
    options: ManualAgentEligibilityOptions,
  ): Promise<ManualAgentEligibilityResult> {
    const target = manualAgentRunTarget(options.stage);
    if (options.ignoreState === true && options.forceLabels !== true) {
      return manualAgentEligibility(
        issue,
        target,
        "ignore_state_requires_force",
        "--ignore-state requires --force",
      );
    }

    const gateOptions: DispatchGateOptions = {
      ignoreExcludeLabels: options.forceLabels === true,
      ignoreState: options.ignoreState === true,
    };
    const preflight = await this.manualDispatchInspectionBlockReason(
      issue,
      target,
      gateOptions,
    );
    if (preflight.reason !== null) {
      return manualAgentEligibility(
        issue,
        target,
        preflight.reason,
        preflight.explanation,
      );
    }
    if (target.role === "reviewer") {
      const reviewEvidence = await this.loadReviewerDispatchEvidence(issue);
      if (!reviewEvidence) {
        return manualAgentEligibility(
          issue,
          target,
          "review_evidence_unavailable",
          "No accepted completion report evidence is available for reviewer dispatch.",
        );
      }
    }
    return manualAgentEligibility(issue, target, null, preflight.explanation);
  }

  private async fetchSingleIssue(
    issueIdOrIdentifier: string,
  ): Promise<Issue | null> {
    const refreshed = await this.options.tracker.fetchIssueStatesByIds([
      issueIdOrIdentifier,
    ]);
    return refreshed[0] ?? null;
  }

  private async reconcileLifecycleBeforeIssueWork(issue: Issue): Promise<void> {
    if (!this.options.lifecycleStore) return;
    const result = await new LifecycleReconciliationService({
      lifecycleStore: this.options.lifecycleStore,
    }).applyIssue(issue.id);
    if (!result?.applied || result.actions.length === 0) return;
    this.options.logger.info("issue lifecycle reconciled before agent work", {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      action_count: result.actions.length,
      actions: result.actions.map((action) => ({
        kind: action.kind,
        record_id: action.recordId,
        superseded_by: action.supersededBy ?? null,
        reason: action.reason ?? null,
      })),
    });
  }

  private async manualDispatchBlockReason(
    issue: Issue,
    target: { role: AgentRunRole; runPhase: AgentRunPhase },
    options: DispatchGateOptions,
  ): Promise<string | null> {
    if (this.availableSlots() <= 0) return "no_agent_slots_available";
    if (await this.activeProviderDispatchGate())
      return "provider_dispatch_gate_active";
    const roleReason = this.manualRoleGateBlockReason(issue, target, options);
    if (roleReason !== null) return roleReason;
    const lifecycle = await this.lifecycleDispatchInspection(
      issue,
      target.role,
      target.runPhase,
      {
        ...options,
        manualDispatch:
          (target.role === "triage" && target.runPhase === "issue_triage") ||
          (target.role === "post_mortem" && target.runPhase === "post_mortem"),
      },
    );
    if (lifecycle.blocked) return "lifecycle_gate_blocked";
    return null;
  }

  private async manualDispatchInspectionBlockReason(
    issue: Issue,
    target: { role: AgentRunRole; runPhase: AgentRunPhase },
    options: DispatchGateOptions,
  ): Promise<{ reason: string | null; explanation: string | null }> {
    if (this.availableSlots() <= 0) {
      return {
        reason: "no_agent_slots_available",
        explanation: "No configured agent slot is currently available.",
      };
    }
    if (await this.activeProviderDispatchGate()) {
      return {
        reason: "provider_dispatch_gate_active",
        explanation: "A provider dispatch gate is active for this runtime.",
      };
    }
    const roleReason = this.manualRoleGateBlockReason(issue, target, options);
    if (roleReason !== null) return { reason: roleReason, explanation: null };
    const lifecycle = await this.lifecycleDispatchInspection(
      issue,
      target.role,
      target.runPhase,
      {
        ...options,
        manualDispatch:
          (target.role === "triage" && target.runPhase === "issue_triage") ||
          (target.role === "post_mortem" && target.runPhase === "post_mortem"),
      },
    );
    if (lifecycle.blocked) {
      return {
        reason: "lifecycle_gate_blocked",
        explanation: lifecycle.explanation,
      };
    }
    return { reason: null, explanation: lifecycle.explanation };
  }

  private manualRoleGateBlockReason(
    issue: Issue,
    target: { role: AgentRunRole; runPhase: AgentRunPhase },
    options: DispatchGateOptions,
  ): string | null {
    const ignoreState = options.ignoreState === true;
    if (this.running.has(issue.id)) return "issue_already_running";
    if (this.pausedIssues.has(issue.id)) return "issue_paused";
    if (
      target.role !== "post_mortem" &&
      isStateIn(issue.state, this.config.tracker.terminalStates)
    )
      return "issue_in_terminal_state";
    const labelReason = this.labelGuardrailBlockReason(
      issue,
      target.role,
      options,
    );
    if (labelReason !== null) return labelReason;

    if (target.role === "worker") {
      if (!issue.assignedToWorker) return "worker_not_assigned";
      if (target.runPhase === "merge_conflict_resolution") {
        if (!ignoreState && !this.isMergeConflictState(issue.state))
          return "issue_not_in_merge_conflict_state";
      } else {
        if (
          !ignoreState &&
          !isStateIn(issue.state, this.config.tracker.activeStates)
        )
          return "issue_not_in_worker_active_state";
        if (
          !ignoreState &&
          isStateIn(issue.state, this.config.tracker.handoffStates)
        )
          return "issue_in_handoff_state";
        if (
          !ignoreState &&
          isStateIn(issue.state, this.config.reviewLoop.reviewStates)
        )
          return "issue_in_review_state";
        if (
          !ignoreState &&
          isStateIn(issue.state, this.config.reviewLoop.blockedStates)
        )
          return "issue_in_blocked_state";
      }
      if (issue.hasChildren) return "issue_has_children";
      if (ignoreState) return null;
      if (
        issue.state.toLowerCase() === "todo" &&
        hasOpenBlocker(issue, this.config.tracker.terminalStates)
      )
        return "issue_has_open_blocker";
      if (!this.hasStateSlot(issue.state)) return "state_slot_unavailable";
      return null;
    }

    if (target.role === "reviewer") {
      if (
        !ignoreState &&
        !isStateIn(issue.state, this.config.reviewLoop.reviewStates)
      )
        return "issue_not_in_review_state";
      if (
        !ignoreState &&
        isStateIn(issue.state, this.config.reviewLoop.blockedStates)
      )
        return "issue_in_blocked_state";
      if (hasOpenBlocker(issue, this.config.tracker.terminalStates))
        return "issue_has_open_blocker";
      if (!this.hasStateSlot(issue.state)) return "state_slot_unavailable";
      return null;
    }

    if (target.role === "triage") {
      if (!this.config.issueTriage.enabled || !this.options.lifecycleStore)
        return "issue_triage_not_configured";
      if (
        !ignoreState &&
        !isStateIn(issue.state, this.config.reviewLoop.blockedStates)
      )
        return "issue_not_in_blocked_state";
      if (!this.hasStateSlot(issue.state)) return "state_slot_unavailable";
      return null;
    }

    if (target.role === "post_mortem") {
      if (!this.config.postMortem.enabled || !this.options.lifecycleStore)
        return "post_mortem_not_configured";
      if (
        !ignoreState &&
        !isStateIn(issue.state, this.config.postMortem.doneStates)
      )
        return "issue_not_in_post_mortem_done_state";
      if (!this.hasStateSlot(issue.state)) return "state_slot_unavailable";
      return null;
    }

    if (!this.config.issueBreakdown.enabled || !this.options.lifecycleStore)
      return "issue_breakdown_not_configured";
    if (!issue.assignedToWorker) return "planner_not_assigned";
    if (!ignoreState && this.isMergeConflictState(issue.state))
      return "issue_in_merge_conflict_state";
    if (
      !ignoreState &&
      !isStateIn(issue.state, this.config.tracker.activeStates) &&
      !isStateIn(issue.state, this.config.reviewLoop.blockedStates)
    ) {
      return "issue_not_in_planner_state";
    }
    if (issue.hasChildren) return "issue_has_children";
    if (
      issue.state.toLowerCase() === "todo" &&
      hasOpenBlocker(issue, this.config.tracker.terminalStates)
    )
      return "issue_has_open_blocker";
    if (!this.hasStateSlot(issue.state)) return "state_slot_unavailable";
    return null;
  }

  private labelGuardrailBlockReason(
    issue: Issue,
    role: AgentRunRole | "merge_policy",
    options: DispatchGateOptions,
  ): string | null {
    const labels = new Set(issue.labels.map((label) => label.toLowerCase()));
    const missingRequired = this.config.agent.requireLabels.find(
      (label) => !labels.has(label),
    );
    if (missingRequired) return `missing_required_label:${missingRequired}`;
    if (role === "post_mortem") {
      const missingPostMortemRequired =
        this.config.postMortem.requireLabels.find(
          (label) => !labels.has(label),
        );
      if (missingPostMortemRequired)
        return `post_mortem_missing_required_label:${missingPostMortemRequired}`;
    }
    if (options.ignoreExcludeLabels === true) return null;
    const globalExcluded = this.config.agent.excludeLabels.find((label) =>
      labels.has(label),
    );
    if (globalExcluded) return `excluded_label:${globalExcluded}`;
    if (role === "worker") {
      const excluded = this.config.agent.workerExcludeLabels.find((label) =>
        labels.has(label),
      );
      if (excluded) return `worker_excluded_label:${excluded}`;
    }
    if (role === "reviewer") {
      const excluded = this.config.agent.reviewerExcludeLabels.find((label) =>
        labels.has(label),
      );
      if (excluded) return `reviewer_excluded_label:${excluded}`;
    }
    if (role === "planner") {
      const excluded = this.config.agent.plannerExcludeLabels.find((label) =>
        labels.has(label),
      );
      if (excluded) return `planner_excluded_label:${excluded}`;
    }
    if (role === "post_mortem") {
      const excluded = this.config.postMortem.excludeLabels.find((label) =>
        labels.has(label),
      );
      if (excluded) return `post_mortem_excluded_label:${excluded}`;
    }
    return null;
  }

  private async selectPromptPreviewRun(
    issue: Issue,
    lifecycle: IssueLifecycleRecord | null,
    options: PromptPreviewOptions,
  ): Promise<
    | { status: "rendered"; role: AgentRunRole; runPhase: AgentRunPhase }
    | {
        status: "no_prompt";
        role: AgentRunRole | null;
        runPhase: AgentRunPhase | null;
        reason: string;
      }
  > {
    const forcedRole =
      options.role && options.role !== "auto" ? options.role : null;
    const forcedPhase =
      options.phase && options.phase !== "auto" ? options.phase : null;
    if (options.force && forcedRole) {
      return {
        status: "rendered",
        role: forcedRole,
        runPhase: forcedPhase ?? defaultRunPhaseForRole(forcedRole),
      };
    }

    if (
      forcedRole === "reviewer" ||
      (!forcedRole &&
        isStateIn(issue.state, this.config.reviewLoop.reviewStates))
    ) {
      return this.shouldDispatchReviewer(issue, true)
        ? { status: "rendered", role: "reviewer", runPhase: "review" }
        : {
            status: "no_prompt",
            role: "reviewer",
            runPhase: "review",
            reason: "reviewer_would_not_dispatch",
          };
    }
    if (
      forcedRole === "triage" ||
      (!forcedRole &&
        isStateIn(issue.state, this.config.reviewLoop.blockedStates))
    ) {
      const report = lifecycle
        ? latestIssueTriageReportForFingerprint(
            lifecycle,
            issueTriageTriggerFingerprint(lifecycle),
          )
        : null;
      if (
        !forcedRole &&
        reportHasActiveTriageBlocker(
          report,
          "under_specified_needs_decomposition",
        ) &&
        this.shouldDispatchPlanner(issue, true)
      ) {
        return {
          status: "rendered",
          role: "planner",
          runPhase: "issue_breakdown",
        };
      }
      return this.shouldDispatchIssueTriage(issue, true)
        ? { status: "rendered", role: "triage", runPhase: "issue_triage" }
        : {
            status: "no_prompt",
            role: "triage",
            runPhase: "issue_triage",
            reason: "triage_would_not_dispatch",
          };
    }
    if (forcedRole === "planner") {
      return this.shouldDispatchPlanner(issue, true)
        ? { status: "rendered", role: "planner", runPhase: "issue_breakdown" }
        : {
            status: "no_prompt",
            role: "planner",
            runPhase: "issue_breakdown",
            reason: "planner_would_not_dispatch",
          };
    }
    if (
      forcedRole === "post_mortem" ||
      (!forcedRole && isStateIn(issue.state, this.config.postMortem.doneStates))
    ) {
      return this.shouldDispatchPostMortem(issue, true)
        ? { status: "rendered", role: "post_mortem", runPhase: "post_mortem" }
        : {
            status: "no_prompt",
            role: "post_mortem",
            runPhase: "post_mortem",
            reason: "post_mortem_would_not_dispatch",
          };
    }
    if (
      forcedRole === "worker" ||
      isStateIn(issue.state, this.config.tracker.activeStates) ||
      this.isMergeConflictState(issue.state)
    ) {
      const runPhase =
        forcedPhase ??
        (this.isMergeConflictState(issue.state)
          ? "merge_conflict_resolution"
          : "implementation");
      if (!this.shouldDispatchWorker(issue, true, runPhase)) {
        return {
          status: "no_prompt",
          role: "worker",
          runPhase,
          reason: "worker_would_not_dispatch",
        };
      }
      const decision = forcedPhase
        ? { action: "dispatch" as const, runPhase }
        : await this.resolveWorkerDispatchDecision(issue);
      if (decision.action === "skip")
        return {
          status: "no_prompt",
          role: "worker",
          runPhase,
          reason: decision.reason,
        };
      if (decision.runPhase === "issue_breakdown") {
        return this.shouldDispatchPlanner(issue, true)
          ? { status: "rendered", role: "planner", runPhase: "issue_breakdown" }
          : {
              status: "no_prompt",
              role: "planner",
              runPhase: "issue_breakdown",
              reason: "planner_would_not_dispatch",
            };
      }
      return {
        status: "rendered",
        role: "worker",
        runPhase: decision.runPhase,
      };
    }
    return {
      status: "no_prompt",
      role: null,
      runPhase: null,
      reason: "state_has_no_agent_prompt",
    };
  }

  private promptPreviewEntry(
    issue: Issue,
    lifecycle: IssueLifecycleRecord | null,
    role: AgentRunRole,
    runPhase: AgentRunPhase,
    workspace: Workspace,
  ): RunningEntry {
    const abortController = new AbortController();
    return {
      issue,
      role,
      runPhase,
      workspacePath: workspace.path,
      workspace,
      sessionId: null,
      runId: null,
      activeRunId: null,
      issueHistorySnapshotId: null,
      lifecycle,
      worker: Promise.resolve(),
      abortController,
      startedAt: new Date(),
      lastEventAt: null,
      lastEvent: null,
      lastMessage: null,
      sdkRunStatus: null,
      sdkRunStatusUpdatedAt: null,
      sdkRunStatusSource: null,
      failureKind: null,
      failureDiagnosticCode: null,
      failureDiagnosticMessage: null,
      failureDiagnosticAt: null,
      failureDiagnosticPayload: undefined,
      turnCount: 0,
      retryAttempt: 0,
      tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      activeRunTokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      cleanupWorkspaceOnExit: false,
      suppressRetryOnExit: false,
      completionReportAccepted: false,
      mergeConflictResolutionAccepted: false,
      issueBreakdownPlanAccepted: false,
      issueTriageReportAccepted: false,
      issuePostMortemReportAccepted: false,
      pullRequestHandoffAccepted: false,
      reviewVerdictAccepted: false,
      reviewEvidence: null,
      manualDispatch: null,
      handoffRepair: null,
      hermesResume: null,
      cancellationRequestedAt: null,
      cancellationSource: null,
      cancellationReason: null,
      abortSignalledAt: null,
      harnessStopRequestedAt: null,
      harnessStopFailedAt: null,
      harnessStopFailedReason: null,
      lastStreamActivityAt: null,
      lastDeltaOrToolActivityAt: null,
      lastToolActivityAt: null,
      providerLimitSignal: null,
    };
  }

  private previewWorkspaceFor(
    issue: Issue,
    runPhase: AgentRunPhase,
  ): Workspace {
    const pathForIssue = this.options.workspaceManager.getPathForIssue(
      issue.identifier,
    );
    return {
      path:
        runPhase === "issue_breakdown"
          ? `${pathForIssue}-planning`
          : pathForIssue,
      workspaceKey:
        runPhase === "issue_breakdown"
          ? `${issue.identifier}-planning`
          : issue.identifier,
      createdNow: false,
      issueIdentifier: issue.identifier,
      sourceKind:
        runPhase === "issue_breakdown"
          ? "planning_preview"
          : this.config.workspace.source.kind,
      issueId: issue.id,
      ...(issue.branchName === null ? {} : { gitBranchName: issue.branchName }),
      ...(this.config.workspace.source.baseRef === undefined
        ? {}
        : { baseRef: this.config.workspace.source.baseRef }),
    };
  }

  private async renderPromptBundleForPreview(
    entry: RunningEntry,
    workspace: Workspace,
  ): Promise<AgentPromptBundle> {
    if (entry.role === "planner")
      return this.renderIssueBreakdownPromptBundle(entry, null);
    if (entry.role === "triage")
      return this.renderIssueTriagePromptBundle(entry);
    if (entry.role === "post_mortem")
      return this.renderIssuePostMortemPromptBundle(entry);
    if (entry.role === "reviewer") {
      const evidence =
        entry.reviewEvidence ??
        (await this.loadReviewerDispatchEvidence(entry.issue));
      if (!evidence)
        throw new SymphonyError(
          "invalid_request",
          "Reviewer prompt preview requires completion report evidence",
        );
      return this.renderReviewerPromptBundle(entry, evidence, workspace);
    }
    return this.renderWorkerPromptBundle(entry, null, 1);
  }

  async resumeApprovedPublication(
    request: OperatorApprovalRecord,
  ): Promise<boolean> {
    if (request.status !== "approved" || !this.options.lifecycleStore)
      return false;
    const latestIssues = await this.options.tracker.fetchIssueStatesByIds([
      request.issueId,
    ]);
    const issue = latestIssues[0] ?? issueFromApprovalRequest(request);
    const publisher =
      this.options.completionReportPublisher ??
      createGitHubPullRequestClientForCapability(
        this.config,
        "github.publication",
      );
    const result = await this.withTemporaryWritebackOutbox((writebackOutbox) =>
      new CompletionReportService({
        config: this.config,
        lifecycleStore: this.options.lifecycleStore!,
        writebackOutbox,
        ...(this.options.runStore === undefined
          ? {}
          : { runStore: this.options.runStore }),
        ...(this.options.writeback === undefined
          ? {}
          : { writebackProcessor: this.options.writeback }),
        pullRequestPublisher: publisher,
      }).resumeApprovedPublication({ approval: request, issue }),
    );
    if (!result) return false;
    await this.recordIssueEvidenceSnapshot({
      issue,
      evidenceKind: "approval",
      eventType: "publication_approval_resumed",
      sourceId: request.requestId,
      reason: "publication_approval_resumed",
      payload: {
        requestId: request.requestId,
        issueId: request.issueId,
        issueIdentifier: request.issueIdentifier,
        status: request.status,
        runId: request.runId,
        evidenceCursor: request.evidenceCursor,
        action: request.action,
      },
    });
    return true;
  }

  async recordPublicationApprovalTerminal(
    request: OperatorApprovalRecord,
  ): Promise<boolean> {
    if (!this.options.lifecycleStore) return false;
    const latestIssues = await this.options.tracker.fetchIssueStatesByIds([
      request.issueId,
    ]);
    const issue = latestIssues[0] ?? issueFromApprovalRequest(request);
    const result = await this.withTemporaryWritebackOutbox((writebackOutbox) =>
      new CompletionReportService({
        config: this.config,
        lifecycleStore: this.options.lifecycleStore!,
        writebackOutbox,
        ...(this.options.runStore === undefined
          ? {}
          : { runStore: this.options.runStore }),
        ...(this.options.writeback === undefined
          ? {}
          : { writebackProcessor: this.options.writeback }),
      }).recordPublicationApprovalTerminal({ approval: request, issue }),
    );
    if (result.length > 0) {
      await this.recordIssueEvidenceSnapshot({
        issue,
        evidenceKind: "approval",
        eventType: "publication_approval_terminal_recorded",
        sourceId: request.requestId,
        reason: `publication_approval_${request.status}`,
        payload: {
          requestId: request.requestId,
          issueId: request.issueId,
          issueIdentifier: request.issueIdentifier,
          status: request.status,
          runId: request.runId,
          evidenceCursor: request.evidenceCursor,
          action: request.action,
          results: result,
        },
      });
      return true;
    }
    const lifecycle =
      (await this.options.lifecycleStore.get(request.issueId)) ??
      (request.issueIdentifier
        ? await this.options.lifecycleStore.get(request.issueIdentifier)
        : null);
    return (
      lifecycle?.phase === "blocked" &&
      lifecycle.blockedReason === `publication approval ${request.status}`
    );
  }

  private async withTemporaryWritebackOutbox<T>(
    operation: (writebackOutbox: SqliteWritebackOutboxStore) => Promise<T>,
  ): Promise<T> {
    const writebackOutbox = new SqliteWritebackOutboxStore(
      this.config.workspace.stateDir,
    );
    try {
      return await operation(writebackOutbox);
    } finally {
      await writebackOutbox.close();
    }
  }

  async createContinuationSummary(
    issueOrId: Pick<Issue, "id" | "identifier" | "title"> | string,
    summarizer: ContinuationSummarizer = new PlaceholderContinuationSummarizer(),
  ): Promise<ContinuationSummaryCreationResult> {
    const lifecycleStore = this.options.lifecycleStore;
    const runStore = this.options.runStore;
    if (!lifecycleStore || !runStore) {
      throw new SymphonyError(
        "invalid_request",
        "Continuation summaries require lifecycle and transcript stores",
      );
    }

    const lifecycle =
      typeof issueOrId === "string"
        ? await lifecycleStore.get(issueOrId)
        : await lifecycleStore.ensureIssue(issueOrId);
    if (!lifecycle)
      throw new SymphonyError(
        "not_found",
        `Issue lifecycle not found: ${issueOrId}`,
      );

    const issue =
      typeof issueOrId === "string"
        ? {
            id: lifecycle.issueId,
            identifier: lifecycle.issueIdentifier,
            title: lifecycle.issueIdentifier,
          }
        : issueOrId;
    const runs = await listRunsForLifecycle(runStore, lifecycle);
    const transcriptEvents = await readContinuationTranscriptEvents(
      runStore,
      runs,
    );
    const summaryReference = await summarizer.summarizeContinuationHistory({
      issue,
      runs,
      transcriptEvents,
      transcriptPointers: transcriptPointersForRuns(runs),
      statusApiPointers: statusApiPointersForIssue(
        lifecycle.issueIdentifier,
        runs,
      ),
    });
    const updated = await lifecycleStore.updateIssue(
      { id: lifecycle.issueId, identifier: lifecycle.issueIdentifier },
      {
        summaryReferences: upsertSummaryReference(
          lifecycle.summaryReferences,
          summaryReference,
        ),
      },
    );
    return { summaryReference, lifecycle: updated };
  }

  snapshot(): RuntimeSnapshot {
    const now = Date.now();
    return {
      generatedAt: new Date(now).toISOString(),
      counts: {
        running: this.running.size,
        retrying: this.retryAttempts.size,
        paused: this.pausedIssues.size,
        providerGates: this.activeProviderGates.length,
      },
      providerGates: this.activeProviderGates,
      providerGateCounts: {
        active: this.activeProviderGates.length,
        manual: this.activeProviderGates.filter(
          (gate) => gate.resumePolicy === "manual",
        ).length,
        autoResume: this.activeProviderGates.filter(
          (gate) => gate.resumePolicy === "auto_at_window_close",
        ).length,
      },
      running: [...this.running.entries()].map(([issueId, entry]) => ({
        issueId,
        issueIdentifier: entry.issue.identifier,
        role: entry.role,
        runPhase: entry.runPhase,
        runKind: runKindForPhase(entry.runPhase),
        state: entry.issue.state,
        workspacePath: entry.workspacePath,
        sessionId: entry.sessionId,
        runId: entry.runId,
        turnCount: entry.turnCount,
        lastEvent: entry.lastEvent,
        lastMessage: entry.lastMessage,
        startedAt: entry.startedAt.toISOString(),
        lastEventAt: entry.lastEventAt?.toISOString() ?? null,
        liveness: this.livenessForEntry(entry, now),
        cancellation: cancellationForEntry(entry),
        activity: activityForEntry(entry),
        tokens: entry.tokens,
        lifecycle: entry.lifecycle,
        metadata: metadataForRunningEntry(entry),
        issueDetails: toIssueStatusView(entry.issue),
      })),
      retrying: [...this.retryAttempts.values()].map((entry) => ({
        issueId: entry.issueId,
        issueIdentifier: entry.identifier,
        attempt: entry.attempt,
        dueAt: new Date(entry.dueAtMs).toISOString(),
        error: entry.error,
      })),
      paused: [...this.pausedIssues],
      totals: {
        ...this.totals,
        secondsRunning:
          this.endedRuntimeSeconds + this.activeRuntimeSeconds(now),
      },
      rateLimits: this.rateLimits,
    };
  }

  getIssueDetails(
    issueIdOrIdentifier: string,
  ): RuntimeSnapshot["running"][number] | null {
    const snapshot = this.snapshot();
    return (
      snapshot.running.find(
        (row) =>
          row.issueId === issueIdOrIdentifier ||
          row.issueIdentifier === issueIdOrIdentifier,
      ) ?? null
    );
  }

  private scheduleTick(delayMs: number): void {
    if (this.stopped) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      void this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      await this.reconcileRunningIssues();
      await this.reconcileMergeQueueLease();
      const providerGate = await this.activeProviderDispatchGate();
      if (providerGate) {
        this.options.logger.warn("agent dispatch paused by provider limit", {
          gate_id: providerGate.id,
          harness_id: providerGate.scope.harnessId,
          provider_id: providerGate.scope.providerId,
          model: providerGate.scope.model,
          kind: providerGate.kind,
          resume_policy: providerGate.resumePolicy,
          resume_at: providerGate.window?.resumeAt ?? null,
          message: providerGate.message,
        });
        return;
      }
      await this.recoverPendingPublicationApprovalHandoffs();
      await this.processTickIssueCandidates();
    } catch (error) {
      this.options.logger.warn("orchestrator tick failed", {
        error: errorMessage(error),
      });
    } finally {
      this.ticking = false;
      this.scheduleTick(this.config.polling.intervalMs);
    }
  }

  private async processTickIssueCandidates(): Promise<void> {
    const excludedIssueIds = await this.tickIssueCandidateExcludedIssueIds();
    if (typeof this.options.tracker.fetchIssueCandidatePageByFilter === "function") {
      const processedPaged =
        await this.processPagedTickIssueCandidateLanes(excludedIssueIds);
      if (processedPaged) return;
    }

    const candidates = await this.fetchTickIssueCandidates({
      excludeIssueIds: [...excludedIssueIds],
    });
    for (const issue of sortIssuesForDispatch(candidates)) {
      await this.processTickIssueCandidate(issue);
    }
  }

  private async reconcileMergeQueueLease(): Promise<void> {
    if (this.config.mergePolicy.mode !== "gated") return;
    let current: MergeQueueSnapshot;
    try {
      current = await this.mergeQueueStore.getCurrent();
    } catch (error) {
      this.options.logger.warn("merge queue lease read failed", {
        error: errorMessage(error),
      });
      return;
    }
    if (current.activeIssueId === null) return;

    const leaseIssue = {
      id: current.activeIssueId,
      identifier: current.activeIssueIdentifier ?? current.activeIssueId,
    };
    let issue: Issue | null = null;
    try {
      issue =
        (await this.options.tracker.fetchIssueStatesByIds([
          current.activeIssueId,
        ]))[0] ?? null;
    } catch (error) {
      this.options.logger.warn("merge queue active issue refresh failed", {
        issue_id: current.activeIssueId,
        issue_identifier: current.activeIssueIdentifier,
        error: errorMessage(error),
      });
      return;
    }

    if (issue === null) {
      await this.releaseMergeQueueLease(
        leaseIssue,
        "merge_queue_active_issue_missing",
      );
      return;
    }
    if (!this.issueStateCanRetainMergeQueueLease(issue)) {
      await this.releaseMergeQueueLease(
        leaseIssue,
        "merge_queue_active_issue_not_eligible",
      );
    }
  }

  private issueStateCanRetainMergeQueueLease(issue: Issue): boolean {
    if (isStateIn(issue.state, this.config.tracker.terminalStates))
      return false;
    if (
      this.config.mergePolicy.conflictsState !== null &&
      statesEqual(issue.state, this.config.mergePolicy.conflictsState)
    ) {
      return false;
    }
    if (isStateIn(issue.state, this.config.reviewLoop.blockedStates))
      return false;
    if (isStateIn(issue.state, this.config.mergePolicy.sourceStates))
      return true;
    if (isStateIn(issue.state, this.config.reviewLoop.reviewStates))
      return true;
    return isStateIn(issue.state, this.config.tracker.activeStates);
  }

  private async processPagedTickIssueCandidateLanes(
    excludedIssueIds: Set<string>,
  ): Promise<boolean> {
    const processedIssueIds = new Set<string>();
    let fetchedAnyPage = false;
    for (const lane of this.tickIssueCandidateLanes()) {
      if (lane.requiresAgentSlot && this.availableSlots() <= 0) return true;
      const laneExcludedIssueIds = [
        ...excludedIssueIds,
        ...processedIssueIds,
      ];
      let after: string | null = null;
      do {
        if (lane.requiresAgentSlot && this.availableSlots() <= 0) return true;
        let page: TrackerIssueCandidatePage;
        try {
          page = await this.options.tracker.fetchIssueCandidatePageByFilter!({
            branches: [lane.branch],
            excludeIssueIds: laneExcludedIssueIds,
            after,
          });
        } catch (error) {
          this.options.logger.warn("paged tick issue candidate fetch failed", {
            lane_id: lane.id,
            after,
            error: errorMessage(error),
          });
          return fetchedAnyPage;
        }
        fetchedAnyPage = true;
        for (const issue of sortIssuesForDispatch(page.issues)) {
          if (
            excludedIssueIds.has(issue.id) ||
            processedIssueIds.has(issue.id)
          ) {
            continue;
          }
          processedIssueIds.add(issue.id);
          await this.processTickIssueCandidate(issue, {
            refreshBeforeTransition: false,
          });
          if (lane.requiresAgentSlot && this.availableSlots() <= 0) {
            return true;
          }
        }
        after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
      } while (after);
    }

    return true;
  }

  private async tickIssueCandidateExcludedIssueIds(): Promise<Set<string>> {
    const excluded = new Set<string>([
      ...this.running.keys(),
      ...this.claimed,
      ...this.pausedIssues,
      ...this.retryAttempts.keys(),
    ]);

    if (this.options.lifecycleStore) {
      try {
        for (const lifecycle of await this.options.lifecycleStore.list()) {
          if (pendingPublicationHandoffForRun(lifecycle) !== null) {
            excluded.add(lifecycle.issueId);
          }
        }
      } catch (error) {
        this.options.logger.warn("tick lifecycle exclusion list failed", {
          error: errorMessage(error),
        });
      }
    }

    return excluded;
  }

  private async fetchTickIssueCandidates(
    options: { excludeIssueIds?: readonly string[] } = {},
  ): Promise<Issue[]> {
    const byId = new Map<string, Issue>();
    const excludedIssueIds = new Set(options.excludeIssueIds ?? []);
    const filter = this.tickIssueCandidateFilter({
      excludeIssueIds: [...excludedIssueIds],
    });
    let fetchedWithFilter = false;
    if (
      filter.branches.length > 0 &&
      typeof this.options.tracker.fetchIssueCandidatesByFilter === "function"
    ) {
      try {
        for (const issue of await this.options.tracker.fetchIssueCandidatesByFilter(filter)) {
          if (excludedIssueIds.has(issue.id)) continue;
          byId.set(issue.id, issue);
        }
        fetchedWithFilter = true;
      } catch (error) {
        this.options.logger.warn("filtered tick issue candidate fetch failed", {
          branches: filter.branches.map((branch) => branch.id),
          error: errorMessage(error),
        });
      }
    }
    if (!fetchedWithFilter) {
      const states = this.tickIssueCandidateStates();
      if (states.length > 0) {
        try {
          for (const issue of await this.options.tracker.fetchIssuesByStates(
            states,
            { applyRouting: true },
          )) {
            if (excludedIssueIds.has(issue.id)) continue;
            byId.set(issue.id, issue);
          }
        } catch (error) {
          this.options.logger.warn("tick issue state fetch failed", {
            states,
            error: errorMessage(error),
          });
        }
      }
    }
    return [...byId.values()];
  }

  private tickIssueCandidateFilter(
    options: { excludeIssueIds?: readonly string[] } = {},
  ): TrackerIssueCandidateFilterInput {
    return {
      branches: this.tickIssueCandidateLanes().map((lane) => lane.branch),
      excludeIssueIds: [...(options.excludeIssueIds ?? [])],
    };
  }

  private tickIssueCandidateLanes(): TickIssueCandidateLane[] {
    const lanes: TickIssueCandidateLane[] = [];
    const globalRequiredLabels = this.config.agent.requireLabels;
    const globalExcludeLabels = this.config.agent.excludeLabels;
    const activeStates = uniqueStateNames(this.config.tracker.activeStates);
    const todoStates = activeStates.filter(
      (state) => state.trim().toLowerCase() === "todo",
    );
    const nonTodoActiveStates = activeStates.filter(
      (state) => state.trim().toLowerCase() !== "todo",
    );
    for (const state of uniqueStateNames(
      this.config.mergePolicy.mode === "gated"
        ? this.config.mergePolicy.sourceStates
        : [],
    )) {
      lanes.push({
        id: `merge_policy_source:${state}`,
        requiresAgentSlot: false,
        branch: {
          id: `merge_policy_source:${state}`,
          stateNames: [state],
          requireLabels: globalRequiredLabels,
          excludeLabels: globalExcludeLabels,
        },
      });
    }
    if (
      this.config.mergePolicy.mode === "gated" &&
      this.config.mergePolicy.conflictsState !== null
    ) {
      const conflictsState = this.config.mergePolicy.conflictsState;
      lanes.push({
        id: `merge_policy_conflicts:${conflictsState}`,
        requiresAgentSlot: false,
        branch: {
          id: `merge_policy_conflicts:${conflictsState}`,
          stateNames: [conflictsState],
          requireLabels: globalRequiredLabels,
          excludeLabels: globalExcludeLabels,
        },
      });
    }
    for (const state of uniqueStateNames(this.config.reviewLoop.reviewStates)) {
      lanes.push({
        id: `review_dispatch:${state}`,
        requiresAgentSlot: true,
        branch: {
          id: `review_dispatch:${state}`,
          stateNames: [state],
          requireLabels: globalRequiredLabels,
          excludeLabels: globalExcludeLabels,
          requireNoOpenBlockers: true,
        },
      });
    }
    for (const state of nonTodoActiveStates) {
      lanes.push({
        id: `active_non_todo_dispatch:${state}`,
        requiresAgentSlot: true,
        branch: {
          id: `active_non_todo_dispatch:${state}`,
          stateNames: [state],
          requireLabels: globalRequiredLabels,
          excludeLabels: globalExcludeLabels,
          requireAssignedToWorker: true,
          requireNoChildren: true,
        },
      });
    }
    for (const state of todoStates) {
      lanes.push({
        id: `active_todo_dispatch:${state}`,
        requiresAgentSlot: true,
        branch: {
          id: `active_todo_dispatch:${state}`,
          stateNames: [state],
          requireLabels: globalRequiredLabels,
          excludeLabels: globalExcludeLabels,
          requireAssignedToWorker: true,
          requireNoOpenBlockers: true,
          requireNoChildren: true,
        },
      });
    }
    for (const state of uniqueStateNames(this.config.reviewLoop.blockedStates)) {
      lanes.push({
        id: `blocked_triage:${state}`,
        requiresAgentSlot: true,
        branch: {
          id: `blocked_triage:${state}`,
          stateNames: [state],
          requireLabels: globalRequiredLabels,
          excludeLabels: globalExcludeLabels,
        },
      });
    }
    if (this.config.postMortem.enabled) {
      for (const state of uniqueStateNames(this.config.postMortem.doneStates)) {
        lanes.push({
          id: `post_mortem:${state}`,
          requiresAgentSlot: true,
          branch: {
            id: `post_mortem:${state}`,
            stateNames: [state],
            requireLabels: [
              ...globalRequiredLabels,
              ...this.config.postMortem.requireLabels,
            ],
            excludeLabels: [
              ...globalExcludeLabels,
              ...this.config.postMortem.excludeLabels,
            ],
          },
        });
      }
    }
    return lanes;
  }

  /*
   * Keep this method as the single source of all tracker states the tick may
   * need. The paged fast path queries them lane-by-lane; the legacy tracker
   * fallback still needs the compact state list.
   */
  private tickIssueCandidateStates(): string[] {
    const states = [
      ...this.config.tracker.activeStates,
      ...this.config.reviewLoop.reviewStates,
      ...this.config.reviewLoop.blockedStates,
      ...this.config.postMortem.doneStates,
      ...(this.config.mergePolicy.mode === "gated"
        ? this.config.mergePolicy.sourceStates
        : []),
      ...(this.config.mergePolicy.mode === "gated" &&
      this.config.mergePolicy.conflictsState !== null
        ? [this.config.mergePolicy.conflictsState]
        : []),
    ];
    return uniqueStateNames(
      states.map((state) => state.trim()).filter((state) => state.length > 0),
    );
  }

  private async processTickIssueCandidate(
    issue: Issue,
    options: { refreshBeforeTransition?: boolean } = {},
  ): Promise<boolean> {
    let acted = false;
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const result = await this.processIssueTransitionCandidateEvent({
        issue,
        candidateSource: "tick_candidates",
        ...(options.refreshBeforeTransition === undefined
          ? {}
          : { refreshBeforeTransition: options.refreshBeforeTransition }),
      });
      if (
        result.transition === null ||
        result.transition.transitionKind === "noop"
      )
        return acted;
      acted = acted || result.acted;
      if (!result.acted) return acted;
      if (
        mergePolicyTransitionShouldContinue(result.transition.transitionKind)
      ) {
        await this.continueMergePolicyTransitionChain(issue, result.transition);
        return true;
      }
      if (baseRefTransitionShouldContinue(result.transition.transitionKind)) {
        await this.continueBaseRefTransitionChain(issue, result.transition);
        return true;
      }
      if (!tickTransitionShouldContinue(result.transition.transitionKind))
        return acted;
    }
    return acted;
  }

  private async refreshProviderGates(): Promise<RuntimeProviderGate[]> {
    try {
      this.activeProviderGates = await this.providerGateStore.listActive(
        new Date(),
      );
    } catch (error) {
      this.options.logger.warn("provider gate refresh failed", {
        error: errorMessage(error),
      });
    }
    return this.activeProviderGates;
  }

  private async activeProviderDispatchGate(): Promise<RuntimeProviderGate | null> {
    await this.refreshProviderGates();
    return (
      this.activeProviderGates.find((gate) =>
        this.providerGateMatchesConfiguredRuntime(gate),
      ) ?? null
    );
  }

  private providerGateMatchesConfiguredRuntime(
    gate: RuntimeProviderGate,
  ): boolean {
    if (
      gate.scope.harnessId &&
      gate.scope.harnessId !== this.options.harness.id
    )
      return false;
    const configuredProvider = runtimeProviderForHarness(
      this.options.harness.id,
      this.config,
    );
    if (
      gate.scope.providerId &&
      configuredProvider &&
      gate.scope.providerId !== configuredProvider
    )
      return false;
    const configuredModel = runtimeModelForHarness(
      this.options.harness.id,
      this.config,
    );
    if (
      gate.scope.model &&
      configuredModel &&
      gate.scope.model !== configuredModel
    )
      return false;
    return true;
  }

  private createMergePolicyTransitions(): IssueTransition<OrchestratorTransitionContext>[] {
    const execute = (
      id: string,
      fn: (
        context: OrchestratorTransitionContext,
        service: MergePolicyService,
        observation: MergePolicyObservation,
      ) => Promise<unknown>,
    ) => ({
      id,
      execute: async (context: OrchestratorTransitionContext) => {
        const service = this.mergePolicyServiceForContext(context);
        const observation = this.mergePolicyObservationForTransition(
          context.transition,
        );
        const result = await fn(context, service, observation);
        context.mergePolicy.result = result;
        return { details: result };
      },
    });
    const wait = (
      kind: IssueTransitionKind,
      actionType: string,
    ): IssueTransition<OrchestratorTransitionContext> => ({
      kind,
      actions: [
        {
          id: actionType,
          execute: async ({ transition }) => ({
            message: transition.reason,
            details: {
              transitionKind: transition.transitionKind,
              reason: transition.reason,
              observation: mergePolicyObservationFromUnknown(
                transition.lastMergePolicyObservation,
              ),
            },
          }),
        },
      ],
    });
    const conflictPreparationActions = (
      planActionId: string,
      plan: (
        service: MergePolicyService,
        context: OrchestratorTransitionContext,
        observation: MergePolicyObservation,
      ) => Promise<MergePolicyConflictPreparationPlan | null>,
    ): IssueTransition<OrchestratorTransitionContext>["actions"] => [
      {
        id: planActionId,
        execute: async (context) => {
          const service = this.mergePolicyServiceForContext(context);
          const observation = this.mergePolicyObservationForTransition(
            context.transition,
          );
          const preparationPlan = await plan(service, context, observation);
          if (preparationPlan === null) {
            return {
              status: "skipped",
              stop: true,
              message: "Merge conflict preparation is no longer applicable",
            };
          }
          context.mergePolicy.conflictPreparationPlan = preparationPlan;
          return {
            details: {
              mode: preparationPlan.mode,
              workspacePath: preparationPlan.workspacePath,
              branchName: preparationPlan.branchName,
              expectedHeadSha: preparationPlan.expectedHeadSha,
              liveBaseHeadSha: preparationPlan.baseObservation.liveBaseHeadSha,
            },
          };
        },
      },
      {
        id: "prepare_service_conflict_branch",
        execute: async (context) => {
          const service = this.mergePolicyServiceForContext(context);
          const preparationPlan = context.mergePolicy.conflictPreparationPlan;
          if (!preparationPlan)
            throw new SymphonyError(
              "invalid_request",
              "Merge conflict preparation requires a plan",
            );
          const execution =
            await service.prepareServiceConflictBranch(context.issue, preparationPlan);
          context.mergePolicy.conflictPreparationExecution = execution;
          return {
            details: {
              status: execution.preparation.status,
              resolvedHeadSha: execution.resolvedHeadSha,
              pullRequestHeadSha: execution.pullRequestHeadSha,
              conflictedFiles: execution.preparation.conflictedFiles,
            },
          };
        },
      },
      {
        id: "publish_prepared_conflict_head",
        execute: async (context) => {
          const service = this.mergePolicyServiceForContext(context);
          const preparationPlan = context.mergePolicy.conflictPreparationPlan;
          const execution = context.mergePolicy.conflictPreparationExecution;
          if (!preparationPlan || !execution) {
            throw new SymphonyError(
              "invalid_request",
              "Prepared conflict publication requires preparation output",
            );
          }
          if (execution.preparation.status !== "clean") {
            return {
              status: "skipped",
              message: "Prepared conflict branch is still conflicted",
              details: null,
            };
          }
          const result = await service.publishPreparedConflictHead(
            preparationPlan,
            execution,
          );
          await service.restorePreservedStashAfterPreparedHead(
            context.issue,
            preparationPlan,
            execution,
          );
          return { details: result };
        },
      },
      {
        id: "plan_merge_conflict_writebacks",
        execute: async (context) => {
          const service = this.mergePolicyServiceForContext(context);
          const preparationPlan = context.mergePolicy.conflictPreparationPlan;
          const execution = context.mergePolicy.conflictPreparationExecution;
          if (!preparationPlan || !execution) {
            throw new SymphonyError(
              "invalid_request",
              "Merge conflict writeback planning requires preparation output",
            );
          }
          const writebackPlan = service.planServiceConflictWritebacks(
            context.issue,
            preparationPlan,
            execution,
          );
          context.mergePolicy.conflictWritebackPlan = writebackPlan;
          return {
            details: {
              operationKeys: writebackPlan.operations.map(
                (operation) => operation.idempotencyKey,
              ),
            },
          };
        },
      },
      {
        id: "apply_merge_conflict_writebacks",
        execute: async (context) => {
          const service = this.mergePolicyServiceForContext(context);
          const preparationPlan = context.mergePolicy.conflictPreparationPlan;
          const writebackPlan = context.mergePolicy.conflictWritebackPlan;
          if (!preparationPlan || !writebackPlan) {
            throw new SymphonyError(
              "invalid_request",
              "Merge conflict writeback application requires a writeback plan",
            );
          }
          if (writebackPlan.operations.length === 0) {
            return {
              status: "skipped",
              message: "No merge conflict writebacks were required",
              details: null,
            };
          }
          const result = await service.applyServiceConflictWritebacks(
            context.issue,
            preparationPlan,
            writebackPlan,
          );
          return { details: result };
        },
      },
      {
        id: "record_merge_conflict_lifecycle",
        execute: async (context) => {
          const service = this.mergePolicyServiceForContext(context);
          const preparationPlan = context.mergePolicy.conflictPreparationPlan;
          const execution = context.mergePolicy.conflictPreparationExecution;
          const writebackPlan = context.mergePolicy.conflictWritebackPlan;
          if (!preparationPlan || !execution || !writebackPlan) {
            throw new SymphonyError(
              "invalid_request",
              "Merge conflict lifecycle update requires preparation output",
            );
          }
          const result = await service.recordServicePreparedMergeConflict(
            context.issue,
            preparationPlan,
            execution,
            writebackPlan,
          );
          context.mergePolicy.result = result;
          return { details: result };
        },
      },
    ];
    return [
      {
        kind: "merge_policy_observe",
        actions: [
          {
            id: "validate_merge_policy_service_configuration",
            execute: async (context) => {
              const service = this.mergePolicyServiceForContext(context);
              service.requireGatedServiceConfiguration();
              return { details: { mode: this.config.mergePolicy.mode } };
            },
          },
          {
            id: "record_merge_policy_observation",
            execute: async (context) => {
              const service = this.mergePolicyServiceForContext(context);
              const fingerprint = nonEmptyString(
                context.transition
                  .currentMergePolicyObservationInputFingerprint,
              );
              if (fingerprint === null) {
                return {
                  status: "skipped",
                  message:
                    "Merge policy observation fingerprint is unavailable",
                  details: null,
                };
              }
              const observation = await service.observeIssue(
                context.issue,
                fingerprint,
              );
              context.mergePolicy.observation = observation;
              await this.issueStateStore.patchCurrent(context.issue, {
                lastMergePolicyObservation: observation,
                lastMergePolicyObservationFingerprint:
                  observation.inputFingerprint,
                lastMergePolicyObservationStatus: observation.status,
              });
              return {
                status:
                  observation.status === "skipped" ? "skipped" : "succeeded",
                message: observation.reason,
                details: observation,
              };
            },
          },
        ],
      },
      {
        kind: "merge_policy_reset_operator_resume",
        actions: [
          {
            id: "reset_lifecycle_failure_budget_after_operator_action",
            execute: async ({ issue }) => {
              const lifecycle = await this.options.lifecycleStore?.get(
                issue.id,
              );
              if (!lifecycle)
                return {
                  status: "skipped",
                  message: "Lifecycle record is unavailable",
                  details: null,
                };
              const updated = await this.resetFailureBudgetAfterOperatorAction(
                issue,
                lifecycle,
                "merge_policy_source_state_resume",
                {
                  reopenMergeConflict:
                    this.config.mergePolicy.conflictsState !== null &&
                    isStateIn(issue.state, [
                      this.config.mergePolicy.conflictsState,
                    ]),
                },
              );
              return {
                details: {
                  phase: updated.phase,
                  blockedReason: updated.blockedReason,
                },
              };
            },
          },
        ],
      },
      {
        kind: "merge_policy_write_done_state",
        actions: [
          {
            id: "plan_done_state_writeback",
            execute: async (context) => {
              const service = this.mergePolicyServiceForContext(context);
              const plan = await service.planDoneStateWriteback(context.issue);
              context.mergePolicy.doneWritebackPlan = plan;
              return {
                details: {
                  sourceState: plan.sourceState,
                  operationKey: plan.operation.idempotencyKey,
                },
              };
            },
          },
          {
            id: "apply_done_state_writeback",
            execute: async (context) => {
              const service = this.mergePolicyServiceForContext(context);
              const plan = context.mergePolicy.doneWritebackPlan;
              if (!plan)
                throw new SymphonyError(
                  "invalid_request",
                  "Done writeback action requires a planned operation",
                );
              const result = await service.applyDoneStateWriteback(plan);
              return {
                details: {
                  operationKey: result.idempotencyKey,
                  status: result.status,
                },
              };
            },
          },
          {
            id: "verify_done_state",
            execute: async (context) => {
              const service = this.mergePolicyServiceForContext(context);
              const plan = context.mergePolicy.doneWritebackPlan;
              if (!plan)
                throw new SymphonyError(
                  "invalid_request",
                  "Done verification requires a planned operation",
                );
              const result = await service.verifyDoneState(plan.latestIssue);
              context.mergePolicy.result = {
                status: "already_merged",
                merge: plan.merge,
              };
              return { details: { ...result, mergeId: plan.merge.id } };
            },
          },
          {
            id: "release_merge_queue_after_done_writeback",
            execute: (context) =>
              this.releaseMergeQueueAction(
                context,
                "merge_policy_done_writeback_verified",
              ),
          },
        ],
      },
      {
        kind: "merge_policy_retire_stale_gate",
        actions: [
          execute(
            "update_lifecycle_superseded_gate",
            (context, service, observation) =>
              service.retireStaleGate(context.issue, observation),
          ),
        ],
      },
      {
        kind: "merge_policy_mark_head_superseded",
        actions: [
          {
            id: "plan_head_supersession_writebacks",
            execute: async (context) => {
              const service = this.mergePolicyServiceForContext(context);
              const observation = this.mergePolicyObservationForTransition(
                context.transition,
              );
              const plan = await service.planHeadSupersession(
                context.issue,
                observation,
              );
              context.mergePolicy.headSupersessionPlan = plan;
              return {
                details: {
                  previousHeadSha: plan.previousHeadSha,
                  liveHeadSha: plan.liveHeadSha,
                  operationKeys: plan.operations.map(
                    (operation) => operation.idempotencyKey,
                  ),
                },
              };
            },
          },
          {
            id: "apply_head_supersession_writebacks",
            execute: async (context) => {
              const service = this.mergePolicyServiceForContext(context);
              const plan = context.mergePolicy.headSupersessionPlan;
              if (!plan)
                throw new SymphonyError(
                  "invalid_request",
                  "Head supersession writeback requires a plan",
                );
              const result = await service.applyHeadSupersessionWritebacks(
                context.issue,
                plan,
              );
              return { details: result };
            },
          },
          {
            id: "record_head_supersession_lifecycle",
            execute: async (context) => {
              const service = this.mergePolicyServiceForContext(context);
              const plan = context.mergePolicy.headSupersessionPlan;
              if (!plan)
                throw new SymphonyError(
                  "invalid_request",
                  "Head supersession lifecycle update requires a plan",
                );
              const result = await service.recordHeadSupersessionLifecycle(
                context.issue,
                plan,
              );
              context.mergePolicy.result = result;
              return { details: result };
            },
          },
        ],
      },
      wait(
        "merge_policy_wait_conflict_state",
        "record_merge_policy_conflict_state_wait",
      ),
      {
        kind: "merge_policy_refresh_conflict_base",
        actions: conflictPreparationActions(
          "plan_conflict_base_refresh",
          (service, context, observation) =>
            service.planRefreshConflictBase(context.issue, observation),
        ),
      },
      wait(
        "merge_policy_wait_active_blocked_gate",
        "record_merge_policy_blocked_gate_wait",
      ),
      wait(
        "merge_policy_wait_repair_clearance",
        "record_merge_policy_repair_clearance_wait",
      ),
      {
        kind: "merge_policy_refresh_same_gate_blocker",
        actions: [
          execute(
            "update_lifecycle_merge_gate_observation",
            (context, service, observation) =>
              service.refreshSameGateBlocker(context.issue, observation),
          ),
        ],
      },
      {
        kind: "merge_policy_observe_checks_pending",
        actions: [
          execute(
            "update_lifecycle_checks_pending_observation",
            (context, service, observation) =>
              service.observeChecksPending(context.issue, observation),
          ),
        ],
      },
      {
        kind: "merge_policy_auto_resolve_gate",
        actions: [
          execute(
            "update_lifecycle_auto_resolved_merge_gate",
            (context, service, observation) =>
              service.autoResolveGate(context.issue, observation),
          ),
        ],
      },
      {
        kind: "merge_policy_prepare_conflict",
        actions: [
          ...conflictPreparationActions(
            "plan_service_owned_conflict_preparation",
            (service, context, observation) =>
              service.planServicePreparedMergeConflict(
                context.issue,
                observation,
              ),
          ),
          {
            id: "release_merge_queue_after_conflict_preparation",
            execute: (context) =>
              this.releaseMergeQueueAction(
                context,
                "merge_policy_conflict_prepared",
              ),
          },
        ],
      },
      {
        kind: "merge_policy_dispatch_repair",
        actions: [
          {
            id: "plan_merge_gate_repair_writebacks",
            execute: async (context) => {
              const service = this.mergePolicyServiceForContext(context);
              const observation = this.mergePolicyObservationForTransition(
                context.transition,
              );
              const plan = await service.planMergeGateFailure(
                context.issue,
                observation,
                "repair",
              );
              context.mergePolicy.gateFailurePlan = plan;
              return {
                details: {
                  gateId: plan.gate.id,
                  blocked: plan.blocked,
                  reviewRound: plan.reviewRound,
                  operationKeys: plan.operations.map(
                    (operation) => operation.idempotencyKey,
                  ),
                },
              };
            },
          },
          {
            id: "apply_merge_gate_repair_writebacks",
            execute: async (context) => {
              const service = this.mergePolicyServiceForContext(context);
              const plan = context.mergePolicy.gateFailurePlan;
              if (!plan)
                throw new SymphonyError(
                  "invalid_request",
                  "Merge gate repair writeback requires a plan",
                );
              const result = await service.applyMergeGateFailureWritebacks(
                context.issue,
                plan,
              );
              return { details: result };
            },
          },
          {
            id: "record_merge_gate_repair_lifecycle",
            execute: async (context) => {
              const service = this.mergePolicyServiceForContext(context);
              const plan = context.mergePolicy.gateFailurePlan;
              if (!plan)
                throw new SymphonyError(
                  "invalid_request",
                  "Merge gate repair lifecycle update requires a plan",
                );
              const result = await service.recordMergeGateFailureLifecycle(
                context.issue,
                plan,
              );
              context.mergePolicy.result = result;
              return { details: result };
            },
          },
        ],
      },
      {
        kind: "merge_policy_block_failure",
        actions: [
          {
            id: "plan_merge_gate_blocked_writebacks",
            execute: async (context) => {
              const service = this.mergePolicyServiceForContext(context);
              const observation = this.mergePolicyObservationForTransition(
                context.transition,
              );
              const plan = await service.planMergeGateFailure(
                context.issue,
                observation,
                "blocked",
              );
              context.mergePolicy.gateFailurePlan = plan;
              return {
                details: {
                  gateId: plan.gate.id,
                  blocked: plan.blocked,
                  reviewRound: plan.reviewRound,
                  operationKeys: plan.operations.map(
                    (operation) => operation.idempotencyKey,
                  ),
                },
              };
            },
          },
          {
            id: "apply_merge_gate_blocked_writebacks",
            execute: async (context) => {
              const service = this.mergePolicyServiceForContext(context);
              const plan = context.mergePolicy.gateFailurePlan;
              if (!plan)
                throw new SymphonyError(
                  "invalid_request",
                  "Merge gate blocked writeback requires a plan",
                );
              const result = await service.applyMergeGateFailureWritebacks(
                context.issue,
                plan,
              );
              return { details: result };
            },
          },
          {
            id: "record_merge_gate_blocked_lifecycle",
            execute: async (context) => {
              const service = this.mergePolicyServiceForContext(context);
              const plan = context.mergePolicy.gateFailurePlan;
              if (!plan)
                throw new SymphonyError(
                  "invalid_request",
                  "Merge gate blocked lifecycle update requires a plan",
                );
              const result = await service.recordMergeGateFailureLifecycle(
                context.issue,
                plan,
              );
              context.mergePolicy.result = result;
              return { details: result };
            },
          },
          {
            id: "release_merge_queue_after_merge_policy_block",
            execute: (context) =>
              this.releaseMergeQueueAction(
                context,
                "merge_policy_block_failure",
              ),
          },
        ],
      },
      {
        kind: "merge_policy_merge_pull_request",
        actions: [
          {
            id: "plan_pull_request_merge",
            execute: async (context) => {
              const service = this.mergePolicyServiceForContext(context);
              const observation = this.mergePolicyObservationForTransition(
                context.transition,
              );
              const plan = await service.planMergePullRequest(
                context.issue,
                observation,
              );
              context.mergePolicy.mergePlan = plan;
              return {
                details: {
                  pullRequestNumber: plan.pullRequest.number,
                  headSha: plan.headSha,
                  doneTransitionOperationKey: plan.doneTransitionOperationKey,
                },
              };
            },
          },
          {
            id: "merge_pull_request",
            execute: async (context) => {
              const service = this.mergePolicyServiceForContext(context);
              const plan = context.mergePolicy.mergePlan;
              if (!plan)
                throw new SymphonyError(
                  "invalid_request",
                  "Pull request merge requires a merge plan",
                );
              const mergeResult = await service.mergeObservedPullRequest(plan);
              context.mergePolicy.mergeResult = mergeResult;
              return { details: mergeResult };
            },
          },
          {
            id: "record_merge_metadata",
            execute: async (context) => {
              const service = this.mergePolicyServiceForContext(context);
              const plan = context.mergePolicy.mergePlan;
              const mergeResult = context.mergePolicy.mergeResult;
              if (!plan || !mergeResult)
                throw new SymphonyError(
                  "invalid_request",
                  "Merge metadata recording requires merge result",
                );
              const recorded = await service.recordPullRequestMerge(
                context.issue,
                plan,
                mergeResult,
              );
              context.mergePolicy.recordedMerge = recorded;
              return { details: recorded.merge };
            },
          },
          {
            id: "plan_done_state_writeback",
            execute: async (context) => {
              const service = this.mergePolicyServiceForContext(context);
              const recorded = context.mergePolicy.recordedMerge;
              if (!recorded)
                throw new SymphonyError(
                  "invalid_request",
                  "Done writeback planning requires recorded merge metadata",
                );
              const plan = await service.planDoneStateWriteback({
                ...context.issue,
                state: recorded.sourceState,
              });
              context.mergePolicy.doneWritebackPlan = plan;
              return {
                details: {
                  sourceState: plan.sourceState,
                  operationKey: plan.operation.idempotencyKey,
                },
              };
            },
          },
          {
            id: "apply_done_state_writeback",
            execute: async (context) => {
              const service = this.mergePolicyServiceForContext(context);
              const plan = context.mergePolicy.doneWritebackPlan;
              if (!plan)
                throw new SymphonyError(
                  "invalid_request",
                  "Done writeback action requires a planned operation",
                );
              const result = await service.applyDoneStateWriteback(plan);
              return {
                details: {
                  operationKey: result.idempotencyKey,
                  status: result.status,
                },
              };
            },
          },
          {
            id: "verify_done_state",
            execute: async (context) => {
              const service = this.mergePolicyServiceForContext(context);
              const plan = context.mergePolicy.doneWritebackPlan;
              const recorded = context.mergePolicy.recordedMerge;
              if (!plan || !recorded)
                throw new SymphonyError(
                  "invalid_request",
                  "Done verification requires recorded merge metadata",
                );
              const result = await service.verifyDoneState(context.issue);
              context.mergePolicy.result = {
                status: "merged",
                merge: recorded.merge,
              };
              return { details: { ...result, mergeId: recorded.merge.id } };
            },
          },
          {
            id: "release_merge_queue_after_pull_request_merge",
            execute: (context) =>
              this.releaseMergeQueueAction(
                context,
                "merge_policy_merge_verified",
              ),
          },
        ],
      },
      {
        kind: "merge_policy_recover_already_merged_pull_request",
        actions: [
          {
            id: "plan_already_merged_recovery",
            execute: async (context) => {
              const service = this.mergePolicyServiceForContext(context);
              const observation = this.mergePolicyObservationForTransition(
                context.transition,
              );
              const plan = await service.planMergeRecovery(
                context.issue,
                observation,
              );
              context.mergePolicy.mergePlan = plan;
              return {
                details: {
                  pullRequestNumber: plan.pullRequest.number,
                  headSha: plan.headSha,
                  doneTransitionOperationKey: plan.doneTransitionOperationKey,
                },
              };
            },
          },
          {
            id: "recover_already_merged_result",
            execute: async (context) => {
              const service = this.mergePolicyServiceForContext(context);
              const observation = this.mergePolicyObservationForTransition(
                context.transition,
              );
              const plan = context.mergePolicy.mergePlan;
              if (!plan)
                throw new SymphonyError(
                  "invalid_request",
                  "Already-merged recovery requires a merge plan",
                );
              const mergeResult = service.recoverObservedPullRequestMerge(
                plan,
                observation,
              );
              context.mergePolicy.mergeResult = mergeResult;
              return { details: mergeResult };
            },
          },
          {
            id: "record_merge_metadata",
            execute: async (context) => {
              const service = this.mergePolicyServiceForContext(context);
              const plan = context.mergePolicy.mergePlan;
              const mergeResult = context.mergePolicy.mergeResult;
              if (!plan || !mergeResult)
                throw new SymphonyError(
                  "invalid_request",
                  "Merge metadata recording requires merge result",
                );
              const recorded = await service.recordPullRequestMerge(
                context.issue,
                plan,
                mergeResult,
              );
              context.mergePolicy.recordedMerge = recorded;
              return { details: recorded.merge };
            },
          },
          {
            id: "plan_done_state_writeback",
            execute: async (context) => {
              const service = this.mergePolicyServiceForContext(context);
              const recorded = context.mergePolicy.recordedMerge;
              if (!recorded)
                throw new SymphonyError(
                  "invalid_request",
                  "Done writeback planning requires recorded merge metadata",
                );
              const plan = await service.planDoneStateWriteback({
                ...context.issue,
                state: recorded.sourceState,
              });
              context.mergePolicy.doneWritebackPlan = plan;
              return {
                details: {
                  sourceState: plan.sourceState,
                  operationKey: plan.operation.idempotencyKey,
                },
              };
            },
          },
          {
            id: "apply_done_state_writeback",
            execute: async (context) => {
              const service = this.mergePolicyServiceForContext(context);
              const plan = context.mergePolicy.doneWritebackPlan;
              if (!plan)
                throw new SymphonyError(
                  "invalid_request",
                  "Done writeback action requires a planned operation",
                );
              const result = await service.applyDoneStateWriteback(plan);
              return {
                details: {
                  operationKey: result.idempotencyKey,
                  status: result.status,
                },
              };
            },
          },
          {
            id: "verify_done_state",
            execute: async (context) => {
              const service = this.mergePolicyServiceForContext(context);
              const plan = context.mergePolicy.doneWritebackPlan;
              const recorded = context.mergePolicy.recordedMerge;
              if (!plan || !recorded)
                throw new SymphonyError(
                  "invalid_request",
                  "Done verification requires recorded merge metadata",
                );
              const result = await service.verifyDoneState(context.issue);
              context.mergePolicy.result = {
                status: "already_merged",
                merge: recorded.merge,
              };
              return { details: { ...result, mergeId: recorded.merge.id } };
            },
          },
          {
            id: "release_merge_queue_after_already_merged_recovery",
            execute: (context) =>
              this.releaseMergeQueueAction(
                context,
                "merge_policy_already_merged_verified",
              ),
          },
        ],
      },
    ];
  }

  private mergePolicyServiceForContext(
    context: OrchestratorTransitionContext,
  ): MergePolicyService {
    context.mergePolicy.service ??= new MergePolicyService({
      config: this.config,
      tracker: this.options.tracker,
      lifecycleStore: this.requireLifecycleStoreForMergePolicy(),
      ...(this.options.runStore === undefined
        ? {}
        : { runStore: this.options.runStore }),
      ...(this.options.writeback === undefined
        ? {}
        : { writeback: this.options.writeback }),
      ...(this.options.pullRequestMergeClient === undefined
        ? {}
        : { client: this.options.pullRequestMergeClient }),
      logger: this.options.logger,
    });
    return context.mergePolicy.service;
  }

  private requireLifecycleStoreForMergePolicy(): IssueLifecycleStore {
    if (!this.options.lifecycleStore)
      throw new SymphonyError(
        "invalid_request",
        "Gated merge policy requires lifecycle persistence",
      );
    return this.options.lifecycleStore;
  }

  private mergePolicyObservationForTransition(
    transition: IssueHistorySnapshot,
  ): MergePolicyObservation {
    const observation = mergePolicyObservationFromUnknown(
      transition.lastMergePolicyObservation,
    );
    if (observation === null)
      throw new SymphonyError(
        "invalid_request",
        "Merge policy transition requires a fresh observation",
      );
    if (
      transition.currentMergePolicyObservationInputFingerprint !==
      observation.inputFingerprint
    ) {
      throw new SymphonyError(
        "invalid_request",
        "Merge policy observation is stale for the current transition",
      );
    }
    return observation;
  }

  private async claimMergeQueueAction(
    context: OrchestratorTransitionContext,
  ) {
    const result = await this.mergeQueueStore.claim(
      context.issue,
      context.transition.reason ?? "merge_queue_claim",
    );
    const details = {
      status: result.status,
      activeIssueId: result.snapshot.activeIssueId,
      activeIssueIdentifier: result.snapshot.activeIssueIdentifier,
      leaseId: result.snapshot.leaseId,
      sequence: result.snapshot.sequence,
    };
    if (result.status === "blocked_by_active_issue") {
      return {
        status: "skipped" as const,
        stop: true,
        message: "Merge queue is active for another issue",
        details,
      };
    }
    return { details };
  }

  private async releaseMergeQueueAction(
    context: OrchestratorTransitionContext,
    reason: string,
  ) {
    return this.releaseMergeQueueLease(context.issue, reason);
  }

  private async releaseMergeQueueLease(
    issue: Pick<Issue, "id" | "identifier">,
    reason: string,
  ) {
    const result = await this.mergeQueueStore.releaseIfActive(issue, reason);
    return this.mergeQueueReleaseActionResult(result);
  }

  private mergeQueueReleaseActionResult(result: MergeQueueReleaseResult) {
    const details = {
      status: result.status,
      activeIssueId: result.snapshot.activeIssueId,
      activeIssueIdentifier: result.snapshot.activeIssueIdentifier,
      leaseId: result.snapshot.leaseId,
      sequence: result.snapshot.sequence,
    };
    if (result.status !== "released") {
      return {
        status: "skipped" as const,
        message: "Issue does not own the active merge queue lease",
        details,
      };
    }
    return { details };
  }

  private createTransitions(): IssueTransition<OrchestratorTransitionContext>[] {
    return [
      {
        kind: "merge_queue_claim",
        actions: [
          {
            id: "claim_merge_queue",
            execute: (context) => this.claimMergeQueueAction(context),
          },
        ],
      },
      {
        kind: "base_ref_observe",
        actions: [
          {
            id: "record_base_ref_observation",
            execute: (context) => this.recordBaseRefObservationAction(context),
          },
        ],
      },
      {
        kind: "base_ref_repair",
        actions: [
          {
            id: "repair_base_ref_drift",
            execute: (context) => this.repairBaseRefDriftAction(context),
          },
        ],
      },
      {
        kind: "base_ref_block",
        actions: [
          {
            id: "load_block_issue_lifecycle",
            execute: (context) => this.loadBlockIssueLifecycleAction(context),
          },
          {
            id: "update_lifecycle_blocked",
            execute: (context) => this.updateLifecycleBlockedAction(context),
          },
          {
            id: "apply_blocked_escalation_writebacks",
            execute: (context) =>
              this.applyBlockedEscalationWritebacksAction(context),
          },
          {
            id: "record_block_issue",
            execute: (context) => this.recordBlockIssueAction(context),
          },
          {
            id: "release_merge_queue_after_base_ref_block",
            execute: (context) =>
              this.releaseMergeQueueAction(context, "base_ref_blocked"),
          },
        ],
      },
      {
        kind: "preserved_stash_restore",
        actions: [
          {
            id: "restore_preserved_worktree_stashes",
            execute: (context) =>
              this.restorePreservedWorktreeStashesAction(context),
          },
        ],
      },
      {
        kind: "dispatch_worker",
        actions: [
          {
            id: "plan_worker_dispatch_writeback",
            execute: (context) =>
              this.planWorkerDispatchWritebackAction(context),
          },
          {
            id: "apply_worker_dispatch_writeback",
            execute: (context) =>
              this.applyWorkerDispatchWritebackAction(context),
          },
          {
            id: "verify_worker_dispatch_writeback_state",
            execute: (context) =>
              this.verifyWorkerDispatchWritebackStateAction(context),
          },
          {
            id: "load_worker_dispatch_context",
            execute: (context) => this.loadDispatchContextAction(context),
          },
          {
            id: "record_agent_dispatch_started",
            execute: (context) =>
              this.recordAgentDispatchStartedAction(context),
          },
          {
            id: "create_running_entry",
            execute: (context) => this.createRunningEntryAction(context),
          },
          {
            id: "claim_issue_for_run",
            execute: (context) => this.claimIssueForRunAction(context),
          },
          {
            id: "clear_retry_for_issue",
            execute: (context) => this.clearRetryForIssueAction(context),
          },
          {
            id: "start_agent_run_monitor",
            execute: (context) => this.startAgentRunMonitorAction(context),
          },
        ],
      },
      {
        kind: "dispatch_planner",
        actions: [
          {
            id: "load_issue_breakdown_dispatch_context",
            execute: (context) => this.loadDispatchContextAction(context),
          },
          {
            id: "record_agent_dispatch_started",
            execute: (context) =>
              this.recordAgentDispatchStartedAction(context),
          },
          {
            id: "create_running_entry",
            execute: (context) => this.createRunningEntryAction(context),
          },
          {
            id: "claim_issue_for_run",
            execute: (context) => this.claimIssueForRunAction(context),
          },
          {
            id: "clear_retry_for_issue",
            execute: (context) => this.clearRetryForIssueAction(context),
          },
          {
            id: "start_agent_run_monitor",
            execute: (context) => this.startAgentRunMonitorAction(context),
          },
        ],
      },
      {
        kind: "dispatch_reviewer",
        actions: [
          {
            id: "load_reviewer_dispatch_evidence",
            execute: (context) =>
              this.loadReviewerDispatchEvidenceAction(context),
          },
          {
            id: "record_agent_dispatch_started",
            execute: (context) =>
              this.recordAgentDispatchStartedAction(context),
          },
          {
            id: "create_running_entry",
            execute: (context) => this.createRunningEntryAction(context),
          },
          {
            id: "claim_issue_for_run",
            execute: (context) => this.claimIssueForRunAction(context),
          },
          {
            id: "clear_retry_for_issue",
            execute: (context) => this.clearRetryForIssueAction(context),
          },
          {
            id: "start_agent_run_monitor",
            execute: (context) => this.startAgentRunMonitorAction(context),
          },
        ],
      },
      {
        kind: "dispatch_triage",
        actions: [
          {
            id: "load_issue_triage_dispatch_context",
            execute: (context) => this.loadDispatchContextAction(context),
          },
          {
            id: "record_agent_dispatch_started",
            execute: (context) =>
              this.recordAgentDispatchStartedAction(context),
          },
          {
            id: "create_running_entry",
            execute: (context) => this.createRunningEntryAction(context),
          },
          {
            id: "claim_issue_for_run",
            execute: (context) => this.claimIssueForRunAction(context),
          },
          {
            id: "clear_retry_for_issue",
            execute: (context) => this.clearRetryForIssueAction(context),
          },
          {
            id: "start_agent_run_monitor",
            execute: (context) => this.startAgentRunMonitorAction(context),
          },
        ],
      },
      {
        kind: "dispatch_post_mortem",
        actions: [
          {
            id: "load_post_mortem_dispatch_context",
            execute: (context) => this.loadDispatchContextAction(context),
          },
          {
            id: "record_agent_dispatch_started",
            execute: (context) =>
              this.recordAgentDispatchStartedAction(context),
          },
          {
            id: "create_running_entry",
            execute: (context) => this.createRunningEntryAction(context),
          },
          {
            id: "claim_issue_for_run",
            execute: (context) => this.claimIssueForRunAction(context),
          },
          {
            id: "clear_retry_for_issue",
            execute: (context) => this.clearRetryForIssueAction(context),
          },
          {
            id: "start_agent_run_monitor",
            execute: (context) => this.startAgentRunMonitorAction(context),
          },
        ],
      },
      ...this.createMergePolicyTransitions(),
      {
        kind: "reconcile_issue_triage_report_writeback",
        actions: [
          {
            id: "load_issue_triage_report_writeback",
            execute: (context) =>
              this.loadIssueTriageReportWritebackAction(context),
          },
          {
            id: "plan_issue_triage_report_writebacks",
            execute: (context) =>
              this.planIssueTriageReportWritebacksAction(context),
          },
          {
            id: "apply_issue_triage_report_writebacks",
            execute: (context) =>
              this.applyReportWritebacksAction(
                context,
                "issue triage report writeback reconciliation",
              ),
          },
          {
            id: "mark_issue_triage_report_writeback_recorded",
            execute: (context) =>
              this.markIssueTriageReportWritebackRecordedAction(context),
          },
        ],
      },
      {
        kind: "reconcile_post_mortem_report_writeback",
        actions: [
          {
            id: "load_post_mortem_report_writeback",
            execute: (context) =>
              this.loadPostMortemReportWritebackAction(context),
          },
          {
            id: "plan_post_mortem_report_writebacks",
            execute: (context) =>
              this.planPostMortemReportWritebacksAction(context),
          },
          {
            id: "apply_post_mortem_report_writebacks",
            execute: (context) =>
              this.applyReportWritebacksAction(
                context,
                "issue post-mortem report writeback reconciliation",
              ),
          },
          {
            id: "mark_post_mortem_report_writeback_recorded",
            execute: (context) =>
              this.markPostMortemReportWritebackRecordedAction(context),
          },
        ],
      },
      {
        kind: "reconcile_completion_report_handoff",
        actions: [
          {
            id: "load_completion_report_handoff",
            execute: (context) =>
              this.loadCompletionReportHandoffAction(context),
          },
          {
            id: "mark_completion_report_handoff_accepted",
            execute: (context) =>
              this.markCompletionReportHandoffAcceptedAction(context),
          },
          {
            id: "process_completion_report_handoff_writebacks",
            execute: (context) =>
              this.processCompletionReportHandoffWritebacksAction(context),
          },
        ],
      },
      {
        kind: "reconcile_completion_report_rejection",
        actions: [
          {
            id: "load_completion_report_rejection",
            execute: (context) =>
              this.loadCompletionReportRejectionAction(context),
          },
          {
            id: "mark_completion_report_rejected",
            execute: (context) =>
              this.markCompletionReportRejectedAction(context),
          },
          {
            id: "process_completion_report_rejection_writebacks",
            execute: (context) =>
              this.processCompletionReportRejectionWritebacksAction(context),
          },
        ],
      },
      {
        kind: "reconcile_merge_conflict_resolution_handoff",
        actions: [
          {
            id: "load_merge_conflict_resolution_handoff",
            execute: (context) =>
              this.loadMergeConflictResolutionHandoffAction(context),
          },
          {
            id: "mark_merge_conflict_resolution_handoff_accepted",
            execute: (context) =>
              this.markMergeConflictResolutionHandoffAcceptedAction(context),
          },
          {
            id: "process_merge_conflict_resolution_writebacks",
            execute: (context) =>
              this.processMergeConflictResolutionWritebacksAction(context),
          },
        ],
      },
      {
        kind: "reconcile_issue_breakdown_plan_handoff",
        actions: [
          {
            id: "load_issue_breakdown_plan_handoff",
            execute: (context) =>
              this.loadIssueBreakdownPlanHandoffAction(context),
          },
          {
            id: "mark_issue_breakdown_plan_handoff_accepted",
            execute: (context) =>
              this.markIssueBreakdownPlanHandoffAcceptedAction(context),
          },
        ],
      },
      {
        kind: "reconcile_issue_triage_report_handoff",
        actions: [
          {
            id: "load_issue_triage_report_handoff",
            execute: (context) =>
              this.loadIssueTriageReportHandoffAction(context),
          },
          {
            id: "mark_issue_triage_report_handoff_accepted",
            execute: (context) =>
              this.markIssueTriageReportHandoffAcceptedAction(context),
          },
          {
            id: "process_issue_triage_report_handoff_writebacks",
            execute: (context) =>
              this.processIssueTriageReportHandoffWritebacksAction(context),
          },
        ],
      },
      {
        kind: "reconcile_issue_post_mortem_handoff",
        actions: [
          {
            id: "load_issue_post_mortem_handoff",
            execute: (context) =>
              this.loadIssuePostMortemHandoffAction(context),
          },
          {
            id: "mark_issue_post_mortem_handoff_accepted",
            execute: (context) =>
              this.markIssuePostMortemHandoffAcceptedAction(context),
          },
          {
            id: "process_issue_post_mortem_handoff_writebacks",
            execute: (context) =>
              this.processIssuePostMortemHandoffWritebacksAction(context),
          },
        ],
      },
      {
        kind: "reconcile_review_verdict_handoff",
        actions: [
          {
            id: "load_review_verdict_handoff",
            execute: (context) => this.loadReviewVerdictHandoffAction(context),
          },
          {
            id: "mark_review_verdict_handoff_accepted",
            execute: (context) =>
              this.markReviewVerdictHandoffAcceptedAction(context),
          },
          {
            id: "process_review_verdict_handoff_writebacks",
            execute: (context) =>
              this.processReviewVerdictHandoffWritebacksAction(context),
          },
          {
            id: "release_merge_queue_after_failed_review_verdict",
            shouldExecute: (context) =>
              context.handoffReconciliation.reviewVerdict?.verdict !== "pass",
            execute: (context) =>
              this.releaseMergeQueueAction(
                context,
                "review_verdict_failed",
              ),
          },
          {
            id: "request_merge_policy_after_pass_verdict",
            execute: (context) =>
              this.requestMergePolicyAfterPassVerdictAction(context),
          },
        ],
      },
      {
        kind: "reset_lifecycle_after_operator_resume",
        actions: [
          {
            id: "update_lifecycle_after_operator_resume",
            execute: (context) =>
              this.updateLifecycleAfterOperatorResumeAction(context),
          },
        ],
      },
      {
        kind: "reset_merge_conflict_after_operator_resume",
        actions: [
          {
            id: "update_merge_conflict_after_operator_resume",
            execute: (context) =>
              this.updateMergeConflictAfterOperatorResumeAction(context),
          },
        ],
      },
      {
        kind: "block_merge_conflict_attempt_limit",
        actions: [
          {
            id: "update_merge_conflict_blocked",
            execute: (context) =>
              this.updateMergeConflictBlockedAction(context),
          },
          {
            id: "apply_merge_conflict_blocked_writebacks",
            execute: (context) =>
              this.applyMergeConflictBlockedWritebacksAction(context),
          },
          {
            id: "record_merge_conflict_block",
            execute: (context) => this.recordMergeConflictBlockAction(context),
          },
        ],
      },
      {
        kind: "recover_merge_gate_head_supersession",
        actions: [
          {
            id: "plan_head_supersession_recovery_writebacks",
            execute: (context) =>
              this.planHeadSupersessionRecoveryWritebacksAction(context),
          },
          {
            id: "apply_head_supersession_recovery_writebacks",
            execute: (context) =>
              this.applyHeadSupersessionRecoveryWritebacksAction(context),
          },
          {
            id: "update_lifecycle_head_supersession_recovered",
            execute: (context) =>
              this.updateLifecycleHeadSupersessionRecoveredAction(context),
          },
        ],
      },
      {
        kind: "rebound_issue_triage_blocked",
        actions: [
          {
            id: "plan_issue_triage_rebound_writeback",
            execute: (context) =>
              this.planIssueTriageReboundWritebackAction(context),
          },
          {
            id: "apply_issue_triage_rebound_writeback",
            execute: (context) =>
              this.applyIssueTriageReboundWritebackAction(context),
          },
          {
            id: "update_lifecycle_issue_triage_rebound",
            execute: (context) =>
              this.updateLifecycleIssueTriageReboundAction(context),
          },
        ],
      },
      {
        kind: "recover_publication_approval",
        actions: [
          {
            id: "verify_publication_approval_recovery_config",
            execute: (context) =>
              this.verifyPublicationApprovalRecoveryConfigAction(context),
          },
          {
            id: "load_recoverable_publication_approval_lifecycle",
            execute: (context) =>
              this.loadRecoverablePublicationApprovalLifecycleAction(context),
          },
          {
            id: "record_publication_approval_recovery_started",
            execute: (context) =>
              this.recordPublicationApprovalRecoveryStartedAction(context),
          },
          {
            id: "recover_publication_approval_handoff",
            execute: (context) =>
              this.recoverPublicationApprovalHandoffAction(context),
          },
          {
            id: "record_publication_approval_recovery_finished",
            execute: (context) =>
              this.recordPublicationApprovalRecoveryFinishedAction(context),
          },
        ],
      },
      {
        kind: "terminate_running",
        actions: [
          {
            id: "mark_running_cancellation_requested",
            execute: (context) =>
              this.markRunningCancellationRequestedAction(context),
          },
          {
            id: "abort_running_agent",
            execute: (context) => this.abortRunningAgentAction(context),
          },
          {
            id: "mark_workspace_cleanup_on_exit",
            execute: (context) =>
              this.markWorkspaceCleanupOnExitAction(context),
          },
          {
            id: "record_running_termination",
            execute: (context) => this.recordRunningTerminationAction(context),
          },
        ],
      },
      {
        kind: "block_issue",
        actions: [
          {
            id: "load_block_issue_lifecycle",
            execute: (context) => this.loadBlockIssueLifecycleAction(context),
          },
          {
            id: "update_lifecycle_blocked",
            execute: (context) => this.updateLifecycleBlockedAction(context),
          },
          {
            id: "apply_blocked_escalation_writebacks",
            execute: (context) =>
              this.applyBlockedEscalationWritebacksAction(context),
          },
          {
            id: "record_block_issue",
            execute: (context) => this.recordBlockIssueAction(context),
          },
        ],
      },
      {
        kind: "retry_run",
        actions: [
          {
            id: "schedule_retry_timer",
            execute: (context) => this.scheduleRetryTimerAction(context),
          },
          {
            id: "record_retry_scheduled",
            execute: (context) => this.recordRetryScheduledAction(context),
          },
        ],
      },
      {
        kind: "handoff_repair",
        actions: [
          {
            id: "load_handoff_repair_context",
            execute: (context) => this.loadHandoffRepairContextAction(context),
          },
          {
            id: "dispatch_handoff_repair",
            execute: (context) => this.dispatchHandoffRepairAction(context),
          },
          {
            id: "render_handoff_repair_prompt",
            execute: (context) => this.renderHandoffRepairPromptAction(context),
          },
          {
            id: "record_handoff_repair_dispatched_event",
            execute: (context) =>
              this.recordHandoffRepairDispatchedEventAction(context),
          },
          {
            id: "prepare_handoff_repair_harness",
            execute: (context) =>
              this.prepareHandoffRepairHarnessAction(context),
          },
          {
            id: "reload_handoff_repair_harness",
            execute: (context) =>
              this.reloadHandoffRepairHarnessAction(context),
          },
          {
            id: "run_handoff_repair_agent",
            execute: (context) => this.runHandoffRepairAgentAction(context),
          },
          {
            id: "reconcile_handoff_repair_result",
            execute: (context) =>
              this.reconcileHandoffRepairResultAction(context),
          },
        ],
      },
      { kind: "noop", actions: [] },
    ];
  }

  private async planWorkerDispatchWritebackAction(
    context: OrchestratorTransitionContext,
  ) {
    if (context.transition.runPhase !== "implementation") {
      context.dispatch.dispatchWriteback = null;
      return {
        status: "skipped" as const,
        message: "Dispatch writeback is only used for implementation workers",
      };
    }
    if (
      context.transition.manualDispatch === true &&
      context.transition.manualIgnoreState === true
    ) {
      context.dispatch.dispatchWriteback = null;
      return {
        status: "skipped" as const,
        message: "Manual ignore-state dispatch skips dispatch writeback",
      };
    }
    const operation = planDispatchWriteback(context.issue, this.config);
    context.dispatch.dispatchWriteback = operation;
    if (operation === null)
      return {
        status: "skipped" as const,
        message: "No dispatch writeback is required",
      };
    return {
      details: {
        idempotencyKey: operation.idempotencyKey,
        kind: operation.kind,
      },
    };
  }

  private async applyWorkerDispatchWritebackAction(
    context: OrchestratorTransitionContext,
  ) {
    const operation = context.dispatch.dispatchWriteback;
    if (!operation)
      return {
        status: "skipped" as const,
        message: "No dispatch writeback was planned",
      };
    const applied = await this.applyWriteback(
      operation,
      "dispatch",
      context.issue,
    );
    return applied
      ? {
          details: {
            idempotencyKey: operation.idempotencyKey,
            kind: operation.kind,
          },
        }
      : {
          status: "skipped" as const,
          stop: true,
          message: "Dispatch writeback did not complete successfully",
          details: {
            idempotencyKey: operation.idempotencyKey,
            kind: operation.kind,
          },
        };
  }

  private async verifyWorkerDispatchWritebackStateAction(
    context: OrchestratorTransitionContext,
  ) {
    if (!context.dispatch.dispatchWriteback) {
      context.dispatch.issue = context.issue;
      return {
        status: "skipped" as const,
        message: "No dispatch writeback state refresh is required",
      };
    }
    const refreshed = await this.options.tracker.fetchIssueStatesByIds([
      context.issue.id,
    ]);
    const latest = refreshed[0] ?? null;
    if (!latest) {
      return {
        status: "skipped" as const,
        stop: true,
        message: "Issue disappeared after dispatch writeback",
      };
    }
    context.dispatch.issue = latest;
    return {
      details: {
        trackerState: latest.state,
        labels: latest.labels,
        assignedToWorker: latest.assignedToWorker,
      },
    };
  }

  private async loadDispatchContextAction(
    context: OrchestratorTransitionContext,
  ) {
    context.dispatch.issue ??= context.issue;
    return {
      details: {
        issueId: context.dispatch.issue.id,
        issueIdentifier: context.dispatch.issue.identifier,
        role: context.transition.role,
        runPhase: context.transition.runPhase,
      },
    };
  }

  private async loadReviewerDispatchEvidenceAction(
    context: OrchestratorTransitionContext,
  ) {
    context.dispatch.issue ??= context.issue;
    const evidence = await this.loadReviewerDispatchEvidence(
      context.dispatch.issue,
    );
    if (!evidence) {
      return {
        status: "skipped" as const,
        stop: true,
        message:
          "No accepted completion report evidence is available for reviewer dispatch",
      };
    }
    context.dispatch.reviewEvidence = evidence;
    return {
      details: {
        completionReportId: evidence.completionReport.id,
        workerRunId: evidence.workerRun?.runId ?? null,
      },
    };
  }

  private async recordAgentDispatchStartedAction(
    context: OrchestratorTransitionContext,
  ) {
    return {
      details: {
        role: context.transition.role ?? null,
        runPhase: context.transition.runPhase ?? null,
        runKind: context.transition.runKind ?? null,
        attempt: context.attempt,
        rulesetId: context.transition.rulesetId,
      },
    };
  }

  private async createRunningEntryAction(
    context: OrchestratorTransitionContext,
  ) {
    const role = agentRunRoleFromUnknown(context.transition.role);
    const runPhase = agentRunPhaseFromUnknown(context.transition.runPhase);
    if (role === null || runPhase === null) {
      return {
        status: "skipped" as const,
        stop: true,
        message: "Dispatch transition is missing role or run phase",
      };
    }
    const issue = context.dispatch.issue ?? context.issue;
    const manualDispatch =
      context.transition.manualDispatch === true &&
      isManualAgentRunStage(context.transition.manualStage)
        ? {
            stage: context.transition.manualStage,
            forceLabels: context.transition.manualForceLabels === true,
            ignoreState: context.transition.manualIgnoreState === true,
          }
        : null;
    const entry = this.createRunningEntry(
      issue,
      context.attempt,
      role,
      context.dispatch.reviewEvidence ?? null,
      runPhase,
      manualDispatch,
      context.transition.historySnapshotId,
    );
    context.dispatch.entry = entry;
    this.running.set(issue.id, entry);
    await this.recordRuntimeControlEvidenceSnapshot({
      issue,
      eventType: "running_entry_created",
      sourceId: entry.activeRunId ?? entry.runId ?? issue.id,
      reason: "running_entry_created",
      entry,
    });
    return {
      details: {
        role,
        runPhase,
        issueId: issue.id,
        issueIdentifier: issue.identifier,
      },
    };
  }

  private async claimIssueForRunAction(context: OrchestratorTransitionContext) {
    const entry = context.dispatch.entry;
    if (!entry)
      return {
        status: "skipped" as const,
        stop: true,
        message: "No running entry was created",
      };
    this.claimed.add(entry.issue.id);
    await this.recordRuntimeControlEvidenceSnapshot({
      issue: entry.issue,
      eventType: "claim_acquired",
      sourceId: entry.activeRunId ?? entry.runId ?? entry.issue.id,
      reason: "claim_acquired",
      entry,
      claimed: true,
    });
    return {
      details: {
        issueId: entry.issue.id,
        issueIdentifier: entry.issue.identifier,
      },
    };
  }

  private async clearRetryForIssueAction(
    context: OrchestratorTransitionContext,
  ) {
    const entry = context.dispatch.entry;
    if (!entry)
      return {
        status: "skipped" as const,
        stop: true,
        message: "No running entry was created",
      };
    await this.clearIssueRetry(
      entry.issue,
      "dispatch_cleared_retry",
      entry.activeRunId ?? entry.runId ?? entry.issue.id,
    );
    return { details: { issueId: entry.issue.id } };
  }

  private async startAgentRunMonitorAction(
    context: OrchestratorTransitionContext,
  ) {
    const entry = context.dispatch.entry;
    if (!entry)
      return {
        status: "skipped" as const,
        stop: true,
        message: "No running entry was created",
      };
    this.startRunMonitor(entry, context.attempt);
    return {
      details: {
        role: entry.role,
        runPhase: entry.runPhase,
        issueId: entry.issue.id,
        issueIdentifier: entry.issue.identifier,
      },
    };
  }

  private async loadIssueTriageReportWritebackAction(
    context: OrchestratorTransitionContext,
  ) {
    const lifecycle =
      (await this.options.lifecycleStore?.get(context.issue.id)) ?? null;
    if (!lifecycle || lifecycle.phase !== "blocked") {
      return {
        status: "skipped" as const,
        stop: true,
        message: "No blocked lifecycle exists for issue triage writeback",
      };
    }
    const report = latestIssueTriageReportForFingerprint(
      lifecycle,
      issueTriageTriggerFingerprint(lifecycle),
    );
    if (!report || report.writebackOperationKeys.length > 0) {
      return {
        status: "skipped" as const,
        stop: true,
        message: "No issue triage report needs writeback reconciliation",
      };
    }
    context.reportWriteback.lifecycle = lifecycle;
    context.reportWriteback.issueTriageReport = report;
    return {
      details: {
        reportId: report.id,
        triggerFingerprint: report.triggerFingerprint,
      },
    };
  }

  private async planIssueTriageReportWritebacksAction(
    context: OrchestratorTransitionContext,
  ) {
    const lifecycle = context.reportWriteback.lifecycle;
    const report = context.reportWriteback.issueTriageReport;
    if (!lifecycle || !report)
      return {
        status: "skipped" as const,
        stop: true,
        message: "Issue triage report was not loaded",
      };
    const operations = planIssueTriageReportWritebacks(
      {
        issue: context.issue,
        report,
        blockedReason:
          lifecycle.blockedReason ??
          lifecycle.mergeConflict?.blockedReason ??
          null,
      },
      this.config,
    );
    if (operations.length === 0)
      return {
        status: "skipped" as const,
        stop: true,
        message: "No issue triage writebacks were planned",
      };
    context.reportWriteback.operations = operations;
    context.reportWriteback.operationKeys = operations.map(
      (operation) => operation.idempotencyKey,
    );
    return {
      details: {
        reportId: report.id,
        operationKeys: context.reportWriteback.operationKeys,
      },
    };
  }

  private async loadPostMortemReportWritebackAction(
    context: OrchestratorTransitionContext,
  ) {
    const lifecycle = await this.options.lifecycleStore?.get(context.issue.id);
    if (!lifecycle)
      return {
        status: "skipped" as const,
        stop: true,
        message: "No lifecycle exists for post-mortem writeback",
      };
    const report = latestIssuePostMortemReportForFingerprint(
      lifecycle,
      issuePostMortemTriggerFingerprint(lifecycle, context.issue),
    );
    if (!report || report.writebackOperationKeys.length > 0) {
      return {
        status: "skipped" as const,
        stop: true,
        message: "No post-mortem report needs writeback reconciliation",
      };
    }
    context.reportWriteback.lifecycle = lifecycle;
    context.reportWriteback.postMortemReport = report;
    return {
      details: {
        reportId: report.id,
        triggerFingerprint: report.triggerFingerprint,
      },
    };
  }

  private async planPostMortemReportWritebacksAction(
    context: OrchestratorTransitionContext,
  ) {
    const report = context.reportWriteback.postMortemReport;
    if (!report)
      return {
        status: "skipped" as const,
        stop: true,
        message: "Post-mortem report was not loaded",
      };
    const operations = planIssuePostMortemReportWritebacks(
      { issue: context.issue, report },
      this.config,
    );
    if (operations.length === 0)
      return {
        status: "skipped" as const,
        stop: true,
        message: "No post-mortem writebacks were planned",
      };
    context.reportWriteback.operations = operations;
    context.reportWriteback.operationKeys = operations.map(
      (operation) => operation.idempotencyKey,
    );
    return {
      details: {
        reportId: report.id,
        operationKeys: context.reportWriteback.operationKeys,
      },
    };
  }

  private async applyReportWritebacksAction(
    context: OrchestratorTransitionContext,
    reason: string,
  ) {
    const operations = context.reportWriteback.operations ?? [];
    if (operations.length === 0)
      return {
        status: "skipped" as const,
        stop: true,
        message: "No report writebacks were planned",
      };
    const applied = await this.applyWritebacks(
      operations,
      reason,
      context.issue,
    );
    return applied
      ? {
          details: {
            operationKeys: context.reportWriteback.operationKeys ?? [],
          },
        }
      : {
          status: "skipped" as const,
          message:
            "One or more report writebacks did not complete successfully",
          details: {
            operationKeys: context.reportWriteback.operationKeys ?? [],
          },
        };
  }

  private async markIssueTriageReportWritebackRecordedAction(
    context: OrchestratorTransitionContext,
  ) {
    const lifecycle =
      (await this.options.lifecycleStore?.get(context.issue.id)) ??
      context.reportWriteback.lifecycle;
    const report = context.reportWriteback.issueTriageReport;
    const operationKeys = context.reportWriteback.operationKeys ?? [];
    if (!lifecycle || !report)
      return {
        status: "skipped" as const,
        stop: true,
        message: "Issue triage writeback state is missing",
      };
    await this.updateIssueLifecycleWithEvidence(
      context.issue,
      {
        lastIssueTriageReportId: lifecycle.lastIssueTriageReportId ?? report.id,
        issueTriageReports: lifecycle.issueTriageReports.map((candidate) =>
          candidate.id === report.id
            ? { ...candidate, writebackOperationKeys: operationKeys }
            : candidate,
        ),
      },
      "issue_triage_report_writeback_reconciliation",
      report.runId,
    );
    return { details: { reportId: report.id, operationKeys } };
  }

  private async markPostMortemReportWritebackRecordedAction(
    context: OrchestratorTransitionContext,
  ) {
    const lifecycle =
      (await this.options.lifecycleStore?.get(context.issue.id)) ??
      context.reportWriteback.lifecycle;
    const report = context.reportWriteback.postMortemReport;
    const operationKeys = context.reportWriteback.operationKeys ?? [];
    if (!lifecycle || !report)
      return {
        status: "skipped" as const,
        stop: true,
        message: "Post-mortem writeback state is missing",
      };
    await this.updateIssueLifecycleWithEvidence(
      context.issue,
      {
        lastPostMortemReportId: lifecycle.lastPostMortemReportId ?? report.id,
        postMortemReports: lifecycle.postMortemReports.map((candidate) =>
          candidate.id === report.id
            ? { ...candidate, writebackOperationKeys: operationKeys }
            : candidate,
        ),
      },
      "post_mortem_report_writeback_reconciliation",
      report.runId,
    );
    return { details: { reportId: report.id, operationKeys } };
  }

  private async loadCompletionReportHandoffAction(
    context: OrchestratorTransitionContext,
  ) {
    const loaded = await this.loadHandoffReconciliationEntry(context);
    if (!loaded)
      return {
        status: "skipped" as const,
        stop: true,
        message:
          "No active entry exists for completion report handoff reconciliation",
      };
    const lifecycle = await this.options.lifecycleStore?.get(context.issue.id);
    const report =
      lifecycle?.completionReports.find(
        (item) => item.runId === loaded.runId,
      ) ?? null;
    if (!lifecycle || !report)
      return {
        status: "skipped" as const,
        stop: true,
        message: "No completion report exists for run",
      };
    if (
      !isFinalizedCompletionReport(report) &&
      !pendingPublicationHandoffForRun(lifecycle, { runId: loaded.runId })
    ) {
      if (lifecycle.phase !== "review" || lifecycle.blockedReason !== null) {
        return {
          status: "skipped" as const,
          stop: true,
          message: "Completion report is not finalized or pending publication",
        };
      }
    }
    context.handoffReconciliation.lifecycle = lifecycle;
    context.handoffReconciliation.completionReport = report;
    return {
      details: {
        reportId: report.id,
        runId: loaded.runId,
        finalized: isFinalizedCompletionReport(report),
      },
    };
  }

  private async markCompletionReportHandoffAcceptedAction(
    context: OrchestratorTransitionContext,
  ) {
    const entry = context.handoffReconciliation.entry;
    const lifecycle = context.handoffReconciliation.lifecycle;
    const report = context.handoffReconciliation.completionReport;
    if (!entry || !lifecycle || !report)
      return {
        status: "skipped" as const,
        stop: true,
        message: "Completion report handoff was not loaded",
      };
    entry.lifecycle = lifecycle;
    entry.completionReportAccepted = true;
    return {
      message: isFinalizedCompletionReport(report)
        ? "Completion report accepted"
        : "Completion report accepted pending publication",
      details: {
        reportId: report.id,
        runId: context.handoffReconciliation.runId ?? report.runId,
        finalized: isFinalizedCompletionReport(report),
      },
    };
  }

  private async processCompletionReportHandoffWritebacksAction(
    context: OrchestratorTransitionContext,
  ) {
    const entry = context.handoffReconciliation.entry;
    const report = context.handoffReconciliation.completionReport;
    if (!entry || !report)
      return {
        status: "skipped" as const,
        stop: true,
        message: "Completion report handoff was not loaded",
      };
    if (!isFinalizedCompletionReport(report))
      return {
        status: "skipped" as const,
        message: "Completion report is pending publication",
      };
    await this.processDueWritebacksForHandoff(
      entry,
      "completion report accepted",
      { reportId: report.id },
    );
    return {
      details: {
        reportId: report.id,
        runId: context.handoffReconciliation.runId ?? report.runId,
      },
    };
  }

  private async loadCompletionReportRejectionAction(
    context: OrchestratorTransitionContext,
  ) {
    const loaded = await this.loadHandoffReconciliationEntry(context);
    if (!loaded)
      return {
        status: "skipped" as const,
        stop: true,
        message:
          "No active entry exists for completion report rejection reconciliation",
      };
    const lifecycle = await this.options.lifecycleStore?.get(context.issue.id);
    const rejection =
      lifecycle?.completionReportRejections.find(
        (item) => item.runId === loaded.runId,
      ) ?? null;
    if (!lifecycle || !rejection)
      return {
        status: "skipped" as const,
        stop: true,
        message: "No completion report rejection exists for run",
      };
    context.handoffReconciliation.lifecycle = lifecycle;
    context.handoffReconciliation.completionReportRejection = rejection;
    return {
      details: {
        rejectionId: rejection.id,
        reportId: rejection.reportId,
        runId: loaded.runId,
        unsatisfiedChecklistItems: rejection.acceptanceChecklist
          .filter((item) => !item.satisfied)
          .map((item) => item.text),
      },
    };
  }

  private async markCompletionReportRejectedAction(
    context: OrchestratorTransitionContext,
  ) {
    const entry = context.handoffReconciliation.entry;
    const lifecycle = context.handoffReconciliation.lifecycle;
    const rejection = context.handoffReconciliation.completionReportRejection;
    if (!entry || !lifecycle || !rejection)
      return {
        status: "skipped" as const,
        stop: true,
        message: "Completion report rejection was not loaded",
      };
    entry.lifecycle = lifecycle;
    return {
      message: rejection.reason,
      details: {
        rejectionId: rejection.id,
        reportId: rejection.reportId,
        runId: context.handoffReconciliation.runId ?? rejection.runId,
        unsatisfiedChecklistItems: rejection.acceptanceChecklist
          .filter((item) => !item.satisfied)
          .map((item) => item.text),
      },
    };
  }

  private async processCompletionReportRejectionWritebacksAction(
    context: OrchestratorTransitionContext,
  ) {
    const entry = context.handoffReconciliation.entry;
    const rejection = context.handoffReconciliation.completionReportRejection;
    if (!entry || !rejection)
      return {
        status: "skipped" as const,
        stop: true,
        message: "Completion report rejection was not loaded",
      };
    await this.processDueWritebacksForHandoff(
      entry,
      "completion report rejected",
      { rejectionId: rejection.id },
    );
    return {
      details: {
        rejectionId: rejection.id,
        runId: context.handoffReconciliation.runId ?? rejection.runId,
      },
    };
  }

  private async loadMergeConflictResolutionHandoffAction(
    context: OrchestratorTransitionContext,
  ) {
    const loaded = await this.loadHandoffReconciliationEntry(context);
    if (!loaded)
      return {
        status: "skipped" as const,
        stop: true,
        message:
          "No active entry exists for merge conflict handoff reconciliation",
      };
    const lifecycle = await this.options.lifecycleStore?.get(context.issue.id);
    const report =
      lifecycle?.mergeConflictResolutionReports.find(
        (item) => item.runId === loaded.runId,
      ) ?? null;
    if (!lifecycle || !report)
      return {
        status: "skipped" as const,
        stop: true,
        message: "No merge conflict resolution report exists for run",
      };
    context.handoffReconciliation.lifecycle = lifecycle;
    context.handoffReconciliation.mergeConflictResolutionReport = report;
    return {
      details: {
        reportId: report.id,
        runId: loaded.runId,
        resolutionStatus: report.resolutionStatus,
      },
    };
  }

  private async markMergeConflictResolutionHandoffAcceptedAction(
    context: OrchestratorTransitionContext,
  ) {
    const entry = context.handoffReconciliation.entry;
    const lifecycle = context.handoffReconciliation.lifecycle;
    const report = context.handoffReconciliation.mergeConflictResolutionReport;
    if (!entry || !lifecycle || !report)
      return {
        status: "skipped" as const,
        stop: true,
        message: "Merge conflict handoff was not loaded",
      };
    entry.lifecycle = lifecycle;
    entry.mergeConflictResolutionAccepted = true;
    return {
      details: {
        reportId: report.id,
        runId: context.handoffReconciliation.runId ?? report.runId,
        resolutionStatus: report.resolutionStatus,
      },
    };
  }

  private async processMergeConflictResolutionWritebacksAction(
    context: OrchestratorTransitionContext,
  ) {
    const entry = context.handoffReconciliation.entry;
    const report = context.handoffReconciliation.mergeConflictResolutionReport;
    if (!entry || !report)
      return {
        status: "skipped" as const,
        stop: true,
        message: "Merge conflict handoff was not loaded",
      };
    await this.processDueWritebacksForHandoff(
      entry,
      "merge conflict resolution accepted",
      { reportId: report.id },
    );
    return {
      details: {
        reportId: report.id,
        runId: context.handoffReconciliation.runId ?? report.runId,
      },
    };
  }

  private async loadIssueBreakdownPlanHandoffAction(
    context: OrchestratorTransitionContext,
  ) {
    const loaded = await this.loadHandoffReconciliationEntry(context);
    if (!loaded)
      return {
        status: "skipped" as const,
        stop: true,
        message:
          "No active entry exists for issue breakdown handoff reconciliation",
      };
    const lifecycle = await this.options.lifecycleStore?.get(context.issue.id);
    const plan =
      lifecycle?.issueBreakdownPlans.find(
        (item) => item.runId === loaded.runId,
      ) ?? null;
    if (!lifecycle || !plan)
      return {
        status: "skipped" as const,
        stop: true,
        message: "No issue breakdown plan exists for run",
      };
    context.handoffReconciliation.lifecycle = lifecycle;
    context.handoffReconciliation.issueBreakdownPlan = plan;
    return { details: { planId: plan.id, runId: loaded.runId } };
  }

  private async markIssueBreakdownPlanHandoffAcceptedAction(
    context: OrchestratorTransitionContext,
  ) {
    const entry = context.handoffReconciliation.entry;
    const lifecycle = context.handoffReconciliation.lifecycle;
    const plan = context.handoffReconciliation.issueBreakdownPlan;
    if (!entry || !lifecycle || !plan)
      return {
        status: "skipped" as const,
        stop: true,
        message: "Issue breakdown handoff was not loaded",
      };
    entry.lifecycle = lifecycle;
    entry.issueBreakdownPlanAccepted = true;
    return {
      details: {
        planId: plan.id,
        runId: context.handoffReconciliation.runId ?? plan.runId,
      },
    };
  }

  private async loadIssueTriageReportHandoffAction(
    context: OrchestratorTransitionContext,
  ) {
    const loaded = await this.loadHandoffReconciliationEntry(context);
    if (!loaded)
      return {
        status: "skipped" as const,
        stop: true,
        message:
          "No active entry exists for issue triage handoff reconciliation",
      };
    const lifecycle = await this.options.lifecycleStore?.get(context.issue.id);
    const report =
      lifecycle?.issueTriageReports.find(
        (item) => item.runId === loaded.runId,
      ) ?? null;
    if (!lifecycle || !report)
      return {
        status: "skipped" as const,
        stop: true,
        message: "No issue triage report exists for run",
      };
    context.handoffReconciliation.lifecycle = lifecycle;
    context.handoffReconciliation.issueTriageReport = report;
    return { details: { reportId: report.id, runId: loaded.runId } };
  }

  private async markIssueTriageReportHandoffAcceptedAction(
    context: OrchestratorTransitionContext,
  ) {
    const entry = context.handoffReconciliation.entry;
    const lifecycle = context.handoffReconciliation.lifecycle;
    const report = context.handoffReconciliation.issueTriageReport;
    if (!entry || !lifecycle || !report)
      return {
        status: "skipped" as const,
        stop: true,
        message: "Issue triage handoff was not loaded",
      };
    entry.lifecycle = lifecycle;
    entry.issueTriageReportAccepted = true;
    return {
      details: {
        reportId: report.id,
        runId: context.handoffReconciliation.runId ?? report.runId,
      },
    };
  }

  private async processIssueTriageReportHandoffWritebacksAction(
    context: OrchestratorTransitionContext,
  ) {
    const entry = context.handoffReconciliation.entry;
    const report = context.handoffReconciliation.issueTriageReport;
    if (!entry || !report)
      return {
        status: "skipped" as const,
        stop: true,
        message: "Issue triage handoff was not loaded",
      };
    await this.processDueWritebacksForHandoff(
      entry,
      "issue triage report accepted",
      { reportId: report.id },
    );
    return {
      details: {
        reportId: report.id,
        runId: context.handoffReconciliation.runId ?? report.runId,
      },
    };
  }

  private async loadIssuePostMortemHandoffAction(
    context: OrchestratorTransitionContext,
  ) {
    const loaded = await this.loadHandoffReconciliationEntry(context);
    if (!loaded)
      return {
        status: "skipped" as const,
        stop: true,
        message:
          "No active entry exists for issue post-mortem handoff reconciliation",
      };
    const lifecycle = await this.options.lifecycleStore?.get(context.issue.id);
    const report =
      lifecycle?.postMortemReports.find(
        (item) => item.runId === loaded.runId,
      ) ?? null;
    if (!lifecycle || !report)
      return {
        status: "skipped" as const,
        stop: true,
        message: "No issue post-mortem report exists for run",
      };
    context.handoffReconciliation.lifecycle = lifecycle;
    context.handoffReconciliation.postMortemReport = report;
    return { details: { reportId: report.id, runId: loaded.runId } };
  }

  private async markIssuePostMortemHandoffAcceptedAction(
    context: OrchestratorTransitionContext,
  ) {
    const entry = context.handoffReconciliation.entry;
    const lifecycle = context.handoffReconciliation.lifecycle;
    const report = context.handoffReconciliation.postMortemReport;
    if (!entry || !lifecycle || !report)
      return {
        status: "skipped" as const,
        stop: true,
        message: "Issue post-mortem handoff was not loaded",
      };
    entry.lifecycle = lifecycle;
    entry.issuePostMortemReportAccepted = true;
    return {
      details: {
        reportId: report.id,
        runId: context.handoffReconciliation.runId ?? report.runId,
      },
    };
  }

  private async processIssuePostMortemHandoffWritebacksAction(
    context: OrchestratorTransitionContext,
  ) {
    const entry = context.handoffReconciliation.entry;
    const report = context.handoffReconciliation.postMortemReport;
    if (!entry || !report)
      return {
        status: "skipped" as const,
        stop: true,
        message: "Issue post-mortem handoff was not loaded",
      };
    await this.processDueWritebacksForHandoff(
      entry,
      "issue post-mortem report accepted",
      { reportId: report.id },
    );
    return {
      details: {
        reportId: report.id,
        runId: context.handoffReconciliation.runId ?? report.runId,
      },
    };
  }

  private async loadReviewVerdictHandoffAction(
    context: OrchestratorTransitionContext,
  ) {
    const loaded = await this.loadHandoffReconciliationEntry(context);
    if (!loaded)
      return {
        status: "skipped" as const,
        stop: true,
        message:
          "No active entry exists for review verdict handoff reconciliation",
      };
    const lifecycle = await this.options.lifecycleStore?.get(context.issue.id);
    const submission =
      (lifecycle?.reviewVerdictSubmissions ?? []).find(
        (item) => item.runId === loaded.runId && item.status === "pending",
      ) ?? null;
    const verdict =
      lifecycle?.reviewVerdicts.find((item) => item.runId === loaded.runId) ??
      null;
    if (!lifecycle || (!submission && !verdict))
      return {
        status: "skipped" as const,
        stop: true,
        message: "No review verdict exists for run",
      };
    context.handoffReconciliation.lifecycle = lifecycle;
    if (submission) context.handoffReconciliation.reviewVerdictSubmission = submission;
    if (verdict) context.handoffReconciliation.reviewVerdict = verdict;
    return {
      details: {
        verdictId: (submission ?? verdict)?.id,
        runId: loaded.runId,
        verdict: (submission ?? verdict)?.verdict,
        handoffStatus: submission ? "pending" : "applied",
      },
    };
  }

  private async markReviewVerdictHandoffAcceptedAction(
    context: OrchestratorTransitionContext,
  ) {
    const entry = context.handoffReconciliation.entry;
    const lifecycle = context.handoffReconciliation.lifecycle;
    const verdict =
      context.handoffReconciliation.reviewVerdict ??
      context.handoffReconciliation.reviewVerdictSubmission;
    if (!entry || !lifecycle || !verdict)
      return {
        status: "skipped" as const,
        stop: true,
        message: "Review verdict handoff was not loaded",
      };
    entry.lifecycle = lifecycle;
    entry.reviewVerdictAccepted = true;
    return {
      details: {
        verdictId: verdict.id,
        runId: context.handoffReconciliation.runId ?? verdict.runId,
        verdict: verdict.verdict,
      },
    };
  }

  private async processReviewVerdictHandoffWritebacksAction(
    context: OrchestratorTransitionContext,
  ) {
    const entry = context.handoffReconciliation.entry;
    const loadedVerdict = context.handoffReconciliation.reviewVerdict;
    const loadedSubmission = context.handoffReconciliation.reviewVerdictSubmission;
    if (!entry || (!loadedVerdict && !loadedSubmission))
      return {
        status: "skipped" as const,
        stop: true,
        message: "Review verdict handoff was not loaded",
      };
    let verdict = loadedVerdict ?? null;
    let operationKeys: string[] = verdict?.writebackOperationKeys ?? [];
    if (!verdict && loadedSubmission) {
      const lifecycle = await this.options.lifecycleStore?.get(context.issue.id);
      const existingVerdict =
        lifecycle?.reviewVerdicts.find(
          (item) =>
            item.id === loadedSubmission.acceptedVerdictId ||
            item.id === loadedSubmission.id ||
            item.runId === loadedSubmission.runId,
        ) ?? null;
      if (existingVerdict) {
        verdict = existingVerdict;
        operationKeys = existingVerdict.writebackOperationKeys;
      } else {
        const submission =
          (lifecycle?.reviewVerdictSubmissions ?? []).find(
            (item) => item.id === loadedSubmission.id && item.status === "pending",
          ) ?? null;
        if (!lifecycle || !submission)
          return {
            status: "skipped" as const,
            stop: true,
            message: "Pending review verdict submission no longer exists",
          };
        const plan = planReviewVerdictSubmissionApplication({
          config: this.config,
          issue: context.issue,
          lifecycle,
          submission,
        });
        const updatedLifecycle = await this.updateIssueLifecycleWithEvidence(
          context.issue,
          plan.patch,
          "review_verdict",
          submission.runId,
        );
        if (updatedLifecycle) {
          context.handoffReconciliation.lifecycle = updatedLifecycle;
          entry.lifecycle = updatedLifecycle;
          await appendLaneMemoTelemetry(
            this.options.runStore,
            submission.runId,
            updatedLifecycle,
            "review_verdict",
          );
        }
        verdict = plan.verdict;
        operationKeys = plan.operations.map((operation) => operation.idempotencyKey);
        await this.applyWritebacks(
          plan.operations,
          "review verdict accepted",
          context.issue,
        );
      }
      context.handoffReconciliation.reviewVerdict = verdict;
    }
    if (!verdict)
      return {
        status: "skipped" as const,
        stop: true,
        message: "Review verdict handoff was not applied",
      };
    await this.processDueWritebacksForHandoff(
      entry,
      "review verdict accepted",
      { verdictId: verdict.id },
    );
    return {
      details: {
        verdictId: verdict.id,
        runId: context.handoffReconciliation.runId ?? verdict.runId,
        operationKeys,
      },
    };
  }

  private async requestMergePolicyAfterPassVerdictAction(
    context: OrchestratorTransitionContext,
  ) {
    const verdict = context.handoffReconciliation.reviewVerdict;
    if (!verdict)
      return {
        status: "skipped" as const,
        stop: true,
        message: "Review verdict handoff was not loaded",
      };
    if (verdict.verdict !== "pass")
      return {
        status: "skipped" as const,
        message: "Review verdict did not pass",
      };
    await this.processMergePolicyTransitionCandidate(context.issue);
    return { details: { verdictId: verdict.id, verdict: verdict.verdict } };
  }

  private async loadHandoffReconciliationEntry(
    context: OrchestratorTransitionContext,
  ): Promise<{ entry: RunningEntry; runId: string } | null> {
    const runId = nonEmptyString(context.transition.runId);
    if (runId === null) return null;
    const entry = this.running.get(context.issue.id);
    if (!entry) return null;
    context.handoffReconciliation.entry = entry;
    context.handoffReconciliation.runId = runId;
    return { entry, runId };
  }

  private async processDueWritebacksForHandoff(
    entry: RunningEntry,
    eventDescription: string,
    logDetails: Record<string, unknown>,
  ): Promise<void> {
    if (this.options.writeback) {
      await this.options.writeback.processDue();
      return;
    }
    if (this.config.writeback.enabled) {
      this.options.logger.warn(
        `${eventDescription} but writeback processor is not configured`,
        {
          issue_id: entry.issue.id,
          issue_identifier: entry.issue.identifier,
          run_id: entry.activeRunId ?? entry.runId,
          ...logDetails,
        },
      );
    }
  }

  private async updateLifecycleAfterOperatorResumeAction(
    context: OrchestratorTransitionContext,
  ) {
    const lifecycle = await this.options.lifecycleStore?.get(context.issue.id);
    if (!lifecycle)
      return {
        status: "skipped" as const,
        stop: true,
        message: "No lifecycle exists for operator resume reset",
      };
    const reason =
      context.transition.reason === "manual_ignore_state_resume"
        ? "manual_ignore_state_resume"
        : "tracker_state_resume";
    const updated = await this.resetFailureBudgetAfterOperatorAction(
      context.issue,
      lifecycle,
      reason,
    );
    context.lifecycleReset.lifecycle = updated;
    return {
      details: {
        reason,
        previousPhase: lifecycle.phase,
        nextPhase: updated.phase,
        previousBlockedReason: lifecycle.blockedReason,
        nextBlockedReason: updated.blockedReason,
      },
    };
  }

  private async updateMergeConflictAfterOperatorResumeAction(
    context: OrchestratorTransitionContext,
  ) {
    const lifecycle = await this.options.lifecycleStore?.get(context.issue.id);
    if (!lifecycle)
      return {
        status: "skipped" as const,
        stop: true,
        message: "No lifecycle exists for merge conflict resume reset",
      };
    const updated = await this.resetFailureBudgetAfterOperatorAction(
      context.issue,
      lifecycle,
      "merge_conflict_state_resume",
      {
        reopenMergeConflict: true,
      },
    );
    context.lifecycleReset.lifecycle = updated;
    return {
      details: {
        previousConflictFixTurnCount:
          lifecycle.mergeConflict?.fixTurnCount ?? null,
        nextConflictFixTurnCount: updated.mergeConflict?.fixTurnCount ?? null,
        nextConflictStatus: updated.mergeConflict?.status ?? null,
      },
    };
  }

  private async updateMergeConflictBlockedAction(
    context: OrchestratorTransitionContext,
  ) {
    const lifecycle = await this.options.lifecycleStore?.get(context.issue.id);
    const conflict = lifecycle?.mergeConflict ?? null;
    if (!lifecycle || !conflict)
      return {
        status: "skipped" as const,
        stop: true,
        message: "No merge conflict exists to block",
      };
    const runId =
      nonEmptyString(context.transition.runId) ??
      lifecycle.summaryPointers.lastRunId ??
      context.issue.id;
    const reason =
      conflict.blockedReason ??
      mergeConflictBlockedReason(conflict.fixTurnCount, conflict.maxFixTurns);
    const blockedConflict: IssueMergeConflictMetadata = {
      ...conflict,
      status: "blocked",
      resolutionStatus: "blocked",
      blockedAt: conflict.blockedAt ?? new Date().toISOString(),
      blockedReason: reason,
    };
    await this.updateIssueLifecycleWithEvidence(
      context.issue,
      {
        phase: "blocked",
        blockedReason: reason,
        mergeConflict: blockedConflict,
      },
      "merge_conflict_attempt_limit",
      runId,
    );
    context.mergeConflictBlock.lifecycle = lifecycle;
    context.mergeConflictBlock.conflict = blockedConflict;
    context.mergeConflictBlock.runId = runId;
    context.mergeConflictBlock.reason = reason;
    return {
      details: {
        runId,
        blockedReason: reason,
        fixTurnCount: conflict.fixTurnCount,
        maxFixTurns: conflict.maxFixTurns,
      },
    };
  }

  private async applyMergeConflictBlockedWritebacksAction(
    context: OrchestratorTransitionContext,
  ) {
    const conflict = context.mergeConflictBlock.conflict;
    const runId = context.mergeConflictBlock.runId;
    if (!conflict || !runId)
      return {
        status: "skipped" as const,
        stop: true,
        message: "Merge conflict block state was not prepared",
      };
    await this.applyMergeConflictBlockedWritebacks(
      context.issue,
      runId,
      conflict,
      context.mergeConflictBlock.reason ?? "conflict-fix attempt limit reached",
    );
    return {
      details: {
        runId,
        blockedReason: conflict.blockedReason,
        conflictId: conflict.id,
      },
    };
  }

  private async recordMergeConflictBlockAction(
    context: OrchestratorTransitionContext,
  ) {
    const conflict = context.mergeConflictBlock.conflict;
    return {
      details: {
        conflictId: conflict?.id ?? null,
        runId: context.mergeConflictBlock.runId ?? null,
        blockedReason: context.mergeConflictBlock.reason ?? null,
      },
    };
  }

  private async planHeadSupersessionRecoveryWritebacksAction(
    context: OrchestratorTransitionContext,
  ) {
    const lifecycle = await this.options.lifecycleStore?.get(context.issue.id);
    if (!lifecycle)
      return {
        status: "skipped" as const,
        stop: true,
        message: "No lifecycle exists for head supersession recovery",
      };
    const gate = lifecycle.mergeGate ?? null;
    const report = latestCompletionReport(lifecycle);
    const pullRequest = report?.pullRequest ?? null;
    const reportHeadSha = pullRequest?.headSha?.trim() ?? "";
    const verdict = latestCurrentApprovalPassVerdict(lifecycle);
    if (
      this.config.reviewLoop.reviewPassState === null ||
      !isStateIn(context.issue.state, this.config.tracker.activeStates) ||
      lifecycle.phase !== "implementation" ||
      lifecycle.summaryPointers.ciStatus !== "head_superseded" ||
      gate === null ||
      gate.status !== "superseded" ||
      gate.supersededByHeadSha === null ||
      report === null ||
      pullRequest === null ||
      reportHeadSha.length === 0 ||
      reportHeadSha !== gate.supersededByHeadSha ||
      (lifecycle.summaryPointers.prHeadSha !== null &&
        lifecycle.summaryPointers.prHeadSha !== reportHeadSha) ||
      verdict === null
    ) {
      return {
        status: "skipped" as const,
        stop: true,
        message: "Head supersession recovery preconditions no longer match",
      };
    }
    const operations = planMergeGateHeadSupersessionRecoveryWritebacks(
      {
        issue: context.issue,
        gateId: gate.id,
        pullRequest,
        liveHeadSha: reportHeadSha,
        reportId: report.id,
        verdictId: verdict.id,
      },
      this.config,
    );
    if (operations.length === 0)
      return {
        status: "skipped" as const,
        stop: true,
        message: "No head supersession recovery writebacks were planned",
      };
    context.headSupersessionRecovery.lifecycle = lifecycle;
    context.headSupersessionRecovery.report = report;
    context.headSupersessionRecovery.verdict = verdict;
    context.headSupersessionRecovery.operations = operations;
    return {
      details: {
        gateId: gate.id,
        reportId: report.id,
        verdictId: verdict.id,
        operationKeys: operations.map((operation) => operation.idempotencyKey),
      },
    };
  }

  private async applyHeadSupersessionRecoveryWritebacksAction(
    context: OrchestratorTransitionContext,
  ) {
    const operations = context.headSupersessionRecovery.operations ?? [];
    if (operations.length === 0)
      return {
        status: "skipped" as const,
        stop: true,
        message: "No head supersession recovery writebacks were planned",
      };
    const applied = await this.applyWritebacks(
      operations,
      "merge gate head supersession recovery",
      context.issue,
    );
    return applied
      ? {
          details: {
            operationKeys: operations.map(
              (operation) => operation.idempotencyKey,
            ),
          },
        }
      : {
          status: "skipped" as const,
          stop: true,
          message:
            "Head supersession recovery writebacks did not complete successfully",
        };
  }

  private async updateLifecycleHeadSupersessionRecoveredAction(
    context: OrchestratorTransitionContext,
  ) {
    const report = context.headSupersessionRecovery.report;
    const verdict = context.headSupersessionRecovery.verdict;
    if (!report || !verdict)
      return {
        status: "skipped" as const,
        stop: true,
        message: "Head supersession recovery state was not prepared",
      };
    await this.updateIssueLifecycleWithEvidence(
      context.issue,
      {
        phase: "passed",
        blockedReason: null,
        lastReviewVerdictId: verdict.id,
        summaryPointers: { ciStatus: null },
      },
      "merge_gate_head_supersession_rebind",
      report.runId,
    );
    return { details: { reportId: report.id, verdictId: verdict.id } };
  }

  private async planIssueTriageReboundWritebackAction(
    context: OrchestratorTransitionContext,
  ) {
    const lifecycle = await this.options.lifecycleStore?.get(context.issue.id);
    const report = latestIssueTriageReport(lifecycle);
    const gate = lifecycle?.mergeGate ?? null;
    const activeBlockers = activeIssueTriageBlockers(report);
    if (
      !lifecycle ||
      !isStateIn(context.issue.state, this.config.tracker.activeStates) ||
      lifecycle.phase !== "implementation" ||
      gate === null ||
      gate.status !== "blocked" ||
      report === null ||
      activeBlockers.length === 0 ||
      activeBlockers.every((blocker) => blocker.nextActor === "worker")
    ) {
      return {
        status: "skipped" as const,
        stop: true,
        message: "Issue triage rebound preconditions no longer match",
      };
    }
    const reason =
      lifecycle.blockedReason ??
      `max merge gate failures reached (${gate.reviewRound}/${this.config.reviewLoop.failureLimits.mergeGateFailures})`;
    const operation = planIssueTriageBlockedReboundWriteback(
      { issue: context.issue, report, reason },
      this.config,
    );
    if (operation === null)
      return {
        status: "skipped" as const,
        stop: true,
        message: "No issue triage rebound writeback was planned",
      };
    context.triageRebound.lifecycle = lifecycle;
    context.triageRebound.report = report;
    context.triageRebound.reason = reason;
    context.triageRebound.operation = operation;
    return {
      details: {
        reportId: report.id,
        reason,
        operationKey: operation.idempotencyKey,
        blockers: activeBlockers.map((blocker) => ({
          kind: blocker.kind,
          nextActor: blocker.nextActor,
          status: blocker.status,
        })),
      },
    };
  }

  private async applyIssueTriageReboundWritebackAction(
    context: OrchestratorTransitionContext,
  ) {
    const operation = context.triageRebound.operation ?? null;
    if (!operation)
      return {
        status: "skipped" as const,
        stop: true,
        message: "No issue triage rebound writeback was planned",
      };
    const applied = await this.applyWriteback(
      operation,
      "issue triage blocked rebound",
      context.issue,
    );
    return applied
      ? { details: { operationKey: operation.idempotencyKey } }
      : {
          status: "skipped" as const,
          stop: true,
          message:
            "Issue triage rebound writeback did not complete successfully",
        };
  }

  private async updateLifecycleIssueTriageReboundAction(
    context: OrchestratorTransitionContext,
  ) {
    const lifecycle = context.triageRebound.lifecycle;
    const report = context.triageRebound.report;
    const reason = context.triageRebound.reason;
    if (!lifecycle || !report || !reason) {
      return {
        status: "skipped" as const,
        stop: true,
        message: "Issue triage rebound state was not prepared",
      };
    }
    await this.updateIssueLifecycleWithEvidence(
      context.issue,
      {
        phase: "blocked",
        blockedReason: reason,
      },
      "issue_triage_blocked_rebound",
      lifecycle.summaryPointers.lastRunId ?? context.issue.id,
    );
    return { details: { reportId: report.id, reason } };
  }

  private async verifyPublicationApprovalRecoveryConfigAction(
    context: OrchestratorTransitionContext,
  ) {
    if (
      !this.config.github.publishPullRequests ||
      !(this.config.github.operatorApproval?.requiredForPublication ?? false) ||
      !this.options.lifecycleStore ||
      !this.options.writeback ||
      !this.options.operatorApproval
    ) {
      return {
        status: "skipped" as const,
        stop: true,
        message: "Pending publication approval recovery is not configured",
      };
    }
    const writebackOutbox = new SqliteWritebackOutboxStore(
      this.config.workspace.stateDir,
    );
    context.publicationApproval.writebackOutbox = writebackOutbox;
    context.publicationApproval.service = new CompletionReportService({
      config: this.config,
      lifecycleStore: this.options.lifecycleStore,
      writebackOutbox,
      writebackProcessor: this.options.writeback,
      ...(this.options.runStore === undefined
        ? {}
        : { runStore: this.options.runStore }),
      pullRequestPublisher:
        this.options.completionReportPublisher ??
        createGitHubPullRequestClientForCapability(
          this.config,
          "github.publication",
        ),
      operatorApproval: this.options.operatorApproval,
    });
    return true;
  }

  private async loadRecoverablePublicationApprovalLifecycleAction(
    context: OrchestratorTransitionContext,
  ) {
    const lifecycle =
      (await this.options.lifecycleStore?.get(context.issue.id)) ?? null;
    if (!hasRecoverablePendingPublicationApproval(lifecycle)) {
      return {
        status: "skipped" as const,
        stop: true,
        message: "No recoverable pending publication approval handoff exists",
      };
    }
    context.publicationApproval.lifecycle = lifecycle;
    const handoff = pendingPublicationHandoffForRun(lifecycle);
    return {
      details: {
        runId: handoff?.pendingReport.runId ?? null,
        reportId: handoff?.pendingReport.id ?? null,
      },
    };
  }

  private async recordPublicationApprovalRecoveryStartedAction(
    context: OrchestratorTransitionContext,
  ) {
    const lifecycle = context.publicationApproval.lifecycle;
    const handoff = pendingPublicationHandoffForRun(lifecycle);
    return {
      details: {
        runId: handoff?.pendingReport.runId ?? null,
        reportId: handoff?.pendingReport.id ?? null,
      },
    };
  }

  private async recoverPublicationApprovalHandoffAction(
    context: OrchestratorTransitionContext,
  ) {
    const lifecycle = context.publicationApproval.lifecycle;
    const service = context.publicationApproval.service;
    if (!lifecycle || !service)
      return {
        status: "skipped" as const,
        stop: true,
        message: "Publication approval recovery state was not prepared",
      };
    const result = await service.recoverPendingPublicationApproval({
      issue: context.issue,
      lifecycle,
    });
    context.publicationApproval.result = result;
    if (result.recovered) {
      this.options.logger.info("pending publication approval recovered", {
        issue_id: lifecycle.issueId,
        issue_identifier: lifecycle.issueIdentifier,
        run_id: result.report.runId,
        approval_request_id:
          result.outcome === "pending"
            ? result.approvalRequest.requestId
            : null,
        outcome: result.outcome,
      });
      return { details: result };
    }
    return {
      status: "skipped" as const,
      message: "Pending publication approval recovery skipped",
      details: result,
    };
  }

  private async recordPublicationApprovalRecoveryFinishedAction(
    context: OrchestratorTransitionContext,
  ) {
    return { details: context.publicationApproval.result ?? null };
  }

  private async markRunningCancellationRequestedAction(
    context: OrchestratorTransitionContext,
  ) {
    const entry = this.running.get(context.issue.id);
    if (!entry)
      return {
        status: "skipped" as const,
        stop: true,
        message: "No running entry exists for termination",
      };
    const reason =
      nonEmptyString(context.transition.terminationReason) ??
      context.transition.reason ??
      "state changed";
    const cleanupWorkspace = context.transition.cleanupWorkspace === true;
    entry.suppressRetryOnExit = true;
    this.markCancellationRequested(entry, {
      source: "state_change",
      reason,
      abortSignalled: true,
    });
    context.termination.entry = entry;
    context.termination.reason = reason;
    context.termination.cleanupWorkspace = cleanupWorkspace;
    await this.recordRuntimeControlEvidenceSnapshot({
      issue: entry.issue,
      eventType: "cancellation_requested",
      sourceId: entry.activeRunId ?? entry.runId ?? entry.issue.id,
      reason,
      entry,
    });
    return {
      details: {
        reason,
        cleanupWorkspace,
        role: entry.role,
        runPhase: entry.runPhase,
        runId: entry.activeRunId ?? entry.runId,
      },
    };
  }

  private async abortRunningAgentAction(
    context: OrchestratorTransitionContext,
  ) {
    const entry = context.termination.entry;
    if (!entry)
      return {
        status: "skipped" as const,
        stop: true,
        message: "No running entry exists for termination",
      };
    entry.abortController.abort();
    return {
      details: {
        issueId: entry.issue.id,
        runId: entry.activeRunId ?? entry.runId,
      },
    };
  }

  private async markWorkspaceCleanupOnExitAction(
    context: OrchestratorTransitionContext,
  ) {
    const entry = context.termination.entry;
    if (!entry)
      return {
        status: "skipped" as const,
        stop: true,
        message: "No running entry exists for termination",
      };
    if (context.termination.cleanupWorkspace !== true)
      return {
        status: "skipped" as const,
        message: "Workspace cleanup was not requested",
      };
    entry.cleanupWorkspaceOnExit = true;
    return {
      details: { issueId: entry.issue.id, workspacePath: entry.workspacePath },
    };
  }

  private async recordRunningTerminationAction(
    context: OrchestratorTransitionContext,
  ) {
    const entry = context.termination.entry;
    if (!entry)
      return {
        status: "skipped" as const,
        stop: true,
        message: "No running entry exists for termination",
      };
    this.options.logger.info("running issue terminated", {
      issue_id: entry.issue.id,
      issue_identifier: entry.issue.identifier,
      reason: context.termination.reason ?? null,
      cleanup_workspace: context.termination.cleanupWorkspace === true,
    });
    return {
      details: {
        reason: context.termination.reason ?? null,
        cleanupWorkspace: context.termination.cleanupWorkspace === true,
        role: entry.role,
        runPhase: entry.runPhase,
        runId: entry.activeRunId ?? entry.runId,
      },
    };
  }

  private async loadBlockIssueLifecycleAction(
    context: OrchestratorTransitionContext,
  ) {
    const lifecycle = await this.options.lifecycleStore?.get(context.issue.id);
    if (!lifecycle)
      return {
        status: "skipped" as const,
        stop: true,
        message: "No lifecycle exists for blocked transition",
      };
    context.blockIssue.lifecycle = lifecycle;
    context.blockIssue.reason =
      nonEmptyString(context.transition.blockedReason) ??
      context.transition.reason ??
      "blocked";
    context.blockIssue.runId =
      nonEmptyString(context.transition.runId) ??
      lifecycle.summaryPointers.lastRunId ??
      context.issue.id;
    return {
      details: {
        runId: context.blockIssue.runId,
        reason: context.blockIssue.reason,
      },
    };
  }

  private async recordBaseRefObservationAction(
    context: OrchestratorTransitionContext,
  ) {
    const targetRequest = baseRefTargetRequestFromTransition(context.transition);
    if (targetRequest === null) {
      return {
        status: "skipped" as const,
        stop: true,
        message: "Base ref observation target transition is missing",
      };
    }
    const workspacePath = nonEmptyString(context.transition.latestWorkspacePath);
    const branchName =
      nonEmptyString(context.transition.latestGitBranchName) ??
      nonEmptyString(context.transition.latestPrBranch) ??
      nonEmptyString(context.transition.branchName);
    const baseRef =
      nonEmptyString(context.transition.latestBaseRef) ??
      nonEmptyString(this.config.workspace.source.baseRef);
    const client =
      this.options.pullRequestMergeClient ??
      createGitHubPullRequestClientForCapability(this.config, "github.merge");
    const observation = await new BaseRefVerifier().verify({
      workspacePath,
      branchName,
      baseRef,
      operation: targetRequest.transitionKind,
      client,
    });
    context.baseRef.observation = observation;
    const lifecycle =
      (await this.updateIssueLifecycleWithEvidence(
        context.issue,
        { baseRefObservation: observation },
        "base_ref_observed",
        context.transition.historySnapshotId,
      )) ?? null;
    if (lifecycle === null) {
      return {
        status: "skipped" as const,
        stop: true,
        message: "Base ref observation requires lifecycle persistence",
      };
    }
    return {
      details: {
        targetTransitionKind: targetRequest.transitionKind,
        classification: observation.classification,
        inputFingerprint: observation.inputFingerprint,
        workspacePath: observation.workspacePath,
        branchName: observation.branchName,
        baseRef: observation.baseRef,
        githubBaseHeadSha: observation.githubBaseHeadSha,
        localBaseHeadShaAfterFetch: observation.localBaseHeadShaAfterFetch,
        worktreeHeadSha: observation.worktreeHeadSha,
        localBaseIsAncestorOfHead: observation.localBaseIsAncestorOfHead,
        reason: observation.reason,
      },
    };
  }

  private async repairBaseRefDriftAction(
    context: OrchestratorTransitionContext,
  ) {
    const observation = context.transition.lastBaseRefObservation ?? null;
    const requestedFingerprint = nonEmptyString(
      context.transition.baseRefObservationFingerprint,
    );
    if (observation === null) {
      return {
        status: "skipped" as const,
        stop: true,
        message: "Base ref repair requires a recorded base ref observation",
      };
    }
    if (
      requestedFingerprint !== null &&
      observation.inputFingerprint !== requestedFingerprint
    ) {
      return {
        status: "skipped" as const,
        stop: true,
        message: "Base ref repair observation fingerprint is stale",
      };
    }
    const result = await this.mergePolicyServiceForContext(
      context,
    ).repairBaseRefDrift(context.issue, observation);
    context.baseRef.repairResult = result;
    return {
      details: {
        classification: observation.classification,
        inputFingerprint: observation.inputFingerprint,
        resultStatus: result.status,
        ...(result.status === "base_ref_repaired"
          ? { rebasedHeadSha: result.headSha }
          : {}),
        ...(result.status === "conflict_dispatched"
          ? {
              mergeConflictId: result.conflict.id,
              conflictStatus: result.conflict.status,
              conflictResolutionStatus: result.conflict.resolutionStatus,
            }
          : {}),
      },
    };
  }

  private async restorePreservedWorktreeStashesAction(
    context: OrchestratorTransitionContext,
  ) {
    const result = await this.mergePolicyServiceForContext(
      context,
    ).restorePreservedWorktreeStashes(context.issue);
    return {
      details: {
        resultStatus: result.status,
        ...(result.status === "skipped" ? { reason: result.reason } : {}),
        ...(result.status === "conflict_dispatched"
          ? {
              mergeConflictId: result.conflict.id,
              conflictStatus: result.conflict.status,
              conflictResolutionStatus: result.conflict.resolutionStatus,
            }
          : {}),
      },
    };
  }

  private async updateLifecycleBlockedAction(
    context: OrchestratorTransitionContext,
  ) {
    const lifecycle = context.blockIssue.lifecycle;
    const reason = context.blockIssue.reason ?? "blocked";
    const runId = context.blockIssue.runId ?? context.issue.id;
    if (!lifecycle)
      return {
        status: "skipped" as const,
        stop: true,
        message: "Blocked transition lifecycle was not loaded",
      };
    const blockedLifecycle =
      (await this.updateIssueLifecycleWithEvidence(
        context.issue,
        {
          phase: "blocked",
          blockedReason: reason,
        },
        "block_issue",
        runId,
      )) ?? lifecycle;
    context.blockIssue.blockedLifecycle = blockedLifecycle;
    return {
      details: { runId, blockedReason: blockedLifecycle.blockedReason },
    };
  }

  private async applyBlockedEscalationWritebacksAction(
    context: OrchestratorTransitionContext,
  ) {
    const blockedLifecycle = context.blockIssue.blockedLifecycle;
    const reason = context.blockIssue.reason ?? "blocked";
    const runId = context.blockIssue.runId ?? context.issue.id;
    if (!blockedLifecycle)
      return {
        status: "skipped" as const,
        stop: true,
        message: "Blocked lifecycle was not updated",
      };
    const operations = planBlockedEscalationWritebacks(
      {
        issue: context.issue,
        runId,
        reason,
        incompleteTurnCount: blockedLifecycle.incompleteTurnCount,
        maxIncompleteTurns: this.config.reviewLoop.maxIncompleteTurns,
        reviewRound: blockedLifecycle.reviewRound,
        maxReviewRounds: this.config.reviewLoop.failureLimits.reviewerFailures,
        lastCompletionReport: latestCompletionReport(blockedLifecycle),
        lastReviewVerdict: latestReviewVerdict(blockedLifecycle),
        requiredAction:
          "Inspect the latest run output and reviewer feedback, then move the issue out of the blocked state when Symphony should try again.",
      },
      this.config,
    );
    const applied = await this.applyWritebacks(
      operations,
      "blocked escalation",
      context.issue,
    );
    return applied
      ? {
          details: {
            operationKeys: operations.map(
              (operation) => operation.idempotencyKey,
            ),
            runId,
            reason,
          },
        }
      : {
          status: "skipped" as const,
          message:
            "One or more blocked escalation writebacks did not complete successfully",
        };
  }

  private async recordBlockIssueAction(context: OrchestratorTransitionContext) {
    const blockedLifecycle = context.blockIssue.blockedLifecycle;
    return {
      details: {
        runId: context.blockIssue.runId ?? null,
        incompleteTurnCount: blockedLifecycle?.incompleteTurnCount ?? null,
        reviewRound: blockedLifecycle?.reviewRound ?? null,
        blockedReason:
          blockedLifecycle?.blockedReason ?? context.blockIssue.reason ?? null,
      },
    };
  }

  private async scheduleRetryTimerAction(
    context: OrchestratorTransitionContext,
  ) {
    const attempt =
      typeof context.transition.retryAttempt === "number" &&
      Number.isFinite(context.transition.retryAttempt)
        ? context.transition.retryAttempt
        : 1;
    const delayMs =
      typeof context.transition.retryDelayMs === "number" &&
      Number.isFinite(context.transition.retryDelayMs)
        ? context.transition.retryDelayMs
        : 1_000;
    const runPhase =
      agentRunPhaseFromUnknown(context.transition.runPhase) ?? "implementation";
    const error =
      typeof context.transition.retryError === "string"
        ? context.transition.retryError
        : null;
    const dueAtMs = Date.now() + delayMs;
    const retry = await this.scheduleRetry(
      context.issue.id,
      context.issue.identifier,
      attempt,
      delayMs,
      error,
      runPhase,
    );
    context.retry.attempt = attempt;
    context.retry.delayMs = delayMs;
    context.retry.dueAtMs = retry?.dueAtMs ?? dueAtMs;
    context.retry.error = error;
    context.retry.runPhase = runPhase;
    return {
      details: {
        attempt,
        delayMs,
        error,
        runPhase,
        dueAtMs,
      },
    };
  }

  private async recordRetryScheduledAction(
    context: OrchestratorTransitionContext,
  ) {
    await this.recordIssueEvidenceSnapshot({
      issue: context.issue,
      evidenceKind: "harness",
      eventType: "retry_scheduled",
      sourceId: context.issue.id,
      reason: "retry_scheduled",
      payload: {
        attempt: context.retry.attempt ?? null,
        delayMs: context.retry.delayMs ?? null,
        dueAt:
          typeof context.retry.dueAtMs === "number"
            ? new Date(context.retry.dueAtMs).toISOString()
            : null,
        error: context.retry.error ?? null,
        runPhase: context.retry.runPhase ?? null,
      },
    });
    return {
      details: {
        attempt: context.retry.attempt ?? null,
        delayMs: context.retry.delayMs ?? null,
        error: context.retry.error ?? null,
        runPhase: context.retry.runPhase ?? null,
      },
    };
  }

  private async loadHandoffRepairContextAction(
    context: OrchestratorTransitionContext,
  ) {
    const request = context.transition.transitionRequestContext;
    if (request?.kind !== "handoff_repair") {
      return {
        status: "skipped" as const,
        stop: true,
        message: "Handoff repair transition request context is unavailable",
      };
    }
    const {
      sourceRunId,
      kind,
      repairAttempt,
      turnNumber,
      role,
      runPhase,
      runKind,
    } = request.payload;
    if (!this.isHandoffRepairEnabled(kind)) {
      return {
        status: "skipped" as const,
        stop: true,
        message: "Handoff repair is not enabled for this phase",
      };
    }
    if (repairAttempt > this.config.handoffRepair.maxAttempts) {
      return {
        status: "skipped" as const,
        stop: true,
        message: "Handoff repair attempt exceeds the configured limit",
      };
    }
    const entry = this.running.get(context.issue.id);
    if (!entry)
      return {
        status: "skipped" as const,
        stop: true,
        message: "No active running entry exists for handoff repair",
      };
    if (entry.handoffRepair !== null)
      return {
        status: "skipped" as const,
        stop: true,
        message: "Running entry is already in handoff repair mode",
      };
    if (
      entry.role !== role ||
      entry.runPhase !== runPhase ||
      runKindForPhase(entry.runPhase) !== runKind
    ) {
      return {
        status: "skipped" as const,
        stop: true,
        message:
          "Running entry no longer matches the requested handoff repair role and phase",
      };
    }
    const activeSourceRunId = entry.activeRunId ?? entry.runId;
    if (activeSourceRunId !== sourceRunId) {
      return {
        status: "skipped" as const,
        stop: true,
        message:
          "Running entry source run changed before handoff repair dispatch",
      };
    }
    const workspace = entry.workspace;
    if (!workspace)
      return {
        status: "skipped" as const,
        stop: true,
        message: "Running entry workspace is unavailable for handoff repair",
      };
    const resume = await this.resolveHandoffRepairHermesResume(
      entry,
      sourceRunId,
      kind,
    );
    if (resume === null)
      return {
        status: "skipped" as const,
        stop: true,
        message: "Source run is not resumable for handoff repair",
      };

    context.handoffRepair.entry = entry;
    context.handoffRepair.workspace = workspace;
    context.handoffRepair.sourceRunId = sourceRunId;
    context.handoffRepair.kind = kind;
    context.handoffRepair.repairAttempt = repairAttempt;
    context.handoffRepair.turnNumber = turnNumber;
    context.handoffRepair.resume = resume;
    return {
      details: {
        sourceRunId,
        kind,
        repairAttempt,
        turnNumber,
        maxAttempts: this.config.handoffRepair.maxAttempts,
        hermesResumeSourceRunId: resume.sourceRunId,
        hermesResumeReason: resume.reason,
        hermesProfileKey: resume.profileKey,
        hermesSessionKey: resume.sessionKey,
      },
    };
  }

  private async dispatchHandoffRepairAction(
    context: OrchestratorTransitionContext,
  ) {
    const repair = this.requireLoadedHandoffRepairContext(context);
    repair.entry.issueHistorySnapshotId = context.transition.historySnapshotId;
    repair.entry.handoffRepair = {
      sourceRunId: repair.sourceRunId,
      kind: repair.kind,
      attempt: repair.repairAttempt,
    };
    repair.entry.hermesResume = repair.resume;
    repair.entry.activeRunTokens = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    this.options.logger.warn("dispatching MCP handoff repair", {
      issue_id: repair.entry.issue.id,
      issue_identifier: repair.entry.issue.identifier,
      source_run_id: repair.sourceRunId,
      kind: repair.kind,
      repair_attempt: repair.repairAttempt,
    });
    return {
      message: `Dispatching MCP handoff repair for ${formatRepairableHandoffKind(repair.kind)}`,
      details: {
        sourceRunId: repair.sourceRunId,
        kind: repair.kind,
        repairAttempt: repair.repairAttempt,
        maxAttempts: this.config.handoffRepair.maxAttempts,
      },
    };
  }

  private async renderHandoffRepairPromptAction(
    context: OrchestratorTransitionContext,
  ) {
    const repair = this.requireLoadedHandoffRepairContext(context);
    const promptBundle = await this.renderHandoffRepairPromptBundle(
      repair.entry,
      repair.kind,
      repair.sourceRunId,
      repair.repairAttempt,
      { recordAction: false },
    );
    this.assertPromptBundleSupported(promptBundle);
    context.handoffRepair.promptBundle = promptBundle;
    return { details: promptBundle.metadata };
  }

  private async recordHandoffRepairDispatchedEventAction(
    context: OrchestratorTransitionContext,
  ) {
    const repair = this.requireLoadedHandoffRepairContext(context);
    if (!this.options.runStore) {
      return {
        status: "skipped" as const,
        message: "Run transcript store is unavailable",
      };
    }
    await this.options.runStore.appendEvent({
      runId: repair.sourceRunId,
      at: new Date().toISOString(),
      source: "orchestrator",
      eventType: "handoff_repair_dispatched",
      message: `Dispatching MCP handoff repair for ${formatRepairableHandoffKind(repair.kind)}`,
      payload: {
        kind: repair.kind,
        repairAttempt: repair.repairAttempt,
        maxAttempts: this.config.handoffRepair.maxAttempts,
      },
    });
    return {
      details: {
        sourceRunId: repair.sourceRunId,
        kind: repair.kind,
        repairAttempt: repair.repairAttempt,
      },
    };
  }

  private async prepareHandoffRepairHarnessAction(
    context: OrchestratorTransitionContext,
  ) {
    const repair = this.requireLoadedHandoffRepairContext(context);
    if (typeof this.options.harness.prepare !== "function") {
      return {
        status: "skipped" as const,
        message: "Harness prepare hook is unavailable",
      };
    }
    await this.prepareHarnessForRun(
      repair.entry,
      repair.workspace,
      context.attempt,
      repair.turnNumber,
      repair.promptBundle,
    );
    return {
      details: {
        harnessId: this.options.harness.id,
        workspaceKey: repair.workspace.workspaceKey,
        workspacePath: repair.workspace.path,
        turnNumber: repair.turnNumber,
      },
    };
  }

  private async reloadHandoffRepairHarnessAction(
    context: OrchestratorTransitionContext,
  ) {
    const repair = this.requireLoadedHandoffRepairContext(context);
    if (typeof this.options.harness.reload !== "function") {
      return {
        status: "skipped" as const,
        message: "Harness reload hook is unavailable",
      };
    }
    await this.reloadHarnessForRun(
      repair.entry,
      repair.workspace,
      context.attempt,
      repair.turnNumber,
      repair.promptBundle,
    );
    return {
      details: {
        harnessId: this.options.harness.id,
        workspaceKey: repair.workspace.workspaceKey,
        workspacePath: repair.workspace.path,
        turnNumber: repair.turnNumber,
      },
    };
  }

  private async runHandoffRepairAgentAction(
    context: OrchestratorTransitionContext,
  ) {
    const repair = this.requireLoadedHandoffRepairContext(context);
    if (!repair.promptBundle)
      throw new SymphonyError(
        "invalid_request",
        "Handoff repair prompt bundle was not rendered",
      );
    await this.consumeHarnessEvents(
      repair.entry,
      this.options.harness.run(
        this.buildRunContext(
          repair.entry,
          repair.workspace,
          context.attempt,
          repair.turnNumber,
          repair.promptBundle,
        ),
        repair.promptBundle.userPrompt,
      ),
      {
        workspace: repair.workspace,
        prompt: repair.promptBundle.userPrompt,
        promptBundle: repair.promptBundle,
        attempt: context.attempt,
        turnNumber: repair.turnNumber,
      },
    );
    return {
      details: {
        runId: repair.entry.activeRunId ?? repair.entry.runId,
        sessionId: repair.entry.sessionId,
        sourceRunId: repair.sourceRunId,
        kind: repair.kind,
        repairAttempt: repair.repairAttempt,
        turnNumber: repair.turnNumber,
      },
    };
  }

  private async reconcileHandoffRepairResultAction(
    context: OrchestratorTransitionContext,
  ) {
    const repair = this.requireLoadedHandoffRepairContext(context);
    const accepted = await this.reconcileRepairableHandoff(
      repair.entry,
      repair.kind,
    );
    context.handoffRepair.accepted = accepted;
    if (!accepted) {
      this.options.logger.warn(
        "MCP handoff repair finished without required handoff",
        {
          issue_id: repair.entry.issue.id,
          issue_identifier: repair.entry.issue.identifier,
          source_run_id: repair.sourceRunId,
          repair_run_id: repair.entry.activeRunId ?? repair.entry.runId,
          kind: repair.kind,
          repair_attempt: repair.repairAttempt,
        },
      );
      throw new SymphonyError(
        "conflict",
        `MCP handoff repair finished without required ${formatRepairableHandoffKind(repair.kind)} handoff`,
        {
          sourceRunId: repair.sourceRunId,
          repairRunId: repair.entry.activeRunId ?? repair.entry.runId,
          kind: repair.kind,
          repairAttempt: repair.repairAttempt,
        },
      );
    }
    return {
      details: {
        accepted,
        runId: repair.entry.activeRunId ?? repair.entry.runId,
        sourceRunId: repair.sourceRunId,
        kind: repair.kind,
        repairAttempt: repair.repairAttempt,
      },
    };
  }

  private requireLoadedHandoffRepairContext(
    context: OrchestratorTransitionContext,
  ): {
    entry: RunningEntry;
    workspace: Workspace;
    sourceRunId: string;
    kind: RepairableHandoffKind;
    repairAttempt: number;
    turnNumber: number;
    resume: AgentHermesResumeContext;
    promptBundle?: AgentPromptBundle;
  } {
    const {
      entry,
      workspace,
      sourceRunId,
      kind,
      repairAttempt,
      turnNumber,
      resume,
      promptBundle,
    } = context.handoffRepair;
    if (
      !entry ||
      !workspace ||
      !sourceRunId ||
      !kind ||
      repairAttempt === undefined ||
      turnNumber === undefined ||
      !resume
    ) {
      throw new SymphonyError(
        "invalid_request",
        "Handoff repair transition context was not loaded",
      );
    }
    return {
      entry,
      workspace,
      sourceRunId,
      kind,
      repairAttempt,
      turnNumber,
      resume,
      ...(promptBundle === undefined ? {} : { promptBundle }),
    };
  }

  private createTransitionRulesets(): TransitionRuleset[] {
    return this.versionTransitionRulesets([
      {
        id: "manual.reset_lifecycle_after_operator_resume",
        priority: 0,
        evaluate: (snapshot) => {
          if (snapshot.triggerType !== "manual.cli_agent_run") return null;
          if (!isManualAgentRunStage(snapshot.manualStage)) return null;
          if (
            snapshot.manualStage === "triage" ||
            snapshot.manualStage === "post_mortem"
          )
            return null;
          if (!this.rulesetBlockedByLifecycle(snapshot)) return null;
          if (isPendingPublicationApprovalReason(snapshot.blockedReason))
            return null;
          if (
            snapshot.blockedReason === null &&
            snapshot.reviewRound === 0 &&
            snapshot.incompleteTurnCount === 0 &&
            snapshot.lastIssueTriageReportId === null
          ) {
            return null;
          }
          if (
            !snapshot.manualIgnoreState &&
            this.config.reviewLoop.blockedStates.length > 0 &&
            isStateIn(
              snapshot.trackerState,
              this.config.reviewLoop.blockedStates,
            )
          ) {
            return null;
          }
          return {
            transitionKind: "reset_lifecycle_after_operator_resume",
            reason: snapshot.manualIgnoreState
              ? "manual_ignore_state_resume"
              : "tracker_state_resume",
          };
        },
      },
      {
        id: "manual.dispatch",
        priority: 1,
        evaluate: (snapshot) => {
          if (
            snapshot.triggerType !== "manual.cli_agent_run" ||
            !isManualAgentRunStage(snapshot.manualStage)
          )
            return null;
          const target = manualAgentRunTarget(snapshot.manualStage);
          return this.baseRefGuardedTransitionRequest(
            snapshot,
            dispatchTransitionRequest({
              role: target.role,
              runPhase: target.runPhase,
              reason: "manual_dispatch",
              promptScenario: promptScenarioForDispatch(
                target.role,
                target.runPhase,
                true,
              ),
              manualDispatch: true,
            }),
          );
        },
      },
      {
        id: "orchestrator.terminate_running",
        priority: 10,
        evaluate: (snapshot) => this.runningTerminationRequest(snapshot),
      },
      {
        id: "orchestrator.recover_publication_approval",
        priority: 20,
        evaluate: (snapshot) =>
          snapshot.triggerType === "orchestrator.tick" &&
          snapshot.pendingPublicationApprovalRunId !== null
            ? this.baseRefGuardedTransitionRequest(snapshot, {
                transitionKind: "recover_publication_approval",
                reason: "recover_pending_publication_approval",
                runId: snapshot.pendingPublicationApprovalRunId,
                pendingPublicationApprovalReportId:
                  snapshot.pendingPublicationApprovalReportId,
                pendingPublicationApprovalReason:
                  snapshot.pendingPublicationApprovalReason,
              })
            : null,
      },
      {
        id: "orchestrator.block_issue",
        priority: 30,
        evaluate: (snapshot) =>
          snapshot.triggerType === "orchestrator.tick" &&
          (nonEmptyString(snapshot.triggerReason) !== null ||
            nonEmptyString(snapshot.triggerRunId) !== null)
            ? {
                transitionKind: "block_issue",
                reason:
                  nonEmptyString(snapshot.triggerReason) ??
                  nonEmptyString(snapshot.blockedReason) ??
                  "block_issue",
                blockedReason:
                  nonEmptyString(snapshot.triggerReason) ??
                  nonEmptyString(snapshot.blockedReason),
                runId:
                  nonEmptyString(snapshot.triggerRunId) ?? snapshot.latestRunId,
              }
            : null,
      },
      {
        id: "orchestrator.reset_merge_conflict_after_operator_resume",
        priority: 35,
        evaluate: (snapshot) =>
          this.rulesetShouldResetMergeConflictAfterOperatorResume(snapshot)
            ? {
                transitionKind: "reset_merge_conflict_after_operator_resume",
                reason: "merge_conflict_state_resume",
                reopenMergeConflict: true,
              }
            : null,
      },
      {
        id: "orchestrator.block_merge_conflict_attempt_limit",
        priority: 36,
        evaluate: (snapshot) =>
          this.rulesetShouldBlockMergeConflictAttemptLimit(snapshot)
            ? {
                transitionKind: "block_merge_conflict_attempt_limit",
                reason:
                  snapshot.mergeConflict?.blockedReason ??
                  mergeConflictBlockedReason(
                    snapshot.mergeConflict?.fixTurnCount ?? 0,
                    snapshot.mergeConflict?.maxFixTurns ??
                      this.config.mergePolicy.maxConflictFixTurns,
                  ),
                runId: snapshot.latestRunId ?? snapshot.issueId,
              }
            : null,
      },
      {
        id: "orchestrator.reset_lifecycle_after_operator_resume",
        priority: 37,
        evaluate: (snapshot) =>
          this.rulesetShouldResetLifecycleAfterOperatorResume(snapshot)
            ? {
                transitionKind: "reset_lifecycle_after_operator_resume",
                reason: "tracker_state_resume",
              }
            : null,
      },
      {
        id: "orchestrator.recover_merge_gate_head_supersession",
        priority: 38,
        evaluate: (snapshot) =>
          this.rulesetShouldRecoverMergeGateHeadSupersession(snapshot)
            ? {
                transitionKind: "recover_merge_gate_head_supersession",
                reason: "merge_gate_head_supersession_rebind",
              }
            : null,
      },
      {
        id: "orchestrator.rebound_issue_triage_blocked",
        priority: 39,
        evaluate: (snapshot) =>
          this.rulesetShouldReboundIssueTriageBlocked(snapshot)
            ? {
                transitionKind: "rebound_issue_triage_blocked",
                reason: "issue_triage_blocked_rebound",
              }
            : null,
      },
      {
        id: "orchestrator.block.planning_failure_limit",
        priority: 41,
        evaluate: (snapshot) =>
          this.rulesetShouldBlockPlanningFailureLimit(snapshot)
            ? {
                transitionKind: "block_issue",
                reason: maxPlanningFailuresReason(
                  snapshot.planningFailureCount,
                  this.config.issueBreakdown.maxPlanningFailures,
                ),
                blockedReason: maxPlanningFailuresReason(
                  snapshot.planningFailureCount,
                  this.config.issueBreakdown.maxPlanningFailures,
                ),
                runId: snapshot.latestRunId ?? snapshot.issueId,
              }
            : null,
      },
      {
        id: "orchestrator.block.worker_incomplete_turn_limit",
        priority: 42,
        evaluate: (snapshot) =>
          this.rulesetShouldBlockWorkerIncompleteTurnLimit(snapshot)
            ? {
                transitionKind: "block_issue",
                reason: `max incomplete turns reached (${snapshot.incompleteTurnCount}/${this.config.reviewLoop.maxIncompleteTurns})`,
                blockedReason: `max incomplete turns reached (${snapshot.incompleteTurnCount}/${this.config.reviewLoop.maxIncompleteTurns})`,
                runId: snapshot.latestRunId ?? snapshot.issueId,
              }
            : null,
      },
      {
        id: "orchestrator.block.reviewer_failure_limit",
        priority: 43,
        evaluate: (snapshot) =>
          this.rulesetShouldBlockReviewerFailureLimit(snapshot)
            ? {
                transitionKind: "block_issue",
                reason: `max reviewer failures reached (${snapshot.reviewRound}/${this.config.reviewLoop.failureLimits.reviewerFailures})`,
                blockedReason: `max reviewer failures reached (${snapshot.reviewRound}/${this.config.reviewLoop.failureLimits.reviewerFailures})`,
                runId: snapshot.latestRunId ?? snapshot.issueId,
              }
            : null,
      },
      {
        id: "orchestrator.base_ref.chain",
        priority: 44,
        evaluate: (snapshot) => {
          const context = snapshot.transitionRequestContext;
          if (
            snapshot.triggerType !== "runtime.requested" ||
            snapshot.triggerSource !== "transition" ||
            context?.kind !== "base_ref_chain"
          ) {
            return null;
          }
          return this.baseRefGuardedTransitionRequest(
            snapshot,
            context.payload.targetRequest,
          );
        },
      },
      {
        id: "orchestrator.preserved_stash.restore",
        priority: issueTransitionRulesetPriority("preserved_stash_restore"),
        evaluate: (snapshot) =>
          this.rulesetShouldRestorePreservedStashes(snapshot)
            ? {
                transitionKind: "preserved_stash_restore",
                reason: "preserved_worktree_stash_restore",
              }
            : null,
      },
      {
        id: "orchestrator.dispatch.merge_conflict_worker",
        priority: 40,
        evaluate: (snapshot) =>
          snapshot.triggerType === "orchestrator.tick" &&
          this.rulesetCanDispatchWorker(snapshot, "merge_conflict_resolution")
            ? this.baseRefGuardedTransitionRequest(
                snapshot,
                dispatchTransitionRequest({
                  role: "worker",
                  runPhase: "merge_conflict_resolution",
                  reason: "merge_conflict_resolution_required",
                  promptScenario: promptScenarioForDispatch(
                    "worker",
                    "merge_conflict_resolution",
                    false,
                  ),
                }),
              )
            : null,
      },
      {
        id: "orchestrator.reconcile_issue_triage_report_writeback",
        priority: 60,
        evaluate: (snapshot) =>
          this.rulesetShouldReconcileIssueTriageReportWriteback(snapshot)
            ? {
                transitionKind: "reconcile_issue_triage_report_writeback",
                reason: "issue_triage_report_writeback_reconciliation",
                reportId: snapshot.lastIssueTriageReportId,
              }
            : null,
      },
      {
        id: "orchestrator.reconcile_post_mortem_report_writeback",
        priority: 65,
        evaluate: (snapshot) =>
          this.rulesetShouldReconcileIssuePostMortemReportWriteback(snapshot)
            ? {
                transitionKind: "reconcile_post_mortem_report_writeback",
                reason: "post_mortem_report_writeback_reconciliation",
                reportId: snapshot.lastPostMortemReportId,
              }
            : null,
      },
      {
        id: "orchestrator.dispatch.planner",
        priority: 70,
        evaluate: (snapshot) => {
          if (snapshot.triggerType !== "orchestrator.tick") return null;
          if (!this.rulesetCanDispatchPlanner(snapshot)) return null;
          if (!this.rulesetShouldDispatchPlanner(snapshot)) return null;
          return dispatchTransitionRequest({
            role: "planner",
            runPhase: "issue_breakdown",
            reason: this.rulesetPlannerDispatchReason(snapshot),
            promptScenario: promptScenarioForDispatch(
              "planner",
              "issue_breakdown",
              false,
            ),
          });
        },
      },
      {
        id: "orchestrator.issue_breakdown_apply_wait",
        priority: 90,
        evaluate: (snapshot) =>
          this.rulesetShouldWaitForIssueBreakdownApply(snapshot)
            ? {
                transitionKind: "noop",
                reason: "issue_breakdown_apply_required",
              }
            : null,
      },
      {
        id: "orchestrator.dispatch.worker.implementation",
        priority: 100,
        evaluate: (snapshot) =>
          snapshot.triggerType === "orchestrator.tick" &&
          this.rulesetCanDispatchWorker(snapshot, "implementation")
            ? this.baseRefGuardedTransitionRequest(
                snapshot,
                dispatchTransitionRequest({
                  role: "worker",
                  runPhase: "implementation",
                  reason: "worker_dispatch",
                  promptScenario: promptScenarioForDispatch(
                    "worker",
                    "implementation",
                    false,
                  ),
                }),
              )
            : null,
      },
      {
        id: "orchestrator.dispatch.reviewer.review",
        priority: 120,
        evaluate: (snapshot) =>
          snapshot.triggerType === "orchestrator.tick" &&
          this.rulesetCanDispatchReviewer(snapshot)
            ? this.baseRefGuardedTransitionRequest(
                snapshot,
                dispatchTransitionRequest({
                  role: "reviewer",
                  runPhase: "review",
                  reason: "reviewer_dispatch",
                  promptScenario: promptScenarioForDispatch(
                    "reviewer",
                    "review",
                    false,
                  ),
                }),
              )
            : null,
      },
      {
        id: "orchestrator.dispatch.triage.issue_triage",
        priority: 130,
        evaluate: (snapshot) =>
          snapshot.triggerType === "orchestrator.tick" &&
          this.rulesetCanDispatchIssueTriage(snapshot)
            ? dispatchTransitionRequest({
                role: "triage",
                runPhase: "issue_triage",
                reason: "issue_triage_dispatch",
                promptScenario: promptScenarioForDispatch(
                  "triage",
                  "issue_triage",
                  false,
                ),
              })
            : null,
      },
      ...this.createMergePolicyTransitionRulesets(),
      {
        id: "orchestrator.handoff_reconciliation",
        priority: 260,
        evaluate: (snapshot) => {
          const context = snapshot.transitionRequestContext;
          if (
            snapshot.triggerType !== "runtime.requested" ||
            snapshot.triggerSource !== "transition" ||
            context?.kind !== "handoff_reconciliation"
          ) {
            return null;
          }
          return this.baseRefGuardedTransitionRequest(snapshot, {
            transitionKind: handoffReconciliationTransitionKind(
              context.payload.handoffKind,
            ),
            reason: `${context.payload.handoffKind}_handoff_reconciliation`,
            role: context.payload.role,
            runPhase: context.payload.runPhase,
            runKind: context.payload.runKind,
            runId: context.payload.runId,
            handoffKind: context.payload.handoffKind,
          });
        },
      },
      {
        id: "orchestrator.completion_report_rejection",
        priority: 261,
        evaluate: (snapshot) => {
          const context = snapshot.transitionRequestContext;
          if (
            snapshot.triggerType !== "runtime.requested" ||
            snapshot.triggerSource !== "transition" ||
            context?.kind !== "completion_report_rejection"
          ) {
            return null;
          }
          return {
            transitionKind: "reconcile_completion_report_rejection",
            reason: "completion_report_rejection_reconciliation",
            role: context.payload.role,
            runPhase: context.payload.runPhase,
            runKind: context.payload.runKind,
            runId: context.payload.runId,
          };
        },
      },
      {
        id: "orchestrator.dispatch.post_mortem.post_mortem",
        priority: 220,
        evaluate: (snapshot) =>
          snapshot.triggerType === "orchestrator.tick" &&
          this.rulesetCanDispatchPostMortem(snapshot)
            ? dispatchTransitionRequest({
                role: "post_mortem",
                runPhase: "post_mortem",
                reason: "post_mortem_dispatch",
                promptScenario: promptScenarioForDispatch(
                  "post_mortem",
                  "post_mortem",
                  false,
                ),
              })
            : null,
      },
      {
        id: "orchestrator.handoff_repair",
        priority: 300,
        evaluate: (snapshot) =>
          snapshot.triggerType === "runtime.requested" &&
          snapshot.triggerSource === "transition" &&
          snapshot.transitionRequestContext?.kind === "handoff_repair"
            ? {
                transitionKind: "handoff_repair",
                reason: "missing_required_mcp_handoff",
                promptScenario: "handoff_repair.mcp_only",
                userTemplateKey: "handoff_repair.mcp_only",
                systemTemplateKey: "handoff_repair.mcp_only.system",
              }
            : null,
      },
      {
        id: "orchestrator.retry_run",
        priority: issueTransitionRulesetPriority("retry_run"),
        evaluate: (snapshot) =>
          snapshot.triggerType === "orchestrator.tick" &&
          typeof snapshot.retryAttempt === "number" &&
          Number.isFinite(snapshot.retryAttempt) &&
          typeof snapshot.retryDelayMs === "number" &&
          Number.isFinite(snapshot.retryDelayMs)
            ? {
                transitionKind: "retry_run",
                reason:
                  nonEmptyString(snapshot.retryError) ?? "retry_scheduled",
                role:
                  snapshot.runningRole ??
                  agentRunRoleFromUnknown(snapshot.latestRunRole),
                runPhase:
                  snapshot.runningRunPhase ??
                  agentRunPhaseFromUnknown(snapshot.latestRunPhase),
                runKind:
                  snapshot.runningRunKind ??
                  agentRunKindFromUnknown(snapshot.latestRunKind),
                retryAttempt:
                  typeof snapshot.retryAttempt === "number" &&
                  Number.isFinite(snapshot.retryAttempt)
                    ? snapshot.retryAttempt
                    : null,
                retryDelayMs:
                  typeof snapshot.retryDelayMs === "number" &&
                  Number.isFinite(snapshot.retryDelayMs)
                    ? snapshot.retryDelayMs
                    : null,
                retryError: nonEmptyString(snapshot.retryError),
              }
            : null,
      },
      {
        id: "orchestrator.noop",
        priority: 1_000,
        evaluate: (snapshot) => ({
          transitionKind: "noop",
          reason: `no_transition_for_${snapshot.candidateSource}`,
        }),
      },
    ]);
  }

  private createMergePolicyTransitionRulesets(): TransitionRuleset[] {
    const transitionKinds: Array<
      Exclude<
        IssueTransitionKind,
        "merge_queue_claim" | "merge_policy" | "record_evidence" | "noop"
      >
    > = [
      "merge_policy_wait_conflict_state",
      "merge_policy_retire_stale_gate",
      "merge_policy_mark_head_superseded",
      "merge_policy_refresh_conflict_base",
      "merge_policy_wait_active_blocked_gate",
      "merge_policy_wait_repair_clearance",
      "merge_policy_refresh_same_gate_blocker",
      "merge_policy_observe_checks_pending",
      "merge_policy_auto_resolve_gate",
      "merge_policy_prepare_conflict",
      "merge_policy_dispatch_repair",
      "merge_policy_block_failure",
      "merge_policy_merge_pull_request",
      "merge_policy_recover_already_merged_pull_request",
    ];
    return [
      {
        id: "orchestrator.merge_queue.claim",
        priority: issueTransitionRulesetPriority("merge_queue_claim"),
        evaluate: (snapshot) => {
          if (this.rulesetShouldWaitForMergeQueue(snapshot)) {
            return {
              transitionKind: "noop",
              reason: "merge_queue_active_issue",
            };
          }
          return this.rulesetShouldClaimMergeQueue(snapshot)
            ? {
                transitionKind: "merge_queue_claim",
                reason: "merge_queue_claim",
              }
            : null;
        },
      },
      {
        id: "orchestrator.merge_policy.reset_operator_resume",
        priority: issueTransitionRulesetPriority(
          "merge_policy_reset_operator_resume",
        ),
        evaluate: (snapshot) =>
          this.rulesetCanReconcileMergePolicy(snapshot) &&
          this.rulesetShouldResetMergePolicyOperatorResume(snapshot)
            ? {
                transitionKind: "merge_policy_reset_operator_resume",
                reason: "merge_policy_source_state_resume",
              }
            : null,
      },
      {
        id: "orchestrator.merge_policy.write_done_state",
        priority: issueTransitionRulesetPriority(
          "merge_policy_write_done_state",
        ),
        evaluate: (snapshot) =>
          this.rulesetCanReconcileMergePolicy(snapshot) &&
          this.rulesetShouldWriteMergePolicyDoneState(snapshot)
            ? {
                transitionKind: "merge_policy_write_done_state",
                reason: "merge_policy_done_writeback_recovery",
              }
            : null,
      },
      {
        id: "orchestrator.merge_policy.observe",
        priority: issueTransitionRulesetPriority("merge_policy_observe"),
        evaluate: (snapshot) =>
          this.rulesetCanReconcileMergePolicy(snapshot) &&
          snapshot.currentMergePolicyObservationInputFingerprint !== null &&
          !this.rulesetFreshMergePolicyObservation(snapshot)
            ? {
                transitionKind: "merge_policy_observe",
                reason: "merge_policy_live_observation_required",
                mergePolicyObservationInputFingerprint:
                  snapshot.currentMergePolicyObservationInputFingerprint,
              }
            : null,
      },
      ...transitionKinds.map((kind) => ({
        id: `orchestrator.${kind}`,
        priority: issueTransitionRulesetPriority(kind),
        evaluate: (snapshot: IssueCurrentStateSnapshot) => {
          if (!this.rulesetCanReconcileMergePolicy(snapshot)) return null;
          const observation = this.rulesetMergePolicyObservation(snapshot);
          if (observation === null || observation.status !== "ready")
            return null;
          const request = mergePolicyTransitionRequestFromObservation(
            snapshot,
            observation,
          );
          if (request === null || request.transitionKind !== kind) return null;
          return this.baseRefGuardedTransitionRequest(snapshot, {
            ...request,
            reason: observation.reason ?? kind,
            mergePolicyObservationInputFingerprint:
              observation.inputFingerprint,
          });
        },
      })),
    ];
  }

  private baseRefGuardedTransitionRequest(
    snapshot: IssueCurrentStateSnapshot,
    targetRequest: IssueTransitionRequest,
  ): IssueTransitionRequest {
    if (!this.rulesetShouldGuardBaseRef(snapshot, targetRequest)) {
      return targetRequest;
    }
    const expectedFingerprint = this.baseRefObservationFingerprintForSnapshot(
      snapshot,
      targetRequest.transitionKind,
    );
    const chainContext =
      snapshot.transitionRequestContext?.kind === "base_ref_chain"
        ? snapshot.transitionRequestContext
        : null;
    const observation = snapshot.lastBaseRefObservation ?? null;
    if (
      chainContext?.payload.targetTransitionKind ===
        targetRequest.transitionKind &&
      observation !== null &&
      observation.operation === targetRequest.transitionKind &&
      observation.inputFingerprint === expectedFingerprint
    ) {
      if (observation.classification === "ok") return targetRequest;
      const blockedReason = baseRefBlockedReason(observation);
      if (baseRefObservationCanRepairByRebase(observation)) {
        return {
          transitionKind: "base_ref_repair",
          reason: blockedReason,
          baseRefObservationFingerprint: observation.inputFingerprint,
          baseRefObservationClassification: observation.classification,
        };
      }
      return {
        transitionKind: "base_ref_block",
        reason: blockedReason,
        blockedReason,
        runId: snapshot.latestRunId ?? snapshot.issueId,
        baseRefObservationFingerprint: observation.inputFingerprint,
        baseRefObservationClassification: observation.classification,
      };
    }
    return {
      transitionKind: "base_ref_observe",
      reason: "base_ref_observation_required",
      baseRefTargetTransitionKind: targetRequest.transitionKind,
      baseRefTargetRequest: targetRequest,
    };
  }

  private rulesetShouldGuardBaseRef(
    snapshot: IssueCurrentStateSnapshot,
    targetRequest: IssueTransitionRequest,
  ): boolean {
    if (!BASE_REF_GUARDED_TRANSITION_KINDS.has(targetRequest.transitionKind))
      return false;
    if (
      targetRequest.transitionKind === "dispatch_worker" &&
      targetRequest.runPhase === "merge_conflict_resolution"
    ) {
      return false;
    }
    if (!snapshot.lifecyclePersistenceAvailable) return false;
    const workspacePath = nonEmptyString(snapshot.latestWorkspacePath);
    if (workspacePath === null || !workspaceLooksLikeGitWorktree(workspacePath))
      return false;
    if (
      nonEmptyString(snapshot.latestGitBranchName) === null &&
      nonEmptyString(snapshot.latestPrBranch) === null &&
      nonEmptyString(snapshot.branchName) === null
    ) {
      return false;
    }
    return (
      nonEmptyString(snapshot.latestBaseRef) !== null ||
      nonEmptyString(this.config.workspace.source.baseRef) !== null
    );
  }

  private rulesetShouldRestorePreservedStashes(
    snapshot: IssueCurrentStateSnapshot,
  ): boolean {
    if (snapshot.triggerType !== "orchestrator.tick") return false;
    if (!snapshot.lifecyclePersistenceAvailable) return false;
    if (snapshot.running || snapshot.paused || snapshot.claimed) return false;
    if (isStateIn(snapshot.trackerState, this.config.tracker.terminalStates))
      return false;
    if (!hasRestorablePreservedWorktreeStashes(snapshot)) return false;
    const targetRequest = dispatchTransitionRequest({
      role: "worker",
      runPhase: "implementation",
      reason: "preserved_worktree_stash_restore_probe",
      promptScenario: promptScenarioForDispatch(
        "worker",
        "implementation",
        false,
      ),
    });
    if (!this.rulesetShouldGuardBaseRef(snapshot, targetRequest)) return true;
    return snapshot.lastBaseRefObservationClassification === "ok";
  }

  private baseRefObservationFingerprintForSnapshot(
    snapshot: IssueCurrentStateSnapshot,
    targetTransitionKind: IssueTransitionKind,
  ): string {
    return baseRefObservationInputFingerprint({
      workspacePath: nonEmptyString(snapshot.latestWorkspacePath),
      branchName:
        nonEmptyString(snapshot.latestGitBranchName) ??
        nonEmptyString(snapshot.latestPrBranch) ??
        nonEmptyString(snapshot.branchName),
      baseRef:
        nonEmptyString(snapshot.latestBaseRef) ??
        nonEmptyString(this.config.workspace.source.baseRef),
      operation: targetTransitionKind,
    });
  }

  private versionTransitionRulesets(
    rulesets: readonly TransitionRuleset[],
  ): TransitionRuleset[] {
    return rulesets.map((ruleset) => ({
      ...ruleset,
      version: ORCHESTRATOR_RULESET_VERSION,
      fingerprint: `${ruleset.id}@${ORCHESTRATOR_RULESET_VERSION}:${ruleset.priority}`,
    }));
  }

  private rulesetCanDispatchWorker(
    snapshot: IssueCurrentStateSnapshot,
    runPhase: AgentRunPhase,
  ): boolean {
    if (!this.rulesetCommonDispatchGate(snapshot)) return false;
    if (!snapshot.assignedToWorker) return false;
    if (isStateIn(snapshot.trackerState, this.config.tracker.handoffStates))
      return false;
    if (isStateIn(snapshot.trackerState, this.config.reviewLoop.reviewStates))
      return false;
    if (isStateIn(snapshot.trackerState, this.config.reviewLoop.blockedStates))
      return false;
    if (isStateIn(snapshot.trackerState, this.config.tracker.terminalStates))
      return false;
    if (this.rulesetBlockedByLifecycle(snapshot)) return false;
    if (
      !this.isWorkerStateActiveForRunPhase(snapshotAsIssue(snapshot), runPhase)
    )
      return false;
    if (snapshot.hasChildren) return false;
    if (!this.rulesetPassesLabelGuardrails(snapshot, "worker")) return false;
    if (
      runPhase === "implementation" &&
      snapshot.incompleteTurnCount >= this.config.reviewLoop.maxIncompleteTurns
    )
      return false;
    if (runPhase === "merge_conflict_resolution") {
      const conflict = snapshot.mergeConflict;
      if (!conflict || conflict.status !== "open") return false;
      if (conflict.fixTurnCount >= conflict.maxFixTurns) return false;
    }
    if (
      runPhase === "implementation" &&
      this.config.issueBreakdown.enabled &&
      this.rulesetHasPlanningLabel(snapshot)
    ) {
      if (!snapshot.lifecyclePersistenceAvailable) return false;
      if (!this.rulesetHasFreshIssueBreakdownPlan(snapshot)) return false;
    }
    if (
      snapshot.trackerState.toLowerCase() === "todo" &&
      hasOpenBlocker(
        snapshotAsIssue(snapshot),
        this.config.tracker.terminalStates,
      )
    ) {
      return false;
    }
    return true;
  }

  private rulesetCanDispatchReviewer(
    snapshot: IssueCurrentStateSnapshot,
  ): boolean {
    if (!this.rulesetCommonDispatchGate(snapshot)) return false;
    if (!isStateIn(snapshot.trackerState, this.config.reviewLoop.reviewStates))
      return false;
    if (isStateIn(snapshot.trackerState, this.config.reviewLoop.blockedStates))
      return false;
    if (isStateIn(snapshot.trackerState, this.config.tracker.terminalStates))
      return false;
    if (this.rulesetBlockedByLifecycle(snapshot)) return false;
    if (!this.rulesetPassesLabelGuardrails(snapshot, "reviewer")) return false;
    if (
      hasOpenBlocker(
        snapshotAsIssue(snapshot),
        this.config.tracker.terminalStates,
      )
    )
      return false;
    if (
      snapshot.reviewRound >=
      this.config.reviewLoop.failureLimits.reviewerFailures
    )
      return false;
    return true;
  }

  private rulesetCanDispatchIssueTriage(
    snapshot: IssueCurrentStateSnapshot,
  ): boolean {
    if (
      !this.config.issueTriage.enabled ||
      !snapshot.lifecyclePersistenceAvailable
    )
      return false;
    if (!this.rulesetCommonDispatchGate(snapshot)) return false;
    const reviewBlockedTriage =
      isStateIn(snapshot.trackerState, this.config.reviewLoop.reviewStates) &&
      isReviewerBlockedTriageReason(snapshot.blockedReason);
    if (
      !isStateIn(snapshot.trackerState, this.config.reviewLoop.blockedStates) &&
      !reviewBlockedTriage
    )
      return false;
    if (isStateIn(snapshot.trackerState, this.config.tracker.terminalStates))
      return false;
    if (!isIssueTriageBlockedReason(snapshot.blockedReason)) return false;
    if (
      snapshot.issueTriageCurrentTriggerReportIds.length >=
      this.config.issueTriage.maxAttemptsPerTrigger
    )
      return false;
    return this.rulesetPassesLabelGuardrails(snapshot, "triage");
  }

  private rulesetCanDispatchPostMortem(
    snapshot: IssueCurrentStateSnapshot,
  ): boolean {
    if (
      !this.config.postMortem.enabled ||
      !snapshot.lifecyclePersistenceAvailable
    )
      return false;
    if (!this.rulesetCommonDispatchGate(snapshot)) return false;
    if (!isStateIn(snapshot.trackerState, this.config.postMortem.doneStates))
      return false;
    if (
      snapshot.latestCompletionReport === null ||
      snapshot.latestApprovalPassVerdict === null
    )
      return false;
    if (
      snapshot.postMortemCurrentTriggerReportIds.length >=
      this.config.postMortem.maxAttemptsPerTrigger
    )
      return false;
    return this.rulesetPassesLabelGuardrails(snapshot, "post_mortem");
  }

  private rulesetCanDispatchPlanner(
    snapshot: IssueCurrentStateSnapshot,
  ): boolean {
    if (
      !this.config.issueBreakdown.enabled ||
      !snapshot.lifecyclePersistenceAvailable
    )
      return false;
    if (!this.rulesetCommonDispatchGate(snapshot)) return false;
    if (!snapshot.assignedToWorker) return false;
    if (this.isMergeConflictState(snapshot.trackerState)) return false;
    if (isStateIn(snapshot.trackerState, this.config.tracker.terminalStates))
      return false;
    if (
      !isStateIn(snapshot.trackerState, this.config.tracker.activeStates) &&
      !isStateIn(snapshot.trackerState, this.config.reviewLoop.blockedStates)
    ) {
      return false;
    }
    if (
      this.rulesetBlockedByLifecycle(snapshot) &&
      !this.rulesetPlannerAllowedFromBlocked(snapshot)
    )
      return false;
    if (
      isStateIn(snapshot.trackerState, this.config.reviewLoop.blockedStates) &&
      !this.rulesetPlannerAllowedFromBlocked(snapshot)
    )
      return false;
    if (snapshot.hasChildren) return false;
    if (!this.rulesetPassesLabelGuardrails(snapshot, "planner")) return false;
    if (
      snapshot.trackerState.toLowerCase() === "todo" &&
      hasOpenBlocker(
        snapshotAsIssue(snapshot),
        this.config.tracker.terminalStates,
      )
    ) {
      return false;
    }
    if (
      snapshot.planningFailureCount >=
      this.config.issueBreakdown.maxPlanningFailures
    )
      return false;
    if (this.rulesetPlanningBackoffActive(snapshot)) return false;
    return true;
  }

  private rulesetShouldResetMergeConflictAfterOperatorResume(
    snapshot: IssueCurrentStateSnapshot,
  ): boolean {
    if (snapshot.triggerType !== "orchestrator.tick") return false;
    if (!this.rulesetCommonDispatchGate(snapshot)) return false;
    const conflict = snapshot.mergeConflict;
    return Boolean(
      conflict &&
      this.config.mergePolicy.conflictsState !== null &&
      isStateIn(snapshot.trackerState, [
        this.config.mergePolicy.conflictsState,
      ]) &&
      (conflict.status === "blocked" ||
        conflict.resolutionStatus === "blocked"),
    );
  }

  private rulesetShouldBlockMergeConflictAttemptLimit(
    snapshot: IssueCurrentStateSnapshot,
  ): boolean {
    if (snapshot.triggerType !== "orchestrator.tick") return false;
    if (!this.isMergeConflictState(snapshot.trackerState)) return false;
    const conflict = snapshot.mergeConflict;
    if (!conflict) return false;
    if (
      conflict.status === "blocked" ||
      conflict.resolutionStatus === "blocked"
    )
      return false;
    return conflict.status === "open" && conflict.fixTurnCount >= conflict.maxFixTurns;
  }

  private rulesetShouldResetLifecycleAfterOperatorResume(
    snapshot: IssueCurrentStateSnapshot,
  ): boolean {
    if (snapshot.triggerType !== "orchestrator.tick") return false;
    if (!this.rulesetBlockedByLifecycle(snapshot)) return false;
    if (
      isReviewerBlockedTriageReason(snapshot.blockedReason) &&
      !isStateIn(snapshot.trackerState, this.config.tracker.activeStates)
    )
      return false;
    if (isPendingPublicationApprovalReason(snapshot.blockedReason))
      return false;
    if (this.config.reviewLoop.blockedStates.length === 0) return false;
    if (isStateIn(snapshot.trackerState, this.config.reviewLoop.blockedStates))
      return false;
    if (this.rulesetIsMergePolicyTrackedState(snapshot)) return false;
    return true;
  }

  private rulesetShouldRecoverMergeGateHeadSupersession(
    snapshot: IssueCurrentStateSnapshot,
  ): boolean {
    if (snapshot.triggerType !== "orchestrator.tick") return false;
    if (!isStateIn(snapshot.trackerState, this.config.tracker.activeStates))
      return false;
    if (this.config.reviewLoop.reviewPassState === null) return false;
    if (snapshot.phase !== "implementation") return false;
    if (snapshot.lifecycleSummaryCiStatus !== "head_superseded") return false;
    const gate = snapshot.mergeGate;
    const report = snapshot.latestCompletionReport;
    const verdict = snapshot.latestApprovalPassVerdict;
    const reportHeadSha = report?.pullRequest?.headSha?.trim() ?? "";
    if (
      gate === null ||
      gate.status !== "superseded" ||
      gate.supersededByHeadSha === null
    )
      return false;
    if (
      report === null ||
      report.pullRequest === null ||
      reportHeadSha.length === 0
    )
      return false;
    if (reportHeadSha !== gate.supersededByHeadSha) return false;
    if (
      snapshot.latestPrHeadSha !== null &&
      snapshot.latestPrHeadSha !== reportHeadSha
    )
      return false;
    return verdict !== null;
  }

  private rulesetShouldReboundIssueTriageBlocked(
    snapshot: IssueCurrentStateSnapshot,
  ): boolean {
    if (snapshot.triggerType !== "orchestrator.tick") return false;
    if (!isStateIn(snapshot.trackerState, this.config.tracker.activeStates))
      return false;
    if (snapshot.phase !== "implementation") return false;
    if (snapshot.mergeGate === null || snapshot.mergeGate.status !== "blocked")
      return false;
    const activeBlockers = this.rulesetActiveIssueTriageBlockers(snapshot);
    if (activeBlockers.length === 0) return false;
    return !activeBlockers.every((blocker) => blocker.nextActor === "worker");
  }

  private rulesetShouldBlockPlanningFailureLimit(
    snapshot: IssueCurrentStateSnapshot,
  ): boolean {
    if (snapshot.triggerType !== "orchestrator.tick") return false;
    if (
      !this.config.issueBreakdown.enabled ||
      !snapshot.lifecyclePersistenceAvailable
    )
      return false;
    if (!snapshot.assignedToWorker || snapshot.hasChildren) return false;
    if (
      !isStateIn(snapshot.trackerState, this.config.tracker.activeStates) &&
      !isStateIn(snapshot.trackerState, this.config.reviewLoop.blockedStates)
    ) {
      return false;
    }
    return (
      snapshot.planningFailureCount >=
      this.config.issueBreakdown.maxPlanningFailures
    );
  }

  private rulesetShouldBlockWorkerIncompleteTurnLimit(
    snapshot: IssueCurrentStateSnapshot,
  ): boolean {
    if (snapshot.triggerType !== "orchestrator.tick") return false;
    if (!isStateIn(snapshot.trackerState, this.config.tracker.activeStates))
      return false;
    if (snapshot.phase === "blocked" || snapshot.blockedReason !== null)
      return false;
    if (
      this.config.issueBreakdown.enabled &&
      this.rulesetHasPlanningLabel(snapshot) &&
      !this.rulesetHasFreshIssueBreakdownPlan(snapshot)
    ) {
      return false;
    }
    return (
      snapshot.incompleteTurnCount >= this.config.reviewLoop.maxIncompleteTurns
    );
  }

  private rulesetShouldBlockReviewerFailureLimit(
    snapshot: IssueCurrentStateSnapshot,
  ): boolean {
    if (snapshot.triggerType !== "orchestrator.tick") return false;
    if (!isStateIn(snapshot.trackerState, this.config.reviewLoop.reviewStates))
      return false;
    if (snapshot.phase === "blocked" || snapshot.blockedReason !== null)
      return false;
    return (
      snapshot.reviewRound >=
      this.config.reviewLoop.failureLimits.reviewerFailures
    );
  }

  private rulesetBlockedByLifecycle(
    snapshot: IssueCurrentStateSnapshot,
  ): boolean {
    return snapshot.phase === "blocked" || snapshot.blockedReason !== null;
  }

  private rulesetPlannerAllowedFromBlocked(
    snapshot: IssueCurrentStateSnapshot,
  ): boolean {
    return (
      isStateIn(snapshot.trackerState, this.config.reviewLoop.blockedStates) &&
      this.rulesetHasActiveIssueTriageBlocker(
        snapshot,
        "under_specified_needs_decomposition",
      )
    );
  }

  private rulesetPlanningBackoffActive(
    snapshot: IssueCurrentStateSnapshot,
  ): boolean {
    if (snapshot.planningRetryDueAt === null) return false;
    const dueAtMs = Date.parse(snapshot.planningRetryDueAt);
    const snapshotAtMs = Date.parse(snapshot.snapshotAt);
    return (
      Number.isFinite(dueAtMs) &&
      Number.isFinite(snapshotAtMs) &&
      dueAtMs > snapshotAtMs
    );
  }

  private rulesetActiveIssueTriageBlockers(
    snapshot: IssueCurrentStateSnapshot,
  ): IssueTriageBlockerRecord[] {
    return snapshot.latestIssueTriageReportBlockers.filter(
      (blocker) => blocker.status === "active",
    );
  }

  private rulesetHasActiveIssueTriageBlocker(
    snapshot: IssueCurrentStateSnapshot,
    kind: IssueTriageBlockerKind,
  ): boolean {
    return this.rulesetActiveIssueTriageBlockers(snapshot).some(
      (blocker) => blocker.kind === kind,
    );
  }

  private rulesetCanReconcileMergePolicy(
    snapshot: IssueCurrentStateSnapshot,
  ): boolean {
    const triggerAllowed =
      snapshot.triggerType === "orchestrator.tick" ||
      (snapshot.triggerType === "runtime.requested" &&
        snapshot.triggerSource === "transition" &&
        snapshot.transitionRequestContext?.kind === "merge_policy_chain");
    if (!triggerAllowed) return false;
    if (snapshot.mergePolicyMode !== "gated") return false;
    if (!this.rulesetIsMergePolicyTrackedState(snapshot)) return false;
    if (
      this.rulesetIsMergePolicySourceState(snapshot) &&
      snapshot.mergeQueueStatus !== "active_current_issue"
    ) {
      return false;
    }
    if (snapshot.running || snapshot.paused) return false;
    return this.rulesetPassesLabelGuardrails(snapshot, "merge_policy");
  }

  private rulesetCanEnterMergeQueue(
    snapshot: IssueCurrentStateSnapshot,
  ): boolean {
    const triggerAllowed =
      snapshot.triggerType === "orchestrator.tick" ||
      (snapshot.triggerType === "runtime.requested" &&
        snapshot.triggerSource === "transition" &&
        snapshot.transitionRequestContext?.kind === "merge_policy_chain");
    if (!triggerAllowed) return false;
    if (snapshot.mergePolicyMode !== "gated") return false;
    if (!this.rulesetIsMergePolicySourceState(snapshot)) return false;
    if (snapshot.running || snapshot.paused) return false;
    return this.rulesetPassesLabelGuardrails(snapshot, "merge_policy");
  }

  private rulesetShouldClaimMergeQueue(
    snapshot: IssueCurrentStateSnapshot,
  ): boolean {
    return (
      this.rulesetCanEnterMergeQueue(snapshot) &&
      snapshot.mergeQueueStatus === "inactive"
    );
  }

  private rulesetShouldWaitForMergeQueue(
    snapshot: IssueCurrentStateSnapshot,
  ): boolean {
    return (
      this.rulesetCanEnterMergeQueue(snapshot) &&
      snapshot.mergeQueueStatus === "active_other_issue"
    );
  }

  private rulesetIsMergePolicySourceState(
    snapshot: IssueCurrentStateSnapshot,
  ): boolean {
    return (
      snapshot.mergePolicyMode === "gated" &&
      isStateIn(snapshot.trackerState, snapshot.mergePolicySourceStates)
    );
  }

  private rulesetIsMergePolicyTrackedState(
    snapshot: IssueCurrentStateSnapshot,
  ): boolean {
    if (snapshot.mergePolicyMode !== "gated") return false;
    if (isStateIn(snapshot.trackerState, snapshot.mergePolicySourceStates))
      return true;
    return (
      snapshot.mergePolicyConflictsState !== null &&
      isStateIn(snapshot.trackerState, [snapshot.mergePolicyConflictsState])
    );
  }

  private rulesetShouldResetMergePolicyOperatorResume(
    snapshot: IssueCurrentStateSnapshot,
  ): boolean {
    if (!(snapshot.phase === "blocked" || snapshot.blockedReason !== null))
      return false;
    if (isStateIn(snapshot.trackerState, this.config.reviewLoop.blockedStates))
      return false;
    if (isPendingPublicationApprovalReason(snapshot.blockedReason))
      return false;
    return true;
  }

  private rulesetShouldWriteMergePolicyDoneState(
    snapshot: IssueCurrentStateSnapshot,
  ): boolean {
    const merge = snapshot.mergePolicyMerge;
    if (!merge || typeof merge !== "object" || Array.isArray(merge))
      return false;
    const mergeCommitSha = (merge as { mergeCommitSha?: unknown })
      .mergeCommitSha;
    if (
      typeof mergeCommitSha !== "string" ||
      mergeCommitSha.trim().length === 0
    )
      return false;
    if (
      snapshot.mergePolicyDoneState !== null &&
      statesEqual(snapshot.trackerState, snapshot.mergePolicyDoneState)
    )
      return false;
    return true;
  }

  private rulesetFreshMergePolicyObservation(
    snapshot: IssueCurrentStateSnapshot,
  ): boolean {
    return this.rulesetMergePolicyObservation(snapshot) !== null;
  }

  private rulesetMergePolicyObservation(
    snapshot: IssueCurrentStateSnapshot,
  ): MergePolicyObservation | null {
    const observation = mergePolicyObservationFromUnknown(
      snapshot.lastMergePolicyObservation,
    );
    if (!observation) return null;
    if (snapshot.currentMergePolicyObservationInputFingerprint === null)
      return null;
    return observation.inputFingerprint ===
      snapshot.currentMergePolicyObservationInputFingerprint
      ? observation
      : null;
  }

  private rulesetCommonDispatchGate(
    snapshot: IssueCurrentStateSnapshot,
  ): boolean {
    if (snapshot.availableSlots <= 0) return false;
    if (snapshot.providerDispatchGateActive) return false;
    if (snapshot.running) return false;
    if (snapshot.paused) return false;
    if (this.rulesetRetryBackoffActive(snapshot)) return false;
    if (!snapshot.allowExistingClaim && snapshot.claimed) return false;
    return snapshot.stateSlotAvailable;
  }

  private rulesetRetryBackoffActive(
    snapshot: IssueCurrentStateSnapshot,
  ): boolean {
    if (!snapshot.retrying) return false;
    const dueAt = snapshot.planningRetryDueAt ?? snapshot.runtimeRetryDueAt;
    if (dueAt === null) return true;
    const dueAtMs = Date.parse(dueAt);
    const snapshotAtMs = Date.parse(snapshot.snapshotAt);
    if (!Number.isFinite(dueAtMs) || !Number.isFinite(snapshotAtMs))
      return true;
    return dueAtMs > snapshotAtMs;
  }

  private rulesetPassesLabelGuardrails(
    snapshot: IssueCurrentStateSnapshot,
    role: AgentRunRole | "merge_policy",
  ): boolean {
    return this.passesLabelGuardrails(snapshotAsIssue(snapshot), role);
  }

  private rulesetShouldDispatchPlanner(
    snapshot: IssueCurrentStateSnapshot,
  ): boolean {
    if (!this.config.issueBreakdown.enabled) return false;
    if (!snapshot.assignedToWorker || snapshot.hasChildren) return false;
    if (this.rulesetHasFreshIssueBreakdownPlan(snapshot)) return false;
    if (this.rulesetPlannerAllowedFromBlocked(snapshot)) return true;
    if (this.rulesetHasPlanningLabel(snapshot)) return true;
    return snapshot.planningFailureCount > 0;
  }

  private rulesetPlannerDispatchReason(
    snapshot: IssueCurrentStateSnapshot,
  ): string {
    if (this.rulesetPlannerAllowedFromBlocked(snapshot))
      return "blocked_issue_breakdown_required";
    if (this.rulesetHasPlanningLabel(snapshot))
      return "issue_breakdown_required";
    return "planner_dispatch";
  }

  private rulesetShouldWaitForIssueBreakdownApply(
    snapshot: IssueCurrentStateSnapshot,
  ): boolean {
    if (snapshot.triggerType !== "orchestrator.tick") return false;
    if (!isStateIn(snapshot.trackerState, this.config.tracker.activeStates))
      return false;
    if (
      !this.config.issueBreakdown.enabled ||
      !this.config.issueBreakdown.applyToLinear.enabled
    )
      return false;
    if (!this.rulesetHasFreshIssueBreakdownPlan(snapshot)) return false;
    return this.rulesetHasPlanningLabel(snapshot);
  }

  private rulesetHasPlanningLabel(
    snapshot: IssueCurrentStateSnapshot,
  ): boolean {
    if (this.config.issueBreakdown.planningLabels.length === 0) return false;
    const labels = new Set(snapshot.labels.map((label) => label.toLowerCase()));
    return this.config.issueBreakdown.planningLabels.some((label) =>
      labels.has(label),
    );
  }

  private rulesetHasFreshIssueBreakdownPlan(
    snapshot: IssueCurrentStateSnapshot,
  ): boolean {
    if (snapshot.lastIssueBreakdownPlanId === null) return false;
    if (snapshot.lastIssueBreakdownPlanApplicationStatus === "stale")
      return false;
    if (snapshot.lastIssueBreakdownPlanIssueContentFingerprint === null)
      return false;
    if (snapshot.lastIssueBreakdownPlanIssueContentFingerprint.length === 0)
      return false;
    if (
      snapshot.lastIssueBreakdownPlanIssueContentFingerprint !==
      snapshot.currentIssueContentFingerprint
    )
      return false;
    if (
      snapshot.lastIssueBreakdownPlanConfigFingerprint !==
      snapshot.currentIssueBreakdownConfigFingerprint
    )
      return false;
    return snapshot.lastIssueBreakdownPlanSatisfiesCurrentValidation;
  }

  private runningTerminationRequest(
    snapshot: IssueCurrentStateSnapshot,
  ): IssueTransitionRequest | null {
    if (snapshot.triggerType !== "orchestrator.tick") return null;
    if (!snapshot.running || snapshot.runningRole === null) return null;
    const role = snapshot.runningRole;
    const ignoreState = snapshot.runningManualIgnoreState;
    const terminate = (
      reason: string,
      cleanupWorkspace = false,
    ): IssueTransitionRequest => ({
      transitionKind: "terminate_running",
      reason,
      terminationReason: reason,
      cleanupWorkspace,
      role,
      runPhase: snapshot.runningRunPhase,
      runKind: snapshot.runningRunKind,
      runId: snapshot.latestRunId,
    });
    if (
      role !== "post_mortem" &&
      isStateIn(snapshot.trackerState, this.config.tracker.terminalStates)
    ) {
      return terminate("terminal state", true);
    }
    if (role === "worker" && snapshot.runningHasPendingPublicationApproval) {
      return {
        transitionKind: "noop",
        reason: "awaiting_pending_publication_approval",
      };
    }
    if (
      role === "worker" &&
      !ignoreState &&
      isStateIn(snapshot.trackerState, this.config.tracker.handoffStates)
    ) {
      return terminate("handoff state");
    }
    if (role === "worker" && !snapshot.assignedToWorker)
      return terminate("worker route changed");
    if (
      role === "worker" &&
      !ignoreState &&
      !this.isWorkerStateActiveForRunPhase(
        snapshotAsIssue(snapshot),
        snapshot.runningRunPhase ?? "implementation",
      )
    ) {
      return terminate("non-active state");
    }
    if (
      role === "reviewer" &&
      !ignoreState &&
      isStateIn(snapshot.trackerState, this.config.reviewLoop.blockedStates)
    ) {
      return terminate("blocked state");
    }
    if (
      role === "reviewer" &&
      !ignoreState &&
      !isStateIn(snapshot.trackerState, this.config.reviewLoop.reviewStates)
    ) {
      return terminate("non-review state");
    }
    if (
      role === "triage" &&
      !ignoreState &&
      !isStateIn(snapshot.trackerState, this.config.reviewLoop.blockedStates)
    ) {
      return terminate("non-blocked state");
    }
    if (
      role === "post_mortem" &&
      !ignoreState &&
      !isStateIn(snapshot.trackerState, this.config.postMortem.doneStates)
    ) {
      return terminate("non-post-mortem-done state");
    }
    if (
      role === "planner" &&
      !ignoreState &&
      !isStateIn(snapshot.trackerState, this.config.tracker.activeStates) &&
      !isStateIn(snapshot.trackerState, this.config.reviewLoop.blockedStates)
    ) {
      return terminate("non-planning state");
    }
    if (role === "planner" && !snapshot.assignedToWorker)
      return terminate("planner route changed");
    return null;
  }

  private rulesetShouldReconcileIssueTriageReportWriteback(
    snapshot: IssueCurrentStateSnapshot,
  ): boolean {
    if (snapshot.triggerType !== "orchestrator.tick") return false;
    if (
      !this.config.issueTriage.enabled ||
      !snapshot.lifecyclePersistenceAvailable
    )
      return false;
    if (snapshot.phase !== "blocked") return false;
    if (snapshot.lastIssueTriageReportId === null) return false;
    if (snapshot.lastIssueTriageReportWritebackOperationKeys === null)
      return false;
    if (snapshot.lastIssueTriageReportWritebackOperationKeys.length > 0)
      return false;
    return (
      snapshot.lastIssueTriageReportTriggerFingerprint ===
      snapshot.currentIssueTriageTriggerFingerprint
    );
  }

  private rulesetShouldReconcileIssuePostMortemReportWriteback(
    snapshot: IssueCurrentStateSnapshot,
  ): boolean {
    if (snapshot.triggerType !== "orchestrator.tick") return false;
    if (
      !this.config.postMortem.enabled ||
      !snapshot.lifecyclePersistenceAvailable
    )
      return false;
    if (snapshot.lastPostMortemReportId === null) return false;
    if (snapshot.lastPostMortemReportWritebackOperationKeys === null)
      return false;
    if (snapshot.lastPostMortemReportWritebackOperationKeys.length > 0)
      return false;
    return (
      snapshot.lastPostMortemReportTriggerFingerprint ===
      snapshot.currentPostMortemTriggerFingerprint
    );
  }

  private async decideIssueTransition(input: {
    issue: Issue;
    triggerType: IssueTriggerType;
    triggerSource: IssueTriggerSource;
    candidateSource: string;
    manualStage?: ManualAgentRunStage | null;
    manualForceLabels?: boolean;
    manualIgnoreState?: boolean;
    allowExistingClaim?: boolean;
    snapshotPatch?: Partial<IssueCurrentStateSnapshot>;
    transitionPatch?: Partial<IssueTransitionRequest>;
  }): Promise<IssueHistorySnapshot | null> {
    try {
      const mergeQueueSnapshotPatch =
        await this.mergeQueueSnapshotPatchForIssue(input.issue);
      const snapshot = await this.issueCurrentStateBuilder.buildSnapshot(
        input.issue,
        this.issueRuntimeState(input.issue.id),
        {
          triggerType: input.triggerType,
          triggerSource: input.triggerSource,
          candidateSource: input.candidateSource,
          transitionRequestContext: null,
          availableSlots: this.availableSlots(),
          providerDispatchGateActive: this.activeProviderGates.some((gate) =>
            this.providerGateMatchesConfiguredRuntime(gate),
          ),
          stateSlotAvailable: this.hasStateSlot(input.issue.state),
          allowExistingClaim: input.allowExistingClaim === true,
          manualStage: input.manualStage ?? null,
          manualForceLabels: input.manualForceLabels ?? false,
          manualIgnoreState: input.manualIgnoreState ?? false,
          snapshotPatch: {
            ...mergeQueueSnapshotPatch,
            ...(input.snapshotPatch ?? {}),
          },
        },
      );
      await this.issueStateStore.ensureCurrent(snapshot);
      const transition = this.transitionEngine.decide(snapshot, []);
      if (transition === null) return null;
      const patchedTransition =
        input.transitionPatch === undefined
          ? transition
          : { ...transition, ...input.transitionPatch };
      if (patchedTransition.transitionKind !== "noop") {
        await this.issueStateStore.appendSnapshotOnly(
          input.issue,
          patchedTransition,
        );
      }
      return patchedTransition;
    } catch (error) {
      this.options.logger.warn("issue transition decision failed", {
        issue_id: input.issue.id,
        issue_identifier: input.issue.identifier,
        candidate_source: input.candidateSource,
        error: errorMessage(error),
      });
      return null;
    }
  }

  private async mergeQueueSnapshotPatchForIssue(
    issue: Issue,
  ): Promise<Partial<IssueCurrentStateSnapshot>> {
    if (this.config.mergePolicy.mode !== "gated") return {};
    const snapshot = await this.mergeQueueStore.getCurrent();
    return mergeQueueProjectionForIssue(issue, snapshot);
  }

  private async recordTrackerObservationSnapshot(input: {
    issue: Issue;
    triggerType: IssueTriggerType;
    triggerSource: IssueTriggerSource;
    candidateSource: string;
  }): Promise<void> {
    await this.recordIssueEvidenceSnapshot({
      issue: input.issue,
      evidenceKind: "tracker",
      eventType: "tracker_issue_observed",
      sourceId: input.issue.id,
      reason: "tracker_issue_observed",
      triggerType: input.triggerType,
      triggerSource: input.triggerSource,
      payload: {
        candidateSource: input.candidateSource,
        title: input.issue.title,
        description: input.issue.description,
        state: input.issue.state,
        labels: input.issue.labels,
        branchName: input.issue.branchName,
        url: input.issue.url,
        priority: input.issue.priority,
        assigneeId: input.issue.assigneeId,
        delegateId: input.issue.delegateId,
        assignedToWorker: input.issue.assignedToWorker,
        blockedBy: input.issue.blockedBy,
        hasChildren: input.issue.hasChildren === true,
        createdAt: input.issue.createdAt,
        updatedAt: input.issue.updatedAt,
      },
    });
  }

  private async recordIssueTransition(input: {
    issue: Issue;
    triggerType: IssueTriggerType;
    triggerSource?: IssueTriggerSource;
    candidateSource: string;
    request: IssueTransitionRequest;
    rulesetId?: string;
    rulesetPriority?: number;
    manualStage?: ManualAgentRunStage | null;
    manualForceLabels?: boolean;
    manualIgnoreState?: boolean;
    actions?: TransitionActionRecord[];
  }): Promise<string | null> {
    try {
      const snapshot = await this.issueCurrentStateBuilder.buildSnapshot(
        input.issue,
        this.issueRuntimeState(input.issue.id),
        {
          triggerType: input.triggerType,
          triggerSource:
            input.triggerSource ??
            (input.triggerType === "manual.cli_agent_run"
              ? "manual_cli"
              : "orchestrator"),
          candidateSource: input.candidateSource,
          transitionRequestContext: null,
          availableSlots: this.availableSlots(),
          providerDispatchGateActive: this.activeProviderGates.some((gate) =>
            this.providerGateMatchesConfiguredRuntime(gate),
          ),
          stateSlotAvailable: this.hasStateSlot(input.issue.state),
          allowExistingClaim: false,
          manualStage: input.manualStage ?? null,
          manualForceLabels: input.manualForceLabels ?? false,
          manualIgnoreState: input.manualIgnoreState ?? false,
        },
      );
      await this.issueStateStore.ensureCurrent(snapshot);
      const rulesetId =
        input.rulesetId ?? `orchestrator.${input.request.transitionKind}`;
      const rulesetPriority =
        input.rulesetPriority ??
        issueTransitionRulesetPriority(input.request.transitionKind);
      const ruleset: TransitionRuleset = {
        id: rulesetId,
        priority: rulesetPriority,
        version: ORCHESTRATOR_RULESET_VERSION,
        fingerprint: `${rulesetId}@${ORCHESTRATOR_RULESET_VERSION}:${rulesetPriority}`,
        evaluate: () => input.request,
      };
      const decided = new IssueOrchestrationEngine([ruleset]).decide(
        snapshot,
        [],
      );
      if (!decided) return null;
      const historySnapshot = {
        ...decided,
        actions: input.actions ?? [],
      };
      if (historySnapshot.transitionKind === "noop") return null;
      await this.issueStateStore.appendSnapshotOnly(
        input.issue,
        historySnapshot,
      );
      return historySnapshot.historySnapshotId;
    } catch (error) {
      this.options.logger.warn("issue transition snapshot recording failed", {
        issue_id: input.issue.id,
        issue_identifier: input.issue.identifier,
        transition_kind: input.request.transitionKind,
        error: errorMessage(error),
      });
      return null;
    }
  }

  private async recordIssueEvidenceSnapshot(
    input: IssueEvidenceSnapshotInput,
  ): Promise<string | null> {
    return this.recordIssueTransition({
      issue: input.issue,
      triggerType: input.triggerType ?? "orchestrator.tick",
      ...(input.triggerSource === undefined
        ? {}
        : { triggerSource: input.triggerSource }),
      candidateSource: `evidence.${input.evidenceKind}.${safeEvidenceSegment(input.eventType)}`,
      request: {
        transitionKind: "record_evidence",
        reason: input.reason ?? input.eventType,
        evidenceKind: input.evidenceKind,
        evidenceEventType: input.eventType,
        evidenceSourceId: input.sourceId ?? null,
        evidencePayload: input.payload ?? null,
      },
      rulesetId: `orchestrator.evidence.${input.evidenceKind}`,
      rulesetPriority: issueTransitionRulesetPriority("record_evidence"),
    });
  }

  private async recordRuntimeControlEvidenceForIssueId(
    issueId: string,
    eventType: string,
    input: {
      sourceId?: string | null;
      reason?: string | null;
      retry?: RetryEntry | null;
      claimed?: boolean | null;
      paused?: boolean | null;
      retrying?: boolean | null;
    } = {},
  ): Promise<void> {
    const issue = await this.issueForRuntimeEvidence(issueId);
    if (issue === null) return;
    await this.recordRuntimeControlEvidenceSnapshot({
      issue,
      eventType,
      sourceId: input.sourceId ?? issueId,
      reason: input.reason ?? eventType,
      retry: input.retry ?? null,
      claimed: input.claimed ?? null,
      paused: input.paused ?? null,
      retrying: input.retrying ?? null,
    });
  }

  private async recordRuntimeControlEvidenceSnapshot(input: {
    issue: Issue;
    eventType: string;
    sourceId?: string | null;
    reason?: string | null;
    entry?: RunningEntry | null;
    retry?: RetryEntry | null;
    claimed?: boolean | null;
    paused?: boolean | null;
    retrying?: boolean | null;
  }): Promise<void> {
    const entry = input.entry ?? this.running.get(input.issue.id) ?? null;
    const retry = input.retry ?? this.retryAttempts.get(input.issue.id) ?? null;
    await this.recordIssueEvidenceSnapshot({
      issue: input.issue,
      evidenceKind: "runtime",
      eventType: input.eventType,
      sourceId:
        input.sourceId ??
        entry?.activeRunId ??
        entry?.runId ??
        retry?.issueId ??
        input.issue.id,
      reason: input.reason ?? input.eventType,
      payload: {
        running: this.running.has(input.issue.id),
        role: entry?.role ?? null,
        runPhase: entry?.runPhase ?? null,
        runKind: entry ? runKindForPhase(entry.runPhase) : null,
        runId: entry?.runId ?? null,
        activeRunId: entry?.activeRunId ?? null,
        manualDispatchStage: entry?.manualDispatch?.stage ?? null,
        manualIgnoreState: entry?.manualDispatch?.ignoreState ?? null,
        cancellationRequestedAt:
          entry?.cancellationRequestedAt?.toISOString() ?? null,
        claimed: input.claimed ?? this.claimed.has(input.issue.id),
        paused: input.paused ?? this.pausedIssues.has(input.issue.id),
        retrying: input.retrying ?? this.retryAttempts.has(input.issue.id),
        attempt: retry?.attempt ?? null,
        delayMs: retry?.delayMs ?? null,
        dueAt: retry ? new Date(retry.dueAtMs).toISOString() : null,
        error: retry?.error ?? null,
      },
    });
  }

  private async issueForRuntimeEvidence(issueId: string): Promise<Issue | null> {
    try {
      const [issue] = await this.options.tracker.fetchIssueStatesByIds([
        issueId,
      ]);
      if (issue) return issue;
    } catch (error) {
      this.options.logger.warn("runtime evidence issue lookup failed", {
        issue_id: issueId,
        error: errorMessage(error),
      });
    }
    try {
      const current = await this.issueStateStore.getCurrent(issueId);
      return current === null ? null : currentFieldsAsIssue(current);
    } catch (error) {
      this.options.logger.warn("runtime evidence durable issue lookup failed", {
        issue_id: issueId,
        error: errorMessage(error),
      });
      return null;
    }
  }

  private async releaseIssueClaim(
    issue: Issue,
    reason: string,
    sourceId: string | null = null,
  ): Promise<boolean> {
    const released = this.claimed.delete(issue.id);
    if (!released) return false;
    await this.recordRuntimeControlEvidenceSnapshot({
      issue,
      eventType: "claim_released",
      sourceId: sourceId ?? issue.id,
      reason,
      claimed: false,
    });
    return true;
  }

  private async releaseIssueClaimById(
    issueId: string,
    reason: string,
    sourceId: string | null = null,
  ): Promise<boolean> {
    const released = this.claimed.delete(issueId);
    if (!released) return false;
    await this.recordRuntimeControlEvidenceForIssueId(issueId, "claim_released", {
      sourceId: sourceId ?? issueId,
      reason,
      claimed: false,
    });
    return true;
  }

  private async clearIssueRetry(
    issue: Issue,
    reason: string,
    sourceId: string | null = null,
  ): Promise<RetryEntry | null> {
    const cleared = this.clearRetry(issue.id);
    if (!cleared) return null;
    await this.recordRuntimeControlEvidenceSnapshot({
      issue,
      eventType: "retry_cleared",
      sourceId: sourceId ?? issue.id,
      reason,
      retry: cleared,
      retrying: false,
    });
    return cleared;
  }

  private async clearIssueRetryById(
    issueId: string,
    reason: string,
    sourceId: string | null = null,
  ): Promise<RetryEntry | null> {
    const cleared = this.clearRetry(issueId);
    if (!cleared) return null;
    await this.recordRuntimeControlEvidenceForIssueId(issueId, "retry_cleared", {
      sourceId: sourceId ?? issueId,
      reason,
      retry: cleared,
      retrying: false,
    });
    return cleared;
  }

  private async recordLifecycleEvidenceSnapshot(
    input: LifecycleEvidenceInput,
  ): Promise<void> {
    const pendingPublication = pendingPublicationHandoffForRun(input.lifecycle);
    await this.recordIssueEvidenceSnapshot({
      issue: input.issue,
      evidenceKind: "lifecycle",
      eventType: input.eventType ?? "lifecycle_updated",
      sourceId: input.sourceId ?? null,
      reason: input.reason ?? input.eventType ?? "lifecycle_updated",
      payload: {
        patch: input.patch,
        updatedAt: input.lifecycle.updatedAt,
        phase: input.lifecycle.phase,
        blockedReason: input.lifecycle.blockedReason,
        reviewRound: input.lifecycle.reviewRound,
        incompleteTurnCount: input.lifecycle.incompleteTurnCount,
        planningFailureCount: input.lifecycle.planningFailureCount,
        planningDispatchRetryCount: input.lifecycle.planningDispatchRetryCount,
        lastPlanningFailureAt: input.lifecycle.lastPlanningFailureAt ?? null,
        lastIssueBreakdownPlanId:
          input.lifecycle.lastIssueBreakdownPlanId ?? null,
        issueBreakdownPlans: input.lifecycle.issueBreakdownPlans,
        lastIssueTriageReportId:
          input.lifecycle.lastIssueTriageReportId ?? null,
        issueTriageReports: input.lifecycle.issueTriageReports,
        lastPostMortemReportId: input.lifecycle.lastPostMortemReportId ?? null,
        postMortemReports: input.lifecycle.postMortemReports,
        lastCompletionReportId: input.lifecycle.lastCompletionReportId ?? null,
        lastCompletionReportRejectionId:
          input.lifecycle.lastCompletionReportRejectionId ?? null,
        lastReviewVerdictId: input.lifecycle.lastReviewVerdictId ?? null,
        lastMergeGateResultId: input.lifecycle.lastMergeGateResultId ?? null,
        pendingPublicationApprovalRunId:
          pendingPublication?.pendingReport.runId ?? null,
        pendingPublicationApprovalReportId:
          pendingPublication?.pendingReport.id ?? null,
        pendingPublicationApprovalReason:
          pendingPublication === null
            ? null
            : (input.lifecycle.blockedReason ?? null),
        latestCompletionReport: latestCompletionReport(input.lifecycle),
        latestApprovalPassVerdict: latestCurrentApprovalPassVerdict(
          input.lifecycle,
        ),
        merge: input.lifecycle.merge ?? null,
        mergeGate: input.lifecycle.mergeGate ?? null,
        mergeGateResults: input.lifecycle.mergeGateResults ?? [],
        mergeConflict: input.lifecycle.mergeConflict ?? null,
        reviewFeedback: input.lifecycle.reviewFeedback,
        baseRefObservation: input.lifecycle.baseRefObservation,
        summaryPointers: input.lifecycle.summaryPointers,
      },
    });
  }

  private async updateIssueLifecycleWithEvidence(
    issue: Issue,
    patch: IssueLifecyclePatch,
    reason: string,
    sourceId?: string | null,
  ): Promise<IssueLifecycleRecord | null> {
    const store = this.options.lifecycleStore;
    if (!store) return null;
    const lifecycle = await store.updateIssue(issue, patch);
    await this.recordLifecycleEvidenceSnapshot({
      issue,
      lifecycle,
      patch,
      sourceId: sourceId ?? null,
      reason,
    });
    return lifecycle;
  }

  private issueRuntimeState(issueId: string): IssueCurrentStateRuntimeState {
    const entry = this.running.get(issueId);
    const retry = this.retryAttempts.get(issueId);
    return {
      runningEntry: entry
        ? {
            role: entry.role,
            runPhase: entry.runPhase,
            runId: entry.runId,
            activeRunId: entry.activeRunId,
            manualDispatch: entry.manualDispatch,
            cancellationRequestedAt: entry.cancellationRequestedAt,
          }
        : null,
      running: this.running.has(issueId),
      claimed: this.claimed.has(issueId),
      paused: this.pausedIssues.has(issueId),
      retrying: this.retryAttempts.has(issueId),
      retryDueAt: retry ? new Date(retry.dueAtMs).toISOString() : null,
    };
  }

  private async recordTransitionError(
    entry: RunningEntry,
    error: unknown,
    actionId: string | null = null,
  ): Promise<void> {
    if (entry.issueHistorySnapshotId === null) return;
    try {
      await this.issueStateStore.appendSnapshotErrorOnly(
        entry.issue,
        entry.issueHistorySnapshotId,
        transitionErrorFromUnknown(error, {
          actionId,
          errorType: transitionErrorTypeFor(error),
        }),
      );
    } catch (recordError) {
      this.options.logger.warn("issue transition error recording failed", {
        issue_id: entry.issue.id,
        issue_identifier: entry.issue.identifier,
        history_snapshot_id: entry.issueHistorySnapshotId,
        error: errorMessage(recordError),
      });
    }
  }

  private async processIssueTransitionCandidate(input: {
    issue: Issue;
    candidateSource: string;
    attempt?: number | null;
    allowExistingClaim?: boolean;
    refreshBeforeTransition?: boolean;
  }): Promise<boolean> {
    const result = await this.processIssueTransitionCandidateEvent(input);
    return result.acted;
  }

  private async processIssueTransitionCandidateEvent(input: {
    issue: Issue;
    candidateSource: string;
    attempt?: number | null;
    allowExistingClaim?: boolean;
    refreshBeforeTransition?: boolean;
  }): Promise<IssueTransitionEventResult> {
    const issue =
      input.refreshBeforeTransition === false
        ? input.issue
        : await this.refreshIssueForTransitionCandidate(
            input.issue,
            input.candidateSource,
          );
    if (issue === null) return { transition: null, acted: false };
    await this.recordTrackerObservationSnapshot({
      issue,
      triggerType: "orchestrator.tick",
      triggerSource: "orchestrator",
      candidateSource: input.candidateSource,
    });
    return this.processIssueTransitionEvent({
      issue,
      triggerType: "orchestrator.tick",
      triggerSource: "orchestrator",
      candidateSource: input.candidateSource,
      attempt: input.attempt ?? null,
      allowExistingClaim: input.allowExistingClaim === true,
    });
  }

  private async refreshIssueForTransitionCandidate(
    issue: Issue,
    candidateSource: string,
  ): Promise<Issue | null> {
    try {
      const refreshed = await this.options.tracker.fetchIssueStatesByIds([
        issue.id,
      ]);
      return refreshed[0] ?? null;
    } catch (error) {
      this.options.logger.warn("pre-transition issue refresh failed", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        candidate_source: candidateSource,
        error: errorMessage(error),
      });
      return null;
    }
  }

  private async requestTransition(
    input: RequestedIssueTransitionInput,
  ): Promise<IssueTransitionEventResult> {
    await this.recordTrackerObservationSnapshot({
      issue: input.issue,
      triggerType: "runtime.requested",
      triggerSource: "transition",
      candidateSource: input.candidateSource,
    });
    return this.processIssueTransitionEvent({
      issue: input.issue,
      triggerType: "runtime.requested",
      triggerSource: "transition",
      candidateSource: input.candidateSource,
      snapshotPatch: {
        ...(input.snapshotPatch ?? {}),
        transitionRequestContext: input.context,
      },
      ...(input.transitionPatch === undefined
        ? {}
        : { transitionPatch: input.transitionPatch }),
      attempt: input.attempt ?? null,
      allowExistingClaim: input.allowExistingClaim === true,
    });
  }

  private async processIssueTransitionEvent(
    input: IssueTransitionEventInput,
  ): Promise<IssueTransitionEventResult> {
    const transition = await this.decideIssueTransition({
      issue: input.issue,
      triggerType: input.triggerType,
      triggerSource: input.triggerSource,
      candidateSource: input.candidateSource,
      ...(input.manualStage === undefined
        ? {}
        : { manualStage: input.manualStage }),
      ...(input.manualForceLabels === undefined
        ? {}
        : { manualForceLabels: input.manualForceLabels }),
      ...(input.manualIgnoreState === undefined
        ? {}
        : { manualIgnoreState: input.manualIgnoreState }),
      allowExistingClaim: input.allowExistingClaim === true,
      ...(input.snapshotPatch === undefined
        ? {}
        : { snapshotPatch: input.snapshotPatch }),
      ...(input.transitionPatch === undefined
        ? {}
        : { transitionPatch: input.transitionPatch }),
    });
    if (transition === null || transition.transitionKind === "noop")
      return { transition, acted: false };
    const acted = await this.executeIssueTransition(input.issue, transition, {
      attempt: input.attempt ?? null,
      allowExistingClaim: input.allowExistingClaim === true,
    });
    return { transition, acted };
  }

  private async executeIssueTransition(
    issue: Issue,
    transition: IssueHistorySnapshot,
    options: { attempt: number | null; allowExistingClaim: boolean },
  ): Promise<boolean> {
    const definition = this.transitions.get(transition.transitionKind);
    if (!definition || definition.actions.length === 0) return false;
    const context: OrchestratorTransitionContext = {
      issue,
      transition,
      attempt: options.attempt,
      allowExistingClaim: options.allowExistingClaim,
      dispatch: {},
      baseRef: {},
      reportWriteback: {},
      publicationApproval: {},
      termination: {},
      retry: {},
      blockIssue: {},
      lifecycleReset: {},
      mergeConflictBlock: {},
      headSupersessionRecovery: {},
      triageRebound: {},
      mergePolicy: {},
      handoffRepair: {},
      handoffReconciliation: {},
    };
    let acted = false;
    try {
      for (const action of definition.actions) {
        const actionId = `action:${randomUUID()}`;
        const startedAt = new Date().toISOString();
        const pendingAction = transitionAction({
          actionId,
          actionType: action.id,
          status: "pending",
          startedAt,
          completedAt: null,
        });
        await this.issueStateStore.appendSnapshotActionOnly(
          issue,
          transition.historySnapshotId,
          pendingAction,
        );
        transition.actions = [...transition.actions, pendingAction];
        try {
          if (action.shouldExecute && !(await action.shouldExecute(context))) {
            await this.replaceIssueSnapshotAction(
              issue,
              transition,
              transitionAction({
                actionId,
                actionType: action.id,
                status: "skipped",
                startedAt,
                message: "Action condition did not match",
              }),
            );
            continue;
          }
          const result = await action.execute(context);
          const normalized = normalizeTransitionActionExecutionResult(result);
          await this.replaceIssueSnapshotAction(
            issue,
            transition,
            transitionAction({
              actionId,
              actionType: action.id,
              status: normalized.status,
              startedAt,
              message: normalized.message,
              details: normalized.details,
            }),
          );
          if (result === false || normalized.stop) return acted;
          if (normalized.status === "succeeded") acted = true;
        } catch (error) {
          await this.replaceIssueSnapshotAction(
            issue,
            transition,
            transitionAction({
              actionId,
              actionType: action.id,
              status: "failed",
              startedAt,
              message: errorMessage(error),
            }),
          );
          const transitionError = transitionErrorFromUnknown(error, {
            actionId,
            errorType: transitionErrorTypeFor(error),
            details: { actionType: action.id },
          });
          await this.issueStateStore.appendSnapshotErrorOnly(
            issue,
            transition.historySnapshotId,
            transitionError,
          );
          transition.errors = [...transition.errors, transitionError];
          this.options.logger.warn("issue transition action failed", {
            issue_id: issue.id,
            issue_identifier: issue.identifier,
            transition_kind: transition.transitionKind,
            history_snapshot_id: transition.historySnapshotId,
            action_id: action.id,
            error: errorMessage(error),
          });
          return acted;
        }
      }
      return acted;
    } finally {
      await this.cleanupIssueTransitionContext(context);
    }
  }

  private async cleanupIssueTransitionContext(
    context: OrchestratorTransitionContext,
  ): Promise<void> {
    const writebackOutbox = context.publicationApproval.writebackOutbox;
    if (!writebackOutbox) return;
    delete context.publicationApproval.writebackOutbox;
    await writebackOutbox.close().catch((error) => {
      this.options.logger.warn("issue transition resource cleanup failed", {
        issue_id: context.issue.id,
        issue_identifier: context.issue.identifier,
        transition_kind: context.transition.transitionKind,
        resource: "publication_approval_writeback_outbox",
        error: errorMessage(error),
      });
    });
  }

  private async replaceIssueSnapshotAction(
    issue: Issue,
    transition: IssueHistorySnapshot,
    action: TransitionActionRecord,
  ): Promise<void> {
    let replaced = false;
    const actions = transition.actions.map((candidate) => {
      if (candidate.actionId !== action.actionId) return candidate;
      replaced = true;
      return action;
    });
    const nextActions = replaced ? actions : [...actions, action];
    transition.actions = nextActions;
    await this.issueStateStore.updateSnapshotActionsOnly(
      issue,
      transition.historySnapshotId,
      {
        actions: nextActions,
      },
    );
  }

  private async startupCleanup(): Promise<void> {
    const startedAt = Date.now();
    let workspaces: IssueWorkspaceRecord[];
    try {
      workspaces = await this.options.workspaceManager.listIssueWorkspaces();
    } catch (error) {
      this.options.logger.warn("startup workspace directory scan failed", {
        error: errorMessage(error),
      });
      return;
    }

    this.options.logger.info("startup terminal cleanup started", {
      workspace_count: workspaces.length,
      terminal_states: this.config.tracker.terminalStates,
      concurrency: STARTUP_TERMINAL_CLEANUP_CONCURRENCY,
    });
    const progress = createStartupTerminalCleanupProgressLine();
    progress(`scanning ${workspaces.length} workspace directories`);

    let terminalIssues: Issue[];
    try {
      terminalIssues = await this.fetchStartupTerminalIssuesForWorkspaces(workspaces);
    } catch (error) {
      progress("failed during Linear terminal issue lookup", true);
      this.options.logger.warn("startup terminal issue fetch failed", {
        workspace_count: workspaces.length,
        error: errorMessage(error),
      });
      return;
    }

    const targets = this.matchStartupTerminalCleanupTargets(workspaces, terminalIssues);
    this.options.logger.info("startup terminal cleanup targets selected", {
      workspace_count: workspaces.length,
      terminal_issue_count: terminalIssues.length,
      cleanup_target_count: targets.length,
    });

    if (targets.length === 0) {
      progress(`complete: ${workspaces.length} workspaces, 0 terminal targets`, true);
      this.options.logger.info("startup terminal cleanup completed", {
        workspace_count: workspaces.length,
        terminal_issue_count: terminalIssues.length,
        cleanup_target_count: targets.length,
        workspace_removed_count: 0,
        workspace_failed_count: 0,
        transcript_deleted_count: 0,
        transcript_bytes_removed: 0,
        transcript_failed_count: 0,
        duration_ms: Date.now() - startedAt,
      });
      return;
    }

    const transcriptCleanup =
      this.options.runStore && this.config.transcriptCleanup.terminalStartup.enabled
        ? new RunTranscriptCleanupService({ runStore: this.options.runStore })
        : null;
    let completedCount = 0;
    let workspaceRemovedCount = 0;
    let workspaceFailedCount = 0;
    let transcriptDeletedCount = 0;
    let transcriptBytesRemoved = 0;
    let transcriptFailedCount = 0;
    const renderProgress = () => {
      progress(
        `${completedCount}/${targets.length} targets, removed=${workspaceRemovedCount}, transcripts=${transcriptDeletedCount}, failed=${
          workspaceFailedCount + transcriptFailedCount
        }`,
      );
    };

    renderProgress();
    await mapWithConcurrency(
      targets,
      STARTUP_TERMINAL_CLEANUP_CONCURRENCY,
      async (target) => {
        const result = await this.cleanupStartupTerminalTarget(
          target,
          transcriptCleanup,
        );
        completedCount += 1;
        if (result.workspaceRemoved) workspaceRemovedCount += 1;
        if (result.workspaceFailed) workspaceFailedCount += 1;
        transcriptDeletedCount += result.transcriptsDeleted;
        transcriptBytesRemoved += result.transcriptBytesRemoved;
        if (result.transcriptFailed) transcriptFailedCount += 1;
        renderProgress();
      },
    );
    progress(
      `complete: ${completedCount}/${targets.length} targets, removed=${workspaceRemovedCount}, transcripts=${transcriptDeletedCount}, failed=${
        workspaceFailedCount + transcriptFailedCount
      }`,
      true,
    );
    this.options.logger.info("startup terminal cleanup completed", {
      workspace_count: workspaces.length,
      terminal_issue_count: terminalIssues.length,
      cleanup_target_count: targets.length,
      workspace_removed_count: workspaceRemovedCount,
      workspace_failed_count: workspaceFailedCount,
      transcript_deleted_count: transcriptDeletedCount,
      transcript_bytes_removed: transcriptBytesRemoved,
      transcript_failed_count: transcriptFailedCount,
      duration_ms: Date.now() - startedAt,
    });
  }

  private async fetchStartupTerminalIssuesForWorkspaces(
    workspaces: IssueWorkspaceRecord[],
  ): Promise<Issue[]> {
    if (workspaces.length === 0) return [];
    const terminalStates = uniqueStateNames(this.config.tracker.terminalStates);
    const identifiers = uniqueCaseInsensitiveStrings(
      workspaces.map((workspace) => workspace.issueIdentifier),
    );
    if (
      identifiers.length > 0 &&
      this.options.tracker.fetchIssuesByIdentifiersAndStates
    ) {
      return this.options.tracker.fetchIssuesByIdentifiersAndStates(
        identifiers,
        terminalStates,
      );
    }

    const issueIds = uniqueCaseInsensitiveStrings(
      workspaces
        .map((workspace) => workspace.issueId)
        .filter((issueId): issueId is string => issueId !== null),
    );
    if (issueIds.length === 0) return [];
    const refreshed = await this.options.tracker.fetchIssueStatesByIds(issueIds);
    return refreshed.filter((issue) =>
      isStateIn(issue.state, terminalStates),
    );
  }

  private matchStartupTerminalCleanupTargets(
    workspaces: IssueWorkspaceRecord[],
    terminalIssues: Issue[],
  ): StartupTerminalCleanupTarget[] {
    const workspaceByIssueId = new Map<string, IssueWorkspaceRecord>();
    const workspaceByIdentifier = new Map<string, IssueWorkspaceRecord>();
    for (const workspace of workspaces) {
      if (workspace.issueId) {
        workspaceByIssueId.set(workspace.issueId.toLowerCase(), workspace);
      }
      workspaceByIdentifier.set(
        workspace.issueIdentifier.toLowerCase(),
        workspace,
      );
      workspaceByIdentifier.set(workspace.workspaceKey.toLowerCase(), workspace);
    }

    const seen = new Set<string>();
    const targets: StartupTerminalCleanupTarget[] = [];
    for (const issue of terminalIssues) {
      const workspace =
        workspaceByIssueId.get(issue.id.toLowerCase()) ??
        workspaceByIdentifier.get(issue.identifier.toLowerCase()) ??
        null;
      if (!workspace) continue;
      const key = issue.id.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ issue, workspace });
    }
    return targets;
  }

  private async cleanupStartupTerminalTarget(
    target: StartupTerminalCleanupTarget,
    transcriptCleanup: RunTranscriptCleanupService | null,
  ): Promise<StartupTerminalCleanupResult> {
    const { issue } = target;
    const result: StartupTerminalCleanupResult = {
      workspaceRemoved: false,
      workspaceFailed: false,
      transcriptsDeleted: 0,
      transcriptBytesRemoved: 0,
      transcriptFailed: false,
    };
    try {
      const removed = await this.options.workspaceManager.removeForIssue(issue);
      if (removed) {
        result.workspaceRemoved = true;
        await this.recordIssueEvidenceSnapshot({
          issue,
          evidenceKind: "workspace",
          eventType: "startup_terminal_workspace_removed",
          sourceId: issue.id,
          reason: "startup_terminal_cleanup",
          payload: {
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            trackerState: issue.state,
          },
        });
      }
    } catch (error) {
      result.workspaceFailed = true;
      this.options.logger.warn("startup terminal workspace cleanup failed", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        workspace_key: target.workspace.workspaceKey,
        workspace_path: target.workspace.path,
        error: errorMessage(error),
      });
    }

    if (!transcriptCleanup) return result;
    try {
      const cleanup = await transcriptCleanup.cleanup({
        targets: [
          {
            issueIdOrIdentifier: issue.id,
            issueId: issue.id,
            issueIdentifier: issue.identifier,
          },
        ],
        keepLatestRuns: this.config.transcriptCleanup.terminalStartup.keepLatestRuns,
        apply: true,
        reason: "startup_terminal_cleanup",
      });
      result.transcriptsDeleted = cleanup.totals.deleted;
      result.transcriptBytesRemoved = cleanup.totals.bytesRemoved;
      if (cleanup.totals.deleted > 0) {
        this.options.logger.info("startup terminal transcript cleanup completed", {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          kept_count: cleanup.totals.kept,
          deleted_count: cleanup.totals.deleted,
          bytes_removed: cleanup.totals.bytesRemoved,
        });
        await this.recordIssueEvidenceSnapshot({
          issue,
          evidenceKind: "workspace",
          eventType: "startup_terminal_transcripts_removed",
          sourceId: issue.id,
          reason: "startup_terminal_cleanup",
          payload: {
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            trackerState: issue.state,
            keepLatestRuns: cleanup.keepLatestRuns,
            considered: cleanup.totals.considered,
            kept: cleanup.totals.kept,
            deleted: cleanup.totals.deleted,
            bytesRemoved: cleanup.totals.bytesRemoved,
          },
        });
      }
    } catch (error) {
      result.transcriptFailed = true;
      this.options.logger.warn("startup terminal transcript cleanup failed", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        error: errorMessage(error),
      });
    }
    return result;
  }

  private async cleanupOrphanedRunningRuns(): Promise<void> {
    const runStore = this.options.runStore;
    if (!runStore) return;
    let runs: RunRecord[];
    try {
      runs = await runStore.listRuns();
    } catch (error) {
      this.options.logger.warn("startup orphan run cleanup failed", {
        error: errorMessage(error),
      });
      return;
    }

    const runningRuns = runs.filter((run) => run.status === "running");
    if (runningRuns.length === 0) return;

    const completedAt = new Date().toISOString();
    let cancelled = 0;
    for (const run of runningRuns) {
      await runStore.updateRun(run.runId, {
        status: "cancelled",
        completedAt,
        error:
          "Run cancelled during Symphony startup because no live orchestrator owns it.",
        metadata: {
          cancellationRequestedAt: completedAt,
          cancellationSource: "service_stop",
          cancellationReason:
            "Symphony restarted before this run reached a terminal state.",
          cancellationOutcome: "cancelled",
          ...(run.sdkRunStatus === "running"
            ? {
                sdkRunStatus: "cancelled" as const,
                sdkRunStatusObservedAt: completedAt,
                sdkRunStatusSource: "wait" as const,
              }
            : {}),
        },
      });
      await runStore.appendEvent({
        runId: run.runId,
        at: completedAt,
        source: "orchestrator",
        eventType: "cancelled",
        message: "Run cancelled during Symphony startup",
        payload: {
          kind: "run_cancelled",
          actor: "orchestrator",
          channel: "startup",
          protocol: "service",
          reason: "orphaned_running_run",
          previousStatus: "running",
        },
      });
      cancelled += 1;
    }
    this.options.logger.info("startup orphan running runs cancelled", {
      count: cancelled,
    });
  }

  private async restoreRuntimeControlFromIssueHistory(): Promise<void> {
    let records: IssueCurrentFields[];
    try {
      records = await this.listIssueCurrentFields();
    } catch (error) {
      this.options.logger.warn("startup issue runtime restore failed", {
        error: errorMessage(error),
      });
      return;
    }

    let restoredPauses = 0;
    let releasedRunning = 0;
    let releasedClaims = 0;
    for (const record of records) {
      const issue = currentFieldsAsIssue(record);
      if (record.paused) {
        this.pausedIssues.add(record.issueId);
        restoredPauses += 1;
      }
      if (record.running && !this.running.has(record.issueId)) {
        await this.recordRuntimeControlEvidenceSnapshot({
          issue,
          eventType: "running_entry_released",
          sourceId: record.latestRunId ?? record.issueId,
          reason: "startup_reconciled_stale_running",
          claimed: false,
        });
        releasedRunning += 1;
      }
      if (record.claimed && !this.running.has(record.issueId)) {
        await this.recordRuntimeControlEvidenceSnapshot({
          issue,
          eventType: "claim_released",
          sourceId: record.latestRunId ?? record.issueId,
          reason: "startup_reconciled_stale_claim",
          claimed: false,
        });
        releasedClaims += 1;
      }
    }

    if (restoredPauses > 0 || releasedRunning > 0 || releasedClaims > 0) {
      this.options.logger.info("startup issue runtime restored", {
        restored_pauses: restoredPauses,
        stale_running_released: releasedRunning,
        stale_claims_released: releasedClaims,
      });
    }
  }

  private async listIssueCurrentFields(): Promise<IssueCurrentFields[]> {
    if (this.issueStateStore.listCurrent) {
      return this.issueStateStore.listCurrent();
    }
    return this.issueStateStore.list();
  }

  private async recoverPendingPublicationApprovalHandoffs(): Promise<void> {
    if (
      !this.config.github.publishPullRequests ||
      !(this.config.github.operatorApproval?.requiredForPublication ?? false) ||
      !this.options.lifecycleStore ||
      !this.options.writeback ||
      !this.options.operatorApproval
    ) {
      return;
    }

    let lifecycles: IssueLifecycleRecord[];
    try {
      lifecycles = await this.options.lifecycleStore.list();
    } catch (error) {
      this.options.logger.warn(
        "pending publication approval recovery lifecycle scan failed",
        { error: errorMessage(error) },
      );
      return;
    }
    const candidates = lifecycles.filter(
      hasRecoverablePendingPublicationApproval,
    );
    if (candidates.length === 0) return;

    let latestIssues: Issue[] = [];
    try {
      latestIssues = await this.options.tracker.fetchIssueStatesByIds(
        candidates.map((lifecycle) => lifecycle.issueId),
      );
    } catch (error) {
      this.options.logger.warn(
        "pending publication approval recovery issue refresh failed",
        { error: errorMessage(error) },
      );
    }
    const issuesById = new Map(latestIssues.map((issue) => [issue.id, issue]));

    for (const lifecycle of candidates) {
      const issue =
        issuesById.get(lifecycle.issueId) ??
        issueFromPendingPublicationLifecycle(
          lifecycle,
          this.config.writeback.dispatchState,
        );
      await this.processIssueTransitionCandidate({
        issue,
        candidateSource: "pending_publication_approval",
        refreshBeforeTransition: false,
      });
    }
  }

  private async reconcileRunningIssues(): Promise<void> {
    const runningIds = [...this.running.keys()];
    if (runningIds.length === 0) return;
    let refreshed: Issue[];
    try {
      refreshed = await this.options.tracker.fetchIssueStatesByIds(runningIds);
    } catch (error) {
      this.options.logger.warn("running issue refresh failed", {
        error: errorMessage(error),
      });
      return;
    }

    const byId = new Map(refreshed.map((issue) => [issue.id, issue]));
    for (const [issueId, entry] of this.running) {
      const latest = byId.get(issueId);
      if (!latest) continue;
      entry.issue = latest;
      const preservePendingApprovalWorker =
        entry.role === "worker" &&
        (await this.hasPendingPublicationApprovalHandoff(entry));
      if (preservePendingApprovalWorker) {
        entry.lastMessage = "Awaiting operator approval for push/PR";
      }
      await this.processIssueTransitionCandidate({
        issue: latest,
        candidateSource: "running_reconciliation",
        allowExistingClaim: true,
        refreshBeforeTransition: false,
      });
    }
  }

  private async isAwaitingOperatorApproval(
    entry: RunningEntry,
  ): Promise<boolean> {
    const runId = entry.activeRunId ?? entry.runId;
    if (!runId || !this.options.runStore) return false;
    const run = await this.options.runStore.getRun(runId);
    return Boolean(run?.pendingApprovalRequestId);
  }

  private async hasPendingPublicationApprovalHandoff(
    entry: RunningEntry,
  ): Promise<boolean> {
    const store = this.options.lifecycleStore;
    const runId = entry.activeRunId ?? entry.runId;
    if (!store) return false;
    const lifecycle = await store.get(entry.issue.id);
    const handoff = runId
      ? (pendingPublicationHandoffForRun(lifecycle, { runId }) ??
        pendingPublicationHandoffForRun(lifecycle))
      : pendingPublicationHandoffForRun(lifecycle);
    if (!handoff) return false;
    entry.lifecycle = lifecycle;
    return true;
  }

  private shouldDispatchWorker(
    issue: Issue,
    allowExistingClaim = false,
    runPhase: AgentRunPhase = "implementation",
    options: DispatchGateOptions = {},
  ): boolean {
    if (this.running.has(issue.id)) return false;
    if (this.pausedIssues.has(issue.id)) return false;
    if (!allowExistingClaim && this.claimed.has(issue.id)) return false;
    if (!issue.assignedToWorker) return false;
    if (isStateIn(issue.state, this.config.tracker.handoffStates)) return false;
    if (isStateIn(issue.state, this.config.reviewLoop.reviewStates))
      return false;
    if (isStateIn(issue.state, this.config.reviewLoop.blockedStates))
      return false;
    if (isStateIn(issue.state, this.config.tracker.terminalStates))
      return false;
    if (!this.isWorkerStateActiveForRunPhase(issue, runPhase)) return false;
    if (issue.hasChildren) return false;
    if (!this.passesLabelGuardrails(issue, "worker", options)) return false;
    if (issue.state.toLowerCase() === "todo") {
      if (hasOpenBlocker(issue, this.config.tracker.terminalStates))
        return false;
    }
    return this.hasStateSlot(issue.state);
  }

  private isWorkerStateActiveForRunPhase(
    issue: Issue,
    runPhase: AgentRunPhase,
  ): boolean {
    if (runPhase === "merge_conflict_resolution")
      return this.isMergeConflictState(issue.state);
    if (this.isMergeConflictState(issue.state)) return false;
    return isStateIn(issue.state, this.config.tracker.activeStates);
  }

  private shouldDispatchReviewer(
    issue: Issue,
    allowExistingClaim = false,
    options: DispatchGateOptions = {},
  ): boolean {
    if (this.running.has(issue.id)) return false;
    if (this.pausedIssues.has(issue.id)) return false;
    if (!allowExistingClaim && this.claimed.has(issue.id)) return false;
    if (!isStateIn(issue.state, this.config.reviewLoop.reviewStates))
      return false;
    if (isStateIn(issue.state, this.config.reviewLoop.blockedStates))
      return false;
    if (isStateIn(issue.state, this.config.tracker.terminalStates))
      return false;
    if (!this.passesLabelGuardrails(issue, "reviewer", options)) return false;
    if (hasOpenBlocker(issue, this.config.tracker.terminalStates)) return false;
    return this.hasStateSlot(issue.state);
  }

  private shouldDispatchIssueTriage(
    issue: Issue,
    allowExistingClaim = false,
    options: DispatchGateOptions = {},
  ): boolean {
    if (!this.config.issueTriage.enabled || !this.options.lifecycleStore)
      return false;
    if (this.running.has(issue.id)) return false;
    if (this.pausedIssues.has(issue.id)) return false;
    if (!allowExistingClaim && this.claimed.has(issue.id)) return false;
    if (!isStateIn(issue.state, this.config.reviewLoop.blockedStates))
      return false;
    if (isStateIn(issue.state, this.config.tracker.terminalStates))
      return false;
    if (!this.passesLabelGuardrails(issue, "triage", options)) return false;
    return this.hasStateSlot(issue.state);
  }

  private shouldDispatchPostMortem(
    issue: Issue,
    allowExistingClaim = false,
    options: DispatchGateOptions = {},
  ): boolean {
    if (!this.config.postMortem.enabled || !this.options.lifecycleStore)
      return false;
    if (this.running.has(issue.id)) return false;
    if (this.pausedIssues.has(issue.id)) return false;
    if (!allowExistingClaim && this.claimed.has(issue.id)) return false;
    if (!isStateIn(issue.state, this.config.postMortem.doneStates))
      return false;
    if (!this.passesLabelGuardrails(issue, "post_mortem", options))
      return false;
    return this.hasStateSlot(issue.state);
  }

  private shouldDispatchPlanner(
    issue: Issue,
    allowExistingClaim = false,
    options: DispatchGateOptions = {},
  ): boolean {
    if (!this.config.issueBreakdown.enabled || !this.options.lifecycleStore)
      return false;
    if (this.running.has(issue.id)) return false;
    if (this.pausedIssues.has(issue.id)) return false;
    if (!allowExistingClaim && this.claimed.has(issue.id)) return false;
    if (!issue.assignedToWorker) return false;
    if (this.isMergeConflictState(issue.state)) return false;
    if (isStateIn(issue.state, this.config.tracker.terminalStates))
      return false;
    if (
      !isStateIn(issue.state, this.config.tracker.activeStates) &&
      !isStateIn(issue.state, this.config.reviewLoop.blockedStates)
    ) {
      return false;
    }
    if (issue.hasChildren) return false;
    if (!this.passesLabelGuardrails(issue, "planner", options)) return false;
    if (
      issue.state.toLowerCase() === "todo" &&
      hasOpenBlocker(issue, this.config.tracker.terminalStates)
    )
      return false;
    return this.hasStateSlot(issue.state);
  }

  private async resetFailureBudgetAfterOperatorAction(
    issue: Issue,
    lifecycle: IssueLifecycleRecord,
    reason:
      | "tracker_state_resume"
      | "manual_ignore_state_resume"
      | "merge_conflict_state_resume"
      | "merge_policy_source_state_resume",
    options: { reopenMergeConflict?: boolean } = {},
  ): Promise<IssueLifecycleRecord> {
    const store = this.options.lifecycleStore;
    if (!store) return lifecycle;

    const now = new Date().toISOString();
    const approvalVerdict = latestCurrentApprovalPassVerdict(lifecycle);
    const mergeGate = resetMergeGateFailureBudgetForOperatorAction(
      lifecycle.mergeGate ?? null,
      now,
    );
    const mergeConflict = resetMergeConflictFailureBudgetForOperatorAction(
      lifecycle.mergeConflict,
      now,
      options.reopenMergeConflict === true ||
        (this.config.mergePolicy.conflictsState !== null &&
          isStateIn(issue.state, [this.config.mergePolicy.conflictsState])),
    );
    const lastReviewVerdictId =
      lifecycle.mergeGate !== null &&
      lifecycle.mergeGate !== undefined &&
      lifecycle.lastReviewVerdictId === lifecycle.mergeGate.id &&
      approvalVerdict !== null
        ? approvalVerdict.id
        : lifecycle.lastReviewVerdictId;
    const patch: IssueLifecyclePatch = {
      phase: phaseForIssueState(issue.state, this.config),
      reviewRound: 0,
      incompleteTurnCount: 0,
      blockedReason: null,
      lastIssueTriageReportId: null,
      lastReviewVerdictId,
      mergeGate,
      mergeConflict,
    };
    const updated =
      (await this.updateIssueLifecycleWithEvidence(
        issue,
        patch,
        reason,
        lifecycle.summaryPointers.lastRunId ?? issue.id,
      )) ?? lifecycle;
    this.options.logger.info("operator action reset lifecycle failure budget", {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      issue_state: issue.state,
      reason,
      previous_phase: lifecycle.phase,
      next_phase: updated.phase,
      previous_blocked_reason: lifecycle.blockedReason,
      previous_review_round: lifecycle.reviewRound,
      previous_incomplete_turn_count: lifecycle.incompleteTurnCount,
      previous_merge_gate_round: lifecycle.mergeGate?.reviewRound ?? null,
      next_merge_gate_round: updated.mergeGate?.reviewRound ?? null,
      previous_conflict_fix_turn_count:
        lifecycle.mergeConflict?.fixTurnCount ?? null,
      next_conflict_fix_turn_count: updated.mergeConflict?.fixTurnCount ?? null,
    });
    return updated;
  }

  private async lifecycleDispatchInspection(
    issue: Issue,
    role: AgentRunRole,
    runPhase: AgentRunPhase = defaultRunPhaseForRole(role),
    options: DispatchGateOptions & { manualDispatch?: boolean } = {},
  ): Promise<{ blocked: boolean; explanation: string | null }> {
    const store = this.options.lifecycleStore;
    if (!store)
      return {
        blocked: false,
        explanation:
          "No lifecycle store is configured; lifecycle gates are not applied.",
      };
    const lifecycle = await store.get(issue.id);
    if (!lifecycle)
      return {
        blocked: false,
        explanation: "No lifecycle record exists for this issue.",
      };

    if (role === "triage") {
      const allowed =
        runPhase === "issue_triage" &&
        (options.manualDispatch === true
          ? shouldIssueTriageManualRun(lifecycle, this.config)
          : shouldIssueTriageRun(lifecycle, this.config));
      return {
        blocked: !allowed,
        explanation: allowed
          ? `Issue triage is eligible for blocked reason: ${lifecycle.blockedReason ?? "n/a"}.`
          : `Issue triage is not eligible for lifecycle phase=${lifecycle.phase}, blockedReason=${lifecycle.blockedReason ?? "n/a"}.`,
      };
    }

    if (role === "post_mortem") {
      const allowed =
        runPhase === "post_mortem" &&
        (options.manualDispatch === true
          ? shouldIssuePostMortemManualRun(lifecycle, this.config)
          : shouldIssuePostMortemRun(lifecycle, issue, this.config));
      const fingerprint = issuePostMortemTriggerFingerprint(lifecycle, issue);
      const existing = latestIssuePostMortemReportForFingerprint(
        lifecycle,
        fingerprint,
      );
      return {
        blocked: !allowed,
        explanation: allowed
          ? `Issue post-mortem is eligible for completion/review trigger ${fingerprint}.`
          : existing
            ? `Issue post-mortem already exists for completion/review trigger ${fingerprint}.`
            : "Issue post-mortem is not eligible; it requires enabled config, configured Done state, accepted completion report, and current passing review evidence.",
      };
    }

    const conflict = lifecycle.mergeConflict;
    if (
      conflict &&
      this.config.mergePolicy.conflictsState !== null &&
      isStateIn(issue.state, [this.config.mergePolicy.conflictsState]) &&
      (conflict.status === "blocked" || conflict.resolutionStatus === "blocked")
    ) {
      return {
        blocked: true,
        explanation:
          conflict.blockedReason ??
          mergeConflictBlockedReason(
            conflict.fixTurnCount,
            conflict.maxFixTurns,
          ),
      };
    }

    const blockedByLifecycle =
      lifecycle.phase === "blocked" || lifecycle.blockedReason !== null;
    const plannerAllowedFromBlocked =
      role === "planner" &&
      runPhase === "issue_breakdown" &&
      blockedByLifecycle &&
      isStateIn(issue.state, this.config.reviewLoop.blockedStates) &&
      reportHasActiveTriageBlocker(
        latestIssueTriageReportForFingerprint(
          lifecycle,
          issueTriageTriggerFingerprint(lifecycle),
        ),
        "under_specified_needs_decomposition",
      );
    let explanation: string | null = null;
    if (blockedByLifecycle) {
      if (plannerAllowedFromBlocked) {
        explanation =
          "Lifecycle is blocked, but the latest triage report allows planner decomposition from blocked state.";
      } else {
        if (isPendingPublicationApprovalReason(lifecycle.blockedReason)) {
          return {
            blocked: true,
            explanation:
              lifecycle.blockedReason ?? "Publication approval is pending.",
          };
        }
        if (
          options.ignoreState !== true &&
          (this.config.reviewLoop.blockedStates.length === 0 ||
            isStateIn(issue.state, this.config.reviewLoop.blockedStates))
        ) {
          return {
            blocked: true,
            explanation: lifecycle.blockedReason ?? "Lifecycle is blocked.",
          };
        }
        explanation = `Lifecycle is stale-blocked (${lifecycle.blockedReason ?? "blocked"}); dispatch would clear it for current tracker state ${issue.state}, but inspection is read-only.`;
      }
    }

    if (role === "planner" && runPhase === "issue_breakdown") {
      if (
        lifecycle.planningFailureCount >=
        this.config.issueBreakdown.maxPlanningFailures
      ) {
        return {
          blocked: true,
          explanation: maxPlanningFailuresReason(
            lifecycle.planningFailureCount,
            this.config.issueBreakdown.maxPlanningFailures,
          ),
        };
      }
      const backoffMs = planningBackoffRemainingMs(lifecycle, this.config);
      if (backoffMs > 0) {
        return {
          blocked: true,
          explanation: `Planning retry backoff is active for ${backoffMs}ms.`,
        };
      }
    }
    if (role === "worker" && runPhase === "merge_conflict_resolution") {
      if (!conflict || conflict.status !== "open") {
        return {
          blocked: true,
          explanation:
            "No open merge-conflict lifecycle record is available for conflict resolution.",
        };
      }
      if (conflict.fixTurnCount >= conflict.maxFixTurns) {
        return {
          blocked: true,
          explanation: mergeConflictBlockedReason(
            conflict.fixTurnCount,
            conflict.maxFixTurns,
          ),
        };
      }
    }
    if (
      role === "worker" &&
      runPhase === "implementation" &&
      options.ignoreState !== true &&
      lifecycle.incompleteTurnCount >= this.config.reviewLoop.maxIncompleteTurns
    ) {
      return {
        blocked: true,
        explanation: `max incomplete turns reached (${lifecycle.incompleteTurnCount}/${this.config.reviewLoop.maxIncompleteTurns})`,
      };
    }
    if (
      role === "reviewer" &&
      options.ignoreState !== true &&
      lifecycle.reviewRound >=
        this.config.reviewLoop.failureLimits.reviewerFailures
    ) {
      return {
        blocked: true,
        explanation: `max reviewer failures reached (${lifecycle.reviewRound}/${this.config.reviewLoop.failureLimits.reviewerFailures})`,
      };
    }

    return { blocked: false, explanation };
  }

  private passesLabelGuardrails(
    issue: Issue,
    role: AgentRunRole | "merge_policy",
    options: DispatchGateOptions = {},
  ): boolean {
    const labels = new Set(issue.labels.map((label) => label.toLowerCase()));
    if (this.config.agent.requireLabels.some((label) => !labels.has(label)))
      return false;
    if (
      role === "post_mortem" &&
      this.config.postMortem.requireLabels.some((label) => !labels.has(label))
    )
      return false;
    if (options.ignoreExcludeLabels === true) return true;
    if (this.config.agent.excludeLabels.some((label) => labels.has(label)))
      return false;
    if (
      role === "worker" &&
      this.config.agent.workerExcludeLabels.some((label) => labels.has(label))
    )
      return false;
    if (
      role === "reviewer" &&
      this.config.agent.reviewerExcludeLabels.some((label) => labels.has(label))
    )
      return false;
    if (
      role === "planner" &&
      this.config.agent.plannerExcludeLabels.some((label) => labels.has(label))
    )
      return false;
    if (
      role === "post_mortem" &&
      this.config.postMortem.excludeLabels.some((label) => labels.has(label))
    )
      return false;
    return true;
  }

  private async resolveWorkerDispatchDecision(
    issue: Issue,
  ): Promise<WorkerDispatchDecision> {
    if (this.isMergeConflictState(issue.state))
      return { action: "dispatch", runPhase: "merge_conflict_resolution" };
    if (!this.config.issueBreakdown.enabled)
      return { action: "dispatch", runPhase: "implementation" };
    if (!this.passesIssueBreakdownRouting(issue))
      return { action: "dispatch", runPhase: "implementation" };
    if (!this.options.lifecycleStore)
      return { action: "skip", reason: "planning_required_no_lifecycle_store" };
    const lifecycle = await this.options.lifecycleStore.get(issue.id);
    const plan = latestFreshIssueBreakdownPlan(lifecycle, issue, this.config);
    if (plan === null)
      return { action: "dispatch", runPhase: "issue_breakdown" };
    if (this.config.issueBreakdown.applyToLinear.enabled) {
      return {
        action: "skip",
        reason:
          plan.applicationStatus === "applied"
            ? "issue_breakdown_applied_to_linear"
            : plan.applicationStatus === "blocked"
              ? "issue_breakdown_apply_blocked"
              : "issue_breakdown_apply_required",
      };
    }
    return {
      action: "dispatch",
      runPhase: "implementation",
    };
  }

  private passesIssueBreakdownRouting(issue: Issue): boolean {
    if (this.config.issueBreakdown.planningLabels.length === 0) return false;
    const labels = new Set(issue.labels.map((label) => label.toLowerCase()));
    return this.config.issueBreakdown.planningLabels.some((label) =>
      labels.has(label),
    );
  }

  private isMergeConflictState(state: string): boolean {
    return this.config.mergePolicy.mode === "gated" &&
      this.config.mergePolicy.conflictsState !== null
      ? isStateIn(state, [this.config.mergePolicy.conflictsState])
      : false;
  }

  private createRunningEntry(
    issue: Issue,
    attempt: number | null,
    role: AgentRunRole,
    reviewEvidence: ReviewerDispatchEvidence | null,
    runPhase: AgentRunPhase = defaultRunPhaseForRole(role),
    manualDispatch: RunningEntry["manualDispatch"] = null,
    issueHistorySnapshotId: string | null = null,
  ): RunningEntry {
    const abortController = new AbortController();
    const retryAttempt = attempt ?? 0;
    return {
      issue,
      role,
      runPhase,
      workspacePath: null,
      workspace: null,
      sessionId: null,
      runId: null,
      activeRunId: null,
      issueHistorySnapshotId,
      lifecycle: null,
      worker: Promise.resolve(),
      abortController,
      startedAt: new Date(),
      lastEventAt: null,
      lastEvent: null,
      lastMessage: null,
      sdkRunStatus: null,
      sdkRunStatusUpdatedAt: null,
      sdkRunStatusSource: null,
      failureKind: null,
      failureDiagnosticCode: null,
      failureDiagnosticMessage: null,
      failureDiagnosticAt: null,
      failureDiagnosticPayload: undefined,
      turnCount: 0,
      retryAttempt,
      tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      activeRunTokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      cleanupWorkspaceOnExit: false,
      suppressRetryOnExit: false,
      completionReportAccepted: false,
      mergeConflictResolutionAccepted: false,
      issueBreakdownPlanAccepted: false,
      issueTriageReportAccepted: false,
      issuePostMortemReportAccepted: false,
      pullRequestHandoffAccepted: false,
      reviewVerdictAccepted: false,
      reviewEvidence,
      manualDispatch,
      handoffRepair: null,
      hermesResume: null,
      cancellationRequestedAt: null,
      cancellationSource: null,
      cancellationReason: null,
      abortSignalledAt: null,
      harnessStopRequestedAt: null,
      harnessStopFailedAt: null,
      harnessStopFailedReason: null,
      lastStreamActivityAt: null,
      lastDeltaOrToolActivityAt: null,
      lastToolActivityAt: null,
      providerLimitSignal: null,
    };
  }

  private startRunMonitor(entry: RunningEntry, attempt: number | null): void {
    const run =
      entry.role === "reviewer"
        ? this.runReviewer(entry)
        : entry.role === "triage"
          ? this.runIssueTriage(entry)
          : entry.role === "post_mortem"
            ? this.runIssuePostMortem(entry)
            : this.runWorker(entry, attempt);
    const worker = this.monitorRunExit(entry, run);
    entry.worker = worker;
    this.activeWorkers.add(worker);
    void worker.then(
      () => this.activeWorkers.delete(worker),
      () => this.activeWorkers.delete(worker),
    );
  }

  private async monitorRunExit(
    entry: RunningEntry,
    run: Promise<void>,
  ): Promise<void> {
    const issueId = entry.issue.id;
    try {
      await run;
      await this.onWorkerExit(issueId, "normal", null);
      await this.recordIssueEvidenceSnapshot({
        issue: entry.issue,
        evidenceKind: "run",
        eventType: "agent_run_exit",
        sourceId: entry.activeRunId ?? entry.runId ?? null,
        reason: "agent_run_exit",
        payload: {
          runId: entry.activeRunId ?? entry.runId,
          sessionId: entry.sessionId,
          role: entry.role,
          runPhase: entry.runPhase,
          runKind: runKindForPhase(entry.runPhase),
          tokens: entry.tokens,
        },
      });
    } catch (error) {
      await this.recordTransitionError(entry, error);
      try {
        await this.onWorkerExit(issueId, "abnormal", errorMessage(error));
      } catch (exitError) {
        await this.recordTransitionError(entry, exitError);
        this.options.logger.error("run exit handling failed", {
          issue_id: entry.issue.id,
          issue_identifier: entry.issue.identifier,
          role: entry.role,
          run_id: entry.runId,
          active_run_id: entry.activeRunId,
          error: errorMessage(exitError),
          original_error: errorMessage(error),
        });
        await this.releaseRunningEntryForExit(issueId, entry);
        await this.releaseIssueClaim(
          entry.issue,
          "run_exit_handling_failed_released_claim",
          entry.activeRunId ?? entry.runId ?? issueId,
        );
      }
    }
  }

  private async runWorker(
    entry: RunningEntry,
    attempt: number | null,
  ): Promise<void> {
    let workspace: Workspace | null = null;
    try {
      workspace =
        entry.runPhase === "issue_breakdown"
          ? await this.options.workspaceManager.createForPlanning(entry.issue)
          : await this.options.workspaceManager.createForIssue(entry.issue);
      entry.workspacePath = workspace.path;
      entry.workspace = workspace;
      await this.recordWorkspaceEvidenceSnapshot(
        entry,
        "workspace_created",
        workspace,
        {
          planningWorkspace: entry.runPhase === "issue_breakdown",
        },
      );
      await this.updateLifecycle(
        entry,
        entry.runPhase === "issue_breakdown"
          ? { phase: phaseForIssueState(entry.issue.state, this.config) }
          : {
              phase:
                entry.manualDispatch?.ignoreState === true
                  ? entry.runPhase === "merge_conflict_resolution"
                    ? "merge_conflict_resolution"
                    : "implementation"
                  : phaseForIssueState(entry.issue.state, this.config),
              summaryPointers: {
                workspaceKey: workspace.workspaceKey,
                workspacePath: workspace.path,
                branchName: workspace.gitBranchName ?? null,
                gitBranchName: workspace.gitBranchName ?? null,
                repoPath: workspace.repoPath ?? null,
                baseRef: workspace.baseRef ?? null,
              },
            },
      );
      if (entry.runPhase !== "issue_breakdown") {
        await this.options.workspaceManager.beforeRun(workspace.path);
        await this.recordWorkspaceEvidenceSnapshot(
          entry,
          "workspace_before_run_completed",
          workspace,
        );
      }
      if (
        entry.runPhase === "merge_conflict_resolution" &&
        entry.hermesResume === null
      ) {
        entry.hermesResume =
          await this.resolveMergeConflictOriginalWorkerResume(entry);
      }
      await this.prepareHarnessForRun(entry, workspace, attempt, 1);
      await this.reloadHarnessForRun(entry, workspace, attempt, 1);

      if (entry.runPhase === "issue_breakdown") {
        entry.turnCount = 1;
        const promptBundle = await this.renderIssueBreakdownPromptBundle(
          entry,
          attempt,
        );
        this.assertPromptBundleSupported(promptBundle);
        const context = this.buildRunContext(
          entry,
          workspace,
          attempt,
          1,
          promptBundle,
        );
        await this.consumeHarnessEvents(
          entry,
          this.options.harness.run(context, promptBundle.userPrompt),
          {
            workspace,
            prompt: promptBundle.userPrompt,
            promptBundle,
            attempt,
            turnNumber: 1,
          },
        );
        await this.runHandoffRepairIfNeeded(entry, workspace, attempt, 2);
        return;
      }

      if (
        this.shouldDiscoverPullRequestBeforeFirstWorkerPrompt(entry.lifecycle)
      ) {
        await this.discoverPullRequestForEntry(entry, workspace);
      }

      for (
        let turnNumber = 1;
        turnNumber <= this.config.agent.maxTurns;
        turnNumber += 1
      ) {
        if (entry.abortController.signal.aborted)
          throw new SymphonyError("agent_error", "Run was cancelled");
        if (
          turnNumber > 1 &&
          !harnessSupportsContinuation(this.options.harness)
        ) {
          throw new SymphonyError(
            "agent_error",
            `Harness ${this.options.harness.id} does not support continuation turns`,
          );
        }
        entry.turnCount = turnNumber;
        const promptBundle =
          turnNumber === 1
            ? await this.renderWorkerPromptBundle(entry, attempt, turnNumber)
            : await this.renderWorkerContinuationPromptBundle(
                entry,
                attempt,
                turnNumber,
              );
        this.assertPromptBundleSupported(promptBundle);
        const context = this.buildRunContext(
          entry,
          workspace,
          attempt,
          turnNumber,
          promptBundle,
        );
        await this.consumeHarnessEvents(
          entry,
          this.options.harness.run(context, promptBundle.userPrompt),
          {
            workspace,
            prompt: promptBundle.userPrompt,
            promptBundle,
            attempt,
            turnNumber,
          },
        );
        const repair = await this.runHandoffRepairIfNeeded(
          entry,
          workspace,
          attempt,
          turnNumber + 1,
        );
        if (repair.attempted) break;
        if (
          entry.completionReportAccepted ||
          entry.mergeConflictResolutionAccepted
        )
          break;
        if (
          entry.lifecycle?.phase === "blocked" ||
          (entry.lifecycle?.blockedReason ?? null) !== null
        )
          break;

        const refreshed = await this.options.tracker.fetchIssueStatesByIds([
          entry.issue.id,
        ]);
        const latest = refreshed[0];
        if (latest) {
          entry.issue = latest;
          await this.updateLifecycle(entry, {
            phase:
              entry.manualDispatch?.ignoreState === true
                ? entry.runPhase === "merge_conflict_resolution"
                  ? "merge_conflict_resolution"
                  : "implementation"
                : phaseForIssueState(entry.issue.state, this.config),
          });
        }
        if (
          !entry.issue.assignedToWorker ||
          (entry.manualDispatch?.ignoreState !== true &&
            isStateIn(entry.issue.state, this.config.tracker.handoffStates)) ||
          (entry.manualDispatch?.ignoreState !== true &&
            !isStateIn(entry.issue.state, this.config.tracker.activeStates))
        ) {
          break;
        }
      }
    } finally {
      if (workspace) {
        if (entry.runPhase !== "issue_breakdown") {
          await this.options.workspaceManager.afterRun(workspace.path);
          await this.recordWorkspaceEvidenceSnapshot(
            entry,
            "workspace_after_run_completed",
            workspace,
          );
        } else {
          await this.capturePlannerArtifacts(entry, workspace);
          await this.options.workspaceManager.removeForPlanning(entry.issue);
          await this.recordWorkspaceEvidenceSnapshot(
            entry,
            "planning_workspace_removed",
            workspace,
          );
        }
        if (entry.cleanupWorkspaceOnExit) {
          await this.options.workspaceManager.removeForIssue(entry.issue);
          await this.recordWorkspaceEvidenceSnapshot(
            entry,
            "workspace_removed",
            workspace,
            { cleanupWorkspaceOnExit: true },
          );
        }
      }
    }
  }

  private async capturePlannerArtifacts(
    entry: RunningEntry,
    workspace: Workspace,
  ): Promise<void> {
    if (entry.role !== "planner" || entry.runPhase !== "issue_breakdown")
      return;
    const runId = entry.activeRunId ?? entry.runId;
    if (!runId) return;
    const destination = path.join(
      this.config.workspace.stateDir,
      "planner-artifacts",
      safeArtifactSegment(entry.issue.identifier || entry.issue.id),
      safeArtifactSegment(runId),
    );
    const copied: string[] = [];
    for (const relativePath of [
      "specs",
      path.join(".specify", "feature.json"),
    ]) {
      const source = path.join(workspace.path, relativePath);
      if (!(await fileOrDirectoryExists(source))) continue;
      const target = path.join(destination, relativePath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.cp(source, target, { recursive: true, force: true });
      copied.push(relativePath);
    }
    if (copied.length === 0) return;
    await this.options.runStore?.appendEvent({
      runId,
      at: new Date().toISOString(),
      source: "orchestrator",
      eventType: "planner_artifacts_captured",
      message: `Captured planner artifacts for ${entry.issue.identifier}`,
      payload: { path: destination, copied },
    });
  }

  private async runReviewer(entry: RunningEntry): Promise<void> {
    let workspace: Workspace | null = null;
    try {
      const evidence =
        entry.reviewEvidence ??
        (await this.loadReviewerDispatchEvidence(entry.issue));
      if (!evidence) {
        this.options.logger.warn(
          "reviewer dispatch skipped because no completion report is available",
          {
            issue_id: entry.issue.id,
            issue_identifier: entry.issue.identifier,
          },
        );
        return;
      }
      entry.lifecycle = evidence.lifecycle;
      workspace = await this.options.workspaceManager.createForIssue(
        entry.issue,
      );
      entry.workspacePath = workspace.path;
      entry.workspace = workspace;
      await this.recordWorkspaceEvidenceSnapshot(
        entry,
        "workspace_created",
        workspace,
      );
      await this.updateLifecycle(entry, {
        phase: "review",
        summaryPointers: {
          workspaceKey: workspace.workspaceKey,
          workspacePath: workspace.path,
          branchName:
            workspace.gitBranchName ??
            entry.issue.branchName ??
            evidence.lifecycle.summaryPointers.branchName,
          gitBranchName:
            workspace.gitBranchName ??
            entry.issue.branchName ??
            evidence.lifecycle.summaryPointers.gitBranchName,
          repoPath:
            workspace.repoPath ?? evidence.lifecycle.summaryPointers.repoPath,
          baseRef:
            workspace.baseRef ?? evidence.lifecycle.summaryPointers.baseRef,
        },
      });
      await this.options.workspaceManager.beforeRun(workspace.path);
      await this.recordWorkspaceEvidenceSnapshot(
        entry,
        "workspace_before_run_completed",
        workspace,
      );
      await this.prepareHarnessForRun(entry, workspace, null, 1);
      await this.reloadHarnessForRun(entry, workspace, null, 1);
      this.requireMcpHandoff("review");

      entry.turnCount = 1;
      const promptBundle = await this.renderReviewerPromptBundle(
        entry,
        evidence,
        workspace,
      );
      this.assertPromptBundleSupported(promptBundle);
      await this.consumeHarnessEvents(
        entry,
        this.options.harness.run(
          this.buildRunContext(entry, workspace, null, 1, promptBundle),
          promptBundle.userPrompt,
        ),
        {
          workspace,
          prompt: promptBundle.userPrompt,
          promptBundle,
          attempt: null,
          turnNumber: 1,
        },
      );
      await this.runHandoffRepairIfNeeded(entry, workspace, null, 2);
    } finally {
      if (workspace) {
        await this.options.workspaceManager.afterRun(workspace.path);
        await this.recordWorkspaceEvidenceSnapshot(
          entry,
          "workspace_after_run_completed",
          workspace,
        );
      }
    }
  }

  private async runIssueTriage(entry: RunningEntry): Promise<void> {
    let workspace: Workspace | null = null;
    try {
      const lifecycle =
        (await this.options.lifecycleStore?.get(entry.issue.id)) ?? null;
      const triageEligible =
        entry.manualDispatch === null
          ? shouldIssueTriageRun(lifecycle, this.config)
          : shouldIssueTriageManualRun(lifecycle, this.config);
      if (!triageEligible) {
        this.options.logger.warn(
          "issue triage dispatch skipped because lifecycle is not triage-eligible",
          {
            issue_id: entry.issue.id,
            issue_identifier: entry.issue.identifier,
            manual_dispatch: entry.manualDispatch !== null,
          },
        );
        return;
      }
      if (!lifecycle) return;
      const eligibleLifecycle = lifecycle;
      entry.lifecycle = lifecycle;
      workspace = await this.options.workspaceManager.createForIssue(
        entry.issue,
      );
      entry.workspacePath = workspace.path;
      entry.workspace = workspace;
      await this.recordWorkspaceEvidenceSnapshot(
        entry,
        "workspace_created",
        workspace,
      );
      await this.updateLifecycle(entry, {
        summaryPointers: {
          workspaceKey: workspace.workspaceKey,
          workspacePath: workspace.path,
          branchName:
            workspace.gitBranchName ??
            entry.issue.branchName ??
            eligibleLifecycle.summaryPointers.branchName,
          gitBranchName:
            workspace.gitBranchName ??
            entry.issue.branchName ??
            eligibleLifecycle.summaryPointers.gitBranchName,
          repoPath:
            workspace.repoPath ?? eligibleLifecycle.summaryPointers.repoPath,
          baseRef:
            workspace.baseRef ?? eligibleLifecycle.summaryPointers.baseRef,
        },
      });
      await this.options.workspaceManager.beforeRun(workspace.path);
      await this.recordWorkspaceEvidenceSnapshot(
        entry,
        "workspace_before_run_completed",
        workspace,
      );
      await this.prepareHarnessForRun(entry, workspace, null, 1);
      await this.reloadHarnessForRun(entry, workspace, null, 1);
      this.requireMcpHandoff("issue_triage");

      entry.turnCount = 1;
      const promptBundle = await this.renderIssueTriagePromptBundle(entry);
      this.assertPromptBundleSupported(promptBundle);
      await this.consumeHarnessEvents(
        entry,
        this.options.harness.run(
          this.buildRunContext(entry, workspace, null, 1, promptBundle),
          promptBundle.userPrompt,
        ),
        {
          workspace,
          prompt: promptBundle.userPrompt,
          promptBundle,
          attempt: null,
          turnNumber: 1,
        },
      );
      await this.runHandoffRepairIfNeeded(entry, workspace, null, 2);
    } finally {
      if (workspace) {
        await this.options.workspaceManager.afterRun(workspace.path);
        await this.recordWorkspaceEvidenceSnapshot(
          entry,
          "workspace_after_run_completed",
          workspace,
        );
      }
    }
  }

  private async runIssuePostMortem(entry: RunningEntry): Promise<void> {
    let workspace: Workspace | null = null;
    try {
      const lifecycle =
        (await this.options.lifecycleStore?.get(entry.issue.id)) ?? null;
      const eligible =
        entry.manualDispatch === null
          ? shouldIssuePostMortemRun(lifecycle, entry.issue, this.config)
          : shouldIssuePostMortemManualRun(lifecycle, this.config);
      if (!eligible) {
        this.options.logger.warn(
          "issue post-mortem dispatch skipped because lifecycle is not post-mortem-eligible",
          {
            issue_id: entry.issue.id,
            issue_identifier: entry.issue.identifier,
            manual_dispatch: entry.manualDispatch !== null,
          },
        );
        return;
      }
      if (!lifecycle) return;
      const eligibleLifecycle = lifecycle;
      entry.lifecycle = lifecycle;
      workspace = await this.options.workspaceManager.createForIssue(
        entry.issue,
      );
      entry.workspacePath = workspace.path;
      entry.workspace = workspace;
      await this.recordWorkspaceEvidenceSnapshot(
        entry,
        "workspace_created",
        workspace,
      );
      await this.updateLifecycle(entry, {
        summaryPointers: {
          workspaceKey: workspace.workspaceKey,
          workspacePath: workspace.path,
          branchName:
            workspace.gitBranchName ??
            entry.issue.branchName ??
            eligibleLifecycle.summaryPointers.branchName,
          gitBranchName:
            workspace.gitBranchName ??
            entry.issue.branchName ??
            eligibleLifecycle.summaryPointers.gitBranchName,
          repoPath:
            workspace.repoPath ?? eligibleLifecycle.summaryPointers.repoPath,
          baseRef:
            workspace.baseRef ?? eligibleLifecycle.summaryPointers.baseRef,
        },
      });
      await this.options.workspaceManager.beforeRun(workspace.path);
      await this.recordWorkspaceEvidenceSnapshot(
        entry,
        "workspace_before_run_completed",
        workspace,
      );
      await this.prepareHarnessForRun(entry, workspace, null, 1);
      await this.reloadHarnessForRun(entry, workspace, null, 1);
      this.requireMcpHandoff("post_mortem");

      entry.turnCount = 1;
      const promptBundle = await this.renderIssuePostMortemPromptBundle(entry);
      this.assertPromptBundleSupported(promptBundle);
      await this.consumeHarnessEvents(
        entry,
        this.options.harness.run(
          this.buildRunContext(entry, workspace, null, 1, promptBundle),
          promptBundle.userPrompt,
        ),
        {
          workspace,
          prompt: promptBundle.userPrompt,
          promptBundle,
          attempt: null,
          turnNumber: 1,
        },
      );
      await this.runHandoffRepairIfNeeded(entry, workspace, null, 2);
    } finally {
      if (workspace) {
        await this.options.workspaceManager.afterRun(workspace.path);
        await this.recordWorkspaceEvidenceSnapshot(
          entry,
          "workspace_after_run_completed",
          workspace,
        );
      }
    }
  }

  private async consumeHarnessEvents(
    entry: RunningEntry,
    events: AsyncIterable<AgentEvent>,
    context: {
      workspace: Workspace;
      prompt: string;
      promptBundle?: AgentPromptBundle;
      attempt: number | null;
      turnNumber: number;
    },
  ): Promise<void> {
    for await (const rawEvent of events) {
      const event = sanitizeAgentEventForPublicOutput(rawEvent);
      const eventAt = new Date(event.at ?? Date.now());
      if (event.type === "run_status") {
        entry.sdkRunStatus = event.sdkStatus;
        entry.sdkRunStatusUpdatedAt = eventAt;
        entry.sdkRunStatusSource = event.source;
        await this.options.runStore?.updateRun(event.runId, {
          metadata: {
            sdkRunStatus: event.sdkStatus,
            sdkRunStatusObservedAt: eventAt.toISOString(),
            sdkRunStatusSource: event.source,
          },
        });
        await this.persistHarnessEvent(entry, rawEvent);
        await this.recordIssueEvidenceSnapshot({
          issue: entry.issue,
          evidenceKind: "harness",
          eventType: "run_status_observed",
          sourceId: event.runId,
          reason: "run_status_observed",
          payload: {
            runId: event.runId,
            sdkStatus: event.sdkStatus,
            observedAt: eventAt.toISOString(),
            source: event.source,
          },
        });
        continue;
      }
      entry.lastEvent = event.type;
      entry.lastEventAt = eventAt;
      if (event.type === "progress") {
        recordActivitySource(entry, event.activitySource ?? "stream", eventAt);
      }
      if (event.type === "session_started") {
        entry.sessionId = event.sessionId;
        entry.runId = event.runId ?? event.sessionId;
        entry.activeRunId = entry.runId;
        entry.activeRunTokens = {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        };
        const runtimeMetadata = runtimeMetadataForEntry(
          this.options.harness.id,
          entry,
          this.config,
          event,
        );
        await this.updateLifecycle(entry, {
          summaryPointers: { lastRunId: entry.runId },
        });
        const startedRun = await this.options.runStore?.startRun({
          runId: entry.runId,
          sessionId: event.sessionId,
          agentId: event.threadId ?? null,
          role: entry.role,
          runPhase: entry.runPhase,
          runKind: runKindForPhase(entry.runPhase),
          issueId: entry.issue.id,
          issueIdentifier: entry.issue.identifier,
          attempt: context.attempt,
          turnNumber: context.turnNumber,
          prompt: context.prompt,
          ...(context.promptBundle === undefined
            ? {}
            : {
                ephemeralSystemPrompt:
                  context.promptBundle.ephemeralSystemPrompt,
                promptTemplateKeys: context.promptBundle.metadata.templateKeys,
                promptBundleWarnings: context.promptBundle.metadata.warnings,
              }),
          harnessId: this.options.harness.id,
          ...runtimeMetadata,
          cursorModel: this.config.cursor.model,
          cursorModelParams: this.config.cursor.modelParams,
          cursorSettingSources: this.config.cursor.settingSources,
          cursorMode: effectiveRuntimeModeForEntry(entry, this.config),
          cursorAllowLargeContext: this.config.cursor.allowLargeContext,
          cursorWorkerAgentLifecycle: this.config.cursor.workerAgentLifecycle,
          workspaceKey: context.workspace.workspaceKey,
          workspacePath: context.workspace.path,
          ...(context.workspace.gitBranchName === undefined
            ? {}
            : { gitBranchName: context.workspace.gitBranchName }),
          ...(context.workspace.repoPath === undefined
            ? {}
            : { repoPath: context.workspace.repoPath }),
          ...(context.workspace.baseRef === undefined
            ? {}
            : { baseRef: context.workspace.baseRef }),
          ...(entry.manualDispatch === null
            ? {}
            : { metadata: manualDispatchRunMetadata(entry) }),
        });
        await this.recordIssueEvidenceSnapshot({
          issue: entry.issue,
          evidenceKind: "run",
          eventType: "run_started",
          sourceId: entry.runId,
          reason: "run_started",
          payload: {
            runId: entry.runId,
            sessionId: startedRun?.sessionId ?? entry.sessionId,
            agentId: startedRun?.agentId ?? event.threadId ?? null,
            role: entry.role,
            runPhase: entry.runPhase,
            runKind: runKindForPhase(entry.runPhase),
            status: startedRun?.status ?? "running",
            attempt: context.attempt,
            turnNumber: context.turnNumber,
            harnessId: this.options.harness.id,
            prompt: startedRun?.prompt ?? null,
            promptCharCount: startedRun?.promptCharCount ?? null,
            startedAt: startedRun?.startedAt ?? null,
            updatedAt: startedRun?.updatedAt ?? null,
            tokens: startedRun?.tokens ?? null,
            workspaceKey: context.workspace.workspaceKey,
            workspacePath: context.workspace.path,
            gitBranchName: context.workspace.gitBranchName ?? null,
            promptTemplateKeys:
              context.promptBundle?.metadata.templateKeys ?? null,
          },
        });
        if (entry.runPhase !== "issue_breakdown") {
          await this.discoverPullRequestForEntry(entry, context.workspace);
        }
        if (entry.role === "worker" && entry.runPhase === "implementation") {
          await this.applyWriteback(
            planRunStartedComment(
              {
                issue: entry.issue,
                runId: entry.runId,
                sessionId: entry.sessionId,
                workspacePath: entry.workspacePath,
                workspace: context.workspace,
              },
              this.config,
            ),
            "run start comment",
            entry.issue,
          );
        }
      }
      if (event.type === "progress" || event.type === "run_diagnostic")
        entry.lastMessage = event.message;
      if (event.type === "run_diagnostic") {
        entry.failureKind = failureKindForDiagnostic(event.code);
        entry.failureDiagnosticCode = event.code;
        entry.failureDiagnosticMessage = event.message;
        entry.failureDiagnosticAt = eventAt;
        entry.failureDiagnosticPayload = event.payload;
      }
      if (event.type === "tokens") this.applyTokenUpdate(entry, event.tokens);
      if (event.type === "rate_limits") this.rateLimits = event.payload;
      if (event.type === "provider_limit") {
        const signal = await this.recordProviderLimitEvent(
          entry,
          event.signal,
          eventAt,
        );
        await this.recordIssueEvidenceSnapshot({
          issue: entry.issue,
          evidenceKind: "harness",
          eventType: "provider_limit_observed",
          sourceId: entry.activeRunId ?? entry.runId,
          reason: "provider_limit_observed",
          payload: {
            runId: entry.activeRunId ?? entry.runId,
            observedAt: eventAt.toISOString(),
            signal,
          },
        });
        const runId = entry.activeRunId ?? entry.runId ?? "";
        if (runId.length > 0) {
          await this.updateRunTerminalStateIfRunning(
            runId,
            {
              status: "failed",
              completedAt: new Date().toISOString(),
              error: signal.message,
              tokens: entry.activeRunTokens,
              metadata: terminalRunMetadata(entry, "failed"),
            },
            entry.issue,
          );
        }
        await this.persistHarnessEvent(entry, { ...event, signal });
        throw new SymphonyError("agent_error", signal.message);
      }
      const terminalHarnessEvent =
        event.type === "completed" ||
        event.type === "failed" ||
        event.type === "cancelled";
      if (!terminalHarnessEvent)
        await this.persistHarnessEvent(entry, rawEvent);

      if (event.type === "completed") {
        if (entry.runPhase === "issue_triage") {
          const accepted = await this.reconcileIssueTriageHandoff(entry);
          if (accepted) {
            const terminal = await this.terminalizeAcceptedHandoff(
              entry,
              "issue_triage_report",
            );
            await this.persistHarnessEvent(entry, event);
            if (!terminal.updated) return;
            continue;
          }
          const completedAt = new Date().toISOString();
          const terminal = await this.updateRunTerminalStateIfRunning(
            entry.activeRunId ?? entry.runId ?? "",
            {
              status: "failed",
              completedAt,
              error: TRIAGE_NO_REPORT_ERROR,
              tokens: entry.activeRunTokens,
              metadata: terminalRunMetadata(entry, "failed"),
            },
            entry.issue,
          );
          await this.persistHarnessEvent(entry, event);
          if (!terminal.updated) return;
          continue;
        }
        if (entry.runPhase === "post_mortem") {
          const accepted = await this.reconcileIssuePostMortemHandoff(entry);
          if (accepted) {
            const terminal = await this.terminalizeAcceptedHandoff(
              entry,
              "issue_post_mortem_report",
            );
            await this.persistHarnessEvent(entry, event);
            if (!terminal.updated) return;
            continue;
          }
          const completedAt = new Date().toISOString();
          const terminal = await this.updateRunTerminalStateIfRunning(
            entry.activeRunId ?? entry.runId ?? "",
            {
              status: "failed",
              completedAt,
              error: POST_MORTEM_NO_REPORT_ERROR,
              tokens: entry.activeRunTokens,
              metadata: terminalRunMetadata(entry, "failed"),
            },
            entry.issue,
          );
          await this.persistHarnessEvent(entry, event);
          if (!terminal.updated) return;
          continue;
        }
        if (entry.runPhase === "issue_breakdown") {
          const accepted = await this.reconcileIssueBreakdownPlanHandoff(entry);
          if (accepted) {
            const terminal = await this.terminalizeAcceptedHandoff(
              entry,
              "issue_breakdown_plan",
            );
            await this.persistHarnessEvent(entry, event);
            if (!terminal.updated) return;
            continue;
          }
          const completedAt = new Date().toISOString();
          this.applyPlanningFailureDiagnostic(
            entry,
            PLANNING_NO_PLAN_ERROR,
            new Date(completedAt),
          );
          const terminal = await this.updateRunTerminalStateIfRunning(
            entry.activeRunId ?? entry.runId ?? "",
            {
              status: "failed",
              completedAt,
              error: PLANNING_NO_PLAN_ERROR,
              tokens: entry.activeRunTokens,
              metadata: terminalRunMetadata(entry, "failed"),
            },
            entry.issue,
          );
          await this.persistHarnessEvent(entry, event);
          if (!terminal.updated) return;
          continue;
        }
        const terminal = await this.updateRunTerminalStateIfRunning(
          entry.activeRunId ?? entry.runId ?? "",
          {
            status: "succeeded",
            completedAt: new Date().toISOString(),
            tokens: entry.activeRunTokens,
            metadata: terminalRunMetadata(entry, "succeeded"),
          },
          entry.issue,
        );
        await this.persistHarnessEvent(entry, event);
        if (!terminal.updated) return;
        await this.discoverPullRequestForEntry(entry, context.workspace);
        if (
          entry.role === "worker" &&
          entry.runPhase === "merge_conflict_resolution" &&
          !(await this.reconcileMergeConflictResolutionHandoff(entry))
        ) {
          await this.recordIncompleteTurn(entry);
        } else if (
          entry.role === "worker" &&
          entry.runPhase !== "merge_conflict_resolution" &&
          !(await this.reconcileCompletionReportHandoff(entry)) &&
          !entry.pullRequestHandoffAccepted
        ) {
          await this.reconcileCompletionReportRejection(entry);
          await this.recordIncompleteTurn(entry);
        }
        if (entry.role === "reviewer") {
          await this.reconcileReviewVerdictHandoff(entry);
        }
      }
      if (event.type === "failed") {
        if (
          entry.role === "planner" &&
          entry.runPhase === "issue_breakdown" &&
          (await this.terminalizeAcceptedIssueBreakdownPlan(entry))
        ) {
          await this.persistHarnessEvent(entry, event);
          return;
        }
        const acceptedFailedHandoffKind =
          await this.acceptedTerminalHandoffKind(entry);
        if (acceptedFailedHandoffKind) {
          const terminal = await this.terminalizeAcceptedHandoff(
            entry,
            acceptedFailedHandoffKind,
          );
          await this.persistHarnessEvent(entry, event);
          if (!terminal.updated) return;
          return;
        }
        if (
          entry.role === "worker" &&
          entry.runPhase !== "merge_conflict_resolution"
        ) {
          await this.reconcileCompletionReportRejection(entry);
        }
        const terminal = await this.updateRunTerminalStateIfRunning(
          entry.activeRunId ?? entry.runId ?? "",
          {
            status: "failed",
            completedAt: new Date().toISOString(),
            error: event.error,
            tokens: entry.activeRunTokens,
            metadata: terminalRunMetadata(entry, "failed"),
          },
          entry.issue,
        );
        await this.persistHarnessEvent(entry, event);
        if (!terminal.updated) return;
        throw new SymphonyError("agent_error", event.error);
      }
      if (event.type === "cancelled") {
        if (
          entry.role === "planner" &&
          entry.runPhase === "issue_breakdown" &&
          (await this.terminalizeAcceptedIssueBreakdownPlan(entry))
        ) {
          await this.persistHarnessEvent(entry, event);
          return;
        }
        const acceptedCancelledHandoffKind =
          await this.acceptedTerminalHandoffKind(entry);
        if (acceptedCancelledHandoffKind) {
          const terminal = await this.terminalizeAcceptedHandoff(
            entry,
            acceptedCancelledHandoffKind,
          );
          await this.persistHarnessEvent(entry, event);
          if (!terminal.updated) return;
          return;
        }
        if (
          entry.role === "worker" &&
          entry.runPhase !== "merge_conflict_resolution"
        ) {
          await this.reconcileCompletionReportRejection(entry);
        }
        const terminal = await this.updateRunTerminalStateIfRunning(
          entry.activeRunId ?? entry.runId ?? "",
          {
            status: "cancelled",
            completedAt: new Date().toISOString(),
            tokens: entry.activeRunTokens,
            metadata: terminalRunMetadata(entry, "cancelled"),
          },
          entry.issue,
        );
        await this.persistHarnessEvent(entry, event);
        if (!terminal.updated) return;
        throw new SymphonyError("agent_error", "Run was cancelled");
      }
    }
  }

  private async updateRunTerminalStateIfRunning(
    runId: string,
    patch: TerminalRunPatch,
    issue: Issue | null = null,
  ): Promise<TerminalUpdateResult> {
    const runStore = this.options.runStore;
    if (!runStore) return { updated: true, record: null };
    const existing = await runStore.getRun(runId);
    if (existing && existing.status !== "running")
      return { updated: false, record: existing };
    const record = await runStore.updateRun(runId, patch);
    if (issue !== null) {
      await this.recordIssueEvidenceSnapshot({
        issue,
        evidenceKind: "run",
        eventType: "run_terminal_state_updated",
        sourceId: runId,
        reason: `run_${patch.status}`,
        payload: {
          runId,
          sessionId: record?.sessionId ?? null,
          agentId: record?.agentId ?? null,
          status: patch.status,
          updatedAt: record?.updatedAt ?? null,
          completedAt: record?.completedAt ?? patch.completedAt ?? null,
          error: record?.error ?? patch.error ?? null,
          tokens: record?.tokens ?? patch.tokens ?? null,
          metadata: patch.metadata ?? null,
          sdkRunStatus:
            (patch.metadata as Record<string, unknown> | undefined)
              ?.sdkRunStatus ?? null,
          sdkRunStatusSource:
            (patch.metadata as Record<string, unknown> | undefined)
              ?.sdkRunStatusSource ?? null,
          cancellationRequestedAt:
            (patch.metadata as Record<string, unknown> | undefined)
              ?.cancellationRequestedAt ?? null,
          cancellationOutcome:
            (patch.metadata as Record<string, unknown> | undefined)
              ?.cancellationOutcome ?? null,
          cancelFailed:
            (patch.metadata as Record<string, unknown> | undefined)
              ?.cancelFailed ?? null,
          failureKind:
            (patch.metadata as Record<string, unknown> | undefined)
              ?.failureKind ?? null,
          failureDiagnosticCode:
            (patch.metadata as Record<string, unknown> | undefined)
              ?.failureDiagnosticCode ?? null,
        },
      });
    }
    return { updated: true, record };
  }

  private async recordProviderLimitEvent(
    entry: RunningEntry,
    signal: ProviderLimitSignal,
    observedAt: Date,
  ): Promise<ProviderLimitSignal> {
    const normalized = normalizeProviderLimitSignal(
      {
        ...signal,
        observedAt: signal.observedAt ?? observedAt.toISOString(),
        source: {
          ...(signal.source ?? {}),
          issueId: signal.source?.issueId ?? entry.issue.id,
          issueIdentifier:
            signal.source?.issueIdentifier ?? entry.issue.identifier,
          runId: signal.source?.runId ?? entry.activeRunId ?? entry.runId,
          sessionId: signal.source?.sessionId ?? entry.sessionId,
          role: signal.source?.role ?? entry.role,
          runPhase: signal.source?.runPhase ?? entry.runPhase,
        },
      },
      {
        harnessId: this.options.harness.id,
        providerId: runtimeProviderForHarness(
          this.options.harness.id,
          this.config,
        ),
        model: runtimeModelForHarness(this.options.harness.id, this.config),
      },
      observedAt,
    );
    entry.providerLimitSignal = normalized;
    entry.failureKind = "provider_limit";
    entry.failureDiagnosticCode = "provider_limit";
    entry.failureDiagnosticMessage = normalized.message;
    entry.failureDiagnosticAt = observedAt;
    entry.failureDiagnosticPayload = normalized;
    entry.lastMessage = normalized.message;
    const gate = await this.providerGateStore.upsert(normalized);
    await this.refreshProviderGates();
    this.options.logger.warn("provider limit gate recorded", {
      gate_id: gate.id,
      issue_id: entry.issue.id,
      issue_identifier: entry.issue.identifier,
      run_id: normalized.source?.runId ?? null,
      kind: gate.kind,
      harness_id: gate.scope.harnessId,
      provider_id: gate.scope.providerId,
      model: gate.scope.model,
      resume_policy: gate.resumePolicy,
      resume_at: gate.window?.resumeAt ?? null,
    });
    return normalized;
  }

  private applyPlanningFailureDiagnostic(
    entry: RunningEntry,
    message: string,
    at: Date,
  ): void {
    entry.failureKind = entry.failureKind ?? PLANNING_FAILURE_DIAGNOSTIC_CODE;
    entry.failureDiagnosticCode =
      entry.failureDiagnosticCode ?? PLANNING_FAILURE_DIAGNOSTIC_CODE;
    entry.failureDiagnosticMessage = entry.failureDiagnosticMessage ?? message;
    entry.failureDiagnosticAt = entry.failureDiagnosticAt ?? at;
    entry.lastMessage = message;
  }

  private async terminalizeAcceptedIssueBreakdownPlan(
    entry: RunningEntry,
  ): Promise<boolean> {
    const accepted =
      entry.issueBreakdownPlanAccepted ||
      (await this.reconcileIssueBreakdownPlanHandoff(entry));
    if (!accepted) return false;
    await this.terminalizeAcceptedHandoff(entry, "issue_breakdown_plan");
    return true;
  }

  private async acceptedTerminalHandoffKind(
    entry: RunningEntry,
  ): Promise<AcceptedHandoffKind | null> {
    if (entry.role === "triage") {
      return entry.issueTriageReportAccepted ||
        (await this.reconcileIssueTriageHandoff(entry))
        ? "issue_triage_report"
        : null;
    }
    if (entry.role === "post_mortem") {
      return entry.issuePostMortemReportAccepted ||
        (await this.reconcileIssuePostMortemHandoff(entry))
        ? "issue_post_mortem_report"
        : null;
    }
    if (entry.role === "planner" && entry.runPhase === "issue_breakdown") {
      return entry.issueBreakdownPlanAccepted ||
        (await this.reconcileIssueBreakdownPlanHandoff(entry))
        ? "issue_breakdown_plan"
        : null;
    }
    if (entry.role !== "worker") return null;
    if (entry.runPhase === "issue_breakdown") {
      return entry.issueBreakdownPlanAccepted ||
        (await this.reconcileIssueBreakdownPlanHandoff(entry))
        ? "issue_breakdown_plan"
        : null;
    }
    if (entry.runPhase === "merge_conflict_resolution") {
      return entry.mergeConflictResolutionAccepted ||
        (await this.reconcileMergeConflictResolutionHandoff(entry))
        ? "merge_conflict_resolution"
        : null;
    }
    return (await this.reconcileCompletionReportHandoff(entry)) ||
      entry.completionReportAccepted ||
      entry.pullRequestHandoffAccepted
      ? this.acceptedImplementationHandoffKind(entry)
      : null;
  }

  private acceptedImplementationHandoffKind(
    _entry: RunningEntry,
  ): AcceptedHandoffKind {
    return this.config.github.prHandoff.enabled
      ? "pull_request_handoff"
      : "completion_report";
  }

  private async terminalizeAcceptedHandoff(
    entry: RunningEntry,
    kind: AcceptedHandoffKind,
  ): Promise<TerminalUpdateResult> {
    const runId = entry.activeRunId ?? entry.runId ?? "";
    if (runId.length === 0) return { updated: true, record: null };
    const completedAt = new Date().toISOString();
    const metadata = terminalRunMetadata(entry, "succeeded");
    const terminal = await this.updateRunTerminalStateIfRunning(
      runId,
      {
        status: "succeeded",
        completedAt,
        tokens: entry.activeRunTokens,
        metadata,
      },
      entry.issue,
    );
    if (terminal.updated) {
      await this.options.runStore?.appendEvent({
        runId,
        at: completedAt,
        source: "orchestrator",
        eventType: "handoff_terminal",
        message: `Accepted ${formatAcceptedHandoffKind(kind)} handoff terminalized run as succeeded`,
        payload: {
          kind,
          status: "succeeded",
          tokens: entry.activeRunTokens,
          ...metadata,
        },
      });
      if (kind === "issue_breakdown_plan") {
        await this.autoApplyAcceptedIssueBreakdownPlan(entry);
      }
    }
    return terminal;
  }

  private async autoApplyAcceptedIssueBreakdownPlan(
    entry: RunningEntry,
  ): Promise<void> {
    if (
      !this.config.issueBreakdown.applyToLinear.enabled ||
      !this.config.issueBreakdown.applyToLinear.autoApply
    )
      return;
    if (!this.options.lifecycleStore) return;
    const service = new IssueBreakdownPlanApplyService({
      config: this.config,
      lifecycleStore: this.options.lifecycleStore,
      writeback: this.options.writeback,
    });
    try {
      const result = await service.applyLatestFreshPlan(entry.issue);
      this.options.logger.info("issue breakdown auto-apply completed", {
        issue_id: entry.issue.id,
        issue_identifier: entry.issue.identifier,
        status: result.status,
        reason: "reason" in result ? result.reason : null,
      });
    } catch (error) {
      this.options.logger.warn("issue breakdown auto-apply failed", {
        issue_id: entry.issue.id,
        issue_identifier: entry.issue.identifier,
        error: errorMessage(error),
      });
    }
  }

  private async onWorkerExit(
    issueId: string,
    kind: "normal" | "abnormal",
    error: string | null,
  ): Promise<void> {
    const entry = this.running.get(issueId);
    if (!entry) return;
    this.endedRuntimeSeconds += (Date.now() - entry.startedAt.getTime()) / 1000;

    try {
      if (entry.providerLimitSignal) {
        await this.releaseIssueClaim(
          entry.issue,
          "worker_exit_released_claim",
          entry.activeRunId ?? entry.runId ?? issueId,
        );
        return;
      }

      if (entry.runPhase === "issue_triage") {
        const accepted =
          entry.issueTriageReportAccepted ||
          (await this.reconcileIssueTriageHandoff(entry));
        if (accepted && entry.runId) {
          await this.terminalizeAcceptedHandoff(entry, "issue_triage_report");
        } else if (entry.runId) {
          await this.updateRunTerminalStateIfRunning(
            entry.runId,
            {
              status: entry.suppressRetryOnExit ? "cancelled" : "failed",
              completedAt: new Date().toISOString(),
              error: entry.suppressRetryOnExit
                ? error
                : (error ?? TRIAGE_NO_REPORT_ERROR),
              tokens: entry.activeRunTokens,
              metadata: terminalRunMetadata(
                entry,
                entry.suppressRetryOnExit ? "cancelled" : "failed",
              ),
            },
            entry.issue,
          );
        }
        await this.releaseIssueClaim(
          entry.issue,
          "worker_exit_released_claim",
          entry.activeRunId ?? entry.runId ?? issueId,
        );
        return;
      }

      if (entry.runPhase === "post_mortem") {
        const accepted =
          entry.issuePostMortemReportAccepted ||
          (await this.reconcileIssuePostMortemHandoff(entry));
        if (accepted && entry.runId) {
          await this.terminalizeAcceptedHandoff(
            entry,
            "issue_post_mortem_report",
          );
        } else if (entry.runId) {
          await this.updateRunTerminalStateIfRunning(
            entry.runId,
            {
              status: entry.suppressRetryOnExit ? "cancelled" : "failed",
              completedAt: new Date().toISOString(),
              error: entry.suppressRetryOnExit
                ? error
                : (error ?? POST_MORTEM_NO_REPORT_ERROR),
              tokens: entry.activeRunTokens,
              metadata: terminalRunMetadata(
                entry,
                entry.suppressRetryOnExit ? "cancelled" : "failed",
              ),
            },
            entry.issue,
          );
        }
        await this.releaseIssueClaim(
          entry.issue,
          "worker_exit_released_claim",
          entry.activeRunId ?? entry.runId ?? issueId,
        );
        return;
      }

      if (entry.runPhase === "issue_breakdown") {
        const accepted =
          entry.issueBreakdownPlanAccepted ||
          (await this.reconcileIssueBreakdownPlanHandoff(entry));
        if (accepted) {
          await this.terminalizeAcceptedIssueBreakdownPlan(entry);
          await this.updateLifecycle(entry, {
            planningFailureCount: 0,
            planningDispatchRetryCount: 0,
            lastPlanningFailureRunId: null,
            lastPlanningFailureAt: null,
          });
          await this.clearIssueRetry(
            entry.issue,
            "issue_breakdown_accepted_cleared_retry",
            entry.activeRunId ?? entry.runId ?? issueId,
          );
          this.completed.add(issueId);
          await this.releaseIssueClaim(
            entry.issue,
            "worker_exit_released_claim",
            entry.activeRunId ?? entry.runId ?? issueId,
          );
          return;
        }
        if (entry.suppressRetryOnExit) {
          await this.releaseIssueClaim(
            entry.issue,
            "worker_exit_released_claim",
            entry.activeRunId ?? entry.runId ?? issueId,
          );
          return;
        }
        await this.releaseRunningEntryForExit(issueId, entry);
        await this.recordPlanningFailure(
          entry,
          error ??
            (kind === "normal"
              ? "Planning run completed without submit_issue_breakdown_plan"
              : "Planning run failed"),
        );
        return;
      }

      if (
        entry.role === "worker" &&
        ((entry.runPhase === "merge_conflict_resolution" &&
          (await this.reconcileMergeConflictResolutionHandoff(entry))) ||
          (entry.runPhase !== "merge_conflict_resolution" &&
            ((await this.reconcileCompletionReportHandoff(entry)) ||
              entry.pullRequestHandoffAccepted)))
      ) {
        if (entry.runId) {
          const terminal = await this.terminalizeAcceptedHandoff(
            entry,
            entry.runPhase === "merge_conflict_resolution"
              ? "merge_conflict_resolution"
              : this.acceptedImplementationHandoffKind(entry),
          );
          if (!terminal.updated) {
            if (entry.runPhase !== "merge_conflict_resolution") {
              await this.releaseIssueClaim(
                entry.issue,
                "worker_exit_released_claim",
                entry.activeRunId ?? entry.runId ?? issueId,
              );
              return;
            }
          }
        }
        if (entry.runPhase !== "merge_conflict_resolution") {
          this.completed.add(issueId);
        }
        await this.releaseIssueClaim(
          entry.issue,
          "worker_exit_released_claim",
          entry.activeRunId ?? entry.runId ?? issueId,
        );
        return;
      }

      const rejectedCompletionReport =
        entry.role === "worker" &&
        entry.runPhase !== "merge_conflict_resolution" &&
        (await this.reconcileCompletionReportRejection(entry));

      if (kind === "normal") {
        if (entry.runId) {
          const terminal = await this.updateRunTerminalStateIfRunning(
            entry.runId,
            {
              status: "succeeded",
              completedAt: new Date().toISOString(),
              tokens: entry.activeRunTokens,
              metadata: terminalRunMetadata(entry, "succeeded"),
            },
            entry.issue,
          );
          if (
            !terminal.updated &&
            entry.runPhase !== "merge_conflict_resolution"
          ) {
            await this.releaseIssueClaim(
              entry.issue,
              "worker_exit_released_claim",
              entry.activeRunId ?? entry.runId ?? issueId,
            );
            return;
          }
        }
        if (entry.runPhase !== "merge_conflict_resolution") {
          this.completed.add(issueId);
        }
        if (entry.role === "reviewer") {
          await this.reconcileReviewVerdictHandoff(entry);
          await this.releaseIssueClaim(
            entry.issue,
            "worker_exit_released_claim",
            entry.activeRunId ?? entry.runId ?? issueId,
          );
          return;
        }
        if (
          entry.lifecycle?.phase === "blocked" ||
          (entry.lifecycle?.blockedReason ?? null) !== null
        ) {
          await this.releaseIssueClaim(
            entry.issue,
            "worker_exit_released_claim",
            entry.activeRunId ?? entry.runId ?? issueId,
          );
          return;
        }
        if (entry.runPhase === "merge_conflict_resolution") {
          if (await this.shouldScheduleContinuation(entry)) {
            await this.releaseRunningEntryForExit(issueId, entry);
            await this.scheduleRetryTransition(
              entry.issue,
              1,
              1_000,
              null,
              entry.runPhase,
            );
          } else {
            await this.releaseIssueClaim(
              entry.issue,
              "worker_exit_released_claim",
              entry.activeRunId ?? entry.runId ?? issueId,
            );
          }
          return;
        }
        if (this.config.writeback.enabled) {
          if (!rejectedCompletionReport) {
            await this.applyWritebacks(
              planRunSucceededWritebacks(
                {
                  issue: entry.issue,
                  runId: entry.runId ?? issueId,
                  sessionId: entry.sessionId,
                  workspacePath: entry.workspacePath,
                  workspace: entry.workspace,
                },
                this.config,
              ),
              "turn completed",
              entry.issue,
            );
          }
          await this.releaseIssueClaim(
            entry.issue,
            "worker_exit_released_claim",
            entry.activeRunId ?? entry.runId ?? issueId,
          );
          return;
        }
        if (await this.shouldScheduleContinuation(entry)) {
          await this.releaseRunningEntryForExit(issueId, entry);
          await this.scheduleRetryTransition(
            entry.issue,
            1,
            1_000,
            null,
            entry.runPhase,
          );
        } else {
          await this.releaseIssueClaim(
            entry.issue,
            "worker_exit_released_claim",
            entry.activeRunId ?? entry.runId ?? issueId,
          );
        }
      } else if (entry.role === "reviewer") {
        if (entry.runId) {
          const terminal = await this.updateRunTerminalStateIfRunning(
            entry.runId,
            {
              status: entry.suppressRetryOnExit ? "cancelled" : "failed",
              completedAt: new Date().toISOString(),
              error,
              tokens: entry.activeRunTokens,
              metadata: terminalRunMetadata(
                entry,
                entry.suppressRetryOnExit ? "cancelled" : "failed",
              ),
            },
            entry.issue,
          );
          if (!terminal.updated) {
            await this.releaseIssueClaim(
              entry.issue,
              "worker_exit_released_claim",
              entry.activeRunId ?? entry.runId ?? issueId,
            );
            return;
          }
        }
        await this.releaseIssueClaim(
          entry.issue,
          "worker_exit_released_claim",
          entry.activeRunId ?? entry.runId ?? issueId,
        );
      } else if (entry.suppressRetryOnExit) {
        if (entry.runId) {
          const terminal = await this.updateRunTerminalStateIfRunning(
            entry.runId,
            {
              status: "cancelled",
              completedAt: new Date().toISOString(),
              error,
              tokens: entry.activeRunTokens,
              metadata: terminalRunMetadata(entry, "cancelled"),
            },
            entry.issue,
          );
          if (!terminal.updated) {
            await this.releaseIssueClaim(
              entry.issue,
              "worker_exit_released_claim",
              entry.activeRunId ?? entry.runId ?? issueId,
            );
            if (
              terminal.record?.status === "failed" &&
              terminal.record.error === OPERATOR_REJECTED_PUBLICATION_ERROR
            )
              return;
          }
        }
        if (!rejectedCompletionReport) {
          await this.applyWriteback(
            planRunCancelledComment(
              {
                issue: entry.issue,
                runId: entry.runId ?? issueId,
                sessionId: entry.sessionId,
                workspacePath: entry.workspacePath,
                workspace: entry.workspace,
              },
              this.config,
              error,
            ),
            "run cancelled",
            entry.issue,
          );
        }
        await this.releaseIssueClaim(
          entry.issue,
          "worker_exit_released_claim",
          entry.activeRunId ?? entry.runId ?? issueId,
        );
      } else {
        if (entry.runPhase === "merge_conflict_resolution") {
          await this.recordMergeConflictAttempt(
            entry,
            error ?? "conflict-fix run failed before reporting resolution",
          );
          if (
            entry.lifecycle?.phase === "blocked" ||
            (entry.lifecycle?.blockedReason ?? null) !== null
          ) {
            await this.releaseIssueClaim(
              entry.issue,
              "worker_exit_released_claim",
              entry.activeRunId ?? entry.runId ?? issueId,
            );
            return;
          }
        }
        if (entry.runId) {
          const terminal = await this.updateRunTerminalStateIfRunning(
            entry.runId,
            {
              status: "failed",
              completedAt: new Date().toISOString(),
              error,
              tokens: entry.activeRunTokens,
              metadata: terminalRunMetadata(entry, "failed"),
            },
            entry.issue,
          );
          if (error === OPERATOR_REJECTED_PUBLICATION_ERROR) {
            await this.releaseIssueClaim(
              entry.issue,
              "worker_exit_released_claim",
              entry.activeRunId ?? entry.runId ?? issueId,
            );
            return;
          }
          if (!terminal.updated) {
            await this.releaseIssueClaim(
              entry.issue,
              "worker_exit_released_claim",
              entry.activeRunId ?? entry.runId ?? issueId,
            );
            if (
              terminal.record?.status === "failed" &&
              terminal.record.error === OPERATOR_REJECTED_PUBLICATION_ERROR
            )
              return;
          }
        }
        if (!rejectedCompletionReport) {
          await this.applyWriteback(
            planRunFailedComment(
              {
                issue: entry.issue,
                runId: entry.runId ?? issueId,
                sessionId: entry.sessionId,
                workspacePath: entry.workspacePath,
                workspace: entry.workspace,
              },
              this.config,
              error,
            ),
            "run failed",
            entry.issue,
          );
        }
        if (
          entry.role === "worker" &&
          entry.runPhase !== "merge_conflict_resolution" &&
          (rejectedCompletionReport || entry.failureKind === null)
        ) {
          await this.recordIncompleteTurn(entry);
          if (
            entry.lifecycle?.phase === "blocked" ||
            (entry.lifecycle?.blockedReason ?? null) !== null
          ) {
            await this.releaseIssueClaim(
              entry.issue,
              "worker_exit_released_claim",
              entry.activeRunId ?? entry.runId ?? issueId,
            );
            return;
          }
        }
        const sdkErrorFailures = await this.consecutiveSdkErrorFailures(
          entry.issue,
        );
        if (sdkErrorFailures >= 1 + this.config.agent.maxSdkErrorRetries) {
          await this.escalateEntryBlocked(
            entry,
            `consecutive Cursor SDK wait errors reached limit (${sdkErrorFailures} failures; max_sdk_error_retries=${this.config.agent.maxSdkErrorRetries})`,
          );
          await this.releaseIssueClaim(
            entry.issue,
            "worker_exit_released_claim",
            entry.activeRunId ?? entry.runId ?? issueId,
          );
          return;
        }
        const infraFailures = await this.consecutiveInfraFailures(entry.issue);
        if (infraFailures >= this.config.agent.maxInfraFailures) {
          await this.escalateEntryBlocked(
            entry,
            `consecutive harness infrastructure failures reached limit (${infraFailures} failures; max_infra_failures=${this.config.agent.maxInfraFailures})`,
          );
          await this.releaseIssueClaim(
            entry.issue,
            "worker_exit_released_claim",
            entry.activeRunId ?? entry.runId ?? issueId,
          );
          return;
        }
        const nextAttempt = Math.max(entry.retryAttempt + 1, 1);
        const delayMs = Math.min(
          10_000 * 2 ** (nextAttempt - 1),
          this.config.agent.maxRetryBackoffMs,
        );
        await this.releaseRunningEntryForExit(issueId, entry);
        await this.scheduleRetryTransition(
          entry.issue,
          nextAttempt,
          delayMs,
          error,
          entry.runPhase,
        );
      }
    } finally {
      await this.releaseRunningEntryForExit(issueId, entry);
    }
  }

  private async releaseRunningEntryForExit(
    issueId: string,
    entry: RunningEntry,
  ): Promise<void> {
    if (this.running.get(issueId) === entry) {
      this.running.delete(issueId);
      await this.recordRuntimeControlEvidenceSnapshot({
        issue: entry.issue,
        eventType: "running_entry_released",
        sourceId: entry.activeRunId ?? entry.runId ?? issueId,
        reason: "running_entry_released",
        entry,
      });
    }
  }

  private async recordPlanningFailure(
    entry: RunningEntry,
    error: string | null,
  ): Promise<void> {
    const issueId = entry.issue.id;
    const store = this.options.lifecycleStore;
    if (!store) {
      await this.releaseIssueClaim(
        entry.issue,
        "planning_failure_missing_store_released_claim",
        entry.activeRunId ?? entry.runId ?? issueId,
      );
      return;
    }

    const now = new Date().toISOString();
    const runId = entry.activeRunId ?? entry.runId ?? issueId;
    const failureMessage = error ?? "Planning run failed";
    this.applyPlanningFailureDiagnostic(entry, failureMessage, new Date(now));
    await this.updateRunTerminalStateIfRunning(
      runId,
      {
        status: "failed",
        completedAt: now,
        error: failureMessage,
        tokens: entry.activeRunTokens,
        metadata: terminalRunMetadata(entry, "failed"),
      },
      entry.issue,
    );
    const current = (await store.get(issueId)) ?? entry.lifecycle;
    const nextCount = (current?.planningFailureCount ?? 0) + 1;
    await this.updateLifecycle(entry, {
      planningFailureCount: nextCount,
      planningDispatchRetryCount: 0,
      lastPlanningFailureRunId: runId,
      lastPlanningFailureAt: now,
    });
    const lifecycle = entry.lifecycle ?? current;
    if (!lifecycle) {
      await this.releaseIssueClaim(
        entry.issue,
        "planning_failure_missing_lifecycle_released_claim",
        runId,
      );
      return;
    }
    await this.options.runStore?.appendEvent({
      runId,
      at: now,
      source: "orchestrator",
      eventType: PLANNING_FAILURE_DIAGNOSTIC_CODE,
      message: failureMessage,
      payload: {
        status: "failed",
        error: failureMessage,
        tokens: entry.activeRunTokens,
        planningFailureCount: nextCount,
        ...terminalRunMetadata(entry, "failed"),
      },
    });

    const maxFailures = this.config.issueBreakdown.maxPlanningFailures;
    if (nextCount >= maxFailures) {
      await this.escalateLifecycleBlocked(
        entry.issue,
        lifecycle,
        runId,
        maxPlanningFailuresReason(nextCount, maxFailures),
      );
      await this.clearIssueRetry(
        entry.issue,
        "planning_failure_max_failures_cleared_retry",
        runId,
      );
      await this.releaseIssueClaim(
        entry.issue,
        "planning_failure_max_failures_released_claim",
        runId,
      );
      return;
    }

    const delayMs = planningRetryDelayMs(nextCount, this.config);
    await this.scheduleRetryTransition(
      entry.issue,
      nextCount,
      delayMs,
      error,
      "issue_breakdown",
    );
  }

  private async consecutiveSdkErrorFailures(issue: Issue): Promise<number> {
    const runs =
      (await this.options.runStore?.listRunsForIssue(issue.id)) ?? [];
    const seen = new Set<string>();
    const workerRuns = runs
      .filter(
        (run) =>
          run.role === "worker" && !seen.has(run.runId) && seen.add(run.runId),
      )
      .sort(compareRunChronology);
    let count = 0;
    for (const run of workerRuns.slice().reverse()) {
      if (!isCountedSdkWaitErrorFailure(run)) break;
      count += 1;
    }
    return count;
  }

  private async consecutiveInfraFailures(issue: Issue): Promise<number> {
    const runs =
      (await this.options.runStore?.listRunsForIssue(issue.id)) ?? [];
    const seen = new Set<string>();
    const workerRuns = runs
      .filter(
        (run) =>
          run.role === "worker" && !seen.has(run.runId) && seen.add(run.runId),
      )
      .sort(compareRunChronology);
    let count = 0;
    for (const run of workerRuns.slice().reverse()) {
      if (!isCountedInfraFailure(run)) break;
      count += 1;
    }
    return count;
  }

  private async applyWritebacks(
    operations: Array<Parameters<WritebackProcessor["enqueueAndProcess"]>[0]>,
    reason: string,
    issue: Issue | null = null,
  ): Promise<boolean> {
    let ok = true;
    for (const operation of operations) {
      ok = (await this.applyWriteback(operation, reason, issue)) && ok;
    }
    return ok;
  }

  private async applyWriteback(
    operation: Parameters<WritebackProcessor["enqueueAndProcess"]>[0] | null,
    reason: string,
    issue: Issue | null = null,
  ): Promise<boolean> {
    if (!operation) return true;
    if (!this.options.writeback) {
      this.options.logger.warn(
        "writeback operation skipped because no processor is configured",
        {
          issue_id: operation.issueId,
          kind: operation.kind,
          reason,
        },
      );
      return !this.config.writeback.enabled;
    }
    const result = await this.options.writeback.enqueueAndProcess(operation);
    if (issue !== null) {
      await this.recordIssueEvidenceSnapshot({
        issue,
        evidenceKind: "writeback",
        eventType: "writeback_processed",
        sourceId: operation.idempotencyKey,
        reason,
        payload: {
          idempotencyKey: operation.idempotencyKey,
          kind: operation.kind,
          issueId: operation.issueId,
          runId: operation.runId ?? null,
          status: result.status,
          resultStatus: result.resultStatus ?? null,
          resultMessage: result.resultMessage ?? null,
          lastError: result.lastError ?? null,
        },
      });
    }
    return result.status === "succeeded";
  }

  private async shouldScheduleContinuation(
    entry: RunningEntry,
  ): Promise<boolean> {
    let refreshed: Issue[];
    try {
      refreshed = await this.options.tracker.fetchIssueStatesByIds([
        entry.issue.id,
      ]);
    } catch (error) {
      this.options.logger.warn("post-run issue refresh failed", {
        issue_id: entry.issue.id,
        issue_identifier: entry.issue.identifier,
        error: errorMessage(error),
      });
      return true;
    }
    const latest = refreshed[0];
    if (!latest) return false;
    entry.issue = latest;
    return this.shouldDispatchWorker(latest, true, entry.runPhase);
  }

  private async scheduleRetry(
    issueId: string,
    identifier: string,
    attempt: number,
    delayMs: number,
    error: string | null,
    runPhase: AgentRunPhase = "implementation",
  ): Promise<RetryEntry | null> {
    await this.clearIssueRetryById(issueId, "retry_reschedule_cleared_existing");
    if (this.stopped) {
      await this.releaseIssueClaimById(
        issueId,
        "retry_schedule_stopped_released_claim",
      );
      return null;
    }
    const dueAtMs = Date.now() + delayMs;
    const timer = setTimeout(() => {
      const worker = this.onRetryTimer(issueId);
      this.activeRetryWorkers.add(worker);
      worker.finally(() => this.activeRetryWorkers.delete(worker));
      void worker;
    }, delayMs);
    const retry = {
      issueId,
      identifier,
      attempt,
      delayMs,
      dueAtMs,
      timer,
      error,
      runPhase,
    };
    this.retryAttempts.set(issueId, retry);
    return retry;
  }

  private async scheduleRetryTransition(
    issue: Issue,
    attempt: number,
    delayMs: number,
    error: string | null,
    runPhase: AgentRunPhase = "implementation",
  ): Promise<void> {
    const result = await this.processIssueTransitionEvent({
      issue,
      triggerType: "orchestrator.tick",
      triggerSource: "orchestrator",
      candidateSource: "retry_schedule",
      snapshotPatch: {
        retryAttempt: attempt,
        retryDelayMs: delayMs,
        retryError: error,
      },
      transitionPatch: {
        retryAttempt: attempt,
        retryDelayMs: delayMs,
        retryError: error,
        runPhase,
        runKind: runKindForPhase(runPhase),
      },
      attempt,
      allowExistingClaim: true,
    });
    if (result.transition?.transitionKind === "retry_run" && result.acted) {
      return;
    }
    await this.scheduleRetry(
      issue.id,
      issue.identifier,
      attempt,
      delayMs,
      error,
      runPhase,
    );
    const retry = this.retryAttempts.get(issue.id);
    await this.recordIssueEvidenceSnapshot({
      issue,
      evidenceKind: "harness",
      eventType: "retry_scheduled",
      sourceId: issue.id,
      reason: "retry_scheduled_fallback",
      payload: {
        attempt,
        delayMs,
        dueAt:
          retry === undefined ? null : new Date(retry.dueAtMs).toISOString(),
        error,
        runPhase,
      },
    });
  }

  private async onRetryTimer(issueId: string): Promise<void> {
    const retry = this.retryAttempts.get(issueId);
    if (!retry) return;
    this.retryAttempts.delete(issueId);
    try {
      const providerGate = await this.activeProviderDispatchGate();
      if (providerGate) {
        const delayMs =
          providerLimitDelayMs(providerGate) ?? this.config.polling.intervalMs;
        await this.scheduleRetry(
          issueId,
          retry.identifier,
          retry.attempt,
          Math.max(delayMs, this.config.polling.intervalMs),
          retry.error ?? providerGateDispatchBlockedMessage(providerGate),
          retry.runPhase,
        );
        await this.recordRuntimeControlEvidenceForIssueId(issueId, "retry_scheduled", {
          retry: this.retryAttempts.get(issueId) ?? null,
          retrying: true,
          reason: "provider_gate_retry_rescheduled",
        });
        return;
      }
      const candidates = await this.options.tracker.fetchIssueStatesByIds([
        issueId,
      ]);
      const issue = candidates.find((candidate) => candidate.id === issueId);
      if (!issue) {
        await this.releaseIssueClaimById(
          issueId,
          "retry_timer_issue_missing_released_claim",
        );
        return;
      }
      await this.recordRuntimeControlEvidenceSnapshot({
        issue,
        eventType: "retry_fired",
        sourceId: issue.id,
        reason: "retry_timer_fired",
        retry,
        retrying: false,
      });
      await this.recordIssueEvidenceSnapshot({
        issue,
        evidenceKind: "harness",
        eventType: "retry_fired",
        sourceId: issue.id,
        reason: "retry_timer_fired",
        payload: {
          attempt: retry.attempt,
          delayMs: retry.delayMs,
          dueAt: new Date(retry.dueAtMs).toISOString(),
          error: retry.error,
          runPhase: retry.runPhase,
        },
      });
      await this.recordRuntimeControlEvidenceSnapshot({
        issue,
        eventType: "retry_cleared",
        sourceId: issue.id,
        reason: "retry_timer_consumed",
        retry,
        retrying: false,
      });
      await this.recordIssueEvidenceSnapshot({
        issue,
        evidenceKind: "harness",
        eventType: "retry_cleared",
        sourceId: issue.id,
        reason: "retry_timer_consumed",
        payload: {
          attempt: retry.attempt,
          delayMs: retry.delayMs,
          dueAt: new Date(retry.dueAtMs).toISOString(),
          error: retry.error,
          runPhase: retry.runPhase,
        },
      });
      if (retry.runPhase === "issue_breakdown") {
        const remainingMs = await this.planningBackoffRemainingForIssue(issue);
        if (remainingMs > 0) {
          await this.scheduleRetryTransition(
            issue,
            retry.attempt,
            remainingMs,
            retry.error,
            retry.runPhase,
          );
          return;
        }
      }
      if (this.availableSlots() <= 0) {
        if (retry.runPhase === "issue_breakdown") {
          await this.recordPlanningDispatchRetry(
            issue,
            retry,
            "no available orchestrator slots",
          );
        } else {
          await this.scheduleRetryTransition(
            issue,
            retry.attempt + 1,
            1_000,
            "no available orchestrator slots",
            retry.runPhase,
          );
        }
        return;
      }
      const dispatched = await this.processIssueTransitionCandidate({
        issue,
        candidateSource: "retry_timer",
        attempt: retry.attempt,
        allowExistingClaim: true,
      });
      if (!dispatched) {
        if (retry.runPhase === "issue_breakdown") {
          await this.recordPlanningDispatchRetry(
            issue,
            retry,
            retry.error ?? "planning dispatch retry failed",
          );
        } else {
          await this.releaseIssueClaim(
            issue,
            "retry_timer_dispatch_failed_released_claim",
            issueId,
          );
        }
      }
    } catch (error) {
      if (
        retry.runPhase === "issue_breakdown" &&
        retry.attempt >= this.config.issueBreakdown.maxPlanningDispatchRetries
      ) {
        await this.releaseIssueClaimById(
          issueId,
          "retry_timer_max_planning_retries_released_claim",
        );
        return;
      }
      await this.scheduleRetry(
        issueId,
        retry.identifier,
        retry.attempt + 1,
        1_000,
        errorMessage(error),
        retry.runPhase,
      );
      await this.recordRuntimeControlEvidenceForIssueId(issueId, "retry_scheduled", {
        retry: this.retryAttempts.get(issueId) ?? null,
        retrying: true,
        reason: "retry_timer_error_rescheduled",
      });
    }
  }

  private async planningBackoffRemainingForIssue(
    issue: Issue,
  ): Promise<number> {
    const lifecycle = await this.options.lifecycleStore?.get(issue.id);
    if (!lifecycle) return 0;
    return planningBackoffRemainingMs(lifecycle, this.config);
  }

  private async recordPlanningDispatchRetry(
    issue: Issue,
    retry: RetryEntry,
    error: string | null,
  ): Promise<void> {
    const store = this.options.lifecycleStore;
    if (!store) {
      await this.releaseIssueClaim(
        issue,
        "planning_dispatch_retry_missing_store_released_claim",
        retry.identifier,
      );
      return;
    }
    const current = await store.get(issue.id);
    if (current) {
      const remainingMs = planningBackoffRemainingMs(current, this.config);
      if (remainingMs > 0) {
        await this.scheduleRetryTransition(
          issue,
          retry.attempt,
          remainingMs,
          retry.error,
          retry.runPhase,
        );
        return;
      }
    }
    const nextCount = (current?.planningDispatchRetryCount ?? 0) + 1;
    const lifecycle =
      (await this.updateIssueLifecycleWithEvidence(
        issue,
        { planningDispatchRetryCount: nextCount },
        "planning_dispatch_retry",
        retry.identifier,
      )) ?? current;
    if (!lifecycle) {
      await this.releaseIssueClaim(
        issue,
        "planning_dispatch_retry_missing_lifecycle_released_claim",
        retry.identifier,
      );
      return;
    }
    const maxRetries = this.config.issueBreakdown.maxPlanningDispatchRetries;
    if (nextCount >= maxRetries) {
      await this.escalateLifecycleBlocked(
        issue,
        lifecycle,
        lifecycle.summaryPointers.lastRunId ?? retry.identifier,
        maxPlanningDispatchRetriesReason(nextCount, maxRetries),
      );
      await this.clearIssueRetry(
        issue,
        "planning_dispatch_retry_max_retries_cleared_retry",
        retry.identifier,
      );
      await this.releaseIssueClaim(
        issue,
        "planning_dispatch_retry_max_retries_released_claim",
        retry.identifier,
      );
      return;
    }
    const delayMs = planningRetryDelayMs(
      Math.max(lifecycle.planningFailureCount, 1),
      this.config,
    );
    await this.scheduleRetryTransition(
      issue,
      retry.attempt + 1,
      delayMs,
      error,
      retry.runPhase,
    );
  }

  private clearRetry(issueId: string): RetryEntry | null {
    const existing = this.retryAttempts.get(issueId);
    if (!existing) return null;
    clearTimeout(existing.timer);
    this.retryAttempts.delete(issueId);
    return existing;
  }

  private buildRunContext(
    entry: RunningEntry,
    workspace: Workspace,
    attempt: number | null,
    turnNumber: number,
    promptBundle?: AgentPromptBundle,
  ) {
    return {
      issue: entry.issue,
      role: entry.role,
      runPhase: entry.runPhase,
      attempt,
      workspace,
      config: this.config,
      turnNumber,
      ...(entry.runPhase === "issue_breakdown"
        ? { runModeOverride: this.config.issueBreakdown.cursorMode }
        : {}),
      ...(entry.handoffRepair === null
        ? {}
        : { handoffRepair: entry.handoffRepair }),
      ...(entry.manualDispatch === null ? {} : { manualDispatch: true }),
      ...(entry.manualDispatch?.ignoreState === true
        ? { manualDispatchIgnoreState: true }
        : {}),
      ...(entry.hermesResume === null
        ? {}
        : { hermesResume: entry.hermesResume }),
      ...(promptBundle === undefined
        ? {}
        : { ephemeralSystemPrompt: promptBundle.ephemeralSystemPrompt }),
      abortSignal: entry.abortController.signal,
      logger: this.options.logger,
    };
  }

  private assertPromptBundleSupported(bundle: AgentPromptBundle): void {
    if (bundle.ephemeralSystemPrompt.trim().length === 0) return;
    if (harnessSupportsEphemeralSystemPrompt(this.options.harness)) return;
    throw new SymphonyError(
      "config_validation_error",
      `Runtime harness ${this.options.harness.id} does not support Symphony ephemeral system prompts required for ${bundle.metadata.templateKeys.join(", ")}`,
    );
  }

  private async runHandoffRepairIfNeeded(
    entry: RunningEntry,
    workspace: Workspace,
    attempt: number | null,
    turnNumber: number,
  ): Promise<{ attempted: boolean; accepted: boolean }> {
    if (entry.handoffRepair !== null)
      return { attempted: false, accepted: false };
    if (entry.workspace !== workspace)
      return { attempted: false, accepted: false };
    const kind = await this.missingRepairableHandoffKind(entry);
    if (kind === null) return { attempted: false, accepted: false };
    if (!this.isHandoffRepairEnabled(kind))
      return { attempted: false, accepted: false };
    const sourceRunId = entry.activeRunId ?? entry.runId;
    if (!sourceRunId) return { attempted: false, accepted: false };
    const resume = await this.resolveHandoffRepairHermesResume(
      entry,
      sourceRunId,
      kind,
    );
    if (resume === null) return { attempted: false, accepted: false };
    const repairAttempt = await this.nextHandoffRepairAttempt(
      entry,
      sourceRunId,
      kind,
    );
    if (repairAttempt === null) return { attempted: false, accepted: false };

    const parentHistorySnapshotId = entry.issueHistorySnapshotId;
    const parentTransitionKind = await this.transitionKindForHistorySnapshot(
      entry.issue,
      parentHistorySnapshotId,
    );
    const result = await this.requestTransition({
      issue: entry.issue,
      candidateSource: "handoff_repair",
      context: {
        kind: "handoff_repair",
        requestId: `transition_request:${randomUUID()}`,
        requestedAt: new Date().toISOString(),
        parentHistorySnapshotId,
        parentTransitionKind,
        payload: {
          sourceRunId,
          kind,
          repairAttempt,
          turnNumber,
          role: entry.role,
          runPhase: entry.runPhase,
          runKind: runKindForPhase(entry.runPhase),
        },
      },
      transitionPatch: {
        role: entry.role,
        runPhase: entry.runPhase,
        runKind: runKindForPhase(entry.runPhase),
        handoffRepairKind: kind,
        handoffRepairSourceRunId: sourceRunId,
        handoffRepairAttempt: repairAttempt,
        hermesResumeSourceRunId: resume.sourceRunId,
        hermesResumeReason: resume.reason,
        hermesProfileKey: resume.profileKey,
        hermesSessionKey: resume.sessionKey,
      },
      attempt,
      allowExistingClaim: true,
    });
    const attempted =
      result.transition?.transitionKind === "handoff_repair" && result.acted;
    return {
      attempted,
      accepted: attempted
        ? this.entryHasAcceptedRepairableHandoff(entry, kind)
        : false,
    };
  }

  private async missingRepairableHandoffKind(
    entry: RunningEntry,
  ): Promise<RepairableHandoffKind | null> {
    if (entry.role === "triage") {
      return entry.issueTriageReportAccepted ||
        (await this.reconcileIssueTriageHandoff(entry))
        ? null
        : "issue_triage_report";
    }
    if (entry.role === "post_mortem") {
      return entry.issuePostMortemReportAccepted ||
        (await this.reconcileIssuePostMortemHandoff(entry))
        ? null
        : "issue_post_mortem_report";
    }
    if (entry.role === "reviewer") {
      return entry.reviewVerdictAccepted ||
        (await this.reconcileReviewVerdictHandoff(entry))
        ? null
        : "review_verdict";
    }
    if (entry.role === "planner" && entry.runPhase === "issue_breakdown") {
      return entry.issueBreakdownPlanAccepted ||
        (await this.reconcileIssueBreakdownPlanHandoff(entry))
        ? null
        : "issue_breakdown_plan";
    }
    if (entry.role !== "worker") return null;
    if (entry.runPhase === "issue_breakdown") {
      return entry.issueBreakdownPlanAccepted ||
        (await this.reconcileIssueBreakdownPlanHandoff(entry))
        ? null
        : "issue_breakdown_plan";
    }
    if (entry.runPhase === "merge_conflict_resolution") {
      return entry.mergeConflictResolutionAccepted ||
        (await this.reconcileMergeConflictResolutionHandoff(entry))
        ? null
        : "merge_conflict_resolution";
    }
    if (await this.reconcileCompletionReportRejection(entry)) return null;
    return (await this.reconcileCompletionReportHandoff(entry)) ||
      entry.completionReportAccepted ||
      entry.pullRequestHandoffAccepted
      ? null
      : "completion_report";
  }

  private async reconcileRepairableHandoff(
    entry: RunningEntry,
    kind: RepairableHandoffKind,
  ): Promise<boolean> {
    switch (kind) {
      case "completion_report":
        return (
          (await this.reconcileCompletionReportHandoff(entry)) ||
          entry.completionReportAccepted ||
          entry.pullRequestHandoffAccepted
        );
      case "review_verdict":
        return (
          entry.reviewVerdictAccepted ||
          (await this.reconcileReviewVerdictHandoff(entry))
        );
      case "issue_breakdown_plan":
        return (
          entry.issueBreakdownPlanAccepted ||
          (await this.reconcileIssueBreakdownPlanHandoff(entry))
        );
      case "issue_triage_report":
        return (
          entry.issueTriageReportAccepted ||
          (await this.reconcileIssueTriageHandoff(entry))
        );
      case "issue_post_mortem_report":
        return (
          entry.issuePostMortemReportAccepted ||
          (await this.reconcileIssuePostMortemHandoff(entry))
        );
      case "merge_conflict_resolution":
        return (
          entry.mergeConflictResolutionAccepted ||
          (await this.reconcileMergeConflictResolutionHandoff(entry))
        );
    }
  }

  private entryHasAcceptedRepairableHandoff(
    entry: RunningEntry,
    kind: RepairableHandoffKind,
  ): boolean {
    switch (kind) {
      case "completion_report":
        return (
          entry.completionReportAccepted || entry.pullRequestHandoffAccepted
        );
      case "review_verdict":
        return entry.reviewVerdictAccepted;
      case "issue_breakdown_plan":
        return entry.issueBreakdownPlanAccepted;
      case "issue_triage_report":
        return entry.issueTriageReportAccepted;
      case "issue_post_mortem_report":
        return entry.issuePostMortemReportAccepted;
      case "merge_conflict_resolution":
        return entry.mergeConflictResolutionAccepted;
    }
  }

  private async transitionKindForHistorySnapshot(
    issue: Issue,
    historySnapshotId: string | null,
  ): Promise<IssueTransitionKind | null> {
    if (historySnapshotId === null) return null;
    try {
      const record = await this.issueStateStore.get(issue.id);
      return (
        record?.history.find(
          (snapshot) => snapshot.historySnapshotId === historySnapshotId,
        )?.transitionKind ?? null
      );
    } catch (error) {
      this.options.logger.warn("issue transition parent lookup failed", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        history_snapshot_id: historySnapshotId,
        error: errorMessage(error),
      });
      return null;
    }
  }

  private isHandoffRepairEnabled(kind: RepairableHandoffKind): boolean {
    return (
      this.config.handoffRepair.enabled &&
      this.config.handoffRepair.maxAttempts > 0 &&
      this.config.handoffRepair.phases.includes(
        phaseForRepairableHandoffKind(kind),
      )
    );
  }

  private async resolveHandoffRepairHermesResume(
    entry: RunningEntry,
    sourceRunId: string,
    kind: RepairableHandoffKind,
  ): Promise<AgentHermesResumeContext | null> {
    if (this.options.harness.id !== "hermes") return null;
    const sourceRun = await this.options.runStore?.getRun(sourceRunId);
    if (
      !sourceRun ||
      sourceRun.harnessId !== "hermes" ||
      sourceRun.handoffRepairSourceRunId
    )
      return null;
    const resume = hermesResumeContextFromRun(sourceRun, "handoff_repair");
    if (resume === null) {
      this.options.logger.warn(
        "MCP handoff repair skipped because source run is not resumable",
        {
          issue_id: entry.issue.id,
          issue_identifier: entry.issue.identifier,
          source_run_id: sourceRunId,
          kind,
        },
      );
    }
    return resume;
  }

  private async nextHandoffRepairAttempt(
    entry: RunningEntry,
    sourceRunId: string,
    kind: RepairableHandoffKind,
  ): Promise<number | null> {
    const runs =
      (await this.options.runStore?.listRunsForIssue(entry.issue.id)) ?? [];
    const priorAttempts = runs.filter(
      (run) =>
        run.handoffRepairSourceRunId === sourceRunId &&
        run.handoffRepairKind === kind,
    ).length;
    if (priorAttempts >= this.config.handoffRepair.maxAttempts) return null;
    return priorAttempts + 1;
  }

  private async renderHandoffRepairPrompt(
    entry: RunningEntry,
    kind: RepairableHandoffKind,
    sourceRunId: string,
    repairAttempt: number,
  ): Promise<string> {
    const fallback = [
      "Symphony MCP handoff repair:",
      `- Issue: ${entry.issue.identifier} (${entry.issue.id})`,
      `- Source run: ${sourceRunId}`,
      `- Repair attempt: ${repairAttempt} / ${this.config.handoffRepair.maxAttempts}`,
      `- Missing required handoff: ${formatRepairableHandoffKind(kind)}`,
      `- Required tool: ${repairToolName(kind)}`,
      "",
      "You are resuming the same Hermes session only to complete the missing Symphony MCP handoff.",
      "Use the findings and conclusion already present in this session. Do not perform broad new investigation, edit files, create commits, push branches, transition Linear state, or write directly to GitHub/Linear.",
      "Call the required MCP tool now, then stop. If the prior findings are insufficient for a confident success report, submit the safest valid fail/blocked/still-conflicted disposition the tool supports and include that limitation in the evidence.",
    ].join("\n");
    const basePrompt = await this.renderConfiguredPromptTemplate(
      "handoff_repair.mcp_only",
      fallback,
      {
        issue: entry.issue,
        attempt: null,
        role: entry.role,
        lifecycle: entry.lifecycle,
        sourceRunId,
        repairAttempt,
        maxAttempts: this.config.handoffRepair.maxAttempts,
        missingHandoff: formatRepairableHandoffKind(kind),
        requiredTool: repairToolName(kind),
        handoffKind: kind,
      },
    );
    return [basePrompt, "", this.repairMcpPrompt(entry, kind)].join("\n");
  }

  private async renderHandoffRepairPromptBundle(
    entry: RunningEntry,
    kind: RepairableHandoffKind,
    sourceRunId: string,
    repairAttempt: number,
    options: { recordAction?: boolean } = {},
  ): Promise<AgentPromptBundle> {
    const userPrompt = await this.renderHandoffRepairPrompt(
      entry,
      kind,
      sourceRunId,
      repairAttempt,
    );
    return this.renderPromptBundle(
      entry,
      userPrompt,
      "handoff_repair.mcp_only",
      {
        issue: entry.issue,
        attempt: null,
        role: entry.role,
        lifecycle: entry.lifecycle,
        sourceRunId,
        repairAttempt,
        maxAttempts: this.config.handoffRepair.maxAttempts,
        missingHandoff: formatRepairableHandoffKind(kind),
        requiredTool: repairToolName(kind),
        handoffKind: kind,
      },
      {
        attempt: null,
        turnNumber: repairAttempt + 1,
        ...(options.recordAction === undefined
          ? {}
          : { recordAction: options.recordAction }),
      },
    );
  }

  private repairMcpPrompt(
    entry: RunningEntry,
    kind: RepairableHandoffKind,
  ): string {
    switch (kind) {
      case "completion_report":
        return this.workerMcpPrompt(entry) ?? "";
      case "review_verdict": {
        this.requireMcpHandoff("review");
        const workspace = entry.workspace;
        return renderReviewMcpHandoffPrompt({
          issue: entry.issue,
          role: entry.role,
          workspacePath: workspace?.path ?? entry.workspacePath,
          branchName:
            workspace?.gitBranchName ?? entry.issue.branchName ?? null,
          repoPath: workspace?.repoPath ?? null,
          baseRef: workspace?.baseRef ?? null,
        });
      }
      case "issue_breakdown_plan":
        return this.issueBreakdownMcpPrompt(entry);
      case "issue_triage_report":
        return this.issueTriageMcpPrompt(entry);
      case "issue_post_mortem_report":
        return this.issuePostMortemMcpPrompt(entry);
      case "merge_conflict_resolution":
        return this.mergeConflictResolutionMcpPrompt(entry) ?? "";
    }
  }

  private async resolveMergeConflictOriginalWorkerResume(
    entry: RunningEntry,
  ): Promise<AgentHermesResumeContext | null> {
    if (this.options.harness.id !== "hermes") return null;
    if (
      this.config.hermes.mergeConflictSessionReuse !== "implementation_worker"
    )
      return null;
    if (this.config.hermes.workerSessionLifecycle !== "reuse_by_issue")
      return null;
    const runStore = this.options.runStore;
    if (!runStore) return null;
    const lifecycle =
      entry.lifecycle ??
      (await this.options.lifecycleStore?.get(entry.issue.id)) ??
      null;
    const reportRunId = lifecycle
      ? (latestCompletionReport(lifecycle)?.runId ?? null)
      : null;
    const reportRun = reportRunId ? await runStore.getRun(reportRunId) : null;
    const fallbackRun =
      reportRun ??
      [...(await runStore.listRunsForIssue(entry.issue.id))]
        .reverse()
        .find(
          (run) =>
            run.role === "worker" &&
            run.runPhase === "implementation" &&
            run.status === "succeeded",
        ) ??
      null;
    const resume = fallbackRun
      ? hermesResumeContextFromRun(
          fallbackRun,
          "merge_conflict_original_worker",
        )
      : null;
    if (fallbackRun && resume === null) {
      this.options.logger.warn(
        "merge conflict worker session reuse skipped because implementation run is not resumable",
        {
          issue_id: entry.issue.id,
          issue_identifier: entry.issue.identifier,
          implementation_run_id: fallbackRun.runId,
        },
      );
    }
    return resume;
  }

  private applyTokenUpdate(
    entry: RunningEntry,
    tokens: Partial<TokenCounts>,
  ): void {
    const next = {
      inputTokens: tokens.inputTokens ?? entry.activeRunTokens.inputTokens,
      outputTokens: tokens.outputTokens ?? entry.activeRunTokens.outputTokens,
      totalTokens: tokens.totalTokens ?? entry.activeRunTokens.totalTokens,
    };
    const delta = {
      inputTokens: Math.max(
        next.inputTokens - entry.activeRunTokens.inputTokens,
        0,
      ),
      outputTokens: Math.max(
        next.outputTokens - entry.activeRunTokens.outputTokens,
        0,
      ),
      totalTokens: Math.max(
        next.totalTokens - entry.activeRunTokens.totalTokens,
        0,
      ),
    };
    this.totals.inputTokens += delta.inputTokens;
    this.totals.outputTokens += delta.outputTokens;
    this.totals.totalTokens += delta.totalTokens;
    entry.tokens = {
      inputTokens: entry.tokens.inputTokens + delta.inputTokens,
      outputTokens: entry.tokens.outputTokens + delta.outputTokens,
      totalTokens: entry.tokens.totalTokens + delta.totalTokens,
    };
    entry.activeRunTokens = next;
  }

  private async persistHarnessEvent(
    entry: RunningEntry,
    event: AgentEvent,
  ): Promise<void> {
    const runId =
      event.type === "run_status"
        ? event.runId
        : (entry.activeRunId ?? entry.runId);
    if (!runId) return;
    await this.options.runStore?.appendEvent({
      runId,
      at: new Date(event.at ?? Date.now()).toISOString(),
      source: "harness",
      ...mapAgentEventToRunActivityEvent(event),
    });
    if (event.type === "tokens") {
      await this.options.runStore?.updateRun(runId, {
        tokens: entry.activeRunTokens,
      });
    }
  }

  private async recordIncompleteTurn(entry: RunningEntry): Promise<void> {
    const store = this.options.lifecycleStore;
    if (!store) return;
    if (await this.hasPendingPublicationApprovalHandoff(entry)) return;
    const refreshed = await this.refreshEntryIssue(
      entry,
      "incomplete turn refresh",
    );
    if (entry.runPhase === "merge_conflict_resolution") {
      await this.recordMergeConflictAttempt(
        entry,
        "conflict-fix run ended without submit_merge_conflict_resolution",
      );
      return;
    }
    if (!refreshed || !this.isImplementationActive(entry.issue)) {
      await this.updateLifecycle(entry, {
        phase: phaseForIssueState(entry.issue.state, this.config),
      });
      return;
    }

    const incompleteTurnCount = (entry.lifecycle?.incompleteTurnCount ?? 0) + 1;
    await this.updateLifecycle(entry, {
      phase: "implementation",
      incompleteTurnCount,
    });
    if (
      incompleteTurnCount >= this.config.reviewLoop.maxIncompleteTurns &&
      entry.lifecycle
    ) {
      entry.lifecycle = await this.escalateEntryBlocked(
        entry,
        `max incomplete turns reached (${incompleteTurnCount}/${this.config.reviewLoop.maxIncompleteTurns})`,
      );
    }
  }

  private async recordMergeConflictAttempt(
    entry: RunningEntry,
    reason: string,
  ): Promise<void> {
    const store = this.options.lifecycleStore;
    if (!store) return;
    const runId = entry.activeRunId ?? entry.runId ?? entry.issue.id;
    const lifecycle = (await store.get(entry.issue.id)) ?? entry.lifecycle;
    const conflict = lifecycle?.mergeConflict ?? null;
    if (!lifecycle || !conflict || conflict.status !== "open") return;
    if (conflict.attemptRunIds.includes(runId)) {
      entry.lifecycle = lifecycle;
      return;
    }
    const fixTurnCount = conflict.fixTurnCount + 1;
    const attemptRunIds = [...conflict.attemptRunIds, runId];
    const nextConflict: IssueMergeConflictMetadata = {
      ...conflict,
      resolutionStatus:
        fixTurnCount >= conflict.maxFixTurns ? "blocked" : "still_conflicted",
      status: fixTurnCount >= conflict.maxFixTurns ? "blocked" : "open",
      updatedAt: new Date().toISOString(),
      fixTurnCount,
      lastConflictFixRunId: runId,
      attemptRunIds,
      blockedAt:
        fixTurnCount >= conflict.maxFixTurns
          ? new Date().toISOString()
          : conflict.blockedAt,
      blockedReason:
        fixTurnCount >= conflict.maxFixTurns
          ? mergeConflictBlockedReason(fixTurnCount, conflict.maxFixTurns)
          : null,
    };
    await this.updateLifecycle(entry, {
      phase:
        nextConflict.status === "blocked"
          ? "blocked"
          : "merge_conflict_resolution",
      blockedReason: nextConflict.blockedReason,
      mergeConflict: nextConflict,
    });
    if (nextConflict.status === "blocked") {
      await this.applyMergeConflictBlockedWritebacks(
        entry.issue,
        runId,
        nextConflict,
        reason,
      );
      await this.clearIssueRetry(
        entry.issue,
        "merge_conflict_blocked_cleared_retry",
        runId,
      );
    }
  }

  private async applyMergeConflictBlockedWritebacks(
    issue: Issue,
    runId: string,
    conflict: IssueMergeConflictMetadata,
    reason: string,
  ): Promise<void> {
    await this.applyWritebacks(
      planBlockedEscalationWritebacks(
        {
          issue,
          runId,
          reason: conflict.blockedReason ?? reason,
          requiredAction: [
            "Merge conflicts remain unresolved after the configured conflict-fix attempts.",
            `Pull request: ${formatPullRequest(conflict.pullRequest.number, conflict.pullRequest.url)}`,
            `Approved head SHA: ${conflict.approvedHeadSha}`,
            `Latest conflict head SHA: ${conflict.currentHeadSha}`,
            `Conflict-fix attempts: ${conflict.fixTurnCount}/${conflict.maxFixTurns}`,
            "Resolve the conflicts manually or reset approval before returning the issue to Symphony.",
          ].join("\n"),
        },
        this.config,
      ),
      "merge conflict blocked escalation",
      issue,
    );
  }

  private async refreshEntryIssue(
    entry: RunningEntry,
    reason: string,
  ): Promise<boolean> {
    try {
      const refreshed = await this.options.tracker.fetchIssueStatesByIds([
        entry.issue.id,
      ]);
      const latest = refreshed[0];
      if (!latest) return false;
      entry.issue = latest;
      return true;
    } catch (error) {
      this.options.logger.warn(reason, {
        issue_id: entry.issue.id,
        issue_identifier: entry.issue.identifier,
        error: errorMessage(error),
      });
      return true;
    }
  }

  private isImplementationActive(issue: Issue): boolean {
    return (
      issue.assignedToWorker &&
      isStateIn(issue.state, this.config.tracker.activeStates) &&
      !isStateIn(issue.state, this.config.tracker.handoffStates) &&
      !isStateIn(issue.state, this.config.reviewLoop.reviewStates) &&
      !isStateIn(issue.state, this.config.reviewLoop.blockedStates) &&
      !isStateIn(issue.state, this.config.tracker.terminalStates)
    );
  }

  private async escalateEntryBlocked(
    entry: RunningEntry,
    reason: string,
  ): Promise<IssueLifecycleRecord | null> {
    const lifecycle =
      entry.lifecycle ??
      (await this.options.lifecycleStore?.get(entry.issue.id));
    if (!lifecycle) return null;
    entry.lifecycle = await this.escalateLifecycleBlocked(
      entry.issue,
      lifecycle,
      entry.activeRunId ?? entry.runId ?? entry.issue.id,
      reason,
    );
    return entry.lifecycle;
  }

  private async escalateLifecycleBlocked(
    issue: Issue,
    lifecycle: IssueLifecycleRecord,
    runId: string,
    reason: string,
  ): Promise<IssueLifecycleRecord> {
    const result = await this.processIssueTransitionEvent({
      issue,
      triggerType: "orchestrator.tick",
      triggerSource: "orchestrator",
      candidateSource: "block_issue",
      snapshotPatch: {
        triggerRunId: runId,
        triggerReason: reason,
      },
      transitionPatch: {
        runId,
        blockedReason: reason,
      },
      allowExistingClaim: true,
    });
    if (result.transition?.transitionKind === "block_issue" && result.acted) {
      return (await this.options.lifecycleStore?.get(issue.id)) ?? lifecycle;
    }
    return this.applyLifecycleBlocked(issue, lifecycle, runId, reason);
  }

  private async applyLifecycleBlocked(
    issue: Issue,
    lifecycle: IssueLifecycleRecord,
    runId: string,
    reason: string,
  ): Promise<IssueLifecycleRecord> {
    const store = this.options.lifecycleStore;
    const blockedLifecycle =
      (await this.updateIssueLifecycleWithEvidence(
        issue,
        {
          phase: "blocked",
          blockedReason: reason,
        },
        "block_issue",
        runId,
      )) ?? lifecycle;
    await this.applyWritebacks(
      planBlockedEscalationWritebacks(
        {
          issue,
          runId,
          reason,
          incompleteTurnCount: blockedLifecycle.incompleteTurnCount,
          maxIncompleteTurns: this.config.reviewLoop.maxIncompleteTurns,
          reviewRound: blockedLifecycle.reviewRound,
          maxReviewRounds:
            this.config.reviewLoop.failureLimits.reviewerFailures,
          lastCompletionReport: latestCompletionReport(blockedLifecycle),
          lastReviewVerdict: latestReviewVerdict(blockedLifecycle),
          requiredAction:
            "Inspect the latest run output and reviewer feedback, then move the issue out of the blocked state when Symphony should try again.",
        },
        this.config,
      ),
      "blocked escalation",
      issue,
    );
    return blockedLifecycle;
  }

  private async reconcileCompletionReportHandoff(
    entry: RunningEntry,
  ): Promise<boolean> {
    return this.requestHandoffReconciliationTransition(
      entry,
      "completion_report",
    );
  }

  private async reconcileCompletionReportRejection(
    entry: RunningEntry,
  ): Promise<boolean> {
    const runId = entry.activeRunId ?? entry.runId;
    if (!this.options.lifecycleStore || !runId) return false;
    const parentHistorySnapshotId = entry.issueHistorySnapshotId;
    const parentTransitionKind = await this.transitionKindForHistorySnapshot(
      entry.issue,
      parentHistorySnapshotId,
    );
    const result = await this.requestTransition({
      issue: entry.issue,
      candidateSource: "completion_report_rejection",
      context: {
        kind: "completion_report_rejection",
        requestId: `transition_request:${randomUUID()}`,
        requestedAt: new Date().toISOString(),
        parentHistorySnapshotId,
        parentTransitionKind,
        payload: {
          runId,
          role: entry.role,
          runPhase: entry.runPhase,
          runKind: runKindForPhase(entry.runPhase),
        },
      },
      transitionPatch: {
        role: entry.role,
        runPhase: entry.runPhase,
        runKind: runKindForPhase(entry.runPhase),
        runId,
      },
      allowExistingClaim: true,
    });
    return (
      result.transition?.transitionKind ===
        "reconcile_completion_report_rejection" && result.acted
    );
  }

  private async reconcileMergeConflictResolutionHandoff(
    entry: RunningEntry,
  ): Promise<boolean> {
    return this.requestHandoffReconciliationTransition(
      entry,
      "merge_conflict_resolution",
    );
  }

  private async reconcileIssueBreakdownPlanHandoff(
    entry: RunningEntry,
  ): Promise<boolean> {
    return this.requestHandoffReconciliationTransition(
      entry,
      "issue_breakdown_plan",
    );
  }

  private async reconcileIssueTriageHandoff(
    entry: RunningEntry,
  ): Promise<boolean> {
    return this.requestHandoffReconciliationTransition(
      entry,
      "issue_triage_report",
    );
  }

  private async reconcileIssuePostMortemHandoff(
    entry: RunningEntry,
  ): Promise<boolean> {
    return this.requestHandoffReconciliationTransition(
      entry,
      "issue_post_mortem_report",
    );
  }

  private async reconcileReviewVerdictHandoff(
    entry: RunningEntry,
  ): Promise<boolean> {
    return this.requestHandoffReconciliationTransition(entry, "review_verdict");
  }

  private async requestHandoffReconciliationTransition(
    entry: RunningEntry,
    handoffKind: AgentHandoffRepairKind,
  ): Promise<boolean> {
    if (this.entryHasAcceptedRepairableHandoff(entry, handoffKind)) return true;
    const runId = entry.activeRunId ?? entry.runId;
    if (!this.options.lifecycleStore || !runId) return false;
    const parentHistorySnapshotId = entry.issueHistorySnapshotId;
    const parentTransitionKind = await this.transitionKindForHistorySnapshot(
      entry.issue,
      parentHistorySnapshotId,
    );
    const result = await this.requestTransition({
      issue: entry.issue,
      candidateSource: "handoff_reconciliation",
      context: {
        kind: "handoff_reconciliation",
        requestId: `transition_request:${randomUUID()}`,
        requestedAt: new Date().toISOString(),
        parentHistorySnapshotId,
        parentTransitionKind,
        payload: {
          runId,
          handoffKind,
          role: entry.role,
          runPhase: entry.runPhase,
          runKind: runKindForPhase(entry.runPhase),
        },
      },
      transitionPatch: {
        role: entry.role,
        runPhase: entry.runPhase,
        runKind: runKindForPhase(entry.runPhase),
        runId,
        handoffKind,
      },
      allowExistingClaim: true,
    });
    if (result.transition?.transitionKind === "base_ref_observe" && result.acted) {
      await this.continueBaseRefTransitionChain(entry.issue, result.transition);
      return true;
    }
    return (
      result.transition?.transitionKind ===
        handoffReconciliationTransitionKind(handoffKind) && result.acted
    );
  }

  private async processMergePolicyTransitionCandidate(
    issue: Issue,
  ): Promise<void> {
    await this.continueMergePolicyTransitionChain(issue, null);
  }

  private async continueMergePolicyTransitionChain(
    issue: Issue,
    initialPreviousTransition: IssueHistorySnapshot | null,
  ): Promise<void> {
    const chainId = `merge_policy_chain:${randomUUID()}`;
    const maxIterations = 6;
    let previousTransition = initialPreviousTransition;
    const startIteration = previousTransition === null ? 0 : 1;
    for (
      let iteration = startIteration;
      iteration < maxIterations;
      iteration += 1
    ) {
      const result = await this.requestTransition({
        issue,
        candidateSource: "merge_policy_chain",
        context: {
          kind: "merge_policy_chain",
          requestId: `transition_request:${randomUUID()}`,
          requestedAt: new Date().toISOString(),
          parentHistorySnapshotId:
            previousTransition?.historySnapshotId ?? null,
          parentTransitionKind: previousTransition?.transitionKind ?? null,
          payload: {
            chainId,
            iteration,
            maxIterations,
          },
        },
      });
      if (
        result.transition === null ||
        result.transition.transitionKind === "noop" ||
        !result.acted
      )
        return;
      previousTransition = result.transition;
      if (baseRefTransitionShouldContinue(result.transition.transitionKind)) {
        await this.continueBaseRefTransitionChain(issue, result.transition);
        return;
      }
      if (
        !mergePolicyTransitionShouldContinue(result.transition.transitionKind)
      )
        return;
    }
    this.options.logger.warn(
      "merge policy transition chain reached iteration cap",
      {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        chain_id: chainId,
        max_iterations: maxIterations,
      },
    );
  }

  private async continueBaseRefTransitionChain(
    issue: Issue,
    initialPreviousTransition: IssueHistorySnapshot,
  ): Promise<void> {
    const targetRequest = baseRefTargetRequestFromTransition(
      initialPreviousTransition,
    );
    if (targetRequest === null) return;
    const chainId = `base_ref_chain:${randomUUID()}`;
    const maxIterations = 3;
    let previousTransition = initialPreviousTransition;
    for (let iteration = 1; iteration < maxIterations; iteration += 1) {
      const result = await this.requestTransition({
        issue,
        candidateSource: "base_ref_chain",
        context: {
          kind: "base_ref_chain",
          requestId: `transition_request:${randomUUID()}`,
          requestedAt: new Date().toISOString(),
          parentHistorySnapshotId: previousTransition.historySnapshotId,
          parentTransitionKind: previousTransition.transitionKind,
          payload: {
            targetTransitionKind: targetRequest.transitionKind,
            targetRequest,
            chainId,
            iteration,
            maxIterations,
          },
        },
      });
      if (
        result.transition === null ||
        result.transition.transitionKind === "noop" ||
        !result.acted
      )
        return;
      previousTransition = result.transition;
      if (!baseRefTransitionShouldContinue(result.transition.transitionKind))
        return;
    }
    this.options.logger.warn("base ref transition chain reached iteration cap", {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      chain_id: chainId,
      max_iterations: maxIterations,
      target_transition_kind: targetRequest.transitionKind,
    });
  }

  private async updateLifecycle(
    entry: RunningEntry,
    patch: IssueLifecyclePatch,
  ): Promise<void> {
    const store = this.options.lifecycleStore;
    if (!store) return;
    entry.lifecycle = await store.updateIssue(entry.issue, patch);
    await this.recordLifecycleEvidenceSnapshot({
      issue: entry.issue,
      lifecycle: entry.lifecycle,
      patch,
      sourceId: entry.activeRunId ?? entry.runId,
      reason: "lifecycle_updated",
    });
    await appendLaneMemoTelemetry(
      this.options.runStore,
      entry.activeRunId,
      entry.lifecycle,
      "orchestrator_update",
    );
  }

  private async recordWorkspaceEvidenceSnapshot(
    entry: RunningEntry,
    eventType: string,
    workspace: Workspace,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    await this.recordIssueEvidenceSnapshot({
      issue: entry.issue,
      evidenceKind: "workspace",
      eventType,
      sourceId: entry.activeRunId ?? entry.runId ?? workspace.workspaceKey,
      reason: eventType,
      payload: {
        workspaceKey: workspace.workspaceKey,
        workspacePath: workspace.path,
        gitBranchName: workspace.gitBranchName ?? null,
        repoPath: workspace.repoPath ?? null,
        baseRef: workspace.baseRef ?? null,
        role: entry.role,
        runPhase: entry.runPhase,
        runKind: runKindForPhase(entry.runPhase),
        ...details,
      },
    });
  }

  private async prepareHarnessForRun(
    entry: RunningEntry,
    workspace: Workspace,
    attempt: number | null,
    turnNumber: number,
    promptBundle?: AgentPromptBundle,
  ): Promise<void> {
    if (typeof this.options.harness.prepare !== "function") return;
    await this.options.harness.prepare(
      this.buildRunContext(entry, workspace, attempt, turnNumber, promptBundle),
    );
    await this.recordIssueEvidenceSnapshot({
      issue: entry.issue,
      evidenceKind: "harness",
      eventType: "harness_prepare_completed",
      sourceId:
        entry.activeRunId ?? entry.runId ?? entry.issueHistorySnapshotId,
      reason: "harness_prepare_completed",
      payload: {
        harnessId: this.options.harness.id,
        role: entry.role,
        runPhase: entry.runPhase,
        runKind: runKindForPhase(entry.runPhase),
        attempt,
        turnNumber,
        workspaceKey: workspace.workspaceKey,
        workspacePath: workspace.path,
        promptTemplateKeys: promptBundle?.metadata.templateKeys ?? null,
      },
    });
  }

  private async reloadHarnessForRun(
    entry: RunningEntry,
    workspace: Workspace,
    attempt: number | null,
    turnNumber: number,
    promptBundle?: AgentPromptBundle,
  ): Promise<void> {
    if (typeof this.options.harness.reload !== "function") return;
    await this.options.harness.reload(
      this.buildRunContext(entry, workspace, attempt, turnNumber, promptBundle),
    );
    await this.recordIssueEvidenceSnapshot({
      issue: entry.issue,
      evidenceKind: "harness",
      eventType: "harness_reload_completed",
      sourceId:
        entry.activeRunId ?? entry.runId ?? entry.issueHistorySnapshotId,
      reason: "harness_reload_completed",
      payload: {
        harnessId: this.options.harness.id,
        role: entry.role,
        runPhase: entry.runPhase,
        runKind: runKindForPhase(entry.runPhase),
        attempt,
        turnNumber,
        workspaceKey: workspace.workspaceKey,
        workspacePath: workspace.path,
        promptTemplateKeys: promptBundle?.metadata.templateKeys ?? null,
      },
    });
  }

  private shouldDiscoverPullRequestBeforeFirstWorkerPrompt(
    lifecycle: IssueLifecycleRecord | null | undefined,
  ): boolean {
    const gate = lifecycle?.mergeGate ?? null;
    return gate?.status === "repair_dispatched" || gate?.status === "blocked";
  }

  private async discoverPullRequestForEntry(
    entry: RunningEntry,
    workspace: Workspace,
  ): Promise<void> {
    const branchName = workspace.gitBranchName ?? entry.issue.branchName;
    if (!branchName) return;

    let pullRequest: DiscoveredPullRequest | null;
    try {
      const client =
        this.options.pullRequestClient ??
        createGitHubPullRequestClientForCapability(
          this.config,
          "github.discovery",
        );
      pullRequest = await client.findOpenPullRequestByBranch({ branchName });
    } catch (error) {
      this.options.logger.warn("pull request discovery failed", {
        issue_id: entry.issue.id,
        issue_identifier: entry.issue.identifier,
        branch_name: branchName,
        error: errorMessage(error),
      });
      return;
    }
    if (!pullRequest) return;

    const metadata = {
      prUrl: pullRequest.url,
      prNumber: pullRequest.number,
      prHeadSha: pullRequest.headSha,
      prBranch: pullRequest.headBranch,
      lastPushedAt: pullRequest.lastPushedAt,
      gitBranchName: branchName,
      repoPath: workspace.repoPath ?? null,
      baseRef: workspace.baseRef ?? null,
    };
    await this.updateLifecycle(entry, {
      summaryPointers: {
        prUrl: metadata.prUrl,
        prNumber: metadata.prNumber,
        prHeadSha: metadata.prHeadSha,
        prBranch: metadata.prBranch,
        lastPushedAt: metadata.lastPushedAt,
        gitBranchName: metadata.gitBranchName,
        branchName: metadata.gitBranchName,
        repoPath: metadata.repoPath,
        baseRef: metadata.baseRef,
      },
    });
    const staleGatePatch = entry.lifecycle
      ? staleMergeGateLifecyclePatch(
          entry.lifecycle,
          metadata.prHeadSha,
          metadata.prNumber,
        )
      : null;
    if (staleGatePatch) {
      await this.updateLifecycle(entry, {
        ...staleGatePatch,
        blockedReason: null,
      });
    }

    const runId = entry.activeRunId ?? entry.runId;
    if (!runId || !this.options.runStore) return;
    const existing = await this.options.runStore.getRun(runId);
    if (
      existing?.prUrl === metadata.prUrl &&
      existing.prNumber === metadata.prNumber &&
      existing.prHeadSha === metadata.prHeadSha &&
      existing.prBranch === metadata.prBranch &&
      (existing.lastPushedAt ?? null) === metadata.lastPushedAt
    ) {
      return;
    }
    await this.options.runStore.recordPullRequestEvent({
      runId,
      action: existing?.prUrl ? "updated" : "opened",
      prUrl: metadata.prUrl,
      prNumber: metadata.prNumber,
      prHeadSha: metadata.prHeadSha,
      prBranch: metadata.prBranch,
      lastPushedAt: metadata.lastPushedAt,
      gitBranchName: metadata.gitBranchName,
      repoPath: metadata.repoPath,
      baseRef: metadata.baseRef,
    });
    await this.recordIssueEvidenceSnapshot({
      issue: entry.issue,
      evidenceKind: "run",
      eventType: "run_pull_request_updated",
      sourceId: runId,
      reason: existing?.prUrl
        ? "run_pull_request_updated"
        : "run_pull_request_opened",
      payload: {
        runId,
        prUrl: metadata.prUrl,
        prNumber: metadata.prNumber,
        prHeadSha: metadata.prHeadSha,
        prBranch: metadata.prBranch,
        gitBranchName: metadata.gitBranchName,
        repoPath: metadata.repoPath,
        baseRef: metadata.baseRef,
      },
    });
  }

  private async loadReviewerDispatchEvidence(
    issue: Issue,
  ): Promise<ReviewerDispatchEvidence | null> {
    const lifecycle = await this.options.lifecycleStore?.get(issue.id);
    const completionReport = lifecycle
      ? latestCompletionReport(lifecycle)
      : null;
    if (!lifecycle || !completionReport) return null;
    const workerRun =
      (await this.options.runStore?.getRun(completionReport.runId)) ?? null;
    const transcript = this.options.runStore
      ? await this.options.runStore.readTranscript(completionReport.runId, {
          limit: 50,
        })
      : null;
    return {
      lifecycle,
      completionReport,
      workerRun,
      runDigest: digestTranscript(workerRun, transcript?.events ?? []),
    };
  }

  private reviewerPromptTemplate(): string {
    const configured = this.config.reviewLoop.reviewerPromptTemplate;
    if (configured !== null && configured.trim().length > 0) return configured;
    return DEFAULT_REVIEWER_PROMPT_TEMPLATE;
  }

  private async renderConfiguredPromptTemplate(
    templateKey: string,
    fallbackTemplate: string,
    input: Parameters<PromptRenderer["render"]>[1],
  ): Promise<string> {
    const template = await this.loadConfiguredPromptTemplate(
      templateKey,
      fallbackTemplate,
    );
    const renderer =
      this.config.prompts.templatesDir === null
        ? this.promptRenderer
        : new PromptRenderer({ root: this.config.prompts.templatesDir });
    return renderer.render(template, input);
  }

  private async loadConfiguredPromptTemplate(
    templateKey: string,
    fallbackTemplate: string,
  ): Promise<string> {
    const templatesDir = this.config.prompts.templatesDir;
    const relativePath = this.config.prompts.templates[templateKey];
    if (templatesDir === null || relativePath === undefined)
      return fallbackTemplate;
    const templatePath = path.resolve(templatesDir, relativePath);
    return fs.readFile(templatePath, "utf8");
  }

  private async renderPromptBundle(
    entry: RunningEntry,
    userPrompt: string,
    userTemplateKey: string,
    input: Parameters<PromptRenderer["render"]>[1],
    options: {
      attempt: number | null;
      turnNumber: number;
      reviewerEvidence?: ReviewerDispatchEvidence | null;
      recordAction?: boolean;
    } = {
      attempt: null,
      turnNumber: 1,
    },
  ): Promise<AgentPromptBundle> {
    const systemTemplateKey = `${userTemplateKey}.system`;
    const system = await this.renderEphemeralSystemPrompt(
      entry,
      systemTemplateKey,
      {
        ...input,
        attempt: options.attempt,
        role: entry.role,
        lifecycle: entry.lifecycle,
        ...this.ephemeralSystemPromptInput(entry, options),
      },
    );
    const bundle = {
      userPrompt,
      ephemeralSystemPrompt: system.prompt,
      metadata: {
        templateKeys: [userTemplateKey, systemTemplateKey],
        warnings: system.warnings,
        userPromptCharCount: userPrompt.length,
        ephemeralSystemPromptCharCount: system.prompt.length,
      },
    };
    if (
      options.recordAction !== false &&
      entry.issueHistorySnapshotId !== null
    ) {
      await this.recordIssueEvidenceSnapshot({
        issue: entry.issue,
        evidenceKind: "run",
        eventType: "prompt_rendered",
        sourceId:
          entry.activeRunId ?? entry.runId ?? entry.issueHistorySnapshotId,
        reason: "prompt_rendered",
        payload: {
          role: entry.role,
          runPhase: entry.runPhase,
          runKind: runKindForPhase(entry.runPhase),
          attempt: options.attempt,
          turnNumber: options.turnNumber,
          userTemplateKey,
          metadata: bundle.metadata,
        },
      });
    }
    return bundle;
  }

  private async renderEphemeralSystemPrompt(
    entry: RunningEntry,
    templateKey: string,
    input: Parameters<PromptRenderer["render"]>[1],
  ): Promise<{ prompt: string; warnings: string[] }> {
    const rendered = (
      await this.renderConfiguredPromptTemplate(
        templateKey,
        DEFAULT_EPHEMERAL_SYSTEM_PROMPT_TEMPLATE,
        input,
      )
    ).trim();
    const warnings = Array.isArray(input.warnings)
      ? input.warnings.filter(
          (item): item is string => typeof item === "string",
        )
      : [];
    if (rendered.length > EPHEMERAL_SYSTEM_PROMPT_MAX_CHARS) {
      throw new SymphonyError(
        "config_validation_error",
        `Ephemeral system prompt for ${entry.issue.identifier} is ${rendered.length} chars, exceeding ${EPHEMERAL_SYSTEM_PROMPT_MAX_CHARS}. Shorten the Issue Contract or prompt template before dispatch.`,
      );
    }
    return { prompt: rendered, warnings };
  }

  private ephemeralSystemPromptInput(
    entry: RunningEntry,
    options: {
      attempt: number | null;
      turnNumber: number;
      reviewerEvidence?: ReviewerDispatchEvidence | null;
    },
  ): Record<string, unknown> {
    const lifecycle =
      entry.lifecycle === null ? null : currentPromptLifecycle(entry.lifecycle);
    const contract = summarizeIssueContractForPrompt(
      entry.issue.description,
      this.config.agent.protectedPaths,
    );
    const warnings = [
      ...contract.missingSections.map(
        (section) => `Missing issue authoring section: ${section}`,
      ),
      ...contract.issueContractErrors,
      ...contract.underSpecifiedContractErrors,
    ];
    return {
      rolePhase: formatRolePhaseDirective(entry, options),
      currentObjective: currentObjectiveDirective(entry, lifecycle, options),
      pinnedIssueContract: formatPinnedIssueContract(contract),
      activeDirective: activeDirectiveForRun(entry, lifecycle, options),
      successConditions: successConditionsForRun(entry, lifecycle, options),
      scopeGuards: scopeGuardsForRun(entry, options),
      requiredHandoff: requiredHandoffForRun(entry),
      warnings,
    };
  }

  private formatRenderedReviewerPrompt(
    prompt: string,
    mcpHandoff: Parameters<typeof renderReviewMcpHandoffPrompt>[0],
  ): string {
    const configured = this.config.reviewLoop.reviewerPromptTemplate;
    if (configured !== null && configured.trim().length > 0) return prompt;
    const rendered = prompt
      .replace(
        PROJECT_REVIEWER_PROMPT_EXTENSIONS_MARKER,
        formatPromptExtensions(
          "Project-specific reviewer extensions:",
          this.config.reviewLoop.reviewerPromptExtensions,
        ) ?? "",
      )
      .trim();
    return [rendered, renderReviewMcpHandoffPrompt(mcpHandoff)]
      .join("\n")
      .trim();
  }

  private async renderWorkerPrompt(
    entry: RunningEntry,
    attempt: number | null,
  ): Promise<string> {
    if (entry.runPhase === "merge_conflict_resolution")
      return this.renderMergeConflictResolutionPrompt(entry);
    const issueBreakdownPlan = await this.loadIssueBreakdownPlanPrompt(entry);
    const reviewHardening = this.workerReviewHardeningPrompt();
    const reviewEvidence = await this.loadWorkerReviewEvidencePrompt(entry);
    const handoff = await this.loadWorkerHandoffPrompt(entry);
    const mergeGateResult = await this.loadWorkerMergeGatePromptResult(entry);
    const mergeGate = mergeGateResult?.text ?? null;
    const reviewVerdict =
      mergeGateResult?.kind === "repair"
        ? null
        : await this.loadWorkerReviewVerdictPrompt(entry);
    const basePrompt = await this.renderConfiguredPromptTemplate(
      workerImplementationTemplateKey(entry, mergeGateResult, reviewVerdict),
      this.promptTemplate,
      {
        issue: entry.issue,
        attempt,
        role: entry.role,
        lifecycle: entry.lifecycle,
        reviewerPromptExtensions:
          this.config.reviewLoop.reviewerPromptExtensions,
        workerPromptExtensions: this.config.reviewLoop.workerPromptExtensions,
      },
    );
    return formatUserPromptPacket("Symphony Worker Evidence Packet", [
      ["Primary Assignment", basePrompt],
      ["Issue Breakdown Plan", issueBreakdownPlan],
      ["Review Loop Hardening", reviewHardening],
      ["Compact Handoff", handoff],
      ["MCP Handoff Instructions", this.workerMcpPrompt(entry)],
      ["Merge Gate Evidence", mergeGate],
      ["Reviewer Verdict Evidence", reviewVerdict],
      ["Pull Request Review Evidence", reviewEvidence],
    ]);
  }

  private async renderWorkerPromptBundle(
    entry: RunningEntry,
    attempt: number | null,
    turnNumber: number,
  ): Promise<AgentPromptBundle> {
    if (entry.runPhase === "merge_conflict_resolution") {
      const userPrompt = await this.renderMergeConflictResolutionPrompt(entry);
      return this.renderPromptBundle(
        entry,
        userPrompt,
        "worker.merge_conflict.resolve",
        {
          issue: entry.issue,
          attempt,
          role: entry.role,
          lifecycle: entry.lifecycle,
          workspace: entry.workspace,
        },
        { attempt, turnNumber },
      );
    }
    const mergeGateResult = await this.loadWorkerMergeGatePromptResult(entry);
    const reviewVerdict =
      mergeGateResult?.kind === "repair"
        ? null
        : await this.loadWorkerReviewVerdictPrompt(entry);
    const userTemplateKey = workerImplementationTemplateKey(
      entry,
      mergeGateResult,
      reviewVerdict,
    );
    const userPrompt = await this.renderWorkerPrompt(entry, attempt);
    return this.renderPromptBundle(
      entry,
      userPrompt,
      userTemplateKey,
      {
        issue: entry.issue,
        attempt,
        role: entry.role,
        lifecycle: entry.lifecycle,
        reviewerPromptExtensions:
          this.config.reviewLoop.reviewerPromptExtensions,
        workerPromptExtensions: this.config.reviewLoop.workerPromptExtensions,
      },
      { attempt, turnNumber },
    );
  }

  private async renderIssueBreakdownPrompt(
    entry: RunningEntry,
    attempt: number | null,
  ): Promise<string> {
    const basePrompt = await this.renderConfiguredPromptTemplate(
      "planner.issue_breakdown.speckit_to_linear",
      this.config.issueBreakdown.promptTemplate,
      {
        issue: entry.issue,
        attempt,
        role: entry.role,
        lifecycle: entry.lifecycle,
        applyToLinear: this.config.issueBreakdown.applyToLinear,
      },
    );
    return [basePrompt, this.issueBreakdownMcpPrompt(entry)].join("\n");
  }

  private async renderIssueBreakdownPromptBundle(
    entry: RunningEntry,
    attempt: number | null,
  ): Promise<AgentPromptBundle> {
    const userPrompt = await this.renderIssueBreakdownPrompt(entry, attempt);
    return this.renderPromptBundle(
      entry,
      userPrompt,
      "planner.issue_breakdown.speckit_to_linear",
      {
        issue: entry.issue,
        attempt,
        role: entry.role,
        lifecycle: entry.lifecycle,
        applyToLinear: this.config.issueBreakdown.applyToLinear,
      },
      { attempt, turnNumber: 1 },
    );
  }

  private async renderReviewerPrompt(
    entry: RunningEntry,
    evidence: ReviewerDispatchEvidence,
    workspace: Workspace,
  ): Promise<string> {
    const rendered = await this.renderConfiguredPromptTemplate(
      "reviewer.review.exhaustive",
      this.reviewerPromptTemplate(),
      {
        issue: entry.issue,
        attempt: null,
        role: "reviewer",
        completionReport: evidence.completionReport,
        acceptanceCriteria: acceptanceCriteriaForReport(
          evidence.completionReport,
        ),
        workspaceEvidence: workspaceEvidenceForReview(
          entry.issue,
          workspace,
          evidence,
        ),
        validationEvidence: evidence.completionReport.validationEvidence,
        runDigest: evidence.runDigest,
        reviewerPromptExtensions:
          this.config.reviewLoop.reviewerPromptExtensions,
        workerPromptExtensions: this.config.reviewLoop.workerPromptExtensions,
      },
    );
    return this.formatRenderedReviewerPrompt(rendered, {
      issue: entry.issue,
      role: "reviewer",
      workspacePath: workspace.path,
      branchName: workspace.gitBranchName ?? entry.issue.branchName ?? null,
      repoPath: workspace.repoPath ?? null,
      baseRef: workspace.baseRef ?? null,
    });
  }

  private async renderReviewerPromptBundle(
    entry: RunningEntry,
    evidence: ReviewerDispatchEvidence,
    workspace: Workspace,
  ): Promise<AgentPromptBundle> {
    const userPrompt = await this.renderReviewerPrompt(
      entry,
      evidence,
      workspace,
    );
    return this.renderPromptBundle(
      entry,
      userPrompt,
      "reviewer.review.exhaustive",
      {
        issue: entry.issue,
        attempt: null,
        role: "reviewer",
        lifecycle: entry.lifecycle,
        completionReport: evidence.completionReport,
        acceptanceCriteria: acceptanceCriteriaForReport(
          evidence.completionReport,
        ),
        workspaceEvidence: workspaceEvidenceForReview(
          entry.issue,
          workspace,
          evidence,
        ),
        validationEvidence: evidence.completionReport.validationEvidence,
        runDigest: evidence.runDigest,
        reviewerPromptExtensions:
          this.config.reviewLoop.reviewerPromptExtensions,
        workerPromptExtensions: this.config.reviewLoop.workerPromptExtensions,
      },
      { attempt: null, turnNumber: 1, reviewerEvidence: evidence },
    );
  }

  private async renderIssueTriagePrompt(entry: RunningEntry): Promise<string> {
    const lifecycle =
      (await this.options.lifecycleStore?.get(entry.issue.id)) ??
      entry.lifecycle;
    if (!lifecycle)
      throw new SymphonyError(
        "invalid_request",
        "Issue triage prompt requires lifecycle evidence",
      );
    const workspace = entry.workspace;
    const report = latestCompletionReport(lifecycle);
    const verdict = latestReviewVerdict(lifecycle);
    const gate = lifecycle.mergeGate ?? null;
    const triggerFingerprint = issueTriageTriggerFingerprint(lifecycle);
    if (
      this.config.prompts.templates["triage.issue_blocked.classify"] !==
      undefined
    ) {
      const basePrompt = await this.renderConfiguredPromptTemplate(
        "triage.issue_blocked.classify",
        "",
        {
          issue: entry.issue,
          attempt: null,
          role: entry.role,
          lifecycle,
          report,
          verdict,
          gate,
          triggerFingerprint,
          blockerKinds: ISSUE_TRIAGE_BLOCKER_KINDS,
          blockerStatuses: ISSUE_TRIAGE_BLOCKER_STATUSES,
          blockerNextActors: ISSUE_TRIAGE_BLOCKER_NEXT_ACTORS,
          triageLedger: issueTriageLedgerLines(
            lifecycle,
            report,
            verdict,
            gate,
          ).join("\n"),
        },
      );
      return [basePrompt, this.issueTriageMcpPrompt(entry)].join("\n");
    }
    return [
      `Triage why ${entry.issue.identifier} needs Symphony recovery routing.`,
      "",
      "You are a scoped, read-only Symphony issue triage agent. Identify every blocker and recommend the next operator/system action.",
      "Do not edit files, create commits, push branches, transition Linear state, comment on Linear, create subissues, or submit worker/reviewer handoffs.",
      "",
      "Issue:",
      `- Identifier: ${entry.issue.identifier}`,
      `- Title: ${entry.issue.title}`,
      `- State: ${entry.issue.state}`,
      `- URL: ${entry.issue.url ?? "n/a"}`,
      `- Labels: ${formatList(entry.issue.labels)}`,
      `- Has children: ${entry.issue.hasChildren === true ? "yes" : "no"}`,
      `- Open blockers: ${formatList(entry.issue.blockedBy.filter((blocker) => blocker.state === null || !isStateIn(blocker.state, this.config.tracker.terminalStates)).map((blocker) => blocker.identifier ?? blocker.id ?? "unknown"))}`,
      "",
      "Blocked trigger:",
      `- Trigger fingerprint: ${triggerFingerprint}`,
      `- Lifecycle phase: ${lifecycle.phase}`,
      `- Blocked reason: ${lifecycle.blockedReason ?? "n/a"}`,
      `- Reviewer failures: ${lifecycle.reviewRound} / ${this.config.reviewLoop.failureLimits.reviewerFailures}`,
      `- Merge-gate failures: ${gate?.reviewRound ?? 0} / ${this.config.reviewLoop.failureLimits.mergeGateFailures}`,
      `- Incomplete worker turns: ${lifecycle.incompleteTurnCount} / ${this.config.reviewLoop.maxIncompleteTurns}`,
      "",
      "Deterministic blocker ledger:",
      ...issueTriageLedgerLines(lifecycle, report, verdict, gate),
      "",
      "Latest workspace/git evidence:",
      `- Workspace path: ${workspace?.path ?? lifecycle.summaryPointers.workspacePath ?? entry.workspacePath ?? "n/a"}`,
      `- Branch: ${workspace?.gitBranchName ?? lifecycle.summaryPointers.gitBranchName ?? lifecycle.summaryPointers.branchName ?? entry.issue.branchName ?? "n/a"}`,
      `- Repository path: ${workspace?.repoPath ?? lifecycle.summaryPointers.repoPath ?? "n/a"}`,
      `- Base ref: ${workspace?.baseRef ?? lifecycle.summaryPointers.baseRef ?? "n/a"}`,
      `- Pull request: ${formatPullRequest(lifecycle.summaryPointers.prNumber, lifecycle.summaryPointers.prUrl)}`,
      `- PR head SHA: ${lifecycle.summaryPointers.prHeadSha ?? "n/a"}`,
      `- CI status: ${lifecycle.summaryPointers.ciStatus ?? "n/a"}`,
      "",
      "Latest completion report:",
      ...(report
        ? [
            `- Report: ${report.id}; run: ${report.runId}`,
            `- Summary: ${report.summary}`,
            `- Changed files: ${formatList(report.changedFiles)}`,
            `- Validation: ${formatList(report.validationEvidence)}`,
            `- Risks: ${formatList(report.risks)}`,
          ]
        : ["- None"]),
      "",
      "Latest review verdict:",
      ...(verdict
        ? [
            `- Verdict: ${verdict.verdict}; record: ${verdict.id}; run: ${verdict.runId}`,
            `- Findings: ${formatList(verdict.findings)}`,
            `- Evidence: ${formatList(verdict.evidence)}`,
            "Acceptance results:",
            ...verdict.acceptanceResults.map(
              (item) =>
                `- ${item.satisfied ? "[x]" : "[ ]"} ${item.text}${item.evidence === null ? "" : ` (${item.evidence})`}`,
            ),
          ]
        : ["- None"]),
      "",
      "Merge gate:",
      ...(gate
        ? [
            `- Gate: ${gate.id}; status: ${gate.status}`,
            `- PR: ${formatPullRequest(gate.pullRequest.number, gate.pullRequest.url)}`,
            `- Head SHA: ${gate.headSha}`,
            `- Blocker fingerprint: ${gate.blockerFingerprint ?? "n/a"}`,
            `- Required checks: ${formatList(gate.requiredChecks)}`,
            `- Actionable checks: ${formatList(gate.checks.filter((check) => check.outcome === "failing" || check.outcome === "missing_actionable").map((check) => `${check.name}=${check.outcome}`))}`,
            `- Observing checks: ${formatList(gate.checks.filter((check) => check.outcome === "pending" || check.outcome === "missing_observed" || check.outcome === "unknown").map((check) => `${check.name}=${check.outcome}`))}`,
            `- Mergeability: ${gate.mergeability?.status ?? "n/a"} (${gate.mergeability?.reason ?? gate.mergeability?.mergeableState ?? "n/a"})`,
          ]
        : ["- None"]),
      "",
      "Blocker kinds:",
      ...ISSUE_TRIAGE_BLOCKER_KINDS.map((kind) => `- ${kind}`),
      "",
      "Blocker statuses:",
      ...ISSUE_TRIAGE_BLOCKER_STATUSES.map((status) => `- ${status}`),
      "",
      "Next actors:",
      ...ISSUE_TRIAGE_BLOCKER_NEXT_ACTORS.map((actor) => `- ${actor}`),
      "",
      "Blocker guidance:",
      "- Submit an exhaustive blockers array; do not choose a single most-specific disposition.",
      "- Use under_specified_needs_decomposition when hidden or under-specified scope should become smaller blocking child issues.",
      "- Prefer under_specified_needs_decomposition when review history shows repeated sibling-scenario or hidden-matrix discovery under the same broad requirement.",
      "- Use implementation_unsatisfied_requirements when the latest non-merge-gate review failure is active or worker behavior did not satisfy the issue contract.",
      "- A service-owned merge-gate verdict is not proof of unsatisfied implementation by itself. For current-head required-check failures, classify the concrete check, mergeability, conflict, infra, or operator blocker; mark implementation_unsatisfied_requirements active only when evidence shows worker-authored content caused the failure.",
      "- Use pr_review_gate only for review approval gates; mark it downstream when a higher-precedence active blocker still needs work.",
      "- Lower-precedence PR, CI, merge, or review-gate blockers must not mask active implementation, validation, decomposition, or orchestration-context blockers.",
      "- Use manual_decision when the evidence requires a product/owner decision before automation should continue.",
      "",
      this.issueTriageMcpPrompt(entry),
    ].join("\n");
  }

  private async renderIssueTriagePromptBundle(
    entry: RunningEntry,
  ): Promise<AgentPromptBundle> {
    const userPrompt = await this.renderIssueTriagePrompt(entry);
    return this.renderPromptBundle(
      entry,
      userPrompt,
      "triage.issue_blocked.classify",
      {
        issue: entry.issue,
        attempt: null,
        role: entry.role,
        lifecycle: entry.lifecycle,
      },
      { attempt: null, turnNumber: 1 },
    );
  }

  private async renderIssuePostMortemPrompt(
    entry: RunningEntry,
  ): Promise<string> {
    const lifecycle =
      (await this.options.lifecycleStore?.get(entry.issue.id)) ??
      entry.lifecycle;
    if (!lifecycle)
      throw new SymphonyError(
        "invalid_request",
        "Issue post-mortem prompt requires lifecycle evidence",
      );
    const workspace = entry.workspace;
    const report = latestCompletionReport(lifecycle);
    const verdict = latestReviewVerdict(lifecycle);
    const triggerFingerprint = issuePostMortemTriggerFingerprint(
      lifecycle,
      entry.issue,
    );
    if (
      this.config.prompts.templates["post_mortem.issue_done.analyze"] !==
      undefined
    ) {
      const basePrompt = await this.renderConfiguredPromptTemplate(
        "post_mortem.issue_done.analyze",
        "",
        {
          issue: entry.issue,
          attempt: null,
          role: entry.role,
          lifecycle,
          report,
          verdict,
          triggerFingerprint,
        },
      );
      return [basePrompt, this.issuePostMortemMcpPrompt(entry)].join("\n");
    }
    return [
      `Post-mortem ${entry.issue.identifier} after Done.`,
      "",
      "You are a scoped, read-only Symphony post-mortem agent. Perform an exhaustive outcome review, but do not reopen the issue or mutate any external state.",
      "Your output is a report for humans: judge whether Done was valid under the explicit issue contract, identify specification/process lessons, and propose follow-up candidates.",
      "",
      "Issue:",
      `- Identifier: ${entry.issue.identifier}`,
      `- Title: ${entry.issue.title}`,
      `- State: ${entry.issue.state}`,
      `- URL: ${entry.issue.url ?? "n/a"}`,
      `- Labels: ${formatList(entry.issue.labels)}`,
      `- Has children: ${entry.issue.hasChildren === true ? "yes" : "no"}`,
      "",
      "Post-mortem trigger:",
      `- Trigger fingerprint: ${triggerFingerprint}`,
      `- Lifecycle phase: ${lifecycle.phase}`,
      `- Review round: ${lifecycle.reviewRound}`,
      `- Incomplete worker turns: ${lifecycle.incompleteTurnCount}`,
      "",
      "Workspace/git evidence:",
      `- Workspace path: ${workspace?.path ?? lifecycle.summaryPointers.workspacePath ?? entry.workspacePath ?? "n/a"}`,
      `- Branch: ${workspace?.gitBranchName ?? lifecycle.summaryPointers.gitBranchName ?? lifecycle.summaryPointers.branchName ?? entry.issue.branchName ?? "n/a"}`,
      `- Repository path: ${workspace?.repoPath ?? lifecycle.summaryPointers.repoPath ?? "n/a"}`,
      `- Base ref: ${workspace?.baseRef ?? lifecycle.summaryPointers.baseRef ?? "n/a"}`,
      `- Pull request: ${formatPullRequest(lifecycle.summaryPointers.prNumber, lifecycle.summaryPointers.prUrl)}`,
      `- PR head SHA: ${lifecycle.summaryPointers.prHeadSha ?? "n/a"}`,
      `- CI status: ${lifecycle.summaryPointers.ciStatus ?? "n/a"}`,
      "",
      "Latest completion report:",
      ...(report
        ? [
            `- Report: ${report.id}; run: ${report.runId}`,
            `- Summary: ${report.summary}`,
            `- Changed files: ${formatList(report.changedFiles)}`,
            `- Validation: ${formatList(report.validationEvidence)}`,
            `- Risks: ${formatList(report.risks)}`,
            "Acceptance checklist:",
            ...report.acceptanceChecklist.map(
              (item) =>
                `- ${item.satisfied ? "[x]" : "[ ]"} ${item.text}${item.evidence === null ? "" : ` (${item.evidence})`}`,
            ),
          ]
        : ["- None"]),
      "",
      "Latest review verdict:",
      ...(verdict
        ? [
            `- Verdict: ${verdict.verdict}; record: ${verdict.id}; run: ${verdict.runId}`,
            `- Findings: ${formatList(verdict.findings)}`,
            `- Evidence: ${formatList(verdict.evidence)}`,
            "Gate findings:",
            ...formatDirectiveGateFindings(verdict),
            "Discovery findings:",
            ...formatDirectiveDiscoveryFindings(verdict),
            "Acceptance results:",
            ...verdict.acceptanceResults.map(
              (item) =>
                `- ${item.satisfied ? "[x]" : "[ ]"} ${item.text}${item.evidence === null ? "" : ` (${item.evidence})`}`,
            ),
          ]
        : ["- None"]),
      "",
      "Review history signals:",
      ...reviewScopeDiscoveryLedgerLines(lifecycle),
      "",
      "Assessment standard:",
      "- completionJudgment.status=valid_done only when Done appears correct and no material follow-up is worth tracking.",
      "- completionJudgment.status=valid_with_followups when Done appears valid under the explicit contract but hardening, tests, decomposition, or process follow-up should be tracked.",
      "- completionJudgment.status=questionable_done only when there is a likely contract-entitled defect that should have blocked Done.",
      "- missedGateFindings are only for explicit-contract defects or necessary core behavior failures that should have blocked final approval.",
      "- missedDiscoveryFindings and followUpCandidates are for non-gating hardening, hidden scope, weak specification, matrix gaps, sibling scope, or future work.",
      "- Use speckitRecommended when follow-up work should go through specify, plan, tasks, and analyze before implementation.",
      "",
      this.issuePostMortemMcpPrompt(entry),
    ].join("\n");
  }

  private async renderIssuePostMortemPromptBundle(
    entry: RunningEntry,
  ): Promise<AgentPromptBundle> {
    const userPrompt = await this.renderIssuePostMortemPrompt(entry);
    return this.renderPromptBundle(
      entry,
      userPrompt,
      "post_mortem.issue_done.analyze",
      {
        issue: entry.issue,
        attempt: null,
        role: entry.role,
        lifecycle: entry.lifecycle,
      },
      { attempt: null, turnNumber: 1 },
    );
  }

  private async renderMergeConflictResolutionPrompt(
    entry: RunningEntry,
  ): Promise<string> {
    const lifecycle = await this.options.lifecycleStore?.get(entry.issue.id);
    const conflict = lifecycle?.mergeConflict ?? null;
    const workspace = entry.workspace;
    if (
      this.config.prompts.templates["worker.merge_conflict.resolve"] !==
      undefined
    ) {
      const basePrompt = await this.renderConfiguredPromptTemplate(
        "worker.merge_conflict.resolve",
        "",
        {
          issue: entry.issue,
          attempt: null,
          role: entry.role,
          lifecycle,
          conflict,
          workspace,
        },
      );
      return [
        basePrompt,
        "",
        "Conflict metadata:",
        `- Pull request: ${formatPullRequest(conflict?.pullRequest.number ?? null, conflict?.pullRequest.url ?? null)}`,
        `- Approved head SHA: ${conflict?.approvedHeadSha ?? "n/a"}`,
        `- Current conflict head SHA: ${conflict?.currentHeadSha ?? "n/a"}`,
        `- Base branch: ${conflict?.baseBranch ?? "n/a"}`,
        `- Base head SHA: ${conflict?.baseHeadSha ?? "n/a"}`,
        ...formatMergeConflictServicePreparationPrompt(conflict),
        `- Attempts: ${conflict?.fixTurnCount ?? 0} / ${conflict?.maxFixTurns ?? this.config.mergePolicy.maxConflictFixTurns}`,
        `- Reason: ${conflict?.reason ?? "n/a"}`,
        `- GitHub mergeable_state: ${conflict?.mergeableState ?? "unknown"}`,
        this.mergeConflictResolutionMcpPrompt(entry),
      ].join("\n");
    }
    return [
      `Resolve merge conflicts for ${entry.issue.identifier}: ${entry.issue.title}`,
      "",
      "You are a scoped Symphony conflict-fix worker. Only resolve the merge conflict on the existing lifecycle-bound pull request.",
      "Do not perform unrelated implementation work, request review, move Linear state, or call submit_completion_report.",
      "",
      "Conflict metadata:",
      `- Pull request: ${formatPullRequest(conflict?.pullRequest.number ?? null, conflict?.pullRequest.url ?? null)}`,
      `- Approved head SHA: ${conflict?.approvedHeadSha ?? "n/a"}`,
      `- Current conflict head SHA: ${conflict?.currentHeadSha ?? "n/a"}`,
      `- Base branch: ${conflict?.baseBranch ?? "n/a"}`,
      `- Base head SHA: ${conflict?.baseHeadSha ?? "n/a"}`,
      ...formatMergeConflictServicePreparationPrompt(conflict),
      `- Attempts: ${conflict?.fixTurnCount ?? 0} / ${conflict?.maxFixTurns ?? this.config.mergePolicy.maxConflictFixTurns}`,
      `- Reason: ${conflict?.reason ?? "n/a"}`,
      `- GitHub mergeable_state: ${conflict?.mergeableState ?? "unknown"}`,
      "- Git operations are service-owned for this phase. Do not fetch, pull, merge, rebase, commit, push, or continue/abort/skip a rebase.",
      "- Required handoff: call submit_merge_conflict_resolution before ending the run.",
      '- Report resolutionStatus="resolved", resolutionStatus="still_conflicted", or resolutionStatus="blocked"; include previousHeadSha, baseBranch, and baseHeadSha. Omit newHeadSha for service-prepared conflicts.',
      "",
      "Workspace:",
      `- Path: ${workspace?.path ?? entry.workspacePath ?? "n/a"}`,
      `- Branch: ${workspace?.gitBranchName ?? entry.issue.branchName ?? "n/a"}`,
      `- Base ref: ${workspace?.baseRef ?? "n/a"}`,
      this.mergeConflictResolutionMcpPrompt(entry),
    ].join("\n");
  }

  private issueBreakdownMcpPrompt(entry: RunningEntry): string {
    this.requireMcpHandoff("issue_breakdown");
    return renderIssueBreakdownMcpHandoffPrompt({
      issue: entry.issue,
      role: entry.role,
    });
  }

  private issueTriageMcpPrompt(entry: RunningEntry): string {
    this.requireMcpHandoff("issue_triage");
    const workspace = entry.workspace;
    return renderIssueTriageMcpHandoffPrompt({
      issue: entry.issue,
      role: entry.role,
      workspacePath: workspace?.path ?? entry.workspacePath,
      branchName: workspace?.gitBranchName ?? entry.issue.branchName ?? null,
      repoPath: workspace?.repoPath ?? null,
      baseRef: workspace?.baseRef ?? null,
    });
  }

  private issuePostMortemMcpPrompt(entry: RunningEntry): string {
    this.requireMcpHandoff("post_mortem");
    const workspace = entry.workspace;
    return renderIssuePostMortemMcpHandoffPrompt({
      issue: entry.issue,
      role: entry.role,
      workspacePath: workspace?.path ?? entry.workspacePath,
      branchName: workspace?.gitBranchName ?? entry.issue.branchName ?? null,
      repoPath: workspace?.repoPath ?? null,
      baseRef: workspace?.baseRef ?? null,
    });
  }

  private async renderWorkerContinuationPrompt(
    entry: RunningEntry,
  ): Promise<string> {
    const continuationBrief = await this.renderContinuationBrief(entry);
    const reviewHardening = this.workerReviewHardeningPrompt();
    const reviewEvidence = await this.loadWorkerReviewEvidencePrompt(entry);
    const handoff = await this.loadWorkerHandoffPrompt(entry);
    const mergeGateResult = await this.loadWorkerMergeGatePromptResult(entry);
    const mergeGate = mergeGateResult?.text ?? null;
    const reviewVerdict =
      mergeGateResult?.kind === "repair"
        ? null
        : await this.loadWorkerReviewVerdictPrompt(entry);
    return formatUserPromptPacket(
      "Symphony Worker Continuation Evidence Packet",
      [
        ["Continuation Brief", continuationBrief],
        ["Review Loop Hardening", reviewHardening],
        ["Compact Handoff", handoff],
        ["Merge Gate Evidence", mergeGate],
        ["Reviewer Verdict Evidence", reviewVerdict],
        ["Pull Request Review Evidence", reviewEvidence],
        ["MCP Handoff Instructions", this.workerMcpPrompt(entry)],
      ],
    );
  }

  private async renderWorkerContinuationPromptBundle(
    entry: RunningEntry,
    attempt: number | null,
    turnNumber: number,
  ): Promise<AgentPromptBundle> {
    const userPrompt = await this.renderWorkerContinuationPrompt(entry);
    return this.renderPromptBundle(
      entry,
      userPrompt,
      "worker.implementation.continuation",
      {
        issue: entry.issue,
        attempt,
        role: entry.role,
        lifecycle: entry.lifecycle,
      },
      { attempt, turnNumber },
    );
  }

  private workerReviewHardeningPrompt(): string {
    return [
      "",
      DEFAULT_WORKER_INVARIANT_REPAIR_GUIDANCE,
      formatPromptExtensions(
        "Project-specific worker extensions:",
        this.config.reviewLoop.workerPromptExtensions,
      ),
    ]
      .filter((item): item is string => item !== null)
      .join("\n");
  }

  private async renderContinuationBrief(entry: RunningEntry): Promise<string> {
    const lifecycle =
      entry.lifecycle ??
      (await this.options.lifecycleStore?.get(entry.issue.id)) ??
      null;
    const runs =
      (await this.options.runStore?.listRunsForIssue(entry.issue.id)) ?? [];
    const history = await this.loadContinuationHistory(runs);
    const threshold = this.config.reviewLoop.transcriptHistoryLimit;
    const historyMode = "summary";
    const summaryReference = latestContinuationSummaryReference(lifecycle);
    const workspace = entry.workspace;
    const pointers = lifecycle?.summaryPointers;
    const latestRun = runs[runs.length - 1] ?? null;
    const transcriptPointers = transcriptPointersForRuns(runs);
    const statusApiPointers = statusApiPointersForIssue(
      entry.issue.identifier,
      runs,
    );

    return [
      "Structured continuation brief:",
      "",
      "Objective:",
      `- Continue implementation for ${entry.issue.identifier}: ${entry.issue.title}`,
      "- Reuse the history below before rediscovering prior context.",
      "",
      "Lifecycle counters:",
      `- Phase: ${lifecycle?.phase ?? phaseForIssueState(entry.issue.state, this.config)}`,
      `- Reviewer failures: ${lifecycle?.reviewRound ?? 0} / ${this.config.reviewLoop.failureLimits.reviewerFailures}`,
      `- Incomplete worker turns: ${lifecycle?.incompleteTurnCount ?? 0} / ${this.config.reviewLoop.maxIncompleteTurns}`,
      `- Last completion report: ${lifecycle?.lastCompletionReportId ?? "n/a"}`,
      `- Last review verdict: ${lifecycle?.lastReviewVerdictId ?? "n/a"}`,
      "",
      "Latest workspace/git evidence:",
      `- Workspace path: ${workspace?.path ?? pointers?.workspacePath ?? latestRun?.workspacePath ?? entry.workspacePath ?? "n/a"}`,
      `- Workspace key: ${workspace?.workspaceKey ?? pointers?.workspaceKey ?? latestRun?.workspaceKey ?? "n/a"}`,
      `- Branch: ${workspace?.gitBranchName ?? pointers?.gitBranchName ?? pointers?.branchName ?? latestRun?.gitBranchName ?? entry.issue.branchName ?? "n/a"}`,
      `- Repository path: ${workspace?.repoPath ?? pointers?.repoPath ?? latestRun?.repoPath ?? "n/a"}`,
      `- Base ref: ${workspace?.baseRef ?? pointers?.baseRef ?? latestRun?.baseRef ?? "n/a"}`,
      `- Pull request: ${formatPullRequest(pointers?.prNumber ?? latestRun?.prNumber ?? null, pointers?.prUrl ?? latestRun?.prUrl ?? null)}`,
      `- PR head SHA: ${pointers?.prHeadSha ?? latestRun?.prHeadSha ?? "n/a"}`,
      `- Last pushed at: ${pointers?.lastPushedAt ?? latestRun?.lastPushedAt ?? "n/a"}`,
      `- CI status: ${pointers?.ciStatus ?? latestRun?.ciStatus ?? "n/a"}`,
      "",
      "History selection:",
      `- Mode: ${historyMode}`,
      `- Transcript events considered: ${history.eventCount}`,
      `- Configured full-history threshold: ${threshold}`,
      "",
      "Stored continuation summary:",
      `- Reference: ${summaryReference?.id ?? "n/a"}`,
      `- Created at: ${summaryReference?.createdAt ?? "n/a"}`,
      `- Summary: ${summaryReference?.summary ?? "No stored continuation history summary is available yet."}`,
      "",
      "Transcript/status pointers:",
      ...formatPointerList(
        summaryReference?.transcriptPointers ?? transcriptPointers,
      ),
      ...formatPointerList(
        summaryReference?.statusApiPointers ?? statusApiPointers,
      ),
    ].join("\n");
  }

  private async loadContinuationHistory(runs: RunRecord[]): Promise<{
    eventCount: number;
    runs: Array<{
      run: RunRecord;
      events: TranscriptEvent[];
      truncated: boolean;
    }>;
  }> {
    const threshold = this.config.reviewLoop.transcriptHistoryLimit;
    let eventCount = 0;
    const history: Array<{
      run: RunRecord;
      events: TranscriptEvent[];
      truncated: boolean;
    }> = [];
    for (const run of runs) {
      if (!this.options.runStore) break;
      const page = await this.options.runStore.readTranscript(run.runId, {
        limit: threshold + 1,
      });
      const truncated = page.nextOffset !== null;
      const events = promptRelevantTranscriptEvents(page.events);
      eventCount += events.length + (truncated ? 1 : 0);
      history.push({ run, events, truncated });
    }
    return { eventCount, runs: history };
  }

  private workerMcpPrompt(entry: RunningEntry): string | null {
    if (entry.runPhase !== "implementation") return null;
    this.requireMcpHandoff("implementation");
    const workspace = entry.workspace;
    return renderCompletionMcpHandoffPrompt({
      issue: entry.issue,
      role: entry.role,
      workspacePath: workspace?.path ?? entry.workspacePath,
      branchName: workspace?.gitBranchName ?? entry.issue.branchName ?? null,
      repoPath: workspace?.repoPath ?? null,
      baseRef: workspace?.baseRef ?? null,
    });
  }

  private mergeConflictResolutionMcpPrompt(entry: RunningEntry): string | null {
    if (entry.runPhase !== "merge_conflict_resolution") return null;
    this.requireMcpHandoff("merge_conflict_resolution");
    const workspace = entry.workspace;
    return renderMergeConflictResolutionMcpHandoffPrompt({
      issue: entry.issue,
      workspacePath: workspace?.path ?? entry.workspacePath,
      branchName: workspace?.gitBranchName ?? entry.issue.branchName ?? null,
      repoPath: workspace?.repoPath ?? null,
      baseRef: workspace?.baseRef ?? null,
    });
  }

  private requireMcpHandoff(runPhase: AgentRunPhase): void {
    if (harnessSupportsMcpHandoff(this.options.harness)) return;
    throw new SymphonyError(
      "config_validation_error",
      `Runtime harness ${this.options.harness.id} does not support Symphony MCP handoff required for ${runPhase}`,
    );
  }

  private async loadWorkerReviewVerdictPrompt(
    entry: RunningEntry,
  ): Promise<string | null> {
    const lifecycle = await this.loadWorkerCurrentPromptLifecycle(entry);
    return lifecycle === null
      ? null
      : formatWorkerReviewVerdictPrompt(lifecycle);
  }

  private async loadWorkerMergeGatePromptResult(
    entry: RunningEntry,
  ): Promise<WorkerMergeGatePromptResult | null> {
    const lifecycle = await this.loadWorkerCurrentPromptLifecycle(entry);
    if (lifecycle === null) return null;
    return formatWorkerMergeGatePromptResult(lifecycle);
  }

  private async loadWorkerCurrentPromptLifecycle(
    entry: RunningEntry,
  ): Promise<IssueLifecycleRecord | null> {
    const lifecycle = await this.options.lifecycleStore?.get(entry.issue.id);
    if (lifecycle === undefined || lifecycle === null) return null;
    return currentPromptLifecycle(lifecycle);
  }

  private async loadIssueBreakdownPlanPrompt(
    entry: RunningEntry,
  ): Promise<string | null> {
    if (!this.config.issueBreakdown.enabled) return null;
    const lifecycle = await this.options.lifecycleStore?.get(entry.issue.id);
    const plan = latestFreshIssueBreakdownPlan(
      lifecycle,
      entry.issue,
      this.config,
    );
    if (plan === null) return null;
    return [
      "",
      "Issue breakdown plan:",
      `- Source: ${plan.id}; accepted at ${plan.acceptedAt}`,
      `- Runtime mode: ${plan.cursorMode ?? this.config.issueBreakdown.cursorMode}`,
      `- Transcript pointers: ${formatList(plan.transcriptPointers)}`,
      `- Status pointers: ${formatList(plan.statusApiPointers)}`,
      "",
      renderIssueBreakdownPlanSummary(plan),
    ].join("\n");
  }

  private async loadWorkerHandoffPrompt(
    entry: RunningEntry,
  ): Promise<string | null> {
    const lifecycle =
      (await this.options.lifecycleStore?.get(entry.issue.id)) ??
      entry.lifecycle ??
      null;
    const runs =
      (await this.options.runStore?.listRunsForIssue(entry.issue.id)) ?? [];
    if (!lifecycle || !hasRealHandoffContext(lifecycle, runs)) return null;
    const currentLifecycle = currentPromptLifecycle(lifecycle);
    const packet = buildWorkerHandoffPacket(currentLifecycle);
    const transcriptPointers = transcriptPointersForRuns(runs);
    const statusPointers = statusApiPointersForIssue(
      entry.issue.identifier,
      runs,
    );
    const activeReviewEvidence = lifecycle.reviewEvidence.items.filter(
      isActiveReviewEvidenceItem,
    );
    return [
      "",
      "Compact Symphony handoff packet:",
      `- Version: ${packet.version}; generatedAt: ${packet.generatedAt}`,
      `- Issue: ${packet.issueIdentifier} (${packet.issueId})`,
      `- Objective: ${entry.issue.title}`,
      `- Next action: ${nextWorkerAction(currentLifecycle)}`,
      "",
      "Lane memo:",
      ...packet.memo.entries.map((entryLine) => `- ${entryLine}`),
      "",
      "Open reviewer findings:",
      ...(packet.memo.openFindings.length === 0
        ? ["- None"]
        : packet.memo.openFindings.map((finding) => `- ${finding}`)),
      "",
      "Latest worker output:",
      ...(packet.lastWorkerOutput === null
        ? ["- None"]
        : [
            `- Report: ${packet.lastWorkerOutput.reportId}; run: ${packet.lastWorkerOutput.runId}`,
            `- Summary: ${packet.lastWorkerOutput.summary}`,
            `- Changed files: ${formatList(packet.lastWorkerOutput.changedFiles)}`,
            `- Validation: ${formatList(packet.lastWorkerOutput.validationEvidence)}`,
            `- Risks: ${formatList(packet.lastWorkerOutput.risks)}`,
          ]),
      "",
      "Latest rejected completion report:",
      ...formatCompletionReportRejectionForPrompt(
        packet.lastCompletionReportRejection,
      ),
      "",
      "Latest reviewer output:",
      ...(packet.lastReviewerOutput === null
        ? ["- None"]
        : [
            `- Verdict: ${packet.lastReviewerOutput.verdict}; record: ${packet.lastReviewerOutput.verdictId}; run: ${packet.lastReviewerOutput.runId}`,
            `- Findings: ${formatList(packet.lastReviewerOutput.findings)}`,
            `- Evidence: ${formatList(packet.lastReviewerOutput.evidence)}`,
          ]),
      "",
      "Latest blocked reviewer verdict:",
      ...formatBlockedReviewerVerdictForPrompt(packet.lastReviewerOutput),
      "",
      "Stable pointers:",
      `- Workspace: ${packet.pointers.workspacePath ?? "n/a"}`,
      `- Branch: ${packet.pointers.gitBranchName ?? packet.pointers.branchName ?? "n/a"}`,
      `- Pull request: ${formatPullRequest(packet.pointers.prNumber, packet.pointers.prUrl)}`,
      `- PR head SHA: ${packet.pointers.prHeadSha ?? "n/a"}`,
      "",
      "Active unresolved PR review evidence:",
      ...(activeReviewEvidence.length === 0
        ? ["- None"]
        : activeReviewEvidence
            .slice(0, this.config.reviewLoop.prReviewEvidenceLimit)
            .map(
              (item) =>
                `- ${item.source} ${item.path ?? "PR"}: ${oneLine(item.body).slice(0, 240)} (${item.url ?? item.pullRequestUrl ?? "n/a"})`,
            )),
      "",
      "Transcript/status pointers:",
      ...formatPointerList(transcriptPointers),
      ...formatPointerList(statusPointers),
    ].join("\n");
  }

  private async loadWorkerReviewEvidencePrompt(
    entry: RunningEntry,
  ): Promise<string | null> {
    if (!this.options.lifecycleStore) return null;
    try {
      const client =
        this.options.pullRequestReviewClient ??
        createGitHubPullRequestClientForCapability(
          this.config,
          "github.review_evidence_read",
        );
      const service = new PullRequestReviewEvidenceService({
        lifecycleStore: this.options.lifecycleStore,
        client,
        fullHistoryThreshold: this.config.reviewLoop.prReviewEvidenceLimit,
      });
      const context = await service.prepareWorkerPromptContext(entry.issue);
      return context === null
        ? null
        : formatWorkerReviewEvidencePrompt(context);
    } catch (error) {
      this.options.logger.warn(
        "pull request review evidence ingestion failed",
        {
          issue_id: entry.issue.id,
          issue_identifier: entry.issue.identifier,
          error: errorMessage(error),
        },
      );
      return null;
    }
  }

  private availableSlots(): number {
    return Math.max(
      this.config.agent.maxConcurrentAgents - this.running.size,
      0,
    );
  }

  private hasStateSlot(state: string): boolean {
    const stateLimit = this.config.agent.maxConcurrentAgentsByState.get(
      state.toLowerCase(),
    );
    if (!stateLimit) return true;
    const runningInState = [...this.running.values()].filter(
      (entry) => entry.issue.state.toLowerCase() === state.toLowerCase(),
    ).length;
    return runningInState < stateLimit;
  }

  private activeRuntimeSeconds(now: number): number {
    return [...this.running.values()].reduce(
      (sum, entry) => sum + (now - entry.startedAt.getTime()) / 1000,
      0,
    );
  }

  private markCancellationRequested(
    entry: RunningEntry,
    input: {
      source: RunCancellationSource;
      reason: string;
      abortSignalled?: boolean;
      harnessStopRequested?: boolean;
    },
    now = new Date(),
  ): void {
    if (!entry.cancellationRequestedAt) {
      entry.cancellationRequestedAt = now;
      entry.cancellationSource = input.source;
      entry.cancellationReason = input.reason;
    }
    if (input.abortSignalled) {
      entry.abortSignalledAt = entry.abortSignalledAt ?? now;
    }
    if (input.harnessStopRequested) {
      entry.harnessStopRequestedAt = entry.harnessStopRequestedAt ?? now;
    }
  }

  private livenessForEntry(entry: RunningEntry, now: number): RunLivenessState {
    const idleAlertThresholdMs = this.stallTimeoutMs();
    const lastActivityAt = entry.lastEventAt ?? entry.startedAt;
    const idleMs = Math.max(now - lastActivityAt.getTime(), 0);
    const idleAlertSuppressed =
      entry.cancellationRequestedAt !== null ||
      isLifecycleHumanBlocked(entry.lifecycle);
    const status: RunLivenessStatus =
      entry.cancellationRequestedAt !== null
        ? "cancelling"
        : entry.runId === null
          ? "starting"
          : entry.sdkRunStatus !== null &&
              isTerminalSdkRunStatus(entry.sdkRunStatus)
            ? "terminal_pending"
            : "active";
    return {
      status,
      activeRunId: entry.activeRunId,
      lastActivityAt: lastActivityAt.toISOString(),
      secondsSinceLastActivity: idleMs / 1000,
      stallTimeoutMs: idleAlertThresholdMs,
      sdkRunStatus: entry.sdkRunStatus,
      sdkRunStatusUpdatedAt: entry.sdkRunStatusUpdatedAt?.toISOString() ?? null,
      sdkRunStatusSource: entry.sdkRunStatusSource,
      idleAlert: {
        active:
          !idleAlertSuppressed &&
          idleAlertThresholdMs !== null &&
          idleMs > idleAlertThresholdMs,
        thresholdMs: idleAlertThresholdMs,
        lastActivityAt: lastActivityAt.toISOString(),
        secondsSinceLastActivity: idleMs / 1000,
        reason: idleAlertSuppressed ? "suppressed" : "observe_only",
      },
    };
  }

  private stallTimeoutMs(): number | null {
    const codexConfig = this.config.raw as {
      codex?: { stall_timeout_ms?: unknown };
    };
    const stallTimeout = codexConfig.codex?.stall_timeout_ms ?? 300_000;
    return typeof stallTimeout === "number" && stallTimeout > 0
      ? stallTimeout
      : null;
  }

  private harnessStopRunId(entry: RunningEntry): string | null {
    if (typeof this.options.harness.stop !== "function") return null;
    if (entry.harnessStopRequestedAt !== null) return null;
    return entry.activeRunId ?? entry.runId;
  }

  private async requestHarnessStop(
    entry: RunningEntry,
    runId: string,
  ): Promise<void> {
    try {
      await this.options.harness.stop?.(runId);
    } catch (error) {
      const at = new Date();
      entry.harnessStopFailedAt = entry.harnessStopFailedAt ?? at;
      entry.harnessStopFailedReason =
        entry.harnessStopFailedReason ?? errorMessage(error);
      this.options.logger.warn("harness stop failed", {
        issue_id: entry.issue.id,
        issue_identifier: entry.issue.identifier,
        run_id: runId,
        source: entry.cancellationSource,
        error: errorMessage(error),
      });
    }
  }
}

export function sortIssuesForDispatch(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => {
    const priorityA = a.priority ?? Number.POSITIVE_INFINITY;
    const priorityB = b.priority ?? Number.POSITIVE_INFINITY;
    if (priorityA !== priorityB) return priorityA - priorityB;
    const createdA = a.createdAt
      ? Date.parse(a.createdAt)
      : Number.POSITIVE_INFINITY;
    const createdB = b.createdAt
      ? Date.parse(b.createdAt)
      : Number.POSITIVE_INFINITY;
    if (createdA !== createdB) return createdA - createdB;
    return a.identifier.localeCompare(b.identifier);
  });
}

function mergeQueueProjectionForIssue(
  issue: Pick<Issue, "id">,
  snapshot: MergeQueueSnapshot,
): Pick<
  IssueCurrentStateSnapshot,
  | "mergeQueueActiveIssueId"
  | "mergeQueueActiveIssueIdentifier"
  | "mergeQueueLeaseId"
  | "mergeQueueStatus"
> {
  return {
    mergeQueueActiveIssueId: snapshot.activeIssueId,
    mergeQueueActiveIssueIdentifier: snapshot.activeIssueIdentifier,
    mergeQueueLeaseId: snapshot.leaseId,
    mergeQueueStatus:
      snapshot.activeIssueId === null
        ? "inactive"
        : snapshot.activeIssueId === issue.id
          ? "active_current_issue"
          : "active_other_issue",
  };
}

function hasRestorablePreservedWorktreeStashes(
  snapshot: IssueCurrentStateSnapshot,
): boolean {
  return snapshot.activePreservedWorktreeStashes.some(
    (stash) =>
      stash.status === "created" ||
      stash.status === "applied_clean" ||
      stash.status === "finalized" ||
      stash.status === "drop_failed",
  );
}

const BASE_REF_GUARDED_TRANSITION_KINDS = new Set<IssueTransitionKind>([
  "dispatch_worker",
  "dispatch_reviewer",
  "reconcile_completion_report_handoff",
  "reconcile_merge_conflict_resolution_handoff",
  "recover_publication_approval",
  "merge_policy_refresh_conflict_base",
  "merge_policy_prepare_conflict",
  "merge_policy_dispatch_repair",
  "merge_policy_merge_pull_request",
]);

function issueTransitionRulesetPriority(kind: IssueTransitionKind): number {
  switch (kind) {
    case "base_ref_observe":
      return 45;
    case "base_ref_repair":
      return 46;
    case "base_ref_block":
      return 47;
    case "terminate_running":
      return 10;
    case "recover_publication_approval":
      return 20;
    case "handoff_repair":
      return 30;
    case "retry_run":
      return 34;
    case "reset_merge_conflict_after_operator_resume":
      return 35;
    case "block_merge_conflict_attempt_limit":
      return 36;
    case "reset_lifecycle_after_operator_resume":
      return 37;
    case "recover_merge_gate_head_supersession":
      return 38;
    case "rebound_issue_triage_blocked":
      return 39;
    case "preserved_stash_restore":
      return 39.5;
    case "dispatch_worker":
    case "dispatch_planner":
    case "dispatch_reviewer":
    case "dispatch_triage":
    case "dispatch_post_mortem":
      return 100;
    case "merge_queue_claim":
      return 180;
    case "merge_policy":
      return 200;
    case "merge_policy_reset_operator_resume":
      return 181;
    case "merge_policy_write_done_state":
      return 182;
    case "merge_policy_wait_conflict_state":
      return 183;
    case "merge_policy_observe":
      return 184;
    case "merge_policy_retire_stale_gate":
      return 185;
    case "merge_policy_mark_head_superseded":
      return 186;
    case "merge_policy_refresh_conflict_base":
      return 187;
    case "merge_policy_wait_active_blocked_gate":
      return 188;
    case "merge_policy_wait_repair_clearance":
      return 189;
    case "merge_policy_refresh_same_gate_blocker":
      return 190;
    case "merge_policy_observe_checks_pending":
      return 191;
    case "merge_policy_auto_resolve_gate":
      return 192;
    case "merge_policy_prepare_conflict":
      return 193;
    case "merge_policy_dispatch_repair":
      return 194;
    case "merge_policy_block_failure":
      return 195;
    case "merge_policy_merge_pull_request":
      return 196;
    case "merge_policy_recover_already_merged_pull_request":
      return 197;
    case "reconcile_issue_triage_report_writeback":
      return 251;
    case "reconcile_post_mortem_report_writeback":
      return 252;
    case "reconcile_completion_report_handoff":
      return 253;
    case "reconcile_completion_report_rejection":
      return 254;
    case "reconcile_merge_conflict_resolution_handoff":
      return 255;
    case "reconcile_issue_breakdown_plan_handoff":
      return 256;
    case "reconcile_issue_triage_report_handoff":
      return 257;
    case "reconcile_issue_post_mortem_handoff":
      return 258;
    case "reconcile_review_verdict_handoff":
      return 259;
    case "block_issue":
      return 300;
    case "record_evidence":
      return 900;
    case "noop":
      return 1_000;
  }
}

function handoffReconciliationTransitionKind(
  kind: AgentHandoffRepairKind,
): IssueTransitionKind {
  switch (kind) {
    case "completion_report":
      return "reconcile_completion_report_handoff";
    case "review_verdict":
      return "reconcile_review_verdict_handoff";
    case "issue_breakdown_plan":
      return "reconcile_issue_breakdown_plan_handoff";
    case "issue_triage_report":
      return "reconcile_issue_triage_report_handoff";
    case "issue_post_mortem_report":
      return "reconcile_issue_post_mortem_handoff";
    case "merge_conflict_resolution":
      return "reconcile_merge_conflict_resolution_handoff";
  }
}

function normalizeTransitionActionExecutionResult(result: unknown): {
  status: "succeeded" | "skipped";
  message: string | null;
  details: unknown;
  stop: boolean;
} {
  if (result === false)
    return { status: "skipped", message: null, details: null, stop: true };
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const record = result as {
      status?: unknown;
      message?: unknown;
      details?: unknown;
      stop?: unknown;
    };
    return {
      status: record.status === "skipped" ? "skipped" : "succeeded",
      message: typeof record.message === "string" ? record.message : null,
      details: record.details ?? null,
      stop: record.stop === true,
    };
  }
  return { status: "succeeded", message: null, details: null, stop: false };
}

function transitionErrorTypeFor(error: unknown): "runtime" | "domain" {
  if (error instanceof SymphonyError) {
    return error.code === "agent_error" ||
      error.code === "workspace_error" ||
      error.code === "hook_error"
      ? "runtime"
      : "domain";
  }
  return "runtime";
}

function mergePolicyTransitionShouldContinue(
  kind: IssueTransitionKind,
): boolean {
  return (
    kind === "merge_queue_claim" ||
    kind === "merge_policy_reset_operator_resume" ||
    kind === "merge_policy_observe" ||
    kind === "merge_policy_retire_stale_gate" ||
    kind === "merge_policy_auto_resolve_gate"
  );
}

function baseRefTransitionShouldContinue(kind: IssueTransitionKind): boolean {
  return kind === "base_ref_observe";
}

function baseRefObservationCanRepairByRebase(
  observation: IssueBaseRefObservation,
): boolean {
  return observation.classification === "branch_not_based_on_live_base";
}

function tickTransitionShouldContinue(kind: IssueTransitionKind): boolean {
  return kind === "reset_merge_conflict_after_operator_resume";
}

function dispatchTransitionKindForRole(
  role: AgentRunRole,
): IssueTransitionKind {
  switch (role) {
    case "planner":
      return "dispatch_planner";
    case "reviewer":
      return "dispatch_reviewer";
    case "triage":
      return "dispatch_triage";
    case "post_mortem":
      return "dispatch_post_mortem";
    case "worker":
      return "dispatch_worker";
  }
}

function promptScenarioForDispatch(
  role: AgentRunRole,
  runPhase: AgentRunPhase,
  manualDispatch: boolean,
): string {
  const prefix = manualDispatch ? "manual" : "orchestrator";
  if (role === "worker" && runPhase === "merge_conflict_resolution")
    return `${prefix}.worker.merge_conflict_resolution`;
  if (role === "worker") return `${prefix}.worker.implementation`;
  if (role === "planner") return `${prefix}.planner.issue_breakdown`;
  if (role === "reviewer") return `${prefix}.reviewer.review`;
  if (role === "triage") return `${prefix}.triage.issue_triage`;
  return `${prefix}.post_mortem`;
}

function dispatchTransitionRequest(input: {
  role: AgentRunRole;
  runPhase: AgentRunPhase;
  reason: string;
  promptScenario: string;
  manualDispatch?: boolean;
}): IssueTransitionRequest {
  const runKind = runKindForPhase(input.runPhase);
  return {
    transitionKind: dispatchTransitionKindForRole(input.role),
    reason: input.reason,
    role: input.role,
    runPhase: input.runPhase,
    runKind,
    promptScenario: input.promptScenario,
    manualDispatch: input.manualDispatch === true,
  };
}

function baseRefTargetRequestFromTransition(
  transition: IssueHistorySnapshot,
): IssueTransitionRequest | null {
  const value = transition.baseRefTargetRequest;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const request = value as Partial<IssueTransitionRequest>;
    if (
      typeof request.transitionKind === "string" &&
      BASE_REF_GUARDED_TRANSITION_KINDS.has(
        request.transitionKind as IssueTransitionKind,
      )
    ) {
      return request as IssueTransitionRequest;
    }
  }
  const targetKind = transition.baseRefTargetTransitionKind;
  if (
    typeof targetKind === "string" &&
    BASE_REF_GUARDED_TRANSITION_KINDS.has(targetKind as IssueTransitionKind)
  ) {
    return { transitionKind: targetKind as IssueTransitionKind };
  }
  return null;
}

function isManualAgentRunStage(
  value: string | null,
): value is ManualAgentRunStage {
  return (
    value === "worker" ||
    value === "reviewer" ||
    value === "triage" ||
    value === "planner" ||
    value === "post_mortem" ||
    value === "merge_conflict"
  );
}

function isDispatchTransitionForTarget(
  transition: IssueHistorySnapshot,
  target: { role: AgentRunRole; runPhase: AgentRunPhase },
): boolean {
  return (
    transition.role === target.role && transition.runPhase === target.runPhase
  );
}

function isManualPreDispatchResetTransition(
  transition: IssueHistorySnapshot,
): boolean {
  return (
    transition.transitionKind === "reset_lifecycle_after_operator_resume" ||
    transition.transitionKind === "reset_merge_conflict_after_operator_resume"
  );
}

function snapshotAsIssue(snapshot: IssueCurrentStateSnapshot): Issue {
  return currentFieldsAsIssue(snapshot);
}

function currentFieldsAsIssue(current: IssueCurrentFields): Issue;
function currentFieldsAsIssue(current: IssueStateRecord): Issue;
function currentFieldsAsIssue(current: IssueCurrentStateSnapshot): Issue;
function currentFieldsAsIssue(
  current: IssueCurrentFields | IssueStateRecord | IssueCurrentStateSnapshot,
): Issue {
  return {
    id: current.issueId,
    identifier: current.issueIdentifier,
    title: current.title,
    description: current.description,
    priority: current.priority,
    state: current.trackerState,
    branchName: current.branchName,
    url: current.trackerUrl,
    assigneeId: current.assigneeId,
    delegateId: current.delegateId,
    assignedToWorker: current.assignedToWorker,
    labels: [...current.labels],
    blockedBy: current.blockedBy.map((blocker) => ({ ...blocker })),
    hasChildren: current.hasChildren,
    createdAt: current.trackerCreatedAt,
    updatedAt: current.trackerUpdatedAt,
  };
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

function agentRunKindFromUnknown(value: unknown): AgentRunKind | null {
  return value === "planning" ||
    value === "implementation" ||
    value === "review" ||
    value === "triage" ||
    value === "post_mortem"
    ? value
    : null;
}

function isStateIn(state: string, states: string[]): boolean {
  return states.some(
    (candidate) => candidate.toLowerCase() === state.toLowerCase(),
  );
}

function statesEqual(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function uniqueStateNames(states: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const state of states) {
    const key = state.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(state);
  }
  return unique;
}

function uniqueCaseInsensitiveStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(trimmed);
  }
  return unique;
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        const item = items[index];
        if (item === undefined) return;
        await worker(item, index);
      }
    }),
  );
}

function createStartupTerminalCleanupProgressLine(): (
  message: string,
  done?: boolean,
) => void {
  const enabled = process.stderr.isTTY === true;
  let previousLength = 0;
  return (message: string, done = false) => {
    if (!enabled) return;
    const line = `startup terminal cleanup: ${message}`;
    previousLength = Math.max(previousLength, line.length);
    process.stderr.write(`\r${line.padEnd(previousLength)}`);
    if (done) process.stderr.write("\n");
  };
}

function isTerminalSdkRunStatus(status: AgentRunSdkStatus): boolean {
  return status === "finished" || status === "error" || status === "cancelled";
}

function isLifecycleHumanBlocked(
  lifecycle: IssueLifecycleRecord | null,
): boolean {
  return (
    lifecycle !== null &&
    (lifecycle.phase === "blocked" || lifecycle.blockedReason !== null)
  );
}

function hasOpenBlocker(issue: Issue, terminalStates: string[]): boolean {
  return issue.blockedBy.some(
    (blocker) =>
      blocker.state === null || !isStateIn(blocker.state, terminalStates),
  );
}

function hermesResumeContextFromRun(
  run: RunRecord,
  reason: AgentHermesResumeContext["reason"],
): AgentHermesResumeContext | null {
  const profileKey = nonEmptyString(run.hermesProfileKey);
  const profileDir = nonEmptyString(run.hermesProfileDir);
  const sessionKey = nonEmptyString(run.hermesSessionKey);
  if (!profileKey || !profileDir || !sessionKey) return null;
  return {
    sourceRunId: run.runId,
    reason,
    profileKey,
    profileDir,
    sessionKey,
  };
}

function phaseForRepairableHandoffKind(
  kind: RepairableHandoffKind,
): AgentRunPhase {
  switch (kind) {
    case "completion_report":
      return "implementation";
    case "review_verdict":
      return "review";
    case "issue_breakdown_plan":
      return "issue_breakdown";
    case "issue_triage_report":
      return "issue_triage";
    case "issue_post_mortem_report":
      return "post_mortem";
    case "merge_conflict_resolution":
      return "merge_conflict_resolution";
  }
}

function formatRepairableHandoffKind(kind: RepairableHandoffKind): string {
  return kind.replace(/_/g, " ");
}

function repairToolName(kind: RepairableHandoffKind): string {
  switch (kind) {
    case "completion_report":
      return "submit_completion_report";
    case "review_verdict":
      return "submit_review_verdict";
    case "issue_breakdown_plan":
      return "submit_issue_breakdown_plan";
    case "issue_triage_report":
      return "submit_issue_triage_report";
    case "issue_post_mortem_report":
      return "submit_issue_post_mortem_report";
    case "merge_conflict_resolution":
      return "submit_merge_conflict_resolution";
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function workspaceLooksLikeGitWorktree(workspacePath: string): boolean {
  try {
    return existsSync(path.join(workspacePath, ".git"));
  } catch {
    return false;
  }
}

function latestCompletionReport(
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

function latestCompletionReportRejection(
  lifecycle: IssueLifecycleRecord,
): IssueCompletionReportRejectionRecord | null {
  if (lifecycle.lastCompletionReportRejectionId) {
    const exact = lifecycle.completionReportRejections.find(
      (rejection) => rejection.id === lifecycle.lastCompletionReportRejectionId,
    );
    if (exact) return exact;
  }
  return (
    lifecycle.completionReportRejections[
      lifecycle.completionReportRejections.length - 1
    ] ?? null
  );
}

function latestCurrentCompletionReportRejection(
  lifecycle: IssueLifecycleRecord,
): IssueCompletionReportRejectionRecord | null {
  const rejection = latestCompletionReportRejection(lifecycle);
  if (rejection === null) return null;
  const acceptedReport = latestCompletionReport(lifecycle);
  if (acceptedReport === null) return rejection;
  const rejectedAt = Date.parse(rejection.rejectedAt);
  const acceptedAt = Date.parse(acceptedReport.acceptedAt);
  if (
    Number.isFinite(rejectedAt) &&
    Number.isFinite(acceptedAt) &&
    acceptedAt >= rejectedAt
  )
    return null;
  return rejection;
}

function latestReviewVerdict(
  lifecycle: IssueLifecycleRecord,
): IssueReviewVerdictRecord | null {
  if (lifecycle.lastReviewVerdictId) {
    const exact = lifecycle.reviewVerdicts.find(
      (verdict) => verdict.id === lifecycle.lastReviewVerdictId,
    );
    if (exact && !isSupersededLifecycleRecord(exact)) return exact;
  }
  for (const verdict of lifecycle.reviewVerdicts.slice().reverse()) {
    if (!isSupersededLifecycleRecord(verdict)) return verdict;
  }
  return null;
}

function acceptanceCriteriaForReport(
  report: IssueCompletionReportRecord,
): string[] {
  return report.acceptanceChecklist.map((item) => {
    const status = item.satisfied ? "satisfied" : "not satisfied";
    return `${item.text} (${status}${item.evidence === null ? "" : `; evidence: ${item.evidence}`})`;
  });
}

function workspaceEvidenceForReview(
  issue: Issue,
  workspace: Workspace,
  evidence: ReviewerDispatchEvidence,
): string[] {
  const pointers = evidence.lifecycle.summaryPointers;
  const report = evidence.completionReport;
  const workerRun = evidence.workerRun;
  return [
    `Workspace path: ${workspace.path}`,
    `Workspace key: ${workspace.workspaceKey}`,
    `Workspace branch: ${workspace.gitBranchName ?? issue.branchName ?? pointers.gitBranchName ?? pointers.branchName ?? "n/a"}`,
    `Repository path: ${workspace.repoPath ?? pointers.repoPath ?? workerRun?.repoPath ?? "n/a"}`,
    `Base ref: ${workspace.baseRef ?? pointers.baseRef ?? workerRun?.baseRef ?? "n/a"}`,
    `Completion report branch: ${report.branchName ?? "n/a"}`,
    `Pull request: ${report.pullRequest?.url ?? pointers.prUrl ?? workerRun?.prUrl ?? "n/a"}`,
    `Pull request number: ${report.pullRequest?.number ?? pointers.prNumber ?? workerRun?.prNumber ?? "n/a"}`,
    `Pull request head SHA: ${report.pullRequest?.headSha ?? pointers.prHeadSha ?? workerRun?.prHeadSha ?? "n/a"}`,
    `Last pushed at: ${pointers.lastPushedAt ?? workerRun?.lastPushedAt ?? "n/a"}`,
    `Changed files: ${report.changedFiles.length === 0 ? "n/a" : report.changedFiles.join(", ")}`,
  ];
}

function digestTranscript(
  workerRun: RunRecord | null,
  events: TranscriptEvent[],
): string[] {
  const summary = workerRun
    ? [
        `Worker run ${workerRun.runId} status ${workerRun.status}`,
        `Worker agent ${workerRun.agentId ?? "n/a"} session ${workerRun.sessionId ?? "n/a"}`,
        `Worker prompt characters: ${workerRun.promptCharCount ?? "n/a"}`,
      ]
    : ["Worker run metadata is unavailable."];
  const eventDigest = events
    .filter(
      (event) =>
        isPromptRelevantTranscriptEvent(event) &&
        event.message !== undefined &&
        event.message.trim().length > 0,
    )
    .slice(-12)
    .map(
      (event) =>
        `#${event.sequence} ${event.eventType}: ${oneLine(event.message ?? "").slice(0, 240)}`,
    );
  return eventDigest.length === 0 ? summary : [...summary, ...eventDigest];
}

function latestContinuationSummaryReference(
  lifecycle: IssueLifecycleRecord | null,
): IssueLifecycleSummaryReference | null {
  const summaries =
    lifecycle?.summaryReferences.filter(
      (summary) => summary.kind === "continuation_history",
    ) ?? [];
  return (
    [...summaries].sort(
      (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt),
    )[summaries.length - 1] ?? null
  );
}

function effectiveRuntimeModeForEntry(
  entry: RunningEntry,
  config: ServiceConfig,
): "agent" | "plan" | null {
  return entry.runPhase === "issue_breakdown"
    ? config.issueBreakdown.cursorMode
    : config.cursor.mode;
}

function runtimeProviderForHarness(
  harnessId: string,
  config: ServiceConfig,
): string | null {
  if (harnessId === "hermes") return config.hermes.provider;
  if (harnessId === "hermes_acp") return config.hermes.provider;
  return harnessId;
}

function runtimeModelForHarness(
  harnessId: string,
  config: ServiceConfig,
): string | null {
  if (harnessId === "hermes") return config.hermes.model;
  if (harnessId === "hermes_acp") return null;
  if (harnessId === "cursor") return config.cursor.model;
  return null;
}

function runtimeModelParamsForHarness(
  harnessId: string,
  config: ServiceConfig,
): NonNullable<StartRunInput["runtimeModelParams"]> {
  return harnessId === "cursor" ? config.cursor.modelParams : [];
}

function runtimeSettingSourcesForHarness(
  harnessId: string,
  config: ServiceConfig,
): string[] {
  if (harnessId === "cursor") return config.cursor.settingSources;
  if (harnessId === "hermes") {
    return [
      `template:${config.hermes.roleTemplates.planner}`,
      ...(config.hermes.provider === null
        ? []
        : [`provider:${config.hermes.provider}`]),
    ];
  }
  if (harnessId === "hermes_acp") {
    return [
      `host_hermes:${config.hermesAcp.binaryPath ?? "PATH:hermes"}`,
      `source_profile:${config.hermesAcp.sourceProfile ?? "active"}`,
      `profile_prefix:${config.hermesAcp.profilePrefix}`,
    ];
  }
  return [];
}

function runtimeModeForHarness(
  harnessId: string,
  config: ServiceConfig,
): string | null {
  if (harnessId === "cursor") return config.cursor.mode;
  if (harnessId === "hermes") return config.cursor.mode;
  return null;
}

function runtimeAllowLargeContextForHarness(
  harnessId: string,
  config: ServiceConfig,
): boolean | undefined {
  return harnessId === "cursor" ? config.cursor.allowLargeContext : undefined;
}

function operatorChatIssueId(conversationId: string): string {
  return `operator:${conversationId}`;
}

async function existingDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

function mergeTokenCounts(
  current: TokenCounts,
  patch: Partial<TokenCounts>,
): TokenCounts {
  return {
    inputTokens: patch.inputTokens ?? current.inputTokens,
    outputTokens: patch.outputTokens ?? current.outputTokens,
    totalTokens: patch.totalTokens ?? current.totalTokens,
  };
}

function mergeOperatorAssistantText(
  current: string,
  next: string,
  activitySource: AgentActivitySource | undefined,
): string {
  if (next.trim().length === 0) return current;
  if (activitySource === "delta") return `${current}${next}`;
  if (current.trim().length === 0) return next;
  if (next.startsWith(current)) return next;
  if (current.includes(next)) return current;
  return `${current.trimEnd()}\n\n${next}`;
}

function operatorAssistantMetadata(input: {
  command: OrchestratorChatCommand;
  event: Extract<AgentEvent, { type: "session_started" }>;
  harnessId: string;
  model: string | null;
}): Record<string, unknown> {
  return {
    source: "operator_chat",
    commandMessageId: input.command.messageId,
    operatorRun: {
      runId: input.event.runId ?? input.event.sessionId,
      sessionId: input.event.sessionId,
      threadId: input.event.threadId ?? null,
      harnessId: input.harnessId,
      model: input.model,
      role: "planner",
      runKind: "planning",
      status: "streaming",
    },
  };
}

function providerGateDispatchBlockedMessage(gate: RuntimeProviderGate): string {
  const provider = gate.scope.providerId ?? gate.scope.harnessId;
  const reset = gate.window?.resumeAt
    ? ` Dispatch can resume at ${gate.window.resumeAt}.`
    : " Dispatch is waiting for operator resume.";
  return `Provider limit active for ${provider}: ${gate.message}.${reset}`;
}

function runtimeMetadataForEntry(
  harnessId: string,
  entry: RunningEntry,
  config: ServiceConfig,
  sessionStartedEvent?: Extract<AgentEvent, { type: "session_started" }>,
): Partial<
  Pick<
    StartRunInput,
    | "runtimeModel"
    | "runtimeModelParams"
    | "runtimeSettingSources"
    | "runtimeMode"
    | "runtimeAllowLargeContext"
    | "runtimeAgentLifecycle"
  >
> {
  if (harnessId === "cursor") {
    return {
      runtimeModel: config.cursor.model,
      runtimeModelParams: config.cursor.modelParams,
      runtimeSettingSources: config.cursor.settingSources,
      runtimeMode: effectiveRuntimeModeForEntry(entry, config),
      runtimeAllowLargeContext: config.cursor.allowLargeContext,
      runtimeAgentLifecycle: config.cursor.workerAgentLifecycle,
    };
  }
  if (harnessId === "hermes") {
    return {
      runtimeModel: config.hermes.model,
      runtimeModelParams: [],
      runtimeSettingSources: [
        `template:${hermesTemplateForEntry(entry, config)}`,
        ...(config.hermes.provider === null
          ? []
          : [`provider:${config.hermes.provider}`]),
      ],
      runtimeMode: effectiveRuntimeModeForEntry(entry, config),
      runtimeAgentLifecycle: config.hermes.workerSessionLifecycle,
    };
  }
  if (harnessId === "hermes_acp") {
    const runtimeProviderId = cleanRuntimeMetadataString(
      sessionStartedEvent?.providerId,
    );
    const runtimeModel = cleanRuntimeMetadataString(sessionStartedEvent?.model);
    return {
      runtimeModel,
      runtimeModelParams: [],
      runtimeSettingSources: [
        `host_hermes:${config.hermesAcp.binaryPath ?? "PATH:hermes"}`,
        `source_profile:${config.hermesAcp.sourceProfile ?? "active"}`,
        `profile_prefix:${config.hermesAcp.profilePrefix}`,
        ...(runtimeProviderId === null
          ? []
          : [`provider:${runtimeProviderId}`]),
      ],
      runtimeMode: null,
      runtimeAgentLifecycle: config.hermesAcp.workerSessionLifecycle,
    };
  }
  return {
    runtimeModel: null,
    runtimeModelParams: [],
    runtimeSettingSources: [],
    runtimeMode: effectiveRuntimeModeForEntry(entry, config),
  };
}

function cleanRuntimeMetadataString(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function hermesTemplateForEntry(
  entry: RunningEntry,
  config: ServiceConfig,
): string {
  if (entry.role === "reviewer") return config.hermes.roleTemplates.reviewer;
  if (entry.role === "post_mortem")
    return config.hermes.roleTemplates.postMortem;
  if (entry.runPhase === "issue_breakdown")
    return config.hermes.roleTemplates.planner;
  if (entry.runPhase === "merge_conflict_resolution")
    return config.hermes.roleTemplates.mergeConflictResolution;
  return config.hermes.roleTemplates.worker;
}

function maxPlanningFailuresReason(count: number, max: number): string {
  return `max planning failures reached (${count}/${max})`;
}

function mergeConflictBlockedReason(count: number, max: number): string {
  return `merge conflicts remain unresolved (${count}/${max} conflict-fix attempts)`;
}

function maxPlanningDispatchRetriesReason(count: number, max: number): string {
  return `max planning dispatch retries reached (${count}/${max})`;
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
  const failedAtMs = Date.parse(lifecycle.lastPlanningFailureAt);
  if (!Number.isFinite(failedAtMs)) return 0;
  const dueAtMs =
    failedAtMs + planningRetryDelayMs(lifecycle.planningFailureCount, config);
  return Math.max(0, dueAtMs - nowMs);
}

function planningRetryDueAtIso(
  lifecycle: IssueLifecycleRecord,
  config: ServiceConfig,
): string | null {
  if (
    lifecycle.planningFailureCount <= 0 ||
    lifecycle.lastPlanningFailureAt === null
  )
    return null;
  const failedAtMs = Date.parse(lifecycle.lastPlanningFailureAt);
  if (!Number.isFinite(failedAtMs)) return null;
  return new Date(
    failedAtMs + planningRetryDelayMs(lifecycle.planningFailureCount, config),
  ).toISOString();
}

function hasRealHandoffContext(
  lifecycle: IssueLifecycleRecord,
  runs: RunRecord[],
): boolean {
  return (
    lifecycle.handoff.lastWorkerOutput !== null ||
    lifecycle.completionReportRejections.length > 0 ||
    lifecycle.handoff.lastReviewerOutput !== null ||
    runs.length > 0 ||
    lifecycle.reviewRound > 0 ||
    lifecycle.incompleteTurnCount > 0 ||
    lifecycle.summaryReferences.length > 0 ||
    lifecycle.reviewEvidence.items.some(isActiveReviewEvidenceItem) ||
    lifecycle.mergeGate !== null ||
    lifecycle.merge !== null ||
    lifecycle.phase !== "implementation"
  );
}

function currentPromptLifecycle(
  lifecycle: IssueLifecycleRecord,
): IssueLifecycleRecord {
  return (
    sanitizeStaleMergeGateLifecycle(
      lifecycle,
      lifecycle.summaryPointers.prHeadSha,
      lifecycle.summaryPointers.prNumber,
    ) ?? lifecycle
  );
}

function nextWorkerAction(lifecycle: IssueLifecycleRecord): string {
  if (
    lifecycle.mergeGate?.status === "repair_dispatched" ||
    lifecycle.mergeGate?.status === "blocked"
  ) {
    return "Repair the Symphony merge-gate checks on the lifecycle-bound PR, validate, and submit a new completion report.";
  }
  if (latestCurrentCompletionReportRejection(lifecycle) !== null) {
    return "Fix the rejected completion report: satisfy every acceptance checklist item with durable evidence before submitting again.";
  }
  if (lifecycle.handoff.lastReviewerOutput?.verdict === "blocked") {
    return "Use the blocked reviewer verdict as recovery context; wait for triage or operator guidance before treating it as worker-owned repair.";
  }
  if (lifecycle.handoff.lastReviewerOutput?.verdict === "fail")
    return "Address the latest reviewer findings, validate, and submit a new completion report.";
  if (lifecycle.incompleteTurnCount > 0)
    return "Continue the incomplete implementation using the memo and pointers before rediscovering context.";
  if (lifecycle.reviewEvidence.items.some(isActiveReviewEvidenceItem)) {
    return "Address active unresolved PR review evidence before submitting another completion report.";
  }
  return "Continue implementation using the compact memo and stable pointers.";
}

async function listRunsForLifecycle(
  runStore: RunTranscriptStore,
  lifecycle: IssueLifecycleRecord,
): Promise<RunRecord[]> {
  const byId = new Map<string, RunRecord>();
  for (const key of new Set([lifecycle.issueId, lifecycle.issueIdentifier])) {
    for (const run of await runStore.listRunsForIssue(key)) {
      byId.set(run.runId, run);
    }
  }
  return [...byId.values()].sort(compareRunChronology);
}

async function readContinuationTranscriptEvents(
  runStore: RunTranscriptStore,
  runs: RunRecord[],
): Promise<TranscriptEvent[]> {
  const events: TranscriptEvent[] = [];
  for (const run of runs) {
    let offset = 0;
    do {
      const page = await runStore.readTranscript(run.runId, {
        offset,
        limit: 1_000,
      });
      events.push(...page.events);
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    } while (true);
  }
  return events;
}

function upsertSummaryReference(
  existing: IssueLifecycleSummaryReference[],
  summaryReference: IssueLifecycleSummaryReference,
): IssueLifecycleSummaryReference[] {
  return [
    ...existing.filter((item) => item.id !== summaryReference.id),
    summaryReference,
  ];
}

function transcriptPointersForRuns(runs: RunRecord[]): string[] {
  return runs
    .slice(-5)
    .map((run) => `/api/v1/runs/${encodeURIComponent(run.runId)}/transcript`);
}

function statusApiPointersForIssue(
  issueIdentifier: string,
  runs: RunRecord[],
): string[] {
  return [
    `/api/v1/issues/${encodeURIComponent(issueIdentifier)}`,
    `/api/v1/issues/${encodeURIComponent(issueIdentifier)}/runs`,
    ...runs
      .slice(-5)
      .map((run) => `/api/v1/runs/${encodeURIComponent(run.runId)}`),
  ];
}

function promptRelevantTranscriptEvents(
  events: TranscriptEvent[],
): TranscriptEvent[] {
  return events.filter(isPromptRelevantTranscriptEvent);
}

function isPromptRelevantTranscriptEvent(event: TranscriptEvent): boolean {
  return (
    event.eventType !== "lane_memo_updated" &&
    event.eventType !== "transcript_recall"
  );
}

function formatPointerList(pointers: string[]): string[] {
  return pointers.length === 0
    ? ["- n/a"]
    : pointers.map((pointer) => `- ${pointer}`);
}

function formatList(values: string[]): string {
  return values.length === 0 ? "n/a" : values.join("; ");
}

function formatCompletionReportRejectionForPrompt(
  rejection: IssueCompletionReportRejectionRecord | null,
): string[] {
  if (rejection === null) return ["- None"];
  const unsatisfied = rejection.acceptanceChecklist.filter(
    (item) => !item.satisfied,
  );
  return [
    `- Rejection: ${rejection.id}; report: ${rejection.reportId}; run: ${rejection.runId}; rejectedAt: ${rejection.rejectedAt}`,
    `- Reason: ${rejection.reason}`,
    "- Unsatisfied acceptance checklist:",
    ...(unsatisfied.length === 0
      ? ["- n/a"]
      : unsatisfied.map(
          (item) =>
            `- [ ] ${item.text}${item.evidence === null ? "" : ` (${item.evidence})`}`,
        )),
    "- Submitted report summary:",
    `- Summary: ${rejection.summary}`,
    `- Changed files: ${formatList(rejection.changedFiles)}`,
    `- Validation: ${formatList(rejection.validationEvidence)}`,
    `- Risks: ${formatList(rejection.risks)}`,
  ];
}

function formatBlockedReviewerVerdictForPrompt(
  verdict: IssueReviewerOutputContract | null,
): string[] {
  if (verdict?.verdict !== "blocked") return ["- None"];
  return [
    `- Verdict: ${verdict.verdict}; record: ${verdict.verdictId}; run: ${verdict.runId}; submittedAt: ${verdict.submittedAt}`,
    `- Blocked findings: ${formatList(verdict.findings)}`,
    "- Acceptance results:",
    ...(verdict.acceptanceResults.length === 0
      ? ["- n/a"]
      : verdict.acceptanceResults.map(
          (item) =>
            `- ${item.satisfied ? "[x]" : "[ ]"} ${item.text}${item.evidence === null ? "" : ` (${item.evidence})`}`,
        )),
    `- Evidence: ${formatList(verdict.evidence)}`,
    "- Recovery note: classify this as reviewer-unable-to-proceed evidence; do not treat it as worker-owned repair unless triage or operator guidance identifies a bounded worker action.",
  ];
}

function formatUserPromptPacket(
  title: string,
  sections: Array<[string, string | null]>,
): string {
  const renderedSections = sections
    .filter(
      (section): section is [string, string] =>
        section[1] !== null && section[1].trim().length > 0,
    )
    .map(([heading, body]) => [`## ${heading}`, body.trim()].join("\n\n"));
  return [
    `# ${title}`,
    "",
    "## How To Read This Prompt",
    "Use the pinned ephemeral system prompt as the current directive. Use this user prompt as the evidence packet and detailed handoff instructions.",
    "",
    ...renderedSections,
  ].join("\n");
}

function formatPullRequest(number: number | null, url: string | null): string {
  const parts = [number === null ? null : `#${number}`, url].filter(
    (value): value is string => value !== null,
  );
  return parts.length === 0 ? "n/a" : parts.join(" ");
}

function formatMergeConflictServicePreparationPrompt(
  conflict: IssueMergeConflictMetadata | null,
): string[] {
  const servicePreparation = conflict?.servicePreparation ?? null;
  if (servicePreparation === null) return [];
  if (servicePreparation.strategy === "stash_apply") {
    return [
      `- Service preparation: ${servicePreparation.strategy} (${servicePreparation.status})`,
      "- Conflict source: preserved local changes restored after service-owned git repair",
      `- Current PR head SHA: ${servicePreparation.currentHeadSha}`,
      `- Stash ref: ${servicePreparation.preservedStash.stashRef}`,
      `- Stash status: ${servicePreparation.preservedStash.status}`,
      `- Preserved local-change files: ${servicePreparation.preservedStash.dirtyFiles.length === 0 ? "none" : servicePreparation.preservedStash.dirtyFiles.join(", ")}`,
      `- Stash-apply conflicted files: ${servicePreparation.conflictedFiles.length === 0 ? "none" : servicePreparation.conflictedFiles.join(", ")}`,
      `- Allowed repair files: ${servicePreparation.allowedFiles.length === 0 ? "none" : servicePreparation.allowedFiles.join(", ")}`,
    ];
  }
  return [
    `- Service preparation: ${servicePreparation.strategy} (${servicePreparation.status})`,
    `- Service observed PR base head SHA: ${servicePreparation.observedPrBaseHeadSha ?? "n/a"}`,
    `- Service live base head SHA: ${servicePreparation.liveBaseHeadSha}`,
    `- Service prepared base head SHA: ${servicePreparation.preparedBaseHeadSha}`,
    `- Service-prepared conflicted files: ${servicePreparation.conflictedFiles.length === 0 ? "none" : servicePreparation.conflictedFiles.join(", ")}`,
    ...(servicePreparation.preservedStash
      ? [
          `- Pending preserved local changes stash: ${servicePreparation.preservedStash.stashRef}`,
          `- Preserved local-change files: ${servicePreparation.preservedStash.dirtyFiles.length === 0 ? "none" : servicePreparation.preservedStash.dirtyFiles.join(", ")}`,
        ]
      : []),
  ];
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function formatRolePhaseDirective(
  entry: RunningEntry,
  options: { attempt: number | null; turnNumber: number },
): string {
  return [
    `- Issue: ${entry.issue.identifier} - ${entry.issue.title}`,
    `- Role: ${entry.role}`,
    `- Phase: ${entry.runPhase}`,
    `- Run kind: ${runKindForPhase(entry.runPhase)}`,
    `- Turn: ${options.turnNumber}`,
    `- Attempt: ${options.attempt ?? "n/a"}`,
    `- State at dispatch: ${entry.issue.state}`,
  ].join("\n");
}

function currentObjectiveDirective(
  entry: RunningEntry,
  lifecycle: IssueLifecycleRecord | null,
  options: { turnNumber: number },
): string {
  if (entry.handoffRepair) {
    return `Resume the existing Hermes session only to call the missing ${formatRepairableHandoffKind(entry.handoffRepair.kind)} MCP handoff. Do not perform new implementation, review, planning, git, GitHub, or Linear work.`;
  }
  if (entry.runPhase === "issue_breakdown") {
    return "Create a SpecKit-backed decomposition plan and submit proposed blocking Linear child issues for the parent issue.";
  }
  if (entry.runPhase === "issue_triage") {
    return "Identify every blocker behind the current recovery trigger and submit a read-only issue triage blocker report.";
  }
  if (entry.runPhase === "post_mortem") {
    return "Perform a read-only post-mortem for the completed issue and submit an exhaustive issue post-mortem report.";
  }
  if (entry.runPhase === "review") {
    return "Perform an exhaustive independent review against the issue contract and current implementation evidence.";
  }
  if (entry.runPhase === "merge_conflict_resolution") {
    return "Resolve only the lifecycle-bound pull request merge conflict and submit the merge-conflict resolution handoff.";
  }
  if (options.turnNumber > 1) {
    return "Continue the incomplete implementation turn, satisfy the unmet requirements, and submit the required completion handoff.";
  }
  const triage = latestIssueTriageReport(lifecycle);
  const workerBlockers = activeWorkerOwnedIssueTriageBlockers(triage);
  if (workerBlockers.length > 0) {
    return `Run a focused implementation turn for the active triage blockers: ${workerBlockers.map((blocker) => blocker.kind).join(", ")}.`;
  }
  if (
    lifecycle?.mergeGate?.status === "repair_dispatched" ||
    lifecycle?.mergeGate?.status === "blocked"
  ) {
    return "Repair only the active Symphony merge-gate blocker on the lifecycle-bound pull request.";
  }
  if (lifecycle && latestCurrentCompletionReportRejection(lifecycle) !== null) {
    return "Fix the rejected completion report by satisfying every acceptance checklist item with durable evidence before submitting again.";
  }
  if (lifecycle?.handoff.lastReviewerOutput?.verdict === "blocked") {
    return "Use the blocked reviewer verdict as recovery context; proceed with implementation only when triage or operator guidance identifies bounded worker-owned repair.";
  }
  if (lifecycle?.handoff.lastReviewerOutput?.verdict === "fail") {
    return "Repair the latest reviewer-requested changes while preserving correct completed work.";
  }
  if ((lifecycle?.incompleteTurnCount ?? 0) > 0) {
    return "Complete the previously unsatisfied issue requirements without broadening scope.";
  }
  return "Implement the issue contract exactly and submit a completion report with concrete validation evidence.";
}

function activeDirectiveForRun(
  entry: RunningEntry,
  lifecycle: IssueLifecycleRecord | null,
  options: { reviewerEvidence?: ReviewerDispatchEvidence | null },
): string {
  if (entry.handoffRepair) {
    return [
      `- Source run: ${entry.handoffRepair.sourceRunId}`,
      `- Missing handoff: ${formatRepairableHandoffKind(entry.handoffRepair.kind)}`,
      `- Required tool: ${repairToolName(entry.handoffRepair.kind)}`,
      "- Use only findings already present in the resumed session.",
    ].join("\n");
  }
  if (entry.runPhase === "review" && options.reviewerEvidence) {
    return [
      `- Completion report: ${options.reviewerEvidence.completionReport.id}`,
      `- Worker run: ${options.reviewerEvidence.completionReport.runId}`,
      `- Summary: ${options.reviewerEvidence.completionReport.summary}`,
      `- Changed files: ${formatList(options.reviewerEvidence.completionReport.changedFiles)}`,
      `- Validation evidence: ${formatList(options.reviewerEvidence.completionReport.validationEvidence)}`,
    ].join("\n");
  }
  const triage = latestIssueTriageReport(lifecycle);
  const verdict = lifecycle ? latestReviewVerdict(lifecycle) : null;
  const gate = lifecycle?.mergeGate ?? null;
  const sections: string[] = [];
  if (triage) {
    sections.push(
      [
        "Latest issue triage:",
        `- Summary: ${triage.summary}`,
        ...formatTriageBlockersForDirective(triage.blockers),
      ].join("\n"),
    );
  }
  if (verdict?.verdict === "fail") {
    sections.push(
      [
        "Latest review failure:",
        `- Review run: ${verdict.runId}`,
        "Gate findings:",
        ...formatDirectiveGateFindings(verdict),
        "Discovery findings (not worker-gating):",
        ...formatDirectiveDiscoveryFindings(verdict),
        "Unsatisfied acceptance results:",
        ...formatDirectiveAcceptanceGaps(verdict.acceptanceResults),
      ].join("\n"),
    );
  }
  if (verdict?.verdict === "blocked") {
    sections.push(
      [
        "Latest blocked review:",
        `- Review run: ${verdict.runId}`,
        `- Blocked findings: ${formatList(verdict.findings)}`,
        "Unsatisfied or blocked acceptance results:",
        ...formatDirectiveAcceptanceGaps(verdict.acceptanceResults),
        "Discovery findings (not worker-gating):",
        ...formatDirectiveDiscoveryFindings(verdict),
        `- Evidence: ${formatList(verdict.evidence)}`,
      ].join("\n"),
    );
  }
  if (
    gate &&
    (gate.status === "repair_dispatched" || gate.status === "blocked")
  ) {
    const actionable = gate.checks.filter(
      (check) =>
        check.outcome === "failing" || check.outcome === "missing_actionable",
    );
    sections.push(
      [
        "Active merge gate:",
        `- Gate: ${gate.id}; status: ${gate.status}`,
        `- PR: ${formatPullRequest(gate.pullRequest.number, gate.pullRequest.url)}`,
        `- Head SHA: ${gate.headSha}`,
        `- Actionable checks: ${formatList(actionable.map((check) => `${check.name}=${check.outcome}`))}`,
      ].join("\n"),
    );
  }
  if (sections.length > 0) return sections.join("\n\n");
  return "- No prior review, triage, or merge-gate repair signal is active for this run.";
}

function issueTriageLedgerLines(
  lifecycle: IssueLifecycleRecord,
  report: IssueCompletionReportRecord | null,
  verdict: IssueReviewVerdictRecord | null,
  gate: IssueLifecycleRecord["mergeGate"],
): string[] {
  const lines = [
    `- Lifecycle phase: ${lifecycle.phase}`,
    `- Blocked reason: ${lifecycle.blockedReason ?? "n/a"}`,
    `- Latest completion report: ${report?.id ?? "none"}${report ? ` acceptedAt=${report.acceptedAt}` : ""}`,
    `- Latest review verdict: ${verdict?.id ?? "none"}${verdict ? ` verdict=${verdict.verdict} submittedAt=${verdict.submittedAt}` : ""}`,
  ];
  if (verdict?.verdict === "fail" && isMergeGateVerdict(verdict)) {
    lines.push(
      "- Deterministic blocker: latest failed verdict is a service-owned merge-gate verdict; classify the concrete check, mergeability, conflict, infra, or operator blocker. Do not report implementation_unsatisfied_requirements solely because the merge gate fail is newer than the latest completion report.",
    );
  } else if (isUnsupersededReviewFailure(report, verdict)) {
    lines.push(
      "- Deterministic blocker: latest review failure is active and unsuperseded by worker completion; report implementation_unsatisfied_requirements unless stronger evidence proves decomposition or orchestration-context failure.",
    );
  } else if (verdict?.verdict === "fail") {
    lines.push(
      "- Deterministic blocker: latest review failure appears superseded by a newer completion report; verify before marking it downstream or resolved.",
    );
  }
  if (gate) {
    lines.push(
      `- Merge gate signal: status=${gate.status}; headSha=${gate.headSha}; blockerFingerprint=${gate.blockerFingerprint ?? "n/a"}`,
    );
  } else {
    lines.push("- Merge gate signal: none recorded in lifecycle.");
  }
  lines.push(...reviewScopeDiscoveryLedgerLines(lifecycle));
  lines.push(
    "- Precedence rule: lower-precedence PR, CI, merge, or review-gate signals do not clear higher-precedence active blockers.",
  );
  return lines;
}

function isUnsupersededReviewFailure(
  report: IssueCompletionReportRecord | null,
  verdict: IssueReviewVerdictRecord | null,
): boolean {
  if (
    !verdict ||
    verdict.verdict !== "fail" ||
    isMergeGateVerdict(verdict) ||
    isSupersededLifecycleRecord(verdict)
  )
    return false;
  if (!report) return true;
  return Date.parse(verdict.submittedAt) >= Date.parse(report.acceptedAt);
}

function reportHasActiveTriageBlocker(
  report: IssueLifecycleRecord["issueTriageReports"][number] | null | undefined,
  kind: IssueTriageBlockerKind,
): boolean {
  return activeIssueTriageBlockers(report).some(
    (blocker) => blocker.kind === kind,
  );
}

function resetMergeGateFailureBudgetForOperatorAction(
  gate: IssueMergeGateState | null,
  now: string,
): IssueMergeGateState | null {
  if (gate === null) return null;
  const wasActive = gate.status !== "resolved" && gate.status !== "superseded";
  return {
    ...gate,
    status: wasActive ? "resolved" : gate.status,
    reviewRound: 0,
    blockerFingerprint: wasActive ? null : gate.blockerFingerprint,
    supersededByHeadSha:
      gate.status === "superseded" ? gate.supersededByHeadSha : null,
    updatedAt: now,
  };
}

function resetMergeConflictFailureBudgetForOperatorAction(
  conflict: IssueMergeConflictMetadata | null,
  now: string,
  reopenMergeConflict: boolean,
): IssueMergeConflictMetadata | null {
  if (conflict === null) return null;
  const shouldReopen =
    reopenMergeConflict &&
    (conflict.status === "blocked" || conflict.resolutionStatus === "blocked");
  return {
    ...conflict,
    status: shouldReopen ? "open" : conflict.status,
    resolutionStatus: shouldReopen
      ? "still_conflicted"
      : conflict.resolutionStatus,
    fixTurnCount: shouldReopen ? 0 : conflict.fixTurnCount,
    lastConflictFixRunId: shouldReopen ? null : conflict.lastConflictFixRunId,
    attemptRunIds: shouldReopen ? [] : conflict.attemptRunIds,
    blockedAt: shouldReopen ? null : conflict.blockedAt,
    blockedReason: shouldReopen ? null : conflict.blockedReason,
    updatedAt: shouldReopen ? now : conflict.updatedAt,
  };
}

function formatTriageBlockersForDirective(
  blockers: readonly IssueTriageBlockerRecord[],
): string[] {
  if (blockers.length === 0) return ["- Blockers: none reported."];
  return [
    "Blockers, ordered by Symphony precedence:",
    ...sortIssueTriageBlockers(blockers).map(
      (blocker, index) =>
        `- ${index + 1}. ${blocker.kind} (${blocker.status}, ${blocker.nextActor}, ${blocker.confidence}): ${blocker.summary}; action: ${blocker.recommendedAction}`,
    ),
  ];
}

function successConditionsForRun(
  entry: RunningEntry,
  lifecycle: IssueLifecycleRecord | null,
  _options: { turnNumber: number },
): string {
  if (entry.handoffRepair) {
    return `- Call ${repairToolName(entry.handoffRepair.kind)} once with the best valid payload supported by the prior session findings.\n- Stop after the required MCP call.`;
  }
  if (entry.runPhase === "review") {
    return [
      "- Check every Issue Contract requirement and relevant adjacent scenario.",
      "- Leave required PR review feedback when applicable.",
      "- Call submit_review_verdict before ending the run.",
    ].join("\n");
  }
  if (entry.runPhase === "issue_triage") {
    return [
      "- Submit an exhaustive blockers list; do not collapse the situation into one disposition.",
      "- Include status, nextActor, confidence, summary, evidence, and recommendedAction for every blocker.",
      "- Lower-precedence PR, CI, merge, or review-gate blockers must not mask active implementation, validation, decomposition, or orchestration-context blockers.",
      "- Do not convert a service-owned merge-gate verdict into an active worker blocker unless direct evidence shows worker-authored content caused the failing check.",
      "- Call submit_issue_triage_report before ending the run.",
    ].join("\n");
  }
  if (entry.runPhase === "post_mortem") {
    return [
      "- Judge whether Done was valid under the explicit contract standard.",
      "- Report hardening opportunities, hidden scope, weak specification, and process lessons as follow-up candidates rather than retroactive gates unless they are contract-entitled defects.",
      "- Include completionJudgment, specificationAssessment, reviewAssessment, followUpCandidates, and processLessons.",
      "- Call submit_issue_post_mortem_report before ending the run.",
    ].join("\n");
  }
  if (entry.runPhase === "issue_breakdown") {
    return [
      "- Complete specify, plan, tasks, analyze, fix, and task-to-Linear issue planning in one planner session.",
      "- Proposed child issues must satisfy Symphony issue-contract lint.",
      "- Call submit_issue_breakdown_plan before ending the run.",
    ].join("\n");
  }
  if (entry.runPhase === "merge_conflict_resolution") {
    return [
      "- Resolve only merge conflicts on the lifecycle-bound PR.",
      "- Validate the conflict resolution evidence.",
      "- Call submit_merge_conflict_resolution before ending the run.",
    ].join("\n");
  }
  const triage = latestIssueTriageReport(lifecycle);
  const workerBlockers = activeWorkerOwnedIssueTriageBlockers(triage);
  return [
    workerBlockers.length > 0
      ? `- Complete every active worker-owned triage blocker: ${workerBlockers.map((blocker) => `${blocker.kind}: ${blocker.recommendedAction}`).join(" | ")}`
      : "- Satisfy every Issue Contract requirement.",
    "- Preserve correct completed work unless current evidence proves it conflicts with the contract.",
    "- Validate with concrete commands, tests, API checks, or reasoned manual evidence.",
    "- Call submit_completion_report before ending the run.",
  ].join("\n");
}

function scopeGuardsForRun(
  entry: RunningEntry,
  _options: { turnNumber: number },
): string {
  const common = [
    "- The current run directive is authoritative over stale session assumptions.",
    "- Do not commit, push, transition Linear, comment on Linear, or create/update GitHub PRs directly unless a Symphony MCP tool explicitly performs that service-owned action.",
  ];
  if (entry.runPhase === "post_mortem") {
    return [
      "- This run is read-only except for the required Symphony MCP post-mortem handoff.",
      "- Do not edit files or alter repository, Linear, or GitHub state directly.",
      ...common,
    ].join("\n");
  }
  if (entry.runPhase === "review" || entry.runPhase === "issue_triage") {
    return [
      "- This run is read-only except for the required Symphony MCP handoff and allowed review feedback.",
      "- Do not edit files or alter repository, Linear, or GitHub state directly.",
      ...common,
    ].join("\n");
  }
  if (entry.handoffRepair) {
    return [
      "- Do not perform new investigation or code edits.",
      "- Do not reopen implementation, review, planning, git, GitHub, or Linear work.",
      ...common,
    ].join("\n");
  }
  return [
    "- Keep the change scoped to the current issue contract and active repair evidence.",
    "- Do not broaden scope from stale conversation history.",
    ...common,
  ].join("\n");
}

function requiredHandoffForRun(entry: RunningEntry): string {
  if (entry.handoffRepair)
    return `Call ${repairToolName(entry.handoffRepair.kind)} and then stop.`;
  switch (entry.runPhase) {
    case "review":
      return "Call submit_review_verdict before ending the run.";
    case "issue_triage":
      return "Call submit_issue_triage_report before ending the run.";
    case "post_mortem":
      return "Call submit_issue_post_mortem_report before ending the run.";
    case "issue_breakdown":
      return "Call submit_issue_breakdown_plan before ending the run.";
    case "merge_conflict_resolution":
      return "Call submit_merge_conflict_resolution before ending the run.";
    case "implementation":
      return "Call submit_completion_report before ending the run.";
  }
}

function manualAgentRunTarget(stage: ManualAgentRunStage): {
  role: AgentRunRole;
  runPhase: AgentRunPhase;
} {
  switch (stage) {
    case "worker":
      return { role: "worker", runPhase: "implementation" };
    case "reviewer":
      return { role: "reviewer", runPhase: "review" };
    case "triage":
      return { role: "triage", runPhase: "issue_triage" };
    case "planner":
      return { role: "planner", runPhase: "issue_breakdown" };
    case "post_mortem":
      return { role: "post_mortem", runPhase: "post_mortem" };
    case "merge_conflict":
      return { role: "worker", runPhase: "merge_conflict_resolution" };
  }
}

function defaultRunPhaseForRole(role: AgentRunRole): AgentRunPhase {
  switch (role) {
    case "reviewer":
      return "review";
    case "triage":
      return "issue_triage";
    case "post_mortem":
      return "post_mortem";
    case "planner":
      return "issue_breakdown";
    case "worker":
      return "implementation";
  }
}

function manualAgentNotDispatched(
  issue: Issue | null,
  target: { role: AgentRunRole; runPhase: AgentRunPhase },
  reason: string,
): ManualAgentRunResult {
  return {
    status: "not_dispatched",
    issue,
    role: target.role,
    runPhase: target.runPhase,
    runKind: runKindForPhase(target.runPhase),
    reason,
  };
}

function manualAgentEligibility(
  issue: Issue | null,
  target: { role: AgentRunRole; runPhase: AgentRunPhase },
  reason: string | null,
  explanation: string | null,
): ManualAgentEligibilityResult {
  return {
    issue,
    role: target.role,
    runPhase: target.runPhase,
    runKind: runKindForPhase(target.runPhase),
    eligible: reason === null,
    reason,
    explanation,
  };
}

function terminalManualRunStatus(
  status: "running" | "succeeded" | "failed" | "cancelled" | undefined,
): "succeeded" | "failed" | "cancelled" | "unknown" {
  return status === "succeeded" || status === "failed" || status === "cancelled"
    ? status
    : "unknown";
}

function formatPinnedIssueContract(
  contract: ReturnType<typeof summarizeIssueContractForPrompt>,
): string {
  const sections: string[] = [];
  if (contract.issueContractJson) {
    sections.push(
      [
        "Fenced JSON Issue Contract:",
        "```json",
        contract.issueContractJson,
        "```",
      ].join("\n"),
    );
  } else {
    sections.push(
      "Fenced JSON Issue Contract: missing or invalid in the issue description.",
    );
  }
  sections.push(
    [
      "Contract Checklist:",
      clipPromptBlock(
        contract.contractChecklist ??
          "No Contract Checklist section was found.",
      ),
    ].join("\n"),
  );
  sections.push(
    [
      "Validation Requirements:",
      clipPromptBlock(
        contract.validationRequirements ??
          "No Validation Requirements section was found.",
      ),
    ].join("\n"),
  );
  const warnings = [
    ...contract.missingSections.map((section) => `Missing section: ${section}`),
    ...contract.issueContractErrors,
    ...contract.underSpecifiedContractErrors,
  ];
  if (warnings.length > 0) {
    sections.push(
      [
        "Contract authoring warnings:",
        ...warnings.map((warning) => `- ${warning}`),
      ].join("\n"),
    );
  }
  return sections.join("\n\n");
}

function formatDirectiveAcceptanceGaps(
  results: IssueReviewVerdictRecord["acceptanceResults"],
): string[] {
  const gaps = results.filter((item) => !item.satisfied);
  if (gaps.length === 0) return ["- None"];
  return gaps.map(
    (item) =>
      `- ${item.text}${item.evidence === null ? "" : ` (${item.evidence})`}`,
  );
}

function formatDirectiveGateFindings(
  verdict: IssueReviewVerdictRecord,
): string[] {
  const findings =
    verdict.gateFindings.length === 0
      ? verdict.findings.map((finding) => ({
          summary: finding,
          requirementIds: [] as string[],
          scenario: "legacy unstructured finding",
          scenarioEntitlement: "necessary_core_behavior",
        }))
      : verdict.gateFindings;
  if (findings.length === 0) return ["- None"];
  return findings.map(
    (finding) =>
      `- ${finding.summary} (requirements: ${finding.requirementIds.length === 0 ? "n/a" : finding.requirementIds.join(", ")}; scenario: ${finding.scenario}; entitlement: ${finding.scenarioEntitlement})`,
  );
}

function formatDirectiveDiscoveryFindings(
  verdict: IssueReviewVerdictRecord,
): string[] {
  if (verdict.discoveryFindings.length === 0) return ["- None"];
  return verdict.discoveryFindings.map(
    (finding) =>
      `- ${finding.summary} (${finding.importance}, ${finding.relationship}, ${finding.suggestedDisposition}; axes: ${finding.scenarioAxes.length === 0 ? "n/a" : finding.scenarioAxes.join(", ")})`,
  );
}

function reviewScopeDiscoveryLedgerLines(
  lifecycle: IssueLifecycleRecord,
): string[] {
  const failedVerdicts = lifecycle.reviewVerdicts.filter(
    (verdict) =>
      !isMergeGateVerdict(verdict) &&
      verdict.verdict === "fail" &&
      !isSupersededLifecycleRecord(verdict),
  );
  const discoveryFindings = failedVerdicts.flatMap(
    (verdict) => verdict.discoveryFindings,
  );
  const gateFindings = failedVerdicts.flatMap(
    (verdict) => verdict.gateFindings,
  );
  const requirementIds = sortedUnique(
    gateFindings.flatMap((finding) => finding.requirementIds),
  );
  const gateScenarios = sortedUnique(
    gateFindings.map((finding) => finding.scenario),
  );
  const discoveryAxes = sortedUnique(
    discoveryFindings.flatMap((finding) => finding.scenarioAxes),
  );
  const decompositionDiscoveries = discoveryFindings.filter(
    (finding) => finding.suggestedDisposition === "planner_decomposition",
  );
  const hiddenMatrixDiscoveries = discoveryFindings.filter(
    (finding) => finding.relationship === "hidden_matrix_axis",
  );
  const lines = [
    `- Review history: ${failedVerdicts.length} failed reviewer verdict(s), ${gateFindings.length} gate finding(s), ${discoveryFindings.length} discovery finding(s).`,
  ];
  if (requirementIds.length > 0)
    lines.push(
      `- Gate requirement IDs seen across review history: ${formatList(requirementIds)}`,
    );
  if (gateScenarios.length > 0)
    lines.push(
      `- Distinct gate scenarios seen across review history: ${formatList(gateScenarios.slice(0, 12))}`,
    );
  if (discoveryAxes.length > 0)
    lines.push(
      `- Distinct discovery scenario axes: ${formatList(discoveryAxes.slice(0, 12))}`,
    );
  if (
    decompositionDiscoveries.length > 0 ||
    hiddenMatrixDiscoveries.length > 0
  ) {
    lines.push(
      `- Scope-discovery signal: ${decompositionDiscoveries.length} planner-decomposition discover${decompositionDiscoveries.length === 1 ? "y" : "ies"} and ${hiddenMatrixDiscoveries.length} hidden-matrix discover${hiddenMatrixDiscoveries.length === 1 ? "y" : "ies"} recorded by reviewers.`,
    );
  }
  if (
    failedVerdicts.length >= 2 &&
    (gateScenarios.length >= 2 || discoveryAxes.length >= 2)
  ) {
    lines.push(
      "- Deterministic scope-discovery pattern: repeated review failures cover distinct sibling scenarios or axes. Prefer under_specified_needs_decomposition when the issue contract did not explicitly enumerate this matrix.",
    );
  }
  return lines;
}

function sortedUnique(values: readonly string[]): string[] {
  return [
    ...new Set(
      values.map((value) => value.trim()).filter((value) => value.length > 0),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

function clipPromptBlock(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= PROMPT_SUMMARY_BLOCK_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, PROMPT_SUMMARY_BLOCK_MAX_CHARS - 32).trimEnd()}\n...[truncated for prompt directive]`;
}

function harnessSupportsEphemeralSystemPrompt(harness: AgentHarness): boolean {
  if (harness.capabilities?.ephemeralSystemPrompt !== undefined)
    return harness.capabilities.ephemeralSystemPrompt;
  return true;
}

function metadataForRunningEntry(entry: RunningEntry): IssueRunMetadata {
  const pointers = entry.lifecycle?.summaryPointers;
  return {
    prUrl: pointers?.prUrl ?? null,
    prNumber: pointers?.prNumber ?? null,
    prHeadSha: pointers?.prHeadSha ?? null,
    prBranch: pointers?.prBranch ?? null,
    ciStatus: pointers?.ciStatus ?? null,
    lastPushedAt: pointers?.lastPushedAt ?? null,
    lastEvidenceCursor: pointers?.lastEvidenceCursor ?? null,
    branchName:
      pointers?.branchName ??
      entry.workspace?.gitBranchName ??
      entry.issue.branchName ??
      null,
    gitBranchName:
      pointers?.gitBranchName ??
      entry.workspace?.gitBranchName ??
      entry.issue.branchName ??
      null,
    repoPath: pointers?.repoPath ?? entry.workspace?.repoPath ?? null,
    baseRef: pointers?.baseRef ?? entry.workspace?.baseRef ?? null,
  };
}

function recordActivitySource(
  entry: RunningEntry,
  source: AgentActivitySource,
  at: Date,
): void {
  if (source === "stream") {
    entry.lastStreamActivityAt = at;
  }
  if (source === "delta" || source === "tool") {
    entry.lastDeltaOrToolActivityAt = at;
  }
  if (source === "tool") {
    entry.lastToolActivityAt = at;
  }
}

function activityForEntry(entry: RunningEntry): RunActivityState {
  return {
    lastHarnessActivityAt: (entry.lastEventAt ?? entry.startedAt).toISOString(),
    lastStreamActivityAt: entry.lastStreamActivityAt?.toISOString() ?? null,
    lastDeltaOrToolActivityAt:
      entry.lastDeltaOrToolActivityAt?.toISOString() ?? null,
    lastToolActivityAt: entry.lastToolActivityAt?.toISOString() ?? null,
    unavailable: [],
  };
}

function terminalActivitySnapshot(entry: RunningEntry): RunActivitySnapshot {
  const activity = activityForEntry(entry);
  return {
    lastHarnessActivityAt: activity.lastHarnessActivityAt,
    lastStreamActivityAt: activity.lastStreamActivityAt,
    lastDeltaOrToolActivityAt: activity.lastDeltaOrToolActivityAt,
    lastToolActivityAt: activity.lastToolActivityAt,
  };
}

function formatAcceptedHandoffKind(kind: AcceptedHandoffKind): string {
  switch (kind) {
    case "completion_report":
      return "completion report";
    case "pull_request_handoff":
      return "pull request";
    case "issue_breakdown_plan":
      return "issue breakdown plan";
    case "issue_triage_report":
      return "issue triage report";
    case "issue_post_mortem_report":
      return "issue post-mortem report";
    case "merge_conflict_resolution":
      return "merge conflict resolution";
  }
}

async function fileOrDirectoryExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function safeArtifactSegment(value: string): string {
  return (
    value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "unknown"
  );
}

function safeEvidenceSegment(value: string): string {
  return (
    value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "event"
  );
}

function workerImplementationTemplateKey(
  entry: Pick<RunningEntry, "lifecycle">,
  mergeGateResult: WorkerMergeGatePromptResult | null,
  reviewVerdict: string | null,
): string {
  if (mergeGateResult?.kind === "repair")
    return "worker.implementation.merge_gate_repair";
  if (reviewVerdict !== null) return "worker.implementation.review_repair";
  if ((entry.lifecycle?.incompleteTurnCount ?? 0) > 0)
    return "worker.implementation.unsatisfied_requirements";
  return "worker.implementation.initial";
}

function terminalRunMetadata(
  entry: RunningEntry,
  terminalStatus: "succeeded" | "failed" | "cancelled",
): RunMetadata {
  const cancellationRequested = entry.cancellationRequestedAt !== null;
  const cancelIgnored = cancellationRequested && terminalStatus === "succeeded";
  const harnessStopFailed =
    cancellationRequested &&
    terminalStatus === "failed" &&
    entry.harnessStopFailedAt !== null;
  const cancelFailed = cancelIgnored || harnessStopFailed;
  const cancelFailedSource = cancelIgnored
    ? "cancel_ignored"
    : harnessStopFailed
      ? "harness_stop"
      : null;
  const cancelFailedAt = cancelIgnored
    ? (entry.lastEventAt ?? new Date()).toISOString()
    : harnessStopFailed
      ? (entry.harnessStopFailedAt?.toISOString() ?? null)
      : null;
  const cancelFailedReason = cancelIgnored
    ? "run completed after cancellation was requested"
    : harnessStopFailed
      ? entry.harnessStopFailedReason
      : null;
  return {
    cancellationRequestedAt:
      entry.cancellationRequestedAt?.toISOString() ?? null,
    cancellationSource: entry.cancellationSource,
    cancellationReason: entry.cancellationReason,
    harnessStopRequestedAt: entry.harnessStopRequestedAt?.toISOString() ?? null,
    harnessStopFailedAt: entry.harnessStopFailedAt?.toISOString() ?? null,
    harnessStopFailedReason: entry.harnessStopFailedReason,
    cancellationOutcome: !cancellationRequested
      ? "none"
      : cancelIgnored
        ? "cancel_ignored"
        : harnessStopFailed
          ? "harness_stop_failed"
          : terminalStatus === "cancelled"
            ? "cancelled"
            : "requested",
    cancelFailed,
    cancelFailedAt,
    cancelFailedReason,
    cancelFailedSource,
    activitySnapshot: terminalActivitySnapshot(entry),
    sdkRunStatus: entry.sdkRunStatus,
    sdkRunStatusObservedAt: entry.sdkRunStatusUpdatedAt?.toISOString() ?? null,
    sdkRunStatusSource: entry.sdkRunStatusSource,
    failureKind: terminalStatus === "failed" ? entry.failureKind : null,
    failureDiagnosticCode:
      terminalStatus === "failed" ? entry.failureDiagnosticCode : null,
    failureDiagnosticMessage:
      terminalStatus === "failed" ? entry.failureDiagnosticMessage : null,
    failureDiagnosticAt:
      terminalStatus === "failed"
        ? (entry.failureDiagnosticAt?.toISOString() ?? null)
        : null,
    failureDiagnosticPayload:
      terminalStatus === "failed" ? entry.failureDiagnosticPayload : null,
    providerLimit: entry.providerLimitSignal,
    ...manualDispatchRunMetadata(entry),
  };
}

function manualDispatchRunMetadata(
  entry: RunningEntry,
): Pick<
  RunMetadata,
  | "manualDispatch"
  | "manualDispatchStage"
  | "manualDispatchForceLabels"
  | "manualDispatchIgnoreState"
> {
  if (entry.manualDispatch === null) return {};
  return {
    manualDispatch: true,
    manualDispatchStage: entry.manualDispatch.stage,
    manualDispatchForceLabels: entry.manualDispatch.forceLabels,
    manualDispatchIgnoreState: entry.manualDispatch.ignoreState,
  };
}

function failureKindForDiagnostic(code: string): string {
  if (code === "cursor_run_wait_terminal_error")
    return "cursor_sdk_terminal_error";
  if (code === "cursor_run_wait_threw") return "cursor_sdk_wait_error";
  if (
    code === "cursor_stream_error" ||
    code.startsWith("cursor_stream_status_")
  )
    return "cursor_stream_error";
  return "harness_diagnostic";
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

function issueFromApprovalRequest(request: OperatorApprovalRecord): Issue {
  const title = request.action.title.startsWith(`${request.issueIdentifier}: `)
    ? request.action.title.slice(request.issueIdentifier.length + 2)
    : request.action.title;
  return {
    id: request.issueId,
    identifier: request.issueIdentifier,
    title,
    description: null,
    priority: null,
    state: "Blocked",
    branchName: request.action.branchName,
    url: null,
    assigneeId: null,
    delegateId: null,
    assignedToWorker: false,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
  };
}

function hasRecoverablePendingPublicationApproval(
  lifecycle: IssueLifecycleRecord | null,
): lifecycle is IssueLifecycleRecord {
  return pendingPublicationHandoffForRun(lifecycle) !== null;
}

function issueFromPendingPublicationLifecycle(
  lifecycle: IssueLifecycleRecord,
  state: string,
): Issue {
  const report =
    (lifecycle.lastCompletionReportId === null
      ? undefined
      : lifecycle.completionReports.find(
          (item) => item.id === lifecycle.lastCompletionReportId,
        )) ?? lifecycle.completionReports.at(-1);
  return {
    id: lifecycle.issueId,
    identifier: lifecycle.issueIdentifier,
    title: lifecycle.issueIdentifier,
    description: null,
    priority: null,
    state,
    branchName:
      report?.branchName ??
      lifecycle.summaryPointers.gitBranchName ??
      lifecycle.summaryPointers.branchName,
    url: null,
    assigneeId: null,
    delegateId: null,
    assignedToWorker: false,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
  };
}

function cancellationForEntry(entry: RunningEntry): RunCancellationState {
  return {
    requested: entry.cancellationRequestedAt !== null,
    requestedAt: entry.cancellationRequestedAt?.toISOString() ?? null,
    source: entry.cancellationSource,
    reason: entry.cancellationReason,
    abortSignalled:
      entry.abortSignalledAt !== null || entry.abortController.signal.aborted,
    harnessStopRequestedAt: entry.harnessStopRequestedAt?.toISOString() ?? null,
    harnessStopFailedAt: entry.harnessStopFailedAt?.toISOString() ?? null,
    harnessStopFailedReason: entry.harnessStopFailedReason,
    cancelFailed: liveCancelFailedForEntry(entry),
    suppressRetryOnExit: entry.suppressRetryOnExit,
  };
}

function liveCancelFailedForEntry(entry: RunningEntry): CancelFailedState {
  if (entry.harnessStopFailedAt) {
    return {
      tracked: true,
      active: true,
      phase: "failed",
      at: entry.harnessStopFailedAt.toISOString(),
      reason: entry.harnessStopFailedReason,
      source: "harness_stop",
    };
  }
  return {
    tracked: true,
    active: false,
    phase: entry.cancellationRequestedAt ? "requested" : "none",
    at: null,
    reason: null,
    source: null,
  };
}

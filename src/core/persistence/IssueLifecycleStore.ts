import { promises as fs } from "node:fs";
import path from "node:path";
import type { ServiceConfig } from "../config/Config.js";
import type { IssueBaseRefObservation } from "../BaseRefVerification.js";
import {
  LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
  normalizeProjectContextResolution,
  projectContextResolutionFromIssue,
  type ProjectContextRoutingProblemReason,
  type ProjectContextResolution,
} from "../config/ProjectContexts.js";
import { SymphonyError, errorMessage } from "../errors.js";
import type { Issue } from "../types.js";
import { mapWithFileReadConcurrency } from "./FileReadConcurrency.js";
import { ProjectionRevisionNotifier, type ProjectionChangeListener, type ProjectionChangeUnsubscribe } from "./ProjectionRevision.js";

export type IssueLifecyclePhase =
  | "implementation"
  | "merge_conflict_resolution"
  | "review"
  | "passed"
  | "blocked"
  | "terminal"
  | "unknown";

export interface IssueLifecycleSummaryPointers {
  projectContext?: ProjectContextResolution | undefined;
  workspaceKey: string | null;
  workspacePath: string | null;
  branchName: string | null;
  issueTitle?: string | null;
  gitBranchName: string | null;
  repoPath: string | null;
  baseRef: string | null;
  lastRunId: string | null;
  prUrl: string | null;
  prNumber: number | null;
  prHeadSha: string | null;
  prBranch: string | null;
  ciStatus: string | null;
  lastPushedAt: string | null;
  lastEvidenceCursor: string | null;
}

export type IssueLifecycleSummaryReferenceKind = "continuation_history" | "issue_breakdown_plan";

export interface IssueLifecycleSummaryReference {
  id: string;
  kind: IssueLifecycleSummaryReferenceKind;
  summary: string;
  planId?: string;
  runIds: string[];
  transcriptEventCount: number;
  transcriptPointers: string[];
  statusApiPointers: string[];
  issueUpdatedAt?: string | null;
  issueContentFingerprint?: string | null;
  configFingerprint?: string | null;
  cursorMode?: string | null;
  createdAt: string;
}

export type IssueLifecycleEventKind = "worker_dispatch_routing_failure";

export interface IssueLifecycleEvent {
  kind: IssueLifecycleEventKind;
  recordedAt: string;
  redacted: true;
  reason: ProjectContextRoutingProblemReason;
  safeMessage: string;
  candidateContextIds: string[];
}

export interface ProposedIssueRecord {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  dependencies: string[];
  labels: string[];
}

export type IssueBreakdownPlanApplicationStatus =
  | "not_requested"
  | "pending"
  | "applied"
  | "blocked"
  | "stale";

export interface IssueBreakdownCreatedIssueRef {
  proposedIssueIndex: number;
  operationKey: string;
  status: "created" | "verified";
  id: string;
  identifier: string | null;
  url: string | null;
}

export interface IssueBreakdownPlanRecord {
  id: string;
  idempotencyKey: string;
  requestHash: string;
  runId: string;
  issueId: string;
  issueIdentifier: string;
  projectContext?: ProjectContextResolution | undefined;
  summary: string;
  proposedIssues: ProposedIssueRecord[];
  transcriptPointers: string[];
  statusApiPointers: string[];
  issueUpdatedAt: string | null;
  issueContentFingerprint: string;
  configFingerprint: string;
  cursorMode: string;
  acceptedAt: string;
  applicationStatus: IssueBreakdownPlanApplicationStatus;
  applicationOperationKeys: string[];
  createdIssueRefs: IssueBreakdownCreatedIssueRef[];
  appliedAt: string | null;
  applicationBlockedReason: string | null;
}

export interface CompletionReportChecklistItem {
  text: string;
  satisfied: boolean;
  evidence: string | null;
}

export interface CompletionReportPullRequestRef {
  url: string | null;
  number: number | null;
  headSha: string | null;
  branch: string | null;
  draft?: boolean | null;
}

export interface CompletionReportAcceptanceContext {
  version: 1;
  capturedAt: string;
  runId: string;
  branchName: string | null;
  baseRef: string | null;
  baseHeadSha: string | null;
  worktreeHeadSha: string | null;
  treeSha: string | null;
  pullRequestHeadSha: string | null;
  worktreeDirty: boolean | null;
  worktreeStatus: "clean" | "dirty" | "unknown";
  unmergedFiles: string[] | null;
}

export type PullRequestReviewEvidenceSource = "review" | "review_comment" | "issue_comment";

export interface PullRequestReviewEvidenceItem {
  id: string;
  source: PullRequestReviewEvidenceSource;
  githubId: string;
  pullRequestNumber: number;
  pullRequestUrl: string | null;
  url: string | null;
  reviewer: string | null;
  body: string;
  state: string | null;
  path: string | null;
  line: number | null;
  originalLine: number | null;
  side: string | null;
  threadId: string | null;
  inReplyToId: string | null;
  isResolved: boolean | null;
  isOutdated: boolean | null;
  createdAt: string | null;
  updatedAt: string | null;
  submittedAt: string | null;
  cursor: string;
}

export interface PullRequestReviewEvidenceState {
  pullRequest: CompletionReportPullRequestRef | null;
  lastIngestedCursor: string | null;
  lastWorkerEvidenceCursor: string | null;
  items: PullRequestReviewEvidenceItem[];
  updatedAt: string | null;
}

export interface IssueCompletionReportRecord {
  id: string;
  idempotencyKey: string;
  runId: string;
  issueId: string;
  issueIdentifier: string;
  projectContext?: ProjectContextResolution | undefined;
  summary: string;
  validationEvidence: string[];
  acceptanceChecklist: CompletionReportChecklistItem[];
  changedFiles: string[];
  branchName: string | null;
  pullRequest: CompletionReportPullRequestRef | null;
  acceptanceContext?: CompletionReportAcceptanceContext | null;
  risks: string[];
  acceptedAt: string;
  writebackOperationKeys: string[];
}

export interface IssueCompletionReportRejectionRecord {
  id: string;
  reportId: string;
  idempotencyKey: string;
  runId: string;
  issueId: string;
  issueIdentifier: string;
  reasonCode: IssueCompletionReportRejectionReasonCode;
  reason: string;
  summary: string;
  validationEvidence: string[];
  acceptanceChecklist: CompletionReportChecklistItem[];
  changedFiles: string[];
  branchName: string | null;
  pullRequest: CompletionReportPullRequestRef | null;
  risks: string[];
  rejectedAt: string;
  writebackOperationKeys: string[];
}

export type IssueCompletionReportRejectionReasonCode =
  | "unsatisfied_acceptance_checklist"
  | "pull_request_publication_failed";

export type IssueReviewVerdict = "pass" | "fail" | "blocked";

export interface ReviewVerdictAcceptanceResult {
  text: string;
  satisfied: boolean;
  evidence: string | null;
}

export type ReviewGateScenarioEntitlement =
  | "explicit_requirement"
  | "named_acceptance_criterion"
  | "named_validation_requirement"
  | "necessary_core_behavior";

export interface ReviewGateFindingRecord {
  summary: string;
  requirementIds: string[];
  contractAnchor: string;
  scenario: string;
  scenarioEntitlement: ReviewGateScenarioEntitlement;
  observedFailure: string;
  currentIssueOwnership: string;
  boundedRepair: string;
  evidence: string[];
}

export type ReviewDiscoveryImportance = "critical" | "high" | "medium" | "low";
export type ReviewDiscoveryRelationship =
  | "implied_core"
  | "adjacent_sibling"
  | "hidden_matrix_axis"
  | "sibling_issue_scope"
  | "future_hardening"
  | "out_of_scope";
export type ReviewDiscoverySuggestedDisposition =
  | "planner_decomposition"
  | "followup_issue"
  | "operator_decision"
  | "ignore";

export interface ReviewDiscoveryFindingRecord {
  summary: string;
  importance: ReviewDiscoveryImportance;
  relationship: ReviewDiscoveryRelationship;
  discoveryReason: string;
  suggestedDisposition: ReviewDiscoverySuggestedDisposition;
  scenarioAxes: string[];
  evidence: string[];
  ownerIssueIdentifier: string | null;
}

export interface LifecycleSupersessionFields {
  supersededAt?: string | null;
  supersededBy?: string | null;
  supersededReason?: string | null;
}

export interface IssueReviewVerdictRecord extends LifecycleSupersessionFields {
  id: string;
  idempotencyKey: string;
  runId: string;
  issueId: string;
  issueIdentifier: string;
  projectContext?: ProjectContextResolution | undefined;
  verdict: IssueReviewVerdict;
  acceptanceResults: ReviewVerdictAcceptanceResult[];
  findings: string[];
  gateFindings: ReviewGateFindingRecord[];
  discoveryFindings: ReviewDiscoveryFindingRecord[];
  evidence: string[];
  reviewer: string | null;
  submittedAt: string;
  writebackOperationKeys: string[];
}

export type IssueReviewVerdictSubmissionStatus = "pending" | "applied" | "superseded";

export interface IssueReviewVerdictSubmissionRecord {
  id: string;
  idempotencyKey: string;
  runId: string;
  issueId: string;
  issueIdentifier: string;
  projectContext: ProjectContextResolution;
  verdict: IssueReviewVerdict;
  acceptanceResults: ReviewVerdictAcceptanceResult[];
  findings: string[];
  gateFindings: ReviewGateFindingRecord[];
  discoveryFindings: ReviewDiscoveryFindingRecord[];
  evidence: string[];
  reviewer: string | null;
  submittedAt: string;
  status: IssueReviewVerdictSubmissionStatus;
  ignoreStateGate: boolean;
  appliedAt: string | null;
  acceptedVerdictId: string | null;
  supersededAt: string | null;
  supersededReason: string | null;
}

export type PullRequestReviewFeedbackKind = "review" | "review_comment" | "issue_comment";
export type PullRequestReviewFeedbackEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export interface IssueReviewFeedbackRecord {
  id: string;
  idempotencyKey: string;
  requestHash: string;
  runId: string;
  issueId: string;
  issueIdentifier: string;
  projectContext?: ProjectContextResolution | undefined;
  kind: PullRequestReviewFeedbackKind;
  event: PullRequestReviewFeedbackEvent | null;
  body: string;
  pullRequest: CompletionReportPullRequestRef;
  reviewer: string | null;
  reviewUrl: string | null;
  commentUrls: string[];
  submittedAt: string;
}

export type IssueTriageDisposition =
  | "decompose_issue"
  | "implementation_repair"
  | "validation_repair"
  | "compatibility_matrix_repair"
  | "retarget_or_split_pr"
  | "close_or_retarget_issue"
  | "merge_gate_repair"
  | "process_gate_repair"
  | "infra_repair"
  | "orchestrator_context_repair"
  | "manual_decision";

export type IssueTriageConfidence = "high" | "medium" | "low";
export type IssueTriageBlockerKind =
  | "under_specified_needs_decomposition"
  | "implementation_unsatisfied_requirements"
  | "validation_or_test_failure"
  | "compatibility_matrix_gap"
  | "orchestrator_context_or_prompt_gap"
  | "infra_or_tooling_failure"
  | "pr_target_or_scope_mismatch"
  | "merge_conflict"
  | "merge_gate_check_failure"
  | "pr_review_gate"
  | "manual_decision";
export type IssueTriageBlockerStatus = "active" | "downstream";
export type IssueTriageBlockerNextActor =
  | "planner"
  | "worker"
  | "reviewer"
  | "merge_conflict_worker"
  | "operator"
  | "orchestrator"
  | "infra";

export interface IssueTriageBlockerRecord {
  kind: IssueTriageBlockerKind;
  status: IssueTriageBlockerStatus;
  nextActor: IssueTriageBlockerNextActor;
  confidence: IssueTriageConfidence;
  summary: string;
  evidence: string[];
  recommendedAction: string;
}

export interface IssueTriageReportRecord extends LifecycleSupersessionFields {
  id: string;
  idempotencyKey: string;
  requestHash: string;
  runId: string;
  issueId: string;
  issueIdentifier: string;
  triggerFingerprint: string;
  disposition: IssueTriageDisposition;
  confidence: IssueTriageConfidence;
  summary: string;
  evidence: string[];
  recommendedAction: string;
  blockers: IssueTriageBlockerRecord[];
  submittedAt: string;
  writebackOperationKeys: string[];
}

export type IssuePostMortemCompletionStatus = "valid_done" | "valid_with_followups" | "questionable_done";
export type IssuePostMortemSpecificationQuality = "strong" | "adequate" | "weak";
export type IssuePostMortemSpecificationClassification =
  | "well_scoped"
  | "underspecified"
  | "overbroad"
  | "speckit_candidate"
  | "needs_clarification";
export type IssuePostMortemFollowUpPriority = "high" | "medium" | "low";
export type IssuePostMortemFollowUpKind = "hardening" | "test_gap" | "scope_gap" | "refactor" | "process_gap";

export interface IssuePostMortemCompletionJudgmentRecord {
  status: IssuePostMortemCompletionStatus;
  rationale: string;
}

export interface IssuePostMortemSpecificationAssessmentRecord {
  quality: IssuePostMortemSpecificationQuality;
  classifications: IssuePostMortemSpecificationClassification[];
  missingContractAreas: string[];
  speckitRecommended: boolean;
  speckitRationale: string;
}

export interface IssuePostMortemReviewAssessmentRecord {
  gateDecisionLooksValid: boolean;
  missedGateFindings: string[];
  missedDiscoveryFindings: string[];
}

export interface IssuePostMortemFollowUpCandidateRecord {
  title: string;
  priority: IssuePostMortemFollowUpPriority;
  kind: IssuePostMortemFollowUpKind;
  rationale: string;
  readyForSpecKit: boolean;
  suggestedIssueContract: string | null;
}

export interface IssuePostMortemReportRecord {
  id: string;
  idempotencyKey: string;
  requestHash: string;
  runId: string;
  issueId: string;
  issueIdentifier: string;
  triggerFingerprint: string;
  summary: string;
  completionJudgment: IssuePostMortemCompletionJudgmentRecord;
  specificationAssessment: IssuePostMortemSpecificationAssessmentRecord;
  reviewAssessment: IssuePostMortemReviewAssessmentRecord;
  followUpCandidates: IssuePostMortemFollowUpCandidateRecord[];
  processLessons: string[];
  submittedAt: string;
  writebackOperationKeys: string[];
}

export interface IssueMergeMetadata {
  id: string;
  pullRequest: CompletionReportPullRequestRef;
  headSha: string;
  mergeCommitSha: string;
  mergedAt: string;
  mergedBy: {
    login: string | null;
    profile: string | null;
    capability: "github.merge";
  };
  checkStatus: {
    requiredChecks: string[];
    passedChecks: string[];
    noCiEvidence: string | null;
  };
  mergeOperationKey: string;
  doneTransitionOperationKey: string;
}

export type IssueMergeGateStatus = "observing" | "repair_dispatched" | "blocked" | "resolved" | "superseded";
export type IssueMergeGateCheckOutcome =
  | "passing"
  | "pending"
  | "missing_observed"
  | "missing_actionable"
  | "failing"
  | "unknown";
export type IssueMergeGateRawCheckStatus = "success" | "failure" | "pending" | "missing" | "unknown";
export type IssueMergeGateMergeabilityStatus = "mergeable" | "conflicted" | "unknown" | "blocked";

export interface IssueMergeGateCheckState {
  name: string;
  outcome: IssueMergeGateCheckOutcome;
  rawStatus: IssueMergeGateRawCheckStatus;
  conclusion: string | null;
  url: string | null;
  firstObservedAt: string | null;
  actionableSince: string | null;
}

export interface IssueMergeGateMergeabilityState {
  status: IssueMergeGateMergeabilityStatus;
  pullRequest: CompletionReportPullRequestRef;
  mergeable: boolean | null;
  mergeableState: string | null;
  reason: string | null;
  baseBranch: string | null;
  baseHeadSha: string | null;
  observedBaseHeadSha: string | null;
  checkedAt: string;
}

export interface IssueMergeGateState {
  id: string;
  status: IssueMergeGateStatus;
  headSha: string;
  pullRequest: CompletionReportPullRequestRef;
  requiredChecks: string[];
  checks: IssueMergeGateCheckState[];
  mergeability: IssueMergeGateMergeabilityState | null;
  reviewRound: number;
  gateRunId: string | null;
  gateReportId: string | null;
  repairRunId: string | null;
  repairReportId: string | null;
  blockerFingerprint: string | null;
  writebackOperationKeys: string[];
  supersededByHeadSha: string | null;
  updatedAt: string;
}

export type IssueMergeGateResultStatus = "repair_dispatched" | "blocked";

export interface IssueMergeGateResultRecord extends LifecycleSupersessionFields {
  id: string;
  idempotencyKey: string;
  runId: string;
  issueId: string;
  issueIdentifier: string;
  status: IssueMergeGateResultStatus;
  headSha: string;
  pullRequest: CompletionReportPullRequestRef;
  requiredChecks: string[];
  checks: IssueMergeGateCheckState[];
  mergeability: IssueMergeGateMergeabilityState | null;
  reviewRound: number;
  blockerFingerprint: string | null;
  findings: string[];
  evidence: string[];
  submittedAt: string;
  writebackOperationKeys: string[];
}

export type IssueMergeConflictResolutionStatus = "pending" | "still_conflicted" | "resolved" | "blocked";

export type IssuePreservedWorktreeStashSource =
  | "base_ref_repair"
  | "service_conflict_prepare"
  | "service_conflict_base_refresh"
  | "prepared_base_drift";

export type IssuePreservedWorktreeStashStatus =
  | "created"
  | "applied_clean"
  | "apply_conflicted"
  | "finalized"
  | "dropped"
  | "drop_failed";

export interface IssuePreservedWorktreeStash {
  version: 1;
  id: string;
  operationId: string;
  source: IssuePreservedWorktreeStashSource;
  stashRef: string;
  stashSha: string;
  message: string;
  workspacePath: string;
  branchName: string;
  baseBranch: string | null;
  originalHeadSha: string;
  dirtyFiles: string[];
  status: IssuePreservedWorktreeStashStatus;
  conflictedFiles: string[];
  createdAt: string;
  appliedAt: string | null;
  droppedAt: string | null;
  dropError: string | null;
}

export interface IssueSquashRebaseMergeConflictServicePreparation {
  strategy: "squash_rebase";
  status: "conflicted" | "clean" | "finalized";
  originalHeadSha: string;
  observedPrBaseHeadSha: string | null;
  liveBaseHeadSha: string;
  preparedBaseHeadSha: string;
  mergeBaseSha: string;
  squashCommitSha: string | null;
  conflictedFiles: string[];
  preparedAt: string;
  finalizedAt: string | null;
  finalizedHeadSha: string | null;
  preservedStash?: IssuePreservedWorktreeStash | null;
}

export interface IssueStashApplyMergeConflictServicePreparation {
  strategy: "stash_apply";
  status: "conflicted" | "finalized";
  originalHeadSha: string;
  currentHeadSha: string;
  conflictedFiles: string[];
  allowedFiles: string[];
  preservedStash: IssuePreservedWorktreeStash;
  preparedAt: string;
  finalizedAt: string | null;
  finalizedHeadSha: string | null;
}

export type IssueMergeConflictServicePreparation =
  | IssueSquashRebaseMergeConflictServicePreparation
  | IssueStashApplyMergeConflictServicePreparation;

export interface IssueMergeConflictResolutionReportRecord {
  id: string;
  idempotencyKey: string;
  runId: string;
  issueId: string;
  issueIdentifier: string;
  projectContext?: ProjectContextResolution | undefined;
  resolutionStatus: "resolved" | "still_conflicted" | "blocked";
  summary: string;
  validationEvidence: string[];
  changedFiles: string[];
  pullRequest: CompletionReportPullRequestRef;
  previousHeadSha: string | null;
  newHeadSha: string | null;
  baseBranch: string | null;
  baseHeadSha: string | null;
  blockedReason: string | null;
  risks: string[];
  submittedAt: string;
}

export interface IssueMergeConflictMetadata {
  id: string;
  status: "open" | "resolved" | "blocked";
  resolutionStatus: IssueMergeConflictResolutionStatus;
  pullRequest: CompletionReportPullRequestRef;
  approvedHeadSha: string;
  currentHeadSha: string;
  resolvedHeadSha: string | null;
  baseBranch: string | null;
  baseHeadSha: string | null;
  sourceState: string;
  conflictsState: string;
  reason: string;
  mergeableState: string | null;
  servicePreparation: IssueMergeConflictServicePreparation | null;
  detectedAt: string;
  updatedAt: string;
  fixTurnCount: number;
  maxFixTurns: number;
  lastConflictFixRunId: string | null;
  lastConflictResolutionReportId: string | null;
  attemptRunIds: string[];
  writebackOperationKeys: string[];
  blockedAt: string | null;
  blockedReason: string | null;
}

export interface IssueWorkerOutputContract {
  version: 1;
  reportId: string;
  runId: string;
  summary: string;
  changedFiles: string[];
  validationEvidence: string[];
  risks: string[];
  pullRequest: CompletionReportPullRequestRef | null;
  acceptedAt: string;
}

export interface IssueReviewerOutputContract {
  version: 1;
  verdictId: string;
  runId: string;
  verdict: IssueReviewVerdict;
  findings: string[];
  gateFindings: ReviewGateFindingRecord[];
  discoveryFindings: ReviewDiscoveryFindingRecord[];
  acceptanceResults: ReviewVerdictAcceptanceResult[];
  evidence: string[];
  submittedAt: string;
}

export interface IssueLaneMemo {
  version: 1;
  issueId: string;
  issueIdentifier: string;
  projectContext?: ProjectContextResolution | undefined;
  updatedAt: string;
  reviewRound: number;
  incompleteTurnCount: number;
  sizeChars: number;
  entries: string[];
  openFindings: string[];
  pointers: IssueLifecycleSummaryPointers;
  lastWorkerRunId: string | null;
  lastReviewerRunId: string | null;
}

export interface IssueHandoffState {
  version: 1;
  memo: IssueLaneMemo;
  lastWorkerOutput: IssueWorkerOutputContract | null;
  lastReviewerOutput: IssueReviewerOutputContract | null;
}

export interface WorkerHandoffPacket {
  version: 1;
  issueId: string;
  issueIdentifier: string;
  projectContext?: ProjectContextResolution | undefined;
  generatedAt: string;
  memo: IssueLaneMemo;
  lastWorkerOutput: IssueWorkerOutputContract | null;
  lastCompletionReportRejection: IssueCompletionReportRejectionRecord | null;
  lastReviewerOutput: IssueReviewerOutputContract | null;
  pointers: IssueLifecycleSummaryPointers;
}

export interface IssueLifecycleRecord {
  issueId: string;
  issueIdentifier: string;
  projectContext?: ProjectContextResolution | undefined;
  phase: IssueLifecyclePhase;
  reviewRound: number;
  incompleteTurnCount: number;
  lastIssueBreakdownPlanId: string | null;
  planningFailureCount: number;
  planningDispatchRetryCount: number;
  lastPlanningFailureRunId: string | null;
  lastPlanningFailureAt: string | null;
  lastIssueTriageReportId: string | null;
  lastPostMortemReportId: string | null;
  lastCompletionReportId: string | null;
  lastCompletionReportRejectionId: string | null;
  lastReviewVerdictId: string | null;
  lastMergeGateResultId?: string | null;
  blockedReason: string | null;
  events: IssueLifecycleEvent[];
  summaryPointers: IssueLifecycleSummaryPointers;
  summaryReferences: IssueLifecycleSummaryReference[];
  issueBreakdownPlans: IssueBreakdownPlanRecord[];
  completionReports: IssueCompletionReportRecord[];
  completionReportRejections: IssueCompletionReportRejectionRecord[];
  reviewVerdicts: IssueReviewVerdictRecord[];
  reviewVerdictSubmissions?: IssueReviewVerdictSubmissionRecord[];
  mergeGateResults?: IssueMergeGateResultRecord[];
  reviewFeedback: IssueReviewFeedbackRecord[];
  issueTriageReports: IssueTriageReportRecord[];
  postMortemReports: IssuePostMortemReportRecord[];
  reviewEvidence: PullRequestReviewEvidenceState;
  baseRefObservation?: IssueBaseRefObservation | null;
  mergeGate?: IssueMergeGateState | null;
  merge: IssueMergeMetadata | null;
  mergeConflict: IssueMergeConflictMetadata | null;
  mergeConflictResolutionReports: IssueMergeConflictResolutionReportRecord[];
  preservedWorktreeStashes?: IssuePreservedWorktreeStash[];
  handoff: IssueHandoffState;
  createdAt: string;
  updatedAt: string;
}

export interface IssueLifecyclePatch {
  projectContext?: ProjectContextResolution | undefined;
  phase?: IssueLifecyclePhase;
  reviewRound?: number;
  incompleteTurnCount?: number;
  lastIssueBreakdownPlanId?: string | null;
  planningFailureCount?: number;
  planningDispatchRetryCount?: number;
  lastPlanningFailureRunId?: string | null;
  lastPlanningFailureAt?: string | null;
  lastIssueTriageReportId?: string | null;
  lastPostMortemReportId?: string | null;
  lastCompletionReportId?: string | null;
  lastCompletionReportRejectionId?: string | null;
  lastReviewVerdictId?: string | null;
  lastMergeGateResultId?: string | null;
  blockedReason?: string | null;
  events?: IssueLifecycleEvent[];
  summaryPointers?: Partial<IssueLifecycleSummaryPointers>;
  summaryReferences?: IssueLifecycleSummaryReference[];
  issueBreakdownPlans?: IssueBreakdownPlanRecord[];
  completionReports?: IssueCompletionReportRecord[];
  completionReportRejections?: IssueCompletionReportRejectionRecord[];
  reviewVerdicts?: IssueReviewVerdictRecord[];
  reviewVerdictSubmissions?: IssueReviewVerdictSubmissionRecord[];
  mergeGateResults?: IssueMergeGateResultRecord[];
  reviewFeedback?: IssueReviewFeedbackRecord[];
  issueTriageReports?: IssueTriageReportRecord[];
  postMortemReports?: IssuePostMortemReportRecord[];
  reviewEvidence?: PullRequestReviewEvidenceState;
  baseRefObservation?: IssueBaseRefObservation | null;
  mergeGate?: IssueMergeGateState | null;
  merge?: IssueMergeMetadata | null;
  mergeConflict?: IssueMergeConflictMetadata | null;
  mergeConflictResolutionReports?: IssueMergeConflictResolutionReportRecord[];
  preservedWorktreeStashes?: IssuePreservedWorktreeStash[];
  handoff?: IssueHandoffState;
}

export type IssueLifecycleStore = FileIssueLifecycleStore;

export class FileIssueLifecycleStore {
  private readonly projectionNotifier = new ProjectionRevisionNotifier();

  constructor(private readonly stateDir: string) {}

  projectionRevision(): number {
    return this.projectionNotifier.currentRevision();
  }

  onProjectionChanged(listener: ProjectionChangeListener): ProjectionChangeUnsubscribe {
    return this.projectionNotifier.subscribe(listener);
  }

  async ensureIssue(issue: Pick<Issue, "id" | "identifier">, patch: IssueLifecyclePatch = {}): Promise<IssueLifecycleRecord> {
    const existing = await this.find(issue.id, issue.identifier);
    const now = new Date().toISOString();
    const projectContext = normalizeProjectContextResolution(
      patch.projectContext ?? existing?.projectContext ?? projectContextResolutionFromIssue(issue),
    );
    const baseRecord = {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      projectContext,
      phase: patch.phase ?? existing?.phase ?? "implementation",
      reviewRound: patch.reviewRound ?? existing?.reviewRound ?? 0,
      incompleteTurnCount: patch.incompleteTurnCount ?? existing?.incompleteTurnCount ?? 0,
      lastIssueBreakdownPlanId: patchValue(
        patch,
        "lastIssueBreakdownPlanId",
        existing?.lastIssueBreakdownPlanId ?? null,
      ),
      planningFailureCount: patch.planningFailureCount ?? existing?.planningFailureCount ?? 0,
      planningDispatchRetryCount: patch.planningDispatchRetryCount ?? existing?.planningDispatchRetryCount ?? 0,
      lastPlanningFailureRunId: patchValue(
        patch,
        "lastPlanningFailureRunId",
        existing?.lastPlanningFailureRunId ?? null,
      ),
      lastPlanningFailureAt: patchValue(patch, "lastPlanningFailureAt", existing?.lastPlanningFailureAt ?? null),
      lastIssueTriageReportId: patchValue(
        patch,
        "lastIssueTriageReportId",
        existing?.lastIssueTriageReportId ?? null,
      ),
      lastPostMortemReportId: patchValue(
        patch,
        "lastPostMortemReportId",
        existing?.lastPostMortemReportId ?? null,
      ),
      lastCompletionReportId: patchValue(patch, "lastCompletionReportId", existing?.lastCompletionReportId ?? null),
      lastCompletionReportRejectionId: patchValue(
        patch,
        "lastCompletionReportRejectionId",
        existing?.lastCompletionReportRejectionId ?? null,
      ),
      lastReviewVerdictId: patchValue(patch, "lastReviewVerdictId", existing?.lastReviewVerdictId ?? null),
      lastMergeGateResultId: patchValue(patch, "lastMergeGateResultId", existing?.lastMergeGateResultId ?? null),
      blockedReason: patchValue(patch, "blockedReason", existing?.blockedReason ?? null),
      events: patch.events ?? existing?.events ?? [],
      summaryPointers: {
        ...defaultSummaryPointers(),
        ...existing?.summaryPointers,
        ...patch.summaryPointers,
        projectContext,
      },
      summaryReferences: patch.summaryReferences ?? existing?.summaryReferences ?? [],
      issueBreakdownPlans: patch.issueBreakdownPlans ?? existing?.issueBreakdownPlans ?? [],
      completionReports: patch.completionReports ?? existing?.completionReports ?? [],
      completionReportRejections: patch.completionReportRejections ?? existing?.completionReportRejections ?? [],
      reviewVerdicts: patch.reviewVerdicts ?? existing?.reviewVerdicts ?? [],
      reviewVerdictSubmissions:
        patch.reviewVerdictSubmissions ?? existing?.reviewVerdictSubmissions ?? [],
      mergeGateResults: patch.mergeGateResults ?? existing?.mergeGateResults ?? [],
      reviewFeedback: patch.reviewFeedback ?? existing?.reviewFeedback ?? [],
      issueTriageReports: patch.issueTriageReports ?? existing?.issueTriageReports ?? [],
      postMortemReports: patch.postMortemReports ?? existing?.postMortemReports ?? [],
      reviewEvidence: patch.reviewEvidence ?? existing?.reviewEvidence ?? defaultReviewEvidence(),
      baseRefObservation: patchValue(patch, "baseRefObservation", existing?.baseRefObservation ?? null),
      mergeGate: patchValue(patch, "mergeGate", existing?.mergeGate ?? null),
      merge: patchValue(patch, "merge", existing?.merge ?? null),
      mergeConflict: patchValue(patch, "mergeConflict", existing?.mergeConflict ?? null),
      mergeConflictResolutionReports:
        patch.mergeConflictResolutionReports ?? existing?.mergeConflictResolutionReports ?? [],
      preservedWorktreeStashes:
        patch.preservedWorktreeStashes ?? existing?.preservedWorktreeStashes ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const record: IssueLifecycleRecord = {
      ...baseRecord,
      handoff: patch.handoff ?? buildIssueHandoffState(baseRecord),
    };
    await this.write(record);
    this.notifyProjectionChanged();
    return record;
  }

  async updateIssue(
    issue: Pick<Issue, "id" | "identifier">,
    patch: IssueLifecyclePatch,
  ): Promise<IssueLifecycleRecord> {
    return this.ensureIssue(issue, patch);
  }

  async get(issueIdOrIdentifier: string): Promise<IssueLifecycleRecord | null> {
    const direct = await readLifecycleJsonIfExists(this.recordPath(issueIdOrIdentifier));
    if (direct?.issueId === issueIdOrIdentifier) return direct;
    const records = direct ? dedupeIssueLifecycleRecords([direct, ...(await this.list())]) : await this.list();
    const exactIssueIdMatch = records.find((record) => record.issueId === issueIdOrIdentifier);
    if (exactIssueIdMatch) return exactIssueIdMatch;
    const identifierMatches = records.filter((record) => record.issueIdentifier === issueIdOrIdentifier);
    return identifierMatches.length === 1 ? identifierMatches[0] ?? null : null;
  }

  async list(): Promise<IssueLifecycleRecord[]> {
    await fs.mkdir(this.recordsDir(), { recursive: true });
    const entries = await fs.readdir(this.recordsDir());
    const records = await mapWithFileReadConcurrency(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => path.join(this.recordsDir(), entry)),
      (filePath) => readLifecycleJsonIfExists(filePath),
    );
    return records.filter((record): record is IssueLifecycleRecord => record !== null);
  }

  private async find(issueId: string, issueIdentifier: string): Promise<IssueLifecycleRecord | null> {
    const direct = await this.get(issueId);
    if (direct) return direct;
    const byIdentifier = await this.get(issueIdentifier);
    return byIdentifier?.issueId === issueId ? byIdentifier : null;
  }

  private async write(record: IssueLifecycleRecord): Promise<void> {
    await fs.mkdir(this.recordsDir(), { recursive: true });
    const target = this.recordPath(record.issueId);
    const temp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await renameLifecycleRecord(temp, target);
  }

  private notifyProjectionChanged(): void {
    this.projectionNotifier.notify("lifecycle");
  }

  private recordsDir(): string {
    return path.join(this.stateDir, "issue-lifecycle");
  }

  private recordPath(issueIdOrIdentifier: string): string {
    return path.join(this.recordsDir(), `${safeFileName(issueIdOrIdentifier)}.json`);
  }
}

async function renameLifecycleRecord(temp: string, target: string): Promise<void> {
  const attempts = process.platform === "win32" ? 5 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (process.platform === "win32") {
        await fs.rm(target, { force: true });
      }
      await fs.rename(temp, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable = process.platform === "win32" && (code === "EPERM" || code === "EACCES") && attempt < attempts - 1;
      if (!retryable) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
}

export function phaseForIssueState(state: string, config: ServiceConfig): IssueLifecyclePhase {
  if (config.mergePolicy.mode === "gated" && config.mergePolicy.conflictsState !== null && statesEqual(state, config.mergePolicy.conflictsState)) {
    return "merge_conflict_resolution";
  }
  if (isStateIn(state, config.reviewLoop.blockedStates)) return "blocked";
  if (isStateIn(state, config.tracker.handoffStates)) return "review";
  if (isStateIn(state, config.reviewLoop.reviewStates)) return "review";
  if (config.reviewLoop.reviewPassState && statesEqual(state, config.reviewLoop.reviewPassState)) return "passed";
  if (isStateIn(state, config.tracker.terminalStates)) return "terminal";
  if (isStateIn(state, config.tracker.activeStates)) return "implementation";
  return "unknown";
}

export function isSupersededLifecycleRecord(record: LifecycleSupersessionFields | null | undefined): boolean {
  return typeof record?.supersededAt === "string" && record.supersededAt.trim().length > 0;
}

export function buildWorkerHandoffPacket(
  record: IssueLifecycleRecord,
  generatedAt = new Date().toISOString(),
): WorkerHandoffPacket {
  return {
    version: 1,
    issueId: record.issueId,
    issueIdentifier: record.issueIdentifier,
    projectContext: normalizeProjectContextResolution(record.projectContext),
    generatedAt,
    memo: record.handoff.memo,
    lastWorkerOutput: record.handoff.lastWorkerOutput,
    lastCompletionReportRejection: latestCompletionReportRejection(record),
    lastReviewerOutput: record.handoff.lastReviewerOutput,
    pointers: record.summaryPointers,
  };
}

export function buildIssueHandoffState(record: Omit<IssueLifecycleRecord, "handoff">): IssueHandoffState {
  const lastWorkerOutput = workerOutputFromReport(latestCompletionReport(record));
  const lastReviewerOutput = reviewerOutputFromVerdict(latestHumanReviewVerdict(record));
  return {
    version: 1,
    memo: buildLaneMemo(record, lastWorkerOutput, lastReviewerOutput),
    lastWorkerOutput,
    lastReviewerOutput,
  };
}

function buildLaneMemo(
  record: Omit<IssueLifecycleRecord, "handoff">,
  lastWorkerOutput: IssueWorkerOutputContract | null,
  lastReviewerOutput: IssueReviewerOutputContract | null,
): IssueLaneMemo {
  const openFindings = lastReviewerOutput?.verdict === "fail" ? lastReviewerOutput.findings.slice(0, 8) : [];
  const mergeGateEntry = mergeGateMemoEntry(record);
  const lastCompletionReportRejection = latestCompletionReportRejection(record);
  const acceptedDecisions = [
    ...(lastReviewerOutput?.verdict === "pass"
      ? lastReviewerOutput.acceptanceResults
          .filter((result) => result.satisfied)
          .map((result) => `Accepted by reviewer: ${clip(result.text)}`)
      : []),
    ...(record.merge ? [`Merged PR ${record.merge.pullRequest.number === null ? record.merge.pullRequest.url : `#${record.merge.pullRequest.number}`}.`] : []),
    ...(record.mergeConflict
      ? [
          `Merge conflict status: ${record.mergeConflict.resolutionStatus}; attempts ${record.mergeConflict.fixTurnCount}/${record.mergeConflict.maxFixTurns}.`,
        ]
      : []),
    ...record.reviewEvidence.items
      .filter((item) => item.isResolved === true && item.isOutdated !== true)
      .slice(0, 4)
      .map((item) => `Resolved PR evidence: ${clip(item.body)}`),
  ];
  const entries = [
    `Lifecycle phase: ${record.phase}; review round: ${record.reviewRound}; incomplete worker turns: ${record.incompleteTurnCount}.`,
    lastWorkerOutput
      ? `Latest worker output ${lastWorkerOutput.reportId} (${lastWorkerOutput.runId}): ${clip(lastWorkerOutput.summary)}`
      : "No accepted worker output is available yet.",
    ...(lastCompletionReportRejection === null
      ? []
      : [
          `Latest completion report rejection ${lastCompletionReportRejection.id} (${lastCompletionReportRejection.runId}): ${clip(lastCompletionReportRejection.reason)}`,
        ]),
    lastReviewerOutput
      ? `Latest reviewer output ${lastReviewerOutput.verdictId} (${lastReviewerOutput.runId}): ${lastReviewerOutput.verdict}.`
      : "No reviewer output is available yet.",
    ...(mergeGateEntry === null ? [] : [mergeGateEntry]),
    ...acceptedDecisions.map((decision) => clip(decision)),
    ...openFindings.map((finding) => `Open reviewer finding: ${clip(finding)}`),
  ].slice(0, 12);
  const memoWithoutSize = {
    version: 1 as const,
    issueId: record.issueId,
    issueIdentifier: record.issueIdentifier,
    projectContext: normalizeProjectContextResolution(record.projectContext),
    updatedAt: record.updatedAt,
    reviewRound: record.reviewRound,
    incompleteTurnCount: record.incompleteTurnCount,
    entries,
    openFindings,
    pointers: record.summaryPointers,
    lastWorkerRunId: lastWorkerOutput?.runId ?? null,
    lastReviewerRunId: lastReviewerOutput?.runId ?? null,
  };
  return {
    ...memoWithoutSize,
    sizeChars: JSON.stringify(memoWithoutSize).length,
  };
}

function latestCompletionReport(
  record: Pick<IssueLifecycleRecord, "completionReports" | "lastCompletionReportId">,
): IssueCompletionReportRecord | null {
  if (record.lastCompletionReportId) {
    return record.completionReports.find((report) => report.id === record.lastCompletionReportId) ?? null;
  }
  return record.completionReports.at(-1) ?? null;
}

function latestCompletionReportRejection(
  record: Pick<IssueLifecycleRecord, "completionReportRejections" | "lastCompletionReportRejectionId">,
): IssueCompletionReportRejectionRecord | null {
  if (record.lastCompletionReportRejectionId) {
    return record.completionReportRejections.find((rejection) => rejection.id === record.lastCompletionReportRejectionId) ?? null;
  }
  return record.completionReportRejections.at(-1) ?? null;
}

export function latestCurrentApprovalPassVerdict(
  record: Pick<
    IssueLifecycleRecord,
    | "issueId"
    | "issueIdentifier"
    | "completionReports"
    | "lastCompletionReportId"
    | "reviewVerdicts"
    | "reviewFeedback"
    | "summaryPointers"
  >,
): IssueReviewVerdictRecord | null {
  const pullRequest = currentPullRequestForReview(record);
  if (!pullRequest) return latestHumanPassVerdict(record);
  for (const verdict of record.reviewVerdicts.slice().reverse()) {
    if (isSupersededLifecycleRecord(verdict)) continue;
    if (!isHumanPassVerdictForIssue(record, verdict)) continue;
    if (hasApprovalFeedback(record, verdict, pullRequest) || !hasAnyApprovalFeedbackForRun(record, verdict)) return verdict;
  }
  return null;
}

function latestReviewVerdict(
  record: Pick<IssueLifecycleRecord, "reviewVerdicts" | "lastReviewVerdictId">,
): IssueReviewVerdictRecord | null {
  if (record.lastReviewVerdictId) {
    const exact = record.reviewVerdicts.find((verdict) => verdict.id === record.lastReviewVerdictId);
    if (exact && !isSupersededLifecycleRecord(exact)) return exact;
  }
  for (const verdict of record.reviewVerdicts.slice().reverse()) {
    if (!isSupersededLifecycleRecord(verdict)) return verdict;
  }
  return null;
}

function latestHumanReviewVerdict(
  record: Pick<
    IssueLifecycleRecord,
    | "issueId"
    | "issueIdentifier"
    | "completionReports"
    | "lastCompletionReportId"
    | "reviewVerdicts"
    | "reviewFeedback"
    | "lastReviewVerdictId"
    | "summaryPointers"
  >,
): IssueReviewVerdictRecord | null {
  const pointed = latestReviewVerdict(record);
  if (pointed && !isMergeGateVerdict(pointed) && isCurrentHumanVerdict(record, pointed)) return pointed;
  for (const verdict of record.reviewVerdicts.slice().reverse()) {
    if (isSupersededLifecycleRecord(verdict)) continue;
    if (!isMergeGateVerdict(verdict) && isCurrentHumanVerdict(record, verdict)) return verdict;
  }
  return null;
}

function latestHumanPassVerdict(
  record: Pick<IssueLifecycleRecord, "issueId" | "issueIdentifier" | "reviewVerdicts">,
): IssueReviewVerdictRecord | null {
  for (const verdict of record.reviewVerdicts.slice().reverse()) {
    if (isSupersededLifecycleRecord(verdict)) continue;
    if (isHumanPassVerdictForIssue(record, verdict)) return verdict;
  }
  return null;
}

function isCurrentHumanVerdict(
  record: Pick<
    IssueLifecycleRecord,
    | "issueId"
    | "issueIdentifier"
    | "completionReports"
    | "lastCompletionReportId"
    | "reviewFeedback"
    | "summaryPointers"
  >,
  verdict: IssueReviewVerdictRecord,
): boolean {
  if (verdict.issueId !== record.issueId || verdict.issueIdentifier !== record.issueIdentifier) return false;
  if (verdict.verdict !== "pass") return true;
  const pullRequest = currentPullRequestForReview(record);
  return pullRequest === null || hasApprovalFeedback(record, verdict, pullRequest) || !hasAnyApprovalFeedbackForRun(record, verdict);
}

function isHumanPassVerdictForIssue(
  record: Pick<IssueLifecycleRecord, "issueId" | "issueIdentifier">,
  verdict: IssueReviewVerdictRecord,
): boolean {
  return (
    verdict.verdict === "pass" &&
    !isMergeGateVerdict(verdict) &&
    !isSupersededLifecycleRecord(verdict) &&
    verdict.issueId === record.issueId &&
    verdict.issueIdentifier === record.issueIdentifier
  );
}

function currentPullRequestForReview(
  record: Pick<IssueLifecycleRecord, "completionReports" | "lastCompletionReportId" | "summaryPointers">,
): CompletionReportPullRequestRef | null {
  const reportPullRequest = latestCompletionReport(record)?.pullRequest ?? null;
  const pointerPullRequest =
    record.summaryPointers.prNumber !== null && record.summaryPointers.prUrl !== null && record.summaryPointers.prHeadSha !== null
      ? {
          number: record.summaryPointers.prNumber,
          url: record.summaryPointers.prUrl,
          headSha: record.summaryPointers.prHeadSha,
          branch: record.summaryPointers.prBranch,
        }
      : null;
  if (
    pointerPullRequest &&
    reportPullRequest &&
    pointerPullRequest.number === reportPullRequest.number &&
    pointerPullRequest.headSha !== reportPullRequest.headSha
  ) {
    return pointerPullRequest;
  }
  return reportPullRequest ?? pointerPullRequest;
}

function hasApprovalFeedback(
  record: Pick<IssueLifecycleRecord, "reviewFeedback">,
  verdict: IssueReviewVerdictRecord,
  pullRequest: CompletionReportPullRequestRef,
): boolean {
  return record.reviewFeedback.some(
    (feedback) =>
      feedback.runId === verdict.runId &&
      feedback.kind === "review" &&
      feedback.event === "APPROVE" &&
      feedback.pullRequest.number === pullRequest.number &&
      feedback.pullRequest.url === pullRequest.url &&
      feedback.pullRequest.headSha === pullRequest.headSha,
  );
}

function hasAnyApprovalFeedbackForRun(
  record: Pick<IssueLifecycleRecord, "reviewFeedback">,
  verdict: IssueReviewVerdictRecord,
): boolean {
  return record.reviewFeedback.some(
    (feedback) => feedback.runId === verdict.runId && feedback.kind === "review" && feedback.event === "APPROVE",
  );
}

function isMergeGateVerdict(verdict: IssueReviewVerdictRecord): boolean {
  return verdict.reviewer === "symphony-merge-gate" || verdict.id.startsWith("merge-gate:");
}

function mergeGateMemoEntry(record: Pick<IssueLifecycleRecord, "mergeGate">): string | null {
  const gate = record.mergeGate;
  if (!gate || gate.status === "resolved" || gate.status === "superseded") return null;
  const blockers = gate.checks
    .filter((check) => check.outcome === "failing" || check.outcome === "missing_actionable")
    .map((check) => `${check.name} (${check.outcome})`);
  const observing = gate.checks
    .filter((check) => check.outcome === "pending" || check.outcome === "missing_observed" || check.outcome === "unknown")
    .map((check) => `${check.name} (${check.outcome})`);
  return `Merge gate ${gate.status} on head ${gate.headSha}; blockers: ${
    blockers.length === 0 ? "none" : blockers.join(", ")
  }; observing: ${observing.length === 0 ? "none" : observing.join(", ")}.`;
}

function workerOutputFromReport(report: IssueCompletionReportRecord | null): IssueWorkerOutputContract | null {
  if (!report) return null;
  return {
    version: 1,
    reportId: report.id,
    runId: report.runId,
    summary: clip(report.summary),
    changedFiles: report.changedFiles.slice(0, 25),
    validationEvidence: report.validationEvidence.map((item) => clip(item)).slice(0, 10),
    risks: report.risks.map((item) => clip(item)).slice(0, 10),
    pullRequest: report.pullRequest,
    acceptedAt: report.acceptedAt,
  };
}

function reviewerOutputFromVerdict(verdict: IssueReviewVerdictRecord | null): IssueReviewerOutputContract | null {
  if (!verdict) return null;
  return {
    version: 1,
    verdictId: verdict.id,
    runId: verdict.runId,
    verdict: verdict.verdict,
    findings: verdict.findings.map((item) => clip(item)).slice(0, 10),
    gateFindings: verdict.gateFindings.slice(0, 10),
    discoveryFindings: verdict.discoveryFindings.slice(0, 10),
    acceptanceResults: verdict.acceptanceResults.slice(0, 20),
    evidence: verdict.evidence.map((item) => clip(item)).slice(0, 10),
    submittedAt: verdict.submittedAt,
  };
}

function clip(value: string, maxChars = 500): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 15)}...[truncated]`;
}

function defaultSummaryPointers(): IssueLifecycleSummaryPointers {
  return {
    projectContext: undefined,
    workspaceKey: null,
    workspacePath: null,
    branchName: null,
    issueTitle: null,
    gitBranchName: null,
    repoPath: null,
    baseRef: null,
    lastRunId: null,
    prUrl: null,
    prNumber: null,
    prHeadSha: null,
    prBranch: null,
    ciStatus: null,
    lastPushedAt: null,
    lastEvidenceCursor: null,
  };
}

function patchValue<K extends keyof IssueLifecyclePatch>(
  patch: IssueLifecyclePatch,
  key: K,
  fallback: NonNullable<IssueLifecyclePatch[K]> | null,
): NonNullable<IssueLifecyclePatch[K]> | null {
  if (!Object.prototype.hasOwnProperty.call(patch, key)) return fallback;
  const value = patch[key];
  return value === undefined ? fallback : (value as NonNullable<IssueLifecyclePatch[K]> | null);
}

async function readLifecycleJsonIfExists(filePath: string): Promise<IssueLifecycleRecord | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    return normalizeLifecycleRecord(parsed, filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SymphonyError) throw error;
    throw new SymphonyError("lifecycle_store_corrupt", `Issue lifecycle record is unreadable: ${filePath}`, {
      cause: errorMessage(error),
    });
  }
}

function inferLegacyLifecycleProjectContext(
  value: Record<string, unknown>,
  filePath: string,
): ProjectContextResolution | undefined {
  const handoffMemo = isRecord(value.handoff) && isRecord(value.handoff.memo) ? value.handoff.memo : null;
  const handoffPointers = handoffMemo && isRecord(handoffMemo.pointers) ? handoffMemo.pointers : null;
  const candidates = [
    readStoredProjectContextCandidate(isRecord(value.summaryPointers) ? value.summaryPointers.projectContext : undefined),
    ...collectStoredProjectContextCandidates(value.issueBreakdownPlans),
    ...collectStoredProjectContextCandidates(value.completionReports),
    ...collectStoredProjectContextCandidates(value.reviewVerdicts),
    ...collectStoredProjectContextCandidates(value.reviewFeedback),
    ...collectStoredProjectContextCandidates(value.mergeConflictResolutionReports),
    readStoredProjectContextCandidate(handoffMemo?.projectContext),
    readStoredProjectContextCandidate(handoffPointers?.projectContext),
  ].filter((candidate): candidate is ProjectContextResolution => candidate !== null);
  const explicitCandidates = candidates.filter((candidate) => candidate.projectContextId !== LEGACY_DEFAULT_PROJECT_CONTEXT_ID);
  if (explicitCandidates.length > 0) {
    const firstExplicitCandidate = explicitCandidates[0]!;
    if (explicitCandidates.some((candidate) => candidate.projectContextId !== firstExplicitCandidate.projectContextId)) {
      throw corruptLifecycle(filePath, "projectContext metadata is ambiguous across legacy lifecycle subrecords");
    }
    return firstExplicitCandidate;
  }
  return candidates[0];
}

function collectStoredProjectContextCandidates(value: unknown): ProjectContextResolution[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (isRecord(item) ? readStoredProjectContextCandidate(item.projectContext) : null))
    .filter((candidate): candidate is ProjectContextResolution => candidate !== null);
}

function readStoredProjectContextCandidate(value: unknown): ProjectContextResolution | null {
  if (!isRecord(value)) return null;
  if (
    value.projectContextId === undefined &&
    value.projectContextLabel === undefined &&
    value.linearProjectSlug === undefined &&
    value.routingSource === undefined
  ) {
    return null;
  }
  return normalizeProjectContextResolution(value as Partial<ProjectContextResolution>);
}

function normalizeLifecycleRecord(value: unknown, filePath: string): IssueLifecycleRecord {
  if (!isRecord(value)) {
    throw corruptLifecycle(filePath, "record is not an object");
  }
  if (typeof value.issueId !== "string" || value.issueId.length === 0) {
    throw corruptLifecycle(filePath, "issueId is missing");
  }
  if (typeof value.issueIdentifier !== "string" || value.issueIdentifier.length === 0) {
    throw corruptLifecycle(filePath, "issueIdentifier is missing");
  }
  if (!isLifecyclePhase(value.phase)) {
    throw corruptLifecycle(filePath, "phase is invalid");
  }

  const projectContext = normalizeStoredProjectContext(
    value.projectContext,
    inferLegacyLifecycleProjectContext(value, filePath),
  );
  const normalized = {
    issueId: value.issueId,
    issueIdentifier: value.issueIdentifier,
    projectContext,
    phase: value.phase,
    reviewRound: nonNegativeInteger(value.reviewRound, filePath, "reviewRound"),
    incompleteTurnCount: nonNegativeInteger(value.incompleteTurnCount, filePath, "incompleteTurnCount"),
    lastIssueBreakdownPlanId: optionalNullableString(
      value.lastIssueBreakdownPlanId,
      filePath,
      "lastIssueBreakdownPlanId",
    ),
    planningFailureCount:
      value.planningFailureCount === undefined
        ? 0
        : nonNegativeInteger(value.planningFailureCount, filePath, "planningFailureCount"),
    planningDispatchRetryCount:
      value.planningDispatchRetryCount === undefined
        ? 0
        : nonNegativeInteger(value.planningDispatchRetryCount, filePath, "planningDispatchRetryCount"),
    lastPlanningFailureRunId:
      value.lastPlanningFailureRunId === undefined
        ? null
        : nullableString(value.lastPlanningFailureRunId, filePath, "lastPlanningFailureRunId"),
    lastPlanningFailureAt:
      value.lastPlanningFailureAt === undefined
        ? null
        : nullableString(value.lastPlanningFailureAt, filePath, "lastPlanningFailureAt"),
    lastIssueTriageReportId:
      value.lastIssueTriageReportId === undefined
        ? null
        : nullableString(value.lastIssueTriageReportId, filePath, "lastIssueTriageReportId"),
    lastPostMortemReportId:
      value.lastPostMortemReportId === undefined
        ? null
        : nullableString(value.lastPostMortemReportId, filePath, "lastPostMortemReportId"),
    lastCompletionReportId: nullableString(value.lastCompletionReportId, filePath, "lastCompletionReportId"),
    lastCompletionReportRejectionId:
      value.lastCompletionReportRejectionId === undefined
        ? null
        : nullableString(value.lastCompletionReportRejectionId, filePath, "lastCompletionReportRejectionId"),
    lastReviewVerdictId: nullableString(value.lastReviewVerdictId, filePath, "lastReviewVerdictId"),
    lastMergeGateResultId:
      value.lastMergeGateResultId === undefined
        ? null
        : nullableString(value.lastMergeGateResultId, filePath, "lastMergeGateResultId"),
    blockedReason: nullableString(value.blockedReason, filePath, "blockedReason"),
    events: normalizeLifecycleEvents(value.events, filePath),
    summaryPointers: normalizeSummaryPointers(value.summaryPointers, filePath, projectContext),
    summaryReferences: normalizeSummaryReferences(value.summaryReferences, filePath),
    issueBreakdownPlans: normalizeIssueBreakdownPlans(value.issueBreakdownPlans, filePath, projectContext),
    completionReports: normalizeCompletionReports(value.completionReports, filePath, projectContext),
    completionReportRejections: normalizeCompletionReportRejections(value.completionReportRejections, filePath),
    reviewVerdicts: normalizeReviewVerdicts(value.reviewVerdicts, filePath, projectContext),
    reviewVerdictSubmissions: normalizeReviewVerdictSubmissions(value.reviewVerdictSubmissions, filePath, projectContext),
    mergeGateResults: normalizeMergeGateResults(value.mergeGateResults, filePath),
    reviewFeedback: normalizeReviewFeedback(value.reviewFeedback, filePath, projectContext),
    issueTriageReports: normalizeIssueTriageReports(value.issueTriageReports, filePath),
    postMortemReports: normalizePostMortemReports(value.postMortemReports, filePath),
    reviewEvidence: normalizeReviewEvidence(value.reviewEvidence, filePath),
    baseRefObservation: normalizeBaseRefObservation(value.baseRefObservation, filePath),
    mergeGate: normalizeMergeGateState(value.mergeGate, filePath),
    merge: normalizeMergeMetadata(value.merge, filePath),
    mergeConflict: normalizeMergeConflictMetadata(value.mergeConflict, filePath),
    mergeConflictResolutionReports: normalizeMergeConflictResolutionReports(
      value.mergeConflictResolutionReports,
      filePath,
      projectContext,
    ),
    preservedWorktreeStashes: normalizePreservedWorktreeStashes(
      value.preservedWorktreeStashes,
      filePath,
    ),
    createdAt: requiredString(value.createdAt, filePath, "createdAt"),
    updatedAt: requiredString(value.updatedAt, filePath, "updatedAt"),
  };
  return {
    ...normalized,
    handoff: normalizeHandoffState(value.handoff, normalized, filePath),
  };
}

function normalizeSummaryPointers(
  value: unknown,
  filePath: string,
  fallbackProjectContext: ProjectContextResolution,
): IssueLifecycleSummaryPointers {
  if (!isRecord(value)) {
    return {
      ...defaultSummaryPointers(),
      projectContext: fallbackProjectContext,
    };
  }
  return {
    projectContext: normalizeStoredProjectContext(value.projectContext, fallbackProjectContext),
    workspaceKey: nullableString(value.workspaceKey, filePath, "summaryPointers.workspaceKey"),
    workspacePath: nullableString(value.workspacePath, filePath, "summaryPointers.workspacePath"),
    branchName: nullableString(value.branchName, filePath, "summaryPointers.branchName"),
    issueTitle: optionalNullableString(value.issueTitle, filePath, "summaryPointers.issueTitle"),
    gitBranchName: optionalNullableString(value.gitBranchName, filePath, "summaryPointers.gitBranchName"),
    repoPath: optionalNullableString(value.repoPath, filePath, "summaryPointers.repoPath"),
    baseRef: optionalNullableString(value.baseRef, filePath, "summaryPointers.baseRef"),
    lastRunId: nullableString(value.lastRunId, filePath, "summaryPointers.lastRunId"),
    prUrl: optionalNullableString(value.prUrl, filePath, "summaryPointers.prUrl"),
    prNumber: optionalNullableNumber(value.prNumber, filePath, "summaryPointers.prNumber"),
    prHeadSha: optionalNullableString(value.prHeadSha, filePath, "summaryPointers.prHeadSha"),
    prBranch: optionalNullableString(value.prBranch, filePath, "summaryPointers.prBranch"),
    ciStatus: optionalNullableString(value.ciStatus, filePath, "summaryPointers.ciStatus"),
    lastPushedAt: optionalNullableString(value.lastPushedAt, filePath, "summaryPointers.lastPushedAt"),
    lastEvidenceCursor: optionalNullableString(value.lastEvidenceCursor, filePath, "summaryPointers.lastEvidenceCursor"),
  };
}

function normalizeSummaryReferences(value: unknown, filePath: string): IssueLifecycleSummaryReference[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw corruptLifecycle(filePath, "summaryReferences is invalid");
  return value.map((item, index) => normalizeSummaryReference(item, filePath, index));
}

function normalizeLifecycleEvents(value: unknown, filePath: string): IssueLifecycleEvent[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw corruptLifecycle(filePath, "events is invalid");
  return value.map((item, index) => normalizeLifecycleEvent(item, filePath, index));
}

function normalizeLifecycleEvent(value: unknown, filePath: string, index: number): IssueLifecycleEvent {
  if (!isRecord(value)) throw corruptLifecycle(filePath, `events[${index}] is invalid`);
  if (value.kind !== "worker_dispatch_routing_failure") {
    throw corruptLifecycle(filePath, `events[${index}].kind is invalid`);
  }
  if (value.redacted !== true) {
    throw corruptLifecycle(filePath, `events[${index}].redacted must be true`);
  }
  const reason = requiredString(value.reason, filePath, `events[${index}].reason`);
  if (!isProjectContextRoutingProblemReason(reason)) {
    throw corruptLifecycle(filePath, `events[${index}].reason is invalid`);
  }
  return {
    kind: value.kind,
    recordedAt: requiredString(value.recordedAt, filePath, `events[${index}].recordedAt`),
    redacted: true,
    reason,
    safeMessage: requiredString(value.safeMessage, filePath, `events[${index}].safeMessage`),
    candidateContextIds: requiredStringArray(value.candidateContextIds, filePath, `events[${index}].candidateContextIds`),
  };
}

function isProjectContextRoutingProblemReason(value: string): value is ProjectContextRoutingProblemReason {
  return (
    value === "missing_context" ||
    value === "ambiguous_context" ||
    value === "disabled_context" ||
    value === "credential_unavailable" ||
    value === "codebase_unavailable" ||
    value === "stale_context"
  );
}

function normalizeSummaryReference(value: unknown, filePath: string, index: number): IssueLifecycleSummaryReference {
  if (!isRecord(value)) throw corruptLifecycle(filePath, `summaryReferences[${index}] is invalid`);
  if (value.kind !== "continuation_history" && value.kind !== "issue_breakdown_plan") {
    throw corruptLifecycle(filePath, `summaryReferences[${index}].kind is invalid`);
  }
  const normalized: IssueLifecycleSummaryReference = {
    id: requiredString(value.id, filePath, `summaryReferences[${index}].id`),
    kind: value.kind,
    summary: requiredString(value.summary, filePath, `summaryReferences[${index}].summary`),
    runIds: requiredStringArray(value.runIds, filePath, `summaryReferences[${index}].runIds`),
    transcriptEventCount: nonNegativeInteger(
      value.transcriptEventCount,
      filePath,
      `summaryReferences[${index}].transcriptEventCount`,
    ),
    transcriptPointers: requiredStringArray(
      value.transcriptPointers,
      filePath,
      `summaryReferences[${index}].transcriptPointers`,
    ),
    statusApiPointers: requiredStringArray(
      value.statusApiPointers,
      filePath,
      `summaryReferences[${index}].statusApiPointers`,
    ),
    createdAt: requiredString(value.createdAt, filePath, `summaryReferences[${index}].createdAt`),
  };
  if (value.planId !== undefined) {
    normalized.planId = requiredString(value.planId, filePath, `summaryReferences[${index}].planId`);
  }
  if (value.issueUpdatedAt !== undefined) {
    normalized.issueUpdatedAt = optionalNullableString(value.issueUpdatedAt, filePath, `summaryReferences[${index}].issueUpdatedAt`);
  }
  if (value.issueContentFingerprint !== undefined) {
    normalized.issueContentFingerprint = optionalNullableString(
      value.issueContentFingerprint,
      filePath,
      `summaryReferences[${index}].issueContentFingerprint`,
    );
  }
  if (value.configFingerprint !== undefined) {
    normalized.configFingerprint = optionalNullableString(value.configFingerprint, filePath, `summaryReferences[${index}].configFingerprint`);
  }
  if (value.cursorMode !== undefined) {
    normalized.cursorMode = optionalNullableString(value.cursorMode, filePath, `summaryReferences[${index}].cursorMode`);
  }
  return normalized;
}

function normalizeIssueBreakdownPlans(
  value: unknown,
  filePath: string,
  fallbackProjectContext: ProjectContextResolution,
): IssueBreakdownPlanRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw corruptLifecycle(filePath, "issueBreakdownPlans is invalid");
  return value.map((item, index) => normalizeIssueBreakdownPlan(item, filePath, index, fallbackProjectContext));
}

function normalizeIssueBreakdownPlan(
  value: unknown,
  filePath: string,
  index: number,
  fallbackProjectContext: ProjectContextResolution,
): IssueBreakdownPlanRecord {
  if (!isRecord(value)) throw corruptLifecycle(filePath, `issueBreakdownPlans[${index}] is invalid`);
  return {
    id: requiredString(value.id, filePath, `issueBreakdownPlans[${index}].id`),
    projectContext: normalizeStoredProjectContext(value.projectContext, fallbackProjectContext),
    idempotencyKey: requiredString(value.idempotencyKey, filePath, `issueBreakdownPlans[${index}].idempotencyKey`),
    requestHash:
      value.requestHash === undefined
        ? ""
        : requiredString(value.requestHash, filePath, `issueBreakdownPlans[${index}].requestHash`),
    runId: requiredString(value.runId, filePath, `issueBreakdownPlans[${index}].runId`),
    issueId: requiredString(value.issueId, filePath, `issueBreakdownPlans[${index}].issueId`),
    issueIdentifier: requiredString(value.issueIdentifier, filePath, `issueBreakdownPlans[${index}].issueIdentifier`),
    summary: requiredString(value.summary, filePath, `issueBreakdownPlans[${index}].summary`),
    proposedIssues: normalizeProposedIssues(value.proposedIssues, filePath, index),
    transcriptPointers: requiredStringArray(value.transcriptPointers, filePath, `issueBreakdownPlans[${index}].transcriptPointers`),
    statusApiPointers: requiredStringArray(value.statusApiPointers, filePath, `issueBreakdownPlans[${index}].statusApiPointers`),
    issueUpdatedAt: nullableString(value.issueUpdatedAt, filePath, `issueBreakdownPlans[${index}].issueUpdatedAt`),
    issueContentFingerprint:
      value.issueContentFingerprint === undefined
        ? ""
        : requiredString(
            value.issueContentFingerprint,
            filePath,
            `issueBreakdownPlans[${index}].issueContentFingerprint`,
          ),
    configFingerprint: requiredString(value.configFingerprint, filePath, `issueBreakdownPlans[${index}].configFingerprint`),
    cursorMode: requiredString(value.cursorMode, filePath, `issueBreakdownPlans[${index}].cursorMode`),
    acceptedAt: requiredString(value.acceptedAt, filePath, `issueBreakdownPlans[${index}].acceptedAt`),
    applicationStatus: normalizeIssueBreakdownPlanApplicationStatus(
      value.applicationStatus,
      filePath,
      `issueBreakdownPlans[${index}].applicationStatus`,
    ),
    applicationOperationKeys:
      value.applicationOperationKeys === undefined
        ? []
        : requiredStringArray(value.applicationOperationKeys, filePath, `issueBreakdownPlans[${index}].applicationOperationKeys`),
    createdIssueRefs: normalizeCreatedIssueRefs(value.createdIssueRefs, filePath, index),
    appliedAt:
      value.appliedAt === undefined
        ? null
        : nullableString(value.appliedAt, filePath, `issueBreakdownPlans[${index}].appliedAt`),
    applicationBlockedReason:
      value.applicationBlockedReason === undefined
        ? null
        : nullableString(
            value.applicationBlockedReason,
            filePath,
            `issueBreakdownPlans[${index}].applicationBlockedReason`,
          ),
  };
}

function normalizeProposedIssues(value: unknown, filePath: string, planIndex: number): ProposedIssueRecord[] {
  if (!Array.isArray(value)) throw corruptLifecycle(filePath, `issueBreakdownPlans[${planIndex}].proposedIssues is invalid`);
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw corruptLifecycle(filePath, `issueBreakdownPlans[${planIndex}].proposedIssues[${index}] is invalid`);
    }
    return {
      title: requiredString(item.title, filePath, `issueBreakdownPlans[${planIndex}].proposedIssues[${index}].title`),
      description: requiredString(
        item.description,
        filePath,
        `issueBreakdownPlans[${planIndex}].proposedIssues[${index}].description`,
      ),
      acceptanceCriteria: requiredStringArray(
        item.acceptanceCriteria,
        filePath,
        `issueBreakdownPlans[${planIndex}].proposedIssues[${index}].acceptanceCriteria`,
      ),
      dependencies: requiredStringArray(
        item.dependencies,
        filePath,
        `issueBreakdownPlans[${planIndex}].proposedIssues[${index}].dependencies`,
      ),
      labels: requiredStringArray(item.labels, filePath, `issueBreakdownPlans[${planIndex}].proposedIssues[${index}].labels`),
    };
  });
}

function normalizeIssueBreakdownPlanApplicationStatus(
  value: unknown,
  filePath: string,
  field: string,
): IssueBreakdownPlanApplicationStatus {
  if (value === undefined) return "not_requested";
  if (value === "not_requested" || value === "pending" || value === "applied" || value === "blocked" || value === "stale") {
    return value;
  }
  throw corruptLifecycle(filePath, `${field} is invalid`);
}

function normalizeCreatedIssueRefs(value: unknown, filePath: string, planIndex: number): IssueBreakdownCreatedIssueRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw corruptLifecycle(filePath, `issueBreakdownPlans[${planIndex}].createdIssueRefs is invalid`);
  return value.map((item, index) => {
    if (!isRecord(item)) throw corruptLifecycle(filePath, `issueBreakdownPlans[${planIndex}].createdIssueRefs[${index}] is invalid`);
    const status = item.status;
    if (status !== "created" && status !== "verified") {
      throw corruptLifecycle(filePath, `issueBreakdownPlans[${planIndex}].createdIssueRefs[${index}].status is invalid`);
    }
    return {
      proposedIssueIndex: nonNegativeInteger(
        item.proposedIssueIndex,
        filePath,
        `issueBreakdownPlans[${planIndex}].createdIssueRefs[${index}].proposedIssueIndex`,
      ),
      operationKey: requiredString(
        item.operationKey,
        filePath,
        `issueBreakdownPlans[${planIndex}].createdIssueRefs[${index}].operationKey`,
      ),
      status,
      id: requiredString(item.id, filePath, `issueBreakdownPlans[${planIndex}].createdIssueRefs[${index}].id`),
      identifier: nullableString(
        item.identifier,
        filePath,
        `issueBreakdownPlans[${planIndex}].createdIssueRefs[${index}].identifier`,
      ),
      url: nullableString(item.url, filePath, `issueBreakdownPlans[${planIndex}].createdIssueRefs[${index}].url`),
    };
  });
}

function normalizeCompletionReports(
  value: unknown,
  filePath: string,
  fallbackProjectContext: ProjectContextResolution,
): IssueCompletionReportRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw corruptLifecycle(filePath, "completionReports is invalid");
  return value.map((item, index) => normalizeCompletionReport(item, filePath, index, fallbackProjectContext));
}

function normalizeCompletionReportRejections(value: unknown, filePath: string): IssueCompletionReportRejectionRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw corruptLifecycle(filePath, "completionReportRejections is invalid");
  return value.map((item, index) => normalizeCompletionReportRejection(item, filePath, index));
}

function normalizeReviewVerdicts(
  value: unknown,
  filePath: string,
  fallbackProjectContext: ProjectContextResolution,
): IssueReviewVerdictRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw corruptLifecycle(filePath, "reviewVerdicts is invalid");
  return value.map((item, index) => normalizeReviewVerdict(item, filePath, index, fallbackProjectContext));
}

function normalizeReviewVerdictSubmissions(
  value: unknown,
  filePath: string,
  fallbackProjectContext: ProjectContextResolution,
): IssueReviewVerdictSubmissionRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw corruptLifecycle(filePath, "reviewVerdictSubmissions is invalid");
  return value.map((item, index) => normalizeReviewVerdictSubmission(item, filePath, index, fallbackProjectContext));
}

function normalizeMergeGateResults(value: unknown, filePath: string): IssueMergeGateResultRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw corruptLifecycle(filePath, "mergeGateResults is invalid");
  return value.map((item, index) => normalizeMergeGateResult(item, filePath, index));
}

function normalizeReviewFeedback(
  value: unknown,
  filePath: string,
  fallbackProjectContext: ProjectContextResolution,
): IssueReviewFeedbackRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw corruptLifecycle(filePath, "reviewFeedback is invalid");
  return value.map((item, index) => normalizeReviewFeedbackRecord(item, filePath, index, fallbackProjectContext));
}

function normalizeIssueTriageReports(value: unknown, filePath: string): IssueTriageReportRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw corruptLifecycle(filePath, "issueTriageReports is invalid");
  return value.map((item, index) => normalizeIssueTriageReport(item, filePath, index));
}

function normalizePostMortemReports(value: unknown, filePath: string): IssuePostMortemReportRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw corruptLifecycle(filePath, "postMortemReports is invalid");
  return value.map((item, index) => normalizePostMortemReport(item, filePath, index));
}

function normalizeMergeConflictResolutionReports(
  value: unknown,
  filePath: string,
  fallbackProjectContext: ProjectContextResolution,
): IssueMergeConflictResolutionReportRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw corruptLifecycle(filePath, "mergeConflictResolutionReports is invalid");
  return value.map((item, index) =>
    normalizeMergeConflictResolutionReport(item, filePath, index, fallbackProjectContext),
  );
}

function defaultReviewEvidence(): PullRequestReviewEvidenceState {
  return {
    pullRequest: null,
    lastIngestedCursor: null,
    lastWorkerEvidenceCursor: null,
    items: [],
    updatedAt: null,
  };
}

function normalizeReviewEvidence(value: unknown, filePath: string): PullRequestReviewEvidenceState {
  if (value === undefined) return defaultReviewEvidence();
  if (!isRecord(value)) throw corruptLifecycle(filePath, "reviewEvidence is invalid");
  return {
    pullRequest: normalizeReviewEvidencePullRequest(value.pullRequest, filePath),
    lastIngestedCursor: optionalNullableString(value.lastIngestedCursor, filePath, "reviewEvidence.lastIngestedCursor"),
    lastWorkerEvidenceCursor: optionalNullableString(
      value.lastWorkerEvidenceCursor,
      filePath,
      "reviewEvidence.lastWorkerEvidenceCursor",
    ),
    items: normalizeReviewEvidenceItems(value.items, filePath),
    updatedAt: optionalNullableString(value.updatedAt, filePath, "reviewEvidence.updatedAt"),
  };
}

function normalizeBaseRefObservation(value: unknown, filePath: string): IssueBaseRefObservation | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw corruptLifecycle(filePath, "baseRefObservation is invalid");
  const classification = value.classification;
  if (!isBaseRefObservationClassification(classification)) {
    throw corruptLifecycle(filePath, "baseRefObservation.classification is invalid");
  }
  return {
    version: 1,
    inputFingerprint: requiredString(value.inputFingerprint, filePath, "baseRefObservation.inputFingerprint"),
    classification,
    operation: requiredString(value.operation, filePath, "baseRefObservation.operation"),
    checkedAt: requiredString(value.checkedAt, filePath, "baseRefObservation.checkedAt"),
    workspacePath: optionalNullableString(value.workspacePath, filePath, "baseRefObservation.workspacePath"),
    branchName: optionalNullableString(value.branchName, filePath, "baseRefObservation.branchName"),
    baseRef: optionalNullableString(value.baseRef, filePath, "baseRefObservation.baseRef"),
    normalizedBaseBranch: optionalNullableString(
      value.normalizedBaseBranch,
      filePath,
      "baseRefObservation.normalizedBaseBranch",
    ),
    localBaseRef: optionalNullableString(value.localBaseRef, filePath, "baseRefObservation.localBaseRef"),
    githubBaseHeadSha: optionalNullableString(
      value.githubBaseHeadSha,
      filePath,
      "baseRefObservation.githubBaseHeadSha",
    ),
    localBaseHeadShaBeforeFetch: optionalNullableString(
      value.localBaseHeadShaBeforeFetch,
      filePath,
      "baseRefObservation.localBaseHeadShaBeforeFetch",
    ),
    localBaseHeadShaAfterFetch: optionalNullableString(
      value.localBaseHeadShaAfterFetch,
      filePath,
      "baseRefObservation.localBaseHeadShaAfterFetch",
    ),
    worktreeHeadSha: optionalNullableString(value.worktreeHeadSha, filePath, "baseRefObservation.worktreeHeadSha"),
    localBaseIsAncestorOfHead: optionalNullableBoolean(
      value.localBaseIsAncestorOfHead,
      filePath,
      "baseRefObservation.localBaseIsAncestorOfHead",
    ),
    reason: optionalNullableString(value.reason, filePath, "baseRefObservation.reason"),
    error: optionalNullableString(value.error, filePath, "baseRefObservation.error"),
  };
}

function normalizeHandoffState(
  value: unknown,
  record: Omit<IssueLifecycleRecord, "handoff">,
  filePath: string,
): IssueHandoffState {
  if (value === undefined) return buildIssueHandoffState(record);
  if (!isRecord(value)) throw corruptLifecycle(filePath, "handoff is invalid");
  if (value.version !== 1) throw corruptLifecycle(filePath, "handoff.version is invalid");
  return {
    version: 1,
    memo: normalizeLaneMemo(value.memo, filePath, normalizeProjectContextResolution(record.projectContext)),
    lastWorkerOutput: normalizeWorkerOutputContract(value.lastWorkerOutput, filePath),
    lastReviewerOutput: normalizeReviewerOutputContract(value.lastReviewerOutput, filePath),
  };
}

function normalizeLaneMemo(
  value: unknown,
  filePath: string,
  fallbackProjectContext: ProjectContextResolution,
): IssueLaneMemo {
  if (!isRecord(value)) throw corruptLifecycle(filePath, "handoff.memo is invalid");
  if (value.version !== 1) throw corruptLifecycle(filePath, "handoff.memo.version is invalid");
  return {
    version: 1,
    issueId: requiredString(value.issueId, filePath, "handoff.memo.issueId"),
    issueIdentifier: requiredString(value.issueIdentifier, filePath, "handoff.memo.issueIdentifier"),
    projectContext: normalizeStoredProjectContext(value.projectContext, fallbackProjectContext),
    updatedAt: requiredString(value.updatedAt, filePath, "handoff.memo.updatedAt"),
    reviewRound: nonNegativeInteger(value.reviewRound, filePath, "handoff.memo.reviewRound"),
    incompleteTurnCount: nonNegativeInteger(value.incompleteTurnCount, filePath, "handoff.memo.incompleteTurnCount"),
    sizeChars:
      value.sizeChars === undefined
        ? JSON.stringify(value).length
        : nonNegativeInteger(value.sizeChars, filePath, "handoff.memo.sizeChars"),
    entries: requiredStringArray(value.entries, filePath, "handoff.memo.entries"),
    openFindings: requiredStringArray(value.openFindings, filePath, "handoff.memo.openFindings"),
    pointers: normalizeSummaryPointers(value.pointers, filePath, fallbackProjectContext),
    lastWorkerRunId: nullableString(value.lastWorkerRunId, filePath, "handoff.memo.lastWorkerRunId"),
    lastReviewerRunId: nullableString(value.lastReviewerRunId, filePath, "handoff.memo.lastReviewerRunId"),
  };
}

function normalizeWorkerOutputContract(value: unknown, filePath: string): IssueWorkerOutputContract | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw corruptLifecycle(filePath, "handoff.lastWorkerOutput is invalid");
  if (value.version !== 1) throw corruptLifecycle(filePath, "handoff.lastWorkerOutput.version is invalid");
  return {
    version: 1,
    reportId: requiredString(value.reportId, filePath, "handoff.lastWorkerOutput.reportId"),
    runId: requiredString(value.runId, filePath, "handoff.lastWorkerOutput.runId"),
    summary: requiredString(value.summary, filePath, "handoff.lastWorkerOutput.summary"),
    changedFiles: requiredStringArray(value.changedFiles, filePath, "handoff.lastWorkerOutput.changedFiles"),
    validationEvidence: requiredStringArray(value.validationEvidence, filePath, "handoff.lastWorkerOutput.validationEvidence"),
    risks: requiredStringArray(value.risks, filePath, "handoff.lastWorkerOutput.risks"),
    pullRequest: normalizePullRequest(value.pullRequest, filePath, 0),
    acceptedAt: requiredString(value.acceptedAt, filePath, "handoff.lastWorkerOutput.acceptedAt"),
  };
}

function normalizeReviewerOutputContract(value: unknown, filePath: string): IssueReviewerOutputContract | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw corruptLifecycle(filePath, "handoff.lastReviewerOutput is invalid");
  if (value.version !== 1) throw corruptLifecycle(filePath, "handoff.lastReviewerOutput.version is invalid");
  const verdict = value.verdict;
  if (verdict !== "pass" && verdict !== "fail" && verdict !== "blocked") {
    throw corruptLifecycle(filePath, "handoff.lastReviewerOutput.verdict is invalid");
  }
  const findings = requiredStringArray(value.findings, filePath, "handoff.lastReviewerOutput.findings");
  const evidence = requiredStringArray(value.evidence, filePath, "handoff.lastReviewerOutput.evidence");
  return {
    version: 1,
    verdictId: requiredString(value.verdictId, filePath, "handoff.lastReviewerOutput.verdictId"),
    runId: requiredString(value.runId, filePath, "handoff.lastReviewerOutput.runId"),
    verdict,
    findings,
    gateFindings:
      value.gateFindings === undefined
        ? legacyGateFindingsFromFindings(findings, evidence)
        : normalizeReviewGateFindings(value.gateFindings, filePath, 0),
    discoveryFindings:
      value.discoveryFindings === undefined ? [] : normalizeReviewDiscoveryFindings(value.discoveryFindings, filePath, 0),
    acceptanceResults: normalizeReviewVerdictAcceptanceResults(value.acceptanceResults, filePath, 0),
    evidence,
    submittedAt: requiredString(value.submittedAt, filePath, "handoff.lastReviewerOutput.submittedAt"),
  };
}

function normalizeReviewEvidencePullRequest(value: unknown, filePath: string): CompletionReportPullRequestRef | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw corruptLifecycle(filePath, "reviewEvidence.pullRequest is invalid");
  return {
    url: nullableString(value.url, filePath, "reviewEvidence.pullRequest.url"),
    number: nullableNumber(value.number, filePath, "reviewEvidence.pullRequest.number"),
    headSha: optionalNullableString(value.headSha, filePath, "reviewEvidence.pullRequest.headSha"),
    branch: optionalNullableString(value.branch, filePath, "reviewEvidence.pullRequest.branch"),
  };
}

function normalizeReviewEvidenceItems(value: unknown, filePath: string): PullRequestReviewEvidenceItem[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw corruptLifecycle(filePath, "reviewEvidence.items is invalid");
  return value.map((item, index) => normalizeReviewEvidenceItem(item, filePath, index));
}

function normalizeReviewEvidenceItem(value: unknown, filePath: string, index: number): PullRequestReviewEvidenceItem {
  if (!isRecord(value)) throw corruptLifecycle(filePath, `reviewEvidence.items[${index}] is invalid`);
  const source = value.source;
  if (source !== "review" && source !== "review_comment" && source !== "issue_comment") {
    throw corruptLifecycle(filePath, `reviewEvidence.items[${index}].source is invalid`);
  }
  return {
    id: requiredString(value.id, filePath, `reviewEvidence.items[${index}].id`),
    source,
    githubId: requiredString(value.githubId, filePath, `reviewEvidence.items[${index}].githubId`),
    pullRequestNumber: nonNegativeInteger(value.pullRequestNumber, filePath, `reviewEvidence.items[${index}].pullRequestNumber`),
    pullRequestUrl: optionalNullableString(value.pullRequestUrl, filePath, `reviewEvidence.items[${index}].pullRequestUrl`),
    url: optionalNullableString(value.url, filePath, `reviewEvidence.items[${index}].url`),
    reviewer: optionalNullableString(value.reviewer, filePath, `reviewEvidence.items[${index}].reviewer`),
    body: requiredString(value.body, filePath, `reviewEvidence.items[${index}].body`),
    state: optionalNullableString(value.state, filePath, `reviewEvidence.items[${index}].state`),
    path: optionalNullableString(value.path, filePath, `reviewEvidence.items[${index}].path`),
    line: optionalNullableNumber(value.line, filePath, `reviewEvidence.items[${index}].line`),
    originalLine: optionalNullableNumber(value.originalLine, filePath, `reviewEvidence.items[${index}].originalLine`),
    side: optionalNullableString(value.side, filePath, `reviewEvidence.items[${index}].side`),
    threadId: optionalNullableString(value.threadId, filePath, `reviewEvidence.items[${index}].threadId`),
    inReplyToId: optionalNullableString(value.inReplyToId, filePath, `reviewEvidence.items[${index}].inReplyToId`),
    isResolved: optionalNullableBoolean(value.isResolved, filePath, `reviewEvidence.items[${index}].isResolved`),
    isOutdated: optionalNullableBoolean(value.isOutdated, filePath, `reviewEvidence.items[${index}].isOutdated`),
    createdAt: optionalNullableString(value.createdAt, filePath, `reviewEvidence.items[${index}].createdAt`),
    updatedAt: optionalNullableString(value.updatedAt, filePath, `reviewEvidence.items[${index}].updatedAt`),
    submittedAt: optionalNullableString(value.submittedAt, filePath, `reviewEvidence.items[${index}].submittedAt`),
    cursor: requiredString(value.cursor, filePath, `reviewEvidence.items[${index}].cursor`),
  };
}

function normalizeCompletionReport(
  value: unknown,
  filePath: string,
  index: number,
  fallbackProjectContext: ProjectContextResolution,
): IssueCompletionReportRecord {
  if (!isRecord(value)) throw corruptLifecycle(filePath, `completionReports[${index}] is invalid`);
  return {
    id: requiredString(value.id, filePath, `completionReports[${index}].id`),
    projectContext: normalizeStoredProjectContext(value.projectContext, fallbackProjectContext),
    idempotencyKey: requiredString(value.idempotencyKey, filePath, `completionReports[${index}].idempotencyKey`),
    runId: requiredString(value.runId, filePath, `completionReports[${index}].runId`),
    issueId: requiredString(value.issueId, filePath, `completionReports[${index}].issueId`),
    issueIdentifier: requiredString(value.issueIdentifier, filePath, `completionReports[${index}].issueIdentifier`),
    summary: requiredString(value.summary, filePath, `completionReports[${index}].summary`),
    validationEvidence: requiredStringArray(value.validationEvidence, filePath, `completionReports[${index}].validationEvidence`),
    acceptanceChecklist: normalizeChecklist(value.acceptanceChecklist, filePath, index),
    changedFiles: requiredStringArray(value.changedFiles, filePath, `completionReports[${index}].changedFiles`),
    branchName: nullableString(value.branchName, filePath, `completionReports[${index}].branchName`),
    pullRequest: normalizePullRequest(value.pullRequest, filePath, index),
    acceptanceContext: normalizeCompletionReportAcceptanceContext(value.acceptanceContext, filePath, index),
    risks: requiredStringArray(value.risks, filePath, `completionReports[${index}].risks`),
    acceptedAt: requiredString(value.acceptedAt, filePath, `completionReports[${index}].acceptedAt`),
    writebackOperationKeys: requiredStringArray(value.writebackOperationKeys, filePath, `completionReports[${index}].writebackOperationKeys`),
  };
}

function normalizeCompletionReportRejection(
  value: unknown,
  filePath: string,
  index: number,
): IssueCompletionReportRejectionRecord {
  if (!isRecord(value)) throw corruptLifecycle(filePath, `completionReportRejections[${index}] is invalid`);
  if (!isCompletionReportRejectionReasonCode(value.reasonCode)) {
    throw corruptLifecycle(filePath, `completionReportRejections[${index}].reasonCode is invalid`);
  }
  return {
    id: requiredString(value.id, filePath, `completionReportRejections[${index}].id`),
    reportId: requiredString(value.reportId, filePath, `completionReportRejections[${index}].reportId`),
    idempotencyKey: requiredString(value.idempotencyKey, filePath, `completionReportRejections[${index}].idempotencyKey`),
    runId: requiredString(value.runId, filePath, `completionReportRejections[${index}].runId`),
    issueId: requiredString(value.issueId, filePath, `completionReportRejections[${index}].issueId`),
    issueIdentifier: requiredString(value.issueIdentifier, filePath, `completionReportRejections[${index}].issueIdentifier`),
    reasonCode: value.reasonCode,
    reason: requiredString(value.reason, filePath, `completionReportRejections[${index}].reason`),
    summary: requiredString(value.summary, filePath, `completionReportRejections[${index}].summary`),
    validationEvidence: requiredStringArray(
      value.validationEvidence,
      filePath,
      `completionReportRejections[${index}].validationEvidence`,
    ),
    acceptanceChecklist: normalizeChecklist(value.acceptanceChecklist, filePath, index),
    changedFiles: requiredStringArray(value.changedFiles, filePath, `completionReportRejections[${index}].changedFiles`),
    branchName: nullableString(value.branchName, filePath, `completionReportRejections[${index}].branchName`),
    pullRequest: normalizePullRequest(value.pullRequest, filePath, index),
    risks: requiredStringArray(value.risks, filePath, `completionReportRejections[${index}].risks`),
    rejectedAt: requiredString(value.rejectedAt, filePath, `completionReportRejections[${index}].rejectedAt`),
    writebackOperationKeys: requiredStringArray(
      value.writebackOperationKeys,
      filePath,
      `completionReportRejections[${index}].writebackOperationKeys`,
    ),
  };
}

function isCompletionReportRejectionReasonCode(value: unknown): value is IssueCompletionReportRejectionReasonCode {
  return value === "unsatisfied_acceptance_checklist" || value === "pull_request_publication_failed";
}

function normalizeReviewVerdict(
  value: unknown,
  filePath: string,
  index: number,
  fallbackProjectContext: ProjectContextResolution,
): IssueReviewVerdictRecord {
  if (!isRecord(value)) throw corruptLifecycle(filePath, `reviewVerdicts[${index}] is invalid`);
  if (value.verdict !== "pass" && value.verdict !== "fail" && value.verdict !== "blocked") {
    throw corruptLifecycle(filePath, `reviewVerdicts[${index}].verdict is invalid`);
  }
  const findings = requiredStringArray(value.findings, filePath, `reviewVerdicts[${index}].findings`);
  const evidence = requiredStringArray(value.evidence, filePath, `reviewVerdicts[${index}].evidence`);
  const gateFindings =
    value.gateFindings === undefined
      ? legacyGateFindingsFromFindings(findings, evidence)
      : normalizeReviewGateFindings(value.gateFindings, filePath, index);
  const discoveryFindings =
    value.discoveryFindings === undefined
      ? []
      : normalizeReviewDiscoveryFindings(value.discoveryFindings, filePath, index);
  return {
    id: requiredString(value.id, filePath, `reviewVerdicts[${index}].id`),
    idempotencyKey: requiredString(value.idempotencyKey, filePath, `reviewVerdicts[${index}].idempotencyKey`),
    runId: requiredString(value.runId, filePath, `reviewVerdicts[${index}].runId`),
    issueId: requiredString(value.issueId, filePath, `reviewVerdicts[${index}].issueId`),
    issueIdentifier: requiredString(value.issueIdentifier, filePath, `reviewVerdicts[${index}].issueIdentifier`),
    projectContext: normalizeStoredProjectContext(value.projectContext, fallbackProjectContext),
    verdict: value.verdict,
    acceptanceResults: normalizeReviewVerdictAcceptanceResults(value.acceptanceResults, filePath, index),
    findings,
    gateFindings,
    discoveryFindings,
    evidence,
    reviewer: nullableString(value.reviewer, filePath, `reviewVerdicts[${index}].reviewer`),
    submittedAt: requiredString(value.submittedAt, filePath, `reviewVerdicts[${index}].submittedAt`),
    writebackOperationKeys: requiredStringArray(value.writebackOperationKeys, filePath, `reviewVerdicts[${index}].writebackOperationKeys`),
    ...normalizeSupersessionFields(value, filePath, `reviewVerdicts[${index}]`),
  };
}

function normalizeReviewVerdictSubmission(
  value: unknown,
  filePath: string,
  index: number,
  fallbackProjectContext: ProjectContextResolution,
): IssueReviewVerdictSubmissionRecord {
  if (!isRecord(value)) throw corruptLifecycle(filePath, `reviewVerdictSubmissions[${index}] is invalid`);
  if (value.verdict !== "pass" && value.verdict !== "fail" && value.verdict !== "blocked") {
    throw corruptLifecycle(filePath, `reviewVerdictSubmissions[${index}].verdict is invalid`);
  }
  const status = value.status === undefined ? "pending" : value.status;
  if (status !== "pending" && status !== "applied" && status !== "superseded") {
    throw corruptLifecycle(filePath, `reviewVerdictSubmissions[${index}].status is invalid`);
  }
  const findings = requiredStringArray(value.findings, filePath, `reviewVerdictSubmissions[${index}].findings`);
  const evidence = requiredStringArray(value.evidence, filePath, `reviewVerdictSubmissions[${index}].evidence`);
  const gateFindings =
    value.gateFindings === undefined
      ? value.verdict === "blocked"
        ? []
        : legacyGateFindingsFromFindings(findings, evidence)
      : normalizeReviewGateFindings(value.gateFindings, filePath, index);
  const discoveryFindings =
    value.discoveryFindings === undefined
      ? []
      : normalizeReviewDiscoveryFindings(value.discoveryFindings, filePath, index);
  return {
    id: requiredString(value.id, filePath, `reviewVerdictSubmissions[${index}].id`),
    idempotencyKey: requiredString(
      value.idempotencyKey,
      filePath,
      `reviewVerdictSubmissions[${index}].idempotencyKey`,
    ),
    runId: requiredString(value.runId, filePath, `reviewVerdictSubmissions[${index}].runId`),
    issueId: requiredString(value.issueId, filePath, `reviewVerdictSubmissions[${index}].issueId`),
    issueIdentifier: requiredString(
      value.issueIdentifier,
      filePath,
      `reviewVerdictSubmissions[${index}].issueIdentifier`,
    ),
    projectContext: normalizeStoredProjectContext(value.projectContext, fallbackProjectContext),
    verdict: value.verdict,
    acceptanceResults: normalizeReviewVerdictAcceptanceResults(value.acceptanceResults, filePath, index),
    findings,
    gateFindings,
    discoveryFindings,
    evidence,
    reviewer: nullableString(value.reviewer, filePath, `reviewVerdictSubmissions[${index}].reviewer`),
    submittedAt: requiredString(value.submittedAt, filePath, `reviewVerdictSubmissions[${index}].submittedAt`),
    status,
    ignoreStateGate: value.ignoreStateGate === true,
    appliedAt: optionalNullableString(value.appliedAt, filePath, `reviewVerdictSubmissions[${index}].appliedAt`),
    acceptedVerdictId: optionalNullableString(
      value.acceptedVerdictId,
      filePath,
      `reviewVerdictSubmissions[${index}].acceptedVerdictId`,
    ),
    supersededAt: optionalNullableString(
      value.supersededAt,
      filePath,
      `reviewVerdictSubmissions[${index}].supersededAt`,
    ),
    supersededReason: optionalNullableString(
      value.supersededReason,
      filePath,
      `reviewVerdictSubmissions[${index}].supersededReason`,
    ),
  };
}

function normalizeMergeGateResult(value: unknown, filePath: string, index: number): IssueMergeGateResultRecord {
  if (!isRecord(value)) throw corruptLifecycle(filePath, `mergeGateResults[${index}] is invalid`);
  const status = value.status;
  if (!isMergeGateResultStatus(status)) throw corruptLifecycle(filePath, `mergeGateResults[${index}].status is invalid`);
  return {
    id: requiredString(value.id, filePath, `mergeGateResults[${index}].id`),
    idempotencyKey: requiredString(value.idempotencyKey, filePath, `mergeGateResults[${index}].idempotencyKey`),
    runId: requiredString(value.runId, filePath, `mergeGateResults[${index}].runId`),
    issueId: requiredString(value.issueId, filePath, `mergeGateResults[${index}].issueId`),
    issueIdentifier: requiredString(value.issueIdentifier, filePath, `mergeGateResults[${index}].issueIdentifier`),
    status,
    headSha: requiredString(value.headSha, filePath, `mergeGateResults[${index}].headSha`),
    pullRequest: normalizeMergeGatePullRequest(value.pullRequest, filePath),
    requiredChecks: requiredStringArray(value.requiredChecks, filePath, `mergeGateResults[${index}].requiredChecks`),
    checks: normalizeMergeGateChecks(value.checks, filePath, `mergeGateResults[${index}].checks`),
    mergeability: normalizeMergeGateMergeability(value.mergeability, filePath, `mergeGateResults[${index}].mergeability`),
    reviewRound: nonNegativeInteger(value.reviewRound, filePath, `mergeGateResults[${index}].reviewRound`),
    blockerFingerprint: optionalNullableString(value.blockerFingerprint, filePath, `mergeGateResults[${index}].blockerFingerprint`),
    findings: requiredStringArray(value.findings, filePath, `mergeGateResults[${index}].findings`),
    evidence: requiredStringArray(value.evidence, filePath, `mergeGateResults[${index}].evidence`),
    submittedAt: requiredString(value.submittedAt, filePath, `mergeGateResults[${index}].submittedAt`),
    writebackOperationKeys: requiredStringArray(value.writebackOperationKeys, filePath, `mergeGateResults[${index}].writebackOperationKeys`),
    ...normalizeSupersessionFields(value, filePath, `mergeGateResults[${index}]`),
  };
}

function normalizeReviewFeedbackRecord(
  value: unknown,
  filePath: string,
  index: number,
  fallbackProjectContext: ProjectContextResolution,
): IssueReviewFeedbackRecord {
  if (!isRecord(value)) throw corruptLifecycle(filePath, `reviewFeedback[${index}] is invalid`);
  const kind = value.kind;
  if (kind !== "review" && kind !== "review_comment" && kind !== "issue_comment") {
    throw corruptLifecycle(filePath, `reviewFeedback[${index}].kind is invalid`);
  }
  const event = optionalNullableString(value.event, filePath, `reviewFeedback[${index}].event`);
  if (event !== null && event !== "APPROVE" && event !== "REQUEST_CHANGES" && event !== "COMMENT") {
    throw corruptLifecycle(filePath, `reviewFeedback[${index}].event is invalid`);
  }
  return {
    id: requiredString(value.id, filePath, `reviewFeedback[${index}].id`),
    idempotencyKey: requiredString(value.idempotencyKey, filePath, `reviewFeedback[${index}].idempotencyKey`),
    requestHash: requiredString(value.requestHash, filePath, `reviewFeedback[${index}].requestHash`),
    runId: requiredString(value.runId, filePath, `reviewFeedback[${index}].runId`),
    issueId: requiredString(value.issueId, filePath, `reviewFeedback[${index}].issueId`),
    issueIdentifier: requiredString(value.issueIdentifier, filePath, `reviewFeedback[${index}].issueIdentifier`),
    projectContext: normalizeStoredProjectContext(value.projectContext, fallbackProjectContext),
    kind,
    event,
    body: requiredString(value.body, filePath, `reviewFeedback[${index}].body`),
    pullRequest: normalizeReviewFeedbackPullRequest(value.pullRequest, filePath, index),
    reviewer: optionalNullableString(value.reviewer, filePath, `reviewFeedback[${index}].reviewer`),
    reviewUrl: optionalNullableString(value.reviewUrl, filePath, `reviewFeedback[${index}].reviewUrl`),
    commentUrls: requiredStringArray(value.commentUrls, filePath, `reviewFeedback[${index}].commentUrls`),
    submittedAt: requiredString(value.submittedAt, filePath, `reviewFeedback[${index}].submittedAt`),
  };
}

function normalizeIssueTriageReport(value: unknown, filePath: string, index: number): IssueTriageReportRecord {
  if (!isRecord(value)) throw corruptLifecycle(filePath, `issueTriageReports[${index}] is invalid`);
  const summary = requiredString(value.summary, filePath, `issueTriageReports[${index}].summary`);
  const normalizedBlockers =
    value.blockers === undefined ? null : normalizeIssueTriageBlockers(value.blockers, filePath, index);
  const primaryBlocker = normalizedBlockers === null ? null : primaryIssueTriageBlockerForLegacyFields(normalizedBlockers);
  const disposition =
    value.disposition === undefined
      ? primaryBlocker === null
        ? normalizeIssueTriageDisposition(value.disposition, filePath, `issueTriageReports[${index}].disposition`)
        : legacyDispositionForIssueTriageBlocker(primaryBlocker.kind)
      : normalizeIssueTriageDisposition(value.disposition, filePath, `issueTriageReports[${index}].disposition`);
  const confidence =
    value.confidence === undefined
      ? primaryBlocker === null
        ? normalizeIssueTriageConfidence(value.confidence, filePath, `issueTriageReports[${index}].confidence`)
        : primaryBlocker.confidence
      : normalizeIssueTriageConfidence(value.confidence, filePath, `issueTriageReports[${index}].confidence`);
  const evidence =
    value.evidence === undefined
      ? primaryBlocker === null
        ? requiredStringArray(value.evidence, filePath, `issueTriageReports[${index}].evidence`)
        : primaryBlocker.evidence
      : requiredStringArray(value.evidence, filePath, `issueTriageReports[${index}].evidence`);
  const recommendedAction =
    value.recommendedAction === undefined
      ? primaryBlocker === null
        ? requiredString(value.recommendedAction, filePath, `issueTriageReports[${index}].recommendedAction`)
        : primaryBlocker.recommendedAction
      : requiredString(value.recommendedAction, filePath, `issueTriageReports[${index}].recommendedAction`);
  return {
    id: requiredString(value.id, filePath, `issueTriageReports[${index}].id`),
    idempotencyKey: requiredString(value.idempotencyKey, filePath, `issueTriageReports[${index}].idempotencyKey`),
    requestHash: requiredString(value.requestHash, filePath, `issueTriageReports[${index}].requestHash`),
    runId: requiredString(value.runId, filePath, `issueTriageReports[${index}].runId`),
    issueId: requiredString(value.issueId, filePath, `issueTriageReports[${index}].issueId`),
    issueIdentifier: requiredString(value.issueIdentifier, filePath, `issueTriageReports[${index}].issueIdentifier`),
    triggerFingerprint: requiredString(value.triggerFingerprint, filePath, `issueTriageReports[${index}].triggerFingerprint`),
    disposition,
    confidence,
    summary,
    evidence,
    recommendedAction,
    blockers:
      normalizedBlockers === null
        ? [
            {
              kind: legacyIssueTriageBlockerKind(disposition),
              status: "active",
              nextActor: legacyIssueTriageNextActor(disposition),
              confidence,
              summary,
              evidence,
              recommendedAction,
            },
          ]
        : normalizedBlockers,
    submittedAt: requiredString(value.submittedAt, filePath, `issueTriageReports[${index}].submittedAt`),
    writebackOperationKeys:
      value.writebackOperationKeys === undefined
        ? []
        : requiredStringArray(value.writebackOperationKeys, filePath, `issueTriageReports[${index}].writebackOperationKeys`),
    ...normalizeSupersessionFields(value, filePath, `issueTriageReports[${index}]`),
  };
}

function normalizePostMortemReport(value: unknown, filePath: string, index: number): IssuePostMortemReportRecord {
  if (!isRecord(value)) throw corruptLifecycle(filePath, `postMortemReports[${index}] is invalid`);
  return {
    id: requiredString(value.id, filePath, `postMortemReports[${index}].id`),
    idempotencyKey: requiredString(value.idempotencyKey, filePath, `postMortemReports[${index}].idempotencyKey`),
    requestHash: requiredString(value.requestHash, filePath, `postMortemReports[${index}].requestHash`),
    runId: requiredString(value.runId, filePath, `postMortemReports[${index}].runId`),
    issueId: requiredString(value.issueId, filePath, `postMortemReports[${index}].issueId`),
    issueIdentifier: requiredString(value.issueIdentifier, filePath, `postMortemReports[${index}].issueIdentifier`),
    triggerFingerprint: requiredString(value.triggerFingerprint, filePath, `postMortemReports[${index}].triggerFingerprint`),
    summary: requiredString(value.summary, filePath, `postMortemReports[${index}].summary`),
    completionJudgment: normalizePostMortemCompletionJudgment(value.completionJudgment, filePath, index),
    specificationAssessment: normalizePostMortemSpecificationAssessment(value.specificationAssessment, filePath, index),
    reviewAssessment: normalizePostMortemReviewAssessment(value.reviewAssessment, filePath, index),
    followUpCandidates: normalizePostMortemFollowUpCandidates(value.followUpCandidates, filePath, index),
    processLessons: requiredStringArray(value.processLessons, filePath, `postMortemReports[${index}].processLessons`),
    submittedAt: requiredString(value.submittedAt, filePath, `postMortemReports[${index}].submittedAt`),
    writebackOperationKeys:
      value.writebackOperationKeys === undefined
        ? []
        : requiredStringArray(value.writebackOperationKeys, filePath, `postMortemReports[${index}].writebackOperationKeys`),
  };
}

function normalizePostMortemCompletionJudgment(
  value: unknown,
  filePath: string,
  reportIndex: number,
): IssuePostMortemCompletionJudgmentRecord {
  if (!isRecord(value)) throw corruptLifecycle(filePath, `postMortemReports[${reportIndex}].completionJudgment is invalid`);
  return {
    status: normalizePostMortemCompletionStatus(
      value.status,
      filePath,
      `postMortemReports[${reportIndex}].completionJudgment.status`,
    ),
    rationale: requiredString(value.rationale, filePath, `postMortemReports[${reportIndex}].completionJudgment.rationale`),
  };
}

function normalizePostMortemSpecificationAssessment(
  value: unknown,
  filePath: string,
  reportIndex: number,
): IssuePostMortemSpecificationAssessmentRecord {
  if (!isRecord(value)) throw corruptLifecycle(filePath, `postMortemReports[${reportIndex}].specificationAssessment is invalid`);
  return {
    quality: normalizePostMortemSpecificationQuality(
      value.quality,
      filePath,
      `postMortemReports[${reportIndex}].specificationAssessment.quality`,
    ),
    classifications: requiredArray(
      value.classifications,
      filePath,
      `postMortemReports[${reportIndex}].specificationAssessment.classifications`,
    ).map((item, index) =>
      normalizePostMortemSpecificationClassification(
        item,
        filePath,
        `postMortemReports[${reportIndex}].specificationAssessment.classifications[${index}]`,
      ),
    ),
    missingContractAreas: requiredStringArray(
      value.missingContractAreas,
      filePath,
      `postMortemReports[${reportIndex}].specificationAssessment.missingContractAreas`,
    ),
    speckitRecommended: requiredBoolean(
      value.speckitRecommended,
      filePath,
      `postMortemReports[${reportIndex}].specificationAssessment.speckitRecommended`,
    ),
    speckitRationale: requiredString(
      value.speckitRationale,
      filePath,
      `postMortemReports[${reportIndex}].specificationAssessment.speckitRationale`,
    ),
  };
}

function normalizePostMortemReviewAssessment(
  value: unknown,
  filePath: string,
  reportIndex: number,
): IssuePostMortemReviewAssessmentRecord {
  if (!isRecord(value)) throw corruptLifecycle(filePath, `postMortemReports[${reportIndex}].reviewAssessment is invalid`);
  return {
    gateDecisionLooksValid: requiredBoolean(
      value.gateDecisionLooksValid,
      filePath,
      `postMortemReports[${reportIndex}].reviewAssessment.gateDecisionLooksValid`,
    ),
    missedGateFindings: requiredStringArray(
      value.missedGateFindings,
      filePath,
      `postMortemReports[${reportIndex}].reviewAssessment.missedGateFindings`,
    ),
    missedDiscoveryFindings: requiredStringArray(
      value.missedDiscoveryFindings,
      filePath,
      `postMortemReports[${reportIndex}].reviewAssessment.missedDiscoveryFindings`,
    ),
  };
}

function normalizePostMortemFollowUpCandidates(
  value: unknown,
  filePath: string,
  reportIndex: number,
): IssuePostMortemFollowUpCandidateRecord[] {
  if (!Array.isArray(value)) throw corruptLifecycle(filePath, `postMortemReports[${reportIndex}].followUpCandidates is invalid`);
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw corruptLifecycle(filePath, `postMortemReports[${reportIndex}].followUpCandidates[${index}] is invalid`);
    }
    return {
      title: requiredString(item.title, filePath, `postMortemReports[${reportIndex}].followUpCandidates[${index}].title`),
      priority: normalizePostMortemFollowUpPriority(
        item.priority,
        filePath,
        `postMortemReports[${reportIndex}].followUpCandidates[${index}].priority`,
      ),
      kind: normalizePostMortemFollowUpKind(
        item.kind,
        filePath,
        `postMortemReports[${reportIndex}].followUpCandidates[${index}].kind`,
      ),
      rationale: requiredString(item.rationale, filePath, `postMortemReports[${reportIndex}].followUpCandidates[${index}].rationale`),
      readyForSpecKit: requiredBoolean(
        item.readyForSpecKit,
        filePath,
        `postMortemReports[${reportIndex}].followUpCandidates[${index}].readyForSpecKit`,
      ),
      suggestedIssueContract: optionalNullableString(
        item.suggestedIssueContract,
        filePath,
        `postMortemReports[${reportIndex}].followUpCandidates[${index}].suggestedIssueContract`,
      ),
    };
  });
}

function normalizePostMortemCompletionStatus(
  value: unknown,
  filePath: string,
  field: string,
): IssuePostMortemCompletionStatus {
  if (value === "valid_done" || value === "valid_with_followups" || value === "questionable_done") return value;
  throw corruptLifecycle(filePath, `${field} is invalid`);
}

function normalizePostMortemSpecificationQuality(
  value: unknown,
  filePath: string,
  field: string,
): IssuePostMortemSpecificationQuality {
  if (value === "strong" || value === "adequate" || value === "weak") return value;
  throw corruptLifecycle(filePath, `${field} is invalid`);
}

function normalizePostMortemSpecificationClassification(
  value: unknown,
  filePath: string,
  field: string,
): IssuePostMortemSpecificationClassification {
  if (
    value === "well_scoped" ||
    value === "underspecified" ||
    value === "overbroad" ||
    value === "speckit_candidate" ||
    value === "needs_clarification"
  ) {
    return value;
  }
  throw corruptLifecycle(filePath, `${field} is invalid`);
}

function normalizePostMortemFollowUpPriority(
  value: unknown,
  filePath: string,
  field: string,
): IssuePostMortemFollowUpPriority {
  if (value === "high" || value === "medium" || value === "low") return value;
  throw corruptLifecycle(filePath, `${field} is invalid`);
}

function normalizePostMortemFollowUpKind(value: unknown, filePath: string, field: string): IssuePostMortemFollowUpKind {
  if (value === "hardening" || value === "test_gap" || value === "scope_gap" || value === "refactor" || value === "process_gap") {
    return value;
  }
  throw corruptLifecycle(filePath, `${field} is invalid`);
}

function normalizeIssueTriageDisposition(
  value: unknown,
  filePath: string,
  field: string,
): IssueTriageDisposition {
  if (
    value === "decompose_issue" ||
    value === "implementation_repair" ||
    value === "validation_repair" ||
    value === "compatibility_matrix_repair" ||
    value === "retarget_or_split_pr" ||
    value === "close_or_retarget_issue" ||
    value === "merge_gate_repair" ||
    value === "process_gate_repair" ||
    value === "infra_repair" ||
    value === "orchestrator_context_repair" ||
    value === "manual_decision"
  ) {
    return value;
  }
  throw corruptLifecycle(filePath, `${field} is invalid`);
}

function normalizeIssueTriageConfidence(value: unknown, filePath: string, field: string): IssueTriageConfidence {
  if (value === "high" || value === "medium" || value === "low") return value;
  throw corruptLifecycle(filePath, `${field} is invalid`);
}

function normalizeIssueTriageBlockers(value: unknown, filePath: string, reportIndex: number): IssueTriageBlockerRecord[] {
  if (!Array.isArray(value) || value.length === 0) throw corruptLifecycle(filePath, `issueTriageReports[${reportIndex}].blockers is invalid`);
  return value
    .map((item, index) => normalizeIssueTriageBlocker(item, filePath, reportIndex, index))
    .sort(compareIssueTriageBlockers);
}

function normalizeIssueTriageBlocker(
  value: unknown,
  filePath: string,
  reportIndex: number,
  blockerIndex: number,
): IssueTriageBlockerRecord {
  if (!isRecord(value)) throw corruptLifecycle(filePath, `issueTriageReports[${reportIndex}].blockers[${blockerIndex}] is invalid`);
  return {
    kind: normalizeIssueTriageBlockerKind(value.kind, filePath, `issueTriageReports[${reportIndex}].blockers[${blockerIndex}].kind`),
    status: normalizeIssueTriageBlockerStatus(value.status, filePath, `issueTriageReports[${reportIndex}].blockers[${blockerIndex}].status`),
    nextActor: normalizeIssueTriageBlockerNextActor(
      value.nextActor,
      filePath,
      `issueTriageReports[${reportIndex}].blockers[${blockerIndex}].nextActor`,
    ),
    confidence: normalizeIssueTriageConfidence(value.confidence, filePath, `issueTriageReports[${reportIndex}].blockers[${blockerIndex}].confidence`),
    summary: requiredString(value.summary, filePath, `issueTriageReports[${reportIndex}].blockers[${blockerIndex}].summary`),
    evidence: requiredStringArray(value.evidence, filePath, `issueTriageReports[${reportIndex}].blockers[${blockerIndex}].evidence`),
    recommendedAction: requiredString(
      value.recommendedAction,
      filePath,
      `issueTriageReports[${reportIndex}].blockers[${blockerIndex}].recommendedAction`,
    ),
  };
}

function normalizeIssueTriageBlockerKind(value: unknown, filePath: string, field: string): IssueTriageBlockerKind {
  if (
    value === "under_specified_needs_decomposition" ||
    value === "implementation_unsatisfied_requirements" ||
    value === "validation_or_test_failure" ||
    value === "compatibility_matrix_gap" ||
    value === "orchestrator_context_or_prompt_gap" ||
    value === "infra_or_tooling_failure" ||
    value === "pr_target_or_scope_mismatch" ||
    value === "merge_conflict" ||
    value === "merge_gate_check_failure" ||
    value === "pr_review_gate" ||
    value === "manual_decision"
  ) {
    return value;
  }
  throw corruptLifecycle(filePath, `${field} is invalid`);
}

function normalizeIssueTriageBlockerStatus(value: unknown, filePath: string, field: string): IssueTriageBlockerStatus {
  if (value === "active" || value === "downstream") return value;
  throw corruptLifecycle(filePath, `${field} is invalid`);
}

function normalizeIssueTriageBlockerNextActor(value: unknown, filePath: string, field: string): IssueTriageBlockerNextActor {
  if (
    value === "planner" ||
    value === "worker" ||
    value === "reviewer" ||
    value === "merge_conflict_worker" ||
    value === "operator" ||
    value === "orchestrator" ||
    value === "infra"
  ) {
    return value;
  }
  throw corruptLifecycle(filePath, `${field} is invalid`);
}

function legacyIssueTriageBlockerKind(disposition: IssueTriageDisposition): IssueTriageBlockerKind {
  switch (disposition) {
    case "decompose_issue":
      return "under_specified_needs_decomposition";
    case "implementation_repair":
      return "implementation_unsatisfied_requirements";
    case "validation_repair":
      return "validation_or_test_failure";
    case "compatibility_matrix_repair":
      return "compatibility_matrix_gap";
    case "retarget_or_split_pr":
    case "close_or_retarget_issue":
      return "pr_target_or_scope_mismatch";
    case "merge_gate_repair":
      return "merge_gate_check_failure";
    case "process_gate_repair":
    case "orchestrator_context_repair":
      return "orchestrator_context_or_prompt_gap";
    case "infra_repair":
      return "infra_or_tooling_failure";
    case "manual_decision":
      return "manual_decision";
  }
}

function legacyIssueTriageNextActor(disposition: IssueTriageDisposition): IssueTriageBlockerNextActor {
  switch (disposition) {
    case "decompose_issue":
      return "planner";
    case "implementation_repair":
    case "validation_repair":
    case "compatibility_matrix_repair":
    case "merge_gate_repair":
      return "worker";
    case "process_gate_repair":
    case "orchestrator_context_repair":
      return "orchestrator";
    case "infra_repair":
      return "infra";
    case "retarget_or_split_pr":
    case "close_or_retarget_issue":
    case "manual_decision":
      return "operator";
  }
}

function legacyDispositionForIssueTriageBlocker(kind: IssueTriageBlockerKind): IssueTriageDisposition {
  switch (kind) {
    case "under_specified_needs_decomposition":
      return "decompose_issue";
    case "implementation_unsatisfied_requirements":
      return "implementation_repair";
    case "validation_or_test_failure":
      return "validation_repair";
    case "compatibility_matrix_gap":
      return "compatibility_matrix_repair";
    case "pr_target_or_scope_mismatch":
      return "retarget_or_split_pr";
    case "merge_conflict":
    case "merge_gate_check_failure":
    case "pr_review_gate":
      return "merge_gate_repair";
    case "orchestrator_context_or_prompt_gap":
      return "orchestrator_context_repair";
    case "infra_or_tooling_failure":
      return "infra_repair";
    case "manual_decision":
      return "manual_decision";
  }
}

function compareIssueTriageBlockers(left: IssueTriageBlockerRecord, right: IssueTriageBlockerRecord): number {
  const precedence = issueTriageBlockerPrecedence(left.kind) - issueTriageBlockerPrecedence(right.kind);
  if (precedence !== 0) return precedence;
  const status = issueTriageBlockerStatusRank(left.status) - issueTriageBlockerStatusRank(right.status);
  if (status !== 0) return status;
  const actor = left.nextActor.localeCompare(right.nextActor);
  if (actor !== 0) return actor;
  return left.summary.localeCompare(right.summary);
}

function issueTriageBlockerPrecedence(kind: IssueTriageBlockerKind): number {
  switch (kind) {
    case "under_specified_needs_decomposition":
      return 10;
    case "implementation_unsatisfied_requirements":
      return 20;
    case "validation_or_test_failure":
      return 30;
    case "compatibility_matrix_gap":
      return 40;
    case "orchestrator_context_or_prompt_gap":
      return 50;
    case "infra_or_tooling_failure":
      return 60;
    case "pr_target_or_scope_mismatch":
      return 70;
    case "merge_conflict":
      return 80;
    case "merge_gate_check_failure":
      return 90;
    case "pr_review_gate":
      return 100;
    case "manual_decision":
      return 110;
  }
}

function issueTriageBlockerStatusRank(status: IssueTriageBlockerStatus): number {
  return status === "active" ? 0 : 1;
}

function primaryIssueTriageBlockerForLegacyFields(blockers: readonly IssueTriageBlockerRecord[]): IssueTriageBlockerRecord | null {
  const active = blockers.filter((blocker) => blocker.status === "active");
  return active[0] ?? blockers[0] ?? null;
}

function normalizeMergeGateState(value: unknown, filePath: string): IssueMergeGateState | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw corruptLifecycle(filePath, "mergeGate is invalid");
  const status = value.status;
  if (!isMergeGateStatus(status)) throw corruptLifecycle(filePath, "mergeGate.status is invalid");
  return {
    id: requiredString(value.id, filePath, "mergeGate.id"),
    status,
    headSha: requiredString(value.headSha, filePath, "mergeGate.headSha"),
    pullRequest: normalizeMergeGatePullRequest(value.pullRequest, filePath),
    requiredChecks: requiredStringArray(value.requiredChecks, filePath, "mergeGate.requiredChecks"),
    checks: normalizeMergeGateChecks(value.checks, filePath, "mergeGate.checks"),
    mergeability: normalizeMergeGateMergeability(value.mergeability, filePath, "mergeGate.mergeability"),
    reviewRound: nonNegativeInteger(value.reviewRound, filePath, "mergeGate.reviewRound"),
    gateRunId: optionalNullableString(value.gateRunId, filePath, "mergeGate.gateRunId"),
    gateReportId: optionalNullableString(value.gateReportId, filePath, "mergeGate.gateReportId"),
    repairRunId: optionalNullableString(value.repairRunId, filePath, "mergeGate.repairRunId"),
    repairReportId: optionalNullableString(value.repairReportId, filePath, "mergeGate.repairReportId"),
    blockerFingerprint: optionalNullableString(value.blockerFingerprint, filePath, "mergeGate.blockerFingerprint"),
    writebackOperationKeys: requiredStringArray(value.writebackOperationKeys, filePath, "mergeGate.writebackOperationKeys"),
    supersededByHeadSha: optionalNullableString(value.supersededByHeadSha, filePath, "mergeGate.supersededByHeadSha"),
    updatedAt: requiredString(value.updatedAt, filePath, "mergeGate.updatedAt"),
  };
}

function normalizeMergeGateChecks(value: unknown, filePath: string, fieldPath: string): IssueMergeGateCheckState[] {
  if (!Array.isArray(value)) throw corruptLifecycle(filePath, `${fieldPath} is invalid`);
  return value.map((item, index) => {
    if (!isRecord(item)) throw corruptLifecycle(filePath, `${fieldPath}[${index}] is invalid`);
    const outcome = item.outcome;
    if (!isMergeGateCheckOutcome(outcome)) throw corruptLifecycle(filePath, `${fieldPath}[${index}].outcome is invalid`);
    const rawStatus = item.rawStatus;
    if (!isMergeGateRawCheckStatus(rawStatus)) throw corruptLifecycle(filePath, `${fieldPath}[${index}].rawStatus is invalid`);
    return {
      name: requiredString(item.name, filePath, `${fieldPath}[${index}].name`),
      outcome,
      rawStatus,
      conclusion: optionalNullableString(item.conclusion, filePath, `${fieldPath}[${index}].conclusion`),
      url: optionalNullableString(item.url, filePath, `${fieldPath}[${index}].url`),
      firstObservedAt: optionalNullableString(item.firstObservedAt, filePath, `${fieldPath}[${index}].firstObservedAt`),
      actionableSince: optionalNullableString(item.actionableSince, filePath, `${fieldPath}[${index}].actionableSince`),
    };
  });
}

function normalizeMergeGateMergeability(
  value: unknown,
  filePath: string,
  fieldPath: string,
): IssueMergeGateMergeabilityState | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw corruptLifecycle(filePath, `${fieldPath} is invalid`);
  const status = value.status;
  if (!isMergeGateMergeabilityStatus(status)) throw corruptLifecycle(filePath, `${fieldPath}.status is invalid`);
  return {
    status,
    pullRequest: normalizeMergeGatePullRequest(value.pullRequest, filePath),
    mergeable: optionalNullableBoolean(value.mergeable, filePath, `${fieldPath}.mergeable`),
    mergeableState: optionalNullableString(value.mergeableState, filePath, `${fieldPath}.mergeableState`),
    reason: optionalNullableString(value.reason, filePath, `${fieldPath}.reason`),
    baseBranch: optionalNullableString(value.baseBranch, filePath, `${fieldPath}.baseBranch`),
    baseHeadSha: optionalNullableString(value.baseHeadSha, filePath, `${fieldPath}.baseHeadSha`),
    observedBaseHeadSha: optionalNullableString(
      value.observedBaseHeadSha,
      filePath,
      `${fieldPath}.observedBaseHeadSha`,
    ),
    checkedAt: requiredString(value.checkedAt, filePath, `${fieldPath}.checkedAt`),
  };
}

function normalizeMergeGatePullRequest(value: unknown, filePath: string): CompletionReportPullRequestRef {
  if (!isRecord(value)) throw corruptLifecycle(filePath, "mergeGate.pullRequest is invalid");
  return {
    url: nullableString(value.url, filePath, "mergeGate.pullRequest.url"),
    number: nullableNumber(value.number, filePath, "mergeGate.pullRequest.number"),
    headSha: optionalNullableString(value.headSha, filePath, "mergeGate.pullRequest.headSha"),
    branch: optionalNullableString(value.branch, filePath, "mergeGate.pullRequest.branch"),
  };
}

function normalizeMergeMetadata(value: unknown, filePath: string): IssueMergeMetadata | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw corruptLifecycle(filePath, "merge is invalid");
  const mergedBy = value.mergedBy;
  if (!isRecord(mergedBy)) throw corruptLifecycle(filePath, "merge.mergedBy is invalid");
  if (mergedBy.capability !== "github.merge") throw corruptLifecycle(filePath, "merge.mergedBy.capability is invalid");
  const checkStatus = value.checkStatus;
  if (!isRecord(checkStatus)) throw corruptLifecycle(filePath, "merge.checkStatus is invalid");
  return {
    id: requiredString(value.id, filePath, "merge.id"),
    pullRequest: normalizeMergePullRequest(value.pullRequest, filePath),
    headSha: requiredString(value.headSha, filePath, "merge.headSha"),
    mergeCommitSha: requiredString(value.mergeCommitSha, filePath, "merge.mergeCommitSha"),
    mergedAt: requiredString(value.mergedAt, filePath, "merge.mergedAt"),
    mergedBy: {
      login: optionalNullableString(mergedBy.login, filePath, "merge.mergedBy.login"),
      profile: optionalNullableString(mergedBy.profile, filePath, "merge.mergedBy.profile"),
      capability: "github.merge",
    },
    checkStatus: {
      requiredChecks: requiredStringArray(checkStatus.requiredChecks, filePath, "merge.checkStatus.requiredChecks"),
      passedChecks: requiredStringArray(checkStatus.passedChecks, filePath, "merge.checkStatus.passedChecks"),
      noCiEvidence: optionalNullableString(checkStatus.noCiEvidence, filePath, "merge.checkStatus.noCiEvidence"),
    },
    mergeOperationKey: requiredString(value.mergeOperationKey, filePath, "merge.mergeOperationKey"),
    doneTransitionOperationKey: requiredString(
      value.doneTransitionOperationKey,
      filePath,
      "merge.doneTransitionOperationKey",
    ),
  };
}

function normalizeMergeConflictMetadata(value: unknown, filePath: string): IssueMergeConflictMetadata | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw corruptLifecycle(filePath, "mergeConflict is invalid");
  const status = value.status;
  if (status !== "open" && status !== "resolved" && status !== "blocked") {
    throw corruptLifecycle(filePath, "mergeConflict.status is invalid");
  }
  const resolutionStatus = value.resolutionStatus;
  if (
    resolutionStatus !== "pending" &&
    resolutionStatus !== "still_conflicted" &&
    resolutionStatus !== "resolved" &&
    resolutionStatus !== "blocked"
  ) {
    throw corruptLifecycle(filePath, "mergeConflict.resolutionStatus is invalid");
  }
  return {
    id: requiredString(value.id, filePath, "mergeConflict.id"),
    status,
    resolutionStatus,
    pullRequest: normalizeMergePullRequest(value.pullRequest, filePath, "mergeConflict.pullRequest"),
    approvedHeadSha: requiredString(value.approvedHeadSha, filePath, "mergeConflict.approvedHeadSha"),
    currentHeadSha: requiredString(value.currentHeadSha, filePath, "mergeConflict.currentHeadSha"),
    resolvedHeadSha: optionalNullableString(value.resolvedHeadSha, filePath, "mergeConflict.resolvedHeadSha"),
    baseBranch: optionalNullableString(value.baseBranch, filePath, "mergeConflict.baseBranch"),
    baseHeadSha: optionalNullableString(value.baseHeadSha, filePath, "mergeConflict.baseHeadSha"),
    sourceState: requiredString(value.sourceState, filePath, "mergeConflict.sourceState"),
    conflictsState: requiredString(value.conflictsState, filePath, "mergeConflict.conflictsState"),
    reason: requiredString(value.reason, filePath, "mergeConflict.reason"),
    mergeableState: optionalNullableString(value.mergeableState, filePath, "mergeConflict.mergeableState"),
    servicePreparation: normalizeMergeConflictServicePreparation(value.servicePreparation, filePath),
    detectedAt: requiredString(value.detectedAt, filePath, "mergeConflict.detectedAt"),
    updatedAt: requiredString(value.updatedAt, filePath, "mergeConflict.updatedAt"),
    fixTurnCount: nonNegativeInteger(value.fixTurnCount, filePath, "mergeConflict.fixTurnCount"),
    maxFixTurns: nonNegativeInteger(value.maxFixTurns, filePath, "mergeConflict.maxFixTurns"),
    lastConflictFixRunId: optionalNullableString(
      value.lastConflictFixRunId,
      filePath,
      "mergeConflict.lastConflictFixRunId",
    ),
    lastConflictResolutionReportId: optionalNullableString(
      value.lastConflictResolutionReportId,
      filePath,
      "mergeConflict.lastConflictResolutionReportId",
    ),
    attemptRunIds: value.attemptRunIds === undefined ? [] : requiredStringArray(value.attemptRunIds, filePath, "mergeConflict.attemptRunIds"),
    writebackOperationKeys:
      value.writebackOperationKeys === undefined
        ? []
        : requiredStringArray(value.writebackOperationKeys, filePath, "mergeConflict.writebackOperationKeys"),
    blockedAt: optionalNullableString(value.blockedAt, filePath, "mergeConflict.blockedAt"),
    blockedReason: optionalNullableString(value.blockedReason, filePath, "mergeConflict.blockedReason"),
  };
}

function normalizeMergeConflictServicePreparation(
  value: unknown,
  filePath: string,
): IssueMergeConflictServicePreparation | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw corruptLifecycle(filePath, "mergeConflict.servicePreparation is invalid");
  if (value.strategy === "stash_apply") return normalizeStashApplyServicePreparation(value, filePath);
  if (value.strategy !== "squash_rebase") throw corruptLifecycle(filePath, "mergeConflict.servicePreparation.strategy is invalid");
  const status = value.status;
  if (status !== "conflicted" && status !== "clean" && status !== "finalized") {
    throw corruptLifecycle(filePath, "mergeConflict.servicePreparation.status is invalid");
  }
  return {
    strategy: "squash_rebase",
    status,
    originalHeadSha: requiredString(value.originalHeadSha, filePath, "mergeConflict.servicePreparation.originalHeadSha"),
    observedPrBaseHeadSha: optionalNullableString(
      value.observedPrBaseHeadSha,
      filePath,
      "mergeConflict.servicePreparation.observedPrBaseHeadSha",
    ),
    liveBaseHeadSha: requiredString(value.liveBaseHeadSha, filePath, "mergeConflict.servicePreparation.liveBaseHeadSha"),
    preparedBaseHeadSha: requiredString(
      value.preparedBaseHeadSha,
      filePath,
      "mergeConflict.servicePreparation.preparedBaseHeadSha",
    ),
    mergeBaseSha: requiredString(value.mergeBaseSha, filePath, "mergeConflict.servicePreparation.mergeBaseSha"),
    squashCommitSha: optionalNullableString(
      value.squashCommitSha,
      filePath,
      "mergeConflict.servicePreparation.squashCommitSha",
    ),
    conflictedFiles: requiredStringArray(
      value.conflictedFiles,
      filePath,
      "mergeConflict.servicePreparation.conflictedFiles",
    ),
    preparedAt: requiredString(value.preparedAt, filePath, "mergeConflict.servicePreparation.preparedAt"),
    finalizedAt: optionalNullableString(value.finalizedAt, filePath, "mergeConflict.servicePreparation.finalizedAt"),
    finalizedHeadSha: optionalNullableString(
      value.finalizedHeadSha,
      filePath,
      "mergeConflict.servicePreparation.finalizedHeadSha",
    ),
    preservedStash: normalizePreservedWorktreeStash(
      value.preservedStash,
      filePath,
      "mergeConflict.servicePreparation.preservedStash",
    ),
  };
}

function normalizeStashApplyServicePreparation(
  value: Record<string, unknown>,
  filePath: string,
): IssueStashApplyMergeConflictServicePreparation {
  const status = value.status;
  if (status !== "conflicted" && status !== "finalized") {
    throw corruptLifecycle(filePath, "mergeConflict.servicePreparation.status is invalid");
  }
  return {
    strategy: "stash_apply",
    status,
    originalHeadSha: requiredString(value.originalHeadSha, filePath, "mergeConflict.servicePreparation.originalHeadSha"),
    currentHeadSha: requiredString(value.currentHeadSha, filePath, "mergeConflict.servicePreparation.currentHeadSha"),
    conflictedFiles: requiredStringArray(
      value.conflictedFiles,
      filePath,
      "mergeConflict.servicePreparation.conflictedFiles",
    ),
    allowedFiles: requiredStringArray(
      value.allowedFiles,
      filePath,
      "mergeConflict.servicePreparation.allowedFiles",
    ),
    preservedStash: requiredPreservedWorktreeStash(
      value.preservedStash,
      filePath,
      "mergeConflict.servicePreparation.preservedStash",
    ),
    preparedAt: requiredString(value.preparedAt, filePath, "mergeConflict.servicePreparation.preparedAt"),
    finalizedAt: optionalNullableString(value.finalizedAt, filePath, "mergeConflict.servicePreparation.finalizedAt"),
    finalizedHeadSha: optionalNullableString(
      value.finalizedHeadSha,
      filePath,
      "mergeConflict.servicePreparation.finalizedHeadSha",
    ),
  };
}

function normalizePreservedWorktreeStashes(
  value: unknown,
  filePath: string,
): IssuePreservedWorktreeStash[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw corruptLifecycle(filePath, "preservedWorktreeStashes is invalid");
  return value.map((item, index) =>
    requiredPreservedWorktreeStash(item, filePath, `preservedWorktreeStashes[${index}]`),
  );
}

function normalizePreservedWorktreeStash(
  value: unknown,
  filePath: string,
  field: string,
): IssuePreservedWorktreeStash | null {
  if (value === undefined || value === null) return null;
  return requiredPreservedWorktreeStash(value, filePath, field);
}

function requiredPreservedWorktreeStash(
  value: unknown,
  filePath: string,
  field: string,
): IssuePreservedWorktreeStash {
  if (!isRecord(value)) throw corruptLifecycle(filePath, `${field} is invalid`);
  if (value.version !== 1) throw corruptLifecycle(filePath, `${field}.version is invalid`);
  const source = value.source;
  if (
    source !== "base_ref_repair" &&
    source !== "service_conflict_prepare" &&
    source !== "service_conflict_base_refresh" &&
    source !== "prepared_base_drift"
  ) {
    throw corruptLifecycle(filePath, `${field}.source is invalid`);
  }
  const status = value.status;
  if (
    status !== "created" &&
    status !== "applied_clean" &&
    status !== "apply_conflicted" &&
    status !== "finalized" &&
    status !== "dropped" &&
    status !== "drop_failed"
  ) {
    throw corruptLifecycle(filePath, `${field}.status is invalid`);
  }
  return {
    version: 1,
    id: requiredString(value.id, filePath, `${field}.id`),
    operationId: requiredString(value.operationId, filePath, `${field}.operationId`),
    source,
    stashRef: requiredString(value.stashRef, filePath, `${field}.stashRef`),
    stashSha: requiredString(value.stashSha, filePath, `${field}.stashSha`),
    message: requiredString(value.message, filePath, `${field}.message`),
    workspacePath: requiredString(value.workspacePath, filePath, `${field}.workspacePath`),
    branchName: requiredString(value.branchName, filePath, `${field}.branchName`),
    baseBranch: optionalNullableString(value.baseBranch, filePath, `${field}.baseBranch`),
    originalHeadSha: requiredString(value.originalHeadSha, filePath, `${field}.originalHeadSha`),
    dirtyFiles: requiredStringArray(value.dirtyFiles, filePath, `${field}.dirtyFiles`),
    status,
    conflictedFiles: requiredStringArray(value.conflictedFiles, filePath, `${field}.conflictedFiles`),
    createdAt: requiredString(value.createdAt, filePath, `${field}.createdAt`),
    appliedAt: optionalNullableString(value.appliedAt, filePath, `${field}.appliedAt`),
    droppedAt: optionalNullableString(value.droppedAt, filePath, `${field}.droppedAt`),
    dropError: optionalNullableString(value.dropError, filePath, `${field}.dropError`),
  };
}

function normalizeMergeConflictResolutionReport(
  value: unknown,
  filePath: string,
  index: number,
  fallbackProjectContext: ProjectContextResolution,
): IssueMergeConflictResolutionReportRecord {
  if (!isRecord(value)) throw corruptLifecycle(filePath, `mergeConflictResolutionReports[${index}] is invalid`);
  const resolutionStatus = value.resolutionStatus;
  if (resolutionStatus !== "resolved" && resolutionStatus !== "still_conflicted" && resolutionStatus !== "blocked") {
    throw corruptLifecycle(filePath, `mergeConflictResolutionReports[${index}].resolutionStatus is invalid`);
  }
  return {
    id: requiredString(value.id, filePath, `mergeConflictResolutionReports[${index}].id`),
    idempotencyKey: requiredString(value.idempotencyKey, filePath, `mergeConflictResolutionReports[${index}].idempotencyKey`),
    runId: requiredString(value.runId, filePath, `mergeConflictResolutionReports[${index}].runId`),
    issueId: requiredString(value.issueId, filePath, `mergeConflictResolutionReports[${index}].issueId`),
    issueIdentifier: requiredString(value.issueIdentifier, filePath, `mergeConflictResolutionReports[${index}].issueIdentifier`),
    projectContext: normalizeStoredProjectContext(value.projectContext, fallbackProjectContext),
    resolutionStatus,
    summary: requiredString(value.summary, filePath, `mergeConflictResolutionReports[${index}].summary`),
    validationEvidence: requiredStringArray(value.validationEvidence, filePath, `mergeConflictResolutionReports[${index}].validationEvidence`),
    changedFiles: requiredStringArray(value.changedFiles, filePath, `mergeConflictResolutionReports[${index}].changedFiles`),
    pullRequest: normalizeMergePullRequest(
      value.pullRequest,
      filePath,
      `mergeConflictResolutionReports[${index}].pullRequest`,
    ),
    previousHeadSha: optionalNullableString(
      value.previousHeadSha,
      filePath,
      `mergeConflictResolutionReports[${index}].previousHeadSha`,
    ),
    newHeadSha:
      value.newHeadSha === undefined
        ? normalizeMergePullRequest(
            value.pullRequest,
            filePath,
            `mergeConflictResolutionReports[${index}].pullRequest`,
          ).headSha
        : optionalNullableString(value.newHeadSha, filePath, `mergeConflictResolutionReports[${index}].newHeadSha`),
    baseBranch: optionalNullableString(value.baseBranch, filePath, `mergeConflictResolutionReports[${index}].baseBranch`),
    baseHeadSha: optionalNullableString(value.baseHeadSha, filePath, `mergeConflictResolutionReports[${index}].baseHeadSha`),
    blockedReason: optionalNullableString(
      value.blockedReason,
      filePath,
      `mergeConflictResolutionReports[${index}].blockedReason`,
    ),
    risks: requiredStringArray(value.risks, filePath, `mergeConflictResolutionReports[${index}].risks`),
    submittedAt: requiredString(value.submittedAt, filePath, `mergeConflictResolutionReports[${index}].submittedAt`),
  };
}

function normalizeMergePullRequest(
  value: unknown,
  filePath: string,
  field = "merge.pullRequest",
): CompletionReportPullRequestRef {
  if (!isRecord(value)) throw corruptLifecycle(filePath, `${field} is invalid`);
  return {
    url: nullableString(value.url, filePath, `${field}.url`),
    number: nullableNumber(value.number, filePath, `${field}.number`),
    headSha: optionalNullableString(value.headSha, filePath, `${field}.headSha`),
    branch: optionalNullableString(value.branch, filePath, `${field}.branch`),
  };
}

function normalizeReviewFeedbackPullRequest(
  value: unknown,
  filePath: string,
  index: number,
): CompletionReportPullRequestRef {
  if (!isRecord(value)) throw corruptLifecycle(filePath, `reviewFeedback[${index}].pullRequest is invalid`);
  return {
    url: nullableString(value.url, filePath, `reviewFeedback[${index}].pullRequest.url`),
    number: nullableNumber(value.number, filePath, `reviewFeedback[${index}].pullRequest.number`),
    headSha: optionalNullableString(value.headSha, filePath, `reviewFeedback[${index}].pullRequest.headSha`),
    branch: optionalNullableString(value.branch, filePath, `reviewFeedback[${index}].pullRequest.branch`),
  };
}

function normalizeChecklist(value: unknown, filePath: string, reportIndex: number): CompletionReportChecklistItem[] {
  if (!Array.isArray(value)) {
    throw corruptLifecycle(filePath, `completionReports[${reportIndex}].acceptanceChecklist is invalid`);
  }
  return value.map((item, itemIndex) => {
    if (!isRecord(item)) {
      throw corruptLifecycle(filePath, `completionReports[${reportIndex}].acceptanceChecklist[${itemIndex}] is invalid`);
    }
    if (typeof item.satisfied !== "boolean") {
      throw corruptLifecycle(filePath, `completionReports[${reportIndex}].acceptanceChecklist[${itemIndex}].satisfied is invalid`);
    }
    return {
      text: requiredString(item.text, filePath, `completionReports[${reportIndex}].acceptanceChecklist[${itemIndex}].text`),
      satisfied: item.satisfied,
      evidence: nullableString(item.evidence, filePath, `completionReports[${reportIndex}].acceptanceChecklist[${itemIndex}].evidence`),
    };
  });
}

function normalizeReviewVerdictAcceptanceResults(
  value: unknown,
  filePath: string,
  verdictIndex: number,
): ReviewVerdictAcceptanceResult[] {
  if (!Array.isArray(value)) {
    throw corruptLifecycle(filePath, `reviewVerdicts[${verdictIndex}].acceptanceResults is invalid`);
  }
  return value.map((item, itemIndex) => {
    if (!isRecord(item)) {
      throw corruptLifecycle(filePath, `reviewVerdicts[${verdictIndex}].acceptanceResults[${itemIndex}] is invalid`);
    }
    if (typeof item.satisfied !== "boolean") {
      throw corruptLifecycle(
        filePath,
        `reviewVerdicts[${verdictIndex}].acceptanceResults[${itemIndex}].satisfied is invalid`,
      );
    }
    return {
      text: requiredString(item.text, filePath, `reviewVerdicts[${verdictIndex}].acceptanceResults[${itemIndex}].text`),
      satisfied: item.satisfied,
      evidence: nullableString(
        item.evidence,
        filePath,
        `reviewVerdicts[${verdictIndex}].acceptanceResults[${itemIndex}].evidence`,
      ),
    };
  });
}

function normalizeReviewGateFindings(value: unknown, filePath: string, verdictIndex: number): ReviewGateFindingRecord[] {
  if (!Array.isArray(value)) {
    throw corruptLifecycle(filePath, `reviewVerdicts[${verdictIndex}].gateFindings is invalid`);
  }
  return value.map((item, itemIndex) => {
    if (!isRecord(item)) {
      throw corruptLifecycle(filePath, `reviewVerdicts[${verdictIndex}].gateFindings[${itemIndex}] is invalid`);
    }
    const scenarioEntitlement = requiredString(
      item.scenarioEntitlement,
      filePath,
      `reviewVerdicts[${verdictIndex}].gateFindings[${itemIndex}].scenarioEntitlement`,
    );
    if (!isReviewGateScenarioEntitlement(scenarioEntitlement)) {
      throw corruptLifecycle(
        filePath,
        `reviewVerdicts[${verdictIndex}].gateFindings[${itemIndex}].scenarioEntitlement is invalid`,
      );
    }
    return {
      summary: requiredString(item.summary, filePath, `reviewVerdicts[${verdictIndex}].gateFindings[${itemIndex}].summary`),
      requirementIds: requiredStringArray(
        item.requirementIds,
        filePath,
        `reviewVerdicts[${verdictIndex}].gateFindings[${itemIndex}].requirementIds`,
      ),
      contractAnchor: requiredString(
        item.contractAnchor,
        filePath,
        `reviewVerdicts[${verdictIndex}].gateFindings[${itemIndex}].contractAnchor`,
      ),
      scenario: requiredString(item.scenario, filePath, `reviewVerdicts[${verdictIndex}].gateFindings[${itemIndex}].scenario`),
      scenarioEntitlement,
      observedFailure: requiredString(
        item.observedFailure,
        filePath,
        `reviewVerdicts[${verdictIndex}].gateFindings[${itemIndex}].observedFailure`,
      ),
      currentIssueOwnership: requiredString(
        item.currentIssueOwnership,
        filePath,
        `reviewVerdicts[${verdictIndex}].gateFindings[${itemIndex}].currentIssueOwnership`,
      ),
      boundedRepair: requiredString(
        item.boundedRepair,
        filePath,
        `reviewVerdicts[${verdictIndex}].gateFindings[${itemIndex}].boundedRepair`,
      ),
      evidence: requiredStringArray(item.evidence, filePath, `reviewVerdicts[${verdictIndex}].gateFindings[${itemIndex}].evidence`),
    };
  });
}

function normalizeReviewDiscoveryFindings(
  value: unknown,
  filePath: string,
  verdictIndex: number,
): ReviewDiscoveryFindingRecord[] {
  if (!Array.isArray(value)) {
    throw corruptLifecycle(filePath, `reviewVerdicts[${verdictIndex}].discoveryFindings is invalid`);
  }
  return value.map((item, itemIndex) => {
    if (!isRecord(item)) {
      throw corruptLifecycle(filePath, `reviewVerdicts[${verdictIndex}].discoveryFindings[${itemIndex}] is invalid`);
    }
    const importance = requiredString(
      item.importance,
      filePath,
      `reviewVerdicts[${verdictIndex}].discoveryFindings[${itemIndex}].importance`,
    );
    if (!isReviewDiscoveryImportance(importance)) {
      throw corruptLifecycle(
        filePath,
        `reviewVerdicts[${verdictIndex}].discoveryFindings[${itemIndex}].importance is invalid`,
      );
    }
    const relationship = requiredString(
      item.relationship,
      filePath,
      `reviewVerdicts[${verdictIndex}].discoveryFindings[${itemIndex}].relationship`,
    );
    if (!isReviewDiscoveryRelationship(relationship)) {
      throw corruptLifecycle(
        filePath,
        `reviewVerdicts[${verdictIndex}].discoveryFindings[${itemIndex}].relationship is invalid`,
      );
    }
    const suggestedDisposition = requiredString(
      item.suggestedDisposition,
      filePath,
      `reviewVerdicts[${verdictIndex}].discoveryFindings[${itemIndex}].suggestedDisposition`,
    );
    if (!isReviewDiscoverySuggestedDisposition(suggestedDisposition)) {
      throw corruptLifecycle(
        filePath,
        `reviewVerdicts[${verdictIndex}].discoveryFindings[${itemIndex}].suggestedDisposition is invalid`,
      );
    }
    return {
      summary: requiredString(item.summary, filePath, `reviewVerdicts[${verdictIndex}].discoveryFindings[${itemIndex}].summary`),
      importance,
      relationship,
      discoveryReason: requiredString(
        item.discoveryReason,
        filePath,
        `reviewVerdicts[${verdictIndex}].discoveryFindings[${itemIndex}].discoveryReason`,
      ),
      suggestedDisposition,
      scenarioAxes: requiredStringArray(
        item.scenarioAxes,
        filePath,
        `reviewVerdicts[${verdictIndex}].discoveryFindings[${itemIndex}].scenarioAxes`,
      ),
      evidence: requiredStringArray(
        item.evidence,
        filePath,
        `reviewVerdicts[${verdictIndex}].discoveryFindings[${itemIndex}].evidence`,
      ),
      ownerIssueIdentifier: optionalNullableString(
        item.ownerIssueIdentifier,
        filePath,
        `reviewVerdicts[${verdictIndex}].discoveryFindings[${itemIndex}].ownerIssueIdentifier`,
      ),
    };
  });
}

function legacyGateFindingsFromFindings(findings: readonly string[], evidence: readonly string[]): ReviewGateFindingRecord[] {
  return findings.map((finding) => ({
    summary: finding,
    requirementIds: [],
    contractAnchor: "Legacy unstructured reviewer finding.",
    scenario: "Legacy unstructured reviewer finding.",
    scenarioEntitlement: "necessary_core_behavior",
    observedFailure: finding,
    currentIssueOwnership: "Legacy review verdict accepted before structured gate entitlement was recorded.",
    boundedRepair: finding,
    evidence: evidence.length === 0 ? ["Legacy review verdict did not include per-finding evidence."] : [...evidence],
  }));
}

function isReviewGateScenarioEntitlement(value: string): value is ReviewGateScenarioEntitlement {
  return (
    value === "explicit_requirement" ||
    value === "named_acceptance_criterion" ||
    value === "named_validation_requirement" ||
    value === "necessary_core_behavior"
  );
}

function isReviewDiscoveryImportance(value: string): value is ReviewDiscoveryImportance {
  return value === "critical" || value === "high" || value === "medium" || value === "low";
}

function isReviewDiscoveryRelationship(value: string): value is ReviewDiscoveryRelationship {
  return (
    value === "implied_core" ||
    value === "adjacent_sibling" ||
    value === "hidden_matrix_axis" ||
    value === "sibling_issue_scope" ||
    value === "future_hardening" ||
    value === "out_of_scope"
  );
}

function isReviewDiscoverySuggestedDisposition(value: string): value is ReviewDiscoverySuggestedDisposition {
  return (
    value === "planner_decomposition" ||
    value === "followup_issue" ||
    value === "operator_decision" ||
    value === "ignore"
  );
}

function normalizePullRequest(value: unknown, filePath: string, reportIndex: number): CompletionReportPullRequestRef | null {
  if (value === null) return null;
  if (!isRecord(value)) throw corruptLifecycle(filePath, `completionReports[${reportIndex}].pullRequest is invalid`);
  return {
    url: nullableString(value.url, filePath, `completionReports[${reportIndex}].pullRequest.url`),
    number: nullableNumber(value.number, filePath, `completionReports[${reportIndex}].pullRequest.number`),
    headSha: optionalNullableString(value.headSha, filePath, `completionReports[${reportIndex}].pullRequest.headSha`),
    branch: optionalNullableString(value.branch, filePath, `completionReports[${reportIndex}].pullRequest.branch`),
  };
}

function normalizeCompletionReportAcceptanceContext(
  value: unknown,
  filePath: string,
  reportIndex: number,
): CompletionReportAcceptanceContext | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw corruptLifecycle(filePath, `completionReports[${reportIndex}].acceptanceContext is invalid`);
  const version = value.version;
  if (version !== 1) {
    throw corruptLifecycle(filePath, `completionReports[${reportIndex}].acceptanceContext.version is invalid`);
  }
  const field = (name: string) => `completionReports[${reportIndex}].acceptanceContext.${name}`;
  return {
    version,
    capturedAt: requiredString(value.capturedAt, filePath, field("capturedAt")),
    runId: requiredString(value.runId, filePath, field("runId")),
    branchName: optionalNullableString(value.branchName, filePath, field("branchName")),
    baseRef: optionalNullableString(value.baseRef, filePath, field("baseRef")),
    baseHeadSha: optionalNullableString(value.baseHeadSha, filePath, field("baseHeadSha")),
    worktreeHeadSha: optionalNullableString(value.worktreeHeadSha, filePath, field("worktreeHeadSha")),
    treeSha: optionalNullableString(value.treeSha, filePath, field("treeSha")),
    pullRequestHeadSha: optionalNullableString(value.pullRequestHeadSha, filePath, field("pullRequestHeadSha")),
    worktreeDirty: optionalNullableBoolean(value.worktreeDirty, filePath, field("worktreeDirty")),
    worktreeStatus: normalizeCompletionReportWorktreeStatus(value.worktreeStatus, filePath, field("worktreeStatus")),
    unmergedFiles:
      value.unmergedFiles === undefined || value.unmergedFiles === null
        ? null
        : requiredStringArray(value.unmergedFiles, filePath, field("unmergedFiles")),
  };
}

function normalizeCompletionReportWorktreeStatus(
  value: unknown,
  filePath: string,
  field: string,
): "clean" | "dirty" | "unknown" {
  if (value === undefined || value === null) return "unknown";
  if (value === "clean" || value === "dirty" || value === "unknown") return value;
  throw corruptLifecycle(filePath, `${field} is invalid`);
}

function nonNegativeInteger(value: unknown, filePath: string, field: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  throw corruptLifecycle(filePath, `${field} is invalid`);
}

function nullableString(value: unknown, filePath: string, field: string): string | null {
  if (value === null) return null;
  if (typeof value === "string") return value;
  throw corruptLifecycle(filePath, `${field} is invalid`);
}

function optionalNullableString(value: unknown, filePath: string, field: string): string | null {
  if (value === undefined) return null;
  return nullableString(value, filePath, field);
}

function normalizeSupersessionFields(
  value: Record<string, unknown>,
  filePath: string,
  field: string,
): Required<LifecycleSupersessionFields> {
  return {
    supersededAt: optionalNullableString(value.supersededAt, filePath, `${field}.supersededAt`),
    supersededBy: optionalNullableString(value.supersededBy, filePath, `${field}.supersededBy`),
    supersededReason: optionalNullableString(value.supersededReason, filePath, `${field}.supersededReason`),
  };
}

function nullableNumber(value: unknown, filePath: string, field: string): number | null {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw corruptLifecycle(filePath, `${field} is invalid`);
}

function optionalNullableNumber(value: unknown, filePath: string, field: string): number | null {
  if (value === undefined) return null;
  return nullableNumber(value, filePath, field);
}

function optionalNullableBoolean(value: unknown, filePath: string, field: string): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value;
  throw corruptLifecycle(filePath, `${field} is invalid`);
}

function requiredBoolean(value: unknown, filePath: string, field: string): boolean {
  if (typeof value === "boolean") return value;
  throw corruptLifecycle(filePath, `${field} is invalid`);
}

function requiredArray(value: unknown, filePath: string, field: string): unknown[] {
  if (Array.isArray(value)) return value;
  throw corruptLifecycle(filePath, `${field} is invalid`);
}

function requiredStringArray(value: unknown, filePath: string, field: string): string[] {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  throw corruptLifecycle(filePath, `${field} is invalid`);
}

function requiredString(value: unknown, filePath: string, field: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw corruptLifecycle(filePath, `${field} is missing`);
}

function normalizeStoredProjectContext(
  value: unknown,
  fallbackProjectContext?: ProjectContextResolution,
): ProjectContextResolution {
  return normalizeProjectContextResolution(
    value === undefined ? fallbackProjectContext : (value as Partial<ProjectContextResolution> | null | undefined),
  );
}

function corruptLifecycle(filePath: string, reason: string): SymphonyError {
  return new SymphonyError("lifecycle_store_corrupt", `Issue lifecycle record is corrupt: ${filePath} (${reason})`);
}

function isLifecyclePhase(value: unknown): value is IssueLifecyclePhase {
  return (
    value === "implementation" ||
    value === "merge_conflict_resolution" ||
    value === "review" ||
    value === "passed" ||
    value === "blocked" ||
    value === "terminal" ||
    value === "unknown"
  );
}

function isMergeGateStatus(value: unknown): value is IssueMergeGateStatus {
  return (
    value === "observing" ||
    value === "repair_dispatched" ||
    value === "blocked" ||
    value === "resolved" ||
    value === "superseded"
  );
}

function isMergeGateResultStatus(value: unknown): value is IssueMergeGateResultStatus {
  return value === "repair_dispatched" || value === "blocked";
}

function isMergeGateMergeabilityStatus(value: unknown): value is IssueMergeGateMergeabilityStatus {
  return value === "mergeable" || value === "conflicted" || value === "unknown" || value === "blocked";
}

function isMergeGateCheckOutcome(value: unknown): value is IssueMergeGateCheckOutcome {
  return (
    value === "passing" ||
    value === "pending" ||
    value === "missing_observed" ||
    value === "missing_actionable" ||
    value === "failing" ||
    value === "unknown"
  );
}

function isMergeGateRawCheckStatus(value: unknown): value is IssueMergeGateRawCheckStatus {
  return value === "success" || value === "failure" || value === "pending" || value === "missing" || value === "unknown";
}

function isBaseRefObservationClassification(value: unknown): value is IssueBaseRefObservation["classification"] {
  return (
    value === "ok" ||
    value === "local_base_mismatch" ||
    value === "branch_not_based_on_live_base" ||
    value === "base_ref_unavailable" ||
    value === "base_ref_fetch_failed" ||
    value === "base_ref_compare_failed"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dedupeIssueLifecycleRecords(records: readonly IssueLifecycleRecord[]): IssueLifecycleRecord[] {
  const seen = new Set<string>();
  const deduped: IssueLifecycleRecord[] = [];
  for (const record of records) {
    if (seen.has(record.issueId)) continue;
    seen.add(record.issueId);
    deduped.push(record);
  }
  return deduped;
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_") || "record";
}

function isStateIn(state: string, states: string[]): boolean {
  return states.some((candidate) => statesEqual(state, candidate));
}

function statesEqual(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

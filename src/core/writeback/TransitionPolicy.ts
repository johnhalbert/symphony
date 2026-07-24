import type { ServiceConfig } from "../config/Config.js";
import { evaluateWorkerDispatchCapability } from "../IssueDispatchCapability.js";
import { parseIssueContract } from "../IssueContractLint.js";
import type {
  ExpectedRedArtifactEvidence,
  IssueAcceptedArtifactRecord,
  IssueBlockerProvenanceRecord,
  IssueCompletionReportRecord,
  IssueMergeGateMergeabilityState,
  IssueMergeConflictResolutionReportRecord,
  IssuePostMortemReportRecord,
  IssueReviewVerdictRecord,
  IssueTriageBlockerRecord,
  IssueTriageRecoveryActor,
  IssueTriageRecoveryDispositionRecord,
  IssueTriageRecoveryMode,
  IssueTriageReportRecord,
  PullRequestReviewEvidenceItem,
  ReviewDiscoveryFindingRecord,
  ReviewGateFindingRecord,
} from "../persistence/IssueLifecycleStore.js";
import type { Issue, Workspace } from "../types.js";
import type { NewWritebackOperation } from "./WritebackOutbox.js";

export interface RunWritebackContext {
  issue: Issue;
  runId: string;
  sessionId: string | null;
  workspacePath: string | null;
  workspace?: Workspace | null;
}

export interface ReviewVerdictWritebackContext {
  issue: Issue;
  runId: string;
  reviewer: string | null;
}

export interface ReviewVerdictWritebackDetails {
  idempotencyKey: string;
  finalDisposition?: string;
  acceptanceResults: Array<{ text: string; satisfied: boolean; evidence: string | null }>;
  findings: string[];
  gateFindings?: ReviewGateFindingRecord[];
  discoveryFindings?: ReviewDiscoveryFindingRecord[];
  evidence: string[];
  blockerProvenance?: IssueBlockerProvenanceRecord | null;
}

export interface ReviewVerdictDispositionOnlyWritebackDetails {
  idempotencyKey: string;
  verdict: "pass" | "fail" | "blocked";
  finalDisposition?: string;
}

export interface BlockedEscalationWritebackContext {
  issue: Issue;
  runId: string;
  reason: string;
  fromStates?: string[];
  incompleteTurnCount?: number;
  maxIncompleteTurns?: number;
  reviewRound?: number;
  maxReviewRounds?: number;
  acceptedArtifactValidationFailureCount?: number;
  maxAcceptedArtifactValidationFailures?: number;
  lastCompletionReport?: IssueCompletionReportRecord | null;
  lastReviewVerdict?: IssueReviewVerdictRecord | null;
  requiredAction?: string;
  finalDisposition?: string;
  blockerProvenance?: IssueBlockerProvenanceRecord | null;
}

export interface IssueTriageReportWritebackContext {
  issue: Issue;
  report: IssueTriageReportRecord;
  blockedReason?: string | null;
  planningFailureCount?: number;
  hasFreshIssueBreakdownPlan?: boolean;
  issueBreakdownPlanApplicationStatus?: string | null;
  incompleteTurnCount?: number;
  hasActiveMergeConflict?: boolean;
}

export interface IssueTriageRecoveryRouteContext {
  issue: Issue;
  blockers: readonly IssueTriageBlockerRecord[];
  planningFailureCount?: number;
  hasFreshIssueBreakdownPlan?: boolean;
  issueBreakdownPlanApplicationStatus?: string | null;
  incompleteTurnCount?: number;
  hasActiveMergeConflict?: boolean;
}

export interface IssueTriageRecoveryRouteDecision {
  mode: IssueTriageRecoveryMode;
  nextActor: IssueTriageRecoveryActor | null;
  targetState: string | null;
  reason: string;
}

export interface IssueTriageBlockedReboundWritebackContext {
  issue: Issue;
  report: IssueTriageReportRecord;
  reason: string;
}

export interface IssuePostMortemReportWritebackContext {
  issue: Issue;
  report: IssuePostMortemReportRecord;
}

export interface MergeCompletedWritebackContext {
  issue: Issue;
  mergeId: string;
  fromState: string;
  doneState: string;
}

export interface OrganizationalParentCompletionWritebackContext {
  issue: Issue;
  sourceStates: string[];
  doneState: string;
}

export interface MergeGateCheckEvidence {
  name: string;
  status: string;
  conclusion: string | null;
  url: string | null;
}

export interface MergeGateWritebackContext {
  issue: Issue;
  gateId: string;
  blockerFingerprint: string | null;
  fromState: string;
  pullRequest: {
    url: string | null;
    number: number | null;
    headSha?: string | null;
    branch?: string | null;
  };
  requiredChecks: string[];
  failedChecks: MergeGateCheckEvidence[];
  actionableMissingChecks?: MergeGateCheckEvidence[];
  pendingChecks: MergeGateCheckEvidence[];
  missingChecks: MergeGateCheckEvidence[];
  unknownChecks?: MergeGateCheckEvidence[];
  mergeability?: IssueMergeGateMergeabilityState | null;
  reviewRound: number;
  maxReviewRounds: number;
}

export interface MergeConflictsWritebackContext {
  issue: Issue;
  mergeId: string;
  fromState: string;
  conflictsState: string;
  pullRequest: {
    url: string | null;
    number: number | null;
    headSha?: string | null;
    branch?: string | null;
  };
  mergeableState: string | null;
  reason: string;
}

export interface MergeConflictResolvedWritebackContext {
  issue: Issue;
  report: IssueMergeConflictResolutionReportRecord;
  fromState: string;
  conflictsState: string;
}

export interface MergeConflictStillConflictedWritebackContext {
  issue: Issue;
  report: IssueMergeConflictResolutionReportRecord;
}

export interface BaseRefRepairWritebackContext {
  issue: Issue;
  operationId: string;
  fromState: string;
  branchName: string;
  baseBranch: string;
  previousHeadSha: string;
  rebasedHeadSha: string;
  baseHeadSha: string;
  mode?: "pr_backed" | "local_only";
}

export interface MergeGateHeadSupersessionWritebackContext {
  issue: Issue;
  gateId: string;
  fromState: string;
  pullRequest: {
    url: string | null;
    number: number | null;
    headSha?: string | null;
    branch?: string | null;
  };
  liveHeadSha: string;
  reportId: string;
}

export interface MergeGateHeadSupersessionRecoveryWritebackContext {
  issue: Issue;
  gateId: string;
  pullRequest: {
    url: string | null;
    number: number | null;
    headSha?: string | null;
    branch?: string | null;
  };
  liveHeadSha: string;
  reportId: string;
  verdictId: string;
}

export interface CompletionReportWritebackDetails {
  reportId: string;
  idempotencyKey: string;
  finalDisposition?: string;
  summary: string;
  validationEvidence: string[];
  acceptanceChecklist: Array<{ text: string; satisfied: boolean; evidence: string | null }>;
  changedFiles: string[];
  branchName: string | null;
  pullRequest: { url: string | null; number: number | null; headSha?: string | null; branch?: string | null } | null;
  risks: string[];
}

export interface CompletionReportRejectionWritebackDetails {
  reason: string;
  report: CompletionReportWritebackDetails;
}

export interface PullRequestHandoffWritebackDetails {
  pullRequest: {
    url: string | null;
    number: number | null;
    headSha?: string | null;
    branch?: string | null;
    draft?: boolean | null;
  };
  report?: CompletionReportWritebackDetails | null;
  ci?: {
    requiredChecks: string[];
    passedChecks: string[];
    noCiEvidence: string | null;
  } | null;
}

export interface AcceptedArtifactHandoffWritebackDetails {
  pullRequest: PullRequestHandoffWritebackDetails["pullRequest"];
  report: CompletionReportWritebackDetails;
  artifactEvidence: ExpectedRedArtifactEvidence;
}

export interface AcceptedArtifactCompletionWritebackContext {
  issue: Issue;
  artifact: IssueAcceptedArtifactRecord;
  fromStates: string[];
  doneState: string;
}

export interface PublicationApprovalActionDetails {
  branchName: string;
  baseBranch: string;
  workspacePath: string;
  title: string;
}

export function planDispatchWriteback(issue: Issue, config: ServiceConfig): NewWritebackOperation | null {
  if (!config.writeback.enabled || !sameName(issue.state, "Todo")) return null;
  const dispatchStateVersion = safeKeySegment(issue.updatedAt ?? issue.createdAt ?? issue.state);
  return {
    idempotencyKey: `transition:${issue.id}:dispatch:${dispatchStateVersion}:${config.writeback.dispatchState}`,
    kind: "transition",
    issueId: issue.id,
    payload: {
      fromStates: ["Todo"],
      toState: config.writeback.dispatchState,
      reason: "Symphony dispatch",
    },
  };
}

export function planIssueTriageBlockedReboundWriteback(
  context: IssueTriageBlockedReboundWritebackContext,
  config: ServiceConfig,
): NewWritebackOperation | null {
  if (!config.writeback.enabled) return null;
  const blockedState = config.reviewLoop.blockedStates[0] ?? null;
  if (blockedState === null) return null;
  const fromStates = uniqueStates([config.writeback.dispatchState, ...config.tracker.activeStates]);
  if (!isStateIn(context.issue.state, fromStates)) return null;
  const stateVersion = safeKeySegment(context.issue.updatedAt ?? context.issue.createdAt ?? context.issue.state);
  const eventKey = `issue-triage-blocked-rebound:${safeKeySegment(context.report.idempotencyKey)}:${stateVersion}`;
  return {
    idempotencyKey: `transition:${context.issue.id}:${eventKey}:${blockedState}`,
    kind: "transition",
    issueId: context.issue.id,
    runId: context.report.runId,
    payload: {
      fromStates,
      toState: blockedState,
      reason: `Symphony issue triage blocked: ${context.reason}`,
    },
  };
}

export function planRunStartedComment(context: RunWritebackContext, config: ServiceConfig): NewWritebackOperation | null {
  if (!config.writeback.enabled) return null;
  return {
    idempotencyKey: `comment:${context.issue.id}:${context.runId}:run-started`,
    kind: "comment",
    issueId: context.issue.id,
    runId: context.runId,
    payload: {
      dedupeKey: `${context.runId}:run-started`,
      body: [
        "Symphony started a worker run.",
        "",
        `Run: ${context.runId}`,
        `Session: ${context.sessionId ?? "n/a"}`,
        `Workspace: ${context.workspacePath ?? context.workspace?.path ?? "n/a"}`,
        `Branch: ${context.workspace?.gitBranchName ?? context.issue.branchName ?? "n/a"}`,
      ].join("\n"),
    },
  };
}

export function planRunSucceededWritebacks(context: RunWritebackContext, config: ServiceConfig): NewWritebackOperation[] {
  if (!config.writeback.enabled) return [];
  return [
    {
      idempotencyKey: `comment:${context.issue.id}:${context.runId}:run-succeeded`,
      kind: "comment",
      issueId: context.issue.id,
      runId: context.runId,
      payload: {
        dedupeKey: `${context.runId}:run-succeeded`,
        body: [
          `Symphony worker turn completed without an accepted completion report.`,
          `The issue has not been marked ready for review.`,
          "",
          `Run: ${context.runId}`,
        ].join("\n"),
      },
    },
  ];
}

export function planCompletionReportAcceptedWritebacks(
  context: RunWritebackContext,
  config: ServiceConfig,
  report: string | CompletionReportWritebackDetails | null = null,
): NewWritebackOperation[] {
  const completionReportFromStates = completionReportAcceptedFromStates(config);
  if (
    !config.writeback.enabled ||
    !isStateIn(context.issue.state, completionReportFromStates)
  ) {
    return [];
  }

  const reviewState = config.reviewLoop.reviewStates[0];
  if (!reviewState) return [];

  const eventKey =
    typeof report === "object" && report !== null
      ? `${context.runId}:completion-report:${safeKeySegment(report.idempotencyKey)}`
      : `${context.runId}:completion-report-accepted`;
  return [
    {
      idempotencyKey: `comment:${context.issue.id}:${eventKey}`,
      kind: "comment",
      issueId: context.issue.id,
      runId: context.runId,
      payload: {
        dedupeKey: eventKey,
        body: [
          "## Symphony Completion Report",
          "",
          "Status: accepted",
          "Symphony accepted the worker completion report.",
          `Next state: ${reviewState} (agent review queue)`,
          "",
          `Run: ${context.runId}`,
          `Session: ${context.sessionId ?? "n/a"}`,
          `Workspace: ${context.workspacePath ?? context.workspace?.path ?? "n/a"}`,
          `Branch: ${context.workspace?.gitBranchName ?? context.issue.branchName ?? "n/a"}`,
          ...formatCompletionReportForComment(report),
        ].join("\n"),
      },
    },
    {
      idempotencyKey: `transition:${context.issue.id}:${eventKey}:${reviewState}`,
      kind: "transition",
      issueId: context.issue.id,
      runId: context.runId,
      payload: {
        fromStates: completionReportFromStates,
        toState: reviewState,
        reason: "Symphony completion report accepted",
      },
    },
  ];
}

export function planCompletionReportDispositionOnlyWriteback(
  context: RunWritebackContext,
  config: ServiceConfig,
  report: CompletionReportWritebackDetails,
): NewWritebackOperation[] {
  if (!config.writeback.enabled || report.finalDisposition === undefined) {
    return [];
  }
  const eventKey = `${context.runId}:completion-report:${safeKeySegment(report.idempotencyKey)}:disposition-only`;
  return [
    {
      idempotencyKey: `comment:${context.issue.id}:${eventKey}`,
      kind: "comment",
      issueId: context.issue.id,
      runId: context.runId,
      payload: {
        dedupeKey: eventKey,
        body: [
          "## Symphony Completion Report",
          "",
          "Status: accepted by manual state-gate override",
          `Run: ${context.runId}`,
          ...formatFinalDispositionForComment(report.finalDisposition),
        ].join("\n"),
      },
    },
  ];
}

export function planCompletionReportRejectedWritebacks(
  context: RunWritebackContext,
  config: ServiceConfig,
  details: CompletionReportRejectionWritebackDetails,
): NewWritebackOperation[] {
  if (!config.writeback.enabled) return [];

  const eventKey = `${context.runId}:completion-report:${safeKeySegment(details.report.idempotencyKey)}:rejected`;
  const unsatisfied = details.report.acceptanceChecklist.filter((item) => !item.satisfied);
  return [
    {
      idempotencyKey: `comment:${context.issue.id}:${eventKey}`,
      kind: "comment",
      issueId: context.issue.id,
      runId: context.runId,
      payload: {
        dedupeKey: eventKey,
        body: [
          "## Symphony Completion Report",
          "",
          "Status: rejected",
          "Symphony rejected the worker completion report before review handoff.",
          "Next state: unchanged (not ready for review)",
          "",
          `Run: ${context.runId}`,
          `Session: ${context.sessionId ?? "n/a"}`,
          `Workspace: ${context.workspacePath ?? context.workspace?.path ?? "n/a"}`,
          `Branch: ${context.workspace?.gitBranchName ?? context.issue.branchName ?? "n/a"}`,
          "",
          "Rejection reason:",
          `- ${details.reason}`,
          "",
          "Rejected acceptance checklist items:",
          ...listOrFallback(
            unsatisfied.map((item) => `${item.text}${item.evidence === null ? "" : ` (${item.evidence})`}`),
            "No unsatisfied acceptance checklist items supplied.",
          ),
          ...formatCompletionReportForComment(details.report),
        ].join("\n"),
      },
    },
  ];
}

export function planPullRequestHandoffWritebacks(
  context: RunWritebackContext,
  config: ServiceConfig,
  details: PullRequestHandoffWritebackDetails,
): NewWritebackOperation[] {
  if (!config.writeback.enabled || !config.github.prHandoff.enabled) return [];
  const handoffFromStates = pullRequestHandoffFromStates(config);
  if (!isStateIn(context.issue.state, handoffFromStates)) return [];

  const targetState = config.github.prHandoff.targetState;
  if (targetState === null) return [];

  const pullRequestKey = pullRequestIdempotencySegment(details.pullRequest);
  const headKey = safeKeySegment(details.pullRequest.headSha ?? "no-head-sha");
  const eventKey = `pull-request-handoff:${pullRequestKey}:${headKey}`;
  return [
    {
      idempotencyKey: `comment:${context.issue.id}:${eventKey}`,
      kind: "comment",
      issueId: context.issue.id,
      runId: context.runId,
      payload: {
        dedupeKey: eventKey,
        body: [
          "## Symphony PR Handoff",
          "",
          "Status: verified PR ready for human review",
          "Symphony verified the lifecycle-bound pull request before handing off the issue.",
          `Next state: ${targetState} (PR review handoff)`,
          "",
          `Run: ${context.runId}`,
          `Session: ${context.sessionId ?? "n/a"}`,
          `Workspace: ${context.workspacePath ?? context.workspace?.path ?? "n/a"}`,
          `Branch: ${context.workspace?.gitBranchName ?? context.issue.branchName ?? details.pullRequest.branch ?? "n/a"}`,
          "",
          "Pull request:",
          `- PR: ${formatPullRequest(details.pullRequest)}`,
          ...(details.pullRequest.headSha ? [`- PR head SHA: ${details.pullRequest.headSha}`] : []),
          `- Draft: ${details.pullRequest.draft === true ? "yes" : "no"}`,
          ...formatPullRequestHandoffChecks(details.ci ?? null),
          ...(details.report ? formatCompletionReportForComment(details.report) : []),
        ].join("\n"),
      },
    },
    {
      idempotencyKey: `transition:${context.issue.id}:${eventKey}:${targetState}`,
      kind: "transition",
      issueId: context.issue.id,
      runId: context.runId,
      payload: {
        fromStates: handoffFromStates,
        toState: targetState,
        reason: "Symphony verified pull request handoff",
      },
    },
  ];
}

export function planAcceptedArtifactHandoffWritebacks(
  context: RunWritebackContext,
  config: ServiceConfig,
  details: AcceptedArtifactHandoffWritebackDetails,
): NewWritebackOperation[] {
  if (!config.writeback.enabled) return [];
  const handoffFromStates = completionReportAcceptedFromStates(config);
  if (!isStateIn(context.issue.state, handoffFromStates)) return [];
  const targetState = config.reviewLoop.reviewStates[0];
  if (!targetState) return [];
  if (
    details.pullRequest.draft !== true ||
    details.artifactEvidence.kind !== "expected_red_tests" ||
    !Number.isInteger(details.artifactEvidence.exitCode) ||
    details.artifactEvidence.exitCode <= 0
  ) {
    return [];
  }

  const pullRequestKey = pullRequestIdempotencySegment(details.pullRequest);
  const headKey = safeKeySegment(details.pullRequest.headSha ?? "no-head-sha");
  const reportKey = safeKeySegment(details.report.reportId);
  const eventKey = `pull-request-handoff:accepted-artifact:${pullRequestKey}:${headKey}:report-${reportKey}`;
  return [
    {
      idempotencyKey: `comment:${context.issue.id}:${eventKey}`,
      kind: "comment",
      issueId: context.issue.id,
      runId: context.runId,
      payload: {
        dedupeKey: eventKey,
        body: [
          "## Symphony Accepted-Artifact Handoff",
          "",
          "Status: expected-red test artifact ready for review",
          "This draft PR is an intentionally unmerged test artifact. Its expected nonzero test result is the deliverable, not a merge-readiness failure.",
          `Next state: ${targetState} (artifact review handoff)`,
          "",
          `Run: ${context.runId}`,
          `Session: ${context.sessionId ?? "n/a"}`,
          `Workspace: ${context.workspacePath ?? context.workspace?.path ?? "n/a"}`,
          `Branch: ${context.workspace?.gitBranchName ?? context.issue.branchName ?? details.pullRequest.branch ?? "n/a"}`,
          "",
          "Draft pull request:",
          `- PR: ${formatPullRequest(details.pullRequest)}`,
          ...(details.pullRequest.headSha ? [`- PR head SHA: ${details.pullRequest.headSha}`] : []),
          "- Draft: yes",
          "",
          "Expected-red evidence:",
          `- Command: ${details.artifactEvidence.command}`,
          `- Expected failure: ${details.artifactEvidence.expectedFailure}`,
          `- Observed failure: ${details.artifactEvidence.observedFailure}`,
          `- Intentional nonzero exit code: ${details.artifactEvidence.exitCode}`,
          `- Test files: ${details.artifactEvidence.testFiles.join(", ")}`,
          ...formatCompletionReportForComment(details.report),
        ].join("\n"),
      },
    },
    {
      idempotencyKey: `transition:${context.issue.id}:${eventKey}:${targetState}`,
      kind: "transition",
      issueId: context.issue.id,
      runId: context.runId,
      payload: {
        fromStates: handoffFromStates,
        toState: targetState,
        reason: "Symphony verified accepted-artifact draft PR handoff",
      },
    },
  ];
}

export function planAcceptedArtifactCompletionWritebacks(
  context: AcceptedArtifactCompletionWritebackContext,
  config: ServiceConfig,
): NewWritebackOperation[] {
  if (!config.writeback.enabled || !isStateIn(context.issue.state, context.fromStates)) return [];
  const artifact = context.artifact;
  const eventKey = `accepted-artifact:${safeKeySegment(artifact.id)}:completed-unmerged`;
  return [
    {
      idempotencyKey: artifact.commentOperationKey,
      kind: "comment",
      issueId: context.issue.id,
      payload: {
        acceptedArtifactId: artifact.id,
        dedupeKey: eventKey,
        body: [
          "## Symphony Accepted Test Artifact",
          "",
          "Status: completed without merge",
          "The reviewed expected-red tests were checkpointed for dependent implementation issues, and the draft pull request was closed unmerged.",
          "",
          `Artifact: ${artifact.id}`,
          `Source head: ${artifact.sourceHeadSha}`,
          `Source base: ${artifact.sourceBaseHeadSha}`,
          `Source branch: ${artifact.pullRequest.branch ?? "n/a"}`,
          `Draft PR: ${formatPullRequest(artifact.pullRequest)}`,
          `Test command: ${artifact.artifactEvidence.command}`,
          `Intentional nonzero exit code: ${artifact.artifactEvidence.exitCode}`,
          `Test files: ${artifact.artifactEvidence.testFiles.join(", ")}`,
          "",
          "Dependent implementation issues may now seed their workspaces from this reviewed artifact.",
        ].join("\n"),
      },
    },
    {
      idempotencyKey: artifact.doneTransitionOperationKey,
      kind: "transition",
      issueId: context.issue.id,
      payload: {
        acceptedArtifactId: artifact.id,
        fromStates: context.fromStates,
        toState: context.doneState,
        reason: "Symphony accepted reviewed expected-red test artifact without merge",
      },
    },
  ];
}

export function planCompletionReportPublicationApprovalPendingWritebacks(
  context: RunWritebackContext,
  config: ServiceConfig,
  report: CompletionReportWritebackDetails,
  action: PublicationApprovalActionDetails,
): NewWritebackOperation[] {
  if (!config.writeback.enabled || !isStateIn(context.issue.state, [config.writeback.dispatchState])) return [];

  const blockedState = config.reviewLoop.blockedStates[0] ?? null;
  const eventKey = `${context.runId}:completion-report:${safeKeySegment(report.idempotencyKey)}:publication-approval-pending`;
  const operations: NewWritebackOperation[] = [
    {
      idempotencyKey: `comment:${context.issue.id}:${eventKey}`,
      kind: "comment",
      issueId: context.issue.id,
      runId: context.runId,
      payload: {
        dedupeKey: eventKey,
        body: [
          "## Symphony Publication Approval Setup Incomplete",
          "",
          "Status: worker completion report persisted; Symphony is preparing service-owned push/PR publication approval.",
          "Symphony will not dispatch another worker while publication approval setup is pending.",
          "",
          `Run: ${context.runId}`,
          `Workspace: ${context.workspacePath ?? context.workspace?.path ?? action.workspacePath}`,
          `Branch: ${action.branchName}`,
          `Base branch: ${action.baseBranch}`,
          `PR title: ${action.title}`,
          "",
          "Recovery:",
          "- Symphony will retry this setup and create the operator approval request after the audit writebacks are durable.",
          "- At the time this setup audit is written, no operator approval request exists yet for this persisted report.",
          "- If Symphony status later shows awaiting operator approval, use the current approval request surfaced by the service.",
          "",
          blockedState === null
            ? "No blocked state is configured, so Symphony recorded a lifecycle-level blocked phase without changing the tracker state."
            : `Transitioning to non-dispatch state: ${blockedState}`,
          ...formatCompletionReportForComment(report),
        ].join("\n"),
      },
    },
  ];

  if (blockedState !== null) {
    operations.push({
      idempotencyKey: `transition:${context.issue.id}:${eventKey}:${blockedState}`,
      kind: "transition",
      issueId: context.issue.id,
      runId: context.runId,
      payload: {
        fromStates: [config.writeback.dispatchState],
        toState: blockedState,
        reason: "Symphony publication approval setup incomplete",
      },
    });
  }

  return operations;
}

export function planCompletionReportPublicationApprovalTerminalWritebacks(
  context: RunWritebackContext,
  config: ServiceConfig,
  report: CompletionReportWritebackDetails,
  status: "rejected" | "stale" | "expired" | "cancelled",
  reason: string | null,
): NewWritebackOperation[] {
  if (!config.writeback.enabled) return [];

  const fromStates = uniqueStates([config.writeback.dispatchState, ...config.reviewLoop.blockedStates]);
  if (!isStateIn(context.issue.state, fromStates)) return [];

  const eventKey = `${context.runId}:completion-report:${safeKeySegment(report.idempotencyKey)}:publication-approval-${status}`;
  return [
    {
      idempotencyKey: `comment:${context.issue.id}:${eventKey}`,
      kind: "comment",
      issueId: context.issue.id,
      runId: context.runId,
      payload: {
        dedupeKey: eventKey,
        body: [
          "## Symphony Publication Approval Not Completed",
          "",
          `Status: ${status}`,
          `Reason: ${reason ?? "n/a"}`,
          "",
          "The worker completion report remains stored, but Symphony did not publish a PR.",
          "",
          "Recovery:",
          "- Inspect the stored completion report and worktree before retrying.",
          "- Move the issue back to the implementation state when Symphony should run another worker.",
          "- Submit a new completion report or approve a fresh publication request when ready.",
          ...formatCompletionReportForComment(report),
        ].join("\n"),
      },
    },
  ];
}

export function planReviewFailWritebacks(
  context: ReviewVerdictWritebackContext,
  config: ServiceConfig,
  requestedRevisions: string[] | ReviewVerdictWritebackDetails,
  reviewEvidence: PullRequestReviewEvidenceItem[] = [],
): NewWritebackOperation[] {
  if (!config.writeback.enabled || !isStateIn(context.issue.state, config.reviewLoop.reviewStates)) return [];

  const details = reviewVerdictDetailsFromInput(requestedRevisions);
  const gateFindings = reviewGateFindingsForDetails(details);
  const revisions = gateFindings.map((finding) => finding.summary.trim()).filter((revision) => revision.length > 0);
  const eventKey = `${context.runId}:review-verdict-fail`;
  return [
    {
      idempotencyKey: `comment:${context.issue.id}:${eventKey}`,
      kind: "comment",
      issueId: context.issue.id,
      runId: context.runId,
      payload: {
        dedupeKey: eventKey,
        body: [
          "## Symphony Review Verdict: Fail",
          "",
          "Status: requested revisions",
          "Symphony review failed.",
          `Next state: ${config.writeback.dispatchState}`,
          "",
          "Gate findings requiring worker repair:",
          "",
          ...(revisions.length === 0
            ? ["- Reviewer did not provide concrete requested revisions."]
            : revisions.map((revision) => `- ${revision}`)),
          "",
          `Run: ${context.runId}`,
          `Reviewer: ${context.reviewer ?? "n/a"}`,
          ...formatReviewVerdictDetails(details),
          ...formatReviewEvidenceForLinearComment(reviewEvidence),
        ].join("\n"),
      },
    },
    {
      idempotencyKey: `transition:${context.issue.id}:${eventKey}:${config.writeback.dispatchState}`,
      kind: "transition",
      issueId: context.issue.id,
      runId: context.runId,
      payload: {
        fromStates: config.reviewLoop.reviewStates,
        toState: config.writeback.dispatchState,
        reason: "Symphony review requested revisions",
      },
    },
  ];
}

export function planReviewBlockedWritebacks(
  context: ReviewVerdictWritebackContext,
  config: ServiceConfig,
  summary: string[] | ReviewVerdictWritebackDetails,
): NewWritebackOperation[] {
  if (!config.writeback.enabled || !isStateIn(context.issue.state, config.reviewLoop.reviewStates)) return [];

  const details = reviewVerdictDetailsFromInput(summary);
  const blockedState = config.reviewLoop.blockedStates[0] ?? null;
  const provenance = details.blockerProvenance ?? null;
  const recoveryKind = provenance?.recoveryKind ?? null;
  const automaticBaseRefRepair = recoveryKind === "automatic_rebase";
  const automaticBaseRefRecheck = recoveryKind === "automatic_recheck";
  const automaticBaseRefRecovery =
    automaticBaseRefRepair || automaticBaseRefRecheck;
  const eventKey = `${context.runId}:review-verdict-blocked`;
  return [
    {
      idempotencyKey: `comment:${context.issue.id}:${eventKey}`,
      kind: "comment",
      issueId: context.issue.id,
      runId: context.runId,
      payload: {
        dedupeKey: eventKey,
        body: [
          "## Symphony Review Verdict: Blocked",
          "",
          automaticBaseRefRecovery
            ? "Status: review paused, automatic Symphony recovery pending"
            : "Status: review blocked, triage required",
          automaticBaseRefRepair
            ? "Symphony's review-feedback base check identified repairable base-ref drift."
            : automaticBaseRefRecheck
              ? "Symphony's review-feedback base check encountered a transient verification failure."
              : "Symphony review could not complete because the reviewer identified a non-worker-owned blocker.",
          automaticBaseRefRecovery
            ? "Linear state: unchanged in review while Symphony performs service-owned recovery."
            : blockedState === null
              ? "Next state: unchanged; no blocked state is configured, so operator routing is required."
              : `Next state: ${blockedState}; Symphony will transition the issue before triage or operator routing.`,
          "",
          `Run: ${context.runId}`,
          `Reviewer: ${context.reviewer ?? "n/a"}`,
          "",
          "Blocked findings:",
          ...listOrFallback(details.findings, "No blocker summary supplied."),
          ...formatReviewBlockedDetails(details),
          ...formatBlockerProvenanceForComment(provenance),
          "",
          "Next action:",
          automaticBaseRefRepair
            ? "Symphony will run its service-owned base-ref repair using the linked observation; no human triage is required unless that repair fails."
            : automaticBaseRefRecheck
              ? "Symphony will re-run the provenance-bound base-ref check on the next polling tick; no human triage is required while the failure remains transient."
              : "Symphony will run issue triage when enabled; otherwise inspect the reviewer blocker and choose the appropriate recovery path.",
        ].join("\n"),
      },
    },
  ];
}

export function planReviewPassWritebacks(
  context: ReviewVerdictWritebackContext,
  config: ServiceConfig,
  summary: string | ReviewVerdictWritebackDetails | null = null,
): NewWritebackOperation[] {
  if (!config.writeback.enabled || !isStateIn(context.issue.state, config.reviewLoop.reviewStates)) return [];

  const eventKey = `${context.runId}:review-verdict-pass`;
  const details = typeof summary === "object" && summary !== null ? summary : null;
  const summaryText = typeof summary === "string" ? summary : null;
  const operations: NewWritebackOperation[] = [
    {
      idempotencyKey: `comment:${context.issue.id}:${eventKey}`,
      kind: "comment",
      issueId: context.issue.id,
      runId: context.runId,
      payload: {
        dedupeKey: eventKey,
        body: [
          "## Symphony Review Verdict: Pass",
          "",
          "Status: passed",
          "Symphony review passed.",
          "",
          `Run: ${context.runId}`,
          `Reviewer: ${context.reviewer ?? "n/a"}`,
          config.reviewLoop.reviewPassState === null
            ? "Review passed marker: review-passed"
            : `Review pass state: ${config.reviewLoop.reviewPassState}`,
          ...(summaryText === null || summaryText.trim().length === 0 ? [] : ["", "Summary:", summaryText.trim()]),
          ...(details === null ? [] : formatReviewVerdictDetails(details)),
        ].join("\n"),
      },
    },
  ];

  if (config.reviewLoop.reviewPassState !== null) {
    operations.push({
      idempotencyKey: `transition:${context.issue.id}:${eventKey}:${config.reviewLoop.reviewPassState}`,
      kind: "transition",
      issueId: context.issue.id,
      runId: context.runId,
      payload: {
        fromStates: config.reviewLoop.reviewStates,
        toState: config.reviewLoop.reviewPassState,
        reason: "Symphony review passed",
      },
    });
  }

  return operations;
}

export function planReviewAcceptedArtifactPassWritebacks(
  context: ReviewVerdictWritebackContext,
  config: ServiceConfig,
  summary: string | ReviewVerdictWritebackDetails | null = null,
): NewWritebackOperation[] {
  if (!config.writeback.enabled || !isStateIn(context.issue.state, config.reviewLoop.reviewStates)) return [];

  const eventKey = `${context.runId}:review-verdict-pass-artifact`;
  const details = typeof summary === "object" && summary !== null ? summary : null;
  const summaryText = typeof summary === "string" ? summary : null;
  return [
    {
      idempotencyKey: `comment:${context.issue.id}:${eventKey}`,
      kind: "comment",
      issueId: context.issue.id,
      runId: context.runId,
      payload: {
        dedupeKey: eventKey,
        body: [
          "## Symphony Review Verdict: Accepted Artifact",
          "",
          "Status: passed",
          "The expected-red test artifact passed review without merge authorization.",
          "Symphony will checkpoint the reviewed head, close the draft PR unmerged, and complete this issue through the accepted-artifact transition.",
          "",
          `Run: ${context.runId}`,
          `Reviewer: ${context.reviewer ?? "n/a"}`,
          ...(summaryText === null || summaryText.trim().length === 0 ? [] : ["", "Summary:", summaryText.trim()]),
          ...(details === null ? [] : formatReviewVerdictDetails(details)),
        ].join("\n"),
      },
    },
  ];
}

export function planReviewVerdictDispositionOnlyWriteback(
  context: ReviewVerdictWritebackContext,
  config: ServiceConfig,
  details: ReviewVerdictDispositionOnlyWritebackDetails,
): NewWritebackOperation[] {
  if (!config.writeback.enabled || details.finalDisposition === undefined) {
    return [];
  }
  const eventKey = `${context.runId}:review-verdict-${details.verdict}:${safeKeySegment(details.idempotencyKey)}:disposition-only`;
  return [
    {
      idempotencyKey: `comment:${context.issue.id}:${eventKey}`,
      kind: "comment",
      issueId: context.issue.id,
      runId: context.runId,
      payload: {
        dedupeKey: eventKey,
        body: [
          `## Symphony Review Verdict: ${reviewVerdictTitle(details.verdict)}`,
          "",
          "Status: accepted by manual state-gate override",
          `Run: ${context.runId}`,
          `Reviewer: ${context.reviewer ?? "n/a"}`,
          ...formatFinalDispositionForComment(details.finalDisposition),
        ].join("\n"),
      },
    },
  ];
}

export function planBlockedEscalationWritebacks(
  context: BlockedEscalationWritebackContext,
  config: ServiceConfig,
): NewWritebackOperation[] {
  if (!config.writeback.enabled) return [];

  const fromStates = uniqueStates([
    ...config.tracker.activeStates,
    ...config.tracker.handoffStates,
    ...config.reviewLoop.reviewStates,
    ...(config.mergePolicy.mode === "gated" && config.mergePolicy.conflictsState !== null ? [config.mergePolicy.conflictsState] : []),
    ...(context.fromStates ?? []),
  ]);
  if (!isStateIn(context.issue.state, fromStates)) return [];

  const blockedState = config.reviewLoop.blockedStates[0] ?? null;
  const eventKey = `${context.runId}:blocked-escalation`;
  const requiredAction =
    config.issueTriage.enabled && isIssueTriageEligibleBlockedReason(context.reason)
      ? "Symphony will run issue triage for this blocker and publish a follow-up recommendation on the issue. Inspect the latest output only if the triage run does not complete or calls for immediate manual intervention."
      : context.requiredAction ??
        "Inspect the latest worker output and reviewer feedback, then move the issue out of the blocked state when it is safe for Symphony to continue.";
  const operations: NewWritebackOperation[] = [
    {
      idempotencyKey: `comment:${context.issue.id}:${eventKey}`,
      kind: "comment",
      issueId: context.issue.id,
      runId: context.runId,
      payload: {
        dedupeKey: eventKey,
        body: [
          "## Symphony Blocked Escalation",
          "",
          "Status: blocked, human action required",
          "",
          `Run: ${context.runId}`,
          `Ceiling reason: ${context.reason}`,
          "",
          "Counts:",
          `- Incomplete turns: ${formatCount(context.incompleteTurnCount, context.maxIncompleteTurns)}`,
          `- Review rounds: ${formatCount(context.reviewRound, context.maxReviewRounds)}`,
          ...(context.acceptedArtifactValidationFailureCount === undefined
            ? []
            : [
                `- Accepted-artifact validation failures: ${formatCount(
                  context.acceptedArtifactValidationFailureCount,
                  context.maxAcceptedArtifactValidationFailures,
                )}`,
              ]),
          "",
          "Last completion report:",
          ...formatCompletionReportSummary(context.lastCompletionReport ?? null),
          "",
          "Last review verdict:",
          ...formatReviewVerdictSummary(context.lastReviewVerdict ?? null),
          "",
          "Required human action:",
          requiredAction,
          ...formatBlockerProvenanceForComment(
            context.blockerProvenance ?? null,
          ),
          ...formatFinalDispositionForComment(context.finalDisposition),
          "",
          blockedState === null
            ? "No blocked state is configured, so Symphony left the issue state unchanged and automation should remain paused."
            : `Transitioning to blocked state: ${blockedState}`,
        ].join("\n"),
      },
    },
  ];

  if (blockedState !== null) {
    operations.push({
      idempotencyKey: `transition:${context.issue.id}:${eventKey}:${blockedState}`,
      kind: "transition",
      issueId: context.issue.id,
      runId: context.runId,
      payload: {
        fromStates,
        toState: blockedState,
        reason: `Symphony blocked: ${context.reason}`,
      },
    });
  }

  return operations;
}

export function planReviewFailureCeilingTriageWritebacks(
  context: BlockedEscalationWritebackContext,
  config: ServiceConfig,
): NewWritebackOperation[] {
  if (!config.writeback.enabled || !config.issueTriage.enabled) return [];
  if (!isStateIn(context.issue.state, config.reviewLoop.reviewStates)) return [];

  const eventKey = `${context.runId}:review-ceiling-triage`;
  return [
    {
      idempotencyKey: `comment:${context.issue.id}:${eventKey}`,
      kind: "comment",
      issueId: context.issue.id,
      runId: context.runId,
      payload: {
        dedupeKey: eventKey,
        body: [
          "## Symphony Review Ceiling",
          "",
          "Status: paused in review, automated triage pending",
          "",
          `Run: ${context.runId}`,
          `Ceiling reason: ${context.reason}`,
          "",
          "Counts:",
          `- Incomplete turns: ${formatCount(context.incompleteTurnCount, context.maxIncompleteTurns)}`,
          `- Review rounds: ${formatCount(context.reviewRound, context.maxReviewRounds)}`,
          "",
          "Last completion report:",
          ...formatCompletionReportSummary(context.lastCompletionReport ?? null),
          "",
          "Last review verdict:",
          ...formatReviewVerdictSummary(context.lastReviewVerdict ?? null),
          "",
          "Next action:",
          "Symphony will classify the active blockers before changing Linear state. Machine-owned repair will resume automatically; Linear Blocked is reserved for work that cannot continue without external or human action.",
          ...formatBlockerProvenanceForComment(
            context.blockerProvenance ?? null,
          ),
          ...formatFinalDispositionForComment(context.finalDisposition),
        ].join("\n"),
      },
    },
  ];
}

export function planIssueTriageReportWritebacks(
  context: IssueTriageReportWritebackContext,
  config: ServiceConfig,
): NewWritebackOperation[] {
  if (!config.writeback.enabled) return [];
  const eventKey = `issue-triage:${safeKeySegment(context.report.idempotencyKey)}`;
  const recoveryDisposition =
    context.report.recoveryDisposition ??
    decideIssueTriageRecoveryDisposition(context, config);
  const automaticallyActionable = recoveryDisposition.mode === "automated";
  const operations: NewWritebackOperation[] = [
    {
      idempotencyKey: `comment:${context.issue.id}:${eventKey}`,
      kind: "comment",
      issueId: context.issue.id,
      runId: context.report.runId,
      payload: {
        dedupeKey: eventKey,
        body: [
          "## Symphony Issue Triage",
          "",
          automaticallyActionable
            ? "Status: triage complete, automated recovery scheduled"
            : "Status: triage complete, human or external action required",
          "",
          `Run: ${context.report.runId}`,
          `Blocked reason: ${context.blockedReason ?? "n/a"}`,
          "",
          "Summary:",
          context.report.summary,
          "",
          "Blockers, ordered by Symphony precedence:",
          ...formatIssueTriageBlockerWritebackLines(context.report),
          "",
          automaticallyActionable
            ? "Automated recovery action:"
            : "Recommended human or external action:",
          context.report.recommendedAction,
          "",
          "Recovery provenance:",
          `- Mode: ${recoveryDisposition.mode}`,
          `- Next actor: ${recoveryDisposition.nextActor ?? "none"}`,
          `- Target state: ${recoveryDisposition.targetState ?? "not configured"}`,
          `- Full report writeback: ${recoveryDisposition.reportWritebackStatus}`,
          `- Transition operation: ${recoveryDisposition.transitionOperationKey ?? recoveryDisposition.transitionStatus}`,
          `- Decision: ${recoveryDisposition.reason}`,
          ...(automaticallyActionable
            ? [
                "",
                `Transitioning to ${config.writeback.dispatchState}; Symphony will reset the exhausted review budget and route ${recoveryDisposition.nextActor === "planner" ? "planning before implementation" : "a focused worker repair"}.`,
              ]
            : [
                "",
                "Operator next-action matrix:",
                ...formatIssueTriageNextActionMatrix(context, config),
              ]),
          ...formatFinalDispositionForComment(context.report.finalDisposition),
        ].join("\n"),
      },
    },
  ];

  if (
    recoveryDisposition.targetState !== null &&
    recoveryDisposition.transitionOperationKey !== null &&
    recoveryDisposition.transitionStatus === "pending"
  ) {
    const fromStates = uniqueStates([
      ...config.tracker.activeStates,
      ...config.tracker.handoffStates,
      ...config.reviewLoop.reviewStates,
      ...config.reviewLoop.blockedStates,
      ...(config.mergePolicy.mode === "gated" &&
      config.mergePolicy.conflictsState !== null
        ? [config.mergePolicy.conflictsState]
        : []),
    ]);
    if (isStateIn(context.issue.state, fromStates)) {
      operations.push({
        idempotencyKey: recoveryDisposition.transitionOperationKey,
        kind: "transition",
        issueId: context.issue.id,
        runId: context.report.runId,
        payload: {
          fromStates,
          toState: recoveryDisposition.targetState,
          reason: automaticallyActionable
            ? "Symphony triage identified machine-owned recovery"
            : "Symphony triage requires human or external action",
        },
      });
    }
  }

  return operations;
}

export function decideIssueTriageRecoveryDisposition(
  context: IssueTriageReportWritebackContext,
  config: ServiceConfig,
): IssueTriageRecoveryDispositionRecord {
  const routeDecision = decideIssueTriageRecoveryRoute(
    {
      issue: context.issue,
      blockers: context.report.blockers,
      ...(context.planningFailureCount === undefined
        ? {}
        : { planningFailureCount: context.planningFailureCount }),
      ...(context.hasFreshIssueBreakdownPlan === undefined
        ? {}
        : { hasFreshIssueBreakdownPlan: context.hasFreshIssueBreakdownPlan }),
      ...(context.issueBreakdownPlanApplicationStatus === undefined
        ? {}
        : {
            issueBreakdownPlanApplicationStatus:
              context.issueBreakdownPlanApplicationStatus,
          }),
      ...(context.incompleteTurnCount === undefined
        ? {}
        : { incompleteTurnCount: context.incompleteTurnCount }),
      ...(context.hasActiveMergeConflict === undefined
        ? {}
        : { hasActiveMergeConflict: context.hasActiveMergeConflict }),
    },
    config,
  );
  const targetState = routeDecision.targetState;
  const fromStates = uniqueStates([
    ...config.tracker.activeStates,
    ...config.tracker.handoffStates,
    ...config.reviewLoop.reviewStates,
    ...config.reviewLoop.blockedStates,
    ...(config.mergePolicy.mode === "gated" &&
    config.mergePolicy.conflictsState !== null
      ? [config.mergePolicy.conflictsState]
      : []),
  ]);
  const transitionRequired =
    targetState !== null && !sameName(context.issue.state, targetState);
  const transitionEligible =
    config.writeback.enabled &&
    transitionRequired &&
    isStateIn(context.issue.state, fromStates);
  const route =
    routeDecision.mode === "automated"
      ? "automated-recovery"
      : "external-block";
  const eventKey = `issue-triage:${safeKeySegment(context.report.idempotencyKey)}`;
  return {
    ...routeDecision,
    reportWritebackStatus: config.writeback.enabled ? "pending" : "failed",
    transitionOperationKey:
      transitionEligible && targetState !== null
        ? `transition:${context.issue.id}:${eventKey}:${route}:${safeKeySegment(targetState)}`
        : null,
    transitionStatus:
      targetState === null || (transitionRequired && !transitionEligible)
        ? "failed"
        : transitionRequired
          ? "pending"
          : "not_required",
  };
}

/**
 * Selects a durable recovery route from current issue state. The result has no
 * report identity or writeback status, so ruleset snapshots can safely
 * re-evaluate it when assignment, labels, children, or configuration change.
 */
export function decideIssueTriageRecoveryRoute(
  context: IssueTriageRecoveryRouteContext,
  config: ServiceConfig,
): IssueTriageRecoveryRouteDecision {
  const activeBlockers = context.blockers.filter(
    (blocker) => blocker.status === "active",
  );
  const activeActors = new Set(
    activeBlockers.map((blocker) => blocker.nextActor),
  );
  const plannerRecoveryAvailable = issueTriagePlannerRecoveryAvailable(
    context,
    config,
  );
  const workerRecovery = evaluateWorkerDispatchCapability(
    context.issue,
    config,
    config.writeback.dispatchState,
    {
      hasFreshIssueBreakdownPlan:
        context.hasFreshIssueBreakdownPlan === true,
      issueBreakdownPlanApplicationStatus:
        context.issueBreakdownPlanApplicationStatus ?? null,
      ...(context.incompleteTurnCount === undefined
        ? {}
        : { incompleteTurnCount: context.incompleteTurnCount }),
      ...(context.hasActiveMergeConflict === undefined
        ? {}
        : { hasActiveMergeConflict: context.hasActiveMergeConflict }),
    },
  );
  const machineActorsOnly = [...activeActors].every(
    (actor) => actor === "worker" || actor === "planner",
  );
  const plannerOwnsWorkerPrerequisite =
    activeActors.has("worker") &&
    (workerRecovery.reason === "planning_required" ||
      workerRecovery.reason === "issue_breakdown_application_required") &&
    plannerRecoveryAvailable;
  const selectedActor =
    activeActors.has("planner") || plannerOwnsWorkerPrerequisite
      ? "planner"
      : activeActors.has("worker")
        ? "worker"
        : null;
  const automaticallyActionable =
    config.writeback.enabled &&
    activeBlockers.length > 0 &&
    machineActorsOnly &&
    selectedActor !== null &&
    (selectedActor === "planner"
      ? plannerRecoveryAvailable
      : workerRecovery.available);
  const mode = automaticallyActionable ? "automated" : "external";
  const nextActor = automaticallyActionable ? selectedActor : null;
  const targetState = automaticallyActionable
    ? config.writeback.dispatchState
    : (config.reviewLoop.blockedStates[0] ?? null);
  return {
    mode,
    nextActor,
    targetState,
    reason: automaticallyActionable
      ? plannerOwnsWorkerPrerequisite
        ? "machine-owned issue breakdown prerequisite routed to planner"
        : `machine-owned recovery routed to ${nextActor}`
      : "triage requires human or external action, or no durable machine route is available",
  };
}

function issueTriagePlannerRecoveryAvailable(
  context: IssueTriageRecoveryRouteContext,
  config: ServiceConfig,
): boolean {
  if (
    !config.issueBreakdown.enabled ||
    !config.issueBreakdown.applyToLinear.enabled ||
    !config.issueBreakdown.applyToLinear.autoApply ||
    !isStateIn(
      config.writeback.dispatchState,
      config.tracker.activeStates,
    ) ||
    !context.issue.assignedToWorker ||
    context.issue.hasChildren ||
    context.issue.childrenTruncated === true ||
    (context.issue.children?.length ?? 0) > 0 ||
    (context.planningFailureCount ?? 0) >=
      config.issueBreakdown.maxPlanningFailures
  )
    return false;
  const labels = new Set(
    context.issue.labels.map((label) => label.trim().toLowerCase()),
  );
  if (
    config.agent.requireLabels.some(
      (label) => !labels.has(label.trim().toLowerCase()),
    )
  )
    return false;
  if (
    config.agent.excludeLabels.some((label) =>
      labels.has(label.trim().toLowerCase()),
    ) ||
    config.agent.plannerExcludeLabels.some((label) =>
      labels.has(label.trim().toLowerCase()),
    )
  )
    return false;
  const contract = parseIssueContract(context.issue.description);
  return !(
    contract.valid &&
    contract.contract.delivery.mode === "accepted_artifact" &&
    contract.contract.delivery.artifact === "expected_red_tests"
  );
}

function formatIssueTriageBlockerWritebackLines(report: IssueTriageReportRecord): string[] {
  return report.blockers.flatMap((blocker, index) => [
    "",
    `### ${index + 1}. ${blocker.kind}`,
    "",
    `Status: ${blocker.status}`,
    `Next actor: ${blocker.nextActor}`,
    `Confidence: ${blocker.confidence}`,
    "",
    "Summary:",
    blocker.summary,
    "",
    "Evidence:",
    ...blocker.evidence.map((item) => `- ${item}`),
    "",
    "Recommended action:",
    blocker.recommendedAction,
  ]);
}

function formatIssueTriageNextActionMatrix(context: IssueTriageReportWritebackContext, config: ServiceConfig): string[] {
  const blockedState = config.reviewLoop.blockedStates[0] ?? null;
  const dispatchState = config.writeback.dispatchState;
  const reviewPassState = config.reviewLoop.reviewPassState;
  const conflictsState = config.mergePolicy.mode === "gated" ? config.mergePolicy.conflictsState : null;
  const issueKey = context.issue.identifier || context.issue.id;
  const rows = [
    [
      blockedState === null ? "Leave blocked lifecycle as-is" : `Leave in ${blockedState}`,
      "Symphony does not dispatch more issue work.",
      "Use when the blocker still needs an external/operator fix.",
      blockedState === null ? "Lifecycle remains blocked." : `Issue remains in ${blockedState}.`,
    ],
    [
      `Move to ${dispatchState}`,
      "Symphony resets the blocked failure budget and starts the normal worker implementation path.",
      "Use when the triage blocker is worker-repairable code, test, or implementation behavior.",
      "Success moves through review and then merge gate; failure gets a fresh max-failure window before blocking again.",
    ],
    [
      "CLI: agent run --stage worker --force --ignore-state",
      "Symphony resets the blocked failure budget for this explicit manual worker run.",
      `Use when the issue should get one direct worker turn without changing tracker state first. Issue: ${issueKey}.`,
      "Success follows the worker completion path; failure can block again after the configured budget.",
    ],
    [
      "CLI: agent run --stage triage --force --ignore-state",
      "Symphony runs read-only triage again.",
      "Use when the operator wants a fresh diagnosis after external state changed.",
      "This does not resolve the issue by itself; it publishes another triage report if eligible.",
    ],
  ];
  if (reviewPassState !== null) {
    rows.splice(2, 0, [
      `Move to ${reviewPassState}`,
      "Symphony resets the merge-gate failure budget and evaluates the lifecycle-bound pull request again.",
      "Use when CI, mergeability, or another merge-gate input was fixed out of band.",
      "Success merges and moves to the configured done state; failure dispatches repair or blocks after the fresh gate budget.",
    ]);
  }
  if (conflictsState !== null) {
    rows.splice(reviewPassState === null ? 2 : 3, 0, [
      `Move to ${conflictsState}`,
      "Symphony resets conflict-fix attempts and starts the prepared merge-conflict repair path.",
      "Use when the current blocker is an actual pull request merge conflict.",
      "Success returns the issue to the worker queue for reverification and a fresh review; unresolved conflicts can block again after the fresh conflict-fix budget.",
    ]);
  }
  return [
    "| Action/status | Symphony reaction | When to use | Expected outcome |",
    "|---|---|---|---|",
    ...rows.map((row) => `| ${row.map(escapeMarkdownTableCell).join(" | ")} |`),
  ];
}

function escapeMarkdownTableCell(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
}

export function planIssuePostMortemReportWritebacks(
  context: IssuePostMortemReportWritebackContext,
  config: ServiceConfig,
): NewWritebackOperation[] {
  if (!config.writeback.enabled) return [];
  const eventKey = `issue-post-mortem:${safeKeySegment(context.report.idempotencyKey)}`;
  return [
    {
      idempotencyKey: `comment:${context.issue.id}:${eventKey}`,
      kind: "comment",
      issueId: context.issue.id,
      runId: context.report.runId,
      payload: {
        dedupeKey: eventKey,
        body: [
          "## Symphony Post-Mortem",
          "",
          "Status: post-mortem complete, follow-up candidates reported",
          "",
          `Run: ${context.report.runId}`,
          `Trigger fingerprint: ${context.report.triggerFingerprint}`,
          "",
          "Summary:",
          context.report.summary,
          "",
          "Completion judgment:",
          `- Status: ${context.report.completionJudgment.status}`,
          `- Rationale: ${context.report.completionJudgment.rationale}`,
          "",
          "Specification assessment:",
          `- Quality: ${context.report.specificationAssessment.quality}`,
          `- Classifications: ${context.report.specificationAssessment.classifications.join(", ")}`,
          `- Spec Kit recommended: ${context.report.specificationAssessment.speckitRecommended ? "yes" : "no"}`,
          `- Spec Kit rationale: ${context.report.specificationAssessment.speckitRationale}`,
          "",
          "Missing contract areas:",
          ...formatListOrNone(context.report.specificationAssessment.missingContractAreas),
          "",
          "Review assessment:",
          `- Gate decision looks valid: ${context.report.reviewAssessment.gateDecisionLooksValid ? "yes" : "no"}`,
          "- Missed gate findings:",
          ...formatListOrNone(context.report.reviewAssessment.missedGateFindings),
          "- Missed discovery findings:",
          ...formatListOrNone(context.report.reviewAssessment.missedDiscoveryFindings),
          "",
          "Follow-up candidates:",
          ...formatPostMortemFollowUpWritebackLines(context.report),
          "",
          "Process lessons:",
          ...formatListOrNone(context.report.processLessons),
          ...formatFinalDispositionForComment(context.report.finalDisposition),
        ].join("\n"),
      },
    },
  ];
}

function formatPostMortemFollowUpWritebackLines(report: IssuePostMortemReportRecord): string[] {
  if (report.followUpCandidates.length === 0) return ["- None"];
  return report.followUpCandidates.flatMap((candidate, index) => [
    "",
    `### ${index + 1}. ${candidate.title}`,
    "",
    `Priority: ${candidate.priority}`,
    `Kind: ${candidate.kind}`,
    `Ready for Spec Kit: ${candidate.readyForSpecKit ? "yes" : "no"}`,
    "",
    "Rationale:",
    candidate.rationale,
    ...(candidate.suggestedIssueContract === null
      ? []
      : ["", "Suggested issue contract:", "```markdown", candidate.suggestedIssueContract, "```"]),
  ]);
}

function formatListOrNone(items: readonly string[]): string[] {
  return items.length === 0 ? ["- None"] : items.map((item) => `- ${item}`);
}

export function planMergeCompletedWritebacks(
  context: MergeCompletedWritebackContext,
  config: ServiceConfig,
): NewWritebackOperation[] {
  if (!config.writeback.enabled) return [];
  return [
    {
      idempotencyKey: `transition:${context.issue.id}:${context.mergeId}:${context.doneState}`,
      kind: "transition",
      issueId: context.issue.id,
      payload: {
        fromStates: [context.fromState],
        toState: context.doneState,
        reason: "Symphony reviewer-approved merge completed",
      },
    },
  ];
}

export function planOrganizationalParentCompletionWriteback(
  context: OrganizationalParentCompletionWritebackContext,
  config: ServiceConfig,
): NewWritebackOperation | null {
  if (!config.writeback.enabled) return null;
  return {
    idempotencyKey: `transition:${context.issue.id}:organizational-parent-complete:${context.doneState}`,
    kind: "transition",
    issueId: context.issue.id,
    payload: {
      fromStates: context.sourceStates,
      toState: context.doneState,
      reason: "Symphony completed organizational parent after all child issues reached a terminal state",
    },
  };
}

export function planMergeGateRepairWritebacks(
  context: MergeGateWritebackContext,
  config: ServiceConfig,
): NewWritebackOperation[] {
  if (!config.writeback.enabled) return [];
  const eventKey = mergeGateWritebackEventKey(context, "repair");
  const conflict = context.mergeability?.status === "conflicted";
  const requiredAction = conflict
    ? [
        "This generic merge-gate repair path has not prepared the PR worktree for merge-conflict resolution.",
        "Do not run git fetch, git pull, git merge, git rebase, git commit, git push, gh pr create, gh pr edit, or mutate the lifecycle-bound PR directly; Symphony must own those operations.",
        "A configured merge-conflict state is required before Symphony can dispatch a prepared conflict repair.",
        hasActionableCheckBlockers(context)
          ? "Also fix the failing or missing required checks before submitting the completion report."
          : "If mergeability is the only blocker, report that merge_policy.conflicts_state must be configured so Symphony can run the service-owned conflict-prep path.",
      ].join(" ")
    : [
        "Fix the failing required checks in the assigned worktree, validate the repair, leave the final implementation changes uncommitted and unpushed, and submit a new completion report.",
        "Do not run git commit, git push, gh pr create, gh pr edit, or mutate the lifecycle-bound PR directly; Symphony performs service-owned commit, push, and PR publication/reuse after accepting the completion report.",
      ].join(" ");
  return [
    mergeGateCommentOperation(
      context,
      eventKey,
      "repair required",
      `Next state: ${config.writeback.dispatchState} (worker repair queue)`,
      requiredAction,
    ),
    {
      idempotencyKey: `transition:${context.issue.id}:${eventKey}:${config.writeback.dispatchState}`,
      kind: "transition",
      issueId: context.issue.id,
      payload: {
        fromStates: [context.fromState],
        toState: config.writeback.dispatchState,
        reason: conflict ? "Symphony merge gate required PR repair" : "Symphony merge gate required CI repair",
      },
    },
  ];
}

export function planMergeGateBlockedWritebacks(
  context: MergeGateWritebackContext,
  config: ServiceConfig,
): NewWritebackOperation[] {
  if (!config.writeback.enabled) return [];
  const blockedState = config.reviewLoop.blockedStates[0] ?? null;
  const eventKey = mergeGateWritebackEventKey(context, "blocked");
  const conflict = context.mergeability?.status === "conflicted";
  const missingConflictState = conflict && config.mergePolicy.conflictsState === null;
  const requiredAction = missingConflictState
    ? "Configure merge_policy.conflicts_state to an existing tracker state so Symphony can prepare the lifecycle-bound PR worktree with service-owned git operations and dispatch a scoped merge-conflict worker."
    : config.issueTriage.enabled
    ? "Symphony will run issue triage for this merge-gate ceiling and publish a follow-up recommendation on the issue. Inspect the required checks or mergeability only if the triage run does not complete or calls for immediate manual intervention."
    : conflict
    ? "Inspect the merge conflicts and required checks, then decide whether to repair manually, reset approval, or override the merge gate."
    : "Inspect the failing required checks and decide whether to repair, adjust CI configuration, or manually override the merge gate.";
  const operations: NewWritebackOperation[] = [
    mergeGateCommentOperation(
      context,
      eventKey,
      "blocked, human action required",
      blockedState === null
        ? "No blocked state is configured, so Symphony recorded a lifecycle-level block without changing the tracker state."
        : `Transitioning to blocked state: ${blockedState}`,
      requiredAction,
    ),
  ];
  if (blockedState !== null) {
    operations.push({
      idempotencyKey: `transition:${context.issue.id}:${eventKey}:${blockedState}`,
      kind: "transition",
      issueId: context.issue.id,
      payload: {
        fromStates: [context.fromState],
        toState: blockedState,
        reason: "Symphony merge gate repair ceiling reached",
      },
    });
  }
  return operations;
}

function mergeGateWritebackEventKey(context: MergeGateWritebackContext, kind: "repair" | "blocked"): string {
  const fingerprintSegment = safeKeySegment(context.blockerFingerprint ?? "no-blocker-fingerprint");
  return `merge-gate:${safeKeySegment(context.gateId)}:${kind}:${fingerprintSegment}:r${context.reviewRound}`;
}

export function planMergeGateHeadSupersessionWritebacks(
  context: MergeGateHeadSupersessionWritebackContext,
  config: ServiceConfig,
): NewWritebackOperation[] {
  if (!config.writeback.enabled) return [];
  const eventKey = `merge-gate:${safeKeySegment(context.gateId)}:head-superseded:${safeKeySegment(context.liveHeadSha)}`;
  return [
    {
      idempotencyKey: `comment:${context.issue.id}:${eventKey}`,
      kind: "comment",
      issueId: context.issue.id,
      payload: {
        dedupeKey: eventKey,
        body: [
          "## Symphony Merge Gate",
          "",
          "Status: head superseded, implementation rebind required",
          `Next state: ${config.writeback.dispatchState} (worker queue)`,
          "",
          `PR: ${formatPullRequest(context.pullRequest)}`,
          `Previous PR head SHA: ${context.pullRequest.headSha ?? "n/a"}`,
          `Live PR head SHA: ${context.liveHeadSha}`,
          `Anchor report: ${context.reportId}`,
          "",
          "Required action:",
          "Submit a fresh completion report for the live PR head. Normal review and approval are required before Symphony can merge.",
        ].join("\n"),
      },
    },
    {
      idempotencyKey: `transition:${context.issue.id}:${eventKey}:${config.writeback.dispatchState}`,
      kind: "transition",
      issueId: context.issue.id,
      payload: {
        fromStates: uniqueStates([context.fromState, config.writeback.dispatchState]),
        toState: config.writeback.dispatchState,
        reason: "Symphony merge gate head superseded",
      },
    },
  ];
}

export function planMergeGateHeadSupersessionRecoveryWritebacks(
  context: MergeGateHeadSupersessionRecoveryWritebackContext,
  config: ServiceConfig,
): NewWritebackOperation[] {
  if (!config.writeback.enabled || config.reviewLoop.reviewPassState === null) return [];
  const eventKey = `merge-gate:${safeKeySegment(context.gateId)}:head-superseded-recovered:${safeKeySegment(context.liveHeadSha)}`;
  return [
    {
      idempotencyKey: `comment:${context.issue.id}:${eventKey}`,
      kind: "comment",
      issueId: context.issue.id,
      payload: {
        dedupeKey: eventKey,
        body: [
          "## Symphony Merge Gate",
          "",
          "Status: head superseded rebind satisfied",
          `Next state: ${config.reviewLoop.reviewPassState} (merge gate queue)`,
          "",
          `PR: ${formatPullRequest(context.pullRequest)}`,
          `Live PR head SHA: ${context.liveHeadSha}`,
          `Current completion report: ${context.reportId}`,
          `Current approval verdict: ${context.verdictId}`,
          "",
          "Required action:",
          "Symphony will evaluate the current PR head through the merge gate instead of dispatching another worker for the stale superseded head.",
        ].join("\n"),
      },
    },
    {
      idempotencyKey: `transition:${context.issue.id}:${eventKey}:${config.reviewLoop.reviewPassState}`,
      kind: "transition",
      issueId: context.issue.id,
      payload: {
        fromStates: [context.issue.state],
        toState: config.reviewLoop.reviewPassState,
        reason: "Symphony merge gate head supersession rebound satisfied",
      },
    },
  ];
}

export function planMergeConflictsWritebacks(
  context: MergeConflictsWritebackContext,
  config: ServiceConfig,
): NewWritebackOperation[] {
  if (!config.writeback.enabled) return [];
  const headSha = context.pullRequest.headSha ?? "unknown";
  const eventKey = `${context.mergeId}:merge-conflicts:${safeKeySegment(headSha)}`;
  return [
    {
      idempotencyKey: `comment:${context.issue.id}:${eventKey}`,
      kind: "comment",
      issueId: context.issue.id,
      payload: {
        dedupeKey: eventKey,
        body: [
          "## Symphony Gated Merge Blocked",
          "",
          "Status: pull request has merge conflicts",
          context.reason,
          "",
          `Pull request: ${formatPullRequest(context.pullRequest)}`,
          `PR head SHA: ${headSha}`,
          `GitHub mergeable_state: ${context.mergeableState ?? "unknown"}`,
          "",
          `Transitioning to conflict-fix state: ${context.conflictsState}`,
          "Symphony has prepared the worktree with service-owned git operations. A scoped conflict-fix worker must edit only the conflicted files and call submit_merge_conflict_resolution before merge can continue.",
          "The worker must not run git fetch, pull, merge, rebase, commit, push, or continue/abort/skip a rebase.",
        ].join("\n"),
      },
    },
    {
      idempotencyKey: `transition:${context.issue.id}:${eventKey}:${context.conflictsState}`,
      kind: "transition",
      issueId: context.issue.id,
      payload: {
        fromStates: [context.fromState],
        toState: context.conflictsState,
        reason: `Symphony gated merge blocked: ${context.reason}`,
      },
    },
  ];
}

export function planMergeConflictResolvedWritebacks(
  context: MergeConflictResolvedWritebackContext,
  config: ServiceConfig,
): NewWritebackOperation[] {
  if (!config.writeback.enabled) return [];
  const resolvedHeadSha = context.report.newHeadSha ?? context.report.pullRequest.headSha ?? "unknown";
  const eventKey = `merge-conflict-resolved:${safeKeySegment(context.report.idempotencyKey)}:${safeKeySegment(resolvedHeadSha)}`;
  return [
    {
      idempotencyKey: `comment:${context.issue.id}:${eventKey}`,
      kind: "comment",
      issueId: context.issue.id,
      runId: context.report.runId,
      payload: {
        dedupeKey: eventKey,
        body: [
          "## Symphony Conflict Repair Resolved",
          "",
          "Status: conflict repair resolved, worker reverification required",
          `Next state: ${config.writeback.dispatchState} (worker queue)`,
          "",
          `Run: ${context.report.runId}`,
          `Pull request: ${formatPullRequest(context.report.pullRequest)}`,
          `Base branch: ${context.report.baseBranch ?? "n/a"}`,
          `Base head SHA: ${context.report.baseHeadSha ?? "n/a"}`,
          `Previous conflicted head SHA: ${context.report.previousHeadSha ?? "n/a"}`,
          `Resolved head SHA: ${resolvedHeadSha}`,
          "",
          "Required action:",
          "Symphony finalized the prepared conflict repair. The implementation worker must revalidate the repaired changes and submit a fresh completion report before review and merge can continue.",
          ...formatFinalDispositionForComment(context.report.finalDisposition),
        ].join("\n"),
      },
    },
    {
      idempotencyKey: `transition:${context.issue.id}:${eventKey}:${config.writeback.dispatchState}`,
      kind: "transition",
      issueId: context.issue.id,
      runId: context.report.runId,
      payload: {
        fromStates: uniqueStates([
          context.fromState,
          context.conflictsState,
          config.writeback.dispatchState,
        ]),
        toState: config.writeback.dispatchState,
        reason: "Symphony conflict repair resolved; worker reverification required",
      },
    },
  ];
}

export function planMergeConflictStillConflictedWritebacks(
  context: MergeConflictStillConflictedWritebackContext,
  config: ServiceConfig,
): NewWritebackOperation[] {
  if (!config.writeback.enabled) return [];
  const currentHeadSha = context.report.newHeadSha ?? context.report.pullRequest.headSha ?? "unknown";
  const eventKey = `merge-conflict-still-conflicted:${safeKeySegment(context.report.idempotencyKey)}:${safeKeySegment(currentHeadSha)}`;
  return [
    {
      idempotencyKey: `comment:${context.issue.id}:${eventKey}`,
      kind: "comment",
      issueId: context.issue.id,
      runId: context.report.runId,
      payload: {
        dedupeKey: eventKey,
        body: [
          "## Symphony Conflict Repair Attempt",
          "",
          "Status: conflicts remain after this repair attempt",
          "The report was accepted and the issue remains in conflict-repair routing for another bounded attempt.",
          "",
          `Run: ${context.report.runId}`,
          `Pull request: ${formatPullRequest(context.report.pullRequest)}`,
          `Base branch: ${context.report.baseBranch ?? "n/a"}`,
          `Base head SHA: ${context.report.baseHeadSha ?? "n/a"}`,
          `Previous conflicted head SHA: ${context.report.previousHeadSha ?? "n/a"}`,
          `Current head SHA: ${currentHeadSha}`,
          "",
          "Validation evidence:",
          ...listOrFallback(context.report.validationEvidence, "No validation evidence supplied."),
          "",
          "Changed files:",
          ...listOrFallback(context.report.changedFiles, "No changed files supplied."),
          "",
          "Risks / follow-ups:",
          ...listOrFallback(context.report.risks, "No known risks or follow-ups."),
          ...formatFinalDispositionForComment(context.report.finalDisposition),
        ].join("\n"),
      },
    },
  ];
}

export function planBaseRefRepairWritebacks(
  context: BaseRefRepairWritebackContext,
  config: ServiceConfig,
): NewWritebackOperation[] {
  if (!config.writeback.enabled) return [];
  const eventKey = `base-ref-repair:${safeKeySegment(context.operationId)}:${safeKeySegment(context.rebasedHeadSha)}`;
  const localOnly = context.mode === "local_only";
  return [
    {
      idempotencyKey: `comment:${context.issue.id}:${eventKey}`,
      kind: "comment",
      issueId: context.issue.id,
      payload: {
        dedupeKey: eventKey,
        body: [
          "## Symphony Base Ref Repair",
          "",
          localOnly
            ? "Status: local worktree base refreshed, worker reverification required"
            : "Status: clean rebase published, worker reverification required",
          `Next state: ${config.writeback.dispatchState} (worker queue)`,
          "",
          `Branch: ${context.branchName}`,
          `Base branch: ${context.baseBranch}`,
          `Base head SHA: ${context.baseHeadSha}`,
          `Previous worktree head SHA: ${context.previousHeadSha}`,
          localOnly
            ? `Refreshed worktree head SHA: ${context.rebasedHeadSha}`
            : `Rebased worktree head SHA: ${context.rebasedHeadSha}`,
          "",
          "Required action:",
          localOnly
            ? "Symphony refreshed the local worktree base to the live origin base and restored preserved local changes. No PR branch was published. The implementation worker must review the restored changes, validate them, commit if appropriate, and submit a fresh completion report before review continues."
            : "Symphony rebased the worktree over the live origin base and published the rebased head to the PR branch. The implementation worker must revalidate the rebased changes and submit a fresh completion report before review continues.",
        ].join("\n"),
      },
    },
    {
      idempotencyKey: `transition:${context.issue.id}:${eventKey}:${config.writeback.dispatchState}`,
      kind: "transition",
      issueId: context.issue.id,
      payload: {
        fromStates: uniqueStates([context.fromState, config.writeback.dispatchState]),
        toState: config.writeback.dispatchState,
        reason: localOnly
          ? "Symphony refreshed stale local worktree base; worker reverification required"
          : "Symphony rebased stale worktree base; worker reverification required",
      },
    },
  ];
}

export function planRunFailedComment(context: RunWritebackContext, config: ServiceConfig, error: string | null): NewWritebackOperation | null {
  if (!config.writeback.enabled) return null;
  return {
    idempotencyKey: `comment:${context.issue.id}:${context.runId}:run-failed`,
    kind: "comment",
    issueId: context.issue.id,
    runId: context.runId,
    payload: {
      dedupeKey: `${context.runId}:run-failed`,
      body: [`Symphony worker run failed.`, "", `Run: ${context.runId}`, `Error: ${error ?? "unknown"}`].join("\n"),
    },
  };
}

export function planRunCancelledComment(context: RunWritebackContext, config: ServiceConfig, error: string | null): NewWritebackOperation | null {
  if (!config.writeback.enabled) return null;
  return {
    idempotencyKey: `comment:${context.issue.id}:${context.runId}:run-cancelled`,
    kind: "comment",
    issueId: context.issue.id,
    runId: context.runId,
    payload: {
      dedupeKey: `${context.runId}:run-cancelled`,
      body: [`Symphony worker run was cancelled.`, "", `Run: ${context.runId}`, `Reason: ${error ?? "operator request"}`].join("\n"),
    },
  };
}

function sameName(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function isStateIn(state: string, states: string[]): boolean {
  return states.some((candidate) => sameName(state, candidate));
}

function uniqueStates(states: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const state of states) {
    const key = state.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(state);
  }
  return result;
}

function completionReportAcceptedFromStates(config: ServiceConfig): string[] {
  return uniqueStates([config.writeback.dispatchState, ...config.reviewLoop.blockedStates]);
}

function pullRequestHandoffFromStates(config: ServiceConfig): string[] {
  return uniqueStates([config.writeback.dispatchState]);
}

function formatCompletionReportForComment(report: string | CompletionReportWritebackDetails | null): string[] {
  if (typeof report === "string") {
    return report.trim().length === 0 ? [] : ["", "Summary:", report.trim()];
  }
  if (report === null) return [];

  return [
    ...formatFinalDispositionForComment(report.finalDisposition),
    "",
    "Completion report:",
    `Report: ${report.reportId}`,
    `Idempotency key: ${report.idempotencyKey}`,
    "",
    "Summary:",
    report.summary.trim(),
    "",
    "Acceptance checklist:",
    ...report.acceptanceChecklist.map(
      (item) => `- ${item.satisfied ? "[x]" : "[ ]"} ${item.text}${item.evidence === null ? "" : ` (${item.evidence})`}`,
    ),
    "",
    "Validation evidence:",
    ...listOrFallback(report.validationEvidence, "No validation evidence supplied."),
    "",
    "Changed files:",
    ...listOrFallback(report.changedFiles, "No changed files supplied."),
    "",
    "Branch / PR:",
    `- Branch: ${report.branchName ?? "n/a"}`,
    `- PR: ${formatPullRequest(report.pullRequest)}`,
    ...(report.pullRequest?.headSha ? [`- PR head SHA: ${report.pullRequest.headSha}`] : []),
    "",
    "Risks / follow-ups:",
    ...listOrFallback(report.risks, "No known risks or follow-ups."),
  ];
}

function listOrFallback(values: string[], fallback: string): string[] {
  const items = values.map((value) => value.trim()).filter((value) => value.length > 0);
  return items.length === 0 ? [`- ${fallback}`] : items.map((value) => `- ${value}`);
}

function formatCount(count: number | undefined, max: number | undefined): string {
  if (count === undefined) return "n/a";
  return max === undefined ? `${count}` : `${count} / ${max}`;
}

function formatCompletionReportSummary(report: IssueCompletionReportRecord | null): string[] {
  if (report === null) return ["- n/a"];
  return [
    `- Report: ${report.id}`,
    `- Run: ${report.runId}`,
    `- Summary: ${oneLine(report.summary).slice(0, 240)}`,
    `- Changed files: ${report.changedFiles.length === 0 ? "n/a" : report.changedFiles.join(", ")}`,
  ];
}

function formatReviewVerdictSummary(verdict: IssueReviewVerdictRecord | null): string[] {
  if (verdict === null) return ["- n/a"];
  return [
    `- Verdict: ${verdict.verdict}`,
    `- Verdict record: ${verdict.id}`,
    `- Run: ${verdict.runId}`,
    ...listOrFallback(verdict.gateFindings.map((finding) => finding.summary), "No gate findings supplied.").map(
      (item) => `- Gate finding ${item.slice(2)}`,
    ),
    ...listOrFallback(verdict.discoveryFindings.map((finding) => finding.summary), "No discovery findings supplied.").map(
      (item) => `- Discovery finding ${item.slice(2)}`,
    ),
  ];
}

function reviewVerdictDetailsFromInput(input: string[] | ReviewVerdictWritebackDetails): ReviewVerdictWritebackDetails {
  if (Array.isArray(input)) {
    return {
      idempotencyKey: "n/a",
      acceptanceResults: [],
      findings: input,
      gateFindings: input.map((finding) => ({
        summary: finding,
        requirementIds: [],
        contractAnchor: "Legacy unstructured reviewer finding.",
        scenario: "Legacy unstructured reviewer finding.",
        scenarioEntitlement: "necessary_core_behavior",
        observedFailure: finding,
        currentIssueOwnership: "Legacy review verdict accepted before structured gate entitlement was recorded.",
        boundedRepair: finding,
        evidence: ["Legacy review verdict did not include per-finding evidence."],
      })),
      discoveryFindings: [],
      evidence: [],
    };
  }
  return input;
}

function reviewGateFindingsForDetails(details: ReviewVerdictWritebackDetails): ReviewGateFindingRecord[] {
  if (details.gateFindings !== undefined) return details.gateFindings;
  return details.findings.map((finding) => ({
    summary: finding,
    requirementIds: [],
    contractAnchor: "Legacy unstructured reviewer finding.",
    scenario: "Legacy unstructured reviewer finding.",
    scenarioEntitlement: "necessary_core_behavior",
    observedFailure: finding,
    currentIssueOwnership: "Legacy review verdict accepted before structured gate entitlement was recorded.",
    boundedRepair: finding,
    evidence: details.evidence.length === 0 ? ["Legacy review verdict did not include per-finding evidence."] : details.evidence,
  }));
}

function formatGateFindingsForComment(findings: ReviewGateFindingRecord[]): string[] {
  if (findings.length === 0) return ["- No gate findings supplied."];
  return findings.flatMap((finding, index) => [
    `- ${index + 1}. ${finding.summary}`,
    `  - Requirement IDs: ${finding.requirementIds.length === 0 ? "n/a" : finding.requirementIds.join(", ")}`,
    `  - Contract anchor: ${finding.contractAnchor}`,
    `  - Scenario: ${finding.scenario}`,
    `  - Entitlement: ${finding.scenarioEntitlement}`,
    `  - Observed failure: ${finding.observedFailure}`,
    `  - Current-issue ownership: ${finding.currentIssueOwnership}`,
    `  - Bounded repair: ${finding.boundedRepair}`,
    `  - Evidence: ${finding.evidence.join(" | ")}`,
  ]);
}

function formatDiscoveryFindingsForComment(findings: ReviewDiscoveryFindingRecord[]): string[] {
  if (findings.length === 0) return ["- None supplied."];
  return findings.flatMap((finding, index) => [
    `- ${index + 1}. ${finding.summary}`,
    `  - Importance: ${finding.importance}`,
    `  - Relationship: ${finding.relationship}`,
    `  - Suggested disposition: ${finding.suggestedDisposition}`,
    `  - Scenario axes: ${finding.scenarioAxes.length === 0 ? "n/a" : finding.scenarioAxes.join(", ")}`,
    `  - Discovery reason: ${finding.discoveryReason}`,
    `  - Owner issue: ${finding.ownerIssueIdentifier ?? "n/a"}`,
    `  - Evidence: ${finding.evidence.join(" | ")}`,
  ]);
}

function formatReviewVerdictDetails(details: ReviewVerdictWritebackDetails): string[] {
  return [
    ...formatFinalDispositionForComment(details.finalDisposition),
    "",
    "Gate findings:",
    ...formatGateFindingsForComment(reviewGateFindingsForDetails(details)),
    "",
    "Discovery findings (not worker-gating):",
    ...formatDiscoveryFindingsForComment(details.discoveryFindings ?? []),
    "",
    "Acceptance results:",
    ...(details.acceptanceResults.length === 0
      ? ["- No acceptance results supplied."]
      : details.acceptanceResults.map(
          (item) => `- ${item.satisfied ? "[x]" : "[ ]"} ${item.text}${item.evidence === null ? "" : ` (${item.evidence})`}`,
        )),
    "",
    "Review evidence:",
    ...listOrFallback(details.evidence, "No review evidence supplied."),
    ...(details.idempotencyKey === "n/a" ? [] : ["", `Idempotency key: ${details.idempotencyKey}`]),
  ];
}

function formatReviewBlockedDetails(details: ReviewVerdictWritebackDetails): string[] {
  return [
    ...formatFinalDispositionForComment(details.finalDisposition),
    "",
    "Discovery findings (not worker-gating):",
    ...formatDiscoveryFindingsForComment(details.discoveryFindings ?? []),
    "",
    "Acceptance results:",
    ...(details.acceptanceResults.length === 0
      ? ["- No acceptance results supplied."]
      : details.acceptanceResults.map(
          (item) => `- ${item.satisfied ? "[x]" : "[ ]"} ${item.text}${item.evidence === null ? "" : ` (${item.evidence})`}`,
        )),
    "",
    "Review evidence:",
    ...listOrFallback(details.evidence, "No review evidence supplied."),
    ...(details.idempotencyKey === "n/a" ? [] : ["", `Idempotency key: ${details.idempotencyKey}`]),
  ];
}

function formatFinalDispositionForComment(disposition: string | null | undefined): string[] {
  if (disposition === null || disposition === undefined || disposition.length === 0) return [];
  return ["", "Agent final disposition:", disposition];
}

function reviewVerdictTitle(verdict: "pass" | "fail" | "blocked"): string {
  return verdict === "pass" ? "Pass" : verdict === "fail" ? "Fail" : "Blocked";
}

function formatBlockerProvenanceForComment(
  provenance: IssueBlockerProvenanceRecord | null,
): string[] {
  if (provenance === null) return [];
  return [
    "",
    "Symphony blocker provenance:",
    `- Record: ${provenance.id}`,
    `- Code: ${provenance.code}`,
    `- Recovery: ${provenance.recoveryKind}`,
    `- Source: ${provenance.sourceKind}`,
    `- Initial classification: ${provenance.initialClassification}`,
    `- Initial observation fingerprint: ${provenance.initialObservationFingerprint}`,
    `- Current classification: ${provenance.classification}`,
    `- Current observation fingerprint: ${provenance.sourceObservationFingerprint}`,
    `- Operation: ${provenance.operation}`,
    `- Run: ${provenance.runId}`,
    `- Review verdict: ${provenance.reviewVerdictId ?? "pending"}`,
    `- Pull request: ${provenance.pullRequestNumber === null ? "n/a" : `#${provenance.pullRequestNumber}`}`,
    `- Pull request head SHA: ${provenance.pullRequestHeadSha ?? "n/a"}`,
    `- Base ref: ${provenance.baseRef ?? "n/a"}`,
    `- Live base head SHA: ${provenance.liveBaseHeadSha ?? "n/a"}`,
    `- Worktree head SHA: ${provenance.worktreeHeadSha ?? "n/a"}`,
    `- Initial live base head SHA: ${provenance.initialLiveBaseHeadSha ?? "n/a"}`,
    `- Initial worktree head SHA: ${provenance.initialWorktreeHeadSha ?? "n/a"}`,
    `- Observation attempt: ${provenance.observationAttempt ?? 1}`,
    `- First observed at: ${provenance.createdAt}`,
    `- Last observed at: ${provenance.lastObservedAt ?? provenance.createdAt}`,
  ];
}

function formatPullRequest(pullRequest: CompletionReportWritebackDetails["pullRequest"]): string {
  if (pullRequest === null) return "n/a";
  const parts = [
    pullRequest.number === null ? null : `#${pullRequest.number}`,
    pullRequest.url === null ? null : pullRequest.url,
  ].filter((value): value is string => value !== null);
  return parts.length === 0 ? "n/a" : parts.join(" ");
}

function formatPullRequestHandoffChecks(ci: NonNullable<PullRequestHandoffWritebackDetails["ci"]> | null): string[] {
  if (ci === null) return ["- Required checks: n/a"];
  if (ci.requiredChecks.length === 0) {
    return ci.noCiEvidence === null ? ["- Required checks: none configured"] : [`- No-CI evidence: ${ci.noCiEvidence}`];
  }
  return [
    `- Required checks: ${ci.requiredChecks.join(", ")}`,
    `- Passing checks: ${ci.passedChecks.length === 0 ? "none" : ci.passedChecks.join(", ")}`,
  ];
}

function mergeGateCommentOperation(
  context: MergeGateWritebackContext,
  eventKey: string,
  status: string,
  nextState: string,
  requiredAction: string,
): NewWritebackOperation {
  return {
    idempotencyKey: `comment:${context.issue.id}:${eventKey}`,
    kind: "comment",
    issueId: context.issue.id,
    payload: {
      dedupeKey: eventKey,
      body: [
        "## Symphony Merge Gate",
        "",
        `Status: ${status}`,
        nextState,
        "",
        `PR: ${formatPullRequest(context.pullRequest)}`,
        `PR head SHA: ${context.pullRequest.headSha ?? "n/a"}`,
        `Branch: ${context.pullRequest.branch ?? "n/a"}`,
        "",
        "Required checks:",
        ...listOrFallback(context.requiredChecks, "No required checks configured."),
        "",
        "Failing checks:",
        ...formatMergeGateChecks(context.failedChecks, "No failing checks recorded."),
        "",
        "Actionable missing checks:",
        ...formatMergeGateChecks(context.actionableMissingChecks ?? [], "No actionable missing checks recorded."),
        "",
        "Pending checks:",
        ...formatMergeGateChecks(context.pendingChecks, "No pending checks recorded."),
        "",
        "Missing checks:",
        ...formatMergeGateChecks(context.missingChecks, "No missing checks recorded."),
        "",
        "Unknown checks:",
        ...formatMergeGateChecks(context.unknownChecks ?? [], "No unknown checks recorded."),
        "",
        "Mergeability:",
        ...formatMergeGateMergeability(context.mergeability ?? null),
        "",
        "Counts:",
        `- Merge gate repair round: ${formatCount(context.reviewRound, context.maxReviewRounds)}`,
        "",
        "Required action:",
        requiredAction,
      ].join("\n"),
    },
  };
}

function hasActionableCheckBlockers(context: MergeGateWritebackContext): boolean {
  return context.failedChecks.length > 0 || (context.actionableMissingChecks ?? []).length > 0;
}

function formatMergeGateChecks(checks: MergeGateCheckEvidence[], fallback: string): string[] {
  if (checks.length === 0) return [`- ${fallback}`];
  return checks.map((check) => {
    const conclusion = check.conclusion === null ? "" : ` / ${check.conclusion}`;
    const url = check.url === null ? "" : ` (${check.url})`;
    return `- ${check.name}: ${check.status}${conclusion}${url}`;
  });
}

function formatMergeGateMergeability(mergeability: IssueMergeGateMergeabilityState | null): string[] {
  if (mergeability === null) return ["- No mergeability blocker recorded."];
  return [
    `- Status: ${mergeability.status}`,
    `- GitHub mergeable: ${mergeability.mergeable === null ? "unknown" : String(mergeability.mergeable)}`,
    `- GitHub mergeable_state: ${mergeability.mergeableState ?? "unknown"}`,
    `- Reason: ${mergeability.reason ?? "n/a"}`,
    `- Base branch: ${mergeability.baseBranch ?? "n/a"}`,
    `- Base head SHA: ${mergeability.baseHeadSha ?? "n/a"}`,
    ...(mergeability.observedBaseHeadSha !== null && mergeability.observedBaseHeadSha !== mergeability.baseHeadSha
      ? [`- Observed PR base head SHA: ${mergeability.observedBaseHeadSha}`]
      : []),
  ];
}

function formatReviewEvidenceForLinearComment(evidence: PullRequestReviewEvidenceItem[]): string[] {
  const active = evidence.filter((item) => item.isResolved !== true && item.isOutdated !== true);
  if (active.length === 0) return [];
  const pullRequestUrl = active.find((item) => item.pullRequestUrl !== null)?.pullRequestUrl ?? null;
  return [
    "",
    "PR review evidence:",
    ...(pullRequestUrl === null ? [] : [`Pull request: ${pullRequestUrl}`]),
    ...active.map((item) => `- ${formatReviewEvidenceSummary(item)}`),
    "",
    "GitHub PR reviews and comments are the primary detailed review surface.",
  ];
}

function formatReviewEvidenceSummary(item: PullRequestReviewEvidenceItem): string {
  const location = item.path === null ? "PR" : `${item.path}${item.line === null ? "" : `:${item.line}`}`;
  const link = item.url ?? item.pullRequestUrl ?? "n/a";
  const state = item.state === null ? "" : `${item.state} `;
  return `${state}${location}: ${oneLine(item.body).slice(0, 180)} (${link})`;
}

function safeKeySegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_") || "report";
}

function isIssueTriageEligibleBlockedReason(reason: string | null | undefined): boolean {
  const normalized = (reason ?? "").toLowerCase();
  return (
    normalized.startsWith("review blocked:") ||
    normalized.includes("max reviewer failures") ||
    normalized.includes("max review rounds") ||
    normalized.includes("max merge gate failures") ||
    normalized.includes("max accepted-artifact validation failures") ||
    normalized.includes("merge gate required checks failed")
  );
}

function pullRequestIdempotencySegment(pullRequest: PullRequestHandoffWritebackDetails["pullRequest"]): string {
  if (pullRequest.number !== null) return `pr-${pullRequest.number}`;
  return safeKeySegment(pullRequest.url ?? pullRequest.branch ?? "pull-request");
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

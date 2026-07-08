import type { ServiceConfig } from "../config/Config.js";
import { resolveServiceConfigForProjectContext } from "../config/ProjectContextServiceConfig.js";
import type { ProjectContextResolution } from "../config/ProjectContexts.js";
import type {
  IssueCompletionReportRecord,
  IssueMergeGateMergeabilityState,
  IssuePostMortemReportRecord,
  IssueReviewVerdictRecord,
  IssueTriageReportRecord,
  PullRequestReviewEvidenceItem,
  ReviewDiscoveryFindingRecord,
  ReviewGateFindingRecord,
} from "../persistence/IssueLifecycleStore.js";
import type { Issue, Workspace } from "../types.js";
import type { NewWritebackOperation } from "./WritebackOutbox.js";

export interface RunWritebackContext {
  issue: Issue;
  projectContext?: ProjectContextResolution | undefined;
  runId: string;
  sessionId: string | null;
  workspacePath: string | null;
  workspace?: Workspace | null;
}

export interface ReviewVerdictWritebackContext {
  issue: Issue;
  projectContext?: ProjectContextResolution | undefined;
  runId: string;
  reviewer: string | null;
}

export interface ReviewVerdictWritebackDetails {
  idempotencyKey: string;
  acceptanceResults: Array<{ text: string; satisfied: boolean; evidence: string | null }>;
  findings: string[];
  gateFindings?: ReviewGateFindingRecord[];
  discoveryFindings?: ReviewDiscoveryFindingRecord[];
  evidence: string[];
}

export interface BlockedEscalationWritebackContext {
  issue: Issue;
  projectContext?: ProjectContextResolution | undefined;
  runId: string;
  reason: string;
  incompleteTurnCount?: number;
  maxIncompleteTurns?: number;
  reviewRound?: number;
  maxReviewRounds?: number;
  lastCompletionReport?: IssueCompletionReportRecord | null;
  lastReviewVerdict?: IssueReviewVerdictRecord | null;
  requiredAction?: string;
}

export interface IssueTriageReportWritebackContext {
  issue: Issue;
  report: IssueTriageReportRecord;
  blockedReason?: string | null;
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
  projectContext?: ProjectContextResolution | undefined;
  mergeId: string;
  fromState: string;
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
  projectContext?: ProjectContextResolution | undefined;
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
  projectContext?: ProjectContextResolution | undefined;
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

export interface BaseRefRepairWritebackContext {
  issue: Issue;
  projectContext?: ProjectContextResolution | undefined;
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
  projectContext?: ProjectContextResolution | undefined;
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
  projectContext?: ProjectContextResolution | undefined;
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

export interface PublicationApprovalActionDetails {
  branchName: string;
  baseBranch: string;
  workspacePath: string;
  title: string;
}

function resolveTransitionPolicyConfig(
  config: ServiceConfig,
  projectContext?: ProjectContextResolution,
): ServiceConfig {
  return resolveServiceConfigForProjectContext(config, projectContext);
}

export function planDispatchWriteback(
  issue: Issue,
  config: ServiceConfig,
  projectContext?: ProjectContextResolution,
): NewWritebackOperation | null {
  const resolvedConfig = resolveTransitionPolicyConfig(config, projectContext);
  if (!resolvedConfig.writeback.enabled) return null;
  const fromStates = sameName(resolvedConfig.writeback.dispatchState, "Todo")
    ? [resolvedConfig.writeback.dispatchState]
    : uniqueStates(resolvedConfig.tracker.activeStates.filter((state) => !sameName(state, resolvedConfig.writeback.dispatchState)));
  if (!isStateIn(issue.state, fromStates)) return null;
  const dispatchStateVersion = safeKeySegment(issue.updatedAt ?? issue.createdAt ?? issue.state);
  return {
    idempotencyKey: `transition:${issue.id}:dispatch:${dispatchStateVersion}:${resolvedConfig.writeback.dispatchState}`,
    kind: "transition",
    issueId: issue.id,
    projectContext,
    payload: {
      fromStates,
      toState: resolvedConfig.writeback.dispatchState,
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
    projectContext: context.projectContext,
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
      projectContext: context.projectContext,
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
  const resolvedConfig = resolveTransitionPolicyConfig(config, context.projectContext);
  const completionReportFromStates = completionReportAcceptedFromStates(resolvedConfig);
  if (
    !resolvedConfig.writeback.enabled ||
    !isStateIn(context.issue.state, completionReportFromStates)
  ) {
    return [];
  }

  const reviewState = resolvedConfig.reviewLoop.reviewStates[0];
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
      projectContext: context.projectContext,
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
      projectContext: context.projectContext,
      runId: context.runId,
      payload: {
        fromStates: completionReportFromStates,
        toState: reviewState,
        reason: "Symphony completion report accepted",
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
  const resolvedConfig = resolveTransitionPolicyConfig(config, context.projectContext);
  if (!resolvedConfig.writeback.enabled || !resolvedConfig.github.prHandoff.enabled) return [];
  const handoffFromStates = pullRequestHandoffFromStates(resolvedConfig);
  if (!isStateIn(context.issue.state, handoffFromStates)) return [];

  const targetState = resolvedConfig.github.prHandoff.targetState;
  if (targetState === null) return [];

  const pullRequestKey = pullRequestIdempotencySegment(details.pullRequest);
  const headKey = safeKeySegment(details.pullRequest.headSha ?? "no-head-sha");
  const eventKey = `pull-request-handoff:${pullRequestKey}:${headKey}`;
  return [
    {
      idempotencyKey: `comment:${context.issue.id}:${eventKey}`,
      kind: "comment",
      issueId: context.issue.id,
      projectContext: context.projectContext,
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
      projectContext: context.projectContext,
      runId: context.runId,
      payload: {
        fromStates: handoffFromStates,
        toState: targetState,
        reason: "Symphony verified pull request handoff",
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
  const resolvedConfig = resolveTransitionPolicyConfig(config, context.projectContext);
  if (!resolvedConfig.writeback.enabled || !isStateIn(context.issue.state, [resolvedConfig.writeback.dispatchState])) return [];

  const blockedState = resolvedConfig.reviewLoop.blockedStates[0] ?? null;
  const eventKey = `${context.runId}:completion-report:${safeKeySegment(report.idempotencyKey)}:publication-approval-pending`;
  const operations: NewWritebackOperation[] = [
    {
      idempotencyKey: `comment:${context.issue.id}:${eventKey}`,
      kind: "comment",
      issueId: context.issue.id,
      projectContext: context.projectContext,
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
      projectContext: context.projectContext,
      runId: context.runId,
      payload: {
        fromStates: [resolvedConfig.writeback.dispatchState],
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
  const resolvedConfig = resolveTransitionPolicyConfig(config, context.projectContext);
  if (!resolvedConfig.writeback.enabled) return [];

  const fromStates = uniqueStates([resolvedConfig.writeback.dispatchState, ...resolvedConfig.reviewLoop.blockedStates]);
  if (!isStateIn(context.issue.state, fromStates)) return [];

  const eventKey = `${context.runId}:completion-report:${safeKeySegment(report.idempotencyKey)}:publication-approval-${status}`;
  return [
    {
      idempotencyKey: `comment:${context.issue.id}:${eventKey}`,
      kind: "comment",
      issueId: context.issue.id,
      projectContext: context.projectContext,
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
  const resolvedConfig = resolveTransitionPolicyConfig(config, context.projectContext);
  if (!resolvedConfig.writeback.enabled || !isStateIn(context.issue.state, resolvedConfig.reviewLoop.reviewStates)) return [];

  const details = reviewVerdictDetailsFromInput(requestedRevisions);
  const gateFindings = reviewGateFindingsForDetails(details);
  const revisions = gateFindings.map((finding) => finding.summary.trim()).filter((revision) => revision.length > 0);
  const eventKey = `${context.runId}:review-verdict-fail`;
  return [
    {
      idempotencyKey: `comment:${context.issue.id}:${eventKey}`,
      kind: "comment",
      issueId: context.issue.id,
      projectContext: context.projectContext,
      runId: context.runId,
      payload: {
        dedupeKey: eventKey,
        body: [
          "## Symphony Review Verdict: Fail",
          "",
          "Status: requested revisions",
          "Symphony review failed.",
          `Next state: ${resolvedConfig.writeback.dispatchState}`,
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
      idempotencyKey: `transition:${context.issue.id}:${eventKey}:${resolvedConfig.writeback.dispatchState}`,
      kind: "transition",
      issueId: context.issue.id,
      projectContext: context.projectContext,
      runId: context.runId,
      payload: {
        fromStates: resolvedConfig.reviewLoop.reviewStates,
        toState: resolvedConfig.writeback.dispatchState,
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
          "Status: review blocked, triage required",
          "Symphony review could not complete because the reviewer identified a non-worker-owned blocker.",
          "Next state: unchanged; Symphony will decide the next action from lifecycle evidence.",
          "",
          `Run: ${context.runId}`,
          `Reviewer: ${context.reviewer ?? "n/a"}`,
          "",
          "Blocked findings:",
          ...listOrFallback(details.findings, "No blocker summary supplied."),
          ...formatReviewBlockedDetails(details),
          "",
          "Next action:",
          "Symphony will run issue triage when enabled; otherwise inspect the reviewer blocker and choose the appropriate recovery path.",
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
  const resolvedConfig = resolveTransitionPolicyConfig(config, context.projectContext);
  if (!resolvedConfig.writeback.enabled || !isStateIn(context.issue.state, resolvedConfig.reviewLoop.reviewStates)) return [];

  const eventKey = `${context.runId}:review-verdict-pass`;
  const details = typeof summary === "object" && summary !== null ? summary : null;
  const summaryText = typeof summary === "string" ? summary : null;
  const operations: NewWritebackOperation[] = [
    {
      idempotencyKey: `comment:${context.issue.id}:${eventKey}`,
      kind: "comment",
      issueId: context.issue.id,
      projectContext: context.projectContext,
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
          resolvedConfig.reviewLoop.reviewPassState === null
            ? "Review passed marker: review-passed"
            : `Review pass state: ${resolvedConfig.reviewLoop.reviewPassState}`,
          ...(summaryText === null || summaryText.trim().length === 0 ? [] : ["", "Summary:", summaryText.trim()]),
          ...(details === null ? [] : formatReviewVerdictDetails(details)),
        ].join("\n"),
      },
    },
  ];

  if (resolvedConfig.reviewLoop.reviewPassState !== null) {
    operations.push({
      idempotencyKey: `transition:${context.issue.id}:${eventKey}:${resolvedConfig.reviewLoop.reviewPassState}`,
      kind: "transition",
      issueId: context.issue.id,
      projectContext: context.projectContext,
      runId: context.runId,
      payload: {
        fromStates: resolvedConfig.reviewLoop.reviewStates,
        toState: resolvedConfig.reviewLoop.reviewPassState,
        reason: "Symphony review passed",
      },
    });
  }

  return operations;
}

export function planBlockedEscalationWritebacks(
  context: BlockedEscalationWritebackContext,
  config: ServiceConfig,
): NewWritebackOperation[] {
  const resolvedConfig = resolveTransitionPolicyConfig(config, context.projectContext);
  if (!resolvedConfig.writeback.enabled) return [];

  const fromStates = uniqueStates([
    ...resolvedConfig.tracker.activeStates,
    ...resolvedConfig.tracker.handoffStates,
    ...resolvedConfig.reviewLoop.reviewStates,
    ...(resolvedConfig.mergePolicy.mode === "gated" && resolvedConfig.mergePolicy.conflictsState !== null
      ? [resolvedConfig.mergePolicy.conflictsState]
      : []),
  ]);
  if (!isStateIn(context.issue.state, fromStates)) return [];

  const blockedState = resolvedConfig.reviewLoop.blockedStates[0] ?? null;
  const eventKey = `${context.runId}:blocked-escalation`;
  const requiredAction =
    config.issueTriage.enabled && isIssueTriageEligibleBlockedReason(context.reason)
      ? "Symphony will run issue triage for this max-failure block and publish a follow-up recommendation on the issue. Inspect the latest output only if the triage run does not complete or calls for immediate manual intervention."
      : context.requiredAction ??
        "Inspect the latest worker output and reviewer feedback, then move the issue out of the blocked state when it is safe for Symphony to continue.";
  const operations: NewWritebackOperation[] = [
    {
      idempotencyKey: `comment:${context.issue.id}:${eventKey}`,
      kind: "comment",
      issueId: context.issue.id,
      projectContext: context.projectContext,
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
          "",
          "Last completion report:",
          ...formatCompletionReportSummary(context.lastCompletionReport ?? null),
          "",
          "Last review verdict:",
          ...formatReviewVerdictSummary(context.lastReviewVerdict ?? null),
          "",
          "Required human action:",
          requiredAction,
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
      projectContext: context.projectContext,
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

export function planIssueTriageReportWritebacks(
  context: IssueTriageReportWritebackContext,
  config: ServiceConfig,
): NewWritebackOperation[] {
  if (!config.writeback.enabled) return [];
  const eventKey = `issue-triage:${safeKeySegment(context.report.idempotencyKey)}`;
  return [
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
          "Status: triage complete, human action required",
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
          "Recommended human action:",
          context.report.recommendedAction,
          "",
          "Operator next-action matrix:",
          ...formatIssueTriageNextActionMatrix(context, config),
        ].join("\n"),
      },
    },
  ];
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
      "Success lets Symphony finish the service-owned git flow and continue the merge gate; unresolved conflicts can block again after the fresh conflict-fix budget.",
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
      projectContext: context.projectContext,
      payload: {
        fromStates: [context.fromState],
        toState: context.doneState,
        reason: "Symphony reviewer-approved merge completed",
      },
    },
  ];
}

export function planMergeGateRepairWritebacks(
  context: MergeGateWritebackContext,
  config: ServiceConfig,
): NewWritebackOperation[] {
  const resolvedConfig = resolveTransitionPolicyConfig(config, context.projectContext);
  if (!resolvedConfig.writeback.enabled) return [];
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
      `Next state: ${resolvedConfig.writeback.dispatchState} (worker repair queue)`,
      requiredAction,
    ),
    {
      idempotencyKey: `transition:${context.issue.id}:${eventKey}:${resolvedConfig.writeback.dispatchState}`,
      kind: "transition",
      issueId: context.issue.id,
      projectContext: context.projectContext,
      payload: {
        fromStates: [context.fromState],
        toState: resolvedConfig.writeback.dispatchState,
        reason: conflict ? "Symphony merge gate required PR repair" : "Symphony merge gate required CI repair",
      },
    },
  ];
}

export function planMergeGateBlockedWritebacks(
  context: MergeGateWritebackContext,
  config: ServiceConfig,
): NewWritebackOperation[] {
  const resolvedConfig = resolveTransitionPolicyConfig(config, context.projectContext);
  if (!resolvedConfig.writeback.enabled) return [];
  const blockedState = resolvedConfig.reviewLoop.blockedStates[0] ?? null;
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
      projectContext: context.projectContext,
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
  const resolvedConfig = resolveTransitionPolicyConfig(config, context.projectContext);
  if (!resolvedConfig.writeback.enabled) return [];
  const eventKey = `merge-gate:${safeKeySegment(context.gateId)}:head-superseded:${safeKeySegment(context.liveHeadSha)}`;
  return [
    {
      idempotencyKey: `comment:${context.issue.id}:${eventKey}`,
      kind: "comment",
      issueId: context.issue.id,
      projectContext: context.projectContext,
      payload: {
        dedupeKey: eventKey,
        body: [
          "## Symphony Merge Gate",
          "",
          "Status: head superseded, implementation rebind required",
          `Next state: ${resolvedConfig.writeback.dispatchState} (worker queue)`,
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
      idempotencyKey: `transition:${context.issue.id}:${eventKey}:${resolvedConfig.writeback.dispatchState}`,
      kind: "transition",
      issueId: context.issue.id,
      projectContext: context.projectContext,
      payload: {
        fromStates: uniqueStates([context.fromState, resolvedConfig.writeback.dispatchState]),
        toState: resolvedConfig.writeback.dispatchState,
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
      projectContext: context.projectContext,
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
      projectContext: context.projectContext,
      payload: {
        dedupeKey: eventKey,
        body: [
          "## Symphony Gated Merge Blocked",
          "",
          "Status: approved pull request has merge conflicts",
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
      projectContext: context.projectContext,
      payload: {
        fromStates: [context.fromState],
        toState: context.conflictsState,
        reason: `Symphony gated merge blocked: ${context.reason}`,
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
      projectContext: context.projectContext,
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
      projectContext: context.projectContext,
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
    projectContext: context.projectContext,
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
    projectContext: context.projectContext,
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
    projectContext: context.projectContext,
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
    `- Checked at: ${mergeability.checkedAt}`,
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
    normalized.includes("max reviewer failures") ||
    normalized.includes("max review rounds") ||
    normalized.includes("max merge gate failures") ||
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

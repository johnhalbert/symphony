import type { ServiceConfig } from "../config/Config.js";
import type {
  IssueCompletionReportRecord,
  IssueReviewVerdictRecord,
  PullRequestReviewEvidenceItem,
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
  acceptanceResults: Array<{ text: string; satisfied: boolean; evidence: string | null }>;
  findings: string[];
  evidence: string[];
}

export interface BlockedEscalationWritebackContext {
  issue: Issue;
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

export interface MergeCompletedWritebackContext {
  issue: Issue;
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
  gateId: string;
  fromState: string;
  pullRequest: {
    url: string | null;
    number: number | null;
    headSha?: string | null;
    branch?: string | null;
  };
  requiredChecks: string[];
  failedChecks: MergeGateCheckEvidence[];
  pendingChecks: MergeGateCheckEvidence[];
  missingChecks: MergeGateCheckEvidence[];
  reviewRound: number;
  maxReviewRounds: number;
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
  if (
    !config.writeback.enabled ||
    !isStateIn(context.issue.state, [config.writeback.dispatchState, ...config.reviewLoop.blockedStates])
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
        fromStates: uniqueStates([config.writeback.dispatchState, ...config.reviewLoop.blockedStates]),
        toState: reviewState,
        reason: "Symphony completion report accepted",
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
  if (!isStateIn(context.issue.state, [config.writeback.dispatchState])) return [];

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
        fromStates: [config.writeback.dispatchState],
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
  const revisions = details.findings.map((revision) => revision.trim()).filter((revision) => revision.length > 0);
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
          "Revision request:",
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

export function planBlockedEscalationWritebacks(
  context: BlockedEscalationWritebackContext,
  config: ServiceConfig,
): NewWritebackOperation[] {
  if (!config.writeback.enabled) return [];

  const fromStates = uniqueStates([
    ...config.tracker.activeStates,
    ...config.tracker.handoffStates,
    ...config.reviewLoop.reviewStates,
  ]);
  if (!isStateIn(context.issue.state, fromStates)) return [];

  const blockedState = config.reviewLoop.blockedStates[0] ?? null;
  const eventKey = `${context.runId}:blocked-escalation`;
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
          "",
          "Last completion report:",
          ...formatCompletionReportSummary(context.lastCompletionReport ?? null),
          "",
          "Last review verdict:",
          ...formatReviewVerdictSummary(context.lastReviewVerdict ?? null),
          "",
          "Required human action:",
          context.requiredAction ??
            "Inspect the latest worker output and reviewer feedback, then move the issue out of the blocked state when it is safe for Symphony to continue.",
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

export function planMergeGateRepairWritebacks(
  context: MergeGateWritebackContext,
  config: ServiceConfig,
): NewWritebackOperation[] {
  if (!config.writeback.enabled) return [];
  const eventKey = `merge-gate:${safeKeySegment(context.gateId)}:repair:r${context.reviewRound}`;
  return [
    mergeGateCommentOperation(
      context,
      eventKey,
      "repair required",
      `Next state: ${config.writeback.dispatchState} (worker repair queue)`,
      "Fix the failing required checks, push the repair to the lifecycle-bound PR branch, validate it, and submit a new completion report.",
    ),
    {
      idempotencyKey: `transition:${context.issue.id}:${eventKey}:${config.writeback.dispatchState}`,
      kind: "transition",
      issueId: context.issue.id,
      payload: {
        fromStates: [context.fromState],
        toState: config.writeback.dispatchState,
        reason: "Symphony merge gate required CI repair",
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
  const eventKey = `merge-gate:${safeKeySegment(context.gateId)}:blocked:r${context.reviewRound}`;
  const operations: NewWritebackOperation[] = [
    mergeGateCommentOperation(
      context,
      eventKey,
      "blocked, human action required",
      blockedState === null
        ? "No blocked state is configured, so Symphony recorded a lifecycle-level block without changing the tracker state."
        : `Transitioning to blocked state: ${blockedState}`,
      "Inspect the failing required checks and decide whether to repair, adjust CI configuration, or manually override the merge gate.",
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
    ...listOrFallback(verdict.findings, "No findings supplied.").map((item) => `- Finding ${item.slice(2)}`),
  ];
}

function reviewVerdictDetailsFromInput(input: string[] | ReviewVerdictWritebackDetails): ReviewVerdictWritebackDetails {
  if (Array.isArray(input)) {
    return {
      idempotencyKey: "n/a",
      acceptanceResults: [],
      findings: input,
      evidence: [],
    };
  }
  return input;
}

function formatReviewVerdictDetails(details: ReviewVerdictWritebackDetails): string[] {
  return [
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
        "Pending checks:",
        ...formatMergeGateChecks(context.pendingChecks, "No pending checks recorded."),
        "",
        "Missing checks:",
        ...formatMergeGateChecks(context.missingChecks, "No missing checks recorded."),
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

function formatMergeGateChecks(checks: MergeGateCheckEvidence[], fallback: string): string[] {
  if (checks.length === 0) return [`- ${fallback}`];
  return checks.map((check) => {
    const conclusion = check.conclusion === null ? "" : ` / ${check.conclusion}`;
    const url = check.url === null ? "" : ` (${check.url})`;
    return `- ${check.name}: ${check.status}${conclusion}${url}`;
  });
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

function pullRequestIdempotencySegment(pullRequest: PullRequestHandoffWritebackDetails["pullRequest"]): string {
  if (pullRequest.number !== null) return `pr-${pullRequest.number}`;
  return safeKeySegment(pullRequest.url ?? pullRequest.branch ?? "pull-request");
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

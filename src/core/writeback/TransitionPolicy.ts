import type { ServiceConfig } from "../config/Config.js";
import type { PullRequestReviewEvidenceItem } from "../persistence/IssueLifecycleStore.js";
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

export function planDispatchWriteback(issue: Issue, config: ServiceConfig): NewWritebackOperation | null {
  if (!config.writeback.enabled || !sameName(issue.state, "Todo")) return null;
  return {
    idempotencyKey: `transition:${issue.id}:dispatch:${config.writeback.dispatchState}`,
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
  if (!config.writeback.enabled || !isStateIn(context.issue.state, [config.writeback.dispatchState])) return [];

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
          "Symphony accepted the worker completion report.",
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
        fromStates: [config.writeback.dispatchState],
        toState: reviewState,
        reason: "Symphony completion report accepted",
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
          "Symphony review failed. Requested revisions:",
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

  const fromStates = uniqueStates([...config.tracker.activeStates, ...config.reviewLoop.reviewStates]);
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
          "Symphony requires human help before continuing.",
          "",
          `Run: ${context.runId}`,
          `Ceiling reason: ${context.reason}`,
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

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

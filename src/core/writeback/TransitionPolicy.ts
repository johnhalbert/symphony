import type { ServiceConfig } from "../config/Config.js";
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

export interface BlockedEscalationWritebackContext {
  issue: Issue;
  runId: string;
  reason: string;
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
  summary: string | null = null,
): NewWritebackOperation[] {
  if (!config.writeback.enabled || !isStateIn(context.issue.state, [config.writeback.dispatchState])) return [];

  const reviewState = config.reviewLoop.reviewStates[0];
  if (!reviewState) return [];

  const eventKey = `${context.runId}:completion-report-accepted`;
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
          ...(summary === null || summary.trim().length === 0 ? [] : ["", "Summary:", summary.trim()]),
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
  requestedRevisions: string[],
): NewWritebackOperation[] {
  if (!config.writeback.enabled || !isStateIn(context.issue.state, config.reviewLoop.reviewStates)) return [];

  const revisions = requestedRevisions.map((revision) => revision.trim()).filter((revision) => revision.length > 0);
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
  summary: string | null = null,
): NewWritebackOperation[] {
  if (!config.writeback.enabled || !isStateIn(context.issue.state, config.reviewLoop.reviewStates)) return [];

  const eventKey = `${context.runId}:review-verdict-pass`;
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
          ...(summary === null || summary.trim().length === 0 ? [] : ["", "Summary:", summary.trim()]),
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

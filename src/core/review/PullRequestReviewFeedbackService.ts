import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  PullRequestIssueCommentFeedbackInput,
  PullRequestReviewCommentFeedbackInput,
  PullRequestReviewFeedbackInput,
  PullRequestReviewFeedbackResult,
} from "../../integrations/github/GitHubPullRequestClient.js";
import type { ServiceConfig } from "../config/Config.js";
import { SymphonyError } from "../errors.js";
import type {
  CompletionReportPullRequestRef,
  IssueCompletionReportRecord,
  IssueLifecyclePhase,
  IssueLifecycleRecord,
  IssueLifecycleStore,
  IssueReviewFeedbackRecord,
  PullRequestReviewFeedbackEvent,
} from "../persistence/IssueLifecycleStore.js";
import { phaseForIssueState } from "../persistence/IssueLifecycleStore.js";
import type { Issue } from "../types.js";

const reviewEventSchema = z.enum(["APPROVE", "REQUEST_CHANGES"]);
const reviewSideSchema = z.enum(["LEFT", "RIGHT"]);
const inlineReviewCommentSchema = z
  .object({
    path: z.string().trim().min(1),
    body: z.string().trim().min(1),
    line: z.number().int().positive(),
    side: reviewSideSchema,
    startLine: z.number().int().positive().nullable().optional(),
    startSide: reviewSideSchema.nullable().optional(),
  })
  .strict();

const reviewFeedbackSchema = z
  .object({
    kind: z.literal("review"),
    event: reviewEventSchema,
    body: z.string().trim().min(1),
    comments: z.array(inlineReviewCommentSchema).optional(),
    idempotencyKey: z.string().trim().min(1),
  })
  .strict();

const reviewCommentFeedbackSchema = z
  .object({
    kind: z.literal("review_comment"),
    body: z.string().trim().min(1),
    path: z.string().trim().min(1).nullable().optional(),
    line: z.number().int().positive().nullable().optional(),
    side: reviewSideSchema.nullable().optional(),
    inReplyToId: z.number().int().positive().nullable().optional(),
    idempotencyKey: z.string().trim().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.inReplyToId !== undefined && value.inReplyToId !== null) return;
    if (!value.path) ctx.addIssue({ code: "custom", path: ["path"], message: "Inline review comments require path" });
    if (value.line === undefined || value.line === null) {
      ctx.addIssue({ code: "custom", path: ["line"], message: "Inline review comments require line" });
    }
    if (!value.side) ctx.addIssue({ code: "custom", path: ["side"], message: "Inline review comments require side" });
  });

const issueCommentFeedbackSchema = z
  .object({
    kind: z.literal("issue_comment"),
    body: z.string().trim().min(1),
    idempotencyKey: z.string().trim().min(1),
  })
  .strict();

const reviewFeedbackInputParser = z.union([
  reviewFeedbackSchema,
  reviewCommentFeedbackSchema,
  issueCommentFeedbackSchema,
]);

export type PullRequestReviewFeedbackInputValue = z.infer<typeof reviewFeedbackInputParser>;

export interface PullRequestReviewFeedbackClient {
  submitPullRequestReviewFeedback(input: PullRequestReviewFeedbackInput): Promise<PullRequestReviewFeedbackResult>;
  submitPullRequestReviewCommentFeedback(input: PullRequestReviewCommentFeedbackInput): Promise<PullRequestReviewFeedbackResult>;
  submitPullRequestIssueCommentFeedback(input: PullRequestIssueCommentFeedbackInput): Promise<PullRequestReviewFeedbackResult>;
}

export interface ReviewFeedbackActiveContext {
  issue: Issue;
  activeRunId: string;
  role: "reviewer" | string;
  token?: string | null;
  expectedToken?: string | null;
  reviewer?: string | null;
  phase?: IssueLifecyclePhase | null;
}

export interface PullRequestReviewFeedbackServiceOptions {
  config: ServiceConfig;
  lifecycleStore: IssueLifecycleStore;
  client: PullRequestReviewFeedbackClient;
}

export interface PullRequestReviewFeedbackSubmitResult {
  accepted: true;
  replayed: boolean;
  feedback: IssueReviewFeedbackRecord;
  pullRequest: {
    number: number;
    url: string | null;
    headSha: string | null;
  };
  reviewUrl: string | null;
  commentUrls: string[];
  urls: string[];
}

export class PullRequestReviewFeedbackService {
  constructor(private readonly options: PullRequestReviewFeedbackServiceOptions) {}

  async submit_pull_request_review_feedback(
    input: unknown,
    context: ReviewFeedbackActiveContext,
  ): Promise<PullRequestReviewFeedbackSubmitResult> {
    return this.submitPullRequestReviewFeedback(input, context);
  }

  async submitPullRequestReviewFeedback(
    input: unknown,
    context: ReviewFeedbackActiveContext,
  ): Promise<PullRequestReviewFeedbackSubmitResult> {
    const feedback = parseReviewFeedback(input);
    const lifecycle = await this.requireLifecycle(context);
    this.validateCaller(context, lifecycle);
    const pullRequest = requireBoundPullRequest(lifecycle);
    const requestHash = requestHashFor(feedback, pullRequest);
    const existing = lifecycle.reviewFeedback.find(
      (item) => item.runId === context.activeRunId && item.idempotencyKey === feedback.idempotencyKey,
    );
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new SymphonyError("invalid_request", "Review feedback idempotency key was reused with a different payload");
      }
      return resultFromRecord(existing, true);
    }

    const result = await this.writeFeedback(feedback, pullRequest);
    const urls = urlsFromFeedbackResult(result);
    if (urls.length === 0) {
      throw new SymphonyError("tracker_error", "GitHub PR feedback did not return a durable URL");
    }

    const stored: IssueReviewFeedbackRecord = {
      id: feedbackIdFor(context.issue.id, context.activeRunId, feedback.idempotencyKey),
      idempotencyKey: feedback.idempotencyKey,
      requestHash,
      runId: context.activeRunId,
      issueId: context.issue.id,
      issueIdentifier: context.issue.identifier,
      kind: feedback.kind,
      event: feedback.kind === "review" ? feedback.event : null,
      body: feedback.body,
      pullRequest,
      reviewer: context.reviewer ?? null,
      reviewUrl: result.reviewUrl,
      commentUrls: result.commentUrls,
      submittedAt: new Date().toISOString(),
    };
    await this.options.lifecycleStore.updateIssue(context.issue, {
      reviewFeedback: [...lifecycle.reviewFeedback, stored],
    });
    return resultFromRecord(stored, false);
  }

  private async requireLifecycle(context: ReviewFeedbackActiveContext): Promise<IssueLifecycleRecord> {
    const lifecycle = await this.options.lifecycleStore.get(context.issue.id);
    if (!lifecycle) throw new SymphonyError("invalid_request", "Review feedback requires an existing issue lifecycle");
    if (lifecycle.issueId !== context.issue.id || lifecycle.issueIdentifier !== context.issue.identifier) {
      throw new SymphonyError("invalid_request", "Review feedback issue does not match the lifecycle record");
    }
    return lifecycle;
  }

  private validateCaller(context: ReviewFeedbackActiveContext, lifecycle: IssueLifecycleRecord): void {
    if (context.role !== "reviewer") {
      throw new SymphonyError("invalid_request", "Only active reviewers may submit PR review feedback");
    }
    if (!context.activeRunId) {
      throw new SymphonyError("invalid_request", "Review feedback context is not ready for the active run");
    }
    if (context.expectedToken !== undefined && context.expectedToken !== null && context.token !== context.expectedToken) {
      throw new SymphonyError("invalid_request", "Missing or invalid review feedback token");
    }
    if (lifecycle.summaryPointers.lastRunId !== context.activeRunId) {
      throw new SymphonyError("invalid_request", "Review feedback run does not match the active reviewer run");
    }
    const lifecyclePhase = context.phase ?? lifecycle.phase ?? phaseForIssueState(context.issue.state, this.options.config);
    if (lifecyclePhase !== "review") {
      throw new SymphonyError("invalid_request", `Review feedback cannot be accepted while lifecycle phase is ${lifecyclePhase}`);
    }
    if (!sameStateIn(context.issue.state, this.options.config.reviewLoop.reviewStates)) {
      throw new SymphonyError("invalid_request", "Review feedback requires the issue to be in a review state");
    }
  }

  private async writeFeedback(
    feedback: PullRequestReviewFeedbackInputValue,
    pullRequest: CompletionReportPullRequestRef,
  ): Promise<PullRequestReviewFeedbackResult> {
    if (feedback.kind === "issue_comment") {
      return this.options.client.submitPullRequestIssueCommentFeedback({
        pullRequestNumber: requiredPullRequestNumber(pullRequest),
        body: feedback.body,
      });
    }
    if (feedback.kind === "review_comment") {
      return this.options.client.submitPullRequestReviewCommentFeedback({
        pullRequestNumber: requiredPullRequestNumber(pullRequest),
        headSha: feedback.inReplyToId === undefined || feedback.inReplyToId === null ? requiredHeadSha(pullRequest) : pullRequest.headSha,
        body: feedback.body,
        path: feedback.path ?? null,
        line: feedback.line ?? null,
        side: feedback.side ?? null,
        inReplyToId: feedback.inReplyToId ?? null,
      });
    }
    return this.options.client.submitPullRequestReviewFeedback({
      pullRequestNumber: requiredPullRequestNumber(pullRequest),
      headSha: requiredHeadSha(pullRequest),
      event: feedback.event,
      body: feedback.body,
      comments: (feedback.comments ?? []).map((comment) => ({
        path: comment.path,
        body: comment.body,
        line: comment.line,
        side: comment.side,
        ...(comment.startLine === undefined ? {} : { startLine: comment.startLine }),
        ...(comment.startSide === undefined ? {} : { startSide: comment.startSide }),
      })),
    });
  }
}

export function reviewFeedbackInputSchema(): Record<string, unknown> {
  return {
    type: "object",
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "event", "body", "idempotencyKey"],
        properties: {
          kind: { const: "review" },
          event: { enum: ["APPROVE", "REQUEST_CHANGES"] },
          body: { type: "string", minLength: 1 },
          comments: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["path", "body", "line", "side"],
              properties: {
                path: { type: "string", minLength: 1 },
                body: { type: "string", minLength: 1 },
                line: { type: "integer", minimum: 1 },
                side: { enum: ["LEFT", "RIGHT"] },
                startLine: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
                startSide: { anyOf: [{ enum: ["LEFT", "RIGHT"] }, { type: "null" }] },
              },
            },
          },
          idempotencyKey: { type: "string", minLength: 1 },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "body", "idempotencyKey"],
        properties: {
          kind: { const: "review_comment" },
          body: { type: "string", minLength: 1 },
          path: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
          line: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
          side: { anyOf: [{ enum: ["LEFT", "RIGHT"] }, { type: "null" }] },
          inReplyToId: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
          idempotencyKey: { type: "string", minLength: 1 },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "body", "idempotencyKey"],
        properties: {
          kind: { const: "issue_comment" },
          body: { type: "string", minLength: 1 },
          idempotencyKey: { type: "string", minLength: 1 },
        },
      },
    ],
  };
}

export function boundPullRequestForLifecycle(lifecycle: IssueLifecycleRecord): CompletionReportPullRequestRef | null {
  const reportPullRequest = latestCompletionReport(lifecycle)?.pullRequest ?? null;
  if (reportPullRequest?.number) return reportPullRequest;
  if (lifecycle.summaryPointers.prNumber === null) return null;
  return {
    url: lifecycle.summaryPointers.prUrl,
    number: lifecycle.summaryPointers.prNumber,
    headSha: lifecycle.summaryPointers.prHeadSha,
    branch: lifecycle.summaryPointers.prBranch ?? lifecycle.summaryPointers.gitBranchName,
  };
}

function parseReviewFeedback(input: unknown): PullRequestReviewFeedbackInputValue {
  const parsed = reviewFeedbackInputParser.safeParse(input);
  if (!parsed.success) {
    throw new SymphonyError("invalid_request", "PR review feedback is invalid", parsed.error.flatten());
  }
  return parsed.data;
}

function requireLifecyclePullRequestNumber(value: number | null): number {
  if (value === null || !Number.isInteger(value) || value <= 0) {
    throw new SymphonyError("invalid_request", "Review feedback requires a lifecycle-bound pull request number");
  }
  return value;
}

function requiredPullRequestNumber(pullRequest: CompletionReportPullRequestRef): number {
  return requireLifecyclePullRequestNumber(pullRequest.number);
}

function requireBoundPullRequest(lifecycle: IssueLifecycleRecord): CompletionReportPullRequestRef {
  const pullRequest = boundPullRequestForLifecycle(lifecycle);
  if (!pullRequest) {
    throw new SymphonyError("invalid_request", "Review feedback requires a lifecycle-bound pull request");
  }
  requireLifecyclePullRequestNumber(pullRequest.number);
  return pullRequest;
}

function requiredHeadSha(pullRequest: CompletionReportPullRequestRef): string {
  const value = pullRequest.headSha?.trim() ?? "";
  if (value.length === 0) {
    throw new SymphonyError("invalid_request", "Inline or review feedback requires a lifecycle-bound pull request head SHA");
  }
  return value;
}

function latestCompletionReport(lifecycle: IssueLifecycleRecord): IssueCompletionReportRecord | null {
  if (lifecycle.lastCompletionReportId) {
    const exact = lifecycle.completionReports.find((report) => report.id === lifecycle.lastCompletionReportId);
    if (exact) return exact;
  }
  return lifecycle.completionReports[lifecycle.completionReports.length - 1] ?? null;
}

function feedbackIdFor(issueId: string, runId: string, idempotencyKey: string): string {
  return `review-feedback:${issueId}:${runId}:${idempotencyKey}`;
}

function requestHashFor(input: PullRequestReviewFeedbackInputValue, pullRequest: CompletionReportPullRequestRef): string {
  const hashInput = {
    input,
    pullRequest: {
      number: pullRequest.number,
      headSha: pullRequest.headSha,
    },
  };
  return createHash("sha256").update(stableJson(hashInput)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function resultFromRecord(record: IssueReviewFeedbackRecord, replayed: boolean): PullRequestReviewFeedbackSubmitResult {
  const number = requiredPullRequestNumber(record.pullRequest);
  return {
    accepted: true,
    replayed,
    feedback: record,
    pullRequest: {
      number,
      url: record.pullRequest.url,
      headSha: record.pullRequest.headSha,
    },
    reviewUrl: record.reviewUrl,
    commentUrls: record.commentUrls,
    urls: urlsFromFeedbackResult(record),
  };
}

function urlsFromFeedbackResult(result: Pick<IssueReviewFeedbackRecord, "reviewUrl" | "commentUrls">): string[] {
  return [result.reviewUrl, ...result.commentUrls].filter((url): url is string => url !== null && url.length > 0);
}

function sameStateIn(state: string, states: string[]): boolean {
  return states.some((candidate) => candidate.toLowerCase() === state.toLowerCase());
}

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  BaseRefVerifier,
  baseRefBlockedReason,
  localRemoteBaseRefExists,
  type BaseRefGitHubClient,
} from "../BaseRefVerification.js";
import type {
  PullRequestIssueCommentFeedbackInput,
  PullRequestReviewCommentFeedbackInput,
  PullRequestReviewFeedbackInput,
  PullRequestReviewFeedbackResult,
} from "../../integrations/github/GitHubPullRequestClient.js";
import type { ServiceConfig } from "../config/Config.js";
import { SymphonyError } from "../errors.js";
import {
  activateBlockerProvenancePatch,
  createReviewFeedbackBaseRefProvenance,
  matchingReviewFeedbackBaseRefProvenance,
  resolveActiveBlockerProvenancePatch,
  updateReviewFeedbackBaseRefProvenanceObservationPatch,
} from "../BlockerProvenance.js";
import type {
  CompletionReportPullRequestRef,
  IssueCompletionReportRecord,
  IssueLifecyclePhase,
  IssueLifecycleRecord,
  IssueLifecycleStore,
  IssueReviewFeedbackRecord,
  PullRequestReviewFeedbackEvent,
} from "../persistence/IssueLifecycleStore.js";
import {
  latestCurrentCompletionReport,
  phaseForIssueState,
} from "../persistence/IssueLifecycleStore.js";
import type { Issue } from "../types.js";

const reviewEventSchema = z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]);
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
const REVIEW_FEEDBACK_PAYLOAD_EXAMPLES: Record<string, unknown>[] = [
  {
    kind: "review",
    event: "APPROVE",
    body: "Review passed.",
    idempotencyKey: "review-approve-<run-id>",
  },
  {
    kind: "review",
    event: "REQUEST_CHANGES",
    body: "Requested changes.",
    comments: [{ path: "src/file.ts", body: "Inline note.", line: 42, side: "RIGHT" }],
    idempotencyKey: "review-request-changes-<run-id>",
  },
  {
    kind: "review",
    event: "COMMENT",
    body: "Expected-red test artifact accepted without merge authorization.",
    idempotencyKey: "review-artifact-comment-<run-id>",
  },
  {
    kind: "review_comment",
    body: "Inline note.",
    path: "src/file.ts",
    line: 42,
    side: "RIGHT",
    idempotencyKey: "review-comment-<run-id>",
  },
  {
    kind: "review_comment",
    body: "Reply note.",
    inReplyToId: 123,
    idempotencyKey: "review-comment-reply-<run-id>",
  },
  {
    kind: "issue_comment",
    body: "Supplemental high-level PR note.",
    idempotencyKey: "issue-comment-<run-id>",
  },
];
const EMPTY_REVIEW_FEEDBACK_ARGUMENTS_MESSAGE =
  'PR review feedback arguments are required. MCP supplies the active PR context only; provide a feedback payload such as {"kind":"review","event":"APPROVE","body":"...","idempotencyKey":"..."} and never call submit_pull_request_review_feedback with {}.';

export type PullRequestReviewFeedbackInputValue = z.infer<typeof reviewFeedbackInputParser>;

export interface PullRequestReviewFeedbackClient {
  submitPullRequestReviewFeedback(input: PullRequestReviewFeedbackInput): Promise<PullRequestReviewFeedbackResult>;
  submitPullRequestReviewCommentFeedback(input: PullRequestReviewCommentFeedbackInput): Promise<PullRequestReviewFeedbackResult>;
  submitPullRequestIssueCommentFeedback(input: PullRequestIssueCommentFeedbackInput): Promise<PullRequestReviewFeedbackResult>;
  getBranchHeadSha?(input: { branchName: string }): Promise<string>;
  gitAuthHeader?(): Promise<string>;
}

export interface ReviewFeedbackActiveContext {
  issue: Issue;
  activeRunId: string;
  role: "reviewer" | string;
  token?: string | null;
  expectedToken?: string | null;
  reviewer?: string | null;
  phase?: IssueLifecyclePhase | null;
  ignoreStateGate?: boolean;
}

export interface PullRequestReviewFeedbackServiceOptions {
  config: ServiceConfig;
  lifecycleStore: IssueLifecycleStore;
  client: PullRequestReviewFeedbackClient;
  baseRefVerifier?: Pick<BaseRefVerifier, "verify">;
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
    this.validateFeedbackForDelivery(feedback, lifecycle);
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

    const result = await this.writeFeedback(feedback, pullRequest, lifecycle, context);
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
    if (lifecycle.issueId !== context.issue.id && lifecycle.issueIdentifier !== context.issue.identifier) {
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
    if (context.ignoreStateGate !== true && !sameStateIn(context.issue.state, this.options.config.reviewLoop.reviewStates)) {
      throw new SymphonyError("invalid_request", "Review feedback requires the issue to be in a review state");
    }
  }

  private validateFeedbackForDelivery(
    feedback: PullRequestReviewFeedbackInputValue,
    lifecycle: IssueLifecycleRecord,
  ): void {
    if (feedback.kind !== "review") return;
    const report = latestCurrentCompletionReport(lifecycle);
    const acceptedArtifact =
      report?.contractSnapshot?.delivery.mode === "accepted_artifact";
    if (feedback.event === "COMMENT" && !acceptedArtifact) {
      throw new SymphonyError(
        "invalid_request",
        "Whole-PR COMMENT review feedback is reserved for accepted expected-red artifacts",
      );
    }
    if (feedback.event === "APPROVE" && acceptedArtifact) {
      throw new SymphonyError(
        "invalid_request",
        "Accepted expected-red artifacts require a head-bound COMMENT review; APPROVE is reserved for merge authorization",
      );
    }
  }

  private async writeFeedback(
    feedback: PullRequestReviewFeedbackInputValue,
    pullRequest: CompletionReportPullRequestRef,
    lifecycle: IssueLifecycleRecord,
    context: ReviewFeedbackActiveContext,
  ): Promise<PullRequestReviewFeedbackResult> {
    if (feedback.kind === "issue_comment") {
      return this.options.client.submitPullRequestIssueCommentFeedback({
        pullRequestNumber: requiredPullRequestNumber(pullRequest),
        body: feedback.body,
      });
    }
    await this.verifyBaseRefBeforeReviewFeedback(lifecycle, pullRequest, context);
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

  private async verifyBaseRefBeforeReviewFeedback(
    lifecycle: IssueLifecycleRecord,
    pullRequest: CompletionReportPullRequestRef,
    context: ReviewFeedbackActiveContext,
  ): Promise<void> {
    const client = baseRefClientFromReviewFeedbackClient(this.options.client);
    if (client === null) return;
    const workspacePath = lifecycle.summaryPointers.workspacePath;
    const branchName =
      lifecycle.summaryPointers.gitBranchName ??
      lifecycle.summaryPointers.prBranch ??
      lifecycle.summaryPointers.branchName ??
      context.issue.branchName;
    const baseRef = lifecycle.summaryPointers.baseRef ?? this.options.config.workspace.source.baseRef;
    if (
      this.options.baseRefVerifier === undefined &&
      !(await localRemoteBaseRefExists({ workspacePath, baseRef }))
    ) {
      return;
    }
    const observation = await (this.options.baseRefVerifier ?? new BaseRefVerifier()).verify({
      workspacePath,
      branchName,
      baseRef,
      operation: "review_feedback",
      client,
    });
    const matchingProvenance = matchingReviewFeedbackBaseRefProvenance(
      lifecycle,
      { runId: context.activeRunId, pullRequest },
    );
    const provenanceObservationPatch =
      matchingProvenance === null
        ? {}
        : updateReviewFeedbackBaseRefProvenanceObservationPatch(
            lifecycle,
            matchingProvenance.id,
            observation,
          );
    const observedLifecycle = {
      ...lifecycle,
      ...provenanceObservationPatch,
    };
    if (observation.classification === "ok") {
      await this.options.lifecycleStore.updateIssue(context.issue, {
        baseRefObservation: observation,
        ...(matchingProvenance === null
          ? {}
          : {
              phase: "review",
              blockedReason: null,
              ...resolveActiveBlockerProvenancePatch(observedLifecycle, {
                expectedProvenanceId: matchingProvenance.id,
                resolution: "base_ref_recheck",
                resolvedAt: observation.checkedAt,
              }),
            }),
      });
      return;
    }
    const blockedReason = baseRefBlockedReason(observation);
    const provenance =
      matchingProvenance === null
        ? createReviewFeedbackBaseRefProvenance({
            issue: context.issue,
            runId: context.activeRunId,
            pullRequestNumber: requiredPullRequestNumber(pullRequest),
            pullRequestHeadSha: requiredHeadSha(pullRequest),
            observation,
          })
        : (observedLifecycle.blockerProvenances ?? []).find(
            (record) => record.id === matchingProvenance.id,
          ) ?? matchingProvenance;
    await this.options.lifecycleStore.updateIssue(context.issue, {
      phase: "blocked",
      blockedReason,
      baseRefObservation: observation,
      ...(matchingProvenance === null
        ? activateBlockerProvenancePatch(lifecycle, provenance)
        : provenanceObservationPatch),
    });
    throw new SymphonyError("invalid_request", blockedReason, {
      baseRefObservation: observation,
      blockerProvenance: provenance,
    });
  }
}

export function reviewFeedbackInputSchema(): Record<string, unknown> {
  return {
    type: "object",
    description:
      "Required reviewer feedback payload. Symphony supplies the active lifecycle-bound PR context; the tool call must still include kind, body, idempotencyKey, and event for whole-PR reviews. Never call this tool with an empty object.",
    examples: REVIEW_FEEDBACK_PAYLOAD_EXAMPLES,
    oneOf: [
      {
        type: "object",
        title: "Whole-PR review",
        description:
          'Submit a whole-PR GitHub review. Use event "APPROVE" for merge-authorizing pass evidence, "COMMENT" for accepted expected-red artifact evidence, or "REQUEST_CHANGES" for fail review feedback.',
        additionalProperties: false,
        required: ["kind", "event", "body", "idempotencyKey"],
        properties: {
          kind: { const: "review", description: 'Required discriminator for a whole-PR review.' },
          event: { enum: ["APPROVE", "REQUEST_CHANGES", "COMMENT"], description: "Required GitHub review event." },
          body: { type: "string", minLength: 1, description: "Required review body to publish on the PR." },
          comments: {
            type: "array",
            description: "Optional inline review comments to submit with the whole-PR review.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["path", "body", "line", "side"],
              properties: {
                path: { type: "string", minLength: 1, description: "Repository-relative file path." },
                body: { type: "string", minLength: 1, description: "Inline comment body." },
                line: { type: "integer", minimum: 1, description: "Target line number." },
                side: { enum: ["LEFT", "RIGHT"], description: "Diff side for the target line." },
                startLine: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
                startSide: { anyOf: [{ enum: ["LEFT", "RIGHT"] }, { type: "null" }] },
              },
            },
          },
          idempotencyKey: { type: "string", minLength: 1, description: "Required stable unique key for retry-safe submission." },
        },
      },
      {
        type: "object",
        title: "Inline PR review comment",
        description: "Create a single inline PR review comment. path, line, and side are required unless replying with inReplyToId.",
        additionalProperties: false,
        required: ["kind", "body", "path", "line", "side", "idempotencyKey"],
        properties: {
          kind: { const: "review_comment", description: 'Required discriminator for a PR review comment.' },
          body: { type: "string", minLength: 1, description: "Required inline comment body." },
          path: { type: "string", minLength: 1, description: "Required repository-relative file path." },
          line: { type: "integer", minimum: 1, description: "Required target line number." },
          side: { enum: ["LEFT", "RIGHT"], description: "Required diff side for the target line." },
          inReplyToId: { type: "null", description: "Omit for a new inline comment; use the reply shape to reply." },
          idempotencyKey: { type: "string", minLength: 1, description: "Required stable unique key for retry-safe submission." },
        },
      },
      {
        type: "object",
        title: "PR review comment reply",
        description: "Reply to an existing PR review comment by GitHub comment id.",
        additionalProperties: false,
        required: ["kind", "body", "inReplyToId", "idempotencyKey"],
        properties: {
          kind: { const: "review_comment", description: 'Required discriminator for a PR review comment reply.' },
          body: { type: "string", minLength: 1, description: "Required reply body." },
          path: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
          line: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
          side: { anyOf: [{ enum: ["LEFT", "RIGHT"] }, { type: "null" }] },
          inReplyToId: { type: "integer", minimum: 1, description: "Required GitHub review comment id to reply to." },
          idempotencyKey: { type: "string", minLength: 1, description: "Required stable unique key for retry-safe submission." },
        },
      },
      {
        type: "object",
        title: "High-level PR issue comment",
        description: "Post a supplemental high-level PR comment. This does not satisfy pass approval.",
        additionalProperties: false,
        required: ["kind", "body", "idempotencyKey"],
        properties: {
          kind: { const: "issue_comment", description: 'Required discriminator for a high-level PR comment.' },
          body: { type: "string", minLength: 1, description: "Required PR comment body." },
          idempotencyKey: { type: "string", minLength: 1, description: "Required stable unique key for retry-safe submission." },
        },
      },
    ],
  };
}

export function boundPullRequestForLifecycle(lifecycle: IssueLifecycleRecord): CompletionReportPullRequestRef | null {
  const reportPullRequest = latestCurrentCompletionReport(lifecycle)?.pullRequest ?? null;
  if (reportPullRequest === null) return null;
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
  if (isEmptyReviewFeedbackInput(input)) {
    throw new SymphonyError("invalid_request", EMPTY_REVIEW_FEEDBACK_ARGUMENTS_MESSAGE, {
      examples: REVIEW_FEEDBACK_PAYLOAD_EXAMPLES,
    });
  }
  const parsed = reviewFeedbackInputParser.safeParse(input);
  if (!parsed.success) {
    throw new SymphonyError("invalid_request", `PR review feedback is invalid: ${zodIssueSummary(parsed.error.issues)}`, parsed.error.flatten());
  }
  return parsed.data;
}

function isEmptyReviewFeedbackInput(input: unknown): boolean {
  if (input === undefined || input === null) return true;
  if (typeof input !== "object" || Array.isArray(input)) return false;
  return Object.keys(input as Record<string, unknown>).length === 0;
}

function zodIssueSummary(issues: z.ZodIssue[]): string {
  const summary = zodIssueMessages(issues).join("; ");
  return summary.length <= 1_000 ? summary : `${summary.slice(0, 997)}...`;
}

function zodIssueMessages(issues: z.ZodIssue[]): string[] {
  return issues.flatMap((issue) => {
    if (issue.code === "invalid_union") {
      const nested = zodUnionIssueMessages(issue);
      if (nested.length > 0) return nested;
    }
    const path = issue.path.length === 0 ? "$" : issue.path.join(".");
    return `${path}: ${issue.message}`;
  });
}

function zodUnionIssueMessages(issue: z.ZodIssue): string[] {
  const candidate = issue as {
    unionErrors?: Array<{ issues: z.ZodIssue[] }>;
    errors?: z.ZodIssue[][];
  };
  if (Array.isArray(candidate.unionErrors)) {
    return candidate.unionErrors.flatMap((error) => zodIssueMessages(error.issues));
  }
  if (Array.isArray(candidate.errors)) {
    return candidate.errors.flatMap((issues) => zodIssueMessages(issues));
  }
  return [];
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

function baseRefClientFromReviewFeedbackClient(
  client: PullRequestReviewFeedbackClient,
): BaseRefGitHubClient | null {
  if (
    typeof client.getBranchHeadSha === "function" &&
    typeof client.gitAuthHeader === "function"
  ) {
    return {
      getBranchHeadSha: (input) => client.getBranchHeadSha!(input),
      gitAuthHeader: () => client.gitAuthHeader!(),
    };
  }
  return null;
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

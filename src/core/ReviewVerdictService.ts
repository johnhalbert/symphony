import { z } from "zod";
import type { ServiceConfig } from "./config/Config.js";
import { SymphonyError } from "./errors.js";
import type {
  IssueLifecyclePhase,
  IssueLifecycleRecord,
  IssueLifecycleStore,
  IssueReviewVerdictRecord,
  ReviewVerdictAcceptanceResult,
} from "./persistence/IssueLifecycleStore.js";
import { phaseForIssueState } from "./persistence/IssueLifecycleStore.js";
import type { Issue } from "./types.js";
import {
  planBlockedEscalationWritebacks,
  planReviewFailWritebacks,
  planReviewPassWritebacks,
} from "./writeback/TransitionPolicy.js";
import type { FileWritebackOutboxStore, WritebackOperation } from "./writeback/WritebackOutbox.js";

const reviewVerdictSchema = z.object({
  runId: z.string().trim().min(1),
  issueId: z.string().trim().min(1),
  verdict: z.enum(["pass", "fail"]),
  acceptanceResults: z
    .array(
      z.object({
        text: z.string().trim().min(1),
        satisfied: z.boolean(),
        evidence: z.string().trim().min(1).nullable(),
      }),
    )
    .min(1),
  findings: z.array(z.string().trim().min(1)),
  evidence: z.array(z.string().trim().min(1)).min(1),
  idempotencyKey: z.string().trim().min(1),
});

export type ReviewVerdictInput = z.infer<typeof reviewVerdictSchema>;
export type ReviewVerdictSubmitterRole = "worker" | "orchestrator" | "reviewer" | string;

export interface ReviewVerdictActiveContext {
  issue: Issue;
  activeRunId: string;
  role: ReviewVerdictSubmitterRole;
  token?: string | null;
  expectedToken?: string | null;
  reviewer?: string | null;
  phase?: IssueLifecyclePhase | null;
}

export interface ReviewVerdictServiceOptions {
  config: ServiceConfig;
  lifecycleStore: IssueLifecycleStore;
  writebackOutbox: Pick<FileWritebackOutboxStore, "enqueueOnce">;
}

export interface ReviewVerdictResult {
  accepted: true;
  replayed: boolean;
  verdict: IssueReviewVerdictRecord;
  writebackOperations: WritebackOperation[];
}

export class ReviewVerdictService {
  constructor(private readonly options: ReviewVerdictServiceOptions) {}

  async submit_review_verdict(input: unknown, context: ReviewVerdictActiveContext): Promise<ReviewVerdictResult> {
    return this.submitReviewVerdict(input, context);
  }

  async submitReviewVerdict(input: unknown, context: ReviewVerdictActiveContext): Promise<ReviewVerdictResult> {
    const verdict = parseReviewVerdict(input);
    this.validateCaller(verdict, context);

    const existingLifecycle = await this.options.lifecycleStore.get(context.issue.id);
    const existing = existingLifecycle?.reviewVerdicts.find((item) => item.idempotencyKey === verdict.idempotencyKey);
    if (existing) {
      return { accepted: true, replayed: true, verdict: existing, writebackOperations: [] };
    }

    const lifecyclePhase = context.phase ?? existingLifecycle?.phase ?? phaseForIssueState(context.issue.state, this.options.config);
    this.validateIssueIsAcceptingVerdicts(context, lifecyclePhase);
    this.validateVerdictPayload(verdict);

    const lifecycle = await this.options.lifecycleStore.ensureIssue(context.issue, { phase: lifecyclePhase });
    const writebackDetails = {
      idempotencyKey: verdict.idempotencyKey,
      acceptanceResults: normalizeAcceptanceResults(verdict.acceptanceResults),
      findings: verdict.findings,
      evidence: verdict.evidence,
    };
    const reviewRound = verdict.verdict === "fail" ? nextReviewRound(lifecycle) : lifecycle.reviewRound;
    const ceilingReached =
      verdict.verdict === "fail" && reviewRound >= this.options.config.reviewLoop.maxReviewRounds;
    const provisionalVerdict: IssueReviewVerdictRecord = {
      id: verdictIdFor(context.issue.id, verdict.idempotencyKey),
      idempotencyKey: verdict.idempotencyKey,
      runId: verdict.runId,
      issueId: context.issue.id,
      issueIdentifier: context.issue.identifier,
      verdict: verdict.verdict,
      acceptanceResults: normalizeAcceptanceResults(verdict.acceptanceResults),
      findings: verdict.findings,
      evidence: verdict.evidence,
      reviewer: context.reviewer ?? null,
      submittedAt: new Date().toISOString(),
      writebackOperationKeys: [],
    };
    const operations =
      ceilingReached
        ? planBlockedEscalationWritebacks(
            {
              issue: context.issue,
              runId: verdict.runId,
              reason: `max review rounds reached (${reviewRound}/${this.options.config.reviewLoop.maxReviewRounds})`,
              incompleteTurnCount: lifecycle.incompleteTurnCount,
              maxIncompleteTurns: this.options.config.reviewLoop.maxIncompleteTurns,
              reviewRound,
              maxReviewRounds: this.options.config.reviewLoop.maxReviewRounds,
              lastCompletionReport: latestCompletionReport(lifecycle),
              lastReviewVerdict: provisionalVerdict,
              requiredAction:
                "Review the requested changes, decide whether the worker should continue, and move the issue out of Blocked when it is ready for another implementation pass.",
            },
            this.options.config,
          )
        : verdict.verdict === "fail"
        ? planReviewFailWritebacks(reviewWritebackContext(context, verdict.runId), this.options.config, writebackDetails)
        : planReviewPassWritebacks(reviewWritebackContext(context, verdict.runId), this.options.config, writebackDetails);
    if (operations.length === 0) {
      throw new SymphonyError("invalid_request", "Review verdict cannot be accepted for the current issue state");
    }

    const storedVerdict: IssueReviewVerdictRecord = {
      ...provisionalVerdict,
      writebackOperationKeys: operations.map((operation) => operation.idempotencyKey),
    };
    const enqueued: WritebackOperation[] = [];
    for (const operation of operations) {
      enqueued.push(await this.options.writebackOutbox.enqueueOnce(operation));
    }

    await this.options.lifecycleStore.updateIssue(context.issue, {
      phase: verdict.verdict === "pass" ? "passed" : ceilingReached ? "blocked" : "implementation",
      ...(verdict.verdict === "fail" ? { reviewRound } : {}),
      incompleteTurnCount: verdict.verdict === "fail" ? 0 : lifecycle.incompleteTurnCount,
      blockedReason: ceilingReached
        ? `max review rounds reached (${reviewRound}/${this.options.config.reviewLoop.maxReviewRounds})`
        : null,
      lastReviewVerdictId: storedVerdict.id,
      reviewVerdicts: [...lifecycle.reviewVerdicts, storedVerdict],
    });

    return { accepted: true, replayed: false, verdict: storedVerdict, writebackOperations: enqueued };
  }

  private validateCaller(verdict: ReviewVerdictInput, context: ReviewVerdictActiveContext): void {
    if (context.role !== "reviewer") {
      throw new SymphonyError("invalid_request", "Only active reviewers may submit review verdicts");
    }
    if (context.expectedToken !== undefined && context.expectedToken !== null && context.token !== context.expectedToken) {
      throw new SymphonyError("invalid_request", "Missing or invalid review verdict token");
    }
    if (verdict.runId !== context.activeRunId) {
      throw new SymphonyError("invalid_request", "Review verdict run does not match the active reviewer run");
    }
    if (verdict.issueId !== context.issue.id && verdict.issueId !== context.issue.identifier) {
      throw new SymphonyError("invalid_request", "Review verdict issue does not match the active reviewer issue");
    }
  }

  private validateIssueIsAcceptingVerdicts(context: ReviewVerdictActiveContext, lifecyclePhase: IssueLifecyclePhase): void {
    if (lifecyclePhase !== "review") {
      throw new SymphonyError("invalid_request", `Review verdict cannot be accepted while lifecycle phase is ${lifecyclePhase}`);
    }
    if (!sameStateIn(context.issue.state, this.options.config.reviewLoop.reviewStates)) {
      throw new SymphonyError("invalid_request", "Review verdict requires the issue to be in a review state");
    }
  }

  private validateVerdictPayload(verdict: ReviewVerdictInput): void {
    if (verdict.verdict === "fail" && verdict.findings.length === 0) {
      throw new SymphonyError("invalid_request", "Fail review verdicts require at least one finding");
    }
  }
}

export function formatWorkerReviewVerdictPrompt(lifecycle: IssueLifecycleRecord): string | null {
  const verdict = latestReviewVerdict(lifecycle);
  if (!verdict || verdict.verdict !== "fail") return null;
  const pointers = lifecycle.summaryPointers;
  const latestReport = latestCompletionReport(lifecycle);
  return [
    "",
    "Reviewer findings to address before submitting another completion report:",
    "Reviewer verdict: fail / requested changes",
    `Review run: ${verdict.runId}`,
    "",
    "Lifecycle counters:",
    `- Review rounds: ${lifecycle.reviewRound}`,
    `- Incomplete worker turns: ${lifecycle.incompleteTurnCount}`,
    `- Lifecycle phase: ${lifecycle.phase}`,
    "",
    "Latest workspace/git evidence:",
    `- Workspace path: ${pointers.workspacePath ?? "n/a"}`,
    `- Branch: ${pointers.gitBranchName ?? pointers.branchName ?? latestReport?.branchName ?? "n/a"}`,
    `- Repository path: ${pointers.repoPath ?? "n/a"}`,
    `- Base ref: ${pointers.baseRef ?? "n/a"}`,
    `- Pull request: ${formatPullRequest(pointers.prNumber, pointers.prUrl)}`,
    "",
    "Acceptance criteria gaps:",
    ...formatAcceptanceGaps(verdict.acceptanceResults),
    "",
    "Acceptance results:",
    ...verdict.acceptanceResults.map(
      (item) => `- ${item.satisfied ? "[x]" : "[ ]"} ${item.text}${item.evidence === null ? "" : ` (${item.evidence})`}`,
    ),
    "",
    "Findings:",
    ...verdict.findings.map((finding) => `- ${finding}`),
    "",
    "Evidence:",
    ...verdict.evidence.map((item) => `- ${item}`),
  ].join("\n");
}

function parseReviewVerdict(input: unknown): ReviewVerdictInput {
  const parsed = reviewVerdictSchema.safeParse(input);
  if (!parsed.success) {
    throw new SymphonyError("invalid_request", "Review verdict is invalid", parsed.error.flatten());
  }
  return parsed.data;
}

function normalizeAcceptanceResults(items: ReviewVerdictInput["acceptanceResults"]): ReviewVerdictAcceptanceResult[] {
  return items.map((item) => ({
    text: item.text,
    satisfied: item.satisfied,
    evidence: item.evidence,
  }));
}

function reviewWritebackContext(context: ReviewVerdictActiveContext, runId: string) {
  return {
    issue: context.issue,
    runId,
    reviewer: context.reviewer ?? null,
  };
}

function nextReviewRound(lifecycle: IssueLifecycleRecord): number {
  return lifecycle.reviewRound + 1;
}

function verdictIdFor(issueId: string, idempotencyKey: string): string {
  return `review-verdict:${issueId}:${idempotencyKey}`;
}

function latestReviewVerdict(lifecycle: IssueLifecycleRecord): IssueReviewVerdictRecord | null {
  if (lifecycle.lastReviewVerdictId) {
    const exact = lifecycle.reviewVerdicts.find((verdict) => verdict.id === lifecycle.lastReviewVerdictId);
    if (exact) return exact;
  }
  return lifecycle.reviewVerdicts[lifecycle.reviewVerdicts.length - 1] ?? null;
}

function latestCompletionReport(lifecycle: IssueLifecycleRecord) {
  if (lifecycle.lastCompletionReportId) {
    const exact = lifecycle.completionReports.find((report) => report.id === lifecycle.lastCompletionReportId);
    if (exact) return exact;
  }
  return lifecycle.completionReports[lifecycle.completionReports.length - 1] ?? null;
}

function formatPullRequest(number: number | null, url: string | null): string {
  const parts = [number === null ? null : `#${number}`, url].filter((value): value is string => value !== null);
  return parts.length === 0 ? "n/a" : parts.join(" ");
}

function formatAcceptanceGaps(results: ReviewVerdictAcceptanceResult[]): string[] {
  const gaps = results.filter((item) => !item.satisfied);
  if (gaps.length === 0) return ["- No explicit acceptance criteria gaps were recorded."];
  return gaps.map((item) => `- ${item.text}${item.evidence === null ? "" : ` (${item.evidence})`}`);
}

function sameStateIn(state: string, states: string[]): boolean {
  return states.some((candidate) => candidate.toLowerCase() === state.toLowerCase());
}

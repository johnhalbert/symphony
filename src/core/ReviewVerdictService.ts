import { z } from "zod";
import type { ServiceConfig } from "./config/Config.js";
import { SymphonyError } from "./errors.js";
import type {
  CompletionReportPullRequestRef,
  IssueLifecyclePatch,
  IssueLifecyclePhase,
  IssueLifecycleRecord,
  IssueMergeGateState,
  IssueLifecycleStore,
  ReviewDiscoveryFindingRecord,
  ReviewGateFindingRecord,
  IssueReviewVerdictRecord,
  IssueReviewVerdictSubmissionRecord,
  ReviewVerdictAcceptanceResult,
} from "./persistence/IssueLifecycleStore.js";
import { isSupersededLifecycleRecord, phaseForIssueState } from "./persistence/IssueLifecycleStore.js";
import { isMergeGateVerdict } from "./merge/MergePolicyService.js";
import { shouldSilentlyRetireMergeGate } from "./merge/MergeGateLifecycle.js";
import type { RunTranscriptStore } from "./persistence/RunTranscriptStore.js";
import type { Issue } from "./types.js";
import {
  planBlockedEscalationWritebacks,
  planReviewBlockedWritebacks,
  planReviewFailWritebacks,
  planReviewPassWritebacks,
} from "./writeback/TransitionPolicy.js";
import type { NewWritebackOperation, WritebackOperation, WritebackOutboxStore } from "./writeback/WritebackOutbox.js";

const PASS_REQUIRES_APPROVE_MESSAGE =
  'Pass review verdict requires prior submit_pull_request_review_feedback with kind="review" and event="APPROVE" for the active reviewer run and lifecycle-bound PR.';
const FAIL_AFTER_APPROVE_MESSAGE =
  "Fail review verdict cannot follow APPROVE review feedback in the same reviewer run; submit a pass verdict or start a fresh review run.";
const BLOCKED_AFTER_APPROVE_MESSAGE =
  "Blocked review verdict cannot follow APPROVE review feedback in the same reviewer run; submit a pass verdict or start a fresh review run.";

const REVIEW_GATE_SCENARIO_ENTITLEMENTS = [
  "explicit_requirement",
  "named_acceptance_criterion",
  "named_validation_requirement",
  "necessary_core_behavior",
] as const;
const REVIEW_DISCOVERY_IMPORTANCE = ["critical", "high", "medium", "low"] as const;
const REVIEW_DISCOVERY_RELATIONSHIPS = [
  "implied_core",
  "adjacent_sibling",
  "hidden_matrix_axis",
  "sibling_issue_scope",
  "future_hardening",
  "out_of_scope",
] as const;
const REVIEW_DISCOVERY_DISPOSITIONS = ["planner_decomposition", "followup_issue", "operator_decision", "ignore"] as const;

const reviewGateFindingSchema = z.object({
  summary: z.string().trim().min(1),
  requirementIds: z.array(z.string().trim().min(1)).default([]),
  contractAnchor: z.string().trim().min(1),
  scenario: z.string().trim().min(1),
  scenarioEntitlement: z.enum(REVIEW_GATE_SCENARIO_ENTITLEMENTS),
  observedFailure: z.string().trim().min(1),
  currentIssueOwnership: z.string().trim().min(1),
  boundedRepair: z.string().trim().min(1),
  evidence: z.array(z.string().trim().min(1)).min(1),
});

const reviewDiscoveryFindingSchema = z.object({
  summary: z.string().trim().min(1),
  importance: z.enum(REVIEW_DISCOVERY_IMPORTANCE),
  relationship: z.enum(REVIEW_DISCOVERY_RELATIONSHIPS),
  discoveryReason: z.string().trim().min(1),
  suggestedDisposition: z.enum(REVIEW_DISCOVERY_DISPOSITIONS),
  scenarioAxes: z.array(z.string().trim().min(1)).default([]),
  evidence: z.array(z.string().trim().min(1)).min(1),
  ownerIssueIdentifier: z.string().trim().min(1).nullable().optional(),
});

const reviewVerdictSchema = z.object({
  runId: z.string().trim().min(1),
  issueId: z.string().trim().min(1),
  verdict: z.enum(["pass", "fail", "blocked"]),
  acceptanceResults: z
    .array(
      z.object({
        text: z.string().trim().min(1),
        satisfied: z.boolean(),
        evidence: z.string().trim().min(1).nullable(),
      }),
    )
    .min(1),
  findings: z.array(z.string().trim().min(1)).optional().default([]),
  gateFindings: z.array(reviewGateFindingSchema).optional(),
  discoveryFindings: z.array(reviewDiscoveryFindingSchema).optional().default([]),
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
  ignoreStateGate?: boolean;
}

export interface ReviewVerdictServiceOptions {
  config: ServiceConfig;
  lifecycleStore: IssueLifecycleStore;
  writebackOutbox: Pick<WritebackOutboxStore, "enqueueOnce">;
  runStore?: Pick<RunTranscriptStore, "appendEvent">;
}

export interface ReviewVerdictResult {
  accepted: true;
  replayed: boolean;
  verdict: IssueReviewVerdictSubmissionRecord;
  writebackOperations: WritebackOperation[];
  handoffStatus: "pending" | "applied";
}

export interface ReviewVerdictApplicationPlan {
  verdict: IssueReviewVerdictRecord;
  operations: NewWritebackOperation[];
  patch: IssueLifecyclePatch;
}

export type WorkerMergeGatePromptResult =
  | { kind: "repair"; text: string }
  | { kind: "stale_warning"; text: string };

export class ReviewVerdictService {
  constructor(private readonly options: ReviewVerdictServiceOptions) {}

  async submit_review_verdict(input: unknown, context: ReviewVerdictActiveContext): Promise<ReviewVerdictResult> {
    return this.submitReviewVerdict(input, context);
  }

  async submitReviewVerdict(input: unknown, context: ReviewVerdictActiveContext): Promise<ReviewVerdictResult> {
    const verdict = parseReviewVerdict(input);
    this.validateCaller(verdict, context);

    const existingLifecycle = await this.options.lifecycleStore.get(context.issue.id);
    const existingSubmission = (existingLifecycle?.reviewVerdictSubmissions ?? []).find(
      (item) => item.runId === context.activeRunId && item.idempotencyKey === verdict.idempotencyKey,
    );
    if (existingSubmission) {
      return {
        accepted: true,
        replayed: true,
        verdict: existingSubmission,
        writebackOperations: [],
        handoffStatus: existingSubmission.status === "applied" ? "applied" : "pending",
      };
    }
    const existingAccepted = existingLifecycle?.reviewVerdicts.find(
      (item) => item.runId === context.activeRunId && item.idempotencyKey === verdict.idempotencyKey,
    );
    if (existingAccepted) {
      return {
        accepted: true,
        replayed: true,
        verdict: submissionFromAcceptedVerdict(existingAccepted),
        writebackOperations: [],
        handoffStatus: "applied",
      };
    }
    const existingCrossRun = [
      ...(existingLifecycle?.reviewVerdictSubmissions ?? []),
      ...(existingLifecycle?.reviewVerdicts.map((item) => submissionFromAcceptedVerdict(item)) ?? []),
    ].find(
      (item) => item.idempotencyKey === verdict.idempotencyKey && item.runId !== context.activeRunId,
    );
    if (existingCrossRun) {
      throw new SymphonyError("conflict", "Review verdict idempotency key was already used by another run", {
        idempotencyKey: verdict.idempotencyKey,
        activeRunId: context.activeRunId,
        existingRunId: existingCrossRun.runId,
        existingVerdictId: existingCrossRun.id,
      });
    }

    const lifecyclePhase = context.phase ?? existingLifecycle?.phase ?? phaseForIssueState(context.issue.state, this.options.config);
    this.validateIssueIsAcceptingVerdicts(context, lifecyclePhase);
    this.validateVerdictPayload(verdict);
    const gateFindings = normalizeReviewGateFindings(verdict);
    const discoveryFindings = normalizeReviewDiscoveryFindings(verdict.discoveryFindings);
    const storedFindings =
      verdict.verdict === "blocked"
        ? verdict.findings.map((finding) => finding.trim()).filter((finding) => finding.length > 0)
        : gateFindings.map((finding) => finding.summary);

    const lifecycle = await this.options.lifecycleStore.ensureIssue(
      context.issue,
      existingLifecycle ? {} : { phase: lifecyclePhase },
    );
    this.validateReviewFeedbackAlignment(verdict, lifecycle);
    const submission: IssueReviewVerdictSubmissionRecord = {
      id: verdictIdFor(context.issue.id, verdict.idempotencyKey),
      idempotencyKey: verdict.idempotencyKey,
      runId: verdict.runId,
      issueId: context.issue.id,
      issueIdentifier: context.issue.identifier,
      verdict: verdict.verdict,
      acceptanceResults: normalizeAcceptanceResults(verdict.acceptanceResults),
      findings: storedFindings,
      gateFindings,
      discoveryFindings,
      evidence: verdict.evidence,
      reviewer: context.reviewer ?? null,
      submittedAt: new Date().toISOString(),
      status: "pending",
      ignoreStateGate: context.ignoreStateGate === true,
      appliedAt: null,
      acceptedVerdictId: null,
      supersededAt: null,
      supersededReason: null,
    };
    await this.options.lifecycleStore.updateIssue(context.issue, {
      reviewVerdictSubmissions: [...(lifecycle.reviewVerdictSubmissions ?? []), submission],
    });

    return {
      accepted: true,
      replayed: false,
      verdict: submission,
      writebackOperations: [],
      handoffStatus: "pending",
    };
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
    if (context.ignoreStateGate !== true && !sameStateIn(context.issue.state, this.options.config.reviewLoop.reviewStates)) {
      throw new SymphonyError("invalid_request", "Review verdict requires the issue to be in a review state");
    }
  }

  private validateVerdictPayload(verdict: ReviewVerdictInput): void {
    const gateFindings = normalizeReviewGateFindings(verdict);
    if (verdict.verdict === "fail" && gateFindings.length === 0) {
      throw new SymphonyError("invalid_request", "Fail review verdicts require at least one gate finding or legacy finding");
    }
    if (verdict.verdict === "pass" && gateFindings.length > 0) {
      throw new SymphonyError("invalid_request", "Pass review verdicts cannot include gate findings");
    }
    if (verdict.verdict === "blocked" && gateFindings.length > 0) {
      throw new SymphonyError(
        "invalid_request",
        "Blocked review verdicts cannot include gate findings; use findings or discoveryFindings for non-worker-owned blockers",
      );
    }
  }

  private validateReviewFeedbackAlignment(verdict: ReviewVerdictInput, lifecycle: IssueLifecycleRecord): void {
    if (verdict.verdict === "fail") {
      if (hasSameRunApprovalFeedback(lifecycle, verdict.runId)) {
        throw new SymphonyError("invalid_request", FAIL_AFTER_APPROVE_MESSAGE);
      }
      return;
    }
    if (verdict.verdict === "blocked") {
      if (hasSameRunApprovalFeedback(lifecycle, verdict.runId)) {
        throw new SymphonyError("invalid_request", BLOCKED_AFTER_APPROVE_MESSAGE);
      }
      return;
    }

    const pullRequest = currentPullRequestForReview(lifecycle);
    if (!pullRequest || !hasSameRunApprovalFeedbackForPullRequest(lifecycle, verdict.runId, pullRequest)) {
      throw new SymphonyError("invalid_request", PASS_REQUIRES_APPROVE_MESSAGE);
    }
  }
}

export function planReviewVerdictSubmissionApplication(input: {
  config: ServiceConfig;
  issue: Issue;
  lifecycle: IssueLifecycleRecord;
  submission: IssueReviewVerdictSubmissionRecord;
  appliedAt?: string;
}): ReviewVerdictApplicationPlan {
  const reviewRound = input.submission.verdict === "fail" ? nextReviewRound(input.lifecycle) : input.lifecycle.reviewRound;
  const maxReviewerFailures = input.config.reviewLoop.failureLimits.reviewerFailures;
  const ceilingReached = input.submission.verdict === "fail" && reviewRound >= maxReviewerFailures;
  const provisionalVerdict = acceptedVerdictFromSubmission(input.submission, []);
  const writebackDetails = {
    idempotencyKey: input.submission.idempotencyKey,
    acceptanceResults: input.submission.acceptanceResults,
    findings: input.submission.findings,
    gateFindings: input.submission.gateFindings,
    discoveryFindings: input.submission.discoveryFindings,
    evidence: input.submission.evidence,
  };
  let operations: NewWritebackOperation[];
  if (ceilingReached) {
    operations = planBlockedEscalationWritebacks(
      {
        issue: input.issue,
        runId: input.submission.runId,
        reason: `max reviewer failures reached (${reviewRound}/${maxReviewerFailures})`,
        incompleteTurnCount: input.lifecycle.incompleteTurnCount,
        maxIncompleteTurns: input.config.reviewLoop.maxIncompleteTurns,
        reviewRound,
        maxReviewRounds: maxReviewerFailures,
        lastCompletionReport: latestCompletionReport(input.lifecycle),
        lastReviewVerdict: provisionalVerdict,
        requiredAction:
          "Review the requested changes, decide whether the worker should continue, and move the issue out of Blocked when it is ready for another implementation pass.",
      },
      input.config,
    );
  } else if (input.submission.verdict === "fail") {
    operations = planReviewFailWritebacks(reviewWritebackContextForSubmission(input.issue, input.submission), input.config, writebackDetails);
  } else if (input.submission.verdict === "blocked") {
    operations = planReviewBlockedWritebacks(reviewWritebackContextForSubmission(input.issue, input.submission), input.config, writebackDetails);
  } else {
    operations = planReviewPassWritebacks(reviewWritebackContextForSubmission(input.issue, input.submission), input.config, writebackDetails);
  }
  if (operations.length === 0 && input.submission.ignoreStateGate !== true) {
    throw new SymphonyError("invalid_request", "Review verdict cannot be accepted for the current issue state");
  }

  const storedVerdict = acceptedVerdictFromSubmission(
    input.submission,
    operations.map((operation) => operation.idempotencyKey),
  );
  const appliedAt = input.appliedAt ?? new Date().toISOString();
  const reviewVerdictSubmissions = (input.lifecycle.reviewVerdictSubmissions ?? []).map((submission) =>
    submission.id === input.submission.id
      ? {
          ...submission,
          status: "applied" as const,
          appliedAt,
          acceptedVerdictId: storedVerdict.id,
        }
      : submission,
  );
  const patch: IssueLifecyclePatch = {
    phase:
      input.submission.verdict === "pass"
        ? "passed"
        : ceilingReached
          ? "blocked"
          : input.submission.verdict === "blocked"
            ? "review"
            : "implementation",
    ...(input.submission.verdict === "fail" ? { reviewRound } : {}),
    incompleteTurnCount: input.submission.verdict === "fail" ? 0 : input.lifecycle.incompleteTurnCount,
    blockedReason:
      input.submission.verdict === "blocked"
        ? `review blocked: ${blockedReasonForVerdict(storedVerdict)}`
        : ceilingReached
          ? `max reviewer failures reached (${reviewRound}/${maxReviewerFailures})`
          : null,
    lastReviewVerdictId: storedVerdict.id,
    reviewVerdicts: [...input.lifecycle.reviewVerdicts, storedVerdict],
    reviewVerdictSubmissions,
  };
  return { verdict: storedVerdict, operations, patch };
}

function acceptedVerdictFromSubmission(
  submission: IssueReviewVerdictSubmissionRecord,
  writebackOperationKeys: string[],
): IssueReviewVerdictRecord {
  return {
    id: submission.id,
    idempotencyKey: submission.idempotencyKey,
    runId: submission.runId,
    issueId: submission.issueId,
    issueIdentifier: submission.issueIdentifier,
    verdict: submission.verdict,
    acceptanceResults: submission.acceptanceResults,
    findings: submission.findings,
    gateFindings: submission.gateFindings,
    discoveryFindings: submission.discoveryFindings,
    evidence: submission.evidence,
    reviewer: submission.reviewer,
    submittedAt: submission.submittedAt,
    writebackOperationKeys,
    supersededAt: null,
    supersededBy: null,
    supersededReason: null,
  };
}

function submissionFromAcceptedVerdict(verdict: IssueReviewVerdictRecord): IssueReviewVerdictSubmissionRecord {
  return {
    id: verdict.id,
    idempotencyKey: verdict.idempotencyKey,
    runId: verdict.runId,
    issueId: verdict.issueId,
    issueIdentifier: verdict.issueIdentifier,
    verdict: verdict.verdict,
    acceptanceResults: verdict.acceptanceResults,
    findings: verdict.findings,
    gateFindings: verdict.gateFindings,
    discoveryFindings: verdict.discoveryFindings,
    evidence: verdict.evidence,
    reviewer: verdict.reviewer,
    submittedAt: verdict.submittedAt,
    status: "applied",
    ignoreStateGate: false,
    appliedAt: verdict.submittedAt,
    acceptedVerdictId: verdict.id,
    supersededAt: verdict.supersededAt ?? null,
    supersededReason: verdict.supersededReason ?? null,
  };
}

export function formatWorkerReviewVerdictPrompt(lifecycle: IssueLifecycleRecord): string | null {
  const verdict = latestReviewVerdict(lifecycle);
  if (!verdict || (verdict.verdict !== "fail" && verdict.verdict !== "blocked")) return null;
  if (isMergeGateVerdict(verdict)) return null;
  const pointers = lifecycle.summaryPointers;
  const latestReport = latestCompletionReport(lifecycle);
  if (verdict.verdict === "blocked") {
    return [
      "",
      "Reviewer blocked findings for recovery triage before another completion report:",
      "Reviewer verdict: blocked / reviewer unable to proceed",
      `Review run: ${verdict.runId}`,
      "",
      "Recovery condition:",
      "- Continue implementation only when triage or operator guidance identifies bounded worker-owned repair or confirms the required validation path is available.",
      "",
      "Lifecycle counters:",
      `- Reviewer failures: ${lifecycle.reviewRound}`,
      `- Incomplete worker turns: ${lifecycle.incompleteTurnCount}`,
      `- Lifecycle phase: ${lifecycle.phase}`,
      `- Blocked reason: ${lifecycle.blockedReason ?? "n/a"}`,
      "",
      "Latest workspace/git evidence:",
      `- Workspace path: ${pointers.workspacePath ?? "n/a"}`,
      `- Branch: ${pointers.gitBranchName ?? pointers.branchName ?? latestReport?.branchName ?? "n/a"}`,
      `- Repository path: ${pointers.repoPath ?? "n/a"}`,
      `- Base ref: ${pointers.baseRef ?? "n/a"}`,
      `- Pull request: ${formatPullRequest(pointers.prNumber, pointers.prUrl)}`,
      "",
      "Blocked findings:",
      ...(verdict.findings.length === 0 ? ["- No blocked findings supplied."] : verdict.findings.map((finding) => `- ${finding}`)),
      "",
      "Acceptance results:",
      ...verdict.acceptanceResults.map(
        (item) => `- ${item.satisfied ? "[x]" : "[ ]"} ${item.text}${item.evidence === null ? "" : ` (${item.evidence})`}`,
      ),
      "",
      "Discovery findings (non-directed context; do not repair unless a current directive explicitly asks for them):",
      ...formatDiscoveryFindingsForWorker(verdict.discoveryFindings),
      "",
      "Evidence:",
      ...verdict.evidence.map((item) => `- ${item}`),
    ].join("\n");
  }
  return [
    "",
    "Reviewer gate findings to address before submitting another completion report:",
    "Reviewer verdict: fail / requested changes",
    `Review run: ${verdict.runId}`,
    "",
    "Lifecycle counters:",
    `- Reviewer failures: ${lifecycle.reviewRound}`,
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
    "Gate findings:",
    ...formatGateFindingsForWorker(verdict),
    "",
    "Discovery findings (non-directed context; do not repair unless a current directive explicitly asks for them):",
    ...formatDiscoveryFindingsForWorker(verdict.discoveryFindings),
    "",
    "Evidence:",
    ...verdict.evidence.map((item) => `- ${item}`),
  ].join("\n");
}

function blockedReasonForVerdict(verdict: IssueReviewVerdictRecord): string {
  const firstFinding = verdict.findings.find((finding) => finding.trim().length > 0);
  if (firstFinding) return firstFinding.length <= 160 ? firstFinding : `${firstFinding.slice(0, 157)}...`;
  const firstDiscovery = verdict.discoveryFindings.find((finding) => finding.summary.trim().length > 0)?.summary;
  if (firstDiscovery) return firstDiscovery.length <= 160 ? firstDiscovery : `${firstDiscovery.slice(0, 157)}...`;
  return "reviewer reported a non-worker-owned blocker";
}

export function formatWorkerMergeGatePrompt(lifecycle: IssueLifecycleRecord): string | null {
  return formatWorkerMergeGatePromptResult(lifecycle)?.text ?? null;
}

export function formatWorkerMergeGatePromptResult(lifecycle: IssueLifecycleRecord): WorkerMergeGatePromptResult | null {
  if (isStaleActiveMergeGate(lifecycle.mergeGate, lifecycle.summaryPointers.prHeadSha, lifecycle.summaryPointers.prNumber)) {
    return { kind: "stale_warning", text: formatWorkerMergeGateHeadAdvancedWarning(lifecycle) };
  }
  if (isCurrentHeadSupersededGate(lifecycle.mergeGate, lifecycle.summaryPointers.prHeadSha, lifecycle.summaryPointers.prNumber)) {
    return { kind: "stale_warning", text: formatWorkerMergeGateHeadAdvancedWarning(lifecycle) };
  }
  const gate = lifecycle.mergeGate;
  if (!gate || (gate.status !== "repair_dispatched" && gate.status !== "blocked")) return null;
  const actionable = gate.checks.filter((check) => check.outcome === "failing" || check.outcome === "missing_actionable");
  const observing = gate.checks.filter((check) => check.outcome === "pending" || check.outcome === "missing_observed" || check.outcome === "unknown");
  const conflict = gate.mergeability?.status === "conflicted";
  const requiredAction = conflict
    ? [
        "This merge-gate repair prompt was not generated from a service-prepared merge-conflict session.",
        "Do not run git fetch, git pull, git merge, git rebase, git commit, git push, gh pr create, gh pr edit, or mutate the lifecycle-bound PR directly; Symphony must own those operations.",
        "A configured merge-conflict state is required before Symphony can dispatch a prepared conflict repair.",
        actionable.length > 0
          ? "Also fix the failing or missing required checks before submitting the completion report."
          : "If mergeability is the only blocker, stop and report that Symphony needs a configured merge-conflict state before a worker can repair this.",
      ].join(" ")
    : [
        "Fix failing checks or restore missing actionable required checks in the assigned worktree, validate the repair, leave the final implementation changes uncommitted and unpushed, and submit a completion report.",
        "Do not run git commit, git push, gh pr create, gh pr edit, or mutate the lifecycle-bound PR directly; Symphony performs service-owned commit, push, and PR publication/reuse after accepting the completion report.",
        "Symphony will re-fetch GitHub checks and PR mergeability before clearing this blocker.",
      ].join(" ");
  return {
    kind: "repair",
    text: [
      "",
      "## Symphony Merge Gate Repair",
      "",
      `Gate ID: ${gate.id}`,
      `Status: ${gate.status}`,
      `PR: ${formatPullRequest(gate.pullRequest.number, gate.pullRequest.url)}`,
      `PR head SHA: ${gate.headSha}`,
      `Branch: ${gate.pullRequest.branch ?? "n/a"}`,
      `Required checks: ${formatList(gate.requiredChecks)}`,
      `Blocker fingerprint: ${gate.blockerFingerprint ?? "n/a"}`,
      `Repair round: ${gate.reviewRound}`,
      `Gate report: ${gate.gateReportId ?? "n/a"}`,
      `Repair report: ${gate.repairReportId ?? "n/a"}`,
      "",
      "Actionable required checks:",
      ...formatMergeGatePromptChecks(actionable, "No actionable checks recorded."),
      "",
      "Awaiting CI / observation:",
      ...formatMergeGatePromptChecks(observing, "No pending, missing-observed, or unknown checks recorded."),
      "",
      "Mergeability:",
      ...formatMergeGatePromptMergeability(gate),
      "",
      "Required action:",
      requiredAction,
    ].join("\n"),
  };
}

function parseReviewVerdict(input: unknown): ReviewVerdictInput {
  const parsed = reviewVerdictSchema.safeParse(input);
  if (!parsed.success) {
    throw new SymphonyError("invalid_request", "Review verdict is invalid", parsed.error.flatten());
  }
  return parsed.data;
}

function normalizeReviewGateFindings(verdict: ReviewVerdictInput): ReviewGateFindingRecord[] {
  if (verdict.gateFindings !== undefined) {
    return verdict.gateFindings.map((finding) => ({
      summary: finding.summary,
      requirementIds: [...finding.requirementIds],
      contractAnchor: finding.contractAnchor,
      scenario: finding.scenario,
      scenarioEntitlement: finding.scenarioEntitlement,
      observedFailure: finding.observedFailure,
      currentIssueOwnership: finding.currentIssueOwnership,
      boundedRepair: finding.boundedRepair,
      evidence: [...finding.evidence],
    }));
  }
  if (verdict.verdict === "blocked") return [];
  return verdict.findings.map((finding) => ({
    summary: finding,
    requirementIds: [],
    contractAnchor: "Legacy unstructured reviewer finding.",
    scenario: "Legacy unstructured reviewer finding.",
    scenarioEntitlement: "necessary_core_behavior",
    observedFailure: finding,
    currentIssueOwnership: "Legacy review verdict accepted before structured gate entitlement was recorded.",
    boundedRepair: finding,
    evidence: verdict.evidence.length === 0 ? ["Legacy review verdict did not include per-finding evidence."] : [...verdict.evidence],
  }));
}

function normalizeReviewDiscoveryFindings(findings: ReviewVerdictInput["discoveryFindings"]): ReviewDiscoveryFindingRecord[] {
  return findings.map((finding) => ({
    summary: finding.summary,
    importance: finding.importance,
    relationship: finding.relationship,
    discoveryReason: finding.discoveryReason,
    suggestedDisposition: finding.suggestedDisposition,
    scenarioAxes: [...finding.scenarioAxes],
    evidence: [...finding.evidence],
    ownerIssueIdentifier: finding.ownerIssueIdentifier ?? null,
  }));
}

function normalizeAcceptanceResults(items: ReviewVerdictInput["acceptanceResults"]): ReviewVerdictAcceptanceResult[] {
  return items.map((item) => ({
    text: item.text,
    satisfied: item.satisfied,
    evidence: item.evidence,
  }));
}

function reviewWritebackContextForSubmission(issue: Issue, submission: IssueReviewVerdictSubmissionRecord) {
  return {
    issue,
    runId: submission.runId,
    reviewer: submission.reviewer,
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
    if (exact && !isSupersededLifecycleRecord(exact)) return exact;
  }
  for (const verdict of lifecycle.reviewVerdicts.slice().reverse()) {
    if (!isSupersededLifecycleRecord(verdict)) return verdict;
  }
  return null;
}

function latestCompletionReport(lifecycle: IssueLifecycleRecord) {
  if (lifecycle.lastCompletionReportId) {
    const exact = lifecycle.completionReports.find((report) => report.id === lifecycle.lastCompletionReportId);
    if (exact) return exact;
  }
  return lifecycle.completionReports[lifecycle.completionReports.length - 1] ?? null;
}

function currentPullRequestForReview(lifecycle: IssueLifecycleRecord): CompletionReportPullRequestRef | null {
  const reportPullRequest = latestCompletionReport(lifecycle)?.pullRequest ?? null;
  if (reportPullRequest?.number !== null && reportPullRequest?.number !== undefined) return reportPullRequest;
  if (lifecycle.summaryPointers.prNumber === null) return null;
  return {
    url: lifecycle.summaryPointers.prUrl,
    number: lifecycle.summaryPointers.prNumber,
    headSha: lifecycle.summaryPointers.prHeadSha,
    branch: lifecycle.summaryPointers.prBranch ?? lifecycle.summaryPointers.gitBranchName,
  };
}

function hasSameRunApprovalFeedback(lifecycle: IssueLifecycleRecord, runId: string): boolean {
  return lifecycle.reviewFeedback.some(
    (feedback) => feedback.runId === runId && feedback.kind === "review" && feedback.event === "APPROVE",
  );
}

function hasSameRunApprovalFeedbackForPullRequest(
  lifecycle: IssueLifecycleRecord,
  runId: string,
  pullRequest: CompletionReportPullRequestRef,
): boolean {
  return lifecycle.reviewFeedback.some(
    (feedback) =>
      feedback.runId === runId &&
      feedback.kind === "review" &&
      feedback.event === "APPROVE" &&
      samePullRequest(feedback.pullRequest, pullRequest),
  );
}

function samePullRequest(
  feedbackPullRequest: CompletionReportPullRequestRef,
  currentPullRequest: CompletionReportPullRequestRef,
): boolean {
  return (
    feedbackPullRequest.number === currentPullRequest.number &&
    feedbackPullRequest.url === currentPullRequest.url &&
    feedbackPullRequest.headSha !== null &&
    currentPullRequest.headSha !== null &&
    feedbackPullRequest.headSha === currentPullRequest.headSha
  );
}

function isCurrentHeadSupersededGate(
  gate: IssueMergeGateState | null | undefined,
  currentHeadSha: string | null | undefined,
  pullRequestNumber: number | null | undefined,
): boolean {
  return (
    gate !== null &&
    gate !== undefined &&
    gate.status === "superseded" &&
    typeof currentHeadSha === "string" &&
    currentHeadSha.length > 0 &&
    pullRequestNumber !== null &&
    pullRequestNumber !== undefined &&
    gate.pullRequest.number === pullRequestNumber &&
    gate.supersededByHeadSha === currentHeadSha
  );
}

function isStaleActiveMergeGate(
  gate: IssueMergeGateState | null | undefined,
  currentHeadSha: string | null | undefined,
  pullRequestNumber: number | null | undefined,
): boolean {
  return shouldSilentlyRetireMergeGate(gate, currentHeadSha, pullRequestNumber);
}

function formatPullRequest(number: number | null, url: string | null): string {
  const parts = [number === null ? null : `#${number}`, url].filter((value): value is string => value !== null);
  return parts.length === 0 ? "n/a" : parts.join(" ");
}

function formatList(values: string[]): string {
  return values.length === 0 ? "n/a" : values.join(", ");
}

function formatWorkerMergeGateHeadAdvancedWarning(lifecycle: IssueLifecycleRecord): string {
  const pointers = lifecycle.summaryPointers;
  return [
    "",
    "## Symphony Merge Gate Head Advanced",
    "",
    "A previous merge-gate blocker was recorded for an older PR head. The lifecycle-bound PR now points at a newer head, so this worker turn should proceed through the normal completion and review path for the current head.",
    "",
    `Current PR: ${formatPullRequest(pointers.prNumber, pointers.prUrl)}`,
    `Current PR head SHA: ${pointers.prHeadSha ?? "n/a"}`,
    `Current branch: ${pointers.prBranch ?? pointers.gitBranchName ?? pointers.branchName ?? "n/a"}`,
    "",
    "Required action:",
    "Address any current reviewer findings, validate the current PR head, and submit a fresh completion report. Symphony will require normal review approval for this head before merge.",
  ].join("\n");
}

function formatMergeGatePromptChecks(checks: NonNullable<IssueLifecycleRecord["mergeGate"]>["checks"], fallback: string): string[] {
  if (checks.length === 0) return [`- ${fallback}`];
  return checks.map((check) => {
    const conclusion = check.conclusion === null ? "" : ` / ${check.conclusion}`;
    const url = check.url === null ? "" : ` (${check.url})`;
    return `- ${check.name}: ${check.outcome}${conclusion}${url}${formatMissingCheckStabilization(check)}`;
  });
}

function formatMergeGatePromptMergeability(gate: IssueMergeGateState): string[] {
  const mergeability = gate.mergeability;
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

function formatMissingCheckStabilization(check: IssueMergeGateState["checks"][number]): string {
  if (check.rawStatus !== "missing" && check.outcome !== "missing_observed" && check.outcome !== "missing_actionable") {
    return "";
  }
  return `; firstObservedAt: ${check.firstObservedAt ?? "n/a"}; actionableSince: ${check.actionableSince ?? "n/a"}`;
}

function formatAcceptanceGaps(results: ReviewVerdictAcceptanceResult[]): string[] {
  const gaps = results.filter((item) => !item.satisfied);
  if (gaps.length === 0) return ["- No explicit acceptance criteria gaps were recorded."];
  return gaps.map((item) => `- ${item.text}${item.evidence === null ? "" : ` (${item.evidence})`}`);
}

function formatGateFindingsForWorker(verdict: IssueReviewVerdictRecord): string[] {
  const findings =
    verdict.gateFindings.length > 0
      ? verdict.gateFindings
      : legacyGateFindingsFromFindings(verdict.findings, verdict.evidence);
  if (findings.length === 0) return ["- No structured gate findings were recorded."];
  return findings.flatMap((finding, index) => [
    `- ${index + 1}. ${finding.summary}`,
    `  Requirement IDs: ${finding.requirementIds.length === 0 ? "n/a" : finding.requirementIds.join(", ")}`,
    `  Contract anchor: ${finding.contractAnchor}`,
    `  Scenario: ${finding.scenario}`,
    `  Entitlement: ${finding.scenarioEntitlement}`,
    `  Observed failure: ${finding.observedFailure}`,
    `  Current-issue ownership: ${finding.currentIssueOwnership}`,
    `  Bounded repair: ${finding.boundedRepair}`,
    `  Evidence: ${finding.evidence.join(" | ")}`,
  ]);
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

function formatDiscoveryFindingsForWorker(findings: ReviewDiscoveryFindingRecord[]): string[] {
  if (findings.length === 0) return ["- None recorded."];
  return findings.flatMap((finding, index) => [
    `- ${index + 1}. ${finding.summary}`,
    `  Importance: ${finding.importance}`,
    `  Relationship: ${finding.relationship}`,
    `  Suggested disposition: ${finding.suggestedDisposition}`,
    `  Scenario axes: ${finding.scenarioAxes.length === 0 ? "n/a" : finding.scenarioAxes.join(", ")}`,
    `  Discovery reason: ${finding.discoveryReason}`,
    `  Owner issue: ${finding.ownerIssueIdentifier ?? "n/a"}`,
  ]);
}

function sameStateIn(state: string, states: string[]): boolean {
  return states.some((candidate) => candidate.toLowerCase() === state.toLowerCase());
}

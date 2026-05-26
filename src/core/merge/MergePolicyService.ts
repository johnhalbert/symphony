import {
  createGitHubPullRequestClientForCapability,
  resolveGitHubClientConfig,
} from "../../integrations/github/GitHubCredentialResolver.js";
import { resolveLinearClientConfig } from "../../integrations/linear/LinearCredentialResolver.js";
import type {
  PullRequestCheckResult,
  PullRequestDetails,
  PullRequestMergeInput,
  PullRequestMergeResult,
} from "../../integrations/github/GitHubPullRequestClient.js";
import type { ServiceConfig } from "../config/Config.js";
import type { ResolvedCredential } from "../config/CredentialProfiles.js";
import { SymphonyError } from "../errors.js";
import type { Logger } from "../logging/StructuredLogger.js";
import type {
  CompletionReportPullRequestRef,
  IssueCompletionReportRecord,
  IssueLifecycleRecord,
  IssueLifecycleStore,
  IssueMergeConflictMetadata,
  IssueMergeMetadata,
  IssueReviewVerdictRecord,
} from "../persistence/IssueLifecycleStore.js";
import type { RunRecord, RunTranscriptStore } from "../persistence/RunTranscriptStore.js";
import type { TrackerClient } from "../tracker/TrackerClient.js";
import type { Issue } from "../types.js";
import { planMergeCompletedWritebacks, planMergeConflictsWritebacks } from "../writeback/TransitionPolicy.js";
import type { WritebackOperation, WritebackProcessor } from "../writeback/WritebackOutbox.js";

export interface MergePolicyGitHubClient {
  getPullRequest(input: { pullRequestNumber: number }): Promise<PullRequestDetails>;
  getRequiredCheckResults(input: { headSha: string; requiredChecks: string[] }): Promise<PullRequestCheckResult[]>;
  mergePullRequest(input: PullRequestMergeInput): Promise<PullRequestMergeResult>;
  getAuthenticatedLogin(): Promise<string | null>;
  isAncestor(input: { ancestorSha: string; descendantSha: string }): Promise<boolean>;
}

export type MergePolicyResult =
  | { status: "skipped"; reason: string }
  | { status: "merged"; merge: IssueMergeMetadata }
  | { status: "already_merged"; merge: IssueMergeMetadata }
  | { status: "blocked_conflicts"; headSha: string; mergeableState: string | null };

export interface MergePolicyServiceOptions {
  config: ServiceConfig;
  tracker: TrackerClient;
  lifecycleStore: IssueLifecycleStore;
  runStore?: RunTranscriptStore;
  writeback?: WritebackProcessor;
  client?: MergePolicyGitHubClient;
  logger?: Logger;
}

export class MergePolicyService {
  constructor(private readonly options: MergePolicyServiceOptions) {}

  async reconcileIssue(issue: Issue): Promise<MergePolicyResult> {
    const config = this.options.config;
    if (config.mergePolicy.mode !== "gated") return { status: "skipped", reason: "merge policy is not gated" };
    if (!config.writeback.enabled || config.writeback.mode !== "live" || !this.options.writeback) {
      throw new SymphonyError("invalid_request", "Gated merge policy requires service-owned writeback");
    }

    const serviceLinear = resolveLinearClientConfig(config, "linear.writeback").credential;
    if (!serviceLinear) {
      throw new SymphonyError("invalid_request", "Gated merge policy requires service linear.writeback credentials");
    }
    const serviceMerge = resolveGitHubClientConfig(config, "github.merge").credential;
    if (!serviceMerge) {
      throw new SymphonyError("invalid_request", "Gated merge policy requires service github.merge credentials");
    }

    const latestIssue = (await this.options.tracker.fetchIssueStatesByIds([issue.id]))[0] ?? issue;
    const lifecycle = await this.options.lifecycleStore.get(issue.id);
    if (!lifecycle) throw new SymphonyError("invalid_request", "Gated merge policy requires an issue lifecycle record");

    if (lifecycle.merge?.mergeCommitSha) {
      if (statesEqual(latestIssue.state, config.mergePolicy.doneState)) {
        return { status: "already_merged", merge: lifecycle.merge };
      }
      const recoverySourceState = this.mergeSourceState(latestIssue, lifecycle);
      if (recoverySourceState === null) {
        throw new SymphonyError("invalid_request", "Gated merge Done recovery requires issue in Done or a merge source state");
      }
      await this.ensureDoneTransition(latestIssue, lifecycle.merge, recoverySourceState);
      return { status: "already_merged", merge: lifecycle.merge };
    }

    const sourceState = this.mergeSourceState(latestIssue, lifecycle);
    if (sourceState === null) return { status: "skipped", reason: `issue is not in a merge source state: ${latestIssue.state}` };

    const report = latestCompletionReport(lifecycle);
    const verdict = latestReviewVerdict(lifecycle);
    const workerRun = report && this.options.runStore ? await this.options.runStore.getRun(report.runId) : null;
    this.validateLifecycle(lifecycle, report, verdict, workerRun, latestIssue);
    if (!report) throw new SymphonyError("invalid_request", "Gated merge requires a latest completion report");

    const approvedPullRequest = requirePullRequest(report);
    const approvedHeadSha = requireValue(approvedPullRequest.headSha, "Completion report pull request head SHA is required for gated merge");
    const resolvedConflict = resolvedMergeConflictForIssue(latestIssue, lifecycle, config);
    const pullRequest = resolvedConflict ? pullRequestRefForResolvedConflict(resolvedConflict) : approvedPullRequest;
    const headSha = requireValue(pullRequest.headSha, "Completion report pull request head SHA is required for gated merge");
    const github = this.options.client ?? createGitHubPullRequestClientForCapability(config, "github.merge");
    const livePullRequest = await github.getPullRequest({ pullRequestNumber: requireNumber(pullRequest.number) });
    validateLivePullRequestMetadata(livePullRequest, pullRequest, headSha);
    if (resolvedConflict) {
      await validateConflictApprovalCarryForward(github, resolvedConflict, approvedPullRequest, approvedHeadSha, headSha);
    }

    const mergeId = `merge:${latestIssue.id}:${headSha}`;
    let status: "merged" | "already_merged" = "merged";
    let mergeResult: PullRequestMergeResult;
    if (isOpenPullRequest(livePullRequest)) {
      const mergeability = classifyMergeability(livePullRequest);
      if (mergeability.kind === "unknown") {
        return { status: "skipped", reason: "pull request mergeability is still being computed" };
      }
      if (mergeability.kind === "conflicts") {
        await this.ensureConflictsTransition(
          latestIssue,
          lifecycle,
          pullRequest,
          headSha,
          sourceState,
          mergeability.reason,
          livePullRequest.mergeableState,
        );
        return { status: "blocked_conflicts", headSha, mergeableState: livePullRequest.mergeableState };
      }
      if (mergeability.kind === "blocked") {
        throw new SymphonyError("invalid_request", mergeability.reason);
      }
      const checkStatus = await this.validateChecks(github, headSha);
      const doneTransition = this.planDoneTransition(latestIssue, mergeId, sourceState);
      mergeResult = await github.mergePullRequest({
        pullRequestNumber: requireNumber(pullRequest.number),
        expectedHeadSha: headSha,
        method: config.mergePolicy.mergeMethod,
      });
      const merge = buildMergeMetadata(latestIssue, pullRequest, headSha, mergeResult, serviceMerge, checkStatus, doneTransition.idempotencyKey);
      const updated = await this.options.lifecycleStore.updateIssue(latestIssue, { merge });
      const storedMerge = updated.merge ?? merge;
      await this.ensureDoneTransition(latestIssue, storedMerge, sourceState);
      return { status, merge: storedMerge };
    } else {
      const checkStatus = await this.validateChecks(github, headSha);
      const doneTransition = this.planDoneTransition(latestIssue, mergeId, sourceState);
      const serviceLogin = await github.getAuthenticatedLogin();
      mergeResult = recoverAlreadyMergedPullRequest(livePullRequest, serviceLogin);
      status = "already_merged";
      const merge = buildMergeMetadata(latestIssue, pullRequest, headSha, mergeResult, serviceMerge, checkStatus, doneTransition.idempotencyKey);
      const updated = await this.options.lifecycleStore.updateIssue(latestIssue, { merge });
      const storedMerge = updated.merge ?? merge;
      await this.ensureDoneTransition(latestIssue, storedMerge, sourceState);
      return { status, merge: storedMerge };
    }
  }

  private async ensureDoneTransition(issue: Issue, merge: IssueMergeMetadata, sourceState: string): Promise<void> {
    if (statesEqual(issue.state, this.options.config.mergePolicy.doneState)) return;
    const operation = this.planDoneTransition(issue, merge.id, sourceState);
    if (operation.idempotencyKey !== merge.doneTransitionOperationKey) {
      throw new SymphonyError("invalid_request", "Gated merge Done writeback key does not match lifecycle merge metadata");
    }
    await this.requireDoneWritebackSucceeded(issue, operation);
  }

  private async requireDoneWritebackSucceeded(issue: Issue, operation: Parameters<WritebackProcessor["enqueueAndProcess"]>[0]): Promise<void> {
    const writeback = this.options.writeback;
    if (!writeback) throw new SymphonyError("invalid_request", "Gated merge policy requires service-owned writeback");
    const result: WritebackOperation = await writeback.enqueueAndProcess(operation, { retrySkipped: true });
    if (result.status !== "succeeded") {
      throw new SymphonyError(
        "invalid_request",
        `Gated merge Done writeback did not succeed: ${result.status}${result.lastError ? ` (${result.lastError})` : ""}`,
      );
    }
    const latest = (await this.options.tracker.fetchIssueStatesByIds([issue.id]))[0] ?? null;
    if (!latest || !statesEqual(latest.state, this.options.config.mergePolicy.doneState)) {
      throw new SymphonyError("invalid_request", "Gated merge Done writeback could not be verified");
    }
  }

  private planDoneTransition(issue: Issue, mergeId: string, sourceState: string): Parameters<WritebackProcessor["enqueueAndProcess"]>[0] {
    const operation = planMergeCompletedWritebacks(
      {
        issue,
        mergeId,
        fromState: sourceState,
        doneState: this.options.config.mergePolicy.doneState,
      },
      this.options.config,
    )[0];
    if (!operation) throw new SymphonyError("invalid_request", "Gated merge policy could not plan Done writeback");
    return operation;
  }

  private mergeSourceState(issue: Issue, lifecycle: IssueLifecycleRecord | null = null): string | null {
    const sourceState = this.options.config.mergePolicy.sourceStates.find((state) => statesEqual(state, issue.state)) ?? null;
    if (sourceState !== null) return sourceState;
    const conflictsState = this.options.config.mergePolicy.conflictsState;
    if (
      conflictsState !== null &&
      statesEqual(issue.state, conflictsState) &&
      lifecycle?.mergeConflict?.resolutionStatus === "resolved"
    ) {
      return conflictsState;
    }
    return null;
  }

  private async ensureConflictsTransition(
    issue: Issue,
    lifecycle: IssueLifecycleRecord,
    pullRequest: CompletionReportPullRequestRef,
    headSha: string,
    sourceState: string,
    reason: string,
    mergeableState: string | null,
  ): Promise<void> {
    const conflictsState = this.options.config.mergePolicy.conflictsState;
    if (conflictsState === null) {
      throw new SymphonyError(
        "invalid_request",
        `${reason}; configure merge_policy.conflicts_state to route approved-but-conflicting pull requests to a fix state`,
      );
    }
    const writeback = this.options.writeback;
    if (!writeback) throw new SymphonyError("invalid_request", "Gated merge conflicts transition requires service-owned writeback");
    const operations = planMergeConflictsWritebacks(
      {
        issue,
        mergeId: `merge:${issue.id}:${headSha}`,
        fromState: sourceState,
        conflictsState,
        pullRequest,
        mergeableState,
        reason,
      },
      this.options.config,
    );
    for (const operation of operations) {
      const result = await writeback.enqueueAndProcess(operation, { retrySkipped: true });
      if (operation.kind === "transition" && result.status !== "succeeded") {
        throw new SymphonyError(
          "invalid_request",
          `Gated merge conflicts writeback did not succeed: ${result.status}${result.lastError ? ` (${result.lastError})` : ""}`,
        );
      }
    }
    const latest = (await this.options.tracker.fetchIssueStatesByIds([issue.id]))[0] ?? null;
    if (!latest || !statesEqual(latest.state, conflictsState)) {
      throw new SymphonyError("invalid_request", "Gated merge conflicts writeback could not be verified");
    }
    await this.options.lifecycleStore.updateIssue(latest, {
      phase: "merge_conflict_resolution",
      blockedReason: null,
      mergeConflict: buildMergeConflictMetadata({
        config: this.options.config,
        lifecycle,
        issue,
        pullRequest,
        headSha,
        sourceState,
        conflictsState,
        reason,
        mergeableState,
        writebackOperationKeys: operations.map((operation) => operation.idempotencyKey),
      }),
      summaryPointers: {
        prUrl: pullRequest.url,
        prNumber: pullRequest.number,
        prHeadSha: headSha,
        prBranch: pullRequest.branch ?? null,
      },
    });
  }

  private validateLifecycle(
    lifecycle: IssueLifecycleRecord,
    report: IssueCompletionReportRecord | null,
    verdict: IssueReviewVerdictRecord | null,
    workerRun: RunRecord | null,
    issue: Issue,
  ): void {
    if (lifecycle.phase !== "passed") throw new SymphonyError("invalid_request", "Gated merge requires passed lifecycle phase");
    if (!report) throw new SymphonyError("invalid_request", "Gated merge requires a latest completion report");
    if (!verdict || verdict.verdict !== "pass") throw new SymphonyError("invalid_request", "Gated merge requires a pass verdict");
    if (report.issueId !== issue.id || verdict.issueId !== issue.id) {
      throw new SymphonyError("invalid_request", "Gated merge issue metadata does not match lifecycle records");
    }
    if (verdict.evidence.length === 0 || verdict.acceptanceResults.some((item) => !item.satisfied)) {
      throw new SymphonyError("invalid_request", "Gated merge requires satisfied review acceptance results and evidence");
    }
    if (!workerRun) throw new SymphonyError("invalid_request", "Gated merge requires worker run metadata");
    validateRunMetadata(report, workerRun, lifecycle);
    validateApprovalFeedback(lifecycle, verdict, requirePullRequest(report));
  }

  private async validateChecks(
    github: MergePolicyGitHubClient,
    headSha: string,
  ): Promise<IssueMergeMetadata["checkStatus"]> {
    const { requiredChecks, noCiAllowed, noCiEvidence } = this.options.config.mergePolicy;
    if (requiredChecks.length === 0) {
      if (!noCiAllowed || noCiEvidence === null) {
        throw new SymphonyError("invalid_request", "Gated merge requires configured checks or explicit no-CI evidence");
      }
      return { requiredChecks: [], passedChecks: [], noCiEvidence };
    }
    const checks = await github.getRequiredCheckResults({ headSha, requiredChecks });
    const failed = requiredChecks.filter(
      (requiredCheck) => !checks.some((check) => check.name === requiredCheck && check.status === "success"),
    );
    if (failed.length > 0) {
      throw new SymphonyError("invalid_request", `Required checks are not passing: ${failed.join(", ")}`);
    }
    return { requiredChecks, passedChecks: requiredChecks, noCiEvidence: null };
  }
}

function latestCompletionReport(lifecycle: IssueLifecycleRecord): IssueCompletionReportRecord | null {
  if (lifecycle.lastCompletionReportId) {
    const exact = lifecycle.completionReports.find((report) => report.id === lifecycle.lastCompletionReportId);
    if (exact) return exact;
  }
  return lifecycle.completionReports[lifecycle.completionReports.length - 1] ?? null;
}

function latestReviewVerdict(lifecycle: IssueLifecycleRecord): IssueReviewVerdictRecord | null {
  if (lifecycle.lastReviewVerdictId) {
    const exact = lifecycle.reviewVerdicts.find((verdict) => verdict.id === lifecycle.lastReviewVerdictId);
    if (exact) return exact;
  }
  return lifecycle.reviewVerdicts[lifecycle.reviewVerdicts.length - 1] ?? null;
}

function validateRunMetadata(
  report: IssueCompletionReportRecord,
  run: RunRecord,
  lifecycle: IssueLifecycleRecord,
): void {
  const pullRequest = requirePullRequest(report);
  requireMatches("worker run issue", run.issueId, report.issueId);
  requireMatches("worker run PR number", run.prNumber, pullRequest.number);
  requireMatches("worker run PR URL", run.prUrl, pullRequest.url);
  requireMatches("worker run PR head SHA", run.prHeadSha, pullRequest.headSha);
  requireMatches("worker run PR branch", run.prBranch, pullRequest.branch);
  requireMatches("lifecycle PR number", lifecycle.summaryPointers.prNumber, pullRequest.number);
  requireMatches("lifecycle PR URL", lifecycle.summaryPointers.prUrl, pullRequest.url);
  requireMatches("lifecycle PR head SHA", lifecycle.summaryPointers.prHeadSha, pullRequest.headSha);
  requireMatches("lifecycle PR branch", lifecycle.summaryPointers.prBranch, pullRequest.branch);
}

function validateApprovalFeedback(
  lifecycle: IssueLifecycleRecord,
  verdict: IssueReviewVerdictRecord,
  pullRequest: CompletionReportPullRequestRef,
): void {
  const approval = lifecycle.reviewFeedback.find(
    (feedback) =>
      feedback.runId === verdict.runId &&
      feedback.kind === "review" &&
      feedback.event === "APPROVE" &&
      feedback.pullRequest.number === pullRequest.number &&
      feedback.pullRequest.url === pullRequest.url &&
      feedback.pullRequest.headSha === pullRequest.headSha,
  );
  if (!approval) {
    throw new SymphonyError("invalid_request", "Gated merge requires service-recorded APPROVE PR review feedback");
  }
}

function resolvedMergeConflictForIssue(
  issue: Issue,
  lifecycle: IssueLifecycleRecord,
  config: ServiceConfig,
): IssueMergeConflictMetadata | null {
  const conflictsState = config.mergePolicy.conflictsState;
  if (
    conflictsState === null ||
    !statesEqual(issue.state, conflictsState) ||
    lifecycle.mergeConflict?.resolutionStatus !== "resolved"
  ) {
    return null;
  }
  return lifecycle.mergeConflict;
}

function pullRequestRefForResolvedConflict(mergeConflict: IssueMergeConflictMetadata): CompletionReportPullRequestRef {
  const resolvedHeadSha = requireValue(
    mergeConflict.resolvedHeadSha,
    "Resolved merge conflict metadata requires a pull request head SHA",
  );
  return {
    ...mergeConflict.pullRequest,
    headSha: resolvedHeadSha,
  };
}

async function validateConflictApprovalCarryForward(
  github: MergePolicyGitHubClient,
  mergeConflict: IssueMergeConflictMetadata,
  approvedPullRequest: CompletionReportPullRequestRef,
  approvedHeadSha: string,
  resolvedHeadSha: string,
): Promise<void> {
  requireMatches("merge conflict PR number", mergeConflict.pullRequest.number, approvedPullRequest.number);
  requireMatches("merge conflict PR URL", mergeConflict.pullRequest.url, approvedPullRequest.url);
  requireMatches("merge conflict PR branch", mergeConflict.pullRequest.branch, approvedPullRequest.branch);
  if (mergeConflict.approvedHeadSha !== approvedHeadSha) {
    throw new SymphonyError("invalid_request", "Merge conflict approved head does not match review approval metadata");
  }
  const approvedHeadIsAncestor = await github.isAncestor({ ancestorSha: approvedHeadSha, descendantSha: resolvedHeadSha });
  if (!approvedHeadIsAncestor) {
    throw new SymphonyError(
      "invalid_request",
      "Resolved merge conflict head does not descend from the approved head; approval cannot be carried forward",
    );
  }
}

function buildMergeConflictMetadata(input: {
  config: ServiceConfig;
  lifecycle: IssueLifecycleRecord;
  issue: Issue;
  pullRequest: CompletionReportPullRequestRef;
  headSha: string;
  sourceState: string;
  conflictsState: string;
  reason: string;
  mergeableState: string | null;
  writebackOperationKeys: string[];
}): IssueMergeConflictMetadata {
  const existing = input.lifecycle.mergeConflict;
  const now = new Date().toISOString();
  const id = existing?.id ?? `merge-conflict:${input.issue.id}:${input.headSha}`;
  return {
    id,
    status: "open",
    resolutionStatus: "pending",
    pullRequest: { ...input.pullRequest, headSha: input.headSha },
    approvedHeadSha: input.headSha,
    currentHeadSha: input.headSha,
    resolvedHeadSha: null,
    sourceState: input.sourceState,
    conflictsState: input.conflictsState,
    reason: input.reason,
    mergeableState: input.mergeableState,
    detectedAt: existing?.detectedAt ?? now,
    updatedAt: now,
    fixTurnCount: existing?.fixTurnCount ?? 0,
    maxFixTurns: input.config.mergePolicy.maxConflictFixTurns,
    lastConflictFixRunId: existing?.lastConflictFixRunId ?? null,
    lastConflictResolutionReportId: existing?.lastConflictResolutionReportId ?? null,
    attemptRunIds: existing?.attemptRunIds ?? [],
    writebackOperationKeys: input.writebackOperationKeys,
    blockedAt: null,
    blockedReason: null,
  };
}

function validateLivePullRequestMetadata(
  livePullRequest: PullRequestDetails,
  expected: CompletionReportPullRequestRef,
  expectedHeadSha: string,
): void {
  requireMatches("live PR number", livePullRequest.number, expected.number);
  requireMatches("live PR URL", livePullRequest.url, expected.url);
  requireMatches("live PR branch", livePullRequest.headBranch, expected.branch);
  requireMatches("live PR head SHA", livePullRequest.headSha, expectedHeadSha);
}

function isOpenPullRequest(livePullRequest: PullRequestDetails): boolean {
  return livePullRequest.state === null || livePullRequest.state.toLowerCase() === "open";
}

function classifyMergeability(
  livePullRequest: PullRequestDetails,
): { kind: "mergeable" } | { kind: "conflicts"; reason: string } | { kind: "unknown" } | { kind: "blocked"; reason: string } {
  const mergeableState = livePullRequest.mergeableState?.toLowerCase() ?? null;
  if (livePullRequest.mergeable === null || mergeableState === "unknown") return { kind: "unknown" };
  if (livePullRequest.mergeable === true) return { kind: "mergeable" };
  if (mergeableState === "dirty") {
    return { kind: "conflicts", reason: "Pull request has merge conflicts with the base branch" };
  }
  const stateDescription = mergeableState === null ? "unknown" : mergeableState;
  return { kind: "blocked", reason: `Pull request is not currently mergeable: ${stateDescription}` };
}

function recoverAlreadyMergedPullRequest(
  livePullRequest: PullRequestDetails,
  serviceLogin: string | null,
): PullRequestMergeResult {
  if (livePullRequest.merged !== true) {
    throw new SymphonyError("invalid_request", "Gated merge recovery requires an already-merged pull request");
  }
  if (serviceLogin === null || livePullRequest.mergedBy !== serviceLogin) {
    throw new SymphonyError("invalid_request", "Gated merge recovery requires a service-merged pull request");
  }
  if (!livePullRequest.mergeCommitSha || !livePullRequest.mergedAt) {
    throw new SymphonyError("invalid_request", "Gated merge recovery requires GitHub merge metadata");
  }
  return {
    merged: true,
    mergeCommitSha: livePullRequest.mergeCommitSha,
    mergedAt: livePullRequest.mergedAt,
    mergedBy: livePullRequest.mergedBy,
  };
}

function buildMergeMetadata(
  issue: Issue,
  pullRequest: CompletionReportPullRequestRef,
  headSha: string,
  mergeResult: PullRequestMergeResult,
  serviceMerge: ResolvedCredential,
  checkStatus: IssueMergeMetadata["checkStatus"],
  doneTransitionOperationKey: string,
): IssueMergeMetadata {
  return {
    id: `merge:${issue.id}:${headSha}`,
    pullRequest,
    headSha,
    mergeCommitSha: mergeResult.mergeCommitSha,
    mergedAt: mergeResult.mergedAt,
    mergedBy: {
      login: mergeResult.mergedBy,
      profile: serviceMerge.profileName,
      capability: "github.merge",
    },
    checkStatus,
    mergeOperationKey: `github-merge:${issue.id}:${requireNumber(pullRequest.number)}:${headSha}`,
    doneTransitionOperationKey,
  };
}

function requirePullRequest(report: IssueCompletionReportRecord): CompletionReportPullRequestRef {
  if (!report.pullRequest) throw new SymphonyError("invalid_request", "Gated merge requires a lifecycle-bound pull request");
  requireNumber(report.pullRequest.number);
  requireValue(report.pullRequest.url, "Gated merge requires a pull request URL");
  requireValue(report.pullRequest.branch, "Gated merge requires a pull request branch");
  requireValue(report.pullRequest.headSha, "Gated merge requires a pull request head SHA");
  return report.pullRequest;
}

function requireMatches(label: string, actual: string | number | null | undefined, expected: string | number | null | undefined): void {
  if (actual === expected) return;
  throw new SymphonyError("invalid_request", `${label} does not match gated merge metadata`);
}

function requireValue(value: string | null | undefined, message: string): string {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) throw new SymphonyError("invalid_request", message);
  return trimmed;
}

function requireNumber(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new SymphonyError("invalid_request", "Gated merge requires a valid pull request number");
  }
  return value;
}

function statesEqual(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

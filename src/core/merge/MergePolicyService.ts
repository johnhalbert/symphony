import { createGitHubPullRequestClientForCapability } from "../../integrations/github/GitHubCredentialResolver.js";
import type {
  PullRequestCheckResult,
  PullRequestDetails,
  PullRequestMergeInput,
  PullRequestMergeResult,
} from "../../integrations/github/GitHubPullRequestClient.js";
import type { ServiceConfig } from "../config/Config.js";
import { SymphonyError } from "../errors.js";
import type { Logger } from "../logging/StructuredLogger.js";
import type {
  CompletionReportPullRequestRef,
  IssueCompletionReportRecord,
  IssueLifecycleRecord,
  IssueLifecycleStore,
  IssueMergeMetadata,
  IssueReviewVerdictRecord,
} from "../persistence/IssueLifecycleStore.js";
import type { RunRecord, RunTranscriptStore } from "../persistence/RunTranscriptStore.js";
import type { TrackerClient } from "../tracker/TrackerClient.js";
import type { Issue } from "../types.js";
import { planMergeCompletedWritebacks } from "../writeback/TransitionPolicy.js";
import type { WritebackProcessor } from "../writeback/WritebackOutbox.js";

export interface MergePolicyGitHubClient {
  getPullRequest(input: { pullRequestNumber: number }): Promise<PullRequestDetails>;
  getRequiredCheckResults(input: { headSha: string; requiredChecks: string[] }): Promise<PullRequestCheckResult[]>;
  mergePullRequest(input: PullRequestMergeInput): Promise<PullRequestMergeResult>;
}

export type MergePolicyResult =
  | { status: "skipped"; reason: string }
  | { status: "merged"; merge: IssueMergeMetadata }
  | { status: "already_merged"; merge: IssueMergeMetadata };

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
    if (!config.writeback.enabled || !this.options.writeback) {
      throw new SymphonyError("invalid_request", "Gated merge policy requires service-owned writeback");
    }

    const serviceLinear = config.credentialProfiles.resolveForRole("service", "linear.writeback");
    if (!serviceLinear) {
      throw new SymphonyError("invalid_request", "Gated merge policy requires service linear.writeback credentials");
    }

    const latestIssue = (await this.options.tracker.fetchIssueStatesByIds([issue.id]))[0] ?? issue;
    const sourceState = config.mergePolicy.sourceStates.find((state) => statesEqual(state, latestIssue.state)) ?? null;
    if (sourceState === null) return { status: "skipped", reason: `issue is not in a merge source state: ${latestIssue.state}` };

    const lifecycle = await this.options.lifecycleStore.get(issue.id);
    if (!lifecycle) throw new SymphonyError("invalid_request", "Gated merge policy requires an issue lifecycle record");

    if (lifecycle.merge?.mergeCommitSha) {
      await this.ensureDoneTransition(latestIssue, lifecycle.merge, sourceState);
      return { status: "already_merged", merge: lifecycle.merge };
    }

    const report = latestCompletionReport(lifecycle);
    const verdict = latestReviewVerdict(lifecycle);
    const workerRun = report && this.options.runStore ? await this.options.runStore.getRun(report.runId) : null;
    this.validateLifecycle(lifecycle, report, verdict, workerRun, latestIssue);
    if (!report) throw new SymphonyError("invalid_request", "Gated merge requires a latest completion report");

    const pullRequest = requirePullRequest(report);
    const headSha = requireValue(pullRequest.headSha, "Completion report pull request head SHA is required for gated merge");
    const github = this.options.client ?? createGitHubPullRequestClientForCapability(config, "github.merge");
    const livePullRequest = await github.getPullRequest({ pullRequestNumber: requireNumber(pullRequest.number) });
    validateLivePullRequest(livePullRequest, pullRequest, headSha);

    const checkStatus = await this.validateChecks(github, headSha);
    const serviceMerge = config.credentialProfiles.resolveForRole("service", "github.merge");
    if (!serviceMerge) {
      throw new SymphonyError("invalid_request", "Gated merge policy requires service github.merge credentials");
    }

    const mergeResult = await github.mergePullRequest({
      pullRequestNumber: requireNumber(pullRequest.number),
      expectedHeadSha: headSha,
      method: config.mergePolicy.mergeMethod,
    });
    const mergeId = `merge:${latestIssue.id}:${headSha}`;
    const doneTransition = planMergeCompletedWritebacks(
      {
        issue: latestIssue,
        mergeId,
        fromState: sourceState,
        doneState: config.mergePolicy.doneState,
      },
      config,
    )[0];
    if (!doneTransition) throw new SymphonyError("invalid_request", "Gated merge policy could not plan Done writeback");

    const merge: IssueMergeMetadata = {
      id: mergeId,
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
      mergeOperationKey: `github-merge:${latestIssue.id}:${requireNumber(pullRequest.number)}:${headSha}`,
      doneTransitionOperationKey: doneTransition.idempotencyKey,
    };

    const updated = await this.options.lifecycleStore.updateIssue(latestIssue, { merge });
    const storedMerge = updated.merge ?? merge;
    await this.options.writeback.enqueueAndProcess(doneTransition);
    return { status: "merged", merge: storedMerge };
  }

  private async ensureDoneTransition(issue: Issue, merge: IssueMergeMetadata, sourceState: string): Promise<void> {
    const operation = planMergeCompletedWritebacks(
      {
        issue,
        mergeId: merge.id,
        fromState: sourceState,
        doneState: this.options.config.mergePolicy.doneState,
      },
      this.options.config,
    )[0];
    if (operation) await this.options.writeback?.enqueueAndProcess(operation);
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
    const failed = checks.filter((check) => check.status !== "success");
    if (failed.length > 0) {
      throw new SymphonyError("invalid_request", `Required checks are not passing: ${failed.map((check) => check.name).join(", ")}`);
    }
    return { requiredChecks, passedChecks: checks.map((check) => check.name), noCiEvidence: null };
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

function validateLivePullRequest(
  livePullRequest: PullRequestDetails,
  expected: CompletionReportPullRequestRef,
  expectedHeadSha: string,
): void {
  if (livePullRequest.state !== null && livePullRequest.state.toLowerCase() !== "open") {
    throw new SymphonyError("invalid_request", "Gated merge requires an open pull request");
  }
  requireMatches("live PR number", livePullRequest.number, expected.number);
  requireMatches("live PR URL", livePullRequest.url, expected.url);
  requireMatches("live PR branch", livePullRequest.headBranch, expected.branch);
  requireMatches("live PR head SHA", livePullRequest.headSha, expectedHeadSha);
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

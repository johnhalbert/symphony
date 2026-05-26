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
  IssueMergeMetadata,
  IssueReviewVerdictRecord,
} from "../persistence/IssueLifecycleStore.js";
import type { RunRecord, RunTranscriptStore } from "../persistence/RunTranscriptStore.js";
import type { TrackerClient } from "../tracker/TrackerClient.js";
import type { Issue } from "../types.js";
import {
  planMergeCompletedWritebacks,
  planMergeGateBlockedWritebacks,
  planMergeGateRepairWritebacks,
  type MergeGateCheckEvidence,
} from "../writeback/TransitionPolicy.js";
import type { WritebackOperation, WritebackProcessor } from "../writeback/WritebackOutbox.js";

const MERGE_GATE_REVIEWER = "symphony-merge-gate";

export interface MergePolicyGitHubClient {
  getPullRequest(input: { pullRequestNumber: number }): Promise<PullRequestDetails>;
  getRequiredCheckResults(input: { headSha: string; requiredChecks: string[] }): Promise<PullRequestCheckResult[]>;
  mergePullRequest(input: PullRequestMergeInput): Promise<PullRequestMergeResult>;
  getAuthenticatedLogin(): Promise<string | null>;
}

export type MergePolicyResult =
  | { status: "skipped"; reason: string }
  | { status: "merged"; merge: IssueMergeMetadata }
  | { status: "already_merged"; merge: IssueMergeMetadata }
  | { status: "checks_pending"; gate: MergeGateStatus }
  | { status: "repair_dispatched"; gate: MergeGateStatus }
  | { status: "blocked"; gate: MergeGateStatus };

export interface MergeGateStatus {
  id: string;
  pullRequest: CompletionReportPullRequestRef;
  headSha: string;
  requiredChecks: string[];
  passedChecks: string[];
  failedChecks: MergeGateCheckEvidence[];
  pendingChecks: MergeGateCheckEvidence[];
  missingChecks: MergeGateCheckEvidence[];
  writebackOperationKeys: string[];
}

type MergeGateDecision =
  | { kind: "passed"; checkStatus: IssueMergeMetadata["checkStatus"] }
  | { kind: "pending"; gate: MergeGateStatus }
  | { kind: "failure"; gate: MergeGateStatus };

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
      const recoverySourceState = this.mergeSourceState(latestIssue);
      if (recoverySourceState === null) {
        throw new SymphonyError("invalid_request", "Gated merge Done recovery requires issue in Done or a merge source state");
      }
      await this.ensureDoneTransition(latestIssue, lifecycle.merge, recoverySourceState);
      return { status: "already_merged", merge: lifecycle.merge };
    }

    const sourceState = this.mergeSourceState(latestIssue);
    if (sourceState === null) return { status: "skipped", reason: `issue is not in a merge source state: ${latestIssue.state}` };

    const report = latestCompletionReport(lifecycle);
    if (!report) throw new SymphonyError("invalid_request", "Gated merge requires a latest completion report");

    const pullRequest = requirePullRequest(report);
    const headSha = requireValue(pullRequest.headSha, "Completion report pull request head SHA is required for gated merge");
    const github = this.options.client ?? createGitHubPullRequestClientForCapability(config, "github.merge");
    const livePullRequest = await github.getPullRequest({ pullRequestNumber: requireNumber(pullRequest.number) });
    validateLivePullRequestMetadata(livePullRequest, pullRequest, headSha);

    const gateId = mergeGateId(latestIssue.id, pullRequest, headSha);
    let activeLifecycle = lifecycle;
    const approvalVerdict = latestApprovalPassVerdict(activeLifecycle);
    const existingGateVerdict = findMergeGateVerdict(activeLifecycle, gateId);
    const decision = await this.evaluateChecks(github, headSha, pullRequest, gateId);
    if (existingGateVerdict && decision.kind === "passed" && approvalVerdict) {
      activeLifecycle = await this.options.lifecycleStore.updateIssue(latestIssue, {
        phase: "passed",
        blockedReason: null,
        lastReviewVerdictId: approvalVerdict.id,
      });
    } else if (existingGateVerdict && decision.kind === "failure") {
      return this.handleMergeGateFailure(latestIssue, activeLifecycle, report, decision.gate, sourceState, existingGateVerdict);
    }
    if (decision.kind === "pending") return { status: "checks_pending", gate: decision.gate };

    const verdict = latestApprovalPassVerdict(activeLifecycle);
    const workerRun = report && this.options.runStore ? await this.options.runStore.getRun(report.runId) : null;
    this.validateLifecycle(activeLifecycle, report, verdict, workerRun, latestIssue);
    if (decision.kind === "failure") {
      return this.handleMergeGateFailure(latestIssue, activeLifecycle, report, decision.gate, sourceState, null);
    }

    const checkStatus = decision.checkStatus;
    const mergeId = `merge:${latestIssue.id}:${headSha}`;
    const doneTransition = this.planDoneTransition(latestIssue, mergeId, sourceState);
    let status: "merged" | "already_merged" = "merged";
    let mergeResult: PullRequestMergeResult;
    if (isOpenPullRequest(livePullRequest)) {
      mergeResult = await github.mergePullRequest({
        pullRequestNumber: requireNumber(pullRequest.number),
        expectedHeadSha: headSha,
        method: config.mergePolicy.mergeMethod,
      });
    } else {
      const serviceLogin = await github.getAuthenticatedLogin();
      mergeResult = recoverAlreadyMergedPullRequest(livePullRequest, serviceLogin);
      status = "already_merged";
    }

    const merge = buildMergeMetadata(latestIssue, pullRequest, headSha, mergeResult, serviceMerge, checkStatus, doneTransition.idempotencyKey);

    const updated = await this.options.lifecycleStore.updateIssue(latestIssue, { merge });
    const storedMerge = updated.merge ?? merge;
    await this.ensureDoneTransition(latestIssue, storedMerge, sourceState);
    return { status, merge: storedMerge };
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

  private async handleMergeGateFailure(
    issue: Issue,
    lifecycle: IssueLifecycleRecord,
    report: IssueCompletionReportRecord,
    gate: MergeGateStatus,
    sourceState: string,
    existingVerdict: IssueReviewVerdictRecord | null,
  ): Promise<MergePolicyResult> {
    const reviewRound = existingVerdict ? lifecycle.reviewRound : lifecycle.reviewRound + 1;
    const blocked = reviewRound >= this.options.config.reviewLoop.maxReviewRounds;
    const operations = blocked
      ? planMergeGateBlockedWritebacks(this.mergeGateWritebackContext(issue, gate, sourceState, reviewRound), this.options.config)
      : planMergeGateRepairWritebacks(this.mergeGateWritebackContext(issue, gate, sourceState, reviewRound), this.options.config);
    if (operations.length === 0) {
      throw new SymphonyError("invalid_request", "Merge gate failure could not plan service-owned writeback");
    }

    await this.requireMergeGateWritebacksSucceeded(issue, operations, blocked ? this.options.config.reviewLoop.blockedStates[0] ?? null : this.options.config.writeback.dispatchState);

    const storedVerdict: IssueReviewVerdictRecord =
      existingVerdict ??
      {
        id: gate.id,
        idempotencyKey: gate.id,
        runId: report.runId,
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        verdict: "fail",
        acceptanceResults: [
          {
            text: "All configured required checks are passing before gated merge",
            satisfied: false,
            evidence: gate.failedChecks.map((check) => `${check.name}: ${check.status}`).join(", "),
          },
        ],
        findings: mergeGateFindings(gate),
        evidence: mergeGateEvidence(gate),
        reviewer: MERGE_GATE_REVIEWER,
        submittedAt: new Date().toISOString(),
        writebackOperationKeys: operations.map((operation) => operation.idempotencyKey),
      };

    if (!existingVerdict) {
      await this.options.lifecycleStore.updateIssue(issue, {
        phase: blocked ? "blocked" : "implementation",
        reviewRound,
        incompleteTurnCount: 0,
        blockedReason: blocked
          ? `merge gate required checks failed and max review rounds reached (${reviewRound}/${this.options.config.reviewLoop.maxReviewRounds})`
          : null,
        lastReviewVerdictId: storedVerdict.id,
        reviewVerdicts: [...lifecycle.reviewVerdicts, storedVerdict],
        summaryPointers: { ciStatus: "failure" },
      });
    }

    const resultGate = { ...gate, writebackOperationKeys: operations.map((operation) => operation.idempotencyKey) };
    return blocked ? { status: "blocked", gate: resultGate } : { status: "repair_dispatched", gate: resultGate };
  }

  private mergeGateWritebackContext(issue: Issue, gate: MergeGateStatus, sourceState: string, reviewRound: number) {
    return {
      issue,
      gateId: gate.id,
      fromState: sourceState,
      pullRequest: gate.pullRequest,
      requiredChecks: gate.requiredChecks,
      failedChecks: gate.failedChecks,
      pendingChecks: gate.pendingChecks,
      missingChecks: gate.missingChecks,
      reviewRound,
      maxReviewRounds: this.options.config.reviewLoop.maxReviewRounds,
    };
  }

  private async requireMergeGateWritebacksSucceeded(
    issue: Issue,
    operations: Parameters<WritebackProcessor["enqueueAndProcess"]>[0][],
    expectedState: string | null,
  ): Promise<void> {
    const writeback = this.options.writeback;
    if (!writeback) throw new SymphonyError("invalid_request", "Gated merge policy requires service-owned writeback");
    for (const operation of operations) {
      const result: WritebackOperation = await writeback.enqueueAndProcess(operation, { retrySkipped: true });
      if (result.status !== "succeeded") {
        throw new SymphonyError(
          "invalid_request",
          `Merge gate writeback did not succeed: ${result.status}${result.lastError ? ` (${result.lastError})` : ""}`,
        );
      }
    }
    if (expectedState === null) return;
    const latest = (await this.options.tracker.fetchIssueStatesByIds([issue.id]))[0] ?? null;
    if (!latest || !statesEqual(latest.state, expectedState)) {
      throw new SymphonyError("invalid_request", "Merge gate writeback could not be verified");
    }
  }

  private mergeSourceState(issue: Issue): string | null {
    return this.options.config.mergePolicy.sourceStates.find((state) => statesEqual(state, issue.state)) ?? null;
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

  private async evaluateChecks(
    github: MergePolicyGitHubClient,
    headSha: string,
    pullRequest: CompletionReportPullRequestRef,
    gateId: string,
  ): Promise<MergeGateDecision> {
    const { requiredChecks, noCiAllowed, noCiEvidence } = this.options.config.mergePolicy;
    if (requiredChecks.length === 0) {
      if (!noCiAllowed || noCiEvidence === null) {
        throw new SymphonyError("invalid_request", "Gated merge requires configured checks or explicit no-CI evidence");
      }
      return { kind: "passed", checkStatus: { requiredChecks: [], passedChecks: [], noCiEvidence } };
    }
    const checks = await github.getRequiredCheckResults({ headSha, requiredChecks });
    const ordered = requiredChecks.map((requiredCheck) => checkEvidence(requiredCheck, checks));
    const failedChecks = ordered.filter((check) => check.status === "failure");
    const pendingChecks = ordered.filter((check) => check.status === "pending");
    const missingChecks = ordered.filter((check) => check.status === "missing");
    const passedChecks = ordered.filter((check) => check.status === "success").map((check) => check.name);
    if (failedChecks.length > 0) {
      return {
        kind: "failure",
        gate: {
          id: gateId,
          pullRequest,
          headSha,
          requiredChecks,
          passedChecks,
          failedChecks,
          pendingChecks,
          missingChecks,
          writebackOperationKeys: [],
        },
      };
    }
    if (pendingChecks.length > 0 || missingChecks.length > 0) {
      return {
        kind: "pending",
        gate: {
          id: gateId,
          pullRequest,
          headSha,
          requiredChecks,
          passedChecks,
          failedChecks,
          pendingChecks,
          missingChecks,
          writebackOperationKeys: [],
        },
      };
    }
    return { kind: "passed", checkStatus: { requiredChecks, passedChecks: requiredChecks, noCiEvidence: null } };
  }
}

function latestCompletionReport(lifecycle: IssueLifecycleRecord): IssueCompletionReportRecord | null {
  if (lifecycle.lastCompletionReportId) {
    const exact = lifecycle.completionReports.find((report) => report.id === lifecycle.lastCompletionReportId);
    if (exact) return exact;
  }
  return lifecycle.completionReports[lifecycle.completionReports.length - 1] ?? null;
}

function latestApprovalPassVerdict(lifecycle: IssueLifecycleRecord): IssueReviewVerdictRecord | null {
  for (const verdict of lifecycle.reviewVerdicts.slice().reverse()) {
    if (verdict.verdict !== "pass" || isMergeGateVerdict(verdict)) continue;
    if (verdict.issueId === lifecycle.issueId && verdict.issueIdentifier === lifecycle.issueIdentifier) return verdict;
  }
  return null;
}

function findMergeGateVerdict(lifecycle: IssueLifecycleRecord, gateId: string): IssueReviewVerdictRecord | null {
  return lifecycle.reviewVerdicts.find((verdict) => verdict.id === gateId && isMergeGateVerdict(verdict)) ?? null;
}

function isMergeGateVerdict(verdict: IssueReviewVerdictRecord): boolean {
  return verdict.reviewer === MERGE_GATE_REVIEWER || verdict.id.startsWith("merge-gate:");
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
  if (!hasApprovalFeedback(lifecycle, verdict, pullRequest)) {
    throw new SymphonyError("invalid_request", "Gated merge requires service-recorded APPROVE PR review feedback");
  }
}

function hasApprovalFeedback(
  lifecycle: IssueLifecycleRecord,
  verdict: IssueReviewVerdictRecord,
  pullRequest: CompletionReportPullRequestRef,
): boolean {
  return lifecycle.reviewFeedback.some(
    (feedback) =>
      feedback.runId === verdict.runId &&
      feedback.kind === "review" &&
      feedback.event === "APPROVE" &&
      feedback.pullRequest.number === pullRequest.number &&
      feedback.pullRequest.url === pullRequest.url &&
      feedback.pullRequest.headSha === pullRequest.headSha,
  );
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

function mergeGateId(issueId: string, pullRequest: CompletionReportPullRequestRef, headSha: string): string {
  return `merge-gate:${issueId}:pr-${requireNumber(pullRequest.number)}:${headSha}`;
}

function checkEvidence(requiredCheck: string, checks: PullRequestCheckResult[]): MergeGateCheckEvidence {
  const exact = checks.find((check) => check.name === requiredCheck);
  if (!exact) return { name: requiredCheck, status: "missing", conclusion: null, url: null };
  return {
    name: requiredCheck,
    status: exact.status,
    conclusion: exact.conclusion,
    url: exact.url,
  };
}

function mergeGateFindings(gate: MergeGateStatus): string[] {
  return gate.failedChecks.map((check) => `Required check failed: ${formatCheckEvidence(check)}`);
}

function mergeGateEvidence(gate: MergeGateStatus): string[] {
  return [
    `PR: ${gate.pullRequest.number === null ? gate.pullRequest.url ?? "n/a" : `#${gate.pullRequest.number}`} (${gate.pullRequest.url ?? "n/a"})`,
    `PR head SHA: ${gate.headSha}`,
    ...gate.failedChecks.map((check) => `Failing check: ${formatCheckEvidence(check)}`),
    ...gate.pendingChecks.map((check) => `Pending check: ${formatCheckEvidence(check)}`),
    ...gate.missingChecks.map((check) => `Missing check: ${formatCheckEvidence(check)}`),
  ];
}

function formatCheckEvidence(check: MergeGateCheckEvidence): string {
  const conclusion = check.conclusion === null ? "" : ` / ${check.conclusion}`;
  const url = check.url === null ? "" : ` (${check.url})`;
  return `${check.name}: ${check.status}${conclusion}${url}`;
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

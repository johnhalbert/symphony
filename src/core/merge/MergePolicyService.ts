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
  IssueMergeGateCheckOutcome,
  IssueMergeMetadata,
  IssueMergeGateState,
  IssueReviewVerdictRecord,
} from "../persistence/IssueLifecycleStore.js";
import { latestCurrentApprovalPassVerdict } from "../persistence/IssueLifecycleStore.js";
import type { RunRecord, RunTranscriptStore } from "../persistence/RunTranscriptStore.js";
import type { TrackerClient } from "../tracker/TrackerClient.js";
import type { Issue } from "../types.js";
import {
  planMergeCompletedWritebacks,
  planMergeGateBlockedWritebacks,
  planMergeGateHeadSupersessionWritebacks,
  planMergeGateRepairWritebacks,
  type MergeGateCheckEvidence,
} from "../writeback/TransitionPolicy.js";
import type { WritebackOperation, WritebackProcessor } from "../writeback/WritebackOutbox.js";
import { inactiveMergeGateLifecyclePatch, shouldSilentlyRetireMergeGate, supersededMergeGateLifecyclePatch } from "./MergeGateLifecycle.js";

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
  | { status: "blocked"; gate: MergeGateStatus }
  | {
      status: "head_superseded";
      previousHeadSha: string;
      liveHeadSha: string;
      gate: MergeGateStatus;
    };

export interface MergeGateStatus {
  id: string;
  pullRequest: CompletionReportPullRequestRef;
  headSha: string;
  requiredChecks: string[];
  passedChecks: string[];
  failedChecks: MergeGateCheckEvidence[];
  actionableMissingChecks: MergeGateCheckEvidence[];
  pendingChecks: MergeGateCheckEvidence[];
  missingChecks: MergeGateCheckEvidence[];
  unknownChecks: MergeGateCheckEvidence[];
  checks: Array<
    MergeGateCheckEvidence & {
      outcome: IssueMergeGateCheckOutcome;
      rawStatus: "success" | "failure" | "pending" | "missing" | "unknown";
      firstObservedAt: string | null;
      actionableSince: string | null;
    }
  >;
  blockerFingerprint: string | null;
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
    validateLivePullRequestIdentity(livePullRequest, pullRequest);
    if (livePullRequest.headSha !== headSha) {
      return this.handleHeadSupersession(latestIssue, lifecycle, report, pullRequest, headSha, livePullRequest, sourceState);
    }

    let activeLifecycle = lifecycle;
    if (shouldSilentlyRetireMergeGate(activeLifecycle.mergeGate, headSha, pullRequest.number)) {
      activeLifecycle = await this.options.lifecycleStore.updateIssue(latestIssue, {
        ...supersededMergeGateLifecyclePatch(activeLifecycle, activeLifecycle.mergeGate, headSha),
      });
    }
    const gateId = mergeGateId(latestIssue.id, pullRequest, headSha);
    const approvalVerdict = latestCurrentApprovalPassVerdict(activeLifecycle);
    const existingGateVerdict = findMergeGateVerdict(activeLifecycle, gateId);
    const decision = await this.evaluateChecks(github, headSha, pullRequest, gateId, activeLifecycle);
    if (decision.kind === "passed" && approvalVerdict && (existingGateVerdict || activeLifecycle.mergeGate?.id === gateId)) {
      const inactiveGatePatch =
        activeLifecycle.mergeGate?.id === gateId
          ? inactiveMergeGateLifecyclePatch(activeLifecycle, activeLifecycle.mergeGate, "resolved")
          : {};
      activeLifecycle = await this.options.lifecycleStore.updateIssue(latestIssue, {
        ...inactiveGatePatch,
        phase: "passed",
        blockedReason: null,
        lastReviewVerdictId: approvalVerdict.id,
        summaryPointers: { ciStatus: "success" },
      });
    } else if (existingGateVerdict && decision.kind === "failure") {
      if (isSameMergeGateBlocker(activeLifecycle, decision.gate)) {
        return {
          status: activeLifecycle.mergeGate?.status === "blocked" ? "blocked" : "repair_dispatched",
          gate: { ...decision.gate, writebackOperationKeys: activeLifecycle.mergeGate?.writebackOperationKeys ?? existingGateVerdict.writebackOperationKeys },
        };
      }
      return this.handleMergeGateFailure(latestIssue, activeLifecycle, report, decision.gate, sourceState, existingGateVerdict);
    }
    if (decision.kind === "pending") {
      const updated = await this.options.lifecycleStore.updateIssue(latestIssue, {
        phase: activeLifecycle.phase,
        blockedReason: null,
        lastReviewVerdictId:
          existingGateVerdict && approvalVerdict && activeLifecycle.lastReviewVerdictId === existingGateVerdict.id
            ? approvalVerdict.id
            : activeLifecycle.lastReviewVerdictId,
        mergeGate: mergeGateStateFromStatus(decision.gate, "observing", activeLifecycle, null, null),
        summaryPointers: { ciStatus: "observing" },
      });
      activeLifecycle = updated;
      return { status: "checks_pending", gate: decision.gate };
    }

    const verdict = latestCurrentApprovalPassVerdict(activeLifecycle);
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

    const mergeGatePatch =
      activeLifecycle.mergeGate && shouldSilentlyRetireMergeGate(activeLifecycle.mergeGate, headSha, pullRequest.number)
        ? supersededMergeGateLifecyclePatch(activeLifecycle, activeLifecycle.mergeGate, headSha)
        : { mergeGate: activeLifecycle.mergeGate ?? null };
    const updated = await this.options.lifecycleStore.updateIssue(latestIssue, { merge, ...mergeGatePatch });
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
    const approvalVerdict = latestCurrentApprovalPassVerdict(lifecycle);
    const newRepairCycle =
      existingVerdict === null ||
      lifecycle.phase === "passed" ||
      (approvalVerdict !== null && lifecycle.lastReviewVerdictId === approvalVerdict.id);
    const reviewRound = newRepairCycle ? lifecycle.reviewRound + 1 : lifecycle.reviewRound;
    const blocked = reviewRound >= this.options.config.reviewLoop.maxReviewRounds;
    const operations = blocked
      ? planMergeGateBlockedWritebacks(this.mergeGateWritebackContext(issue, gate, sourceState, reviewRound), this.options.config)
      : planMergeGateRepairWritebacks(this.mergeGateWritebackContext(issue, gate, sourceState, reviewRound), this.options.config);
    if (operations.length === 0) {
      throw new SymphonyError("invalid_request", "Merge gate failure could not plan service-owned writeback");
    }

    await this.requireMergeGateWritebacksSucceeded(issue, operations, blocked ? this.options.config.reviewLoop.blockedStates[0] ?? null : this.options.config.writeback.dispatchState);

    const blockerKind = blocked ? "blocked" : "repair";
    const operationKeys = operations.map((operation) => operation.idempotencyKey);
    const storedVerdict: IssueReviewVerdictRecord = {
      id: gate.id,
      idempotencyKey: mergeGateVerdictIdempotencyKey(gate, blockerKind),
      runId: report.runId,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      verdict: "fail",
      acceptanceResults: [
        {
          text: "All configured required checks are passing before gated merge",
          satisfied: false,
          evidence: [...gate.failedChecks, ...gate.actionableMissingChecks].map((check) => `${check.name}: ${check.status}`).join(", "),
        },
      ],
      findings: mergeGateFindings(gate),
      evidence: mergeGateEvidence(gate),
      reviewer: MERGE_GATE_REVIEWER,
      submittedAt: new Date().toISOString(),
      writebackOperationKeys: operationKeys,
    };

    await this.options.lifecycleStore.updateIssue(issue, {
      phase: blocked ? "blocked" : "implementation",
      reviewRound,
      incompleteTurnCount: 0,
      blockedReason: blocked
        ? `merge gate required checks failed and max review rounds reached (${reviewRound}/${this.options.config.reviewLoop.maxReviewRounds})`
        : null,
      lastReviewVerdictId: storedVerdict.id,
      reviewVerdicts: upsertMergeGateVerdict(lifecycle.reviewVerdicts, storedVerdict),
      mergeGate: mergeGateStateFromStatus(
        { ...gate, writebackOperationKeys: operationKeys },
        blocked ? "blocked" : "repair_dispatched",
        lifecycle,
        report.runId,
        report.id,
        reviewRound,
      ),
      summaryPointers: { ciStatus: "failure" },
    });

    const resultGate = { ...gate, writebackOperationKeys: operationKeys };
    return blocked ? { status: "blocked", gate: resultGate } : { status: "repair_dispatched", gate: resultGate };
  }

  private mergeGateWritebackContext(issue: Issue, gate: MergeGateStatus, sourceState: string, reviewRound: number) {
    return {
      issue,
      gateId: gate.id,
      blockerFingerprint: gate.blockerFingerprint,
      fromState: sourceState,
      pullRequest: gate.pullRequest,
      requiredChecks: gate.requiredChecks,
      failedChecks: gate.failedChecks,
      actionableMissingChecks: gate.actionableMissingChecks,
      pendingChecks: gate.pendingChecks,
      missingChecks: gate.missingChecks,
      unknownChecks: gate.unknownChecks,
      reviewRound,
      maxReviewRounds: this.options.config.reviewLoop.maxReviewRounds,
    };
  }

  private async handleHeadSupersession(
    issue: Issue,
    lifecycle: IssueLifecycleRecord,
    report: IssueCompletionReportRecord,
    pullRequest: CompletionReportPullRequestRef,
    previousHeadSha: string,
    livePullRequest: PullRequestDetails,
    sourceState: string,
  ): Promise<MergePolicyResult> {
    const liveHeadSha = requireValue(livePullRequest.headSha, "Live PR head SHA is required for merge gate supersession");
    const gateId = mergeGateId(issue.id, pullRequest, previousHeadSha);
    const gate = lifecycle.mergeGate?.id === gateId ? lifecycle.mergeGate : null;
    const supersededPatch = gate
      ? inactiveMergeGateLifecyclePatch(lifecycle, gate, "superseded", liveHeadSha).mergeGate
      : inactiveMergeGateLifecyclePatch(
          lifecycle,
          mergeGateStateFromStatus(
            emptyGateStatus(gateId, pullRequest, previousHeadSha, this.options.config.mergePolicy.requiredChecks),
            "superseded",
            lifecycle,
            report.runId,
            report.id,
          ),
          "superseded",
          liveHeadSha,
        ).mergeGate;
    if (!supersededPatch) throw new SymphonyError("invalid_request", "Merge gate supersession could not build inactive gate state");
    const supersededGate = supersededPatch;
    const operations = planMergeGateHeadSupersessionWritebacks(
      { issue, gateId, fromState: sourceState, pullRequest, liveHeadSha, reportId: report.id },
      this.options.config,
    );
    await this.requireMergeGateWritebacksSucceeded(issue, operations, this.options.config.writeback.dispatchState);
    await this.options.lifecycleStore.updateIssue(issue, {
      ...(gate ? inactiveMergeGateLifecyclePatch(lifecycle, gate, "superseded", liveHeadSha) : { mergeGate: supersededGate }),
      phase: "implementation",
      blockedReason: null,
      lastReviewVerdictId: null,
      summaryPointers: { ciStatus: "head_superseded" },
    });
    return {
      status: "head_superseded",
      previousHeadSha,
      liveHeadSha,
      gate: gateStatusFromState(supersededGate),
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
    lifecycle: IssueLifecycleRecord,
  ): Promise<MergeGateDecision> {
    const { requiredChecks, noCiAllowed, noCiEvidence } = this.options.config.mergePolicy;
    if (requiredChecks.length === 0) {
      if (!noCiAllowed || noCiEvidence === null) {
        throw new SymphonyError("invalid_request", "Gated merge requires configured checks or explicit no-CI evidence");
      }
      return { kind: "passed", checkStatus: { requiredChecks: [], passedChecks: [], noCiEvidence } };
    }
    const checks = await github.getRequiredCheckResults({ headSha, requiredChecks });
    const ordered = requiredChecks.map((requiredCheck) =>
      classifyCheck(requiredCheck, checks, lifecycle.mergeGate ?? null, gateId, this.options.config.mergePolicy.missingCheckStabilizationMs),
    );
    const failedChecks = ordered.filter((check) => check.outcome === "failing");
    const actionableMissingChecks = ordered.filter((check) => check.outcome === "missing_actionable");
    const pendingChecks = ordered.filter((check) => check.outcome === "pending");
    const missingChecks = ordered.filter((check) => check.outcome === "missing_observed");
    const unknownChecks = ordered.filter((check) => check.outcome === "unknown");
    const passedChecks = ordered.filter((check) => check.outcome === "passing").map((check) => check.name);
    const baseGate = {
      id: gateId,
      pullRequest,
      headSha,
      requiredChecks,
      passedChecks,
      failedChecks,
      actionableMissingChecks,
      pendingChecks,
      missingChecks,
      unknownChecks,
      checks: ordered,
      blockerFingerprint: blockerFingerprint(headSha, [...failedChecks, ...actionableMissingChecks]),
      writebackOperationKeys: [],
    };
    if (failedChecks.length > 0 || actionableMissingChecks.length > 0) {
      return {
        kind: "failure",
        gate: baseGate,
      };
    }
    if (pendingChecks.length > 0 || missingChecks.length > 0 || unknownChecks.length > 0) {
      return {
        kind: "pending",
        gate: baseGate,
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

function findMergeGateVerdict(lifecycle: IssueLifecycleRecord, gateId: string): IssueReviewVerdictRecord | null {
  return lifecycle.reviewVerdicts.find((verdict) => verdict.id === gateId && isMergeGateVerdict(verdict)) ?? null;
}

export function isMergeGateVerdict(verdict: IssueReviewVerdictRecord): boolean {
  return verdict.reviewer === MERGE_GATE_REVIEWER || verdict.id.startsWith("merge-gate:");
}

function upsertMergeGateVerdict(
  verdicts: IssueReviewVerdictRecord[],
  mergeGateVerdict: IssueReviewVerdictRecord,
): IssueReviewVerdictRecord[] {
  const result = verdicts.filter((verdict) => verdict.id !== mergeGateVerdict.id || !isMergeGateVerdict(verdict));
  result.push(mergeGateVerdict);
  return result;
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

function validateLivePullRequestIdentity(livePullRequest: PullRequestDetails, expected: CompletionReportPullRequestRef): void {
  requireMatches("live PR number", livePullRequest.number, expected.number);
  requireMatches("live PR URL", livePullRequest.url, expected.url);
  requireMatches("live PR branch", livePullRequest.headBranch, expected.branch);
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

function classifyCheck(
  requiredCheck: string,
  checks: PullRequestCheckResult[],
  existingGate: IssueMergeGateState | null,
  gateId: string,
  stabilizationMs: number,
): MergeGateStatus["checks"][number] {
  const raw = checkEvidence(requiredCheck, checks);
  const existing = existingGate?.id === gateId ? existingGate.checks.find((check) => check.name === requiredCheck) ?? null : null;
  const now = new Date().toISOString();
  if (raw.status === "missing") {
    const firstObservedAt = existing?.rawStatus === "missing" ? existing.firstObservedAt ?? now : now;
    const elapsedMs = Date.parse(now) - Date.parse(firstObservedAt);
    const stabilized = Number.isFinite(elapsedMs) && elapsedMs >= stabilizationMs;
    return {
      ...raw,
      rawStatus: "missing",
      outcome: stabilized ? "missing_actionable" : "missing_observed",
      firstObservedAt,
      actionableSince: stabilized ? existing?.actionableSince ?? now : null,
    };
  }
  if (raw.status === "success") {
    return { ...raw, rawStatus: "success", outcome: "passing", firstObservedAt: null, actionableSince: null };
  }
  if (raw.status === "pending") {
    return { ...raw, rawStatus: "pending", outcome: "pending", firstObservedAt: null, actionableSince: null };
  }
  if (raw.status === "unknown") {
    return { ...raw, rawStatus: "unknown", outcome: "unknown", firstObservedAt: null, actionableSince: null };
  }
  return { ...raw, rawStatus: "failure", outcome: "failing", firstObservedAt: null, actionableSince: null };
}

function blockerFingerprint(headSha: string, blockers: MergeGateCheckEvidence[]): string | null {
  if (blockers.length === 0) return null;
  return `${headSha}:${blockers
    .map((check) => `${check.name}:${check.status}`)
    .sort()
    .join("|")}`;
}

function mergeGateVerdictIdempotencyKey(gate: MergeGateStatus, kind: "repair" | "blocked"): string {
  return `${gate.id}:${kind}:${gate.blockerFingerprint ?? "no-blocker-fingerprint"}`;
}

function isSameMergeGateBlocker(lifecycle: IssueLifecycleRecord, gate: MergeGateStatus): boolean {
  const current = lifecycle.mergeGate ?? null;
  return (
    current !== null &&
    current.id === gate.id &&
    (current.status === "repair_dispatched" || current.status === "blocked") &&
    current.blockerFingerprint === gate.blockerFingerprint &&
    lifecycle.lastReviewVerdictId === gate.id
  );
}

function mergeGateStateFromStatus(
  gate: MergeGateStatus,
  status: IssueMergeGateState["status"],
  lifecycle: IssueLifecycleRecord,
  gateRunId: string | null,
  gateReportId: string | null,
  reviewRound = lifecycle.reviewRound,
): IssueMergeGateState {
  const previous = lifecycle.mergeGate?.id === gate.id ? lifecycle.mergeGate : null;
  return {
    id: gate.id,
    status,
    headSha: gate.headSha,
    pullRequest: gate.pullRequest,
    requiredChecks: gate.requiredChecks,
    checks: gate.checks.map((check) => ({
      name: check.name,
      outcome: check.outcome,
      rawStatus: check.rawStatus,
      conclusion: check.conclusion,
      url: check.url,
      firstObservedAt: check.firstObservedAt,
      actionableSince: check.actionableSince,
    })),
    reviewRound,
    gateRunId: previous?.gateRunId ?? gateRunId,
    gateReportId: previous?.gateReportId ?? gateReportId,
    repairRunId: status === "repair_dispatched" ? null : previous?.repairRunId ?? null,
    repairReportId: status === "repair_dispatched" ? null : previous?.repairReportId ?? null,
    blockerFingerprint: gate.blockerFingerprint,
    writebackOperationKeys: gate.writebackOperationKeys,
    supersededByHeadSha: status === "superseded" ? previous?.supersededByHeadSha ?? null : null,
    updatedAt: new Date().toISOString(),
  };
}

function gateStatusFromState(state: IssueMergeGateState): MergeGateStatus {
  const checks = state.checks.map((check) => ({
    name: check.name,
    status: check.rawStatus,
    conclusion: check.conclusion,
    url: check.url,
    outcome: check.outcome,
    rawStatus: check.rawStatus,
    firstObservedAt: check.firstObservedAt,
    actionableSince: check.actionableSince,
  }));
  return {
    id: state.id,
    pullRequest: state.pullRequest,
    headSha: state.headSha,
    requiredChecks: state.requiredChecks,
    passedChecks: checks.filter((check) => check.outcome === "passing").map((check) => check.name),
    failedChecks: checks.filter((check) => check.outcome === "failing"),
    actionableMissingChecks: checks.filter((check) => check.outcome === "missing_actionable"),
    pendingChecks: checks.filter((check) => check.outcome === "pending"),
    missingChecks: checks.filter((check) => check.outcome === "missing_observed"),
    unknownChecks: checks.filter((check) => check.outcome === "unknown"),
    checks,
    blockerFingerprint: state.blockerFingerprint,
    writebackOperationKeys: state.writebackOperationKeys,
  };
}

function emptyGateStatus(
  gateId: string,
  pullRequest: CompletionReportPullRequestRef,
  headSha: string,
  requiredChecks: string[],
): MergeGateStatus {
  return {
    id: gateId,
    pullRequest,
    headSha,
    requiredChecks,
    passedChecks: [],
    failedChecks: [],
    actionableMissingChecks: [],
    pendingChecks: [],
    missingChecks: [],
    unknownChecks: [],
    checks: [],
    blockerFingerprint: null,
    writebackOperationKeys: [],
  };
}

function mergeGateFindings(gate: MergeGateStatus): string[] {
  return [
    ...gate.failedChecks.map((check) => `Required check failed: ${formatCheckEvidence(check)}`),
    ...gate.actionableMissingChecks.map((check) => `Required check missing (actionable): ${formatCheckEvidence(check)}`),
  ];
}

function mergeGateEvidence(gate: MergeGateStatus): string[] {
  return [
    `PR: ${gate.pullRequest.number === null ? gate.pullRequest.url ?? "n/a" : `#${gate.pullRequest.number}`} (${gate.pullRequest.url ?? "n/a"})`,
    `PR head SHA: ${gate.headSha}`,
    ...gate.failedChecks.map((check) => `Failing check: ${formatCheckEvidence(check)}`),
    ...gate.actionableMissingChecks.map((check) => `Actionable missing check: ${formatCheckEvidence(check)}`),
    ...gate.pendingChecks.map((check) => `Pending check: ${formatCheckEvidence(check)}`),
    ...gate.missingChecks.map((check) => `Missing check: ${formatCheckEvidence(check)}`),
    ...gate.unknownChecks.map((check) => `Unknown check: ${formatCheckEvidence(check)}`),
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

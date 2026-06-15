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
  IssueMergeGateMergeabilityState,
  IssueMergeConflictMetadata,
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
  planMergeConflictsWritebacks,
  planMergeGateBlockedWritebacks,
  planMergeGateHeadSupersessionWritebacks,
  planMergeGateRepairWritebacks,
  type MergeGateCheckEvidence,
} from "../writeback/TransitionPolicy.js";
import type { WritebackOperation, WritebackProcessor } from "../writeback/WritebackOutbox.js";
import {
  canAutoResolveMergeGateOnCheckPass,
  hasRepairGateClearance,
  inactiveMergeGateLifecyclePatch,
  isActiveMergeGate,
  shouldSilentlyRetireMergeGate,
  supersededMergeGateLifecyclePatch,
} from "./MergeGateLifecycle.js";
import {
  ServiceOwnedMergeConflictGit,
  type ServiceOwnedMergeConflictPreparationResult,
} from "./ServiceOwnedMergeConflictGit.js";

const MERGE_GATE_REVIEWER = "symphony-merge-gate";

export interface MergePolicyGitHubClient {
  getPullRequest(input: { pullRequestNumber: number }): Promise<PullRequestDetails>;
  getBranchHeadSha(input: { branchName: string }): Promise<string>;
  getRequiredCheckResults(input: { headSha: string; requiredChecks: string[] }): Promise<PullRequestCheckResult[]>;
  mergePullRequest(input: PullRequestMergeInput): Promise<PullRequestMergeResult>;
  getAuthenticatedLogin(): Promise<string | null>;
  isAncestor(input: { ancestorSha: string; descendantSha: string }): Promise<boolean>;
  gitAuthHeader(): Promise<string>;
}

export type MergePolicyResult =
  | { status: "skipped"; reason: string }
  | { status: "merged"; merge: IssueMergeMetadata }
  | { status: "already_merged"; merge: IssueMergeMetadata }
  | { status: "checks_pending"; gate: MergeGateStatus }
  | { status: "repair_dispatched"; gate: MergeGateStatus }
  | { status: "conflict_dispatched"; gate: MergeGateStatus; conflict: IssueMergeConflictMetadata }
  | { status: "blocked"; gate: MergeGateStatus }
  | {
      status: "head_superseded";
      previousHeadSha: string;
      liveHeadSha: string;
      gate: MergeGateStatus;
    }
  | { status: "blocked_conflicts"; headSha: string; mergeableState: string | null };

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
  mergeability: IssueMergeGateMergeabilityState | null;
  blockerFingerprint: string | null;
  writebackOperationKeys: string[];
}

type MergeGateDecision =
  | { kind: "passed"; checkStatus: IssueMergeMetadata["checkStatus"]; gate: MergeGateStatus }
  | { kind: "pending"; gate: MergeGateStatus }
  | { kind: "failure"; gate: MergeGateStatus };

export interface MergePolicyServiceOptions {
  config: ServiceConfig;
  tracker: TrackerClient;
  lifecycleStore: IssueLifecycleStore;
  runStore?: RunTranscriptStore;
  writeback?: WritebackProcessor;
  client?: MergePolicyGitHubClient;
  conflictGit?: ServiceOwnedMergeConflictGit;
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
    const serviceMergeConfig = resolveGitHubClientConfig(config, "github.merge");
    const serviceMerge = serviceMergeConfig.credential;
    if (!serviceMerge && serviceMergeConfig.github.app === null) {
      throw new SymphonyError(
        "invalid_request",
        "Gated merge policy requires service github.merge credentials or GitHub App installation auth",
      );
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
    const staleConflictResult = this.pendingConflictsWhileTrackerCatchesUp(latestIssue, lifecycle);
    if (staleConflictResult !== null) return staleConflictResult;
    if (sourceState === null) return { status: "skipped", reason: `issue is not in a merge source state: ${latestIssue.state}` };

    const report = latestCompletionReport(lifecycle);
    if (!report) throw new SymphonyError("invalid_request", "Gated merge requires a latest completion report");

    const approvedPullRequest = requirePullRequest(report);
    const approvedHeadSha = requireValue(approvedPullRequest.headSha, "Completion report pull request head SHA is required for gated merge");
    const resolvedConflict = resolvedMergeConflictForIssue(latestIssue, lifecycle, config);
    const pullRequest = resolvedConflict ? pullRequestRefForResolvedConflict(resolvedConflict) : approvedPullRequest;
    const headSha = requireValue(pullRequest.headSha, "Completion report pull request head SHA is required for gated merge");
    const github = this.options.client ?? createGitHubPullRequestClientForCapability(config, "github.merge");
    const livePullRequest = await github.getPullRequest({ pullRequestNumber: requireNumber(pullRequest.number) });
    validateLivePullRequestMetadata(livePullRequest, pullRequest, headSha);
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
    const baseObservation = await resolveLiveBaseObservation(github, livePullRequest);
    if (baseObservation.rewritten) {
      const baseRewriteGate = gateWithMergeability(
        emptyGateStatus(gateId, pullRequest, headSha, config.mergePolicy.requiredChecks),
        baseRewriteMergeabilityState(livePullRequest, pullRequest, headSha, baseObservation),
      );
      return this.handleMergeGateFailure(latestIssue, activeLifecycle, report, baseRewriteGate, sourceState, null);
    }
    if (resolvedConflict) {
      await validateConflictApprovalCarryForward(github, resolvedConflict, approvedPullRequest, approvedHeadSha, headSha);
    }

    const approvalVerdict = latestMergeApprovalPassVerdict(activeLifecycle, resolvedConflict !== null);
    const existingGateVerdict = findMergeGateVerdict(activeLifecycle, gateId);
    const checkDecision = await this.evaluateChecks(github, headSha, pullRequest, gateId, activeLifecycle);
    const decision = mergeGateDecisionWithMergeability(
      checkDecision,
      mergeabilityStateFromPullRequest(livePullRequest, pullRequest, headSha, baseObservation),
    );
    const workerRun = report && this.options.runStore ? await this.options.runStore.getRun(report.runId) : null;
    if (decision.kind === "failure" && decision.gate.mergeability?.status === "conflicted" && config.mergePolicy.conflictsState !== null) {
      return this.handleServicePreparedMergeConflict(
        latestIssue,
        activeLifecycle,
        report,
        decision.gate,
        sourceState,
        livePullRequest,
        baseObservation,
        workerRun,
        github,
      );
    }
    if (decision.kind === "passed") {
      const gate = activeLifecycle.mergeGate;
      if (gate?.id === gateId && isActiveMergeGate(gate)) {
        if (gate.status === "blocked" && !canAutoResolveMergeGateOnCheckPass(activeLifecycle, gateId)) {
          return { status: "blocked", gate: gateStatusFromState(gate) };
        }
        if (gate.status === "repair_dispatched" && !hasRepairGateClearance(activeLifecycle, gate)) {
          return { status: "repair_dispatched", gate: gateStatusFromState(gate) };
        }
      }
    }
    if (existingGateVerdict && decision.kind === "failure") {
      if (shouldRefreshSameMergeGateBlocker(activeLifecycle, decision.gate)) {
        const refreshedMergeGate = refreshActiveMergeGateObservation(activeLifecycle, decision.gate, existingGateVerdict.writebackOperationKeys);
        if (refreshedMergeGate) {
          const updated = await this.options.lifecycleStore.updateIssue(latestIssue, {
            phase: activeLifecycle.phase,
            blockedReason: refreshedMergeGate.status === "blocked" ? activeLifecycle.blockedReason : null,
            lastReviewVerdictId: refreshedActiveGateLastReviewVerdictId(activeLifecycle, refreshedMergeGate),
            mergeGate: refreshedMergeGate,
            summaryPointers: { ciStatus: "failure" },
          });
          const gate = updated.mergeGate ?? refreshedMergeGate;
          return {
            status: gate.status === "blocked" ? "blocked" : "repair_dispatched",
            gate: gateStatusFromState(gate),
          };
        }
        return {
          status: activeLifecycle.mergeGate?.status === "blocked" ? "blocked" : "repair_dispatched",
          gate: { ...decision.gate, writebackOperationKeys: activeLifecycle.mergeGate?.writebackOperationKeys ?? existingGateVerdict.writebackOperationKeys },
        };
      }
      return this.handleMergeGateFailure(latestIssue, activeLifecycle, report, decision.gate, sourceState, existingGateVerdict);
    }
    if (decision.kind === "pending") {
      const refreshedMergeGate = refreshActiveMergeGateObservation(activeLifecycle, decision.gate, existingGateVerdict?.writebackOperationKeys ?? []);
      if (refreshedMergeGate) {
        const updated = await this.options.lifecycleStore.updateIssue(latestIssue, {
          phase: activeLifecycle.phase,
          blockedReason: refreshedMergeGate.status === "blocked" ? activeLifecycle.blockedReason : null,
          lastReviewVerdictId: refreshedActiveGateLastReviewVerdictId(activeLifecycle, refreshedMergeGate),
          mergeGate: refreshedMergeGate,
          summaryPointers: { ciStatus: "failure" },
        });
        const gate = updated.mergeGate ?? refreshedMergeGate;
        return {
          status: gate.status === "blocked" ? "blocked" : "repair_dispatched",
          gate: gateStatusFromState(gate),
        };
      }
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

    const verdict = latestMergeApprovalPassVerdict(activeLifecycle, resolvedConflict !== null);
    this.validateLifecycle(activeLifecycle, report, verdict, workerRun, latestIssue);
    if (decision.kind === "failure") {
      return this.handleMergeGateFailure(latestIssue, activeLifecycle, report, decision.gate, sourceState, null);
    }
    if (
      decision.kind === "passed" &&
      verdict &&
      (existingGateVerdict || activeLifecycle.mergeGate?.id === gateId) &&
      canAutoResolveMergeGateOnCheckPass(activeLifecycle, gateId)
    ) {
      const inactiveGatePatch =
        activeLifecycle.mergeGate?.id === gateId
          ? inactiveMergeGateLifecyclePatch(activeLifecycle, activeLifecycle.mergeGate, "resolved")
          : {};
      activeLifecycle = await this.options.lifecycleStore.updateIssue(latestIssue, {
        ...inactiveGatePatch,
        phase: "passed",
        blockedReason: null,
        lastReviewVerdictId: verdict.id,
        summaryPointers: { ciStatus: "success" },
      });
    }

    const checkStatus = decision.checkStatus;
    const mergeId = `merge:${latestIssue.id}:${headSha}`;
    let status: "merged" | "already_merged" = "merged";
    let mergeResult: PullRequestMergeResult;
    if (isOpenPullRequest(livePullRequest)) {
      const mergeability = decision.gate.mergeability;
      if (mergeability?.status === "blocked") {
        throw new SymphonyError("invalid_request", mergeability.reason ?? "Pull request is not currently mergeable");
      }
      const doneTransition = this.planDoneTransition(latestIssue, mergeId, sourceState);
      mergeResult = await github.mergePullRequest({
        pullRequestNumber: requireNumber(pullRequest.number),
        expectedHeadSha: headSha,
        method: config.mergePolicy.mergeMethod,
      });
      const merge = buildMergeMetadata(latestIssue, pullRequest, headSha, mergeResult, serviceMerge, checkStatus, doneTransition.idempotencyKey);
      const mergeGatePatch =
        activeLifecycle.mergeGate && shouldSilentlyRetireMergeGate(activeLifecycle.mergeGate, headSha, pullRequest.number)
          ? supersededMergeGateLifecyclePatch(activeLifecycle, activeLifecycle.mergeGate, headSha)
          : { mergeGate: activeLifecycle.mergeGate ?? null };
      const updated = await this.options.lifecycleStore.updateIssue(latestIssue, { merge, ...mergeGatePatch });
      const storedMerge = updated.merge ?? merge;
      await this.ensureDoneTransition(latestIssue, storedMerge, sourceState);
      return { status, merge: storedMerge };
    } else {
      const doneTransition = this.planDoneTransition(latestIssue, mergeId, sourceState);
      const serviceLogin = await github.getAuthenticatedLogin();
      mergeResult = recoverAlreadyMergedPullRequest(livePullRequest, serviceLogin);
      status = "already_merged";
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
    const previousMergeGateRound = lifecycle.mergeGate?.id === gate.id ? lifecycle.mergeGate.reviewRound : 0;
    const reviewRound = newRepairCycle ? previousMergeGateRound + 1 : previousMergeGateRound;
    const maxMergeGateFailures = this.options.config.reviewLoop.failureLimits.mergeGateFailures;
    const missingConflictState = gate.mergeability?.status === "conflicted" && this.options.config.mergePolicy.conflictsState === null;
    const blocked = missingConflictState || reviewRound >= maxMergeGateFailures;
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
          text: "Required checks are passing and the pull request is mergeable before gated merge",
          satisfied: false,
          evidence: mergeGateEvidence(gate).join("; "),
        },
      ],
      findings: mergeGateFindings(gate),
      gateFindings: mergeGateFindings(gate).map((finding) => ({
        summary: finding,
        requirementIds: [],
        contractAnchor: "Merge gate policy",
        scenario: "Lifecycle-bound pull request merge gate",
        scenarioEntitlement: "necessary_core_behavior",
        observedFailure: finding,
        currentIssueOwnership: "The current issue owns clearing its lifecycle-bound merge gate.",
        boundedRepair: "Repair the failing or missing merge-gate checks for the current pull request head.",
        evidence: mergeGateEvidence(gate),
      })),
      discoveryFindings: [],
      evidence: mergeGateEvidence(gate),
      reviewer: MERGE_GATE_REVIEWER,
      submittedAt: new Date().toISOString(),
      writebackOperationKeys: operationKeys,
    };

    await this.options.lifecycleStore.updateIssue(issue, {
      phase: blocked ? "blocked" : "implementation",
      incompleteTurnCount: 0,
      blockedReason: blocked
        ? missingConflictState
          ? "merge_policy.conflicts_state is required before Symphony can prepare a service-owned merge-conflict repair"
          : `max merge gate failures reached (${reviewRound}/${maxMergeGateFailures})`
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

  private async handleServicePreparedMergeConflict(
    issue: Issue,
    lifecycle: IssueLifecycleRecord,
    report: IssueCompletionReportRecord,
    gate: MergeGateStatus,
    sourceState: string,
    livePullRequest: PullRequestDetails,
    baseObservation: LiveBaseObservation,
    workerRun: RunRecord | null,
    github: MergePolicyGitHubClient,
  ): Promise<MergePolicyResult> {
    const conflictsState = this.options.config.mergePolicy.conflictsState;
    if (conflictsState === null) {
      return this.handleMergeGateFailure(issue, lifecycle, report, gate, sourceState, null);
    }
    const pullRequest = gate.pullRequest;
    const branchName = requireValue(pullRequest.branch, "Service-owned conflict preparation requires a pull request branch");
    const workspacePath = workerRun?.workspacePath ?? lifecycle.summaryPointers.workspacePath;
    if (!workspacePath) {
      throw new SymphonyError("invalid_request", "Service-owned conflict preparation requires the worker workspace path");
    }
    const conflictGit = this.options.conflictGit ?? new ServiceOwnedMergeConflictGit();
    const authHeader = await github.gitAuthHeader();
    const preparation = await conflictGit.prepare({
      workspacePath,
      branchName,
      expectedHeadSha: gate.headSha,
      baseBranch: livePullRequest.baseBranch,
      observedPrBaseHeadSha: baseObservation.observedPrBaseHeadSha,
      liveBaseHeadSha: baseObservation.liveBaseHeadSha,
      authHeader,
    });
    let resolvedHeadSha: string | null = null;
    let pullRequestHeadSha = gate.headSha;
    if (preparation.status === "clean") {
      resolvedHeadSha = preparation.rebasedHeadSha;
      pullRequestHeadSha = preparation.rebasedHeadSha;
      await conflictGit.publishPreparedHead({
        workspacePath,
        branchName,
        previousRemoteHeadSha: gate.headSha,
        authHeader,
      });
    }

    const operations =
      preparation.status === "conflicted"
        ? planMergeConflictsWritebacks(
            {
              issue,
              mergeId: `merge:${issue.id}:${gate.headSha}`,
              fromState: sourceState,
              conflictsState,
              pullRequest: {
                ...pullRequest,
                headSha: pullRequestHeadSha,
              },
              mergeableState: livePullRequest.mergeableState,
              reason: gate.mergeability?.reason ?? "Pull request has merge conflicts with the base branch",
            },
            this.options.config,
          )
        : [];
    await this.requireMergeGateWritebacksSucceeded(issue, operations, preparation.status === "conflicted" ? conflictsState : null);

    const now = new Date().toISOString();
    const conflict = buildServicePreparedMergeConflict({
      issue,
      gate,
      sourceState,
      conflictsState,
      mergeableState: livePullRequest.mergeableState,
      preparation,
      resolvedHeadSha,
      pullRequestHeadSha,
      maxFixTurns: this.options.config.mergePolicy.maxConflictFixTurns,
      now,
    });
    const updated = await this.options.lifecycleStore.updateIssue(issue, {
      phase: preparation.status === "clean" ? "passed" : "merge_conflict_resolution",
      blockedReason: null,
      mergeGate: null,
      mergeConflict: {
        ...conflict,
        writebackOperationKeys: operations.map((operation) => operation.idempotencyKey),
      },
      summaryPointers: {
        ciStatus: preparation.status === "clean" ? "success" : "conflicted",
        prUrl: pullRequest.url,
        prNumber: pullRequest.number,
        prHeadSha: pullRequestHeadSha,
        prBranch: pullRequest.branch,
        workspacePath,
      },
    });
    const storedConflict = updated.mergeConflict ?? conflict;
    return { status: "conflict_dispatched", gate, conflict: storedConflict };
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
      mergeability: gate.mergeability,
      reviewRound,
      maxReviewRounds: this.options.config.reviewLoop.failureLimits.mergeGateFailures,
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

  private pendingConflictsWhileTrackerCatchesUp(issue: Issue, lifecycle: IssueLifecycleRecord): MergePolicyResult | null {
    const conflict = lifecycle.mergeConflict;
    if (
      lifecycle.phase !== "merge_conflict_resolution" ||
      conflict === null ||
      conflict.status !== "open" ||
      conflict.resolutionStatus !== "pending" ||
      statesEqual(issue.state, conflict.conflictsState)
    ) {
      return null;
    }
    const reportPullRequest = latestCompletionReport(lifecycle)?.pullRequest ?? null;
    if (
      reportPullRequest === null ||
      conflict.pullRequest.number !== reportPullRequest.number ||
      conflict.pullRequest.url !== reportPullRequest.url ||
      conflict.pullRequest.branch !== reportPullRequest.branch
    ) {
      return null;
    }
    return {
      status: "blocked_conflicts",
      headSha: conflict.currentHeadSha,
      mergeableState: conflict.mergeableState,
    };
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
      return {
        kind: "passed",
        checkStatus: { requiredChecks: [], passedChecks: [], noCiEvidence },
        gate: emptyGateStatus(gateId, pullRequest, headSha, requiredChecks),
      };
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
    const baseGate: MergeGateStatus = {
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
      mergeability: null,
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
    return { kind: "passed", checkStatus: { requiredChecks, passedChecks: requiredChecks, noCiEvidence: null }, gate: baseGate };
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
  requireMatchesAny("lifecycle PR head SHA", lifecycle.summaryPointers.prHeadSha, [
    pullRequest.headSha,
    lifecycle.mergeConflict?.currentHeadSha,
    lifecycle.mergeConflict?.resolvedHeadSha,
  ]);
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

function resolvedMergeConflictForIssue(
  issue: Issue,
  lifecycle: IssueLifecycleRecord,
  config: ServiceConfig,
): IssueMergeConflictMetadata | null {
  const conflictsState = config.mergePolicy.conflictsState;
  const mergeConflict = lifecycle.mergeConflict;
  if (conflictsState === null || mergeConflict?.resolutionStatus !== "resolved") return null;
  if (statesEqual(issue.state, conflictsState)) return mergeConflict;
  if (
    mergeConflict.servicePreparation?.strategy === "squash_rebase" &&
    mergeConflict.servicePreparation.status === "finalized" &&
    config.mergePolicy.sourceStates.some((sourceState) => statesEqual(issue.state, sourceState))
  ) {
    return mergeConflict;
  }
  return null;
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

function buildServicePreparedMergeConflict(input: {
  issue: Issue;
  gate: MergeGateStatus;
  sourceState: string;
  conflictsState: string;
  mergeableState: string | null;
  preparation: ServiceOwnedMergeConflictPreparationResult;
  resolvedHeadSha: string | null;
  pullRequestHeadSha: string;
  maxFixTurns: number;
  now: string;
}): IssueMergeConflictMetadata {
  const resolved = input.preparation.status === "clean";
  return {
    id: `merge-conflict:${input.issue.id}:${input.gate.headSha}:${input.preparation.liveBaseHeadSha}`,
    status: resolved ? "resolved" : "open",
    resolutionStatus: resolved ? "resolved" : "pending",
    pullRequest: {
      ...input.gate.pullRequest,
      headSha: input.pullRequestHeadSha,
    },
    approvedHeadSha: input.gate.headSha,
    currentHeadSha: input.resolvedHeadSha ?? input.gate.headSha,
    resolvedHeadSha: input.resolvedHeadSha,
    baseBranch: input.gate.mergeability?.baseBranch ?? null,
    baseHeadSha: input.preparation.liveBaseHeadSha,
    sourceState: input.sourceState,
    conflictsState: input.conflictsState,
    reason: input.gate.mergeability?.reason ?? "Pull request has merge conflicts with the base branch",
    mergeableState: input.mergeableState,
    servicePreparation: {
      strategy: "squash_rebase",
      status: resolved ? "finalized" : "conflicted",
      originalHeadSha: input.preparation.originalHeadSha,
      observedPrBaseHeadSha: input.preparation.observedPrBaseHeadSha,
      liveBaseHeadSha: input.preparation.liveBaseHeadSha,
      preparedBaseHeadSha: input.preparation.preparedBaseHeadSha,
      mergeBaseSha: input.preparation.mergeBaseSha,
      squashCommitSha: input.preparation.squashCommitSha,
      conflictedFiles: input.preparation.conflictedFiles,
      preparedAt: input.now,
      finalizedAt: resolved ? input.now : null,
      finalizedHeadSha: input.resolvedHeadSha,
    },
    detectedAt: input.now,
    updatedAt: input.now,
    fixTurnCount: 0,
    maxFixTurns: input.maxFixTurns,
    lastConflictFixRunId: null,
    lastConflictResolutionReportId: null,
    attemptRunIds: [],
    writebackOperationKeys: [],
    blockedAt: null,
    blockedReason: null,
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
  if (
    mergeConflict.servicePreparation?.strategy === "squash_rebase" &&
    mergeConflict.servicePreparation.status === "finalized" &&
    mergeConflict.servicePreparation.originalHeadSha === approvedHeadSha &&
    mergeConflict.servicePreparation.finalizedHeadSha === resolvedHeadSha
  ) {
    return;
  }
  const approvedHeadIsAncestor = await github.isAncestor({ ancestorSha: approvedHeadSha, descendantSha: resolvedHeadSha });
  if (!approvedHeadIsAncestor) {
    throw new SymphonyError(
      "invalid_request",
      "Resolved merge conflict head does not descend from the approved head; approval cannot be carried forward",
    );
  }
}

function validateLivePullRequestMetadata(
  livePullRequest: PullRequestDetails,
  expected: CompletionReportPullRequestRef,
  expectedHeadSha: string,
): void {
  requireMatches("live PR number", livePullRequest.number, expected.number);
  requireMatches("live PR URL", livePullRequest.url, expected.url);
  requireMatches("live PR branch", livePullRequest.headBranch, expected.branch);
}

function latestMergeApprovalPassVerdict(
  lifecycle: IssueLifecycleRecord,
  allowConflictResolutionCarryForward: boolean,
): IssueReviewVerdictRecord | null {
  const current = latestCurrentApprovalPassVerdict(lifecycle);
  if (current !== null || !allowConflictResolutionCarryForward) return current;
  for (const verdict of lifecycle.reviewVerdicts.slice().reverse()) {
    if (verdict.issueId !== lifecycle.issueId || verdict.issueIdentifier !== lifecycle.issueIdentifier) continue;
    if (verdict.verdict !== "pass" || verdict.reviewer === MERGE_GATE_REVIEWER) continue;
    return verdict;
  }
  return null;
}

function isOpenPullRequest(livePullRequest: PullRequestDetails): boolean {
  return livePullRequest.state === null || livePullRequest.state.toLowerCase() === "open";
}

function mergeabilityStateFromPullRequest(
  livePullRequest: PullRequestDetails,
  pullRequest: CompletionReportPullRequestRef,
  headSha: string,
  baseObservation: LiveBaseObservation,
): IssueMergeGateMergeabilityState {
  const mergeableState = livePullRequest.mergeableState?.toLowerCase() ?? null;
  let status: IssueMergeGateMergeabilityState["status"];
  let reason: string | null = null;
  if (livePullRequest.mergeable === null || mergeableState === "unknown") {
    status = "unknown";
    reason = "Pull request mergeability is still being computed";
  } else if (livePullRequest.mergeable === true) {
    status = "mergeable";
  } else if (mergeableState === "dirty") {
    status = "conflicted";
    reason = "Pull request has merge conflicts with the base branch";
  } else {
    const stateDescription = mergeableState === null ? "unknown" : mergeableState;
    status = "blocked";
    reason = `Pull request is not currently mergeable: ${stateDescription}`;
  }
  return {
    status,
    pullRequest: { ...pullRequest, headSha },
    mergeable: livePullRequest.mergeable,
    mergeableState,
    reason,
    baseBranch: livePullRequest.baseBranch,
    baseHeadSha: baseObservation.liveBaseHeadSha,
    observedBaseHeadSha: baseObservation.observedPrBaseHeadSha,
    checkedAt: new Date().toISOString(),
  };
}

interface LiveBaseObservation {
  baseBranch: string;
  observedPrBaseHeadSha: string | null;
  liveBaseHeadSha: string;
  rewritten: boolean;
}

async function resolveLiveBaseObservation(
  github: MergePolicyGitHubClient,
  livePullRequest: PullRequestDetails,
): Promise<LiveBaseObservation> {
  const liveBaseHeadSha = await github.getBranchHeadSha({ branchName: livePullRequest.baseBranch });
  const observedPrBaseHeadSha = livePullRequest.baseHeadSha;
  if (observedPrBaseHeadSha === liveBaseHeadSha) {
    return { baseBranch: livePullRequest.baseBranch, observedPrBaseHeadSha, liveBaseHeadSha, rewritten: false };
  }
  let rewritten = false;
  try {
    rewritten = !(await github.isAncestor({ ancestorSha: observedPrBaseHeadSha, descendantSha: liveBaseHeadSha }));
  } catch {
    rewritten = true;
  }
  return { baseBranch: livePullRequest.baseBranch, observedPrBaseHeadSha, liveBaseHeadSha, rewritten };
}

function baseRewriteMergeabilityState(
  livePullRequest: PullRequestDetails,
  pullRequest: CompletionReportPullRequestRef,
  headSha: string,
  baseObservation: LiveBaseObservation,
): IssueMergeGateMergeabilityState {
  return {
    status: "blocked",
    pullRequest: { ...pullRequest, headSha },
    mergeable: livePullRequest.mergeable,
    mergeableState: livePullRequest.mergeableState?.toLowerCase() ?? null,
    reason: "Pull request base branch changed non-fast-forward while mergeability was being evaluated",
    baseBranch: baseObservation.baseBranch,
    baseHeadSha: baseObservation.liveBaseHeadSha,
    observedBaseHeadSha: baseObservation.observedPrBaseHeadSha,
    checkedAt: new Date().toISOString(),
  };
}

function mergeGateDecisionWithMergeability(
  decision: MergeGateDecision,
  mergeability: IssueMergeGateMergeabilityState,
): MergeGateDecision {
  const gate = gateWithMergeability(decision.gate, mergeability);
  if (mergeability.status === "unknown") return { kind: "pending", gate };
  if (mergeability.status === "conflicted") return { kind: "failure", gate };
  if (decision.kind === "passed") return { ...decision, gate };
  return { ...decision, gate };
}

function gateWithMergeability(gate: MergeGateStatus, mergeability: IssueMergeGateMergeabilityState): MergeGateStatus {
  const blockers = [...gate.failedChecks, ...gate.actionableMissingChecks];
  return {
    ...gate,
    mergeability,
    blockerFingerprint: blockerFingerprint(gate.headSha, blockers, mergeability),
  };
}

function formatMergeabilityEvidence(mergeability: IssueMergeGateMergeabilityState): string[] {
  return [
    `Mergeability status: ${mergeability.status}`,
    `GitHub mergeable: ${mergeability.mergeable === null ? "unknown" : String(mergeability.mergeable)}`,
    `GitHub mergeable_state: ${mergeability.mergeableState ?? "unknown"}`,
    `Mergeability reason: ${mergeability.reason ?? "n/a"}`,
    `Base branch: ${mergeability.baseBranch ?? "n/a"}`,
    `Base head SHA: ${mergeability.baseHeadSha ?? "n/a"}`,
    ...(mergeability.observedBaseHeadSha !== null && mergeability.observedBaseHeadSha !== mergeability.baseHeadSha
      ? [`Observed PR base head SHA: ${mergeability.observedBaseHeadSha}`]
      : []),
  ];
}

function mergeabilityFinding(mergeability: IssueMergeGateMergeabilityState | null): string | null {
  if (mergeability?.status === "conflicted") {
    return mergeability.reason ?? "Pull request has merge conflicts with the base branch";
  }
  if (mergeability?.status === "blocked") {
    return mergeability.reason ?? "Pull request is not currently mergeable";
  }
  return null;
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
  serviceMerge: ResolvedCredential | null,
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
      profile: serviceMerge?.profileName ?? null,
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

function blockerFingerprint(
  headSha: string,
  blockers: MergeGateCheckEvidence[],
  mergeability: IssueMergeGateMergeabilityState | null = null,
): string | null {
  const segments = blockers
    .map((check) => `${check.name}:${check.status}`)
    .sort();
  if (mergeability?.status === "conflicted") {
    segments.push(`mergeability:${mergeability.mergeableState ?? "unknown"}:${mergeability.reason ?? "conflicted"}`);
  }
  if (segments.length === 0) return null;
  return `${headSha}:${segments.sort().join("|")}`;
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

function shouldRefreshSameMergeGateBlocker(lifecycle: IssueLifecycleRecord, gate: MergeGateStatus): boolean {
  if (!isSameMergeGateBlocker(lifecycle, gate)) return false;
  const current = lifecycle.mergeGate ?? null;
  if (current?.status === "repair_dispatched" && hasCompletedRepairApproval(lifecycle, current)) return false;
  return true;
}

function hasCompletedRepairApproval(lifecycle: IssueLifecycleRecord, gate: IssueMergeGateState): boolean {
  if (!gate.repairRunId || !gate.repairReportId) return false;
  if (lifecycle.lastCompletionReportId !== gate.repairReportId) return false;
  const repairReport = lifecycle.completionReports.find((report) => report.id === gate.repairReportId) ?? null;
  if (!repairReport || repairReport.runId !== gate.repairRunId) return false;
  if (repairReport.acceptedAt.trim().length === 0) return false;
  if (repairReport.pullRequest?.number !== gate.pullRequest.number) return false;
  if (repairReport.pullRequest?.headSha !== gate.headSha) return false;
  if (gate.gateReportId && repairReport.id === gate.gateReportId) return false;

  const gateVerdict = lifecycle.reviewVerdicts.find((verdict) => verdict.id === gate.id && isMergeGateVerdict(verdict)) ?? null;
  if (!gateVerdict) return false;
  const approvalVerdict = latestCurrentApprovalPassVerdict(lifecycle);
  if (!approvalVerdict) return false;
  const repairAcceptedAt = Date.parse(repairReport.acceptedAt);
  const approvalSubmittedAt = Date.parse(approvalVerdict.submittedAt);
  const gateFailedAt = Date.parse(gateVerdict.submittedAt);
  if (!Number.isFinite(repairAcceptedAt) || !Number.isFinite(approvalSubmittedAt) || !Number.isFinite(gateFailedAt)) return false;
  return repairAcceptedAt > gateFailedAt && approvalSubmittedAt > repairAcceptedAt;
}

function refreshActiveMergeGateObservation(
  lifecycle: IssueLifecycleRecord,
  gate: MergeGateStatus,
  fallbackWritebackOperationKeys: string[],
): IssueMergeGateState | null {
  const current = lifecycle.mergeGate ?? null;
  if (
    current === null ||
    current.id !== gate.id ||
    current.headSha !== gate.headSha ||
    (current.status !== "repair_dispatched" && current.status !== "blocked")
  ) {
    return null;
  }
  const writebackOperationKeys =
    current.writebackOperationKeys.length > 0 ? current.writebackOperationKeys : fallbackWritebackOperationKeys;
  return {
    ...current,
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
    mergeability: gate.mergeability,
    blockerFingerprint: current.blockerFingerprint ?? gate.blockerFingerprint,
    writebackOperationKeys,
    updatedAt: new Date().toISOString(),
  };
}

function refreshedActiveGateLastReviewVerdictId(lifecycle: IssueLifecycleRecord, gate: IssueMergeGateState): string | null {
  if (gate.status === "repair_dispatched" && hasRepairGateClearance(lifecycle, gate)) {
    return lifecycle.lastReviewVerdictId;
  }
  return gate.id;
}

function mergeGateStateFromStatus(
  gate: MergeGateStatus,
  status: IssueMergeGateState["status"],
  lifecycle: IssueLifecycleRecord,
  gateRunId: string | null,
  gateReportId: string | null,
  reviewRound?: number,
): IssueMergeGateState {
  const previous = lifecycle.mergeGate?.id === gate.id ? lifecycle.mergeGate : null;
  const effectiveReviewRound = reviewRound ?? previous?.reviewRound ?? 0;
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
    mergeability: gate.mergeability,
    reviewRound: effectiveReviewRound,
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
    mergeability: state.mergeability ?? null,
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
    mergeability: null,
    blockerFingerprint: null,
    writebackOperationKeys: [],
  };
}

function mergeGateFindings(gate: MergeGateStatus): string[] {
  const mergeability = mergeabilityFinding(gate.mergeability);
  return [
    ...gate.failedChecks.map((check) => `Required check failed: ${formatCheckEvidence(check)}`),
    ...gate.actionableMissingChecks.map((check) => `Required check missing (actionable): ${formatCheckEvidence(check)}`),
    ...(mergeability === null ? [] : [mergeability]),
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
    ...(gate.mergeability === null || gate.mergeability.status === "mergeable" ? [] : formatMergeabilityEvidence(gate.mergeability)),
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

function requireMatchesAny(
  label: string,
  actual: string | number | null | undefined,
  expected: Array<string | number | null | undefined>,
): void {
  if (expected.some((item) => actual === item)) return;
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

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
import type { IssueBaseRefObservation } from "../BaseRefVerification.js";
import type { ResolvedCredential } from "../config/CredentialProfiles.js";
import { SymphonyError } from "../errors.js";
import {
  activeBlockerProvenance,
  resolveActiveBlockerProvenancePatch,
} from "../BlockerProvenance.js";
import type { Logger } from "../logging/StructuredLogger.js";
import type { IssueTransitionKind } from "../orchestration/IssueOrchestrationState.js";
import type {
  CompletionReportPullRequestRef,
  IssueCompletionReportRecord,
  IssueLifecycleRecord,
  IssueLifecyclePatch,
  IssueLifecycleStore,
  IssueMergeGateCheckOutcome,
  IssueMergeGateMergeabilityState,
  IssueMergeConflictMetadata,
  IssuePreservedWorktreeStash,
  IssueMergeMetadata,
  IssueMergeGateState,
  IssueMergeGateResultRecord,
  IssueReviewVerdictRecord,
} from "../persistence/IssueLifecycleStore.js";
import {
  isSupersededLifecycleRecord,
  latestCurrentApprovalPassVerdict,
  latestCurrentCompletionReport,
} from "../persistence/IssueLifecycleStore.js";
import type { RunRecord, RunTranscriptStore } from "../persistence/RunTranscriptStore.js";
import type { TrackerClient } from "../tracker/TrackerClient.js";
import type { Issue } from "../types.js";
import {
  planBaseRefRepairWritebacks,
  planMergeCompletedWritebacks,
  planMergeConflictsWritebacks,
  planMergeGateBlockedWritebacks,
  planMergeGateHeadSupersessionWritebacks,
  planMergeGateRepairWritebacks,
  type MergeGateCheckEvidence,
} from "../writeback/TransitionPolicy.js";
import type { WritebackOperation, WritebackProcessor } from "../writeback/WritebackOutbox.js";
import { bindWritebackOperationToLifecycle } from "../writeback/WritebackOutbox.js";
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
  type ServiceOwnedPreservedStashApplyResult,
  type ServiceOwnedMergeConflictPreparationResult,
  type ServiceOwnedLocalBaseRefreshResult,
} from "./ServiceOwnedMergeConflictGit.js";

const MERGE_GATE_REVIEWER = "symphony-merge-gate";

type MergeGateFailureRecord = Pick<IssueMergeGateResultRecord | IssueReviewVerdictRecord, "id" | "submittedAt" | "writebackOperationKeys">;

type PreservedStashQueueRestoreResult =
  | {
      status: "clean";
      stashes: IssuePreservedWorktreeStash[];
    }
  | {
      status: "conflicted";
      stashes: IssuePreservedWorktreeStash[];
      stashApply: Extract<ServiceOwnedPreservedStashApplyResult, { status: "conflicted" }>;
    };

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
  | { status: "base_ref_repaired"; headSha: string }
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

export interface MergePolicyObservation {
  version: 1;
  inputFingerprint: string;
  observedAt: string;
  status: "ready" | "skipped";
  observationKind: MergePolicyObservationKind;
  reason: string | null;
  latestIssue: Issue;
  sourceState: string | null;
  report: IssueCompletionReportRecord | null;
  approvedPullRequest: CompletionReportPullRequestRef | null;
  approvedHeadSha: string | null;
  pullRequest: CompletionReportPullRequestRef | null;
  headSha: string | null;
  livePullRequest: PullRequestDetails | null;
  baseObservation: LiveBaseObservation | null;
  resolvedConflict: IssueMergeConflictMetadata | null;
  gate: MergeGateStatus | null;
  decisionKind: MergeGateDecision["kind"] | null;
  checkStatus: IssueMergeMetadata["checkStatus"] | null;
  workerRun: RunRecord | null;
  approvalVerdict: IssueReviewVerdictRecord | null;
  existingGateFailure: MergeGateFailureRecord | null;
  serviceMergeLogin: string | null;
  /**
   * Legacy read compatibility for snapshots written before observation kinds
   * became the ruleset input. The active orchestrator path no longer consumes
   * this field for transition selection.
   */
  nextTransitionKind?: IssueTransitionKind | "noop";
}

export type MergePolicyObservationKind =
  | "skipped"
  | "already_done"
  | "done_writeback_required"
  | "conflict_base_drifted"
  | "waiting_conflict_state"
  | "head_superseded"
  | "stale_gate"
  | "base_rewritten"
  | "service_preparable_conflict"
  | "wait_active_blocked_gate"
  | "wait_repair_clearance"
  | "same_gate_blocker_refresh"
  | "active_gate_observation_refresh"
  | "checks_pending"
  | "auto_resolve_gate"
  | "merge_gate_failure"
  | "merge_ready"
  | "already_merged_pull_request";

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

export interface MergePolicyDoneWritebackPlan {
  latestIssue: Issue;
  sourceState: string;
  merge: IssueMergeMetadata;
  operation: Parameters<WritebackProcessor["enqueueAndProcess"]>[0];
}

export interface MergePolicyMergePlan {
  lifecycle: IssueLifecycleRecord;
  report: IssueCompletionReportRecord;
  verdict: IssueReviewVerdictRecord;
  workerRun: RunRecord | null;
  pullRequest: CompletionReportPullRequestRef;
  headSha: string;
  livePullRequest: PullRequestDetails;
  checkStatus: IssueMergeMetadata["checkStatus"];
  sourceState: string;
  mergeId: string;
  doneTransitionOperationKey: string;
}

export interface MergePolicyRecordedMerge {
  sourceState: string;
  merge: IssueMergeMetadata;
}

export interface MergePolicyGateFailurePlan {
  lifecycle: IssueLifecycleRecord;
  report: IssueCompletionReportRecord;
  gate: MergeGateStatus;
  sourceState: string;
  existingFailure: MergeGateFailureRecord | null;
  approvalVerdict: IssueReviewVerdictRecord | null;
  blocked: boolean;
  missingConflictState: boolean;
  reviewRound: number;
  maxMergeGateFailures: number;
  operations: Parameters<WritebackProcessor["enqueueAndProcess"]>[0][];
  storedResult: IssueMergeGateResultRecord;
}

export interface MergePolicyHeadSupersessionPlan {
  lifecycle: IssueLifecycleRecord;
  report: IssueCompletionReportRecord;
  pullRequest: CompletionReportPullRequestRef;
  previousHeadSha: string;
  livePullRequest: PullRequestDetails;
  sourceState: string;
  liveHeadSha: string;
  supersededGate: MergeGateStatus;
  lifecyclePatch: IssueLifecyclePatch;
  operations: Parameters<WritebackProcessor["enqueueAndProcess"]>[0][];
}

export interface MergePolicyConflictPreparationPlan {
  mode: "initial" | "base_refresh";
  lifecycle: IssueLifecycleRecord;
  gate: MergeGateStatus;
  sourceState: string;
  conflictsState: string;
  livePullRequest: PullRequestDetails;
  baseObservation: LiveBaseObservation;
  workspacePath: string;
  branchName: string;
  expectedHeadSha: string;
  previousRemoteHeadSha: string;
  baseBranch: string;
  mergeableState: string | null;
  existingWritebackOperationKeys: string[];
}

export interface MergePolicyConflictPreparationExecution {
  preparation: ServiceOwnedMergeConflictPreparationResult;
  authHeader: string;
  resolvedHeadSha: string | null;
  pullRequestHeadSha: string;
  preservedStash: IssuePreservedWorktreeStash | null;
  preservedStashes: IssuePreservedWorktreeStash[];
  stashApplyResult: ServiceOwnedPreservedStashApplyResult | null;
  finalPreservedStash: IssuePreservedWorktreeStash | null;
}

export interface MergePolicyConflictWritebackPlan {
  operations: Parameters<WritebackProcessor["enqueueAndProcess"]>[0][];
  expectedState: string | null;
}

export class MergePolicyService {
  constructor(private readonly options: MergePolicyServiceOptions) {
    this.options.writeback?.bindLifecycleStore(this.options.lifecycleStore);
  }

  requireGatedServiceConfiguration(): void {
    const config = this.options.config;
    if (config.mergePolicy.mode !== "gated") {
      throw new SymphonyError("invalid_request", "Merge policy is not gated");
    }
    if (!config.writeback.enabled || config.writeback.mode !== "live" || !this.options.writeback) {
      throw new SymphonyError("invalid_request", "Gated merge policy requires service-owned writeback");
    }

    const serviceLinear = resolveLinearClientConfig(config, "linear.writeback").credential;
    if (!serviceLinear) {
      throw new SymphonyError("invalid_request", "Gated merge policy requires service linear.writeback credentials");
    }
    const serviceMergeConfig = resolveGitHubClientConfig(config, "github.merge");
    if (!serviceMergeConfig.credential && serviceMergeConfig.github.app === null) {
      throw new SymphonyError(
        "invalid_request",
        "Gated merge policy requires service github.merge credentials or GitHub App installation auth",
      );
    }
  }

  async observeIssue(issue: Issue, inputFingerprint: string): Promise<MergePolicyObservation> {
    const config = this.options.config;
    const observedAt = new Date().toISOString();
    if (config.mergePolicy.mode !== "gated") {
      return this.skippedObservation(issue, inputFingerprint, observedAt, "merge policy is not gated");
    }
    this.requireGatedServiceConfiguration();

    const latestIssue = (await this.options.tracker.fetchIssueStatesByIds([issue.id]))[0] ?? issue;
    const lifecycle = await this.options.lifecycleStore.get(issue.id);
    if (!lifecycle) throw new SymphonyError("invalid_request", "Gated merge policy requires an issue lifecycle record");

    if (lifecycle.merge?.mergeCommitSha) {
      if (statesEqual(latestIssue.state, config.mergePolicy.doneState)) {
        return this.readyObservation({
          inputFingerprint,
          observedAt,
          latestIssue,
          sourceState: null,
          observationKind: "already_done",
          reason: "merge already recorded and tracker is already Done",
        });
      }
      const recoverySourceState = this.mergeSourceState(latestIssue, lifecycle);
      if (recoverySourceState === null) {
        throw new SymphonyError("invalid_request", "Gated merge Done recovery requires issue in Done or a merge source state");
      }
      return this.readyObservation({
        inputFingerprint,
        observedAt,
        latestIssue,
        sourceState: recoverySourceState,
        observationKind: "done_writeback_required",
        reason: "merge metadata exists but Done writeback is not verified",
      });
    }

    const conflictRefresh = await this.observeOpenMergeConflictBaseRefresh(latestIssue, lifecycle);
    if (conflictRefresh !== null) {
      return this.readyObservation({
        ...conflictRefresh,
        inputFingerprint,
        observedAt,
        latestIssue,
        observationKind: "conflict_base_drifted",
        reason: "service-prepared conflict base drifted",
      });
    }

    const sourceState = this.mergeSourceState(latestIssue, lifecycle);
    const staleConflictResult = this.pendingConflictsWhileTrackerCatchesUp(latestIssue, lifecycle);
    if (staleConflictResult !== null) {
      return this.readyObservation({
        inputFingerprint,
        observedAt,
        latestIssue,
        sourceState: null,
        observationKind: "waiting_conflict_state",
        reason: "waiting for tracker to reach merge conflict state",
      });
    }
    if (sourceState === null) {
      return this.skippedObservation(latestIssue, inputFingerprint, observedAt, `issue is not in a merge source state: ${latestIssue.state}`);
    }

    const report = latestCurrentCompletionReport(lifecycle);
    if (!report) throw new SymphonyError("invalid_request", "Gated merge requires a latest completion report");

    const approvedPullRequest = requirePullRequest(report);
    const approvedHeadSha = requireValue(approvedPullRequest.headSha, "Completion report pull request head SHA is required for gated merge");
    const resolvedConflict = resolvedMergeConflictForIssue(latestIssue, lifecycle, config, approvedPullRequest);
    const pullRequest = resolvedConflict ? pullRequestRefForResolvedConflict(resolvedConflict) : approvedPullRequest;
    const headSha = requireValue(pullRequest.headSha, "Completion report pull request head SHA is required for gated merge");
    const github = this.options.client ?? createGitHubPullRequestClientForCapability(config, "github.merge");
    const livePullRequest = await github.getPullRequest({ pullRequestNumber: requireNumber(pullRequest.number) });
    validateLivePullRequestMetadata(livePullRequest, pullRequest, headSha);
    if (livePullRequest.headSha !== headSha) {
      return this.readyObservation({
        inputFingerprint,
        observedAt,
        latestIssue,
        sourceState,
        report,
        approvedPullRequest,
        approvedHeadSha,
        pullRequest,
        headSha,
        livePullRequest,
        resolvedConflict,
        observationKind: "head_superseded",
        reason: "live pull request head superseded approved head",
      });
    }

    const staleGateCandidate = lifecycle.mergeGate ?? null;
    const staleGateShouldRetire =
      staleGateCandidate !== null &&
      staleGateCandidate.status !== "resolved" &&
      staleGateCandidate.status !== "superseded" &&
      typeof headSha === "string" &&
      headSha.length > 0 &&
      pullRequest.number !== null &&
      pullRequest.number !== undefined &&
      staleGateCandidate.pullRequest.number === pullRequest.number &&
      staleGateCandidate.headSha !== headSha;
    if (staleGateShouldRetire) {
      return this.readyObservation({
        inputFingerprint,
        observedAt,
        latestIssue,
        sourceState,
        report,
        approvedPullRequest,
        approvedHeadSha,
        pullRequest,
        headSha,
        livePullRequest,
        resolvedConflict,
        observationKind: "stale_gate",
        reason: "active merge gate belongs to an older PR head",
      });
    }

    const gateId = mergeGateId(latestIssue.id, pullRequest, headSha);
    const baseObservation = await resolveLiveBaseObservation(github, livePullRequest);
    if (baseObservation.rewritten) {
      const gate = gateWithMergeability(
        emptyGateStatus(gateId, pullRequest, headSha, config.mergePolicy.requiredChecks),
        baseRewriteMergeabilityState(livePullRequest, pullRequest, headSha, baseObservation),
      );
      const existingGateFailure = findMergeGateFailure(lifecycle, gateId);
      return this.readyObservation({
        inputFingerprint,
        observedAt,
        latestIssue,
        sourceState,
        report,
        approvedPullRequest,
        approvedHeadSha,
        pullRequest,
        headSha,
        livePullRequest,
        baseObservation,
        resolvedConflict,
        gate,
        decisionKind: "failure",
        existingGateFailure,
        observationKind: "base_rewritten",
        reason: "pull request base branch changed non-fast-forward",
      });
    }
    if (resolvedConflict) {
      await validateConflictApprovalCarryForward(github, resolvedConflict, approvedPullRequest, approvedHeadSha, headSha);
    }

    const approvalVerdict = latestMergeApprovalPassVerdict(lifecycle);
    const existingGateFailure = findMergeGateFailure(lifecycle, gateId);
    const checkDecision = await this.evaluateChecks(github, headSha, pullRequest, gateId, lifecycle);
    const decision = mergeGateDecisionWithMergeability(
      checkDecision,
      mergeabilityStateFromPullRequest(livePullRequest, pullRequest, headSha, baseObservation),
    );
    const workerRun = this.options.runStore ? await this.options.runStore.getRun(report.runId) : null;
    const base = {
      inputFingerprint,
      observedAt,
      latestIssue,
      sourceState,
      report,
      approvedPullRequest,
      approvedHeadSha,
      pullRequest,
      headSha,
      livePullRequest,
      baseObservation,
      resolvedConflict,
      gate: decision.gate,
      decisionKind: decision.kind,
      checkStatus: decision.kind === "passed" ? decision.checkStatus : null,
      workerRun,
      approvalVerdict,
      existingGateFailure,
    };

    if (decision.kind === "failure" && decision.gate.mergeability?.status === "conflicted" && config.mergePolicy.conflictsState !== null) {
      return this.readyObservation({
        ...base,
        observationKind: "service_preparable_conflict",
        reason: "pull request has service-preparable merge conflicts",
      });
    }
    if (decision.kind === "passed") {
      const activeGate = lifecycle.mergeGate ?? null;
      if (activeGate !== null && activeGate.id === gateId && activeGate.status !== "resolved" && activeGate.status !== "superseded") {
        if (activeGate.status === "blocked" && !canAutoResolveMergeGateOnCheckPass(lifecycle, gateId)) {
          return this.readyObservation({
            ...base,
            observationKind: "wait_active_blocked_gate",
            reason: "active blocked merge gate still requires operator action",
          });
        }
        if (activeGate.status === "repair_dispatched" && !hasRepairGateClearance(lifecycle, activeGate)) {
          return this.readyObservation({
            ...base,
            observationKind: "wait_repair_clearance",
            reason: "merge gate repair has not completed with approval",
          });
        }
      }
    }
    if (existingGateFailure && decision.kind === "failure") {
      if (shouldRefreshSameMergeGateBlocker(lifecycle, decision.gate)) {
        return this.readyObservation({
          ...base,
          observationKind: "same_gate_blocker_refresh",
          reason: "same merge gate blocker should refresh observation without duplicate writeback",
        });
      }
      return this.readyObservation({
        ...base,
        observationKind: "merge_gate_failure",
        reason: "merge gate failure changed or needs another repair/block action",
      });
    }
    if (decision.kind === "pending") {
      const refreshedMergeGate = refreshActiveMergeGateObservation(lifecycle, decision.gate, existingGateFailure?.writebackOperationKeys ?? []);
      return this.readyObservation({
        ...base,
        observationKind: refreshedMergeGate ? "active_gate_observation_refresh" : "checks_pending",
        reason: refreshedMergeGate ? "active merge gate observation should be refreshed" : "required checks or mergeability are pending",
      });
    }

    const verdict = latestMergeApprovalPassVerdict(lifecycle);
    const currentMergeGate = lifecycle.mergeGate ?? null;
    if (
      decision.kind === "passed" &&
      verdict &&
      currentMergeGate !== null &&
      currentMergeGate.id === gateId &&
      currentMergeGate.status === "blocked" &&
      canAutoResolveMergeGateOnCheckPass(lifecycle, gateId)
    ) {
      return this.readyObservation({
        ...base,
        approvalVerdict: verdict,
        observationKind: "auto_resolve_gate",
        reason: "blocked merge gate can auto-resolve after checks pass",
      });
    }
    this.validateLifecycle(lifecycle, report, verdict, workerRun, latestIssue);
    if (
      decision.kind === "passed" &&
      verdict &&
      currentMergeGate !== null &&
      currentMergeGate.id === gateId &&
      currentMergeGate.status !== "resolved" &&
      currentMergeGate.status !== "superseded" &&
      canAutoResolveMergeGateOnCheckPass(lifecycle, gateId)
    ) {
      return this.readyObservation({
        ...base,
        approvalVerdict: verdict,
        observationKind: "auto_resolve_gate",
        reason: "active merge gate can auto-resolve after checks pass",
      });
    }
    if (decision.kind === "failure") {
      return this.readyObservation({
        ...base,
        approvalVerdict: verdict,
        observationKind: "merge_gate_failure",
        reason: "merge gate failure requires repair or block",
      });
    }

    const openPullRequest = isOpenPullRequest(livePullRequest);
    const serviceMergeLogin = openPullRequest ? null : await github.getAuthenticatedLogin();
    return this.readyObservation({
      ...base,
      approvalVerdict: verdict,
      serviceMergeLogin,
      observationKind: openPullRequest ? "merge_ready" : "already_merged_pull_request",
      reason: openPullRequest ? "pull request is ready to merge" : "pull request is already merged",
    });
  }

  private skippedObservation(issue: Issue, inputFingerprint: string, observedAt: string, reason: string): MergePolicyObservation {
    return {
      version: 1,
      inputFingerprint,
      observedAt,
      status: "skipped",
      observationKind: "skipped",
      reason,
      latestIssue: issue,
      sourceState: null,
      report: null,
      approvedPullRequest: null,
      approvedHeadSha: null,
      pullRequest: null,
      headSha: null,
      livePullRequest: null,
      baseObservation: null,
      resolvedConflict: null,
      gate: null,
      decisionKind: null,
      checkStatus: null,
      workerRun: null,
      approvalVerdict: null,
      existingGateFailure: null,
      serviceMergeLogin: null,
    };
  }

  private readyObservation(
    input: Partial<Omit<MergePolicyObservation, "version" | "status">> &
      Pick<MergePolicyObservation, "inputFingerprint" | "observedAt" | "latestIssue" | "observationKind" | "reason">,
  ): MergePolicyObservation {
    return {
      version: 1,
      status: "ready",
      sourceState: null,
      report: null,
      approvedPullRequest: null,
      approvedHeadSha: null,
      pullRequest: null,
      headSha: null,
      livePullRequest: null,
      baseObservation: null,
      resolvedConflict: null,
      gate: null,
      decisionKind: null,
      checkStatus: null,
      workerRun: null,
      approvalVerdict: null,
      existingGateFailure: null,
      serviceMergeLogin: null,
      ...input,
    };
  }

  private async observeOpenMergeConflictBaseRefresh(
    issue: Issue,
    lifecycle: IssueLifecycleRecord,
  ): Promise<Partial<MergePolicyObservation> | null> {
    const conflictsState = this.options.config.mergePolicy.conflictsState;
    const conflict = lifecycle.mergeConflict;
    const servicePreparation = conflict?.servicePreparation ?? null;
    if (
      conflictsState === null ||
      conflict === null ||
      servicePreparation === null ||
      servicePreparation.strategy !== "squash_rebase" ||
      servicePreparation.status !== "conflicted" ||
      !statesEqual(issue.state, conflictsState)
    ) {
      return null;
    }
    if (conflict.status !== "open" && conflict.status !== "blocked") return null;
    const baseBranch = requireValue(conflict.baseBranch, "Service-owned conflict refresh requires the PR base branch");
    const github = this.options.client ?? createGitHubPullRequestClientForCapability(this.options.config, "github.merge");
    const livePullRequest = await github.getPullRequest({ pullRequestNumber: requireNumber(conflict.pullRequest.number) });
    validateLivePullRequestMetadata(livePullRequest, conflict.pullRequest, conflict.currentHeadSha);
    if (livePullRequest.headSha !== conflict.currentHeadSha || livePullRequest.baseBranch !== baseBranch) return null;
    const baseObservation = await resolveLiveBaseObservation(github, livePullRequest);
    if (baseObservation.liveBaseHeadSha === servicePreparation.preparedBaseHeadSha) return null;
    const gate = gateWithMergeability(
      emptyGateStatus(mergeGateId(issue.id, conflict.pullRequest, conflict.currentHeadSha), conflict.pullRequest, conflict.currentHeadSha, this.options.config.mergePolicy.requiredChecks),
      mergeabilityStateFromPullRequest(livePullRequest, conflict.pullRequest, conflict.currentHeadSha, baseObservation),
    );
    return {
      sourceState: conflict.sourceState,
      pullRequest: conflict.pullRequest,
      headSha: conflict.currentHeadSha,
      livePullRequest,
      baseObservation,
      resolvedConflict: conflict,
      gate,
      decisionKind: "failure",
    };
  }

  private mergeGateFailureTransitionKind(
    lifecycle: IssueLifecycleRecord,
    gate: MergeGateStatus,
    existingFailure: MergeGateFailureRecord | null,
  ): IssueTransitionKind {
    const newRepairCycle = existingFailure === null || lifecycle.phase === "passed";
    const previousMergeGateRound = previousMergeGateRepairRound(lifecycle, gate);
    const reviewRound = newRepairCycle ? previousMergeGateRound + 1 : previousMergeGateRound;
    const maxMergeGateFailures = this.options.config.reviewLoop.failureLimits.mergeGateFailures;
    const missingConflictState = gate.mergeability?.status === "conflicted" && this.options.config.mergePolicy.conflictsState === null;
    return missingConflictState || reviewRound >= maxMergeGateFailures ? "merge_policy_block_failure" : "merge_policy_dispatch_repair";
  }

  async writeDoneState(issue: Issue): Promise<MergePolicyResult> {
    const plan = await this.planDoneStateWriteback(issue);
    await this.applyDoneStateWriteback(plan);
    await this.verifyDoneState(plan.latestIssue);
    return { status: "already_merged", merge: plan.merge };
  }

  async planDoneStateWriteback(issue: Issue): Promise<MergePolicyDoneWritebackPlan> {
    this.requireGatedServiceConfiguration();
    const latestIssue = (await this.options.tracker.fetchIssueStatesByIds([issue.id]))[0] ?? issue;
    const lifecycle = await this.options.lifecycleStore.get(issue.id);
    if (!lifecycle?.merge) throw new SymphonyError("invalid_request", "Gated merge Done writeback requires lifecycle merge metadata");
    const sourceState = this.mergeSourceState(latestIssue, lifecycle);
    if (sourceState === null) {
      throw new SymphonyError("invalid_request", "Gated merge Done recovery requires issue in Done or a merge source state");
    }
    const operation = this.planDoneTransition(latestIssue, lifecycle.merge.id, sourceState);
    if (operation.idempotencyKey !== lifecycle.merge.doneTransitionOperationKey) {
      throw new SymphonyError("invalid_request", "Gated merge Done writeback key does not match lifecycle merge metadata");
    }
    return { latestIssue, sourceState, merge: lifecycle.merge, operation };
  }

  async applyDoneStateWriteback(plan: MergePolicyDoneWritebackPlan): Promise<WritebackOperation> {
    return this.enqueueDoneWriteback(plan.operation);
  }

  async verifyDoneState(issue: Issue): Promise<{ state: string }> {
    if (statesEqual(issue.state, this.options.config.mergePolicy.doneState)) return { state: issue.state };
    const latest = (await this.options.tracker.fetchIssueStatesByIds([issue.id]))[0] ?? null;
    if (!latest || !statesEqual(latest.state, this.options.config.mergePolicy.doneState)) {
      throw new SymphonyError("invalid_request", "Gated merge Done writeback could not be verified");
    }
    return { state: latest.state };
  }

  async retireStaleGate(issue: Issue, observation: MergePolicyObservation): Promise<MergePolicyResult> {
    const lifecycle = await this.options.lifecycleStore.get(issue.id);
    if (!lifecycle || !observation.headSha || !observation.pullRequest) return { status: "skipped", reason: "stale merge gate is no longer current" };
    if (!shouldSilentlyRetireMergeGate(lifecycle.mergeGate, observation.headSha, observation.pullRequest.number)) {
      return { status: "skipped", reason: "stale merge gate is no longer active" };
    }
    await this.options.lifecycleStore.updateIssue(issue, {
      ...supersededMergeGateLifecyclePatch(lifecycle, lifecycle.mergeGate, observation.headSha),
    });
    return { status: "checks_pending", gate: gateStatusFromState(lifecycle.mergeGate) };
  }

  async markHeadSuperseded(issue: Issue, observation: MergePolicyObservation): Promise<MergePolicyResult> {
    const plan = await this.planHeadSupersession(issue, observation);
    const result = await this.recordHeadSupersessionLifecycle(issue, plan);
    await this.applyHeadSupersessionWritebacks(issue, plan);
    return result;
  }

  async planHeadSupersession(issue: Issue, observation: MergePolicyObservation): Promise<MergePolicyHeadSupersessionPlan> {
    const lifecycle = await this.options.lifecycleStore.get(issue.id);
    if (!lifecycle) throw new SymphonyError("invalid_request", "Gated merge policy requires an issue lifecycle record");
    const report = requireObservationValue(observation.report, "Head supersession requires observed completion report");
    const pullRequest = requireObservationValue(observation.pullRequest, "Head supersession requires observed pull request");
    const previousHeadSha = requireObservationValue(observation.headSha, "Head supersession requires observed head SHA");
    const livePullRequest = requireObservationValue(observation.livePullRequest, "Head supersession requires observed live pull request");
    const sourceState = requireObservationValue(observation.sourceState, "Head supersession requires observed source state");
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
    const rawOperations = planMergeGateHeadSupersessionWritebacks(
      { issue, gateId, fromState: sourceState, pullRequest, liveHeadSha, reportId: report.id },
      this.options.config,
    );
    const operationKeys = rawOperations.map((operation) => operation.idempotencyKey);
    const ownedSupersededPatch: IssueMergeGateState = {
      ...supersededPatch,
      writebackOperationKeys: operationKeys,
    };
    const lifecyclePatch: IssueLifecyclePatch = {
      ...(gate
        ? {
            ...inactiveMergeGateLifecyclePatch(lifecycle, gate, "superseded", liveHeadSha),
            mergeGate: ownedSupersededPatch,
          }
        : { mergeGate: ownedSupersededPatch }),
      phase: "implementation",
      blockedReason: null,
      lastReviewVerdictId: null,
      summaryPointers: { ciStatus: "head_superseded" },
    };
    const operations = rawOperations.map((operation) =>
      bindWritebackOperationToLifecycle(operation, {
        kind: "merge_gate",
        recordId: ownedSupersededPatch.id,
        status: "superseded",
        headSha: ownedSupersededPatch.headSha,
        supersededByHeadSha: liveHeadSha,
      }),
    );
    return {
      lifecycle,
      report,
      pullRequest,
      previousHeadSha,
      livePullRequest,
      sourceState,
      liveHeadSha,
      supersededGate: gateStatusFromState(ownedSupersededPatch),
      lifecyclePatch,
      operations,
    };
  }

  async applyHeadSupersessionWritebacks(
    issue: Issue,
    plan: MergePolicyHeadSupersessionPlan,
  ): Promise<{ operations: Array<{ operationKey: string; status: WritebackOperation["status"] }> }> {
    const results = await this.requireMergeGateWritebacksSucceeded(
      issue,
      plan.operations,
      this.options.config.writeback.dispatchState,
    );
    return {
      operations: results.map((operation) => ({ operationKey: operation.idempotencyKey, status: operation.status })),
    };
  }

  async recordHeadSupersessionLifecycle(issue: Issue, plan: MergePolicyHeadSupersessionPlan): Promise<MergePolicyResult> {
    await this.enqueueMergeGateWritebacks(plan.operations);
    await this.options.lifecycleStore.updateIssue(issue, plan.lifecyclePatch);
    return {
      status: "head_superseded",
      previousHeadSha: plan.previousHeadSha,
      liveHeadSha: plan.liveHeadSha,
      gate: plan.supersededGate,
    };
  }

  async refreshConflictBase(issue: Issue, observation: MergePolicyObservation): Promise<MergePolicyResult> {
    const plan = await this.planRefreshConflictBase(issue, observation);
    if (!plan) return { status: "skipped", reason: "merge conflict base no longer requires refresh" };
    const execution = await this.prepareServiceConflictBranch(issue, plan);
    if (execution.preparation.status === "clean") {
      await this.publishPreparedConflictHead(plan, execution);
      await this.restorePreservedStashAfterPreparedHead(issue, plan, execution);
    }
    const writebackPlan = this.planServiceConflictWritebacks(issue, plan, execution);
    const result = await this.recordServicePreparedMergeConflict(
      issue,
      plan,
      execution,
      writebackPlan,
    );
    await this.applyServiceConflictWritebacks(issue, plan, writebackPlan);
    return result;
  }

  async planRefreshConflictBase(
    issue: Issue,
    observation: MergePolicyObservation,
  ): Promise<MergePolicyConflictPreparationPlan | null> {
    const lifecycle = await this.options.lifecycleStore.get(issue.id);
    if (!lifecycle) throw new SymphonyError("invalid_request", "Gated merge policy requires an issue lifecycle record");
    const conflictsState = this.options.config.mergePolicy.conflictsState;
    const conflict = lifecycle.mergeConflict;
    const servicePreparation = conflict?.servicePreparation ?? null;
    if (
      conflictsState === null ||
      conflict === null ||
      servicePreparation === null ||
      servicePreparation.strategy !== "squash_rebase" ||
      servicePreparation.status !== "conflicted" ||
      !statesEqual(issue.state, conflictsState) ||
      (conflict.status !== "open" && conflict.status !== "blocked")
    ) {
      return null;
    }
    const branchName = requireValue(conflict.pullRequest.branch, "Service-owned conflict refresh requires a pull request branch");
    const baseBranch = requireValue(conflict.baseBranch, "Service-owned conflict refresh requires the PR base branch");
    const workspacePath = lifecycle.summaryPointers.workspacePath;
    if (!workspacePath) return null;
    const livePullRequest = requireObservationValue(observation.livePullRequest, "Merge conflict refresh requires observed live pull request");
    const baseObservation = requireObservationValue(observation.baseObservation, "Merge conflict refresh requires observed base");
    const gate = requireObservationValue(observation.gate, "Merge conflict refresh requires observed gate");
    validateLivePullRequestMetadata(livePullRequest, conflict.pullRequest, conflict.currentHeadSha);
    if (livePullRequest.headSha !== conflict.currentHeadSha || livePullRequest.baseBranch !== baseBranch) {
      return null;
    }
    if (baseObservation.liveBaseHeadSha === servicePreparation.preparedBaseHeadSha) {
      return null;
    }
    return {
      mode: "base_refresh",
      lifecycle,
      gate,
      sourceState: conflict.sourceState,
      conflictsState,
      livePullRequest,
      baseObservation,
      workspacePath,
      branchName,
      expectedHeadSha: conflict.currentHeadSha,
      previousRemoteHeadSha: conflict.currentHeadSha,
      baseBranch,
      mergeableState: livePullRequest.mergeableState,
      existingWritebackOperationKeys: conflict.writebackOperationKeys,
    };
  }

  async refreshSameGateBlocker(issue: Issue, observation: MergePolicyObservation): Promise<MergePolicyResult> {
    const lifecycle = await this.options.lifecycleStore.get(issue.id);
    const gate = requireObservationValue(observation.gate, "Merge gate refresh requires observed gate");
    const sourceState = requireObservationValue(observation.sourceState, "Merge gate refresh requires observed source state");
    if (!lifecycle) throw new SymphonyError("invalid_request", "Gated merge policy requires an issue lifecycle record");
    await this.retryDurableMergeGateResultWritebacks(issue, lifecycle, sourceState);
    const refreshedMergeGate = refreshActiveMergeGateObservation(lifecycle, gate, observation.existingGateFailure?.writebackOperationKeys ?? []);
    if (!refreshedMergeGate) {
      const activeGate = lifecycle.mergeGate ? gateStatusFromState(lifecycle.mergeGate) : gate;
      return lifecycle.mergeGate?.status === "blocked"
        ? { status: "blocked", gate: activeGate }
        : { status: "repair_dispatched", gate: activeGate };
    }
    const updated = await this.options.lifecycleStore.updateIssue(issue, {
      phase: lifecycle.phase,
      blockedReason: refreshedMergeGate.status === "blocked" ? lifecycle.blockedReason : null,
      lastReviewVerdictId: refreshedActiveGateLastReviewVerdictId(lifecycle, refreshedMergeGate),
      lastMergeGateResultId: observation.existingGateFailure?.id ?? lifecycle.lastMergeGateResultId ?? null,
      mergeGate: refreshedMergeGate,
      summaryPointers: { ciStatus: "failure" },
    });
    const stored = updated.mergeGate ?? refreshedMergeGate;
    return stored.status === "blocked" ? { status: "blocked", gate: gateStatusFromState(stored) } : { status: "repair_dispatched", gate: gateStatusFromState(stored) };
  }

  async observeChecksPending(issue: Issue, observation: MergePolicyObservation): Promise<MergePolicyResult> {
    const lifecycle = await this.options.lifecycleStore.get(issue.id);
    const gate = requireObservationValue(observation.gate, "Pending checks observation requires observed gate");
    if (!lifecycle) throw new SymphonyError("invalid_request", "Gated merge policy requires an issue lifecycle record");
    await this.options.lifecycleStore.updateIssue(issue, {
      phase: lifecycle.phase,
      blockedReason: null,
      lastReviewVerdictId:
        observation.existingGateFailure && observation.approvalVerdict && lifecycle.lastReviewVerdictId === observation.existingGateFailure.id
          ? observation.approvalVerdict.id
          : lifecycle.lastReviewVerdictId,
      mergeGate: mergeGateStateFromStatus(gate, "observing", lifecycle, null, null),
      summaryPointers: { ciStatus: "observing" },
    });
    return { status: "checks_pending", gate };
  }

  async autoResolveGate(issue: Issue, observation: MergePolicyObservation): Promise<MergePolicyResult> {
    const lifecycle = await this.options.lifecycleStore.get(issue.id);
    const gate = requireObservationValue(observation.gate, "Merge gate auto-resolve requires observed gate");
    const verdict = requireObservationValue(observation.approvalVerdict, "Merge gate auto-resolve requires approval verdict");
    if (!lifecycle) throw new SymphonyError("invalid_request", "Gated merge policy requires an issue lifecycle record");
    const activeGate = lifecycle.mergeGate?.id === gate.id ? lifecycle.mergeGate : null;
    if (!activeGate || !isActiveMergeGate(activeGate) || !canAutoResolveMergeGateOnCheckPass(lifecycle, gate.id)) {
      return { status: "checks_pending", gate };
    }
    await this.options.lifecycleStore.updateIssue(issue, {
      ...inactiveMergeGateLifecyclePatch(lifecycle, activeGate, "resolved"),
      phase: "passed",
      blockedReason: null,
      lastReviewVerdictId: verdict.id,
      summaryPointers: { ciStatus: "success" },
    });
    return { status: "checks_pending", gate };
  }

  async prepareConflict(issue: Issue, observation: MergePolicyObservation): Promise<MergePolicyResult> {
    const plan = await this.planServicePreparedMergeConflict(issue, observation);
    const execution = await this.prepareServiceConflictBranch(issue, plan);
    if (execution.preparation.status === "clean") {
      await this.publishPreparedConflictHead(plan, execution);
      await this.restorePreservedStashAfterPreparedHead(issue, plan, execution);
    }
    const writebackPlan = this.planServiceConflictWritebacks(issue, plan, execution);
    const result = await this.recordServicePreparedMergeConflict(
      issue,
      plan,
      execution,
      writebackPlan,
    );
    await this.applyServiceConflictWritebacks(issue, plan, writebackPlan);
    return result;
  }

  async repairBaseRefDrift(issue: Issue, observation: IssueBaseRefObservation): Promise<MergePolicyResult> {
    this.requireGatedServiceConfiguration();
    if (observation.classification !== "branch_not_based_on_live_base") {
      throw new SymphonyError("invalid_request", "Base ref repair requires a worktree head that is not based on the live base");
    }
    const latestIssue = (await this.options.tracker.fetchIssueStatesByIds([issue.id]))[0] ?? issue;
    const lifecycle = await this.options.lifecycleStore.get(issue.id);
    if (!lifecycle) throw new SymphonyError("invalid_request", "Base ref repair requires an issue lifecycle record");

    const workspacePath = requireValue(observation.workspacePath, "Base ref repair requires a workspace path");
    const branchName =
      observation.branchName ??
      lifecycle.summaryPointers.gitBranchName ??
      lifecycle.summaryPointers.prBranch ??
      lifecycle.summaryPointers.branchName;
    const originalHeadSha =
      observation.worktreeHeadSha ??
      lifecycle.summaryPointers.prHeadSha ??
      latestCurrentCompletionReport(lifecycle)?.pullRequest?.headSha;
    const baseBranch =
      observation.normalizedBaseBranch ??
      observation.baseRef ??
      lifecycle.summaryPointers.baseRef;
    const requiredBranchName = requireValue(branchName, "Base ref repair requires a branch name");
    const requiredOriginalHeadSha = requireValue(originalHeadSha, "Base ref repair requires the worktree head SHA");
    const requiredBaseBranch = requireValue(baseBranch, "Base ref repair requires a base branch");
    const pullRequest = pullRequestForBaseRefRepair(lifecycle, requiredBranchName, requiredOriginalHeadSha);
    const sourceState = latestIssue.state;
    const activeProvenance = activeBlockerProvenance(lifecycle);
    const blockerProvenanceId =
      activeProvenance !== null &&
      activeProvenance.sourceObservationFingerprint ===
        observation.inputFingerprint &&
      activeProvenance.classification === observation.classification &&
      activeProvenance.worktreeHeadSha === observation.worktreeHeadSha
        ? activeProvenance.id
        : null;
    const blockerResolutionPatch = resolveActiveBlockerProvenancePatch(
      lifecycle,
      {
        expectedObservation: observation,
        resolution: "base_ref_repair",
      },
    );

    const github = this.options.client ?? createGitHubPullRequestClientForCapability(this.options.config, "github.merge");
    const requiredLiveBaseHeadSha = requireValue(
      await github.getBranchHeadSha({ branchName: requiredBaseBranch }),
      "Base ref repair requires the live base head SHA",
    );
    const authHeader = await github.gitAuthHeader();
    const conflictGit =
      this.options.conflictGit ??
      new ServiceOwnedMergeConflictGit({
        journalDir: this.options.config.workspace.stateDir,
      });
    const operationId = `base-ref:${issue.id}:${requiredOriginalHeadSha}:${requiredLiveBaseHeadSha}`;
    let preservedStashes = preservedWorktreeStashesOf(lifecycle);
    const preservedStash = await conflictGit.preserveDirtyWorktree({
      workspacePath,
      branchName: requiredBranchName,
      baseBranch: requiredBaseBranch,
      operationId,
      source: "base_ref_repair",
      message: `Symphony preserved local changes before base-ref repair for ${issue.identifier}`,
    });
    if (preservedStash !== null) {
      preservedStashes = upsertPreservedWorktreeStash(
        preservedStashes,
        preservedStash,
      );
      await this.options.lifecycleStore.updateIssue(latestIssue, {
        preservedWorktreeStashes: preservedStashes,
      });
    }

    if (pullRequest === null) {
      return this.repairLocalOnlyBaseRefDrift({
        issue: latestIssue,
        conflictGit,
        workspacePath,
        branchName: requiredBranchName,
        baseBranch: requiredBaseBranch,
        originalHeadSha: requiredOriginalHeadSha,
        liveBaseHeadSha: requiredLiveBaseHeadSha,
        authHeader,
        operationId,
        sourceState,
        preservedStashes,
        blockerResolutionPatch,
        blockerProvenanceId,
      });
    }

    const preparation = await conflictGit.prepare({
      workspacePath,
      branchName: requiredBranchName,
      expectedHeadSha: requiredOriginalHeadSha,
      baseBranch: requiredBaseBranch,
      observedPrBaseHeadSha: observation.localBaseHeadShaBeforeFetch,
      liveBaseHeadSha: requiredLiveBaseHeadSha,
      authHeader,
    });

    if (preparation.status === "clean") {
      await conflictGit.publishPreparedHead({
        workspacePath,
        branchName: requiredBranchName,
        previousRemoteHeadSha: requiredOriginalHeadSha,
        authHeader,
      });
      const restore = await this.restorePreservedStashQueue({
        issue: latestIssue,
        conflictGit,
        workspacePath,
        branchName: requiredBranchName,
        stashes: preservedStashes,
      });
      preservedStashes = restore.stashes;
      if (restore.status === "conflicted") {
        return this.dispatchStashApplyConflict({
          issue: latestIssue,
          pullRequest: { ...pullRequest, headSha: preparation.rebasedHeadSha },
          operationId,
          sourceState,
          conflictsState: this.options.config.mergePolicy.conflictsState,
          workspacePath,
          branchName: requiredBranchName,
          baseBranch: requiredBaseBranch,
          baseHeadSha: requiredLiveBaseHeadSha,
          currentHeadSha: preparation.rebasedHeadSha,
          preservedStashes,
          stashApply: restore.stashApply,
          reason: "Preserved local changes conflicted while restoring after base-ref repair",
          blockerProvenanceId,
        });
      }
      const operations = planBaseRefRepairWritebacks(
        {
          issue: latestIssue,
          operationId,
          fromState: sourceState,
          branchName: requiredBranchName,
          baseBranch: requiredBaseBranch,
          previousHeadSha: requiredOriginalHeadSha,
          rebasedHeadSha: preparation.rebasedHeadSha,
          baseHeadSha: requiredLiveBaseHeadSha,
          mode: "pr_backed",
        },
        this.options.config,
      );
      const boundOperations = operations.map((operation) =>
        bindWritebackOperationToLifecycle(operation, {
          kind: "issue_checkpoint",
          phase: "implementation",
          prHeadSha: preparation.rebasedHeadSha,
          gitBranchName: requiredBranchName,
          baseRef: requiredBaseBranch,
          resolvedBlockerProvenanceId: blockerProvenanceId,
        }),
      );
      await this.enqueueMergeGateWritebacks(boundOperations);
      await this.options.lifecycleStore.updateIssue(latestIssue, {
        ...blockerResolutionPatch,
        phase: "implementation",
        blockedReason: null,
        mergeGate: null,
        mergeConflict: null,
        summaryPointers: {
          ciStatus: null,
          workspacePath,
          gitBranchName: requiredBranchName,
          prUrl: pullRequest.url,
          prNumber: pullRequest.number,
          prHeadSha: preparation.rebasedHeadSha,
          prBranch: requiredBranchName,
          baseRef: requiredBaseBranch,
        },
        preservedWorktreeStashes: preservedStashes,
      });
      await this.requireMergeGateWritebacksSucceeded(
        latestIssue,
        boundOperations,
        this.options.config.writeback.dispatchState,
      );
      return { status: "base_ref_repaired", headSha: preparation.rebasedHeadSha };
    }

    const conflictsState = this.options.config.mergePolicy.conflictsState;
    if (conflictsState === null) {
      throw new SymphonyError("invalid_request", "merge_policy.conflicts_state is required before Symphony can prepare a base-ref conflict repair");
    }
    const operations = planMergeConflictsWritebacks(
      {
        issue: latestIssue,
        mergeId: operationId,
        fromState: sourceState,
        conflictsState,
        pullRequest,
        mergeableState: "dirty",
        reason: "Worktree rebase over the live origin base produced conflicts",
      },
      this.options.config,
    );
    const now = new Date().toISOString();
    const conflict = buildBaseRefRepairMergeConflict({
      issue: latestIssue,
      pullRequest,
      sourceState,
      conflictsState,
      baseBranch: requiredBaseBranch,
      baseHeadSha: requiredLiveBaseHeadSha,
      preparation,
      blockerProvenanceId,
      maxFixTurns: this.options.config.mergePolicy.maxConflictFixTurns,
      now,
    });
    const boundOperations = operations.map((operation) =>
      bindWritebackOperationToLifecycle(operation, {
        kind: "merge_conflict",
        recordId: conflict.id,
      }),
    );
    await this.enqueueMergeGateWritebacks(boundOperations);
    const updated = await this.options.lifecycleStore.updateIssue(latestIssue, {
      phase: "merge_conflict_resolution",
      blockedReason: null,
      mergeGate: null,
      mergeConflict: {
        ...conflict,
        servicePreparation:
          conflict.servicePreparation?.strategy === "squash_rebase"
            ? {
                ...conflict.servicePreparation,
                preservedStash:
                  firstPendingCreatedPreservedStash(preservedStashes),
              }
            : conflict.servicePreparation,
        writebackOperationKeys: operations.map((operation) => operation.idempotencyKey),
      },
      preservedWorktreeStashes: preservedStashes,
      summaryPointers: {
        ciStatus: "conflicted",
        workspacePath,
        gitBranchName: requiredBranchName,
        prUrl: pullRequest.url,
        prNumber: pullRequest.number,
        prHeadSha: requiredOriginalHeadSha,
        prBranch: requiredBranchName,
        baseRef: requiredBaseBranch,
      },
    });
    await this.requireMergeGateWritebacksSucceeded(
      latestIssue,
      boundOperations,
      conflictsState,
    );
    return {
      status: "conflict_dispatched",
      gate: emptyGateStatus(operationId, pullRequest, requiredOriginalHeadSha, this.options.config.mergePolicy.requiredChecks),
      conflict: updated.mergeConflict ?? conflict,
    };
  }

  private async repairLocalOnlyBaseRefDrift(input: {
    issue: Issue;
    conflictGit: ServiceOwnedMergeConflictGit;
    workspacePath: string;
    branchName: string;
    baseBranch: string;
    originalHeadSha: string;
    liveBaseHeadSha: string;
    authHeader: string;
    operationId: string;
    sourceState: string;
    preservedStashes: IssuePreservedWorktreeStash[];
    blockerResolutionPatch: Pick<
      IssueLifecyclePatch,
      "blockerProvenances" | "activeBlockerProvenanceId"
    >;
    blockerProvenanceId: string | null;
  }): Promise<MergePolicyResult> {
    let refresh: ServiceOwnedLocalBaseRefreshResult;
    let preservedStashes = input.preservedStashes;
    try {
      refresh = await input.conflictGit.refreshLocalBranchBase({
        workspacePath: input.workspacePath,
        branchName: input.branchName,
        expectedHeadSha: input.originalHeadSha,
        baseBranch: input.baseBranch,
        liveBaseHeadSha: input.liveBaseHeadSha,
        authHeader: input.authHeader,
      });
    } catch (error) {
      const restore = await this.restorePreservedStashQueue({
        issue: input.issue,
        conflictGit: input.conflictGit,
        workspacePath: input.workspacePath,
        branchName: input.branchName,
        stashes: preservedStashes,
      });
      preservedStashes = restore.stashes;
      if (restore.status === "conflicted") {
        return this.dispatchStashApplyConflict({
          issue: input.issue,
          pullRequest: {
            url: null,
            number: null,
            headSha: input.originalHeadSha,
            branch: input.branchName,
          },
          operationId: input.operationId,
          sourceState: input.sourceState,
          conflictsState: this.options.config.mergePolicy.conflictsState,
          workspacePath: input.workspacePath,
          branchName: input.branchName,
          baseBranch: input.baseBranch,
          baseHeadSha: input.liveBaseHeadSha,
          currentHeadSha: input.originalHeadSha,
          preservedStashes,
          stashApply: restore.stashApply,
          reason: "Preserved local changes conflicted while restoring after blocked local-only base refresh",
          blockerProvenanceId: null,
        });
      }
      const reason = `local-only base refresh blocked: ${messageFromUnknown(error)}`;
      await this.options.lifecycleStore.updateIssue(input.issue, {
        phase: "blocked",
        blockedReason: reason,
        mergeGate: null,
        mergeConflict: null,
        preservedWorktreeStashes: preservedStashes,
        summaryPointers: {
          ciStatus: null,
          workspacePath: input.workspacePath,
          gitBranchName: input.branchName,
          prUrl: null,
          prNumber: null,
          prHeadSha: null,
          prBranch: null,
          baseRef: input.baseBranch,
        },
      });
      return { status: "skipped", reason };
    }

    const restore = await this.restorePreservedStashQueue({
      issue: input.issue,
      conflictGit: input.conflictGit,
      workspacePath: input.workspacePath,
      branchName: input.branchName,
      stashes: preservedStashes,
    });
    preservedStashes = restore.stashes;
    if (restore.status === "conflicted") {
      return this.dispatchStashApplyConflict({
        issue: input.issue,
        pullRequest: {
          url: null,
          number: null,
          headSha: refresh.refreshedHeadSha,
          branch: input.branchName,
        },
        operationId: input.operationId,
        sourceState: input.sourceState,
        conflictsState: this.options.config.mergePolicy.conflictsState,
        workspacePath: input.workspacePath,
        branchName: input.branchName,
        baseBranch: input.baseBranch,
        baseHeadSha: input.liveBaseHeadSha,
        currentHeadSha: refresh.refreshedHeadSha,
        preservedStashes,
        stashApply: restore.stashApply,
        reason: "Preserved local changes conflicted while restoring after local-only base refresh",
        blockerProvenanceId: input.blockerProvenanceId,
      });
    }

    const operations = planBaseRefRepairWritebacks(
      {
        issue: input.issue,
        operationId: input.operationId,
        fromState: input.sourceState,
        branchName: input.branchName,
        baseBranch: input.baseBranch,
        previousHeadSha: input.originalHeadSha,
        rebasedHeadSha: refresh.refreshedHeadSha,
        baseHeadSha: input.liveBaseHeadSha,
        mode: "local_only",
      },
      this.options.config,
    );
    const boundOperations = operations.map((operation) =>
      bindWritebackOperationToLifecycle(operation, {
        kind: "issue_checkpoint",
        phase: "implementation",
        prHeadSha: null,
        gitBranchName: input.branchName,
        baseRef: input.baseBranch,
        resolvedBlockerProvenanceId: input.blockerProvenanceId,
      }),
    );
    await this.enqueueMergeGateWritebacks(boundOperations);
    await this.options.lifecycleStore.updateIssue(input.issue, {
      ...input.blockerResolutionPatch,
      phase: "implementation",
      blockedReason: null,
      mergeGate: null,
      mergeConflict: null,
      preservedWorktreeStashes: preservedStashes,
      summaryPointers: {
        ciStatus: null,
        workspacePath: input.workspacePath,
        gitBranchName: input.branchName,
        prUrl: null,
        prNumber: null,
        prHeadSha: null,
        prBranch: null,
        baseRef: input.baseBranch,
      },
    });
    await this.requireMergeGateWritebacksSucceeded(
      input.issue,
      boundOperations,
      this.options.config.writeback.dispatchState,
    );
    return { status: "base_ref_repaired", headSha: refresh.refreshedHeadSha };
  }

  async restorePreservedWorktreeStashes(issue: Issue): Promise<MergePolicyResult> {
    this.requireGatedServiceConfiguration();
    const latestIssue = (await this.options.tracker.fetchIssueStatesByIds([issue.id]))[0] ?? issue;
    const lifecycle = await this.options.lifecycleStore.get(issue.id);
    if (!lifecycle) {
      throw new SymphonyError("invalid_request", "Preserved stash restore requires an issue lifecycle record");
    }
    const activeStashes = restorablePreservedWorktreeStashes(
      preservedWorktreeStashesOf(lifecycle),
    );
    if (activeStashes.length === 0) {
      return { status: "skipped", reason: "no_restorable_preserved_worktree_stashes" };
    }
    const first = activeStashes[0]!;
    const workspacePath = requireValue(
      first.workspacePath ?? lifecycle.summaryPointers.workspacePath,
      "Preserved stash restore requires a workspace path",
    );
    const branchName = requireValue(
      first.branchName ?? lifecycle.summaryPointers.gitBranchName ?? lifecycle.summaryPointers.branchName,
      "Preserved stash restore requires a branch name",
    );
    const conflictGit =
      this.options.conflictGit ??
      new ServiceOwnedMergeConflictGit({
        journalDir: this.options.config.workspace.stateDir,
      });
    const restore = await this.restorePreservedStashQueue({
      issue: latestIssue,
      conflictGit,
      workspacePath,
      branchName,
      stashes: preservedWorktreeStashesOf(lifecycle),
    });
    if (restore.status === "conflicted") {
      const pullRequest = pullRequestRefForPreservedStashRestore(
        lifecycle,
        branchName,
        restore.stashApply.headSha,
      );
      return this.dispatchStashApplyConflict({
        issue: latestIssue,
        pullRequest,
        operationId: restore.stashApply.stash.operationId,
        sourceState: latestIssue.state,
        conflictsState: this.options.config.mergePolicy.conflictsState,
        workspacePath,
        branchName,
        baseBranch:
          restore.stashApply.stash.baseBranch ??
          lifecycle.summaryPointers.baseRef ??
          this.options.config.workspace.source.baseRef ??
          null,
        baseHeadSha:
          lifecycle.baseRefObservation?.localBaseHeadShaAfterFetch ??
          lifecycle.baseRefObservation?.githubBaseHeadSha ??
          null,
        currentHeadSha: restore.stashApply.headSha,
        preservedStashes: restore.stashes,
        stashApply: restore.stashApply,
        reason: "Preserved local changes conflicted while restoring before worker dispatch",
      });
    }
    await this.options.lifecycleStore.updateIssue(latestIssue, {
      preservedWorktreeStashes: restore.stashes,
      blockedReason: lifecycle.phase === "blocked" ? lifecycle.blockedReason : null,
      summaryPointers: {
        workspacePath,
        gitBranchName: branchName,
      },
    });
    return { status: "skipped", reason: "preserved_worktree_stashes_restored" };
  }

  private async restorePreservedStashQueue(input: {
    issue: Issue;
    conflictGit: ServiceOwnedMergeConflictGit;
    workspacePath: string;
    branchName: string;
    stashes: IssuePreservedWorktreeStash[];
  }): Promise<PreservedStashQueueRestoreResult> {
    let stashes = input.stashes;
    for (const stash of restorablePreservedWorktreeStashes(stashes)) {
      if (
        stash.workspacePath !== input.workspacePath ||
        stash.branchName !== input.branchName
      ) {
        continue;
      }
      if (stash.status === "created") {
        const stashApply = await input.conflictGit.applyPreservedStash({
          workspacePath: input.workspacePath,
          branchName: input.branchName,
          preservedStash: stash,
        });
        stashes = upsertPreservedWorktreeStash(stashes, stashApply.stash);
        await this.options.lifecycleStore.updateIssue(input.issue, {
          preservedWorktreeStashes: stashes,
        });
        if (stashApply.status === "conflicted") {
          return { status: "conflicted", stashes, stashApply };
        }
        const dropped = await input.conflictGit.dropPreservedStash({
          workspacePath: input.workspacePath,
          preservedStash: stashApply.stash,
        });
        stashes = upsertPreservedWorktreeStash(stashes, dropped);
        await this.options.lifecycleStore.updateIssue(input.issue, {
          preservedWorktreeStashes: stashes,
        });
        continue;
      }
      const dropped = await input.conflictGit.dropPreservedStash({
        workspacePath: input.workspacePath,
        preservedStash: stash,
      });
      stashes = upsertPreservedWorktreeStash(stashes, dropped);
      await this.options.lifecycleStore.updateIssue(input.issue, {
        preservedWorktreeStashes: stashes,
      });
    }
    return { status: "clean", stashes };
  }

  private async dispatchStashApplyConflict(input: {
    issue: Issue;
    pullRequest: CompletionReportPullRequestRef;
    operationId: string;
    sourceState: string;
    conflictsState: string | null;
    workspacePath: string;
    branchName: string;
    baseBranch: string | null;
    baseHeadSha: string | null;
    currentHeadSha: string;
    preservedStashes: IssuePreservedWorktreeStash[];
    stashApply: Extract<ServiceOwnedPreservedStashApplyResult, { status: "conflicted" }>;
    reason: string;
    blockerProvenanceId?: string | null;
  }): Promise<MergePolicyResult> {
    const conflictsState = input.conflictsState;
    if (conflictsState === null) {
      throw new SymphonyError("invalid_request", "merge_policy.conflicts_state is required before Symphony can repair preserved local change conflicts");
    }
    const operations = planMergeConflictsWritebacks(
      {
        issue: input.issue,
        mergeId: `stash-apply:${input.issue.id}:${input.currentHeadSha}:${input.stashApply.stash.stashSha}`,
        fromState: input.sourceState,
        conflictsState,
        pullRequest: { ...input.pullRequest, headSha: input.currentHeadSha },
        mergeableState: "dirty",
        reason: input.reason,
      },
      this.options.config,
    );
    const now = new Date().toISOString();
    const conflict = buildStashApplyMergeConflict({
      issue: input.issue,
      pullRequest: { ...input.pullRequest, headSha: input.currentHeadSha },
      sourceState: input.sourceState,
      conflictsState,
      baseBranch: input.baseBranch,
      baseHeadSha: input.baseHeadSha,
      currentHeadSha: input.currentHeadSha,
      preservedStash: input.stashApply.stash,
      changedFiles: input.stashApply.changedFiles,
      conflictedFiles: input.stashApply.conflictedFiles,
      reason: input.reason,
      blockerProvenanceId: input.blockerProvenanceId ?? null,
      maxFixTurns: this.options.config.mergePolicy.maxConflictFixTurns,
      now,
    });
    const boundOperations = operations.map((operation) =>
      bindWritebackOperationToLifecycle(operation, {
        kind: "merge_conflict",
        recordId: conflict.id,
      }),
    );
    await this.enqueueMergeGateWritebacks(boundOperations);
    const updated = await this.options.lifecycleStore.updateIssue(input.issue, {
      phase: "merge_conflict_resolution",
      blockedReason: null,
      mergeGate: null,
      mergeConflict: {
        ...conflict,
        writebackOperationKeys: operations.map((operation) => operation.idempotencyKey),
      },
      preservedWorktreeStashes: input.preservedStashes,
      summaryPointers: {
        ciStatus: "conflicted",
        workspacePath: input.workspacePath,
        gitBranchName: input.branchName,
        prUrl: input.pullRequest.url,
        prNumber: input.pullRequest.number,
        prHeadSha: input.currentHeadSha,
        prBranch: input.pullRequest.branch ?? input.branchName,
        baseRef: input.baseBranch,
      },
    });
    await this.requireMergeGateWritebacksSucceeded(
      input.issue,
      boundOperations,
      conflictsState,
    );
    return {
      status: "conflict_dispatched",
      gate: emptyGateStatus(
        input.operationId,
        input.pullRequest,
        input.currentHeadSha,
        this.options.config.mergePolicy.requiredChecks,
      ),
      conflict: updated.mergeConflict ?? conflict,
    };
  }

  async planServicePreparedMergeConflict(
    issue: Issue,
    observation: MergePolicyObservation,
  ): Promise<MergePolicyConflictPreparationPlan> {
    const lifecycle = await this.options.lifecycleStore.get(issue.id);
    if (!lifecycle) throw new SymphonyError("invalid_request", "Gated merge policy requires an issue lifecycle record");
    const conflictsState = this.options.config.mergePolicy.conflictsState;
    if (conflictsState === null) {
      throw new SymphonyError("invalid_request", "merge_policy.conflicts_state is required before service conflict preparation");
    }
    const gate = requireObservationValue(observation.gate, "Merge conflict preparation requires observed gate");
    const sourceState = requireObservationValue(observation.sourceState, "Merge conflict preparation requires observed source state");
    const livePullRequest = requireObservationValue(observation.livePullRequest, "Merge conflict preparation requires observed live pull request");
    const baseObservation = requireObservationValue(observation.baseObservation, "Merge conflict preparation requires observed base");
    const pullRequest = gate.pullRequest;
    const branchName = requireValue(pullRequest.branch, "Service-owned conflict preparation requires a pull request branch");
    const workspacePath = observation.workerRun?.workspacePath ?? lifecycle.summaryPointers.workspacePath;
    if (!workspacePath) {
      throw new SymphonyError("invalid_request", "Service-owned conflict preparation requires the worker workspace path");
    }
    return {
      mode: "initial",
      lifecycle,
      gate,
      sourceState,
      conflictsState,
      livePullRequest,
      baseObservation,
      workspacePath,
      branchName,
      expectedHeadSha: gate.headSha,
      previousRemoteHeadSha: gate.headSha,
      baseBranch: livePullRequest.baseBranch,
      mergeableState: livePullRequest.mergeableState,
      existingWritebackOperationKeys: [],
    };
  }

  async prepareServiceConflictBranch(
    issue: Issue,
    plan: MergePolicyConflictPreparationPlan,
  ): Promise<MergePolicyConflictPreparationExecution> {
    const github = this.options.client ?? createGitHubPullRequestClientForCapability(this.options.config, "github.merge");
    const authHeader = await github.gitAuthHeader();
    const conflictGit =
      this.options.conflictGit ??
      new ServiceOwnedMergeConflictGit({
        journalDir: this.options.config.workspace.stateDir,
      });
    const operationId = `${plan.mode === "base_refresh" ? "service-conflict-base-refresh" : "service-conflict"}:${issue.id}:${plan.expectedHeadSha}:${plan.baseObservation.liveBaseHeadSha}`;
    let preservedStashes = preservedWorktreeStashesOf(plan.lifecycle);
    const preservedStash = await conflictGit.preserveDirtyWorktree({
      workspacePath: plan.workspacePath,
      branchName: plan.branchName,
      baseBranch: plan.baseBranch,
      operationId,
      source: plan.mode === "base_refresh" ? "service_conflict_base_refresh" : "service_conflict_prepare",
      message: `Symphony preserved local changes before service conflict repair for ${issue.identifier}`,
    });
    if (preservedStash !== null) {
      preservedStashes = upsertPreservedWorktreeStash(
        preservedStashes,
        preservedStash,
      );
      await this.options.lifecycleStore.updateIssue(issue, {
        preservedWorktreeStashes: preservedStashes,
      });
    }
    const preparation =
      plan.mode === "base_refresh"
        ? await conflictGit.reprepareAfterBaseDrift({
            workspacePath: plan.workspacePath,
            branchName: plan.branchName,
            expectedHeadSha: plan.expectedHeadSha,
            baseBranch: plan.baseBranch,
            observedPrBaseHeadSha: plan.baseObservation.observedPrBaseHeadSha,
            liveBaseHeadSha: plan.baseObservation.liveBaseHeadSha,
            authHeader,
          })
        : await conflictGit.prepare({
            workspacePath: plan.workspacePath,
            branchName: plan.branchName,
            expectedHeadSha: plan.expectedHeadSha,
            baseBranch: plan.baseBranch,
            observedPrBaseHeadSha: plan.baseObservation.observedPrBaseHeadSha,
            liveBaseHeadSha: plan.baseObservation.liveBaseHeadSha,
            authHeader,
          });
    return {
      preparation,
      authHeader,
      resolvedHeadSha: preparation.status === "clean" ? preparation.rebasedHeadSha : null,
      pullRequestHeadSha: preparation.status === "clean" ? preparation.rebasedHeadSha : plan.expectedHeadSha,
      preservedStash,
      preservedStashes,
      stashApplyResult: null,
      finalPreservedStash:
        firstPendingCreatedPreservedStash(preservedStashes),
    };
  }

  async publishPreparedConflictHead(
    plan: MergePolicyConflictPreparationPlan,
    execution: MergePolicyConflictPreparationExecution,
  ): Promise<{ published: boolean; headSha: string | null }> {
    if (execution.preparation.status !== "clean") return { published: false, headSha: null };
    const conflictGit =
      this.options.conflictGit ??
      new ServiceOwnedMergeConflictGit({
        journalDir: this.options.config.workspace.stateDir,
      });
    await conflictGit.publishPreparedHead({
      workspacePath: plan.workspacePath,
      branchName: plan.branchName,
      previousRemoteHeadSha: plan.previousRemoteHeadSha,
      authHeader: execution.authHeader,
    });
    return { published: true, headSha: execution.preparation.rebasedHeadSha };
  }

  async restorePreservedStashAfterPreparedHead(
    issue: Issue,
    plan: MergePolicyConflictPreparationPlan,
    execution: MergePolicyConflictPreparationExecution,
  ): Promise<void> {
    if (execution.preparation.status !== "clean") return;
    const conflictGit =
      this.options.conflictGit ??
      new ServiceOwnedMergeConflictGit({
        journalDir: this.options.config.workspace.stateDir,
      });
    const restore = await this.restorePreservedStashQueue({
      issue,
      conflictGit,
      workspacePath: plan.workspacePath,
      branchName: plan.branchName,
      stashes: execution.preservedStashes,
    });
    execution.preservedStashes = restore.stashes;
    if (restore.status === "clean") {
      execution.finalPreservedStash =
        latestRestoredPreservedStash(restore.stashes) ??
        firstPendingCreatedPreservedStash(restore.stashes);
      return;
    }
    execution.stashApplyResult = restore.stashApply;
    execution.finalPreservedStash = restore.stashApply.stash;
  }

  planServiceConflictWritebacks(
    issue: Issue,
    plan: MergePolicyConflictPreparationPlan,
    execution: MergePolicyConflictPreparationExecution,
  ): MergePolicyConflictWritebackPlan {
    const stashApplyConflict =
      execution.stashApplyResult?.status === "conflicted"
        ? execution.stashApplyResult
        : null;
    if (execution.preparation.status === "clean" && stashApplyConflict === null) {
      const operations = planBaseRefRepairWritebacks(
        {
          issue,
          operationId: `service-conflict:${issue.id}:${plan.expectedHeadSha}:${plan.baseObservation.liveBaseHeadSha}`,
          fromState: plan.sourceState,
          branchName: plan.branchName,
          baseBranch: plan.baseBranch,
          previousHeadSha: plan.previousRemoteHeadSha,
          rebasedHeadSha: execution.pullRequestHeadSha,
          baseHeadSha: plan.baseObservation.liveBaseHeadSha,
          mode: "pr_backed",
        },
        this.options.config,
      );
      return {
        operations,
        expectedState:
          operations.length > 0 ? this.options.config.writeback.dispatchState : null,
      };
    }
    if (plan.mode === "base_refresh") return { operations: [], expectedState: null };
    return {
      operations: planMergeConflictsWritebacks(
        {
          issue,
          mergeId:
            stashApplyConflict === null
              ? `merge:${issue.id}:${plan.gate.headSha}`
              : `stash-apply:${issue.id}:${execution.pullRequestHeadSha}:${stashApplyConflict.stash.stashSha}`,
          fromState: plan.sourceState,
          conflictsState: plan.conflictsState,
          pullRequest: {
            ...plan.gate.pullRequest,
            headSha: execution.pullRequestHeadSha,
          },
          mergeableState: stashApplyConflict === null ? plan.livePullRequest.mergeableState : "dirty",
          reason:
            stashApplyConflict === null
              ? plan.gate.mergeability?.reason ?? "Pull request has merge conflicts with the base branch"
              : "Preserved local changes conflicted while restoring after service-owned repair",
        },
        this.options.config,
      ),
      expectedState: plan.conflictsState,
    };
  }

  async applyServiceConflictWritebacks(
    issue: Issue,
    plan: MergePolicyConflictPreparationPlan,
    writebackPlan: MergePolicyConflictWritebackPlan,
  ): Promise<{ operations: Array<{ operationKey: string; status: WritebackOperation["status"] }> }> {
    const lifecycle = await this.options.lifecycleStore.get(issue.id);
    const conflict = lifecycle?.mergeConflict ?? null;
    if (conflict === null) {
      throw new SymphonyError(
        "invalid_request",
        "Service conflict writebacks require a durable merge-conflict lifecycle record",
      );
    }
    const operationKeys = writebackPlan.operations.map(
      (operation) => operation.idempotencyKey,
    );
    if (
      operationKeys.some(
        (operationKey) =>
          !conflict.writebackOperationKeys.includes(operationKey),
      )
    ) {
      throw new SymphonyError(
        "invalid_request",
        "Service conflict writebacks are not registered on the current merge conflict",
      );
    }
    const boundOperations = writebackPlan.operations.map((operation) =>
      bindWritebackOperationToLifecycle(operation, {
        kind: "merge_conflict",
        recordId: conflict.id,
      }),
    );
    const results = await this.requireMergeGateWritebacksSucceeded(
      issue,
      boundOperations,
      writebackPlan.expectedState,
    );
    return {
      operations: results.map((operation) => ({ operationKey: operation.idempotencyKey, status: operation.status })),
    };
  }

  async recordServicePreparedMergeConflict(
    issue: Issue,
    plan: MergePolicyConflictPreparationPlan,
    execution: MergePolicyConflictPreparationExecution,
    writebackPlan: MergePolicyConflictWritebackPlan,
  ): Promise<MergePolicyResult> {
    const now = new Date().toISOString();
    const stashApplyConflict =
      execution.stashApplyResult?.status === "conflicted"
        ? execution.stashApplyResult
        : null;
    const conflict =
      stashApplyConflict === null
        ? buildServicePreparedMergeConflict({
            issue,
            gate: plan.gate,
            sourceState: plan.sourceState,
            conflictsState: plan.conflictsState,
            mergeableState: plan.mergeableState,
            preparation: withPreservedStash(
              execution.preparation,
              execution.finalPreservedStash,
            ),
            resolvedHeadSha: execution.resolvedHeadSha,
            pullRequestHeadSha: execution.pullRequestHeadSha,
            maxFixTurns: this.options.config.mergePolicy.maxConflictFixTurns,
            now,
          })
        : buildStashApplyMergeConflict({
            issue,
            pullRequest: { ...plan.gate.pullRequest, headSha: execution.pullRequestHeadSha },
            sourceState: plan.sourceState,
            conflictsState: plan.conflictsState,
            baseBranch: plan.baseBranch,
            baseHeadSha: plan.baseObservation.liveBaseHeadSha,
            currentHeadSha: execution.pullRequestHeadSha,
            preservedStash: stashApplyConflict.stash,
            changedFiles: stashApplyConflict.changedFiles,
            conflictedFiles: stashApplyConflict.conflictedFiles,
            reason: "Preserved local changes conflicted while restoring after service-owned repair",
            maxFixTurns: this.options.config.mergePolicy.maxConflictFixTurns,
            now,
          });
    const operationKeys =
      writebackPlan.operations.length > 0
        ? writebackPlan.operations.map((operation) => operation.idempotencyKey)
        : plan.existingWritebackOperationKeys;
    const phase =
      stashApplyConflict !== null
        ? "merge_conflict_resolution"
        : execution.preparation.status === "clean"
          ? "implementation"
          : "merge_conflict_resolution";
    const updated = await this.options.lifecycleStore.updateIssue(issue, {
      phase,
      blockedReason: null,
      mergeGate: null,
      mergeConflict: {
        ...conflict,
        writebackOperationKeys: operationKeys,
      },
      preservedWorktreeStashes: execution.preservedStashes,
      summaryPointers: {
        ciStatus:
          phase === "implementation"
            ? null
            : execution.preparation.status === "clean" && stashApplyConflict === null
              ? "success"
              : "conflicted",
        prUrl: plan.gate.pullRequest.url,
        prNumber: plan.gate.pullRequest.number,
        prHeadSha: execution.pullRequestHeadSha,
        prBranch: plan.gate.pullRequest.branch,
        workspacePath: plan.workspacePath,
      },
    });
    return { status: "conflict_dispatched", gate: plan.gate, conflict: updated.mergeConflict ?? conflict };
  }

  async dispatchRepair(issue: Issue, observation: MergePolicyObservation): Promise<MergePolicyResult> {
    const plan = await this.planMergeGateFailure(issue, observation, "repair");
    const result = await this.recordMergeGateFailureLifecycle(issue, plan);
    await this.applyMergeGateFailureWritebacks(issue, plan);
    return result;
  }

  async blockFailure(issue: Issue, observation: MergePolicyObservation): Promise<MergePolicyResult> {
    const plan = await this.planMergeGateFailure(issue, observation, "blocked");
    const result = await this.recordMergeGateFailureLifecycle(issue, plan);
    await this.applyMergeGateFailureWritebacks(issue, plan);
    return result;
  }

  async mergePullRequest(issue: Issue, observation: MergePolicyObservation): Promise<MergePolicyResult> {
    const plan = await this.planMergePullRequest(issue, observation);
    const mergeResult = await this.mergeObservedPullRequest(plan);
    const recorded = await this.recordPullRequestMerge(issue, plan, mergeResult);
    const donePlan = await this.planDoneStateWriteback({ ...issue, state: recorded.sourceState });
    await this.applyDoneStateWriteback(donePlan);
    await this.verifyDoneState(issue);
    return { status: "merged", merge: recorded.merge };
  }

  async recoverAlreadyMergedPullRequest(issue: Issue, observation: MergePolicyObservation): Promise<MergePolicyResult> {
    const plan = await this.planMergeRecovery(issue, observation);
    const mergeResult = this.recoverObservedPullRequestMerge(plan, observation);
    const recorded = await this.recordPullRequestMerge(issue, plan, mergeResult);
    const donePlan = await this.planDoneStateWriteback({ ...issue, state: recorded.sourceState });
    await this.applyDoneStateWriteback(donePlan);
    await this.verifyDoneState(issue);
    return { status: "already_merged", merge: recorded.merge };
  }

  async planMergePullRequest(issue: Issue, observation: MergePolicyObservation): Promise<MergePolicyMergePlan> {
    const plan = await this.planMergeRecovery(issue, observation);
    if (!isOpenPullRequest(plan.livePullRequest)) {
      throw new SymphonyError("invalid_request", "Observed pull request is not open for merge");
    }
    return plan;
  }

  async planMergeRecovery(issue: Issue, observation: MergePolicyObservation): Promise<MergePolicyMergePlan> {
    this.requireGatedServiceConfiguration();
    const lifecycle = await this.options.lifecycleStore.get(issue.id);
    if (!lifecycle) throw new SymphonyError("invalid_request", "Gated merge policy requires an issue lifecycle record");
    const report = requireObservationValue(observation.report, "Gated merge requires observed completion report");
    const verdict = requireObservationValue(observation.approvalVerdict, "Gated merge requires observed approval verdict");
    const workerRun = observation.workerRun;
    this.validateLifecycle(lifecycle, report, verdict, workerRun, issue);
    const pullRequest = requireObservationValue(observation.pullRequest, "Gated merge requires observed pull request");
    const headSha = requireObservationValue(observation.headSha, "Gated merge requires observed head SHA");
    const livePullRequest = requireObservationValue(observation.livePullRequest, "Gated merge requires observed live pull request");
    const checkStatus = requireObservationValue(observation.checkStatus, "Gated merge requires observed check status");
    const sourceState = requireObservationValue(observation.sourceState, "Gated merge requires observed source state");
    const mergeability = observation.gate?.mergeability ?? null;
    if (mergeability?.status === "blocked") {
      throw new SymphonyError("invalid_request", mergeability.reason ?? "Pull request is not currently mergeable");
    }
    const mergeId = `merge:${issue.id}:${headSha}`;
    const doneTransition = this.planDoneTransition(issue, mergeId, sourceState);
    return {
      lifecycle,
      report,
      verdict,
      workerRun,
      pullRequest,
      headSha,
      livePullRequest,
      checkStatus,
      sourceState,
      mergeId,
      doneTransitionOperationKey: doneTransition.idempotencyKey,
    };
  }

  async mergeObservedPullRequest(plan: MergePolicyMergePlan): Promise<PullRequestMergeResult> {
    const github = this.options.client ?? createGitHubPullRequestClientForCapability(this.options.config, "github.merge");
    return github.mergePullRequest({
      pullRequestNumber: requireNumber(plan.pullRequest.number),
      expectedHeadSha: plan.headSha,
      method: this.options.config.mergePolicy.mergeMethod,
    });
  }

  recoverObservedPullRequestMerge(
    plan: MergePolicyMergePlan,
    observation: Pick<MergePolicyObservation, "serviceMergeLogin">,
  ): PullRequestMergeResult {
    return recoverAlreadyMergedPullRequest(plan.livePullRequest, observation.serviceMergeLogin);
  }

  async recordPullRequestMerge(
    issue: Issue,
    plan: MergePolicyMergePlan,
    mergeResult: PullRequestMergeResult,
  ): Promise<MergePolicyRecordedMerge> {
    const serviceMerge = resolveGitHubClientConfig(this.options.config, "github.merge").credential;
    const merge = buildMergeMetadata(
      issue,
      plan.pullRequest,
      plan.headSha,
      mergeResult,
      serviceMerge,
      plan.checkStatus,
      plan.doneTransitionOperationKey,
    );
    const mergeGatePatch =
      plan.lifecycle.mergeGate && shouldSilentlyRetireMergeGate(plan.lifecycle.mergeGate, plan.headSha, plan.pullRequest.number)
        ? supersededMergeGateLifecyclePatch(plan.lifecycle, plan.lifecycle.mergeGate, plan.headSha)
        : { mergeGate: plan.lifecycle.mergeGate ?? null };
    const updated = await this.options.lifecycleStore.updateIssue(issue, { merge, ...mergeGatePatch });
    return { sourceState: plan.sourceState, merge: updated.merge ?? merge };
  }

  async planMergeGateFailure(
    issue: Issue,
    observation: MergePolicyObservation,
    expectedDisposition?: "repair" | "blocked",
  ): Promise<MergePolicyGateFailurePlan> {
    const lifecycle = await this.options.lifecycleStore.get(issue.id);
    if (!lifecycle) throw new SymphonyError("invalid_request", "Gated merge policy requires an issue lifecycle record");
    const report = requireObservationValue(observation.report, "Merge gate failure requires observed completion report");
    const gate = requireObservationValue(observation.gate, "Merge gate failure requires observed gate");
    const sourceState = requireObservationValue(observation.sourceState, "Merge gate failure requires observed source state");
    const approvalVerdict = latestCurrentApprovalPassVerdict(lifecycle);
    const existingFailure = observation.existingGateFailure;
    const newRepairCycle = existingFailure === null || lifecycle.phase === "passed";
    const previousMergeGateRound = previousMergeGateRepairRound(lifecycle, gate);
    const reviewRound = newRepairCycle ? previousMergeGateRound + 1 : previousMergeGateRound;
    const maxMergeGateFailures = this.options.config.reviewLoop.failureLimits.mergeGateFailures;
    const missingConflictState = gate.mergeability?.status === "conflicted" && this.options.config.mergePolicy.conflictsState === null;
    const blocked = missingConflictState || reviewRound >= maxMergeGateFailures;
    if (expectedDisposition === "repair" && blocked) {
      throw new SymphonyError("invalid_request", "Merge gate failure snapshot selected repair but current evidence requires block");
    }
    if (expectedDisposition === "blocked" && !blocked) {
      throw new SymphonyError("invalid_request", "Merge gate failure snapshot selected block but current evidence allows repair");
    }
    const rawOperations = blocked
      ? planMergeGateBlockedWritebacks(this.mergeGateWritebackContext(issue, gate, sourceState, reviewRound), this.options.config)
      : planMergeGateRepairWritebacks(this.mergeGateWritebackContext(issue, gate, sourceState, reviewRound), this.options.config);
    if (rawOperations.length === 0) {
      throw new SymphonyError("invalid_request", "Merge gate failure could not plan service-owned writeback");
    }

    const blockerKind = blocked ? "blocked" : "repair";
    const operationKeys = rawOperations.map((operation) => operation.idempotencyKey);
    const storedResult: IssueMergeGateResultRecord = {
      id: gate.id,
      idempotencyKey: mergeGateResultIdempotencyKey(gate, blockerKind),
      runId: report.runId,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      status: blocked ? "blocked" : "repair_dispatched",
      headSha: gate.headSha,
      pullRequest: gate.pullRequest,
      requiredChecks: [...gate.requiredChecks],
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
      reviewRound,
      blockerFingerprint: gate.blockerFingerprint,
      findings: mergeGateFindings(gate),
      evidence: mergeGateEvidence(gate),
      submittedAt: new Date().toISOString(),
      writebackOperationKeys: operationKeys,
      supersededAt: null,
      supersededBy: null,
      supersededReason: null,
    };
    const operations = rawOperations.map((operation) =>
      bindWritebackOperationToLifecycle(operation, {
        kind: "merge_gate_result",
        recordId: storedResult.id,
        resultIdempotencyKey: storedResult.idempotencyKey,
      }),
    );
    return {
      lifecycle,
      report,
      gate,
      sourceState,
      existingFailure,
      approvalVerdict,
      blocked,
      missingConflictState,
      reviewRound,
      maxMergeGateFailures,
      operations,
      storedResult,
    };
  }

  async applyMergeGateFailureWritebacks(
    issue: Issue,
    plan: MergePolicyGateFailurePlan,
  ): Promise<{ operations: Array<{ operationKey: string; status: WritebackOperation["status"] }> }> {
    const results = await this.requireMergeGateWritebacksSucceeded(
      issue,
      plan.operations,
      plan.blocked ? this.options.config.reviewLoop.blockedStates[0] ?? null : this.options.config.writeback.dispatchState,
    );
    return {
      operations: results.map((operation) => ({ operationKey: operation.idempotencyKey, status: operation.status })),
    };
  }

  async recordMergeGateFailureLifecycle(issue: Issue, plan: MergePolicyGateFailurePlan): Promise<MergePolicyResult> {
    await this.enqueueMergeGateWritebacks(plan.operations);
    await this.options.lifecycleStore.updateIssue(issue, {
      phase: plan.blocked ? "blocked" : "implementation",
      incompleteTurnCount: 0,
      blockedReason: plan.blocked
        ? plan.missingConflictState
          ? "merge_policy.conflicts_state is required before Symphony can prepare a service-owned merge-conflict repair"
          : `max merge gate failures reached (${plan.reviewRound}/${plan.maxMergeGateFailures})`
        : null,
      lastReviewVerdictId: plan.approvalVerdict?.id ?? plan.lifecycle.lastReviewVerdictId,
      lastMergeGateResultId: plan.storedResult.id,
      mergeGateResults: upsertMergeGateResult(plan.lifecycle.mergeGateResults ?? [], plan.storedResult),
      mergeGate: mergeGateStateFromStatus(
        { ...plan.gate, writebackOperationKeys: plan.storedResult.writebackOperationKeys },
        plan.blocked ? "blocked" : "repair_dispatched",
        plan.lifecycle,
        plan.report.runId,
        plan.report.id,
        plan.reviewRound,
      ),
      summaryPointers: { ciStatus: "failure" },
    });

    const resultGate = { ...plan.gate, writebackOperationKeys: plan.storedResult.writebackOperationKeys };
    return plan.blocked ? { status: "blocked", gate: resultGate } : { status: "repair_dispatched", gate: resultGate };
  }

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

    const refreshedConflict = await this.refreshOpenMergeConflictBaseIfNeeded(latestIssue, lifecycle);
    if (refreshedConflict !== null) return refreshedConflict;

    const sourceState = this.mergeSourceState(latestIssue, lifecycle);
    const staleConflictResult = this.pendingConflictsWhileTrackerCatchesUp(latestIssue, lifecycle);
    if (staleConflictResult !== null) return staleConflictResult;
    if (sourceState === null) return { status: "skipped", reason: `issue is not in a merge source state: ${latestIssue.state}` };

    const report = latestCurrentCompletionReport(lifecycle);
    if (!report) throw new SymphonyError("invalid_request", "Gated merge requires a latest completion report");

    const approvedPullRequest = requirePullRequest(report);
    const approvedHeadSha = requireValue(approvedPullRequest.headSha, "Completion report pull request head SHA is required for gated merge");
    const resolvedConflict = resolvedMergeConflictForIssue(latestIssue, lifecycle, config, approvedPullRequest);
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

    const approvalVerdict = latestMergeApprovalPassVerdict(activeLifecycle);
    const existingGateFailure = findMergeGateFailure(activeLifecycle, gateId);
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
    if (existingGateFailure && decision.kind === "failure") {
      if (shouldRefreshSameMergeGateBlocker(activeLifecycle, decision.gate)) {
        await this.retryDurableMergeGateResultWritebacks(
          latestIssue,
          activeLifecycle,
          sourceState,
        );
        const refreshedMergeGate = refreshActiveMergeGateObservation(activeLifecycle, decision.gate, existingGateFailure.writebackOperationKeys);
        if (refreshedMergeGate) {
          const updated = await this.options.lifecycleStore.updateIssue(latestIssue, {
            phase: activeLifecycle.phase,
            blockedReason: refreshedMergeGate.status === "blocked" ? activeLifecycle.blockedReason : null,
            lastReviewVerdictId: refreshedActiveGateLastReviewVerdictId(activeLifecycle, refreshedMergeGate),
            lastMergeGateResultId: existingGateFailure.id,
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
          gate: { ...decision.gate, writebackOperationKeys: activeLifecycle.mergeGate?.writebackOperationKeys ?? existingGateFailure.writebackOperationKeys },
        };
      }
      return this.handleMergeGateFailure(latestIssue, activeLifecycle, report, decision.gate, sourceState, existingGateFailure);
    }
    if (decision.kind === "pending") {
      const refreshedMergeGate = refreshActiveMergeGateObservation(activeLifecycle, decision.gate, existingGateFailure?.writebackOperationKeys ?? []);
      if (refreshedMergeGate) {
        const updated = await this.options.lifecycleStore.updateIssue(latestIssue, {
        phase: activeLifecycle.phase,
        blockedReason: refreshedMergeGate.status === "blocked" ? activeLifecycle.blockedReason : null,
        lastReviewVerdictId: refreshedActiveGateLastReviewVerdictId(activeLifecycle, refreshedMergeGate),
        lastMergeGateResultId: existingGateFailure?.id ?? activeLifecycle.lastMergeGateResultId ?? null,
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
          existingGateFailure && approvalVerdict && activeLifecycle.lastReviewVerdictId === existingGateFailure.id
            ? approvalVerdict.id
            : activeLifecycle.lastReviewVerdictId,
        mergeGate: mergeGateStateFromStatus(decision.gate, "observing", activeLifecycle, null, null),
        summaryPointers: { ciStatus: "observing" },
      });
      activeLifecycle = updated;
      return { status: "checks_pending", gate: decision.gate };
    }

    const verdict = latestMergeApprovalPassVerdict(activeLifecycle);
    if (
      decision.kind === "passed" &&
      verdict &&
      activeLifecycle.mergeGate?.id === gateId &&
      activeLifecycle.mergeGate.status === "blocked" &&
      (existingGateFailure || activeLifecycle.mergeGate?.id === gateId) &&
      canAutoResolveMergeGateOnCheckPass(activeLifecycle, gateId)
    ) {
      activeLifecycle = await this.options.lifecycleStore.updateIssue(latestIssue, {
        ...inactiveMergeGateLifecyclePatch(activeLifecycle, activeLifecycle.mergeGate, "resolved"),
        phase: "passed",
        blockedReason: null,
        lastReviewVerdictId: verdict.id,
        summaryPointers: { ciStatus: "success" },
      });
    }
    this.validateLifecycle(activeLifecycle, report, verdict, workerRun, latestIssue);
    if (
      decision.kind === "passed" &&
      verdict &&
      activeLifecycle.mergeGate?.id === gateId &&
      isActiveMergeGate(activeLifecycle.mergeGate) &&
      (existingGateFailure || activeLifecycle.mergeGate?.id === gateId) &&
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
    if (decision.kind === "failure") {
      return this.handleMergeGateFailure(latestIssue, activeLifecycle, report, decision.gate, sourceState, null);
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
    await this.enqueueDoneWriteback(operation);
    await this.verifyDoneState(issue);
  }

  private async enqueueDoneWriteback(operation: Parameters<WritebackProcessor["enqueueAndProcess"]>[0]): Promise<WritebackOperation> {
    const writeback = this.options.writeback;
    if (!writeback) throw new SymphonyError("invalid_request", "Gated merge policy requires service-owned writeback");
    const result: WritebackOperation = await writeback.enqueueAndProcess(operation, { retrySkipped: true });
    if (result.status !== "succeeded") {
      throw new SymphonyError(
        "invalid_request",
        `Gated merge Done writeback did not succeed: ${result.status}${result.lastError ? ` (${result.lastError})` : ""}`,
      );
    }
    return result;
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
    existingFailure: MergeGateFailureRecord | null,
  ): Promise<MergePolicyResult> {
    const approvalVerdict = latestCurrentApprovalPassVerdict(lifecycle);
    const newRepairCycle = existingFailure === null || lifecycle.phase === "passed";
    const previousMergeGateRound = previousMergeGateRepairRound(lifecycle, gate);
    const reviewRound = newRepairCycle ? previousMergeGateRound + 1 : previousMergeGateRound;
    const maxMergeGateFailures = this.options.config.reviewLoop.failureLimits.mergeGateFailures;
    const missingConflictState = gate.mergeability?.status === "conflicted" && this.options.config.mergePolicy.conflictsState === null;
    const blocked = missingConflictState || reviewRound >= maxMergeGateFailures;
    const rawOperations = blocked
      ? planMergeGateBlockedWritebacks(this.mergeGateWritebackContext(issue, gate, sourceState, reviewRound), this.options.config)
      : planMergeGateRepairWritebacks(this.mergeGateWritebackContext(issue, gate, sourceState, reviewRound), this.options.config);
    if (rawOperations.length === 0) {
      throw new SymphonyError("invalid_request", "Merge gate failure could not plan service-owned writeback");
    }

    const blockerKind = blocked ? "blocked" : "repair";
    const operationKeys = rawOperations.map((operation) => operation.idempotencyKey);
    const storedResult: IssueMergeGateResultRecord = {
      id: gate.id,
      idempotencyKey: mergeGateResultIdempotencyKey(gate, blockerKind),
      runId: report.runId,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      status: blocked ? "blocked" : "repair_dispatched",
      headSha: gate.headSha,
      pullRequest: gate.pullRequest,
      requiredChecks: [...gate.requiredChecks],
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
      reviewRound,
      blockerFingerprint: gate.blockerFingerprint,
      findings: mergeGateFindings(gate),
      evidence: mergeGateEvidence(gate),
      submittedAt: new Date().toISOString(),
      writebackOperationKeys: operationKeys,
      supersededAt: null,
      supersededBy: null,
      supersededReason: null,
    };
    const operations = rawOperations.map((operation) =>
      bindWritebackOperationToLifecycle(operation, {
        kind: "merge_gate_result",
        recordId: storedResult.id,
        resultIdempotencyKey: storedResult.idempotencyKey,
      }),
    );

    await this.enqueueMergeGateWritebacks(operations);
    await this.options.lifecycleStore.updateIssue(issue, {
      phase: blocked ? "blocked" : "implementation",
      incompleteTurnCount: 0,
      blockedReason: blocked
        ? missingConflictState
          ? "merge_policy.conflicts_state is required before Symphony can prepare a service-owned merge-conflict repair"
          : `max merge gate failures reached (${reviewRound}/${maxMergeGateFailures})`
        : null,
      lastReviewVerdictId: approvalVerdict?.id ?? lifecycle.lastReviewVerdictId,
      lastMergeGateResultId: storedResult.id,
      mergeGateResults: upsertMergeGateResult(lifecycle.mergeGateResults ?? [], storedResult),
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
    await this.requireMergeGateWritebacksSucceeded(
      issue,
      operations,
      blocked
        ? this.options.config.reviewLoop.blockedStates[0] ?? null
        : this.options.config.writeback.dispatchState,
    );

    const resultGate = { ...gate, writebackOperationKeys: operationKeys };
    return blocked ? { status: "blocked", gate: resultGate } : { status: "repair_dispatched", gate: resultGate };
  }

  private async refreshOpenMergeConflictBaseIfNeeded(
    issue: Issue,
    lifecycle: IssueLifecycleRecord,
  ): Promise<MergePolicyResult | null> {
    const conflictsState = this.options.config.mergePolicy.conflictsState;
    const conflict = lifecycle.mergeConflict;
    const servicePreparation = conflict?.servicePreparation ?? null;
    if (
      conflictsState === null ||
      conflict === null ||
      servicePreparation === null ||
      servicePreparation.strategy !== "squash_rebase" ||
      servicePreparation.status !== "conflicted" ||
      !statesEqual(issue.state, conflictsState)
    ) {
      return null;
    }
    if (conflict.status !== "open" && conflict.status !== "blocked") return null;

    const branchName = requireValue(conflict.pullRequest.branch, "Service-owned conflict refresh requires a pull request branch");
    const baseBranch = requireValue(conflict.baseBranch, "Service-owned conflict refresh requires the PR base branch");
    const workspacePath = lifecycle.summaryPointers.workspacePath;
    if (!workspacePath) return null;

    const github = this.options.client ?? createGitHubPullRequestClientForCapability(this.options.config, "github.merge");
    const livePullRequest = await github.getPullRequest({ pullRequestNumber: requireNumber(conflict.pullRequest.number) });
    validateLivePullRequestMetadata(livePullRequest, conflict.pullRequest, conflict.currentHeadSha);
    if (livePullRequest.headSha !== conflict.currentHeadSha || livePullRequest.baseBranch !== baseBranch) return null;

    const baseObservation = await resolveLiveBaseObservation(github, livePullRequest);
    if (baseObservation.liveBaseHeadSha === servicePreparation.preparedBaseHeadSha) return null;

    const gate = gateWithMergeability(
      emptyGateStatus(mergeGateId(issue.id, conflict.pullRequest, conflict.currentHeadSha), conflict.pullRequest, conflict.currentHeadSha, this.options.config.mergePolicy.requiredChecks),
      mergeabilityStateFromPullRequest(livePullRequest, conflict.pullRequest, conflict.currentHeadSha, baseObservation),
    );
    const plan: MergePolicyConflictPreparationPlan = {
      mode: "base_refresh",
      lifecycle,
      gate,
      sourceState: conflict.sourceState,
      conflictsState,
      livePullRequest,
      baseObservation,
      workspacePath,
      branchName,
      expectedHeadSha: conflict.currentHeadSha,
      previousRemoteHeadSha: conflict.currentHeadSha,
      baseBranch,
      mergeableState: livePullRequest.mergeableState,
      existingWritebackOperationKeys: conflict.writebackOperationKeys,
    };
    const execution = await this.prepareServiceConflictBranch(issue, plan);
    if (execution.preparation.status === "clean") {
      await this.publishPreparedConflictHead(plan, execution);
      await this.restorePreservedStashAfterPreparedHead(issue, plan, execution);
    }
    const writebackPlan = this.planServiceConflictWritebacks(issue, plan, execution);
    const result = await this.recordServicePreparedMergeConflict(
      issue,
      plan,
      execution,
      writebackPlan,
    );
    await this.applyServiceConflictWritebacks(issue, plan, writebackPlan);
    return result;
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
    const plan: MergePolicyConflictPreparationPlan = {
      mode: "initial",
      lifecycle,
      gate,
      sourceState,
      conflictsState,
      livePullRequest,
      baseObservation,
      workspacePath,
      branchName,
      expectedHeadSha: gate.headSha,
      previousRemoteHeadSha: gate.headSha,
      baseBranch: livePullRequest.baseBranch,
      mergeableState: livePullRequest.mergeableState,
      existingWritebackOperationKeys: [],
    };
    const execution = await this.prepareServiceConflictBranch(issue, plan);
    if (execution.preparation.status === "clean") {
      await this.publishPreparedConflictHead(plan, execution);
      await this.restorePreservedStashAfterPreparedHead(issue, plan, execution);
    }
    const writebackPlan = this.planServiceConflictWritebacks(issue, plan, execution);
    const result = await this.recordServicePreparedMergeConflict(
      issue,
      plan,
      execution,
      writebackPlan,
    );
    await this.applyServiceConflictWritebacks(issue, plan, writebackPlan);
    return result;
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
    const rawOperations = planMergeGateHeadSupersessionWritebacks(
      { issue, gateId, fromState: sourceState, pullRequest, liveHeadSha, reportId: report.id },
      this.options.config,
    );
    const operationKeys = rawOperations.map((operation) => operation.idempotencyKey);
    const supersededGate: IssueMergeGateState = {
      ...supersededPatch,
      writebackOperationKeys: operationKeys,
    };
    const operations = rawOperations.map((operation) =>
      bindWritebackOperationToLifecycle(operation, {
        kind: "merge_gate",
        recordId: supersededGate.id,
        status: "superseded",
        headSha: supersededGate.headSha,
        supersededByHeadSha: liveHeadSha,
      }),
    );
    await this.enqueueMergeGateWritebacks(operations);
    await this.options.lifecycleStore.updateIssue(issue, {
      ...(gate
        ? {
            ...inactiveMergeGateLifecyclePatch(lifecycle, gate, "superseded", liveHeadSha),
            mergeGate: supersededGate,
          }
        : { mergeGate: supersededGate }),
      phase: "implementation",
      blockedReason: null,
      lastReviewVerdictId: null,
      summaryPointers: { ciStatus: "head_superseded" },
    });
    await this.requireMergeGateWritebacksSucceeded(
      issue,
      operations,
      this.options.config.writeback.dispatchState,
    );
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
  ): Promise<WritebackOperation[]> {
    const writeback = this.options.writeback;
    if (!writeback) throw new SymphonyError("invalid_request", "Gated merge policy requires service-owned writeback");
    const results: WritebackOperation[] = [];
    for (const operation of operations) {
      const result: WritebackOperation = await writeback.enqueueAndProcess(operation, { retrySkipped: true });
      results.push(result);
      if (result.status !== "succeeded") {
        throw new SymphonyError(
          "invalid_request",
          `Merge gate writeback did not succeed: ${result.status}${result.lastError ? ` (${result.lastError})` : ""}`,
        );
      }
    }
    if (expectedState === null) return results;
    const latest = (await this.options.tracker.fetchIssueStatesByIds([issue.id]))[0] ?? null;
    if (!latest || !statesEqual(latest.state, expectedState)) {
      throw new SymphonyError("invalid_request", "Merge gate writeback could not be verified");
    }
    return results;
  }

  private async retryDurableMergeGateResultWritebacks(
    issue: Issue,
    lifecycle: IssueLifecycleRecord,
    sourceState: string,
  ): Promise<void> {
    const gate = lifecycle.mergeGate ?? null;
    if (gate === null || (gate.status !== "repair_dispatched" && gate.status !== "blocked")) return;
    const result = (lifecycle.mergeGateResults ?? []).find(
      (candidate) =>
        candidate.id === gate.id &&
        !isSupersededLifecycleRecord(candidate),
    );
    if (!result) return;
    if (result.writebackOperationKeys.length === 0) {
      throw new SymphonyError(
        "invalid_request",
        "Durable merge-gate result does not own any writebacks",
      );
    }
    const writeback = this.options.writeback;
    if (!writeback) {
      throw new SymphonyError(
        "invalid_request",
        "Gated merge policy requires service-owned writeback",
      );
    }
    const operations = await writeback.retryRegistered(
      result.writebackOperationKeys,
      { retrySkipped: true },
    );
    const incomplete = operations.find(
      (operation) => operation.status !== "succeeded",
    );
    if (incomplete) {
      throw new SymphonyError(
        "invalid_request",
        `Merge gate writeback did not succeed: ${incomplete.status}${
          incomplete.lastError ? ` (${incomplete.lastError})` : ""
        }`,
      );
    }
    const expectedState =
      result.status === "blocked"
        ? this.options.config.reviewLoop.blockedStates[0] ?? null
        : this.options.config.writeback.dispatchState;
    if (expectedState === null) return;
    const latest =
      (await this.options.tracker.fetchIssueStatesByIds([issue.id]))[0] ?? null;
    if (!latest || !statesEqual(latest.state, expectedState)) {
      throw new SymphonyError(
        "invalid_request",
        "Merge gate writeback could not be verified",
      );
    }
  }

  private async enqueueMergeGateWritebacks(
    operations: Parameters<WritebackProcessor["enqueueAndProcess"]>[0][],
  ): Promise<void> {
    const writeback = this.options.writeback;
    if (!writeback) {
      throw new SymphonyError(
        "invalid_request",
        "Gated merge policy requires service-owned writeback",
      );
    }
    for (const operation of operations) await writeback.enqueue(operation);
  }

  private mergeSourceState(issue: Issue, lifecycle: IssueLifecycleRecord | null = null): string | null {
    const sourceState = this.options.config.mergePolicy.sourceStates.find((state) => statesEqual(state, issue.state)) ?? null;
    if (sourceState !== null) return sourceState;
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
    const reportPullRequest = latestCurrentCompletionReport(lifecycle)?.pullRequest ?? null;
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

function findMergeGateFailure(lifecycle: IssueLifecycleRecord, gateId: string): MergeGateFailureRecord | null {
  const result =
    (lifecycle.mergeGateResults ?? []).find(
      (item) => item.id === gateId && !isSupersededLifecycleRecord(item),
    ) ?? null;
  if (result) return result;
  return lifecycle.reviewVerdicts.find((verdict) => verdict.id === gateId && isMergeGateVerdict(verdict)) ?? null;
}

export function isMergeGateVerdict(verdict: IssueReviewVerdictRecord): boolean {
  return verdict.reviewer === MERGE_GATE_REVIEWER || verdict.id.startsWith("merge-gate:");
}

function upsertMergeGateResult(
  results: IssueMergeGateResultRecord[],
  mergeGateResult: IssueMergeGateResultRecord,
): IssueMergeGateResultRecord[] {
  const result = results.filter((item) => item.id !== mergeGateResult.id);
  result.push(mergeGateResult);
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
  approvedPullRequest: CompletionReportPullRequestRef,
): IssueMergeConflictMetadata | null {
  const conflictsState = config.mergePolicy.conflictsState;
  const mergeConflict = lifecycle.mergeConflict;
  if (conflictsState === null || mergeConflict?.resolutionStatus !== "resolved") return null;
  if (!resolvedMergeConflictMatchesLatestReport(mergeConflict, approvedPullRequest)) return null;
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

function resolvedMergeConflictMatchesLatestReport(
  mergeConflict: IssueMergeConflictMetadata,
  approvedPullRequest: CompletionReportPullRequestRef,
): boolean {
  if (mergeConflict.pullRequest.number !== approvedPullRequest.number) return false;
  if (mergeConflict.pullRequest.url !== approvedPullRequest.url) return false;
  if (mergeConflict.pullRequest.branch !== approvedPullRequest.branch) return false;
  const reportHeadSha = approvedPullRequest.headSha?.trim() ?? "";
  if (reportHeadSha.length === 0) return false;
  if (reportHeadSha === mergeConflict.approvedHeadSha) return true;
  return mergeConflict.resolvedHeadSha !== null && reportHeadSha === mergeConflict.resolvedHeadSha;
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

function pullRequestForBaseRefRepair(
  lifecycle: IssueLifecycleRecord,
  branchName: string,
  headSha: string,
): CompletionReportPullRequestRef | null {
  const reportPullRequest = latestCurrentCompletionReport(lifecycle)?.pullRequest ?? null;
  const hasSummaryRemoteMetadata =
    lifecycle.summaryPointers.prUrl !== null ||
    lifecycle.summaryPointers.prNumber !== null ||
    lifecycle.summaryPointers.prHeadSha !== null ||
    lifecycle.summaryPointers.prBranch !== null;
  const summaryPullRequest: CompletionReportPullRequestRef | null = hasSummaryRemoteMetadata
    ? {
        url: lifecycle.summaryPointers.prUrl ?? reportPullRequest?.url ?? null,
        number: lifecycle.summaryPointers.prNumber ?? reportPullRequest?.number ?? null,
        headSha: lifecycle.summaryPointers.prHeadSha,
        branch:
          lifecycle.summaryPointers.prBranch ??
          reportPullRequest?.branch ??
          branchName,
      }
    : null;
  const candidates = [summaryPullRequest, reportPullRequest].filter(
    (pullRequest): pullRequest is CompletionReportPullRequestRef =>
      pullRequest !== null,
  );
  if (candidates.length === 0) return null;

  const matched = candidates.find((pullRequest) => pullRequest.headSha === headSha) ?? null;
  if (matched !== null) {
    return {
      ...matched,
      headSha,
      branch: matched.branch ?? branchName,
    };
  }
  if (candidates.every((pullRequest) => pullRequest.headSha === null)) {
    throw new SymphonyError(
      "invalid_request",
      "PR-backed base-ref repair requires lifecycle PR head metadata",
    );
  }
  requireMatchesAny(
    "lifecycle PR head SHA",
    headSha,
    candidates.map((pullRequest) => pullRequest.headSha),
  );
  throw new SymphonyError("invalid_request", "lifecycle PR head SHA does not match gated merge metadata");
}

function pullRequestRefForPreservedStashRestore(
  lifecycle: IssueLifecycleRecord,
  branchName: string,
  headSha: string,
): CompletionReportPullRequestRef {
  const reportPullRequest = latestCurrentCompletionReport(lifecycle)?.pullRequest ?? null;
  return {
    url: reportPullRequest?.url ?? lifecycle.summaryPointers.prUrl,
    number: reportPullRequest?.number ?? lifecycle.summaryPointers.prNumber,
    headSha,
    branch:
      reportPullRequest?.branch ??
      lifecycle.summaryPointers.prBranch ??
      branchName,
  };
}

function restorablePreservedWorktreeStashes(
  stashes: readonly IssuePreservedWorktreeStash[],
): IssuePreservedWorktreeStash[] {
  return stashes.filter(
    (stash) =>
      stash.status === "created" ||
      stash.status === "applied_clean" ||
      stash.status === "finalized" ||
      stash.status === "drop_failed",
  );
}

function firstPendingCreatedPreservedStash(
  stashes: readonly IssuePreservedWorktreeStash[],
): IssuePreservedWorktreeStash | null {
  return stashes.find((stash) => stash.status === "created") ?? null;
}

function latestRestoredPreservedStash(
  stashes: readonly IssuePreservedWorktreeStash[],
): IssuePreservedWorktreeStash | null {
  for (let index = stashes.length - 1; index >= 0; index -= 1) {
    const stash = stashes[index]!;
    if (
      stash.status === "applied_clean" ||
      stash.status === "finalized" ||
      stash.status === "dropped" ||
      stash.status === "drop_failed"
    ) {
      return stash;
    }
  }
  return null;
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildBaseRefRepairMergeConflict(input: {
  issue: Issue;
  pullRequest: CompletionReportPullRequestRef;
  sourceState: string;
  conflictsState: string;
  baseBranch: string;
  baseHeadSha: string;
  preparation: ServiceOwnedMergeConflictPreparationResult & { status: "conflicted" };
  blockerProvenanceId: string | null;
  maxFixTurns: number;
  now: string;
}): IssueMergeConflictMetadata {
  return {
    id: `merge-conflict:${input.issue.id}:${input.preparation.originalHeadSha}:${input.preparation.liveBaseHeadSha}`,
    status: "open",
    resolutionStatus: "pending",
    pullRequest: { ...input.pullRequest, headSha: input.preparation.originalHeadSha },
    approvedHeadSha: input.preparation.originalHeadSha,
    currentHeadSha: input.preparation.originalHeadSha,
    resolvedHeadSha: null,
    baseBranch: input.baseBranch,
    baseHeadSha: input.baseHeadSha,
    sourceState: input.sourceState,
    conflictsState: input.conflictsState,
    reason: "Worktree rebase over the live origin base produced conflicts",
    mergeableState: "dirty",
    blockerProvenanceId: input.blockerProvenanceId,
    servicePreparation: {
      strategy: "squash_rebase",
      status: "conflicted",
      originalHeadSha: input.preparation.originalHeadSha,
      observedPrBaseHeadSha: input.preparation.observedPrBaseHeadSha,
      liveBaseHeadSha: input.preparation.liveBaseHeadSha,
      preparedBaseHeadSha: input.preparation.preparedBaseHeadSha,
      mergeBaseSha: input.preparation.mergeBaseSha,
      squashCommitSha: input.preparation.squashCommitSha,
      conflictedFiles: input.preparation.conflictedFiles,
      preparedAt: input.now,
      finalizedAt: null,
      finalizedHeadSha: null,
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

function buildServicePreparedMergeConflict(input: {
  issue: Issue;
  gate: MergeGateStatus;
  sourceState: string;
  conflictsState: string;
  mergeableState: string | null;
  preparation: ServiceOwnedMergeConflictPreparationResult & {
    preservedStash?: IssuePreservedWorktreeStash | null;
  };
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
    blockerProvenanceId: null,
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
      preservedStash: input.preparation.preservedStash ?? null,
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

function buildStashApplyMergeConflict(input: {
  issue: Issue;
  pullRequest: CompletionReportPullRequestRef;
  sourceState: string;
  conflictsState: string;
  baseBranch: string | null;
  baseHeadSha: string | null;
  currentHeadSha: string;
  preservedStash: IssuePreservedWorktreeStash;
  changedFiles: string[];
  conflictedFiles: string[];
  reason: string;
  blockerProvenanceId?: string | null;
  maxFixTurns: number;
  now: string;
}): IssueMergeConflictMetadata {
  const allowedFiles = sortedUnique([
    ...input.preservedStash.dirtyFiles,
    ...input.changedFiles,
    ...input.conflictedFiles,
  ]);
  return {
    id: `merge-conflict:${input.issue.id}:stash-apply:${input.currentHeadSha}:${input.preservedStash.stashSha}`,
    status: "open",
    resolutionStatus: "pending",
    pullRequest: { ...input.pullRequest, headSha: input.currentHeadSha },
    approvedHeadSha: input.currentHeadSha,
    currentHeadSha: input.currentHeadSha,
    resolvedHeadSha: null,
    baseBranch: input.baseBranch,
    baseHeadSha: input.baseHeadSha,
    sourceState: input.sourceState,
    conflictsState: input.conflictsState,
    reason: input.reason,
    mergeableState: "dirty",
    blockerProvenanceId: input.blockerProvenanceId ?? null,
    servicePreparation: {
      strategy: "stash_apply",
      status: "conflicted",
      originalHeadSha: input.currentHeadSha,
      currentHeadSha: input.currentHeadSha,
      conflictedFiles: input.conflictedFiles,
      allowedFiles,
      preservedStash: input.preservedStash,
      preparedAt: input.now,
      finalizedAt: null,
      finalizedHeadSha: null,
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

function withPreservedStash(
  preparation: ServiceOwnedMergeConflictPreparationResult,
  preservedStash: IssuePreservedWorktreeStash | null,
): ServiceOwnedMergeConflictPreparationResult & {
  preservedStash?: IssuePreservedWorktreeStash | null;
} {
  return preservedStash === null ? preparation : { ...preparation, preservedStash };
}

function upsertPreservedWorktreeStash(
  stashes: IssuePreservedWorktreeStash[],
  stash: IssuePreservedWorktreeStash,
): IssuePreservedWorktreeStash[] {
  const index = stashes.findIndex((item) => item.id === stash.id);
  if (index === -1) return [...stashes, stash];
  return stashes.map((item, itemIndex) => (itemIndex === index ? stash : item));
}

function preservedWorktreeStashesOf(
  lifecycle: Pick<IssueLifecycleRecord, "preservedWorktreeStashes">,
): IssuePreservedWorktreeStash[] {
  return lifecycle.preservedWorktreeStashes ?? [];
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
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
  if (approvedHeadSha === resolvedHeadSha) return;
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
): IssueReviewVerdictRecord | null {
  return latestCurrentApprovalPassVerdict(lifecycle);
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

export interface LiveBaseObservation {
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

function mergeGateResultIdempotencyKey(gate: MergeGateStatus, kind: "repair" | "blocked"): string {
  return `${gate.id}:${kind}:${gate.blockerFingerprint ?? "no-blocker-fingerprint"}`;
}

function isSameMergeGateBlocker(lifecycle: IssueLifecycleRecord, gate: MergeGateStatus): boolean {
  const current = lifecycle.mergeGate ?? null;
  return (
    current !== null &&
    current.id === gate.id &&
    (current.status === "repair_dispatched" || current.status === "blocked") &&
    current.blockerFingerprint === gate.blockerFingerprint &&
    (lifecycle.lastMergeGateResultId === gate.id || legacyMergeGateVerdictPointer(lifecycle, gate.id))
  );
}

function legacyMergeGateVerdictPointer(lifecycle: IssueLifecycleRecord, gateId: string): boolean {
  if (lifecycle.lastReviewVerdictId !== gateId) return false;
  return lifecycle.reviewVerdicts.some((verdict) => verdict.id === gateId && isMergeGateVerdict(verdict));
}

function shouldRefreshSameMergeGateBlocker(lifecycle: IssueLifecycleRecord, gate: MergeGateStatus): boolean {
  if (!isSameMergeGateBlocker(lifecycle, gate)) return false;
  if (lifecycle.phase === "passed") return false;
  const current = lifecycle.mergeGate ?? null;
  if (current?.status === "repair_dispatched" && hasCompletedRepairApproval(lifecycle, current)) return false;
  return true;
}

function hasCompletedRepairApproval(lifecycle: IssueLifecycleRecord, gate: IssueMergeGateState): boolean {
  if (!gate.repairRunId || !gate.repairReportId) return false;
  if (lifecycle.lastCompletionReportId !== gate.repairReportId) return false;
  const repairReport = latestCurrentCompletionReport(lifecycle);
  if (!repairReport || repairReport.runId !== gate.repairRunId) return false;
  if (repairReport.acceptedAt.trim().length === 0) return false;
  if (repairReport.pullRequest?.number !== gate.pullRequest.number) return false;
  if (repairReport.pullRequest?.headSha !== gate.headSha) return false;
  if (gate.gateReportId && repairReport.id === gate.gateReportId) return false;

  const gateFailedAtValue = mergeGateFailureSubmittedAt(lifecycle, gate.id);
  if (gateFailedAtValue === null) return false;
  const approvalVerdict = latestCurrentApprovalPassVerdict(lifecycle);
  if (!approvalVerdict) return false;
  const repairAcceptedAt = Date.parse(repairReport.acceptedAt);
  const approvalSubmittedAt = Date.parse(approvalVerdict.submittedAt);
  const gateFailedAt = Date.parse(gateFailedAtValue);
  if (!Number.isFinite(repairAcceptedAt) || !Number.isFinite(approvalSubmittedAt) || !Number.isFinite(gateFailedAt)) return false;
  return repairAcceptedAt > gateFailedAt && approvalSubmittedAt > repairAcceptedAt;
}

function mergeGateFailureSubmittedAt(lifecycle: IssueLifecycleRecord, gateId: string): string | null {
  const result =
    (lifecycle.mergeGateResults ?? []).find(
      (item) => item.id === gateId && !isSupersededLifecycleRecord(item),
    ) ?? null;
  if (result) return result.submittedAt;
  const legacyVerdict = lifecycle.reviewVerdicts.find((verdict) => verdict.id === gateId && isMergeGateVerdict(verdict)) ?? null;
  return legacyVerdict?.submittedAt ?? null;
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
  return latestCurrentApprovalPassVerdict(lifecycle)?.id ?? lifecycle.lastReviewVerdictId;
}

function previousMergeGateRepairRound(lifecycle: IssueLifecycleRecord, gate: MergeGateStatus): number {
  const current = lifecycle.mergeGate;
  if (!current) return 0;
  if (current.id === gate.id) return current.reviewRound;
  if (current.status === "superseded" && current.pullRequest.number === gate.pullRequest.number) {
    return current.reviewRound;
  }
  return 0;
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

function requireObservationValue<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new SymphonyError("invalid_request", message);
  return value;
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

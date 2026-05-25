import { setTimeout as delay } from "node:timers/promises";
import type { ServiceConfig } from "../config/Config.js";
import { SymphonyError, errorMessage } from "../errors.js";
import type { AgentActivitySource, AgentEvent, AgentHarness, AgentRunSdkStatus } from "../harness/AgentHarness.js";
import type { Logger } from "../logging/StructuredLogger.js";
import type { TrackerClient } from "../tracker/TrackerClient.js";
import {
  runKindForPhase,
  toIssueStatusView,
  type AgentRunPhase,
  type AgentRunKind,
  type AgentRunRole,
  type Issue,
  type IssueStatusView,
  type RuntimeTotals,
  type TokenCounts,
  type Workspace,
} from "../types.js";
import type { WorkspaceManager } from "../workspace/WorkspaceManager.js";
import {
  CompletionReportService,
  isFinalizedCompletionReport,
  isPendingPublicationApprovalReason,
  pendingPublicationHandoffForRun,
  type CompletionReportPullRequestPublisher,
} from "../CompletionReportService.js";
import {
  latestFreshIssueBreakdownPlan,
  renderIssueBreakdownPlanSummary,
} from "../IssueBreakdownPlanService.js";
import { PromptRenderer } from "../workflow/PromptRenderer.js";
import {
  DEFAULT_REVIEWER_REVIEW_LOOP_GUIDANCE,
  DEFAULT_WORKER_INVARIANT_REPAIR_GUIDANCE,
  formatGeneralScenarioMatrix,
  formatPromptExtensions,
} from "../workflow/ReviewLoopPromptGuidance.js";
import {
  compareRunChronology,
  type RunActivitySnapshot,
  type RunMetadata,
  type RunRecord,
  type RunTranscriptStore,
  type TranscriptEvent,
  type UpdateRunInput,
} from "../persistence/RunTranscriptStore.js";
import { appendLaneMemoTelemetry } from "../persistence/LaneMemoTelemetry.js";
import {
  buildWorkerHandoffPacket,
  phaseForIssueState,
  type IssueCompletionReportRecord,
  type IssueLifecyclePatch,
  type IssueLifecycleRecord,
  type IssueLifecycleSummaryReference,
  type IssueLifecycleStore,
  type IssueReviewVerdictRecord,
} from "../persistence/IssueLifecycleStore.js";
import { MergePolicyService, type MergePolicyGitHubClient } from "../merge/MergePolicyService.js";
import {
  formatWorkerReviewEvidencePrompt,
  isActiveReviewEvidenceItem,
  PullRequestReviewEvidenceService,
  type PullRequestReviewEvidenceClient,
} from "../review/PullRequestReviewEvidenceService.js";
import { formatWorkerReviewVerdictPrompt } from "../ReviewVerdictService.js";
import {
  PlaceholderContinuationSummarizer,
  type ContinuationSummarizer,
} from "../summarization/ContinuationSummarizer.js";
import { FileWritebackOutboxStore, type WritebackProcessor } from "../writeback/WritebackOutbox.js";
import {
  planBlockedEscalationWritebacks,
  planDispatchWriteback,
  planRunCancelledComment,
  planRunFailedComment,
  planRunStartedComment,
  planRunSucceededWritebacks,
} from "../writeback/TransitionPolicy.js";
import { createGitHubPullRequestClientForCapability } from "../../integrations/github/GitHubCredentialResolver.js";
import {
  OPERATOR_REJECTED_PUBLICATION_ERROR,
  type OperatorApprovalRecord,
  type OperatorApprovalService,
} from "../approval/OperatorApprovalService.js";

export interface OrchestratorOptions {
  config: ServiceConfig;
  tracker: TrackerClient;
  workspaceManager: WorkspaceManager;
  harness: AgentHarness;
  logger: Logger;
  promptTemplate: string;
  runStore?: RunTranscriptStore;
  lifecycleStore?: IssueLifecycleStore;
  writeback?: WritebackProcessor;
  pullRequestClient?: PullRequestDiscoveryClient;
  pullRequestReviewClient?: PullRequestReviewEvidenceClient;
  pullRequestMergeClient?: MergePolicyGitHubClient;
  completionReportPublisher?: CompletionReportPullRequestPublisher;
  operatorApproval?: Pick<OperatorApprovalService, "requestPublicationApproval" | "waitForPublicationApprovalRequest"> &
    Partial<Pick<OperatorApprovalService, "get" | "getByDedupe">>;
}

export interface PullRequestDiscoveryClient {
  findOpenPullRequestByBranch(input: { branchName: string }): Promise<DiscoveredPullRequest | null>;
}

export interface DiscoveredPullRequest {
  url: string;
  number: number;
  headBranch: string;
  headSha: string | null;
  lastPushedAt: string | null;
  draft?: boolean;
}

export interface ContinuationSummaryCreationResult {
  summaryReference: IssueLifecycleSummaryReference;
  lifecycle: IssueLifecycleRecord;
}

export interface RunningEntry {
  issue: Issue;
  role: AgentRunRole;
  runPhase: AgentRunPhase;
  workspacePath: string | null;
  workspace: Workspace | null;
  sessionId: string | null;
  runId: string | null;
  activeRunId: string | null;
  lifecycle: IssueLifecycleRecord | null;
  worker: Promise<void>;
  abortController: AbortController;
  startedAt: Date;
  lastEventAt: Date | null;
  lastEvent: string | null;
  lastMessage: string | null;
  sdkRunStatus: AgentRunSdkStatus | null;
  sdkRunStatusUpdatedAt: Date | null;
  sdkRunStatusSource: "initial" | "onDidChangeStatus" | "wait" | null;
  failureKind: string | null;
  failureDiagnosticCode: string | null;
  failureDiagnosticMessage: string | null;
  failureDiagnosticAt: Date | null;
  failureDiagnosticPayload: unknown;
  turnCount: number;
  retryAttempt: number;
  tokens: TokenCounts;
  activeRunTokens: TokenCounts;
  cleanupWorkspaceOnExit: boolean;
  suppressRetryOnExit: boolean;
  completionReportAccepted: boolean;
  issueBreakdownPlanAccepted: boolean;
  pullRequestHandoffAccepted: boolean;
  reviewVerdictAccepted: boolean;
  reviewEvidence: ReviewerDispatchEvidence | null;
  cancellationRequestedAt: Date | null;
  cancellationSource: RunCancellationSource | null;
  cancellationReason: string | null;
  abortSignalledAt: Date | null;
  harnessStopRequestedAt: Date | null;
  harnessStopFailedAt: Date | null;
  harnessStopFailedReason: string | null;
  lastStreamActivityAt: Date | null;
  lastDeltaOrToolActivityAt: Date | null;
  lastToolActivityAt: Date | null;
}

interface ReviewerDispatchEvidence {
  lifecycle: IssueLifecycleRecord;
  completionReport: IssueCompletionReportRecord;
  workerRun: RunRecord | null;
  runDigest: string[];
}

type WorkerDispatchDecision =
  | { action: "dispatch"; runPhase: AgentRunPhase }
  | { action: "skip"; reason: "planning_required_no_lifecycle_store" };

export interface RetryEntry {
  issueId: string;
  identifier: string;
  attempt: number;
  dueAtMs: number;
  timer: NodeJS.Timeout;
  error: string | null;
  runPhase: AgentRunPhase;
}

type TerminalRunPatch = Pick<UpdateRunInput, "status" | "completedAt" | "error" | "tokens" | "metadata">;
type TerminalUpdateResult = { updated: true; record: RunRecord | null } | { updated: false; record: RunRecord | null };

export interface RuntimeSnapshot {
  generatedAt: string;
  counts: {
    running: number;
    retrying: number;
    paused: number;
  };
  running: Array<{
    issueId: string;
    issueIdentifier: string;
    role: AgentRunRole;
    runPhase: AgentRunPhase;
    runKind: AgentRunKind;
    state: string;
    workspacePath: string | null;
    sessionId: string | null;
    runId: string | null;
    turnCount: number;
    lastEvent: string | null;
    lastMessage: string | null;
    startedAt: string;
    lastEventAt: string | null;
    liveness: RunLivenessState;
    cancellation: RunCancellationState;
    activity?: RunActivityState;
    tokens: TokenCounts;
    lifecycle: IssueLifecycleRecord | null;
    metadata: IssueRunMetadata;
    issueDetails: IssueStatusView;
  }>;
  retrying: Array<{
    issueId: string;
    issueIdentifier: string;
    attempt: number;
    dueAt: string;
    error: string | null;
  }>;
  paused: string[];
  totals: RuntimeTotals;
  rateLimits: unknown;
}

export type RunLivenessStatus = "starting" | "active" | "terminal_pending" | "stalled" | "cancelling";

export interface RunIdleAlertState {
  active: boolean;
  thresholdMs: number | null;
  lastActivityAt: string;
  secondsSinceLastActivity: number;
  reason: "observe_only" | "suppressed" | null;
}

export interface RunLivenessState {
  status: RunLivenessStatus;
  activeRunId: string | null;
  lastActivityAt: string;
  secondsSinceLastActivity: number;
  stallTimeoutMs: number | null;
  sdkRunStatus?: AgentRunSdkStatus | null;
  sdkRunStatusUpdatedAt?: string | null;
  sdkRunStatusSource?: "initial" | "onDidChangeStatus" | "wait" | null;
  idleAlert?: RunIdleAlertState;
}

export type RunCancellationSource = "operator" | "state_change" | "stalled" | "service_stop";

export interface RunCancellationState {
  requested: boolean;
  requestedAt: string | null;
  source: RunCancellationSource | null;
  reason: string | null;
  abortSignalled: boolean;
  harnessStopRequestedAt: string | null;
  harnessStopFailedAt?: string | null;
  harnessStopFailedReason?: string | null;
  cancelFailed?: CancelFailedState;
  suppressRetryOnExit: boolean;
}

export interface RunActivityState extends RunActivitySnapshot {
  unavailable: string[];
}

export interface CancelFailedState {
  tracked: true;
  active: boolean;
  phase: "none" | "requested" | "failed" | "resolved_cancelled" | "resolved_failed";
  at: string | null;
  reason: string | null;
  source: "harness_stop" | "cancel_ignored" | null;
}

export interface IssueRunMetadata {
  prUrl: string | null;
  prNumber: number | null;
  prHeadSha: string | null;
  prBranch: string | null;
  ciStatus: string | null;
  lastPushedAt: string | null;
  lastEvidenceCursor: string | null;
  branchName: string | null;
  gitBranchName: string | null;
  repoPath: string | null;
  baseRef: string | null;
}

const PROJECT_REVIEWER_PROMPT_EXTENSIONS_MARKER = "[[SYMPHONY_PROJECT_REVIEWER_PROMPT_EXTENSIONS]]";

const DEFAULT_REVIEWER_PROMPT_TEMPLATE = `
You are a reviewer agent for {{ issue.identifier }}.

Inspect only. Do not modify files, create commits, push branches, comment on Linear, transition Linear state, or otherwise change workspace or lifecycle state directly.

Use the linked GitHub pull request as the primary detailed review surface. Call the submit_pull_request_review_feedback MCP tool before any verdict submission to leave concrete feedback directly on the lifecycle-bound PR by submitting a GitHub PR review and/or posting PR review comments. Requested changes must point to the relevant files, lines, or threads on GitHub; a pass verdict should also leave a concise approving or summary review/comment on the PR.

After submit_pull_request_review_feedback succeeds, pass the returned reviewUrl/commentUrls/urls into submit_review_verdict.evidence. Then call the submit_review_verdict MCP tool before ending the run. Use verdict "fail" for requested changes and "pass" only when all acceptance criteria are satisfied. The MCP servers supply the active run, issue, and lifecycle-bound PR context; include runId, issueId, PR number, repository, token, or commit identity only if a tool explicitly asks for it.

${DEFAULT_REVIEWER_REVIEW_LOOP_GUIDANCE}

${formatGeneralScenarioMatrix()}

${PROJECT_REVIEWER_PROMPT_EXTENSIONS_MARKER}

Tool payload guidance:
- acceptanceResults: one entry per acceptance criterion with satisfied true/false and concrete evidence.
- findings: required for fail verdicts, empty for pass verdicts.
- evidence: PR review/comment URLs or other durable review evidence.
- idempotencyKey: a stable unique key for this reviewer verdict.

Feedback tool payload guidance:
- Use kind "review" with event "REQUEST_CHANGES", "COMMENT", or "APPROVE" for whole-PR review feedback; include inline comments when helpful.
- Use kind "review_comment" for a single inline comment or reply, and "issue_comment" only for high-level PR comments.
- Use a stable idempotencyKey; reuse returned URLs as verdict evidence on retry.

Report a verdict in this format:
VERDICT: pass | fail | blocked
SUMMARY:
EVIDENCE:
REQUESTED REVISIONS:

Original issue:
{{ issue.identifier }} - {{ issue.title }}
State: {{ issue.state }}
URL: {{ issue.url }}

Description:
{{ issue.description }}

Acceptance criteria:
{% for item in acceptanceCriteria %}- {{ item }}
{% else %}- No acceptance criteria were supplied.
{% endfor %}

Worker completion report:
Report: {{ completionReport.id }}
Worker run: {{ completionReport.runId }}
Summary: {{ completionReport.summary }}
Changed files:
{% for file in completionReport.changedFiles %}- {{ file }}
{% else %}- No changed files supplied.
{% endfor %}
Risks:
{% for risk in completionReport.risks %}- {{ risk }}
{% else %}- No known risks supplied.
{% endfor %}

Validation evidence:
{% for item in validationEvidence %}- {{ item }}
{% else %}- No validation evidence supplied.
{% endfor %}

Git and workspace evidence:
{% for item in workspaceEvidence %}- {{ item }}
{% else %}- No workspace evidence supplied.
{% endfor %}

Relevant worker run digest:
{% for item in runDigest %}- {{ item }}
{% else %}- No run digest is available.
{% endfor %}
`;

export class Orchestrator {
  private config: ServiceConfig;
  private promptTemplate: string;
  private readonly promptRenderer = new PromptRenderer();
  private pollTimer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;
  private endedRuntimeSeconds = 0;
  private readonly running = new Map<string, RunningEntry>();
  private readonly claimed = new Set<string>();
  private readonly completed = new Set<string>();
  private readonly pausedIssues = new Set<string>();
  private readonly retryAttempts = new Map<string, RetryEntry>();
  private readonly totals: TokenCounts = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  private rateLimits: unknown = null;

  constructor(private readonly options: OrchestratorOptions) {
    this.config = options.config;
    this.promptTemplate = options.promptTemplate;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.options.writeback?.processDue();
    await this.startupCleanup();
    this.scheduleTick(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    for (const retry of this.retryAttempts.values()) clearTimeout(retry.timer);
    for (const [issueId, running] of this.running) {
      running.suppressRetryOnExit = true;
      const stopRunId = this.harnessStopRunId(running);
      this.markCancellationRequested(running, {
        source: "service_stop",
        reason: "orchestrator stop",
        abortSignalled: true,
        harnessStopRequested: stopRunId !== null,
      });
      running.abortController.abort();
      if (stopRunId !== null) await this.requestHarnessStop(running, stopRunId);
    }
    await Promise.allSettled([...this.running.values()].map((entry) => entry.worker));
  }

  updateConfig(config: ServiceConfig, promptTemplate: string): void {
    this.config = config;
    this.promptTemplate = promptTemplate;
  }

  async refreshNow(): Promise<void> {
    await this.tick();
  }

  pauseIssue(issueId: string): void {
    this.pausedIssues.add(issueId);
    this.clearRetry(issueId);
  }

  resumeIssue(issueId: string): void {
    this.pausedIssues.delete(issueId);
    this.scheduleTick(0);
  }

  async cancelIssue(issueId: string): Promise<void> {
    this.clearRetry(issueId);
    this.claimed.delete(issueId);
    const running = this.running.get(issueId);
    if (!running) return;
    running.suppressRetryOnExit = true;
    const stopRunId = this.harnessStopRunId(running);
    this.markCancellationRequested(running, {
      source: "operator",
      reason: "operator request",
      abortSignalled: true,
      harnessStopRequested: stopRunId !== null,
    });
    running.abortController.abort();
    if (stopRunId !== null) await this.requestHarnessStop(running, stopRunId);
  }

  async requestIssueBreakdown(issueIdOrIdentifier: string): Promise<{ queued: boolean; issue: Issue; reason: string }> {
    if (!this.config.issueBreakdown.enabled) {
      throw new SymphonyError("invalid_request", "Issue breakdown planning is disabled");
    }
    if (!this.options.lifecycleStore) {
      throw new SymphonyError("invalid_request", "Issue breakdown planning requires a lifecycle store");
    }
    if (this.availableSlots() <= 0) {
      throw new SymphonyError("conflict", "No agent slots are available for issue breakdown planning");
    }
    const refreshed = await this.options.tracker.fetchIssueStatesByIds([issueIdOrIdentifier]);
    const issue = refreshed[0];
    if (!issue) throw new SymphonyError("not_found", `Issue not found: ${issueIdOrIdentifier}`);
    if (this.running.has(issue.id)) throw new SymphonyError("conflict", "Issue already has a running Symphony agent");
    if (!this.shouldDispatchWorker(issue, false)) {
      throw new SymphonyError("conflict", "Issue is not currently eligible for worker dispatch");
    }
    if (!(await this.lifecycleAllowsDispatch(issue, "worker", "issue_breakdown"))) {
      throw new SymphonyError("conflict", "Issue lifecycle does not currently allow issue breakdown planning");
    }
    const lifecycle = await this.options.lifecycleStore.get(issue.id);
    if (latestFreshIssueBreakdownPlan(lifecycle, issue, this.config) !== null) {
      return { queued: false, issue, reason: "fresh_plan_exists" };
    }
    this.dispatchIssue(issue, null, "worker", null, "issue_breakdown");
    return { queued: true, issue, reason: "explicit_request" };
  }

  async resumeApprovedPublication(request: OperatorApprovalRecord): Promise<boolean> {
    if (request.status !== "approved" || !this.options.lifecycleStore) return false;
    const latestIssues = await this.options.tracker.fetchIssueStatesByIds([request.issueId]);
    const issue = latestIssues[0] ?? issueFromApprovalRequest(request);
    const publisher =
      this.options.completionReportPublisher ??
      createGitHubPullRequestClientForCapability(this.config, "github.publication");
    const result = await new CompletionReportService({
      config: this.config,
      lifecycleStore: this.options.lifecycleStore,
      writebackOutbox: new FileWritebackOutboxStore(this.config.workspace.stateDir),
      ...(this.options.runStore === undefined ? {} : { runStore: this.options.runStore }),
      ...(this.options.writeback === undefined ? {} : { writebackProcessor: this.options.writeback }),
      pullRequestPublisher: publisher,
    }).resumeApprovedPublication({ approval: request, issue });
    if (!result) return false;
    await this.options.writeback?.processDue();
    return true;
  }

  async recordPublicationApprovalTerminal(request: OperatorApprovalRecord): Promise<boolean> {
    if (!this.options.lifecycleStore) return false;
    const latestIssues = await this.options.tracker.fetchIssueStatesByIds([request.issueId]);
    const issue = latestIssues[0] ?? issueFromApprovalRequest(request);
    const result = await new CompletionReportService({
      config: this.config,
      lifecycleStore: this.options.lifecycleStore,
      writebackOutbox: new FileWritebackOutboxStore(this.config.workspace.stateDir),
      ...(this.options.runStore === undefined ? {} : { runStore: this.options.runStore }),
    }).recordPublicationApprovalTerminal({ approval: request, issue });
    if (!result) return false;
    await this.options.writeback?.processDue();
    return true;
  }

  async createContinuationSummary(
    issueOrId: Pick<Issue, "id" | "identifier" | "title"> | string,
    summarizer: ContinuationSummarizer = new PlaceholderContinuationSummarizer(),
  ): Promise<ContinuationSummaryCreationResult> {
    const lifecycleStore = this.options.lifecycleStore;
    const runStore = this.options.runStore;
    if (!lifecycleStore || !runStore) {
      throw new SymphonyError("invalid_request", "Continuation summaries require lifecycle and transcript stores");
    }

    const lifecycle =
      typeof issueOrId === "string"
        ? await lifecycleStore.get(issueOrId)
        : await lifecycleStore.ensureIssue(issueOrId);
    if (!lifecycle) throw new SymphonyError("not_found", `Issue lifecycle not found: ${issueOrId}`);

    const issue =
      typeof issueOrId === "string"
        ? { id: lifecycle.issueId, identifier: lifecycle.issueIdentifier, title: lifecycle.issueIdentifier }
        : issueOrId;
    const runs = await listRunsForLifecycle(runStore, lifecycle);
    const transcriptEvents = await readContinuationTranscriptEvents(runStore, runs);
    const summaryReference = await summarizer.summarizeContinuationHistory({
      issue,
      runs,
      transcriptEvents,
      transcriptPointers: transcriptPointersForRuns(runs),
      statusApiPointers: statusApiPointersForIssue(lifecycle.issueIdentifier, runs),
    });
    const updated = await lifecycleStore.updateIssue(
      { id: lifecycle.issueId, identifier: lifecycle.issueIdentifier },
      { summaryReferences: upsertSummaryReference(lifecycle.summaryReferences, summaryReference) },
    );
    return { summaryReference, lifecycle: updated };
  }

  snapshot(): RuntimeSnapshot {
    const now = Date.now();
    return {
      generatedAt: new Date(now).toISOString(),
      counts: {
        running: this.running.size,
        retrying: this.retryAttempts.size,
        paused: this.pausedIssues.size,
      },
      running: [...this.running.entries()].map(([issueId, entry]) => ({
        issueId,
        issueIdentifier: entry.issue.identifier,
        role: entry.role,
        runPhase: entry.runPhase,
        runKind: runKindForPhase(entry.runPhase),
        state: entry.issue.state,
        workspacePath: entry.workspacePath,
        sessionId: entry.sessionId,
        runId: entry.runId,
        turnCount: entry.turnCount,
        lastEvent: entry.lastEvent,
        lastMessage: entry.lastMessage,
        startedAt: entry.startedAt.toISOString(),
        lastEventAt: entry.lastEventAt?.toISOString() ?? null,
        liveness: this.livenessForEntry(entry, now),
        cancellation: cancellationForEntry(entry),
        activity: activityForEntry(entry),
        tokens: entry.tokens,
        lifecycle: entry.lifecycle,
        metadata: metadataForRunningEntry(entry),
        issueDetails: toIssueStatusView(entry.issue),
      })),
      retrying: [...this.retryAttempts.values()].map((entry) => ({
        issueId: entry.issueId,
        issueIdentifier: entry.identifier,
        attempt: entry.attempt,
        dueAt: new Date(entry.dueAtMs).toISOString(),
        error: entry.error,
      })),
      paused: [...this.pausedIssues],
      totals: {
        ...this.totals,
        secondsRunning: this.endedRuntimeSeconds + this.activeRuntimeSeconds(now),
      },
      rateLimits: this.rateLimits,
    };
  }

  getIssueDetails(issueIdOrIdentifier: string): RuntimeSnapshot["running"][number] | null {
    const snapshot = this.snapshot();
    return (
      snapshot.running.find(
        (row) => row.issueId === issueIdOrIdentifier || row.issueIdentifier === issueIdOrIdentifier,
      ) ?? null
    );
  }

  private scheduleTick(delayMs: number): void {
    if (this.stopped) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      void this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      await this.reconcileRunningIssues();
      await this.recoverPendingPublicationApprovalHandoffs();
      const workerCandidates = await this.options.tracker.fetchCandidateIssues();
      for (const issue of sortIssuesForDispatch(workerCandidates)) {
        if (this.availableSlots() <= 0) break;
        await this.tryDispatchWorkerIssue(issue, null);
      }
      const reviewerCandidates = await this.options.tracker.fetchIssuesByStates(this.config.reviewLoop.reviewStates);
      for (const issue of sortIssuesForDispatch(reviewerCandidates)) {
        if (this.availableSlots() <= 0) break;
        await this.tryDispatchReviewerIssue(issue);
      }
      await this.reconcileMergePolicyIssues();
    } catch (error) {
      this.options.logger.warn("orchestrator tick failed", { error: errorMessage(error) });
    } finally {
      this.ticking = false;
      this.scheduleTick(this.config.polling.intervalMs);
    }
  }

  private async startupCleanup(): Promise<void> {
    try {
      const terminalIssues = await this.options.tracker.fetchIssuesByStates(this.config.tracker.terminalStates);
      for (const issue of terminalIssues) {
        await this.options.workspaceManager.removeForIssue(issue);
      }
    } catch (error) {
      this.options.logger.warn("startup terminal cleanup failed", { error: errorMessage(error) });
    }
  }

  private async recoverPendingPublicationApprovalHandoffs(): Promise<void> {
    if (
      !this.config.github.publishPullRequests ||
      !(this.config.github.operatorApproval?.requiredForPublication ?? false) ||
      !this.options.lifecycleStore ||
      !this.options.writeback ||
      !this.options.operatorApproval
    ) {
      return;
    }

    let lifecycles: IssueLifecycleRecord[];
    try {
      lifecycles = await this.options.lifecycleStore.list();
    } catch (error) {
      this.options.logger.warn("pending publication approval recovery lifecycle scan failed", { error: errorMessage(error) });
      return;
    }
    const candidates = lifecycles.filter(hasRecoverablePendingPublicationApproval);
    if (candidates.length === 0) return;

    let latestIssues: Issue[] = [];
    try {
      latestIssues = await this.options.tracker.fetchIssueStatesByIds(candidates.map((lifecycle) => lifecycle.issueId));
    } catch (error) {
      this.options.logger.warn("pending publication approval recovery issue refresh failed", { error: errorMessage(error) });
    }
    const issuesById = new Map(latestIssues.map((issue) => [issue.id, issue]));
    const service = new CompletionReportService({
      config: this.config,
      lifecycleStore: this.options.lifecycleStore,
      writebackOutbox: new FileWritebackOutboxStore(this.config.workspace.stateDir),
      writebackProcessor: this.options.writeback,
      ...(this.options.runStore === undefined ? {} : { runStore: this.options.runStore }),
      pullRequestPublisher:
        this.options.completionReportPublisher ??
        createGitHubPullRequestClientForCapability(this.config, "github.publication"),
      operatorApproval: this.options.operatorApproval,
    });

    for (const lifecycle of candidates) {
      const issue = issuesById.get(lifecycle.issueId) ?? issueFromPendingPublicationLifecycle(lifecycle, this.config.writeback.dispatchState);
      try {
        const result = await service.recoverPendingPublicationApproval({ issue, lifecycle });
        if (result.recovered) {
          this.options.logger.info("pending publication approval recovered", {
            issue_id: lifecycle.issueId,
            issue_identifier: lifecycle.issueIdentifier,
            run_id: result.report.runId,
            approval_request_id: result.outcome === "pending" ? result.approvalRequest.requestId : null,
            outcome: result.outcome,
          });
        }
      } catch (error) {
        this.options.logger.warn("pending publication approval recovery failed", {
          issue_id: lifecycle.issueId,
          issue_identifier: lifecycle.issueIdentifier,
          error: errorMessage(error),
        });
      }
    }
  }

  private async reconcileRunningIssues(): Promise<void> {
    const runningIds = [...this.running.keys()];
    if (runningIds.length === 0) return;
    let refreshed: Issue[];
    try {
      refreshed = await this.options.tracker.fetchIssueStatesByIds(runningIds);
    } catch (error) {
      this.options.logger.warn("running issue refresh failed", { error: errorMessage(error) });
      return;
    }

    const byId = new Map(refreshed.map((issue) => [issue.id, issue]));
    for (const [issueId, entry] of this.running) {
      const latest = byId.get(issueId);
      if (!latest) continue;
      entry.issue = latest;
      const preservePendingApprovalWorker =
        entry.role === "worker" && (await this.hasPendingPublicationApprovalHandoff(entry));
      if (isStateIn(latest.state, this.config.tracker.terminalStates)) {
        await this.terminateRunningIssue(issueId, true, "terminal state");
      } else if (preservePendingApprovalWorker) {
        entry.lastMessage = "Awaiting operator approval for push/PR";
      } else if (entry.role === "worker" && isStateIn(latest.state, this.config.tracker.handoffStates)) {
        await this.terminateRunningIssue(issueId, false, "handoff state");
      } else if (entry.role === "worker" && !latest.assignedToWorker) {
        await this.terminateRunningIssue(issueId, false, "assignee route changed");
      } else if (entry.role === "worker" && !isStateIn(latest.state, this.config.tracker.activeStates)) {
        await this.terminateRunningIssue(issueId, false, "non-active state");
      } else if (entry.role === "reviewer" && isStateIn(latest.state, this.config.reviewLoop.blockedStates)) {
        await this.terminateRunningIssue(issueId, false, "blocked state");
      } else if (entry.role === "reviewer" && !isStateIn(latest.state, this.config.reviewLoop.reviewStates)) {
        await this.terminateRunningIssue(issueId, false, "non-review state");
      }
    }
  }

  private async isAwaitingOperatorApproval(entry: RunningEntry): Promise<boolean> {
    const runId = entry.activeRunId ?? entry.runId;
    if (!runId || !this.options.runStore) return false;
    const run = await this.options.runStore.getRun(runId);
    return Boolean(run?.pendingApprovalRequestId);
  }

  private async hasPendingPublicationApprovalHandoff(entry: RunningEntry): Promise<boolean> {
    const store = this.options.lifecycleStore;
    const runId = entry.activeRunId ?? entry.runId;
    if (!store || !runId) return false;
    const lifecycle = await store.get(entry.issue.id);
    const handoff = pendingPublicationHandoffForRun(lifecycle, { runId });
    if (!handoff) return false;
    entry.lifecycle = lifecycle;
    return true;
  }

  private async terminateRunningIssue(issueId: string, cleanupWorkspace: boolean, reason: string): Promise<void> {
    const entry = this.running.get(issueId);
    if (!entry) return;
    entry.suppressRetryOnExit = true;
    this.markCancellationRequested(entry, {
      source: "state_change",
      reason,
      abortSignalled: true,
    });
    entry.abortController.abort();
    if (cleanupWorkspace) {
      entry.cleanupWorkspaceOnExit = true;
    }
    this.options.logger.info("running issue terminated", {
      issue_id: issueId,
      issue_identifier: entry.issue.identifier,
      reason,
      cleanup_workspace: cleanupWorkspace,
    });
  }

  private shouldDispatchWorker(issue: Issue, allowExistingClaim = false): boolean {
    if (this.running.has(issue.id)) return false;
    if (this.pausedIssues.has(issue.id)) return false;
    if (!allowExistingClaim && this.claimed.has(issue.id)) return false;
    if (!issue.assignedToWorker) return false;
    if (isStateIn(issue.state, this.config.tracker.handoffStates)) return false;
    if (isStateIn(issue.state, this.config.reviewLoop.reviewStates)) return false;
    if (isStateIn(issue.state, this.config.reviewLoop.blockedStates)) return false;
    if (!isStateIn(issue.state, this.config.tracker.activeStates)) return false;
    if (isStateIn(issue.state, this.config.tracker.terminalStates)) return false;
    if (!this.passesLabelGuardrails(issue)) return false;
    if (issue.state.toLowerCase() === "todo") {
      if (hasOpenBlocker(issue, this.config.tracker.terminalStates)) return false;
    }
    return this.hasStateSlot(issue.state);
  }

  private shouldDispatchReviewer(issue: Issue, allowExistingClaim = false): boolean {
    if (this.running.has(issue.id)) return false;
    if (this.pausedIssues.has(issue.id)) return false;
    if (!allowExistingClaim && this.claimed.has(issue.id)) return false;
    if (!isStateIn(issue.state, this.config.reviewLoop.reviewStates)) return false;
    if (isStateIn(issue.state, this.config.reviewLoop.blockedStates)) return false;
    if (isStateIn(issue.state, this.config.tracker.terminalStates)) return false;
    if (!this.passesLabelGuardrails(issue)) return false;
    if (hasOpenBlocker(issue, this.config.tracker.terminalStates)) return false;
    return this.hasStateSlot(issue.state);
  }

  private async lifecycleAllowsDispatch(
    issue: Issue,
    role: AgentRunRole,
    runPhase: AgentRunPhase = role === "reviewer" ? "review" : "implementation",
  ): Promise<boolean> {
    const store = this.options.lifecycleStore;
    if (!store) return true;
    const lifecycle = await store.get(issue.id);
    if (!lifecycle) return true;

    const phase = phaseForIssueState(issue.state, this.config);
    const blockedByLifecycle = lifecycle.phase === "blocked" || lifecycle.blockedReason !== null;
    if (blockedByLifecycle) {
      if (isPendingPublicationApprovalReason(lifecycle.blockedReason)) {
        return false;
      }
      if (this.config.reviewLoop.blockedStates.length === 0 || isStateIn(issue.state, this.config.reviewLoop.blockedStates)) {
        return false;
      }
      await store.updateIssue(issue, {
        phase,
        reviewRound: 0,
        incompleteTurnCount: 0,
        blockedReason: null,
      });
      return true;
    }

    if (role === "worker" && runPhase === "issue_breakdown") {
      if (lifecycle.planningFailureCount >= this.config.issueBreakdown.maxPlanningFailures) {
        await this.escalateLifecycleBlocked(
          issue,
          lifecycle,
          lifecycle.summaryPointers.lastRunId ?? issue.id,
          maxPlanningFailuresReason(lifecycle.planningFailureCount, this.config.issueBreakdown.maxPlanningFailures),
        );
        return false;
      }
      if (planningBackoffRemainingMs(lifecycle, this.config) > 0) return false;
    }
    if (
      role === "worker" &&
      runPhase === "implementation" &&
      lifecycle.incompleteTurnCount >= this.config.reviewLoop.maxIncompleteTurns
    ) {
      await this.escalateLifecycleBlocked(
        issue,
        lifecycle,
        lifecycle.summaryPointers.lastRunId ?? issue.id,
        `max incomplete turns reached (${lifecycle.incompleteTurnCount}/${this.config.reviewLoop.maxIncompleteTurns})`,
      );
      return false;
    }
    if (role === "reviewer" && lifecycle.reviewRound >= this.config.reviewLoop.maxReviewRounds) {
      await this.escalateLifecycleBlocked(
        issue,
        lifecycle,
        lifecycle.summaryPointers.lastRunId ?? issue.id,
        `max review rounds reached (${lifecycle.reviewRound}/${this.config.reviewLoop.maxReviewRounds})`,
      );
      return false;
    }

    return true;
  }

  private passesLabelGuardrails(issue: Issue): boolean {
    const labels = new Set(issue.labels.map((label) => label.toLowerCase()));
    if (this.config.agent.requireLabels.some((label) => !labels.has(label))) return false;
    if (this.config.agent.excludeLabels.some((label) => labels.has(label))) return false;
    return true;
  }

  private async tryDispatchWorkerIssue(issue: Issue, attempt: number | null, allowExistingClaim = false): Promise<boolean> {
    if (this.availableSlots() <= 0) return false;
    if (!this.shouldDispatchWorker(issue, allowExistingClaim)) return false;

    let refreshed: Issue[];
    try {
      refreshed = await this.options.tracker.fetchIssueStatesByIds([issue.id]);
    } catch (error) {
      this.options.logger.warn("pre-dispatch issue refresh failed", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        error: errorMessage(error),
      });
      return false;
    }

    const latest = refreshed[0];
    if (!latest) return false;
    if (this.availableSlots() <= 0) return false;
    if (!this.shouldDispatchWorker(latest, allowExistingClaim)) return false;

    const decision = await this.resolveWorkerDispatchDecision(latest);
    if (decision.action === "skip") {
      this.options.logger.warn("worker dispatch skipped", {
        issue_id: latest.id,
        issue_identifier: latest.identifier,
        reason: decision.reason,
      });
      return false;
    }
    let runPhase = decision.runPhase;
    if (!(await this.lifecycleAllowsDispatch(latest, "worker", runPhase))) return false;
    const dispatchWriteback = runPhase === "implementation" ? planDispatchWriteback(latest, this.config) : null;
    if (!(await this.applyWriteback(dispatchWriteback, "dispatch"))) return false;
    const afterWriteback = dispatchWriteback ? (await this.options.tracker.fetchIssueStatesByIds([issue.id]))[0] : latest;
    if (!afterWriteback) return false;
    if (dispatchWriteback) {
      const postWritebackDecision = await this.resolveWorkerDispatchDecision(afterWriteback);
      if (postWritebackDecision.action === "skip") {
        this.options.logger.warn("worker dispatch skipped after writeback", {
          issue_id: afterWriteback.id,
          issue_identifier: afterWriteback.identifier,
          reason: postWritebackDecision.reason,
        });
        return false;
      }
      runPhase = postWritebackDecision.runPhase;
    }
    if (!this.shouldDispatchWorker(afterWriteback, allowExistingClaim)) return false;
    if (!(await this.lifecycleAllowsDispatch(afterWriteback, "worker", runPhase))) return false;

    this.dispatchIssue(afterWriteback, attempt, "worker", null, runPhase);
    return true;
  }

  private async tryDispatchReviewerIssue(issue: Issue, allowExistingClaim = false): Promise<boolean> {
    if (this.availableSlots() <= 0) return false;
    if (!this.shouldDispatchReviewer(issue, allowExistingClaim)) return false;
    if (!(await this.lifecycleAllowsDispatch(issue, "reviewer"))) return false;

    let refreshed: Issue[];
    try {
      refreshed = await this.options.tracker.fetchIssueStatesByIds([issue.id]);
    } catch (error) {
      this.options.logger.warn("pre-review issue refresh failed", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        error: errorMessage(error),
      });
      return false;
    }

    const latest = refreshed[0];
    if (!latest) return false;
    if (this.availableSlots() <= 0) return false;
    if (!this.shouldDispatchReviewer(latest, allowExistingClaim)) return false;
    if (!(await this.lifecycleAllowsDispatch(latest, "reviewer"))) return false;

    const reviewEvidence = await this.loadReviewerDispatchEvidence(latest);
    if (!reviewEvidence) return false;

    this.dispatchIssue(latest, null, "reviewer", reviewEvidence);
    return true;
  }

  private async resolveWorkerDispatchDecision(issue: Issue): Promise<WorkerDispatchDecision> {
    if (!this.config.issueBreakdown.enabled) return { action: "dispatch", runPhase: "implementation" };
    if (!this.passesIssueBreakdownRouting(issue)) return { action: "dispatch", runPhase: "implementation" };
    if (!this.options.lifecycleStore) return { action: "skip", reason: "planning_required_no_lifecycle_store" };
    const lifecycle = await this.options.lifecycleStore.get(issue.id);
    return {
      action: "dispatch",
      runPhase: latestFreshIssueBreakdownPlan(lifecycle, issue, this.config) === null ? "issue_breakdown" : "implementation",
    };
  }

  private passesIssueBreakdownRouting(issue: Issue): boolean {
    if (this.config.issueBreakdown.planningLabels.length === 0) return false;
    const labels = new Set(issue.labels.map((label) => label.toLowerCase()));
    return this.config.issueBreakdown.planningLabels.some((label) => labels.has(label));
  }

  private dispatchIssue(
    issue: Issue,
    attempt: number | null,
    role: AgentRunRole,
    reviewEvidence: ReviewerDispatchEvidence | null,
    runPhase: AgentRunPhase = role === "reviewer" ? "review" : "implementation",
  ): void {
    const abortController = new AbortController();
    const retryAttempt = attempt ?? 0;
    const entry: RunningEntry = {
      issue,
      role,
      runPhase,
      workspacePath: null,
      workspace: null,
      sessionId: null,
      runId: null,
      activeRunId: null,
      lifecycle: null,
      worker: Promise.resolve(),
      abortController,
      startedAt: new Date(),
      lastEventAt: null,
      lastEvent: null,
      lastMessage: null,
      sdkRunStatus: null,
      sdkRunStatusUpdatedAt: null,
      sdkRunStatusSource: null,
      failureKind: null,
      failureDiagnosticCode: null,
      failureDiagnosticMessage: null,
      failureDiagnosticAt: null,
      failureDiagnosticPayload: undefined,
      turnCount: 0,
      retryAttempt,
      tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      activeRunTokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      cleanupWorkspaceOnExit: false,
      suppressRetryOnExit: false,
      completionReportAccepted: false,
      issueBreakdownPlanAccepted: false,
      pullRequestHandoffAccepted: false,
      reviewVerdictAccepted: false,
      reviewEvidence,
      cancellationRequestedAt: null,
      cancellationSource: null,
      cancellationReason: null,
      abortSignalledAt: null,
      harnessStopRequestedAt: null,
      harnessStopFailedAt: null,
      harnessStopFailedReason: null,
      lastStreamActivityAt: null,
      lastDeltaOrToolActivityAt: null,
      lastToolActivityAt: null,
    };
    this.running.set(issue.id, entry);
    this.claimed.add(issue.id);
    this.clearRetry(issue.id);
    const run = role === "reviewer" ? this.runReviewer(entry) : this.runWorker(entry, attempt);
    entry.worker = this.monitorRunExit(entry, run);
  }

  private async monitorRunExit(entry: RunningEntry, run: Promise<void>): Promise<void> {
    const issueId = entry.issue.id;
    try {
      await run;
      await this.onWorkerExit(issueId, "normal", null);
    } catch (error) {
      try {
        await this.onWorkerExit(issueId, "abnormal", errorMessage(error));
      } catch (exitError) {
        this.options.logger.error("run exit handling failed", {
          issue_id: entry.issue.id,
          issue_identifier: entry.issue.identifier,
          role: entry.role,
          run_id: entry.runId,
          active_run_id: entry.activeRunId,
          error: errorMessage(exitError),
          original_error: errorMessage(error),
        });
        this.running.delete(issueId);
        this.claimed.delete(issueId);
      }
    }
  }

  private async runWorker(entry: RunningEntry, attempt: number | null): Promise<void> {
    let workspace: Workspace | null = null;
    try {
      workspace =
        entry.runPhase === "issue_breakdown"
          ? await this.options.workspaceManager.createForPlanning(entry.issue)
          : await this.options.workspaceManager.createForIssue(entry.issue);
      entry.workspacePath = workspace.path;
      entry.workspace = workspace;
      await this.updateLifecycle(
        entry,
        entry.runPhase === "issue_breakdown"
          ? { phase: phaseForIssueState(entry.issue.state, this.config) }
          : {
              phase: phaseForIssueState(entry.issue.state, this.config),
              summaryPointers: {
                workspaceKey: workspace.workspaceKey,
                workspacePath: workspace.path,
                branchName: workspace.gitBranchName ?? null,
                gitBranchName: workspace.gitBranchName ?? null,
                repoPath: workspace.repoPath ?? null,
                baseRef: workspace.baseRef ?? null,
              },
            },
      );
      if (entry.runPhase !== "issue_breakdown") {
        await this.options.workspaceManager.beforeRun(workspace.path);
      }
      await this.options.harness.prepare?.(this.buildRunContext(entry, workspace, attempt, 1));
      await this.options.harness.reload?.(this.buildRunContext(entry, workspace, attempt, 1));

      if (entry.runPhase === "issue_breakdown") {
        entry.turnCount = 1;
        const prompt = await this.renderIssueBreakdownPrompt(entry, attempt);
        const context = this.buildRunContext(entry, workspace, attempt, 1);
        await this.consumeHarnessEvents(entry, this.options.harness.run(context, prompt), {
          workspace,
          prompt,
          attempt,
          turnNumber: 1,
        });
        return;
      }

      for (let turnNumber = 1; turnNumber <= this.config.agent.maxTurns; turnNumber += 1) {
        if (entry.abortController.signal.aborted) throw new SymphonyError("agent_error", "Run was cancelled");
        if (turnNumber > 1 && this.options.harness.supportsContinuation === false) {
          throw new SymphonyError(
            "agent_error",
            `Harness ${this.options.harness.id} does not support continuation turns`,
          );
        }
        entry.turnCount = turnNumber;
        const prompt =
          turnNumber === 1
            ? await this.renderWorkerPrompt(entry, attempt)
            : await this.renderWorkerContinuationPrompt(entry);
        const context = this.buildRunContext(entry, workspace, attempt, turnNumber);
        await this.consumeHarnessEvents(entry, this.options.harness.run(context, prompt), {
          workspace,
          prompt,
          attempt,
          turnNumber,
        });
        if (entry.completionReportAccepted) break;
        if (entry.lifecycle?.phase === "blocked" || entry.lifecycle?.blockedReason !== null) break;

        const refreshed = await this.options.tracker.fetchIssueStatesByIds([entry.issue.id]);
        const latest = refreshed[0];
        if (latest) {
          entry.issue = latest;
          await this.updateLifecycle(entry, { phase: phaseForIssueState(entry.issue.state, this.config) });
        }
        if (
          !entry.issue.assignedToWorker ||
          isStateIn(entry.issue.state, this.config.tracker.handoffStates) ||
          !isStateIn(entry.issue.state, this.config.tracker.activeStates)
        ) {
          break;
        }
      }
    } finally {
      if (workspace) {
        if (entry.runPhase !== "issue_breakdown") {
          await this.options.workspaceManager.afterRun(workspace.path);
        } else {
          await this.options.workspaceManager.removeForPlanning(entry.issue);
        }
        if (entry.cleanupWorkspaceOnExit) await this.options.workspaceManager.removeForIssue(entry.issue);
      }
    }
  }

  private async runReviewer(entry: RunningEntry): Promise<void> {
    let workspace: Workspace | null = null;
    try {
      const evidence = entry.reviewEvidence ?? (await this.loadReviewerDispatchEvidence(entry.issue));
      if (!evidence) {
        this.options.logger.warn("reviewer dispatch skipped because no completion report is available", {
          issue_id: entry.issue.id,
          issue_identifier: entry.issue.identifier,
        });
        return;
      }
      entry.lifecycle = evidence.lifecycle;
      workspace = await this.options.workspaceManager.createForIssue(entry.issue);
      entry.workspacePath = workspace.path;
      entry.workspace = workspace;
      await this.updateLifecycle(entry, {
        phase: "review",
        summaryPointers: {
          workspaceKey: workspace.workspaceKey,
          workspacePath: workspace.path,
          branchName: workspace.gitBranchName ?? entry.issue.branchName ?? evidence.lifecycle.summaryPointers.branchName,
          gitBranchName:
            workspace.gitBranchName ?? entry.issue.branchName ?? evidence.lifecycle.summaryPointers.gitBranchName,
          repoPath: workspace.repoPath ?? evidence.lifecycle.summaryPointers.repoPath,
          baseRef: workspace.baseRef ?? evidence.lifecycle.summaryPointers.baseRef,
        },
      });
      await this.options.workspaceManager.beforeRun(workspace.path);
      await this.options.harness.prepare?.(this.buildRunContext(entry, workspace, null, 1));
      await this.options.harness.reload?.(this.buildRunContext(entry, workspace, null, 1));

      entry.turnCount = 1;
      const prompt = this.formatRenderedReviewerPrompt(
        await this.promptRenderer.render(this.reviewerPromptTemplate(), {
          issue: entry.issue,
          attempt: null,
          role: "reviewer",
          completionReport: evidence.completionReport,
          acceptanceCriteria: acceptanceCriteriaForReport(evidence.completionReport),
          workspaceEvidence: workspaceEvidenceForReview(entry.issue, workspace, evidence),
          validationEvidence: evidence.completionReport.validationEvidence,
          runDigest: evidence.runDigest,
          reviewerPromptExtensions: this.config.reviewLoop.reviewerPromptExtensions,
          workerPromptExtensions: this.config.reviewLoop.workerPromptExtensions,
        }),
      );
      await this.consumeHarnessEvents(entry, this.options.harness.run(this.buildRunContext(entry, workspace, null, 1), prompt), {
        workspace,
        prompt,
        attempt: null,
        turnNumber: 1,
      });
    } finally {
      if (workspace) {
        await this.options.workspaceManager.afterRun(workspace.path);
      }
    }
  }

  private async consumeHarnessEvents(
    entry: RunningEntry,
    events: AsyncIterable<AgentEvent>,
    context: { workspace: Workspace; prompt: string; attempt: number | null; turnNumber: number },
  ): Promise<void> {
    for await (const event of events) {
      const eventAt = new Date(event.at ?? Date.now());
      if (event.type === "run_status") {
        entry.sdkRunStatus = event.sdkStatus;
        entry.sdkRunStatusUpdatedAt = eventAt;
        entry.sdkRunStatusSource = event.source;
        await this.options.runStore?.updateRun(event.runId, {
          metadata: {
            sdkRunStatus: event.sdkStatus,
            sdkRunStatusObservedAt: eventAt.toISOString(),
            sdkRunStatusSource: event.source,
          },
        });
        continue;
      }
      entry.lastEvent = event.type;
      entry.lastEventAt = eventAt;
      if (event.type === "progress") {
        recordActivitySource(entry, event.activitySource ?? "stream", eventAt);
      }
      if (event.type === "session_started") {
        entry.sessionId = event.sessionId;
        entry.runId = event.runId ?? event.sessionId;
        entry.activeRunId = entry.runId;
        entry.activeRunTokens = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        await this.updateLifecycle(entry, { summaryPointers: { lastRunId: entry.runId } });
        await this.options.runStore?.startRun({
          runId: entry.runId,
          sessionId: event.sessionId,
          agentId: event.threadId ?? null,
          role: entry.role,
          runPhase: entry.runPhase,
          runKind: runKindForPhase(entry.runPhase),
          issueId: entry.issue.id,
          issueIdentifier: entry.issue.identifier,
          attempt: context.attempt,
          turnNumber: context.turnNumber,
          prompt: context.prompt,
          cursorModel: this.config.cursor.model,
          cursorModelParams: this.config.cursor.modelParams,
          cursorSettingSources: this.config.cursor.settingSources,
          cursorMode: effectiveCursorModeForEntry(entry, this.config),
          cursorAllowLargeContext: this.config.cursor.allowLargeContext,
          cursorWorkerAgentLifecycle: this.config.cursor.workerAgentLifecycle,
          workspaceKey: context.workspace.workspaceKey,
          workspacePath: context.workspace.path,
          ...(context.workspace.gitBranchName === undefined ? {} : { gitBranchName: context.workspace.gitBranchName }),
          ...(context.workspace.repoPath === undefined ? {} : { repoPath: context.workspace.repoPath }),
          ...(context.workspace.baseRef === undefined ? {} : { baseRef: context.workspace.baseRef }),
        });
        if (entry.runPhase !== "issue_breakdown") {
          await this.discoverPullRequestForEntry(entry, context.workspace);
        }
        if (entry.role === "worker" && entry.runPhase === "implementation") {
          await this.applyWriteback(
            planRunStartedComment(
              {
                issue: entry.issue,
                runId: entry.runId,
                sessionId: entry.sessionId,
                workspacePath: entry.workspacePath,
                workspace: context.workspace,
              },
              this.config,
            ),
            "run start comment",
          );
        }
      }
      if (event.type === "progress" || event.type === "run_diagnostic") entry.lastMessage = event.message;
      if (event.type === "run_diagnostic") {
        entry.failureKind = failureKindForDiagnostic(event.code);
        entry.failureDiagnosticCode = event.code;
        entry.failureDiagnosticMessage = event.message;
        entry.failureDiagnosticAt = eventAt;
        entry.failureDiagnosticPayload = event.payload;
      }
      if (event.type === "tokens") this.applyTokenUpdate(entry, event.tokens);
      if (event.type === "rate_limits") this.rateLimits = event.payload;
      await this.persistHarnessEvent(entry, event);
      if (event.type === "completed") {
        if (entry.runPhase === "issue_breakdown") {
          const accepted = await this.reconcileIssueBreakdownPlanHandoff(entry);
          const terminal = await this.updateRunTerminalStateIfRunning(entry.activeRunId ?? entry.runId ?? "", {
            status: accepted ? "succeeded" : "failed",
            completedAt: new Date().toISOString(),
            ...(accepted ? {} : { error: "Planning run completed without submit_issue_breakdown_plan" }),
            tokens: entry.activeRunTokens,
            metadata: terminalRunMetadata(entry, accepted ? "succeeded" : "failed"),
          });
          if (!terminal.updated) return;
          continue;
        }
        const terminal = await this.updateRunTerminalStateIfRunning(entry.activeRunId ?? entry.runId ?? "", {
          status: "succeeded",
          completedAt: new Date().toISOString(),
          tokens: entry.activeRunTokens,
          metadata: terminalRunMetadata(entry, "succeeded"),
        });
        if (!terminal.updated) return;
        await this.discoverPullRequestForEntry(entry, context.workspace);
        if (entry.role === "worker" && !(await this.reconcileCompletionReportHandoff(entry)) && !entry.pullRequestHandoffAccepted) {
          await this.recordIncompleteTurn(entry);
        }
        if (entry.role === "reviewer") {
          await this.reconcileReviewVerdictHandoff(entry);
        }
      }
      if (event.type === "failed") {
        if (
          entry.role === "worker" &&
          entry.runPhase === "issue_breakdown" &&
          (await this.terminalizeAcceptedIssueBreakdownPlan(entry))
        ) {
          return;
        }
        if (entry.role === "worker" && entry.runPhase === "implementation" && ((await this.reconcileCompletionReportHandoff(entry)) || entry.pullRequestHandoffAccepted)) {
          const terminal = await this.updateRunTerminalStateIfRunning(entry.activeRunId ?? entry.runId ?? "", {
            status: "succeeded",
            completedAt: new Date().toISOString(),
            tokens: entry.activeRunTokens,
            metadata: terminalRunMetadata(entry, "succeeded"),
          });
          if (!terminal.updated) return;
          return;
        }
        const terminal = await this.updateRunTerminalStateIfRunning(entry.activeRunId ?? entry.runId ?? "", {
          status: "failed",
          completedAt: new Date().toISOString(),
          error: event.error,
          tokens: entry.activeRunTokens,
          metadata: terminalRunMetadata(entry, "failed"),
        });
        if (!terminal.updated) return;
        throw new SymphonyError("agent_error", event.error);
      }
      if (event.type === "cancelled") {
        if (
          entry.role === "worker" &&
          entry.runPhase === "issue_breakdown" &&
          (await this.terminalizeAcceptedIssueBreakdownPlan(entry))
        ) {
          return;
        }
        if (entry.role === "worker" && entry.runPhase === "implementation" && ((await this.reconcileCompletionReportHandoff(entry)) || entry.pullRequestHandoffAccepted)) {
          const terminal = await this.updateRunTerminalStateIfRunning(entry.activeRunId ?? entry.runId ?? "", {
            status: "succeeded",
            completedAt: new Date().toISOString(),
            tokens: entry.activeRunTokens,
            metadata: terminalRunMetadata(entry, "succeeded"),
          });
          if (!terminal.updated) return;
          return;
        }
        const terminal = await this.updateRunTerminalStateIfRunning(entry.activeRunId ?? entry.runId ?? "", {
          status: "cancelled",
          completedAt: new Date().toISOString(),
          tokens: entry.activeRunTokens,
          metadata: terminalRunMetadata(entry, "cancelled"),
        });
        if (!terminal.updated) return;
        throw new SymphonyError("agent_error", "Run was cancelled");
      }
    }
  }

  private async updateRunTerminalStateIfRunning(runId: string, patch: TerminalRunPatch): Promise<TerminalUpdateResult> {
    const runStore = this.options.runStore;
    if (!runStore) return { updated: true, record: null };
    const existing = await runStore.getRun(runId);
    if (existing && existing.status !== "running") return { updated: false, record: existing };
    return { updated: true, record: await runStore.updateRun(runId, patch) };
  }

  private async terminalizeAcceptedIssueBreakdownPlan(entry: RunningEntry): Promise<boolean> {
    const accepted = entry.issueBreakdownPlanAccepted || (await this.reconcileIssueBreakdownPlanHandoff(entry));
    if (!accepted) return false;
    const runId = entry.activeRunId ?? entry.runId ?? "";
    if (runId.length > 0) {
      await this.updateRunTerminalStateIfRunning(runId, {
        status: "succeeded",
        completedAt: new Date().toISOString(),
        tokens: entry.activeRunTokens,
        metadata: terminalRunMetadata(entry, "succeeded"),
      });
    }
    return true;
  }

  private async onWorkerExit(issueId: string, kind: "normal" | "abnormal", error: string | null): Promise<void> {
    const entry = this.running.get(issueId);
    if (!entry) return;
    this.running.delete(issueId);
    this.endedRuntimeSeconds += (Date.now() - entry.startedAt.getTime()) / 1000;

    if (entry.runPhase === "issue_breakdown") {
      const accepted = entry.issueBreakdownPlanAccepted || (await this.reconcileIssueBreakdownPlanHandoff(entry));
      if (accepted) {
        await this.terminalizeAcceptedIssueBreakdownPlan(entry);
        await this.options.lifecycleStore?.updateIssue(entry.issue, {
          planningFailureCount: 0,
          planningDispatchRetryCount: 0,
          lastPlanningFailureRunId: null,
          lastPlanningFailureAt: null,
        });
        this.clearRetry(issueId);
        this.completed.add(issueId);
        this.claimed.delete(issueId);
        return;
      }
      if (entry.suppressRetryOnExit) {
        this.claimed.delete(issueId);
        return;
      }
      await this.recordPlanningFailure(
        entry,
        error ?? (kind === "normal" ? "Planning run completed without submit_issue_breakdown_plan" : "Planning run failed"),
      );
      return;
    }

    if (entry.role === "worker" && ((await this.reconcileCompletionReportHandoff(entry)) || entry.pullRequestHandoffAccepted)) {
      if (entry.runId) {
        const terminal = await this.updateRunTerminalStateIfRunning(entry.runId, {
          status: "succeeded",
          completedAt: new Date().toISOString(),
          tokens: entry.activeRunTokens,
          metadata: terminalRunMetadata(entry, "succeeded"),
        });
        if (!terminal.updated) {
          this.claimed.delete(issueId);
          return;
        }
      }
      this.completed.add(issueId);
      this.claimed.delete(issueId);
      return;
    }

    if (kind === "normal") {
      if (entry.runId) {
        const terminal = await this.updateRunTerminalStateIfRunning(entry.runId, {
          status: "succeeded",
          completedAt: new Date().toISOString(),
          tokens: entry.activeRunTokens,
          metadata: terminalRunMetadata(entry, "succeeded"),
        });
        if (!terminal.updated) {
          this.claimed.delete(issueId);
          return;
        }
      }
      this.completed.add(issueId);
      if (entry.role === "reviewer") {
        await this.reconcileReviewVerdictHandoff(entry);
        this.claimed.delete(issueId);
        return;
      }
      if (entry.lifecycle?.phase === "blocked" || entry.lifecycle?.blockedReason !== null) {
        this.claimed.delete(issueId);
        return;
      }
      if (this.config.writeback.enabled) {
        await this.applyWritebacks(
          planRunSucceededWritebacks(
            {
              issue: entry.issue,
              runId: entry.runId ?? issueId,
              sessionId: entry.sessionId,
              workspacePath: entry.workspacePath,
              workspace: entry.workspace,
            },
            this.config,
          ),
          "turn completed",
        );
        this.claimed.delete(issueId);
        return;
      }
      if (await this.shouldScheduleContinuation(entry)) {
        this.scheduleRetry(issueId, entry.issue.identifier, 1, 1_000, null, entry.runPhase);
      } else {
        this.claimed.delete(issueId);
      }
    } else if (entry.role === "reviewer") {
      if (entry.runId) {
        const terminal = await this.updateRunTerminalStateIfRunning(entry.runId, {
          status: entry.suppressRetryOnExit ? "cancelled" : "failed",
          completedAt: new Date().toISOString(),
          error,
          tokens: entry.activeRunTokens,
          metadata: terminalRunMetadata(entry, entry.suppressRetryOnExit ? "cancelled" : "failed"),
        });
        if (!terminal.updated) {
          this.claimed.delete(issueId);
          return;
        }
      }
      this.claimed.delete(issueId);
    } else if (entry.suppressRetryOnExit) {
      if (entry.runId) {
        const terminal = await this.updateRunTerminalStateIfRunning(entry.runId, {
          status: "cancelled",
          completedAt: new Date().toISOString(),
          error,
          tokens: entry.activeRunTokens,
          metadata: terminalRunMetadata(entry, "cancelled"),
        });
        if (!terminal.updated) {
          this.claimed.delete(issueId);
          if (terminal.record?.status === "failed" && terminal.record.error === OPERATOR_REJECTED_PUBLICATION_ERROR) return;
        }
      }
      await this.applyWriteback(
        planRunCancelledComment(
          {
            issue: entry.issue,
            runId: entry.runId ?? issueId,
            sessionId: entry.sessionId,
            workspacePath: entry.workspacePath,
            workspace: entry.workspace,
          },
          this.config,
          error,
        ),
        "run cancelled",
      );
      this.claimed.delete(issueId);
    } else {
      if (entry.runId) {
        const terminal = await this.updateRunTerminalStateIfRunning(entry.runId, {
          status: "failed",
          completedAt: new Date().toISOString(),
          error,
          tokens: entry.activeRunTokens,
          metadata: terminalRunMetadata(entry, "failed"),
        });
        if (error === OPERATOR_REJECTED_PUBLICATION_ERROR) {
          this.claimed.delete(issueId);
          return;
        }
        if (!terminal.updated) {
          this.claimed.delete(issueId);
          if (terminal.record?.status === "failed" && terminal.record.error === OPERATOR_REJECTED_PUBLICATION_ERROR) return;
        }
      }
      await this.applyWriteback(
        planRunFailedComment(
          {
            issue: entry.issue,
            runId: entry.runId ?? issueId,
            sessionId: entry.sessionId,
            workspacePath: entry.workspacePath,
            workspace: entry.workspace,
          },
          this.config,
          error,
        ),
        "run failed",
      );
      const sdkErrorFailures = await this.consecutiveSdkErrorFailures(entry.issue);
      if (sdkErrorFailures >= 1 + this.config.agent.maxSdkErrorRetries) {
        await this.escalateEntryBlocked(
          entry,
          `consecutive Cursor SDK wait errors reached limit (${sdkErrorFailures} failures; max_sdk_error_retries=${this.config.agent.maxSdkErrorRetries})`,
        );
        this.claimed.delete(issueId);
        return;
      }
      const nextAttempt = Math.max(entry.retryAttempt + 1, 1);
      const delayMs = Math.min(10_000 * 2 ** (nextAttempt - 1), this.config.agent.maxRetryBackoffMs);
      this.scheduleRetry(issueId, entry.issue.identifier, nextAttempt, delayMs, error, entry.runPhase);
    }
  }

  private async recordPlanningFailure(entry: RunningEntry, error: string | null): Promise<void> {
    const issueId = entry.issue.id;
    const store = this.options.lifecycleStore;
    if (!store) {
      this.claimed.delete(issueId);
      return;
    }

    const now = new Date().toISOString();
    const runId = entry.activeRunId ?? entry.runId ?? issueId;
    const current = (await store.get(issueId)) ?? entry.lifecycle;
    const nextCount = (current?.planningFailureCount ?? 0) + 1;
    const lifecycle = await store.updateIssue(entry.issue, {
      planningFailureCount: nextCount,
      planningDispatchRetryCount: 0,
      lastPlanningFailureRunId: runId,
      lastPlanningFailureAt: now,
    });
    entry.lifecycle = lifecycle;
    await this.options.runStore?.appendEvent({
      runId,
      at: now,
      source: "orchestrator",
      eventType: "planning_run_failed",
      message: error ?? "Planning run failed",
      payload: { planningFailureCount: nextCount },
    });

    const maxFailures = this.config.issueBreakdown.maxPlanningFailures;
    if (nextCount >= maxFailures) {
      await this.escalateLifecycleBlocked(entry.issue, lifecycle, runId, maxPlanningFailuresReason(nextCount, maxFailures));
      this.clearRetry(issueId);
      this.claimed.delete(issueId);
      return;
    }

    const delayMs = planningRetryDelayMs(nextCount, this.config);
    this.scheduleRetry(issueId, entry.issue.identifier, nextCount, delayMs, error, "issue_breakdown");
  }

  private async consecutiveSdkErrorFailures(issue: Issue): Promise<number> {
    const runs = (await this.options.runStore?.listRunsForIssue(issue.id)) ?? [];
    const seen = new Set<string>();
    const workerRuns = runs
      .filter((run) => run.role === "worker" && !seen.has(run.runId) && seen.add(run.runId))
      .sort(compareRunChronology);
    let count = 0;
    for (const run of workerRuns.slice().reverse()) {
      if (!isCountedSdkWaitErrorFailure(run)) break;
      count += 1;
    }
    return count;
  }

  private async applyWritebacks(
    operations: Array<Parameters<WritebackProcessor["enqueueAndProcess"]>[0]>,
    reason: string,
  ): Promise<boolean> {
    let ok = true;
    for (const operation of operations) {
      ok = (await this.applyWriteback(operation, reason)) && ok;
    }
    return ok;
  }

  private async applyWriteback(
    operation: Parameters<WritebackProcessor["enqueueAndProcess"]>[0] | null,
    reason: string,
  ): Promise<boolean> {
    if (!operation) return true;
    if (!this.options.writeback) {
      this.options.logger.warn("writeback operation skipped because no processor is configured", {
        issue_id: operation.issueId,
        kind: operation.kind,
        reason,
      });
      return !this.config.writeback.enabled;
    }
    const result = await this.options.writeback.enqueueAndProcess(operation);
    return result.status === "succeeded";
  }

  private async shouldScheduleContinuation(entry: RunningEntry): Promise<boolean> {
    let refreshed: Issue[];
    try {
      refreshed = await this.options.tracker.fetchIssueStatesByIds([entry.issue.id]);
    } catch (error) {
      this.options.logger.warn("post-run issue refresh failed", {
        issue_id: entry.issue.id,
        issue_identifier: entry.issue.identifier,
        error: errorMessage(error),
      });
      return true;
    }
    const latest = refreshed[0];
    if (!latest) return false;
    entry.issue = latest;
    return this.shouldDispatchWorker(latest, true);
  }

  private scheduleRetry(
    issueId: string,
    identifier: string,
    attempt: number,
    delayMs: number,
    error: string | null,
    runPhase: AgentRunPhase = "implementation",
  ): void {
    this.clearRetry(issueId);
    const dueAtMs = Date.now() + delayMs;
    const timer = setTimeout(() => {
      void this.onRetryTimer(issueId);
    }, delayMs);
    this.retryAttempts.set(issueId, { issueId, identifier, attempt, dueAtMs, timer, error, runPhase });
  }

  private async onRetryTimer(issueId: string): Promise<void> {
    const retry = this.retryAttempts.get(issueId);
    if (!retry) return;
    this.retryAttempts.delete(issueId);
    try {
      const candidates = await this.options.tracker.fetchCandidateIssues();
      const issue = candidates.find((candidate) => candidate.id === issueId);
      if (!issue) {
        this.claimed.delete(issueId);
        return;
      }
      if (retry.runPhase === "issue_breakdown") {
        const remainingMs = await this.planningBackoffRemainingForIssue(issue);
        if (remainingMs > 0) {
          this.scheduleRetry(issueId, retry.identifier, retry.attempt, remainingMs, retry.error, retry.runPhase);
          return;
        }
      }
      if (this.availableSlots() <= 0) {
        if (retry.runPhase === "issue_breakdown") {
          await this.recordPlanningDispatchRetry(issue, retry, "no available orchestrator slots");
        } else {
          this.scheduleRetry(issueId, retry.identifier, retry.attempt + 1, 1_000, "no available orchestrator slots", retry.runPhase);
        }
        return;
      }
      const dispatched = await this.tryDispatchWorkerIssue(issue, retry.attempt, true);
      if (!dispatched) {
        if (retry.runPhase === "issue_breakdown") {
          await this.recordPlanningDispatchRetry(issue, retry, retry.error ?? "planning dispatch retry failed");
        } else {
          this.claimed.delete(issueId);
        }
      }
    } catch (error) {
      if (retry.runPhase === "issue_breakdown" && retry.attempt >= this.config.issueBreakdown.maxPlanningDispatchRetries) {
        this.claimed.delete(issueId);
        return;
      }
      this.scheduleRetry(issueId, retry.identifier, retry.attempt + 1, 1_000, errorMessage(error), retry.runPhase);
    }
  }

  private async planningBackoffRemainingForIssue(issue: Issue): Promise<number> {
    const lifecycle = await this.options.lifecycleStore?.get(issue.id);
    if (!lifecycle) return 0;
    return planningBackoffRemainingMs(lifecycle, this.config);
  }

  private async recordPlanningDispatchRetry(issue: Issue, retry: RetryEntry, error: string | null): Promise<void> {
    const store = this.options.lifecycleStore;
    if (!store) {
      this.claimed.delete(issue.id);
      return;
    }
    const current = await store.get(issue.id);
    if (current) {
      const remainingMs = planningBackoffRemainingMs(current, this.config);
      if (remainingMs > 0) {
        this.scheduleRetry(issue.id, retry.identifier, retry.attempt, remainingMs, retry.error, retry.runPhase);
        return;
      }
    }
    const nextCount = (current?.planningDispatchRetryCount ?? 0) + 1;
    const lifecycle = await store.updateIssue(issue, { planningDispatchRetryCount: nextCount });
    const maxRetries = this.config.issueBreakdown.maxPlanningDispatchRetries;
    if (nextCount >= maxRetries) {
      await this.escalateLifecycleBlocked(
        issue,
        lifecycle,
        lifecycle.summaryPointers.lastRunId ?? retry.identifier,
        maxPlanningDispatchRetriesReason(nextCount, maxRetries),
      );
      this.clearRetry(issue.id);
      this.claimed.delete(issue.id);
      return;
    }
    const delayMs = planningRetryDelayMs(Math.max(lifecycle.planningFailureCount, 1), this.config);
    this.scheduleRetry(issue.id, retry.identifier, retry.attempt + 1, delayMs, error, retry.runPhase);
  }

  private clearRetry(issueId: string): void {
    const existing = this.retryAttempts.get(issueId);
    if (!existing) return;
    clearTimeout(existing.timer);
    this.retryAttempts.delete(issueId);
  }

  private buildRunContext(
    entry: RunningEntry,
    workspace: Workspace,
    attempt: number | null,
    turnNumber: number,
  ) {
    return {
      issue: entry.issue,
      role: entry.role,
      runPhase: entry.runPhase,
      attempt,
      workspace,
      config: this.config,
      turnNumber,
      ...(entry.runPhase === "issue_breakdown" ? { cursorModeOverride: this.config.issueBreakdown.cursorMode } : {}),
      abortSignal: entry.abortController.signal,
      logger: this.options.logger,
    };
  }

  private applyTokenUpdate(entry: RunningEntry, tokens: Partial<TokenCounts>): void {
    const next = {
      inputTokens: tokens.inputTokens ?? entry.activeRunTokens.inputTokens,
      outputTokens: tokens.outputTokens ?? entry.activeRunTokens.outputTokens,
      totalTokens: tokens.totalTokens ?? entry.activeRunTokens.totalTokens,
    };
    const delta = {
      inputTokens: Math.max(next.inputTokens - entry.activeRunTokens.inputTokens, 0),
      outputTokens: Math.max(next.outputTokens - entry.activeRunTokens.outputTokens, 0),
      totalTokens: Math.max(next.totalTokens - entry.activeRunTokens.totalTokens, 0),
    };
    this.totals.inputTokens += delta.inputTokens;
    this.totals.outputTokens += delta.outputTokens;
    this.totals.totalTokens += delta.totalTokens;
    entry.tokens = {
      inputTokens: entry.tokens.inputTokens + delta.inputTokens,
      outputTokens: entry.tokens.outputTokens + delta.outputTokens,
      totalTokens: entry.tokens.totalTokens + delta.totalTokens,
    };
    entry.activeRunTokens = next;
  }

  private async persistHarnessEvent(entry: RunningEntry, event: AgentEvent): Promise<void> {
    const runId = entry.activeRunId ?? entry.runId;
    if (!runId) return;
    const message =
      event.type === "progress" || event.type === "completed" || event.type === "run_diagnostic" ? event.message : undefined;
    await this.options.runStore?.appendEvent({
      runId,
      at: new Date(event.at ?? Date.now()).toISOString(),
      source: "harness",
      eventType: event.type,
      ...(message === undefined ? {} : { message }),
      payload: event,
    });
    if (event.type === "tokens") {
      await this.options.runStore?.updateRun(runId, { tokens: entry.activeRunTokens });
    }
  }

  private async recordIncompleteTurn(entry: RunningEntry): Promise<void> {
    const store = this.options.lifecycleStore;
    if (!store) return;
    if (await this.hasPendingPublicationApprovalHandoff(entry)) return;
    const refreshed = await this.refreshEntryIssue(entry, "incomplete turn refresh");
    if (!refreshed || !this.isImplementationActive(entry.issue)) {
      await this.updateLifecycle(entry, { phase: phaseForIssueState(entry.issue.state, this.config) });
      return;
    }

    const incompleteTurnCount = (entry.lifecycle?.incompleteTurnCount ?? 0) + 1;
    await this.updateLifecycle(entry, {
      phase: "implementation",
      incompleteTurnCount,
    });
    if (incompleteTurnCount >= this.config.reviewLoop.maxIncompleteTurns && entry.lifecycle) {
      await this.escalateEntryBlocked(
        entry,
        `max incomplete turns reached (${incompleteTurnCount}/${this.config.reviewLoop.maxIncompleteTurns})`,
      );
    }
  }

  private async refreshEntryIssue(entry: RunningEntry, reason: string): Promise<boolean> {
    try {
      const refreshed = await this.options.tracker.fetchIssueStatesByIds([entry.issue.id]);
      const latest = refreshed[0];
      if (!latest) return false;
      entry.issue = latest;
      return true;
    } catch (error) {
      this.options.logger.warn(reason, {
        issue_id: entry.issue.id,
        issue_identifier: entry.issue.identifier,
        error: errorMessage(error),
      });
      return true;
    }
  }

  private isImplementationActive(issue: Issue): boolean {
    return (
      issue.assignedToWorker &&
      isStateIn(issue.state, this.config.tracker.activeStates) &&
      !isStateIn(issue.state, this.config.tracker.handoffStates) &&
      !isStateIn(issue.state, this.config.reviewLoop.reviewStates) &&
      !isStateIn(issue.state, this.config.reviewLoop.blockedStates) &&
      !isStateIn(issue.state, this.config.tracker.terminalStates)
    );
  }

  private async escalateEntryBlocked(entry: RunningEntry, reason: string): Promise<void> {
    const lifecycle = entry.lifecycle ?? (await this.options.lifecycleStore?.get(entry.issue.id));
    if (!lifecycle) return;
    entry.lifecycle = await this.escalateLifecycleBlocked(
      entry.issue,
      lifecycle,
      entry.activeRunId ?? entry.runId ?? entry.issue.id,
      reason,
    );
  }

  private async escalateLifecycleBlocked(
    issue: Issue,
    lifecycle: IssueLifecycleRecord,
    runId: string,
    reason: string,
  ): Promise<IssueLifecycleRecord> {
    const store = this.options.lifecycleStore;
    const blockedLifecycle = store
      ? await store.updateIssue(issue, {
          phase: "blocked",
          blockedReason: reason,
        })
      : lifecycle;
    await this.applyWritebacks(
      planBlockedEscalationWritebacks(
        {
          issue,
          runId,
          reason,
          incompleteTurnCount: blockedLifecycle.incompleteTurnCount,
          maxIncompleteTurns: this.config.reviewLoop.maxIncompleteTurns,
          reviewRound: blockedLifecycle.reviewRound,
          maxReviewRounds: this.config.reviewLoop.maxReviewRounds,
          lastCompletionReport: latestCompletionReport(blockedLifecycle),
          lastReviewVerdict: latestReviewVerdict(blockedLifecycle),
          requiredAction:
            "Inspect the latest run output and reviewer feedback, then move the issue out of the blocked state when Symphony should try again.",
        },
        this.config,
      ),
      "blocked escalation",
    );
    return blockedLifecycle;
  }

  private async reconcileCompletionReportHandoff(entry: RunningEntry): Promise<boolean> {
    const store = this.options.lifecycleStore;
    const runId = entry.activeRunId ?? entry.runId;
    if (!store || !runId) return entry.completionReportAccepted;

    const lifecycle = await store.get(entry.issue.id);
    const report = lifecycle?.completionReports.find((item) => item.runId === runId) ?? null;
    if (!lifecycle || !report) return entry.completionReportAccepted;
    if (!isFinalizedCompletionReport(report)) {
      if (!pendingPublicationHandoffForRun(lifecycle, { runId })) return false;
      entry.lifecycle = lifecycle;
      entry.completionReportAccepted = true;
      return true;
    }

    entry.lifecycle = lifecycle;
    entry.completionReportAccepted = true;

    if (this.options.writeback) {
      await this.options.writeback.processDue();
    } else if (this.config.writeback.enabled) {
      this.options.logger.warn("completion report accepted but writeback processor is not configured", {
        issue_id: entry.issue.id,
        issue_identifier: entry.issue.identifier,
        run_id: runId,
        report_id: report.id,
      });
    }

    return true;
  }

  private async reconcileIssueBreakdownPlanHandoff(entry: RunningEntry): Promise<boolean> {
    const store = this.options.lifecycleStore;
    const runId = entry.activeRunId ?? entry.runId;
    if (!store || !runId) return entry.issueBreakdownPlanAccepted;
    const lifecycle = await store.get(entry.issue.id);
    const plan = lifecycle?.issueBreakdownPlans.find((item) => item.runId === runId) ?? null;
    if (!lifecycle || !plan) return entry.issueBreakdownPlanAccepted;
    entry.lifecycle = lifecycle;
    entry.issueBreakdownPlanAccepted = true;
    return true;
  }

  private async reconcileReviewVerdictHandoff(entry: RunningEntry): Promise<boolean> {
    const store = this.options.lifecycleStore;
    const runId = entry.activeRunId ?? entry.runId;
    if (!store || !runId) return entry.reviewVerdictAccepted;

    const lifecycle = await store.get(entry.issue.id);
    const verdict = lifecycle?.reviewVerdicts.find((item) => item.runId === runId) ?? null;
    if (!lifecycle || !verdict) return entry.reviewVerdictAccepted;

    entry.lifecycle = lifecycle;
    entry.reviewVerdictAccepted = true;

    if (this.options.writeback) {
      await this.options.writeback.processDue();
    } else if (this.config.writeback.enabled) {
      this.options.logger.warn("review verdict accepted but writeback processor is not configured", {
        issue_id: entry.issue.id,
        issue_identifier: entry.issue.identifier,
        run_id: runId,
        verdict_id: verdict.id,
        verdict: verdict.verdict,
      });
    }

    if (verdict.verdict === "pass") await this.tryReconcileMergePolicy(entry.issue);
    return true;
  }

  private async reconcileMergePolicyIssues(): Promise<void> {
    if (this.config.mergePolicy.mode !== "gated" || this.config.mergePolicy.sourceStates.length === 0) return;
    let candidates: Issue[];
    try {
      candidates = await this.options.tracker.fetchIssuesByStates(this.config.mergePolicy.sourceStates);
    } catch (error) {
      this.options.logger.warn("merge policy issue fetch failed", { error: errorMessage(error) });
      return;
    }
    for (const issue of sortIssuesForDispatch(candidates)) {
      if (this.running.has(issue.id) || this.pausedIssues.has(issue.id)) continue;
      if (!this.passesLabelGuardrails(issue)) continue;
      await this.tryReconcileMergePolicy(issue);
    }
  }

  private async tryReconcileMergePolicy(issue: Issue): Promise<void> {
    if (this.config.mergePolicy.mode !== "gated" || !this.options.lifecycleStore) return;
    try {
      const service = new MergePolicyService({
        config: this.config,
        tracker: this.options.tracker,
        lifecycleStore: this.options.lifecycleStore,
        ...(this.options.runStore === undefined ? {} : { runStore: this.options.runStore }),
        ...(this.options.writeback === undefined ? {} : { writeback: this.options.writeback }),
        ...(this.options.pullRequestMergeClient === undefined ? {} : { client: this.options.pullRequestMergeClient }),
        logger: this.options.logger,
      });
      const result = await service.reconcileIssue(issue);
      if (result.status !== "skipped") {
        this.options.logger.info("merge policy reconciled issue", {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          status: result.status,
          merge_id: result.merge.id,
        });
      }
    } catch (error) {
      this.options.logger.warn("merge policy reconciliation failed", {
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        error: errorMessage(error),
      });
    }
  }

  private async updateLifecycle(entry: RunningEntry, patch: IssueLifecyclePatch): Promise<void> {
    const store = this.options.lifecycleStore;
    if (!store) return;
    entry.lifecycle = await store.updateIssue(entry.issue, patch);
    await appendLaneMemoTelemetry(this.options.runStore, entry.activeRunId, entry.lifecycle, "orchestrator_update");
  }

  private async discoverPullRequestForEntry(entry: RunningEntry, workspace: Workspace): Promise<void> {
    const branchName = workspace.gitBranchName ?? entry.issue.branchName;
    if (!branchName) return;

    let pullRequest: DiscoveredPullRequest | null;
    try {
      const client =
        this.options.pullRequestClient ??
        createGitHubPullRequestClientForCapability(this.config, "github.discovery");
      pullRequest = await client.findOpenPullRequestByBranch({ branchName });
    } catch (error) {
      this.options.logger.warn("pull request discovery failed", {
        issue_id: entry.issue.id,
        issue_identifier: entry.issue.identifier,
        branch_name: branchName,
        error: errorMessage(error),
      });
      return;
    }
    if (!pullRequest) return;

    const metadata = {
      prUrl: pullRequest.url,
      prNumber: pullRequest.number,
      prHeadSha: pullRequest.headSha,
      prBranch: pullRequest.headBranch,
      lastPushedAt: pullRequest.lastPushedAt,
      gitBranchName: branchName,
      repoPath: workspace.repoPath ?? null,
      baseRef: workspace.baseRef ?? null,
    };
    await this.updateLifecycle(entry, {
      summaryPointers: {
        prUrl: metadata.prUrl,
        prNumber: metadata.prNumber,
        prHeadSha: metadata.prHeadSha,
        prBranch: metadata.prBranch,
        lastPushedAt: metadata.lastPushedAt,
        gitBranchName: metadata.gitBranchName,
        branchName: metadata.gitBranchName,
        repoPath: metadata.repoPath,
        baseRef: metadata.baseRef,
      },
    });

    const runId = entry.activeRunId ?? entry.runId;
    if (!runId || !this.options.runStore) return;
    const existing = await this.options.runStore.getRun(runId);
    if (
      existing?.prUrl === metadata.prUrl &&
      existing.prNumber === metadata.prNumber &&
      existing.prHeadSha === metadata.prHeadSha &&
      existing.prBranch === metadata.prBranch &&
      (existing.lastPushedAt ?? null) === metadata.lastPushedAt
    ) {
      return;
    }
    await this.options.runStore.recordPullRequestEvent({
      runId,
      action: existing?.prUrl ? "updated" : "opened",
      prUrl: metadata.prUrl,
      prNumber: metadata.prNumber,
      prHeadSha: metadata.prHeadSha,
      prBranch: metadata.prBranch,
      lastPushedAt: metadata.lastPushedAt,
      gitBranchName: metadata.gitBranchName,
      repoPath: metadata.repoPath,
      baseRef: metadata.baseRef,
    });
  }

  private async loadReviewerDispatchEvidence(issue: Issue): Promise<ReviewerDispatchEvidence | null> {
    const lifecycle = await this.options.lifecycleStore?.get(issue.id);
    const completionReport = lifecycle ? latestCompletionReport(lifecycle) : null;
    if (!lifecycle || !completionReport) return null;
    const workerRun = (await this.options.runStore?.getRun(completionReport.runId)) ?? null;
    const transcript = this.options.runStore
      ? await this.options.runStore.readTranscript(completionReport.runId, { limit: 50 })
      : null;
    return {
      lifecycle,
      completionReport,
      workerRun,
      runDigest: digestTranscript(workerRun, transcript?.events ?? []),
    };
  }

  private reviewerPromptTemplate(): string {
    const configured = this.config.reviewLoop.reviewerPromptTemplate;
    if (configured !== null && configured.trim().length > 0) return configured;
    return DEFAULT_REVIEWER_PROMPT_TEMPLATE;
  }

  private formatRenderedReviewerPrompt(prompt: string): string {
    const configured = this.config.reviewLoop.reviewerPromptTemplate;
    if (configured !== null && configured.trim().length > 0) return prompt;
    return prompt
      .replace(
        PROJECT_REVIEWER_PROMPT_EXTENSIONS_MARKER,
        formatPromptExtensions("Project-specific reviewer extensions:", this.config.reviewLoop.reviewerPromptExtensions) ??
          "",
      )
      .trim();
  }

  private async renderWorkerPrompt(entry: RunningEntry, attempt: number | null): Promise<string> {
    const basePrompt = await this.promptRenderer.render(this.promptTemplate, {
      issue: entry.issue,
      attempt,
      reviewerPromptExtensions: this.config.reviewLoop.reviewerPromptExtensions,
      workerPromptExtensions: this.config.reviewLoop.workerPromptExtensions,
    });
    const issueBreakdownPlan = await this.loadIssueBreakdownPlanPrompt(entry);
    const reviewHardening = this.workerReviewHardeningPrompt();
    const reviewEvidence = await this.loadWorkerReviewEvidencePrompt(entry);
    const handoff = await this.loadWorkerHandoffPrompt(entry);
    const reviewVerdict = await this.loadWorkerReviewVerdictPrompt(entry);
    return [basePrompt, issueBreakdownPlan, reviewHardening, handoff, this.cursorWorkerMcpPrompt(entry), reviewVerdict, reviewEvidence]
      .filter((item): item is string => item !== null)
      .join("\n");
  }

  private async renderIssueBreakdownPrompt(entry: RunningEntry, attempt: number | null): Promise<string> {
    const basePrompt = await this.promptRenderer.render(this.config.issueBreakdown.promptTemplate, { issue: entry.issue, attempt });
    return [basePrompt, this.cursorIssueBreakdownMcpPrompt(entry)].join("\n");
  }

  private cursorIssueBreakdownMcpPrompt(entry: RunningEntry): string {
    return [
      "",
      "Symphony MCP issue-breakdown handoff:",
      `- Active issue: ${entry.issue.identifier} (${entry.issue.id})`,
      "- Active role: worker",
      "- Active phase: issue_breakdown",
      "- Before ending the run, call the submit_issue_breakdown_plan MCP tool with summary, proposedIssues, and idempotencyKey.",
      "- Each proposed issue must include title, description, acceptanceCriteria, dependencies, and labels.",
      "- Do not call submit_completion_report, comment on Linear, transition Linear state, or create child issues.",
      "- Symphony persists the plan locally and injects it into the later implementation prompt after validation.",
    ].join("\n");
  }

  private async renderWorkerContinuationPrompt(entry: RunningEntry): Promise<string> {
    const continuationBrief = await this.renderContinuationBrief(entry);
    const reviewHardening = this.workerReviewHardeningPrompt();
    const reviewEvidence = await this.loadWorkerReviewEvidencePrompt(entry);
    const handoff = await this.loadWorkerHandoffPrompt(entry);
    const reviewVerdict = await this.loadWorkerReviewVerdictPrompt(entry);
    return [
      continuationBrief,
      reviewHardening,
      handoff,
      reviewVerdict,
      reviewEvidence,
      this.cursorWorkerMcpPrompt(entry),
    ]
      .filter((item): item is string => item !== null)
      .join("\n");
  }

  private workerReviewHardeningPrompt(): string {
    return [
      "",
      DEFAULT_WORKER_INVARIANT_REPAIR_GUIDANCE,
      formatPromptExtensions("Project-specific worker extensions:", this.config.reviewLoop.workerPromptExtensions),
    ]
      .filter((item): item is string => item !== null)
      .join("\n");
  }

  private async renderContinuationBrief(entry: RunningEntry): Promise<string> {
    const lifecycle = entry.lifecycle ?? (await this.options.lifecycleStore?.get(entry.issue.id)) ?? null;
    const runs = (await this.options.runStore?.listRunsForIssue(entry.issue.id)) ?? [];
    const history = await this.loadContinuationHistory(runs);
    const threshold = this.config.reviewLoop.transcriptHistoryLimit;
    const historyMode = "summary";
    const summaryReference = latestContinuationSummaryReference(lifecycle);
    const workspace = entry.workspace;
    const pointers = lifecycle?.summaryPointers;
    const latestRun = runs[runs.length - 1] ?? null;
    const transcriptPointers = transcriptPointersForRuns(runs);
    const statusApiPointers = statusApiPointersForIssue(entry.issue.identifier, runs);

    return [
      "Structured continuation brief:",
      "",
      "Objective:",
      `- Continue implementation for ${entry.issue.identifier}: ${entry.issue.title}`,
      "- Reuse the history below before rediscovering prior context.",
      "",
      "Lifecycle counters:",
      `- Phase: ${lifecycle?.phase ?? phaseForIssueState(entry.issue.state, this.config)}`,
      `- Review rounds: ${lifecycle?.reviewRound ?? 0} / ${this.config.reviewLoop.maxReviewRounds}`,
      `- Incomplete worker turns: ${lifecycle?.incompleteTurnCount ?? 0} / ${this.config.reviewLoop.maxIncompleteTurns}`,
      `- Last completion report: ${lifecycle?.lastCompletionReportId ?? "n/a"}`,
      `- Last review verdict: ${lifecycle?.lastReviewVerdictId ?? "n/a"}`,
      "",
      "Latest workspace/git evidence:",
      `- Workspace path: ${workspace?.path ?? pointers?.workspacePath ?? latestRun?.workspacePath ?? entry.workspacePath ?? "n/a"}`,
      `- Workspace key: ${workspace?.workspaceKey ?? pointers?.workspaceKey ?? latestRun?.workspaceKey ?? "n/a"}`,
      `- Branch: ${workspace?.gitBranchName ?? pointers?.gitBranchName ?? pointers?.branchName ?? latestRun?.gitBranchName ?? entry.issue.branchName ?? "n/a"}`,
      `- Repository path: ${workspace?.repoPath ?? pointers?.repoPath ?? latestRun?.repoPath ?? "n/a"}`,
      `- Base ref: ${workspace?.baseRef ?? pointers?.baseRef ?? latestRun?.baseRef ?? "n/a"}`,
      `- Pull request: ${formatPullRequest(pointers?.prNumber ?? latestRun?.prNumber ?? null, pointers?.prUrl ?? latestRun?.prUrl ?? null)}`,
      `- PR head SHA: ${pointers?.prHeadSha ?? latestRun?.prHeadSha ?? "n/a"}`,
      `- Last pushed at: ${pointers?.lastPushedAt ?? latestRun?.lastPushedAt ?? "n/a"}`,
      `- CI status: ${pointers?.ciStatus ?? latestRun?.ciStatus ?? "n/a"}`,
      "",
      "History selection:",
      `- Mode: ${historyMode}`,
      `- Transcript events considered: ${history.eventCount}`,
      `- Configured full-history threshold: ${threshold}`,
      "",
      "Stored continuation summary:",
      `- Reference: ${summaryReference?.id ?? "n/a"}`,
      `- Created at: ${summaryReference?.createdAt ?? "n/a"}`,
      `- Summary: ${summaryReference?.summary ?? "No stored continuation history summary is available yet."}`,
      "",
      "Transcript/status pointers:",
      ...formatPointerList(summaryReference?.transcriptPointers ?? transcriptPointers),
      ...formatPointerList(summaryReference?.statusApiPointers ?? statusApiPointers),
    ].join("\n");
  }

  private async loadContinuationHistory(runs: RunRecord[]): Promise<{
    eventCount: number;
    runs: Array<{ run: RunRecord; events: TranscriptEvent[]; truncated: boolean }>;
  }> {
    const threshold = this.config.reviewLoop.transcriptHistoryLimit;
    let eventCount = 0;
    const history: Array<{ run: RunRecord; events: TranscriptEvent[]; truncated: boolean }> = [];
    for (const run of runs) {
      if (!this.options.runStore) break;
      const page = await this.options.runStore.readTranscript(run.runId, { limit: threshold + 1 });
      const truncated = page.nextOffset !== null;
      const events = promptRelevantTranscriptEvents(page.events);
      eventCount += events.length + (truncated ? 1 : 0);
      history.push({ run, events, truncated });
    }
    return { eventCount, runs: history };
  }

  private cursorWorkerMcpPrompt(entry: RunningEntry): string | null {
    if (this.options.harness.id !== "cursor") return null;
    if (entry.runPhase !== "implementation") return null;
    const workspace = entry.workspace;
    return [
      "",
      "Symphony MCP completion handoff:",
      `- Active issue: ${entry.issue.identifier} (${entry.issue.id})`,
      `- Active role: ${entry.role}`,
      `- Workspace path: ${workspace?.path ?? entry.workspacePath ?? "n/a"}`,
      `- Branch: ${workspace?.gitBranchName ?? entry.issue.branchName ?? "n/a"}`,
      `- Repository path: ${workspace?.repoPath ?? "n/a"}`,
      `- Base ref: ${workspace?.baseRef ?? "n/a"}`,
      "- Before ending the run, call the submit_completion_report MCP tool with summary, validationEvidence, acceptanceChecklist, changedFiles, branchName, pullRequest, risks, and idempotencyKey.",
      "- The MCP server is scoped to this issue and the current Cursor run; Symphony injects runId and issueId for you.",
      "- Do not comment on Linear, transition Linear state, or request broad Linear write credentials. Symphony handles writeback after the tool accepts the report.",
    ].join("\n");
  }

  private async loadWorkerReviewVerdictPrompt(entry: RunningEntry): Promise<string | null> {
    const lifecycle = await this.options.lifecycleStore?.get(entry.issue.id);
    return lifecycle === undefined || lifecycle === null ? null : formatWorkerReviewVerdictPrompt(lifecycle);
  }

  private async loadIssueBreakdownPlanPrompt(entry: RunningEntry): Promise<string | null> {
    if (!this.config.issueBreakdown.enabled) return null;
    const lifecycle = await this.options.lifecycleStore?.get(entry.issue.id);
    const plan = latestFreshIssueBreakdownPlan(lifecycle, entry.issue, this.config);
    if (plan === null) return null;
    return [
      "",
      "Issue breakdown plan:",
      `- Source: ${plan.id}; accepted at ${plan.acceptedAt}`,
      `- Cursor mode: ${plan.cursorMode ?? this.config.issueBreakdown.cursorMode}`,
      `- Transcript pointers: ${formatList(plan.transcriptPointers)}`,
      `- Status pointers: ${formatList(plan.statusApiPointers)}`,
      "",
      renderIssueBreakdownPlanSummary(plan),
    ].join("\n");
  }

  private async loadWorkerHandoffPrompt(entry: RunningEntry): Promise<string | null> {
    const lifecycle = (await this.options.lifecycleStore?.get(entry.issue.id)) ?? entry.lifecycle ?? null;
    const runs = (await this.options.runStore?.listRunsForIssue(entry.issue.id)) ?? [];
    if (!lifecycle || !hasRealHandoffContext(lifecycle, runs)) return null;
    const packet = buildWorkerHandoffPacket(lifecycle);
    const transcriptPointers = transcriptPointersForRuns(runs);
    const statusPointers = statusApiPointersForIssue(entry.issue.identifier, runs);
    const activeReviewEvidence = lifecycle.reviewEvidence.items.filter(isActiveReviewEvidenceItem);
    return [
      "",
      "Compact Symphony handoff packet:",
      `- Version: ${packet.version}; generatedAt: ${packet.generatedAt}`,
      `- Issue: ${packet.issueIdentifier} (${packet.issueId})`,
      `- Objective: ${entry.issue.title}`,
      `- Next action: ${nextWorkerAction(lifecycle)}`,
      "",
      "Lane memo:",
      ...packet.memo.entries.map((entryLine) => `- ${entryLine}`),
      "",
      "Open reviewer findings:",
      ...(packet.memo.openFindings.length === 0 ? ["- None"] : packet.memo.openFindings.map((finding) => `- ${finding}`)),
      "",
      "Latest worker output:",
      ...(packet.lastWorkerOutput === null
        ? ["- None"]
        : [
            `- Report: ${packet.lastWorkerOutput.reportId}; run: ${packet.lastWorkerOutput.runId}`,
            `- Summary: ${packet.lastWorkerOutput.summary}`,
            `- Changed files: ${formatList(packet.lastWorkerOutput.changedFiles)}`,
            `- Validation: ${formatList(packet.lastWorkerOutput.validationEvidence)}`,
            `- Risks: ${formatList(packet.lastWorkerOutput.risks)}`,
          ]),
      "",
      "Latest reviewer output:",
      ...(packet.lastReviewerOutput === null
        ? ["- None"]
        : [
            `- Verdict: ${packet.lastReviewerOutput.verdict}; record: ${packet.lastReviewerOutput.verdictId}; run: ${packet.lastReviewerOutput.runId}`,
            `- Findings: ${formatList(packet.lastReviewerOutput.findings)}`,
            `- Evidence: ${formatList(packet.lastReviewerOutput.evidence)}`,
          ]),
      "",
      "Stable pointers:",
      `- Workspace: ${packet.pointers.workspacePath ?? "n/a"}`,
      `- Branch: ${packet.pointers.gitBranchName ?? packet.pointers.branchName ?? "n/a"}`,
      `- Pull request: ${formatPullRequest(packet.pointers.prNumber, packet.pointers.prUrl)}`,
      `- PR head SHA: ${packet.pointers.prHeadSha ?? "n/a"}`,
      "",
      "Active unresolved PR review evidence:",
      ...(activeReviewEvidence.length === 0
        ? ["- None"]
        : activeReviewEvidence
            .slice(0, this.config.reviewLoop.prReviewEvidenceLimit)
            .map((item) => `- ${item.source} ${item.path ?? "PR"}: ${oneLine(item.body).slice(0, 240)} (${item.url ?? item.pullRequestUrl ?? "n/a"})`)),
      "",
      "Transcript/status pointers:",
      ...formatPointerList(transcriptPointers),
      ...formatPointerList(statusPointers),
    ].join("\n");
  }

  private async loadWorkerReviewEvidencePrompt(entry: RunningEntry): Promise<string | null> {
    if (!this.options.lifecycleStore) return null;
    try {
      const client =
        this.options.pullRequestReviewClient ??
        createGitHubPullRequestClientForCapability(this.config, "github.review_evidence_read");
      const service = new PullRequestReviewEvidenceService({
        lifecycleStore: this.options.lifecycleStore,
        client,
        fullHistoryThreshold: this.config.reviewLoop.prReviewEvidenceLimit,
      });
      const context = await service.prepareWorkerPromptContext(entry.issue);
      return context === null ? null : formatWorkerReviewEvidencePrompt(context);
    } catch (error) {
      this.options.logger.warn("pull request review evidence ingestion failed", {
        issue_id: entry.issue.id,
        issue_identifier: entry.issue.identifier,
        error: errorMessage(error),
      });
      return null;
    }
  }

  private availableSlots(): number {
    return Math.max(this.config.agent.maxConcurrentAgents - this.running.size, 0);
  }

  private hasStateSlot(state: string): boolean {
    const stateLimit = this.config.agent.maxConcurrentAgentsByState.get(state.toLowerCase());
    if (!stateLimit) return true;
    const runningInState = [...this.running.values()].filter(
      (entry) => entry.issue.state.toLowerCase() === state.toLowerCase(),
    ).length;
    return runningInState < stateLimit;
  }

  private activeRuntimeSeconds(now: number): number {
    return [...this.running.values()].reduce((sum, entry) => sum + (now - entry.startedAt.getTime()) / 1000, 0);
  }

  private markCancellationRequested(
    entry: RunningEntry,
    input: {
      source: RunCancellationSource;
      reason: string;
      abortSignalled?: boolean;
      harnessStopRequested?: boolean;
    },
    now = new Date(),
  ): void {
    if (!entry.cancellationRequestedAt) {
      entry.cancellationRequestedAt = now;
      entry.cancellationSource = input.source;
      entry.cancellationReason = input.reason;
    }
    if (input.abortSignalled) {
      entry.abortSignalledAt = entry.abortSignalledAt ?? now;
    }
    if (input.harnessStopRequested) {
      entry.harnessStopRequestedAt = now;
    }
  }

  private livenessForEntry(entry: RunningEntry, now: number): RunLivenessState {
    const idleAlertThresholdMs = this.stallTimeoutMs();
    const lastActivityAt = entry.lastEventAt ?? entry.startedAt;
    const idleMs = Math.max(now - lastActivityAt.getTime(), 0);
    const idleAlertSuppressed = entry.cancellationRequestedAt !== null || isLifecycleHumanBlocked(entry.lifecycle);
    const status: RunLivenessStatus =
      entry.cancellationRequestedAt !== null
        ? "cancelling"
        : entry.runId === null
          ? "starting"
          : entry.sdkRunStatus !== null && isTerminalSdkRunStatus(entry.sdkRunStatus)
            ? "terminal_pending"
            : "active";
    return {
      status,
      activeRunId: entry.activeRunId,
      lastActivityAt: lastActivityAt.toISOString(),
      secondsSinceLastActivity: idleMs / 1000,
      stallTimeoutMs: idleAlertThresholdMs,
      sdkRunStatus: entry.sdkRunStatus,
      sdkRunStatusUpdatedAt: entry.sdkRunStatusUpdatedAt?.toISOString() ?? null,
      sdkRunStatusSource: entry.sdkRunStatusSource,
      idleAlert: {
        active: !idleAlertSuppressed && idleAlertThresholdMs !== null && idleMs > idleAlertThresholdMs,
        thresholdMs: idleAlertThresholdMs,
        lastActivityAt: lastActivityAt.toISOString(),
        secondsSinceLastActivity: idleMs / 1000,
        reason: idleAlertSuppressed ? "suppressed" : "observe_only",
      },
    };
  }

  private stallTimeoutMs(): number | null {
    const codexConfig = this.config.raw as { codex?: { stall_timeout_ms?: unknown } };
    const stallTimeout = codexConfig.codex?.stall_timeout_ms ?? 300_000;
    return typeof stallTimeout === "number" && stallTimeout > 0 ? stallTimeout : null;
  }

  private harnessStopRunId(entry: RunningEntry): string | null {
    if (typeof this.options.harness.stop !== "function") return null;
    return entry.activeRunId ?? entry.runId;
  }

  private async requestHarnessStop(entry: RunningEntry, runId: string): Promise<void> {
    try {
      await this.options.harness.stop?.(runId);
    } catch (error) {
      const at = new Date();
      entry.harnessStopFailedAt = entry.harnessStopFailedAt ?? at;
      entry.harnessStopFailedReason = entry.harnessStopFailedReason ?? errorMessage(error);
      this.options.logger.warn("harness stop failed", {
        issue_id: entry.issue.id,
        issue_identifier: entry.issue.identifier,
        run_id: runId,
        source: entry.cancellationSource,
        error: errorMessage(error),
      });
    }
  }
}

export function sortIssuesForDispatch(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => {
    const priorityA = a.priority ?? Number.POSITIVE_INFINITY;
    const priorityB = b.priority ?? Number.POSITIVE_INFINITY;
    if (priorityA !== priorityB) return priorityA - priorityB;
    const createdA = a.createdAt ? Date.parse(a.createdAt) : Number.POSITIVE_INFINITY;
    const createdB = b.createdAt ? Date.parse(b.createdAt) : Number.POSITIVE_INFINITY;
    if (createdA !== createdB) return createdA - createdB;
    return a.identifier.localeCompare(b.identifier);
  });
}

function isStateIn(state: string, states: string[]): boolean {
  return states.some((candidate) => candidate.toLowerCase() === state.toLowerCase());
}

function isTerminalSdkRunStatus(status: AgentRunSdkStatus): boolean {
  return status === "finished" || status === "error" || status === "cancelled";
}

function isLifecycleHumanBlocked(lifecycle: IssueLifecycleRecord | null): boolean {
  return lifecycle !== null && (lifecycle.phase === "blocked" || lifecycle.blockedReason !== null);
}

function hasOpenBlocker(issue: Issue, terminalStates: string[]): boolean {
  return issue.blockedBy.some((blocker) => blocker.state === null || !isStateIn(blocker.state, terminalStates));
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

function acceptanceCriteriaForReport(report: IssueCompletionReportRecord): string[] {
  return report.acceptanceChecklist.map((item) => {
    const status = item.satisfied ? "satisfied" : "not satisfied";
    return `${item.text} (${status}${item.evidence === null ? "" : `; evidence: ${item.evidence}`})`;
  });
}

function workspaceEvidenceForReview(
  issue: Issue,
  workspace: Workspace,
  evidence: ReviewerDispatchEvidence,
): string[] {
  const pointers = evidence.lifecycle.summaryPointers;
  const report = evidence.completionReport;
  const workerRun = evidence.workerRun;
  return [
    `Workspace path: ${workspace.path}`,
    `Workspace key: ${workspace.workspaceKey}`,
    `Workspace branch: ${workspace.gitBranchName ?? issue.branchName ?? pointers.gitBranchName ?? pointers.branchName ?? "n/a"}`,
    `Repository path: ${workspace.repoPath ?? pointers.repoPath ?? workerRun?.repoPath ?? "n/a"}`,
    `Base ref: ${workspace.baseRef ?? pointers.baseRef ?? workerRun?.baseRef ?? "n/a"}`,
    `Completion report branch: ${report.branchName ?? "n/a"}`,
    `Pull request: ${report.pullRequest?.url ?? pointers.prUrl ?? workerRun?.prUrl ?? "n/a"}`,
    `Pull request number: ${report.pullRequest?.number ?? pointers.prNumber ?? workerRun?.prNumber ?? "n/a"}`,
    `Pull request head SHA: ${report.pullRequest?.headSha ?? pointers.prHeadSha ?? workerRun?.prHeadSha ?? "n/a"}`,
    `Last pushed at: ${pointers.lastPushedAt ?? workerRun?.lastPushedAt ?? "n/a"}`,
    `Changed files: ${report.changedFiles.length === 0 ? "n/a" : report.changedFiles.join(", ")}`,
  ];
}

function digestTranscript(workerRun: RunRecord | null, events: TranscriptEvent[]): string[] {
  const summary = workerRun
    ? [
        `Worker run ${workerRun.runId} status ${workerRun.status}`,
        `Worker agent ${workerRun.agentId ?? "n/a"} session ${workerRun.sessionId ?? "n/a"}`,
        `Worker prompt characters: ${workerRun.promptCharCount ?? "n/a"}`,
      ]
    : ["Worker run metadata is unavailable."];
  const eventDigest = events
    .filter((event) => isPromptRelevantTranscriptEvent(event) && event.message !== undefined && event.message.trim().length > 0)
    .slice(-12)
    .map((event) => `#${event.sequence} ${event.eventType}: ${oneLine(event.message ?? "").slice(0, 240)}`);
  return eventDigest.length === 0 ? summary : [...summary, ...eventDigest];
}

function latestContinuationSummaryReference(
  lifecycle: IssueLifecycleRecord | null,
): IssueLifecycleSummaryReference | null {
  const summaries =
    lifecycle?.summaryReferences.filter((summary) => summary.kind === "continuation_history") ?? [];
  return (
    [...summaries].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))[
      summaries.length - 1
    ] ?? null
  );
}

function effectiveCursorModeForEntry(entry: RunningEntry, config: ServiceConfig): "agent" | "plan" | null {
  return entry.runPhase === "issue_breakdown" ? config.issueBreakdown.cursorMode : config.cursor.mode;
}

function maxPlanningFailuresReason(count: number, max: number): string {
  return `max planning failures reached (${count}/${max})`;
}

function maxPlanningDispatchRetriesReason(count: number, max: number): string {
  return `max planning dispatch retries reached (${count}/${max})`;
}

function planningRetryDelayMs(failureCount: number, config: ServiceConfig): number {
  return Math.min(
    config.issueBreakdown.planningRetryBaseMs * 2 ** Math.max(failureCount - 1, 0),
    config.issueBreakdown.planningRetryMaxMs,
  );
}

function planningBackoffRemainingMs(lifecycle: IssueLifecycleRecord, config: ServiceConfig, nowMs = Date.now()): number {
  if (lifecycle.planningFailureCount <= 0 || lifecycle.lastPlanningFailureAt === null) return 0;
  const failedAtMs = Date.parse(lifecycle.lastPlanningFailureAt);
  if (!Number.isFinite(failedAtMs)) return 0;
  const dueAtMs = failedAtMs + planningRetryDelayMs(lifecycle.planningFailureCount, config);
  return Math.max(0, dueAtMs - nowMs);
}

function hasRealHandoffContext(lifecycle: IssueLifecycleRecord, runs: RunRecord[]): boolean {
  return (
    lifecycle.handoff.lastWorkerOutput !== null ||
    lifecycle.handoff.lastReviewerOutput !== null ||
    runs.length > 0 ||
    lifecycle.reviewRound > 0 ||
    lifecycle.incompleteTurnCount > 0 ||
    lifecycle.summaryReferences.length > 0 ||
    lifecycle.reviewEvidence.items.some(isActiveReviewEvidenceItem) ||
    lifecycle.merge !== null ||
    lifecycle.phase !== "implementation"
  );
}

function nextWorkerAction(lifecycle: IssueLifecycleRecord): string {
  if (lifecycle.handoff.lastReviewerOutput?.verdict === "fail") return "Address the latest reviewer findings, validate, and submit a new completion report.";
  if (lifecycle.incompleteTurnCount > 0) return "Continue the incomplete implementation using the memo and pointers before rediscovering context.";
  if (lifecycle.reviewEvidence.items.some(isActiveReviewEvidenceItem)) {
    return "Address active unresolved PR review evidence before submitting another completion report.";
  }
  return "Continue implementation using the compact memo and stable pointers.";
}

async function listRunsForLifecycle(
  runStore: RunTranscriptStore,
  lifecycle: IssueLifecycleRecord,
): Promise<RunRecord[]> {
  const byId = new Map<string, RunRecord>();
  for (const key of new Set([lifecycle.issueId, lifecycle.issueIdentifier])) {
    for (const run of await runStore.listRunsForIssue(key)) {
      byId.set(run.runId, run);
    }
  }
  return [...byId.values()].sort(compareRunChronology);
}

async function readContinuationTranscriptEvents(
  runStore: RunTranscriptStore,
  runs: RunRecord[],
): Promise<TranscriptEvent[]> {
  const events: TranscriptEvent[] = [];
  for (const run of runs) {
    let offset = 0;
    do {
      const page = await runStore.readTranscript(run.runId, { offset, limit: 1_000 });
      events.push(...page.events);
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    } while (true);
  }
  return events;
}

function upsertSummaryReference(
  existing: IssueLifecycleSummaryReference[],
  summaryReference: IssueLifecycleSummaryReference,
): IssueLifecycleSummaryReference[] {
  return [
    ...existing.filter((item) => item.id !== summaryReference.id),
    summaryReference,
  ];
}

function transcriptPointersForRuns(runs: RunRecord[]): string[] {
  return runs.slice(-5).map((run) => `/api/v1/runs/${encodeURIComponent(run.runId)}/transcript`);
}

function statusApiPointersForIssue(issueIdentifier: string, runs: RunRecord[]): string[] {
  return [
    `/api/v1/issues/${encodeURIComponent(issueIdentifier)}`,
    `/api/v1/issues/${encodeURIComponent(issueIdentifier)}/runs`,
    ...runs.slice(-5).map((run) => `/api/v1/runs/${encodeURIComponent(run.runId)}`),
  ];
}

function promptRelevantTranscriptEvents(events: TranscriptEvent[]): TranscriptEvent[] {
  return events.filter(isPromptRelevantTranscriptEvent);
}

function isPromptRelevantTranscriptEvent(event: TranscriptEvent): boolean {
  return event.eventType !== "lane_memo_updated" && event.eventType !== "transcript_recall";
}

function formatPointerList(pointers: string[]): string[] {
  return pointers.length === 0 ? ["- n/a"] : pointers.map((pointer) => `- ${pointer}`);
}

function formatList(values: string[]): string {
  return values.length === 0 ? "n/a" : values.join("; ");
}

function formatPullRequest(number: number | null, url: string | null): string {
  const parts = [number === null ? null : `#${number}`, url].filter((value): value is string => value !== null);
  return parts.length === 0 ? "n/a" : parts.join(" ");
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function metadataForRunningEntry(entry: RunningEntry): IssueRunMetadata {
  const pointers = entry.lifecycle?.summaryPointers;
  return {
    prUrl: pointers?.prUrl ?? null,
    prNumber: pointers?.prNumber ?? null,
    prHeadSha: pointers?.prHeadSha ?? null,
    prBranch: pointers?.prBranch ?? null,
    ciStatus: pointers?.ciStatus ?? null,
    lastPushedAt: pointers?.lastPushedAt ?? null,
    lastEvidenceCursor: pointers?.lastEvidenceCursor ?? null,
    branchName: pointers?.branchName ?? entry.workspace?.gitBranchName ?? entry.issue.branchName ?? null,
    gitBranchName: pointers?.gitBranchName ?? entry.workspace?.gitBranchName ?? entry.issue.branchName ?? null,
    repoPath: pointers?.repoPath ?? entry.workspace?.repoPath ?? null,
    baseRef: pointers?.baseRef ?? entry.workspace?.baseRef ?? null,
  };
}

function recordActivitySource(entry: RunningEntry, source: AgentActivitySource, at: Date): void {
  if (source === "stream") {
    entry.lastStreamActivityAt = at;
  }
  if (source === "delta" || source === "tool") {
    entry.lastDeltaOrToolActivityAt = at;
  }
  if (source === "tool") {
    entry.lastToolActivityAt = at;
  }
}

function activityForEntry(entry: RunningEntry): RunActivityState {
  return {
    lastHarnessActivityAt: (entry.lastEventAt ?? entry.startedAt).toISOString(),
    lastStreamActivityAt: entry.lastStreamActivityAt?.toISOString() ?? null,
    lastDeltaOrToolActivityAt: entry.lastDeltaOrToolActivityAt?.toISOString() ?? null,
    lastToolActivityAt: entry.lastToolActivityAt?.toISOString() ?? null,
    unavailable: [],
  };
}

function terminalActivitySnapshot(entry: RunningEntry): RunActivitySnapshot {
  const activity = activityForEntry(entry);
  return {
    lastHarnessActivityAt: activity.lastHarnessActivityAt,
    lastStreamActivityAt: activity.lastStreamActivityAt,
    lastDeltaOrToolActivityAt: activity.lastDeltaOrToolActivityAt,
    lastToolActivityAt: activity.lastToolActivityAt,
  };
}

function terminalRunMetadata(entry: RunningEntry, terminalStatus: "succeeded" | "failed" | "cancelled"): RunMetadata {
  const cancellationRequested = entry.cancellationRequestedAt !== null;
  const cancelIgnored = cancellationRequested && terminalStatus === "succeeded";
  const harnessStopFailed = cancellationRequested && terminalStatus === "failed" && entry.harnessStopFailedAt !== null;
  const cancelFailed = cancelIgnored || harnessStopFailed;
  const cancelFailedSource = cancelIgnored ? "cancel_ignored" : harnessStopFailed ? "harness_stop" : null;
  const cancelFailedAt = cancelIgnored
    ? (entry.lastEventAt ?? new Date()).toISOString()
    : harnessStopFailed
      ? entry.harnessStopFailedAt?.toISOString() ?? null
      : null;
  const cancelFailedReason = cancelIgnored
    ? "run completed after cancellation was requested"
    : harnessStopFailed
      ? entry.harnessStopFailedReason
      : null;
  return {
    cancellationRequestedAt: entry.cancellationRequestedAt?.toISOString() ?? null,
    cancellationSource: entry.cancellationSource,
    cancellationReason: entry.cancellationReason,
    harnessStopRequestedAt: entry.harnessStopRequestedAt?.toISOString() ?? null,
    harnessStopFailedAt: entry.harnessStopFailedAt?.toISOString() ?? null,
    harnessStopFailedReason: entry.harnessStopFailedReason,
    cancellationOutcome: !cancellationRequested
      ? "none"
      : cancelIgnored
        ? "cancel_ignored"
        : harnessStopFailed
          ? "harness_stop_failed"
          : terminalStatus === "cancelled"
            ? "cancelled"
            : "requested",
    cancelFailed,
    cancelFailedAt,
    cancelFailedReason,
    cancelFailedSource,
    activitySnapshot: terminalActivitySnapshot(entry),
    sdkRunStatus: entry.sdkRunStatus,
    sdkRunStatusObservedAt: entry.sdkRunStatusUpdatedAt?.toISOString() ?? null,
    sdkRunStatusSource: entry.sdkRunStatusSource,
    failureKind: terminalStatus === "failed" ? entry.failureKind : null,
    failureDiagnosticCode: terminalStatus === "failed" ? entry.failureDiagnosticCode : null,
    failureDiagnosticMessage: terminalStatus === "failed" ? entry.failureDiagnosticMessage : null,
    failureDiagnosticAt: terminalStatus === "failed" ? entry.failureDiagnosticAt?.toISOString() ?? null : null,
    failureDiagnosticPayload: terminalStatus === "failed" ? entry.failureDiagnosticPayload : null,
  };
}

function failureKindForDiagnostic(code: string): string {
  if (code === "cursor_run_wait_terminal_error") return "cursor_sdk_terminal_error";
  if (code === "cursor_run_wait_threw") return "cursor_sdk_wait_error";
  if (code === "cursor_stream_error" || code.startsWith("cursor_stream_status_")) return "cursor_stream_error";
  return "harness_diagnostic";
}

function isCountedSdkWaitErrorFailure(run: RunRecord): boolean {
  return (
    run.role === "worker" &&
    run.status === "failed" &&
    run.completedAt !== null &&
    run.sdkRunStatus === "error" &&
    run.sdkRunStatusSource === "wait" &&
    run.cancellationRequestedAt == null &&
    (run.cancellationOutcome ?? "none") === "none" &&
    run.cancelFailed !== true &&
    run.error !== OPERATOR_REJECTED_PUBLICATION_ERROR
  );
}

function issueFromApprovalRequest(request: OperatorApprovalRecord): Issue {
  const title = request.action.title.startsWith(`${request.issueIdentifier}: `)
    ? request.action.title.slice(request.issueIdentifier.length + 2)
    : request.action.title;
  return {
    id: request.issueId,
    identifier: request.issueIdentifier,
    title,
    description: null,
    priority: null,
    state: "Blocked",
    branchName: request.action.branchName,
    url: null,
    assigneeId: null,
    assignedToWorker: false,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
  };
}

function hasRecoverablePendingPublicationApproval(lifecycle: IssueLifecycleRecord): boolean {
  return pendingPublicationHandoffForRun(lifecycle) !== null;
}

function issueFromPendingPublicationLifecycle(lifecycle: IssueLifecycleRecord, state: string): Issue {
  const report =
    (lifecycle.lastCompletionReportId === null
      ? undefined
      : lifecycle.completionReports.find((item) => item.id === lifecycle.lastCompletionReportId)) ??
    lifecycle.completionReports.at(-1);
  return {
    id: lifecycle.issueId,
    identifier: lifecycle.issueIdentifier,
    title: lifecycle.issueIdentifier,
    description: null,
    priority: null,
    state,
    branchName: report?.branchName ?? lifecycle.summaryPointers.gitBranchName ?? lifecycle.summaryPointers.branchName,
    url: null,
    assigneeId: null,
    assignedToWorker: false,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
  };
}

function cancellationForEntry(entry: RunningEntry): RunCancellationState {
  return {
    requested: entry.cancellationRequestedAt !== null,
    requestedAt: entry.cancellationRequestedAt?.toISOString() ?? null,
    source: entry.cancellationSource,
    reason: entry.cancellationReason,
    abortSignalled: entry.abortSignalledAt !== null || entry.abortController.signal.aborted,
    harnessStopRequestedAt: entry.harnessStopRequestedAt?.toISOString() ?? null,
    harnessStopFailedAt: entry.harnessStopFailedAt?.toISOString() ?? null,
    harnessStopFailedReason: entry.harnessStopFailedReason,
    cancelFailed: liveCancelFailedForEntry(entry),
    suppressRetryOnExit: entry.suppressRetryOnExit,
  };
}

function liveCancelFailedForEntry(entry: RunningEntry): CancelFailedState {
  if (entry.harnessStopFailedAt) {
    return {
      tracked: true,
      active: true,
      phase: "failed",
      at: entry.harnessStopFailedAt.toISOString(),
      reason: entry.harnessStopFailedReason,
      source: "harness_stop",
    };
  }
  return {
    tracked: true,
    active: false,
    phase: entry.cancellationRequestedAt ? "requested" : "none",
    at: null,
    reason: null,
    source: null,
  };
}

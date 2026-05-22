import { setTimeout as delay } from "node:timers/promises";
import type { ServiceConfig } from "../config/Config.js";
import { SymphonyError, errorMessage } from "../errors.js";
import type { AgentEvent, AgentHarness } from "../harness/AgentHarness.js";
import type { Logger } from "../logging/StructuredLogger.js";
import type { TrackerClient } from "../tracker/TrackerClient.js";
import type { AgentRunRole, Issue, RuntimeTotals, TokenCounts, Workspace } from "../types.js";
import type { WorkspaceManager } from "../workspace/WorkspaceManager.js";
import { PromptRenderer } from "../workflow/PromptRenderer.js";
import type { RunRecord, RunTranscriptStore, TranscriptEvent } from "../persistence/RunTranscriptStore.js";
import {
  phaseForIssueState,
  type IssueCompletionReportRecord,
  type IssueLifecyclePatch,
  type IssueLifecycleRecord,
  type IssueLifecycleSummaryReference,
  type IssueLifecycleStore,
  type IssueReviewVerdictRecord,
} from "../persistence/IssueLifecycleStore.js";
import {
  formatWorkerReviewEvidencePrompt,
  PullRequestReviewEvidenceService,
  type PullRequestReviewEvidenceClient,
} from "../review/PullRequestReviewEvidenceService.js";
import { formatWorkerReviewVerdictPrompt } from "../ReviewVerdictService.js";
import {
  PlaceholderContinuationSummarizer,
  type ContinuationSummarizer,
} from "../summarization/ContinuationSummarizer.js";
import type { WritebackProcessor } from "../writeback/WritebackOutbox.js";
import {
  planBlockedEscalationWritebacks,
  planDispatchWriteback,
  planRunCancelledComment,
  planRunFailedComment,
  planRunStartedComment,
  planRunSucceededWritebacks,
} from "../writeback/TransitionPolicy.js";

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
}

export interface ContinuationSummaryCreationResult {
  summaryReference: IssueLifecycleSummaryReference;
  lifecycle: IssueLifecycleRecord;
}

export interface RunningEntry {
  issue: Issue;
  role: AgentRunRole;
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
  turnCount: number;
  retryAttempt: number;
  tokens: TokenCounts;
  cleanupWorkspaceOnExit: boolean;
  suppressRetryOnExit: boolean;
  completionReportAccepted: boolean;
  reviewVerdictAccepted: boolean;
  reviewEvidence: ReviewerDispatchEvidence | null;
}

interface ReviewerDispatchEvidence {
  lifecycle: IssueLifecycleRecord;
  completionReport: IssueCompletionReportRecord;
  workerRun: RunRecord | null;
  runDigest: string[];
}

export interface RetryEntry {
  issueId: string;
  identifier: string;
  attempt: number;
  dueAtMs: number;
  timer: NodeJS.Timeout;
  error: string | null;
}

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
    state: string;
    workspacePath: string | null;
    sessionId: string | null;
    runId: string | null;
    turnCount: number;
    lastEvent: string | null;
    lastMessage: string | null;
    startedAt: string;
    lastEventAt: string | null;
    tokens: TokenCounts;
    lifecycle: IssueLifecycleRecord | null;
    metadata: IssueRunMetadata;
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

const DEFAULT_REVIEWER_PROMPT_TEMPLATE = `
You are a Symphony reviewer agent for {{ issue.identifier }}.

Inspect only. Do not modify files, create commits, push branches, comment on Linear, transition Linear state, or otherwise change workspace or lifecycle state directly.

Use the linked GitHub pull request as the primary detailed review surface. Before calling submit_review_verdict, leave concrete feedback directly on the PR by submitting a GitHub PR review and/or posting PR review comments. Requested changes must point to the relevant files, lines, or threads on GitHub; a pass verdict should also leave a concise approving or summary review/comment on the PR. In submit_review_verdict, reference the PR review/comment URLs you used as evidence.

Call the submit_review_verdict MCP tool before ending the run. Use verdict "fail" for requested changes and "pass" only when all acceptance criteria are satisfied. The MCP server supplies the active run and issue context; include runId or issueId only if the tool asks for them.

Tool payload guidance:
- acceptanceResults: one entry per acceptance criterion with satisfied true/false and concrete evidence.
- findings: required for fail verdicts, empty for pass verdicts.
- evidence: PR review/comment URLs or other durable review evidence.
- idempotencyKey: a stable unique key for this reviewer verdict.

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
      running.abortController.abort();
      await this.options.harness.stop?.(running.runId ?? issueId);
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
    running.abortController.abort();
    await this.options.harness.stop?.(running.runId ?? issueId);
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
        state: entry.issue.state,
        workspacePath: entry.workspacePath,
        sessionId: entry.sessionId,
        runId: entry.runId,
        turnCount: entry.turnCount,
        lastEvent: entry.lastEvent,
        lastMessage: entry.lastMessage,
        startedAt: entry.startedAt.toISOString(),
        lastEventAt: entry.lastEventAt?.toISOString() ?? null,
        tokens: entry.tokens,
        lifecycle: entry.lifecycle,
        metadata: metadataForRunningEntry(entry),
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

  private async reconcileRunningIssues(): Promise<void> {
    this.reconcileStalledRuns();
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
      if (isStateIn(latest.state, this.config.tracker.terminalStates)) {
        await this.terminateRunningIssue(issueId, true, "terminal state");
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

  private reconcileStalledRuns(): void {
    const codexConfig = this.config.raw as { codex?: { stall_timeout_ms?: unknown } };
    const stallTimeout = codexConfig.codex?.stall_timeout_ms ?? 300_000;
    if (typeof stallTimeout !== "number" || stallTimeout <= 0) return;
    const now = Date.now();
    for (const [issueId, entry] of this.running) {
      const lastActivity = entry.lastEventAt?.getTime() ?? entry.startedAt.getTime();
      if (now - lastActivity > stallTimeout) {
        entry.abortController.abort();
        this.options.logger.warn("run stalled", {
          issue_id: issueId,
          issue_identifier: entry.issue.identifier,
        });
      }
    }
  }

  private async terminateRunningIssue(issueId: string, cleanupWorkspace: boolean, reason: string): Promise<void> {
    const entry = this.running.get(issueId);
    if (!entry) return;
    entry.suppressRetryOnExit = true;
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

  private async lifecycleAllowsDispatch(issue: Issue, role: AgentRunRole): Promise<boolean> {
    const store = this.options.lifecycleStore;
    if (!store) return true;
    const lifecycle = await store.get(issue.id);
    if (!lifecycle) return true;

    const phase = phaseForIssueState(issue.state, this.config);
    const blockedByLifecycle = lifecycle.phase === "blocked" || lifecycle.blockedReason !== null;
    if (blockedByLifecycle) {
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

    if (role === "worker" && lifecycle.incompleteTurnCount >= this.config.reviewLoop.maxIncompleteTurns) {
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
    if (!(await this.lifecycleAllowsDispatch(issue, "worker"))) return false;

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
    if (!(await this.lifecycleAllowsDispatch(latest, "worker"))) return false;

    const dispatchWriteback = planDispatchWriteback(latest, this.config);
    if (!(await this.applyWriteback(dispatchWriteback, "dispatch"))) return false;
    const afterWriteback = dispatchWriteback
      ? (await this.options.tracker.fetchIssueStatesByIds([issue.id]))[0]
      : latest;
    if (!afterWriteback) return false;
    if (!this.shouldDispatchWorker(afterWriteback, allowExistingClaim)) return false;
    if (!(await this.lifecycleAllowsDispatch(afterWriteback, "worker"))) return false;

    this.dispatchIssue(afterWriteback, attempt, "worker", null);
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

  private dispatchIssue(
    issue: Issue,
    attempt: number | null,
    role: AgentRunRole,
    reviewEvidence: ReviewerDispatchEvidence | null,
  ): void {
    const abortController = new AbortController();
    const retryAttempt = attempt ?? 0;
    const entry: RunningEntry = {
      issue,
      role,
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
      turnCount: 0,
      retryAttempt,
      tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      cleanupWorkspaceOnExit: false,
      suppressRetryOnExit: false,
      completionReportAccepted: false,
      reviewVerdictAccepted: false,
      reviewEvidence,
    };
    this.running.set(issue.id, entry);
    this.claimed.add(issue.id);
    this.clearRetry(issue.id);
    const run = role === "reviewer" ? this.runReviewer(entry) : this.runWorker(entry, attempt);
    entry.worker = run
      .then(() => this.onWorkerExit(issue.id, "normal", null))
      .catch((error: unknown) => this.onWorkerExit(issue.id, "abnormal", errorMessage(error)));
  }

  private async runWorker(entry: RunningEntry, attempt: number | null): Promise<void> {
    let workspace: Workspace | null = null;
    try {
      workspace = await this.options.workspaceManager.createForIssue(entry.issue);
      entry.workspacePath = workspace.path;
      entry.workspace = workspace;
      await this.updateLifecycle(entry, {
        phase: phaseForIssueState(entry.issue.state, this.config),
        summaryPointers: {
          workspaceKey: workspace.workspaceKey,
          workspacePath: workspace.path,
          branchName: workspace.gitBranchName ?? null,
          gitBranchName: workspace.gitBranchName ?? null,
          repoPath: workspace.repoPath ?? null,
          baseRef: workspace.baseRef ?? null,
        },
      });
      await this.options.workspaceManager.beforeRun(workspace.path);
      await this.options.harness.prepare?.(this.buildRunContext(entry, workspace, attempt, 1));
      await this.options.harness.reload?.(this.buildRunContext(entry, workspace, attempt, 1));

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
        await this.options.workspaceManager.afterRun(workspace.path);
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
      const prompt = await this.promptRenderer.render(this.reviewerPromptTemplate(), {
        issue: entry.issue,
        attempt: null,
        role: "reviewer",
        completionReport: evidence.completionReport,
        acceptanceCriteria: acceptanceCriteriaForReport(evidence.completionReport),
        workspaceEvidence: workspaceEvidenceForReview(entry.issue, workspace, evidence),
        validationEvidence: evidence.completionReport.validationEvidence,
        runDigest: evidence.runDigest,
      });
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
      entry.lastEvent = event.type;
      entry.lastEventAt = new Date(event.at ?? Date.now());
      if (event.type === "session_started") {
        entry.sessionId = event.sessionId;
        entry.runId = event.runId ?? event.sessionId;
        entry.activeRunId = entry.runId;
        await this.updateLifecycle(entry, { summaryPointers: { lastRunId: entry.runId } });
        await this.options.runStore?.startRun({
          runId: entry.runId,
          sessionId: event.sessionId,
          agentId: event.threadId ?? null,
          role: entry.role,
          issueId: entry.issue.id,
          issueIdentifier: entry.issue.identifier,
          attempt: context.attempt,
          turnNumber: context.turnNumber,
          prompt: context.prompt,
          workspaceKey: context.workspace.workspaceKey,
          workspacePath: context.workspace.path,
          ...(context.workspace.gitBranchName === undefined ? {} : { gitBranchName: context.workspace.gitBranchName }),
          ...(context.workspace.repoPath === undefined ? {} : { repoPath: context.workspace.repoPath }),
          ...(context.workspace.baseRef === undefined ? {} : { baseRef: context.workspace.baseRef }),
        });
        await this.discoverPullRequestForEntry(entry, context.workspace);
        if (entry.role === "worker") {
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
      if (event.type === "progress") entry.lastMessage = event.message;
      if (event.type === "tokens") this.applyTokenUpdate(entry, event.tokens);
      if (event.type === "rate_limits") this.rateLimits = event.payload;
      await this.persistHarnessEvent(entry, event);
      if (event.type === "completed") {
        await this.options.runStore?.updateRun(entry.activeRunId ?? entry.runId ?? "", {
          status: "succeeded",
          completedAt: new Date().toISOString(),
          tokens: entry.tokens,
        });
        await this.discoverPullRequestForEntry(entry, context.workspace);
        if (entry.role === "worker" && !(await this.reconcileCompletionReportHandoff(entry))) {
          await this.recordIncompleteTurn(entry);
        }
        if (entry.role === "reviewer") {
          await this.reconcileReviewVerdictHandoff(entry);
        }
      }
      if (event.type === "failed") {
        await this.options.runStore?.updateRun(entry.activeRunId ?? entry.runId ?? "", {
          status: "failed",
          completedAt: new Date().toISOString(),
          error: event.error,
          tokens: entry.tokens,
        });
        throw new SymphonyError("agent_error", event.error);
      }
      if (event.type === "cancelled") {
        await this.options.runStore?.updateRun(entry.activeRunId ?? entry.runId ?? "", {
          status: "cancelled",
          completedAt: new Date().toISOString(),
          tokens: entry.tokens,
        });
        throw new SymphonyError("agent_error", "Run was cancelled");
      }
    }
  }

  private async onWorkerExit(issueId: string, kind: "normal" | "abnormal", error: string | null): Promise<void> {
    const entry = this.running.get(issueId);
    if (!entry) return;
    this.running.delete(issueId);
    this.endedRuntimeSeconds += (Date.now() - entry.startedAt.getTime()) / 1000;

    if (kind === "normal") {
      if (entry.runId) {
        await this.options.runStore?.updateRun(entry.runId, {
          status: "succeeded",
          completedAt: new Date().toISOString(),
          tokens: entry.tokens,
        });
      }
      this.completed.add(issueId);
      if (entry.role === "reviewer") {
        await this.reconcileReviewVerdictHandoff(entry);
        this.claimed.delete(issueId);
        return;
      }
      if (await this.reconcileCompletionReportHandoff(entry)) {
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
        this.scheduleRetry(issueId, entry.issue.identifier, 1, 1_000, null);
      } else {
        this.claimed.delete(issueId);
      }
    } else if (entry.role === "reviewer") {
      if (entry.runId) {
        await this.options.runStore?.updateRun(entry.runId, {
          status: entry.suppressRetryOnExit ? "cancelled" : "failed",
          completedAt: new Date().toISOString(),
          error,
          tokens: entry.tokens,
        });
      }
      this.claimed.delete(issueId);
    } else if (entry.suppressRetryOnExit) {
      if (entry.runId) {
        await this.options.runStore?.updateRun(entry.runId, {
          status: "cancelled",
          completedAt: new Date().toISOString(),
          error,
          tokens: entry.tokens,
        });
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
        await this.options.runStore?.updateRun(entry.runId, {
          status: "failed",
          completedAt: new Date().toISOString(),
          error,
          tokens: entry.tokens,
        });
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
      const nextAttempt = Math.max(entry.retryAttempt + 1, 1);
      const delayMs = Math.min(10_000 * 2 ** (nextAttempt - 1), this.config.agent.maxRetryBackoffMs);
      this.scheduleRetry(issueId, entry.issue.identifier, nextAttempt, delayMs, error);
    }
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

  private scheduleRetry(issueId: string, identifier: string, attempt: number, delayMs: number, error: string | null): void {
    this.clearRetry(issueId);
    const dueAtMs = Date.now() + delayMs;
    const timer = setTimeout(() => {
      void this.onRetryTimer(issueId);
    }, delayMs);
    this.retryAttempts.set(issueId, { issueId, identifier, attempt, dueAtMs, timer, error });
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
      if (this.availableSlots() <= 0) {
        this.scheduleRetry(issueId, retry.identifier, retry.attempt + 1, 1_000, "no available orchestrator slots");
        return;
      }
      const dispatched = await this.tryDispatchWorkerIssue(issue, retry.attempt, true);
      if (!dispatched) this.claimed.delete(issueId);
    } catch (error) {
      this.scheduleRetry(issueId, retry.identifier, retry.attempt + 1, 1_000, errorMessage(error));
    }
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
      attempt,
      workspace,
      config: this.config,
      turnNumber,
      abortSignal: entry.abortController.signal,
      logger: this.options.logger,
    };
  }

  private applyTokenUpdate(entry: RunningEntry, tokens: Partial<TokenCounts>): void {
    const next = {
      inputTokens: tokens.inputTokens ?? entry.tokens.inputTokens,
      outputTokens: tokens.outputTokens ?? entry.tokens.outputTokens,
      totalTokens: tokens.totalTokens ?? entry.tokens.totalTokens,
    };
    this.totals.inputTokens += Math.max(next.inputTokens - entry.tokens.inputTokens, 0);
    this.totals.outputTokens += Math.max(next.outputTokens - entry.tokens.outputTokens, 0);
    this.totals.totalTokens += Math.max(next.totalTokens - entry.tokens.totalTokens, 0);
    entry.tokens = next;
  }

  private async persistHarnessEvent(entry: RunningEntry, event: AgentEvent): Promise<void> {
    const runId = entry.activeRunId ?? entry.runId;
    if (!runId) return;
    const message = event.type === "progress" || event.type === "completed" ? event.message : undefined;
    await this.options.runStore?.appendEvent({
      runId,
      at: new Date(event.at ?? Date.now()).toISOString(),
      source: "harness",
      eventType: event.type,
      ...(message === undefined ? {} : { message }),
      payload: event,
    });
    if (event.type === "tokens") {
      await this.options.runStore?.updateRun(runId, { tokens: entry.tokens });
    }
  }

  private async recordIncompleteTurn(entry: RunningEntry): Promise<void> {
    const store = this.options.lifecycleStore;
    if (!store) return;
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

    return true;
  }

  private async updateLifecycle(entry: RunningEntry, patch: IssueLifecyclePatch): Promise<void> {
    const store = this.options.lifecycleStore;
    if (!store) return;
    entry.lifecycle = await store.updateIssue(entry.issue, patch);
  }

  private async discoverPullRequestForEntry(entry: RunningEntry, workspace: Workspace): Promise<void> {
    const client = this.options.pullRequestClient;
    const branchName = workspace.gitBranchName ?? entry.issue.branchName;
    if (!client || !branchName) return;

    let pullRequest: DiscoveredPullRequest | null;
    try {
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
    return configured === null || configured.trim().length === 0 ? DEFAULT_REVIEWER_PROMPT_TEMPLATE : configured;
  }

  private async renderWorkerPrompt(entry: RunningEntry, attempt: number | null): Promise<string> {
    const basePrompt = await this.promptRenderer.render(this.promptTemplate, { issue: entry.issue, attempt });
    const reviewVerdict = await this.loadWorkerReviewVerdictPrompt(entry);
    const reviewEvidence = await this.loadWorkerReviewEvidencePrompt(entry);
    return [basePrompt, this.cursorWorkerMcpPrompt(entry), reviewVerdict, reviewEvidence]
      .filter((item): item is string => item !== null)
      .join("\n");
  }

  private async renderWorkerContinuationPrompt(entry: RunningEntry): Promise<string> {
    const continuationBrief = await this.renderContinuationBrief(entry);
    const reviewVerdict = await this.loadWorkerReviewVerdictPrompt(entry);
    const reviewEvidence = await this.loadWorkerReviewEvidencePrompt(entry);
    return [
      continuationBrief,
      reviewVerdict,
      reviewEvidence,
      this.cursorWorkerMcpPrompt(entry),
    ]
      .filter((item): item is string => item !== null)
      .join("\n");
  }

  private async renderContinuationBrief(entry: RunningEntry): Promise<string> {
    const lifecycle = entry.lifecycle ?? (await this.options.lifecycleStore?.get(entry.issue.id)) ?? null;
    const runs = (await this.options.runStore?.listRunsForIssue(entry.issue.id)) ?? [];
    const history = await this.loadContinuationHistory(runs);
    const threshold = this.config.reviewLoop.continuationHistoryThreshold;
    const historyMode = history.eventCount <= threshold ? "full" : "summary";
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
      ...(historyMode === "full"
        ? ["", "Full relevant history:", ...formatFullHistory(history.runs)]
        : [
            "",
            "Stored continuation summary:",
            `- Reference: ${summaryReference?.id ?? "n/a"}`,
            `- Created at: ${summaryReference?.createdAt ?? "n/a"}`,
            `- Summary: ${summaryReference?.summary ?? "No stored continuation history summary is available yet."}`,
            "",
            "Transcript/status pointers:",
            ...formatPointerList(summaryReference?.transcriptPointers ?? transcriptPointers),
            ...formatPointerList(summaryReference?.statusApiPointers ?? statusApiPointers),
          ]),
    ].join("\n");
  }

  private async loadContinuationHistory(runs: RunRecord[]): Promise<{
    eventCount: number;
    runs: Array<{ run: RunRecord; events: TranscriptEvent[]; truncated: boolean }>;
  }> {
    const threshold = this.config.reviewLoop.continuationHistoryThreshold;
    let eventCount = 0;
    const history: Array<{ run: RunRecord; events: TranscriptEvent[]; truncated: boolean }> = [];
    for (const run of runs) {
      if (!this.options.runStore) break;
      const page = await this.options.runStore.readTranscript(run.runId, { limit: threshold + 1 });
      const truncated = page.nextOffset !== null;
      eventCount += page.events.length + (truncated ? 1 : 0);
      history.push({ run, events: page.events, truncated });
    }
    return { eventCount, runs: history };
  }

  private cursorWorkerMcpPrompt(entry: RunningEntry): string | null {
    if (this.options.harness.id !== "cursor") return null;
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

  private async loadWorkerReviewEvidencePrompt(entry: RunningEntry): Promise<string | null> {
    if (!this.options.lifecycleStore || !this.options.pullRequestReviewClient) return null;
    const service = new PullRequestReviewEvidenceService({
      lifecycleStore: this.options.lifecycleStore,
      client: this.options.pullRequestReviewClient,
      fullHistoryThreshold: this.config.reviewLoop.continuationHistoryThreshold,
    });
    try {
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
        `Worker prompt: ${oneLine(workerRun.prompt).slice(0, 240)}`,
      ]
    : ["Worker run metadata is unavailable."];
  const eventDigest = events
    .filter((event) => event.message !== undefined && event.message.trim().length > 0)
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
  return [...byId.values()].sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
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
  return runs.map((run) => `/api/v1/runs/${encodeURIComponent(run.runId)}/transcript`);
}

function statusApiPointersForIssue(issueIdentifier: string, runs: RunRecord[]): string[] {
  return [
    `/api/v1/issues/${encodeURIComponent(issueIdentifier)}`,
    `/api/v1/issues/${encodeURIComponent(issueIdentifier)}/runs`,
    ...runs.map((run) => `/api/v1/runs/${encodeURIComponent(run.runId)}`),
  ];
}

function formatFullHistory(history: Array<{ run: RunRecord; events: TranscriptEvent[]; truncated: boolean }>): string[] {
  if (history.length === 0) return ["- No prior run history is available."];
  return history.flatMap(({ run, events, truncated }) => [
    `- Run ${run.runId} (${run.role}, turn ${run.turnNumber}, status ${run.status})`,
    `  Prompt: ${oneLine(run.prompt).slice(0, 240) || "n/a"}`,
    `  Workspace: ${run.workspacePath}`,
    `  Branch: ${run.gitBranchName ?? "n/a"}; base: ${run.baseRef ?? "n/a"}`,
    ...(events.length === 0
      ? ["  Transcript events: none"]
      : events.map((event) => `  #${event.sequence} ${event.eventType}: ${oneLine(event.message ?? "").slice(0, 240) || "n/a"}`)),
    ...(truncated ? ["  Transcript truncated; inspect the transcript API pointer for the remaining events."] : []),
  ]);
}

function formatPointerList(pointers: string[]): string[] {
  return pointers.length === 0 ? ["- n/a"] : pointers.map((pointer) => `- ${pointer}`);
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

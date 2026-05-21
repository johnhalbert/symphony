import { setTimeout as delay } from "node:timers/promises";
import type { ServiceConfig } from "../config/Config.js";
import { SymphonyError, errorMessage } from "../errors.js";
import type { AgentEvent, AgentHarness } from "../harness/AgentHarness.js";
import type { Logger } from "../logging/StructuredLogger.js";
import type { TrackerClient } from "../tracker/TrackerClient.js";
import type { Issue, RuntimeTotals, TokenCounts, Workspace } from "../types.js";
import type { WorkspaceManager } from "../workspace/WorkspaceManager.js";
import { PromptRenderer } from "../workflow/PromptRenderer.js";
import type { RunTranscriptStore } from "../persistence/RunTranscriptStore.js";
import {
  phaseForIssueState,
  type IssueLifecyclePatch,
  type IssueLifecycleRecord,
  type IssueLifecycleStore,
} from "../persistence/IssueLifecycleStore.js";
import type { WritebackProcessor } from "../writeback/WritebackOutbox.js";
import {
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
}

export interface PullRequestDiscoveryClient {
  findOpenPullRequestByBranch(input: { branchName: string }): Promise<DiscoveredPullRequest | null>;
}

export interface DiscoveredPullRequest {
  url: string;
  number: number;
  headBranch: string;
  lastPushedAt: string | null;
}

export interface RunningEntry {
  issue: Issue;
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
  ciStatus: string | null;
  lastPushedAt: string | null;
  branchName: string | null;
  gitBranchName: string | null;
  repoPath: string | null;
  baseRef: string | null;
}

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
      const candidates = await this.options.tracker.fetchCandidateIssues();
      for (const issue of sortIssuesForDispatch(candidates)) {
        if (this.availableSlots() <= 0) break;
        await this.tryDispatchIssue(issue, null);
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
      } else if (isStateIn(latest.state, this.config.tracker.handoffStates)) {
        await this.terminateRunningIssue(issueId, false, "handoff state");
      } else if (!latest.assignedToWorker) {
        await this.terminateRunningIssue(issueId, false, "assignee route changed");
      } else if (!isStateIn(latest.state, this.config.tracker.activeStates)) {
        await this.terminateRunningIssue(issueId, false, "non-active state");
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

  private shouldDispatch(issue: Issue, allowExistingClaim = false): boolean {
    if (this.running.has(issue.id)) return false;
    if (this.pausedIssues.has(issue.id)) return false;
    if (!allowExistingClaim && this.claimed.has(issue.id)) return false;
    if (!issue.assignedToWorker) return false;
    if (isStateIn(issue.state, this.config.tracker.handoffStates)) return false;
    if (!isStateIn(issue.state, this.config.tracker.activeStates)) return false;
    if (isStateIn(issue.state, this.config.tracker.terminalStates)) return false;
    if (!this.passesLabelGuardrails(issue)) return false;
    if (issue.state.toLowerCase() === "todo") {
      const hasOpenBlocker = issue.blockedBy.some(
        (blocker) => blocker.state === null || !isStateIn(blocker.state, this.config.tracker.terminalStates),
      );
      if (hasOpenBlocker) return false;
    }
    return this.hasStateSlot(issue.state);
  }

  private passesLabelGuardrails(issue: Issue): boolean {
    const labels = new Set(issue.labels.map((label) => label.toLowerCase()));
    if (this.config.agent.requireLabels.some((label) => !labels.has(label))) return false;
    if (this.config.agent.excludeLabels.some((label) => labels.has(label))) return false;
    return true;
  }

  private async tryDispatchIssue(issue: Issue, attempt: number | null, allowExistingClaim = false): Promise<boolean> {
    if (this.availableSlots() <= 0) return false;
    if (!this.shouldDispatch(issue, allowExistingClaim)) return false;

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
    if (!this.shouldDispatch(latest, allowExistingClaim)) return false;

    const dispatchWriteback = planDispatchWriteback(latest, this.config);
    if (!(await this.applyWriteback(dispatchWriteback, "dispatch"))) return false;
    const afterWriteback = dispatchWriteback
      ? (await this.options.tracker.fetchIssueStatesByIds([issue.id]))[0]
      : latest;
    if (!afterWriteback) return false;
    if (!this.shouldDispatch(afterWriteback, allowExistingClaim)) return false;

    this.dispatchIssue(afterWriteback, attempt);
    return true;
  }

  private dispatchIssue(issue: Issue, attempt: number | null): void {
    const abortController = new AbortController();
    const retryAttempt = attempt ?? 0;
    const entry: RunningEntry = {
      issue,
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
    };
    this.running.set(issue.id, entry);
    this.claimed.add(issue.id);
    this.clearRetry(issue.id);
    entry.worker = this.runWorker(entry, attempt)
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
            ? await this.promptRenderer.render(this.promptTemplate, { issue: entry.issue, attempt })
            : "Continue working on the issue. Check current issue state and proceed according to the workflow.";
        const context = this.buildRunContext(entry, workspace, attempt, turnNumber);
        await this.consumeHarnessEvents(entry, this.options.harness.run(context, prompt), {
          workspace,
          prompt,
          attempt,
          turnNumber,
        });

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
        await this.recordIncompleteTurn(entry);
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
    return this.shouldDispatch(latest, true);
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
      const dispatched = await this.tryDispatchIssue(issue, retry.attempt, true);
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
    const incompleteTurnCount = (entry.lifecycle?.incompleteTurnCount ?? 0) + 1;
    await this.updateLifecycle(entry, { incompleteTurnCount });
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
      lastPushedAt: pullRequest.lastPushedAt,
      gitBranchName: branchName,
      repoPath: workspace.repoPath ?? null,
      baseRef: workspace.baseRef ?? null,
    };
    await this.updateLifecycle(entry, {
      summaryPointers: {
        prUrl: metadata.prUrl,
        prNumber: metadata.prNumber,
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
      (existing.lastPushedAt ?? null) === metadata.lastPushedAt
    ) {
      return;
    }
    await this.options.runStore.recordPullRequestEvent({
      runId,
      action: existing?.prUrl ? "updated" : "opened",
      prUrl: metadata.prUrl,
      prNumber: metadata.prNumber,
      lastPushedAt: metadata.lastPushedAt,
      gitBranchName: metadata.gitBranchName,
      repoPath: metadata.repoPath,
      baseRef: metadata.baseRef,
    });
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

function metadataForRunningEntry(entry: RunningEntry): IssueRunMetadata {
  const pointers = entry.lifecycle?.summaryPointers;
  return {
    prUrl: pointers?.prUrl ?? null,
    prNumber: pointers?.prNumber ?? null,
    ciStatus: pointers?.ciStatus ?? null,
    lastPushedAt: pointers?.lastPushedAt ?? null,
    branchName: pointers?.branchName ?? entry.workspace?.gitBranchName ?? entry.issue.branchName ?? null,
    gitBranchName: pointers?.gitBranchName ?? entry.workspace?.gitBranchName ?? entry.issue.branchName ?? null,
    repoPath: pointers?.repoPath ?? entry.workspace?.repoPath ?? null,
    baseRef: pointers?.baseRef ?? entry.workspace?.baseRef ?? null,
  };
}

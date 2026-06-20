import { promises as fs } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { parseIssueRuntimeSourceScope, type ServiceConfig } from "../config/Config.js";
import {
  LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
  LEGACY_DEFAULT_PROJECT_CONTEXT_ROUTING_SOURCE,
  normalizeProjectContextResolution,
  normalizeProjectContextId,
  projectContextResolutionFromIssue,
  resolveProjectContextForIssue,
  type ProjectContextResolution,
} from "../config/ProjectContexts.js";
import { resolveServiceConfigForProjectContext } from "../config/ProjectContextServiceConfig.js";
import { SymphonyError, errorMessage } from "../errors.js";
import type {
  AgentActivitySource,
  AgentEvent,
  AgentHarness,
  AgentRunSdkStatus,
  OperatorChatRunContext,
} from "../harness/AgentHarness.js";
import {
  harnessSupportsContinuation,
  harnessSupportsMcpHandoff,
  renderCompletionMcpHandoffPrompt,
  renderIssueBreakdownMcpHandoffPrompt,
  renderMergeConflictResolutionMcpHandoffPrompt,
  renderOperatorChatMcpPrompt,
  renderReviewMcpHandoffPrompt,
} from "../harness/HandoffMcp.js";
import type { Logger } from "../logging/StructuredLogger.js";
import type { TrackerClient } from "../tracker/TrackerClient.js";
import {
  runKindForPhase,
  toIssueStatusView,
  type AgentRunPhase,
  type AgentRunKind,
  type AgentRunRole,
  type Issue,
  type IssueRouteEvidence,
  type IssueRouteEvidenceSource,
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
import { IssueBreakdownPlanApplyService } from "../IssueBreakdownPlanApplyService.js";
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
  type StartRunInput,
  type TranscriptEvent,
  type UpdateRunInput,
} from "../persistence/RunTranscriptStore.js";
import type { OrchestratorConversationMessage, OrchestratorConversationStore } from "../persistence/OrchestratorConversationStore.js";
import { FileProviderGateStore, type ProviderGateStore } from "../persistence/ProviderGateStore.js";
import {
  normalizeProviderLimitSignal,
  providerLimitDelayMs,
  type ProviderLimitSignal,
  type RuntimeProviderGate,
} from "../provider/ProviderLimits.js";
import { mapAgentEventToRunActivityEvent } from "../transcript/RunActivityEventMapper.js";
import { sanitizeAgentEventForPublicOutput } from "../transcript/TranscriptProjection.js";
import { appendLaneMemoTelemetry } from "../persistence/LaneMemoTelemetry.js";
import {
  buildWorkerHandoffPacket,
  phaseForIssueState,
  type IssueCompletionReportRecord,
  type IssueLifecyclePatch,
  type IssueLifecycleRecord,
  type IssueLifecycleSummaryReference,
  type IssueLifecycleStore,
  type IssueMergeConflictMetadata,
  type IssueReviewVerdictRecord,
} from "../persistence/IssueLifecycleStore.js";
import { MergePolicyService, type MergePolicyGitHubClient } from "../merge/MergePolicyService.js";
import { sanitizeStaleMergeGateLifecycle, staleMergeGateLifecyclePatch } from "../merge/MergeGateLifecycle.js";
import {
  formatWorkerReviewEvidencePrompt,
  isActiveReviewEvidenceItem,
  PullRequestReviewEvidenceService,
  type PullRequestReviewEvidenceClient,
} from "../review/PullRequestReviewEvidenceService.js";
import {
  formatWorkerMergeGatePromptResult,
  formatWorkerReviewVerdictPrompt,
  type WorkerMergeGatePromptResult,
} from "../ReviewVerdictService.js";
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
import type {
  OrchestratorChatCommand,
  OrchestratorChatCommandResult,
} from "./OrchestratorChatCommand.js";

export interface OrchestratorOptions {
  config: ServiceConfig;
  tracker: TrackerClient;
  trackerResolver?: (projectContext?: ProjectContextResolution) => TrackerClient;
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
  providerGateStore?: ProviderGateStore;
  orchestratorConversationStore?: OrchestratorConversationStore;
  statusServerBaseUrl?: () => string | null;
  statusMutationToken?: string | null;
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
  projectContext: ProjectContextResolution | null;
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
  mergeConflictResolutionAccepted: boolean;
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
  providerLimitSignal: ProviderLimitSignal | null;
}

interface ReviewerDispatchEvidence {
  lifecycle: IssueLifecycleRecord;
  completionReport: IssueCompletionReportRecord;
  workerRun: RunRecord | null;
  runDigest: string[];
}

type WorkerDispatchDecision =
  | { action: "dispatch"; runPhase: AgentRunPhase; projectContext?: ProjectContextResolution | undefined }
  | { action: "skip"; reason: string };

export interface RetryEntry {
  issueId: string;
  identifier: string;
  attempt: number;
  dueAtMs: number;
  timer: NodeJS.Timeout;
  error: string | null;
  runPhase: AgentRunPhase;
  projectContext: ProjectContextResolution | undefined;
}

type TerminalRunPatch = Pick<UpdateRunInput, "status" | "completedAt" | "error" | "tokens" | "metadata">;
type TerminalUpdateResult = { updated: true; record: RunRecord | null } | { updated: false; record: RunRecord | null };
type AcceptedHandoffKind = "completion_report" | "pull_request_handoff" | "issue_breakdown_plan" | "merge_conflict_resolution";

interface OperatorChatQueueEntry {
  conversationId: string;
  messageId: string;
  command: OrchestratorChatCommand;
  abortController: AbortController;
  worker: Promise<void>;
  runId: string | null;
  sessionId: string | null;
  startedAt: Date;
  tokens: TokenCounts;
}

const PLANNING_NO_PLAN_ERROR = "Planning run completed without submit_issue_breakdown_plan";
const PLANNING_FAILURE_DIAGNOSTIC_CODE = "planning_run_failed";

export interface RuntimeSnapshot {
  generatedAt: string;
  counts: {
    running: number;
    retrying: number;
    paused: number;
    providerGates: number;
  };
  providerGates: RuntimeProviderGate[];
  providerGateCounts: {
    active: number;
    manual: number;
    autoResume: number;
  };
  running: Array<{
    issueId: string;
    issueIdentifier: string;
    role: AgentRunRole;
    runPhase: AgentRunPhase;
    runKind: AgentRunKind;
    state: string;
    projectContext?: ProjectContextResolution | undefined;
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

Use the linked GitHub pull request as the primary detailed review surface. Call the submit_pull_request_review_feedback MCP tool before any verdict submission to leave concrete feedback directly on the lifecycle-bound PR by submitting a GitHub PR review and/or posting PR review comments. A pass verdict requires a prior whole-PR review with kind "review" and event "APPROVE" in this reviewer run. Requested changes should use kind "review" with event "REQUEST_CHANGES" when PR feedback is submitted, and must point to the relevant files, lines, or threads on GitHub.

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
- For a pass verdict, first use kind "review" with event "APPROVE" for whole-PR approval feedback; include inline comments when helpful.
- For a fail verdict, use kind "review" with event "REQUEST_CHANGES" when submitting whole-PR review feedback; include inline comments when helpful.
- Use kind "review_comment" for a single inline comment or reply, and "issue_comment" only for supplemental high-level PR comments. These supplemental comments do not satisfy pass approval.
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
  private readonly activeWorkers = new Set<Promise<void>>();
  private readonly claimed = new Set<string>();
  private readonly completed = new Set<string>();
  private readonly pausedIssues = new Set<string>();
  private readonly retryAttempts = new Map<string, RetryEntry>();
  private readonly operatorChatQueues = new Map<string, Promise<void>>();
  private readonly operatorChatRuns = new Map<string, OperatorChatQueueEntry>();
  private readonly totals: TokenCounts = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  private readonly providerGateStore: ProviderGateStore;
  private activeProviderGates: RuntimeProviderGate[] = [];
  private rateLimits: unknown = null;

  constructor(private readonly options: OrchestratorOptions) {
    this.config = options.config;
    this.promptTemplate = options.promptTemplate;
    this.providerGateStore = options.providerGateStore ?? new FileProviderGateStore(options.config.workspace.stateDir);
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.refreshProviderGates();
    await this.options.writeback?.processDue();
    await this.startupCleanup();
    this.scheduleTick(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    for (const retry of this.retryAttempts.values()) clearTimeout(retry.timer);
    for (const entry of this.operatorChatRuns.values()) {
      entry.abortController.abort();
      const stopRunId = entry.runId;
      if (stopRunId) {
        await this.options.harness.stop?.(stopRunId).catch((error: unknown) => {
          this.options.logger.warn("operator chat harness stop failed", {
            run_id: stopRunId,
            conversation_id: entry.conversationId,
            error: errorMessage(error),
          });
        });
      }
    }
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
    const workers = new Set([
      ...this.activeWorkers,
      ...[...this.running.values()].map((entry) => entry.worker),
      ...[...this.operatorChatRuns.values()].map((entry) => entry.worker),
      ...this.operatorChatQueues.values(),
    ]);
    await Promise.allSettled([...workers]);
  }

  updateConfig(config: ServiceConfig, promptTemplate: string): void {
    this.config = config;
    this.promptTemplate = promptTemplate;
  }

  async refreshNow(): Promise<void> {
    await this.tick();
  }

  async dispatchOrchestratorChatCommand(command: OrchestratorChatCommand): Promise<OrchestratorChatCommandResult> {
    if (this.stopped) {
      return { status: "disabled", reason: "orchestrator_stopped" };
    }
    if (!this.options.orchestratorConversationStore) {
      return { status: "unavailable", reason: "orchestrator_conversation_store_unavailable" };
    }
    if (typeof this.options.harness.runOperatorChat !== "function") {
      return { status: "unavailable", reason: `harness_${this.options.harness.id}_does_not_support_operator_chat` };
    }
    this.options.logger.info("orchestrator chat command accepted", {
      action: command.action,
      conversation_id: command.conversationId,
      message_id: command.messageId,
      source: command.source,
    });
    const acceptedAt = new Date().toISOString();
    const previous = this.operatorChatQueues.get(command.conversationId);
    const queued = Boolean(previous);
    const abortController = new AbortController();
    const worker = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.runOperatorChatCommand(command, abortController));
    const entry: OperatorChatQueueEntry = {
      conversationId: command.conversationId,
      messageId: command.messageId,
      command,
      abortController,
      worker,
      runId: null,
      sessionId: null,
      startedAt: new Date(acceptedAt),
      tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
    this.operatorChatRuns.set(command.messageId, entry);
    this.operatorChatQueues.set(command.conversationId, worker);
    void worker.finally(() => {
      this.operatorChatRuns.delete(command.messageId);
      if (this.operatorChatQueues.get(command.conversationId) === worker) {
        this.operatorChatQueues.delete(command.conversationId);
      }
    });
    return {
      status: "accepted",
      reason: queued ? "queued" : "accepted",
      acceptedAt,
      metadata: {
        conversationId: command.conversationId,
        messageId: command.messageId,
        queued,
        role: "planner",
        runKind: "planning",
        harnessId: this.options.harness.id,
        model: runtimeModelForHarness(this.options.harness.id, this.config),
      },
    };
  }

  private async runOperatorChatCommand(command: OrchestratorChatCommand, abortController: AbortController): Promise<void> {
    const store = this.options.orchestratorConversationStore;
    const runOperatorChat = this.options.harness.runOperatorChat?.bind(this.options.harness);
    if (!store || !runOperatorChat) return;

    const queueEntry = this.operatorChatRuns.get(command.messageId) ?? null;
    const workspace = await this.operatorChatWorkspace();
    const messages = await store.listMessages(command.conversationId);
    const turnNumber = Math.max(1, messages.filter((message) => message.role === "user").length);
    const context: OperatorChatRunContext = {
      conversationId: command.conversationId,
      messageId: command.messageId,
      workspace,
      config: this.config,
      turnNumber,
      abortSignal: abortController.signal,
      logger: this.options.logger,
      statusServer: this.operatorChatStatusServer() ?? null,
    };
    const prompt = await this.renderOperatorChatPrompt(command, messages);
    let assistant: OrchestratorConversationMessage | null = null;
    let assistantText = "";
    let runId: string | null = null;
    let sessionId: string | null = null;
    let tokens: TokenCounts = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let terminalStatus: "succeeded" | "failed" | "cancelled" = "succeeded";
    let terminalError: string | null = null;

    try {
      await store.updateMessage({
        conversationId: command.conversationId,
        messageId: command.messageId,
        status: "completed",
        metadata: {
          dispatch: {
            status: "running",
            role: "planner",
            harnessId: this.options.harness.id,
            startedAt: new Date().toISOString(),
          },
        },
      });
    } catch (error) {
      this.options.logger.warn("operator chat user message status update failed", {
        conversation_id: command.conversationId,
        message_id: command.messageId,
        error: errorMessage(error),
      });
    }

    try {
      for await (const event of runOperatorChat(context, prompt)) {
        if (event.type === "session_started") {
          runId = event.runId ?? event.sessionId;
          sessionId = event.sessionId;
          if (queueEntry) {
            queueEntry.runId = runId;
            queueEntry.sessionId = sessionId;
          }
          const runtimeAllowLargeContext = runtimeAllowLargeContextForHarness(this.options.harness.id, this.config);
          await this.options.runStore?.startRun({
            runId,
            sessionId,
            agentId: event.threadId ?? null,
            role: "planner",
            runPhase: "issue_breakdown",
            runKind: "planning",
            issueId: operatorChatIssueId(command.conversationId),
            issueIdentifier: "OPERATOR",
            attempt: null,
            turnNumber,
            prompt,
            harnessId: this.options.harness.id,
            runtimeModel: event.model ?? runtimeModelForHarness(this.options.harness.id, this.config),
            runtimeModelParams: runtimeModelParamsForHarness(this.options.harness.id, this.config),
            runtimeSettingSources: runtimeSettingSourcesForHarness(this.options.harness.id, this.config),
            runtimeMode: runtimeModeForHarness(this.options.harness.id, this.config),
            ...(runtimeAllowLargeContext === undefined ? {} : { runtimeAllowLargeContext }),
            runtimeAgentLifecycle: "reuse_by_conversation",
            cursorModel: this.config.cursor.model,
            cursorModelParams: this.config.cursor.modelParams,
            cursorSettingSources: this.config.cursor.settingSources,
            cursorMode: this.config.cursor.mode,
            cursorAllowLargeContext: this.config.cursor.allowLargeContext,
            cursorWorkerAgentLifecycle: this.config.cursor.workerAgentLifecycle,
            workspaceKey: workspace.workspaceKey,
            workspacePath: workspace.path,
            ...(workspace.gitBranchName === undefined ? {} : { gitBranchName: workspace.gitBranchName }),
            ...(workspace.repoPath === undefined ? {} : { repoPath: workspace.repoPath }),
            ...(workspace.baseRef === undefined ? {} : { baseRef: workspace.baseRef }),
          });
          assistant = await store.appendMessage({
            conversationId: command.conversationId,
            role: "assistant",
            body: "Starting operator session...",
            status: "streaming",
            metadata: operatorAssistantMetadata({
              command,
              event,
              harnessId: this.options.harness.id,
              model: event.model ?? runtimeModelForHarness(this.options.harness.id, this.config),
            }),
            transcriptLinks: [{ runId, eventType: "session_started" }],
          });
          await this.persistOperatorHarnessEvent(runId, event);
          continue;
        }

        if (event.type === "tokens") {
          tokens = mergeTokenCounts(tokens, event.tokens);
          if (queueEntry) queueEntry.tokens = tokens;
        }
        if (runId) await this.persistOperatorHarnessEvent(runId, event);

        if (event.type === "progress") {
          if (event.activitySource === "tool") {
            await store.appendMessage({
              conversationId: command.conversationId,
              role: "server",
              body: event.message,
              status: "completed",
              metadata: {
                source: "operator_chat_tool",
                runId,
                sessionId,
                harnessId: this.options.harness.id,
              },
              transcriptLinks: runId ? [{ runId, eventType: "tool" }] : [],
            });
            continue;
          }
          assistantText = mergeOperatorAssistantText(assistantText, event.message, event.activitySource);
          assistant = await this.upsertOperatorAssistantMessage(store, command, assistant, assistantText, "streaming", {
            runId,
            sessionId,
            eventType: "progress",
          });
          continue;
        }

        if (event.type === "provider_limit") {
          terminalStatus = "failed";
          terminalError = event.signal.message;
          assistantText = mergeOperatorAssistantText(assistantText, event.signal.message, "stream");
          continue;
        }

        if (event.type === "completed") {
          terminalStatus = "succeeded";
          if (event.message && event.message.trim().length > 0) {
            assistantText = mergeOperatorAssistantText(assistantText, event.message, "stream");
          }
          continue;
        }

        if (event.type === "failed") {
          terminalStatus = "failed";
          terminalError = event.error;
          assistantText = assistantText.trim().length > 0 ? assistantText : event.error;
          continue;
        }

        if (event.type === "cancelled") {
          terminalStatus = "cancelled";
          terminalError = "Operator chat run was cancelled";
          assistantText = assistantText.trim().length > 0 ? assistantText : terminalError;
        }
      }
    } catch (error) {
      terminalStatus = abortController.signal.aborted ? "cancelled" : "failed";
      terminalError = errorMessage(error);
      assistantText = assistantText.trim().length > 0 ? assistantText : `Operator chat failed: ${terminalError}`;
      if (runId) {
        await this.options.runStore?.appendEvent({
          runId,
          at: new Date().toISOString(),
          source: "orchestrator",
          eventType: "operator_chat_error",
          message: terminalError,
          payload: { conversationId: command.conversationId, messageId: command.messageId },
        });
      }
    } finally {
      const completedAt = new Date().toISOString();
      const finalStatus = terminalStatus === "succeeded" ? "completed" : "failed";
      assistant = await this.upsertOperatorAssistantMessage(
        store,
        command,
        assistant,
        assistantText.trim().length > 0 ? assistantText : "Operator run completed.",
        finalStatus,
        {
          runId,
          sessionId,
          eventType: terminalStatus,
          completedAt,
          error: terminalError,
        },
      );
      if (runId) {
        await this.options.runStore?.updateRun(runId, {
          status: terminalStatus,
          completedAt,
          error: terminalError,
          tokens,
          metadata: {
            activitySnapshot: {
              lastHarnessActivityAt: completedAt,
              lastStreamActivityAt: completedAt,
              lastDeltaOrToolActivityAt: completedAt,
              lastToolActivityAt: null,
            },
          },
        });
      }
    }
  }

  private async upsertOperatorAssistantMessage(
    store: OrchestratorConversationStore,
    command: OrchestratorChatCommand,
    existing: OrchestratorConversationMessage | null,
    body: string,
    status: "streaming" | "completed" | "failed",
    metadata: Record<string, unknown>,
  ): Promise<OrchestratorConversationMessage> {
    if (existing) {
      return store.updateMessage({
        conversationId: command.conversationId,
        messageId: existing.id,
        body,
        status,
        metadata: { operatorRun: metadata },
        ...(typeof metadata.runId === "string" && metadata.runId.length > 0
          ? {
              transcriptLinks: [
                { runId: metadata.runId, eventType: typeof metadata.eventType === "string" ? metadata.eventType : null },
              ],
            }
          : {}),
      });
    }
    return store.appendMessage({
      conversationId: command.conversationId,
      role: "assistant",
      body,
      status,
      metadata: {
        source: "operator_chat",
        commandMessageId: command.messageId,
        operatorRun: metadata,
      },
      transcriptLinks:
        typeof metadata.runId === "string" && metadata.runId.length > 0
          ? [{ runId: metadata.runId, eventType: typeof metadata.eventType === "string" ? metadata.eventType : null }]
          : [],
    });
  }

  private async persistOperatorHarnessEvent(runId: string, event: AgentEvent): Promise<void> {
    await this.options.runStore?.appendEvent({
      runId: event.type === "run_status" ? event.runId : runId,
      at: new Date(event.at ?? Date.now()).toISOString(),
      source: "harness",
      ...mapAgentEventToRunActivityEvent(event),
    });
  }

  private async operatorChatWorkspace(): Promise<Workspace> {
    const configuredPath = this.config.workspace.source.path;
    const workspacePath = configuredPath && (await existingDirectory(configuredPath)) ? configuredPath : this.config.workflowDir;
    await fs.mkdir(workspacePath, { recursive: true });
    return {
      path: workspacePath,
      workspaceKey: "operator-chat",
      createdNow: false,
      issueId: "operator-chat",
      issueIdentifier: "OPERATOR",
      sourceKind: "operator_chat",
      ...(configuredPath === undefined || workspacePath !== configuredPath ? {} : { repoPath: configuredPath }),
      ...(this.config.workspace.source.baseRef === undefined ? {} : { baseRef: this.config.workspace.source.baseRef }),
    };
  }

  private operatorChatStatusServer(): OperatorChatRunContext["statusServer"] {
    const baseUrl = this.options.statusServerBaseUrl?.() ?? null;
    return baseUrl ? { baseUrl, mutationToken: this.options.statusMutationToken ?? null } : null;
  }

  private async renderOperatorChatPrompt(
    command: OrchestratorChatCommand,
    messages: readonly OrchestratorConversationMessage[],
  ): Promise<string> {
    const recentMessages = messages.slice(-20).map((message) => {
      const speaker = message.role === "user" ? "User" : message.role === "assistant" ? "Assistant" : "System";
      return `${speaker}: ${message.body}`;
    });
    return [
      "You are the persistent Symphony dashboard operator agent.",
      "",
      "You can inspect and operate Symphony through the provided service-owned MCP tools. Use those tools instead of asking for raw credentials or direct access.",
      "When you take an action, be explicit about what you did and cite the tool result. Preserve useful formatting in your response.",
      "",
      "Current user message:",
      command.input,
      "",
      "Recent conversation:",
      recentMessages.length > 0 ? recentMessages.join("\n\n") : "No prior messages.",
      renderOperatorChatMcpPrompt({
        conversationId: command.conversationId,
        statusBaseUrl: this.options.statusServerBaseUrl?.() ?? null,
      }),
    ].join("\n");
  }

  pauseIssue(issueId: string): void {
    this.pausedIssues.add(issueId);
    this.clearRetry(issueId);
  }

  resumeIssue(issueId: string): void {
    this.pausedIssues.delete(issueId);
    this.scheduleTick(0);
  }

  async clearProviderGate(gateId: string): Promise<RuntimeProviderGate | null> {
    const cleared = await this.providerGateStore.clear(gateId);
    await this.refreshProviderGates();
    this.scheduleTick(0);
    return cleared;
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

  async requestIssueBreakdown(
    issueIdOrIdentifier: string,
    options: { projectContext?: ProjectContextResolution } = {},
  ): Promise<{ queued: boolean; issue: Issue; reason: string; routeEvidence: IssueRouteEvidence }> {
    const gate = await this.activeProviderDispatchGate();
    if (gate) {
      throw new SymphonyError("conflict", providerGateDispatchBlockedMessage(gate));
    }
    if (!this.options.lifecycleStore) {
      throw new SymphonyError("invalid_request", "Issue breakdown planning requires a lifecycle store");
    }
    if (this.availableSlots() <= 0) {
      throw new SymphonyError("conflict", "No agent slots are available for issue breakdown planning");
    }
    const { issue, routeEvidence } = await this.resolveTrackedIssue(issueIdOrIdentifier, options.projectContext, {
      allowCandidateIdentifierLookup: true,
      kind: "issue_breakdown",
    });
    if (!issue) throw new SymphonyError("not_found", `Issue not found: ${issueIdOrIdentifier}`, { routeEvidence });
    const projectContext = this.requestedProjectContextForIssue(issue, options.projectContext);
    const config = this.configForProjectContext(projectContext);
    if (!config.issueBreakdown.enabled) {
      throw new SymphonyError("invalid_request", "Issue breakdown planning is disabled");
    }
    if (this.running.has(issue.id)) throw new SymphonyError("conflict", "Issue already has a running Symphony agent");
    if (this.isMergeConflictState(issue.state)) {
      throw new SymphonyError("conflict", "Merge conflict states are only eligible for conflict-fix workers");
    }
    if (!this.shouldDispatchWorker(issue, false, "issue_breakdown")) {
      throw new SymphonyError("conflict", "Issue is not currently eligible for worker dispatch");
    }
    if (!(await this.lifecycleAllowsDispatch(issue, "worker", "issue_breakdown", projectContext))) {
      throw new SymphonyError("conflict", "Issue lifecycle does not currently allow issue breakdown planning");
    }
    const lifecycle = await this.options.lifecycleStore.get(issue.id);
    if (latestFreshIssueBreakdownPlan(lifecycle, issue, config) !== null) {
      return { queued: false, issue, reason: "fresh_plan_exists", routeEvidence };
    }
    this.dispatchIssue(issue, null, "worker", null, "issue_breakdown", projectContext ?? null);
    return { queued: true, issue, reason: "explicit_request", routeEvidence };
  }

  async applyIssueBreakdownPlan(
    issueIdOrIdentifier: string,
    options: { dryRun?: boolean; projectContext?: ProjectContextResolution } = {},
  ) {
    if (!this.options.lifecycleStore) {
      throw new SymphonyError("invalid_request", "Issue breakdown Linear application requires a lifecycle store");
    }
    const { issue, routeEvidence } = await this.resolveTrackedIssue(issueIdOrIdentifier, options.projectContext, {
      allowCandidateIdentifierLookup: true,
      kind: "issue_breakdown_apply",
    });
    if (!issue) throw new SymphonyError("not_found", `Issue not found: ${issueIdOrIdentifier}`, { routeEvidence });
    const projectContext = this.requestedProjectContextForIssue(issue, options.projectContext);
    const config = this.configForProjectContext(projectContext);
    if (!config.issueBreakdown.enabled || !config.issueBreakdown.applyToLinear.enabled) {
      throw new SymphonyError("invalid_request", "Issue breakdown Linear application is disabled");
    }
    const service = new IssueBreakdownPlanApplyService({
      config,
      lifecycleStore: this.options.lifecycleStore,
      writeback: this.options.writeback,
    });
    const result = options.dryRun === true ? await service.previewLatestFreshPlan(issue) : await service.applyLatestFreshPlan(issue);
    return { ...result, routeEvidence };
  }

  private trackerClientForProjectContext(projectContext?: ProjectContextResolution): TrackerClient {
    return this.options.trackerResolver?.(projectContext) ?? this.options.tracker;
  }

  private currentProjectContext(projectContext: ProjectContextResolution | null | undefined): ProjectContextResolution | undefined {
    if (!projectContext) return undefined;
    const defaultContext = this.config.projectContexts.defaultContext;
    if (
      defaultContext.source === LEGACY_DEFAULT_PROJECT_CONTEXT_ROUTING_SOURCE &&
      projectContext.projectContextId === defaultContext.id &&
      projectContext.routingSource === LEGACY_DEFAULT_PROJECT_CONTEXT_ROUTING_SOURCE &&
      projectContext.linearProjectSlug === null
    ) {
      return {
        ...projectContext,
        linearProjectSlug: defaultContext.tracker.projectSlug,
      };
    }
    return projectContext;
  }

  private issueWithDispatchProjectContext(
    issue: Issue,
    projectContext: ProjectContextResolution | null | undefined,
    force = false,
  ): Issue {
    const currentProjectContext = this.currentProjectContext(projectContext);
    if (!currentProjectContext) return issue;
    if (!force && this.issueHasExplicitProjectContextProof(issue)) return issue;
    if (!force && !this.requestedProjectContextCanProveRouting(currentProjectContext)) return issue;
    return { ...issue, projectContext: currentProjectContext } as Issue;
  }

  private pollingProjectContextKey(projectContext: ProjectContextResolution | null | undefined): string {
    return this.comparableProjectContextId(projectContext) ?? "__default__";
  }

  private dispatchIssueKey(issueId: string, projectContext: ProjectContextResolution | null | undefined): string {
    return `${this.pollingProjectContextKey(projectContext)}::${issueId}`;
  }

  private isEnabledProjectContext(projectContext: ProjectContextResolution | null | undefined): boolean {
    const currentProjectContext = this.currentProjectContext(projectContext);
    if (!currentProjectContext) return false;
    const projectContextId = this.comparableProjectContextId(currentProjectContext);
    if (!projectContextId) return true;
    return this.config.projectContexts.enabledContexts.some(
      (context) => this.comparableProjectContextId(normalizeProjectContextResolution({ projectContextId: context.id })) === projectContextId,
    );
  }

  private shouldPreserveLifecycleProjectContext(lifecycle: IssueLifecycleRecord): boolean {
    return (
      lifecycle.phase === "implementation" ||
      lifecycle.phase === "merge_conflict_resolution" ||
      lifecycle.phase === "review"
    );
  }

  private async pollingDispatchState(): Promise<{
    projectContexts: Array<ProjectContextResolution | undefined>;
    inProgressIssueContexts: Map<string, ProjectContextResolution>;
    stickyIssueIds: Set<string>;
  }> {
    if (!this.options.trackerResolver) {
      return {
        projectContexts: [undefined],
        inProgressIssueContexts: new Map(),
        stickyIssueIds: new Set(),
      };
    }

    const inProgressIssueContexts = new Map<string, ProjectContextResolution>();
    const stickyIssueIds = new Set<string>();
    const rememberIssueContext = (
      issueId: string,
      projectContext: ProjectContextResolution | null | undefined,
      options?: { requireEnabled?: boolean; sticky?: boolean },
    ): void => {
      const currentProjectContext = this.currentProjectContext(projectContext);
      if (!currentProjectContext) return;
      if (options?.requireEnabled && !this.isEnabledProjectContext(currentProjectContext)) return;
      inProgressIssueContexts.set(issueId, currentProjectContext);
      if (options?.sticky) stickyIssueIds.add(issueId);
    };

    if (this.options.lifecycleStore) {
      try {
        for (const lifecycle of await this.options.lifecycleStore.list()) {
          if (!this.shouldPreserveLifecycleProjectContext(lifecycle)) continue;
          rememberIssueContext(lifecycle.issueId, lifecycle.projectContext, { requireEnabled: true });
        }
      } catch (error) {
        this.options.logger.warn("polling lifecycle context scan failed", { error: errorMessage(error) });
      }
    }

    for (const [issueId, entry] of this.running) {
      rememberIssueContext(issueId, this.resolvedProjectContext(entry), { sticky: true });
    }
    for (const retry of this.retryAttempts.values()) {
      rememberIssueContext(retry.issueId, retry.projectContext, { sticky: true });
    }

    const projectContextsByKey = new Map<string, ProjectContextResolution>();
    const rememberProjectContext = (projectContext: ProjectContextResolution | null | undefined): void => {
      const currentProjectContext = this.currentProjectContext(projectContext);
      if (!currentProjectContext) return;
      projectContextsByKey.set(this.pollingProjectContextKey(currentProjectContext), currentProjectContext);
    };

    for (const context of this.config.projectContexts.enabledContexts) {
      rememberProjectContext(
        normalizeProjectContextResolution({
          projectContextId: context.id,
          projectContextLabel: context.label,
          linearProjectSlug: context.tracker.projectSlug ?? null,
          routingSource: context.source === LEGACY_DEFAULT_PROJECT_CONTEXT_ROUTING_SOURCE ? context.source : "candidate_poll",
        }),
      );
    }
    for (const projectContext of inProgressIssueContexts.values()) {
      rememberProjectContext(projectContext);
    }

    return {
      projectContexts: [...projectContextsByKey.values()],
      inProgressIssueContexts,
      stickyIssueIds,
    };
  }

  private issueWithRequestedProjectContext(issue: Issue, requestedProjectContext?: ProjectContextResolution): Issue {
    return this.issueWithDispatchProjectContext(issue, this.requestedProjectContextForIssue(issue, requestedProjectContext));
  }

  private async fetchCandidateIssuesForProjectContext(projectContext?: ProjectContextResolution): Promise<Issue[]> {
    const tracker = this.trackerClientForProjectContext(projectContext);
    return (await tracker.fetchCandidateIssues()).map((issue) => this.issueWithRequestedProjectContext(issue, projectContext));
  }

  private async fetchIssuesByStatesForProjectContext(
    states: readonly string[],
    projectContext?: ProjectContextResolution,
  ): Promise<Issue[]> {
    const tracker = this.trackerClientForProjectContext(projectContext);
    return (await tracker.fetchIssuesByStates([...states])).map((issue) => this.issueWithRequestedProjectContext(issue, projectContext));
  }

  private async fetchIssueStatesByIdsForProjectContext(
    issueIds: readonly string[],
    projectContext?: ProjectContextResolution,
  ): Promise<Issue[]> {
    const tracker = this.trackerClientForProjectContext(projectContext);
    return (await tracker.fetchIssueStatesByIds([...issueIds])).map((issue) => this.issueWithRequestedProjectContext(issue, projectContext));
  }

  private async fetchPollingIssues(read: (projectContext?: ProjectContextResolution) => Promise<Issue[]>): Promise<Issue[]> {
    const { projectContexts, inProgressIssueContexts, stickyIssueIds } = await this.pollingDispatchState();
    if (projectContexts.length === 0) return [];

    const issues = new Map<string, Issue>();
    for (const projectContext of projectContexts) {
      for (const issue of await read(projectContext)) {
        const persistedProjectContext = inProgressIssueContexts.get(issue.id);
        const requestedProjectContext = this.requestedProjectContextForIssue(issue, projectContext);
        const shouldForcePersistedProjectContext = persistedProjectContext !== undefined && stickyIssueIds.has(issue.id);
        const dispatchIssue = this.issueWithDispatchProjectContext(
          issue,
          shouldForcePersistedProjectContext ? persistedProjectContext : requestedProjectContext ?? persistedProjectContext,
          shouldForcePersistedProjectContext,
        );
        issues.set(this.dispatchIssueKey(issue.id, projectContextResolutionFromIssue(dispatchIssue)), dispatchIssue);
      }
    }
    return [...issues.values()];
  }

  private async fetchIssueStatesByIdsGroupedByProjectContext(
    requests: Array<{ issueId: string; projectContext: ProjectContextResolution | undefined }>,
  ): Promise<Map<string, Issue>> {
    if (requests.length === 0) return new Map();
    if (!this.options.trackerResolver) {
      return new Map(
        (await this.fetchIssueStatesByIdsForProjectContext(
          requests.map((request) => request.issueId),
          undefined,
        )).map((issue) => {
          const dispatchIssue = this.issueWithDispatchProjectContext(issue, this.requestedProjectContextForIssue(issue));
          return [this.dispatchIssueKey(issue.id, projectContextResolutionFromIssue(dispatchIssue)), dispatchIssue];
        }),
      );
    }

    const groupedRequests = new Map<string, { issueIds: string[]; projectContext: ProjectContextResolution | undefined }>();
    for (const request of requests) {
      const key = this.comparableProjectContextId(request.projectContext) ?? "__default__";
      const group = groupedRequests.get(key);
      if (group) {
        group.issueIds.push(request.issueId);
        continue;
      }
      groupedRequests.set(key, { issueIds: [request.issueId], projectContext: request.projectContext });
    }

    const issues = new Map<string, Issue>();
    for (const { issueIds, projectContext } of groupedRequests.values()) {
      for (const issue of await this.fetchIssueStatesByIdsForProjectContext(issueIds, projectContext)) {
        const dispatchIssue = this.issueWithDispatchProjectContext(
          issue,
          this.requestedProjectContextForIssue(issue, projectContext),
          projectContext !== undefined,
        );
        issues.set(this.dispatchIssueKey(issue.id, projectContextResolutionFromIssue(dispatchIssue)), dispatchIssue);
      }
    }
    return issues;
  }

  private configForProjectContext(projectContext?: ProjectContextResolution): ServiceConfig {
    try {
      return resolveServiceConfigForProjectContext(this.config, projectContext);
    } catch (error) {
      if (error instanceof SymphonyError && error.code === "config_validation_error") {
        return this.config;
      }
      throw error;
    }
  }

  private requestedProjectContextForIssue(
    issue: Issue,
    requestedProjectContext?: ProjectContextResolution,
  ): ProjectContextResolution | undefined {
    if (requestedProjectContext) return requestedProjectContext;
    return this.resolvedProjectContextFromIssue(issue);
  }

  private resolvedProjectContextFromIssue(issue: Issue): ProjectContextResolution | undefined {
    const issueProjectContext = projectContextResolutionFromIssue(issue);
    if (this.issueHasExplicitProjectContextProof(issue)) {
      return issueProjectContext ?? undefined;
    }
    const routing = resolveProjectContextForIssue(issue, this.config.projectContexts);
    return routing.kind === "resolved" ? routing.projectContext : undefined;
  }

  private serviceConfigForIssue(issue: Issue, requestedProjectContext?: ProjectContextResolution): ServiceConfig {
    return this.configForProjectContext(this.requestedProjectContextForIssue(issue, requestedProjectContext));
  }

  private serviceConfigForEntry(entry: RunningEntry): ServiceConfig {
    return this.configForProjectContext(this.resolvedProjectContext(entry) ?? undefined);
  }

  private comparableProjectContextId(projectContext?: ProjectContextResolution | null): string | null {
    if (!projectContext) return null;
    const normalizedProjectContextId = normalizeProjectContextId(projectContext.projectContextId);
    return normalizedProjectContextId === LEGACY_DEFAULT_PROJECT_CONTEXT_ID
      ? this.config.projectContexts.defaultContextId
      : normalizedProjectContextId;
  }

  private requestedProjectContextCanProveRouting(projectContext?: ProjectContextResolution): boolean {
    if (!projectContext) return false;
    const requestedProjectSlug = normalizeProjectSlug(projectContext.linearProjectSlug);
    if (requestedProjectSlug === null) return true;
    return (
      this.config.projectContexts.enabledContexts.filter((context) =>
        sameProjectSlug(context.tracker.projectSlug, requestedProjectSlug),
      ).length <= 1
    );
  }

  private issueHasExplicitProjectContextProof(issue: Issue): boolean {
    const candidate = issue as {
      projectContext?: { projectContextId?: unknown } | null;
      projectContextId?: unknown;
    };
    return (
      typeof candidate.projectContext?.projectContextId === "string" || typeof candidate.projectContextId === "string"
    );
  }

  private issueHasProjectContextProof(issue: Issue): boolean {
    return this.resolvedProjectContextFromIssue(issue) !== undefined;
  }

  private issueHasTrackerRoutingProofForProjectContext(
    issue: Issue,
    projectContext: ProjectContextResolution | null | undefined,
  ): boolean {
    if (!projectContext || !this.requestedProjectContextCanProveRouting(projectContext)) return false;
    const routedProjectSlug = normalizeProjectSlug(issue.linearProjectSlug ?? issue.linearProjectIdentity?.slug);
    const projectContextSlug = normalizeProjectSlug(projectContext.linearProjectSlug);
    return routedProjectSlug !== null && projectContextSlug !== null && sameProjectSlug(routedProjectSlug, projectContextSlug);
  }

  private issueMatchesRequestedProjectContext(
    issue: Issue,
    requestedProjectContext?: ProjectContextResolution,
  ): boolean {
    if (!requestedProjectContext) return true;
    const issueProjectContext = this.resolvedProjectContextFromIssue(issue);
    if (!issueProjectContext) return false;
    return this.comparableProjectContextId(issueProjectContext) === this.comparableProjectContextId(requestedProjectContext);
  }

  private canTrustRequestedProjectContextFromTrackerLookup(
    tracker: TrackerClient,
    requestedProjectContext?: ProjectContextResolution,
  ): boolean {
    if (!requestedProjectContext) return true;
    if (!this.requestedProjectContextCanProveRouting(requestedProjectContext)) return false;
    const requestedProjectContextId = this.comparableProjectContextId(requestedProjectContext);
    if (requestedProjectContextId === this.config.projectContexts.defaultContextId) {
      return tracker === this.options.tracker || Boolean(this.options.trackerResolver);
    }
    return Boolean(this.options.trackerResolver && tracker !== this.options.tracker);
  }

  private buildIssueRouteEvidence(input: {
    kind: IssueRouteEvidence["kind"];
    requestKey: string;
    requestedProjectContext?: ProjectContextResolution | undefined;
    resolvedProjectContext?: ProjectContextResolution | null | undefined;
    lookupKey?: string | null | undefined;
    sources: IssueRouteEvidenceSource[];
    status: IssueRouteEvidence["status"];
    reason?: string | null | undefined;
  }): IssueRouteEvidence {
    const trimmedRequestKey = input.requestKey.trim();
    return {
      kind: input.kind,
      requestKey: trimmedRequestKey,
      requestAlias: trimmedRequestKey,
      requestedProjectContextId: input.requestedProjectContext?.projectContextId ?? null,
      resolvedProjectContextId: input.resolvedProjectContext?.projectContextId ?? null,
      lookupKey: input.lookupKey ?? null,
      sources: [...new Set(input.sources)],
      status: input.status,
      reason: input.reason ?? null,
      redacted: true,
    };
  }

  private async resolveTrackedIssue(
    issueIdOrIdentifier: string,
    projectContext: ProjectContextResolution | undefined,
    options: { allowCandidateIdentifierLookup?: boolean; kind: IssueRouteEvidence["kind"] },
  ): Promise<{ issue: Issue | null; routeEvidence: IssueRouteEvidence }> {
    const trimmedRequestKey = issueIdOrIdentifier.trim();
    try {
      const tracker = this.trackerClientForProjectContext(projectContext);
      const trackerLookupProvesRequestedContext = this.canTrustRequestedProjectContextFromTrackerLookup(
        tracker,
        projectContext,
      );
      const direct = (await tracker.fetchIssueStatesByIds([issueIdOrIdentifier]))[0] ?? null;
      const directMatchesRequestedContext = direct !== null && this.issueMatchesRequestedProjectContext(direct, projectContext);
      if (direct && directMatchesRequestedContext) {
        const issue = this.issueWithRequestedProjectContext(direct, projectContext);
        return {
          issue,
          routeEvidence: this.buildIssueRouteEvidence({
            kind: options.kind,
            requestKey: trimmedRequestKey,
            requestedProjectContext: projectContext,
            resolvedProjectContext: this.requestedProjectContextForIssue(issue, projectContext) ?? projectContext,
            lookupKey: issue.id,
            sources: ["tracker_direct"],
            status: "resolved",
          }),
        };
      }
      const mismatchedDirect = direct && !directMatchesRequestedContext ? direct : null;
      if (options.allowCandidateIdentifierLookup !== true) {
        return {
          issue: null,
          routeEvidence: this.buildIssueRouteEvidence({
            kind: options.kind,
            requestKey: trimmedRequestKey,
            requestedProjectContext: projectContext,
            lookupKey: trimmedRequestKey,
            sources: ["tracker_direct"],
            status: "missing",
            reason: "issue_not_found",
          }),
        };
      }
      const matchingCandidates = (await tracker.fetchCandidateIssues()).filter((candidateIssue) => {
        if (candidateIssue.id !== issueIdOrIdentifier && candidateIssue.identifier !== issueIdOrIdentifier) {
          return false;
        }
        return true;
      });
      const candidate = matchingCandidates.find((candidateIssue) => {
        return (
          this.issueMatchesRequestedProjectContext(candidateIssue, projectContext) ||
          (!this.issueHasProjectContextProof(candidateIssue) && trackerLookupProvesRequestedContext)
        );
      });
      if (candidate) {
        const issue = this.issueWithRequestedProjectContext(candidate, projectContext);
        return {
          issue,
          routeEvidence: this.buildIssueRouteEvidence({
            kind: options.kind,
            requestKey: trimmedRequestKey,
            requestedProjectContext: projectContext,
            resolvedProjectContext: this.requestedProjectContextForIssue(issue, projectContext) ?? projectContext,
            lookupKey: issue.id,
            sources: ["tracker_direct", "tracker_candidate"],
            status: "resolved",
            reason: "candidate_identifier_fallback",
          }),
        };
      }
      const mismatchedCandidate = matchingCandidates[0] ?? null;
      const mismatchedIssue = mismatchedCandidate ?? mismatchedDirect;
      if (mismatchedIssue) {
        return {
          issue: null,
          routeEvidence: this.buildIssueRouteEvidence({
            kind: options.kind,
            requestKey: trimmedRequestKey,
            requestedProjectContext: projectContext,
            resolvedProjectContext: this.resolvedProjectContextFromIssue(mismatchedIssue) ?? null,
            lookupKey: mismatchedIssue.id,
            sources: ["tracker_direct", "tracker_candidate"],
            status: "wrong_context",
            reason: mismatchedCandidate ? "candidate_issue_outside_requested_project_context" : "resolved_issue_outside_requested_project_context",
          }),
        };
      }
      return {
        issue: null,
        routeEvidence: this.buildIssueRouteEvidence({
          kind: options.kind,
          requestKey: trimmedRequestKey,
          requestedProjectContext: projectContext,
          lookupKey: trimmedRequestKey,
          sources: ["tracker_direct", "tracker_candidate"],
          status: "missing",
          reason: "issue_not_found",
        }),
      };
    } catch (error) {
      if (error instanceof SymphonyError && error.code === "config_validation_error") {
        return {
          issue: null,
          routeEvidence: this.buildIssueRouteEvidence({
            kind: options.kind,
            requestKey: trimmedRequestKey,
            requestedProjectContext: projectContext,
            resolvedProjectContext: projectContext ?? null,
            lookupKey: trimmedRequestKey,
            sources: [],
            status: "credential_unavailable",
            reason: "resolved_project_context_tracker_unavailable",
          }),
        };
      }
      throw error;
    }
  }

  async resumeApprovedPublication(request: OperatorApprovalRecord): Promise<boolean> {
    if (request.status !== "approved" || !this.options.lifecycleStore) return false;
    const latestIssues = await this.fetchIssueStatesByIdsForProjectContext([request.issueId], request.projectContext);
    const issue = this.issueWithDispatchProjectContext(latestIssues[0] ?? issueFromApprovalRequest(request), request.projectContext, true);
    const publisher =
      this.options.completionReportPublisher ??
      this.defaultGitHubPullRequestClientForCapability(
        "github.publication",
        request.projectContext ?? projectContextResolutionFromIssue(issue) ?? undefined,
      );
    const result = await new CompletionReportService({
      config: this.config,
      lifecycleStore: this.options.lifecycleStore,
      writebackOutbox: new FileWritebackOutboxStore(this.config.workspace.stateDir),
      ...(this.options.runStore === undefined ? {} : { runStore: this.options.runStore }),
      ...(this.options.writeback === undefined ? {} : { writebackProcessor: this.options.writeback }),
      pullRequestPublisher: publisher,
    }).resumeApprovedPublication({ approval: request, issue });
    if (!result) return false;
    return true;
  }

  async recordPublicationApprovalTerminal(request: OperatorApprovalRecord): Promise<boolean> {
    if (!this.options.lifecycleStore) return false;
    const latestIssues = await this.fetchIssueStatesByIdsForProjectContext([request.issueId], request.projectContext);
    const issue = this.issueWithDispatchProjectContext(latestIssues[0] ?? issueFromApprovalRequest(request), request.projectContext, true);
    const result = await new CompletionReportService({
      config: this.config,
      lifecycleStore: this.options.lifecycleStore,
      writebackOutbox: new FileWritebackOutboxStore(this.config.workspace.stateDir),
      ...(this.options.runStore === undefined ? {} : { runStore: this.options.runStore }),
      ...(this.options.writeback === undefined ? {} : { writebackProcessor: this.options.writeback }),
    }).recordPublicationApprovalTerminal({ approval: request, issue });
    if (result.length > 0) return true;
    const lifecycle =
      (await this.options.lifecycleStore.get(request.issueId)) ??
      (request.issueIdentifier ? await this.options.lifecycleStore.get(request.issueIdentifier) : null);
    return lifecycle?.phase === "blocked" && lifecycle.blockedReason === `publication approval ${request.status}`;
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
      statusApiPointers: statusApiPointersForIssue(lifecycle.issueId, runs),
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
        providerGates: this.activeProviderGates.length,
      },
      providerGates: this.activeProviderGates,
      providerGateCounts: {
        active: this.activeProviderGates.length,
        manual: this.activeProviderGates.filter((gate) => gate.resumePolicy === "manual").length,
        autoResume: this.activeProviderGates.filter((gate) => gate.resumePolicy === "auto_at_window_close").length,
      },
      running: [...this.running.entries()].map(([issueId, entry]) => {
        const projectContext = this.resolvedProjectContext(entry);
        return {
          issueId,
          issueIdentifier: entry.issue.identifier,
          role: entry.role,
          runPhase: entry.runPhase,
          runKind: runKindForPhase(entry.runPhase),
          state: entry.issue.state,
          ...(projectContext === undefined ? {} : { projectContext }),
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
          issueDetails: toIssueStatusView(issueWithProjectContext(entry.issue, projectContext ?? null)),
        };
      }),
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
    const exactIssueIdMatch = snapshot.running.find((row) => row.issueId === issueIdOrIdentifier);
    if (exactIssueIdMatch) return exactIssueIdMatch;
    const identifierMatches = snapshot.running.filter((row) => row.issueIdentifier === issueIdOrIdentifier);
    return identifierMatches.length === 1 ? identifierMatches[0] ?? null : null;
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
      const providerGate = await this.activeProviderDispatchGate();
      if (providerGate) {
        this.options.logger.warn("agent dispatch paused by provider limit", {
          gate_id: providerGate.id,
          harness_id: providerGate.scope.harnessId,
          provider_id: providerGate.scope.providerId,
          model: providerGate.scope.model,
          kind: providerGate.kind,
          resume_policy: providerGate.resumePolicy,
          resume_at: providerGate.window?.resumeAt ?? null,
          message: providerGate.message,
        });
        return;
      }
      await this.recoverPendingPublicationApprovalHandoffs();
      const workerCandidates = await this.fetchPollingIssues((projectContext) =>
        this.fetchCandidateIssuesForProjectContext(projectContext),
      );
      for (const issue of sortIssuesForDispatch(workerCandidates)) {
        if (this.availableSlots() <= 0) break;
        await this.tryDispatchWorkerIssue(issue, null);
      }
      const reviewerCandidates = await this.fetchPollingIssues((projectContext) =>
        this.fetchIssuesByStatesForProjectContext(
          this.configForProjectContext(projectContext).reviewLoop.reviewStates,
          projectContext,
        ),
      );
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

  private async refreshProviderGates(): Promise<RuntimeProviderGate[]> {
    try {
      this.activeProviderGates = await this.providerGateStore.listActive(new Date());
    } catch (error) {
      this.options.logger.warn("provider gate refresh failed", { error: errorMessage(error) });
    }
    return this.activeProviderGates;
  }

  private async activeProviderDispatchGate(): Promise<RuntimeProviderGate | null> {
    await this.refreshProviderGates();
    return this.activeProviderGates.find((gate) => this.providerGateMatchesConfiguredRuntime(gate)) ?? null;
  }

  private providerGateMatchesConfiguredRuntime(gate: RuntimeProviderGate): boolean {
    if (gate.scope.harnessId && gate.scope.harnessId !== this.options.harness.id) return false;
    const configuredProvider = runtimeProviderForHarness(this.options.harness.id, this.config);
    if (gate.scope.providerId && configuredProvider && gate.scope.providerId !== configuredProvider) return false;
    const configuredModel = runtimeModelForHarness(this.options.harness.id, this.config);
    if (gate.scope.model && configuredModel && gate.scope.model !== configuredModel) return false;
    return true;
  }

  private async startupCleanup(): Promise<void> {
    try {
      const terminalIssues = await this.fetchPollingIssues((projectContext) =>
        this.fetchIssuesByStatesForProjectContext(this.configForProjectContext(projectContext).tracker.terminalStates, projectContext),
      );
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

    let latestIssuesByScope = new Map<string, Issue>();
    try {
      latestIssuesByScope = await this.fetchIssueStatesByIdsGroupedByProjectContext(
        candidates.map((lifecycle) => ({
          issueId: lifecycle.issueId,
          projectContext: this.currentProjectContext(lifecycle.projectContext) ?? undefined,
        })),
      );
    } catch (error) {
      this.options.logger.warn("pending publication approval recovery issue refresh failed", { error: errorMessage(error) });
    }
    for (const lifecycle of candidates) {
      const issue =
        latestIssuesByScope.get(this.dispatchIssueKey(lifecycle.issueId, lifecycle.projectContext)) ??
        issueFromPendingPublicationLifecycle(lifecycle, this.config.writeback.dispatchState);
      const service = new CompletionReportService({
        config: this.config,
        lifecycleStore: this.options.lifecycleStore,
        writebackOutbox: new FileWritebackOutboxStore(this.config.workspace.stateDir),
        writebackProcessor: this.options.writeback,
        ...(this.options.runStore === undefined ? {} : { runStore: this.options.runStore }),
        pullRequestPublisher:
          this.options.completionReportPublisher ??
          this.defaultGitHubPullRequestClientForCapability(
            "github.publication",
            lifecycle.projectContext ?? projectContextResolutionFromIssue(issue) ?? undefined,
          ),
        operatorApproval: this.options.operatorApproval,
      });
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
    let refreshedByScope: Map<string, Issue>;
    try {
      refreshedByScope = await this.fetchIssueStatesByIdsGroupedByProjectContext(
        [...this.running.entries()].map(([issueId, entry]) => ({
          issueId,
          projectContext: this.resolvedProjectContext(entry) ?? undefined,
        })),
      );
    } catch (error) {
      this.options.logger.warn("running issue refresh failed", { error: errorMessage(error) });
      return;
    }

    for (const [issueId, entry] of this.running) {
      const latest = refreshedByScope.get(this.dispatchIssueKey(issueId, this.resolvedProjectContext(entry)));
      if (!latest) continue;
      entry.issue = latest;
      const config = this.serviceConfigForEntry(entry);
      const preservePendingApprovalWorker =
        entry.role === "worker" && (await this.hasPendingPublicationApprovalHandoff(entry));
      if (isStateIn(latest.state, config.tracker.terminalStates)) {
        await this.terminateRunningIssue(issueId, true, "terminal state");
      } else if (preservePendingApprovalWorker) {
        entry.lastMessage = "Awaiting operator approval for push/PR";
      } else if (entry.role === "worker" && isStateIn(latest.state, config.tracker.handoffStates)) {
        await this.terminateRunningIssue(issueId, false, "handoff state");
      } else if (entry.role === "worker" && !latest.assignedToWorker) {
        await this.terminateRunningIssue(issueId, false, "worker route changed");
      } else if (entry.role === "worker" && !this.isWorkerStateActiveForRunPhase(latest, entry.runPhase, config)) {
        await this.terminateRunningIssue(issueId, false, "non-active state");
      } else if (entry.role === "reviewer" && isStateIn(latest.state, config.reviewLoop.blockedStates)) {
        await this.terminateRunningIssue(issueId, false, "blocked state");
      } else if (entry.role === "reviewer" && !isStateIn(latest.state, config.reviewLoop.reviewStates)) {
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

  private shouldDispatchWorker(
    issue: Issue,
    allowExistingClaim = false,
    runPhase: AgentRunPhase = "implementation",
  ): boolean {
    const config = this.serviceConfigForIssue(issue);
    if (this.running.has(issue.id)) return false;
    if (this.pausedIssues.has(issue.id)) return false;
    if (!allowExistingClaim && this.claimed.has(issue.id)) return false;
    if (!issue.assignedToWorker) return false;
    if (isStateIn(issue.state, config.tracker.handoffStates)) return false;
    if (isStateIn(issue.state, config.reviewLoop.reviewStates)) return false;
    if (isStateIn(issue.state, config.reviewLoop.blockedStates)) return false;
    if (isStateIn(issue.state, config.tracker.terminalStates)) return false;
    if (!this.isWorkerStateActiveForRunPhase(issue, runPhase, config)) return false;
    if (!this.passesLabelGuardrails(issue, config)) return false;
    if (issue.state.toLowerCase() === "todo") {
      if (hasOpenBlocker(issue, config.tracker.terminalStates)) return false;
    }
    return this.hasStateSlot(issue.state);
  }

  private isWorkerStateActiveForRunPhase(
    issue: Issue,
    runPhase: AgentRunPhase,
    config: ServiceConfig = this.serviceConfigForIssue(issue),
  ): boolean {
    if (runPhase === "merge_conflict_resolution") return this.isMergeConflictState(issue.state);
    if (this.isMergeConflictState(issue.state)) return false;
    return isStateIn(issue.state, config.tracker.activeStates);
  }

  private shouldDispatchReviewer(issue: Issue, allowExistingClaim = false): boolean {
    const config = this.serviceConfigForIssue(issue);
    if (this.running.has(issue.id)) return false;
    if (this.pausedIssues.has(issue.id)) return false;
    if (!allowExistingClaim && this.claimed.has(issue.id)) return false;
    if (!isStateIn(issue.state, config.reviewLoop.reviewStates)) return false;
    if (isStateIn(issue.state, config.reviewLoop.blockedStates)) return false;
    if (isStateIn(issue.state, config.tracker.terminalStates)) return false;
    if (!this.passesLabelGuardrails(issue, config)) return false;
    if (hasOpenBlocker(issue, config.tracker.terminalStates)) return false;
    return this.hasStateSlot(issue.state);
  }

  private async lifecycleAllowsDispatch(
    issue: Issue,
    role: AgentRunRole,
    runPhase: AgentRunPhase = role === "reviewer" ? "review" : "implementation",
    projectContext?: ProjectContextResolution,
  ): Promise<boolean> {
    const store = this.options.lifecycleStore;
    if (!store) return true;
    const lifecycle = await store.get(issue.id);
    if (!lifecycle) return true;

    const config = this.configForProjectContext(
      projectContext ?? lifecycle.projectContext ?? projectContextResolutionFromIssue(issue) ?? undefined,
    );
    const phase = phaseForIssueState(issue.state, config);
    const conflict = lifecycle.mergeConflict;
    if (
      conflict &&
      config.mergePolicy.conflictsState !== null &&
      isStateIn(issue.state, [config.mergePolicy.conflictsState]) &&
      (conflict.status === "blocked" || conflict.resolutionStatus === "blocked")
    ) {
      const blockedReason =
        conflict.blockedReason ?? mergeConflictBlockedReason(conflict.fixTurnCount, conflict.maxFixTurns);
      if (lifecycle.phase !== "blocked" || lifecycle.blockedReason !== blockedReason) {
        await store.updateIssue(issue, {
          phase: "blocked",
          blockedReason,
          mergeConflict: { ...conflict, status: "blocked", resolutionStatus: "blocked", blockedReason },
        });
      }
      return false;
    }
    const blockedByLifecycle = lifecycle.phase === "blocked" || lifecycle.blockedReason !== null;
    if (blockedByLifecycle) {
      if (isPendingPublicationApprovalReason(lifecycle.blockedReason)) {
        return false;
      }
      if (config.reviewLoop.blockedStates.length === 0 || isStateIn(issue.state, config.reviewLoop.blockedStates)) {
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
      const issueBreakdownConfig = config;
      if (lifecycle.planningFailureCount >= issueBreakdownConfig.issueBreakdown.maxPlanningFailures) {
        await this.escalateLifecycleBlocked(
          issue,
          lifecycle,
          lifecycle.summaryPointers.lastRunId ?? issue.id,
          maxPlanningFailuresReason(
            lifecycle.planningFailureCount,
            issueBreakdownConfig.issueBreakdown.maxPlanningFailures,
          ),
        );
        return false;
      }
      if (planningBackoffRemainingMs(lifecycle, issueBreakdownConfig) > 0) return false;
    }
    if (role === "worker" && runPhase === "merge_conflict_resolution") {
      if (!conflict || conflict.status !== "open") return false;
      if (conflict.fixTurnCount >= conflict.maxFixTurns) {
        await this.blockMergeConflictAttempts(issue, lifecycle.summaryPointers.lastRunId ?? issue.id, conflict);
        return false;
      }
    }
    if (
      role === "worker" &&
      runPhase === "implementation" &&
      lifecycle.incompleteTurnCount >= config.reviewLoop.maxIncompleteTurns
    ) {
      await this.escalateLifecycleBlocked(
        issue,
        lifecycle,
        lifecycle.summaryPointers.lastRunId ?? issue.id,
        `max incomplete turns reached (${lifecycle.incompleteTurnCount}/${config.reviewLoop.maxIncompleteTurns})`,
      );
      return false;
    }
    if (role === "reviewer" && lifecycle.reviewRound >= config.reviewLoop.maxReviewRounds) {
      await this.escalateLifecycleBlocked(
        issue,
        lifecycle,
        lifecycle.summaryPointers.lastRunId ?? issue.id,
        `max review rounds reached (${lifecycle.reviewRound}/${config.reviewLoop.maxReviewRounds})`,
      );
      return false;
    }

    return true;
  }

  private passesLabelGuardrails(issue: Issue, config: ServiceConfig = this.serviceConfigForIssue(issue)): boolean {
    const labels = new Set(issue.labels.map((label) => label.toLowerCase()));
    if (config.agent.requireLabels.some((label) => !labels.has(label))) return false;
    if (config.agent.excludeLabels.some((label) => labels.has(label))) return false;
    return true;
  }

  private async tryDispatchWorkerIssue(issue: Issue, attempt: number | null, allowExistingClaim = false): Promise<boolean> {
    if (this.availableSlots() <= 0) return false;
    if (await this.activeProviderDispatchGate()) return false;
    const initialRunPhase = this.isMergeConflictState(issue.state) ? "merge_conflict_resolution" : "implementation";
    if (!this.shouldDispatchWorker(issue, allowExistingClaim, initialRunPhase)) return false;

    const requestedProjectContext = this.requestedProjectContextForIssue(issue);
    let refreshed: Issue[];
    try {
      refreshed = await this.fetchIssueStatesByIdsForProjectContext([issue.id], requestedProjectContext);
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
    if (await this.activeProviderDispatchGate()) return false;
    const latestRunPhase = this.isMergeConflictState(latest.state) ? "merge_conflict_resolution" : "implementation";
    if (!this.shouldDispatchWorker(latest, allowExistingClaim, latestRunPhase)) return false;
    const latestProjectContext = this.requestedProjectContextForIssue(latest, requestedProjectContext);

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
    if (!(await this.lifecycleAllowsDispatch(latest, "worker", runPhase, latestProjectContext))) return false;
    const dispatchWriteback =
      runPhase === "implementation"
        ? planDispatchWriteback(latest, this.serviceConfigForIssue(latest, latestProjectContext), latestProjectContext)
        : null;
    if (!(await this.applyWriteback(dispatchWriteback, "dispatch"))) return false;
    const afterWriteback = dispatchWriteback
      ? (await this.fetchIssueStatesByIdsForProjectContext([issue.id], latestProjectContext))[0]
      : latest;
    if (!afterWriteback) return false;
    const afterWritebackProjectContext = this.requestedProjectContextForIssue(afterWriteback, latestProjectContext);
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
    if (!this.shouldDispatchWorker(afterWriteback, allowExistingClaim, runPhase)) return false;
    if (!(await this.lifecycleAllowsDispatch(afterWriteback, "worker", runPhase, afterWritebackProjectContext))) return false;

    this.dispatchIssue(afterWriteback, attempt, "worker", null, runPhase, afterWritebackProjectContext ?? null);
    return true;
  }

  private async tryDispatchReviewerIssue(issue: Issue, allowExistingClaim = false): Promise<boolean> {
    if (this.availableSlots() <= 0) return false;
    if (await this.activeProviderDispatchGate()) return false;
    const requestedProjectContext = this.requestedProjectContextForIssue(issue);
    if (!this.shouldDispatchReviewer(issue, allowExistingClaim)) return false;
    if (!(await this.lifecycleAllowsDispatch(issue, "reviewer", "review", requestedProjectContext))) return false;

    let refreshed: Issue[];
    try {
      refreshed = await this.fetchIssueStatesByIdsForProjectContext([issue.id], requestedProjectContext);
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
    if (await this.activeProviderDispatchGate()) return false;
    const latestProjectContext = this.requestedProjectContextForIssue(latest, requestedProjectContext);
    if (!this.shouldDispatchReviewer(latest, allowExistingClaim)) return false;
    if (!(await this.lifecycleAllowsDispatch(latest, "reviewer", "review", latestProjectContext))) return false;

    const reviewEvidence = await this.loadReviewerDispatchEvidence(latest);
    if (!reviewEvidence) return false;

    this.dispatchIssue(latest, null, "reviewer", reviewEvidence, "review", latestProjectContext ?? null);
    return true;
  }

  private async resolveWorkerDispatchDecision(issue: Issue): Promise<WorkerDispatchDecision> {
    if (this.isMergeConflictState(issue.state)) return { action: "dispatch", runPhase: "merge_conflict_resolution" };
    const config = this.configForProjectContext(this.requestedProjectContextForIssue(issue));
    if (!config.issueBreakdown.enabled) return { action: "dispatch", runPhase: "implementation" };
    if (!this.passesIssueBreakdownRouting(issue, config)) return { action: "dispatch", runPhase: "implementation" };
    if (!this.options.lifecycleStore) return { action: "skip", reason: "planning_required_no_lifecycle_store" };
    const lifecycle = await this.options.lifecycleStore.get(issue.id);
    const plan = latestFreshIssueBreakdownPlan(lifecycle, issue, config);
    if (plan === null) return { action: "dispatch", runPhase: "issue_breakdown" };
    if (config.issueBreakdown.applyToLinear.enabled) {
      return {
        action: "skip",
        reason:
          plan.applicationStatus === "applied"
            ? "issue_breakdown_applied_to_linear"
            : plan.applicationStatus === "blocked"
              ? "issue_breakdown_apply_blocked"
              : "issue_breakdown_apply_required",
      };
    }
    return {
      action: "dispatch",
      runPhase: "implementation",
    };
  }

  private passesIssueBreakdownRouting(issue: Issue, config: ServiceConfig): boolean {
    if (config.issueBreakdown.planningLabels.length === 0) return false;
    const labels = new Set(issue.labels.map((label) => label.toLowerCase()));
    return config.issueBreakdown.planningLabels.some((label) => labels.has(label));
  }

  private isMergeConflictState(_state: string): boolean {
    return false;
  }

  private dispatchIssue(
    issue: Issue,
    attempt: number | null,
    role: AgentRunRole,
    reviewEvidence: ReviewerDispatchEvidence | null,
    runPhase: AgentRunPhase = role === "reviewer" ? "review" : "implementation",
    projectContext: ProjectContextResolution | null = null,
  ): void {
    const abortController = new AbortController();
    const retryAttempt = attempt ?? 0;
    const entry: RunningEntry = {
      issue,
      projectContext,
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
      mergeConflictResolutionAccepted: false,
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
      providerLimitSignal: null,
    };
    this.running.set(issue.id, entry);
    this.claimed.add(issue.id);
    this.clearRetry(issue.id);
    const run = role === "reviewer" ? this.runReviewer(entry) : this.runWorker(entry, attempt);
    const worker = this.monitorRunExit(entry, run);
    entry.worker = worker;
    this.activeWorkers.add(worker);
    void worker.then(
      () => this.activeWorkers.delete(worker),
      () => this.activeWorkers.delete(worker),
    );
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
    let workspaceIssue = issueWithProjectContext(entry.issue, null);
    try {
      entry.lifecycle ??= await this.options.lifecycleStore?.get(entry.issue.id) ?? null;
      const resolvedProjectContext =
        entry.runPhase === "issue_breakdown"
          ? this.resolvedProjectContext(entry) ?? null
          : await this.resolveWorkerProjectContext(entry);
      entry.projectContext = resolvedProjectContext;
      workspaceIssue = issueWithProjectContext(entry.issue, resolvedProjectContext);
      if (
        entry.runPhase !== "issue_breakdown" &&
        entry.lifecycle !== null &&
        (entry.lifecycle.phase === "blocked" || entry.lifecycle.blockedReason !== null)
      ) {
        return;
      }
      workspace =
        entry.runPhase === "issue_breakdown"
          ? await this.options.workspaceManager.createForPlanning(workspaceIssue)
          : await this.options.workspaceManager.createForIssue(workspaceIssue);
      entry.workspacePath = workspace.path;
      entry.workspace = workspace;

      await this.updateLifecycle(
        entry,
        entry.runPhase === "issue_breakdown"
          ? {
              phase: phaseForIssueState(entry.issue.state, this.config),
              ...(resolvedProjectContext === null ? {} : { projectContext: resolvedProjectContext }),
            }
          : {
              phase: phaseForIssueState(entry.issue.state, this.config),
              ...(resolvedProjectContext === null ? {} : { projectContext: resolvedProjectContext }),
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

      if (this.shouldDiscoverPullRequestBeforeFirstWorkerPrompt(entry.lifecycle)) {
        await this.discoverPullRequestForEntry(entry, workspace);
      }

      for (let turnNumber = 1; turnNumber <= this.config.agent.maxTurns; turnNumber += 1) {
        if (entry.abortController.signal.aborted) throw new SymphonyError("agent_error", "Run was cancelled");
        if (turnNumber > 1 && !harnessSupportsContinuation(this.options.harness)) {
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
        if (entry.completionReportAccepted || entry.mergeConflictResolutionAccepted) break;
        if (entry.lifecycle?.phase === "blocked" || entry.lifecycle?.blockedReason !== null) break;

        const refreshed = await this.fetchIssueStatesByIdsForProjectContext(
          [entry.issue.id],
          this.resolvedProjectContext(entry) ?? undefined,
        );
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
          await this.options.workspaceManager.removeForPlanning(workspaceIssue);
        }
        if (entry.cleanupWorkspaceOnExit) await this.options.workspaceManager.removeForIssue(workspaceIssue);
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
      workspace = await this.options.workspaceManager.createForIssue(
        issueWithProjectContext(entry.issue, this.resolvedProjectContext(entry) ?? null),
      );
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
      this.requireMcpHandoff("review");

      const runConfig = this.configForProjectContext(this.resolvedProjectContext(entry));
      entry.turnCount = 1;
      const promptIssue = this.issueWithResolvedProjectContext(entry);
      const prompt = this.formatRenderedReviewerPrompt(
        await this.promptRenderer.render(this.reviewerPromptTemplate(runConfig), {
          issue: promptIssue,
          attempt: null,
          role: "reviewer",
          completionReport: evidence.completionReport,
          acceptanceCriteria: acceptanceCriteriaForReport(evidence.completionReport),
          workspaceEvidence: workspaceEvidenceForReview(entry.issue, workspace, evidence),
          validationEvidence: evidence.completionReport.validationEvidence,
          runDigest: evidence.runDigest,
          reviewerPromptExtensions: runConfig.reviewLoop.reviewerPromptExtensions,
          workerPromptExtensions: runConfig.reviewLoop.workerPromptExtensions,
        }),
        this.renderResolvedProjectContextPrompt(entry),
        {
          issue: promptIssue,
          role: "reviewer",
          workspacePath: workspace.path,
          branchName: workspace.gitBranchName ?? entry.issue.branchName ?? null,
          repoPath: workspace.repoPath ?? null,
          baseRef: workspace.baseRef ?? null,
        },
        runConfig,
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
    for await (const rawEvent of events) {
      const event = sanitizeAgentEventForPublicOutput(rawEvent);
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
        await this.persistHarnessEvent(entry, rawEvent);
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
        const runtimeMetadata = runtimeMetadataForEntry(this.options.harness.id, entry, this.config, event);
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
          projectContext: this.resolvedProjectContext(entry),
          attempt: context.attempt,
          turnNumber: context.turnNumber,
          prompt: context.prompt,
          harnessId: this.options.harness.id,
          ...runtimeMetadata,
          cursorModel: this.config.cursor.model,
          cursorModelParams: this.config.cursor.modelParams,
          cursorSettingSources: this.config.cursor.settingSources,
          cursorMode: effectiveRuntimeModeForEntry(entry, this.config),
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
                projectContext: this.resolvedProjectContext(entry),
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
      if (event.type === "provider_limit") {
        const signal = await this.recordProviderLimitEvent(entry, event.signal, eventAt);
        const runId = entry.activeRunId ?? entry.runId ?? "";
        if (runId.length > 0) {
          await this.updateRunTerminalStateIfRunning(runId, {
            status: "failed",
            completedAt: new Date().toISOString(),
            error: signal.message,
            tokens: entry.activeRunTokens,
            metadata: terminalRunMetadata(entry, "failed"),
          });
        }
        await this.persistHarnessEvent(entry, { ...event, signal });
        throw new SymphonyError("agent_error", signal.message);
      }
      const terminalHarnessEvent = event.type === "completed" || event.type === "failed" || event.type === "cancelled";
      if (!terminalHarnessEvent) await this.persistHarnessEvent(entry, rawEvent);

      if (event.type === "completed") {
        if (entry.runPhase === "issue_breakdown") {
          const accepted = await this.reconcileIssueBreakdownPlanHandoff(entry);
          if (accepted) {
            const terminal = await this.terminalizeAcceptedHandoff(entry, "issue_breakdown_plan");
            await this.persistHarnessEvent(entry, event);
            if (!terminal.updated) return;
            continue;
          }
          const completedAt = new Date().toISOString();
          this.applyPlanningFailureDiagnostic(entry, PLANNING_NO_PLAN_ERROR, new Date(completedAt));
          const terminal = await this.updateRunTerminalStateIfRunning(entry.activeRunId ?? entry.runId ?? "", {
            status: "failed",
            completedAt,
            error: PLANNING_NO_PLAN_ERROR,
            tokens: entry.activeRunTokens,
            metadata: terminalRunMetadata(entry, "failed"),
          });
          await this.persistHarnessEvent(entry, event);
          if (!terminal.updated) return;
          continue;
        }
        const terminal = await this.updateRunTerminalStateIfRunning(entry.activeRunId ?? entry.runId ?? "", {
          status: "succeeded",
          completedAt: new Date().toISOString(),
          tokens: entry.activeRunTokens,
          metadata: terminalRunMetadata(entry, "succeeded"),
        });
        await this.persistHarnessEvent(entry, event);
        if (!terminal.updated) return;
        await this.discoverPullRequestForEntry(entry, context.workspace);
        if (
          entry.role === "worker" &&
          entry.runPhase === "merge_conflict_resolution" &&
          !(await this.reconcileMergeConflictResolutionHandoff(entry))
        ) {
          await this.recordIncompleteTurn(entry);
        } else if (
          entry.role === "worker" &&
          entry.runPhase !== "merge_conflict_resolution" &&
          !(await this.reconcileCompletionReportHandoff(entry)) &&
          !entry.pullRequestHandoffAccepted
        ) {
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
          await this.persistHarnessEvent(entry, event);
          return;
        }
        const acceptedFailedHandoffKind = await this.acceptedTerminalHandoffKind(entry);
        if (acceptedFailedHandoffKind) {
          const terminal = await this.terminalizeAcceptedHandoff(entry, acceptedFailedHandoffKind);
          await this.persistHarnessEvent(entry, event);
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
        await this.persistHarnessEvent(entry, event);
        if (!terminal.updated) return;
        throw new SymphonyError("agent_error", event.error);
      }
      if (event.type === "cancelled") {
        if (
          entry.role === "worker" &&
          entry.runPhase === "issue_breakdown" &&
          (await this.terminalizeAcceptedIssueBreakdownPlan(entry))
        ) {
          await this.persistHarnessEvent(entry, event);
          return;
        }
        const acceptedCancelledHandoffKind = await this.acceptedTerminalHandoffKind(entry);
        if (acceptedCancelledHandoffKind) {
          const terminal = await this.terminalizeAcceptedHandoff(entry, acceptedCancelledHandoffKind);
          await this.persistHarnessEvent(entry, event);
          if (!terminal.updated) return;
          return;
        }
        const terminal = await this.updateRunTerminalStateIfRunning(entry.activeRunId ?? entry.runId ?? "", {
          status: "cancelled",
          completedAt: new Date().toISOString(),
          tokens: entry.activeRunTokens,
          metadata: terminalRunMetadata(entry, "cancelled"),
        });
        await this.persistHarnessEvent(entry, event);
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

  private async recordProviderLimitEvent(
    entry: RunningEntry,
    signal: ProviderLimitSignal,
    observedAt: Date,
  ): Promise<ProviderLimitSignal> {
    const normalized = normalizeProviderLimitSignal(
      {
        ...signal,
        observedAt: signal.observedAt ?? observedAt.toISOString(),
        source: {
          ...(signal.source ?? {}),
          issueId: signal.source?.issueId ?? entry.issue.id,
          issueIdentifier: signal.source?.issueIdentifier ?? entry.issue.identifier,
          runId: signal.source?.runId ?? entry.activeRunId ?? entry.runId,
          sessionId: signal.source?.sessionId ?? entry.sessionId,
          role: signal.source?.role ?? entry.role,
          runPhase: signal.source?.runPhase ?? entry.runPhase,
        },
      },
      {
        harnessId: this.options.harness.id,
        providerId: runtimeProviderForHarness(this.options.harness.id, this.config),
        model: runtimeModelForHarness(this.options.harness.id, this.config),
      },
      observedAt,
    );
    entry.providerLimitSignal = normalized;
    entry.failureKind = "provider_limit";
    entry.failureDiagnosticCode = "provider_limit";
    entry.failureDiagnosticMessage = normalized.message;
    entry.failureDiagnosticAt = observedAt;
    entry.failureDiagnosticPayload = normalized;
    entry.lastMessage = normalized.message;
    const gate = await this.providerGateStore.upsert(normalized);
    await this.refreshProviderGates();
    this.options.logger.warn("provider limit gate recorded", {
      gate_id: gate.id,
      issue_id: entry.issue.id,
      issue_identifier: entry.issue.identifier,
      run_id: normalized.source?.runId ?? null,
      kind: gate.kind,
      harness_id: gate.scope.harnessId,
      provider_id: gate.scope.providerId,
      model: gate.scope.model,
      resume_policy: gate.resumePolicy,
      resume_at: gate.window?.resumeAt ?? null,
    });
    return normalized;
  }

  private applyPlanningFailureDiagnostic(entry: RunningEntry, message: string, at: Date): void {
    entry.failureKind = entry.failureKind ?? PLANNING_FAILURE_DIAGNOSTIC_CODE;
    entry.failureDiagnosticCode = entry.failureDiagnosticCode ?? PLANNING_FAILURE_DIAGNOSTIC_CODE;
    entry.failureDiagnosticMessage = entry.failureDiagnosticMessage ?? message;
    entry.failureDiagnosticAt = entry.failureDiagnosticAt ?? at;
    entry.lastMessage = message;
  }

  private async terminalizeAcceptedIssueBreakdownPlan(entry: RunningEntry): Promise<boolean> {
    const accepted = entry.issueBreakdownPlanAccepted || (await this.reconcileIssueBreakdownPlanHandoff(entry));
    if (!accepted) return false;
    await this.terminalizeAcceptedHandoff(entry, "issue_breakdown_plan");
    return true;
  }

  private async acceptedTerminalHandoffKind(entry: RunningEntry): Promise<AcceptedHandoffKind | null> {
    if (entry.role !== "worker") return null;
    if (entry.runPhase === "issue_breakdown") {
      return entry.issueBreakdownPlanAccepted || (await this.reconcileIssueBreakdownPlanHandoff(entry))
        ? "issue_breakdown_plan"
        : null;
    }
    if (entry.runPhase === "merge_conflict_resolution") {
      return entry.mergeConflictResolutionAccepted || (await this.reconcileMergeConflictResolutionHandoff(entry))
        ? "merge_conflict_resolution"
        : null;
    }
    return (await this.reconcileCompletionReportHandoff(entry)) || entry.completionReportAccepted || entry.pullRequestHandoffAccepted
      ? this.acceptedImplementationHandoffKind(entry)
      : null;
  }

  private acceptedImplementationHandoffKind(_entry: RunningEntry): AcceptedHandoffKind {
    return this.config.github.prHandoff.enabled ? "pull_request_handoff" : "completion_report";
  }

  private async terminalizeAcceptedHandoff(entry: RunningEntry, kind: AcceptedHandoffKind): Promise<TerminalUpdateResult> {
    const runId = entry.activeRunId ?? entry.runId ?? "";
    if (runId.length === 0) return { updated: true, record: null };
    const completedAt = new Date().toISOString();
    const metadata = terminalRunMetadata(entry, "succeeded");
    const terminal = await this.updateRunTerminalStateIfRunning(runId, {
      status: "succeeded",
      completedAt,
      tokens: entry.activeRunTokens,
      metadata,
    });
    if (terminal.updated) {
      await this.options.runStore?.appendEvent({
        runId,
        at: completedAt,
        source: "orchestrator",
        eventType: "handoff_terminal",
        message: `Accepted ${formatAcceptedHandoffKind(kind)} handoff terminalized run as succeeded`,
        payload: {
          kind,
          status: "succeeded",
          tokens: entry.activeRunTokens,
          ...metadata,
        },
      });
    }
    return terminal;
  }

  private async onWorkerExit(issueId: string, kind: "normal" | "abnormal", error: string | null): Promise<void> {
    const entry = this.running.get(issueId);
    if (!entry) return;
    this.running.delete(issueId);
    this.endedRuntimeSeconds += (Date.now() - entry.startedAt.getTime()) / 1000;

    if (entry.providerLimitSignal) {
      this.claimed.delete(issueId);
      return;
    }

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

    if (
      entry.role === "worker" &&
      (((entry.runPhase === "merge_conflict_resolution" && (await this.reconcileMergeConflictResolutionHandoff(entry))) ||
        (entry.runPhase !== "merge_conflict_resolution" &&
          ((await this.reconcileCompletionReportHandoff(entry)) || entry.pullRequestHandoffAccepted))))
    ) {
      if (entry.runId) {
        const terminal = await this.terminalizeAcceptedHandoff(
          entry,
          entry.runPhase === "merge_conflict_resolution" ? "merge_conflict_resolution" : this.acceptedImplementationHandoffKind(entry),
        );
        if (!terminal.updated) {
          if (entry.runPhase !== "merge_conflict_resolution") {
            this.claimed.delete(issueId);
            return;
          }
        }
      }
      if (entry.runPhase !== "merge_conflict_resolution") {
        this.completed.add(issueId);
      }
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
        if (!terminal.updated && entry.runPhase !== "merge_conflict_resolution") {
          this.claimed.delete(issueId);
          return;
        }
      }
      if (entry.runPhase !== "merge_conflict_resolution") {
        this.completed.add(issueId);
      }
      if (entry.role === "reviewer") {
        await this.reconcileReviewVerdictHandoff(entry);
        this.claimed.delete(issueId);
        return;
      }
      if (entry.lifecycle?.phase === "blocked" || entry.lifecycle?.blockedReason !== null) {
        this.claimed.delete(issueId);
        return;
      }
      if (entry.runPhase === "merge_conflict_resolution") {
        if (await this.shouldScheduleContinuation(entry)) {
          this.scheduleRetry(
            issueId,
            entry.issue.identifier,
            1,
            1_000,
            null,
            entry.runPhase,
            this.resolvedProjectContext(entry) ?? undefined,
          );
        } else {
          this.claimed.delete(issueId);
        }
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
        this.scheduleRetry(
          issueId,
          entry.issue.identifier,
          1,
          1_000,
          null,
          entry.runPhase,
          this.resolvedProjectContext(entry) ?? undefined,
        );
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
      if (entry.runPhase === "merge_conflict_resolution") {
        await this.recordMergeConflictAttempt(entry, error ?? "conflict-fix run failed before reporting resolution");
        if (entry.lifecycle?.phase === "blocked" || entry.lifecycle?.blockedReason !== null) {
          this.claimed.delete(issueId);
          return;
        }
      }
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
      const infraFailures = await this.consecutiveInfraFailures(entry.issue);
      if (infraFailures >= this.config.agent.maxInfraFailures) {
        await this.escalateEntryBlocked(
          entry,
          `consecutive harness infrastructure failures reached limit (${infraFailures} failures; max_infra_failures=${this.config.agent.maxInfraFailures})`,
        );
        this.claimed.delete(issueId);
        return;
      }
      const nextAttempt = Math.max(entry.retryAttempt + 1, 1);
      const delayMs = Math.min(10_000 * 2 ** (nextAttempt - 1), this.config.agent.maxRetryBackoffMs);
      this.scheduleRetry(
        issueId,
        entry.issue.identifier,
        nextAttempt,
        delayMs,
        error,
        entry.runPhase,
        this.resolvedProjectContext(entry) ?? undefined,
      );
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
    const failureMessage = error ?? "Planning run failed";
    this.applyPlanningFailureDiagnostic(entry, failureMessage, new Date(now));
    await this.updateRunTerminalStateIfRunning(runId, {
      status: "failed",
      completedAt: now,
      error: failureMessage,
      tokens: entry.activeRunTokens,
      metadata: terminalRunMetadata(entry, "failed"),
    });
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
      eventType: PLANNING_FAILURE_DIAGNOSTIC_CODE,
      message: failureMessage,
      payload: {
        status: "failed",
        error: failureMessage,
        tokens: entry.activeRunTokens,
        planningFailureCount: nextCount,
        ...terminalRunMetadata(entry, "failed"),
      },
    });

    const maxFailures = this.config.issueBreakdown.maxPlanningFailures;
    if (nextCount >= maxFailures) {
      await this.escalateLifecycleBlocked(entry.issue, lifecycle, runId, maxPlanningFailuresReason(nextCount, maxFailures));
      this.clearRetry(issueId);
      this.claimed.delete(issueId);
      return;
    }

    const delayMs = planningRetryDelayMs(nextCount, this.config);
    this.scheduleRetry(
      issueId,
      entry.issue.identifier,
      nextCount,
      delayMs,
      error,
      "issue_breakdown",
      this.resolvedProjectContext(entry) ?? undefined,
    );
  }

  private async consecutiveSdkErrorFailures(issue: Issue): Promise<number> {
    const lookupOptions = projectContextLookupOptions(projectContextResolutionFromIssue(issue));
    const runs = (await this.options.runStore?.listRunsForIssue(issue.id, lookupOptions)) ?? [];
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

  private async consecutiveInfraFailures(issue: Issue): Promise<number> {
    const lookupOptions = projectContextLookupOptions(projectContextResolutionFromIssue(issue));
    const runs = (await this.options.runStore?.listRunsForIssue(issue.id, lookupOptions)) ?? [];
    const seen = new Set<string>();
    const workerRuns = runs
      .filter((run) => run.role === "worker" && !seen.has(run.runId) && seen.add(run.runId))
      .sort(compareRunChronology);
    let count = 0;
    for (const run of workerRuns.slice().reverse()) {
      if (!isCountedInfraFailure(run)) break;
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
      refreshed = await this.fetchIssueStatesByIdsForProjectContext(
        [entry.issue.id],
        this.resolvedProjectContext(entry) ?? undefined,
      );
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
    return this.shouldDispatchWorker(latest, true, entry.runPhase);
  }

  private scheduleRetry(
    issueId: string,
    identifier: string,
    attempt: number,
    delayMs: number,
    error: string | null,
    runPhase: AgentRunPhase = "implementation",
    projectContext: ProjectContextResolution | undefined = undefined,
  ): void {
    this.clearRetry(issueId);
    if (this.stopped) {
      this.claimed.delete(issueId);
      return;
    }
    const dueAtMs = Date.now() + delayMs;
    const timer = setTimeout(() => {
      void this.onRetryTimer(issueId);
    }, delayMs);
    this.retryAttempts.set(issueId, { issueId, identifier, attempt, dueAtMs, timer, error, runPhase, projectContext });
  }

  private async onRetryTimer(issueId: string): Promise<void> {
    const retry = this.retryAttempts.get(issueId);
    if (!retry) return;
    this.retryAttempts.delete(issueId);
    try {
      const providerGate = await this.activeProviderDispatchGate();
      if (providerGate) {
        const delayMs = providerLimitDelayMs(providerGate) ?? this.config.polling.intervalMs;
        this.scheduleRetry(
          issueId,
          retry.identifier,
          retry.attempt,
          Math.max(delayMs, this.config.polling.intervalMs),
          retry.error ?? providerGateDispatchBlockedMessage(providerGate),
          retry.runPhase,
          retry.projectContext,
        );
        return;
      }
      const candidates =
        retry.runPhase === "merge_conflict_resolution"
          ? await this.fetchIssueStatesByIdsForProjectContext([issueId], retry.projectContext)
          : await this.fetchCandidateIssuesForProjectContext(retry.projectContext);
      const issue = candidates.find((candidate) => candidate.id === issueId);
      if (!issue) {
        this.claimed.delete(issueId);
        return;
      }
      const retryProjectContext = this.requestedProjectContextForIssue(issue, retry.projectContext);
      if (retry.runPhase === "issue_breakdown") {
        const remainingMs = await this.planningBackoffRemainingForIssue(issue);
        if (remainingMs > 0) {
          this.scheduleRetry(issueId, retry.identifier, retry.attempt, remainingMs, retry.error, retry.runPhase, retryProjectContext);
          return;
        }
      }
      if (this.availableSlots() <= 0) {
        if (retry.runPhase === "issue_breakdown") {
          await this.recordPlanningDispatchRetry(issue, retry, "no available orchestrator slots");
        } else {
          this.scheduleRetry(
            issueId,
            retry.identifier,
            retry.attempt + 1,
            1_000,
            "no available orchestrator slots",
            retry.runPhase,
            retryProjectContext,
          );
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
      this.scheduleRetry(
        issueId,
        retry.identifier,
        retry.attempt + 1,
        1_000,
        errorMessage(error),
        retry.runPhase,
        retry.projectContext,
      );
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
        this.scheduleRetry(issue.id, retry.identifier, retry.attempt, remainingMs, retry.error, retry.runPhase, retry.projectContext);
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
    this.scheduleRetry(issue.id, retry.identifier, retry.attempt + 1, delayMs, error, retry.runPhase, retry.projectContext);
  }

  private clearRetry(issueId: string): void {
    const existing = this.retryAttempts.get(issueId);
    if (!existing) return;
    clearTimeout(existing.timer);
    this.retryAttempts.delete(issueId);
  }

  private defaultGitHubPullRequestClientForCapability(
    capability: "github.discovery" | "github.publication" | "github.review_evidence_read",
    projectContext: ProjectContextResolution | undefined,
  ) {
    return createGitHubPullRequestClientForCapability(
      this.config,
      capability,
      undefined,
      projectContext === undefined ? {} : { projectContext },
    );
  }

  private resolvedProjectContext(entry: RunningEntry): ProjectContextResolution | undefined {
    const resolvedFromLifecycleOrIssue =
      entry.projectContext ?? entry.lifecycle?.projectContext ?? projectContextResolutionFromIssue(entry.issue);
    const defaultContext = this.config.projectContexts.defaultContext;

    if (resolvedFromLifecycleOrIssue) {
      if (
        defaultContext.source === LEGACY_DEFAULT_PROJECT_CONTEXT_ROUTING_SOURCE &&
        resolvedFromLifecycleOrIssue.projectContextId === defaultContext.id &&
        resolvedFromLifecycleOrIssue.routingSource === LEGACY_DEFAULT_PROJECT_CONTEXT_ROUTING_SOURCE &&
        resolvedFromLifecycleOrIssue.linearProjectSlug === null
      ) {
        return {
          ...resolvedFromLifecycleOrIssue,
          linearProjectSlug: defaultContext.tracker.projectSlug,
        };
      }
      return resolvedFromLifecycleOrIssue;
    }

    if (defaultContext.source !== LEGACY_DEFAULT_PROJECT_CONTEXT_ROUTING_SOURCE) return undefined;

    return {
      projectContextId: defaultContext.id,
      projectContextLabel: defaultContext.label,
      linearProjectSlug: defaultContext.tracker.projectSlug,
      routingSource: LEGACY_DEFAULT_PROJECT_CONTEXT_ROUTING_SOURCE,
    };
  }

  private async resolveWorkerProjectContext(entry: RunningEntry): Promise<ProjectContextResolution | null> {
    const persistedOrIssueResolution = this.resolvedProjectContext(entry) ?? null;
    const usesConfiguredRouting =
      entry.runPhase !== "merge_conflict_resolution" &&
      this.config.projectContexts.contexts.some((context) => context.source === "explicit");
    if (!usesConfiguredRouting) {
      return persistedOrIssueResolution;
    }

    const persistedContextForRouting = this.issueHasTrackerRoutingProofForProjectContext(entry.issue, entry.projectContext)
      ? undefined
      : entry.lifecycle?.projectContext;
    const routing = resolveProjectContextForIssue(
      entry.issue,
      this.config.projectContexts,
      persistedContextForRouting === undefined ? {} : { persistedContext: persistedContextForRouting },
    );
    if (routing.kind === "resolved") {
      return routing.projectContext;
    }
    if (!this.options.lifecycleStore) {
      entry.suppressRetryOnExit = true;
      throw new SymphonyError("agent_error", routing.problem.safeMessage);
    }

    entry.lifecycle = await this.options.lifecycleStore.updateIssue(entry.issue, {
      phase: phaseForIssueState(entry.issue.state, this.config),
      ...(persistedOrIssueResolution === null ? {} : { projectContext: persistedOrIssueResolution }),
    });
    await this.escalateEntryBlocked(entry, routing.problem.safeMessage);
    return null;
  }

  private issueWithResolvedProjectContext(entry: RunningEntry): Issue {
    return issueWithProjectContext(entry.issue, this.resolvedProjectContext(entry) ?? null);
  }

  private renderResolvedProjectContextPrompt(entry: RunningEntry): string | null {
    const projectContext = this.resolvedProjectContext(entry);
    if (!projectContext) return null;
    return [
      "",
      "Service-resolved project context:",
      "- This context is selected by Symphony routing before dispatch and is authoritative for this run.",
      "- Use it when interpreting repository, workspace, and review scope, but do not alter, overwrite, or invent project-context values.",
      `- Project context id: ${projectContext.projectContextId}`,
      `- Label: ${projectContext.projectContextLabel}`,
      `- Linear project slug: ${projectContext.linearProjectSlug ?? "n/a"}`,
      `- Routing source: ${projectContext.routingSource}`,
    ].join("\n");
  }

  private buildRunContext(
    entry: RunningEntry,
    workspace: Workspace,
    attempt: number | null,
    turnNumber: number,
  ) {
    const projectContext = this.resolvedProjectContext(entry);
    const config = this.configForProjectContext(projectContext);
    return {
      issue: issueWithProjectContext(entry.issue, projectContext ?? null),
      projectContext,
      role: entry.role,
      runPhase: entry.runPhase,
      attempt,
      workspace,
      config,
      turnNumber,
      ...(entry.runPhase === "issue_breakdown" ? { runModeOverride: config.issueBreakdown.cursorMode } : {}),
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
    const runId = event.type === "run_status" ? event.runId : (entry.activeRunId ?? entry.runId);
    if (!runId) return;
    await this.options.runStore?.appendEvent({
      runId,
      at: new Date(event.at ?? Date.now()).toISOString(),
      source: "harness",
      ...mapAgentEventToRunActivityEvent(event),
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
    if (entry.runPhase === "merge_conflict_resolution") {
      await this.recordMergeConflictAttempt(entry, "conflict-fix run ended without submit_merge_conflict_resolution");
      return;
    }
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

  private async recordMergeConflictAttempt(entry: RunningEntry, reason: string): Promise<void> {
    const store = this.options.lifecycleStore;
    if (!store) return;
    const runId = entry.activeRunId ?? entry.runId ?? entry.issue.id;
    const lifecycle = (await store.get(entry.issue.id)) ?? entry.lifecycle;
    const conflict = lifecycle?.mergeConflict ?? null;
    if (!lifecycle || !conflict || conflict.status !== "open") return;
    if (conflict.attemptRunIds.includes(runId)) {
      entry.lifecycle = lifecycle;
      return;
    }
    const fixTurnCount = conflict.fixTurnCount + 1;
    const attemptRunIds = [...conflict.attemptRunIds, runId];
    const nextConflict: IssueMergeConflictMetadata = {
      ...conflict,
      resolutionStatus: fixTurnCount >= conflict.maxFixTurns ? "blocked" : "still_conflicted",
      status: fixTurnCount >= conflict.maxFixTurns ? "blocked" : "open",
      updatedAt: new Date().toISOString(),
      fixTurnCount,
      lastConflictFixRunId: runId,
      attemptRunIds,
      blockedAt: fixTurnCount >= conflict.maxFixTurns ? new Date().toISOString() : conflict.blockedAt,
      blockedReason: fixTurnCount >= conflict.maxFixTurns ? mergeConflictBlockedReason(fixTurnCount, conflict.maxFixTurns) : null,
    };
    entry.lifecycle = await store.updateIssue(entry.issue, {
      phase: nextConflict.status === "blocked" ? "blocked" : "merge_conflict_resolution",
      blockedReason: nextConflict.blockedReason,
      mergeConflict: nextConflict,
    });
    if (nextConflict.status === "blocked") {
      await this.applyMergeConflictBlockedWritebacks(entry.issue, runId, nextConflict, reason);
      this.clearRetry(entry.issue.id);
    }
  }

  private async blockMergeConflictAttempts(
    issue: Issue,
    runId: string,
    conflict: IssueMergeConflictMetadata,
  ): Promise<void> {
    const blockedConflict: IssueMergeConflictMetadata = {
      ...conflict,
      status: "blocked",
      resolutionStatus: "blocked",
      blockedAt: conflict.blockedAt ?? new Date().toISOString(),
      blockedReason: conflict.blockedReason ?? mergeConflictBlockedReason(conflict.fixTurnCount, conflict.maxFixTurns),
    };
    await this.options.lifecycleStore?.updateIssue(issue, {
      phase: "blocked",
      blockedReason: blockedConflict.blockedReason,
      mergeConflict: blockedConflict,
    });
    await this.applyMergeConflictBlockedWritebacks(issue, runId, blockedConflict, "conflict-fix attempt limit reached");
  }

  private async applyMergeConflictBlockedWritebacks(
    issue: Issue,
    runId: string,
    conflict: IssueMergeConflictMetadata,
    reason: string,
  ): Promise<void> {
    await this.applyWritebacks(
      planBlockedEscalationWritebacks(
        {
          issue,
          runId,
          reason: conflict.blockedReason ?? reason,
          requiredAction: [
            "Merge conflicts remain unresolved after the configured conflict-fix attempts.",
            `Pull request: ${formatPullRequest(conflict.pullRequest.number, conflict.pullRequest.url)}`,
            `Approved head SHA: ${conflict.approvedHeadSha}`,
            `Latest conflict head SHA: ${conflict.currentHeadSha}`,
            `Conflict-fix attempts: ${conflict.fixTurnCount}/${conflict.maxFixTurns}`,
            "Resolve the conflicts manually or reset approval before returning the issue to Symphony.",
          ].join("\n"),
        },
        this.config,
      ),
      "merge conflict blocked escalation",
    );
  }

  private async refreshEntryIssue(entry: RunningEntry, reason: string): Promise<boolean> {
    try {
      const refreshed = await this.fetchIssueStatesByIdsForProjectContext(
        [entry.issue.id],
        this.resolvedProjectContext(entry) ?? undefined,
      );
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

  private async reconcileMergeConflictResolutionHandoff(entry: RunningEntry): Promise<boolean> {
    const store = this.options.lifecycleStore;
    const runId = entry.activeRunId ?? entry.runId;
    if (!store || !runId) return entry.mergeConflictResolutionAccepted;

    const lifecycle = await store.get(entry.issue.id);
    const report = lifecycle?.mergeConflictResolutionReports.find((item) => item.runId === runId) ?? null;
    if (!lifecycle || !report) return entry.mergeConflictResolutionAccepted;

    entry.lifecycle = lifecycle;
    entry.mergeConflictResolutionAccepted = true;

    if (this.options.writeback) {
      await this.options.writeback.processDue();
    } else if (this.config.writeback.enabled) {
      this.options.logger.warn("merge conflict resolution accepted but writeback processor is not configured", {
        issue_id: entry.issue.id,
        issue_identifier: entry.issue.identifier,
        run_id: runId,
        report_id: report.id,
      });
    }

    if (report.resolutionStatus === "resolved") {
      await this.tryReconcileMergePolicy(entry.issue, this.resolvedProjectContext(entry) ?? undefined);
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

    if (verdict.verdict === "pass") {
      await this.tryReconcileMergePolicy(entry.issue, this.resolvedProjectContext(entry) ?? undefined);
    }
    return true;
  }

  private async reconcileMergePolicyIssues(): Promise<void> {
    let candidates: Issue[];
    try {
      candidates = await this.fetchPollingIssues((projectContext) => {
        const config = this.configForProjectContext(projectContext);
        if (config.mergePolicy.mode !== "gated" || config.mergePolicy.sourceStates.length === 0) return Promise.resolve([]);
        const states = [
          ...config.mergePolicy.sourceStates,
          ...(config.mergePolicy.conflictsState === null ? [] : [config.mergePolicy.conflictsState]),
        ];
        return this.fetchIssuesByStatesForProjectContext(uniqueStateNames(states), projectContext);
      });
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

  private async tryReconcileMergePolicy(
    issue: Issue,
    requestedProjectContext?: ProjectContextResolution,
  ): Promise<void> {
    const projectContext = this.requestedProjectContextForIssue(issue, requestedProjectContext);
    const config = this.configForProjectContext(projectContext);
    if (config.mergePolicy.mode !== "gated" || !this.options.lifecycleStore) return;
    try {
      const service = new MergePolicyService({
        config,
        tracker: this.trackerClientForProjectContext(projectContext),
        lifecycleStore: this.options.lifecycleStore,
        ...(this.options.runStore === undefined ? {} : { runStore: this.options.runStore }),
        ...(this.options.writeback === undefined ? {} : { writeback: this.options.writeback }),
        ...(this.options.pullRequestMergeClient === undefined ? {} : { client: this.options.pullRequestMergeClient }),
        logger: this.options.logger,
      });
      const result = await service.reconcileIssue(this.issueWithDispatchProjectContext(issue, projectContext, projectContext !== undefined));
      if (result.status === "merged" || result.status === "already_merged") {
        this.options.logger.info("merge policy reconciled issue", {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          status: result.status,
          merge_id: result.merge.id,
        });
      } else if (result.status === "blocked_conflicts") {
        this.options.logger.info("merge policy blocked on conflicts", {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          status: result.status,
          head_sha: result.headSha,
          mergeable_state: result.mergeableState,
        });
      } else if (result.status !== "skipped") {
        this.options.logger.info("merge policy reconciled issue", {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          status: result.status,
          merge_gate_id: result.gate.id,
          pr_number: result.gate.pullRequest.number,
          head_sha: result.gate.headSha,
          failed_checks: result.gate.failedChecks.map((check) => check.name),
          pending_checks: result.gate.pendingChecks.map((check) => check.name),
          missing_checks: result.gate.missingChecks.map((check) => check.name),
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
    entry.lifecycle = await store.updateIssue(entry.issue, {
      ...patch,
      projectContext: patch.projectContext ?? this.resolvedProjectContext(entry),
    });
    await appendLaneMemoTelemetry(this.options.runStore, entry.activeRunId, entry.lifecycle, "orchestrator_update");
  }

  private shouldDiscoverPullRequestBeforeFirstWorkerPrompt(lifecycle: IssueLifecycleRecord | null | undefined): boolean {
    const gate = lifecycle?.mergeGate ?? null;
    return gate?.status === "repair_dispatched" || gate?.status === "blocked";
  }

  private async discoverPullRequestForEntry(entry: RunningEntry, workspace: Workspace): Promise<void> {
    const branchName = workspace.gitBranchName ?? entry.issue.branchName;
    if (!branchName) return;

    let pullRequest: DiscoveredPullRequest | null;
    try {
      const client =
        this.options.pullRequestClient ??
        this.defaultGitHubPullRequestClientForCapability("github.discovery", this.resolvedProjectContext(entry));
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
    const staleGatePatch = entry.lifecycle
      ? staleMergeGateLifecyclePatch(entry.lifecycle, metadata.prHeadSha, metadata.prNumber)
      : null;
    if (staleGatePatch) {
      await this.updateLifecycle(entry, {
        ...staleGatePatch,
        blockedReason: null,
      });
    }

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

  private reviewerPromptTemplate(config: ServiceConfig = this.config): string {
    const configured = config.reviewLoop.reviewerPromptTemplate;
    if (configured !== null && configured.trim().length > 0) return configured;
    return DEFAULT_REVIEWER_PROMPT_TEMPLATE;
  }

  private formatRenderedReviewerPrompt(
    prompt: string,
    projectContextPrompt: string | null,
    mcpHandoff: Parameters<typeof renderReviewMcpHandoffPrompt>[0],
    config: ServiceConfig = this.config,
  ): string {
    const configured = config.reviewLoop.reviewerPromptTemplate;
    if (configured !== null && configured.trim().length > 0) {
      return [prompt, projectContextPrompt, renderReviewMcpHandoffPrompt(mcpHandoff)]
        .filter((item): item is string => item !== null && item.length > 0)
        .join("\n")
        .trim();
    }
    const rendered = prompt
      .replace(
        PROJECT_REVIEWER_PROMPT_EXTENSIONS_MARKER,
        formatPromptExtensions("Project-specific reviewer extensions:", config.reviewLoop.reviewerPromptExtensions) ?? "",
      )
      .trim();
    return [rendered, projectContextPrompt, renderReviewMcpHandoffPrompt(mcpHandoff)]
      .filter((item): item is string => item !== null && item.length > 0)
      .join("\n")
      .trim();
  }

  private async renderWorkerPrompt(entry: RunningEntry, attempt: number | null): Promise<string> {
    if (entry.runPhase === "merge_conflict_resolution") return this.renderMergeConflictResolutionPrompt(entry);
    const runConfig = this.configForProjectContext(this.resolvedProjectContext(entry));
    const basePrompt = await this.promptRenderer.render(this.promptTemplate, {
      issue: this.issueWithResolvedProjectContext(entry),
      attempt,
      reviewerPromptExtensions: runConfig.reviewLoop.reviewerPromptExtensions,
      workerPromptExtensions: runConfig.reviewLoop.workerPromptExtensions,
    });
    const projectContextPrompt = this.renderResolvedProjectContextPrompt(entry);
    const issueBreakdownPlan = await this.loadIssueBreakdownPlanPrompt(entry);
    const runtimeSourceScope = this.renderRuntimeSourceScopePrompt(entry.issue);
    const reviewHardening = this.workerReviewHardeningPrompt(runConfig);
    const reviewEvidence = await this.loadWorkerReviewEvidencePrompt(entry);
    const handoff = await this.loadWorkerHandoffPrompt(entry);
    const mergeGateResult = await this.loadWorkerMergeGatePromptResult(entry);
    const mergeGate = mergeGateResult?.text ?? null;
    const reviewVerdict = mergeGateResult?.kind === "repair" ? null : await this.loadWorkerReviewVerdictPrompt(entry);
    return [
      basePrompt,
      projectContextPrompt,
      issueBreakdownPlan,
      runtimeSourceScope,
      reviewHardening,
      handoff,
      this.workerMcpPrompt(entry),
      mergeGate,
      reviewVerdict,
      reviewEvidence,
    ]
      .filter((item): item is string => item !== null)
      .join("\n");
  }

  private async renderIssueBreakdownPrompt(entry: RunningEntry, attempt: number | null): Promise<string> {
    const config = this.configForProjectContext(this.resolvedProjectContext(entry));
    const basePrompt = await this.promptRenderer.render(config.issueBreakdown.promptTemplate, {
      issue: this.issueWithResolvedProjectContext(entry),
      attempt,
    });
    return [basePrompt, this.renderResolvedProjectContextPrompt(entry), this.issueBreakdownMcpPrompt(entry)]
      .filter((item): item is string => item !== null)
      .join("\n");
  }

  private async renderMergeConflictResolutionPrompt(entry: RunningEntry): Promise<string> {
    const lifecycle = await this.options.lifecycleStore?.get(entry.issue.id);
    const conflict = lifecycle?.mergeConflict ?? null;
    const workspace = entry.workspace;
    return [
      `Resolve merge conflicts for ${entry.issue.identifier}: ${entry.issue.title}`,
      "",
      "You are a scoped Symphony conflict-fix worker. Only resolve the merge conflict on the existing lifecycle-bound pull request.",
      "Do not perform unrelated implementation work, request review, move Linear state, or call submit_completion_report.",
      this.renderResolvedProjectContextPrompt(entry),
      "",
      "Conflict metadata:",
      `- Pull request: ${formatPullRequest(conflict?.pullRequest.number ?? null, conflict?.pullRequest.url ?? null)}`,
      `- Approved head SHA: ${conflict?.approvedHeadSha ?? "n/a"}`,
      `- Current conflict head SHA: ${conflict?.currentHeadSha ?? "n/a"}`,
      `- Base branch: ${conflict?.baseBranch ?? "n/a"}`,
      `- Base head SHA: ${conflict?.baseHeadSha ?? "n/a"}`,
      `- Attempts: ${conflict?.fixTurnCount ?? 0} / ${conflict?.maxFixTurns ?? this.config.mergePolicy.maxConflictFixTurns}`,
      `- Reason: ${conflict?.reason ?? "n/a"}`,
      `- GitHub mergeable_state: ${conflict?.mergeableState ?? "unknown"}`,
      "- Required handoff: call submit_merge_conflict_resolution before ending the run.",
      "- Report resolutionStatus=\"resolved\", resolutionStatus=\"still_conflicted\", or resolutionStatus=\"blocked\"; include previousHeadSha, newHeadSha, baseBranch, and baseHeadSha.",
      "",
      "Workspace:",
      `- Path: ${workspace?.path ?? entry.workspacePath ?? "n/a"}`,
      `- Branch: ${workspace?.gitBranchName ?? entry.issue.branchName ?? "n/a"}`,
      `- Base ref: ${workspace?.baseRef ?? "n/a"}`,
      this.mergeConflictResolutionMcpPrompt(entry),
    ]
      .filter((item): item is string => item !== null)
      .join("\n");
  }

  private issueBreakdownMcpPrompt(entry: RunningEntry): string {
    this.requireMcpHandoff("issue_breakdown");
    return renderIssueBreakdownMcpHandoffPrompt({ issue: this.issueWithResolvedProjectContext(entry) });
  }

  private async renderWorkerContinuationPrompt(entry: RunningEntry): Promise<string> {
    const runConfig = this.configForProjectContext(this.resolvedProjectContext(entry));
    const continuationBrief = await this.renderContinuationBrief(entry);
    const projectContextPrompt = this.renderResolvedProjectContextPrompt(entry);
    const runtimeSourceScope = this.renderRuntimeSourceScopePrompt(entry.issue);
    const reviewHardening = this.workerReviewHardeningPrompt(runConfig);
    const reviewEvidence = await this.loadWorkerReviewEvidencePrompt(entry);
    const handoff = await this.loadWorkerHandoffPrompt(entry);
    const mergeGateResult = await this.loadWorkerMergeGatePromptResult(entry);
    const mergeGate = mergeGateResult?.text ?? null;
    const reviewVerdict = mergeGateResult?.kind === "repair" ? null : await this.loadWorkerReviewVerdictPrompt(entry);
    return [
      continuationBrief,
      projectContextPrompt,
      runtimeSourceScope,
      reviewHardening,
      handoff,
      mergeGate,
      reviewVerdict,
      reviewEvidence,
      this.workerMcpPrompt(entry),
    ]
      .filter((item): item is string => item !== null)
      .join("\n");
  }

  private renderRuntimeSourceScopePrompt(issue: Issue): string | null {
    const scope = parseIssueRuntimeSourceScope(issue.description);
    if (!scope.hasTouchedSurfacesSection) return null;
    if (scope.authorizedPaths.length === 0) {
      return [
        "",
        "Authorized runtime source scope:",
        "- This issue does not authorize runtime source implementation under src/ or cursor/src/.",
        "- Keep runtime source changes out of this run unless a child issue explicitly lists them in Touched Surfaces.",
      ].join("\n");
    }
    return [
      "",
      "Authorized runtime source scope:",
      "- If you modify runtime source files under src/ or cursor/src/, stay within these Touched Surfaces entries:",
      ...scope.authorizedPaths.map((item) => `- ${item}`),
      "- Do not widen runtime implementation to unlisted source surfaces; move that work to a separately authorized child issue.",
    ].join("\n");
  }

  private workerReviewHardeningPrompt(config: ServiceConfig = this.config): string {
    return [
      "",
      DEFAULT_WORKER_INVARIANT_REPAIR_GUIDANCE,
      formatPromptExtensions("Project-specific worker extensions:", config.reviewLoop.workerPromptExtensions),
    ]
      .filter((item): item is string => item !== null)
      .join("\n");
  }

  private async renderContinuationBrief(entry: RunningEntry): Promise<string> {
    const lifecycle = entry.lifecycle ?? (await this.options.lifecycleStore?.get(entry.issue.id)) ?? null;
    const lookupOptions = projectContextLookupOptions(lifecycle?.projectContext ?? projectContextResolutionFromIssue(entry.issue));
    const runs = (await this.options.runStore?.listRunsForIssue(entry.issue.id, lookupOptions)) ?? [];
    const history = await this.loadContinuationHistory(runs);
    const threshold = this.config.reviewLoop.transcriptHistoryLimit;
    const historyMode = "summary";
    const summaryReference = latestContinuationSummaryReference(lifecycle);
    const workspace = entry.workspace;
    const pointers = lifecycle?.summaryPointers;
    const latestRun = runs[runs.length - 1] ?? null;
    const transcriptPointers = transcriptPointersForRuns(runs);
    const statusApiPointers = statusApiPointersForIssue(entry.issue.id, runs);

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

  private workerMcpPrompt(entry: RunningEntry): string | null {
    if (entry.runPhase !== "implementation") return null;
    this.requireMcpHandoff("implementation");
    const workspace = entry.workspace;
    return renderCompletionMcpHandoffPrompt({
      issue: this.issueWithResolvedProjectContext(entry),
      role: entry.role,
      workspacePath: workspace?.path ?? entry.workspacePath,
      branchName: workspace?.gitBranchName ?? entry.issue.branchName ?? null,
      repoPath: workspace?.repoPath ?? null,
      baseRef: workspace?.baseRef ?? null,
    });
  }

  private mergeConflictResolutionMcpPrompt(entry: RunningEntry): string | null {
    if (entry.runPhase !== "merge_conflict_resolution") return null;
    this.requireMcpHandoff("merge_conflict_resolution");
    const workspace = entry.workspace;
    return renderMergeConflictResolutionMcpHandoffPrompt({
      issue: this.issueWithResolvedProjectContext(entry),
      workspacePath: workspace?.path ?? entry.workspacePath,
      branchName: workspace?.gitBranchName ?? entry.issue.branchName ?? null,
      repoPath: workspace?.repoPath ?? null,
      baseRef: workspace?.baseRef ?? null,
    });
  }

  private requireMcpHandoff(runPhase: AgentRunPhase): void {
    if (harnessSupportsMcpHandoff(this.options.harness)) return;
    throw new SymphonyError(
      "config_validation_error",
      `Runtime harness ${this.options.harness.id} does not support Symphony MCP handoff required for ${runPhase}`,
    );
  }

  private async loadWorkerReviewVerdictPrompt(entry: RunningEntry): Promise<string | null> {
    const lifecycle = await this.loadWorkerCurrentPromptLifecycle(entry);
    return lifecycle === null ? null : formatWorkerReviewVerdictPrompt(lifecycle);
  }

  private async loadWorkerMergeGatePromptResult(entry: RunningEntry): Promise<WorkerMergeGatePromptResult | null> {
    const lifecycle = await this.loadWorkerCurrentPromptLifecycle(entry);
    if (lifecycle === null) return null;
    return formatWorkerMergeGatePromptResult(lifecycle);
  }

  private async loadWorkerCurrentPromptLifecycle(entry: RunningEntry): Promise<IssueLifecycleRecord | null> {
    const lifecycle = await this.options.lifecycleStore?.get(entry.issue.id);
    if (lifecycle === undefined || lifecycle === null) return null;
    return currentPromptLifecycle(lifecycle);
  }

  private async loadIssueBreakdownPlanPrompt(entry: RunningEntry): Promise<string | null> {
    const config = this.configForProjectContext(this.resolvedProjectContext(entry));
    if (!config.issueBreakdown.enabled) return null;
    const lifecycle = await this.options.lifecycleStore?.get(entry.issue.id);
    const plan = latestFreshIssueBreakdownPlan(lifecycle, entry.issue, config);
    if (plan === null) return null;
    return [
      "",
      "Issue breakdown plan:",
      `- Source: ${plan.id}; accepted at ${plan.acceptedAt}`,
      `- Runtime mode: ${plan.cursorMode ?? config.issueBreakdown.cursorMode}`,
      `- Transcript pointers: ${formatList(plan.transcriptPointers)}`,
      `- Status pointers: ${formatList(plan.statusApiPointers)}`,
      "",
      renderIssueBreakdownPlanSummary(plan),
    ].join("\n");
  }

  private async loadWorkerHandoffPrompt(entry: RunningEntry): Promise<string | null> {
    const lifecycle = (await this.options.lifecycleStore?.get(entry.issue.id)) ?? entry.lifecycle ?? null;
    const lookupOptions = projectContextLookupOptions(lifecycle?.projectContext ?? projectContextResolutionFromIssue(entry.issue));
    const runs = (await this.options.runStore?.listRunsForIssue(entry.issue.id, lookupOptions)) ?? [];
    if (!lifecycle || !hasRealHandoffContext(lifecycle, runs)) return null;
    const currentLifecycle = currentPromptLifecycle(lifecycle);
    const packet = buildWorkerHandoffPacket(currentLifecycle);
    const transcriptPointers = transcriptPointersForRuns(runs);
    const statusPointers = statusApiPointersForIssue(entry.issue.id, runs);
    const activeReviewEvidence = lifecycle.reviewEvidence.items.filter(isActiveReviewEvidenceItem);
    return [
      "",
      "Compact Symphony handoff packet:",
      `- Version: ${packet.version}; generatedAt: ${packet.generatedAt}`,
      `- Issue: ${packet.issueIdentifier} (${packet.issueId})`,
      `- Objective: ${entry.issue.title}`,
      `- Next action: ${nextWorkerAction(currentLifecycle)}`,
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
        this.defaultGitHubPullRequestClientForCapability(
          "github.review_evidence_read",
          this.resolvedProjectContext(entry),
        );
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
      entry.harnessStopRequestedAt = entry.harnessStopRequestedAt ?? now;
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
    if (entry.harnessStopRequestedAt !== null) return null;
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

function statesEqual(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function uniqueStateNames(states: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const state of states) {
    const key = state.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(state);
  }
  return unique;
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

function effectiveRuntimeModeForEntry(entry: RunningEntry, config: ServiceConfig): "agent" | "plan" | null {
  return entry.runPhase === "issue_breakdown" ? config.issueBreakdown.cursorMode : config.cursor.mode;
}

function runtimeProviderForHarness(harnessId: string, config: ServiceConfig): string | null {
  if (harnessId === "hermes") return config.hermes.provider;
  if (harnessId === "hermes_acp") return config.hermes.provider;
  return harnessId;
}

function runtimeModelForHarness(harnessId: string, config: ServiceConfig): string | null {
  if (harnessId === "hermes") return config.hermes.model;
  if (harnessId === "hermes_acp") return null;
  if (harnessId === "cursor") return config.cursor.model;
  return null;
}

function runtimeModelParamsForHarness(
  harnessId: string,
  config: ServiceConfig,
): NonNullable<StartRunInput["runtimeModelParams"]> {
  return harnessId === "cursor" ? config.cursor.modelParams : [];
}

function runtimeSettingSourcesForHarness(harnessId: string, config: ServiceConfig): string[] {
  if (harnessId === "cursor") return config.cursor.settingSources;
  if (harnessId === "hermes") {
    return [
      `template:${config.hermes.roleTemplates.planner}`,
      ...(config.hermes.provider === null ? [] : [`provider:${config.hermes.provider}`]),
    ];
  }
  if (harnessId === "hermes_acp") {
    return [
      `host_hermes:${config.hermesAcp.binaryPath ?? "PATH:hermes"}`,
      `source_profile:${config.hermesAcp.sourceProfile ?? "active"}`,
      `profile_prefix:${config.hermesAcp.profilePrefix}`,
    ];
  }
  return [];
}

function runtimeModeForHarness(harnessId: string, config: ServiceConfig): string | null {
  if (harnessId === "cursor") return config.cursor.mode;
  if (harnessId === "hermes") return config.cursor.mode;
  return null;
}

function runtimeAllowLargeContextForHarness(harnessId: string, config: ServiceConfig): boolean | undefined {
  return harnessId === "cursor" ? config.cursor.allowLargeContext : undefined;
}

function operatorChatIssueId(conversationId: string): string {
  return `operator:${conversationId}`;
}

async function existingDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

function mergeTokenCounts(current: TokenCounts, patch: Partial<TokenCounts>): TokenCounts {
  return {
    inputTokens: patch.inputTokens ?? current.inputTokens,
    outputTokens: patch.outputTokens ?? current.outputTokens,
    totalTokens: patch.totalTokens ?? current.totalTokens,
  };
}

function mergeOperatorAssistantText(
  current: string,
  next: string,
  activitySource: AgentActivitySource | undefined,
): string {
  if (next.trim().length === 0) return current;
  if (activitySource === "delta") return `${current}${next}`;
  if (current.trim().length === 0) return next;
  if (next.startsWith(current)) return next;
  if (current.includes(next)) return current;
  return `${current.trimEnd()}\n\n${next}`;
}

function operatorAssistantMetadata(input: {
  command: OrchestratorChatCommand;
  event: Extract<AgentEvent, { type: "session_started" }>;
  harnessId: string;
  model: string | null;
}): Record<string, unknown> {
  return {
    source: "operator_chat",
    commandMessageId: input.command.messageId,
    operatorRun: {
      runId: input.event.runId ?? input.event.sessionId,
      sessionId: input.event.sessionId,
      threadId: input.event.threadId ?? null,
      harnessId: input.harnessId,
      model: input.model,
      role: "planner",
      runKind: "planning",
      status: "streaming",
    },
  };
}

function providerGateDispatchBlockedMessage(gate: RuntimeProviderGate): string {
  const provider = gate.scope.providerId ?? gate.scope.harnessId;
  const reset = gate.window?.resumeAt
    ? ` Dispatch can resume at ${gate.window.resumeAt}.`
    : " Dispatch is waiting for operator resume.";
  return `Provider limit active for ${provider}: ${gate.message}.${reset}`;
}

function runtimeMetadataForEntry(
  harnessId: string,
  entry: RunningEntry,
  config: ServiceConfig,
  sessionStartedEvent?: Extract<AgentEvent, { type: "session_started" }>,
): Partial<
  Pick<
    StartRunInput,
    | "runtimeModel"
    | "runtimeModelParams"
    | "runtimeSettingSources"
    | "runtimeMode"
    | "runtimeAllowLargeContext"
    | "runtimeAgentLifecycle"
  >
> {
  if (harnessId === "cursor") {
    return {
      runtimeModel: config.cursor.model,
      runtimeModelParams: config.cursor.modelParams,
      runtimeSettingSources: config.cursor.settingSources,
      runtimeMode: effectiveRuntimeModeForEntry(entry, config),
      runtimeAllowLargeContext: config.cursor.allowLargeContext,
      runtimeAgentLifecycle: config.cursor.workerAgentLifecycle,
    };
  }
  if (harnessId === "hermes") {
    return {
      runtimeModel: config.hermes.model,
      runtimeModelParams: [],
      runtimeSettingSources: [
        `template:${hermesTemplateForEntry(entry, config)}`,
        ...(config.hermes.provider === null ? [] : [`provider:${config.hermes.provider}`]),
      ],
      runtimeMode: effectiveRuntimeModeForEntry(entry, config),
      runtimeAgentLifecycle: config.hermes.workerSessionLifecycle,
    };
  }
  if (harnessId === "hermes_acp") {
    const runtimeProviderId = cleanRuntimeMetadataString(sessionStartedEvent?.providerId);
    const runtimeModel = cleanRuntimeMetadataString(sessionStartedEvent?.model);
    return {
      runtimeModel,
      runtimeModelParams: [],
      runtimeSettingSources: [
        `host_hermes:${config.hermesAcp.binaryPath ?? "PATH:hermes"}`,
        `source_profile:${config.hermesAcp.sourceProfile ?? "active"}`,
        `profile_prefix:${config.hermesAcp.profilePrefix}`,
        ...(runtimeProviderId === null ? [] : [`provider:${runtimeProviderId}`]),
      ],
      runtimeMode: null,
      runtimeAgentLifecycle: config.hermesAcp.workerSessionLifecycle,
    };
  }
  return {
    runtimeModel: null,
    runtimeModelParams: [],
    runtimeSettingSources: [],
    runtimeMode: effectiveRuntimeModeForEntry(entry, config),
  };
}

function cleanRuntimeMetadataString(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function hermesTemplateForEntry(entry: RunningEntry, config: ServiceConfig): string {
  if (entry.role === "reviewer") return config.hermes.roleTemplates.reviewer;
  if (entry.runPhase === "issue_breakdown") return config.hermes.roleTemplates.planner;
  if (entry.runPhase === "merge_conflict_resolution") return config.hermes.roleTemplates.mergeConflictResolution;
  return config.hermes.roleTemplates.worker;
}

function maxPlanningFailuresReason(count: number, max: number): string {
  return `max planning failures reached (${count}/${max})`;
}

function mergeConflictBlockedReason(count: number, max: number): string {
  return `merge conflicts remain unresolved (${count}/${max} conflict-fix attempts)`;
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
    lifecycle.mergeGate !== null ||
    lifecycle.merge !== null ||
    lifecycle.phase !== "implementation"
  );
}

function currentPromptLifecycle(lifecycle: IssueLifecycleRecord): IssueLifecycleRecord {
  return (
    sanitizeStaleMergeGateLifecycle(lifecycle, lifecycle.summaryPointers.prHeadSha, lifecycle.summaryPointers.prNumber) ??
    lifecycle
  );
}

function nextWorkerAction(lifecycle: IssueLifecycleRecord): string {
  if (lifecycle.mergeGate?.status === "repair_dispatched" || lifecycle.mergeGate?.status === "blocked") {
    return "Repair the Symphony merge-gate checks on the lifecycle-bound PR, validate, and submit a new completion report.";
  }
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
  const lookupOptions = projectContextLookupOptions(lifecycle.projectContext);
  for (const key of new Set([lifecycle.issueId, lifecycle.issueIdentifier])) {
    for (const run of await runStore.listRunsForIssue(key, lookupOptions)) {
      byId.set(run.runId, run);
    }
  }
  return [...byId.values()].sort(compareRunChronology);
}

function projectContextLookupOptions(projectContext: ProjectContextResolution | null | undefined):
  | { projectContext: ProjectContextResolution }
  | {} {
  return projectContext ? { projectContext } : {};
}

function issueWithProjectContext(issue: Issue, projectContext: ProjectContextResolution | null | undefined) {
  return {
    ...issue,
    ...(projectContext ? { projectContext } : {}),
  };
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

function statusApiPointersForIssue(issueKey: string, runs: RunRecord[]): string[] {
  const pointers = new Set<string>();
  pointers.add(`/api/v1/issues/${encodeURIComponent(issueKey)}`);
  pointers.add(`/api/v1/issues/${encodeURIComponent(issueKey)}/runs`);
  for (const run of runs) pointers.add(`/api/v1/runs/${encodeURIComponent(run.runId)}`);
  return [...pointers];
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

function formatAcceptedHandoffKind(kind: AcceptedHandoffKind): string {
  switch (kind) {
    case "completion_report":
      return "completion report";
    case "pull_request_handoff":
      return "pull request";
    case "issue_breakdown_plan":
      return "issue breakdown plan";
    case "merge_conflict_resolution":
      return "merge conflict resolution";
  }
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
    providerLimit: entry.providerLimitSignal,
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

const INFRA_FAILURE_DIAGNOSTIC_CODES = new Set([
  "hermes_gateway_exit",
  "hermes_run_error",
  "hermes_gateway_start_timeout",
  "hermes_gateway_protocol_error",
  "hermes_gateway_error",
  "hermes_acp_run_error",
]);

function isCountedInfraFailure(run: RunRecord): boolean {
  return (
    run.role === "worker" &&
    run.status === "failed" &&
    run.completedAt !== null &&
    run.cancellationRequestedAt == null &&
    (run.cancellationOutcome ?? "none") === "none" &&
    run.cancelFailed !== true &&
    run.error !== OPERATOR_REJECTED_PUBLICATION_ERROR &&
    run.failureKind === "harness_diagnostic" &&
    isInfraFailureDiagnosticCode(run.failureDiagnosticCode)
  );
}

function isInfraFailureDiagnosticCode(code: string | null | undefined): boolean {
  return typeof code === "string" && INFRA_FAILURE_DIAGNOSTIC_CODES.has(code);
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
    delegateId: null,
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
    delegateId: null,
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

function normalizeProjectSlug(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function sameProjectSlug(left: string | null | undefined, right: string | null | undefined): boolean {
  const normalizedLeft = normalizeProjectSlug(left);
  const normalizedRight = normalizeProjectSlug(right);
  return normalizedLeft !== null && normalizedRight !== null && normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
}

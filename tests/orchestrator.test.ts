import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatusServer } from "../src/app/http.js";
import { projectWebTranscript } from "../src/app/WebTranscriptProjection.js";
import { CursorWorkspaceOpener } from "../cursor/src/CursorWorkspaceOpener.js";
import {
  CompletionReportService,
  PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON,
  PUBLICATION_APPROVAL_SETUP_INCOMPLETE_REASON,
  type CompletionReportPullRequestPublication,
  type CompletionReportPullRequestPublicationInput,
  type CompletionReportPullRequestPublisher,
} from "../src/core/CompletionReportService.js";
import { SymphonyError } from "../src/core/errors.js";
import {
  FileOperatorApprovalStore,
  OPERATOR_REJECTED_PUBLICATION_ERROR,
  OperatorApprovalService,
  type OperatorApprovalRecord,
} from "../src/core/approval/OperatorApprovalService.js";
import { parseServiceConfig } from "../src/core/config/Config.js";
import { ReviewVerdictService } from "../src/core/ReviewVerdictService.js";
import { FakeHarness } from "../src/core/harness/FakeHarness.js";
import type {
  AgentEvent,
  AgentHarness,
  AgentRunContext,
  OperatorChatRunContext,
} from "../src/core/harness/AgentHarness.js";
import type { RunActivityEvent } from "../src/core/runActivity/RunActivityEvent.js";
import {
  planIssueBreakdownApplicationWritebacks,
  planIssueBreakdownFinalizationWritebacks,
} from "../src/core/IssueBreakdownPlanApplyService.js";
import { IssueBreakdownPlanService } from "../src/core/IssueBreakdownPlanService.js";
import { IssueTriageService, issueTriageTriggerFingerprint } from "../src/core/IssueTriageService.js";
import type { MergePolicyGitHubClient } from "../src/core/merge/MergePolicyService.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import { Orchestrator, sortIssuesForDispatch, type PullRequestDiscoveryClient } from "../src/core/orchestrator/Orchestrator.js";
import type { IssueCurrentStateSnapshot, IssueHistorySnapshot } from "../src/core/orchestration/IssueOrchestrationState.js";
import { SqliteIssueStateStore } from "../src/core/orchestration/SqliteIssueStateStore.js";
import {
  FileIssueLifecycleStore,
  type IssueCompletionReportRecord,
  type IssueBreakdownCreatedIssueRef,
  type IssueBreakdownPlanRecord,
  type IssueLifecyclePatch,
  type IssueMergeConflictMetadata,
  type IssueMergeGateState,
  type IssueReviewFeedbackRecord,
  type IssueReviewVerdictRecord,
} from "../src/core/persistence/IssueLifecycleStore.js";
import type {
  PullRequestReviewEvidenceClient,
  RemotePullRequestReviewEvidence,
} from "../src/core/review/PullRequestReviewEvidenceService.js";
import { FileRunTranscriptStore } from "../src/core/persistence/RunTranscriptStore.js";
import { FileOrchestratorConversationStore } from "../src/core/persistence/OrchestratorConversationStore.js";
import type {
  TrackerCommentInput,
  TrackerIssueCreateInput,
  TrackerIssueRelationInput,
  TrackerTransitionInput,
  TrackerWriteResult,
  TrackerWriter,
} from "../src/core/tracker/TrackerWriter.js";
import type { TrackerClient } from "../src/core/tracker/TrackerClient.js";
import {
  FileWritebackOutboxStore,
  ISSUE_BREAKDOWN_PLAN_STALE_REASON,
  ISSUE_BREAKDOWN_WRITEBACK_NOT_CURRENT_REASON,
  WritebackProcessor,
} from "../src/core/writeback/WritebackOutbox.js";
import type { NewWritebackOperation } from "../src/core/writeback/WritebackOutbox.js";
import { WorkspaceManager } from "../src/core/workspace/WorkspaceManager.js";
import type { Issue, TokenCounts, TrackerStateLists } from "../src/core/types.js";
import { agentEligibleIssueContract, issue, testConfig } from "./helpers.js";

type IssueCreateWriteback = Extract<NewWritebackOperation, { kind: "issue_create" }>;
type IssueRelationWriteback = Extract<NewWritebackOperation, { kind: "issue_relation" }>;
type CommentWriteback = Extract<NewWritebackOperation, { kind: "comment" }>;
type RequestedTransitionCall = {
  candidateSource: string;
  context: ReturnType<typeof mergePolicyChainContext>;
};

function issuesInStates(issues: Issue[], states: string[]): Issue[] {
  const wanted = new Set(states.map((state) => state.toLowerCase()));
  return issues.filter((item) => wanted.has(item.state.toLowerCase()));
}

describe("Orchestrator", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-orchestrator-"));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  });

  it("sorts issues by priority, creation date, then identifier", () => {
    const sorted = sortIssuesForDispatch([
      issue({ identifier: "B", priority: null }),
      issue({ identifier: "A", priority: 2 }),
      issue({ identifier: "C", priority: 1 }),
    ]);
    expect(sorted.map((item) => item.identifier)).toEqual(["C", "A", "B"]);
  });

  it("marks persisted running runs as cancelled on startup", async () => {
    const config = testConfig(root);
    const candidate = issue({ state: "In Progress" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await runStore.startRun({
      runId: "orphan-run-1",
      sessionId: "orphan-session-1",
      agentId: "orphan-agent-1",
      role: "worker",
      runPhase: "implementation",
      issueId: candidate.id,
      issueIdentifier: candidate.identifier,
      attempt: 1,
      turnNumber: 1,
      prompt: "Worker prompt",
      workspaceKey: candidate.identifier,
      workspacePath: path.join(root, candidate.identifier),
      gitBranchName: "symphony/TEST-1",
      repoPath: root,
      baseRef: "main",
      metadata: {
        sdkRunStatus: "running",
        sdkRunStatusObservedAt: "2026-01-01T00:00:00.000Z",
        sdkRunStatusSource: "initial",
      },
    });
    const harness = new FakeHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      runStore,
    });

    await orchestrator.start();
    await orchestrator.stop();

    await expect(runStore.getRun("orphan-run-1")).resolves.toMatchObject({
      status: "cancelled",
      error: "Run cancelled during Symphony startup because no live orchestrator owns it.",
      cancellationSource: "service_stop",
      cancellationOutcome: "cancelled",
      sdkRunStatus: "cancelled",
      sdkRunStatusSource: "wait",
    });
    const transcript = await runStore.readTranscript("orphan-run-1");
    expect(transcript.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "cancelled",
          message: "Run cancelled during Symphony startup",
        }),
      ]),
    );
  });

  it("dispatches eligible work through the harness", async () => {
    const config = testConfig(root);
    const candidate = issue({ state: "Todo" });
    let active = true;
    let refreshes = 0;
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return active ? [candidate] : [];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates(active ? [candidate] : [], states);
      },
      async fetchIssueStatesByIds() {
        refreshes += 1;
        if (refreshes === 1) return [candidate];
        active = false;
        return [{ ...candidate, state: "Done" }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const harness = new FakeHarness();
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
    });
    expect(orchestrator.registeredTransitionRulesets().map((ruleset) => ruleset.id)).toEqual(
      expect.arrayContaining([
        "manual.dispatch",
        "orchestrator.dispatch.worker.implementation",
        "orchestrator.dispatch.reviewer.review",
        "orchestrator.handoff_repair",
        "orchestrator.merge_policy.observe",
        "orchestrator.merge_policy_dispatch_repair",
        "orchestrator.merge_policy_merge_pull_request",
      ]),
    );

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await orchestrator.stop();

    expect(harness.runs[0]?.prompt).toContain("Work on TEST-1");
    expect(harness.runs[0]?.prompt).toContain("Review-cycle hardening:");
    expect(harness.runs[0]?.prompt).toContain("underlying contract invariant");
    expect(harness.runs[0]?.prompt).toContain("derive a conservative checklist");
    expect(harness.runs[0]?.prompt).toContain("issue-authoring gap");
    expect(harness.runs[0]?.prompt).not.toContain("Compact Symphony handoff packet:");
    expect(harness.runs[0]?.ctx.role).toBe("worker");
    expect(orchestrator.snapshot().counts.running).toBe(0);
    const issueState = await readIssueState(config.workspace.stateDir, candidate.id);
    const dispatchSnapshot = issueState?.history.find((snapshot) => snapshot.transitionKind === "dispatch_worker");
    expect(dispatchSnapshot).toMatchObject({
      triggerType: "orchestrator.tick",
      candidateSource: "tick_candidates",
      rulesetId: "orchestrator.dispatch.worker.implementation",
      role: "worker",
      runPhase: "implementation",
      reason: "worker_dispatch",
    });
    expect(dispatchSnapshot).not.toHaveProperty("current");
    expect(dispatchSnapshot).not.toHaveProperty("transitionRequest");
    expect(dispatchSnapshot?.actions.map((action) => action.actionType)).toEqual(
      expect.arrayContaining([
        "record_agent_dispatch_started",
        "create_running_entry",
        "claim_issue_for_run",
        "clear_retry_for_issue",
        "start_agent_run_monitor",
      ]),
    );
    const evidenceEvents = issueState?.history
      .filter((snapshot) => snapshot.snapshotKind === "evidence")
      .map((snapshot) => `${snapshot.evidenceKind}:${snapshot.evidenceEventType}`);
    expect(evidenceEvents).toEqual(
      expect.arrayContaining([
        "workspace:workspace_created",
        "workspace:workspace_before_run_completed",
        "workspace:workspace_after_run_completed",
        "harness:harness_reload_completed",
        "lifecycle:lifecycle_updated",
        "run:prompt_rendered",
        "run:run_started",
        "run:run_terminal_state_updated",
        "run:agent_run_exit",
      ]),
    );
  });

  it("runs dashboard operator chat through the configured harness and persists assistant output", async () => {
    const config = testConfig(root);
    const logger = new StructuredLogger(() => undefined);
    const tracker = idleTracker();
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const conversationStore = new FileOrchestratorConversationStore(config.workspace.stateDir);
    const harness = new FakeOperatorChatHarness([
      { type: "session_started", sessionId: "operator-session-1", runId: "operator-run-1", model: "test-planner" },
      { type: "progress", activitySource: "delta", message: "Hello " },
      { type: "progress", activitySource: "delta", message: "operator" },
      { type: "completed" },
    ]);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "unused",
      runStore,
      orchestratorConversationStore: conversationStore,
      statusServerBaseUrl: () => "http://127.0.0.1:7331",
      statusMutationToken: "secret",
    });
    await conversationStore.appendMessage({
      conversationId: "operator-room",
      id: "client-message-1",
      role: "user",
      body: "what is running?",
      status: "pending",
    });

    const result = await orchestrator.dispatchOrchestratorChatCommand({
      action: "orchestrator.chat.post",
      source: "web",
      conversationId: "operator-room",
      messageId: "client-message-1",
      input: "what is running?",
      requestedAt: "2026-06-06T00:00:00.000Z",
    });

    expect(result).toMatchObject({
      status: "accepted",
      metadata: {
        conversationId: "operator-room",
        messageId: "client-message-1",
        role: "planner",
        harnessId: "fake-operator",
      },
    });

    await eventually(async () => {
      const messages = await conversationStore.listMessages("operator-room");
      expect(messages.map((message) => [message.role, message.status, message.body])).toEqual([
        ["user", "completed", "what is running?"],
        ["assistant", "completed", "Hello operator"],
      ]);
    });
    expect(harness.operatorContexts).toHaveLength(1);
    expect(harness.operatorContexts[0]).toMatchObject({
      conversationId: "operator-room",
      messageId: "client-message-1",
      statusServer: { baseUrl: "http://127.0.0.1:7331", mutationToken: "secret" },
    });
    await eventually(async () => {
      const run = await runStore.getRun("operator-run-1");
      expect(run).toMatchObject({
        runId: "operator-run-1",
        role: "planner",
        runPhase: "issue_breakdown",
        runKind: "planning",
        status: "succeeded",
        runtimeModel: "test-planner",
        runtimeAgentLifecycle: "reuse_by_conversation",
      });
    });
    const transcript = await runStore.readTranscript("operator-run-1");
    expect(transcript.events.map((event) => event.eventType)).toContain("completed");
  });

  it("persists distinct Hermes ACP runtime metadata on started runs", async () => {
    const config = testConfig(root);
    config.agent.harness = "hermes_acp";
    config.hermes.provider = "openrouter";
    config.hermes.model = "config-model-should-not-leak";
    config.hermesAcp.binaryPath = "/opt/hermes/bin/hermes";
    config.hermesAcp.sourceProfile = "dogfood";
    config.hermesAcp.profilePrefix = "sym-test";
    config.hermesAcp.workerSessionLifecycle = "fresh_per_run";
    const candidate = issue({ state: "Todo" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const harness: AgentHarness & { runs: Array<{ ctx: AgentRunContext; prompt: string }> } = {
      id: "hermes_acp",
      capabilities: { continuation: true, mcpHandoff: true },
      runs: [],
      async *run(ctx: AgentRunContext, prompt: string): AsyncIterable<AgentEvent> {
        this.runs.push({ ctx, prompt });
        yield {
          type: "session_started",
          sessionId: `hermes-acp-${ctx.issue.id}-${ctx.turnNumber}`,
          providerId: "openrouter",
          model: "anthropic/claude-sonnet-test",
        };
        yield { type: "completed", message: "hermes acp completed" };
      },
    };
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      runStore,
    });

    await orchestrator.refreshNow();
    await waitFor(() => harness.runs.length === 1, "Hermes ACP dispatch");
    await waitFor(() => orchestrator.snapshot().counts.running === 0, "Hermes ACP run completion");
    await orchestrator.stop();

    await expect(runStore.latestRunForIssue(candidate.id)).resolves.toMatchObject({
      harnessId: "hermes_acp",
      runtimeModel: "anthropic/claude-sonnet-test",
      runtimeModelParams: [],
      runtimeSettingSources: [
        "host_hermes:/opt/hermes/bin/hermes",
        "source_profile:dogfood",
        "profile_prefix:sym-test",
        "provider:openrouter",
      ],
      runtimeMode: null,
      runtimeAgentLifecycle: "fresh_per_run",
    });
  });

  it("persists default Hermes ACP runtime metadata and harness-provided ACP session identity without optional config", async () => {
    const config = testConfig(root);
    config.agent.harness = "hermes_acp";
    config.hermes.provider = null;
    config.hermes.model = "config-model-should-not-leak";
    config.hermesAcp.binaryPath = null;
    config.hermesAcp.sourceProfile = null;
    const candidate = issue({ state: "Todo" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const harness: AgentHarness & { runs: Array<{ ctx: AgentRunContext; prompt: string }> } = {
      id: "hermes_acp",
      capabilities: { continuation: true, mcpHandoff: true },
      runs: [],
      async *run(ctx: AgentRunContext, prompt: string): AsyncIterable<AgentEvent> {
        this.runs.push({ ctx, prompt });
        yield {
          type: "session_started",
          sessionId: "symphony-profile:acp-session-1:hermes-acp-run-1",
          threadId: "acp-session-1",
          runId: "hermes-acp-run-1",
          providerId: null,
          model: null,
        };
        yield { type: "completed", message: "hermes acp completed" };
      },
    };
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      runStore,
    });

    await orchestrator.refreshNow();
    await waitFor(() => harness.runs.length === 1, "Hermes ACP default dispatch");
    await waitFor(() => orchestrator.snapshot().counts.running === 0, "Hermes ACP default run completion");
    await orchestrator.stop();

    await expect(runStore.latestRunForIssue(candidate.id)).resolves.toMatchObject({
      runId: "hermes-acp-run-1",
      sessionId: "symphony-profile:acp-session-1:hermes-acp-run-1",
      agentId: "acp-session-1",
      harnessId: "hermes_acp",
      runtimeModel: null,
      runtimeModelParams: [],
      runtimeSettingSources: ["host_hermes:PATH:hermes", "source_profile:active", "profile_prefix:symphony"],
      runtimeMode: null,
      runtimeAgentLifecycle: "reuse_by_issue",
    });
  });

  it("persists harness-provided ACP RunActivityEvent metadata through the shared orchestrator transcript path", async () => {
    const config = testConfig(root);
    const candidate = issue({ state: "Todo" });
    let active = true;
    let refreshes = 0;
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return active ? [candidate] : [];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates(active ? [candidate] : [], states);
      },
      async fetchIssueStatesByIds() {
        refreshes += 1;
        if (refreshes === 1) return [candidate];
        active = false;
        return [{ ...candidate, state: "Done" }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const runId = `fake-${candidate.id}-1`;
    const harness = new RunActivityHarness([
      {
        type: "progress",
        activitySource: "delta",
        message: "hello",
        runActivity: acpActivity(runId, 2, {
          actor: "assistant",
          channel: "chat",
          kind: "assistant_message_delta",
          text: "hello",
          payload: { delta: true, messagePreview: "hello", redacted: true },
        }),
      },
      {
        type: "progress",
        activitySource: "stream",
        message: "Hermes ACP user message replay",
        runActivity: acpActivity(runId, 3, {
          actor: "user",
          channel: "chat",
          kind: "user_message_submitted",
          text: "Do work",
          payload: { replay: true, messagePreview: "Do work" },
        }),
      },
      {
        type: "progress",
        activitySource: "stream",
        message: "Hermes ACP thought update",
        runActivity: acpActivity(runId, 4, {
          actor: "assistant",
          channel: "chat",
          kind: "assistant_reasoning_delta",
          text: "Hermes ACP thought update",
          payload: { reasoning: true, messagePreview: "thought preview", redacted: true },
        }),
      },
      {
        type: "progress",
        activitySource: "tool",
        message: "Hermes ACP tool started: terminal",
        runActivity: acpActivity(runId, 5, {
          actor: "tool",
          channel: "tool",
          kind: "tool_call_started",
          text: "Hermes ACP tool started: terminal",
          payload: { toolCallId: "call-1", toolName: "terminal", status: "running", outputPreview: "started", redacted: true },
        }),
      },
      {
        type: "progress",
        activitySource: "tool",
        message: "Hermes ACP tool completed: terminal",
        runActivity: acpActivity(runId, 6, {
          actor: "tool",
          channel: "tool",
          kind: "tool_call_completed",
          text: "Hermes ACP tool completed: terminal",
          payload: { toolCallId: "call-1", toolName: "terminal", status: "succeeded", outputPreview: "tests passed", redacted: true },
        }),
      },
      {
        type: "tokens",
        tokens: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
        runActivity: acpActivity(runId, 7, {
          actor: "runtime",
          channel: "token",
          kind: "token_usage_reported",
          text: "Token usage reported",
          payload: { inputTokens: 3, outputTokens: 5, totalTokens: 8, usageSource: "stream" },
        }),
      },
      {
        type: "run_diagnostic",
        code: "hermes_acp_permission_denied",
        message: "ACP permission denied",
        payload: { paramsPreview: "safe" },
        runActivity: acpActivity(runId, 8, {
          actor: "runtime",
          channel: "diagnostic",
          kind: "runtime_diagnostic",
          text: "ACP permission denied",
          payload: { code: "hermes_acp_permission_denied", severity: "info", messagePreview: "permission denied", redacted: true },
        }),
      },
      {
        type: "completed",
        message: "Run completed",
        runActivity: acpActivity(runId, 9, {
          actor: "runtime",
          channel: "terminal",
          kind: "run_succeeded",
          text: "Run completed",
          payload: { reason: "run_succeeded" },
        }),
      },
    ]);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      runStore,
    });

    await orchestrator.refreshNow();
    await waitFor(() => harness.runs.length === 1, "run-activity harness dispatched");
    await waitFor(() => orchestrator.snapshot().counts.running === 0, "run-activity harness exited");
    await settleOrchestratorExit();
    await orchestrator.stop();

    const run = await runStore.latestRunForIssue(candidate.id);
    expect(run).toMatchObject({ runId, status: "succeeded", tokens: { inputTokens: 3, outputTokens: 5, totalTokens: 8 } });
    const transcript = await runStore.readTranscript(runId);
    const eventTypes = transcript.events.map((event) => event.eventType);
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        "session_started",
        "assistant_message_delta",
        "user_message_submitted",
        "assistant_reasoning_delta",
        "tool_call_started",
        "tool_call_completed",
        "token_usage_reported",
        "runtime_diagnostic",
        "run_succeeded",
      ]),
    );
    expect(eventTypes).not.toContain("agent_message_chunk");
    expect(eventTypes).not.toContain("session/update");
    expect(transcript.events.find((event) => event.eventType === "assistant_message_delta")).toMatchObject({
      source: "harness",
      message: "hello",
      payload: {
        kind: "assistant_message_delta",
        actor: "assistant",
        channel: "chat",
        protocol: "acp",
        activitySequence: 2,
        sequenceSource: "harness",
      },
    });
    expect(transcript.events.find((event) => event.eventType === "runtime_diagnostic")).toMatchObject({
      payload: { kind: "runtime_diagnostic", code: "hermes_acp_permission_denied", messagePreview: "permission denied" },
    });
    const projected = projectWebTranscript(transcript.events, { includeRunPrelude: false });
    expect(projected).toEqual(
      expect.arrayContaining([
        { kind: "assistant", ts: expect.any(String), text: "hello" },
        { kind: "user", ts: expect.any(String), from: "user", issue: "", text: "Do work" },
        { kind: "thinking", ts: expect.any(String), text: "thought preview" },
        expect.objectContaining({ kind: "tool_call", call_id: "call-1", name: "terminal", status: "succeeded", result: "tests passed" }),
        { kind: "status", state: "token_usage_reported", ts: expect.any(String), text: "Tokens: input 3 · output 5 · total 8" },
        { kind: "status", state: "runtime_diagnostic", ts: expect.any(String), text: "ACP permission denied" },
        { kind: "status", state: "run_succeeded", ts: expect.any(String), text: "Run completed" },
      ]),
    );
  });

  it("persists harness-provided ACP terminal failure and cancellation metadata through the shared orchestrator transcript path", async () => {
    const failed = await runTerminalRunActivityScenario(root, "failed");
    expect(failed.run).toMatchObject({ status: "failed", error: "Run failed token=[redacted]" });
    expect(failed.eventTypes).toContain("run_failed");
    expect(failed.eventTypes).not.toContain("failed");
    expect(failed.transcript.events.find((event) => event.eventType === "run_failed")).toMatchObject({
      message: "Run failed token=[redacted]",
      payload: { kind: "run_failed", actor: "runtime", channel: "terminal", protocol: "acp", reason: "provider_error" },
    });
    expect(failed.projected).toEqual(
      expect.arrayContaining([{ kind: "status", state: "run_failed", ts: expect.any(String), text: "Run failed token=[redacted]" }]),
    );
    expect(JSON.stringify(failed.transcript)).not.toContain("SECRET_TERMINAL_TOKEN");

    const cancelled = await runTerminalRunActivityScenario(root, "cancelled");
    expect(cancelled.run).toMatchObject({ status: "cancelled" });
    expect(cancelled.eventTypes).toContain("run_cancelled");
    expect(cancelled.eventTypes).not.toContain("cancelled");
    expect(cancelled.transcript.events.find((event) => event.eventType === "run_cancelled")).toMatchObject({
      message: "Run cancelled",
      payload: { kind: "run_cancelled", actor: "runtime", channel: "terminal", protocol: "acp", reason: "operator_cancelled" },
    });
    expect(cancelled.projected).toEqual(
      expect.arrayContaining([{ kind: "status", state: "run_cancelled", ts: expect.any(String), text: "Run cancelled" }]),
    );
  });

  it("records provider-limit gates without normal retry and resumes after the window closes", async () => {
    const config = testConfig(root);
    config.hermes.provider = "openai-codex";
    config.hermes.model = "gpt-5-test";
    const providerWindowMs = 3_000;
    const resumeAt = new Date(Date.now() + providerWindowMs).toISOString();
    const candidate = issue({ state: "Todo" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const harness = new ProviderLimitThenCompleteHarness({
      resumeAt,
      providerId: "openai-codex",
      model: "gpt-5-test",
    });
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      runStore,
    });

    await orchestrator.refreshNow();
    await waitFor(() => harness.runs.length === 1, "provider-limit run dispatched");
    await waitFor(() => orchestrator.snapshot().counts.running === 0, "provider-limit run exited");
    await waitFor(() => orchestrator.snapshot().providerGates.length === 1, "active provider-limit gate");
    const gatedSnapshot = orchestrator.snapshot();

    expect(gatedSnapshot.counts.retrying).toBe(0);
    expect(gatedSnapshot.providerGates[0]).toMatchObject({
      kind: "windowed_bucket_exhausted",
      resumePolicy: "auto_at_window_close",
      window: { resumeAt, windowKind: "codex_5h" },
      source: { issueIdentifier: "TEST-1", role: "worker", runPhase: "implementation" },
    });
    await expect(runStore.latestRunForIssue(candidate.id)).resolves.toMatchObject({
      status: "failed",
      providerLimit: {
        kind: "windowed_bucket_exhausted",
        window: { resumeAt },
      },
      failureKind: "provider_limit",
    });

    await orchestrator.refreshNow();
    expect(harness.runs).toHaveLength(1);
    const msUntilWindowCloses = Math.max(Date.parse(resumeAt) - Date.now() + 50, 0);
    if (msUntilWindowCloses > 0) {
      await new Promise((resolve) => setTimeout(resolve, msUntilWindowCloses));
    }
    await orchestrator.refreshNow();
    await waitFor(() => harness.runs.length === 2, "dispatch after provider window closes");
    await orchestrator.stop();
  });

  it("keeps ACP-sourced Hermes ACP provider-limit gates active when the configured provider is unknown", async () => {
    const config = testConfig(root);
    config.agent.harness = "hermes_acp";
    config.hermes.provider = null;
    config.hermes.model = "config-model-should-not-leak";
    const candidate = issue({ state: "Todo" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const harness = new ProviderLimitThenCompleteHarness(
      { providerId: "openrouter", model: "anthropic/claude-sonnet-acp" },
      "hermes_acp",
      { providerId: "openrouter", model: "anthropic/claude-sonnet-acp" },
    );
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      runStore,
    });

    await orchestrator.refreshNow();
    await waitFor(() => harness.runs.length === 1, "Hermes ACP provider-limit run dispatched");
    await waitFor(() => orchestrator.snapshot().providerGates.length === 1, "Hermes ACP provider gate recorded");
    await waitFor(() => orchestrator.snapshot().counts.running === 0, "Hermes ACP provider-limit run exited");

    expect(orchestrator.snapshot().providerGates[0]).toMatchObject({
      scope: { harnessId: "hermes_acp", providerId: "openrouter", model: "anthropic/claude-sonnet-acp" },
      resumePolicy: "manual",
    });
    await expect(runStore.latestRunForIssue(candidate.id)).resolves.toMatchObject({
      harnessId: "hermes_acp",
      status: "failed",
      runtimeModel: "anthropic/claude-sonnet-acp",
      runtimeSettingSources: ["host_hermes:PATH:hermes", "source_profile:active", "profile_prefix:symphony", "provider:openrouter"],
      providerLimit: {
        scope: { harnessId: "hermes_acp", providerId: "openrouter", model: "anthropic/claude-sonnet-acp" },
      },
      failureKind: "provider_limit",
    });

    await orchestrator.refreshNow();
    expect(harness.runs).toHaveLength(1);
    const gateId = orchestrator.snapshot().providerGates[0]!.id;
    await expect(orchestrator.clearProviderGate(gateId)).resolves.toMatchObject({ id: gateId });
    await orchestrator.refreshNow();
    await waitFor(() => harness.runs.length === 2, "Hermes ACP dispatch after provider gate clear");
    await orchestrator.stop();
  });

  it("keeps manual provider-limit gates active until the operator clears them", async () => {
    const config = testConfig(root);
    config.hermes.provider = "openai-codex";
    const candidate = issue({ state: "Todo" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const harness = new ProviderLimitThenCompleteHarness({ providerId: "openai-codex" });
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
    });

    await orchestrator.refreshNow();
    await waitFor(() => orchestrator.snapshot().providerGates.length === 1, "manual provider gate");
    const gateId = orchestrator.snapshot().providerGates[0]!.id;

    await orchestrator.refreshNow();
    expect(harness.runs).toHaveLength(1);
    await expect(orchestrator.clearProviderGate(gateId)).resolves.toMatchObject({ id: gateId });
    await orchestrator.refreshNow();
    await waitFor(() => harness.runs.length === 2, "dispatch after manual gate clear");
    await orchestrator.stop();
  });

  it("runs issue breakdown planning before implementation and injects the plan", async () => {
    const config = testConfig(root);
    config.issueBreakdown.enabled = true;
    config.issueBreakdown.promptTemplate = "Plan {{ issue.identifier }}";
    config.issueBreakdown.planningLabels = ["planning"];
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    const candidate = issue({ state: "Todo", labels: ["planning"], updatedAt: "2026-01-02T00:00:00Z" });
    let currentState = "Todo";
    let updatedAt = "2026-01-02T00:00:00Z";
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [{ ...candidate, state: currentState, updatedAt }];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([{ ...candidate, state: currentState, updatedAt }], states);
      },
      async fetchIssueStatesByIds() {
        return [{ ...candidate, state: currentState, updatedAt }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const harness = new IssueBreakdownAcceptingHarness(lifecycleStore);
    const writer = new StateChangingWriter((state) => {
      currentState = state;
      updatedAt = "2026-01-02T00:01:00Z";
    });
    const writeback = new WritebackProcessor(new FileWritebackOutboxStore(config.workspace.stateDir), writer, logger, 300_000);
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
      writeback,
    });

    await orchestrator.refreshNow();
    await waitFor(() => harness.runs.length === 1);
    await waitFor(() => orchestrator.snapshot().counts.running === 0);
    await waitForAsync(
      async () => ((await lifecycleStore.get(candidate.id))?.issueBreakdownPlans.length ?? 0) === 1,
      "persisted issue breakdown plan",
    );
    await settleOrchestratorExit();
    expect(writer.transitions).toEqual([]);
    await waitForAsync(async () => {
      await orchestrator.refreshNow();
      return harness.runs.length === 2;
    }, "implementation dispatch after accepted plan", 5_000);
    await waitFor(() => orchestrator.snapshot().counts.running === 0);

    await orchestrator.refreshNow();
    await settleOrchestratorExit();
    await orchestrator.stop();

    expect(writer.transitions.map((transition) => transition.toState)).toEqual(["In Progress"]);
    expect(harness.runs[0]?.ctx.runPhase).toBe("issue_breakdown");
    expect(harness.runs[0]?.ctx.role).toBe("planner");
    expect(harness.runs[0]?.prompt).toContain("Plan TEST-1");
    expect(harness.runs[0]?.prompt).toContain("submit_issue_breakdown_plan");
    expect(harness.runs[1]?.ctx.runPhase).toBe("implementation");
    expect(harness.runs[1]?.ctx.role).toBe("worker");
    expect(harness.runs.filter((run) => run.ctx.runPhase === "issue_breakdown")).toHaveLength(1);
    expect(harness.runs[1]?.prompt).toContain("Work on TEST-1");
    expect(harness.runs[1]?.prompt).toContain("Issue breakdown plan:");
    expect(harness.runs[1]?.prompt).toContain("Create implementation task");
    await expect(runStore.latestRunForIssue(candidate.id, { role: "planner", runPhase: "issue_breakdown" })).resolves.toMatchObject({
      runPhase: "issue_breakdown",
      runKind: "planning",
    });
    await expect(runStore.latestRunForIssue(candidate.id, { role: "worker", runPhase: "implementation" })).resolves.toMatchObject({
      runPhase: "implementation",
      runKind: "implementation",
    });
  }, 10_000);

  it("does not apply accepted issue breakdown plans during normal dispatch", async () => {
    const config = testConfig(root);
    config.issueBreakdown.enabled = true;
    config.issueBreakdown.applyToLinear.enabled = true;
    config.issueBreakdown.promptTemplate = "Plan {{ issue.identifier }}";
    config.issueBreakdown.planningLabels = ["planning"];
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    const candidate = issue({ state: "Todo", labels: ["planning"], updatedAt: "2026-01-02T00:00:00Z" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const harness = new IssueBreakdownAcceptingHarness(lifecycleStore);
    const writer = new StateChangingWriter(() => undefined);
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore: new FileRunTranscriptStore(config.workspace.stateDir),
      writeback: new WritebackProcessor(new FileWritebackOutboxStore(config.workspace.stateDir), writer, logger, 300_000),
    });

    await orchestrator.refreshNow();
    await waitFor(() => harness.runs.length === 1);
    await waitFor(() => orchestrator.snapshot().counts.running === 0);
    await settleOrchestratorExit();
    await orchestrator.refreshNow();
    await settleOrchestratorExit();
    await orchestrator.stop();

    const lifecycle = await lifecycleStore.get(candidate.id);
    expect(writer.issueCreates).toEqual([]);
    expect(harness.runs.filter((run) => run.ctx.runPhase === "implementation")).toHaveLength(0);
    expect(lifecycle?.issueBreakdownPlans[0]?.applicationStatus).toBe("not_requested");
    expect(lifecycle?.issueBreakdownPlans[0]?.createdIssueRefs).toEqual([]);
  }, 10_000);

  it("startup processDue skips superseded issue breakdown children, relations, and comments", async () => {
    const fixture = await createIssueBreakdownStartupFixture(root, { scenario: "superseded" });

    await fixture.orchestrator.start();
    await fixture.orchestrator.stop();
    const lifecycle = await fixture.lifecycleStore.get(fixture.parentIssue.id);
    const planA = lifecycle?.issueBreakdownPlans.find((plan) => plan.id === fixture.supersededPlan.id);

    for (const key of fixture.replayOperationKeys) {
      await expect(fixture.outboxStore.get(key)).resolves.toMatchObject({
        status: "skipped",
        lastError: ISSUE_BREAKDOWN_WRITEBACK_NOT_CURRENT_REASON,
        resultMessage: ISSUE_BREAKDOWN_WRITEBACK_NOT_CURRENT_REASON,
      });
    }
    await expectStartupReplayActivitySkipReasons(fixture, {
      code: "issue_breakdown_plan_not_current",
      message: "Issue breakdown writeback is not bound to the current plan.",
    });
    expect(fixture.writer.issueCreates).toEqual([]);
    expect(fixture.writer.issueRelations).toEqual([]);
    expect(fixture.writer.comments).toEqual([]);
    expect(lifecycle?.lastIssueBreakdownPlanId).toBe(fixture.currentPlan?.id);
    expect(planA).toMatchObject({ applicationStatus: "pending", applicationBlockedReason: null });
  });

  it("startup processDue skips drifted issue breakdown replay without marking the plan stale", async () => {
    const fixture = await createIssueBreakdownStartupFixture(root, { scenario: "drifted" });

    await fixture.orchestrator.start();
    await fixture.orchestrator.stop();
    const lifecycle = await fixture.lifecycleStore.get(fixture.parentIssue.id);
    const plan = lifecycle?.issueBreakdownPlans.find((candidatePlan) => candidatePlan.id === fixture.supersededPlan.id);

    for (const key of fixture.replayOperationKeys) {
      await expect(fixture.outboxStore.get(key)).resolves.toMatchObject({
        status: "skipped",
        lastError: ISSUE_BREAKDOWN_PLAN_STALE_REASON,
        resultMessage: ISSUE_BREAKDOWN_PLAN_STALE_REASON,
      });
    }
    await expectStartupReplayActivitySkipReasons(fixture, {
      code: "issue_breakdown_plan_stale",
      message: "Issue breakdown plan is no longer fresh.",
    });
    expect(fixture.writer.issueCreates).toEqual([]);
    expect(fixture.writer.issueRelations).toEqual([]);
    expect(fixture.writer.comments).toEqual([]);
    expect(plan?.applicationStatus).toBe("pending");
    expect(plan?.applicationBlockedReason).toBeNull();
    expect(plan?.applicationStatus).not.toBe("stale");
  });

  it("startup processDue still applies fresh current issue breakdown work", async () => {
    const fixture = await createIssueBreakdownStartupFixture(root, { scenario: "fresh" });

    await fixture.orchestrator.start();
    await fixture.orchestrator.stop();

    for (const key of fixture.replayOperationKeys) {
      await expect(fixture.outboxStore.get(key)).resolves.toMatchObject({ status: "succeeded" });
    }
    expect(fixture.writer.issueCreates).toHaveLength(1);
    expect(fixture.writer.issueRelations).toHaveLength(1);
    expect(fixture.writer.comments).toHaveLength(1);
  });

  it("does not reroute implementation dispatch inside writeback execution when writeback reveals stale issue content", async () => {
    const config = testConfig(root);
    config.issueBreakdown.enabled = true;
    config.issueBreakdown.promptTemplate = "Plan {{ issue.identifier }}";
    config.issueBreakdown.planningLabels = ["planning"];
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    const candidate = issue({
      state: "Todo",
      labels: ["planning"],
      title: "Original work",
      updatedAt: "2026-01-02T00:00:00Z",
    });
    let currentState = "Todo";
    let currentTitle = "Original work";
    let updatedAt = "2026-01-02T00:00:00Z";
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [{ ...candidate, state: currentState, title: currentTitle, updatedAt }];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([{ ...candidate, state: currentState, title: currentTitle, updatedAt }], states);
      },
      async fetchIssueStatesByIds() {
        return [{ ...candidate, state: currentState, title: currentTitle, updatedAt }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const harness = new IssueBreakdownAcceptingHarness(lifecycleStore);
    const writer = new StateChangingWriter((state) => {
      currentState = state;
      currentTitle = "Edited during dispatch";
      updatedAt = "2026-01-02T00:01:00Z";
    });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore: new FileRunTranscriptStore(config.workspace.stateDir),
      writeback: new WritebackProcessor(new FileWritebackOutboxStore(config.workspace.stateDir), writer, logger, 300_000),
    });

    await orchestrator.refreshNow();
    await waitFor(() => harness.runs.length === 1);
    await waitFor(() => orchestrator.snapshot().counts.running === 0);
    await waitForAsync(
      async () => ((await lifecycleStore.get(candidate.id))?.issueBreakdownPlans.length ?? 0) === 1,
      "persisted issue breakdown plan",
    );
    await settleOrchestratorExit();
    await orchestrator.refreshNow();
    await waitFor(() => writer.transitions.length === 1, "dispatch writeback applied", 10_000);
    await waitFor(
      () =>
        harness.runs.length === 2 ||
        orchestrator
          .snapshot()
          .running.some(
            (run) => run.issueId === candidate.id && run.role === "worker" && run.runPhase === "implementation",
          ),
      "stale post-writeback implementation dispatch",
      10_000,
    );
    await waitFor(() => harness.runs.length === 2, "stale post-writeback implementation harness run", 10_000);
    await waitFor(() => orchestrator.snapshot().counts.running === 0, "stale post-writeback implementation completion", 10_000);
    await orchestrator.stop();

    const lifecycle = await lifecycleStore.get(candidate.id);
    expect(writer.transitions.map((transition) => transition.toState)).toEqual(["In Progress"]);
    expect(harness.runs[0]?.ctx.runPhase).toBe("issue_breakdown");
    expect(harness.runs[1]?.ctx.runPhase).toBe("implementation");
    expect(lifecycle?.planningFailureCount).toBe(0);
  }, 30_000);

  it("routes worker dispatch to planning when only a superseded plan matches the issue", async () => {
    const config = testConfig(root);
    config.issueBreakdown.enabled = true;
    config.issueBreakdown.promptTemplate = "Plan {{ issue.identifier }}";
    config.issueBreakdown.planningLabels = ["planning"];
    const candidate = issue({
      state: "Todo",
      labels: ["planning"],
      title: "Original work",
      updatedAt: "2026-01-02T00:00:00Z",
    });
    const changed = { ...candidate, title: "Changed work", updatedAt: "2026-01-02T00:05:00Z" };
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    await submitTwoChildPlan(config, lifecycleStore, candidate, "plan-a", "run-plan-a");
    await submitTwoChildPlan(config, lifecycleStore, changed, "plan-b", "run-plan-b");
    const harness = new FakeHarness();
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore: new FileRunTranscriptStore(config.workspace.stateDir),
    });

    await orchestrator.refreshNow();
    await waitFor(() => harness.runs.length === 1);
    await waitFor(() => orchestrator.snapshot().counts.running === 0);
    await settleOrchestratorExit();
    await orchestrator.stop();

    expect(harness.runs[0]?.ctx.runPhase).toBe("issue_breakdown");
    expect(harness.runs[0]?.prompt).toContain("Plan TEST-1");
    expect(harness.runs[0]?.prompt).not.toContain("Issue breakdown plan:");
  });

  it("queues explicit issue breakdown planning when the only matching plan is superseded", async () => {
    const config = testConfig(root);
    config.issueBreakdown.enabled = true;
    config.issueBreakdown.promptTemplate = "Plan {{ issue.identifier }}";
    const candidate = issue({
      state: "Todo",
      title: "Original work",
      updatedAt: "2026-01-02T00:00:00Z",
    });
    const changed = { ...candidate, title: "Changed work", updatedAt: "2026-01-02T00:05:00Z" };
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    await submitTwoChildPlan(config, lifecycleStore, candidate, "plan-a", "run-plan-a");
    await submitTwoChildPlan(config, lifecycleStore, changed, "plan-b", "run-plan-b");
    const harness = new FakeHarness();
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore: new FileRunTranscriptStore(config.workspace.stateDir),
    });

    const result = await orchestrator.requestIssueBreakdown(candidate.id);
    await waitFor(() => harness.runs.length === 1);
    await waitFor(() => orchestrator.snapshot().counts.running === 0);
    await settleOrchestratorExit();
    await orchestrator.stop();

    expect(result).toMatchObject({ queued: true, reason: "explicit_request" });
    expect(harness.runs[0]?.ctx.runPhase).toBe("issue_breakdown");
  });

  it("allows issue breakdown planning when implementation incomplete-turn limits are exhausted", async () => {
    const config = testConfig(root);
    config.issueBreakdown.enabled = true;
    config.issueBreakdown.promptTemplate = "Plan {{ issue.identifier }}";
    config.issueBreakdown.planningLabels = ["planning"];
    config.reviewLoop.maxIncompleteTurns = 2;
    const candidate = issue({ state: "Todo", labels: ["planning"], updatedAt: "2026-01-02T00:00:00Z" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    await lifecycleStore.ensureIssue(candidate, { incompleteTurnCount: 2 });
    const harness = new IssueBreakdownAcceptingHarness(lifecycleStore);
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore: new FileRunTranscriptStore(config.workspace.stateDir),
    });

    await orchestrator.refreshNow();
    await waitFor(() => harness.runs.length === 1);
    await orchestrator.stop();

    expect(harness.runs[0]?.ctx.runPhase).toBe("issue_breakdown");
    expect(harness.runs[0]?.prompt).toContain("Plan TEST-1");
  });

  it("[event-guard:completed] treats accepted issue breakdown plans as succeeded when the harness completes after submitting", async () => {
    const result = await runAcceptedIssueBreakdownHandoffScenario(root, { type: "completed" });
    const transcript = await result.runStore.readTranscript(result.planRunId);
    const eventTypes = transcript.events.map((event) => event.eventType);

    expect(eventTypes).toEqual(
      expect.arrayContaining(["session_started", "handoff_terminal", "completed"]),
    );
    await expectReplaySucceededFromHandoff(result.stateDir, result.planRunId, {
      runPhase: "issue_breakdown",
      runKind: "planning",
    });
  });

  it("[event-guard:failed] treats accepted issue breakdown plans as succeeded when the harness fails after submitting", async () => {
    const result = await runAcceptedIssueBreakdownHandoffScenario(root, {
      type: "failed",
      error: "post-plan harness failure",
    });
    const transcript = await result.runStore.readTranscript(result.planRunId);
    const eventTypes = transcript.events.map((event) => event.eventType);

    expect(eventTypes).toContain("session_started");
    expect(eventTypes).toContain("handoff_terminal");
    expect(transcript.events.find((event) => event.eventType === "handoff_terminal")?.payload).toMatchObject({
      kind: "issue_breakdown_plan",
      status: "succeeded",
    });
    expect(eventTypes).toContain("failed");
    expect(eventTypes).not.toContain("completed");
    await expectReplaySucceededFromHandoff(result.stateDir, result.planRunId, {
      runPhase: "issue_breakdown",
      runKind: "planning",
    });
  });

  it("[event-guard:cancelled] treats accepted issue breakdown plans as succeeded when the harness is cancelled after submitting", async () => {
    const result = await runAcceptedIssueBreakdownHandoffScenario(root, { type: "cancelled" });
    const transcript = await result.runStore.readTranscript(result.planRunId);
    const eventTypes = transcript.events.map((event) => event.eventType);

    expect(eventTypes).toContain("session_started");
    expect(eventTypes).toContain("handoff_terminal");
    expect(transcript.events.find((event) => event.eventType === "handoff_terminal")?.payload).toMatchObject({
      kind: "issue_breakdown_plan",
      status: "succeeded",
    });
    expect(eventTypes).toContain("cancelled");
    expect(eventTypes).not.toContain("completed");
    await expectReplaySucceededFromHandoff(result.stateDir, result.planRunId, {
      runPhase: "issue_breakdown",
      runKind: "planning",
    });
  });

  it("[exit-guard:throw] terminalizes accepted planning runs when the harness throws after submitting without a terminal event", async () => {
    const result = await runAcceptedIssueBreakdownHandoffScenario(root, "throw");
    const transcript = await result.runStore.readTranscript(result.planRunId);
    const eventTypes = transcript.events.map((event) => event.eventType);

    expect(eventTypes).toContain("session_started");
    expect(eventTypes).toContain("handoff_terminal");
    expect(transcript.events.find((event) => event.eventType === "handoff_terminal")?.payload).toMatchObject({
      kind: "issue_breakdown_plan",
      status: "succeeded",
    });
    expect(eventTypes).not.toContain("failed");
    expect(eventTypes).not.toContain("cancelled");
    expect(eventTypes).not.toContain("completed");
    await expectReplaySucceededFromHandoff(result.stateDir, result.planRunId, {
      runPhase: "issue_breakdown",
      runKind: "planning",
    });
  });

  it("[replay:planning-no-plan] records durable failed state when issue breakdown completes without a submitted plan", async () => {
    const config = testConfig(root);
    config.issueBreakdown.enabled = true;
    config.issueBreakdown.promptTemplate = "Plan {{ issue.identifier }}";
    config.issueBreakdown.planningLabels = ["planning"];
    config.issueBreakdown.maxPlanningFailures = 3;
    const candidate = issue({ state: "Todo", labels: ["planning"], updatedAt: "2026-01-02T00:00:00Z" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const harness = new IssueBreakdownRejectingHarness();
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
    });

    await orchestrator.refreshNow();
    await waitFor(() => harness.runs.length === 1);
    const run = await waitForTerminalRunRecord(runStore, "rejecting-plan-run-1");
    await waitForAsync(async () => (await lifecycleStore.get(candidate.id))?.planningFailureCount === 1);
    await settleOrchestratorExit();
    await waitForAsync(async () => {
      const current = await runStore.readTranscript("rejecting-plan-run-1");
      return current.events.some((event) => event.eventType === "planning_run_failed");
    }, "planning failure transcript event");
    const transcript = await runStore.readTranscript("rejecting-plan-run-1");
    await orchestrator.stop();

    const eventTypes = transcript.events.map((event) => event.eventType);
    const planningEventTypes = eventTypes.filter((eventType) =>
      ["session_started", "completed", "failed", "cancelled", "planning_run_failed"].includes(eventType),
    );
    expect(planningEventTypes).toEqual(["session_started", "completed", "planning_run_failed"]);
    expect(transcript.events.find((event) => event.eventType === "planning_run_failed")?.payload).toMatchObject({
      status: "failed",
      error: "Planning run completed without submit_issue_breakdown_plan",
      planningFailureCount: 1,
    });
    expect(run).toMatchObject({
      status: "failed",
      error: "Planning run completed without submit_issue_breakdown_plan",
      runPhase: "issue_breakdown",
      runKind: "planning",
      failureKind: "planning_run_failed",
      failureDiagnosticCode: "planning_run_failed",
      failureDiagnosticMessage: "Planning run completed without submit_issue_breakdown_plan",
    });
    await expectReplayFailedFromPlanningFailure(
      config.workspace.stateDir,
      "rejecting-plan-run-1",
      "Planning run completed without submit_issue_breakdown_plan",
    );
    const lifecycle = await lifecycleStore.get(candidate.id);
    expect(lifecycle?.lastPlanningFailureRunId).toBe("rejecting-plan-run-1");
    expect(lifecycle?.incompleteTurnCount).toBe(0);
  });

  it("[replay:planning-no-plan] records durable failed state when issue breakdown fails or throws before submitting a plan", async () => {
    for (const scenario of [
      {
        terminal: { type: "failed", error: "planning harness reported failure" } as const,
        expectedRunId: "no-plan-terminal-run-1",
        expectedEvents: ["session_started", "failed", "planning_run_failed"],
        expectedError: "planning harness reported failure",
      },
      {
        terminal: "throw" as const,
        expectedRunId: "no-plan-terminal-run-1",
        expectedEvents: ["session_started", "planning_run_failed"],
        expectedError: "planning harness threw before submitting a plan",
      },
    ]) {
      const scenarioRoot = path.join(root, `no-plan-${typeof scenario.terminal === "string" ? scenario.terminal : scenario.terminal.type}`);
      const config = testConfig(scenarioRoot);
      config.issueBreakdown.enabled = true;
      config.issueBreakdown.promptTemplate = "Plan {{ issue.identifier }}";
      config.issueBreakdown.planningLabels = ["planning"];
      config.issueBreakdown.maxPlanningFailures = 3;
      const candidate = issue({ state: "Todo", labels: ["planning"], updatedAt: "2026-01-02T00:00:00Z" });
      const tracker: TrackerClient = {
        async fetchCandidateIssues() {
          return [candidate];
        },
        async fetchIssuesByStates(states) {
          return issuesInStates([candidate], states);
        },
        async fetchIssueStatesByIds() {
          return [candidate];
        },
      };
      const logger = new StructuredLogger(() => undefined);
      const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
      const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
      const harness = new IssueBreakdownNoPlanTerminalHarness(scenario.terminal);
      const orchestrator = new Orchestrator({
        config,
        tracker,
        workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
        harness,
        logger,
        promptTemplate: "Work on {{ issue.identifier }}",
        lifecycleStore,
        runStore,
      });

      await orchestrator.refreshNow();
      await waitFor(() => harness.runs.length === 1);
      await waitForTerminalRunRecord(runStore, scenario.expectedRunId);
      await waitForAsync(async () => (await lifecycleStore.get(candidate.id))?.planningFailureCount === 1);
      await settleOrchestratorExit();
      const transcript = await runStore.readTranscript(scenario.expectedRunId);
      await orchestrator.stop();

      const scenarioEventTypes = transcript.events
        .map((event) => event.eventType)
        .filter((eventType) => ["session_started", "completed", "failed", "cancelled", "planning_run_failed"].includes(eventType));
      expect(scenarioEventTypes).toEqual(scenario.expectedEvents);
      await expectReplayFailedFromPlanningFailure(config.workspace.stateDir, scenario.expectedRunId, scenario.expectedError);
      const lifecycle = await lifecycleStore.get(candidate.id);
      expect(lifecycle?.lastPlanningFailureRunId).toBe(scenario.expectedRunId);
      expect(lifecycle?.incompleteTurnCount).toBe(0);
    }
  });

  it("blocks repeated issue breakdown failures without incrementing implementation incomplete turns", async () => {
    const config = testConfig(root);
    config.issueBreakdown.enabled = true;
    config.issueBreakdown.promptTemplate = "Plan {{ issue.identifier }}";
    config.issueBreakdown.planningLabels = ["planning"];
    config.issueBreakdown.maxPlanningFailures = 1;
    config.reviewLoop.maxIncompleteTurns = 2;
    const candidate = issue({ state: "Todo", labels: ["planning"], updatedAt: "2026-01-02T00:00:00Z" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    await lifecycleStore.ensureIssue(candidate, { incompleteTurnCount: 2 });
    const harness = new IssueBreakdownRejectingHarness();
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore: new FileRunTranscriptStore(config.workspace.stateDir),
    });

    await orchestrator.refreshNow();
    await waitFor(() => harness.runs.length === 1);
    await waitFor(() => orchestrator.snapshot().counts.running === 0);
    await orchestrator.refreshNow();
    await settleOrchestratorExit();
    await orchestrator.stop();

    const lifecycle = await lifecycleStore.get(candidate.id);
    expect(harness.runs).toHaveLength(1);
    expect(lifecycle?.planningFailureCount).toBe(1);
    expect(lifecycle?.incompleteTurnCount).toBe(2);
    expect(lifecycle?.phase).toBe("blocked");
    expect(lifecycle?.blockedReason).toBe("max planning failures reached (1/1)");
    expect(lifecycle?.lastPlanningFailureRunId).toBe("rejecting-plan-run-1");
  });

  it("honors durable planning backoff after a non-submitting planning run", async () => {
    const config = testConfig(root);
    config.issueBreakdown.enabled = true;
    config.issueBreakdown.promptTemplate = "Plan {{ issue.identifier }}";
    config.issueBreakdown.planningLabels = ["planning"];
    config.issueBreakdown.maxPlanningFailures = 3;
    config.issueBreakdown.planningRetryBaseMs = 10_000;
    config.issueBreakdown.planningRetryMaxMs = 10_000;
    const candidate = issue({ state: "Todo", labels: ["planning"], updatedAt: "2026-01-02T00:00:00Z" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const harness = new IssueBreakdownRejectingHarness();
    const first = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore: new FileRunTranscriptStore(config.workspace.stateDir),
    });

    await first.refreshNow();
    await waitFor(() => harness.runs.length === 1);
    await waitFor(() => first.snapshot().counts.running === 0);
    await waitForAsync(async () => (await lifecycleStore.get(candidate.id))?.planningFailureCount === 1);
    await settleOrchestratorExit();
    await first.stop();

    const second = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore: new FileRunTranscriptStore(config.workspace.stateDir),
    });

    await second.refreshNow();
    await settleOrchestratorExit();
    expect(harness.runs).toHaveLength(1);
    await lifecycleStore.updateIssue(candidate, { lastPlanningFailureAt: "2000-01-01T00:00:00.000Z" });
    await second.refreshNow();
    await waitFor(() => harness.runs.length === 2, "planning retry after durable backoff");
    await waitFor(() => second.snapshot().counts.running === 0);
    await waitForAsync(async () => (await lifecycleStore.get(candidate.id))?.planningFailureCount === 2);
    await settleOrchestratorExit();
    await second.stop();

    const lifecycle = await lifecycleStore.get(candidate.id);
    expect(lifecycle?.planningFailureCount).toBe(2);
    expect(lifecycle?.incompleteTurnCount).toBe(0);
  });

  it("blocks bounded planning dispatch retries without burning implementation incomplete turns", async () => {
    const config = testConfig(root);
    config.issueBreakdown.enabled = true;
    config.issueBreakdown.promptTemplate = "Plan {{ issue.identifier }}";
    config.issueBreakdown.planningLabels = ["planning"];
    config.issueBreakdown.maxPlanningFailures = 3;
    config.issueBreakdown.maxPlanningDispatchRetries = 1;
    config.issueBreakdown.planningRetryBaseMs = 20;
    config.issueBreakdown.planningRetryMaxMs = 20;
    const candidate = issue({ state: "Todo", labels: ["planning"], updatedAt: "2026-01-02T00:00:00Z" });
    let currentState = "Todo";
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [{ ...candidate, state: currentState }];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([{ ...candidate, state: currentState }], states);
      },
      async fetchIssueStatesByIds() {
        return [{ ...candidate, state: currentState }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const harness = new IssueBreakdownRejectingHarness();
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore: new FileRunTranscriptStore(config.workspace.stateDir),
    });

    await orchestrator.refreshNow();
    await waitFor(() => harness.runs.length === 1);
    await waitFor(() => orchestrator.snapshot().counts.running === 0);
    currentState = "Blocked";
    await waitForAsync(async () => {
      try {
        return (await lifecycleStore.get(candidate.id))?.phase === "blocked";
      } catch {
        return false;
      }
    }, "planning dispatch retry block", 2_000);
    await orchestrator.stop();

    const lifecycle = await lifecycleStore.get(candidate.id);
    expect(harness.runs).toHaveLength(1);
    expect(lifecycle?.planningFailureCount).toBe(1);
    expect(lifecycle?.planningDispatchRetryCount).toBe(1);
    expect(lifecycle?.incompleteTurnCount).toBe(0);
    expect(lifecycle?.blockedReason).toBe("max planning dispatch retries reached (1/1)");
  });

  it("does not route planning-labeled issues to implementation when planning persistence is missing", async () => {
    const config = testConfig(root);
    config.issueBreakdown.enabled = true;
    config.issueBreakdown.promptTemplate = "Plan {{ issue.identifier }}";
    config.issueBreakdown.planningLabels = ["planning"];
    const candidate = issue({ state: "Todo", labels: ["planning"] });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const harness = new FakeHarness();
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
    });

    await orchestrator.refreshNow();
    await settleOrchestratorExit();
    await orchestrator.stop();

    expect(harness.runs).toHaveLength(0);
  });

  it("rejects explicit issue breakdown requests without lifecycle persistence", async () => {
    const config = testConfig(root);
    config.issueBreakdown.enabled = true;
    const candidate = issue({ state: "Todo" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness: new FakeHarness(),
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
    });

    await expect(orchestrator.requestIssueBreakdown(candidate.id)).rejects.toMatchObject({
      code: "invalid_request",
    });
    await orchestrator.stop();
  });

  it("adds scoped Symphony MCP completion instructions to runtime worker prompts", async () => {
    const config = testConfig(root);
    const candidate = issue({ state: "Todo", branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const harness = new CursorPromptHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
    });

    await orchestrator.refreshNow();
    await waitFor(() => harness.prompts.length === 1);
    await orchestrator.stop();

    expect(harness.prompts[0]).toContain("Work on TEST-1");
    expect(harness.prompts[0]).toContain("Symphony MCP completion handoff");
    expect(harness.prompts[0]).toContain("Active issue: TEST-1 (issue-1)");
    expect(harness.prompts[0]).toContain("call the submit_completion_report MCP tool");
    expect(harness.prompts[0]).toContain("Symphony injects runId and issueId");
    expect(harness.prompts[0]).toContain("Do not comment on Linear");
  });

  it("fails before worker dispatch when the runtime harness lacks MCP handoff support", async () => {
    const config = testConfig(root);
    const candidate = issue({ state: "Todo", branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logEntries: unknown[] = [];
    const logger = new StructuredLogger((entry) => logEntries.push(entry));
    const harness = new NonMcpHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
    });

    await orchestrator.refreshNow();
    await waitFor(() => orchestrator.snapshot().retrying.length === 1);
    const snapshot = orchestrator.snapshot();
    await orchestrator.stop();

    expect(harness.prompts).toEqual([]);
    expect(JSON.stringify(logEntries) + JSON.stringify(snapshot.retrying)).toContain(
      "Runtime harness no-mcp does not support Symphony MCP handoff required for implementation",
    );
  });

  it("revalidates issue state before dispatch", async () => {
    const config = testConfig(root);
    const candidate = issue({ state: "Todo" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [{ ...candidate, state: "Done" }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const harness = new FakeHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await orchestrator.stop();

    expect(harness.runs).toHaveLength(0);
  });

  it("skips issues no longer routed to this worker", async () => {
    const config = testConfig(root);
    const candidate = issue({ state: "Todo" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [{ ...candidate, assignedToWorker: false }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const harness = new FakeHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await orchestrator.stop();

    expect(harness.runs).toHaveLength(0);
  });

  it("skips issues with refreshed open blockers", async () => {
    const config = testConfig(root);
    const candidate = issue({ state: "Todo" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [{ ...candidate, blockedBy: [{ id: "blocker", identifier: "TEST-0", state: null }] }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const harness = new FakeHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await orchestrator.stop();

    expect(harness.runs).toHaveLength(0);
  });

  it("skips issues without required dispatch labels", async () => {
    const config = testConfig(root);
    config.agent.requireLabels = ["dogfood-ready"];
    const candidate = issue({ state: "Todo", labels: ["dogfood"] });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const harness = new FakeHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await orchestrator.stop();

    expect(harness.runs).toHaveLength(0);
  });

  it("skips worker dispatch for worker-scoped excluded labels", async () => {
    const config = testConfig(root);
    config.agent.requireLabels = ["dogfood-ready"];
    config.agent.workerExcludeLabels = ["review_only"];
    const candidate = issue({ state: "Todo", labels: ["dogfood-ready", "review_only"] });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const harness = new FakeHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await orchestrator.stop();

    expect(harness.runs).toHaveLength(0);
  });

  it("skips worker dispatch for parent issues with children", async () => {
    const config = testConfig(root);
    const candidate = issue({ state: "Todo", hasChildren: true });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const harness = new FakeHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await orchestrator.stop();

    expect(harness.runs).toHaveLength(0);
  });

  it("does not retry after a handoff state", async () => {
    const config = testConfig(root);
    config.tracker.handoffStates = ["Human Review"];
    const candidate = issue({ state: "Todo", labels: ["dogfood-ready"] });
    let refreshes = 0;
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        refreshes += 1;
        return [refreshes === 1 ? candidate : { ...candidate, state: "Human Review" }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const harness = new FakeHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await orchestrator.stop();

    expect(harness.runs).toHaveLength(1);
    expect(orchestrator.snapshot().counts.retrying).toBe(0);
  });

  it("uses service-owned writeback for dispatch and turn-completed comments without handoff", async () => {
    const config = testConfig(root);
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.tracker.handoffStates = ["Human Review"];
    const candidate = issue({ state: "Todo", labels: ["dogfood-ready"] });
    let currentState = "Todo";
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [{ ...candidate, state: currentState }];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([{ ...candidate, state: currentState }], states);
      },
      async fetchIssueStatesByIds() {
        return [{ ...candidate, state: currentState }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const writer = new StateChangingWriter((state) => {
      currentState = state;
    });
    const writeback = new WritebackProcessor(
      new FileWritebackOutboxStore(path.join(root, "state")),
      writer,
      logger,
      300_000,
    );
    const harness = new FakeHarness();
    const lifecycleStore = new FileIssueLifecycleStore(path.join(root, "state"));
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      writeback,
      lifecycleStore,
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await orchestrator.stop();

    expect(harness.runs).toHaveLength(1);
    expect(currentState).toBe("In Progress");
    expect(writer.transitions.map((transition) => transition.toState)).toEqual(["In Progress"]);
    expect(writer.comments.map((comment) => comment.dedupeKey)).toEqual([
      "fake-issue-1-1:run-started",
      "fake-issue-1-1:run-succeeded",
    ]);
    expect(writer.comments[1]?.body).toContain("worker turn completed");
    expect(writer.comments[1]?.body).toContain("not been marked ready for review");
    await expect(lifecycleStore.get(candidate.identifier)).resolves.toMatchObject({
      incompleteTurnCount: 1,
    });
    expect(orchestrator.snapshot().counts.retrying).toBe(0);
  });

  it("records max-turn exhaustion as incomplete turns instead of handoff", async () => {
    const config = testConfig(root);
    config.agent.maxTurns = 2;
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.tracker.handoffStates = ["In Review"];
    const candidate = issue({ state: "Todo", labels: ["dogfood-ready"] });
    let currentState = "Todo";
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [{ ...candidate, state: currentState }];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([{ ...candidate, state: currentState }], states);
      },
      async fetchIssueStatesByIds() {
        return [{ ...candidate, state: currentState }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const writer = new StateChangingWriter((state) => {
      currentState = state;
    });
    const writeback = new WritebackProcessor(
      new FileWritebackOutboxStore(path.join(root, "state")),
      writer,
      logger,
      300_000,
    );
    const harness = new FakeHarness();
    const lifecycleStore = new FileIssueLifecycleStore(path.join(root, "state"));
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      writeback,
      lifecycleStore,
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await orchestrator.stop();

    expect(harness.runs).toHaveLength(2);
    expect(currentState).toBe("In Progress");
    expect(writer.transitions.map((transition) => transition.toState)).toEqual(["In Progress"]);
    await expect(lifecycleStore.get(candidate.identifier)).resolves.toMatchObject({
      incompleteTurnCount: 2,
    });
  });

  it("blocks a worker after the max incomplete turn ceiling", async () => {
    const config = testConfig(root);
    config.agent.maxTurns = 5;
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.tracker.handoffStates = ["Human Review"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.reviewLoop.blockedStates = ["Blocked"];
    config.reviewLoop.maxIncompleteTurns = 2;
    const candidate = issue({ state: "Todo", labels: ["dogfood-ready"] });
    let currentState = "Todo";
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [{ ...candidate, state: currentState }];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([{ ...candidate, state: currentState }], states);
      },
      async fetchIssueStatesByIds() {
        return [{ ...candidate, state: currentState }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const writer = new StateChangingWriter((state) => {
      currentState = state;
    });
    const stateDir = config.workspace.stateDir;
    const writeback = new WritebackProcessor(new FileWritebackOutboxStore(stateDir), writer, logger, 300_000);
    const harness = new FakeHarness();
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      writeback,
      lifecycleStore,
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await orchestrator.stop();

    expect(harness.runs).toHaveLength(2);
    expect(currentState).toBe("Blocked");
    expect(writer.transitions.map((transition) => transition.toState)).toEqual(["In Progress", "Blocked"]);
    expect(writer.comments.map((comment) => comment.dedupeKey)).toEqual([
      "fake-issue-1-1:run-started",
      "fake-issue-1-2:run-started",
      "fake-issue-1-2:blocked-escalation",
    ]);
    expect(writer.comments[2]?.body).toContain("max incomplete turns reached (2/2)");
    expect(writer.comments[2]?.body).toContain("Incomplete turns: 2 / 2");
    expect(writer.comments[2]?.body).toContain("Last completion report:");
    expect(writer.comments[2]?.body).toContain("Required human action:");
    expect(writer.comments.some((comment) => comment.dedupeKey.includes("run-succeeded"))).toBe(false);
    await expect(lifecycleStore.get(candidate.identifier)).resolves.toMatchObject({
      phase: "blocked",
      incompleteTurnCount: 2,
      blockedReason: "max incomplete turns reached (2/2)",
    });
  });

  it("blocks after consecutive worker SDK wait errors reach the retry cap", async () => {
    const config = testConfig(root);
    config.agent.maxSdkErrorRetries = 2;
    config.agent.maxRetryBackoffMs = 0;
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.writeback.dispatchState = "In Progress";
    config.reviewLoop.blockedStates = ["Blocked"];
    const candidate = issue({ state: "Todo", labels: ["dogfood-ready"] });
    let currentState = "Todo";
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return currentState === "Blocked" ? [] : [{ ...candidate, state: currentState }];
      },
      async fetchIssuesByStates() {
        return currentState === "Blocked" ? [] : [{ ...candidate, state: currentState }];
      },
      async fetchIssueStatesByIds() {
        return [{ ...candidate, state: currentState }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const stateDir = config.workspace.stateDir;
    const writer = new StateChangingWriter((state) => {
      currentState = state;
    });
    const writeback = new WritebackProcessor(new FileWritebackOutboxStore(stateDir), writer, logger, 0);
    const runStore = new FileRunTranscriptStore(stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const harness = new SdkWaitErrorHarness();
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
      writeback,
    });

    try {
      await orchestrator.refreshNow();
      await waitFor(() => currentState === "Blocked" && orchestrator.snapshot().counts.retrying === 0, "sdk error escalation");
    } finally {
      await orchestrator.stop();
    }

    expect(harness.runs).toEqual(["sdk-error-run-1", "sdk-error-run-2", "sdk-error-run-3"]);
    const runs = await runStore.listRunsForIssue(candidate.id);
    expect(runs.map((run) => [run.runId, run.status, run.sdkRunStatus, run.sdkRunStatusSource])).toEqual([
      ["sdk-error-run-1", "failed", "error", "wait"],
      ["sdk-error-run-2", "failed", "error", "wait"],
      ["sdk-error-run-3", "failed", "error", "wait"],
    ]);
    expect(runs[2]).toMatchObject({
      failureKind: "cursor_sdk_terminal_error",
      failureDiagnosticCode: "cursor_run_wait_terminal_error",
    });
    expect(writer.transitions.map((transition) => transition.toState)).toEqual(["In Progress", "Blocked"]);
    expect(writer.comments.at(-1)?.body).toContain("consecutive Cursor SDK wait errors reached limit (3 failures; max_sdk_error_retries=2)");
    await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
      phase: "blocked",
      blockedReason: "consecutive Cursor SDK wait errors reached limit (3 failures; max_sdk_error_retries=2)",
    });
    const issueState = await readIssueState(config.workspace.stateDir, candidate.id);
    expect(issueState?.history.filter((snapshot) => snapshot.transitionKind === "retry_run")).toHaveLength(2);
    const block = issueState?.history.find((snapshot) => snapshot.transitionKind === "block_issue");
    expect(block).toMatchObject({
      candidateSource: "block_issue",
      rulesetId: "orchestrator.block_issue",
      blockedReason: "consecutive Cursor SDK wait errors reached limit (3 failures; max_sdk_error_retries=2)",
    });
    expect(block?.actions.map((action) => action.actionType)).toEqual(
      expect.arrayContaining(["update_lifecycle_blocked", "apply_blocked_escalation_writebacks", "record_block_issue"]),
    );
  });

  it("blocks after consecutive worker infrastructure failures reach the configured cap", async () => {
    const config = testConfig(root);
    config.agent.maxInfraFailures = 1;
    config.agent.maxRetryBackoffMs = 0;
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.writeback.dispatchState = "In Progress";
    config.reviewLoop.blockedStates = ["Blocked"];
    const candidate = issue({ state: "Todo", labels: ["dogfood-ready"] });
    let currentState = "Todo";
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return currentState === "Blocked" ? [] : [{ ...candidate, state: currentState }];
      },
      async fetchIssuesByStates() {
        return currentState === "Blocked" ? [] : [{ ...candidate, state: currentState }];
      },
      async fetchIssueStatesByIds() {
        return [{ ...candidate, state: currentState }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const stateDir = config.workspace.stateDir;
    const writer = new StateChangingWriter((state) => {
      currentState = state;
    });
    const writeback = new WritebackProcessor(new FileWritebackOutboxStore(stateDir), writer, logger, 0);
    const runStore = new FileRunTranscriptStore(stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const harness = new InfraFailureHarness();
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
      writeback,
    });

    try {
      await orchestrator.refreshNow();
      await waitFor(() => currentState === "Blocked" && orchestrator.snapshot().counts.retrying === 0, "infra failure escalation");
    } finally {
      await orchestrator.stop();
    }

    expect(harness.runs).toEqual(["infra-error-run-1"]);
    const runs = await runStore.listRunsForIssue(candidate.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      runId: "infra-error-run-1",
      status: "failed",
      failureKind: "harness_diagnostic",
      failureDiagnosticCode: "hermes_gateway_exit",
    });
    expect(writer.transitions.map((transition) => transition.toState)).toEqual(["In Progress", "Blocked"]);
    expect(writer.comments.at(-1)?.body).toContain(
      "consecutive harness infrastructure failures reached limit (1 failures; max_infra_failures=1)",
    );
    await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
      phase: "blocked",
      blockedReason: "consecutive harness infrastructure failures reached limit (1 failures; max_infra_failures=1)",
    });
  });

  it.each([
    ["setup-incomplete", PUBLICATION_APPROVAL_SETUP_INCOMPLETE_REASON],
    ["awaiting operator", PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON],
  ] as const)("does not burn incomplete turns while %s publication approval handoff is active", async (_name, blockedReason) => {
    const config = testConfig(root);
    config.reviewLoop.maxIncompleteTurns = 2;
    config.reviewLoop.blockedStates = ["Blocked"];
    const candidate = issue({ state: "In Progress", branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([], states);
      },
      async fetchIssueStatesByIds() {
        throw new Error("incomplete turn guard should not refresh active issues");
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    await lifecycleStore.ensureIssue(candidate, {
      ...pendingApprovalLifecyclePatch(candidate, root, "run-1", blockedReason),
      phase: "implementation",
      incompleteTurnCount: 1,
    });
    const writer = new StateChangingWriter(() => undefined);
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness: new FakeHarness(),
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
    });

    try {
      await (
        orchestrator as unknown as {
          recordIncompleteTurn(entry: unknown): Promise<void>;
        }
      ).recordIncompleteTurn({
        issue: candidate,
        runId: "run-1",
        activeRunId: "run-1",
        lifecycle: await lifecycleStore.get(candidate.id),
      });

      await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
        phase: "implementation",
        blockedReason,
        incompleteTurnCount: 1,
      });
      expect(writer.comments).toEqual([]);
      expect(writer.transitions).toEqual([]);
    } finally {
      await orchestrator.stop();
    }
  });

  it("blocks a reviewer fail verdict at the max reviewer failure ceiling", async () => {
    const config = testConfig(root);
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.tracker.handoffStates = ["In Review"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.reviewLoop.blockedStates = ["Blocked"];
    config.reviewLoop.maxReviewRounds = 1;
    config.reviewLoop.failureLimits.reviewerFailures = 1;
    config.reviewLoop.reviewerPromptTemplate = "Review {{ issue.identifier }}.";
    const candidate = issue({ state: "In Review", branchName: "symphony/TEST-1" });
    let currentState = "In Review";
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [{ ...candidate, state: currentState }];
      },
      async fetchIssuesByStates(states) {
        return states.includes(currentState) ? [{ ...candidate, state: currentState }] : [];
      },
      async fetchIssueStatesByIds() {
        return [{ ...candidate, state: currentState }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const stateDir = config.workspace.stateDir;
    const outboxStore = new FileWritebackOutboxStore(stateDir);
    const writer = new StateChangingWriter((state) => {
      currentState = state;
    });
    const writeback = new WritebackProcessor(outboxStore, writer, logger, 300_000);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const runStore = new FileRunTranscriptStore(stateDir);
    const report = completionReportRecord(candidate);
    await lifecycleStore.ensureIssue(candidate, {
      phase: "review",
      lastCompletionReportId: report.id,
      completionReports: [report],
    });
    const harness = new ReviewVerdictSubmittingHarness("fail", lifecycleStore, outboxStore);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
      writeback,
    });

    await orchestrator.refreshNow();
    await waitFor(() => harness.runs.length === 1, "head-advanced repair dispatch");
    await orchestrator.stop();

    expect(harness.runs).toEqual([{ role: "reviewer", runId: "review-run-1" }]);
    expect(currentState).toBe("Blocked");
    expect(writer.comments.map((comment) => comment.dedupeKey)).toEqual(["review-run-1:blocked-escalation"]);
    expect(writer.comments[0]?.body).toContain("max reviewer failures reached (1/1)");
    expect(writer.comments[0]?.body).toContain("Review rounds: 1 / 1");
    expect(writer.comments[0]?.body).toContain("Last completion report:");
    expect(writer.comments[0]?.body).toContain("Last review verdict:");
    expect(writer.comments[0]?.body).toContain("Add reviewer MCP integration.");
    expect(writer.transitions.map((transition) => transition.toState)).toEqual(["Blocked"]);
    await expect(lifecycleStore.get(candidate.identifier)).resolves.toMatchObject({
      phase: "blocked",
      reviewRound: 1,
      incompleteTurnCount: 0,
      blockedReason: "max reviewer failures reached (1/1)",
      lastReviewVerdictId: "review-verdict:issue-1:review-verdict-fail-1",
    });
  });

  it("dispatches classify-only issue triage for max-failure blocked issues", async () => {
    const config = testConfig(root);
    config.issueTriage.enabled = true;
    config.writeback.enabled = true;
    config.reviewLoop.blockedStates = ["Blocked"];
    const candidate = issue({ state: "Blocked", branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates(states) {
        return states.includes("Blocked") ? [candidate] : [];
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const outboxStore = new FileWritebackOutboxStore(config.workspace.stateDir);
    await lifecycleStore.ensureIssue(candidate, {
      phase: "blocked",
      reviewRound: 3,
      blockedReason: "max reviewer failures reached (3/3)",
    });
    const harness = new IssueTriageAcceptingHarness(lifecycleStore, outboxStore);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
    });

    await orchestrator.refreshNow();
    await waitFor(() => harness.runs.length === 1, "issue triage dispatch");
    await waitFor(() => orchestrator.snapshot().counts.running === 0, "issue triage completion");
    await orchestrator.stop();

    expect(harness.runs[0]?.ctx.role).toBe("triage");
    expect(harness.runs[0]?.ctx.runPhase).toBe("issue_triage");
    expect(harness.runs[0]?.prompt).toContain("submit_issue_triage_report");
    expect(harness.runs[0]?.prompt).toContain("Blocker kinds:");
    expect(harness.runs[0]?.prompt).toContain("Do not edit files");
    await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
      lastIssueTriageReportId: "issue-triage-report:issue-1:triage-run-1",
      issueTriageReports: [
        {
          runId: "triage-run-1",
          disposition: "decompose_issue",
          confidence: "high",
          blockers: [
            {
              kind: "under_specified_needs_decomposition",
              status: "active",
              nextActor: "planner",
            },
          ],
          writebackOperationKeys: ["comment:issue-1:issue-triage:triage-run-1"],
        },
      ],
    });
    const writebacks = await outboxStore.list();
    expect(writebacks).toHaveLength(1);
    expect(writebacks[0]).toMatchObject({
      idempotencyKey: "comment:issue-1:issue-triage:triage-run-1",
      kind: "comment",
      issueId: "issue-1",
      runId: "triage-run-1",
    });
    expect(writebacks[0]?.kind === "comment" ? writebacks[0].payload.body : "").toContain("## Symphony Issue Triage");
    expect(writebacks[0]?.kind === "comment" ? writebacks[0].payload.body : "").toContain("Recommended human action:");
    await expect(runStore.getRun("triage-run-1")).resolves.toMatchObject({
      role: "triage",
      runPhase: "issue_triage",
      runKind: "triage",
      status: "succeeded",
    });
  });

  it("keeps blocked issues stopped after triage even when blockers are worker-owned", async () => {
    const config = testConfig(root);
    config.issueTriage.enabled = true;
    config.writeback.enabled = true;
    config.reviewLoop.blockedStates = ["Blocked"];
    config.writeback.dispatchState = "In Progress";
    let state = "Blocked";
    const candidate = issue({ state, branchName: "symphony/TEST-1" });
    const currentIssue = (): Issue => ({ ...candidate, state });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates(states) {
        return states.some((candidateState) => candidateState.toLowerCase() === state.toLowerCase()) ? [currentIssue()] : [];
      },
      async fetchIssueStatesByIds() {
        return [currentIssue()];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const outboxStore = new FileWritebackOutboxStore(config.workspace.stateDir);
    const writer = new StateChangingWriter((nextState) => {
      state = nextState;
    });
    const writeback = new WritebackProcessor(outboxStore, writer, logger, config.writeback.maxBackoffMs);
    const seeded = await lifecycleStore.ensureIssue(currentIssue(), {
      phase: "blocked",
      reviewRound: 3,
      blockedReason: "max merge gate failures reached (3/3)",
    });
    await lifecycleStore.updateIssue(currentIssue(), {
      lastIssueTriageReportId: "issue-triage-report:issue-1:triage-worker",
      issueTriageReports: [
        {
          id: "issue-triage-report:issue-1:triage-worker",
          idempotencyKey: "triage-worker",
          requestHash: "triage-worker-hash",
          runId: "triage-run-1",
          issueId: candidate.id,
          issueIdentifier: candidate.identifier,
          triggerFingerprint: issueTriageTriggerFingerprint(seeded),
          disposition: "implementation_repair",
          confidence: "medium",
          summary: "Worker should produce a fresh no-diff repair packet after CI is fixed.",
          evidence: ["blockedReason=max merge gate failures reached (3/3)"],
          recommendedAction: "Produce a fresh completion report that supersedes the stale failing merge-gate verdict.",
          blockers: [
            {
              kind: "implementation_unsatisfied_requirements",
              status: "active",
              nextActor: "worker",
              confidence: "medium",
              summary: "The failed merge-gate verdict is unsuperseded by a newer completion report.",
              evidence: ["latest review verdict was recorded after latest completion report"],
              recommendedAction: "Produce a fresh completion report that supersedes the stale failing merge-gate verdict.",
            },
          ],
          submittedAt: "2026-01-01T00:00:00.000Z",
          writebackOperationKeys: ["comment:issue-1:issue-triage:triage-worker"],
        },
      ],
    });
    const harness = new ManualDispatchRecordingHarness(lifecycleStore, outboxStore, runStore);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
      writeback,
    });

    await orchestrator.refreshNow();
    await orchestrator.stop();

    expect(state).toBe("Blocked");
    expect(writer.transitions).toEqual([]);
    expect(harness.runs).toEqual([]);
  });

  it("does not route mixed active triage blockers back to worker dispatch", async () => {
    const config = testConfig(root);
    config.issueTriage.enabled = true;
    config.writeback.enabled = true;
    config.reviewLoop.blockedStates = ["Blocked"];
    config.writeback.dispatchState = "In Progress";
    let state = "Blocked";
    const candidate = issue({ state, branchName: "symphony/TEST-1" });
    const currentIssue = (): Issue => ({ ...candidate, state });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates(states) {
        return states.some((candidateState) => candidateState.toLowerCase() === state.toLowerCase()) ? [currentIssue()] : [];
      },
      async fetchIssueStatesByIds() {
        return [currentIssue()];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const outboxStore = new FileWritebackOutboxStore(config.workspace.stateDir);
    const writer = new StateChangingWriter((nextState) => {
      state = nextState;
    });
    const writeback = new WritebackProcessor(outboxStore, writer, logger, config.writeback.maxBackoffMs);
    const seeded = await lifecycleStore.ensureIssue(currentIssue(), {
      phase: "blocked",
      reviewRound: 3,
      blockedReason: "max merge gate failures reached (3/3)",
    });
    await lifecycleStore.updateIssue(currentIssue(), {
      lastIssueTriageReportId: "issue-triage-report:issue-1:triage-mixed",
      issueTriageReports: [
        {
          id: "issue-triage-report:issue-1:triage-mixed",
          idempotencyKey: "triage-mixed",
          requestHash: "triage-mixed-hash",
          runId: "triage-run-1",
          issueId: candidate.id,
          issueIdentifier: candidate.identifier,
          triggerFingerprint: issueTriageTriggerFingerprint(seeded),
          disposition: "implementation_repair",
          confidence: "medium",
          summary: "Worker blocker is mixed with an active operator-owned merge gate blocker.",
          evidence: ["blockedReason=max merge gate failures reached (3/3)"],
          recommendedAction: "Do not dispatch worker while the active gate blocker needs operator action.",
          blockers: [
            {
              kind: "implementation_unsatisfied_requirements",
              status: "active",
              nextActor: "worker",
              confidence: "medium",
              summary: "The failed merge-gate verdict is unsuperseded by a newer completion report.",
              evidence: ["latest merge-gate verdict was recorded after latest completion report"],
              recommendedAction: "Produce a fresh completion report that supersedes the stale failing merge-gate verdict.",
            },
            {
              kind: "merge_gate_check_failure",
              status: "active",
              nextActor: "operator",
              confidence: "high",
              summary: "The current PR head is blocked on a required check failure.",
              evidence: ["Typecheck and test failed on the current PR head"],
              recommendedAction: "Fix or rerun the required check before dispatching another worker.",
            },
          ],
          submittedAt: "2026-01-01T00:00:00.000Z",
          writebackOperationKeys: ["comment:issue-1:issue-triage:triage-mixed"],
        },
      ],
    });
    const harness = new ManualDispatchRecordingHarness(lifecycleStore, outboxStore, runStore);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
      writeback,
    });

    await orchestrator.refreshNow();
    await orchestrator.stop();

    expect(state).toBe("Blocked");
    expect(writer.transitions).toEqual([]);
    expect(harness.runs).toEqual([]);
  });

  it("rebounds stale mixed triage dispatches back to blocked before worker dispatch", async () => {
    const config = testConfig(root);
    config.issueTriage.enabled = true;
    config.writeback.enabled = true;
    config.tracker.activeStates = ["In Progress"];
    config.reviewLoop.blockedStates = ["Blocked"];
    config.writeback.dispatchState = "In Progress";
    let state = "In Progress";
    const candidate = issue({ state, branchName: "symphony/TEST-1" });
    const currentIssue = (): Issue => ({ ...candidate, state });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return config.tracker.activeStates.some((activeState) => activeState.toLowerCase() === state.toLowerCase())
          ? [currentIssue()]
          : [];
      },
      async fetchIssuesByStates(states) {
        return states.some((candidateState) => candidateState.toLowerCase() === state.toLowerCase()) ? [currentIssue()] : [];
      },
      async fetchIssueStatesByIds() {
        return [currentIssue()];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const outboxStore = new FileWritebackOutboxStore(config.workspace.stateDir);
    const writer = new StateChangingWriter((nextState) => {
      state = nextState;
    });
    const writeback = new WritebackProcessor(outboxStore, writer, logger, config.writeback.maxBackoffMs);
    const blockedReason = "max merge gate failures reached (5/3)";
    const mergeGate = {
      id: "merge-gate:issue-1:pr-42:head-sha-1",
      status: "blocked" as const,
      headSha: "head-sha-1",
      pullRequest: { url: "https://github.com/acme/symphony/pull/42", number: 42, headSha: "head-sha-1", branch: "symphony/TEST-1" },
      requiredChecks: ["Typecheck and test"],
      checks: [
        {
          name: "Typecheck and test",
          outcome: "failing" as const,
          rawStatus: "failure" as const,
          conclusion: "failure",
          url: "https://ci.test/test",
          firstObservedAt: null,
          actionableSince: null,
        },
      ],
      mergeability: null,
      reviewRound: 5,
      gateRunId: "worker-run-1",
      gateReportId: "completion-report:issue-1:repair-1",
      repairRunId: null,
      repairReportId: null,
      blockerFingerprint: "head-sha-1:Typecheck and test:failure",
      writebackOperationKeys: [],
      supersededByHeadSha: null,
      updatedAt: "2026-01-01T00:00:01.000Z",
    };
    const seeded = await lifecycleStore.ensureIssue(currentIssue(), {
      phase: "blocked",
      reviewRound: 3,
      blockedReason,
      mergeGate,
    });
    await lifecycleStore.updateIssue(currentIssue(), {
      phase: "implementation",
      blockedReason: null,
      lastIssueTriageReportId: "issue-triage-report:issue-1:triage-mixed",
      issueTriageReports: [
        {
          id: "issue-triage-report:issue-1:triage-mixed",
          idempotencyKey: "triage-mixed",
          requestHash: "triage-mixed-hash",
          runId: "triage-run-1",
          issueId: candidate.id,
          issueIdentifier: candidate.identifier,
          triggerFingerprint: issueTriageTriggerFingerprint(seeded),
          disposition: "implementation_repair",
          confidence: "medium",
          summary: "Worker blocker is mixed with an active operator-owned merge gate blocker.",
          evidence: ["blockedReason=max merge gate failures reached (5/3)"],
          recommendedAction: "Do not dispatch worker while the active gate blocker needs operator action.",
          blockers: [
            {
              kind: "implementation_unsatisfied_requirements",
              status: "active",
              nextActor: "worker",
              confidence: "medium",
              summary: "The failed merge-gate verdict is unsuperseded by a newer completion report.",
              evidence: ["latest merge-gate verdict was recorded after latest completion report"],
              recommendedAction: "Produce a fresh completion report that supersedes the stale failing merge-gate verdict.",
            },
            {
              kind: "merge_gate_check_failure",
              status: "active",
              nextActor: "operator",
              confidence: "high",
              summary: "The current PR head is blocked on a required check failure.",
              evidence: ["Typecheck and test failed on the current PR head"],
              recommendedAction: "Fix or rerun the required check before dispatching another worker.",
            },
          ],
          submittedAt: "2026-01-01T00:00:00.000Z",
          writebackOperationKeys: ["comment:issue-1:issue-triage:triage-mixed"],
        },
      ],
    });
    const harness = new ManualDispatchRecordingHarness(lifecycleStore, outboxStore, runStore);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
      writeback,
    });

    await orchestrator.refreshNow();
    await waitFor(() => writer.transitions.length === 1, "mixed triage blocked rebound");
    await orchestrator.stop();

    expect(writer.transitions[0]).toMatchObject({
      issueId: candidate.id,
      fromStates: ["In Progress"],
      toState: "Blocked",
      reason: `Symphony issue triage blocked: ${blockedReason}`,
    });
    expect(harness.runs).toEqual([]);
    await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
      phase: "blocked",
      blockedReason,
    });
  });

  it("does not rebound mixed triage when operator moves a blocked issue to In Progress", async () => {
    const config = testConfig(root);
    config.issueTriage.enabled = true;
    config.writeback.enabled = true;
    config.tracker.activeStates = ["In Progress"];
    config.reviewLoop.blockedStates = ["Blocked"];
    config.writeback.dispatchState = "In Progress";
    let state = "In Progress";
    const candidate = issue({ state, branchName: "symphony/TEST-1" });
    const currentIssue = (): Issue => ({ ...candidate, state });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return config.tracker.activeStates.some((activeState) => activeState.toLowerCase() === state.toLowerCase())
          ? [currentIssue()]
          : [];
      },
      async fetchIssuesByStates(states) {
        return states.some((candidateState) => candidateState.toLowerCase() === state.toLowerCase()) ? [currentIssue()] : [];
      },
      async fetchIssueStatesByIds() {
        return [currentIssue()];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const outboxStore = new FileWritebackOutboxStore(config.workspace.stateDir);
    const writer = new StateChangingWriter((nextState) => {
      state = nextState;
    });
    const writeback = new WritebackProcessor(outboxStore, writer, logger, config.writeback.maxBackoffMs);
    const blockedReason = "max merge gate failures reached (5/3)";
    const seeded = await lifecycleStore.ensureIssue(currentIssue(), {
      phase: "blocked",
      reviewRound: 3,
      incompleteTurnCount: 2,
      blockedReason,
      mergeGate: {
        ...blockedMergeGate(candidate),
        id: "merge-gate:issue-1:pr-42:head-sha-1",
        headSha: "head-sha-1",
        reviewRound: 5,
        blockerFingerprint: "head-sha-1:Typecheck and test:failure",
      },
    });
    await lifecycleStore.updateIssue(currentIssue(), {
      lastIssueTriageReportId: "issue-triage-report:issue-1:triage-mixed",
      issueTriageReports: [
        {
          id: "issue-triage-report:issue-1:triage-mixed",
          idempotencyKey: "triage-mixed",
          requestHash: "triage-mixed-hash",
          runId: "triage-run-1",
          issueId: candidate.id,
          issueIdentifier: candidate.identifier,
          triggerFingerprint: issueTriageTriggerFingerprint(seeded),
          disposition: "implementation_repair",
          confidence: "medium",
          summary: "Worker blocker is mixed with an active operator-owned merge gate blocker.",
          evidence: ["blockedReason=max merge gate failures reached (5/3)"],
          recommendedAction: "Operator moved the issue to In Progress to start a fresh worker attempt.",
          blockers: [
            {
              kind: "implementation_unsatisfied_requirements",
              status: "active",
              nextActor: "worker",
              confidence: "medium",
              summary: "The failed merge-gate verdict is unsuperseded by a newer completion report.",
              evidence: ["latest merge-gate verdict was recorded after latest completion report"],
              recommendedAction: "Produce a fresh completion report that supersedes the stale failing merge-gate verdict.",
            },
            {
              kind: "merge_gate_check_failure",
              status: "active",
              nextActor: "operator",
              confidence: "high",
              summary: "The current PR head is blocked on a required check failure.",
              evidence: ["Typecheck and test failed on the current PR head"],
              recommendedAction: "Fix or rerun the required check before dispatching another worker.",
            },
          ],
          submittedAt: "2026-01-01T00:00:00.000Z",
          writebackOperationKeys: ["comment:issue-1:issue-triage:triage-mixed"],
        },
      ],
    });
    const harness = new LifecycleSnapshotHarness(lifecycleStore);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
      writeback,
    });

    await orchestrator.refreshNow();
    await orchestrator.refreshNow();
    await waitFor(() => harness.runs.length === 1, "operator-resumed worker dispatch");
    await orchestrator.stop();

    expect(state).toBe("In Progress");
    expect(writer.transitions).toEqual([]);
    expect(harness.runs[0]?.runPhase).toBe("implementation");
    expect(harness.snapshots[0]).toMatchObject({
      phase: "implementation",
      reviewRound: 0,
      incompleteTurnCount: 0,
      blockedReason: null,
      lastIssueTriageReportId: null,
      mergeGate: {
        status: "resolved",
        reviewRound: 0,
        blockerFingerprint: null,
      },
    });
  });

  it("manual agent run re-triggers triage after the automatic attempt limit", async () => {
    const config = testConfig(root);
    config.issueTriage.enabled = true;
    config.reviewLoop.blockedStates = ["Blocked"];
    const candidate = issue({ state: "Blocked", branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates(states) {
        return states.includes("Blocked") ? [candidate] : [];
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const outboxStore = new FileWritebackOutboxStore(config.workspace.stateDir);
    const seeded = await lifecycleStore.ensureIssue(candidate, {
      phase: "blocked",
      reviewRound: 3,
      blockedReason: "max reviewer failures reached (3/3)",
    });
    await lifecycleStore.updateIssue(candidate, {
      lastIssueTriageReportId: "issue-triage-report:issue-1:existing-triage",
      issueTriageReports: [
        {
          id: "issue-triage-report:issue-1:existing-triage",
          idempotencyKey: "existing-triage",
          requestHash: "existing-hash",
          runId: "existing-triage-run",
          issueId: candidate.id,
          issueIdentifier: candidate.identifier,
          triggerFingerprint: issueTriageTriggerFingerprint(seeded),
          disposition: "implementation_repair",
          confidence: "medium",
          summary: "Existing automatic triage report.",
          evidence: ["blockedReason=max reviewer failures reached (3/3)"],
          recommendedAction: "Run another explicit triage pass.",
          blockers: [
            {
              kind: "implementation_unsatisfied_requirements",
              status: "active",
              nextActor: "worker",
              confidence: "medium",
              summary: "Existing automatic triage report.",
              evidence: ["blockedReason=max reviewer failures reached (3/3)"],
              recommendedAction: "Run another explicit triage pass.",
            },
          ],
          submittedAt: "2026-01-01T00:00:00.000Z",
          writebackOperationKeys: [],
        },
      ],
    });
    const harness = new IssueTriageAcceptingHarness(lifecycleStore, outboxStore);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
    });

    const result = await orchestrator.runManualAgent(candidate.id, { stage: "triage" });
    await orchestrator.stop();

    expect(result).toMatchObject({ status: "completed", role: "triage", runPhase: "issue_triage", finalStatus: "succeeded" });
    expect(harness.runs[0]?.ctx.manualDispatch).toBe(true);
    await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
      issueTriageReports: [
        { runId: "existing-triage-run" },
        { runId: "triage-run-1" },
      ],
    });
    await expect(runStore.getRun("triage-run-1")).resolves.toMatchObject({
      manualDispatch: true,
      manualDispatchStage: "triage",
    });
  });

  it("manual triage still rejects non-triage blocked lifecycle reasons", async () => {
    const config = testConfig(root);
    config.issueTriage.enabled = true;
    config.reviewLoop.blockedStates = ["Blocked"];
    const candidate = issue({ state: "Blocked", branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await lifecycleStore.ensureIssue(candidate, {
      phase: "blocked",
      blockedReason: "needs operator",
    });
    const harness = new IssueTriageAcceptingHarness(lifecycleStore, new FileWritebackOutboxStore(config.workspace.stateDir));
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
    });

    const result = await orchestrator.runManualAgent(candidate.id, { stage: "triage" });
    await orchestrator.stop();

    expect(result).toMatchObject({ status: "not_dispatched", reason: "lifecycle_gate_blocked" });
    expect(harness.runs).toHaveLength(0);
  });

  it("manual triage can ignore the current issue state gate when force is explicit", async () => {
    const config = testConfig(root);
    config.issueTriage.enabled = true;
    config.reviewLoop.blockedStates = ["Blocked"];
    const candidate = issue({ state: "Todo", branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const outboxStore = new FileWritebackOutboxStore(config.workspace.stateDir);
    await lifecycleStore.ensureIssue(candidate, {
      phase: "blocked",
      reviewRound: 3,
      blockedReason: "max reviewer failures reached (3/3)",
    });
    const harness = new IssueTriageAcceptingHarness(lifecycleStore, outboxStore);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
    });

    const forceOnly = await orchestrator.runManualAgent(candidate.id, { stage: "triage", forceLabels: true });
    const forcedStateOverride = await orchestrator.runManualAgent(candidate.id, {
      stage: "triage",
      forceLabels: true,
      ignoreState: true,
    });
    await orchestrator.stop();

    expect(forceOnly).toMatchObject({ status: "not_dispatched", reason: "issue_not_in_blocked_state" });
    expect(forcedStateOverride).toMatchObject({
      status: "completed",
      role: "triage",
      runPhase: "issue_triage",
      finalStatus: "succeeded",
    });
    expect(harness.runs).toHaveLength(1);
    expect(harness.runs[0]?.ctx).toMatchObject({
      role: "triage",
      runPhase: "issue_triage",
      manualDispatch: true,
      manualDispatchIgnoreState: true,
    });
    await expect(runStore.getRun("triage-run-1")).resolves.toMatchObject({
      manualDispatch: true,
      manualDispatchStage: "triage",
      manualDispatchForceLabels: true,
      manualDispatchIgnoreState: true,
    });
  });

  it("manual worker dispatch force bypasses worker exclude labels only", async () => {
    const config = testConfig(root);
    config.agent.workerExcludeLabels = ["review_only"];
    const candidate = issue({ state: "Todo", labels: ["review_only"], branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const outboxStore = new FileWritebackOutboxStore(config.workspace.stateDir);
    const harness = new ManualDispatchRecordingHarness(lifecycleStore, outboxStore, runStore);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
    });

    const blocked = await orchestrator.runManualAgent(candidate.id, { stage: "worker" });
    const forced = await orchestrator.runManualAgent(candidate.id, { stage: "worker", forceLabels: true });
    await orchestrator.stop();

    expect(blocked).toMatchObject({ status: "not_dispatched", reason: "worker_excluded_label:review_only" });
    expect(forced).toMatchObject({ status: "completed", role: "worker", runPhase: "implementation" });
    expect(harness.runs).toHaveLength(1);
    expect(harness.runs[0]?.ctx).toMatchObject({ role: "worker", runPhase: "implementation", manualDispatch: true });
  });

  it("manual worker dispatch requires force to ignore the current issue state gate", async () => {
    const config = testConfig(root);
    config.reviewLoop.reviewStates = ["In Review"];
    const candidate = issue({ state: "In Review", branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates() {
        return [candidate];
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const outboxStore = new FileWritebackOutboxStore(config.workspace.stateDir);
    const harness = new ManualDispatchRecordingHarness(lifecycleStore, outboxStore, runStore);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
    });

    const missingForce = await orchestrator.runManualAgent(candidate.id, { stage: "worker", ignoreState: true });
    const forceOnly = await orchestrator.runManualAgent(candidate.id, { stage: "worker", forceLabels: true });
    const forcedStateOverride = await orchestrator.runManualAgent(candidate.id, {
      stage: "worker",
      forceLabels: true,
      ignoreState: true,
    });
    await orchestrator.stop();

    expect(missingForce).toMatchObject({ status: "not_dispatched", reason: "ignore_state_requires_force" });
    expect(forceOnly).toMatchObject({ status: "not_dispatched", reason: "issue_not_in_worker_active_state" });
    expect(forcedStateOverride).toMatchObject({
      status: "completed",
      role: "worker",
      runPhase: "implementation",
      finalStatus: "succeeded",
    });
    expect(harness.runs).toHaveLength(1);
    expect(harness.runs[0]?.ctx).toMatchObject({
      role: "worker",
      runPhase: "implementation",
      manualDispatch: true,
      manualDispatchIgnoreState: true,
    });
    await expect(runStore.getRun("manual-run-1")).resolves.toMatchObject({
      manualDispatch: true,
      manualDispatchStage: "worker",
      manualDispatchForceLabels: true,
      manualDispatchIgnoreState: true,
    });
    await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
      phase: "review",
      lastCompletionReportId: "completion-report:issue-1:manual-run-1",
    });
  });

  it("manual worker dispatch from blocked resets the failure budget before the run starts", async () => {
    const config = testConfig(root);
    config.reviewLoop.blockedStates = ["Blocked"];
    const candidate = issue({ state: "Blocked", branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates() {
        return [candidate];
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const approvalVerdict: IssueReviewVerdictRecord = {
      ...reviewVerdictRecord(candidate),
      id: "review-verdict:issue-1:approval-pass",
      idempotencyKey: "approval-pass",
      runId: "review-run-pass",
      verdict: "pass",
      findings: [],
      acceptanceResults: [{ text: "Approved", satisfied: true, evidence: "review passed" }],
      submittedAt: "2026-01-01T00:00:02.000Z",
    };
    await lifecycleStore.ensureIssue(candidate, {
      phase: "blocked",
      reviewRound: 3,
      incompleteTurnCount: 3,
      blockedReason: "max merge gate failures reached (4/3)",
      lastCompletionReportId: "completion-report:issue-1:idem-1",
      lastReviewVerdictId: "merge-gate:issue-1:pr-42:abc123",
      lastIssueTriageReportId: "issue-triage-report:issue-1:stale",
      completionReports: [completionReportRecord(candidate)],
      reviewVerdicts: [
        approvalVerdict,
        {
          ...reviewVerdictRecord(candidate),
          id: "merge-gate:issue-1:pr-42:abc123",
          idempotencyKey: "merge-gate-fail",
          runId: "worker-run-1",
          reviewer: "symphony-merge-gate",
          submittedAt: "2026-01-01T00:00:03.000Z",
        },
      ],
      mergeGate: blockedMergeGate(candidate),
    });
    const harness = new LifecycleSnapshotHarness(lifecycleStore);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
    });

    const result = await orchestrator.runManualAgent(candidate.id, {
      stage: "worker",
      forceLabels: true,
      ignoreState: true,
    });
    await orchestrator.stop();

    expect(result).toMatchObject({ status: "completed", role: "worker", runPhase: "implementation" });
    expect(harness.snapshots[0]).toMatchObject({
      reviewRound: 0,
      incompleteTurnCount: 0,
      blockedReason: null,
      lastReviewVerdictId: approvalVerdict.id,
      lastIssueTriageReportId: null,
      mergeGate: {
        status: "resolved",
        reviewRound: 0,
        blockerFingerprint: null,
      },
    });
  });

  it("operator Ready to Merge resume resets merge-gate rounds before rerunning the gate", async () => {
    const config = mergePolicyOrchestratorConfig(root);
    let state = "Ready to Merge";
    const candidate = issue({ state, branchName: "symphony/TEST-1", labels: ["dogfood-ready"] });
    const currentIssue = (): Issue => ({ ...candidate, state });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates(states) {
        return states.some((candidateState) => candidateState.toLowerCase() === state.toLowerCase()) ? [currentIssue()] : [];
      },
      async fetchIssueStatesByIds() {
        return [currentIssue()];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const outboxStore = new FileWritebackOutboxStore(config.workspace.stateDir);
    const writer = new StateChangingWriter((nextState) => {
      state = nextState;
    });
    const approvalVerdict: IssueReviewVerdictRecord = {
      ...reviewVerdictRecord(candidate),
      id: "review-verdict:issue-1:approval-pass",
      idempotencyKey: "approval-pass",
      runId: "review-run-pass",
      verdict: "pass",
      findings: [],
      acceptanceResults: [{ text: "Approved", satisfied: true, evidence: "review passed" }],
      submittedAt: "2026-01-01T00:00:02.000Z",
    };
    await lifecycleStore.ensureIssue(currentIssue(), {
      phase: "blocked",
      reviewRound: 2,
      incompleteTurnCount: 1,
      blockedReason: "max merge gate failures reached (4/3)",
      lastCompletionReportId: "completion-report:issue-1:idem-1",
      lastReviewVerdictId: "merge-gate:issue-1:pr-42:abc123",
      completionReports: [completionReportRecord(candidate)],
      reviewVerdicts: [
        approvalVerdict,
        {
          ...reviewVerdictRecord(candidate),
          id: "merge-gate:issue-1:pr-42:abc123",
          idempotencyKey: "merge-gate-fail",
          runId: "worker-run-1",
          reviewer: "symphony-merge-gate",
          submittedAt: "2026-01-01T00:00:03.000Z",
        },
      ],
      mergeGate: blockedMergeGate(candidate),
    });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness: new FakeHarness(),
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
      writeback: new WritebackProcessor(outboxStore, writer, logger, config.writeback.maxBackoffMs),
      pullRequestMergeClient: new FailingRequiredCheckMergeClient(),
    });

    await orchestrator.refreshNow();
    await orchestrator.stop();

    const lifecycle = await lifecycleStore.get(candidate.id);
    expect(state).toBe("In Progress");
    expect(writer.transitions).toEqual([
      {
        issueId: candidate.id,
        fromStates: ["Ready to Merge"],
        toState: "In Progress",
        reason: "Symphony merge gate required CI repair",
      },
    ]);
    expect(lifecycle).toMatchObject({
      phase: "implementation",
      reviewRound: 0,
      incompleteTurnCount: 0,
      blockedReason: null,
      lastReviewVerdictId: "review-verdict:issue-1:approval-pass",
      lastMergeGateResultId: "merge-gate:issue-1:pr-42:abc123",
      mergeGate: {
        status: "repair_dispatched",
        reviewRound: 1,
      },
    });
    expect(lifecycle?.mergeGateResults?.find((result) => result.id === "merge-gate:issue-1:pr-42:abc123")?.writebackOperationKeys).toEqual([
      "comment:issue-1:merge-gate:merge-gate_issue-1_pr-42_abc123:repair:abc123_test_failure:r1",
      "transition:issue-1:merge-gate:merge-gate_issue-1_pr-42_abc123:repair:abc123_test_failure:r1:In Progress",
    ]);
    const issueState = await readIssueState(config.workspace.stateDir, candidate.id);
    const mergePolicySnapshots =
      issueState?.history.filter((snapshot) => snapshot.transitionKind.startsWith("merge_policy_")) ?? [];
    expect(mergePolicySnapshots.map((snapshot) => snapshot.transitionKind)).toEqual([
      "merge_policy_reset_operator_resume",
      "merge_policy_observe",
      "merge_policy_dispatch_repair",
    ]);
    expect(
      mergePolicySnapshots.map((snapshot) => {
        const context =
          snapshot.transitionRequestContext?.kind === "merge_policy_chain" ? snapshot.transitionRequestContext : null;
        return {
          triggerType: snapshot.triggerType,
          triggerSource: snapshot.triggerSource,
          contextKind: snapshot.transitionRequestContext?.kind ?? null,
          iteration: context?.payload.iteration ?? null,
          maxIterations: context?.payload.maxIterations ?? null,
        };
      }),
    ).toEqual([
      {
        triggerType: "orchestrator.tick",
        triggerSource: "orchestrator",
        contextKind: null,
        iteration: null,
        maxIterations: null,
      },
      {
        triggerType: "runtime.requested",
        triggerSource: "transition",
        contextKind: "merge_policy_chain",
        iteration: 1,
        maxIterations: 6,
      },
      {
        triggerType: "runtime.requested",
        triggerSource: "transition",
        contextKind: "merge_policy_chain",
        iteration: 2,
        maxIterations: 6,
      },
    ]);
    const firstContext =
      mergePolicySnapshots[1]?.transitionRequestContext?.kind === "merge_policy_chain"
        ? mergePolicySnapshots[1].transitionRequestContext
        : null;
    const chainId = firstContext?.payload.chainId;
    expect(typeof chainId).toBe("string");
    expect(
      mergePolicySnapshots.map((snapshot) =>
        snapshot.transitionRequestContext?.kind === "merge_policy_chain" ? snapshot.transitionRequestContext.payload.chainId : null,
      ),
    ).toEqual([null, chainId, chainId]);
    expect(mergePolicySnapshots[1]?.transitionRequestContext).toMatchObject({
      parentHistorySnapshotId: mergePolicySnapshots[0]?.historySnapshotId,
      parentTransitionKind: "merge_policy_reset_operator_resume",
    });
    expect(mergePolicySnapshots[2]?.transitionRequestContext).toMatchObject({
      parentHistorySnapshotId: mergePolicySnapshots[1]?.historySnapshotId,
      parentTransitionKind: "merge_policy_observe",
    });
  });

  it("merge-policy rulesets require merge-policy state and requested-transition context", async () => {
    const config = mergePolicyOrchestratorConfig(root);
    const logger = new StructuredLogger(() => undefined);
    const orchestrator = new Orchestrator({
      config,
      tracker: emptyTracker(),
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness: new FakeHarness(),
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
    });
    const observeRuleset = orchestrator
      .registeredTransitionRulesets()
      .find((ruleset) => ruleset.id === "orchestrator.merge_policy.observe");
    expect(observeRuleset).toBeDefined();
    const base = mergePolicyRulesetSnapshot();

    expect(observeRuleset?.evaluate(base, [])).toMatchObject({
      transitionKind: "merge_policy_observe",
      mergePolicyObservationInputFingerprint: "merge-policy-input",
    });
    expect(
      observeRuleset?.evaluate(
        {
          ...base,
          triggerType: "runtime.requested",
          triggerSource: "transition",
          transitionRequestContext: mergePolicyChainContext(0),
        },
        [],
      ),
    ).toMatchObject({
      transitionKind: "merge_policy_observe",
      mergePolicyObservationInputFingerprint: "merge-policy-input",
    });
    expect(observeRuleset?.evaluate({ ...base, candidateSource: "worker_candidates" }, [])).toMatchObject({
      transitionKind: "merge_policy_observe",
      mergePolicyObservationInputFingerprint: "merge-policy-input",
    });
    expect(
      observeRuleset?.evaluate(
        {
          ...base,
          triggerType: "runtime.requested",
          triggerSource: "transition",
          candidateSource: "worker_candidates",
          transitionRequestContext: mergePolicyChainContext(0),
        },
        [],
      ),
    ).toMatchObject({
      transitionKind: "merge_policy_observe",
      mergePolicyObservationInputFingerprint: "merge-policy-input",
    });
    expect(
      observeRuleset?.evaluate(
        {
          ...base,
          triggerType: "runtime.requested",
          triggerSource: "transition",
          transitionRequestContext: null,
        },
        [],
      ),
    ).toBeNull();
    expect(
      observeRuleset?.evaluate(
        {
          ...base,
          triggerType: "runtime.requested",
          triggerSource: "transition",
          transitionRequestContext: {
            ...mergePolicyChainContext(0),
            kind: "other_requested_transition",
          } as never,
        },
        [],
      ),
    ).toBeNull();
    await orchestrator.stop();
  });

  it.each([
    {
      name: "null transition",
      response: { transition: null, acted: false },
    },
    {
      name: "noop transition",
      response: { transition: transitionSnapshot("noop", "noop-1"), acted: false },
    },
    {
      name: "unacted transition",
      response: { transition: transitionSnapshot("merge_policy_observe", "observe-1"), acted: false },
    },
    {
      name: "non-continuable transition",
      response: { transition: transitionSnapshot("merge_policy_dispatch_repair", "dispatch-repair-1"), acted: true },
    },
  ])("merge-policy requested transition chain stops on $name", async ({ response }) => {
    const { candidate, orchestrator, requester } = mergePolicyLoopHarness(root, [response]);

    await requester.processMergePolicyTransitionCandidate(candidate);
    await orchestrator.stop();

    expect(requester.requestTransition).toHaveBeenCalledTimes(1);
    const requestCalls = requester.requestTransition.mock.calls as Array<[RequestedTransitionCall]>;
    expect(requestCalls[0]?.[0]).toMatchObject({
      candidateSource: "merge_policy_chain",
      context: {
        kind: "merge_policy_chain",
        parentHistorySnapshotId: null,
        parentTransitionKind: null,
        payload: {
          iteration: 0,
          maxIterations: 6,
        },
      },
    });
  });

  it("merge-policy requested transition chain increments context and logs when the cap is reached", async () => {
    const logs: string[] = [];
    const responses = Array.from({ length: 6 }, (_, index) => ({
      transition: transitionSnapshot("merge_policy_observe", `observe-${index}`),
      acted: true,
    }));
    const { candidate, orchestrator, requester } = mergePolicyLoopHarness(root, responses, logs);

    await requester.processMergePolicyTransitionCandidate(candidate);
    await orchestrator.stop();

    expect(requester.requestTransition).toHaveBeenCalledTimes(6);
    const requestCalls = requester.requestTransition.mock.calls as Array<[RequestedTransitionCall]>;
    const contexts = requestCalls.map((call) => call[0].context);
    expect(contexts.map((context) => context.payload.iteration)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(contexts.map((context) => context.payload.maxIterations)).toEqual([6, 6, 6, 6, 6, 6]);
    expect(new Set(contexts.map((context) => context.payload.chainId)).size).toBe(1);
    expect(contexts[0]).toMatchObject({
      parentHistorySnapshotId: null,
      parentTransitionKind: null,
    });
    expect(contexts[1]).toMatchObject({
      parentHistorySnapshotId: "observe-0",
      parentTransitionKind: "merge_policy_observe",
    });
    expect(contexts[5]).toMatchObject({
      parentHistorySnapshotId: "observe-4",
      parentTransitionKind: "merge_policy_observe",
    });
    expect(logs.some((line) => line.includes('message="merge policy transition chain reached iteration cap"'))).toBe(true);
  });

  it("manual worker dispatch does not auto-route planning-labeled issues to planner", async () => {
    const config = testConfig(root);
    config.issueBreakdown.enabled = true;
    config.issueBreakdown.planningLabels = ["needs_breakdown"];
    const candidate = issue({ state: "Todo", labels: ["needs_breakdown"], branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const outboxStore = new FileWritebackOutboxStore(config.workspace.stateDir);
    const harness = new ManualDispatchRecordingHarness(lifecycleStore, outboxStore, runStore);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
    });

    const result = await orchestrator.runManualAgent(candidate.id, { stage: "worker" });
    await orchestrator.stop();

    expect(result).toMatchObject({ status: "completed", role: "worker", runPhase: "implementation" });
    expect(harness.runs[0]?.ctx).toMatchObject({ role: "worker", runPhase: "implementation" });
  });

  it("manual reviewer dispatch fails clearly when review evidence is unavailable", async () => {
    const config = testConfig(root);
    config.reviewLoop.reviewStates = ["In Review"];
    const candidate = issue({ state: "In Review", branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates() {
        return [candidate];
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const outboxStore = new FileWritebackOutboxStore(config.workspace.stateDir);
    const harness = new ManualDispatchRecordingHarness(lifecycleStore, outboxStore, runStore);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
    });

    const result = await orchestrator.runManualAgent(candidate.id, { stage: "reviewer" });
    await orchestrator.stop();

    expect(result).toMatchObject({ status: "not_dispatched", reason: "review_evidence_unavailable" });
    expect(harness.runs).toHaveLength(0);
  });

  it("flushes issue triage report writebacks when the triage handoff is accepted", async () => {
    const config = testConfig(root);
    config.issueTriage.enabled = true;
    config.writeback.enabled = true;
    config.reviewLoop.blockedStates = ["Blocked"];
    const candidate = issue({ state: "Blocked", branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates(states) {
        return states.includes("Blocked") ? [candidate] : [];
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const outboxStore = new FileWritebackOutboxStore(config.workspace.stateDir);
    const writer = new StateChangingWriter(() => undefined);
    const writeback = new WritebackProcessor(outboxStore, writer, logger, config.writeback.maxBackoffMs);
    await lifecycleStore.ensureIssue(candidate, {
      phase: "blocked",
      reviewRound: 3,
      blockedReason: "max reviewer failures reached (3/3)",
    });
    const harness = new IssueTriageAcceptingHarness(lifecycleStore, outboxStore);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
      writeback,
    });

    await orchestrator.refreshNow();
    await waitFor(() => harness.runs.length === 1, "issue triage dispatch");
    await waitFor(() => orchestrator.snapshot().counts.running === 0, "issue triage completion");
    await orchestrator.stop();

    expect(writer.comments).toHaveLength(1);
    expect(writer.comments[0]).toMatchObject({
      issueId: candidate.id,
      dedupeKey: "issue-triage:triage-run-1",
    });
    expect(writer.comments[0]?.body).toContain("## Symphony Issue Triage");
    expect(writer.comments[0]?.body).toContain("Decompose the hidden scope into blocking child issues.");
    await expect(outboxStore.list()).resolves.toEqual([
      expect.objectContaining({
        idempotencyKey: "comment:issue-1:issue-triage:triage-run-1",
        status: "succeeded",
      }),
    ]);
  });

  it("reconciles missing issue triage report writebacks without redispatching triage", async () => {
    const config = testConfig(root);
    config.issueTriage.enabled = true;
    config.writeback.enabled = true;
    config.reviewLoop.blockedStates = ["Blocked"];
    const candidate = issue({ state: "Blocked", branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates(states) {
        return states.includes("Blocked") ? [candidate] : [];
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const outboxStore = new FileWritebackOutboxStore(config.workspace.stateDir);
    const writer = new StateChangingWriter(() => undefined);
    const writeback = new WritebackProcessor(outboxStore, writer, logger, config.writeback.maxBackoffMs);
    const seeded = await lifecycleStore.ensureIssue(candidate, {
      phase: "blocked",
      reviewRound: 3,
      blockedReason: "max reviewer failures reached (3/3)",
    });
    await lifecycleStore.updateIssue(candidate, {
      lastIssueTriageReportId: "issue-triage-report:issue-1:triage-1",
      issueTriageReports: [
        {
          id: "issue-triage-report:issue-1:triage-1",
          idempotencyKey: "triage-1",
          requestHash: "triage-hash-1",
          runId: "triage-run-1",
          issueId: candidate.id,
          issueIdentifier: candidate.identifier,
          triggerFingerprint: issueTriageTriggerFingerprint(seeded),
          disposition: "decompose_issue",
          confidence: "high",
          summary: "Existing triage report was accepted before writebacks existed.",
          evidence: ["blockedReason=max reviewer failures reached (3/3)"],
          recommendedAction: "Publish the missing triage recommendation without rerunning the agent.",
          blockers: [
            {
              kind: "under_specified_needs_decomposition",
              status: "active",
              nextActor: "planner",
              confidence: "high",
              summary: "Existing triage report was accepted before writebacks existed.",
              evidence: ["blockedReason=max reviewer failures reached (3/3)"],
              recommendedAction: "Publish the missing triage recommendation without rerunning the agent.",
            },
          ],
          submittedAt: "2026-01-01T00:00:00.000Z",
          writebackOperationKeys: [],
        },
      ],
    });
    const harness = new FakeHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
      writeback,
    });

    await orchestrator.refreshNow();
    await orchestrator.stop();

    expect(writer.comments).toHaveLength(1);
    expect(writer.comments[0]).toMatchObject({
      issueId: candidate.id,
      dedupeKey: "issue-triage:triage-1",
    });
    expect(writer.comments[0]?.body).toContain("## Symphony Issue Triage");
    expect(writer.comments[0]?.body).toContain("Publish the missing triage recommendation without rerunning the agent.");
    await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
      lastIssueTriageReportId: "issue-triage-report:issue-1:triage-1",
      issueTriageReports: [
        {
          writebackOperationKeys: ["comment:issue-1:issue-triage:triage-1"],
        },
      ],
    });
    const issueState = await readIssueState(config.workspace.stateDir, candidate.id);
    const reconciliation = issueState?.history.find((snapshot) => snapshot.transitionKind === "reconcile_issue_triage_report_writeback");
    expect(reconciliation).toMatchObject({
      candidateSource: "tick_candidates",
      rulesetId: "orchestrator.reconcile_issue_triage_report_writeback",
      reason: "issue_triage_report_writeback_reconciliation",
    });
    expect(reconciliation?.actions.map((action) => action.actionType)).toEqual(
      expect.arrayContaining([
        "load_issue_triage_report_writeback",
        "plan_issue_triage_report_writebacks",
        "apply_issue_triage_report_writebacks",
        "mark_issue_triage_report_writeback_recorded",
      ]),
    );
  });

  it("does not redispatch persisted fallback-blocked issues after restart", async () => {
    const config = testConfig(root);
    config.reviewLoop.blockedStates = [];
    config.reviewLoop.maxIncompleteTurns = 2;
    const candidate = issue({ state: "In Progress" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const lifecycleStore = new FileIssueLifecycleStore(path.join(root, "state"));
    await lifecycleStore.ensureIssue(candidate, {
      phase: "blocked",
      incompleteTurnCount: 2,
      blockedReason: "max incomplete turns reached (2/2)",
    });
    const harness = new FakeHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await orchestrator.stop();

    expect(harness.runs).toHaveLength(0);
    await expect(lifecycleStore.get(candidate.identifier)).resolves.toMatchObject({
      phase: "blocked",
      blockedReason: "max incomplete turns reached (2/2)",
    });
  });

  it.each([
    ["setup-incomplete", PUBLICATION_APPROVAL_SETUP_INCOMPLETE_REASON],
    ["awaiting operator", PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON],
  ] as const)("does not redispatch issues with %s pending publication approval before Linear reaches Blocked", async (_name, blockedReason) => {
    const config = testConfig(root);
    config.reviewLoop.blockedStates = ["Blocked"];
    const candidate = issue({ state: "In Progress", branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const lifecycleStore = new FileIssueLifecycleStore(path.join(root, "state"));
    await lifecycleStore.ensureIssue(candidate, {
      ...pendingApprovalLifecyclePatch(candidate, root, "run-1", blockedReason),
      phase: "implementation",
    });
    const harness = new FakeHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await orchestrator.stop();

    expect(harness.runs).toHaveLength(0);
    await expect(lifecycleStore.get(candidate.identifier)).resolves.toMatchObject({
      phase: "implementation",
      blockedReason,
    });
  });

  it("does not stall-cancel lifecycle-only pending publication approval handoffs", async () => {
    const config = testConfig(root);
    config.reviewLoop.blockedStates = ["Blocked"];
    (config.raw as { codex?: { stall_timeout_ms?: number } }).codex = { stall_timeout_ms: 1 };
    const candidate = issue({ state: "Todo", labels: ["dogfood-ready"], branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const harness = new BlockingHarness();
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
    });

    try {
      await orchestrator.refreshNow();
      await waitFor(() => typeof orchestrator.snapshot().running[0]?.runId === "string", "worker run start");
      const runId = orchestrator.snapshot().running[0]?.runId ?? "";
      await waitForRunRecord(runStore, runId);
      await lifecycleStore.ensureIssue(
        candidate,
        pendingApprovalLifecyclePatch(candidate, root, runId, PUBLICATION_APPROVAL_SETUP_INCOMPLETE_REASON),
      );
      await runStore.updateRun(runId, {
        metadata: {
          pendingApprovalRequestId: null,
          pendingApprovalRequestedAt: null,
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 5));

      await orchestrator.refreshNow();

      expect(orchestrator.snapshot().counts.running).toBe(1);
      expect(orchestrator.snapshot().running[0]?.liveness.idleAlert).toMatchObject({
        active: false,
        reason: "suppressed",
      });
      const runningRun = await runStore.getRun(runId);
      expect(runningRun).toMatchObject({
        status: "running",
      });
      expect(runningRun?.pendingApprovalRequestId ?? null).toBeNull();
      expect(runningRun?.cancellationRequestedAt ?? null).toBeNull();
      await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
        phase: "blocked",
        blockedReason: PUBLICATION_APPROVAL_SETUP_INCOMPLETE_REASON,
        incompleteTurnCount: 0,
      });
      await expect(runStore.listRunsForIssue(candidate.id)).resolves.toHaveLength(1);
    } finally {
      await orchestrator.stop();
    }
  });

  it.each([
    {
      name: "comment fails while Blocked transition succeeds",
      writer: (setState: (state: string) => void) => new PublicationApprovalCommentFailingWriter(setState),
      stateBeforeRecovery: "Blocked",
      recoveryComments: 1,
      recoveryTransitions: 0,
    },
    {
      name: "Blocked transition fails after comment succeeds",
      writer: (setState: (state: string) => void) => new PublicationApprovalTransitionFailingWriter(setState),
      stateBeforeRecovery: "Todo",
      recoveryComments: 0,
      recoveryTransitions: 1,
    },
  ])(
    "recovers a real post-exit pending publication approval handoff after partial audit failure: $name",
    async ({ writer, stateBeforeRecovery, recoveryComments, recoveryTransitions }) => {
      const config = testConfig(root);
      config.writeback.enabled = true;
      config.writeback.mode = "live";
      config.writeback.dispatchState = "Todo";
      config.writeback.maxBackoffMs = 0;
      config.reviewLoop.blockedStates = ["Blocked"];
      config.github.publishPullRequests = true;
      config.github.owner = "acme";
      config.github.repo = "symphony";
      config.github.token = "github-token";
      config.github.operatorApproval!.requiredForPublication = true;
      config.workspace.source.baseRef = "main";
      const candidate = issue({ state: "Todo", labels: ["dogfood-ready"], branchName: "symphony/TEST-1" });
      let currentState = "Todo";
      const tracker: TrackerClient = {
        async fetchCandidateIssues() {
          return ["Todo", "In Progress"].includes(currentState) ? [{ ...candidate, state: currentState }] : [];
        },
        async fetchIssuesByStates(states) {
          return states.includes(currentState) ? [{ ...candidate, state: currentState }] : [];
        },
        async fetchIssueStatesByIds() {
          return [{ ...candidate, state: currentState }];
        },
      };
      const logger = new StructuredLogger(() => undefined);
      const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
      const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
      const outboxStore = new FileWritebackOutboxStore(config.workspace.stateDir);
      const approvalStore = new FileOperatorApprovalStore(config.workspace.stateDir);
      const operatorApproval = new OperatorApprovalService({ config, store: approvalStore, runStore });
      const partialWriter = writer((state) => {
        currentState = state;
      });
      const partialWriteback = new WritebackProcessor(outboxStore, partialWriter, logger, config.writeback.maxBackoffMs);
      const publisher = new FakeCompletionReportPublisher({
        action: "created",
        url: "https://github.com/acme/symphony/pull/42",
        number: 42,
        headBranch: "symphony/TEST-1",
        headSha: "abc123",
        lastPushedAt: "2026-01-01T00:00:01Z",
        evidenceCursor: "idem-1",
      });
      const harness = new ReportingHarness(
        lifecycleStore,
        outboxStore,
        runStore,
        publisher,
        "throw",
        operatorApproval,
        partialWriteback,
      );
      const firstOrchestrator = new Orchestrator({
        config,
        tracker,
        workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
        harness,
        logger,
        promptTemplate: "Work on {{ issue.identifier }}",
        lifecycleStore,
        runStore,
        writeback: partialWriteback,
        operatorApproval,
      });

      await firstOrchestrator.refreshNow();
      await waitFor(() => firstOrchestrator.snapshot().counts.running === 0, "partial audit worker exit");
      await firstOrchestrator.stop();

      expect(harness.prompts).toHaveLength(1);
      expect(harness.prompts[0]).toContain("Work on TEST-1");
      expect(currentState).toBe(stateBeforeRecovery);
      await expect(approvalStore.findPendingForRun("report-run-1")).resolves.toBeNull();
      const runBeforeRecovery = await waitForTerminalRunRecord(runStore, "report-run-1");
      expect(runBeforeRecovery).toMatchObject({ status: "succeeded" });
      expect(runBeforeRecovery?.pendingApprovalRequestId ?? null).toBeNull();
      await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
        phase: "blocked",
        blockedReason: PUBLICATION_APPROVAL_SETUP_INCOMPLETE_REASON,
        incompleteTurnCount: 0,
        completionReports: [
          expect.objectContaining({
            runId: "report-run-1",
            idempotencyKey: "idem-1",
            writebackOperationKeys: [],
          }),
        ],
      });
      expect(partialWriter.comments.some((comment) => comment.dedupeKey?.includes("run-failed"))).toBe(false);
      expect(partialWriter.comments.some((comment) => comment.dedupeKey?.includes("run-cancelled"))).toBe(false);
      expect(firstOrchestrator.snapshot().counts.retrying).toBe(0);
      await expect(runStore.listRunsForIssue(candidate.id)).resolves.toHaveLength(1);

      const recoveryWriter = new StateChangingWriter((state) => {
        currentState = state;
      });
      const recoveryWriteback = new WritebackProcessor(outboxStore, recoveryWriter, logger, config.writeback.maxBackoffMs);
      const recoveryOrchestrator = new Orchestrator({
        config,
        tracker,
        workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
        harness: new FakeHarness(),
        logger,
        promptTemplate: "Work on {{ issue.identifier }}",
        lifecycleStore,
        runStore,
        writeback: recoveryWriteback,
        operatorApproval,
      });

      await recoveryOrchestrator.refreshNow();
      const pending = await approvalStore.findPendingForRun("report-run-1");
      expect(pending).toMatchObject({
        status: "pending",
        issueId: candidate.id,
        issueIdentifier: candidate.identifier,
        runId: "report-run-1",
        evidenceCursor: "idem-1",
      });
      await recoveryOrchestrator.refreshNow();

      const approvals = await approvalStore.list();
      expect(approvals.filter((approval) => approval.runId === "report-run-1")).toHaveLength(1);
      await expect(runStore.getRun("report-run-1")).resolves.toMatchObject({
        status: "succeeded",
        pendingApprovalRequestId: pending?.requestId,
        pendingApprovalRequestedAt: pending?.requestedAt,
      });
      const transcript = await runStore.readTranscript("report-run-1");
      expect(transcript.events.filter((event) => event.eventType === "approval_request")).toHaveLength(1);
      expect(recoveryWriter.comments).toHaveLength(recoveryComments);
      expect(recoveryWriter.transitions).toHaveLength(recoveryTransitions);
      const pendingAuditOperations = (await outboxStore.list()).filter((operation) =>
        operation.idempotencyKey.includes("publication-approval-pending"),
      );
      expect(pendingAuditOperations).toHaveLength(2);
      expect(pendingAuditOperations.map((operation) => operation.status)).toEqual(["succeeded", "succeeded"]);
      expect(recoveryOrchestrator.snapshot().counts.running).toBe(0);
      expect(recoveryOrchestrator.snapshot().counts.retrying).toBe(0);
      expect(harness.prompts).toHaveLength(1);
      await expect(runStore.listRunsForIssue(candidate.id)).resolves.toHaveLength(1);
      const issueState = await readIssueState(config.workspace.stateDir, candidate.id);
      const recovery = issueState?.history.find((snapshot) => snapshot.transitionKind === "recover_publication_approval");
      expect(recovery).toMatchObject({
        candidateSource: "pending_publication_approval",
        rulesetId: "orchestrator.recover_publication_approval",
        runId: "report-run-1",
        pendingPublicationApprovalReportId: expect.any(String),
      });
      expect(recovery?.actions.map((action) => action.actionType)).toEqual(
        expect.arrayContaining([
          "verify_publication_approval_recovery_config",
          "load_recoverable_publication_approval_lifecycle",
          "record_publication_approval_recovery_started",
          "recover_publication_approval_handoff",
          "record_publication_approval_recovery_finished",
        ]),
      );
      await recoveryOrchestrator.stop();
    },
  );

  it("skips recovery for an already linked pending publication approval wait", async () => {
    const config = testConfig(root);
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.writeback.dispatchState = "Todo";
    config.github.publishPullRequests = true;
    config.github.owner = "acme";
    config.github.repo = "symphony";
    config.github.token = "github-token";
    config.github.operatorApproval!.requiredForPublication = true;
    config.workspace.source.baseRef = "main";
    const candidate = issue({ state: "Blocked", labels: ["dogfood-ready"], branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logs: string[] = [];
    const logger = new StructuredLogger((line) => logs.push(line));
    const stateDir = config.workspace.stateDir;
    const outboxStore = new FileWritebackOutboxStore(stateDir);
    const writer = new StateChangingWriter(() => undefined);
    const writeback = new WritebackProcessor(outboxStore, writer, logger, 300_000);
    const runStore = new FileRunTranscriptStore(stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const approvalStore = new FileOperatorApprovalStore(stateDir);
    const operatorApproval = new OperatorApprovalService({ config, store: approvalStore, runStore });
    await startApprovalRun(runStore, candidate, "run-1", root);
    const { record: approval } = await approvalStore.requestOrGetPending(
      {
        issueId: candidate.id,
        issueIdentifier: candidate.identifier,
        runId: "run-1",
        evidenceCursor: "idem-1",
        action: {
          kind: "push_and_pr",
          branchName: "symphony/TEST-1",
          baseBranch: "main",
          workspacePath: path.join(root, "workspace"),
          title: `${candidate.identifier}: ${candidate.title}`,
          evidenceCursor: "idem-1",
          summaryPreview: "Implemented the requested handoff.",
          changedFiles: ["src/core/orchestrator/Orchestrator.ts"],
          plannedOperations: ["commit_if_needed", "git_push", "pull_request_create_or_reuse"],
        },
      },
      null,
    );
    await runStore.updateRun("run-1", {
      status: "succeeded",
      completedAt: "2026-01-01T00:00:00.000Z",
      metadata: {
        pendingApprovalRequestId: approval.requestId,
        pendingApprovalRequestedAt: approval.requestedAt,
      },
    });
    await lifecycleStore.ensureIssue(candidate, pendingApprovalLifecyclePatch(candidate, root, "run-1"));
    const lifecycleBefore = await lifecycleStore.get(candidate.id);
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness: new FakeHarness(),
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
      writeback,
      operatorApproval,
    });

    try {
      await orchestrator.refreshNow();
      await orchestrator.refreshNow();

      expect(await approvalStore.list()).toHaveLength(1);
      expect(await outboxStore.list()).toEqual([]);
      expect(writer.comments).toEqual([]);
      expect(writer.transitions).toEqual([]);
      await expect(lifecycleStore.get(candidate.id)).resolves.toEqual(lifecycleBefore);
      await expect(runStore.getRun("run-1")).resolves.toMatchObject({
        pendingApprovalRequestId: approval.requestId,
        pendingApprovalRequestedAt: approval.requestedAt,
      });
      expect(logs.some((line) => line.includes("pending publication approval recovered"))).toBe(false);
      expect(orchestrator.snapshot().counts.running).toBe(0);
    } finally {
      await orchestrator.stop();
    }
  });

  it("leaves missing_run pending publication approval recovery untouched during orchestrator ticks", async () => {
    const config = testConfig(root);
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.writeback.dispatchState = "Todo";
    config.github.publishPullRequests = true;
    config.github.owner = "acme";
    config.github.repo = "symphony";
    config.github.token = "github-token";
    config.github.operatorApproval!.requiredForPublication = true;
    config.workspace.source.baseRef = "main";
    const candidate = issue({ state: "Blocked", labels: ["dogfood-ready"], branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logs: string[] = [];
    const logger = new StructuredLogger((line) => logs.push(line));
    const stateDir = config.workspace.stateDir;
    const outboxStore = new FileWritebackOutboxStore(stateDir);
    const writer = new StateChangingWriter(() => undefined);
    const writeback = new WritebackProcessor(outboxStore, writer, logger, 300_000);
    const runStore = new FileRunTranscriptStore(stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const approvalStore = new FileOperatorApprovalStore(stateDir);
    const operatorApproval = new OperatorApprovalService({ config, store: approvalStore, runStore });
    await lifecycleStore.ensureIssue(candidate, pendingApprovalLifecyclePatch(candidate, root, "missing-run"));
    const lifecycleBefore = await lifecycleStore.get(candidate.id);
    const publisher = new FakeCompletionReportPublisher({
      action: "created",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "idem-1",
    });
    const harness = new FakeHarness();
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
      writeback,
      operatorApproval,
      completionReportPublisher: publisher,
    });

    try {
      await orchestrator.refreshNow();
      await orchestrator.refreshNow();

      expect(await approvalStore.list()).toHaveLength(0);
      expect(await outboxStore.list()).toEqual([]);
      expect(writer.comments).toEqual([]);
      expect(writer.transitions).toEqual([]);
      await expect(lifecycleStore.get(candidate.id)).resolves.toEqual(lifecycleBefore);
      await expect(runStore.getRun("missing-run")).resolves.toBeNull();
      expect(publisher.inputs).toEqual([]);
      expect(harness.runs).toEqual([]);
      expect(logs.some((line) => line.includes("pending publication approval recovered"))).toBe(false);
      expect(orchestrator.snapshot().counts.running).toBe(0);
    } finally {
      await orchestrator.stop();
    }
  });

  it("leaves audit_not_settled pending publication approval recovery unfinalized during orchestrator ticks", async () => {
    const config = testConfig(root);
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.writeback.dispatchState = "Todo";
    config.writeback.maxBackoffMs = 0;
    config.reviewLoop.blockedStates = ["Blocked"];
    config.github.publishPullRequests = true;
    config.github.owner = "acme";
    config.github.repo = "symphony";
    config.github.token = "github-token";
    config.github.operatorApproval!.requiredForPublication = true;
    config.workspace.source.baseRef = "main";
    const candidate = issue({ state: "Todo", labels: ["dogfood-ready"], branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logs: string[] = [];
    const logger = new StructuredLogger((line) => logs.push(line));
    const stateDir = config.workspace.stateDir;
    const outboxStore = new FileWritebackOutboxStore(stateDir);
    const writer = new FailingWriter();
    const writeback = new WritebackProcessor(outboxStore, writer, logger, config.writeback.maxBackoffMs);
    const runStore = new FileRunTranscriptStore(stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const approvalStore = new FileOperatorApprovalStore(stateDir);
    const operatorApproval = new OperatorApprovalService({ config, store: approvalStore, runStore });
    await startApprovalRun(runStore, candidate, "run-1", root);
    await runStore.updateRun("run-1", { status: "succeeded", completedAt: "2026-01-01T00:00:00.000Z" });
    await lifecycleStore.ensureIssue(candidate, pendingApprovalLifecyclePatch(candidate, root, "run-1"));
    const lifecycleBefore = await lifecycleStore.get(candidate.id);
    const publisher = new FakeCompletionReportPublisher({
      action: "created",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "idem-1",
    });
    const harness = new FakeHarness();
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
      writeback,
      operatorApproval,
      completionReportPublisher: publisher,
    });

    try {
      await orchestrator.refreshNow();
      const operationsAfterFirstTick = await outboxStore.list();
      expect(operationsAfterFirstTick).toHaveLength(2);
      expect(operationsAfterFirstTick.map((operation) => operation.status)).toEqual(["retrying", "retrying"]);

      await orchestrator.refreshNow();
      const operationsAfterSecondTick = await outboxStore.list();
      expect(operationsAfterSecondTick).toHaveLength(2);
      expect(operationsAfterSecondTick.map((operation) => operation.status)).toEqual(["retrying", "retrying"]);

      expect(await approvalStore.list()).toHaveLength(0);
      await expect(approvalStore.findPendingForRun("run-1")).resolves.toBeNull();
      expect(writer.comments).toEqual([]);
      expect(writer.transitions).toEqual([]);
      await expect(lifecycleStore.get(candidate.id)).resolves.toEqual(lifecycleBefore);
      expect((await runStore.getRun("run-1"))?.pendingApprovalRequestId ?? null).toBeNull();
      expect(publisher.inputs).toEqual([]);
      expect(harness.runs).toEqual([]);
      expect(logs.some((line) => line.includes("pending publication approval recovered"))).toBe(false);
      expect(orchestrator.snapshot().counts.running).toBe(0);
    } finally {
      await orchestrator.stop();
    }
  });

  it("recovers a pre-approved publication approval handoff during an orchestrator tick", async () => {
    const config = testConfig(root);
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.writeback.dispatchState = "Todo";
    config.tracker.handoffStates = ["In Review"];
    config.reviewLoop.blockedStates = ["Blocked"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.reviewLoop.reviewerPromptTemplate = "Review {{ issue.identifier }}.";
    config.github.publishPullRequests = true;
    config.github.owner = "acme";
    config.github.repo = "symphony";
    config.github.token = "github-token";
    config.github.operatorApproval!.requiredForPublication = true;
    config.workspace.source.baseRef = "main";
    const candidate = issue({ state: "Blocked", labels: ["dogfood-ready"], branchName: "symphony/TEST-1" });
    let currentState = "Blocked";
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates(states) {
        return states.includes(currentState) ? [{ ...candidate, state: currentState }] : [];
      },
      async fetchIssueStatesByIds() {
        return [{ ...candidate, state: currentState }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const stateDir = config.workspace.stateDir;
    const outboxStore = new FileWritebackOutboxStore(stateDir);
    const writer = new StateChangingWriter((state) => {
      currentState = state;
    });
    const writeback = new WritebackProcessor(outboxStore, writer, logger, 300_000);
    const runStore = new FileRunTranscriptStore(stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const approvalStore = new FileOperatorApprovalStore(stateDir);
    const operatorApproval = new OperatorApprovalService({ config, store: approvalStore, runStore });
    await startApprovalRun(runStore, candidate, "run-1", root);
    await runStore.updateRun("run-1", { status: "succeeded", completedAt: "2026-01-01T00:00:00.000Z" });
    await lifecycleStore.ensureIssue(candidate, pendingApprovalLifecyclePatch(candidate, root, "run-1"));
    const { record } = await approvalStore.requestOrGetPending(
      {
        issueId: candidate.id,
        issueIdentifier: candidate.identifier,
        runId: "run-1",
        evidenceCursor: "idem-1",
        action: approvalRecordFor("pending", candidate, "run-1", root).action,
      },
      null,
    );
    await approvalStore.resolve(record.requestId, "approve");
    const publisher = new FakeCompletionReportPublisher({
      action: "created",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "idem-1",
    });
    const harness = new FakeHarness();
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
      writeback,
      operatorApproval,
      completionReportPublisher: publisher,
    });

    try {
      await orchestrator.refreshNow();
      await waitFor(() => publisher.inputs.length === 1, "approved recovery publication");
      await waitFor(
        () => harness.runs.filter((run) => run.ctx.role === "reviewer").length === 1,
        "reviewer dispatch after approved recovery",
      );

      expect(await approvalStore.list()).toHaveLength(1);
      await expect(approvalStore.findPendingForRun("run-1")).resolves.toBeNull();
      expect(publisher.inputs[0]).toMatchObject({
        workspacePath: path.join(root, "workspace"),
        branchName: "symphony/TEST-1",
        baseBranch: "main",
        evidenceCursor: "idem-1",
      });
      expect(writer.comments.filter((comment) => comment.body.includes("## Symphony Completion Report"))).toHaveLength(1);
      expect(writer.comments.filter((comment) => comment.body.includes("## Symphony Publication Approval Setup Incomplete"))).toHaveLength(1);
      expect(writer.transitions.map((transition) => transition.toState)).toEqual(["Blocked", "In Review"]);
      expect(currentState).toBe("In Review");
      await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
        phase: "review",
        blockedReason: null,
        completionReports: [
          expect.objectContaining({
            runId: "run-1",
            idempotencyKey: "idem-1",
            pullRequest: {
              url: "https://github.com/acme/symphony/pull/42",
              number: 42,
              headSha: "abc123",
              branch: "symphony/TEST-1",
            },
          }),
        ],
      });
      await expect(runStore.getRun("run-1")).resolves.toMatchObject({
        prUrl: "https://github.com/acme/symphony/pull/42",
        prNumber: 42,
        prHeadSha: "abc123",
        prBranch: "symphony/TEST-1",
      });
      expect((await runStore.getRun("run-1"))?.pendingApprovalRequestId ?? null).toBeNull();
      expect(harness.runs.filter((run) => run.ctx.role === "worker")).toHaveLength(0);
      expect(orchestrator.snapshot().counts.retrying).toBe(0);
    } finally {
      await orchestrator.stop();
    }
  });

  it("recovers a terminal publication approval handoff during an orchestrator tick", async () => {
    const config = testConfig(root);
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.writeback.dispatchState = "Todo";
    config.tracker.handoffStates = ["In Review"];
    config.reviewLoop.blockedStates = ["Blocked"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.github.publishPullRequests = true;
    config.github.owner = "acme";
    config.github.repo = "symphony";
    config.github.token = "github-token";
    config.github.operatorApproval!.requiredForPublication = true;
    config.workspace.source.baseRef = "main";
    const candidate = issue({ state: "Blocked", labels: ["dogfood-ready"], branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const stateDir = config.workspace.stateDir;
    const outboxStore = new FileWritebackOutboxStore(stateDir);
    const writer = new StateChangingWriter(() => undefined);
    const writeback = new WritebackProcessor(outboxStore, writer, logger, 300_000);
    const runStore = new FileRunTranscriptStore(stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const approvalStore = new FileOperatorApprovalStore(stateDir);
    const operatorApproval = new OperatorApprovalService({ config, store: approvalStore, runStore });
    await startApprovalRun(runStore, candidate, "run-1", root);
    await runStore.updateRun("run-1", { status: "succeeded", completedAt: "2026-01-01T00:00:00.000Z" });
    await lifecycleStore.ensureIssue(candidate, pendingApprovalLifecyclePatch(candidate, root, "run-1"));
    const { record } = await approvalStore.requestOrGetPending(
      {
        issueId: candidate.id,
        issueIdentifier: candidate.identifier,
        runId: "run-1",
        evidenceCursor: "idem-1",
        action: approvalRecordFor("pending", candidate, "run-1", root).action,
      },
      null,
    );
    await approvalStore.markExpired(record.requestId);
    const publisher = new FakeCompletionReportPublisher({
      action: "created",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "idem-1",
    });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness: new FakeHarness(),
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
      writeback,
      operatorApproval,
      completionReportPublisher: publisher,
    });

    try {
      await orchestrator.refreshNow();

      expect(await approvalStore.list()).toHaveLength(1);
      await expect(approvalStore.findPendingForRun("run-1")).resolves.toBeNull();
      expect(publisher.inputs).toEqual([]);
      expect(writer.comments.filter((comment) => comment.body.includes("## Symphony Publication Approval Setup Incomplete"))).toHaveLength(1);
      expect(writer.comments.filter((comment) => comment.body.includes("## Symphony Publication Approval Not Completed"))).toHaveLength(1);
      expect(writer.comments.some((comment) => comment.body.includes("Status: accepted"))).toBe(false);
      expect(writer.comments.some((comment) => comment.body.includes("Status: expired"))).toBe(true);
      expect(writer.transitions.map((transition) => transition.toState)).toEqual(["Blocked"]);
      await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
        phase: "blocked",
        blockedReason: "publication approval expired",
        completionReports: [
          expect.objectContaining({
            runId: "run-1",
            idempotencyKey: "idem-1",
            pullRequest: null,
            writebackOperationKeys: [],
          }),
        ],
      });
      const recoveredRun = await runStore.getRun("run-1");
      expect(recoveredRun?.prUrl ?? null).toBeNull();
      expect(recoveredRun?.pendingApprovalRequestId ?? null).toBeNull();
      expect(orchestrator.snapshot().counts.running).toBe(0);
      expect(orchestrator.snapshot().counts.retrying).toBe(0);
    } finally {
      await orchestrator.stop();
    }
  });

  it("clears blocked lifecycle counters after a human unblock transition", async () => {
    const config = testConfig(root);
    config.reviewLoop.blockedStates = ["Blocked"];
    const candidate = issue({ state: "In Progress" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const lifecycleStore = new FileIssueLifecycleStore(path.join(root, "state"));
    await lifecycleStore.ensureIssue(candidate, {
      phase: "blocked",
      reviewRound: 3,
      incompleteTurnCount: 2,
      blockedReason: "max review rounds reached (3/3)",
    });
    const harness = new BlockingHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
    });

    await orchestrator.refreshNow();
    await orchestrator.refreshNow();
    await waitFor(() => orchestrator.snapshot().running[0]?.runId !== null, "blocked lifecycle worker start");
    const lifecycle = orchestrator.snapshot().running[0]?.lifecycle;
    await orchestrator.stop();

    expect(harness.stoppedRunIds).toEqual(["run-123"]);
    expect(lifecycle).toMatchObject({
      phase: "implementation",
      reviewRound: 0,
      incompleteTurnCount: 0,
      blockedReason: null,
    });
  });

  it("reapplies Todo dispatch transitions after a prior dispatch writeback already succeeded", async () => {
    const config = testConfig(root);
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.writeback.dispatchState = "In Progress";
    config.reviewLoop.blockedStates = ["Blocked"];
    const candidate = issue({ state: "Todo", updatedAt: "2026-01-01T01:00:00Z" });
    let currentState = "Todo";
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [{ ...candidate, state: currentState }];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([{ ...candidate, state: currentState }], states);
      },
      async fetchIssueStatesByIds() {
        return [{ ...candidate, state: currentState }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const stateDir = path.join(root, "state");
    const outboxStore = new FileWritebackOutboxStore(stateDir);
    const oldDispatchRecord = await outboxStore.enqueueOnce({
      idempotencyKey: `transition:${candidate.id}:dispatch:In Progress`,
      kind: "transition",
      issueId: candidate.id,
      payload: {
        fromStates: ["Todo"],
        toState: "In Progress",
        reason: "Symphony dispatch",
      },
    });
    await outboxStore.markSucceeded(oldDispatchRecord);
    const writer = new StateChangingWriter((state) => {
      currentState = state;
    });
    const writeback = new WritebackProcessor(outboxStore, writer, logger, 300_000);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    await lifecycleStore.ensureIssue(candidate, {
      phase: "blocked",
      reviewRound: 3,
      incompleteTurnCount: 2,
      blockedReason: "max review rounds reached (3/3)",
    });
    const harness = new FakeHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      writeback,
      lifecycleStore,
    });

    await orchestrator.refreshNow();
    await orchestrator.refreshNow();
    await waitFor(() => harness.runs.length === 1, "worker dispatch after human Todo unblock");
    await waitFor(() => writer.transitions.length === 1, "dispatch transition writeback");
    await waitFor(() => orchestrator.snapshot().counts.running === 0, "worker dispatch exit");
    await settleOrchestratorExit();
    await orchestrator.stop();

    expect(writer.transitions).toEqual([
      expect.objectContaining({
        issueId: candidate.id,
        fromStates: ["Todo"],
        toState: "In Progress",
      }),
    ]);
    expect(currentState).toBe("In Progress");
    expect(harness.runs[0]?.ctx.issue.state).toBe("In Progress");
  });

  it("treats accepted completion reports as live handoff and suppresses continuation/no-report writeback", async () => {
    const config = testConfig(root);
    config.agent.maxTurns = 3;
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.tracker.handoffStates = ["Human Review"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.github.publishPullRequests = true;
    config.github.prHandoff.enabled = true;
    config.github.prHandoff.targetState = "Human Review";
    config.github.prHandoff.noCiAllowed = true;
    config.github.prHandoff.noCiEvidence = "No CI configured in unit test";
    config.github.owner = "acme";
    config.github.repo = "symphony";
    config.github.token = "github-token";
    config.workspace.source.baseRef = "main";
    const candidate = issue({ state: "Todo", labels: ["dogfood-ready"], branchName: "symphony/TEST-1" });
    let currentState = "Todo";
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [{ ...candidate, state: currentState }];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([{ ...candidate, state: currentState }], states);
      },
      async fetchIssueStatesByIds() {
        return [{ ...candidate, state: currentState }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const stateDir = config.workspace.stateDir;
    const outboxStore = new FileWritebackOutboxStore(stateDir);
    const writer = new StateChangingWriter((state) => {
      currentState = state;
    });
    const writeback = new WritebackProcessor(outboxStore, writer, logger, 300_000);
    const runStore = new FileRunTranscriptStore(stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const publisher = new FakeCompletionReportPublisher({
      action: "created",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "idem-1",
    });
    const harness = new ReportingHarness(lifecycleStore, outboxStore, runStore, publisher);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      writeback,
      lifecycleStore,
      runStore,
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await orchestrator.stop();

    expect(harness.prompts).toHaveLength(1);
    expect(harness.prompts[0]).toContain("Work on TEST-1");
    expect(writer.comments.map((comment) => comment.dedupeKey)).toEqual([
      "report-run-1:run-started",
      "pull-request-handoff:pr-42:abc123",
    ]);
    expect(writer.transitions.map((transition) => transition.toState)).toEqual(["In Progress", "Human Review"]);
    expect(currentState).toBe("Human Review");
    expect(writer.comments[1]?.body).toContain("https://github.com/acme/symphony/pull/42");
    expect(writer.comments.some((comment) => comment.dedupeKey.includes("run-succeeded"))).toBe(false);
    expect(writer.comments.some((comment) => comment.body.includes("without an accepted completion report"))).toBe(false);
    await expect(runStore.getRun("report-run-1")).resolves.toMatchObject({
      prUrl: "https://github.com/acme/symphony/pull/42",
      prNumber: 42,
      prHeadSha: "abc123",
      prBranch: "symphony/TEST-1",
      lastEvidenceCursor: "idem-1",
    });
    await expect(lifecycleStore.get(candidate.identifier)).resolves.toMatchObject({
      phase: "review",
      incompleteTurnCount: 0,
      summaryPointers: {
        prUrl: "https://github.com/acme/symphony/pull/42",
        prNumber: 42,
        prHeadSha: "abc123",
        prBranch: "symphony/TEST-1",
        lastEvidenceCursor: "idem-1",
      },
    });
    expect(orchestrator.snapshot().counts.retrying).toBe(0);
  });

  it("surfaces rejected completion reports in Linear comments and subsequent worker prompts", async () => {
    const config = testConfig(root);
    config.agent.maxTurns = 2;
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    const candidate = issue({ state: "In Progress", branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const stateDir = config.workspace.stateDir;
    const outboxStore = new FileWritebackOutboxStore(stateDir);
    const writer = new StateChangingWriter(() => undefined);
    const writeback = new WritebackProcessor(outboxStore, writer, logger, 300_000);
    const runStore = new FileRunTranscriptStore(stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const harness = new RejectedCompletionReportHarness(lifecycleStore, outboxStore, runStore);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      writeback,
      lifecycleStore,
      runStore,
    });

    await orchestrator.refreshNow();
    await waitFor(() => harness.prompts.length === 2, "worker continuation after rejected completion report");
    await waitFor(() => writer.comments.some((comment) => comment.body.includes("Status: rejected")), "rejection comment");
    await orchestrator.stop();

    const rejectionComment = writer.comments.find((comment) => comment.body.includes("Status: rejected"));
    expect(rejectionComment?.dedupeKey).toBe("reject-run-1:completion-report:rejected-idem-1:rejected");
    expect(rejectionComment?.body).toContain("Completion report cannot be accepted with unsatisfied acceptance checklist items");
    expect(rejectionComment?.body).toContain("REQ-1 Required validation is complete.");
    expect(harness.prompts[1]).toContain(
      "Next action: Fix the rejected completion report: satisfy every acceptance checklist item with durable evidence before submitting again.",
    );
    expect(harness.prompts[1]).toContain("Latest rejected completion report:");
    expect(harness.prompts[1]).toContain("Reason: Completion report cannot be accepted with unsatisfied acceptance checklist items");
    expect(harness.prompts[1]).toContain("REQ-1 Required validation is complete.");
    const lifecycle = await lifecycleStore.get(candidate.id);
    expect(lifecycle?.incompleteTurnCount).toBeGreaterThanOrEqual(1);
    expect(lifecycle).toMatchObject({
      lastCompletionReportRejectionId: "completion-report-rejection:issue-1:rejected-idem-1",
    });
    const issueState = await readIssueState(stateDir, candidate.id);
    const workerSnapshots = issueState?.history.filter((snapshot) => snapshot.transitionKind === "dispatch_worker") ?? [];
    expect(workerSnapshots.every((snapshot) => snapshot.rulesetId !== "legacy.dispatch_worker")).toBe(true);
    const rejectionSnapshot = issueState?.history.find((snapshot) => snapshot.transitionKind === "reconcile_completion_report_rejection");
    expect(rejectionSnapshot).toMatchObject({
      triggerType: "runtime.requested",
      triggerSource: "transition",
      candidateSource: "completion_report_rejection",
      rulesetId: "orchestrator.completion_report_rejection",
      runId: "reject-run-1",
      transitionRequestContext: {
        kind: "completion_report_rejection",
        parentTransitionKind: "dispatch_worker",
        payload: {
          runId: "reject-run-1",
          role: "worker",
          runPhase: "implementation",
          runKind: "implementation",
        },
      },
    });
    expect(rejectionSnapshot?.actions.map((action) => action.actionType)).toEqual(
      expect.arrayContaining([
        "load_completion_report_rejection",
        "mark_completion_report_rejected",
        "process_completion_report_rejection_writebacks",
      ]),
    );
    expect(workerSnapshots.some((snapshot) => snapshot.actions.some((action) => action.actionType === "reject_completion_report"))).toBe(false);
    expect(issueState?.history.some((snapshot) => snapshot.transitionKind === "handoff_repair")).toBe(false);
  });

  it("[event-guard:failed] treats accepted completion reports as handoff when the harness fails after reporting", async () => {
    const config = testConfig(root);
    config.agent.maxTurns = 3;
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.tracker.handoffStates = ["Human Review"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.github.publishPullRequests = true;
    config.github.prHandoff.enabled = true;
    config.github.prHandoff.targetState = "Human Review";
    config.github.prHandoff.noCiAllowed = true;
    config.github.prHandoff.noCiEvidence = "No CI configured in unit test";
    config.github.owner = "acme";
    config.github.repo = "symphony";
    config.github.token = "github-token";
    config.workspace.source.baseRef = "main";
    const candidate = issue({ state: "Todo", labels: ["dogfood-ready"], branchName: "symphony/TEST-1" });
    let currentState = "Todo";
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [{ ...candidate, state: currentState }];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([{ ...candidate, state: currentState }], states);
      },
      async fetchIssueStatesByIds() {
        return [{ ...candidate, state: currentState }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const stateDir = config.workspace.stateDir;
    const outboxStore = new FileWritebackOutboxStore(stateDir);
    const writer = new StateChangingWriter((state) => {
      currentState = state;
    });
    const writeback = new WritebackProcessor(outboxStore, writer, logger, 300_000);
    const runStore = new FileRunTranscriptStore(stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const publisher = new FakeCompletionReportPublisher({
      action: "created",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "idem-1",
    });
    const harness = new ReportingHarness(lifecycleStore, outboxStore, runStore, publisher, {
      type: "failed",
      error: "post-handoff harness failure",
    });
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      writeback,
      lifecycleStore,
      runStore,
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await orchestrator.stop();

    expect(harness.prompts).toHaveLength(1);
    expect(harness.prompts[0]).toContain("Work on TEST-1");
    expect(writer.comments.map((comment) => comment.dedupeKey)).toEqual([
      "report-run-1:run-started",
      "pull-request-handoff:pr-42:abc123",
    ]);
    expect(writer.transitions.map((transition) => transition.toState)).toEqual(["In Progress", "Human Review"]);
    expect(currentState).toBe("Human Review");
    expect(writer.comments.some((comment) => comment.dedupeKey.includes("run-failed"))).toBe(false);
    expect(writer.comments.some((comment) => comment.dedupeKey.includes("run-cancelled"))).toBe(false);
    expect(writer.comments.some((comment) => comment.dedupeKey.includes("run-succeeded"))).toBe(false);
    expect(writer.comments.some((comment) => comment.body.includes("without an accepted completion report"))).toBe(false);
    await expect(runStore.getRun("report-run-1")).resolves.toMatchObject({
      status: "succeeded",
      prUrl: "https://github.com/acme/symphony/pull/42",
      prNumber: 42,
      prHeadSha: "abc123",
      prBranch: "symphony/TEST-1",
      lastEvidenceCursor: "idem-1",
    });
    await expect(lifecycleStore.get(candidate.identifier)).resolves.toMatchObject({
      phase: "review",
      incompleteTurnCount: 0,
      summaryPointers: {
        prUrl: "https://github.com/acme/symphony/pull/42",
        prNumber: 42,
        prHeadSha: "abc123",
        prBranch: "symphony/TEST-1",
        lastEvidenceCursor: "idem-1",
      },
    });
    const transcript = await runStore.readTranscript("report-run-1");
    const eventTypes = transcript.events.map((event) => event.eventType);
    expect(eventTypes).toContain("session_started");
    expect(eventTypes).toContain("handoff_terminal");
    expect(transcript.events.find((event) => event.eventType === "handoff_terminal")?.payload).toMatchObject({
      kind: "pull_request_handoff",
      status: "succeeded",
    });
    expect(eventTypes).toContain("failed");
    expect(eventTypes).not.toContain("completed");
    await expectReplaySucceededFromHandoff(stateDir, "report-run-1", {
      prUrl: "https://github.com/acme/symphony/pull/42",
      prNumber: 42,
      prHeadSha: "abc123",
      prBranch: "symphony/TEST-1",
      lastEvidenceCursor: "idem-1",
    });
    expect(orchestrator.snapshot().counts.retrying).toBe(0);
  });

  it("[event-guard:cancelled] treats accepted completion reports as handoff when the harness is cancelled after reporting", async () => {
    const config = testConfig(root);
    config.agent.maxTurns = 3;
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.tracker.handoffStates = ["Human Review"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.github.publishPullRequests = true;
    config.github.prHandoff.enabled = true;
    config.github.prHandoff.targetState = "Human Review";
    config.github.prHandoff.noCiAllowed = true;
    config.github.prHandoff.noCiEvidence = "No CI configured in unit test";
    config.github.owner = "acme";
    config.github.repo = "symphony";
    config.github.token = "github-token";
    config.workspace.source.baseRef = "main";
    const candidate = issue({ state: "Todo", labels: ["dogfood-ready"], branchName: "symphony/TEST-1" });
    let currentState = "Todo";
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [{ ...candidate, state: currentState }];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([{ ...candidate, state: currentState }], states);
      },
      async fetchIssueStatesByIds() {
        return [{ ...candidate, state: currentState }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const stateDir = config.workspace.stateDir;
    const outboxStore = new FileWritebackOutboxStore(stateDir);
    const writer = new StateChangingWriter((state) => {
      currentState = state;
    });
    const writeback = new WritebackProcessor(outboxStore, writer, logger, 300_000);
    const runStore = new FileRunTranscriptStore(stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const publisher = new FakeCompletionReportPublisher({
      action: "created",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "idem-1",
    });
    const harness = new ReportingHarness(lifecycleStore, outboxStore, runStore, publisher, {
      type: "cancelled",
    });
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      writeback,
      lifecycleStore,
      runStore,
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await orchestrator.stop();

    expect(harness.prompts).toHaveLength(1);
    expect(harness.prompts[0]).toContain("Work on TEST-1");
    expect(writer.comments.map((comment) => comment.dedupeKey)).toEqual([
      "report-run-1:run-started",
      "pull-request-handoff:pr-42:abc123",
    ]);
    expect(writer.transitions.map((transition) => transition.toState)).toEqual(["In Progress", "Human Review"]);
    expect(currentState).toBe("Human Review");
    expect(writer.comments.some((comment) => comment.dedupeKey.includes("run-failed"))).toBe(false);
    expect(writer.comments.some((comment) => comment.dedupeKey.includes("run-cancelled"))).toBe(false);
    expect(writer.comments.some((comment) => comment.dedupeKey.includes("run-succeeded"))).toBe(false);
    expect(writer.comments.some((comment) => comment.body.includes("without an accepted completion report"))).toBe(false);
    await expect(runStore.getRun("report-run-1")).resolves.toMatchObject({
      status: "succeeded",
      prUrl: "https://github.com/acme/symphony/pull/42",
      prNumber: 42,
      prHeadSha: "abc123",
      prBranch: "symphony/TEST-1",
      lastEvidenceCursor: "idem-1",
    });
    await expect(lifecycleStore.get(candidate.identifier)).resolves.toMatchObject({
      phase: "review",
      incompleteTurnCount: 0,
      summaryPointers: {
        prUrl: "https://github.com/acme/symphony/pull/42",
        prNumber: 42,
        prHeadSha: "abc123",
        prBranch: "symphony/TEST-1",
        lastEvidenceCursor: "idem-1",
      },
    });
    const transcript = await runStore.readTranscript("report-run-1");
    const eventTypes = transcript.events.map((event) => event.eventType);
    expect(eventTypes).toContain("session_started");
    expect(eventTypes).toContain("handoff_terminal");
    expect(transcript.events.find((event) => event.eventType === "handoff_terminal")?.payload).toMatchObject({
      kind: "pull_request_handoff",
      status: "succeeded",
    });
    expect(eventTypes).toContain("cancelled");
    expect(eventTypes).not.toContain("completed");
    await expectReplaySucceededFromHandoff(stateDir, "report-run-1", {
      prUrl: "https://github.com/acme/symphony/pull/42",
      prNumber: 42,
      prHeadSha: "abc123",
      prBranch: "symphony/TEST-1",
      lastEvidenceCursor: "idem-1",
    });
    expect(orchestrator.snapshot().counts.retrying).toBe(0);
  });

  it("[backstop:throw] reconciles accepted completion reports when the harness throws after reporting", async () => {
    const config = testConfig(root);
    config.agent.maxTurns = 3;
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.tracker.handoffStates = ["Human Review"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.github.publishPullRequests = true;
    config.github.prHandoff.enabled = true;
    config.github.prHandoff.targetState = "Human Review";
    config.github.prHandoff.noCiAllowed = true;
    config.github.prHandoff.noCiEvidence = "No CI configured in unit test";
    config.github.owner = "acme";
    config.github.repo = "symphony";
    config.github.token = "github-token";
    config.workspace.source.baseRef = "main";
    const candidate = issue({ state: "Todo", labels: ["dogfood-ready"], branchName: "symphony/TEST-1" });
    let currentState = "Todo";
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [{ ...candidate, state: currentState }];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([{ ...candidate, state: currentState }], states);
      },
      async fetchIssueStatesByIds() {
        return [{ ...candidate, state: currentState }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const stateDir = config.workspace.stateDir;
    const outboxStore = new FileWritebackOutboxStore(stateDir);
    const writer = new StateChangingWriter((state) => {
      currentState = state;
    });
    const writeback = new WritebackProcessor(outboxStore, writer, logger, 300_000);
    const runStore = new FileRunTranscriptStore(stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const publisher = new FakeCompletionReportPublisher({
      action: "created",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "idem-1",
    });
    const harness = new ReportingHarness(lifecycleStore, outboxStore, runStore, publisher, "throw");
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      writeback,
      lifecycleStore,
      runStore,
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await orchestrator.stop();

    expect(harness.prompts).toHaveLength(1);
    expect(harness.prompts[0]).toContain("Work on TEST-1");
    expect(writer.comments.map((comment) => comment.dedupeKey)).toEqual([
      "report-run-1:run-started",
      "pull-request-handoff:pr-42:abc123",
    ]);
    expect(writer.transitions.map((transition) => transition.toState)).toEqual(["In Progress", "Human Review"]);
    expect(currentState).toBe("Human Review");
    expect(writer.comments.some((comment) => comment.dedupeKey.includes("run-failed"))).toBe(false);
    expect(writer.comments.some((comment) => comment.dedupeKey.includes("run-cancelled"))).toBe(false);
    expect(writer.comments.some((comment) => comment.dedupeKey.includes("run-succeeded"))).toBe(false);
    expect(writer.comments.some((comment) => comment.body.includes("without an accepted completion report"))).toBe(false);
    await expect(runStore.getRun("report-run-1")).resolves.toMatchObject({
      status: "succeeded",
      prUrl: "https://github.com/acme/symphony/pull/42",
      prNumber: 42,
      prHeadSha: "abc123",
      prBranch: "symphony/TEST-1",
      lastEvidenceCursor: "idem-1",
    });
    await expect(lifecycleStore.get(candidate.identifier)).resolves.toMatchObject({
      phase: "review",
      incompleteTurnCount: 0,
      summaryPointers: {
        prUrl: "https://github.com/acme/symphony/pull/42",
        prNumber: 42,
        prHeadSha: "abc123",
        prBranch: "symphony/TEST-1",
        lastEvidenceCursor: "idem-1",
      },
    });
    const transcript = await runStore.readTranscript("report-run-1");
    const eventTypes = transcript.events.map((event) => event.eventType);
    expect(eventTypes).toContain("session_started");
    expect(eventTypes).toContain("handoff_terminal");
    expect(transcript.events.find((event) => event.eventType === "handoff_terminal")?.payload).toMatchObject({
      kind: "pull_request_handoff",
      status: "succeeded",
    });
    expect(eventTypes).not.toContain("failed");
    expect(eventTypes).not.toContain("cancelled");
    expect(eventTypes).not.toContain("completed");
    await expectReplaySucceededFromHandoff(stateDir, "report-run-1", {
      prUrl: "https://github.com/acme/symphony/pull/42",
      prNumber: 42,
      prHeadSha: "abc123",
      prBranch: "symphony/TEST-1",
      lastEvidenceCursor: "idem-1",
    });
    expect(orchestrator.snapshot().counts.retrying).toBe(0);
  });

  it("preserves fail-policy approval rejection through abnormal worker exit", async () => {
    const config = testConfig(root);
    config.agent.maxTurns = 3;
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.writeback.dispatchState = "Todo";
    config.reviewLoop.blockedStates = ["Blocked"];
    config.tracker.handoffStates = ["In Review"];
    config.github.publishPullRequests = true;
    config.github.owner = "acme";
    config.github.repo = "symphony";
    config.github.token = "github-token";
    config.github.operatorApproval!.requiredForPublication = true;
    config.github.operatorApproval!.rejectPolicy = "fail";
    config.github.operatorApproval!.pollIntervalMs = 5;
    config.workspace.source.baseRef = "main";
    const candidate = issue({ state: "Todo", labels: ["dogfood-ready"], branchName: "symphony/TEST-1" });
    let currentState = "Todo";
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [{ ...candidate, state: currentState }];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([{ ...candidate, state: currentState }], states);
      },
      async fetchIssueStatesByIds() {
        return [{ ...candidate, state: currentState }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const stateDir = config.workspace.stateDir;
    const outboxStore = new FileWritebackOutboxStore(stateDir);
    const writer = new StateChangingWriter((state) => {
      currentState = state;
    });
    const writeback = new WritebackProcessor(outboxStore, writer, logger, 300_000);
    const runStore = new FileRunTranscriptStore(stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const approvalStore = new FileOperatorApprovalStore(stateDir);
    const operatorApproval = new OperatorApprovalService({ config, store: approvalStore, runStore });
    const publisher = new FakeCompletionReportPublisher({
      action: "created",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "idem-1",
    });
    const harness = new ReportingHarness(
      lifecycleStore,
      outboxStore,
      runStore,
      publisher,
      { type: "completed" },
      operatorApproval,
      writeback,
    );
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
      writeback,
    });

    await orchestrator.refreshNow();
    const pending = await waitForPendingApproval(approvalStore, "report-run-1");
    await operatorApproval.resolve(pending.requestId, "reject");
    const rejectedRun = await waitForRunRecord(runStore, "report-run-1");
    const rejectedAt = rejectedRun?.completedAt;

    expect(rejectedRun).toMatchObject({
      status: "failed",
      completedAt: expect.any(String),
      error: OPERATOR_REJECTED_PUBLICATION_ERROR,
      pendingApprovalRequestId: null,
    });
    await waitFor(() => orchestrator.snapshot().counts.running === 0, "approval-rejected worker exit");

    const finalRun = await waitForTerminalRunRecord(runStore, "report-run-1");
    expect(finalRun).toMatchObject({
      status: "failed",
      completedAt: expect.any(String),
      error: OPERATOR_REJECTED_PUBLICATION_ERROR,
      pendingApprovalRequestId: null,
    });
    expect(finalRun?.cancellationRequestedAt ?? null).toBeNull();
    expect(finalRun?.cancellationSource ?? null).toBeNull();
    expect(finalRun?.cancellationOutcome ?? "none").toBe("none");
    expect(publisher.inputs).toEqual([]);
    expect(writer.comments.some((comment) => comment.body.includes("Publication Approval Setup Incomplete"))).toBe(true);
    expect(writer.transitions.map((transition) => transition.toState)).toEqual(["Todo", "Blocked"]);
    expect(orchestrator.snapshot().counts.retrying).toBe(0);
    await orchestrator.stop();
  });

  it("preserves cancel-policy approval rejection through cancelled worker exit", async () => {
    const config = testConfig(root);
    config.agent.maxTurns = 3;
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.writeback.dispatchState = "Todo";
    config.reviewLoop.blockedStates = ["Blocked"];
    config.tracker.handoffStates = ["In Review"];
    config.github.publishPullRequests = true;
    config.github.owner = "acme";
    config.github.repo = "symphony";
    config.github.token = "github-token";
    config.github.operatorApproval!.requiredForPublication = true;
    config.github.operatorApproval!.rejectPolicy = "cancel";
    config.github.operatorApproval!.pollIntervalMs = 5;
    config.workspace.source.baseRef = "main";
    const candidate = issue({ state: "Todo", labels: ["dogfood-ready"], branchName: "symphony/TEST-1" });
    let currentState = "Todo";
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [{ ...candidate, state: currentState }];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([{ ...candidate, state: currentState }], states);
      },
      async fetchIssueStatesByIds() {
        return [{ ...candidate, state: currentState }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const stateDir = config.workspace.stateDir;
    const outboxStore = new FileWritebackOutboxStore(stateDir);
    const writer = new StateChangingWriter((state) => {
      currentState = state;
    });
    const writeback = new WritebackProcessor(outboxStore, writer, logger, 300_000);
    const runStore = new FileRunTranscriptStore(stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const approvalStore = new FileOperatorApprovalStore(stateDir);
    const operatorApproval = new OperatorApprovalService({ config, store: approvalStore, runStore });
    const publisher = new FakeCompletionReportPublisher({
      action: "created",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "idem-1",
    });
    const harness = new ReportingHarness(
      lifecycleStore,
      outboxStore,
      runStore,
      publisher,
      { type: "completed" },
      operatorApproval,
      writeback,
    );
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
      writeback,
    });

    await orchestrator.refreshNow();
    const pending = await waitForPendingApproval(approvalStore, "report-run-1");
    expect(writer.comments.some((comment) => comment.body.includes("Publication Approval Setup Incomplete"))).toBe(true);
    expect(writer.transitions.map((transition) => transition.toState)).toEqual(["Todo", "Blocked"]);
    const result = await operatorApproval.resolve(pending.requestId, "reject");
    await orchestrator.cancelIssue(candidate.id);
    await orchestrator.recordPublicationApprovalTerminal(result.request);
    await waitFor(() => orchestrator.snapshot().counts.running === 0, "approval-rejected cancel-policy worker exit");

    const finalRun = await waitForTerminalRunRecord(runStore, "report-run-1");
    expect(finalRun).toMatchObject({
      status: "cancelled",
      completedAt: expect.any(String),
      pendingApprovalRequestId: null,
    });
    expect(publisher.inputs).toEqual([]);
    expect(writer.comments.some((comment) => comment.body.includes("Status: rejected"))).toBe(true);
    expect(writer.comments.some((comment) => comment.dedupeKey === "report-run-1:completion-report:idem-1")).toBe(false);
    expect(writer.transitions.map((transition) => transition.toState)).toEqual(["Todo", "Blocked"]);
    await expect(lifecycleStore.get(candidate.identifier)).resolves.toMatchObject({
      phase: "blocked",
      blockedReason: "publication approval rejected",
      incompleteTurnCount: 0,
      completionReports: [
        {
          idempotencyKey: "idem-1",
          runId: "report-run-1",
          writebackOperationKeys: [],
        },
      ],
    });
    await orchestrator.refreshNow();
    expect(harness.prompts).toHaveLength(1);
    expect(orchestrator.snapshot().counts.retrying).toBe(0);
    await orchestrator.stop();
  });

  it("resumes approved publication through the orchestrator after the worker exits", async () => {
    const config = testConfig(root);
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.writeback.dispatchState = "Todo";
    config.reviewLoop.blockedStates = ["Blocked"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.github.publishPullRequests = true;
    config.github.owner = "acme";
    config.github.repo = "symphony";
    config.github.token = "github-token";
    config.workspace.source.baseRef = "main";
    const candidate = issue({ state: "Blocked", labels: ["dogfood-ready"], branchName: "symphony/TEST-1" });
    let currentState = "Blocked";
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([], states);
      },
      async fetchIssueStatesByIds() {
        return [{ ...candidate, state: currentState }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const stateDir = config.workspace.stateDir;
    const outboxStore = new FileWritebackOutboxStore(stateDir);
    const writer = new StateChangingWriter((state) => {
      currentState = state;
    });
    const writeback = new WritebackProcessor(outboxStore, writer, logger, 300_000);
    const runStore = new FileRunTranscriptStore(stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    await startApprovalRun(runStore, candidate, "run-1", root);
    await runStore.updateRun("run-1", { status: "succeeded", completedAt: "2026-01-01T00:00:00.000Z" });
    await lifecycleStore.ensureIssue(candidate, pendingApprovalLifecyclePatch(candidate, root, "run-1"));
    const publisher = new FakeCompletionReportPublisher({
      action: "created",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "idem-1",
    });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness: new FakeHarness(),
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
      writeback,
      completionReportPublisher: publisher,
    });

    await expect(orchestrator.resumeApprovedPublication(approvalRecordFor("approved", candidate, "run-1", root))).resolves.toBe(
      true,
    );

    expect(publisher.inputs).toHaveLength(1);
    expect(publisher.inputs[0]).toMatchObject({
      workspacePath: path.join(root, "workspace"),
      branchName: "symphony/TEST-1",
      baseBranch: "main",
      evidenceCursor: "idem-1",
    });
    expect(writer.comments).toHaveLength(1);
    expect(writer.comments[0]?.body).toContain("## Symphony Completion Report");
    expect(writer.comments[0]?.body).toContain("Status: accepted");
    expect(writer.comments[0]?.body).not.toContain("Publication Approval Not Completed");
    expect(writer.transitions).toHaveLength(1);
    expect(writer.transitions[0]).toMatchObject({ toState: "In Review" });
    await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
      phase: "review",
      blockedReason: null,
      completionReports: [
        expect.objectContaining({
          runId: "run-1",
          idempotencyKey: "idem-1",
          pullRequest: {
            url: "https://github.com/acme/symphony/pull/42",
            number: 42,
            headSha: "abc123",
            branch: "symphony/TEST-1",
          },
        }),
      ],
    });
    await expect(runStore.getRun("run-1")).resolves.toMatchObject({
      prUrl: "https://github.com/acme/symphony/pull/42",
      prNumber: 42,
      prHeadSha: "abc123",
    });
    await orchestrator.stop();
  });

  it.each([
    ["stale", "run cancellation has been requested"],
    ["expired", "approval request expired"],
  ] as const)(
    "records terminal publication approval recovery through the orchestrator when approval is %s after worker exit",
    async (status, staleReason) => {
      const config = testConfig(root);
      config.writeback.enabled = true;
      config.writeback.mode = "live";
      config.writeback.dispatchState = "Todo";
      config.reviewLoop.blockedStates = ["Blocked"];
      config.reviewLoop.reviewStates = ["In Review"];
      config.github.publishPullRequests = true;
      config.github.owner = "acme";
      config.github.repo = "symphony";
      config.github.token = "github-token";
      config.workspace.source.baseRef = "main";
      const candidate = issue({ state: "Blocked", labels: ["dogfood-ready"], branchName: "symphony/TEST-1" });
      const tracker: TrackerClient = {
        async fetchCandidateIssues() {
          return [];
        },
        async fetchIssuesByStates(states) {
          return issuesInStates([], states);
        },
        async fetchIssueStatesByIds() {
          return [candidate];
        },
      };
      const logger = new StructuredLogger(() => undefined);
      const stateDir = config.workspace.stateDir;
      const outboxStore = new FileWritebackOutboxStore(stateDir);
      const writer = new StateChangingWriter(() => undefined);
      const writeback = new WritebackProcessor(outboxStore, writer, logger, 300_000);
      const runStore = new FileRunTranscriptStore(stateDir);
      const lifecycleStore = new FileIssueLifecycleStore(stateDir);
      await startApprovalRun(runStore, candidate, "run-1", root);
      await runStore.updateRun("run-1", { status: "succeeded", completedAt: "2026-01-01T00:00:00.000Z" });
      await lifecycleStore.ensureIssue(candidate, pendingApprovalLifecyclePatch(candidate, root, "run-1"));
      const orchestrator = new Orchestrator({
        config,
        tracker,
        workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
        harness: new FakeHarness(),
        logger,
        promptTemplate: "Work on {{ issue.identifier }}",
        lifecycleStore,
        runStore,
        writeback,
      });
      const approval = approvalRecordFor(status, candidate, "run-1", root, staleReason);

      await expect(orchestrator.recordPublicationApprovalTerminal(approval)).resolves.toBe(true);
      await expect(orchestrator.recordPublicationApprovalTerminal(approval)).resolves.toBe(true);

      expect(writer.comments).toHaveLength(1);
      expect(writer.comments[0]?.body).toContain("## Symphony Publication Approval Not Completed");
      expect(writer.comments[0]?.body).toContain(`Status: ${status}`);
      expect(writer.comments[0]?.body).toContain(`Reason: ${staleReason}`);
      expect(writer.comments[0]?.body).toContain("The worker completion report remains stored");
      expect(writer.transitions).toEqual([]);
      await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
        phase: "blocked",
        blockedReason: `publication approval ${status}`,
      });
      await orchestrator.stop();
    },
  );

  it("smokes a manufactured fail, revision worker, and pass review loop", async () => {
    const config = testConfig(root);
    config.agent.maxConcurrentAgents = 1;
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.writeback.dispatchState = "In Progress";
    config.tracker.handoffStates = ["In Review"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.reviewLoop.reviewPassState = "Ready to Merge";
    expect(config.continuationContext.searchEnabled).toBe(false);
    expect(config.continuationContext.summarizationEnabled).toBe(false);

    const candidate = issue({ state: "Todo", labels: ["dogfood-ready"], branchName: "symphony/TEST-1" });
    let currentState = "Todo";
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return ["Todo", "In Progress"].includes(currentState) ? [{ ...candidate, state: currentState }] : [];
      },
      async fetchIssuesByStates(states) {
        return states.includes(currentState) ? [{ ...candidate, state: currentState }] : [];
      },
      async fetchIssueStatesByIds() {
        return [{ ...candidate, state: currentState }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const stateDir = config.workspace.stateDir;
    const outboxStore = new FileWritebackOutboxStore(stateDir);
    const writer = new StateChangingWriter((state) => {
      currentState = state;
    });
    const writeback = new WritebackProcessor(outboxStore, writer, logger, 300_000);
    const runStore = new FileRunTranscriptStore(stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const harness = new ManufacturedReviewLoopHarness(lifecycleStore, outboxStore, runStore);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      writeback,
      lifecycleStore,
      runStore,
    });

    try {
      await orchestrator.refreshNow();
      await waitFor(
        () => currentState === "In Review" && harness.runs.length === 1 && orchestrator.snapshot().counts.running === 0,
        "first worker handoff",
      );
      await runStore.appendEvent({
        runId: "smoke-worker-run-1",
        at: "2026-01-01T00:00:10.000Z",
        source: "harness",
        eventType: "progress",
        message: `RAW_TRANSCRIPT_SECRET ${"x".repeat(20_000)}`,
      });
      await settleOrchestratorExit();

      await orchestrator.refreshNow();
      await waitFor(
        () => currentState === "In Progress" && harness.runs.length === 2 && orchestrator.snapshot().counts.running === 0,
        "reviewer fail handoff",
      );
      await settleOrchestratorExit();

      await orchestrator.refreshNow();
      await waitFor(
        () => currentState === "In Review" && harness.runs.length === 3 && orchestrator.snapshot().counts.running === 0,
        "revision worker handoff",
      );
      await settleOrchestratorExit();

      await orchestrator.refreshNow();
      await waitFor(
        () => currentState === "Ready to Merge" && harness.runs.length === 4 && orchestrator.snapshot().counts.running === 0,
        "reviewer pass handoff",
      );
    } finally {
      await orchestrator.stop();
    }

    expect(harness.runs.map(({ role, runId }) => ({ role, runId }))).toEqual([
      { role: "worker", runId: "smoke-worker-run-1" },
      { role: "reviewer", runId: "smoke-review-run-1" },
      { role: "worker", runId: "smoke-worker-run-2" },
      { role: "reviewer", runId: "smoke-review-run-2" },
    ]);
    expect(harness.runs[2]?.prompt).toContain("Reviewer gate findings to address");
    expect(harness.runs[2]?.prompt).toContain("Add the manufactured smoke revision.");
    expect(harness.runs[2]?.prompt).not.toContain("RAW_TRANSCRIPT_SECRET");
    expect(harness.runs[2]?.prompt.length).toBeLessThan(12_000);
    expect(currentState).toBe("Ready to Merge");
    expect(writer.transitions.map((transition) => transition.toState)).toEqual([
      "In Progress",
      "In Review",
      "In Progress",
      "In Review",
      "Ready to Merge",
    ]);

    const lifecycle = await lifecycleStore.get(candidate.identifier);
    expect(lifecycle).toMatchObject({
      phase: "passed",
      reviewRound: 1,
      incompleteTurnCount: 0,
      lastCompletionReportId: "completion-report:issue-1:smoke-report-2",
      lastReviewVerdictId: "review-verdict:issue-1:smoke-verdict-pass",
    });
    expect(lifecycle?.completionReports.map((report) => report.idempotencyKey)).toEqual([
      "smoke-report-1",
      "smoke-report-2",
    ]);
    expect(lifecycle?.reviewVerdicts.map((verdict) => verdict.idempotencyKey)).toEqual([
      "smoke-verdict-fail",
      "smoke-verdict-pass",
    ]);
    expect(lifecycle?.summaryPointers.workspacePath).toBeTruthy();

    const runs = await runStore.listRunsForIssue(candidate.identifier);
    expect(runs).toHaveLength(4);
    expect(runs.map((run) => run.runId)).toEqual(
      expect.arrayContaining([
        "smoke-worker-run-1",
        "smoke-review-run-1",
        "smoke-worker-run-2",
        "smoke-review-run-2",
      ]),
    );
    expect(runs.every((run) => run.status === "succeeded")).toBe(true);
    for (const runId of runs.map((run) => run.runId)) {
      await expect(runStore.readTranscript(runId)).resolves.toMatchObject({
        runId,
        events: expect.arrayContaining([expect.objectContaining({ eventType: "completed" })]),
      });
    }
    await expect(runStore.readTranscript("smoke-worker-run-2")).resolves.toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({
          eventType: "lane_memo_updated",
          payload: expect.objectContaining({ memoSizeChars: expect.any(Number) }),
        }),
      ]),
    });
  }, 15_000);

  it("dispatches reviewer runs from configured review states with reviewer evidence", async () => {
    const config = testConfig(root);
    config.tracker.handoffStates = ["In Review"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.reviewLoop.reviewerPromptTemplate =
      "Review {{ issue.identifier }} as {{ role }}: {{ completionReport.summary }}\n{% for item in workspaceEvidence %}{{ item }}\n{% endfor %}{% for item in runDigest %}{{ item }}\n{% endfor %}";
    config.reviewLoop.reviewerPromptExtensions = ["Custom project reviewer extension."];
    const candidate = issue({ state: "In Review", branchName: "symphony/TEST-1" });
    const fetchedReviewStates: string[][] = [];
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates(states) {
        fetchedReviewStates.push(states);
        return states.includes("In Review") ? [candidate] : [];
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const stateDir = path.join(root, "state");
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const runStore = new FileRunTranscriptStore(stateDir);
    const report = completionReportRecord(candidate);
    await lifecycleStore.ensureIssue(candidate, {
      phase: "review",
      lastCompletionReportId: report.id,
      completionReports: [report],
      summaryPointers: {
        branchName: "symphony/TEST-1",
        gitBranchName: "symphony/TEST-1",
        prUrl: "https://github.com/acme/symphony/pull/42",
        prNumber: 42,
        prHeadSha: "abc123",
      },
    });
    await runStore.startRun({
      runId: report.runId,
      sessionId: "worker-session-1",
      agentId: "worker-agent-1",
      role: "worker",
      issueId: candidate.id,
      issueIdentifier: candidate.identifier,
      attempt: null,
      turnNumber: 1,
      prompt: "Worker prompt",
      workspaceKey: candidate.identifier,
      workspacePath: path.join(root, candidate.identifier),
      gitBranchName: "symphony/TEST-1",
      repoPath: root,
      baseRef: "main",
    });
    await runStore.appendEvent({
      runId: report.runId,
      at: "2026-01-01T00:00:02Z",
      source: "harness",
      eventType: "progress",
      message: "Implemented the reviewer dispatch lane.",
    });
    const harness = new FakeHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
    });

    await orchestrator.refreshNow();
    await waitFor(() => harness.runs.length === 1, "reviewer dispatch");
    await orchestrator.stop();

    expect(fetchedReviewStates).toEqual([expect.arrayContaining(["In Review"])]);
    expect(harness.runs).toHaveLength(1);
    expect(harness.runs[0]?.ctx.role).toBe("reviewer");
    expect(harness.runs[0]?.prompt).toContain("Review TEST-1 as reviewer");
    expect(harness.runs[0]?.prompt).toContain("Implemented the requested change.");
    expect(harness.runs[0]?.prompt).toContain("Pull request: https://github.com/acme/symphony/pull/42");
    expect(harness.runs[0]?.prompt).toContain("Implemented the reviewer dispatch lane.");
    expect(harness.runs[0]?.prompt).not.toContain("Custom project reviewer extension.");
    expect(harness.runs[0]?.prompt).not.toContain("General software review matrix:");
    const runs = await runStore.listRunsForIssue(candidate.identifier);
    expect(runs.find((run) => run.runId === "fake-issue-1-1")).toMatchObject({ role: "reviewer" });
    await expect(lifecycleStore.get(candidate.identifier)).resolves.toMatchObject({ reviewRound: 0 });
  });

  it("allows reviewer dispatch for worker-scoped excluded labels", async () => {
    const config = testConfig(root);
    config.tracker.handoffStates = ["In Review"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.reviewLoop.reviewerPromptTemplate = "Review {{ issue.identifier }}.";
    config.agent.requireLabels = ["dogfood-ready"];
    config.agent.workerExcludeLabels = ["review_only"];
    const candidate = issue({ state: "In Review", branchName: "symphony/TEST-1", labels: ["dogfood-ready", "review_only"] });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates(states) {
        return states.includes("In Review") ? [candidate] : [];
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const report = completionReportRecord(candidate);
    await lifecycleStore.ensureIssue(candidate, {
      phase: "review",
      lastCompletionReportId: report.id,
      completionReports: [report],
    });
    const harness = new FakeHarness();
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore: new FileRunTranscriptStore(config.workspace.stateDir),
    });

    await orchestrator.refreshNow();
    await waitFor(() => harness.runs.length === 1, "review_only reviewer dispatch");
    await orchestrator.stop();

    expect(harness.runs[0]?.ctx.role).toBe("reviewer");
  });

  it("skips reviewer dispatch for reviewer-scoped excluded labels", async () => {
    const config = testConfig(root);
    config.tracker.handoffStates = ["In Review"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.reviewLoop.reviewerPromptTemplate = "Review {{ issue.identifier }}.";
    config.agent.requireLabels = ["dogfood-ready"];
    config.agent.reviewerExcludeLabels = ["no-agent-review"];
    const candidate = issue({ state: "In Review", branchName: "symphony/TEST-1", labels: ["dogfood-ready", "no-agent-review"] });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates(states) {
        return states.includes("In Review") ? [candidate] : [];
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const report = completionReportRecord(candidate);
    await lifecycleStore.ensureIssue(candidate, {
      phase: "review",
      lastCompletionReportId: report.id,
      completionReports: [report],
    });
    const harness = new FakeHarness();
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore: new FileRunTranscriptStore(config.workspace.stateDir),
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await orchestrator.stop();

    expect(harness.runs).toHaveLength(0);
  });

  it("instructs default reviewer prompts to leave PR feedback before verdict submission", async () => {
    const config = testConfig(root);
    config.tracker.handoffStates = ["In Review"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.reviewLoop.reviewerPromptExtensions = [
      "Check project-specific billing boundaries.",
      "Keep {{ issue.identifier }} literal and {{ missing.value }} literal.",
    ];
    const candidate = issue({ state: "In Review", branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates(states) {
        return states.includes("In Review") ? [candidate] : [];
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const stateDir = path.join(root, "state");
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const runStore = new FileRunTranscriptStore(stateDir);
    const report = completionReportRecord(candidate);
    await lifecycleStore.ensureIssue(candidate, {
      phase: "review",
      lastCompletionReportId: report.id,
      completionReports: [report],
      summaryPointers: {
        branchName: "symphony/TEST-1",
        gitBranchName: "symphony/TEST-1",
        prUrl: "https://github.com/acme/symphony/pull/42",
        prNumber: 42,
        prHeadSha: "abc123",
      },
    });
    const harness = new FakeHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
    });

    await orchestrator.refreshNow();
    await waitFor(() => harness.runs.length === 1, "reviewer prompt dispatch");
    await orchestrator.stop();

    const prompt = harness.runs[0]?.prompt ?? "";
    expect(prompt).toContain("submit_pull_request_review_feedback");
    expect(prompt).toContain("submit_review_verdict.evidence");
    expect(prompt.indexOf("submit_pull_request_review_feedback")).toBeLessThan(prompt.indexOf("submit_review_verdict"));
    expect(prompt).toContain('event "APPROVE"');
    expect(prompt).toContain('event "REQUEST_CHANGES"');
    expect(prompt).toContain("These supplemental comments do not satisfy pass approval");
    expect(prompt).not.toContain('event "REQUEST_CHANGES", "COMMENT", or "APPROVE"');
    expect(prompt).toContain("PR number, repository, token, or commit identity");
    expect(prompt).toContain("Symphony service-owned review feedback workflow");
    expect(prompt).toContain("Do not run gh pr review");
    expect(prompt).toContain("direct GitHub API/curl writes");
    expect(prompt).toContain("Before any fail verdict, classify every concern as either a gate finding or a discovery finding");
    expect(prompt).toContain("Gate findings must be contract-entitled");
    expect(prompt).toContain("Discovery findings are valuable backlog/decomposition evidence");
    expect(prompt).toContain("General software review matrix:");
    expect(prompt).toContain("Persistence/durability");
    expect(prompt).toContain("Project-specific reviewer extensions:");
    expect(prompt).toContain("Check project-specific billing boundaries.");
    expect(prompt).toContain("Keep {{ issue.identifier }} literal and {{ missing.value }} literal.");
    expect(prompt).not.toContain("Keep TEST-1 literal");
    expect(prompt.indexOf("General software review matrix:")).toBeLessThan(
      prompt.indexOf("Project-specific reviewer extensions:"),
    );
    expect(prompt).not.toContain("Symphony dogfood extension");
    expect(prompt).not.toContain("writeback/outbox");
  });

  it("repairs a missing reviewer verdict by resuming the Hermes source session once", async () => {
    const config = testConfig(root);
    config.handoffRepair.enabled = true;
    config.handoffRepair.phases = ["review"];
    config.tracker.handoffStates = ["In Review"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.reviewLoop.reviewerPromptTemplate = "Review {{ issue.identifier }}.";
    config.writeback.enabled = true;
    const candidate = issue({ state: "In Review", branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates(states) {
        return states.includes("In Review") ? [candidate] : [];
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const stateDir = config.workspace.stateDir;
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const runStore = new FileRunTranscriptStore(stateDir);
    const outboxStore = new FileWritebackOutboxStore(stateDir);
    const report = completionReportRecord(candidate);
    await lifecycleStore.ensureIssue(candidate, {
      phase: "review",
      lastCompletionReportId: report.id,
      completionReports: [report],
    });
    await runStore.startRun({
      runId: report.runId,
      sessionId: "worker-session-1",
      agentId: "worker-agent-1",
      role: "worker",
      issueId: candidate.id,
      issueIdentifier: candidate.identifier,
      attempt: null,
      turnNumber: 1,
      prompt: "Worker prompt",
      workspaceKey: candidate.identifier,
      workspacePath: path.join(root, candidate.identifier),
      gitBranchName: "symphony/TEST-1",
      repoPath: root,
      baseRef: "main",
    });
    const harness = new MissingReviewVerdictThenRepairHarness(lifecycleStore, outboxStore, runStore);
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
    });

    await orchestrator.refreshNow();
    await waitFor(() => harness.runs.length === 2, "review handoff repair dispatch");
    await orchestrator.stop();

    expect(harness.runs.map((run) => [run.runId, run.ctx.handoffRepair?.kind ?? null])).toEqual([
      ["review-source-run-1", null],
      ["review-repair-run-1", "review_verdict"],
    ]);
    expect(harness.runs[1]?.ctx.hermesResume).toMatchObject({
      sourceRunId: "review-source-run-1",
      reason: "handoff_repair",
      profileKey: "review-source-profile",
      sessionKey: "review-source-session-key",
    });
    await expect(lifecycleStore.get(candidate.identifier)).resolves.toMatchObject({
      lastReviewVerdictId: "review-verdict:issue-1:review-repair-verdict",
      reviewVerdicts: [
        {
          runId: "review-repair-run-1",
          verdict: "fail",
        },
      ],
    });
    await expect(runStore.getRun("review-repair-run-1")).resolves.toMatchObject({
      status: "succeeded",
      handoffRepairSourceRunId: "review-source-run-1",
      handoffRepairKind: "review_verdict",
      handoffRepairAttempt: 1,
      hermesResumeSourceRunId: "review-source-run-1",
      hermesResumeReason: "handoff_repair",
    });
    const issueState = await readIssueState(stateDir, candidate.id);
    const repairSnapshot = issueState?.history.find((snapshot) => snapshot.transitionKind === "handoff_repair");
    expect(repairSnapshot).toMatchObject({
      triggerType: "runtime.requested",
      triggerSource: "transition",
      rulesetId: "orchestrator.handoff_repair",
      reason: "missing_required_mcp_handoff",
      role: "reviewer",
      runPhase: "review",
      promptScenario: "handoff_repair.mcp_only",
      handoffRepairKind: "review_verdict",
      handoffRepairSourceRunId: "review-source-run-1",
      handoffRepairAttempt: 1,
      hermesResumeSourceRunId: "review-source-run-1",
      hermesResumeReason: "handoff_repair",
      transitionRequestContext: {
        kind: "handoff_repair",
        parentTransitionKind: "dispatch_reviewer",
        payload: {
          sourceRunId: "review-source-run-1",
          kind: "review_verdict",
          repairAttempt: 1,
          turnNumber: 2,
          role: "reviewer",
          runPhase: "review",
          runKind: "review",
        },
      },
    });
    expect(repairSnapshot).not.toHaveProperty("current");
    expect(repairSnapshot).not.toHaveProperty("transitionRequest");
    expect(repairSnapshot?.actions.map((action) => action.actionType)).toEqual(
      expect.arrayContaining([
        "load_handoff_repair_context",
        "dispatch_handoff_repair",
        "render_handoff_repair_prompt",
        "record_handoff_repair_dispatched_event",
        "prepare_handoff_repair_harness",
        "reload_handoff_repair_harness",
        "run_handoff_repair_agent",
        "reconcile_handoff_repair_result",
      ]),
    );
    expect(repairSnapshot?.actions.some((action) => action.actionType === "start_agent_run")).toBe(false);
    const verdictSnapshot = issueState?.history.find(
      (snapshot) => snapshot.transitionKind === "reconcile_review_verdict_handoff" && snapshot.runId === "review-repair-run-1",
    );
    expect(verdictSnapshot).toMatchObject({
      triggerType: "runtime.requested",
      triggerSource: "transition",
      candidateSource: "handoff_reconciliation",
      rulesetId: "orchestrator.handoff_reconciliation",
      runId: "review-repair-run-1",
      transitionRequestContext: {
        kind: "handoff_reconciliation",
        parentTransitionKind: "handoff_repair",
        payload: {
          runId: "review-repair-run-1",
          handoffKind: "review_verdict",
          role: "reviewer",
          runPhase: "review",
          runKind: "review",
        },
      },
    });
    expect(verdictSnapshot?.actions.map((action) => action.actionType)).toEqual(
      expect.arrayContaining([
        "load_review_verdict_handoff",
        "mark_review_verdict_handoff_accepted",
        "process_review_verdict_handoff_writebacks",
        "request_merge_policy_after_pass_verdict",
      ]),
    );
  });

  it("skips handoff repair when the source run is not resumable", async () => {
    const config = testConfig(root);
    config.handoffRepair.enabled = true;
    config.handoffRepair.phases = ["review"];
    config.tracker.handoffStates = ["In Review"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.reviewLoop.reviewerPromptTemplate = "Review {{ issue.identifier }}.";
    config.writeback.enabled = true;
    const candidate = issue({ state: "In Review", branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates(states) {
        return states.includes("In Review") ? [candidate] : [];
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const stateDir = config.workspace.stateDir;
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const runStore = new FileRunTranscriptStore(stateDir);
    const outboxStore = new FileWritebackOutboxStore(stateDir);
    const report = completionReportRecord(candidate);
    await lifecycleStore.ensureIssue(candidate, {
      phase: "review",
      lastCompletionReportId: report.id,
      completionReports: [report],
    });
    await runStore.startRun({
      runId: report.runId,
      sessionId: "worker-session-1",
      agentId: "worker-agent-1",
      role: "worker",
      issueId: candidate.id,
      issueIdentifier: candidate.identifier,
      attempt: null,
      turnNumber: 1,
      prompt: "Worker prompt",
      workspaceKey: candidate.identifier,
      workspacePath: path.join(root, candidate.identifier),
      gitBranchName: "symphony/TEST-1",
      repoPath: root,
      baseRef: "main",
    });
    const harness = new MissingReviewVerdictThenRepairHarness(lifecycleStore, outboxStore, runStore, {
      writeSourceResumeMetadata: false,
    });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
    });

    await orchestrator.refreshNow();
    await waitFor(() => harness.runs.length === 1, "non-resumable review source run");
    await waitFor(() => orchestrator.snapshot().counts.running === 0, "non-resumable review run exit");
    await orchestrator.stop();

    expect(harness.runs.map((run) => [run.runId, run.ctx.handoffRepair?.kind ?? null])).toEqual([
      ["review-source-run-1", null],
    ]);
    const sourceRun = await runStore.getRun("review-source-run-1");
    expect(sourceRun?.hermesProfileKey ?? null).toBeNull();
    expect(sourceRun?.hermesSessionKey ?? null).toBeNull();
    const issueState = await readIssueState(stateDir, candidate.id);
    expect(issueState?.history.some((snapshot) => snapshot.transitionKind === "handoff_repair")).toBe(false);
  });

  it("skips handoff repair when the configured attempt budget is exhausted", async () => {
    const config = testConfig(root);
    config.handoffRepair.enabled = true;
    config.handoffRepair.maxAttempts = 1;
    config.handoffRepair.phases = ["review"];
    config.tracker.handoffStates = ["In Review"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.reviewLoop.reviewerPromptTemplate = "Review {{ issue.identifier }}.";
    config.writeback.enabled = true;
    const candidate = issue({ state: "In Review", branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates(states) {
        return states.includes("In Review") ? [candidate] : [];
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const stateDir = config.workspace.stateDir;
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const runStore = new FileRunTranscriptStore(stateDir);
    const outboxStore = new FileWritebackOutboxStore(stateDir);
    const report = completionReportRecord(candidate);
    await lifecycleStore.ensureIssue(candidate, {
      phase: "review",
      lastCompletionReportId: report.id,
      completionReports: [report],
    });
    await runStore.startRun({
      runId: report.runId,
      sessionId: "worker-session-1",
      agentId: "worker-agent-1",
      role: "worker",
      issueId: candidate.id,
      issueIdentifier: candidate.identifier,
      attempt: null,
      turnNumber: 1,
      prompt: "Worker prompt",
      workspaceKey: candidate.identifier,
      workspacePath: path.join(root, candidate.identifier),
      gitBranchName: "symphony/TEST-1",
      repoPath: root,
      baseRef: "main",
    });
    await runStore.startRun({
      runId: "prior-review-repair-run-1",
      sessionId: "prior-review-repair-session-1",
      agentId: "prior-review-repair-agent-1",
      role: "reviewer",
      runPhase: "review",
      issueId: candidate.id,
      issueIdentifier: candidate.identifier,
      attempt: null,
      turnNumber: 2,
      prompt: "Prior repair prompt",
      harnessId: "hermes",
      workspaceKey: candidate.identifier,
      workspacePath: path.join(root, candidate.identifier),
      gitBranchName: "symphony/TEST-1",
      repoPath: root,
      baseRef: "main",
      metadata: {
        handoffRepairSourceRunId: "review-source-run-1",
        handoffRepairKind: "review_verdict",
        handoffRepairAttempt: 1,
      },
    });
    const harness = new MissingReviewVerdictThenRepairHarness(lifecycleStore, outboxStore, runStore);
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
    });

    await orchestrator.refreshNow();
    await waitFor(() => harness.runs.length === 1, "review source run with exhausted repair budget");
    await waitFor(() => orchestrator.snapshot().counts.running === 0, "exhausted-budget review run exit");
    await orchestrator.stop();

    expect(harness.runs.map((run) => [run.runId, run.ctx.handoffRepair?.kind ?? null])).toEqual([
      ["review-source-run-1", null],
    ]);
    const issueState = await readIssueState(stateDir, candidate.id);
    expect(issueState?.history.some((snapshot) => snapshot.transitionKind === "handoff_repair")).toBe(false);
  });

  it("records a domain transition error when handoff repair completes without the required handoff", async () => {
    const config = testConfig(root);
    config.handoffRepair.enabled = true;
    config.handoffRepair.phases = ["review"];
    config.tracker.handoffStates = ["In Review"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.reviewLoop.reviewerPromptTemplate = "Review {{ issue.identifier }}.";
    config.writeback.enabled = true;
    const candidate = issue({ state: "In Review", branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates(states) {
        return states.includes("In Review") ? [candidate] : [];
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const stateDir = config.workspace.stateDir;
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const runStore = new FileRunTranscriptStore(stateDir);
    const outboxStore = new FileWritebackOutboxStore(stateDir);
    const report = completionReportRecord(candidate);
    await lifecycleStore.ensureIssue(candidate, {
      phase: "review",
      lastCompletionReportId: report.id,
      completionReports: [report],
    });
    await runStore.startRun({
      runId: report.runId,
      sessionId: "worker-session-1",
      agentId: "worker-agent-1",
      role: "worker",
      issueId: candidate.id,
      issueIdentifier: candidate.identifier,
      attempt: null,
      turnNumber: 1,
      prompt: "Worker prompt",
      workspaceKey: candidate.identifier,
      workspacePath: path.join(root, candidate.identifier),
      gitBranchName: "symphony/TEST-1",
      repoPath: root,
      baseRef: "main",
    });
    const harness = new MissingReviewVerdictThenRepairHarness(lifecycleStore, outboxStore, runStore, {
      submitRepairVerdict: false,
    });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
    });

    await orchestrator.refreshNow();
    await waitFor(() => harness.runs.length === 2, "review handoff repair without handoff dispatch");
    await waitFor(() => orchestrator.snapshot().counts.running === 0, "failed repair run exit");
    await orchestrator.stop();

    const issueState = await readIssueState(stateDir, candidate.id);
    const repairSnapshot = issueState?.history.find((snapshot) => snapshot.transitionKind === "handoff_repair");
    const failedAction = repairSnapshot?.actions.find((action) => action.actionType === "reconcile_handoff_repair_result");
    expect(failedAction).toMatchObject({
      status: "failed",
      message: "MCP handoff repair finished without required review verdict handoff",
    });
    expect(repairSnapshot?.errors).toEqual([
      expect.objectContaining({
        errorType: "domain",
        actionId: failedAction?.actionId,
        code: "conflict",
        message: "MCP handoff repair finished without required review verdict handoff",
      }),
    ]);
    await expect(lifecycleStore.get(candidate.identifier)).resolves.toMatchObject({
      lastReviewVerdictId: null,
      reviewVerdicts: [],
    });
  });

  it("dispatches merge-conflict repair with the original implementation worker Hermes session", async () => {
    const config = testConfig(root);
    config.agent.harness = "hermes";
    config.mergePolicy.mode = "gated";
    config.mergePolicy.conflictsState = "Merge Conflicts";
    config.hermes.workerSessionLifecycle = "reuse_by_issue";
    config.hermes.mergeConflictSessionReuse = "implementation_worker";
    const candidate = issue({ state: "Merge Conflicts", branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates(states) {
        return states.includes("Merge Conflicts") ? [candidate] : [];
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const report = completionReportRecord(candidate);
    await lifecycleStore.ensureIssue(candidate, {
      phase: "merge_conflict_resolution",
      lastCompletionReportId: report.id,
      completionReports: [report],
      mergeConflict: openMergeConflict(candidate),
    });
    await runStore.startRun({
      runId: report.runId,
      sessionId: "worker-session-1",
      agentId: "worker-agent-1",
      role: "worker",
      runPhase: "implementation",
      issueId: candidate.id,
      issueIdentifier: candidate.identifier,
      attempt: null,
      turnNumber: 1,
      prompt: "Worker prompt",
      harnessId: "hermes",
      workspaceKey: candidate.identifier,
      workspacePath: path.join(root, candidate.identifier),
      gitBranchName: "symphony/TEST-1",
      repoPath: root,
      baseRef: "main",
    });
    await runStore.updateRun(report.runId, {
      status: "succeeded",
      completedAt: "2026-01-01T00:00:02.000Z",
      metadata: {
        hermesProfileKey: "implementation-profile",
        hermesProfileDir: path.join(config.hermes.stateDir, "profiles", "implementation-profile"),
        hermesSessionKey: "implementation-session-key",
      },
    });
    const harness = new ContextRecordingHermesHarness();
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
    });

    await orchestrator.refreshNow();
    await waitFor(() => harness.runs.length === 1, "merge conflict repair dispatch");
    await orchestrator.stop();

    expect(harness.runs[0]?.ctx.runPhase).toBe("merge_conflict_resolution");
    expect(harness.runs[0]?.ctx.hermesResume).toMatchObject({
      sourceRunId: report.runId,
      reason: "merge_conflict_original_worker",
      profileKey: "implementation-profile",
      sessionKey: "implementation-session-key",
    });
    expect(harness.runs[0]?.prompt).toContain("submit_merge_conflict_resolution");
  });

  it("does not dispatch conflict-state workers without merge-conflict lifecycle metadata", async () => {
    const config = testConfig(root);
    config.mergePolicy.mode = "gated";
    config.mergePolicy.conflictsState = "Merge Conflicts";
    const candidate = issue({ state: "Merge Conflicts", branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates(states) {
        return states.length === 1 && states.includes("Merge Conflicts") ? [candidate] : [];
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await lifecycleStore.ensureIssue(candidate, {
      phase: "merge_conflict_resolution",
    });
    const harness = new ContextRecordingHermesHarness();
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
    });

    await orchestrator.refreshNow();
    await orchestrator.stop();

    expect(harness.runs).toEqual([]);
  });

  it("does not duplicate conflict dispatch when the same issue is returned by normal worker candidates", async () => {
    const config = testConfig(root);
    config.mergePolicy.mode = "gated";
    config.mergePolicy.conflictsState = "Merge Conflicts";
    const candidate = issue({ state: "Merge Conflicts", branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return states.includes("Merge Conflicts") ? [candidate] : [];
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await lifecycleStore.ensureIssue(candidate, {
      phase: "merge_conflict_resolution",
      mergeConflict: openMergeConflict(candidate),
    });
    const harness = new BlockingRecordingHarness();
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
    });

    await orchestrator.refreshNow();
    await waitFor(() => harness.runs.length === 1, "single merge conflict repair dispatch");
    await orchestrator.stop();

    expect(harness.runs).toHaveLength(1);
    expect(harness.runs[0]?.runPhase).toBe("merge_conflict_resolution");
  });

  it("reopens a blocked merge-conflict repair budget when the operator returns to the conflict state", async () => {
    const config = testConfig(root);
    config.mergePolicy.mode = "gated";
    config.mergePolicy.conflictsState = "Merge Conflicts";
    const candidate = issue({ state: "Merge Conflicts", branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates(states) {
        return states.includes("Merge Conflicts") ? [candidate] : [];
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const conflict: IssueMergeConflictMetadata = {
      ...openMergeConflict(candidate),
      status: "blocked",
      resolutionStatus: "blocked",
      fixTurnCount: 3,
      maxFixTurns: 3,
      lastConflictFixRunId: "conflict-run-3",
      attemptRunIds: ["conflict-run-1", "conflict-run-2", "conflict-run-3"],
      blockedAt: "2026-01-01T00:00:04.000Z",
      blockedReason: "merge conflicts remain unresolved (3/3 conflict-fix attempts)",
    };
    await lifecycleStore.ensureIssue(candidate, {
      phase: "blocked",
      blockedReason: conflict.blockedReason,
      mergeConflict: conflict,
    });
    const harness = new LifecycleSnapshotHarness(lifecycleStore);
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
    });

    await orchestrator.refreshNow();
    await waitFor(() => harness.runs.length === 1, "conflict repair dispatch after operator resume");
    await orchestrator.stop();

    expect(harness.runs[0]?.runPhase).toBe("merge_conflict_resolution");
    expect(harness.snapshots[0]).toMatchObject({
      phase: "merge_conflict_resolution",
      blockedReason: null,
      mergeConflict: {
        status: "open",
        resolutionStatus: "still_conflicted",
        fixTurnCount: 0,
        lastConflictFixRunId: null,
        attemptRunIds: [],
        blockedAt: null,
        blockedReason: null,
      },
    });
  });

  it("processes a live fail verdict submitted by a reviewer harness run", async () => {
    const config = testConfig(root);
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.tracker.handoffStates = ["In Review"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.reviewLoop.reviewerPromptTemplate = "Review {{ issue.identifier }}.";
    const candidate = issue({ state: "In Review", branchName: "symphony/TEST-1" });
    let currentState = "In Review";
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [{ ...candidate, state: currentState }];
      },
      async fetchIssuesByStates(states) {
        return states.includes(currentState) ? [{ ...candidate, state: currentState }] : [];
      },
      async fetchIssueStatesByIds() {
        return [{ ...candidate, state: currentState }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const stateDir = config.workspace.stateDir;
    const outboxStore = new FileWritebackOutboxStore(stateDir);
    const writer = new StateChangingWriter((state) => {
      currentState = state;
    });
    const writeback = new WritebackProcessor(outboxStore, writer, logger, 300_000);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const runStore = new FileRunTranscriptStore(stateDir);
    const report = completionReportRecord(candidate);
    await lifecycleStore.ensureIssue(candidate, {
      phase: "review",
      lastCompletionReportId: report.id,
      completionReports: [report],
      summaryPointers: {
        branchName: "symphony/TEST-1",
        gitBranchName: "symphony/TEST-1",
        prUrl: "https://github.com/acme/symphony/pull/42",
        prNumber: 42,
      },
    });
    await runStore.startRun({
      runId: report.runId,
      sessionId: "worker-session-1",
      agentId: "worker-agent-1",
      role: "worker",
      issueId: candidate.id,
      issueIdentifier: candidate.identifier,
      attempt: null,
      turnNumber: 1,
      prompt: "Worker prompt",
      workspaceKey: candidate.identifier,
      workspacePath: path.join(root, candidate.identifier),
      gitBranchName: "symphony/TEST-1",
      repoPath: root,
      baseRef: "main",
    });
    const harness = new ReviewVerdictSubmittingHarness("fail", lifecycleStore, outboxStore);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
      writeback,
    });

    await orchestrator.refreshNow();
    await waitFor(() => harness.runs.length === 1, "review fail verdict dispatch");
    await orchestrator.stop();

    expect(harness.runs).toEqual([{ role: "reviewer", runId: "review-run-1" }]);
    expect(currentState).toBe("In Progress");
    expect(writer.comments.map((comment) => comment.dedupeKey)).toEqual(["review-run-1:review-verdict-fail"]);
    expect(writer.comments[0]?.body).toContain("Symphony review failed");
    expect(writer.comments[0]?.body).toContain("Add reviewer MCP integration.");
    expect(writer.transitions.map((transition) => transition.toState)).toEqual(["In Progress"]);
    await expect(lifecycleStore.get(candidate.identifier)).resolves.toMatchObject({
      phase: "implementation",
      reviewRound: 1,
      lastReviewVerdictId: "review-verdict:issue-1:review-verdict-fail-1",
    });
    expect(orchestrator.snapshot().counts.retrying).toBe(0);
  });

  it("processes a live pass verdict submitted by a reviewer harness run", async () => {
    const config = testConfig(root);
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.tracker.handoffStates = ["In Review"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.reviewLoop.reviewPassState = "Ready to Merge";
    config.reviewLoop.reviewerPromptTemplate = "Review {{ issue.identifier }}.";
    const candidate = issue({ state: "In Review", branchName: "symphony/TEST-1" });
    let currentState = "In Review";
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [{ ...candidate, state: currentState }];
      },
      async fetchIssuesByStates(states) {
        return states.includes(currentState) ? [{ ...candidate, state: currentState }] : [];
      },
      async fetchIssueStatesByIds() {
        return [{ ...candidate, state: currentState }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const stateDir = config.workspace.stateDir;
    const outboxStore = new FileWritebackOutboxStore(stateDir);
    const writer = new StateChangingWriter((state) => {
      currentState = state;
    });
    const writeback = new WritebackProcessor(outboxStore, writer, logger, 300_000);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const runStore = new FileRunTranscriptStore(stateDir);
    const report = completionReportRecord(candidate);
    await lifecycleStore.ensureIssue(candidate, {
      phase: "review",
      lastCompletionReportId: report.id,
      completionReports: [report],
    });
    const harness = new ReviewVerdictSubmittingHarness("pass", lifecycleStore, outboxStore);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
      writeback,
    });

    await orchestrator.refreshNow();
    await waitFor(() => harness.runs.length === 1, "review pass verdict dispatch");
    await orchestrator.stop();

    expect(harness.runs).toEqual([{ role: "reviewer", runId: "review-run-1" }]);
    expect(currentState).toBe("Ready to Merge");
    expect(writer.comments.map((comment) => comment.dedupeKey)).toEqual(["review-run-1:review-verdict-pass"]);
    expect(writer.comments[0]?.body).toContain("Symphony review passed");
    expect(writer.transitions.map((transition) => transition.toState)).toEqual(["Ready to Merge"]);
    await expect(lifecycleStore.get(candidate.identifier)).resolves.toMatchObject({
      phase: "passed",
      reviewRound: 0,
      lastReviewVerdictId: "review-verdict:issue-1:review-verdict-pass-1",
    });
  });

  it("does not treat review-state issues as worker candidates", async () => {
    const config = testConfig(root);
    config.reviewLoop.reviewStates = ["In Review"];
    const candidate = issue({ state: "In Review" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const harness = new FakeHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await orchestrator.stop();

    expect(harness.runs).toHaveLength(0);
  });

  it("does not dispatch worker runs for blocked states even when they are active states", async () => {
    const config = testConfig(root);
    config.tracker.activeStates = ["Todo", "In Progress", "Blocked"];
    config.reviewLoop.blockedStates = ["Blocked"];
    const candidate = issue({ state: "Blocked" });
    let refreshes = 0;
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        refreshes += 1;
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const harness = new FakeHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await orchestrator.stop();

    expect(harness.runs).toHaveLength(0);
    expect(refreshes).toBe(1);
  });

  it("does not dispatch reviewers for blocked review issues", async () => {
    const config = testConfig(root);
    config.reviewLoop.reviewStates = ["In Review"];
    const candidate = issue({
      state: "In Review",
      blockedBy: [{ id: "blocker", identifier: "TEST-0", state: "Todo" }],
    });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates() {
        return [candidate];
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const lifecycleStore = new FileIssueLifecycleStore(path.join(root, "state"));
    const report = completionReportRecord(candidate);
    await lifecycleStore.ensureIssue(candidate, {
      phase: "review",
      lastCompletionReportId: report.id,
      completionReports: [report],
    });
    const harness = new FakeHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await orchestrator.stop();

    expect(harness.runs).toHaveLength(0);
  });

  it("pauses and resumes issue dispatch", async () => {
    const config = testConfig(root);
    const candidate = issue({ state: "Todo" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const harness = new FakeHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
    });

    orchestrator.pauseIssue(candidate.id);
    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(harness.runs).toHaveLength(0);

    orchestrator.resumeIssue(candidate.id);
    await orchestrator.refreshNow();
    await waitFor(() => harness.runs.length === 1, "resumed issue dispatch");
    await orchestrator.stop();

    expect(harness.runs).toHaveLength(1);
  });

  it("passes emitted run ids to harness stop", async () => {
    const config = testConfig(root);
    const candidate = issue({ state: "Todo" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const harness = new BlockingHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await orchestrator.stop();

    expect(harness.stoppedRunIds).toEqual(["run-123"]);
  });

  it("records state-change running termination through the transition ruleset", async () => {
    const config = testConfig(root);
    const candidate = issue({ state: "Todo" });
    let currentState = "Todo";
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [{ ...candidate, state: currentState }];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([{ ...candidate, state: currentState }], states);
      },
      async fetchIssueStatesByIds() {
        return [{ ...candidate, state: currentState }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const harness = new BlockingHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
    });

    await orchestrator.refreshNow();
    await waitFor(() => orchestrator.snapshot().running[0]?.runId === "run-123", "blocking run start");
    currentState = config.tracker.terminalStates[0] ?? "Done";
    await orchestrator.refreshNow();
    await waitFor(() => orchestrator.snapshot().counts.running === 0, "state-change termination");
    await orchestrator.stop();

    const issueState = await readIssueState(config.workspace.stateDir, candidate.id);
    const termination = issueState?.history.find((snapshot) => snapshot.transitionKind === "terminate_running");
    expect(termination).toMatchObject({
      triggerType: "orchestrator.tick",
      candidateSource: "running_reconciliation",
      rulesetId: "orchestrator.terminate_running",
      reason: "terminal state",
      cleanupWorkspace: true,
      terminationReason: "terminal state",
    });
    expect(termination?.actions.map((action) => action.actionType)).toEqual(
      expect.arrayContaining([
        "mark_running_cancellation_requested",
        "abort_running_agent",
        "record_running_termination",
      ]),
    );
  });

  it("loads and exposes issue lifecycle records during dispatch", async () => {
    const config = testConfig(root);
    config.reviewLoop.reviewStates = ["In Review"];
    const candidate = issue({ state: "Todo" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const harness = new BlockingHarness();
    const lifecycleStore = new FileIssueLifecycleStore(path.join(root, "state"));
    await lifecycleStore.ensureIssue(candidate, { reviewRound: 1, incompleteTurnCount: 2 });
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
    });

    let lifecycle = orchestrator.snapshot().running[0]?.lifecycle;
    try {
      await orchestrator.refreshNow();
      await waitFor(() => {
        lifecycle = orchestrator.snapshot().running[0]?.lifecycle;
        return lifecycle?.summaryPointers.lastRunId === "run-123";
      }, "lifecycle run id to be recorded");
    } finally {
      await orchestrator.stop();
    }

    expect(lifecycle).toMatchObject({
      issueId: candidate.id,
      issueIdentifier: candidate.identifier,
      phase: "implementation",
      reviewRound: 1,
      incompleteTurnCount: 2,
      summaryPointers: {
        workspaceKey: "TEST-1",
        lastRunId: "run-123",
      },
    });
    await expect(lifecycleStore.get(candidate.identifier)).resolves.toMatchObject({
      reviewRound: 1,
      incompleteTurnCount: 2,
    });
  });

  it("discovers and links open pull requests by worktree branch idempotently", async () => {
    const config = testConfig(root);
    const candidate = issue({ state: "Todo", branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const harness = new FakeHarness();
    const stateDir = path.join(root, "state");
    const runStore = new FileRunTranscriptStore(stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const pullRequestClient = new FakePullRequestDiscoveryClient({
      url: "https://github.com/octo-org/symphony/pull/12",
      number: 12,
      headBranch: "symphony/TEST-1",
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:01:00Z",
    });
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      runStore,
      lifecycleStore,
      pullRequestClient,
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await orchestrator.stop();

    const run = await runStore.latestRunForIssue(candidate.identifier);
    const transcript = await runStore.readTranscript(run?.runId ?? "");
    const lifecycle = await lifecycleStore.get(candidate.identifier);

    expect(pullRequestClient.branches).toEqual(["symphony/TEST-1", "symphony/TEST-1"]);
    expect(run).toMatchObject({
      prUrl: "https://github.com/octo-org/symphony/pull/12",
      prNumber: 12,
      lastPushedAt: "2026-01-01T00:01:00Z",
      gitBranchName: "symphony/TEST-1",
    });
    expect(transcript.events.filter((event) => event.eventType === "pr_opened")).toHaveLength(1);
    expect(lifecycle?.summaryPointers).toMatchObject({
      prUrl: "https://github.com/octo-org/symphony/pull/12",
      prNumber: 12,
      lastPushedAt: "2026-01-01T00:01:00Z",
      branchName: "symphony/TEST-1",
      gitBranchName: "symphony/TEST-1",
    });
  });

  it("lazy-resolves worker GitHub discovery credentials when no discovery client override is injected", async () => {
    const config = githubProfileConfig(root, {
      profiles: {
        discovery: { value: "$GITHUB_DISCOVERY_TOKEN", capabilities: ["github.discovery"] },
      },
      roles: {
        worker: {
          "github.discovery": "discovery",
        },
      },
      env: {
        GITHUB_DISCOVERY_TOKEN: "discovery-secret",
      },
    });
    const candidate = issue({ state: "Todo", branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const authorizations: string[] = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      authorizations.push(String((init?.headers as Record<string, string> | undefined)?.authorization));
      const url = new URL(String(input));
      expect(url.pathname).toBe("/repos/acme/symphony/pulls");
      return new Response(
        JSON.stringify([
          {
            html_url: "https://github.com/acme/symphony/pull/42",
            number: 42,
            head: { ref: "symphony/TEST-1", sha: "abc123", repo: { pushed_at: "2026-01-01T00:00:01Z" } },
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const logger = new StructuredLogger(() => undefined);
    const harness = new FakeHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await orchestrator.stop();

    expect(authorizations).toEqual(["Bearer discovery-secret", "Bearer discovery-secret"]);
  });

  it("injects PR review evidence into the next worker prompt after requested changes", async () => {
    const config = testConfig(root);
    config.reviewLoop.continuationHistoryThreshold = 5;
    config.reviewLoop.workerPromptExtensions = ["Check project-specific publication replay."];
    const candidate = issue({ state: "In Progress", branchName: null });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const stateDir = path.join(root, "state");
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    await lifecycleStore.ensureIssue(candidate, {
      phase: "implementation",
      lastCompletionReportId: "completion-report:issue-1:idem-1",
      completionReports: [completionReportRecord(candidate)],
    });
    const pullRequestReviewClient = new FakePullRequestReviewEvidenceClient([
      {
        source: "review",
        githubId: "review-1",
        pullRequestNumber: 42,
        pullRequestUrl: "https://api.github.test/repos/acme/symphony/pulls/42",
        url: "https://github.com/acme/symphony/pull/42#pullrequestreview-1",
        reviewer: "reviewer-a",
        body: "Please address the inline comments.",
        state: "CHANGES_REQUESTED",
        path: null,
        line: null,
        originalLine: null,
        side: null,
        threadId: null,
        inReplyToId: null,
        isResolved: null,
        isOutdated: null,
        createdAt: "2026-01-01T00:00:01Z",
        updatedAt: "2026-01-01T00:00:01Z",
        submittedAt: "2026-01-01T00:00:01Z",
      },
      {
        source: "review_comment",
        githubId: "comment-1",
        pullRequestNumber: 42,
        pullRequestUrl: "https://api.github.test/repos/acme/symphony/pulls/42",
        url: "https://github.com/acme/symphony/pull/42#discussion_r1",
        reviewer: "reviewer-a",
        body: "Add coverage for the dedupe path.",
        state: null,
        path: "src/core/review/PullRequestReviewEvidenceService.ts",
        line: 72,
        originalLine: 70,
        side: "RIGHT",
        threadId: "thread-1",
        inReplyToId: null,
        isResolved: false,
        isOutdated: false,
        createdAt: "2026-01-01T00:00:02Z",
        updatedAt: "2026-01-01T00:00:02Z",
        submittedAt: null,
      },
      {
        source: "issue_comment",
        githubId: "linear-linkback",
        pullRequestNumber: 42,
        pullRequestUrl: null,
        url: "https://github.com/acme/symphony/pull/42#issuecomment-1",
        reviewer: "linear-code[bot]",
        body: linearLinkbackComment(),
        state: null,
        path: null,
        line: null,
        originalLine: null,
        side: null,
        threadId: null,
        inReplyToId: null,
        isResolved: null,
        isOutdated: null,
        createdAt: "2026-01-01T00:00:03Z",
        updatedAt: "2026-01-01T00:00:03Z",
        submittedAt: null,
      },
    ]);
    const harness = new FakeHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      pullRequestReviewClient,
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await orchestrator.stop();

    expect(pullRequestReviewClient.calls).toEqual([42]);
    expect(harness.runs[0]?.prompt).toContain("Work on TEST-1");
    expect(harness.runs[0]?.prompt).toContain("Review-cycle hardening:");
    expect(harness.runs[0]?.prompt).toContain("underlying contract invariant");
    expect(harness.runs[0]?.prompt).toContain("General software change matrix:");
    expect(harness.runs[0]?.prompt).toContain("Project-specific worker extensions:");
    expect(harness.runs[0]?.prompt).toContain("Check project-specific publication replay.");
    expect(harness.runs[0]?.prompt).toContain("PR review feedback to address");
    expect(harness.runs[0]?.prompt).toContain("Compact Symphony handoff packet:");
    expect(harness.runs[0]?.prompt).toContain("Active unresolved PR review evidence:");
    expect(harness.runs[0]?.prompt).toContain("Reviewer verdict: fail / requested changes");
    expect(harness.runs[0]?.prompt).toContain("src/core/review/PullRequestReviewEvidenceService.ts:72");
    expect(harness.runs[0]?.prompt).toContain("thread: thread-1");
    expect(harness.runs[0]?.prompt).toContain("Add coverage for the dedupe path.");
    expect(harness.runs[0]?.prompt).toContain("https://github.com/acme/symphony/pull/42");
    expect(harness.runs[0]?.prompt).not.toContain("linear-linkback");
    expect(harness.runs[0]?.prompt).not.toContain("Linear linkback");
  });

  it("omits linkback-only PR review evidence from worker prompts and persisted lifecycle", async () => {
    const config = testConfig(root);
    const candidate = issue({ state: "In Progress", branchName: null });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const stateDir = path.join(root, "state");
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    await lifecycleStore.ensureIssue(candidate, {
      phase: "implementation",
      lastCompletionReportId: "completion-report:issue-1:idem-1",
      completionReports: [completionReportRecord(candidate)],
      reviewEvidence: {
        pullRequest: {
          url: "https://github.com/acme/symphony/pull/42",
          number: 42,
          headSha: "abc123",
          branch: null,
        },
        lastIngestedCursor: "2026-01-01T00:00:00Z",
        lastWorkerEvidenceCursor: "2026-01-01T00:00:00Z",
        items: [
          {
            id: "issue_comment:42:stale-linear-linkback",
            source: "issue_comment",
            githubId: "stale-linear-linkback",
            pullRequestNumber: 42,
            pullRequestUrl: "https://github.com/acme/symphony/pull/42",
            url: "https://github.com/acme/symphony/pull/42#issuecomment-0",
            reviewer: "linear-code[bot]",
            body: linearLinkbackComment(),
            state: null,
            path: null,
            line: null,
            originalLine: null,
            side: null,
            threadId: null,
            inReplyToId: null,
            isResolved: null,
            isOutdated: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            submittedAt: null,
            cursor: "2026-01-01T00:00:00Z",
          },
        ],
        updatedAt: "2026-01-01T00:00:00Z",
      },
    });
    const pullRequestReviewClient = new FakePullRequestReviewEvidenceClient([
      {
        source: "issue_comment",
        githubId: "linear-linkback",
        pullRequestNumber: 42,
        pullRequestUrl: null,
        url: "https://github.com/acme/symphony/pull/42#issuecomment-1",
        reviewer: "linear-code[bot]",
        body: linearLinkbackComment(),
        state: null,
        path: null,
        line: null,
        originalLine: null,
        side: null,
        threadId: null,
        inReplyToId: null,
        isResolved: null,
        isOutdated: null,
        createdAt: "2026-01-01T00:00:01Z",
        updatedAt: "2026-01-01T00:00:01Z",
        submittedAt: null,
      },
    ]);
    const harness = new FakeHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      pullRequestReviewClient,
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await orchestrator.stop();

    const prompt = harness.runs[0]?.prompt ?? "";
    expect(pullRequestReviewClient.calls).toEqual([42]);
    expect(prompt).toContain("Work on TEST-1");
    expect(prompt).not.toContain("PR review feedback to address before submitting another completion report:");
    expect(prompt).not.toContain("Reviewer gate findings to address before submitting another completion report:");
    expect(prompt).not.toContain("Reviewer verdict: fail / requested changes");
    expect(prompt).not.toContain("linear-linkback");
    expect(prompt).not.toContain("Linear linkback");
    expect(prompt).not.toContain("<!-- linear-review-link -->");
    expect(prompt).not.toContain("Address active unresolved PR review evidence before submitting another completion report.");
    if (prompt.includes("Compact Symphony handoff packet:")) {
      expect(prompt).toContain("Active unresolved PR review evidence:\n- None");
    }
    await expect(lifecycleStore.get(candidate.identifier)).resolves.toMatchObject({
      reviewEvidence: {
        lastIngestedCursor: null,
        items: [],
      },
    });
  });

  it("lazy-resolves reviewer GitHub review-evidence credentials for worker feedback prompts", async () => {
    const config = githubProfileConfig(root, {
      profiles: {
        "review-read": {
          value: "$GITHUB_REVIEW_READ_TOKEN",
          capabilities: ["github.review_evidence_read"],
        },
      },
      roles: {
        reviewer: {
          "github.review_evidence_read": "review-read",
        },
      },
      env: {
        GITHUB_REVIEW_READ_TOKEN: "review-read-secret",
      },
    });
    config.reviewLoop.continuationHistoryThreshold = 5;
    const candidate = issue({ state: "In Progress", branchName: null });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const stateDir = config.workspace.stateDir;
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    await lifecycleStore.ensureIssue(candidate, {
      phase: "implementation",
      lastCompletionReportId: "completion-report:issue-1:idem-1",
      completionReports: [completionReportRecord(candidate)],
    });
    const calls: Array<{ pathname: string; authorization: string }> = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({
        pathname: url.pathname,
        authorization: String((init?.headers as Record<string, string> | undefined)?.authorization),
      });
      if (url.pathname === "/graphql") {
        return jsonResponse({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [],
                },
              },
            },
          },
        });
      }
      if (url.pathname.endsWith("/pulls/42/reviews")) {
        return jsonResponse([
          {
            id: 1001,
            html_url: "https://github.com/acme/symphony/pull/42#pullrequestreview-1001",
            state: "CHANGES_REQUESTED",
            body: "Please address the reviewer-owned evidence path.",
            user: { login: "reviewer-a" },
            submitted_at: "2026-01-01T00:00:01Z",
            updated_at: "2026-01-01T00:00:01Z",
          },
        ]);
      }
      return jsonResponse([]);
    });
    const harness = new FakeHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await orchestrator.stop();

    expect(calls.map((call) => call.authorization)).toEqual([
      "Bearer review-read-secret",
      "Bearer review-read-secret",
      "Bearer review-read-secret",
      "Bearer review-read-secret",
    ]);
    expect(harness.runs[0]?.prompt).toContain("PR review feedback to address");
    expect(harness.runs[0]?.prompt).toContain("Please address the reviewer-owned evidence path.");
  });

  it("injects the latest fail verdict findings and workspace context into the next worker prompt", async () => {
    const config = testConfig(root);
    const candidate = issue({ state: "In Progress", branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const stateDir = path.join(root, "state");
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const report = completionReportRecord(candidate);
    await lifecycleStore.ensureIssue(candidate, {
      phase: "implementation",
      lastCompletionReportId: report.id,
      lastReviewVerdictId: "review-verdict:issue-1:verdict-1",
      completionReports: [report],
      reviewVerdicts: [reviewVerdictRecord(candidate)],
      summaryPointers: {
        workspacePath: "/tmp/old-workspace",
        gitBranchName: "symphony/TEST-1",
        repoPath: "/repo",
        baseRef: "main",
        prUrl: "https://github.com/acme/symphony/pull/42",
        prNumber: 42,
      },
    });
    const harness = new FakeHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await orchestrator.stop();

    expect(harness.runs[0]?.prompt).toContain("Work on TEST-1");
    expect(harness.runs[0]?.prompt).toContain("Reviewer gate findings to address");
    expect(harness.runs[0]?.prompt).toContain("Lifecycle counters:");
    expect(harness.runs[0]?.prompt).toContain("Reviewer failures: 0");
    expect(harness.runs[0]?.prompt).toContain("Latest workspace/git evidence:");
    expect(harness.runs[0]?.prompt).toContain("Branch: symphony/TEST-1");
    expect(harness.runs[0]?.prompt).toContain("Pull request: #42 https://github.com/acme/symphony/pull/42");
    expect(harness.runs[0]?.prompt).toContain("Acceptance criteria gaps:");
    expect(harness.runs[0]?.prompt).toContain("Duplicate verdicts are idempotent");
    expect(harness.runs[0]?.prompt).toContain("Add regression coverage for duplicate verdict submissions.");
    expect(harness.runs[0]?.prompt).toContain("https://github.com/acme/symphony/pull/42#discussion_r1");
  });

  it("injects blocked reviewer verdict context into the resumed worker prompt", async () => {
    const config = testConfig(root);
    const candidate = issue({ state: "In Progress", branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const stateDir = path.join(root, "state");
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const report = completionReportRecord(candidate);
    const blockedVerdict: IssueReviewVerdictRecord = {
      ...reviewVerdictRecord(candidate),
      id: "review-verdict:issue-1:blocked-1",
      idempotencyKey: "blocked-1",
      runId: "review-run-blocked",
      verdict: "blocked",
      acceptanceResults: [
        {
          text: "Required validation evidence is available",
          satisfied: false,
          evidence: "The worker and reviewer command surfaces cannot execute the required validation.",
        },
      ],
      findings: ["Focused validation is unavailable to worker and reviewer command surfaces."],
      gateFindings: [],
      discoveryFindings: [],
      evidence: ["reviewer observed command-policy denial"],
      submittedAt: "2026-01-01T00:00:03Z",
    };
    await lifecycleStore.ensureIssue(candidate, {
      phase: "implementation",
      reviewRound: 1,
      blockedReason: null,
      lastCompletionReportId: report.id,
      lastReviewVerdictId: blockedVerdict.id,
      completionReports: [report],
      reviewVerdicts: [blockedVerdict],
      summaryPointers: {
        workspacePath: "/tmp/old-workspace",
        gitBranchName: "symphony/TEST-1",
        repoPath: "/repo",
        baseRef: "main",
        prUrl: "https://github.com/acme/symphony/pull/42",
        prNumber: 42,
      },
    });
    const harness = new FakeHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await orchestrator.stop();

    const prompt = harness.runs[0]?.prompt ?? "";
    const systemPrompt = harness.runs[0]?.ctx.ephemeralSystemPrompt ?? "";
    expect(prompt).toContain("Reviewer blocked findings to resolve before submitting another completion report:");
    expect(prompt).toContain("Reviewer verdict: blocked / human action required");
    expect(prompt).toContain(
      "Next action: Resume after the blocked review: verify the human/operator blocker is resolved, then complete any remaining implementation or validation and submit a new completion report.",
    );
    expect(prompt).toContain("Latest blocked reviewer verdict:");
    expect(prompt).toContain("Focused validation is unavailable to worker and reviewer command surfaces.");
    expect(prompt).toContain("The worker and reviewer command surfaces cannot execute the required validation.");
    expect(prompt).toContain("reviewer observed command-policy denial");
    expect(systemPrompt).toContain("Resume after the blocked review only after the human/operator blocker has been resolved");
    expect(systemPrompt).toContain("Latest blocked review:");
    expect(systemPrompt).toContain("Focused validation is unavailable to worker and reviewer command surfaces.");
  });

  it("injects dedicated merge-gate repair context instead of reviewer-fail framing", async () => {
    const config = testConfig(root);
    const candidate = issue({ state: "In Progress", branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const stateDir = path.join(root, "state");
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const report = completionReportRecord(candidate);
    await lifecycleStore.ensureIssue(candidate, {
      phase: "implementation",
      reviewRound: 1,
      lastCompletionReportId: report.id,
      lastReviewVerdictId: "merge-gate:issue-1:pr-42:head-sha-1",
      completionReports: [report],
      reviewVerdicts: [
        {
          id: "merge-gate:issue-1:pr-42:head-sha-1",
          idempotencyKey: "merge-gate:issue-1:pr-42:head-sha-1",
          runId: "worker-run-1",
          issueId: candidate.id,
          issueIdentifier: candidate.identifier,
          verdict: "fail",
          acceptanceResults: [{ text: "Required checks pass", satisfied: false, evidence: "test failed" }],
          findings: ["Required check failed: test: failure"],
          gateFindings: [],
          discoveryFindings: [],
          evidence: ["Failing check: test: failure"],
          reviewer: "symphony-merge-gate",
          submittedAt: "2026-01-01T00:00:01.000Z",
          writebackOperationKeys: [],
        },
      ],
      mergeGate: {
        id: "merge-gate:issue-1:pr-42:head-sha-1",
        status: "repair_dispatched",
        headSha: "head-sha-1",
        pullRequest: { url: "https://github.com/acme/symphony/pull/42", number: 42, headSha: "head-sha-1", branch: "symphony/TEST-1" },
        requiredChecks: ["test"],
        checks: [
          {
            name: "test",
            outcome: "failing",
            rawStatus: "failure",
            conclusion: "failure",
            url: "https://ci.test/test",
            firstObservedAt: null,
            actionableSince: null,
          },
        ],
        mergeability: null,
        reviewRound: 1,
        gateRunId: "worker-run-1",
        gateReportId: report.id,
        repairRunId: null,
        repairReportId: null,
        blockerFingerprint: "head-sha-1:test:failure",
        writebackOperationKeys: [],
        supersededByHeadSha: null,
        updatedAt: "2026-01-01T00:00:01.000Z",
      },
    });
    const harness = new FakeHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await orchestrator.stop();

    expect(harness.runs[0]?.prompt).toContain("## Symphony Merge Gate Repair");
    expect(harness.runs[0]?.prompt).toContain("test: failing / failure (https://ci.test/test)");
    expect(harness.runs[0]?.prompt).not.toContain("Reviewer gate findings to address");
  });

  it("shows head-advanced guidance without old-head repair context after the current PR head advances", async () => {
    const config = testConfig(root);
    const candidate = issue({ state: "In Progress", branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const stateDir = path.join(root, "state");
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const report = completionReportRecord(candidate);
    await lifecycleStore.ensureIssue(candidate, {
      phase: "implementation",
      reviewRound: 1,
      lastCompletionReportId: report.id,
      lastReviewVerdictId: "merge-gate:issue-1:pr-42:head-sha-1",
      summaryPointers: {
        prUrl: "https://github.com/acme/symphony/pull/42",
        prNumber: 42,
        prHeadSha: "head-sha-1",
        prBranch: "symphony/TEST-1",
      },
      completionReports: [report],
      reviewVerdicts: [
        {
          id: "merge-gate:issue-1:pr-42:head-sha-1",
          idempotencyKey: "merge-gate:issue-1:pr-42:head-sha-1",
          runId: "worker-run-1",
          issueId: candidate.id,
          issueIdentifier: candidate.identifier,
          verdict: "fail",
          acceptanceResults: [{ text: "Required checks pass", satisfied: false, evidence: "test failed" }],
          findings: ["Required check failed: test: failure"],
          gateFindings: [],
          discoveryFindings: [],
          evidence: ["Failing check: test: failure"],
          reviewer: "symphony-merge-gate",
          submittedAt: "2026-01-01T00:00:01.000Z",
          writebackOperationKeys: [],
        },
        {
          id: "review-verdict:issue-1:current-head-review",
          idempotencyKey: "current-head-review",
          runId: "review-run-2",
          issueId: candidate.id,
          issueIdentifier: candidate.identifier,
          verdict: "fail",
          acceptanceResults: [{ text: "Current head review finding is addressed", satisfied: false, evidence: "Missing regression test." }],
          findings: ["Add regression coverage for the current PR head."],
          gateFindings: [],
          discoveryFindings: [],
          evidence: ["https://github.com/acme/symphony/pull/42#discussion_current"],
          reviewer: "reviewer-1",
          submittedAt: "2026-01-01T00:00:02.000Z",
          writebackOperationKeys: [],
        },
      ],
      mergeGate: {
        id: "merge-gate:issue-1:pr-42:head-sha-1",
        status: "repair_dispatched",
        headSha: "head-sha-1",
        pullRequest: { url: "https://github.com/acme/symphony/pull/42", number: 42, headSha: "head-sha-1", branch: "symphony/TEST-1" },
        requiredChecks: ["test"],
        checks: [
          {
            name: "test",
            outcome: "failing",
            rawStatus: "failure",
            conclusion: "failure",
            url: "https://ci.test/test",
            firstObservedAt: null,
            actionableSince: null,
          },
        ],
        mergeability: null,
        reviewRound: 1,
        gateRunId: "worker-run-1",
        gateReportId: report.id,
        repairRunId: "repair-run-1",
        repairReportId: "completion-report:issue-1:repair-1",
        blockerFingerprint: "head-sha-1:test:failure",
        writebackOperationKeys: [],
        supersededByHeadSha: null,
        updatedAt: "2026-01-01T00:00:01.000Z",
      },
    });
    const harness = new FakeHarness();
    const pullRequestClient = new FakePullRequestDiscoveryClient({
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "head-sha-2",
      lastPushedAt: "2026-01-01T00:02:00Z",
    });
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      pullRequestClient,
    });

    await orchestrator.refreshNow();
    await waitFor(() => harness.runs.length === 1, "head-advanced repair dispatch");
    await orchestrator.stop();

    expect(pullRequestClient.branches[0]).toBe("symphony/TEST-1");
    expect(harness.runs[0]?.prompt).toContain("## Symphony Merge Gate Head Advanced");
    expect(harness.runs[0]?.prompt).toContain("Current PR head SHA: head-sha-2");
    expect(harness.runs[0]?.prompt).toContain("normal review approval");
    expect(harness.runs[0]?.prompt).toContain("Reviewer gate findings to address");
    expect(harness.runs[0]?.prompt).toContain("Add regression coverage for the current PR head.");
    expect(harness.runs[0]?.prompt).not.toContain("## Symphony Merge Gate Repair");
    expect(harness.runs[0]?.prompt).not.toContain("test: failing / failure (https://ci.test/test)");
    expect(harness.runs[0]?.prompt).not.toContain("Repair the Symphony merge-gate checks");
    expect(harness.runs[0]?.prompt).not.toContain("completion-report:issue-1:repair-1");
  });

  it("recovers a satisfied head-superseded rebind before dispatching another worker", async () => {
    const config = testConfig(root);
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.reviewLoop.reviewPassState = "Ready to Merge";
    const candidate = issue({ state: "In Progress", branchName: "symphony/TEST-1" });
    let currentState = "In Progress";
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [{ ...candidate, state: currentState }];
      },
      async fetchIssuesByStates(states) {
        return states.includes(currentState) ? [{ ...candidate, state: currentState }] : [];
      },
      async fetchIssueStatesByIds() {
        return [{ ...candidate, state: currentState }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const stateDir = config.workspace.stateDir;
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const outboxStore = new FileWritebackOutboxStore(stateDir);
    const writer = new StateChangingWriter((state) => {
      currentState = state;
    });
    const writeback = new WritebackProcessor(outboxStore, writer, logger, 300_000);
    const report = {
      ...completionReportRecord(candidate),
      id: "completion-report:issue-1:fresh-head",
      runId: "worker-run-2",
      pullRequest: {
        url: "https://github.com/acme/symphony/pull/42",
        number: 42,
        headSha: "head-sha-2",
        branch: "symphony/TEST-1",
      },
    };
    const approval: IssueReviewVerdictRecord = {
      ...reviewVerdictRecord(candidate),
      id: "review-verdict:issue-1:fresh-head-pass",
      idempotencyKey: "fresh-head-pass",
      runId: "review-run-2",
      verdict: "pass",
      acceptanceResults: [{ text: "Fresh head approved", satisfied: true, evidence: "reviewed" }],
      findings: [],
      evidence: ["https://github.com/acme/symphony/pull/42#pullrequestreview-2"],
    };
    await lifecycleStore.ensureIssue(candidate, {
      phase: "implementation",
      lastCompletionReportId: report.id,
      lastReviewVerdictId: approval.id,
      summaryPointers: {
        prUrl: "https://github.com/acme/symphony/pull/42",
        prNumber: 42,
        prHeadSha: "head-sha-2",
        prBranch: "symphony/TEST-1",
        ciStatus: "head_superseded",
      },
      completionReports: [report],
      reviewVerdicts: [approval],
      reviewFeedback: [
        {
          ...approvalFeedbackRecord(candidate, "review-run-2"),
          pullRequest: {
            url: "https://github.com/acme/symphony/pull/42",
            number: 42,
            headSha: "head-sha-2",
            branch: "symphony/TEST-1",
          },
        },
      ],
      mergeGate: {
        id: "merge-gate:issue-1:pr-42:head-sha-1",
        status: "superseded",
        headSha: "head-sha-1",
        pullRequest: { url: "https://github.com/acme/symphony/pull/42", number: 42, headSha: "head-sha-1", branch: "symphony/TEST-1" },
        requiredChecks: ["test"],
        checks: [
          {
            name: "test",
            outcome: "failing",
            rawStatus: "failure",
            conclusion: "failure",
            url: "https://ci.test/test",
            firstObservedAt: null,
            actionableSince: null,
          },
        ],
        mergeability: null,
        reviewRound: 4,
        gateRunId: "worker-run-1",
        gateReportId: "completion-report:issue-1:old-head",
        repairRunId: "repair-run-1",
        repairReportId: "completion-report:issue-1:repair-1",
        blockerFingerprint: "head-sha-1:test:failure",
        writebackOperationKeys: [],
        supersededByHeadSha: "head-sha-2",
        updatedAt: "2026-01-01T00:00:03.000Z",
      },
    });
    const harness = new FakeHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      writeback,
    });

    await orchestrator.refreshNow();
    await waitFor(() => writer.transitions.length === 1, "head-superseded recovery transition");
    await orchestrator.stop();

    expect(harness.runs).toEqual([]);
    expect(currentState).toBe("Ready to Merge");
    expect(writer.transitions).toEqual([
      {
        issueId: "issue-1",
        fromStates: ["In Progress"],
        toState: "Ready to Merge",
        reason: "Symphony merge gate head supersession rebound satisfied",
      },
    ]);
    expect(writer.comments[0]?.dedupeKey).toContain("head-superseded-recovered:head-sha-2");
    await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
      phase: "passed",
      blockedReason: null,
      lastReviewVerdictId: approval.id,
      summaryPointers: { ciStatus: null, prHeadSha: "head-sha-2" },
      mergeGate: { status: "superseded", supersededByHeadSha: "head-sha-2" },
    });
  });

  it("cancels an active issue without retrying it", async () => {
    const config = testConfig(root);
    const candidate = issue({ state: "Todo" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const harness = new BlockingHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
    });

    await orchestrator.refreshNow();
    await waitFor(() => orchestrator.snapshot().running[0]?.runId === "run-123", "active issue dispatch before cancellation");
    await orchestrator.cancelIssue(candidate.id);
    await waitFor(() => harness.stoppedRunIds.length === 1, "active issue cancellation");
    await orchestrator.stop();

    expect(harness.stoppedRunIds).toEqual(["run-123"]);
    expect(orchestrator.snapshot().counts.retrying).toBe(0);
  });

  it("exposes live liveness and cancellation state before a cancelled run exits", async () => {
    const config = testConfig(root);
    const candidate = issue({ state: "Todo" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const harness = new HeldCancellationHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
    });

    await orchestrator.refreshNow();
    await waitFor(() => orchestrator.snapshot().running[0]?.runId === "run-123", "run to start");
    const active = orchestrator.snapshot().running[0];
    expect(active).toMatchObject({
      issueIdentifier: "TEST-1",
      runId: "run-123",
      liveness: {
        status: "active",
        activeRunId: "run-123",
        stallTimeoutMs: 300_000,
      },
      cancellation: {
        requested: false,
        requestedAt: null,
        source: null,
        reason: null,
        abortSignalled: false,
        harnessStopRequestedAt: null,
        suppressRetryOnExit: false,
      },
    });

    await orchestrator.cancelIssue(candidate.id);
    const cancelling = orchestrator.snapshot().running[0];
    expect(cancelling).toMatchObject({
      issueIdentifier: "TEST-1",
      liveness: {
        status: "cancelling",
        activeRunId: "run-123",
      },
      cancellation: {
        requested: true,
        source: "operator",
        reason: "operator request",
        abortSignalled: true,
        suppressRetryOnExit: true,
      },
    });
    expect(cancelling?.cancellation.requestedAt).toEqual(expect.any(String));
    expect(cancelling?.cancellation.harnessStopRequestedAt).toEqual(expect.any(String));

    await orchestrator.cancelIssue(candidate.id);
    const repeatedCancel = orchestrator.snapshot().running[0];
    expect(repeatedCancel?.cancellation.requestedAt).toBe(cancelling?.cancellation.requestedAt);
    expect(repeatedCancel?.cancellation.reason).toBe("operator request");

    harness.release();
    await waitFor(() => orchestrator.snapshot().running.length === 0, "cancelled run to exit");
    await orchestrator.stop();
  });

  it("records harness stop failures without failing cancellation", async () => {
    const config = testConfig(root);
    const candidate = issue({ state: "Todo" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const harness = new FailingStopHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      runStore,
    });

    await orchestrator.refreshNow();
    await waitFor(() => orchestrator.snapshot().running[0]?.runId === "run-failing-stop", "run to start");
    await expect(orchestrator.cancelIssue(candidate.id)).resolves.toBeUndefined();

    const cancelling = orchestrator.snapshot().running[0];
    expect(cancelling).toMatchObject({
      liveness: { status: "cancelling", activeRunId: "run-failing-stop" },
      cancellation: {
        requested: true,
        source: "operator",
        harnessStopFailedReason: "stop failed",
        cancelFailed: {
          tracked: true,
          active: true,
          phase: "failed",
          source: "harness_stop",
        },
      },
    });
    expect(cancelling?.cancellation.harnessStopFailedAt).toEqual(expect.any(String));

    harness.release();
    await waitFor(() => orchestrator.snapshot().running.length === 0, "cancelled run to exit");
    await expect(runStore.getRun("run-failing-stop")).resolves.toMatchObject({
      status: "cancelled",
      cancelFailed: false,
      cancellationOutcome: "cancelled",
      harnessStopFailedReason: "stop failed",
      activitySnapshot: {
        lastHarnessActivityAt: expect.any(String),
      },
    });
    await orchestrator.stop();
  });

  it("keeps quiet SDK-running work active instead of stall-cancelling it", async () => {
    const config = testConfig(root);
    (config.raw as { codex?: { stall_timeout_ms?: number } }).codex = { stall_timeout_ms: 1 };
    const candidate = issue({ state: "Todo" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const harness = new StalledAbortHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      runStore,
    });

    await orchestrator.refreshNow();
    await waitFor(() => orchestrator.snapshot().running[0]?.runId === "run-stalled", "stalled run to start");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await orchestrator.refreshNow();
    const quiet = orchestrator.snapshot().running[0];
    expect(quiet).toMatchObject({
      liveness: {
        status: "active",
        idleAlert: {
          active: true,
          reason: "observe_only",
        },
      },
      cancellation: {
        requested: false,
        source: null,
        abortSignalled: false,
      },
    });

    harness.release();
    await waitFor(() => orchestrator.snapshot().running.length === 0, "stalled run to exit");

    await expect(runStore.getRun("run-stalled")).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(orchestrator.snapshot().counts.retrying).toBe(0);
    await orchestrator.stop();
  });

  it("does not record harness stop metadata before a run id is known for operator cancellation", async () => {
    const config = testConfig(root);
    const candidate = issue({ state: "Todo" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const harness = new PreSessionCancellationHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
    });

    await orchestrator.refreshNow();
    await harness.started;
    await orchestrator.cancelIssue(candidate.id);

    const cancelling = orchestrator.snapshot().running[0];
    expect(cancelling).toMatchObject({
      runId: null,
      liveness: { status: "cancelling", activeRunId: null },
      cancellation: {
        requested: true,
        source: "operator",
        reason: "operator request",
        abortSignalled: true,
        harnessStopRequestedAt: null,
        suppressRetryOnExit: true,
      },
    });
    expect(harness.stoppedRunIds).toEqual([]);

    harness.release();
    await waitFor(() => orchestrator.snapshot().running.length === 0, "pre-session cancelled run to exit");
    await orchestrator.stop();
  });

  it("does not call harness stop with an issue id during pre-session orchestrator shutdown", async () => {
    const config = testConfig(root);
    const candidate = issue({ state: "Todo" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const harness = new PreSessionCancellationHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
    });

    await orchestrator.refreshNow();
    await harness.started;
    const stopPromise = orchestrator.stop();
    await waitFor(
      () => orchestrator.snapshot().running[0]?.cancellation.source === "service_stop",
      "service stop cancellation to be recorded",
    );

    const stopping = orchestrator.snapshot().running[0];
    expect(stopping).toMatchObject({
      runId: null,
      cancellation: {
        requested: true,
        source: "service_stop",
        reason: "orchestrator stop",
        abortSignalled: true,
        harnessStopRequestedAt: null,
      },
    });
    expect(harness.stoppedRunIds).toEqual([]);

    harness.release();
    await stopPromise;
  });

  it("treats service stop aborts as terminal cancelled without retrying", async () => {
    const config = testConfig(root);
    const candidate = issue({ state: "Todo" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const harness = new ServiceStopAbortHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      runStore,
    });

    await orchestrator.refreshNow();
    await waitFor(() => orchestrator.snapshot().running[0]?.runId === "run-service-stop", "service-stop run to start");
    const stopPromise = orchestrator.stop();
    await waitFor(
      () => orchestrator.snapshot().running[0]?.cancellation.source === "service_stop",
      "service stop cancellation to be recorded",
    );
    expect(orchestrator.snapshot().running[0]).toMatchObject({
      liveness: { status: "cancelling", activeRunId: "run-service-stop" },
      cancellation: {
        requested: true,
        source: "service_stop",
        reason: "orchestrator stop",
        abortSignalled: true,
        suppressRetryOnExit: true,
      },
    });
    expect(harness.stoppedRunIds).toEqual(["run-service-stop"]);

    harness.release();
    await stopPromise;

    await expect(runStore.getRun("run-service-stop")).resolves.toMatchObject({
      status: "cancelled",
      error: "service stop abort",
    });
    expect(orchestrator.snapshot().counts.retrying).toBe(0);
  });

  it("blocks continuation turns for non-resumable harnesses", async () => {
    const config = testConfig(root);
    config.agent.maxTurns = 2;
    const candidate = issue({ state: "Todo" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const harness = new NonResumableHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
    });

    await orchestrator.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await orchestrator.stop();

    expect(harness.prompts).toHaveLength(1);
    expect(harness.prompts[0]).toContain("Work on TEST-1");
  });

  it("accounts tokens per fresh active run across continuation turns", async () => {
    const config = testConfig(root);
    config.agent.maxTurns = 2;
    const candidate = issue({ state: "Todo" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const harness = new TokenSequenceHarness([
      { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    ]);
    const runStore = new FileRunTranscriptStore(root);
    const lifecycleStore = new FileIssueLifecycleStore(root);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      runStore,
      lifecycleStore,
    });

    await orchestrator.refreshNow();
    await waitFor(() => harness.runs.length === 2);
    await orchestrator.stop();

    const runs = await runStore.listRunsForIssue(candidate.id);
    expect(runs.map((run) => ({ runId: run.runId, tokens: run.tokens }))).toEqual([
      { runId: "token-run-1", tokens: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } },
      { runId: "token-run-2", tokens: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
    ]);
    expect(orchestrator.snapshot().totals).toMatchObject({
      inputTokens: 110,
      outputTokens: 55,
      totalTokens: 165,
    });
  });

  it("persists tool, diagnostic, token, and rate-limit harness events while applying side effects", async () => {
    const config = testConfig(root);
    config.agent.maxTurns = 1;
    const candidate = issue({ state: "Todo" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const harness = new DiagnosticActivityHarness();
    const runStore = new FileRunTranscriptStore(root);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      runStore,
    });

    await orchestrator.refreshNow();
    await waitForAsync(async () => (await runStore.getRun("diagnostic-run-1"))?.status === "succeeded", "diagnostic activity run");
    await orchestrator.stop();

    const run = await runStore.getRun("diagnostic-run-1");
    const transcript = await runStore.readTranscript("diagnostic-run-1");
    const serializedTranscript = JSON.stringify(transcript.events);

    expect(run).toMatchObject({
      tokens: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
      transcriptEventCount: 6,
    });
    expect(orchestrator.snapshot().totals).toMatchObject({ inputTokens: 12, outputTokens: 8, totalTokens: 20 });
    expect(orchestrator.snapshot().rateLimits).toEqual({
      requests: { remaining: 2, resetAt: "2026-01-01T00:30:00.000Z" },
      authorization: "[redacted]",
    });
    expect(transcript.events.map((event) => event.eventType)).toEqual([
      "session_started",
      "progress",
      "run_diagnostic",
      "tokens",
      "rate_limits",
      "completed",
    ]);
    expect(transcript.events[1]).toMatchObject({
      message: "terminal tool completed",
      payload: { kind: "tool", activitySource: "tool", progressKind: "tool" },
    });
    expect(transcript.events[2]).toMatchObject({
      eventType: "run_diagnostic",
      message: "Hermes gateway diagnostic token=[redacted]",
      payload: { kind: "diagnostic", code: "hermes_gateway_protocol_error" },
    });
    expect(transcript.events[3]).toMatchObject({
      eventType: "tokens",
      payload: { kind: "usage", tokens: { inputTokens: 12, outputTokens: 8, totalTokens: 20 } },
    });
    expect(transcript.events[4]).toMatchObject({
      eventType: "rate_limits",
      payload: {
        kind: "rate_limits",
        rateLimits: { requests: { remaining: 2, resetAt: "2026-01-01T00:30:00.000Z" }, authorization: "[redacted]" },
      },
    });
    expect(serializedTranscript).not.toContain("SECRET_DIAGNOSTIC_TOKEN");
    expect(serializedTranscript).not.toContain("SECRET_RATE_LIMIT_TOKEN");
    expect(serializedTranscript).not.toContain("rawPayload");
  });

  it("includes compact handoff for prior-run-only follow-up prompts", async () => {
    const config = testConfig(root);
    const candidate = issue({ state: "Todo" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const stateDir = path.join(root, "state");
    const runStore = new FileRunTranscriptStore(stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    await lifecycleStore.ensureIssue(candidate);
    await runStore.startRun({
      runId: "prior-run-only",
      role: "worker",
      issueId: candidate.id,
      issueIdentifier: candidate.identifier,
      attempt: null,
      turnNumber: 1,
      prompt: "SECRET_FULL_PROMPT_BODY",
      workspaceKey: candidate.identifier,
      workspacePath: path.join(root, candidate.identifier),
    });
    await runStore.appendEvent({
      runId: "prior-run-only",
      at: "2026-01-01T00:00:00.000Z",
      source: "harness",
      eventType: "progress",
      message: "Prior run exists without a lifecycle handoff.",
    });
    const harness = new FakeHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      runStore,
      lifecycleStore,
    });

    await orchestrator.refreshNow();
    await waitFor(() => harness.runs.length === 1);
    await orchestrator.stop();

    const prompt = harness.runs[0]?.prompt ?? "";
    expect(prompt).toContain("Compact Symphony handoff packet:");
    expect(prompt).toContain("/api/v1/runs/prior-run-only/transcript");
    expect(prompt).not.toContain("SECRET_FULL_PROMPT_BODY");
  });

  it("uses pointers instead of raw run history in continuation prompts below the event threshold", async () => {
    const config = testConfig(root);
    config.agent.maxTurns = 2;
    config.reviewLoop.continuationHistoryThreshold = 5;
    config.reviewLoop.workerPromptExtensions = ["Check continuation-specific project invariants."];
    const candidate = issue({ state: "Todo" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const stateDir = path.join(root, "state");
    const runStore = new FileRunTranscriptStore(stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const harness = new FakeHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      runStore,
      lifecycleStore,
    });

    await orchestrator.refreshNow();
    await waitFor(() => harness.runs.length === 2, "continuation dispatch below event threshold", 5_000);
    await orchestrator.stop();

    expect(harness.runs).toHaveLength(2);
    expect(harness.runs[1]?.prompt).toContain("Structured continuation brief:");
    expect(harness.runs[1]?.prompt).toContain("Review-cycle hardening:");
    expect(harness.runs[1]?.prompt).toContain("underlying contract invariant");
    expect(harness.runs[1]?.prompt).toContain("Check continuation-specific project invariants.");
    expect(harness.runs[1]?.prompt).toContain("Mode: summary");
    expect(harness.runs[1]?.prompt).toContain("Transcript/status pointers:");
    expect(harness.runs[1]?.prompt).toContain("/api/v1/runs/fake-issue-1-1/transcript");
    expect(harness.runs[1]?.prompt).not.toContain("completed: fake completed");
    expect(harness.runs[1]?.prompt).not.toContain("Continue working on the issue. Check current issue state");
  });

  it("uses stored summaries and API pointers in continuation prompts above the event threshold", async () => {
    const config = testConfig(root);
    config.agent.maxTurns = 2;
    config.reviewLoop.continuationHistoryThreshold = 1;
    config.reviewLoop.transcriptHistoryLimit = 1;
    const candidate = issue({ state: "Todo" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates(states) {
        return issuesInStates([candidate], states);
      },
      async fetchIssueStatesByIds() {
        return [candidate];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const stateDir = path.join(root, "state");
    const runStore = new FileRunTranscriptStore(stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    await runStore.startRun({
      runId: "prior-run-1",
      sessionId: "prior-session-1",
      agentId: "prior-agent-1",
      role: "worker",
      issueId: candidate.id,
      issueIdentifier: candidate.identifier,
      attempt: null,
      turnNumber: 1,
      prompt: "Prior worker prompt",
      workspaceKey: candidate.identifier,
      workspacePath: path.join(root, candidate.identifier),
      gitBranchName: "symphony/TEST-1",
      repoPath: root,
      baseRef: "main",
    });
    await runStore.appendEvent({
      runId: "prior-run-1",
      at: "2026-01-01T00:00:01Z",
      source: "harness",
      eventType: "progress",
      message: "Prior run gathered context.",
    });
    await runStore.appendEvent({
      runId: "prior-run-1",
      at: "2026-01-01T00:00:02Z",
      source: "harness",
      eventType: "completed",
      message: "Prior run stopped before handoff.",
    });
    const harness = new FakeHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      runStore,
      lifecycleStore,
    });
    const createdSummary = await orchestrator.createContinuationSummary(candidate);
    const storedLifecycle = await lifecycleStore.get(candidate.identifier);

    await orchestrator.refreshNow();
    await waitFor(() => harness.runs.length === 2, "continuation dispatch above event threshold", 5_000);
    await orchestrator.stop();

    expect(createdSummary.summaryReference.id).toContain("continuation-summary:issue-1:");
    expect(createdSummary.summaryReference.runIds).toEqual(["prior-run-1"]);
    expect(createdSummary.summaryReference.transcriptEventCount).toBe(2);
    expect(createdSummary.summaryReference.transcriptPointers).toEqual(["/api/v1/runs/prior-run-1/transcript"]);
    expect(createdSummary.summaryReference.statusApiPointers).toEqual([
      "/api/v1/issues/TEST-1",
      "/api/v1/issues/TEST-1/runs",
      "/api/v1/runs/prior-run-1",
    ]);
    expect(storedLifecycle?.summaryReferences).toEqual([createdSummary.summaryReference]);
    expect(harness.runs).toHaveLength(2);
    expect(harness.runs[1]?.prompt).toContain("Mode: summary");
    expect(harness.runs[1]?.prompt).toContain(`Reference: ${createdSummary.summaryReference.id}`);
    expect(harness.runs[1]?.prompt).toContain("Continuation history summarization is not automated yet.");
    expect(harness.runs[1]?.prompt).toContain("/api/v1/runs/prior-run-1/transcript");
    expect(harness.runs[1]?.prompt).toContain("/api/v1/issues/TEST-1");
    expect(harness.runs[1]?.prompt).toContain("/api/v1/runs/prior-run-1");
    expect(harness.runs[1]?.prompt).not.toContain("Full relevant history:");
  });
});

function completionReportRecord(candidate = issue()): IssueCompletionReportRecord {
  return {
    id: `completion-report:${candidate.id}:idem-1`,
    idempotencyKey: "idem-1",
    runId: "worker-run-1",
    issueId: candidate.id,
    issueIdentifier: candidate.identifier,
    summary: "Implemented the requested change.",
    validationEvidence: ["npm test -- orchestrator"],
    acceptanceChecklist: [
      {
        text: "Reviewer dispatch is covered.",
        satisfied: true,
        evidence: "orchestrator test",
      },
    ],
    changedFiles: ["src/core/orchestrator/Orchestrator.ts"],
    branchName: candidate.branchName,
    pullRequest: {
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headSha: "abc123",
      branch: candidate.branchName,
    },
    risks: [],
    acceptedAt: "2026-01-01T00:00:01Z",
    writebackOperationKeys: [],
  };
}

function openMergeConflict(candidate = issue()): IssueMergeConflictMetadata {
  return {
    id: `merge-conflict:${candidate.id}:42`,
    status: "open",
    resolutionStatus: "still_conflicted",
    pullRequest: {
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headSha: "conflict-head",
      branch: candidate.branchName,
    },
    approvedHeadSha: "approved-head",
    currentHeadSha: "conflict-head",
    resolvedHeadSha: null,
    baseBranch: "main",
    baseHeadSha: "base-head",
    sourceState: "Ready to Merge",
    conflictsState: "Merge Conflicts",
    reason: "merge conflicts",
    mergeableState: "dirty",
    servicePreparation: null,
    detectedAt: "2026-01-01T00:00:03.000Z",
    updatedAt: "2026-01-01T00:00:03.000Z",
    fixTurnCount: 0,
    maxFixTurns: 3,
    lastConflictFixRunId: null,
    lastConflictResolutionReportId: null,
    attemptRunIds: [],
    writebackOperationKeys: [],
    blockedAt: null,
    blockedReason: null,
  };
}

function blockedMergeGate(candidate = issue()): IssueMergeGateState {
  return {
    id: "merge-gate:issue-1:pr-42:abc123",
    status: "blocked",
    headSha: "abc123",
    pullRequest: {
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headSha: "abc123",
      branch: candidate.branchName,
    },
    requiredChecks: ["test"],
    checks: [
      {
        name: "test",
        outcome: "failing",
        rawStatus: "failure",
        conclusion: "failure",
        url: "https://ci.test/test",
        firstObservedAt: "2026-01-01T00:00:00.000Z",
        actionableSince: "2026-01-01T00:00:01.000Z",
      },
    ],
    mergeability: null,
    reviewRound: 4,
    gateRunId: "worker-run-1",
    gateReportId: "completion-report:issue-1:idem-1",
    repairRunId: null,
    repairReportId: null,
    blockerFingerprint: "abc123:test:failure",
    writebackOperationKeys: ["transition:issue-1:merge-gate:blocked"],
    supersededByHeadSha: null,
    updatedAt: "2026-01-01T00:00:03.000Z",
  };
}

async function appendApprovalFeedback(
  lifecycleStore: FileIssueLifecycleStore,
  candidate: Issue,
  runId: string,
): Promise<void> {
  const lifecycle = (await lifecycleStore.get(candidate.id)) ?? (await lifecycleStore.get(candidate.identifier));
  if (!lifecycle) throw new Error(`Missing lifecycle for ${candidate.identifier}`);
  await lifecycleStore.updateIssue(candidate, {
    reviewFeedback: [...lifecycle.reviewFeedback, approvalFeedbackRecord(candidate, runId)],
  });
}

function approvalFeedbackRecord(candidate: Issue, runId: string): IssueReviewFeedbackRecord {
  return {
    id: `review-feedback:${candidate.id}:${runId}:approve-1`,
    idempotencyKey: "approve-1",
    requestHash: "request-hash",
    runId,
    issueId: candidate.id,
    issueIdentifier: candidate.identifier,
    kind: "review",
    event: "APPROVE",
    body: "Looks good.",
    pullRequest: {
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headSha: "abc123",
      branch: candidate.branchName,
    },
    reviewer: "reviewer-agent",
    reviewUrl: "https://github.com/acme/symphony/pull/42#pullrequestreview-approve",
    commentUrls: [],
    submittedAt: "2026-01-01T00:00:02Z",
  };
}

function reviewVerdictRecord(candidate = issue()): IssueReviewVerdictRecord {
  return {
    id: `review-verdict:${candidate.id}:verdict-1`,
    idempotencyKey: "verdict-1",
    runId: "review-run-1",
    issueId: candidate.id,
    issueIdentifier: candidate.identifier,
    verdict: "fail",
    acceptanceResults: [
      {
        text: "Duplicate verdicts are idempotent",
        satisfied: false,
        evidence: "Reviewer could not find a regression test.",
      },
    ],
    findings: ["Add regression coverage for duplicate verdict submissions."],
    gateFindings: [],
    discoveryFindings: [],
    evidence: ["https://github.com/acme/symphony/pull/42#discussion_r1"],
    reviewer: "reviewer-a",
    submittedAt: "2026-01-01T00:00:02Z",
    writebackOperationKeys: [],
  };
}

function linearLinkbackComment(): string {
  return [
    "<!-- linear-linkback -->",
    "<details>",
    "<summary>Linear linkback</summary>",
    "</details>",
    "<!-- linear-review-link -->",
  ].join("\n");
}

async function startApprovalRun(
  runStore: FileRunTranscriptStore,
  candidate: Issue,
  runId: string,
  root: string,
): Promise<void> {
  await runStore.startRun({
    runId,
    sessionId: `${runId}-session`,
    agentId: `${runId}-agent`,
    role: "worker",
    issueId: candidate.id,
    issueIdentifier: candidate.identifier,
    attempt: null,
    turnNumber: 1,
    prompt: "Worker submitted a completion report.",
    workspaceKey: candidate.identifier,
    workspacePath: path.join(root, "workspace"),
    gitBranchName: candidate.branchName ?? "symphony/TEST-1",
    repoPath: root,
    baseRef: "main",
  });
}

function pendingApprovalLifecyclePatch(
  candidate: Issue,
  root: string,
  runId: string,
  blockedReason = PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON,
): IssueLifecyclePatch {
  return {
    phase: "blocked",
    blockedReason,
    lastCompletionReportId: `completion-report:${candidate.id}:idem-1`,
    completionReports: [
      {
        ...completionReportRecord(candidate),
        runId,
        branchName: candidate.branchName,
        pullRequest: null,
      },
    ],
    summaryPointers: {
      workspaceKey: candidate.identifier,
      workspacePath: path.join(root, "workspace"),
      branchName: candidate.branchName,
      gitBranchName: candidate.branchName,
      repoPath: root,
      baseRef: "main",
      lastRunId: runId,
    },
  };
}

function approvalRecordFor(
  status: OperatorApprovalRecord["status"],
  candidate: Issue,
  runId: string,
  root: string,
  staleReason: string | null = null,
): OperatorApprovalRecord {
  return {
    requestId: `approval-${status}`,
    status,
    issueId: candidate.id,
    issueIdentifier: candidate.identifier,
    runId,
    evidenceCursor: "idem-1",
    dedupeKey: `${runId}:idem-1:push_and_pr`,
    action: {
      kind: "push_and_pr",
      branchName: candidate.branchName ?? "symphony/TEST-1",
      baseBranch: "main",
      workspacePath: path.join(root, "workspace"),
      title: `${candidate.identifier}: ${candidate.title}`,
      evidenceCursor: "idem-1",
      summaryPreview: "Implemented the requested handoff.",
      changedFiles: ["src/core/orchestrator/Orchestrator.ts"],
      plannedOperations: ["commit_if_needed", "git_push", "pull_request_create_or_reuse"],
    },
    requestedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: status === "expired" ? "2026-01-01T00:00:01.000Z" : null,
    resolvedAt: status === "pending" ? null : "2026-01-01T00:00:02.000Z",
    resolvedBy: status === "approved" || status === "rejected" ? "operator" : status === "pending" ? null : "system",
    decision: status === "approved" ? "approve" : status === "rejected" ? "reject" : null,
    staleReason,
  };
}

function githubProfileConfig(
  workspaceRoot: string,
  input: {
    profiles: Record<string, { value: string; capabilities: string[] }>;
    roles: { worker?: Record<string, string>; reviewer?: Record<string, string> };
    env: Record<string, string>;
  },
) {
  return parseServiceConfig(
    {
      tracker: {
        kind: "linear",
        api_key: "$LINEAR_API_KEY",
        project_slug: "TEST",
      },
      workspace: {
        root: workspaceRoot,
      },
      polling: {
        interval_ms: 60_000,
      },
      agent: {
        max_concurrent_agents: 2,
        max_turns: 1,
      },
      github: {
        owner: "acme",
        repo: "symphony",
        token: "legacy-github-token",
        api_base_url: "https://api.github.test",
      },
      credential_profiles: {
        profiles: input.profiles,
        roles: input.roles,
      },
    },
    path.join(workspaceRoot, "WORKFLOW.md"),
    {
      LINEAR_API_KEY: "linear-test-key",
      ...input.env,
    },
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type StartupReplayScenario = "superseded" | "drifted" | "fresh";

async function createIssueBreakdownStartupFixture(
  workspaceRoot: string,
  options: { scenario: StartupReplayScenario },
): Promise<{
  config: ReturnType<typeof testConfig>;
  orchestrator: Orchestrator;
  outboxStore: FileWritebackOutboxStore;
  lifecycleStore: FileIssueLifecycleStore;
  writer: StateChangingWriter;
  parentIssue: Issue;
  supersededPlan: IssueBreakdownPlanRecord;
  currentPlan: IssueBreakdownPlanRecord | null;
  replayOperationKeys: string[];
}> {
  const config = testConfig(workspaceRoot);
  config.issueBreakdown.applyToLinear.enabled = true;
  config.writeback.enabled = true;
  config.writeback.mode = "live";
  const logger = new StructuredLogger(() => undefined);
  const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
  const outboxStore = new FileWritebackOutboxStore(config.workspace.stateDir);
  const parentIssue = issue({
    identifier: "ENG-1",
    labels: ["planning"],
    title: "Original issue",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const seeded = await seedIssueBreakdownReplayWork(config, lifecycleStore, outboxStore, parentIssue, {
    supersede: options.scenario === "superseded",
  });
  const resolvedIssue =
    options.scenario === "drifted"
      ? { ...parentIssue, title: "Changed issue", updatedAt: "2026-01-02T00:00:00.000Z" }
      : parentIssue;
  const tracker: TrackerClient = {
    async fetchCandidateIssues() {
      return [];
    },
    async fetchIssuesByStates(states) {
      return issuesInStates([], states);
    },
    async fetchIssueStatesByIds() {
      return [resolvedIssue];
    },
  };
  const writer = new StateChangingWriter(() => undefined);
  const writeback = new WritebackProcessor(
    outboxStore,
    writer,
    logger,
    config.writeback.maxBackoffMs,
    lifecycleStore,
    false,
    {
      getConfig: () => config,
      resolveIssue: async () => ({ status: "ok", issue: resolvedIssue }),
    },
  );
  const orchestrator = new Orchestrator({
    config,
    tracker,
    workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
    harness: new FakeHarness(),
    logger,
    promptTemplate: "Work on {{ issue.identifier }}",
    lifecycleStore,
    writeback,
  });

  return {
    config,
    orchestrator,
    outboxStore,
    lifecycleStore,
    writer,
    parentIssue,
    supersededPlan: seeded.plan,
    currentPlan: seeded.currentPlan,
    replayOperationKeys: seeded.replayOperationKeys,
  };
}

type StartupReplayActivityFixture = Awaited<ReturnType<typeof createIssueBreakdownStartupFixture>>;

async function expectStartupReplayActivitySkipReasons(
  fixture: StartupReplayActivityFixture,
  expectedSkipReason: {
    code: "issue_breakdown_plan_not_current" | "issue_breakdown_plan_stale";
    message: string;
  },
): Promise<void> {
  const activity = await fetchActivityForIssue(fixture);
  const expectedKinds = ["issue_create", "issue_relation", "comment"];
  for (const [index, key] of fixture.replayOperationKeys.entries()) {
    const item = activity.find((candidate) => candidate.id === `writeback:${key}`);
    expect(item).toMatchObject({
      kind: "writeback_operation",
      writeback: {
        operationKind: expectedKinds[index],
        status: "skipped",
        skipReason: expectedSkipReason,
      },
    });
    expect(item?.writeback).not.toHaveProperty("lastError");
    expect(item?.writeback).not.toHaveProperty("resultMessage");
  }
}

async function fetchActivityForIssue(fixture: StartupReplayActivityFixture): Promise<ActivityWritebackItem[]> {
  const logger = new StructuredLogger(() => undefined);
  const server = new StatusServer({
    orchestrator: fixture.orchestrator,
    workspaceManager: new WorkspaceManager({ workspace: fixture.config.workspace, hooks: fixture.config.hooks, logger }),
    workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: fixture.config.workspace.root, openerCommand: null }),
    lifecycleStore: fixture.lifecycleStore,
    writebackOutbox: fixture.outboxStore,
    host: "127.0.0.1",
    port: 0,
    openWorkspaceToken: null,
    trackerStateLists: testTrackerStateLists(),
    staleThresholdMs: 300_000,
  });
  const address = await server.start();
  try {
    const response = await fetch(
      `http://${address.host}:${address.port}/api/v1/activity?issue=${encodeURIComponent(fixture.parentIssue.identifier)}&limit=100`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { activity: ActivityWritebackItem[] };
    return body.activity;
  } finally {
    await server.stop();
  }
}

type ActivityWritebackItem = {
  id: string;
  kind: string;
  writeback: null | {
    operationKind: string;
    status: string;
    skipReason: {
      code: "issue_breakdown_plan_not_current" | "issue_breakdown_plan_stale";
      message: string;
    } | null;
  };
};

function testTrackerStateLists(): TrackerStateLists {
  return {
    activeStates: ["Todo", "In Progress"],
    handoffStates: ["Human Review"],
    reviewStates: ["In Review"],
    blockedStates: ["Blocked"],
    terminalStates: ["Done", "Canceled"],
  };
}

function mergePolicyOrchestratorConfig(root: string) {
  return parseServiceConfig(
    {
      tracker: {
        kind: "linear",
        api_key: "$LINEAR_API_KEY",
        project_slug: "TEST",
      },
      workspace: { root },
      writeback: { enabled: true, mode: "live", dispatch_state: "In Progress" },
      review_loop: { review_states: ["In Review"], review_pass_state: "Ready to Merge", blocked_states: ["Blocked"] },
      merge_policy: {
        mode: "gated",
        source_states: ["Ready to Merge"],
        done_state: "Done",
        merge_method: "squash",
        required_checks: ["test"],
        no_ci: { allowed: false },
      },
      github: { owner: "acme", repo: "symphony" },
    },
    path.join(root, "WORKFLOW.md"),
    { LINEAR_API_KEY: "linear-secret", GITHUB_TOKEN: "github-secret" },
  );
}

async function seedIssueBreakdownReplayWork(
  config: ReturnType<typeof testConfig>,
  lifecycleStore: FileIssueLifecycleStore,
  outboxStore: FileWritebackOutboxStore,
  parentIssue: Issue,
  options: { supersede: boolean },
): Promise<{ plan: IssueBreakdownPlanRecord; currentPlan: IssueBreakdownPlanRecord | null; replayOperationKeys: string[] }> {
  const plan = await submitTwoChildPlan(config, lifecycleStore, parentIssue, "plan-a", "run-plan-a");
  const childOperations = planIssueBreakdownApplicationWritebacks(parentIssue, plan) as IssueCreateWriteback[];
  const planWithRefs = {
    ...plan,
    createdIssueRefs: childOperations.map((operation) => createdIssueRefForOperation(operation)),
  };
  const finalOperations = planIssueBreakdownFinalizationWritebacks(parentIssue, planWithRefs);
  const relationOperation = finalOperations.find((operation): operation is IssueRelationWriteback => operation.kind === "issue_relation");
  const parentCommentOperation = finalOperations.find((operation): operation is CommentWriteback => operation.kind === "comment");
  if (!relationOperation || !parentCommentOperation) throw new Error("expected relation and parent comment writebacks");

  const applicationOperationKeys = [
    ...childOperations.map((operation) => operation.idempotencyKey),
    ...finalOperations.map((operation) => operation.idempotencyKey),
  ];
  const lifecycle = await lifecycleStore.get(parentIssue.id);
  await lifecycleStore.updateIssue(parentIssue, {
    issueBreakdownPlans: (lifecycle?.issueBreakdownPlans ?? []).map((candidatePlan) =>
      candidatePlan.id === plan.id
        ? {
            ...planWithRefs,
            applicationStatus: "pending",
            applicationOperationKeys,
            applicationBlockedReason: null,
          }
        : candidatePlan,
    ),
    lastIssueBreakdownPlanId: plan.id,
  });

  await outboxStore.enqueueOnce(childOperations[0]!);
  await outboxStore.markRetry(
    await outboxStore.enqueueOnce(relationOperation),
    "transient relation failure",
    "2026-01-01T00:00:00.000Z",
  );
  await outboxStore.enqueueOnce(parentCommentOperation);

  const currentPlan = options.supersede ? await submitTwoChildPlan(config, lifecycleStore, parentIssue, "plan-b", "run-plan-b") : null;
  return {
    plan,
    currentPlan,
    replayOperationKeys: [childOperations[0]!.idempotencyKey, relationOperation.idempotencyKey, parentCommentOperation.idempotencyKey],
  };
}

async function submitTwoChildPlan(
  config: ReturnType<typeof testConfig>,
  lifecycleStore: FileIssueLifecycleStore,
  parentIssue: Issue,
  idempotencyKey: string,
  runId: string,
): Promise<IssueBreakdownPlanRecord> {
  const result = await new IssueBreakdownPlanService({ config, lifecycleStore }).submit_issue_breakdown_plan(
    {
      runId,
      issueId: parentIssue.id,
      summary: "Split into child issues.",
      proposedIssues: [
        {
          title: "Build child",
          description: agentEligibleIssueContract(),
          acceptanceCriteria: ["Done"],
          dependencies: [],
          labels: ["planning"],
        },
        {
          title: "Build dependent child",
          description: agentEligibleIssueContract(),
          acceptanceCriteria: ["Done"],
          dependencies: ["Build child"],
          labels: ["planning"],
        },
      ],
      idempotencyKey,
    },
    { issue: parentIssue, activeRunId: runId, role: "worker", phase: "issue_breakdown" },
  );
  return result.plan;
}

function createdIssueRefForOperation(operation: IssueCreateWriteback): IssueBreakdownCreatedIssueRef {
  const childNumber = operation.payload.proposedIssueIndex + 1;
  return {
    proposedIssueIndex: operation.payload.proposedIssueIndex,
    operationKey: operation.idempotencyKey,
    status: "created",
    id: `child-${childNumber}`,
    identifier: `TEST-${childNumber + 1}`,
    url: `https://linear.test/TEST-${childNumber + 1}`,
  };
}

class RunActivityHarness implements AgentHarness {
  readonly id = "fake";
  readonly capabilities = { continuation: true, mcpHandoff: true };
  readonly runs: Array<{ ctx: AgentRunContext; prompt: string }> = [];

  constructor(private readonly events: AgentEvent[]) {}

  async *run(ctx: AgentRunContext, prompt: string): AsyncIterable<AgentEvent> {
    this.runs.push({ ctx, prompt });
    yield { type: "session_started", sessionId: `fake-${ctx.issue.id}-${ctx.turnNumber}` };
    for (const event of this.events) yield event;
  }
}

function acpActivity(runId: string, sequence: number, overrides: Partial<RunActivityEvent>): RunActivityEvent {
  const payload =
    overrides.payload && typeof overrides.payload === "object" && !Array.isArray(overrides.payload) ? overrides.payload : {};
  return {
    eventId: `${runId}:activity:${sequence}`,
    runSessionId: `profile:acp-session-1:${runId}`,
    occurredAt: `2026-05-31T00:00:0${Math.min(sequence, 9)}.000Z`,
    sequence,
    sequenceSource: "harness",
    externalEventId: `upstream-${sequence}`,
    protocol: "acp",
    harness: "hermes-acp",
    ...overrides,
    payload: { runtimeSessionId: "acp-session-1", ...payload },
  } as RunActivityEvent;
}

async function runTerminalRunActivityScenario(root: string, terminal: "failed" | "cancelled") {
  const config = testConfig(root);
  const candidate = issue({ id: `issue-${terminal}`, identifier: `TEST-${terminal.toUpperCase()}`, state: "Todo" });
  let active = true;
  let refreshes = 0;
  const tracker: TrackerClient = {
    async fetchCandidateIssues() {
      return active ? [candidate] : [];
    },
    async fetchIssuesByStates(states) {
      return issuesInStates(active ? [candidate] : [], states);
    },
    async fetchIssueStatesByIds() {
      refreshes += 1;
      if (refreshes === 1) return [candidate];
      active = false;
      return [{ ...candidate, state: "Done" }];
    },
  };
  const logger = new StructuredLogger(() => undefined);
  const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
  const runId = `fake-${candidate.id}-1`;
  const terminalEvent: AgentEvent =
    terminal === "failed"
      ? {
          type: "failed",
          error: "Run failed token=SECRET_TERMINAL_TOKEN",
          runActivity: acpActivity(runId, 2, {
            actor: "runtime",
            channel: "terminal",
            kind: "run_failed",
            text: "Run failed token=SECRET_TERMINAL_TOKEN",
            payload: { reason: "provider_error", errorPreview: "Run failed token=SECRET_TERMINAL_TOKEN", redacted: true },
          }),
        }
      : {
          type: "cancelled",
          runActivity: acpActivity(runId, 2, {
            actor: "runtime",
            channel: "terminal",
            kind: "run_cancelled",
            text: "Run cancelled",
            payload: { reason: "operator_cancelled" },
          }),
        };
  const harness = new RunActivityHarness([terminalEvent]);
  const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
  const orchestrator = new Orchestrator({
    config,
    tracker,
    workspaceManager,
    harness,
    logger,
    promptTemplate: "Work on {{ issue.identifier }}",
    runStore,
  });

  await orchestrator.refreshNow();
  await waitFor(() => harness.runs.length === 1, `${terminal} run-activity harness dispatched`);
  await waitFor(() => orchestrator.snapshot().counts.running === 0, `${terminal} run-activity harness exited`);
  await settleOrchestratorExit();
  await orchestrator.stop();

  const run = await runStore.latestRunForIssue(candidate.id);
  const transcript = await runStore.readTranscript(runId);
  return {
    run,
    transcript,
    eventTypes: transcript.events.map((event) => event.eventType),
    projected: projectWebTranscript(transcript.events, { includeRunPrelude: false }),
  };
}

async function waitFor(predicate: () => boolean, description = "condition", timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate(), `Timed out waiting for ${description}`).toBe(true);
}

async function waitForAsync(predicate: () => Promise<boolean>, description = "condition", timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(await predicate(), `Timed out waiting for ${description}`).toBe(true);
}

async function waitForPendingApproval(store: FileOperatorApprovalStore, runId: string, timeoutMs = 2_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const pending = await store.findPendingForRun(runId);
    if (pending) return pending;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for pending approval on ${runId}`);
}

async function waitForRunRecord(store: FileRunTranscriptStore, runId: string, timeoutMs = 2_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const run = await store.getRun(runId);
      if (run) return run;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for run record ${runId}`);
}

async function waitForTerminalRunRecord(store: FileRunTranscriptStore, runId: string, timeoutMs = 2_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const run = await store.getRun(runId);
      if (run && run.status !== "running") return run;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for terminal run record ${runId}`);
}

async function settleOrchestratorExit(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

async function expectReplaySucceededFromHandoff(
  stateDir: string,
  runId: string,
  expected: Record<string, unknown> = {},
): Promise<void> {
  const rebuilt = await new FileRunTranscriptStore(stateDir).rebuildRunFromTranscript(runId);
  expect(rebuilt).toMatchObject({
    status: "succeeded",
    completedAt: expect.any(String),
    error: null,
    ...expected,
  });
  expect(rebuilt?.failureKind ?? null).toBeNull();
  expect(rebuilt?.failureDiagnosticCode ?? null).toBeNull();
  expect(rebuilt?.failureDiagnosticMessage ?? null).toBeNull();
  expect(rebuilt?.failureDiagnosticAt ?? null).toBeNull();
}

async function expectReplayFailedFromPlanningFailure(
  stateDir: string,
  runId: string,
  error: string,
  expected: Record<string, unknown> = {},
): Promise<void> {
  const rebuilt = await new FileRunTranscriptStore(stateDir).rebuildRunFromTranscript(runId);
  expect(rebuilt).toMatchObject({
    status: "failed",
    completedAt: expect.any(String),
    error,
    runPhase: "issue_breakdown",
    runKind: "planning",
    failureKind: "planning_run_failed",
    failureDiagnosticCode: "planning_run_failed",
    failureDiagnosticMessage: error,
    failureDiagnosticAt: expect.any(String),
    ...expected,
  });
}

async function runAcceptedIssueBreakdownHandoffScenario(
  root: string,
  terminal: IssueBreakdownHandoffTerminal,
): Promise<{
  runStore: FileRunTranscriptStore;
  planRunId: string;
  stateDir: string;
}> {
  const config = testConfig(root);
  config.issueBreakdown.enabled = true;
  config.issueBreakdown.promptTemplate = "Plan {{ issue.identifier }}";
  config.issueBreakdown.planningLabels = ["planning"];
  config.issueBreakdown.maxPlanningFailures = 3;
  const candidate = issue({ state: "Todo", labels: ["planning"], updatedAt: "2026-01-02T00:00:00Z" });
  let active = true;
  const tracker: TrackerClient = {
    async fetchCandidateIssues() {
      return active ? [candidate] : [];
    },
    async fetchIssuesByStates(states) {
      return issuesInStates(active ? [candidate] : [], states);
    },
    async fetchIssueStatesByIds() {
      return [candidate];
    },
  };
  const logger = new StructuredLogger(() => undefined);
  const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
  await lifecycleStore.ensureIssue(candidate, {
    incompleteTurnCount: 2,
    planningFailureCount: 1,
    planningDispatchRetryCount: 1,
    lastPlanningFailureRunId: "previous-planning-run",
    lastPlanningFailureAt: "2026-01-01T00:00:00.000Z",
  });
  const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
  const harness = new IssueBreakdownHandoffHarness(lifecycleStore, terminal);
  const orchestrator = new Orchestrator({
    config,
    tracker,
    workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
    harness,
    logger,
    promptTemplate: "Work on {{ issue.identifier }}",
    lifecycleStore,
    runStore,
  });

  await orchestrator.refreshNow();
  await waitFor(() => harness.runs.filter((run) => run.ctx.runPhase === "issue_breakdown").length === 1);
  await waitFor(() => orchestrator.snapshot().counts.running === 0);
  await settleOrchestratorExit();
  const planRunId = harness.runs.find((run) => run.ctx.runPhase === "issue_breakdown")?.runId ?? "";
  const lifecycle = await lifecycleStore.get(candidate.id);

  await expect(runStore.getRun(planRunId)).resolves.toMatchObject({
    status: "succeeded",
    runPhase: "issue_breakdown",
    runKind: "planning",
  });
  expect(lifecycle?.planningFailureCount).toBe(0);
  expect(lifecycle?.planningDispatchRetryCount).toBe(0);
  expect(lifecycle?.lastPlanningFailureRunId).toBeNull();
  expect(lifecycle?.lastPlanningFailureAt).toBeNull();
  expect(lifecycle?.incompleteTurnCount).toBe(2);
  expect(orchestrator.snapshot().counts.retrying).toBe(0);

  active = false;
  await orchestrator.refreshNow();
  await settleOrchestratorExit();
  await orchestrator.stop();
  expect(harness.runs.filter((run) => run.ctx.runPhase === "issue_breakdown")).toHaveLength(1);

  return { runStore, planRunId, stateDir: config.workspace.stateDir };
}

async function readIssueState(stateDir: string, issueIdOrIdentifier: string) {
  const store = new SqliteIssueStateStore(stateDir);
  try {
    return await store.get(issueIdOrIdentifier);
  } finally {
    await store.close();
  }
}

function emptyTracker(): TrackerClient {
  return {
    async fetchCandidateIssues() {
      return [];
    },
    async fetchIssuesByStates(states) {
      return issuesInStates([], states);
    },
    async fetchIssueStatesByIds() {
      return [];
    },
  };
}

function mergePolicyChainContext(iteration: number, parent: IssueHistorySnapshot | null = null) {
  return {
    kind: "merge_policy_chain" as const,
    requestId: `transition-request-${iteration}`,
    requestedAt: "2026-01-01T00:00:01.000Z",
    parentHistorySnapshotId: parent?.historySnapshotId ?? null,
    parentTransitionKind: parent?.transitionKind ?? null,
    payload: {
      chainId: "merge-policy-chain-1",
      iteration,
      maxIterations: 6,
    },
  };
}

function mergePolicyRulesetSnapshot(overrides: Partial<IssueCurrentStateSnapshot> = {}): IssueCurrentStateSnapshot {
  const now = "2026-01-01T00:00:00.000Z";
  const candidate = issue({ state: "Ready to Merge", branchName: "symphony/TEST-1" });
  return {
    version: 1,
    issueId: candidate.id,
    issueIdentifier: candidate.identifier,
    title: candidate.title,
    description: candidate.description,
    priority: candidate.priority,
    trackerState: candidate.state,
    branchName: candidate.branchName,
    trackerUrl: candidate.url,
    assigneeId: candidate.assigneeId,
    delegateId: candidate.delegateId,
    assignedToWorker: candidate.assignedToWorker,
    labels: candidate.labels,
    blockedBy: candidate.blockedBy,
    hasChildren: candidate.hasChildren === true,
    trackerCreatedAt: candidate.createdAt,
    trackerUpdatedAt: candidate.updatedAt,
    phase: "passed",
    reviewRound: 0,
    incompleteTurnCount: 0,
    planningFailureCount: 0,
    planningDispatchRetryCount: 0,
    lastPlanningFailureAt: null,
    planningRetryDueAt: null,
    blockedReason: null,
    lastIssueBreakdownPlanId: null,
    lastIssueBreakdownPlanApplicationStatus: null,
    lastIssueBreakdownPlanIssueContentFingerprint: null,
    lastIssueBreakdownPlanConfigFingerprint: null,
    lastIssueBreakdownPlanSatisfiesCurrentValidation: false,
    currentIssueContentFingerprint: "issue-fingerprint",
    currentIssueBreakdownConfigFingerprint: "breakdown-config",
    lastIssueTriageReportId: null,
    lastIssueTriageReportTriggerFingerprint: null,
    lastIssueTriageReportWritebackOperationKeys: null,
    currentIssueTriageTriggerFingerprint: null,
    issueTriageCurrentTriggerReportIds: [],
    latestIssueTriageReportBlockers: [],
    lastPostMortemReportId: null,
    lastPostMortemReportTriggerFingerprint: null,
    lastPostMortemReportWritebackOperationKeys: null,
    currentPostMortemTriggerFingerprint: null,
    postMortemCurrentTriggerReportIds: [],
    lastCompletionReportId: null,
    lastCompletionReportRejectionId: null,
    lastReviewVerdictId: null,
    lastMergeGateResultId: null,
    latestCompletionReport: null,
    latestApprovalPassVerdict: null,
    mergeGate: null,
    mergeConflict: null,
    lifecycleSummaryCiStatus: null,
    mergePolicyMode: "gated",
    mergePolicySourceStates: ["Ready to Merge"],
    mergePolicyDoneState: "Done",
    mergePolicyConflictsState: "Merge Conflict",
    mergePolicyRequiredChecks: ["test"],
    mergePolicyMaxMergeGateFailures: 3,
    mergePolicyConfigFingerprint: "merge-policy-config",
    currentMergePolicyObservationInputFingerprint: "merge-policy-input",
    lastMergePolicyObservationFingerprint: null,
    lastMergePolicyObservationStatus: null,
    lastMergePolicyObservation: null,
    mergePolicyMerge: null,
    mergePolicyMergeGate: null,
    mergePolicyMergeGateResults: [],
    mergePolicyMergeConflict: null,
    mergePolicyLatestCompletionReport: null,
    mergePolicyLatestApprovalVerdict: null,
    mergePolicyReviewFeedback: [],
    mergePolicyLatestCompletionRun: null,
    pendingPublicationApprovalRunId: null,
    pendingPublicationApprovalReportId: null,
    pendingPublicationApprovalReason: null,
    latestRunId: null,
    latestRunStatus: null,
    latestRunRole: null,
    latestRunPhase: null,
    latestRunKind: null,
    latestRunCompletedAt: null,
    latestRunError: null,
    latestPrUrl: null,
    latestPrNumber: 42,
    latestPrHeadSha: "abc123",
    latestPrBranch: "symphony/TEST-1",
    latestWorkspaceKey: null,
    latestWorkspacePath: null,
    latestGitBranchName: "symphony/TEST-1",
    running: false,
    runningRole: null,
    runningRunPhase: null,
    runningRunKind: null,
    runningManualDispatchStage: null,
    runningManualIgnoreState: false,
    runningHasPendingPublicationApproval: false,
    runningCancellationRequested: false,
    claimed: false,
    paused: false,
    retrying: false,
    consecutiveSdkErrorFailures: 0,
    consecutiveInfraFailures: 0,
    recordCreatedAt: now,
    recordUpdatedAt: now,
    snapshotId: "snapshot-1",
    snapshotAt: now,
    triggerType: "orchestrator.tick",
    triggerId: "tick-1",
    triggerAt: now,
    triggerSource: "orchestrator",
    candidateSource: "merge_policy_candidates",
    transitionRequestContext: null,
    availableSlots: 1,
    providerDispatchGateActive: false,
    stateSlotAvailable: true,
    allowExistingClaim: false,
    manualStage: null,
    manualForceLabels: false,
    manualIgnoreState: false,
    ...overrides,
  };
}

function transitionSnapshot(
  transitionKind: IssueHistorySnapshot["transitionKind"],
  historySnapshotId: string,
): IssueHistorySnapshot {
  return {
    transitionKind,
    historySnapshotId,
  } as IssueHistorySnapshot;
}

function mergePolicyLoopHarness(
  root: string,
  responses: Array<{ transition: IssueHistorySnapshot | null; acted: boolean }>,
  logs: string[] = [],
) {
  const config = mergePolicyOrchestratorConfig(root);
  const logger = new StructuredLogger((line) => logs.push(line));
  const candidate = issue({ state: "Ready to Merge", branchName: "symphony/TEST-1" });
  const orchestrator = new Orchestrator({
    config,
    tracker: emptyTracker(),
    workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
    harness: new FakeHarness(),
    logger,
    promptTemplate: "Work on {{ issue.identifier }}",
  });
  const requester = orchestrator as unknown as {
    requestTransition: ReturnType<typeof vi.fn>;
    processMergePolicyTransitionCandidate(issue: Issue): Promise<void>;
  };
  let responseIndex = 0;
  requester.requestTransition = vi.fn(async () => responses[Math.min(responseIndex++, responses.length - 1)]);
  return { candidate, orchestrator, requester };
}

class BlockingHarness implements AgentHarness {
  readonly id = "blocking";
  readonly stoppedRunIds: string[] = [];

  async *run(ctx: AgentRunContext): AsyncIterable<AgentEvent> {
    yield { type: "session_started", sessionId: "session-123", runId: "run-123" };
    if (!ctx.abortSignal.aborted) {
      await new Promise<void>((resolve) => ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true }));
    }
    yield { type: "cancelled" };
  }

  async stop(runId: string): Promise<void> {
    this.stoppedRunIds.push(runId);
  }
}

class HeldCancellationHarness implements AgentHarness {
  readonly id = "held-cancellation";
  readonly stoppedRunIds: string[] = [];
  private releaseRun: () => void = () => undefined;
  private readonly released = new Promise<void>((resolve) => {
    this.releaseRun = resolve;
  });

  async *run(): AsyncIterable<AgentEvent> {
    yield { type: "session_started", sessionId: "session-123", runId: "run-123" };
    await this.released;
    yield { type: "cancelled" };
  }

  async stop(runId: string): Promise<void> {
    this.stoppedRunIds.push(runId);
  }

  release(): void {
    this.releaseRun();
  }
}

class FailingStopHarness implements AgentHarness {
  readonly id = "failing-stop";
  readonly stoppedRunIds: string[] = [];
  private releaseRun: () => void = () => undefined;
  private readonly released = new Promise<void>((resolve) => {
    this.releaseRun = resolve;
  });

  async *run(): AsyncIterable<AgentEvent> {
    yield { type: "session_started", sessionId: "session-failing-stop", runId: "run-failing-stop" };
    yield { type: "progress", message: "working", activitySource: "stream" };
    await this.released;
    yield { type: "cancelled" };
  }

  async stop(runId: string): Promise<void> {
    this.stoppedRunIds.push(runId);
    throw new Error("stop failed");
  }

  release(): void {
    this.releaseRun();
  }
}

class StalledAbortHarness implements AgentHarness {
  readonly id = "stalled-abort";
  private releaseRun: () => void = () => undefined;
  private readonly released = new Promise<void>((resolve) => {
    this.releaseRun = resolve;
  });

  async *run(ctx: AgentRunContext): AsyncIterable<AgentEvent> {
    yield { type: "session_started", sessionId: "session-stalled", runId: "run-stalled" };
    await this.released;
    if (ctx.abortSignal.aborted) {
      yield { type: "cancelled" };
      return;
    }
    yield { type: "completed" };
  }

  release(): void {
    this.releaseRun();
  }
}

class PreSessionCancellationHarness implements AgentHarness {
  readonly id = "pre-session-cancellation";
  readonly stoppedRunIds: string[] = [];
  private resolveStarted: () => void = () => undefined;
  readonly started = new Promise<void>((resolve) => {
    this.resolveStarted = resolve;
  });
  private releaseRun: () => void = () => undefined;
  private readonly released = new Promise<void>((resolve) => {
    this.releaseRun = resolve;
  });

  async *run(): AsyncIterable<AgentEvent> {
    this.resolveStarted();
    await this.released;
    yield { type: "session_started", sessionId: "session-pre", runId: "run-pre" };
    yield { type: "cancelled" };
  }

  async stop(runId: string): Promise<void> {
    this.stoppedRunIds.push(runId);
  }

  release(): void {
    this.releaseRun();
  }
}

class ServiceStopAbortHarness implements AgentHarness {
  readonly id = "service-stop-abort";
  readonly stoppedRunIds: string[] = [];
  private releaseRun: () => void = () => undefined;
  private readonly released = new Promise<void>((resolve) => {
    this.releaseRun = resolve;
  });

  async *run(ctx: AgentRunContext): AsyncIterable<AgentEvent> {
    yield { type: "session_started", sessionId: "session-service-stop", runId: "run-service-stop" };
    if (!ctx.abortSignal.aborted) {
      await new Promise<void>((resolve) => ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true }));
    }
    await this.released;
    throw new Error("service stop abort");
  }

  async stop(runId: string): Promise<void> {
    this.stoppedRunIds.push(runId);
  }

  release(): void {
    this.releaseRun();
  }
}

class NonResumableHarness implements AgentHarness {
  readonly id = "non-resumable";
  readonly supportsContinuation = false;
  readonly prompts: string[] = [];

  async *run(_ctx: AgentRunContext, prompt: string): AsyncIterable<AgentEvent> {
    this.prompts.push(prompt);
    yield { type: "session_started", sessionId: "session-1", runId: "run-1" };
    yield { type: "completed" };
  }
}

class CursorPromptHarness implements AgentHarness {
  readonly id = "cursor";
  readonly prompts: string[] = [];

  async *run(_ctx: AgentRunContext, prompt: string): AsyncIterable<AgentEvent> {
    this.prompts.push(prompt);
    yield { type: "session_started", sessionId: "cursor-session-1", runId: "cursor-run-1" };
    yield { type: "completed" };
  }
}

class NonMcpHarness implements AgentHarness {
  readonly id = "no-mcp";
  readonly capabilities = { continuation: true, mcpHandoff: false };
  readonly prompts: string[] = [];

  async *run(_ctx: AgentRunContext, prompt: string): AsyncIterable<AgentEvent> {
    this.prompts.push(prompt);
    yield { type: "session_started", sessionId: "no-mcp-session", runId: "no-mcp-run" };
    yield { type: "completed" };
  }
}

class ManualDispatchRecordingHarness implements AgentHarness {
  readonly id = "manual-dispatch-recording";
  readonly capabilities = { continuation: true, mcpHandoff: true, ephemeralSystemPrompt: true };
  readonly runs: Array<{ ctx: AgentRunContext; prompt: string }> = [];

  constructor(
    private readonly lifecycleStore: FileIssueLifecycleStore,
    private readonly outboxStore: FileWritebackOutboxStore,
    private readonly runStore: FileRunTranscriptStore,
  ) {}

  async *run(ctx: AgentRunContext, prompt: string): AsyncIterable<AgentEvent> {
    this.runs.push({ ctx, prompt });
    const runId = `manual-run-${this.runs.length}`;
    yield { type: "session_started", sessionId: `${runId}-session`, runId };
    if (ctx.role === "worker" && ctx.runPhase === "implementation") {
      await new CompletionReportService({
        config: ctx.config,
        lifecycleStore: this.lifecycleStore,
        writebackOutbox: this.outboxStore,
        runStore: this.runStore,
      }).submitCompletionReport(
        {
          runId,
          issueId: ctx.issue.id,
          summary: "Manual worker dispatch completed.",
          validationEvidence: ["manual dispatch test"],
          acceptanceChecklist: [{ text: "Manual dispatch started the requested worker stage.", satisfied: true, evidence: "test" }],
          changedFiles: [],
          branchName: ctx.workspace.gitBranchName ?? ctx.issue.branchName,
          pullRequest: null,
          risks: [],
          idempotencyKey: runId,
        },
        {
          issue: ctx.issue,
          activeRunId: runId,
          role: "worker",
          sessionId: `${runId}-session`,
          workspacePath: ctx.workspace.path,
          workspace: ctx.workspace,
          phase: "implementation",
          ...(ctx.manualDispatchIgnoreState === true ? { ignoreStateGate: true } : {}),
        },
      );
    }
    yield { type: "completed" };
  }
}

class LifecycleSnapshotHarness implements AgentHarness {
  readonly id = "lifecycle-snapshot";
  readonly capabilities = { continuation: true, mcpHandoff: true, ephemeralSystemPrompt: true };
  readonly runs: AgentRunContext[] = [];
  readonly snapshots: Array<Awaited<ReturnType<FileIssueLifecycleStore["get"]>>> = [];

  constructor(private readonly lifecycleStore: FileIssueLifecycleStore) {}

  async *run(ctx: AgentRunContext): AsyncIterable<AgentEvent> {
    this.runs.push(ctx);
    yield { type: "session_started", sessionId: "snapshot-session-1", runId: "snapshot-run-1" };
    this.snapshots.push(await this.lifecycleStore.get(ctx.issue.id));
    yield { type: "completed" };
  }
}

class FailingRequiredCheckMergeClient implements MergePolicyGitHubClient {
  async getPullRequest() {
    return {
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:00:02.000Z",
      state: "open",
      merged: false,
      mergeCommitSha: null,
      mergedAt: null,
      mergedBy: null,
      mergeable: true,
      mergeableState: "clean",
      baseBranch: "main",
      baseHeadSha: "base-sha-1",
    };
  }

  async getBranchHeadSha() {
    return "base-sha-1";
  }

  async getRequiredCheckResults() {
    return [{ name: "test", status: "failure" as const, conclusion: "failure", url: "https://ci.test/test" }];
  }

  async mergePullRequest(): Promise<never> {
    throw new Error("merge should not be called while required checks fail");
  }

  async getAuthenticatedLogin() {
    return "symphony-bot";
  }

  async isAncestor() {
    return true;
  }

  async gitAuthHeader() {
    return "x-access-token:token";
  }
}

class ProviderLimitThenCompleteHarness implements AgentHarness {
  readonly capabilities = { continuation: true, mcpHandoff: true };
  readonly runs: Array<{ ctx: AgentRunContext; prompt: string }> = [];

  constructor(
    private readonly limit: { providerId: string; model?: string | null; resumeAt?: string | null },
    readonly id = "hermes",
    private readonly sessionRuntimeMetadata: { providerId?: string | null; model?: string | null } = {},
  ) {}

  async *run(ctx: AgentRunContext, prompt: string): AsyncIterable<AgentEvent> {
    this.runs.push({ ctx, prompt });
    yield {
      type: "session_started",
      sessionId: `provider-limit-${this.runs.length}`,
      runId: `provider-limit-run-${this.runs.length}`,
      ...(this.sessionRuntimeMetadata.providerId === undefined ? {} : { providerId: this.sessionRuntimeMetadata.providerId }),
      ...(this.sessionRuntimeMetadata.model === undefined ? {} : { model: this.sessionRuntimeMetadata.model }),
    };
    if (this.runs.length === 1) {
      yield {
        type: "provider_limit",
        signal: {
          scope: {
            harnessId: this.id,
            providerId: this.limit.providerId,
            model: this.limit.model ?? null,
          },
          kind: "windowed_bucket_exhausted",
          message: "Codex usage window exhausted",
          window: {
            resumeAt: this.limit.resumeAt ?? null,
            windowLabel: this.limit.resumeAt ? "Session" : null,
            windowKind: this.limit.resumeAt ? "codex_5h" : null,
          },
          resumePolicy: this.limit.resumeAt ? "auto_at_window_close" : "manual",
        },
      };
      return;
    }
    yield { type: "completed", message: "recovered" };
  }
}

class IssueBreakdownAcceptingHarness implements AgentHarness {
  readonly id = "issue-breakdown-accepting";
  readonly runs: Array<{ ctx: AgentRunContext; prompt: string }> = [];

  constructor(private readonly lifecycleStore: FileIssueLifecycleStore) {}

  async *run(ctx: AgentRunContext, prompt: string): AsyncIterable<AgentEvent> {
    this.runs.push({ ctx, prompt });
    const runId = `${ctx.runPhase ?? "implementation"}-run-${this.runs.length}`;
    yield { type: "session_started", sessionId: `${runId}-session`, runId };
    if (ctx.runPhase === "issue_breakdown") {
      await new IssueBreakdownPlanService({ config: ctx.config, lifecycleStore: this.lifecycleStore }).submit_issue_breakdown_plan(
        {
          runId,
          issueId: ctx.issue.id,
          idempotencyKey: `test-plan-${runId}`,
          summary: "Break implementation into one task.",
          proposedIssues: [
            {
              title: "Create implementation task",
              description: agentEligibleIssueContract(),
              acceptanceCriteria: ["Behavior is implemented and tested."],
              dependencies: [],
              labels: ["planning"],
            },
          ],
        },
        {
          issue: ctx.issue,
          activeRunId: runId,
          role: "worker",
          phase: "issue_breakdown",
        },
      );
    }
    yield { type: "completed" };
  }
}

class IssueTriageAcceptingHarness implements AgentHarness {
  readonly id = "issue-triage-accepting";
  readonly runs: Array<{ ctx: AgentRunContext; prompt: string }> = [];

  constructor(
    private readonly lifecycleStore: FileIssueLifecycleStore,
    private readonly writebackOutbox: FileWritebackOutboxStore,
  ) {}

  async *run(ctx: AgentRunContext, prompt: string): AsyncIterable<AgentEvent> {
    this.runs.push({ ctx, prompt });
    const runId = `triage-run-${this.runs.length}`;
    yield { type: "session_started", sessionId: `${runId}-session`, runId };
    if (ctx.runPhase === "issue_triage") {
      const lifecycle = await this.lifecycleStore.get(ctx.issue.id);
      if (!lifecycle) throw new Error("missing lifecycle for triage test");
      await new IssueTriageService({
        config: ctx.config,
        lifecycleStore: this.lifecycleStore,
        writebackOutbox: this.writebackOutbox,
      }).submit_issue_triage_report(
        {
          runId,
          issueId: ctx.issue.id,
          triggerFingerprint: issueTriageTriggerFingerprint(lifecycle),
          summary: "Repeated review failures exposed hidden child scope.",
          blockers: [
            {
              kind: "under_specified_needs_decomposition",
              status: "active",
              nextActor: "planner",
              confidence: "high",
              summary: "Repeated review failures exposed hidden child scope.",
              evidence: ["blockedReason=max reviewer failures reached (3/3)"],
              recommendedAction: "Decompose the hidden scope into blocking child issues.",
            },
          ],
          idempotencyKey: runId,
        },
        {
          issue: ctx.issue,
          activeRunId: runId,
          role: "triage",
          phase: "issue_triage",
          ...(ctx.manualDispatch === true ? { manualDispatch: true } : {}),
        },
      );
    }
    yield { type: "completed" };
  }
}

type IssueBreakdownHandoffTerminal = { type: "completed" } | { type: "failed"; error: string } | { type: "cancelled" } | "throw";

class IssueBreakdownHandoffHarness implements AgentHarness {
  readonly id = "issue-breakdown-handoff";
  readonly runs: Array<{ ctx: AgentRunContext; prompt: string; runId: string }> = [];

  constructor(
    private readonly lifecycleStore: FileIssueLifecycleStore,
    private readonly terminal: IssueBreakdownHandoffTerminal,
  ) {}

  async *run(ctx: AgentRunContext, prompt: string): AsyncIterable<AgentEvent> {
    const runId = `${ctx.runPhase ?? "implementation"}-handoff-run-${this.runs.length + 1}`;
    this.runs.push({ ctx, prompt, runId });
    yield { type: "session_started", sessionId: `${runId}-session`, runId };
    if (ctx.runPhase !== "issue_breakdown") {
      yield { type: "completed" };
      return;
    }

    await new IssueBreakdownPlanService({ config: ctx.config, lifecycleStore: this.lifecycleStore }).submit_issue_breakdown_plan(
      {
        runId,
        issueId: ctx.issue.id,
        idempotencyKey: `test-plan-${runId}`,
        summary: "Break implementation into one task.",
        proposedIssues: [
          {
            title: "Create implementation task",
            description: agentEligibleIssueContract(),
            acceptanceCriteria: ["Behavior is implemented and tested."],
            dependencies: [],
            labels: ["planning"],
          },
        ],
      },
      {
        issue: ctx.issue,
        activeRunId: runId,
        role: "worker",
        phase: "issue_breakdown",
      },
    );

    if (this.terminal === "throw") {
      throw new Error("post-plan harness throw");
    }
    yield this.terminal;
  }
}

class IssueBreakdownRejectingHarness implements AgentHarness {
  readonly id = "issue-breakdown-rejecting";
  readonly runs: Array<{ ctx: AgentRunContext; prompt: string }> = [];

  async *run(ctx: AgentRunContext, prompt: string): AsyncIterable<AgentEvent> {
    this.runs.push({ ctx, prompt });
    const runId = `rejecting-plan-run-${this.runs.length}`;
    yield { type: "session_started", sessionId: `${runId}-session`, runId };
    yield { type: "completed" };
  }
}

class IssueBreakdownNoPlanTerminalHarness implements AgentHarness {
  readonly id = "issue-breakdown-no-plan-terminal";
  readonly runs: Array<{ ctx: AgentRunContext; prompt: string }> = [];

  constructor(private readonly terminal: Extract<AgentEvent, { type: "failed" }> | "throw") {}

  async *run(ctx: AgentRunContext, prompt: string): AsyncIterable<AgentEvent> {
    this.runs.push({ ctx, prompt });
    const runId = `no-plan-terminal-run-${this.runs.length}`;
    yield { type: "session_started", sessionId: `${runId}-session`, runId };
    if (this.terminal === "throw") throw new Error("planning harness threw before submitting a plan");
    yield this.terminal;
  }
}

class TokenSequenceHarness implements AgentHarness {
  readonly id = "token-sequence";
  readonly runs: string[] = [];

  constructor(private readonly tokenEvents: TokenCounts[]) {}

  async *run(_ctx: AgentRunContext, _prompt: string): AsyncIterable<AgentEvent> {
    const runNumber = this.runs.length + 1;
    const runId = `token-run-${runNumber}`;
    this.runs.push(runId);
    yield { type: "session_started", sessionId: `${runId}-session`, runId };
    const tokens = this.tokenEvents[runNumber - 1];
    if (tokens) yield { type: "tokens", tokens };
    yield { type: "completed" };
  }
}

class DiagnosticActivityHarness implements AgentHarness {
  readonly id = "diagnostic-activity";

  async *run(): AsyncIterable<AgentEvent> {
    yield { type: "session_started", sessionId: "diagnostic-session-1", runId: "diagnostic-run-1" };
    yield { type: "progress", activitySource: "tool", message: "terminal tool completed" };
    yield {
      type: "run_diagnostic",
      code: "hermes_gateway_protocol_error",
      message: "Hermes gateway diagnostic token=SECRET_DIAGNOSTIC_TOKEN",
      payload: { preview: "malformed gateway line", rawPayload: { token: "SECRET_DIAGNOSTIC_TOKEN" } },
    };
    yield { type: "tokens", tokens: { inputTokens: 12, outputTokens: 8, totalTokens: 20 } };
    yield {
      type: "rate_limits",
      payload: {
        requests: { remaining: 2, resetAt: "2026-01-01T00:30:00.000Z" },
        authorization: "Bearer SECRET_RATE_LIMIT_TOKEN",
      },
    };
    yield { type: "completed", message: "diagnostic run completed" };
  }
}

class SdkWaitErrorHarness implements AgentHarness {
  readonly id = "sdk-wait-error";
  readonly runs: string[] = [];

  async *run(_ctx: AgentRunContext): AsyncIterable<AgentEvent> {
    const runId = `sdk-error-run-${this.runs.length + 1}`;
    this.runs.push(runId);
    yield { type: "session_started", sessionId: `session-${runId}`, runId };
    yield { type: "run_status", runId, sdkStatus: "error", source: "wait" };
    yield {
      type: "run_diagnostic",
      code: "cursor_run_wait_terminal_error",
      message: "Cursor run wait returned terminal SDK error",
      payload: { runId },
    };
    yield { type: "failed", error: "Cursor run failed" };
  }
}

class InfraFailureHarness implements AgentHarness {
  readonly id = "infra-failure";
  readonly runs: string[] = [];

  async *run(): AsyncIterable<AgentEvent> {
    const runId = `infra-error-run-${this.runs.length + 1}`;
    this.runs.push(runId);
    yield { type: "session_started", sessionId: `session-${runId}`, runId };
    yield {
      type: "run_diagnostic",
      code: "hermes_gateway_exit",
      message: "Hermes gateway exited before the run completed (code 0)",
      payload: { runId, gatewayExitCode: 0 },
    };
    yield { type: "failed", error: "Hermes gateway exited before the run completed (code 0)" };
  }
}

type ReportingHarnessTerminal = AgentEvent | "throw";

class RejectedCompletionReportHarness implements AgentHarness {
  readonly id = "rejected-completion-report";
  readonly capabilities = { continuation: true, mcpHandoff: true };
  readonly prompts: string[] = [];

  constructor(
    private readonly lifecycleStore: FileIssueLifecycleStore,
    private readonly outboxStore: FileWritebackOutboxStore,
    private readonly runStore: FileRunTranscriptStore,
  ) {}

  async *run(ctx: AgentRunContext, prompt: string): AsyncIterable<AgentEvent> {
    const turn = this.prompts.length + 1;
    const runId = `reject-run-${turn}`;
    this.prompts.push(prompt);
    yield { type: "session_started", sessionId: `reject-session-${turn}`, runId };
    if (turn === 1) {
      try {
        await new CompletionReportService({
          config: ctx.config,
          lifecycleStore: this.lifecycleStore,
          writebackOutbox: this.outboxStore,
          runStore: this.runStore,
        }).submitCompletionReport(
          {
            runId,
            issueId: ctx.issue.id,
            summary: "Implemented part of the requested handoff.",
            validationEvidence: ["Focused validation could not run in this worker environment."],
            acceptanceChecklist: [
              {
                text: "REQ-1 Required validation is complete.",
                satisfied: false,
                evidence: "Focused validation could not run in this worker environment.",
              },
            ],
            changedFiles: ["src/core/CompletionReportService.ts"],
            branchName: ctx.workspace.gitBranchName ?? ctx.issue.branchName,
            pullRequest: null,
            risks: ["Validation remains incomplete."],
            idempotencyKey: "rejected-idem-1",
          },
          {
            issue: ctx.issue,
            activeRunId: runId,
            role: "worker",
            sessionId: `reject-session-${turn}`,
            workspacePath: ctx.workspace.path,
            workspace: ctx.workspace,
            phase: "implementation",
          },
        );
      } catch (error) {
        if (!(error instanceof SymphonyError) || error.code !== "invalid_request") throw error;
      }
    }
    yield { type: "completed" };
  }
}

class ReportingHarness implements AgentHarness {
  readonly id = "reporting";
  readonly prompts: string[] = [];

  constructor(
    private readonly lifecycleStore: FileIssueLifecycleStore,
    private readonly outboxStore: FileWritebackOutboxStore,
    private readonly runStore: FileRunTranscriptStore,
    private readonly publisher: CompletionReportPullRequestPublisher,
    private readonly terminalEvent: ReportingHarnessTerminal = { type: "completed" },
    private readonly operatorApproval?: OperatorApprovalService,
    private readonly writebackProcessor?: Pick<WritebackProcessor, "processDue">,
  ) {}

  async *run(ctx: AgentRunContext, prompt: string): AsyncIterable<AgentEvent> {
    this.prompts.push(prompt);
    yield { type: "session_started", sessionId: "report-session-1", runId: "report-run-1" };
    try {
      await new CompletionReportService({
        config: ctx.config,
        lifecycleStore: this.lifecycleStore,
        writebackOutbox: this.outboxStore,
        ...(this.writebackProcessor ? { writebackProcessor: this.writebackProcessor } : {}),
        runStore: this.runStore,
        pullRequestPublisher: this.publisher,
        ...(this.operatorApproval ? { operatorApproval: this.operatorApproval } : {}),
      }).submitCompletionReport(
        {
          runId: "report-run-1",
          issueId: ctx.issue.id,
          summary: "Implemented the requested handoff.",
          validationEvidence: ["npm test"],
          acceptanceChecklist: [
            {
              text: "Completion report handoff is live.",
              satisfied: true,
              evidence: "Orchestrator test",
            },
          ],
          changedFiles: ["src/core/orchestrator/Orchestrator.ts"],
          branchName: ctx.workspace.gitBranchName ?? ctx.issue.branchName,
          pullRequest: null,
          risks: [],
          idempotencyKey: "idem-1",
        },
        {
          issue: ctx.issue,
          activeRunId: "report-run-1",
          role: "worker",
          sessionId: "report-session-1",
          workspacePath: ctx.workspace.path,
          workspace: ctx.workspace,
          phase: "implementation",
        },
      );
    } catch (error) {
      if (this.terminalEvent !== "throw") {
        yield this.terminalEvent;
        return;
      }
      yield { type: "failed", error: error instanceof Error ? error.message : String(error) };
      return;
    }
    if (this.terminalEvent === "throw") {
      throw new Error("post-handoff harness throw");
    }
    yield this.terminalEvent;
  }
}

class ManufacturedReviewLoopHarness implements AgentHarness {
  readonly id = "manufactured-review-loop";
  readonly runs: Array<{ role: string; runId: string; prompt: string }> = [];

  constructor(
    private readonly lifecycleStore: FileIssueLifecycleStore,
    private readonly outboxStore: FileWritebackOutboxStore,
    private readonly runStore: FileRunTranscriptStore,
  ) {}

  async *run(ctx: AgentRunContext, prompt: string): AsyncIterable<AgentEvent> {
    const roleRunNumber = this.runs.filter((run) => run.role === ctx.role).length + 1;
    const runId = ctx.role === "reviewer" ? `smoke-review-run-${roleRunNumber}` : `smoke-worker-run-${roleRunNumber}`;
    this.runs.push({ role: ctx.role, runId, prompt });
    yield { type: "session_started", sessionId: `${runId}-session`, runId };

    if (ctx.role === "reviewer") {
      await this.submitReviewVerdict(ctx, runId, roleRunNumber);
    } else {
      await this.submitCompletionReport(ctx, runId, roleRunNumber);
    }

    yield { type: "progress", message: `${ctx.role} submitted manufactured review-loop evidence.` };
    yield { type: "completed" };
  }

  private async submitCompletionReport(ctx: AgentRunContext, runId: string, runNumber: number): Promise<void> {
    await new CompletionReportService({
      config: ctx.config,
      lifecycleStore: this.lifecycleStore,
      writebackOutbox: this.outboxStore,
      runStore: this.runStore,
    }).submitCompletionReport(
      {
        runId,
        issueId: ctx.issue.id,
        summary:
          runNumber === 1
            ? "Submitted the manufactured smoke implementation."
            : "Addressed the manufactured smoke revision.",
        validationEvidence: ["npm test -- tests/orchestrator.test.ts"],
        acceptanceChecklist: [
          {
            text: "Manufactured fail/revise/pass smoke is covered.",
            satisfied: true,
            evidence: runNumber === 1 ? "Initial manufactured implementation." : "Revision worker handled reviewer feedback.",
          },
        ],
        changedFiles: ["tests/orchestrator.test.ts"],
        branchName: ctx.workspace.gitBranchName ?? ctx.issue.branchName,
        pullRequest: {
          url: "https://github.com/acme/symphony/pull/42",
          number: 42,
          headSha: "abc123",
          branch: ctx.workspace.gitBranchName ?? ctx.issue.branchName,
        },
        risks: [],
        idempotencyKey: `smoke-report-${runNumber}`,
      },
      {
        issue: ctx.issue,
        activeRunId: runId,
        role: "worker",
        sessionId: `${runId}-session`,
        workspacePath: ctx.workspace.path,
        workspace: ctx.workspace,
        phase: "implementation",
      },
    );
  }

  private async submitReviewVerdict(ctx: AgentRunContext, runId: string, runNumber: number): Promise<void> {
    if (runNumber > 1) {
      await appendApprovalFeedback(this.lifecycleStore, ctx.issue, runId);
    }
    await new ReviewVerdictService({
      config: ctx.config,
      lifecycleStore: this.lifecycleStore,
      writebackOutbox: this.outboxStore,
      runStore: this.runStore,
    }).submitReviewVerdict(
      runNumber === 1
        ? {
            runId,
            issueId: ctx.issue.id,
            verdict: "fail",
            acceptanceResults: [
              {
                text: "Revision worker handles the manufactured reviewer feedback.",
                satisfied: false,
                evidence: "First worker intentionally leaves the manufactured revision outstanding.",
              },
            ],
            findings: ["Add the manufactured smoke revision."],
            evidence: ["manufactured-review-loop-smoke"],
            idempotencyKey: "smoke-verdict-fail",
          }
        : {
            runId,
            issueId: ctx.issue.id,
            verdict: "pass",
            acceptanceResults: [
              {
                text: "Revision worker handles the manufactured reviewer feedback.",
                satisfied: true,
                evidence: "Second worker prompt included and addressed the manufactured revision.",
              },
            ],
            findings: [],
            evidence: ["manufactured-review-loop-smoke"],
            idempotencyKey: "smoke-verdict-pass",
          },
      {
        issue: ctx.issue,
        activeRunId: runId,
        role: "reviewer",
        reviewer: "reviewer-agent",
        phase: "review",
      },
    );
  }
}

class ReviewVerdictSubmittingHarness implements AgentHarness {
  readonly id = "review-verdict-submitting";
  readonly runs: Array<{ role: string; runId: string }> = [];

  constructor(
    private readonly verdict: "fail" | "pass",
    private readonly lifecycleStore: FileIssueLifecycleStore,
    private readonly outboxStore: FileWritebackOutboxStore,
  ) {}

  async *run(ctx: AgentRunContext): AsyncIterable<AgentEvent> {
    const runId = "review-run-1";
    this.runs.push({ role: ctx.role, runId });
    yield { type: "session_started", sessionId: "review-session-1", runId };
    if (this.verdict === "pass") {
      await appendApprovalFeedback(this.lifecycleStore, ctx.issue, runId);
    }
    await new ReviewVerdictService({
      config: ctx.config,
      lifecycleStore: this.lifecycleStore,
      writebackOutbox: this.outboxStore,
    }).submitReviewVerdict(
      this.verdict === "fail"
        ? {
            runId,
            issueId: ctx.issue.id,
            verdict: "fail",
            acceptanceResults: [
              {
                text: "Reviewer verdict submissions are wired through the reviewer harness.",
                satisfied: false,
                evidence: "Reviewer MCP path was missing.",
              },
            ],
            findings: ["Add reviewer MCP integration."],
            evidence: ["https://github.com/acme/symphony/pull/42#pullrequestreview-1"],
            idempotencyKey: "review-verdict-fail-1",
          }
        : {
            runId,
            issueId: ctx.issue.id,
            verdict: "pass",
            acceptanceResults: [
              {
                text: "Reviewer verdict submissions are wired through the reviewer harness.",
                satisfied: true,
                evidence: "Reviewer MCP path is present.",
              },
            ],
            findings: [],
            evidence: ["https://github.com/acme/symphony/pull/42#pullrequestreview-2"],
            idempotencyKey: "review-verdict-pass-1",
          },
      {
        issue: ctx.issue,
        activeRunId: runId,
        role: "reviewer",
        reviewer: "reviewer-agent",
        phase: "review",
      },
    );
    yield { type: "completed" };
  }
}

class MissingReviewVerdictThenRepairHarness implements AgentHarness {
  readonly id = "hermes";
  readonly capabilities = { continuation: true, mcpHandoff: true };
  readonly runs: Array<{ ctx: AgentRunContext; prompt: string; runId: string }> = [];

  constructor(
    private readonly lifecycleStore: FileIssueLifecycleStore,
    private readonly outboxStore: FileWritebackOutboxStore,
    private readonly runStore: FileRunTranscriptStore,
    private readonly options: { submitRepairVerdict?: boolean; writeSourceResumeMetadata?: boolean } = {},
  ) {}

  async *run(ctx: AgentRunContext, prompt: string): AsyncIterable<AgentEvent> {
    const isRepair = ctx.handoffRepair?.kind === "review_verdict";
    const runId = isRepair ? "review-repair-run-1" : "review-source-run-1";
    this.runs.push({ ctx, prompt, runId });
    yield { type: "session_started", sessionId: `${runId}-session`, runId };
    if (isRepair || this.options.writeSourceResumeMetadata !== false) {
      await this.runStore.updateRun(runId, {
        metadata: {
          hermesProfileKey: "review-source-profile",
          hermesProfileDir: path.join(ctx.config.hermes.stateDir, "profiles", "review-source-profile"),
          hermesSessionKey: isRepair ? "review-repair-session-key" : "review-source-session-key",
          hermesResumeSourceRunId: ctx.hermesResume?.sourceRunId ?? null,
          hermesResumeReason: ctx.hermesResume?.reason ?? null,
          handoffRepairSourceRunId: ctx.handoffRepair?.sourceRunId ?? null,
          handoffRepairKind: ctx.handoffRepair?.kind ?? null,
          handoffRepairAttempt: ctx.handoffRepair?.attempt ?? null,
        },
      });
    }
    if (isRepair && this.options.submitRepairVerdict !== false) {
      await new ReviewVerdictService({
        config: ctx.config,
        lifecycleStore: this.lifecycleStore,
        writebackOutbox: this.outboxStore,
        runStore: this.runStore,
      }).submitReviewVerdict(
        {
          runId,
          issueId: ctx.issue.id,
          verdict: "fail",
          acceptanceResults: [
            {
              text: "Reviewer handoff repair submits the missing verdict.",
              satisfied: false,
              evidence: "Repair run resumed the reviewer session and submitted this verdict.",
            },
          ],
          findings: ["Repair path submitted the previously missing verdict."],
          evidence: ["handoff repair test"],
          idempotencyKey: "review-repair-verdict",
        },
        {
          issue: ctx.issue,
          activeRunId: runId,
          role: "reviewer",
          reviewer: `${runId}-session`,
          phase: "review",
        },
      );
    }
    yield { type: "completed" };
  }
}

class ContextRecordingHermesHarness implements AgentHarness {
  readonly id = "hermes";
  readonly capabilities = { continuation: true, mcpHandoff: true };
  readonly runs: Array<{ ctx: AgentRunContext; prompt: string }> = [];

  async *run(ctx: AgentRunContext, prompt: string): AsyncIterable<AgentEvent> {
    this.runs.push({ ctx, prompt });
    yield { type: "session_started", sessionId: `context-session-${this.runs.length}`, runId: `context-run-${this.runs.length}` };
    yield { type: "completed" };
  }
}

class BlockingRecordingHarness implements AgentHarness {
  readonly id = "blocking";
  readonly capabilities = { continuation: true, mcpHandoff: true };
  readonly runs: AgentRunContext[] = [];

  async *run(ctx: AgentRunContext): AsyncIterable<AgentEvent> {
    this.runs.push(ctx);
    yield { type: "session_started", sessionId: `blocking-session-${this.runs.length}`, runId: `blocking-run-${this.runs.length}` };
    if (!ctx.abortSignal.aborted) {
      await new Promise<void>((resolve) => ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true }));
    }
    yield { type: "completed" };
  }
}

class FakeOperatorChatHarness implements AgentHarness {
  readonly id = "fake-operator";
  readonly operatorContexts: OperatorChatRunContext[] = [];

  constructor(private readonly events: AgentEvent[]) {}

  async *run(_ctx: AgentRunContext, _prompt: string): AsyncIterable<AgentEvent> {
    throw new Error("issue run is not implemented by FakeOperatorChatHarness");
  }

  async *runOperatorChat(ctx: OperatorChatRunContext, _prompt: string): AsyncIterable<AgentEvent> {
    this.operatorContexts.push(ctx);
    for (const event of this.events) yield event;
  }
}

function idleTracker(): TrackerClient {
  return {
    async fetchCandidateIssues() {
      return [];
    },
    async fetchIssuesByStates(states) {
      return issuesInStates([], states);
    },
    async fetchIssueStatesByIds() {
      return [];
    },
  };
}

async function eventually(assertion: () => Promise<void> | void, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  if (lastError) throw lastError;
}

class FakeCompletionReportPublisher implements CompletionReportPullRequestPublisher {
  readonly inputs: CompletionReportPullRequestPublicationInput[] = [];

  constructor(private readonly publication: CompletionReportPullRequestPublication) {}

  async publishPullRequest(
    input: CompletionReportPullRequestPublicationInput,
  ): Promise<CompletionReportPullRequestPublication> {
    this.inputs.push(input);
    return this.publication;
  }
}

class FakePullRequestDiscoveryClient implements PullRequestDiscoveryClient {
  readonly branches: string[] = [];

  constructor(
    private readonly pullRequest: {
      url: string;
      number: number;
      headBranch: string;
      headSha: string | null;
      lastPushedAt: string | null;
    } | null,
  ) {}

  async findOpenPullRequestByBranch(input: { branchName: string }) {
    this.branches.push(input.branchName);
    return this.pullRequest;
  }
}

class FakePullRequestReviewEvidenceClient implements PullRequestReviewEvidenceClient {
  readonly calls: number[] = [];

  constructor(private readonly evidence: RemotePullRequestReviewEvidence[]) {}

  async listPullRequestReviewEvidence(input: { pullRequestNumber: number }): Promise<RemotePullRequestReviewEvidence[]> {
    this.calls.push(input.pullRequestNumber);
    return this.evidence.filter((item) => item.pullRequestNumber === input.pullRequestNumber);
  }
}

class StateChangingWriter implements TrackerWriter {
  readonly transitions: TrackerTransitionInput[] = [];
  readonly comments: TrackerCommentInput[] = [];
  readonly issueCreates: TrackerIssueCreateInput[] = [];
  readonly issueRelations: TrackerIssueRelationInput[] = [];

  constructor(private readonly setState: (state: string) => void) {}

  async transitionIssueState(input: TrackerTransitionInput): Promise<TrackerWriteResult> {
    this.transitions.push(input);
    this.setState(input.toState);
    return { status: "applied" };
  }

  async createIssueComment(input: TrackerCommentInput): Promise<TrackerWriteResult> {
    this.comments.push(input);
    return { status: "applied" };
  }

  async createIssueFromPlan(input: TrackerIssueCreateInput): Promise<TrackerWriteResult> {
    this.issueCreates.push(input);
    const childNumber = (input.proposedIssueIndex ?? this.issueCreates.length - 1) + 1;
    return {
      status: "applied",
      evidence: {
        kind: "issue_create",
        issue: { id: `child-${childNumber}`, identifier: `TEST-${childNumber + 1}`, url: `https://linear.test/TEST-${childNumber + 1}` },
        issueCreateStatus: "created",
        parentIssueId: input.parentIssueId,
        dedupeKey: input.dedupeKey,
        payloadHash: input.payloadHash,
        unresolvedLabelNames: [],
      },
    };
  }

  async createIssueRelation(input: TrackerIssueRelationInput): Promise<TrackerWriteResult> {
    this.issueRelations.push(input);
    return { status: "applied" };
  }
}

class FailingWriter implements TrackerWriter {
  readonly transitions: TrackerTransitionInput[] = [];
  readonly comments: TrackerCommentInput[] = [];

  async transitionIssueState(_input: TrackerTransitionInput): Promise<TrackerWriteResult> {
    throw new Error("linear transition failed");
  }

  async createIssueComment(_input: TrackerCommentInput): Promise<TrackerWriteResult> {
    throw new Error("linear comment failed");
  }
}

class PublicationApprovalCommentFailingWriter extends StateChangingWriter {
  async createIssueComment(input: TrackerCommentInput): Promise<TrackerWriteResult> {
    if (input.dedupeKey?.includes("publication-approval-pending")) {
      throw new Error("linear pending approval comment failed");
    }
    return super.createIssueComment(input);
  }
}

class PublicationApprovalTransitionFailingWriter extends StateChangingWriter {
  async transitionIssueState(input: TrackerTransitionInput): Promise<TrackerWriteResult> {
    if (
      input.toState === "Blocked" &&
      (input.reason?.includes("operator approval for PR publication") ||
        input.reason?.includes("publication approval setup incomplete"))
    ) {
      throw new Error("linear pending approval transition failed");
    }
    return super.transitionIssueState(input);
  }
}

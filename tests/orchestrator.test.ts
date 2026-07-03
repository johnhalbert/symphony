import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import {
  FileOperatorApprovalStore,
  OPERATOR_REJECTED_PUBLICATION_ERROR,
  OperatorApprovalService,
  type OperatorApprovalRecord,
} from "../src/core/approval/OperatorApprovalService.js";
import { parseServiceConfig } from "../src/core/config/Config.js";
import {
  LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
  LEGACY_DEFAULT_PROJECT_CONTEXT_LABEL,
  LEGACY_DEFAULT_PROJECT_CONTEXT_ROUTING_SOURCE,
} from "../src/core/config/ProjectContexts.js";
import { ReviewVerdictService } from "../src/core/ReviewVerdictService.js";
import { SymphonyError } from "../src/core/errors.js";
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
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import type { MergePolicyGitHubClient } from "../src/core/merge/MergePolicyService.js";
import { Orchestrator, sortIssuesForDispatch, type PullRequestDiscoveryClient } from "../src/core/orchestrator/Orchestrator.js";
import {
  FileIssueLifecycleStore,
  type IssueCompletionReportRecord,
  type IssueBreakdownCreatedIssueRef,
  type IssueBreakdownPlanRecord,
  type IssueLifecyclePatch,
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
  writebackIdentityKey,
} from "../src/core/writeback/WritebackOutbox.js";
import type { NewWritebackOperation } from "../src/core/writeback/WritebackOutbox.js";
import { WorkspaceManager } from "../src/core/workspace/WorkspaceManager.js";
import type { Issue, TokenCounts, TrackerStateLists } from "../src/core/types.js";
import type { PullRequestCheckResult } from "../src/integrations/github/GitHubPullRequestClient.js";
import { agentEligibleIssueContract, issue, testConfig, trackerClientFixture, trackerIssue } from "./helpers.js";

type IssueCreateWriteback = Extract<NewWritebackOperation, { kind: "issue_create" }>;
type IssueRelationWriteback = Extract<NewWritebackOperation, { kind: "issue_relation" }>;
type CommentWriteback = Extract<NewWritebackOperation, { kind: "comment" }>;

const docsProjectContext = {
  projectContextId: "docs",
  projectContextLabel: "Documentation Site",
  linearProjectSlug: "DOCS",
  routingSource: "candidate_poll",
} as const;

const legacyDefaultProjectContext = {
  projectContextId: LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
  projectContextLabel: LEGACY_DEFAULT_PROJECT_CONTEXT_LABEL,
  linearProjectSlug: "TEST",
  routingSource: LEGACY_DEFAULT_PROJECT_CONTEXT_ROUTING_SOURCE,
} as const;


function addDocsPollingProjectContext(config: ReturnType<typeof testConfig>): void {
  if (config.projectContexts.byId.has(docsProjectContext.projectContextId)) return;

  const defaultContext = config.projectContexts.defaultContext;
  const docsContext = {
    ...defaultContext,
    id: docsProjectContext.projectContextId,
    label: docsProjectContext.projectContextLabel,
    source: "explicit" as const,
    tracker: {
      ...defaultContext.tracker,
      projectSlug: docsProjectContext.linearProjectSlug,
    },
    reviewLoop: {
      ...config.reviewLoop,
    },
    issueBreakdown: {
      ...config.issueBreakdown,
    },
    agent: {
      ...config.agent,
    },
    publicMetadata: {
      ...defaultContext.publicMetadata,
      id: docsProjectContext.projectContextId,
      label: docsProjectContext.projectContextLabel,
      linearProjectSlug: docsProjectContext.linearProjectSlug,
    },
    publicSummary: {
      ...defaultContext.publicSummary,
      id: docsProjectContext.projectContextId,
      label: docsProjectContext.projectContextLabel,
      tracker: {
        ...defaultContext.publicSummary.tracker,
        projectSlug: docsProjectContext.linearProjectSlug,
      },
      publicMetadata: {
        ...defaultContext.publicSummary.publicMetadata,
        id: docsProjectContext.projectContextId,
        label: docsProjectContext.projectContextLabel,
        linearProjectSlug: docsProjectContext.linearProjectSlug,
      },
    },
  };

  config.projectContexts.contexts = [...config.projectContexts.contexts, docsContext];
  config.projectContexts.enabledContexts = [...config.projectContexts.enabledContexts, docsContext];
  (config.projectContexts.byId as unknown as Map<string, typeof docsContext>).set(docsContext.id, docsContext);
}

function addSymphonyPollingProjectContext(config: ReturnType<typeof testConfig>): void {
  if (config.projectContexts.byId.has(symphonyProjectContext.projectContextId)) return;

  const defaultContext = config.projectContexts.defaultContext;
  const symphonyContext = {
    ...defaultContext,
    id: symphonyProjectContext.projectContextId,
    label: symphonyProjectContext.projectContextLabel,
    source: "explicit" as const,
    tracker: {
      ...defaultContext.tracker,
      projectSlug: symphonyProjectContext.linearProjectSlug,
    },
    reviewLoop: {
      ...config.reviewLoop,
    },
    issueBreakdown: {
      ...config.issueBreakdown,
    },
    agent: {
      ...config.agent,
    },
    publicMetadata: {
      ...defaultContext.publicMetadata,
      id: symphonyProjectContext.projectContextId,
      label: symphonyProjectContext.projectContextLabel,
      linearProjectSlug: symphonyProjectContext.linearProjectSlug,
    },
    publicSummary: {
      ...defaultContext.publicSummary,
      id: symphonyProjectContext.projectContextId,
      label: symphonyProjectContext.projectContextLabel,
      tracker: {
        ...defaultContext.publicSummary.tracker,
        projectSlug: symphonyProjectContext.linearProjectSlug,
      },
      publicMetadata: {
        ...defaultContext.publicSummary.publicMetadata,
        id: symphonyProjectContext.projectContextId,
        label: symphonyProjectContext.projectContextLabel,
        linearProjectSlug: symphonyProjectContext.linearProjectSlug,
      },
    },
  };

  config.projectContexts.contexts = [...config.projectContexts.contexts, symphonyContext];
  config.projectContexts.enabledContexts = [...config.projectContexts.enabledContexts, symphonyContext];
  (config.projectContexts.byId as unknown as Map<string, typeof symphonyContext>).set(symphonyContext.id, symphonyContext);
}

function requireDocsPollingContext(config: ReturnType<typeof testConfig>) {
  const docsContext = config.projectContexts.byId.get(docsProjectContext.projectContextId);
  expect(docsContext).toBeDefined();
  if (!docsContext) throw new Error("Expected docs project context in orchestrator test fixture");
  return docsContext;
}

describe("Orchestrator", () => {
  let root: string;

const symphonyProjectContext = {
  projectContextId: "symphony",
  projectContextLabel: "Symphony",
  linearProjectSlug: "TEST",
  routingSource: "candidate_poll",
} as const;

const docsProjectContext = {
  projectContextId: "docs",
  projectContextLabel: "Documentation Site",
  linearProjectSlug: "DOCS",
  routingSource: "candidate_poll",
} as const;


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

  it("dispatches eligible work through the harness", async () => {
    const config = testConfig(root);
    const candidate = issue({ state: "Todo" });
    let active = true;
    let refreshes = 0;
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return active ? [candidate] : [];
      },
      async fetchIssuesByStates() {
        return [];
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

    expect(harness.runs[0]?.prompt).toContain("Work on TEST-1");
    expect(harness.runs[0]?.prompt).toContain("Review-cycle hardening:");
    expect(harness.runs[0]?.prompt).toContain("address the underlying invariant");
    expect(harness.runs[0]?.prompt).toContain("derive a conservative checklist");
    expect(harness.runs[0]?.prompt).toContain("issue-authoring gap");
    expect(harness.runs[0]?.prompt).not.toContain("Compact Symphony handoff packet:");
    expect(harness.runs[0]?.ctx.role).toBe("worker");
    expect(orchestrator.snapshot().counts.running).toBe(0);
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
    expect(await runStore.rebuildRunFromTranscript("operator-run-1")).toMatchObject({
      runId: "operator-run-1",
      status: "succeeded",
      runPhase: "issue_breakdown",
      runKind: "planning",
    });
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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
    expect(harness.runs[0]?.prompt).toContain("Plan TEST-1");
    expect(harness.runs[0]?.prompt).toContain("submit_issue_breakdown_plan");
    expect(harness.runs[1]?.ctx.runPhase).toBe("implementation");
    expect(harness.runs.filter((run) => run.ctx.runPhase === "issue_breakdown")).toHaveLength(1);
    expect(harness.runs[1]?.prompt).toContain("Work on TEST-1");
    expect(harness.runs[1]?.prompt).toContain("Issue breakdown plan:");
    expect(harness.runs[1]?.prompt).toContain("Create implementation task");
    await expect(runStore.latestRunForIssue(candidate.id, { role: "worker", runPhase: "issue_breakdown" })).resolves.toMatchObject({
      runPhase: "issue_breakdown",
      runKind: "planning",
    });
    await expect(runStore.latestRunForIssue(candidate.id, { role: "worker", runPhase: "implementation" })).resolves.toMatchObject({
      runPhase: "implementation",
      runKind: "implementation",
    });
  }, 10_000);

  it("injects exact issue-id breakdown-plan status pointers into implementation prompts for context-scoped issues", async () => {
    const config = testConfig(root);
    config.issueBreakdown.enabled = true;
    config.issueBreakdown.promptTemplate = "Plan {{ issue.identifier }}";
    config.issueBreakdown.planningLabels = ["planning"];
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    addDocsPollingProjectContext(config);
    const candidate = trackerIssue({
      id: "issue-docs-1",
      identifier: "ENG-123",
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      linearProjectSlug: "DOCS",
      state: "Todo",
      labels: ["planning"],
      updatedAt: "2026-01-02T00:00:00Z",
    });
    let currentState = candidate.state;
    let updatedAt = candidate.updatedAt;
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [{ ...candidate, state: currentState, updatedAt }];
      },
      async fetchIssuesByStates() {
        return [];
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
      "persisted context-scoped issue breakdown plan",
    );
    await settleOrchestratorExit();
    await waitForAsync(async () => {
      await orchestrator.refreshNow();
      return harness.runs.length === 2;
    }, "context-scoped implementation dispatch after accepted plan", 5_000);
    await waitFor(() => orchestrator.snapshot().counts.running === 0);
    await orchestrator.stop();

    const expectedStatusApiPointers = [
      "/api/v1/issues/issue-docs-1",
      "/api/v1/issues/issue-docs-1/runs",
      "/api/v1/runs/issue_breakdown-run-1",
    ];
    const lifecycle = await lifecycleStore.get(candidate.id);

    expect(harness.runs[1]?.ctx.runPhase).toBe("implementation");
    expect(harness.runs[1]?.prompt).toContain("Issue breakdown plan:");
    expect(harness.runs[1]?.prompt).toContain("/api/v1/issues/issue-docs-1");
    expect(harness.runs[1]?.prompt).toContain("/api/v1/issues/issue-docs-1/runs");
    expect(harness.runs[1]?.prompt).toContain("/api/v1/runs/issue_breakdown-run-1");
    expect(harness.runs[1]?.prompt).not.toContain("/api/v1/issues/ENG-123");
    expect(lifecycle?.issueBreakdownPlans[0]?.statusApiPointers).toEqual(expectedStatusApiPointers);
    expect(lifecycle?.summaryReferences[0]?.statusApiPointers).toEqual(expectedStatusApiPointers);
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
      async fetchIssuesByStates() {
        return [];
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

  it("uses resolved project-context issue breakdown planning config during automatic polling", async () => {
    const config = testConfig(root);
    config.issueBreakdown.enabled = false;
    config.issueBreakdown.promptTemplate = "Default planning prompt for {{ issue.identifier }}";
    config.issueBreakdown.planningLabels = ["planning"];
    addDocsPollingProjectContext(config);
    const docsContext = requireDocsPollingContext(config);
    docsContext.issueBreakdown.enabled = true;
    docsContext.issueBreakdown.planningLabels = ["docs-planning"];
    docsContext.issueBreakdown.promptTemplate = "Docs planning prompt for {{ issue.identifier }}";
    docsContext.issueBreakdown.cursorMode = "plan";
    const candidate = trackerIssue({
      id: "issue-docs-plan-routing-1",
      identifier: "DOCS-PLAN-1",
      state: "Todo",
      labels: ["docs-planning"],
      projectContextId: docsProjectContext.projectContextId,
      projectContextLabel: docsProjectContext.projectContextLabel,
      linearProjectSlug: docsProjectContext.linearProjectSlug,
    });
    const defaultTracker = trackerClientFixture();
    const docsTracker = trackerClientFixture({
      candidates: [candidate],
      issues: [candidate],
    });
    const logger = new StructuredLogger(() => undefined);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const harness = new IssueBreakdownAcceptingHarness(lifecycleStore);
    const orchestrator = new Orchestrator({
      config,
      tracker: defaultTracker,
      trackerResolver(projectContext) {
        return projectContext?.projectContextId === docsProjectContext.projectContextId ? docsTracker : defaultTracker;
      },
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

    expect(defaultTracker.candidateFetchCount).toBe(1);
    expect(docsTracker.candidateFetchCount).toBe(1);
    expect(defaultTracker.requestedIds).toEqual([]);
    expect(docsTracker.requestedIds.length).toBeGreaterThanOrEqual(1);
    expect(docsTracker.requestedIds.every((issueIds) => issueIds.length === 1 && issueIds[0] === candidate.id)).toBe(true);
    expect(harness.runs).toHaveLength(1);
    expect(harness.runs[0]?.ctx.runPhase).toBe("issue_breakdown");
    expect(harness.runs[0]?.ctx.projectContext).toMatchObject(docsProjectContext);
    expect(harness.runs[0]?.ctx.config.issueBreakdown.enabled).toBe(true);
    expect(harness.runs[0]?.ctx.config.issueBreakdown.planningLabels).toEqual(["docs-planning"]);
    expect(harness.runs[0]?.ctx.runModeOverride).toBe("plan");
    expect(harness.runs[0]?.prompt).toContain("Docs planning prompt for DOCS-PLAN-1");
    await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
      projectContext: docsProjectContext,
    });
  }, 10_000);

  it("uses resolved project-context fresh-plan and apply-to-linear config during automatic polling", async () => {
    const config = testConfig(root);
    config.issueBreakdown.enabled = true;
    config.issueBreakdown.applyToLinear.enabled = true;
    config.issueBreakdown.promptTemplate = "Default planning prompt for {{ issue.identifier }}";
    config.issueBreakdown.planningLabels = ["planning"];
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    addDocsPollingProjectContext(config);
    const docsContext = requireDocsPollingContext(config);
    docsContext.issueBreakdown.enabled = true;
    docsContext.issueBreakdown.applyToLinear.enabled = false;
    docsContext.issueBreakdown.planningLabels = ["docs-planning"];
    docsContext.issueBreakdown.promptTemplate = "Docs planning prompt for {{ issue.identifier }}";
    docsContext.issueBreakdown.cursorMode = "plan";
    const candidate = trackerIssue({
      id: "issue-docs-plan-routing-2",
      identifier: "DOCS-PLAN-2",
      state: "Todo",
      labels: ["docs-planning"],
      updatedAt: "2026-01-02T00:00:00Z",
      projectContextId: docsProjectContext.projectContextId,
      projectContextLabel: docsProjectContext.projectContextLabel,
      linearProjectSlug: docsProjectContext.linearProjectSlug,
    });
    let currentState = "Todo";
    let updatedAt = "2026-01-02T00:00:00Z";
    const defaultTracker = trackerClientFixture();
    const docsTrackerStats = {
      candidateFetchCount: 0,
      requestedIds: [] as string[][],
    };
    const docsTracker: TrackerClient = {
      async fetchCandidateIssues() {
        docsTrackerStats.candidateFetchCount += 1;
        return [{ ...candidate, state: currentState, updatedAt }];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds(issueIds) {
        docsTrackerStats.requestedIds.push([...issueIds]);
        return issueIds.includes(candidate.id) ? [{ ...candidate, state: currentState, updatedAt }] : [];
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
      tracker: defaultTracker,
      trackerResolver(projectContext) {
        return projectContext?.projectContextId === docsProjectContext.projectContextId ? docsTracker : defaultTracker;
      },
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
      "persisted docs issue breakdown plan",
    );
    await settleOrchestratorExit();
    await waitForAsync(async () => {
      await orchestrator.refreshNow();
      return harness.runs.length === 2;
    }, "docs implementation dispatch after accepted plan", 5_000);
    await waitFor(() => orchestrator.snapshot().counts.running === 0);
    await settleOrchestratorExit();
    await orchestrator.stop();

    expect(defaultTracker.requestedIds).toEqual([]);
    expect(docsTrackerStats.candidateFetchCount).toBeGreaterThanOrEqual(2);
    expect(docsTrackerStats.requestedIds.length).toBeGreaterThanOrEqual(2);
    expect(docsTrackerStats.requestedIds.every((issueIds) => issueIds.length === 1 && issueIds[0] === candidate.id)).toBe(true);
    expect(writer.transitions.map((transition) => transition.toState)).toEqual(["In Progress"]);
    expect(writer.issueCreates).toEqual([]);
    expect(harness.runs.map((run) => run.ctx.runPhase)).toEqual(["issue_breakdown", "implementation"]);
    expect(harness.runs[0]?.ctx.config.issueBreakdown.planningLabels).toEqual(["docs-planning"]);
    expect(harness.runs[0]?.prompt).toContain("Docs planning prompt for DOCS-PLAN-2");
    expect(harness.runs[1]?.ctx.projectContext).toMatchObject(docsProjectContext);
    expect(harness.runs[1]?.ctx.config.issueBreakdown.applyToLinear.enabled).toBe(false);
    expect(harness.runs[1]?.prompt).toContain("Issue breakdown plan:");
    expect(harness.runs[1]?.prompt).toContain("Create implementation task");
    await expect(runStore.latestRunForIssue(candidate.id, { role: "worker", runPhase: "issue_breakdown" })).resolves.toMatchObject({
      runPhase: "issue_breakdown",
      runKind: "planning",
      projectContext: docsProjectContext,
    });
    await expect(runStore.latestRunForIssue(candidate.id, { role: "worker", runPhase: "implementation" })).resolves.toMatchObject({
      runPhase: "implementation",
      runKind: "implementation",
      projectContext: docsProjectContext,
    });
    await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
      projectContext: docsProjectContext,
      issueBreakdownPlans: [
        expect.objectContaining({
          applicationStatus: "not_requested",
        }),
      ],
    });
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

  it("reroutes implementation dispatch to planning when writeback reveals stale issue content", async () => {
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
      async fetchIssuesByStates() {
        return [];
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
            (run) => run.issueId === candidate.id && run.role === "worker" && run.runPhase === "issue_breakdown",
          ),
      "stale post-writeback planning reroute dispatch",
      10_000,
    );
    await waitFor(() => harness.runs.length === 2, "stale post-writeback planning harness run", 10_000);
    await waitFor(() => orchestrator.snapshot().counts.running === 0, "stale post-writeback planning completion", 10_000);
    await orchestrator.stop();

    const lifecycle = await lifecycleStore.get(candidate.id);
    expect(writer.transitions.map((transition) => transition.toState)).toEqual(["In Progress"]);
    expect(harness.runs[0]?.ctx.runPhase).toBe("issue_breakdown");
    expect(harness.runs[1]?.ctx.runPhase).toBe("issue_breakdown");
    expect(harness.runs.some((run) => run.ctx.runPhase === "implementation")).toBe(false);
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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

    expect(result).toMatchObject({
      queued: true,
      reason: "explicit_request",
      routeEvidence: {
        kind: "issue_breakdown",
        status: "resolved",
        lookupKey: candidate.id,
        sources: ["tracker_direct"],
        redacted: true,
      },
    });
    expect(harness.runs[0]?.ctx.runPhase).toBe("issue_breakdown");
  });

  it("fails closed for direct issue-breakdown lookups when the direct tracker hit resolves outside the requested project context", async () => {
    const config = testConfig(root);
    addDocsPollingProjectContext(config);
    config.issueBreakdown.enabled = true;
    config.issueBreakdown.planningLabels = ["planning"];
    const directRuntimeIssue = {
      ...issue({
        id: "linear-symphony-179",
        identifier: "ENG-179",
        state: "Todo",
        labels: ["planning"],
      }),
      linearProjectIdentity: {
        kind: "linear",
        slug: config.tracker.projectSlug,
        id: "linear-project-symphony",
      },
      routingSource: "tracker_direct",
    } as Issue;
    const requestedIds: string[][] = [];
    let candidateFetchCount = 0;
    const sharedTracker: TrackerClient = {
      async fetchCandidateIssues() {
        candidateFetchCount += 1;
        return [];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds(issueIds: string[]) {
        requestedIds.push([...issueIds]);
        return issueIds.includes(directRuntimeIssue.id) ? [structuredClone(directRuntimeIssue)] : [];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const orchestrator = new Orchestrator({
      config,
      tracker: sharedTracker,
      workspaceManager,
      harness: new FakeHarness(),
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
    });

    await expect(
      orchestrator.requestIssueBreakdown(directRuntimeIssue.id, { projectContext: docsProjectContext }),
    ).rejects.toMatchObject({
      code: "not_found",
      details: {
        routeEvidence: {
          kind: "issue_breakdown",
          status: "wrong_context",
          requestedProjectContextId: docsProjectContext.projectContextId,
          resolvedProjectContextId: config.projectContexts.defaultContextId,
          lookupKey: directRuntimeIssue.id,
          sources: ["tracker_direct", "tracker_candidate"],
          reason: "resolved_issue_outside_requested_project_context",
          redacted: true,
        },
      },
    });
    expect(requestedIds).toEqual([[directRuntimeIssue.id]]);
    expect(candidateFetchCount).toBe(1);
    await expect(
      runStore.latestRunForIssue(directRuntimeIssue.id, {
        role: "worker",
        runPhase: "issue_breakdown",
      }),
    ).resolves.toBeNull();
    await orchestrator.stop();
  });

  it("redacts orchestrator route evidence when issue breakdown tracker credentials are unavailable", async () => {
    const config = testConfig(root);
    addDocsPollingProjectContext(config);
    config.issueBreakdown.enabled = true;
    config.issueBreakdown.planningLabels = ["planning"];
    const rawCredentialMessage =
      "Linear credential capability linear.tracker is owned by worker, but is assigned only to service. Configure credential_profiles.roles.worker.linear.tracker or remove the non-owning assignment to use legacy tracker api key/LINEAR_API_KEY.";
    const tracker = trackerClientFixture({ candidates: [], issues: [] });
    const logger = new StructuredLogger(() => undefined);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const orchestrator = new Orchestrator({
      config,
      tracker,
      trackerResolver: (projectContext) => {
        if (projectContext?.projectContextId === docsProjectContext.projectContextId) {
          throw new SymphonyError("config_validation_error", rawCredentialMessage);
        }
        return tracker;
      },
      workspaceManager,
      harness: new IssueBreakdownAcceptingHarness(lifecycleStore),
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
    });

    let thrown: unknown = null;
    try {
      await orchestrator.requestIssueBreakdown("ENG-179", { projectContext: docsProjectContext });
    } catch (error) {
      thrown = error;
    } finally {
      await orchestrator.stop();
    }

    expect(thrown).toMatchObject({
      code: "not_found",
      details: {
        routeEvidence: {
          kind: "issue_breakdown",
          status: "credential_unavailable",
          requestedProjectContextId: "docs",
          resolvedProjectContextId: "docs",
          reason: "resolved_project_context_tracker_unavailable",
          redacted: true,
        },
      },
    });
    expect(JSON.stringify((thrown as { details?: unknown })?.details ?? null)).not.toContain(rawCredentialMessage);
    expect(JSON.stringify((thrown as { details?: unknown })?.details ?? null)).not.toContain("LINEAR_API_KEY");
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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
        async fetchIssuesByStates() {
          return [];
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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

  it("propagates non-default project context through dispatch harness, run records, and lifecycle state", async () => {
    const config = testConfig(root);
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.tracker.handoffStates = ["Human Review"];
    addDocsPollingProjectContext(config);
    const candidate = trackerIssue({
      id: "issue-1",
      identifier: "TEST-1",
      state: "Todo",
      labels: ["dogfood-ready"],
      projectContextId: docsProjectContext.projectContextId,
      projectContextLabel: docsProjectContext.projectContextLabel,
      linearProjectSlug: docsProjectContext.linearProjectSlug,
    });
    let currentState = "Todo";
    const defaultTracker = trackerClientFixture();
    const docsTracker = trackerClientFixture({
      candidates: [{ ...candidate, state: currentState }],
      issues: [{ ...candidate, state: currentState }],
    });
    const logger = new StructuredLogger(() => undefined);
    const writer = new StateChangingWriter((state) => {
      currentState = state;
    });
    const stateDir = path.join(root, "state");
    const writeback = new WritebackProcessor(new FileWritebackOutboxStore(stateDir), writer, logger, 300_000);
    const harness = new FakeHarness();
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const runStore = new FileRunTranscriptStore(stateDir);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker: defaultTracker,
      trackerResolver(projectContext) {
        return projectContext?.projectContextId === docsProjectContext.projectContextId ? docsTracker : defaultTracker;
      },
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

    expect(defaultTracker.candidateFetchCount).toBe(1);
    expect(docsTracker.candidateFetchCount).toBe(1);
    expect(defaultTracker.requestedIds).toEqual([]);
    expect(docsTracker.requestedIds.length).toBeGreaterThanOrEqual(2);
    expect(docsTracker.requestedIds.every((issueIds) => issueIds.length === 1 && issueIds[0] === candidate.id)).toBe(true);
    expect(harness.runs).toHaveLength(1);
    expect(harness.runs[0]?.ctx.projectContext).toMatchObject(docsProjectContext);
    expect(currentState).toBe("In Progress");
    expect(writer.transitions.map((transition) => transition.toState)).toEqual(["In Progress"]);
    expect(writer.comments[0]?.dedupeKey).toBe("fake-issue-1-1:run-started");
    await expect(runStore.getRun("fake-issue-1-1")).resolves.toMatchObject({
      projectContext: docsProjectContext,
    });
    await expect(lifecycleStore.get(candidate.identifier)).resolves.toMatchObject({
      incompleteTurnCount: 1,
      projectContext: docsProjectContext,
    });
    expect(orchestrator.snapshot().counts.retrying).toBe(0);
  });

  it("preserves an in-progress run's original project context and persisted routing snapshot across config reload", async () => {
    const config = testConfig(root);
    addDocsPollingProjectContext(config);
    const initialCandidate = {
      ...issue({
        id: "issue-docs-1",
        identifier: "ENG-123",
        title: "Docs work item",
        state: "Todo",
        branchName: "symphony/docs/ENG-123",
      }),
      linearProjectIdentity: {
        kind: "linear" as const,
        slug: docsProjectContext.linearProjectSlug,
        id: "linear-project-docs-1",
      },
      routingSource: "candidate_poll" as const,
      resolvedAt: "2026-01-01T00:00:00Z",
    };
    const reroutedCandidate = {
      ...issue({
        id: "issue-rerouted-1",
        identifier: "ENG-456",
        title: "Rerouted docs work item",
        state: "Todo",
        branchName: "symphony/default/ENG-456",
      }),
      linearProjectIdentity: {
        kind: "linear" as const,
        slug: docsProjectContext.linearProjectSlug,
        id: "linear-project-docs-2",
      },
      routingSource: "candidate_poll" as const,
      resolvedAt: "2026-01-01T00:00:00Z",
    };
    let includeReroutedCandidate = false;
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return includeReroutedCandidate ? [initialCandidate, reroutedCandidate] : [initialCandidate];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds(issueIds) {
        return [initialCandidate, ...(includeReroutedCandidate ? [reroutedCandidate] : [])].filter((candidate) =>
          issueIds.includes(candidate.id),
        );
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const harness: AgentHarness & {
      runs: Array<{ ctx: AgentRunContext; prompt: string }>;
      stoppedRunIds: string[];
    } = {
      id: "project-context-reload-blocking",
      capabilities: { continuation: true, mcpHandoff: true },
      runs: [],
      stoppedRunIds: [],
      async *run(ctx: AgentRunContext, prompt: string): AsyncIterable<AgentEvent> {
        this.runs.push({ ctx, prompt });
        const runId = `run-${ctx.issue.id}-${ctx.turnNumber}`;
        yield { type: "session_started", sessionId: `session-${ctx.issue.id}-${ctx.turnNumber}`, runId };
        if (!ctx.abortSignal.aborted) {
          await new Promise<void>((resolve) =>
            ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
        yield { type: "cancelled" };
      },
      async stop(runId: string): Promise<void> {
        this.stoppedRunIds.push(runId);
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
      lifecycleStore,
    });

    try {
      await orchestrator.refreshNow();
      await waitFor(() => harness.runs.length === 1, "initial docs dispatch");
      await waitFor(
        () => typeof orchestrator.snapshot().running.find((run) => run.issueId === initialCandidate.id)?.runId === "string",
        "initial docs run start",
      );

      const initialRunning = orchestrator.snapshot().running.find((run) => run.issueId === initialCandidate.id);
      const initialRunId = initialRunning?.runId ?? "";
      expect(initialRunning?.projectContext).toMatchObject(docsProjectContext);
      expect(initialRunning?.issueDetails).toMatchObject({
        projectContextId: docsProjectContext.projectContextId,
        linearProjectIdentity: {
          kind: "linear",
          slug: docsProjectContext.linearProjectSlug,
          id: "linear-project-docs-1",
        },
      });
      expect(harness.runs[0]?.ctx.projectContext).toMatchObject(docsProjectContext);
      await waitForRunRecord(runStore, initialRunId);
      await expect(runStore.getRun(initialRunId)).resolves.toMatchObject({
        projectContext: docsProjectContext,
      });
      await expect(lifecycleStore.get(initialCandidate.identifier)).resolves.toMatchObject({
        projectContext: docsProjectContext,
      });

      const reloadedConfig = testConfig(root);
      addDocsPollingProjectContext(reloadedConfig);
      reloadedConfig.projectContexts.defaultContext.tracker.projectSlug = docsProjectContext.linearProjectSlug;
      requireDocsPollingContext(reloadedConfig).tracker.projectSlug = "GUIDES";
      includeReroutedCandidate = true;

      orchestrator.updateConfig(reloadedConfig, "Reloaded work on {{ issue.identifier }}");
      await orchestrator.refreshNow();
      await waitFor(
        () => harness.runs.some((run) => run.ctx.issue.id === reroutedCandidate.id),
        "rerouted dispatch after config reload",
      );

      const runningAfterReload = orchestrator.snapshot().running;
      const preservedRun = runningAfterReload.find((run) => run.issueId === initialCandidate.id);
      const reroutedRun = harness.runs.find((run) => run.ctx.issue.id === reroutedCandidate.id);

      expect(preservedRun?.projectContext).toMatchObject(docsProjectContext);
      expect(preservedRun?.projectContext?.routingSource).toBe("candidate_poll");
      expect(preservedRun?.issueDetails).toMatchObject({
        projectContextId: docsProjectContext.projectContextId,
        linearProjectIdentity: {
          kind: "linear",
          slug: docsProjectContext.linearProjectSlug,
          id: "linear-project-docs-1",
        },
      });
      await expect(runStore.getRun(initialRunId)).resolves.toMatchObject({
        projectContext: docsProjectContext,
      });
      await expect(lifecycleStore.get(initialCandidate.identifier)).resolves.toMatchObject({
        projectContext: docsProjectContext,
      });
      expect(reroutedRun?.ctx.projectContext).toMatchObject({
        projectContextId: LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
        projectContextLabel: LEGACY_DEFAULT_PROJECT_CONTEXT_LABEL,
        linearProjectSlug: docsProjectContext.linearProjectSlug,
        routingSource: "candidate_poll",
      });
      expect(harness.runs[0]?.prompt).toContain("Work on ENG-123");
      expect(reroutedRun?.prompt).toContain("Reloaded work on ENG-456");
    } finally {
      await orchestrator.stop();
    }
  });

  it("skips stale removed lifecycle contexts when polling context-scoped tracker clients", async () => {
    const config = testConfig(root);
    addDocsPollingProjectContext(config);
    const removedDocsContext = {
      projectContextId: "docs-legacy",
      projectContextLabel: "Docs Legacy",
      linearProjectSlug: "DOCS",
      routingSource: "candidate_poll",
    } as const;
    const candidate = {
      ...issue({
        id: "issue-default-context-1",
        identifier: "ENG-789",
        state: "Todo",
        labels: ["dogfood-ready"],
        branchName: "symphony/ENG-789",
      }),
      linearProjectIdentity: {
        kind: "linear" as const,
        slug: legacyDefaultProjectContext.linearProjectSlug,
        id: "linear-project-default-1",
      },
      routingSource: "candidate_poll" as const,
      resolvedAt: "2026-01-01T00:00:00Z",
    };
    const defaultTracker = trackerClientFixture({
      candidates: [candidate],
      issues: [candidate],
    });
    const docsTracker = trackerClientFixture();
    const logger = new StructuredLogger(() => undefined);
    const stateDir = path.join(root, "state");
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const runStore = new FileRunTranscriptStore(stateDir);
    await lifecycleStore.ensureIssue(
      issue({
        id: "issue-stale-context-1",
        identifier: "DOCS-STALE-1",
        state: "In Progress",
        branchName: "symphony/docs/DOCS-STALE-1",
      }),
      {
        phase: "implementation",
        projectContext: removedDocsContext,
      },
    );
    const harness = new FakeHarness();
    const resolvedProjectContextIds: string[] = [];
    const orchestrator = new Orchestrator({
      config,
      tracker: defaultTracker,
      trackerResolver(projectContext) {
        const projectContextId = projectContext?.projectContextId ?? LEGACY_DEFAULT_PROJECT_CONTEXT_ID;
        resolvedProjectContextIds.push(projectContextId);
        if (projectContextId === docsProjectContext.projectContextId) return docsTracker;
        if (projectContextId === LEGACY_DEFAULT_PROJECT_CONTEXT_ID) return defaultTracker;
        throw new Error(`Unexpected project context ${projectContextId}`);
      },
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
    });

    try {
      await orchestrator.refreshNow();
      await waitFor(() => harness.runs.length === 1, "default dispatch after stale lifecycle context filtering");
    } finally {
      await orchestrator.stop();
      await settleOrchestratorExit();
    }

    expect(resolvedProjectContextIds).toContain(LEGACY_DEFAULT_PROJECT_CONTEXT_ID);
    expect(resolvedProjectContextIds).toContain(docsProjectContext.projectContextId);
    expect(resolvedProjectContextIds).not.toContain(removedDocsContext.projectContextId);
    expect(harness.runs).toHaveLength(1);
    expect(harness.runs[0]?.ctx.projectContext).toMatchObject(legacyDefaultProjectContext);
    await expect(runStore.getRun(`fake-${candidate.id}-1`)).resolves.toMatchObject({
      projectContext: legacyDefaultProjectContext,
    });
    await expect(lifecycleStore.get(candidate.identifier)).resolves.toMatchObject({
      projectContext: legacyDefaultProjectContext,
    });
  });

  it("keeps disabled lifecycle contexts out of context-scoped polling", async () => {
    const config = testConfig(root);
    addDocsPollingProjectContext(config);
    const disabledDocsContext = requireDocsPollingContext(config);
    disabledDocsContext.enabled = false;
    config.projectContexts.enabledContexts = config.projectContexts.enabledContexts.filter(
      (context) => context.id !== disabledDocsContext.id,
    );
    const candidate = {
      ...issue({
        id: "issue-default-context-disabled-1",
        identifier: "ENG-789-DISABLED",
        state: "Todo",
        labels: ["dogfood-ready"],
        branchName: "symphony/ENG-789-DISABLED",
      }),
      linearProjectIdentity: {
        kind: "linear" as const,
        slug: legacyDefaultProjectContext.linearProjectSlug,
        id: "linear-project-default-disabled-1",
      },
      routingSource: "candidate_poll" as const,
      resolvedAt: "2026-01-01T00:00:00Z",
    };
    const defaultTracker = trackerClientFixture({
      candidates: [candidate],
      issues: [candidate],
    });
    const docsTracker = trackerClientFixture();
    const logger = new StructuredLogger(() => undefined);
    const stateDir = path.join(root, "state");
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const runStore = new FileRunTranscriptStore(stateDir);
    await lifecycleStore.ensureIssue(
      issue({
        id: "issue-disabled-context-1",
        identifier: "DOCS-DISABLED-1",
        state: "In Progress",
        branchName: "symphony/docs/DOCS-DISABLED-1",
      }),
      {
        phase: "implementation",
        projectContext: docsProjectContext,
      },
    );
    const harness = new FakeHarness();
    const resolvedProjectContextIds: string[] = [];
    const orchestrator = new Orchestrator({
      config,
      tracker: defaultTracker,
      trackerResolver(projectContext) {
        const projectContextId = projectContext?.projectContextId ?? LEGACY_DEFAULT_PROJECT_CONTEXT_ID;
        resolvedProjectContextIds.push(projectContextId);
        return projectContextId === docsProjectContext.projectContextId ? docsTracker : defaultTracker;
      },
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
    });

    try {
      await orchestrator.refreshNow();
      await waitFor(() => harness.runs.length === 1, "default dispatch after disabled lifecycle context filtering");
    } finally {
      await orchestrator.stop();
      await settleOrchestratorExit();
    }

    expect(defaultTracker.candidateFetchCount).toBe(1);
    expect(docsTracker.candidateFetchCount).toBe(0);
    expect(resolvedProjectContextIds).toContain(LEGACY_DEFAULT_PROJECT_CONTEXT_ID);
    expect(resolvedProjectContextIds).not.toContain(docsProjectContext.projectContextId);
    expect(harness.runs).toHaveLength(1);
    expect(harness.runs[0]?.ctx.projectContext).toMatchObject(legacyDefaultProjectContext);
    await expect(runStore.getRun(`fake-${candidate.id}-1`)).resolves.toMatchObject({
      projectContext: legacyDefaultProjectContext,
    });
    await expect(lifecycleStore.get(candidate.identifier)).resolves.toMatchObject({
      projectContext: legacyDefaultProjectContext,
    });
  });

  it("prefers the freshly polled project context over a non-running persisted lifecycle context", async () => {
    const config = testConfig(root);
    addDocsPollingProjectContext(config);
    const candidate = {
      ...issue({
        id: "issue-rerouted-context-1",
        identifier: "ENG-790",
        state: "Todo",
        labels: ["dogfood-ready"],
        branchName: "symphony/ENG-790",
      }),
      linearProjectIdentity: {
        kind: "linear" as const,
        slug: legacyDefaultProjectContext.linearProjectSlug,
        id: "linear-project-default-2",
      },
      routingSource: "candidate_poll" as const,
      resolvedAt: "2026-01-01T00:00:00Z",
    };
    const defaultTracker = trackerClientFixture({
      candidates: [candidate],
      issues: [candidate],
    });
    const docsTracker = trackerClientFixture();
    const logger = new StructuredLogger(() => undefined);
    const stateDir = path.join(root, "state");
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const runStore = new FileRunTranscriptStore(stateDir);
    await lifecycleStore.ensureIssue(candidate, {
      phase: "implementation",
      projectContext: docsProjectContext,
    });
    const harness = new FakeHarness();
    const orchestrator = new Orchestrator({
      config,
      tracker: defaultTracker,
      trackerResolver(projectContext) {
        return projectContext?.projectContextId === docsProjectContext.projectContextId ? docsTracker : defaultTracker;
      },
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
    });

    try {
      await orchestrator.refreshNow();
      await waitFor(() => harness.runs.length === 1, "rerouted default-context dispatch");
    } finally {
      await orchestrator.stop();
      await settleOrchestratorExit();
    }

    expect(defaultTracker.candidateFetchCount).toBe(1);
    expect(docsTracker.candidateFetchCount).toBe(1);
    expect(harness.runs).toHaveLength(1);
    expect(harness.runs[0]?.ctx.projectContext).toMatchObject(legacyDefaultProjectContext);
    await expect(runStore.getRun(`fake-${candidate.id}-1`)).resolves.toMatchObject({
      projectContext: legacyDefaultProjectContext,
    });
    await expect(lifecycleStore.get(candidate.identifier)).resolves.toMatchObject({
      projectContext: legacyDefaultProjectContext,
    });
  });

  it("routes duplicate identifiers from distinct project contexts into distinct workspaces and persisted state", async () => {
    const config = testConfig(root);
    addDocsPollingProjectContext(config);
    const sharedIdentifier = "ENG-123";
    const defaultProjectContext = legacyDefaultProjectContext;
    const defaultCandidate = {
      ...issue({
        id: "issue-default-1",
        identifier: sharedIdentifier,
        state: "Todo",
        labels: ["dogfood-ready"],
        branchName: "symphony/ENG-123",
      }),
      linearProjectIdentity: {
        kind: "linear" as const,
        slug: defaultProjectContext.linearProjectSlug,
        id: "linear-project-default-1",
      },
      routingSource: "candidate_poll" as const,
      resolvedAt: "2026-01-01T00:00:00Z",
    };
    const docsCandidate = trackerIssue({
      id: "issue-docs-1",
      identifier: sharedIdentifier,
      state: "Todo",
      labels: ["dogfood-ready"],
      projectContextId: docsProjectContext.projectContextId,
      projectContextLabel: docsProjectContext.projectContextLabel,
      linearProjectSlug: docsProjectContext.linearProjectSlug,
      branchName: "symphony/docs/ENG-123",
    });
    const defaultTracker: TrackerClient & { candidateFetchCount: number; requestedIds: string[][] } = {
      candidateFetchCount: 0,
      requestedIds: [],
      async fetchCandidateIssues() {
        defaultTracker.candidateFetchCount += 1;
        return [defaultCandidate];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds(issueIds) {
        defaultTracker.requestedIds.push([...issueIds]);
        return issueIds.includes(defaultCandidate.id) ? [defaultCandidate] : [];
      },
    };
    const docsTracker = trackerClientFixture({
      candidates: [docsCandidate],
      issues: [docsCandidate],
    });
    const logger = new StructuredLogger(() => undefined);
    const stateDir = path.join(root, "state");
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const runStore = new FileRunTranscriptStore(stateDir);
    const harness: AgentHarness & {
      runs: Array<{ ctx: AgentRunContext; prompt: string }>;
      stoppedRunIds: string[];
    } = {
      id: "project-context-routing-blocking",
      capabilities: { continuation: true, mcpHandoff: true },
      runs: [],
      stoppedRunIds: [],
      async *run(ctx: AgentRunContext, prompt: string): AsyncIterable<AgentEvent> {
        this.runs.push({ ctx, prompt });
        const runId = `run-${ctx.issue.id}-${ctx.turnNumber}`;
        yield { type: "session_started", sessionId: `session-${ctx.issue.id}-${ctx.turnNumber}`, runId };
        if (!ctx.abortSignal.aborted) {
          await new Promise<void>((resolve) =>
            ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
        yield { type: "cancelled" };
      },
      async stop(runId: string): Promise<void> {
        this.stoppedRunIds.push(runId);
      },
    };
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker: defaultTracker,
      trackerResolver(projectContext) {
        return projectContext?.projectContextId === docsProjectContext.projectContextId ? docsTracker : defaultTracker;
      },
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
    });

    try {
      await orchestrator.refreshNow();
      await waitFor(() => harness.runs.length === 2, "two context-scoped dispatches");
      await waitFor(() => orchestrator.snapshot().counts.running === 2, "two context-scoped runs active");

      const defaultRequestedIdsBeforeRefresh = defaultTracker.requestedIds.length;
      const docsRequestedIdsBeforeRefresh = docsTracker.requestedIds.length;

      await orchestrator.refreshNow();
      await waitFor(
        () =>
          orchestrator.snapshot().counts.running === 2 &&
          defaultTracker.requestedIds.length > defaultRequestedIdsBeforeRefresh &&
          docsTracker.requestedIds.length > docsRequestedIdsBeforeRefresh,
        "running issue refresh scoped by project context",
      );
    } finally {
      await orchestrator.stop();
      await settleOrchestratorExit();
    }

    const defaultHarnessRun = harness.runs.find((run) => run.ctx.issue.id === defaultCandidate.id);
    const docsHarnessRun = harness.runs.find((run) => run.ctx.issue.id === docsCandidate.id);
    const defaultRunningRefreshIds = defaultTracker.requestedIds[defaultTracker.requestedIds.length - 1];
    const docsRunningRefreshIds = docsTracker.requestedIds[docsTracker.requestedIds.length - 1];
    const defaultWorkspaceKey = sharedIdentifier;
    const docsWorkspaceKey = `docs__${sharedIdentifier}`;

    expect(defaultTracker.candidateFetchCount).toBeGreaterThanOrEqual(2);
    expect(docsTracker.candidateFetchCount).toBeGreaterThanOrEqual(2);
    expect(defaultTracker.requestedIds.length).toBeGreaterThanOrEqual(1);
    expect(docsTracker.requestedIds.length).toBeGreaterThanOrEqual(1);
    expect(defaultRunningRefreshIds).toEqual([defaultCandidate.id]);
    expect(docsRunningRefreshIds).toEqual([docsCandidate.id]);
    expect(defaultTracker.requestedIds.every((issueIds) => issueIds.length === 1 && issueIds[0] === defaultCandidate.id)).toBe(true);
    expect(docsTracker.requestedIds.every((issueIds) => issueIds.length === 1 && issueIds[0] === docsCandidate.id)).toBe(true);
    expect(defaultHarnessRun?.ctx.projectContext).toMatchObject(defaultProjectContext);
    expect(docsHarnessRun?.ctx.projectContext).toMatchObject(docsProjectContext);
    expect(defaultHarnessRun?.ctx.workspace).toMatchObject({
      workspaceKey: defaultWorkspaceKey,
      path: path.join(config.workspace.root, defaultWorkspaceKey),
    });
    expect(docsHarnessRun?.ctx.workspace).toMatchObject({
      workspaceKey: docsWorkspaceKey,
      path: path.join(config.workspace.root, docsWorkspaceKey),
    });
    expect(defaultHarnessRun?.ctx.workspace.path).not.toBe(docsHarnessRun?.ctx.workspace.path);

    const defaultRuns = await runStore.listRunsForIssue(sharedIdentifier, { projectContext: defaultProjectContext });
    const docsRuns = await runStore.listRunsForIssue(sharedIdentifier, { projectContext: docsProjectContext });

    expect(defaultRuns).toHaveLength(1);
    expect(docsRuns).toHaveLength(1);
    expect(defaultRuns[0]).toMatchObject({
      issueId: defaultCandidate.id,
      issueIdentifier: sharedIdentifier,
      projectContext: defaultProjectContext,
      workspaceKey: defaultWorkspaceKey,
      workspacePath: path.join(config.workspace.root, defaultWorkspaceKey),
    });
    expect(docsRuns[0]).toMatchObject({
      issueId: docsCandidate.id,
      issueIdentifier: sharedIdentifier,
      projectContext: docsProjectContext,
      workspaceKey: docsWorkspaceKey,
      workspacePath: path.join(config.workspace.root, docsWorkspaceKey),
    });
    await expect(lifecycleStore.get(sharedIdentifier)).resolves.toBeNull();
    await expect(lifecycleStore.get(defaultCandidate.id)).resolves.toMatchObject({
      issueIdentifier: sharedIdentifier,
      projectContext: defaultProjectContext,
      summaryPointers: {
        workspaceKey: defaultWorkspaceKey,
        workspacePath: path.join(config.workspace.root, defaultWorkspaceKey),
      },
    });
    await expect(lifecycleStore.get(docsCandidate.id)).resolves.toMatchObject({
      issueIdentifier: sharedIdentifier,
      projectContext: docsProjectContext,
      summaryPointers: {
        workspaceKey: docsWorkspaceKey,
        workspacePath: path.join(config.workspace.root, docsWorkspaceKey),
      },
    });
    expect(orchestrator.snapshot().counts.retrying).toBe(0);
  });

  it("records routing failures before skipping worker dispatch without workspace or Linear mutation for ambiguous project contexts", async () => {
    const config = testConfig(root);
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.tracker.handoffStates = ["Human Review"];
    addSymphonyPollingProjectContext(config);
    const candidate = {
      ...issue({
        id: "issue-routing-ambiguous-1",
        identifier: "ENG-409-A",
        state: "Todo",
        labels: ["dogfood-ready"],
      }),
      linearProjectIdentity: {
        kind: "linear" as const,
        slug: legacyDefaultProjectContext.linearProjectSlug,
        id: "linear-project-ambiguous-1",
      },
      routingSource: "candidate_poll" as const,
      resolvedAt: "2026-01-01T00:00:00Z",
    };
    const defaultTracker: TrackerClient & { candidateFetchCount: number; requestedIds: string[][] } = {
      candidateFetchCount: 0,
      requestedIds: [],
      async fetchCandidateIssues() {
        defaultTracker.candidateFetchCount += 1;
        return [candidate];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds(issueIds) {
        defaultTracker.requestedIds.push([...issueIds]);
        return issueIds.includes(candidate.id) ? [candidate] : [];
      },
    };
    const symphonyTracker: TrackerClient & { candidateFetchCount: number; requestedIds: string[][] } = {
      candidateFetchCount: 0,
      requestedIds: [],
      async fetchCandidateIssues() {
        symphonyTracker.candidateFetchCount += 1;
        return [];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds(issueIds) {
        symphonyTracker.requestedIds.push([...issueIds]);
        return [];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const writer = new StateChangingWriter(() => undefined);
    const stateDir = path.join(root, "state");
    const writeback = new WritebackProcessor(new FileWritebackOutboxStore(stateDir), writer, logger, 300_000);
    const harness = new FakeHarness();
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const runStore = new FileRunTranscriptStore(stateDir);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker: defaultTracker,
      trackerResolver(projectContext) {
        return projectContext?.projectContextId === symphonyProjectContext.projectContextId ? symphonyTracker : defaultTracker;
      },
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
      await orchestrator.refreshNow();
    } finally {
      await orchestrator.stop();
      await settleOrchestratorExit();
    }

    const lifecycle = await lifecycleStore.get(candidate.id);
    expect(defaultTracker.candidateFetchCount).toBeGreaterThanOrEqual(2);
    expect(symphonyTracker.candidateFetchCount).toBeGreaterThanOrEqual(2);
    expect(defaultTracker.requestedIds).toEqual([]);
    expect(symphonyTracker.requestedIds).toEqual([]);
    expect(harness.runs).toHaveLength(0);
    await expect(runStore.listRuns()).resolves.toEqual([]);
    await expect(runStore.listWorkspaces()).resolves.toEqual([]);
    expect(writer.transitions).toEqual([]);
    expect(writer.comments).toEqual([]);
    expect(lifecycle).toMatchObject({
      phase: "unknown",
      blockedReason: null,
      events: [
        {
          kind: "worker_dispatch_routing_failure",
          redacted: true,
          reason: "ambiguous_context",
          candidateContextIds: [LEGACY_DEFAULT_PROJECT_CONTEXT_ID, symphonyProjectContext.projectContextId],
        },
      ],
    });
    expect(lifecycle?.events[0]?.safeMessage).toContain("matched multiple enabled project contexts");
    expect(lifecycle?.events).toHaveLength(1);
    expect(orchestrator.snapshot().counts.retrying).toBe(0);
  });

  it("records routing failures before skipping worker dispatch without workspace or Linear mutation for missing project contexts", async () => {
    const config = testConfig(root);
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.tracker.handoffStates = ["Human Review"];
    addDocsPollingProjectContext(config);
    const candidate = {
      ...issue({
        id: "issue-routing-missing-1",
        identifier: "ENG-409-B",
        state: "Todo",
        labels: ["dogfood-ready"],
      }),
      linearProjectIdentity: {
        kind: "linear" as const,
        slug: "MISSING",
        id: "linear-project-missing-1",
      },
      routingSource: "candidate_poll" as const,
      resolvedAt: "2026-01-01T00:00:00Z",
    };
    const defaultTracker: TrackerClient & { candidateFetchCount: number; requestedIds: string[][] } = {
      candidateFetchCount: 0,
      requestedIds: [],
      async fetchCandidateIssues() {
        defaultTracker.candidateFetchCount += 1;
        return [candidate];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds(issueIds) {
        defaultTracker.requestedIds.push([...issueIds]);
        return issueIds.includes(candidate.id) ? [candidate] : [];
      },
    };
    const docsTracker: TrackerClient & { candidateFetchCount: number; requestedIds: string[][] } = {
      candidateFetchCount: 0,
      requestedIds: [],
      async fetchCandidateIssues() {
        docsTracker.candidateFetchCount += 1;
        return [];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds(issueIds) {
        docsTracker.requestedIds.push([...issueIds]);
        return [];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const writer = new StateChangingWriter(() => undefined);
    const stateDir = path.join(root, "state");
    const writeback = new WritebackProcessor(new FileWritebackOutboxStore(stateDir), writer, logger, 300_000);
    const harness = new FakeHarness();
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const runStore = new FileRunTranscriptStore(stateDir);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker: defaultTracker,
      trackerResolver(projectContext) {
        return projectContext?.projectContextId === docsProjectContext.projectContextId ? docsTracker : defaultTracker;
      },
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
      await orchestrator.refreshNow();
    } finally {
      await orchestrator.stop();
      await settleOrchestratorExit();
    }

    const lifecycle = await lifecycleStore.get(candidate.id);
    expect(defaultTracker.candidateFetchCount).toBeGreaterThanOrEqual(2);
    expect(docsTracker.candidateFetchCount).toBeGreaterThanOrEqual(2);
    expect(defaultTracker.requestedIds).toEqual([]);
    expect(docsTracker.requestedIds).toEqual([]);
    expect(harness.runs).toHaveLength(0);
    await expect(runStore.listRuns()).resolves.toEqual([]);
    await expect(runStore.listWorkspaces()).resolves.toEqual([]);
    expect(writer.transitions).toEqual([]);
    expect(writer.comments).toEqual([]);
    expect(lifecycle).toMatchObject({
      phase: "unknown",
      blockedReason: null,
      events: [
        {
          kind: "worker_dispatch_routing_failure",
          redacted: true,
          reason: "missing_context",
          candidateContextIds: [],
        },
      ],
    });
    expect(lifecycle?.events[0]?.safeMessage).toContain("did not match any enabled project context");
    expect(lifecycle?.events).toHaveLength(1);
    expect(orchestrator.snapshot().counts.retrying).toBe(0);
  });

  it("dispatches legacy single-project workflows as the synthesized default context", async () => {
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
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [{ ...candidate, state: currentState }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const writer = new StateChangingWriter((state) => {
      currentState = state;
    });
    const stateDir = path.join(root, "state");
    const writeback = new WritebackProcessor(new FileWritebackOutboxStore(stateDir), writer, logger, 300_000);
    const harness = new FakeHarness();
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const runStore = new FileRunTranscriptStore(stateDir);
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

    expect(harness.runs).toHaveLength(1);
    expect(harness.runs[0]?.ctx.projectContext).toMatchObject(legacyDefaultProjectContext);
    expect(currentState).toBe("In Progress");
    expect(writer.transitions.map((transition) => transition.toState)).toEqual(["In Progress"]);
    expect(writer.comments[0]?.dedupeKey).toBe("fake-issue-1-1:run-started");
    await expect(runStore.getRun("fake-issue-1-1")).resolves.toMatchObject({
      projectContext: legacyDefaultProjectContext,
    });
    await expect(lifecycleStore.get(candidate.identifier)).resolves.toMatchObject({
      incompleteTurnCount: 1,
      projectContext: legacyDefaultProjectContext,
    });
    expect(orchestrator.snapshot().counts.retrying).toBe(0);
  });

  it("rehydrates stale legacy-default lifecycle records on dispatch recovery", async () => {
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
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [{ ...candidate, state: currentState }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const writer = new StateChangingWriter((state) => {
      currentState = state;
    });
    const stateDir = path.join(root, "state");
    const writeback = new WritebackProcessor(new FileWritebackOutboxStore(stateDir), writer, logger, 300_000);
    const harness = new FakeHarness();
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const runStore = new FileRunTranscriptStore(stateDir);
    await lifecycleStore.updateIssue(candidate, {
      projectContext: {
        ...legacyDefaultProjectContext,
        linearProjectSlug: null,
      },
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

    expect(harness.runs).toHaveLength(1);
    expect(harness.runs[0]?.ctx.projectContext).toMatchObject(legacyDefaultProjectContext);
    expect(currentState).toBe("In Progress");
    expect(writer.transitions.map((transition) => transition.toState)).toEqual(["In Progress"]);
    expect(writer.comments[0]?.dedupeKey).toBe("fake-issue-1-1:run-started");
    await expect(runStore.getRun("fake-issue-1-1")).resolves.toMatchObject({
      projectContext: legacyDefaultProjectContext,
    });
    await expect(lifecycleStore.get(candidate.identifier)).resolves.toMatchObject({
      incompleteTurnCount: 1,
      projectContext: legacyDefaultProjectContext,
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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

  it("preserves routed worker retry redispatch context through config reload", async () => {
    const docsActiveStates = ["Docs In Progress"];
    const config = testConfig(root);
    config.agent.maxSdkErrorRetries = 1;
    config.agent.maxRetryBackoffMs = 250;
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.writeback.dispatchState = "Docs In Progress";
    config.reviewLoop.blockedStates = ["Blocked"];
    config.tracker.activeStates = ["Root Todo"];
    addDocsPollingProjectContext(config);
    const docsContext = requireDocsPollingContext(config);
    docsContext.tracker.activeStates = [...docsActiveStates];

    class ReloadRecordingSdkWaitErrorHarness implements AgentHarness {
      readonly id = "reload-recording-sdk-wait-error";
      readonly capabilities = { continuation: true, mcpHandoff: true };
      readonly runs: Array<{ ctx: AgentRunContext; runId: string }> = [];
      readonly reloads: AgentRunContext[] = [];

      async reload(ctx: AgentRunContext): Promise<void> {
        this.reloads.push(ctx);
      }

      async *run(ctx: AgentRunContext): AsyncIterable<AgentEvent> {
        const runId = `reload-sdk-error-run-${this.runs.length + 1}`;
        this.runs.push({ ctx, runId });
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

    const candidate = trackerIssue({
      id: "issue-docs-sdk-retry-reload-1",
      identifier: "DOCS-SDK-RETRY-RELOAD-1",
      state: "Docs In Progress",
      labels: ["dogfood-ready"],
      projectContextId: docsProjectContext.projectContextId,
      projectContextLabel: docsProjectContext.projectContextLabel,
      linearProjectSlug: docsProjectContext.linearProjectSlug,
    });
    let currentState = "Docs In Progress";
    const defaultTracker = trackerClientFixture();
    const docsTrackerStats = {
      candidateFetchCount: 0,
      requestedIds: [] as string[][],
    };
    const docsTracker: TrackerClient = {
      async fetchCandidateIssues() {
        docsTrackerStats.candidateFetchCount += 1;
        return currentState === "Blocked" ? [] : [{ ...candidate, state: currentState }];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds(issueIds) {
        docsTrackerStats.requestedIds.push([...issueIds]);
        return [{ ...candidate, state: currentState }].filter((issue) => issueIds.includes(issue.id));
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
    const harness = new ReloadRecordingSdkWaitErrorHarness();
    const orchestrator = new Orchestrator({
      config,
      tracker: defaultTracker,
      trackerResolver(projectContext) {
        return projectContext?.projectContextId === docsProjectContext.projectContextId ? docsTracker : defaultTracker;
      },
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
      writeback,
    });

    const reloadedConfig = testConfig(root);
    reloadedConfig.agent.maxSdkErrorRetries = 1;
    reloadedConfig.agent.maxRetryBackoffMs = 250;
    reloadedConfig.writeback.enabled = true;
    reloadedConfig.writeback.mode = "live";
    reloadedConfig.writeback.dispatchState = "Docs In Progress";
    reloadedConfig.reviewLoop.blockedStates = ["Blocked"];
    reloadedConfig.tracker.activeStates = ["Reloaded Root Todo"];
    addDocsPollingProjectContext(reloadedConfig);
    const reloadedDocsContext = requireDocsPollingContext(reloadedConfig);
    reloadedDocsContext.tracker.activeStates = [...docsActiveStates];

    try {
      await orchestrator.refreshNow();
      await waitFor(() => harness.runs.length === 1 && orchestrator.snapshot().counts.retrying === 1, "first docs sdk retry scheduled");
      orchestrator.updateConfig(reloadedConfig, "Work on {{ issue.identifier }}");
      await waitFor(
        () => harness.runs.length === 2 && orchestrator.snapshot().counts.retrying === 0,
        "docs retry redispatch after config reload",
      );
    } finally {
      await orchestrator.stop();
    }

    expect(harness.reloads).toHaveLength(2);
    expect(harness.runs).toHaveLength(2);
    expect(defaultTracker.requestedIds).toEqual([]);
    expect(docsTrackerStats.candidateFetchCount).toBeGreaterThan(defaultTracker.candidateFetchCount);
    expect(docsTrackerStats.requestedIds.length).toBeGreaterThanOrEqual(2);
    expect(harness.reloads[1]?.projectContext).toMatchObject(docsProjectContext);
    expect(harness.reloads[1]?.issue.state).toBe("Docs In Progress");
    expect(harness.reloads[1]?.config.tracker.activeStates).toEqual(docsActiveStates);
    expect(harness.reloads[1]?.config.tracker.activeStates).not.toEqual(reloadedConfig.tracker.activeStates);
    expect(harness.runs[1]?.ctx.projectContext).toMatchObject(docsProjectContext);
    expect(harness.runs[1]?.ctx.issue.state).toBe("Docs In Progress");
    expect(harness.runs[1]?.ctx.config.tracker.activeStates).toEqual(docsActiveStates);
    const runs = await runStore.listRunsForIssue(candidate.id);
    expect(runs.map((run) => [run.runId, run.status, run.sdkRunStatus, run.sdkRunStatusSource])).toEqual([
      ["reload-sdk-error-run-1", "failed", "error", "wait"],
      ["reload-sdk-error-run-2", "failed", "error", "wait"],
    ]);
    expect(currentState).toBe("Docs In Progress");
    await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
      projectContext: docsProjectContext,
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
    addDocsPollingProjectContext(config);
    const candidate = trackerIssue({
      id: "issue-docs-sdk-retry-1",
      identifier: "DOCS-SDK-RETRY-1",
      state: "Todo",
      labels: ["dogfood-ready"],
      projectContextId: docsProjectContext.projectContextId,
      projectContextLabel: docsProjectContext.projectContextLabel,
      linearProjectSlug: docsProjectContext.linearProjectSlug,
    });
    let currentState = "Todo";
    const defaultTracker = trackerClientFixture();
    const docsTrackerStats = {
      candidateFetchCount: 0,
      requestedStates: [] as string[][],
      requestedIds: [] as string[][],
    };
    const docsTracker: TrackerClient = {
      async fetchCandidateIssues() {
        docsTrackerStats.candidateFetchCount += 1;
        return currentState === "Blocked" ? [] : [{ ...candidate, state: currentState }];
      },
      async fetchIssuesByStates(states) {
        docsTrackerStats.requestedStates.push([...states]);
        return currentState === "Blocked" || !states.includes(currentState) ? [] : [{ ...candidate, state: currentState }];
      },
      async fetchIssueStatesByIds(issueIds) {
        docsTrackerStats.requestedIds.push([...issueIds]);
        return [{ ...candidate, state: currentState }].filter((issue) => issueIds.includes(issue.id));
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
      tracker: defaultTracker,
      trackerResolver(projectContext) {
        return projectContext?.projectContextId === docsProjectContext.projectContextId ? docsTracker : defaultTracker;
      },
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
      await waitFor(
        () => currentState === "Blocked" && orchestrator.snapshot().counts.retrying === 0,
        "sdk error escalation",
        10_000,
      );
    } finally {
      await orchestrator.stop();
    }

    expect(harness.runs).toEqual(["sdk-error-run-1", "sdk-error-run-2", "sdk-error-run-3"]);
    expect(docsTrackerStats.candidateFetchCount).toBeGreaterThan(defaultTracker.candidateFetchCount);
    expect(defaultTracker.requestedIds).toEqual([]);
    expect(docsTrackerStats.requestedIds.length).toBeGreaterThan(2);
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
      projectContext: docsProjectContext,
      blockedReason: "consecutive Cursor SDK wait errors reached limit (3 failures; max_sdk_error_retries=2)",
    });
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
      async fetchIssuesByStates() {
        return [];
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

  it("blocks a reviewer fail verdict at the max review round ceiling", async () => {
    const config = testConfig(root);
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.tracker.handoffStates = ["In Review"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.reviewLoop.blockedStates = ["Blocked"];
    config.reviewLoop.maxReviewRounds = 1;
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
    expect(writer.comments[0]?.body).toContain("max review rounds reached (1/1)");
    expect(writer.comments[0]?.body).toContain("Review rounds: 1 / 1");
    expect(writer.comments[0]?.body).toContain("Last completion report:");
    expect(writer.comments[0]?.body).toContain("Last review verdict:");
    expect(writer.comments[0]?.body).toContain("Add reviewer MCP integration.");
    expect(writer.transitions.map((transition) => transition.toState)).toEqual(["Blocked"]);
    await expect(lifecycleStore.get(candidate.identifier)).resolves.toMatchObject({
      phase: "blocked",
      reviewRound: 1,
      incompleteTurnCount: 0,
      blockedReason: "max review rounds reached (1/1)",
      lastReviewVerdictId: "review-verdict:issue-1:review-verdict-fail-1",
    });
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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
      await lifecycleStore.ensureIssue(candidate, {
        ...pendingApprovalLifecyclePatch(candidate, root, runId, PUBLICATION_APPROVAL_SETUP_INCOMPLETE_REASON),
        phase: "implementation",
      });
      await runStore.updateRun(runId, {
        metadata: {
          pendingApprovalRequestId: null,
          pendingApprovalRequestedAt: null,
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 5));

      await orchestrator.refreshNow();

      const runningRun = await runStore.getRun(runId);
      expect(runningRun).toMatchObject({
        status: "running",
      });
      expect(runningRun?.pendingApprovalRequestId ?? null).toBeNull();
      expect(runningRun?.cancellationRequestedAt ?? null).toBeNull();
      await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
        phase: "implementation",
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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
    addDocsPollingProjectContext(config);
    const candidate = trackerIssue({
      id: "issue-1",
      identifier: "TEST-1",
      state: "Todo",
      labels: ["dogfood-ready"],
      branchName: "symphony/TEST-1",
      projectContextId: docsProjectContext.projectContextId,
      projectContextLabel: docsProjectContext.projectContextLabel,
      linearProjectSlug: docsProjectContext.linearProjectSlug,
    });
    let currentState = "Todo";
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [{ ...candidate, state: currentState }];
      },
      async fetchIssuesByStates() {
        return [];
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

    const operations = await outboxStore.list();

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
    expect(operations).toEqual(expect.arrayContaining([expect.objectContaining({ projectContext: docsProjectContext })]));
    await expect(runStore.getRun("report-run-1")).resolves.toMatchObject({
      projectContext: docsProjectContext,
      prUrl: "https://github.com/acme/symphony/pull/42",
      prNumber: 42,
      prHeadSha: "abc123",
      prBranch: "symphony/TEST-1",
      lastEvidenceCursor: "idem-1",
    });
    await expect(lifecycleStore.get(candidate.identifier)).resolves.toMatchObject({
      phase: "review",
      incompleteTurnCount: 0,
      projectContext: docsProjectContext,
      completionReports: [expect.objectContaining({ projectContext: docsProjectContext })],
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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
  });

  it("records terminal publication approval recovery through the orchestrator when an approval is replayed after worker exit", async () => {
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
      async fetchIssuesByStates() {
        return [];
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
    const approval = approvalRecordFor("stale", candidate, "run-1", root, "run cancellation has been requested");

    await expect(orchestrator.recordPublicationApprovalTerminal(approval)).resolves.toBe(true);
    await expect(orchestrator.recordPublicationApprovalTerminal(approval)).resolves.toBe(true);

    expect(writer.comments).toHaveLength(1);
    expect(writer.comments[0]?.body).toContain("## Symphony Publication Approval Not Completed");
    expect(writer.comments[0]?.body).toContain("Status: stale");
    expect(writer.comments[0]?.body).toContain("Reason: run cancellation has been requested");
    expect(writer.comments[0]?.body).toContain("The worker completion report remains stored");
    expect(writer.transitions).toEqual([]);
    await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
      phase: "blocked",
      blockedReason: "publication approval stale",
    });
  });

  it("resumes approved publication with project-context GitHub publication credentials", async () => {
    const config = githubProfileConfig(root, {
      profiles: {
        publication: { value: "$GLOBAL_GITHUB_PUBLICATION_TOKEN", capabilities: ["github.publication"] },
      },
      roles: {
        service: {
          "github.publication": "publication",
        },
      },
      env: {
        GLOBAL_GITHUB_PUBLICATION_TOKEN: "global-publication-secret",
        DOCS_GITHUB_PUBLICATION_TOKEN: "docs-publication-secret",
      },
      projectContexts: [
        {
          id: "symphony",
          tracker: { project_slug: "TEST" },
          workspace: { source: { kind: "git", repository: "." } },
          credential_profiles: {
            profiles: {
              publication: { value: "$GLOBAL_GITHUB_PUBLICATION_TOKEN" },
            },
          },
        },
        {
          id: "docs",
          tracker: { project_slug: "DOCS" },
          workspace: { source: { kind: "git", repository: "../docs-site" } },
          github: {
            publish_pull_requests: true,
            operator_approval: { required_for_publication: true },
            pr_handoff: { enabled: false },
          },
          review_loop: { review_states: ["In Review"], blocked_states: ["Blocked"] },
          credential_profiles: {
            profiles: {
              publication: { value: "$DOCS_GITHUB_PUBLICATION_TOKEN" },
            },
          },
        },
      ],
    });
    vi.stubEnv("GLOBAL_GITHUB_PUBLICATION_TOKEN", "global-publication-secret");
    vi.stubEnv("DOCS_GITHUB_PUBLICATION_TOKEN", "docs-publication-secret");
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.writeback.dispatchState = "Todo";
    config.reviewLoop.blockedStates = ["Blocked"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.github.publishPullRequests = true;
    const candidate = issue({ state: "Blocked", labels: ["dogfood-ready"], branchName: "symphony/TEST-1" });
    let currentState = "Blocked";
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [];
      },
      async fetchIssuesByStates() {
        return [];
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
    const workspace = await initPublishRepo(root, { remote: true });
    await writeFile(path.join(workspace, "feature.txt"), "changed\n", "utf8");
    await startApprovalRun(runStore, candidate, "run-1", root);
    await runStore.updateRun("run-1", { status: "succeeded", completedAt: "2026-01-01T00:00:00.000Z" });
    await lifecycleStore.ensureIssue(candidate, pendingApprovalLifecyclePatch(candidate, root, "run-1", PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON, docsProjectContext));
    const authorizations: string[] = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      authorizations.push(String((init?.headers as Record<string, string> | undefined)?.authorization));
      if (init?.method === "POST") {
        return jsonResponse(
          {
            html_url: "https://github.com/acme/symphony/pull/42",
            number: 42,
            head: {
              ref: "symphony/TEST-1",
              sha: "abc123",
              repo: { pushed_at: "2026-01-01T00:00:01Z" },
            },
          },
          201,
        );
      }
      return jsonResponse([]);
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
    });

    await expect(orchestrator.resumeApprovedPublication(approvalRecordFor("approved", candidate, "run-1", root, null, docsProjectContext))).resolves.toBe(
      true,
    );

    expect(authorizations).toEqual(["Bearer docs-publication-secret", "Bearer docs-publication-secret"]);
    expect(writer.transitions).toHaveLength(1);
    expect(writer.transitions[0]).toMatchObject({ toState: "In Review" });
  });

  it("recovers approved publication with project-context GitHub publication credentials after worker exit", async () => {
    const config = githubProfileConfig(root, {
      profiles: {
        publication: { value: "$GLOBAL_GITHUB_PUBLICATION_TOKEN", capabilities: ["github.publication"] },
      },
      roles: {
        service: {
          "github.publication": "publication",
        },
      },
      env: {
        GLOBAL_GITHUB_PUBLICATION_TOKEN: "global-publication-secret",
        DOCS_GITHUB_PUBLICATION_TOKEN: "docs-publication-secret",
      },
      projectContexts: [
        {
          id: "symphony",
          tracker: { project_slug: "TEST" },
          workspace: { source: { kind: "git", repository: "." } },
          credential_profiles: {
            profiles: {
              publication: { value: "$GLOBAL_GITHUB_PUBLICATION_TOKEN" },
            },
          },
        },
        {
          id: "docs",
          tracker: { project_slug: "DOCS" },
          workspace: { source: { kind: "git", repository: "../docs-site" } },
          github: {
            publish_pull_requests: true,
            operator_approval: { required_for_publication: true },
            pr_handoff: { enabled: false },
          },
          review_loop: { review_states: ["In Review"], blocked_states: ["Blocked"] },
          credential_profiles: {
            profiles: {
              publication: { value: "$DOCS_GITHUB_PUBLICATION_TOKEN" },
            },
          },
        },
      ],
    });
    vi.stubEnv("GLOBAL_GITHUB_PUBLICATION_TOKEN", "global-publication-secret");
    vi.stubEnv("DOCS_GITHUB_PUBLICATION_TOKEN", "docs-publication-secret");
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.writeback.dispatchState = "Todo";
    config.reviewLoop.blockedStates = ["Blocked"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.github.publishPullRequests = true;
    config.github.operatorApproval!.requiredForPublication = true;
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
    const workspace = await initPublishRepo(root, { remote: true });
    await writeFile(path.join(workspace, "feature.txt"), "changed\n", "utf8");
    await startApprovalRun(runStore, candidate, "run-1", root);
    await runStore.updateRun("run-1", { status: "succeeded", completedAt: "2026-01-01T00:00:00.000Z" });
    const { record } = await approvalStore.requestOrGetPending(
      {
        issueId: candidate.id,
        issueIdentifier: candidate.identifier,
        runId: "run-1",
        evidenceCursor: "idem-1",
        projectContext: docsProjectContext,
        action: {
          kind: "push_and_pr",
          branchName: "symphony/TEST-1",
          baseBranch: "main",
          workspacePath: workspace,
          title: `${candidate.identifier}: ${candidate.title}`,
          evidenceCursor: "idem-1",
          summaryPreview: "Implemented the requested handoff.",
          changedFiles: ["src/core/orchestrator/Orchestrator.ts"],
          plannedOperations: ["commit_if_needed", "git_push", "pull_request_create_or_reuse"],
        },
      },
      null,
    );
    await operatorApproval.resolve(record.requestId, "approve");
    await lifecycleStore.ensureIssue(candidate, pendingApprovalLifecyclePatch(candidate, root, "run-1", PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON, docsProjectContext));
    const authorizations: string[] = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      authorizations.push(String((init?.headers as Record<string, string> | undefined)?.authorization));
      if (init?.method === "POST") {
        return jsonResponse(
          {
            html_url: "https://github.com/acme/symphony/pull/42",
            number: 42,
            head: {
              ref: "symphony/TEST-1",
              sha: "abc123",
              repo: { pushed_at: "2026-01-01T00:00:01Z" },
            },
          },
          201,
        );
      }
      return jsonResponse([]);
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
    });

    try {
      await orchestrator.refreshNow();
      await orchestrator.refreshNow();
    } finally {
      await orchestrator.stop();
    }

    expect(authorizations).toEqual(["Bearer docs-publication-secret", "Bearer docs-publication-secret"]);
    expect(writer.transitions.map((transition) => transition.toState)).toEqual(["Blocked", "In Review"]);
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
        async fetchIssuesByStates() {
          return [];
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
    expect(harness.runs[2]?.prompt).toContain("Reviewer findings to address");
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

  it("dispatches reviewer runs from resolved project-context review states with reviewer evidence", async () => {
    const config = testConfig(root);
    config.tracker.handoffStates = ["In Review"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.reviewLoop.reviewerPromptTemplate =
      "Review {{ issue.identifier }} as {{ role }}: {{ completionReport.summary }}\n{% for item in workspaceEvidence %}{{ item }}\n{% endfor %}{% for item in runDigest %}{{ item }}\n{% endfor %}";
    config.reviewLoop.reviewerPromptExtensions = ["Custom project reviewer extension."];
    addDocsPollingProjectContext(config);
    const docsContext = requireDocsPollingContext(config);
    docsContext.reviewLoop.reviewStates = ["Docs Review"];
    const candidate = trackerIssue({
      id: "issue-review-docs-1",
      identifier: "TEST-1",
      state: "Docs Review",
      branchName: "symphony/docs/TEST-1",
      projectContextId: docsProjectContext.projectContextId,
      projectContextLabel: docsProjectContext.projectContextLabel,
      linearProjectSlug: docsProjectContext.linearProjectSlug,
    });
    const defaultTracker = trackerClientFixture();
    const docsTracker = trackerClientFixture({ issues: [candidate] });
    const logger = new StructuredLogger(() => undefined);
    const stateDir = path.join(root, "state");
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const runStore = new FileRunTranscriptStore(stateDir);
    const report = completionReportRecord(candidate);
    await lifecycleStore.ensureIssue(candidate, {
      phase: "review",
      projectContext: docsProjectContext,
      lastCompletionReportId: report.id,
      completionReports: [report],
      summaryPointers: {
        branchName: "symphony/docs/TEST-1",
        gitBranchName: "symphony/docs/TEST-1",
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
      gitBranchName: "symphony/docs/TEST-1",
      repoPath: root,
      baseRef: "main",
      projectContext: docsProjectContext,
    });
    await runStore.appendEvent({
      runId: report.runId,
      at: "2026-01-01T00:00:02Z",
      source: "harness",
      eventType: "progress",
      message: "Implemented the reviewer dispatch lane.",
    });
    class ReloadTrackingFakeHarness extends FakeHarness {
      readonly reloadCtxs: AgentRunContext[] = [];

      override async reload(ctx?: AgentRunContext): Promise<void> {
        if (ctx) this.reloadCtxs.push(ctx);
        await super.reload();
      }
    }

    const harness = new ReloadTrackingFakeHarness();
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker: defaultTracker,
      trackerResolver(projectContext) {
        return projectContext?.projectContextId === docsProjectContext.projectContextId ? docsTracker : defaultTracker;
      },
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

    expect(defaultTracker.requestedStates).toEqual([["In Review"]]);
    expect(defaultTracker.requestedIds).toEqual([]);
    expect(docsTracker.requestedStates).toEqual([["Docs Review"]]);
    expect(docsTracker.requestedIds).toEqual([[candidate.id]]);
    expect(harness.reloadCount).toBe(1);
    expect(harness.reloadCtxs).toHaveLength(1);
    expect(harness.reloadCtxs[0]?.role).toBe("reviewer");
    expect(harness.reloadCtxs[0]?.projectContext).toMatchObject(docsProjectContext);
    expect(harness.reloadCtxs[0]?.config.reviewLoop.reviewStates).toEqual(["Docs Review"]);
    expect(harness.reloadCtxs[0]?.issue).toEqual(
      expect.objectContaining({
        identifier: candidate.identifier,
        state: "Docs Review",
        projectContextId: docsProjectContext.projectContextId,
        projectContextLabel: docsProjectContext.projectContextLabel,
      }),
    );
    expect(harness.runs).toHaveLength(1);
    expect(harness.runs[0]?.ctx.role).toBe("reviewer");
    expect(harness.runs[0]?.ctx.projectContext).toMatchObject(docsProjectContext);
    expect(harness.runs[0]?.ctx.config.reviewLoop.reviewStates).toEqual(["Docs Review"]);
    expect(harness.runs[0]?.ctx.issue).toEqual(
      expect.objectContaining({
        identifier: candidate.identifier,
        state: "Docs Review",
        projectContextId: docsProjectContext.projectContextId,
        projectContextLabel: docsProjectContext.projectContextLabel,
      }),
    );
    expect(harness.runs[0]?.prompt).toContain("Review TEST-1 as reviewer");
    expect(harness.runs[0]?.prompt).toContain("Implemented the requested change.");
    expect(harness.runs[0]?.prompt).toContain("Pull request: https://github.com/acme/symphony/pull/42");
    expect(harness.runs[0]?.prompt).toContain("Implemented the reviewer dispatch lane.");
    expect(harness.runs[0]?.prompt).not.toContain("Custom project reviewer extension.");
    expect(harness.runs[0]?.prompt).not.toContain("General software review matrix:");
    const runs = await runStore.listRunsForIssue(candidate.identifier);
    expect(runs.find((run) => run.runId === "fake-issue-review-docs-1-1")).toMatchObject({ role: "reviewer" });
    await expect(lifecycleStore.get(candidate.identifier)).resolves.toMatchObject({ reviewRound: 0 });
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
    expect(prompt).toContain("Before any fail verdict, perform a bounded sibling-risk sweep");
    expect(prompt).toContain("Include every known blocking gap");
    expect(prompt).toContain("required behavior, concrete evidence, expected validation");
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

  it("reconciles merge-policy issues through resolved project-context tracker clients", async () => {
    const config = testConfig(root);
    config.writeback.enabled = true;
    config.writeback.mode = "live";
    config.mergePolicy.mode = "gated";
    config.mergePolicy.sourceStates = ["Ready to Merge"];
    config.mergePolicy.doneState = "Done";
    config.mergePolicy.requiredChecks = ["ci"];
    config.github.owner = "acme";
    config.github.repo = "symphony";
    addDocsPollingProjectContext(config);
    const docsContext = requireDocsPollingContext(config);
    docsContext.github.token = "github-secret";

    const candidate = trackerIssue({
      id: "issue-docs-merge-1",
      identifier: "DOCS-1",
      state: "Ready to Merge",
      branchName: "symphony/docs/DOCS-1",
      projectContextId: docsProjectContext.projectContextId,
      projectContextLabel: docsProjectContext.projectContextLabel,
      linearProjectSlug: docsProjectContext.linearProjectSlug,
    });
    const branchName = candidate.branchName ?? "symphony/docs/DOCS-1";
    let docsState = "Ready to Merge";
    const defaultTracker = trackerClientFixture();
    const docsTracker: TrackerClient & { candidateFetchCount: number; requestedStates: string[][]; requestedIds: string[][] } = {
      candidateFetchCount: 0,
      requestedStates: [],
      requestedIds: [],
      async fetchCandidateIssues() {
        docsTracker.candidateFetchCount += 1;
        return [];
      },
      async fetchIssuesByStates(states) {
        docsTracker.requestedStates.push([...states]);
        return states.includes(docsState) ? [{ ...candidate, state: docsState }] : [];
      },
      async fetchIssueStatesByIds(issueIds) {
        docsTracker.requestedIds.push([...issueIds]);
        return issueIds.includes(candidate.id) ? [{ ...candidate, state: docsState }] : [];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const stateDir = config.workspace.stateDir;
    const outboxStore = new FileWritebackOutboxStore(stateDir);
    const writer = new StateChangingWriter((state) => {
      docsState = state;
    });
    const writeback = new WritebackProcessor(outboxStore, writer, logger, 300_000);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const runStore = new FileRunTranscriptStore(stateDir);
    await runStore.startRun({
      runId: "worker-run-1",
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
      gitBranchName: branchName,
      repoPath: root,
      baseRef: "main",
      projectContext: docsProjectContext,
    });
    await runStore.recordPullRequestEvent({
      runId: "worker-run-1",
      action: "opened",
      prUrl: "https://github.com/acme/symphony/pull/42",
      prNumber: 42,
      prHeadSha: "head-sha-1",
      prBranch: branchName,
    });
    const report = {
      ...completionReportRecord(candidate),
      id: "completion-report:issue-docs-merge-1:report-1",
      idempotencyKey: "report-1",
      pullRequest: {
        url: "https://github.com/acme/symphony/pull/42",
        number: 42,
        headSha: "head-sha-1",
        branch: branchName,
      },
      projectContext: docsProjectContext,
    };
    const verdict = {
      ...reviewVerdictRecord(candidate),
      id: "review-verdict:issue-docs-merge-1:verdict-pass-1",
      idempotencyKey: "verdict-pass-1",
      verdict: "pass" as const,
      acceptanceResults: [{ text: "Ready to merge", satisfied: true, evidence: "reviewed" }],
      findings: [],
      projectContext: docsProjectContext,
    };
    const approval = {
      ...approvalFeedbackRecord(candidate, verdict.runId),
      id: "review-feedback:issue-docs-merge-1:review-run-1:approve-1",
      pullRequest: {
        url: "https://github.com/acme/symphony/pull/42",
        number: 42,
        headSha: "head-sha-1",
        branch: branchName,
      },
      projectContext: docsProjectContext,
    };
    await lifecycleStore.ensureIssue(candidate, {
      phase: "passed",
      projectContext: docsProjectContext,
      lastCompletionReportId: report.id,
      lastReviewVerdictId: verdict.id,
      completionReports: [report],
      reviewVerdicts: [verdict],
      reviewFeedback: [approval],
      summaryPointers: {
        prUrl: report.pullRequest.url,
        prNumber: report.pullRequest.number,
        prHeadSha: report.pullRequest.headSha,
        prBranch: report.pullRequest.branch,
      },
    });
    const mergeClient = new FakeMergePolicyClient();
    const orchestrator = new Orchestrator({
      config,
      tracker: defaultTracker,
      trackerResolver(projectContext) {
        return projectContext?.projectContextId === docsProjectContext.projectContextId ? docsTracker : defaultTracker;
      },
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness: new FakeHarness(),
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
      runStore,
      writeback,
      pullRequestMergeClient: mergeClient,
    });

    await orchestrator.refreshNow();
    await waitFor(() => docsState === "Done", "docs merge-policy reconciliation");
    await orchestrator.stop();

    expect(defaultTracker.requestedStates).toContainEqual(["Ready to Merge"]);
    expect(defaultTracker.requestedIds).toEqual([]);
    expect(docsTracker.requestedStates).toContainEqual(["Ready to Merge"]);
    expect(docsTracker.requestedIds).toEqual([[candidate.id], [candidate.id]]);
    expect(mergeClient.mergeInput).toMatchObject({ pullRequestNumber: 42, expectedHeadSha: "head-sha-1", method: "merge" });
    expect(writer.transitions).toEqual([
      {
        issueId: candidate.id,
        fromStates: ["Ready to Merge"],
        toState: "Done",
        reason: "Symphony reviewer-approved merge completed",
      },
    ]);
    await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
      phase: "passed",
      projectContext: docsProjectContext,
      merge: {
        pullRequest: { number: 42, headSha: "head-sha-1" },
        checkStatus: { requiredChecks: ["ci"], passedChecks: ["ci"] },
      },
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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
    expect(refreshes).toBe(0);
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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

  it("loads and exposes issue lifecycle records during dispatch", async () => {
    const config = testConfig(root);
    config.reviewLoop.reviewStates = ["In Review"];
    const candidate = issue({ state: "Todo" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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

  it("lazy-resolves worker GitHub discovery credentials from the running issue project context", async () => {
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
        GITHUB_DISCOVERY_TOKEN: "global-discovery-secret",
        DOCS_GITHUB_DISCOVERY_TOKEN: "docs-discovery-secret",
      },
      projectContexts: [
        {
          id: "symphony",
          tracker: { project_slug: "TEST" },
          workspace: { source: { kind: "git", repository: "." } },
          credential_profiles: {
            profiles: {
              discovery: { value: "$GITHUB_DISCOVERY_TOKEN" },
            },
          },
        },
        {
          id: "docs",
          tracker: { project_slug: "DOCS" },
          workspace: { source: { kind: "git", repository: "../docs-site" } },
          credential_profiles: {
            profiles: {
              discovery: { value: "$DOCS_GITHUB_DISCOVERY_TOKEN" },
            },
          },
        },
      ],
    });
    vi.stubEnv("GITHUB_DISCOVERY_TOKEN", "global-discovery-secret");
    vi.stubEnv("DOCS_GITHUB_DISCOVERY_TOKEN", "docs-discovery-secret");
    const candidate = issue({ state: "Todo", branchName: "symphony/TEST-1" });
    const candidateWithContext = { ...candidate, projectContext: docsProjectContext };
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
    const stateDir = path.join(root, "state");
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const orchestrator = new Orchestrator({
      config,
      tracker: {
        async fetchCandidateIssues() {
          return [];
        },
        async fetchIssuesByStates() {
          return [];
        },
        async fetchIssueStatesByIds() {
          return [];
        },
      },
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger: new StructuredLogger(() => undefined) }),
      harness: new FakeHarness(),
      logger: new StructuredLogger(() => undefined),
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
    });
    const entry = {
      issue: candidateWithContext,
      lifecycle: null,
      activeRunId: null,
      runId: null,
    };

    await (orchestrator as any).discoverPullRequestForEntry(entry, {
      gitBranchName: "symphony/TEST-1",
      repoPath: "/repo",
      baseRef: "main",
    });

    expect(authorizations).toEqual(["Bearer docs-discovery-secret"]);
    await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
      summaryPointers: {
        prUrl: "https://github.com/acme/symphony/pull/42",
        prNumber: 42,
        prHeadSha: "abc123",
        prBranch: "symphony/TEST-1",
      },
    });
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
      async fetchIssuesByStates() {
        return [];
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
    expect(harness.runs[0]?.prompt).toContain("address the underlying invariant");
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
      async fetchIssuesByStates() {
        return [];
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
    expect(prompt).not.toContain("Reviewer findings to address before submitting another completion report:");
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

  it("lazy-resolves reviewer GitHub review-evidence credentials from the issue project context for worker feedback prompts", async () => {
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
        GITHUB_REVIEW_READ_TOKEN: "global-review-read-secret",
        DOCS_GITHUB_REVIEW_READ_TOKEN: "docs-review-read-secret",
      },
      projectContexts: [
        {
          id: "symphony",
          tracker: { project_slug: "TEST" },
          workspace: { source: { kind: "git", repository: "." } },
          credential_profiles: {
            profiles: {
              "review-read": { value: "$GITHUB_REVIEW_READ_TOKEN" },
            },
          },
        },
        {
          id: "docs",
          tracker: { project_slug: "DOCS" },
          workspace: { source: { kind: "git", repository: "../docs-site" } },
          credential_profiles: {
            profiles: {
              "review-read": { value: "$DOCS_GITHUB_REVIEW_READ_TOKEN" },
            },
          },
        },
      ],
    });
    vi.stubEnv("GITHUB_REVIEW_READ_TOKEN", "global-review-read-secret");
    vi.stubEnv("DOCS_GITHUB_REVIEW_READ_TOKEN", "docs-review-read-secret");
    config.reviewLoop.continuationHistoryThreshold = 5;
    const candidate = issue({ state: "In Progress", branchName: null });
    const candidateWithContext = { ...candidate, projectContext: docsProjectContext };
    const stateDir = config.workspace.stateDir;
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    await lifecycleStore.ensureIssue(candidate, {
      phase: "implementation",
      projectContext: docsProjectContext,
      lastCompletionReportId: "completion-report:issue-1:idem-1",
      lastReviewVerdictId: "review-verdict:issue-1:verdict-1",
      completionReports: [completionReportRecord(candidate)],
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
    const orchestrator = new Orchestrator({
      config,
      tracker: {
        async fetchCandidateIssues() {
          return [];
        },
        async fetchIssuesByStates() {
          return [];
        },
        async fetchIssueStatesByIds() {
          return [];
        },
      },
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger: new StructuredLogger(() => undefined) }),
      harness: new FakeHarness(),
      logger: new StructuredLogger(() => undefined),
      promptTemplate: "Work on {{ issue.identifier }}",
      lifecycleStore,
    });

    const prompt = await (orchestrator as any).loadWorkerReviewEvidencePrompt({
      issue: candidateWithContext,
      lifecycle: await lifecycleStore.get(candidate.id),
      activeRunId: null,
      runId: null,
    });

    expect(calls.map((call) => call.authorization)).toEqual([
      "Bearer docs-review-read-secret",
      "Bearer docs-review-read-secret",
      "Bearer docs-review-read-secret",
      "Bearer docs-review-read-secret",
    ]);
    expect(prompt).toContain("PR review feedback to address");
    expect(prompt).toContain("Please address the reviewer-owned evidence path.");
  });

  it("injects the latest fail verdict findings and workspace context into the next worker prompt", async () => {
    const config = testConfig(root);
    const candidate = issue({ state: "In Progress", branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates() {
        return [];
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
    expect(harness.runs[0]?.prompt).toContain("Reviewer findings to address");
    expect(harness.runs[0]?.prompt).toContain("Lifecycle counters:");
    expect(harness.runs[0]?.prompt).toContain("Review rounds: 0");
    expect(harness.runs[0]?.prompt).toContain("Latest workspace/git evidence:");
    expect(harness.runs[0]?.prompt).toContain("Branch: symphony/TEST-1");
    expect(harness.runs[0]?.prompt).toContain("Pull request: #42 https://github.com/acme/symphony/pull/42");
    expect(harness.runs[0]?.prompt).toContain("Acceptance criteria gaps:");
    expect(harness.runs[0]?.prompt).toContain("Duplicate verdicts are idempotent");
    expect(harness.runs[0]?.prompt).toContain("Add regression coverage for duplicate verdict submissions.");
    expect(harness.runs[0]?.prompt).toContain("https://github.com/acme/symphony/pull/42#discussion_r1");
  });

  it("injects dedicated merge-gate repair context instead of reviewer-fail framing", async () => {
    const config = testConfig(root);
    const candidate = issue({ state: "In Progress", branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates() {
        return [];
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
    expect(harness.runs[0]?.prompt).not.toContain("Reviewer findings to address");
  });

  it("shows head-advanced guidance without old-head repair context after the current PR head advances", async () => {
    const config = testConfig(root);
    const candidate = issue({ state: "In Progress", branchName: "symphony/TEST-1" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates() {
        return [];
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
    expect(harness.runs[0]?.prompt).toContain("Reviewer findings to address");
    expect(harness.runs[0]?.prompt).toContain("Add regression coverage for the current PR head.");
    expect(harness.runs[0]?.prompt).not.toContain("## Symphony Merge Gate Repair");
    expect(harness.runs[0]?.prompt).not.toContain("test: failing / failure (https://ci.test/test)");
    expect(harness.runs[0]?.prompt).not.toContain("Repair the Symphony merge-gate checks");
    expect(harness.runs[0]?.prompt).not.toContain("completion-report:issue-1:repair-1");
  });

  it("cancels an active issue without retrying it", async () => {
    const config = testConfig(root);
    const candidate = issue({ state: "Todo" });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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
      async fetchIssuesByStates() {
        return [];
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
    expect(harness.runs[1]?.prompt).toContain("address the underlying invariant");
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
      async fetchIssuesByStates() {
        return [];
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
      "/api/v1/issues/issue-1",
      "/api/v1/issues/issue-1/runs",
      "/api/v1/runs/prior-run-1",
    ]);
    expect(storedLifecycle?.summaryReferences).toEqual([createdSummary.summaryReference]);
    expect(harness.runs).toHaveLength(2);
    expect(harness.runs[1]?.prompt).toContain("Mode: summary");
    expect(harness.runs[1]?.prompt).toContain(`Reference: ${createdSummary.summaryReference.id}`);
    expect(harness.runs[1]?.prompt).toContain("Continuation history summarization is not automated yet.");
    expect(harness.runs[1]?.prompt).toContain("/api/v1/runs/prior-run-1/transcript");
    expect(harness.runs[1]?.prompt).toContain("/api/v1/issues/issue-1");
    expect(harness.runs[1]?.prompt).toContain("/api/v1/runs/prior-run-1");
    expect(harness.runs[1]?.prompt).not.toContain("Full relevant history:");
  });

  it("scopes continuation summaries to the lifecycle project context when duplicate identifiers collide", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-orchestrator-summary-scope-"));
    const config = testConfig(path.join(root, "workspaces"));
    const candidate = trackerIssue({
      id: "issue-docs-1",
      identifier: "ENG-123",
      state: "Todo",
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      branchName: "symphony/docs/ENG-123",
    });
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return [candidate];
      },
      async fetchIssuesByStates() {
        return [];
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
      runId: "docs-run-1",
      sessionId: "docs-session-1",
      agentId: "docs-agent-1",
      role: "worker",
      issueId: candidate.id,
      issueIdentifier: candidate.identifier,
      projectContext: {
        projectContextId: "docs",
        projectContextLabel: "Documentation Site",
        linearProjectSlug: "DOCS",
        routingSource: "candidate_poll",
      },
      attempt: null,
      turnNumber: 1,
      prompt: "Docs worker prompt",
      workspaceKey: "docs__ENG-123",
      workspacePath: path.join(root, "docs-eng-123"),
      gitBranchName: "symphony/docs/ENG-123",
      repoPath: root,
      baseRef: "main",
    });
    await runStore.appendEvent({
      runId: "docs-run-1",
      at: "2026-01-01T00:00:01Z",
      source: "harness",
      eventType: "progress",
      message: "Docs context gathered.",
    });
    await runStore.startRun({
      runId: "symphony-run-1",
      sessionId: "symphony-session-1",
      agentId: "symphony-agent-1",
      role: "worker",
      issueId: "issue-symphony-1",
      issueIdentifier: candidate.identifier,
      projectContext: {
        projectContextId: "symphony",
        projectContextLabel: "Symphony",
        linearProjectSlug: "ENG",
        routingSource: "candidate_poll",
      },
      attempt: null,
      turnNumber: 1,
      prompt: "Symphony worker prompt",
      workspaceKey: "symphony__ENG-123",
      workspacePath: path.join(root, "symphony-eng-123"),
      gitBranchName: "symphony/symphony/ENG-123",
      repoPath: root,
      baseRef: "main",
    });
    await runStore.appendEvent({
      runId: "symphony-run-1",
      at: "2026-01-01T00:00:02Z",
      source: "harness",
      eventType: "progress",
      message: "Sibling context should not bleed into docs summary.",
    });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager: new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger }),
      harness: new FakeHarness(),
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      runStore,
      lifecycleStore,
    });

    try {
      const createdSummary = await orchestrator.createContinuationSummary(candidate);

      expect(createdSummary.summaryReference.runIds).toEqual(["docs-run-1"]);
      expect(createdSummary.summaryReference.transcriptPointers).toEqual(["/api/v1/runs/docs-run-1/transcript"]);
      expect(createdSummary.summaryReference.statusApiPointers).toEqual([
        "/api/v1/issues/issue-docs-1",
        "/api/v1/issues/issue-docs-1/runs",
        "/api/v1/runs/docs-run-1",
      ]);
      expect(createdSummary.summaryReference.summary).not.toContain("Sibling context should not bleed into docs summary.");
    } finally {
      await orchestrator.stop();
      await rm(root, { recursive: true, force: true });
    }
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
  projectContext?: {
    projectContextId: string;
    projectContextLabel: string;
    linearProjectSlug: string;
    routingSource: string;
  },
): IssueLifecyclePatch {
  return {
    phase: "blocked",
    ...(projectContext === undefined ? {} : { projectContext }),
    blockedReason,
    lastCompletionReportId: `completion-report:${candidate.id}:idem-1`,
    completionReports: [
      {
        ...completionReportRecord(candidate),
        runId,
        branchName: candidate.branchName,
        pullRequest: null,
        ...(projectContext === undefined ? {} : { projectContext }),
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
  projectContext?: {
    projectContextId: string;
    projectContextLabel: string;
    linearProjectSlug: string;
    routingSource: string;
  },
): OperatorApprovalRecord {
  return {
    requestId: `approval-${status}`,
    status,
    issueId: candidate.id,
    issueIdentifier: candidate.identifier,
    runId,
    evidenceCursor: "idem-1",
    dedupeKey: `${runId}:idem-1:push_and_pr`,
    ...(projectContext === undefined ? {} : { projectContext }),
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
    roles: { worker?: Record<string, string>; reviewer?: Record<string, string>; service?: Record<string, string> };
    env: Record<string, string>;
    projectContexts?: Array<Record<string, unknown>>;
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
      ...(input.projectContexts === undefined ? {} : { project_contexts: input.projectContexts }),
    },
    path.join(workspaceRoot, "WORKFLOW.md"),
    {
      LINEAR_API_KEY: "linear-test-key",
      ...input.env,
    },
  );
}

async function initPublishRepo(root: string, options: { remote?: boolean } = {}): Promise<string> {
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await git(["init"], workspace);
  await git(["checkout", "-b", "main"], workspace);
  await writeFile(path.join(workspace, "README.md"), "hello\n", "utf8");
  await git(["add", "README.md"], workspace);
  await git(["-c", "user.name=Symphony Test", "-c", "user.email=symphony@example.com", "commit", "-m", "initial"], workspace);
  if (options.remote) {
    const remote = path.join(root, "remote.git");
    await git(["init", "--bare", remote], root);
    await git(["remote", "add", "origin", remote], workspace);
  }
  await git(["checkout", "-b", "symphony/TEST-1"], workspace);
  return workspace;
}

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`git exited with ${code}: ${stderr}`));
    });
  });
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
    async fetchIssuesByStates() {
      return [];
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
    const item = activity.find((candidate) => candidate.id === `writeback:${writebackIdentityKey(key)}`);
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
    async fetchIssuesByStates() {
      return [];
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
    async fetchIssuesByStates() {
      return [];
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
          projectContext: ctx.projectContext,
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
            satisfied: runNumber === 2,
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
    async fetchIssuesByStates() {
      return [];
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

class FakeMergePolicyClient implements MergePolicyGitHubClient {
  mergeInput: Parameters<MergePolicyGitHubClient["mergePullRequest"]>[0] | null = null;

  async getPullRequest() {
    return {
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/docs/DOCS-1",
      headSha: "head-sha-1",
      lastPushedAt: "2026-01-01T00:00:00Z",
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

  async getRequiredCheckResults(input: { requiredChecks: string[] }): Promise<PullRequestCheckResult[]> {
    return input.requiredChecks.map((name) => ({
      name,
      status: "success",
      conclusion: "success",
      url: `https://ci.test/${name}`,
    }));
  }

  async mergePullRequest(input: Parameters<MergePolicyGitHubClient["mergePullRequest"]>[0]) {
    this.mergeInput = input;
    return {
      merged: true,
      mergeCommitSha: "merge-sha-1",
      mergedAt: "2026-01-01T00:00:02.000Z",
      mergedBy: "symphony-bot",
    };
  }

  async getAuthenticatedLogin() {
    return "symphony-bot";
  }

  async isAncestor() {
    return true;
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

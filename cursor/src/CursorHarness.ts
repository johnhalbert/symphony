import { Agent, type Run, type SDKAgent, type SettingSource } from "@cursor/sdk";
import path from "node:path";
import type { ModelSelection } from "@cursor/sdk";
import type { AgentEvent, AgentHarness, AgentRunContext } from "../../src/core/harness/AgentHarness.js";
import { writeCompletionReportMcpContext } from "../../src/core/harness/CompletionReportMcpServer.js";
import { writeReviewFeedbackMcpContext } from "../../src/core/harness/ReviewFeedbackMcpServer.js";
import { writeReviewVerdictMcpContext } from "../../src/core/harness/ReviewVerdictMcpServer.js";
import { writeTranscriptRecallMcpContext } from "../../src/core/harness/TranscriptRecallMcpServer.js";
import {
  buildMcpSubprocessServerConfig,
  type McpSubprocessServerConfig,
} from "../../src/core/harness/McpSubprocessEnvironment.js";
import { errorMessage, SymphonyError } from "../../src/core/errors.js";
import type { RunTranscriptStore } from "../../src/core/persistence/RunTranscriptStore.js";
import { resolveCursorRuntimeApiKey } from "../../src/app/RuntimeDependencies.js";
import { mapCursorDelta, mapCursorMessage } from "./CursorEventMapper.js";

export interface CursorHarnessOptions {
  runStore?: RunTranscriptStore;
}

interface CursorAgentLease {
  agent: SDKAgent;
  created: boolean;
  resumeAttempted: boolean;
  resumeUsed: boolean;
  outcome: "created" | "resumed" | "reused";
}

export class CursorHarness implements AgentHarness {
  readonly id = "cursor";
  private readonly agents = new Map<string, SDKAgent>();
  private readonly activeRuns = new Map<string, Run>();

  constructor(private readonly options: CursorHarnessOptions = {}) {}

  async prepare(ctx: AgentRunContext): Promise<void> {
    await writeInitialRoleMcpContexts(ctx);
    if (shouldReuseAgent(ctx)) await this.getOrCreateAgent(ctx);
  }

  async reload(ctx: AgentRunContext): Promise<void> {
    if (!shouldReuseAgent(ctx)) return;
    const agent = await this.getOrCreateAgent(ctx);
    await agent.reload();
  }

  async *run(ctx: AgentRunContext, prompt: string): AsyncIterable<AgentEvent> {
    const reusable = shouldReuseAgent(ctx);
    const lease = reusable ? await this.getOrCreateAgentLease(ctx) : await this.createAgent(ctx, { allowResume: false });
    const agent = lease.agent;
    const deltaEvents: AgentEvent[] = [];
    const cliPath = currentSymphonyCliPath();
    const runOptions = cursorAgentSendOptions(ctx, {
      mcpServers: cursorRoleMcpServers(ctx, { cliPath }),
      onDelta: ({ update }) => {
        deltaEvents.push(...mapCursorDelta(update));
      },
    });
    let run: Run;
    try {
      run = await agent.send(prompt, runOptions);
    } catch (error) {
      if (!reusable) {
        this.agents.delete(agentKey(ctx));
        await this.disposeAgent(agent, ctx, "send_failed");
      }
      throw error;
    }

    this.activeRuns.set(run.id, run);
    const abort = () => {
      void run.cancel().catch((error) => {
        ctx.logger.warn("cursor sdk run cancel failed", {
          run_id: run.id,
          issue_id: ctx.issue.id,
          issue_identifier: ctx.issue.identifier,
          role: ctx.role,
          error: errorMessage(error),
        });
      });
    };
    ctx.abortSignal.addEventListener("abort", abort, { once: true });
    if (ctx.abortSignal.aborted) abort();

    try {
      if (ctx.role === "worker") {
        await writeCompletionReportMcpContext(completionReportContextFilePath(ctx), {
          issue: ctx.issue,
          activeRunId: run.id,
          role: "worker",
          token: null,
          expectedToken: null,
          sessionId: `${agent.agentId}:${run.id}`,
          workspacePath: ctx.workspace.path,
          workspace: ctx.workspace,
          phase: "implementation",
        });
      }
      if (ctx.config.continuationContext.searchEnabled) {
        await writeTranscriptRecallMcpContext(transcriptRecallContextFilePath(ctx), {
          issue: ctx.issue,
          activeRunId: run.id,
          role: ctx.role,
          phase: ctx.role === "reviewer" ? "review" : "implementation",
        });
      }
      if (ctx.role === "reviewer") {
        await writeReviewVerdictMcpContext(reviewVerdictContextFilePath(ctx), {
          issue: ctx.issue,
          activeRunId: run.id,
          role: "reviewer",
          token: null,
          expectedToken: null,
          reviewer: `${agent.agentId}:${run.id}`,
          phase: "review",
        });
        await writeReviewFeedbackMcpContext(reviewFeedbackContextFilePath(ctx), {
          issue: ctx.issue,
          activeRunId: run.id,
          role: "reviewer",
          token: null,
          expectedToken: null,
          reviewer: `${agent.agentId}:${run.id}`,
          phase: "review",
        });
      }
      yield {
        type: "session_started",
        sessionId: `${agent.agentId}:${run.id}`,
        threadId: agent.agentId,
        runId: run.id,
      };
      await this.options.runStore?.updateRun(run.id, {
        sessionId: `${agent.agentId}:${run.id}`,
        agentId: agent.agentId,
      });
      await this.options.runStore?.appendEvent({
        runId: run.id,
        at: new Date().toISOString(),
        source: "cursor",
        eventType: "cursor_agent_lifecycle",
        message: `Cursor agent ${lease.outcome}; resumeUsed=${lease.resumeUsed}`,
        payload: {
          agentId: agent.agentId,
          lifecycleMode: ctx.config.cursor.workerAgentLifecycle,
          reusable,
          created: lease.created,
          resumeAttempted: lease.resumeAttempted,
          resumeUsed: lease.resumeUsed,
          outcome: lease.outcome,
        },
      });

      for await (const message of run.stream()) {
        const transcriptEvent = cursorTranscriptEvent(message);
        if (transcriptEvent) {
          await this.options.runStore?.appendEvent({
            runId: run.id,
            at: new Date().toISOString(),
            source: "cursor",
            ...transcriptEvent,
          });
        }
        for (const event of flush(deltaEvents)) yield event;
        for (const event of mapCursorMessage(message)) yield event;
      }
      for (const event of flush(deltaEvents)) yield event;

      const result = await run.wait();
      if (result.status === "finished") {
        yield result.result === undefined
          ? { type: "completed" }
          : { type: "completed", message: result.result };
      } else if (result.status === "cancelled") {
        yield { type: "cancelled" };
      } else {
        yield { type: "failed", error: result.result ?? "Cursor run failed" };
      }
    } catch (error) {
      throw new SymphonyError("agent_error", `Cursor run failed: ${errorMessage(error)}`, error);
    } finally {
      ctx.abortSignal.removeEventListener("abort", abort);
      this.activeRuns.delete(run.id);
      if (!reusable) {
        this.agents.delete(agentKey(ctx));
        const dispose = await this.disposeAgent(agent, ctx, "run_finished");
        await this.options.runStore?.appendEvent({
          runId: run.id,
          at: new Date().toISOString(),
          source: "cursor",
          eventType: "cursor_agent_disposed",
          message: dispose.ok ? "Cursor agent disposed" : `Cursor agent dispose failed: ${dispose.error}`,
          payload: {
            agentId: agent.agentId,
            ok: dispose.ok,
            reason: "run_finished",
            ...(dispose.error === null ? {} : { error: dispose.error }),
          },
        });
      }
    }
  }

  async stop(runId: string): Promise<void> {
    const run = this.activeRuns.get(runId);
    if (run) await run.cancel();
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.agents.values()].map((agent) => this.disposeAgent(agent, null, "harness_dispose")));
    this.agents.clear();
  }

  private async getOrCreateAgent(ctx: AgentRunContext): Promise<SDKAgent> {
    return (await this.getOrCreateAgentLease(ctx)).agent;
  }

  private async getOrCreateAgentLease(ctx: AgentRunContext): Promise<CursorAgentLease> {
    const key = agentKey(ctx);
    const existing = this.agents.get(key);
    if (existing) return { agent: existing, created: false, resumeAttempted: false, resumeUsed: false, outcome: "reused" };

    const lease = await this.createAgent(ctx, { allowResume: true });
    this.agents.set(key, lease.agent);
    return lease;
  }

  private async createAgent(ctx: AgentRunContext, options: { allowResume: boolean }): Promise<CursorAgentLease> {
    const cliPath = currentSymphonyCliPath();
    await writeInitialRoleMcpContexts(ctx);
    const mcpServers = cursorRoleMcpServers(ctx, { cliPath });
    const createOptions = cursorAgentCreateOptions(ctx, resolveCursorRuntimeApiKey(ctx.config, ctx.role), {
      mcpServers,
    });
    const resumeOptions = cursorAgentBaseOptions(ctx, resolveCursorRuntimeApiKey(ctx.config, ctx.role), {
      mcpServers,
    });
    const latestRun =
      options.allowResume && ctx.role === "worker"
        ? await this.options.runStore?.latestRunForIssue(ctx.issue.id, { role: "worker" })
        : null;
    let agent: SDKAgent;
    if (latestRun?.agentId) {
      try {
        agent = await Agent.resume(latestRun.agentId, resumeOptions);
        return { agent, created: false, resumeAttempted: true, resumeUsed: true, outcome: "resumed" };
      } catch (error) {
        ctx.logger.warn("cursor agent resume failed; creating a new agent", {
          agent_id: latestRun.agentId,
          workspace_path: ctx.workspace.path,
          error: errorMessage(error),
        });
        agent = await Agent.create(createOptions);
        return { agent, created: true, resumeAttempted: true, resumeUsed: false, outcome: "created" };
      }
    } else {
      agent = await Agent.create(createOptions);
      return { agent, created: true, resumeAttempted: false, resumeUsed: false, outcome: "created" };
    }
  }

  private async disposeAgent(agent: SDKAgent, ctx: AgentRunContext | null, reason: string): Promise<{ ok: boolean; error: string | null }> {
    try {
      await agent[Symbol.asyncDispose]();
      return { ok: true, error: null };
    } catch (error) {
      const message = errorMessage(error);
      ctx?.logger.warn("cursor sdk agent dispose failed", {
        agent_id: agent.agentId,
        issue_id: ctx.issue.id,
        issue_identifier: ctx.issue.identifier,
        role: ctx.role,
        reason,
        error: message,
      });
      return { ok: false, error: message };
    }
  }
}

function shouldReuseAgent(ctx: AgentRunContext): boolean {
  return ctx.role === "worker" && ctx.config.cursor.workerAgentLifecycle === "resume_by_issue";
}

function flush(events: AgentEvent[]): AgentEvent[] {
  return events.splice(0, events.length);
}

function cursorTranscriptEvent(message: unknown): { eventType: string; message?: string; payload?: unknown } | null {
  if (!isCursorMessageRecord(message)) return { eventType: "unknown" };
  switch (message.type) {
    case "user":
      return null;
    case "thinking":
      return { eventType: "thinking", message: "Cursor thinking event" };
    case "tool_call":
      return {
        eventType: "tool_call",
        message: `tool ${typeof message.name === "string" ? message.name : "unknown"} ${typeof message.status === "string" ? message.status : "unknown"}`,
      };
    case "assistant":
      return { eventType: "assistant", message: "Cursor assistant message" };
    case "task":
      return { eventType: "task", message: "Cursor task event" };
    case "status":
      return { eventType: "status", message: typeof message.status === "string" ? `Cursor status ${message.status}` : "Cursor status event" };
    case "system":
      return {
        eventType: "system",
        message: `Cursor system event: ${typeof message.subtype === "string" ? message.subtype : "system"}`,
      };
    case "request":
      return { eventType: "request", message: "Cursor requested external input" };
    default:
      return { eventType: message.type };
  }
}

function isCursorMessageRecord(value: unknown): value is { type: string; [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as { type?: unknown }).type === "string";
}

export function cursorAgentCreateOptions(
  ctx: AgentRunContext,
  apiKey: string | null | undefined = resolveCursorRuntimeApiKey(ctx.config, ctx.role),
  options: { mcpServers?: Record<string, McpSubprocessServerConfig> } = {},
): Parameters<typeof Agent.create>[0] {
  return {
    ...cursorAgentBaseOptions(ctx, apiKey, options),
    ...cursorConversationModeOption(ctx),
  };
}

function cursorAgentBaseOptions(
  ctx: AgentRunContext,
  apiKey: string | null | undefined,
  options: { mcpServers?: Record<string, McpSubprocessServerConfig> } = {},
): Parameters<typeof Agent.create>[0] {
  return {
    model: cursorModelSelection(ctx),
    local: {
      cwd: ctx.workspace.path,
      settingSources: ctx.config.cursor.settingSources as SettingSource[],
    },
    name: cursorAgentName(ctx),
    ...(apiKey ? { apiKey } : {}),
    ...(options.mcpServers === undefined ? {} : { mcpServers: options.mcpServers }),
  };
}

export function cursorAgentSendOptions(
  ctx: AgentRunContext,
  options: {
    mcpServers?: Record<string, McpSubprocessServerConfig>;
    onDelta?: NonNullable<Parameters<SDKAgent["send"]>[1]>["onDelta"];
  } = {},
): NonNullable<Parameters<SDKAgent["send"]>[1]> {
  return {
    model: cursorModelSelection(ctx),
    ...cursorConversationModeOption(ctx),
    local: { force: true },
    ...(options.onDelta === undefined ? {} : { onDelta: options.onDelta }),
    ...(options.mcpServers === undefined ? {} : { mcpServers: options.mcpServers }),
  };
}

function cursorConversationModeOption(ctx: AgentRunContext): { mode?: "agent" | "plan" } {
  return ctx.config.cursor.mode === null ? {} : { mode: ctx.config.cursor.mode };
}

export function cursorRoleMcpServers(
  ctx: AgentRunContext,
  options: { cliPath: string; mcpCwd?: string },
): Record<string, McpSubprocessServerConfig> {
  const applyCwd = (server: McpSubprocessServerConfig): McpSubprocessServerConfig =>
    options.mcpCwd === undefined ? server : { ...server, cwd: options.mcpCwd };
  if (ctx.role === "worker") {
    return {
      symphony: applyCwd(completionReportMcpServerConfig(ctx, completionReportContextFilePath(ctx), options)),
      ...transcriptRecallMcpServerEntry(ctx, options, applyCwd),
    };
  }
  return {
    symphony_review_verdict: applyCwd(reviewVerdictMcpServerConfig(ctx, reviewVerdictContextFilePath(ctx), options)),
    symphony_review_feedback: applyCwd(reviewFeedbackMcpServerConfig(ctx, reviewFeedbackContextFilePath(ctx), options)),
    ...transcriptRecallMcpServerEntry(ctx, options, applyCwd),
  };
}

export async function writeInitialRoleMcpContexts(ctx: AgentRunContext): Promise<void> {
  if (ctx.config.continuationContext.searchEnabled) {
    await writeTranscriptRecallMcpContext(transcriptRecallContextFilePath(ctx), {
      issue: ctx.issue,
      activeRunId: null,
      role: ctx.role,
      phase: ctx.role === "reviewer" ? "review" : "implementation",
    });
  }
  if (ctx.role === "worker") {
    await writeCompletionReportMcpContext(completionReportContextFilePath(ctx), {
      issue: ctx.issue,
      activeRunId: null,
      role: "worker",
      token: null,
      expectedToken: null,
      sessionId: null,
      workspacePath: ctx.workspace.path,
      workspace: ctx.workspace,
      phase: "implementation",
    });
    return;
  }
  await writeReviewVerdictMcpContext(reviewVerdictContextFilePath(ctx), {
    issue: ctx.issue,
    activeRunId: null,
    role: "reviewer",
    token: null,
    expectedToken: null,
    reviewer: null,
    phase: "review",
  });
  await writeReviewFeedbackMcpContext(reviewFeedbackContextFilePath(ctx), {
    issue: ctx.issue,
    activeRunId: null,
    role: "reviewer",
    token: null,
    expectedToken: null,
    reviewer: null,
    phase: "review",
  });
}

function transcriptRecallMcpServerEntry(
  ctx: AgentRunContext,
  options: { cliPath: string },
  applyCwd: (server: McpSubprocessServerConfig) => McpSubprocessServerConfig,
): Record<string, McpSubprocessServerConfig> {
  return ctx.config.continuationContext.searchEnabled
    ? {
        symphony_recall: applyCwd(transcriptRecallMcpServerConfig(ctx, transcriptRecallContextFilePath(ctx), options)),
      }
    : {};
}

export function cursorAgentName(ctx: AgentRunContext): string {
  return ctx.role === "reviewer" ? `Symphony reviewer ${ctx.issue.identifier}` : `Symphony ${ctx.issue.identifier}`;
}

export function cursorModelSelection(ctx: AgentRunContext): ModelSelection {
  return ctx.config.cursor.modelParams.length === 0
    ? { id: ctx.config.cursor.model }
    : { id: ctx.config.cursor.model, params: ctx.config.cursor.modelParams };
}

export function completionReportMcpServerConfig(
  ctx: AgentRunContext,
  contextFile: string,
  options: { cliPath: string },
): McpSubprocessServerConfig {
  return buildMcpSubprocessServerConfig({
    config: ctx.config,
    command: "completion-report-mcp",
    cliPath: options.cliPath,
    workflowPath: ctx.config.workflowPath,
    contextFile,
  });
}

export function reviewVerdictMcpServerConfig(
  ctx: AgentRunContext,
  contextFile: string,
  options: { cliPath: string },
): McpSubprocessServerConfig {
  return buildMcpSubprocessServerConfig({
    config: ctx.config,
    command: "review-verdict-mcp",
    cliPath: options.cliPath,
    workflowPath: ctx.config.workflowPath,
    contextFile,
  });
}

export function reviewFeedbackMcpServerConfig(
  ctx: AgentRunContext,
  contextFile: string,
  options: { cliPath: string },
): McpSubprocessServerConfig {
  return buildMcpSubprocessServerConfig({
    config: ctx.config,
    command: "review-feedback-mcp",
    cliPath: options.cliPath,
    workflowPath: ctx.config.workflowPath,
    contextFile,
  });
}

export function transcriptRecallMcpServerConfig(
  ctx: AgentRunContext,
  contextFile: string,
  options: { cliPath: string },
): McpSubprocessServerConfig {
  return buildMcpSubprocessServerConfig({
    config: ctx.config,
    command: "transcript-recall-mcp",
    cliPath: options.cliPath,
    workflowPath: ctx.config.workflowPath,
    contextFile,
  });
}

export function completionReportContextFilePath(ctx: AgentRunContext): string {
  return path.join(
    ctx.config.workspace.stateDir,
    "completion-report-mcp",
    `${safeFileName(ctx.issue.id)}-${ctx.turnNumber}.json`,
  );
}

export function reviewVerdictContextFilePath(ctx: AgentRunContext): string {
  return path.join(
    ctx.config.workspace.stateDir,
    "review-verdict-mcp",
    `${safeFileName(ctx.issue.id)}-${ctx.turnNumber}.json`,
  );
}

export function reviewFeedbackContextFilePath(ctx: AgentRunContext): string {
  return path.join(
    ctx.config.workspace.stateDir,
    "review-feedback-mcp",
    `${safeFileName(ctx.issue.id)}-${ctx.turnNumber}.json`,
  );
}

export function transcriptRecallContextFilePath(ctx: AgentRunContext): string {
  return path.join(
    ctx.config.workspace.stateDir,
    "transcript-recall-mcp",
    `${safeFileName(ctx.issue.id)}-${ctx.role}-${ctx.turnNumber}.json`,
  );
}

function agentKey(ctx: AgentRunContext): string {
  return ctx.role === "reviewer" ? `${ctx.workspace.path}:reviewer` : `${ctx.workspace.path}:worker`;
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_") || "context";
}

function currentSymphonyCliPath(): string {
  return process.argv[1] ?? path.resolve("dist/cli.js");
}


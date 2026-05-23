import { Agent, type Run, type SDKAgent, type SettingSource } from "@cursor/sdk";
import path from "node:path";
import type { ModelSelection } from "@cursor/sdk";
import type { AgentEvent, AgentHarness, AgentRunContext } from "../../src/core/harness/AgentHarness.js";
import { writeCompletionReportMcpContext } from "../../src/core/harness/CompletionReportMcpServer.js";
import { writeReviewFeedbackMcpContext } from "../../src/core/harness/ReviewFeedbackMcpServer.js";
import { writeReviewVerdictMcpContext } from "../../src/core/harness/ReviewVerdictMcpServer.js";
import {
  buildMcpSubprocessServerConfig,
  type McpSubprocessServerConfig,
} from "../../src/core/harness/McpSubprocessEnvironment.js";
import { errorMessage, SymphonyError } from "../../src/core/errors.js";
import type { RunTranscriptStore } from "../../src/core/persistence/RunTranscriptStore.js";
import { mapCursorDelta, mapCursorMessage } from "./CursorEventMapper.js";

export interface CursorHarnessOptions {
  runStore?: RunTranscriptStore;
}

export class CursorHarness implements AgentHarness {
  readonly id = "cursor";
  private readonly agents = new Map<string, SDKAgent>();
  private readonly activeRuns = new Map<string, Run>();

  constructor(private readonly options: CursorHarnessOptions = {}) {}

  async prepare(ctx: AgentRunContext): Promise<void> {
    await this.getOrCreateAgent(ctx);
  }

  async reload(ctx: AgentRunContext): Promise<void> {
    const agent = await this.getOrCreateAgent(ctx);
    await agent.reload();
  }

  async *run(ctx: AgentRunContext, prompt: string): AsyncIterable<AgentEvent> {
    const agent = await this.getOrCreateAgent(ctx);
    const deltaEvents: AgentEvent[] = [];
    const cliPath = currentSymphonyCliPath();
    await writeInitialRoleMcpContexts(ctx);
    const runOptions: NonNullable<Parameters<SDKAgent["send"]>[1]> = {
      model: cursorModelSelection(ctx),
      local: { force: true },
      onDelta: ({ update }) => {
        deltaEvents.push(...mapCursorDelta(update));
      },
      mcpServers: cursorRoleMcpServers(ctx, { cliPath }),
    };
    let run: Run;
    try {
      run = await agent.send(prompt, runOptions);
    } catch (error) {
      if (ctx.role === "reviewer") {
        this.agents.delete(agentKey(ctx));
        await agent[Symbol.asyncDispose]().catch(() => undefined);
      }
      throw error;
    }

    this.activeRuns.set(run.id, run);
    const abort = () => {
      void run.cancel();
    };
    ctx.abortSignal.addEventListener("abort", abort, { once: true });

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

      for await (const message of run.stream()) {
        await this.options.runStore?.appendEvent({
          runId: run.id,
          at: new Date().toISOString(),
          source: "cursor",
          eventType: message.type,
          payload: message,
        });
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
      if (ctx.role === "reviewer") {
        this.agents.delete(agentKey(ctx));
        await agent[Symbol.asyncDispose]();
      }
    }
  }

  async stop(runId: string): Promise<void> {
    const run = this.activeRuns.get(runId);
    if (run) await run.cancel();
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.agents.values()].map((agent) => agent[Symbol.asyncDispose]()));
    this.agents.clear();
  }

  private async getOrCreateAgent(ctx: AgentRunContext): Promise<SDKAgent> {
    const key = agentKey(ctx);
    const existing = this.agents.get(key);
    if (existing) return existing;

    const cliPath = currentSymphonyCliPath();
    await writeInitialRoleMcpContexts(ctx);
    const agentOptions = cursorAgentCreateOptions(ctx, process.env.CURSOR_API_KEY, {
      mcpServers: cursorRoleMcpServers(ctx, { cliPath }),
    });
    const latestRun = ctx.role === "worker" ? await this.options.runStore?.latestRunForIssue(ctx.issue.id, { role: "worker" }) : null;
    let agent: SDKAgent;
    if (latestRun?.agentId) {
      try {
        agent = await Agent.resume(latestRun.agentId, agentOptions);
      } catch (error) {
        ctx.logger.warn("cursor agent resume failed; creating a new agent", {
          agent_id: latestRun.agentId,
          workspace_path: ctx.workspace.path,
          error: errorMessage(error),
        });
        agent = await Agent.create(agentOptions);
      }
    } else {
      agent = await Agent.create(agentOptions);
    }
    this.agents.set(key, agent);
    return agent;
  }
}

function flush(events: AgentEvent[]): AgentEvent[] {
  return events.splice(0, events.length);
}

export function cursorAgentCreateOptions(
  ctx: AgentRunContext,
  apiKey = process.env.CURSOR_API_KEY,
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

export function cursorRoleMcpServers(
  ctx: AgentRunContext,
  options: { cliPath: string; mcpCwd?: string },
): Record<string, McpSubprocessServerConfig> {
  const applyCwd = (server: McpSubprocessServerConfig): McpSubprocessServerConfig =>
    options.mcpCwd === undefined ? server : { ...server, cwd: options.mcpCwd };
  if (ctx.role === "worker") {
    return {
      symphony: applyCwd(completionReportMcpServerConfig(ctx, completionReportContextFilePath(ctx), options)),
    };
  }
  return {
    symphony_review_verdict: applyCwd(reviewVerdictMcpServerConfig(ctx, reviewVerdictContextFilePath(ctx), options)),
    symphony_review_feedback: applyCwd(reviewFeedbackMcpServerConfig(ctx, reviewFeedbackContextFilePath(ctx), options)),
  };
}

export async function writeInitialRoleMcpContexts(ctx: AgentRunContext): Promise<void> {
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

function agentKey(ctx: AgentRunContext): string {
  return ctx.role === "reviewer" ? `${ctx.workspace.path}:reviewer` : `${ctx.workspace.path}:worker`;
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_") || "context";
}

function currentSymphonyCliPath(): string {
  return process.argv[1] ?? path.resolve("dist/cli.js");
}


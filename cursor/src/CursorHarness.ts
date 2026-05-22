import { Agent, type Run, type SDKAgent, type SettingSource } from "@cursor/sdk";
import path from "node:path";
import type { ModelSelection } from "@cursor/sdk";
import type { AgentEvent, AgentHarness, AgentRunContext } from "../../src/core/harness/AgentHarness.js";
import { writeCompletionReportMcpContext } from "../../src/core/harness/CompletionReportMcpServer.js";
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
    const completionReportContextFile = completionReportContextFilePath(ctx);
    await writeCompletionReportMcpContext(completionReportContextFile, {
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
    const run = await agent.send(prompt, {
      model: cursorModelSelection(ctx),
      local: { force: true },
      mcpServers: {
        symphony: completionReportMcpServerConfig(ctx, completionReportContextFile),
      },
      onDelta: ({ update }) => {
        deltaEvents.push(...mapCursorDelta(update));
      },
    });

    this.activeRuns.set(run.id, run);
    const abort = () => {
      void run.cancel();
    };
    ctx.abortSignal.addEventListener("abort", abort, { once: true });

    yield {
      type: "session_started",
      sessionId: `${agent.agentId}:${run.id}`,
      threadId: agent.agentId,
      runId: run.id,
    };
    await writeCompletionReportMcpContext(completionReportContextFile, {
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
    await this.options.runStore?.updateRun(run.id, {
      sessionId: `${agent.agentId}:${run.id}`,
      agentId: agent.agentId,
    });

    try {
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
    const key = ctx.workspace.path;
    const existing = this.agents.get(key);
    if (existing) return existing;

    const apiKey = process.env.CURSOR_API_KEY;
    const model = cursorModelSelection(ctx);
    const agentOptions = {
      model,
      local: {
        cwd: ctx.workspace.path,
        settingSources: ctx.config.cursor.settingSources as SettingSource[],
      },
      name: `Symphony ${ctx.issue.identifier}`,
      ...(apiKey ? { apiKey } : {}),
    };
    const latestRun = await this.options.runStore?.latestRunForIssue(ctx.issue.id);
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

function cursorModelSelection(ctx: AgentRunContext): ModelSelection {
  return ctx.config.cursor.modelParams.length === 0
    ? { id: ctx.config.cursor.model }
    : { id: ctx.config.cursor.model, params: ctx.config.cursor.modelParams };
}

export function completionReportMcpServerConfig(ctx: AgentRunContext, contextFile: string): {
  type: "stdio";
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
} {
  return {
    type: "stdio",
    command: process.execPath,
    args: [
      ...process.execArgv,
      process.argv[1] ?? "dist/cli.js",
      "completion-report-mcp",
      "--workflow",
      ctx.config.workflowPath,
      "--context-file",
      contextFile,
    ],
    cwd: ctx.config.workflowDir,
    env: stringEnvironment(process.env),
  };
}

function completionReportContextFilePath(ctx: AgentRunContext): string {
  return path.join(
    ctx.config.workspace.stateDir,
    "completion-report-mcp",
    `${safeFileName(ctx.issue.id)}-${ctx.turnNumber}.json`,
  );
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_") || "context";
}

function stringEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

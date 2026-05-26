import { Agent, type Run, type SDKAgent, type SDKMessage, type SettingSource } from "@cursor/sdk";
import path from "node:path";
import type { ModelSelection } from "@cursor/sdk";
import type { AgentEvent, AgentHarness, AgentRunContext, AgentRunSdkStatus } from "../../src/core/harness/AgentHarness.js";
import { writeCompletionReportMcpContext } from "../../src/core/harness/CompletionReportMcpServer.js";
import { writeIssueBreakdownPlanMcpContext } from "../../src/core/harness/IssueBreakdownPlanMcpServer.js";
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

    const queue = new AsyncEventQueue<AgentEvent>();
    let sessionStarted = false;
    let waitStarted = false;
    let waitSettled = false;
    let streamSettled = false;
    let terminalByStatusObserved = false;
    let pendingTerminalEvents: AgentEvent[] | null = null;
    let streamIterator: AsyncIterator<unknown> | null = null;
    let lastToolContext: CursorLastToolContext | null = null;
    const bufferedStatusEvents: AgentEvent[] = [];
    const observableRun = run as Run & {
      readonly status?: unknown;
      onDidChangeStatus?: (listener: (status: AgentRunSdkStatus) => void) => () => void;
    };
    const enqueueStatus = (status: AgentRunSdkStatus, source: "initial" | "onDidChangeStatus" | "wait") => {
      const event: AgentEvent = {
        type: "run_status",
        runId: run.id,
        sdkStatus: status,
        source,
        at: new Date().toISOString(),
      };
      if (sessionStarted) {
        queue.push(event);
      } else {
        bufferedStatusEvents.push(event);
      }
      if (source !== "wait" && isTerminalSdkStatus(status)) {
        terminalByStatusObserved = true;
        if (sessionStarted) void finalizeFromWait();
      }
    };
    const contextualizeTerminalEvents = (events: AgentEvent[]) =>
      events.map((event) => {
        if (
          event.type !== "run_diagnostic" ||
          (event.code !== "cursor_run_wait_terminal_error" && event.code !== "cursor_run_wait_threw") ||
          typeof event.payload !== "object" ||
          event.payload === null ||
          Array.isArray(event.payload)
        ) {
          return event;
        }
        return {
          ...event,
          payload: {
            ...event.payload,
            streamSettled,
            terminalByStatusObserved,
            cancellationRequested: ctx.abortSignal.aborted,
            lastTool: lastToolContext,
          },
        };
      });
    const emitTerminalEvents = (events: AgentEvent[]) => {
      for (const event of contextualizeTerminalEvents(events)) queue.push(event);
      queue.close();
    };
    const finalizeFromWait = async () => {
      if (waitStarted) return;
      waitStarted = true;
      try {
        const result = await run.wait();
        waitSettled = true;
        const status = normalizeSdkRunStatus(result.status) ?? "error";
        const terminalEvents: AgentEvent[] = [
          {
            type: "run_status",
            runId: run.id,
            sdkStatus: status,
            source: "wait",
            at: new Date().toISOString(),
          },
        ];
        if (result.status === "finished") {
          terminalEvents.push(result.result === undefined ? { type: "completed" } : { type: "completed", message: result.result });
        } else if (result.status === "cancelled") {
          terminalEvents.push({ type: "cancelled" });
        } else {
          terminalEvents.push({
            type: "run_diagnostic",
            code: "cursor_run_wait_terminal_error",
            message: "Cursor run wait returned terminal SDK error",
            payload: {
              runId: run.id,
              agentId: agent.agentId,
              sdkStatus: status,
              sdkStatusSource: "wait",
              waitResultStatus: previewValue(result.status, 160),
              waitResultMessage: previewValue(result.result, 500),
              streamSettled,
              terminalByStatusObserved,
              cancellationRequested: ctx.abortSignal.aborted,
              lastTool: lastToolContext,
            },
          });
          terminalEvents.push({ type: "failed", error: result.result ?? "Cursor run failed" });
        }
        if (streamSettled || terminalByStatusObserved) emitTerminalEvents(terminalEvents);
        else pendingTerminalEvents = terminalEvents;
      } catch (error) {
        waitSettled = true;
        const terminalEvents: AgentEvent[] = [
          {
            type: "run_status",
            runId: run.id,
            sdkStatus: "error",
            source: "wait",
            at: new Date().toISOString(),
          },
          {
            type: "run_diagnostic",
            code: "cursor_run_wait_threw",
            message: `Cursor run wait threw: ${errorMessage(error)}`,
            payload: {
              runId: run.id,
              agentId: agent.agentId,
              sdkStatus: "error",
              sdkStatusSource: "wait",
              errorPreview: previewValue(errorMessage(error), 500),
              streamSettled,
              terminalByStatusObserved,
              cancellationRequested: ctx.abortSignal.aborted,
              lastTool: lastToolContext,
            },
          },
          { type: "failed", error: `Cursor run wait failed: ${errorMessage(error)}` },
        ];
        if (streamSettled || terminalByStatusObserved) emitTerminalEvents(terminalEvents);
        else pendingTerminalEvents = terminalEvents;
      }
    };
    const unsubscribeStatus =
      typeof observableRun.onDidChangeStatus === "function"
        ? observableRun.onDidChangeStatus((status) => {
            const normalized = normalizeSdkRunStatus(status) ?? normalizeSdkRunStatus(observableRun.status);
            if (normalized) enqueueStatus(normalized, "onDidChangeStatus");
          })
        : null;
    const initialStatus = normalizeSdkRunStatus(observableRun.status);
    if (initialStatus) enqueueStatus(initialStatus, "initial");

    try {
      if (ctx.role === "worker" && cursorRunPhase(ctx) === "implementation") {
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
      if (ctx.role === "worker" && cursorRunPhase(ctx) === "issue_breakdown") {
        await writeIssueBreakdownPlanMcpContext(issueBreakdownPlanContextFilePath(ctx), {
          issue: ctx.issue,
          activeRunId: run.id,
          role: "worker",
          workspacePath: ctx.workspace.path,
          workspace: ctx.workspace,
          phase: "issue_breakdown",
        });
      }
      if (ctx.config.continuationContext.searchEnabled) {
        await writeTranscriptRecallMcpContext(transcriptRecallContextFilePath(ctx), {
          issue: ctx.issue,
          activeRunId: run.id,
          role: ctx.role,
          phase: cursorRunPhase(ctx),
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

      sessionStarted = true;
      for (const event of bufferedStatusEvents.splice(0, bufferedStatusEvents.length)) queue.push(event);
      void finalizeFromWait();
      const streamTask = (async () => {
        try {
          streamIterator = run.stream()[Symbol.asyncIterator]();
          while (true) {
            const next = await streamIterator.next();
            if (next.done) break;
            const message = next.value;
            const toolContext = cursorLastToolContext(message);
            if (toolContext) lastToolContext = toolContext;
            const transcriptEvent = cursorTranscriptEvent(message);
            if (transcriptEvent) {
              await this.options.runStore?.appendEvent({
                runId: run.id,
                at: new Date().toISOString(),
                source: "cursor",
                ...transcriptEvent,
              });
            }
            for (const event of flush(deltaEvents)) queue.push(event);
            for (const event of mapCursorMessage(message as SDKMessage)) queue.push(event);
          }
        } catch (error) {
          queue.push({
            type: "run_diagnostic",
            code: "cursor_stream_error",
            message: `Cursor stream failed: ${errorMessage(error)}`,
            payload: { error: errorMessage(error) },
          });
          void run.cancel().catch((cancelError) => {
            ctx.logger.warn("cursor sdk run cancel after stream failure failed", {
              run_id: run.id,
              issue_id: ctx.issue.id,
              issue_identifier: ctx.issue.identifier,
              role: ctx.role,
              error: errorMessage(cancelError),
            });
          });
        } finally {
          streamSettled = true;
          for (const event of flush(deltaEvents)) queue.push(event);
          if (pendingTerminalEvents) emitTerminalEvents(pendingTerminalEvents);
        }
      })();

      try {
        for await (const event of queue) yield event;
      } finally {
        if (!waitSettled) queue.close();
        const iterator = streamIterator as ({ return?: () => Promise<IteratorResult<unknown>> } & AsyncIterator<unknown>) | null;
        if (typeof iterator?.return === "function") void iterator.return().catch(() => undefined);
        void streamTask.catch(() => undefined);
      }
    } catch (error) {
      throw new SymphonyError("agent_error", `Cursor run failed: ${errorMessage(error)}`, error);
    } finally {
      unsubscribeStatus?.();
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
      options.allowResume && ctx.role === "worker" && cursorRunPhase(ctx) === "implementation"
        ? await this.options.runStore?.latestRunForIssue(ctx.issue.id, { role: "worker", runPhase: "implementation" })
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

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next(),
      return: async () => {
        this.close();
        return { value: undefined as never, done: true };
      },
    };
  }

  private async next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return { value, done: false };
    if (this.closed) return { value: undefined as never, done: true };
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

function normalizeSdkRunStatus(status: unknown): AgentRunSdkStatus | null {
  return status === "running" || status === "finished" || status === "error" || status === "cancelled" ? status : null;
}

function isTerminalSdkStatus(status: AgentRunSdkStatus): boolean {
  return status === "finished" || status === "error" || status === "cancelled";
}

interface CursorLastToolContext {
  name: string | null;
  status: string | null;
  observedAt: string;
}

function shouldReuseAgent(ctx: AgentRunContext): boolean {
  return ctx.role === "worker" && cursorRunPhase(ctx) === "implementation" && ctx.config.cursor.workerAgentLifecycle === "resume_by_issue";
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
      return {
        eventType: "thinking",
        message: "Cursor thinking event",
        payload: summaryPayload("thinking", message.text ?? message.message ?? message.content, 240),
      };
    case "tool_call":
      return {
        eventType: "tool_call",
        message: `tool ${typeof message.name === "string" ? message.name : "unknown"} ${typeof message.status === "string" ? message.status : "unknown"}`,
        payload: toolCallPayload(message),
      };
    case "assistant":
      return {
        eventType: "assistant",
        message: "Cursor assistant message",
        payload: textPayload("assistant", message.text ?? message.message ?? message.content, 500),
      };
    case "task":
      return {
        eventType: "task",
        message: "Cursor task event",
        payload: summaryPayload("task", message.text ?? message.message ?? message.content, 240),
      };
    case "status":
      return {
        eventType: "status",
        message: typeof message.status === "string" ? `Cursor status ${message.status}` : "Cursor status event",
        payload: {
          kind: "status",
          status: sanitizedPreviewValue(message.status, 160).preview ?? "unknown",
          messagePreview: sanitizedPreviewValue(message.message ?? message.text, 500).preview,
          truncated: sanitizedPreviewValue(message.message ?? message.text, 500).truncated,
        },
      };
    case "system":
      return {
        eventType: "system",
        message: `Cursor system event: ${typeof message.subtype === "string" ? message.subtype : "system"}`,
        payload: {
          kind: "system",
          subtype: sanitizedPreviewValue(message.subtype, 160).preview ?? "system",
          messagePreview: sanitizedPreviewValue(message.message ?? message.text, 500).preview,
          truncated: sanitizedPreviewValue(message.message ?? message.text, 500).truncated,
        },
      };
    case "request":
      return { eventType: "request", message: "Cursor requested external input" };
    default:
      return { eventType: message.type };
  }
}

function summaryPayload(kind: "thinking" | "task", value: unknown, maxLength: number): unknown {
  const preview = sanitizedPreviewValue(value, maxLength);
  return { kind, summary: preview.preview ?? "", truncated: preview.truncated, redacted: true };
}

function textPayload(kind: "assistant", value: unknown, maxLength: number): unknown {
  const preview = sanitizedPreviewValue(value, maxLength);
  return { kind, textPreview: preview.preview ?? "", truncated: preview.truncated };
}

function toolCallPayload(message: { [key: string]: unknown }): unknown {
  const payload: Record<string, unknown> = {
    kind: "tool_call",
    name: sanitizedPreviewValue(message.name, 160).preview ?? "unknown",
    status: sanitizedPreviewValue(message.status, 160).preview ?? "unknown",
    callId: sanitizedPreviewValue(message.callId ?? message.call_id ?? message.id, 160).preview,
    argumentsPreview: sanitizedPreviewValue(message.arguments ?? message.args ?? message.input, 500).preview,
    redacted: true,
    truncated: false,
  };
  for (const [field, outputField] of [
    ["result", "resultPreview"],
    ["output", "outputPreview"],
    ["error", "errorPreview"],
  ] as const) {
    const preview = sanitizedPreviewValue(message[field], 500);
    if (preview.preview !== null) payload[outputField] = preview.preview;
    payload.truncated = Boolean(payload.truncated) || preview.truncated;
  }
  const argumentPreview = sanitizedPreviewValue(message.arguments ?? message.args ?? message.input, 500);
  payload.truncated = Boolean(payload.truncated) || argumentPreview.truncated;
  return payload;
}

function cursorLastToolContext(message: unknown): CursorLastToolContext | null {
  if (!isCursorMessageRecord(message) || message.type !== "tool_call") return null;
  return {
    name: typeof message.name === "string" ? previewValue(message.name, 160) : null,
    status: typeof message.status === "string" ? previewValue(message.status, 160) : null,
    observedAt: new Date().toISOString(),
  };
}

function isCursorMessageRecord(value: unknown): value is { type: string; [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as { type?: unknown }).type === "string";
}

function previewValue(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  const text = typeof value === "string" ? value : safeJsonPreview(value);
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= maxLength ? oneLine : `${oneLine.slice(0, Math.max(maxLength - 15, 0))}...[truncated]`;
}

function sanitizedPreviewValue(value: unknown, maxLength: number): { preview: string | null; truncated: boolean } {
  if (value === undefined || value === null) return { preview: null, truncated: false };
  const text = typeof value === "string" ? value : safeJsonPreview(value);
  const redacted = redactTranscriptText(text).replace(/\s+/g, " ").trim();
  return {
    preview: redacted.length <= maxLength ? redacted : `${redacted.slice(0, Math.max(maxLength - 15, 0))}...[truncated]`,
    truncated: redacted.length > maxLength,
  };
}

function redactTranscriptText(value: string): string {
  return value
    .replace(/SECRET_[A-Z0-9_]+/g, "[redacted]")
    .replace(/\b(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*[^\s"',}]+/gi, "$1=[redacted]")
    .replace(/\bBearer\s+[^\s"',}]+/gi, "Bearer [redacted]");
}

function safeJsonPreview(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
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
  const mode = ctx.cursorModeOverride ?? ctx.config.cursor.mode;
  return mode === null ? {} : { mode };
}

export function cursorRoleMcpServers(
  ctx: AgentRunContext,
  options: { cliPath: string; mcpCwd?: string },
): Record<string, McpSubprocessServerConfig> {
  const applyCwd = (server: McpSubprocessServerConfig): McpSubprocessServerConfig =>
    options.mcpCwd === undefined ? server : { ...server, cwd: options.mcpCwd };
  if (ctx.role === "worker" && cursorRunPhase(ctx) === "implementation") {
    return {
      symphony: applyCwd(completionReportMcpServerConfig(ctx, completionReportContextFilePath(ctx), options)),
      ...transcriptRecallMcpServerEntry(ctx, options, applyCwd),
    };
  }
  if (ctx.role === "worker" && cursorRunPhase(ctx) === "issue_breakdown") {
    return {
      symphony_planning: applyCwd(issueBreakdownPlanMcpServerConfig(ctx, issueBreakdownPlanContextFilePath(ctx), options)),
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
      phase: cursorRunPhase(ctx),
    });
  }
  if (ctx.role === "worker" && cursorRunPhase(ctx) === "implementation") {
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
  if (ctx.role === "worker" && cursorRunPhase(ctx) === "issue_breakdown") {
    await writeIssueBreakdownPlanMcpContext(issueBreakdownPlanContextFilePath(ctx), {
      issue: ctx.issue,
      activeRunId: null,
      role: "worker",
      workspacePath: ctx.workspace.path,
      workspace: ctx.workspace,
      phase: "issue_breakdown",
    });
    return;
  }
  if (ctx.role !== "reviewer") return;
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

export function issueBreakdownPlanMcpServerConfig(
  ctx: AgentRunContext,
  contextFile: string,
  options: { cliPath: string },
): McpSubprocessServerConfig {
  return buildMcpSubprocessServerConfig({
    config: ctx.config,
    command: "issue-breakdown-plan-mcp",
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

export function issueBreakdownPlanContextFilePath(ctx: AgentRunContext): string {
  return path.join(
    ctx.config.workspace.stateDir,
    "issue-breakdown-plan-mcp",
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
  return ctx.role === "reviewer" ? `${ctx.workspace.path}:reviewer` : `${ctx.workspace.path}:worker:${cursorRunPhase(ctx)}`;
}

function cursorRunPhase(ctx: AgentRunContext): "issue_breakdown" | "implementation" | "review" {
  return ctx.runPhase ?? (ctx.role === "reviewer" ? "review" : "implementation");
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_") || "context";
}

function currentSymphonyCliPath(): string {
  return process.argv[1] ?? path.resolve("dist/cli.js");
}


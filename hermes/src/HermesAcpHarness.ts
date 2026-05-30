import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentEvent, AgentHarness, AgentRunContext } from "../../src/core/harness/AgentHarness.js";
import {
  symphonyRoleMcpServers,
  writeActiveHandoffMcpContexts,
  writeInitialHandoffMcpContexts,
} from "../../src/core/harness/HandoffMcp.js";
import type { RunTranscriptStore } from "../../src/core/persistence/RunTranscriptStore.js";
import type { AgentRunPhase, TokenCounts } from "../../src/core/types.js";
import { errorMessage, SymphonyError } from "../../src/core/errors.js";
import { redactTranscriptText, sanitizedPreviewValue } from "../../src/core/transcript/TranscriptProjection.js";
import {
  discoverHostHermes,
  type HostHermesDiscoveryResult,
  type HostHermesDiagnostic,
} from "./HostHermesDiscovery.js";
import {
  createHostHermesAcpProfileLease,
  type HostHermesAcpProfileLease,
  type HostHermesAcpProfileLeaseOptions,
  type HostHermesAcpTerminalStatus,
  type HostHermesAcpProcessCommand,
} from "./HostHermesAcpProfileLease.js";
import {
  mcpServersToAcpStdioServers,
  StdioHermesAcpClient,
  type HermesAcpClient,
  type HermesAcpFacadeEvent,
  type HermesAcpFacadeOptions,
  type HermesAcpPromptResult,
} from "./HermesAcpFacade.js";

export interface HermesAcpHarnessOptions {
  runStore?: RunTranscriptStore;
  cliPath?: string;
  discoverHostHermes?: (options: Parameters<typeof discoverHostHermes>[0]) => Promise<HostHermesDiscoveryResult>;
  profileLeaseFactory?: (options: HostHermesAcpProfileLeaseOptions) => Promise<HostHermesAcpProfileLease>;
  acpClientFactory?: (command: HostHermesAcpProcessCommand, options: HermesAcpFacadeOptions) => HermesAcpClient;
}

interface HermesAcpLease {
  key: string;
  reusable: boolean;
  profile: HostHermesAcpProfileLease;
  client: HermesAcpClient;
  initialized: boolean;
  acpSessionId: string | null;
  disposed: boolean;
}

type TerminalStatus = HostHermesAcpTerminalStatus;

export class HermesAcpHarness implements AgentHarness {
  readonly id = "hermes_acp";
  readonly capabilities = {
    continuation: true,
    mcpHandoff: true,
    runStatus: false,
    liveDiagnostics: true,
  };
  readonly supportsContinuation = true;

  private readonly leases = new Map<string, HermesAcpLease>();
  private readonly activeRuns = new Map<string, HermesAcpLease>();
  private readonly cancelledRuns = new Set<string>();
  private readonly discoverHostHermes: (options: Parameters<typeof discoverHostHermes>[0]) => Promise<HostHermesDiscoveryResult>;
  private readonly profileLeaseFactory: (options: HostHermesAcpProfileLeaseOptions) => Promise<HostHermesAcpProfileLease>;
  private readonly acpClientFactory: (command: HostHermesAcpProcessCommand, options: HermesAcpFacadeOptions) => HermesAcpClient;

  constructor(private readonly options: HermesAcpHarnessOptions = {}) {
    this.discoverHostHermes = options.discoverHostHermes ?? discoverHostHermes;
    this.profileLeaseFactory = options.profileLeaseFactory ?? createHostHermesAcpProfileLease;
    this.acpClientFactory = options.acpClientFactory ?? ((command, clientOptions) => new StdioHermesAcpClient(command, clientOptions));
  }

  async prepare(ctx: AgentRunContext): Promise<void> {
    await writeInitialHandoffMcpContexts(ctx);
  }

  async reload(_ctx: AgentRunContext): Promise<void> {
    return;
  }

  async *run(ctx: AgentRunContext, prompt: string): AsyncIterable<AgentEvent> {
    await writeInitialHandoffMcpContexts(ctx);
    const runId = `hermes-acp-${randomUUID()}`;
    const lease = await this.getOrCreateLease(ctx, runId);
    this.activeRuns.set(runId, lease);

    const queue = new AsyncEventQueue<AgentEvent>();
    let terminalStatus: TerminalStatus = null;
    let sessionStarted = false;
    let symphonySessionId: string | null = null;
    let responseText = "";

    const enqueue = (event: AgentEvent): void => queue.push({ ...event, at: event.at ?? new Date().toISOString() });
    const persistRuntimeEvent = (event: HermesAcpFacadeEvent): void => {
      const transcriptEvent = hermesAcpTranscriptEvent(event, this.id);
      if (!transcriptEvent) return;
      void this.options.runStore?.appendEvent({
        runId,
        at: new Date().toISOString(),
        source: "runtime",
        ...transcriptEvent,
      });
    };
    const onAcpEvent = (event: HermesAcpFacadeEvent): void => {
      if (!acceptAcpEvent(event, lease.acpSessionId)) return;
      if (sessionStarted) persistRuntimeEvent(event);
      const agentMessageDelta = hermesAcpAgentMessageDelta(event);
      if (agentMessageDelta) responseText += agentMessageDelta;
      for (const mapped of mapHermesAcpEvent(event)) {
        enqueue(mapped);
      }
    };
    const failRun = (message: string, payload?: unknown): void => {
      if (terminalStatus !== null) return;
      terminalStatus = ctx.abortSignal.aborted || this.cancelledRuns.has(runId) ? "cancelled" : "failed";
      if (terminalStatus === "cancelled") {
        enqueue({ type: "cancelled" });
      } else {
        enqueue({ type: "run_diagnostic", code: "hermes_acp_run_error", message, ...(payload === undefined ? {} : { payload }) });
        enqueue({ type: "failed", error: message });
      }
      queue.close();
    };
    const onExit = (code: number | null): void => {
      this.retireLeaseAfterTransportExit(lease);
      failRun(`Hermes ACP process exited before the run completed${code === null ? "" : ` (code ${code})`}`, {
        runId,
        sessionId: symphonySessionId,
        profileName: lease.profile.profileName,
        acpLogTail: acpLogTailPayload(lease),
      });
    };
    const abort = (): void => {
      this.cancelledRuns.add(runId);
      void this.interruptLease(lease, "abort_signal").catch((error) => {
        ctx.logger.warn("hermes_acp cancel after abort failed", {
          run_id: runId,
          issue_id: ctx.issue.id,
          issue_identifier: ctx.issue.identifier,
          error: errorMessage(error),
        });
      });
    };

    lease.client.on("event", onAcpEvent);
    lease.client.on("exit", onExit);
    ctx.abortSignal.addEventListener("abort", abort, { once: true });
    if (ctx.abortSignal.aborted) abort();

    try {
      const acpSessionId = await this.ensureAcpSession(ctx, lease);
      symphonySessionId = `${lease.profile.profileName}:${acpSessionId}:${runId}`;
      await writeActiveHandoffMcpContexts(ctx, { activeRunId: runId, sessionId: symphonySessionId });
      yield { type: "session_started", sessionId: symphonySessionId, threadId: acpSessionId, runId };
      sessionStarted = true;
      await this.options.runStore?.appendEvent({
        runId,
        at: new Date().toISOString(),
        source: "runtime",
        eventType: "hermes_acp_profile",
        message: `Host Hermes ACP profile ${lease.profile.profileName}`,
        payload: {
          harnessId: this.id,
          profileName: lease.profile.profileName,
          sourceProfile: lease.profile.sourceProfile,
          reusable: lease.reusable,
        },
      });

      void lease.client
        .prompt({ sessionId: acpSessionId, prompt })
        .then((result) => {
          if (terminalStatus !== null) return;
          terminalStatus = result.stopReason === "cancelled" || ctx.abortSignal.aborted || this.cancelledRuns.has(runId) ? "cancelled" : "succeeded";
          const tokens = usageTokens(result.usage ?? result.raw?.usage);
          if (tokens) enqueue({ type: "tokens", tokens });
          if (terminalStatus === "cancelled") {
            enqueue({ type: "cancelled" });
          } else {
            const completed: AgentEvent = responseText.trim().length > 0 ? { type: "completed", message: responseText } : { type: "completed" };
            enqueue(completed);
          }
          queue.close();
        })
        .catch((error: unknown) => {
          failRun(`Hermes ACP run failed: ${errorMessage(error)}`, {
            runId,
            sessionId: symphonySessionId,
            profileName: lease.profile.profileName,
            acpLogTail: acpLogTailPayload(lease),
          });
        });

      for await (const event of queue) {
        yield event;
      }
    } finally {
      ctx.abortSignal.removeEventListener("abort", abort);
      lease.client.off("event", onAcpEvent);
      lease.client.off("exit", onExit);
      this.activeRuns.delete(runId);
      this.cancelledRuns.delete(runId);
      if (!lease.reusable || terminalStatus !== "succeeded") {
        await this.disposeLease(lease, terminalStatus, "run_finished");
      }
    }
  }

  async stop(runId: string): Promise<void> {
    const lease = this.activeRuns.get(runId);
    if (!lease) return;
    this.cancelledRuns.add(runId);
    await this.interruptLease(lease, "stop");
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.leases.values()].map((lease) => this.disposeLease(lease, null, "harness_dispose")));
    this.leases.clear();
  }

  private async getOrCreateLease(ctx: AgentRunContext, runId: string): Promise<HermesAcpLease> {
    const reusable = shouldReuseLease(ctx);
    const key = reusable ? reusableLeaseKey(ctx) : `fresh:${runId}`;
    const existing = reusable ? this.leases.get(key) : undefined;
    if (existing && !existing.disposed) return existing;

    const binaryPath = await this.resolveBinaryPath(ctx);
    const sourceProfile = await this.resolveSourceProfile(ctx, binaryPath);
    const phase = currentRunPhase(ctx);
    const profile = await this.profileLeaseFactory({
      binaryPath,
      cwd: ctx.workspace.path,
      timeoutMs: ctx.config.hermesAcp.discoveryTimeoutMs,
      ...(sourceProfile === null ? {} : { sourceProfile }),
      keepProfiles: ctx.config.hermesAcp.keepProfiles,
      nameInput: {
        workspaceKey: ctx.workspace.workspaceKey,
        issueIdentifier: ctx.issue.identifier,
        role: ctx.role,
        phase,
        attempt: ctx.attempt,
        runId: reusable ? null : runId,
        prefix: ctx.config.hermesAcp.profileNamePrefix,
      },
    });
    const client = this.acpClientFactory(profile.acpCommand, {
      startupTimeoutMs: ctx.config.hermesAcp.startupTimeoutMs,
      requestTimeoutMs: ctx.config.hermesAcp.requestTimeoutMs,
      permissionTimeoutMs: ctx.config.hermesAcp.permissionTimeoutMs,
      shutdownGraceMs: ctx.config.hermesAcp.shutdownGraceMs,
      clientInfo: { name: "symphony", title: "Symphony", version: "0.1.0" },
    });
    const lease: HermesAcpLease = { key, reusable, profile, client, initialized: false, acpSessionId: null, disposed: false };
    if (reusable) this.leases.set(key, lease);
    return lease;
  }

  private async resolveBinaryPath(ctx: AgentRunContext): Promise<string> {
    if (ctx.config.hermesAcp.binaryPath) return ctx.config.hermesAcp.binaryPath;
    const discovery = await this.discoverHostHermes({
      cwd: ctx.workspace.path,
      sourceProfile: ctx.config.hermesAcp.sourceProfile,
      timeoutMs: ctx.config.hermesAcp.discoveryTimeoutMs,
    });
    if (discovery.binary?.path && discovery.diagnostics.every((diagnostic) => diagnostic.severity !== "error")) {
      return discovery.binary.path;
    }
    throw new SymphonyError("config_validation_error", hostHermesDiscoveryErrorMessage(discovery));
  }

  private async resolveSourceProfile(ctx: AgentRunContext, binaryPath: string): Promise<string | null> {
    if (ctx.config.hermesAcp.sourceProfile) return ctx.config.hermesAcp.sourceProfile;
    const discovery = await this.discoverHostHermes({
      binaryPath,
      cwd: ctx.workspace.path,
      timeoutMs: ctx.config.hermesAcp.discoveryTimeoutMs,
    });
    if (discovery.sourceProfile?.name && discovery.diagnostics.every((diagnostic) => diagnostic.severity !== "error")) {
      return discovery.sourceProfile.name;
    }
    throw new SymphonyError("config_validation_error", hostHermesDiscoveryErrorMessage(discovery));
  }

  private async ensureAcpSession(ctx: AgentRunContext, lease: HermesAcpLease): Promise<string> {
    if (!lease.initialized) {
      await lease.client.initialize();
      lease.initialized = true;
    }
    if (lease.acpSessionId) return lease.acpSessionId;
    const session = await lease.client.newSession({
      cwd: ctx.workspace.path,
      mcpServers: mcpServersToAcpStdioServers(symphonyRoleMcpServers(ctx, { cliPath: this.cliPath(), mcpCwd: ctx.workspace.path })),
    });
    lease.acpSessionId = session.sessionId;
    return session.sessionId;
  }

  private async interruptLease(lease: HermesAcpLease, reason: string): Promise<void> {
    if (lease.disposed) return;
    const sessionId = lease.acpSessionId;
    if (!sessionId) {
      lease.client.kill(`hermes_acp.${reason}.no_session`);
      return;
    }
    try {
      await lease.client.cancel(sessionId);
    } catch {
      lease.client.kill(`hermes_acp.${reason}.cancel_failed`);
    }
  }

  private async disposeLease(lease: HermesAcpLease, terminalStatus: TerminalStatus, reason: string): Promise<void> {
    if (lease.disposed) return;
    lease.disposed = true;
    this.leases.delete(lease.key);
    await lease.client.close(`hermes_acp.${reason}`).catch(() => lease.client.kill(`hermes_acp.${reason}.close_failed`));
    await lease.profile.dispose(terminalStatus);
  }

  private retireLeaseAfterTransportExit(lease: HermesAcpLease): void {
    if (lease.disposed) return;
    lease.acpSessionId = null;
    this.leases.delete(lease.key);
  }

  private cliPath(): string {
    return this.options.cliPath ?? process.argv[1] ?? path.resolve("dist/cli.js");
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

function shouldReuseLease(ctx: AgentRunContext): boolean {
  return (
    ctx.role === "worker" &&
    currentRunPhase(ctx) === "implementation" &&
    ctx.config.hermesAcp.workerSessionLifecycle === "reuse_by_issue"
  );
}

function reusableLeaseKey(ctx: AgentRunContext): string {
  return `${ctx.workspace.path}:worker:${ctx.issue.id || ctx.issue.identifier}:${currentRunPhase(ctx)}`;
}

function currentRunPhase(ctx: AgentRunContext): AgentRunPhase {
  return ctx.runPhase ?? (ctx.role === "reviewer" ? "review" : "implementation");
}

function acceptAcpEvent(event: HermesAcpFacadeEvent, sessionId: string | null): boolean {
  if (event.type !== "session.update" && event.type !== "permission.denied") return true;
  if (!sessionId || !event.sessionId) return true;
  return event.sessionId === sessionId;
}

function mapHermesAcpEvent(event: HermesAcpFacadeEvent): AgentEvent[] {
  switch (event.type) {
    case "acp.started":
      return [{ type: "progress", message: `Host Hermes ACP started (${event.command})` }];
    case "acp.stderr":
      return [{ type: "progress", message: `Hermes ACP stderr: ${preview(event.line, 240)}` }];
    case "acp.protocol_error":
      return [{ type: "run_diagnostic", code: "hermes_acp_protocol_error", message: event.message, payload: event.payload }];
    case "client_request.denied":
      return [
        {
          type: "run_diagnostic",
          code: "hermes_acp_client_request_denied",
          message: event.reason,
          payload: { method: event.method, messageId: event.messageId },
        },
      ];
    case "permission.denied":
      return [
        {
          type: "run_diagnostic",
          code: "hermes_acp_permission_denied",
          message: event.reason,
          payload: { sessionId: event.sessionId, options: event.options, toolCall: event.toolCall },
        },
      ];
    case "session.update":
      return mapSessionUpdate(event.update);
    case "acp.exit":
      return [];
  }
}

function hermesAcpAgentMessageDelta(event: HermesAcpFacadeEvent): string | null {
  if (event.type !== "session.update") return null;
  const kind = nonEmptyString(event.update.sessionUpdate) ?? nonEmptyString(event.update.session_update);
  if (kind !== "agent_message_chunk") return null;
  const content = isRecord(event.update.content) ? event.update.content : {};
  return nonEmptyString(content.text) ?? nonEmptyString(event.update.text) ?? "";
}

function mapSessionUpdate(update: Record<string, unknown>): AgentEvent[] {
  const kind = nonEmptyString(update.sessionUpdate) ?? nonEmptyString(update.session_update) ?? "session_update";
  const content = isRecord(update.content) ? update.content : {};
  const text = nonEmptyString(content.text) ?? nonEmptyString(update.text) ?? preview(content, 240) ?? preview(update, 240);
  if (kind === "agent_message_chunk") return [{ type: "progress", activitySource: "delta", message: text }];
  if (kind === "agent_thought_chunk") return [{ type: "progress", activitySource: "delta", message: text }];
  if (kind === "usage_update") {
    const tokens = usageTokens({ total: update.used });
    return tokens ? [{ type: "tokens", tokens }] : [];
  }
  if (kind === "tool_call" || kind === "tool_call_update" || kind.includes("tool")) {
    return [{ type: "progress", activitySource: "tool", message: `Hermes ACP ${formatToolUpdate(update)}` }];
  }
  if (kind === "plan") return [{ type: "progress", message: "Hermes ACP plan updated" }];
  if (kind === "current_mode_update") return [{ type: "progress", message: `Hermes ACP mode: ${preview(update, 240)}` }];
  return [{ type: "progress", message: `Hermes ACP ${kind}: ${text}` }];
}

function formatToolUpdate(update: Record<string, unknown>): string {
  const toolCall = isRecord(update.toolCall) ? update.toolCall : isRecord(update.tool_call) ? update.tool_call : update;
  const title = nonEmptyString(toolCall.title) ?? nonEmptyString(toolCall.name) ?? nonEmptyString(toolCall.tool) ?? "tool update";
  const status = nonEmptyString(update.status) ?? nonEmptyString(toolCall.status);
  return status ? `${title} (${status})` : title;
}

function hermesAcpTranscriptEvent(
  event: HermesAcpFacadeEvent,
  harnessId: string,
): { eventType: string; message?: string; payload?: unknown } | null {
  switch (event.type) {
    case "session.update":
      return {
        eventType: "acp_session_update",
        message: `Hermes ACP ${nonEmptyString(event.update.sessionUpdate) ?? nonEmptyString(event.update.session_update) ?? "session update"}`,
        payload: {
          harnessId,
          sessionId: event.sessionId,
          updatePreview: preview(event.update, 1_000),
          redacted: true,
        },
      };
    case "permission.denied":
      return {
        eventType: "acp_permission_denied",
        message: event.reason,
        payload: { harnessId, sessionId: event.sessionId, redacted: true },
      };
    case "acp.stderr":
      return {
        eventType: "acp_stderr",
        message: "Hermes ACP stderr",
        payload: { harnessId, linePreview: preview(event.line, 500), redacted: true },
      };
    case "acp.protocol_error":
      return {
        eventType: "acp_protocol_error",
        message: event.message,
        payload: { harnessId, payloadPreview: preview(event.payload, 500), redacted: true },
      };
    default:
      return null;
  }
}

function usageTokens(usage: unknown): Partial<TokenCounts> | null {
  if (!isRecord(usage)) return null;
  const input = numberFromUnknown(usage.input) ?? numberFromUnknown(usage.inputTokens) ?? numberFromUnknown(usage.input_tokens);
  const output = numberFromUnknown(usage.output) ?? numberFromUnknown(usage.outputTokens) ?? numberFromUnknown(usage.output_tokens);
  const total = numberFromUnknown(usage.total) ?? numberFromUnknown(usage.totalTokens) ?? numberFromUnknown(usage.total_tokens);
  if (input === null && output === null && total === null) return null;
  return {
    ...(input === null ? {} : { inputTokens: input }),
    ...(output === null ? {} : { outputTokens: output }),
    ...(total === null ? {} : { totalTokens: total }),
  };
}

function hostHermesDiscoveryErrorMessage(discovery: HostHermesDiscoveryResult): string {
  const errors = discovery.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  const diagnostics = (errors.length > 0 ? errors : discovery.diagnostics).map(formatHostHermesDiagnostic).join("; ");
  return diagnostics || "Host Hermes ACP discovery failed.";
}

function formatHostHermesDiagnostic(diagnostic: HostHermesDiagnostic): string {
  return `${diagnostic.code}: ${diagnostic.message}`;
}

function acpLogTailPayload(lease: HermesAcpLease): { lines: string[]; lineCount: number } | null {
  const tail = lease.client.getLogTail(50).trim();
  if (!tail) return null;
  const lines = tail
    .split(/\r?\n/g)
    .map((line) => preview(redactLogLine(line), 600))
    .filter((line) => line.length > 0);
  return { lines, lineCount: lines.length };
}

function redactLogLine(line: string): string {
  let redacted = redactTranscriptText(line).text;
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || value.length < 8 || !/[A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|AUTH)[A-Z0-9_]*/i.test(key)) continue;
    redacted = redacted.split(value).join("[redacted]");
  }
  return redacted;
}

function preview(value: unknown, maxLength: number): string {
  return sanitizedPreviewValue(value, maxLength).preview ?? "";
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function numberFromUnknown(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

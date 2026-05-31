import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentEvent, AgentHarness, AgentRunContext } from "../../src/core/harness/AgentHarness.js";
import {
  symphonyRoleMcpServers,
  writeActiveHandoffMcpContexts,
  writeInitialHandoffMcpContexts,
} from "../../src/core/harness/HandoffMcp.js";
import type { McpSubprocessServerConfig } from "../../src/core/harness/McpSubprocessEnvironment.js";
import { errorMessage, SymphonyError } from "../../src/core/errors.js";
import type { RunTranscriptStore } from "../../src/core/persistence/RunTranscriptStore.js";
import type { AgentRunPhase, TokenCounts } from "../../src/core/types.js";
import { redactTranscriptText, sanitizedPreviewValue } from "../../src/core/transcript/TranscriptProjection.js";
import {
  discoverHostHermes,
  type HostHermesDiscoveryResult,
  type HostHermesDiagnostic as HostHermesDiscoveryDiagnostic,
} from "./HostHermesDiscovery.js";
import {
  createHostHermesAcpProfileLease,
  type HostHermesAcpProcessCommand,
  type HostHermesAcpProfileLease,
  type HostHermesAcpProfileLeaseOptions,
  type HostHermesAcpTerminalStatus,
} from "./HostHermesAcpProfileLease.js";
import {
  HostHermesAcpStdioJsonRpcFacade,
  type HostHermesAcpDiagnostic,
  type HostHermesAcpJsonRpcNotification,
  type HostHermesAcpJsonRpcRequest,
  type HostHermesAcpProcessExit,
  type HostHermesAcpRequestOptions,
} from "./HostHermesAcpFacade.js";

export interface AcpEnvVariable {
  name: string;
  value: string;
}

export interface AcpMcpServerStdio {
  name: string;
  command: string;
  args: string[];
  env: AcpEnvVariable[];
}

export interface HermesAcpHarnessOptions {
  runStore?: RunTranscriptStore;
  cliPath?: string;
  discoverHostHermes?: (options: Parameters<typeof discoverHostHermes>[0]) => Promise<HostHermesDiscoveryResult>;
  profileLeaseFactory?: (options: HostHermesAcpProfileLeaseOptions) => Promise<HostHermesAcpProfileLease>;
  acpClientFactory?: (command: HostHermesAcpProcessCommand, options: HermesAcpRuntimeClientOptions) => HermesAcpRuntimeClient;
}

export interface HermesAcpRuntimeClientOptions {
  requestTimeoutMs?: number;
}

export interface HermesAcpRuntimeClient {
  request<T = unknown>(method: string, params?: unknown, options?: HostHermesAcpRequestOptions): Promise<T>;
  onNotification(method: string, handler: (params: unknown, notification: HostHermesAcpJsonRpcNotification) => void): () => void;
  onClientRequest(method: string, handler: (params: unknown, request: HostHermesAcpJsonRpcRequest) => unknown | Promise<unknown>): () => void;
  on(event: "diagnostic", listener: (diagnostic: HostHermesAcpDiagnostic) => void): this;
  on(event: "exit", listener: (exit: HostHermesAcpProcessExit) => void): this;
  off(event: "diagnostic", listener: (diagnostic: HostHermesAcpDiagnostic) => void): this;
  off(event: "exit", listener: (exit: HostHermesAcpProcessExit) => void): this;
  kill(reason?: string): void;
  getLogTail(limit?: number): string;
}

interface HermesAcpLease {
  key: string;
  reusable: boolean;
  profile: HostHermesAcpProfileLease;
  client: HermesAcpRuntimeClient;
  initialized: boolean;
  disposed: boolean;
  transportExited: boolean;
  transportExitListener: ((exit: HostHermesAcpProcessExit) => void) | undefined;
}

interface ActiveHermesAcpRun {
  lease: HermesAcpLease;
  acpSessionId: string | null;
  symphonySessionId: string | null;
}

type TerminalStatus = HostHermesAcpTerminalStatus;

type HermesAcpRuntimeEvent =
  | { type: "session.update"; sessionId: string | null; update: Record<string, unknown>; raw: Record<string, unknown> }
  | { type: "diagnostic"; diagnostic: HostHermesAcpDiagnostic }
  | { type: "permission.denied"; sessionId: string | null; reason: string; params: unknown };

const TERMINAL_SETUP_AUTH_METHOD_ID = "hermes-setup";
const DEFAULT_PROFILE_PREFIX = "symphony";

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
  private readonly activeRuns = new Map<string, ActiveHermesAcpRun>();
  private readonly cancelledRuns = new Set<string>();
  private readonly discoverHostHermes: (options: Parameters<typeof discoverHostHermes>[0]) => Promise<HostHermesDiscoveryResult>;
  private readonly profileLeaseFactory: (options: HostHermesAcpProfileLeaseOptions) => Promise<HostHermesAcpProfileLease>;
  private readonly acpClientFactory: (command: HostHermesAcpProcessCommand, options: HermesAcpRuntimeClientOptions) => HermesAcpRuntimeClient;

  constructor(private readonly options: HermesAcpHarnessOptions = {}) {
    this.discoverHostHermes = options.discoverHostHermes ?? discoverHostHermes;
    this.profileLeaseFactory = options.profileLeaseFactory ?? createHostHermesAcpProfileLease;
    this.acpClientFactory =
      options.acpClientFactory ??
      ((command, clientOptions) =>
        HostHermesAcpStdioJsonRpcFacade.spawn(
          command,
          clientOptions.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: clientOptions.requestTimeoutMs },
        ));
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
    const activeRun: ActiveHermesAcpRun = { lease, acpSessionId: null, symphonySessionId: null };
    this.activeRuns.set(runId, activeRun);

    const queue = new AsyncEventQueue<AgentEvent>();
    let terminalStatus: TerminalStatus = null;
    let sessionStarted = false;
    let responseText = "";

    const enqueue = (event: AgentEvent): void => queue.push({ ...event, at: event.at ?? new Date().toISOString() });
    const persistRuntimeEvent = (event: HermesAcpRuntimeEvent): void => {
      const transcriptEvent = hermesAcpTranscriptEvent(event, this.id);
      if (!transcriptEvent) return;
      void this.options.runStore?.appendEvent({
        runId,
        at: new Date().toISOString(),
        source: "runtime",
        ...transcriptEvent,
      });
    };
    const onSessionUpdate = (params: unknown): void => {
      const event = hermesAcpSessionUpdateEvent(params);
      if (!event || !acceptAcpSessionEvent(event, activeRun.acpSessionId)) return;
      if (sessionStarted) persistRuntimeEvent(event);
      responseText += hermesAcpAgentMessageDelta(event.update);
      for (const mapped of mapHermesAcpSessionUpdate(event.update)) {
        enqueue(mapped);
      }
    };
    const permissionDeniedReason = "ACP permission requests are denied by Symphony unless an explicit approval bridge is implemented.";
    const onPermissionRequest = (params: unknown): Record<string, unknown> => {
      const sessionId = acpSessionIdFromParams(params);
      const event: HermesAcpRuntimeEvent = { type: "permission.denied", sessionId, reason: permissionDeniedReason, params };
      if (sessionStarted) persistRuntimeEvent(event);
      enqueue({
        type: "run_diagnostic",
        code: "hermes_acp_permission_denied",
        message: permissionDeniedReason,
        payload: { sessionId, paramsPreview: preview(params, 500), redacted: true },
      });
      return { outcome: { outcome: "cancelled" } };
    };
    const onDiagnostic = (diagnostic: HostHermesAcpDiagnostic): void => {
      const event: HermesAcpRuntimeEvent = { type: "diagnostic", diagnostic };
      if (sessionStarted) persistRuntimeEvent(event);
      enqueue({
        type: "run_diagnostic",
        code: diagnostic.code,
        message: diagnostic.message,
        ...(diagnostic.details === undefined ? {} : { payload: diagnostic.details }),
      });
    };
    const failRun = (message: string, payload?: unknown): void => {
      if (terminalStatus !== null) return;
      terminalStatus = ctx.abortSignal.aborted || this.cancelledRuns.has(runId) ? "cancelled" : "failed";
      if (terminalStatus === "cancelled") {
        enqueue({ type: "cancelled" });
      } else {
        enqueue({
          type: "run_diagnostic",
          code: "hermes_acp_run_error",
          message,
          ...(payload === undefined ? {} : { payload }),
        });
        enqueue({ type: "failed", error: message });
      }
      queue.close();
    };
    const onExit = (exit: HostHermesAcpProcessExit): void => {
      this.retireLeaseAfterTransportExit(lease);
      failRun(`Host Hermes ACP process exited before the run completed (${hostHermesAcpExitDescription(exit)})`, {
        runId,
        sessionId: activeRun.symphonySessionId,
        profileName: lease.profile.profileName,
        exit,
        acpLogTail: acpLogTailPayload(lease),
      });
    };
    const abort = (): void => {
      this.cancelledRuns.add(runId);
      void this.interruptActiveRun(activeRun, "abort_signal").catch((error) => {
        ctx.logger.warn("hermes_acp cancel after abort failed", {
          run_id: runId,
          issue_id: ctx.issue.id,
          issue_identifier: ctx.issue.identifier,
          error: errorMessage(error),
        });
      });
    };

    const removeSessionUpdateHandler = lease.client.onNotification("session/update", onSessionUpdate);
    const removePermissionHandler = lease.client.onClientRequest("session/request_permission", onPermissionRequest);
    lease.client.on("diagnostic", onDiagnostic);
    lease.client.on("exit", onExit);
    ctx.abortSignal.addEventListener("abort", abort, { once: true });
    if (ctx.abortSignal.aborted) abort();

    try {
      await this.ensureAcpInitialized(ctx, lease);
      const acpSessionId = await this.createAcpSession(ctx, lease);
      activeRun.acpSessionId = acpSessionId;
      activeRun.symphonySessionId = `${lease.profile.profileName}:${acpSessionId}:${runId}`;
      await writeActiveHandoffMcpContexts(ctx, { activeRunId: runId, sessionId: activeRun.symphonySessionId });
      yield { type: "session_started", sessionId: activeRun.symphonySessionId, threadId: acpSessionId, runId };
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
          acpSessionId,
          reusable: lease.reusable,
        },
      });

      const promptTask = lease.client
        .request<Record<string, unknown> | null>(
          "session/prompt",
          { sessionId: acpSessionId, prompt: [{ type: "text", text: prompt }] },
          { timeoutMs: ctx.config.hermes.requestTimeoutMs },
        )
        .then((result) => {
          if (terminalStatus !== null) return;
          const events = mapHermesAcpPromptResult(result, {
            cancelled: ctx.abortSignal.aborted || this.cancelledRuns.has(runId),
            responseText,
          });
          terminalStatus = terminalStatusFromEvents(events);
          for (const event of events) enqueue(event);
          queue.close();
        })
        .catch((error: unknown) => {
          failRun(`Host Hermes ACP run failed: ${errorMessage(error)}`, {
            runId,
            sessionId: activeRun.symphonySessionId,
            profileName: lease.profile.profileName,
            acpLogTail: acpLogTailPayload(lease),
          });
        });

      for await (const event of queue) {
        yield event;
      }
      await promptTask;
    } catch (error) {
      if (terminalStatus !== null) {
        for await (const event of queue) {
          yield event;
        }
      } else if (ctx.abortSignal.aborted || this.cancelledRuns.has(runId)) {
        terminalStatus = "cancelled";
        yield { type: "cancelled" };
      } else {
        terminalStatus = "failed";
        yield {
          type: "run_diagnostic",
          code: "hermes_acp_run_error",
          message: `Host Hermes ACP run failed: ${errorMessage(error)}`,
          payload: {
            runId,
            sessionId: activeRun.symphonySessionId,
            profileName: lease.profile.profileName,
            acpLogTail: acpLogTailPayload(lease),
          },
        };
        yield { type: "failed", error: `Host Hermes ACP run failed: ${errorMessage(error)}` };
      }
    } finally {
      ctx.abortSignal.removeEventListener("abort", abort);
      removeSessionUpdateHandler();
      removePermissionHandler();
      lease.client.off("diagnostic", onDiagnostic);
      lease.client.off("exit", onExit);
      this.activeRuns.delete(runId);
      this.cancelledRuns.delete(runId);
      if (shouldDisposeLeaseAfterRun(lease, terminalStatus)) {
        await this.disposeLease(lease, terminalStatus, lease.transportExited ? "transport_exit" : "run_finished");
      }
    }
  }

  async stop(runId: string): Promise<void> {
    const activeRun = this.activeRuns.get(runId);
    if (!activeRun) return;
    this.cancelledRuns.add(runId);
    await this.interruptActiveRun(activeRun, "stop");
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.leases.values()].map((lease) => this.disposeLease(lease, null, "harness_dispose")));
    this.leases.clear();
  }

  private async getOrCreateLease(ctx: AgentRunContext, runId: string): Promise<HermesAcpLease> {
    const reusable = shouldReuseLease(ctx);
    const key = reusable ? reusableLeaseKey(ctx) : `fresh:${runId}`;
    const existing = reusable ? this.leases.get(key) : undefined;
    if (existing && !existing.disposed && !existing.transportExited) return existing;

    const binaryPath = await this.resolveBinaryPath(ctx);
    const sourceProfile = await this.resolveSourceProfile(ctx, binaryPath);
    const phase = currentRunPhase(ctx);
    const profile = await this.profileLeaseFactory({
      binaryPath,
      cwd: ctx.workspace.path,
      timeoutMs: ctx.config.hermes.startupTimeoutMs,
      sourceProfile,
      keepProfiles: ctx.config.hermes.keepProfiles,
      nameInput: {
        workspaceKey: ctx.workspace.workspaceKey,
        issueIdentifier: ctx.issue.identifier,
        role: ctx.role,
        phase,
        attempt: ctx.attempt,
        runId: reusable ? null : runId,
        prefix: configuredHermesAcpProfilePrefix(ctx) ?? DEFAULT_PROFILE_PREFIX,
      },
    });
    const client = this.acpClientFactory(profile.acpCommand, { requestTimeoutMs: ctx.config.hermes.requestTimeoutMs });
    const lease: HermesAcpLease = {
      key,
      reusable,
      profile,
      client,
      initialized: false,
      disposed: false,
      transportExited: false,
      transportExitListener: undefined,
    };
    lease.transportExitListener = (exit) => this.handleLeaseTransportExit(lease, exit);
    lease.client.on("exit", lease.transportExitListener);
    if (reusable) this.leases.set(key, lease);
    return lease;
  }

  private async resolveBinaryPath(ctx: AgentRunContext): Promise<string> {
    const configuredBinaryPath = configuredHostHermesBinaryPath(ctx);
    if (configuredBinaryPath) return configuredBinaryPath;
    const discovery = await this.discoverHostHermes({
      cwd: ctx.workspace.path,
      sourceProfile: configuredHostHermesSourceProfile(ctx),
      timeoutMs: ctx.config.hermes.startupTimeoutMs,
    });
    if (discovery.binary?.path && discovery.diagnostics.every((diagnostic) => diagnostic.severity !== "error")) {
      return discovery.binary.path;
    }
    throw new SymphonyError("config_validation_error", hostHermesDiscoveryErrorMessage(discovery));
  }

  private async resolveSourceProfile(ctx: AgentRunContext, binaryPath: string): Promise<string> {
    const configured = configuredHostHermesSourceProfile(ctx);
    if (configured) return configured;
    const discovery = await this.discoverHostHermes({
      binaryPath,
      cwd: ctx.workspace.path,
      timeoutMs: ctx.config.hermes.startupTimeoutMs,
    });
    if (discovery.sourceProfile?.name && discovery.diagnostics.every((diagnostic) => diagnostic.severity !== "error")) {
      return discovery.sourceProfile.name;
    }
    throw new SymphonyError("config_validation_error", hostHermesDiscoveryErrorMessage(discovery));
  }

  private async ensureAcpInitialized(ctx: AgentRunContext, lease: HermesAcpLease): Promise<void> {
    if (lease.initialized) return;
    const initializeResult = await lease.client.request<Record<string, unknown>>(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "symphony", title: "Symphony", version: "0.1.0" },
      },
      { timeoutMs: ctx.config.hermes.startupTimeoutMs },
    );
    const method = selectNonTerminalAuthMethod(initializeResult);
    const authenticateResult = await lease.client.request<unknown>(
      "authenticate",
      { methodId: method.id },
      { timeoutMs: ctx.config.hermes.startupTimeoutMs },
    );
    validateAcpAuthenticateResult(authenticateResult, method);
    lease.initialized = true;
  }

  private async createAcpSession(ctx: AgentRunContext, lease: HermesAcpLease): Promise<string> {
    const response = await lease.client.request<Record<string, unknown>>(
      "session/new",
      {
        cwd: ctx.workspace.path,
        mcpServers: mcpServersToAcpStdioServers(symphonyRoleMcpServers(ctx, { cliPath: this.cliPath(), mcpCwd: ctx.workspace.path })),
      },
      { timeoutMs: ctx.config.hermes.startupTimeoutMs },
    );
    const sessionId = nonEmptyString(response.sessionId) ?? nonEmptyString(response.session_id);
    if (!sessionId) throw new SymphonyError("agent_error", "Host Hermes ACP session/new did not return a sessionId.");
    return sessionId;
  }

  private async interruptActiveRun(activeRun: ActiveHermesAcpRun, reason: string): Promise<void> {
    const lease = activeRun.lease;
    if (lease.disposed) return;
    const sessionId = activeRun.acpSessionId;
    if (!sessionId) {
      lease.client.kill(`hermes_acp.${reason}.no_session`);
      return;
    }
    try {
      await lease.client.request("session/cancel", { sessionId }, { timeoutMs: 10_000 });
    } catch {
      lease.client.kill(`hermes_acp.${reason}.cancel_failed`);
    }
  }

  private async disposeLease(lease: HermesAcpLease, terminalStatus: TerminalStatus, reason: string): Promise<void> {
    if (lease.disposed) return;
    lease.disposed = true;
    this.leases.delete(lease.key);
    if (lease.transportExitListener) {
      lease.client.off("exit", lease.transportExitListener);
      lease.transportExitListener = undefined;
    }
    lease.client.kill(`hermes_acp.${reason}`);
    await lease.profile.dispose(terminalStatus);
  }

  private handleLeaseTransportExit(lease: HermesAcpLease, _exit: HostHermesAcpProcessExit): void {
    this.retireLeaseAfterTransportExit(lease);
    if ([...this.activeRuns.values()].some((activeRun) => activeRun.lease === lease)) return;
    void this.disposeLease(lease, "failed", "transport_exit").catch(() => lease.client.kill("hermes_acp.transport_exit.dispose_failed"));
  }

  private retireLeaseAfterTransportExit(lease: HermesAcpLease): void {
    if (lease.disposed) return;
    lease.transportExited = true;
    lease.initialized = false;
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

export function mcpServersToAcpStdioServers(servers: Record<string, McpSubprocessServerConfig>): AcpMcpServerStdio[] {
  return Object.entries(servers).map(([name, server]) => ({
    name,
    command: server.command,
    args: [...server.args],
    env: Object.entries(server.env).map(([envName, value]) => ({ name: envName, value })),
  }));
}

function shouldDisposeLeaseAfterRun(lease: HermesAcpLease, terminalStatus: TerminalStatus): boolean {
  return !lease.reusable || terminalStatus !== "succeeded" || lease.transportExited;
}

function shouldReuseLease(ctx: AgentRunContext): boolean {
  return (
    ctx.role === "worker" &&
    currentRunPhase(ctx) === "implementation" &&
    ctx.config.hermes.workerSessionLifecycle === "reuse_by_issue"
  );
}

function reusableLeaseKey(ctx: AgentRunContext): string {
  return `${ctx.workspace.path}:worker:${ctx.issue.id || ctx.issue.identifier}:${currentRunPhase(ctx)}`;
}

function currentRunPhase(ctx: AgentRunContext): AgentRunPhase {
  return ctx.runPhase ?? (ctx.role === "reviewer" ? "review" : "implementation");
}

function configuredHostHermesBinaryPath(ctx: AgentRunContext): string | null {
  const rawHermes = rawHermesConfig(ctx);
  return nonEmptyString(rawHermes.acp_binary_path) ?? nonEmptyString(rawHermes.binary_path);
}

function configuredHostHermesSourceProfile(ctx: AgentRunContext): string | null {
  const rawHermes = rawHermesConfig(ctx);
  return nonEmptyString(rawHermes.acp_source_profile) ?? nonEmptyString(rawHermes.source_profile);
}

function configuredHermesAcpProfilePrefix(ctx: AgentRunContext): string | null {
  const rawHermes = rawHermesConfig(ctx);
  return nonEmptyString(rawHermes.acp_profile_prefix) ?? nonEmptyString(rawHermes.profile_name_prefix);
}

function rawHermesConfig(ctx: AgentRunContext): Record<string, unknown> {
  return isRecord(ctx.config.raw.hermes) ? (ctx.config.raw.hermes as Record<string, unknown>) : {};
}

function hostHermesDiscoveryErrorMessage(discovery: HostHermesDiscoveryResult): string {
  const errors = discovery.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  const diagnostics = (errors.length > 0 ? errors : discovery.diagnostics).map(formatHostHermesDiagnostic).join("; ");
  return diagnostics || "Host Hermes ACP discovery failed.";
}

function formatHostHermesDiagnostic(diagnostic: HostHermesDiscoveryDiagnostic): string {
  return `${diagnostic.code}: ${diagnostic.message}`;
}

function selectNonTerminalAuthMethod(initializeResult: Record<string, unknown>): { id: string; label: string } {
  const authMethods = authMethodsFromInitializeResult(initializeResult);
  const selected = authMethods.find((method) => {
    const id = authMethodId(method);
    return id !== null && !isTerminalAuthMethod(method);
  });
  if (!selected) {
    throw new SymphonyError(
      "config_validation_error",
      "Host Hermes ACP initialize did not advertise a non-terminal provider auth method. Refusing unattended hermes_acp run; configure Hermes provider credentials before using the ACP harness.",
    );
  }
  const id = authMethodId(selected);
  if (!id) {
    throw new SymphonyError("agent_error", "Host Hermes ACP selected auth method did not include an id.");
  }
  return { id, label: authMethodLabel(selected) ?? id };
}

function validateAcpAuthenticateResult(result: unknown, method: { id: string; label: string }): void {
  if (result === null || result === undefined || result === false) {
    throw new SymphonyError(
      "config_validation_error",
      `Host Hermes ACP authenticate rejected auth method ${method.label} (${method.id}). Refusing unattended hermes_acp run; configure Hermes provider credentials before using the ACP harness.`,
    );
  }
  if (!isRecord(result)) {
    throw new SymphonyError(
      "agent_error",
      `Host Hermes ACP authenticate returned an invalid response for auth method ${method.label} (${method.id}).`,
    );
  }
}

function authMethodsFromInitializeResult(initializeResult: Record<string, unknown>): Record<string, unknown>[] {
  const value = Array.isArray(initializeResult.authMethods)
    ? initializeResult.authMethods
    : Array.isArray(initializeResult.auth_methods)
      ? initializeResult.auth_methods
      : [];
  return value.filter(isRecord);
}

function authMethodId(method: Record<string, unknown>): string | null {
  return nonEmptyString(method.id) ?? nonEmptyString(method.methodId) ?? nonEmptyString(method.method_id);
}

function authMethodLabel(method: Record<string, unknown>): string | null {
  return nonEmptyString(method.name) ?? nonEmptyString(method.title) ?? nonEmptyString(method.description);
}

function isTerminalAuthMethod(method: Record<string, unknown>): boolean {
  const id = authMethodId(method);
  const type = nonEmptyString(method.type)?.toLowerCase() ?? "";
  return id === TERMINAL_SETUP_AUTH_METHOD_ID || type === "terminal" || type === "terminalauthmethod";
}

function hermesAcpSessionUpdateEvent(params: unknown): Extract<HermesAcpRuntimeEvent, { type: "session.update" }> | null {
  if (!isRecord(params)) return null;
  const update = isRecord(params.update) ? params.update : {};
  return {
    type: "session.update",
    sessionId: acpSessionIdFromParams(params),
    update,
    raw: params,
  };
}

function acpSessionIdFromParams(params: unknown): string | null {
  if (!isRecord(params)) return null;
  return nonEmptyString(params.sessionId) ?? nonEmptyString(params.session_id);
}

function acceptAcpSessionEvent(event: Extract<HermesAcpRuntimeEvent, { type: "session.update" }>, activeSessionId: string | null): boolean {
  if (!activeSessionId || !event.sessionId) return true;
  return event.sessionId === activeSessionId;
}

function mapHermesAcpSessionUpdate(update: Record<string, unknown>): AgentEvent[] {
  const kind = acpSessionUpdateKind(update);
  const text = acpUpdateText(update);
  if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
    return [{ type: "progress", activitySource: "delta", message: text }];
  }
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

function hermesAcpAgentMessageDelta(update: Record<string, unknown>): string {
  if (acpSessionUpdateKind(update) !== "agent_message_chunk") return "";
  return acpUpdateText(update);
}

function acpSessionUpdateKind(update: Record<string, unknown>): string {
  return nonEmptyString(update.sessionUpdate) ?? nonEmptyString(update.session_update) ?? "session_update";
}

function acpUpdateText(update: Record<string, unknown>): string {
  return (
    textFromContent(update.content) ??
    nonEmptyString(update.text) ??
    preview(isRecord(update.content) || Array.isArray(update.content) ? update.content : update, 240) ??
    ""
  );
}

function textFromContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (isRecord(content)) return nonEmptyString(content.text) ?? nonEmptyString(content.content);
  if (!Array.isArray(content)) return null;
  const parts = content
    .map((part) => {
      if (typeof part === "string") return part;
      if (isRecord(part)) return nonEmptyString(part.text) ?? nonEmptyString(part.content) ?? "";
      return "";
    })
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join("") : null;
}

function formatToolUpdate(update: Record<string, unknown>): string {
  const toolCall = isRecord(update.toolCall) ? update.toolCall : isRecord(update.tool_call) ? update.tool_call : update;
  const title = nonEmptyString(toolCall.title) ?? nonEmptyString(toolCall.name) ?? nonEmptyString(toolCall.tool) ?? "tool update";
  const status = nonEmptyString(update.status) ?? nonEmptyString(toolCall.status);
  return status ? `${title} (${status})` : title;
}

function mapHermesAcpPromptResult(
  result: Record<string, unknown> | null,
  input: { cancelled: boolean; responseText: string },
): AgentEvent[] {
  const stopReason = nonEmptyString(result?.stopReason) ?? nonEmptyString(result?.stop_reason) ?? null;
  const usage = usageTokens(result?.usage);
  const events: AgentEvent[] = usage ? [{ type: "tokens", tokens: usage }] : [];
  if (input.cancelled || stopReason === "cancelled") {
    events.push({ type: "cancelled" });
    return events;
  }
  if (stopReason === "refusal") {
    events.push({
      type: "run_diagnostic",
      code: "hermes_acp_refusal",
      message: "Host Hermes ACP refused the prompt.",
      payload: { stopReason },
    });
    events.push({ type: "failed", error: "Host Hermes ACP refused the prompt." });
    return events;
  }
  if (stopReason === null || stopReason === "end_turn" || stopReason === "stop" || stopReason === "max_turn_requests") {
    const completed: AgentEvent = input.responseText.trim().length > 0 ? { type: "completed", message: input.responseText } : { type: "completed" };
    events.push(completed);
    return events;
  }
  events.push({
    type: "run_diagnostic",
    code: "hermes_acp_unexpected_stop_reason",
    message: `Host Hermes ACP stopped with unsupported stop reason ${stopReason}.`,
    payload: { stopReason },
  });
  events.push({ type: "failed", error: `Host Hermes ACP stopped with unsupported stop reason ${stopReason}.` });
  return events;
}

function terminalStatusFromEvents(events: AgentEvent[]): TerminalStatus {
  if (events.some((event) => event.type === "failed")) return "failed";
  if (events.some((event) => event.type === "cancelled")) return "cancelled";
  if (events.some((event) => event.type === "completed")) return "succeeded";
  return null;
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

function hermesAcpTranscriptEvent(
  event: HermesAcpRuntimeEvent,
  harnessId: string,
): { eventType: string; message?: string; payload?: unknown } | null {
  switch (event.type) {
    case "session.update":
      return {
        eventType: "acp_session_update",
        message: `Host Hermes ACP ${acpSessionUpdateKind(event.update)}`,
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
        payload: { harnessId, sessionId: event.sessionId, paramsPreview: preview(event.params, 500), redacted: true },
      };
    case "diagnostic":
      return {
        eventType: "acp_diagnostic",
        message: event.diagnostic.message,
        payload: { harnessId, code: event.diagnostic.code, detailsPreview: preview(event.diagnostic.details, 500), redacted: true },
      };
  }
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

function hostHermesAcpExitDescription(exit: HostHermesAcpProcessExit): string {
  if (exit.signal) return `signal ${exit.signal}`;
  if (exit.code === null) return "exit code unknown";
  return `exit code ${exit.code}`;
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

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentEvent, AgentHarness, AgentRunContext } from "../../src/core/harness/AgentHarness.js";
import type { ProviderLimitKind, ProviderLimitSignal } from "../../src/core/provider/ProviderLimits.js";
import {
  symphonyRoleMcpServers,
  writeActiveHandoffMcpContexts,
  writeInitialHandoffMcpContexts,
} from "../../src/core/harness/HandoffMcp.js";
import { errorMessage, SymphonyError } from "../../src/core/errors.js";
import type { RunTranscriptStore } from "../../src/core/persistence/RunTranscriptStore.js";
import type { AgentRunPhase, TokenCounts } from "../../src/core/types.js";
import { redactTranscriptText, sanitizedPreviewValue } from "../../src/core/transcript/TranscriptProjection.js";
import { resolveRuntimeCredential } from "../../src/app/RuntimeDependencies.js";
import { ScopedGatewayClient, type GatewayEvent, type HermesGatewayClient, type HermesGatewayEnvironment } from "./GatewayFacade.js";
import {
  HermesAuthManager,
  hermesOwnedAuthProvidersForRuntime,
  isHermesOwnedAuthProvider,
  normalizeHermesAuthProvider,
} from "./HermesAuthManager.js";
import { SYMPHONY_HERMES_AGENT_MAX_TURNS, writeHermesMcpConfig } from "./HermesMcpConfig.js";
import { HermesProfileManager, safeProfileKey, type HermesProfile } from "./HermesProfileManager.js";

export interface HermesHarnessOptions {
  runStore?: RunTranscriptStore;
  cliPath?: string;
  gatewayFactory?: (env: HermesGatewayEnvironment) => HermesGatewayClient;
  profileManager?: HermesProfileManager;
  authManager?: HermesAuthManager;
}

interface HermesLease {
  key: string;
  reusable: boolean;
  profile: HermesProfile;
  client: HermesGatewayClient;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  shutdownGraceMs: number;
  gatewaySessionId: string | null;
  disposed: boolean;
}

type TerminalStatus = "succeeded" | "failed" | "cancelled" | null;

export class HermesHarness implements AgentHarness {
  readonly id = "hermes";
  readonly capabilities = {
    continuation: true,
    mcpHandoff: true,
    runStatus: false,
    liveDiagnostics: true,
  };
  readonly supportsContinuation = true;

  private readonly leases = new Map<string, HermesLease>();
  private readonly activeRuns = new Map<string, HermesLease>();
  private readonly cancelledRuns = new Set<string>();
  private readonly gatewayFactory: (env: HermesGatewayEnvironment) => HermesGatewayClient;

  constructor(private readonly options: HermesHarnessOptions = {}) {
    this.gatewayFactory = options.gatewayFactory ?? ((env) => new ScopedGatewayClient(env));
  }

  async prepare(ctx: AgentRunContext): Promise<void> {
    await writeInitialHandoffMcpContexts(ctx);
  }

  async reload(_ctx: AgentRunContext): Promise<void> {
    return;
  }

  async *run(ctx: AgentRunContext, prompt: string): AsyncIterable<AgentEvent> {
    await writeInitialHandoffMcpContexts(ctx);
    const lease = await this.getOrCreateLease(ctx);
    const runId = `hermes-${randomUUID()}`;
    this.activeRuns.set(runId, lease);

    const queue = new AsyncEventQueue<AgentEvent>();
    const pendingRuntimeEvents: GatewayEvent[] = [];
    let sessionStarted = false;
    let terminalStatus: TerminalStatus = null;
    let symphonySessionId: string | null = null;

    const enqueue = (event: AgentEvent) => queue.push({ ...event, at: event.at ?? new Date().toISOString() });
    const persistRuntimeEvent = (event: GatewayEvent): void => {
      const transcriptEvent = hermesTranscriptEvent(event, this.id);
      if (!transcriptEvent) return;
      void this.options.runStore?.appendEvent({
        runId,
        at: new Date().toISOString(),
        source: "runtime",
        ...transcriptEvent,
      });
    };
    const appendRuntimeEvent = (event: GatewayEvent): void => {
      if (!sessionStarted) {
        pendingRuntimeEvents.push(event);
        return;
      }
      persistRuntimeEvent(event);
    };
    const onGatewayEvent = (event: GatewayEvent) => {
      if (!acceptGatewayEvent(event, lease.gatewaySessionId)) return;
      appendRuntimeEvent(event);
      for (const mapped of mapHermesGatewayEvent(event, {
        cancelled: ctx.abortSignal.aborted || this.cancelledRuns.has(runId),
        providerId: ctx.config.hermes.provider,
        model: ctx.config.hermes.model,
      })) {
        if (mapped.type === "completed") terminalStatus = "succeeded";
        if (mapped.type === "failed") terminalStatus = "failed";
        if (mapped.type === "cancelled") terminalStatus = "cancelled";
        enqueue(mapped);
      }
      if (terminalStatus !== null) queue.close();
    };
    const onExit = (code: number | null) => {
      this.retireLeaseAfterTransportExit(lease);
      if (terminalStatus !== null) return;
      terminalStatus = ctx.abortSignal.aborted || this.cancelledRuns.has(runId) ? "cancelled" : "failed";
      enqueue(
        terminalStatus === "cancelled"
          ? { type: "cancelled" }
          : hermesRunDiagnostic("hermes_gateway_exit", `Hermes gateway exited before the run completed${code === null ? "" : ` (code ${code})`}`, {
              runId,
              sessionId: symphonySessionId,
              profileDir: lease.profile.profileDir,
              gatewayExitCode: code,
              gatewayLogTail: gatewayLogTailPayload(lease),
            }),
      );
      if (terminalStatus !== "cancelled") {
        enqueue({
          type: "failed",
          error: `Hermes gateway exited before the run completed${code === null ? "" : ` (code ${code})`}`,
        });
      }
      queue.close();
    };
    const abort = () => {
      this.cancelledRuns.add(runId);
      void this.interruptLease(lease, "abort_signal").catch((error) => {
        ctx.logger.warn("hermes interrupt after abort failed", {
          run_id: runId,
          issue_id: ctx.issue.id,
          issue_identifier: ctx.issue.identifier,
          error: errorMessage(error),
        });
      });
    };

    lease.client.on("event", onGatewayEvent);
    lease.client.on("exit", onExit);
    lease.client.drain();
    ctx.abortSignal.addEventListener("abort", abort, { once: true });
    if (ctx.abortSignal.aborted) abort();

    try {
      const gatewaySessionId = await this.ensureGatewaySession(lease);
      symphonySessionId = `${lease.profile.profileKey}:${gatewaySessionId}:${runId}`;
      await writeActiveHandoffMcpContexts(ctx, { activeRunId: runId, sessionId: symphonySessionId });
      const promptSubmit = this.gatewayRequest(lease, "prompt.submit", { session_id: gatewaySessionId, text: prompt }).then(
        () => null,
        (error: unknown) => error,
      );
      yield {
        type: "session_started",
        sessionId: symphonySessionId,
        threadId: gatewaySessionId,
        runId,
      };
      sessionStarted = true;
      for (const event of pendingRuntimeEvents.splice(0)) persistRuntimeEvent(event);
      await this.options.runStore?.appendEvent({
        runId,
        at: new Date().toISOString(),
        source: "runtime",
        eventType: "hermes_profile",
        message: `Hermes profile ${lease.profile.profileKey}`,
        payload: {
          harnessId: this.id,
          profileDir: lease.profile.profileDir,
          templateDir: lease.profile.templateDir,
          gatewaySessionId,
          reusable: lease.reusable,
        },
      });

      const promptSubmitError = await promptSubmit;
      if (promptSubmitError !== null) throw promptSubmitError;

      for await (const event of queue) {
        yield event;
      }
    } catch (error) {
      this.retireReusableLeaseAfterRequestFailure(lease, "run_error");
      terminalStatus = "failed";
      const providerLimit = providerLimitSignalFromHermesError(error, {
        providerId: ctx.config.hermes.provider,
        model: ctx.config.hermes.model,
      });
      if (providerLimit) {
        yield { type: "provider_limit", signal: providerLimit };
      }
      yield hermesRunDiagnostic("hermes_run_error", `Hermes run failed: ${errorMessage(error)}`, {
        runId,
        sessionId: symphonySessionId,
        profileDir: lease.profile.profileDir,
        gatewayLogTail: gatewayLogTailPayload(lease),
      });
      yield { type: "failed", error: `Hermes run failed: ${errorMessage(error)}` };
    } finally {
      ctx.abortSignal.removeEventListener("abort", abort);
      lease.client.off("event", onGatewayEvent);
      lease.client.off("exit", onExit);
      this.activeRuns.delete(runId);
      this.cancelledRuns.delete(runId);
      if (!lease.reusable) {
        await this.disposeLease(lease, "run_finished");
        await this.cleanupProfileAfterRun(ctx, lease, terminalStatus);
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
    await Promise.all([...this.leases.values()].map((lease) => this.disposeLease(lease, "harness_dispose")));
    this.leases.clear();
  }

  private async getOrCreateLease(ctx: AgentRunContext): Promise<HermesLease> {
    const reusable = shouldReuseLease(ctx);
    const key = reusable ? reusableLeaseKey(ctx) : `fresh:${randomUUID()}`;
    const existing = reusable ? this.leases.get(key) : undefined;
    if (existing && !existing.disposed) return existing;

    const manager = this.effectiveProfileManager(ctx);
    const phase = currentRunPhase(ctx);
    const profileKey = hermesRunProfileKey(ctx.issue.identifier, phase, reusable);
    const profile = await manager.materialize({
      workspaceKey: ctx.workspace.workspaceKey,
      role: ctx.role,
      phase,
      template: templateForRun(ctx),
      profileKey,
      mode: reusable ? "reuse" : "fresh",
    });
    await writeHermesMcpConfig({
      profileDir: profile.profileDir,
      servers: symphonyRoleMcpServers(ctx, { cliPath: this.cliPath(), mcpCwd: ctx.workspace.path }),
      agentMaxTurns: SYMPHONY_HERMES_AGENT_MAX_TURNS,
    });

    const requiredAuthProviders = hermesOwnedAuthProvidersForRuntime(ctx.config.hermes.provider, ctx.config.hermes.auth.providers);
    if (isHermesOwnedAuthProvider(ctx.config.hermes.provider) && requiredAuthProviders.length === 0) {
      throw new SymphonyError(
        "config_validation_error",
        `Hermes provider ${normalizeHermesAuthProvider(ctx.config.hermes.provider ?? "")} requires hermes.auth.providers to include openai-codex`,
      );
    }
    if (requiredAuthProviders.length > 0) {
      await this.effectiveAuthManager(ctx).requireProviders(requiredAuthProviders);
    }

    const credential = requiredAuthProviders.length > 0 ? null : resolveRuntimeCredential(ctx.config, ctx.role, this.id);
    const extraEnv: Record<string, string> = {};
    if (credential?.value) extraEnv[ctx.config.hermes.runtimeCredentialEnv] = credential.value;
    const client = this.gatewayFactory({
      upstreamRoot: ctx.config.hermes.upstreamRoot,
      hermesHome: profile.profileDir,
      authHome: requiredAuthProviders.length > 0 ? ctx.config.hermes.auth.managedRoot : null,
      cwd: ctx.workspace.path,
      python: ctx.config.hermes.python,
      model: ctx.config.hermes.model,
      provider: ctx.config.hermes.provider,
      startupTimeoutMs: ctx.config.hermes.startupTimeoutMs,
      requestTimeoutMs: ctx.config.hermes.requestTimeoutMs,
      extraEnv,
    });
    const lease: HermesLease = {
      key,
      reusable,
      profile,
      client,
      startupTimeoutMs: ctx.config.hermes.startupTimeoutMs,
      requestTimeoutMs: ctx.config.hermes.requestTimeoutMs,
      shutdownGraceMs: ctx.config.hermes.shutdownGraceMs,
      gatewaySessionId: null,
      disposed: false,
    };
    if (reusable) this.leases.set(key, lease);
    return lease;
  }

  private effectiveProfileManager(ctx: AgentRunContext): HermesProfileManager {
    if (this.options.profileManager) return this.options.profileManager;
    return new HermesProfileManager({
      templatesDir: ctx.config.hermes.templatesDir,
      stateDir: ctx.config.hermes.stateDir,
    });
  }

  private effectiveAuthManager(ctx: AgentRunContext): HermesAuthManager {
    if (this.options.authManager) return this.options.authManager;
    return new HermesAuthManager({
      managedRoot: ctx.config.hermes.auth.managedRoot,
      bootstrapFrom: ctx.config.hermes.auth.bootstrapFrom,
      providers: ctx.config.hermes.auth.providers,
      upstreamRoot: ctx.config.hermes.upstreamRoot,
      python: ctx.config.hermes.python,
      timeoutMs: ctx.config.hermes.startupTimeoutMs,
    });
  }

  private async ensureGatewaySession(lease: HermesLease): Promise<string> {
    if (lease.gatewaySessionId) return lease.gatewaySessionId;
    const response = await this.gatewayRequest<{ session_id?: unknown }>(lease, "session.create", { cols: 120 }, lease.startupTimeoutMs);
    const gatewaySessionId = typeof response.session_id === "string" ? response.session_id : "";
    if (!gatewaySessionId) throw new SymphonyError("agent_error", "Hermes gateway did not return a session_id");
    lease.gatewaySessionId = gatewaySessionId;
    return gatewaySessionId;
  }

  private async gatewayRequest<T = unknown>(
    lease: HermesLease,
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = lease.requestTimeoutMs,
  ): Promise<T> {
    return promiseWithTimeout(
      lease.client.request<T>(method, params),
      timeoutMs,
      `Hermes gateway request ${method} timed out after ${timeoutMs}ms`,
    );
  }

  private async interruptLease(lease: HermesLease, reason: string): Promise<void> {
    if (lease.disposed) return;
    const sessionId = lease.gatewaySessionId;
    if (sessionId) {
      try {
        await this.gatewayRequest(lease, "session.interrupt", { session_id: sessionId });
      } catch {
        lease.client.kill(`hermes.${reason}.interrupt_failed`);
      }
    } else {
      lease.client.kill(`hermes.${reason}.no_session`);
    }
  }

  private async disposeLease(lease: HermesLease, reason: string): Promise<void> {
    if (lease.disposed) return;
    lease.disposed = true;
    this.leases.delete(lease.key);
    if (lease.gatewaySessionId) {
      try {
        await this.gatewayRequest(lease, "session.close", { session_id: lease.gatewaySessionId });
      } catch {
        // best effort; kill below is the hard boundary.
      }
    }
    lease.client.kill(`hermes.${reason}`);
  }

  private retireLeaseAfterTransportExit(lease: HermesLease): void {
    if (lease.disposed) return;
    lease.disposed = true;
    lease.gatewaySessionId = null;
    this.leases.delete(lease.key);
  }

  private retireReusableLeaseAfterRequestFailure(lease: HermesLease, reason: string): void {
    if (!lease.reusable || lease.disposed) return;
    lease.disposed = true;
    lease.gatewaySessionId = null;
    this.leases.delete(lease.key);
    lease.client.kill(`hermes.${reason}`);
  }

  private async cleanupProfileAfterRun(ctx: AgentRunContext, lease: HermesLease, terminalStatus: TerminalStatus): Promise<void> {
    const keep = ctx.config.hermes.keepProfiles;
    if (keep === "always") return;
    if (keep === "failed" && terminalStatus === "failed") return;
    await removeProfileInsideState(ctx.config.hermes.stateDir, lease.profile.profileDir).catch((error: unknown) => {
      ctx.logger.warn("hermes profile cleanup failed", {
        issue_id: ctx.issue.id,
        issue_identifier: ctx.issue.identifier,
        profile_dir: lease.profile.profileDir,
        error: errorMessage(error),
      });
    });
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
    ctx.config.hermes.workerSessionLifecycle === "reuse_by_issue"
  );
}

function reusableLeaseKey(ctx: AgentRunContext): string {
  return `${ctx.workspace.path}:worker:${ctx.issue.id || ctx.issue.identifier}:${currentRunPhase(ctx)}`;
}

function templateForRun(ctx: AgentRunContext): string {
  const phase = currentRunPhase(ctx);
  if (ctx.role === "reviewer") return ctx.config.hermes.roleTemplates.reviewer;
  if (phase === "issue_breakdown") return ctx.config.hermes.roleTemplates.planner;
  if (phase === "merge_conflict_resolution") return ctx.config.hermes.roleTemplates.mergeConflictResolution;
  return ctx.config.hermes.roleTemplates.worker;
}

function currentRunPhase(ctx: AgentRunContext): AgentRunPhase {
  return ctx.runPhase ?? (ctx.role === "reviewer" ? "review" : "implementation");
}

function hermesRunProfileKey(issueIdentifier: string, phase: AgentRunPhase, reusable: boolean): string {
  const suffix = reusable ? "" : `-${randomUUID().slice(0, 8)}`;
  return safeProfileKey(`${issueIdentifier}-${phase}${suffix}`);
}

function acceptGatewayEvent(event: GatewayEvent, sessionId: string | null): boolean {
  if (event.type.startsWith("gateway.")) return true;
  if (!sessionId) return false;
  return event.session_id === undefined || event.session_id === sessionId;
}

function hermesRunDiagnostic(code: string, message: string, payload: Record<string, unknown>): AgentEvent {
  return {
    type: "run_diagnostic",
    code,
    message,
    payload,
  };
}

interface HermesLimitMappingDefaults {
  providerId?: string | null;
  model?: string | null;
}

function providerLimitSignalFromHermesPayload(
  payload: unknown,
  defaults: HermesLimitMappingDefaults = {},
): ProviderLimitSignal | null {
  if (!isRecord(payload)) return null;
  const windowRecord = isRecord(payload.window) ? payload.window : {};
  const resumeAt =
    isoFromUnknown(payload.resume_at) ??
    isoFromUnknown(payload.resumeAt) ??
    isoFromUnknown(payload.reset_at) ??
    isoFromUnknown(payload.resetAt) ??
    isoFromUnknown(windowRecord.resume_at) ??
    isoFromUnknown(windowRecord.resumeAt) ??
    isoFromUnknown(windowRecord.reset_at) ??
    isoFromUnknown(windowRecord.resetAt);
  const retryAfterMs =
    numberFromUnknown(payload.retry_after_ms) ??
    numberFromUnknown(payload.retryAfterMs) ??
    secondsToMs(payload.retry_after) ??
    secondsToMs(payload.retryAfter) ??
    numberFromUnknown(windowRecord.retry_after_ms) ??
    numberFromUnknown(windowRecord.retryAfterMs);
  const message = nonEmptyString(payload.message) ?? "Provider limit reached";
  const providerId =
    nonEmptyString(payload.provider_id) ??
    nonEmptyString(payload.providerId) ??
    nonEmptyString(payload.provider) ??
    defaults.providerId ??
    null;
  const model = nonEmptyString(payload.model) ?? defaults.model ?? null;
  return {
    scope: {
      harnessId: "hermes",
      providerId,
      model,
      accountScopeKey: nonEmptyString(payload.account_scope_key) ?? nonEmptyString(payload.accountScopeKey) ?? null,
    },
    kind: normalizeProviderLimitKind(nonEmptyString(payload.kind), message),
    window: {
      resumeAt,
      retryAfterMs,
      windowLabel:
        nonEmptyString(payload.window_label) ??
        nonEmptyString(payload.windowLabel) ??
        nonEmptyString(windowRecord.window_label) ??
        nonEmptyString(windowRecord.windowLabel) ??
        null,
      windowKind:
        nonEmptyString(payload.window_kind) ??
        nonEmptyString(payload.windowKind) ??
        nonEmptyString(windowRecord.window_kind) ??
        nonEmptyString(windowRecord.windowKind) ??
        null,
    },
    resumePolicy:
      nonEmptyString(payload.resume_policy) === "manual" || (!resumeAt && retryAfterMs === null)
        ? "manual"
        : "auto_at_window_close",
    message,
    observedAt: isoFromUnknown(payload.observed_at) ?? isoFromUnknown(payload.observedAt) ?? new Date().toISOString(),
    raw: payload.raw ?? payload,
  };
}

function credibleProviderLimitSignalFromHermesPayload(
  payload: unknown,
  defaults: HermesLimitMappingDefaults = {},
): ProviderLimitSignal | null {
  const signal = providerLimitSignalFromHermesPayload(payload, defaults);
  if (!signal || hasEmptyHermesResultClassifierEvidence(signal)) return null;
  return signal;
}

function hasEmptyHermesResultClassifierEvidence(signal: ProviderLimitSignal): boolean {
  const window = signal.window;
  if (
    window?.resumeAt ||
    window?.retryAfterMs != null ||
    window?.windowLabel ||
    window?.windowKind
  ) {
    return false;
  }
  if (!isRecord(signal.raw)) return false;
  const rawHasHermesClassifierShape =
    "reason" in signal.raw ||
    "status_code" in signal.raw ||
    "statusCode" in signal.raw ||
    "error_context" in signal.raw ||
    "errorContext" in signal.raw;
  if (!rawHasHermesClassifierShape) return false;
  const errorContext = isRecord(signal.raw.error_context)
    ? signal.raw.error_context
    : isRecord(signal.raw.errorContext)
      ? signal.raw.errorContext
      : {};
  return (
    !hasMeaningfulValue(signal.raw.reason) &&
    !hasMeaningfulValue(signal.raw.status_code) &&
    !hasMeaningfulValue(signal.raw.statusCode) &&
    !hasMeaningfulValue(errorContext)
  );
}

function providerLimitSignalFromHermesError(error: unknown, defaults: HermesLimitMappingDefaults = {}): ProviderLimitSignal | null {
  const errorRecord = errorRecordWithProperties(error);
  const data = isRecord(errorRecord.data) ? errorRecord.data : {};
  const directPayload =
    credibleProviderLimitSignalFromHermesPayload(data.provider_limit, defaults) ??
    credibleProviderLimitSignalFromHermesPayload(data.providerLimit, defaults);
  if (directPayload) return directPayload;

  const message = errorMessage(error);
  const code = nonEmptyString(errorRecord.code) ?? nonEmptyString(data.code) ?? nonEmptyString(data.reason) ?? nonEmptyString(data.type);
  if (!looksLikeProviderLimit(`${code ?? ""} ${message} ${JSON.stringify(data)}`)) return null;
  return providerLimitSignalFromHermesPayload(
    {
      provider_id: data.provider_id ?? data.provider ?? defaults.providerId,
      model: data.model ?? defaults.model,
      kind: code,
      message,
      reset_at: data.reset_at ?? data.resets_at ?? data.retry_until,
      retry_after_ms: data.retry_after_ms,
      retry_after: data.retry_after,
      raw: {
        code: errorRecord.code,
        data,
        message,
      },
    },
    defaults,
  );
}

function gatewayLogTailPayload(lease: HermesLease): { lines: string[]; lineCount: number } | null {
  const tail = lease.client.getLogTail(50).trim();
  if (!tail) return null;
  const lines = tail
    .split(/\r?\n/g)
    .map((line) => preview(redactGatewayLogLine(line), 600))
    .filter((line) => line.length > 0);
  return { lines, lineCount: lines.length };
}

function redactGatewayLogLine(line: string): string {
  let redacted = redactTranscriptText(line).text;
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || value.length < 8 || !/[A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|AUTH)[A-Z0-9_]*/i.test(key)) continue;
    redacted = redacted.split(value).join("[redacted]");
  }
  return redacted;
}

function mapHermesGatewayEvent(event: GatewayEvent, input: { cancelled: boolean } & HermesLimitMappingDefaults): AgentEvent[] {
  switch (event.type) {
    case "gateway.ready":
      return [{ type: "progress", message: "Hermes gateway ready" }];
    case "gateway.stderr":
      return [{ type: "progress", message: `Hermes stderr: ${preview(event.payload.line, 240)}` }];
    case "gateway.start_timeout":
      return [
        {
          type: "run_diagnostic",
          code: "hermes_gateway_start_timeout",
          message: "Hermes gateway timed out before reporting ready",
          payload: event.payload,
        },
        { type: "failed", error: "Hermes gateway startup timed out" },
      ];
    case "gateway.protocol_error":
      return [
        {
          type: "run_diagnostic",
          code: "hermes_gateway_protocol_error",
          message: "Hermes gateway emitted malformed JSON-RPC output",
          payload: event.payload,
        },
      ];
    case "session.info":
      return [{ type: "progress", message: `Hermes session ready (${preview((event.payload as { model?: unknown }).model, 120)})` }];
    case "status.update":
      return [{ type: "progress", message: preview(event.payload?.text ?? event.payload?.kind ?? "Hermes status update", 240) }];
    case "message.delta":
      return [{ type: "progress", activitySource: "delta", message: preview(event.payload?.text ?? "Hermes response delta", 240) }];
    case "thinking.delta":
    case "reasoning.delta":
    case "reasoning.available":
      return [{ type: "progress", activitySource: "delta", message: preview(event.payload?.text ?? event.type, 240) }];
    case "tool.start":
      return [{ type: "progress", activitySource: "tool", message: `Hermes tool ${event.payload.name ?? "unknown"} started` }];
    case "tool.progress":
      return [{ type: "progress", activitySource: "tool", message: `Hermes tool ${event.payload.name ?? "unknown"}: ${preview(event.payload.preview, 200)}` }];
    case "tool.complete":
      return [{ type: "progress", activitySource: "tool", message: `Hermes tool ${event.payload.name ?? "unknown"} completed` }];
    case "provider.limit": {
      const signal = credibleProviderLimitSignalFromHermesPayload(event.payload, input);
      if (!signal) return [];
      return [{ type: "provider_limit", signal }, { type: "failed", error: signal.message }];
    }
    case "error":
      {
        const payloadRecord: Record<string, unknown> = isRecord(event.payload) ? event.payload : {};
        const signal =
          credibleProviderLimitSignalFromHermesPayload(payloadRecord.provider_limit, input) ??
          credibleProviderLimitSignalFromHermesPayload(payloadRecord.providerLimit, input) ??
          credibleProviderLimitSignalFromHermesPayload(event.payload, input);
        if (signal && looksLikeProviderLimit(`${signal.kind} ${signal.message}`)) {
          return [
            { type: "provider_limit", signal },
            {
              type: "run_diagnostic",
              code: "hermes_provider_limit",
              message: signal.message,
              payload: event.payload,
            },
            { type: "failed", error: signal.message },
          ];
        }
      }
      return [
        {
          type: "run_diagnostic",
          code: "hermes_gateway_error",
          message: event.payload?.message ?? "Hermes gateway error",
          payload: event.payload,
        },
        { type: "failed", error: event.payload?.message ?? "Hermes gateway error" },
      ];
    case "message.complete": {
      const payload = event.payload as { provider_limit?: unknown; providerLimit?: unknown; status?: unknown; text?: unknown; usage?: unknown } | undefined;
      const usage = usageTokens(payload?.usage);
      const providerLimit =
        credibleProviderLimitSignalFromHermesPayload(payload?.provider_limit, input) ??
        credibleProviderLimitSignalFromHermesPayload(payload?.providerLimit, input) ??
        (payload?.status === "error" && looksLikeProviderLimit(String(payload.text ?? ""))
          ? providerLimitSignalFromHermesPayload({ message: payload.text, provider_id: input.providerId, model: input.model }, input)
          : null);
      const terminal =
        providerLimit
          ? ({ type: "failed", error: providerLimit.message } as AgentEvent)
          : payload?.status === "error"
            ? ({ type: "failed", error: preview(payload.text ?? "Hermes run failed", 500) } as AgentEvent)
          : payload?.status === "interrupted" || input.cancelled
            ? ({ type: "cancelled" } as AgentEvent)
            : ({ type: "completed", message: typeof payload?.text === "string" ? payload.text : undefined } as AgentEvent);
      return [
        ...(usage === null ? [] : [{ type: "tokens", tokens: usage } as AgentEvent]),
        ...(providerLimit ? [{ type: "provider_limit", signal: providerLimit } as AgentEvent] : []),
        terminal,
      ];
    }
    default:
      return [];
  }
}

function hermesTranscriptEvent(event: GatewayEvent, harnessId: string): { eventType: string; message?: string; payload?: unknown } | null {
  switch (event.type) {
    case "message.delta":
      return {
        eventType: "message_delta",
        message: "Hermes message delta",
        payload: { harnessId, textPreview: preview(event.payload?.text, 500), redacted: true },
      };
    case "message.complete":
      return {
        eventType: "message_complete",
        message: "Hermes message complete",
        payload: { harnessId, ...messageCompletePayload(event.payload) },
      };
    case "tool.start":
      return {
        eventType: "tool_start",
        message: `Hermes tool ${event.payload.name ?? "unknown"} started`,
        payload: {
          harnessId,
          name: event.payload.name ?? null,
          toolId: event.payload.tool_id,
          argsPreview: preview(event.payload.args_text, 500),
          redacted: true,
        },
      };
    case "tool.complete":
      return {
        eventType: "tool_complete",
        message: `Hermes tool ${event.payload.name ?? "unknown"} completed`,
        payload: {
          harnessId,
          name: event.payload.name ?? null,
          toolId: event.payload.tool_id,
          summary: preview(event.payload.summary, 500),
          resultPreview: preview(event.payload.result_text, 500),
          errorPreview: preview(event.payload.error, 500),
          redacted: true,
        },
      };
    case "status.update":
      return {
        eventType: "status_update",
        message: preview(event.payload?.text ?? event.payload?.kind ?? "Hermes status update", 240),
        payload: { harnessId, kind: event.payload?.kind ?? null },
      };
    case "gateway.stderr":
      return {
        eventType: "gateway_stderr",
        message: "Hermes gateway stderr",
        payload: { harnessId, linePreview: preview(event.payload.line, 500), redacted: true },
      };
    default:
      return null;
  }
}

function messageCompletePayload(payload: unknown): Record<string, unknown> {
  const record = isRecord(payload) ? payload : {};
  return {
    textPreview: preview(record.text, 500),
    status: preview(record.status, 80),
    usage: isRecord(record.usage) ? record.usage : null,
    redacted: true,
  };
}

function usageTokens(usage: unknown): Partial<TokenCounts> | null {
  if (!isRecord(usage)) return null;
  const input = typeof usage.input === "number" ? usage.input : undefined;
  const output = typeof usage.output === "number" ? usage.output : undefined;
  const total = typeof usage.total === "number" ? usage.total : undefined;
  if (input === undefined && output === undefined && total === undefined) return null;
  return {
    ...(input === undefined ? {} : { inputTokens: input }),
    ...(output === undefined ? {} : { outputTokens: output }),
    ...(total === undefined ? {} : { totalTokens: total }),
  };
}

function preview(value: unknown, maxLength: number): string {
  return sanitizedPreviewValue(value, maxLength).preview ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorRecordWithProperties(error: unknown): Record<string, unknown> {
  if (isRecord(error)) return error;
  if (!(error instanceof Error)) return {};
  const record: Record<string, unknown> = { message: error.message };
  const withStructured = error as Error & { code?: unknown; data?: unknown; rpcError?: unknown };
  if (withStructured.code !== undefined) record.code = withStructured.code;
  if (withStructured.data !== undefined) record.data = withStructured.data;
  if (withStructured.rpcError !== undefined) record.rpcError = withStructured.rpcError;
  return record;
}

function normalizeProviderLimitKind(kind: string | null, message: string): ProviderLimitKind {
  const text = `${kind ?? ""} ${message}`.toLowerCase();
  if (text.includes("credit") || text.includes("billing") || text.includes("insufficient_quota")) return "credits_exhausted";
  if (text.includes("subscription") || text.includes("entitlement") || text.includes("plan required")) return "subscription_required";
  if (text.includes("usage_limit") || text.includes("usage limit") || text.includes("weekly") || text.includes("5 hour") || text.includes("5-hour")) {
    return "windowed_bucket_exhausted";
  }
  if (text.includes("rate_limit") || text.includes("rate limit") || text.includes("429")) return "transient_rate_limit";
  if (
    kind === "transient_rate_limit" ||
    kind === "windowed_bucket_exhausted" ||
    kind === "credits_exhausted" ||
    kind === "subscription_required" ||
    kind === "unknown_limit"
  ) {
    return kind;
  }
  return "unknown_limit";
}

function looksLikeProviderLimit(value: string): boolean {
  const text = value.toLowerCase();
  return (
    text.includes("provider.limit") ||
    text.includes("usage_limit_reached") ||
    text.includes("usage limit") ||
    text.includes("rate_limit") ||
    text.includes("rate limit") ||
    text.includes("429") ||
    text.includes("credit") ||
    text.includes("billing") ||
    text.includes("quota") ||
    text.includes("subscription")
  );
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function hasMeaningfulValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(hasMeaningfulValue);
  if (isRecord(value)) return Object.values(value).some(hasMeaningfulValue);
  return true;
}

function numberFromUnknown(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function secondsToMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.round(value * 1_000);
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.round(numeric * 1_000) : null;
}

function isoFromUnknown(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 10_000_000_000 ? value : value * 1_000;
    return new Date(ms).toISOString();
  }
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

async function removeProfileInsideState(stateDir: string, profileDir: string): Promise<void> {
  const root = path.resolve(stateDir);
  const target = path.resolve(profileDir);
  const relative = path.relative(root, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return;
  await fs.rm(target, { recursive: true, force: true });
}

function promiseWithTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

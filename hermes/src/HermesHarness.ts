import { randomUUID } from "node:crypto";
import fsSync, { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentCommandPolicyDecision } from "../../src/core/harness/AgentCommandPolicy.js";
import {
  buildAgentCommandPolicyHookDecisionJournalFallbackPath,
  type AgentCommandPolicyHookDecisionJournalEntry,
} from "../../src/core/harness/AgentCommandPolicyHookRunner.js";
import type { AgentEvent, AgentHarness, AgentRunContext, OperatorChatRunContext } from "../../src/core/harness/AgentHarness.js";
import type { ProviderLimitKind, ProviderLimitSignal } from "../../src/core/provider/ProviderLimits.js";
import type { RunActivityEvent, RunActivityCommandPolicyDecisionPayload } from "../../src/core/runActivity/RunActivityEvent.js";
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
import {
  buildHermesAgentCommandPolicyDecisionJournalPath,
  buildHermesAgentCommandPolicyHookConfig,
  SYMPHONY_HERMES_AGENT_MAX_TURNS,
  type BuildHermesAgentCommandPolicyHookOptions,
  type HermesAgentCommandPolicyHookVerifier,
  verifyHermesAgentCommandPolicyHookInstallation,
  writeHermesMcpConfig,
} from "./HermesMcpConfig.js";
import { hermesAcpProfileName, HermesProfileManager, type HermesProfile } from "./HermesProfileManager.js";

export interface HermesHarnessOptions {
  runStore?: RunTranscriptStore;
  cliPath?: string;
  gatewayFactory?: (env: HermesGatewayEnvironment) => HermesGatewayClient;
  profileManager?: HermesProfileManager;
  authManager?: HermesAuthManager;
  commandPolicyHookVerifier?: HermesAgentCommandPolicyHookVerifier;
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
  hermesSessionKey: string | null;
  gatewaySessionResumed: boolean;
  commandPolicyDecisionJournalPath: string | null;
  disposed: boolean;
}

type TerminalStatus = "succeeded" | "failed" | "cancelled" | null;

const HERMES_SESSION_STATE_FILENAME = ".symphony-hermes-session.json";

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
  private readonly reusableSessionKeys = new Map<string, string>();
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
    resetHookDecisionJournal(lease.commandPolicyDecisionJournalPath);
    const runId = `hermes-${randomUUID()}`;
    this.activeRuns.set(runId, lease);

    const queue = new AsyncEventQueue<AgentEvent>();
    const pendingRuntimeEvents: GatewayEvent[] = [];
    let sessionStarted = false;
    let terminalStatus: TerminalStatus = null;
    let symphonySessionId: string | null = null;
    let hookDecisionSequence = 0;

    const enqueue = (event: AgentEvent) => queue.push({ ...event, at: event.at ?? new Date().toISOString() });
    const enqueueHookDecisionJournal = () => {
      if (!lease.commandPolicyDecisionJournalPath) return;
      for (const entry of drainHookDecisionJournals(lease.commandPolicyDecisionJournalPath, ctx.logger.warn.bind(ctx.logger))) {
        enqueue(
          hookDecisionAgentEvent(entry, {
            runId,
            runSessionId: symphonySessionId ?? `${lease.profile.profileKey}:pending:${runId}`,
            harnessId: this.id,
            sequence: ++hookDecisionSequence,
          }),
        );
      }
    };
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
      this.rememberHermesSessionKeyFromEvent(lease, event);
      enqueueHookDecisionJournal();
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
      if (terminalStatus !== null) {
        enqueueHookDecisionJournal();
        queue.close();
      }
    };
    const onExit = (code: number | null) => {
      this.retireLeaseAfterTransportExit(lease);
      enqueueHookDecisionJournal();
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
          hermesSessionKey: lease.hermesSessionKey,
          sessionResumed: lease.gatewaySessionResumed,
          reusable: lease.reusable,
        },
      });

      const promptSubmitError = await promptSubmit;
      enqueueHookDecisionJournal();
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
      } else {
        await this.persistReusableHermesSessionKeyAfterRun(ctx, lease);
        await this.disposeLease(lease, "run_finished");
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
    const freshLeaseId = reusable ? null : randomUUID();
    const key = reusable ? reusableLeaseKey(ctx) : `fresh:${freshLeaseId}`;
    const existing = reusable ? this.leases.get(key) : undefined;
    if (existing && !existing.disposed) {
      await this.disposeLease(existing, "superseded_reusable_run");
    }

    const manager = this.effectiveProfileManager(ctx);
    const phase = currentRunPhase(ctx);
    const cliPath = this.cliPath();
    const profileKey = hermesRunProfileKey(ctx, phase, reusable, freshLeaseId);
    const profile = await manager.materialize({
      workspaceKey: ctx.workspace.workspaceKey,
      role: ctx.role,
      phase,
      template: templateForRun(ctx),
      profileKey,
      mode: reusable ? "reuse" : "fresh",
    });
    const commandPolicyHookOptions = agentCommandPolicyHookOptionsForRun(ctx, phase, cliPath, profile.profileDir);
    const commandPolicyHooks =
      commandPolicyHookOptions === undefined ? undefined : buildHermesAgentCommandPolicyHookConfig(commandPolicyHookOptions);
    await writeHermesMcpConfig({
      profileDir: profile.profileDir,
      servers: symphonyRoleMcpServers(ctx, { cliPath, mcpCwd: ctx.workspace.path }),
      agentMaxTurns: SYMPHONY_HERMES_AGENT_MAX_TURNS,
      ...(commandPolicyHooks === undefined ? {} : { hooks: commandPolicyHooks, hooksAutoAccept: true }),
    });
    if (commandPolicyHookOptions !== undefined) {
      await (this.options.commandPolicyHookVerifier ?? verifyHermesAgentCommandPolicyHookInstallation)({
        ...commandPolicyHookOptions,
        profileDir: profile.profileDir,
        upstreamRoot: ctx.config.hermes.upstreamRoot,
        python: ctx.config.hermes.python,
        smokeCwd: ctx.workspace.path,
      });
    }

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

    const persistedHermesSessionKey = reusable ? await readHermesSessionKey(profile.profileDir, ctx.logger.warn.bind(ctx.logger)) : null;
    const hermesSessionKey = reusable ? this.reusableSessionKeys.get(key) ?? persistedHermesSessionKey : null;
    if (reusable && hermesSessionKey) this.reusableSessionKeys.set(key, hermesSessionKey);

    const credential =
      requiredAuthProviders.length > 0
        ? null
        : resolveRuntimeCredential(ctx.config, ctx.role, this.id, ctx.projectContext?.projectContextId);
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
      hermesSessionKey,
      gatewaySessionResumed: false,
      commandPolicyDecisionJournalPath: commandPolicyHookOptions?.decisionJournalPath ?? null,
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
    if (lease.client.isClosed()) {
      this.retireLeaseAfterTransportExit(lease);
      throw new SymphonyError("agent_error", "Hermes gateway is closed");
    }
    if (lease.gatewaySessionId) return lease.gatewaySessionId;

    if (lease.reusable && lease.hermesSessionKey) {
      try {
        const response = await this.gatewayRequest<{ resumed?: unknown; session_id?: unknown }>(
          lease,
          "session.resume",
          { cols: 120, session_id: lease.hermesSessionKey },
          lease.startupTimeoutMs,
        );
        const gatewaySessionId = nonEmptyString(response.session_id);
        if (!gatewaySessionId) throw new SymphonyError("agent_error", "Hermes gateway did not return a session_id");
        lease.gatewaySessionId = gatewaySessionId;
        lease.gatewaySessionResumed = true;
        await this.rememberHermesSessionKey(lease, nonEmptyString(response.resumed) ?? lease.hermesSessionKey);
        return gatewaySessionId;
      } catch (error) {
        if (!isMissingHermesSessionError(error)) throw error;
        await this.forgetHermesSessionKey(lease);
      }
    }

    const response = await this.gatewayRequest<{ session_id?: unknown; session_key?: unknown }>(
      lease,
      "session.create",
      { cols: 120 },
      lease.startupTimeoutMs,
    );
    const gatewaySessionId = typeof response.session_id === "string" ? response.session_id : "";
    if (!gatewaySessionId) throw new SymphonyError("agent_error", "Hermes gateway did not return a session_id");
    lease.gatewaySessionId = gatewaySessionId;
    lease.gatewaySessionResumed = false;
    if (lease.reusable) {
      const hermesSessionKey = nonEmptyString(response.session_key);
      if (!hermesSessionKey) {
        throw new SymphonyError("agent_error", "Hermes gateway did not return a session_key for reusable worker session");
      }
      await this.rememberHermesSessionKey(lease, hermesSessionKey);
    }
    return gatewaySessionId;
  }

  async *runOperatorChat(ctx: OperatorChatRunContext, prompt: string): AsyncIterable<AgentEvent> {
    yield* this.run(operatorChatAgentRunContext(ctx), prompt);
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
    lease.gatewaySessionId = null;
    lease.gatewaySessionResumed = false;
    lease.client.kill(`hermes.${reason}`);
  }

  private retireLeaseAfterTransportExit(lease: HermesLease): void {
    if (lease.disposed) return;
    lease.disposed = true;
    lease.gatewaySessionId = null;
    lease.gatewaySessionResumed = false;
    this.leases.delete(lease.key);
  }

  private retireReusableLeaseAfterRequestFailure(lease: HermesLease, reason: string): void {
    if (!lease.reusable || lease.disposed) return;
    lease.disposed = true;
    lease.gatewaySessionId = null;
    lease.gatewaySessionResumed = false;
    this.leases.delete(lease.key);
    lease.client.kill(`hermes.${reason}`);
  }

  private async rememberHermesSessionKey(lease: HermesLease, hermesSessionKey: string): Promise<void> {
    lease.hermesSessionKey = hermesSessionKey;
    if (!lease.reusable) return;
    this.reusableSessionKeys.set(lease.key, hermesSessionKey);
    await writeHermesSessionKey(lease.profile.profileDir, hermesSessionKey);
  }

  private async forgetHermesSessionKey(lease: HermesLease): Promise<void> {
    lease.hermesSessionKey = null;
    if (!lease.reusable) return;
    this.reusableSessionKeys.delete(lease.key);
    await removeHermesSessionKey(lease.profile.profileDir);
  }

  private rememberHermesSessionKeyFromEvent(lease: HermesLease, event: GatewayEvent): void {
    if (!lease.reusable || !isRecord(event.payload)) return;
    const payload = event.payload as Record<string, unknown>;
    const hermesSessionKey = nonEmptyString(payload.session_key) ?? nonEmptyString(payload.sessionKey);
    if (!hermesSessionKey || hermesSessionKey === lease.hermesSessionKey) return;
    void this.rememberHermesSessionKey(lease, hermesSessionKey).catch(() => undefined);
  }

  private async persistReusableHermesSessionKeyAfterRun(ctx: AgentRunContext, lease: HermesLease): Promise<void> {
    if (!lease.hermesSessionKey) return;
    try {
      await writeHermesSessionKey(lease.profile.profileDir, lease.hermesSessionKey);
    } catch (error) {
      ctx.logger.warn("hermes reusable session state write failed", {
        profile_dir: lease.profile.profileDir,
        error: errorMessage(error),
      });
    }
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
  if (ctx.operatorChat) return true;
  return (
    ctx.role === "worker" &&
    currentRunPhase(ctx) === "implementation" &&
    ctx.config.hermes.workerSessionLifecycle === "reuse_by_issue"
  );
}

function reusableLeaseKey(ctx: AgentRunContext): string {
  if (ctx.operatorChat) return `${ctx.workspace.path}:operator:${ctx.operatorChat.conversationId}`;
  return `${ctx.workspace.path}:worker:${ctx.issue.id || ctx.issue.identifier}:${currentRunPhase(ctx)}`;
}

function templateForRun(ctx: AgentRunContext): string {
  if (ctx.operatorChat) return ctx.config.hermes.roleTemplates.planner;
  const phase = currentRunPhase(ctx);
  if (ctx.role === "reviewer") return ctx.config.hermes.roleTemplates.reviewer;
  if (phase === "issue_breakdown") return ctx.config.hermes.roleTemplates.planner;
  if (phase === "merge_conflict_resolution") return ctx.config.hermes.roleTemplates.mergeConflictResolution;
  return ctx.config.hermes.roleTemplates.worker;
}

function currentRunPhase(ctx: AgentRunContext): AgentRunPhase {
  return ctx.runPhase ?? (ctx.role === "reviewer" ? "review" : "implementation");
}

function agentCommandPolicyHookOptionsForRun(
  ctx: AgentRunContext,
  phase: AgentRunPhase,
  cliPath: string,
  profileDir: string,
): BuildHermesAgentCommandPolicyHookOptions | undefined {
  if (!shouldInstallAgentCommandPolicyHook(ctx, phase)) return undefined;
  return {
    cliPath,
    decisionJournalPath: buildHermesAgentCommandPolicyDecisionJournalPath(profileDir),
    role: ctx.role,
    phase,
    issueId: ctx.issue.id || ctx.issue.identifier,
  };
}

function shouldInstallAgentCommandPolicyHook(ctx: AgentRunContext, phase: AgentRunPhase): boolean {
  if (ctx.role === "reviewer") return true;
  return ctx.role === "worker" && phase !== "issue_breakdown";
}

function hermesRunProfileKey(ctx: AgentRunContext, phase: AgentRunPhase, reusable: boolean, freshLeaseId: string | null): string {
  if (ctx.operatorChat) {
    return hermesAcpProfileName({
      workspaceKey: ctx.workspace.workspaceKey,
      role: "planner",
      issueIdentifier: ctx.operatorChat.conversationId,
      phase: "operator_chat",
      reuseMode: "reuse_by_issue",
      freshLeaseId: null,
    });
  }
  return hermesAcpProfileName({
    workspaceKey: ctx.workspace.workspaceKey,
    role: ctx.role,
    issueIdentifier: ctx.issue.identifier,
    phase,
    reuseMode: reusable ? "reuse_by_issue" : "fresh_per_run",
    freshLeaseId,
  });
}

function operatorChatAgentRunContext(ctx: OperatorChatRunContext): AgentRunContext {
  return {
    issue: {
      id: `operator:${ctx.conversationId}`,
      identifier: "OPERATOR",
      title: "Dashboard operator chat",
      description: null,
      priority: null,
      state: "operator_chat",
      branchName: null,
      url: null,
      assigneeId: null,
      delegateId: null,
      assignedToWorker: false,
      labels: [],
      blockedBy: [],
      createdAt: null,
      updatedAt: null,
    },
    role: "worker",
    runPhase: "implementation",
    attempt: null,
    workspace: ctx.workspace,
    config: ctx.config,
    turnNumber: ctx.turnNumber,
    abortSignal: ctx.abortSignal,
    logger: ctx.logger,
    operatorChat: {
      conversationId: ctx.conversationId,
      messageId: ctx.messageId,
      statusServer: ctx.statusServer ?? null,
    },
  };
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

function resetHookDecisionJournal(journalPath: string | null): void {
  if (!journalPath) return;
  for (const candidate of hookDecisionJournalPaths(journalPath)) {
    try {
      fsSync.rmSync(candidate, { force: true });
    } catch {
      // Best-effort cleanup for reused profiles.
    }
  }
}

function drainHookDecisionJournals(
  journalPath: string,
  warn: (message: string, payload?: Record<string, unknown>) => void,
): AgentCommandPolicyHookDecisionJournalEntry[] {
  return hookDecisionJournalPaths(journalPath).flatMap((candidate) => drainHookDecisionJournal(candidate, warn));
}

function hookDecisionJournalPaths(journalPath: string): string[] {
  return [journalPath, buildAgentCommandPolicyHookDecisionJournalFallbackPath(journalPath)];
}

function drainHookDecisionJournal(
  journalPath: string,
  warn: (message: string, payload?: Record<string, unknown>) => void,
): AgentCommandPolicyHookDecisionJournalEntry[] {
  if (!fsSync.existsSync(journalPath)) return [];
  try {
    const stat = fsSync.statSync(journalPath);
    if (!stat.isFile()) {
      warn("hermes command-policy journal path was not a file", { journal_path: journalPath });
      return [];
    }
  } catch (error) {
    if (isMissingFileError(error)) return [];
    warn("hermes command-policy journal stat failed", { journal_path: journalPath, error: errorMessage(error) });
    return [];
  }
  const drainedPath = `${journalPath}.${randomUUID()}.drain`;
  try {
    fsSync.renameSync(journalPath, drainedPath);
  } catch (error) {
    if (isMissingFileError(error)) return [];
    warn("hermes command-policy journal drain failed", { journal_path: journalPath, error: errorMessage(error) });
    return [];
  }

  try {
    const text = fsSync.readFileSync(drainedPath, "utf8");
    const entries: AgentCommandPolicyHookDecisionJournalEntry[] = [];
    for (const line of text.split(/\r?\n/g)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (!isHookDecisionJournalEntry(parsed)) {
          warn("hermes command-policy journal entry was invalid", {
            journal_path: journalPath,
            entry_preview: preview(trimmed, 400),
          });
          continue;
        }
        entries.push(parsed);
      } catch (error) {
        warn("hermes command-policy journal entry could not be parsed", {
          journal_path: journalPath,
          error: errorMessage(error),
          entry_preview: preview(trimmed, 400),
        });
      }
    }
    return entries;
  } catch (error) {
    warn("hermes command-policy journal read failed", { journal_path: journalPath, error: errorMessage(error) });
    return [];
  } finally {
    try {
      fsSync.rmSync(drainedPath, { force: true });
    } catch {
      // best effort
    }
  }
}

function hookDecisionAgentEvent(
  entry: AgentCommandPolicyHookDecisionJournalEntry,
  context: { runId: string; runSessionId: string; harnessId: string; sequence: number },
): AgentEvent {
  const audit = hookDecisionAudit(entry);
  const message = `Command policy ${entry.decision.outcome}: ${entry.decision.reasonKind} (${audit.role} · ${audit.phase} · ${audit.surface})`;
  return {
    type: "run_diagnostic",
    code: "command_policy_decision",
    message,
    payload: {
      outcome: entry.decision.outcome,
      reasonKind: entry.decision.reasonKind,
      requestKind: entry.requestKind,
      toolCallId: entry.toolCallId,
      permissionOutcome: entry.permissionOutcome,
      hookAction: entry.hookAction,
      redacted: true,
    },
    runActivity: hookDecisionRunActivity(entry, context, message),
  };
}

function hookDecisionRunActivity(
  entry: AgentCommandPolicyHookDecisionJournalEntry,
  context: { runId: string; runSessionId: string; harnessId: string; sequence: number },
  text: string,
): RunActivityEvent {
  const audit = hookDecisionAudit(entry);
  const payload: RunActivityCommandPolicyDecisionPayload = {
    decisionId: entry.decision.decisionId ?? null,
    attemptId: entry.decision.attemptId ?? entry.toolCallId ?? null,
    runId: context.runId,
    issueId: entry.issueId,
    surface: audit.surface,
    role: audit.role,
    phase: audit.phase,
    outcome: entry.decision.outcome,
    reasonKind: entry.decision.reasonKind,
    commandClass: entry.decision.commandClass,
    message: entry.decision.message,
    upstreamContactAttempted: entry.decision.audit.upstreamContactAttempted,
    ...(entry.decision.requiresCodeChange === undefined ? {} : { requiresCodeChange: entry.decision.requiresCodeChange }),
    ...(entry.decision.requiresUserOrServiceFix === undefined
      ? {}
      : { requiresUserOrServiceFix: entry.decision.requiresUserOrServiceFix }),
    ...(entry.decision.normalizedCommand === undefined ? {} : { normalizedCommand: entry.decision.normalizedCommand }),
    audit,
    requestKind: entry.requestKind,
    toolCallId: entry.toolCallId,
    permissionOutcome: entry.permissionOutcome,
    hookAction: entry.hookAction,
    redacted: true,
  };
  return {
    eventId: `${context.runId}:command-policy:${context.sequence}`,
    runSessionId: context.runSessionId,
    occurredAt: entry.recordedAt,
    sequence: context.sequence,
    sequenceSource: "harness",
    externalEventId: null,
    protocol: "symphony",
    harness: context.harnessId,
    actor: "harness",
    channel: "diagnostic",
    kind: "command_policy_decision",
    text,
    payload,
  };
}

function hookDecisionAudit(entry: AgentCommandPolicyHookDecisionJournalEntry): AgentCommandPolicyDecision["audit"] {
  const surface =
    entry.requestKind === "terminal_execute" && entry.decision.audit.surface === "terminal"
      ? "terminal_execute"
      : entry.decision.audit.surface;
  return surface === entry.decision.audit.surface ? entry.decision.audit : { ...entry.decision.audit, surface };
}

function isHookDecisionJournalEntry(value: unknown): value is AgentCommandPolicyHookDecisionJournalEntry {
  if (!isRecord(value)) return false;
  if (value.version !== 1 || typeof value.recordedAt !== "string") return false;
  if (!nullableString(value.runId) || !nullableString(value.issueId)) return false;
  if (!nullableString(value.requestKind) || !nullableString(value.toolCallId)) return false;
  if (!nullableString(value.permissionOutcome) || !nullableString(value.hookAction)) return false;
  return isHookDecision(value.decision);
}

function isHookDecision(value: unknown): value is AgentCommandPolicyDecision {
  if (!isRecord(value)) return false;
  if (value.outcome !== "allow" && value.outcome !== "deny") return false;
  if (typeof value.reasonKind !== "string" || typeof value.commandClass !== "string" || typeof value.message !== "string") return false;
  return isHookDecisionAudit(value.audit);
}

function isHookDecisionAudit(value: unknown): value is AgentCommandPolicyDecision["audit"] {
  return (
    isRecord(value) &&
    value.redacted === true &&
    typeof value.role === "string" &&
    typeof value.phase === "string" &&
    typeof value.surface === "string" &&
    typeof value.upstreamContactAttempted === "boolean"
  );
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

export interface HermesLimitMappingDefaults {
  providerId?: string | null;
  model?: string | null;
  harnessId?: string | null;
}

export function providerLimitSignalFromHermesPayload(
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
      harnessId: nonEmptyString(payload.harness_id) ?? nonEmptyString(payload.harnessId) ?? nonEmptyString(defaults.harnessId) ?? "hermes",
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

export function credibleProviderLimitSignalFromHermesPayload(
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

export function providerLimitSignalFromHermesError(error: unknown, defaults: HermesLimitMappingDefaults = {}): ProviderLimitSignal | null {
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
          argsPreview: transcriptToolDetailText(event.payload.args_text),
          redacted: event.payload.redacted === false ? false : true,
          ...(event.payload.unsafe_tool_details === true ? { unsafeToolDetails: true } : {}),
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
          resultPreview: transcriptToolDetailText(event.payload.result_text),
          errorPreview: preview(event.payload.error, 500),
          redacted: event.payload.redacted === false ? false : true,
          ...(event.payload.unsafe_tool_details === true ? { unsafeToolDetails: true } : {}),
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

function transcriptToolDetailText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
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

export function looksLikeProviderLimit(value: string): boolean {
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

async function readHermesSessionKey(
  profileDir: string,
  warn: (message: string, payload?: Record<string, unknown>) => void,
): Promise<string | null> {
  const statePath = path.join(profileDir, HERMES_SESSION_STATE_FILENAME);
  try {
    const parsed = JSON.parse(await fs.readFile(statePath, "utf8")) as unknown;
    if (!isRecord(parsed)) return null;
    return nonEmptyString(parsed.hermesSessionKey) ?? nonEmptyString(parsed.session_key);
  } catch (error) {
    if (!isMissingFileError(error)) {
      warn("hermes reusable session state read failed", { state_path: statePath, error: errorMessage(error) });
    }
    return null;
  }
}

async function writeHermesSessionKey(profileDir: string, hermesSessionKey: string): Promise<void> {
  await fs.mkdir(profileDir, { recursive: true });
  await fs.writeFile(
    path.join(profileDir, HERMES_SESSION_STATE_FILENAME),
    `${JSON.stringify({ hermesSessionKey, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
}

async function removeHermesSessionKey(profileDir: string): Promise<void> {
  await fs.rm(path.join(profileDir, HERMES_SESSION_STATE_FILENAME), { force: true });
}

function isMissingHermesSessionError(error: unknown): boolean {
  const record = errorRecordWithProperties(error);
  const data = isRecord(record.data) ? record.data : {};
  const rpcError = isRecord(record.rpcError) ? record.rpcError : {};
  const code = record.code ?? data.code ?? rpcError.code;
  if (code === 4007 || code === "4007") return true;
  return errorMessage(error).toLowerCase().includes("session not found");
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

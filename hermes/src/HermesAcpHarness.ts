import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentEvent, AgentHarness, AgentRunContext } from "../../src/core/harness/AgentHarness.js";
import type {
  RunActivityActor,
  RunActivityChannel,
  RunActivityEvent,
  RunActivityKind,
} from "../../src/core/runActivity/RunActivityEvent.js";
import {
  symphonyRoleMcpServers,
  writeActiveHandoffMcpContexts,
  writeInitialHandoffMcpContexts,
} from "../../src/core/harness/HandoffMcp.js";
import type { McpSubprocessServerConfig } from "../../src/core/harness/McpSubprocessEnvironment.js";
import { errorMessage, SymphonyError } from "../../src/core/errors.js";
import type { ProviderLimitSignal } from "../../src/core/provider/ProviderLimits.js";
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
import { normalizeHermesAuthProvider } from "./HermesAuthManager.js";
import {
  HostHermesAcpStdioJsonRpcFacade,
  type HostHermesAcpDiagnostic,
  type HostHermesAcpJsonRpcNotification,
  type HostHermesAcpJsonRpcRequest,
  type HostHermesAcpProcessExit,
  type HostHermesAcpRequestOptions,
} from "./HostHermesAcpFacade.js";
import {
  denyHermesAcpPermission,
  parseHermesAcpPermissionRequest,
  resolveHermesAcpPermissionDecision,
  type HermesAcpPermissionDecision,
  type HermesAcpPermissionRequest,
  type HermesAcpPermissionResolution,
} from "./HermesAcpPermissions.js";
import {
  credibleProviderLimitSignalFromHermesPayload,
  looksLikeProviderLimit,
  providerLimitSignalFromHermesError,
  providerLimitSignalFromHermesPayload,
  type HermesLimitMappingDefaults,
} from "./HermesHarness.js";

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

export interface HermesAcpPermissionResolverInput {
  ctx: AgentRunContext;
  runId: string;
  request: HermesAcpPermissionRequest;
  jsonRpcRequest: HostHermesAcpJsonRpcRequest;
  acpSessionId: string | null;
  symphonySessionId: string | null;
}

export type HermesAcpPermissionResolver = (
  input: HermesAcpPermissionResolverInput,
) => HermesAcpPermissionDecision | Promise<HermesAcpPermissionDecision>;

export interface HermesAcpHarnessOptions {
  cliPath?: string;
  discoverHostHermes?: (options: Parameters<typeof discoverHostHermes>[0]) => Promise<HostHermesDiscoveryResult>;
  profileLeaseFactory?: (options: HostHermesAcpProfileLeaseOptions) => Promise<HostHermesAcpProfileLease>;
  acpClientFactory?: (command: HostHermesAcpProcessCommand, options: HermesAcpRuntimeClientOptions) => HermesAcpRuntimeClient;
  permissionResolver?: HermesAcpPermissionResolver;
  permissionRequestTimeoutMs?: number;
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
  cancelPromise: Promise<void> | null;
  cancelled: boolean;
  permissionCancellationWaiters: Set<() => void>;
}

type TerminalStatus = HostHermesAcpTerminalStatus;

type HermesAcpRuntimeEvent =
  | { type: "session.update"; sessionId: string | null; update: Record<string, unknown>; raw: Record<string, unknown> }
  | { type: "diagnostic"; diagnostic: HostHermesAcpDiagnostic }
  | { type: "permission.resolved"; resolution: HermesAcpPermissionResolution };

const TERMINAL_SETUP_AUTH_METHOD_ID = "hermes-setup";
const DEFAULT_PROFILE_PREFIX = "symphony";
const RUN_CANCELLED = Symbol("hermes_acp_run_cancelled");

interface SelectedAuthMethod {
  id: string;
  display: string;
  diagnostics: string;
}

interface AuthMethodSelectionContext {
  expectedProvider: string | null;
  sourceProfile: string | null;
}

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
    const activeRun: ActiveHermesAcpRun = {
      lease,
      acpSessionId: null,
      symphonySessionId: null,
      cancelPromise: null,
      cancelled: false,
      permissionCancellationWaiters: new Set(),
    };
    this.activeRuns.set(runId, activeRun);

    const queue = new AsyncEventQueue<AgentEvent>();
    let terminalStatus: TerminalStatus = null;
    let responseText = "";
    let pendingFinalUsageUpdateTokens: Partial<TokenCounts> | null = null;
    let activitySequence = 0;

    const runActivityContext = (at: string, sequence: number, idScope?: string): HermesAcpRunActivityContext => ({
      runId,
      sequence,
      at,
      runSessionId: activeRun.symphonySessionId ?? runId,
      sessionId: activeRun.acpSessionId,
      harnessId: this.id,
      ...(idScope === undefined ? {} : { idScope }),
    });
    const withRunActivity = (event: AgentEvent, metadata?: HermesAcpRunActivityMetadata): AgentEvent => {
      const at = event.at ?? new Date().toISOString();
      return attachHermesAcpRunActivity({ ...event, at }, runActivityContext(at, ++activitySequence), metadata);
    };
    const enqueue = (event: AgentEvent, metadata?: HermesAcpRunActivityMetadata): void => queue.push(withRunActivity(event, metadata));
    const enqueueRuntimeEvent = (event: HermesAcpRuntimeEvent, mappedEvents?: HermesAcpMappedAgentEvent[]): void => {
      for (const mapped of runtimeAgentEventsForHermesAcpRuntimeEvent(event, mappedEvents)) {
        enqueue(mapped.event, mapped.runActivityMetadata);
      }
    };
    const onSessionUpdate = (params: unknown): void => {
      const event = hermesAcpSessionUpdateEvent(params);
      if (!event || !acceptAcpSessionEvent(event, activeRun.acpSessionId)) return;
      const mappedEvents = mapHermesAcpSessionUpdateWithMetadata(event.update).map((mapped) =>
        withAcpSessionUpdateMetadata(mapped, event.sessionId, event.update),
      );
      responseText += hermesAcpAgentMessageDelta(event.update);
      for (const mapped of mappedEvents) {
        if (mapped.event.type === "tokens" && acpSessionUpdateKind(event.update) === "usage_update") {
          pendingFinalUsageUpdateTokens = mapped.event.tokens;
          continue;
        }
        enqueue(mapped.event, mapped.runActivityMetadata);
      }
    };
    const onPermissionRequest = async (
      params: unknown,
      request: HostHermesAcpJsonRpcRequest,
    ): Promise<Record<string, unknown>> => {
      const parsedRequest = parseHermesAcpPermissionRequest(params);
      const resolution = await this.resolvePermissionRequest(ctx, runId, activeRun, parsedRequest, request);
      enqueueRuntimeEvent({ type: "permission.resolved", resolution });
      return resolution.response;
    };

    const onDiagnostic = (diagnostic: HostHermesAcpDiagnostic): void => {
      const event: HermesAcpRuntimeEvent = { type: "diagnostic", diagnostic };
      enqueueRuntimeEvent(event);
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
        cwd: ctx.workspace.path,
        exit,
        acpLogTail: acpLogTailPayload(lease),
      });
    };
    const abort = (): void => {
      this.markRunCancelling(runId, activeRun);
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
      yield withRunActivity({ type: "session_started", sessionId: activeRun.symphonySessionId, threadId: acpSessionId, runId });
      enqueue(
        { type: "progress", activitySource: "stream", message: `Host Hermes ACP profile ${lease.profile.profileName}` },
        {
          actor: "runtime",
          channel: "diagnostic",
          kind: "runtime_ready",
          text: `Host Hermes runtime profile ${lease.profile.profileName}`,
          payload: {
            profileName: lease.profile.profileName,
            sourceProfile: lease.profile.sourceProfile,
            acpSessionId,
            reusable: lease.reusable,
            redacted: true,
          },
        },
      );

      const promptTask = lease.client
        .request<Record<string, unknown> | null>(
          "session/prompt",
          { sessionId: acpSessionId, prompt: [{ type: "text", text: prompt }] },
          { timeoutMs: ctx.config.hermes.requestTimeoutMs },
        )
        .then((result) => {
          if (terminalStatus !== null) return;
          const events = mapHermesAcpPromptResult(result, {
            cancelled: this.isRunCancelling(ctx, runId, activeRun),
            responseText,
            fallbackUsageTokens: pendingFinalUsageUpdateTokens,
            providerId: ctx.config.hermes.provider,
            model: ctx.config.hermes.model,
            harnessId: this.id,
          });
          terminalStatus = terminalStatusFromEvents(events);
          for (const event of events) enqueue(event);
          queue.close();
        })
        .catch((error: unknown) => {
          const providerLimit = providerLimitSignalFromHermesError(error, {
            providerId: ctx.config.hermes.provider,
            model: ctx.config.hermes.model,
            harnessId: this.id,
          });
          if (providerLimit) enqueue({ type: "provider_limit", signal: providerLimit });
          failRun(`Host Hermes ACP run failed: ${errorMessage(error)}`, {
            runId,
            sessionId: activeRun.symphonySessionId,
            profileName: lease.profile.profileName,
            cwd: ctx.workspace.path,
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
        yield withRunActivity({ type: "cancelled" });
      } else {
        terminalStatus = "failed";
        const providerLimit = providerLimitSignalFromHermesError(error, {
          providerId: ctx.config.hermes.provider,
          model: ctx.config.hermes.model,
          harnessId: this.id,
        });
        if (providerLimit) yield withRunActivity({ type: "provider_limit", signal: providerLimit });
        yield withRunActivity({
          type: "run_diagnostic",
          code: "hermes_acp_run_error",
          message: `Host Hermes ACP run failed: ${errorMessage(error)}`,
          payload: {
            runId,
            sessionId: activeRun.symphonySessionId,
            profileName: lease.profile.profileName,
            cwd: ctx.workspace.path,
            acpLogTail: acpLogTailPayload(lease),
          },
        });
        yield withRunActivity({ type: "failed", error: `Host Hermes ACP run failed: ${errorMessage(error)}` });
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

  private async resolvePermissionRequest(
    ctx: AgentRunContext,
    runId: string,
    activeRun: ActiveHermesAcpRun,
    request: HermesAcpPermissionRequest,
    jsonRpcRequest: HostHermesAcpJsonRpcRequest,
  ): Promise<HermesAcpPermissionResolution> {
    if (request.malformedReason) return denyHermesAcpPermission(request, request.malformedReason);
    if (this.isRunCancelling(ctx, runId, activeRun)) return denyHermesAcpPermission(request, "run_cancelled");

    const resolver = this.options.permissionResolver;
    if (!resolver) return denyHermesAcpPermission(request, "permission_bridge_not_configured");

    try {
      const decision = await this.resolvePermissionDecisionUnlessCancelled(
        ctx,
        runId,
        activeRun,
        withTimeout(
          Promise.resolve(
            resolver({
              ctx,
              runId,
              request,
              jsonRpcRequest,
              acpSessionId: activeRun.acpSessionId,
              symphonySessionId: activeRun.symphonySessionId,
            }),
          ),
          this.options.permissionRequestTimeoutMs ?? ctx.config.hermes.requestTimeoutMs,
          "ACP permission resolver timed out",
        ),
      );
      if (decision === RUN_CANCELLED || this.isRunCancelling(ctx, runId, activeRun)) {
        return denyHermesAcpPermission(request, "run_cancelled");
      }
      return resolveHermesAcpPermissionDecision(request, decision);
    } catch (error) {
      ctx.logger.warn("hermes_acp permission resolver failed closed", {
        run_id: runId,
        issue_id: ctx.issue.id,
        issue_identifier: ctx.issue.identifier,
        error: errorMessage(error),
      });
      return denyHermesAcpPermission(request, "permission_bridge_error");
    }
  }

  async stop(runId: string): Promise<void> {
    const activeRun = this.activeRuns.get(runId);
    if (!activeRun) return;
    this.markRunCancelling(runId, activeRun);
    await this.interruptActiveRun(activeRun, "stop");
  }

  private async resolvePermissionDecisionUnlessCancelled(
    ctx: AgentRunContext,
    runId: string,
    activeRun: ActiveHermesAcpRun,
    decisionPromise: Promise<HermesAcpPermissionDecision>,
  ): Promise<HermesAcpPermissionDecision | typeof RUN_CANCELLED> {
    if (this.isRunCancelling(ctx, runId, activeRun)) return RUN_CANCELLED;

    let notifyCancelled: (() => void) | null = null;
    const cancellationPromise = new Promise<typeof RUN_CANCELLED>((resolve) => {
      notifyCancelled = () => resolve(RUN_CANCELLED);
      activeRun.permissionCancellationWaiters.add(notifyCancelled);
    });
    try {
      return await Promise.race([decisionPromise, cancellationPromise]);
    } finally {
      if (notifyCancelled) activeRun.permissionCancellationWaiters.delete(notifyCancelled);
    }
  }

  private isRunCancelling(ctx: AgentRunContext, runId: string, activeRun: ActiveHermesAcpRun): boolean {
    return ctx.abortSignal.aborted || activeRun.cancelled || this.cancelledRuns.has(runId);
  }

  private markRunCancelling(runId: string, activeRun: ActiveHermesAcpRun): void {
    activeRun.cancelled = true;
    this.cancelledRuns.add(runId);
    for (const notifyCancelled of activeRun.permissionCancellationWaiters) notifyCancelled();
    activeRun.permissionCancellationWaiters.clear();
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
    const method = selectNonTerminalAuthMethod(initializeResult, {
      expectedProvider: ctx.config.hermes.provider,
      sourceProfile: lease.profile.sourceProfile,
    });
    let authenticateResult: unknown;
    try {
      authenticateResult = await lease.client.request<unknown>(
        "authenticate",
        { methodId: method.id },
        { timeoutMs: ctx.config.hermes.startupTimeoutMs },
      );
    } catch (error) {
      throw new SymphonyError(
        "config_validation_error",
        `Host Hermes ACP authenticate failed for auth method ${method.display}: ${redactLogLine(errorMessage(error))}. ${method.diagnostics} Refusing unattended hermes_acp run; configure Hermes provider credentials before using the ACP harness.`,
        error,
      );
    }
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
    if (activeRun.cancelPromise) return activeRun.cancelPromise;
    activeRun.cancelPromise = this.cancelActiveRunOnce(activeRun, reason);
    return activeRun.cancelPromise;
  }

  private async cancelActiveRunOnce(activeRun: ActiveHermesAcpRun, reason: string): Promise<void> {
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

interface HermesAcpRunActivityContext {
  runId: string;
  sequence: number;
  at: string;
  runSessionId: string;
  sessionId: string | null;
  harnessId: string;
  idScope?: string;
}

interface HermesAcpRunActivityMetadata {
  actor: RunActivityActor;
  channel: RunActivityChannel;
  kind: RunActivityKind;
  text: string | null;
  payload: Record<string, unknown>;
}

interface HermesAcpMappedAgentEvent {
  event: AgentEvent;
  runActivityMetadata?: HermesAcpRunActivityMetadata;
}

function attachHermesAcpRunActivity<T extends AgentEvent>(
  event: T,
  context: HermesAcpRunActivityContext,
  runActivityMetadata?: HermesAcpRunActivityMetadata,
): T {
  if (event.runActivity) return event;
  const metadata = runActivityMetadata ?? runActivityMetadataForAgentEvent(event);
  const sessionId = context.sessionId ?? (event.type === "session_started" ? event.threadId ?? event.sessionId : null);
  const activity = {
    eventId: `${context.runId}:${context.idScope ?? "activity"}:${context.sequence}`,
    runSessionId: context.runSessionId,
    occurredAt: context.at,
    sequence: context.sequence,
    sequenceSource: "harness",
    externalEventId: null,
    protocol: "acp",
    harness: context.harnessId,
    actor: metadata.actor,
    channel: metadata.channel,
    kind: metadata.kind,
    text: metadata.text,
    payload: { ...metadata.payload, runtimeSessionId: sessionId },
  } as RunActivityEvent;
  return { ...event, runActivity: activity };
}

function runActivityMetadataForAgentEvent(event: AgentEvent): HermesAcpRunActivityMetadata {
  switch (event.type) {
    case "session_started":
      return {
        actor: "harness",
        channel: "lifecycle",
        kind: "session_started",
        text: "ACP session started",
        payload: { sessionId: event.sessionId, threadId: event.threadId ?? null, runId: event.runId ?? null },
      };
    case "progress":
      return progressRunActivityMetadata(event);
    case "tokens":
      return {
        actor: "runtime",
        channel: "token",
        kind: "token_usage_reported",
        text: "Token usage reported",
        payload: { ...normalizedTokenCounts(event.tokens), usageSource: "stream" },
      };
    case "rate_limits":
      return {
        actor: "provider",
        channel: "rate_limit",
        kind: "rate_limit_retry_scheduled",
        text: "Rate limits updated",
        payload: { rateLimitsPreview: preview(event.payload, 1_000), redacted: true },
      };
    case "provider_limit":
      return {
        actor: "provider",
        channel: "rate_limit",
        kind: "provider_limit_detected",
        text: event.signal.message,
        payload: {
          providerId: event.signal.scope.providerId,
          model: event.signal.scope.model,
          limitKind: event.signal.kind,
          resumePolicy: event.signal.resumePolicy,
          window: event.signal.window,
          observedAt: event.signal.observedAt,
          redacted: true,
        },
      };
    case "run_status":
      return {
        actor: "runtime",
        channel: "diagnostic",
        kind: "sdk_status_update",
        text: `Run status: ${event.sdkStatus}`,
        payload: { runId: event.runId, status: event.sdkStatus, source: event.source },
      };
    case "run_diagnostic":
      return {
        actor: "runtime",
        channel: "diagnostic",
        kind: "runtime_diagnostic",
        text: event.message,
        payload: {
          code: event.code,
          severity: "info",
          ...(event.payload === undefined ? {} : { detailsPreview: preview(event.payload, 1_000), redacted: true }),
        },
      };
    case "completed":
      return {
        actor: "runtime",
        channel: "terminal",
        kind: "run_succeeded",
        text: event.message ?? "Run completed",
        payload: { reason: "run_succeeded" },
      };
    case "failed":
      return {
        actor: "runtime",
        channel: "terminal",
        kind: "run_failed",
        text: event.error,
        payload: { reason: "run_failed", error: preview(event.error, 1_000), redacted: true },
      };
    case "cancelled":
      return {
        actor: "runtime",
        channel: "terminal",
        kind: "run_cancelled",
        text: "Run cancelled",
        payload: { reason: "run_cancelled" },
      };
  }
}

function progressRunActivityMetadata(event: Extract<AgentEvent, { type: "progress" }>): HermesAcpRunActivityMetadata {
  const messagePreview = preview(event.message, 1_000);
  if (event.activitySource === "tool") {
    const status = toolStatusFromProgressMessage(event.message);
    return {
      actor: "tool",
      channel: "tool",
      kind: toolRunActivityKind(status),
      text: event.message,
      payload: {
        status: status ?? "running",
        outputPreview: messagePreview,
        redacted: true,
      },
    };
  }
  if (event.activitySource === "delta") {
    return {
      actor: "assistant",
      channel: "chat",
      kind: "assistant_message_delta",
      text: event.message,
      payload: { delta: true, messagePreview, redacted: true },
    };
  }
  if (/\b(thought|reasoning)\b/i.test(event.message)) {
    return {
      actor: "assistant",
      channel: "chat",
      kind: "assistant_reasoning_delta",
      text: event.message,
      payload: { delta: true, reasoning: true, messagePreview, redacted: true },
    };
  }
  if (/\bplan updated\b/i.test(event.message)) {
    return {
      actor: "runtime",
      channel: "chat",
      kind: "plan_update",
      text: event.message,
      payload: { messagePreview, redacted: true },
    };
  }
  return {
    actor: "runtime",
    channel: "diagnostic",
    kind: "runtime_status_update",
    text: event.message,
    payload: { status: "progress", activitySource: event.activitySource ?? "stream", messagePreview, redacted: true },
  };
}

function toolStatusFromProgressMessage(message: string): string | null {
  const lower = message.toLowerCase();
  if (/\b(failed|error)\b/.test(lower)) return "failed";
  if (/\b(completed|succeeded|success)\b/.test(lower)) return "succeeded";
  if (/\b(started|running|pending)\b/.test(lower)) return "running";
  if (/\b(cancelled|canceled)\b/.test(lower)) return "cancelled";
  return null;
}

function toolRunActivityKind(status: string | null): RunActivityKind {
  switch (status) {
    case "failed":
      return "tool_call_failed";
    case "succeeded":
      return "tool_call_completed";
    case "cancelled":
      return "tool_call_progress";
    case "running":
      return "tool_call_started";
    default:
      return "tool_call_progress";
  }
}

function normalizedTokenCounts(tokens: Partial<TokenCounts>): Partial<TokenCounts> {
  const inputTokens = finiteNumber(tokens.inputTokens);
  const outputTokens = finiteNumber(tokens.outputTokens);
  const totalTokens = finiteNumber(tokens.totalTokens);
  return {
    ...(inputTokens === null ? {} : { inputTokens }),
    ...(outputTokens === null ? {} : { outputTokens }),
    ...(totalTokens === null ? {} : { totalTokens }),
  };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function mcpServersToAcpStdioServers(servers: Record<string, McpSubprocessServerConfig>): AcpMcpServerStdio[] {
  return Object.entries(servers).map(([name, server]) => {
    const config = requireStdioMcpServerConfig(name, server);
    return {
      name: requireNonEmptyMcpString(name, `MCP server name for ${name || "<empty>"}`),
      command: config.command,
      args: [...config.args],
      env: Object.entries(config.env).map(([envName, value]) => ({
        name: requireNonEmptyMcpString(envName, `MCP server ${name} env variable name`),
        value,
      })),
    };
  });
}

function requireStdioMcpServerConfig(name: string, server: unknown): McpSubprocessServerConfig {
  const label = `MCP server ${name || "<empty>"}`;
  if (!isRecord(server)) {
    throw new SymphonyError("config_validation_error", `${label} config must be an object.`);
  }
  const type = nonEmptyString(server.type);
  if (type !== "stdio") {
    throw new SymphonyError(
      "config_validation_error",
      `${label} uses unsupported MCP server type ${type ?? "<missing>"}; Symphony role MCP handoff currently supports stdio servers only.`,
    );
  }
  return {
    type: "stdio",
    command: requireNonEmptyMcpString(server.command, `${label} command`),
    args: requireStringArray(server.args, `${label} args`),
    cwd: requireNonEmptyMcpString(server.cwd, `${label} cwd`),
    env: requireStringRecord(server.env, `${label} env`),
  };
}

function requireNonEmptyMcpString(value: unknown, label: string): string {
  const normalized = nonEmptyString(value);
  if (normalized === null) {
    throw new SymphonyError("config_validation_error", `${label} must be a non-empty string.`);
  }
  return normalized;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new SymphonyError("config_validation_error", `${label} must be an array of strings.`);
  }
  return [...value];
}

function requireStringRecord(value: unknown, label: string): Record<string, string> {
  if (!isRecord(value)) {
    throw new SymphonyError("config_validation_error", `${label} must be an object with string values.`);
  }
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      throw new SymphonyError("config_validation_error", `${label}.${key} must be a string.`);
    }
    output[key] = item;
  }
  return output;
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

function selectNonTerminalAuthMethod(
  initializeResult: Record<string, unknown>,
  context: AuthMethodSelectionContext,
): SelectedAuthMethod {
  const authMethods = authMethodsFromInitializeResult(initializeResult);
  const diagnostics = advertisedAuthMethodsDiagnostic(authMethods, context);
  const nonTerminalMethods = authMethods.filter((method) => authMethodId(method) !== null && !isTerminalAuthMethod(method));
  const expectedProviders = expectedAuthProviderKeys(context);

  if (nonTerminalMethods.length === 0) {
    throw new SymphonyError(
      "config_validation_error",
      `Host Hermes ACP initialize did not advertise a non-terminal provider auth method. ${diagnostics} Refusing unattended hermes_acp run; configure Hermes provider credentials before using the ACP harness.`,
    );
  }

  if (expectedProviders.length > 0) {
    const matchingMethods = nonTerminalMethods.filter((method) => authMethodMatchesExpectedProvider(method, expectedProviders));
    if (matchingMethods.length === 1) return selectedAuthMethod(matchingMethods[0]!, diagnostics);
    if (matchingMethods.length > 1) {
      throw new SymphonyError(
        "config_validation_error",
        `Host Hermes ACP initialize advertised multiple non-terminal auth methods matching expected provider(s) ${expectedProviders.join(", ")}. ${diagnostics} Refusing unattended hermes_acp run until the provider auth method is unambiguous.`,
      );
    }
  }

  if (nonTerminalMethods.length === 1) return selectedAuthMethod(nonTerminalMethods[0]!, diagnostics);

  const expected = expectedProviders.length > 0 ? ` for expected provider(s) ${expectedProviders.join(", ")}` : "";
  throw new SymphonyError(
    "config_validation_error",
    `Host Hermes ACP initialize advertised multiple non-terminal provider auth methods but none matched unambiguously${expected}. ${diagnostics} Refusing unattended hermes_acp run until the provider auth method is explicit.`,
  );
}

function selectedAuthMethod(
  method: Record<string, unknown>,
  diagnostics: string,
): SelectedAuthMethod {
  const id = authMethodId(method);
  if (!id) {
    throw new SymphonyError("agent_error", `Host Hermes ACP selected auth method did not include an id. ${diagnostics}`);
  }
  return { id, display: selectedAuthMethodDisplay(method, id), diagnostics };
}

function selectedAuthMethodDisplay(method: Record<string, unknown>, id: string): string {
  const displayLabel = sanitizedAuthMethodField(authMethodLabel(method) ?? id) ?? "[redacted]";
  const displayId = sanitizedAuthMethodField(id) ?? "[redacted]";
  return `${displayLabel} (${displayId})`;
}

function validateAcpAuthenticateResult(result: unknown, method: SelectedAuthMethod): void {
  if (result === null || result === undefined || result === false) {
    throw new SymphonyError(
      "config_validation_error",
      `Host Hermes ACP authenticate rejected auth method ${method.display}. ${method.diagnostics} Refusing unattended hermes_acp run; configure Hermes provider credentials before using the ACP harness.`,
    );
  }
  if (!isRecord(result)) {
    throw new SymphonyError(
      "agent_error",
      `Host Hermes ACP authenticate returned an invalid response for auth method ${method.display}. ${method.diagnostics}`,
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

function expectedAuthProviderKeys(context: AuthMethodSelectionContext): string[] {
  const configuredProvider = normalizedAuthProviderKey(context.expectedProvider);
  if (configuredProvider.length > 0) return [configuredProvider];
  return uniqueNonEmptyStrings([context.sourceProfile].map(normalizedAuthProviderKey));
}

function authMethodMatchesExpectedProvider(method: Record<string, unknown>, expectedProviders: string[]): boolean {
  return authMethodProviderKeys(method).some((provider) => expectedProviders.includes(provider));
}

function authMethodProviderKeys(method: Record<string, unknown>): string[] {
  return uniqueNonEmptyStrings(
    [
      method.provider,
      method.providerId,
      method.provider_id,
      method.providerName,
      method.provider_name,
      authMethodId(method),
    ].map(normalizedAuthProviderKey),
  );
}

function normalizedAuthProviderKey(value: unknown): string {
  const provider = nonEmptyString(value);
  return provider ? normalizeHermesAuthProvider(provider) : "";
}

function uniqueNonEmptyStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function advertisedAuthMethodsDiagnostic(authMethods: Record<string, unknown>[], context: AuthMethodSelectionContext): string {
  const expectedProviders = expectedAuthProviderKeys(context);
  const expected = expectedProviders.length > 0 ? ` expectedProviders=${JSON.stringify(expectedProviders)};` : "";
  return `advertised authMethods=${JSON.stringify(authMethods.map(sanitizedAuthMethodForDiagnostics))};${expected}`;
}

function sanitizedAuthMethodForDiagnostics(method: Record<string, unknown>): Record<string, unknown> {
  return {
    id: sanitizedAuthMethodField(authMethodId(method)),
    type: sanitizedAuthMethodField(authMethodType(method)),
    label: sanitizedAuthMethodField(authMethodLabel(method)),
    provider: sanitizedAuthMethodField(authMethodProviderForDiagnostics(method)),
    terminal: isTerminalAuthMethod(method),
  };
}

function sanitizedAuthMethodField(value: string | null): string | null {
  if (!value) return null;
  const sanitized = preview(value, 160);
  return sanitized.length > 0 ? sanitized : null;
}

function authMethodProviderForDiagnostics(method: Record<string, unknown>): string | null {
  const explicitProvider =
    nonEmptyString(method.provider) ??
    nonEmptyString(method.providerId) ??
    nonEmptyString(method.provider_id) ??
    nonEmptyString(method.providerName) ??
    nonEmptyString(method.provider_name);
  if (explicitProvider) return normalizeHermesAuthProvider(explicitProvider);
  if (isTerminalAuthMethod(method)) return null;
  const id = authMethodId(method);
  return id ? normalizeHermesAuthProvider(id) : null;
}

function authMethodId(method: Record<string, unknown>): string | null {
  return nonEmptyString(method.id) ?? nonEmptyString(method.methodId) ?? nonEmptyString(method.method_id);
}

function authMethodType(method: Record<string, unknown>): string | null {
  return nonEmptyString(method.type) ?? nonEmptyString(method.kind);
}

function authMethodLabel(method: Record<string, unknown>): string | null {
  return nonEmptyString(method.label) ?? nonEmptyString(method.name) ?? nonEmptyString(method.title) ?? nonEmptyString(method.description);
}

function isTerminalAuthMethod(method: Record<string, unknown>): boolean {
  const id = authMethodId(method);
  const type = authMethodType(method)?.toLowerCase() ?? "";
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
  if (!activeSessionId) return false;
  return event.sessionId === null || event.sessionId === activeSessionId;
}

export function mapHermesAcpSessionUpdate(update: Record<string, unknown>): AgentEvent[] {
  return mapHermesAcpSessionUpdateWithMetadata(update).map((mapped) => mapped.event);
}

function mapHermesAcpSessionUpdateWithMetadata(update: Record<string, unknown>): HermesAcpMappedAgentEvent[] {
  const kind = acpSessionUpdateKind(update);
  switch (kind) {
    case "agent_message_chunk": {
      const text = acpAgentMessageText(update);
      return text.length > 0
        ? [
            mappedAgentEvent(
              { type: "progress", activitySource: "delta", message: text },
              {
                actor: "assistant",
                channel: "chat",
                kind: "assistant_message_delta",
                text,
                payload: {
                  delta: true,
                  messagePreview: preview(text, 1_000),
                  ...acpSessionUpdatePreviewPayload(update),
                },
              },
            ),
          ]
        : [];
    }
    case "agent_thought_chunk": {
      const message = "Hermes ACP thought update";
      return [
        mappedAgentEvent(
          { type: "progress", activitySource: "stream", message },
          {
            actor: "assistant",
            channel: "chat",
            kind: "assistant_reasoning_delta",
            text: message,
            payload: {
              delta: true,
              reasoning: true,
              messagePreview: preview(textFromContent(update.content) ?? update.text ?? message, 1_000),
              ...acpSessionUpdatePreviewPayload(update),
            },
          },
        ),
      ];
    }
    case "user_message_chunk":
      return [];
    case "usage_update": {
      const finalTokens = finalUsageUpdateTokens(update);
      if (finalTokens) {
        const tokens = normalizedTokenCounts(finalTokens);
        return [
          mappedAgentEvent(
            { type: "tokens", tokens },
            {
              actor: "runtime",
              channel: "token",
              kind: "token_usage_reported",
              text: "Token usage reported",
              payload: { ...tokens, usageSource: "stream", ...acpSessionUpdatePreviewPayload(update) },
            },
          ),
        ];
      }
      const message = formatUsageUpdate(update);
      return [
        mappedAgentEvent(
          { type: "progress", activitySource: "stream", message },
          {
            actor: "runtime",
            channel: "diagnostic",
            kind: "runtime_status_update",
            text: message,
            payload: { status: "usage_update", usagePreview: preview(update.usage ?? update, 1_000), ...acpSessionUpdatePreviewPayload(update) },
          },
        ),
      ];
    }
    case "tool_call": {
      const message = `Hermes ACP tool started: ${formatToolUpdate(update, "started")}`;
      return [mappedAgentEvent({ type: "progress", activitySource: "tool", message }, toolRunActivityMetadata(update, message, "running"))];
    }
    case "tool_call_update": {
      const message = `Hermes ACP tool ${formatToolStatus(update)}: ${formatToolUpdate(update)}`;
      return [mappedAgentEvent({ type: "progress", activitySource: "tool", message }, toolRunActivityMetadata(update, message, null))];
    }
    case "plan": {
      const message = formatPlanUpdate(update);
      return [
        mappedAgentEvent(
          { type: "progress", activitySource: "stream", message },
          {
            actor: "runtime",
            channel: "chat",
            kind: "plan_update",
            text: message,
            payload: { entriesPreview: preview(update.entries ?? update, 1_000), ...acpSessionUpdatePreviewPayload(update) },
          },
        ),
      ];
    }
    case "current_mode_update": {
      const message = formatCurrentModeUpdate(update);
      return [
        mappedAgentEvent(
          { type: "progress", activitySource: "stream", message },
          {
            actor: "runtime",
            channel: "diagnostic",
            kind: "mode_update",
            text: message,
            payload: {
              status: "mode_update",
              mode: nonEmptyString(update.currentMode) ?? nonEmptyString(update.current_mode) ?? nonEmptyString(update.modeId) ?? nonEmptyString(update.mode_id),
              ...acpSessionUpdatePreviewPayload(update),
            },
          },
        ),
      ];
    }
    case "session_info_update": {
      const message = formatSessionInfoUpdate(update);
      return [
        mappedAgentEvent(
          { type: "progress", activitySource: "stream", message },
          {
            actor: "runtime",
            channel: "diagnostic",
            kind: "runtime_status_update",
            text: message,
            payload: { status: "session_info_update", title: nonEmptyString(update.title), ...acpSessionUpdatePreviewPayload(update) },
          },
        ),
      ];
    }
    case "available_commands_update": {
      const message = formatAvailableCommandsUpdate(update);
      return [
        mappedAgentEvent(
          { type: "progress", activitySource: "stream", message },
          {
            actor: "runtime",
            channel: "diagnostic",
            kind: "available_commands_update",
            text: message,
            payload: { commands: availableCommandNames(update), ...acpSessionUpdatePreviewPayload(update) },
          },
        ),
      ];
    }
    default: {
      const message = `Host Hermes ACP emitted unmapped session update ${kind}.`;
      return [
        mappedAgentEvent(
          {
            type: "run_diagnostic",
            code: "hermes_acp_session_update_unmapped",
            message,
            payload: { updateKind: kind, updatePreview: preview(update, 500), redacted: true },
          },
          {
            actor: "runtime",
            channel: "diagnostic",
            kind: "runtime_diagnostic",
            text: message,
            payload: {
              code: "hermes_acp_session_update_unmapped",
              severity: "info",
              ...acpSessionUpdatePreviewPayload(update),
            },
          },
        ),
      ];
    }
  }
}

function mappedAgentEvent(event: AgentEvent, runActivityMetadata: HermesAcpRunActivityMetadata): HermesAcpMappedAgentEvent {
  return { event, runActivityMetadata };
}

function acpSessionUpdatePreviewPayload(update: Record<string, unknown>): Record<string, unknown> {
  return { updateKind: acpSessionUpdateKind(update), updatePreview: preview(update, 1_000), redacted: true };
}

function withAcpSessionUpdateMetadata(
  mapped: HermesAcpMappedAgentEvent,
  sessionId: string | null,
  update: Record<string, unknown>,
): HermesAcpMappedAgentEvent {
  const metadata = mapped.runActivityMetadata ?? runActivityMetadataForAgentEvent(mapped.event);
  return {
    event: mapped.event,
    runActivityMetadata: {
      ...metadata,
      payload: {
        ...metadata.payload,
        acpSessionId: sessionId,
        updateKind: acpSessionUpdateKind(update),
        updatePreview: preview(update, 1_000),
        redacted: true,
      },
    },
  };
}

function hermesAcpAgentMessageDelta(update: Record<string, unknown>): string {
  if (acpSessionUpdateKind(update) !== "agent_message_chunk") return "";
  return acpAgentMessageText(update);
}

function acpSessionUpdateKind(update: Record<string, unknown>): string {
  const raw = nonEmptyString(update.sessionUpdate) ?? nonEmptyString(update.session_update) ?? "session_update";
  return toSnakeCase(raw);
}

function acpAgentMessageText(update: Record<string, unknown>): string {
  return textFromContent(update.content) ?? contentString(update.text) ?? "";
}

function textFromContent(content: unknown, depth = 0): string | null {
  if (depth > 6) return null;
  if (typeof content === "string") return content.length > 0 ? content : null;
  if (Array.isArray(content)) {
    const parts = content.map((part) => textFromContent(part, depth + 1) ?? "").filter((part) => part.length > 0);
    return parts.length > 0 ? parts.join("") : null;
  }
  if (!isRecord(content)) return null;
  const directText = contentString(content.text) ?? contentString(content.content);
  if (directText !== null && directText.length > 0) return directText;
  if (content.content !== undefined) {
    const nested = textFromContent(content.content, depth + 1);
    if (nested !== null && nested.length > 0) return nested;
  }
  if (content.resource !== undefined) {
    const resource = textFromContent(content.resource, depth + 1);
    if (resource !== null && resource.length > 0) return resource;
  }
  const path = nonEmptyString(content.path);
  if (path) return path;
  const uri = nonEmptyString(content.uri);
  if (uri) return uri;
  return null;
}

function finalUsageUpdateTokens(update: Record<string, unknown>): Partial<TokenCounts> | null {
  if (!isFinalUsageUpdate(update)) return null;
  return usageTokens(update.usage ?? { input: update.input ?? update.inputTokens ?? update.input_tokens, output: update.output ?? update.outputTokens ?? update.output_tokens, total: update.total ?? update.totalTokens ?? update.total_tokens });
}

function isFinalUsageUpdate(update: Record<string, unknown>): boolean {
  if (update.final === true || update.isFinal === true || update.is_final === true) return true;
  const marker = toSnakeCase(
    nonEmptyString(update.kind) ?? nonEmptyString(update.type) ?? nonEmptyString(update.status) ?? nonEmptyString(update.phase) ?? "",
  );
  return marker === "final" || marker === "final_usage" || marker === "prompt_usage" || marker === "usage_final";
}

function formatUsageUpdate(update: Record<string, unknown>): string {
  const usage = isRecord(update.usage) ? update.usage : {};
  const used = numberFromUnknown(update.used) ?? numberFromUnknown(usage.used);
  const size = numberFromUnknown(update.size) ?? numberFromUnknown(update.limit) ?? numberFromUnknown(usage.size) ?? numberFromUnknown(usage.limit);
  const total = numberFromUnknown(update.total) ?? numberFromUnknown(update.totalTokens) ?? numberFromUnknown(update.total_tokens) ?? numberFromUnknown(usage.total) ?? numberFromUnknown(usage.totalTokens) ?? numberFromUnknown(usage.total_tokens);
  if (used !== null && size !== null) return `Hermes ACP usage update: ${used}/${size} context tokens`;
  if (used !== null) return `Hermes ACP usage update: ${used} context tokens used`;
  if (total !== null) return `Hermes ACP usage update: ${total} tokens reported`;
  return "Hermes ACP usage update";
}

function formatToolUpdate(update: Record<string, unknown>, defaultStatus?: string): string {
  const toolCall = isRecord(update.toolCall) ? update.toolCall : isRecord(update.tool_call) ? update.tool_call : update;
  const title =
    nonEmptyString(toolCall.title) ??
    nonEmptyString(update.title) ??
    nonEmptyString(toolCall.name) ??
    nonEmptyString(update.name) ??
    nonEmptyString(toolCall.tool) ??
    nonEmptyString(update.tool) ??
    nonEmptyString(toolCall.kind) ??
    nonEmptyString(update.kind) ??
    "tool update";
  const status = nonEmptyString(update.status) ?? nonEmptyString(toolCall.status) ?? defaultStatus;
  return status ? `${title} (${status})` : title;
}

function formatToolStatus(update: Record<string, unknown>): string {
  const toolCall = isRecord(update.toolCall) ? update.toolCall : isRecord(update.tool_call) ? update.tool_call : update;
  return nonEmptyString(update.status) ?? nonEmptyString(toolCall.status) ?? "updated";
}

function toolRunActivityMetadata(
  update: Record<string, unknown>,
  message: string,
  fallbackStatus: "running" | null,
): HermesAcpRunActivityMetadata {
  const tool = toolDetailsFromUpdate(update);
  const status = normalizedToolStatus(tool.status, fallbackStatus);
  const payload: Record<string, unknown> = {
    status,
    ...acpSessionUpdatePreviewPayload(update),
  };
  if (tool.callId) payload.toolCallId = tool.callId;
  if (tool.name) payload.toolName = tool.name;
  if (tool.title && tool.title !== tool.name) payload.toolTitle = tool.title;
  if (tool.inputPreview) payload.inputPreview = tool.inputPreview;
  if (tool.argsPreview) payload.argsPreview = tool.argsPreview;
  if (tool.resultPreview) payload.resultPreview = tool.resultPreview;
  if (tool.outputPreview) payload.outputPreview = tool.outputPreview;
  if (tool.errorPreview) payload.errorPreview = tool.errorPreview;
  return {
    actor: "tool",
    channel: "tool",
    kind: toolRunActivityKind(status),
    text: message,
    payload,
  };
}

interface HermesAcpToolDetails {
  callId: string | null;
  name: string | null;
  title: string | null;
  status: string | null;
  inputPreview: string | null;
  argsPreview: string | null;
  resultPreview: string | null;
  outputPreview: string | null;
  errorPreview: string | null;
}

function toolDetailsFromUpdate(update: Record<string, unknown>): HermesAcpToolDetails {
  const toolCall = isRecord(update.toolCall) ? update.toolCall : isRecord(update.tool_call) ? update.tool_call : {};
  const callId = firstScalarString(
    update.toolCallId,
    update.tool_call_id,
    update.callId,
    update.call_id,
    update.id,
    update.toolId,
    update.tool_id,
    toolCall.toolCallId,
    toolCall.tool_call_id,
    toolCall.callId,
    toolCall.call_id,
    toolCall.id,
    toolCall.toolId,
    toolCall.tool_id,
  );
  const title = firstScalarString(toolCall.title, update.title);
  const name = firstScalarString(
    toolCall.toolName,
    toolCall.tool_name,
    update.toolName,
    update.tool_name,
    toolCall.name,
    update.name,
    toolCall.tool,
    update.tool,
    title,
  );
  const status = firstScalarString(update.status, toolCall.status, update.state, toolCall.state, update.phase, toolCall.phase);
  return {
    callId,
    name,
    title,
    status,
    inputPreview: previewIfPresent(firstPresent(toolCall.input, update.input, toolCall.parameters, update.parameters), 1_000),
    argsPreview: previewIfPresent(firstPresent(toolCall.args, update.args, toolCall.arguments, update.arguments), 1_000),
    resultPreview: previewIfPresent(firstPresent(toolCall.result, update.result, toolCall.summary, update.summary), 1_000),
    outputPreview: previewIfPresent(firstPresent(toolCall.output, update.output, toolCall.content, update.content, toolCall.message, update.message), 1_000),
    errorPreview: previewIfPresent(firstPresent(toolCall.error, update.error, toolCall.errorMessage, update.errorMessage, toolCall.error_message, update.error_message), 1_000),
  };
}

function normalizedToolStatus(status: string | null, fallbackStatus: "running" | null): string {
  const normalized = toSnakeCase(status ?? fallbackStatus ?? "running");
  switch (normalized) {
    case "pending":
    case "started":
    case "start":
    case "running":
    case "in_progress":
      return "running";
    case "completed":
    case "complete":
    case "succeeded":
    case "success":
    case "done":
      return "succeeded";
    case "failed":
    case "failure":
    case "error":
    case "errored":
      return "failed";
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      return normalized || "running";
  }
}

function firstScalarString(...values: unknown[]): string | null {
  for (const value of values) {
    const text = nonEmptyString(value);
    if (text) return text;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function firstPresent(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function previewIfPresent(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  const output = preview(value, maxLength);
  return output.length > 0 ? output : null;
}

function availableCommandNames(update: Record<string, unknown>): string[] {
  const rawCommands = Array.isArray(update.availableCommands)
    ? update.availableCommands
    : Array.isArray(update.available_commands)
      ? update.available_commands
      : [];
  return rawCommands
    .filter(isRecord)
    .map((command) => nonEmptyString(command.name) ?? nonEmptyString(command.title))
    .filter((command): command is string => command !== null)
    .slice(0, 8);
}

function formatPlanUpdate(update: Record<string, unknown>): string {
  const entries = Array.isArray(update.entries) ? update.entries.filter(isRecord) : [];
  if (entries.length === 0) return "Hermes ACP plan updated";
  const counts = new Map<string, number>();
  const active: string[] = [];
  for (const entry of entries) {
    const status = toSnakeCase(nonEmptyString(entry.status) ?? "pending");
    counts.set(status, (counts.get(status) ?? 0) + 1);
    if (status === "in_progress") {
      const content = nonEmptyString(entry.content) ?? nonEmptyString(entry.title);
      if (content) active.push(content);
    }
  }
  const summary = [...counts.entries()].map(([status, count]) => `${count} ${status}`).join(", ");
  const activeText = active.length > 0 ? `; active: ${active.slice(0, 3).join("; ")}` : "";
  return `Hermes ACP plan updated: ${summary}${activeText}`;
}

function formatCurrentModeUpdate(update: Record<string, unknown>): string {
  const mode = nonEmptyString(update.currentMode) ?? nonEmptyString(update.current_mode) ?? nonEmptyString(update.modeId) ?? nonEmptyString(update.mode_id);
  return mode ? `Hermes ACP mode: ${mode}` : `Hermes ACP mode: ${preview(update, 240)}`;
}

function formatSessionInfoUpdate(update: Record<string, unknown>): string {
  const title = nonEmptyString(update.title);
  return title ? `Hermes ACP session: ${title}` : "Hermes ACP session info updated";
}

function formatAvailableCommandsUpdate(update: Record<string, unknown>): string {
  const rawCommands = Array.isArray(update.availableCommands)
    ? update.availableCommands
    : Array.isArray(update.available_commands)
      ? update.available_commands
      : [];
  const commands = rawCommands
    .filter(isRecord)
    .map((command) => nonEmptyString(command.name) ?? nonEmptyString(command.title))
    .filter((command): command is string => command !== null)
    .slice(0, 8);
  return commands.length > 0 ? `Hermes ACP commands available: ${commands.join(", ")}` : "Hermes ACP commands available";
}

function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function mapHermesAcpPromptResult(
  result: Record<string, unknown> | null,
  input: { cancelled: boolean; responseText: string; fallbackUsageTokens?: Partial<TokenCounts> | null } & HermesLimitMappingDefaults,
): AgentEvent[] {
  const stopReason = nonEmptyString(result?.stopReason) ?? nonEmptyString(result?.stop_reason) ?? null;
  const usage = usageTokens(result?.usage) ?? input.fallbackUsageTokens ?? null;
  const events: AgentEvent[] = usage ? [{ type: "tokens", tokens: usage }] : [];
  const providerLimit = providerLimitSignalFromHermesAcpPromptResult(result, input);
  if (providerLimit) {
    events.push({ type: "provider_limit", signal: providerLimit });
    events.push({
      type: "run_diagnostic",
      code: "hermes_acp_provider_limit",
      message: providerLimit.message,
      payload: { stopReason, resultPreview: preview(result, 500), redacted: true },
    });
    events.push({ type: "failed", error: providerLimit.message });
    return events;
  }
  if (input.cancelled || stopReason === "cancelled") {
    events.push({ type: "cancelled" });
    return events;
  }
  if (stopReason === "refusal") {
    events.push({
      type: "run_diagnostic",
      code: "hermes_acp_refusal",
      message: "Host Hermes ACP refused the prompt.",
      payload: promptResultPayload(result, stopReason, input.responseText, "failed"),
    });
    events.push({ type: "failed", error: "Host Hermes ACP refused the prompt." });
    return events;
  }
  if (stopReason === null || stopReason === "end_turn" || stopReason === "stop" || stopReason === "max_turn_requests") {
    const completed: AgentEvent = {
      type: "completed",
      ...(input.responseText.trim().length > 0 ? { message: input.responseText } : {}),
      payload: promptResultPayload(result, stopReason, input.responseText, "succeeded"),
    };
    events.push(completed);
    return events;
  }
  events.push({
    type: "run_diagnostic",
    code: "hermes_acp_unexpected_stop_reason",
    message: `Host Hermes ACP stopped with unsupported stop reason ${stopReason}.`,
    payload: promptResultPayload(result, stopReason, input.responseText, "failed"),
  });
  events.push({ type: "failed", error: `Host Hermes ACP stopped with unsupported stop reason ${stopReason}.` });
  return events;
}

function promptResultPayload(
  result: Record<string, unknown> | null,
  stopReason: string | null,
  responseText: string,
  terminalStatus: Exclude<TerminalStatus, null>,
): Record<string, unknown> {
  return {
    acpResponse: {
      stopReason,
      terminalStatus,
      usage: usageTokens(result?.usage),
      responseTextPreview: preview(responseText, 1_000),
      resultPreview: preview(result, 1_000),
      redacted: true,
    },
  };
}

function providerLimitSignalFromHermesAcpPromptResult(
  result: Record<string, unknown> | null,
  defaults: HermesLimitMappingDefaults,
): ProviderLimitSignal | null {
  if (!isRecord(result)) return null;
  const directPayload =
    credibleProviderLimitSignalFromHermesPayload(result.provider_limit, defaults) ??
    credibleProviderLimitSignalFromHermesPayload(result.providerLimit, defaults);
  if (directPayload) return directPayload;

  const error = isRecord(result.error) ? result.error : {};
  const errorPayload =
    credibleProviderLimitSignalFromHermesPayload(error.provider_limit, defaults) ??
    credibleProviderLimitSignalFromHermesPayload(error.providerLimit, defaults) ??
    credibleProviderLimitSignalFromHermesPayload(error, defaults);
  if (errorPayload && looksLikeProviderLimit(`${errorPayload.kind} ${errorPayload.message}`)) return errorPayload;

  const status = nonEmptyString(result.status) ?? nonEmptyString(result.stopReason) ?? nonEmptyString(result.stop_reason);
  const code =
    nonEmptyString(result.code) ??
    nonEmptyString(result.reason) ??
    nonEmptyString(result.type) ??
    nonEmptyString(error.code) ??
    nonEmptyString(error.reason) ??
    nonEmptyString(error.type);
  const message =
    nonEmptyString(result.message) ??
    nonEmptyString(result.errorMessage) ??
    nonEmptyString(result.error_message) ??
    nonEmptyString(result.text) ??
    nonEmptyString(error.message) ??
    nonEmptyString(error.errorMessage) ??
    nonEmptyString(error.error_message);
  const errorStatus = toSnakeCase(status ?? "") === "error" || toSnakeCase(status ?? "") === "provider_limit";
  const candidateText = `${code ?? ""} ${status ?? ""} ${message ?? ""}`;
  if (!errorStatus || !looksLikeProviderLimit(candidateText)) return null;
  return providerLimitSignalFromHermesPayload(
    {
      provider_id: defaults.providerId,
      model: defaults.model,
      harness_id: defaults.harnessId,
      kind: code ?? status,
      message: message ?? "Provider limit reached",
      reset_at: result.reset_at ?? result.resets_at ?? result.retry_until ?? error.reset_at ?? error.resets_at ?? error.retry_until,
      retry_after_ms: result.retry_after_ms ?? error.retry_after_ms,
      retry_after: result.retry_after ?? error.retry_after,
      raw: result,
    },
    defaults,
  );
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

function runtimeAgentEventsForHermesAcpRuntimeEvent(
  event: HermesAcpRuntimeEvent,
  mappedEvents?: HermesAcpMappedAgentEvent[],
): HermesAcpMappedAgentEvent[] {
  switch (event.type) {
    case "session.update":
      return mappedEvents ?? mapHermesAcpSessionUpdateWithMetadata(event.update).map((mapped) => withAcpSessionUpdateMetadata(mapped, event.sessionId, event.update));
    case "permission.resolved": {
      const resolution = event.resolution;
      const selected = resolution.outcome === "selected";
      const message = selected
        ? `Host Hermes ACP permission ${resolution.selectedOptionId ?? "selected"} for ${resolution.request.requestKind}`
        : `Host Hermes ACP permission request denied: ${resolution.reason}`;
      const payload = {
        requestKind: resolution.request.requestKind,
        toolCallId: resolution.request.toolCallId,
        selectedOptionId: resolution.selectedOptionId,
        reason: resolution.reason,
        acpSessionId: resolution.request.sessionId,
        paramsPreview: preview(resolution.request.params, 500),
        redacted: true,
      };
      return [
        mappedAgentEvent(
          selected
            ? { type: "progress", activitySource: "tool", message }
            : {
                type: "run_diagnostic",
                code: "hermes_acp_permission_denied",
                message,
                payload: {
                  sessionId: resolution.request.sessionId,
                  requestKind: resolution.request.requestKind,
                  toolCallId: resolution.request.toolCallId,
                  reason: resolution.reason,
                  paramsPreview: preview(resolution.request.params, 500),
                  redacted: true,
                },
              },
          selected
            ? {
                actor: "runtime",
                channel: "diagnostic",
                kind: "runtime_status_update",
                text: message,
                payload: { ...payload, status: "permission_selected" },
              }
            : {
                actor: "runtime",
                channel: "diagnostic",
                kind: "runtime_diagnostic",
                text: message,
                payload: { ...payload, code: "hermes_acp_permission_denied", severity: "warning" },
              },
        ),
      ];
    }
    case "diagnostic":
      return [
        mappedAgentEvent(
          {
            type: "run_diagnostic",
            code: event.diagnostic.code,
            message: event.diagnostic.message,
            ...(event.diagnostic.details === undefined ? {} : { payload: event.diagnostic.details }),
          },
          {
            actor: "runtime",
            channel: "diagnostic",
            kind: "runtime_diagnostic",
            text: event.diagnostic.message,
            payload: {
              code: event.diagnostic.code,
              severity: "info",
              detailsPreview: preview(event.diagnostic.details, 500),
              redacted: true,
            },
          },
        ),
      ];
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
  const base = exit.signal ? `signal ${exit.signal}` : exit.code === null ? "exit code unknown" : `exit code ${exit.code}`;
  return exit.error ? `${base}; process error: ${exit.error}` : base;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${message} after ${timeoutMs}ms.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function preview(value: unknown, maxLength: number): string {
  return sanitizedPreviewValue(value, maxLength).preview ?? "";
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function contentString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberFromUnknown(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentEvent, AgentHarness, AgentRunContext } from "../../src/core/harness/AgentHarness.js";
import type { RunActivityEvent } from "../../src/core/runActivity/RunActivityEvent.js";
import {
  symphonyRoleMcpServers,
  writeActiveHandoffMcpContexts,
  writeInitialHandoffMcpContexts,
} from "../../src/core/harness/HandoffMcp.js";
import type { McpSubprocessServerConfig } from "../../src/core/harness/McpSubprocessEnvironment.js";
import { errorMessage, SymphonyError } from "../../src/core/errors.js";
import type { RunTranscriptStore } from "../../src/core/persistence/RunTranscriptStore.js";

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
  runStore?: RunTranscriptStore;
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
      cancelled: false,
      permissionCancellationWaiters: new Set(),
    };
    this.activeRuns.set(runId, activeRun);

    const queue = new AsyncEventQueue<AgentEvent>();
    let terminalStatus: TerminalStatus = null;
    let sessionStarted = false;
    let responseText = "";
    let pendingFinalUsageUpdateTokens: Partial<TokenCounts> | null = null;
    let activitySequence = 0;

    const withRunActivity = (event: AgentEvent): AgentEvent => {
      const at = event.at ?? new Date().toISOString();
      return attachHermesAcpRunActivity(
        { ...event, at },
        {
          runId,
          sequence: ++activitySequence,
          at,
          runSessionId: activeRun.symphonySessionId ?? runId,
          sessionId: activeRun.acpSessionId,
          harnessId: this.id,
        },
      );
    };
    const enqueue = (event: AgentEvent): void => queue.push(withRunActivity(event));
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
        if (mapped.type === "tokens" && acpSessionUpdateKind(event.update) === "usage_update") {
          pendingFinalUsageUpdateTokens = mapped.tokens;
          continue;
        }
        enqueue(mapped);
      }
    };
    const onPermissionRequest = async (
      params: unknown,
      request: HostHermesAcpJsonRpcRequest,
    ): Promise<Record<string, unknown>> => {
      const parsedRequest = parseHermesAcpPermissionRequest(params);
      const resolution = await this.resolvePermissionRequest(ctx, runId, activeRun, parsedRequest, request);
      const event: HermesAcpRuntimeEvent = { type: "permission.resolved", resolution };
      if (sessionStarted) persistRuntimeEvent(event);
      if (resolution.outcome === "cancelled") {
        enqueue({
          type: "run_diagnostic",
          code: "hermes_acp_permission_denied",
          message: `Host Hermes ACP permission request denied: ${resolution.reason}`,
          payload: {
            sessionId: resolution.request.sessionId,
            requestKind: resolution.request.requestKind,
            toolCallId: resolution.request.toolCallId,
            reason: resolution.reason,
            paramsPreview: preview(params, 500),
            redacted: true,
          },
        });
      } else {
        enqueue({
          type: "progress",
          activitySource: "tool",
          message: `Host Hermes ACP permission ${resolution.selectedOptionId ?? "selected"} for ${resolution.request.requestKind}`,
        });
      }
      return resolution.response;
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
    const method = selectNonTerminalAuthMethod(initializeResult);
    await lease.client.request("authenticate", { methodId: method.id }, { timeoutMs: ctx.config.hermes.startupTimeoutMs });
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

interface HermesAcpRunActivityContext {
  runId: string;
  sequence: number;
  at: string;
  runSessionId: string;
  sessionId: string | null;
  harnessId: string;
}

interface HermesAcpRunActivityMetadata {
  actor: string;
  channel: string;
  kind: string;
  text: string | null;
  payload: Record<string, unknown>;
}

function attachHermesAcpRunActivity<T extends AgentEvent>(event: T, context: HermesAcpRunActivityContext): T {
  if (event.runActivity) return event;
  const metadata = runActivityMetadataForAgentEvent(event);
  const sessionId = context.sessionId ?? (event.type === "session_started" ? event.threadId ?? event.sessionId : null);
  const activity = {
    id: `${context.runId}:activity:${context.sequence}`,
    runId: context.runId,
    sessionId,
    runSessionId: context.runSessionId,
    at: context.at,
    sequence: context.sequence,
    sequenceSource: "harness",
    externalEventId: null,
    protocol: "acp",
    harnessId: context.harnessId,
    actor: metadata.actor,
    channel: metadata.channel,
    kind: metadata.kind,
    text: metadata.text,
    payload: metadata.payload,
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
        channel: "status",
        kind: "sdk_status_update",
        text: `Run status: ${event.sdkStatus}`,
        payload: { runId: event.runId, status: event.sdkStatus, source: event.source },
      };
    case "run_diagnostic":
      return {
        actor: "runtime",
        channel: "status",
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
      channel: "message",
      kind: "assistant_message_delta",
      text: event.message,
      payload: { delta: true, messagePreview, redacted: true },
    };
  }
  if (/\b(thought|reasoning)\b/i.test(event.message)) {
    return {
      actor: "assistant",
      channel: "message",
      kind: "assistant_reasoning_delta",
      text: event.message,
      payload: { delta: true, reasoning: true, messagePreview, redacted: true },
    };
  }
  if (/\bplan updated\b/i.test(event.message)) {
    return {
      actor: "runtime",
      channel: "message",
      kind: "plan_update",
      text: event.message,
      payload: { messagePreview, redacted: true },
    };
  }
  return {
    actor: "runtime",
    channel: "status",
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

function toolRunActivityKind(status: string | null): string {
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
  if (!activeSessionId) return false;
  return event.sessionId === null || event.sessionId === activeSessionId;
}

export function mapHermesAcpSessionUpdate(update: Record<string, unknown>): AgentEvent[] {
  const kind = acpSessionUpdateKind(update);
  switch (kind) {
    case "agent_message_chunk": {
      const text = acpAgentMessageText(update);
      return text.length > 0 ? [{ type: "progress", activitySource: "delta", message: text }] : [];
    }
    case "agent_thought_chunk":
      return [{ type: "progress", activitySource: "stream", message: "Hermes ACP thought update" }];
    case "user_message_chunk":
      return [];
    case "usage_update": {
      const finalTokens = finalUsageUpdateTokens(update);
      return finalTokens ? [{ type: "tokens", tokens: finalTokens }] : [{ type: "progress", activitySource: "stream", message: formatUsageUpdate(update) }];
    }
    case "tool_call":
      return [{ type: "progress", activitySource: "tool", message: `Hermes ACP tool started: ${formatToolUpdate(update, "started")}` }];
    case "tool_call_update":
      return [{ type: "progress", activitySource: "tool", message: `Hermes ACP tool ${formatToolStatus(update)}: ${formatToolUpdate(update)}` }];
    case "plan":
      return [{ type: "progress", activitySource: "stream", message: formatPlanUpdate(update) }];
    case "current_mode_update":
      return [{ type: "progress", activitySource: "stream", message: formatCurrentModeUpdate(update) }];
    case "session_info_update":
      return [{ type: "progress", activitySource: "stream", message: formatSessionInfoUpdate(update) }];
    case "available_commands_update":
      return [{ type: "progress", activitySource: "stream", message: formatAvailableCommandsUpdate(update) }];
    default:
      return [
        {
          type: "run_diagnostic",
          code: "hermes_acp_session_update_unmapped",
          message: `Host Hermes ACP emitted unmapped session update ${kind}.`,
          payload: { updateKind: kind, updatePreview: preview(update, 500), redacted: true },
        },
      ];
  }
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
      payload: { stopReason },
    });
    events.push({ type: "failed", error: "Host Hermes ACP refused the prompt." });
    return events;
  }
  if (stopReason === null || stopReason === "end_turn" || stopReason === "stop" || stopReason === "max_turn_requests") {
    const completed: AgentEvent = input.responseText.length > 0 ? { type: "completed", message: input.responseText } : { type: "completed" };
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
    case "permission.resolved": {
      const resolution = event.resolution;
      return {
        eventType: resolution.outcome === "selected" ? "acp_permission_selected" : "acp_permission_denied",
        message:
          resolution.outcome === "selected"
            ? `Host Hermes ACP permission selected: ${resolution.selectedOptionId ?? "unknown"}`
            : `Host Hermes ACP permission denied: ${resolution.reason}`,
        payload: {
          harnessId,
          sessionId: resolution.request.sessionId,
          requestKind: resolution.request.requestKind,
          toolCallId: resolution.request.toolCallId,
          selectedOptionId: resolution.selectedOptionId,
          reason: resolution.reason,
          paramsPreview: preview(resolution.request.params, 500),
          redacted: true,
        },
      };
    }
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

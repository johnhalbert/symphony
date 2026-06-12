import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentEvent, AgentHarness, AgentRunContext } from "../../src/core/harness/AgentHarness.js";
import type { AgentCommandPolicyDecision } from "../../src/core/harness/AgentCommandPolicy.js";
import type {
  RunActivityActor,
  RunActivityChannel,
  RunActivityCommandPolicyDecisionPayload,
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
import {
  redactTextPreserveFormatting,
  redactTranscriptText,
  sanitizeAgentEventForPublicOutput,
  sanitizedPreviewValue,
} from "../../src/core/transcript/TranscriptProjection.js";
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
  scopeKey: string;
  reusable: boolean;
  compatibility: HermesAcpLeaseCompatibility;
  profile: HostHermesAcpProfileLease;
  client: HermesAcpRuntimeClient;
  initialized: boolean;
  runtimeMetadata: HermesAcpRuntimeMetadata;
  disposed: boolean;
  transportExited: boolean;
  transportExitListener: ((exit: HostHermesAcpProcessExit) => void) | undefined;
}

interface ActiveHermesAcpRun {
  ctx: AgentRunContext;
  runId: string;
  lease: HermesAcpLease;
  acpSessionId: string | null;
  symphonySessionId: string | null;
  cancelPromise: Promise<void> | null;
  cancelled: boolean;
  permissionAbortWaiters: Set<(reason: string) => void>;
  pendingPermissionRequests: Map<string, ActiveHermesAcpPermissionRequest>;
  emitPermissionResolution?: (resolution: HermesAcpPermissionResolution, jsonRpcRequestId: HostHermesAcpJsonRpcRequest["id"]) => void;
}

interface ActiveHermesAcpPermissionRequest {
  request: HermesAcpPermissionRequest;
  jsonRpcRequestId: HostHermesAcpJsonRpcRequest["id"];
  auditedTerminalReason: string | null;
}

interface HermesAcpLeaseCompatibility {
  binaryPath: string;
  cwd: string;
  sourceProfile: string;
  profilePrefix: string | null;
  keepProfiles: string;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  cliPath: string;
}

type HermesAcpLeaseReuseDecisionReason =
  | "compatible_reusable_worker_implementation"
  | "fresh_worker_session_lifecycle"
  | "fresh_isolated_role"
  | "fresh_non_implementation_phase"
  | "fresh_no_existing_reusable_lease"
  | "fresh_existing_disposed"
  | "fresh_previous_process_exited"
  | "fresh_incompatible_context";

interface HermesAcpLeaseReuseDecision {
  outcome: "created" | "reused";
  reuseMode: "reuse_by_issue" | "fresh_per_run";
  reason: HermesAcpLeaseReuseDecisionReason;
  key: string;
  scopeKey: string;
  compatibility: HermesAcpLeaseCompatibility;
  existingProfileName?: string;
  incompatibleFields?: string[];
}

interface HermesAcpLeaseAcquisition {
  lease: HermesAcpLease;
  decision: HermesAcpLeaseReuseDecision;
}

type TerminalStatus = HostHermesAcpTerminalStatus;

interface HermesAcpRuntimeMetadata {
  providerId: string | null;
  model: string | null;
}

interface HermesAcpSessionStart {
  sessionId: string;
  runtimeMetadata: HermesAcpRuntimeMetadata;
}

type HermesAcpSessionUpdateDiagnosticCode = "hermes_acp_malformed_session_update" | "hermes_acp_unknown_session_update";

type HermesAcpKnownSessionUpdateKind =
  | "agent_message_chunk"
  | "agent_thought_chunk"
  | "user_message_chunk"
  | "tool_call"
  | "tool_call_update"
  | "plan"
  | "usage_update"
  | "session_info_update"
  | "available_commands_update"
  | "current_mode_update";

interface HermesAcpSessionUpdateDiagnostic {
  code: HermesAcpSessionUpdateDiagnosticCode;
  message: string;
  reason: string;
}

interface NormalizedHermesAcpSessionUpdateBase<TCategory extends string, TKind extends string = string> {
  category: TCategory;
  kind: TKind;
  raw: unknown;
  rawRecord: Record<string, unknown> | null;
  diagnostics: HermesAcpSessionUpdateDiagnostic[];
}

type HermesAcpMessageRole = "agent" | "agent_thought" | "user";

interface NormalizedHermesAcpMessageChunk
  extends NormalizedHermesAcpSessionUpdateBase<"message_chunk", "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk"> {
  role: HermesAcpMessageRole;
  text: string;
  content: unknown;
}

interface NormalizedHermesAcpUsageUpdate extends NormalizedHermesAcpSessionUpdateBase<"usage", "usage_update"> {
  size: number | null;
  used: number | null;
  tokens: Partial<TokenCounts> | null;
}

interface NormalizedHermesAcpToolUpdate extends NormalizedHermesAcpSessionUpdateBase<"tool", "tool_call" | "tool_call_update"> {
  toolCallId: string | null;
  toolKind: string | null;
  title: string | null;
  name: string | null;
  status: string | null;
}

interface HermesAcpToolIdentity {
  toolKind: string | null;
  title: string | null;
  name: string | null;
}

interface HermesAcpSessionUpdateMappingOptions {
  toolIdentities?: Map<string, HermesAcpToolIdentity>;
}

interface NormalizedHermesAcpPlanEntry {
  content: string;
  status: string | null;
  priority: string | null;
  raw: Record<string, unknown>;
}

interface NormalizedHermesAcpPlanUpdate extends NormalizedHermesAcpSessionUpdateBase<"plan", "plan"> {
  entries: NormalizedHermesAcpPlanEntry[];
}

interface NormalizedHermesAcpSessionInfoUpdate extends NormalizedHermesAcpSessionUpdateBase<"session_info", "session_info_update"> {
  title: string | null;
  updatedAt: string | null;
}

interface NormalizedHermesAcpAvailableCommand {
  name: string;
  description: string | null;
  raw: Record<string, unknown>;
}

interface NormalizedHermesAcpAvailableCommandsUpdate
  extends NormalizedHermesAcpSessionUpdateBase<"available_commands", "available_commands_update"> {
  commands: NormalizedHermesAcpAvailableCommand[];
}

interface NormalizedHermesAcpModeUpdate extends NormalizedHermesAcpSessionUpdateBase<"mode", "current_mode_update"> {
  currentModeId: string | null;
}

interface NormalizedHermesAcpUnknownUpdate extends NormalizedHermesAcpSessionUpdateBase<"unknown"> {
  kind: string;
}

interface NormalizedHermesAcpMalformedUpdate extends NormalizedHermesAcpSessionUpdateBase<"malformed"> {
  kind: string;
}

type NormalizedHermesAcpSessionUpdate =
  | NormalizedHermesAcpMessageChunk
  | NormalizedHermesAcpUsageUpdate
  | NormalizedHermesAcpToolUpdate
  | NormalizedHermesAcpPlanUpdate
  | NormalizedHermesAcpSessionInfoUpdate
  | NormalizedHermesAcpAvailableCommandsUpdate
  | NormalizedHermesAcpModeUpdate
  | NormalizedHermesAcpUnknownUpdate
  | NormalizedHermesAcpMalformedUpdate;

type HermesAcpRuntimeEvent =
  | { type: "session.update"; sessionId: string | null; update: NormalizedHermesAcpSessionUpdate; raw: unknown }
  | { type: "diagnostic"; diagnostic: HostHermesAcpDiagnostic }
  | {
      type: "permission.requested";
      request: HermesAcpPermissionRequest;
      jsonRpcRequestId: HostHermesAcpJsonRpcRequest["id"];
    }
  | {
      type: "permission.resolved";
      resolution: HermesAcpPermissionResolution;
      jsonRpcRequestId: HostHermesAcpJsonRpcRequest["id"];
    };

const TERMINAL_SETUP_AUTH_METHOD_ID = "hermes-setup";
const RUN_CANCELLED = Symbol("hermes_acp_run_cancelled");
const PERMISSION_ABORTED = Symbol("hermes_acp_permission_aborted");

interface HermesAcpPermissionAbort {
  type: typeof PERMISSION_ABORTED;
  reason: string;
}

interface SelectedAuthMethod {
  id: string;
  display: string;
  diagnostics: string;
  method: Record<string, unknown>;
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
  private readonly retiredReusableLeaseReasons = new Map<string, HermesAcpLeaseReuseDecisionReason>();
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
    const leaseAcquisition = await this.getOrCreateLease(ctx, runId);
    const lease = leaseAcquisition.lease;
    const activeRun: ActiveHermesAcpRun = {
      ctx,
      runId,
      lease,
      acpSessionId: null,
      symphonySessionId: null,
      cancelPromise: null,
      cancelled: false,
      permissionAbortWaiters: new Set(),
      pendingPermissionRequests: new Map(),
    };
    this.activeRuns.set(runId, activeRun);

    const queue = new AsyncEventQueue<AgentEvent>();
    let terminalStatus: TerminalStatus = null;
    let responseText = "";
    let pendingFinalUsageUpdateTokens: Partial<TokenCounts> | null = null;
    let activitySequence = 0;
    let runRuntimeMetadata = unknownHermesAcpRuntimeMetadata();
    const toolIdentities = new Map<string, HermesAcpToolIdentity>();

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
    activeRun.emitPermissionResolution = (resolution, jsonRpcRequestId) => {
      enqueueRuntimeEvent({ type: "permission.resolved", resolution, jsonRpcRequestId });
    };
    const onSessionUpdate = (params: unknown): void => {
      const event = hermesAcpSessionUpdateEvent(params);
      if (!acceptAcpSessionEvent(event, activeRun.acpSessionId)) return;
      const mappedEvents = mapHermesAcpSessionUpdateWithMetadata(event.update, { toolIdentities }).map((mapped) =>
        withAcpSessionUpdateMetadata(mapped, event.sessionId, event.update),
      );
      responseText += hermesAcpAgentMessageDelta(event.update);
      for (const mapped of mappedEvents) {
        if (mapped.event.type === "tokens" && event.update.kind === "usage_update") {
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
      const requestKey = hermesAcpJsonRpcIdKey(request.id);
      const activePermission: ActiveHermesAcpPermissionRequest = {
        request: parsedRequest,
        jsonRpcRequestId: request.id,
        auditedTerminalReason: null,
      };
      activeRun.pendingPermissionRequests.set(requestKey, activePermission);
      enqueueRuntimeEvent({ type: "permission.requested", request: parsedRequest, jsonRpcRequestId: request.id });
      try {
        const resolution = await this.resolvePermissionRequest(ctx, runId, activeRun, parsedRequest, request);
        if (activePermission.auditedTerminalReason !== resolution.reason) {
          enqueueRuntimeEvent({ type: "permission.resolved", resolution, jsonRpcRequestId: request.id });
        }
        return resolution.response;
      } finally {
        activeRun.pendingPermissionRequests.delete(requestKey);
      }
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
      this.abortPendingPermissionRequests(activeRun, "acp_process_exited");
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
      this.markRunCancelling(activeRun);
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
      runRuntimeMetadata = await this.ensureAcpInitialized(ctx, lease);
      const acpSession = await this.createAcpSession(ctx, lease);
      const acpSessionId = acpSession.sessionId;
      runRuntimeMetadata = acpSession.runtimeMetadata;
      activeRun.acpSessionId = acpSessionId;
      activeRun.symphonySessionId = `${lease.profile.profileName}:${acpSessionId}:${runId}`;
      await writeActiveHandoffMcpContexts(ctx, { activeRunId: runId, sessionId: activeRun.symphonySessionId });
      yield withRunActivity({
        type: "session_started",
        sessionId: activeRun.symphonySessionId,
        threadId: acpSessionId,
        runId,
        providerId: runRuntimeMetadata.providerId,
        model: runRuntimeMetadata.model,
      });

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
      enqueue(hermesAcpLeaseReuseDecisionDiagnostic(leaseAcquisition.decision, lease));

      const promptTask = lease.client
        .request<Record<string, unknown> | null>(
          "session/prompt",
          { sessionId: acpSessionId, prompt: [{ type: "text", text: prompt }] },
          { timeoutMs: ctx.config.hermesAcp.requestTimeoutMs },
        )
        .then((result) => {
          if (terminalStatus !== null) return;
          const events = mapHermesAcpPromptResult(result, {
            cancelled: this.isRunCancelling(ctx, runId, activeRun),
            responseText,
            fallbackUsageTokens: pendingFinalUsageUpdateTokens,
            ...hermesAcpLimitMappingDefaults(ctx, this.id, runRuntimeMetadata),
          });
          terminalStatus = terminalStatusFromEvents(events);
          for (const event of events) enqueue(event);
          queue.close();
        })
        .catch((error: unknown) => {
          const providerLimit = providerLimitSignalFromHermesError(
            error,
            hermesAcpLimitMappingDefaults(ctx, this.id, runRuntimeMetadata),
          );
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
        const providerLimit = providerLimitSignalFromHermesError(
          error,
          hermesAcpLimitMappingDefaults(ctx, this.id, runRuntimeMetadata),
        );
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
    if (request.malformedReason) return finalizePermissionResolution(ctx, runId, denyHermesAcpPermission(request, request.malformedReason));
    if (this.isRunCancelling(ctx, runId, activeRun)) return finalizePermissionResolution(ctx, runId, denyHermesAcpPermission(request, "run_cancelled"));

    const resolver = this.options.permissionResolver;
    if (!resolver) return finalizePermissionResolution(ctx, runId, denyHermesAcpPermission(request, "permission_bridge_not_configured"));

    try {
      const decision = await this.resolvePermissionDecisionUnlessAborted(
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
          this.options.permissionRequestTimeoutMs ?? ctx.config.hermesAcp.permissionTimeoutMs,
          "ACP permission resolver timed out",
        ),
      );
      if (isHermesAcpPermissionAbort(decision)) {
        return finalizePermissionResolution(ctx, runId, denyHermesAcpPermission(request, decision.reason));
      }
      if (this.isRunCancelling(ctx, runId, activeRun)) {
        return finalizePermissionResolution(ctx, runId, denyHermesAcpPermission(request, "run_cancelled"));
      }
      return finalizePermissionResolution(ctx, runId, resolveHermesAcpPermissionDecision(request, decision));
    } catch (error) {
      const reason = error instanceof HermesAcpTimeoutError ? "permission_request_timeout" : "permission_bridge_error";
      ctx.logger.warn("hermes_acp permission resolver failed closed", {
        run_id: runId,
        issue_id: ctx.issue.id,
        issue_identifier: ctx.issue.identifier,
        reason,
        error: errorMessage(error),
      });
      return finalizePermissionResolution(ctx, runId, denyHermesAcpPermission(request, reason));
    }
  }

  async stop(runId: string): Promise<void> {
    const activeRun = this.activeRuns.get(runId);
    if (!activeRun) return;
    this.markRunCancelling(activeRun);
    await this.interruptActiveRun(activeRun, "stop");
  }

  private async resolvePermissionDecisionUnlessAborted(
    ctx: AgentRunContext,
    runId: string,
    activeRun: ActiveHermesAcpRun,
    decisionPromise: Promise<HermesAcpPermissionDecision>,
  ): Promise<HermesAcpPermissionDecision | HermesAcpPermissionAbort> {
    if (this.isRunCancelling(ctx, runId, activeRun)) return hermesAcpPermissionAbort("run_cancelled");

    let notifyAborted: ((reason: string) => void) | null = null;
    const abortPromise = new Promise<HermesAcpPermissionAbort>((resolve) => {
      notifyAborted = (reason: string) => resolve(hermesAcpPermissionAbort(reason));
      activeRun.permissionAbortWaiters.add(notifyAborted);
    });
    try {
      return await Promise.race([decisionPromise, abortPromise]);
    } finally {
      if (notifyAborted) activeRun.permissionAbortWaiters.delete(notifyAborted);
    }
  }

  private isRunCancelling(ctx: AgentRunContext, runId: string, activeRun: ActiveHermesAcpRun): boolean {
    return ctx.abortSignal.aborted || activeRun.cancelled || this.cancelledRuns.has(runId);
  }

  private markRunCancelling(activeRun: ActiveHermesAcpRun): void {
    activeRun.cancelled = true;
    this.cancelledRuns.add(activeRun.runId);
    this.abortPendingPermissionRequests(activeRun, "run_cancelled");
  }

  private abortPendingPermissionRequests(activeRun: ActiveHermesAcpRun, reason: string): void {
    for (const pending of activeRun.pendingPermissionRequests.values()) {
      if (pending.auditedTerminalReason === reason) continue;
      const resolution = finalizePermissionResolution(
        activeRun.ctx,
        activeRun.runId,
        denyHermesAcpPermission(pending.request, reason),
      );
      pending.auditedTerminalReason = reason;
      activeRun.emitPermissionResolution?.(resolution, pending.jsonRpcRequestId);
    }
    for (const notifyAborted of activeRun.permissionAbortWaiters) notifyAborted(reason);
    activeRun.permissionAbortWaiters.clear();
  }

  async dispose(): Promise<void> {
    for (const activeRun of this.activeRuns.values()) this.abortPendingPermissionRequests(activeRun, "harness_dispose");
    await Promise.all([...this.leases.values()].map((lease) => this.disposeLease(lease, null, "harness_dispose")));
    this.leases.clear();
    this.retiredReusableLeaseReasons.clear();
  }

  private async getOrCreateLease(ctx: AgentRunContext, runId: string): Promise<HermesAcpLeaseAcquisition> {
    const policy = hermesAcpLeaseReusePolicy(ctx);
    const scopeKey = reusableLeaseScopeKey(ctx);
    let key = policy.reusable ? reusableLeaseKey(ctx) : `fresh:${runId}`;
    const binaryPath = await this.resolveBinaryPath(ctx);
    const sourceProfile = await this.resolveSourceProfile(ctx, binaryPath);
    const compatibility = hermesAcpLeaseCompatibility(ctx, {
      binaryPath,
      sourceProfile,
      cliPath: this.cliPath(),
    });
    let reusable = policy.reusable;
    let reason = policy.reason;
    const existingLease = reusable ? this.leases.get(key) : undefined;
    let incompatibleFields: string[] | undefined;
    let existingProfileName: string | undefined;

    if (existingLease) {
      existingProfileName = existingLease.profile.profileName;
      if (existingLease.disposed) {
        this.leases.delete(existingLease.key);
        reason = "fresh_existing_disposed";
      } else if (existingLease.transportExited) {
        this.retireLeaseAfterTransportExit(existingLease);
        reason = "fresh_previous_process_exited";
      } else {
        incompatibleFields = incompatibleHermesAcpLeaseFields(existingLease.compatibility, compatibility);
        if (incompatibleFields.length === 0) {
          return {
            lease: existingLease,
            decision: {
              outcome: "reused",
              reuseMode: "reuse_by_issue",
              reason: "compatible_reusable_worker_implementation",
              key: existingLease.key,
              scopeKey,
              compatibility,
              existingProfileName: existingLease.profile.profileName,
            },
          };
        }
        reason = "fresh_incompatible_context";
        if (this.leaseHasActiveRun(existingLease)) {
          reusable = false;
          key = `fresh:${runId}`;
        } else {
          await this.disposeLease(existingLease, null, "reuse_incompatible");
        }
      }
    } else if (reusable) {
      reason = this.retiredReusableLeaseReasons.get(key) ?? "fresh_no_existing_reusable_lease";
    }

    if (reusable) this.retiredReusableLeaseReasons.delete(key);
    const phase = currentRunPhase(ctx);
    const profile = await this.profileLeaseFactory({
      binaryPath,
      cwd: ctx.workspace.path,
      timeoutMs: ctx.config.hermesAcp.startupTimeoutMs,
      sourceProfile,
      reservedProfileNames: [sourceProfile],
      keepProfiles: ctx.config.hermesAcp.keepProfiles,
      reusable,
      nameInput: {
        workspaceKey: ctx.workspace.workspaceKey,
        issueIdentifier: ctx.issue.identifier,
        role: ctx.role,
        phase,
        attempt: ctx.attempt,
        runId: reusable ? null : runId,
        prefix: configuredHermesAcpProfilePrefix(ctx),
      },
    });
    const client = this.acpClientFactory(profile.acpCommand, { requestTimeoutMs: ctx.config.hermesAcp.requestTimeoutMs });
    const lease: HermesAcpLease = {
      key,
      scopeKey,
      reusable,
      compatibility,
      profile,
      client,
      initialized: false,
      runtimeMetadata: unknownHermesAcpRuntimeMetadata(),
      disposed: false,
      transportExited: false,
      transportExitListener: undefined,
    };
    lease.transportExitListener = (exit) => this.handleLeaseTransportExit(lease, exit);
    lease.client.on("exit", lease.transportExitListener);
    if (reusable) this.leases.set(key, lease);
    return {
      lease,
      decision: {
        outcome: "created",
        reuseMode: reusable ? "reuse_by_issue" : "fresh_per_run",
        reason,
        key,
        scopeKey,
        compatibility,
        ...(existingProfileName === undefined ? {} : { existingProfileName }),
        ...(incompatibleFields === undefined ? {} : { incompatibleFields }),
      },
    };
  }

  private async resolveBinaryPath(ctx: AgentRunContext): Promise<string> {
    const configuredBinaryPath = configuredHostHermesBinaryPath(ctx);
    if (configuredBinaryPath) return configuredBinaryPath;
    const discovery = await this.discoverHostHermes({
      cwd: ctx.workspace.path,
      sourceProfile: configuredHostHermesSourceProfile(ctx),
      timeoutMs: ctx.config.hermesAcp.startupTimeoutMs,
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
      timeoutMs: ctx.config.hermesAcp.startupTimeoutMs,
    });
    if (discovery.sourceProfile?.name && discovery.diagnostics.every((diagnostic) => diagnostic.severity !== "error")) {
      return discovery.sourceProfile.name;
    }
    throw new SymphonyError("config_validation_error", hostHermesDiscoveryErrorMessage(discovery));
  }

  private async ensureAcpInitialized(ctx: AgentRunContext, lease: HermesAcpLease): Promise<HermesAcpRuntimeMetadata> {
    if (lease.initialized) return lease.runtimeMetadata;
    const initializeResult = await lease.client.request<Record<string, unknown>>(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "symphony", title: "Symphony", version: "0.1.0" },
      },
      { timeoutMs: ctx.config.hermesAcp.startupTimeoutMs },
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
        { timeoutMs: ctx.config.hermesAcp.startupTimeoutMs },
      );
    } catch (error) {
      throw new SymphonyError(
        "config_validation_error",
        `Host Hermes ACP authenticate failed for auth method ${method.display}: ${redactLogLine(errorMessage(error))}. ${method.diagnostics} Refusing unattended hermes_acp run; configure Hermes provider credentials before using the ACP harness.`,
        error,
      );
    }
    validateAcpAuthenticateResult(authenticateResult, method);
    lease.runtimeMetadata = mergeHermesAcpRuntimeMetadata(
      hermesAcpRuntimeMetadataFromInitializeResult(initializeResult, method),
      hermesAcpRuntimeMetadataFromRecord(authenticateResult),
    );
    lease.initialized = true;
    return lease.runtimeMetadata;
  }

  private async createAcpSession(ctx: AgentRunContext, lease: HermesAcpLease): Promise<HermesAcpSessionStart> {
    const response = await lease.client.request<Record<string, unknown>>(
      "session/new",
      {
        cwd: ctx.workspace.path,
        mcpServers: mcpServersToAcpStdioServers(symphonyRoleMcpServers(ctx, { cliPath: this.cliPath(), mcpCwd: ctx.workspace.path })),
      },
      { timeoutMs: ctx.config.hermesAcp.startupTimeoutMs },
    );
    const sessionId = nonEmptyString(response.sessionId) ?? nonEmptyString(response.session_id);
    if (!sessionId) throw new SymphonyError("agent_error", "Host Hermes ACP session/new did not return a sessionId.");
    const runtimeMetadata = mergeHermesAcpRuntimeMetadata(lease.runtimeMetadata, hermesAcpRuntimeMetadataFromRecord(response));
    return { sessionId, runtimeMetadata };
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
    lease.runtimeMetadata = unknownHermesAcpRuntimeMetadata();
    this.leases.delete(lease.key);
    if (lease.reusable) this.retiredReusableLeaseReasons.set(lease.key, "fresh_previous_process_exited");
  }

  private leaseHasActiveRun(lease: HermesAcpLease): boolean {
    return [...this.activeRuns.values()].some((activeRun) => activeRun.lease === lease);
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
    const publicValue =
      isRecord(value) && typeof value.type === "string" ? (sanitizeAgentEventForPublicOutput(value as unknown as AgentEvent) as T) : value;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: publicValue, done: false });
      return;
    }
    this.values.push(publicValue);
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
        payload: {
          sessionId: event.sessionId,
          threadId: event.threadId ?? null,
          runId: event.runId ?? null,
          providerId: event.providerId ?? null,
          model: event.model ?? null,
        },
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
    const deltaPreview = previewDelta(event.message, 1_000);
    return {
      actor: "assistant",
      channel: "chat",
      kind: "assistant_message_delta",
      text: event.message,
      payload: { delta: true, messagePreview: deltaPreview, redacted: true },
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

function hermesAcpLeaseReusePolicy(ctx: AgentRunContext): { reusable: boolean; reason: HermesAcpLeaseReuseDecisionReason } {
  const phase = currentRunPhase(ctx);
  if (ctx.role !== "worker") return { reusable: false, reason: "fresh_isolated_role" };
  if (phase !== "implementation") return { reusable: false, reason: "fresh_non_implementation_phase" };
  if (ctx.config.hermesAcp.workerSessionLifecycle !== "reuse_by_issue") {
    return { reusable: false, reason: "fresh_worker_session_lifecycle" };
  }
  return { reusable: true, reason: "fresh_no_existing_reusable_lease" };
}

function reusableLeaseScopeKey(ctx: AgentRunContext): string {
  return `${ctx.role}:${ctx.issue.id || ctx.issue.identifier}:${currentRunPhase(ctx)}`;
}

function reusableLeaseKey(ctx: AgentRunContext): string {
  return `${ctx.workspace.path}:${reusableLeaseScopeKey(ctx)}`;
}

function hermesAcpLeaseCompatibility(
  ctx: AgentRunContext,
  input: { binaryPath: string; sourceProfile: string; cliPath: string },
): HermesAcpLeaseCompatibility {
  return {
    binaryPath: input.binaryPath,
    cwd: ctx.workspace.path,
    sourceProfile: input.sourceProfile,
    profilePrefix: configuredHermesAcpProfilePrefix(ctx),
    keepProfiles: ctx.config.hermesAcp.keepProfiles,
    startupTimeoutMs: ctx.config.hermesAcp.startupTimeoutMs,
    requestTimeoutMs: ctx.config.hermesAcp.requestTimeoutMs,
    cliPath: input.cliPath,
  };
}

function incompatibleHermesAcpLeaseFields(
  existing: HermesAcpLeaseCompatibility,
  next: HermesAcpLeaseCompatibility,
): string[] {
  const fields: Array<keyof HermesAcpLeaseCompatibility> = [
    "binaryPath",
    "cwd",
    "sourceProfile",
    "profilePrefix",
    "keepProfiles",
    "startupTimeoutMs",
    "requestTimeoutMs",
    "cliPath",
  ];
  return fields.filter((field) => existing[field] !== next[field]);
}

function hermesAcpLeaseReuseDecisionDiagnostic(
  decision: HermesAcpLeaseReuseDecision,
  lease: HermesAcpLease,
): AgentEvent {
  const reused = decision.outcome === "reused";
  const reason = formatHermesAcpLeaseReuseReason(decision.reason);
  return {
    type: "run_diagnostic",
    code: "hermes_acp_lease_reuse_decision",
    message: reused
      ? `Host Hermes ACP lease reused for ${lease.profile.profileName}: ${reason}.`
      : `Host Hermes ACP lease created for ${lease.profile.profileName}: ${reason}.`,
    payload: {
      harnessId: "hermes_acp",
      profileName: lease.profile.profileName,
      sourceProfile: lease.profile.sourceProfile,
      reusable: lease.reusable,
      outcome: decision.outcome,
      reuseMode: decision.reuseMode,
      reason: decision.reason,
      key: decision.key,
      scopeKey: decision.scopeKey,
      existingProfileName: decision.existingProfileName ?? null,
      incompatibleFields: decision.incompatibleFields ?? [],
      compatibility: decision.compatibility,
    },
  };
}

function formatHermesAcpLeaseReuseReason(reason: HermesAcpLeaseReuseDecisionReason): string {
  switch (reason) {
    case "compatible_reusable_worker_implementation":
      return "existing worker implementation context is compatible";
    case "fresh_worker_session_lifecycle":
      return "hermes_acp.worker_session_lifecycle requires a fresh run";
    case "fresh_isolated_role":
      return "role requires an isolated fresh lease";
    case "fresh_non_implementation_phase":
      return "run phase requires an isolated fresh lease";
    case "fresh_no_existing_reusable_lease":
      return "no compatible reusable worker lease exists yet";
    case "fresh_existing_disposed":
      return "previous reusable lease was already disposed";
    case "fresh_previous_process_exited":
      return "previous reusable ACP process exited before reuse";
    case "fresh_incompatible_context":
      return "existing reusable lease context is incompatible";
  }
}

function currentRunPhase(ctx: AgentRunContext): AgentRunPhase {
  return ctx.runPhase ?? (ctx.role === "reviewer" ? "review" : "implementation");
}

function configuredHostHermesBinaryPath(ctx: AgentRunContext): string | null {
  return ctx.config.hermesAcp.binaryPath;
}

function configuredHostHermesSourceProfile(ctx: AgentRunContext): string | null {
  return ctx.config.hermesAcp.sourceProfile;
}

function configuredHermesAcpProfilePrefix(ctx: AgentRunContext): string {
  return ctx.config.hermesAcp.profilePrefix;
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
  return { id, display: selectedAuthMethodDisplay(method, id), diagnostics, method };
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

function unknownHermesAcpRuntimeMetadata(): HermesAcpRuntimeMetadata {
  return { providerId: null, model: null };
}

function hermesAcpRuntimeMetadataFromInitializeResult(
  initializeResult: Record<string, unknown>,
  method: SelectedAuthMethod,
): HermesAcpRuntimeMetadata {
  return mergeHermesAcpRuntimeMetadata(
    hermesAcpRuntimeMetadataFromRecord(initializeResult),
    hermesAcpRuntimeMetadataFromRecord(method.method),
  );
}

function hermesAcpRuntimeMetadataFromRecord(value: unknown): HermesAcpRuntimeMetadata {
  if (!isRecord(value)) return unknownHermesAcpRuntimeMetadata();
  const records = runtimeMetadataCandidateRecords(value);
  const provider = runtimeMetadataStringFromRecords(records, [
    "providerId",
    "provider_id",
    "provider",
    "activeProvider",
    "active_provider",
    "runtimeProvider",
    "runtime_provider",
    "providerName",
    "provider_name",
  ]);
  return {
    providerId: provider ? normalizeHermesAuthProvider(provider) : null,
    model: runtimeMetadataStringFromRecords(records, [
      "model",
      "modelId",
      "model_id",
      "modelName",
      "model_name",
      "activeModel",
      "active_model",
      "currentModel",
      "current_model",
      "runtimeModel",
      "runtime_model",
    ]),
  };
}

function runtimeMetadataCandidateRecords(record: Record<string, unknown>): Record<string, unknown>[] {
  return [
    record,
    record.runtime,
    record.runtimeMetadata,
    record.runtime_metadata,
    record.metadata,
    record.session,
    record.auth,
  ].filter(isRecord);
}

function runtimeMetadataStringFromRecords(records: Record<string, unknown>[], keys: string[]): string | null {
  for (const record of records) {
    for (const key of keys) {
      const value = nonEmptyString(record[key]);
      if (value) return value;
    }
  }
  return null;
}

function mergeHermesAcpRuntimeMetadata(...items: HermesAcpRuntimeMetadata[]): HermesAcpRuntimeMetadata {
  const merged = unknownHermesAcpRuntimeMetadata();
  for (const item of items) {
    if (item.providerId) merged.providerId = item.providerId;
    if (item.model) merged.model = item.model;
  }
  return merged;
}

function hermesAcpLimitMappingDefaults(
  ctx: AgentRunContext,
  harnessId: string,
  runtimeMetadata: HermesAcpRuntimeMetadata,
): HermesLimitMappingDefaults {
  return {
    harnessId,
    providerId: runtimeMetadata.providerId ?? ctx.config.hermes.provider,
    model: runtimeMetadata.model,
  };
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

const KNOWN_HERMES_ACP_SESSION_UPDATE_KINDS: ReadonlySet<string> = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "user_message_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "usage_update",
  "session_info_update",
  "available_commands_update",
  "current_mode_update",
]);

function hermesAcpSessionUpdateEvent(params: unknown): Extract<HermesAcpRuntimeEvent, { type: "session.update" }> {
  const update = isRecord(params) ? params.update : undefined;
  return {
    type: "session.update",
    sessionId: acpSessionIdFromParams(params),
    update: normalizeHermesAcpSessionUpdate(update),
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
  return mapHermesAcpSessionUpdateWithMetadata(normalizeHermesAcpSessionUpdate(update)).map((mapped) => mapped.event);
}

function normalizeHermesAcpSessionUpdate(update: unknown): NormalizedHermesAcpSessionUpdate {
  if (!isRecord(update)) {
    return {
      category: "malformed",
      kind: "session_update",
      raw: update,
      rawRecord: null,
      diagnostics: [
        sessionUpdateDiagnostic(
          "hermes_acp_malformed_session_update",
          "ACP session/update payload did not include an object update.",
          "update_not_object",
        ),
      ],
    };
  }

  const kind = rawAcpSessionUpdateKind(update);
  if (kind === null) {
    return {
      category: "malformed",
      kind: "session_update",
      raw: update,
      rawRecord: update,
      diagnostics: [
        sessionUpdateDiagnostic(
          "hermes_acp_malformed_session_update",
          "ACP session/update payload did not include a sessionUpdate discriminator.",
          "missing_session_update_kind",
        ),
      ],
    };
  }

  if (!isKnownHermesAcpSessionUpdateKind(kind)) {
    return {
      category: "unknown",
      kind,
      raw: update,
      rawRecord: update,
      diagnostics: [
        sessionUpdateDiagnostic(
          "hermes_acp_unknown_session_update",
          `Host Hermes ACP emitted unknown session/update kind ${kind}.`,
          "unknown_session_update_kind",
        ),
      ],
    };
  }

  switch (kind) {
    case "agent_message_chunk":
    case "agent_thought_chunk":
    case "user_message_chunk":
      return normalizeMessageChunk(kind, update);
    case "usage_update":
      return normalizeUsageUpdate(update);
    case "tool_call":
    case "tool_call_update":
      return normalizeToolUpdate(kind, update);
    case "plan":
      return normalizePlanUpdate(update);
    case "session_info_update":
      return normalizeSessionInfoUpdate(update);
    case "available_commands_update":
      return normalizeAvailableCommandsUpdate(update);
    case "current_mode_update":
      return normalizeModeUpdate(update);
  }
}

function sessionUpdateDiagnostic(
  code: HermesAcpSessionUpdateDiagnosticCode,
  message: string,
  reason: string,
): HermesAcpSessionUpdateDiagnostic {
  return { code, message, reason };
}

function isKnownHermesAcpSessionUpdateKind(kind: string): kind is HermesAcpKnownSessionUpdateKind {
  return KNOWN_HERMES_ACP_SESSION_UPDATE_KINDS.has(kind);
}

function rawAcpSessionUpdateKind(update: Record<string, unknown>): string | null {
  const raw = nonEmptyString(update.sessionUpdate) ?? nonEmptyString(update.session_update);
  return raw ? toSnakeCase(raw) : null;
}

function normalizeMessageChunk(
  kind: "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk",
  update: Record<string, unknown>,
): NormalizedHermesAcpMessageChunk {
  return {
    category: "message_chunk",
    kind,
    role: messageRoleForSessionUpdateKind(kind),
    content: update.content,
    text: acpAgentMessageText(update),
    raw: update,
    rawRecord: update,
    diagnostics: [],
  };
}

function messageRoleForSessionUpdateKind(kind: NormalizedHermesAcpMessageChunk["kind"]): HermesAcpMessageRole {
  if (kind === "agent_message_chunk") return "agent";
  if (kind === "agent_thought_chunk") return "agent_thought";
  return "user";
}

function normalizeUsageUpdate(update: Record<string, unknown>): NormalizedHermesAcpUsageUpdate {
  const usage = isRecord(update.usage) ? update.usage : {};
  const used = numberFromUnknown(update.used) ?? numberFromUnknown(usage.used);
  return {
    category: "usage",
    kind: "usage_update",
    size: numberFromUnknown(update.size) ?? numberFromUnknown(update.limit) ?? numberFromUnknown(usage.size) ?? numberFromUnknown(usage.limit),
    used,
    tokens: finalUsageUpdateTokens(update),
    raw: update,
    rawRecord: update,
    diagnostics: [],
  };
}

function normalizeToolUpdate(
  kind: "tool_call" | "tool_call_update",
  update: Record<string, unknown>,
): NormalizedHermesAcpToolUpdate {
  const toolCall = toolCallRecord(update);
  return {
    category: "tool",
    kind,
    toolCallId:
      nonEmptyString(update.toolCallId) ??
      nonEmptyString(update.tool_call_id) ??
      nonEmptyString(toolCall.id) ??
      nonEmptyString(toolCall.toolCallId) ??
      nonEmptyString(toolCall.tool_call_id),
    toolKind: nonEmptyString(update.kind) ?? nonEmptyString(update.toolKind) ?? nonEmptyString(update.tool_kind) ?? nonEmptyString(toolCall.kind),
    title: nonEmptyString(update.title) ?? nonEmptyString(toolCall.title),
    name: nonEmptyString(update.name) ?? nonEmptyString(update.tool) ?? nonEmptyString(toolCall.name) ?? nonEmptyString(toolCall.tool),
    status: nonEmptyString(update.status) ?? nonEmptyString(toolCall.status),
    raw: update,
    rawRecord: update,
    diagnostics: [],
  };
}

function normalizePlanUpdate(update: Record<string, unknown>): NormalizedHermesAcpPlanUpdate {
  const entries = Array.isArray(update.entries) ? update.entries : [];
  return {
    category: "plan",
    kind: "plan",
    entries: entries.filter(isRecord).map((entry) => ({
      content: nonEmptyString(entry.content) ?? nonEmptyString(entry.title) ?? preview(entry, 160),
      status: nonEmptyString(entry.status),
      priority: nonEmptyString(entry.priority),
      raw: entry,
    })),
    raw: update,
    rawRecord: update,
    diagnostics: [],
  };
}

function normalizeSessionInfoUpdate(update: Record<string, unknown>): NormalizedHermesAcpSessionInfoUpdate {
  return {
    category: "session_info",
    kind: "session_info_update",
    title: nonEmptyString(update.title),
    updatedAt: nonEmptyString(update.updatedAt) ?? nonEmptyString(update.updated_at),
    raw: update,
    rawRecord: update,
    diagnostics: [],
  };
}

function normalizeAvailableCommandsUpdate(update: Record<string, unknown>): NormalizedHermesAcpAvailableCommandsUpdate {
  const rawCommands = Array.isArray(update.availableCommands)
    ? update.availableCommands
    : Array.isArray(update.available_commands)
      ? update.available_commands
      : [];
  return {
    category: "available_commands",
    kind: "available_commands_update",
    commands: rawCommands.filter(isRecord).map((command) => ({
      name: nonEmptyString(command.name) ?? nonEmptyString(command.title) ?? preview(command, 80),
      description: nonEmptyString(command.description),
      raw: command,
    })),
    raw: update,
    rawRecord: update,
    diagnostics: [],
  };
}

function normalizeModeUpdate(update: Record<string, unknown>): NormalizedHermesAcpModeUpdate {
  return {
    category: "mode",
    kind: "current_mode_update",
    currentModeId:
      nonEmptyString(update.currentModeId) ??
      nonEmptyString(update.current_mode_id) ??
      nonEmptyString(update.currentMode) ??
      nonEmptyString(update.current_mode) ??
      nonEmptyString(update.modeId) ??
      nonEmptyString(update.mode_id),
    raw: update,
    rawRecord: update,
    diagnostics: [],
  };
}

function mapHermesAcpSessionUpdateWithMetadata(
  update: NormalizedHermesAcpSessionUpdate,
  options: HermesAcpSessionUpdateMappingOptions = {},
): HermesAcpMappedAgentEvent[] {
  const diagnostics = mapSessionUpdateDiagnosticsWithMetadata(update);
  const raw = update.rawRecord;
  switch (update.category) {
    case "message_chunk": {
      const text = update.text;
      if (update.role === "user") {
        const message = "Hermes ACP user message replay";
        return text.length > 0
          ? [
              ...diagnostics,
              mappedAgentEvent(
                { type: "progress", activitySource: "stream", message },
                {
                  actor: "user",
                  channel: "chat",
                  kind: "user_message_submitted",
                  text,
                  payload: {
                    replay: true,
                    messagePreview: preview(text, 1_000),
                    ...acpSessionUpdatePreviewPayload(update),
                  },
                },
              ),
            ]
          : diagnostics;
      }
      if (update.role === "agent_thought") {
        const message = "Hermes ACP thought update";
        return [
          ...diagnostics,
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
                messagePreview: preview(text.length > 0 ? text : message, 1_000),
                ...acpSessionUpdatePreviewPayload(update),
              },
            },
          ),
        ];
      }
      return text.length > 0
        ? [
            ...diagnostics,
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
        : diagnostics;
    }
    case "usage": {
      if (!raw) return diagnostics;
      const finalTokens = update.tokens;
      if (finalTokens) {
        const tokens = normalizedTokenCounts(finalTokens);
        return [
          ...diagnostics,
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
      const message = formatUsageUpdate(raw);
      return [
        ...diagnostics,
        mappedAgentEvent(
          { type: "progress", activitySource: "stream", message },
          {
            actor: "runtime",
            channel: "diagnostic",
            kind: "runtime_status_update",
            text: message,
            payload: { status: "usage_update", usagePreview: preview(raw.usage ?? raw, 1_000), ...acpSessionUpdatePreviewPayload(update) },
          },
        ),
      ];
    }
    case "tool": {
      if (!raw) return diagnostics;
      const toolUpdate = correlateToolIdentity(update, options.toolIdentities);
      if (toolUpdate.kind === "tool_call") {
        const message = `Hermes ACP tool started: ${formatNormalizedToolUpdate(toolUpdate, "started")}`;
        return [
          ...diagnostics,
          mappedAgentEvent({ type: "progress", activitySource: "tool", message }, toolRunActivityMetadata(raw, message, "running", toolUpdate)),
        ];
      }
      const message = `Hermes ACP tool ${formatNormalizedToolStatus(toolUpdate)}: ${formatNormalizedToolUpdate(toolUpdate)}`;
      return [
        ...diagnostics,
        mappedAgentEvent({ type: "progress", activitySource: "tool", message }, toolRunActivityMetadata(raw, message, null, toolUpdate)),
      ];
    }
    case "plan": {
      if (!raw) return diagnostics;
      const message = formatPlanUpdate(raw);
      return [
        ...diagnostics,
        mappedAgentEvent(
          { type: "progress", activitySource: "stream", message },
          {
            actor: "runtime",
            channel: "chat",
            kind: "plan_update",
            text: message,
            payload: { ...planRunActivityPayload(update, raw), ...acpSessionUpdatePreviewPayload(update) },
          },
        ),
      ];
    }
    case "mode": {
      if (!raw) return diagnostics;
      const message = formatCurrentModeUpdate(raw);
      return [
        ...diagnostics,
        mappedAgentEvent(
          { type: "progress", activitySource: "stream", message },
          {
            actor: "runtime",
            channel: "diagnostic",
            kind: "mode_update",
            text: message,
            payload: {
              status: "mode_update",
              mode: update.currentModeId,
              ...acpSessionUpdatePreviewPayload(update),
            },
          },
        ),
      ];
    }
    case "session_info": {
      if (!raw) return diagnostics;
      const message = formatSessionInfoUpdate(raw);
      return [
        ...diagnostics,
        mappedAgentEvent(
          { type: "progress", activitySource: "stream", message },
          {
            actor: "runtime",
            channel: "diagnostic",
            kind: "runtime_status_update",
            text: message,
            payload: { status: "session_info_update", title: update.title, ...acpSessionUpdatePreviewPayload(update) },
          },
        ),
      ];
    }
    case "available_commands": {
      if (!raw) return diagnostics;
      const message = formatAvailableCommandsUpdate(raw);
      return [
        ...diagnostics,
        mappedAgentEvent(
          { type: "progress", activitySource: "stream", message },
          {
            actor: "runtime",
            channel: "diagnostic",
            kind: "available_commands_update",
            text: message,
            payload: { commands: availableCommandNames(raw), ...acpSessionUpdatePreviewPayload(update) },
          },
        ),
      ];
    }
    case "unknown": {
      const text = normalizedUpdateText(update);
      const progress = raw
        ? [
            mappedAgentEvent(
              {
                type: "progress",
                ...(update.kind.includes("tool") ? { activitySource: "tool" as const } : {}),
                message: update.kind.includes("tool")
                  ? `Hermes ACP ${formatToolUpdate(raw)}`
                  : `Hermes ACP ${update.kind}${text.length > 0 ? `: ${text}` : ""}`,
              },
              {
                actor: update.kind.includes("tool") ? "tool" : "runtime",
                channel: update.kind.includes("tool") ? "tool" : "diagnostic",
                kind: update.kind.includes("tool") ? "tool_call_progress" : "runtime_status_update",
                text: update.kind.includes("tool") ? `Hermes ACP ${formatToolUpdate(raw)}` : `Hermes ACP ${update.kind}`,
                payload: { status: "unknown_session_update", ...acpSessionUpdatePreviewPayload(update) },
              },
            ),
          ]
        : [];
      return [...diagnostics, ...progress];
    }
    case "malformed":
      return diagnostics;
  }
}

function mapSessionUpdateDiagnosticsWithMetadata(update: NormalizedHermesAcpSessionUpdate): HermesAcpMappedAgentEvent[] {
  return update.diagnostics.map((diagnostic) => {
    const message = diagnostic.message;
    return mappedAgentEvent(
      {
        type: "run_diagnostic",
        code: diagnostic.code,
        message,
        payload: {
          updateKind: update.kind,
          updateCategory: update.category,
          reason: diagnostic.reason,
          updatePreview: preview(update.raw, 500),
          redacted: true,
        },
      },
      {
        actor: "runtime",
        channel: "diagnostic",
        kind: "runtime_diagnostic",
        text: message,
        payload: {
          code: diagnostic.code,
          severity: diagnostic.code === "hermes_acp_unknown_session_update" ? "info" : "warning",
          reason: diagnostic.reason,
          ...acpSessionUpdatePreviewPayload(update),
        },
      },
    );
  });
}

function normalizedUpdateText(update: NormalizedHermesAcpSessionUpdate): string {
  if (update.category === "message_chunk") return update.text;
  if (!update.rawRecord) return "";
  return acpAgentMessageText(update.rawRecord);
}

function toolCallRecord(update: Record<string, unknown>): Record<string, unknown> {
  return isRecord(update.toolCall) ? update.toolCall : isRecord(update.tool_call) ? update.tool_call : update;
}

function mappedAgentEvent(event: AgentEvent, runActivityMetadata: HermesAcpRunActivityMetadata): HermesAcpMappedAgentEvent {
  return { event, runActivityMetadata };
}

function acpSessionUpdatePreviewPayload(update: NormalizedHermesAcpSessionUpdate): Record<string, unknown> {
  return { updateKind: update.kind, updateCategory: update.category, updatePreview: preview(update.raw, 1_000), redacted: true };
}

function withAcpSessionUpdateMetadata(
  mapped: HermesAcpMappedAgentEvent,
  sessionId: string | null,
  update: NormalizedHermesAcpSessionUpdate,
): HermesAcpMappedAgentEvent {
  const metadata = mapped.runActivityMetadata ?? runActivityMetadataForAgentEvent(mapped.event);
  return {
    event: mapped.event,
    runActivityMetadata: {
      ...metadata,
      payload: {
        ...metadata.payload,
        acpSessionId: sessionId,
        updateKind: update.kind,
        updateCategory: update.category,
        updatePreview: preview(update.raw, 1_000),
        redacted: true,
      },
    },
  };
}

function hermesAcpAgentMessageDelta(update: NormalizedHermesAcpSessionUpdate): string {
  return update.category === "message_chunk" && update.role === "agent" ? update.text : "";
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

function correlateToolIdentity(
  update: NormalizedHermesAcpToolUpdate,
  toolIdentities: Map<string, HermesAcpToolIdentity> | undefined,
): NormalizedHermesAcpToolUpdate {
  const callId = update.toolCallId;
  if (!toolIdentities || !callId) return update;

  const stored = toolIdentities.get(callId);
  const correlated: NormalizedHermesAcpToolUpdate = {
    ...update,
    toolKind: update.toolKind ?? stored?.toolKind ?? null,
    title: update.title ?? stored?.title ?? null,
    name: update.name ?? stored?.name ?? stored?.title ?? null,
  };

  const nextIdentity: HermesAcpToolIdentity = {
    toolKind: correlated.toolKind,
    title: correlated.title,
    name: correlated.name,
  };
  if (nextIdentity.toolKind || nextIdentity.title || nextIdentity.name) toolIdentities.set(callId, nextIdentity);
  return correlated;
}

function formatNormalizedToolUpdate(update: NormalizedHermesAcpToolUpdate, defaultStatus?: string): string {
  const title = update.title ?? update.name ?? update.toolKind ?? "tool update";
  const status = update.status ?? defaultStatus;
  return status ? `${title} (${status})` : title;
}

function formatNormalizedToolStatus(update: NormalizedHermesAcpToolUpdate): string {
  return update.status ?? "updated";
}

function toolRunActivityMetadata(
  update: Record<string, unknown>,
  message: string,
  fallbackStatus: "running" | null,
  normalizedUpdate: NormalizedHermesAcpSessionUpdate = normalizeHermesAcpSessionUpdate(update),
): HermesAcpRunActivityMetadata {
  const tool = toolDetailsFromUpdate(update, normalizedUpdate, fallbackStatus);
  const status = normalizedToolStatus(tool.status, fallbackStatus);
  const payload: Record<string, unknown> = {
    status,
    ...acpSessionUpdatePreviewPayload(normalizedUpdate),
  };
  if (tool.callId) payload.toolCallId = tool.callId;
  if (tool.name) payload.toolName = tool.name;
  if (tool.toolKind) payload.toolKind = tool.toolKind;
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
  toolKind: string | null;
  title: string | null;
  status: string | null;
  inputPreview: string | null;
  argsPreview: string | null;
  resultPreview: string | null;
  outputPreview: string | null;
  errorPreview: string | null;
}

function toolDetailsFromUpdate(
  update: Record<string, unknown>,
  normalizedUpdate: NormalizedHermesAcpSessionUpdate = normalizeHermesAcpSessionUpdate(update),
  fallbackStatus: "running" | null = null,
): HermesAcpToolDetails {
  const toolCall = isRecord(update.toolCall) ? update.toolCall : isRecord(update.tool_call) ? update.tool_call : {};
  const normalizedToolUpdate = normalizedUpdate.category === "tool" ? normalizedUpdate : null;
  const callId = firstScalarString(
    normalizedToolUpdate?.toolCallId,
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
  const title = firstScalarString(normalizedToolUpdate?.title, toolCall.title, update.title);
  const toolKind = firstScalarString(
    normalizedToolUpdate?.toolKind,
    toolCall.kind,
    update.kind,
    toolCall.toolKind,
    toolCall.tool_kind,
    update.toolKind,
    update.tool_kind,
  );
  const name = firstScalarString(
    normalizedToolUpdate?.name,
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
  const status = firstScalarString(normalizedToolUpdate?.status, update.status, toolCall.status, update.state, toolCall.state, update.phase, toolCall.phase);
  const normalizedStatus = normalizedToolStatus(status, fallbackStatus);
  const content = firstPresent(toolCall.content, update.content);
  const startContent = normalizedToolUpdate?.kind === "tool_call" ? content : undefined;
  const updateContent = normalizedToolUpdate?.kind === "tool_call_update" ? content : undefined;
  const outputContent = normalizedStatus === "failed" ? undefined : updateContent;
  const errorContent = normalizedStatus === "failed" ? updateContent : undefined;
  return {
    callId,
    name,
    toolKind,
    title,
    status,
    inputPreview: previewIfPresent(
      firstPresent(
        toolCall.input,
        update.input,
        toolCall.rawInput,
        update.rawInput,
        toolCall.raw_input,
        update.raw_input,
        toolCall.parameters,
        update.parameters,
        startContent,
      ),
      1_000,
    ),
    argsPreview: previewIfPresent(firstPresent(toolCall.args, update.args, toolCall.arguments, update.arguments), 1_000),
    resultPreview: previewIfPresent(
      firstPresent(toolCall.result, update.result, toolCall.rawResult, update.rawResult, toolCall.raw_result, update.raw_result, toolCall.summary, update.summary),
      1_000,
    ),
    outputPreview: previewIfPresent(
      firstPresent(toolCall.output, update.output, toolCall.rawOutput, update.rawOutput, toolCall.raw_output, update.raw_output, outputContent, toolCall.message, update.message),
      1_000,
    ),
    errorPreview: previewIfPresent(
      firstPresent(toolCall.error, update.error, toolCall.errorMessage, update.errorMessage, toolCall.error_message, update.error_message, errorContent),
      1_000,
    ),
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

function planRunActivityPayload(update: NormalizedHermesAcpPlanUpdate, raw: Record<string, unknown>): Record<string, unknown> {
  const entries = update.entries.slice(0, 20).map((entry, index) => ({
    index,
    contentPreview: preview(entry.content, 300),
    status: normalizedPlanStatus(entry.status),
    ...(entry.priority ? { priority: preview(entry.priority, 80) } : {}),
  }));
  return {
    entriesPreview: preview(raw.entries ?? raw, 1_000),
    entries,
    statusCounts: planStatusCounts(update.entries),
    activeEntries: update.entries
      .filter((entry) => normalizedPlanStatus(entry.status) === "in_progress")
      .slice(0, 5)
      .map((entry) => preview(entry.content, 300)),
  };
}

function planStatusCounts(entries: readonly NormalizedHermesAcpPlanEntry[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const status = normalizedPlanStatus(entry.status);
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return Object.fromEntries(counts.entries());
}

function normalizedPlanStatus(status: string | null | undefined): string {
  return toSnakeCase(nonEmptyString(status) ?? "pending") || "pending";
}

function planEntryContentPreview(entry: Record<string, unknown>, maxLength: number): string | null {
  const content = nonEmptyString(entry.content) ?? nonEmptyString(entry.title);
  if (content) return preview(content, maxLength);
  const fallback = preview(entry, maxLength);
  return fallback.length > 0 ? fallback : null;
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
    const status = normalizedPlanStatus(nonEmptyString(entry.status));
    counts.set(status, (counts.get(status) ?? 0) + 1);
    if (status === "in_progress") {
      const content = planEntryContentPreview(entry, 240);
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
    case "permission.requested": {
      const requestedOptionIds = event.request.options.map((option) => option.optionId);
      const message = `Host Hermes ACP permission requested for ${event.request.requestKind}`;
      const payload = {
        acpJsonRpcRequestId: event.jsonRpcRequestId,
        requestedOptionIds,
        requestKind: event.request.requestKind,
        toolCallId: event.request.toolCallId,
        outcome: "pending",
        selectedOptionId: null,
        reason: "permission_requested",
        acpSessionId: event.request.sessionId,
        paramsPreview: preview(event.request.params, 500),
        redacted: true,
      };
      return [
        mappedAgentEvent(
          { type: "progress", activitySource: "tool", message },
          {
            actor: "runtime",
            channel: "diagnostic",
            kind: "runtime_status_update",
            text: message,
            payload: { ...payload, status: "permission_requested" },
          },
        ),
      ];
    }
    case "permission.resolved": {
      const resolution = event.resolution;
      const decision = resolution.policyDecision;
      if (!decision) {
        throw new Error("Hermes ACP permission resolution was missing a structured policyDecision payload");
      }
      const message = permissionResolutionSummary(decision);
      const permissionOutcome = permissionResolutionPermissionOutcome(resolution, decision);
      const eventPayload = {
        outcome: decision.outcome,
        reasonKind: decision.reasonKind,
        requestKind: resolution.request.requestKind,
        toolCallId: resolution.request.toolCallId,
        permissionOutcome,
        hookAction: null,
        ...(decision.outcome === "allow" ? { selectedOptionId: resolution.selectedOptionId } : {}),
        redacted: true,
      };
      return [
        mappedAgentEvent(
          {
            type: "run_diagnostic",
            code: "command_policy_decision",
            message,
            payload: eventPayload,
          },
          {
            actor: "runtime",
            channel: "diagnostic",
            kind: "command_policy_decision",
            text: message,
            payload: permissionResolutionRunActivityPayload(resolution, decision),
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

const ACP_ALLOW_PERMISSION_OPTION_IDS = new Set<string>(["allow_once", "allow_session", "allow_always"]);
const ACP_FAIL_CLOSED_REASON_KINDS = new Set<AgentCommandPolicyDecision["reasonKind"]>([
  "run_cancelled",
  "permission_bridge_not_configured",
  "permission_bridge_error",
  "permission_request_timeout",
  "acp_process_exited",
  "malformed_permission_request",
  "missing_permission_session_id",
  "missing_permission_tool_call",
  "missing_permission_tool_call_kind",
  "missing_permission_tool_call_id",
  "missing_permission_tool_call_content",
  "missing_permission_options",
  "malformed_permission_options",
  "duplicate_permission_options",
  "unsupported_permission_tool_call",
  "unsupported_permission_options",
  "permission_option_not_offered",
  "permission_option_not_supported",
  "classifier_error",
  "file_edit_approval_bridge_not_configured",
  "file_edit_approval_error",
  "missing_file_edit_diff",
  "malformed_file_edit_diff",
  "file_edit_diff_too_large",
  "invalid_file_edit_path",
  "file_edit_path_outside_workspace",
  "file_edit_target_path_mismatch",
  "missing_file_edit_workspace",
  "unsupported_agent_command_policy_permission_kind",
  "unsupported_agent_command_policy_acp_allow_option",
]);

function finalizePermissionResolution(
  ctx: AgentRunContext,
  runId: string,
  resolution: HermesAcpPermissionResolution,
): HermesAcpPermissionResolution {
  const issueId = nonEmptyString(ctx.issue.id) ?? nonEmptyString(ctx.issue.identifier);
  return {
    ...resolution,
    runId,
    issueId,
    policyDecision: resolution.policyDecision ?? fallbackPermissionPolicyDecision(ctx, resolution),
  };
}

function fallbackPermissionPolicyDecision(
  ctx: AgentRunContext,
  resolution: HermesAcpPermissionResolution,
): AgentCommandPolicyDecision {
  const outcome = permissionResolutionOutcome(resolution);
  const reasonKind = permissionResolutionReasonKind(resolution.reason, outcome, resolution.request.requestKind);
  const commandClass = permissionResolutionCommandClass(reasonKind, outcome, resolution.request.requestKind);
  return {
    attemptId: resolution.request.toolCallId,
    outcome,
    reasonKind,
    commandClass,
    message: permissionResolutionMessage(reasonKind, outcome, resolution.request.requestKind),
    requiresCodeChange: false,
    requiresUserOrServiceFix: permissionResolutionRequiresUserOrServiceFix(reasonKind),
    audit: {
      redacted: true,
      surface: resolution.request.requestKind,
      role: ctx.role,
      phase: ctx.runPhase ?? (ctx.role === "reviewer" ? "review" : "implementation"),
      commandClass,
      inlineEnvironmentKeys: [],
      unsafeConfigCategories: [],
      upstreamContactAttempted: false,
      outcome,
      reasonKind,
    },
  };
}

function permissionResolutionOutcome(resolution: HermesAcpPermissionResolution): AgentCommandPolicyDecision["outcome"] {
  if (resolution.policyDecision) return resolution.policyDecision.outcome;
  if (resolution.outcome === "selected" && resolution.selectedOptionId && ACP_ALLOW_PERMISSION_OPTION_IDS.has(resolution.selectedOptionId)) {
    return "allow";
  }
  return "deny";
}

function permissionResolutionReasonKind(
  reason: string,
  outcome: AgentCommandPolicyDecision["outcome"],
  requestKind: HermesAcpPermissionRequest["requestKind"],
): AgentCommandPolicyDecision["reasonKind"] {
  switch (reason) {
    case "harness_dispose":
      return "run_cancelled";
    case "permission_bridge_not_configured":
    case "permission_bridge_error":
    case "permission_request_timeout":
    case "run_cancelled":
    case "acp_process_exited":
    case "malformed_permission_request":
    case "missing_permission_session_id":
    case "missing_permission_tool_call":
    case "missing_permission_tool_call_kind":
    case "missing_permission_tool_call_id":
    case "missing_permission_tool_call_content":
    case "missing_permission_options":
    case "malformed_permission_options":
    case "duplicate_permission_options":
    case "unsupported_permission_tool_call":
    case "unsupported_permission_options":
    case "permission_option_not_offered":
    case "permission_option_not_supported":
    case "permission_option_selected":
    case "no_permission_policy":
    case "classifier_error":
    case "file_edit_permission_allowed":
    case "file_edit_permission_denied":
    case "file_edit_approval_bridge_not_configured":
    case "file_edit_approval_error":
    case "missing_file_edit_diff":
    case "malformed_file_edit_diff":
    case "file_edit_diff_too_large":
    case "invalid_file_edit_path":
    case "file_edit_path_outside_workspace":
    case "file_edit_target_path_mismatch":
    case "missing_file_edit_workspace":
    case "unsupported_agent_command_policy_permission_kind":
    case "unsupported_agent_command_policy_acp_allow_option":
      return reason;
    default:
      return requestKind === "file_edit"
        ? outcome === "allow"
          ? "file_edit_permission_allowed"
          : "file_edit_permission_denied"
        : outcome === "allow"
          ? "permission_option_selected"
          : "no_permission_policy";
  }
}

function permissionResolutionCommandClass(
  reasonKind: AgentCommandPolicyDecision["reasonKind"],
  outcome: AgentCommandPolicyDecision["outcome"],
  requestKind: HermesAcpPermissionRequest["requestKind"],
): string {
  if (requestKind === "file_edit") {
    switch (reasonKind) {
      case "file_edit_permission_allowed":
        return "acp_file_edit_permission_allowed";
      case "file_edit_permission_denied":
        return "acp_file_edit_permission_denied";
      case "file_edit_approval_bridge_not_configured":
      case "file_edit_approval_error":
        return "acp_file_edit_approval_bridge";
      default:
        return "acp_file_edit_permission_validation";
    }
  }
  switch (reasonKind) {
    case "permission_bridge_not_configured":
    case "permission_bridge_error":
      return "acp_permission_bridge";
    case "permission_request_timeout":
      return "acp_permission_timeout";
    case "classifier_error":
      return "agent_command_policy_classifier_error";
    case "run_cancelled":
      return "acp_permission_cancelled";
    case "acp_process_exited":
      return "acp_process_exit";
    case "permission_option_selected":
      return outcome === "allow" ? "acp_permission_allowed" : "acp_permission_denied";
    default:
      return "acp_permission_validation";
  }
}

function permissionResolutionMessage(
  reasonKind: AgentCommandPolicyDecision["reasonKind"],
  outcome: AgentCommandPolicyDecision["outcome"],
  requestKind: HermesAcpPermissionRequest["requestKind"],
): string {
  if (requestKind === "file_edit") {
    switch (reasonKind) {
      case "file_edit_permission_allowed":
        return "Allowed ACP file-edit request after Symphony review.";
      case "file_edit_permission_denied":
        return "Denied ACP file-edit request during Symphony review.";
      case "file_edit_approval_bridge_not_configured":
        return "Blocked ACP file-edit request because the Symphony file-edit approval bridge is not configured.";
      case "file_edit_approval_error":
        return "Blocked ACP file-edit request because the Symphony file-edit approval bridge failed closed.";
      case "missing_file_edit_diff":
        return "Blocked ACP file-edit request because it did not include an auditable diff.";
      case "malformed_file_edit_diff":
        return "Blocked ACP file-edit request because the presented diff was malformed.";
      case "file_edit_diff_too_large":
        return "Blocked ACP file-edit request because the presented diff exceeded the allowed audit size.";
      case "invalid_file_edit_path":
        return "Blocked ACP file-edit request because the edited path was invalid.";
      case "file_edit_path_outside_workspace":
        return "Blocked ACP file-edit request because the edited path was outside the workspace.";
      case "file_edit_target_path_mismatch":
        return "Blocked ACP file-edit request because the displayed diff did not match the raw file-edit target paths.";
      case "missing_file_edit_workspace":
        return "Blocked ACP file-edit request because the workspace context was incomplete.";
      default:
        return outcome === "allow"
          ? "Allowed ACP file-edit request after Symphony review."
          : "Blocked ACP file-edit request because it could not be audited safely.";
    }
  }
  switch (reasonKind) {
    case "permission_option_selected":
      return outcome === "allow"
        ? "Allowed ACP permission request via explicit resolver selection."
        : "Denied ACP permission request via explicit resolver selection.";
    case "permission_bridge_not_configured":
      return "Blocked ACP permission request because the Symphony permission bridge is not configured.";
    case "permission_bridge_error":
      return "Blocked ACP permission request because the Symphony permission bridge failed closed.";
    case "permission_request_timeout":
      return "Blocked ACP permission request because the Symphony permission bridge timed out.";
    case "classifier_error":
      return "Blocked ACP permission request because the Symphony agent command policy classifier failed closed.";
    case "run_cancelled":
      return "Blocked ACP permission request because the active Symphony run was cancelled.";
    case "acp_process_exited":
      return "Blocked ACP permission request because the Host Hermes ACP process exited before permission resolution completed.";
    default:
      return outcome === "allow"
        ? "Allowed ACP permission request after Symphony review."
        : "Blocked ACP permission request because it could not be audited safely.";
  }
}

function permissionResolutionRequiresUserOrServiceFix(reasonKind: AgentCommandPolicyDecision["reasonKind"]): boolean {
  return (
    reasonKind === "permission_bridge_not_configured" ||
    reasonKind === "permission_bridge_error" ||
    reasonKind === "permission_request_timeout" ||
    reasonKind === "classifier_error" ||
    reasonKind === "acp_process_exited"
  );
}

function permissionResolutionSummary(decision: AgentCommandPolicyDecision): string {
  return `Command policy ${decision.outcome}: ${decision.reasonKind} (${decision.audit.role} · ${decision.audit.phase} · ${decision.audit.surface})`;
}

function permissionResolutionRunActivityPayload(
  resolution: HermesAcpPermissionResolution,
  decision: AgentCommandPolicyDecision,
): RunActivityCommandPolicyDecisionPayload {
  const permissionOutcome = permissionResolutionPermissionOutcome(resolution, decision);
  return {
    decisionId: decision.decisionId ?? null,
    attemptId: decision.attemptId ?? resolution.request.toolCallId ?? null,
    runId: resolution.runId ?? null,
    issueId: resolution.issueId ?? null,
    surface: decision.audit.surface,
    role: decision.audit.role,
    phase: decision.audit.phase,
    outcome: decision.outcome,
    reasonKind: decision.reasonKind,
    commandClass: decision.commandClass,
    message: decision.message,
    upstreamContactAttempted: decision.audit.upstreamContactAttempted,
    ...(decision.requiresCodeChange === undefined ? {} : { requiresCodeChange: decision.requiresCodeChange }),
    ...(decision.requiresUserOrServiceFix === undefined
      ? {}
      : { requiresUserOrServiceFix: decision.requiresUserOrServiceFix }),
    ...(decision.normalizedCommand === undefined ? {} : { normalizedCommand: decision.normalizedCommand }),
    audit: decision.audit,
    requestKind: resolution.request.requestKind,
    toolCallId: resolution.request.toolCallId,
    ...(decision.outcome === "allow" ? { selectedOptionId: resolution.selectedOptionId } : {}),
    permissionOutcome,
    hookAction: null,
    redacted: true,
  };
}

function permissionResolutionPermissionOutcome(
  resolution: HermesAcpPermissionResolution,
  decision: AgentCommandPolicyDecision,
): "allowed" | "denied" | "fail_closed" {
  if (decision.outcome === "allow") return "allowed";
  if (resolution.selectedOptionId === null && ACP_FAIL_CLOSED_REASON_KINDS.has(decision.reasonKind)) return "fail_closed";
  return "denied";
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

function hermesAcpPermissionAbort(reason: string): HermesAcpPermissionAbort {
  return { type: PERMISSION_ABORTED, reason };
}

function isHermesAcpPermissionAbort(value: unknown): value is HermesAcpPermissionAbort {
  return isRecord(value) && value.type === PERMISSION_ABORTED && typeof value.reason === "string";
}

function hermesAcpJsonRpcIdKey(id: HostHermesAcpJsonRpcRequest["id"]): string {
  return `${typeof id}:${String(id)}`;
}

class HermesAcpTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HermesAcpTimeoutError";
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new HermesAcpTimeoutError(`${message} after ${timeoutMs}ms.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function preview(value: unknown, maxLength: number): string {
  return sanitizedPreviewValue(value, maxLength).preview ?? "";
}

function previewDelta(value: unknown, maxLength: number): string {
  return redactTextPreserveFormatting(value, maxLength).text ?? "";
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

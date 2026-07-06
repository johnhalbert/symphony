import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs, type Stats } from "node:fs";
import type { Orchestrator } from "../core/orchestrator/Orchestrator.js";
import type { WorkspaceIssueInput, WorkspaceManager } from "../core/workspace/WorkspaceManager.js";
import type { WorkspaceOpener } from "./WorkspaceOpener.js";
import {
  LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
  normalizeProjectContextId,
  normalizeProjectContextResolution,
  projectContextResolutionFromIssue,
  type ProjectContextResolution,
} from "../core/config/ProjectContexts.js";
import { SymphonyError, errorMessage } from "../core/errors.js";
import {
  projectActivityModels,
  formatAgentUsageLabel,
  projectProviderGates,
  projectRunningAgents,
  projectSessionModel,
  projectTranscriptMessages,
  projectWebDashboard,
  projectWebIssueBoard,
  projectWebIssueDetail,
  projectWebOrchestratorChat,
  projectWebOrchestratorChatPost,
  projectWebReferenceData,
  projectWebSidebar,
  type ChatMessage,
  type DashboardRuntimeConfig,
  type DashboardSourceProjectionInput,
  type IssueModel,
  type WebIssueBoardModel,
  type WebIssueDetailModel,
} from "./webProjection.js";
import {
  runKindForPhase,
  toIssueStatusView,
  type AgentRunKind,
  type AgentRunPhase,
  type AgentRunRole,
  type Issue,
  type IssueBoardColumnId,
  type IssueBoardColumnMapping,
  type IssueRouteEvidence,
  type IssueRouteEvidenceSource,
} from "../core/types.js";
import type {
  IssueCompletionReportRecord,
  IssueLifecycleRecord,
  IssueLifecycleStore,
  IssueMergeConflictMetadata,
  IssueMergeGateMergeabilityState,
  IssueReviewVerdictRecord,
} from "../core/persistence/IssueLifecycleStore.js";
import { latestCurrentApprovalPassVerdict } from "../core/persistence/IssueLifecycleStore.js";
import type { FileMcpExposureDiagnosticsStore } from "../core/persistence/McpExposureDiagnosticsStore.js";
import type { OperatorApprovalService, OperatorApprovalRecord } from "../core/approval/OperatorApprovalService.js";
import { OPERATOR_REJECTED_PUBLICATION_ERROR, approvalResolve } from "../core/approval/OperatorApprovalService.js";
import {
  approvalMatchesReport,
  isAwaitingPublicationApprovalLifecycle,
  isPendingPublicationApprovalLifecycle,
  pendingPublicationReport,
} from "../core/CompletionReportService.js";
import { sanitizeInactiveMergeGateLifecycle, sanitizeStaleMergeGateLifecycle } from "../core/merge/MergeGateLifecycle.js";
import {
  compareRunChronology,
  type RunRecord,
  type RunTranscriptStore,
  type TranscriptPage,
  type TranscriptEvent,
  type WorkspaceRecord,
} from "../core/persistence/RunTranscriptStore.js";
import type {
  RunActivityEventsPage,
  RunActivityEventSourceStore,
} from "../core/persistence/RunActivityAppendStore.js";
import { mapRunActivityEventToTranscriptEvent } from "../core/transcript/RunActivityEventMapper.js";
import {
  ISSUE_BREAKDOWN_PLAN_STALE_REASON,
  ISSUE_BREAKDOWN_WRITEBACK_NOT_CURRENT_REASON,
  issueBreakdownPlanIdForOperation,
  type FileWritebackOutboxStore,
  type WritebackOperation,
  writebackIdentityKey,
} from "../core/writeback/WritebackOutbox.js";
import type { TrackerClient } from "../core/tracker/TrackerClient.js";
import { sanitizedPreviewValue, sanitizeCommandPolicyReplayStateForPublicOutput, sanitizePublicJson } from "../core/transcript/TranscriptProjection.js";
import {
  DEFAULT_ORCHESTRATOR_CONVERSATION_ID,
  type OrchestratorConversationMessage,
  type OrchestratorConversationStatus,
  type OrchestratorConversationStore,
} from "../core/persistence/OrchestratorConversationStore.js";
import {
  ORCHESTRATOR_CHAT_PROJECTION_SCHEMA_VERSION,
  ORCHESTRATOR_CHAT_PROJECTION_SOURCE,
  projectOrchestratorChatProjectionPayload,
  type OrchestratorChatProjectionPayload,
  type OrchestratorChatProjectionState,
  type OrchestratorChatProjectionStatusCounts,
} from "../core/persistence/OrchestratorChatProjectionReducer.js";
import {
  ORCHESTRATOR_CHAT_POST_ACTION,
  type OrchestratorChatCommandDispatcher,
  type OrchestratorChatCommandResult,
  type OrchestratorChatCommandResultStatus,
} from "../core/orchestrator/OrchestratorChatCommand.js";

import {
  applyWebHistoryRuntimeLiveness,
  isWebHistoryProjectionPayloadCurrent,
  isWebHistorySessionListCurrent,
  projectWebHistory,
} from "./WebHistoryProjection.js";
import {
  applyWebTranscriptProjectContextAttribution,
  emptyWebTranscriptProjectionPayload,
  isWebTranscriptProjectionPayload,
  projectRunProjectContext,
  projectWebTranscript,
  projectWebTranscriptProjectContext,
  projectWebTranscriptWindow,
  type TranscriptMessage as WebTranscriptMessage,
  type WebTranscriptProjectionPayload,
} from "./WebTranscriptProjection.js";
import {
  buildWebProjectionSourceIndex,
  createWebProjectionCacheMetadata,
  createWebProjectionFingerprint,
  defaultWebProjectionIssueBoardColumns,
  isWebProjectionContextExpired,
  isWebProjectionRefreshRequested,
  webProjectionIssueKeyAliases,
  webProjectionFingerprintCacheKey,
  webProjectionIssueBoardFetchStates,
  type BuiltWebProjectionSourceIndex,
  type WebProjectionCacheFingerprint,
  type WebProjectionCacheMetadata,
  type WebProjectionClock,
  type WebProjectionContext,
  type WebProjectionRevisionListener,
  type WebProjectionRevisionProvider,
  type WebProjectionRevisionUnsubscribe,
  type WebProjectionSourceRevision,
} from "./WebProjectionContext.js";
import { RealtimeProjectionEventBus, type RealtimeResourceKind } from "./RealtimeProjectionEvents.js";
import {
  compatibleProjectionRevisionSelectors,
  createWebProjectionReadRepositories,
  webHistoryProjectionScopeKey,
  webOrchestratorChatProjectionScopeKey,
  webTranscriptProjectionScopeKey,
  type WebProjectionPayloadReader,
  type WebProjectionReadRepositories,
  type WebProjectionReadResult,
  type WebTranscriptProjectionPageSelector,
} from "./WebProjectionRepository.js";
import {
  DURABLE_PROJECTION_NAMES,
  type DurableProjectionName,
  type ProjectionBuildMode,
  type ProjectionPayloadRecord,
  type ProjectionPayloadWriteInput,
  type ProjectionRevisionPublication,
  type ProjectionRevisionRecord,
  type ProjectionRevisionSelector,
  type ProjectionSourceRevision,
  type ProjectionWriteMode,
  type ProjectionWriteResult,
} from "../core/persistence/ProjectionTransactionService.js";
import type { ProjectionSourceFreshness, ProjectionSourceFreshnessInput } from "../core/persistence/ProjectionSourceFreshness.js";
import type {
  IssueBlockerRef,
  IssueDetailsEnvelope,
  IssueLatestRunSummary,
  IssueMergeGateSummary,
  IssuePullRequestSummary,
  IssueStateClassification,
  IssueStatusView,
  IssueTrackerMetadata,
  IssueWorkspaceSummary,
  RunTerminalReason,
  TrackerStateLists,
} from "../core/types.js";

export const WEB_PROJECTION_CONTEXT_TTL_MS = 5_000;

export type StatusServerWebProjectionContext = WebProjectionContext<BuiltWebProjectionSourceIndex, Record<string, unknown>>;

type StatusServerWritebackOutbox = Pick<FileWritebackOutboxStore, "list"> &
  Partial<Pick<FileWritebackOutboxStore, "projectionRevision" | "onProjectionChanged">>;

interface StatusServerProjectionRevisionStore {
  projectionRevision(): number;
  onProjectionChanged(listener: (event: { source: string; revision: number; detail?: Readonly<Record<string, unknown>> | null }) => void): () => void;
}

export interface StatusServerProjectionWriter {
  writeProjection(input: ProjectionPayloadWriteInput): Promise<ProjectionWriteResult>;
  onProjectionChanged?(listener: (event: ProjectionRevisionPublication) => void): () => void;
}

export interface StatusServerProjectionReader extends WebProjectionPayloadReader {
  readCurrentRevision?(selector: ProjectionRevisionSelector): Promise<ProjectionRevisionRecord | null>;
}

export type StatusServerProjectionRebuildEntryStatus = ProjectionWriteResult["status"] | "skipped" | "failed";

export interface StatusServerProjectionRebuildOptions {
  /** Rebuild from a fresh source-index snapshot instead of any completed in-memory context. */
  forceRefresh?: boolean;
  /** Durable projection names to rebuild. Omit to rebuild every supported web projection. */
  projections?: readonly DurableProjectionName[];
  /** Collection limits for the canonical global history projection scope. */
  historyLimits?: Partial<{ sessionLimit: number; timelineLimit: number }>;
  /** Transcript events per durable page. Values are clamped to the route-level max page size. */
  transcriptPageLimit?: number;
  /** Orchestrator conversation scopes to rebuild. Defaults to the canonical web conversation. */
  conversationIds?: readonly string[];
}

export interface StatusServerProjectionRebuildEntry {
  projectionName: DurableProjectionName;
  scopeKind: string;
  scopeKey: string;
  status: StatusServerProjectionRebuildEntryStatus;
  revision: number | null;
  /** `rebuild` for explicit rebuild/backfill write inputs; absent for skips before a projection write input exists. */
  requestedBuildMode?: ProjectionWriteMode | null;
  /** Durable build mode for the revision returned by the writer; first writes are `bootstrap`. */
  buildMode?: ProjectionBuildMode | null;
  reason: string | null;
}

export interface StatusServerProjectionRebuildResult {
  generatedAt: string;
  sourceRevisions: readonly ProjectionSourceRevision[];
  entries: readonly StatusServerProjectionRebuildEntry[];
  attempted: number;
  written: number;
  unchanged: number;
  skipped: number;
  failed: number;
}

export interface StatusServerWebProjectionContextBuildInput {
  metadata: WebProjectionCacheMetadata;
  fingerprint: WebProjectionCacheFingerprint;
  forceRefresh: boolean;
  snapshot: ReturnType<Orchestrator["snapshot"]>;
  issueBoardColumns: IssueBoardColumnMapping;
  clock: WebProjectionClock;
}

export type StatusServerWebProjectionContextBuilder = (
  input: StatusServerWebProjectionContextBuildInput,
) => StatusServerWebProjectionContext | Promise<StatusServerWebProjectionContext>;

interface StatusServerWebProjectionContextAcquireResult {
  context: StatusServerWebProjectionContext;
  reusedCompleted: boolean;
}

interface WebProjectionEventClient {
  id: number;
  response: ServerResponse;
}

interface WebProjectionJsonResponse<TBody> {
  body: TBody;
  headers?: Record<string, string>;
}

type WebOrchestratorChatPostResult = {
  status: number;
  body: unknown;
  stateChanged: boolean;
};

type DurableProjectionReadResult<TPayload> = WebProjectionReadResult<TPayload>;

export interface StatusServerRealtimeOptions {
  enabled?: boolean;
  keepAliveIntervalMs?: number;
}

export interface StatusServerOptions {
  orchestrator: Orchestrator;
  workspaceManager: WorkspaceManager;
  workspaceOpener: WorkspaceOpener;
  defaultProjectContextId?: string | null | undefined;
  runStore?: RunTranscriptStore;
  runActivitySourceStore?: RunActivityEventSourceStore;
  orchestratorConversationStore?: OrchestratorConversationStore;
  lifecycleStore?: IssueLifecycleStore;
  mcpExposureDiagnosticsStore?: FileMcpExposureDiagnosticsStore;
  writebackOutbox?: StatusServerWritebackOutbox;
  operatorApproval?: Pick<
    OperatorApprovalService,
    "get" | "resolve" | "findPendingForIssue" | "findPendingForRun" | "rejectPolicy" | "isRequired"
  >;
  host: string;
  port: number;
  openWorkspaceToken: string | null;
  tracker?: TrackerClient;
  trackerStateLists: TrackerStateLists;
  issueBoardColumns?: IssueBoardColumnMapping;
  staleThresholdMs: number;
  dashboard?: DashboardRuntimeConfig | undefined;
  /**
   * Absolute root of the generated React web bundle, normally `web/dist`.
   * Undefined or blank values default to `process.cwd()/web/dist`; null disables static serving.
   */
  webAssetsRoot?: string | null | undefined;
  webProjectionContextClock?: WebProjectionClock;
  webProjectionContextBuilder?: StatusServerWebProjectionContextBuilder;
  webProjectionRevisionProviders?: readonly WebProjectionRevisionProvider[];
  projectionWriter?: StatusServerProjectionWriter;
  projectionReader?: StatusServerProjectionReader;
  realtime?: StatusServerRealtimeOptions;
}

export class StatusServer {
  private server: http.Server | null = null;
  private issueBoardTrackerCache: IssueBoardTrackerCache | null = null;
  private completedWebProjectionContext: StatusServerWebProjectionContext | null = null;
  private readonly pendingWebProjectionContexts = new Map<string, Promise<StatusServerWebProjectionContext>>();
  private readonly webAssetsRoot: string | null;
  private readonly webProjectionRevisionProviders: readonly WebProjectionRevisionProvider[];
  private readonly webProjectionRepositories: WebProjectionReadRepositories;
  private readonly webProjectionRevisionUnsubscribes: WebProjectionRevisionUnsubscribe[] = [];
  private readonly realtimeEvents = new RealtimeProjectionEventBus();
  private readonly webProjectionEventClients = new Map<number, WebProjectionEventClient>();
  private readonly pendingWebOrchestratorChatMessagePosts = new Map<string, Promise<unknown>>();
  private lastPublishedTrackerSourceStatusKey: string | null = null;
  private trackerSourceStatusRevision = 0;
  private nextWebProjectionEventClientId = 1;
  private webProjectionDirtyGeneration = 0;

  constructor(private readonly options: StatusServerOptions) {
    this.webAssetsRoot = resolveWebAssetsRootOption(options.webAssetsRoot);
    this.webProjectionRevisionProviders = createStatusServerWebProjectionRevisionProviders(options);
    this.webProjectionRepositories = createWebProjectionReadRepositories({
      ...(options.projectionReader ? { reader: options.projectionReader } : {}),
      isRecordCurrent: (record) => this.isDurableProjectionRecordCurrent(record),
      resolveDefaultProjectContextId: () => this.options.defaultProjectContextId,
    });
  }

  setDefaultProjectContextId(defaultProjectContextId: string | null | undefined): void {
    this.options.defaultProjectContextId = defaultProjectContextId;
  }

  async start(): Promise<{ host: string; port: number }> {
    if (this.server) {
      this.registerWebProjectionRevisionListeners();
      const address = this.server.address();
      return typeof address === "object" && address
        ? { host: address.address, port: address.port }
        : { host: this.options.host, port: this.options.port };
    }
    this.server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve) => {
      this.server?.listen(this.options.port, this.options.host, resolve);
    });
    this.registerWebProjectionRevisionListeners();
    const address = this.server.address();
    if (typeof address === "object" && address) return { host: address.address, port: address.port };
    return { host: this.options.host, port: this.options.port };
  }

  async stop(): Promise<void> {
    this.realtimeEvents.closeAllStreams();
    if (!this.server) {
      this.unsubscribeWebProjectionRevisionListeners();
      return;
    }
    const server = this.server;
    this.server = null;
    this.closeWebProjectionEventClients();
    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    } finally {
      this.unsubscribeWebProjectionRevisionListeners();
    }
  }

  activeRealtimeSubscriberCount(): number {
    return this.realtimeEvents.subscriberCount();
  }

  private registerWebProjectionRevisionListeners(): void {
    if (this.webProjectionRevisionUnsubscribes.length > 0) return;
    const projectionPublicationUnsubscribe = this.subscribeProjectionPublicationEvents();
    if (projectionPublicationUnsubscribe) this.webProjectionRevisionUnsubscribes.push(projectionPublicationUnsubscribe);
    for (const provider of this.webProjectionRevisionProviders) {
      if (!provider.subscribe) continue;
      const unsubscribe = provider.subscribe((revision) => {
        this.markCompletedWebProjectionContextDirty(revision);
        this.realtimeEvents.publishProjectionRevision(revision);
      });
      this.webProjectionRevisionUnsubscribes.push(unsubscribe);
    }
  }

  private subscribeProjectionPublicationEvents(): WebProjectionRevisionUnsubscribe | null {
    const writer = this.options.projectionWriter;
    if (!writer || typeof writer.onProjectionChanged !== "function") return null;
    return writer.onProjectionChanged((publication) => {
      const revision = webProjectionSourceRevisionFromProjectionPublication(publication);
      this.publishWebProjectionRevision(revision);
      this.realtimeEvents.publishProjectionRevision(revision);
    });
  }

  private unsubscribeWebProjectionRevisionListeners(): void {
    while (this.webProjectionRevisionUnsubscribes.length > 0) {
      const unsubscribe = this.webProjectionRevisionUnsubscribes.pop();
      try {
        unsubscribe?.();
      } catch {
        // Projection invalidation cleanup is best-effort; stop should still close the status server.
      }
    }
  }

  private markCompletedWebProjectionContextDirty(revision: WebProjectionSourceRevision): void {
    this.completedWebProjectionContext = null;
    this.publishWebProjectionRevision(revision);
  }

  private publishWebProjectionRevision(revision: WebProjectionSourceRevision): void {
    this.webProjectionDirtyGeneration += 1;
    this.broadcastWebProjectionRevision(revision);
  }

  private handleWebProjectionEvents(request: IncomingMessage, response: ServerResponse): void {
    const clientId = this.nextWebProjectionEventClientId;
    this.nextWebProjectionEventClientId += 1;
    const client: WebProjectionEventClient = { id: clientId, response };
    this.webProjectionEventClients.set(clientId, client);

    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    writeWebProjectionSseEvent(response, "projection_ready", {
      type: "projection_ready",
      generation: this.webProjectionDirtyGeneration,
    });

    const unsubscribe = (): void => {
      this.webProjectionEventClients.delete(clientId);
    };
    request.on("close", unsubscribe);
    response.on("close", unsubscribe);
  }

  private broadcastWebProjectionRevision(revision: WebProjectionSourceRevision): void {
    const eventId = String(this.webProjectionDirtyGeneration);
    const payload = {
      type: "projection_revision",
      generation: this.webProjectionDirtyGeneration,
      source: revision.source,
      revision: revision.revision,
      observedAt: revision.observedAt,
    };
    for (const client of Array.from(this.webProjectionEventClients.values())) {
      try {
        writeWebProjectionSseEvent(client.response, "projection_revision", payload, eventId);
      } catch {
        this.webProjectionEventClients.delete(client.id);
      }
    }
  }

  private closeWebProjectionEventClients(): void {
    for (const client of Array.from(this.webProjectionEventClients.values())) {
      try {
        writeWebProjectionSseEvent(client.response, "projection_closed", { type: "projection_closed" });
        client.response.end();
      } catch {
        // Closing the status server should not fail because an SSE client has already disconnected.
      }
      this.webProjectionEventClients.delete(client.id);
    }
  }

  private publishTrackerSourceStatusIfChanged(sourceIndex: BuiltWebProjectionSourceIndex): void {
    const trackerIssues = sourceIndex.trackerIssues;
    const statusKey = trackerSourceStatusKey(trackerIssues);
    if (statusKey === this.lastPublishedTrackerSourceStatusKey) return;
    this.lastPublishedTrackerSourceStatusKey = statusKey;
    this.trackerSourceStatusRevision += 1;
    this.realtimeEvents.publish({
      type: "source.status",
      source: {
        source: "trackerIssues",
        revision: this.trackerSourceStatusRevision,
        observedAt: trackerIssues.fetchedAt,
      },
      detail: {
        source: "trackerIssues",
        status: trackerIssues.status,
        fetchedStates: trackerIssues.fetchedStates,
        fetchedAt: trackerIssues.fetchedAt,
        cached: trackerIssues.cached,
        error: trackerIssues.error
          ? { code: trackerIssues.error.code, message: trackerIssues.error.message }
          : null,
        issueCount: trackerIssues.issues.length,
      },
    });
  }

  private handleRealtime(request: IncomingMessage, response: ServerResponse, url: URL): void {
    if (this.options.realtime?.enabled === false) {
      sendJson(response, 503, {
        error: {
          code: "realtime_unavailable",
          message: "Realtime event stream is unavailable",
        },
      });
      return;
    }

    const keepAliveIntervalMs = this.options.realtime?.keepAliveIntervalMs;
    const stream = this.realtimeEvents.openSseStream({
      response,
      lastEventId: realtimeLastEventId(request, url),
      ...(keepAliveIntervalMs === undefined ? {} : { keepAliveIntervalMs }),
    });
    const close = (): void => stream.close();
    request.on("aborted", close);
    response.on("close", close);
    response.on("error", close);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (request.method === "GET" && url.pathname === "/") {
        const snapshot = publicRuntimeSnapshot(this.options.orchestrator.snapshot());
        sendHtml(
          response,
          await renderDashboard(
            snapshot,
            Boolean(this.options.openWorkspaceToken),
            this.options.runStore,
            this.options.lifecycleStore,
            this.options.trackerStateLists,
            this.options.staleThresholdMs,
          ),
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/web/events") {
        this.handleWebProjectionEvents(request, response);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/web/projections/rebuild") {
        this.requireMutationToken(request);
        let rebuildOptions: StatusServerProjectionRebuildOptions;
        try {
          rebuildOptions = parseStatusServerProjectionRebuildOptions(url);
        } catch (error) {
          if (error instanceof SymphonyError && error.code === "invalid_request") {
            sendJson(response, 400, { error: { code: error.code, message: errorMessage(error) } });
            return;
          }
          throw error;
        }
        sendJson(response, 200, await this.rebuildDurableWebProjections(rebuildOptions));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/state") {
        const snapshot = publicRuntimeSnapshot(this.options.orchestrator.snapshot());
        sendJson(response, 200, {
          ...snapshot,
          operatorView: await operatorSnapshotView(
            snapshot,
            Boolean(this.options.openWorkspaceToken),
            this.options.runStore,
            this.options.lifecycleStore,
            this.options.trackerStateLists,
            this.options.staleThresholdMs,
          ),
          operatorLivenessContract: OPERATOR_LIVENESS_CONTRACT,
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/realtime") {
        this.handleRealtime(request, response, url);
        return;
      }
      const webIssueMatch = /^\/api\/v1\/web\/issues\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && webIssueMatch) {
        const issueId = decodeURIComponent(webIssueMatch[1] ?? "");
        const detail = await this.fetchWebIssueDetail(
          issueId,
          isWebProjectionRefreshRequested(url.searchParams.get("refresh")),
          {
            includeTranscript: parseBooleanWebQueryParam(url.searchParams, "includeTranscript"),
            transcriptUrl: url,
          },
        );
        sendJson(response, 200, detail.body, detail.headers);
        return;
      }
      const boardIssueMatch = /^\/api\/v1\/board\/issues\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && boardIssueMatch) {
        const issueId = decodeURIComponent(boardIssueMatch[1] ?? "");
        const detail = await this.fetchBoardIssueDetail(
          issueId,
          isWebProjectionRefreshRequested(url.searchParams.get("refresh")),
        );
        sendJson(response, 200, detail);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/v1/web/reference-data") {
        const forceRefresh = isWebProjectionRefreshRequested(url.searchParams.get("refresh"));
        const durableIssues = await this.webProjectionRepositories.issueBoard.readDefaultBoard({ forceRefresh });
        if (durableIssues.status === "hit" && durableIssues.record) {
          sendJson(response, 200, projectWebReferenceData(durableIssues.record.payload), durableProjectionReadHeaders(durableIssues));
          return;
        }
        if (this.shouldReturnDurableProjectionFallback(forceRefresh)) {
          sendJson(response, 200, projectWebReferenceData(null), durableProjectionReadHeaders(durableIssues));
          return;
        }
        let board: IssueBoardResponse | null = null;
        let projection: { sourceIndex: BuiltWebProjectionSourceIndex; issueBoardColumns: IssueBoardColumnMapping } | null = null;
        try {
          projection = await this.fetchWebProjectionSourceIndex(forceRefresh);
          board = await this.buildIssueBoardFromSourceIndex(projection.sourceIndex, projection.issueBoardColumns);
        } catch (error) {
          if (
            !(error instanceof SymphonyError) ||
            (error.code !== "tracker_error" && error.code !== "tracker_unavailable")
          ) {
            throw error;
          }
        }
        if (forceRefresh && projection) {
          await this.persistWebIssueBoardProjection(projectWebIssueBoard(board), {
            sourceIndex: projection.sourceIndex,
            issueBoardColumns: projection.issueBoardColumns,
          });
        }
        sendJson(response, 200, projectWebReferenceData(board), durableProjectionReadHeaders(durableIssues));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/v1/web/dashboard") {
        const dashboard = await this.fetchWebDashboard(isWebProjectionRefreshRequested(url.searchParams.get("refresh")));
        sendJson(response, 200, dashboard.body, dashboard.headers);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/web/sidebar") {
        const sidebar = await this.fetchWebSidebar(isWebProjectionRefreshRequested(url.searchParams.get("refresh")));
        sendJson(response, 200, sidebar.body, sidebar.headers);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/board") {
        sendJson(
          response,
          200,
          acceptedBoardResponse(
            await this.fetchIssueBoard(
              isWebProjectionRefreshRequested(url.searchParams.get("refresh")),
            ),
          ),
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/web/issues") {
        const forceRefresh = isWebProjectionRefreshRequested(url.searchParams.get("refresh"));
        const durableIssues = await this.webProjectionRepositories.issueBoard.readDefaultBoard({ forceRefresh });
        if (durableIssues.status === "hit" && durableIssues.record) {
          sendJson(response, 200, durableIssues.record.payload, durableProjectionReadHeaders(durableIssues));
          return;
        }
        if (this.shouldReturnDurableProjectionFallback(forceRefresh)) {
          sendJson(response, 200, projectWebIssueBoard(null), durableProjectionReadHeaders(durableIssues));
          return;
        }
        const projection = await this.fetchOptionalWebProjectionSourceIndex(forceRefresh);
        let board: IssueBoardResponse | null = null;
        if (projection) {
          try {
            board = await this.buildIssueBoardFromSourceIndex(projection.sourceIndex, projection.issueBoardColumns);
          } catch (error) {
            if (!(error instanceof SymphonyError) || (error.code !== "tracker_error" && error.code !== "tracker_unavailable")) {
              throw error;
            }
          }
        }
        const issues = projectWebIssueBoard(board);
        await this.persistWebIssueBoardProjection(issues, {
          sourceIndex: projection?.sourceIndex ?? null,
          issueBoardColumns: projection?.issueBoardColumns ?? this.resolveWebProjectionIssueBoardColumns(),
        });
        sendJson(response, 200, issues, durableProjectionReadHeaders(durableIssues));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/issue-board") {
        sendJson(
          response,
          200,
          await this.fetchIssueBoard(isWebProjectionRefreshRequested(url.searchParams.get("refresh"))),
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/activity") {
        sendJson(
          response,
          200,
          await buildActivityFeed({
            generatedAt: this.options.orchestrator.snapshot().generatedAt,
            runStore: this.options.runStore,
            lifecycleStore: this.options.lifecycleStore,
            writebackOutbox: this.options.writebackOutbox,
            query: parseActivityQuery(url),
            defaultProjectContextId: this.options.defaultProjectContextId,
          }),
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/web/history") {
        const history = await this.fetchWebHistory(isWebProjectionRefreshRequested(url.searchParams.get("refresh")), url);
        sendJson(response, 200, history.body, history.headers);
        return;
      }
      const webTranscriptMatch = /^\/api\/v1\/web\/sessions\/([^/]+)\/transcript$/.exec(url.pathname);
      if (request.method === "GET" && webTranscriptMatch) {
        const sessionIdOrRunId = decodeURIComponent(webTranscriptMatch[1] ?? "").trim();
        const requestedFullTranscript = parseBooleanWebQueryParam(url.searchParams, "full");
        const requestedTranscriptPage = parseWebTranscriptPagination(url);
        const requestedTranscriptLimit = requestedFullTranscript ? WEB_TRANSCRIPT_PAGE_LIMIT : requestedTranscriptPage?.limit ?? WEB_TRANSCRIPT_DEFAULT_EVENT_LIMIT;
        if (sessionIdOrRunId.length === 0) {
          sendJson(
            response,
            200,
            emptyWebTranscriptProjectionPayload({ runId: sessionIdOrRunId, limit: requestedTranscriptLimit, kind: requestedFullTranscript ? "page" : "tail" }),
          );
          return;
        }
        const forceRefresh = isWebProjectionRefreshRequested(url.searchParams.get("refresh"));
        if (!this.options.runStore) {
          if (requestedFullTranscript) {
            sendJson(
              response,
              200,
              emptyWebTranscriptProjectionPayload({ runId: sessionIdOrRunId, limit: requestedTranscriptLimit, kind: "page" }),
            );
            return;
          }
          const durableTranscript = requestedTranscriptPage
            ? await this.webProjectionRepositories.transcript.readRunPage(
                { runId: sessionIdOrRunId, offset: requestedTranscriptPage.offset, limit: requestedTranscriptPage.limit },
                { forceRefresh },
              )
            : await this.webProjectionRepositories.transcript.readRunDefaultPage(
                { runId: sessionIdOrRunId, limit: WEB_TRANSCRIPT_DEFAULT_EVENT_LIMIT },
                { forceRefresh },
              );
          if (durableTranscript.status === "hit" && durableTranscript.record) {
            sendJson(
              response,
              200,
              webTranscriptProjectionResponseBody(durableTranscript.record.payload, {
                run: null,
                runId: sessionIdOrRunId,
                requestedPage: requestedTranscriptPage,
                limit: requestedTranscriptLimit,
                sourceCursors: durableTranscript.record.revision.sourceCursors,
              }),
              durableProjectionReadHeaders(durableTranscript),
            );
            return;
          }
          sendJson(
            response,
            200,
            emptyWebTranscriptProjectionPayload({
              runId: sessionIdOrRunId,
              limit: requestedTranscriptLimit,
              kind: requestedFullTranscript || requestedTranscriptPage ? "page" : "tail",
            }),
            durableProjectionReadHeaders(durableTranscript),
          );
          return;
        }
        const resolvedRun = await resolveWebTranscriptRun(this.options.runStore, sessionIdOrRunId, this.options.defaultProjectContextId);
        if (resolvedRun.status === "ambiguous" || resolvedRun.status === "wrong_context") {
          throw statusAliasResolutionError("Transcript", sessionIdOrRunId, resolvedRun.status);
        }
        if (!resolvedRun.run) {
          sendJson(
            response,
            200,
            emptyWebTranscriptProjectionPayload({
              runId: sessionIdOrRunId,
              limit: requestedTranscriptLimit,
              kind: requestedFullTranscript || requestedTranscriptPage ? "page" : "tail",
            }),
          );
          return;
        }
        const run = resolvedRun.run;
        let durableTranscript: DurableProjectionReadResult<WebTranscriptProjectionPayload> | undefined;
        if (!requestedFullTranscript && !shouldBypassDurableWebTranscriptForActiveTail(run, requestedTranscriptPage)) {
          durableTranscript = await this.webProjectionRepositories.transcript.readRunPage(
            transcriptProjectionPageSelectorForRequest(run, requestedTranscriptPage),
            { forceRefresh },
          );
          if (durableTranscript.status === "hit" && durableTranscript.record) {
            sendJson(
              response,
              200,
              webTranscriptProjectionResponseBody(durableTranscript.record.payload, {
                run,
                runId: run.runId,
                requestedPage: requestedTranscriptPage,
                limit: requestedTranscriptLimit,
                sourceCursors: durableTranscript.record.revision.sourceCursors,
              }),
              durableProjectionReadHeaders(durableTranscript),
            );
            return;
          }
        }
        const transcriptPage = requestedFullTranscript
          ? await readFullWebTranscriptPage(this.options.runStore, run.runId)
          : await readBoundedWebTranscriptPage(this.options.runStore, run.runId, url);
        const transcript = projectWebTranscript(transcriptPage.events, { run });
        const transcriptPayload = projectWebTranscriptWindow(transcriptPage, transcript, {
          run,
          requestedPage: requestedFullTranscript ? { offset: 0, limit: transcriptPage.limit } : requestedTranscriptPage,
          tailLimit: transcriptPage.limit,
          kind: requestedFullTranscript || requestedTranscriptPage ? "page" : "tail",
        });
        if (!requestedFullTranscript) await this.persistWebTranscriptProjection(run, transcriptPage, transcriptPayload);
        sendJson(response, 200, transcriptPayload, durableProjectionReadHeaders(durableTranscript));
        return;
      }
      if (url.pathname === "/api/v1/web/orchestrator-chat") {
        const conversationId = parseWebOrchestratorChatConversationId(url.searchParams.get("conversationId"));
        if (request.method === "GET") {
          const forceRefresh = isWebProjectionRefreshRequested(url.searchParams.get("refresh"));
          const durableChat = await this.webProjectionRepositories.orchestratorChat.readConversation(conversationId, {
            forceRefresh,
          });
          if (durableChat.status === "hit" && durableChat.record) {
            const chat = webOrchestratorChatProjectionFromResponseBody(durableChat.record.payload, conversationId);
            if (chat) {
              sendJson(response, 200, chat, durableProjectionReadHeaders(durableChat));
              return;
            }
            sendJson(
              response,
              200,
              webOrchestratorChatUnavailableProjection(conversationId, "orchestrator_chat_projection_payload_missing_chat_array"),
              durableProjectionReadHeaders({
                ...durableChat,
                status: "missing_item",
                reason: "orchestrator_chat_projection_payload_missing_chat_array",
              }),
            );
            return;
          }
          if (this.shouldReturnDurableOrchestratorChatFallback(durableChat, forceRefresh)) {
            sendJson(response, 200, webOrchestratorChatReadFallbackProjection(conversationId, durableChat), durableProjectionReadHeaders(durableChat));
            return;
          }
          const chat = await this.fetchWebOrchestratorChatProjection(conversationId);
          await this.persistWebOrchestratorChatProjection(chat);
          sendJson(
            response,
            200,
            webOrchestratorChatProjectionFromResponseBody(chat, conversationId) ?? chat,
            durableProjectionReadHeaders(durableChat),
          );
          return;
        }
        if (request.method === "POST") {
          let body: unknown;
          try {
            body = await readJsonBody(request);
          } catch {
            sendJson(response, 400, {
              error: {
                code: "invalid_request",
                message: "Web orchestrator chat request body must be valid JSON",
              },
            });
            return;
          }

          let input: WebOrchestratorChatPostRequest;
          try {
            input = parseWebOrchestratorChatPostRequest(body);
          } catch (error) {
            if (error instanceof SymphonyError && error.code === "invalid_request") {
              sendJson(response, 400, {
                error: {
                  code: error.code,
                  message: errorMessage(error),
                },
              });
              return;
            }
            throw error;
          }

          const postConversationId = input.conversationId ?? conversationId;
          const result = await this.acceptWebOrchestratorChatPost({
            input: input.input,
            ...(postConversationId === undefined ? {} : { conversationId: postConversationId }),
            ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
          });
          const chatProjection = webOrchestratorChatProjectionFromResponseBody(result.body, postConversationId);
          if (chatProjection) {
            let currentChatProjection: Pick<WebOrchestratorChatProjectionResponse, "conversation" | "state" | "status" | "chat" | "source"> =
              chatProjection;
            if (this.options.orchestratorConversationStore) {
              const durableChatProjection = await this.fetchWebOrchestratorChatProjection(postConversationId);
              await this.persistWebOrchestratorChatProjection(durableChatProjection);
              currentChatProjection = durableChatProjection;
            }
            if (result.stateChanged && currentChatProjection.chat.length > 0 && result.status !== 200) {
              const directPatchMessage = chatProjection.chat.at(-1) ?? currentChatProjection.chat.at(-1) ?? null;
              this.realtimeEvents.publishOrchestratorMessage(
                orchestratorChatRealtimeDetailFromProjection(currentChatProjection, {
                  inputLength: input.input.length,
                  status: result.status,
                  ...(directPatchMessage ? { message: directPatchMessage, messages: [directPatchMessage] } : {}),
                }),
              );
            }
          }

          sendJson(response, result.status, result.body);
          return;
        }
      }
      if (request.method === "GET" && url.pathname === "/api/v1/workspaces") {
        sendJson(response, 200, {
          workspaces: ((await this.options.runStore?.listWorkspaces()) ?? []).map(publicWorkspaceRecord),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/diagnostics/mcp-tool-exposure") {
        sendJson(response, 200, {
          latest: (await this.options.mcpExposureDiagnosticsStore?.latest()) ?? null,
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/refresh") {
        await this.options.orchestrator.refreshNow();
        sendJson(response, 202, {
          queued: true,
          coalesced: false,
          requested_at: new Date().toISOString(),
          operations: ["poll", "reconcile"],
        });
        return;
      }

      const approvalMatch = /^\/api\/v1\/approval-requests\/([^/]+)$/.exec(url.pathname);
      if (approvalMatch) {
        const requestId = decodeURIComponent(approvalMatch[1] ?? "").trim();
        if (request.method === "GET") {
          const resolvedApproval = await resolveApprovalRouteFromAlias({
            operatorApproval: this.options.operatorApproval,
            requestKey: requestId,
            snapshot: this.options.orchestrator.snapshot(),
            runStore: this.options.runStore,
            lifecycleStore: this.options.lifecycleStore,
            defaultProjectContextId: this.options.defaultProjectContextId,
          });
          if (resolvedApproval.status === "ambiguous" || resolvedApproval.status === "wrong_context") {
            throw statusAliasResolutionError("Approval", requestId, resolvedApproval.status);
          }
          const approval = resolvedApproval.approval;
          if (!approval) throw new SymphonyError("not_found", `Approval request not found: ${requestId}`);
          sendJson(response, 200, approvalResponse(approval, this.options.operatorApproval?.isRequired() ?? false));
          return;
        }
        if (request.method === "POST") {
          this.requireApprovalMutationToken(request);
          const decision = parseApprovalDecision(await readJsonBody(request));
          let resolvedApproval: ApprovalRouteResolution = { status: "none", approval: null };
          try {
            resolvedApproval = await resolveApprovalRouteFromAlias({
              operatorApproval: this.options.operatorApproval,
              requestKey: requestId,
              snapshot: this.options.orchestrator.snapshot(),
              runStore: this.options.runStore,
              lifecycleStore: this.options.lifecycleStore,
              defaultProjectContextId: this.options.defaultProjectContextId,
            });
          } catch {
            resolvedApproval = { status: "none", approval: null };
          }
          if (resolvedApproval.status === "ambiguous" || resolvedApproval.status === "wrong_context") {
            throw statusAliasResolutionError("Approval", requestId, resolvedApproval.status);
          }
          const existingApproval = resolvedApproval.approval;
          if (existingApproval?.status === "pending") {
            const currentApproval = await currentPendingPublicationApproval({
              approval: existingApproval,
              lifecycleStore: this.options.lifecycleStore,
              runStore: this.options.runStore,
              allowSetupIncomplete: decision === "reject",
            });
            if (!currentApproval && (await hasPendingPublicationLifecycle(existingApproval, this.options.lifecycleStore))) {
              throw new SymphonyError("conflict", "Approval request is not current pending publication approval");
            }
          }
          const resolvedRequestId = existingApproval?.requestId ?? requestId;
          let result;
          try {
            result = await this.options.operatorApproval?.resolve(resolvedRequestId, decision);
          } catch (error) {
            await this.recordPublicationApprovalTerminalConflict(resolvedRequestId, error);
            throw error;
          }
          if (!result) throw new SymphonyError("not_found", `Approval request not found: ${requestId}`);
          if (decision === "reject" && !result.replayed) {
            await this.recordRejectedApprovalRunTerminal(result.request);
          }
          if (decision === "approve" && result.request.status === "approved") {
            const resumed = await this.options.orchestrator.resumeApprovedPublication(result.request);
            if (resumed !== true) {
              throw new SymphonyError(
                "conflict",
                "Approved publication could not be resumed from a pending completion report",
              );
            }
          }
          if (decision === "reject" && !result.replayed) {
            try {
              await this.options.orchestrator.recordPublicationApprovalTerminal(result.request);
            } catch {
              // The approval decision is already durable; worker exit recovery will retry terminal writeback.
            }
            if (this.options.operatorApproval?.rejectPolicy === "cancel") {
              await this.options.orchestrator.cancelIssue(result.request.issueId);
            }
          }
          sendJson(response, 200, {
            request: approvalResponse(result.request, this.options.operatorApproval?.isRequired() ?? false),
            replayed: result.replayed,
          });
          return;
        }
      }

      const pauseMatch = /^\/api\/v1\/issues\/([^/]+)\/pause$/.exec(url.pathname);
      if (request.method === "POST" && pauseMatch) {
        this.requireMutationToken(request);
        const issueId = decodeURIComponent(pauseMatch[1] ?? "");
        const lookup = await this.resolveRouteIssueLookup(issueId);
        if (lookup.ambiguousCandidates.length > 0) throw ambiguousIssueLookupError(issueId, lookup.ambiguousCandidates);
        const lookupIssueId = lookup.issueId ?? issueId;
        this.options.orchestrator.pauseIssue(lookupIssueId);
        sendJson(response, 202, { paused: true, issue: lookupIssueId });
        return;
      }

      const resumeMatch = /^\/api\/v1\/issues\/([^/]+)\/resume$/.exec(url.pathname);
      if (request.method === "POST" && resumeMatch) {
        this.requireMutationToken(request);
        const issueId = decodeURIComponent(resumeMatch[1] ?? "");
        const lookup = await this.resolveRouteIssueLookup(issueId);
        if (lookup.ambiguousCandidates.length > 0) throw ambiguousIssueLookupError(issueId, lookup.ambiguousCandidates);
        const lookupIssueId = lookup.issueId ?? issueId;
        this.options.orchestrator.resumeIssue(lookupIssueId);
        sendJson(response, 202, { paused: false, issue: lookupIssueId });
        return;
      }

      const cancelMatch = /^\/api\/v1\/issues\/([^/]+)\/cancel$/.exec(url.pathname);
      if (request.method === "POST" && cancelMatch) {
        this.requireMutationToken(request);
        const issueId = decodeURIComponent(cancelMatch[1] ?? "");
        const lookup = await this.resolveRouteIssueLookup(issueId);
        if (lookup.ambiguousCandidates.length > 0) throw ambiguousIssueLookupError(issueId, lookup.ambiguousCandidates);
        const lookupIssueId = lookup.issueId ?? issueId;
        await this.options.orchestrator.cancelIssue(lookupIssueId);
        sendJson(response, 202, { cancelled: true, issue: lookupIssueId });
        return;
      }

      const providerGateMutationMatch = /^\/api\/v1\/provider-gates\/([^/]+)\/(clear|resume)$/.exec(url.pathname);
      if (request.method === "POST" && providerGateMutationMatch) {
        this.requireMutationToken(request);
        const gateId = decodeURIComponent(providerGateMutationMatch[1] ?? "");
        const cleared = await this.options.orchestrator.clearProviderGate(gateId);
        if (!cleared) throw new SymphonyError("not_found", `Provider gate not found: ${gateId}`);
        sendJson(response, 202, {
          cleared: true,
          resumed: providerGateMutationMatch[2] === "resume",
          gate: cleared,
        });
        return;
      }

      const issueRunsMatch = /^\/api\/v1\/issues\/([^/]+)\/runs$/.exec(url.pathname);
      if (request.method === "GET" && issueRunsMatch) {
        const issueId = decodeURIComponent(issueRunsMatch[1] ?? "").trim();
        const snapshot = this.options.orchestrator.snapshot();
        const parsedIssueAlias = parseContextualAlias(issueId);
        const preferRouteLookup =
          parsedIssueAlias.projectContextId === null && (!this.options.defaultProjectContextId || Boolean(this.options.tracker));
        const routeLookup =
          parsedIssueAlias.projectContextId === null ? await this.resolveRouteIssueLookup(issueId, snapshot) : null;
        const resolvedIssue = await resolveIssueAliasData({
          requestKey: issueId,
          snapshot,
          runStore: this.options.runStore,
          lifecycleStore: this.options.lifecycleStore,
          defaultProjectContextId: this.options.defaultProjectContextId,
        });
        let issueResponseKey = issueId;
        let lookupIssueId: string | null = null;
        let live: RunningRow | null = null;
        let workspace: WorkspaceRecord | null = null;
        let latestRun: RunRecord | null = null;
        let runs: RunRecord[] = [];
        let rawLifecycle: IssueLifecycleRecord | null = null;
        if (routeLookup?.resolutionKind === "exact_issue_id" && routeLookup.issueId) {
          lookupIssueId = routeLookup.issueId;
          issueResponseKey = lookupIssueId;
          live = this.options.orchestrator.getIssueDetails(lookupIssueId);
          rawLifecycle = (await this.options.lifecycleStore?.get(lookupIssueId)) ?? null;
          workspace = (await this.options.runStore?.findWorkspace(lookupIssueId)) ?? null;
          latestRun = (await this.options.runStore?.latestRunForIssue(lookupIssueId)) ?? null;
          runs = (await this.options.runStore?.listRunsForIssue(lookupIssueId)) ?? [];
        } else if (preferRouteLookup && routeLookup?.ambiguousCandidates.length) {
          throw ambiguousIssueLookupError(issueId, routeLookup.ambiguousCandidates);
        } else if (preferRouteLookup && routeLookup?.issueId) {
          lookupIssueId = routeLookup.issueId;
          issueResponseKey = lookupIssueId;
          live = this.options.orchestrator.getIssueDetails(lookupIssueId);
          rawLifecycle = (await this.options.lifecycleStore?.get(lookupIssueId)) ?? null;
          workspace = (await this.options.runStore?.findWorkspace(lookupIssueId)) ?? null;
          latestRun = (await this.options.runStore?.latestRunForIssue(lookupIssueId)) ?? null;
          runs = (await this.options.runStore?.listRunsForIssue(lookupIssueId)) ?? [];
        } else {
          if (resolvedIssue.status === "ambiguous" || resolvedIssue.status === "wrong_context") {
            throw statusAliasResolutionError("Issue", issueId, resolvedIssue.status);
          }
          if (resolvedIssue.status === "resolved") {
            issueResponseKey = parsedIssueAlias.projectContextId !== null ? issueId : resolvedIssue.requestKey;
            lookupIssueId =
              resolvedIssue.lifecycle?.issueId ??
              resolvedIssue.latestRun?.issueId ??
              resolvedIssue.workspace?.issueId ??
              resolvedIssue.live?.issueId ??
              null;
            live = resolvedIssue.live;
            workspace = resolvedIssue.workspace;
            latestRun = resolvedIssue.latestRun;
            runs = [...resolvedIssue.runs];
            rawLifecycle = resolvedIssue.lifecycle;
          } else {
            throw new SymphonyError("not_found", `Issue not found: ${issueId}`);
          }
        }
        const summaryRun = await resolveIssueDetailsSummaryRun(live, latestRun, this.options.runStore);
        const lifecycle = sanitizeStatusLifecycle({
          live,
          workspace,
          latestRun,
          lifecycle: rawLifecycle,
        });
        const enrichedRuns = await Promise.all(
          runs.map(async (run) => ({
            ...publicRunRecord(run),
            operatorLiveness: await runOperatorLiveness(run, snapshot, lifecycle, runs, this.options.runStore),
            livenessSummary: runLivenessSummary(run, snapshot, lifecycle, runs),
          })),
        );
        sendJson(response, 200, {
          issue: lookupIssueId ?? issueResponseKey,
          issueDetails: buildIssueDetailsEnvelope({
            requestKey: issueResponseKey,
            generatedAt: snapshot.generatedAt,
            trackerStateLists: this.options.trackerStateLists,
            staleThresholdMs: this.options.staleThresholdMs,
            live,
            workspace,
            latestRun,
            summaryRun,
            lifecycle,
          }),
          runs: enrichedRuns,
          issueBlocked: blockedIssueView(lifecycle),
          enrichment: {
            level: "operator_liveness_with_timeline",
            detailEndpoint: "/api/v1/runs/{runId}",
            transcriptEndpoint: "/api/v1/runs/{runId}/transcript",
            timelineIncluded: true,
            operatorLivenessContract: OPERATOR_LIVENESS_CONTRACT,
          },
          operatorLivenessContract: OPERATOR_LIVENESS_CONTRACT,
        });
        return;
      }

      const continuationSummaryMatch = /^\/api\/v1\/issues\/([^/]+)\/continuation-summary$/.exec(url.pathname);
      if (request.method === "POST" && continuationSummaryMatch) {
        this.requireMutationToken(request);
        const issueId = decodeURIComponent(continuationSummaryMatch[1] ?? "").trim();
        const parsedIssueAlias = parseContextualAlias(issueId);
        const preferRouteLookup =
          parsedIssueAlias.projectContextId === null && (!this.options.defaultProjectContextId || Boolean(this.options.tracker));
        if (parsedIssueAlias.projectContextId === null) {
          const lookup = await this.resolveRouteIssueLookup(issueId);
          if (lookup.resolutionKind === "exact_issue_id" && lookup.issueId) {
            const result = await this.options.orchestrator.createContinuationSummary(lookup.issueId);
            sendJson(response, 201, {
              issue: lookup.issueId,
              summaryReference: result.summaryReference,
              lifecycle: result.lifecycle,
            });
            return;
          }
          if (preferRouteLookup && lookup.ambiguousCandidates.length > 0) {
            throw ambiguousIssueLookupError(issueId, lookup.ambiguousCandidates);
          }
          if (preferRouteLookup && lookup.issueId) {
            const result = await this.options.orchestrator.createContinuationSummary(lookup.issueId);
            sendJson(response, 201, {
              issue: lookup.issueId,
              summaryReference: result.summaryReference,
              lifecycle: result.lifecycle,
            });
            return;
          }
        }
        const resolvedIssue = await resolveIssueAliasData({
          requestKey: issueId,
          snapshot: this.options.orchestrator.snapshot(),
          runStore: this.options.runStore,
          lifecycleStore: this.options.lifecycleStore,
          defaultProjectContextId: this.options.defaultProjectContextId,
        });
        if (resolvedIssue.status === "ambiguous" || resolvedIssue.status === "wrong_context") {
          throw statusAliasResolutionError("Issue", issueId, resolvedIssue.status);
        }
        let continuationSummaryIssueId = issueId;
        if (resolvedIssue.status === "resolved") {
          continuationSummaryIssueId =
            resolvedIssue.lifecycle?.issueId ??
            resolvedIssue.latestRun?.issueId ??
            resolvedIssue.workspace?.issueId ??
            resolvedIssue.live?.issueId ??
            continuationSummaryIssueId;
        }
        const result = await this.options.orchestrator.createContinuationSummary(continuationSummaryIssueId);
        sendJson(response, 201, {
          issue: issueId,
          summaryReference: result.summaryReference,
          lifecycle: result.lifecycle,
        });
        return;
      }

      const issueBreakdownMatch = /^\/api\/v1\/issues\/([^/]+)\/planning-run$/.exec(url.pathname);
      if (request.method === "POST" && issueBreakdownMatch) {
        this.requireMutationToken(request);
        const issueId = decodeURIComponent(issueBreakdownMatch[1] ?? "").trim();
        const resolvedTarget = await resolveIssueActionTarget({
          requestKey: issueId,
          snapshot: this.options.orchestrator.snapshot(),
          runStore: this.options.runStore,
          lifecycleStore: this.options.lifecycleStore,
          defaultProjectContextId: this.options.defaultProjectContextId,
        });
        if (resolvedTarget.status !== "resolved") {
          throw statusAliasResolutionError(
            "Issue",
            issueId,
            resolvedTarget.status,
            buildIssueRouteEvidence({
              kind: "issue_breakdown",
              requestKey: issueId,
              status: resolvedTarget.status,
              reason:
                resolvedTarget.status === "ambiguous"
                  ? "alias_ambiguous_across_project_contexts"
                  : "alias_not_available_through_default_project_context",
            }),
          );
        }
        const { target } = resolvedTarget;
        const aliasRouteEvidence = buildIssueRouteEvidence({
          kind: "issue_breakdown",
          requestKey: issueId,
          status: "resolved",
          resolvedProjectContextId: target.projectContext?.projectContextId ?? null,
          lookupKey: target.lookupKey,
          sources: issueRouteEvidenceAliasSources(target),
        });
        try {
          const result = await this.options.orchestrator.requestIssueBreakdown(target.lookupKey, {
            ...(target.projectContext ? { projectContext: target.projectContext } : {}),
          });
          sendJson(response, result.queued ? 202 : 200, {
            queued: result.queued,
            issue: result.issue.identifier,
            issueId: result.issue.id,
            runPhase: "issue_breakdown",
            runKind: "planning",
            reason: result.reason,
            routeEvidence: result.routeEvidence ? mergeIssueRouteEvidence(aliasRouteEvidence, result.routeEvidence) : aliasRouteEvidence,
          });
        } catch (error) {
          throw mergeRouteEvidenceIntoError(error, aliasRouteEvidence);
        }
        return;
      }

      const issueBreakdownApplyMatch = /^\/api\/v1\/issues\/([^/]+)\/planning-run\/apply$/.exec(url.pathname);
      if (request.method === "POST" && issueBreakdownApplyMatch) {
        this.requireIssueBreakdownApplyToken(request);
        const issueId = decodeURIComponent(issueBreakdownApplyMatch[1] ?? "").trim();
        const resolvedTarget = await resolveIssueActionTarget({
          requestKey: issueId,
          snapshot: this.options.orchestrator.snapshot(),
          runStore: this.options.runStore,
          lifecycleStore: this.options.lifecycleStore,
          defaultProjectContextId: this.options.defaultProjectContextId,
        });
        if (resolvedTarget.status !== "resolved") {
          throw statusAliasResolutionError(
            "Issue",
            issueId,
            resolvedTarget.status,
            buildIssueRouteEvidence({
              kind: "issue_breakdown_apply",
              requestKey: issueId,
              status: resolvedTarget.status,
              reason:
                resolvedTarget.status === "ambiguous"
                  ? "alias_ambiguous_across_project_contexts"
                  : "alias_not_available_through_default_project_context",
            }),
          );
        }
        const { target } = resolvedTarget;
        const aliasRouteEvidence = buildIssueRouteEvidence({
          kind: "issue_breakdown_apply",
          requestKey: issueId,
          status: "resolved",
          resolvedProjectContextId: target.projectContext?.projectContextId ?? null,
          lookupKey: target.lookupKey,
          sources: issueRouteEvidenceAliasSources(target),
        });
        try {
          const options = parseIssueBreakdownApplyRequest(await readJsonBody(request));
          const result = await this.options.orchestrator.applyIssueBreakdownPlan(target.lookupKey, {
            ...options,
            ...(target.projectContext ? { projectContext: target.projectContext } : {}),
          });
          sendJson(response, result.status === "pending" ? 202 : 200, {
            issue: issueId,
            mode: options.dryRun ? "preview" : "apply",
            ...result,
            routeEvidence: result.routeEvidence ? mergeIssueRouteEvidence(aliasRouteEvidence, result.routeEvidence) : aliasRouteEvidence,
          });
        } catch (error) {
          throw mergeRouteEvidenceIntoError(error, aliasRouteEvidence);
        }
        return;
      }

      const issueMatch = /^\/api\/v1\/issues\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && issueMatch) {
        const issueId = decodeURIComponent(issueMatch[1] ?? "").trim();
        const snapshot = this.options.orchestrator.snapshot();
        const parsedIssueAlias = parseContextualAlias(issueId);
        const preferRouteLookup =
          parsedIssueAlias.projectContextId === null && (!this.options.defaultProjectContextId || Boolean(this.options.tracker));
        const routeLookup =
          parsedIssueAlias.projectContextId === null ? await this.resolveRouteIssueLookup(issueId, snapshot) : null;
        const resolvedIssue = await resolveIssueAliasData({
          requestKey: issueId,
          snapshot,
          runStore: this.options.runStore,
          lifecycleStore: this.options.lifecycleStore,
          defaultProjectContextId: this.options.defaultProjectContextId,
        });
        let issueRouteKey = issueId;
        let lookupIssueId: string | null = null;
        let live: RunningRow | null = null;
        let workspace: WorkspaceRecord | null = null;
        let latestRun: RunRecord | null = null;
        let rawLifecycle: IssueLifecycleRecord | null = null;
        if (routeLookup?.resolutionKind === "exact_issue_id" && routeLookup.issueId) {
          lookupIssueId = routeLookup.issueId;
          issueRouteKey = lookupIssueId;
          live = this.options.orchestrator.getIssueDetails(lookupIssueId);
          rawLifecycle = (await this.options.lifecycleStore?.get(lookupIssueId)) ?? null;
          workspace = (await this.options.runStore?.findWorkspace(lookupIssueId)) ?? null;
          latestRun = (await this.options.runStore?.latestRunForIssue(lookupIssueId)) ?? null;
        } else if (preferRouteLookup && routeLookup?.ambiguousCandidates.length) {
          throw ambiguousIssueLookupError(issueId, routeLookup.ambiguousCandidates);
        } else if (preferRouteLookup && routeLookup?.issueId) {
          lookupIssueId = routeLookup.issueId;
          issueRouteKey = lookupIssueId;
          live = this.options.orchestrator.getIssueDetails(lookupIssueId);
          rawLifecycle = (await this.options.lifecycleStore?.get(lookupIssueId)) ?? null;
          workspace = (await this.options.runStore?.findWorkspace(lookupIssueId)) ?? null;
          latestRun = (await this.options.runStore?.latestRunForIssue(lookupIssueId)) ?? null;
        } else {
          if (resolvedIssue.status === "ambiguous" || resolvedIssue.status === "wrong_context") {
            throw statusAliasResolutionError("Issue", issueId, resolvedIssue.status);
          }
          if (resolvedIssue.status === "resolved") {
            issueRouteKey = parsedIssueAlias.projectContextId !== null ? issueId : resolvedIssue.requestKey;
            lookupIssueId =
              resolvedIssue.lifecycle?.issueId ??
              resolvedIssue.latestRun?.issueId ??
              resolvedIssue.workspace?.issueId ??
              resolvedIssue.live?.issueId ??
              null;
            live = resolvedIssue.live;
            workspace = resolvedIssue.workspace;
            latestRun = resolvedIssue.latestRun;
            rawLifecycle = resolvedIssue.lifecycle;
          } else {
            throw new SymphonyError("not_found", `Issue not found: ${issueId}`);
          }
        }
        const summaryRun = await resolveIssueDetailsSummaryRun(live, latestRun, this.options.runStore);
        const lifecycle = sanitizeStatusLifecycle({
          live,
          workspace,
          latestRun,
          lifecycle: rawLifecycle,
        });
        const workspacePath = live?.workspacePath ?? workspace?.path ?? null;
        const keys = issueKeys(issueRouteKey, { live, latestRun, lifecycle });
        const paused = isIssuePaused(snapshot, keys);
        const resolvedAgentId = live ? await resolveRunningAgentId(live, this.options.runStore) : null;
        const issueProjectContext = lifecycle?.projectContext ?? workspace?.projectContext ?? projectContextResolutionFromIssue(live) ?? latestRun?.projectContext;
        const pendingApprovalCandidate = await this.options.operatorApproval?.findPendingForIssue(keys, issueProjectContext);
        const pendingApproval = pendingApprovalCandidate
          ? await currentPendingPublicationApproval({
              approval: pendingApprovalCandidate,
              lifecycleStore: this.options.lifecycleStore,
              runStore: this.options.runStore,
            })
          : null;
        const operatorLiveness = await issueOperatorLiveness({
          live,
          latestRun: publicRunRecordOrNull(latestRun),
          lifecycle,
          paused,
          resolvedAgentId,
          runStore: this.options.runStore,
        });
        const controls = operatorControls({ issueKnown: true, live, paused, mutationsConfigured: Boolean(this.options.openWorkspaceToken) });
        const affordances = operatorAffordances({
          issueKey: issueRouteKey,
          lifecycle,
          continuationSummaryAvailable: Boolean(this.options.lifecycleStore && this.options.runStore),
          mutationsRequireToken: controls.mutationsRequireToken,
        });
        sendJson(response, 200, {
          issue: lookupIssueId ?? issueRouteKey,
          issueDetails: buildIssueDetailsEnvelope({
            requestKey: issueRouteKey,
            generatedAt: snapshot.generatedAt,

            trackerStateLists: this.options.trackerStateLists,
            staleThresholdMs: this.options.staleThresholdMs,
            live,
            workspace,
            latestRun,
            summaryRun,
            lifecycle,
          }),
          live: live ? liveIssueResponse(live, operatorLiveness) : null,
          workspace,
          latestRun: publicRunRecordOrNull(latestRun),
          lifecycle,
          reviewLoop: reviewLoopStatus({ live, latestRun, lifecycle }),
          mergeGate: mergeGateStatus(lifecycle, buildIssuePullRequestSummary(statusMetadata({ live, workspace, latestRun, lifecycle }))),
          metadata: statusMetadata({ live, workspace, latestRun, lifecycle }),
          operatorLiveness,
          diagnostics: {
            mcpToolExposure: (await this.options.mcpExposureDiagnosticsStore?.latest()) ?? null,
          },
          capabilities: {
            transcript: Boolean(latestRun),
            openWorkspace: workspacePath === null ? false : await pathExists(workspacePath),
            pause: controls.pause,
            resume: controls.resume,
            cancel: controls.cancel,
            humanRequired: pendingApproval
              ? {
                  active: true,
                  reason: "awaiting operator approval for push/PR",
                  continuationSummaryRecommended: false,
                }
              : affordances.humanRequired,
            continuationSummary: affordances.continuationSummary,
            mutationsRequireToken: controls.mutationsRequireToken,
            mutationHeader: "X-Symphony-Token",
            pendingApproval: approvalCapability(
              pendingApproval ?? null,
              this.options.operatorApproval?.isRequired() ?? false,
              this.options.openWorkspaceToken,
            ),
          },
          pendingApproval: pendingApproval ? approvalResponse(pendingApproval, this.options.operatorApproval?.isRequired() ?? false) : null,
          operatorLivenessContract: OPERATOR_LIVENESS_CONTRACT,
        });
        return;
      }

      const transcriptMatch = /^\/api\/v1\/runs\/([^/]+)\/transcript$/.exec(url.pathname);
      if (request.method === "GET" && transcriptMatch) {
        const runId = decodeURIComponent(transcriptMatch[1] ?? "").trim();
        if (!this.options.runStore) throw new SymphonyError("not_found", `Run not found: ${runId}`);
        const resolvedRun = await resolveTranscriptRunFromAlias({
          runStore: this.options.runStore,
          requestKey: runId,
          defaultProjectContextId: this.options.defaultProjectContextId,
        });
        if (resolvedRun.status === "ambiguous" || resolvedRun.status === "wrong_context") {
          throw statusAliasResolutionError("Transcript", runId, resolvedRun.status);
        }
        if (!resolvedRun.run) throw new SymphonyError("not_found", `Run not found: ${runId}`);
        sendJson(response, 200, await this.options.runStore.readTranscript(resolvedRun.run.runId, parsePagination(url)));
        return;
      }

      const runMatch = /^\/api\/v1\/runs\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && runMatch) {
        const runId = decodeURIComponent(runMatch[1] ?? "").trim();
        if (!this.options.runStore) throw new SymphonyError("not_found", `Run not found: ${runId}`);
        const resolvedRun = await resolveTranscriptRunFromAlias({
          runStore: this.options.runStore,
          requestKey: runId,
          defaultProjectContextId: this.options.defaultProjectContextId,
        });
        if (resolvedRun.status === "ambiguous" || resolvedRun.status === "wrong_context") {
          throw statusAliasResolutionError("Run", runId, resolvedRun.status);
        }
        const run = resolvedRun.run;
        if (!run) throw new SymphonyError("not_found", `Run not found: ${runId}`);
        const issueLookupOptions = run.projectContext ? { projectContext: run.projectContext } : {};
        const issueRunsByIdentifier = (await this.options.runStore?.listRunsForIssue(run.issueIdentifier, issueLookupOptions)) ?? [];
        const issueRuns =
          issueRunsByIdentifier.length > 0 || run.issueIdentifier === run.issueId
            ? issueRunsByIdentifier
            : ((await this.options.runStore?.listRunsForIssue(run.issueId, issueLookupOptions)) ?? []);
        const lifecycle =
          (await this.options.lifecycleStore?.get(run.issueId)) ?? (await this.options.lifecycleStore?.get(run.issueIdentifier)) ?? null;
        sendJson(response, 200, {
          ...publicRunRecord(run),
          pendingApproval: (await this.options.operatorApproval?.findPendingForRun(run.runId)) ?? null,
          telemetry: await runTelemetrySummary(run.runId, this.options.runStore),
          operatorLiveness: await runOperatorLiveness(run, this.options.orchestrator.snapshot(), lifecycle, issueRuns, this.options.runStore),
          operatorLivenessContract: OPERATOR_LIVENESS_CONTRACT,
        });
        return;
      }

      const workspaceMatch = /^\/api\/v1\/workspaces\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && workspaceMatch) {
        const workspaceKey = decodeURIComponent(workspaceMatch[1] ?? "").trim();
        const directWorkspace = await this.options.runStore?.getWorkspace(workspaceKey);
        if (directWorkspace && (directWorkspace.workspaceKey !== directWorkspace.issueIdentifier || !this.options.defaultProjectContextId)) {
          sendJson(response, 200, publicWorkspaceRecord(directWorkspace));
          return;
        }
        const parsedWorkspaceAlias = parseContextualAlias(workspaceKey);
        if (parsedWorkspaceAlias.projectContextId === null) {
          const lookup = await this.resolveRouteIssueLookup(workspaceKey);
          if (lookup.resolutionKind === "exact_issue_id" && lookup.issueId) {
            const exactWorkspace = await this.options.runStore?.findWorkspace(lookup.issueId);
            if (exactWorkspace) {
              sendJson(response, 200, publicWorkspaceRecord(exactWorkspace));
              return;
            }
          }
          if (lookup.ambiguousCandidates.length > 0 && (!this.options.defaultProjectContextId || this.options.tracker)) {
            throw ambiguousIssueLookupError(workspaceKey, lookup.ambiguousCandidates);
          }
        }
        const snapshot = this.options.orchestrator.snapshot();
        const resolvedIssue = await resolveIssueAliasData({
          requestKey: workspaceKey,
          snapshot,
          runStore: this.options.runStore,
          lifecycleStore: this.options.lifecycleStore,
          defaultProjectContextId: this.options.defaultProjectContextId,
        });
        if (resolvedIssue.status === "ambiguous" || resolvedIssue.status === "wrong_context") {
          throw statusAliasResolutionError("Workspace", workspaceKey, resolvedIssue.status);
        }
        if (!resolvedIssue.workspace) throw new SymphonyError("not_found", `Workspace not found: ${workspaceKey}`);
        sendJson(response, 200, publicWorkspaceRecord(resolvedIssue.workspace));
        return;
      }

      const openMatch = /^\/api\/v1\/issues\/([^/]+)\/open-workspace$/.exec(url.pathname);
      if (request.method === "POST" && openMatch) {
        this.requireMutationToken(request);
        const issueId = decodeURIComponent(openMatch[1] ?? "").trim();
        const parsedIssueAlias = parseContextualAlias(issueId);
        const preferRouteLookup =
          parsedIssueAlias.projectContextId === null && (!this.options.defaultProjectContextId || Boolean(this.options.tracker));
        if (parsedIssueAlias.projectContextId === null) {
          const lookup = await this.resolveRouteIssueLookup(issueId);
          if (preferRouteLookup && lookup.ambiguousCandidates.length > 0) {
            throw ambiguousIssueLookupError(issueId, lookup.ambiguousCandidates);
          }
          if (lookup.issueId && (lookup.resolutionKind === "exact_issue_id" || preferRouteLookup)) {
            const lookupIssueId = lookup.issueId;
            const details = this.options.orchestrator.getIssueDetails(lookupIssueId);
            const lifecycle = await this.options.lifecycleStore?.get(lookupIssueId);
            const workspace = await this.options.runStore?.findWorkspace(lookupIssueId);
            const latestRun = await this.options.runStore?.latestRunForIssue(lookupIssueId);
            const persistedWorkspaceLookupKey =
              workspace?.workspaceKey ?? latestRun?.workspaceKey ?? lifecycle?.summaryPointers.workspaceKey ?? null;
            const workspacePath =
              details?.workspacePath ??
              workspace?.path ??
              latestRun?.workspacePath ??
              lifecycle?.summaryPointers.workspacePath ??
              (persistedWorkspaceLookupKey
                ? workspacePathForLookupKey(persistedWorkspaceLookupKey, this.options.workspaceManager)
                : lifecycle
                  ? this.options.workspaceManager.getPathForIssue({
                      id: lifecycle.issueId,
                      identifier: lifecycle.issueIdentifier,
                      branchName: lifecycle.summaryPointers.gitBranchName ?? lifecycle.summaryPointers.branchName ?? null,
                      ...(lifecycle.projectContext === undefined ? {} : { projectContext: lifecycle.projectContext }),
                    })
                  : null);
            if (!workspacePath) {
              throw new SymphonyError("not_found", `Workspace not found for issue: ${issueId}`);
            }
            if (!(await pathExists(workspacePath))) {
              throw new SymphonyError("not_found", `Workspace not found: ${workspacePath}`);
            }
            await this.options.workspaceOpener.open(workspacePath);
            sendJson(response, 202, { opened: true, workspace_path: workspacePath });
            return;
          }
        }
        const resolvedTarget = await resolveIssueActionTarget({
          requestKey: issueId,
          snapshot: this.options.orchestrator.snapshot(),
          runStore: this.options.runStore,
          lifecycleStore: this.options.lifecycleStore,
          defaultProjectContextId: this.options.defaultProjectContextId,
        });
        if (resolvedTarget.status !== "resolved") {
          throw statusAliasResolutionError(
            "Issue",
            issueId,
            resolvedTarget.status,
            buildIssueRouteEvidence({
              kind: "open_workspace",
              requestKey: issueId,
              status: resolvedTarget.status,
              reason:
                resolvedTarget.status === "ambiguous"
                  ? "alias_ambiguous_across_project_contexts"
                  : "alias_not_available_through_default_project_context",
            }),
          );
        }
        const { target } = resolvedTarget;
        const aliasSources = issueRouteEvidenceAliasSources(target);
        const workspaceLookupKey = resolvedWorkspaceActionLookupKey(target, this.options.defaultProjectContextId);
        const scopedIssueLookupKeys = Array.from(
          new Set(
            [target.live?.issueId, target.latestRun?.issueId, target.lifecycle?.issueId, target.workspace?.issueId, workspaceLookupKey, issueId].filter(
              (key): key is string => typeof key === "string" && key.length > 0,
            ),
          ),
        );
        const details =
          target.live ??
          scopedIssueLookupKeys
            .map((key) => this.options.orchestrator.getIssueDetails(key))
            .find((candidate) => candidate !== null) ??
          null;
        const scopedWorkspaceLookupKeys = Array.from(
          new Set(
            [
              target.workspace?.workspaceKey,
              target.latestRun?.workspaceKey,
              target.lifecycle?.summaryPointers.workspaceKey,
              target.workspace?.issueId,
              target.live?.issueId,
              target.latestRun?.issueId,
              target.lifecycle?.issueId,
              workspaceLookupKey,
              issueId,
            ].filter((key): key is string => typeof key === "string" && key.length > 0),
          ),
        );
        let workspace = target.workspace;
        if (!workspace && this.options.runStore) {
          for (const key of scopedWorkspaceLookupKeys) {
            workspace = await this.options.runStore.findWorkspace(key);
            if (workspace) break;
          }
        }
        const workspacePath =
          details?.workspacePath ??
          workspace?.path ??
          target.latestRun?.workspacePath ??
          target.lifecycle?.summaryPointers.workspacePath ??
          workspacePathForLookupKey(workspaceLookupKey, this.options.workspaceManager);
        let workspaceSource: IssueRouteEvidenceSource = "workspace_filesystem_fallback";
        if (details?.workspacePath) {
          workspaceSource = "workspace_live";
        } else if (workspace?.path) {
          workspaceSource = "workspace_record";
        } else if (target.latestRun?.workspacePath) {
          workspaceSource = "workspace_run";
        } else if (target.lifecycle?.summaryPointers.workspacePath) {
          workspaceSource = "workspace_lifecycle";
        }

        if (!(await pathExists(workspacePath))) {
          throw new SymphonyError("not_found", `Workspace not found: ${workspacePath}`, {
            routeEvidence: buildIssueRouteEvidence({
              kind: "open_workspace",
              requestKey: issueId,
              status: "missing",
              reason: "workspace_path_not_found",
              resolvedProjectContextId: target.projectContext?.projectContextId ?? null,
              lookupKey: workspaceLookupKey,
              sources: [...aliasSources, workspaceSource],
            }),
          });
        }
        await this.options.workspaceOpener.open(workspacePath);
        sendJson(response, 202, {
          opened: true,
          workspace_path: workspacePath,
          routeEvidence: buildIssueRouteEvidence({
            kind: "open_workspace",
            requestKey: issueId,
            status: "resolved",
            reason: workspaceSource === "workspace_filesystem_fallback" ? "workspace_filesystem_fallback" : null,
            resolvedProjectContextId: target.projectContext?.projectContextId ?? null,
            lookupKey: workspaceLookupKey,
            sources: [...aliasSources, workspaceSource],
          }),
        });
        return;
      }

      if ((request.method === "GET" || request.method === "HEAD") && isWebAssetRoute(url.pathname)) {
        if (await serveWebAsset(response, request.method, url.pathname, this.webAssetsRoot)) return;
      }

      sendJson(response, 404, { error: { code: "not_found", message: "Route not found" } });
    } catch (error) {
      const status =
        error instanceof SymphonyError && error.code === "not_found"
          ? 404
          : error instanceof SymphonyError && error.code === "conflict"
            ? 409
          : error instanceof SymphonyError && (error.code === "tracker_error" || error.code === "tracker_unavailable")
            ? 503
          : error instanceof SymphonyError && error.code === "invalid_request"
            ? 401
            : 500;
      const routeEvidence = issueRouteEvidenceFromError(error);
      sendJson(response, status, {
        error: {
          code: error instanceof SymphonyError ? error.code : "internal_error",
          message: errorMessage(error),
        },
        ...(routeEvidence ? { routeEvidence } : {}),
      });
    }
  }

  private requireApprovalMutationToken(request: IncomingMessage): void {
    if (!(this.options.operatorApproval?.isRequired() ?? false)) {
      this.requireMutationToken(request);
      return;
    }
    const expected = this.options.openWorkspaceToken?.trim() ?? "";
    if (expected.length === 0) {
      throw new SymphonyError("invalid_request", "Missing or invalid open-workspace token");
    }
    const provided = request.headers["x-symphony-token"];
    if (provided !== expected) {
      throw new SymphonyError("invalid_request", "Missing or invalid open-workspace token");
    }
  }

  private async recordPublicationApprovalTerminalConflict(requestId: string, error: unknown): Promise<void> {
    if (!(error instanceof SymphonyError) || error.code !== "conflict") return;
    try {
      const approval =
        approvalRecordFromDetails(error.details) ?? (await this.options.operatorApproval?.get(requestId)) ?? null;
      if (!approval || !isPublicationApprovalTerminal(approval)) return;
      await this.options.orchestrator.recordPublicationApprovalTerminal(approval);
    } catch {
      // Recovery must not mask the approval API's original conflict response.
    }
  }

  private async recordRejectedApprovalRunTerminal(request: OperatorApprovalRecord): Promise<void> {
    if (!this.options.runStore) return;
    const existing = await this.options.runStore.getRun(request.runId);
    const completedAt = existing?.completedAt ?? request.resolvedAt ?? new Date().toISOString();
    const cancelPolicy = this.options.operatorApproval?.rejectPolicy === "cancel";
    await this.options.runStore.updateRun(request.runId, {
      status: cancelPolicy ? "cancelled" : "failed",
      completedAt,
      error: cancelPolicy ? "Operator cancelled issue" : OPERATOR_REJECTED_PUBLICATION_ERROR,
      metadata: {
        pendingApprovalRequestId: null,
        pendingApprovalRequestedAt: null,
      },
    });
  }

  private requireMutationToken(request: IncomingMessage): void {
    const expected = this.options.openWorkspaceToken;
    if (!expected) return;
    const provided = request.headers["x-symphony-token"];
    if (provided !== expected) {
      throw new SymphonyError("invalid_request", "Missing or invalid open-workspace token");
    }
  }

  private requireIssueBreakdownApplyToken(request: IncomingMessage): void {
    const expected = this.options.openWorkspaceToken?.trim() ?? "";
    if (!expected) {
      throw new SymphonyError("invalid_request", "Issue breakdown apply requires a configured X-Symphony-Token");
    }
    const provided = request.headers["x-symphony-token"];
    if (typeof provided !== "string" || provided.trim().length === 0 || provided !== expected) {
      throw new SymphonyError("invalid_request", "Missing or invalid issue breakdown apply token");
    }
  }

  async rebuildDurableWebProjections(
    options: StatusServerProjectionRebuildOptions = {},
  ): Promise<StatusServerProjectionRebuildResult> {
    const generatedAt = (this.options.webProjectionContextClock?.() ?? new Date()).toISOString();
    const projectionNames = normalizeStatusServerProjectionRebuildSelection(options.projections);
    const entries: StatusServerProjectionRebuildEntry[] = [];
    const projection = statusServerProjectionRebuildNeedsSourceIndex(projectionNames)
      ? await this.fetchOptionalWebProjectionSourceIndex(options.forceRefresh ?? true)
      : null;
    const sourceIndex = projection?.sourceIndex ?? null;
    const issueBoardColumns = projection?.issueBoardColumns ?? this.resolveWebProjectionIssueBoardColumns();
    const sourceRevisions = statusServerProjectionSourceRevisions(sourceIndex, this.options);
    const snapshot = sourceIndex?.runtime.snapshot ?? this.options.orchestrator.snapshot();
    let board: IssueBoardResponse | null = null;

    if (sourceIndex && statusServerProjectionRebuildNeedsIssueBoard(projectionNames)) {
      try {
        board = await this.buildIssueBoardFromSourceIndex(sourceIndex, issueBoardColumns);
      } catch (error) {
        if (!isTrackerProjectionFailure(error)) throw error;
      }
    }

    if (projectionNames.has("dashboard_projection")) {
      const activitySources = await this.fetchWebCollectionActivitySources(sourceIndex, WEB_DASHBOARD_RUN_LIMIT);
      const activity = await buildActivityFeed({
        generatedAt: snapshot.generatedAt,
        runStore: this.options.runStore,
        runs: activitySources.runs,
        lifecycleStore: this.options.lifecycleStore,
        lifecycleRecords: activitySources.lifecycleRecords,
        writebackOutbox: this.options.writebackOutbox,
        writebackOperations: activitySources.writebackOperations,
        query: { issue: null, offset: 0, limit: 20 },
        includeTranscriptEvents: false,
      });
      const dashboard = projectWebDashboard({
        runtime: snapshot,
        board,
        activity,
        runs: sourceIndex?.runs.runs ?? activitySources.runs,
        lifecycleRecords: sourceIndex?.lifecycles.records ?? activitySources.lifecycleRecords,
        source: dashboardSourceInputFromSourceIndex(sourceIndex, { activityCount: activity.activity.length }),
        config: this.options.dashboard ?? null,
      });
      await this.recordProjectionRebuildEntry(
        this.webDashboardProjectionWriteInput(dashboard, {
          sourceIndex,
          activityCount: activity.activity.length,
          issueBoardColumns,
        }),
        entries,
      );
    }

    if (projectionNames.has("issue_board_projection")) {
      const issues = projectWebIssueBoard(board);
      await this.recordProjectionRebuildEntry(
        this.webIssueBoardProjectionWriteInput(issues, { sourceIndex, issueBoardColumns }),
        entries,
      );
    }

    if (projectionNames.has("sidebar_projection")) {
      const activitySources = await this.fetchWebCollectionActivitySources(sourceIndex, WEB_SIDEBAR_SESSION_LIMIT);
      const historyActivity = await buildActivityFeed({
        generatedAt: snapshot.generatedAt,
        runStore: this.options.runStore,
        runs: activitySources.runs,
        lifecycleStore: this.options.lifecycleStore,
        lifecycleRecords: activitySources.lifecycleRecords,
        writebackOutbox: this.options.writebackOutbox,
        writebackOperations: activitySources.writebackOperations,
        query: { issue: null, offset: 0, limit: WEB_SIDEBAR_HISTORY_TIMELINE_LIMIT },
        includeTranscriptEvents: false,
      });
      const dashboardActivity = previewActivityFeed(historyActivity, 20);
      const dashboard = projectWebDashboard({
        runtime: snapshot,
        board,
        activity: dashboardActivity,
        runs: sourceIndex?.runs.runs ?? activitySources.runs,
        lifecycleRecords: sourceIndex?.lifecycles.records ?? activitySources.lifecycleRecords,
        config: this.options.dashboard ?? null,
      });
      const issues = projectWebIssueBoard(board);
      const history = projectWebHistory(activitySources.runs, historyActivity.activity, { runtime: snapshot, activityRuns: activitySources.runs });
      const chat = projectWebOrchestratorChat(await this.fetchWebOrchestratorChatMessages());
      const sidebar = projectWebSidebar(dashboard, issues, history, chat);
      await this.recordProjectionRebuildEntry(
        this.webSidebarProjectionWriteInput(sidebar, {
          sourceIndex,
          activityCount: historyActivity.activity.length,
          issueBoardColumns,
        }),
        entries,
      );
    }

    if (projectionNames.has("history_projection")) {
      const limits = normalizeStatusServerProjectionRebuildHistoryLimits(options.historyLimits);
      const activitySources = await this.fetchWebCollectionActivitySources(
        sourceIndex,
        Math.max(limits.sessionLimit, limits.timelineLimit),
      );
      const runs = selectRecentRuns(activitySources.runs, limits.sessionLimit);
      const activityRuns = selectRecentRuns(activitySources.runs, limits.timelineLimit);
      const activityFeed = await buildActivityFeed({
        generatedAt: snapshot.generatedAt,
        runStore: this.options.runStore,
        runs: activityRuns,
        lifecycleStore: this.options.lifecycleStore,
        lifecycleRecords: activitySources.lifecycleRecords,
        writebackOutbox: this.options.writebackOutbox,
        writebackOperations: activitySources.writebackOperations,
        query: { issue: null, offset: 0, limit: limits.timelineLimit },
        includeTranscriptEvents: false,
      });
      const history = projectWebHistory(runs, activityFeed.activity, { runtime: snapshot, activityRuns });
      await this.recordProjectionRebuildEntry(
        this.webHistoryProjectionWriteInput(history, {
          sourceIndex,
          limits,
          activityCount: activityFeed.activity.length,
        }),
        entries,
      );
    }

    if (projectionNames.has("transcript_projection")) {
      await this.rebuildWebTranscriptProjections(
        entries,
        normalizeStatusServerProjectionRebuildTranscriptPageLimit(options.transcriptPageLimit),
      );
    }

    if (projectionNames.has("orchestrator_chat_projection")) {
      for (const conversationId of normalizeStatusServerProjectionRebuildConversationIds(options.conversationIds)) {
        const chat = await this.fetchWebOrchestratorChatProjection(conversationId);
        await this.recordProjectionRebuildEntry(
          this.webOrchestratorChatProjectionWriteInput(chat),
          entries,
        );
      }
    }

    const written = entries.filter((entry) => entry.status === "written").length;
    const unchanged = entries.filter((entry) => entry.status === "unchanged").length;
    const skipped = entries.filter((entry) => entry.status === "skipped").length;
    const failed = entries.filter((entry) => entry.status === "failed").length;
    return {
      generatedAt,
      sourceRevisions,
      entries,
      attempted: written + unchanged + failed,
      written,
      unchanged,
      skipped,
      failed,
    };
  }

  private async rebuildWebTranscriptProjections(
    entries: StatusServerProjectionRebuildEntry[],
    pageLimit: number,
  ): Promise<void> {
    const runStore = this.options.runStore;
    if (!runStore) {
      entries.push({
        projectionName: "transcript_projection",
        scopeKind: "run_page",
        scopeKey: "*",
        status: "skipped",
        revision: null,
        reason: "Run transcript store is not configured",
      });
      return;
    }

    const runs = (await runStore.listRuns()).sort(compareRunChronology);
    if (runs.length === 0) {
      entries.push({
        projectionName: "transcript_projection",
        scopeKind: "run_page",
        scopeKey: "*",
        status: "skipped",
        revision: null,
        reason: "No runs available for transcript projection rebuild",
      });
      return;
    }

    for (const run of runs) {
      const recordedScopeKeys = new Set<string>();
      try {
        const tailPage = await this.readTranscriptProjectionSourceTail(run, {
          limit: WEB_TRANSCRIPT_DEFAULT_EVENT_LIMIT,
        });
        await this.recordWebTranscriptProjectionRebuildPage(run, tailPage, entries, recordedScopeKeys);
      } catch (error) {
        entries.push({
          projectionName: "transcript_projection",
          scopeKind: "run_page",
          scopeKey: `${run.runId}:tail:limit:${WEB_TRANSCRIPT_DEFAULT_EVENT_LIMIT}`,
          status: "failed",
          revision: null,
          reason: publicDiagnosticText(errorMessage(error)),
        });
      }

      let offset = 0;
      try {
        do {
          const page = await this.readTranscriptProjectionSourcePage(run, { offset, limit: pageLimit });
          await this.recordWebTranscriptProjectionRebuildPage(run, page, entries, recordedScopeKeys);
          if (page.nextOffset === null) break;
          if (page.nextOffset <= offset) {
            entries.push({
              projectionName: "transcript_projection",
              scopeKind: "run_page",
              scopeKey: transcriptProjectionScopeKey(run, page),
              status: "failed",
              revision: null,
              reason: "Transcript source returned a non-advancing nextOffset cursor",
            });
            break;
          }
          offset = page.nextOffset;
        } while (true);
      } catch (error) {
        entries.push({
          projectionName: "transcript_projection",
          scopeKind: "run_page",
          scopeKey: `${run.runId}:offset:${offset}:limit:${pageLimit}`,
          status: "failed",
          revision: null,
          reason: publicDiagnosticText(errorMessage(error)),
        });
      }
    }
  }

  private async recordWebTranscriptProjectionRebuildPage(
    run: RunRecord,
    page: TranscriptPage,
    entries: StatusServerProjectionRebuildEntry[],
    recordedScopeKeys: Set<string>,
  ): Promise<void> {
    const scopeKey = transcriptProjectionScopeKey(run, page);
    if (recordedScopeKeys.has(scopeKey)) return;
    recordedScopeKeys.add(scopeKey);
    const transcript = projectWebTranscript(page.events, { run });
    const transcriptPayload = projectWebTranscriptWindow(page, transcript, {
      run,
      tailLimit: page.limit,
      kind: page.windowKind ?? "page",
      requestedPage: page.windowKind === "tail" ? null : { offset: page.offset, limit: page.limit },
    });
    await this.recordProjectionRebuildEntry(this.webTranscriptProjectionWriteInput(run, page, transcriptPayload), entries);
  }

  private async readTranscriptProjectionSourceTail(
    run: RunRecord,
    options: { limit: number },
  ): Promise<TranscriptPage> {
    const durablePage = this.options.runActivitySourceStore
      ? await readRunActivityTranscriptTail(this.options.runActivitySourceStore, run, options)
      : null;
    if (durablePage !== null) return durablePage;

    const runStore = this.options.runStore;
    if (!runStore) throw new SymphonyError("invalid_request", "Run transcript store is not configured");
    return runStore.readTranscriptTail(run.runId, options);
  }

  private async readTranscriptProjectionSourcePage(
    run: RunRecord,
    options: { offset: number; limit: number },
  ): Promise<TranscriptPage> {
    const durablePage = this.options.runActivitySourceStore
      ? await readRunActivityTranscriptPage(this.options.runActivitySourceStore, run, options)
      : null;
    if (durablePage !== null) return durablePage;

    const runStore = this.options.runStore;
    if (!runStore) throw new SymphonyError("invalid_request", "Run transcript store is not configured");
    return runStore.readTranscript(run.runId, options);
  }

  private async recordProjectionRebuildEntry(
    input: ProjectionPayloadWriteInput,
    entries: StatusServerProjectionRebuildEntry[],
  ): Promise<void> {
    const requestedBuildMode: ProjectionWriteMode = "rebuild";
    const rebuildInput: ProjectionPayloadWriteInput = { ...input, buildMode: requestedBuildMode };
    const selector = statusServerProjectionRebuildEntrySelector(rebuildInput);
    const writer = this.options.projectionWriter;
    if (!writer) {
      entries.push({
        ...selector,
        status: "skipped",
        revision: null,
        requestedBuildMode,
        buildMode: null,
        reason: "Durable projection writer is not configured",
      });
      return;
    }
    try {
      const result = await writer.writeProjection(rebuildInput);
      entries.push({
        ...selector,
        status: result.status,
        revision: typeof result.revision.revision === "number" ? result.revision.revision : null,
        requestedBuildMode: result.requestedBuildMode ?? requestedBuildMode,
        buildMode: result.buildMode ?? result.revision.buildMode ?? null,
        reason: null,
      });
    } catch (error) {
      entries.push({
        ...selector,
        status: "failed",
        revision: null,
        requestedBuildMode,
        buildMode: null,
        reason: publicDiagnosticText(errorMessage(error)),
      });
    }
  }

  private webDashboardProjectionWriteInput(
    dashboard: ReturnType<typeof projectWebDashboard>,
    input: {
      sourceIndex: BuiltWebProjectionSourceIndex | null;
      activityCount: number;
      issueBoardColumns: IssueBoardColumnMapping;
    },
  ): ProjectionPayloadWriteInput {
    return {
      projectionName: "dashboard_projection",
      projectContextId: this.options.defaultProjectContextId ?? null,
      scopeKind: "global",
      scopeKey: "global",
      payload: dashboard,
      sourceRevisions: statusServerProjectionSourceRevisions(input.sourceIndex, this.options),
      sourceFreshness: statusServerProjectionSourceFreshness(input.sourceIndex),
      sourceCursors: {
        generatedAt: input.sourceIndex?.generatedAt ?? null,
        issueCount: dashboard.totals.all,
        openIssueCount: dashboard.totals.open,
        runningAgentCount: dashboard.runningAgents.length,
        providerGateCount: dashboard.providerGates.length,
        activityCount: input.activityCount,
        issueBoardColumns: input.issueBoardColumns,
      },
      fields: { messageCount: dashboard.activity.length },
    };
  }

  private webIssueBoardProjectionWriteInput(
    issues: ReturnType<typeof projectWebIssueBoard>,
    input: { sourceIndex: BuiltWebProjectionSourceIndex | null; issueBoardColumns: IssueBoardColumnMapping },
  ): ProjectionPayloadWriteInput {
    const fetchedStates = webProjectionIssueBoardFetchStates(input.issueBoardColumns);
    return {
      projectionName: "issue_board_projection",
      projectContextId: this.options.defaultProjectContextId ?? null,
      scopeKind: "board",
      scopeKey: "default-board",
      payload: issues,
      sourceRevisions: statusServerProjectionSourceRevisions(input.sourceIndex, this.options),
      sourceFreshness: statusServerProjectionSourceFreshness(input.sourceIndex),
      sourceCursors: {
        generatedAt: input.sourceIndex?.generatedAt ?? null,
        issueCount: issues.issues.length,
        laneCounts: Object.fromEntries(Object.entries(issues.lanes).map(([lane, cards]) => [lane, cards.length])),
        fetchedStates,
        issueBoardColumns: input.issueBoardColumns,
      },
      fields: {
        fetchedStates,
        messageCount: issues.issues.length,
      },
    };
  }

  private webSidebarProjectionWriteInput(
    sidebar: ReturnType<typeof projectWebSidebar>,
    input: {
      sourceIndex: BuiltWebProjectionSourceIndex | null;
      activityCount: number;
      issueBoardColumns: IssueBoardColumnMapping;
    },
  ): ProjectionPayloadWriteInput {
    return {
      projectionName: "sidebar_projection",
      projectContextId: this.options.defaultProjectContextId ?? null,
      scopeKind: "global",
      scopeKey: "global",
      payload: sidebar,
      sourceRevisions: statusServerProjectionSourceRevisions(input.sourceIndex, this.options),
      sourceFreshness: statusServerProjectionSourceFreshness(input.sourceIndex),
      sourceCursors: {
        generatedAt: input.sourceIndex?.generatedAt ?? null,
        runningAgentCount: sidebar.runningAgents.length,
        reviewIssueCount: sidebar.reviewIssues.length,
        sessionCount: sidebar.sessions.length,
        chatMessageCount: sidebar.chat.length,
        activityCount: input.activityCount,
        issueBoardColumns: input.issueBoardColumns,
      },
      fields: { messageCount: sidebar.activity.length },
    };
  }

  private webHistoryProjectionWriteInput(
    history: ReturnType<typeof projectWebHistory>,
    input: {
      sourceIndex: BuiltWebProjectionSourceIndex | null;
      limits: { sessionLimit: number; timelineLimit: number };
      activityCount: number;
    },
  ): ProjectionPayloadWriteInput {
    return {
      projectionName: "history_projection",
      projectContextId: this.options.defaultProjectContextId ?? null,
      scopeKind: "global_collection",
      scopeKey: historyProjectionScopeKey(input.limits),
      payload: history,
      sourceRevisions: statusServerProjectionSourceRevisions(input.sourceIndex, this.options),
      sourceFreshness: statusServerProjectionSourceFreshness(input.sourceIndex),
      sourceCursors: {
        sessionLimit: input.limits.sessionLimit,
        timelineLimit: input.limits.timelineLimit,
        sessionCount: history.sessions.length,
        timelineCount: history.timeline.length,
        activityCount: input.activityCount,
        defaultSessionId: history.defaultSessionId,
        runIds: history.sessions.map((session) => session.runSession.runId),
      },
      fields: {
        messageCount: history.sessions.length,
      },
    };
  }

  private webTranscriptProjectionWriteInput(
    run: RunRecord,
    page: TranscriptPage,
    transcript: WebTranscriptProjectionPayload,
  ): ProjectionPayloadWriteInput {
    return {
      projectionName: "transcript_projection",
      projectContextId: run.projectContext?.projectContextId ?? this.options.defaultProjectContextId ?? null,
      scopeKind: "run_page",
      scopeKey: transcriptProjectionScopeKey(run, page),
      payload: transcript,
      sourceRevisions: statusServerTranscriptProjectionSourceRevisions(this.options.runStore, run, page),
      sourceCursors: transcriptProjectionSourceCursors(run, page),
      fields: {
        issueKey: run.issueIdentifier || run.issueId,
        runId: run.runId,
        sessionId: run.sessionId,
        offsetStart: page.offset,
        offsetLimit: page.limit,
        nextOffset: page.nextOffset,
        messageCount: transcript.messages.length,
      },
    };
  }

  private webOrchestratorChatProjectionWriteInput(
    chat: OrchestratorChatProjectionPayload,
  ): ProjectionPayloadWriteInput {
    return {
      projectionName: "orchestrator_chat_projection",
      projectContextId: firstChatMetadataString(chat.chat, "projectContextId") ?? this.options.defaultProjectContextId ?? null,
      scopeKind: "conversation",
      scopeKey: orchestratorChatProjectionScopeKey(chat.conversation.id),
      payload: chat,
      sourceRevisions: [
        {
          source: `${ORCHESTRATOR_CHAT_PROJECTION_SOURCE}:${orchestratorChatProjectionScopeKey(chat.conversation.id)}`,
          revision: chat.source.revision,
          observedAt: chat.source.observedAt,
        },
      ],
      sourceCursors: orchestratorChatProjectionSourceCursors(chat),
      fields: {
        conversationKey: orchestratorChatProjectionScopeKey(chat.conversation.id),
        issueKey: firstChatMetadataString(chat.chat, "issueKey", "issueIdentifier"),
        runId: firstChatMetadataString(chat.chat, "runId"),
        messageCount: chat.chat.length,
      },
    };
  }

  private async fetchWebIssueDetail(
    issueId: string,
    forceRefresh: boolean,
    options: { includeTranscript?: boolean; transcriptUrl?: URL } = {},
  ): Promise<WebProjectionJsonResponse<WebIssueDetailModel | null>> {
    let durableRead = await this.webProjectionRepositories.issueBoard.readDefaultBoard({ forceRefresh });
    if (durableRead.status === "hit" && durableRead.record) {
      const durableDetail = await this.buildDurableWebIssueDetailFromIssueBoard(
        durableRead.record.payload,
        issueId,
        durableRead.record,
        options,
      );
      if (durableDetail) return webProjectionJsonResponse(durableDetail, durableRead);
      durableRead = {
        ...durableRead,
        status: "missing_item",
        reason: "issue_detail_not_found_in_current_issue_board_projection",
      };
    }

    if (this.shouldReturnDurableProjectionFallback(forceRefresh)) {
      return webProjectionJsonResponse(null, durableRead);
    }

    try {
      const detail = await this.fetchBoardIssueDetail(issueId, forceRefresh);
      const issueActivityKey =
        detail.issueDetails.issue.id ??
        detail.issueDetails.issue.identifier ??
        detail.boardCard?.issueIdentifier ??
        detail.boardCard?.issueId ??
        issueId;
      const latestRunId = detail.latestRun?.runId ?? detail.runs.at(-1)?.runId ?? null;
      const detailRuns = selectLatestChronologicalRuns(detail.runs, WEB_ISSUE_DETAIL_RUN_LIMIT);
      const activity = await buildActivityFeed({
        generatedAt: detail.issueDetails.tracker.generatedAt ?? this.options.orchestrator.snapshot().generatedAt,
        runStore: this.options.runStore,
        runs: detailRuns,
        lifecycleStore: this.options.lifecycleStore,
        writebackOutbox: this.options.writebackOutbox,
        query: { issue: issueActivityKey, offset: 0, limit: 50 },
        includeTranscriptEvents: false,
        defaultProjectContextId: this.options.defaultProjectContextId,
      });
      const transcript =
        options.includeTranscript === true && this.options.runStore && latestRunId
          ? await readBoundedWebTranscript(this.options.runStore, latestRunId, options.transcriptUrl)
          : [];
      return webProjectionJsonResponse(projectWebIssueDetail({ ...detail, runs: detailRuns, activity, transcript }, issueId), durableRead);
    } catch (error) {
      if (error instanceof SymphonyError && (error.code === "not_found" || error.code === "tracker_unavailable")) {
        return webProjectionJsonResponse(null, durableRead);
      }
      throw error;
    }
  }

  private async buildDurableWebIssueDetailFromIssueBoard(
    board: WebIssueBoardModel,
    issueId: string,
    record: ProjectionPayloadRecord<WebIssueBoardModel>,
    options: { includeTranscript?: boolean; transcriptUrl?: URL } = {},
  ): Promise<WebIssueDetailModel | null> {
    const issue = durableWebIssueFromIssueBoard(board, issueId);
    if (!issue) return null;

    const snapshot = this.options.orchestrator.snapshot();
    const fallbackIssueActivityKey = issue.id || issueId;
    const resolvedIssue = await resolveIssueAliasData({
      requestKey: issueId,
      snapshot,
      runStore: this.options.runStore,
      lifecycleStore: this.options.lifecycleStore,
      defaultProjectContextId: this.options.defaultProjectContextId,
    });
    const issueActivityKey =
      resolvedIssue.status === "resolved"
        ? resolvedIssue.lifecycle?.issueId ??
          resolvedIssue.latestRun?.issueId ??
          resolvedIssue.workspace?.issueId ??
          resolvedIssue.live?.issueId ??
          fallbackIssueActivityKey
        : fallbackIssueActivityKey;
    const issueRuns =
      resolvedIssue.status === "resolved"
        ? resolvedIssue.runs
        : this.options.runStore
          ? (await this.options.runStore.listRuns()).filter((run) => activityRunMatchesIssue(run, issueActivityKey))
          : [];
    const detailRuns = selectLatestChronologicalRuns(issueRuns, WEB_ISSUE_DETAIL_RUN_LIMIT);
    const latestRun = resolvedIssue.status === "resolved" ? resolvedIssue.latestRun ?? detailRuns.at(-1) ?? null : detailRuns.at(-1) ?? null;
    const activity = await buildActivityFeed({
      generatedAt: record.generatedAt || record.revision.generatedAt,
      runStore: this.options.runStore,
      runs: detailRuns,
      lifecycleStore: this.options.lifecycleStore,
      ...(resolvedIssue.status === "resolved" && resolvedIssue.lifecycle ? { lifecycleRecords: [resolvedIssue.lifecycle] } : {}),
      writebackOutbox: this.options.writebackOutbox,
      query: { issue: issueActivityKey, offset: 0, limit: 50 },
      includeTranscriptEvents: false,
      defaultProjectContextId: this.options.defaultProjectContextId,
    });
    const transcript =
      options.includeTranscript === true && this.options.runStore && latestRun
        ? await readBoundedWebTranscript(this.options.runStore, latestRun.runId, options.transcriptUrl)
        : [];
    return {
      issue: cloneJson(issue),
      activity: projectActivityModels(activity),
      runs: detailRuns.map(projectSessionModel),
      transcript: projectTranscriptMessages(transcript, { run: latestRun, includeRunPrelude: transcript.length > 0 }),
    };
  }

  private async fetchWebDashboard(forceRefresh: boolean): Promise<WebProjectionJsonResponse<ReturnType<typeof projectWebDashboard>>> {
    const durableDashboard = await this.webProjectionRepositories.dashboard.readCurrent({ forceRefresh });
    if (durableDashboard.status === "hit" && durableDashboard.record) {
      const dashboard = durableDashboard.record.payload;
      const snapshot = this.options.orchestrator.snapshot();
      const runningAgents = projectRunningAgents(snapshot, snapshot.generatedAt);
      return webProjectionJsonResponse(
        {
          ...dashboard,
          agentUsageLabel: formatAgentUsageLabel(runningAgents.length, dashboard.concurrencyCap),
          providerGates: projectProviderGates(snapshot),
          runningAgents,
        },
        durableDashboard,
      );
    }

    if (this.shouldReturnDurableProjectionFallback(forceRefresh)) {
      return webProjectionJsonResponse(this.buildProjectionFallbackDashboard(), durableDashboard);
    }

    const projection = await this.fetchOptionalWebProjectionSourceIndex(forceRefresh);
    const sourceIndex = projection?.sourceIndex ?? null;
    const snapshot = sourceIndex?.runtime.snapshot ?? this.options.orchestrator.snapshot();
    let board: IssueBoardResponse | null = null;
    if (projection) {
      try {
        board = await this.buildIssueBoardFromSourceIndex(projection.sourceIndex, projection.issueBoardColumns);
      } catch (error) {
        if (!isTrackerProjectionFailure(error)) {
          throw error;
        }
      }
    }
    const activitySources = await this.fetchWebCollectionActivitySources(sourceIndex, WEB_DASHBOARD_RUN_LIMIT);
    const activity = await buildActivityFeed({
      generatedAt: snapshot.generatedAt,
      runStore: this.options.runStore,
      runs: activitySources.runs,
      lifecycleStore: this.options.lifecycleStore,
      lifecycleRecords: activitySources.lifecycleRecords,
      writebackOutbox: this.options.writebackOutbox,
      writebackOperations: activitySources.writebackOperations,
      query: { issue: null, offset: 0, limit: 20 },
      includeTranscriptEvents: false,
    });
    const dashboard = projectWebDashboard({
      runtime: snapshot,
      board,
      activity,
      runs: sourceIndex?.runs.runs ?? activitySources.runs,
      lifecycleRecords: sourceIndex?.lifecycles.records ?? activitySources.lifecycleRecords,
      source: dashboardSourceInputFromSourceIndex(sourceIndex, { activityCount: activity.activity.length }),
      config: this.options.dashboard ?? null,
    });
    await this.persistWebDashboardProjection(dashboard, {
      sourceIndex,
      activityCount: activity.activity.length,
      issueBoardColumns: projection?.issueBoardColumns ?? this.resolveWebProjectionIssueBoardColumns(),
    });
    return webProjectionJsonResponse(dashboard, durableDashboard);
  }

  private async fetchWebOrchestratorChatMessages(
    conversationId?: string | null,
  ): Promise<OrchestratorConversationMessage[]> {
    return selectOrchestratorConversationMessageTail(
      (await this.options.orchestratorConversationStore?.listMessages(conversationId)) ?? [],
    );
  }

  private async fetchWebOrchestratorChatProjection(
    conversationId?: string | null,
  ): Promise<OrchestratorChatProjectionPayload> {
    const record = await this.options.orchestratorConversationStore?.getConversation(conversationId);
    return projectOrchestratorChatProjectionPayload(record ?? null, conversationId);
  }

  private async acceptWebOrchestratorChatPost(input: {
    conversationId?: string | null;
    messageId?: string;
    input: string;
  }): Promise<WebOrchestratorChatPostResult> {
    const store = this.options.orchestratorConversationStore;
    if (!store) {
      return {
        ...webOrchestratorChatErrorResponse(
          503,
          "orchestrator_chat_unavailable",
          "Web orchestrator chat is unavailable because durable conversation storage is not configured",
          [],
        ),
        stateChanged: false,
      };
    }

    if (input.messageId !== undefined) {
      return this.withWebOrchestratorChatMessagePostLock(input.conversationId, input.messageId, () =>
        this.acceptWebOrchestratorChatPostWithStore(store, input),
      );
    }

    return this.acceptWebOrchestratorChatPostWithStore(store, input);
  }

  private async withWebOrchestratorChatMessagePostLock<T>(
    conversationId: string | null | undefined,
    messageId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = webOrchestratorChatMessagePostLockKey(conversationId, messageId);
    const previous = this.pendingWebOrchestratorChatMessagePosts.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.pendingWebOrchestratorChatMessagePosts.set(key, next);
    try {
      return await next;
    } finally {
      if (this.pendingWebOrchestratorChatMessagePosts.get(key) === next) {
        this.pendingWebOrchestratorChatMessagePosts.delete(key);
      }
    }
  }

  private async acceptWebOrchestratorChatPostWithStore(
    store: OrchestratorConversationStore,
    input: { conversationId?: string | null; messageId?: string; input: string },
  ): Promise<WebOrchestratorChatPostResult> {
    let existingMessages: OrchestratorConversationMessage[] = [];
    try {
      existingMessages = input.messageId === undefined ? [] : await store.listMessages(input.conversationId);
    } catch {
      return {
        ...webOrchestratorChatErrorResponse(
          500,
          "orchestrator_chat_persistence_failed",
          "Web orchestrator chat could not inspect existing messages",
          [],
        ),
        stateChanged: false,
      };
    }
    const existingMessage =
      input.messageId === undefined ? undefined : existingMessages.find((message) => message.id === input.messageId);
    if (existingMessage) {
      return webOrchestratorChatReplayResponse(input.input, existingMessage, existingMessages);
    }

    const requestedAt = new Date().toISOString();
    const commandClaimId = randomUUID();
    let message: OrchestratorConversationMessage;
    try {
      message = await store.appendMessage({
        role: "user",
        body: input.input,
        status: "pending",
        at: requestedAt,
        ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
        ...(input.messageId === undefined ? {} : { id: input.messageId }),
        metadata: {
          source: "web_orchestrator_chat",
          action: ORCHESTRATOR_CHAT_POST_ACTION,
          actionDispatched: false,
          commandStatus: "pending",
          commandClaimId,
          commandRequestedAt: requestedAt,
        },
      });
    } catch {
      return {
        ...webOrchestratorChatErrorResponse(
          500,
          "orchestrator_chat_persistence_failed",
          "Web orchestrator chat could not persist the user message",
          [],
        ),
        stateChanged: false,
      };
    }

    if (!webOrchestratorChatMessageMatchesClaim(message, commandClaimId)) {
      let messages: OrchestratorConversationMessage[];
      try {
        messages = selectOrchestratorConversationMessageTail(await store.listMessages(message.conversationId), {
          includeMessageId: message.id,
        });
      } catch {
        messages = [message];
      }
      return webOrchestratorChatReplayResponse(input.input, message, messages);
    }

    const dispatcher = orchestratorChatCommandDispatcher(this.options.orchestrator);
    if (!dispatcher) {
      return this.finalizeWebOrchestratorChatCommand({
        store,
        input,
        message,
        actionDispatched: false,
        result: { status: "unavailable", reason: "orchestrator_chat_command_dispatcher_unavailable" },
      });
    }

    try {
      message = await store.updateMessage({
        conversationId: message.conversationId,
        messageId: message.id,
        status: "pending",
        metadata: webOrchestratorChatCommandDispatchingMetadata(commandClaimId, new Date().toISOString()),
      });
    } catch {
      return {
        ...webOrchestratorChatErrorResponse(
          500,
          "orchestrator_chat_persistence_failed",
          "Web orchestrator chat could not persist the command dispatch claim",
          projectWebOrchestratorChatPost(input.input, [message]),
        ),
        stateChanged: true,
      };
    }

    let result: OrchestratorChatCommandResult;
    try {
      result = await dispatcher.dispatchOrchestratorChatCommand({
        action: ORCHESTRATOR_CHAT_POST_ACTION,
        source: "web",
        conversationId: message.conversationId,
        messageId: message.id,
        input: message.body,
        requestedAt,
      });
    } catch {
      result = { status: "failed", reason: "orchestrator_chat_command_dispatch_failed" };
    }

    return this.finalizeWebOrchestratorChatCommand({
      store,
      input,
      message,
      actionDispatched: true,
      result,
    });
  }

  private async finalizeWebOrchestratorChatCommand(input: {
    store: OrchestratorConversationStore;
    conversationId?: string | null;
    message?: OrchestratorConversationMessage;
    input: { conversationId?: string | null; input: string };
    actionDispatched: boolean;
    result: OrchestratorChatCommandResult;
  }): Promise<WebOrchestratorChatPostResult> {
    const message = input.message;
    if (!message) {
      return {
        ...webOrchestratorChatErrorResponse(
          500,
          "orchestrator_chat_persistence_failed",
          "Web orchestrator chat could not persist the user message",
          [],
        ),
        stateChanged: false,
      };
    }
    let messages: OrchestratorConversationMessage[];
    try {
      await input.store.updateMessage({
        conversationId: message.conversationId,
        messageId: message.id,
        status: webOrchestratorChatMessageStatusFromCommandResult(input.result.status),
        metadata: webOrchestratorChatCommandMetadata(input.result, input.actionDispatched),
      });
      messages = selectOrchestratorConversationMessageTail(await input.store.listMessages(message.conversationId), {
        includeMessageId: message.id,
      });
    } catch {
      let recoveryMessage = message;
      if (input.actionDispatched) {
        try {
          recoveryMessage = await input.store.updateMessage({
            conversationId: message.conversationId,
            messageId: message.id,
            status: "failed",
            metadata: webOrchestratorChatCommandMetadata(
              { status: "failed", reason: "orchestrator_chat_command_state_persistence_failed" },
              true,
            ),
          });
        } catch {
          // The pre-dispatch claim already records that the side effect crossed the boundary.
          // If even the repair update fails, expose that honest claimed state rather than the
          // original pending append projection.
        }
      }
      try {
        messages = selectOrchestratorConversationMessageTail(await input.store.listMessages(message.conversationId), {
          includeMessageId: message.id,
        });
      } catch {
        messages = [recoveryMessage];
      }
      return {
        ...webOrchestratorChatErrorResponse(
          500,
          "orchestrator_chat_persistence_failed",
          "Web orchestrator chat could not persist the command state update",
          projectWebOrchestratorChatPost(input.input.input, messages),
        ),
        stateChanged: true,
      };
    }

    if (input.result.status === "accepted") {
      return { status: 202, body: projectWebOrchestratorChatPost(input.input.input, messages), stateChanged: true };
    }
    return {
      ...webOrchestratorChatErrorResponse(
        webOrchestratorChatHttpStatusFromCommandResult(input.result.status),
        webOrchestratorChatErrorCodeFromCommandResult(input.result.status),
        webOrchestratorChatErrorMessageFromCommandResult(input.result.status),
        projectWebOrchestratorChatPost(input.input.input, messages),
      ),
      stateChanged: true,
    };
  }

  private async fetchWebSidebar(forceRefresh: boolean): Promise<WebProjectionJsonResponse<ReturnType<typeof projectWebSidebar>>> {
    const durableSidebar = await this.webProjectionRepositories.sidebar.readCurrent({ forceRefresh });
    if (durableSidebar.status === "hit" && durableSidebar.record) {
      const sidebar = durableSidebar.record.payload;
      const snapshot = this.options.orchestrator.snapshot();
      const runningAgents = projectRunningAgents(snapshot, snapshot.generatedAt);
      const normalizedHistory = applyWebHistoryRuntimeLiveness(
        { sessions: sidebar.sessions, transcriptBySession: {}, timeline: [], defaultSessionId: "" },
        snapshot,
      );
      return webProjectionJsonResponse(
        {
          ...sidebar,
          providerGates: projectProviderGates(snapshot),
          runningAgents,
          sessions: normalizedHistory.sessions,
        },
        durableSidebar,
      );
    }

    if (this.shouldReturnDurableProjectionFallback(forceRefresh)) {
      return webProjectionJsonResponse(this.buildProjectionFallbackSidebar(), durableSidebar);
    }

    const projection = await this.fetchOptionalWebProjectionSourceIndex(forceRefresh);
    const sourceIndex = projection?.sourceIndex ?? null;
    const snapshot = sourceIndex?.runtime.snapshot ?? this.options.orchestrator.snapshot();
    let board: IssueBoardResponse | null = null;
    if (projection) {
      try {
        board = await this.buildIssueBoardFromSourceIndex(projection.sourceIndex, projection.issueBoardColumns);
      } catch (error) {
        if (!isTrackerProjectionFailure(error)) {
          throw error;
        }
      }
    }
    const activitySources = await this.fetchWebCollectionActivitySources(sourceIndex, WEB_SIDEBAR_SESSION_LIMIT);
    const historyActivity = await buildActivityFeed({
      generatedAt: snapshot.generatedAt,
      runStore: this.options.runStore,
      runs: activitySources.runs,
      lifecycleStore: this.options.lifecycleStore,
      lifecycleRecords: activitySources.lifecycleRecords,
      writebackOutbox: this.options.writebackOutbox,
      writebackOperations: activitySources.writebackOperations,
      query: { issue: null, offset: 0, limit: WEB_SIDEBAR_HISTORY_TIMELINE_LIMIT },
      includeTranscriptEvents: false,
    });
    const dashboardActivity = previewActivityFeed(historyActivity, 20);
    const dashboard = projectWebDashboard({
      runtime: snapshot,
      board,
      activity: dashboardActivity,
      runs: sourceIndex?.runs.runs ?? activitySources.runs,
      lifecycleRecords: sourceIndex?.lifecycles.records ?? activitySources.lifecycleRecords,
      config: this.options.dashboard ?? null,
    });
    const issues = projectWebIssueBoard(board);
    const history = projectWebHistory(activitySources.runs, historyActivity.activity, { runtime: snapshot, activityRuns: activitySources.runs });
    const chat = projectWebOrchestratorChat(await this.fetchWebOrchestratorChatMessages());
    const sidebar = projectWebSidebar(dashboard, issues, history, chat);
    await this.persistWebSidebarProjection(sidebar, {
      sourceIndex,
      activityCount: historyActivity.activity.length,
      issueBoardColumns: projection?.issueBoardColumns ?? this.resolveWebProjectionIssueBoardColumns(),
    });
    return webProjectionJsonResponse(sidebar, durableSidebar);
  }

  private async fetchWebHistory(forceRefresh: boolean, url: URL): Promise<WebProjectionJsonResponse<ReturnType<typeof projectWebHistory>>> {
    const limits = parseWebHistoryLimits(url);
    const durableHistory = await this.webProjectionRepositories.history.readGlobalCollection(limits, { forceRefresh });
    if (durableHistory.status === "hit" && durableHistory.record) {
      return webProjectionJsonResponse(
        applyWebHistoryRuntimeLiveness(durableHistory.record.payload, this.options.orchestrator.snapshot()),
        durableHistory,
      );
    }

    const projection = await this.fetchOptionalWebProjectionSourceIndex(forceRefresh);
    const sourceIndex = projection?.sourceIndex ?? null;
    const snapshot = sourceIndex?.runtime.snapshot ?? this.options.orchestrator.snapshot();
    const activitySources = await this.fetchWebCollectionActivitySources(
      sourceIndex,
      Math.max(limits.sessionLimit, limits.timelineLimit),
    );
    const runs = selectRecentRuns(activitySources.runs, limits.sessionLimit);
    const activityRuns = selectRecentRuns(activitySources.runs, limits.timelineLimit);
    const activityFeed = await buildActivityFeed({
      generatedAt: snapshot.generatedAt,
      runStore: this.options.runStore,
      runs: activityRuns,
      lifecycleStore: this.options.lifecycleStore,
      lifecycleRecords: activitySources.lifecycleRecords,
      writebackOutbox: this.options.writebackOutbox,
      writebackOperations: activitySources.writebackOperations,
      query: { issue: null, offset: 0, limit: limits.timelineLimit },
      includeTranscriptEvents: false,
    });
    const history = projectWebHistory(runs, activityFeed.activity, { runtime: snapshot, activityRuns });
    await this.persistWebHistoryProjection(history, {
      sourceIndex,
      limits,
      activityCount: activityFeed.activity.length,
    });
    return webProjectionJsonResponse(history, durableHistory);
  }

  private async persistWebDashboardProjection(
    dashboard: ReturnType<typeof projectWebDashboard>,
    input: {
      sourceIndex: BuiltWebProjectionSourceIndex | null;
      activityCount: number;
      issueBoardColumns: IssueBoardColumnMapping;
    },
  ): Promise<void> {
    await this.persistProjection(this.webDashboardProjectionWriteInput(dashboard, input));
  }

  private async persistWebIssueBoardProjection(
    issues: ReturnType<typeof projectWebIssueBoard>,
    input: { sourceIndex: BuiltWebProjectionSourceIndex | null; issueBoardColumns: IssueBoardColumnMapping },
  ): Promise<void> {
    await this.persistProjection(this.webIssueBoardProjectionWriteInput(issues, input));
  }

  private async persistWebSidebarProjection(
    sidebar: ReturnType<typeof projectWebSidebar>,
    input: {
      sourceIndex: BuiltWebProjectionSourceIndex | null;
      activityCount: number;
      issueBoardColumns: IssueBoardColumnMapping;
    },
  ): Promise<void> {
    await this.persistProjection(this.webSidebarProjectionWriteInput(sidebar, input));
  }

  private async persistWebHistoryProjection(
    history: ReturnType<typeof projectWebHistory>,
    input: {
      sourceIndex: BuiltWebProjectionSourceIndex | null;
      limits: { sessionLimit: number; timelineLimit: number };
      activityCount: number;
    },
  ): Promise<void> {
    await this.persistProjection(this.webHistoryProjectionWriteInput(history, input));
  }

  private async persistWebTranscriptProjection(
    run: RunRecord,
    page: TranscriptPage,
    transcript: WebTranscriptProjectionPayload,
  ): Promise<void> {
    await this.persistProjection(this.webTranscriptProjectionWriteInput(run, page, transcript));
  }

  private async persistWebOrchestratorChatProjection(
    chat: OrchestratorChatProjectionPayload,
  ): Promise<void> {
    await this.persistProjection(this.webOrchestratorChatProjectionWriteInput(chat));
  }

  private async persistProjection(input: ProjectionPayloadWriteInput): Promise<void> {
    const writer = this.options.projectionWriter;
    if (!writer) return;
    try {
      await writer.writeProjection({ ...input, buildMode: input.buildMode ?? "incremental" });
    } catch {
      // Durable projection rows are cache/read-model side effects. The status API
      // response is derived from canonical stores during this transition phase,
      // so projection persistence failures must not make the UI unavailable.
    }
  }

  private hasDurableProjectionReader(): boolean {
    return Boolean(this.options.projectionReader);
  }

  private hasDurableProjectionWriter(): boolean {
    return Boolean(this.options.projectionWriter);
  }

  private shouldReturnDurableProjectionFallback(forceRefresh: boolean): boolean {
    return this.hasDurableProjectionReader() && (!forceRefresh || !this.hasDurableProjectionWriter());
  }

  private shouldReturnDurableOrchestratorChatFallback(
    read: DurableProjectionReadResult<unknown>,
    forceRefresh: boolean,
  ): boolean {
    if (!this.hasDurableProjectionReader()) return false;
    if (forceRefresh && this.hasDurableProjectionWriter()) return false;
    if (read.status === "expired" && this.hasDurableProjectionWriter()) return false;
    return true;
  }

  private buildProjectionFallbackDashboard(): ReturnType<typeof projectWebDashboard> {
    return projectWebDashboard({
      config: this.options.dashboard ?? null,
    });
  }

  private buildProjectionFallbackSidebar(): ReturnType<typeof projectWebSidebar> {
    return projectWebSidebar(
      this.buildProjectionFallbackDashboard(),
      projectWebIssueBoard(null),
      projectWebHistory([], []),
      [],
    );
  }

  private async isDurableProjectionRecordCurrent(record: ProjectionPayloadRecord): Promise<boolean> {
    const orchestratorChatRecordCurrent = await this.isDurableOrchestratorChatProjectionRecordCurrent(record);
    if (orchestratorChatRecordCurrent !== null) return orchestratorChatRecordCurrent;
    if (record.revision.projectionName === "history_projection" && !isWebHistoryProjectionPayloadCurrent(record.payload)) {
      return false;
    }
    if (record.revision.projectionName === "sidebar_projection" && !isWebSidebarProjectionPayloadCurrent(record.payload)) {
      return false;
    }

    const currentRevisions = projectionCurrentSourceRevisionsForRead(
      record.revision.projectionName,
      await this.resolveWebProjectionSourceRevisions(),
    );
    return projectionSourceRevisionsCompatible(record.revision.sourceRevisions, currentRevisions);
  }

  private async isDurableOrchestratorChatProjectionRecordCurrent(
    record: ProjectionPayloadRecord,
  ): Promise<boolean | null> {
    if (record.revision.projectionName !== "orchestrator_chat_projection") return null;
    const store = this.options.orchestratorConversationStore;
    if (!store) return null;
    const conversationSource = `${ORCHESTRATOR_CHAT_PROJECTION_SOURCE}:${record.revision.scopeKey}`;
    const storedRevision = record.revision.sourceRevisions.find((revision) => revision.source === conversationSource);
    if (!storedRevision) return null;
    const conversation = await store.getConversation(record.revision.scopeKey);
    const currentProjection = projectOrchestratorChatProjectionPayload(conversation, record.revision.scopeKey);
    return String(storedRevision.revision) === currentProjection.source.revision;
  }

  private async fetchOptionalWebProjectionSourceIndex(forceRefresh: boolean): Promise<{
    sourceIndex: BuiltWebProjectionSourceIndex;
    issueBoardColumns: IssueBoardColumnMapping;
  } | null> {
    try {
      return await this.fetchWebProjectionSourceIndex(forceRefresh);
    } catch (error) {
      if (isTrackerProjectionFailure(error)) return null;
      throw error;
    }
  }

  private async fetchWebCollectionActivitySources(
    sourceIndex: BuiltWebProjectionSourceIndex | null,
    runLimit?: number,
  ): Promise<{
    runs: readonly RunRecord[];
    lifecycleRecords: readonly IssueLifecycleRecord[];
    writebackOperations: readonly WritebackOperation[];
  }> {
    const limitRuns = (runs: readonly RunRecord[]) =>
      typeof runLimit === "number" ? selectRecentRuns(runs, runLimit) : runs;
    if (sourceIndex) {
      return {
        runs: limitRuns(sourceIndex.runs.runs),
        lifecycleRecords: sourceIndex.lifecycles.records,
        writebackOperations: sourceIndex.writebacks.operations,
      };
    }
    const [runs, lifecycleRecords, writebackOperations] = await Promise.all([
      this.options.runStore?.listRuns() ?? Promise.resolve([]),
      this.options.lifecycleStore?.list() ?? Promise.resolve([]),
      this.options.writebackOutbox?.list() ?? Promise.resolve([]),
    ]);
    return { runs: limitRuns(runs), lifecycleRecords, writebackOperations };
  }

  private async fetchIssueBoard(forceRefresh: boolean): Promise<IssueBoardResponse> {
    const { sourceIndex, issueBoardColumns } = await this.fetchWebProjectionSourceIndex(forceRefresh);
    return this.buildIssueBoardFromSourceIndex(sourceIndex, issueBoardColumns);
  }

  private async buildIssueBoardFromSourceIndex(
    sourceIndex: BuiltWebProjectionSourceIndex,
    issueBoardColumns: IssueBoardColumnMapping,
  ): Promise<IssueBoardResponse> {
    return buildIssueBoard({
      sourceIndex,
      mutationsConfigured: Boolean(this.options.openWorkspaceToken),
      runStore: this.options.runStore,
      trackerStateLists: this.options.trackerStateLists,
      issueBoardColumns,
      staleThresholdMs: this.options.staleThresholdMs,
      continuationSummaryAvailable: Boolean(this.options.lifecycleStore && this.options.runStore),
    });
  }

  private resolveBoardIssueLookup(issueId: string, sourceIndex: BuiltWebProjectionSourceIndex): IssueLookupResult {
    const lookupCandidates = dedupeIssueLookupCandidates([
      ...(sourceIndex.trackerIssues.error ? [] : sourceIndex.trackerIssues.issues.map(issueLookupCandidateFromIssue)),
      ...sourceIndex.runtime.snapshot.running.map(issueLookupCandidateFromRunningRow),
      ...sourceIndex.lifecycles.records.map(issueLookupCandidateFromLifecycle),
      ...sourceIndex.workspaces.workspaces.map(issueLookupCandidateFromWorkspace),
      ...sourceIndex.runs.runs.map(issueLookupCandidateFromRun),
    ].filter((candidate): candidate is IssueLookupCandidate => candidate !== null));
    const direct = resolveIssueLookupFromCandidates(issueId, lookupCandidates);
    if (direct.issueId !== null || direct.ambiguousCandidates.length > 0) return direct;

    const parsedIssueAlias = parseContextualAlias(issueId);
    if (parsedIssueAlias.projectContextId === null) return direct;

    const resolution = resolveContextualAliasMatches({
      requestKey: issueId,
      candidates: buildIssueAliasCandidates({
        snapshot: sourceIndex.runtime.snapshot,
        trackerIssues: sourceIndex.trackerIssues.error ? [] : sourceIndex.trackerIssues.issues,
        runs: sourceIndex.runs.runs,
        workspaces: sourceIndex.workspaces.workspaces,
        lifecycles: sourceIndex.lifecycles.records,
      }),
      aliasValues: issueAliasValuesForCandidate,
      projectContextId: issueAliasCandidateProjectContextId,
      defaultProjectContextId: this.options.defaultProjectContextId,
    });
    if (resolution.status !== "resolved" || resolution.matches.length === 0) return direct;

    const contextualCandidates = dedupeIssueLookupCandidates(
      resolution.matches
        .map(issueLookupCandidateFromAliasCandidate)
        .filter((candidate): candidate is IssueLookupCandidate => candidate !== null),
    );
    if (contextualCandidates.length === 1) {
      return {
        issueId: contextualCandidates[0]?.issueId ?? null,
        ambiguousCandidates: [],
        resolutionKind: "contextual_alias",
        refreshTrackerCache: resolution.matches.some((candidate) => candidate.kind === "tracker"),
      };
    }

    return {
      issueId: null,
      ambiguousCandidates: contextualCandidates.length > 1 ? contextualCandidates : [],
      resolutionKind: "unresolved",
    };
  }

  private async fetchBoardIssueDetail(issueId: string, forceRefresh: boolean) {
    let { sourceIndex, issueBoardColumns } = await this.fetchWebProjectionSourceIndex(forceRefresh);
    let lookup = this.resolveBoardIssueLookup(issueId, sourceIndex);
    const refreshTrackerLookup =
      Boolean(this.options.tracker) && sourceIndex.trackerIssues.cached && (lookup.resolutionKind === "issue_identifier" || lookup.refreshTrackerCache === true);
    if (refreshTrackerLookup) {
      ({ sourceIndex, issueBoardColumns } = await this.fetchWebProjectionSourceIndex(true));
      lookup = this.resolveBoardIssueLookup(issueId, sourceIndex);
    }
    if (lookup.ambiguousCandidates.length > 0) throw ambiguousIssueLookupError(issueId, lookup.ambiguousCandidates);
    if (
      this.options.tracker &&
      sourceIndex.trackerIssues.error &&
      (lookup.resolutionKind === "issue_identifier" || lookup.refreshTrackerCache === true || refreshTrackerLookup)
    ) {
      throw trackerFailureFromSourceIndex(sourceIndex);
    }
    const lookupIssueId = lookup.issueId ?? issueId;
    let board: IssueBoardResponse | null = null;
    let trackerFailure: SymphonyError | null = null;
    if (sourceIndex.trackerIssues.error) {
      trackerFailure = trackerFailureFromSourceIndex(sourceIndex);
    } else {
      board = await buildIssueBoard({
        sourceIndex,
        mutationsConfigured: Boolean(this.options.openWorkspaceToken),
        runStore: this.options.runStore,
        trackerStateLists: this.options.trackerStateLists,
        issueBoardColumns,
        staleThresholdMs: this.options.staleThresholdMs,
        continuationSummaryAvailable: Boolean(this.options.lifecycleStore && this.options.runStore),
      });
    }

    const card = board?.issues.find((item) => hasBoardKey(new Set(boardCardKeys(item)), [lookupIssueId])) ?? null;
    const detail = await buildBoardIssueDetail({
      requestKey: lookupIssueId,
      card,
      sourceIndex,
      mutationsConfigured: Boolean(this.options.openWorkspaceToken),
      runStore: this.options.runStore,
      mcpExposureDiagnosticsStore: this.options.mcpExposureDiagnosticsStore,
      trackerStateLists: this.options.trackerStateLists,
      staleThresholdMs: this.options.staleThresholdMs,
      continuationSummaryAvailable: Boolean(this.options.lifecycleStore && this.options.runStore),
    });
    if (detail) return detail;
    if (trackerFailure) throw trackerFailure;
    throw new SymphonyError("not_found", `Board issue not found: ${issueId}`);
  }

  private async fetchWebProjectionSourceIndex(forceRefresh: boolean): Promise<{
    sourceIndex: BuiltWebProjectionSourceIndex;
    issueBoardColumns: IssueBoardColumnMapping;
  }> {
    const acquired = await this.acquireWebProjectionContextEntry(forceRefresh);
    const sourceIndex = acquired.reusedCompleted
      ? webProjectionSourceIndexWithTrackerCacheHit(acquired.context.sourceIndex)
      : acquired.context.sourceIndex;
    this.publishTrackerSourceStatusIfChanged(sourceIndex);
    return {
      sourceIndex,
      issueBoardColumns: this.resolveWebProjectionIssueBoardColumns(),
    };
  }

  async acquireWebProjectionContext(forceRefresh: boolean): Promise<StatusServerWebProjectionContext> {
    const context = (await this.acquireWebProjectionContextEntry(forceRefresh)).context;
    assertCompletedWebProjectionContextCacheable(context);
    return context;
  }

  private async acquireWebProjectionContextEntry(
    forceRefresh: boolean,
  ): Promise<StatusServerWebProjectionContextAcquireResult> {
    const clock = this.options.webProjectionContextClock ?? (() => new Date());
    const now = clock();
    const snapshot = this.options.orchestrator.snapshot();
    const issueBoardColumns = this.resolveWebProjectionIssueBoardColumns();
    const fingerprint = await this.createWebProjectionContextFingerprint(snapshot, issueBoardColumns);
    const fingerprintKey = webProjectionFingerprintCacheKey(fingerprint);
    const completed = this.completedWebProjectionContext;
    if (
      completed &&
      !forceRefresh &&
      !isWebProjectionContextExpired(completed, now) &&
      webProjectionFingerprintCacheKey(completed.metadata.fingerprint) === fingerprintKey
    ) {
      return { context: completed, reusedCompleted: true };
    }

    const pendingKey = webProjectionContextPendingKey(forceRefresh, fingerprintKey);
    const pending = this.pendingWebProjectionContexts.get(pendingKey);
    if (pending) return { context: await pending, reusedCompleted: false };

    const metadata = createWebProjectionCacheMetadata({
      builtAt: now,
      maxAgeMs: WEB_PROJECTION_CONTEXT_TTL_MS,
      fingerprint,
    });
    const promise = this.buildWebProjectionContext({
      metadata,
      fingerprint,
      forceRefresh,
      snapshot,
      issueBoardColumns,
      clock,
    });
    this.pendingWebProjectionContexts.set(pendingKey, promise);

    try {
      const context = await promise;
      if (
        this.pendingWebProjectionContexts.get(pendingKey) === promise &&
        isCompletedWebProjectionContextCacheable(context) &&
        (await this.isWebProjectionContextCurrent(context, issueBoardColumns))
      ) {
        this.completedWebProjectionContext = context;
      }
      return { context, reusedCompleted: false };
    } finally {
      if (this.pendingWebProjectionContexts.get(pendingKey) === promise) {
        this.pendingWebProjectionContexts.delete(pendingKey);
      }
    }
  }

  private async buildWebProjectionContext(
    input: StatusServerWebProjectionContextBuildInput,
  ): Promise<StatusServerWebProjectionContext> {
    const builder = this.options.webProjectionContextBuilder;
    if (builder) return builder(input);
    const sourceIndex = await buildWebProjectionSourceIndex({
      snapshot: input.snapshot,
      issueBoardColumns: input.issueBoardColumns,
      defaultProjectContextId: this.options.defaultProjectContextId,
      ...(this.options.tracker
        ? { fetchTrackerProjection: ({ columns, forceRefresh }) => this.fetchIssueBoardTrackerProjection(columns, forceRefresh, input.clock) }
        : {}),
      forceRefresh: input.forceRefresh,
      clock: input.clock,
      durableSourceRevisions: input.fingerprint.durableSourceRevisions,
      ...(this.options.runStore ? { runStore: this.options.runStore } : {}),
      ...(this.options.lifecycleStore ? { lifecycleStore: this.options.lifecycleStore } : {}),
      ...(this.options.writebackOutbox ? { writebackOutbox: this.options.writebackOutbox } : {}),
    });
    return { metadata: input.metadata, sourceIndex, projections: {} };
  }

  private resolveWebProjectionIssueBoardColumns(): IssueBoardColumnMapping {
    return this.options.issueBoardColumns ?? defaultWebProjectionIssueBoardColumns(this.options.trackerStateLists);
  }

  private async resolveRouteIssueLookup(
    issueKey: string,
    snapshot: RuntimeSnapshot = this.options.orchestrator.snapshot(),
  ): Promise<IssueLookupResult> {
    const resolveLookup = async (trackerIssues: readonly Issue[]): Promise<IssueLookupResult> =>
      resolveIssueLookupKey(issueKey, {
        snapshot,
        lifecycleStore: this.options.lifecycleStore,
        runStore: this.options.runStore,
        trackerIssues,
      });

    const initialTrackerLookup = await this.loadTrackerIssuesForRouteLookup();
    let lookup = await resolveLookup(initialTrackerLookup.trackerIssues);
    if (lookup.resolutionKind === "issue_identifier") {
      if (initialTrackerLookup.trackerFailure) {
        throw initialTrackerLookup.trackerFailure;
      }
      if (initialTrackerLookup.trackerCached) {
        const refreshedTrackerLookup = await this.loadTrackerIssuesForRouteLookup(true);
        lookup = await resolveLookup(refreshedTrackerLookup.trackerIssues);
        if (refreshedTrackerLookup.trackerFailure) {
          throw refreshedTrackerLookup.trackerFailure;
        }
      }
    }
    return lookup;
  }

  private async loadTrackerIssuesForRouteLookup(forceRefresh = false): Promise<{
    trackerIssues: readonly Issue[];
    trackerFailure: SymphonyError | null;
    trackerCached: boolean;
  }> {
    if (!this.options.tracker) return { trackerIssues: [], trackerFailure: null, trackerCached: false };
    try {
      const projection = await this.fetchIssueBoardTrackerProjection(
        this.resolveWebProjectionIssueBoardColumns(),
        forceRefresh,
      );
      return { trackerIssues: projection.trackerIssues, trackerFailure: null, trackerCached: projection.cached };
    } catch (error) {
      if (error instanceof SymphonyError && (error.code === "tracker_error" || error.code === "tracker_unavailable")) {
        return { trackerIssues: [], trackerFailure: error, trackerCached: false };
      }
      throw error;
    }
  }

  private async createWebProjectionContextFingerprint(
    snapshot: RuntimeSnapshot,
    issueBoardColumns: IssueBoardColumnMapping,
  ): Promise<WebProjectionCacheFingerprint> {
    const fetchedStates = webProjectionIssueBoardFetchStates(issueBoardColumns);
    const [durableSourceRevisions, durableProjectionRevisions] = await Promise.all([
      this.resolveWebProjectionSourceRevisions(),
      this.resolveWebProjectionDurableProjectionRevisions(),
    ]);
    return createWebProjectionFingerprint({
      runtimeGeneratedAt: statusServerRuntimeFingerprintKey(snapshot),
      defaultProjectContextId: this.options.defaultProjectContextId,
      issueBoardStates: [issueBoardFetchedStateCacheKey(fetchedStates)],
      issueBoardColumns: issueBoardColumnCacheKeyValues(issueBoardColumns),
      durableSourceRevisions,
      durableProjectionRevisions,
    });
  }

  private async resolveWebProjectionSourceRevisions(): Promise<readonly WebProjectionSourceRevision[]> {
    const providers = this.webProjectionRevisionProviders;
    if (providers.length === 0) return [];
    return Promise.all(providers.map((provider) => provider.getRevision()));
  }

  private async resolveWebProjectionDurableProjectionRevisions(): Promise<readonly WebProjectionSourceRevision[]> {
    const reader = this.options.projectionReader;
    if (!reader?.readCurrentRevision) return [];
    return Promise.all(
      statusServerWebProjectionContextDurableRevisionSelectors(this.options.defaultProjectContextId).map(async (selector) => {
        try {
          for (const attemptSelector of compatibleProjectionRevisionSelectors(selector, this.options.defaultProjectContextId)) {
            const record = await reader.readCurrentRevision!(attemptSelector);
            if (record) return durableProjectionRevisionFingerprint(selector, record);
          }
          return durableProjectionRevisionFingerprint(selector, null);
        } catch {
          return durableProjectionRevisionFingerprint(selector, null, "error");
        }
      }),
    );
  }

  private async isWebProjectionContextCurrent(
    context: StatusServerWebProjectionContext,
    issueBoardColumns: IssueBoardColumnMapping,
  ): Promise<boolean> {
    const generationBeforeFingerprint = this.webProjectionDirtyGeneration;
    const currentFingerprint = await this.createWebProjectionContextFingerprint(
      this.options.orchestrator.snapshot(),
      issueBoardColumns,
    );
    return (
      this.webProjectionDirtyGeneration === generationBeforeFingerprint &&
      webProjectionFingerprintCacheKey(context.metadata.fingerprint) === webProjectionFingerprintCacheKey(currentFingerprint)
    );
  }

  private async fetchIssueBoardTrackerProjection(
    columns: IssueBoardColumnMapping,
    forceRefresh: boolean,
    clock: WebProjectionClock = () => new Date(),
  ): Promise<IssueBoardTrackerProjection> {
    const tracker = this.options.tracker;
    if (!tracker) {
      throw new SymphonyError("tracker_unavailable", "Issue board requires a configured tracker client");
    }

    const fetchedStates = webProjectionIssueBoardFetchStates(columns);
    const cacheKey = issueBoardFetchedStateCacheKey(fetchedStates);
    const nowDate = clock();
    const now = nowDate.getTime();
    const cached = this.issueBoardTrackerCache;
    if (
      cached &&
      !forceRefresh &&
      cached.cacheKey === cacheKey &&
      now - cached.fetchedAtMs <= this.options.staleThresholdMs
    ) {
      return { ...cached.projection, cached: true };
    }

    try {
      const trackerIssues = await tracker.fetchIssuesByStates(fetchedStates);
      const projection = {
        fetchedStates,
        trackerIssues,
        fetchedAt: nowDate.toISOString(),
        cached: false,
      };
      this.issueBoardTrackerCache = {
        cacheKey,
        fetchedAtMs: now,
        projection,
      };
      return projection;
    } catch (error) {
      if (error instanceof SymphonyError) throw error;
      throw new SymphonyError("tracker_error", `Issue board tracker fetch failed: ${errorMessage(error)}`);
    }
  }
}

function webProjectionSourceRevisionFromProjectionPublication(
  publication: ProjectionRevisionPublication,
): WebProjectionSourceRevision {
  return {
    source: durableProjectionRealtimeSource(publication),
    revision: publication.revision,
    observedAt: publication.generatedAt,
    detail: realtimeDetailFromProjectionPublication(publication),
  };
}

function durableProjectionRealtimeSource(publication: ProjectionRevisionPublication): string {
  return `${publication.projectionName}:${publication.scopeKind}:${publication.scopeKey}`;
}

function realtimeDetailFromProjectionPublication(publication: ProjectionRevisionPublication): Readonly<Record<string, unknown>> {
  const sourceCursors = realtimeSafeRecord(publication.sourceCursors);
  const sourceFreshness = publication.sourceFreshness.map(realtimeSourceFreshnessDetail);
  const primaryFreshness = sourceFreshness[0] ?? null;
  const detail: Record<string, unknown> = {
    source: "projection",
    projectionName: publication.projectionName,
    scopeKind: publication.scopeKind,
    scopeKey: publication.scopeKey,
    projectionRevisionId: publication.projectionRevisionId,
    contentSha256: publication.contentSha256,
    expiresAt: publication.expiresAt,
    resourcesChanged: realtimeResourceKindsForDurableProjection(publication.projectionName),
    sourceRevisions: publication.sourceRevisions.map(realtimeProjectionSourceRevisionDetail),
    sourceCursors,
    sourceFreshness,
  };

  if (primaryFreshness) {
    detail.checkedAt = recordStringValue(primaryFreshness, "checkedAt");
    detail.fetchedAt = recordStringValue(primaryFreshness, "checkedAt");
  }

  return {
    ...detail,
    ...durableProjectionSpecificRealtimeDetail(publication, sourceCursors),
  };
}

function realtimeProjectionSourceRevisionDetail(revision: ProjectionSourceRevision): Record<string, unknown> {
  return { source: revision.source, revision: revision.revision, observedAt: revision.observedAt };
}

function realtimeSourceFreshnessDetail(freshness: ProjectionSourceFreshness): Record<string, unknown> {
  return realtimeSafeRecord({
    source: freshness.source,
    status: freshness.status,
    checkedAt: freshness.checkedAt,
    revision: freshness.revision,
    lastSuccessAt: freshness.lastSuccessAt,
    lastErrorAt: freshness.lastErrorAt,
    staleMs: freshness.staleMs,
    detail: freshness.detail,
  });
}

function durableProjectionSpecificRealtimeDetail(
  publication: ProjectionRevisionPublication,
  sourceCursors: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  switch (publication.projectionName) {
    case "transcript_projection":
      return transcriptProjectionRealtimeDetail(sourceCursors);
    case "orchestrator_chat_projection":
      return orchestratorChatProjectionRealtimeDetail(publication, sourceCursors);
    case "dashboard_projection":
    case "issue_board_projection":
    case "sidebar_projection":
    case "history_projection":
      return {};
  }
}

function transcriptProjectionRealtimeDetail(sourceCursors: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const firstSequence = recordNumberValue(sourceCursors, "firstSequence");
  const afterSequence =
    recordNumberValue(sourceCursors, "afterSequence") ??
    (firstSequence === null ? recordNumberValue(sourceCursors, "offset") : Math.max(0, firstSequence - 1));
  const detail: Record<string, unknown> = {};
  copyStringRecordField(detail, sourceCursors, "runId");
  copyStringRecordField(detail, sourceCursors, "sessionId");
  copyStringRecordField(detail, sourceCursors, "issueKey");
  if (typeof detail.issueKey === "string") detail.issueIdentifier = detail.issueKey;
  copyNumberRecordField(detail, sourceCursors, "offset");
  copyNumberRecordField(detail, sourceCursors, "limit");
  copyNumberRecordField(detail, sourceCursors, "nextOffset");
  copyNumberRecordField(detail, sourceCursors, "eventCount");
  copyNumberRecordField(detail, sourceCursors, "firstSequence");
  copyNumberRecordField(detail, sourceCursors, "lastSequence");
  copyStringRecordField(detail, sourceCursors, "lastEventAt");
  if (afterSequence !== null) detail.afterSequence = afterSequence;
  return detail;
}

function orchestratorChatProjectionRealtimeDetail(
  publication: ProjectionRevisionPublication,
  sourceCursors: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const conversationId =
    recordStringValue(sourceCursors, "conversationId") ?? recordStringValue(sourceCursors, "conversationKey") ?? publication.scopeKey;
  const detail: Record<string, unknown> = { conversationId, conversationKey: conversationId };
  copyStringRecordField(detail, sourceCursors, "conversationStatus");
  copyStringRecordField(detail, sourceCursors, "state");
  copyNumberRecordField(detail, sourceCursors, "messageCount");
  copyNumberRecordField(detail, sourceCursors, "latestMessageSequence");
  copyStringRecordField(detail, sourceCursors, "latestMessageUpdatedAt");
  copyStringRecordField(detail, sourceCursors, "sourceRevision");
  copyStringRecordField(detail, sourceCursors, "lastMessageId");
  copyStringRecordField(detail, sourceCursors, "lastMessageStatus");
  copyStringRecordField(detail, sourceCursors, "lastMessageAt");
  return detail;
}

function realtimeSafeRecord(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const sanitized = sanitizePublicJson(value, 1_000);
  return isRecord(sanitized) ? sanitized : {};
}

function copyStringRecordField(output: Record<string, unknown>, input: Readonly<Record<string, unknown>>, key: string): void {
  const value = recordStringValue(input, key);
  if (value !== null) output[key] = value;
}

function copyNumberRecordField(output: Record<string, unknown>, input: Readonly<Record<string, unknown>>, key: string): void {
  const value = recordNumberValue(input, key);
  if (value !== null) output[key] = value;
}

function recordStringValue(record: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = record[key];
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function recordNumberValue(record: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function realtimeResourceKindsForDurableProjection(projectionName: DurableProjectionName): readonly RealtimeResourceKind[] {
  switch (projectionName) {
    case "dashboard_projection":
      return ["dashboard"];
    case "issue_board_projection":
      return ["issue-board", "issue-detail"];
    case "sidebar_projection":
      return ["sidebar"];
    case "history_projection":
      return ["history"];
    case "transcript_projection":
      return ["session-transcript", "history"];
    case "orchestrator_chat_projection":
      return ["orchestrator-chat", "sidebar", "dashboard"];
  }
}

function createStatusServerWebProjectionRevisionProviders(
  options: StatusServerOptions,
): readonly WebProjectionRevisionProvider[] {
  const providers: WebProjectionRevisionProvider[] = [...(options.webProjectionRevisionProviders ?? [])];
  const runStoreProvider = createStatusServerStoreRevisionProvider("runStore", options.runStore);
  if (runStoreProvider) providers.push(runStoreProvider);
  const runActivityProvider = createStatusServerStoreRevisionProvider("run_activity", options.runActivitySourceStore);
  if (runActivityProvider) providers.push(runActivityProvider);
  const lifecycleStoreProvider = createStatusServerStoreRevisionProvider("lifecycleStore", options.lifecycleStore);
  if (lifecycleStoreProvider) providers.push(lifecycleStoreProvider);
  const writebackOutboxProvider = createStatusServerStoreRevisionProvider("writebackOutbox", options.writebackOutbox);
  if (writebackOutboxProvider) providers.push(writebackOutboxProvider);
  const orchestratorConversationProvider = createStatusServerStoreRevisionProvider(
    "orchestrator_conversations",
    options.orchestratorConversationStore,
  );
  if (orchestratorConversationProvider) providers.push(orchestratorConversationProvider);
  return providers;
}

function createStatusServerStoreRevisionProvider(
  source: string,
  store: unknown,
): WebProjectionRevisionProvider | null {
  if (!isStatusServerProjectionRevisionStore(store)) return null;
  return {
    source,
    getRevision: () => ({ source, revision: store.projectionRevision(), observedAt: null }),
    subscribe: (listener: WebProjectionRevisionListener) =>
      store.onProjectionChanged((event) => {
        listener({ source: event.source || source, revision: event.revision, observedAt: null, detail: event.detail ?? null });
      }),
  };
}

function isStatusServerProjectionRevisionStore(store: unknown): store is StatusServerProjectionRevisionStore {
  return Boolean(
    store &&
      typeof (store as Partial<StatusServerProjectionRevisionStore>).projectionRevision === "function" &&
      typeof (store as Partial<StatusServerProjectionRevisionStore>).onProjectionChanged === "function",
  );
}

function statusServerWebProjectionContextDurableRevisionSelectors(
  projectContextId: string | null | undefined,
): readonly ProjectionRevisionSelector[] {
  const selectorProjectContextId = projectContextId ?? null;
  return [
    { projectionName: "dashboard_projection", projectContextId: selectorProjectContextId, scopeKind: "global", scopeKey: "global" },
    { projectionName: "issue_board_projection", projectContextId: selectorProjectContextId, scopeKind: "board", scopeKey: "default-board" },
    { projectionName: "sidebar_projection", projectContextId: selectorProjectContextId, scopeKind: "global", scopeKey: "global" },
    {
      projectionName: "history_projection",
      projectContextId: selectorProjectContextId,
      scopeKind: "global_collection",
      scopeKey: webHistoryProjectionScopeKey({
        sessionLimit: WEB_HISTORY_DEFAULT_SESSION_LIMIT,
        timelineLimit: WEB_HISTORY_DEFAULT_TIMELINE_LIMIT,
      }),
    },
  ];
}

function durableProjectionRevisionFingerprint(
  selector: ProjectionRevisionSelector,
  record: ProjectionRevisionRecord | null,
  missingRevision: string | number = 0,
): WebProjectionSourceRevision {
  return {
    source: durableProjectionRevisionFingerprintSource(selector),
    revision: record?.revision ?? missingRevision,
    observedAt: record?.generatedAt ?? null,
  };
}

function durableProjectionRevisionFingerprintSource(selector: ProjectionRevisionSelector): string {
  return ["projection", selector.projectionName, selector.scopeKind ?? "global", selector.scopeKey ?? "global"].join(":");
}

async function readRunActivityTranscriptPage(
  sourceStore: RunActivityEventSourceStore,
  run: RunRecord,
  options: { offset: number; limit: number },
): Promise<TranscriptPage | null> {
  const sourcePage = await sourceStore.readRunEvents(run.runId, {
    ...options,
    projectContextId: run.projectContext?.projectContextId ?? null,
  });
  if (sourcePage.total === 0) return null;
  return runActivityEventsPageToTranscriptPage(sourcePage, run);
}

async function readRunActivityTranscriptTail(
  sourceStore: RunActivityEventSourceStore,
  run: RunRecord,
  options: { limit: number },
): Promise<TranscriptPage | null> {
  const sourceHead = await sourceStore.readRunEvents(run.runId, {
    offset: 0,
    limit: 1,
    projectContextId: run.projectContext?.projectContextId ?? null,
  });
  if (sourceHead.total === 0) return null;
  const offset = Math.max(0, sourceHead.total - options.limit);
  return runActivityEventsPageToTranscriptPage(
    await sourceStore.readRunEvents(run.runId, {
      offset,
      limit: options.limit,
      projectContextId: run.projectContext?.projectContextId ?? null,
    }),
    run,
    "tail",
  );
}

function runActivityEventsPageToTranscriptPage(sourcePage: RunActivityEventsPage, run: RunRecord, windowKind: "page" | "tail" = "page"): TranscriptPage {
  const events = sourcePage.events.map((stored) => mapRunActivityEventToTranscriptEvent(stored.event, { runId: run.runId }));
  const firstEvent = events[0] ?? null;
  const lastEvent = events.at(-1) ?? null;
  const previousOffset = sourcePage.offset > 0 ? Math.max(0, sourcePage.offset - sourcePage.limit) : null;
  return {
    runId: run.runId,
    offset: sourcePage.offset,
    limit: sourcePage.limit,
    nextOffset: sourcePage.nextOffset,
    events,
    total: sourcePage.total,
    eventCount: events.length,
    previousOffset,
    hasPrevious: previousOffset !== null,
    hasNext: sourcePage.nextOffset !== null,
    windowKind,
    firstSequence: firstEvent?.sequence ?? null,
    lastSequence: lastEvent?.sequence ?? null,
    lastEventAt: lastEvent?.at ?? null,
  };
}

function statusServerProjectionSourceRevisions(
  sourceIndex: BuiltWebProjectionSourceIndex | null,
  options: Pick<StatusServerOptions, "runStore" | "runActivitySourceStore" | "lifecycleStore" | "writebackOutbox">,
): ProjectionSourceRevision[] {
  if (sourceIndex) return sourceIndex.durableSourceRevisions.map(toProjectionSourceRevision);
  return [
    statusServerStoreProjectionSourceRevision("runStore", options.runStore),
    statusServerStoreProjectionSourceRevision("run_activity", options.runActivitySourceStore),
    statusServerStoreProjectionSourceRevision("lifecycleStore", options.lifecycleStore),
    statusServerStoreProjectionSourceRevision("writebackOutbox", options.writebackOutbox),
  ].filter((revision): revision is ProjectionSourceRevision => revision !== null);
}

function dashboardSourceInputFromSourceIndex(
  sourceIndex: BuiltWebProjectionSourceIndex | null,
  input: { activityCount: number },
): DashboardSourceProjectionInput {
  if (!sourceIndex) {
    return {
      status: "unavailable",
      detail: "Dashboard was rebuilt without a shared web projection source index.",
      activityCount: input.activityCount,
    };
  }
  const trackerIssues = sourceIndex.trackerIssues;
  return {
    status: trackerIssues.status,
    generatedAt: sourceIndex.generatedAt,
    trackerFetchedAt: trackerIssues.fetchedAt,
    issueCount: trackerIssues.issues.length,
    runCount: sourceIndex.runs.runs.length,
    lifecycleCount: sourceIndex.lifecycles.records.length,
    activityCount: input.activityCount,
    writebackCount: sourceIndex.writebacks.operations.length,
    cached: trackerIssues.cached,
    error: trackerIssues.error?.message ?? null,
  };
}

function statusServerProjectionSourceFreshness(
  sourceIndex: BuiltWebProjectionSourceIndex | null,
): ProjectionSourceFreshnessInput[] {
  if (!sourceIndex) return [];
  const trackerIssues = sourceIndex.trackerIssues;
  const trackerRevision = sourceIndex.durableSourceRevisions.find((revision) => revision.source === "trackerIssues") ?? null;
  const checkedAt = trackerIssues.fetchedAt ?? sourceIndex.generatedAt;
  const revision = trackerRevision?.revision ?? null;

  if (trackerIssues.status !== "ok") {
    return [
      {
        source: "trackerIssues",
        status: "error",
        checkedAt,
        revision,
        lastSuccessAt: null,
        lastErrorAt: checkedAt,
        detail: trackerIssues.error?.message ?? "Issue board tracker source is unavailable",
      },
    ];
  }

  const status = trackerIssues.cached ? "stale" : trackerIssues.issues.length === 0 ? "empty" : "fresh";
  return [
    {
      source: "trackerIssues",
      status,
      checkedAt,
      revision,
      lastSuccessAt: checkedAt,
      lastErrorAt: null,
      detail:
        status === "stale"
          ? "Using a cached issue board tracker source while refresh catches up"
          : status === "empty"
            ? "Issue board tracker source returned no issues"
            : "Issue board tracker source is current",
    },
  ];
}

function statusServerTranscriptProjectionSourceRevisions(
  runStore: RunTranscriptStore | undefined,
  run: RunRecord,
  page: TranscriptPage,
): ProjectionSourceRevision[] {
  const runStoreRevision = statusServerStoreProjectionSourceRevision("runs", runStore) ?? {
    source: "runs",
    revision: [run.status, run.updatedAt, run.transcriptEventCount ?? "unknown"].join(":"),
    observedAt: run.updatedAt,
  };
  const lastEvent = page.events.at(-1) ?? null;
  const totalEventCount = Math.max(run.transcriptEventCount ?? 0, page.nextOffset ?? page.offset + page.events.length);
  return [
    runStoreRevision,
    {
      source: `transcript:${run.runId}`,
      revision: [totalEventCount, lastEvent?.sequence ?? "none", lastEvent?.at ?? run.updatedAt].join(":"),
      observedAt: lastEvent?.at ?? run.updatedAt,
    },
  ];
}

function statusServerStoreProjectionSourceRevision(source: string, store: unknown): ProjectionSourceRevision | null {
  if (!isStatusServerProjectionRevisionStore(store)) return null;
  return { source, revision: store.projectionRevision(), observedAt: null };
}

function toProjectionSourceRevision(revision: WebProjectionSourceRevision): ProjectionSourceRevision {
  return { source: revision.source, revision: revision.revision, observedAt: revision.observedAt };
}

function projectionSourceRevisionsCompatible(
  storedRevisions: readonly ProjectionSourceRevision[],
  currentRevisions: readonly WebProjectionSourceRevision[],
): boolean {
  if (currentRevisions.length === 0) return true;
  const storedBySource = new Map(storedRevisions.map((revision) => [revision.source, revision]));
  for (const current of currentRevisions) {
    const stored = projectionStoredRevisionForCurrentSource(storedBySource, current.source);
    if (!stored) return false;
    if (String(stored.revision) !== String(current.revision)) return false;
  }
  return true;
}

function projectionCurrentSourceRevisionsForRead(
  projectionName: DurableProjectionName,
  currentRevisions: readonly WebProjectionSourceRevision[],
): readonly WebProjectionSourceRevision[] {
  if (projectionName === "transcript_projection") {
    return currentRevisions.filter((revision) => revision.source === "runStore" || revision.source === "runs");
  }
  if (projectionName === "orchestrator_chat_projection") {
    return currentRevisions.filter((revision) => revision.source === "orchestrator_conversations");
  }
  return currentRevisions;
}

function projectionStoredRevisionForCurrentSource(
  storedBySource: ReadonlyMap<string, ProjectionSourceRevision>,
  currentSource: string,
): ProjectionSourceRevision | undefined {
  for (const source of projectionSourceAliases(currentSource)) {
    const revision = storedBySource.get(source);
    if (revision) return revision;
  }
  return undefined;
}

function projectionSourceAliases(source: string): readonly string[] {
  if (source === "runStore") return ["runStore", "runs"];
  if (source === "lifecycleStore") return ["lifecycleStore", "lifecycles"];
  if (source === "writebackOutbox") return ["writebackOutbox", "writebacks"];
  return [source];
}

function parseStatusServerProjectionRebuildOptions(url: URL): StatusServerProjectionRebuildOptions {
  const projectionNames = parseStatusServerProjectionRebuildProjectionNames(url.searchParams);
  const conversationIds = parseStatusServerProjectionRebuildListValues(url.searchParams, ["conversationId", "conversationIds"]);
  return {
    forceRefresh:
      isWebProjectionRefreshRequested(url.searchParams.get("refresh")) ||
      parseBooleanWebQueryParam(url.searchParams, "forceRefresh"),
    ...(projectionNames.length > 0 ? { projections: projectionNames } : {}),
    historyLimits: {
      sessionLimit: parsePositiveIntegerQueryParam(
        url.searchParams,
        "sessionLimit",
        WEB_HISTORY_DEFAULT_SESSION_LIMIT,
        WEB_HISTORY_MAX_LIMIT,
      ),
      timelineLimit: parsePositiveIntegerQueryParam(
        url.searchParams,
        "timelineLimit",
        WEB_HISTORY_DEFAULT_TIMELINE_LIMIT,
        WEB_HISTORY_MAX_LIMIT,
      ),
    },
    transcriptPageLimit: parsePositiveIntegerQueryParam(
      url.searchParams,
      "transcriptPageLimit",
      WEB_TRANSCRIPT_PAGE_LIMIT,
      WEB_TRANSCRIPT_PAGE_LIMIT,
    ),
    ...(conversationIds.length > 0 ? { conversationIds } : {}),
  };
}

function parseStatusServerProjectionRebuildProjectionNames(searchParams: URLSearchParams): DurableProjectionName[] {
  const rawValues = parseStatusServerProjectionRebuildListValues(searchParams, ["projection", "projections"]);
  if (rawValues.length === 0 || rawValues.some((value) => value.toLowerCase() === "all")) return [];
  const names: DurableProjectionName[] = [];
  const seen = new Set<DurableProjectionName>();
  for (const rawValue of rawValues) {
    const projectionName = rawValue.trim();
    if (!isDurableProjectionName(projectionName)) {
      throw new SymphonyError("invalid_request", `Unknown durable projection name for rebuild: ${projectionName}`);
    }
    if (!seen.has(projectionName)) {
      seen.add(projectionName);
      names.push(projectionName);
    }
  }
  return names;
}

function parseStatusServerProjectionRebuildListValues(
  searchParams: URLSearchParams,
  names: readonly string[],
): string[] {
  const values: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    for (const rawValue of searchParams.getAll(name)) {
      for (const part of rawValue.split(",")) {
        const value = part.trim();
        if (value.length === 0 || seen.has(value)) continue;
        seen.add(value);
        values.push(value);
      }
    }
  }
  return values;
}

function normalizeStatusServerProjectionRebuildSelection(
  projections: readonly DurableProjectionName[] | undefined,
): Set<DurableProjectionName> {
  if (!projections || projections.length === 0) return new Set(DURABLE_PROJECTION_NAMES);
  const selection = new Set<DurableProjectionName>();
  for (const rawProjectionName of projections) {
    const projectionName = String(rawProjectionName).trim();
    if (projectionName.toLowerCase() === "all") return new Set(DURABLE_PROJECTION_NAMES);
    if (isDurableProjectionName(projectionName)) selection.add(projectionName);
  }
  return selection.size > 0 ? selection : new Set(DURABLE_PROJECTION_NAMES);
}

function statusServerProjectionRebuildNeedsSourceIndex(selection: ReadonlySet<DurableProjectionName>): boolean {
  return (
    selection.has("dashboard_projection") ||
    selection.has("issue_board_projection") ||
    selection.has("sidebar_projection") ||
    selection.has("history_projection")
  );
}

function statusServerProjectionRebuildNeedsIssueBoard(selection: ReadonlySet<DurableProjectionName>): boolean {
  return (
    selection.has("dashboard_projection") || selection.has("issue_board_projection") || selection.has("sidebar_projection")
  );
}

function normalizeStatusServerProjectionRebuildHistoryLimits(
  limits: StatusServerProjectionRebuildOptions["historyLimits"],
): { sessionLimit: number; timelineLimit: number } {
  return {
    sessionLimit: normalizeStatusServerProjectionRebuildLimit(
      limits?.sessionLimit,
      WEB_HISTORY_DEFAULT_SESSION_LIMIT,
      WEB_HISTORY_MAX_LIMIT,
    ),
    timelineLimit: normalizeStatusServerProjectionRebuildLimit(
      limits?.timelineLimit,
      WEB_HISTORY_DEFAULT_TIMELINE_LIMIT,
      WEB_HISTORY_MAX_LIMIT,
    ),
  };
}

function normalizeStatusServerProjectionRebuildTranscriptPageLimit(value: number | undefined): number {
  return normalizeStatusServerProjectionRebuildLimit(value, WEB_TRANSCRIPT_PAGE_LIMIT, WEB_TRANSCRIPT_PAGE_LIMIT);
}

function normalizeStatusServerProjectionRebuildLimit(value: number | undefined, defaultValue: number, maxValue: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return defaultValue;
  return Math.min(Math.floor(value), maxValue);
}

function normalizeStatusServerProjectionRebuildConversationIds(conversationIds: readonly string[] | undefined): string[] {
  const normalized = statusServerProjectionRebuildUniqueNonEmptyStrings(conversationIds ?? []);
  return normalized.length > 0 ? normalized : [DEFAULT_ORCHESTRATOR_CONVERSATION_ID];
}

function statusServerProjectionRebuildUniqueNonEmptyStrings(values: readonly string[]): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const rawValue of values) {
    const value = String(rawValue).trim();
    if (value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    output.push(value);
  }
  return output;
}

function statusServerProjectionRebuildEntrySelector(
  input: ProjectionPayloadWriteInput,
): Pick<StatusServerProjectionRebuildEntry, "projectionName" | "scopeKind" | "scopeKey"> {
  return {
    projectionName: input.projectionName,
    scopeKind: normalizeStatusServerProjectionRebuildScopeValue(input.scopeKind, "global"),
    scopeKey: normalizeStatusServerProjectionRebuildScopeValue(input.scopeKey, input.projectionName),
  };
}

function normalizeStatusServerProjectionRebuildScopeValue(value: string | null | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : fallback;
}

function isDurableProjectionName(value: string): value is DurableProjectionName {
  return (DURABLE_PROJECTION_NAMES as readonly string[]).includes(value);
}

function historyProjectionScopeKey(limits: { sessionLimit: number; timelineLimit: number }): string {
  return webHistoryProjectionScopeKey(limits);
}

function transcriptProjectionScopeKey(run: RunRecord, page: TranscriptPage): string {
  return webTranscriptProjectionScopeKey({ runId: run.runId, offset: page.offset, limit: page.limit });
}

function transcriptProjectionPageSelectorForRequest(
  run: RunRecord,
  requestedPage: { offset: number; limit: number } | null,
): WebTranscriptProjectionPageSelector {
  const offset = requestedPage?.offset ?? Math.max(0, (run.transcriptEventCount ?? 0) - WEB_TRANSCRIPT_DEFAULT_EVENT_LIMIT);
  const limit = requestedPage?.limit ?? WEB_TRANSCRIPT_DEFAULT_EVENT_LIMIT;
  return {
    runId: run.runId,
    projectContextId: run.projectContext?.projectContextId ?? null,
    offset,
    limit,
  };
}

function shouldBypassDurableWebTranscriptForActiveTail(
  run: RunRecord,
  requestedPage: { offset: number; limit: number } | null,
): boolean {
  return requestedPage === null && run.status === "running";
}

function orchestratorChatProjectionScopeKey(conversationId?: string | null): string {
  return webOrchestratorChatProjectionScopeKey(conversationId);
}

function transcriptProjectionSourceCursors(run: RunRecord, page: TranscriptPage): Record<string, unknown> {
  const firstEvent = page.events[0] ?? null;
  const lastEvent = page.events.at(-1) ?? null;
  return {
    runId: run.runId,
    sessionId: run.sessionId,
    issueKey: run.issueIdentifier || run.issueId,
    ...(run.projectContext ? { projectContext: { ...run.projectContext } } : {}),
    offset: page.offset,
    limit: page.limit,
    nextOffset: page.nextOffset,
    previousOffset: page.previousOffset ?? (page.offset > 0 ? Math.max(0, page.offset - page.limit) : null),
    total: page.total ?? null,
    windowKind: page.windowKind ?? "page",
    hasNext: page.hasNext ?? page.nextOffset !== null,
    hasPrevious: page.hasPrevious ?? page.offset > 0,
    eventCount: page.eventCount ?? page.events.length,
    firstSequence: page.firstSequence ?? firstEvent?.sequence ?? null,
    lastSequence: page.lastSequence ?? lastEvent?.sequence ?? null,
    lastEventAt: page.lastEventAt ?? lastEvent?.at ?? null,
  };
}

function webTranscriptProjectionResponseBody(
  body: unknown,
  input: {
    run: RunRecord | null;
    runId: string;
    requestedPage: { offset: number; limit: number } | null;
    limit: number;
    sourceCursors?: Record<string, unknown> | null;
  },
): WebTranscriptProjectionPayload {
  const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  const pageRecord = record?.page && typeof record.page === "object" && !Array.isArray(record.page) ? (record.page as Record<string, unknown>) : null;
  const windowRecord = record?.window && typeof record.window === "object" && !Array.isArray(record.window) ? (record.window as Record<string, unknown>) : null;
  const messages = Array.isArray(body)
    ? (body as WebTranscriptMessage[])
    : Array.isArray(record?.messages)
      ? (record.messages as WebTranscriptMessage[])
      : [];
  const cursor = input.sourceCursors ?? {};
  const sourceProjectContext =
    isRecordObject(record?.source) && Object.prototype.hasOwnProperty.call(record.source, "projectContext")
      ? projectWebTranscriptProjectContext(record.source.projectContext)
      : null;
  const resolvedProjectContext =
    projectRunProjectContext(input.run) ?? sourceProjectContext ?? projectWebTranscriptProjectContext(cursor.projectContext);
  const projectedMessages = applyWebTranscriptProjectContextAttribution(messages, resolvedProjectContext);
  const offset = optionalNumber(pageRecord?.offset) ?? optionalNumber(cursor.offset) ?? input.requestedPage?.offset ?? 0;
  const limit = optionalNumber(pageRecord?.limit) ?? optionalNumber(cursor.limit) ?? input.limit;
  const nextOffset = optionalNumber(pageRecord?.nextOffset) ?? optionalNumber(cursor.nextOffset);
  const previousOffset =
    optionalNumber(pageRecord?.previousOffset) ??
    optionalNumber(cursor.previousOffset) ??
    (offset > 0 ? Math.max(0, offset - limit) : null);
  const kind =
    (windowRecord?.kind === "tail" || windowRecord?.kind === "page"
      ? windowRecord.kind
      : cursor.windowKind === "tail" || cursor.windowKind === "page"
        ? cursor.windowKind
        : null) ?? (input.requestedPage ? "page" : "tail");
  const page: TranscriptPage = {
    runId: input.run?.runId ?? input.runId,
    offset,
    limit,
    nextOffset,
    events: [],
    total: optionalNumber(pageRecord?.total) ?? optionalNumber(cursor.total),
    eventCount: optionalNumber(pageRecord?.size) ?? optionalNumber(cursor.eventCount) ?? projectedMessages.length,
    previousOffset,
    hasNext: optionalBoolean(pageRecord?.hasNext) ?? optionalBoolean(cursor.hasNext) ?? nextOffset !== null,
    hasPrevious: optionalBoolean(pageRecord?.hasPrevious) ?? optionalBoolean(cursor.hasPrevious) ?? previousOffset !== null,
    windowKind: kind,
    firstSequence: optionalNumber(pageRecord?.firstSequence) ?? optionalNumber(cursor.firstSequence),
    lastSequence: optionalNumber(pageRecord?.lastSequence) ?? optionalNumber(cursor.lastSequence),
    lastEventAt: optionalString(pageRecord?.lastEventAt) ?? optionalString(cursor.lastEventAt),
  };
  let projection = projectWebTranscriptWindow(page, projectedMessages, {
    run: input.run,
    requestedPage: input.requestedPage,
    tailLimit: limit,
    kind,
    sourceIdentity: transcriptSourceIdentityFallback(cursor),
  });
  if (projection.source.projectContext === null && resolvedProjectContext !== null) {
    projection = {
      ...projection,
      source: {
        ...projection.source,
        projectContext: resolvedProjectContext,
      },
    };
  }
  if (isWebTranscriptProjectionPayload(body)) {
    return {
      ...body,
      messages: projectedMessages,
      source: mergeWebTranscriptSourceRecord(body.source, projection.source),
    };
  }
  if (isBackfillableWebTranscriptProjectionEnvelope(record)) {
    return {
      ...projection,
      ...record,
      messages: projectedMessages,
      source: projection.source,
    };
  }
  return projection;
}

function isBackfillableWebTranscriptProjectionEnvelope(
  value: Record<string, unknown> | null,
): value is Omit<WebTranscriptProjectionPayload, "source"> & { source?: unknown } {
  if (!value) return false;
  return (
    value.schemaVersion === 1 &&
    Array.isArray(value.messages) &&
    isRecordObject(value.page) &&
    isRecordObject(value.window) &&
    isRecordObject(value.activeTail) &&
    isRecordObject(value.recovery) &&
    !isWebTranscriptSourceRecordLike(value.source) &&
    isRecordObject(value.compatibility)
  );
}

function isWebTranscriptSourceRecordLike(value: unknown): value is WebTranscriptProjectionPayload["source"] {
  return isRecordObject(value) && typeof value.runId === "string" && value.runId.length > 0 && isRecordObject(value.cursors);
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function transcriptSourceIdentityFallback(
  sourceCursors: Record<string, unknown> | null | undefined,
): { sessionId?: string | null; issueIdentifier?: string | null } | null {
  if (!sourceCursors) return null;
  const sessionId = optionalString(sourceCursors.sessionId);
  const issueIdentifier = optionalString(sourceCursors.issueKey);
  if (!sessionId && !issueIdentifier) return null;
  return { sessionId, issueIdentifier };
}

function mergeWebTranscriptSourceRecord(
  source: WebTranscriptProjectionPayload["source"],
  fallback: WebTranscriptProjectionPayload["source"],
): WebTranscriptProjectionPayload["source"] {
  return {
    runId: optionalString(source.runId) ?? fallback.runId,
    sessionId: optionalString(source.sessionId) ?? fallback.sessionId,
    issueId: optionalString(source.issueId) ?? fallback.issueId,
    issueIdentifier: optionalString(source.issueIdentifier) ?? fallback.issueIdentifier,
    projectContext: isRecordObject(source.projectContext) ? source.projectContext : fallback.projectContext,
    workspace: isRecordObject(source.workspace) ? source.workspace : fallback.workspace,
    cursors: isRecordObject(source.cursors) ? source.cursors : fallback.cursors,
  };
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

type WebOrchestratorChatProjectionResponse = {
  readonly schemaVersion: number;
  readonly conversation: OrchestratorChatProjectionPayload["conversation"];
  readonly state: OrchestratorChatProjectionPayload["state"];
  readonly status: OrchestratorChatProjectionPayload["status"];
  readonly chat: ChatMessage[];
  readonly source: OrchestratorChatProjectionPayload["source"];
  readonly compatibility?: {
    readonly responseShape: "orchestrator_chat_projection";
    readonly sourceShape: "reducer_envelope" | "legacy_chat_array" | "fallback";
  };
};

const ORCHESTRATOR_CHAT_CONVERSATION_STATUSES: readonly OrchestratorConversationStatus[] = [
  "pending",
  "streaming",
  "completed",
  "failed",
  "disabled",
  "unavailable",
];

function orchestratorChatProjectionSourceCursors(
  projection: OrchestratorChatProjectionPayload,
): Record<string, unknown> {
  const lastMessage = projection.chat.at(-1) ?? null;
  return {
    conversationKey: orchestratorChatProjectionScopeKey(projection.conversation.id),
    conversationStatus: projection.conversation.status,
    state: projection.state,
    messageCount: projection.chat.length,
    tailLimit: WEB_ORCHESTRATOR_CHAT_DEFAULT_MESSAGE_LIMIT,
    latestMessageSequence: projection.source.latestMessageSequence,
    latestMessageUpdatedAt: projection.source.latestMessageUpdatedAt,
    sourceRevision: projection.source.revision,
    lastMessageId: lastMessage?.id ?? null,
    lastMessageStatus: lastMessage?.status ?? null,
    lastMessageAt: lastMessage?.updatedAt ?? lastMessage?.createdAt ?? null,
  };
}

function orchestratorChatRealtimeDetailFromProjection(
  projection: Pick<WebOrchestratorChatProjectionResponse, "conversation" | "state" | "status" | "chat" | "source">,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  const chat = selectChatMessageTail(projection.chat);
  const lastMessage = chat.at(-1) ?? null;
  const latestMessageAt = lastMessage?.updatedAt ?? lastMessage?.createdAt ?? null;
  const messageCount = typeof projection.conversation.messageCount === "number" ? projection.conversation.messageCount : projection.chat.length;
  return {
    conversationId: projection.conversation.id,
    conversationKey: orchestratorChatProjectionScopeKey(projection.conversation.id),
    conversation: projection.conversation,
    conversationStatus: projection.conversation.status,
    state: projection.state,
    statusSummary: projection.status,
    statusCounts: projection.status.statusCounts,
    active: projection.status.active,
    terminal: projection.status.terminal,
    empty: projection.status.empty,
    messageCount,
    latestMessageSequence: projection.source.latestMessageSequence,
    latestMessageUpdatedAt: projection.source.latestMessageUpdatedAt,
    sourceSummary: projection.source,
    lastMessageId: lastMessage?.id ?? null,
    lastMessageStatus: lastMessage?.status ?? null,
    lastMessageAt: latestMessageAt,
    chat,
    ...extras,
  };
}

function webOrchestratorChatProjectionFromResponseBody(
  body: unknown,
  conversationId?: string | null,
): WebOrchestratorChatProjectionResponse | null {
  if (isWebOrchestratorChatProjectionEnvelope(body)) {
    return webOrchestratorChatObjectProjection(body, selectChatMessageTail(body.chat), conversationId);
  }
  if (isWebOrchestratorChatProjection(body)) {
    return webOrchestratorChatLegacyProjection(body, conversationId);
  }
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    if (isWebOrchestratorChatProjection(record.chat)) {
      return webOrchestratorChatObjectProjection(record, selectChatMessageTail(record.chat), conversationId);
    }
  }
  return null;
}

function webOrchestratorChatReadFallbackProjection(
  conversationId: string | null | undefined,
  read: DurableProjectionReadResult<unknown>,
): WebOrchestratorChatProjectionResponse {
  return webOrchestratorChatUnavailableProjection(conversationId, read.reason ?? read.status, read.status);
}

function webOrchestratorChatUnavailableProjection(
  conversationId?: string | null,
  reason = "orchestrator_chat_projection_unavailable",
  projectionStatus?: string,
): WebOrchestratorChatProjectionResponse {
  const conversationKey = orchestratorChatProjectionScopeKey(conversationId);
  const status = webOrchestratorChatStatusSummary([], "unavailable", "unavailable");
  return {
    schemaVersion: ORCHESTRATOR_CHAT_PROJECTION_SCHEMA_VERSION,
    conversation: {
      id: conversationKey,
      status: "unavailable",
      createdAt: null,
      updatedAt: null,
      messageCount: 0,
      metadata: { reason, ...(projectionStatus ? { projectionStatus } : {}) },
    },
    state: "unavailable",
    status,
    chat: [],
    source: {
      source: ORCHESTRATOR_CHAT_PROJECTION_SOURCE,
      revision: `unavailable:${reason}`,
      observedAt: null,
      conversationId: conversationKey,
      latestMessageSequence: null,
      latestMessageUpdatedAt: null,
    },
    compatibility: {
      responseShape: "orchestrator_chat_projection",
      sourceShape: "fallback",
    },
  };
}

function webOrchestratorChatLegacyProjection(
  chat: ChatMessage[],
  conversationId?: string | null,
): WebOrchestratorChatProjectionResponse {
  const tail = selectChatMessageTail(chat);
  return webOrchestratorChatObjectProjection({ chat: tail }, tail, conversationId, "legacy_chat_array");
}

function webOrchestratorChatObjectProjection(
  body: Record<string, unknown>,
  chat: ChatMessage[],
  conversationId?: string | null,
  sourceShape: "legacy_chat_array" | "reducer_envelope" = "reducer_envelope",
): WebOrchestratorChatProjectionResponse {
  const fallbackConversationId = orchestratorChatProjectionScopeKey(conversationId);
  const rawConversation = objectRecord(body.conversation);
  const rawStatus = objectRecord(body.status);
  const rawSource = objectRecord(body.source);
  const bodyState = normalizeWebOrchestratorChatProjectionState(body.state);
  const statusState = normalizeWebOrchestratorChatProjectionState(rawStatus?.state);
  const conversationStatus =
    normalizeOrchestratorConversationStatus(rawConversation?.status) ??
    normalizeOrchestratorConversationStatus(rawStatus?.conversationStatus) ??
    webOrchestratorConversationStatusFromState(bodyState ?? statusState) ??
    "completed";
  const summarizedStatus = webOrchestratorChatStatusSummary(chat, conversationStatus, bodyState ?? statusState ?? undefined);
  const status = {
    ...summarizedStatus,
    ...(statusState ? { state: statusState } : {}),
    conversationStatus:
      normalizeOrchestratorConversationStatus(rawStatus?.conversationStatus) ?? summarizedStatus.conversationStatus,
    latestMessageStatus:
      normalizeOrchestratorConversationStatus(rawStatus?.latestMessageStatus) ?? summarizedStatus.latestMessageStatus,
    active: typeof rawStatus?.active === "boolean" ? rawStatus.active : summarizedStatus.active,
    terminal: typeof rawStatus?.terminal === "boolean" ? rawStatus.terminal : summarizedStatus.terminal,
    empty: typeof rawStatus?.empty === "boolean" ? rawStatus.empty : summarizedStatus.empty,
    messageCount: normalizeNonNegativeInteger(rawStatus?.messageCount) ?? summarizedStatus.messageCount,
    statusCounts: normalizeOrchestratorChatStatusCounts(rawStatus?.statusCounts) ?? summarizedStatus.statusCounts,
  };
  const state = bodyState ?? status.state;
  const conversationKey = stringValue(rawConversation?.id) ?? fallbackConversationId;
  const latestMessage = chat.at(-1) ?? null;
  return {
    schemaVersion: normalizeNonNegativeInteger(body.schemaVersion) ?? ORCHESTRATOR_CHAT_PROJECTION_SCHEMA_VERSION,
    conversation: {
      id: conversationKey,
      status: conversationStatus,
      createdAt: nullableStringValue(rawConversation?.createdAt),
      updatedAt: nullableStringValue(rawConversation?.updatedAt),
      messageCount: normalizeNonNegativeInteger(rawConversation?.messageCount) ?? chat.length,
      metadata: sanitizeRecord(rawConversation?.metadata),
    },
    state,
    status: { ...status, state },
    chat,
    source: {
      source: stringValue(rawSource?.source) ?? (sourceShape === "legacy_chat_array" ? "legacy_chat_array" : ORCHESTRATOR_CHAT_PROJECTION_SOURCE),
      revision: stringValue(rawSource?.revision) ?? webOrchestratorChatLegacyRevision(chat, conversationKey),
      observedAt: nullableStringValue(rawSource?.observedAt),
      conversationId: stringValue(rawSource?.conversationId) ?? conversationKey,
      latestMessageSequence: normalizeNonNegativeInteger(rawSource?.latestMessageSequence),
      latestMessageUpdatedAt: nullableStringValue(rawSource?.latestMessageUpdatedAt) ?? latestMessage?.updatedAt ?? latestMessage?.createdAt ?? null,
    },
    ...(sourceShape === "reducer_envelope"
      ? {}
      : {
          compatibility: {
            responseShape: "orchestrator_chat_projection" as const,
            sourceShape,
          },
        }),
  };
}

function isWebOrchestratorChatProjectionEnvelope(value: unknown): value is WebOrchestratorChatProjectionResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Boolean(
    isWebOrchestratorChatProjection(record.chat) &&
      normalizeWebOrchestratorChatProjectionState(record.state) &&
      objectRecord(record.conversation) &&
      objectRecord(record.status) &&
      objectRecord(record.source),
  );
}

function isWebOrchestratorChatProjection(value: unknown): value is ChatMessage[] {
  return Array.isArray(value) && value.every((item) => item && typeof item === "object" && typeof (item as ChatMessage).text === "string");
}

function selectChatMessageTail(messages: readonly ChatMessage[]): ChatMessage[] {
  return selectRecentTail(messages, WEB_ORCHESTRATOR_CHAT_DEFAULT_MESSAGE_LIMIT);
}

function selectOrchestratorConversationMessageTail(
  messages: readonly OrchestratorConversationMessage[],
  options: { includeMessageId?: string | null } = {},
): OrchestratorConversationMessage[] {
  const tail = selectRecentTail(messages, WEB_ORCHESTRATOR_CHAT_DEFAULT_MESSAGE_LIMIT);
  const includeMessageId = options.includeMessageId ?? null;
  if (!includeMessageId || tail.some((message) => message.id === includeMessageId)) return tail;
  const included = messages.find((message) => message.id === includeMessageId);
  if (!included) return tail;
  return [...tail.slice(1), included].sort(compareOrchestratorConversationMessageSequence);
}

function selectRecentTail<T>(items: readonly T[], limit: number): T[] {
  if (limit <= 0) return [];
  return items.slice(-limit);
}

function compareOrchestratorConversationMessageSequence(
  left: OrchestratorConversationMessage,
  right: OrchestratorConversationMessage,
): number {
  return left.sequence - right.sequence || compareString(left.id, right.id);
}

function webOrchestratorChatStatusSummary(
  chat: readonly ChatMessage[],
  conversationStatus: OrchestratorConversationStatus,
  stateOverride?: OrchestratorChatProjectionState,
): OrchestratorChatProjectionPayload["status"] {
  const statusCounts = emptyWebOrchestratorChatStatusCounts();
  for (const message of chat) statusCounts[webOrchestratorChatMessageStatus(message)] += 1;
  const latestMessageStatus = chat.length > 0 ? webOrchestratorChatMessageStatus(chat[chat.length - 1]!) : null;
  const noMessages = chat.length === 0;
  const state = stateOverride ?? (noMessages && conversationStatus === "completed" ? "empty" : deriveWebOrchestratorChatState(conversationStatus, latestMessageStatus, statusCounts));
  const active = state === "pending" || state === "streaming";
  return {
    state,
    conversationStatus,
    latestMessageStatus,
    active,
    terminal: !active && state !== "empty",
    empty: noMessages,
    messageCount: chat.length,
    statusCounts,
  };
}

function deriveWebOrchestratorChatState(
  conversationStatus: OrchestratorConversationStatus,
  latestMessageStatus: OrchestratorConversationStatus | null,
  statusCounts: OrchestratorChatProjectionStatusCounts,
): OrchestratorChatProjectionState {
  if (latestMessageStatus === "pending" || latestMessageStatus === "streaming") return latestMessageStatus;
  if (conversationStatus === "pending" || conversationStatus === "streaming") return conversationStatus;
  if (latestMessageStatus === "failed" || latestMessageStatus === "unavailable" || latestMessageStatus === "disabled") return latestMessageStatus;
  if (conversationStatus === "failed" || conversationStatus === "unavailable" || conversationStatus === "disabled") return conversationStatus;
  if (statusCounts.streaming > 0) return "streaming";
  if (statusCounts.pending > 0) return "pending";
  if (statusCounts.failed > 0) return "failed";
  if (statusCounts.unavailable > 0) return "unavailable";
  if (statusCounts.disabled > 0) return "disabled";
  return "completed";
}

function emptyWebOrchestratorChatStatusCounts(): OrchestratorChatProjectionStatusCounts {
  return {
    pending: 0,
    streaming: 0,
    completed: 0,
    failed: 0,
    disabled: 0,
    unavailable: 0,
  };
}

function webOrchestratorChatMessageStatus(message: ChatMessage): OrchestratorConversationStatus {
  return normalizeOrchestratorConversationStatus(message.status) ?? "completed";
}

function normalizeWebOrchestratorChatProjectionState(value: unknown): OrchestratorChatProjectionState | null {
  if (value === "empty") return "empty";
  return normalizeOrchestratorConversationStatus(value);
}

function webOrchestratorConversationStatusFromState(
  state: OrchestratorChatProjectionState | null,
): OrchestratorConversationStatus | null {
  if (!state) return null;
  return state === "empty" ? "completed" : state;
}

function normalizeOrchestratorConversationStatus(value: unknown): OrchestratorConversationStatus | null {
  return typeof value === "string" && ORCHESTRATOR_CHAT_CONVERSATION_STATUSES.includes(value as OrchestratorConversationStatus)
    ? (value as OrchestratorConversationStatus)
    : null;
}

function normalizeOrchestratorChatStatusCounts(value: unknown): OrchestratorChatProjectionStatusCounts | null {
  const record = objectRecord(value);
  if (!record) return null;
  const counts = emptyWebOrchestratorChatStatusCounts();
  for (const status of ORCHESTRATOR_CHAT_CONVERSATION_STATUSES) {
    counts[status] = normalizeNonNegativeInteger(record[status]) ?? 0;
  }
  return counts;
}

function webOrchestratorChatLegacyRevision(chat: readonly ChatMessage[], conversationId: string): string {
  const lastMessage = chat.at(-1) ?? null;
  return [conversationId, chat.length, lastMessage?.id ?? "none", lastMessage?.updatedAt ?? lastMessage?.createdAt ?? "unknown"].join(":");
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function nullableStringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizeNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function sanitizeRecord(value: unknown): Record<string, unknown> {
  const sanitized = sanitizePublicJson(value ?? {});
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized) ? (sanitized as Record<string, unknown>) : {};
}

function firstChatMetadataString(chat: readonly ChatMessage[], ...keys: readonly string[]): string | null {
  for (const message of chat) {
    const metadata = message.metadata;
    if (!metadata) continue;
    for (const key of keys) {
      const value = metadata[key];
      if (typeof value === "string" && value.trim().length > 0) return value.trim();
    }
  }
  return null;
}

const STATUS_SERVER_WEB_PROJECTION_COLUMN_IDS: readonly IssueBoardColumnId[] = [
  "backlog",
  "todo",
  "progress",
  "review",
  "done",
  "canceled",
] as const;

const STATUS_SERVER_RUNTIME_FINGERPRINT_VOLATILE_FIELDS = new Set([
  "secondsRunning",
  "secondsSinceLastActivity",
]);

function statusServerRuntimeFingerprintKey(snapshot: ReturnType<Orchestrator["snapshot"]>): string {
  return JSON.stringify(statusServerRuntimeFingerprintValue(snapshot));
}

function statusServerRuntimeFingerprintValue(value: unknown, key?: string): unknown {
  if (key && STATUS_SERVER_RUNTIME_FINGERPRINT_VOLATILE_FIELDS.has(key)) return undefined;
  if (Array.isArray(value)) return value.map((item) => statusServerRuntimeFingerprintValue(item));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const childKey of Object.keys(record).sort()) {
      const childValue = statusServerRuntimeFingerprintValue(record[childKey], childKey);
      if (childValue !== undefined) output[childKey] = childValue;
    }
    return output;
  }
  return value;
}

function assertCompletedWebProjectionContextCacheable(context: StatusServerWebProjectionContext): void {
  if (isCompletedWebProjectionContextCacheable(context)) return;
  throw trackerFailureFromSourceIndex(context.sourceIndex);
}

function isCompletedWebProjectionContextCacheable(context: StatusServerWebProjectionContext): boolean {
  const trackerFailure = context.sourceIndex.trackerIssues.error;
  return !trackerFailure || trackerFailure.code === "tracker_unavailable";
}

function webProjectionContextPendingKey(forceRefresh: boolean, fingerprintKey: string): string {
  return `${forceRefresh ? "refresh" : "default"}\0${fingerprintKey}`;
}

function issueBoardFetchedStateCacheKey(fetchedStates: readonly string[]): string {
  return fetchedStates.map((state) => state.trim().toLowerCase()).join("\0");
}

function issueBoardColumnCacheKeyValues(columns: IssueBoardColumnMapping): string[] {
  return STATUS_SERVER_WEB_PROJECTION_COLUMN_IDS.map(
    (column) => `${column}:${issueBoardFetchedStateCacheKey(columns[column] ?? [])}`,
  );
}

function webProjectionSourceIndexWithTrackerCacheHit(
  sourceIndex: BuiltWebProjectionSourceIndex,
): BuiltWebProjectionSourceIndex {
  if (sourceIndex.trackerIssues.status !== "ok" || sourceIndex.trackerIssues.cached) return sourceIndex;
  return {
    ...sourceIndex,
    trackerIssues: {
      ...sourceIndex.trackerIssues,
      cached: true,
    },
  };
}

function trackerSourceStatusKey(trackerIssues: BuiltWebProjectionSourceIndex["trackerIssues"]): string {
  return JSON.stringify({
    status: trackerIssues.status,
    fetchedStateKey: trackerIssues.fetchedStateKey,
    fetchedAt: trackerIssues.fetchedAt,
    cached: trackerIssues.cached,
    error: trackerIssues.error ? { code: trackerIssues.error.code, message: trackerIssues.error.message } : null,
    issueCount: trackerIssues.issues.length,
    latestIssueRevision: latestTrackerIssueRevision(trackerIssues.issues),
  });
}

function latestTrackerIssueRevision(issues: readonly Issue[]): string | null {
  let latest: string | null = null;
  for (const issue of issues) {
    const revision = issue.updatedAt ?? issue.createdAt ?? issue.id;
    if (!revision) continue;
    if (latest === null || revision > latest) latest = revision;
  }
  return latest;
}

function webProjectionJsonResponse<TBody>(
  body: TBody,
  durableRead?: DurableProjectionReadResult<unknown>,
): WebProjectionJsonResponse<TBody> {
  const headers = durableProjectionReadHeaders(durableRead);
  return headers ? { body, headers } : { body };
}

function durableProjectionReadHeaders(read: DurableProjectionReadResult<unknown> | undefined): Record<string, string> | undefined {
  if (!read) return undefined;
  const headers: Record<string, string> = {
    "x-symphony-projection-name": read.selector.projectionName,
    "x-symphony-projection-scope-kind": read.selector.scopeKind ?? "global",
    "x-symphony-projection-scope-key": read.selector.scopeKey ?? "global",
    "x-symphony-projection-status": read.status,
    "x-symphony-projection-cache": read.status === "hit" ? "hit" : "miss",
  };
  if (read.reason) headers["x-symphony-projection-reason"] = headerValue(read.reason);
  const record = read.record;
  if (!record) return headers;
  headers["x-symphony-projection-revision"] = String(record.revision.revision);
  headers["x-symphony-projection-generated-at"] = record.generatedAt || record.revision.generatedAt;
  if (record.expiresAt ?? record.revision.expiresAt) {
    headers["x-symphony-projection-expires-at"] = record.expiresAt ?? record.revision.expiresAt ?? "";
  }
  headers["x-symphony-projection-build-mode"] = record.revision.buildMode;
  if (record.revision.contentSha256) headers["x-symphony-projection-content-sha256"] = record.revision.contentSha256;
  if (record.payloadSha256) headers["x-symphony-projection-payload-sha256"] = record.payloadSha256;
  headers["x-symphony-projection-source-revisions"] = headerJsonValue(record.revision.sourceRevisions);
  headers["x-symphony-projection-source-cursors"] = headerJsonValue(record.revision.sourceCursors);
  headers["x-symphony-projection-source-freshness"] = headerJsonValue(record.revision.sourceFreshness);
  return headers;
}

function durableWebIssueFromIssueBoard(board: WebIssueBoardModel, issueId: string): IssueModel | null {
  const issue = board.issues.find((candidate) => webIssueModelMatches(candidate, issueId)) ?? null;
  return issue ? cloneJson(issue) : null;
}

function webIssueModelMatches(issue: IssueModel, issueId: string): boolean {
  const requested = issueId.trim().toLowerCase();
  return issue.id.trim().toLowerCase() === requested;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function headerJsonValue(value: unknown): string {
  return encodeURIComponent(JSON.stringify(value));
}

function headerValue(value: string): string {
  return encodeURIComponent(value);
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function writeWebProjectionSseEvent(response: ServerResponse, event: string, body: unknown, id?: string): void {
  if (id) response.write(`id: ${id}\n`);
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(body)}\n\n`);
}

function sendHtml(response: ServerResponse, body: string): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(body);
}

function realtimeLastEventId(request: IncomingMessage, url: URL): string | null {
  const header = request.headers["last-event-id"];
  const headerValue = Array.isArray(header) ? header[0] : header;
  const queryValue = url.searchParams.get("lastEventId") ?? url.searchParams.get("last-event-id");
  const value = headerValue ?? queryValue;
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : null;
}

const WEB_MOUNT_PATH = "/web";
const WEB_INDEX_FILE = "index.html";
const WEB_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
const WEB_HTML_CACHE_CONTROL = "no-cache";
const STATIC_ASSET_NOT_FOUND = { error: { code: "not_found", message: "Static asset not found" } } as const;
const WEB_ASSET_DIRECTORIES = new Set(["assets", "static", "media", "images", "img", "fonts", "icons"]);
const WEB_STATIC_FORBIDDEN_DIRECTORIES = new Set([
  ".git",
  ".symphony",
  "coverage",
  "cursor",
  "dist",
  "docs",
  "extension",
  "hermes",
  "node_modules",
  "scripts",
  "src",
  "symphony_workspaces",
  "test",
  "tests",
]);
const WEB_STATIC_FORBIDDEN_FILENAMES = new Set([
  "agents.md",
  "bun.lockb",
  "claude.md",
  "dockerfile",
  "license",
  "makefile",
  "package-lock.json",
  "package.json",
  "pnpm-lock.yaml",
  "readme",
  "tsconfig.json",
  "vite.config.ts",
  "vitest.config.ts",
  "workflow.md",
  "yarn.lock",
]);
const WEB_STATIC_FORBIDDEN_EXTENSIONS = new Set([
  ".crt",
  ".db",
  ".key",
  ".lock",
  ".log",
  ".md",
  ".pem",
  ".py",
  ".sqlite",
  ".toml",
  ".ts",
  ".tsbuildinfo",
  ".tsx",
  ".yaml",
  ".yml",
]);

type WebAssetFileResult = "served" | "missing" | "blocked";

interface WebAssetRequest {
  filePath: string;
  relativePath: string;
  segments: string[];
  assetLike: boolean;
}

function resolveWebAssetsRootOption(configuredWebAssetsRoot: string | null | undefined): string | null {
  if (configuredWebAssetsRoot === null) return null;
  const configured = configuredWebAssetsRoot?.trim();
  return path.resolve(configured && configured.length > 0 ? configured : path.join(process.cwd(), "web", "dist"));
}

function isWebAssetRoute(pathname: string): boolean {
  return pathname === WEB_MOUNT_PATH || pathname.startsWith(`${WEB_MOUNT_PATH}/`);
}

async function serveWebAsset(
  response: ServerResponse,
  method: "GET" | "HEAD",
  pathname: string,
  webAssetsRoot: string | null,
): Promise<boolean> {
  if (!webAssetsRoot) return false;

  const resolvedRoot = await resolveExistingWebAssetsRoot(webAssetsRoot);
  if (!resolvedRoot) {
    sendStaticAssetNotFound(response, method);
    return true;
  }

  const request = resolveWebAssetRequest(pathname, resolvedRoot);
  if (!request || isForbiddenWebStaticPath(request)) {
    sendStaticAssetNotFound(response, method);
    return true;
  }

  if (request.relativePath === WEB_INDEX_FILE || request.assetLike) {
    const exactResult = await serveExistingWebAssetFile(response, method, request, resolvedRoot);
    if (exactResult === "served") return true;
    sendStaticAssetNotFound(response, method);
    return true;
  }

  const fallback = resolveWebIndexFallback(resolvedRoot);
  const fallbackResult = await serveExistingWebAssetFile(response, method, fallback, resolvedRoot);
  if (fallbackResult === "served") return true;

  sendStaticAssetNotFound(response, method);
  return true;
}

async function resolveExistingWebAssetsRoot(root: string): Promise<string | null> {
  try {
    const realRoot = await fs.realpath(path.resolve(root));
    const stat = await fs.stat(realRoot);
    return stat.isDirectory() ? realRoot : null;
  } catch {
    return null;
  }
}

function resolveWebAssetRequest(pathname: string, webAssetsRoot: string): WebAssetRequest | null {
  const mountRelativePath = pathname === WEB_MOUNT_PATH ? "" : pathname.slice(WEB_MOUNT_PATH.length + 1);
  let decodedRelativePath: string;
  try {
    decodedRelativePath = decodeURIComponent(mountRelativePath);
  } catch {
    return null;
  }

  if (decodedRelativePath.includes("\0") || decodedRelativePath.includes("\\")) return null;
  const segments = decodedRelativePath.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "." || segment === "..")) return null;

  const relativePath = segments.length === 0 ? WEB_INDEX_FILE : segments.join("/");
  const filePath = path.resolve(webAssetsRoot, relativePath);
  return pathIsWithin(webAssetsRoot, filePath)
    ? { filePath, relativePath, segments, assetLike: isAssetLikeWebPath(relativePath, segments) }
    : null;
}

function resolveWebIndexFallback(webAssetsRoot: string): WebAssetRequest {
  const filePath = path.resolve(webAssetsRoot, WEB_INDEX_FILE);
  return { filePath, relativePath: WEB_INDEX_FILE, segments: [WEB_INDEX_FILE], assetLike: true };
}

async function serveExistingWebAssetFile(
  response: ServerResponse,
  method: "GET" | "HEAD",
  request: Pick<WebAssetRequest, "filePath" | "relativePath">,
  resolvedRoot: string,
): Promise<WebAssetFileResult> {
  let filePath: string;
  let stat: Stats;
  try {
    filePath = await fs.realpath(request.filePath);
    if (!pathIsWithin(resolvedRoot, filePath)) return "blocked";
    stat = await fs.stat(filePath);
  } catch {
    return "missing";
  }

  if (!stat.isFile()) return "missing";

  response.writeHead(200, {
    "content-type": contentTypeForStaticAsset(filePath),
    "content-length": String(stat.size),
    "cache-control": request.relativePath === WEB_INDEX_FILE ? WEB_HTML_CACHE_CONTROL : WEB_ASSET_CACHE_CONTROL,
  });
  if (method === "HEAD") {
    response.end();
    return "served";
  }
  response.end(await fs.readFile(filePath));
  return "served";
}

function isAssetLikeWebPath(relativePath: string, segments: string[]): boolean {
  const basename = webRelativeBasename(relativePath);
  return WEB_ASSET_DIRECTORIES.has((segments[0] ?? "").toLowerCase()) || path.posix.extname(basename).length > 0;
}

function isForbiddenWebStaticPath(request: WebAssetRequest): boolean {
  return request.segments.some((segment) => {
    const lower = segment.toLowerCase();
    return (
      lower.startsWith(".") ||
      WEB_STATIC_FORBIDDEN_DIRECTORIES.has(lower) ||
      WEB_STATIC_FORBIDDEN_FILENAMES.has(lower) ||
      WEB_STATIC_FORBIDDEN_EXTENSIONS.has(path.posix.extname(lower))
    );
  });
}

function webRelativeBasename(relativePath: string): string {
  return relativePath.split("/").at(-1) ?? relativePath;
}

function pathIsWithin(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), target);
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function contentTypeForStaticAsset(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
    case ".map":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    case ".webmanifest":
      return "application/manifest+json; charset=utf-8";
    case ".wasm":
      return "application/wasm";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".ttf":
      return "font/ttf";
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function sendStaticAssetNotFound(response: ServerResponse, method: "GET" | "HEAD" = "GET"): void {
  const body = `${JSON.stringify(STATIC_ASSET_NOT_FOUND, null, 2)}\n`;
  response.writeHead(404, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-cache",
  });
  response.end(method === "HEAD" ? undefined : body);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8").trim();
  if (body.length === 0) return {};
  return JSON.parse(body) as unknown;
}

function parseApprovalDecision(body: unknown): "approve" | "reject" {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new SymphonyError("invalid_request", "Approval decision body must be an object");
  }
  const decision = (body as { decision?: unknown }).decision;
  if (decision !== "approve" && decision !== "reject") {
    throw new SymphonyError("invalid_request", "Approval decision must be approve or reject");
  }
  return decision;
}

interface WebOrchestratorChatPostRequest {
  input: string;
  conversationId?: string;
  messageId?: string;
}

function parseWebOrchestratorChatPostRequest(body: unknown): WebOrchestratorChatPostRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new SymphonyError(
      "invalid_request",
      "Web orchestrator chat request body must be a JSON object with a non-empty string input",
    );
  }
  const input = (body as { input?: unknown }).input;
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new SymphonyError(
      "invalid_request",
      "Web orchestrator chat request body must include a non-empty string input",
    );
  }
  const conversationId = parseOptionalWebOrchestratorChatString(body, "conversationId");
  const messageId = parseOptionalWebOrchestratorChatString(body, "messageId");
  return {
    input,
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(messageId === undefined ? {} : { messageId }),
  };
}

function parseWebOrchestratorChatConversationId(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function parseOptionalWebOrchestratorChatString(body: unknown, key: "conversationId" | "messageId"): string | undefined {
  const value = (body as Record<string, unknown>)[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SymphonyError("invalid_request", `Web orchestrator chat request body ${key} must be a non-empty string`);
  }
  return value.trim();
}

function orchestratorChatCommandDispatcher(value: unknown): OrchestratorChatCommandDispatcher | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<OrchestratorChatCommandDispatcher>;
  return typeof candidate.dispatchOrchestratorChatCommand === "function"
    ? (value as OrchestratorChatCommandDispatcher)
    : null;
}

function webOrchestratorChatMessagePostLockKey(conversationId: string | null | undefined, messageId: string): string {
  return `${conversationId?.trim() || DEFAULT_ORCHESTRATOR_CONVERSATION_ID}\0${messageId}`;
}

function webOrchestratorChatMessageMatchesClaim(
  message: OrchestratorConversationMessage,
  commandClaimId: string,
): boolean {
  return message.metadata.commandClaimId === commandClaimId;
}

function webOrchestratorChatReplayResponse(
  input: string,
  message: OrchestratorConversationMessage,
  messages: readonly OrchestratorConversationMessage[],
): WebOrchestratorChatPostResult {
  return {
    status: webOrchestratorChatReplayStatus(message),
    body: projectWebOrchestratorChatPost(
      input,
      selectOrchestratorConversationMessageTail(messages, { includeMessageId: message.id }),
    ),
    stateChanged: false,
  };
}

function webOrchestratorChatReplayStatus(message: OrchestratorConversationMessage): number {
  const commandStatus = message.metadata.commandStatus;
  return commandStatus === "pending" || commandStatus === "dispatching" ? 202 : 200;
}

function webOrchestratorChatCommandDispatchingMetadata(
  commandClaimId: string,
  commandDispatchedAt: string,
): Record<string, unknown> {
  return {
    actionDispatched: true,
    commandStatus: "dispatching",
    commandReason: "orchestrator_chat_command_dispatch_in_progress",
    commandClaimId,
    commandDispatchedAt,
  };
}

function webOrchestratorChatMessageStatusFromCommandResult(
  status: OrchestratorChatCommandResultStatus,
): OrchestratorConversationStatus {
  switch (status) {
    case "accepted":
      return "pending";
    case "disabled":
      return "disabled";
    case "unavailable":
      return "unavailable";
    case "failed":
      return "failed";
  }
}

function webOrchestratorChatHttpStatusFromCommandResult(status: OrchestratorChatCommandResultStatus): number {
  switch (status) {
    case "accepted":
      return 202;
    case "disabled":
    case "unavailable":
      return 503;
    case "failed":
      return 500;
  }
}

function webOrchestratorChatErrorCodeFromCommandResult(status: OrchestratorChatCommandResultStatus): string {
  switch (status) {
    case "accepted":
      return "orchestrator_chat_accepted";
    case "disabled":
      return "orchestrator_chat_disabled";
    case "unavailable":
      return "orchestrator_chat_unavailable";
    case "failed":
      return "orchestrator_chat_dispatch_failed";
  }
}

function webOrchestratorChatErrorMessageFromCommandResult(status: OrchestratorChatCommandResultStatus): string {
  switch (status) {
    case "accepted":
      return "Web orchestrator chat command was accepted";
    case "disabled":
      return "Web orchestrator chat command dispatch is disabled";
    case "unavailable":
      return "Web orchestrator chat command dispatch is unavailable";
    case "failed":
      return "Web orchestrator chat command dispatch failed";
  }
}

function webOrchestratorChatCommandMetadata(
  result: OrchestratorChatCommandResult,
  actionDispatched: boolean,
): Record<string, unknown> {
  return {
    actionDispatched,
    commandStatus: result.status,
    commandReason: sanitizedPreviewValue(result.reason, 200).preview ?? "",
    ...(result.acceptedAt ? { commandAcceptedAt: result.acceptedAt } : {}),
    ...(result.metadata ? { commandMetadata: sanitizePublicJson(result.metadata) } : {}),
  };
}

function webOrchestratorChatErrorResponse(
  status: number,
  code: string,
  message: string,
  chat: unknown,
): { status: number; body: unknown } {
  return {
    status,
    body: {
      error: { code, message },
      chat,
    },
  };
}

function parseIssueBreakdownApplyRequest(body: unknown): { dryRun: boolean } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new SymphonyError("invalid_request", "Issue breakdown apply body must be an object");
  }
  const input = body as { dryRun?: unknown; mode?: unknown };
  if (input.mode !== undefined) {
    if (input.mode === "preview") return { dryRun: true };
    if (input.mode === "apply") return { dryRun: false };
    throw new SymphonyError("invalid_request", "Issue breakdown apply mode must be preview or apply");
  }
  if (input.dryRun === undefined) return { dryRun: true };
  if (typeof input.dryRun !== "boolean") {
    throw new SymphonyError("invalid_request", "Issue breakdown apply dryRun must be a boolean");
  }
  return { dryRun: input.dryRun };
}

function approvalResponse(record: OperatorApprovalRecord, enabled: boolean): Record<string, unknown> {
  return {
    ...record,
    capabilities: {
      enabled,
      resolve: approvalResolve(record),
    },
  };
}

function approvalCapability(
  record: OperatorApprovalRecord | null,
  enabled: boolean,
  openWorkspaceToken: string | null,
): Record<string, unknown> {
  return {
    enabled,
    active: record !== null,
    requestId: record?.requestId ?? null,
    status: record?.status ?? null,
    action: record?.action ?? null,
    projectContext: record?.projectContext ?? null,
    requestedAt: record?.requestedAt ?? null,
    resolve: record === null ? null : approvalResolve(record),
    requiresToken: approvalMutationsRequireToken(enabled, openWorkspaceToken),
  };
}

async function currentPendingPublicationApproval(input: {
  approval: OperatorApprovalRecord;
  lifecycleStore: IssueLifecycleStore | undefined;
  runStore: RunTranscriptStore | undefined;
  allowSetupIncomplete?: boolean;
}): Promise<OperatorApprovalRecord | null> {
  if (input.approval.status !== "pending" || !input.lifecycleStore || !input.runStore) return null;
  const lifecycle =
    (await input.lifecycleStore.get(input.approval.issueId)) ??
    (await input.lifecycleStore.get(input.approval.issueIdentifier));
  if (
    !isAwaitingPublicationApprovalLifecycle(lifecycle) &&
    !(input.allowSetupIncomplete === true && isPendingPublicationApprovalLifecycle(lifecycle))
  ) {
    return null;
  }
  const report = pendingPublicationReport(lifecycle);
  if (!report || !approvalMatchesReport(input.approval, report)) return null;
  const run = await input.runStore.getRun(report.runId);
  if (run?.pendingApprovalRequestId !== input.approval.requestId) return null;
  return input.approval;
}

async function hasPendingPublicationLifecycle(
  approval: OperatorApprovalRecord,
  lifecycleStore: IssueLifecycleStore | undefined,
): Promise<boolean> {
  if (!lifecycleStore) return false;
  const lifecycle = (await lifecycleStore.get(approval.issueId)) ?? (await lifecycleStore.get(approval.issueIdentifier));
  return isPendingPublicationApprovalLifecycle(lifecycle);
}

function approvalMutationsRequireToken(enabled: boolean, openWorkspaceToken: string | null): boolean {
  return enabled || Boolean(openWorkspaceToken?.trim());
}

function approvalRecordFromDetails(details: unknown): OperatorApprovalRecord | null {
  if (typeof details !== "object" || details === null) return null;
  const record = details as Partial<OperatorApprovalRecord>;
  return typeof record.requestId === "string" && typeof record.status === "string"
    ? (record as OperatorApprovalRecord)
    : null;
}

function isPublicationApprovalTerminal(
  record: OperatorApprovalRecord,
): record is OperatorApprovalRecord & { status: "rejected" | "stale" | "expired" | "cancelled" } {
  return (
    record.status === "rejected" ||
    record.status === "stale" ||
    record.status === "expired" ||
    record.status === "cancelled"
  );
}

type RuntimeSnapshot = ReturnType<Orchestrator["snapshot"]>;
type RunningRow = RuntimeSnapshot["running"][number];
type OperatorLivenessStatus =
  | "running"
  | "possibly_stalled"
  | "cancelling"
  | "cancelled"
  | "blocked_human_required"
  | "not_live";

const OPERATOR_LIVENESS_CONTRACT = {
  version: "sdk-run-lifecycle-v2",
  supportedStatuses: ["running", "possibly_stalled", "cancelling", "cancelled", "blocked_human_required", "not_live"],
  sdkRunLifecycle: {
    tracked: true,
    terminalSource: "run.wait",
    streamStatusesAreDiagnostics: true,
  },
  idleAlert: {
    tracked: true,
    action: "observe_only",
    deprecatedStatus: "possibly_stalled",
  },
  cancelFailed: {
    tracked: true,
    sources: ["harness_stop", "cancel_ignored"],
  },
  deferred: {
    linearAuditComments: {
      tracked: false,
      reason: "writeback_status_does_not_persist_linear_comment_urls",
      followUp: "writeback_result_url_persistence",
    },
  },
} as const;

interface OperatorControls {
  pause: boolean;
  resume: boolean;
  cancel: boolean;
  mutationsRequireToken: boolean;
}

interface OperatorAffordances {
  humanRequired: {
    active: boolean;
    reason: string | null;
    continuationSummaryRecommended: boolean;
  };
  continuationSummary: {
    available: boolean;
    method: "POST";
    path: string;
    requiresToken: boolean;
  };
}

interface PausedOperatorView extends OperatorAffordances {
  issueId: string;
  issueIdentifier: string;
  label: string;
  paused: true;
  controls: OperatorControls;
  issueDetails: IssueDetailsEnvelope;
}

interface IssueBoardTrackerProjection {
  fetchedStates: string[];
  trackerIssues: Issue[];
  fetchedAt: string;
  cached: boolean;
}

interface IssueBoardTrackerCache {
  cacheKey: string;
  fetchedAtMs: number;
  projection: IssueBoardTrackerProjection;
}

interface ActivityQuery {
  issue: string | null;
  projectContextId?: string | null;
  offset: number;
  limit: number;
}

interface ActivityItem {
  id: string;
  at: string;
  kind: "run_started" | "run_completed" | "transcript_event" | "writeback_operation";
  source: "run" | TranscriptEvent["source"] | "writeback";
  projectContext?: ProjectContextResolution | null;
  issue: {
    id: string;
    identifier: string;
  };
  run: {
    runId: string;
    role: RunRecord["role"];
    runPhase: AgentRunPhase | null;
    runKind: string | null;
    status: RunRecord["status"];
    agentId: string | null;
    sessionId: string | null;
  } | null;
  transcript: {
    sequence: number;
    eventType: string;
    message: string | null;
  } | null;
  writeback: {
    operationKind: WritebackOperation["kind"];
    status: WritebackOperation["status"];
    skipReason: WritebackSkipReason | null;
    attempt: number;
    createdAt: string;
    updatedAt: string;
    nextAttemptAt: string;
    transition: { toState: string; fromStates: string[] | null } | null;
    comment: { dedupeKey: string; bodyLength: number; bodyRedacted: true } | null;
  } | null;
  links: {
    issue: string;
    run: string | null;
    transcript: string | null;
  };
}

type WritebackSkipReason = {
  code: "issue_breakdown_plan_not_current" | "issue_breakdown_plan_stale";
  message: string;
};

interface IssueBoardCard {
  key: string;
  issueId: string | null;
  issueIdentifier: string | null;
  origin: "tracker" | "symphony";
  lane: IssueBoardColumnId;
  issueDetails: IssueDetailsEnvelope;
  paused: boolean;
  live: { role: AgentRunRole; runPhase: AgentRunPhase; runKind: AgentRunKind; state: string; runId: string | null } | null;
  operatorLiveness: Awaited<ReturnType<typeof issueOperatorLiveness>>;
  reviewLoop: ReturnType<typeof reviewLoopStatus>;
  metadata: ReturnType<typeof statusMetadata>;
  capabilities: {
    detail: string | null;
    runs: string | null;
    humanRequired: OperatorAffordances["humanRequired"];
    continuationSummary: OperatorAffordances["continuationSummary"];
  };
}

interface IssueBoardLane {
  id: IssueBoardColumnId;
  title: string;
  states: string[];
  issues: IssueBoardCard[];
}

async function buildIssueBoard(input: {
  sourceIndex: BuiltWebProjectionSourceIndex;
  mutationsConfigured: boolean;
  runStore: RunTranscriptStore | undefined;
  trackerStateLists: TrackerStateLists;
  issueBoardColumns: IssueBoardColumnMapping;
  staleThresholdMs: number;
  continuationSummaryAvailable: boolean;
}) {
  if (input.sourceIndex.trackerIssues.error) throw trackerFailureFromSourceIndex(input.sourceIndex);
  const snapshot = input.sourceIndex.runtime.snapshot;
  const representedKeys = new Set<string>();
  const cards: IssueBoardCard[] = [];
  for (const issue of input.sourceIndex.trackerIssues.issues) {
    addBoardKeys(representedKeys, [issue.id, issue.identifier]);
    cards.push(
      await buildTrackerBoardCard({
        issue,
        sourceIndex: input.sourceIndex,
        mutationsConfigured: input.mutationsConfigured,
        runStore: input.runStore,
        trackerStateLists: input.trackerStateLists,
        issueBoardColumns: input.issueBoardColumns,
        staleThresholdMs: input.staleThresholdMs,
        continuationSummaryAvailable: input.continuationSummaryAvailable,
      }),
    );
  }

  const symphonyOnlyCards = await buildSymphonyOnlyBoardCards({
    sourceIndex: input.sourceIndex,
    mutationsConfigured: input.mutationsConfigured,
    runStore: input.runStore,
    trackerStateLists: input.trackerStateLists,
    issueBoardColumns: input.issueBoardColumns,
    staleThresholdMs: input.staleThresholdMs,
    continuationSummaryAvailable: input.continuationSummaryAvailable,
    representedKeys,
  });
  cards.push(...symphonyOnlyCards);

  const lanes = boardLanes(input.issueBoardColumns).map((lane) => ({
    ...lane,
    issues: cards.filter((card) => card.lane === lane.id),
  }));

  return {
    generatedAt: snapshot.generatedAt,
    tracker: {
      status: "ok" as const,
      fetchedStates: input.sourceIndex.trackerIssues.fetchedStates,
      fetchedAt: input.sourceIndex.trackerIssues.fetchedAt,
      cached: input.sourceIndex.trackerIssues.cached,
      issueCount: input.sourceIndex.trackerIssues.issues.length,
      error: null,
    },
    lanes,
    issues: cards,
    counts: {
      total: cards.length,
      trackerBacked: cards.filter((card) => card.origin === "tracker").length,
      symphonyOnly: cards.filter((card) => card.origin === "symphony").length,
      live: cards.filter((card) => card.live !== null).length,
      paused: cards.filter((card) => card.paused).length,
      blocked: cards.filter((card) => card.issueDetails.blockers.blocked).length,
    },
  };
}

type IssueBoardResponse = Awaited<ReturnType<typeof buildIssueBoard>>;

function trackerFailureFromSourceIndex(sourceIndex: BuiltWebProjectionSourceIndex): SymphonyError {
  const failure = sourceIndex.trackerIssues.error;
  if (!failure) return new SymphonyError("tracker_error", "Issue board tracker fetch failed");
  return new SymphonyError(failure.code === "tracker_unavailable" ? "tracker_unavailable" : "tracker_error", failure.message);
}

function isTrackerProjectionFailure(error: unknown): error is SymphonyError {
  return error instanceof SymphonyError && (error.code === "tracker_error" || error.code === "tracker_unavailable");
}

function acceptedBoardResponse(board: IssueBoardResponse) {
  const columns = board.lanes.map((lane) => ({
    id: lane.id,
    title: lane.title,
    states: lane.states,
    count: lane.issues.length,
    issues: lane.issues.map(acceptedBoardCard),
  }));
  return {
    generatedAt: board.generatedAt,
    tracker: board.tracker,
    columns,
    issues: board.issues.map(acceptedBoardCard),
    counts: board.counts,
  };
}

function acceptedBoardCard(card: IssueBoardCard): IssueBoardCard {
  const detailKey = card.issueId ?? card.issueIdentifier ?? card.key;
  return {
    ...card,
    capabilities: {
      ...card.capabilities,
      detail: `/api/v1/board/issues/${encodeURIComponent(detailKey)}`,
    },
  };
}

async function buildBoardIssueDetail(input: {
  requestKey: string;
  card: IssueBoardCard | null;
  sourceIndex: BuiltWebProjectionSourceIndex;
  mutationsConfigured: boolean;
  runStore: RunTranscriptStore | undefined;
  mcpExposureDiagnosticsStore: FileMcpExposureDiagnosticsStore | undefined;
  trackerStateLists: TrackerStateLists;
  staleThresholdMs: number;
  continuationSummaryAvailable: boolean;
}) {
  const snapshot = input.sourceIndex.runtime.snapshot;
  const keys = input.card?.issueId ? [input.card.issueId] : input.card ? boardCardKeys(input.card) : [input.requestKey];
  const live = liveIssueByKeys(input.sourceIndex, keys);
  const workspace = workspaceByKeys(input.sourceIndex, keys);
  const latestRun = latestRunByKeys(input.sourceIndex, keys);
  const rawLifecycle = lifecycleByKeys(input.sourceIndex, keys);
  const lifecycle = sanitizeStatusLifecycle({ live, workspace, latestRun, lifecycle: rawLifecycle });
  if (!input.card && !live && !workspace && !latestRun && !lifecycle) return null;

  const issueKey = input.card?.issueId ?? input.card?.issueIdentifier ?? input.requestKey;
  const summaryRun = await resolveIssueDetailsSummaryRun(live, latestRun, input.runStore, input.sourceIndex.runs);
  const runs = runsByKeys(input.sourceIndex, keys);
  const enrichedRuns = await Promise.all(
    runs.map(async (run) => ({
      ...publicRunRecord(run),
      operatorLiveness: await runOperatorLiveness(run, snapshot, lifecycle, runs, input.runStore),
      livenessSummary: runLivenessSummary(run, snapshot, lifecycle, runs),
    })),
  );
  const issueDetails =
    input.card?.issueDetails ??
    buildIssueDetailsEnvelope({
      requestKey: issueKey,
      generatedAt: snapshot.generatedAt,
      trackerStateLists: input.trackerStateLists,
      staleThresholdMs: input.staleThresholdMs,
      live,
      workspace,
      latestRun,
      summaryRun,
      lifecycle,
    });
  const allKeys = issueKeys(issueKey, { live, latestRun, lifecycle });
  const paused = isIssuePaused(snapshot, [input.requestKey, ...keys, ...allKeys]);
  const resolvedAgentId = live ? await resolveRunningAgentId(live, input.runStore, input.sourceIndex.runs) : null;
  const operatorLiveness = await issueOperatorLiveness({
    live,
    latestRun,
    lifecycle,
    paused,
    resolvedAgentId,
    runStore: input.runStore,
  });
  const controls = operatorControls({ issueKnown: true, live, paused, mutationsConfigured: input.mutationsConfigured });
  const affordances = operatorAffordances({
    issueKey,
    lifecycle,
    continuationSummaryAvailable: input.continuationSummaryAvailable,
    mutationsRequireToken: controls.mutationsRequireToken,
  });
  const workspacePath = live?.workspacePath ?? workspace?.path ?? null;
  const metadata = statusMetadata({ live, workspace, latestRun, lifecycle });
  return {
    issue: issueKey,
    boardCard: input.card ? acceptedBoardCard(input.card) : null,
    issueDetails,
    live: live ? liveIssueResponse(live, operatorLiveness) : null,
    workspace,
    latestRun: publicRunRecordOrNull(latestRun),
    runs: enrichedRuns,
    lifecycle,
    reviewLoop: reviewLoopStatus({ live, latestRun, lifecycle }),
    metadata,
    pullRequest: issueDetails.pullRequest,
    blockers: issueDetails.blockers,
    operatorLiveness,
    capabilities: {
      transcript: Boolean(latestRun),
      openWorkspace: workspacePath === null ? false : await pathExists(workspacePath),
      pause: controls.pause,
      resume: controls.resume,
      cancel: controls.cancel,
      humanRequired: affordances.humanRequired,
      continuationSummary: affordances.continuationSummary,
      mutationsRequireToken: controls.mutationsRequireToken,
      mutationHeader: "X-Symphony-Token",
    },
    diagnostics: {
      mcpToolExposure: (await input.mcpExposureDiagnosticsStore?.latest()) ?? null,
    },
    operatorLivenessContract: OPERATOR_LIVENESS_CONTRACT,
  };
}

const WEB_HISTORY_DEFAULT_SESSION_LIMIT = 100;
const WEB_HISTORY_DEFAULT_TIMELINE_LIMIT = 250;
const WEB_HISTORY_MAX_LIMIT = 500;
const WEB_DASHBOARD_RUN_LIMIT = 50;
const WEB_SIDEBAR_SESSION_LIMIT = 10;
const WEB_SIDEBAR_HISTORY_TIMELINE_LIMIT = 50;
const WEB_ISSUE_DETAIL_RUN_LIMIT = 25;
const WEB_TRANSCRIPT_DEFAULT_EVENT_LIMIT = 500;
const WEB_TRANSCRIPT_PAGE_LIMIT = 1_000;
const WEB_ORCHESTRATOR_CHAT_DEFAULT_MESSAGE_LIMIT = 100;
const ACTIVITY_TRANSCRIPT_TAIL_PER_RUN = 500;
const TERMINAL_ACTIVITY_TRANSCRIPT_TAIL = 256;

function parseWebHistoryLimits(url: URL): { sessionLimit: number; timelineLimit: number } {
  return {
    sessionLimit: parsePositiveIntegerQueryParam(
      url.searchParams,
      "sessionLimit",
      WEB_HISTORY_DEFAULT_SESSION_LIMIT,
      WEB_HISTORY_MAX_LIMIT,
    ),
    timelineLimit: parsePositiveIntegerQueryParam(
      url.searchParams,
      "timelineLimit",
      WEB_HISTORY_DEFAULT_TIMELINE_LIMIT,
      WEB_HISTORY_MAX_LIMIT,
    ),
  };
}

function parseBooleanWebQueryParam(searchParams: URLSearchParams, name: string): boolean {
  const value = searchParams.get(name)?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function parsePositiveIntegerQueryParam(searchParams: URLSearchParams, name: string, defaultValue: number, maxValue: number): number {
  const parsed = parseIntegerQueryParam(searchParams, name);
  if (parsed === null || parsed < 1) return defaultValue;
  return Math.min(parsed, maxValue);
}

function parseNonNegativeIntegerQueryParam(searchParams: URLSearchParams, name: string, defaultValue: number): number {
  const parsed = parseIntegerQueryParam(searchParams, name);
  if (parsed === null || parsed < 0) return defaultValue;
  return parsed;
}

function parseIntegerQueryParam(searchParams: URLSearchParams, name: string): number | null {
  if (!searchParams.has(name)) return null;
  const rawValue = searchParams.get(name)?.trim() ?? "";
  if (rawValue.length === 0) return null;
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return null;
  return Math.floor(value);
}

async function buildActivityFeed(input: {
  generatedAt: string;
  runStore: RunTranscriptStore | undefined;
  runs?: readonly RunRecord[];
  lifecycleStore: IssueLifecycleStore | undefined;
  lifecycleRecords?: readonly IssueLifecycleRecord[];
  writebackOutbox: Pick<FileWritebackOutboxStore, "list"> | undefined;
  writebackOperations?: readonly WritebackOperation[];
  query: ActivityQuery;
  includeTranscriptEvents?: boolean;
  defaultProjectContextId?: string | null | undefined;
}) {
  const allRuns = input.runs ?? (input.runStore ? await input.runStore.listRuns() : []);
  const includeTranscriptEvents = input.includeTranscriptEvents ?? true;
  const lifecycleRecords = input.lifecycleRecords ?? (await input.lifecycleStore?.list()) ?? [];
  const requestedProjectContextId = input.query.projectContextId ?? null;
  const scopedRuns = requestedProjectContextId
    ? allRuns.filter((run) => matchesActivityProjectContext(run.projectContext, requestedProjectContextId, input.defaultProjectContextId))
    : allRuns;
  const scopedLifecycleRecords = requestedProjectContextId
    ? lifecycleRecords.filter((lifecycle) =>
        matchesActivityProjectContext(lifecycle.projectContext, requestedProjectContextId, input.defaultProjectContextId),
      )
    : lifecycleRecords;
  const requestedIssueFilter = input.query.issue;
  const resolvedIssueFilter = requestedIssueFilter
    ? resolveActivityIssueFilter(requestedIssueFilter, scopedRuns, scopedLifecycleRecords, input.defaultProjectContextId)
    : null;
  const runs = resolvedIssueFilter ? scopedRuns.filter((run) => activityRunMatchesIssue(run, resolvedIssueFilter)) : scopedRuns;
  const activity: ActivityItem[] = [];
  let transcriptEventsConsidered = 0;
  let transcriptEventsTotal = 0;
  let transcriptEventsTruncated = false;
  let syntheticRunEvents = 0;
  let writebackOperationsConsidered = 0;

  for (const run of runs) {
    activity.push(activityItemForRun(run, "run_started", run.startedAt));
    syntheticRunEvents += 1;
    if (run.completedAt) {
      activity.push(activityItemForRun(run, "run_completed", run.completedAt));
      syntheticRunEvents += 1;
    }

    if (includeTranscriptEvents) {
      const totalEvents = input.runStore ? await input.runStore.readTranscriptEventCount(run.runId) : 0;
      transcriptEventsTotal += totalEvents;
      const transcriptOffset = Math.max(0, totalEvents - ACTIVITY_TRANSCRIPT_TAIL_PER_RUN);
      const events =
        input.runStore && totalEvents > 0
          ? (await input.runStore.readTranscript(run.runId, { offset: transcriptOffset, limit: ACTIVITY_TRANSCRIPT_TAIL_PER_RUN })).events
          : [];
      transcriptEventsConsidered += events.length;
      transcriptEventsTruncated ||= totalEvents > events.length;
      activity.push(...events.map((event) => activityItemForTranscriptEvent(run, event)));
    }
  }

  const writebackOperations = input.writebackOperations ?? (await input.writebackOutbox?.list()) ?? [];
  const projectScopedWritebackOperations = requestedProjectContextId
    ? writebackOperations.filter((operation) =>
        writebackOperationMatchesProjectContext(
          operation,
          requestedProjectContextId,
          allRuns,
          lifecycleRecords,
          input.defaultProjectContextId,
        ),
      )
    : writebackOperations;
  const filteredWritebackOperations = resolvedIssueFilter
    ? projectScopedWritebackOperations.filter((operation) =>
        writebackOperationMatchesIssue(
          operation,
          resolvedIssueFilter,
          allRuns,
          lifecycleRecords,
          input.defaultProjectContextId,
        ),
      )
    : projectScopedWritebackOperations;
  writebackOperationsConsidered = filteredWritebackOperations.length;
  activity.push(
    ...filteredWritebackOperations.map((operation) =>
      activityItemForWritebackOperation(operation, allRuns, lifecycleRecords, input.defaultProjectContextId),
    ),
  );

  activity.sort(compareActivityItems);
  const page = activity.slice(input.query.offset, input.query.offset + input.query.limit);
  const nextOffset = input.query.offset + page.length < activity.length ? input.query.offset + page.length : null;
  return {
    generatedAt: input.generatedAt,
    offset: input.query.offset,
    limit: input.query.limit,
    nextOffset,
    activity: page,
    counts: {
      totalItems: activity.length,
      distinctRunsConsidered: runs.length,
      transcriptEventsConsidered,
      transcriptEventsTotal,
      transcriptEventsIncluded: transcriptEventsConsidered,
      transcriptEventsTruncated,
      syntheticRunEvents,
      writebackOperationsConsidered,
    },
    source: {
      kind: "durable_activity" as const,
      runStoreAvailable: Boolean(input.runStore),
      writebackOutboxAvailable: Boolean(input.writebackOutbox || input.writebackOperations),
      transcriptTailPerRun: ACTIVITY_TRANSCRIPT_TAIL_PER_RUN,
    },
    filter: {
      issue: input.query.issue,
      projectContextId: requestedProjectContextId,
    },
  };
}

function previewActivityFeed<T extends { limit: number; nextOffset: number | null; activity: ActivityItem[] }>(feed: T, limit: number): T {
  const activity = feed.activity.slice(0, limit);
  return {
    ...feed,
    limit,
    nextOffset: feed.activity.length > activity.length ? activity.length : null,
    activity,
  };
}

function activityItemForRun(run: RunRecord, kind: Extract<ActivityItem["kind"], "run_started" | "run_completed">, at: string): ActivityItem {
  return {
    id: `run:${run.runId}:${kind}`,
    at,
    kind,
    source: "run",
    projectContext: activityProjectContext(run.projectContext),
    issue: activityIssue(run),
    run: activityRun(run),
    transcript: null,
    writeback: null,
    links: activityLinks(run, null),
  };
}

function activityItemForTranscriptEvent(run: RunRecord, event: TranscriptEvent): ActivityItem {
  return {
    id: `transcript:${run.runId}:${event.sequence}`,
    at: event.at,
    kind: "transcript_event",
    source: event.source,
    projectContext: activityProjectContext(run.projectContext),
    issue: activityIssue(run),
    run: activityRun(run),
    transcript: {
      sequence: event.sequence,
      eventType: event.eventType,
      message: event.message ?? null,
    },
    writeback: null,
    links: activityLinks(run, event),
  };
}

function activityItemForWritebackOperation(
  operation: WritebackOperation,
  runs: readonly RunRecord[],
  lifecycles: readonly IssueLifecycleRecord[],
  defaultProjectContextId: string | null | undefined,
): ActivityItem {
  const run = operation.runId ? (runs.find((candidate) => candidate.runId === operation.runId) ?? null) : null;
  const lifecycle = writebackOperationLifecycle(operation, lifecycles, defaultProjectContextId);
  const issueId = run?.issueId ?? lifecycle?.issueId ?? operation.issueId;
  const issueIdentifier = run?.issueIdentifier ?? lifecycle?.issueIdentifier ?? operation.issueId;
  return {
    id: `writeback:${writebackIdentityKey(operation.idempotencyKey, operation.projectContext)}`,
    at: operation.updatedAt,
    kind: "writeback_operation",
    source: "writeback",
    projectContext: activityProjectContext(run?.projectContext ?? lifecycle?.projectContext ?? operation.projectContext),
    issue: {
      id: issueId,
      identifier: issueIdentifier,
    },
    run: run ? activityRun(run) : null,
    transcript: null,
    writeback: {
      operationKind: operation.kind,
      status: operation.status,
      skipReason: writebackSkipReason(operation),
      attempt: operation.attempt,
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
      nextAttemptAt: operation.nextAttemptAt,
      transition:
        operation.kind === "transition"
          ? {
              toState: operation.payload.toState,
              fromStates: operation.payload.fromStates ?? null,
            }
          : null,
      comment:
        operation.kind === "comment"
          ? {
              dedupeKey: operation.payload.dedupeKey,
              bodyLength: operation.payload.body.length,
              bodyRedacted: true,
            }
          : null,
    },
    links: {
      issue: `/api/v1/board/issues/${encodeURIComponent(issueId)}`,
      run: operation.runId ? `/api/v1/runs/${encodeURIComponent(operation.runId)}` : null,
      transcript: null,
    },
  };
}

function activityProjectContext(projectContext: Partial<ProjectContextResolution> | null | undefined): ProjectContextResolution {
  return normalizeProjectContextResolution(projectContext);
}

function isWebSidebarProjectionPayloadCurrent(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return isWebHistorySessionListCurrent((value as { sessions?: unknown }).sessions);
}

function writebackSkipReason(operation: WritebackOperation): WritebackSkipReason | null {
  if (operation.status !== "skipped") return null;
  if (issueBreakdownPlanIdForOperation(operation) === null) return null;
  const persistedReason = operation.resultMessage ?? operation.lastError;
  if (persistedReason === ISSUE_BREAKDOWN_WRITEBACK_NOT_CURRENT_REASON) {
    return {
      code: "issue_breakdown_plan_not_current",
      message: "Issue breakdown writeback is not bound to the current plan.",
    };
  }
  if (persistedReason === ISSUE_BREAKDOWN_PLAN_STALE_REASON) {
    return {
      code: "issue_breakdown_plan_stale",
      message: "Issue breakdown plan is no longer fresh.",
    };
  }
  return null;
}

function activityIssue(run: RunRecord): ActivityItem["issue"] {
  return {
    id: run.issueId,
    identifier: run.issueIdentifier,
  };
}

function activityRun(run: RunRecord): ActivityItem["run"] {
  const runPhase = run.runPhase ?? null;
  return {
    runId: run.runId,
    role: run.role,
    runPhase,
    runKind: runPhase === null ? null : runKindForPhase(runPhase),
    status: run.status,
    agentId: run.agentId,
    sessionId: run.sessionId,
  };
}

function activityLinks(run: RunRecord, event: TranscriptEvent | null): ActivityItem["links"] {
  return {
    issue: `/api/v1/board/issues/${encodeURIComponent(run.issueId)}`,
    run: `/api/v1/runs/${encodeURIComponent(run.runId)}`,
    transcript: event
      ? `/api/v1/runs/${encodeURIComponent(run.runId)}/transcript?offset=${Math.max(event.sequence - 1, 0)}&limit=1`
      : null,
  };
}

function compareActivityItems(left: ActivityItem, right: ActivityItem): number {
  return (
    compareIsoDesc(left.at, right.at) ||
    compareNumber(kindRank(left.kind), kindRank(right.kind)) ||
    compareString(left.run?.runId ?? "", right.run?.runId ?? "") ||
    compareNumber(right.transcript?.sequence ?? -1, left.transcript?.sequence ?? -1) ||
    compareString(left.id, right.id)
  );
}

function kindRank(kind: ActivityItem["kind"]): number {
  switch (kind) {
    case "transcript_event":
      return 0;
    case "run_completed":
      return 1;
    case "run_started":
      return 2;
    case "writeback_operation":
      return 3;
  }
}

async function buildTrackerBoardCard(input: {
  issue: Issue;
  sourceIndex: BuiltWebProjectionSourceIndex;
  mutationsConfigured: boolean;
  runStore: RunTranscriptStore | undefined;
  trackerStateLists: TrackerStateLists;
  issueBoardColumns: IssueBoardColumnMapping;
  staleThresholdMs: number;
  continuationSummaryAvailable: boolean;
}): Promise<IssueBoardCard> {
  const snapshot = input.sourceIndex.runtime.snapshot;
  const issueStatus = toIssueStatusView(input.issue);
  const keys = [input.issue.id, input.issue.identifier];
  const live = liveIssueByKeys(input.sourceIndex, keys);
  const workspace = workspaceByKeys(input.sourceIndex, keys);
  const latestRun = latestRunByKeys(input.sourceIndex, keys);
  const rawLifecycle = lifecycleByKeys(input.sourceIndex, keys);
  const lifecycle = sanitizeStatusLifecycle({ live, workspace, latestRun, lifecycle: rawLifecycle });
  const summaryRun = await resolveIssueDetailsSummaryRun(live, latestRun, input.runStore, input.sourceIndex.runs);
  const paused = isIssuePaused(snapshot, [
    ...keys,
    ...issueKeys(input.issue.identifier, { live, latestRun, lifecycle }),
  ]);
  const issueDetails = buildIssueDetailsEnvelope({
    requestKey: input.issue.identifier,
    generatedAt: snapshot.generatedAt,
    trackerStateLists: input.trackerStateLists,
    staleThresholdMs: input.staleThresholdMs,
    live,
    workspace,
    latestRun,
    summaryRun,
    lifecycle,
    trackerIssue: issueStatus,
  });
  return buildBoardCard({
    key: input.issue.id,
    origin: "tracker",
    lane: classifyBoardLane(input.issue.state, lifecycle, live?.role ?? null, input.issueBoardColumns),
    issueDetails,
    live,
    workspace,
    latestRun,
    lifecycle,
    paused,
    mutationsConfigured: input.mutationsConfigured,
    runStore: input.runStore,
    runIndex: input.sourceIndex.runs,
    continuationSummaryAvailable: input.continuationSummaryAvailable,
  });
}

async function buildSymphonyOnlyBoardCards(input: {
  sourceIndex: BuiltWebProjectionSourceIndex;
  mutationsConfigured: boolean;
  runStore: RunTranscriptStore | undefined;
  trackerStateLists: TrackerStateLists;
  issueBoardColumns: IssueBoardColumnMapping;
  staleThresholdMs: number;
  continuationSummaryAvailable: boolean;
  representedKeys: Set<string>;
}): Promise<IssueBoardCard[]> {
  const snapshot = input.sourceIndex.runtime.snapshot;
  const cards: IssueBoardCard[] = [];
  const localKeys = new Set<string>();
  const maybeAdd = async (requestKey: string, forcedLive: RunningRow | null = null) => {
    if (hasBoardKey(input.representedKeys, [requestKey]) || hasBoardKey(localKeys, [requestKey])) return;
    const keys = [requestKey];
    const live = forcedLive ?? liveIssueByKeys(input.sourceIndex, keys);
    const workspace = workspaceByKeys(input.sourceIndex, keys);
    const latestRun = latestRunByKeys(input.sourceIndex, keys);
    const rawLifecycle = lifecycleByKeys(input.sourceIndex, keys);
    const lifecycle = sanitizeStatusLifecycle({ live, workspace, latestRun, lifecycle: rawLifecycle });
    const isBlocked = isLifecycleBlocked(lifecycle);
    const isPaused = isIssuePaused(snapshot, [
      requestKey,
      ...issueKeys(requestKey, { live, latestRun, lifecycle }),
    ]);
    if (!live && !isPaused && !isBlocked) return;
    if (!live && !isPaused && lifecycle?.phase === "terminal") return;
    const summaryRun = await resolveIssueDetailsSummaryRun(live, latestRun, input.runStore, input.sourceIndex.runs);
    const issueDetails = buildIssueDetailsEnvelope({
      requestKey,
      generatedAt: snapshot.generatedAt,
      trackerStateLists: input.trackerStateLists,
      staleThresholdMs: input.staleThresholdMs,
      live,
      workspace,
      latestRun,
      summaryRun,
      lifecycle,
    });
    const card = await buildBoardCard({
      key: issueDetails.issue.id ?? issueDetails.issue.identifier ?? requestKey,
      origin: "symphony",
      lane: classifyBoardLane(live?.state ?? issueDetails.issue.state, lifecycle, live?.role ?? null, input.issueBoardColumns),
      issueDetails,
      live,
      workspace,
      latestRun,
      lifecycle,
      paused: isPaused,
      mutationsConfigured: input.mutationsConfigured,
      runStore: input.runStore,
      runIndex: input.sourceIndex.runs,
      continuationSummaryAvailable: input.continuationSummaryAvailable,
    });
    addBoardKeys(localKeys, boardCardKeys(card));
    cards.push(card);
  };

  for (const live of snapshot.running) {
    await maybeAdd(live.issueId, live);
  }
  for (const pausedKey of snapshot.paused) {
    await maybeAdd(pausedKey);
  }
  for (const lifecycle of input.sourceIndex.lifecycles.records) {
    if (isLifecycleBlocked(lifecycle)) await maybeAdd(lifecycle.issueId);
  }
  return cards;
}

async function buildBoardCard(input: {
  key: string;
  origin: "tracker" | "symphony";
  lane: IssueBoardColumnId;
  issueDetails: IssueDetailsEnvelope;
  live: RunningRow | null;
  workspace: WorkspaceRecord | null | undefined;
  latestRun: RunRecord | null | undefined;
  lifecycle: IssueLifecycleRecord | null | undefined;
  paused: boolean;
  mutationsConfigured: boolean;
  runStore: RunTranscriptStore | undefined;
  runIndex?: BuiltWebProjectionSourceIndex["runs"];
  continuationSummaryAvailable: boolean;
}): Promise<IssueBoardCard> {
  const issueKey = input.issueDetails.issue.id ?? input.issueDetails.issue.identifier ?? input.key;
  const lifecycle = sanitizeStatusLifecycle({
    live: input.live,
    workspace: input.workspace,
    latestRun: input.latestRun,
    lifecycle: input.lifecycle,
  });
  const resolvedAgentId = input.live ? await resolveRunningAgentId(input.live, input.runStore, input.runIndex) : null;
  const operatorLiveness = await issueOperatorLiveness({
    live: input.live,
    latestRun: input.latestRun,
    lifecycle,
    paused: input.paused,
    resolvedAgentId,
    runStore: input.runStore,
  });
  const affordances = operatorAffordances({
    issueKey,
    lifecycle,
    continuationSummaryAvailable: input.continuationSummaryAvailable,
    mutationsRequireToken: input.mutationsConfigured,
  });
  return {
    key: input.key,
    issueId: input.issueDetails.issue.id,
    issueIdentifier: input.issueDetails.issue.identifier,
    origin: input.origin,
    lane: input.lane,
    issueDetails: input.issueDetails,
    paused: input.paused,
    live: input.live
      ? {
          role: input.live.role,
          runPhase: input.live.runPhase,
          runKind: input.live.runKind,
          state: input.live.state,
          runId: input.live.liveness.activeRunId ?? input.live.runId,
        }
      : null,
    operatorLiveness,
    reviewLoop: reviewLoopStatus({ live: input.live, latestRun: input.latestRun, lifecycle }),
    metadata: statusMetadata({
      live: input.live,
      workspace: input.workspace,
      latestRun: input.latestRun,
      lifecycle,
    }),
    capabilities: {
      detail: `/api/v1/issues/${encodeURIComponent(issueKey)}`,
      runs: `/api/v1/issues/${encodeURIComponent(issueKey)}/runs`,
      humanRequired: affordances.humanRequired,
      continuationSummary: affordances.continuationSummary,
    },
  };
}

const ISSUE_BOARD_COLUMN_IDS: IssueBoardColumnId[] = ["backlog", "todo", "progress", "review", "done", "canceled"];

function defaultIssueBoardColumns(stateLists: TrackerStateLists): IssueBoardColumnMapping {
  return {
    backlog: ["Backlog"],
    todo: stateLists.activeStates.filter((state) => isStateNameIn(state, ["Todo"])),
    progress: uniqueStateNames(
      [...stateLists.activeStates, ...stateLists.blockedStates].filter(
        (state) => !isStateNameIn(state, ["Todo", "Backlog"]),
      ),
    ),
    review: uniqueStateNames([...stateLists.handoffStates, ...stateLists.reviewStates]),
    done: stateLists.terminalStates.filter((state) => isStateNameIn(state, ["Done", "Closed"])),
    canceled: stateLists.terminalStates.filter((state) => isStateNameIn(state, ["Cancelled", "Canceled", "Duplicate"])),
  };
}

function boardFetchStates(columns: IssueBoardColumnMapping): string[] {
  return uniqueStateNames(ISSUE_BOARD_COLUMN_IDS.flatMap((column) => columns[column]));
}

function boardLanes(columns: IssueBoardColumnMapping): Array<Omit<IssueBoardLane, "issues">> {
  return ISSUE_BOARD_COLUMN_IDS.map((id) => ({
    id,
    title: boardColumnTitle(id),
    states: uniqueStateNames(columns[id]),
  }));
}

function boardColumnTitle(id: IssueBoardColumnId): string {
  switch (id) {
    case "backlog":
      return "Backlog";
    case "todo":
      return "Todo";
    case "progress":
      return "In Progress";
    case "review":
      return "Review";
    case "done":
      return "Done";
    case "canceled":
      return "Canceled";
  }
}

function classifyBoardLane(
  state: string | null,
  lifecycle: IssueLifecycleRecord | null | undefined,
  role: AgentRunRole | null,
  columns: IssueBoardColumnMapping,
): IssueBoardColumnId {
  if (state !== null) {
    for (const column of ISSUE_BOARD_COLUMN_IDS) {
      if (isStateNameIn(state, columns[column])) return column;
    }
  }
  if (isLifecycleBlocked(lifecycle)) return "progress";
  if (role === "reviewer") return "review";
  if (role === "worker") return "progress";
  if (lifecycle?.phase === "terminal") return "done";
  return "backlog";
}

function liveIssueByKeys(sourceIndex: BuiltWebProjectionSourceIndex, keys: string[]): RunningRow | null {
  for (const key of keys) {
    const live = sourceIndex.runtime.liveByIssueKey.get(key);
    if (live) return live;
  }
  return null;
}

function workspaceByKeys(sourceIndex: BuiltWebProjectionSourceIndex, keys: string[]): WorkspaceRecord | null {
  for (const key of keys) {
    const workspace = sourceIndex.workspaces.workspaceByIssueKey.get(key);
    if (workspace) return workspace;
  }
  return null;
}

function latestRunByKeys(sourceIndex: BuiltWebProjectionSourceIndex, keys: string[]): RunRecord | null {
  return runsByKeys(sourceIndex, keys).at(-1) ?? null;
}

function runsByKeys(sourceIndex: BuiltWebProjectionSourceIndex, keys: string[]): RunRecord[] {
  const byRunId = new Map<string, RunRecord>();
  for (const key of keys) {
    for (const run of sourceIndex.runs.runsByIssueKey.get(key) ?? []) {
      byRunId.set(run.runId, run);
    }
  }
  return [...byRunId.values()].sort(compareRunChronology);
}

function selectRecentRuns(runs: readonly RunRecord[], limit: number): RunRecord[] {
  if (limit <= 0) return [];
  return [...runs].sort(compareRunRecencyDesc).slice(0, limit);
}

function selectLatestChronologicalRuns(runs: readonly RunRecord[], limit: number): RunRecord[] {
  return selectRecentRuns(runs, limit).sort(compareRunChronology);
}

function compareRunRecencyDesc(left: RunRecord, right: RunRecord): number {
  return compareIsoDesc(left.updatedAt, right.updatedAt) || compareIsoDesc(left.startedAt, right.startedAt) || compareString(right.runId, left.runId);
}

type AliasResolutionStatus = "resolved" | "none" | "ambiguous" | "wrong_context";

interface ParsedContextualAlias {
  alias: string;
  projectContextId: string | null;
}

interface AliasResolutionResult<T> {
  status: AliasResolutionStatus;
  matches: T[];
  parsed: ParsedContextualAlias;
}

type IssueAliasCandidate =
  | { kind: "tracker"; record: Issue }
  | { kind: "live"; record: RunningRow }
  | { kind: "workspace"; record: WorkspaceRecord }
  | { kind: "run"; record: RunRecord }
  | { kind: "lifecycle"; record: IssueLifecycleRecord };

interface ResolvedIssueAliasData {
  status: AliasResolutionStatus;
  requestKey: string;
  live: RunningRow | null;
  workspace: WorkspaceRecord | null;
  latestRun: RunRecord | null;
  runs: RunRecord[];
  lifecycle: IssueLifecycleRecord | null;
}

interface ResolvedIssueActionTarget {
  lookupKey: string;
  requestAlias: string;
  projectContext: ProjectContextResolution | undefined;
  live: RunningRow | null;
  workspace: WorkspaceRecord | null;
  latestRun: RunRecord | null;
  lifecycle: IssueLifecycleRecord | null;
}

interface TranscriptRunResolution {
  status: AliasResolutionStatus;
  run: RunRecord | null;
}

interface ApprovalRouteResolution {
  status: AliasResolutionStatus;
  approval: OperatorApprovalRecord | null;
}

function parseContextualAlias(requestKey: string): ParsedContextualAlias {
  const trimmed = requestKey.trim();
  if (trimmed.length === 0) return { alias: "", projectContextId: null };
  const separatorIndex = trimmed.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex >= trimmed.length - 1) {
    return { alias: trimmed, projectContextId: null };
  }

  try {
    return {
      alias: trimmed.slice(separatorIndex + 1).trim(),
      projectContextId: normalizeProjectContextId(trimmed.slice(0, separatorIndex)),
    };
  } catch {
    return { alias: trimmed, projectContextId: null };
  }
}

function projectContextResolutionFromParsedAlias(parsed: ParsedContextualAlias): ProjectContextResolution | undefined {
  if (!parsed.projectContextId) return undefined;
  return {
    projectContextId: parsed.projectContextId,
    projectContextLabel: parsed.projectContextId,
    linearProjectSlug: null,
    routingSource: "explicit",
  };
}

function workspaceIssueInputFromLookupKey(lookupKey: string): WorkspaceIssueInput {
  const parsed = parseContextualAlias(lookupKey);
  const projectContext = projectContextResolutionFromParsedAlias(parsed);
  return {
    id: null,
    identifier: parsed.alias || lookupKey.trim(),
    branchName: null,
    ...(projectContext === undefined ? {} : { projectContext }),
  };
}

function workspacePathForLookupKey(lookupKey: string, workspaceManager: WorkspaceManager): string {
  return workspaceManager.getPathForIssue(workspaceIssueInputFromLookupKey(lookupKey));
}

function resolvedIssueActionProjectContext(
  input: Pick<ResolvedIssueAliasData, "live" | "workspace" | "latestRun" | "lifecycle">,
): ProjectContextResolution | undefined {
  return input.lifecycle?.projectContext ?? input.workspace?.projectContext ?? projectContextResolutionFromIssue(input.live) ?? input.latestRun?.projectContext;
}

function contextualWorkspaceLookupKey(
  issueIdentifier: string,
  projectContext: ProjectContextResolution | undefined,
  defaultProjectContextId: string | null | undefined,
): string {
  const normalizedIssueIdentifier = issueIdentifier.trim();
  if (normalizedIssueIdentifier.length === 0) return normalizedIssueIdentifier;
  const projectContextId = normalizeOptionalProjectContextId(projectContext?.projectContextId);
  if (!projectContextId) return normalizedIssueIdentifier;
  if (compatibilityDefaultProjectContextIds(defaultProjectContextId).has(projectContextId)) {
    return normalizedIssueIdentifier;
  }
  return `${projectContextId}:${normalizedIssueIdentifier}`;
}

function resolvedWorkspaceActionLookupKey(
  target: ResolvedIssueActionTarget,
  defaultProjectContextId: string | null | undefined,
): string {
  const persistedWorkspaceKey =
    target.workspace?.workspaceKey ?? target.latestRun?.workspaceKey ?? target.lifecycle?.summaryPointers.workspaceKey;
  if (typeof persistedWorkspaceKey === "string" && persistedWorkspaceKey.trim().length > 0) {
    return persistedWorkspaceKey;
  }

  const canonicalIssueIdentifier =
    target.workspace?.issueIdentifier ??
    target.latestRun?.issueIdentifier ??
    target.lifecycle?.issueIdentifier ??
    target.live?.issueIdentifier ??
    target.requestAlias ??
    target.lookupKey;
  return contextualWorkspaceLookupKey(canonicalIssueIdentifier, target.projectContext, defaultProjectContextId);
}

function normalizeOptionalProjectContextId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  try {
    return normalizeProjectContextId(trimmed);
  } catch {
    return null;
  }
}

function resolvedDefaultProjectContextId(defaultProjectContextId: string | null | undefined): string {
  return normalizeOptionalProjectContextId(defaultProjectContextId) ?? LEGACY_DEFAULT_PROJECT_CONTEXT_ID;
}

function compatibilityDefaultProjectContextIds(defaultProjectContextId: string | null | undefined): ReadonlySet<string> {
  const defaultContextId = resolvedDefaultProjectContextId(defaultProjectContextId);
  return defaultContextId === LEGACY_DEFAULT_PROJECT_CONTEXT_ID
    ? new Set([LEGACY_DEFAULT_PROJECT_CONTEXT_ID])
    : new Set([LEGACY_DEFAULT_PROJECT_CONTEXT_ID, defaultContextId]);
}

function projectContextIdForAliasMatching(record: unknown): string {
  return projectContextResolutionFromIssue(record)?.projectContextId ?? LEGACY_DEFAULT_PROJECT_CONTEXT_ID;
}

function projectContextGroupId(projectContextId: string, defaultProjectContextId: string | null | undefined): string {
  const defaultContextId = resolvedDefaultProjectContextId(defaultProjectContextId);
  return compatibilityDefaultProjectContextIds(defaultContextId).has(projectContextId) ? defaultContextId : projectContextId;
}

function resolveContextualAliasMatches<T>(input: {
  requestKey: string;
  candidates: readonly T[];
  aliasValues: (candidate: T) => readonly string[];
  projectContextId: (candidate: T) => string;
  defaultProjectContextId: string | null | undefined;
}): AliasResolutionResult<T> {
  const parsed = parseContextualAlias(input.requestKey);
  if (parsed.alias.length === 0) {
    return { status: "none", matches: [], parsed };
  }

  const defaultContextId = resolvedDefaultProjectContextId(input.defaultProjectContextId);
  const compatibilityIds = compatibilityDefaultProjectContextIds(defaultContextId);
  const rawMatches = input.candidates.filter((candidate) => input.aliasValues(candidate).some((alias) => alias === parsed.alias));
  if (rawMatches.length === 0) {
    return { status: "none", matches: [], parsed };
  }

  const groupedMatches = new Map<string, T[]>();
  for (const candidate of rawMatches) {
    const candidateContextId = input.projectContextId(candidate);
    const groupId = compatibilityIds.has(candidateContextId) ? defaultContextId : candidateContextId;
    const existing = groupedMatches.get(groupId) ?? [];
    existing.push(candidate);
    groupedMatches.set(groupId, existing);
  }

  if (parsed.projectContextId !== null) {
    const requestedGroupId = compatibilityIds.has(parsed.projectContextId) ? defaultContextId : parsed.projectContextId;
    const matches = groupedMatches.get(requestedGroupId) ?? [];
    return { status: matches.length > 0 ? "resolved" : "none", matches, parsed };
  }

  if (groupedMatches.size === 1 && groupedMatches.has(defaultContextId)) {
    return { status: "resolved", matches: groupedMatches.get(defaultContextId) ?? [], parsed };
  }
  if (groupedMatches.size === 1) {
    return { status: "wrong_context", matches: [], parsed };
  }
  return { status: "ambiguous", matches: [], parsed };
}

function issueAliasValuesForTracker(issue: Issue): string[] {
  return webProjectionIssueKeyAliases({ issueId: issue.id, issueIdentifier: issue.identifier });
}

function issueAliasValuesForLive(live: RunningRow): string[] {
  return webProjectionIssueKeyAliases({ issueId: live.issueId, issueIdentifier: live.issueIdentifier });
}

function issueAliasValuesForWorkspace(workspace: WorkspaceRecord): string[] {
  return webProjectionIssueKeyAliases({
    issueId: workspace.issueId,
    issueIdentifier: workspace.issueIdentifier,
    workspaceKey: workspace.workspaceKey,
  });
}

function issueAliasValuesForRun(run: RunRecord): string[] {
  return webProjectionIssueKeyAliases({
    issueId: run.issueId,
    issueIdentifier: run.issueIdentifier,
    workspaceKey: run.workspaceKey,
  });
}

function issueAliasValuesForLifecycle(lifecycle: IssueLifecycleRecord): string[] {
  return webProjectionIssueKeyAliases({ issueId: lifecycle.issueId, issueIdentifier: lifecycle.issueIdentifier });
}

function transcriptAliasValuesForRun(run: RunRecord): string[] {
  return webProjectionIssueKeyAliases({
    issueId: run.issueId,
    issueIdentifier: run.issueIdentifier,
    workspaceKey: run.workspaceKey,
    runId: run.runId,
    sessionId: run.sessionId,
  });
}

function buildIssueAliasCandidates(input: {
  snapshot: RuntimeSnapshot;
  trackerIssues?: readonly Issue[];
  runs: readonly RunRecord[];
  workspaces: readonly WorkspaceRecord[];
  lifecycles: readonly IssueLifecycleRecord[];
}): IssueAliasCandidate[] {
  return [
    ...(input.trackerIssues ?? []).map((record) => ({ kind: "tracker" as const, record })),
    ...input.snapshot.running.map((record) => ({ kind: "live" as const, record })),
    ...input.workspaces.map((record) => ({ kind: "workspace" as const, record })),
    ...input.runs.map((record) => ({ kind: "run" as const, record })),
    ...input.lifecycles.map((record) => ({ kind: "lifecycle" as const, record })),
  ];
}

function issueAliasValuesForCandidate(candidate: IssueAliasCandidate): string[] {
  switch (candidate.kind) {
    case "tracker":
      return issueAliasValuesForTracker(candidate.record);
    case "live":
      return issueAliasValuesForLive(candidate.record);
    case "workspace":
      return issueAliasValuesForWorkspace(candidate.record);
    case "run":
      return issueAliasValuesForRun(candidate.record);
    case "lifecycle":
      return issueAliasValuesForLifecycle(candidate.record);
  }
}

function issueAliasCandidateProjectContextId(candidate: IssueAliasCandidate): string {
  return projectContextIdForAliasMatching(candidate.record);
}

function addIssueAliasLookupKeys(target: Set<string>, candidate: IssueAliasCandidate): void {
  switch (candidate.kind) {
    case "tracker":
      target.add(candidate.record.id);
      target.add(candidate.record.identifier);
      return;
    case "live":
      target.add(candidate.record.issueId);
      target.add(candidate.record.issueIdentifier);
      return;
    case "workspace":
      if (candidate.record.issueId) target.add(candidate.record.issueId);
      target.add(candidate.record.issueIdentifier);
      target.add(candidate.record.workspaceKey);
      return;
    case "run":
      target.add(candidate.record.issueId);
      target.add(candidate.record.issueIdentifier);
      target.add(candidate.record.workspaceKey);
      return;
    case "lifecycle":
      target.add(candidate.record.issueId);
      target.add(candidate.record.issueIdentifier);
      return;
  }
}

function aliasValuesIntersect(values: readonly string[], keys: ReadonlySet<string>): boolean {
  return values.some((value) => keys.has(value));
}

interface WorkspaceContextSource {
  issueId: string | null;
  issueIdentifier: string;
  workspaceKey?: string | null;
  projectContext?: ProjectContextResolution | undefined;
}

function workspaceAliasMatchPriority(workspace: WorkspaceRecord, alias: string): number | null {
  if (workspace.workspaceKey === alias) return 0;
  if (workspace.issueIdentifier === alias) return 1;
  if (workspace.issueId === alias) return 2;
  return null;
}

function workspaceContextSourcePriority(workspace: WorkspaceRecord, source: WorkspaceContextSource): number | null {
  if (source.workspaceKey && workspace.workspaceKey === source.workspaceKey) return 0;
  if (workspace.issueId && source.issueId) return workspace.issueId === source.issueId ? 1 : null;
  return workspace.issueIdentifier === source.issueIdentifier ? 2 : null;
}

function resolveWorkspaceProjectContext(
  workspace: WorkspaceRecord,
  sources: readonly WorkspaceContextSource[],
): ProjectContextResolution | undefined {
  const explicitProjectContext = projectContextResolutionFromIssue(workspace) ?? workspace.projectContext;
  if (explicitProjectContext && explicitProjectContext.projectContextId !== LEGACY_DEFAULT_PROJECT_CONTEXT_ID) {
    return explicitProjectContext;
  }

  let bestMatch: { priority: number; legacyRank: number; projectContext: ProjectContextResolution } | null = null;
  for (const source of sources) {
    const priority = workspaceContextSourcePriority(workspace, source);
    const projectContext = projectContextResolutionFromIssue(source) ?? source.projectContext;
    if (priority === null || !projectContext) continue;
    const legacyRank = projectContext.projectContextId === LEGACY_DEFAULT_PROJECT_CONTEXT_ID ? 1 : 0;
    if (
      !bestMatch ||
      priority < bestMatch.priority ||
      (priority === bestMatch.priority && legacyRank < bestMatch.legacyRank)
    ) {
      bestMatch = { priority, legacyRank, projectContext };
    }
  }

  return bestMatch?.projectContext ?? explicitProjectContext ?? undefined;
}

async function resolveIssueAliasData(input: {
  requestKey: string;
  snapshot: RuntimeSnapshot;
  runStore: RunTranscriptStore | undefined;
  lifecycleStore: IssueLifecycleStore | undefined;
  defaultProjectContextId: string | null | undefined;
}): Promise<ResolvedIssueAliasData> {
  const runs = ((await input.runStore?.listRuns()) ?? []).sort(compareRunChronology);
  const workspaces = (await input.runStore?.listWorkspaces()) ?? [];
  const lifecycles = (await input.lifecycleStore?.list()) ?? [];
  const candidates = buildIssueAliasCandidates({ snapshot: input.snapshot, runs, workspaces, lifecycles });
  const resolution = resolveContextualAliasMatches({
    requestKey: input.requestKey,
    candidates,
    aliasValues: issueAliasValuesForCandidate,
    projectContextId: issueAliasCandidateProjectContextId,
    defaultProjectContextId: input.defaultProjectContextId,
  });
  if (resolution.status !== "resolved" || resolution.matches.length === 0) {
    return {
      status: resolution.status,
      requestKey: input.requestKey,
      live: null,
      workspace: null,
      latestRun: null,
      runs: [],
      lifecycle: null,
    };
  }

  const lookupKeys = new Set<string>();
  for (const match of resolution.matches) addIssueAliasLookupKeys(lookupKeys, match);
  const resolvedGroupId = projectContextGroupId(issueAliasCandidateProjectContextId(resolution.matches[0]!), input.defaultProjectContextId);
  const live =
    input.snapshot.running.find(
      (record) =>
        projectContextGroupId(projectContextIdForAliasMatching(record), input.defaultProjectContextId) === resolvedGroupId &&
        aliasValuesIntersect(issueAliasValuesForLive(record), lookupKeys),
    ) ?? null;
  const resolvedRuns = runs.filter(
    (record) =>
      projectContextGroupId(projectContextIdForAliasMatching(record), input.defaultProjectContextId) === resolvedGroupId &&
      aliasValuesIntersect(issueAliasValuesForRun(record), lookupKeys),
  );
  const lifecycle =
    lifecycles.find(
      (record) =>
        projectContextGroupId(projectContextIdForAliasMatching(record), input.defaultProjectContextId) === resolvedGroupId &&
        aliasValuesIntersect(issueAliasValuesForLifecycle(record), lookupKeys),
    ) ?? null;
  const workspaceContextSources: WorkspaceContextSource[] = [
    ...(live ? [live] : []),
    ...resolvedRuns,
    ...(lifecycle ? [lifecycle] : []),
  ];
  const workspaceCandidates = workspaces
    .map((record) => ({ record, projectContext: resolveWorkspaceProjectContext(record, workspaceContextSources) }))
    .filter(
      ({ record, projectContext }) =>
        projectContextGroupId(projectContext?.projectContextId ?? projectContextIdForAliasMatching(record), input.defaultProjectContextId) ===
          resolvedGroupId && aliasValuesIntersect(issueAliasValuesForWorkspace(record), lookupKeys),
    );
  const prioritizedWorkspaceCandidate = workspaceCandidates.reduce<
    | { record: WorkspaceRecord; projectContext: ProjectContextResolution | undefined; priority: number }
    | null
  >((best, candidate) => {
    const priority = workspaceAliasMatchPriority(candidate.record, resolution.parsed.alias);
    if (priority === null) return best;
    if (!best || priority < best.priority) {
      return { ...candidate, priority };
    }
    return best;
  }, null);
  const workspaceCandidate = prioritizedWorkspaceCandidate ?? workspaceCandidates[0] ?? null;
  const workspace = workspaceCandidate
    ? {
        ...workspaceCandidate.record,
        ...(workspaceCandidate.projectContext ? { projectContext: workspaceCandidate.projectContext } : {}),
      }
    : null;
  const inferredRuns = inferResolvedIssueRunsFromStrongIssueId({
    runs,
    resolvedRuns,
    lifecycle,
    workspace,
    live,
    resolvedGroupId,
    defaultProjectContextId: input.defaultProjectContextId,
  });
  const contextualRuns = [...resolvedRuns, ...inferredRuns].sort(compareRunChronology);
  return {
    status: "resolved",
    requestKey: lifecycle?.issueIdentifier ?? workspace?.issueIdentifier ?? contextualRuns.at(-1)?.issueIdentifier ?? live?.issueIdentifier ?? input.requestKey,
    live,
    workspace,
    latestRun: contextualRuns.at(-1) ?? null,
    runs: contextualRuns,
    lifecycle,
  };
}

function inferResolvedIssueRunsFromStrongIssueId(input: {
  runs: readonly RunRecord[];
  resolvedRuns: readonly RunRecord[];
  lifecycle: IssueLifecycleRecord | null;
  workspace: WorkspaceRecord | null;
  live: RunningRow | null;
  resolvedGroupId: string;
  defaultProjectContextId: string | null | undefined;
}): RunRecord[] {
  const strongIssueId = input.lifecycle?.issueId ?? input.workspace?.issueId ?? input.live?.issueId ?? null;
  if (!strongIssueId) return [];
  const resolvedRunIds = new Set(input.resolvedRuns.map((record) => record.runId));
  return input.runs.filter((record) => {
    if (resolvedRunIds.has(record.runId)) return false;
    if (record.issueId !== strongIssueId) return false;
    return projectContextGroupId(projectContextIdForAliasMatching(record), input.defaultProjectContextId) !== input.resolvedGroupId;
  });
}

async function resolveIssueActionTarget(input: {
  requestKey: string;
  snapshot: RuntimeSnapshot;
  runStore: RunTranscriptStore | undefined;
  lifecycleStore: IssueLifecycleStore | undefined;
  defaultProjectContextId: string | null | undefined;
}): Promise<{ status: Extract<AliasResolutionStatus, "ambiguous" | "wrong_context"> } | { status: "resolved"; target: ResolvedIssueActionTarget }> {
  const parsed = parseContextualAlias(input.requestKey);
  const fallbackLookupKey = parsed.alias || input.requestKey.trim();
  const fallbackProjectContext = projectContextResolutionFromParsedAlias(parsed);
  if (!input.runStore && !input.lifecycleStore) {
    return {
      status: "resolved",
      target: {
        lookupKey: fallbackLookupKey,
        requestAlias: parsed.alias,
        projectContext: fallbackProjectContext,
        live: null,
        workspace: null,
        latestRun: null,
        lifecycle: null,
      },
    };
  }

  const resolvedIssue = await resolveIssueAliasData(input);
  if (resolvedIssue.status === "ambiguous" || resolvedIssue.status === "wrong_context") {
    return { status: resolvedIssue.status };
  }
  if (resolvedIssue.status !== "resolved") {
    return {
      status: "resolved",
      target: {
        lookupKey: fallbackLookupKey,
        requestAlias: parsed.alias,
        projectContext: fallbackProjectContext,
        live: null,
        workspace: null,
        latestRun: null,
        lifecycle: null,
      },
    };
  }

  return {
    status: "resolved",
    target: {
      lookupKey:
        resolvedIssue.lifecycle?.issueId ??
        resolvedIssue.latestRun?.issueId ??
        resolvedIssue.workspace?.issueId ??
        resolvedIssue.live?.issueId ??
        fallbackLookupKey,
      requestAlias: parsed.alias,
      projectContext: resolvedIssueActionProjectContext(resolvedIssue) ?? fallbackProjectContext,
      live: resolvedIssue.live,
      workspace: resolvedIssue.workspace,
      latestRun: resolvedIssue.latestRun,
      lifecycle: resolvedIssue.lifecycle,
    },
  };
}

function issueRouteEvidenceRequest(
  requestKey: string,
): Pick<IssueRouteEvidence, "requestKey" | "requestAlias" | "requestedProjectContextId" | "lookupKey"> {
  const parsed = parseContextualAlias(requestKey);
  const trimmedRequestKey = requestKey.trim();
  const normalizedAlias = parsed.alias || trimmedRequestKey;
  return {
    requestKey: trimmedRequestKey,
    requestAlias: normalizedAlias,
    requestedProjectContextId: parsed.projectContextId ?? null,
    lookupKey: normalizedAlias,
  };
}

function issueRouteEvidenceAliasSources(
  input: Pick<ResolvedIssueActionTarget, "live" | "workspace" | "latestRun" | "lifecycle">,
): IssueRouteEvidenceSource[] {
  const sources: IssueRouteEvidenceSource[] = [];
  if (input.live) sources.push("alias_live");
  if (input.workspace) sources.push("alias_workspace");
  if (input.latestRun) sources.push("alias_run");
  if (input.lifecycle) sources.push("alias_lifecycle");
  return sources;
}

function buildIssueRouteEvidence(input: {
  kind: IssueRouteEvidence["kind"];
  requestKey: string;
  status: IssueRouteEvidence["status"];
  reason?: string | null;
  lookupKey?: string | null;
  requestedProjectContextId?: string | null;
  resolvedProjectContextId?: string | null;
  sources?: IssueRouteEvidenceSource[];
}): IssueRouteEvidence {
  const request = issueRouteEvidenceRequest(input.requestKey);
  return {
    kind: input.kind,
    requestKey: request.requestKey,
    requestAlias: request.requestAlias,
    requestedProjectContextId: input.requestedProjectContextId ?? request.requestedProjectContextId,
    resolvedProjectContextId: input.resolvedProjectContextId ?? null,
    lookupKey: input.lookupKey ?? request.lookupKey,
    sources: [...new Set(input.sources ?? [])],
    status: input.status,
    reason: input.reason ?? null,
    redacted: true,
  };
}

function mergeIssueRouteEvidence(base: IssueRouteEvidence, overlay: IssueRouteEvidence): IssueRouteEvidence {
  return {
    ...overlay,
    requestKey: base.requestKey,
    requestAlias: base.requestAlias,
    requestedProjectContextId: base.requestedProjectContextId,
    resolvedProjectContextId: overlay.resolvedProjectContextId ?? base.resolvedProjectContextId,
    lookupKey: overlay.lookupKey ?? base.lookupKey,
    sources: [...new Set([...base.sources, ...overlay.sources])],
    reason: overlay.reason ?? base.reason,
    redacted: true,
  };
}

function issueRouteEvidenceFromError(error: unknown): IssueRouteEvidence | null {
  if (!(error instanceof SymphonyError)) return null;
  const details = error.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const routeEvidence = (details as { routeEvidence?: unknown }).routeEvidence;
  if (!routeEvidence || typeof routeEvidence !== "object" || Array.isArray(routeEvidence)) return null;
  return (routeEvidence as IssueRouteEvidence).redacted === true ? (routeEvidence as IssueRouteEvidence) : null;
}

function mergeRouteEvidenceIntoError(error: unknown, routeEvidence: IssueRouteEvidence): unknown {
  if (!(error instanceof SymphonyError)) return error;
  const details =
    error.details && typeof error.details === "object" && !Array.isArray(error.details)
      ? { ...(error.details as Record<string, unknown>) }
      : {};
  const existing = issueRouteEvidenceFromError(error);
  return new SymphonyError(error.code, error.message, {
    ...details,
    routeEvidence: existing ? mergeIssueRouteEvidence(routeEvidence, existing) : routeEvidence,
  });
}

function statusAliasResolutionError(
  entityLabel: string,
  requestKey: string,
  status: Extract<AliasResolutionStatus, "ambiguous" | "wrong_context">,
  routeEvidence?: IssueRouteEvidence,
): SymphonyError {
  if (status === "ambiguous") {
    return new SymphonyError(
      "not_found",
      `${entityLabel} alias is ambiguous across project contexts: ${requestKey}. Use a context-qualified alias.`,
      routeEvidence ? { routeEvidence } : undefined,
    );
  }
  return new SymphonyError(
    "not_found",
    `${entityLabel} alias is not available through the default project context: ${requestKey}. Use a context-qualified alias.`,
    routeEvidence ? { routeEvidence } : undefined,
  );
}

function approvalAliasLookupKeys(requestKey: string, resolvedIssue: ResolvedIssueAliasData): string[] {
  return [
    requestKey,
    resolvedIssue.live?.issueId,
    resolvedIssue.live?.issueIdentifier,
    resolvedIssue.workspace?.issueId,
    resolvedIssue.workspace?.issueIdentifier,
    resolvedIssue.latestRun?.issueId,
    resolvedIssue.latestRun?.issueIdentifier,
    resolvedIssue.lifecycle?.issueId,
    resolvedIssue.lifecycle?.issueIdentifier,
  ].filter((value, index, values): value is string => value !== null && value !== undefined && values.indexOf(value) === index);
}

async function resolveCurrentPendingApprovalAlias(input: {
  approval: OperatorApprovalRecord | null;
  lifecycleStore: IssueLifecycleStore | undefined;
  runStore: RunTranscriptStore | undefined;
}): Promise<OperatorApprovalRecord | null> {
  if (!input.approval) return null;
  if (!input.lifecycleStore || !input.runStore) return input.approval;
  return currentPendingPublicationApproval({
    approval: input.approval,
    lifecycleStore: input.lifecycleStore,
    runStore: input.runStore,
  });
}

async function resolveApprovalRouteFromAlias(input: {
  operatorApproval: StatusServerOptions["operatorApproval"];
  requestKey: string;
  snapshot: RuntimeSnapshot;
  runStore: RunTranscriptStore | undefined;
  lifecycleStore: IssueLifecycleStore | undefined;
  defaultProjectContextId: string | null | undefined;
}): Promise<ApprovalRouteResolution> {
  const directApproval = await input.operatorApproval?.get(input.requestKey);
  if (directApproval) return { status: "resolved", approval: directApproval };
  if (!input.operatorApproval) return { status: "none", approval: null };

  if (input.runStore) {
    const resolvedRun = await resolveTranscriptRunFromAlias({
      runStore: input.runStore,
      requestKey: input.requestKey,
      defaultProjectContextId: input.defaultProjectContextId,
    });
    if (resolvedRun.status === "ambiguous" || resolvedRun.status === "wrong_context") {
      return { status: resolvedRun.status, approval: null };
    }
    if (resolvedRun.run) {
      const approval = await resolveCurrentPendingApprovalAlias({
        approval: await input.operatorApproval.findPendingForRun(resolvedRun.run.runId),
        lifecycleStore: input.lifecycleStore,
        runStore: input.runStore,
      });
      if (approval) return { status: "resolved", approval };
    }
  }

  const resolvedIssue = await resolveIssueAliasData({
    requestKey: input.requestKey,
    snapshot: input.snapshot,
    runStore: input.runStore,
    lifecycleStore: input.lifecycleStore,
    defaultProjectContextId: input.defaultProjectContextId,
  });
  if (resolvedIssue.status === "ambiguous" || resolvedIssue.status === "wrong_context") {
    return { status: resolvedIssue.status, approval: null };
  }
  if (resolvedIssue.status !== "resolved") return { status: "none", approval: null };

  const approval = await resolveCurrentPendingApprovalAlias({
    approval: await input.operatorApproval.findPendingForIssue(
      approvalAliasLookupKeys(input.requestKey, resolvedIssue),
      resolvedIssueActionProjectContext(resolvedIssue) ?? projectContextResolutionFromParsedAlias(parseContextualAlias(input.requestKey)),
    ),
    lifecycleStore: input.lifecycleStore,
    runStore: input.runStore,
  });
  return approval ? { status: "resolved", approval } : { status: "none", approval: null };
}

async function resolveTranscriptRunFromAlias(input: {
  runStore: RunTranscriptStore;
  requestKey: string;
  defaultProjectContextId: string | null | undefined;
}): Promise<TranscriptRunResolution> {
  const directRun = await input.runStore.getRun(input.requestKey);
  if (directRun) return { status: "resolved", run: directRun };

  const runs = (await input.runStore.listRuns()).sort(compareRunChronology);
  const directSessionMatches = runs.filter((record) => record.sessionId === input.requestKey);
  if (directSessionMatches.length === 1) return { status: "resolved", run: directSessionMatches[0] ?? null };
  if (directSessionMatches.length > 1) return { status: "ambiguous", run: null };

  const resolution = resolveContextualAliasMatches({
    requestKey: input.requestKey,
    candidates: runs,
    aliasValues: transcriptAliasValuesForRun,
    projectContextId: (record) => projectContextIdForAliasMatching(record),
    defaultProjectContextId: input.defaultProjectContextId,
  });
  if (resolution.status !== "resolved") {
    return { status: resolution.status, run: null };
  }

  const runIdMatches = resolution.matches.filter((record) => record.runId === resolution.parsed.alias);
  if (runIdMatches.length === 1) return { status: "resolved", run: runIdMatches[0] ?? null };
  if (runIdMatches.length > 1) return { status: "ambiguous", run: null };

  const sessionMatches = resolution.matches.filter((record) => record.sessionId === resolution.parsed.alias);
  if (sessionMatches.length === 1) return { status: "resolved", run: sessionMatches[0] ?? null };
  if (sessionMatches.length > 1) return { status: "ambiguous", run: null };

  return { status: "resolved", run: resolution.matches.at(-1) ?? null };
}

function lifecycleByKeys(sourceIndex: BuiltWebProjectionSourceIndex, keys: string[]): IssueLifecycleRecord | null {
  for (const key of keys) {
    const lifecycle = sourceIndex.lifecycles.lifecycleByIssueKey.get(key);
    if (lifecycle) return lifecycle;
  }
  return null;
}

function addBoardKeys(target: Set<string>, keys: Array<string | null | undefined>): void {
  for (const key of keys) {
    if (key) target.add(key);
  }
}

function hasBoardKey(target: Set<string>, keys: Array<string | null | undefined>): boolean {
  return keys.some((key) => key !== null && key !== undefined && target.has(key));
}

function boardCardKeys(card: IssueBoardCard): string[] {
  return [card.key, card.issueId, card.issueIdentifier].filter((value): value is string => value !== null && value !== undefined);
}

function resolveActivityIssueFilter(
  issue: string,
  runs: readonly RunRecord[],
  lifecycles: readonly IssueLifecycleRecord[],
  defaultProjectContextId: string | null | undefined,
): string {
  const lookupCandidates = dedupeIssueLookupCandidates(
    [...runs.map(issueLookupCandidateFromRun), ...lifecycles.map(issueLookupCandidateFromLifecycle)].filter(
      (candidate): candidate is IssueLookupCandidate => candidate !== null,
    ),
  );
  const lookup = resolveIssueLookupFromCandidates(issue, lookupCandidates);
  if (lookup.ambiguousCandidates.length > 0) throw ambiguousIssueLookupError(issue, lookup.ambiguousCandidates);
  if (lookup.issueId) return lookup.issueId;

  const parsed = parseContextualAlias(issue);
  if (parsed.projectContextId === null) return issue;

  const resolution = resolveContextualAliasMatches({
    requestKey: issue,
    candidates: [
      ...runs.map((record) => ({ kind: "run" as const, record })),
      ...lifecycles.map((record) => ({ kind: "lifecycle" as const, record })),
    ],
    aliasValues: issueAliasValuesForCandidate,
    projectContextId: issueAliasCandidateProjectContextId,
    defaultProjectContextId,
  });
  if (resolution.status !== "resolved" || resolution.matches.length === 0) return issue;

  const contextualCandidates = dedupeIssueLookupCandidates(
    resolution.matches
      .map(issueLookupCandidateFromAliasCandidate)
      .filter((candidate): candidate is IssueLookupCandidate => candidate !== null),
  );
  if (contextualCandidates.length > 1) throw ambiguousIssueLookupError(issue, contextualCandidates);
  return contextualCandidates[0]?.issueId ?? issue;
}

function writebackOperationLifecycle(
  operation: WritebackOperation,
  lifecycles: readonly IssueLifecycleRecord[],
  defaultProjectContextId: string | null | undefined,
): IssueLifecycleRecord | null {
  const candidateLifecycles = lifecycles.filter(
    (candidate) => candidate.issueId === operation.issueId || candidate.issueIdentifier === operation.issueId,
  );
  const explicitProjectContextId = normalizeOptionalProjectContextId(operation.projectContext?.projectContextId);
  if (explicitProjectContextId !== null) {
    const explicitProjectContextGroupId = projectContextGroupId(explicitProjectContextId, defaultProjectContextId);
    return candidateLifecycles.find(
      (candidate) => projectContextGroupId(projectContextIdForAliasMatching(candidate), defaultProjectContextId) === explicitProjectContextGroupId,
    ) ?? null;
  }
  return candidateLifecycles[0] ?? null;
}

function activityRunMatchesIssue(run: RunRecord, issueKey: string): boolean {
  return run.issueId === issueKey || run.issueIdentifier === issueKey;
}

function matchesActivityProjectContext(
  projectContext: Partial<ProjectContextResolution> | null | undefined,
  projectContextId: string | null | undefined,
  defaultProjectContextId: string | null | undefined,
): boolean {
  if (!projectContextId) return true;
  const candidateProjectContextId = normalizeProjectContextResolution(projectContext).projectContextId;
  return projectContextGroupId(candidateProjectContextId, defaultProjectContextId) === projectContextGroupId(projectContextId, defaultProjectContextId);
}

function writebackOperationProjectContext(
  operation: WritebackOperation,
  runs: readonly RunRecord[],
  lifecycles: readonly IssueLifecycleRecord[],
  defaultProjectContextId: string | null | undefined,
): Partial<ProjectContextResolution> | null | undefined {
  const run = operation.runId ? runs.find((candidate) => candidate.runId === operation.runId) : null;
  if (run?.projectContext) return run.projectContext;
  const lifecycle = writebackOperationLifecycle(operation, lifecycles, defaultProjectContextId);
  return lifecycle?.projectContext ?? operation.projectContext;
}

function writebackOperationMatchesProjectContext(
  operation: WritebackOperation,
  projectContextId: string | null | undefined,
  runs: readonly RunRecord[],
  lifecycles: readonly IssueLifecycleRecord[],
  defaultProjectContextId: string | null | undefined,
): boolean {
  return matchesActivityProjectContext(
    writebackOperationProjectContext(operation, runs, lifecycles, defaultProjectContextId),
    projectContextId,
    defaultProjectContextId,
  );
}

function writebackOperationMatchesIssue(
  operation: WritebackOperation,
  issueId: string,
  runs: readonly RunRecord[],
  lifecycles: readonly IssueLifecycleRecord[],
  defaultProjectContextId: string | null | undefined,
): boolean {
  if (operation.issueId === issueId) return true;
  const run = operation.runId ? runs.find((candidate) => candidate.runId === operation.runId) : null;
  if (run && activityRunMatchesIssue(run, issueId)) return true;
  const lifecycle = writebackOperationLifecycle(operation, lifecycles, defaultProjectContextId);
  return lifecycle ? lifecycle.issueId === issueId || lifecycle.issueIdentifier === issueId : false;
}

function uniqueStateNames(states: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const state of states) {
    const key = state.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(state);
  }
  return result;
}

async function renderDashboard(
  snapshot: RuntimeSnapshot,
  mutationsConfigured: boolean,
  runStore?: RunTranscriptStore,
  lifecycleStore?: IssueLifecycleStore,
  trackerStateLists?: TrackerStateLists,
  staleThresholdMs?: number,
): Promise<string> {
  const runningRows = await Promise.all(
    snapshot.running.map(async (row) => ({
      row,
      agentId: await resolveRunningAgentId(row, runStore),
    })),
  );
  const running = runningRows
    .map(({ row, agentId }) =>
      renderRunningRow(row, snapshot, mutationsConfigured, agentId, Boolean(lifecycleStore && runStore)),
    )
    .join("");
  const pausedRows = await pausedOperatorViews(
    snapshot.paused,
    snapshot.running,
    snapshot.generatedAt,
    trackerStateLists ?? defaultTrackerStateLists(),
    staleThresholdMs ?? 0,
    mutationsConfigured,
    runStore,
    lifecycleStore,
  );
  const paused =
    pausedRows.length === 0
      ? ""
      : `<section><h2>Paused</h2><ul class="plain-list">${pausedRows
          .map(
            (row) =>
              `<li><span class="paused-label">${escapeHtml(row.label)}</span> <code>${escapeHtml(row.issueId)}</code><div class="controls">controls: ${formatControls(row.controls)}</div>${formatAffordances(row)}</li>`,
          )
          .join("")}</ul></section>`;
  const retrying =
    snapshot.retrying.length === 0
      ? ""
      : `<section><h2>Retrying</h2><ul class="plain-list">${snapshot.retrying
          .map(
            (row) =>
              `<li><strong>${escapeHtml(row.issueIdentifier)}</strong> attempt ${row.attempt}, due ${escapeHtml(row.dueAt)}${
                row.error ? `, error ${escapeHtml(row.error)}` : ""
              }</li>`,
          )
          .join("")}</ul></section>`;
  const providerGates = renderProviderGateBanner(snapshot);
  const orphanedRows = await orphanedOperatorViews(snapshot, runStore);
  const orphaned =
    orphanedRows.length === 0
      ? ""
      : `<section><h2>Not Live Runs</h2><ul class="plain-list">${orphanedRows.map(renderOrphanedRunRow).join("")}</ul></section>`;
  return `<!doctype html>
<html>
  <head>
    <title>Symphony</title>
    <style>
      body { font-family: system-ui, sans-serif; line-height: 1.4; margin: 2rem; }
      code { background: #f5f5f5; border-radius: 4px; padding: 0.1rem 0.25rem; }
      .plain-list { padding-left: 0; }
      .plain-list li, .run-row { list-style: none; margin: 0 0 0.75rem; }
      .run-row { border: 1px solid #ddd; border-left: 5px solid #888; border-radius: 6px; padding: 0.75rem; }
      .run-row.operator-running { border-left-color: #2e7d32; }
      .run-row.operator-possibly_stalled { border-left-color: #e65100; background: #fff8ef; }
      .run-row.operator-cancelling { border-left-color: #c62828; background: #fff5f7; }
      .run-row.operator-blocked_human_required { border-left-color: #6a1b9a; background: #fbf5ff; }
      .badge { border-radius: 999px; display: inline-block; font-size: 0.8rem; font-weight: 700; margin-left: 0.4rem; padding: 0.1rem 0.45rem; }
      .operator-running .badge { background: #e8f5e9; color: #2e7d32; }
      .operator-possibly_stalled .badge { background: #fff3e0; color: #e65100; }
      .operator-cancelling .badge { background: #fce4ec; color: #c62828; }
      .operator-blocked_human_required .badge { background: #f3e5f5; color: #6a1b9a; }
      .operator-not_live { border-left-color: #607d8b; background: #f6f8f9; }
      .operator-not_live .badge { background: #eceff1; color: #455a64; }
      .meta, .activity, .controls { color: #555; font-size: 0.9rem; }
      .cancellation, .blocked { margin-top: 0.25rem; font-size: 0.9rem; }
      .cancellation { color: #a31919; }
      .blocked { color: #5e197c; }
      .paused-label { color: #555; }
      .provider-gate { border: 1px solid #bf7a00; border-left: 5px solid #bf7a00; background: #fff8e6; border-radius: 6px; margin: 0 0 1rem; padding: 0.75rem; }
      .provider-gate strong { color: #7a4a00; }
    </style>
  </head>
  <body>
    <h1>Symphony</h1>
    <p>Running: ${snapshot.counts.running}, retrying: ${snapshot.counts.retrying}, paused: ${snapshot.counts.paused}, provider gates: ${snapshot.counts.providerGates}</p>
    <p class="meta">Mutations ${mutationsConfigured ? "require X-Symphony-Token" : "do not require a configured token"}; use the existing pause, resume, cancel, and continuation-summary API endpoints.</p>
    ${providerGates}
    <section>
      <h2>Running Agents</h2>
      <ul class="plain-list">${running || "<li>No active runs</li>"}</ul>
    </section>
    ${paused}
    ${retrying}
    ${orphaned}
    <p class="meta">Snapshot generated at ${escapeHtml(snapshot.generatedAt)}</p>
  </body>
</html>`;
}

function renderProviderGateBanner(snapshot: RuntimeSnapshot): string {
  if (snapshot.providerGates.length === 0) return "";
  return `<section><h2>Provider Limits</h2>${snapshot.providerGates
    .map((gate) => {
      const provider = gate.scope.providerId ?? gate.scope.harnessId;
      const sourceInfo = gate.source;
      const resume =
        gate.resumePolicy === "auto_at_window_close" && gate.window?.resumeAt
          ? `resets at ${gate.window.resumeAt}`
          : "waiting for user resume";
      const affected = `${gate.affectedRoles.join(", ")} · ${gate.affectedRunPhases.join(", ")}`;
      const source = sourceInfo?.issueIdentifier || sourceInfo?.runId
        ? `triggered by ${sourceInfo.issueIdentifier ?? "unknown issue"}${sourceInfo.runId ? ` / ${sourceInfo.runId}` : ""}`
        : "triggering run unavailable";
      return `<div class="provider-gate"><strong>${escapeHtml(provider)}</strong> ${escapeHtml(gate.kind)} · ${escapeHtml(resume)}<div>${escapeHtml(gate.message)}</div><div class="meta">affected ${escapeHtml(affected)} · ${escapeHtml(source)} · gate <code>${escapeHtml(gate.id)}</code></div></div>`;
    })
    .join("")}</section>`;
}

function renderRunningRow(
  row: RunningRow,
  snapshot: RuntimeSnapshot,
  mutationsConfigured: boolean,
  agentId: string | null,
  continuationSummaryAvailable: boolean,
): string {
  const keys = issueKeys(row.issueIdentifier, { live: row, latestRun: null, lifecycle: row.lifecycle });
  const paused = isIssuePaused(snapshot, keys);
  const operator = runningOperatorLiveness(row, paused, row.lifecycle, agentId);
  const controls = operatorControls({ issueKnown: true, live: row, paused, mutationsConfigured });
  const affordances = operatorAffordances({
    issueKey: row.issueId,
    lifecycle: row.lifecycle,
    continuationSummaryAvailable,
    mutationsRequireToken: controls.mutationsRequireToken,
  });
  const runId = row.liveness.activeRunId ?? row.runId ?? "n/a";
  const idle = `${Math.round(row.liveness.secondsSinceLastActivity)}s idle`;
  const threshold = row.liveness.stallTimeoutMs === null ? "no idle alert threshold" : `${row.liveness.stallTimeoutMs}ms idle alert`;
  const cancellation = cancellationSummary(row);
  const cancelFailed = cancelFailedSummary(liveCancelFailed(row));
  const activitySources = activitySummary(row);
  const blockedReason = lifecycleBlockedReason(row.lifecycle);
  const conflictSummary = mergeConflictDashboardSummary(row.lifecycle?.mergeConflict ?? null);
  return `<li class="run-row operator-${operator.status}">
    <div><strong>${escapeHtml(row.issueIdentifier)}</strong><span class="badge">${escapeHtml(operator.status)}</span> <span class="meta">${escapeHtml(row.role)} · ${escapeHtml(row.runKind)} · ${escapeHtml(row.state)}</span></div>
    <div class="meta">run <code>${escapeHtml(runId)}</code> · agent <code>${escapeHtml(agentId ?? "n/a")}</code> · session <code>${escapeHtml(row.sessionId ?? "n/a")}</code>${paused ? " · paused" : ""}</div>
    <div class="activity">last activity ${escapeHtml(row.liveness.lastActivityAt)} (${escapeHtml(idle)}, ${escapeHtml(threshold)}); SDK status <code>${escapeHtml(row.liveness.sdkRunStatus ?? "n/a")}</code>; event <code>${escapeHtml(row.lastEvent ?? "n/a")}</code>${row.lastEventAt ? ` at ${escapeHtml(row.lastEventAt)}` : ""}</div>
    ${activitySources ? `<div class="activity">${escapeHtml(activitySources)}</div>` : ""}
    ${row.lastMessage ? `<div>${escapeHtml(row.lastMessage)}</div>` : ""}
    <div><code>${escapeHtml(row.workspacePath ?? "")}</code></div>
    ${cancellation ? `<div class="cancellation">${escapeHtml(cancellation)}</div>` : ""}
    ${cancelFailed ? `<div class="cancellation">${escapeHtml(cancelFailed)}</div>` : ""}
    ${blockedReason ? `<div class="blocked">Blocked: ${escapeHtml(blockedReason)}</div>` : ""}
    ${conflictSummary ? `<div class="blocked">Merge conflict: ${escapeHtml(conflictSummary)}</div>` : ""}
    <div class="controls">controls: ${formatControls(controls)}</div>
    ${formatAffordances(affordances)}
  </li>`;
}

function renderOrphanedRunRow(row: Awaited<ReturnType<typeof orphanedOperatorViews>>[number]): string {
  return `<li class="run-row operator-not_live">
    <div><strong>${escapeHtml(row.issueIdentifier)}</strong><span class="badge">not_live</span> <span class="meta">${escapeHtml(row.role)}</span></div>
    <div class="meta">run <code>${escapeHtml(row.runId)}</code> · agent <code>${escapeHtml(row.agentId ?? "n/a")}</code> · session <code>${escapeHtml(row.sessionId ?? "n/a")}</code></div>
    <div class="activity">persisted running run is not present in the live orchestrator snapshot; SDK status <code>${escapeHtml(row.sdkRunStatus ?? "n/a")}</code>${row.lastActivityAt ? `; last activity ${escapeHtml(row.lastActivityAt)}` : ""}</div>
    <div><code>${escapeHtml(row.workspacePath ?? "")}</code></div>
    <div class="controls">controls: none</div>
  </li>`;
}

async function operatorSnapshotView(
  snapshot: RuntimeSnapshot,
  mutationsConfigured: boolean,
  runStore?: RunTranscriptStore,
  lifecycleStore?: IssueLifecycleStore,
  trackerStateLists: TrackerStateLists = defaultTrackerStateLists(),
  staleThresholdMs = 0,
) {
  const running = await Promise.all(
    snapshot.running.map(async (row) => {
      const keys = issueKeys(row.issueIdentifier, { live: row, latestRun: null, lifecycle: row.lifecycle });
      const paused = isIssuePaused(snapshot, keys);
      const agentId = await resolveRunningAgentId(row, runStore);
      const lookupOptions = row.lifecycle?.projectContext ? { projectContext: row.lifecycle.projectContext } : {};
      const workspace =
        (await runStore?.findWorkspace(row.issueId, lookupOptions)) ??
        (await runStore?.findWorkspace(row.issueIdentifier, lookupOptions));
      const latestRun =
        (await runStore?.latestRunForIssue(row.issueId, lookupOptions)) ??
        (await runStore?.latestRunForIssue(row.issueIdentifier, lookupOptions));
      const summaryRun = await resolveIssueDetailsSummaryRun(row, latestRun, runStore);
      const controls = operatorControls({ issueKnown: true, live: row, paused, mutationsConfigured });
      const mergeConflict = mergeConflictOperatorSummary(row.lifecycle?.mergeConflict ?? null);
      const affordances = operatorAffordances({
        issueKey: row.issueId,
        lifecycle: row.lifecycle,
        continuationSummaryAvailable: Boolean(lifecycleStore && runStore),
        mutationsRequireToken: controls.mutationsRequireToken,
      });
      return {
        issueId: row.issueId,
        issueIdentifier: row.issueIdentifier,
        role: row.role,
        runPhase: row.runPhase,
        runKind: row.runKind,
        state: row.state,
        ...(row.projectContext === undefined ? {} : { projectContext: row.projectContext }),
        runId: row.liveness.activeRunId ?? row.runId,
        workspacePath: row.workspacePath,
        paused,
        issueDetails: buildIssueDetailsEnvelope({
          requestKey: row.issueId,
          generatedAt: snapshot.generatedAt,
          trackerStateLists,
          staleThresholdMs,
          live: row,
          workspace,
          latestRun,
          summaryRun,
          lifecycle: row.lifecycle,
        }),
        liveness: runningOperatorLiveness(row, paused, row.lifecycle, agentId),
        mergeConflict,
        controls,
        ...affordances,
      };
    }),
  );
  const orphaned = await orphanedOperatorViews(snapshot, runStore);
  return {
    generatedAt: snapshot.generatedAt,
    mutationsRequireToken: mutationsConfigured,
    operatorLivenessContract: OPERATOR_LIVENESS_CONTRACT,
    providerGates: snapshot.providerGates.map((gate) => providerGateOperatorSummary(gate, mutationsConfigured)),
    providerGateCounts: snapshot.providerGateCounts,
    running,
    orphaned,
    paused: await pausedOperatorViews(
      snapshot.paused,
      snapshot.running,
      snapshot.generatedAt,
      trackerStateLists,
      staleThresholdMs,
      mutationsConfigured,
      runStore,
      lifecycleStore,
    ),
    retrying: snapshot.retrying,
  };
}

async function orphanedOperatorViews(snapshot: RuntimeSnapshot, runStore?: RunTranscriptStore) {
  if (!runStore) return [];
  const runs = (await runStore.listRuns())
    .filter((run) => isOrphanedPersistedRun(run, snapshot))
    .sort(compareRunChronology)
    .slice(-25)
    .reverse();
  return runs.map((run) => ({
    issueId: run.issueId,
    issueIdentifier: run.issueIdentifier,
    role: run.role ?? "unknown",
    runId: run.runId,
    agentId: run.agentId,
    sessionId: run.sessionId,
    workspacePath: run.workspacePath ?? null,
    rawStatus: run.status,
    tracking: "orphaned" as const,
    status: "not_live" as const,
    sdkRunStatus: run.sdkRunStatus ?? null,
    sdkRunStatusUpdatedAt: run.sdkRunStatusObservedAt ?? null,
    sdkRunStatusSource: run.sdkRunStatusSource ?? null,
    lastActivityAt: run.activitySnapshot?.lastHarnessActivityAt ?? run.updatedAt,
    controls: { pause: false, resume: false, cancel: false, mutationsRequireToken: false },
  }));
}

function providerGateOperatorSummary(gate: RuntimeSnapshot["providerGates"][number], mutationsConfigured: boolean) {
  return {
    id: gate.id,
    provider: gate.scope.providerId ?? gate.scope.harnessId,
    harnessId: gate.scope.harnessId,
    model: gate.scope.model ?? null,
    kind: gate.kind,
    message: gate.message,
    resumePolicy: gate.resumePolicy,
    resumeAt: gate.window?.resumeAt ?? null,
    windowLabel: gate.window?.windowLabel ?? null,
    windowKind: gate.window?.windowKind ?? null,
    affectedRoles: gate.affectedRoles,
    affectedRunPhases: gate.affectedRunPhases,
    source: gate.source === null ? null : gate.source === undefined ? undefined : publicProviderLimitSource(gate.source),
    controls: {
      clear: true,
      resume: true,
      mutationsRequireToken: mutationsConfigured,
    },
  };
}

function runningOperatorLiveness(row: RunningRow, paused: boolean, lifecycle: IssueLifecycleRecord | null | undefined = row.lifecycle, agentId: string | null = null) {
  const status = liveOperatorStatus(row, lifecycle);
  return {
    status,
    rawStatus: row.liveness.status,
    tracking: "live",
    cancelFailed: liveCancelFailed(row),
    linearAuditComments: OPERATOR_LIVENESS_CONTRACT.deferred.linearAuditComments,
    runId: row.runId,
    activeRunId: row.liveness.activeRunId,
    agentId,
    sessionId: row.sessionId,
    workspacePath: row.workspacePath,
    lastActivityAt: row.liveness.lastActivityAt,
    lastTranscriptEventAt: row.lastEventAt,
    lastTranscriptEvent: publicDiagnosticText(row.lastEvent),
    lastMessage: publicDiagnosticText(row.lastMessage),
    secondsSinceLastActivity: row.liveness.secondsSinceLastActivity,
    stallTimeoutMs: row.liveness.stallTimeoutMs,
    sdkRunStatus: row.liveness.sdkRunStatus ?? null,
    sdkRunStatusUpdatedAt: row.liveness.sdkRunStatusUpdatedAt ?? null,
    sdkRunStatusSource: row.liveness.sdkRunStatusSource ?? null,
    idleAlert: row.liveness.idleAlert ?? null,
    cancellation: publicLiveCancellation(row.cancellation),
    paused,
    activity: liveActivity(row),
    timeline: liveTimeline(row),
  };
}

async function resolveRunningAgentId(
  row: RunningRow,
  runStore?: RunTranscriptStore,
  runIndex?: BuiltWebProjectionSourceIndex["runs"],
): Promise<string | null> {
  const runId = row.liveness.activeRunId ?? row.runId;
  if (runId && runIndex) {
    const run = runIndex.runById.get(runId) ?? null;
    if (runMatchesLiveRow(row, run)) return run.agentId;
  }
  if (runIndex) {
    for (const issueKey of [row.issueId, row.issueIdentifier]) {
      const run = runIndex.latestRunByIssueKey.get(issueKey) ?? null;
      if (runMatchesLiveRow(row, run)) return run.agentId;
    }
  }
  if (!runStore) return null;
  if (runId) {
    const run = await runStore.getRun(runId);
    if (runMatchesLiveRow(row, run)) return run.agentId;
  }
  const lookupOptions = row.lifecycle?.projectContext ? { projectContext: row.lifecycle.projectContext } : {};
  for (const issueKey of [row.issueId, row.issueIdentifier]) {
    const run = await runStore.latestRunForIssue(issueKey, lookupOptions);
    if (runMatchesLiveRow(row, run)) return run.agentId;
  }
  return null;
}

function runMatchesLiveRow(row: RunningRow, run: RunRecord | null): run is RunRecord {
  return run !== null && (run.runId === row.runId || run.runId === row.liveness.activeRunId);
}

async function pausedOperatorViews(
  pausedKeys: string[],
  running: RunningRow[],
  generatedAt: string,
  trackerStateLists: TrackerStateLists,
  staleThresholdMs: number,
  mutationsConfigured: boolean,
  runStore?: RunTranscriptStore,
  lifecycleStore?: IssueLifecycleStore,
): Promise<PausedOperatorView[]> {
  return Promise.all(
    pausedKeys.map(async (pausedKey) => {
      const lifecycle = (await lifecycleStore?.get(pausedKey)) ?? null;
      const lookupOptions = lifecycle?.projectContext ? { projectContext: lifecycle.projectContext } : {};
      const workspace = await runStore?.findWorkspace(pausedKey, lookupOptions);
      const latestRun = await runStore?.latestRunForIssue(pausedKey, lookupOptions);
      const live = running.find((row) => row.issueId === pausedKey || row.issueIdentifier === pausedKey) ?? null;
      const summaryRun = await resolveIssueDetailsSummaryRun(live, latestRun, runStore);
      const issueIdentifier = lifecycle?.issueIdentifier ?? workspace?.issueIdentifier ?? pausedKey;
      const controls = operatorControls({ issueKnown: true, live: null, paused: true, mutationsConfigured });
      return {
        issueId: pausedKey,
        issueIdentifier,
        label: `Paused ${issueIdentifier}`,
        paused: true,
        controls,
        issueDetails: buildIssueDetailsEnvelope({
          requestKey: lifecycle?.issueId ?? workspace?.issueId ?? latestRun?.issueId ?? pausedKey,
          generatedAt,
          trackerStateLists,
          staleThresholdMs,
          live,
          workspace,
          latestRun,
          summaryRun,
          lifecycle,
        }),
        ...operatorAffordances({
          issueKey: lifecycle?.issueId ?? workspace?.issueId ?? latestRun?.issueId ?? pausedKey,
          lifecycle,
          continuationSummaryAvailable: Boolean(lifecycleStore && runStore),
          mutationsRequireToken: controls.mutationsRequireToken,
        }),
      };
    }),
  );
}

async function issueOperatorLiveness(input: {
  live: RunningRow | null;
  latestRun: RunRecord | null | undefined;
  lifecycle: IssueLifecycleRecord | null | undefined;
  paused: boolean;
  resolvedAgentId: string | null;
  runStore: RunTranscriptStore | undefined;
}) {
  if (input.live) {
    return runningOperatorLiveness(input.live, input.paused, input.lifecycle ?? input.live.lifecycle, input.resolvedAgentId);
  }
  if (isLifecycleBlocked(input.lifecycle)) {
    return terminalOperatorLiveness("blocked_human_required", input.latestRun ?? null, input.lifecycle ?? null, input.paused, input.runStore);
  }
  if (input.latestRun?.status === "cancelled" || input.latestRun?.cancellationRequestedAt || input.latestRun?.cancelFailed) {
    return terminalOperatorLiveness("cancelled", input.latestRun, input.lifecycle ?? null, input.paused, input.runStore);
  }
  if (input.latestRun?.status === "running") {
    return orphanedOperatorLiveness(input.latestRun, input.paused, input.runStore);
  }
  return null;
}

async function runOperatorLiveness(
  run: RunRecord,
  snapshot: RuntimeSnapshot,
  lifecycle: IssueLifecycleRecord | null = null,
  issueRuns: RunRecord[] = [],
  runStore?: RunTranscriptStore,
) {
  const live = findLiveRun(snapshot, run.runId);
  if (live) {
    const keys = issueKeys(run.issueIdentifier, { live, latestRun: run, lifecycle: live.lifecycle });
    return runningOperatorLiveness(live, isIssuePaused(snapshot, keys), live.lifecycle, run.agentId);
  }
  if (isLatestRunForBlockedLifecycle(run, lifecycle, issueRuns)) {
    return terminalOperatorLiveness("blocked_human_required", run, lifecycle, false, runStore);
  }
  if (run.status === "cancelled" || run.cancellationRequestedAt || run.cancelFailed) {
    return terminalOperatorLiveness("cancelled", run, null, false, runStore);
  }
  if (isOrphanedPersistedRun(run, snapshot)) {
    return orphanedOperatorLiveness(run, false, runStore);
  }
  return null;
}

async function resolveWebTranscriptRun(
  runStore: RunTranscriptStore,
  sessionIdOrRunId: string,
  defaultProjectContextId: string | null | undefined,
): Promise<TranscriptRunResolution> {
  return resolveTranscriptRunFromAlias({
    runStore,
    requestKey: sessionIdOrRunId,
    defaultProjectContextId,
  });
}

async function readBoundedWebTranscript(runStore: RunTranscriptStore, runId: string, url?: URL): Promise<TranscriptEvent[]> {
  return (await readBoundedWebTranscriptPage(runStore, runId, url)).events;
}

async function readBoundedWebTranscriptPage(runStore: RunTranscriptStore, runId: string, url?: URL): Promise<TranscriptPage> {
  const requestedPage = parseWebTranscriptPagination(url);
  if (requestedPage) return runStore.readTranscript(runId, requestedPage);

  return runStore.readTranscriptTail(runId, { limit: WEB_TRANSCRIPT_DEFAULT_EVENT_LIMIT });
}

async function readFullWebTranscriptPage(runStore: RunTranscriptStore, runId: string): Promise<TranscriptPage> {
  const events: TranscriptEvent[] = [];
  let offset = 0;
  let total: number | null = null;
  let completed = false;
  for (let pageCount = 0; pageCount < 10_000; pageCount += 1) {
    const page = await runStore.readTranscript(runId, { offset, limit: WEB_TRANSCRIPT_PAGE_LIMIT });
    events.push(...page.events);
    if (typeof page.total === "number" && Number.isFinite(page.total)) total = page.total;
    if (page.nextOffset === null) {
      completed = true;
      break;
    }
    if (page.nextOffset <= offset) throw new Error(`Transcript pagination did not advance for run ${runId}`);
    offset = page.nextOffset;
  }
  if (!completed) throw new Error(`Transcript pagination exceeded safety limit for run ${runId}`);
  const firstEvent = events[0] ?? null;
  const lastEvent = events.at(-1) ?? null;
  return {
    runId,
    offset: 0,
    limit: total ?? events.length,
    nextOffset: null,
    events,
    total: total ?? events.length,
    eventCount: events.length,
    previousOffset: null,
    hasPrevious: false,
    hasNext: false,
    windowKind: "page",
    firstSequence: firstEvent?.sequence ?? null,
    lastSequence: lastEvent?.sequence ?? null,
    lastEventAt: lastEvent?.at ?? null,
  };
}

function parseWebTranscriptPagination(url: URL | undefined): { offset: number; limit: number } | null {
  if (!url || (!url.searchParams.has("offset") && !url.searchParams.has("limit"))) return null;
  return {
    offset: parseNonNegativeIntegerQueryParam(url.searchParams, "offset", 0),
    limit: parsePositiveIntegerQueryParam(
      url.searchParams,
      "limit",
      WEB_TRANSCRIPT_DEFAULT_EVENT_LIMIT,
      WEB_TRANSCRIPT_PAGE_LIMIT,
    ),
  };
}

async function runTelemetrySummary(runId: string, runStore?: RunTranscriptStore): Promise<{
  transcriptRecall: { calls: number; returnedEvents: number; returnedChars: number; truncations: number; denied: number };
  laneMemo: { updates: number; latestSizeChars: number | null };
}> {
  const empty = {
    transcriptRecall: { calls: 0, returnedEvents: 0, returnedChars: 0, truncations: 0, denied: 0 },
    laneMemo: { updates: 0, latestSizeChars: null },
  } as {
    transcriptRecall: { calls: number; returnedEvents: number; returnedChars: number; truncations: number; denied: number };
    laneMemo: { updates: number; latestSizeChars: number | null };
  };
  if (!runStore) return empty;
  const events: TranscriptEvent[] = [];
  let offset = 0;
  do {
    const page = await runStore.readTranscript(runId, { offset, limit: 1_000 });
    events.push(...page.events);
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  } while (true);
  return events.reduce((summary, event) => {
    if (event.eventType === "transcript_recall" && isRecord(event.payload)) {
      summary.transcriptRecall.calls += 1;
      summary.transcriptRecall.returnedEvents += numberValue(event.payload.returnedEvents);
      summary.transcriptRecall.returnedChars += numberValue(event.payload.returnedChars);
      if (event.payload.truncated === true) summary.transcriptRecall.truncations += 1;
      if (event.payload.denied === true) summary.transcriptRecall.denied += 1;
    }
    if (event.eventType === "lane_memo_updated" && isRecord(event.payload)) {
      summary.laneMemo.updates += 1;
      summary.laneMemo.latestSizeChars = numberValue(event.payload.memoSizeChars);
    }
    return summary;
  }, empty);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function publicRuntimeSnapshot(snapshot: RuntimeSnapshot): RuntimeSnapshot {
  const publicSnapshot = sanitizePublicJson(snapshot) as RuntimeSnapshot;
  return {
    ...publicSnapshot,
    providerGates: snapshot.providerGates.map(publicProviderGate),
    running: snapshot.running.map(publicLiveRow),
  };
}

function publicRunRecord(run: RunRecord): RunRecord {
  const projectContext = publicProjectContext(run.projectContext);
  const record: RunRecord = {
    ...run,
    error: publicDiagnosticText(run.error),
    ...(projectContext === undefined ? {} : { projectContext }),
    ...(run.providerLimit === undefined
      ? {}
      : { providerLimit: run.providerLimit === null ? null : publicProviderLimitSignal(run.providerLimit) }),
    ...(run.commandPolicy === undefined
      ? {}
      : { commandPolicy: sanitizeCommandPolicyReplayStateForPublicOutput(run.commandPolicy) }),
  };
  if (run.cancelFailedReason !== undefined) record.cancelFailedReason = publicDiagnosticText(run.cancelFailedReason);
  if (run.harnessStopFailedReason !== undefined) record.harnessStopFailedReason = publicDiagnosticText(run.harnessStopFailedReason);
  return record;
}

function publicRunRecordOrNull(run: RunRecord | null | undefined): RunRecord | null {
  return run ? publicRunRecord(run) : null;
}

function publicDiagnosticText(value: string | null | undefined): string | null {
  return sanitizedPreviewValue(value).preview;
}

function publicProjectContext(
  projectContext: Partial<ProjectContextResolution> | undefined,
): ProjectContextResolution | undefined {
  if (projectContext === undefined) return undefined;
  const publicProjectContext = sanitizePublicJson(projectContext) as Partial<ProjectContextResolution>;
  return normalizeProjectContextResolution(publicProjectContext);
}

function publicNullableProjectContext(
  projectContext: Partial<ProjectContextResolution> | null | undefined,
): ProjectContextResolution | null | undefined {
  if (projectContext === null) return null;
  return publicProjectContext(projectContext);
}

function publicProviderLimitSource(
  source: NonNullable<RuntimeSnapshot["providerGates"][number]["source"]>,
): RuntimeSnapshot["providerGates"][number]["source"] {
  const publicSource = sanitizePublicJson(source) as NonNullable<RuntimeSnapshot["providerGates"][number]["source"]>;
  const projectContext = publicNullableProjectContext(publicSource.projectContext);
  return {
    ...publicSource,
    ...(projectContext === undefined ? {} : { projectContext }),
  };
}

function publicProviderLimitSignal(signal: NonNullable<RunRecord["providerLimit"]>): NonNullable<RunRecord["providerLimit"]> {
  return {
    ...signal,
    ...(signal.source === undefined ? {} : { source: signal.source === null ? null : publicProviderLimitSource(signal.source) }),
  };
}

function publicProviderGate(gate: RuntimeSnapshot["providerGates"][number]): RuntimeSnapshot["providerGates"][number] {
  const publicGate = sanitizePublicJson(gate) as RuntimeSnapshot["providerGates"][number];
  return {
    ...publicGate,
    ...(gate.source === undefined ? {} : { source: gate.source === null ? null : publicProviderLimitSource(gate.source) }),
  };
}

function publicWorkspaceRecord(workspace: WorkspaceRecord): WorkspaceRecord {
  const projectContext = publicProjectContext(workspace.projectContext);
  return {
    ...workspace,
    ...(projectContext === undefined ? {} : { projectContext }),
  };
}

function publicLiveRow(row: RunningRow): RunningRow {
  const publicRow = sanitizePublicJson(row) as RunningRow;
  const projectContext = publicProjectContext(
    row.projectContext ?? projectContextResolutionFromIssue(publicRow.issueDetails) ?? row.lifecycle?.projectContext,
  );
  return {
    ...publicRow,
    lastEvent: publicDiagnosticText(row.lastEvent),
    lastMessage: publicDiagnosticText(row.lastMessage),
    ...(projectContext === undefined ? {} : { projectContext }),
    cancellation: publicLiveCancellation(publicRow.cancellation),
  };
}

function publicLiveCancellation(cancellation: RunningRow["cancellation"]): RunningRow["cancellation"] {
  const publicCancellation: RunningRow["cancellation"] = {
    ...cancellation,
    reason: publicDiagnosticText(cancellation.reason),
    harnessStopFailedReason: publicDiagnosticText(cancellation.harnessStopFailedReason),
  };
  if (cancellation.cancelFailed) {
    publicCancellation.cancelFailed = publicLiveCancelFailed(cancellation.cancelFailed);
  }
  return publicCancellation;
}

function publicLiveCancelFailed(cancelFailed: NonNullable<RunningRow["cancellation"]["cancelFailed"]>) {
  return {
    ...cancelFailed,
    reason: publicDiagnosticText(cancelFailed.reason),
  };
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function runLivenessSummary(
  run: RunRecord,
  snapshot: RuntimeSnapshot,
  lifecycle: IssueLifecycleRecord | null = null,
  issueRuns: RunRecord[] = [],
) {
  const live = findLiveRun(snapshot, run.runId);
  if (live) {
    const keys = issueKeys(run.issueIdentifier, { live, latestRun: run, lifecycle: live.lifecycle });
    return {
      tracking: "live",
      status: liveOperatorStatus(live, live.lifecycle),
      paused: isIssuePaused(snapshot, keys),
    };
  }
  if (isLatestRunForBlockedLifecycle(run, lifecycle, issueRuns)) {
    return { tracking: "terminal", status: "blocked_human_required" as const, paused: false };
  }
  if (run.status === "cancelled" || run.cancellationRequestedAt || run.cancelFailed)
    return { tracking: "terminal", status: "cancelled" as const, paused: false, cancelFailed: terminalCancelFailed(run) };
  if (isOrphanedPersistedRun(run, snapshot)) return { tracking: "orphaned", status: "not_live" as const, rawStatus: "running" as const, paused: false };
  return { tracking: "terminal", status: null, paused: false };
}

async function orphanedOperatorLiveness(run: RunRecord, paused: boolean, runStore?: RunTranscriptStore) {
  return {
    status: "not_live" as const,
    rawStatus: run.status,
    tracking: "orphaned" as const,
    cancelFailed: terminalCancelFailed(run),
    linearAuditComments: OPERATOR_LIVENESS_CONTRACT.deferred.linearAuditComments,
    runId: run.runId,
    activeRunId: null,
    agentId: run.agentId ?? null,
    sessionId: run.sessionId ?? null,
    workspacePath: run.workspacePath ?? null,
    lastActivityAt: run.activitySnapshot?.lastHarnessActivityAt ?? run.updatedAt,
    lastTranscriptEventAt: null,
    lastTranscriptEvent: null,
    lastMessage: "Persisted running run is not present in the live orchestrator snapshot",
    secondsSinceLastActivity: null,
    stallTimeoutMs: null,
    sdkRunStatus: run.sdkRunStatus ?? null,
    sdkRunStatusUpdatedAt: run.sdkRunStatusObservedAt ?? null,
    sdkRunStatusSource: run.sdkRunStatusSource ?? null,
    idleAlert: null,
    cancellation: null,
    paused,
    activity: await terminalActivity(run, null, runStore),
    timeline: [],
  };
}

async function terminalOperatorLiveness(
  status: Extract<OperatorLivenessStatus, "cancelled" | "blocked_human_required">,
  run: RunRecord | null,
  lifecycle: IssueLifecycleRecord | null,
  paused: boolean,
  runStore?: RunTranscriptStore,
) {
  return {
    status,
    rawStatus: run?.status ?? null,
    tracking: "terminal",
    cancelFailed: terminalCancelFailed(run),
    linearAuditComments: OPERATOR_LIVENESS_CONTRACT.deferred.linearAuditComments,
    runId: run?.runId ?? lifecycle?.summaryPointers.lastRunId ?? null,
    activeRunId: null,
    agentId: run?.agentId ?? null,
    sessionId: run?.sessionId ?? null,
    workspacePath: run?.workspacePath ?? lifecycle?.summaryPointers.workspacePath ?? null,
    lastActivityAt: run?.updatedAt ?? lifecycle?.updatedAt ?? null,
    lastTranscriptEventAt: null,
    lastTranscriptEvent: null,
    lastMessage: lifecycle?.blockedReason ?? publicDiagnosticText(run?.error),
    secondsSinceLastActivity: null,
    stallTimeoutMs: null,
    cancellation: null,
    paused,
    activity: await terminalActivity(run, lifecycle, runStore),
    timeline: terminalTimeline(status, run, lifecycle),
  };
}

function liveCancelFailed(row: RunningRow) {
  if (row.cancellation.cancelFailed) return publicLiveCancelFailed(row.cancellation.cancelFailed);
  if (row.cancellation.harnessStopFailedAt) {
    return {
      tracked: true,
      active: true,
      phase: "failed",
      at: row.cancellation.harnessStopFailedAt,
      reason: publicDiagnosticText(row.cancellation.harnessStopFailedReason),
      source: "harness_stop",
    };
  }
  return {
    tracked: true,
    active: false,
    phase: row.cancellation.requested ? "requested" : "none",
    at: null,
    reason: null,
    source: null,
  };
}

function terminalCancelFailed(run: RunRecord | null) {
  if (!run) {
    return { tracked: true, active: false, phase: "none", at: null, reason: null, source: null };
  }
  if (run.cancelFailed) {
    return {
      tracked: true,
      active: true,
      phase: "resolved_failed",
      at: run.cancelFailedAt ?? null,
      reason: publicDiagnosticText(run.cancelFailedReason),
      source: run.cancelFailedSource ?? null,
    };
  }
  return {
    tracked: true,
    active: false,
    phase: run.cancellationRequestedAt ? "resolved_cancelled" : "none",
    at: null,
    reason: null,
    source: null,
  };
}

function liveActivity(row: RunningRow) {
  return (
    row.activity ?? {
      lastHarnessActivityAt: row.liveness.lastActivityAt,
      lastStreamActivityAt: null,
      lastDeltaOrToolActivityAt: null,
      lastToolActivityAt: null,
      unavailable: ["activity_source_not_available_in_snapshot"],
    }
  );
}

async function terminalActivity(run: RunRecord | null, lifecycle: IssueLifecycleRecord | null, runStore?: RunTranscriptStore) {
  if (run?.activitySnapshot) {
    return {
      ...run.activitySnapshot,
      unavailable: [],
    };
  }
  if (run && runStore) {
    const totalEvents = await runStore.readTranscriptEventCount(run.runId);
    const offset = Math.max(0, totalEvents - TERMINAL_ACTIVITY_TRANSCRIPT_TAIL);
    const page = await runStore.readTranscript(run.runId, { offset, limit: TERMINAL_ACTIVITY_TRANSCRIPT_TAIL });
    return deriveTerminalActivityFromTranscript(page.events, run.updatedAt ?? lifecycle?.updatedAt ?? null);
  }
  return {
    lastHarnessActivityAt: run?.updatedAt ?? lifecycle?.updatedAt ?? null,
    lastStreamActivityAt: null,
    lastDeltaOrToolActivityAt: null,
    lastToolActivityAt: null,
    unavailable: ["transcript_store_unavailable"],
  };
}

function deriveTerminalActivityFromTranscript(events: TranscriptEvent[], fallbackHarnessActivityAt: string | null) {
  let lastHarnessActivityAt: string | null = null;
  let lastStreamActivityAt: string | null = null;
  let lastDeltaOrToolActivityAt: string | null = null;
  let lastToolActivityAt: string | null = null;

  for (const event of events) {
    if (event.source !== "harness") continue;
    lastHarnessActivityAt = latestIso(lastHarnessActivityAt, event.at);
    if (event.eventType !== "progress") continue;

    const source = transcriptActivitySource(event.payload);
    if (source === "stream") {
      lastStreamActivityAt = latestIso(lastStreamActivityAt, event.at);
    }
    if (source === "delta" || source === "tool") {
      lastDeltaOrToolActivityAt = latestIso(lastDeltaOrToolActivityAt, event.at);
    }
    if (source === "tool") {
      lastToolActivityAt = latestIso(lastToolActivityAt, event.at);
    }
  }

  return {
    lastHarnessActivityAt: lastHarnessActivityAt ?? fallbackHarnessActivityAt,
    lastStreamActivityAt,
    lastDeltaOrToolActivityAt,
    lastToolActivityAt,
    unavailable: [],
  };
}

function transcriptActivitySource(payload: unknown): "stream" | "delta" | "tool" {
  if (payload && typeof payload === "object" && "activitySource" in payload) {
    const source = (payload as { activitySource?: unknown }).activitySource;
    if (source === "delta" || source === "tool" || source === "stream") return source;
  }
  return "stream";
}

function latestIso(current: string | null, candidate: string): string {
  if (current === null) return candidate;
  return Date.parse(candidate) >= Date.parse(current) ? candidate : current;
}

function blockedIssueView(lifecycle: IssueLifecycleRecord | null | undefined) {
  if (lifecycle === null || lifecycle === undefined || !isLifecycleBlocked(lifecycle)) return null;
  const blockedLifecycle = lifecycle;
  return {
    status: "blocked_human_required" as const,
    reason: lifecycleBlockedReason(blockedLifecycle),
    issueId: blockedLifecycle.issueId,
    issueIdentifier: blockedLifecycle.issueIdentifier,
    continuationSummaryRecommended: true,
  };
}

function isLatestRunForBlockedLifecycle(
  run: RunRecord,
  lifecycle: IssueLifecycleRecord | null | undefined,
  issueRuns: RunRecord[],
): boolean {
  if (lifecycle === null || lifecycle === undefined || !isLifecycleBlocked(lifecycle)) return false;
  const blockedLifecycle = lifecycle;
  if (blockedLifecycle.summaryPointers.lastRunId) return run.runId === blockedLifecycle.summaryPointers.lastRunId;
  const latestRun = issueRuns[issueRuns.length - 1] ?? null;
  return latestRun?.runId === run.runId;
}

function liveTimeline(row: RunningRow) {
  return [
    {
      at: row.startedAt,
      kind: "run_started",
      label: "Run started",
      detail: row.runId,
      synthetic: true,
      source: "live_snapshot",
    },
    {
      at: row.liveness.lastActivityAt,
      kind: "last_activity",
      label: "Last harness activity",
      detail: publicDiagnosticText(row.lastMessage ?? row.lastEvent),
      synthetic: true,
      source: "live_snapshot",
    },
    ...(row.cancellation.requestedAt
      ? [
          {
            at: row.cancellation.requestedAt,
            kind: "cancellation_requested",
            label: "Cancellation requested",
            detail: publicDiagnosticText(row.cancellation.reason),
            synthetic: true,
            source: "live_snapshot",
          },
        ]
      : []),
    ...(row.cancellation.harnessStopRequestedAt
      ? [
          {
            at: row.cancellation.harnessStopRequestedAt,
            kind: "harness_stop_requested",
            label: "Harness stop requested",
            detail: row.cancellation.source,
            synthetic: true,
            source: "live_snapshot",
          },
        ]
      : []),
    ...(row.cancellation.harnessStopFailedAt
      ? [
          {
            at: row.cancellation.harnessStopFailedAt,
            kind: "harness_stop_failed",
            label: "Harness stop failed",
            detail: publicDiagnosticText(row.cancellation.harnessStopFailedReason),
            synthetic: true,
            source: "live_snapshot",
          },
        ]
      : []),
  ];
}

function terminalTimeline(
  status: Extract<OperatorLivenessStatus, "cancelled" | "blocked_human_required">,
  run: RunRecord | null,
  lifecycle: IssueLifecycleRecord | null,
) {
  return [
    ...(run
      ? [
          {
            at: run.startedAt,
            kind: "run_started",
            label: "Run started",
            detail: run.runId,
            synthetic: true,
            source: "run_record",
          },
        ]
      : []),
    ...(run?.completedAt
      ? [
          {
            at: run.completedAt,
            kind: "run_terminal",
            label: `Run ${run.status}`,
            detail: publicDiagnosticText(run.error),
            synthetic: true,
            source: "run_record",
          },
        ]
      : []),
    ...(run?.cancelFailed
      ? [
          {
            at: run.cancelFailedAt ?? run.completedAt ?? run.updatedAt,
            kind: "cancel_failed",
            label: "Cancel failed",
            detail: publicDiagnosticText(run.cancelFailedReason),
            synthetic: true,
            source: "run_record",
          },
        ]
      : []),
    ...(status === "blocked_human_required" && lifecycle
      ? [
          {
            at: lifecycle.updatedAt,
            kind: "lifecycle_blocked",
            label: "Human-required block recorded",
            detail: lifecycleBlockedReason(lifecycle),
            synthetic: true,
            source: "lifecycle_store",
          },
        ]
      : []),
  ];
}

function liveOperatorStatus(row: RunningRow, lifecycle: IssueLifecycleRecord | null | undefined): OperatorLivenessStatus {
  if (row.cancellation.requested || row.liveness.status === "cancelling") return "cancelling";
  if (isLifecycleBlocked(lifecycle)) return "blocked_human_required";
  return "running";
}

function isOrphanedPersistedRun(run: RunRecord, snapshot: RuntimeSnapshot): boolean {
  return run.status === "running" && findLiveRun(snapshot, run.runId) === null;
}

function findLiveRun(snapshot: RuntimeSnapshot, runId: string): RunningRow | null {
  return snapshot.running.find((row) => row.runId === runId || row.liveness.activeRunId === runId) ?? null;
}

function isLifecycleBlocked(lifecycle: IssueLifecycleRecord | null | undefined): boolean {
  return (
    lifecycle !== null &&
    lifecycle !== undefined &&
    (lifecycle.phase === "blocked" ||
      lifecycle.blockedReason !== null ||
      lifecycle.mergeConflict?.status === "blocked" ||
      lifecycle.mergeConflict?.resolutionStatus === "blocked")
  );
}

function lifecycleBlockedReason(lifecycle: IssueLifecycleRecord | null | undefined): string | null {
  if (lifecycle === null || lifecycle === undefined) return null;
  return lifecycle.blockedReason ?? lifecycle.mergeConflict?.blockedReason ?? null;
}

function mergeConflictOperatorSummary(conflict: IssueMergeConflictMetadata | null) {
  if (conflict === null) return null;
  return {
    conflictState: conflict.conflictsState,
    status: conflict.status,
    resolutionStatus: conflict.resolutionStatus,
    fixTurnCount: conflict.fixTurnCount,
    maxFixTurns: conflict.maxFixTurns,
    attemptsLabel: `${conflict.fixTurnCount}/${conflict.maxFixTurns}`,
    attemptRunIds: conflict.attemptRunIds,
    pullRequest: {
      url: conflict.pullRequest.url,
      number: conflict.pullRequest.number,
      branch: conflict.pullRequest.branch,
      headSha: conflict.pullRequest.headSha,
    },
    approvedHeadSha: conflict.approvedHeadSha,
    currentHeadSha: conflict.currentHeadSha,
    resolvedHeadSha: conflict.resolvedHeadSha,
    baseBranch: conflict.baseBranch,
    baseHeadSha: conflict.baseHeadSha,
    lastConflictFixRunId: conflict.lastConflictFixRunId,
    lastConflictResolutionReportId: conflict.lastConflictResolutionReportId,
    blockedReason: conflict.blockedReason,
  };
}

function mergeConflictDashboardSummary(conflict: IssueMergeConflictMetadata | null): string | null {
  const summary = mergeConflictOperatorSummary(conflict);
  if (summary === null) return null;
  const pr =
    summary.pullRequest.number === null
      ? summary.pullRequest.url ?? "n/a"
      : `#${summary.pullRequest.number}${summary.pullRequest.url === null ? "" : ` ${summary.pullRequest.url}`}`;
  return [
    `state=${summary.conflictState}`,
    `status=${summary.status}/${summary.resolutionStatus}`,
    `attempts=${summary.attemptsLabel}`,
    `PR=${pr}`,
    `branch=${summary.pullRequest.branch ?? "n/a"}`,
    `head=${summary.pullRequest.headSha ?? summary.currentHeadSha}`,
    `base=${summary.baseBranch ?? "n/a"}@${summary.baseHeadSha ?? "n/a"}`,
    `lastRun=${summary.lastConflictFixRunId ?? "n/a"}`,
    ...(summary.blockedReason === null ? [] : [`blocked=${summary.blockedReason}`]),
  ].join("; ");
}

function liveIssueResponse(live: RunningRow, operatorLiveness: Awaited<ReturnType<typeof issueOperatorLiveness>>) {
  return { ...publicLiveRow(live), operatorLiveness };
}

function buildIssueDetailsEnvelope(input: {
  requestKey: string;
  generatedAt: string;
  trackerStateLists: TrackerStateLists;
  staleThresholdMs: number;
  live: RunningRow | null;
  latestRun: RunRecord | null | undefined;
  summaryRun: RunRecord | null | undefined;
  lifecycle: IssueLifecycleRecord | null | undefined;
  workspace: WorkspaceRecord | null | undefined;
  trackerIssue?: IssueStatusView;
}): IssueDetailsEnvelope {
  const inactiveLifecycle = sanitizeInactiveMergeGateLifecycle(input.lifecycle);
  const inactiveInput = { ...input, lifecycle: inactiveLifecycle };
  const initialMetadata = statusMetadata(inactiveInput);
  const lifecycle = sanitizeStaleMergeGateLifecycle(inactiveLifecycle, initialMetadata.prHeadSha, initialMetadata.prNumber);
  const sanitizedInput = { ...input, lifecycle };
  const metadata = statusMetadata(sanitizedInput);
  const issue = input.trackerIssue ?? input.live?.issueDetails ?? null;
  if (issue) {
    return {
      source: input.trackerIssue ? "tracker" : "live",
      completeness: "full",
      issue,
      tracker: buildIssueTrackerMetadata(issue, input.generatedAt, input.trackerStateLists, input.staleThresholdMs),
      blockers: buildIssueBlockerSummary(issue.blockedBy, input.trackerStateLists, lifecycle, issue.state),
      workspace: buildIssueWorkspaceSummary(sanitizedInput, metadata),
      pullRequest: buildIssuePullRequestSummary(metadata),
      mergeGate: mergeGateStatus(lifecycle, buildIssuePullRequestSummary(metadata)),
      latestRun: buildIssueLatestRunSummary(input.summaryRun),
    };
  }

  return {
    source: "durable",
    completeness: "partial",
    issue: durableIssueStatusView(sanitizedInput),
    tracker: buildIssueTrackerMetadata(null, null, input.trackerStateLists, input.staleThresholdMs),
    blockers: buildIssueBlockerSummary(null, input.trackerStateLists, lifecycle, null),
    workspace: buildIssueWorkspaceSummary(sanitizedInput, metadata),
    pullRequest: buildIssuePullRequestSummary(metadata),
    mergeGate: mergeGateStatus(lifecycle, buildIssuePullRequestSummary(metadata)),
    latestRun: buildIssueLatestRunSummary(input.summaryRun),
  };
}

async function resolveIssueDetailsSummaryRun(
  live: RunningRow | null,
  issueWideLatestRun: RunRecord | null | undefined,
  runStore?: RunTranscriptStore,
  runIndex?: BuiltWebProjectionSourceIndex["runs"],
): Promise<RunRecord | null> {
  if (!live) return issueWideLatestRun ?? null;
  const activeRunId = live.liveness.activeRunId ?? live.runId;
  if (activeRunId && runIndex) {
    const activeRun = runIndex.runById.get(activeRunId) ?? null;
    if (runMatchesLiveRow(live, activeRun)) return activeRun;
  }
  if (activeRunId && runStore) {
    const activeRun = await runStore.getRun(activeRunId);
    if (runMatchesLiveRow(live, activeRun)) return activeRun;
  }
  return runMatchesLiveRow(live, issueWideLatestRun ?? null) ? (issueWideLatestRun ?? null) : null;
}

function preferredDurableIssueProjectContext(input: {
  workspace: WorkspaceRecord | null | undefined;
  latestRun: RunRecord | null | undefined;
  lifecycle: IssueLifecycleRecord | null | undefined;
}): ProjectContextResolution | null {
  const candidates = [input.workspace?.projectContext ?? null, input.latestRun?.projectContext ?? null, input.lifecycle?.projectContext ?? null];
  let legacyFallback: ProjectContextResolution | null = null;
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate.projectContextId !== LEGACY_DEFAULT_PROJECT_CONTEXT_ID) return candidate;
    if (!legacyFallback) legacyFallback = candidate;
  }
  return legacyFallback;
}

function durableIssueStatusView(input: {
  requestKey: string;
  latestRun: RunRecord | null | undefined;
  lifecycle: IssueLifecycleRecord | null | undefined;
  workspace: WorkspaceRecord | null | undefined;
}): IssueStatusView {
  const projectContext = preferredDurableIssueProjectContext(input);
  return {
    id: input.lifecycle?.issueId ?? input.latestRun?.issueId ?? input.workspace?.issueId ?? null,
    identifier: input.lifecycle?.issueIdentifier ?? input.latestRun?.issueIdentifier ?? input.workspace?.issueIdentifier ?? null,
    title: null,
    description: null,
    priority: null,
    state: null,
    branchName:
      input.lifecycle?.summaryPointers.branchName ?? input.latestRun?.gitBranchName ?? input.workspace?.gitBranchName ?? null,
    url: null,
    assigneeId: null,
    delegateId: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    ...(projectContext
      ? {
          projectContext: { ...projectContext },
          projectContextId: projectContext.projectContextId,
          projectContextLabel: projectContext.projectContextLabel,
          linearProjectSlug: projectContext.linearProjectSlug,
          routingSource: projectContext.routingSource,
        }
      : {}),
  };
}

function buildIssueTrackerMetadata(
  issue: IssueStatusView | null,
  generatedAt: string | null,
  stateLists: TrackerStateLists,
  staleThresholdMs: number,
): IssueTrackerMetadata {
  const updatedAt = issue?.updatedAt ?? null;
  const generatedMs = generatedAt === null ? Number.NaN : Date.parse(generatedAt);
  const updatedMs = updatedAt === null ? Number.NaN : Date.parse(updatedAt);
  const ageMs = Number.isFinite(generatedMs) && Number.isFinite(updatedMs) ? Math.max(generatedMs - updatedMs, 0) : null;
  return {
    generatedAt,
    updatedAt,
    ageMs,
    stale: ageMs === null ? null : ageMs > staleThresholdMs,
    staleThresholdMs,
    state: issue?.state ?? null,
    classification: classifyIssueState(issue?.state ?? null, stateLists),
  };
}

function classifyIssueState(state: string | null, stateLists: TrackerStateLists): IssueStateClassification | null {
  if (state === null) return null;
  if (isStateNameIn(state, stateLists.terminalStates)) return "terminal";
  if (isStateNameIn(state, stateLists.blockedStates)) return "blocked";
  if (isStateNameIn(state, [...stateLists.handoffStates, ...stateLists.reviewStates])) return "handoff";
  if (isStateNameIn(state, stateLists.activeStates)) return "active";
  return "unknown";
}

function buildIssueBlockerSummary(
  blockedBy: IssueBlockerRef[] | null,
  stateLists: TrackerStateLists,
  lifecycle: IssueLifecycleRecord | null | undefined,
  issueState: string | null,
) {
  const open = (blockedBy ?? []).filter((blocker) => blocker.state === null || !isStateNameIn(blocker.state, stateLists.terminalStates));
  const lifecycleBlocked = isLifecycleBlocked(lifecycle);
  const mergeGateBlocked = lifecycle?.mergeGate?.status === "repair_dispatched" || lifecycle?.mergeGate?.status === "blocked";
  const stateBlocked = issueState !== null && isStateNameIn(issueState, stateLists.blockedStates);
  const dispatchBlocked =
    issueState !== null &&
    open.length > 0 &&
    (issueState.toLowerCase() === "todo" || isStateNameIn(issueState, stateLists.reviewStates));
  return {
    available: blockedBy !== null,
    totalCount: blockedBy?.length ?? 0,
    openCount: open.length,
    open,
    blocked: lifecycleBlocked || mergeGateBlocked || stateBlocked || dispatchBlocked,
    humanBlockedReason: lifecycleBlocked ? lifecycleBlockedReason(lifecycle) : null,
  };
}

function buildIssueWorkspaceSummary(
  input: {
    live: RunningRow | null;
    workspace: WorkspaceRecord | null | undefined;
    latestRun: RunRecord | null | undefined;
    lifecycle: IssueLifecycleRecord | null | undefined;
  },
  metadata: ReturnType<typeof statusMetadata>,
): IssueWorkspaceSummary {
  const latestWorkspaceRun = input.latestRun?.runPhase === "issue_breakdown" ? null : input.latestRun;
  const workspaceRecord =
    input.workspace?.workspaceKey.endsWith("-planning") === true && input.live?.runPhase !== "issue_breakdown"
      ? null
      : input.workspace;
  return {
    workspaceKey: workspaceRecord?.workspaceKey ?? latestWorkspaceRun?.workspaceKey ?? input.lifecycle?.summaryPointers.workspaceKey ?? null,
    path: workspaceRecord?.path ?? input.live?.workspacePath ?? latestWorkspaceRun?.workspacePath ?? input.lifecycle?.summaryPointers.workspacePath ?? null,
    sourceKind: workspaceRecord?.sourceKind ?? null,
    branchName: metadata.branchName,
    gitBranchName: metadata.gitBranchName,
    repoPath: metadata.repoPath,
    baseRef: metadata.baseRef,
  };
}

function buildIssuePullRequestSummary(metadata: ReturnType<typeof statusMetadata>): IssuePullRequestSummary {
  return {
    url: metadata.prUrl ?? null,
    number: metadata.prNumber ?? null,
    headSha: metadata.prHeadSha ?? null,
    branch: metadata.prBranch ?? null,
    ciStatus: metadata.ciStatus ?? null,
    lastPushedAt: metadata.lastPushedAt ?? null,
  };
}

function mergeGateStatus(
  lifecycle: IssueLifecycleRecord | null | undefined,
  fallbackPullRequest: IssuePullRequestSummary,
): IssueMergeGateSummary | null {
  const inactiveLifecycle = sanitizeInactiveMergeGateLifecycle(lifecycle);
  const sanitizedLifecycle = sanitizeStaleMergeGateLifecycle(
    inactiveLifecycle,
    fallbackPullRequest.headSha,
    fallbackPullRequest.number,
  );
  const gate = sanitizedLifecycle?.mergeGate ?? null;
  if (!gate) return null;
  const pullRequest: IssuePullRequestSummary = {
    url: gate.pullRequest.url ?? fallbackPullRequest.url,
    number: gate.pullRequest.number ?? fallbackPullRequest.number,
    headSha: gate.headSha,
    branch: gate.pullRequest.branch ?? fallbackPullRequest.branch,
    ciStatus: fallbackPullRequest.ciStatus,
    lastPushedAt: fallbackPullRequest.lastPushedAt,
  };
  const actionableCheckNames = gate.checks
    .filter((check) => check.outcome === "failing" || check.outcome === "missing_actionable")
    .map((check) => check.name);
  const observingCheckNames = gate.checks
    .filter((check) => check.outcome === "pending" || check.outcome === "missing_observed" || check.outcome === "unknown")
    .map((check) => check.name);
  return {
    active: gate.status !== "resolved" && gate.status !== "superseded",
    id: gate.id,
    status: gate.status,
    headSha: gate.headSha,
    pullRequest,
    repairRound: gate.reviewRound,
    gateRunId: gate.gateRunId,
    gateReportId: gate.gateReportId,
    repairRunId: gate.repairRunId,
    repairReportId: gate.repairReportId,
    checks: gate.checks.map((check) => ({ ...check })),
    mergeability: mergeGateMergeabilityStatus(gate.mergeability ?? null, fallbackPullRequest),
    actionableCheckNames,
    observingCheckNames,
    blockerFingerprint: gate.blockerFingerprint,
    supersededByHeadSha: gate.supersededByHeadSha,
    awaitingCi: gate.status === "observing",
    automationBlocked: gate.status === "repair_dispatched" || gate.status === "blocked",
    updatedAt: gate.updatedAt,
  };
}

function mergeGateMergeabilityStatus(
  mergeability: IssueMergeGateMergeabilityState | null,
  fallbackPullRequest: IssuePullRequestSummary,
): IssueMergeGateSummary["mergeability"] {
  if (mergeability === null) return null;
  return {
    status: mergeability.status,
    pullRequest: {
      url: mergeability.pullRequest.url ?? fallbackPullRequest.url,
      number: mergeability.pullRequest.number ?? fallbackPullRequest.number,
      headSha: mergeability.pullRequest.headSha ?? fallbackPullRequest.headSha,
      branch: mergeability.pullRequest.branch ?? fallbackPullRequest.branch,
      ciStatus: fallbackPullRequest.ciStatus,
      lastPushedAt: fallbackPullRequest.lastPushedAt,
    },
    mergeable: mergeability.mergeable,
    mergeableState: mergeability.mergeableState,
    reason: mergeability.reason,
    baseBranch: mergeability.baseBranch,
    baseHeadSha: mergeability.baseHeadSha,
    checkedAt: mergeability.checkedAt,
  };
}

function buildIssueLatestRunSummary(run: RunRecord | null | undefined): IssueLatestRunSummary {
  const runPhase = run?.runPhase ?? null;
  return {
    runId: run?.runId ?? null,
    runPhase,
    runKind: runPhase === null ? null : runKindForPhase(runPhase),
    status: run?.status ?? null,
    terminalReason: deriveRunTerminalReason(run ?? null),
    error: publicDiagnosticText(run?.error),
    completedAt: run?.completedAt ?? null,
  };
}

function deriveRunTerminalReason(run: RunRecord | null): RunTerminalReason | null {
  if (!run || run.status === "running") return null;
  if (run.status === "succeeded") return "succeeded";
  if (run.status === "cancelled") return run.cancellationSource === "stalled" ? "stalled" : "cancelled";
  if (run.status === "failed") return "failed";
  return null;
}

function defaultTrackerStateLists(): TrackerStateLists {
  return { activeStates: [], handoffStates: [], reviewStates: [], blockedStates: [], terminalStates: [] };
}

function isStateNameIn(state: string, states: readonly string[]): boolean {
  return states.some((candidate) => candidate.toLowerCase() === state.toLowerCase());
}

interface IssueLookupCandidate {
  issueId: string;
  issueIdentifier: string;
  projectContextId: string | null;
}

interface IssueLookupResult {
  issueId: string | null;
  ambiguousCandidates: IssueLookupCandidate[];
  resolutionKind: "exact_issue_id" | "issue_identifier" | "contextual_alias" | "unresolved";
  refreshTrackerCache?: boolean;
}

async function resolveIssueLookupKey(
  issueKey: string,
  input: {
    snapshot: RuntimeSnapshot;
    lifecycleStore: IssueLifecycleStore | undefined;
    runStore: RunTranscriptStore | undefined;
    trackerIssues?: readonly Issue[];
  },
): Promise<IssueLookupResult> {
  const [lifecycleRecords, workspaces, runs] = await Promise.all([
    input.lifecycleStore?.list() ?? Promise.resolve([]),
    input.runStore?.listWorkspaces() ?? Promise.resolve([]),
    input.runStore?.listRuns() ?? Promise.resolve([]),
  ]);
  return resolveIssueLookupFromCandidates(
    issueKey,
    dedupeIssueLookupCandidates(
      [
        ...(input.trackerIssues ?? []).map(issueLookupCandidateFromIssue),
        ...input.snapshot.running.map(issueLookupCandidateFromRunningRow),
        ...lifecycleRecords.map(issueLookupCandidateFromLifecycle),
        ...workspaces.map(issueLookupCandidateFromWorkspace),
        ...runs.map(issueLookupCandidateFromRun),
      ].filter((candidate): candidate is IssueLookupCandidate => candidate !== null),
    ),
  );
}

function resolveIssueLookupFromCandidates(
  issueKey: string,
  candidates: readonly IssueLookupCandidate[],
): IssueLookupResult {
  const exactIssueIdMatch = candidates.find((candidate) => candidate.issueId === issueKey);
  if (exactIssueIdMatch) {
    return { issueId: exactIssueIdMatch.issueId, ambiguousCandidates: [], resolutionKind: "exact_issue_id" };
  }
  const identifierMatches = candidates.filter((candidate) => candidate.issueIdentifier === issueKey);
  if (identifierMatches.length === 1) {
    return { issueId: identifierMatches[0]?.issueId ?? null, ambiguousCandidates: [], resolutionKind: "issue_identifier" };
  }
  return {
    issueId: null,
    ambiguousCandidates: identifierMatches.length > 1 ? identifierMatches : [],
    resolutionKind: "unresolved",
  };
}

function ambiguousIssueLookupError(issueKey: string, candidates: readonly IssueLookupCandidate[]): SymphonyError {
  const details = candidates.map((candidate) => {
    const context = candidate.projectContextId ? ` [${candidate.projectContextId}]` : "";
    return `${candidate.issueId}${context}`;
  });
  return new SymphonyError(
    "conflict",
    `Ambiguous issue identifier: ${issueKey}. Use exact issue id. Candidates: ${details.join(", ")}`,
  );
}

function issueLookupCandidateFromRunningRow(row: RunningRow): IssueLookupCandidate | null {
  return issueLookupCandidate({
    issueId: row.issueId,
    issueIdentifier: row.issueIdentifier,
    projectContext: projectContextResolutionFromIssue(row) ?? undefined,
  });
}

function issueLookupCandidateFromIssue(issue: Issue): IssueLookupCandidate | null {
  return issueLookupCandidate({
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    projectContext: projectContextResolutionFromIssue(issue) ?? undefined,
  });
}

function issueLookupCandidateFromLifecycle(record: IssueLifecycleRecord): IssueLookupCandidate | null {
  return issueLookupCandidate({
    issueId: record.issueId,
    issueIdentifier: record.issueIdentifier,
    projectContext: record.projectContext,
  });
}

function issueLookupCandidateFromWorkspace(record: WorkspaceRecord): IssueLookupCandidate | null {
  return issueLookupCandidate({
    issueId: record.issueId ?? null,
    issueIdentifier: record.issueIdentifier,
    projectContext: record.projectContext,
  });
}

function issueLookupCandidateFromRun(record: RunRecord): IssueLookupCandidate | null {
  return issueLookupCandidate({
    issueId: record.issueId,
    issueIdentifier: record.issueIdentifier,
    projectContext: record.projectContext,
  });
}

function issueLookupCandidateFromAliasCandidate(candidate: IssueAliasCandidate): IssueLookupCandidate | null {
  switch (candidate.kind) {
    case "tracker":
      return issueLookupCandidateFromIssue(candidate.record);
    case "live":
      return issueLookupCandidateFromRunningRow(candidate.record);
    case "workspace":
      return issueLookupCandidateFromWorkspace(candidate.record);
    case "run":
      return issueLookupCandidateFromRun(candidate.record);
    case "lifecycle":
      return issueLookupCandidateFromLifecycle(candidate.record);
  }
}

function issueLookupCandidate(input: {
  issueId: string | null;
  issueIdentifier: string | null;
  projectContext?: IssueLifecycleRecord["projectContext"] | WorkspaceRecord["projectContext"] | RunRecord["projectContext"];
}): IssueLookupCandidate | null {
  if (!input.issueId || !input.issueIdentifier) {
    return null;
  }
  return {
    issueId: input.issueId,
    issueIdentifier: input.issueIdentifier,
    projectContextId: input.projectContext?.projectContextId ?? null,
  };
}

function dedupeIssueLookupCandidates(candidates: readonly IssueLookupCandidate[]): IssueLookupCandidate[] {
  const byIssueId = new Map<string, IssueLookupCandidate>();
  for (const candidate of candidates) {
    const existing = byIssueId.get(candidate.issueId);
    if (!existing) {
      byIssueId.set(candidate.issueId, candidate);
      continue;
    }
    if (existing.projectContextId === null && candidate.projectContextId !== null) {
      byIssueId.set(candidate.issueId, candidate);
    }
  }
  return [...byIssueId.values()].sort((left, right) => compareString(left.issueId, right.issueId));
}

function issueKeys(
  requestKey: string,
  input: {
    live: RunningRow | null;
    latestRun: RunRecord | null | undefined;
    lifecycle: IssueLifecycleRecord | null | undefined;
  },
): string[] {
  return [
    requestKey,
    input.live?.issueId,
    input.live?.issueIdentifier,
    input.latestRun?.issueId,
    input.latestRun?.issueIdentifier,
    input.lifecycle?.issueId,
    input.lifecycle?.issueIdentifier,
  ].filter((value, index, values): value is string => value !== null && value !== undefined && values.indexOf(value) === index);
}

function isIssuePaused(snapshot: RuntimeSnapshot, keys: string[]): boolean {
  return keys.some((key) => snapshot.paused.includes(key));
}

function operatorControls(input: {
  issueKnown: boolean;
  live: RunningRow | null;
  paused: boolean;
  mutationsConfigured: boolean;
}): OperatorControls {
  return {
    pause: input.issueKnown && !input.paused,
    resume: input.paused,
    cancel: input.live !== null && !input.live.cancellation.requested,
    mutationsRequireToken: input.mutationsConfigured,
  };
}

function operatorAffordances(input: {
  issueKey: string;
  lifecycle: IssueLifecycleRecord | null | undefined;
  continuationSummaryAvailable: boolean;
  mutationsRequireToken: boolean;
}): OperatorAffordances {
  const blocked = isLifecycleBlocked(input.lifecycle);
  return {
    humanRequired: {
      active: blocked,
      reason: lifecycleBlockedReason(input.lifecycle),
      continuationSummaryRecommended: blocked,
    },
    continuationSummary: {
      available: input.continuationSummaryAvailable,
      method: "POST",
      path: `/api/v1/issues/${encodeURIComponent(input.issueKey)}/continuation-summary`,
      requiresToken: input.mutationsRequireToken,
    },
  };
}

function cancellationSummary(row: RunningRow): string | null {
  if (!row.cancellation.requested) return null;
  return [
    "Cancellation requested",
    row.cancellation.source ? `source=${row.cancellation.source}` : null,
    row.cancellation.reason,
    row.cancellation.requestedAt ? `at ${row.cancellation.requestedAt}` : null,
    row.cancellation.abortSignalled ? "abort signalled" : null,
    row.cancellation.harnessStopRequestedAt ? `harness stop requested ${row.cancellation.harnessStopRequestedAt}` : null,
  ]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(" · ");
}

function cancelFailedSummary(cancelFailed: ReturnType<typeof liveCancelFailed>): string | null {
  if (!cancelFailed.active) return null;
  return [
    "cancel_failed",
    `phase=${cancelFailed.phase}`,
    cancelFailed.source ? `source=${cancelFailed.source}` : null,
    cancelFailed.at ? `at=${cancelFailed.at}` : null,
    cancelFailed.reason ? `reason=${cancelFailed.reason}` : null,
  ]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(" · ");
}

function activitySummary(row: RunningRow): string | null {
  if (!row.activity) return null;
  const parts = [
    row.activity.lastStreamActivityAt ? `stream ${row.activity.lastStreamActivityAt}` : null,
    row.activity.lastDeltaOrToolActivityAt ? `delta/tool ${row.activity.lastDeltaOrToolActivityAt}` : null,
    row.activity.lastToolActivityAt ? `tool ${row.activity.lastToolActivityAt}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : `activity sources: ${parts.join(" · ")}`;
}

function formatControls(controls: OperatorControls): string {
  const enabled = [
    controls.pause ? "pause" : null,
    controls.resume ? "resume" : null,
    controls.cancel ? "cancel" : null,
  ].filter((item): item is string => item !== null);
  const token = controls.mutationsRequireToken ? "requires X-Symphony-Token" : "no configured token";
  return `${enabled.length === 0 ? "status only" : enabled.join(", ")} (${token})`;
}

function formatAffordances(affordances: OperatorAffordances): string {
  if (!affordances.humanRequired.active) return "";
  const parts = [
    "human-required",
    affordances.humanRequired.reason,
    affordances.continuationSummary.available
      ? `continuation-summary ${affordances.continuationSummary.method} ${affordances.continuationSummary.path}`
      : "continuation-summary unavailable",
  ].filter((part): part is string => part !== null && part.length > 0);
  return `<div class="blocked">${escapeHtml(parts.join(" · "))}</div>`;
}

function parsePagination(url: URL): { offset: number; limit: number } {
  const offset = Number(url.searchParams.get("offset") ?? "0");
  const limit = Number(url.searchParams.get("limit") ?? "100");
  return {
    offset: Number.isFinite(offset) ? Math.max(Math.floor(offset), 0) : 0,
    limit: Number.isFinite(limit) ? Math.max(Math.floor(limit), 1) : 100,
  };
}

function parseActivityQuery(url: URL): ActivityQuery {
  const offset = Number(url.searchParams.get("offset") ?? "0");
  const limit = Number(url.searchParams.get("limit") ?? "50");
  const issue = url.searchParams.get("issue");
  const rawProjectContextId = url.searchParams.get("projectContextId")?.trim() ?? "";
  let projectContextId: string | null = null;
  if (rawProjectContextId.length > 0) {
    try {
      projectContextId = normalizeProjectContextId(rawProjectContextId);
    } catch {
      throw new SymphonyError("invalid_request", `Invalid project context filter: ${rawProjectContextId}`);
    }
  }
  return {
    issue: issue && issue.length > 0 ? issue : null,
    projectContextId,
    offset: Number.isFinite(offset) ? Math.max(Math.floor(offset), 0) : 0,
    limit: Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), 100) : 50,
  };
}

function compareIsoDesc(left: string, right: string): number {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (!Number.isNaN(leftMs) && !Number.isNaN(rightMs) && leftMs !== rightMs) return rightMs - leftMs;
  return compareString(right, left);
}

function compareNumber(left: number, right: number): number {
  return left - right;
}

function compareString(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function statusMetadata(input: {
  live: ReturnType<Orchestrator["getIssueDetails"]>;
  workspace: WorkspaceRecord | null | undefined;
  latestRun: RunRecord | null | undefined;
  lifecycle: IssueLifecycleRecord | null | undefined;
}) {
  const pointers = input.lifecycle?.summaryPointers;
  return {
    prUrl: metadataValue(input.latestRun, "prUrl", pointers?.prUrl ?? null),
    prNumber: metadataValue(input.latestRun, "prNumber", pointers?.prNumber ?? null),
    prHeadSha: metadataValue(input.latestRun, "prHeadSha", pointers?.prHeadSha ?? null),
    prBranch: metadataValue(input.latestRun, "prBranch", pointers?.prBranch ?? null),
    ciStatus: metadataValue(input.latestRun, "ciStatus", pointers?.ciStatus ?? null),
    lastPushedAt: metadataValue(input.latestRun, "lastPushedAt", pointers?.lastPushedAt ?? null),
    lastEvidenceCursor: metadataValue(input.latestRun, "lastEvidenceCursor", pointers?.lastEvidenceCursor ?? null),
    branchName:
      input.live?.metadata?.branchName ??
      pointers?.branchName ??
      input.latestRun?.gitBranchName ??
      input.workspace?.gitBranchName ??
      null,
    gitBranchName:
      input.live?.metadata?.gitBranchName ??
      pointers?.gitBranchName ??
      input.latestRun?.gitBranchName ??
      input.workspace?.gitBranchName ??
      null,
    repoPath: input.live?.metadata?.repoPath ?? pointers?.repoPath ?? input.latestRun?.repoPath ?? input.workspace?.repoPath ?? null,
    baseRef: input.live?.metadata?.baseRef ?? pointers?.baseRef ?? input.latestRun?.baseRef ?? input.workspace?.baseRef ?? null,
    merge: input.lifecycle?.merge ?? null,
    mergeConflict: input.lifecycle?.mergeConflict ?? null,
  };
}

function sanitizeStatusLifecycle(input: {
  live: ReturnType<Orchestrator["getIssueDetails"]>;
  workspace: WorkspaceRecord | null | undefined;
  latestRun: RunRecord | null | undefined;
  lifecycle: IssueLifecycleRecord | null | undefined;
}): IssueLifecycleRecord | null | undefined {
  const inactiveLifecycle = sanitizeInactiveMergeGateLifecycle(input.lifecycle);
  const metadata = statusMetadata({ ...input, lifecycle: inactiveLifecycle });
  return sanitizeStaleMergeGateLifecycle(inactiveLifecycle, metadata.prHeadSha, metadata.prNumber);
}

function reviewLoopStatus(input: {
  live: ReturnType<Orchestrator["getIssueDetails"]>;
  latestRun: RunRecord | null | undefined;
  lifecycle: IssueLifecycleRecord | null | undefined;
}) {
  const lifecycle = input.lifecycle ?? null;
  return {
    phase: lifecycle?.phase ?? null,
    role: input.live?.role ?? input.latestRun?.role ?? null,
    runPhase: input.live?.runPhase ?? input.latestRun?.runPhase ?? null,
    runKind:
      input.live?.runKind ?? (input.latestRun?.runPhase === undefined ? null : runKindForPhase(input.latestRun.runPhase)),
    reviewRound: lifecycle?.reviewRound ?? null,
    incompleteTurnCount: lifecycle?.incompleteTurnCount ?? null,
    lastCompletionReport: latestCompletionReport(lifecycle),
    lastReviewVerdict: latestReviewVerdict(lifecycle),
    mergeConflict: lifecycle?.mergeConflict ?? null,
    blockedReason: lifecycleBlockedReason(lifecycle),
  };
}

function latestCompletionReport(lifecycle: IssueLifecycleRecord | null): IssueCompletionReportRecord | null {
  if (!lifecycle) return null;
  if (lifecycle.lastCompletionReportId) {
    const exact = lifecycle.completionReports.find((report) => report.id === lifecycle.lastCompletionReportId);
    if (exact) return exact;
  }
  return lifecycle.completionReports[lifecycle.completionReports.length - 1] ?? null;
}

function latestReviewVerdict(lifecycle: IssueLifecycleRecord | null): IssueReviewVerdictRecord | null {
  if (!lifecycle) return null;
  if (lifecycle.lastReviewVerdictId) {
    const exact = lifecycle.reviewVerdicts.find((verdict) => verdict.id === lifecycle.lastReviewVerdictId);
    if (exact && !isMergeGateVerdict(exact)) {
      if (exact.verdict !== "pass") return exact;
      const currentPass = latestCurrentApprovalPassVerdict(lifecycle);
      if (currentPass?.id === exact.id) return exact;
    }
  }
  for (const verdict of lifecycle.reviewVerdicts.slice().reverse()) {
    if (isMergeGateVerdict(verdict)) continue;
    if (verdict.verdict !== "pass") return verdict;
    const currentPass = latestCurrentApprovalPassVerdict(lifecycle);
    if (currentPass?.id === verdict.id) return verdict;
  }
  return null;
}

function isMergeGateVerdict(verdict: IssueReviewVerdictRecord): boolean {
  return verdict.reviewer === "symphony-merge-gate" || verdict.id.startsWith("merge-gate:");
}

function metadataValue<K extends "prUrl" | "prNumber" | "prHeadSha" | "prBranch" | "ciStatus" | "lastPushedAt" | "lastEvidenceCursor">(
  run: RunRecord | null | undefined,
  key: K,
  fallback: NonNullable<RunRecord[K]> | null,
): RunRecord[K] | null {
  if (run && Object.prototype.hasOwnProperty.call(run, key)) return run[key] ?? null;
  return fallback;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

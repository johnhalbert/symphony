import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs, type Stats } from "node:fs";
import type { Orchestrator } from "../core/orchestrator/Orchestrator.js";
import type { WorkspaceManager } from "../core/workspace/WorkspaceManager.js";
import type { WorkspaceOpener } from "./WorkspaceOpener.js";
import { SymphonyError, errorMessage } from "../core/errors.js";
import {
  projectActivityModels,
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
} from "../core/writeback/WritebackOutbox.js";
import type { TrackerClient } from "../core/tracker/TrackerClient.js";
import { sanitizedPreviewValue, sanitizePublicJson } from "../core/transcript/TranscriptProjection.js";
import {
  DEFAULT_ORCHESTRATOR_CONVERSATION_ID,
  type OrchestratorConversationMessage,
  type OrchestratorConversationStatus,
  type OrchestratorConversationStore,
} from "../core/persistence/OrchestratorConversationStore.js";
import {
  ORCHESTRATOR_CHAT_POST_ACTION,
  type OrchestratorChatCommandDispatcher,
  type OrchestratorChatCommandResult,
  type OrchestratorChatCommandResultStatus,
} from "../core/orchestrator/OrchestratorChatCommand.js";

import { projectWebHistory } from "./WebHistoryProjection.js";
import { projectWebTranscript } from "./WebTranscriptProjection.js";
import {
  buildWebProjectionSourceIndex,
  createWebProjectionCacheMetadata,
  createWebProjectionFingerprint,
  defaultWebProjectionIssueBoardColumns,
  isWebProjectionContextExpired,
  isWebProjectionRefreshRequested,
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
import { RealtimeProjectionEventBus } from "./RealtimeProjectionEvents.js";
import {
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
  type ProjectionPayloadRecord,
  type ProjectionPayloadWriteInput,
  type ProjectionSourceRevision,
  type ProjectionWriteResult,
} from "../core/persistence/ProjectionTransactionService.js";
import type { ProjectionSourceFreshnessInput } from "../core/persistence/ProjectionSourceFreshness.js";
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
  onProjectionChanged(listener: (event: { source: string; revision: number }) => void): () => void;
}

export interface StatusServerProjectionWriter {
  writeProjection(input: ProjectionPayloadWriteInput): Promise<ProjectionWriteResult>;
}

export interface StatusServerProjectionReader extends WebProjectionPayloadReader {}

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

type DurableProjectionReadResult<TPayload> = WebProjectionReadResult<TPayload>;

export interface StatusServerRealtimeOptions {
  enabled?: boolean;
  keepAliveIntervalMs?: number;
}

export interface StatusServerOptions {
  orchestrator: Orchestrator;
  workspaceManager: WorkspaceManager;
  workspaceOpener: WorkspaceOpener;
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
    });
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
    for (const provider of this.webProjectionRevisionProviders) {
      if (!provider.subscribe) continue;
      const unsubscribe = provider.subscribe((revision) => {
        this.markCompletedWebProjectionContextDirty(revision);
        this.realtimeEvents.publishProjectionRevision(revision);
      });
      this.webProjectionRevisionUnsubscribes.push(unsubscribe);
    }
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
    this.webProjectionDirtyGeneration += 1;
    this.completedWebProjectionContext = null;
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
        if (this.hasDurableProjectionReader()) {
          sendJson(response, 200, projectWebReferenceData(null), durableProjectionReadHeaders(durableIssues));
          return;
        }
        let board: IssueBoardResponse | null = null;
        try {
          board = await this.fetchIssueBoard(forceRefresh);
        } catch (error) {
          if (
            !(error instanceof SymphonyError) ||
            (error.code !== "tracker_error" && error.code !== "tracker_unavailable")
          ) {
            throw error;
          }
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
        if (this.hasDurableProjectionReader()) {
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
        if (sessionIdOrRunId.length === 0) {
          sendJson(response, 200, []);
          return;
        }
        const forceRefresh = isWebProjectionRefreshRequested(url.searchParams.get("refresh"));
        if (!this.options.runStore) {
          const requestedPage = parseWebTranscriptPagination(url);
          const durableTranscript = requestedPage
            ? await this.webProjectionRepositories.transcript.readRunPage(
                { runId: sessionIdOrRunId, offset: requestedPage.offset, limit: requestedPage.limit },
                { forceRefresh },
              )
            : await this.webProjectionRepositories.transcript.readRunDefaultPage(
                { runId: sessionIdOrRunId, limit: WEB_TRANSCRIPT_DEFAULT_EVENT_LIMIT },
                { forceRefresh },
              );
          if (durableTranscript.status === "hit" && durableTranscript.record) {
            sendJson(response, 200, durableTranscript.record.payload, durableProjectionReadHeaders(durableTranscript));
            return;
          }
          sendJson(response, 200, [], durableProjectionReadHeaders(durableTranscript));
          return;
        }
        const run = await resolveWebTranscriptRun(this.options.runStore, sessionIdOrRunId);
        if (!run) {
          sendJson(response, 200, []);
          return;
        }
        const durableTranscript = await this.webProjectionRepositories.transcript.readRunPage(
          transcriptProjectionPageSelectorForRequest(run, url),
          { forceRefresh },
        );
        if (durableTranscript.status === "hit" && durableTranscript.record) {
          sendJson(response, 200, durableTranscript.record.payload, durableProjectionReadHeaders(durableTranscript));
          return;
        }
        const transcriptPage = await readBoundedWebTranscriptPage(this.options.runStore, run.runId, url);
        const transcript = projectWebTranscript(transcriptPage.events, { run });
        await this.persistWebTranscriptProjection(run, transcriptPage, transcript);
        sendJson(response, 200, transcript, durableProjectionReadHeaders(durableTranscript));
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
            sendJson(response, 200, durableChat.record.payload, durableProjectionReadHeaders(durableChat));
            return;
          }
          const chat = projectWebOrchestratorChat(await this.fetchWebOrchestratorChatMessages(conversationId));
          await this.persistWebOrchestratorChatProjection(chat, conversationId);
          sendJson(response, 200, chat, durableProjectionReadHeaders(durableChat));
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
          const chat = webOrchestratorChatProjectionFromResponseBody(result.body);
          if (chat) {
            await this.persistWebOrchestratorChatProjection(chat, postConversationId);
            if (chat.length > 0 && result.status !== 200) {
              this.realtimeEvents.publishOrchestratorMessage({
                inputLength: input.input.length,
                messageCount: chat.length,
                conversationId: postConversationId ?? DEFAULT_ORCHESTRATOR_CONVERSATION_ID,
                status: result.status,
              });
            }
          }
          sendJson(response, result.status, result.body);
          return;
        }
      }
      if (request.method === "GET" && url.pathname === "/api/v1/workspaces") {
        sendJson(response, 200, {
          workspaces: (await this.options.runStore?.listWorkspaces()) ?? [],
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
        const requestId = decodeURIComponent(approvalMatch[1] ?? "");
        if (request.method === "GET") {
          const approval = await this.options.operatorApproval?.get(requestId);
          if (!approval) throw new SymphonyError("not_found", `Approval request not found: ${requestId}`);
          sendJson(response, 200, approvalResponse(approval, this.options.operatorApproval?.isRequired() ?? false));
          return;
        }
        if (request.method === "POST") {
          this.requireApprovalMutationToken(request);
          const decision = parseApprovalDecision(await readJsonBody(request));
          let existingApproval: OperatorApprovalRecord | null = null;
          try {
            existingApproval = (await this.options.operatorApproval?.get(requestId)) ?? null;
          } catch {
            existingApproval = null;
          }
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
          let result;
          try {
            result = await this.options.operatorApproval?.resolve(requestId, decision);
          } catch (error) {
            await this.recordPublicationApprovalTerminalConflict(requestId, error);
            throw error;
          }
          if (!result) throw new SymphonyError("not_found", `Approval request not found: ${requestId}`);
          if (decision === "reject") {
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
        this.options.orchestrator.pauseIssue(issueId);
        sendJson(response, 202, { paused: true, issue: issueId });
        return;
      }

      const resumeMatch = /^\/api\/v1\/issues\/([^/]+)\/resume$/.exec(url.pathname);
      if (request.method === "POST" && resumeMatch) {
        this.requireMutationToken(request);
        const issueId = decodeURIComponent(resumeMatch[1] ?? "");
        this.options.orchestrator.resumeIssue(issueId);
        sendJson(response, 202, { paused: false, issue: issueId });
        return;
      }

      const cancelMatch = /^\/api\/v1\/issues\/([^/]+)\/cancel$/.exec(url.pathname);
      if (request.method === "POST" && cancelMatch) {
        this.requireMutationToken(request);
        const issueId = decodeURIComponent(cancelMatch[1] ?? "");
        await this.options.orchestrator.cancelIssue(issueId);
        sendJson(response, 202, { cancelled: true, issue: issueId });
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
        const issueId = decodeURIComponent(issueRunsMatch[1] ?? "");
        const snapshot = this.options.orchestrator.snapshot();
        const live = this.options.orchestrator.getIssueDetails(issueId);
        const workspace = await this.options.runStore?.findWorkspace(issueId);
        const latestRun = await this.options.runStore?.latestRunForIssue(issueId);
        const summaryRun = await resolveIssueDetailsSummaryRun(live, latestRun, this.options.runStore);
        const runs = (await this.options.runStore?.listRunsForIssue(issueId)) ?? [];
        const lifecycle = sanitizeStatusLifecycle({
          live,
          workspace,
          latestRun,
          lifecycle: await this.options.lifecycleStore?.get(issueId),
        });
        const enrichedRuns = await Promise.all(
          runs.map(async (run) => ({
            ...publicRunRecord(run),
            operatorLiveness: await runOperatorLiveness(run, snapshot, lifecycle, runs, this.options.runStore),
            livenessSummary: runLivenessSummary(run, snapshot, lifecycle, runs),
          })),
        );
        sendJson(response, 200, {
          issue: issueId,
          issueDetails: buildIssueDetailsEnvelope({
            requestKey: issueId,
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
        const issueId = decodeURIComponent(continuationSummaryMatch[1] ?? "");
        const result = await this.options.orchestrator.createContinuationSummary(issueId);
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
        const issueId = decodeURIComponent(issueBreakdownMatch[1] ?? "");
        const result = await this.options.orchestrator.requestIssueBreakdown(issueId);
        sendJson(response, result.queued ? 202 : 200, {
          queued: result.queued,
          issue: result.issue.identifier,
          issueId: result.issue.id,
          runPhase: "issue_breakdown",
          runKind: "planning",
          reason: result.reason,
        });
        return;
      }

      const issueBreakdownApplyMatch = /^\/api\/v1\/issues\/([^/]+)\/planning-run\/apply$/.exec(url.pathname);
      if (request.method === "POST" && issueBreakdownApplyMatch) {
        this.requireIssueBreakdownApplyToken(request);
        const issueId = decodeURIComponent(issueBreakdownApplyMatch[1] ?? "");
        const options = parseIssueBreakdownApplyRequest(await readJsonBody(request));
        const result = await this.options.orchestrator.applyIssueBreakdownPlan(issueId, options);
        sendJson(response, result.status === "pending" ? 202 : 200, {
          issue: issueId,
          mode: options.dryRun ? "preview" : "apply",
          ...result,
        });
        return;
      }

      const issueMatch = /^\/api\/v1\/issues\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && issueMatch) {
        const issueId = decodeURIComponent(issueMatch[1] ?? "");
        const snapshot = this.options.orchestrator.snapshot();
        const live = this.options.orchestrator.getIssueDetails(issueId);
        const workspace = await this.options.runStore?.findWorkspace(issueId);
        const latestRun = await this.options.runStore?.latestRunForIssue(issueId);
        const summaryRun = await resolveIssueDetailsSummaryRun(live, latestRun, this.options.runStore);
        const lifecycle = sanitizeStatusLifecycle({
          live,
          workspace,
          latestRun,
          lifecycle: await this.options.lifecycleStore?.get(issueId),
        });
        if (!live && !workspace && !latestRun && !lifecycle) throw new SymphonyError("not_found", `Issue not found: ${issueId}`);
        const workspacePath = live?.workspacePath ?? workspace?.path ?? null;
        const keys = issueKeys(issueId, { live, latestRun, lifecycle });
        const paused = isIssuePaused(snapshot, keys);
        const resolvedAgentId = live ? await resolveRunningAgentId(live, this.options.runStore) : null;
        const pendingApprovalCandidate = await this.options.operatorApproval?.findPendingForIssue(keys);
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
          issueKey: issueId,
          lifecycle,
          continuationSummaryAvailable: Boolean(this.options.lifecycleStore && this.options.runStore),
          mutationsRequireToken: controls.mutationsRequireToken,
        });
        sendJson(response, 200, {
          issue: issueId,
          issueDetails: buildIssueDetailsEnvelope({
            requestKey: issueId,
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
        const runId = decodeURIComponent(transcriptMatch[1] ?? "");
        const run = await this.options.runStore?.getRun(runId);
        if (!run) throw new SymphonyError("not_found", `Run not found: ${runId}`);
        sendJson(response, 200, await this.options.runStore?.readTranscript(runId, parsePagination(url)));
        return;
      }

      const runMatch = /^\/api\/v1\/runs\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && runMatch) {
        const runId = decodeURIComponent(runMatch[1] ?? "");
        const run = await this.options.runStore?.getRun(runId);
        if (!run) throw new SymphonyError("not_found", `Run not found: ${runId}`);
        const issueRunsByIdentifier = (await this.options.runStore?.listRunsForIssue(run.issueIdentifier)) ?? [];
        const issueRuns =
          issueRunsByIdentifier.length > 0 || run.issueIdentifier === run.issueId
            ? issueRunsByIdentifier
            : ((await this.options.runStore?.listRunsForIssue(run.issueId)) ?? []);
        const lifecycle =
          (await this.options.lifecycleStore?.get(run.issueId)) ?? (await this.options.lifecycleStore?.get(run.issueIdentifier)) ?? null;
        sendJson(response, 200, {
          ...publicRunRecord(run),
          pendingApproval: (await this.options.operatorApproval?.findPendingForRun(runId)) ?? null,
          telemetry: await runTelemetrySummary(run.runId, this.options.runStore),
          operatorLiveness: await runOperatorLiveness(run, this.options.orchestrator.snapshot(), lifecycle, issueRuns, this.options.runStore),
          operatorLivenessContract: OPERATOR_LIVENESS_CONTRACT,
        });
        return;
      }

      const workspaceMatch = /^\/api\/v1\/workspaces\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && workspaceMatch) {
        const workspaceKey = decodeURIComponent(workspaceMatch[1] ?? "");
        const workspace = await this.options.runStore?.findWorkspace(workspaceKey);
        if (!workspace) throw new SymphonyError("not_found", `Workspace not found: ${workspaceKey}`);
        sendJson(response, 200, workspace);
        return;
      }

      const openMatch = /^\/api\/v1\/issues\/([^/]+)\/open-workspace$/.exec(url.pathname);
      if (request.method === "POST" && openMatch) {
        this.requireMutationToken(request);
        const issueId = decodeURIComponent(openMatch[1] ?? "");
        const details = this.options.orchestrator.getIssueDetails(issueId);
        const workspace = await this.options.runStore?.findWorkspace(issueId);
        const workspacePath =
          details?.workspacePath ?? workspace?.path ?? this.options.workspaceManager.getPathForIssue(issueId);
        if (!(await pathExists(workspacePath))) {
          throw new SymphonyError("not_found", `Workspace not found: ${workspacePath}`);
        }
        await this.options.workspaceOpener.open(workspacePath);
        sendJson(response, 202, { opened: true, workspace_path: workspacePath });
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
      sendJson(response, status, {
        error: {
          code: error instanceof SymphonyError ? error.code : "internal_error",
          message: errorMessage(error),
        },
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
      const history = projectWebHistory(activitySources.runs, historyActivity.activity);
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
      const history = projectWebHistory(runs, activityFeed.activity);
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
        const chat = projectWebOrchestratorChat(await this.fetchWebOrchestratorChatMessages(conversationId));
        await this.recordProjectionRebuildEntry(
          this.webOrchestratorChatProjectionWriteInput(chat, conversationId),
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
    await this.recordProjectionRebuildEntry(this.webTranscriptProjectionWriteInput(run, page, transcript), entries);
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
    const selector = statusServerProjectionRebuildEntrySelector(input);
    const writer = this.options.projectionWriter;
    if (!writer) {
      entries.push({ ...selector, status: "skipped", revision: null, reason: "Durable projection writer is not configured" });
      return;
    }
    try {
      const result = await writer.writeProjection(input);
      entries.push({
        ...selector,
        status: result.status,
        revision: typeof result.revision.revision === "number" ? result.revision.revision : null,
        reason: null,
      });
    } catch (error) {
      entries.push({ ...selector, status: "failed", revision: null, reason: publicDiagnosticText(errorMessage(error)) });
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
    transcript: ReturnType<typeof projectWebTranscript>,
  ): ProjectionPayloadWriteInput {
    return {
      projectionName: "transcript_projection",
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
        messageCount: transcript.length,
      },
    };
  }

  private webOrchestratorChatProjectionWriteInput(
    chat: readonly ChatMessage[],
    conversationId?: string | null,
  ): ProjectionPayloadWriteInput {
    return {
      projectionName: "orchestrator_chat_projection",
      scopeKind: "conversation",
      scopeKey: orchestratorChatProjectionScopeKey(conversationId),
      payload: chat,
      sourceRevisions: statusServerOrchestratorChatProjectionSourceRevisions(
        this.options.orchestratorConversationStore,
        chat,
        conversationId,
      ),
      sourceCursors: orchestratorChatProjectionSourceCursors(chat, conversationId),
      fields: {
        conversationKey: orchestratorChatProjectionScopeKey(conversationId),
        issueKey: firstChatMetadataString(chat, "issueKey", "issueIdentifier"),
        runId: firstChatMetadataString(chat, "runId"),
        messageCount: chat.length,
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

    if (this.hasDurableProjectionReader()) {
      return webProjectionJsonResponse(null, durableRead);
    }

    try {
      const detail = await this.fetchBoardIssueDetail(issueId, forceRefresh);
      const issueActivityKey =
        detail.issueDetails.issue.identifier ??
        detail.issueDetails.issue.id ??
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

    const issueActivityKey = issue.id || issueId;
    const issueRuns = this.options.runStore
      ? (await this.options.runStore.listRuns()).filter((run) => activityRunMatchesIssue(run, issueActivityKey))
      : [];
    const detailRuns = selectLatestChronologicalRuns(issueRuns, WEB_ISSUE_DETAIL_RUN_LIMIT);
    const latestRun = detailRuns.at(-1) ?? null;
    const activity = await buildActivityFeed({
      generatedAt: record.generatedAt || record.revision.generatedAt,
      runStore: this.options.runStore,
      runs: detailRuns,
      lifecycleStore: this.options.lifecycleStore,
      writebackOutbox: this.options.writebackOutbox,
      query: { issue: issueActivityKey, offset: 0, limit: 50 },
      includeTranscriptEvents: false,
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
      return webProjectionJsonResponse(durableDashboard.record.payload, durableDashboard);
    }

    if (this.hasDurableProjectionReader()) {
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
    return (await this.options.orchestratorConversationStore?.listMessages(conversationId)) ?? [];
  }

  private async acceptWebOrchestratorChatPost(input: {
    conversationId?: string | null;
    messageId?: string;
    input: string;
  }): Promise<{ status: number; body: unknown }> {
    const store = this.options.orchestratorConversationStore;
    if (!store) {
      return webOrchestratorChatErrorResponse(
        503,
        "orchestrator_chat_unavailable",
        "Web orchestrator chat is unavailable because durable conversation storage is not configured",
        [],
      );
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
  ): Promise<{ status: number; body: unknown }> {
    let existingMessages: OrchestratorConversationMessage[] = [];
    try {
      existingMessages = input.messageId === undefined ? [] : await store.listMessages(input.conversationId);
    } catch {
      return webOrchestratorChatErrorResponse(
        500,
        "orchestrator_chat_persistence_failed",
        "Web orchestrator chat could not inspect existing messages",
        [],
      );
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
      return webOrchestratorChatErrorResponse(
        500,
        "orchestrator_chat_persistence_failed",
        "Web orchestrator chat could not persist the user message",
        [],
      );
    }

    if (!webOrchestratorChatMessageMatchesClaim(message, commandClaimId)) {
      let messages: OrchestratorConversationMessage[];
      try {
        messages = await store.listMessages(message.conversationId);
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
      return webOrchestratorChatErrorResponse(
        500,
        "orchestrator_chat_persistence_failed",
        "Web orchestrator chat could not persist the command dispatch claim",
        projectWebOrchestratorChatPost(input.input, [message]),
      );
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
  }): Promise<{ status: number; body: unknown }> {
    const message = input.message;
    if (!message) {
      return webOrchestratorChatErrorResponse(
        500,
        "orchestrator_chat_persistence_failed",
        "Web orchestrator chat could not persist the user message",
        [],
      );
    }
    let messages: OrchestratorConversationMessage[];
    try {
      await input.store.updateMessage({
        conversationId: message.conversationId,
        messageId: message.id,
        status: webOrchestratorChatMessageStatusFromCommandResult(input.result.status),
        metadata: webOrchestratorChatCommandMetadata(input.result, input.actionDispatched),
      });
      messages = await input.store.listMessages(message.conversationId);
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
        messages = await input.store.listMessages(message.conversationId);
      } catch {
        messages = [recoveryMessage];
      }
      return webOrchestratorChatErrorResponse(
        500,
        "orchestrator_chat_persistence_failed",
        "Web orchestrator chat could not persist the command state update",
        projectWebOrchestratorChatPost(input.input.input, messages),
      );
    }

    if (input.result.status === "accepted") {
      return { status: 202, body: projectWebOrchestratorChatPost(input.input.input, messages) };
    }
    return webOrchestratorChatErrorResponse(
      webOrchestratorChatHttpStatusFromCommandResult(input.result.status),
      webOrchestratorChatErrorCodeFromCommandResult(input.result.status),
      webOrchestratorChatErrorMessageFromCommandResult(input.result.status),
      projectWebOrchestratorChatPost(input.input.input, messages),
    );
  }

  private async fetchWebSidebar(forceRefresh: boolean): Promise<WebProjectionJsonResponse<ReturnType<typeof projectWebSidebar>>> {
    const durableSidebar = await this.webProjectionRepositories.sidebar.readCurrent({ forceRefresh });
    if (durableSidebar.status === "hit" && durableSidebar.record) {
      return webProjectionJsonResponse(durableSidebar.record.payload, durableSidebar);
    }

    if (this.hasDurableProjectionReader()) {
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
    const history = projectWebHistory(activitySources.runs, historyActivity.activity);
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
      return webProjectionJsonResponse(durableHistory.record.payload, durableHistory);
    }

    const projection = await this.fetchOptionalWebProjectionSourceIndex(forceRefresh);
    const sourceIndex = projection?.sourceIndex ?? null;
    const activitySources = await this.fetchWebCollectionActivitySources(
      sourceIndex,
      Math.max(limits.sessionLimit, limits.timelineLimit),
    );
    const runs = selectRecentRuns(activitySources.runs, limits.sessionLimit);
    const activityRuns = selectRecentRuns(activitySources.runs, limits.timelineLimit);
    const activityFeed = await buildActivityFeed({
      generatedAt: sourceIndex?.runtime.snapshot.generatedAt ?? this.options.orchestrator.snapshot().generatedAt,
      runStore: this.options.runStore,
      runs: activityRuns,
      lifecycleStore: this.options.lifecycleStore,
      lifecycleRecords: activitySources.lifecycleRecords,
      writebackOutbox: this.options.writebackOutbox,
      writebackOperations: activitySources.writebackOperations,
      query: { issue: null, offset: 0, limit: limits.timelineLimit },
      includeTranscriptEvents: false,
    });
    const history = projectWebHistory(runs, activityFeed.activity);
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
    transcript: ReturnType<typeof projectWebTranscript>,
  ): Promise<void> {
    await this.persistProjection(this.webTranscriptProjectionWriteInput(run, page, transcript));
  }

  private async persistWebOrchestratorChatProjection(
    chat: readonly ChatMessage[],
    conversationId?: string | null,
  ): Promise<void> {
    await this.persistProjection(this.webOrchestratorChatProjectionWriteInput(chat, conversationId));
  }

  private async persistProjection(input: ProjectionPayloadWriteInput): Promise<void> {
    const writer = this.options.projectionWriter;
    if (!writer) return;
    try {
      await writer.writeProjection(input);
    } catch {
      // Durable projection rows are cache/read-model side effects. The status API
      // response is derived from canonical stores during this transition phase,
      // so projection persistence failures must not make the UI unavailable.
    }
  }

  private hasDurableProjectionReader(): boolean {
    return Boolean(this.options.projectionReader);
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
    const currentRevisions = projectionCurrentSourceRevisionsForRead(
      record.revision.projectionName,
      await this.resolveWebProjectionSourceRevisions(),
    );
    return projectionSourceRevisionsCompatible(record.revision.sourceRevisions, currentRevisions);
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

  private async fetchBoardIssueDetail(issueId: string, forceRefresh: boolean) {
    const { sourceIndex, issueBoardColumns } = await this.fetchWebProjectionSourceIndex(forceRefresh);
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

    const card = board?.issues.find((item) => hasBoardKey(new Set(boardCardKeys(item)), [issueId])) ?? null;
    const detail = await buildBoardIssueDetail({
      requestKey: issueId,
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
      ...(this.options.tracker
        ? { fetchTrackerProjection: ({ columns, forceRefresh }) => this.fetchIssueBoardTrackerProjection(columns, forceRefresh) }
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

  private async createWebProjectionContextFingerprint(
    snapshot: ReturnType<Orchestrator["snapshot"]>,
    issueBoardColumns: IssueBoardColumnMapping,
  ): Promise<WebProjectionCacheFingerprint> {
    const fetchedStates = webProjectionIssueBoardFetchStates(issueBoardColumns);
    return createWebProjectionFingerprint({
      runtimeGeneratedAt: statusServerRuntimeFingerprintKey(snapshot),
      issueBoardStates: [issueBoardFetchedStateCacheKey(fetchedStates)],
      issueBoardColumns: issueBoardColumnCacheKeyValues(issueBoardColumns),
      durableSourceRevisions: await this.resolveWebProjectionSourceRevisions(),
    });
  }

  private async resolveWebProjectionSourceRevisions(): Promise<readonly WebProjectionSourceRevision[]> {
    const providers = this.webProjectionRevisionProviders;
    if (providers.length === 0) return [];
    return Promise.all(providers.map((provider) => provider.getRevision()));
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
  ): Promise<IssueBoardTrackerProjection> {
    const tracker = this.options.tracker;
    if (!tracker) {
      throw new SymphonyError("tracker_unavailable", "Issue board requires a configured tracker client");
    }

    const fetchedStates = webProjectionIssueBoardFetchStates(columns);
    const cacheKey = issueBoardFetchedStateCacheKey(fetchedStates);
    const now = Date.now();
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
        fetchedAt: new Date(now).toISOString(),
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

function createStatusServerWebProjectionRevisionProviders(
  options: StatusServerOptions,
): readonly WebProjectionRevisionProvider[] {
  const providers: WebProjectionRevisionProvider[] = [...(options.webProjectionRevisionProviders ?? [])];
  const runStoreProvider = createStatusServerStoreRevisionProvider("runStore", options.runStore);
  if (runStoreProvider) providers.push(runStoreProvider);
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
        listener({ source: event.source || source, revision: event.revision, observedAt: null });
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

async function readRunActivityTranscriptPage(
  sourceStore: RunActivityEventSourceStore,
  run: RunRecord,
  options: { offset: number; limit: number },
): Promise<TranscriptPage | null> {
  const sourcePage = await sourceStore.readRunEvents(run.runId, options);
  if (sourcePage.total === 0) return null;
  return runActivityEventsPageToTranscriptPage(sourcePage, run);
}

async function readRunActivityTranscriptTail(
  sourceStore: RunActivityEventSourceStore,
  run: RunRecord,
  options: { limit: number },
): Promise<TranscriptPage | null> {
  const sourceHead = await sourceStore.readRunEvents(run.runId, { offset: 0, limit: 1 });
  if (sourceHead.total === 0) return null;
  const offset = Math.max(0, sourceHead.total - options.limit);
  return runActivityEventsPageToTranscriptPage(
    await sourceStore.readRunEvents(run.runId, { offset, limit: options.limit }),
    run,
  );
}

function runActivityEventsPageToTranscriptPage(sourcePage: RunActivityEventsPage, run: RunRecord): TranscriptPage {
  return {
    runId: run.runId,
    offset: sourcePage.offset,
    limit: sourcePage.limit,
    nextOffset: sourcePage.nextOffset,
    events: sourcePage.events.map((stored) => mapRunActivityEventToTranscriptEvent(stored.event, { runId: run.runId })),
  };
}

function statusServerProjectionSourceRevisions(
  sourceIndex: BuiltWebProjectionSourceIndex | null,
  options: Pick<StatusServerOptions, "runStore" | "lifecycleStore" | "writebackOutbox">,
): ProjectionSourceRevision[] {
  if (sourceIndex) return sourceIndex.durableSourceRevisions.map(toProjectionSourceRevision);
  return [
    statusServerStoreProjectionSourceRevision("runStore", options.runStore),
    statusServerStoreProjectionSourceRevision("lifecycleStore", options.lifecycleStore),
    statusServerStoreProjectionSourceRevision("writebackOutbox", options.writebackOutbox),
  ].filter((revision): revision is ProjectionSourceRevision => revision !== null);
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

  const status = trackerIssues.issues.length === 0 ? "empty" : "fresh";
  return [
    {
      source: "trackerIssues",
      status,
      checkedAt,
      revision,
      lastSuccessAt: checkedAt,
      lastErrorAt: null,
      detail: status === "empty" ? "Issue board tracker source returned no issues" : "Issue board tracker source is current",
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

function statusServerOrchestratorChatProjectionSourceRevisions(
  store: OrchestratorConversationStore | undefined,
  chat: readonly ChatMessage[],
  conversationId?: string | null,
): ProjectionSourceRevision[] {
  const storeRevision = statusServerStoreProjectionSourceRevision("orchestrator_conversations", store);
  const lastMessage = chat.at(-1) ?? null;
  const conversationKey = orchestratorChatProjectionScopeKey(conversationId);
  const chatRevision: ProjectionSourceRevision = {
    source: `orchestrator_chat:${conversationKey}`,
    revision: [chat.length, lastMessage?.id ?? "none", lastMessage?.updatedAt ?? lastMessage?.createdAt ?? "unknown"].join(":"),
    observedAt: lastMessage?.updatedAt ?? lastMessage?.createdAt ?? null,
  };
  return storeRevision ? [storeRevision, chatRevision] : [chatRevision];
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

function transcriptProjectionPageSelectorForRequest(run: RunRecord, url: URL): WebTranscriptProjectionPageSelector {
  const requestedPage = parseWebTranscriptPagination(url);
  const offset = requestedPage?.offset ?? Math.max(0, (run.transcriptEventCount ?? 0) - WEB_TRANSCRIPT_DEFAULT_EVENT_LIMIT);
  const limit = requestedPage?.limit ?? WEB_TRANSCRIPT_DEFAULT_EVENT_LIMIT;
  return { runId: run.runId, offset, limit };
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
    offset: page.offset,
    limit: page.limit,
    nextOffset: page.nextOffset,
    eventCount: page.events.length,
    firstSequence: firstEvent?.sequence ?? null,
    lastSequence: lastEvent?.sequence ?? null,
    lastEventAt: lastEvent?.at ?? null,
  };
}

function orchestratorChatProjectionSourceCursors(
  chat: readonly ChatMessage[],
  conversationId?: string | null,
): Record<string, unknown> {
  const lastMessage = chat.at(-1) ?? null;
  return {
    conversationKey: orchestratorChatProjectionScopeKey(conversationId),
    messageCount: chat.length,
    lastMessageId: lastMessage?.id ?? null,
    lastMessageStatus: lastMessage?.status ?? null,
    lastMessageAt: lastMessage?.updatedAt ?? lastMessage?.createdAt ?? null,
  };
}

function webOrchestratorChatProjectionFromResponseBody(body: unknown): ChatMessage[] | null {
  if (isWebOrchestratorChatProjection(body)) return body;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const chat = (body as { chat?: unknown }).chat;
    if (isWebOrchestratorChatProjection(chat)) return chat;
  }
  return null;
}

function isWebOrchestratorChatProjection(value: unknown): value is ChatMessage[] {
  return Array.isArray(value) && value.every((item) => item && typeof item === "object" && typeof (item as ChatMessage).text === "string");
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
): { status: number; body: unknown } {
  return {
    status: webOrchestratorChatReplayStatus(message),
    body: projectWebOrchestratorChatPost(input, messages),
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
  offset: number;
  limit: number;
}

interface ActivityItem {
  id: string;
  at: string;
  kind: "run_started" | "run_completed" | "transcript_event" | "writeback_operation";
  source: "run" | TranscriptEvent["source"] | "writeback";
  issue: {
    id: string;
    identifier: string;
  };
  run: {
    runId: string;
    role: AgentRunRole;
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
  const keys = input.card ? boardCardKeys(input.card) : [input.requestKey];
  const live = liveIssueByKeys(input.sourceIndex, keys);
  const workspace = workspaceByKeys(input.sourceIndex, keys);
  const latestRun = latestRunByKeys(input.sourceIndex, keys);
  const rawLifecycle = lifecycleByKeys(input.sourceIndex, keys);
  const lifecycle = sanitizeStatusLifecycle({ live, workspace, latestRun, lifecycle: rawLifecycle });
  if (!input.card && !live && !workspace && !latestRun && !lifecycle) return null;

  const issueKey = input.card?.issueIdentifier ?? input.card?.issueId ?? input.requestKey;
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
      requestKey: input.requestKey,
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
    issue: input.requestKey,
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
}) {
  const allRuns = input.runs ?? (input.runStore ? await input.runStore.listRuns() : []);
  const includeTranscriptEvents = input.includeTranscriptEvents ?? true;
  const lifecycleRecords = input.lifecycleRecords ?? (await input.lifecycleStore?.list()) ?? [];
  const issueFilter = input.query.issue;
  const runs = issueFilter ? allRuns.filter((run) => activityRunMatchesIssue(run, issueFilter)) : allRuns;
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
  const filteredWritebackOperations = issueFilter
    ? writebackOperations.filter((operation) => writebackOperationMatchesIssue(operation, issueFilter, allRuns, lifecycleRecords))
    : writebackOperations;
  writebackOperationsConsidered = filteredWritebackOperations.length;
  activity.push(...filteredWritebackOperations.map((operation) => activityItemForWritebackOperation(operation, allRuns, lifecycleRecords)));

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
): ActivityItem {
  const run = operation.runId ? (runs.find((candidate) => candidate.runId === operation.runId) ?? null) : null;
  const lifecycle =
    lifecycles.find((candidate) => candidate.issueId === operation.issueId || candidate.issueIdentifier === operation.issueId) ?? null;
  const issueIdentifier = run?.issueIdentifier ?? lifecycle?.issueIdentifier ?? operation.issueId;
  return {
    id: `writeback:${operation.idempotencyKey}`,
    at: operation.updatedAt,
    kind: "writeback_operation",
    source: "writeback",
    issue: {
      id: operation.issueId,
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
      issue: `/api/v1/board/issues/${encodeURIComponent(issueIdentifier)}`,
      run: operation.runId ? `/api/v1/runs/${encodeURIComponent(operation.runId)}` : null,
      transcript: null,
    },
  };
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
    issue: `/api/v1/board/issues/${encodeURIComponent(run.issueIdentifier)}`,
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
    await maybeAdd(live.issueIdentifier, live);
  }
  for (const pausedKey of snapshot.paused) {
    await maybeAdd(pausedKey);
  }
  for (const lifecycle of input.sourceIndex.lifecycles.records) {
    if (isLifecycleBlocked(lifecycle)) await maybeAdd(lifecycle.issueIdentifier);
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
  const issueKey = input.issueDetails.issue.identifier ?? input.issueDetails.issue.id ?? input.key;
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

function activityRunMatchesIssue(run: RunRecord, issue: string): boolean {
  return run.issueId === issue || run.issueIdentifier === issue;
}

function writebackOperationMatchesIssue(
  operation: WritebackOperation,
  issue: string,
  runs: readonly RunRecord[],
  lifecycles: readonly IssueLifecycleRecord[],
): boolean {
  if (operation.issueId === issue) return true;
  const run = operation.runId ? runs.find((candidate) => candidate.runId === operation.runId) : null;
  if (run && activityRunMatchesIssue(run, issue)) return true;
  return lifecycles.some(
    (lifecycle) =>
      (lifecycle.issueId === operation.issueId || lifecycle.issueIdentifier === operation.issueId) &&
      (lifecycle.issueId === issue || lifecycle.issueIdentifier === issue),
  );
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
    issueKey: row.issueIdentifier,
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
      const workspace = (await runStore?.findWorkspace(row.issueId)) ?? (await runStore?.findWorkspace(row.issueIdentifier));
      const latestRun =
        (await runStore?.latestRunForIssue(row.issueId)) ?? (await runStore?.latestRunForIssue(row.issueIdentifier));
      const summaryRun = await resolveIssueDetailsSummaryRun(row, latestRun, runStore);
      const controls = operatorControls({ issueKnown: true, live: row, paused, mutationsConfigured });
      const mergeConflict = mergeConflictOperatorSummary(row.lifecycle?.mergeConflict ?? null);
      const affordances = operatorAffordances({
        issueKey: row.issueIdentifier,
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
        runId: row.liveness.activeRunId ?? row.runId,
        workspacePath: row.workspacePath,
        paused,
        issueDetails: buildIssueDetailsEnvelope({
          requestKey: row.issueIdentifier,
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
    source: gate.source,
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
  for (const issueKey of [row.issueId, row.issueIdentifier]) {
    const run = await runStore.latestRunForIssue(issueKey);
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
      const workspace = await runStore?.findWorkspace(pausedKey);
      const latestRun = await runStore?.latestRunForIssue(pausedKey);
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
          requestKey: pausedKey,
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
          issueKey: issueIdentifier,
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

async function resolveWebTranscriptRun(runStore: RunTranscriptStore, sessionIdOrRunId: string): Promise<RunRecord | null> {
  const directRun = await runStore.getRun(sessionIdOrRunId);
  if (directRun) return directRun;
  const runs = (await runStore.listRuns()).sort(compareRunChronology);
  return runs.find((run) => run.sessionId === sessionIdOrRunId) ?? null;
}

async function readBoundedWebTranscript(runStore: RunTranscriptStore, runId: string, url?: URL): Promise<TranscriptEvent[]> {
  return (await readBoundedWebTranscriptPage(runStore, runId, url)).events;
}

async function readBoundedWebTranscriptPage(runStore: RunTranscriptStore, runId: string, url?: URL): Promise<TranscriptPage> {
  const requestedPage = parseWebTranscriptPagination(url);
  if (requestedPage) return runStore.readTranscript(runId, requestedPage);

  return runStore.readTranscriptTail(runId, { limit: WEB_TRANSCRIPT_DEFAULT_EVENT_LIMIT });
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
  return sanitizePublicJson(snapshot) as RuntimeSnapshot;
}

function publicRunRecord(run: RunRecord): RunRecord {
  const record: RunRecord = {
    ...run,
    error: publicDiagnosticText(run.error),
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

function publicLiveRow(row: RunningRow): RunningRow {
  return {
    ...row,
    lastEvent: publicDiagnosticText(row.lastEvent),
    lastMessage: publicDiagnosticText(row.lastMessage),
    cancellation: publicLiveCancellation(row.cancellation),
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

function durableIssueStatusView(input: {
  requestKey: string;
  latestRun: RunRecord | null | undefined;
  lifecycle: IssueLifecycleRecord | null | undefined;
  workspace: WorkspaceRecord | null | undefined;
}): IssueStatusView {
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
  return {
    issue: issue && issue.length > 0 ? issue : null,
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

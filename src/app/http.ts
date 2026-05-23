import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { constants as fsConstants, promises as fs } from "node:fs";
import type { Orchestrator } from "../core/orchestrator/Orchestrator.js";
import type { WorkspaceManager } from "../core/workspace/WorkspaceManager.js";
import type { CursorWorkspaceOpener } from "../../cursor/src/CursorWorkspaceOpener.js";
import { SymphonyError, errorMessage } from "../core/errors.js";
import { toIssueStatusView, type AgentRunRole, type Issue } from "../core/types.js";
import type {
  IssueCompletionReportRecord,
  IssueLifecycleRecord,
  IssueLifecycleStore,
  IssueReviewVerdictRecord,
} from "../core/persistence/IssueLifecycleStore.js";
import type { FileMcpExposureDiagnosticsStore } from "../core/persistence/McpExposureDiagnosticsStore.js";
import {
  compareRunChronology,
  type RunRecord,
  type RunTranscriptStore,
  type TranscriptEvent,
  type WorkspaceRecord,
} from "../core/persistence/RunTranscriptStore.js";
import type { TrackerClient } from "../core/tracker/TrackerClient.js";
import type {
  IssueBlockerRef,
  IssueDetailsEnvelope,
  IssueLatestRunSummary,
  IssuePullRequestSummary,
  IssueStateClassification,
  IssueStatusView,
  IssueTrackerMetadata,
  IssueWorkspaceSummary,
  RunTerminalReason,
  TrackerStateLists,
} from "../core/types.js";

export interface StatusServerOptions {
  orchestrator: Orchestrator;
  workspaceManager: WorkspaceManager;
  workspaceOpener: CursorWorkspaceOpener;
  runStore?: RunTranscriptStore;
  lifecycleStore?: IssueLifecycleStore;
  mcpExposureDiagnosticsStore?: FileMcpExposureDiagnosticsStore;
  host: string;
  port: number;
  openWorkspaceToken: string | null;
  tracker?: TrackerClient;
  trackerStateLists: TrackerStateLists;
  issueBoardMergeReadyStates?: readonly string[];
  staleThresholdMs: number;
}

export class StatusServer {
  private server: http.Server | null = null;

  constructor(private readonly options: StatusServerOptions) {}

  async start(): Promise<{ host: string; port: number }> {
    if (this.server) {
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
    const address = this.server.address();
    if (typeof address === "object" && address) return { host: address.address, port: address.port };
    return { host: this.options.host, port: this.options.port };
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (request.method === "GET" && url.pathname === "/") {
        sendHtml(
          response,
          await renderDashboard(
            this.options.orchestrator.snapshot(),
            Boolean(this.options.openWorkspaceToken),
            this.options.runStore,
            this.options.lifecycleStore,
            this.options.trackerStateLists,
            this.options.staleThresholdMs,
          ),
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/state") {
        const snapshot = this.options.orchestrator.snapshot();
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
      if (request.method === "GET" && url.pathname === "/api/v1/issue-board") {
        sendJson(
          response,
          200,
          await buildIssueBoard(
            this.options.orchestrator.snapshot(),
            Boolean(this.options.openWorkspaceToken),
            this.options.tracker,
            this.options.runStore,
            this.options.lifecycleStore,
            this.options.trackerStateLists,
            this.options.issueBoardMergeReadyStates ?? [],
            this.options.staleThresholdMs,
          ),
        );
        return;
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

      const issueRunsMatch = /^\/api\/v1\/issues\/([^/]+)\/runs$/.exec(url.pathname);
      if (request.method === "GET" && issueRunsMatch) {
        const issueId = decodeURIComponent(issueRunsMatch[1] ?? "");
        const snapshot = this.options.orchestrator.snapshot();
        const live = this.options.orchestrator.getIssueDetails(issueId);
        const workspace = await this.options.runStore?.findWorkspace(issueId);
        const latestRun = await this.options.runStore?.latestRunForIssue(issueId);
        const summaryRun = await resolveIssueDetailsSummaryRun(live, latestRun, this.options.runStore);
        const runs = (await this.options.runStore?.listRunsForIssue(issueId)) ?? [];
        const lifecycle = await this.options.lifecycleStore?.get(issueId);
        const enrichedRuns = await Promise.all(
          runs.map(async (run) => ({
            ...run,
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

      const issueMatch = /^\/api\/v1\/issues\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && issueMatch) {
        const issueId = decodeURIComponent(issueMatch[1] ?? "");
        const snapshot = this.options.orchestrator.snapshot();
        const live = this.options.orchestrator.getIssueDetails(issueId);
        const workspace = await this.options.runStore?.findWorkspace(issueId);
        const latestRun = await this.options.runStore?.latestRunForIssue(issueId);
        const summaryRun = await resolveIssueDetailsSummaryRun(live, latestRun, this.options.runStore);
        const lifecycle = await this.options.lifecycleStore?.get(issueId);
        if (!live && !workspace && !latestRun && !lifecycle) throw new SymphonyError("not_found", `Issue not found: ${issueId}`);
        const workspacePath = live?.workspacePath ?? workspace?.path ?? null;
        const keys = issueKeys(issueId, { live, latestRun, lifecycle });
        const paused = isIssuePaused(snapshot, keys);
        const resolvedAgentId = live ? await resolveRunningAgentId(live, this.options.runStore) : null;
        const operatorLiveness = await issueOperatorLiveness({
          live,
          latestRun,
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
          latestRun,
          lifecycle,
          reviewLoop: reviewLoopStatus({ live, latestRun, lifecycle }),
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
            humanRequired: affordances.humanRequired,
            continuationSummary: affordances.continuationSummary,
            mutationsRequireToken: controls.mutationsRequireToken,
            mutationHeader: "X-Symphony-Token",
          },
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
          ...run,
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

      sendJson(response, 404, { error: { code: "not_found", message: "Route not found" } });
    } catch (error) {
      const status =
        error instanceof SymphonyError && error.code === "not_found"
          ? 404
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

  private requireMutationToken(request: IncomingMessage): void {
    const expected = this.options.openWorkspaceToken;
    if (!expected) return;
    const provided = request.headers["x-symphony-token"];
    if (provided !== expected) {
      throw new SymphonyError("invalid_request", "Missing or invalid open-workspace token");
    }
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function sendHtml(response: ServerResponse, body: string): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(body);
}

type RuntimeSnapshot = ReturnType<Orchestrator["snapshot"]>;
type RunningRow = RuntimeSnapshot["running"][number];
type OperatorLivenessStatus = "running" | "possibly_stalled" | "cancelling" | "cancelled" | "blocked_human_required";

const OPERATOR_LIVENESS_CONTRACT = {
  version: "eng-62-v1",
  supportedStatuses: ["running", "possibly_stalled", "cancelling", "cancelled", "blocked_human_required"],
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

type IssueBoardLaneId = "active" | "handoff" | "merge_ready" | "blocked" | "unknown";

interface IssueBoardCard {
  key: string;
  issueId: string | null;
  issueIdentifier: string | null;
  origin: "tracker" | "symphony";
  lane: IssueBoardLaneId;
  issueDetails: IssueDetailsEnvelope;
  paused: boolean;
  live: { role: AgentRunRole; state: string; runId: string | null } | null;
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
  id: IssueBoardLaneId;
  title: string;
  states: string[];
  issues: IssueBoardCard[];
}

async function buildIssueBoard(
  snapshot: RuntimeSnapshot,
  mutationsConfigured: boolean,
  tracker: TrackerClient | undefined,
  runStore: RunTranscriptStore | undefined,
  lifecycleStore: IssueLifecycleStore | undefined,
  trackerStateLists: TrackerStateLists,
  mergeReadyStates: readonly string[],
  staleThresholdMs: number,
) {
  if (!tracker) {
    throw new SymphonyError("tracker_unavailable", "Issue board requires a configured tracker client");
  }

  const fetchedStates = boardFetchStates(trackerStateLists, mergeReadyStates);
  let trackerIssues: Issue[];
  try {
    trackerIssues = await tracker.fetchIssuesByStates(fetchedStates);
  } catch (error) {
    if (error instanceof SymphonyError) throw error;
    throw new SymphonyError("tracker_error", `Issue board tracker fetch failed: ${errorMessage(error)}`);
  }

  const representedKeys = new Set<string>();
  const cards: IssueBoardCard[] = [];
  for (const issue of trackerIssues) {
    addBoardKeys(representedKeys, [issue.id, issue.identifier]);
    cards.push(
      await buildTrackerBoardCard({
        issue,
        snapshot,
        mutationsConfigured,
        runStore,
        lifecycleStore,
        trackerStateLists,
        mergeReadyStates,
        staleThresholdMs,
      }),
    );
  }

  const symphonyOnlyCards = await buildSymphonyOnlyBoardCards({
    snapshot,
    mutationsConfigured,
    runStore,
    lifecycleStore,
    trackerStateLists,
    mergeReadyStates,
    staleThresholdMs,
    representedKeys,
  });
  cards.push(...symphonyOnlyCards);

  const lanes = boardLanes(trackerStateLists, mergeReadyStates).map((lane) => ({
    ...lane,
    issues: cards.filter((card) => card.lane === lane.id),
  }));

  return {
    generatedAt: snapshot.generatedAt,
    tracker: {
      status: "ok" as const,
      fetchedStates,
      issueCount: trackerIssues.length,
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

async function buildTrackerBoardCard(input: {
  issue: Issue;
  snapshot: RuntimeSnapshot;
  mutationsConfigured: boolean;
  runStore: RunTranscriptStore | undefined;
  lifecycleStore: IssueLifecycleStore | undefined;
  trackerStateLists: TrackerStateLists;
  mergeReadyStates: readonly string[];
  staleThresholdMs: number;
}): Promise<IssueBoardCard> {
  const issueStatus = toIssueStatusView(input.issue);
  const keys = [input.issue.id, input.issue.identifier];
  const live = liveIssueByKeys(input.snapshot, keys);
  const workspace = await workspaceByKeys(input.runStore, keys);
  const latestRun = await latestRunByKeys(input.runStore, keys);
  const lifecycle = await lifecycleByKeys(input.lifecycleStore, keys);
  const summaryRun = await resolveIssueDetailsSummaryRun(live, latestRun, input.runStore);
  const paused = isIssuePaused(input.snapshot, [
    ...keys,
    ...issueKeys(input.issue.identifier, { live, latestRun, lifecycle }),
  ]);
  const issueDetails = buildIssueDetailsEnvelope({
    requestKey: input.issue.identifier,
    generatedAt: input.snapshot.generatedAt,
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
    lane: classifyBoardLane(input.issue.state, lifecycle, input.trackerStateLists, input.mergeReadyStates),
    issueDetails,
    live,
    workspace,
    latestRun,
    lifecycle,
    paused,
    mutationsConfigured: input.mutationsConfigured,
    runStore: input.runStore,
    continuationSummaryAvailable: Boolean(input.lifecycleStore && input.runStore),
  });
}

async function buildSymphonyOnlyBoardCards(input: {
  snapshot: RuntimeSnapshot;
  mutationsConfigured: boolean;
  runStore: RunTranscriptStore | undefined;
  lifecycleStore: IssueLifecycleStore | undefined;
  trackerStateLists: TrackerStateLists;
  mergeReadyStates: readonly string[];
  staleThresholdMs: number;
  representedKeys: Set<string>;
}): Promise<IssueBoardCard[]> {
  const cards: IssueBoardCard[] = [];
  const localKeys = new Set<string>();
  const maybeAdd = async (requestKey: string, forcedLive: RunningRow | null = null) => {
    if (hasBoardKey(input.representedKeys, [requestKey]) || hasBoardKey(localKeys, [requestKey])) return;
    const keys = [requestKey];
    const live = forcedLive ?? liveIssueByKeys(input.snapshot, keys);
    const workspace = await workspaceByKeys(input.runStore, keys);
    const latestRun = await latestRunByKeys(input.runStore, keys);
    const lifecycle = await lifecycleByKeys(input.lifecycleStore, keys);
    const isBlocked = isLifecycleBlocked(lifecycle);
    const isPaused = isIssuePaused(input.snapshot, [
      requestKey,
      ...issueKeys(requestKey, { live, latestRun, lifecycle }),
    ]);
    if (!live && !isPaused && !isBlocked) return;
    if (!live && !isPaused && lifecycle?.phase === "terminal") return;
    const summaryRun = await resolveIssueDetailsSummaryRun(live, latestRun, input.runStore);
    const issueDetails = buildIssueDetailsEnvelope({
      requestKey,
      generatedAt: input.snapshot.generatedAt,
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
      lane: classifyBoardLane(live?.state ?? issueDetails.issue.state, lifecycle, input.trackerStateLists, input.mergeReadyStates),
      issueDetails,
      live,
      workspace,
      latestRun,
      lifecycle,
      paused: isPaused,
      mutationsConfigured: input.mutationsConfigured,
      runStore: input.runStore,
      continuationSummaryAvailable: Boolean(input.lifecycleStore && input.runStore),
    });
    addBoardKeys(localKeys, boardCardKeys(card));
    cards.push(card);
  };

  for (const live of input.snapshot.running) {
    await maybeAdd(live.issueIdentifier, live);
  }
  for (const pausedKey of input.snapshot.paused) {
    await maybeAdd(pausedKey);
  }
  for (const lifecycle of (await input.lifecycleStore?.list()) ?? []) {
    if (isLifecycleBlocked(lifecycle)) await maybeAdd(lifecycle.issueIdentifier);
  }
  return cards;
}

async function buildBoardCard(input: {
  key: string;
  origin: "tracker" | "symphony";
  lane: IssueBoardLaneId;
  issueDetails: IssueDetailsEnvelope;
  live: RunningRow | null;
  workspace: WorkspaceRecord | null | undefined;
  latestRun: RunRecord | null | undefined;
  lifecycle: IssueLifecycleRecord | null | undefined;
  paused: boolean;
  mutationsConfigured: boolean;
  runStore: RunTranscriptStore | undefined;
  continuationSummaryAvailable: boolean;
}): Promise<IssueBoardCard> {
  const issueKey = input.issueDetails.issue.identifier ?? input.issueDetails.issue.id ?? input.key;
  const resolvedAgentId = input.live ? await resolveRunningAgentId(input.live, input.runStore) : null;
  const operatorLiveness = await issueOperatorLiveness({
    live: input.live,
    latestRun: input.latestRun,
    lifecycle: input.lifecycle,
    paused: input.paused,
    resolvedAgentId,
    runStore: input.runStore,
  });
  const affordances = operatorAffordances({
    issueKey,
    lifecycle: input.lifecycle,
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
          state: input.live.state,
          runId: input.live.liveness.activeRunId ?? input.live.runId,
        }
      : null,
    operatorLiveness,
    reviewLoop: reviewLoopStatus({ live: input.live, latestRun: input.latestRun, lifecycle: input.lifecycle }),
    metadata: statusMetadata({
      live: input.live,
      workspace: input.workspace,
      latestRun: input.latestRun,
      lifecycle: input.lifecycle,
    }),
    capabilities: {
      detail: `/api/v1/issues/${encodeURIComponent(issueKey)}`,
      runs: `/api/v1/issues/${encodeURIComponent(issueKey)}/runs`,
      humanRequired: affordances.humanRequired,
      continuationSummary: affordances.continuationSummary,
    },
  };
}

function boardFetchStates(stateLists: TrackerStateLists, mergeReadyStates: readonly string[]): string[] {
  return uniqueStateNames([
    ...stateLists.activeStates,
    ...stateLists.handoffStates,
    ...stateLists.reviewStates,
    ...stateLists.blockedStates,
    ...mergeReadyStates,
  ]).filter((state) => !isStateNameIn(state, stateLists.terminalStates));
}

function boardLanes(stateLists: TrackerStateLists, mergeReadyStates: readonly string[]): Array<Omit<IssueBoardLane, "issues">> {
  return [
    { id: "active", title: "Active", states: uniqueStateNames(stateLists.activeStates) },
    { id: "handoff", title: "Review", states: uniqueStateNames([...stateLists.handoffStates, ...stateLists.reviewStates]) },
    { id: "merge_ready", title: "Ready to Merge", states: uniqueStateNames(mergeReadyStates) },
    { id: "blocked", title: "Blocked", states: uniqueStateNames(stateLists.blockedStates) },
    { id: "unknown", title: "Unknown", states: [] },
  ];
}

function classifyBoardLane(
  state: string | null,
  lifecycle: IssueLifecycleRecord | null | undefined,
  stateLists: TrackerStateLists,
  mergeReadyStates: readonly string[],
): IssueBoardLaneId {
  if (isLifecycleBlocked(lifecycle) || (state !== null && isStateNameIn(state, stateLists.blockedStates))) return "blocked";
  if (state !== null && isStateNameIn(state, mergeReadyStates)) return "merge_ready";
  if (state !== null && isStateNameIn(state, [...stateLists.handoffStates, ...stateLists.reviewStates])) return "handoff";
  if (state !== null && isStateNameIn(state, stateLists.activeStates)) return "active";
  return "unknown";
}

function liveIssueByKeys(snapshot: RuntimeSnapshot, keys: string[]): RunningRow | null {
  return snapshot.running.find((row) => keys.includes(row.issueId) || keys.includes(row.issueIdentifier)) ?? null;
}

async function workspaceByKeys(runStore: RunTranscriptStore | undefined, keys: string[]): Promise<WorkspaceRecord | null> {
  if (!runStore) return null;
  for (const key of keys) {
    const workspace = await runStore.findWorkspace(key);
    if (workspace) return workspace;
  }
  return null;
}

async function latestRunByKeys(runStore: RunTranscriptStore | undefined, keys: string[]): Promise<RunRecord | null> {
  if (!runStore) return null;
  const byRunId = new Map<string, RunRecord>();
  for (const key of keys) {
    for (const run of await runStore.listRunsForIssue(key)) {
      byRunId.set(run.runId, run);
    }
  }
  return [...byRunId.values()].sort(compareRunChronology).at(-1) ?? null;
}

async function lifecycleByKeys(lifecycleStore: IssueLifecycleStore | undefined, keys: string[]): Promise<IssueLifecycleRecord | null> {
  if (!lifecycleStore) return null;
  for (const key of keys) {
    const lifecycle = await lifecycleStore.get(key);
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
      .meta, .activity, .controls { color: #555; font-size: 0.9rem; }
      .cancellation, .blocked { margin-top: 0.25rem; font-size: 0.9rem; }
      .cancellation { color: #a31919; }
      .blocked { color: #5e197c; }
      .paused-label { color: #555; }
    </style>
  </head>
  <body>
    <h1>Symphony</h1>
    <p>Running: ${snapshot.counts.running}, retrying: ${snapshot.counts.retrying}, paused: ${snapshot.counts.paused}</p>
    <p class="meta">Mutations ${mutationsConfigured ? "require X-Symphony-Token" : "do not require a configured token"}; use the existing pause, resume, cancel, and continuation-summary API endpoints.</p>
    <section>
      <h2>Running Agents</h2>
      <ul class="plain-list">${running || "<li>No active runs</li>"}</ul>
    </section>
    ${paused}
    ${retrying}
    <p class="meta">Snapshot generated at ${escapeHtml(snapshot.generatedAt)}</p>
  </body>
</html>`;
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
  const threshold = row.liveness.stallTimeoutMs === null ? "no stall threshold" : `${row.liveness.stallTimeoutMs}ms threshold`;
  const cancellation = cancellationSummary(row);
  const cancelFailed = cancelFailedSummary(liveCancelFailed(row));
  const activitySources = activitySummary(row);
  const blockedReason = row.lifecycle?.blockedReason ?? null;
  return `<li class="run-row operator-${operator.status}">
    <div><strong>${escapeHtml(row.issueIdentifier)}</strong><span class="badge">${escapeHtml(operator.status)}</span> <span class="meta">${escapeHtml(row.role)} · ${escapeHtml(row.state)}</span></div>
    <div class="meta">run <code>${escapeHtml(runId)}</code> · agent <code>${escapeHtml(agentId ?? "n/a")}</code> · session <code>${escapeHtml(row.sessionId ?? "n/a")}</code>${paused ? " · paused" : ""}</div>
    <div class="activity">last activity ${escapeHtml(row.liveness.lastActivityAt)} (${escapeHtml(idle)}, ${escapeHtml(threshold)}); event <code>${escapeHtml(row.lastEvent ?? "n/a")}</code>${row.lastEventAt ? ` at ${escapeHtml(row.lastEventAt)}` : ""}</div>
    ${activitySources ? `<div class="activity">${escapeHtml(activitySources)}</div>` : ""}
    ${row.lastMessage ? `<div>${escapeHtml(row.lastMessage)}</div>` : ""}
    <div><code>${escapeHtml(row.workspacePath ?? "")}</code></div>
    ${cancellation ? `<div class="cancellation">${escapeHtml(cancellation)}</div>` : ""}
    ${cancelFailed ? `<div class="cancellation">${escapeHtml(cancelFailed)}</div>` : ""}
    ${blockedReason ? `<div class="blocked">Blocked: ${escapeHtml(blockedReason)}</div>` : ""}
    <div class="controls">controls: ${formatControls(controls)}</div>
    ${formatAffordances(affordances)}
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
        controls,
        ...affordances,
      };
    }),
  );
  return {
    generatedAt: snapshot.generatedAt,
    mutationsRequireToken: mutationsConfigured,
    operatorLivenessContract: OPERATOR_LIVENESS_CONTRACT,
    running,
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
    lastTranscriptEvent: row.lastEvent,
    lastMessage: row.lastMessage,
    secondsSinceLastActivity: row.liveness.secondsSinceLastActivity,
    stallTimeoutMs: row.liveness.stallTimeoutMs,
    cancellation: row.cancellation,
    paused,
    activity: liveActivity(row),
    timeline: liveTimeline(row),
  };
}

async function resolveRunningAgentId(row: RunningRow, runStore?: RunTranscriptStore): Promise<string | null> {
  if (!runStore) return null;
  const runId = row.liveness.activeRunId ?? row.runId;
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
  return null;
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
  if (run.status === "running") return { tracking: "orphaned", status: null, paused: false };
  return { tracking: "terminal", status: null, paused: false };
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
    lastMessage: lifecycle?.blockedReason ?? run?.error ?? null,
    secondsSinceLastActivity: null,
    stallTimeoutMs: null,
    cancellation: null,
    paused,
    activity: await terminalActivity(run, lifecycle, runStore),
    timeline: terminalTimeline(status, run, lifecycle),
  };
}

function liveCancelFailed(row: RunningRow) {
  if (row.cancellation.cancelFailed) return row.cancellation.cancelFailed;
  if (row.cancellation.harnessStopFailedAt) {
    return {
      tracked: true,
      active: true,
      phase: "failed",
      at: row.cancellation.harnessStopFailedAt,
      reason: row.cancellation.harnessStopFailedReason ?? null,
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
      reason: run.cancelFailedReason ?? null,
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
    return deriveTerminalActivityFromTranscript(await readAllTranscriptEvents(runStore, run.runId), run.updatedAt ?? lifecycle?.updatedAt ?? null);
  }
  return {
    lastHarnessActivityAt: run?.updatedAt ?? lifecycle?.updatedAt ?? null,
    lastStreamActivityAt: null,
    lastDeltaOrToolActivityAt: null,
    lastToolActivityAt: null,
    unavailable: ["transcript_store_unavailable"],
  };
}

async function readAllTranscriptEvents(runStore: RunTranscriptStore, runId: string): Promise<TranscriptEvent[]> {
  const events: TranscriptEvent[] = [];
  let offset = 0;
  do {
    const page = await runStore.readTranscript(runId, { offset, limit: 1_000 });
    events.push(...page.events);
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  } while (true);
  return events;
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
    reason: blockedLifecycle.blockedReason,
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
      detail: row.lastMessage ?? row.lastEvent,
      synthetic: true,
      source: "live_snapshot",
    },
    ...(row.cancellation.requestedAt
      ? [
          {
            at: row.cancellation.requestedAt,
            kind: "cancellation_requested",
            label: "Cancellation requested",
            detail: row.cancellation.reason,
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
            detail: row.cancellation.harnessStopFailedReason ?? null,
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
            detail: run.error,
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
            detail: run.cancelFailedReason ?? null,
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
            detail: lifecycle.blockedReason,
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
  if (row.liveness.status === "stalled") return "possibly_stalled";
  return "running";
}

function findLiveRun(snapshot: RuntimeSnapshot, runId: string): RunningRow | null {
  return snapshot.running.find((row) => row.runId === runId || row.liveness.activeRunId === runId) ?? null;
}

function isLifecycleBlocked(lifecycle: IssueLifecycleRecord | null | undefined): boolean {
  return lifecycle !== null && lifecycle !== undefined && (lifecycle.phase === "blocked" || lifecycle.blockedReason !== null);
}

function liveIssueResponse(live: RunningRow, operatorLiveness: Awaited<ReturnType<typeof issueOperatorLiveness>>) {
  return { ...live, operatorLiveness };
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
  const metadata = statusMetadata(input);
  const issue = input.trackerIssue ?? input.live?.issueDetails ?? null;
  if (issue) {
    return {
      source: input.trackerIssue ? "tracker" : "live",
      completeness: "full",
      issue,
      tracker: buildIssueTrackerMetadata(issue, input.generatedAt, input.trackerStateLists, input.staleThresholdMs),
      blockers: buildIssueBlockerSummary(issue.blockedBy, input.trackerStateLists.terminalStates, input.lifecycle),
      workspace: buildIssueWorkspaceSummary(input, metadata),
      pullRequest: buildIssuePullRequestSummary(metadata),
      latestRun: buildIssueLatestRunSummary(input.summaryRun),
    };
  }

  return {
    source: "durable",
    completeness: "partial",
    issue: durableIssueStatusView(input),
    tracker: buildIssueTrackerMetadata(null, null, input.trackerStateLists, input.staleThresholdMs),
    blockers: buildIssueBlockerSummary(null, input.trackerStateLists.terminalStates, input.lifecycle),
    workspace: buildIssueWorkspaceSummary(input, metadata),
    pullRequest: buildIssuePullRequestSummary(metadata),
    latestRun: buildIssueLatestRunSummary(input.summaryRun),
  };
}

async function resolveIssueDetailsSummaryRun(
  live: RunningRow | null,
  issueWideLatestRun: RunRecord | null | undefined,
  runStore?: RunTranscriptStore,
): Promise<RunRecord | null> {
  if (!live) return issueWideLatestRun ?? null;
  const activeRunId = live.liveness.activeRunId ?? live.runId;
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
  terminalStates: readonly string[],
  lifecycle: IssueLifecycleRecord | null | undefined,
) {
  const open = (blockedBy ?? []).filter((blocker) => blocker.state === null || !isStateNameIn(blocker.state, terminalStates));
  const lifecycleBlocked = isLifecycleBlocked(lifecycle);
  return {
    available: blockedBy !== null,
    totalCount: blockedBy?.length ?? 0,
    openCount: open.length,
    open,
    blocked: open.length > 0 || lifecycleBlocked,
    humanBlockedReason: lifecycleBlocked ? (lifecycle?.blockedReason ?? null) : null,
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
  return {
    workspaceKey: input.workspace?.workspaceKey ?? input.latestRun?.workspaceKey ?? input.lifecycle?.summaryPointers.workspaceKey ?? null,
    path: input.workspace?.path ?? input.live?.workspacePath ?? input.latestRun?.workspacePath ?? input.lifecycle?.summaryPointers.workspacePath ?? null,
    sourceKind: input.workspace?.sourceKind ?? null,
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

function buildIssueLatestRunSummary(run: RunRecord | null | undefined): IssueLatestRunSummary {
  return {
    runId: run?.runId ?? null,
    status: run?.status ?? null,
    terminalReason: deriveRunTerminalReason(run ?? null),
    error: run?.error ?? null,
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
      reason: input.lifecycle?.blockedReason ?? null,
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
  };
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
    reviewRound: lifecycle?.reviewRound ?? null,
    incompleteTurnCount: lifecycle?.incompleteTurnCount ?? null,
    lastCompletionReport: latestCompletionReport(lifecycle),
    lastReviewVerdict: latestReviewVerdict(lifecycle),
    blockedReason: lifecycle?.blockedReason ?? null,
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
    if (exact) return exact;
  }
  return lifecycle.reviewVerdicts[lifecycle.reviewVerdicts.length - 1] ?? null;
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
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

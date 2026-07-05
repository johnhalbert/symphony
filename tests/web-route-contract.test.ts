import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CursorWorkspaceOpener } from "../cursor/src/CursorWorkspaceOpener.js";
import {
  StatusServer,
  type StatusServerProjectionReader,
  type StatusServerProjectionWriter,
  type StatusServerWebProjectionContextBuilder,
} from "../src/app/http.js";
import type { WebProjectionRevisionProvider } from "../src/app/WebProjectionContext.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import type {
  DurableProjectionName,
  ProjectionPayloadRecord,
  ProjectionPayloadWriteInput,
  ProjectionRevisionRecord,
  ProjectionRevisionSelector,
  ProjectionSourceRevision,
  ProjectionWriteResult,
} from "../src/core/persistence/ProjectionTransactionService.js";
import type { Orchestrator } from "../src/core/orchestrator/Orchestrator.js";
import type { RunRecord, RunTranscriptStore, TranscriptEvent, TranscriptPage, WorkspaceRecord } from "../src/core/persistence/RunTranscriptStore.js";
import type { TrackerStateLists } from "../src/core/types.js";
import type { TrackerClient } from "../src/core/tracker/TrackerClient.js";
import { WorkspaceManager } from "../src/core/workspace/WorkspaceManager.js";
import { webRouteContractGetFixtureCases, webRouteContractPaths } from "../web/tests/fixtures/webRouteContractFixtures.js";
import {
  FileOrchestratorConversationStore,
  type OrchestratorConversationStore,
} from "../src/core/persistence/OrchestratorConversationStore.js";
import {
  LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
  LEGACY_DEFAULT_PROJECT_CONTEXT_LABEL,
  LEGACY_DEFAULT_PROJECT_CONTEXT_ROUTING_SOURCE,
} from "../src/core/config/ProjectContexts.js";
import { projectOrchestratorChatProjectionPayload } from "../src/core/persistence/OrchestratorChatProjectionReducer.js";
import { issue as trackerIssue, testConfig } from "./helpers.js";

describe("/api/v1/web route contracts", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-web-route-contract-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("serves the frontend GET route matrix with stable JSON top-level contracts", async () => {
    const { server } = createStatusServer(root);
    const address = await server.start();
    const baseUrl = baseUrlFor(address);
    try {
      const routes: Array<{ path: string; assert: (body: unknown, text: string) => void }> = [
        {
          path: webRouteContractPaths.referenceData,
          assert: (body) => {
            expectTopLevelKeys(body, ["labels", "users"]);
            expect(body).toMatchObject({ labels: {}, users: { unassigned: { name: "Unassigned" } } });
          },
        },
        {
          path: webRouteContractPaths.dashboard,
          assert: (body) => {
            expectTopLevelKeys(body, [
              "activity",
              "agentUsageLabel",
              "branch",
              "chat",
              "concurrencyCap",
              "pollLabel",
              "projectName",
              "providerGates",
              "repoLabel",
              "runningAgents",
              "source",
              "totals",
              "workflowLabel",
            ]);

            expect(body).toEqual({
              projectName: "Symphony",
              repoLabel: "",
              branch: "",
              workflowLabel: "",
              pollLabel: "",
              agentUsageLabel: "0 agents",
              concurrencyCap: 0,
              providerGates: [],
              runningAgents: [],
              activity: [],
              chat: [],
              source: unavailableDashboardSource(),
              totals: emptyTotals(),
            });
          },

        },
        {
          path: webRouteContractPaths.issueBoard,
          assert: (body) => {
            expectTopLevelKeys(body, ["backlog", "cycleDateRange", "cycleLabel", "issues", "lanes", "selectedIssueId"]);
            expect(body).toEqual({
              issues: [],
              backlog: [],
              lanes: { todo: [], progress: [], review: [] },
              cycleLabel: "",
              cycleDateRange: "",
              selectedIssueId: "",
            });
          },
        },
        {
          path: webRouteContractPaths.issueDetail,
          assert: (body, text) => {
            expect(body).toBeNull();
            expect(text.trim()).toBe("null");
          },
        },
        {
          path: webRouteContractPaths.history,
          assert: (body) => {
            expectTopLevelKeys(body, ["defaultSessionId", "sessions", "timeline", "transcriptBySession"]);
            expect(body).toEqual({ sessions: [], transcriptBySession: {}, timeline: [], defaultSessionId: "" });
          },
        },
        {
          path: webRouteContractPaths.transcript,
          assert: (body) => {
            expectTranscriptWindowPayload(body, [], { kind: "tail", limit: 500 });
          },
        },
        {
          path: webRouteContractPaths.sidebar,
          assert: (body) => {
            expectTopLevelKeys(body, [
              "activity",
              "chat",
              "providerGates",
              "reviewIssues",
              "runningAgents",
              "sessions",
              "totals",
            ]);
            expect(body).toEqual({
              providerGates: [],
              runningAgents: [],
              reviewIssues: [],
              activity: [],
              sessions: [],
              chat: [],
              totals: emptyTotals(),
            });
          },
        },
        {
          path: webRouteContractPaths.orchestratorChat,
          assert: (body) => {
            expectTopLevelKeys(body, ["chat", "conversation", "schemaVersion", "source", "state", "status"]);
            expect(body).toMatchObject({
              schemaVersion: 1,
              conversation: { id: "orchestrator-default", status: "completed", messageCount: 0 },
              state: "empty",
              status: { state: "empty", empty: true, messageCount: 0 },
              chat: [],
            });
          },
        },
      ];

      expect(routes.map((route) => route.path)).toEqual(webRouteContractGetFixtureCases.map((testCase) => testCase.path));

      for (const route of routes) {
        const { response, body, text } = await getJson(`${baseUrl}${route.path}`);
        expect({ path: route.path, status: response.status }).toEqual({ path: route.path, status: 200 });
        route.assert(body, text);
        expect(text).not.toMatch(/mock|placeholder|sample/i);
      }
    } finally {
      await server.stop();
    }
  });

  it("records durable projection writes for web collection and chat routes", async () => {
    const projectionWriter = new RecordingProjectionWriter();
    const { server } = createStatusServer(root, { projectionWriter });
    const address = await server.start();
    const baseUrl = baseUrlFor(address);
    try {
      for (const path of [
        "/api/v1/web/dashboard",
        "/api/v1/web/issues",
        "/api/v1/web/history?sessionLimit=7&timelineLimit=9",
        "/api/v1/web/sidebar",
        "/api/v1/web/orchestrator-chat?conversationId=operator-room",
      ]) {
        const { response } = await getJson(`${baseUrl}${path}`);
        expect({ path, status: response.status }).toEqual({ path, status: 200 });
      }
    } finally {
      await server.stop();
    }

    expect(projectionWriter.writes.map(({ projectionName, scopeKind, scopeKey }) => ({ projectionName, scopeKind, scopeKey }))).toEqual([
      { projectionName: "dashboard_projection", scopeKind: "global", scopeKey: "global" },
      { projectionName: "issue_board_projection", scopeKind: "board", scopeKey: "default-board" },
      {
        projectionName: "history_projection",
        scopeKind: "global_collection",
        scopeKey: "global:session:7:timeline:9",
      },
      { projectionName: "sidebar_projection", scopeKind: "global", scopeKey: "global" },
      { projectionName: "orchestrator_chat_projection", scopeKind: "conversation", scopeKey: "operator-room" },
    ]);
    const dashboard = projectionWriter.writeFor("dashboard_projection");
    expect(dashboard.sourceCursors).toMatchObject({
      issueCount: 0,
      openIssueCount: 0,
      runningAgentCount: 0,
      providerGateCount: 0,
      activityCount: 0,
    });
    const issueBoard = projectionWriter.writeFor("issue_board_projection");
    expect(issueBoard.fields?.fetchedStates).toEqual(
      expect.arrayContaining(["Backlog", "Todo", "In Progress", "In Review", "Done", "Cancelled"]),
    );
    expect(issueBoard.sourceCursors).toMatchObject({ issueCount: 0 });
    expect(projectionWriter.writeFor("history_projection").sourceCursors).toMatchObject({
      sessionLimit: 7,
      timelineLimit: 9,
      sessionCount: 0,
      timelineCount: 0,
    });
    expect(projectionWriter.writeFor("orchestrator_chat_projection")).toMatchObject({
      fields: { conversationKey: "operator-room", messageCount: 0 },
      sourceCursors: { conversationKey: "operator-room", messageCount: 0 },
    });
  });

  it("serves web route payloads from durable projection read models without rebuilding or rewriting", async () => {
    const durableIssue = issueModelFixture();
    const issueBoard = {
      issues: [durableIssue],
      backlog: [],
      lanes: { todo: [], progress: [durableIssue], review: [] },
      cycleLabel: "Durable cycle",
      cycleDateRange: "May 2026",
      selectedIssueId: "ENG-179",
    };
    const dashboard = {
      projectName: "Durable Symphony",
      repoLabel: "durable/repo",
      branch: "durable-branch",
      workflowLabel: "durable workflow",
      pollLabel: "durable poll",
      agentUsageLabel: "1 agent",
      concurrencyCap: 4,
      providerGates: [],
      runningAgents: [],
      activity: [],
      chat: [],
      totals: { ...emptyTotals(), progress: 1, open: 1, all: 1, completeness: 0 },
    };
    const history = {
      sessions: [
        historySessionFixture({
          id: "durable-session",
          issue: "ENG-179",
          title: "Durable session",
          subtitle: "read model",
          startedAt: "2026-05-31T00:00:00.000Z",
          updatedAt: "2026-05-31T00:00:00.000Z",
          msgCount: 1,
          lastEvent: "done",
          toolCount: 0,
        }),
      ],
      transcriptBySession: {},
      timeline: [],
      defaultSessionId: "durable-session",
    };
    const sidebar = {
      providerGates: [],
      runningAgents: [],
      reviewIssues: [durableIssue],
      activity: [],
      sessions: history.sessions,
      chat: [],
      totals: dashboard.totals,
    };
    const chat = [{ id: "chat-1", who: "agent", text: "served from durable projection", createdAt: "2026-05-31T00:00:00.000Z" }];
    const legacyChat = [{ id: "legacy-chat-1", who: "agent", text: "served from legacy durable array", createdAt: "2026-05-31T00:01:00.000Z" }];
    const chatProjection = {
      schemaVersion: 1,
      conversation: {
        id: "operator-room",
        status: "completed",
        createdAt: "2026-05-31T00:00:00.000Z",
        updatedAt: "2026-05-31T00:00:00.000Z",
        messageCount: chat.length,
        metadata: {},
      },
      state: "completed",
      status: {
        state: "completed",
        conversationStatus: "completed",
        latestMessageStatus: "completed",
        active: false,
        terminal: true,
        empty: false,
        messageCount: chat.length,
        statusCounts: { pending: 0, streaming: 0, completed: 1, failed: 0, disabled: 0, unavailable: 0 },
      },
      chat,
      source: {
        source: "orchestrator_conversations",
        revision: "durable-chat-revision",
        observedAt: "2026-05-31T00:00:00.000Z",
        conversationId: "operator-room",
        latestMessageSequence: 1,
        latestMessageUpdatedAt: "2026-05-31T00:00:00.000Z",
      },
    };
    const sourceFreshness: ProjectionRevisionRecord["sourceFreshness"] = [
      {
        source: "trackerIssues",
        status: "fresh",
        checkedAt: "2026-01-01T00:00:00.000Z",
        revision: "ok:durable",
        lastSuccessAt: "2026-01-01T00:00:00.000Z",
        lastErrorAt: null,
        staleMs: null,
        detail: "Durable tracker source is current",
      },
    ];
    const expectedDashboard = { ...dashboard, agentUsageLabel: "0/4 agents" };
    const projectionReader = new RecordingProjectionReader([
      projectionPayloadRecordFixture(
        { projectionName: "dashboard_projection", scopeKind: "global", scopeKey: "global" },
        dashboard,
        { sourceFreshness },
      ),
      projectionPayloadRecordFixture(
        { projectionName: "issue_board_projection", scopeKind: "board", scopeKey: "default-board" },
        issueBoard,
        { sourceFreshness },
      ),
      projectionPayloadRecordFixture(
        { projectionName: "history_projection", scopeKind: "global_collection", scopeKey: "global:session:100:timeline:250" },
        history,
      ),
      projectionPayloadRecordFixture(
        { projectionName: "sidebar_projection", scopeKind: "global", scopeKey: "global" },
        sidebar,
        { sourceFreshness },
      ),
      projectionPayloadRecordFixture(
        { projectionName: "orchestrator_chat_projection", scopeKind: "conversation", scopeKey: "operator-room" },
        chatProjection,
      ),
      projectionPayloadRecordFixture(
        { projectionName: "orchestrator_chat_projection", scopeKind: "conversation", scopeKey: "legacy-room" },
        legacyChat,
      ),
    ]);
    const projectionWriter = new RecordingProjectionWriter();
    const { server, calls } = createStatusServer(root, { projectionReader, projectionWriter });
    const address = await server.start();
    const baseUrl = baseUrlFor(address);
    try {
      const durableDashboard = await getJson(`${baseUrl}/api/v1/web/dashboard`);
      expect(durableDashboard.body).toEqual(expectedDashboard);
      expect(durableDashboard.response.headers.get("x-symphony-projection-status")).toBe("hit");
      expect(durableDashboard.response.headers.get("x-symphony-projection-cache")).toBe("hit");
      expect(durableDashboard.response.headers.get("x-symphony-projection-name")).toBe("dashboard_projection");
      expect(durableDashboard.response.headers.get("x-symphony-projection-revision")).toBe("1");
      expect(durableDashboard.response.headers.get("x-symphony-projection-build-mode")).toBe("bootstrap");
      expect(headerJson(durableDashboard.response, "x-symphony-projection-source-revisions")).toEqual([]);
      expect(headerJson(durableDashboard.response, "x-symphony-projection-source-freshness")).toEqual(sourceFreshness);
      const durableIssues = await getJson(`${baseUrl}/api/v1/web/issues`);
      expect(durableIssues.body).toEqual(issueBoard);
      expect(durableIssues.response.headers.get("x-symphony-projection-status")).toBe("hit");
      expect(durableIssues.response.headers.get("x-symphony-projection-name")).toBe("issue_board_projection");
      expect(headerJson(durableIssues.response, "x-symphony-projection-source-freshness")).toEqual(sourceFreshness);
      await expect(getJson(`${baseUrl}/api/v1/web/issues/ENG-179`)).resolves.toMatchObject({
        body: { issue: durableIssue, activity: durableIssue.activity, runs: [], transcript: [] },
      });
      await expect(getJson(`${baseUrl}/api/v1/web/history`)).resolves.toMatchObject({ body: history });
      const durableSidebar = await getJson(`${baseUrl}/api/v1/web/sidebar`);
      expect(durableSidebar.body).toEqual(sidebar);
      expect(durableSidebar.response.headers.get("x-symphony-projection-status")).toBe("hit");
      expect(durableSidebar.response.headers.get("x-symphony-projection-name")).toBe("sidebar_projection");
      expect(headerJson(durableSidebar.response, "x-symphony-projection-source-freshness")).toEqual(sourceFreshness);
      await expect(getJson(`${baseUrl}/api/v1/web/orchestrator-chat?conversationId=operator-room`)).resolves.toMatchObject({ body: chatProjection });
      await expect(getJson(`${baseUrl}/api/v1/web/orchestrator-chat?conversationId=legacy-room`)).resolves.toMatchObject({
        body: {
          conversation: { id: "legacy-room", messageCount: legacyChat.length },
          state: "completed",
          status: { state: "completed", messageCount: legacyChat.length },
          chat: legacyChat,
          compatibility: { responseShape: "orchestrator_chat_projection", sourceShape: "legacy_chat_array" },
        },
      });
      const referenceData = await getJson(`${baseUrl}/api/v1/web/reference-data`);
      expect(referenceData.body).toMatchObject({
        labels: { durable: { name: "durable" } },
        users: { Ada: { name: "Ada" }, worker: { name: "worker" } },
      });
    } finally {
      await server.stop();
    }

    expect(calls.snapshot).toBe(4);
    expect(projectionWriter.writes).toEqual([]);
    expect(projectionReader.selectors.map(({ projectionName, scopeKind, scopeKey }) => ({ projectionName, scopeKind, scopeKey }))).toEqual([
      { projectionName: "dashboard_projection", scopeKind: "global", scopeKey: "global" },
      { projectionName: "issue_board_projection", scopeKind: "board", scopeKey: "default-board" },
      { projectionName: "issue_board_projection", scopeKind: "board", scopeKey: "default-board" },
      { projectionName: "history_projection", scopeKind: "global_collection", scopeKey: "global:session:100:timeline:250" },
      { projectionName: "sidebar_projection", scopeKind: "global", scopeKey: "global" },
      { projectionName: "orchestrator_chat_projection", scopeKind: "conversation", scopeKey: "operator-room" },
      { projectionName: "orchestrator_chat_projection", scopeKind: "conversation", scopeKey: "legacy-room" },
      { projectionName: "issue_board_projection", scopeKind: "board", scopeKey: "default-board" },
    ]);
  });

  it("treats stale durable history payloads missing project context attribution as rebuild candidates", async () => {
    const runStore = new RecordingRunStore([
      runRecordFixture({
        runId: "run-history-current",
        sessionId: "session-history-current",
        issueId: "issue-history-current",
        issueIdentifier: "ENG-424",
        updatedAt: "2026-05-31T00:02:00.000Z",
        completedAt: "2026-05-31T00:02:00.000Z",
        status: "succeeded",
      }),
    ]);
    const staleSession = historySessionFixture({
      id: "run-history-current",
      issue: "ENG-424",
      title: "ENG-424: Durable history",
      updatedAt: "2026-05-31T00:02:00.000Z",
      msgCount: 0,
      lastEvent: "legacy durable history",
      toolCount: 0,
    }) as Record<string, unknown>;
    const staleRunSession = staleSession["runSession"] as Record<string, unknown>;
    delete staleSession["projectContext"];
    delete staleRunSession["projectContext"];
    const staleHistory = {
      sessions: [staleSession],
      transcriptBySession: {},
      timeline: [],
      defaultSessionId: "run-history-current",
    };
    const sourceRevisions = [{ source: "runs", revision: "7", observedAt: null }];
    const projectionReader = new RecordingProjectionReader([
      projectionPayloadRecordFixture(
        { projectionName: "history_projection", scopeKind: "global_collection", scopeKey: "global:session:100:timeline:250" },
        staleHistory,
        { sourceRevisions, revision: 6 },
      ),
    ]);
    const projectionWriter = new RecordingProjectionWriter();
    const { server } = createStatusServer(root, {
      projectionReader,
      projectionWriter,
      runStore: runStore.asRunTranscriptStore(),
      webProjectionRevisionProviders: [
        {
          source: "runs",
          getRevision: () => ({ source: "runs", revision: "7", observedAt: null }),
        },
      ],
    });
    const address = await server.start();
    try {
      const history = await getJson(`${baseUrlFor(address)}/api/v1/web/history`);
      expect(history.response.headers.get("x-symphony-projection-status")).toBe("stale");
      expect(history.response.headers.get("x-symphony-projection-cache")).toBe("miss");
      expect(history.body).not.toEqual(staleHistory);
      expect(history.body).toMatchObject({
        defaultSessionId: "run-history-current",
        sessions: [
          {
            id: "run-history-current",
            projectContext: legacyDefaultProjectContext(),
            runSession: { projectContext: legacyDefaultProjectContext() },
          },
        ],
      });
      expect((history.body as { timeline: unknown[] }).timeline).toHaveLength(2);
    } finally {
      await server.stop();
    }

    expect(projectionWriter.writeFor("history_projection").payload).toEqual(
      expect.objectContaining({
        defaultSessionId: "run-history-current",
      }),
    );
    expect(projectionReader.selectors).toEqual([
      { projectionName: "history_projection", scopeKind: "global_collection", scopeKey: "global:session:100:timeline:250" },
    ]);
  });

  it("invalidates stale durable sidebar payloads missing project context attribution", async () => {
    const runStore = new RecordingRunStore([
      runRecordFixture({
        runId: "run-sidebar-current",
        sessionId: "session-sidebar-current",
        issueId: "issue-sidebar-current",
        issueIdentifier: "ENG-424",
        updatedAt: "2026-05-31T00:03:00.000Z",
        completedAt: "2026-05-31T00:03:00.000Z",
        status: "succeeded",
      }),
    ]);
    const staleSession = historySessionFixture({
      id: "run-sidebar-current",
      issue: "ENG-424",
      title: "ENG-424: Durable sidebar",
      updatedAt: "2026-05-31T00:03:00.000Z",
      msgCount: 0,
      lastEvent: "legacy durable sidebar",
      toolCount: 0,
    }) as Record<string, unknown>;
    const staleRunSession = staleSession["runSession"] as Record<string, unknown>;
    delete staleSession["projectContext"];
    delete staleRunSession["projectContext"];
    const staleSidebar = {
      providerGates: [],
      runningAgents: [],
      reviewIssues: [],
      activity: [],
      sessions: [staleSession],
      chat: [],
      totals: emptyTotals(),
    };
    const sourceRevisions = [{ source: "runs", revision: "9", observedAt: null }];
    const projectionReader = new RecordingProjectionReader([
      projectionPayloadRecordFixture(
        { projectionName: "sidebar_projection", scopeKind: "global", scopeKey: "global" },
        staleSidebar,
        { sourceRevisions, revision: 7 },
      ),
    ]);
    const projectionWriter = new RecordingProjectionWriter();
    const { server } = createStatusServer(root, {
      projectionReader,
      projectionWriter,
      runStore: runStore.asRunTranscriptStore(),
      webProjectionRevisionProviders: [
        {
          source: "runs",
          getRevision: () => ({ source: "runs", revision: "9", observedAt: null }),
        },
      ],
    });
    const address = await server.start();
    try {
      const sidebar = await getJson(`${baseUrlFor(address)}/api/v1/web/sidebar`);
      expect(sidebar.response.headers.get("x-symphony-projection-status")).toBe("stale");
      expect(sidebar.response.headers.get("x-symphony-projection-cache")).toBe("miss");
      expect(sidebar.body).not.toEqual(staleSidebar);
      expect(sidebar.body).toMatchObject({
        providerGates: [],
        runningAgents: [],
        reviewIssues: [],
        activity: [],
        sessions: [],
        chat: [],
      });
    } finally {
      await server.stop();
    }

    expect(projectionWriter.writes).toEqual([]);
    expect(projectionReader.selectors).toEqual([{ projectionName: "sidebar_projection", scopeKind: "global", scopeKey: "global" }]);
  });

  it("serves large-volume dashboard, issue board, history, sidebar, and transcript API payloads from durable projections without raw hydration or source-index rebuilds", async () => {
    const issues = Array.from({ length: 360 }, (_, index) => {
      const lane = index % 3 === 0 ? "todo" : index % 3 === 1 ? "progress" : "review";
      return {
        ...issueModelFixture(),
        id: `ENG-${String(1000 + index)}`,
        title: `Large durable issue ${index + 1}`,
        status: lane,
        priority: ((index % 4) + 1) as 1 | 2 | 3 | 4,
        labels: ["durable-large", `team-${index % 12}`],
        assignee: `Ada ${index % 9}`,
        agent: `worker-${index % 5}`,
        activity: Array.from({ length: 3 }, (_, activityIndex) => ({
          id: `activity-${index}-${activityIndex}`,
          verb: activityIndex === 0 ? "run_started" : activityIndex === 1 ? "commented" : "run_completed",
          at: new Date(Date.UTC(2026, 4, 31, 0, index % 60, activityIndex)).toISOString(),
          who: `agent-${index % 5}`,
          extra: `large activity ${activityIndex}`,
        })),
      };
    });
    const historySessions = Array.from({ length: 100 }, (_, index) =>
      historySessionFixture({
        id: `session-large-${index + 1}`,
        issue: `ENG-${1000 + index}`,
        title: `Large durable session ${index + 1}`,
        subtitle: `ENG-${1000 + index} · worker-${index % 5}`,
        startedAt: new Date(Date.UTC(2026, 4, 31, 1, index % 60, 0)).toISOString(),
        updatedAt: new Date(Date.UTC(2026, 4, 31, 2, index % 60, 0)).toISOString(),
        msgCount: 500 + index,
        lastEvent: `large event ${index + 1}`,
        toolCount: index % 7,
        agentId: `worker-${index % 5}`,
      }),
    );
    const historyTimeline = Array.from({ length: 250 }, (_, index) => ({
      id: `timeline-large-${index + 1}`,
      sessionId: historySessions[index % historySessions.length]?.id,
      ts: new Date(Date.UTC(2026, 4, 31, 3, index % 60, index % 60)).toISOString(),
      kind: index % 2 === 0 ? "assistant" : "tool",
      text: `Large durable timeline item ${index + 1}`,
    }));
    const largeTranscript = Array.from({ length: 500 }, (_, index) => {
      const sequence = 9_501 + index;
      return {
        kind: index % 5 === 0 ? ("tool" as const) : ("assistant" as const),
        ts: new Date(Date.UTC(2026, 4, 31, 4, Math.floor(index / 60), index % 60)).toISOString(),
        text: `Durable transcript tail event ${sequence}`,
      };
    });
    const largeRun = runRecordFixture({
      runId: "run-large-1",
      sessionId: "session-large-1",
      issueIdentifier: "ENG-1000",
      workspaceKey: "ENG-1000",
      transcriptEventCount: 10_000,
    });
    const runStore = new FailingTranscriptRunStore([largeRun]);
    const sourceFreshness: ProjectionRevisionRecord["sourceFreshness"] = [
      {
        source: "trackerIssues",
        status: "fresh",
        checkedAt: "2026-01-01T00:00:00.000Z",
        revision: "large-durable-issues",
        lastSuccessAt: "2026-01-01T00:00:00.000Z",
        lastErrorAt: null,
        staleMs: null,
        detail: "Large durable reader fixture is current",
      },
    ];
    const largeSourceRevisions = [{ source: "runStore", revision: runStore.projectionRevision(), observedAt: null }];
    const issueBoard = {
      issues,
      backlog: issues.filter((issue) => issue.status === "todo").slice(0, 60),
      lanes: {
        todo: issues.filter((issue) => issue.status === "todo"),
        progress: issues.filter((issue) => issue.status === "progress"),
        review: issues.filter((issue) => issue.status === "review"),
      },
      cycleLabel: "Large durable cycle",
      cycleDateRange: "May 2026",
      selectedIssueId: "ENG-1000",
    };
    const dashboard = {
      projectName: "Large durable Symphony",
      repoLabel: "durable/large-repo",
      branch: "durable-large-branch",
      workflowLabel: "durable workflow",
      pollLabel: "large durable poll",
      agentUsageLabel: "72 agents",
      concurrencyCap: 72,
      providerGates: [],
      runningAgents: issues.slice(0, 72).map((issue, index) => ({ id: `agent-${index}`, issue: issue.id, status: "running" })),
      activity: issues.flatMap((issue) => issue.activity).slice(0, 250),
      chat: [],
      totals: { ...emptyTotals(), todo: 120, progress: 120, review: 120, open: 360, all: 360, completeness: 33 },
    };
    const history = {
      sessions: historySessions,
      transcriptBySession: {},
      timeline: historyTimeline,
      defaultSessionId: "session-large-1",
    };
    const sidebar = {
      providerGates: [],
      runningAgents: dashboard.runningAgents.slice(0, 40),
      reviewIssues: issueBoard.lanes.review.slice(0, 80),
      activity: dashboard.activity.slice(0, 120),
      sessions: history.sessions.slice(0, 50),
      chat: [],
      totals: dashboard.totals,
    };
    const projectionReader = new RecordingProjectionReader([
      projectionPayloadRecordFixture(
        { projectionName: "dashboard_projection", scopeKind: "global", scopeKey: "global" },
        dashboard,
        { sourceRevisions: largeSourceRevisions, sourceCursors: { issueCount: issues.length, runningAgentCount: dashboard.runningAgents.length, activityCount: dashboard.activity.length }, sourceFreshness, revision: 11 },
      ),
      projectionPayloadRecordFixture(
        { projectionName: "issue_board_projection", scopeKind: "board", scopeKey: "default-board" },
        issueBoard,
        { sourceRevisions: largeSourceRevisions, sourceCursors: { issueCount: issues.length, laneCounts: { todo: 120, progress: 120, review: 120 } }, sourceFreshness, revision: 12 },
      ),
      projectionPayloadRecordFixture(
        { projectionName: "history_projection", scopeKind: "global_collection", scopeKey: "global:session:100:timeline:250" },
        history,
        { sourceRevisions: largeSourceRevisions, sourceCursors: { sessionCount: history.sessions.length, timelineCount: history.timeline.length, totalRuns: issues.length }, revision: 13 },
      ),
      projectionPayloadRecordFixture(
        { projectionName: "sidebar_projection", scopeKind: "global", scopeKey: "global" },
        sidebar,
        { sourceRevisions: largeSourceRevisions, sourceCursors: { sessionCount: sidebar.sessions.length, reviewIssueCount: sidebar.reviewIssues.length, activityCount: sidebar.activity.length }, sourceFreshness, revision: 14 },
      ),
      projectionPayloadRecordFixture(
        { projectionName: "transcript_projection", scopeKind: "run_page", scopeKey: "run-large-1:offset:9500:limit:500" },
        largeTranscript,
        {
          sourceRevisions: largeSourceRevisions,
          sourceCursors: {
            runId: "run-large-1",
            sessionId: "session-large-1",
            offset: 9_500,
            limit: 500,
            eventCount: largeTranscript.length,
            nextOffset: null,
            firstSequence: 9_501,
            lastSequence: 10_000,
          },
          revision: 15,
        },
      ),
    ]);
    const expectedDashboard = { ...dashboard, agentUsageLabel: "0/72 agents", runningAgents: [] };
    const expectedSidebar = { ...sidebar, runningAgents: [] };
    const projectionWriter = new RecordingProjectionWriter();
    let contextBuilds = 0;
    const { server, calls } = createStatusServer(root, {
      projectionReader,
      projectionWriter,
      runStore: runStore.asRunTranscriptStore(),
      webProjectionContextBuilder: () => {
        contextBuilds += 1;
        throw new Error("large durable reader route must not rebuild the broad web projection source index");
      },
    });
    const address = await server.start();
    const baseUrl = baseUrlFor(address);
    const expectProjectionHeaders = (
      response: Response,
      expected: { name: DurableProjectionName; scopeKind: string; scopeKey: string; sourceCursors: Record<string, unknown> },
    ) => {
      expect(response.headers.get("x-symphony-projection-status")).toBe("hit");
      expect(response.headers.get("x-symphony-projection-cache")).toBe("hit");
      expect(response.headers.get("x-symphony-projection-name")).toBe(expected.name);
      expect(response.headers.get("x-symphony-projection-scope-kind")).toBe(expected.scopeKind);
      expect(response.headers.get("x-symphony-projection-scope-key")).toBe(expected.scopeKey);
      expect(headerJson(response, "x-symphony-projection-source-cursors")).toMatchObject(expected.sourceCursors);
    };

    try {
      const durableDashboard = await getJson(`${baseUrl}/api/v1/web/dashboard`);
      expect(durableDashboard.body).toEqual(expectedDashboard);
      expect((durableDashboard.body as { activity: unknown[] }).activity).toHaveLength(250);
      expectProjectionHeaders(durableDashboard.response, {
        name: "dashboard_projection",
        scopeKind: "global",
        scopeKey: "global",
        sourceCursors: { issueCount: 360, runningAgentCount: 72, activityCount: 250 },
      });

      const durableIssues = await getJson(`${baseUrl}/api/v1/web/issues`);
      expect(durableIssues.body).toEqual(issueBoard);
      expect((durableIssues.body as { issues: unknown[] }).issues).toHaveLength(360);
      expectProjectionHeaders(durableIssues.response, {
        name: "issue_board_projection",
        scopeKind: "board",
        scopeKey: "default-board",
        sourceCursors: { issueCount: 360, laneCounts: { todo: 120, progress: 120, review: 120 } },
      });

      const durableHistory = await getJson(`${baseUrl}/api/v1/web/history`);
      expect(durableHistory.body).toEqual(history);
      expect((durableHistory.body as { sessions: unknown[] }).sessions).toHaveLength(100);
      expect((durableHistory.body as { timeline: unknown[] }).timeline).toHaveLength(250);
      expectProjectionHeaders(durableHistory.response, {
        name: "history_projection",
        scopeKind: "global_collection",
        scopeKey: "global:session:100:timeline:250",
        sourceCursors: { sessionCount: 100, timelineCount: 250, totalRuns: 360 },
      });

      const durableSidebar = await getJson(`${baseUrl}/api/v1/web/sidebar`);
      expect(durableSidebar.body).toEqual(expectedSidebar);
      expect((durableSidebar.body as { reviewIssues: unknown[] }).reviewIssues).toHaveLength(80);
      expectProjectionHeaders(durableSidebar.response, {
        name: "sidebar_projection",
        scopeKind: "global",
        scopeKey: "global",
        sourceCursors: { sessionCount: 50, reviewIssueCount: 80, activityCount: 120 },
      });

      const durableTranscript = await getJson(`${baseUrl}/api/v1/web/sessions/session-large-1/transcript`);
      expectTranscriptWindowPayload(durableTranscript.body, largeTranscript, { kind: "tail", limit: 500 });
      const durableTranscriptMessages = (durableTranscript.body as { messages: Array<{ text: string }> }).messages;
      expect(durableTranscriptMessages).toHaveLength(500);
      expect(durableTranscriptMessages[0]).toMatchObject({ text: "Durable transcript tail event 9501" });
      expect(durableTranscriptMessages.at(-1)).toMatchObject({ text: "Durable transcript tail event 10000" });
      expectProjectionHeaders(durableTranscript.response, {
        name: "transcript_projection",
        scopeKind: "run_page",
        scopeKey: "run-large-1:offset:9500:limit:500",
        sourceCursors: { runId: "run-large-1", sessionId: "session-large-1", offset: 9_500, limit: 500, eventCount: 500, nextOffset: null },
      });
    } finally {
      await server.stop();
    }

    expect(contextBuilds).toBe(0);
    expect(calls).toEqual({ snapshot: 3, getIssueDetails: 0, refreshNow: 0, pauseIssue: 0, resumeIssue: 0, cancelIssue: 0 });
    expect(runStore.transcriptReadCount).toBe(0);
    expect(projectionWriter.writes).toEqual([]);
    expect(projectionReader.selectors.map(({ projectionName, scopeKind, scopeKey }) => ({ projectionName, scopeKind, scopeKey }))).toEqual([
      { projectionName: "dashboard_projection", scopeKind: "global", scopeKey: "global" },
      { projectionName: "issue_board_projection", scopeKind: "board", scopeKey: "default-board" },
      { projectionName: "history_projection", scopeKind: "global_collection", scopeKey: "global:session:100:timeline:250" },
      { projectionName: "sidebar_projection", scopeKind: "global", scopeKey: "global" },
      { projectionName: "transcript_projection", scopeKind: "run_page", scopeKey: "run-large-1:offset:9500:limit:500" },
    ]);
  });

  it("serves reducer-shaped orchestrator chat projections with per-conversation freshness checks", async () => {
    const conversationStore = new FileOrchestratorConversationStore(path.join(root, "chat-state"));
    await conversationStore.appendMessage({
      id: "chat-1",
      conversationId: "operator-room",
      role: "assistant",
      body: "served from reducer projection",
      status: "completed",
      at: "2026-05-31T00:00:00.000Z",
    });
    const projectionPayload = projectOrchestratorChatProjectionPayload(
      await conversationStore.getConversation("operator-room"),
      "operator-room",
    );
    const projectionReader = new RecordingProjectionReader([
      projectionPayloadRecordFixture(
        { projectionName: "orchestrator_chat_projection", scopeKind: "conversation", scopeKey: "operator-room" },
        projectionPayload,
        {
          sourceRevisions: [
            {
              source: "orchestrator_conversations:operator-room",
              revision: projectionPayload.source.revision,
              observedAt: projectionPayload.source.observedAt,
            },
          ],
        },
      ),
    ]);
    const projectionWriter = new RecordingProjectionWriter();
    const { server } = createStatusServer(root, {
      orchestratorConversationStore: conversationStore,
      projectionReader,
      projectionWriter,
    });
    const address = await server.start();
    const url = `${baseUrlFor(address)}/api/v1/web/orchestrator-chat?conversationId=operator-room`;

    try {
      const current = await getJson(url);
      expect(current.response.status).toBe(200);
      expect(current.response.headers.get("x-symphony-projection-status")).toBe("hit");
      expect(current.body).toEqual(projectionPayload);
      expect(headerJson(current.response, "x-symphony-projection-source-revisions")).toEqual([
        {
          source: "orchestrator_conversations:operator-room",
          revision: projectionPayload.source.revision,
          observedAt: projectionPayload.source.observedAt,
        },
      ]);

      await conversationStore.appendMessage({
        id: "chat-2",
        conversationId: "operator-room",
        role: "assistant",
        body: "newer chat not in the stale durable projection",
        status: "completed",
        at: "2026-05-31T00:01:00.000Z",
      });
      const stale = await getJson(url);
      expect(stale.response.status).toBe(200);
      expect(stale.response.headers.get("x-symphony-projection-status")).toBe("stale");
      expect(stale.response.headers.get("x-symphony-projection-cache")).toBe("miss");
      expect(stale.body).toMatchObject({
        conversation: { id: "operator-room", status: "unavailable", messageCount: 0 },
        state: "unavailable",
        status: { state: "unavailable", empty: true, messageCount: 0 },
        chat: [],
        compatibility: { responseShape: "orchestrator_chat_projection", sourceShape: "fallback" },
      });
    } finally {
      await server.stop();
    }

    expect(projectionWriter.writes).toEqual([]);
    expect(projectionReader.selectors.map(({ projectionName, scopeKind, scopeKey }) => ({ projectionName, scopeKind, scopeKey }))).toEqual([
      { projectionName: "orchestrator_chat_projection", scopeKind: "conversation", scopeKey: "operator-room" },
      { projectionName: "orchestrator_chat_projection", scopeKind: "conversation", scopeKey: "operator-room" },
    ]);
  });

  it("preserves reducer state metadata for empty, active, failed, disabled, unavailable, and restart readback GET projections", async () => {
    const stateDir = path.join(root, "chat-state-matrix");
    const writerStore = new FileOrchestratorConversationStore(stateDir);
    await writerStore.createConversation({ conversationId: "empty-room", status: "completed", at: "2026-06-03T00:00:00.000Z" });
    await writerStore.createConversation({ conversationId: "pending-room", status: "pending", at: "2026-06-03T00:01:00.000Z" });
    await writerStore.createConversation({ conversationId: "streaming-room", status: "streaming", at: "2026-06-03T00:02:00.000Z" });
    await writerStore.createConversation({ conversationId: "failed-room", status: "failed", at: "2026-06-03T00:03:00.000Z" });
    await writerStore.createConversation({ conversationId: "disabled-room", status: "disabled", at: "2026-06-03T00:04:00.000Z" });
    await writerStore.createConversation({ conversationId: "unavailable-room", status: "unavailable", at: "2026-06-03T00:05:00.000Z" });
    await writerStore.appendMessage({
      id: "restart-chat-1",
      conversationId: "restart-room",
      role: "assistant",
      body: "durable chat survives restart",
      status: "completed",
      at: "2026-06-03T00:06:00.000Z",
    });
    const cases = [
      { conversationId: "empty-room", state: "empty", messageCount: 0, latestMessageStatus: null },
      { conversationId: "pending-room", state: "pending", messageCount: 0, latestMessageStatus: null },
      { conversationId: "streaming-room", state: "streaming", messageCount: 0, latestMessageStatus: null },
      { conversationId: "failed-room", state: "failed", messageCount: 0, latestMessageStatus: null },
      { conversationId: "disabled-room", state: "disabled", messageCount: 0, latestMessageStatus: null },
      { conversationId: "unavailable-room", state: "unavailable", messageCount: 0, latestMessageStatus: null },
      { conversationId: "restart-room", state: "completed", messageCount: 1, latestMessageStatus: "completed" },
    ] as const;
    const projectionPayloads = await Promise.all(
      cases.map(async ({ conversationId }) =>
        projectOrchestratorChatProjectionPayload(await writerStore.getConversation(conversationId), conversationId),
      ),
    );
    const restartedStore = new FileOrchestratorConversationStore(stateDir);
    const projectionReader = new RecordingProjectionReader(
      projectionPayloads.map((payload) =>
        projectionPayloadRecordFixture(
          { projectionName: "orchestrator_chat_projection", scopeKind: "conversation", scopeKey: payload.conversation.id },
          payload,
          {
            sourceRevisions: [
              {
                source: `orchestrator_conversations:${payload.conversation.id}`,
                revision: payload.source.revision,
                observedAt: payload.source.observedAt,
              },
            ],
          },
        ),
      ),
    );
    const projectionWriter = new RecordingProjectionWriter();
    const { server } = createStatusServer(root, {
      orchestratorConversationStore: restartedStore,
      projectionReader,
      projectionWriter,
    });
    const address = await server.start();
    const baseUrl = baseUrlFor(address);

    try {
      for (const [index, testCase] of cases.entries()) {
        const payload = projectionPayloads[index]!;
        const result = await getJson(`${baseUrl}/api/v1/web/orchestrator-chat?conversationId=${testCase.conversationId}`);
        expect(result.response.headers.get("x-symphony-projection-status")).toBe("hit");
        expect(result.body).toEqual(payload);
        const body = result.body as typeof payload;
        expect(body).toMatchObject({
          conversation: { id: testCase.conversationId, messageCount: testCase.messageCount },
          state: testCase.state,
          status: {
            state: testCase.state,
            latestMessageStatus: testCase.latestMessageStatus,
            messageCount: testCase.messageCount,
            empty: testCase.messageCount === 0,
          },
        });
        if (testCase.messageCount === 0) expect(body.chat).toEqual([]);
        expect(JSON.stringify(body.chat)).not.toMatch(/fake|placeholder|mock/i);
      }
    } finally {
      await server.stop();
    }

    expect(projectionWriter.writes).toEqual([]);
    expect(projectionReader.selectors.map(({ scopeKey }) => scopeKey)).toEqual(cases.map(({ conversationId }) => conversationId));
  });

  it("returns explicit durable miss responses without broad source-index rebuilds when projection rows are absent", async () => {
    const projectionReader = new RecordingProjectionReader([]);
    const projectionWriter = new RecordingProjectionWriter();
    let contextBuilds = 0;
    const { server, calls } = createStatusServer(root, {
      projectionReader,
      projectionWriter,
      webProjectionContextBuilder: () => {
        contextBuilds += 1;
        throw new Error("cold durable miss must not rebuild the broad web projection source index");
      },
    });
    const address = await server.start();
    const baseUrl = baseUrlFor(address);

    try {
      const dashboard = await getJson(`${baseUrl}/api/v1/web/dashboard`);
      expect(dashboard.response.status).toBe(200);
      expect(dashboard.response.headers.get("x-symphony-projection-status")).toBe("missing");
      expect(dashboard.body).toMatchObject({ projectName: "Symphony", agentUsageLabel: "0 agents" });

      const issues = await getJson(`${baseUrl}/api/v1/web/issues`);
      expect(issues.response.status).toBe(200);
      expect(issues.response.headers.get("x-symphony-projection-status")).toBe("missing");
      expect(issues.body).toEqual({
        issues: [],
        backlog: [],
        lanes: { todo: [], progress: [], review: [] },
        cycleLabel: "",
        cycleDateRange: "",
        selectedIssueId: "",
      });

      const detail = await getJson(`${baseUrl}/api/v1/web/issues/ENG-404`);
      expect(detail.response.status).toBe(200);
      expect(detail.response.headers.get("x-symphony-projection-status")).toBe("missing");
      expect(detail.body).toBeNull();

      const sidebar = await getJson(`${baseUrl}/api/v1/web/sidebar`);
      expect(sidebar.response.status).toBe(200);
      expect(sidebar.response.headers.get("x-symphony-projection-status")).toBe("missing");
      expect(sidebar.body).toMatchObject({
        providerGates: [],
        runningAgents: [],
        reviewIssues: [],
        activity: [],
        sessions: [],
        chat: [],
      });

      const chat = await getJson(`${baseUrl}/api/v1/web/orchestrator-chat?conversationId=operator-room`);
      expect(chat.response.status).toBe(200);
      expect(chat.response.headers.get("x-symphony-projection-status")).toBe("missing");
      expect(chat.body).toMatchObject({
        conversation: { id: "operator-room", status: "unavailable", messageCount: 0 },
        state: "unavailable",
        status: { state: "unavailable", empty: true, messageCount: 0 },
        chat: [],
        compatibility: { responseShape: "orchestrator_chat_projection", sourceShape: "fallback" },
      });
    } finally {
      await server.stop();
    }

    expect(contextBuilds).toBe(0);
    expect(calls.snapshot).toBe(0);
    expect(projectionWriter.writes).toEqual([]);
    expect(projectionReader.selectors.map(({ projectionName, scopeKind, scopeKey }) => ({ projectionName, scopeKind, scopeKey }))).toEqual([
      { projectionName: "dashboard_projection", scopeKind: "global", scopeKey: "global" },
      { projectionName: "issue_board_projection", scopeKind: "board", scopeKey: "default-board" },
      { projectionName: "issue_board_projection", scopeKind: "board", scopeKey: "default-board" },
      { projectionName: "sidebar_projection", scopeKind: "global", scopeKey: "global" },
      { projectionName: "orchestrator_chat_projection", scopeKind: "conversation", scopeKey: "operator-room" },
    ]);
  });

  it("rebuilds dashboard, issue board, and sidebar projections through the explicit rebuild path", async () => {
    const projectionWriter = new RecordingProjectionWriter();
    const { server } = createStatusServer(root, { projectionWriter });

    const result = await server.rebuildDurableWebProjections({
      projections: ["dashboard_projection", "issue_board_projection", "sidebar_projection"],
    });

    expect(result).toMatchObject({ attempted: 3, written: 3, unchanged: 0, skipped: 0, failed: 0 });
    expect(result.entries.map(({ projectionName, scopeKind, scopeKey, status }) => ({ projectionName, scopeKind, scopeKey, status }))).toEqual([
      { projectionName: "dashboard_projection", scopeKind: "global", scopeKey: "global", status: "written" },
      { projectionName: "issue_board_projection", scopeKind: "board", scopeKey: "default-board", status: "written" },
      { projectionName: "sidebar_projection", scopeKind: "global", scopeKey: "global", status: "written" },
    ]);
    expect(projectionWriter.writes.map(({ projectionName }) => projectionName)).toEqual([
      "dashboard_projection",
      "issue_board_projection",
      "sidebar_projection",
    ]);
  });

  it("rebuilds route durable projections on force-refresh when a reader and writer are configured", async () => {
    const projectionReader = new RecordingProjectionReader([]);
    const projectionWriter = new RecordingProjectionWriter();
    const { server } = createStatusServer(root, { projectionReader, projectionWriter });
    const address = await server.start();
    const baseUrl = baseUrlFor(address);
    try {
      const dashboard = await getJson(`${baseUrl}/api/v1/web/dashboard?refresh=true`);
      expect(dashboard.response.headers.get("x-symphony-projection-status")).toBe("refresh_bypass");
      expect(dashboard.body).toMatchObject({ projectName: "Symphony" });

      const issues = await getJson(`${baseUrl}/api/v1/web/issues?refresh=true`);
      expect(issues.response.headers.get("x-symphony-projection-status")).toBe("refresh_bypass");
      expect(issues.body).toMatchObject({ issues: [], lanes: { todo: [], progress: [], review: [] } });

      const history = await getJson(`${baseUrl}/api/v1/web/history?refresh=true`);
      expect(history.response.headers.get("x-symphony-projection-status")).toBe("refresh_bypass");
      expect(history.body).toMatchObject({ sessions: [], timeline: [] });

      const sidebar = await getJson(`${baseUrl}/api/v1/web/sidebar?refresh=true`);
      expect(sidebar.response.headers.get("x-symphony-projection-status")).toBe("refresh_bypass");
      expect(sidebar.body).toMatchObject({ runningAgents: [], reviewIssues: [], sessions: [] });

      const chat = await getJson(`${baseUrl}/api/v1/web/orchestrator-chat?refresh=true&conversationId=operator-room`);
      expect(chat.response.headers.get("x-symphony-projection-status")).toBe("refresh_bypass");
      expect(chat.body).toMatchObject({
        conversation: { id: "operator-room", status: "completed", messageCount: 0 },
        state: "empty",
        status: { state: "empty", empty: true, messageCount: 0 },
        chat: [],
      });
    } finally {
      await server.stop();
    }

    expect(projectionReader.selectors).toEqual([]);
    expect(projectionWriter.writes.map(({ projectionName }) => projectionName)).toEqual([
      "dashboard_projection",
      "issue_board_projection",
      "history_projection",
      "sidebar_projection",
      "orchestrator_chat_projection",
    ]);
  });

  it("serves issue detail and transcript payloads from durable projections with route-specific freshness checks", async () => {
    const durableIssue = issueModelFixture();
    const issueBoard = {
      issues: [durableIssue],
      backlog: [],
      lanes: { todo: [], progress: [durableIssue], review: [] },
      cycleLabel: "Durable cycle",
      cycleDateRange: "May 2026",
      selectedIssueId: "ENG-179",
    };
    const transcriptEvents: TranscriptEvent[] = [
      {
        runId: "run-1",
        sequence: 1,
        at: "2026-05-31T00:00:30.000Z",
        source: "runtime",
        eventType: "assistant_complete",
        message: "served from durable issue detail transcript",
      },
    ];
    const run = runRecordFixture({
      runId: "run-1",
      sessionId: "session-1",
      cursorModel: "gpt-5-durable",
      transcriptEventCount: transcriptEvents.length,
    });
    const durableTranscript = [{ kind: "assistant" as const, ts: "2026-05-31T00:00:00.000Z", text: "served from durable transcript" }];
    const runStore = new RecordingRunStore([run], { "run-1": transcriptEvents });
    const transcriptSourceRevisions = [
      { source: "runs", revision: runStore.projectionRevision(), observedAt: null },
      { source: "transcript:run-1", revision: "1:1:2026-05-31T00:00:00.000Z", observedAt: "2026-05-31T00:00:00.000Z" },
    ];
    const runtimeProviders: WebProjectionRevisionProvider[] = [
      { source: "lifecycleStore", getRevision: () => ({ source: "lifecycleStore", revision: "lifecycle-current", observedAt: null }) },
      { source: "writebackOutbox", getRevision: () => ({ source: "writebackOutbox", revision: "writeback-current", observedAt: null }) },
      {
        source: "orchestrator_conversations",
        getRevision: () => ({ source: "orchestrator_conversations", revision: "chat-current", observedAt: null }),
      },
    ];
    const projectionReader = new RecordingProjectionReader([
      projectionPayloadRecordFixture(
        { projectionName: "issue_board_projection", scopeKind: "board", scopeKey: "default-board" },
        issueBoard,
        {
          sourceRevisions: [
            { source: "runStore", revision: runStore.projectionRevision(), observedAt: null },
            { source: "lifecycleStore", revision: "lifecycle-current", observedAt: null },
            { source: "writebackOutbox", revision: "writeback-current", observedAt: null },
            { source: "orchestrator_conversations", revision: "chat-current", observedAt: null },
          ],
        },
      ),
      projectionPayloadRecordFixture(
        { projectionName: "transcript_projection", scopeKind: "run_page", scopeKey: "run-1:offset:0:limit:500" },
        durableTranscript,
        { sourceRevisions: transcriptSourceRevisions },
      ),
    ]);
    const projectionWriter = new RecordingProjectionWriter();
    const { server, calls } = createStatusServer(root, {
      projectionReader,
      projectionWriter,
      runStore: runStore.asRunTranscriptStore(),
      webProjectionRevisionProviders: runtimeProviders,
    });
    const address = await server.start();
    const baseUrl = baseUrlFor(address);
    try {
      const detail = await getJson(`${baseUrl}/api/v1/web/issues/ENG-179`);
      expect(detail.body).toMatchObject({ issue: durableIssue, transcript: [] });
      expect((detail.body as { activity: unknown[] }).activity).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ verb: "run_started", id: "ENG-179", extra: "succeeded", who: "agent-1" }),
          expect.objectContaining({ verb: "run_completed", id: "ENG-179", extra: "succeeded", who: "agent-1" }),
        ]),
      );
      expect((detail.body as { activity: unknown[] }).activity).toHaveLength(2);
      expect((detail.body as { runs: unknown[] }).runs).toEqual([
        expect.objectContaining({ id: "session-1", issue: "ENG-179", state: "succeeded", model: "gpt-5-durable", msgCount: 1 }),
      ]);
      expect(detail.response.headers.get("x-symphony-projection-status")).toBe("hit");
      expect(runStore.transcriptReadCount).toBe(0);

      const detailWithTranscript = await getJson(`${baseUrl}/api/v1/web/issues/ENG-179?includeTranscript=1`);
      expect((detailWithTranscript.body as { activity: unknown[] }).activity).toEqual((detail.body as { activity: unknown[] }).activity);
      expect((detailWithTranscript.body as { runs: unknown[] }).runs).toEqual((detail.body as { runs: unknown[] }).runs);
      expect((detailWithTranscript.body as { transcript: unknown[] }).transcript).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "system", model: "gpt-5-durable", workspace: "ENG-179", session: "session-1" }),
          expect.objectContaining({ kind: "assistant", text: "served from durable issue detail transcript" }),
        ]),
      );
      expect((detailWithTranscript.body as { transcript: unknown[] }).transcript).toHaveLength(3);
      expect(detailWithTranscript.response.headers.get("x-symphony-projection-status")).toBe("hit");

      const transcript = await getJson(`${baseUrl}/api/v1/web/sessions/session-1/transcript`);
      expectTranscriptWindowPayload(transcript.body, durableTranscript, { kind: "tail", limit: 500 });
      expect(transcript.response.headers.get("x-symphony-projection-status")).toBe("hit");
      expect(transcript.response.headers.get("x-symphony-projection-cache")).toBe("hit");
      expect(JSON.parse(decodeURIComponent(transcript.response.headers.get("x-symphony-projection-source-revisions") ?? "[]"))).toEqual(
        transcriptSourceRevisions,
      );
    } finally {
      await server.stop();
    }

    expect(calls).toEqual({ snapshot: 2, getIssueDetails: 0, refreshNow: 0, pauseIssue: 0, resumeIssue: 0, cancelIssue: 0 });
    expect(runStore.transcriptReadCount).toBe(1);
    expect(projectionWriter.writes).toEqual([]);
    expect(projectionReader.selectors.map(({ projectionName, scopeKind, scopeKey }) => ({ projectionName, scopeKind, scopeKey }))).toEqual([
      { projectionName: "issue_board_projection", scopeKind: "board", scopeKey: "default-board" },
      { projectionName: "issue_board_projection", scopeKind: "board", scopeKey: "default-board" },
      { projectionName: "transcript_projection", scopeKind: "run_page", scopeKey: "run-1:offset:0:limit:500" },
    ]);
  });

  it("serves contextual issue-detail payloads from durable board projections without losing raw run associations", async () => {
    const docsProjectContext = {
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      linearProjectSlug: "DOCS",
      routingSource: "candidate_poll",
    } as const;
    const durableIssue = {
      ...issueModelFixture(),
      id: "docs:ENG-179",
      title: "Serve contextual durable web projections",
      project: "Documentation Site",
    };
    const issueBoard = {
      issues: [durableIssue],
      backlog: [],
      lanes: { todo: [], progress: [durableIssue], review: [] },
      cycleLabel: "Docs cycle",
      cycleDateRange: "May 2026",
      selectedIssueId: "docs:ENG-179",
    };
    const transcriptEvents: TranscriptEvent[] = [
      {
        runId: "run-docs-1",
        sequence: 1,
        at: "2026-05-31T00:00:31.000Z",
        source: "runtime",
        eventType: "assistant_complete",
        message: "served from contextual durable issue detail transcript",
      },
    ];
    const run = runRecordFixture({
      runId: "run-docs-1",
      sessionId: "session-docs-1",
      issueId: "issue-docs-179",
      issueIdentifier: "ENG-179",
      workspaceKey: "ENG-179",
      projectContext: docsProjectContext,
      cursorModel: "gpt-5-durable-docs",
      transcriptEventCount: transcriptEvents.length,
    });
    const durableTranscript = [
      { kind: "assistant" as const, ts: "2026-05-31T00:00:00.000Z", text: "served from contextual durable transcript" },
    ];
    const runStore = new RecordingRunStore([run], { "run-docs-1": transcriptEvents });
    const projectionReader = new RecordingProjectionReader([
      projectionPayloadRecordFixture(
        { projectionName: "issue_board_projection", scopeKind: "board", scopeKey: "default-board" },
        issueBoard,
        {
          sourceRevisions: [
            { source: "runStore", revision: runStore.projectionRevision(), observedAt: null },
            { source: "lifecycleStore", revision: "lifecycle-current", observedAt: null },
            { source: "writebackOutbox", revision: "writeback-current", observedAt: null },
            { source: "orchestrator_conversations", revision: "chat-current", observedAt: null },
          ],
        },
      ),
      projectionPayloadRecordFixture(
        { projectionName: "transcript_projection", scopeKind: "run_page", scopeKey: "run-docs-1:offset:0:limit:500" },
        durableTranscript,
      ),
    ]);
    const { server, calls } = createStatusServer(root, {
      projectionReader,
      runStore: runStore.asRunTranscriptStore(),
      defaultProjectContextId: "symphony",
    });
    const address = await server.start();
    const baseUrl = baseUrlFor(address);
    try {
      const detail = await getJson(`${baseUrl}/api/v1/web/issues/docs:ENG-179`);
      expect(detail.body).toMatchObject({ issue: durableIssue, transcript: [] });
      expect((detail.body as { activity: unknown[] }).activity).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ verb: "run_started", id: "ENG-179", extra: "succeeded", who: "agent-1" }),
          expect.objectContaining({ verb: "run_completed", id: "ENG-179", extra: "succeeded", who: "agent-1" }),
        ]),
      );
      expect((detail.body as { runs: unknown[] }).runs).toEqual([
        expect.objectContaining({ id: "session-docs-1", issue: "ENG-179", state: "succeeded", model: "gpt-5-durable-docs", msgCount: 1 }),
      ]);
      expect(detail.response.headers.get("x-symphony-projection-status")).toBe("hit");

      const detailWithTranscript = await getJson(`${baseUrl}/api/v1/web/issues/docs:ENG-179?includeTranscript=1`);
      expect((detailWithTranscript.body as { runs: unknown[] }).runs).toEqual((detail.body as { runs: unknown[] }).runs);
      expect((detailWithTranscript.body as { transcript: unknown[] }).transcript).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "system", model: "gpt-5-durable-docs", workspace: "ENG-179", session: "session-docs-1" }),
          expect.objectContaining({ kind: "assistant", text: "served from contextual durable issue detail transcript" }),
        ]),
      );
      expect(detailWithTranscript.response.headers.get("x-symphony-projection-status")).toBe("hit");
    } finally {
      await server.stop();
    }

    expect(calls).toEqual({ snapshot: 2, getIssueDetails: 0, refreshNow: 0, pauseIssue: 0, resumeIssue: 0, cancelIssue: 0 });
    expect(runStore.transcriptReadCount).toBe(1);
    expect(projectionReader.selectors.map(({ projectionName, scopeKind, scopeKey }) => ({ projectionName, scopeKind, scopeKey }))).toEqual([
      { projectionName: "issue_board_projection", scopeKind: "board", scopeKey: "default-board" },
      { projectionName: "issue_board_projection", scopeKind: "board", scopeKey: "default-board" },
    ]);
  });

  it("keeps unresolved contextual durable detail aliases isolated from raw runs in other project contexts", async () => {
    const durableIssue = {
      ...issueModelFixture(),
      id: "docs:ENG-179",
      title: "Serve contextual durable web projections",
      project: "Documentation Site",
    };
    const issueBoard = {
      issues: [durableIssue],
      backlog: [],
      lanes: { todo: [], progress: [durableIssue], review: [] },
      cycleLabel: "Docs cycle",
      cycleDateRange: "May 2026",
      selectedIssueId: "docs:ENG-179",
    };
    const otherContextRun = runRecordFixture({
      runId: "run-default-1",
      sessionId: "session-default-1",
      issueId: "issue-default-179",
      issueIdentifier: "ENG-179",
      workspaceKey: "ENG-179",
      cursorModel: "gpt-5-default",
      transcriptEventCount: 1,
    });
    const runStore = new RecordingRunStore(
      [otherContextRun],
      {
        "run-default-1": [
          {
            runId: "run-default-1",
            sequence: 1,
            at: "2026-05-31T00:00:30.000Z",
            source: "runtime",
            eventType: "assistant_complete",
            message: "must not leak across project contexts",
          },
        ],
      },
    );
    const projectionReader = new RecordingProjectionReader([
      projectionPayloadRecordFixture(
        { projectionName: "issue_board_projection", scopeKind: "board", scopeKey: "default-board" },
        issueBoard,
        {
          sourceRevisions: [
            { source: "runStore", revision: runStore.projectionRevision(), observedAt: null },
            { source: "lifecycleStore", revision: "lifecycle-current", observedAt: null },
            { source: "writebackOutbox", revision: "writeback-current", observedAt: null },
            { source: "orchestrator_conversations", revision: "chat-current", observedAt: null },
          ],
        },
      ),
    ]);
    const { server, calls } = createStatusServer(root, {
      projectionReader,
      runStore: runStore.asRunTranscriptStore(),
      defaultProjectContextId: "symphony",
    });
    const address = await server.start();
    const baseUrl = baseUrlFor(address);
    try {
      const detail = await getJson(`${baseUrl}/api/v1/web/issues/docs:ENG-179`);
      expect(detail.response.status).toBe(200);
      expect(detail.response.headers.get("x-symphony-projection-status")).toBe("hit");
      expect(detail.body).toMatchObject({ issue: durableIssue, activity: [], runs: [], transcript: [] });

      const detailWithTranscript = await getJson(`${baseUrl}/api/v1/web/issues/docs:ENG-179?includeTranscript=1`);
      expect(detailWithTranscript.response.status).toBe(200);
      expect(detailWithTranscript.response.headers.get("x-symphony-projection-status")).toBe("hit");
      expect(detailWithTranscript.body).toMatchObject({ issue: durableIssue, activity: [], runs: [], transcript: [] });
    } finally {
      await server.stop();
    }

    expect(calls).toEqual({ snapshot: 2, getIssueDetails: 0, refreshNow: 0, pauseIssue: 0, resumeIssue: 0, cancelIssue: 0 });
    expect(runStore.transcriptReadCount).toBe(0);
    expect(projectionReader.selectors.map(({ projectionName, scopeKind, scopeKey }) => ({ projectionName, scopeKind, scopeKey }))).toEqual([
      { projectionName: "issue_board_projection", scopeKind: "board", scopeKey: "default-board" },
      { projectionName: "issue_board_projection", scopeKind: "board", scopeKey: "default-board" },
    ]);
  });

  it("serves direct run-id transcript payloads from durable projections when the raw run store is unavailable", async () => {
    const defaultTranscript = Array.from({ length: 500 }, (_, index) => {
      const sequence = index + 701;
      return {
        kind: "assistant" as const,
        ts: new Date(Date.UTC(2026, 4, 31, 0, 0, index)).toISOString(),
        text: `default tail event ${sequence}`,
      };
    });
    const pagedTranscript = [
      { kind: "tool" as const, ts: "2026-05-31T00:00:03.000Z", text: "explicit page from durable transcript" },
    ];
    const projectionReader = new RecordingProjectionReader([
      projectionPayloadRecordFixture(
        { projectionName: "transcript_projection", scopeKind: "run_page", scopeKey: "run-1:offset:700:limit:500" },
        defaultTranscript,
      ),
      projectionPayloadRecordFixture(
        { projectionName: "transcript_projection", scopeKind: "run_page", scopeKey: "run-1:offset:2:limit:3" },
        pagedTranscript,
      ),
    ]);
    const projectionWriter = new RecordingProjectionWriter();
    const { server, calls } = createStatusServer(root, { projectionReader, projectionWriter });
    const address = await server.start();
    const baseUrl = baseUrlFor(address);
    try {
      const defaultPage = await getJson(`${baseUrl}/api/v1/web/sessions/run-1/transcript`);
      expectTranscriptWindowPayload(defaultPage.body, defaultTranscript, { kind: "tail", limit: 500 });
      expect(defaultPage.response.headers.get("x-symphony-projection-status")).toBe("hit");
      expect(defaultPage.response.headers.get("x-symphony-projection-cache")).toBe("hit");
      expect(defaultPage.response.headers.get("x-symphony-projection-scope-key")).toBe("run-1:offset:700:limit:500");
      const defaultMessages = (defaultPage.body as { messages: Array<{ text: string }> }).messages;
      expect(defaultMessages[0]).toMatchObject({ text: "default tail event 701" });
      expect(defaultMessages.at(-1)).toMatchObject({ text: "default tail event 1200" });
      expect(defaultMessages).toHaveLength(500);

      const explicitPage = await getJson(`${baseUrl}/api/v1/web/sessions/run-1/transcript?offset=2&limit=3`);
      expectTranscriptWindowPayload(explicitPage.body, pagedTranscript, { kind: "page", limit: 3 });
      expect(explicitPage.response.headers.get("x-symphony-projection-status")).toBe("hit");
      expect(explicitPage.response.headers.get("x-symphony-projection-cache")).toBe("hit");
      expect(explicitPage.response.headers.get("x-symphony-projection-scope-key")).toBe("run-1:offset:2:limit:3");

      const refreshDefault = await getJson(`${baseUrl}/api/v1/web/sessions/run-1/transcript?refresh=1`);
      expectTranscriptWindowPayload(refreshDefault.body, [], { kind: "tail", limit: 500 });
      expect(refreshDefault.response.headers.get("x-symphony-projection-status")).toBe("refresh_bypass");
      expect(refreshDefault.response.headers.get("x-symphony-projection-cache")).toBe("miss");
      expect(refreshDefault.response.headers.get("x-symphony-projection-scope-key")).toBe("run-1:tail:limit:500");

      const refreshBypass = await getJson(`${baseUrl}/api/v1/web/sessions/run-1/transcript?offset=2&limit=3&refresh=1`);
      expectTranscriptWindowPayload(refreshBypass.body, [], { kind: "page", limit: 3 });
      expect((refreshBypass.body as { messages: unknown[] }).messages).toEqual([]);
      expect(refreshBypass.response.headers.get("x-symphony-projection-status")).toBe("refresh_bypass");
      expect(refreshBypass.response.headers.get("x-symphony-projection-cache")).toBe("miss");
    } finally {
      await server.stop();
    }

    expect(calls).toEqual({ snapshot: 0, getIssueDetails: 0, refreshNow: 0, pauseIssue: 0, resumeIssue: 0, cancelIssue: 0 });
    expect(projectionWriter.writes).toEqual([]);
    expect(projectionReader.selectors.map(({ projectionName, scopeKind, scopeKey }) => ({ projectionName, scopeKind, scopeKey }))).toEqual([
      { projectionName: "transcript_projection", scopeKind: "run_page", scopeKey: "run-1:offset:700:limit:500" },
      { projectionName: "transcript_projection", scopeKind: "run_page", scopeKey: "run-1:offset:2:limit:3" },
    ]);
  });

  it("resolves legacy web transcript aliases through the compatibility default context", async () => {
    const runStore = new RecordingRunStore(
      [
        runRecordFixture({
          runId: "run-default-alias-1",
          sessionId: "session-default-alias-1",
          issueId: "issue-default-alias-1",
          issueIdentifier: "ENG-179",
          workspaceKey: "ENG-179",
        }),
      ],
      {
        "run-default-alias-1": [
          {
            runId: "run-default-alias-1",
            sequence: 1,
            at: "2026-05-31T00:00:30.000Z",
            source: "runtime",
            eventType: "assistant_complete",
            message: "served from compatibility default alias",
          },
        ],
      },
    );
    const { server, calls } = createStatusServer(root, {
      runStore: runStore.asRunTranscriptStore(),
      defaultProjectContextId: "symphony",
    });
    const address = await server.start();
    const baseUrl = baseUrlFor(address);
    try {
      const transcript = await getJson(`${baseUrl}/api/v1/web/sessions/ENG-179/transcript`);
      const payload = transcript.body as { messages: Array<{ text?: string }>; window: { kind: string; limit: number } };

      expect(transcript.response.status).toBe(200);
      expect(payload.window).toMatchObject({ kind: "tail", limit: 500 });
      expect(payload.messages).toEqual(
        expect.arrayContaining([expect.objectContaining({ text: "served from compatibility default alias" })]),
      );
    } finally {
      await server.stop();
    }

    expect(calls).toEqual({ snapshot: 0, getIssueDetails: 0, refreshNow: 0, pauseIssue: 0, resumeIssue: 0, cancelIssue: 0 });
    expect(runStore.transcriptReadCount).toBe(1);
  });

  it("fails closed for ambiguous legacy web transcript aliases while qualified aliases still resolve", async () => {
    const docsProjectContext = {
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      linearProjectSlug: "DOCS",
      routingSource: "candidate_poll",
    } as const;
    const runStore = new RecordingRunStore(
      [
        runRecordFixture({
          runId: "run-default-ambiguous-1",
          sessionId: "session-default-ambiguous-1",
          issueId: "issue-default-ambiguous-1",
          issueIdentifier: "ENG-179",
          workspaceKey: "ENG-179",
        }),
        runRecordFixture({
          runId: "run-docs-ambiguous-1",
          sessionId: "session-docs-ambiguous-1",
          issueId: "issue-docs-ambiguous-1",
          issueIdentifier: "ENG-179",
          workspaceKey: "ENG-179",
          projectContext: docsProjectContext,
        }),
      ],
      {
        "run-default-ambiguous-1": [
          {
            runId: "run-default-ambiguous-1",
            sequence: 1,
            at: "2026-05-31T00:00:30.000Z",
            source: "runtime",
            eventType: "assistant_complete",
            message: "default transcript alias",
          },
        ],
        "run-docs-ambiguous-1": [
          {
            runId: "run-docs-ambiguous-1",
            sequence: 1,
            at: "2026-05-31T00:00:31.000Z",
            source: "runtime",
            eventType: "assistant_complete",
            message: "docs transcript alias",
          },
        ],
      },
    );
    const { server, calls } = createStatusServer(root, {
      runStore: runStore.asRunTranscriptStore(),
      defaultProjectContextId: "symphony",
    });
    const address = await server.start();
    const baseUrl = baseUrlFor(address);
    try {
      const ambiguous = await getJson(`${baseUrl}/api/v1/web/sessions/ENG-179/transcript`);
      const ambiguousBody = ambiguous.body as { error: { message: string } };
      expect(ambiguous.response.status).toBe(404);
      expect(ambiguousBody.error.message).toContain("ambiguous across project contexts");
      expect(ambiguousBody.error.message).toContain("context-qualified alias");

      const qualified = await getJson(`${baseUrl}/api/v1/web/sessions/docs%3AENG-179/transcript`);
      const qualifiedBody = qualified.body as { messages: Array<{ text?: string }>; window: { kind: string; limit: number } };
      expect(qualified.response.status).toBe(200);
      expect(qualifiedBody.window).toMatchObject({ kind: "tail", limit: 500 });
      expect(qualifiedBody.messages).toEqual(expect.arrayContaining([expect.objectContaining({ text: "docs transcript alias" })]));
    } finally {
      await server.stop();
    }

    expect(calls).toEqual({ snapshot: 0, getIssueDetails: 0, refreshNow: 0, pauseIssue: 0, resumeIssue: 0, cancelIssue: 0 });
    expect(runStore.transcriptReadCount).toBe(1);
  });

  it("fails closed for wrong-context legacy web transcript aliases with actionable guidance", async () => {
    const docsProjectContext = {
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      linearProjectSlug: "DOCS",
      routingSource: "candidate_poll",
    } as const;
    const runStore = new RecordingRunStore(
      [
        runRecordFixture({
          runId: "run-docs-wrong-context-1",
          sessionId: "session-docs-wrong-context-1",
          issueId: "issue-docs-wrong-context-1",
          issueIdentifier: "ENG-179",
          workspaceKey: "ENG-179",
          projectContext: docsProjectContext,
        }),
      ],
      {
        "run-docs-wrong-context-1": [
          {
            runId: "run-docs-wrong-context-1",
            sequence: 1,
            at: "2026-05-31T00:00:31.000Z",
            source: "runtime",
            eventType: "assistant_complete",
            message: "docs transcript alias",
          },
        ],
      },
    );
    const { server, calls } = createStatusServer(root, {
      runStore: runStore.asRunTranscriptStore(),
      defaultProjectContextId: "symphony",
    });
    const address = await server.start();
    const baseUrl = baseUrlFor(address);
    try {
      const wrongContext = await getJson(`${baseUrl}/api/v1/web/sessions/ENG-179/transcript`);
      const wrongContextBody = wrongContext.body as { error: { message: string } };
      expect(wrongContext.response.status).toBe(404);
      expect(wrongContextBody.error.message).toContain("not available through the default project context");
      expect(wrongContextBody.error.message).toContain("context-qualified alias");

      const qualified = await getJson(`${baseUrl}/api/v1/web/sessions/docs%3AENG-179/transcript`);
      const qualifiedBody = qualified.body as { messages: Array<{ text?: string }>; window: { kind: string; limit: number } };
      expect(qualified.response.status).toBe(200);
      expect(qualifiedBody.window).toMatchObject({ kind: "tail", limit: 500 });
      expect(qualifiedBody.messages).toEqual(expect.arrayContaining([expect.objectContaining({ text: "docs transcript alias" })]));
    } finally {
      await server.stop();
    }

    expect(calls).toEqual({ snapshot: 0, getIssueDetails: 0, refreshNow: 0, pauseIssue: 0, resumeIssue: 0, cancelIssue: 0 });
    expect(runStore.transcriptReadCount).toBe(1);
  });

  it("resolves context-qualified web issue detail lookups during refresh bypasses", async () => {
    const docsProjectContext = {
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      linearProjectSlug: "DOCS",
      routingSource: "candidate_poll",
    } as const;
    const runStore = new RecordingRunStore([
      runRecordFixture({
        runId: "run-docs-refresh-1",
        sessionId: "session-docs-refresh-1",
        issueId: "issue-docs-refresh-1",
        issueIdentifier: "ENG-179",
        workspaceKey: "ENG-179",
        projectContext: docsProjectContext,
        cursorModel: "gpt-5-refresh-docs",
      }),
    ]);
    const { server, calls } = createStatusServer(root, {
      runStore: runStore.asRunTranscriptStore(),
      defaultProjectContextId: "symphony",
    });
    const address = await server.start();
    const baseUrl = baseUrlFor(address);
    try {
      const detail = await getJson(`${baseUrl}/api/v1/web/issues/docs:ENG-179?refresh=1`);
      expect(detail.response.status).toBe(200);
      expect(detail.response.headers.get("x-symphony-projection-status")).toBe("refresh_bypass");
      expect(detail.body).toMatchObject({
        issue: {
          id: "docs:ENG-179",
          title: "ENG-179",
          project: "Documentation Site",
        },
        runs: [expect.objectContaining({ id: "session-docs-refresh-1", issue: "ENG-179", model: "gpt-5-refresh-docs" })],
      });
    } finally {
      await server.stop();
    }

    expect(calls.snapshot).toBeGreaterThanOrEqual(1);
  });

  it("resolves tracker-backed context-qualified web issue details during refresh bypasses", async () => {
    const docsIssue = trackerIssue({
      id: "issue-docs-179",
      identifier: "ENG-179",
      title: "Tracker-backed docs issue",
      description: "Tracker-backed docs issue detail.",
      priority: 2,
      state: "In Progress",
      projectContext: {
        projectContextId: "docs",
        projectContextLabel: "Documentation Site",
        linearProjectSlug: "DOCS",
        routingSource: "candidate_poll",
      },
    });
    const { server, calls } = createStatusServer(root, {
      tracker: trackerClient(async () => [docsIssue]),
      defaultProjectContextId: "symphony",
    });
    const address = await server.start();
    const baseUrl = baseUrlFor(address);
    try {
      const board = await getJson(`${baseUrl}/api/v1/web/issues?refresh=1`);
      expect(board.response.status).toBe(200);
      expect(board.response.headers.get("x-symphony-projection-status")).toBe("refresh_bypass");
      expect(board.body).toMatchObject({
        selectedIssueId: "docs:ENG-179",
        issues: [expect.objectContaining({ id: "docs:ENG-179", title: "Tracker-backed docs issue", project: "Documentation Site" })],
      });

      const detail = await getJson(`${baseUrl}/api/v1/web/issues/docs:ENG-179?refresh=1`);
      expect(detail.response.status).toBe(200);
      expect(detail.response.headers.get("x-symphony-projection-status")).toBe("refresh_bypass");
      expect(detail.body).toMatchObject({
        issue: {
          id: "docs:ENG-179",
          title: "Tracker-backed docs issue",
          project: "Documentation Site",
        },
        runs: [],
        transcript: [],
      });
    } finally {
      await server.stop();
    }

    expect(calls.snapshot).toBeGreaterThanOrEqual(2);
  });

  it("returns explicit stale responses without rebuilding canonical web projection sources", async () => {
    const staleDashboard = {
      projectName: "Stale durable dashboard",
      repoLabel: "",
      branch: "",
      workflowLabel: "",
      pollLabel: "",
      agentUsageLabel: "stale",
      concurrencyCap: 0,
      providerGates: [],
      runningAgents: [],
      activity: [],
      chat: [],
      totals: emptyTotals(),
    };
    const staleIssue = issueModelFixture();
    const staleIssueBoard = {
      issues: [staleIssue],
      backlog: [],
      lanes: { todo: [], progress: [staleIssue], review: [] },
      cycleLabel: "Stale cycle",
      cycleDateRange: "Stale dates",
      selectedIssueId: staleIssue.id,
    };
    const staleSidebar = {
      providerGates: [],
      runningAgents: [],
      reviewIssues: [staleIssue],
      activity: staleIssue.activity,
      sessions: [],
      chat: [],
      totals: emptyTotals(),
    };
    const sourceFreshness: ProjectionRevisionRecord["sourceFreshness"] = [
      {
        source: "runs",
        status: "stale",
        checkedAt: "2026-01-01T00:00:00.000Z",
        revision: "old",
        lastSuccessAt: "2026-01-01T00:00:00.000Z",
        lastErrorAt: null,
        staleMs: 60_000,
        detail: "Durable projection source is stale",
      },
    ];
    const staleRevisionOptions = {
      sourceRevisions: [{ source: "runs", revision: "old", observedAt: null }],
      sourceFreshness,
    };
    const projectionReader = new RecordingProjectionReader([
      projectionPayloadRecordFixture(
        { projectionName: "dashboard_projection", scopeKind: "global", scopeKey: "global" },
        staleDashboard,
        staleRevisionOptions,
      ),
      projectionPayloadRecordFixture(
        { projectionName: "issue_board_projection", scopeKind: "board", scopeKey: "default-board" },
        staleIssueBoard,
        staleRevisionOptions,
      ),
      projectionPayloadRecordFixture(
        { projectionName: "sidebar_projection", scopeKind: "global", scopeKey: "global" },
        staleSidebar,
        staleRevisionOptions,
      ),
    ]);
    const projectionWriter = new RecordingProjectionWriter();
    let contextBuilds = 0;
    const { server, calls } = createStatusServer(root, {
      projectionReader,
      projectionWriter,
      webProjectionRevisionProviders: [{ source: "runs", getRevision: () => ({ source: "runs", revision: "new", observedAt: null }) }],
      webProjectionContextBuilder: () => {
        contextBuilds += 1;
        throw new Error("stale durable rows must not rebuild the broad web projection source index");
      },
    });
    const address = await server.start();
    try {
      const baseUrl = baseUrlFor(address);
      const { response, body } = await getJson(`${baseUrl}/api/v1/web/dashboard`);
      expect(response.status).toBe(200);
      expect(body).toMatchObject({ projectName: "Symphony", agentUsageLabel: "0 agents" });
      expect(body).not.toEqual(staleDashboard);
      expect(response.headers.get("x-symphony-projection-status")).toBe("stale");
      expect(response.headers.get("x-symphony-projection-cache")).toBe("miss");
      expect(response.headers.get("x-symphony-projection-revision")).toBe("1");
      expect(headerJson(response, "x-symphony-projection-source-freshness")).toEqual(sourceFreshness);

      const staleIssues = await getJson(`${baseUrl}/api/v1/web/issues`);
      expect(staleIssues.response.status).toBe(200);
      expect(staleIssues.body).toEqual({
        issues: [],
        backlog: [],
        lanes: { todo: [], progress: [], review: [] },
        cycleLabel: "",
        cycleDateRange: "",
        selectedIssueId: "",
      });
      expect(staleIssues.body).not.toEqual(staleIssueBoard);
      expect(staleIssues.response.headers.get("x-symphony-projection-status")).toBe("stale");
      expect(staleIssues.response.headers.get("x-symphony-projection-cache")).toBe("miss");
      expect(staleIssues.response.headers.get("x-symphony-projection-revision")).toBe("1");
      expect(headerJson(staleIssues.response, "x-symphony-projection-source-freshness")).toEqual(sourceFreshness);

      const referenceData = await getJson(`${baseUrl}/api/v1/web/reference-data`);
      expect(referenceData.response.status).toBe(200);
      expect(referenceData.body).toEqual({ labels: {}, users: { unassigned: { name: "Unassigned", color: expect.any(String) } } });
      expect(referenceData.response.headers.get("x-symphony-projection-status")).toBe("stale");
      expect(referenceData.response.headers.get("x-symphony-projection-cache")).toBe("miss");
      expect(headerJson(referenceData.response, "x-symphony-projection-source-freshness")).toEqual(sourceFreshness);

      const staleSidebarResponse = await getJson(`${baseUrl}/api/v1/web/sidebar`);
      expect(staleSidebarResponse.response.status).toBe(200);
      expect(staleSidebarResponse.body).toMatchObject({
        providerGates: [],
        runningAgents: [],
        reviewIssues: [],
        activity: [],
        sessions: [],
        chat: [],
      });
      expect(staleSidebarResponse.body).not.toEqual(staleSidebar);
      expect(staleSidebarResponse.response.headers.get("x-symphony-projection-status")).toBe("stale");
      expect(staleSidebarResponse.response.headers.get("x-symphony-projection-cache")).toBe("miss");
      expect(staleSidebarResponse.response.headers.get("x-symphony-projection-revision")).toBe("1");
      expect(headerJson(staleSidebarResponse.response, "x-symphony-projection-source-freshness")).toEqual(sourceFreshness);
    } finally {
      await server.stop();
    }

    expect(contextBuilds).toBe(0);
    expect(calls.snapshot).toBe(0);
    expect(projectionWriter.writes).toEqual([]);

    const staleIssueReader = new RecordingProjectionReader([
      projectionPayloadRecordFixture(
        { projectionName: "issue_board_projection", scopeKind: "board", scopeKey: "default-board" },
        { issues: [staleIssue], backlog: [], lanes: { todo: [], progress: [staleIssue], review: [] }, cycleLabel: "", cycleDateRange: "", selectedIssueId: staleIssue.id },
        { sourceRevisions: [{ source: "runs", revision: "old", observedAt: null }] },
      ),
    ]);
    const staleIssueServer = createStatusServer(root, {
      projectionReader: staleIssueReader,
      webProjectionRevisionProviders: [{ source: "runs", getRevision: () => ({ source: "runs", revision: "new", observedAt: null }) }],
    }).server;
    const staleIssueAddress = await staleIssueServer.start();
    try {
      const staleDetail = await getJson(`${baseUrlFor(staleIssueAddress)}/api/v1/web/issues/ENG-179`);
      expect(staleDetail.body).toBeNull();
      expect(staleDetail.response.headers.get("x-symphony-projection-status")).toBe("stale");
      expect(staleDetail.response.headers.get("x-symphony-projection-cache")).toBe("miss");
      expect(staleDetail.response.headers.get("x-symphony-projection-revision")).toBe("1");
    } finally {
      await staleIssueServer.stop();
    }
  });

  it("does not serve expired durable projection payloads while preserving record metadata headers", async () => {
    const expiresAt = "2000-01-01T00:00:00.000Z";
    const sourceRevisions = [{ source: "runs", revision: "expired-run-revision", observedAt: null }];
    const sourceCursors = { durableEdge: "expired", eventCount: 3 };
    const expiredIssue = issueModelFixture();
    const expiredDashboard = {
      projectName: "Expired durable dashboard",
      repoLabel: "expired/repo",
      branch: "expired-branch",
      workflowLabel: "expired workflow",
      pollLabel: "expired poll",
      agentUsageLabel: "expired agents",
      concurrencyCap: 99,
      providerGates: [],
      runningAgents: [],
      activity: [],
      chat: [],
      totals: { ...emptyTotals(), progress: 99, open: 99, all: 99 },
    };
    const expiredIssueBoard = {
      issues: [expiredIssue],
      backlog: [],
      lanes: { todo: [], progress: [expiredIssue], review: [] },
      cycleLabel: "Expired cycle",
      cycleDateRange: "Expired dates",
      selectedIssueId: expiredIssue.id,
    };
    const expiredHistory = {
      sessions: [
        {
          id: "expired-session",
          title: "Expired session",
          subtitle: "must not be served",
          updatedAt: "2026-05-31T00:00:00.000Z",
          msgCount: 3,
          lastEvent: "expired",
          toolCount: 0,
        },
      ],
      transcriptBySession: {},
      timeline: [],
      defaultSessionId: "expired-session",
    };
    const expiredChat = [{ id: "expired-chat", who: "agent", text: "expired chat must not leak", createdAt: "2026-05-31T00:00:00.000Z" }];
    const expiredTranscript = [{ kind: "assistant" as const, ts: "2026-05-31T00:00:00.000Z", text: "expired transcript must not leak" }];
    const projectionReader = new RecordingProjectionReader([
      projectionPayloadRecordFixture(
        { projectionName: "dashboard_projection", scopeKind: "global", scopeKey: "global" },
        expiredDashboard,
        { expiresAt, revision: 9, sourceRevisions, sourceCursors },
      ),
      projectionPayloadRecordFixture(
        { projectionName: "issue_board_projection", scopeKind: "board", scopeKey: "default-board" },
        expiredIssueBoard,
        { expiresAt, revision: 10, sourceRevisions, sourceCursors },
      ),
      projectionPayloadRecordFixture(
        { projectionName: "history_projection", scopeKind: "global_collection", scopeKey: "global:session:7:timeline:9" },
        expiredHistory,
        { expiresAt, revision: 11, sourceRevisions, sourceCursors },
      ),
      projectionPayloadRecordFixture(
        { projectionName: "orchestrator_chat_projection", scopeKind: "conversation", scopeKey: "operator-room" },
        expiredChat,
        { expiresAt, revision: 12, sourceRevisions, sourceCursors },
      ),
      projectionPayloadRecordFixture(
        { projectionName: "transcript_projection", scopeKind: "run_page", scopeKey: "run-1:offset:2:limit:3" },
        expiredTranscript,
        { expiresAt, revision: 13, sourceRevisions, sourceCursors },
      ),
    ]);
    const projectionWriter = new RecordingProjectionWriter();
    const { server } = createStatusServer(root, { projectionReader, projectionWriter });
    const address = await server.start();
    const baseUrl = baseUrlFor(address);

    try {
      const dashboard = await getJson(`${baseUrl}/api/v1/web/dashboard`);
      expect(dashboard.body).toMatchObject({ projectName: "Symphony", agentUsageLabel: "0 agents" });
      expect(dashboard.body).not.toEqual(expiredDashboard);
      expect(dashboard.response.headers.get("x-symphony-projection-status")).toBe("expired");
      expect(dashboard.response.headers.get("x-symphony-projection-cache")).toBe("miss");
      expect(dashboard.response.headers.get("x-symphony-projection-revision")).toBe("9");
      expect(dashboard.response.headers.get("x-symphony-projection-expires-at")).toBe(expiresAt);
      expect(dashboard.response.headers.get("x-symphony-projection-content-sha256")).toBe("0".repeat(64));
      expect(dashboard.response.headers.get("x-symphony-projection-payload-sha256")).toBe("1".repeat(64));
      expect(headerJson(dashboard.response, "x-symphony-projection-source-revisions")).toEqual(sourceRevisions);
      expect(headerJson(dashboard.response, "x-symphony-projection-source-cursors")).toEqual(sourceCursors);

      const referenceData = await getJson(`${baseUrl}/api/v1/web/reference-data`);
      expect(referenceData.body).toEqual({ labels: {}, users: { unassigned: { name: "Unassigned", color: expect.any(String) } } });
      expect(referenceData.response.headers.get("x-symphony-projection-status")).toBe("expired");
      expect(referenceData.response.headers.get("x-symphony-projection-revision")).toBe("10");
      expect(referenceData.body).not.toMatchObject({ labels: { durable: expect.anything() } });

      const history = await getJson(`${baseUrl}/api/v1/web/history?sessionLimit=7&timelineLimit=9`);
      expect(history.body).toEqual({ sessions: [], transcriptBySession: {}, timeline: [], defaultSessionId: "" });
      expect(history.body).not.toEqual(expiredHistory);
      expect(history.response.headers.get("x-symphony-projection-status")).toBe("expired");
      expect(history.response.headers.get("x-symphony-projection-scope-key")).toBe("global:session:7:timeline:9");
      expect(history.response.headers.get("x-symphony-projection-revision")).toBe("11");

      const chat = await getJson(`${baseUrl}/api/v1/web/orchestrator-chat?conversationId=operator-room`);
      expect(chat.body).toMatchObject({
        conversation: { id: "operator-room", status: "completed", messageCount: 0 },
        state: "empty",
        status: { state: "empty", empty: true, messageCount: 0 },
        chat: [],
      });
      expect(chat.body).not.toEqual(expiredChat);
      expect(chat.response.headers.get("x-symphony-projection-status")).toBe("expired");
      expect(chat.response.headers.get("x-symphony-projection-scope-key")).toBe("operator-room");
      expect(chat.response.headers.get("x-symphony-projection-revision")).toBe("12");

      const transcript = await getJson(`${baseUrl}/api/v1/web/sessions/run-1/transcript?offset=2&limit=3`);
      expectTranscriptWindowPayload(transcript.body, [], { kind: "page", limit: 3 });
      expect((transcript.body as { messages: unknown[] }).messages).toEqual([]);
      expect((transcript.body as { messages: unknown[] }).messages).not.toEqual(expiredTranscript);
      expect(transcript.response.headers.get("x-symphony-projection-status")).toBe("expired");
      expect(transcript.response.headers.get("x-symphony-projection-scope-key")).toBe("run-1:offset:2:limit:3");
      expect(transcript.response.headers.get("x-symphony-projection-revision")).toBe("13");
    } finally {
      await server.stop();
    }

    expect(projectionWriter.writes.map(({ projectionName, scopeKind, scopeKey }) => ({ projectionName, scopeKind, scopeKey }))).toEqual([
      { projectionName: "history_projection", scopeKind: "global_collection", scopeKey: "global:session:7:timeline:9" },
      { projectionName: "orchestrator_chat_projection", scopeKind: "conversation", scopeKey: "operator-room" },
    ]);
    expect(projectionWriter.writeFor("history_projection").payload).toEqual({
      sessions: [],
      transcriptBySession: {},
      timeline: [],
      defaultSessionId: "",
    });
    expect(projectionWriter.writeFor("orchestrator_chat_projection").payload).toMatchObject({
      conversation: { id: "operator-room", status: "completed", messageCount: 0 },
      state: "empty",
      status: { state: "empty", empty: true, messageCount: 0 },
      chat: [],
    });
    expect(projectionReader.selectors.map(({ projectionName, scopeKind, scopeKey }) => ({ projectionName, scopeKind, scopeKey }))).toEqual([
      { projectionName: "dashboard_projection", scopeKind: "global", scopeKey: "global" },
      { projectionName: "issue_board_projection", scopeKind: "board", scopeKey: "default-board" },
      { projectionName: "history_projection", scopeKind: "global_collection", scopeKey: "global:session:7:timeline:9" },
      { projectionName: "orchestrator_chat_projection", scopeKind: "conversation", scopeKey: "operator-room" },
      { projectionName: "transcript_projection", scopeKind: "run_page", scopeKey: "run-1:offset:2:limit:3" },
    ]);
  });

  it("keeps orchestrator chat durable reads scoped to conversation-source revisions", async () => {
    const chat = [{ id: "chat-1", who: "agent", text: "chat source is current", createdAt: "2026-05-31T00:00:00.000Z" }];
    const projectionReader = new RecordingProjectionReader([
      projectionPayloadRecordFixture(
        { projectionName: "orchestrator_chat_projection", scopeKind: "conversation", scopeKey: "operator-room" },
        chat,
        {
          sourceRevisions: [
            { source: "runs", revision: "old-unrelated-run-revision", observedAt: null },
            { source: "lifecycleStore", revision: "old-unrelated-lifecycle-revision", observedAt: null },
            { source: "orchestrator_conversations", revision: "chat-current", observedAt: null },
          ],
        },
      ),
    ]);
    const { server } = createStatusServer(root, {
      projectionReader,
      webProjectionRevisionProviders: [
        { source: "runs", getRevision: () => ({ source: "runs", revision: "new-unrelated-run-revision", observedAt: null }) },
        { source: "lifecycleStore", getRevision: () => ({ source: "lifecycleStore", revision: "new-unrelated-lifecycle-revision", observedAt: null }) },
        {
          source: "orchestrator_conversations",
          getRevision: () => ({ source: "orchestrator_conversations", revision: "chat-current", observedAt: null }),
        },
      ],
    });
    const address = await server.start();
    try {
      const response = await getJson(`${baseUrlFor(address)}/api/v1/web/orchestrator-chat?conversationId=operator-room`);
      expect(response.body).toMatchObject({
        conversation: { id: "operator-room", messageCount: chat.length },
        state: "completed",
        status: { state: "completed", messageCount: chat.length },
        chat,
        compatibility: { responseShape: "orchestrator_chat_projection", sourceShape: "legacy_chat_array" },
      });
      expect(response.response.headers.get("x-symphony-projection-status")).toBe("hit");
      expect(response.response.headers.get("x-symphony-projection-cache")).toBe("hit");
      expect(response.response.headers.get("x-symphony-projection-scope-key")).toBe("operator-room");
    } finally {
      await server.stop();
    }

    const staleChat = [{ id: "chat-stale", who: "agent", text: "stale chat must not leak", createdAt: "2026-05-31T00:00:00.000Z" }];
    const staleReader = new RecordingProjectionReader([
      projectionPayloadRecordFixture(
        { projectionName: "orchestrator_chat_projection", scopeKind: "conversation", scopeKey: "operator-room" },
        staleChat,
        { sourceRevisions: [{ source: "orchestrator_conversations", revision: "chat-old", observedAt: null }] },
      ),
    ]);
    const staleServer = createStatusServer(root, {
      projectionReader: staleReader,
      webProjectionRevisionProviders: [
        {
          source: "orchestrator_conversations",
          getRevision: () => ({ source: "orchestrator_conversations", revision: "chat-new", observedAt: null }),
        },
      ],
    }).server;
    const staleAddress = await staleServer.start();
    try {
      const stale = await getJson(`${baseUrlFor(staleAddress)}/api/v1/web/orchestrator-chat?conversationId=operator-room`);
      expect(stale.body).toMatchObject({
        conversation: { id: "operator-room", status: "unavailable", messageCount: 0 },
        state: "unavailable",
        status: { state: "unavailable", empty: true, messageCount: 0 },
        chat: [],
        compatibility: { responseShape: "orchestrator_chat_projection", sourceShape: "fallback" },
      });
      expect(stale.body).not.toEqual(staleChat);
      expect(stale.response.headers.get("x-symphony-projection-status")).toBe("stale");
      expect(stale.response.headers.get("x-symphony-projection-cache")).toBe("miss");
      expect(stale.response.headers.get("x-symphony-projection-revision")).toBe("1");
    } finally {
      await staleServer.stop();
    }
  });

  it("annotates durable projection fallback states for unavailable readers, missing records, refresh bypass, read errors, and missing detail items", async () => {
    const unavailableServer = createStatusServer(root).server;
    const unavailableAddress = await unavailableServer.start();
    try {
      const unavailable = await getJson(`${baseUrlFor(unavailableAddress)}/api/v1/web/dashboard`);
      expect(unavailable.body).toMatchObject({ projectName: "Symphony" });
      expect(unavailable.response.headers.get("x-symphony-projection-status")).toBe("unavailable");
      expect(unavailable.response.headers.get("x-symphony-projection-cache")).toBe("miss");
      expect(unavailable.response.headers.get("x-symphony-projection-name")).toBe("dashboard_projection");
    } finally {
      await unavailableServer.stop();
    }

    const missingReader = new RecordingProjectionReader([]);
    const missingServer = createStatusServer(root, { projectionReader: missingReader }).server;
    const missingAddress = await missingServer.start();
    try {
      const missing = await getJson(`${baseUrlFor(missingAddress)}/api/v1/web/dashboard`);
      expect(missing.body).toMatchObject({ projectName: "Symphony" });
      expect(missing.response.headers.get("x-symphony-projection-status")).toBe("missing");
      expect(missing.response.headers.get("x-symphony-projection-cache")).toBe("miss");
      expect(missing.response.headers.get("x-symphony-projection-name")).toBe("dashboard_projection");
    } finally {
      await missingServer.stop();
    }

    const missingDetailServer = createStatusServer(root, { projectionReader: new RecordingProjectionReader([]) }).server;
    const missingDetailAddress = await missingDetailServer.start();
    try {
      const missingDetailProjection = await getJson(`${baseUrlFor(missingDetailAddress)}/api/v1/web/issues/ENG-179`);
      expect(missingDetailProjection.body).toBeNull();
      expect(missingDetailProjection.response.headers.get("x-symphony-projection-status")).toBe("missing");
      expect(missingDetailProjection.response.headers.get("x-symphony-projection-cache")).toBe("miss");
      expect(missingDetailProjection.response.headers.get("x-symphony-projection-name")).toBe("issue_board_projection");
    } finally {
      await missingDetailServer.stop();
    }

    const durableDashboard = {
      projectName: "Do not serve on refresh",
      repoLabel: "",
      branch: "",
      workflowLabel: "",
      pollLabel: "",
      agentUsageLabel: "stale",
      concurrencyCap: 0,
      providerGates: [],
      runningAgents: [],
      activity: [],
      chat: [],
      totals: emptyTotals(),
    };
    const refreshReader = new RecordingProjectionReader([
      projectionPayloadRecordFixture({ projectionName: "dashboard_projection", scopeKind: "global", scopeKey: "global" }, durableDashboard),
    ]);
    const refreshServer = createStatusServer(root, { projectionReader: refreshReader }).server;
    const refreshAddress = await refreshServer.start();
    try {
      const refresh = await getJson(`${baseUrlFor(refreshAddress)}/api/v1/web/dashboard?refresh=true`);
      expect(refresh.body).not.toEqual(durableDashboard);
      expect(refresh.response.headers.get("x-symphony-projection-status")).toBe("refresh_bypass");
      expect(refresh.response.headers.get("x-symphony-projection-cache")).toBe("miss");
      expect(refreshReader.selectors).toEqual([]);
    } finally {
      await refreshServer.stop();
    }

    const refreshIssue = issueModelFixture();
    const refreshIssueReader = new RecordingProjectionReader([
      projectionPayloadRecordFixture(
        { projectionName: "issue_board_projection", scopeKind: "board", scopeKey: "default-board" },
        { issues: [refreshIssue], backlog: [], lanes: { todo: [], progress: [refreshIssue], review: [] }, cycleLabel: "", cycleDateRange: "", selectedIssueId: refreshIssue.id },
      ),
    ]);
    const refreshDetailServer = createStatusServer(root, { projectionReader: refreshIssueReader }).server;
    const refreshDetailAddress = await refreshDetailServer.start();
    try {
      const refreshDetail = await getJson(`${baseUrlFor(refreshDetailAddress)}/api/v1/web/issues/ENG-179?refresh=true`);
      expect(refreshDetail.body).toBeNull();
      expect(refreshDetail.response.headers.get("x-symphony-projection-status")).toBe("refresh_bypass");
      expect(refreshDetail.response.headers.get("x-symphony-projection-cache")).toBe("miss");
      expect(refreshIssueReader.selectors).toEqual([]);
    } finally {
      await refreshDetailServer.stop();
    }

    const failingReader = new FailingProjectionReader();
    const errorServer = createStatusServer(root, { projectionReader: failingReader }).server;
    const errorAddress = await errorServer.start();
    try {
      const failed = await getJson(`${baseUrlFor(errorAddress)}/api/v1/web/dashboard`);
      expect(failed.body).toMatchObject({ projectName: "Symphony" });
      expect(failed.response.headers.get("x-symphony-projection-status")).toBe("error");
      expect(failed.response.headers.get("x-symphony-projection-cache")).toBe("miss");
      expect(failingReader.selectors.map(({ projectionName }) => projectionName)).toEqual(["dashboard_projection"]);
    } finally {
      await errorServer.stop();
    }

    const issue = issueModelFixture();
    const detailReader = new RecordingProjectionReader([
      projectionPayloadRecordFixture(
        { projectionName: "issue_board_projection", scopeKind: "board", scopeKey: "default-board" },
        { issues: [issue], backlog: [], lanes: { todo: [], progress: [issue], review: [] }, cycleLabel: "", cycleDateRange: "", selectedIssueId: issue.id },
      ),
    ]);
    const detailServer = createStatusServer(root, { projectionReader: detailReader }).server;
    const detailAddress = await detailServer.start();
    try {
      const missingDetail = await getJson(`${baseUrlFor(detailAddress)}/api/v1/web/issues/ENG-404`);
      expect(missingDetail.body).toBeNull();
      expect(missingDetail.response.headers.get("x-symphony-projection-status")).toBe("missing_item");
      expect(decodeURIComponent(missingDetail.response.headers.get("x-symphony-projection-reason") ?? "")).toBe(
        "issue_detail_not_found_in_current_issue_board_projection",
      );
      expect(missingDetail.response.headers.get("x-symphony-projection-revision")).toBe("1");
    } finally {
      await detailServer.stop();
    }
  });

  it("records non-success source freshness for unavailable and failing tracker web projections", async () => {
    const cases: Array<{
      name: string;
      tracker?: TrackerClient;
      revisionPrefix: string;
      detail: string;
    }> = [
      {
        name: "tracker unavailable",
        revisionPrefix: "unavailable:",
        detail: "Issue board requires a configured tracker client",
      },
      {
        name: "tracker fetch throws",
        tracker: trackerClient(async () => {
          throw new Error("Linear request failed");
        }),
        revisionPrefix: "error:",
        detail: "Issue board tracker fetch failed: Linear request failed",
      },
    ];

    for (const testCase of cases) {
      const projectionWriter = new RecordingProjectionWriter();
      const { server } = createStatusServer(root, {
        projectionWriter,
        ...(testCase.tracker ? { tracker: testCase.tracker } : {}),
      });
      const address = await server.start();
      try {
        const { response } = await getJson(`${baseUrlFor(address)}/api/v1/web/issues`);
        expect({ name: testCase.name, status: response.status }).toEqual({ name: testCase.name, status: 200 });
      } finally {
        await server.stop();
      }

      const issueBoard = projectionWriter.writeFor("issue_board_projection");
      const trackerRevision = issueBoard.sourceRevisions?.find((revision) => revision.source === "trackerIssues");
      const trackerFreshness = issueBoard.sourceFreshness?.find((record) => record.source === "trackerIssues");
      expect(String(trackerRevision?.revision)).toMatch(new RegExp(`^${testCase.revisionPrefix}`));
      expect(trackerFreshness).toMatchObject({
        source: "trackerIssues",
        status: "error",
        checkedAt: "2026-01-01T00:00:00.000Z",
        revision: expect.stringMatching(new RegExp(`^${testCase.revisionPrefix}`)),
        lastSuccessAt: null,
        lastErrorAt: "2026-01-01T00:00:00.000Z",
        detail: expect.stringContaining(testCase.detail),
      });
    }
  });

  it("records successful empty tracker freshness distinctly from tracker failure states", async () => {
    const projectionWriter = new RecordingProjectionWriter();
    const fetchedAt = "2026-01-01T00:00:10.000Z";
    const { server } = createStatusServer(root, {
      projectionWriter,
      tracker: trackerClient(async () => []),
      webProjectionContextClock: () => new Date(fetchedAt),
    });
    const address = await server.start();
    try {
      const { response } = await getJson(`${baseUrlFor(address)}/api/v1/web/issues`);
      expect(response.status).toBe(200);
    } finally {
      await server.stop();
    }

    const issueBoard = projectionWriter.writeFor("issue_board_projection");
    expect(issueBoard.sourceRevisions?.find((revision) => revision.source === "trackerIssues")?.revision).toBe(
      "ok:Backlog,Todo,In Progress,Blocked,In Review,Done,Closed,Cancelled,Canceled,Duplicate:0:none",
    );
    const emptyTrackerFreshness = issueBoard.sourceFreshness?.find((record) => record.source === "trackerIssues");
    expect(emptyTrackerFreshness).toMatchObject({
      source: "trackerIssues",
      status: "empty",
      checkedAt: expect.any(String),
      revision: "ok:Backlog,Todo,In Progress,Blocked,In Review,Done,Closed,Cancelled,Canceled,Duplicate:0:none",
      lastSuccessAt: expect.any(String),
      lastErrorAt: null,
      detail: "Issue board tracker source returned no issues",
    });
    expect(emptyTrackerFreshness?.lastSuccessAt).toBe(emptyTrackerFreshness?.checkedAt);
  });

  it("keeps web responses available when durable projection persistence rejects", async () => {
    const { server } = createStatusServer(root, { projectionWriter: new FailingProjectionWriter() });
    const address = await server.start();
    try {
      const { response, body } = await getJson(`${baseUrlFor(address)}/api/v1/web/dashboard`);
      expect(response.status).toBe(200);
      expectTopLevelKeys(body, [
        "activity",
        "agentUsageLabel",
        "branch",
        "chat",
        "concurrencyCap",
        "pollLabel",
        "projectName",
        "providerGates",
        "repoLabel",
        "runningAgents",
        "source",
        "totals",
        "workflowLabel",
      ]);
    } finally {
      await server.stop();
    }
  });

  it("keeps the orchestrator chat POST contract bounded when storage is absent and validates malformed input", async () => {
    const { server, calls } = createStatusServer(root);
    const address = await server.start();
    const url = `${baseUrlFor(address)}/api/v1/web/orchestrator-chat`;
    try {
      const unavailable = await postJson(url, { input: "summarize ENG-113" });
      expect(unavailable.response.status).toBe(503);
      expect(unavailable.body).toEqual({
        error: {
          code: "orchestrator_chat_unavailable",
          message: "Web orchestrator chat is unavailable because durable conversation storage is not configured",
        },
        chat: [],
      });
      expect(unavailable.text).not.toContain("summarize ENG-113");

      const malformed = await fetch(url, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ input: "   " }),
      });
      const malformedBody = (await malformed.json()) as { error?: { code?: string; message?: string } };
      expect(malformed.status).toBe(400);
      expect(malformed.headers.get("content-type")).toContain("application/json");
      expect(malformedBody.error).toMatchObject({
        code: "invalid_request",
        message: "Web orchestrator chat request body must include a non-empty string input",
      });
      expect(calls).toEqual({ snapshot: 0, getIssueDetails: 0, refreshNow: 0, pauseIssue: 0, resumeIssue: 0, cancelIssue: 0 });
    } finally {
      await server.stop();
    }
  });

  it("returns JSON not_found errors for unsupported /api/v1/web route or method variants", async () => {
    const { server } = createStatusServer(root);
    const address = await server.start();
    const baseUrl = baseUrlFor(address);
    try {
      const unsupportedCases: Array<{ name: string; url: string; init?: RequestInit }> = [
        { name: "unsupported dashboard method", url: `${baseUrl}/api/v1/web/dashboard`, init: { method: "POST" } },
        { name: "missing transcript suffix", url: `${baseUrl}/api/v1/web/sessions/run-1` },
        { name: "unknown web route", url: `${baseUrl}/api/v1/web/unknown` },
      ];

      for (const testCase of unsupportedCases) {
        const { response, body } = await getJson(testCase.url, testCase.init);
        expect({ name: testCase.name, status: response.status }).toEqual({ name: testCase.name, status: 404 });
        expect(body).toEqual({ error: { code: "not_found", message: "Route not found" } });
      }
    } finally {
      await server.stop();
    }
  });

  it("serves configured production web assets under /web after API routes have precedence", async () => {
    const webAssetsRoot = await createWebAssets(root);
    const { server } = createStatusServer(root, { webAssetsRoot });
    const address = await server.start();
    const baseUrl = baseUrlFor(address);
    try {
      for (const route of ["/web", "/web/", "/web/index.html"]) {
        const { response, text } = await getText(`${baseUrl}${route}`);
        expect({ route, status: response.status }).toEqual({ route, status: 200 });
        expect(response.headers.get("content-type")).toContain("text/html");
        expect(response.headers.get("cache-control")).toBe("no-cache");
        expect(text).toContain("Symphony static shell");
        expect(text).toContain('/web/assets/app.css');
      }

      const css = await getText(`${baseUrl}/web/assets/app.css?cache-bust=1`);
      expect(css.response.status).toBe(200);
      expect(css.response.headers.get("content-type")).toContain("text/css");
      expect(css.response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(css.text).toContain("color: papayawhip");

      const assetHead = await fetch(`${baseUrl}/web/assets/app.js`, { method: "HEAD" });
      expect(assetHead.status).toBe(200);
      expect(assetHead.headers.get("content-type")).toContain("javascript");
      expect(assetHead.headers.get("content-length")).toBe(String("console.log('symphony static shell');\n".length));
      expect(await assetHead.text()).toBe("");

      const deepLink = await getText(`${baseUrl}/web/issues/ENG-119`);
      expect(deepLink.response.status).toBe(200);
      expect(deepLink.response.headers.get("content-type")).toContain("text/html");
      expect(deepLink.response.headers.get("cache-control")).toBe("no-cache");
      expect(deepLink.text).toContain("Symphony static shell");

      const deepLinkHead = await fetch(`${baseUrl}/web/history/session-1`, { method: "HEAD" });
      expect(deepLinkHead.status).toBe(200);
      expect(deepLinkHead.headers.get("content-type")).toContain("text/html");
      expect(deepLinkHead.headers.get("cache-control")).toBe("no-cache");
      expect(await deepLinkHead.text()).toBe("");

      const traversal = await getJson(`${baseUrl}/web/..%2fpackage.json`);
      expect(traversal.response.status).toBe(404);
      expect(traversal.body).toEqual({ error: { code: "not_found", message: "Static asset not found" } });

      const api = await getJson(`${baseUrl}/api/v1/web/dashboard`);
      expect(api.response.status).toBe(200);
      expectTopLevelKeys(api.body, [
        "activity",
        "agentUsageLabel",
        "branch",
        "chat",
        "concurrencyCap",
        "pollLabel",
        "projectName",
        "providerGates",
        "repoLabel",
        "runningAgents",
        "source",
        "totals",
        "workflowLabel",
      ]);

      const unsupportedApi = await getJson(`${baseUrl}/api/v1/web/unknown`);
      expect(unsupportedApi.response.status).toBe(404);
      expect(unsupportedApi.body).toEqual({ error: { code: "not_found", message: "Route not found" } });
    } finally {
      await server.stop();
    }
  });

  it("returns static 404s for missing asset-like /web paths instead of the SPA fallback", async () => {
    const webAssetsRoot = await createWebAssets(root);
    const { server } = createStatusServer(root, { webAssetsRoot });
    const address = await server.start();
    const baseUrl = baseUrlFor(address);
    try {
      const cases = ["/web/assets/missing.js", "/web/assets", "/web/static/missing", "/web/missing.css", "/web/favicon.ico"];
      for (const route of cases) {
        const missingAsset = await getJson(`${baseUrl}${route}`);
        expect({ route, status: missingAsset.response.status }).toEqual({ route, status: 404 });
        expect(missingAsset.body).toEqual({ error: { code: "not_found", message: "Static asset not found" } });
        expect(missingAsset.text).not.toContain("Symphony static shell");
      }
    } finally {
      await server.stop();
    }
  });

  it("can explicitly disable /web static serving", async () => {
    const { server } = createStatusServer(root, { webAssetsRoot: null });
    const address = await server.start();
    try {
      const { response, body } = await getJson(`${baseUrlFor(address)}/web/`);
      expect(response.status).toBe(404);
      expect(body).toEqual({ error: { code: "not_found", message: "Route not found" } });
    } finally {
      await server.stop();
    }
  });

  it("returns safe static 404s when the configured /web asset root is missing or not a directory", async () => {
    const nonDirectoryRoot = path.join(root, "web-dist-file");
    await writeFile(nonDirectoryRoot, "not a directory", "utf8");
    const invalidRoots = [path.join(root, "missing-web-dist"), nonDirectoryRoot];

    for (const webAssetsRoot of invalidRoots) {
      const { server } = createStatusServer(root, { webAssetsRoot });
      const address = await server.start();
      const baseUrl = baseUrlFor(address);
      try {
        for (const route of ["/web", "/web/", "/web/assets/app.js"]) {
          const { response, body, text } = await getJson(`${baseUrl}${route}`);
          expect({ route, webAssetsRoot, status: response.status }).toEqual({ route, webAssetsRoot, status: 404 });
          expect(body).toEqual({ error: { code: "not_found", message: "Static asset not found" } });
          expect(text).not.toContain("Symphony static shell");
        }
      } finally {
        await server.stop();
      }
    }
  });

  it("does not serve files outside the configured /web asset root", async () => {
    const webAssetsRoot = await createWebAssets(root);
    await writeFile(path.join(root, "secret.txt"), "do not serve", "utf8");
    await writeFile(path.join(webAssetsRoot, ".env"), "SYMPHONY_SECRET=do not serve env", "utf8");
    await writeFile(path.join(webAssetsRoot, "package.json"), '{"secret":"do not serve package"}\n', "utf8");
    await writeFile(path.join(webAssetsRoot, "LICENSE"), "do not serve repository license", "utf8");
    await mkdir(path.join(webAssetsRoot, "src"), { recursive: true });
    await writeFile(path.join(webAssetsRoot, "src", "App.tsx"), "do not serve source", "utf8");
    await mkdir(path.join(webAssetsRoot, ".symphony"), { recursive: true });
    await writeFile(path.join(webAssetsRoot, ".symphony", "state.json"), "do not serve runtime state", "utf8");
    await mkdir(path.join(webAssetsRoot, "symphony_workspaces", "ENG-1"), { recursive: true });
    await writeFile(
      path.join(webAssetsRoot, "symphony_workspaces", "ENG-1", "package.json"),
      '{"secret":"do not serve workspace"}\n',
      "utf8",
    );
    const outsideRoot = path.join(root, "outside-web-dist");
    await mkdir(outsideRoot, { recursive: true });
    await writeFile(path.join(outsideRoot, "secret.txt"), "do not serve via link", "utf8");
    await symlink(
      outsideRoot,
      path.join(webAssetsRoot, "linked-outside"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const { server } = createStatusServer(root, { webAssetsRoot });
    const address = await server.start();
    const baseUrl = baseUrlFor(address);
    try {
      const traversal = await getJson(`${baseUrl}/web/%2e%2e%2fsecret.txt`);
      expect(traversal.response.status).toBe(404);
      expect(traversal.body).toEqual({ error: { code: "not_found", message: "Static asset not found" } });
      expect(traversal.text).not.toContain("do not serve");

      const missingAsset = await getJson(`${baseUrl}/web/assets/missing.js`);
      expect(missingAsset.response.status).toBe(404);
      expect(missingAsset.body).toEqual({ error: { code: "not_found", message: "Static asset not found" } });

      const linkedEscape = await getJson(`${baseUrl}/web/linked-outside/secret.txt`);
      expect(linkedEscape.response.status).toBe(404);
      expect(linkedEscape.body).toEqual({ error: { code: "not_found", message: "Static asset not found" } });
      expect(linkedEscape.text).not.toContain("do not serve via link");

      const deniedRoutes = [
        { route: "/web/.env", secret: "do not serve env" },
        { route: "/web/package.json", secret: "do not serve package" },
        { route: "/web/LICENSE", secret: "do not serve repository license" },
        { route: "/web/src/App.tsx", secret: "do not serve source" },
        { route: "/web/.symphony/state.json", secret: "do not serve runtime state" },
        { route: "/web/symphony_workspaces/ENG-1/package.json", secret: "do not serve workspace" },
      ];
      for (const { route, secret } of deniedRoutes) {
        const denied = await getJson(`${baseUrl}${route}`);
        expect({ route, status: denied.response.status }).toEqual({ route, status: 404 });
        expect(denied.body).toEqual({ error: { code: "not_found", message: "Static asset not found" } });
        expect(denied.text).not.toContain(secret);
        expect(denied.text).not.toContain("Symphony static shell");
      }
    } finally {
      await server.stop();
    }
  });
});

interface OrchestratorCallCounts {
  snapshot: number;
  getIssueDetails: number;
  refreshNow: number;
  pauseIssue: number;
  resumeIssue: number;
  cancelIssue: number;
}

interface CreateStatusServerOptions {
  webAssetsRoot?: string | null;
  projectionWriter?: StatusServerProjectionWriter;
  projectionReader?: StatusServerProjectionReader;
  webProjectionRevisionProviders?: readonly WebProjectionRevisionProvider[];
  defaultProjectContextId?: string | null;
  runStore?: RunTranscriptStore;
  tracker?: TrackerClient;
  webProjectionContextClock?: () => Date;
  webProjectionContextBuilder?: StatusServerWebProjectionContextBuilder;
  orchestratorConversationStore?: OrchestratorConversationStore;
}

class RecordingProjectionWriter implements StatusServerProjectionWriter {
  readonly writes: ProjectionPayloadWriteInput[] = [];

  async writeProjection(input: ProjectionPayloadWriteInput): Promise<ProjectionWriteResult> {
    this.writes.push(JSON.parse(JSON.stringify(input)) as ProjectionPayloadWriteInput);
    const revision = projectionRevisionRecordFixture(input, this.writes.length);
    const requestedBuildMode = input.buildMode ?? "incremental";
    return {
      status: "written",
      revision,
      previousRevision: null,
      requestedBuildMode,
      buildMode: revision.buildMode,
      contentSha256: "0".repeat(64),
      payloadSha256: "1".repeat(64),
      event: null,
    };
  }

  writeFor(projectionName: ProjectionPayloadWriteInput["projectionName"]): ProjectionPayloadWriteInput {
    const write = this.writes.find((candidate) => candidate.projectionName === projectionName);
    if (!write) throw new Error(`expected projection write for ${projectionName}`);
    return write;
  }
}

class FailingProjectionWriter implements StatusServerProjectionWriter {
  async writeProjection(): Promise<ProjectionWriteResult> {
    throw new Error("simulated projection persistence failure");
  }
}

class RecordingProjectionReader implements StatusServerProjectionReader {
  readonly selectors: ProjectionRevisionSelector[] = [];
  private readonly records = new Map<string, ProjectionPayloadRecord>();

  constructor(records: readonly ProjectionPayloadRecord[]) {
    for (const record of records) {
      this.records.set(projectionSelectorKey(record.revision), cloneJson(record));
    }
  }

  async readCurrentPayload<TPayload = unknown>(selector: ProjectionRevisionSelector): Promise<ProjectionPayloadRecord<TPayload> | null> {
    this.selectors.push({ ...selector });
    const record = this.records.get(projectionSelectorKey(selector));
    return record ? (cloneJson(record) as ProjectionPayloadRecord<TPayload>) : null;
  }

  async readCurrentTranscriptDefaultPayload<TPayload = unknown>(selector: {
    runId: string;
    limit: number;
  }): Promise<ProjectionPayloadRecord<TPayload> | null> {
    const record = [...this.records.values()]
      .filter((candidate) => {
        const page = transcriptProjectionPageFromScopeKey(candidate.revision.scopeKey);
        return (
          candidate.revision.projectionName === "transcript_projection" &&
          candidate.revision.scopeKind === "run_page" &&
          page?.runId === selector.runId &&
          page.limit === selector.limit
        );
      })
      .sort(compareTranscriptDefaultProjectionRecords)[0];
    if (record) this.selectors.push(projectionRevisionSelector(record.revision));
    else {
      this.selectors.push({
        projectionName: "transcript_projection",
        scopeKind: "run_page",
        scopeKey: `${selector.runId}:tail:limit:${selector.limit}`,
      });
    }
    return record ? (cloneJson(record) as ProjectionPayloadRecord<TPayload>) : null;
  }
}

class FailingProjectionReader implements StatusServerProjectionReader {
  readonly selectors: ProjectionRevisionSelector[] = [];

  async readCurrentPayload<TPayload = unknown>(selector: ProjectionRevisionSelector): Promise<ProjectionPayloadRecord<TPayload> | null> {
    this.selectors.push({ ...selector });
    throw new Error("simulated projection read failure");
  }
}

class RecordingRunStore {
  transcriptReadCount = 0;

  private readonly runsById = new Map<string, RunRecord>();
  private readonly transcriptEventsByRunId = new Map<string, TranscriptEvent[]>();

  constructor(runs: readonly RunRecord[], transcriptEvents: Record<string, readonly TranscriptEvent[]> = {}) {
    for (const run of runs) this.runsById.set(run.runId, cloneJson(run));
    for (const [runId, events] of Object.entries(transcriptEvents)) {
      this.transcriptEventsByRunId.set(runId, events.map((event) => cloneJson(event)));
    }
  }

  projectionRevision(): number {
    return 7;
  }

  onProjectionChanged(): () => void {
    return () => undefined;
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const run = this.runsById.get(runId);
    if (run) return cloneJson(run);
    const sessionRun = [...this.runsById.values()].find((candidate) => candidate.sessionId === runId);
    return sessionRun ? cloneJson(sessionRun) : null;
  }

  async listRuns(): Promise<RunRecord[]> {
    return [...this.runsById.values()].map((run) => cloneJson(run));
  }

  async listWorkspaces(): Promise<WorkspaceRecord[]> {
    return [];
  }

  async readTranscript(runId: string, page: { offset: number; limit: number }): Promise<TranscriptPage> {
    this.transcriptReadCount += 1;
    const events = this.transcriptEventsByRunId.get(runId) ?? [];
    const pageEvents = events.slice(page.offset, page.offset + page.limit);
    const nextOffset = page.offset + pageEvents.length < events.length ? page.offset + pageEvents.length : null;
    return { runId, offset: page.offset, limit: page.limit, nextOffset, events: pageEvents.map((event) => cloneJson(event)) };
  }

  async readTranscriptTail(runId: string, page: { limit: number }): Promise<TranscriptPage> {
    this.transcriptReadCount += 1;
    const events = this.transcriptEventsByRunId.get(runId) ?? [];
    const offset = Math.max(0, events.length - page.limit);
    const pageEvents = events.slice(offset);
    return { runId, offset, limit: page.limit, nextOffset: null, events: pageEvents.map((event) => cloneJson(event)) };
  }

  async readTranscriptEventCount(runId: string): Promise<number> {
    return this.transcriptEventsByRunId.get(runId)?.length ?? 0;
  }

  asRunTranscriptStore(): RunTranscriptStore {
    return this as unknown as RunTranscriptStore;
  }
}

class FailingTranscriptRunStore extends RecordingRunStore {
  async readTranscript(runId: string, page: { offset: number; limit: number }): Promise<TranscriptPage> {
    this.transcriptReadCount += 1;
    throw new Error(`large durable projection route must not hydrate raw transcript ${runId}:${page.offset}:${page.limit}`);
  }

  async readTranscriptTail(runId: string, page: { limit: number }): Promise<TranscriptPage> {
    this.transcriptReadCount += 1;
    throw new Error(`large durable projection route must not hydrate raw transcript tail ${runId}:${page.limit}`);
  }
}

function projectionSelectorKey(selector: ProjectionRevisionSelector): string {
  return [selector.projectionName, selector.scopeKind ?? "global", selector.scopeKey ?? "global"].join(":");
}

function projectionRevisionSelector(revision: ProjectionRevisionRecord): ProjectionRevisionSelector {
  return { projectionName: revision.projectionName, scopeKind: revision.scopeKind, scopeKey: revision.scopeKey };
}

function transcriptProjectionPageFromScopeKey(scopeKey: string): { runId: string; offset: number; limit: number } | null {
  const match = /^(.*):offset:(\d+):limit:(\d+)$/.exec(scopeKey);
  if (!match) return null;
  return { runId: match[1] ?? "", offset: Number(match[2]), limit: Number(match[3]) };
}

function compareTranscriptDefaultProjectionRecords(left: ProjectionPayloadRecord, right: ProjectionPayloadRecord): number {
  const leftNextOffset = transcriptProjectionRecordNextOffset(left);
  const rightNextOffset = transcriptProjectionRecordNextOffset(right);
  const terminalDelta = Number(rightNextOffset === null) - Number(leftNextOffset === null);
  if (terminalDelta !== 0) return terminalDelta;
  const messageCountDelta = transcriptProjectionRecordMessageCount(right) - transcriptProjectionRecordMessageCount(left);
  if (messageCountDelta !== 0) return messageCountDelta;
  const leftPage = transcriptProjectionPageFromScopeKey(left.revision.scopeKey);
  const rightPage = transcriptProjectionPageFromScopeKey(right.revision.scopeKey);
  return (rightPage?.offset ?? 0) - (leftPage?.offset ?? 0);
}

function transcriptProjectionRecordNextOffset(record: ProjectionPayloadRecord): number | null | undefined {
  const nextOffset = record.revision.sourceCursors["nextOffset"];
  return typeof nextOffset === "number" || nextOffset === null ? nextOffset : undefined;
}

function transcriptProjectionRecordMessageCount(record: ProjectionPayloadRecord): number {
  const eventCount = record.revision.sourceCursors["eventCount"];
  if (typeof eventCount === "number") return eventCount;
  return Array.isArray(record.payload) ? record.payload.length : 0;
}

function projectionPayloadRecordFixture<TPayload>(
  selector: { projectionName: DurableProjectionName; scopeKind: string; scopeKey: string },
  payload: TPayload,
  options: {
    sourceRevisions?: ProjectionSourceRevision[];
    sourceCursors?: ProjectionRevisionRecord["sourceCursors"];
    sourceFreshness?: ProjectionRevisionRecord["sourceFreshness"];
    expiresAt?: string | null;
    revision?: number;
  } = {},
): ProjectionPayloadRecord<TPayload> {
  const generatedAt = "2026-01-01T00:00:00.000Z";
  const revision = options.revision ?? 1;
  return {
    revision: {
      projectionRevisionId: revision,
      projectionName: selector.projectionName,
      scopeKind: selector.scopeKind,
      scopeKey: selector.scopeKey,
      revision,
      buildMode: options.revision === undefined || revision === 1 ? "bootstrap" : "incremental",
      sourceRevisions: options.sourceRevisions ?? [],
      sourceCursors: options.sourceCursors ?? {},
      sourceFreshness: options.sourceFreshness ?? [],
      contentSha256: "0".repeat(64),
      generatedAt,
      expiresAt: options.expiresAt ?? null,
      supersededAt: null,
      createdAt: generatedAt,
    },
    payload: cloneJson(payload),
    payloadSha256: "1".repeat(64),
    rawPayloadRefs: [],
    generatedAt,
    expiresAt: options.expiresAt ?? null,
  };
}

function issueModelFixture() {
  return {
    id: "ENG-179",
    title: "Serve durable web projections",
    status: "progress" as const,
    priority: 1 as const,
    labels: ["durable"],
    assignee: "Ada",
    agent: "worker",
    project: "Symphony",
    cycle: "May 2026",
    activity: [],
    pr: null,
    ci: null,
    workspace: null,
    session: null,
  };
}

function runRecordFixture(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: "run-1",
    sessionId: "session-1",
    agentId: "agent-1",
    role: "worker",
    runPhase: "implementation",
    runKind: "implementation",
    issueId: "issue-id",
    issueIdentifier: "ENG-179",
    attempt: 1,
    turnNumber: 1,
    prompt: "serve durable web projections",
    workspaceKey: "ENG-179",
    workspacePath: path.join("workspaces", "ENG-179"),
    status: "succeeded",
    startedAt: "2026-05-31T00:00:00.000Z",
    updatedAt: "2026-05-31T00:00:00.000Z",
    completedAt: "2026-05-31T00:01:00.000Z",
    error: null,
    tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    transcriptEventCount: 0,
    ...overrides,
  };
}

function historySessionFixture(input: {
  id: string;
  issue: string;
  title: string;
  updatedAt: string;
  msgCount: number;
  lastEvent: string;
  toolCount: number;
  subtitle?: string;
  startedAt?: string;
  agentId?: string;
  state?: "running" | "finished" | "error" | "cancelled" | "queued" | "not_live";
  status?: RunRecord["status"];
  model?: string;
  projectContext?: {
    projectContextId: string;
    projectContextLabel: string;
    linearProjectSlug: string | null;
    routingSource: string;
  };
}) {
  const {
    id,
    issue,
    title,
    updatedAt,
    msgCount,
    lastEvent,
    toolCount,
    subtitle,
    startedAt = updatedAt,
    agentId = "agent-1",
    state = "finished",
    status = "succeeded",
    model = "claude-sonnet-4",
    projectContext = legacyDefaultProjectContext(),
  } = input;
  return {
    id,
    issue,
    title,
    ...(subtitle ? { subtitle } : {}),
    projectContext,
    state,
    model,
    startedAt,
    updatedAt,
    msgCount,
    lastEvent,
    toolCount,
    runSession: {
      runId: id,
      sessionId: id,
      agentId,
      projectContext,
      role: "worker" as const,
      runPhase: "implementation" as const,
      runKind: "implementation" as const,
      attempt: 1,
      turnNumber: 1,
      harnessId: "cursor",
      status,
      startedAt,
      updatedAt,
      completedAt: status === "running" ? null : updatedAt,
      error: null,
      transcriptEventCount: msgCount,
      tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      runtime: {
        model,
        modelParams: [],
        settingSources: [],
        mode: null,
        allowLargeContext: null,
        agentLifecycle: null,
      },
      cursor: {
        model,
        modelParams: [],
        settingSources: [],
        mode: null,
        allowLargeContext: null,
        workerAgentLifecycle: null,
      },
      workspace: {
        key: issue,
        path: path.join("workspaces", issue),
        repoPath: "/repo",
        baseRef: "main",
        branch: `symphony/${issue}`,
      },
      pullRequest: {
        url: null,
        number: null,
        headSha: null,
        branch: null,
        ciStatus: null,
        lastPushedAt: null,
        lastEvidenceCursor: null,
      },
      approval: {
        pendingRequestId: null,
        requestedAt: null,
      },
      cancellation: {
        requestedAt: null,
        source: null,
        reason: null,
        outcome: null,
        harnessStopRequestedAt: null,
        harnessStopFailedAt: null,
        harnessStopFailedReason: null,
        cancelFailed: false,
        cancelFailedAt: null,
        cancelFailedReason: null,
        cancelFailedSource: null,
      },
      failure: {
        kind: null,
        diagnosticCode: null,
        diagnosticMessage: null,
        diagnosticAt: null,
      },
      providerLimit: null,
      links: {
        issue: `/api/v1/web/issues/${encodeURIComponent(issue)}`,
        run: `/api/v1/runs/${encodeURIComponent(id)}`,
        transcript: `/api/v1/web/sessions/${encodeURIComponent(id)}/transcript`,
      },
    },
  };
}

function legacyDefaultProjectContext() {
  return {
    projectContextId: LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
    projectContextLabel: LEGACY_DEFAULT_PROJECT_CONTEXT_LABEL,
    linearProjectSlug: null,
    routingSource: LEGACY_DEFAULT_PROJECT_CONTEXT_ROUTING_SOURCE,
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function projectionRevisionRecordFixture(input: ProjectionPayloadWriteInput, revision: number): ProjectionRevisionRecord {
  return {
    projectionRevisionId: revision,
    projectionName: input.projectionName,
    scopeKind: input.scopeKind ?? "global",
    scopeKey: input.scopeKey ?? "global",
    revision,
    buildMode: revision === 1 ? "bootstrap" : input.buildMode ?? "incremental",
    sourceRevisions: [],
    sourceCursors: {},
    sourceFreshness: [],
    contentSha256: "0".repeat(64),
    generatedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    supersededAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function createStatusServer(
  root: string,
  options: CreateStatusServerOptions = {},
): { server: StatusServer; calls: OrchestratorCallCounts } {
  const config = testConfig(path.join(root, "workspaces"));
  const { orchestrator, calls } = instrumentedOrchestrator();
  return {
    calls,
    server: new StatusServer({
      orchestrator,
      workspaceManager: new WorkspaceManager({
        workspace: config.workspace,
        hooks: config.hooks,
        logger: new StructuredLogger(() => undefined),
      }),
      workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
      defaultProjectContextId: options.defaultProjectContextId,
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: null,
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
      webAssetsRoot: options.webAssetsRoot,
      ...(options.runStore ? { runStore: options.runStore } : {}),
      ...(options.tracker ? { tracker: options.tracker } : {}),
      ...(options.webProjectionContextClock ? { webProjectionContextClock: options.webProjectionContextClock } : {}),
      ...(options.webProjectionContextBuilder ? { webProjectionContextBuilder: options.webProjectionContextBuilder } : {}),
      ...(options.projectionWriter ? { projectionWriter: options.projectionWriter } : {}),
      ...(options.projectionReader ? { projectionReader: options.projectionReader } : {}),
      ...(options.webProjectionRevisionProviders
        ? { webProjectionRevisionProviders: options.webProjectionRevisionProviders }
        : {}),
      ...(options.orchestratorConversationStore
        ? { orchestratorConversationStore: options.orchestratorConversationStore }
        : {}),
    }),
  };
}

function trackerClient(fetchIssuesByStates: TrackerClient["fetchIssuesByStates"]): TrackerClient {
  return {
    async fetchCandidateIssues() {
      return [];
    },
    fetchIssuesByStates,
    async fetchIssueStatesByIds() {
      return [];
    },
  };
}

async function createWebAssets(root: string): Promise<string> {
  const webAssetsRoot = path.join(root, "web-dist");
  const assetDir = path.join(webAssetsRoot, "assets");
  await mkdir(assetDir, { recursive: true });
  await writeFile(
    path.join(webAssetsRoot, "index.html"),
    [
      "<!doctype html>",
      '<html lang="en">',
      "<head>",
      '  <meta charset="UTF-8" />',
      '  <link rel="stylesheet" href="/web/assets/app.css" />',
      "  <title>Symphony static shell</title>",
      "</head>",
      "<body>",
      "  <div id=\"root\">Symphony static shell</div>",
      '  <script type="module" src="/web/assets/app.js"></script>',
      "</body>",
      "</html>",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(path.join(assetDir, "app.css"), "body { color: papayawhip; }\n", "utf8");
  await writeFile(path.join(assetDir, "app.js"), "console.log('symphony static shell');\n", "utf8");
  return webAssetsRoot;
}

function instrumentedOrchestrator(): { orchestrator: Orchestrator; calls: OrchestratorCallCounts } {
  const calls: OrchestratorCallCounts = {
    snapshot: 0,
    getIssueDetails: 0,
    refreshNow: 0,
    pauseIssue: 0,
    resumeIssue: 0,
    cancelIssue: 0,
  };
  return {
    calls,
    orchestrator: {
      snapshot() {
        calls.snapshot += 1;
        return {
          generatedAt: "2026-01-01T00:00:00.000Z",
          counts: { running: 0, retrying: 0, paused: 0 },
          running: [],
          retrying: [],
          paused: [],
          totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
          rateLimits: null,
          providerGates: [],
        };
      },
      getIssueDetails() {
        calls.getIssueDetails += 1;
        return null;
      },
      async refreshNow() {
        calls.refreshNow += 1;
      },
      pauseIssue() {
        calls.pauseIssue += 1;
      },
      resumeIssue() {
        calls.resumeIssue += 1;
      },
      async cancelIssue() {
        calls.cancelIssue += 1;
      },
    } as unknown as Orchestrator,
  };
}

function testTrackerStateLists(): TrackerStateLists {
  return {
    activeStates: ["Todo", "In Progress"],
    handoffStates: ["In Review"],
    reviewStates: ["In Review"],
    blockedStates: ["Blocked"],
    terminalStates: ["Done", "Closed", "Cancelled", "Canceled", "Duplicate"],
  };
}

function baseUrlFor(address: { host: string; port: number }): string {
  return `http://${address.host}:${address.port}`;
}

async function getJson(url: string, init?: RequestInit): Promise<{ response: Response; text: string; body: unknown }> {
  const response = await fetch(url, { headers: { Accept: "application/json" }, ...init });
  const text = await response.text();
  expect(response.headers.get("content-type")).toContain("application/json");
  return { response, text, body: JSON.parse(text) as unknown };
}

function headerJson(response: Response, name: string): unknown {
  const value = response.headers.get(name);
  expect(value).not.toBeNull();
  return JSON.parse(decodeURIComponent(value ?? "null")) as unknown;
}

async function getText(url: string, init?: RequestInit): Promise<{ response: Response; text: string }> {
  const response = await fetch(url, init);
  return { response, text: await response.text() };
}

async function postJson(url: string, body: unknown): Promise<{ response: Response; text: string; body: unknown }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  expect(response.headers.get("content-type")).toContain("application/json");
  return { response, text, body: JSON.parse(text) as unknown };
}

function expectTopLevelKeys(body: unknown, keys: string[]): void {
  expect(body).not.toBeNull();
  expect(Array.isArray(body)).toBe(false);
  expect(Object.keys(body as Record<string, unknown>).sort()).toEqual([...keys].sort());
}

function expectTranscriptWindowPayload(
  body: unknown,
  expectedMessages: readonly Record<string, unknown>[],
  expected: { kind: "page" | "tail"; limit: number },
): void {
  const payload = body as {
    schemaVersion: number;
    messages: readonly Record<string, unknown>[];
    page: {
      offset: number;
      limit: number;
      size: number;
      total: number | null;
      nextOffset: number | null;
      previousOffset: number | null;
      hasNext: boolean;
      hasPrevious: boolean;
      firstSequence: number | null;
      lastSequence: number | null;
      lastEventAt: string | null;
    };
    window: {
      kind: "page" | "tail";
      limit: number;
      size: number;
      total: number | null;
      hasNext: boolean;
      hasPrevious: boolean;
      firstSequence: number | null;
      lastSequence: number | null;
      lastEventAt: string | null;
      tailLimit: number;
      messageCount: number;
      requested: { offset: number | null; limit: number };
    };
    activeTail: {
      enabled: boolean;
      canAppend: boolean;
      runStatus: unknown;
      tailLimit: number;
      afterSequence: number | null;
      lastEventAt: string | null;
      refetchHref: string | null;
    };
    recovery: {
      strategy: "refetch";
      reason: "tail-gap";
      href: string | null;
    };
    compatibility: { responseShape: "transcript_window"; messagesField: "messages" };
  };

  expect(payload).not.toBeNull();
  expect(payload.schemaVersion).toBe(1);
  expect(Array.isArray(payload.messages)).toBe(true);
  expect(payload.messages).toEqual(expectedMessages);
  expect(payload.page).toMatchObject({
    limit: expected.limit,
    size: expectedMessages.length,
  });
  expect(payload.window).toMatchObject({
    kind: expected.kind,
    limit: expected.limit,
    size: expectedMessages.length,
    messageCount: expectedMessages.length,
  });
  expect(payload.activeTail).toMatchObject({
    enabled: expected.kind === "tail" ? expect.any(Boolean) : false,
    canAppend: expected.kind === "tail" ? expect.any(Boolean) : false,
    tailLimit: expect.any(Number),
  });
  expect(payload.recovery).toMatchObject({ strategy: "refetch", reason: "tail-gap" });
  expect(payload.compatibility).toMatchObject({ responseShape: "transcript_window", messagesField: "messages" });
}

function emptyTotals(): Record<string, number> {
  return { backlog: 0, todo: 0, progress: 0, review: 0, done: 0, cancelled: 0, open: 0, all: 0, completeness: 0 };
}
function unavailableDashboardSource(): Record<string, unknown> {
  return {
    status: "unavailable",
    label: "tracker unavailable",
    detail: "Issue board requires a configured tracker client",
    generatedAt: "2026-01-01T00:00:00.000Z",
    trackerFetchedAt: null,
    issueCount: 0,
    runCount: 0,
    lifecycleCount: 0,
    activityCount: 0,
    writebackCount: 0,
    cached: false,
    error: "Issue board requires a configured tracker client",
  };
}

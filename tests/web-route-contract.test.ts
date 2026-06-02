import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CursorWorkspaceOpener } from "../cursor/src/CursorWorkspaceOpener.js";
import { StatusServer, type StatusServerProjectionReader, type StatusServerProjectionWriter } from "../src/app/http.js";
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
import type { RunRecord, RunTranscriptStore, TranscriptEvent, TranscriptPage } from "../src/core/persistence/RunTranscriptStore.js";
import type { TrackerStateLists } from "../src/core/types.js";
import type { TrackerClient } from "../src/core/tracker/TrackerClient.js";
import { WorkspaceManager } from "../src/core/workspace/WorkspaceManager.js";
import { webRouteContractGetFixtureCases, webRouteContractPaths } from "../web/tests/fixtures/webRouteContractFixtures.js";
import { testConfig } from "./helpers.js";

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
          assert: (body, text) => {
            expect(body).toEqual([]);
            expect(text.trim()).toBe("[]");
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
          assert: (body, text) => {
            expect(body).toEqual([]);
            expect(text.trim()).toBe("[]");
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
      sessions: [{ id: "durable-session", title: "Durable session", subtitle: "read model", updatedAt: "2026-05-31T00:00:00.000Z", msgCount: 1, lastEvent: "done", toolCount: 0 }],
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
    const projectionReader = new RecordingProjectionReader([
      projectionPayloadRecordFixture({ projectionName: "dashboard_projection", scopeKind: "global", scopeKey: "global" }, dashboard),
      projectionPayloadRecordFixture({ projectionName: "issue_board_projection", scopeKind: "board", scopeKey: "default-board" }, issueBoard),
      projectionPayloadRecordFixture(
        { projectionName: "history_projection", scopeKind: "global_collection", scopeKey: "global:session:100:timeline:250" },
        history,
      ),
      projectionPayloadRecordFixture({ projectionName: "sidebar_projection", scopeKind: "global", scopeKey: "global" }, sidebar),
      projectionPayloadRecordFixture(
        { projectionName: "orchestrator_chat_projection", scopeKind: "conversation", scopeKey: "operator-room" },
        chat,
      ),
    ]);
    const projectionWriter = new RecordingProjectionWriter();
    const { server, calls } = createStatusServer(root, { projectionReader, projectionWriter });
    const address = await server.start();
    const baseUrl = baseUrlFor(address);
    try {
      const durableDashboard = await getJson(`${baseUrl}/api/v1/web/dashboard`);
      expect(durableDashboard.body).toEqual(dashboard);
      expect(durableDashboard.response.headers.get("x-symphony-projection-status")).toBe("hit");
      expect(durableDashboard.response.headers.get("x-symphony-projection-revision")).toBe("1");
      expect(JSON.parse(decodeURIComponent(durableDashboard.response.headers.get("x-symphony-projection-source-revisions") ?? "[]"))).toEqual([]);
      await expect(getJson(`${baseUrl}/api/v1/web/issues`)).resolves.toMatchObject({ body: issueBoard });
      await expect(getJson(`${baseUrl}/api/v1/web/issues/ENG-179`)).resolves.toMatchObject({
        body: { issue: durableIssue, activity: durableIssue.activity, runs: [], transcript: [] },
      });
      await expect(getJson(`${baseUrl}/api/v1/web/history`)).resolves.toMatchObject({ body: history });
      await expect(getJson(`${baseUrl}/api/v1/web/sidebar`)).resolves.toMatchObject({ body: sidebar });
      await expect(getJson(`${baseUrl}/api/v1/web/orchestrator-chat?conversationId=operator-room`)).resolves.toMatchObject({ body: chat });
      const referenceData = await getJson(`${baseUrl}/api/v1/web/reference-data`);
      expect(referenceData.body).toMatchObject({
        labels: { durable: { name: "durable" } },
        users: { Ada: { name: "Ada" }, worker: { name: "worker" } },
      });
    } finally {
      await server.stop();
    }

    expect(calls.snapshot).toBe(0);
    expect(projectionWriter.writes).toEqual([]);
    expect(projectionReader.selectors.map(({ projectionName, scopeKind, scopeKey }) => ({ projectionName, scopeKind, scopeKey }))).toEqual([
      { projectionName: "dashboard_projection", scopeKind: "global", scopeKey: "global" },
      { projectionName: "issue_board_projection", scopeKind: "board", scopeKey: "default-board" },
      { projectionName: "issue_board_projection", scopeKind: "board", scopeKey: "default-board" },
      { projectionName: "history_projection", scopeKind: "global_collection", scopeKey: "global:session:100:timeline:250" },
      { projectionName: "sidebar_projection", scopeKind: "global", scopeKey: "global" },
      { projectionName: "orchestrator_chat_projection", scopeKind: "conversation", scopeKey: "operator-room" },
      { projectionName: "issue_board_projection", scopeKind: "board", scopeKey: "default-board" },
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
      expect(transcript.body).toEqual(durableTranscript);
      expect(transcript.response.headers.get("x-symphony-projection-status")).toBe("hit");
      expect(transcript.response.headers.get("x-symphony-projection-cache")).toBe("hit");
      expect(JSON.parse(decodeURIComponent(transcript.response.headers.get("x-symphony-projection-source-revisions") ?? "[]"))).toEqual(
        transcriptSourceRevisions,
      );
    } finally {
      await server.stop();
    }

    expect(calls).toEqual({ snapshot: 0, getIssueDetails: 0, refreshNow: 0, pauseIssue: 0, resumeIssue: 0, cancelIssue: 0 });
    expect(runStore.transcriptReadCount).toBe(1);
    expect(projectionWriter.writes).toEqual([]);
    expect(projectionReader.selectors.map(({ projectionName, scopeKind, scopeKey }) => ({ projectionName, scopeKind, scopeKey }))).toEqual([
      { projectionName: "issue_board_projection", scopeKind: "board", scopeKey: "default-board" },
      { projectionName: "issue_board_projection", scopeKind: "board", scopeKey: "default-board" },
      { projectionName: "transcript_projection", scopeKind: "run_page", scopeKey: "run-1:offset:0:limit:500" },
    ]);
  });

  it("falls back to canonical web projection sources when durable read models are stale", async () => {
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
    const projectionReader = new RecordingProjectionReader([
      projectionPayloadRecordFixture(
        { projectionName: "dashboard_projection", scopeKind: "global", scopeKey: "global" },
        staleDashboard,
        { sourceRevisions: [{ source: "runs", revision: "old", observedAt: null }] },
      ),
    ]);
    const projectionWriter = new RecordingProjectionWriter();
    const { server } = createStatusServer(root, {
      projectionReader,
      projectionWriter,
      webProjectionRevisionProviders: [{ source: "runs", getRevision: () => ({ source: "runs", revision: "new", observedAt: null }) }],
    });
    const address = await server.start();
    try {
      const { response, body } = await getJson(`${baseUrlFor(address)}/api/v1/web/dashboard`);
      expect(response.status).toBe(200);
      expect(body).toMatchObject({ projectName: "Symphony", agentUsageLabel: "0 agents" });
      expect(body).not.toEqual(staleDashboard);
      expect(response.headers.get("x-symphony-projection-status")).toBe("stale");
      expect(response.headers.get("x-symphony-projection-cache")).toBe("miss");
      expect(response.headers.get("x-symphony-projection-revision")).toBe("1");
    } finally {
      await server.stop();
    }

    expect(projectionWriter.writeFor("dashboard_projection").projectionName).toBe("dashboard_projection");

    const staleIssue = issueModelFixture();
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
  runStore?: RunTranscriptStore;
  tracker?: TrackerClient;
  webProjectionContextClock?: () => Date;
}

class RecordingProjectionWriter implements StatusServerProjectionWriter {
  readonly writes: ProjectionPayloadWriteInput[] = [];

  async writeProjection(input: ProjectionPayloadWriteInput): Promise<ProjectionWriteResult> {
    this.writes.push(JSON.parse(JSON.stringify(input)) as ProjectionPayloadWriteInput);
    const revision = projectionRevisionRecordFixture(input, this.writes.length);
    return {
      status: "written",
      revision,
      previousRevision: null,
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
    return run ? cloneJson(run) : null;
  }

  async listRuns(): Promise<RunRecord[]> {
    return [...this.runsById.values()].map((run) => cloneJson(run));
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

function projectionSelectorKey(selector: ProjectionRevisionSelector): string {
  return [selector.projectionName, selector.scopeKind ?? "global", selector.scopeKey ?? "global"].join(":");
}

function projectionPayloadRecordFixture<TPayload>(
  selector: { projectionName: DurableProjectionName; scopeKind: string; scopeKey: string },
  payload: TPayload,
  options: { sourceRevisions?: ProjectionSourceRevision[]; expiresAt?: string | null; revision?: number } = {},
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
      sourceRevisions: options.sourceRevisions ?? [],
      sourceCursors: {},
      sourceFreshness: [],
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
      host: "127.0.0.1",
      port: 0,
      openWorkspaceToken: null,
      trackerStateLists: testTrackerStateLists(),
      staleThresholdMs: 300_000,
      webAssetsRoot: options.webAssetsRoot,
      ...(options.runStore ? { runStore: options.runStore } : {}),
      ...(options.tracker ? { tracker: options.tracker } : {}),
      ...(options.webProjectionContextClock ? { webProjectionContextClock: options.webProjectionContextClock } : {}),
      ...(options.projectionWriter ? { projectionWriter: options.projectionWriter } : {}),
      ...(options.projectionReader ? { projectionReader: options.projectionReader } : {}),
      ...(options.webProjectionRevisionProviders
        ? { webProjectionRevisionProviders: options.webProjectionRevisionProviders }
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

function emptyTotals(): Record<string, number> {
  return { backlog: 0, todo: 0, progress: 0, review: 0, done: 0, cancelled: 0, open: 0, all: 0, completeness: 0 };
}

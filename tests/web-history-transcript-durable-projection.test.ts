import { describe, expect, it } from "vitest";
import { StatusServer, type StatusServerProjectionWriter } from "../src/app/http.js";
import type { ProjectionPayloadWriteInput, ProjectionWriteResult } from "../src/core/persistence/ProjectionTransactionService.js";
import {
  InMemoryRunActivityAppendStore,
  type RunActivityAppendInput,
} from "../src/core/persistence/RunActivityAppendStore.js";
import type { OrchestratorConversationStore } from "../src/core/persistence/OrchestratorConversationStore.js";
import type { IssueLifecycleRecord } from "../src/core/persistence/IssueLifecycleStore.js";
import type { RunRecord, RunTranscriptStore, TranscriptEvent } from "../src/core/persistence/RunTranscriptStore.js";
import { mapRunActivityEventToTranscriptEvent } from "../src/core/transcript/RunActivityEventMapper.js";
import type { Issue, TrackerStateLists } from "../src/core/types.js";

describe("web history/transcript durable projection writes", () => {
  it("backfills selected durable projections from source stores with stable scope keys", async () => {
    const projectionWriter = recordingProjectionWriter();
    const run = runFixture({ runId: "run-1", sessionId: "session-1", transcriptEventCount: 3 });
    const server = createStatusServer({
      runStore: runStoreFixture({
        runs: [run],
        transcriptEventsByRunId: new Map([
          [
            run.runId,
            [
              transcriptEventFixture({ runId: run.runId, sequence: 1, message: "first" }),
              transcriptEventFixture({ runId: run.runId, sequence: 2, message: "second" }),
              transcriptEventFixture({ runId: run.runId, sequence: 3, message: "third" }),
            ],
          ],
        ]),
      }),
      projectionWriter,
    });

    const result = await server.rebuildDurableWebProjections({
      projections: ["history_projection", "transcript_projection"],
      historyLimits: { sessionLimit: 1, timelineLimit: 5 },
      transcriptPageLimit: 2,
    });

    expect(result).toMatchObject({ attempted: 4, written: 4, unchanged: 0, skipped: 0, failed: 0 });
    expect(result.entries.map((entry) => [entry.projectionName, entry.scopeKey, entry.status])).toEqual([
      ["history_projection", "global:session:1:timeline:5", "written"],
      ["transcript_projection", "run-1:offset:0:limit:500", "written"],
      ["transcript_projection", "run-1:offset:0:limit:2", "written"],
      ["transcript_projection", "run-1:offset:2:limit:2", "written"],
    ]);
    expect(result.entries.map((entry) => [entry.requestedBuildMode, entry.buildMode])).toEqual([
      ["rebuild", "bootstrap"],
      ["rebuild", "bootstrap"],
      ["rebuild", "bootstrap"],
      ["rebuild", "bootstrap"],
    ]);
    expect(projectionWriter.writes.map((write) => write.projectionName)).toEqual([
      "history_projection",
      "transcript_projection",
      "transcript_projection",
      "transcript_projection",
    ]);
    expect(projectionWriter.writes.every((write) => write.buildMode === "rebuild")).toBe(true);
    expect(projectionWriter.writes[0]).toMatchObject({
      projectionName: "history_projection",
      sourceCursors: { sessionLimit: 1, timelineLimit: 5, sessionCount: 1, defaultSessionId: "run-1" },
      fields: { messageCount: 1 },
    });
    expect(projectionWriter.writes[1]).toMatchObject({
      projectionName: "transcript_projection",
      scopeKey: "run-1:offset:0:limit:500",
      fields: { runId: "run-1", sessionId: "session-1", offsetStart: 0, offsetLimit: 500, nextOffset: null },
    });
    expect(projectionWriter.writes[2]).toMatchObject({
      projectionName: "transcript_projection",
      scopeKey: "run-1:offset:0:limit:2",
      fields: { runId: "run-1", sessionId: "session-1", offsetStart: 0, offsetLimit: 2, nextOffset: 2 },
    });
    expect(projectionWriter.writes[3]).toMatchObject({
      projectionName: "transcript_projection",
      scopeKey: "run-1:offset:2:limit:2",
      fields: { runId: "run-1", sessionId: "session-1", offsetStart: 2, offsetLimit: 2, nextOffset: null },
    });
  });

  it("exposes a token-protected rebuild endpoint with projection filters", async () => {
    const projectionWriter = recordingProjectionWriter();
    const server = createStatusServer({
      openWorkspaceToken: "test-token",
      runStore: runStoreFixture({ runs: [runFixture({ runId: "run-1" })] }),
      projectionWriter,
    });
    const address = await server.start();

    try {
      const missingToken = await postJson(`${baseUrlFor(address)}/api/v1/web/projections/rebuild?projection=history_projection`);
      const invalidProjection = await postJson(
        `${baseUrlFor(address)}/api/v1/web/projections/rebuild?projection=unknown_projection`,
        "test-token",
      );
      const valid = await postJson(
        `${baseUrlFor(address)}/api/v1/web/projections/rebuild?projection=history_projection&sessionLimit=1&timelineLimit=5`,
        "test-token",
      );

      expect(missingToken.response.status).toBe(401);
      expect(invalidProjection.response.status).toBe(400);
      expect(valid.response.status).toBe(200);
      expect(valid.body).toMatchObject({ attempted: 1, written: 1, skipped: 0, failed: 0 });
      expect(valid.body.entries).toMatchObject([
        {
          projectionName: "history_projection",
          scopeKey: "global:session:1:timeline:5",
          status: "written",
          requestedBuildMode: "rebuild",
          buildMode: "bootstrap",
        },
      ]);
      expect(projectionWriter.writes).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  it("reports rebuild attempts as unchanged when the durable projection row is already current", async () => {
    const projectionWriter = statefulProjectionWriter();
    const server = createStatusServer({
      runStore: runStoreFixture({ runs: [runFixture({ runId: "run-1", sessionId: "session-1" })] }),
      projectionWriter,
    });

    const first = await server.rebuildDurableWebProjections({
      projections: ["history_projection"],
      historyLimits: { sessionLimit: 1, timelineLimit: 5 },
    });
    const repeated = await server.rebuildDurableWebProjections({
      projections: ["history_projection"],
      historyLimits: { sessionLimit: 1, timelineLimit: 5 },
    });

    expect(first).toMatchObject({ attempted: 1, written: 1, unchanged: 0, skipped: 0, failed: 0 });
    expect(first.entries).toMatchObject([
      { projectionName: "history_projection", status: "written", requestedBuildMode: "rebuild", buildMode: "bootstrap" },
    ]);
    expect(repeated).toMatchObject({ attempted: 1, written: 0, unchanged: 1, skipped: 0, failed: 0 });
    expect(repeated.entries).toMatchObject([
      { projectionName: "history_projection", status: "unchanged", requestedBuildMode: "rebuild", buildMode: "bootstrap" },
    ]);
    expect(projectionWriter.writes.map((write) => write.buildMode)).toEqual(["rebuild"]);
  });

  it("reports skipped rebuild entries when projection writer or transcript source is unavailable", async () => {
    const server = createStatusServer();

    const result = await server.rebuildDurableWebProjections({
      projections: ["history_projection", "transcript_projection"],
      historyLimits: { sessionLimit: 1, timelineLimit: 5 },
    });

    expect(result).toMatchObject({ attempted: 0, written: 0, unchanged: 0, skipped: 2, failed: 0 });
    expect(result.entries).toMatchObject([
      {
        projectionName: "history_projection",
        scopeKey: "global:session:1:timeline:5",
        status: "skipped",
        requestedBuildMode: "rebuild",
        buildMode: null,
        reason: "Durable projection writer is not configured",
      },
      {
        projectionName: "transcript_projection",
        scopeKey: "*",
        status: "skipped",
        reason: "Run transcript store is not configured",
      },
    ]);
  });

  it("persists bounded history projection rows after serving the canonical response", async () => {
    const projectionWriter = recordingProjectionWriter();
    const server = createStatusServer({
      runStore: runStoreFixture({
        runs: [
          runFixture({ runId: "run-older", issueIdentifier: "TEST-1", updatedAt: "2026-01-01T00:00:00.000Z" }),
          runFixture({ runId: "run-newer", issueIdentifier: "TEST-2", updatedAt: "2026-01-01T00:01:00.000Z" }),
        ],
      }),
      projectionWriter,
    });
    const address = await server.start();

    try {
      const { response, body } = await getJson(`${baseUrlFor(address)}/api/v1/web/history?sessionLimit=1&timelineLimit=5`);

      expect(response.status).toBe(200);
      expect(body.sessions.map((session: { id: string }) => session.id)).toEqual(["run-newer"]);
      expect(projectionWriter.writes).toHaveLength(1);
      expect(projectionWriter.writes[0]).toMatchObject({
        projectionName: "history_projection",
        buildMode: "incremental",
        scopeKind: "global_collection",
        scopeKey: "global:session:1:timeline:5",
        payload: body,
        sourceCursors: {
          sessionLimit: 1,
          timelineLimit: 5,
          sessionCount: 1,
          timelineCount: 4,
          activityCount: 4,
          defaultSessionId: "run-newer",
          runIds: ["run-newer"],
        },
        fields: { messageCount: 1 },
      });
      expect(projectionWriter.writes[0]?.sourceRevisions?.map((revision) => revision.source)).toEqual(
        expect.arrayContaining(["runs", "trackerIssues", "workspaces", "lifecycles", "writebacks"]),
      );
    } finally {
      await server.stop();
    }
  });

  it("persists transcript page projections with run/session/page fields and sanitized payload", async () => {
    const projectionWriter = recordingProjectionWriter();
    const run = runFixture({ runId: "run-1", sessionId: "session-1", transcriptEventCount: 3 });
    const server = createStatusServer({
      runStore: runStoreFixture({
        runs: [run],
        transcriptEventsByRunId: new Map([
          [
            run.runId,
            [
              transcriptEventFixture({ runId: run.runId, sequence: 1, message: "first" }),
              transcriptEventFixture({ runId: run.runId, sequence: 2, message: "visible assistant message" }),
              transcriptEventFixture({ runId: run.runId, sequence: 3, message: "third" }),
            ],
          ],
        ]),
      }),
      projectionWriter,
    });
    const address = await server.start();

    try {
      const { response, body } = await getJson(
        `${baseUrlFor(address)}/api/v1/web/sessions/session-1/transcript?offset=1&limit=1`,
      );

      expect(response.status).toBe(200);
      expect(body).toEqual(projectionWriter.writes[0]?.payload);
      expect(JSON.stringify(body)).toContain("visible assistant message");
      expect(projectionWriter.writes).toHaveLength(1);
      expect(projectionWriter.writes[0]).toMatchObject({
        projectionName: "transcript_projection",
        buildMode: "incremental",
        scopeKind: "run_page",
        scopeKey: "run-1:offset:1:limit:1",
        sourceCursors: {
          runId: "run-1",
          sessionId: "session-1",
          issueKey: "TEST-1",
          offset: 1,
          limit: 1,
          nextOffset: 2,
          eventCount: 1,
          firstSequence: 2,
          lastSequence: 2,
          lastEventAt: "2026-01-01T00:00:02.000Z",
        },
        fields: {
          issueKey: "TEST-1",
          runId: "run-1",
          sessionId: "session-1",
          offsetStart: 1,
          offsetLimit: 1,
          nextOffset: 2,
          messageCount: 3,
        },
      });
      expect(projectionWriter.writes[0]?.sourceRevisions?.map((revision) => revision.source)).toEqual([
        "runs",
        "transcript:run-1",
      ]);
    } finally {
      await server.stop();
    }
  });

  it("rebuilds representative durable projection rows from source-table transcript data after rows are cleared", async () => {
    const projectionWriter = statefulProjectionWriter();
    const run = runFixture({ runId: "run-parity", sessionId: "session-parity", transcriptEventCount: 1_200 });
    const runActivitySourceStore = new InMemoryRunActivityAppendStore();
    const appended = await runActivitySourceStore.appendEvents(
      Array.from({ length: 1_200 }, (_, index) => {
        const sequence = index + 1;
        const text = `durable source message ${sequence}`;
        return runActivityInputFixture({
          id: `activity-parity-${sequence}`,
          runId: run.runId,
          sessionId: run.sessionId,
          sequence,
          at: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
          text,
          payload: { messagePreview: text },
        });
      }),
    );
    expect(appended.rejected).toEqual([]);
    const transcriptEvents = appended.accepted.map((result) =>
      mapRunActivityEventToTranscriptEvent(result.event, { runId: run.runId }),
    );
    const rawTranscriptAvailable = { current: true };
    let rawTranscriptReads = 0;
    const server = createStatusServer({
      runStore: runStoreFixture({
        runs: [run],
        transcriptEventsByRunId: new Map([[run.runId, transcriptEvents]]),
        beforeReadTranscript: () => {
          rawTranscriptReads += 1;
          if (!rawTranscriptAvailable.current) throw new Error("raw events.jsonl unavailable");
        },
      }),
      runActivitySourceStore,
      orchestratorConversationStore: orchestratorConversationStoreFixture([
        {
          id: "chat-message-1",
          conversationId: "orchestrator-default",
          sequence: 1,
          role: "assistant",
          body: "Durable chat summary",
          status: "completed",
          createdAt: "2026-01-01T00:00:03.000Z",
          updatedAt: "2026-01-01T00:00:03.000Z",
          metadata: { issueKey: "TEST-1", runId: run.runId },
          transcriptLinks: [{ runId: run.runId, sequence: 2, eventType: "runtime_log" }],
        },
      ]),
      tracker: trackerFixture([issueFixture()]),
      projectionWriter,
      webProjectionContextClock: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    const address = await server.start();

    try {
      const baseUrl = baseUrlFor(address);
      const liveResponses = [
        await getJson(`${baseUrl}/api/v1/web/dashboard?refresh=1`),
        await getJson(`${baseUrl}/api/v1/web/issues?refresh=1`),
        await getJson(`${baseUrl}/api/v1/web/sidebar?refresh=1`),
        await getJson(`${baseUrl}/api/v1/web/history?refresh=1&sessionLimit=1&timelineLimit=5`),
        await getJson(`${baseUrl}/api/v1/web/sessions/session-parity/transcript`),
        await getJson(`${baseUrl}/api/v1/web/sessions/session-parity/transcript?offset=0&limit=1000`),
        await getJson(`${baseUrl}/api/v1/web/sessions/session-parity/transcript?offset=1000&limit=1000`),
        await getJson(`${baseUrl}/api/v1/web/orchestrator-chat`),
      ];
      expect(liveResponses.map(({ response }) => response.status)).toEqual([200, 200, 200, 200, 200, 200, 200, 200]);
      const liveRows = projectionRowsByKey(projectionWriter.currentRows());
      expect(projectionNames(liveRows)).toEqual([
        "dashboard_projection",
        "history_projection",
        "issue_board_projection",
        "orchestrator_chat_projection",
        "sidebar_projection",
        "transcript_projection",
      ]);

      projectionWriter.clearRows();
      rawTranscriptAvailable.current = false;
      const rawReadsBeforeRebuild = rawTranscriptReads;
      const result = await server.rebuildDurableWebProjections({
        forceRefresh: true,
        historyLimits: { sessionLimit: 1, timelineLimit: 5 },
        transcriptPageLimit: 1_000,
      });

      expect(result).toMatchObject({ attempted: 8, written: 8, unchanged: 0, skipped: 0, failed: 0 });
      expect(rawTranscriptReads).toBe(rawReadsBeforeRebuild);
      const rebuiltRows = projectionRowsByKey(projectionWriter.currentRows());
      expect([...rebuiltRows.keys()].sort()).toEqual([...liveRows.keys()].sort());
      expect(rebuiltRows.has("transcript_projection::run_page::run-parity:offset:700:limit:500")).toBe(true);
      for (const [key, liveRow] of liveRows) {
        const rebuiltRow = rebuiltRows.get(key);
        expect(rebuiltRow).toBeDefined();
        const {
          sourceCursors: liveSourceCursors,
          payload: livePayloadData,
          buildMode: liveBuildMode,
          ...liveRowSummary
        } = liveRow as unknown as Record<string, unknown>;
        const {
          sourceCursors: _rebuiltSourceCursors,
          payload: _rebuiltPayloadData,
          buildMode: _rebuiltBuildMode,
          ...rebuiltRowSummary
        } = rebuiltRow as unknown as Record<string, unknown>;
        expect(rebuiltRowSummary).toMatchObject(liveRowSummary);
        expect(rebuiltRow).toMatchObject({ buildMode: "rebuild" });
      }
    } finally {
      await server.stop();
    }
  });

  it("rebuilds large transcript projections from durable activity pages without raw transcript hydration", async () => {
    const projectionWriter = recordingProjectionWriter();
    const run = runFixture({ runId: "run-large", sessionId: "session-large", transcriptEventCount: 2_050 });
    const durableActivityStore = new InMemoryRunActivityAppendStore();
    const appended = await durableActivityStore.appendEvents(
      Array.from({ length: 2_050 }, (_, index) => {
        const sequence = index + 1;
        const text =
          sequence === 2_050
            ? "durable source message 2050 token=SECRET_DURABLE_TRANSCRIPT_TOKEN"
            : `durable source message ${sequence}`;
        return runActivityInputFixture({
          id: `activity-large-${sequence}`,
          runId: run.runId,
          sessionId: run.sessionId,
          sequence,
          at: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
          text,
          payload: { messagePreview: text },
        });
      }),
    );
    expect(appended.rejected).toEqual([]);
    const durableReadCalls: Array<{ runId: string; offset: number | undefined; limit: number | undefined }> = [];
    const runActivitySourceStore = {
      async readRunEvents(runId: string, options: { offset?: number; limit?: number } = {}) {
        durableReadCalls.push({ runId, offset: options.offset, limit: options.limit });
        return durableActivityStore.readRunEvents(runId, options);
      },
    };
    let rawTranscriptReads = 0;
    const server = createStatusServer({
      runStore: runStoreFixture({
        runs: [run],
        beforeReadTranscript: () => {
          rawTranscriptReads += 1;
          throw new Error("large durable rebuild should not hydrate raw events.jsonl transcript pages");
        },
      }),
      runActivitySourceStore,
      projectionWriter,
    });

    const result = await server.rebuildDurableWebProjections({
      projections: ["transcript_projection"],
      transcriptPageLimit: 1_000,
    });

    expect(result).toMatchObject({ attempted: 4, written: 4, unchanged: 0, skipped: 0, failed: 0 });
    expect(rawTranscriptReads).toBe(0);
    expect(durableReadCalls).toEqual([
      { runId: "run-large", offset: 0, limit: 1 },
      { runId: "run-large", offset: 1_550, limit: 500 },
      { runId: "run-large", offset: 0, limit: 1_000 },
      { runId: "run-large", offset: 1_000, limit: 1_000 },
      { runId: "run-large", offset: 2_000, limit: 1_000 },
    ]);
    expect(projectionWriter.writes.map((write) => write.scopeKey)).toEqual([
      "run-large:offset:1550:limit:500",
      "run-large:offset:0:limit:1000",
      "run-large:offset:1000:limit:1000",
      "run-large:offset:2000:limit:1000",
    ]);
    expect(projectionWriter.writes.map((write) => write.sourceCursors)).toMatchObject([
      { offset: 1_550, limit: 500, eventCount: 500, firstSequence: 1_551, lastSequence: 2_050, nextOffset: null },
      { offset: 0, limit: 1_000, eventCount: 1_000, firstSequence: 1, lastSequence: 1_000, nextOffset: 1_000 },
      { offset: 1_000, limit: 1_000, eventCount: 1_000, firstSequence: 1_001, lastSequence: 2_000, nextOffset: 2_000 },
      { offset: 2_000, limit: 1_000, eventCount: 50, firstSequence: 2_001, lastSequence: 2_050, nextOffset: null },
    ]);
    const serializedWrites = JSON.stringify(projectionWriter.writes);
    expect(serializedWrites).not.toContain("SECRET_DURABLE_TRANSCRIPT_TOKEN");
    expect(serializedWrites).toContain("token=[redacted]");
  });

  it("serves large history views from bounded run slices without transcript hydration", async () => {
    const projectionWriter = recordingProjectionWriter();
    const runs = Array.from({ length: 250 }, (_, index) =>
      runFixture({
        runId: `run-${String(index).padStart(3, "0")}`,
        sessionId: `session-${String(index).padStart(3, "0")}`,
        issueId: `issue-${index}`,
        issueIdentifier: `TEST-${index}`,
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        completedAt: new Date(Date.UTC(2026, 0, 1, 0, 5, index)).toISOString(),
      }),
    );
    let transcriptReads = 0;
    const server = createStatusServer({
      runStore: runStoreFixture({
        runs,
        beforeReadTranscript: () => {
          transcriptReads += 1;
          throw new Error("history projection should not hydrate transcript pages");
        },
      }),
      projectionWriter,
    });
    const address = await server.start();

    try {
      const { response, body } = await getJson(`${baseUrlFor(address)}/api/v1/web/history?sessionLimit=5&timelineLimit=7`);

      expect(response.status).toBe(200);
      expect(body.sessions.map((session: { id: string }) => session.id)).toEqual([
        "run-249",
        "run-248",
        "run-247",
        "run-246",
        "run-245",
      ]);
      expect(body.timeline).toHaveLength(7);
      expect(transcriptReads).toBe(0);
      expect(projectionWriter.writes).toHaveLength(1);
      expect(projectionWriter.writes[0]).toMatchObject({
        projectionName: "history_projection",
        scopeKind: "global_collection",
        scopeKey: "global:session:5:timeline:7",
        sourceCursors: {
          sessionLimit: 5,
          timelineLimit: 7,
          sessionCount: 5,
          timelineCount: 7,
          runIds: ["run-249", "run-248", "run-247", "run-246", "run-245"],
        },
      });
    } finally {
      await server.stop();
    }
  });

  it("rebuilds dashboard and sidebar rows with runtime-authoritative running agents and lifecycle-only issues omitted by the tracker board", async () => {
    const projectionWriter = statefulProjectionWriter();
    const runningRun = runFixture({
      runId: "run-active-only",
      sessionId: "session-active-only",
      issueId: "issue-run-only",
      issueIdentifier: "TEST-RUN-ONLY",
      workspaceKey: "TEST-RUN-ONLY",
      status: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:19:00.000Z",
      completedAt: null,
      tokens: { inputTokens: 10, outputTokens: 15, totalTokens: 25 },
    });
    const lifecycleRecords = [
      lifecycleFixture({ issueId: "issue-run-only", issueIdentifier: "TEST-RUN-ONLY", phase: "implementation" }),
      lifecycleFixture({ issueId: "issue-review-only", issueIdentifier: "TEST-REVIEW-ONLY", phase: "review" }),
    ];
    const server = createStatusServer({
      runStore: runStoreFixture({ runs: [runningRun] }),
      lifecycleStore: lifecycleStoreFixture(lifecycleRecords),
      tracker: trackerFixture([]),
      projectionWriter,
      webProjectionContextClock: () => new Date("2026-01-01T00:20:00.000Z"),
    });
    const address = await server.start();

    try {
      const baseUrl = baseUrlFor(address);
      const routeResponses = [
        await getJson(`${baseUrl}/api/v1/web/dashboard?refresh=1`),
        await getJson(`${baseUrl}/api/v1/web/sidebar?refresh=1`),
      ];
      expect(routeResponses.map(({ response }) => response.status)).toEqual([200, 200]);

      const routeRows = projectionRowsByKey(projectionWriter.currentRows());
      const routeDashboard = routeRows.get("dashboard_projection::global::global")!;
      const routeSidebar = routeRows.get("sidebar_projection::global::global")!;
      expect(routeDashboard).toBeDefined();
      expect(routeSidebar).toBeDefined();

      const routeDashboardPayload = routeDashboard.payload as {
        agentUsageLabel: string;
        runningAgents: Array<{ id: string; issue: string; state: string; tokens: string }>;
        totals: Record<string, number>;
      };
      const routeSidebarPayload = routeSidebar.payload as {
        runningAgents: Array<{ id: string; issue: string; state: string; tokens: string }>;
        totals: Record<string, number>;
      };
      expect(routeDashboardPayload.agentUsageLabel).toBe("0 agents");
      expect(routeDashboardPayload.runningAgents).toEqual([]);
      expect(routeDashboardPayload.totals).toMatchObject({ progress: 1, review: 1, open: 2, all: 2 });
      expect(routeDashboard.sourceCursors).toMatchObject({ issueCount: 2, openIssueCount: 2, runningAgentCount: 0 });
      expect(routeSidebarPayload.runningAgents).toMatchObject(routeDashboardPayload.runningAgents);
      expect(routeSidebarPayload.totals).toMatchObject(routeDashboardPayload.totals);
      expect(routeSidebar.sourceCursors).toMatchObject({ runningAgentCount: 0 });

      projectionWriter.clearRows();
      const result = await server.rebuildDurableWebProjections({
        forceRefresh: true,
        projections: ["dashboard_projection", "sidebar_projection"],
      });

      expect(result).toMatchObject({ attempted: 2, written: 2, unchanged: 0, skipped: 0, failed: 0 });
      const rebuiltRows = projectionRowsByKey(projectionWriter.currentRows());
      const rebuiltDashboard = rebuiltRows.get("dashboard_projection::global::global")!;
      const rebuiltSidebar = rebuiltRows.get("sidebar_projection::global::global")!;
      expect(rebuiltDashboard.payload).toEqual(routeDashboard.payload);
      expect(rebuiltDashboard.sourceCursors).toEqual(routeDashboard.sourceCursors);
      expect(rebuiltSidebar.payload).toEqual(routeSidebar.payload);
      expect(rebuiltSidebar.sourceCursors).toEqual(routeSidebar.sourceCursors);
    } finally {
      await server.stop();
    }
  });

  it("does not block status responses when optional projection persistence fails or no transcript run exists", async () => {
    const projectionWriter = recordingProjectionWriter({ fail: true });
    const server = createStatusServer({
      runStore: runStoreFixture({ runs: [runFixture({ runId: "run-1" })] }),
      projectionWriter,
    });
    const address = await server.start();

    try {
      const history = await getJson(`${baseUrlFor(address)}/api/v1/web/history`);
      const missingTranscript = await getJson(`${baseUrlFor(address)}/api/v1/web/sessions/missing/transcript`);

      expect(history.response.status).toBe(200);
      expect(history.body.sessions.map((session: { id: string }) => session.id)).toEqual(["run-1"]);
      expect(missingTranscript.response.status).toBe(200);
      expect(missingTranscript.body).toMatchObject({
        schemaVersion: 1,
        messages: [],
      });
      expect(projectionWriter.writes).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });
});

function createStatusServer(overrides: Partial<ConstructorParameters<typeof StatusServer>[0]> = {}): StatusServer {
  return new StatusServer({
    orchestrator: fakeOrchestrator(),
    workspaceManager: {} as ConstructorParameters<typeof StatusServer>[0]["workspaceManager"],
    workspaceOpener: {} as ConstructorParameters<typeof StatusServer>[0]["workspaceOpener"],
    host: "127.0.0.1",
    port: 0,
    openWorkspaceToken: null,
    trackerStateLists: testTrackerStateLists(),
    staleThresholdMs: 300_000,
    webAssetsRoot: null,
    ...overrides,
  });
}

function recordingProjectionWriter(options: { fail?: boolean } = {}): StatusServerProjectionWriter & {
  writes: ProjectionPayloadWriteInput[];
} {
  const writes: ProjectionPayloadWriteInput[] = [];
  const revisionsByKey = new Map<string, number>();
  return {
    writes,
    async writeProjection(input: ProjectionPayloadWriteInput): Promise<ProjectionWriteResult> {
      writes.push(JSON.parse(JSON.stringify(input)) as ProjectionPayloadWriteInput);
      if (options.fail) throw new Error("simulated projection persistence failure");
      const key = projectionRowKey(input);
      const revisionNumber = (revisionsByKey.get(key) ?? 0) + 1;
      revisionsByKey.set(key, revisionNumber);
      const requestedBuildMode = input.buildMode ?? "incremental";
      const buildMode = revisionNumber === 1 ? "bootstrap" : requestedBuildMode;
      return {
        status: "written",
        revision: { revision: revisionNumber, buildMode } as ProjectionWriteResult["revision"],
        previousRevision: null,
        requestedBuildMode,
        buildMode,
        contentSha256: "",
        payloadSha256: "",
        event: null,
      };
    },
  };
}

type StatefulProjectionWriter = StatusServerProjectionWriter & {
  writes: ProjectionPayloadWriteInput[];
  currentRows(): ProjectionPayloadWriteInput[];
  clearRows(): void;
};

function statefulProjectionWriter(): StatefulProjectionWriter {
  const writes: ProjectionPayloadWriteInput[] = [];
  const rows = new Map<string, ProjectionPayloadWriteInput>();
  const revisionsByKey = new Map<string, number>();
  const buildModesByKey = new Map<string, ProjectionWriteResult["buildMode"]>();
  return {
    writes,
    currentRows: () => [...rows.values()].map(cloneProjectionWriteInput),
    clearRows: () => {
      rows.clear();
      revisionsByKey.clear();
      buildModesByKey.clear();
    },
    async writeProjection(input: ProjectionPayloadWriteInput): Promise<ProjectionWriteResult> {
      const stored = cloneProjectionWriteInput(input);
      const key = projectionRowKey(stored);
      const existing = rows.get(key);
      const requestedBuildMode = input.buildMode ?? "incremental";
      if (existing && projectionRowsEquivalent(existing, stored)) {
        const revisionNumber = revisionsByKey.get(key) ?? 1;
        const buildMode = buildModesByKey.get(key) ?? "bootstrap";
        return {
          status: "unchanged",
          revision: { revision: revisionNumber, buildMode } as ProjectionWriteResult["revision"],
          previousRevision: { revision: revisionNumber, buildMode } as ProjectionWriteResult["revision"],
          requestedBuildMode,
          buildMode,
          contentSha256: "",
          payloadSha256: "",
          event: null,
        };
      }
      writes.push(stored);
      const revisionNumber = (revisionsByKey.get(key) ?? 0) + 1;
      revisionsByKey.set(key, revisionNumber);
      const buildMode = revisionNumber === 1 ? "bootstrap" : requestedBuildMode;
      buildModesByKey.set(key, buildMode);
      rows.set(key, stored);
      return {
        status: "written",
        revision: { revision: revisionNumber, buildMode } as ProjectionWriteResult["revision"],
        previousRevision: null,
        requestedBuildMode,
        buildMode,
        contentSha256: "",
        payloadSha256: "",
        event: null,
      };
    },
  };
}

function projectionRowsByKey(rows: readonly ProjectionPayloadWriteInput[]): Map<string, ProjectionPayloadWriteInput> {
  return new Map(rows.map((row) => [projectionRowKey(row), row]));
}

function projectionNames(rows: ReadonlyMap<string, ProjectionPayloadWriteInput>): string[] {
  return [...new Set([...rows.values()].map((row) => row.projectionName))].sort();
}

function projectionRowKey(input: ProjectionPayloadWriteInput): string {
  return [input.projectionName, input.scopeKind ?? "global", input.scopeKey ?? "global"].join("::");
}

function projectionRowsEquivalent(left: ProjectionPayloadWriteInput, right: ProjectionPayloadWriteInput): boolean {
  return JSON.stringify(projectionRowWithoutBuildMode(left)) === JSON.stringify(projectionRowWithoutBuildMode(right));
}

function projectionRowWithoutBuildMode(input: ProjectionPayloadWriteInput): ProjectionPayloadWriteInput {
  const clone = cloneProjectionWriteInput(input);
  delete clone.buildMode;
  return clone;
}

function cloneProjectionWriteInput(input: ProjectionPayloadWriteInput): ProjectionPayloadWriteInput {
  return cloneJson(input);
}

function cloneJson<T>(input: T): T {
  return JSON.parse(JSON.stringify(input)) as T;
}

function runStoreFixture(options: {
  runs?: readonly RunRecord[];
  transcriptEventsByRunId?: ReadonlyMap<string, readonly TranscriptEvent[]>;
  beforeReadTranscript?: () => void;
} = {}): RunTranscriptStore {
  const runs = [...(options.runs ?? [])];
  const transcriptEventsByRunId = options.transcriptEventsByRunId ?? new Map<string, readonly TranscriptEvent[]>();
  return {
    projectionRevision: () => 7,
    onProjectionChanged: () => () => undefined,
    async listRuns() {
      return [...runs];
    },
    async listWorkspaces() {
      return [];
    },
    async getRun(runId: string) {
      return runs.find((run) => run.runId === runId) ?? null;
    },
    async readTranscript(runId: string, input: { offset?: number; limit?: number } = {}) {
      options.beforeReadTranscript?.();
      const offset = input.offset ?? 0;
      const limit = input.limit ?? 100;
      const events = [...(transcriptEventsByRunId.get(runId) ?? [])];
      const page = events.slice(offset, offset + limit);
      const nextOffset = offset + page.length < events.length ? offset + page.length : null;
      return { runId, offset, limit, nextOffset, events: page };
    },
    async readTranscriptTail(runId: string, input: { limit?: number } = {}) {
      options.beforeReadTranscript?.();
      const limit = input.limit ?? 100;
      const events = [...(transcriptEventsByRunId.get(runId) ?? [])];
      const offset = Math.max(0, events.length - limit);
      return { runId, offset, limit, nextOffset: null, events: events.slice(offset) };
    },
    async readTranscriptEventCount(runId: string) {
      return transcriptEventsByRunId.get(runId)?.length ?? 0;
    },
  } as unknown as RunTranscriptStore;
}

function lifecycleStoreFixture(
  lifecycleRecords: readonly IssueLifecycleRecord[],
): NonNullable<ConstructorParameters<typeof StatusServer>[0]["lifecycleStore"]> {
  const records = lifecycleRecords.map(cloneJson);
  return {
    projectionRevision: () => 13,
    onProjectionChanged: () => () => undefined,
    async list() {
      return records.map(cloneJson);
    },
    async get(issueIdOrIdentifier: string) {
      const record = records.find(
        (candidate) => candidate.issueId === issueIdOrIdentifier || candidate.issueIdentifier === issueIdOrIdentifier,
      );
      return record ? cloneJson(record) : null;
    },
  } as unknown as NonNullable<ConstructorParameters<typeof StatusServer>[0]["lifecycleStore"]>;
}

function runFixture(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: "run-1",
    sessionId: "session-1",
    agentId: "agent-1",
    role: "worker",
    runPhase: "implementation",
    runKind: "implementation",
    issueId: "issue-1",
    issueIdentifier: "TEST-1",
    attempt: 1,
    turnNumber: 1,
    prompt: "Implement the issue",
    harnessId: "harness-1",
    runtimeModel: "claude-sonnet-4",
    workspaceKey: "TEST-1",
    workspacePath: "/tmp/workspaces/TEST-1",
    gitBranchName: "symphony/TEST-1",
    repoPath: "/tmp/repo",
    baseRef: "main",
    status: "succeeded",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:05:00.000Z",
    error: null,
    tokens: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    transcriptEventCount: 0,
    cancellationOutcome: "none",
    cancelFailed: false,
    ...overrides,
  };
}

function issueFixture(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "TEST-1",
    title: "Representative projection issue",
    description: "Issue used by durable projection rebuild parity coverage.",
    priority: 1,
    state: "In Progress",
    branchName: "symphony/TEST-1",
    url: "https://linear.example/TEST-1",
    assigneeId: "user-1",
    delegateId: null,
    assignedToWorker: true,
    labels: ["dogfood"],
    blockedBy: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function lifecycleFixture(overrides: Partial<IssueLifecycleRecord> = {}): IssueLifecycleRecord {
  const issueId = overrides.issueId ?? "issue-1";
  const issueIdentifier = overrides.issueIdentifier ?? "TEST-1";
  const updatedAt = overrides.updatedAt ?? "2026-01-01T00:10:00.000Z";
  const summaryPointers = {
    workspaceKey: null,
    workspacePath: null,
    branchName: null,
    gitBranchName: null,
    repoPath: null,
    baseRef: null,
    lastRunId: null,
    prUrl: null,
    prNumber: null,
    prHeadSha: null,
    prBranch: null,
    ciStatus: null,
    lastPushedAt: null,
    lastEvidenceCursor: null,
    ...(overrides.summaryPointers ?? {}),
  };
  return {
    issueId,
    issueIdentifier,
    phase: "implementation",
    blockedReason: null,
    updatedAt,
    createdAt: overrides.createdAt ?? updatedAt,
    ...overrides,
    summaryPointers,
  } as IssueLifecycleRecord;
}

function trackerFixture(issues: readonly Issue[]): NonNullable<ConstructorParameters<typeof StatusServer>[0]["tracker"]> {
  return {
    async fetchCandidateIssues() {
      return [...issues];
    },
    async fetchIssuesByStates() {
      return [...issues];
    },
    async fetchIssueStatesByIds() {
      return [...issues];
    },
  } as NonNullable<ConstructorParameters<typeof StatusServer>[0]["tracker"]>;
}

function transcriptEventFixture(overrides: Partial<TranscriptEvent> = {}): TranscriptEvent {
  const sequence = overrides.sequence ?? 1;
  return {
    runId: "run-1",
    sequence,
    at: `2026-01-01T00:00:0${sequence}.000Z`,
    source: "runtime",
    eventType: "assistant",
    message: "assistant message",
    payload: { textPreview: overrides.message ?? "assistant message" },
    ...overrides,
  };
}

function runActivityInputFixture(overrides: Record<string, unknown> = {}): RunActivityAppendInput {
  return {
    id: "activity-1",
    runId: "run-1",
    sessionId: "session-1",
    at: "2026-01-01T00:00:01.000Z",
    harnessId: "runtime-adapter",
    actor: "runtime",
    channel: "status",
    kind: "runtime_log",
    text: "runtime event",
    payload: {},
    protocol: "json_rpc",
    ...overrides,
  } as RunActivityAppendInput;
}

function orchestratorConversationStoreFixture(
  messages: Awaited<ReturnType<OrchestratorConversationStore["listMessages"]>>,
): OrchestratorConversationStore {
  return {
    projectionRevision: () => 11,
    onProjectionChanged: () => () => undefined,
    async listMessages(conversationId?: string | null) {
      const normalized = conversationId ?? "orchestrator-default";
      return messages.filter((message) => message.conversationId === normalized);
    },
    async createConversation() {
      throw new Error("unexpected createConversation call");
    },
    async getConversation() {
      return null;
    },
    async appendMessage() {
      throw new Error("unexpected appendMessage call");
    },
    async updateMessage() {
      throw new Error("unexpected updateMessage call");
    },
  } as OrchestratorConversationStore;
}

function fakeOrchestrator(): ConstructorParameters<typeof StatusServer>[0]["orchestrator"] {
  return {
    snapshot: () => ({
      generatedAt: "2026-01-01T00:00:00.000Z",
      counts: { running: 0, retrying: 0, paused: 0, providerGates: 0 },
      providerGates: [],
      providerGateCounts: { active: 0, manual: 0, autoResume: 0 },
      running: [],
      retrying: [],
      paused: [],
      totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
      rateLimits: null,
    }),
    refreshNow: async () => undefined,
  } as unknown as ConstructorParameters<typeof StatusServer>[0]["orchestrator"];
}

function testTrackerStateLists(): TrackerStateLists {
  return {
    activeStates: ["Todo", "In Progress"],
    blockedStates: ["Blocked"],
    handoffStates: ["In Review"],
    reviewStates: ["Ready to Merge"],
    terminalStates: ["Done", "Canceled"],
  };
}

function baseUrlFor(address: { host: string; port: number }): string {
  return `http://${address.host}:${address.port}`;
}

async function getJson(url: string): Promise<{ response: Response; body: any }> {
  const response = await fetch(url);
  return { response, body: await response.json() };
}

async function postJson(url: string, token?: string): Promise<{ response: Response; body: any }> {
  const request: RequestInit = { method: "POST" };
  if (token) request.headers = { "X-Symphony-Token": token };
  const response = await fetch(url, request);
  return { response, body: await response.json() };
}

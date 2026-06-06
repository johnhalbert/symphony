import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StatusServer, type StatusServerOptions } from "../src/app/http.js";
import {
  REALTIME_EVENT_SCHEMA,
  REALTIME_EVENT_SCHEMA_VERSION,
  RealtimeProjectionEventBus,
  serializeRealtimeEventData,
  serializeSseComment,
  serializeSseEvent,
  type RealtimeProjectionEvent,
  type RealtimeProjectionEventType,
} from "../src/app/RealtimeProjectionEvents.js";
import type { Orchestrator } from "../src/core/orchestrator/Orchestrator.js";
import { FileOrchestratorConversationStore } from "../src/core/persistence/OrchestratorConversationStore.js";
import { InMemoryRunActivityAppendStore, type RunActivityAppendInput } from "../src/core/persistence/RunActivityAppendStore.js";
import type { ProjectionPayloadWriteInput, ProjectionRevisionPublication, ProjectionWriteResult } from "../src/core/persistence/ProjectionTransactionService.js";
import { FileIssueLifecycleStore } from "../src/core/persistence/IssueLifecycleStore.js";
import { FileRunTranscriptStore } from "../src/core/persistence/RunTranscriptStore.js";
import { FileOperatorApprovalStore, OperatorApprovalService } from "../src/core/approval/OperatorApprovalService.js";
import { PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON } from "../src/core/CompletionReportService.js";
import type { TrackerClient } from "../src/core/tracker/TrackerClient.js";
import type { Issue, TrackerStateLists } from "../src/core/types.js";
import { FileWritebackOutboxStore } from "../src/core/writeback/WritebackOutbox.js";
import { testConfig } from "./helpers.js";

describe("StatusServer realtime SSE API", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-realtime-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("serializes revisioned projection-contract SSE events and is safe with no subscribers", () => {
    const bus = new RealtimeProjectionEventBus({
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
      historyLimit: 4,
    });

    const events = bus.publishProjectionRevision({
      source: "runs",
      revision: 7,
      observedAt: "2026-01-01T00:00:00.000Z",
    });
    const projection = requireEvent(events.find((event) => event.type === "projection.updated"));
    const run = requireEvent(events.find((event) => event.type === "run.updated"));
    const transcript = requireEvent(events.find((event) => event.type === "transcript.delta"));
    const source = requireEvent(events.find((event) => event.type === "source.status"));

    expect(bus.subscriberCount()).toBe(0);
    expect([projection.revision, source.revision, run.revision, transcript.revision]).toEqual([1, 2, 3, 4]);
    expect(projection).toMatchObject({
      schema: REALTIME_EVENT_SCHEMA,
      schemaVersion: REALTIME_EVENT_SCHEMA_VERSION,
      id: "1",
      type: "projection.updated",
      scope: "global",
      key: null,
      source: { source: "runs", revision: 7, observedAt: "2026-01-01T00:00:00.000Z" },
      recovery: { strategy: "refetch", reason: "event", lastEventId: null },
      missedEvents: false,
      payload: {
        source: "runs",
        sourceRevision: 7,
        resourceKinds: ["dashboard", "issue-board", "sidebar", "history"],
        resourcesChanged: ["dashboard", "issue-board", "sidebar", "history"],
        detail: null,
      },
      detail: null,
    });
    expect(source).toMatchObject({
      type: "source.status",
      scope: "source",
      key: "runs",
      payload: { source: "runs", sourceRevision: 7, status: null, fetchedStates: [], cached: null, issueCount: null },
    });
    expect(run).toMatchObject({
      type: "run.updated",
      scope: "run",
      key: null,
      payload: { source: "runs", sourceRevision: 7, runId: null, issueId: null, status: null },
    });
    expect(transcript).toMatchObject({
      type: "transcript.delta",
      scope: "session",
      key: null,
      payload: { source: "runs", sourceRevision: 7, runId: null, sessionId: null, afterSequence: null },
    });
    expect(projection.recovery.endpoints).toEqual(
      expect.arrayContaining(["/api/v1/web/dashboard", "/api/v1/web/issues", "/api/v1/web/sidebar"]),
    );
    expect(transcript.recovery.endpoints).toContain("/api/v1/web/sessions/{sessionId}/transcript");

    const runActivityEvents = bus.publishProjectionRevision({
      source: "run_activity",
      revision: 8,
      observedAt: "2026-01-01T00:00:01.000Z",
      detail: {
        source: "run_activity",
        runId: "run-activity-1",
        sessionId: "session-activity-1",
        afterSequence: 2,
        eventCount: 3,
        status: "running",
        resourcesChanged: ["history", "session-transcript"],
      },
    });
    expect(requireEvent(runActivityEvents.find((event) => event.type === "run.updated"))).toMatchObject({
      type: "run.updated",
      scope: "run",
      key: "run-activity-1",
      payload: { source: "run_activity", sourceRevision: 8, runId: "run-activity-1", status: "running" },
    });
    expect(requireEvent(runActivityEvents.find((event) => event.type === "transcript.delta"))).toMatchObject({
      type: "transcript.delta",
      scope: "session",
      key: "session-activity-1",
      payload: {
        source: "run_activity",
        sourceRevision: 8,
        runId: "run-activity-1",
        sessionId: "session-activity-1",
        afterSequence: 2,
        eventCount: 3,
      },
    });
    expect(requireEvent(runActivityEvents.find((event) => event.type === "projection.updated"))).toMatchObject({
      payload: { resourcesChanged: ["history", "session-transcript"] },
    });

    for (const chatSource of [
      "orchestrator_conversations",
      "orchestrator_conversations:orchestrator-default",
      "orchestrator_chat:orchestrator-default",
      "orchestrator-chat",
    ]) {
      const chatEvents = bus.publishProjectionRevision({
        source: chatSource,
        revision: `revision-for-${chatSource}`,
        observedAt: "2026-01-01T00:00:00.000Z",
      });
      const chatMessage = requireEvent(chatEvents.find((event) => event.type === "orchestrator.message"));
      expect(chatMessage).toMatchObject({
        type: "orchestrator.message",
        source: { source: chatSource },
        recovery: { strategy: "refetch", reason: "event", lastEventId: null },
      });
      expect(chatMessage.resources).toEqual(
        expect.arrayContaining([{ kind: "orchestrator-chat", href: "/api/v1/web/orchestrator-chat", relation: "refetch" }]),
      );
      expect(chatMessage.recovery.endpoints).toContain("/api/v1/web/orchestrator-chat");
    }

    const serialized = serializeSseEvent(projection);
    expect(serialized).toContain("id: 1\n");
    expect(serialized).toContain("event: projection.updated\n");
    expect(requireDataLine(serialized)).toBe(serializeRealtimeEventData(projection));
    expect(JSON.parse(requireDataLine(serialized))).toMatchObject({
      schema: REALTIME_EVENT_SCHEMA,
      schemaVersion: REALTIME_EVENT_SCHEMA_VERSION,
      type: "projection.updated",
      revision: 1,
      scope: "global",
      key: null,
      source: { source: "runs", revision: 7 },
      payload: { source: "runs", sourceRevision: 7, resourcesChanged: ["dashboard", "issue-board", "sidebar", "history"] },
    });

    const newlineInjectedFrame = serializeSseEvent({
      ...projection,
      id: "malformed\nid",
      type: "projection.updated\nextra" as RealtimeProjectionEventType,
    });
    expect(newlineInjectedFrame).toContain("id: malformed id\n");
    expect(newlineInjectedFrame).toContain("event: projection.updated extra\n");
    expect(newlineInjectedFrame).not.toContain("id: malformed\nid\n");
    expect(newlineInjectedFrame).not.toContain("event: projection.updated\nextra\n");
    expect(serializeSseComment("keepalive\nignored")).toBe(": keepalive ignored\n\n");
  });

  it("omits unsafe assistant delta patch payloads when canonical transcript patch state is unavailable", () => {
    const bus = new RealtimeProjectionEventBus({ clock: () => new Date("2026-01-01T00:00:00.000Z") });

    const revision = {
      source: "runs",
      revision: 8,
      observedAt: "2026-01-01T00:00:00.000Z",
      detail: {
        runId: "run-midstream",
        sessionId: "session-midstream",
        afterSequence: 41,
        eventCount: 1,
        events: [
          {
            runId: "run-midstream",
            sequence: 42,
            at: "2026-01-01T00:00:42.000Z",
            source: "runtime",
            eventType: "message_delta",
            message: "Hermes message delta",
            payload: { harnessId: "hermes", textPreview: "unsafe", redacted: true },
          },
        ],
      },
    } as Parameters<RealtimeProjectionEventBus["publishProjectionRevision"]>[0] & { detail: Record<string, unknown> };
    const events = bus.publishProjectionRevision(revision);

    const transcript = requireEvent(events.find((event) => event.type === "transcript.delta"));
    expect(transcript).toMatchObject({
      type: "transcript.delta",
      scope: "session",
      key: "session-midstream",
      payload: {
        source: "runs",
        sourceRevision: 8,
        runId: "run-midstream",
        sessionId: "session-midstream",
        afterSequence: 41,
        eventCount: 1,
      },
    });
    expect("messages" in (transcript.payload as unknown as Record<string, unknown>)).toBe(false);
  });

  it("streams keepalive comments with SSE headers and cleans up disconnects", async () => {
    const server = createRealtimeServer({ realtime: { keepAliveIntervalMs: 20 } });
    const address = await server.start();
    const baseUrl = `http://${address.host}:${address.port}`;
    const client = await openSseClient(`${baseUrl}/api/v1/realtime`);

    try {
      expect(client.response.status).toBe(200);
      expect(client.response.headers.get("content-type")).toContain("text/event-stream");
      expect(client.response.headers.get("cache-control")).toContain("no-cache");
      expect(client.response.headers.get("cache-control")).toContain("no-transform");
      expect(client.response.headers.get("x-accel-buffering")).toBe("no");
      await waitFor(() => server.activeRealtimeSubscriberCount() === 1, "SSE subscriber to register");

      await expect(client.nextRawBlock()).resolves.toBe("retry: 5000");
      await expect(client.nextRawBlock(500)).resolves.toBe(": keepalive");

      await client.close();
      await waitFor(() => server.activeRealtimeSubscriberCount() === 0, "SSE subscriber to disconnect");
    } finally {
      await client.close();
      await server.stop();
    }
  });

  it("returns a clear JSON error when realtime transport is unavailable", async () => {
    const server = createRealtimeServer({ realtime: { enabled: false } });
    const address = await server.start();
    const baseUrl = `http://${address.host}:${address.port}`;

    try {
      const response = await fetch(`${baseUrl}/api/v1/realtime`);
      expect(response.status).toBe(503);
      expect(response.headers.get("content-type")).toContain("application/json");
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "realtime_unavailable",
          message: "Realtime event stream is unavailable",
        },
      });
      expect(server.activeRealtimeSubscriberCount()).toBe(0);
    } finally {
      await server.stop();
    }
  });

  it("streams projection, source, run, and transcript updates, replays known Last-Event-ID, and cleans up disconnects", async () => {
    const runStore = new FileRunTranscriptStore(root);
    const server = createRealtimeServer({ runStore });
    const address = await server.start();
    const baseUrl = `http://${address.host}:${address.port}`;
    const client = await openSseClient(`${baseUrl}/api/v1/realtime`);

    try {
      expect(client.response.status).toBe(200);
      expect(client.response.headers.get("content-type")).toContain("text/event-stream");
      await waitFor(() => server.activeRealtimeSubscriberCount() === 1, "SSE subscriber to register");

      await runStore.startRun({
        runId: "run-realtime-1",
        sessionId: "session-realtime-1",
        agentId: "agent-1",
        role: "worker",
        issueId: "issue-1",
        issueIdentifier: "TEST-1",
        attempt: null,
        turnNumber: 1,
        prompt: "work",
        workspaceKey: "TEST-1",
        workspacePath: "/tmp/workspace",
      });

      const projection = await client.nextEventOfType("projection.updated");
      const source = await client.nextEventOfType("source.status");
      const run = await client.nextEventOfType("run.updated");
      const transcript = await client.nextEventOfType("transcript.delta");

      expect(projection.data).toMatchObject({ type: "projection.updated", revision: 1, source: { source: "runs", revision: 1 } });
      expect(source.data).toMatchObject({ type: "source.status", revision: 2, source: { source: "runs", revision: 1 } });
      expect(run.data).toMatchObject({ type: "run.updated", revision: 3, source: { source: "runs", revision: 1 } });
      expect(transcript.data).toMatchObject({ type: "transcript.delta", revision: 4, source: { source: "runs", revision: 1 } });
      expect((run.data as RealtimeProjectionEvent).recovery.endpoints).toContain("/api/v1/web/history");
      expect((transcript.data as RealtimeProjectionEvent).recovery.endpoints).toContain(
        "/api/v1/web/sessions/{sessionId}/transcript",
      );

      await client.close();
      await waitFor(() => server.activeRealtimeSubscriberCount() === 0, "SSE subscriber to disconnect");

      const replayClient = await openSseClient(`${baseUrl}/api/v1/realtime`, { "Last-Event-ID": projection.id });
      try {
        const replayedSource = await replayClient.nextEvent();
        expect(replayedSource.id).toBe(source.id);
        expect(replayedSource.event).toBe("source.status");
      } finally {
        await replayClient.close();
      }
    } finally {
      await client.close();
      await server.stop();
    }
  });

  it("replays known events from lastEventId query cursors without missed-event recovery", async () => {
    const runStore = new FileRunTranscriptStore(root);
    const server = createRealtimeServer({ runStore });
    const address = await server.start();
    const baseUrl = `http://${address.host}:${address.port}`;
    const client = await openSseClient(`${baseUrl}/api/v1/realtime`);

    try {
      await waitFor(() => server.activeRealtimeSubscriberCount() === 1, "SSE subscriber to register");
      await runStore.startRun({
        runId: "run-realtime-query-cursor",
        sessionId: "session-realtime-query-cursor",
        agentId: "agent-1",
        role: "worker",
        issueId: "issue-1",
        issueIdentifier: "TEST-1",
        attempt: null,
        turnNumber: 1,
        prompt: "work",
        workspaceKey: "TEST-1",
        workspacePath: "/tmp/workspace",
      });

      const liveEvents = [
        await client.nextEventOfType("projection.updated"),
        await client.nextEventOfType("source.status"),
        await client.nextEventOfType("run.updated"),
        await client.nextEventOfType("transcript.delta"),
      ];
      await client.close();
      await waitFor(() => server.activeRealtimeSubscriberCount() === 0, "initial SSE subscriber to disconnect");

      const queryReplayClient = await openSseClient(
        `${baseUrl}/api/v1/realtime?lastEventId=${encodeURIComponent(liveEvents[0]!.id)}`,
      );
      try {
        const replayedEvents = [
          await queryReplayClient.nextEvent(),
          await queryReplayClient.nextEvent(),
          await queryReplayClient.nextEvent(),
        ];
        expect(replayedEvents.map((event) => event.id)).toEqual(liveEvents.slice(1).map((event) => event.id));
        expect(replayedEvents.map((event) => event.event)).toEqual(["source.status", "run.updated", "transcript.delta"]);
        for (const replayed of replayedEvents) {
          const data = replayed.data as RealtimeProjectionEvent;
          expect(data.id).toBe(replayed.id);
          expect(data.type).toBe(replayed.event);
          expect(typeof data.revision).toBe("number");
          expect(data.source).toMatchObject({ source: "runs", revision: 1 });
          expect(data.payload).toMatchObject({ source: "runs", sourceRevision: 1 });
          expect(data.missedEvents).toBe(false);
        }
        await expect(queryReplayClient.nextEvent(150)).rejects.toThrow(/Timed out waiting for SSE event/);
      } finally {
        await queryReplayClient.close();
      }
    } finally {
      await client.close();
      await server.stop();
    }
  });

  it("streams run and transcript realtime events from accepted run activity appends", async () => {
    const runActivitySourceStore = new InMemoryRunActivityAppendStore();
    const server = createRealtimeServer({ runActivitySourceStore });
    const address = await server.start();
    const baseUrl = `http://${address.host}:${address.port}`;
    const client = await openSseClient(`${baseUrl}/api/v1/realtime`);

    try {
      await waitFor(() => server.activeRealtimeSubscriberCount() === 1, "SSE subscriber to register");

      await runActivitySourceStore.appendEvents([
        runActivityInput({ id: "activity-realtime-1", sequence: 1 }),
        runActivityInput({ id: "activity-realtime-2", sequence: 2 }),
      ]);

      const projection = await client.nextEventOfType("projection.updated");
      const source = await client.nextEventOfType("source.status");
      const run = await client.nextEventOfType("run.updated");
      const transcript = await client.nextEventOfType("transcript.delta");

      expect(projection.data).toMatchObject({
        type: "projection.updated",
        source: { source: "run_activity", revision: 1 },
        payload: { resourcesChanged: ["history", "session-transcript", "dashboard", "sidebar"] },
      });
      expect(source.data).toMatchObject({
        type: "source.status",
        scope: "source",
        key: "run_activity",
        source: { source: "run_activity", revision: 1 },
      });
      expect(run.data).toMatchObject({
        type: "run.updated",
        scope: "run",
        key: "run-realtime-activity",
        source: { source: "run_activity", revision: 1 },
        payload: { runId: "run-realtime-activity", status: null },
      });
      expect(transcript.data).toMatchObject({
        type: "transcript.delta",
        scope: "session",
        key: "session-realtime-activity",
        source: { source: "run_activity", revision: 1 },
        payload: {
          runId: "run-realtime-activity",
          sessionId: "session-realtime-activity",
          afterSequence: 0,
          eventCount: 2,
        },
      });
    } finally {
      await client.close();
      await server.stop();
    }
  });

  it("suppresses realtime events for duplicate run activity appends", async () => {
    const runActivitySourceStore = new InMemoryRunActivityAppendStore();
    const server = createRealtimeServer({ runActivitySourceStore });
    const address = await server.start();
    const baseUrl = `http://${address.host}:${address.port}`;
    const client = await openSseClient(`${baseUrl}/api/v1/realtime`);

    try {
      await waitFor(() => server.activeRealtimeSubscriberCount() === 1, "SSE subscriber to register");
      const accepted = await runActivitySourceStore.appendEvent(
        runActivityInput({ id: "activity-realtime-duplicate", sequence: 1, externalEventId: "upstream-duplicate" }),
      );
      expect(accepted.status).toBe("accepted");
      await readOrderedRealtimeEvents(client, "run_activity", 1, [
        "projection.updated",
        "source.status",
        "run.updated",
        "transcript.delta",
      ]);

      const duplicate = await runActivitySourceStore.appendEvent(
        runActivityInput({ id: "activity-realtime-duplicate", sequence: 2, externalEventId: "upstream-other" }),
      );
      expect(duplicate).toMatchObject({ status: "duplicate", reason: "event_id" });
      expect(server.activeRealtimeSubscriberCount()).toBe(1);
      await expect(client.nextEvent(150)).rejects.toThrow(/Timed out waiting for SSE event/);
    } finally {
      await client.close();
      await server.stop();
    }
  });

  it("streams realtime and legacy SSE events from durable projection publications to multiple subscribers", async () => {
    const projectionWriter = fakeProjectionWriter();
    const server = createRealtimeServer({ projectionWriter });
    const address = await server.start();
    const baseUrl = `http://${address.host}:${address.port}`;
    const realtimeClient = await openSseClient(`${baseUrl}/api/v1/realtime`);
    const secondRealtimeClient = await openSseClient(`${baseUrl}/api/v1/realtime`);
    const legacyClient = await openSseClient(`${baseUrl}/api/v1/web/events`);

    try {
      await waitFor(() => server.activeRealtimeSubscriberCount() === 2, "both SSE subscribers to register");
      await expect(legacyClient.nextEvent()).resolves.toMatchObject({ event: "projection_ready" });

      const firstRealtimeProjection = realtimeClient.nextEventOfType("projection.updated");
      const secondRealtimeProjection = secondRealtimeClient.nextEventOfType("projection.updated");
      projectionWriter.publish(
        projectionPublication({
          projectionName: "history_projection",
          scopeKind: "global",
          scopeKey: "global",
          projectionRevisionId: "projection-revision-1",
          revision: 3,
          contentSha256: "history-sha",
          generatedAt: "2026-01-01T00:00:02.000Z",
        }),
      );

      const [realtime, secondRealtime] = await Promise.all([firstRealtimeProjection, secondRealtimeProjection]);
      expect(secondRealtime.event).toBe(realtime.event);
      expect(secondRealtime.id).toBe(realtime.id);
      expect(secondRealtime.data).toEqual(realtime.data);
      const [sourceStatus, secondSourceStatus] = await Promise.all([realtimeClient.nextEvent(), secondRealtimeClient.nextEvent()]);
      expect(sourceStatus.event).toBe("source.status");
      expect(secondSourceStatus.event).toBe(sourceStatus.event);
      expect(secondSourceStatus.id).toBe(sourceStatus.id);
      expect(secondSourceStatus.data).toEqual(sourceStatus.data);
      expect(realtime.data).toMatchObject({
        type: "projection.updated",
        source: { source: "history_projection:global:global", revision: 3, observedAt: "2026-01-01T00:00:02.000Z" },
        detail: {
          source: "projection",
          projectionName: "history_projection",
          scopeKind: "global",
          scopeKey: "global",
          resourcesChanged: ["history"],
        },
        payload: { resourcesChanged: ["history"] },
      });
      await expect(legacyClient.nextEvent()).resolves.toMatchObject({
        event: "projection_revision",
        data: {
          type: "projection_revision",
          generation: 1,
          source: "history_projection:global:global",
          revision: 3,
          observedAt: "2026-01-01T00:00:02.000Z",
        },
      });
    } finally {
      await realtimeClient.close();
      await secondRealtimeClient.close();
      await legacyClient.close();
      await waitFor(() => server.activeRealtimeSubscriberCount() === 0, "both SSE subscribers to disconnect");
      await server.stop();
    }
  });

  it("emits typed realtime events and freshness payloads from durable transcript publications and suppresses patchless durable orchestrator chat events", async () => {
    const projectionWriter = fakeProjectionWriter();
    const server = createRealtimeServer({ projectionWriter });
    const address = await server.start();
    const baseUrl = `http://${address.host}:${address.port}`;
    const client = await openSseClient(`${baseUrl}/api/v1/realtime`);

    try {
      await waitFor(() => server.activeRealtimeSubscriberCount() === 1, "SSE subscriber to register");

      projectionWriter.publish(
        projectionPublication({
          projectionName: "transcript_projection",
          scopeKind: "run_page",
          scopeKey: "run-durable-transcript:0:50",
          projectionRevisionId: "projection-revision-transcript",
          revision: 11,
          contentSha256: "transcript-sha",
          generatedAt: "2026-01-01T00:00:03.000Z",
          sourceRevisions: [
            { source: "runs", revision: 10, observedAt: "2026-01-01T00:00:02.000Z" },
            {
              source: "transcript:run-durable-transcript",
              revision: "2:5:2026-01-01T00:00:02.500Z",
              observedAt: "2026-01-01T00:00:02.500Z",
            },
          ],
          sourceCursors: {
            runId: "run-durable-transcript",
            sessionId: "session-durable-transcript",
            issueKey: "ENG-214",
            offset: 0,
            limit: 50,
            nextOffset: 2,
            eventCount: 2,
            firstSequence: 4,
            lastSequence: 5,
            lastEventAt: "2026-01-01T00:00:02.500Z",
          },
          sourceFreshness: [
            {
              source: "run_activity",
              status: "fresh",
              checkedAt: "2026-01-01T00:00:03.000Z",
              revision: 10,
              lastSuccessAt: "2026-01-01T00:00:03.000Z",
              lastErrorAt: null,
              staleMs: null,
              detail: "durable transcript projection is current",
            },
          ],
        }),
      );

      const transcriptProjection = await client.nextEventOfType("projection.updated");
      const transcriptSource = await client.nextEventOfType("source.status");
      const run = await client.nextEventOfType("run.updated");
      const transcript = await client.nextEventOfType("transcript.delta");

      expect(transcriptProjection.data).toMatchObject({
        type: "projection.updated",
        source: {
          source: "transcript_projection:run_page:run-durable-transcript:0:50",
          revision: 11,
          observedAt: "2026-01-01T00:00:03.000Z",
        },
        payload: { resourcesChanged: ["session-transcript", "history"] },
      });
      expect(transcriptSource.data).toMatchObject({
        type: "source.status",
        scope: "source",
        key: "projection",
        source: { source: "transcript_projection:run_page:run-durable-transcript:0:50", revision: 11 },
        detail: {
          projectionName: "transcript_projection",
          sourceRevisions: expect.arrayContaining([
            { source: "runs", revision: 10, observedAt: "2026-01-01T00:00:02.000Z" },
          ]),
          sourceCursors: {
            runId: "run-durable-transcript",
            sessionId: "session-durable-transcript",
            eventCount: 2,
            firstSequence: 4,
            lastSequence: 5,
          },
          sourceFreshness: expect.arrayContaining([
            expect.objectContaining({ source: "run_activity", status: "fresh", revision: 10 }),
          ]),
        },
        payload: {
          status: "fresh",
          fetchedAt: "2026-01-01T00:00:03.000Z",
          sourceCursors: { runId: "run-durable-transcript", sessionId: "session-durable-transcript" },
          sourceFreshness: expect.arrayContaining([
            expect.objectContaining({ source: "run_activity", status: "fresh", checkedAt: "2026-01-01T00:00:03.000Z" }),
          ]),
        },
      });
      expect(run.data).toMatchObject({
        type: "run.updated",
        scope: "run",
        key: "run-durable-transcript",
        payload: { runId: "run-durable-transcript", issueIdentifier: "ENG-214", status: null },
      });
      expect(transcript.data).toMatchObject({
        type: "transcript.delta",
        scope: "session",
        key: "session-durable-transcript",
        payload: {
          runId: "run-durable-transcript",
          sessionId: "session-durable-transcript",
          afterSequence: 3,
          eventCount: 2,
        },
      });

      projectionWriter.publish(
        projectionPublication({
          projectionName: "orchestrator_chat_projection",
          scopeKind: "conversation",
          scopeKey: "operator-room",
          projectionRevisionId: "projection-revision-orchestrator",
          revision: 12,
          contentSha256: "orchestrator-sha",
          generatedAt: "2026-01-01T00:00:04.000Z",
          sourceRevisions: [
            { source: "orchestrator_conversations", revision: 8, observedAt: null },
            { source: "orchestrator_chat:operator-room", revision: "3:message-3:2026-01-01T00:00:03.500Z", observedAt: "2026-01-01T00:00:03.500Z" },
          ],
          sourceCursors: {
            conversationKey: "operator-room",
            conversationStatus: "completed",
            state: "completed",
            messageCount: 3,
            latestMessageSequence: 3,
            latestMessageUpdatedAt: "2026-01-01T00:00:03.500Z",
            lastMessageId: "message-3",
            lastMessageStatus: "completed",
            lastMessageAt: "2026-01-01T00:00:03.500Z",
          },
          sourceFreshness: [
            {
              source: "orchestrator_chat:operator-room",
              status: "fresh",
              checkedAt: "2026-01-01T00:00:04.000Z",
              revision: "3:message-3:2026-01-01T00:00:03.500Z",
              lastSuccessAt: "2026-01-01T00:00:04.000Z",
              lastErrorAt: null,
              staleMs: null,
              detail: "durable orchestrator chat projection is current",
            },
          ],
        }),
      );

      const chatProjection = await client.nextEventOfType("projection.updated");
      const chatSource = await client.nextEventOfType("source.status");

      expect(chatProjection.data).toMatchObject({
        type: "projection.updated",
        source: { source: "orchestrator_chat_projection:conversation:operator-room", revision: 12 },
        payload: { resourcesChanged: ["orchestrator-chat", "sidebar", "dashboard"] },
      });
      expect(chatSource.data).toMatchObject({
        type: "source.status",
        source: { source: "orchestrator_chat_projection:conversation:operator-room", revision: 12 },
        payload: {
          status: "fresh",
          fetchedAt: "2026-01-01T00:00:04.000Z",
          sourceCursors: {
            conversationKey: "operator-room",
            messageCount: 3,
            lastMessageId: "message-3",
            lastMessageStatus: "completed",
          },
          sourceFreshness: expect.arrayContaining([
            expect.objectContaining({ source: "orchestrator_chat:operator-room", status: "fresh" }),
          ]),
        },
      });
      await expect(client.nextEventOfType("orchestrator.message", 150)).rejects.toThrow(/Timed out waiting for SSE event/);
    } finally {
      await client.close();
      await waitFor(() => server.activeRealtimeSubscriberCount() === 0, "SSE subscriber to disconnect");
      await server.stop();
    }
  });

  it("publishes tracker source freshness changes from reference-data, issues, and dashboard refresh paths", async () => {
    let currentIssue = testIssue();
    const tracker = mutableTracker(() => [currentIssue]);
    const server = createRealtimeServer({ tracker });
    const address = await server.start();
    const baseUrl = `http://${address.host}:${address.port}`;
    const client = await openSseClient(`${baseUrl}/api/v1/realtime`);

    try {
      await waitFor(() => server.activeRealtimeSubscriberCount() === 1, "SSE subscriber to register");

      const referenceResponse = await fetch(`${baseUrl}/api/v1/web/reference-data?refresh=1`);
      expect(referenceResponse.status).toBe(200);
      const fresh = await client.nextEventOfType("source.status");
      expect(fresh.data).toMatchObject({
        type: "source.status",
        scope: "source",
        key: "trackerIssues",
        source: { source: "trackerIssues", revision: 1 },
        detail: {
          source: "trackerIssues",
          status: "ok",
          cached: false,
          error: null,
          issueCount: 1,
        },
        payload: {
          source: "trackerIssues",
          sourceRevision: 1,
          status: "ok",
          fetchedStates: expect.arrayContaining(["Todo", "In Progress"]),
          cached: false,
          error: null,
          issueCount: 1,
        },
        recovery: { strategy: "refetch", reason: "event" },
      });
      expect((fresh.data as RealtimeProjectionEvent).recovery.endpoints).toEqual(
        expect.arrayContaining([
          "/api/v1/web/reference-data?refresh=1",
          "/api/v1/web/issues?refresh=1",
          "/api/v1/web/dashboard?refresh=1",
        ]),
      );

      const issuesResponse = await fetch(`${baseUrl}/api/v1/web/issues`);
      expect(issuesResponse.status).toBe(200);
      const cached = await client.nextEventOfType("source.status");
      expect(cached.data).toMatchObject({
        type: "source.status",
        source: { source: "trackerIssues", revision: 2 },
        detail: { status: "ok", cached: true, error: null, issueCount: 1 },
      });

      currentIssue = testIssue({ updatedAt: "2026-01-01T00:00:01.000Z" });
      const dashboardResponse = await fetch(`${baseUrl}/api/v1/web/dashboard?refresh=1`);
      expect(dashboardResponse.status).toBe(200);
      const refreshed = await client.nextEventOfType("source.status");
      expect(refreshed.data).toMatchObject({
        type: "source.status",
        source: { source: "trackerIssues", revision: 3 },
        detail: { status: "ok", cached: false, error: null, issueCount: 1 },
      });
      expect((refreshed.data as RealtimeProjectionEvent).resources).toEqual(
        expect.arrayContaining([{ kind: "dashboard", href: "/api/v1/web/dashboard?refresh=1", relation: "refetch" }]),
      );
    } finally {
      await client.close();
      await server.stop();
    }
  });

  it("publishes ordered writeback outbox realtime events without duplicating idempotent replays", async () => {
    const writebackOutbox = new FileWritebackOutboxStore(path.join(root, "writeback-state"));
    const server = createRealtimeServer({ writebackOutbox });
    const address = await server.start();
    const baseUrl = `http://${address.host}:${address.port}`;
    const client = await openSseClient(`${baseUrl}/api/v1/realtime`);
    const operation = {
      idempotencyKey: "writeback:TEST-1:completion-note",
      kind: "comment" as const,
      issueId: "issue-1",
      runId: "run-writeback-1",
      payload: {
        body: "Durable completion report writeback is ready.",
        dedupeKey: "writeback-sse-dedupe",
      },
    };

    try {
      await waitFor(() => server.activeRealtimeSubscriberCount() === 1, "SSE subscriber to register");

      const enqueued = await writebackOutbox.enqueueOnce(operation);
      const enqueueEvents = await readOrderedRealtimeEvents(client, "writeback", 1, ["projection.updated", "source.status"]);
      expect(enqueueEvents[0]?.resources).toEqual(
        expect.arrayContaining([{ kind: "dashboard", href: "/api/v1/web/dashboard", relation: "refetch" }]),
      );
      expect(enqueueEvents[1]?.resources).toEqual(
        expect.arrayContaining([{ kind: "source", href: "/api/v1/web/reference-data?refresh=1", relation: "refetch" }]),
      );

      const [claimed] = await writebackOutbox.claimDue(new Date(), { idempotencyKeys: [operation.idempotencyKey] });
      expect(claimed).toMatchObject({ idempotencyKey: operation.idempotencyKey, status: "in_flight" });
      await readOrderedRealtimeEvents(client, "writeback", 2, ["projection.updated", "source.status"]);

      await writebackOutbox.markSucceeded(claimed ?? enqueued);
      await readOrderedRealtimeEvents(client, "writeback", 3, ["projection.updated", "source.status"]);

      await expect(writebackOutbox.enqueueOnce(operation)).resolves.toMatchObject({
        idempotencyKey: operation.idempotencyKey,
        status: "succeeded",
      });
      await expect(client.nextEvent(150)).rejects.toThrow(/Timed out waiting for SSE event/);
    } finally {
      await client.close();
      await server.stop();
    }
  });

  it("publishes approval request, lifecycle, and rejected-publication realtime events once across route replay", async () => {
    const config = testConfig(root);
    config.github.publishPullRequests = true;
    config.github.operatorApproval!.requiredForPublication = true;
    config.github.operatorApproval!.rejectPolicy = "cancel";
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const approvalStore = new FileOperatorApprovalStore(config.workspace.stateDir);
    const operatorApproval = new OperatorApprovalService({ config, store: approvalStore, runStore });
    await runStore.startRun({
      runId: "run-approval-1",
      sessionId: "session-approval-1",
      agentId: "agent-1",
      role: "worker",
      issueId: "issue-approval-1",
      issueIdentifier: "TEST-APPROVAL",
      attempt: null,
      turnNumber: 1,
      prompt: "publish completion report",
      workspaceKey: "TEST-APPROVAL",
      workspacePath: path.join(root, "workspace"),
    });
    const server = createRealtimeServer({
      runStore,
      lifecycleStore,
      operatorApproval,
      openWorkspaceToken: "secret",
    });
    const address = await server.start();
    const baseUrl = `http://${address.host}:${address.port}`;
    const client = await openSseClient(`${baseUrl}/api/v1/realtime`);

    try {
      await waitFor(() => server.activeRealtimeSubscriberCount() === 1, "SSE subscriber to register");

      const approval = await operatorApproval.requestPublicationApproval({
        issueId: "issue-approval-1",
        issueIdentifier: "TEST-APPROVAL",
        runId: "run-approval-1",
        evidenceCursor: "approval-evidence-1",
        action: {
          kind: "push_and_pr",
          branchName: "symphony/TEST-APPROVAL",
          baseBranch: "main",
          workspacePath: path.join(root, "workspace"),
          title: "TEST-APPROVAL durable publication",
          evidenceCursor: "approval-evidence-1",
          summaryPreview: "Publication approval required",
          changedFiles: ["tests/realtime-api.test.ts"],
          plannedOperations: ["commit_if_needed", "git_push", "pull_request_create_or_reuse"],
        },
      });
      await readOrderedRealtimeEvents(client, "runs", 2, [
        "projection.updated",
        "source.status",
        "run.updated",
        "transcript.delta",
      ]);
      const requestTranscriptEvents = await readOrderedRealtimeEvents(client, "runs", 3, [
        "projection.updated",
        "source.status",
        "run.updated",
        "transcript.delta",
      ]);
      expect(requestTranscriptEvents[3]?.recovery.endpoints).toContain("/api/v1/web/sessions/{sessionId}/transcript");
      await expect(runStore.readTranscript("run-approval-1", { offset: 0, limit: 10 })).resolves.toMatchObject({
        events: [expect.objectContaining({ eventType: "approval_request" })],
      });

      await lifecycleStore.ensureIssue(
        { id: "issue-approval-1", identifier: "TEST-APPROVAL" },
        {
          phase: "blocked",
          blockedReason: PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON,
          lastCompletionReportId: "report-approval-1",
          completionReports: [
            {
              id: "report-approval-1",
              idempotencyKey: "approval-evidence-1",
              runId: "run-approval-1",
              issueId: "issue-approval-1",
              issueIdentifier: "TEST-APPROVAL",
              summary: "Publication is waiting for operator approval.",
              validationEvidence: ["approval realtime route test"],
              acceptanceChecklist: [{ text: "approval requested", satisfied: true, evidence: "approval request created" }],
              changedFiles: ["tests/realtime-api.test.ts"],
              branchName: "symphony/TEST-APPROVAL",
              pullRequest: null,
              risks: [],
              acceptedAt: "2026-01-01T00:00:00.000Z",
              writebackOperationKeys: [],
            },
          ],
        },
      );
      const lifecycleEvents = await readOrderedRealtimeEvents(client, "lifecycle", 1, ["projection.updated", "source.status"]);
      expect(lifecycleEvents[0]?.resources).toEqual(
        expect.arrayContaining([{ kind: "issue-board", href: "/api/v1/web/issues", relation: "refetch" }]),
      );

      const rejected = await fetch(`${baseUrl}/api/v1/approval-requests/${approval.requestId}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-symphony-token": "secret" },
        body: JSON.stringify({ decision: "reject" }),
      });
      await expect(rejected.json()).resolves.toMatchObject({ replayed: false, request: { status: "rejected" } });
      expect(rejected.status).toBe(200);
      await readOrderedRealtimeEvents(client, "runs", 4, [
        "projection.updated",
        "source.status",
        "run.updated",
        "transcript.delta",
      ]);
      await readOrderedRealtimeEvents(client, "runs", 5, [
        "projection.updated",
        "source.status",
        "run.updated",
        "transcript.delta",
      ]);
      const terminalEvents = await readOrderedRealtimeEvents(client, "runs", 6, [
        "projection.updated",
        "source.status",
        "run.updated",
        "transcript.delta",
      ]);
      expect(terminalEvents[2]?.resources).toEqual(
        expect.arrayContaining([{ kind: "history", href: "/api/v1/web/history", relation: "refetch" }]),
      );
      await expect(runStore.getRun("run-approval-1")).resolves.toMatchObject({
        status: "cancelled",
        pendingApprovalRequestId: null,
        pendingApprovalRequestedAt: null,
      });
      await expect(runStore.readTranscript("run-approval-1", { offset: 0, limit: 10 })).resolves.toMatchObject({
        events: [
          expect.objectContaining({ eventType: "approval_request" }),
          expect.objectContaining({ eventType: "approval_resolved" }),
        ],
      });

      const replay = await fetch(`${baseUrl}/api/v1/approval-requests/${approval.requestId}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-symphony-token": "secret" },
        body: JSON.stringify({ decision: "reject" }),
      });
      await expect(replay.json()).resolves.toMatchObject({ replayed: true, request: { status: "rejected" } });
      expect(replay.status).toBe(200);
      await expect(client.nextEvent(150)).rejects.toThrow(/Timed out waiting for SSE event/);
    } finally {
      await client.close();
      await server.stop();
    }
  });

  it("recovers unknown high Last-Event-ID values without replaying an exact current ID", async () => {
    const runStore = new FileRunTranscriptStore(root);
    const server = createRealtimeServer({ runStore });
    const address = await server.start();
    const baseUrl = `http://${address.host}:${address.port}`;

    try {
      await runStore.startRun({
        runId: "run-realtime-current-id",
        sessionId: "session-realtime-current-id",
        agentId: "agent-1",
        role: "worker",
        issueId: "issue-1",
        issueIdentifier: "TEST-1",
        attempt: null,
        turnNumber: 1,
        prompt: "work",
        workspaceKey: "TEST-1",
        workspacePath: "/tmp/workspace",
      });

      const currentClient = await openSseClient(`${baseUrl}/api/v1/realtime`, { "Last-Event-ID": "4" });
      try {
        await expect(currentClient.nextEvent(150)).rejects.toThrow(/Timed out waiting for SSE event/);
      } finally {
        await currentClient.close();
      }

      const recoveryClient = await openSseClient(`${baseUrl}/api/v1/realtime`, { "Last-Event-ID": "200" });
      try {
        const recovery = await recoveryClient.nextEvent();
        expect(recovery.event).toBe("projection.updated");
        expect(recovery.data).toMatchObject({
          type: "projection.updated",
          missedEvents: true,
          recovery: { strategy: "refetch", reason: "missed-events", lastEventId: "200" },
          payload: {
            resourcesChanged: [
              "dashboard",
              "issue-board",
              "issue-detail",
              "history",
              "sidebar",
              "session-transcript",
              "orchestrator-chat",
              "source",
            ],
          },
        });
        expect((recovery.data as RealtimeProjectionEvent).recovery.endpoints).toEqual(
          expect.arrayContaining([
            "/api/v1/web/reference-data?refresh=1",
            "/api/v1/web/dashboard",
            "/api/v1/web/issues",
            "/api/v1/web/sidebar",
            "/api/v1/web/history",
            "/api/v1/web/orchestrator-chat",
          ]),
        );
        for (const endpoint of [
          "/api/v1/web/reference-data?refresh=1",
          "/api/v1/web/dashboard",
          "/api/v1/web/issues",
          "/api/v1/web/sidebar",
          "/api/v1/web/history",
          "/api/v1/web/orchestrator-chat",
        ]) {
          const refetch = await fetch(`${baseUrl}${endpoint}`);
          expect(refetch.status, `missed-event recovery refetch ${endpoint} should use normal GET semantics`).toBe(200);
          expect(refetch.headers.get("content-type")).toContain("application/json");
          expect(await refetch.json()).toBeTruthy();
        }
      } finally {
        await recoveryClient.close();
      }
    } finally {
      await server.stop();
    }
  });

  it("publishes store-driven transcript deltas with canonical patch payloads for mirrored assistant streams", async () => {
    const runStore = new FileRunTranscriptStore(root);
    await runStore.startRun({
      runId: "run-transcript-patch-1",
      sessionId: "session-transcript-patch-1",
      agentId: "agent-1",
      role: "worker",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      attempt: null,
      turnNumber: 1,
      prompt: "work",
      workspaceKey: "TEST-1",
      workspacePath: "/tmp/workspace",
    });
    const server = createRealtimeServer({ runStore });
    const address = await server.start();
    const baseUrl = `http://${address.host}:${address.port}`;
    const client = await openSseClient(`${baseUrl}/api/v1/realtime`);

    try {
      await waitFor(() => server.activeRealtimeSubscriberCount() === 1, "SSE subscriber to register");
      await runStore.appendEvent({
        runId: "run-transcript-patch-1",
        at: "2026-01-01T00:00:01.000Z",
        source: "runtime",
        eventType: "message_delta",
        message: "Hermes message delta",
        payload: { harnessId: "hermes", textPreview: "Hel", redacted: true },
      });

      const runtimeHel = await client.nextEventOfType("transcript.delta");
      expect(runtimeHel.data).toMatchObject({
        type: "transcript.delta",
        scope: "session",
        key: "session-transcript-patch-1",
        source: { source: "runs", revision: 2 },
        payload: {
          source: "runs",
          sourceRevision: 2,
          runId: "run-transcript-patch-1",
          sessionId: "session-transcript-patch-1",
          afterSequence: 0,
          eventCount: 1,
          messages: [
            {
              sequence: 1,
              operation: "append",
              joinMode: "exact",
              message: { kind: "assistant", ts: "2026-01-01T00:00:01.000Z", text: "Hel" },
            },
          ],
        },
      });
      expect((runtimeHel.data as RealtimeProjectionEvent).recovery.endpoints).toContain("/api/v1/web/sessions/{sessionId}/transcript");

      await runStore.appendEvent({
        runId: "run-transcript-patch-1",
        at: "2026-01-01T00:00:01.100Z",
        source: "harness",
        eventType: "progress",
        message: "Hel",
        payload: { kind: "assistant_delta", activitySource: "delta", progressKind: "assistant_delta", messagePreview: "Hel", redacted: false },
      });
      const harnessHel = await client.nextEventOfType("transcript.delta");
      expect((harnessHel.data as RealtimeProjectionEvent).payload).toMatchObject({
        afterSequence: 1,
        eventCount: 1,
        messages: [{ sequence: 2, message: null }],
      });

      await runStore.appendEvent({
        runId: "run-transcript-patch-1",
        at: "2026-01-01T00:00:02.000Z",
        source: "runtime",
        eventType: "message_delta",
        message: "Hermes message delta",
        payload: { harnessId: "hermes", textPreview: "lo", redacted: true },
      });
      const runtimeLo = await client.nextEventOfType("transcript.delta");
      expect((runtimeLo.data as RealtimeProjectionEvent).payload).toMatchObject({
        afterSequence: 2,
        eventCount: 1,
        messages: [
          {
            sequence: 3,
            operation: "merge-assistant-delta",
            joinMode: "exact",
            message: { kind: "assistant", ts: "2026-01-01T00:00:02.000Z", text: "lo" },
          },
        ],
      });

      await runStore.appendEvent({
        runId: "run-transcript-patch-1",
        at: "2026-01-01T00:00:02.100Z",
        source: "harness",
        eventType: "progress",
        message: "lo",
        payload: { kind: "assistant_delta", activitySource: "delta", progressKind: "assistant_delta", messagePreview: "lo", redacted: false },
      });
      const harnessLo = await client.nextEventOfType("transcript.delta");
      expect((harnessLo.data as RealtimeProjectionEvent).payload).toMatchObject({
        afterSequence: 3,
        eventCount: 1,
        messages: [{ sequence: 4, message: null }],
      });
    } finally {
      await client.close();
      await server.stop();
    }
  });

  it("bounds realtime assistant delta patch state without retaining raw delta text", () => {
    const bus = new RealtimeProjectionEventBus({ clock: () => new Date("2026-01-01T00:00:00.000Z") });
    const stateByRunId = (
      bus as unknown as {
        transcriptPatchStateByRunId: Map<
          string,
          {
            seenAssistantDeltaReplayKeys: Set<string>;
            seenAssistantDeltaReplayKeyOrder: string[];
            assistantDeltaMirrorCounts: { runtime: Map<string, number>; harness: Map<string, number> };
          }
        >;
      }
    ).transcriptPatchStateByRunId;

    for (let sequence = 1; sequence <= 4_200; sequence += 1) {
      const text = `raw-delta-text-that-should-not-be-retained-${sequence}`;
      bus.publish({
        type: "transcript.delta",
        source: { source: "runs", revision: sequence, observedAt: "2026-01-01T00:00:00.000Z" },
        detail: {
          runId: "run-bounded-delta-state",
          sessionId: "session-bounded-delta-state",
          afterSequence: sequence - 1,
          eventCount: 1,
          events: [
            {
              runId: "run-bounded-delta-state",
              sequence,
              at: "2026-01-01T00:00:00.000Z",
              source: "runtime",
              eventType: "message_delta",
              message: "Hermes message delta",
              payload: { harnessId: "hermes", textPreview: text, redacted: true },
            },
          ],
        },
      });
    }

    const state = stateByRunId.get("run-bounded-delta-state");
    expect(state).toBeTruthy();
    expect(state?.seenAssistantDeltaReplayKeys.size).toBeLessThanOrEqual(4_096);
    expect(state?.seenAssistantDeltaReplayKeyOrder).toHaveLength(4_096);
    expect(state?.assistantDeltaMirrorCounts.runtime.size).toBeLessThanOrEqual(4_096);
    const retainedStateKeys = [
      ...(state?.seenAssistantDeltaReplayKeys ?? []),
      ...Array.from(state?.assistantDeltaMirrorCounts.runtime.keys() ?? []),
    ];
    expect(retainedStateKeys.join("\n")).not.toContain("raw-delta-text-that-should-not-be-retained");

    bus.publish({
      type: "transcript.delta",
      source: { source: "runs", revision: 4_201, observedAt: "2026-01-01T00:00:01.000Z" },
      detail: {
        runId: "run-bounded-delta-state",
        sessionId: "session-bounded-delta-state",
        afterSequence: 4_200,
        eventCount: 1,
        events: [
          {
            runId: "run-bounded-delta-state",
            sequence: 4_201,
            at: "2026-01-01T00:00:01.000Z",
            source: "harness",
            eventType: "completed",
            message: "done",
            payload: {},
          },
        ],
      },
    });
    expect(stateByRunId.has("run-bounded-delta-state")).toBe(false);
  });

  it("publishes store-driven assistant and system conversation writes as orchestrator chat realtime events", async () => {
    const orchestratorConversationStore = new FileOrchestratorConversationStore(path.join(root, "chat-state"));
    const server = createRealtimeServer({ orchestratorConversationStore });
    const address = await server.start();
    const baseUrl = `http://${address.host}:${address.port}`;
    const client = await openSseClient(`${baseUrl}/api/v1/realtime`);

    try {
      await waitFor(() => server.activeRealtimeSubscriberCount() === 1, "SSE subscriber to register");

      const assistant = await orchestratorConversationStore.appendMessage({
        conversationId: "operator-room",
        role: "assistant",
        body: "I can help inspect the queue.",
        status: "streaming",
        at: "2026-01-01T00:00:00.000Z",
      });
      const assistantAppend = await client.nextEventOfType("orchestrator.message");
      expect(assistantAppend.data).toMatchObject({
        type: "orchestrator.message",
        source: { source: "orchestrator_conversations", revision: 1 },
        scope: "orchestrator",
        key: "operator-room",
        payload: {
          conversationId: "operator-room",
          conversationStatus: "streaming",
          state: "streaming",
          active: true,
          messageCount: 1,
          latestMessageSequence: 1,
          latestMessageUpdatedAt: "2026-01-01T00:00:00.000Z",
          lastMessageId: assistant.id,
          lastMessageStatus: "streaming",
          chat: [
            expect.objectContaining({
              id: assistant.id,
              conversationId: "operator-room",
              role: "assistant",
              text: "I can help inspect the queue.",
              status: "streaming",
            }),
          ],
          statusSummary: expect.objectContaining({ state: "streaming", active: true, messageCount: 1 }),
        },
        recovery: { strategy: "refetch", reason: "event" },
      });
      expect((assistantAppend.data as RealtimeProjectionEvent).payload).toMatchObject({
        conversationId: "operator-room",
        operation: "append",
        messageCount: 1,
        message: { id: assistant.id, conversationId: "operator-room", who: "agent", role: "assistant", text: "I can help inspect the queue.", status: "streaming" },
        messages: [
          { id: assistant.id, conversationId: "operator-room", who: "agent", role: "assistant", text: "I can help inspect the queue.", status: "streaming" },
        ],
      });
      expect((assistantAppend.data as RealtimeProjectionEvent).resources).toEqual(
        expect.arrayContaining([{ kind: "orchestrator-chat", href: "/api/v1/web/orchestrator-chat", relation: "refetch" }]),
      );
      expect((assistantAppend.data as RealtimeProjectionEvent).recovery.endpoints).toContain(
        "/api/v1/web/orchestrator-chat",
      );

      await orchestratorConversationStore.updateMessage({
        conversationId: assistant.conversationId,
        messageId: assistant.id,
        status: "completed",
        body: "I found the queue summary.",
        at: "2026-01-01T00:00:01.000Z",
      });
      const assistantUpdate = await client.nextEventOfType("orchestrator.message");
      expect(assistantUpdate.data).toMatchObject({
        type: "orchestrator.message",
        source: { source: "orchestrator_conversations", revision: 2 },
        key: "operator-room",
        payload: {
          conversationId: "operator-room",
          conversationStatus: "completed",
          state: "completed",
          active: false,
          terminal: true,
          messageCount: 1,
          latestMessageSequence: 1,
          latestMessageUpdatedAt: "2026-01-01T00:00:01.000Z",
          lastMessageId: assistant.id,
          lastMessageStatus: "completed",
          chat: [
            expect.objectContaining({
              id: assistant.id,
              text: "I found the queue summary.",
              status: "completed",
            }),
          ],
        },
        recovery: { strategy: "refetch", reason: "event" },
      });
      expect((assistantUpdate.data as RealtimeProjectionEvent).payload).toMatchObject({
        conversationId: "operator-room",
        operation: "update",
        messageCount: 1,
        message: { id: assistant.id, conversationId: "operator-room", who: "agent", role: "assistant", text: "I found the queue summary.", status: "completed" },
        messages: [
          { id: assistant.id, conversationId: "operator-room", who: "agent", role: "assistant", text: "I found the queue summary.", status: "completed" },
        ],
      });
      expect((assistantUpdate.data as RealtimeProjectionEvent).recovery.endpoints).toContain(
        "/api/v1/web/orchestrator-chat",
      );

      await orchestratorConversationStore.appendMessage({
        conversationId: "operator-room",
        role: "system",
        body: "System note: summary persisted.",
        status: "completed",
        at: "2026-01-01T00:00:02.000Z",
      });
      const systemAppend = await client.nextEventOfType("orchestrator.message");
      expect(systemAppend.data).toMatchObject({
        type: "orchestrator.message",
        source: { source: "orchestrator_conversations", revision: 3 },
        key: "operator-room",
        payload: {
          conversationId: "operator-room",
          conversationStatus: "completed",
          state: "completed",
          messageCount: 2,
          latestMessageSequence: 2,
          latestMessageUpdatedAt: "2026-01-01T00:00:02.000Z",
          chat: [
            expect.objectContaining({ id: assistant.id, text: "I found the queue summary." }),
            expect.objectContaining({ role: "system", text: "System note: summary persisted.", status: "completed" }),
          ],
        },
        recovery: { strategy: "refetch", reason: "event" },
      });
      expect((systemAppend.data as RealtimeProjectionEvent).resources).toEqual(
        expect.arrayContaining([{ kind: "orchestrator-chat", href: "/api/v1/web/orchestrator-chat", relation: "refetch" }]),
      );
    } finally {
      await client.close();
      await server.stop();
    }
  });

  it("emits missed-event recovery hints, replays post-recovery publications, and orchestrator chat message events", async () => {
    const orchestratorConversationStore = new FileOrchestratorConversationStore(path.join(root, "chat-state"));
    const projectionWriter = fakeProjectionWriterPublishingWrites();
    const server = createRealtimeServer({ orchestratorConversationStore, projectionWriter });
    const address = await server.start();
    const baseUrl = `http://${address.host}:${address.port}`;

    try {
      let recoveryId = "";
      const recoveryClient = await openSseClient(`${baseUrl}/api/v1/realtime`, { "Last-Event-ID": "0" });
      try {
        const recovery = await recoveryClient.nextEvent();
        recoveryId = recovery.id;
        expect(recovery.event).toBe("projection.updated");
        expect(recovery.data).toMatchObject({
          type: "projection.updated",
          missedEvents: true,
          recovery: { strategy: "refetch", reason: "missed-events", lastEventId: "0" },
        });
        expect((recovery.data as RealtimeProjectionEvent).recovery.endpoints).toEqual(
          expect.arrayContaining(["/api/v1/web/dashboard", "/api/v1/web/issues", "/api/v1/web/history"]),
        );
      } finally {
        await recoveryClient.close();
      }

      const recoveryCursorClient = await openSseClient(`${baseUrl}/api/v1/realtime`, { "Last-Event-ID": recoveryId });
      try {
        await expect(recoveryCursorClient.nextEvent(150)).rejects.toThrow(/Timed out waiting for SSE event/);
      } finally {
        await recoveryCursorClient.close();
      }

      projectionWriter.publish(
        projectionPublication({
          projectionName: "history_projection",
          scopeKind: "global",
          scopeKey: "global",
          projectionRevisionId: "projection-revision-after-recovery",
          revision: 23,
          contentSha256: "history-after-recovery-sha",
          generatedAt: "2026-01-01T00:00:23.000Z",
        }),
      );

      const recoveryReplayClient = await openSseClient(`${baseUrl}/api/v1/realtime`, { "Last-Event-ID": recoveryId });
      try {
        const replayedProjection = await recoveryReplayClient.nextEvent();
        expect(replayedProjection.event).toBe("projection.updated");
        expect(replayedProjection.data).toMatchObject({
          type: "projection.updated",
          missedEvents: false,
          source: { source: "history_projection:global:global", revision: 23, observedAt: "2026-01-01T00:00:23.000Z" },
          recovery: { strategy: "refetch", reason: "event", lastEventId: null },
          payload: { resourcesChanged: ["history"] },
        });
        expect((replayedProjection.data as RealtimeProjectionEvent).recovery.endpoints).toContain("/api/v1/web/history");

        const replayedSource = await recoveryReplayClient.nextEvent();
        expect(replayedSource.event).toBe("source.status");
        expect(replayedSource.data).toMatchObject({
          type: "source.status",
          missedEvents: false,
          source: { source: "history_projection:global:global", revision: 23 },
          recovery: { strategy: "refetch", reason: "event", lastEventId: null },
        });
        await expect(recoveryReplayClient.nextEvent(150)).rejects.toThrow(/Timed out waiting for SSE event/);
      } finally {
        await recoveryReplayClient.close();
      }

      const chatClient = await openSseClient(`${baseUrl}/api/v1/realtime`);
      try {
        const chatResponse = await fetch(`${baseUrl}/api/v1/web/orchestrator-chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input: "hello from the operator" }),
        });
        expect(chatResponse.status).toBe(202);
        await expect(chatResponse.json()).resolves.toMatchObject([{ text: "hello from the operator" }]);

        const storeChat = await chatClient.nextEventOfType("orchestrator.message");
        expect(storeChat.data).toMatchObject({
          type: "orchestrator.message",
          source: { source: "orchestrator_conversations" },
          recovery: { strategy: "refetch", reason: "event" },
        });
        expect((storeChat.data as RealtimeProjectionEvent).recovery.endpoints).toContain(
          "/api/v1/web/orchestrator-chat",
        );

        const projectionSource = "orchestrator_chat_projection:conversation:orchestrator-default";
        const persistedProjection = await nextEventOfTypeFromSource(chatClient, "projection.updated", projectionSource);
        expect(persistedProjection.data).toMatchObject({
          type: "projection.updated",
          source: { source: projectionSource, revision: expect.any(Number) },
          payload: { resourcesChanged: ["orchestrator-chat", "sidebar", "dashboard"] },
        });

        const persistedFreshness = await nextEventOfTypeFromSource(chatClient, "source.status", projectionSource);
        expect(persistedFreshness.data).toMatchObject({
          type: "source.status",
          source: { source: projectionSource, revision: expect.any(Number) },
          payload: {
            sourceCursors: {
              conversationKey: "orchestrator-default",
              messageCount: 1,
              lastMessageId: expect.any(String),
              lastMessageStatus: "pending",
            },
          },
        });

        const chat = await nextEventOfTypeFromSource(chatClient, "orchestrator.message", "orchestrator-chat");
        expect(chat.data).toMatchObject({
          type: "orchestrator.message",
          scope: "orchestrator",
          key: "orchestrator-default",
          source: { source: "orchestrator-chat" },
          detail: {
            inputLength: "hello from the operator".length,
            messageCount: 1,
            conversationId: "orchestrator-default",
            status: 202,
          },
          payload: {
            source: "orchestrator-chat",
            conversationId: "orchestrator-default",
            inputLength: "hello from the operator".length,
            messageCount: 1,
            status: 202,
            state: "pending",
            conversationStatus: "pending",
            active: true,
            latestMessageSequence: 1,
            latestMessageUpdatedAt: expect.any(String),
            message: expect.objectContaining({
              conversationId: "orchestrator-default",
              role: "user",
              text: "hello from the operator",
              status: "pending",
            }),
            messages: [
              expect.objectContaining({
                conversationId: "orchestrator-default",
                role: "user",
                text: "hello from the operator",
                status: "pending",
              }),
            ],
            chat: [
              expect.objectContaining({
                conversationId: "orchestrator-default",
                role: "user",
                text: "hello from the operator",
                status: "pending",
              }),
            ],
            statusSummary: expect.objectContaining({ state: "pending", active: true, messageCount: 1 }),
          },
          recovery: { strategy: "refetch", reason: "event" },
        });
        expect((chat.data as RealtimeProjectionEvent).recovery.endpoints).toContain("/api/v1/web/orchestrator-chat");
        await expect(nextEventOfTypeFromSource(chatClient, "orchestrator.message", projectionSource, 150)).rejects.toThrow(
          /Timed out waiting for SSE event/,
        );
      } finally {
        await chatClient.close();
      }
    } finally {
      await server.stop();
    }
  });

  it.each(["pending", "dispatching"] as const)(
    "does not publish orchestrator.message for idempotent %s web chat POST replays",
    async (commandStatus) => {
      const orchestratorConversationStore = new FileOrchestratorConversationStore(
        path.join(root, `chat-state-replay-${commandStatus}`),
      );
      const messageId = `operator-replay-${commandStatus}`;
      await orchestratorConversationStore.appendMessage({
        conversationId: "operator-room",
        id: messageId,
        role: "user",
        body: "please retry safely",
        status: "pending",
        at: "2026-01-01T00:00:00.000Z",
        metadata: {
          source: "web_orchestrator_chat",
          action: "orchestrator.chat.post",
          actionDispatched: commandStatus === "dispatching",
          commandStatus,
        },
      });

      let dispatchCalls = 0;
      const orchestrator = fakeOrchestrator();
      orchestrator.dispatchOrchestratorChatCommand = async () => {
        dispatchCalls += 1;
        return { status: "accepted", reason: "accepted", acceptedAt: "2026-01-01T00:00:00.000Z" };
      };
      const server = createRealtimeServer({ orchestratorConversationStore, orchestrator });
      const address = await server.start();
      const baseUrl = `http://${address.host}:${address.port}`;
      const client = await openSseClient(`${baseUrl}/api/v1/realtime`);

      try {
        await waitFor(() => server.activeRealtimeSubscriberCount() === 1, "SSE subscriber to register");

        const replayResponse = await fetch(`${baseUrl}/api/v1/web/orchestrator-chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            conversationId: "operator-room",
            messageId,
            input: "please retry safely",
          }),
        });
        expect(replayResponse.status).toBe(202);
        await expect(replayResponse.json()).resolves.toMatchObject([
          {
            id: messageId,
            conversationId: "operator-room",
            role: "user",
            text: "please retry safely",
            status: "pending",
          },
        ]);
        expect(dispatchCalls).toBe(0);
        await expect(client.nextEventOfType("orchestrator.message", 200)).rejects.toThrow(
          /Timed out waiting for SSE event/,
        );
      } finally {
        await client.close();
        await server.stop();
      }
    },
  );

  it("replays orchestrator chat events after Last-Event-ID without duplicating the cursor event", async () => {
    const orchestratorConversationStore = new FileOrchestratorConversationStore(path.join(root, "chat-state-replay-cursor"));
    const server = createRealtimeServer({ orchestratorConversationStore });
    const address = await server.start();
    const baseUrl = `http://${address.host}:${address.port}`;
    const client = await openSseClient(`${baseUrl}/api/v1/realtime`);

    try {
      await waitFor(() => server.activeRealtimeSubscriberCount() === 1, "SSE subscriber to register");

      await orchestratorConversationStore.appendMessage({
        conversationId: "operator-room",
        role: "assistant",
        body: "First chat event",
        status: "streaming",
        at: "2026-01-01T00:00:00.000Z",
      });
      const first = await client.nextEventOfType("orchestrator.message");
      await orchestratorConversationStore.appendMessage({
        conversationId: "operator-room",
        role: "assistant",
        body: "Second chat event",
        status: "completed",
        at: "2026-01-01T00:00:01.000Z",
      });
      const second = await client.nextEventOfType("orchestrator.message");

      const replayClient = await openSseClient(`${baseUrl}/api/v1/realtime`, { "Last-Event-ID": first.id });
      try {
        const replayed = await replayClient.nextEventOfType("orchestrator.message");
        expect(replayed.id).toBe(second.id);
        expect(replayed.data).toMatchObject({
          type: "orchestrator.message",
          source: { source: "orchestrator_conversations" },
          payload: {
            conversationId: "operator-room",
            messageCount: 2,
            chat: [
              expect.objectContaining({ text: "First chat event" }),
              expect.objectContaining({ text: "Second chat event", status: "completed" }),
            ],
          },
        });
        await expect(replayClient.nextEventOfType("orchestrator.message", 200)).rejects.toThrow(
          /Timed out waiting for SSE event/,
        );
      } finally {
        await replayClient.close();
      }

      const cursorClient = await openSseClient(`${baseUrl}/api/v1/realtime`, { "Last-Event-ID": second.id });
      try {
        await expect(cursorClient.nextEventOfType("orchestrator.message", 200)).rejects.toThrow(
          /Timed out waiting for SSE event/,
        );
      } finally {
        await cursorClient.close();
      }
    } finally {
      await client.close();
      await server.stop();
    }
  });

  it.each([
    { resultStatus: "failed" as const, httpStatus: 500 },
    { resultStatus: "unavailable" as const, httpStatus: 503 },
  ])(
    "publishes $resultStatus orchestrator chat POST results as orchestrator.message SSE status events",
    async ({ resultStatus, httpStatus }) => {
      const orchestratorConversationStore = new FileOrchestratorConversationStore(
        path.join(root, `chat-state-${resultStatus}`),
      );
      const projectionWriter = fakeProjectionWriterPublishingWrites();
      const orchestrator = fakeOrchestrator();
      orchestrator.dispatchOrchestratorChatCommand = async () => ({
        status: resultStatus,
        reason: `test_${resultStatus}`,
      });
      const server = createRealtimeServer({ orchestratorConversationStore, orchestrator, projectionWriter });
      const address = await server.start();
      const baseUrl = `http://${address.host}:${address.port}`;
      const client = await openSseClient(`${baseUrl}/api/v1/realtime`);

      try {
        await waitFor(() => server.activeRealtimeSubscriberCount() === 1, "SSE subscriber to register");

        const response = await fetch(`${baseUrl}/api/v1/web/orchestrator-chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input: `trigger ${resultStatus}` }),
        });
        expect(response.status).toBe(httpStatus);
        await expect(response.json()).resolves.toMatchObject({
          error: {
            code: resultStatus === "failed" ? "orchestrator_chat_dispatch_failed" : "orchestrator_chat_unavailable",
          },
          chat: [
            expect.objectContaining({
              conversationId: "orchestrator-default",
              role: "user",
              text: `trigger ${resultStatus}`,
              status: resultStatus,
            }),
          ],
        });

        const projectionSource = "orchestrator_chat_projection:conversation:orchestrator-default";
        const persistedProjection = await nextEventOfTypeFromSource(client, "projection.updated", projectionSource);
        expect(persistedProjection.data).toMatchObject({
          type: "projection.updated",
          source: { source: projectionSource, revision: expect.any(Number) },
          payload: { resourcesChanged: ["orchestrator-chat", "sidebar", "dashboard"] },
        });

        const persistedFreshness = await nextEventOfTypeFromSource(client, "source.status", projectionSource);
        expect(persistedFreshness.data).toMatchObject({
          type: "source.status",
          source: { source: projectionSource, revision: expect.any(Number) },
          payload: {
            sourceCursors: {
              conversationKey: "orchestrator-default",
              messageCount: 1,
              lastMessageId: expect.any(String),
              lastMessageStatus: resultStatus,
            },
          },
        });

        const chat = await nextEventOfTypeFromSource(client, "orchestrator.message", "orchestrator-chat");
        expect(chat.data).toMatchObject({
          type: "orchestrator.message",
          scope: "orchestrator",
          key: "orchestrator-default",
          source: { source: "orchestrator-chat" },
          detail: {
            inputLength: `trigger ${resultStatus}`.length,
            messageCount: 1,
            conversationId: "orchestrator-default",
            status: httpStatus,
            state: resultStatus,
            conversationStatus: resultStatus,
            active: false,
            terminal: true,
            lastMessageStatus: resultStatus,
          },
          payload: {
            source: "orchestrator-chat",
            conversationId: "orchestrator-default",
            inputLength: `trigger ${resultStatus}`.length,
            messageCount: 1,
            status: httpStatus,
            state: resultStatus,
            conversationStatus: resultStatus,
            active: false,
            terminal: true,
            lastMessageStatus: resultStatus,
            chat: [
              expect.objectContaining({
                conversationId: "orchestrator-default",
                role: "user",
                text: `trigger ${resultStatus}`,
                status: resultStatus,
              }),
            ],
          },
          recovery: { strategy: "refetch", reason: "event" },
        });
        expect((chat.data as RealtimeProjectionEvent).recovery.endpoints).toContain("/api/v1/web/orchestrator-chat");
        await expect(nextEventOfTypeFromSource(client, "orchestrator.message", projectionSource, 150)).rejects.toThrow(
          /Timed out waiting for SSE event/,
        );
      } finally {
        await client.close();
        await server.stop();
      }
    },
  );
});

interface ParsedSseEvent {
  id: string;
  event: string;
  data: unknown;
  raw: string;
}

interface SseTestClient {
  response: Response;
  nextRawBlock(timeoutMs?: number): Promise<string>;
  nextEvent(timeoutMs?: number): Promise<ParsedSseEvent>;
  nextEventOfType(type: RealtimeProjectionEventType, timeoutMs?: number): Promise<ParsedSseEvent>;
  close(): Promise<void>;
}

function createRealtimeServer(
  options: {
    runStore?: FileRunTranscriptStore;
    runActivitySourceStore?: InMemoryRunActivityAppendStore;
    tracker?: TrackerClient;
    orchestratorConversationStore?: FileOrchestratorConversationStore;
    projectionWriter?: StatusServerOptions["projectionWriter"];
    lifecycleStore?: FileIssueLifecycleStore;
    writebackOutbox?: FileWritebackOutboxStore;
    operatorApproval?: StatusServerOptions["operatorApproval"];
    orchestrator?: Orchestrator;
    openWorkspaceToken?: string | null;
    realtime?: StatusServerOptions["realtime"];
  } = {},
): StatusServer {
  return new StatusServer({
    orchestrator: options.orchestrator ?? fakeOrchestrator(),
    workspaceManager: {} as StatusServerOptions["workspaceManager"],
    workspaceOpener: {} as StatusServerOptions["workspaceOpener"],
    ...(options.runStore ? { runStore: options.runStore } : {}),
    ...(options.runActivitySourceStore ? { runActivitySourceStore: options.runActivitySourceStore } : {}),
    ...(options.tracker ? { tracker: options.tracker } : {}),
    ...(options.orchestratorConversationStore
      ? { orchestratorConversationStore: options.orchestratorConversationStore }
      : {}),
    ...(options.projectionWriter ? { projectionWriter: options.projectionWriter } : {}),
    ...(options.lifecycleStore ? { lifecycleStore: options.lifecycleStore } : {}),
    ...(options.writebackOutbox ? { writebackOutbox: options.writebackOutbox } : {}),
    ...(options.operatorApproval ? { operatorApproval: options.operatorApproval } : {}),
    host: "127.0.0.1",
    port: 0,
    openWorkspaceToken: options.openWorkspaceToken ?? null,
    trackerStateLists: testTrackerStateLists(),
    staleThresholdMs: 300_000,
    ...(options.realtime ? { realtime: options.realtime } : {}),
  });
}

interface FakeProjectionWriter extends NonNullable<StatusServerOptions["projectionWriter"]> {
  publish(publication: ProjectionRevisionPublication): void;
}

function projectionPublication(overrides: Partial<ProjectionRevisionPublication> = {}): ProjectionRevisionPublication {
  return {
    projectionName: "history_projection",
    scopeKind: "global",
    scopeKey: "global",
    projectionRevisionId: "projection-revision-default",
    revision: 1,
    buildMode: "bootstrap",
    contentSha256: "projection-sha",
    generatedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    sourceRevisions: [],
    sourceCursors: {},
    sourceFreshness: [],
    ...overrides,
  };
}

function fakeProjectionWriter(): FakeProjectionWriter {
  const listeners = new Set<(event: ProjectionRevisionPublication) => void>();
  return {
    async writeProjection(_input: ProjectionPayloadWriteInput): Promise<ProjectionWriteResult> {
      throw new Error("fake projection writer is only used for publication events in realtime tests");
    },
    onProjectionChanged(listener: (event: ProjectionRevisionPublication) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish(publication: ProjectionRevisionPublication): void {
      for (const listener of Array.from(listeners)) listener(publication);
    },
  };
}

function fakeProjectionWriterPublishingWrites(): FakeProjectionWriter {
  const writer = fakeProjectionWriter();
  let nextRevision = 100;
  return {
    ...writer,
    async writeProjection(input: ProjectionPayloadWriteInput): Promise<ProjectionWriteResult> {
      const revision = nextRevision;
      nextRevision += 1;
      const generatedAt = normalizeProjectionWriteTimestamp(input.generatedAt, revision);
      const publication = projectionPublication({
        projectionName: input.projectionName,
        scopeKind: input.scopeKind ?? "global",
        scopeKey: input.scopeKey ?? "global",
        projectionRevisionId: `projection-revision-write-${revision}`,
        revision,
        buildMode: input.buildMode ?? "incremental",
        contentSha256: input.contentSha256 ?? `projection-sha-${revision}`,
        generatedAt,
        expiresAt: normalizeOptionalProjectionWriteTimestamp(input.expiresAt),
        sourceRevisions: (input.sourceRevisions ?? []).map((sourceRevision) => ({
          source: sourceRevision.source,
          revision: sourceRevision.revision,
          observedAt: normalizeOptionalProjectionWriteTimestamp(sourceRevision.observedAt),
        })),
        sourceCursors: (input.sourceCursors ?? {}) as ProjectionRevisionPublication["sourceCursors"],
        sourceFreshness: [],
      });
      writer.publish(publication);
      return {
        status: "written",
        revision: {
          projectionRevisionId: publication.projectionRevisionId,
          projectionName: publication.projectionName,
          scopeKind: publication.scopeKind,
          scopeKey: publication.scopeKey,
          revision: publication.revision,
          buildMode: publication.buildMode,
          sourceRevisions: publication.sourceRevisions,
          sourceCursors: publication.sourceCursors,
          sourceFreshness: publication.sourceFreshness,
          contentSha256: publication.contentSha256,
          generatedAt: publication.generatedAt,
          expiresAt: publication.expiresAt,
          supersededAt: null,
          createdAt: publication.generatedAt,
        },
        previousRevision: null,
        requestedBuildMode: input.buildMode ?? "incremental",
        buildMode: publication.buildMode,
        contentSha256: publication.contentSha256,
        payloadSha256: input.payloadSha256 ?? publication.contentSha256,
        event: publication,
      };
    },
  };
}

function normalizeProjectionWriteTimestamp(value: Date | string | undefined, revision: number): string {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return new Date(Date.UTC(2026, 0, 1, 0, 0, revision)).toISOString();
}

function normalizeOptionalProjectionWriteTimestamp(value: Date | string | null | undefined): string | null {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return value ?? null;
}

function fakeOrchestrator(): Orchestrator {
  return {
    snapshot() {
      return {
        generatedAt: "2026-01-01T00:10:00.000Z",
        counts: { running: 0, retrying: 0, paused: 0, providerGates: 0 },
        providerGates: [],
        providerGateCounts: { active: 0, manual: 0, autoResume: 0 },
        running: [],
        retrying: [],
        paused: [],
        totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
        rateLimits: null,
      };
    },
    getIssueDetails() {
      return null;
    },
    async refreshNow() {
      return undefined;
    },
    pauseIssue() {
      return undefined;
    },
    resumeIssue() {
      return undefined;
    },
    async cancelIssue() {
      return undefined;
    },
    async createContinuationSummary(issueId: string) {
      return {
        summaryReference: {
          id: `fake-summary:${issueId}`,
          kind: "continuation_history",
          summary: "fake summary",
          runIds: [],
          transcriptEventCount: 0,
          transcriptPointers: [],
          statusApiPointers: [],
          createdAt: "2026-01-01T00:00:00Z",
        },
        lifecycle: { summaryReferences: [] },
      };
    },
    async dispatchOrchestratorChatCommand() {
      return { status: "accepted", reason: "accepted", acceptedAt: "2026-01-01T00:00:00.000Z" };
    },
  } as unknown as Orchestrator;
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

function mutableTracker(getIssues: () => readonly Issue[]): TrackerClient {
  const matchingIssues = (states: readonly string[]) => {
    const wanted = new Set(states.map((state) => state.toLowerCase()));
    return getIssues().filter((issue) => wanted.has(issue.state.toLowerCase()));
  };
  return {
    async fetchCandidateIssues() {
      return [...getIssues()];
    },
    async fetchIssuesByStates(states) {
      return matchingIssues(states);
    },
    async fetchIssueStatesByIds(issueIds) {
      const wanted = new Set(issueIds);
      return getIssues().filter((issue) => wanted.has(issue.id));
    },
  };
}

function testIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-realtime-1",
    identifier: "TEST-1",
    title: "Realtime issue",
    description: null,
    priority: null,
    state: "Todo",
    branchName: null,
    url: null,
    assigneeId: null,
    delegateId: null,
    assignedToWorker: false,
    labels: ["dogfood-ready"],
    blockedBy: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function runActivityInput(overrides: Record<string, unknown> = {}): RunActivityAppendInput {
  return {
    id: "activity-realtime",
    runId: "run-realtime-activity",
    sessionId: "session-realtime-activity",
    at: "2026-01-01T00:00:00.000Z",
    harnessId: "runtime-adapter",
    actor: "runtime",
    channel: "status",
    kind: "runtime_log",
    text: "runtime activity",
    payload: {},
    protocol: "json_rpc",
    ...overrides,
  } as RunActivityAppendInput;
}

async function openSseClient(url: string, headers: Record<string, string> = {}): Promise<SseTestClient> {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  const body = response.body;
  if (!body) throw new Error("SSE response did not include a body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const nextRawBlock = async (timeoutMs = 2_000, description = "SSE block"): Promise<string> => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const delimiter = buffer.indexOf("\n\n");
      if (delimiter >= 0) {
        const raw = buffer.slice(0, delimiter);
        buffer = buffer.slice(delimiter + 2);
        return raw;
      }
      const chunk = await withTimeout(reader.read(), timeoutMs - (Date.now() - startedAt), description);
      if (chunk.done) throw new Error(`SSE stream closed before ${description === "SSE event" ? "an event" : "a block"} was available`);
      buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
    }
    throw new Error(`Timed out waiting for ${description}`);
  };

  const nextEvent = async (timeoutMs = 2_000): Promise<ParsedSseEvent> => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const event = parseSseBlock(await nextRawBlock(timeoutMs - (Date.now() - startedAt), "SSE event"));
      if (event) return event;
    }
    throw new Error("Timed out waiting for SSE event");
  };

  return {
    response,
    nextRawBlock,
    nextEvent,
    async nextEventOfType(type: RealtimeProjectionEventType, timeoutMs = 2_000): Promise<ParsedSseEvent> {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        const event = await nextEvent(timeoutMs - (Date.now() - startedAt));
        if (event.event === type) return event;
      }
      throw new Error(`Timed out waiting for SSE event type ${type}`);
    },
    async close(): Promise<void> {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    },
  };
}

function parseSseBlock(raw: string): ParsedSseEvent | null {
  let id = "";
  let event = "";
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0 || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator >= 0 ? line.slice(0, separator) : line;
    const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, "") : "";
    if (field === "id") id = value;
    if (field === "event") event = value;
    if (field === "data") data.push(value);
  }
  if (data.length === 0) return null;
  return { id, event, data: JSON.parse(data.join("\n")), raw };
}

async function nextEventOfTypeFromSource(
  client: SseTestClient,
  type: RealtimeProjectionEventType,
  source: string,
  timeoutMs = 2_000,
): Promise<ParsedSseEvent> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const remaining = timeoutMs - (Date.now() - startedAt);
    const event = await client.nextEventOfType(type, remaining);
    if ((event.data as RealtimeProjectionEvent).source.source === source) return event;
  }
  throw new Error(`Timed out waiting for SSE event type ${type} from source ${source}`);
}

async function readOrderedRealtimeEvents(
  client: SseTestClient,
  source: string,
  sourceRevision: number,
  expectedTypes: readonly RealtimeProjectionEventType[],
): Promise<RealtimeProjectionEvent[]> {
  const events: RealtimeProjectionEvent[] = [];
  for (const type of expectedTypes) {
    const event = await client.nextEvent();
    expect(event.event).toBe(type);
    const data = event.data as RealtimeProjectionEvent;
    expect(data).toMatchObject({
      type,
      source: { source, revision: sourceRevision },
      recovery: { strategy: "refetch", reason: "event" },
      missedEvents: false,
    });
    expect(data.resources.length).toBeGreaterThan(0);
    expect(data.recovery.endpoints.length).toBeGreaterThan(0);
    events.push(data);
  }
  expect(events.map((event) => event.revision)).toEqual(
    events.map((event) => event.revision).slice().sort((left, right) => left - right),
  );
  expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
  return events;
}

async function waitFor(predicate: () => boolean, description: string, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate(), `Timed out waiting for ${description}`).toBe(true);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, description: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function requireEvent(event: RealtimeProjectionEvent | undefined): RealtimeProjectionEvent {
  if (!event) throw new Error("Expected realtime event to be present");
  return event;
}

function requireDataLine(serialized: string): string {
  const line = serialized.split("\n").find((candidate) => candidate.startsWith("data: "));
  if (!line) throw new Error("Expected serialized SSE event to contain a data line");
  return line.slice("data: ".length);
}

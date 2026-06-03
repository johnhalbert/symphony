import { describe, expect, it } from "vitest";
import { REALTIME_EVENT_SCHEMA, REALTIME_EVENT_SCHEMA_VERSION, type RealtimeProjectionEvent } from "../src/data/realtimeEvents";
import {
  DEFAULT_ORCHESTRATOR_CONVERSATION_ID,
  applyOrchestratorMessageEvent,
  applyTranscriptDeltaEvent,
  realtimeEventHasDirectPatchPayload,
} from "../src/data/realtimePatches";
import type { ChatMessage, TranscriptMessage } from "../src/types/symphony";

function transcriptEvent(overrides: Partial<RealtimeProjectionEvent<"transcript.delta">> = {}): RealtimeProjectionEvent<"transcript.delta"> {
  const payload = {
    source: "runs",
    sourceRevision: 2,
    detail: null,
    runId: "run-1",
    sessionId: "session-1",
    afterSequence: 1,
    eventCount: 1,
    messages: [
      {
        sequence: 2,
        message: { kind: "assistant", ts: "2026-01-01T00:00:02.000Z", text: "streamed delta" } satisfies TranscriptMessage,
      },
    ],
  };
  return {
    schema: REALTIME_EVENT_SCHEMA,
    schemaVersion: REALTIME_EVENT_SCHEMA_VERSION,
    id: "2",
    type: "transcript.delta",
    revision: 2,
    createdAt: "2026-01-01T00:00:02.000Z",
    scope: "session",
    key: "session-1",
    source: { source: "runs", revision: 2, observedAt: null },
    resources: [{ kind: "session-transcript", href: "/api/v1/web/sessions/{sessionId}/transcript", relation: "template" }],
    recovery: { strategy: "refetch", reason: "event", lastEventId: null, endpoints: ["/api/v1/web/sessions/{sessionId}/transcript"] },
    missedEvents: false,
    payload,
    detail: null,
    ...overrides,
  } as RealtimeProjectionEvent<"transcript.delta">;
}

function orchestratorEvent(overrides: Partial<RealtimeProjectionEvent<"orchestrator.message">> = {}): RealtimeProjectionEvent<"orchestrator.message"> {
  const message: ChatMessage = {
    id: "msg-2",
    conversationId: DEFAULT_ORCHESTRATOR_CONVERSATION_ID,
    who: "agent",
    role: "assistant",
    text: "server message",
    status: "completed",
  };
  const payload = {
    source: "orchestrator_conversations",
    sourceRevision: 2,
    detail: null,
    conversationId: DEFAULT_ORCHESTRATOR_CONVERSATION_ID,
    messageCount: 2,
    inputLength: null,
    status: null,
    operation: "append",
    message,
    messages: [message],
  };
  return {
    schema: REALTIME_EVENT_SCHEMA,
    schemaVersion: REALTIME_EVENT_SCHEMA_VERSION,
    id: "2",
    type: "orchestrator.message",
    revision: 2,
    createdAt: "2026-01-01T00:00:02.000Z",
    scope: "orchestrator",
    key: DEFAULT_ORCHESTRATOR_CONVERSATION_ID,
    source: { source: "orchestrator_conversations", revision: 2, observedAt: null },
    resources: [{ kind: "orchestrator-chat", href: "/api/v1/web/orchestrator-chat", relation: "refetch" }],
    recovery: { strategy: "refetch", reason: "event", lastEventId: null, endpoints: ["/api/v1/web/orchestrator-chat"] },
    missedEvents: false,
    payload,
    detail: null,
    ...overrides,
  } as RealtimeProjectionEvent<"orchestrator.message">;
}

describe("realtime active-view patch reducers", () => {
  it("applies ordered transcript deltas and suppresses duplicate or replayed sequences", () => {
    const current: TranscriptMessage[] = [{ kind: "assistant", ts: "2026-01-01T00:00:01.000Z", text: "loaded" }];

    const applied = applyTranscriptDeltaEvent({
      event: transcriptEvent(),
      sessionId: "session-1",
      current,
      lastSequence: 1,
      lastRevision: 1,
    });

    expect(applied).toMatchObject({ action: "applied", lastSequence: 2, lastRevision: 2 });
    expect(applied.action === "applied" ? applied.data : []).toEqual([
      current[0],
      { kind: "assistant", ts: "2026-01-01T00:00:02.000Z", text: "streamed delta" },
    ]);

    expect(
      applyTranscriptDeltaEvent({ event: transcriptEvent({ revision: 2, id: "2-replay" }), sessionId: "session-1", current, lastSequence: 2, lastRevision: 2 }),
    ).toMatchObject({ action: "ignored" });
  });

  it("keeps the selected transcript active tail at the server default size when applying direct deltas", () => {
    const current: TranscriptMessage[] = Array.from({ length: 500 }, (_, index) => ({
      kind: "assistant",
      ts: `2026-01-01T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
      text: `event-${index + 1}`,
    }));

    const applied = applyTranscriptDeltaEvent({
      event: transcriptEvent({
        id: "501",
        revision: 501,
        payload: {
          ...transcriptEvent().payload,
          afterSequence: 500,
          messages: [{ sequence: 501, message: { kind: "assistant", ts: "2026-01-01T00:09:00.000Z", text: "event-501" } }],
        },
      }),
      sessionId: "session-1",
      current,
      lastSequence: 500,
      lastRevision: 500,
    });

    expect(applied).toMatchObject({ action: "applied", lastSequence: 501 });
    const data = applied.action === "applied" ? applied.data : [];
    expect(data).toHaveLength(500);
    expect(data[0]?.kind === "assistant" ? data[0].text : null).toBe("event-2");
    const last = data.at(-1);
    expect(last?.kind === "assistant" ? last.text : null).toBe("event-501");
  });

  it("updates an active assistant transcript tail from streaming deltas and final replacements", () => {
    const current: TranscriptMessage[] = [{ kind: "assistant", ts: "2026-01-01T00:00:01.000Z", text: "hel" }];

    const merged = applyTranscriptDeltaEvent({
      event: transcriptEvent({
        payload: {
          ...transcriptEvent().payload,
          afterSequence: 1,
          messages: [
            {
              sequence: 2,
              operation: "merge-assistant-delta",
              joinMode: "exact",
              message: { kind: "assistant", ts: "2026-01-01T00:00:02.000Z", text: "lo" },
            },
          ],
        },
      }),
      sessionId: "session-1",
      current,
      lastSequence: 1,
      lastRevision: 1,
    });

    expect(merged.action === "applied" ? merged.data : []).toEqual([{ kind: "assistant", ts: "2026-01-01T00:00:02.000Z", text: "hello" }]);

    const replaced = applyTranscriptDeltaEvent({
      event: transcriptEvent({
        revision: 3,
        payload: {
          ...transcriptEvent().payload,
          sourceRevision: 3,
          afterSequence: 2,
          messages: [
            {
              sequence: 3,
              operation: "replace-assistant",
              message: { kind: "assistant", ts: "2026-01-01T00:00:03.000Z", text: "hello!" },
            },
          ],
        },
      }),
      sessionId: "session-1",
      current: merged.action === "applied" ? merged.data : [],
      lastSequence: 2,
      lastRevision: 2,
    });

    expect(replaced.action === "applied" ? replaced.data : []).toEqual([{ kind: "assistant", ts: "2026-01-01T00:00:03.000Z", text: "hello!" }]);

    const mirrored = applyTranscriptDeltaEvent({
      event: transcriptEvent({
        revision: 4,
        payload: {
          ...transcriptEvent().payload,
          sourceRevision: 4,
          afterSequence: 1,
          messages: [
            { sequence: 2, operation: "merge-assistant-delta", joinMode: "exact", message: { kind: "assistant", ts: "2026-01-01T00:00:02.000Z", text: "Hel" } },
            { sequence: 3, message: null },
            { sequence: 4, operation: "merge-assistant-delta", joinMode: "exact", message: { kind: "assistant", ts: "2026-01-01T00:00:04.000Z", text: "lo" } },
            { sequence: 5, message: null },
          ],
        },
      }),
      sessionId: "session-1",
      current: [],
      lastSequence: 1,
      lastRevision: 3,
    });
    expect(mirrored).toMatchObject({ action: "applied", lastSequence: 5 });
    expect(mirrored.action === "applied" ? mirrored.data : []).toEqual([{ kind: "assistant", ts: "2026-01-01T00:00:04.000Z", text: "Hello" }]);
  });

  it("falls back for missed, missing, stale/gapped, or incompatible transcript deltas and ignores inactive sessions", () => {
    const current: TranscriptMessage[] = [{ kind: "assistant", ts: "2026-01-01T00:00:01.000Z", text: "loaded" }];

    expect(
      applyTranscriptDeltaEvent({
        event: transcriptEvent({ missedEvents: true, recovery: { strategy: "refetch", reason: "missed-events", lastEventId: "1", endpoints: [] } }),
        sessionId: "session-1",
        current,
        lastSequence: 1,
        lastRevision: 1,
      }),
    ).toMatchObject({ action: "fallback", reason: "missed-events" });

    expect(
      applyTranscriptDeltaEvent({
        event: transcriptEvent({ payload: { ...transcriptEvent().payload, messages: undefined } }),
        sessionId: "session-1",
        current,
        lastSequence: 1,
        lastRevision: 1,
      }),
    ).toMatchObject({ action: "fallback", reason: "missing-payload" });

    expect(
      applyTranscriptDeltaEvent({
        event: transcriptEvent({ payload: { ...transcriptEvent().payload, afterSequence: 3, messages: [{ sequence: 4, message: current[0] }] } }),
        sessionId: "session-1",
        current,
        lastSequence: 1,
        lastRevision: 1,
      }),
    ).toMatchObject({ action: "fallback", reason: "gap" });

    expect(
      applyTranscriptDeltaEvent({
        event: transcriptEvent({ payload: { ...transcriptEvent().payload, afterSequence: 0, messages: [{ sequence: 3, message: current[0] }] } }),
        sessionId: "session-1",
        current,
        lastSequence: 2,
        lastRevision: 1,
      }),
    ).toMatchObject({ action: "fallback", reason: "incompatible" });

    expect(
      applyTranscriptDeltaEvent({
        event: transcriptEvent({ revision: 1 }),
        sessionId: "session-1",
        current,
        lastSequence: 1,
        lastRevision: 2,
      }),
    ).toMatchObject({ action: "ignored" });

    expect(
      applyTranscriptDeltaEvent({
        event: transcriptEvent({ payload: { ...transcriptEvent().payload, sessionId: "session-2" }, key: "session-2" }),
        sessionId: "session-1",
        current,
        lastSequence: 1,
        lastRevision: 1,
      }),
    ).toMatchObject({ action: "ignored" });
  });

  it("patches orchestrator chat messages by stable id and suppresses replay duplicates", () => {
    const current: ChatMessage[] = [
      { id: "msg-1", conversationId: DEFAULT_ORCHESTRATOR_CONVERSATION_ID, who: "user", text: "status" },
    ];

    const applied = applyOrchestratorMessageEvent({ event: orchestratorEvent(), current, lastRevision: 1 });

    expect(applied).toMatchObject({ action: "applied", lastRevision: 2 });
    expect(applied.action === "applied" ? applied.data : []).toEqual([
      current[0],
      {
        id: "msg-2",
        conversationId: DEFAULT_ORCHESTRATOR_CONVERSATION_ID,
        who: "agent",
        role: "assistant",
        text: "server message",
        status: "completed",
      },
    ]);

    const update = orchestratorEvent({
      revision: 3,
      payload: {
        ...orchestratorEvent().payload,
        operation: "update",
        messageCount: 2,
        message: { id: "msg-2", conversationId: DEFAULT_ORCHESTRATOR_CONVERSATION_ID, who: "agent", text: "server message done", status: "completed" },
        messages: [{ id: "msg-2", conversationId: DEFAULT_ORCHESTRATOR_CONVERSATION_ID, who: "agent", text: "server message done", status: "completed" }],
      },
    });
    const updated = applyOrchestratorMessageEvent({ event: update, current: applied.action === "applied" ? applied.data : [], lastRevision: 2 });
    expect(updated.action === "applied" ? updated.data : []).toHaveLength(2);
    expect(updated.action === "applied" ? updated.data.at(-1)?.text : null).toBe("server message done");

    expect(applyOrchestratorMessageEvent({ event: update, current, lastRevision: 3 })).toMatchObject({ action: "ignored" });
  });

  it("falls back for absent orchestrator update ids outside a full active tail but still patches true appends", () => {
    const current: ChatMessage[] = [
      { id: "msg-2", conversationId: DEFAULT_ORCHESTRATOR_CONVERSATION_ID, who: "agent", text: "visible-2" },
      { id: "msg-3", conversationId: DEFAULT_ORCHESTRATOR_CONVERSATION_ID, who: "agent", text: "visible-3" },
    ];

    const oldUpdate = orchestratorEvent({
      payload: {
        ...orchestratorEvent().payload,
        operation: "update",
        messageCount: 3,
        message: { id: "msg-1", conversationId: DEFAULT_ORCHESTRATOR_CONVERSATION_ID, who: "agent", text: "old updated" },
        messages: [{ id: "msg-1", conversationId: DEFAULT_ORCHESTRATOR_CONVERSATION_ID, who: "agent", text: "old updated" }],
      },
    });
    expect(applyOrchestratorMessageEvent({ event: oldUpdate, current, lastRevision: 1, tailLimit: 2 })).toMatchObject({
      action: "fallback",
      reason: "gap",
    });

    const append = orchestratorEvent({
      revision: 3,
      payload: {
        ...orchestratorEvent().payload,
        sourceRevision: 3,
        operation: "append",
        messageCount: 4,
        message: { id: "msg-4", conversationId: DEFAULT_ORCHESTRATOR_CONVERSATION_ID, who: "agent", text: "new visible" },
        messages: [{ id: "msg-4", conversationId: DEFAULT_ORCHESTRATOR_CONVERSATION_ID, who: "agent", text: "new visible" }],
      },
    });
    const applied = applyOrchestratorMessageEvent({ event: append, current, lastRevision: 2, tailLimit: 2 });
    expect(applied).toMatchObject({ action: "applied", lastRevision: 3 });
    expect(applied.action === "applied" ? applied.data.map((message) => message.id) : []).toEqual(["msg-3", "msg-4"]);
  });

  it("falls back for missed, missing, gapped, or incompatible orchestrator message patches and ignores inactive conversations", () => {
    const current: ChatMessage[] = [
      { id: "msg-1", conversationId: DEFAULT_ORCHESTRATOR_CONVERSATION_ID, who: "user", text: "status" },
    ];

    expect(
      applyOrchestratorMessageEvent({
        event: orchestratorEvent({ missedEvents: true, recovery: { strategy: "refetch", reason: "missed-events", lastEventId: "1", endpoints: [] } }),
        current,
        lastRevision: 1,
      }),
    ).toMatchObject({ action: "fallback", reason: "missed-events" });

    expect(
      applyOrchestratorMessageEvent({ event: orchestratorEvent({ payload: { ...orchestratorEvent().payload, message: undefined, messages: undefined } }), current, lastRevision: 1 }),
    ).toMatchObject({ action: "fallback", reason: "missing-payload" });

    expect(
      applyOrchestratorMessageEvent({ event: orchestratorEvent({ payload: { ...orchestratorEvent().payload, messageCount: 4 } }), current, lastRevision: 1 }),
    ).toMatchObject({ action: "fallback", reason: "gap" });

    expect(
      applyOrchestratorMessageEvent({
        event: orchestratorEvent({
          payload: {
            ...orchestratorEvent().payload,
            messages: [{ id: "msg-2", conversationId: "orchestrator-default", who: "bot", text: "bad shape" } as never],
          },
        }),
        current,
        lastRevision: 1,
      }),
    ).toMatchObject({ action: "fallback", reason: "incompatible" });

    expect(
      applyOrchestratorMessageEvent({
        event: orchestratorEvent({
          key: "other-room",
          payload: { ...orchestratorEvent().payload, conversationId: "other-room" },
        }),
        current,
        lastRevision: 1,
      }),
    ).toMatchObject({ action: "ignored" });
  });

  it("flags direct patch payloads so global live tokens can leave active resources to the patch hooks", () => {
    expect(realtimeEventHasDirectPatchPayload(transcriptEvent())).toBe(true);
    expect(realtimeEventHasDirectPatchPayload(orchestratorEvent())).toBe(true);
    expect(realtimeEventHasDirectPatchPayload(transcriptEvent({ payload: { ...transcriptEvent().payload, messages: undefined } }))).toBe(false);
    expect(
      realtimeEventHasDirectPatchPayload(
        orchestratorEvent({ missedEvents: true, recovery: { strategy: "refetch", reason: "missed-events", lastEventId: "1", endpoints: [] } }),
      ),
    ).toBe(false);
  });
});

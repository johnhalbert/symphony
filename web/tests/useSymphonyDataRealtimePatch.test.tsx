// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RealtimeEventListener, RealtimeProjectionEvent, SymphonyDataSource } from "../src/data/dataSource";
import { DataSourceProvider } from "../src/data/dataSourceContext";
import { orchestratorChatModelFromMessages } from "../src/data/orchestratorChat";
import { createTranscriptWindowResponse } from "../src/data/transcriptWindow";
import { REALTIME_EVENT_SCHEMA, REALTIME_EVENT_SCHEMA_VERSION } from "../src/data/realtimeEvents";
import { useOrchestratorChat, useTranscript } from "../src/hooks/useSymphonyData";
import type {
  ChatMessage,
  Loadable,
  OrchestratorChatModel,
  TranscriptMessage,
  TranscriptWindowResponse,
} from "../src/types/symphony";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];

function transcriptEvent(sequence: number, afterSequence: number, text: string, overrides: Partial<RealtimeProjectionEvent> = {}): RealtimeProjectionEvent {
  return {
    schema: REALTIME_EVENT_SCHEMA,
    schemaVersion: REALTIME_EVENT_SCHEMA_VERSION,
    id: `transcript-${sequence}`,
    type: "transcript.delta",
    revision: sequence,
    createdAt: `2026-01-01T00:00:0${sequence}.000Z`,
    scope: "session",
    key: "session-1",
    source: { source: "runs", revision: sequence, observedAt: null },
    resources: [{ kind: "session-transcript", href: "/api/v1/web/sessions/{sessionId}/transcript", relation: "template" }],
    recovery: { strategy: "refetch", reason: "event", lastEventId: null, endpoints: ["/api/v1/web/sessions/{sessionId}/transcript"] },
    missedEvents: false,
    payload: {
      source: "runs",
      sourceRevision: sequence,
      detail: null,
      runId: "run-1",
      sessionId: "session-1",
      afterSequence,
      eventCount: 1,
      messages: [{ sequence, message: { kind: "assistant", ts: `2026-01-01T00:00:0${sequence}.000Z`, text } }],
    },
    detail: null,
    ...overrides,
  } as RealtimeProjectionEvent;
}

function chatEvent(revision: number, message: ChatMessage, messageCount: number, overrides: Partial<RealtimeProjectionEvent> = {}): RealtimeProjectionEvent {
  return {
    schema: REALTIME_EVENT_SCHEMA,
    schemaVersion: REALTIME_EVENT_SCHEMA_VERSION,
    id: `chat-${revision}`,
    type: "orchestrator.message",
    revision,
    createdAt: `2026-01-01T00:00:0${revision}.000Z`,
    scope: "orchestrator",
    key: "orchestrator-default",
    source: { source: "orchestrator_conversations", revision, observedAt: null },
    resources: [{ kind: "orchestrator-chat", href: "/api/v1/web/orchestrator-chat", relation: "refetch" }],
    recovery: { strategy: "refetch", reason: "event", lastEventId: null, endpoints: ["/api/v1/web/orchestrator-chat"] },
    missedEvents: false,
    payload: {
      source: "orchestrator_conversations",
      sourceRevision: revision,
      detail: null,
      conversationId: "orchestrator-default",
      messageCount,
      inputLength: null,
      status: null,
      message,
      messages: [message],
    },
    detail: null,
    ...overrides,
  } as RealtimeProjectionEvent;
}

function testDataSource(overrides: Partial<SymphonyDataSource>): SymphonyDataSource {
  const notImplemented = async () => {
    throw new Error("test data source method was not implemented");
  };
  return {
    getReferenceData: notImplemented,
    getDashboard: notImplemented,
    getIssueBoard: notImplemented,
    getIssueDetail: notImplemented,
    getHistory: notImplemented,
    getSessions: notImplemented,
    getTranscript: notImplemented,
    getSidebar: notImplemented,
    getOrchestratorChat: notImplemented,
    sendOrchestratorMessage: notImplemented,
    ...overrides,
  } as SymphonyDataSource;
}

function renderTranscriptProbe(dataSource: SymphonyDataSource) {
  let latest: Loadable<TranscriptMessage[]> | null = null;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);

  function Probe() {
    latest = useTranscript("session-1");
    return null;
  }

  act(() => {
    root.render(createElement(DataSourceProvider, { value: dataSource, children: createElement(Probe) }));
  });

  return {
    result() {
      if (!latest) throw new Error("transcript probe did not render");
      return latest;
    },
  };
}

function renderChatProbe(dataSource: SymphonyDataSource) {
  let latest: Loadable<OrchestratorChatModel> | null = null;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);

  function Probe() {
    latest = useOrchestratorChat({ enabled: true });
    return null;
  }

  act(() => {
    root.render(createElement(DataSourceProvider, { value: dataSource, children: createElement(Probe) }));
  });

  return {
    result() {
      if (!latest) throw new Error("chat probe did not render");
      return latest;
    },
  };
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
  });
}

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => {
      root.unmount();
    });
  }
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("useSymphonyData realtime direct patching", () => {
  it("patches the selected transcript from ordered SSE deltas without refetching and refetches on gaps", async () => {
    let listener: RealtimeEventListener | null = null;
    const invalidateCachedReads = vi.fn();
    const initial: TranscriptMessage[] = [{ kind: "assistant", ts: "2026-01-01T00:00:01.000Z", text: "loaded" }];
    const refetched: TranscriptMessage[] = [{ kind: "assistant", ts: "2026-01-01T00:00:05.000Z", text: "refetched after gap" }];
    const getTranscript: SymphonyDataSource["getTranscript"] = vi
      .fn()
      .mockResolvedValueOnce(
        createTranscriptWindowResponse(initial, {
          runStatus: "running",
          lastSequence: 1,
          refetchHref: "/api/v1/web/sessions/session-1/transcript?refresh=1",
        }),
      )
      .mockResolvedValueOnce(createTranscriptWindowResponse(refetched, { runStatus: "running", lastSequence: 5 }));

    const dataSource = testDataSource({
      getTranscript,
      invalidateCachedReads,
      subscribeToRealtimeEvents(nextListener) {
        listener = nextListener;
        return () => undefined;
      },
    });
    const probe = renderTranscriptProbe(dataSource);
    await flushPromises();

    expect(probe.result()).toMatchObject({ data: initial, loading: false, error: null });
    expect(getTranscript).toHaveBeenCalledTimes(1);

    act(() => listener?.(transcriptEvent(2, 1, "streamed delta")));

    expect(probe.result().data).toEqual([...initial, { kind: "assistant", ts: "2026-01-01T00:00:02.000Z", text: "streamed delta" }]);
    expect(getTranscript).toHaveBeenCalledTimes(1);

    act(() => listener?.(transcriptEvent(2, 1, "streamed delta", { id: "transcript-2-replay" })));
    expect(probe.result().data).toHaveLength(2);
    expect(getTranscript).toHaveBeenCalledTimes(1);

    act(() => listener?.(transcriptEvent(5, 4, "gap delta")));
    await flushPromises();

    expect(invalidateCachedReads).toHaveBeenCalledWith({ forceRefreshHrefs: ["/api/v1/web/sessions/session-1/transcript?refresh=1"] });
    expect(getTranscript).toHaveBeenCalledTimes(2);
    expect(probe.result().data).toEqual(refetched);
  });

  it("refetches instead of appending when a running transcript tail still contains only run prelude messages", async () => {
    let listener: RealtimeEventListener | null = null;
    const invalidateCachedReads = vi.fn();
    const preludeOnly: TranscriptMessage[] = [
      {
        kind: "system",
        ts: "2026-01-01T00:00:00.000Z",
        model: "gpt-5.4",
        cwd: "/workspace",
        workspace: "/workspace",
        session: "session-1",
        tools: ["terminal"],
        note: "System prelude",
      },
      {
        kind: "user",
        ts: "2026-01-01T00:00:00.500Z",
        from: "worker",
        issue: "ENG-225",
        text: "Fix the transcript gap.",
      },
    ];
    const refetched: TranscriptMessage[] = [
      ...preludeOnly,
      { kind: "assistant", ts: "2026-01-01T00:00:01.000Z", text: "missed earlier row" },
      { kind: "assistant", ts: "2026-01-01T00:00:02.000Z", text: "visible after gap" },
    ];
    const getTranscript: SymphonyDataSource["getTranscript"] = vi
      .fn()
      .mockResolvedValueOnce(
        createTranscriptWindowResponse(preludeOnly, {
          runStatus: "running",
          lastSequence: null,
          refetchHref: "/api/v1/web/sessions/session-1/transcript?refresh=1",
        }),
      )
      .mockResolvedValueOnce(
        createTranscriptWindowResponse(refetched, {
          runStatus: "running",
          lastSequence: 2,
          refetchHref: "/api/v1/web/sessions/session-1/transcript?refresh=1",
        }),
      );

    const dataSource = testDataSource({
      getTranscript,
      invalidateCachedReads,
      subscribeToRealtimeEvents(nextListener) {
        listener = nextListener;
        return () => undefined;
      },
    });
    const probe = renderTranscriptProbe(dataSource);
    await flushPromises();

    expect(probe.result()).toMatchObject({ data: preludeOnly, loading: false, error: null });
    expect(getTranscript).toHaveBeenCalledTimes(1);

    act(() => listener?.(transcriptEvent(2, 1, "visible after gap")));
    await flushPromises();

    expect(invalidateCachedReads).toHaveBeenCalledWith({ forceRefreshHrefs: ["/api/v1/web/sessions/session-1/transcript?refresh=1"] });
    expect(getTranscript).toHaveBeenCalledTimes(2);
    expect(probe.result().data).toEqual(refetched);
  });

  it("keeps a selected 500-event transcript tail live patched without shrinking or refetching", async () => {
    let listener: RealtimeEventListener | null = null;
    const initial: TranscriptMessage[] = Array.from({ length: 500 }, (_, index) => ({
      kind: "assistant",
      ts: `2026-01-01T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
      text: `event-${index + 1}`,
    }));
    const getTranscript: SymphonyDataSource["getTranscript"] = vi
      .fn()
      .mockResolvedValueOnce(createTranscriptWindowResponse(initial, { runStatus: "running", lastSequence: 500 }));

    const dataSource = testDataSource({
      getTranscript,
      invalidateCachedReads: vi.fn(),
      subscribeToRealtimeEvents(nextListener) {
        listener = nextListener;
        return () => undefined;
      },
    });
    const probe = renderTranscriptProbe(dataSource);
    await flushPromises();

    act(() => listener?.(transcriptEvent(501, 500, "event-501", { revision: 501, id: "transcript-501" })));

    expect(getTranscript).toHaveBeenCalledTimes(1);
    const patched = probe.result().data ?? [];
    expect(patched).toHaveLength(500);
    expect(patched[0]?.kind === "assistant" ? patched[0].text : null).toBe("event-2");
    const last = patched.at(-1);
    expect(last?.kind === "assistant" ? last.text : null).toBe("event-501");
  });

  it("ignores transcript deltas when the loaded transcript window is not an active appendable tail", async () => {
    let listener: RealtimeEventListener | null = null;
    const invalidateCachedReads = vi.fn();
    const initial: TranscriptMessage[] = [{ kind: "assistant", ts: "2026-01-01T00:00:01.000Z", text: "completed tail" }];
    const getTranscript: SymphonyDataSource["getTranscript"] = vi
      .fn()
      .mockResolvedValueOnce(createTranscriptWindowResponse(initial, { runStatus: "succeeded", lastSequence: 1, refetchHref: "/api/v1/web/sessions/session-1/transcript?refresh=1" }));

    const dataSource = testDataSource({
      getTranscript,
      invalidateCachedReads,
      subscribeToRealtimeEvents(nextListener) {
        listener = nextListener;
        return () => undefined;
      },
    });
    const probe = renderTranscriptProbe(dataSource);
    await flushPromises();

    act(() => listener?.(transcriptEvent(2, 1, "unexpected live delta")));

    expect(probe.result()).toMatchObject({ data: initial, loading: false, error: null });
    expect(getTranscript).toHaveBeenCalledTimes(1);
    expect(invalidateCachedReads).not.toHaveBeenCalled();
  });

  it("patches orchestrator chat from message SSE payloads without refetching and refetches on missing messages", async () => {
    let listener: RealtimeEventListener | null = null;
    const invalidateCachedReads = vi.fn();
    const initial: ChatMessage[] = [{ id: "msg-1", conversationId: "orchestrator-default", who: "user", text: "status" }];
    const refetched: ChatMessage[] = [{ id: "msg-refetch", conversationId: "orchestrator-default", who: "agent", text: "refetched" }];
    const getOrchestratorChat = vi.fn<(_: AbortSignal | undefined) => Promise<OrchestratorChatModel>>()
      .mockResolvedValueOnce(orchestratorChatModelFromMessages(initial))
      .mockResolvedValueOnce(orchestratorChatModelFromMessages(refetched));
    const dataSource = testDataSource({
      getOrchestratorChat,
      invalidateCachedReads,
      subscribeToRealtimeEvents(nextListener) {
        listener = nextListener;
        return () => undefined;
      },
    });
    const probe = renderChatProbe(dataSource);
    await flushPromises();

    expect(probe.result().data?.chat).toEqual(initial);
    expect(probe.result()).toMatchObject({ loading: false, error: null });
    expect(getOrchestratorChat).toHaveBeenCalledTimes(1);

    const serverMessage: ChatMessage = { id: "msg-2", conversationId: "orchestrator-default", who: "agent", text: "server message" };
    act(() => listener?.(chatEvent(2, serverMessage, 2)));

    expect(probe.result().data?.chat).toEqual([...initial, serverMessage]);
    expect(getOrchestratorChat).toHaveBeenCalledTimes(1);

    act(() => listener?.(chatEvent(2, serverMessage, 2, { id: "chat-2-replay" })));
    expect(probe.result().data?.chat).toHaveLength(2);
    expect(getOrchestratorChat).toHaveBeenCalledTimes(1);

    act(() =>
      listener?.(
        chatEvent(3, serverMessage, 2, {
          payload: { ...chatEvent(3, serverMessage, 2).payload, message: undefined, messages: undefined },
        }),
      ),
    );
    await flushPromises();

    expect(invalidateCachedReads).toHaveBeenCalledWith({ forceRefreshHrefs: ["/api/v1/web/orchestrator-chat?refresh=1"] });
    expect(getOrchestratorChat).toHaveBeenCalledTimes(2);
    expect(probe.result().data?.chat).toEqual(refetched);
  });

  it("refetches orchestrator chat instead of appending updates for ids outside the active bounded tail", async () => {
    let listener: RealtimeEventListener | null = null;
    const invalidateCachedReads = vi.fn();
    const initial: ChatMessage[] = [
      { id: "msg-2", conversationId: "orchestrator-default", who: "agent", text: "visible-2" },
      { id: "msg-3", conversationId: "orchestrator-default", who: "agent", text: "visible-3" },
    ];
    const refetched: ChatMessage[] = [...initial];
    const getOrchestratorChat = vi.fn<(_: AbortSignal | undefined) => Promise<OrchestratorChatModel>>()
      .mockResolvedValueOnce(orchestratorChatModelFromMessages(initial))
      .mockResolvedValueOnce(orchestratorChatModelFromMessages(refetched));
    const dataSource = testDataSource({
      getOrchestratorChat,
      invalidateCachedReads,
      subscribeToRealtimeEvents(nextListener) {
        listener = nextListener;
        return () => undefined;
      },
    });
    const probe = renderChatProbe(dataSource);
    await flushPromises();

    const oldUpdate: ChatMessage = { id: "msg-1", conversationId: "orchestrator-default", who: "agent", text: "old updated" };
    act(() =>
      listener?.(
        chatEvent(2, oldUpdate, 3, {
          payload: { ...chatEvent(2, oldUpdate, 3).payload, operation: "update" },
        }),
      ),
    );
    await flushPromises();

    expect(invalidateCachedReads).toHaveBeenCalledWith({ forceRefreshHrefs: ["/api/v1/web/orchestrator-chat?refresh=1"] });
    expect(getOrchestratorChat).toHaveBeenCalledTimes(2);
    expect(probe.result().data?.chat).toEqual(refetched);
  });
});

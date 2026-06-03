// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ProjectionChangeListener,
  RealtimeEventListener,
  RealtimeProjectionEvent,
  RealtimeProjectionResource,
  SymphonyDataSource,
} from "../src/data/dataSource";
import { DataSourceProvider } from "../src/data/dataSourceContext";
import {
  LIVE_RESOURCE_KEYS,
  combineLiveResourceTokens,
  createLiveResourceTokenMap,
  liveResourceKeysForRealtimeEvent,
  realtimeRefreshHrefsForEvent,
  useLiveResourceState,
  type LiveResourceState,
} from "../src/hooks/useLiveResource";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];

function eventFor(resources: readonly RealtimeProjectionResource[], overrides: Partial<RealtimeProjectionEvent> = {}): RealtimeProjectionEvent {
  return {
    id: "1",
    type: "projection.updated",
    revision: 1,
    createdAt: "2026-06-02T00:00:00.000Z",
    source: { source: "runs", revision: 1, observedAt: "2026-06-02T00:00:00.000Z" },
    resources,
    recovery: {
      strategy: "refetch",
      reason: "event",
      lastEventId: null,
      endpoints: resources.map((resource) => resource.href),
    },
    missedEvents: false,
    detail: null,
    ...overrides,
  };
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

function renderLiveResourceProbe(dataSource: SymphonyDataSource, enabled = true) {
  let latestState: LiveResourceState | null = null;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);

  function Probe() {
    latestState = useLiveResourceState(enabled);
    return null;
  }

  act(() => {
    root.render(createElement(DataSourceProvider, { value: dataSource, children: createElement(Probe) }));
  });

  return {
    state() {
      if (!latestState) throw new Error("live resource probe did not render");
      return latestState;
    },
  };
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

describe("live resource realtime mapping", () => {
  it("maps source.status refresh hints to reference, issue board, and dashboard resources", () => {
    const event = eventFor(
      [
        { kind: "source", href: "/api/v1/web/reference-data?refresh=1", relation: "refetch" },
        { kind: "issue-board", href: "/api/v1/web/issues?refresh=1", relation: "refetch" },
        { kind: "dashboard", href: "/api/v1/web/dashboard?refresh=1", relation: "refetch" },
      ],
      { type: "source.status" },
    );

    expect(liveResourceKeysForRealtimeEvent(event)).toEqual(["referenceData", "issueBoard", "dashboard"]);
    expect(realtimeRefreshHrefsForEvent(event)).toEqual([
      "/api/v1/web/reference-data?refresh=1",
      "/api/v1/web/issues?refresh=1",
      "/api/v1/web/dashboard?refresh=1",
    ]);
  });

  it("maps transcript template events to history and selected transcript refresh tokens", () => {
    const event = eventFor(
      [
        { kind: "history", href: "/api/v1/web/history", relation: "refetch" },
        { kind: "session-transcript", href: "/api/v1/web/sessions/{sessionId}/transcript", relation: "template" },
      ],
      { type: "transcript.delta" },
    );

    expect(liveResourceKeysForRealtimeEvent(event)).toEqual(["history", "sessionTranscript"]);
  });

  it("falls back to all live resources when a missed-events recovery has no resource hints", () => {
    const event = eventFor([], {
      missedEvents: true,
      recovery: { strategy: "refetch", reason: "missed-events", lastEventId: "old", endpoints: [] },
    });

    expect(liveResourceKeysForRealtimeEvent(event)).toEqual([
      "referenceData",
      "dashboard",
      "issueBoard",
      "issueDetail",
      "history",
      "sidebar",
      "sessionTranscript",
      "orchestratorChat",
    ]);
  });

  it("combines resource counters for detail and transcript refresh dependencies", () => {
    const tokens = createLiveResourceTokenMap();
    tokens.issueBoard = 2;
    tokens.issueDetail = 3;
    tokens.history = 5;
    tokens.sessionTranscript = 7;

    expect(combineLiveResourceTokens(tokens, ["issueDetail", "issueBoard"])).toBe(5);
    expect(combineLiveResourceTokens(tokens, ["sessionTranscript", "history"])).toBe(12);
  });

  it("ignores stale or duplicate realtime revisions before invalidating caches or refreshing selected transcript resources", () => {
    let listener: RealtimeEventListener | null = null;
    const invalidateCachedReads = vi.fn();
    const dataSource = testDataSource({
      invalidateCachedReads,
      subscribeToRealtimeEvents(nextListener) {
        listener = nextListener;
        return () => undefined;
      },
    });
    const probe = renderLiveResourceProbe(dataSource);
    const emit = (event: RealtimeProjectionEvent) => {
      if (!listener) throw new Error("realtime listener was not subscribed");
      act(() => listener?.(event));
    };

    emit(
      eventFor(
        [
          { kind: "history", href: "/api/v1/web/history", relation: "refetch" },
          { kind: "session-transcript", href: "/api/v1/web/sessions/{sessionId}/transcript", relation: "template" },
        ],
        { id: "rev-5", revision: 5, type: "transcript.delta" },
      ),
    );
    expect(invalidateCachedReads).toHaveBeenCalledTimes(1);
    expect(probe.state().tokens.history).toBe(1);
    expect(probe.state().tokens.sessionTranscript).toBe(1);

    emit(
      eventFor(
        [
          { kind: "history", href: "/api/v1/web/history", relation: "refetch" },
          { kind: "session-transcript", href: "/api/v1/web/sessions/{sessionId}/transcript", relation: "template" },
        ],
        { id: "rev-5-duplicate", revision: 5, type: "transcript.delta" },
      ),
    );
    emit(eventFor([{ kind: "orchestrator-chat", href: "/api/v1/web/orchestrator-chat", relation: "refetch" }], { id: "rev-4", revision: 4 }));
    expect(invalidateCachedReads).toHaveBeenCalledTimes(1);
    expect(probe.state().tokens.history).toBe(1);
    expect(probe.state().tokens.sessionTranscript).toBe(1);
    expect(probe.state().tokens.orchestratorChat).toBe(0);

    emit(eventFor([{ kind: "dashboard", href: "/api/v1/web/dashboard", relation: "refetch" }], { id: "rev-6", revision: 6 }));
    expect(invalidateCachedReads).toHaveBeenCalledTimes(2);
    expect(probe.state().tokens.dashboard).toBe(1);

    emit(
      eventFor([], {
        id: "rev-4-missed-events",
        revision: 4,
        missedEvents: true,
        recovery: { strategy: "refetch", reason: "missed-events", lastEventId: "rev-3", endpoints: [] },
      }),
    );
    expect(invalidateCachedReads).toHaveBeenCalledTimes(3);
    for (const key of LIVE_RESOURCE_KEYS) {
      expect(probe.state().tokens[key]).toBeGreaterThan(0);
    }
  });

  it("uses the legacy projection subscription as a hook-level fallback refetch path when realtime is unavailable", () => {
    let projectionListener: ProjectionChangeListener | null = null;
    const invalidateCachedReads = vi.fn();
    const dataSource = testDataSource({
      invalidateCachedReads,
      subscribeToProjectionChanges(nextListener) {
        projectionListener = nextListener;
        return () => undefined;
      },
    });
    const probe = renderLiveResourceProbe(dataSource);
    const emit = (event: { type: string; revision?: number }) => {
      if (!projectionListener) throw new Error("projection listener was not subscribed");
      act(() => projectionListener?.(event));
    };

    expect(probe.state().realtimeStatus.kind).toBe("unavailable");
    emit({ type: "projection_closed", revision: 1 });
    expect(invalidateCachedReads).not.toHaveBeenCalled();
    for (const key of LIVE_RESOURCE_KEYS) {
      expect(probe.state().tokens[key]).toBe(0);
    }

    emit({ type: "projection_revision", revision: 2 });
    expect(invalidateCachedReads).toHaveBeenCalledTimes(1);
    for (const key of LIVE_RESOURCE_KEYS) {
      expect(probe.state().tokens[key]).toBe(1);
    }
  });
});

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
import { REALTIME_EVENT_SCHEMA, REALTIME_EVENT_SCHEMA_VERSION } from "../src/data/realtimeEvents";
import {
  LIVE_RESOURCE_KEYS,
  applyRealtimeEventToLiveResourceRevisions,
  combineLiveResourceTokens,
  createLiveResourceRevisionMap,
  createLiveResourceTokenMap,
  liveResourceKeysForRealtimeEvent,
  realtimeRefreshHrefsForEvent,
  useLiveResourceState,
  type LiveResourceState,
} from "../src/hooks/useLiveResource";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];

function eventFor(resources: readonly RealtimeProjectionResource[], overrides: Partial<RealtimeProjectionEvent> = {}): RealtimeProjectionEvent {
  const source = overrides.source ?? { source: "runs", revision: 1, observedAt: "2026-06-02T00:00:00.000Z" };
  const detail = overrides.detail ?? null;
  return {
    schema: REALTIME_EVENT_SCHEMA,
    schemaVersion: REALTIME_EVENT_SCHEMA_VERSION,
    id: "1",
    type: "projection.updated",
    revision: 1,
    createdAt: "2026-06-02T00:00:00.000Z",
    scope: "global",
    key: null,
    source,
    resources,
    recovery: {
      strategy: "refetch",
      reason: "event",
      lastEventId: null,
      endpoints: resources.map((resource) => resource.href),
    },
    missedEvents: false,
    payload: {
      source: source.source,
      sourceRevision: source.revision,
      detail,
      resourceKinds: resources.map((resource) => resource.kind),
      resourcesChanged: resources.map((resource) => resource.kind),
    },
    detail,
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

  it("uses projection.updated payload resource changes as the authoritative narrowed routing set", () => {
    const event = eventFor(
      [
        { kind: "dashboard", href: "/api/v1/web/dashboard", relation: "refetch" },
        { kind: "issue-board", href: "/api/v1/web/issues", relation: "refetch" },
        { kind: "sidebar", href: "/api/v1/web/sidebar", relation: "refetch" },
        { kind: "history", href: "/api/v1/web/history", relation: "refetch" },
      ],
      {
        id: "orchestrator-projection",
        revision: 3,
        payload: {
          source: "orchestrator-chat",
          sourceRevision: 3,
          detail: null,
          resourceKinds: ["dashboard", "issue-board", "sidebar", "history"],
          resourcesChanged: ["orchestrator-chat", "sidebar", "dashboard"],
        },
      },
    );

    expect(liveResourceKeysForRealtimeEvent(event)).toEqual(["orchestratorChat", "sidebar", "dashboard"]);
    expect(realtimeRefreshHrefsForEvent(event)).toEqual([
      "/api/v1/web/orchestrator-chat",
      "/api/v1/web/sidebar",
      "/api/v1/web/dashboard",
    ]);
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

  it("records per-resource realtime revisions and returns only resources with newer updates", () => {
    const revisions = createLiveResourceRevisionMap();
    const first = eventFor(
      [
        { kind: "dashboard", href: "/api/v1/web/dashboard", relation: "refetch" },
        { kind: "issue-board", href: "/api/v1/web/issues", relation: "refetch" },
      ],
      { id: "rev-7", revision: 7 },
    );

    expect(applyRealtimeEventToLiveResourceRevisions(revisions, first)).toEqual(["dashboard", "issueBoard"]);
    expect(revisions.dashboard).toBe(7);
    expect(revisions.issueBoard).toBe(7);

    const mixed = eventFor(
      [
        { kind: "dashboard", href: "/api/v1/web/dashboard", relation: "refetch" },
        { kind: "sidebar", href: "/api/v1/web/sidebar", relation: "refetch" },
      ],
      { id: "rev-6", revision: 6 },
    );
    expect(applyRealtimeEventToLiveResourceRevisions(revisions, mixed)).toEqual(["sidebar"]);
    expect(revisions.dashboard).toBe(7);
    expect(revisions.sidebar).toBe(6);

    const missedRecovery = eventFor([], {
      id: "rev-5-missed",
      revision: 5,
      missedEvents: true,
      recovery: { strategy: "refetch", reason: "missed-events", lastEventId: "rev-4", endpoints: [] },
    });
    expect(applyRealtimeEventToLiveResourceRevisions(revisions, missedRecovery)).toEqual([...LIVE_RESOURCE_KEYS]);
    expect(revisions.dashboard).toBe(7);
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

  it("ignores stale or duplicate realtime revisions per resource before invalidating caches or refreshing tokens", () => {
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
    expect(probe.state().revisions.history).toBe(5);
    expect(probe.state().revisions.sessionTranscript).toBe(5);

    emit(
      eventFor(
        [
          { kind: "history", href: "/api/v1/web/history", relation: "refetch" },
          { kind: "session-transcript", href: "/api/v1/web/sessions/{sessionId}/transcript", relation: "template" },
        ],
        { id: "rev-5-duplicate", revision: 5, type: "transcript.delta" },
      ),
    );
    expect(invalidateCachedReads).toHaveBeenCalledTimes(1);
    expect(probe.state().tokens.history).toBe(1);
    expect(probe.state().tokens.sessionTranscript).toBe(1);

    emit(eventFor([{ kind: "orchestrator-chat", href: "/api/v1/web/orchestrator-chat", relation: "refetch" }], { id: "rev-4", revision: 4 }));
    expect(invalidateCachedReads).toHaveBeenCalledTimes(2);
    expect(probe.state().tokens.orchestratorChat).toBe(1);
    expect(probe.state().revisions.orchestratorChat).toBe(4);

    emit(eventFor([{ kind: "history", href: "/api/v1/web/history", relation: "refetch" }], { id: "rev-4-history", revision: 4 }));
    expect(invalidateCachedReads).toHaveBeenCalledTimes(2);
    expect(probe.state().tokens.history).toBe(1);

    emit(eventFor([{ kind: "dashboard", href: "/api/v1/web/dashboard", relation: "refetch" }], { id: "rev-6", revision: 6 }));
    expect(invalidateCachedReads).toHaveBeenCalledTimes(3);
    expect(probe.state().tokens.dashboard).toBe(1);

    emit(
      eventFor(
        [
          { kind: "dashboard", href: "/api/v1/web/dashboard", relation: "refetch" },
          { kind: "sidebar", href: "/api/v1/web/sidebar", relation: "refetch" },
        ],
        { id: "rev-5-mixed", revision: 5 },
      ),
    );
    expect(invalidateCachedReads).toHaveBeenCalledTimes(4);
    expect(invalidateCachedReads).toHaveBeenLastCalledWith({ forceRefreshHrefs: ["/api/v1/web/sidebar"] });
    expect(probe.state().tokens.dashboard).toBe(1);
    expect(probe.state().tokens.sidebar).toBe(1);
    expect(probe.state().revisions.dashboard).toBe(6);
    expect(probe.state().revisions.sidebar).toBe(5);

    emit(
      eventFor([], {
        id: "rev-4-missed-events",
        revision: 4,
        missedEvents: true,
        recovery: { strategy: "refetch", reason: "missed-events", lastEventId: "rev-3", endpoints: [] },
      }),
    );
    expect(invalidateCachedReads).toHaveBeenCalledTimes(5);
    for (const key of LIVE_RESOURCE_KEYS) {
      expect(probe.state().tokens[key]).toBeGreaterThan(0);
    }
    expect(probe.state().revisions.history).toBe(5);
  });

  it("routes backend-shaped orchestrator projection updates without refreshing issue board or history resources", () => {
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
    const event = eventFor(
      [
        { kind: "dashboard", href: "/api/v1/web/dashboard", relation: "refetch" },
        { kind: "issue-board", href: "/api/v1/web/issues", relation: "refetch" },
        { kind: "sidebar", href: "/api/v1/web/sidebar", relation: "refetch" },
        { kind: "history", href: "/api/v1/web/history", relation: "refetch" },
      ],
      {
        id: "orchestrator-projection",
        revision: 11,
        payload: {
          source: "orchestrator-chat",
          sourceRevision: 11,
          detail: null,
          resourceKinds: ["dashboard", "issue-board", "sidebar", "history"],
          resourcesChanged: ["orchestrator-chat", "sidebar", "dashboard"],
        },
      },
    );

    if (!listener) throw new Error("realtime listener was not subscribed");
    act(() => listener?.(event));

    expect(invalidateCachedReads).toHaveBeenCalledTimes(1);
    expect(invalidateCachedReads).toHaveBeenLastCalledWith({
      forceRefreshHrefs: ["/api/v1/web/orchestrator-chat", "/api/v1/web/sidebar", "/api/v1/web/dashboard"],
    });
    expect(probe.state().tokens.orchestratorChat).toBe(1);
    expect(probe.state().tokens.sidebar).toBe(1);
    expect(probe.state().tokens.dashboard).toBe(1);
    expect(probe.state().tokens.issueBoard).toBe(0);
    expect(probe.state().tokens.history).toBe(0);
    expect(probe.state().revisions.orchestratorChat).toBe(11);
    expect(probe.state().revisions.sidebar).toBe(11);
    expect(probe.state().revisions.dashboard).toBe(11);
    expect(probe.state().revisions.issueBoard).toBeNull();
    expect(probe.state().revisions.history).toBeNull();
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

import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiDataSource, normalizeReferenceData } from "../src/data/apiDataSource";
import type { ProjectionChangeEvent, RealtimeConnectionStatus, RealtimeProjectionEvent } from "../src/data/dataSource";
import { createDataSource, resolveDataSourceConfig } from "../src/data/dataSourceConfig";
import { REALTIME_EVENT_SCHEMA, REALTIME_EVENT_SCHEMA_VERSION } from "../src/data/realtimeEvents";
import type { ChatMessage, DashboardModel, HistoryModel, IssueBoardModel, TranscriptMessage } from "../src/types/symphony";

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
  if (originalEventSource) {
    globalThis.EventSource = originalEventSource;
  } else {
    Reflect.deleteProperty(globalThis, "EventSource");
  }
});

function mockJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readonly url: string;
  closed = false;
  readyState = FakeEventSource.CONNECTING;
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  emit(type: string, data?: string, init: MessageEventInit = {}): void {
    const event = typeof data === "string" ? new MessageEvent(type, { ...init, data }) : new Event(type);
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === "function") {
        listener(event);
      } else {
        listener.handleEvent(event);
      }
    }
  }

  emitOpen(): void {
    this.readyState = FakeEventSource.OPEN;
    this.emit("open");
  }

  emitError(readyState = FakeEventSource.CONNECTING): void {
    this.readyState = readyState;
    this.emit("error");
  }
}

const chatResponse: ChatMessage[] = [{ who: "agent", text: "Chat loaded from the API." }];

function realtimeEvent(overrides: Partial<RealtimeProjectionEvent> = {}): RealtimeProjectionEvent {
  const resources = overrides.resources ?? [{ kind: "dashboard", href: "/api/v1/web/dashboard", relation: "refetch" }];
  const source = overrides.source ?? { source: "runs", revision: 1, observedAt: "2026-06-02T00:00:00.000Z" };
  const detail = overrides.detail ?? null;
  const type = overrides.type ?? "projection.updated";
  return {
    schema: REALTIME_EVENT_SCHEMA,
    schemaVersion: REALTIME_EVENT_SCHEMA_VERSION,
    id: "1",
    type,
    revision: 1,
    createdAt: "2026-06-02T00:00:00.000Z",
    scope: realtimeScopeForTestEvent(type),
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
    payload: realtimePayloadForTestEvent(type, source, resources, detail),
    detail,
    ...overrides,
  };
}

function realtimeScopeForTestEvent(type: RealtimeProjectionEvent["type"]): RealtimeProjectionEvent["scope"] {
  if (type === "source.status") return "source";
  if (type === "run.updated") return "run";
  if (type === "transcript.delta") return "session";
  if (type === "orchestrator.message") return "orchestrator";
  return "global";
}

function realtimePayloadForTestEvent(
  type: RealtimeProjectionEvent["type"],
  source: RealtimeProjectionEvent["source"],
  resources: RealtimeProjectionEvent["resources"],
  detail: RealtimeProjectionEvent["detail"],
): RealtimeProjectionEvent["payload"] {
  const base = { source: source.source, sourceRevision: source.revision, detail };
  if (type === "run.updated") {
    return { ...base, runId: null, issueId: null, issueIdentifier: null, status: null };
  }
  if (type === "transcript.delta") {
    return { ...base, runId: null, sessionId: null, afterSequence: null, eventCount: null };
  }
  if (type === "orchestrator.message") {
    return { ...base, conversationId: null, messageCount: null, inputLength: null, status: null };
  }
  if (type === "source.status") {
    return { ...base, status: null, fetchedStates: [], fetchedAt: null, cached: null, error: null, issueCount: null };
  }
  return {
    ...base,
    resourceKinds: resources.map((resource) => resource.kind),
    resourcesChanged: resources.map((resource) => resource.kind),
  };
}

const historyModel: HistoryModel = {
  sessions: [
    {
      id: "run/with space",
      issue: "ENG-106",
      title: "ENG-106: Integrate web history",
      state: "finished",
      model: "gpt-5.5",
      startedAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:05:00.000Z",
      msgCount: 2,
      lastEvent: "ENG-106 run finished",
      toolCount: 1,
    },
  ],
  transcriptBySession: {},
  timeline: [
    {
      t: "2026-05-29T00:05:00.000Z",
      sess: "run/with space",
      kind: "status",
      text: "ENG-106 run finished",
      state: "finished",
    },
  ],
  defaultSessionId: "run/with space",
};

const transcript: TranscriptMessage[] = [
  {
    kind: "user",
    ts: "2026-05-29T00:01:00.000Z",
    from: "operator",
    issue: "ENG-106",
    text: "Load history from the API.",
  },
  {
    kind: "assistant",
    ts: "2026-05-29T00:02:00.000Z",
    text: "History loaded.",
  },
];

const dashboardModel: DashboardModel = {
  projectName: "Symphony API",
  repoLabel: "johnhalbert/symphony",
  branch: "sinfonista/api-source",
  workflowLabel: "WORKFLOW.md@main",
  pollLabel: "poll 10s",
  agentUsageLabel: "1/2 agents",
  concurrencyCap: 2,
  providerGates: [],
  runningAgents: [
    {
      id: "agent-api-1",
      issue: "ENG-115",
      title: "Add API data source tests",
      state: "running",
      step: "validating",
      duration: "2m",
      tokens: "4k",
    },
  ],
  activity: [{ t: "now", who: "orchestrator", verb: "dispatched", id: "ENG-115", extra: "worker" }],
  chat: [{ who: "agent", text: "Dashboard loaded from the API." }],
  totals: { backlog: 1, todo: 1, progress: 1, review: 1, done: 2, cancelled: 0, open: 4, all: 6, completeness: 33 },
};

const issueBoardIssues: IssueBoardModel["issues"] = [
  {
    id: "ENG-2",
    title: "Todo issue from API",
    status: "todo",
    priority: 1,
    labels: ["dogfood-ready"],
    assignee: "delegate-a",
    agent: "agent-api-2",
    project: "Symphony",
    cycle: "Cycle API",
    desc: ["Server-projected description should pass through unchanged."],
    activity: [{ t: "now", verb: "queued", val: "worker", who: "orchestrator" }],
    pr: "#84",
    ci: "pending",
    workspace: "ENG-2",
    session: "session-api-2",
  },
  {
    id: "ENG-1",
    title: "Backlog issue from API",
    status: "backlog",
    priority: "urgent",
    labels: ["api"],
    assignee: "unassigned",
    project: "Symphony",
    cycle: "Cycle API",
  },
  {
    id: "ENG-3",
    title: "Review issue from API",
    status: "review",
    priority: 3,
    labels: ["review-loop"],
    assignee: "reviewer-a",
    project: "Symphony",
    cycle: "Cycle API",
  },
];

const issueBoardModel: IssueBoardModel = {
  issues: issueBoardIssues,
  backlog: [issueBoardIssues[1], issueBoardIssues[0]],
  lanes: {
    todo: [issueBoardIssues[0]],
    progress: [],
    review: [issueBoardIssues[2]],
  },
  cycleLabel: "Symphony · API Cycle",
  cycleDateRange: "May 29 - Jun 12",
  selectedIssueId: "ENG-2",
};

describe("API data source", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses same-origin /api paths when no base URL is configured", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ projectName: "Symphony" }));

    await createApiDataSource("").getDashboard();

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/web/dashboard", {
      headers: { Accept: "application/json" },
      signal: undefined,
    });
  });

  it("uses configured slash API mode for same-origin requests instead of mock fallback", async () => {
    const config = resolveDataSourceConfig({ VITE_SYMPHONY_API_BASE_URL: " / " });
    expect(config).toEqual({ mode: "api", apiBaseUrl: "/" });

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(dashboardModel));

    await expect(createDataSource(config).getDashboard()).resolves.toEqual(dashboardModel);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/web/dashboard", {
      headers: { Accept: "application/json" },
      signal: undefined,
    });
  });

  it("returns the dashboard payload from GET /api/v1/web/dashboard without mock fallbacks", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(dashboardModel));

    await expect(createApiDataSource("/status-server/").getDashboard()).resolves.toEqual(dashboardModel);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/status-server/api/v1/web/dashboard", {
      headers: { Accept: "application/json" },
      signal: undefined,
    });
  });

  it("deduplicates simultaneous duplicate GET requests through one in-flight API call", async () => {
    const gate = deferred<Response>();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValue(gate.promise);
    const dataSource = createApiDataSource("/status-server/");

    const first = dataSource.getDashboard();
    const second = dataSource.getDashboard();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/status-server/api/v1/web/dashboard", {
      headers: { Accept: "application/json" },
      signal: undefined,
    });

    gate.resolve(jsonResponse(dashboardModel));
    await expect(Promise.all([first, second])).resolves.toEqual([dashboardModel, dashboardModel]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("deduplicates hook-style signaled duplicate cacheable GET requests and reuses their successful response", async () => {
    const gate = deferred<Response>();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValue(gate.promise);
    const dataSource = createApiDataSource("/status-server/");
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = dataSource.getDashboard(firstController.signal);
    const second = dataSource.getDashboard(secondController.signal);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/status-server/api/v1/web/dashboard", {
      headers: { Accept: "application/json" },
      signal: undefined,
    });

    gate.resolve(jsonResponse(dashboardModel));
    await expect(Promise.all([first, second])).resolves.toEqual([dashboardModel, dashboardModel]);

    const cacheController = new AbortController();
    await expect(dataSource.getDashboard(cacheController.signal)).resolves.toEqual(dashboardModel);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cancels a stale signaled subscriber without breaking the shared cacheable GET for active subscribers", async () => {
    const gate = deferred<Response>();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValue(gate.promise);
    const dataSource = createApiDataSource("/status-server/");
    const staleController = new AbortController();
    const activeController = new AbortController();

    const staleRequest = dataSource.getDashboard(staleController.signal);
    const activeRequest = dataSource.getDashboard(activeController.signal);
    staleController.abort();

    await expect(staleRequest).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    gate.resolve(jsonResponse(dashboardModel));
    await expect(activeRequest).resolves.toEqual(dashboardModel);
    await expect(dataSource.getDashboard()).resolves.toEqual(dashboardModel);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reuses successful duplicate GET responses briefly before refreshing after the cache window", async () => {
    const dateNow = vi.spyOn(Date, "now");
    dateNow.mockReturnValue(1_000);
    const refreshedDashboard = { ...dashboardModel, pollLabel: "poll refreshed" };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(dashboardModel))
      .mockResolvedValueOnce(jsonResponse(refreshedDashboard));
    const dataSource = createApiDataSource("/status-server/");

    await expect(dataSource.getDashboard()).resolves.toEqual(dashboardModel);
    dateNow.mockReturnValue(5_999);
    await expect(dataSource.getDashboard()).resolves.toEqual(dashboardModel);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    dateNow.mockReturnValue(6_001);
    await expect(dataSource.getDashboard()).resolves.toEqual(refreshedDashboard);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("invalidates cached GET responses when realtime projection changes arrive", async () => {
    const refreshedDashboard = { ...dashboardModel, pollLabel: "poll realtime" };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(dashboardModel))
      .mockResolvedValueOnce(jsonResponse(refreshedDashboard));
    const dataSource = createApiDataSource("/status-server/");

    await expect(dataSource.getDashboard()).resolves.toEqual(dashboardModel);
    await expect(dataSource.getDashboard()).resolves.toEqual(dashboardModel);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    dataSource.invalidateCachedReads?.();

    await expect(dataSource.getDashboard()).resolves.toEqual(refreshedDashboard);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fences in-flight cacheable GETs when realtime projection invalidation arrives", async () => {
    const staleDashboard = { ...dashboardModel, pollLabel: "poll stale in-flight" };
    const refreshedDashboard = { ...dashboardModel, pollLabel: "poll post-invalidation" };
    const staleGate = deferred<Response>();
    const freshGate = deferred<Response>();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValueOnce(staleGate.promise)
      .mockReturnValueOnce(freshGate.promise);
    const dataSource = createApiDataSource("/status-server/");

    const staleRequest = dataSource.getDashboard();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    dataSource.invalidateCachedReads?.();
    const postInvalidationRequest = dataSource.getDashboard();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    staleGate.resolve(jsonResponse(staleDashboard));
    await expect(staleRequest).resolves.toEqual(staleDashboard);

    const sharedPostInvalidationRequest = dataSource.getDashboard();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    freshGate.resolve(jsonResponse(refreshedDashboard));
    await expect(Promise.all([postInvalidationRequest, sharedPostInvalidationRequest])).resolves.toEqual([
      refreshedDashboard,
      refreshedDashboard,
    ]);
    await expect(dataSource.getDashboard()).resolves.toEqual(refreshedDashboard);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("subscribes to projection revision events through EventSource and ignores malformed payload shape safely", () => {
    FakeEventSource.instances = [];
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    const events: ProjectionChangeEvent[] = [];
    const dataSource = createApiDataSource("/status-server/");

    const unsubscribe = dataSource.subscribeToProjectionChanges?.((event) => events.push(event));
    expect(unsubscribe).toBeDefined();
    const eventSource = FakeEventSource.instances[0];
    expect(eventSource?.url).toBe("/status-server/api/v1/web/events");

    eventSource?.emit("projection_revision", JSON.stringify({ type: "projection_revision", generation: 4, source: "runs", revision: 9 }));
    eventSource?.emit("projection_revision", "not-json");
    unsubscribe?.();

    expect(events).toEqual([
      { type: "projection_revision", generation: 4, source: "runs", revision: 9 },
      { type: "projection_revision" },
    ]);
    expect(eventSource?.closed).toBe(true);
  });

  it("treats missing EventSource support as a no-op projection subscription", () => {
    Reflect.deleteProperty(globalThis, "EventSource");
    const events: ProjectionChangeEvent[] = [];

    const unsubscribe = createApiDataSource("").subscribeToProjectionChanges?.((event) => events.push(event));
    unsubscribe?.();

    expect(events).toEqual([]);
  });

  it("subscribes to typed realtime events through EventSource with explicit resume support", () => {
    FakeEventSource.instances = [];
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    const events: RealtimeProjectionEvent[] = [];
    const dataSource = createApiDataSource("/status-server/");

    const unsubscribe = dataSource.subscribeToRealtimeEvents?.((event) => events.push(event), { lastEventId: "4 /5" });
    expect(unsubscribe).toBeDefined();
    const eventSource = FakeEventSource.instances[0];
    expect(eventSource?.url).toBe("/status-server/api/v1/realtime?lastEventId=4%20%2F5");

    const runEvent = realtimeEvent({
      id: "5",
      type: "run.updated",
      revision: 5,
      resources: [{ kind: "history", href: "/api/v1/web/history", relation: "refetch" }],
    });
    const projectionEvent = realtimeEvent({ id: "6", revision: 6, type: "projection.updated" });
    eventSource?.emit("run.updated", JSON.stringify(runEvent), { lastEventId: "not-5" });
    eventSource?.emit("run.updated", JSON.stringify(projectionEvent));
    eventSource?.emit("message", JSON.stringify(projectionEvent));
    eventSource?.emit("run.updated", JSON.stringify(runEvent), { lastEventId: "5" });
    eventSource?.emit("run.updated", "not-json");
    eventSource?.emit("run.updated", JSON.stringify({ type: "run.updated" }));
    eventSource?.emit("run.updated", JSON.stringify({ ...runEvent, scope: "global" }));
    eventSource?.emit("run.updated", JSON.stringify({ ...runEvent, payload: projectionEvent.payload }));
    eventSource?.emit("projection.updated", JSON.stringify(projectionEvent));
    unsubscribe?.();

    expect(events).toEqual([runEvent, projectionEvent]);
    expect(eventSource?.closed).toBe(true);
  });

  it("shares one API-mode realtime EventSource connection across subscribers", () => {
    FakeEventSource.instances = [];
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    const firstSubscriberEvents: RealtimeProjectionEvent[] = [];
    const secondSubscriberEvents: RealtimeProjectionEvent[] = [];
    const firstSubscriberStatuses: RealtimeConnectionStatus[] = [];
    const secondSubscriberStatuses: RealtimeConnectionStatus[] = [];
    const dataSource = createApiDataSource("/status-server/");

    const unsubscribeFirst = dataSource.subscribeToRealtimeEvents?.((event) => firstSubscriberEvents.push(event), {
      lastEventId: " first-event ",
      onStatus: (status) => firstSubscriberStatuses.push(status),
    });
    expect(FakeEventSource.instances).toHaveLength(1);
    const eventSource = FakeEventSource.instances[0];
    expect(eventSource?.url).toBe("/status-server/api/v1/realtime?lastEventId=first-event");
    expect(firstSubscriberStatuses.map((status) => status.kind)).toEqual(["connecting"]);

    eventSource?.emitOpen();
    const unsubscribeSecond = dataSource.subscribeToRealtimeEvents?.((event) => secondSubscriberEvents.push(event), {
      lastEventId: "second-event",
      onStatus: (status) => secondSubscriberStatuses.push(status),
    });
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(secondSubscriberStatuses.map((status) => status.kind)).toEqual(["open"]);

    const event = realtimeEvent({ id: "shared-2", revision: 2 });
    eventSource?.emit("projection.updated", JSON.stringify(event));
    expect(firstSubscriberEvents).toEqual([event]);
    expect(secondSubscriberEvents).toEqual([event]);

    unsubscribeFirst?.();
    expect(eventSource?.closed).toBe(false);
    unsubscribeSecond?.();
    expect(eventSource?.closed).toBe(true);
  });

  it("surfaces realtime connect, reconnect, recovery, stale, and closed-error status", () => {
    FakeEventSource.instances = [];
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    const events: RealtimeProjectionEvent[] = [];
    const statuses: RealtimeConnectionStatus[] = [];
    const dataSource = createApiDataSource("/status-server/");

    const unsubscribe = dataSource.subscribeToRealtimeEvents?.((event) => events.push(event), {
      onStatus: (status) => statuses.push(status),
    });
    const eventSource = FakeEventSource.instances[0];

    expect(statuses.map((status) => status.kind)).toEqual(["connecting"]);
    eventSource?.emitOpen();
    eventSource?.emitError();
    eventSource?.emitOpen();
    const missedEvent = realtimeEvent({
      id: "missed-7",
      revision: 7,
      missedEvents: true,
      recovery: { strategy: "refetch", reason: "missed-events", lastEventId: "missed-6", endpoints: [] },
      resources: [],
    });
    eventSource?.emit("projection.updated", JSON.stringify(missedEvent));
    expect(statuses.at(-1)).toMatchObject({ lastEventId: "missed-6", revision: 7, missedEvents: true });
    eventSource?.emitError(FakeEventSource.CLOSED);
    unsubscribe?.();

    expect(statuses.map((status) => status.kind)).toEqual(["connecting", "open", "reconnecting", "recovered", "stale", "error"]);
    expect(statuses.map((status) => status.label)).toEqual([
      "realtime connecting",
      "realtime connected",
      "realtime reconnecting",
      "realtime recovered",
      "realtime stale · refetching",
      "realtime error",
    ]);
    expect(statuses.at(-2)).toMatchObject({ lastEventId: "missed-6", revision: 7, missedEvents: true });
    expect(events).toEqual([missedEvent]);
    expect(eventSource?.closed).toBe(true);
  });

  it("treats missing EventSource support as a no-op realtime subscription", () => {
    Reflect.deleteProperty(globalThis, "EventSource");
    const events: RealtimeProjectionEvent[] = [];
    const statuses: RealtimeConnectionStatus[] = [];

    const unsubscribe = createApiDataSource("").subscribeToRealtimeEvents?.((event) => events.push(event), {
      onStatus: (status) => statuses.push(status),
    });
    unsubscribe?.();

    expect(events).toEqual([]);
    expect(statuses.map((status) => status.kind)).toEqual(["unavailable"]);
  });

  it("uses realtime force-refresh hrefs on the next cacheable GET after invalidation", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(dashboardModel))
      .mockResolvedValueOnce(jsonResponse(issueBoardModel));
    const dataSource = createApiDataSource("/status-server/");

    dataSource.invalidateCachedReads?.({
      forceRefreshHrefs: ["/api/v1/web/dashboard?refresh=1", "/api/v1/web/issues?refresh=true"],
    });

    await expect(dataSource.getDashboard()).resolves.toEqual(dashboardModel);
    await expect(dataSource.getIssueBoard()).resolves.toEqual(issueBoardModel);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/status-server/api/v1/web/dashboard?refresh=1", {
      headers: { Accept: "application/json" },
      signal: undefined,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/status-server/api/v1/web/issues?refresh=1", {
      headers: { Accept: "application/json" },
      signal: undefined,
    });
  });

  it("does not cache failed GET responses", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ error: "temporarily unavailable" }, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse(dashboardModel));
    const dataSource = createApiDataSource("/status-server/");

    await expect(dataSource.getDashboard()).rejects.toThrow("Symphony API returned HTTP 503");
    await expect(dataSource.getDashboard()).resolves.toEqual(dashboardModel);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not deduplicate orchestrator chat POST requests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse(chatResponse));
    const dataSource = createApiDataSource("/status-server/");

    await expect(dataSource.sendOrchestratorMessage("status")).resolves.toEqual(chatResponse);
    await expect(dataSource.sendOrchestratorMessage("status")).resolves.toEqual(chatResponse);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/status-server/api/v1/web/orchestrator-chat", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ input: "status" }),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/status-server/api/v1/web/orchestrator-chat", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ input: "status" }),
    });
  });

  it("returns the issue-board payload from GET /api/v1/web/issues without client-side reshaping", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(issueBoardModel));

    await expect(createApiDataSource("https://symphony.example.test/").getIssueBoard()).resolves.toEqual(issueBoardModel);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("https://symphony.example.test/api/v1/web/issues", {
      headers: { Accept: "application/json" },
      signal: undefined,
    });
  });

  it("fetches issue detail from the encoded issue-detail endpoint", async () => {
    const detail = { issue: { id: "ENG/109", title: "Detail" }, activity: [], runs: [], transcript: [] };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(detail));

    await expect(createApiDataSource("https://symphony.example.test///").getIssueDetail("ENG/109")).resolves.toEqual(detail);
    expect(fetchMock).toHaveBeenCalledWith("https://symphony.example.test/api/v1/web/issues/ENG%2F109", {
      headers: { Accept: "application/json" },
      signal: undefined,
    });
  });

  it("passes through null issue detail responses", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(null));

    await expect(createApiDataSource("").getIssueDetail("UNKNOWN-1")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/web/issues/UNKNOWN-1", {
      headers: { Accept: "application/json" },
      signal: undefined,
    });
  });

  it("normalizes absolute base URLs and encodes path parameters", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ id: "ENG/102" }));

    await createApiDataSource("https://symphony.test///").getIssueDetail("ENG/102");

    expect(fetchMock).toHaveBeenCalledWith("https://symphony.test/api/v1/web/issues/ENG%2F102", {
      headers: { Accept: "application/json" },
      signal: undefined,
    });
  });

  it("fetches the dedicated sidebar endpoint without remapping enriched issue fields", async () => {
    const sidebar = {
      providerGates: [],
      runningAgents: [{ id: "agent-1", issue: "ENG-7", title: "Sidebar", state: "running", step: "render", duration: "1m", tokens: "1k" }],
      reviewIssues: [
        {
          id: "ENG-8",
          title: "Review enriched issue",
          status: "review",
          priority: "urgent",
          labels: ["dogfood", "api"],
          assignee: "reviewer-1",
          agent: "agent-2",
          project: "Symphony",
          cycle: "Cycle 1",
          activity: [{ t: "now", verb: "reviewed", val: "pass", who: "bot" }],
          pr: "#123",
          ci: "green",
          workspace: "ENG-8",
          session: "session-8",
        },
      ],
      activity: [],
      sessions: [],
      chat: [],
      totals: { backlog: 0, todo: 0, progress: 0, review: 1, done: 0, cancelled: 0, open: 1, all: 1, completeness: 0 },
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(sidebar));

    await expect(createApiDataSource("").getSidebar()).resolves.toEqual(sidebar);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/web/sidebar", {
      headers: { Accept: "application/json" },
      signal: undefined,
    });
  });

  it("loads the web history model from GET /api/v1/web/history", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(historyModel));

    await expect(createApiDataSource("http://localhost:7331/").getHistory()).resolves.toEqual(historyModel);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:7331/api/v1/web/history", {
      headers: { Accept: "application/json" },
      signal: undefined,
    });
  });

  it("derives session lists from GET /api/v1/web/history instead of a legacy sessions endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(historyModel));

    await expect(createApiDataSource("").getSessions()).resolves.toEqual(historyModel.sessions);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/web/history", {
      headers: { Accept: "application/json" },
      signal: undefined,
    });
  });

  it("loads selected session transcripts using the encoded web session id", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(transcript));

    await expect(createApiDataSource("").getTranscript("run/with space")).resolves.toEqual(transcript);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/web/sessions/run%2Fwith%20space/transcript", {
      headers: { Accept: "application/json" },
      signal: undefined,
    });
  });

  it("passes AbortSignal through selected detail and transcript reads without sharing stale responses", async () => {
    const firstDetail = { issue: { id: "ENG-124", title: "first detail" }, activity: [], runs: [], transcript: [] };
    const secondDetail = { issue: { id: "ENG-124", title: "second detail" }, activity: [], runs: [], transcript: [] };
    const firstTranscript: TranscriptMessage[] = [{ kind: "assistant", ts: "2026-05-30T00:00:00.000Z", text: "first transcript" }];
    const secondTranscript: TranscriptMessage[] = [{ kind: "assistant", ts: "2026-05-30T00:00:01.000Z", text: "second transcript" }];
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(firstDetail))
      .mockResolvedValueOnce(jsonResponse(secondDetail))
      .mockResolvedValueOnce(jsonResponse(firstTranscript))
      .mockResolvedValueOnce(jsonResponse(secondTranscript));
    const firstController = new AbortController();
    const secondController = new AbortController();
    const dataSource = createApiDataSource("");

    await expect(dataSource.getIssueDetail("ENG-124", firstController.signal)).resolves.toEqual(firstDetail);
    await expect(dataSource.getIssueDetail("ENG-124", secondController.signal)).resolves.toEqual(secondDetail);
    await expect(dataSource.getTranscript("run-124", firstController.signal)).resolves.toEqual(firstTranscript);
    await expect(dataSource.getTranscript("run-124", secondController.signal)).resolves.toEqual(secondTranscript);

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/web/issues/ENG-124", {
      headers: { Accept: "application/json" },
      signal: firstController.signal,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/web/issues/ENG-124", {
      headers: { Accept: "application/json" },
      signal: secondController.signal,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/v1/web/sessions/run-124/transcript", {
      headers: { Accept: "application/json" },
      signal: firstController.signal,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(4, "/api/v1/web/sessions/run-124/transcript", {
      headers: { Accept: "application/json" },
      signal: secondController.signal,
    });
  });

  it("loads GET /api/v1/web/orchestrator-chat from the configured API base URL", async () => {
    const chat: ChatMessage[] = [
      { who: "agent", text: "Chat loaded from the API.", suggestions: ["Inspect ENG-108"] },
      { who: "user", text: "show active workers" },
    ];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(chat));

    await expect(createApiDataSource("https://symphony.example///").getOrchestratorChat()).resolves.toEqual(chat);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("https://symphony.example/api/v1/web/orchestrator-chat", {
      headers: { Accept: "application/json" },
      signal: undefined,
    });
  });

  it("posts orchestrator chat input to the same relative API boundary and returns the response chat", async () => {
    const responseChat: ChatMessage[] = [{ who: "user", text: "pause ENG-108" }];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(responseChat));

    await expect(createApiDataSource("").sendOrchestratorMessage("pause ENG-108")).resolves.toEqual(responseChat);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/web/orchestrator-chat", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ input: "pause ENG-108" }),
    });
  });

  it("posts orchestrator chat input to the configured API base URL", async () => {
    const responseChat: ChatMessage[] = [{ who: "agent", text: "Inspecting ENG-115 from the API." }];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(responseChat));

    await expect(createApiDataSource("https://symphony.example///").sendOrchestratorMessage("inspect ENG-115")).resolves.toEqual(
      responseChat,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("https://symphony.example/api/v1/web/orchestrator-chat", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ input: "inspect ENG-115" }),
    });
  });

  it("surfaces non-2xx API responses as errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "nope" }, { status: 502 }));

    await expect(createApiDataSource("").getIssueBoard()).rejects.toThrow("Symphony API returned HTTP 502");
  });

  it("surfaces issue-detail HTTP failures", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));

    await expect(createApiDataSource("https://symphony.example.test").getIssueDetail("missing")).rejects.toThrow(
      "Symphony API returned HTTP 404",
    );
    expect(fetchMock).toHaveBeenCalledWith("https://symphony.example.test/api/v1/web/issues/missing", {
      headers: { Accept: "application/json" },
      signal: undefined,
    });
  });

  it("surfaces non-2xx history responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "unavailable" }, { status: 503 }));

    await expect(createApiDataSource("http://localhost:7331").getHistory()).rejects.toThrow("Symphony API returned HTTP 503");
  });

  it("surfaces non-2xx orchestrator chat responses instead of substituting mock chat", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: { code: "unavailable" } }, { status: 503 }));

    await expect(createApiDataSource("https://symphony.example").getOrchestratorChat()).rejects.toThrow(
      "Symphony API returned HTTP 503",
    );
  });

  it("surfaces non-2xx orchestrator chat POST responses instead of appending mock chat", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: { code: "approval_required" } }, { status: 409 }));

    await expect(createApiDataSource("").sendOrchestratorMessage("resume ENG-115")).rejects.toThrow(
      "Symphony API returned HTTP 409",
    );
  });
});

describe("api data source reference data", () => {
  it("loads GET /api/v1/web/reference-data from the configured API base URL", async () => {
    const fetchMock = vi.fn(async () =>
      mockJsonResponse({
        users: {
          unassigned: { name: "Unassigned", color: "#6f7785" },
          "delegate-review": { name: "delegate-review", color: null },
        },
        labels: {
          "dogfood-ready": { name: "dogfood-ready", color: "#7fc28b" },
        },
      }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const dataSource = createApiDataSource("https://symphony.example///");
    const reference = await dataSource.getReferenceData();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("https://symphony.example/api/v1/web/reference-data", {
      headers: { Accept: "application/json" },
      signal: undefined,
    });
    expect(reference).toEqual({
      users: {
        unassigned: { name: "Unassigned", color: "#6f7785" },
        "delegate-review": { name: "delegate-review", color: null },
      },
      labels: {
        "dogfood-ready": { name: "dogfood-ready", color: "#7fc28b" },
      },
    });
  });

  it("normalizes sparse reference records without dropping usable keys", () => {
    expect(
      normalizeReferenceData({
        users: {
          "delegate-a": { name: "  ", color: null },
          "user-b": null,
        },
        labels: {
          alpha: { color: "#123456" },
          beta: { name: "Beta", color: undefined },
        },
      }),
    ).toEqual({
      users: {
        "delegate-a": { name: "delegate-a", color: null },
        "user-b": { name: "user-b", color: null },
      },
      labels: {
        alpha: { name: "alpha", color: "#123456" },
        beta: { name: "Beta", color: null },
      },
    });
  });

  it("surfaces HTTP failures while loading reference data", async () => {
    globalThis.fetch = vi.fn(async () => mockJsonResponse({ error: { code: "tracker_unavailable" } }, 503)) as typeof fetch;

    await expect(createApiDataSource("https://symphony.example").getReferenceData()).rejects.toThrow(
      "Symphony API returned HTTP 503",
    );
  });
});

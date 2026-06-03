import {
  REALTIME_PROJECTION_EVENT_TYPES,
  parseRealtimeProjectionEventData,
  realtimeConnectionStatus,
  type RealtimeConnectionStatus,
  type RealtimeEventListener,
  type RealtimeEventUnsubscribe,
  type RealtimeProjectionEvent,
  type RealtimeSubscriptionOptions,
} from "./realtimeEvents";

interface RealtimeEventSourceClientOptions {
  urlForLastEventId(lastEventId: string | null): string;
  reconnectDelayMs?: number;
}

const REALTIME_EVENT_SOURCE_RECONNECT_MS = 5_000;

interface RealtimeEventSourceSubscriber {
  listener: RealtimeEventListener;
  onStatus?: (status: RealtimeConnectionStatus) => void;
}

export interface RealtimeEventSourceClient {
  subscribe(listener: RealtimeEventListener, options?: RealtimeSubscriptionOptions): RealtimeEventUnsubscribe;
  close(): void;
}

export function createRealtimeEventSourceClient(options: RealtimeEventSourceClientOptions): RealtimeEventSourceClient {
  const subscribers = new Map<symbol, RealtimeEventSourceSubscriber>();
  const reconnectDelayMs = Math.max(1, Math.trunc(options.reconnectDelayMs ?? REALTIME_EVENT_SOURCE_RECONNECT_MS));
  let eventSource: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let lastStatus: RealtimeConnectionStatus | null = null;
  let lastEventId: string | null = null;
  let sawConnectionError = false;

  function publishStatus(status: RealtimeConnectionStatus): void {
    lastStatus = status;
    for (const subscriber of subscribers.values()) subscriber.onStatus?.(status);
  }

  function publishEvent(event: RealtimeProjectionEvent): void {
    for (const subscriber of subscribers.values()) subscriber.listener(event);
  }

  function open(resumeLastEventId: string | null): void {
    clearReconnectTimer();
    publishStatus(realtimeConnectionStatus("connecting"));
    const source = new EventSource(options.urlForLastEventId(resumeLastEventId));
    eventSource = source;
    source.addEventListener("open", () => handleOpen(source));
    source.addEventListener("error", () => handleConnectionError(source));
    for (const type of REALTIME_PROJECTION_EVENT_TYPES) source.addEventListener(type, (event) => handleRealtimeEvent(source, event as MessageEvent));
    source.addEventListener("message", (event) => handleRealtimeEvent(source, event as MessageEvent));
  }

  function close(): void {
    clearReconnectTimer();
    eventSource?.close();
    eventSource = null;
    subscribers.clear();
    sawConnectionError = false;
    lastStatus = null;
    lastEventId = null;
  }

  function clearReconnectTimer(): void {
    if (!reconnectTimer) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function scheduleReconnect(): void {
    if (reconnectTimer || subscribers.size === 0) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (subscribers.size === 0 || eventSource) return;
      open(lastEventId);
    }, reconnectDelayMs);
  }

  function handleOpen(source: EventSource): void {
    if (source !== eventSource) return;
    publishStatus(realtimeConnectionStatus(sawConnectionError ? "recovered" : "open"));
    sawConnectionError = false;
  }

  function handleConnectionError(source: EventSource): void {
    if (source !== eventSource) return;
    sawConnectionError = true;
    const closed = source.readyState === EventSource.CLOSED;
    if (closed) {
      source.close();
      if (source === eventSource) eventSource = null;
    }
    publishStatus(realtimeConnectionStatus("reconnecting"));
    if (closed) scheduleReconnect();
  }

  function handleRealtimeEvent(source: EventSource, event: MessageEvent): void {
    if (source !== eventSource) return;
    const parsed = parseRealtimeProjectionTransportEvent(event);
    if (!parsed) return;
    lastEventId = parsed.id;
    if (parsed.missedEvents || parsed.recovery.reason === "missed-events") {
      publishStatus(
        realtimeConnectionStatus("stale", {
          lastEventId: parsed.recovery.lastEventId,
          revision: parsed.revision,
          missedEvents: true,
        }),
      );
    }
    publishEvent(parsed);
  }

  return {
    subscribe(listener, subscriptionOptions = {}) {
      if (typeof EventSource === "undefined") {
        subscriptionOptions.onStatus?.(realtimeConnectionStatus("unavailable"));
        return () => undefined;
      }

      const hadSubscribers = subscribers.size > 0;
      const subscriberId = Symbol("realtime-event-source-subscriber");
      subscribers.set(subscriberId, { listener, onStatus: subscriptionOptions.onStatus });
      if (!eventSource && !hadSubscribers) {
        lastEventId = normalizeSubscriptionLastEventId(subscriptionOptions.lastEventId);
        open(lastEventId);
      } else if (lastStatus) {
        subscriptionOptions.onStatus?.(lastStatus);
      }

      return () => {
        subscribers.delete(subscriberId);
        if (subscribers.size === 0) close();
      };
    },
    close,
  };
}

function normalizeSubscriptionLastEventId(lastEventId: string | null | undefined): string | null {
  const normalized = lastEventId?.trim();
  return normalized && normalized.length > 0 ? normalized : null;
}

export function parseRealtimeProjectionTransportEvent(event: MessageEvent): RealtimeProjectionEvent | null {
  if (typeof event.data !== "string") return null;
  const parsed = parseRealtimeProjectionEventData(event.data);
  if (!parsed) return null;

  if (event.type !== parsed.type) return null;

  const lastEventId = typeof event.lastEventId === "string" ? event.lastEventId : "";
  if (lastEventId !== "" && lastEventId !== parsed.id) return null;

  const transportId = (event as { id?: unknown }).id;
  if (typeof transportId === "string" && transportId !== "" && transportId !== parsed.id) return null;

  return parsed;
}

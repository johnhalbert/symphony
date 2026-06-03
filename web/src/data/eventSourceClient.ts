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
}

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
  let eventSource: EventSource | null = null;
  let lastStatus: RealtimeConnectionStatus | null = null;
  let sawConnectionError = false;

  function publishStatus(status: RealtimeConnectionStatus): void {
    lastStatus = status;
    for (const subscriber of subscribers.values()) subscriber.onStatus?.(status);
  }

  function publishEvent(event: RealtimeProjectionEvent): void {
    for (const subscriber of subscribers.values()) subscriber.listener(event);
  }

  function open(lastEventId: string | null): void {
    publishStatus(realtimeConnectionStatus("connecting"));
    eventSource = new EventSource(options.urlForLastEventId(lastEventId));
    eventSource.addEventListener("open", handleOpen);
    eventSource.addEventListener("error", handleConnectionError);
    for (const type of REALTIME_PROJECTION_EVENT_TYPES) eventSource.addEventListener(type, handleRealtimeEvent);
    eventSource.addEventListener("message", handleRealtimeEvent);
  }

  function close(): void {
    eventSource?.close();
    eventSource = null;
    subscribers.clear();
    sawConnectionError = false;
    lastStatus = null;
  }

  function handleOpen(): void {
    publishStatus(realtimeConnectionStatus(sawConnectionError ? "recovered" : "open"));
    sawConnectionError = false;
  }

  function handleConnectionError(): void {
    sawConnectionError = true;
    const closed = eventSource?.readyState === EventSource.CLOSED;
    publishStatus(realtimeConnectionStatus(closed ? "error" : "reconnecting"));
  }

  function handleRealtimeEvent(event: MessageEvent): void {
    const parsed = parseRealtimeProjectionTransportEvent(event);
    if (!parsed) return;
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

      const subscriberId = Symbol("realtime-event-source-subscriber");
      subscribers.set(subscriberId, { listener, onStatus: subscriptionOptions.onStatus });
      if (!eventSource) {
        open(subscriptionOptions.lastEventId?.trim() || null);
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

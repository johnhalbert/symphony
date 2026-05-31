import type { ServerResponse } from "node:http";
import type { WebProjectionSourceRevision } from "./WebProjectionContext.js";

export type RealtimeProjectionEventType =
  | "projection.updated"
  | "run.updated"
  | "transcript.delta"
  | "orchestrator.message"
  | "source.status";

export interface RealtimeProjectionResource {
  kind:
    | "dashboard"
    | "issue-board"
    | "issue-detail"
    | "history"
    | "sidebar"
    | "session-transcript"
    | "orchestrator-chat"
    | "source";
  href: string;
  relation: "refetch" | "template";
}

export interface RealtimeProjectionRecoveryHint {
  strategy: "refetch";
  reason: "event" | "missed-events";
  lastEventId: string | null;
  endpoints: readonly string[];
}

export interface RealtimeProjectionEvent {
  id: string;
  type: RealtimeProjectionEventType;
  revision: number;
  createdAt: string;
  source: WebProjectionSourceRevision;
  resources: readonly RealtimeProjectionResource[];
  recovery: RealtimeProjectionRecoveryHint;
  missedEvents: boolean;
  detail: Record<string, unknown> | null;
}

export interface RealtimeProjectionEventInput {
  type: RealtimeProjectionEventType;
  source: WebProjectionSourceRevision;
  resources?: readonly RealtimeProjectionResource[];
  recoveryReason?: RealtimeProjectionRecoveryHint["reason"];
  lastEventId?: string | null;
  missedEvents?: boolean;
  detail?: Record<string, unknown> | null;
}

export interface RealtimeProjectionEventBusOptions {
  clock?: () => Date;
  historyLimit?: number;
}

export interface RealtimeSseStreamOptions {
  response: ServerResponse;
  lastEventId?: string | null;
  keepAliveIntervalMs?: number;
}

export interface RealtimeSseStream {
  close(): void;
}

export const REALTIME_SSE_RETRY_MS = 5_000;
export const REALTIME_SSE_KEEPALIVE_MS = 15_000;
export const REALTIME_EVENT_HISTORY_LIMIT = 256;

export class RealtimeProjectionEventBus {
  private readonly subscribers = new Map<number, (event: RealtimeProjectionEvent) => void>();
  private readonly streamClosers = new Set<() => void>();
  private readonly history: RealtimeProjectionEvent[] = [];
  private readonly clock: () => Date;
  private readonly historyLimit: number;
  private nextSubscriberId = 0;
  private nextRevision = 0;

  constructor(options: RealtimeProjectionEventBusOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.historyLimit = Math.max(1, Math.trunc(options.historyLimit ?? REALTIME_EVENT_HISTORY_LIMIT));
  }

  subscriberCount(): number {
    return this.subscribers.size;
  }

  currentRevision(): number {
    return this.nextRevision;
  }

  closeAllStreams(): void {
    for (const close of [...this.streamClosers]) close();
  }

  publish(input: RealtimeProjectionEventInput): RealtimeProjectionEvent {
    const event = this.createEvent(input);
    this.history.push(event);
    while (this.history.length > this.historyLimit) this.history.shift();
    for (const listener of this.subscribers.values()) {
      try {
        listener(event);
      } catch {
        // A broken client stream must not prevent durable writes or other subscribers from receiving events.
      }
    }
    return event;
  }

  publishProjectionRevision(revision: WebProjectionSourceRevision): RealtimeProjectionEvent[] {
    return realtimeEventTypesForSourceRevision(revision).map((type) =>
      this.publish({
        type,
        source: revision,
        resources: realtimeResourcesForEventType(type),
      }),
    );
  }

  publishOrchestratorMessage(detail: Record<string, unknown> | null = null): RealtimeProjectionEvent[] {
    const source = this.realtimeSourceRevision("orchestrator-chat");
    return [
      this.publish({
        type: "orchestrator.message",
        source,
        resources: realtimeResourcesForEventType("orchestrator.message"),
        detail,
      }),
      this.publish({
        type: "projection.updated",
        source,
        resources: realtimeResourcesForEventType("projection.updated"),
        detail: { resourcesChanged: ["orchestrator-chat", "sidebar", "dashboard"] },
      }),
    ];
  }

  openSseStream(options: RealtimeSseStreamOptions): RealtimeSseStream {
    const response = options.response;
    let closed = false;
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    response.write(`retry: ${REALTIME_SSE_RETRY_MS}\n\n`);

    const writeEvent = (event: RealtimeProjectionEvent): void => {
      if (closed || response.destroyed || response.writableEnded) return;
      response.write(serializeSseEvent(event));
    };

    for (const event of this.replayEvents(options.lastEventId ?? null)) {
      writeEvent(event);
    }

    const unsubscribe = this.subscribe(writeEvent);
    const keepAliveIntervalMs = Math.max(1, Math.trunc(options.keepAliveIntervalMs ?? REALTIME_SSE_KEEPALIVE_MS));
    const keepAlive = setInterval(() => {
      if (closed || response.destroyed || response.writableEnded) return;
      response.write(serializeSseComment("keepalive"));
    }, keepAliveIntervalMs);
    keepAlive.unref?.();

    const close = (): void => {
      if (closed) return;
      closed = true;
      this.streamClosers.delete(close);
      clearInterval(keepAlive);
      unsubscribe();
      if (!response.destroyed && !response.writableEnded) response.end();
    };
    this.streamClosers.add(close);

    return { close };
  }

  private subscribe(listener: (event: RealtimeProjectionEvent) => void): () => void {
    const subscriberId = ++this.nextSubscriberId;
    this.subscribers.set(subscriberId, listener);
    return () => {
      this.subscribers.delete(subscriberId);
    };
  }

  private replayEvents(lastEventId: string | null): RealtimeProjectionEvent[] {
    const normalizedLastEventId = normalizeSseId(lastEventId);
    if (!normalizedLastEventId) return [];
    if (this.history.length === 0) return [this.createMissedEventsRecovery(normalizedLastEventId)];

    const knownIndex = this.history.findIndex((event) => event.id === normalizedLastEventId);
    if (knownIndex >= 0) return this.history.slice(knownIndex + 1);

    return [this.createMissedEventsRecovery(normalizedLastEventId)];
  }

  private createMissedEventsRecovery(lastEventId: string): RealtimeProjectionEvent {
    return this.createEvent({
      type: "projection.updated",
      source: this.realtimeSourceRevision("realtime-recovery"),
      resources: realtimeResourcesForEventType("projection.updated"),
      recoveryReason: "missed-events",
      lastEventId,
      missedEvents: true,
      detail: { lastEventId },
    });
  }

  private realtimeSourceRevision(source: string): WebProjectionSourceRevision {
    return {
      source,
      revision: this.nextRevision + 1,
      observedAt: this.clock().toISOString(),
    };
  }

  private createEvent(input: RealtimeProjectionEventInput): RealtimeProjectionEvent {
    const revision = ++this.nextRevision;
    const resources = input.resources ?? realtimeResourcesForEventType(input.type);
    return {
      id: String(revision),
      type: input.type,
      revision,
      createdAt: this.clock().toISOString(),
      source: normalizeRealtimeSourceRevision(input.source),
      resources,
      recovery: {
        strategy: "refetch",
        reason: input.recoveryReason ?? "event",
        lastEventId: normalizeSseId(input.lastEventId ?? null),
        endpoints: resources.map((resource) => resource.href),
      },
      missedEvents: input.missedEvents ?? false,
      detail: input.detail ?? null,
    };
  }
}

export function serializeSseEvent(event: RealtimeProjectionEvent): string {
  const id = sanitizeSseField(event.id);
  const type = sanitizeSseField(event.type);
  const data = JSON.stringify(event);
  return [`id: ${id}`, `event: ${type}`, ...data.split(/\r?\n/).map((line) => `data: ${line}`), "", ""].join("\n");
}

export function serializeSseComment(comment: string): string {
  return `: ${sanitizeSseField(comment)}\n\n`;
}

export function realtimeResourcesForEventType(type: RealtimeProjectionEventType): readonly RealtimeProjectionResource[] {
  switch (type) {
    case "run.updated":
      return [
        { kind: "history", href: "/api/v1/web/history", relation: "refetch" },
        { kind: "sidebar", href: "/api/v1/web/sidebar", relation: "refetch" },
        { kind: "dashboard", href: "/api/v1/web/dashboard", relation: "refetch" },
      ];
    case "transcript.delta":
      return [
        { kind: "history", href: "/api/v1/web/history", relation: "refetch" },
        { kind: "session-transcript", href: "/api/v1/web/sessions/{sessionId}/transcript", relation: "template" },
      ];
    case "orchestrator.message":
      return [
        { kind: "orchestrator-chat", href: "/api/v1/web/orchestrator-chat", relation: "refetch" },
        { kind: "sidebar", href: "/api/v1/web/sidebar", relation: "refetch" },
        { kind: "dashboard", href: "/api/v1/web/dashboard", relation: "refetch" },
      ];
    case "source.status":
      return [
        { kind: "source", href: "/api/v1/web/reference-data?refresh=1", relation: "refetch" },
        { kind: "issue-board", href: "/api/v1/web/issues?refresh=1", relation: "refetch" },
        { kind: "dashboard", href: "/api/v1/web/dashboard?refresh=1", relation: "refetch" },
      ];
    case "projection.updated":
    default:
      return [
        { kind: "dashboard", href: "/api/v1/web/dashboard", relation: "refetch" },
        { kind: "issue-board", href: "/api/v1/web/issues", relation: "refetch" },
        { kind: "sidebar", href: "/api/v1/web/sidebar", relation: "refetch" },
        { kind: "history", href: "/api/v1/web/history", relation: "refetch" },
      ];
  }
}

function realtimeEventTypesForSourceRevision(revision: WebProjectionSourceRevision): readonly RealtimeProjectionEventType[] {
  const source = revision.source.trim().toLowerCase();
  const types: RealtimeProjectionEventType[] = ["projection.updated", "source.status"];
  if (source === "runs" || source === "runstore" || source === "transcript") {
    types.push("run.updated", "transcript.delta");
  }
  if (source === "orchestrator-chat" || source === "chat") {
    types.push("orchestrator.message");
  }
  return types;
}

function normalizeRealtimeSourceRevision(revision: WebProjectionSourceRevision): WebProjectionSourceRevision {
  return {
    source: revision.source,
    revision: revision.revision,
    observedAt: revision.observedAt ?? null,
  };
}

function normalizeSseId(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? sanitizeSseField(normalized) : null;
}

function sanitizeSseField(value: string): string {
  return value.replace(/[\r\n]/g, " ");
}

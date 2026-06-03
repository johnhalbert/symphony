import type { ServerResponse } from "node:http";
import type { WebProjectionSourceRevision } from "./WebProjectionContext.js";

export const REALTIME_EVENT_SCHEMA = "symphony.realtime.v1" as const;
export const REALTIME_EVENT_SCHEMA_VERSION = 1 as const;

export const REALTIME_PROJECTION_EVENT_TYPES = [
  "projection.updated",
  "run.updated",
  "transcript.delta",
  "orchestrator.message",
  "source.status",
] as const;

export type RealtimeProjectionEventType = (typeof REALTIME_PROJECTION_EVENT_TYPES)[number];

export const REALTIME_RESOURCE_KINDS = [
  "dashboard",
  "issue-board",
  "issue-detail",
  "history",
  "sidebar",
  "session-transcript",
  "orchestrator-chat",
  "source",
] as const;

export type RealtimeResourceKind = (typeof REALTIME_RESOURCE_KINDS)[number];

export const REALTIME_EVENT_SCOPES = ["global", "source", "run", "session", "orchestrator"] as const;

export type RealtimeProjectionEventScope = (typeof REALTIME_EVENT_SCOPES)[number];

export type RealtimeProjectionEventDetail = Record<string, unknown>;

export interface RealtimeProjectionResource {
  kind: RealtimeResourceKind;
  href: string;
  relation: "refetch" | "template";
}

export interface RealtimeProjectionRecoveryHint {
  strategy: "refetch";
  reason: "event" | "missed-events";
  lastEventId: string | null;
  endpoints: readonly string[];
}

interface RealtimePayloadBase {
  source: string;
  sourceRevision: string | number;
  detail: RealtimeProjectionEventDetail | null;
}

export interface RealtimeProjectionUpdatedPayload extends RealtimePayloadBase {
  resourceKinds: readonly RealtimeResourceKind[];
  resourcesChanged: readonly RealtimeResourceKind[];
}

export interface RealtimeRunUpdatedPayload extends RealtimePayloadBase {
  runId: string | null;
  issueId: string | null;
  issueIdentifier: string | null;
  status: string | null;
}

export interface RealtimeTranscriptDeltaPayload extends RealtimePayloadBase {
  runId: string | null;
  sessionId: string | null;
  afterSequence: number | null;
  eventCount: number | null;
}

export interface RealtimeOrchestratorMessagePayload extends RealtimePayloadBase {
  conversationId: string | null;
  messageCount: number | null;
  inputLength: number | null;
  status: number | null;
}

export interface RealtimeSourceStatusPayload extends RealtimePayloadBase {
  status: string | null;
  fetchedStates: readonly string[];
  fetchedAt: string | null;
  cached: boolean | null;
  error: { code: string; message: string } | null;
  issueCount: number | null;
}

export interface RealtimeProjectionEventPayloadByType {
  "projection.updated": RealtimeProjectionUpdatedPayload;
  "run.updated": RealtimeRunUpdatedPayload;
  "transcript.delta": RealtimeTranscriptDeltaPayload;
  "orchestrator.message": RealtimeOrchestratorMessagePayload;
  "source.status": RealtimeSourceStatusPayload;
}

export type RealtimeProjectionEventPayload = RealtimeProjectionEventPayloadByType[RealtimeProjectionEventType];

export interface RealtimeProjectionEvent<TType extends RealtimeProjectionEventType = RealtimeProjectionEventType> {
  schema: typeof REALTIME_EVENT_SCHEMA;
  schemaVersion: typeof REALTIME_EVENT_SCHEMA_VERSION;
  id: string;
  type: TType;
  revision: number;
  createdAt: string;
  scope: RealtimeProjectionEventScope;
  key: string | null;
  source: WebProjectionSourceRevision;
  resources: readonly RealtimeProjectionResource[];
  recovery: RealtimeProjectionRecoveryHint;
  missedEvents: boolean;
  payload: RealtimeProjectionEventPayloadByType[TType];
  /** @deprecated Use the typed payload field. Kept for current web invalidation/detail consumers. */
  detail: RealtimeProjectionEventDetail | null;
}

export interface RealtimeProjectionEventInput<TType extends RealtimeProjectionEventType = RealtimeProjectionEventType> {
  type: TType;
  source: WebProjectionSourceRevision;
  resources?: readonly RealtimeProjectionResource[];
  recoveryReason?: RealtimeProjectionRecoveryHint["reason"];
  lastEventId?: string | null;
  missedEvents?: boolean;
  detail?: RealtimeProjectionEventDetail | null;
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

  publish<TType extends RealtimeProjectionEventType>(input: RealtimeProjectionEventInput<TType>): RealtimeProjectionEvent<TType> {
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
        detail: revision.detail ?? null,
      }),
    );
  }

  publishOrchestratorMessage(detail: RealtimeProjectionEventDetail | null = null): RealtimeProjectionEvent[] {
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

  private createEvent<TType extends RealtimeProjectionEventType>(input: RealtimeProjectionEventInput<TType>): RealtimeProjectionEvent<TType> {
    const revision = ++this.nextRevision;
    const resources = input.resources ?? realtimeResourcesForEventType(input.type);
    const source = normalizeRealtimeSourceRevision(input.source);
    const detail = normalizeRealtimeDetail(input.detail ?? null);
    const scope = realtimeScopeForEvent(input.type, source, detail);
    return {
      schema: REALTIME_EVENT_SCHEMA,
      schemaVersion: REALTIME_EVENT_SCHEMA_VERSION,
      id: String(revision),
      type: input.type,
      revision,
      createdAt: this.clock().toISOString(),
      scope: scope.scope,
      key: scope.key,
      source,
      resources,
      recovery: {
        strategy: "refetch",
        reason: input.recoveryReason ?? "event",
        lastEventId: normalizeSseId(input.lastEventId ?? null),
        endpoints: resources.map((resource) => resource.href),
      },
      missedEvents: input.missedEvents ?? false,
      payload: realtimePayloadForEvent(input.type, source, resources, detail),
      detail,
    };
  }
}

export function serializeRealtimeEventData(event: RealtimeProjectionEvent): string {
  return JSON.stringify({
    schema: event.schema,
    schemaVersion: event.schemaVersion,
    id: event.id,
    type: event.type,
    revision: event.revision,
    createdAt: event.createdAt,
    scope: event.scope,
    key: event.key,
    source: event.source,
    resources: event.resources,
    recovery: event.recovery,
    missedEvents: event.missedEvents,
    payload: event.payload,
    detail: event.detail,
  });
}

export function serializeSseEvent(event: RealtimeProjectionEvent): string {
  const id = sanitizeSseField(event.id);
  const type = sanitizeSseField(event.type);
  const data = serializeRealtimeEventData(event);
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

function realtimePayloadForEvent<TType extends RealtimeProjectionEventType>(
  type: TType,
  source: WebProjectionSourceRevision,
  resources: readonly RealtimeProjectionResource[],
  detail: RealtimeProjectionEventDetail | null,
): RealtimeProjectionEventPayloadByType[TType] {
  const base = realtimePayloadBase(source, detail);
  switch (type) {
    case "projection.updated": {
      const resourceKinds = realtimeResourceKinds(resources);
      return {
        ...base,
        resourceKinds,
        resourcesChanged: readResourceKinds(detail, "resourcesChanged") ?? resourceKinds,
      } as RealtimeProjectionEventPayloadByType[TType];
    }
    case "run.updated":
      return {
        ...base,
        runId: readStringDetail(detail, "runId") ?? readStringDetail(detail, "id"),
        issueId: readStringDetail(detail, "issueId"),
        issueIdentifier: readStringDetail(detail, "issueIdentifier"),
        status: readStringDetail(detail, "status"),
      } as RealtimeProjectionEventPayloadByType[TType];
    case "transcript.delta":
      return {
        ...base,
        runId: readStringDetail(detail, "runId"),
        sessionId: readStringDetail(detail, "sessionId"),
        afterSequence: readNumberDetail(detail, "afterSequence"),
        eventCount: readNumberDetail(detail, "eventCount"),
      } as RealtimeProjectionEventPayloadByType[TType];
    case "orchestrator.message":
      return {
        ...base,
        conversationId: readStringDetail(detail, "conversationId"),
        messageCount: readNumberDetail(detail, "messageCount"),
        inputLength: readNumberDetail(detail, "inputLength"),
        status: readNumberDetail(detail, "status"),
      } as RealtimeProjectionEventPayloadByType[TType];
    case "source.status":
      return {
        ...base,
        status: readStringDetail(detail, "status"),
        fetchedStates: readStringArrayDetail(detail, "fetchedStates"),
        fetchedAt: readStringDetail(detail, "fetchedAt"),
        cached: readBooleanDetail(detail, "cached"),
        error: readErrorDetail(detail, "error"),
        issueCount: readNumberDetail(detail, "issueCount"),
      } as RealtimeProjectionEventPayloadByType[TType];
  }
}

function realtimePayloadBase(
  source: WebProjectionSourceRevision,
  detail: RealtimeProjectionEventDetail | null,
): RealtimePayloadBase {
  return { source: source.source, sourceRevision: source.revision, detail };
}

function realtimeScopeForEvent(
  type: RealtimeProjectionEventType,
  source: WebProjectionSourceRevision,
  detail: RealtimeProjectionEventDetail | null,
): { scope: RealtimeProjectionEventScope; key: string | null } {
  switch (type) {
    case "run.updated":
      return { scope: "run", key: readStringDetail(detail, "runId") ?? readStringDetail(detail, "id") };
    case "transcript.delta":
      return { scope: "session", key: readStringDetail(detail, "sessionId") ?? readStringDetail(detail, "runId") };
    case "orchestrator.message":
      return { scope: "orchestrator", key: readStringDetail(detail, "conversationId") };
    case "source.status":
      return { scope: "source", key: readStringDetail(detail, "source") ?? source.source };
    case "projection.updated":
    default:
      return { scope: "global", key: null };
  }
}

function realtimeResourceKinds(resources: readonly RealtimeProjectionResource[]): readonly RealtimeResourceKind[] {
  return [...new Set(resources.map((resource) => resource.kind))];
}

function readResourceKinds(detail: RealtimeProjectionEventDetail | null, key: string): readonly RealtimeResourceKind[] | null {
  const value = detail?.[key];
  if (!Array.isArray(value)) return null;
  const kinds = value.filter((item): item is RealtimeResourceKind => typeof item === "string" && isRealtimeResourceKind(item));
  return kinds.length > 0 ? [...new Set(kinds)] : null;
}

function readStringDetail(detail: RealtimeProjectionEventDetail | null, key: string): string | null {
  const value = detail?.[key];
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function readStringArrayDetail(detail: RealtimeProjectionEventDetail | null, key: string): readonly string[] {
  const value = detail?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function readNumberDetail(detail: RealtimeProjectionEventDetail | null, key: string): number | null {
  const value = detail?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBooleanDetail(detail: RealtimeProjectionEventDetail | null, key: string): boolean | null {
  const value = detail?.[key];
  return typeof value === "boolean" ? value : null;
}

function readErrorDetail(detail: RealtimeProjectionEventDetail | null, key: string): { code: string; message: string } | null {
  const value = detail?.[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as { code?: unknown; message?: unknown };
  return typeof candidate.code === "string" && typeof candidate.message === "string"
    ? { code: candidate.code, message: candidate.message }
    : null;
}

function realtimeEventTypesForSourceRevision(revision: WebProjectionSourceRevision): readonly RealtimeProjectionEventType[] {
  const source = revision.source.trim().toLowerCase();
  const types: RealtimeProjectionEventType[] = ["projection.updated", "source.status"];
  if (source === "runs" || source === "runstore" || source === "transcript" || source === "run_activity" || source === "run-activity") {
    types.push("run.updated", "transcript.delta");
  }
  if (isOrchestratorChatRealtimeSource(source)) {
    types.push("orchestrator.message");
  }
  return types;
}

function isOrchestratorChatRealtimeSource(source: string): boolean {
  return (
    source === "orchestrator-chat" ||
    source === "chat" ||
    source === "orchestrator_conversations" ||
    source.startsWith("orchestrator_conversations:") ||
    source.startsWith("orchestrator_chat:")
  );
}

function normalizeRealtimeSourceRevision(revision: WebProjectionSourceRevision): WebProjectionSourceRevision {
  return {
    source: revision.source,
    revision: revision.revision,
    observedAt: revision.observedAt ?? null,
  };
}

function normalizeRealtimeDetail(detail: RealtimeProjectionEventDetail | null): RealtimeProjectionEventDetail | null {
  return detail && typeof detail === "object" && !Array.isArray(detail) ? detail : null;
}

function normalizeSseId(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? sanitizeSseField(normalized) : null;
}

function sanitizeSseField(value: string): string {
  return value.replace(/[\r\n]/g, " ");
}

function isRealtimeResourceKind(kind: string): kind is RealtimeResourceKind {
  return REALTIME_RESOURCE_KINDS.some((candidate) => candidate === kind);
}

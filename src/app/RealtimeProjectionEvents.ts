import type { ServerResponse } from "node:http";
import {
  projectWebTranscript,
  projectWebTranscriptProjectContext,
  type TranscriptMessage,
} from "./WebTranscriptProjection.js";
import { projectWebOrchestratorChat, type ChatMessage } from "./webProjection.js";
import { sanitizePublicJson } from "./WebTranscriptProjectionCore.js";
import type { WebProjectionSourceRevision } from "./WebProjectionContext.js";
import type { TranscriptEvent } from "../core/persistence/RunTranscriptStore.js";

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

export type RealtimeProjectContextMetadata = Readonly<Record<string, unknown>>;

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

const MISSED_EVENTS_RECOVERY_RESOURCES: readonly RealtimeProjectionResource[] = [
  { kind: "source", href: "/api/v1/web/reference-data?refresh=1", relation: "refetch" },
  { kind: "dashboard", href: "/api/v1/web/dashboard", relation: "refetch" },
  { kind: "issue-board", href: "/api/v1/web/issues", relation: "refetch" },
  { kind: "sidebar", href: "/api/v1/web/sidebar", relation: "refetch" },
  { kind: "history", href: "/api/v1/web/history", relation: "refetch" },
  { kind: "orchestrator-chat", href: "/api/v1/web/orchestrator-chat", relation: "refetch" },
];

const MISSED_EVENTS_RECOVERY_RESOURCE_KINDS = [...REALTIME_RESOURCE_KINDS] satisfies readonly RealtimeResourceKind[];

interface RealtimePayloadBase {
  source: string;
  sourceRevision: string | number;
  detail: RealtimeProjectionEventDetail | null;
  projectContext: RealtimeProjectContextMetadata | null;
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

export interface RealtimeTranscriptPatchMessage {
  sequence: number;
  message: TranscriptMessage | null;
  operation?: "append" | "merge-assistant-delta" | "replace-assistant";
  joinMode?: "spaced" | "exact" | "token";
}

export interface RealtimeTranscriptDeltaPayload extends RealtimePayloadBase {
  runId: string | null;
  sessionId: string | null;
  afterSequence: number | null;
  eventCount: number | null;
  messages?: readonly RealtimeTranscriptPatchMessage[];
}

export interface RealtimeOrchestratorMessagePayload extends RealtimePayloadBase {
  conversationId: string | null;
  messageCount: number | null;
  inputLength: number | null;
  status: number | null;
  operation?: "append" | "update";
  message?: ChatMessage | null;
  messages?: readonly ChatMessage[];
  lastMessageId: string | null;
  lastMessageStatus: string | null;
  lastMessageAt: string | null;
  state: string | null;
  conversationStatus: string | null;
  active: boolean | null;
  terminal: boolean | null;
  empty: boolean | null;
  latestMessageSequence: number | null;
  latestMessageUpdatedAt: string | null;
  conversation: Readonly<Record<string, unknown>> | null;
  statusSummary: Readonly<Record<string, unknown>> | null;
  statusCounts: Readonly<Record<string, unknown>> | null;
  sourceSummary: Readonly<Record<string, unknown>> | null;
  chat: readonly Readonly<Record<string, unknown>>[] | null;
}

export interface RealtimeSourceStatusPayload extends RealtimePayloadBase {
  status: string | null;
  fetchedStates: readonly string[];
  fetchedAt: string | null;
  cached: boolean | null;
  error: { code: string; message: string } | null;
  issueCount: number | null;
  sourceRevisions: readonly Readonly<Record<string, unknown>>[];
  sourceCursors: Readonly<Record<string, unknown>> | null;
  sourceFreshness: readonly Readonly<Record<string, unknown>>[];
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

interface RealtimePayloadOptions {
  transcriptPatchStateByRunId?: Map<string, RealtimeTranscriptPatchProjectionState>;
  payloadDetail?: RealtimeProjectionEventDetail | null;
}

type AssistantDeltaMirrorSource = "runtime" | "harness";

type AssistantDeltaMirrorCounts = Record<AssistantDeltaMirrorSource, Map<string, number>>;

interface RealtimeTranscriptPatchProjectionState {
  seenAssistantDeltaReplayKeys: Set<string>;
  seenAssistantDeltaReplayKeyOrder: string[];
  assistantDeltaMirrorCounts: AssistantDeltaMirrorCounts;
  pendingAssistantDelta: boolean;
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
const REALTIME_TRANSCRIPT_PATCH_REPLAY_KEY_LIMIT = 4_096;
const REALTIME_TRANSCRIPT_PATCH_MIRROR_KEY_LIMIT = 4_096;

export class RealtimeProjectionEventBus {
  private readonly subscribers = new Map<number, (event: RealtimeProjectionEvent) => void>();
  private readonly streamClosers = new Set<() => void>();
  private readonly history: RealtimeProjectionEvent[] = [];
  private readonly transcriptPatchStateByRunId = new Map<string, RealtimeTranscriptPatchProjectionState>();
  private readonly recoveryCursors = new Map<string, number>();
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
    this.pruneRecoveryCursors();
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

    const knownIndex = this.history.findIndex((event) => event.id === normalizedLastEventId);
    if (knownIndex >= 0) return this.history.slice(knownIndex + 1);

    const recoveryCursorRevision = this.recoveryCursors.get(normalizedLastEventId);
    if (recoveryCursorRevision !== undefined) {
      const replay = this.replayAfterKnownRevision(recoveryCursorRevision);
      if (replay) return replay;
      this.recoveryCursors.delete(normalizedLastEventId);
    }

    return [this.createMissedEventsRecovery(normalizedLastEventId)];
  }

  private replayAfterKnownRevision(revision: number): RealtimeProjectionEvent[] | null {
    if (this.history.length === 0) return [];
    const earliestReplayableRevision = this.history[0]?.revision;
    if (earliestReplayableRevision === undefined || revision < earliestReplayableRevision - 1) return null;
    return this.history.filter((event) => event.revision > revision);
  }

  private createMissedEventsRecovery(lastEventId: string): RealtimeProjectionEvent {
    const event = this.createEvent({
      type: "projection.updated",
      source: this.realtimeSourceRevision("realtime-recovery"),
      resources: MISSED_EVENTS_RECOVERY_RESOURCES,
      recoveryReason: "missed-events",
      lastEventId,
      missedEvents: true,
      detail: {
        lastEventId,
        resourcesChanged: MISSED_EVENTS_RECOVERY_RESOURCE_KINDS,
      },
    });
    this.rememberRecoveryCursor(event);
    return event;
  }

  private rememberRecoveryCursor(event: RealtimeProjectionEvent): void {
    this.recoveryCursors.set(event.id, event.revision);
    this.pruneRecoveryCursors();
  }

  private pruneRecoveryCursors(): void {
    const earliestReplayableRevision = this.history[0]?.revision;
    for (const [cursor, revision] of this.recoveryCursors) {
      if (earliestReplayableRevision !== undefined && revision < earliestReplayableRevision - 1) {
        this.recoveryCursors.delete(cursor);
      }
    }
    while (this.recoveryCursors.size > this.historyLimit) {
      const oldestCursor = this.recoveryCursors.keys().next().value;
      if (oldestCursor === undefined) return;
      this.recoveryCursors.delete(oldestCursor);
    }
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
    const publicDetail = publicRealtimeDetailForEvent(input.type, detail);
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
      payload: realtimePayloadForEvent(input.type, source, resources, detail, {
        transcriptPatchStateByRunId: this.transcriptPatchStateByRunId,
        payloadDetail: publicDetail,
      }),
      detail: publicDetail,
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
  options: RealtimePayloadOptions = {},
): RealtimeProjectionEventPayloadByType[TType] {
  const publicDetail = options.payloadDetail ?? detail;
  const base = realtimePayloadBase(source, publicDetail);
  switch (type) {
    case "projection.updated": {
      const resourceKinds = realtimeResourceKinds(resources);
      return {
        ...base,
        resourceKinds,
        resourcesChanged: readResourceKinds(publicDetail, "resourcesChanged") ?? resourceKinds,
      } as RealtimeProjectionEventPayloadByType[TType];
    }
    case "run.updated":
      return {
        ...base,
        runId: readStringDetail(publicDetail, "runId") ?? readStringDetail(publicDetail, "id"),
        issueId: readStringDetail(publicDetail, "issueId"),
        issueIdentifier: readStringDetail(publicDetail, "issueIdentifier"),
        status: readStringDetail(publicDetail, "status"),
      } as RealtimeProjectionEventPayloadByType[TType];
    case "transcript.delta": {
      const messages = readTranscriptPatchMessages(publicDetail, options);
      return {
        ...base,
        runId: readStringDetail(publicDetail, "runId"),
        sessionId: readStringDetail(publicDetail, "sessionId"),
        afterSequence: readNumberDetail(publicDetail, "afterSequence"),
        eventCount: readNumberDetail(publicDetail, "eventCount"),
        ...(messages ? { messages } : {}),
      } as RealtimeProjectionEventPayloadByType[TType];
    }
    case "orchestrator.message": {
      const messages = readChatPatchMessages(detail);
      const statusSummary = readRecordDetail(detail, "statusSummary");
      return {
        ...base,
        conversationId: readStringDetail(detail, "conversationId"),
        messageCount: readNumberDetail(detail, "messageCount"),
        inputLength: readNumberDetail(detail, "inputLength"),
        status: readNumberDetail(detail, "status"),
        ...orchestratorMessageOperationDetail(detail),
        ...(messages ? { messages, message: messages.at(-1) ?? null } : {}),
        lastMessageId: readStringDetail(detail, "lastMessageId"),
        lastMessageStatus: readStringDetail(detail, "lastMessageStatus"),
        lastMessageAt: readStringDetail(detail, "lastMessageAt"),
        state: readStringDetail(detail, "state"),
        conversationStatus: readStringDetail(detail, "conversationStatus"),
        active: readBooleanDetail(detail, "active"),
        terminal: readBooleanDetail(detail, "terminal"),
        empty: readBooleanDetail(detail, "empty"),
        latestMessageSequence: readNumberDetail(detail, "latestMessageSequence"),
        latestMessageUpdatedAt: readStringDetail(detail, "latestMessageUpdatedAt"),
        conversation: readRecordDetail(detail, "conversation"),
        statusSummary,
        statusCounts: readRecordDetail(detail, "statusCounts") ?? readRecordField(statusSummary, "statusCounts"),
        sourceSummary: readRecordDetail(detail, "sourceSummary"),
        chat: readNullableRecordArrayDetail(detail, "chat"),
      } as RealtimeProjectionEventPayloadByType[TType];
    }
    case "source.status": {
      const primaryFreshness = primarySourceFreshness(publicDetail);
      return {
        ...base,
        status: readStringDetail(publicDetail, "status") ?? readStringRecordField(primaryFreshness, "status"),
        fetchedStates: readStringArrayDetail(publicDetail, "fetchedStates"),
        fetchedAt:
          readStringDetail(publicDetail, "fetchedAt") ??
          readStringDetail(publicDetail, "checkedAt") ??
          readStringRecordField(primaryFreshness, "checkedAt"),
        cached: readBooleanDetail(publicDetail, "cached"),
        error: readErrorDetail(publicDetail, "error"),
        issueCount: readNumberDetail(publicDetail, "issueCount"),
        sourceRevisions: readRecordArrayDetail(publicDetail, "sourceRevisions"),
        sourceCursors: readRecordDetail(publicDetail, "sourceCursors"),
        sourceFreshness: readRecordArrayDetail(publicDetail, "sourceFreshness"),
      } as RealtimeProjectionEventPayloadByType[TType];
    }
  }
}

function realtimePayloadBase(
  source: WebProjectionSourceRevision,
  detail: RealtimeProjectionEventDetail | null,
): RealtimePayloadBase {
  return {
    source: source.source,
    sourceRevision: source.revision,
    detail,
    projectContext: realtimeProjectContextDetail(detail),
  };
}

function realtimeProjectContextDetail(detail: RealtimeProjectionEventDetail | null): RealtimeProjectContextMetadata | null {
  const directProjectContext = readRecordDetail(detail, "projectContext");
  const sourceCursors = readRecordDetail(detail, "sourceCursors");
  const projectContext =
    directProjectContext ??
    readRecordField(sourceCursors, "projectContext") ??
    realtimeProjectContextMetadataDetail(detail);
  if (!projectContext) return null;
  const sanitized = sanitizePublicJson(projectContext);
  return isRecord(sanitized) ? sanitized : null;
}

function realtimeProjectContextMetadataDetail(
  detail: RealtimeProjectionEventDetail | null,
): RealtimeProjectContextMetadata | null {
  if (!detail) return null;
  const projectContextId = readStringDetail(detail, "projectContextId");
  const projectContextLabel = readStringDetail(detail, "projectContextLabel");
  const linearProjectSlug = readStringDetail(detail, "linearProjectSlug");
  const routingSource = readStringDetail(detail, "routingSource");
  if (!projectContextId && !projectContextLabel && !linearProjectSlug && !routingSource) return null;
  return {
    ...(projectContextId ? { projectContextId } : {}),
    ...(projectContextLabel ? { projectContextLabel } : {}),
    ...(linearProjectSlug ? { linearProjectSlug } : {}),
    ...(routingSource ? { routingSource } : {}),
  };
}

function publicRealtimeDetailForEvent(
  type: RealtimeProjectionEventType,
  detail: RealtimeProjectionEventDetail | null,
): RealtimeProjectionEventDetail | null {
  if (!detail) return null;
  switch (type) {
    case "orchestrator.message":
      return sanitizeRealtimeDetailProjectContext(
        omitRealtimeDetailKeys(detail, [
          "chat",
          "conversation",
          "statusSummary",
          "statusCounts",
          "sourceSummary",
          "message",
          "messages",
        ]),
      );
    case "projection.updated":
    case "run.updated":
    case "transcript.delta":
    case "source.status":
    default:
      return sanitizeRealtimeDetailProjectContext(detail);
  }
}

function sanitizeRealtimeDetailProjectContext(detail: RealtimeProjectionEventDetail): RealtimeProjectionEventDetail {
  let next: RealtimeProjectionEventDetail | null = null;

  if (Object.prototype.hasOwnProperty.call(detail, "projectContext")) {
    next = { ...(next ?? detail), projectContext: sanitizePublicJson(detail.projectContext) };
  }

  const sourceCursors = readRecordDetail(detail, "sourceCursors");
  if (sourceCursors && Object.prototype.hasOwnProperty.call(sourceCursors, "projectContext")) {
    next = {
      ...(next ?? detail),
      sourceCursors: {
        ...sourceCursors,
        projectContext: sanitizePublicJson(sourceCursors.projectContext),
      },
    };
  }

  return next ?? detail;
}

function omitRealtimeDetailKeys(
  detail: RealtimeProjectionEventDetail,
  keys: readonly string[],
): RealtimeProjectionEventDetail {
  const omitted = new Set(keys);
  const next: RealtimeProjectionEventDetail = {};
  for (const [key, value] of Object.entries(detail)) {
    if (!omitted.has(key)) next[key] = value;
  }
  return next;
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

function orchestratorMessageOperationDetail(
  detail: RealtimeProjectionEventDetail | null,
): Pick<RealtimeOrchestratorMessagePayload, "operation"> {
  const operation = readStringDetail(detail, "operation");
  return operation === "append" || operation === "update" ? { operation } : {};
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

function readTranscriptPatchMessages(
  detail: RealtimeProjectionEventDetail | null,
  options: RealtimePayloadOptions = {},
): readonly RealtimeTranscriptPatchMessage[] | null {
  const explicit = readTranscriptPatchMessagesDetail(detail, "messages");
  if (explicit) return explicit;
  const events = readTranscriptEventsDetail(detail, "events");
  if (events.length === 0) return null;
  const projectContext = projectWebTranscriptProjectContext(readRecordField(readRecordDetail(detail, "sourceCursors"), "projectContext"));
  return projectRealtimeTranscriptPatchMessages(
    events,
    readNumberDetail(detail, "afterSequence"),
    options.transcriptPatchStateByRunId,
    projectContext,
  );
}

function projectRealtimeTranscriptPatchMessages(
  events: readonly TranscriptEvent[],
  afterSequence: number | null,
  stateByRunId: Map<string, RealtimeTranscriptPatchProjectionState> | undefined,
  projectContext: ReturnType<typeof projectWebTranscriptProjectContext> = null,
): readonly RealtimeTranscriptPatchMessage[] | null {
  const runId = events[0]?.runId;
  if (!runId) return null;

  let state = stateByRunId?.get(runId) ?? createRealtimeTranscriptPatchProjectionState();
  let stateKnown = stateByRunId?.has(runId) ?? false;
  if (afterSequence === 0 || events.some((event) => event.sequence === 1)) stateKnown = true;

  const patches: RealtimeTranscriptPatchMessage[] = [];
  for (const event of events) {
    if (event.runId !== runId) return null;
    const message = projectWebTranscript([event], { includeRunPrelude: false, projectContext })[0] ?? null;
    if (message === null) {
      patches.push({ sequence: event.sequence, message: null });
      continue;
    }

    if (message.kind === "assistant" && isAssistantDeltaPatchEvent(event)) {
      if (!stateKnown) return null;
      const replayKey = assistantDeltaPatchReplayKey(event, message.text);
      if (state.seenAssistantDeltaReplayKeys.has(replayKey)) {
        patches.push({ sequence: event.sequence, message: null });
        continue;
      }
      rememberAssistantDeltaPatchReplayKey(state, replayKey);
      const mirrorSource = assistantDeltaPatchMirrorSource(event);
      if (mirrorSource && consumeAssistantDeltaPatchMirror(mirrorSource, message.text, state.assistantDeltaMirrorCounts)) {
        patches.push({ sequence: event.sequence, message: null });
        continue;
      }
      patches.push({
        sequence: event.sequence,
        message,
        operation: state.pendingAssistantDelta ? "merge-assistant-delta" : "append",
        joinMode: assistantDeltaPatchJoinMode(event),
      });
      state.pendingAssistantDelta = true;
      continue;
    }

    if (message.kind === "assistant" && isAssistantCompletePatchEvent(event)) {
      if (!stateKnown) return null;
      patches.push({
        sequence: event.sequence,
        message,
        operation: state.pendingAssistantDelta ? "replace-assistant" : "append",
      });
      resetRealtimeTranscriptAssistantDeltaGroup(state);
      continue;
    }

    patches.push({ sequence: event.sequence, message });
    resetRealtimeTranscriptAssistantDeltaGroup(state);
    stateKnown = true;
  }

  if (stateByRunId && stateKnown) {
    if (events.some(isTerminalTranscriptPatchEvent)) {
      stateByRunId.delete(runId);
    } else {
      stateByRunId.set(runId, state);
    }
  }
  return patches;
}

function readTranscriptPatchMessagesDetail(
  detail: RealtimeProjectionEventDetail | null,
  key: string,
): readonly RealtimeTranscriptPatchMessage[] | null {
  const value = detail?.[key];
  if (!Array.isArray(value)) return null;
  const patches = value.map(readTranscriptPatchMessage).filter((patch): patch is RealtimeTranscriptPatchMessage => patch !== null);
  return patches.length === value.length ? patches : null;
}

function readTranscriptPatchMessage(value: unknown): RealtimeTranscriptPatchMessage | null {
  if (!isRecordValue(value)) return null;
  const sequence = value.sequence;
  if (typeof sequence !== "number" || !Number.isFinite(sequence)) return null;
  const message = value.message;
  if (message !== null && !isRecordValue(message)) return null;
  const operation = transcriptPatchOperation(value.operation);
  const joinMode = transcriptPatchJoinMode(value.joinMode);
  return {
    sequence,
    message: message as TranscriptMessage | null,
    ...(operation ? { operation } : {}),
    ...(joinMode ? { joinMode } : {}),
  };
}

function createRealtimeTranscriptPatchProjectionState(): RealtimeTranscriptPatchProjectionState {
  return {
    seenAssistantDeltaReplayKeys: new Set<string>(),
    seenAssistantDeltaReplayKeyOrder: [],
    assistantDeltaMirrorCounts: createAssistantDeltaPatchMirrorCounts(),
    pendingAssistantDelta: false,
  };
}

function createAssistantDeltaPatchMirrorCounts(): AssistantDeltaMirrorCounts {
  return { runtime: new Map<string, number>(), harness: new Map<string, number>() };
}

function resetRealtimeTranscriptAssistantDeltaGroup(state: RealtimeTranscriptPatchProjectionState): void {
  state.pendingAssistantDelta = false;
  state.assistantDeltaMirrorCounts.runtime.clear();
  state.assistantDeltaMirrorCounts.harness.clear();
}

function rememberAssistantDeltaPatchReplayKey(
  state: RealtimeTranscriptPatchProjectionState,
  replayKey: string,
): void {
  state.seenAssistantDeltaReplayKeys.add(replayKey);
  state.seenAssistantDeltaReplayKeyOrder.push(replayKey);
  while (state.seenAssistantDeltaReplayKeyOrder.length > REALTIME_TRANSCRIPT_PATCH_REPLAY_KEY_LIMIT) {
    const evicted = state.seenAssistantDeltaReplayKeyOrder.shift();
    if (evicted !== undefined) state.seenAssistantDeltaReplayKeys.delete(evicted);
  }
}

function assistantDeltaPatchReplayKey(event: TranscriptEvent, _text: string): string {
  return `${event.runId}:${event.sequence}:${event.source}:${normalizeToken(event.eventType)}`;
}

function assistantDeltaPatchMirrorSource(event: TranscriptEvent): AssistantDeltaMirrorSource | null {
  const eventType = normalizeToken(event.eventType);
  const payload = transcriptEventPayloadRecord(event);
  if (event.source === "runtime" && eventType === "message_delta") return "runtime";
  if (event.source === "harness" && eventType === "progress" && normalizedOptionalToken(payload.activitySource) === "delta") return "harness";
  return null;
}

function consumeAssistantDeltaPatchMirror(
  source: AssistantDeltaMirrorSource,
  text: string,
  counts: AssistantDeltaMirrorCounts,
): boolean {
  const textKey = assistantDeltaPatchMirrorKey(text);
  const opposite = source === "runtime" ? "harness" : "runtime";
  const sourceCount = counts[source].get(textKey) ?? 0;
  const oppositeCount = counts[opposite].get(textKey) ?? 0;
  const nextSourceCount = sourceCount + 1;
  rememberAssistantDeltaPatchMirrorCount(counts[source], textKey, nextSourceCount);
  const mirrored = oppositeCount > sourceCount;
  if (mirrored && oppositeCount === nextSourceCount) {
    counts[source].delete(textKey);
    counts[opposite].delete(textKey);
  }
  return mirrored;
}

function rememberAssistantDeltaPatchMirrorCount(counts: Map<string, number>, textKey: string, count: number): void {
  counts.set(textKey, count);
  while (counts.size > REALTIME_TRANSCRIPT_PATCH_MIRROR_KEY_LIMIT) {
    const oldest = counts.keys().next().value;
    if (oldest === undefined) return;
    counts.delete(oldest);
  }
}

function assistantDeltaPatchMirrorKey(text: string): string {
  return `${text.length}:${hashString(text)}`;
}

function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function transcriptPatchOperation(value: unknown): RealtimeTranscriptPatchMessage["operation"] | null {
  return value === "append" || value === "merge-assistant-delta" || value === "replace-assistant" ? value : null;
}

function transcriptPatchJoinMode(value: unknown): RealtimeTranscriptPatchMessage["joinMode"] | null {
  return value === "spaced" || value === "exact" || value === "token" ? value : null;
}

function isAssistantDeltaPatchEvent(event: TranscriptEvent): boolean {
  const eventType = normalizeToken(event.eventType);
  const payload = transcriptEventPayloadRecord(event);
  const payloadKind = normalizedPayloadKind(payload);
  return (
    eventType === "message_delta" ||
    eventType === "assistant_delta" ||
    eventType === "assistant_message_delta" ||
    eventType === "response_delta" ||
    payloadKind === "assistant_delta" ||
    payloadKind === "assistant_message_delta" ||
    payloadKind === "response_delta" ||
    (payloadKind === "progress" && normalizedOptionalToken(payload.actor) === "assistant" && payload.delta === true)
  );
}

function isAssistantCompletePatchEvent(event: TranscriptEvent): boolean {
  const eventType = normalizeToken(event.eventType);
  return (
    eventType === "message_complete" ||
    eventType === "assistant_complete" ||
    eventType === "assistant_message_completed" ||
    eventType === "response_complete" ||
    eventType === "completed"
  );
}

function isTerminalTranscriptPatchEvent(event: TranscriptEvent): boolean {
  const eventType = normalizeToken(event.eventType);
  return eventType === "completed" || eventType === "failed" || eventType === "cancelled";
}

function assistantDeltaPatchJoinMode(event: TranscriptEvent): NonNullable<RealtimeTranscriptPatchMessage["joinMode"]> {
  const eventType = normalizeToken(event.eventType);
  const payload = transcriptEventPayloadRecord(event);
  if (eventType === "assistant_message_delta") return "exact";
  if (eventType === "progress" && normalizedOptionalToken(payload.activitySource) === "delta") return "exact";
  if (eventType === "message_delta" && isHermesRuntimeMessageDelta(event, payload)) return "exact";
  if (eventType === "message_delta") return "token";
  return "spaced";
}

function isHermesRuntimeMessageDelta(event: TranscriptEvent, payload: Record<string, unknown>): boolean {
  return event.source === "runtime" && (typeof payload.harnessId === "string" || (typeof event.message === "string" && normalizeToken(event.message) === "hermes_message_delta"));
}

function normalizedPayloadKind(payload: Record<string, unknown>): string | null {
  const kind = firstStringValue(payload.kind, payload.type);
  return kind ? normalizeToken(kind) : null;
}

function normalizedOptionalToken(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? normalizeToken(value) : null;
}

function firstStringValue(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

function transcriptEventPayloadRecord(event: TranscriptEvent): Record<string, unknown> {
  return isRecordValue(event.payload) ? event.payload : {};
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "status";
}

function readTranscriptEventsDetail(detail: RealtimeProjectionEventDetail | null, key: string): readonly TranscriptEvent[] {
  const value = detail?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter(isTranscriptEventLike);
}

function isTranscriptEventLike(value: unknown): value is TranscriptEvent {
  return (
    isRecordValue(value) &&
    typeof value.runId === "string" &&
    typeof value.sequence === "number" &&
    Number.isFinite(value.sequence) &&
    typeof value.at === "string" &&
    typeof value.source === "string" &&
    typeof value.eventType === "string"
  );
}

function readChatPatchMessages(detail: RealtimeProjectionEventDetail | null): readonly ChatMessage[] | null {
  const rawMessages = detail?.messages;
  const values = Array.isArray(rawMessages) ? rawMessages : detail && "message" in detail ? [detail.message] : [];
  if (values.length === 0) return null;
  const messages = values.map(readChatPatchMessage).filter((message): message is ChatMessage => message !== null);
  return messages.length === values.length ? messages : null;
}

function readChatPatchMessage(value: unknown): ChatMessage | null {
  if (!isRecordValue(value)) return null;
  if (typeof value.text === "string" && (value.who === "agent" || value.who === "user")) {
    const message: ChatMessage = { who: value.who, text: value.text };
    const id = stringField(value, "id");
    const conversationId = stringField(value, "conversationId");
    const role = stringField(value, "role");
    const status = stringField(value, "status");
    const createdAt = stringField(value, "createdAt");
    const updatedAt = stringField(value, "updatedAt");
    if (id) message.id = id;
    if (conversationId) message.conversationId = conversationId;
    if (role) message.role = role as NonNullable<ChatMessage["role"]>;
    if (status) message.status = status as NonNullable<ChatMessage["status"]>;
    if (createdAt) message.createdAt = createdAt;
    if (updatedAt) message.updatedAt = updatedAt;
    if (isRecordValue(value.metadata)) message.metadata = value.metadata as Record<string, unknown>;
    if (Array.isArray(value.suggestions)) {
      const suggestions = value.suggestions.filter((suggestion): suggestion is string => typeof suggestion === "string");
      if (suggestions.length > 0) message.suggestions = suggestions;
    }
    return message;
  }
  if (typeof value.body === "string" && typeof value.role === "string") {
    return projectWebOrchestratorChat([value as never])[0] ?? null;
  }
  return null;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function readRecordDetail(detail: RealtimeProjectionEventDetail | null, key: string): Readonly<Record<string, unknown>> | null {
  const value = detail?.[key];
  return isRecord(value) ? value : null;
}

function readRecordArrayDetail(
  detail: RealtimeProjectionEventDetail | null,
  key: string,
): readonly Readonly<Record<string, unknown>>[] {
  const value = detail?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Readonly<Record<string, unknown>> => isRecord(item));
}

function readNullableRecordArrayDetail(
  detail: RealtimeProjectionEventDetail | null,
  key: string,
): readonly Readonly<Record<string, unknown>>[] | null {
  if (!detail || !(key in detail)) return null;
  const value = detail[key];
  if (!Array.isArray(value)) return null;
  return value.every(isRecord) ? value : null;
}

function readRecordField(record: Readonly<Record<string, unknown>> | null, key: string): Readonly<Record<string, unknown>> | null {
  const value = record?.[key];
  return isRecord(value) ? value : null;
}

function primarySourceFreshness(detail: RealtimeProjectionEventDetail | null): Readonly<Record<string, unknown>> | null {
  return readRecordArrayDetail(detail, "sourceFreshness")[0] ?? null;
}

function readStringRecordField(record: Readonly<Record<string, unknown>> | null, key: string): string | null {
  const value = record?.[key];
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function realtimeEventTypesForSourceRevision(revision: WebProjectionSourceRevision): readonly RealtimeProjectionEventType[] {
  const source = revision.source.trim().toLowerCase();
  const projectionName = readStringDetail(revision.detail ?? null, "projectionName")?.toLowerCase() ?? null;
  const types: RealtimeProjectionEventType[] = ["projection.updated", "source.status"];
  if (isRunMetadataRealtimeSource(source, projectionName)) {
    types.push("run.updated");
  }
  if (isTranscriptRealtimeSource(source, projectionName)) {
    types.push("run.updated", "transcript.delta");
  }
  if (
    isOrchestratorChatRealtimeSource(source, projectionName) &&
    (!isDurableOrchestratorChatProjectionSource(source, projectionName) ||
      realtimeDetailHasOrchestratorPatchPayload(revision.detail ?? null))
  ) {
    types.push("orchestrator.message");
  }
  return types;
}

function isRunMetadataRealtimeSource(source: string, projectionName: string | null): boolean {
  return source === "run_metadata" || projectionName === "run_metadata_projection";
}

function isTranscriptRealtimeSource(source: string, projectionName: string | null): boolean {
  return (
    source === "runs" ||
    source === "runstore" ||
    source === "transcript" ||
    source === "run_activity" ||
    source === "run-activity" ||
    projectionName === "transcript_projection" ||
    source.startsWith("transcript_projection:")
  );
}

function isOrchestratorChatRealtimeSource(source: string, projectionName: string | null = null): boolean {
  return (
    source === "orchestrator-chat" ||
    source === "chat" ||
    source === "orchestrator_conversations" ||
    source.startsWith("orchestrator_conversations:") ||
    source.startsWith("orchestrator_chat:") ||
    projectionName === "orchestrator_chat_projection" ||
    source.startsWith("orchestrator_chat_projection:")
  );
}

function isDurableOrchestratorChatProjectionSource(source: string, projectionName: string | null): boolean {
  return projectionName === "orchestrator_chat_projection" || source.startsWith("orchestrator_chat_projection:");
}

function realtimeDetailHasOrchestratorPatchPayload(detail: RealtimeProjectionEventDetail | null): boolean {
  return readChatPatchMessages(detail) !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

import type { ChatMessage, TranscriptMessage } from "../types/symphony";

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

export type RealtimeProjectionEventDetail = Record<string, unknown>;

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
  message?: ChatMessage | null;
  messages?: readonly ChatMessage[];
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
  source: {
    source: string;
    revision: string | number;
    observedAt: string | null;
  };
  resources: readonly RealtimeProjectionResource[];
  recovery: RealtimeProjectionRecoveryHint;
  missedEvents: boolean;
  payload: RealtimeProjectionEventPayloadByType[TType];
  /** @deprecated Use the typed payload field. Kept for current web invalidation/detail consumers. */
  detail: RealtimeProjectionEventDetail | null;
}

export type RealtimeConnectionStatusKind = "unavailable" | "connecting" | "open" | "reconnecting" | "recovered" | "stale" | "error";

export interface RealtimeConnectionStatus {
  kind: RealtimeConnectionStatusKind;
  label: string;
  lastEventId?: string | null;
  revision?: number;
  missedEvents?: boolean;
}

export type RealtimeConnectionStatusListener = (status: RealtimeConnectionStatus) => void;

export interface RealtimeSubscriptionOptions {
  lastEventId?: string | null;
  onStatus?: RealtimeConnectionStatusListener;
}

export type RealtimeEventListener = (event: RealtimeProjectionEvent) => void;
export type RealtimeEventUnsubscribe = () => void;

export function realtimeConnectionStatus(
  kind: RealtimeConnectionStatusKind,
  details: Omit<Partial<RealtimeConnectionStatus>, "kind" | "label"> = {},
): RealtimeConnectionStatus {
  return { kind, label: REALTIME_CONNECTION_STATUS_LABELS[kind], ...details };
}

const REALTIME_CONNECTION_STATUS_LABELS: Record<RealtimeConnectionStatusKind, string> = {
  unavailable: "realtime unavailable",
  connecting: "realtime connecting",
  open: "realtime connected",
  reconnecting: "realtime reconnecting",
  recovered: "realtime recovered",
  stale: "realtime stale · refetching",
  error: "realtime error",
};

const REALTIME_PROJECTION_EVENT_TYPE_SET = new Set<string>(REALTIME_PROJECTION_EVENT_TYPES);
const REALTIME_EVENT_SCOPE_SET = new Set<string>(REALTIME_EVENT_SCOPES);
const REALTIME_RESOURCE_KIND_SET = new Set<string>(REALTIME_RESOURCE_KINDS);

export function parseRealtimeProjectionEventData(data: string): RealtimeProjectionEvent | null {
  try {
    const parsed = JSON.parse(data) as unknown;
    return isRealtimeProjectionEvent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function isRealtimeProjectionEvent(value: unknown): value is RealtimeProjectionEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<RealtimeProjectionEvent>;
  return (
    event.schema === REALTIME_EVENT_SCHEMA &&
    event.schemaVersion === REALTIME_EVENT_SCHEMA_VERSION &&
    typeof event.id === "string" &&
    event.id.trim().length > 0 &&
    typeof event.type === "string" &&
    REALTIME_PROJECTION_EVENT_TYPE_SET.has(event.type) &&
    typeof event.revision === "number" &&
    Number.isFinite(event.revision) &&
    typeof event.createdAt === "string" &&
    typeof event.scope === "string" &&
    REALTIME_EVENT_SCOPE_SET.has(event.scope) &&
    isRealtimeScopeForEventType(event.type as RealtimeProjectionEventType, event.scope) &&
    (event.key === null || typeof event.key === "string") &&
    isRealtimeSourceRevision(event.source) &&
    Array.isArray(event.resources) &&
    event.resources.every(isRealtimeProjectionResource) &&
    isRealtimeRecoveryHint(event.recovery) &&
    typeof event.missedEvents === "boolean" &&
    isRealtimePayloadForEventType(event.type as RealtimeProjectionEventType, event.payload) &&
    (event.detail === null || isRecord(event.detail))
  );
}

function isRealtimeScopeForEventType(type: RealtimeProjectionEventType, scope: string): scope is RealtimeProjectionEventScope {
  switch (type) {
    case "projection.updated":
      return scope === "global";
    case "source.status":
      return scope === "source";
    case "run.updated":
      return scope === "run";
    case "transcript.delta":
      return scope === "session";
    case "orchestrator.message":
      return scope === "orchestrator";
  }
}

function isRealtimePayloadForEventType(type: RealtimeProjectionEventType, value: unknown): value is RealtimeProjectionEventPayload {
  if (!isRealtimePayloadBase(value)) return false;
  const payload = value as Partial<RealtimeProjectionEventPayload>;
  switch (type) {
    case "projection.updated": {
      const projectionPayload = payload as Partial<RealtimeProjectionUpdatedPayload>;
      return isRealtimeResourceKindArray(projectionPayload.resourceKinds) && isRealtimeResourceKindArray(projectionPayload.resourcesChanged);
    }
    case "run.updated": {
      const runPayload = payload as Partial<RealtimeRunUpdatedPayload>;
      return (
        isNullableString(runPayload.runId) &&
        isNullableString(runPayload.issueId) &&
        isNullableString(runPayload.issueIdentifier) &&
        isNullableString(runPayload.status)
      );
    }
    case "transcript.delta": {
      const transcriptPayload = payload as Partial<RealtimeTranscriptDeltaPayload>;
      return (
        isNullableString(transcriptPayload.runId) &&
        isNullableString(transcriptPayload.sessionId) &&
        isNullableFiniteNumber(transcriptPayload.afterSequence) &&
        isNullableFiniteNumber(transcriptPayload.eventCount) &&
        isOptionalTranscriptPatchMessages(transcriptPayload.messages)
      );
    }
    case "orchestrator.message": {
      const orchestratorPayload = payload as Partial<RealtimeOrchestratorMessagePayload>;
      return (
        isNullableString(orchestratorPayload.conversationId) &&
        isNullableFiniteNumber(orchestratorPayload.messageCount) &&
        isNullableFiniteNumber(orchestratorPayload.inputLength) &&
        isNullableFiniteNumber(orchestratorPayload.status) &&
        isOptionalChatMessage(orchestratorPayload.message) &&
        isOptionalChatMessages(orchestratorPayload.messages)
      );
    }
    case "source.status": {
      const sourcePayload = payload as Partial<RealtimeSourceStatusPayload>;
      return (
        isNullableString(sourcePayload.status) &&
        Array.isArray(sourcePayload.fetchedStates) &&
        sourcePayload.fetchedStates.every((state) => typeof state === "string") &&
        isNullableString(sourcePayload.fetchedAt) &&
        (sourcePayload.cached === null || typeof sourcePayload.cached === "boolean") &&
        isNullableSourceStatusError(sourcePayload.error) &&
        isNullableFiniteNumber(sourcePayload.issueCount)
      );
    }
  }
}

function isOptionalTranscriptPatchMessages(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every(isTranscriptPatchMessage));
}

function isTranscriptPatchMessage(value: unknown): value is RealtimeTranscriptPatchMessage {
  if (!isRecord(value)) return false;
  const patch = value as Partial<RealtimeTranscriptPatchMessage>;
  return (
    typeof patch.sequence === "number" &&
    Number.isFinite(patch.sequence) &&
    (patch.message === null || isRecord(patch.message)) &&
    isOptionalTranscriptPatchOperation(patch.operation) &&
    isOptionalTranscriptPatchJoinMode(patch.joinMode)
  );
}

function isOptionalTranscriptPatchOperation(value: unknown): boolean {
  return value === undefined || value === "append" || value === "merge-assistant-delta" || value === "replace-assistant";
}

function isOptionalTranscriptPatchJoinMode(value: unknown): boolean {
  return value === undefined || value === "spaced" || value === "exact" || value === "token";
}

function isOptionalChatMessages(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every(isChatMessage));
}

function isOptionalChatMessage(value: unknown): boolean {
  return value === undefined || value === null || isChatMessage(value);
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!isRecord(value)) return false;
  const message = value as Partial<ChatMessage>;
  return (message.who === "agent" || message.who === "user") && typeof message.text === "string";
}

function isRealtimePayloadBase(value: unknown): value is RealtimePayloadBase {
  if (!isRecord(value)) return false;
  const payload = value as Partial<RealtimePayloadBase>;
  return (
    typeof payload.source === "string" &&
    (typeof payload.sourceRevision === "string" || typeof payload.sourceRevision === "number") &&
    (payload.detail === null || isRecord(payload.detail))
  );
}

function isRealtimeSourceRevision(value: unknown): value is RealtimeProjectionEvent["source"] {
  if (!isRecord(value)) return false;
  const source = value as Partial<RealtimeProjectionEvent["source"]>;
  return (
    typeof source.source === "string" &&
    (typeof source.revision === "string" || typeof source.revision === "number") &&
    (source.observedAt === null || typeof source.observedAt === "string")
  );
}

function isRealtimeProjectionResource(value: unknown): value is RealtimeProjectionResource {
  if (!isRecord(value)) return false;
  const resource = value as Partial<RealtimeProjectionResource>;
  return (
    typeof resource.kind === "string" &&
    isRealtimeResourceKind(resource.kind) &&
    typeof resource.href === "string" &&
    resource.href.trim().length > 0 &&
    (resource.relation === "refetch" || resource.relation === "template")
  );
}

function isRealtimeRecoveryHint(value: unknown): value is RealtimeProjectionRecoveryHint {
  if (!isRecord(value)) return false;
  const recovery = value as Partial<RealtimeProjectionRecoveryHint>;
  return (
    recovery.strategy === "refetch" &&
    (recovery.reason === "event" || recovery.reason === "missed-events") &&
    (recovery.lastEventId === null || typeof recovery.lastEventId === "string") &&
    Array.isArray(recovery.endpoints) &&
    recovery.endpoints.every((endpoint) => typeof endpoint === "string")
  );
}

function isRealtimeResourceKind(kind: string): kind is RealtimeResourceKind {
  return REALTIME_RESOURCE_KIND_SET.has(kind);
}

function isRealtimeResourceKindArray(value: unknown): value is readonly RealtimeResourceKind[] {
  return Array.isArray(value) && value.every((kind) => typeof kind === "string" && isRealtimeResourceKind(kind));
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isNullableSourceStatusError(value: unknown): value is RealtimeSourceStatusPayload["error"] {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  const error = value as Partial<NonNullable<RealtimeSourceStatusPayload["error"]>>;
  return typeof error.code === "string" && typeof error.message === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

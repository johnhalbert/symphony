export type RealtimeProjectionEventType =
  | "projection.updated"
  | "run.updated"
  | "transcript.delta"
  | "orchestrator.message"
  | "source.status";

export type RealtimeResourceKind =
  | "dashboard"
  | "issue-board"
  | "issue-detail"
  | "history"
  | "sidebar"
  | "session-transcript"
  | "orchestrator-chat"
  | "source";

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

export interface RealtimeProjectionEvent {
  id: string;
  type: RealtimeProjectionEventType;
  revision: number;
  createdAt: string;
  source: {
    source: string;
    revision: string | number;
    observedAt: string | null;
  };
  resources: readonly RealtimeProjectionResource[];
  recovery: RealtimeProjectionRecoveryHint;
  missedEvents: boolean;
  detail: Record<string, unknown> | null;
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

export const REALTIME_PROJECTION_EVENT_TYPES: readonly RealtimeProjectionEventType[] = [
  "projection.updated",
  "run.updated",
  "transcript.delta",
  "orchestrator.message",
  "source.status",
] as const;

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

export function isRealtimeProjectionEvent(value: unknown): value is RealtimeProjectionEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<RealtimeProjectionEvent>;
  return (
    typeof event.id === "string" &&
    event.id.trim().length > 0 &&
    typeof event.type === "string" &&
    REALTIME_PROJECTION_EVENT_TYPE_SET.has(event.type) &&
    typeof event.revision === "number" &&
    Number.isFinite(event.revision) &&
    typeof event.createdAt === "string" &&
    isRealtimeSourceRevision(event.source) &&
    Array.isArray(event.resources) &&
    event.resources.every(isRealtimeProjectionResource) &&
    isRealtimeRecoveryHint(event.recovery) &&
    typeof event.missedEvents === "boolean" &&
    (event.detail === null || (typeof event.detail === "object" && !Array.isArray(event.detail)))
  );
}

function isRealtimeSourceRevision(value: unknown): value is RealtimeProjectionEvent["source"] {
  if (!value || typeof value !== "object") return false;
  const source = value as Partial<RealtimeProjectionEvent["source"]>;
  return (
    typeof source.source === "string" &&
    (typeof source.revision === "string" || typeof source.revision === "number") &&
    (source.observedAt === null || typeof source.observedAt === "string")
  );
}

function isRealtimeProjectionResource(value: unknown): value is RealtimeProjectionResource {
  if (!value || typeof value !== "object") return false;
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
  if (!value || typeof value !== "object") return false;
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
  return (
    kind === "dashboard" ||
    kind === "issue-board" ||
    kind === "issue-detail" ||
    kind === "history" ||
    kind === "sidebar" ||
    kind === "session-transcript" ||
    kind === "orchestrator-chat" ||
    kind === "source"
  );
}

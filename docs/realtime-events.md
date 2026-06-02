# Symphony realtime event contract

Symphony exposes a resumable realtime stream at `GET /api/v1/realtime`. The first
transport is Server-Sent Events (SSE); the JSON envelope below is the stable event
shape regardless of whether a future transport is SSE or WebSocket.

## Transport serialization

Each non-comment SSE frame uses the canonical event id and type as SSE metadata
and the complete JSON envelope as the data payload:

```text
id: <event.id>
event: <event.type>
data: <JSON.stringify(event)>
```

The server sends `retry: 5000` when a stream opens and may send keepalive comment
frames (`: keepalive`). Clients resume with the browser `Last-Event-ID` header or
with `?lastEventId=<id>`. If the server can replay from its short in-memory
history, it emits the missed events after the known id. If the id is unknown or
history has been truncated, the stream emits a `projection.updated` recovery event
with `missedEvents: true` and `recovery.reason: "missed-events"` so clients can
refetch the listed resources.

SSE `id`, `event`, and comment fields are newline-sanitized before writing.

## Envelope

Every realtime event uses the following versioned envelope:

```ts
interface RealtimeProjectionEvent<TType extends RealtimeProjectionEventType> {
  schema: "symphony.realtime.v1";
  schemaVersion: 1;
  id: string;                 // monotonically increasing per StatusServer process
  type: TType;                // also used as the SSE event name
  revision: number;           // numeric equivalent of id for client ordering
  createdAt: string;          // ISO timestamp from the server clock
  scope: "global" | "source" | "run" | "session" | "orchestrator";
  key: string | null;         // scope-specific key when known, otherwise null
  source: {
    source: string;           // projection or durable source that triggered the event
    revision: string | number;
    observedAt: string | null;
  };
  resources: RealtimeProjectionResource[];
  recovery: RealtimeProjectionRecoveryHint;
  missedEvents: boolean;
  payload: RealtimeProjectionEventPayloadByType[TType];
  detail: Record<string, unknown> | null; // deprecated compatibility mirror
}
```

`resources` and `recovery.endpoints` tell web clients which read-model routes to
refetch. `payload` is the typed event body. `detail` remains for compatibility
with current consumers but new consumers should prefer `payload`.

## Event types and payloads

### `projection.updated`

Scope: `global`, `key: null`.

Published when one or more web projections should be treated as stale. Clients
should refetch the resources listed in `resources`/`recovery.endpoints`.

```ts
interface RealtimeProjectionUpdatedPayload {
  source: string;
  sourceRevision: string | number;
  resourceKinds: RealtimeResourceKind[];
  resourcesChanged: RealtimeResourceKind[];
  detail: Record<string, unknown> | null;
}
```

### `run.updated`

Scope: `run`; `key` is the run id when the publisher knows it, otherwise `null`.

Published for run-store or transcript source changes that affect dashboard,
sidebar, or history run summaries.

```ts
interface RealtimeRunUpdatedPayload {
  source: string;
  sourceRevision: string | number;
  runId: string | null;
  issueId: string | null;
  issueIdentifier: string | null;
  status: string | null;
  detail: Record<string, unknown> | null;
}
```

### `transcript.delta`

Scope: `session`; `key` is the session id when known, falling back to run id when
known, otherwise `null`.

Published for transcript-bearing source revisions. The current slice uses this as
a refetch hint for the transcript route; future transcript-tail publishers can
populate `afterSequence` and `eventCount`.

```ts
interface RealtimeTranscriptDeltaPayload {
  source: string;
  sourceRevision: string | number;
  runId: string | null;
  sessionId: string | null;
  afterSequence: number | null;
  eventCount: number | null;
  detail: Record<string, unknown> | null;
}
```

### `orchestrator.message`

Scope: `orchestrator`; `key` is the conversation id when known.

Published for durable orchestrator conversation appends/updates and accepted
operator chat posts.

```ts
interface RealtimeOrchestratorMessagePayload {
  source: string;
  sourceRevision: string | number;
  conversationId: string | null;
  messageCount: number | null;
  inputLength: number | null;
  status: number | null;
  detail: Record<string, unknown> | null;
}
```

### `source.status`

Scope: `source`; `key` is the source name.

Published when externally backed web-projection source freshness changes, such as
Linear/tracker issue source refreshes or cached fallbacks.

```ts
interface RealtimeSourceStatusPayload {
  source: string;
  sourceRevision: string | number;
  status: string | null;
  fetchedStates: string[];
  fetchedAt: string | null;
  cached: boolean | null;
  error: { code: string; message: string } | null;
  issueCount: number | null;
  detail: Record<string, unknown> | null;
}
```

## Resource kinds

`RealtimeResourceKind` is one of:

- `dashboard`
- `issue-board`
- `issue-detail`
- `history`
- `sidebar`
- `session-transcript`
- `orchestrator-chat`
- `source`

Each resource has an `href` and a relation of `refetch` (direct route) or
`template` (route template that requires client context, such as a session id).

## Client validation

The web client mirrors this contract in `web/src/data/realtimeEvents.ts`. It
accepts only `schema: "symphony.realtime.v1"`, `schemaVersion: 1`, known event
types, known scopes, valid resource/recovery shapes, and the payload shape for
the event type. Malformed frames are ignored; browser reconnection or the next
valid missed-event recovery frame should trigger refetch behavior.

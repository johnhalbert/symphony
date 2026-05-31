# Run activity event ordering contract

`RunActivityEvent` is Symphony's normalized, frontend-facing run activity stream. Harness adapters may map JSON-RPC streams, ACP session updates, SDK diagnostics, or Symphony-owned lifecycle signals into this shape, but persistence and realtime code must be able to consume the normalized stream without knowing the upstream protocol.

Canonical frontend events expose `eventId`, `runSessionId`, `occurredAt`, `harness`, optional `sequence`, `actor`, `channel`, `kind`, `text`, and `payload`. The canonical frontend channels are `lifecycle`, `chat`, `tool`, `diagnostic`, `token`, `rate_limit`, and `terminal`; older adapter-facing `message` and `status` names are aliases that must normalize to `chat` and `diagnostic` before events are emitted to clients.

## Scope

- `runSessionId` is the ordering and idempotency scope.
- `runSessionId` must be unique for a Symphony run attempt, even when the upstream runtime reuses a raw runtime session/thread id across issue turns.
- When an adapter cannot provide an explicit scope, Symphony may derive one from source `runId` and raw `sessionId` (`runId:sessionId`) or from source `runId` before a runtime session exists. These source identifiers are adapter input/correlation metadata and are not part of the frontend-facing event shape.
- Raw runtime session ids belong in `payload.runtimeSessionId` when useful for diagnostics; they are not sufficient as an idempotency scope.

## Sequencing

- `sequence` is optional in the public contract. When present, it is a positive, 1-based integer scoped to one `(runSessionId, harness)` stream.
- If a harness/protocol provides a positive integer sequence, Symphony preserves it, even if it arrives out of order.
- If `sequence` is missing, null, zero, negative, or non-integer on an ordering input, Symphony assigns `highWatermark + 1` for the `runSessionId` scope and records `sequenceSource: "symphony"` on the accepted internal event.
- Out-of-order explicit sequences are valid backfill as long as their `runSessionId + sequence` has not already been accepted and they do not violate the terminal boundary rules below.
- Persistence and realtime projections should order accepted events in the same `(runSessionId, harness)` stream by `sequence`; when sequence is missing or events are from different streams, they fall back to `occurredAt`, then `runSessionId`, `harness`, and `eventId` as deterministic tie-breakers.

## Idempotency

An incoming event is a duplicate no-op when any accepted event in the same durable stream already owns one of these keys:

1. `eventId` (stable Symphony activity event id),
2. `runSessionId + sequence` when a positive sequence is present or assigned, or
3. `runSessionId + externalEventId` when the upstream event id is present and non-empty on adapter/orderer input.

Duplicate no-ops must not increment sequence state, mutate terminal state, or be re-emitted over SSE/realtime streams.

## Transactional append metadata

- Append stores must apply this ordering/idempotency contract inside the persistence transaction before accepted events are emitted to reducers or realtime clients.
- Accepted append results return the final `runSessionId`, `sequence`, `sequenceSource`, and a durable append revision. In Postgres, the append revision is `run_activity_event_id`.
- Duplicate append results return the existing event metadata and must not allocate a new sequence or append revision.
- Rejected append results do not persist rows and must not be published as activity updates.

## Terminal events and replay

- The first accepted `channel: "terminal"` event wins and records `terminalSequence`.
- A first terminal event with an explicit sequence is rejected as `terminal_sequence_precedes_accepted_event` when any accepted event in the same `runSessionId` already has a greater sequence. For example, after accepting non-terminal sequences `1` and `4`, a terminal event with sequence `3` is rejected and does not mutate ordering state or emit over SSE. The adapter must instead replay a terminal boundary at or above the accepted high-water mark, or leave terminal sequence unset so Symphony assigns the next sequence.
- Exact duplicate terminal replay remains a duplicate no-op.
- After a terminal event, explicit non-terminal backfill with `sequence < terminalSequence` may still be accepted so reconnect/replay can fill gaps.
- After a terminal event, missing-sequence events, events with `sequence > terminalSequence`, and additional terminal events are rejected as `terminal_already_accepted` unless they are duplicates.
- SSE consumers may treat an accepted terminal event as the live stream close marker because no accepted event may sort after `terminalSequence`, while still allowing durable readers to observe later accepted pre-terminal backfill in sequence order.

## Adapter commitments

JSON-RPC and ACP adapters can both satisfy this contract by:

- mapping upstream message/status concepts to canonical `chat` and `diagnostic` channels before exposing events to frontend clients,
- preserving upstream positive sequence/order fields when available,
- leaving sequence unset when the upstream stream has no reliable sequence so Symphony assigns it,
- carrying an opaque `externalEventId` whenever the protocol provides one for reconnect/replay idempotency, and
- using `runSessionId` rather than raw runtime session/thread ids for durable idempotency.

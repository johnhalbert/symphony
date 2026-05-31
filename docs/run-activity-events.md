# Run activity event ordering contract

`RunActivityEvent` is Symphony's normalized, frontend-facing run activity stream. Harness adapters may map JSON-RPC streams, ACP session updates, SDK diagnostics, or Symphony-owned lifecycle signals into this shape, but persistence and realtime code must be able to consume the normalized stream without knowing the upstream protocol.

## Scope

- `runSessionId` is the ordering and idempotency scope.
- `runSessionId` must be unique for a Symphony run attempt, even when the upstream runtime reuses a raw `sessionId` or thread across issue turns.
- When an adapter cannot provide an explicit scope, Symphony derives one from `runId` and `sessionId` (`runId:sessionId`) or from `runId` before a runtime session exists.
- Raw `sessionId` is correlation metadata only; it is not sufficient as an idempotency scope.

## Sequencing

- `sequence` is a positive, 1-based integer within a `runSessionId`.
- If a harness/protocol provides a positive integer sequence, Symphony preserves it, even if it arrives out of order.
- If `sequence` is missing, null, zero, negative, or non-integer, Symphony assigns `highWatermark + 1` for the `runSessionId` scope and records `sequenceSource: "symphony"`.
- Out-of-order explicit sequences are valid backfill as long as their `runSessionId + sequence` has not already been accepted.
- Persistence and realtime projections must order accepted events by `(runSessionId, sequence)`, with `at` and `id` only as deterministic tie-breakers for corrupted legacy data.

## Idempotency

An incoming event is a duplicate no-op when any accepted event in the same durable stream already owns one of these keys:

1. `id` (stable Symphony activity event id),
2. `runSessionId + sequence`, or
3. `runSessionId + externalEventId` when the upstream event id is present and non-empty.

Duplicate no-ops must not increment sequence state, mutate terminal state, or be re-emitted over SSE/realtime streams.

## Terminal events and replay

- The first accepted `channel: "terminal"` event wins and records `terminalSequence`.
- Exact duplicate terminal replay remains a duplicate no-op.
- After a terminal event, explicit non-terminal backfill with `sequence < terminalSequence` may still be accepted so reconnect/replay can fill gaps.
- After a terminal event, missing-sequence events, events with `sequence > terminalSequence`, and additional terminal events are rejected as `terminal_already_accepted` unless they are duplicates.
- SSE consumers may treat an accepted terminal event as the live stream close marker, while still allowing durable readers to observe later accepted pre-terminal backfill in sequence order.

## Adapter commitments

JSON-RPC and ACP adapters can both satisfy this contract by:

- setting `protocol` to `"json_rpc"` or `"acp"`,
- preserving upstream positive sequence/order fields when available,
- leaving sequence unset when the upstream stream has no reliable sequence so Symphony assigns it,
- carrying an opaque `externalEventId` whenever the protocol provides one, and
- using `runSessionId` rather than raw session/thread ids for durable idempotency.

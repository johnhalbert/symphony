# Transcript display taxonomy and grouping

This document defines the web transcript presentation model used by Symphony run
history. It is intentionally a projection contract: persisted transcript events
can contain runtime-only details, but the web model must expose only sanitized,
public display fields.

## Message classes

The public transcript remains the compact `TranscriptMessage` union shared by
the backend and web UI:

| Display class | Public `kind` | Source events | Notes |
| --- | --- | --- | --- |
| Run prelude | `system`, `user` | Persisted `RunRecord` metadata and prompt | Prepended when no equivalent transcript event exists. System prompt is redacted; user prompt is length-bounded and secret-redacted. |
| Chat output | `assistant` | `assistant`, `message_*`, `assistant_message_*`, `response_*`, `harness:progress` without a status/tool activity source, and `harness:progress` with `activitySource: stream`/`delta` or assistant chat-channel payloads | Text is projected from sanitized preview fields or sanitized event message. Delta fragments are grouped (see below). |
| Reasoning | `thinking` | `thinking`, `reasoning_*`, `thought_*`, `assistant_reasoning_*` | Uses public summaries/previews only; raw reasoning payloads stay hidden. |
| Tool rows | `tool_call` | Runtime/Cursor tool events such as `tool_call`, `tool_start`, `tool_complete`, `tool_call_started`, `tool_call_completed` | Start/complete pairs group by call id/tool id. Arguments/results are previews only. Harness tool progress is hidden to avoid duplicate rows and raw command spam. |
| Work/task summaries | `task` | `task` events | For coarse-grained task updates that are safe to show as milestones. |
| Operator requests | `request` | `approval_request`, `human_required`, `request` | `actions` is always an array; unresolved actions project as `[]`, not `undefined`. |
| Status rows | `status` | Lifecycle, approval/publication resolution, sanitized canonical token summaries, diagnostics, provider/rate limits, terminal states, legacy ACP protocol diagnostics, unknown safe events | Status rows are concise public state changes. Unknown events fall back to sanitized preview text. |
| Hidden metadata | none | `session_started`, raw/legacy `tokens`, raw/legacy `rate_limits`, `run_status`, harness `progress` with `activitySource: tool` | These events can update run metadata elsewhere, but they should not create transcript rows. |

Raw token-count telemetry is not a chat transcript message. The run/session
summary owns aggregate token display. When the durable RunActivity taxonomy emits
a sanitized, low-frequency `token_usage_reported`/token-budget event, or a
migration fixture emits a legacy `tokens` row with public summary text plus
top-level counts, it may appear as a concise `status` row; raw legacy `tokens`
payloads without that public summary remain hidden.

## Grouping boundaries

* Assistant deltas: contiguous `message_delta`, `assistant_delta`,
  `assistant_message_delta`, `response_delta`, or harness `progress` events with
  `activitySource: delta` or assistant chat-channel payloads collapse into one
  `assistant` message. Hermes runtime `message_delta` and harness text deltas
  concatenate exactly so token fragments do not acquire artificial spaces; when
  Hermes persists the same gateway `message.delta` through both runtime and
  harness rows, the mirrored fragment is consumed once. Empty delta fragments do
  not create placeholder rows, and exact replay of the same run sequence/text is
  idempotent. A final `message_complete`/`assistant_complete`/
  `assistant_message_completed`/`response_complete` replaces the accumulated
  delta with the final public text.

* Tool calls: tool start/progress/complete events with the same `callId`,
  `call_id`, `toolCallId`, `toolId`, or `tool_id` collapse into one `tool_call`
  row. The row keeps the first timestamp, merges previews, and prefers terminal
  status over `running`/`unknown`.
* Harness tool progress: `harness:progress` with `activitySource: tool` is a
  hidden boundary-neutral metadata event. It must not reset an in-flight
  assistant delta group because the runtime tool events provide the visible tool
  row when one is safe to display.
* Diagnostics: `run_diagnostic` and `runtime_diagnostic` project to one `status`
  row keyed by diagnostic `code` or runtime state. Diagnostic payload details are
  not exposed unless they are already in sanitized public preview/message fields.
* Provider/rate limits: `provider_limit`, `provider_limit_detected`, and
  `rate_limit_*` events project to concise `status` rows keyed by the provider
  limit or rate-limit kind. Raw provider payloads and account identifiers remain
  hidden.
* Lifecycle/status changes: known lifecycle, approval, publication, sanitized
  canonical token summaries, and unknown safe events project to `status` rows.
  Internal SDK liveness (`run_status`) is hidden metadata because live status is
  represented outside the transcript.
* Terminal states: legacy `completed`, `failed`, and `cancelled` plus canonical
  `run_succeeded`, `run_failed`, and `run_cancelled` events project to `status`
  rows, not assistant messages. If no public message/error exists, legacy
  defaults are `Run completed`, `Run failed`, and `Run cancelled`.

## Sanitization invariants

* The web projection never forwards raw payload objects wholesale.
* Raw request objects, raw tool arguments, runtime run ids, agent ids, tokens,
  credentials, and secret-like strings must not appear in serialized transcript
  messages.
* Public previews are still passed through shared transcript redaction helpers.
* Empty arrays with meaning are preserved exactly, especially unresolved request
  `actions: []`.

## Missing and terminal behavior

* Missing completion: a transcript may end without `completed`, `failed`,
  `cancelled`, `run_succeeded`, `run_failed`, or `run_cancelled`; the UI should
  render the rows it has and rely on run/session status for liveness. The
  projection must not synthesize a terminal message.
* Failure: `failed`/`run_failed` is a terminal `status` row using the sanitized
  public error or `Run failed` fallback.
* Cancellation: `cancelled`/`run_cancelled` is a terminal `status` row using the
  sanitized public reason/message or `Run cancelled` fallback.
* Replays/idempotency: repeated hidden metadata remains hidden; repeated tool
  events with the same call id merge into the existing row; repeated terminal
  events remain explicit status rows in timestamp order so recovery/replay is
  auditable without exposing internals.

## Encoded scenarios

`tests/web-transcript-projection.test.ts` encodes the high-risk grouping rules:

* sanitized Cursor/runtime message mapping, including persisted harness
  `progress` text with `activitySource: stream` or no status/tool activity source;
* assistant delta replacement by final completion, canonical
  `assistant_message_delta` grouping, runtime-only missing-completion
  `message_delta` streams, and real Hermes runtime+harness mirrored delta rows;
* tool start/complete pairing by `toolId`/`toolCallId`;
* hidden legacy session/token/rate-limit/run-status metadata;
* exact grouping of harness text deltas across hidden tool-progress spam;
* missing-completion streams with duplicate replayed deltas, empty deltas, and
  failed/cancelled terminal rows;
* diagnostics, provider/rate limits, canonical token summaries, completion,
  failure, and cancellation status rows;
* legacy ACP protocol events downgraded to neutral runtime diagnostics;
* unresolved request `actions: []` and unknown-event fallback without leaking
  runtime fields.

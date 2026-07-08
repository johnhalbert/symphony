# Cursor Extension API

Symphony remains the orchestration service. A future Cursor extension should be a local UI client over the status API and should not reach into Cursor SDK internals or assume SDK-created runs appear in Cursor's native chat UI.

## Connection

- Base URL: `http://127.0.0.1:{port}` or the configured `server.host` and `server.port`.
- Read endpoints do not require a token.
- Mutating endpoints, including `open-workspace`, require `X-Symphony-Token` when `server.open_workspace_token` is configured.

## Stable Resources

- `GET /api/v1/state` returns the live orchestrator snapshot.
- `GET /api/v1/board?refresh=1` returns the extension-facing issue board with `columns`, flat `issues`, `counts`, and `generatedAt` metadata. `refresh=1` bypasses the short-lived tracker cache.
- `GET /api/v1/board/issues/:id` returns a board-scoped issue detail payload with the issue envelope, workspace capabilities, runs, PR/CI, blockers, and liveness data.
- `GET /api/v1/issue-board?refresh=1` remains the legacy board response with `lanes` for existing clients.
- `GET /api/v1/activity?offset=0&limit=50` returns a globally sorted feed of persisted run, transcript, and writeback activity.
- `GET /api/v1/issues/:id` returns live issue status when present plus durable workspace, latest run metadata, and an `issueDetails` envelope. Prefer `issueDetails` for extension issue cards; top-level `metadata`, `workspace`, `latestRun`, and `lifecycle` remain available for backward compatibility and detailed inspection. Those top-level durable records expose normalized `projectContext` metadata when known.
- `GET /api/v1/issues/:id/runs` returns all persisted runs for an issue id or identifier plus the same `issueDetails` envelope. Each run row retains its normalized `projectContext`.
- `GET /api/v1/runs/:runId` returns run metadata, including normalized `projectContext` attribution for durable reads.
- `GET /api/v1/runs/:runId/transcript?offset=0&limit=100` returns paginated transcript events.
- `GET /api/v1/workspaces` returns known durable workspace records, including normalized `projectContext` attribution.
- `GET /api/v1/workspaces/:key` returns a workspace record by key, issue id, or issue identifier.
- `POST /api/v1/issues/:id/open-workspace` opens the associated workspace in Cursor.
- `POST /api/v1/issues/:id/pause` prevents new dispatch for that issue and clears pending retries.
- `POST /api/v1/issues/:id/resume` allows dispatch for that issue again and schedules a refresh.
- `POST /api/v1/issues/:id/cancel` aborts an in-flight worker for that issue and clears pending retries.

## MVP Extension Shape

- Activity tree: issues, workspaces, and runs.
- Workspace action: call `open-workspace` rather than constructing editor commands itself.
- Transcript webview: render persisted transcript events from Symphony's store.
- Status surface: show live running/retrying state and durable run terminal state.
- Operator controls: expose pause, resume, cancel, and open-workspace only when a mutation token is configured.

## Issue Details Envelope

`issueDetails` is the enriched issue/status contract on `GET /api/v1/issues/:id`, `GET /api/v1/issues/:id/runs`, and `operatorView` rows in `GET /api/v1/state`.

- `source`: `live` when the envelope was built from an active orchestrator tracker row, otherwise `durable`.
- `completeness`: `full` for live tracker data and `partial` for durable store synthesis.
- `issue`: tracker-shaped fields (`id`, `identifier`, title, state, labels, blockers, Linear URL, timestamps). Durable partial responses leave unavailable tracker fields null or empty. `issue.id` is null unless a persisted lifecycle, run, workspace, or live tracker row provides a real Linear issue id; Symphony does not copy the route key into `issue.id`.
- `tracker`: Linear record-age and classification metadata for tracker-derived fields. Live rows include `generatedAt` (the Symphony snapshot time), tracker `updatedAt` (Linear issue `updatedAt`), `ageMs = max(generatedAt - updatedAt, 0)`, `stale = ageMs > staleThresholdMs`, `staleThresholdMs` (currently the polling interval), raw `state`, and a config-driven `classification` (`active`, `handoff`, `blocked`, `terminal`, or `unknown`). This is not a tracker-cache fetch timestamp. Durable partial rows set tracker timestamps, staleness, and classification to null.
- `blockers`: summary of live Linear `blockedBy` data plus lifecycle human block state. `available` is false for durable partial rows. `openCount` uses the configured terminal states to distinguish open blockers from completed blockers.
- `workspace`: workspace and git hints (`workspaceKey`, `path`, `sourceKind`, `branchName`, `gitBranchName`, `repoPath`, `baseRef`) resolved with the same precedence as legacy status metadata.
- `pullRequest`: GitHub PR hints (`url`, `number`, `headSha`, `branch`, `ciStatus`, `lastPushedAt`) when known.
- `latestRun`: run summary (`runId`, `status`, `terminalReason`, `error`, `completedAt`). Live envelopes prefer the active run (`activeRunId` or live `runId`) so issue cards describe the running agent. Durable envelopes use the issue-wide latest persisted run. `terminalReason` is normalized from persisted run status; `timed_out` is reserved until a durable timeout signal exists.

`issueDetails` itself does not currently surface `projectContext`. When clients need durable attribution, read the top-level `workspace`, `latestRun`, `lifecycle`, or run-list records on the same response family. Older persisted records that predate explicit attribution are normalized on read to the legacy/default context (`projectContextId: "default"`, `projectContextLabel: "Default"`, `routingSource: "legacy_default"`) so compatibility endpoints stay context-safe.

`GET /api/v1/state` also exposes raw `running[].issueDetails` directly from the orchestrator snapshot. That raw field is the bare tracker-shaped `issue` view, not the envelope. Use `operatorView.running[].issueDetails` when the extension needs the enriched envelope.

`GET /api/v1/issues/:id` also keeps `live.issueDetails` as a deprecated raw tracker-view mirror for compatibility with older clients. Prefer the top-level `issueDetails` envelope and `issueDetails.issue` for new code.

On `GET /api/v1/issues/:id/runs`, the top-level `enrichment` object describes run-list liveness/timeline enrichment. It is separate from `issueDetails` and should not be confused with the issue details envelope.

## Issue Board

`GET /api/v1/board` returns:

```json
{
  "generatedAt": "2026-01-01T00:00:00.000Z",
  "tracker": { "status": "ok", "cached": false, "issueCount": 0 },
  "columns": [
    { "id": "todo", "title": "Todo", "states": ["Todo"], "count": 0, "issues": [] }
  ],
  "issues": [],
  "counts": { "total": 0, "trackerBacked": 0, "symphonyOnly": 0, "live": 0, "paused": 0, "blocked": 0 }
}
```

Columns contain the same card shape as the flat `issues` list. Card `capabilities.detail` points at `GET /api/v1/board/issues/:id`, preferring the Linear issue id when available and falling back to the identifier or durable card key. The endpoint requires a configured tracker client and returns `503` with `tracker_unavailable` when tracker access is not configured.

`GET /api/v1/issue-board` is kept for compatibility and returns the older `lanes` field and legacy card links.

## Board Issue Detail

`GET /api/v1/board/issues/:id` accepts either a Linear issue id or identifier. It first resolves the issue against the current board projection so tracker-backed board cards include title, description, labels, state, and blockers. It then attaches durable Symphony data: `workspace`, `latestRun`, enriched `runs`, `lifecycle`, `reviewLoop`, `metadata`, `pullRequest`, `blockers`, `operatorLiveness`, and `capabilities`. Those attached durable records retain normalized `projectContext` metadata, including legacy/default fallback when older file-backed rows omitted explicit attribution.

If tracker lookup fails but live or durable Symphony data exists, the endpoint returns that partial detail. It returns `503` only when tracker-backed data is required and no local fallback exists, and `404` when the issue is absent from board, live, workspace, run, and lifecycle sources.

## Activity Feed

`GET /api/v1/activity?offset=0&limit=50` returns read-only activity from persisted Symphony runs, transcripts, and writeback outbox records. `limit` defaults to `50` and is clamped to `100`; `offset` defaults to `0`. Add `issue=ENG-11` or a Linear issue id to restrict the feed to one issue.

The response shape is:

```json
{
  "generatedAt": "2026-01-01T00:00:00.000Z",
  "offset": 0,
  "limit": 50,
  "nextOffset": null,
  "activity": [],
  "counts": {
    "totalItems": 0,
    "distinctRunsConsidered": 0,
    "transcriptEventsConsidered": 0,
    "syntheticRunEvents": 0,
    "writebackOperationsConsidered": 0
  },
  "source": {
    "kind": "durable_activity",
    "runStoreAvailable": true,
    "writebackOutboxAvailable": true
  },
  "filter": {
    "issue": null
  }
}
```

Activity items are explicit summaries, not raw persisted records. Run and transcript items include `id`, `at`, `kind`, source, issue id/identifier, run id/role/status/agent/session, optional transcript sequence/event type/message, and links to the board issue, run, and one-event transcript page.

Writeback items use `kind: "writeback_operation"`, `source: "writeback"`, `at` from the outbox record `updatedAt`, `transcript: null`, and a redacted `writeback` object with operation kind, status, attempt, timestamps, transition `toState`/`fromStates`, or comment `dedupeKey`/`bodyLength`/`bodyRedacted`. Raw writeback comment bodies, raw transcript `payload`, run prompts, workspace paths, repo-local paths, and unbounded tracker error text are intentionally omitted from the feed.

## Non-Goals

- The extension does not run agents in the first version.
- The extension does not attempt to mirror SDK-created conversations into Cursor's native chat UI.
- The extension does not manage git worktrees directly; Symphony owns branch/worktree lifecycle.

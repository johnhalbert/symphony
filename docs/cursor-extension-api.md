# Cursor Extension API

Symphony remains the orchestration service. A future Cursor extension should be a local UI client over the status API and should not reach into Cursor SDK internals or assume SDK-created runs appear in Cursor's native chat UI.

## Connection

- Base URL: `http://127.0.0.1:{port}` or the configured `server.host` and `server.port`.
- Read endpoints do not require a token.
- Mutating endpoints, including `open-workspace`, require `X-Symphony-Token` when `server.open_workspace_token` is configured.

## Stable Resources

- `GET /api/v1/state` returns the live orchestrator snapshot.
- `GET /api/v1/issues/:id` returns live issue status when present plus durable workspace, latest run metadata, and an `issueDetails` envelope. Prefer `issueDetails` for extension issue cards; top-level `metadata`, `workspace`, `latestRun`, and `lifecycle` remain available for backward compatibility and detailed inspection.
- `GET /api/v1/issues/:id/runs` returns all persisted runs for an issue id or identifier plus the same `issueDetails` envelope.
- `GET /api/v1/runs/:runId` returns run metadata.
- `GET /api/v1/runs/:runId/transcript?offset=0&limit=100` returns paginated transcript events.
- `GET /api/v1/workspaces` returns known durable workspace records.
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
- `tracker`: freshness and classification metadata for tracker-derived fields. Live rows include `generatedAt`, tracker `updatedAt`, `ageMs`, `stale`, `staleThresholdMs`, raw `state`, and a config-driven `classification` (`active`, `handoff`, `blocked`, `terminal`, or `unknown`). Durable partial rows set tracker timestamps, staleness, and classification to null.
- `blockers`: summary of live Linear `blockedBy` data plus lifecycle human block state. `available` is false for durable partial rows. `openCount` uses the configured terminal states to distinguish open blockers from completed blockers.
- `workspace`: workspace and git hints (`workspaceKey`, `path`, `sourceKind`, `branchName`, `gitBranchName`, `repoPath`, `baseRef`) resolved with the same precedence as legacy status metadata.
- `pullRequest`: GitHub PR hints (`url`, `number`, `headSha`, `branch`, `ciStatus`, `lastPushedAt`) when known.
- `latestRun`: latest persisted run summary (`runId`, `status`, `terminalReason`, `error`, `completedAt`). `terminalReason` is normalized from persisted run status; `timed_out` is reserved until a durable timeout signal exists.

`GET /api/v1/state` also exposes raw `running[].issueDetails` directly from the orchestrator snapshot. That raw field is the bare tracker-shaped `issue` view, not the envelope. Use `operatorView.running[].issueDetails` when the extension needs the enriched envelope.

On `GET /api/v1/issues/:id/runs`, the top-level `enrichment` object describes run-list liveness/timeline enrichment. It is separate from `issueDetails` and should not be confused with the issue details envelope.

## Non-Goals

- The extension does not run agents in the first version.
- The extension does not attempt to mirror SDK-created conversations into Cursor's native chat UI.
- The extension does not manage git worktrees directly; Symphony owns branch/worktree lifecycle.

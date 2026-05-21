# Cursor Extension API

Symphony remains the orchestration service. A future Cursor extension should be a local UI client over the status API and should not reach into Cursor SDK internals or assume SDK-created runs appear in Cursor's native chat UI.

## Connection

- Base URL: `http://127.0.0.1:{port}` or the configured `server.host` and `server.port`.
- Read endpoints do not require a token.
- Mutating endpoints, including `open-workspace`, require `X-Symphony-Token` when `server.open_workspace_token` is configured.

## Stable Resources

- `GET /api/v1/state` returns the live orchestrator snapshot.
- `GET /api/v1/issues/:id` returns live issue status when present plus durable workspace and latest run metadata.
- `GET /api/v1/issues/:id/runs` returns all persisted runs for an issue id or identifier.
- `GET /api/v1/runs/:runId` returns run metadata.
- `GET /api/v1/runs/:runId/transcript?offset=0&limit=100` returns paginated transcript events.
- `GET /api/v1/workspaces` returns known durable workspace records.
- `GET /api/v1/workspaces/:key` returns a workspace record by key, issue id, or issue identifier.
- `POST /api/v1/issues/:id/open-workspace` opens the associated workspace in Cursor.

## MVP Extension Shape

- Activity tree: issues, workspaces, and runs.
- Workspace action: call `open-workspace` rather than constructing editor commands itself.
- Transcript webview: render persisted transcript events from Symphony's store.
- Status surface: show live running/retrying state and durable run terminal state.

## Non-Goals

- The extension does not run agents in the first version.
- The extension does not attempt to mirror SDK-created conversations into Cursor's native chat UI.
- The extension does not manage git worktrees directly; Symphony owns branch/worktree lifecycle.

# Symphony Cursor Extension

This package is a Cursor/VS Code extension shell for Symphony. It is a local UI client over the public Symphony status API documented in [`../docs/cursor-extension-api.md`](../docs/cursor-extension-api.md). It does not import Symphony orchestrator internals, the Cursor SDK harness, or MCP servers.

The visual direction is intentionally minimal for this scaffold. Future UI work can draw from [`../docs/design-system/`](../docs/design-system/).

## Install And Build

From the repository root:

```powershell
npm ci
npm run extension:ci
npm run extension:typecheck
npm run extension:build
npm run extension:test
```

The extension has its own lockfile and dependency install under `extension/`.

## Settings

- `symphony.baseUrl`: defaults to `http://127.0.0.1:7331`.
- `symphony.token`: optional token for future mutating API calls. Read-only probes do not send it. Mutating calls will send it as `X-Symphony-Token`.

The extension validates connectivity with `GET /api/v1/state`. When connected, it also renders read-only dashboard sections from `operatorView`, `GET /api/v1/board`, `GET /api/v1/workspaces`, and `GET /api/v1/activity?offset=0&limit=20`. Read-only requests do not send `symphony.token`.

Connected dashboards show active agent sessions, durable workspace rows, board counts, the activity feed, and disabled Planning / Orchestrator / Chat placeholders until those APIs exist. Workspace actions call `POST /api/v1/issues/:id/open-workspace` through Symphony; they are disabled when the status API reports that mutations require a token and `symphony.token` is empty, or when the mutation policy is unavailable.

The sidebar and fallback webview panel share one live polling loop. Opening the fallback panel starts refresh polling even when the sidebar view is unavailable, and polling stops after all dashboard surfaces are hidden or disposed.

Connection states:

- `connected`: HTTP 200, JSON object body, and string `generatedAt`.
- `offline`: valid URL, but the server is unreachable or the probe times out.
- `error`: invalid URL, non-200 response, invalid JSON, or a response missing `generatedAt`.

## F5 Development Host

This repository ignores `.vscode/`, so copy the example files locally:

1. Copy `extension/dev/launch.example.json` to `.vscode/launch.json`.
2. Copy `extension/dev/tasks.example.json` to `.vscode/tasks.json`.
3. Open the repository root in Cursor or VS Code.
4. Run the `Run Symphony Extension` launch configuration.
5. Use the Command Palette action `Symphony: Open Panel`.

Start Symphony separately with the status server listening on the configured base URL. With Symphony stopped, the panel should show `offline`; with a malformed base URL, it should show `error`.

## Scope

This extension includes the webview shell, connection status, read-only active session cards, operator queue cards, workspace/open-workspace affordances, board counts, disabled planning/orchestrator/chat placeholders, activity feed, settings, scripts, docs, and unit tests. Transcript views, issue drill-down, and broader operator mutation controls are intentionally deferred.

## Validation Matrix

- Happy path: connected state renders health, active sessions, workspace rows, board counts, activity, disabled Planning / Orchestrator / Chat placeholders, and enabled open-workspace buttons when mutation policy and token allow it.
- Offline/error: failed state probes render retry/settings only and skip dashboard section reads and mutation controls.
- Partial failure: board, workspace, or activity failures degrade their own section while the connected dashboard remains usable.
- Token/security: public GET reads omit `X-Symphony-Token`; only `open-workspace` POST sends it, and disabled buttons do not post webview messages.
- Idempotent refresh: rapid retries and polling suppress stale dashboard generations and keep one polling timer across sidebar/fallback surfaces.

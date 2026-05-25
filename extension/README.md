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

The extension validates connectivity with `GET /api/v1/state`. When connected, it also renders read-only dashboard sections from `operatorView`, `GET /api/v1/board`, and `GET /api/v1/activity?offset=0&limit=20`. Read-only requests do not send `symphony.token`.

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

This extension includes the webview shell, connection status, read-only operator queue cards, board counts, activity feed, settings, scripts, docs, and unit tests. Transcript views, issue drill-down, and operator mutation controls are intentionally deferred.

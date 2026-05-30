# CI

The `CI` GitHub Actions workflow runs on pull requests and pushes to `main`.

Default validation uses the repository lockfile and does not need live service credentials:

- Install with `npm ci`.
- Typecheck with `npm run typecheck`.
- Test with `npm test`.
- Install the web app dependencies with `npm ci --prefix web`.
- Typecheck the web app with `npm run typecheck --prefix web`.
- Test the web app with `npm test --prefix web`.
- Build the web app with `npm run build --prefix web`.
- Run the web browser/Vite proxy smoke with `npm run smoke:browser --prefix web`.
- Run the web production serving browser smoke with `npm run smoke:browser-production --prefix web`.
- Install extension dependencies with `npm run extension:ci`.
- Typecheck the extension with `npm run extension:typecheck`.
- Test the extension with `npm run extension:test`.
- Build the extension with `npm run extension:build`.

Local contributors should use Node `22.12` or newer on the Node 22 line, then run the same commands from the repository root.

## Extension Package

The Cursor extension under `extension/` has its own lockfile and install step. `npm run extension:ci` runs `npm ci --prefix extension`; extension tests are unit tests with mocked HTTP and do not launch Cursor.

## Web Browser Smoke

`npm run smoke:browser --prefix web` starts a fake local Symphony web API, starts the Vite development server in `VITE_SYMPHONY_DATA_SOURCE=api` mode, points the `/api` dev proxy at the fake API with `SYMPHONY_WEB_API_PROXY_TARGET`, and launches a headless Chromium-compatible browser. The smoke fails if the browser renders mock data, if any required web API endpoint is not observed through the Vite proxy, or if API-mode dashboard, issue-detail, history transcript, sidebar summary, and dedicated orchestrator-chat guard markers do not appear.

`npm run smoke:browser-production --prefix web` reuses the same browser/API assertions against the built `web/dist` artifact served under `/web/` with same-origin `/api/v1/web/*` routes. Run `npm run build --prefix web` first. The production smoke also asserts that `/web/` and deep links return the built React shell with `/web/assets/*` URLs, built assets are cacheable, missing asset-like paths return static JSON 404s, and the browser still loads API-mode data without a Vite dev proxy.

The smoke needs a Chromium-compatible executable. CI runners provide Chrome; local runs can override discovery with `SYMPHONY_WEB_BROWSER_EXECUTABLE` or `CHROME_BIN`.

## Optional Real Smoke

The hosted Linear smoke test is opt-in. Run the workflow manually with the `real_smoke` input enabled after configuring these repository secrets:

- `LINEAR_API_KEY`
- `LINEAR_PROJECT_SLUG`

The manual job sets `SYMPHONY_REAL_SMOKE=1` and runs only `tests/real-smoke.test.ts`. Normal pull request and push CI set `SYMPHONY_REAL_SMOKE=0`, so live smoke tests remain skipped.

`npm run smoke:hermes-local` remains a local operator check because it requires local Hermes installation, Hermes-owned OpenAI Codex auth, Python dependencies, and the reference Hermes `gpt-5.5` model to be available to the authenticated provider. It is not run by the hosted CI workflow.

`npm run smoke:hermes-acp` is also local/operator-only. It requires a host `hermes` binary with ACP support and a source profile that can be cloned. The script first runs live host ACP doctor checks against disposable clones, then optionally sends a tiny prompt through `HermesAcpHarness`; it verifies that the active host profile is unchanged before and after the run. Use `--doctor-only` for clone/ACP readiness without an LLM prompt.

`npm run smoke:sdk-local` remains available for Cursor-provider checks, but Cursor is no longer the default dogfood runtime.

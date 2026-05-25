# CI

The `CI` GitHub Actions workflow runs on pull requests and pushes to `main`.

Default validation uses the repository lockfile and does not need live service credentials:

- Install with `npm ci`.
- Typecheck with `npm run typecheck`.
- Test with `npm test`.
- Install extension dependencies with `npm run extension:ci`.
- Typecheck the extension with `npm run extension:typecheck`.
- Test the extension with `npm run extension:test`.
- Build the extension with `npm run extension:build`.

Local contributors should use Node `22.12` or newer on the Node 22 line, then run the same commands from the repository root.

## Extension Package

The Cursor extension under `extension/` has its own lockfile and install step. `npm run extension:ci` runs `npm ci --prefix extension`; extension tests are unit tests with mocked HTTP and do not launch Cursor.

## Optional Real Smoke

The real Cursor and Linear smoke tests are opt-in. Run the workflow manually with the `real_smoke` input enabled after configuring these repository secrets:

- `CURSOR_API_KEY`
- `LINEAR_API_KEY`
- `LINEAR_PROJECT_SLUG`

The manual job sets `SYMPHONY_REAL_SMOKE=1` and runs only `tests/real-smoke.test.ts`. Normal pull request and push CI set `SYMPHONY_REAL_SMOKE=0`, so live smoke tests remain skipped.

`npm run smoke:sdk-local` remains a local operator check because it requires Cursor local runtime setup. It is not run by the hosted CI workflow.

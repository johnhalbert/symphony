# CI

The `CI` GitHub Actions workflow runs on pull requests and pushes to `main`.

Default validation uses the repository lockfile and does not need live service credentials:

- Install with `npm ci`.
- Typecheck with `npm run typecheck`.
- Test with `npm test`.

Local contributors should use Node `22.12` or newer on the Node 22 line, then run the same commands from the repository root.

## Optional Real Smoke

The real Cursor and Linear smoke tests are opt-in. Run the workflow manually with the `real_smoke` input enabled after configuring these repository secrets:

- `CURSOR_API_KEY`
- `LINEAR_API_KEY`
- `LINEAR_PROJECT_SLUG`

The manual job sets `SYMPHONY_REAL_SMOKE=1` and runs only `tests/real-smoke.test.ts`. Normal pull request and push CI set `SYMPHONY_REAL_SMOKE=0`, so live smoke tests remain skipped.

`npm run smoke:sdk-local` remains a local operator check because it requires Cursor local runtime setup. It is not run by the hosted CI workflow.

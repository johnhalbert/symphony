# ENG-243 Final Validation Record (ENG-282)

Captured on `2026-06-06T06:16:51Z` for `specs/001-block-agent-github` on branch `sinfonista/eng-282-eng-24326-final-typecheck-targeted-suite-ci-equivalent`.

## Purpose

Record the final validation gate for Issue 26 / `ENG-282`:

- T065 — root typecheck
- T066 — targeted command-policy validation suite
- T067 — CI-equivalent validation commands
- T068 — vendored Hermes protected-surface no-touch check

Supporting live-run SC-004 dogfood evidence remains in [`docs/smoke/eng-243-sc-004-no-upstream-prompts.md`](./eng-243-sc-004-no-upstream-prompts.md).

## Scenario Matrix Covered

- **Happy path**: every required quickstart command completed successfully.
- **Negative / error path**: the targeted suite re-ran deny, fail-closed, service-boundary, replay, and redaction coverage so a reviewer can see that the final packet still includes non-happy-path enforcement.
- **Adjacent / sibling surfaces**: root, web, extension, audit, replay, projection, redaction, and service-owned GitHub boundary coverage all remained in the final command matrix.
- **Replay / idempotency**: every command below can be rerun from the recorded branch and workspace state; the code-validation commands completed before this evidence capture updated only the expected issue artifacts.
- **Credential / security boundary**: no validation command exposed tokens, SSH keys, or auth state; the existing SC-004 packet remains the live-run prompt evidence source.
- **Protected-surface side effects**: vendored Hermes base diff, worktree diff, and status checks all remained empty.

## T065 — Root Typecheck

```text
$ npm run typecheck
> symphony@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit
# exit 0
```

## T066 — Targeted Command-Policy Suite

These are the five command groups from `specs/001-block-agent-github/quickstart.md`.

| Command group | Result |
| --- | --- |
| `npm test -- tests/agent-command-policy-upstream.test.ts tests/agent-command-policy-disguised.test.ts tests/agent-command-policy-execute-code.test.ts tests/agent-command-policy-local-inspection.test.ts tests/agent-command-policy-git-config.test.ts tests/agent-command-policy-fake-helper.test.ts` | `6` files passed, `176` tests passed, duration `1.53s` |
| `npm test -- tests/agent-command-policy-hook-runner.test.ts tests/agent-command-policy-hook-runner-local.test.ts tests/agent-command-policy-cli.test.ts` | `3` files passed, `50` tests passed, duration `32.90s` |
| `npm test -- tests/agent-command-policy-acp-resolver.test.ts tests/hermes-acp-harness.test.ts tests/hermes-command-policy-profile.test.ts tests/hermes-delegated-command-policy.test.ts tests/hermes-template-policy.test.ts tests/hermes-mcp-config.test.ts` | `6` files passed, `127` tests passed, duration `4.12s` |
| `npm test -- tests/mcp-subprocess-environment-command-policy.test.ts tests/completion-report-mcp-command-policy.test.ts tests/review-feedback-mcp-command-policy.test.ts tests/github-service-boundary-command-policy.test.ts` | `4` files passed, `29` tests passed, duration `1.54s` |
| `npm test -- tests/run-activity-event-command-policy.test.ts tests/transcript-replay-command-policy.test.ts tests/web-transcript-projection-command-policy.test.ts` | `3` files passed, `18` tests passed, duration `931ms` |

Combined targeted result: **22 files passed, 400 tests passed, 0 failures**.

## T067 — CI-Equivalent Validation Commands

These commands match `.github/workflows/ci.yml`.

### Root

```text
$ npm ci
# exit 0
# note: npm emitted only non-failing deprecation/audit warnings

$ npm run typecheck
# exit 0

$ npm test
# exit 0
Test Files  104 passed | 1 skipped (105)
Tests       1447 passed | 5 skipped (1452)
Duration    133.23s
```

### Web

```text
$ npm ci --prefix web
# exit 0

$ npm run typecheck --prefix web
# exit 0

$ npm test --prefix web
# exit 0
Test Files  20 passed (20)
Tests       198 passed (198)

$ npm run build --prefix web
# exit 0
# built web/dist assets via vite build

$ npm run smoke:browser --prefix web
# exit 0
Browser smoke passed: Vite served http://127.0.0.1:5173/ in API mode and proxied 21 API request(s)

$ npm run smoke:browser-production --prefix web
# exit 0
Browser production smoke passed: built assets served with 21 same-origin API request(s)
```

### Extension

```text
$ npm run extension:ci
# exit 0

$ npm run extension:typecheck
# exit 0

$ npm run extension:test
# exit 0
Test Files  10 passed (10)
Tests       47 passed (47)

$ npm run extension:build
# exit 0
# built via node esbuild.mjs
```

## T068 — Vendored Hermes No-Touch Check

```text
$ git status --short --branch
## sinfonista/eng-282-eng-24326-final-typecheck-targeted-suite-ci-equivalent
 M specs/001-block-agent-github/tasks.md
?? docs/smoke/eng-243-final-validation.md

$ git diff --name-only origin/main...HEAD -- hermes/upstream-src
# stdout: <empty>

$ git diff --name-only -- hermes/upstream-src
# stdout: <empty>

$ git status --short -- hermes/upstream-src
# stdout: <empty>
```

Taken together, those commands show:

- no committed vendored-Hermes branch changes relative to `origin/main`
- no uncommitted vendored-Hermes worktree/index changes
- the only final worktree changes are the expected evidence artifacts for this issue: `specs/001-block-agent-github/tasks.md` and `docs/smoke/eng-243-final-validation.md`

## Exceptions

None.

`npm ci` emitted standard deprecation and audit warnings, but every required validation command exited `0` and no promotion-blocking failure occurred.

## Reviewer Pointers

- Final validation command source: `specs/001-block-agent-github/quickstart.md`
- CI-equivalent command source: `.github/workflows/ci.yml`
- Existing live-run SC-004 packet: `docs/smoke/eng-243-sc-004-no-upstream-prompts.md`

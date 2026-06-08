# ENG-347 Final Validation Record

Captured on `2026-06-08T20:40:32Z` for `specs/003-multi-project-config` on branch `sinfonista/eng-347-implement-multi-project-configuration`.

## Purpose

Record the current ENG-347 validation and promotion packet for:

- T095 — focused configuration / doctor validation
- T096 — focused orchestration / workspace validation
- T097 — focused MCP / harness validation
- T098 — focused web / projection validation
- T099 — focused database validation
- T100 — full repository validation
- T101 — TypeScript validation
- T102 — quickstart scenario coverage
- T103 — redaction audit
- T104 — vendored Hermes upstream diff check
- T105 — promotion notes and remaining risks

## Scenario Matrix Covered

- **Happy path:** context-aware routing, transition-policy propagation, MCP handoff propagation, durable projection rebuilds, and durable dashboard/sidebar/history route reads all passed on the current head.
- **Negative / error path:** ambiguous project-context routing still fails closed; durable dashboard/sidebar rebuilds and durable route reads now keep empty live runtime snapshots authoritative instead of rehydrating lifecycle-only `runningAgents` / `agentUsageLabel` data from persisted runs.
- **Boundary / integration:** validated HTTP/status API, durable web projection readers/rebuilders, transition policy, completion-report approval writeback scoping, MCP boundaries, workspace/orchestrator routing, and Postgres schema coverage.
- **Persistence / durability:** durable dashboard/sidebar/history records continue to serve stored payloads and source cursors while overlaying only runtime-authoritative liveness fields; publication-approval setup drains remain scoped to the report writeback identities instead of sibling outbox entries.
- **Idempotency / replay / repeated-operation behavior:** covered by the passing transition-policy, linear-multi-project, completion-report-service targeted regression, writeback-outbox, completion-report MCP, review-verdict MCP, and review-feedback MCP suites.
- **Security / redaction:** the token-pattern scan below returned no matches, and the passing web/status suites continue to cover redacted operator-facing payload behavior.
- **Intentionally unverified:** no live Linear + GitHub end-to-end multi-context publication/replay flow was exercised; the current Windows Node 22 host still blocks sqlite-backed doctor/smoke surfaces and unrelated CLI-policy full-suite failures remain outside this durable web repair.

## T095 — Focused Configuration / Doctor Validation

```text
$ npm test -- tests/workflow.test.ts tests/doctor.test.ts
Test Files  1 failed | 1 passed (2)
Tests       40 passed (40)
Duration    1.67s
Failure     tests/doctor.test.ts could not locate the sqlite3 native binding for `node-v127-win32-x64/node_sqlite3.node` on this Windows Node 22 host.
```

`tests/workflow.test.ts` remained green, but the doctor surface is currently blocked on this host by the missing sqlite3 native binding before the doctor tests can execute.

## T096 — Focused Orchestration / Workspace Validation

```text
$ npm test -- tests/orchestrator.test.ts tests/git-worktree.test.ts tests/writeback-outbox.test.ts
Test Files  3 passed (3)
Tests       142 passed (142)
Duration    19.48s
```

This covers the routing / workspace / writeback isolation surfaces that remain load-bearing for multi-project activity.

## T097 — Focused MCP / Harness Validation

```text
$ npm test -- tests/completion-report-mcp.test.ts tests/review-verdict-mcp.test.ts tests/review-feedback-mcp.test.ts tests/mcp-subprocess-environment.test.ts tests/cursor-harness.test.ts tests/hermes-harness.test.ts tests/hermes-acp-harness.test.ts
Test Files  7 passed (7)
Tests       146 passed (146)
Duration    7.15s
```

This revalidates completion-report / review MCP boundaries and the harness surfaces touched by the multi-project handoff propagation work.

## T098 — Focused Web / Projection Validation

```text
$ npm test -- tests/status-api.test.ts tests/web-projection.test.ts tests/web-history-projection.test.ts tests/web-transcript-projection.test.ts tests/web-route-contract.test.ts tests/web-projection-context.test.ts tests/web-history-transcript-durable-projection.test.ts tests/web-issue-detail.test.ts
Test Files  8 passed (8)
Tests       145 passed (145)
Duration    10.98s
```

Focused follow-up fixes on the current head:

- Durable dashboard and sidebar route hits now stay runtime-authoritative when the live runtime snapshot is empty, so they omit lifecycle-only `runningAgents` / `agentUsageLabel` data instead of replaying stale durable run rows.
- Durable dashboard/sidebar rebuilds and `?refresh=1` writes now preserve empty live snapshots as authoritative instead of coercing them to `null` and falling back to durable running rows.
- Durable history route hits still apply runtime liveness overlay without rebuilding the broad source index.
- The broader web/projection sweep that the reviewer requested is now green on the final tip.

## T099 — Focused Database Validation

```text
$ npm test -- tests/postgres-schema.test.ts
Test Files  1 passed (1)
Tests       14 passed | 2 skipped (16)
Duration    437ms
```

This covers the project-context attribution schema surface.

## T100 — Full Repository Validation

```text
$ npm test
Test Files  6 failed | 101 passed (107)
Tests       15 failed | 1409 passed | 2 skipped (1426)
Errors      1 error
Duration    129.65s
Remaining failures:
- tests/agent-command-policy-cli.test.ts (15 CLI exit-code failures plus an unhandled `write EOF`)
- tests/doctor.test.ts
- tests/github-app-installation-token-provider.test.ts
- tests/harness-factory.test.ts
- tests/mcp-tool-exposure-probe.test.ts
- tests/real-smoke.test.ts
Shared blocker for the five import-failure suites above: missing sqlite3 native binding (`node-v127-win32-x64/node_sqlite3.node`) on this Windows Node 22 host.
```

The current full-suite failures are outside the durable web projection repair itself. The earlier full-suite `CompletionReportService` regression is no longer present after the targeted report-writeback stub update documented below.

## T101 — TypeScript Validation

```text
$ npm run typecheck
> tsc -p tsconfig.json --noEmit
# exit 0
```

## Reviewer-finding and adjacent-invariant follow-up

```text
$ npm test -- tests/transition-policy.test.ts tests/linear-multi-project.test.ts tests/status-api.test.ts tests/workflow.test.ts
Test Files  4 passed (4)
Tests       93 passed (93)
Duration    8.29s

$ npm test -- tests/completion-report-service.test.ts
Test Files  1 passed (1)
Tests       19 passed (19)
Duration    796ms
```

This follow-up revalidated the reviewer-reported behavior gaps and the adjacent approval-writeback scoping invariant on the current head:

- `tests/transition-policy.test.ts` plus `tests/linear-multi-project.test.ts` still prove context-specific writeback / review / merge-policy overrides flow through completion, review-pass/fail, blocked escalation, and merge repair planning.
- `tests/status-api.test.ts` plus the focused T098 sweep now prove durable dashboard/sidebar/history readers and rebuilds remain runtime-authoritative when the live snapshot is empty.
- `tests/completion-report-service.test.ts` now proves publication-approval setup drains use the report-scoped writeback identities (`operations` + `projectContextId`) without consuming unrelated sibling outbox keys.

## T102 — Quickstart Scenario Coverage

```text
$ npm test -- tests/workflow.test.ts tests/doctor.test.ts tests/orchestrator.test.ts tests/git-worktree.test.ts tests/status-api.test.ts tests/web-projection.test.ts tests/web-history-projection.test.ts tests/web-transcript-projection.test.ts tests/web-route-contract.test.ts tests/web-projection-context.test.ts tests/completion-report-mcp.test.ts tests/review-verdict-mcp.test.ts tests/review-feedback-mcp.test.ts tests/writeback-outbox.test.ts tests/postgres-schema.test.ts tests/mcp-subprocess-environment.test.ts tests/cursor-harness.test.ts tests/hermes-harness.test.ts tests/hermes-acp-harness.test.ts
Test Files  1 failed | 18 passed (19)
Tests       468 passed | 2 skipped (470)
Duration    35.74s
Failure     tests/doctor.test.ts could not locate the sqlite3 native binding for `node-v127-win32-x64/node_sqlite3.node` on this Windows Node 22 host.
```

Scenario mapping remains the same as the quickstart, but the aggregated current-host run is blocked only by the doctor/sqlite surface; every non-doctor slice in the documented aggregate command passed on the final tip.

## T103 — Redaction Audit

Production-code/docs token-pattern scan:

```text
$ rg -n --hidden --glob '!**/node_modules/**' --glob '!**/dist/**' --glob '!**/.git/**' '(ghp_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{20,}|gho_[A-Za-z0-9]{8,}|ghu_[A-Za-z0-9]{8,}|ghs_[A-Za-z0-9]{8,}|sk-[A-Za-z0-9]{8,}|-----BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY-----)' src/core/orchestrator/Orchestrator.ts src/core/harness src/app docs
# stdout: <empty>
# exit 1 (no matches)
```

Additional redaction coverage came from the passing `tests/status-api.test.ts`, `tests/web-route-contract.test.ts`, and `tests/web-issue-detail.test.ts` suites.

## T104 — Vendored Hermes Upstream Diff Check

```text
$ git diff --name-only origin/main...HEAD -- hermes/upstream-src
# stdout: <empty>

$ git diff --name-only -- hermes/upstream-src
# stdout: <empty>

$ git status --short -- hermes/upstream-src
# stdout: <empty>
```

These commands show no committed or worktree-local changes under `hermes/upstream-src/**`.

## Issue-Contract / Governance Audit

Repo-local reviewer-verifiable governance closure lives in `docs/smoke/eng-347-governance-ledger.md`.

- `WORKFLOW.md:29-35` remains the governing rule that worker/reviewer runs must treat a fenced JSON `Issue Contract` as authoritative.
- `specs/003-multi-project-config/tasks.md:9` remains the governing rule that every split child issue retains that fenced JSON contract shape.
- The governance ledger mirrors the authoritative ENG-347 feature contract (`contractVersion` `2026-06-07.1` with `REQ-FEATURE-001` / `REQ-FEATURE-002`), records the refreshed repo-visible child ref table for `ENG-348`, `ENG-349`, and `ENG-356` through `ENG-364`, and keeps the repo-local closure proof self-contained.
- A current parse of the ledger's fenced JSON mirrors still returns 12 valid `schemaVersion=1` blocks with non-empty unique requirement ids.

## T105 — Promotion Notes / Remaining Risks

Promotion notes remain in `specs/003-multi-project-config/quickstart.md` and point back to this validation record and the governance ledger.

Remaining risks:

1. **Current full-repo validation is still red on this Windows host.** `npm test` now fails only six suites, but the remaining blockers are outside the durable web repair: five sqlite-import failures plus `tests/agent-command-policy-cli.test.ts`.
2. **No live multi-backend publication replay.** Validation covered local/unit/integration boundaries only; it did not run a live Linear + GitHub end-to-end multi-context publication/replay flow.
3. **Governance closure remains repo-local by design.** Reviewer verification is now self-contained in the worktree, but the child-issue contract evidence remains mirrored locally because external Linear issue bodies are outside this review surface.

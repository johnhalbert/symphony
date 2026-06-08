# ENG-347 Final Validation Record

Captured on `2026-06-08T12:44:00Z` for `specs/003-multi-project-config` on branch `sinfonista/eng-347-implement-multi-project-configuration`.

Reviewer-finding follow-up updated on `2026-06-08T17:04:19Z` after the final governance ledger and focused regression sweep below were added.

## Purpose

Record the ENG-347 final validation gate and promotion packet for:

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

- **Happy path:** `/api/v1/activity?projectContextId=<id>` now returns only matching run, transcript, and writeback items even without an `issue` query; durable dashboard/history/sidebar hits round-trip stored payloads without live-route mutation.
- **Negative / error path:** mixed-context activity is excluded from project-context-only filters; durable-hit routes no longer overwrite stored read models with empty live snapshots; merge-policy transition expectations now include the multi-project `projectContextId` contract.
- **Boundary / integration:** validated HTTP/status API, web projections, durable projection rebuilds, merge-policy transition writeback expectations, issue-detail projection fields, MCP handoff suites, and Postgres schema coverage.
- **Persistence / durability:** covered durable dashboard/history/sidebar projection reads and rebuilds, durable activity counts, and project-context-aware writeback / transition propagation.
- **Idempotency / replay / repeated-operation behavior:** covered by the passing merge-policy, writeback-outbox, review-verdict/review-feedback MCP, and full-repo regression suites.
- **Security / redaction:** status/web route suites plus the explicit token-pattern audit below verified that operator-facing payloads and docs do not expose token-shaped secrets.
- **Intentionally unverified:** no live Linear/GitHub end-to-end multi-context publication/replay flow was exercised; authoritative external Linear child-issue state remains outside the worktree.

## T095 — Focused Configuration / Doctor Validation

```text
$ npm test -- tests/workflow.test.ts tests/doctor.test.ts
Test Files  2 passed (2)
Tests       77 passed (77)
Duration    4.40s
```

This covers quickstart Scenarios 1 and 2 for legacy-single-project compatibility, multi-context loading, normalization, and validation behavior.

## T096 — Focused Orchestration / Workspace Validation

```text
$ npm test -- tests/orchestrator.test.ts tests/git-worktree.test.ts tests/writeback-outbox.test.ts
Test Files  3 passed (3)
Tests       139 passed (139)
Duration    33.01s
```

This covers quickstart Scenarios 3 and 4 for deterministic routing, safe ambiguity handling, and concurrent project activity/workspace isolation.

## T097 — Focused MCP / Harness Validation

```text
$ npm test -- tests/completion-report-mcp.test.ts tests/review-verdict-mcp.test.ts tests/review-feedback-mcp.test.ts tests/mcp-subprocess-environment.test.ts tests/cursor-harness.test.ts tests/hermes-harness.test.ts tests/hermes-acp-harness.test.ts
Test Files  7 passed (7)
Tests       144 passed (144)
Duration    12.51s
```

This revalidates completion-report/review MCP boundaries and the harness surfaces touched by the multi-project handoff propagation work.

## T098 — Focused Web / Projection Validation

```text
$ npm test -- tests/status-api.test.ts tests/web-projection.test.ts tests/web-history-projection.test.ts tests/web-transcript-projection.test.ts tests/web-route-contract.test.ts tests/web-projection-context.test.ts
Test Files  6 passed (6)
Tests       125 passed (125)
Duration    9.53s
```

Focused follow-up fixes included:

- `/api/v1/activity` now honors `projectContextId` even when `issue` is omitted.
- Durable dashboard/history/sidebar route hits return stored read models unchanged.
- Dashboard/sidebar rebuilds still fall back to durable running-agent rows when the live snapshot is empty/non-authoritative.
- Web issue-detail and merge-policy expectations now reflect the multi-project projection/writeback contract.

## T099 — Focused Database Validation

```text
$ npm test -- tests/postgres-schema.test.ts
Test Files  1 passed (1)
Tests       14 passed | 2 skipped (16)
Duration    435ms
```

This covers quickstart Scenario 6 for context-attributed schema changes.

## T100 — Full Repository Validation

```text
$ npm test
Test Files  105 passed | 1 skipped (106)
Tests       1475 passed | 5 skipped (1480)
Duration    145.47s
```

## T101 — TypeScript Validation

```text
$ npm run typecheck
> tsc -p tsconfig.json --noEmit
# exit 0
```

## Reviewer-finding follow-up (2026-06-08T17:04:19Z)

```text
$ npm test -- tests/transition-policy.test.ts tests/linear-multi-project.test.ts tests/status-api.test.ts tests/workflow.test.ts
Test Files  4 passed (4)
Tests       92 passed (92)
Duration    8.75s

$ npm run typecheck
> tsc -p tsconfig.json --noEmit
# exit 0
```

This follow-up revalidated the two reviewer-reported behavior gaps and the new repo-local governance closure:

- `tests/status-api.test.ts` now proves `/api/v1/web/history?projectContextId=...` preserves legacy inferred writebacks in the matching project's durable timeline while still marking orphaned running sessions as `not_live` in the session summary.
- `tests/transition-policy.test.ts` plus `tests/linear-multi-project.test.ts` now prove context-specific writeback / review / merge-policy overrides flow through completion, review-pass/fail, blocked escalation, and merge-repair planners.
- `docs/smoke/eng-347-governance-ledger.md` now supplies the reviewer-requested fenced JSON feature contract mirror, child-issue inventory/order/completion ledger, child issue-contract mirrors, and explicit FR/SC proof ledger.

## T102 — Quickstart Scenario Coverage

Quickstart scenario coverage was executed via the documented focused commands above and the documented full-validation command below.

```text
$ npm test -- tests/workflow.test.ts tests/doctor.test.ts tests/orchestrator.test.ts tests/git-worktree.test.ts tests/status-api.test.ts tests/web-projection.test.ts tests/web-history-projection.test.ts tests/web-transcript-projection.test.ts tests/web-route-contract.test.ts tests/web-projection-context.test.ts tests/completion-report-mcp.test.ts tests/review-verdict-mcp.test.ts tests/review-feedback-mcp.test.ts tests/writeback-outbox.test.ts tests/postgres-schema.test.ts tests/mcp-subprocess-environment.test.ts tests/cursor-harness.test.ts tests/hermes-harness.test.ts tests/hermes-acp-harness.test.ts
Test Files  19 passed (19)
Tests       499 passed | 2 skipped (501)
Duration    34.82s
```

Scenario mapping:

- **Scenarios 1-2:** `tests/workflow.test.ts`, `tests/doctor.test.ts`
- **Scenario 3:** `tests/orchestrator.test.ts`, `tests/git-worktree.test.ts`, `tests/writeback-outbox.test.ts`
- **Scenario 4:** `tests/orchestrator.test.ts`, `tests/status-api.test.ts`
- **Scenario 5:** `tests/status-api.test.ts`, `tests/web-projection.test.ts`, `tests/web-history-projection.test.ts`, `tests/web-transcript-projection.test.ts`, `tests/web-route-contract.test.ts`, `tests/web-projection-context.test.ts`
- **Scenario 6:** `tests/postgres-schema.test.ts`

## T103 — Redaction Audit

Production-code/docs token-pattern scan:

```text
$ rg -n --hidden --glob '!**/node_modules/**' --glob '!**/dist/**' --glob '!**/.git/**' '(ghp_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{20,}|gho_[A-Za-z0-9]{8,}|ghu_[A-Za-z0-9]{8,}|ghs_[A-Za-z0-9]{8,}|sk-[A-Za-z0-9]{8,}|-----BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY-----)' src/core/orchestrator/Orchestrator.ts src/core/harness src/app docs
# stdout: <empty>
# exit 1 (no matches)
```

Additional redaction coverage came from the passing `tests/status-api.test.ts`, `tests/web-route-contract.test.ts`, `tests/web-issue-detail.test.ts`, and `tests/web-orchestrator-chat-api.test.ts` suites, which assert redacted transcript/writeback/operator-facing payload behavior.

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

Repo-local reviewer-verifiable governance closure now lives in `docs/smoke/eng-347-governance-ledger.md`.

- `WORKFLOW.md:29-35` remains the governing rule that worker/reviewer runs must treat a fenced JSON `Issue Contract` as authoritative.
- `specs/003-multi-project-config/tasks.md:9` remains the governing rule that every split child issue retains that fenced JSON contract shape.
- `docs/smoke/eng-347-governance-ledger.md` now mirrors the authoritative ENG-347 feature contract exactly (`contractVersion` `2026-06-07.1` with the original `REQ-FEATURE-001` / `REQ-FEATURE-002` texts), records the complete repo-visible child-issue inventory/order/completion ledger for `ENG-348`, `ENG-349`, and `ENG-356` through `ENG-364`, and explains that the remaining Phase 3-8 tasks stayed parent-scoped on `ENG-347` rather than separate child refs.
- The same ledger now re-verifies the current local/origin child refs and maps `FR-001` through `FR-025` and `SC-001` through `SC-009` to current repo-local code, tests, docs, and validation artifacts so the reviewer can verify closure from the worktree alone.

## T105 — Promotion Notes / Remaining Risks

Promotion notes have been appended to `specs/003-multi-project-config/quickstart.md` and point back to this validation record and the governance ledger.

Remaining risks:

1. **No live multi-backend publication replay.** Validation covered local/unit/integration boundaries only; it did not run a live Linear + GitHub end-to-end multi-context publication/replay flow.
2. **History summary vs durable timeline semantics remain intentionally distinct.** `/api/v1/web/history` still marks orphaned running sessions as `not_live` in the session summary even when the durable timeline's latest project-matching event is a writeback operation; the focused regression confirms that distinction is stable and that the timeline preserves the project-scoped legacy writeback event.
3. **Governance ledger depends on repo-local mirrors rather than external Linear issue bodies.** Reviewer verification is now self-contained in the worktree, but the child-issue contract evidence is intentionally preserved as repo-local mirrors because the external Linear issue bodies are outside this review surface.

# ENG-455 T100 Full Repository Validation

Captured on `2026-07-07T07:12:03Z` for branch `sinfonista/eng-455-t100-run-full-repository-validation`.

## Purpose

Record the full-repository validation required by ENG-455 / `REQ-T100`:

- confirm focused validation evidence exists before the final full-suite run
- run `npm test` from the repository root using the `package.json` `test` script
- capture durable evidence that the full repository suite passes in the assigned ENG-455 worktree

## Focused Validation Evidence Available Before `npm test`

`specs/003-multi-project-config/tasks.md:207-212` sequences the validation work as focused packets `T095` through `T099` before `T100` runs the full repository suite.

Durable focused-validation evidence already present in this worktree before the full-suite run:

- `docs/smoke/eng-450-t095-focused-config-doctor-validation.md` — records a passing `npm test -- tests/workflow.test.ts tests/doctor.test.ts` run for focused workflow/doctor coverage.
- `docs/smoke/eng-451-t096-focused-orchestration-workspace-writeback-validation.md` — records a passing `npm test -- tests/orchestrator.test.ts tests/git-worktree.test.ts tests/writeback-outbox.test.ts` run for focused orchestration/worktree/writeback coverage.
- `docs/smoke/eng-452-t097-focused-mcp-and-harness-validation.md` — records a passing focused MCP/harness packet for completion-report, review-verdict, review-feedback, subprocess-environment, Cursor, Hermes, and Hermes ACP coverage.
- `docs/smoke/eng-453-t098-focused-web-and-projection-validation.md` — records a passing focused status/web/projection packet.

No standalone `ENG-454` / `T099` smoke artifact was present in this worktree, so the focused database validation command from `specs/003-multi-project-config/tasks.md:211` was rerun immediately before the full-suite command in this ENG-455 worktree to satisfy the required sequencing.

## Scenario Matrix Covered

- **Prerequisite / sequencing path**: focused validation evidence existed before `npm test`, with the missing focused database packet rerun immediately before the full-suite command.
- **Happy path / repository validation**: the repository-wide `package.json` `test` script completed successfully in the assigned worktree.
- **Integration breadth**: the passing suite covered orchestration, worktrees, writeback, MCP handoff, harnesses, status API, realtime APIs, web projections, migrations, command-policy enforcement, and transcript/projection durability surfaces together.
- **Negative / guard behavior**: the passing full suite still exercised fail-closed and rejection paths such as provider-limit gates, ambiguous route handling, MCP context mismatch rejection, dirty-worktree protection, and credential/redaction enforcement.
- **Durability / replay coverage**: the same run passed transcript-store, transcript-replay, completion-report, realtime publication, and durable projection tests alongside the broader repository packet.

## Validation Commands

### Focused database prerequisite (`T099` packet rerun)

```text
$ npm test -- tests/postgres-schema.test.ts
> symphony@0.1.0 test
> vitest run --no-file-parallelism tests/postgres-schema.test.ts

RUN  v4.1.5 C:/Users/john/src/github.com/johnhalbert/symphony/symphony_workspaces/ENG-455

✓ tests/postgres-schema.test.ts (18 tests | 2 skipped) 95ms

Test Files  1 passed (1)
Tests       16 passed | 2 skipped (18)
Duration    515ms
# exit 0
```

### Full repository validation (`REQ-T100`)

```text
$ npm test
> symphony@0.1.0 test
> vitest run --no-file-parallelism

RUN  v4.1.5 C:/Users/john/src/github.com/johnhalbert/symphony/symphony_workspaces/ENG-455

Representative passing suites from the full repository run:
- ✓ tests/orchestrator.test.ts (126 tests) 21717ms
- ✓ tests/status-api.test.ts (70 tests) 9930ms
- ✓ tests/realtime-api.test.ts (24 tests) 23011ms
- ✓ tests/git-worktree.test.ts (18 tests) 8473ms
- ✓ tests/completion-report-mcp.test.ts (17 tests) 1912ms
- ✓ tests/review-verdict-mcp.test.ts (4 tests) 145ms
- ✓ tests/review-feedback-mcp.test.ts (5 tests) 163ms
- ✓ tests/postgres-schema.test.ts (18 tests | 2 skipped) 77ms
- ✓ tests/agent-command-policy-cli.test.ts (15 tests) 32597ms
- ↓ tests/real-smoke.test.ts (3 tests | 3 skipped)

Test Files  112 passed | 1 skipped (113)
Tests       1883 passed | 5 skipped (1888)
Start at    02:08:43
Duration    176.34s
# exit 0
```

## Review Repair Refresh (`2026-07-07T15:27:53Z`)

The blocked reviewer verdict was tied to an older PR head (`50900cd400625aae31978cc221413b31ac22847a`) that was behind `origin/main` in the reviewer workspace. On the current service-owned merge-conflict-prep head `b1770088572318f1b113c64c1fe3c316952b1799`, the base-ref blocker is resolved:

- `git rev-list --left-right --count HEAD...origin/main` → `1 0`
- `git merge-base --is-ancestor origin/main HEAD` exited `0`

After confirming the branch now contains the latest `origin/main`, the required validation commands were rerun at the current PR head:

```text
$ npm test -- tests/postgres-schema.test.ts
> symphony@0.1.0 test
> vitest run --no-file-parallelism tests/postgres-schema.test.ts

RUN  v4.1.5 C:/Users/john/src/github.com/johnhalbert/symphony/symphony_workspaces/ENG-455

✓ tests/postgres-schema.test.ts (18 tests | 2 skipped) 62ms

Test Files  1 passed (1)
Tests       16 passed | 2 skipped (18)
Duration    555ms
# exit 0
```

```text
$ npm test
> symphony@0.1.0 test
> vitest run --no-file-parallelism

RUN  v4.1.5 C:/Users/john/src/github.com/johnhalbert/symphony/symphony_workspaces/ENG-455

Representative passing suites from the refreshed full repository run:
- ✓ tests/agent-command-policy-cli.test.ts (15 tests) 37234ms
- ✓ tests/realtime-api.test.ts (24 tests) 23036ms
- ✓ tests/orchestrator.test.ts (126 tests) 22184ms
- ✓ tests/status-api.test.ts (70 tests) 10131ms
- ✓ tests/git-worktree.test.ts (18 tests) 8976ms
- ✓ tests/postgres-schema.test.ts (18 tests | 2 skipped) 59ms
- ↓ tests/real-smoke.test.ts (3 tests | 3 skipped)

Test Files  112 passed | 1 skipped (113)
Tests       1883 passed | 5 skipped (1888)
Start at    10:24:37
Duration    188.95s
# exit 0
```

## Reviewer Notes

- This issue is validation-only. No production code changes were required; this document is the durable evidence artifact for the required full-repository validation run.
- The repository root `package.json` defines `"test": "vitest run --no-file-parallelism"`, so the recorded `npm test` command exercised the full repository suite through the canonical project script.
- `specs/003-multi-project-config/quickstart.md:81-87` also distinguishes the final full-validation step from the earlier focused scenario packets, matching the sequence used here.

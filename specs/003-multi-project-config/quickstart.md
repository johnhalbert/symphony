# Quickstart: Multi-Project Configuration

## Prerequisites

- Node.js dependencies installed.
- A valid single-project workflow still loads before the feature work starts.
- Test credentials remain referenced through environment variables or credential profiles, not literal secrets.

## Scenario 1: Existing single-project workflow remains valid

1. Use the current `WORKFLOW.md` with no `project_contexts` block.
2. Run:

   ```powershell
   npm test -- tests/workflow.test.ts tests/doctor.test.ts
   ```

3. Confirm the parsed configuration contains one default/legacy project context.
4. Confirm existing tracker, workspace, GitHub, review-loop, issue-breakdown, and credential behavior is unchanged.

## Scenario 2: Multiple contexts load and validate

1. Create a test workflow with at least three contexts:
   - two different Linear project slugs
   - two different codebase sources
   - one intentional shared codebase or shared Linear project case
2. Run targeted config tests:

   ```powershell
   npm test -- tests/workflow.test.ts tests/doctor.test.ts
   ```

3. Confirm all context ids are visible in validation output and duplicate/missing context errors identify the affected context.

## Scenario 3: Issue routing is deterministic

1. Use tracker fixtures or test doubles with two Linear projects that both contain an issue identifier such as `ENG-123`.
2. Run:

   ```powershell
   npm test -- tests/orchestrator.test.ts tests/git-worktree.test.ts tests/writeback-outbox.test.ts
   ```

3. Confirm each issue resolves to exactly one context before workspace creation or writeback.
4. Confirm ambiguous routing records a safe problem and does not dispatch work.

## Scenario 4: Concurrent project activity remains isolated

1. Configure two healthy contexts with active worker or reviewer candidates.
2. Run:

   ```powershell
   npm test -- tests/orchestrator.test.ts tests/status-api.test.ts
   ```

3. Confirm both contexts can have active runs in the same service cycle.
4. Confirm workspace keys, run records, transcripts, approvals, and writebacks do not collide.

## Scenario 5: Operator views show project attribution

1. Seed runs, lifecycle records, workspaces, and transcript events for two contexts with overlapping issue identifiers.
2. Run:

   ```powershell
   npm test -- tests/web-projection.test.ts tests/web-history-projection.test.ts tests/web-transcript-projection.test.ts tests/web-route-contract.test.ts tests/web-projection-context.test.ts
   ```

3. Confirm board, history, transcript, issue detail, workspace, and approval views display context attribution and support context filtering.

## Scenario 6: Database projections include context attribution

1. Apply migrations in a test database.
2. Run:

   ```powershell
   npm test -- tests/postgres-schema.test.ts
   ```

   To exercise the Docker-backed live migration/application checks in this test file, rerun:

   ```powershell
   $env:SYMPHONY_POSTGRES_SCHEMA_VALIDATE_DOCKER = '1'
   npm test -- tests/postgres-schema.test.ts
   ```

3. Confirm context columns and indexes exist for state and projection records that need collision-safe lookup.

## Full Validation

After the implementation tasks complete, run:

```powershell
npm test -- tests/workflow.test.ts tests/doctor.test.ts tests/orchestrator.test.ts tests/git-worktree.test.ts tests/status-api.test.ts tests/web-projection.test.ts tests/web-history-projection.test.ts tests/web-transcript-projection.test.ts tests/web-route-contract.test.ts tests/web-projection-context.test.ts tests/completion-report-mcp.test.ts tests/review-verdict-mcp.test.ts tests/review-feedback-mcp.test.ts tests/writeback-outbox.test.ts tests/postgres-schema.test.ts tests/mcp-subprocess-environment.test.ts tests/cursor-harness.test.ts tests/hermes-harness.test.ts tests/hermes-acp-harness.test.ts
```

To include the Docker-backed live Postgres migration/application checks in the same sweep, run:

```powershell
$env:SYMPHONY_POSTGRES_SCHEMA_VALIDATE_DOCKER = '1'
npm test -- tests/workflow.test.ts tests/doctor.test.ts tests/orchestrator.test.ts tests/git-worktree.test.ts tests/status-api.test.ts tests/web-projection.test.ts tests/web-history-projection.test.ts tests/web-transcript-projection.test.ts tests/web-route-contract.test.ts tests/web-projection-context.test.ts tests/completion-report-mcp.test.ts tests/review-verdict-mcp.test.ts tests/review-feedback-mcp.test.ts tests/writeback-outbox.test.ts tests/postgres-schema.test.ts tests/mcp-subprocess-environment.test.ts tests/cursor-harness.test.ts tests/hermes-harness.test.ts tests/hermes-acp-harness.test.ts
```

## Validation record (ENG-457 / T102)

Validated on 2026-07-07 in the assigned `ENG-457` worktree.

- Prerequisite check: the current `WORKFLOW.md` still loads as a legacy/single-project workflow with no `project_contexts` block, and all runtime credentials remain referenced through environment variables.
- Scenario 1 / 2 command: `npm test -- tests/workflow.test.ts tests/doctor.test.ts` passed (`111 passed`).
- Scenario 3 command: `npm test -- tests/orchestrator.test.ts tests/git-worktree.test.ts tests/writeback-outbox.test.ts` passed (`210 passed`).
- Scenario 4 command: `npm test -- tests/orchestrator.test.ts tests/status-api.test.ts` passed (`196 passed`).
- Scenario 5 command: `npm test -- tests/web-projection.test.ts tests/web-history-projection.test.ts tests/web-transcript-projection.test.ts tests/web-route-contract.test.ts tests/web-projection-context.test.ts` passed (`129 passed`).
- Scenario 6 command: `npm test -- tests/postgres-schema.test.ts` passed with the baseline contract coverage (`16 passed, 2 skipped`). The Docker-backed live migration checks in that file are gated by `SYMPHONY_POSTGRES_SCHEMA_VALIDATE_DOCKER`; rerunning `$env:SYMPHONY_POSTGRES_SCHEMA_VALIDATE_DOCKER = '1'; npm test -- tests/postgres-schema.test.ts` in PowerShell passed the full live matrix (`18 passed`).
- Full validation command: the documented `npm test -- ...` command above passed (`716 passed, 2 skipped`). The PowerShell Docker-enabled full-sweep variant (`$env:SYMPHONY_POSTGRES_SCHEMA_VALIDATE_DOCKER = '1'` followed by the same `npm test -- ...` command) passed with the live Postgres checks included (`718 passed`).

Operator note: the Docker-enabled snippets above use PowerShell-compatible `$env:...` assignment so the commands can be pasted directly into the quickstart shell context.

## Promotion notes (ENG-460 / T105)

Use this summary as the operator-facing promotion packet for the multi-project configuration feature:

- ENG-455 / T100: `docs/smoke/eng-455-t100-full-repository-validation.md` records the prerequisite focused validation sequence plus a passing repository-root `npm test` run (`112 passed | 1 skipped` test files, `1883 passed | 5 skipped` tests).
- ENG-456 / T101: `docs/smoke/eng-456-t101-run-typescript-validation.md` records a passing root `npm run typecheck` invocation (`tsc -p tsconfig.json --noEmit`, exit `0`) with no TypeScript diagnostics.
- ENG-457 / T102: the validation record above confirms the documented quickstart scenarios passed end-to-end, including the full validation sweep (`716 passed, 2 skipped`) and the Docker-enabled Postgres variant (`718 passed`).
- ENG-458 / T103: `src/core/harness/McpToolExposureProbe.ts` and `tests/mcp-tool-exposure-probe.test.ts` verify operator-facing harness diagnostics redact bearer/basic auth values, configured secret values, and common runtime/Linear/GitHub token forms including `sk-...`, `sk_...`, `lin_...`, `ghr_...`, `ghs_...`, and `github_pat_...`.
- ENG-459 / T104: `specs/003-multi-project-config/research.md` records a clean protected-path audit: `git diff --name-only origin/main -- 'hermes/upstream-src'` and `git status --porcelain=v1 --untracked-files=all -- 'hermes/upstream-src'` both returned no output, and the combined guard script reported `RESULT=PASS`.

Remaining risks and promotion blockers:

- Current live dogfood routing still polls and creates worktrees only for the first enabled explicit `project_contexts` entry, so list the primary project first and do not assume one workflow process actively dispatches every configured context yet.
- Treat any operator-facing raw environment value, token, private key material, or credential-bearing repository URL as a stop-promotion redaction regression; do not promote until the leak is fixed and revalidated.
- `dogfood-ready`: **not yet**. These notes collect the required validation evidence, but `docs/dogfood-runbook.md` still requires explicit operator review before applying the label.

## Legacy backfill disposition note (ENG-443 / T088)

Checked-in planning for this legacy/default project-context work lives under `specs/003-multi-project-config/`, even though the ENG-838 issue description points at a non-present `specs/008-eng-443-legacy-backfill-resolution/tasks.md` source path.

Current-base proof run recorded for `ENG-838`:

- Treat `git rev-list --left-right --count HEAD...origin/main` as a live drift check only: this documentation-only branch can gain extra local commits during review repairs, so the exact ahead/behind counts are intentionally not recorded as durable proof; rerun that command locally before any future proof refresh to confirm whether the branch is still behind `origin/main`.
- `git diff --name-status origin/main...HEAD -- src/core/persistence/RunTranscriptStore.ts src/core/workspace/WorkspaceManager.ts src/app/WebHistoryProjection.ts src/app/WebTranscriptProjection.ts src/app/WebProjectionContext.ts tests/transcript-store.test.ts tests/workspace.test.ts tests/web-history-projection.test.ts tests/transcript-replay.test.ts tests/web-transcript-projection.test.ts tests/web-projection-context.test.ts` returned no output on the proof-refresh run, proving PR `#295` itself adds no source/test edits inside the legacy run/workspace backfill proof surface.
- On the proof-refresh run that supported this disposition, `git rev-parse origin/main` resolved to `8cff0aea39e5089607c2f5a56d4a2c29ef188e8e`; the remaining bullets record validations against a disposable snapshot of that exact `origin/main` commit rather than a live worktree-vs-base equality claim.
- `tmp=.tmp-origin-main-proof-$$-$(date +%s) && mkdir "$tmp" && git archive origin/main | tar -x -C "$tmp"` created a disposable snapshot of that pinned `origin/main` commit inside the assigned worktree so the issue-required validations could run without rebasing this documentation-only PR.
- `(cd "$tmp" && npm test -- tests/transcript-store.test.ts tests/transcript-replay.test.ts tests/workspace.test.ts)` passed on that pinned `origin/main` snapshot (`25 passed`).
- `(cd "$tmp" && npm test -- tests/web-history-projection.test.ts tests/web-transcript-projection.test.ts tests/web-projection-context.test.ts)` passed on that pinned `origin/main` snapshot (`47 passed`).
- `(cd "$tmp" && npm test -- tests/status-api.test.ts -t "surfaces legacy/default project context attribution across durable status records")` passed on that pinned `origin/main` snapshot (`1 passed, 30 skipped`), proving the durable status API still backfills legacy/default project context metadata.
- `(cd "$tmp" && npm test -- tests/web-history-transcript-durable-projection.test.ts -t "passes the legacy/default project context id into durable transcript rebuild reads for persisted runs missing projectContext metadata")` passed on that pinned `origin/main` snapshot (`1 passed, 12 skipped`), proving downstream durable transcript rebuilds still scope legacy records to the default context.
- The underlying read-time fallback is still present on that pinned `origin/main` commit in `src/core/persistence/RunTranscriptStore.ts`, where `normalizeWorkspaceRecord(...)` and `normalizeRunRecord(...)` both call `normalizeProjectContextResolution(record.projectContext)`, and `src/core/config/ProjectContexts.ts` still defaults missing project-context metadata to the legacy/default context.

Active PR classification recorded for `ENG-443`:

- On the proof-refresh run, `gh pr view 289 --json files,commits,url,title,headRefName,baseRefName` reported `https://github.com/johnhalbert/symphony/pull/289` with `files: []`, so GitHub showed no net file diff for the active `ENG-443` PR at classification time.
- On the same proof-refresh run, `git merge-base origin/main origin/sinfonista/eng-443-t088-backfill-legacy-run-and-workspace-context-on-read` produced `1a719acc78d7f31178391c042775bd0c534946e2`, and both that merge-base tree and the PR branch tree resolved to `f73a18e97e2765d7f8ed2d54304c87d87115ef10`, proving the PR branch tip was content-identical to its merge base at classification time.

Selected service-owned disposition recorded for that proof run:

- GitHub follow-up target from the proof run: close `https://github.com/johnhalbert/symphony/pull/289` without merge because the branch was classified as an empty / behaviorally redundant no-op against the already-passing pinned `origin/main` proof-run commit.
- Linear follow-up target from the proof run: record on `https://linear.app/john-halbert/issue/ENG-443/t088-backfill-legacy-run-and-workspace-context-on-read` and `https://linear.app/john-halbert/issue/ENG-838/eng-443a-prove-base-legacy-backfill-and-classify-no-op-pr` that the pinned `origin/main` proof run already satisfied the legacy run/workspace read-time backfill proof for T088, then continue remaining ENG-443 legacy backfill work through the still-distinct sibling tasks (`T089-T094`) instead of merging PR #289.

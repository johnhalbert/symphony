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

3. Confirm context columns and indexes exist for state and projection records that need collision-safe lookup.

## Full Validation

After the implementation tasks complete, run:

```powershell
npm test -- tests/workflow.test.ts tests/doctor.test.ts tests/orchestrator.test.ts tests/git-worktree.test.ts tests/status-api.test.ts tests/web-projection.test.ts tests/web-history-projection.test.ts tests/web-transcript-projection.test.ts tests/web-route-contract.test.ts tests/web-projection-context.test.ts tests/completion-report-mcp.test.ts tests/review-verdict-mcp.test.ts tests/review-feedback-mcp.test.ts tests/writeback-outbox.test.ts tests/postgres-schema.test.ts tests/mcp-subprocess-environment.test.ts tests/cursor-harness.test.ts tests/hermes-harness.test.ts tests/hermes-acp-harness.test.ts
```

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

Conditional child disposition recorded for `ENG-842`:

- The `ENG-842` repair branch exists only to fix a legacy run, workspace, or projection readback path if `ENG-838` proves one is missing on current base. The accepted `ENG-838` proof above recorded the opposite result: current base already satisfied the T088 legacy/default read-time backfill behavior.
- On the `ENG-842` worker evaluation run, `git rev-parse HEAD` and `git rev-parse origin/main` both resolved to `b9b5e8794744a23c313c8334b391774a4f3d65dc`, `git rev-list --left-right --count HEAD...origin/main` returned `0 0`, and both the triple-dot and direct proof-surface diffs against `origin/main` returned no output, confirming the branch carried no repair beyond the already-passing base state.
- The issue-required validation commands still passed on that unchanged branch (`npm test -- tests/transcript-store.test.ts tests/transcript-replay.test.ts tests/workspace.test.ts` -> `25 passed`; `npm test -- tests/web-history-projection.test.ts tests/web-transcript-projection.test.ts tests/web-projection-context.test.ts` -> `47 passed`), and the downstream durable checks also still passed (`tests/status-api.test.ts` legacy/default case -> `1 passed, 30 skipped`; `tests/web-history-transcript-durable-projection.test.ts` legacy/default case -> `1 passed, 12 skipped`).
- Service-owned follow-up for `ENG-842`: cancel or retarget `https://linear.app/john-halbert/issue/ENG-842/eng-443b-repair-only-proven-missing-legacy-backfill-path` instead of publishing a product-code repair, because the prerequisite missing-path proof was not met.

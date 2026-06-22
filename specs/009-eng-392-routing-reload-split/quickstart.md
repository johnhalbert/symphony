# Quickstart: ENG-392 Routing Reload Decomposition

## Purpose

Use this plan to turn blocked Linear issue ENG-392 into independently reviewable child issues before any renewed worker dispatch or publication.

## Workflow

1. Confirm the active planning artifact:

   ```powershell
   Get-Content -Raw .specify\feature.json
   ```

   Expected feature directory: `specs/009-eng-392-routing-reload-split`.

2. Read the planning record:

   - `specs/009-eng-392-routing-reload-split/spec.md`
   - `specs/009-eng-392-routing-reload-split/plan.md`
   - `specs/009-eng-392-routing-reload-split/research.md`
   - `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md`
   - `specs/009-eng-392-routing-reload-split/contracts/publication-surface-gate.md`
   - `specs/009-eng-392-routing-reload-split/contracts/validation-evidence.md`

3. Generate tasks with `/speckit-tasks` before implementation work. The first task group should record the operator decision and produce child issue contracts.

4. Validate child issue descriptions before delegation:

   ```powershell
   npm test -- tests/issue-contract-lint.test.ts
   ```

5. For the original routing/reload test-proof child, validate focused and broader orchestrator behavior after runtime dependencies are satisfied:

   ```powershell
   npx vitest run --no-file-parallelism tests/orchestrator.test.ts -t "routes multi-project worker dispatch through each context|preserves running project-context routing when config reload changes active states, workspace root, and state dir|preserves worker retry redispatch through the original docs active states after reload|preserves reviewer redispatch through the original docs review states after reload"
   npm test -- tests/orchestrator.test.ts
   ```

6. Before review, compare the publication candidate to the active child contract:

   ```powershell
   $base = git merge-base origin/main HEAD
   git diff --name-status $base --
   git diff --stat $base --
   ```

   Every changed surface must be named by the active child issue contract. Out-of-contract surfaces require a separate child issue or removal before review.

7. Run project-level validation for any child that touches shared orchestration, writeback, workspace, cursor, or status surfaces:

   ```powershell
   npm run typecheck
   ```

   Add the focused test suite for the touched surface, such as `tests/status-api.test.ts` or `tests/cursor-workspace-opener.test.ts`, only when that surface is authorized by the child contract.

## Completion Evidence

Each child issue should include:

- The active fenced JSON issue contract.
- Dependency status for other child contracts.
- Focused validation output.
- Broader validation output when shared orchestration or protected surfaces are touched.
- Contract-to-surface comparison showing no unmapped changed files.
- Publication hygiene statement covering debug artifacts and redaction.

# Quickstart: ENG-443 Legacy Backfill Resolution

## Scenario 1: Prove current-main behavior

1. Check out or inspect current `main`.
2. Seed legacy run and workspace records without project-context metadata.
3. Run:

   ```powershell
   npm test -- tests/transcript-store.test.ts tests/workspace.test.ts
   ```

4. Record whether run and workspace records read back with stable non-secret attribution.

## Scenario 2: Classify the active pull request

1. Compare the active ENG-443 PR against current `main`.
2. Classify it as `empty`, `behaviorally_redundant`, or `non_empty`.
3. If base satisfies the contract, prepare evidence for closure, retarget, or replacement rather than merge.

## Scenario 3: Implement only a proven missing path

1. If Scenario 1 finds a missing readback path, capture failing-before evidence.
2. Implement the smallest repair for that specific path.
3. Rerun the focused tests and capture passing-after evidence.

## Scenario 4: Projection readback remains safe

1. Seed projections or projection inputs from legacy records.
2. Run:

   ```powershell
   npm test -- tests/web-history-projection.test.ts tests/web-transcript-projection.test.ts tests/web-projection-context.test.ts
   ```

3. Confirm projection output includes safe legacy/default attribution only.

## Full Validation

After child tasks complete, run:

```powershell
npm test -- tests/transcript-store.test.ts tests/transcript-replay.test.ts tests/workspace.test.ts tests/web-history-projection.test.ts tests/web-transcript-projection.test.ts tests/web-projection-context.test.ts tests/issue-contract-lint.test.ts
```

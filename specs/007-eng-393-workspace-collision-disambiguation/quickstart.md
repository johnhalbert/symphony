# Quickstart: ENG-393 Workspace Collision Disambiguation

## Scenario 1: Duplicate identifiers create distinct workspaces

1. Configure two project contexts whose trackers expose the same visible issue identifier.
2. Create or simulate workspaces for both issues.
3. Run:

   ```powershell
   npm test -- tests/git-worktree.test.ts tests/workspace.test.ts
   ```

4. Confirm workspace keys and paths are distinct.

## Scenario 2: Null branch metadata remains safe

1. Use duplicate-context issues with null tracker branch metadata.
2. Configure a branch template that can collide if context is ignored.
3. Run the focused Git worktree tests.
4. Confirm each issue receives a deterministic safe branch.

## Scenario 3: Branch safety cache cannot be poisoned

1. Prime branch safety with one contextual issue.
2. Evaluate a second issue with a duplicate visible identifier under the same template.
3. Confirm the second issue is evaluated independently and cannot reuse an unsafe cached result.

## Scenario 4: Exact-id readback works with legacy artifacts

1. Seed legacy workspace records, summaries, and status pointers.
2. Read, summarize, and resume an exact issue when a duplicate visible identifier exists in another context.
3. Run:

   ```powershell
   npm test -- tests/transcript-store.test.ts tests/transcript-replay.test.ts tests/status-api.test.ts tests/web-projection-context.test.ts
   ```

4. Confirm the exact issue's records are selected and legacy artifacts remain readable.

## Full Validation

After child tasks complete, run:

```powershell
npm test -- tests/git-worktree.test.ts tests/workspace.test.ts tests/transcript-store.test.ts tests/transcript-replay.test.ts tests/status-api.test.ts tests/web-projection-context.test.ts tests/issue-contract-lint.test.ts
```

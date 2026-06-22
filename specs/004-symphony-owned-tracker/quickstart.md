# Quickstart: Symphony Owned Tracker MVP

This quickstart describes the intended validation path for the implementation phase. It is not a user migration guide.

## 1. Prepare Datastore

1. Configure `database.postgres.connection_string` for a local test database.
2. Apply the configured migration path:

   ```powershell
   npm run migrations:apply -- WORKFLOW.md
   ```

3. Confirm the native tracker migration is present and validated:

   ```powershell
   npm run migrations:validate -- WORKFLOW.md
   ```

## 2. Configure Native Tracker

Use a workflow configuration that selects the native tracker and does not require Linear credentials:

```yaml
tracker:
  kind: symphony
  active_states:
    - Todo
    - In Progress
  handoff_states:
    - Ready for Review
  terminal_states:
    - Done
database:
  postgres:
    connection_string: $TEST_POSTGRES_URL
```

Expected result: runtime config parses without `LINEAR_API_KEY` or Linear project slug when `tracker.kind` is `symphony`.

## 3. Seed One Eligible Issue

Create one native Symphony issue with:

- stable durable ID;
- human identifier;
- title and active state;
- required labels for the workflow;
- no open blockers;
- description containing the required fenced JSON issue contract.

Expected result: `fetchCandidateIssues()` returns the issue as `assignedToWorker: true`.

## 4. Validate Dispatch

Start the runtime with the native tracker selected.

Expected result:

- Linear is not contacted.
- The eligible native issue is selected for the same worker dispatch path used by Linear-backed issues.
- Lifecycle/run records still use the issue's durable ID and identifier.

## 5. Validate Blocker Semantics

1. Add an unresolved blocker reference to the issue.
2. Poll candidates.
3. Mark the blocker terminal.
4. Poll candidates again.

Expected result:

- The issue is skipped while the blocker is unresolved.
- The issue becomes eligible within one polling cycle after all blockers are terminal.

## 6. Validate Writeback

Run a flow or targeted test that requests:

- a state transition;
- a comment with a dedupe key;
- a retry of the same comment write.

Expected result:

- The state transition is applied atomically and recorded with transition evidence.
- The retried comment verifies the existing logical comment instead of creating a duplicate.
- Unsupported optional child issue or relation creation fails closed when requested.

## 7. Validate Linear Compatibility

Run the existing Linear tracker tests and runtime dependency tests.

Expected result:

- Linear config still requires Linear credentials/project slug when selected.
- Linear tracker reads and writeback behavior remain unchanged.

## 8. Non-Goals Check

Confirm the implementation did not modify:

- projection tables or projection rebuild behavior;
- vendored upstream source;
- worker/reviewer direct mutation paths;
- unrelated dirty worktree files.

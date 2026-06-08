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

## Promotion Notes

Recorded on `2026-06-08T12:44:00Z`.

- Validation evidence: `docs/smoke/eng-347-final-validation.md`
- Governance closure ledger: `docs/smoke/eng-347-governance-ledger.md`
- Focused suite packet (T095-T099), quickstart full-validation command, full-repository `npm test`, and `npm run typecheck` all completed successfully.
- `/api/v1/activity?projectContextId=<id>` now scopes run, transcript, and writeback items even without an `issue` filter, and the status-api regression lives in `tests/status-api.test.ts`.
- Durable dashboard/history/sidebar route hits now preserve stored read models, while rebuild paths still surface durable running-agent rows when the live snapshot is empty.
- The repo-local governance ledger now mirrors the ENG-347 feature contract, records the child-issue inventory/order/completion evidence, and maps `FR-001` through `FR-025` plus `SC-001` through `SC-009` to current artifacts.
- Remaining runtime risk: no live Linear/GitHub multi-context publication/replay flow was exercised in this packet.

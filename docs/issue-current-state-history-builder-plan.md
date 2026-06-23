# Issue Current State And History Builder Plan

Date: 2026-06-23

Status: Proposed, pending review.

This planning record captures the intended path from the current store-backed
builder to a history-backed current-state builder. It is not a Spec Kit artifact
and is not a standalone work assignment.

## Design Target

The architecture has two connected layers:

1. A store-backed current-state builder that centralizes the decision-state
   assembly we can support today.
2. A history-backed current-state builder that becomes possible after issue
   history captures all facts needed to rebuild current state.

`IssueCurrentStateBuilder` remains the public decision-state boundary. It builds
an immutable, flat `IssueCurrentStateSnapshot` from the active tracker issue,
runtime facts, configured behavior, persisted lifecycle/run data, and issue
history.

Rulesets receive only:

- `IssueCurrentStateSnapshot`
- `IssueHistorySnapshot[]`
- pure helper/config logic

`candidateSource` remains on snapshots as trigger and fetch lineage metadata,
but rules should not rely on it for ordinary transition decisions.

Transition actions may perform side effects directly through injected stores,
trackers, harnesses, clients, or services. They do not own the persistence
framework for action lifecycle. The transition executor records pending,
succeeded, skipped, and failed action records, plus runtime/domain errors.

## Current Gaps

- `SqliteIssueStateStore` stores `current_json` and separate history rows.
- `current_json` is still treated as persisted current state rather than a
  rebuildable cache.
- Issue history is useful for audit but is not yet complete enough to rebuild
  all current fields.
- Some current-state facts still exist only in lifecycle records, run records,
  runtime maps, tracker issue data, or generic evidence payloads.
- Some evidence is stored as nested generic payloads instead of typed top-level
  snapshot fields.

## Fact Ownership

Facts that must be captured before history can become authoritative:

- Tracker observations: state, labels, assignee, branch, blockers, child status,
  URL, priority, and updated timestamp.
- Lifecycle mutations: phase, review round, planning failures, blocked reason,
  reports, verdicts, merge gate state, merge data, conflict metadata, and
  summary pointers.
- Run events: run start, prompt/session ids, role, phase, kind, status,
  completion, error, token usage, workspace pointers, and PR metadata.
- Writeback events: queued, attempted, succeeded, failed, dedupe key, target
  state, comment, and operation identifiers.
- Approval events: requested, approved, rejected, expired, cancelled, and replay
  handling.
- Runtime control events: retry scheduled, retry fired, retry cleared, claim
  acquired/released, pause/resume, and cancellation request where durable
  behavior depends on it.
- Transition actions: every side-effect bounded action result, including
  skipped actions.
- Errors: runtime/domain errors at snapshot and action level.

Trigger-local facts remain snapshot-local and should not become durable issue
truth:

- available slots
- active provider gate status
- state slot availability
- manual force/ignore flags
- `candidateSource`

## Implementation Plan

### Phase 0: Baseline

- Treat the current builder, tick, and ruleset work as the baseline.
- Keep `candidateSource` as lineage metadata.
- Keep `current_json` as persisted current state for now.
- Do not make history authoritative until parity exists.

Validation:

- `npm run typecheck`
- targeted orchestration and builder tests
- full suite, with unrelated known failures called out explicitly

### Phase 1: Clean The Store-Backed Builder

- Refactor `IssueCurrentStateBuilder` into internal field-group builders:
  - `buildTrackerFields`
  - `buildLifecycleFields`
  - `buildRunFields`
  - `buildRuntimeFields`
  - `buildConfigFields`
  - `buildHistoryFields`
  - `buildTriggerFields`
- Preserve the public contract:

```ts
buildSnapshot(issue, runtime, input): Promise<IssueCurrentStateSnapshot>
```

- Add focused tests per field group:
  - tracker-only issue fields
  - lifecycle report, verdict, and merge fields
  - latest run fields
  - runtime flags
  - history-derived merge-policy observation fields
  - trigger-local fields
- Add a guard test that `buildSnapshot` returns a flat immutable snapshot with
  no nested `current`.

### Phase 2: Ruleset Isolation

- Audit all `TransitionRuleset.evaluate` bodies.
- Ensure rulesets only use the current snapshot, history, and pure helpers.
- Remove remaining transition decision logic that depends on candidate lanes.
- Keep `candidateSource` available for audit/debug metadata only.

Validation:

- Tests that mutate `candidateSource` while keeping state fields identical
  should produce the same transition, except explicit lineage-only test cases.

### Phase 3: Type History Evidence

- Add typed evidence snapshot variants under the one heterogeneous history array.
- Start with typed variants for:
  - tracker observation
  - lifecycle mutation
  - run started
  - run completed
  - run updated
  - writeback queued/applied/failed
  - approval requested/approved/rejected
  - workspace created/removed/updated
  - runtime retry scheduled/fired/cleared
- Keep `evidencePayload` temporarily for compatibility.
- Move important facts to top-level typed fields.
- Update normalization so legacy snapshots remain readable.

### Phase 4: Complete Evidence Capture

- Record tracker observations during tick, manual, retry, and transition-chain
  processing.
- Ensure lifecycle updates record typed lifecycle evidence with before/after or
  patch details.
- Ensure run lifecycle operations record typed run evidence.
- Ensure writeback and approval flows record typed evidence.
- Continue recording transition action lifecycle through the executor.

Rule:

- Side-effect actions can call stores/services directly.
- Any state-changing side effect must leave an action record and, where
  relevant, a typed evidence snapshot.

### Phase 5: History-Built Current State

- Add internal `buildFromStores(...)` and `buildFromHistory(...)` paths inside
  `IssueCurrentStateBuilder`.
- Add history-completeness checks per field group.
- Initially return store-built state.
- In tests, compare store-built and history-built output for selected field
  groups.

Suggested switch order:

1. tracker fields
2. run summary fields
3. writeback and approval fields
4. lifecycle report and verdict fields
5. merge policy fields
6. retry and runtime-control fields

Runtime-only trigger facts stay outside durable history:

- available slots
- provider gate active flag
- manual flags
- active in-memory running, claimed, and paused state where it is genuinely
  process-local

### Phase 6: Parity Tests

Add timeline-based tests that build current state both ways for:

1. normal worker dispatch and completion
2. reviewer pass/fail
3. rejected completion report
4. issue triage blocked/rebound
5. merge policy pass to done
6. merge conflict repair
7. publication approval rejection/recovery
8. retry scheduling and retry firing

Acceptance:

- For fields marked history-backed, history-built state matches store-built
  state.
- Mismatches identify field name, source, expected value, actual value, and
  history snapshot ids considered.

### Phase 7: Switch Authority Gradually

- Flip field groups one at a time from store-backed to history-backed inside the
  builder.
- Keep fallback to store-backed behavior for incomplete legacy history.
- Keep writing `current_json`, but treat it as cached state.
- Add a rebuild test:
  - delete or ignore `current_json`
  - rebuild current fields from history
  - compare rebuilt fields to cached current fields

### Phase 8: Finalize Cache Semantics

- Document `current_json` as cached current snapshot storage, not durable source
  of truth.
- Add a rebuild utility/test helper for issue state from history.
- Keep SQLite schema compatible; avoid destructive migration.
- Add operational logging for history-incomplete fallback cases.

## Review Questions

- Which field groups should be history-backed first after tracker/run basics?
- Which runtime facts should remain intentionally process-local?
- Should typed history variants be represented as TypeScript discriminated
  unions immediately, or introduced first through normalized top-level fields
  with compatibility tests?
- What mismatch reporting format should parity tests use for the dashboard or
  logs, if any?

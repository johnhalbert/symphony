# Research: ENG-443 Legacy Backfill Resolution

## Decision: Require current-main proof before implementation

**Rationale**: Review found the active PR may be empty while current `main` already satisfies the behavior. A proof-first step prevents semantic no-op work from continuing.

**Alternatives considered**:

- Continue revising the existing PR until review passes. Rejected because an empty diff cannot prove missing behavior.
- Close the issue without proof. Rejected because the parent still needs evidence that the contract is satisfied or retargeted.

## Decision: Treat no-op PR disposition as valid work

**Rationale**: If the base already satisfies the contract, the correct resolution is evidence plus closure, retargeting, or replacement of the PR. That is work the system should track explicitly.

**Alternatives considered**:

- Merge the no-op PR to satisfy workflow mechanics. Rejected because it teaches the agents to promote meaningless changes.
- Leave the parent blocked for a human to sort out later. Rejected because the process can express the resolution as a child issue.

## Decision: Implement only a demonstrated missing read path

**Rationale**: If one legacy read path is missing, the fix should be scoped to that path with failing-before and passing-after evidence. Broad persistence refactoring is not justified by the current blocker.

**Alternatives considered**:

- Rewrite all legacy persistence handling. Rejected as disproportionate and risky.
- Add tests only, regardless of behavior. Rejected if a runtime path is actually failing.

## Decision: Use read-time backfill before destructive migration

**Rationale**: Legacy records are operator-controlled historical evidence. Read-time fallback preserves readability without rewriting records during normal inspection.

**Alternatives considered**:

- Eagerly migrate historical files. Rejected because it is destructive and needs a separate migration/rollback plan.
- Ignore records without context. Rejected because historical diagnosis must remain available.

## Decision: Backfilled metadata is non-secret diagnostic attribution

**Rationale**: The feature needs context attribution for old records, not credential reconstruction. Synthetic default/legacy metadata is enough for readback and proof.

**Alternatives considered**:

- Reconstruct full context including credentials. Rejected by secret hygiene and unnecessary for readback.

# Research: ENG-392 Routing Reload Decomposition

## Decision: Preserve ENG-392 as a blocked parent until decomposition is explicit

**Rationale**: Linear comments show ENG-392 reached the blocked path after repeated reviewer failures because the original contract authorized test work in `tests/orchestrator.test.ts`, while the active publication candidate included broader runtime, status, workspace, cursor, and debug-artifact surfaces. Re-dispatching the same parent would repeat the scope mismatch.

**Alternatives considered**:

- Re-dispatch ENG-392 unchanged: rejected because the issue comments explicitly identify a contract/publication mismatch, not a transient worker or CI failure.
- Widen ENG-392 directly: rejected as the default because widening a blocked test-only issue would hide separable runtime obligations and make review harder.
- Close the issue as done: rejected unless current base behavior is proven to satisfy the original contract and no publication work remains.

## Decision: Split the original test proof from runtime prerequisites

**Rationale**: The completion and review comments record a bounded contradiction proof: with the broader runtime surface present, the routing/reload tests passed; when non-contract paths were restored to base, the focused and full orchestrator validations failed. That means the original test proof depends on runtime behavior that needs its own contract.

**Alternatives considered**:

- Keep tests and runtime changes in one issue: rejected because reviewers already classified this as a scope/publication defect.
- Make the test issue depend on child runtime work: selected because it keeps the original test proof independently reviewable once prerequisites are satisfied.
- Convert all work into one larger replacement issue: acceptable only if an operator explicitly chooses a widened contract and the widened issue passes preflight.

## Decision: Use child issue contracts as the decomposition unit

**Rationale**: Symphony's constitution requires fenced JSON issue contracts before issue delegation or promotion. The existing issue breakdown services can represent child issues with title, description, acceptance criteria, labels, dependencies, and idempotent writeback operations.

**Alternatives considered**:

- Use only Spec Kit tasks: rejected because project guidance says Spec Kit artifacts are planning records and Linear issue contracts are canonical for agent work.
- Use review comments without new contracts: rejected because future workers need stable requirement IDs and proof hints.
- Create one child per changed file: rejected because behavior families are the reviewable unit; file lists may change during implementation.

## Decision: Require contract-to-surface comparison before publication

**Rationale**: The main failure mode was not missing coverage alone; it was that the publication candidate exceeded the active contract. A final surface check ensures every changed file is authorized by the active child issue contract before review.

**Alternatives considered**:

- Rely on reviewer inspection only: rejected because ENG-392 already consumed multiple review rounds on this mismatch.
- Require every child to touch exactly one file: rejected because some behavior families require coordinated test and source changes.
- Allow broader surfaces when tests pass: rejected because passing tests do not prove authority to publish unrelated changes.

## Decision: Treat debug artifacts as a separate publication hygiene concern

**Rationale**: Review comments flagged orphaned temp debug captures containing local paths and captured lifecycle state. These artifacts are not intrinsically invalid, but they must either be removed or converted into deliberate redacted fixtures with tests that reference them.

**Alternatives considered**:

- Ignore debug artifacts after tests pass: rejected because publication hygiene was an explicit reviewer blocker.
- Ban all fixture extraction: rejected because deliberate redacted fixtures may be useful when tied to validation.
- Fold hygiene into every runtime child: rejected because a dedicated hygiene gate makes the publication surface easier to audit.

## Decision: Keep live Linear/GitHub round trips out of the default validation path

**Rationale**: The blocked evidence and intended decomposition can be validated with local issue breakdown, contract linting, orchestrator, writeback, and surface checks. Live tracker or GitHub writes are service-owned effects and should be invoked only by configured Symphony paths or an explicitly expanded child contract.

**Alternatives considered**:

- Require live publication/writeback for every child: rejected as unnecessary and higher risk for planning and local validation.
- Never allow live validation: rejected because a later child may explicitly own service writeback or publication behavior.
- Use local validation first, with live effects only when authorized: selected.

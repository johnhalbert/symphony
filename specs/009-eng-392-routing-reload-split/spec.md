# Feature Specification: ENG-392 Routing Reload Decomposition

**Feature Branch**: `[009-eng-392-routing-reload-split]`

**Created**: 2026-06-14

**Status**: Draft

**Input**: User description: "Use the requirements for Linear issue ENG-392 as the spec. Note the comments on the issue, and concerns raised. This issue needs to be decomposed. Do not switch branches."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Choose a decomposition path (Priority: P1)

As the operator, I need ENG-392 to stop cycling through review until its original test-only obligation is separated from the broader runtime and publication concerns raised in the issue comments.

**Why this priority**: ENG-392 is blocked after repeated reviewer failures because the active publication candidate exceeded the issue contract while the new tests depended on those broader changes.

**Independent Test**: Can be tested by comparing the active ENG-392 contract, Linear comments, review findings, and publication candidate, then recording one explicit path: split and retarget, widen through new contracts, or close/replace if current behavior is already proven.

**Acceptance Scenarios**:

1. **Given** ENG-392 is contracted as test proof for routing and reload preservation, **When** the active work also contains broader runtime or publication behavior, **Then** the issue remains blocked until that mismatch is split, retargeted, or explicitly widened.
2. **Given** the test proof cannot pass when broader behavior is removed, **When** the issue is decomposed, **Then** the missing behavior is represented as dependency work rather than hidden inside the test-only issue.
3. **Given** an operator chooses to widen the original work, **When** the widened scope is authorized, **Then** each added obligation has its own fenced JSON issue contract before worker dispatch.

---

### User Story 2 - Preserve the original test proof as a narrow deliverable (Priority: P2)

As a reviewer, I need the routing and config-reload test proof to remain independently reviewable so the original ENG-392 requirement can be accepted without unrelated behavior riding along.

**Why this priority**: The original issue contract requires proof that two Linear project contexts route to distinct workspaces, distinct state buckets, and preserved in-progress run context after configuration reload.

**Independent Test**: Can be tested by running the routing and reload-preservation scenarios in isolation and in the broader orchestrator validation set after prerequisite behavior is already present or declared as a dependency.

**Acceptance Scenarios**:

1. **Given** two Linear project contexts are active, **When** worker dispatch is evaluated, **Then** each issue routes through its own project context, workspace identity, state bucket, and durable run/lifecycle records.
2. **Given** configuration reload changes active states, review states, workspace roots, or state locations, **When** an in-progress run continues, **Then** the run keeps the project context and persisted routing snapshot it had before reload.
3. **Given** the test proof is reviewed after decomposition, **When** its publication candidate is inspected, **Then** the candidate only contains surfaces authorized by the active test-proof contract.

---

### User Story 3 - Extract runtime prerequisites into child work (Priority: P3)

As an implementer, I need each runtime behavior discovered during ENG-392 review to have its own contract so required behavior can be implemented, reviewed, and validated without overloading the original test issue.

**Why this priority**: Linear comments show the green branch tip depended on broader behavior such as context-aware dispatch, preserved configuration snapshots, approval recovery, writeback routing, workspace/status handling, and repository hygiene.

**Independent Test**: Can be tested by creating child issue contracts that each own one behavior family and by proving each child can pass or fail without relying on unrelated child work.

**Acceptance Scenarios**:

1. **Given** context-aware dispatch or retry behavior is missing, **When** child work is created, **Then** that child owns the runtime routing requirement and the original test issue records the dependency.
2. **Given** reload preservation fails for an active run or reviewer/worker redispatch, **When** child work is created, **Then** that child owns preserving the original project context across reload until the run or redispatch completes.
3. **Given** approval recovery or terminal writeback can use a stale global context after reload, **When** child work is created, **Then** that child owns preserving the request's project context and writeback bucket for approved, rejected, stale, and expired outcomes.
4. **Given** additional surfaces appear in a publication candidate, **When** they are unrelated to the active child contract, **Then** they are moved to a separate issue or removed before review.

---

### User Story 4 - Keep evidence and publication clean (Priority: P4)

As the operator, I need decomposed ENG-392 work to leave durable, redacted evidence and avoid transient debug artifacts so future automation can replay and review the result safely.

**Why this priority**: Review comments flagged orphaned debug captures, local paths, and repeated review churn as blockers even after some behavior appeared to pass.

**Independent Test**: Can be tested by inspecting the final publication candidate and Linear evidence for authorized scope, redacted proof, no orphaned artifacts, and validation that explains which contract each result satisfies.

**Acceptance Scenarios**:

1. **Given** debug captures or local runtime artifacts were produced during diagnosis, **When** the publication candidate is prepared, **Then** they are removed or converted into deliberate redacted fixtures with explicit validation value.
2. **Given** validation evidence is attached to a child issue, **When** a reviewer reads it, **Then** it distinguishes base-behavior proof, failing-before evidence, passing-after evidence, and any intentionally unverified live integrations.
3. **Given** a reviewer checks the decomposed work, **When** the publication surface is compared with the active contract, **Then** every changed surface is authorized by that contract.

### Edge Cases

- Current main already satisfies one or more runtime prerequisites, making evidence and issue closure preferable to new implementation.
- The routing/reload tests pass at branch tip but fail when out-of-contract runtime changes are removed.
- Configuration reload changes active states, review states, handoff states, workspace roots, or state locations while a run is still in progress.
- Worker retry and reviewer redispatch happen after reload and must continue using the original issue/request project context.
- Lifecycle-only pending publication approval handoffs must remain suppressed rather than surfacing as idle alerts or cancellation candidates.
- Publication approval recovery reaches approved, rejected, stale, or expired outcomes after reload.
- A publication candidate includes status, workspace, command-line, editor, or other adjacent surfaces that are not named by the active contract.
- Transient debug captures contain local paths, fake tracker data, or captured workflow state that is not deliberate fixture data.
- A worker prompt or review context omits the fenced JSON issue contract even though Linear contains one.

## Constitution Coverage *(mandatory)*

- **Authority Boundary**: Symphony owns decomposition decisions, issue contract preflight, tracker writeback, pull-request publication, review writeback, and merge gates. Workers and reviewers must not silently widen ENG-392, publish unrelated surfaces, close tracker work, or bypass service-owned paths.
- **Credential And Secret Handling**: Project context metadata, validation evidence, debug captures, local paths, tracker data, workflow state, and comments must be redacted and must not expose tokens, credential values, secret-backed profiles, private keys, or customer-private data.
- **Issue Contract Source**: Child issues must derive from ENG-392's fenced JSON contract, the Linear comments, and the reviewer concern families: `REQ-392-DECISION`, `REQ-392-TEST-PROOF`, `REQ-392-RUNTIME-ROUTING`, `REQ-392-RELOAD-PRESERVATION`, `REQ-392-APPROVAL-WRITEBACK`, and `REQ-392-PUBLICATION-HYGIENE`. Each delegated child issue must include a valid fenced JSON issue contract before promotion.
- **Audit And Replay Evidence**: Decomposition must record the operator decision, contract-to-publication surface comparison, dependency map, validation evidence, and any contradiction proof showing whether tests require prerequisite runtime behavior.
- **Protected Or Vendored Surfaces**: Orchestration, runtime harness behavior, workspace identity, durable run/lifecycle stores, approval recovery, writeback state, tracker writeback, status readback, and publication evidence are protected. Vendored upstream source, live credentialed integrations, and unrelated operator-controlled state are out of scope unless a child contract explicitly authorizes them.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: ENG-392 MUST remain blocked for automation dispatch until the test-only contract and broader runtime/publication concerns are split, retargeted, or explicitly widened by an operator decision.
- **FR-002**: Decomposition MUST separate the original routing/reload test proof from runtime prerequisites, publication hygiene, and any adjacent status/workspace/editor surfaces.
- **FR-003**: The test-proof work MUST verify that two Linear project contexts route to distinct workspaces, distinct state buckets, and distinct durable run/lifecycle records.
- **FR-004**: The test-proof work MUST verify that an in-progress run keeps its original project context and persisted routing snapshot after configuration reload.
- **FR-005**: Runtime routing child work MUST carry the resolved project context through dispatch, retry, running-run reconciliation, handoff, continuation, and readback behavior required by the tests.
- **FR-006**: Reload-preservation child work MUST keep worker and reviewer redispatch tied to the original issue/request project context until the run or review flow completes.
- **FR-007**: Approval and writeback child work MUST preserve the request's project context and state bucket for approved, rejected, stale, and expired publication approval outcomes after reload.
- **FR-008**: Publication hygiene child work MUST remove orphaned debug/runtime captures or convert them into deliberate, redacted, referenced fixtures.
- **FR-009**: Validation MUST prove routing/reload behavior in focused runs and broader orchestrator validation without relying on order-dependent side effects.
- **FR-010**: If the test-only proof fails after non-contract behavior is removed, the failure MUST be recorded as a dependency on child runtime work rather than published under the original test-only contract.
- **FR-011**: Every child issue derived from this spec MUST include a valid fenced JSON Issue Contract with stable requirement IDs before delegation, review, writeback, or promotion.
- **FR-012**: Review evidence MUST show that each publication candidate contains only surfaces authorized by its active issue contract.
- **FR-013**: Evidence, fixtures, and comments MUST avoid credential values, secret-backed configuration, and unnecessary local absolute paths.

### Key Entities *(include if feature involves data)*

- **Original Issue Contract**: The ENG-392 fenced JSON contract requiring routing/reload test proof for two Linear project contexts.
- **Publication Candidate**: The work proposed for review or merge under a specific issue contract.
- **Runtime Prerequisite**: Behavior required for the test proof to pass but not authorized by the original test-only contract.
- **Project Context**: The tracker/workspace/state routing identity that distinguishes Linear projects and must persist across reload.
- **Reload Preservation Record**: Durable evidence that a run or redispatch kept its original project context after configuration changed.
- **Child Issue Contract**: A fenced JSON contract created from this decomposition for one independently reviewable concern.
- **Validation Evidence**: Focused and broader proof that a child issue satisfies its contract, including any base-behavior proof or failing-before/passing-after evidence.
- **Debug Artifact**: A transient capture or local runtime record that must be removed or intentionally converted into redacted fixture data.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: ENG-392 has a recorded operator-facing decision classifying the active work as split/retargeted, explicitly widened through child contracts, or closed/replaced by base-behavior proof.
- **SC-002**: All ENG-392 obligations are assigned to independently reviewable child issue contracts, and no child mixes test-only proof with unrelated runtime or publication changes.
- **SC-003**: The routing/reload test-proof child can pass its focused and broader validation after declared dependencies are satisfied, with no out-of-contract publication surface.
- **SC-004**: Each publication candidate produced from the decomposition has a contract-to-surface comparison showing 100% of changed surfaces are authorized by the active contract.
- **SC-005**: Every child issue produced from this spec passes Symphony issue-contract preflight before delegation or promotion.
- **SC-006**: Final evidence contains no orphaned debug captures, unredacted secret values, or unnecessary local absolute paths.

## Assumptions

- ENG-392 should not be re-dispatched as-is while it remains blocked for contract/publication mismatch.
- The safest default decomposition is to keep the original routing/reload test proof narrow and move prerequisite runtime behavior into separate child contracts.
- Existing behavior may already satisfy some child concerns; proof and issue resolution are acceptable outcomes when no implementation is needed.
- The active pull request may be split, retargeted, or replaced by a new publication candidate, but that operator choice is outside this specification.
- Validation can use synthetic project contexts and local stores; live Linear or GitHub writeback is not required unless a child contract explicitly expands scope.

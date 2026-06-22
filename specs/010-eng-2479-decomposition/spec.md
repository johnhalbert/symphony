# Feature Specification: ENG-2479 Runtime Child Preflight Decomposition

**Feature Branch**: `010-eng-2479-decomposition`

**Created**: 2026-06-16

**Status**: Draft

**Input**: User description: "ENG-2479 has been flagged for decomposition. Review the issue, as well as its parents, to the root of the issue tree, using the information there for decomposition of 2479 into subissues."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Define The Decomposition Matrix (Priority: P1)

A planner can review ENG-2479, ENG-392, ENG-351, and ENG-347, then produce a Linear-ready child issue body set that separates the proof matrix, execution path, evidence capture, and review-unblock concerns that caused ENG-2479 to block.

**Why this priority**: ENG-2479 failed because one validation task mixed planning, orchestration, worker evidence, and review recovery obligations; no worker should be re-dispatched until those obligations are independently owned.

**Independent Test**: Compare the prepared child issue body set against ENG-2479's blocked triage comment and the ancestor contracts; the set is valid when every active blocker has exactly one child owner and no duplicate child body exists.

**Acceptance Scenarios**:

1. **Given** ENG-2479 has no existing child issue body for a blocker category, **When** the decomposition artifacts are prepared, **Then** each required blocker category has one Linear-ready child body that states its intended ENG-2479 parent relationship.
2. **Given** the ancestor chain ends at ENG-347, **When** child issue descriptions are reviewed, **Then** each prepared description cites the relevant source context from ENG-2479 and its ancestors.
3. **Given** a prepared child issue body is later promoted for agent work through the appropriate issue-sync flow, **When** its description is inspected, **Then** it includes one valid fenced JSON issue contract with stable requirement ids.

---

### User Story 2 - Establish An Approved Validation Path (Priority: P2)

An orchestrator owner can resolve the mismatch between ENG-2479's required focused preflight and restricted worker/reviewer execution policy by defining an approved validation path before evidence collection.

**Why this priority**: Repeated review failures show that the expected evidence cannot be produced reliably through the restricted worker/reviewer path alone.

**Independent Test**: The validation-path child is complete when it names an approved executor or service-owned route and explains where the focused result must be captured for lifecycle-bound evidence.

**Acceptance Scenarios**:

1. **Given** restricted worker/reviewer policy blocks package-command execution, **When** the validation-path child completes, **Then** it provides an approved route for collecting the focused preflight result.
2. **Given** a worker later attempts the evidence child, **When** the worker follows the validation-path output, **Then** the worker can reference a durable result rather than repeating the blocked command attempt.

---

### User Story 3 - Capture Exact Preflight Evidence (Priority: P3)

A worker can collect or attach the exact focused preflight evidence for the planned runtime child contracts after the proof matrix and validation path are defined.

**Why this priority**: ENG-2479's explicit requirement remains unsatisfied until the lifecycle-bound record includes the exact focused preflight result or concrete findings.

**Independent Test**: The evidence child is complete when the lifecycle-bound artifact records the command string, outcome, and coverage signal for the planned runtime contract families, or records concrete findings if the preflight fails.

**Acceptance Scenarios**:

1. **Given** the proof matrix child identifies the planned runtime contract families, **When** the preflight evidence child completes, **Then** the evidence states whether each family was validated or which findings remain.
2. **Given** the approved validation path produces a focused result, **When** the evidence child completes, **Then** the result is attached or summarized without credential values or unnecessary local absolute paths.

---

### User Story 4 - Unblock Parent Review Deliberately (Priority: P4)

A reviewer or operator can see whether ENG-2479 is ready for a new review attempt because the decomposition records what evidence supersedes the previous failed review and what remains intentionally unverified.

**Why this priority**: ENG-2479 is blocked by an unsuperseded failed review; successful evidence collection still needs a clear handoff back to the parent issue.

**Independent Test**: The review-unblock child is complete when ENG-2479 has a parent-facing summary that links the child evidence, lists the remaining review action, and avoids any lifecycle state change outside the service-owned path.

**Acceptance Scenarios**:

1. **Given** all prerequisite children are complete, **When** the review-unblock child is reviewed, **Then** it identifies the exact evidence that should supersede the failed review.
2. **Given** live Linear or GitHub effects were not exercised, **When** the parent-facing summary is read, **Then** those effects are explicitly marked as intentionally unverified.

### Edge Cases

- If ENG-2479 gains children before issue sync is applied, the decomposition must not prepare duplicates for the same blocker category.
- If the focused preflight fails, the evidence child must record findings rather than claiming success.
- If the worker workspace lacks planning files that ancestor comments mention, the proof-matrix child must name the authoritative fallback sources.
- If public continuous-integration evidence only shows a broad validation run, the child evidence must not treat it as proof of the focused preflight.
- If any child issue would require runtime implementation, that work must be authorized by that child issue's own contract before dispatch.

## Constitution Coverage *(mandatory)*

- **Authority Boundary**: The planner may prepare Linear-ready child issue bodies and parent-facing handoff text in Spec Kit artifacts. Live Linear child creation, tracker writeback, worker/reviewer validation, publication, and lifecycle-state changes remain service-owned and must flow through the project's issue-sync or orchestration paths.
- **Credential And Secret Handling**: Child descriptions and evidence must not include credential values, secret-backed profile contents, raw environment variables, customer-private data, or unnecessary local absolute paths.
- **Issue Contract Source**: Child issues derive their contracts from ENG-2479, ENG-392, ENG-351, ENG-347, the ENG-2479 blocked triage comments, and the ENG-392 child-contract and validation-evidence planning records. Each delegated child issue must include exactly one fenced JSON Issue Contract before promotion.
- **Audit And Replay Evidence**: Prepared child issue bodies, intended dependency relations, parent handoff text, this specification, and the checklist provide durable evidence of why ENG-2479 should be split and how each child maps to the blocked review findings.
- **Protected Or Vendored Surfaces**: This decomposition does not authorize code changes. Future child work must keep vendored upstream source out of scope and must explicitly authorize any runtime, writeback, workspace, status, cursor/editor, or publication surface it changes.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The decomposition MUST review ENG-2479 and every parent issue up to ENG-347 before defining child scope.
- **FR-002**: The decomposition MUST check whether ENG-2479 already has child issues or prepared child bodies before preparing new ones.
- **FR-003**: The decomposition MUST prepare separate child ownership for proof-matrix definition, approved validation execution path, exact preflight evidence capture, and parent review-unblock evidence.
- **FR-004**: Each prepared child issue body MUST include a valid fenced JSON Issue Contract with a non-empty contract version and stable requirement ids.
- **FR-005**: Each prepared child issue body MUST state that it is intended to be parented to ENG-2479 and block ENG-2479 until complete once synchronized.
- **FR-006**: Child issue dependencies MUST reflect the order: proof matrix before validation path, validation path before evidence capture, and evidence capture before review unblock.
- **FR-007**: The proof-matrix child MUST identify the planned runtime contract families and authoritative fallback sources when planning files are absent from a worker workspace.
- **FR-008**: The validation-path child MUST address the restricted worker/reviewer execution-policy blocker and name where focused validation evidence should be captured.
- **FR-009**: The evidence-capture child MUST require exact focused preflight outcome evidence, including outcome status and per-family coverage or findings.
- **FR-010**: The review-unblock child MUST require a parent-facing summary that identifies the evidence superseding the failed review and any intentionally unverified live effects.
- **FR-011**: All child descriptions and evidence guidance MUST require redaction of secrets and unnecessary local absolute paths.
- **FR-012**: The decomposition itself MUST NOT authorize or perform runtime implementation, publication, protected branch updates, or vendored upstream changes.

### Key Entities

- **Parent Issue Chain**: ENG-2479, ENG-392, ENG-351, and ENG-347; provides the requirement hierarchy and blocked-review context.
- **Decomposition Child Issue Body**: A Linear-ready issue description intended for ENG-2479 with a fenced JSON contract, owner category, dependency relations, and completion evidence expectations.
- **Proof Matrix**: The planner-owned mapping from ENG-2479's failed review axes to runtime contract families, fallback sources, and required evidence shape.
- **Validation Path**: The approved route for producing focused preflight evidence without relying on denied worker/reviewer command execution.
- **Evidence Artifact**: A redacted lifecycle-bound record that states the focused preflight outcome, coverage signal, and remaining findings.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of active ENG-2479 blocked-review categories are represented by exactly one prepared child issue body.
- **SC-002**: 100% of prepared child issue bodies include one valid fenced JSON Issue Contract with stable requirement ids.
- **SC-003**: 100% of prepared child issue bodies specify their intended ENG-2479 parent relationship and blocking dependency.
- **SC-004**: The child dependency chain can be followed from first prerequisite to final review-unblock handoff without ambiguity.
- **SC-005**: A reviewer can determine the next required actor and evidence for each prepared child body in under 5 minutes using only the issue descriptions and dependency notes.

## Assumptions

- ENG-347 is the root of the relevant Linear issue tree for ENG-2479.
- Four prepared child issue bodies are sufficient because they cover every active ENG-2479 blocker without duplicating existing ENG-392 child families.
- Any later issue-sync step should inherit the Engineering team, Symphony project, high priority, dogfood labels, and Sinfonista delegation pattern used by ENG-2479.
- The decomposition records planning and tracker structure only; it does not move ENG-2479 out of Blocked or re-run review.

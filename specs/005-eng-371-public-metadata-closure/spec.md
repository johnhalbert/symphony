# Feature Specification: ENG-371 Public Metadata Redaction Closure

**Feature Branch**: `[005-eng-371-public-metadata-closure]`

**Created**: 2026-06-11

**Status**: Draft

**Input**: User description: "Decompose blocked Linear issue ENG-371 after review loops found additional public metadata redaction boundaries and the issue later blocked at merge gate."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Prove public metadata is non-secret (Priority: P1)

As a Symphony operator or reviewer, I need every public project-context metadata surface to expose enough context for diagnosis while excluding credential-bearing values.

**Why this priority**: The original issue is security-sensitive. If public metadata leaks secrets, every prompt, log, summary, transcript, projection, or issue comment that consumes it becomes unsafe.

**Independent Test**: Can be tested by preparing project-context metadata from representative secret-bearing and non-secret inputs, then confirming only safe identifiers and redacted values appear in public output.

**Acceptance Scenarios**:

1. **Given** a project context contains tokens, private keys, profile contents, environment-backed values, or repository credentials, **When** the context is converted to public metadata, **Then** none of those credential values appear in the public result.
2. **Given** the same project context is exposed through direct helper usage and through normalized workflow configuration, **When** both public metadata results are compared, **Then** they enforce the same redaction policy.
3. **Given** a repository-like value contains ambiguous user-info, query, fragment, host, pathless, or single-label forms, **When** public metadata is produced, **Then** credential-like material is removed or the value fails closed instead of leaking.

---

### User Story 2 - Close the merge-gate blocker without expanding scope (Priority: P2)

As the operator, I need the blocked ENG-371 work to resolve its current merge-gate conflict while preserving the reviewed redaction behavior.

**Why this priority**: The current Linear blocker is merge-gate conflict cleanup after review passed. Expanding the scope would restart churn instead of closing the already-reviewed security fix.

**Independent Test**: Can be tested by applying only conflict-resolution changes and rerunning the focused redaction/config validation plus the merge-gate-required validation.

**Acceptance Scenarios**:

1. **Given** the ENG-371 implementation already passed redaction review, **When** merge conflicts are repaired, **Then** the repair keeps the public metadata behavior unchanged except where required by the current base.
2. **Given** the merge gate requires validation evidence, **When** the repair completes, **Then** the issue has focused validation evidence attached before it returns to review or merge-ready state.

---

### User Story 3 - Preserve review evidence for future child work (Priority: P3)

As a future worker or reviewer, I need the discovered redaction boundaries captured as explicit requirements so the same issues are not rediscovered in review.

**Why this priority**: The parent issue has already churned through repeated review loops. Capturing the boundaries prevents duplicated reviewer discovery.

**Independent Test**: Can be tested by deriving child issue contracts from this specification and confirming each contract has a fenced JSON requirement tied to a specific redaction or merge-gate obligation.

**Acceptance Scenarios**:

1. **Given** child issues are created from this specification, **When** they are inspected for Symphony eligibility, **Then** each contains a valid fenced JSON Issue Contract with stable requirement IDs.
2. **Given** a reviewer evaluates a child issue, **When** they compare worker proof to the contract, **Then** the proof target is specific enough to avoid broad rediscovery of the original ENG-371 scope.

### Edge Cases

- Repository-like values that contain `@`, `?`, or `#` before host or path boundaries.
- Pathless or single-label repository values that could be misclassified as safe host names.
- Missing optional project-context fields where the absence itself must remain distinguishable from redaction.
- Safe public identifiers that must remain visible for diagnosis without including backing credential values.
- Merge-gate repairs where the base branch changed validation expectations after review passed.

## Constitution Coverage *(mandatory)*

- **Authority Boundary**: Symphony owns lifecycle, merge-gate, tracker writeback, and public metadata policy. Worker or reviewer agents may repair scoped code and provide evidence, but must not bypass service-owned merge or tracker state transitions.
- **Credential And Secret Handling**: Public metadata must not expose tokens, private keys, raw credential profile values, environment values, repository credentials, or secret-bearing configuration. Evidence must use redacted fixtures and avoid real secrets.
- **Issue Contract Source**: Child issues derived from this spec must include fenced JSON contracts with requirement IDs for redaction parity, ambiguous repository handling, merge-gate repair, and validation evidence.
- **Audit And Replay Evidence**: Completion evidence must show the redaction matrix and merge-gate validation result. The issue history must distinguish security behavior changes from conflict-only repairs.
- **Protected Or Vendored Surfaces**: Protected workflow, credential, tracker, and generated context surfaces are in scope only where required for public metadata behavior. Vendored source and operator-controlled state are out of scope.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Symphony MUST provide public project-context metadata that omits all credential-bearing values while preserving non-secret context needed for operator diagnosis.
- **FR-002**: Public metadata produced from direct helper paths and from normalized workflow configuration MUST enforce the same redaction behavior.
- **FR-003**: Public metadata MUST preserve safe context identifiers, labels, capability names, and non-secret routing hints needed to understand which project context was used.
- **FR-004**: Repository-like values with ambiguous user-info, query, fragment, pathless, or single-label forms MUST not leak credential-like material.
- **FR-005**: If a value cannot be confidently classified as safe public metadata, Symphony MUST redact or omit the sensitive portion instead of exposing it.
- **FR-006**: The ENG-371 closure work MUST separate merge-gate conflict repair from new redaction behavior so reviewers can identify whether scope changed.
- **FR-007**: Completion evidence MUST include focused validation for the redaction matrix and any merge-gate validation required by the current base.
- **FR-008**: Any child issue produced from this spec MUST include a valid fenced JSON Issue Contract before delegation or promotion.

### Key Entities *(include if feature involves data)*

- **Project Context**: The logical project configuration selected for a Symphony issue, including public identity and secret-backed capability assignments.
- **Public Metadata Snapshot**: The redacted data shape that may appear in prompts, summaries, logs, transcripts, projections, or issue comments.
- **Secret-Bearing Field**: Any credential, token, private key, raw profile value, repository credential, or environment-backed value that must not appear in public metadata.
- **Review Finding**: A reviewer-discovered boundary that must become an explicit requirement before child issues are delegated.
- **Merge-Gate State**: The current readiness and conflict status that determines whether the issue can return to merge-ready after validation.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: All redaction fixture cases produce public metadata with zero raw credential values.
- **SC-002**: Direct helper and normalized configuration paths produce equivalent public metadata for the same project context.
- **SC-003**: ENG-371 can return to review or merge-ready with evidence that the current change is either conflict-only repair or an explicitly bounded redaction fix.
- **SC-004**: Every child issue derived from this spec passes Symphony issue-contract preflight before delegation.

## Assumptions

- ENG-371 remains attached to its existing parent and pull request until a later plan or operator decision says otherwise.
- The current blocker is primarily merge-gate conflict cleanup; new implementation work should be limited to redaction findings that are still reproducible against the current base.
- Real credential values are never required for validation; synthetic fixtures are sufficient.

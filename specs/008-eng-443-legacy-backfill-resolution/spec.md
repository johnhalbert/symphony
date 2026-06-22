# Feature Specification: ENG-443 Legacy Backfill Resolution

**Feature Branch**: `[008-eng-443-legacy-backfill-resolution]`

**Created**: 2026-06-11

**Status**: Draft

**Input**: User description: "Decompose blocked Linear issue ENG-443 after review found the active pull request appears empty against current main and the required legacy backfill behavior may already exist."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Decide whether the backfill requirement is already satisfied (Priority: P1)

As the operator, I need ENG-443 to first prove whether current main already satisfies the legacy run and workspace project-context backfill requirement.

**Why this priority**: The issue is blocked because the current pull request appears to contain no meaningful change. Merging a no-op does not improve Symphony and keeps the parent issue churning.

**Independent Test**: Can be tested by comparing current base behavior to the ENG-443 issue contract and recording whether legacy run and workspace records read back with safe default or legacy project-context metadata.

**Acceptance Scenarios**:

1. **Given** current main already backfills legacy run and workspace context on read, **When** ENG-443 is evaluated, **Then** the issue is resolved by attaching proof and closing, retargeting, or replacing the no-op pull request rather than merging it.
2. **Given** current main does not satisfy one or more legacy backfill scenarios, **When** the gap is identified, **Then** the remaining work is narrowed to the exact missing read path.

---

### User Story 2 - Implement only a proven missing backfill path (Priority: P2)

As a reviewer, I need any ENG-443 implementation work to be tied to a failing legacy-read scenario so the review does not repeat no-op loops.

**Why this priority**: If the base already meets the contract, implementation is unnecessary. If it does not, the missing path must be explicit before code changes continue.

**Independent Test**: Can be tested by demonstrating a failing legacy-read case before the fix and a passing result after the fix, without changing unrelated behavior.

**Acceptance Scenarios**:

1. **Given** a legacy run record lacks project-context metadata, **When** it is read, **Then** Symphony returns stable non-secret default or legacy attribution.
2. **Given** a legacy workspace record lacks project-context metadata, **When** it is read, **Then** Symphony returns stable non-secret default or legacy attribution.
3. **Given** a proposed change does not alter any failing scenario, **When** it is reviewed, **Then** it is rejected as no-op or retargeted before merge.

---

### User Story 3 - Preserve historical readability without leaking secrets (Priority: P3)

As an operator diagnosing older runs, I need historical records to remain readable and safely attributed after multi-project context support.

**Why this priority**: The feature exists to keep old single-project history usable while Symphony becomes inherently multi-project.

**Independent Test**: Can be tested by reading representative older run and workspace records and confirming each has stable redacted project-context metadata.

**Acceptance Scenarios**:

1. **Given** older records were created before project-context metadata existed, **When** they are read after the backfill behavior is applied, **Then** they include a stable non-secret project context.
2. **Given** a legacy fallback value is derived from operator configuration, **When** it is exposed in readback or evidence, **Then** no credential values appear.

### Edge Cases

- The active pull request has no diff against current main.
- Current main satisfies the runtime behavior but lacks explicit evidence on the issue.
- Only run records or only workspace records are missing safe fallback metadata.
- Legacy records contain partial or malformed historical attribution.
- Default project context metadata exists but contains secret-backed configuration that must not be exposed.

## Constitution Coverage *(mandatory)*

- **Authority Boundary**: Symphony owns historical record readback, issue resolution evidence, pull-request publication, and tracker writeback. Workers must not merge or close lifecycle work outside service-owned paths.
- **Credential And Secret Handling**: Backfilled context metadata must be non-secret. Default and legacy attribution must not expose credential values, tokens, profile contents, private keys, or environment-backed values.
- **Issue Contract Source**: Child issues must include fenced JSON contracts for base-behavior proof, missing-path implementation if needed, no-op pull request resolution, and validation evidence.
- **Audit And Replay Evidence**: The issue must record whether the requirement was already satisfied by current main or which failing read path required a change. Replay must preserve historical readability.
- **Protected Or Vendored Surfaces**: Persistence readback, historical run/workspace records, pull-request state, and tracker resolution evidence are protected surfaces. Vendored source and operator secrets are out of scope.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: ENG-443 MUST first determine whether current main already satisfies legacy run and workspace project-context backfill on read.
- **FR-002**: If current main satisfies the contract, Symphony MUST resolve the issue through evidence, closure, retargeting, or replacement of the no-op pull request rather than merging an empty change.
- **FR-003**: If current main does not satisfy the contract, the remaining work MUST identify the exact failing legacy read path before implementation continues.
- **FR-004**: Legacy run records that lack project-context metadata MUST read back with stable non-secret default or legacy attribution.
- **FR-005**: Legacy workspace records that lack project-context metadata MUST read back with stable non-secret default or legacy attribution.
- **FR-006**: Backfilled metadata MUST preserve historical readability without exposing credential values or secret-backed configuration.
- **FR-007**: Validation evidence MUST distinguish base behavior proof, failing-before evidence, and passing-after evidence.
- **FR-008**: Any child issue produced from this spec MUST include a valid fenced JSON Issue Contract before delegation or promotion.

### Key Entities *(include if feature involves data)*

- **Legacy Run Record**: A historical run record created before project-context metadata was mandatory.
- **Legacy Workspace Record**: A historical workspace record created before project-context metadata was mandatory.
- **Backfilled Project Context**: Stable non-secret attribution supplied at read time for legacy records.
- **No-op Pull Request**: A pull request whose current diff does not materially change the behavior required by its issue contract.
- **Resolution Evidence**: The proof attached to the issue showing whether base already satisfied the contract or which missing path was fixed.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: ENG-443 has a recorded decision that classifies the active pull request as no-op, retargeted, or tied to a specific failing legacy-read scenario.
- **SC-002**: Legacy run and workspace readback scenarios either pass on current main with attached evidence or have a focused failing-before/passing-after validation path.
- **SC-003**: No empty or behaviorally redundant pull request is promoted as the resolution for ENG-443.
- **SC-004**: Every child issue derived from this spec passes Symphony issue-contract preflight before delegation.

## Assumptions

- ENG-443 should not produce code changes unless a concrete failing legacy-read scenario is found.
- Existing current-main behavior may already satisfy all or part of the contract; evidence is an acceptable outcome.
- Historical records do not need real credential values for validation, and any fixture values must be synthetic.

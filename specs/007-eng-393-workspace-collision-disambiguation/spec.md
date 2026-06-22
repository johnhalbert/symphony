# Feature Specification: ENG-393 Workspace Collision Disambiguation

**Feature Branch**: `[007-eng-393-workspace-collision-disambiguation]`

**Created**: 2026-06-11

**Status**: Draft

**Input**: User description: "Decompose blocked Linear issue ENG-393 after review loops discovered duplicate issue identifier, workspace key, branch fallback, legacy artifact, and exact-id readback collision requirements."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Keep duplicate issue identifiers separate (Priority: P1)

As a Symphony operator running multiple tracker contexts, I need issues with the same visible identifier in different contexts to receive distinct workspace identity, paths, and durable records.

**Why this priority**: Multi-project operation cannot be reliable if one context's issue can reuse or overwrite another context's workspace.

**Independent Test**: Can be tested by creating two tracker contexts with duplicate visible issue identifiers and confirming all workspace identity, path, readback, and cleanup operations remain context-specific.

**Acceptance Scenarios**:

1. **Given** two project contexts contain issues with the same visible identifier, **When** Symphony creates workspaces for both, **Then** each workspace has a distinct key and path.
2. **Given** an operator opens, summarizes, or resumes work for one exact issue, **When** another context has a matching visible identifier, **Then** Symphony selects the exact issue's workspace and records.
3. **Given** cleanup runs for one context's workspace, **When** another context has a duplicate visible identifier, **Then** the sibling workspace is not removed or reused.

---

### User Story 2 - Make branch fallback collision-safe (Priority: P2)

As a reviewer, I need branch name fallback and branch-template safety checks to remain collision-safe even when tracker branch metadata is absent.

**Why this priority**: Review found null branch metadata and cached safety decisions could let one issue's branch safety result leak into another issue's branch selection.

**Independent Test**: Can be tested by priming one context's branch safety result, then creating a second duplicate-identifier issue under the same branch-template rules and confirming the second issue still receives a collision-safe branch.

**Acceptance Scenarios**:

1. **Given** tracker branch metadata is missing for duplicate-context issues, **When** Symphony derives branch fallback names, **Then** the names are still unique for each issue context.
2. **Given** branch-template safety was evaluated for one issue, **When** another issue with a different context or identifier is evaluated, **Then** the previous safety result cannot falsely mark the new branch safe.
3. **Given** a configured branch template produces an unsafe branch for one duplicate identifier, **When** Symphony chooses a branch, **Then** it uses a context-safe alternative.

---

### User Story 3 - Preserve legacy workspace readability (Priority: P3)

As an operator, I need older workspace records and summaries created before context-safe naming to remain readable without blocking new collision-safe workspaces.

**Why this priority**: Review found legacy or reserved-prefix artifacts can interfere with new context-qualified workspace names if compatibility is not explicit.

**Independent Test**: Can be tested by loading legacy workspace records and then creating new context-qualified workspaces with duplicate visible identifiers.

**Acceptance Scenarios**:

1. **Given** a legacy workspace uses an older naming scheme, **When** Symphony reads it, **Then** the workspace remains available with clear legacy attribution.
2. **Given** a new context-qualified workspace would otherwise conflict with an older reserved-prefix artifact, **When** Symphony creates or opens the new workspace, **Then** the legacy artifact is migrated, escaped, or otherwise prevented from blocking the new safe name.
3. **Given** status pointers or continuation summaries refer to an exact issue identity, **When** duplicate visible identifiers exist, **Then** readback remains unambiguous.

### Edge Cases

- Tracker branch metadata is explicitly null or missing.
- A branch-template rule produces the same name for two different contexts.
- A branch-safety cache is primed by one issue and then reused for another issue.
- Legacy workspace keys or paths already use a reserved context prefix.
- Status pointers, summaries, and continuation records refer only to visible issue identifiers.
- Cleanup or reuse logic runs after one duplicate-context workspace already exists.

## Constitution Coverage *(mandatory)*

- **Authority Boundary**: Symphony owns workspace identity, branch fallback, cleanup, durable readback, and status pointer resolution. Agents must not manually rename, delete, or merge workspaces to repair collisions.
- **Credential And Secret Handling**: Workspace and branch metadata may include public project context identifiers but must not include credential values or secret-backed routing material.
- **Issue Contract Source**: Child issues must include fenced JSON contracts for duplicate identifier identity, branch fallback safety, identifier-sensitive safety decisions, legacy artifact compatibility, exact-id readback, and validation evidence.
- **Audit And Replay Evidence**: Workspace creation, reuse, cleanup, and readback must leave enough redacted evidence to explain which context and exact issue identity were selected.
- **Protected Or Vendored Surfaces**: Workspace management, branch naming, run transcript readback, status pointers, and cleanup behavior are protected surfaces. Vendored source is out of scope.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Symphony MUST distinguish workspace identity, paths, and durable records by exact issue identity and project context, not by visible issue identifier alone.
- **FR-002**: Workspace open, resume, summarize, status pointer, and cleanup operations MUST remain unambiguous when duplicate visible issue identifiers exist across contexts.
- **FR-003**: Branch fallback names MUST be collision-safe when tracker branch metadata is null or missing.
- **FR-004**: Branch-template safety decisions MUST be sensitive to the issue identity and project context being evaluated.
- **FR-005**: A safety decision computed for one issue MUST NOT cause a different issue to reuse an unsafe branch name.
- **FR-006**: Legacy workspace records and artifacts MUST remain readable while preventing older reserved or ambiguous names from blocking new context-safe workspaces.
- **FR-007**: Validation MUST include duplicate-context issue identifiers, null tracker branch metadata, branch-template fallback, identifier-sensitive safety decisions, and exact-id readback.
- **FR-008**: Any child issue produced from this spec MUST include a valid fenced JSON Issue Contract before delegation or promotion.

### Key Entities *(include if feature involves data)*

- **Exact Issue Identity**: The unambiguous issue reference including tracker identity and project context.
- **Visible Issue Identifier**: The human-facing issue key that may be duplicated across contexts.
- **Workspace Identity**: The durable key and path used to create, find, resume, summarize, and clean up work for an issue.
- **Branch Candidate**: A branch name derived from tracker metadata, configuration, or fallback rules.
- **Legacy Workspace Artifact**: A workspace record, path, summary, or status pointer created before context-safe identity rules.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Duplicate visible identifiers across at least two contexts produce distinct workspace keys and paths.
- **SC-002**: Null tracker branch metadata plus configured branch-template fallback produces distinct safe branch names for duplicate-context issues.
- **SC-003**: Exact-id open, resume, summarize, status pointer, and cleanup operations select the intended issue in duplicate-identifier scenarios.
- **SC-004**: Every child issue derived from this spec passes Symphony issue-contract preflight before delegation.

## Assumptions

- Existing workspaces created before context-safe identity remain operator-visible unless a later plan explicitly defines a migration or retirement step.
- The safest validation target is a focused matrix that creates collision scenarios intentionally rather than relying on incidental workspace names.
- Duplicate visible identifiers are expected in multi-project operation and must be treated as normal, not exceptional.

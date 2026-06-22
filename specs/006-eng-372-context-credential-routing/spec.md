# Feature Specification: ENG-372 Context Credential Routing

**Feature Branch**: `[006-eng-372-context-credential-routing]`

**Created**: 2026-06-11

**Status**: Draft

**Input**: User description: "Decompose blocked Linear issue ENG-372 after review loops discovered broader context-specific credential assignment, tracker routing, status lookup, and validation requirements."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Resolve credentials by project context (Priority: P1)

As a Symphony operator running multiple projects, I need each project context to use only the credentials assigned to that context and capability.

**Why this priority**: Multi-project operation is unsafe if a context can silently borrow a default credential or expose another project's credential material.

**Independent Test**: Can be tested by configuring at least two project contexts with distinct capability credentials and confirming each context resolves only its own credential profile without exposing credential values.

**Acceptance Scenarios**:

1. **Given** two project contexts assign different credentials for the same capability, **When** Symphony resolves credentials for one context, **Then** only that context's assigned credential is available to the capability.
2. **Given** a context-specific profile overrides only part of a structured credential profile, **When** the credential is resolved, **Then** required inherited profile attributes remain available and secret values stay hidden from public output.
3. **Given** no credential is assigned for a requested capability, **When** Symphony attempts to use that capability, **Then** the request fails closed with a redacted explanation.

---

### User Story 2 - Route live tracker and status reads through the issue context (Priority: P2)

As an operator, I need candidate polling, review polling, status lookup, and issue-breakdown flows to contact the tracker client for the issue's project context, not an unrelated default context.

**Why this priority**: Review found that some live reads could still fall back to the default tracker, which breaks projects that require context-specific tracker credentials.

**Independent Test**: Can be tested by using distinct default and secondary tracker credentials, then verifying each live issue read and mutation precursor resolves the target issue through the correct context.

**Acceptance Scenarios**:

1. **Given** an issue belongs to a non-default project context, **When** Symphony polls candidates or review status, **Then** it uses the tracker access assigned to that issue's context.
2. **Given** a status or workspace action starts with only an issue identifier, **When** Symphony needs live tracker data, **Then** it first resolves the issue to an unambiguous context and canonical tracker identity.
3. **Given** an issue-breakdown request or apply action needs tracker data, **When** it runs for a context-specific issue, **Then** it follows the same context resolution rules as polling and status lookup.

---

### User Story 3 - Give reviewers a stable validation matrix (Priority: P3)

As a reviewer, I need deterministic evidence that credential assignment and tracker routing work across the known multi-project paths so I do not rediscover missing paths one review round at a time.

**Why this priority**: ENG-372 churned because each review round found another path that still assumed a default context.

**Independent Test**: Can be tested by running a focused validation matrix that covers credential merge behavior, context-specific tracker reads, identifier-only fallback, and issue-breakdown flows.

**Acceptance Scenarios**:

1. **Given** the validation matrix is run, **When** all required paths pass, **Then** the reviewer can see which contexts, capabilities, and live-read flows were covered.
2. **Given** a validation path fails, **When** the failure is reported, **Then** it identifies the unresolved context or capability boundary without exposing credential values.

### Edge Cases

- A secondary project context has no usable default tracker credential.
- The same credential profile name is reused with different context-level assignments.
- A structured credential profile override omits fields that should be inherited.
- A status or workspace action receives an identifier rather than a canonical tracker identity.
- Two contexts contain issues with similar or duplicate identifiers.
- A validation stub passes without proving the real context-specific tracker behavior.

## Constitution Coverage *(mandatory)*

- **Authority Boundary**: Symphony owns credential resolution, tracker client selection, lifecycle/status routing, and issue-breakdown tracker access. Agents must not use ad hoc credentials or bypass service-owned routing.
- **Credential And Secret Handling**: Capability credentials, profile contents, tracker tokens, GitHub credentials, and environment-backed values must remain out of logs, prompts, issue descriptions, validation output, and public metadata.
- **Issue Contract Source**: Child issues must include fenced JSON contracts for credential assignment, structured profile inheritance, context-specific live tracker routing, identifier-only fallback, issue-breakdown routing, and validation evidence.
- **Audit And Replay Evidence**: Symphony must leave redacted evidence showing which context and capability were selected for each live access path. Replay must not depend on hidden default-context assumptions.
- **Protected Or Vendored Surfaces**: Credential configuration, tracker routing, lifecycle status, issue breakdown, and runtime handoff boundaries are protected surfaces. Vendored source and operator secrets are out of scope.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Symphony MUST support context-specific credential profile assignments for each service capability that can vary by project context.
- **FR-002**: Context-specific credential resolution MUST preserve required structured profile attributes while allowing scoped overrides.
- **FR-003**: Credential resolution MUST never expose raw credential values, profile contents, tokens, or private keys through public metadata, logs, prompts, issue comments, or validation output.
- **FR-004**: Live tracker reads for candidate polling, reviewer polling, status lookup, and issue-breakdown flows MUST select the tracker client for the target issue's resolved project context.
- **FR-005**: Identifier-only actions MUST resolve to an unambiguous project context and canonical tracker identity before using live tracker data.
- **FR-006**: If an issue cannot be resolved to a context-specific tracker safely, Symphony MUST fail closed with a redacted operator-facing reason.
- **FR-007**: Context-specific credential and tracker routing behavior MUST be validated with real routing behavior rather than stubs that can pass while default fallback remains broken.
- **FR-008**: Any child issue produced from this spec MUST include a valid fenced JSON Issue Contract before delegation or promotion.

### Key Entities *(include if feature involves data)*

- **Project Context**: The configured project boundary that determines tracker, repository, runtime, and credential routing.
- **Credential Profile Assignment**: A capability-scoped mapping from project context to secret-backed credential material.
- **Structured Credential Profile**: A credential profile with multiple required attributes, some of which may be inherited and some overridden by context.
- **Live Tracker Access Path**: Any polling, status, workspace, review, or issue-breakdown action that needs current tracker data.
- **Canonical Tracker Identity**: The unambiguous tracker-side issue identity used after resolving a user-facing issue identifier.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The validation matrix demonstrates at least two project contexts with distinct credential assignments for the same capability.
- **SC-002**: Every covered live tracker access path resolves through the issue's project context with no default-context fallback when context data is available.
- **SC-003**: Identifier-only actions either resolve to one canonical context and tracker identity or fail closed with a redacted reason.
- **SC-004**: Every child issue derived from this spec passes Symphony issue-contract preflight before delegation.

## Assumptions

- The parent ENG-372 issue remains the container for this decomposition until child issues are created and linked.
- The default project context may still exist for legacy compatibility, but it must not mask missing context-specific routing.
- Synthetic credential fixtures are sufficient for validation; real secret values are not required and must not be copied into artifacts.

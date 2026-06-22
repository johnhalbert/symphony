# Feature Specification: Symphony Owned Tracker

**Feature Branch**: `004-symphony-owned-tracker`

**Created**: 2026-06-08

**Status**: Draft

**Input**: User description: "I want to create a Symphony owned tracker that can take the place of Linear. We'll need to ensure semantics match Symphony's current expectations, and refactor areas that are currently tightly coupled to Linear. The tracker should encode native Symphony Issue and IssueBlockerRef in the Symphony datastore (postgres now). The scope for this change needs to be tight, and shouldn't include work for the projection layer. The end goal of this change should be to have MVP tracker that is capable of replacing Linear, and the smallest changeset to the Symphony runtime to enable that tracker."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Run From Symphony-Owned Issues (Priority: P1)

An operator can configure Symphony to use a Symphony-owned tracker instead of Linear, seed an eligible issue with the same issue fields Symphony already expects, and have the runtime dispatch work from that issue without requiring Linear availability.

**Why this priority**: This is the MVP replacement path. Without this, Symphony cannot prove that a native tracker can stand in for Linear.

**Independent Test**: Can be tested by configuring a local workflow to use the Symphony-owned tracker, creating one eligible issue with a valid issue contract, starting the runtime, and confirming the issue is selected for worker dispatch using the same eligibility rules as the current tracker path.

**Acceptance Scenarios**:

1. **Given** a Symphony-owned issue in an active state with required labels, no open blockers, and an agent-eligible issue contract, **When** the runtime polls for work, **Then** Symphony treats the issue as a candidate and starts the normal worker flow.
2. **Given** Linear credentials are absent and the Symphony-owned tracker is selected, **When** the runtime starts and polls for work, **Then** tracker reads succeed without contacting Linear.
3. **Given** an issue is assigned or delegated according to the configured worker routing rules, **When** candidates are fetched, **Then** the issue's worker eligibility matches the current tracker behavior.

---

### User Story 2 - Preserve Tracker Semantics (Priority: P2)

An operator can rely on the Symphony-owned tracker to return issue data with the same meaning Symphony currently expects from Linear, including stable identifiers, state names, labels, timestamps, branch hints, and blocker references.

**Why this priority**: Runtime behavior depends on tracker semantics, not only field names. A replacement tracker that returns similarly shaped data but different meanings would cause unsafe dispatch, skipped work, or incorrect blocking.

**Independent Test**: Can be tested by creating representative issues for active, review, blocked, handoff, and terminal states, including open and resolved blockers, then confirming dispatch, review, blocker, and lifecycle decisions match the existing tracker expectations.

**Acceptance Scenarios**:

1. **Given** an issue has an open blocker whose state is not terminal, **When** Symphony evaluates worker or reviewer eligibility, **Then** the issue is not dispatched.
2. **Given** an issue's blockers are all in terminal states, **When** Symphony evaluates eligibility, **Then** the blockers do not prevent dispatch.
3. **Given** an operator requests an issue by either durable ID or human identifier, **When** Symphony refreshes the issue, **Then** the selected tracker resolves the same issue consistently.
4. **Given** labels differ only by case or spacing conventions, **When** Symphony applies label guardrails, **Then** include and exclude decisions match current behavior.

---

### User Story 3 - Service-Owned Tracker Mutations (Priority: P3)

Symphony can perform the minimum service-owned tracker mutations needed for normal runtime operation against the Symphony-owned tracker, while preserving durable evidence and idempotent behavior.

**Why this priority**: A read-only tracker can start work, but replacement of Linear requires Symphony-owned transitions and writeback for normal handoff, review, blocked, and terminal flows.

**Independent Test**: Can be tested by completing a worker or reviewer flow that requests a state transition and comment, then restarting Symphony and confirming the issue state, writeback evidence, and issue history remain consistent with no duplicate visible effects.

**Acceptance Scenarios**:

1. **Given** a runtime flow requests a tracker state transition, **When** the Symphony-owned tracker is selected, **Then** the issue state changes only when the current state allows the requested transition.
2. **Given** a runtime flow writes a tracker comment with an idempotency key, **When** the same write is retried, **Then** Symphony records or verifies one logical comment effect.
3. **Given** issue creation or blocker relation creation is not supported for the MVP, **When** an existing optional flow requests that operation, **Then** Symphony fails closed with an explicit unsupported-operation result instead of silently losing data.

---

### User Story 4 - Keep Linear Available (Priority: P4)

An operator can continue using the existing Linear tracker unchanged while the Symphony-owned tracker is introduced as a separate selectable tracker.

**Why this priority**: The change should be low risk and should not force migration for existing workflows.

**Independent Test**: Can be tested by running the existing Linear-backed tracker flow after the Symphony-owned tracker is added and confirming the current Linear behavior and configuration remain valid.

**Acceptance Scenarios**:

1. **Given** a workflow is configured for Linear, **When** Symphony starts, **Then** it uses the existing Linear tracker behavior.
2. **Given** a workflow is configured for the Symphony-owned tracker, **When** Symphony starts, **Then** Linear-specific credential checks do not block the selected tracker.
3. **Given** tracker diagnostics are run for either tracker selection, **When** a tracker-specific check is not applicable, **Then** Symphony reports a tracker-appropriate result rather than a misleading Linear failure.

### Edge Cases

- The selected tracker contains duplicate human identifiers.
- An issue is missing a required stable ID, identifier, title, or state.
- A blocker reference points to an issue that no longer exists or has no known state.
- State names in stored issues do not match any configured active, review, blocked, handoff, or terminal state.
- The datastore is unavailable during runtime startup, polling, or writeback retry.
- Two runtime processes attempt to transition or comment on the same issue concurrently.
- Existing optional issue-splitting flows request child issue creation or blocker relation creation before MVP support exists.
- Projection and status data may still be incomplete for tracker-owned fields that are outside this feature's scope.

## Constitution Coverage *(mandatory)*

- **Authority Boundary**: Symphony service owns all Symphony-owned tracker reads and mutations. Workers and reviewers may consume issue context through existing runtime prompts and service-owned MCP paths, but must not directly mutate tracker records or bypass the tracker writeback path. Linear remains owned by the existing Linear integration when selected.
- **Credential And Secret Handling**: The Symphony-owned tracker must not require Linear credentials. Datastore credentials remain service-owned configuration and must not appear in issue descriptions, prompts, logs, transcripts, diagnostics, or Spec Kit artifacts. Tracker errors must redact connection details and credential material.
- **Issue Contract Source**: Symphony-owned issues intended for planning, implementation, review, writeback, or agent dispatch must still carry the fenced JSON issue contract in the issue description before promotion or delegation. The existing contract shape, requirement IDs, requirement text, optional proof hints, and contract hash semantics remain authoritative.
- **Audit And Replay Evidence**: Tracker state changes, comments, and supported relationship changes must be durable, replay-safe, and idempotent. Retries and restarts must distinguish already-applied effects from failed, skipped, unsupported, or blocked effects.
- **Protected Or Vendored Surfaces**: In scope are tracker selection, runtime tracker construction, tracker diagnostics, tracker writeback capability checks, and native issue/blocker persistence. Out of scope are projection-layer schema, projection build behavior, vendored upstream source, worker-owned direct datastore mutation, and implicit cleanup of operator-controlled state.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide a selectable Symphony-owned tracker that can be used instead of Linear for runtime issue reads.
- **FR-002**: System MUST keep the existing Linear tracker available and behaviorally unchanged when Linear is selected.
- **FR-003**: System MUST store native Symphony issue records with all fields required by the current runtime issue contract: durable ID, human identifier, title, description, priority, state, branch hint, URL, assignee, delegate, worker-routing eligibility, labels, blockers, created time, and updated time.
- **FR-004**: System MUST store native Symphony blocker references with the fields required by current runtime blocker semantics: blocker durable ID, blocker human identifier, and blocker state.
- **FR-005**: System MUST return issues for candidate, state-filtered, and explicit refresh lookups with the same meaning currently expected by the runtime.
- **FR-006**: System MUST resolve explicit issue refreshes by durable ID and human identifier when the selected tracker owns both values.
- **FR-007**: System MUST classify blocker references as open when their state is unknown or not terminal, and as non-blocking when their state is terminal.
- **FR-008**: System MUST apply existing state, label, assignment, delegation, and blocker eligibility semantics to Symphony-owned issues.
- **FR-009**: System MUST support the minimum tracker mutations needed by normal runtime operation: issue state transition and idempotent comment writeback.
- **FR-010**: System MUST make unsupported optional tracker mutations explicit and safe, including child issue creation and blocker relation creation when those operations are not part of the MVP.
- **FR-011**: System MUST remove Linear-only startup, diagnostic, and writeback credential assumptions from runtime paths when the Symphony-owned tracker is selected.
- **FR-012**: System MUST fail closed when the selected tracker cannot prove issue identity, current state, blocker status, or writeback idempotency.
- **FR-013**: System MUST leave projection-layer behavior and projection storage out of scope for this feature.
- **FR-014**: System MUST provide enough operator-facing diagnostics to confirm which tracker is selected and whether its issue reads, state lists, and writeback capabilities are available.

### Key Entities *(include if feature involves data)*

- **Symphony Issue**: A tracker-owned work item used by Symphony for dispatch, review, lifecycle decisions, and writeback. Key attributes include stable ID, human identifier, title, description, priority, state, branch hint, URL, assignee, delegate, worker-routing eligibility, labels, blockers, and tracker timestamps.
- **Issue Blocker Reference**: A relationship summary indicating that one issue is blocked by another issue. Key attributes include blocker ID, blocker identifier, and blocker state.
- **Tracker Selection**: The operator choice that determines whether Symphony reads and mutates Linear-backed issues or Symphony-owned issues.
- **Tracker Writeback Evidence**: A durable record or verifiable effect showing whether a tracker mutation was applied, verified, skipped, unsupported, or failed.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A workflow configured for the Symphony-owned tracker can dispatch one eligible issue through the normal worker start path without any Linear credentials or Linear service availability.
- **SC-002**: For representative active, review, blocked, handoff, and terminal issues, Symphony-owned tracker eligibility decisions match the current tracker behavior in 100% of defined validation cases.
- **SC-003**: An issue with one unresolved blocker is not dispatched, and the same issue becomes eligible within one polling cycle after all blockers are marked terminal.
- **SC-004**: A completed worker or reviewer flow can apply a state transition and comment, restart the service, retry writeback, and observe no duplicate logical tracker effects.
- **SC-005**: Existing Linear-backed workflows continue to pass the same tracker read and writeback validation cases after the Symphony-owned tracker is introduced.
- **SC-006**: The MVP change can be validated without requiring projection-layer changes or projection rebuild behavior changes.

## Assumptions

- The MVP targets service-owned runtime replacement of Linear, not a full user-facing issue management product.
- The existing runtime issue and blocker field meanings are the compatibility contract for the Symphony-owned tracker.
- The configured datastore is the persistence authority for Symphony-owned tracker records.
- Existing issue contract validation remains required before agent-eligible dispatch.
- Child issue creation and blocker relation creation may be deferred if they fail closed and optional flows are not required for the MVP replacement path.
- Projection-layer changes are intentionally deferred; any status or projection limitations discovered during implementation will be documented rather than folded into this feature.

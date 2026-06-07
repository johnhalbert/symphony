# Feature Specification: Multi-Project Configuration

**Feature Branch**: `003-multi-project-config`
**Created**: 2026-06-07
**Status**: Draft
**Input**: User description: "Symphony must not be 1:1 with a single project. Its design must be inherently multi-project, and should support configuration for more than one codebase and linear project simultaneously."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Configure multiple project contexts (Priority: P1)

As a Symphony operator, I want one Symphony configuration to define multiple project contexts, so that a single Symphony service can understand more than one codebase and more than one Linear project without being redesigned around a single project.

**Why this priority**: This is the core product requirement. If the configuration model remains tied to one codebase and one Linear project, all later multi-project behavior will be fragile or impossible.

**Independent Test**: Configure at least two named project contexts, each with its own codebase source and Linear project, then validate that Symphony accepts the configuration and reports each context as a first-class configured project.

**Acceptance Scenarios**:

1. **Given** an operator defines two named project contexts with different codebases and different Linear projects, **When** Symphony loads the configuration, **Then** both contexts are accepted and visible as distinct project contexts.
2. **Given** an operator defines three named project contexts where two share a codebase but use different Linear projects, **When** Symphony loads the configuration, **Then** the shared codebase is allowed only because each context is explicitly named and independently addressable.
3. **Given** an operator defines two contexts with duplicate identifiers, missing Linear project references, or missing codebase references, **When** Symphony validates the configuration, **Then** validation fails with the affected context and required correction.

---

### User Story 2 - Route work to the correct codebase and Linear project (Priority: P1)

As a Symphony operator, I want every issue, run, workspace, and service-owned writeback to resolve to exactly one project context before work begins, so that Symphony never applies code changes or Linear lifecycle changes to the wrong project.

**Why this priority**: Multi-project support is only safe if routing is deterministic before dispatch. Incorrect routing would create cross-project data loss, wrong-codebase changes, or wrong Linear writeback.

**Independent Test**: Provide eligible issues from two configured Linear projects, start work for each, and confirm each run uses the codebase, workspace identity, lifecycle states, and Linear writeback target associated with its resolved project context.

**Acceptance Scenarios**:

1. **Given** an eligible issue belongs to Linear Project A, which maps to Codebase A, **When** Symphony dispatches the issue, **Then** the run uses Codebase A and writes lifecycle evidence back to Linear Project A.
2. **Given** an eligible issue belongs to Linear Project B, which maps to Codebase B, **When** Symphony dispatches the issue while a Project A run is also active, **Then** the Project B run uses Codebase B without reusing Project A workspace or tracker settings.
3. **Given** an issue cannot be resolved to a single project context, **When** Symphony evaluates it for dispatch, **Then** Symphony does not create a workspace or mutate Linear state and instead reports a human-required routing problem.

---

### User Story 3 - Run multiple projects simultaneously (Priority: P2)

As a Symphony operator, I want Symphony to poll, dispatch, review, and record activity across multiple configured projects at the same time, so that one slow or unhealthy project does not force a separate Symphony instance for every codebase.

**Why this priority**: The user explicitly requires simultaneous support for more than one codebase and Linear project. Concurrency and isolation make that support operationally useful.

**Independent Test**: Run active work for at least two project contexts at the same time, including one worker run and one reviewer run, and confirm each project keeps separate queue eligibility, workspace state, run records, and lifecycle writeback.

**Acceptance Scenarios**:

1. **Given** Project A and Project B both have eligible work, **When** Symphony polls for work, **Then** it discovers candidates from both configured Linear projects in one service cycle.
2. **Given** a Project A run and a Project B run execute concurrently, **When** each run creates or reuses local workspace state, **Then** their workspace keys, paths, run records, and transcripts remain distinct.
3. **Given** Project A has a configuration or credential problem, **When** Project B remains valid, **Then** Symphony reports the Project A problem without blocking eligible Project B work.

---

### User Story 4 - Preserve project attribution in operator views and history (Priority: P2)

As a Symphony operator, I want every board item, run, workspace, transcript, approval, and review record to show its project context, so that I can understand and filter activity across multiple projects without relying on issue identifiers alone.

**Why this priority**: Linear issue identifiers can collide across projects, and operators need durable attribution to diagnose behavior after runs finish.

**Independent Test**: Create records for two project contexts with overlapping issue identifiers or similar issue titles, then inspect operator-facing views and durable history to confirm the records remain distinguishable by project context.

**Acceptance Scenarios**:

1. **Given** two Linear projects both contain an issue with identifier `ENG-123`, **When** Symphony displays board, history, and run details, **Then** each item remains distinguishable by project context and tracker project.
2. **Given** an operator filters or groups active work by project context, **When** multiple projects have active and historical records, **Then** only matching project records appear in the filtered view.
3. **Given** an operator inspects a completed run, **When** the run record is displayed or replayed, **Then** it includes the project context, codebase source identity, Linear project identity, and workspace identity used by that run.

---

### User Story 5 - Migrate from single-project usage safely (Priority: P3)

As an existing Symphony operator, I want my current single-project configuration to remain valid as one default project context, so that adopting the multi-project model is incremental rather than a breaking migration.

**Why this priority**: Backward compatibility reduces rollout risk, but it follows the core multi-project model rather than preserving single-project assumptions forever.

**Independent Test**: Load an existing single-project configuration, confirm Symphony represents it as one project context, then add a second context and confirm both contexts can operate without changing the meaning of existing records.

**Acceptance Scenarios**:

1. **Given** an existing valid single-project configuration, **When** Symphony loads it after this feature, **Then** it is treated as one default project context and existing behavior is preserved.
2. **Given** an operator adds a second project context to an existing configuration, **When** Symphony next loads configuration, **Then** existing work keeps its original context and new work can route to either configured context.
3. **Given** historical records were created before explicit project contexts existed, **When** an operator views or replays them, **Then** Symphony identifies them with a legacy or default context rather than leaving project attribution blank.

### Edge Cases

- Two Linear projects use the same issue identifier, issue title, team state names, or workflow state names.
- Two project contexts intentionally share the same codebase but use different Linear projects.
- Two project contexts intentionally share the same Linear project but use different codebases.
- A configuration reload changes a project context while a run from that context is already in progress.
- A configured project context is disabled, paused, invalid, or missing credentials while other contexts remain healthy.
- A Linear issue moves between projects after Symphony has already created a run or workspace for it.
- A workspace path, branch name, cache key, transcript key, or run identifier would collide unless project context is included.
- An issue cannot be matched to any configured project context or matches more than one context.
- A context-specific credential, repository, or tracker setting is unavailable and must be reported without exposing secret values.
- Historical single-project records do not contain explicit project context metadata.

## Constitution Coverage *(mandatory)*

- **Authority Boundary**: Symphony owns project context resolution, workspace creation, tracker polling, Linear lifecycle writeback, review handoff, approval handling, and external workflow mutations for every configured project context. Workers and reviewers must receive their resolved context from Symphony and must not select, change, or infer an alternate project context through prompts, terminal actions, or delegated tools.
- **Credential And Secret Handling**: Project context identifiers, codebase labels, Linear project labels, and routing decisions are non-secret metadata. Linear API keys, GitHub credentials, runtime credentials, environment values, profile contents, and private repository access material must not appear in configuration summaries, issue descriptions, prompts, transcripts, logs, validation errors, or Spec Kit artifacts. Context-specific credential failures must identify the affected context without printing credential values.
- **Issue Contract Source**: Future Linear issues generated from this spec must use the fenced JSON issue contract as the authoritative requirement source. Each generated issue should identify the applicable project context and requirement IDs in prose, while the fenced JSON block remains the source of truth for delegated work and review proof.
- **Audit And Replay Evidence**: Every run, workspace record, transcript, approval, review, publication handoff, lifecycle writeback, and routing failure must preserve enough redacted evidence to reconstruct the project context, codebase source, Linear project, workspace identity, and configuration decision that applied at the time. Retries and replay must not re-route an in-progress or historical run to a different project context because configuration changed later.
- **Protected Or Vendored Surfaces**: The feature may touch Symphony-owned configuration, workflow loading, workspace management, tracker integration, lifecycle writeback, run records, transcripts, operator-facing projections, and documentation. Vendored runtime source, operator-controlled secret stores, existing dirty workspaces, protected branches, and external project state are out of scope unless a later plan explicitly ratifies a protected-surface change.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Symphony MUST support a single configuration containing two or more named project contexts.
- **FR-002**: Each project context MUST have a stable, unique operator-defined identifier suitable for display, routing evidence, and durable records.
- **FR-003**: Each project context MUST associate a codebase source with a Linear project for issue discovery, workspace creation, lifecycle state interpretation, and writeback.
- **FR-004**: Symphony MUST allow multiple project contexts to reuse the same codebase or the same Linear project only when that reuse is explicitly configured and remains unambiguous.
- **FR-005**: Symphony MUST resolve every candidate issue, run, workspace, review, approval, and lifecycle writeback to exactly one project context before taking workflow-affecting action.
- **FR-006**: Symphony MUST fail closed before workspace creation, agent dispatch, or Linear mutation when a candidate issue has no matching context or has more than one possible context.
- **FR-007**: Symphony MUST discover eligible work from multiple configured Linear projects during the same service operation.
- **FR-008**: Symphony MUST support active work from more than one project context at the same time while preserving configured global and project-specific concurrency limits.
- **FR-009**: Symphony MUST create, reuse, and clean up workspaces using the codebase source and workspace policy of the resolved project context.
- **FR-010**: Symphony MUST apply Linear comments, lifecycle transitions, review handoffs, and completion writeback only to the Linear project associated with the resolved project context.
- **FR-011**: Symphony MUST ensure worker, reviewer, planner, issue-breakdown, merge-repair, and service-owned publication flows receive the resolved project context before they act on project-specific data.
- **FR-012**: Symphony MUST prevent delegated agents from changing the resolved project context through their own prompts, command surfaces, or completion reports.
- **FR-013**: Symphony MUST namespace workspace keys, run identifiers, transcript records, approval records, review records, and operator-facing aliases so same-looking Linear identifiers from different projects remain distinct.
- **FR-014**: Symphony MUST record the resolved project context identifier, codebase source identity, Linear project identity, workspace identity, and routing source for every started run.
- **FR-015**: Symphony MUST record routing failures with the affected project context candidates and the reason no safe single context was available.
- **FR-016**: Symphony MUST expose project context attribution in operator-facing board, run, workspace, transcript, approval, review, and history views.
- **FR-017**: Operators MUST be able to filter or group active and historical work by project context.
- **FR-018**: Symphony MUST validate configuration for duplicate context identifiers, missing codebase definitions, missing Linear project definitions, ambiguous context matching, and context-specific credential/profile gaps.
- **FR-019**: Symphony MUST report context-specific validation or runtime problems without blocking unrelated healthy contexts when safe operation can continue for those contexts.
- **FR-020**: Symphony MUST preserve the resolved project context for in-progress runs when configuration reloads or project definitions change after dispatch.
- **FR-021**: Symphony MUST represent existing single-project configuration as one default or legacy project context so current valid workflows continue to operate.
- **FR-022**: Symphony MUST assign historical records without explicit context metadata to a legacy or default project context for display and replay compatibility.
- **FR-023**: Symphony MUST allow project-specific workflow settings that naturally differ by project, including tracker states, workspace policy, codebase source, repository publication target, prompt extensions, protected paths, and credential profile assignments, while permitting shared defaults where values are intentionally common.
- **FR-024**: Symphony MUST keep project context identifiers and routing metadata non-secret, and MUST redact credential values, environment values, private keys, and profile contents from all durable and operator-facing evidence.
- **FR-025**: Symphony MUST include validation coverage for multi-context loading, issue routing, same-identifier collisions, concurrent runs across contexts, context-specific failures, single-project compatibility, configuration reloads, and durable project attribution.

### Key Entities

- **Project Context**: A named configuration unit that binds project-specific codebase, tracker, workspace, credential, safety, and workflow behavior under one stable identifier.
- **Codebase Source**: The repository, local path, branch policy, workspace policy, and related code access settings used by a project context.
- **Linear Project**: The tracker project whose issues, lifecycle states, comments, and writeback operations belong to a project context.
- **Project Context Resolution**: The decision that assigns an issue, run, workspace, review, approval, or writeback operation to exactly one project context before workflow-affecting action occurs.
- **Project-Scoped Workspace**: The local workspace created or reused for a run under the codebase and workspace policy of its resolved project context.
- **Project-Scoped Run Evidence**: Durable, redacted run and transcript data that preserves project context attribution for audit, replay, filtering, and diagnosis.
- **Routing Problem**: A missing, ambiguous, invalid, disabled, or credential-blocked context decision that prevents safe dispatch or writeback until corrected.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Operators can configure at least three project contexts in one Symphony configuration, including at least two different codebases and at least two different Linear projects, and validation identifies all contexts by name.
- **SC-002**: In validation runs with eligible issues from two Linear projects, 100% of runs use the codebase and Linear writeback target assigned to the issue's resolved project context.
- **SC-003**: In validation runs where two configured Linear projects contain the same issue identifier, 100% of board, history, run, workspace, and transcript records remain distinguishable by project context.
- **SC-004**: At least two project contexts can have active worker or reviewer activity at the same time without workspace key, run record, transcript, or lifecycle writeback collisions.
- **SC-005**: 100% of missing, duplicate, or ambiguous project context routing cases are reported before workspace creation, agent dispatch, or Linear lifecycle mutation.
- **SC-006**: Existing valid single-project configurations continue to load and dispatch work as one default or legacy project context with no required operator changes.
- **SC-007**: 100% of context-specific credential, tracker, or codebase validation failures identify the affected project context and do not expose secret values.
- **SC-008**: 100% of completed, failed, cancelled, retried, and replayed runs preserve the project context, codebase source identity, Linear project identity, and workspace identity used at dispatch time.
- **SC-009**: Operators can filter active and historical work by project context and see only matching records in the filtered result.

## Assumptions

- Linear remains the tracker kind in scope for this feature; support for additional tracker products is out of scope unless planned separately.
- A project context is the core design unit, even when only one context is configured.
- Each run has one primary resolved project context. A single run that intentionally changes multiple codebases or multiple Linear projects is out of scope for the initial feature and should be handled by separate issues or a later cross-project orchestration feature.
- Existing single-project settings can be mapped into a default or legacy context for compatibility.
- Shared defaults may still exist for values that are truly common across projects, but project-specific values must not depend on a hidden global single-project assumption.
- Project context identifiers, codebase labels, Linear project labels, and routing metadata are non-secret.

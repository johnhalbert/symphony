# Feature Specification: Configure Agent Role Models

**Feature Branch**: `002-agent-role-models`
**Created**: 2026-06-04
**Status**: Draft
**Input**: User description: "I want to be able to configure independent models for planner, reviewer and worker. The user-facing dashboard planning agent could be gpt-5.5, while the worker could be gpt-5.3-codex-spark and the reviewer be gpt-5.4."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Assign distinct models by role (Priority: P1)

As a Symphony operator, I want to configure separate model choices for the planner, worker, and reviewer roles, so that each role can use a model matched to its responsibility without forcing all agents onto the same model.

**Why this priority**: This is the core user value. Without independent role assignments, operators cannot tune cost, capability, latency, or review quality per role.

**Independent Test**: Configure three different model identifiers for planner, worker, and reviewer, start one run that exercises all three roles, and confirm each role uses its configured model.

**Acceptance Scenarios**:

1. **Given** the operator configures the planner model as `gpt-5.5`, the worker model as `gpt-5.3-codex-spark`, and the reviewer model as `gpt-5.4`, **When** a run starts and reaches each role, **Then** the planner, worker, and reviewer each use their own configured model.
2. **Given** the operator configures the same model for two roles and a different model for the third role, **When** a run starts, **Then** the matching roles share the selected model and the remaining role uses its separate selection.
3. **Given** the operator changes only the reviewer model, **When** the next reviewer session starts, **Then** the reviewer uses the new model while the planner and worker remain unchanged.

---

### User Story 2 - Preserve safe defaults and clear overrides (Priority: P2)

As a Symphony operator, I want missing role-specific model settings to fall back predictably, so that I can opt into independent role models gradually without breaking existing workflows.

**Why this priority**: Existing users and workflows need continuity. Independent configuration should be additive, not a forced migration that requires every role to be configured immediately.

**Independent Test**: Remove one or more role-specific model settings, start runs that exercise those roles, and confirm each missing role uses the documented default while configured roles keep their explicit assignments.

**Acceptance Scenarios**:

1. **Given** no role-specific model settings are configured, **When** a run starts, **Then** all roles use the existing default model behavior.
2. **Given** only the worker model is configured, **When** a run starts, **Then** the worker uses the configured model and the planner and reviewer use the documented default model behavior.
3. **Given** a role-specific model setting is removed, **When** the next session for that role starts, **Then** that role returns to the documented default without affecting other roles.

---

### User Story 3 - Detect unusable role model settings before work is delegated (Priority: P2)

As a Symphony operator, I want invalid or unavailable role model settings to be reported before an agent begins work, so that failures are actionable and do not waste worker or reviewer effort.

**Why this priority**: A misconfigured model can stall the entire orchestration loop. Early, role-specific feedback keeps the operator in control and prevents confusing downstream failures.

**Independent Test**: Configure an unusable model identifier for one role, start a run that needs that role, and confirm the run stops or requests operator action before delegating work to that role.

**Acceptance Scenarios**:

1. **Given** the worker model is set to an unusable model identifier, **When** a run attempts to start worker work, **Then** the system reports the worker model problem before the worker receives the task.
2. **Given** the reviewer model is unusable but the worker model is valid, **When** a run reaches review, **Then** completed worker output is preserved and the system reports a reviewer-specific configuration problem.
3. **Given** a model setting is syntactically invalid or empty after trimming, **When** configuration is loaded for a run, **Then** the system rejects that role setting with a clear explanation of which role is affected.

---

### User Story 4 - Show which model each role used (Priority: P3)

As a Symphony operator reviewing a run, I want to see the resolved model for each planner, worker, and reviewer session, so that I can diagnose output quality, cost, latency, and regressions after changing model assignments.

**Why this priority**: Model selection affects run behavior and review outcomes. Operators need durable, non-secret evidence of the resolved assignment to understand what happened later.

**Independent Test**: Run a workflow with configured role models, inspect the run record, and confirm each role session records its resolved model assignment.

**Acceptance Scenarios**:

1. **Given** a run uses distinct role model settings, **When** the operator inspects the run record, **Then** the record identifies the resolved model for each role session.
2. **Given** a role uses the default model because no override was configured, **When** the operator inspects the run record, **Then** the record distinguishes defaulted selection from explicit role configuration.
3. **Given** an operator changes role model settings between runs, **When** comparing the run records, **Then** each run preserves the model selections that were active for its own sessions.

### Edge Cases

- Only one role has an explicit model setting while the others rely on defaults.
- Two or more roles intentionally use the same model.
- A role model setting is empty, whitespace-only, malformed, or refers to an unavailable model.
- A model configuration changes while a run is already in progress.
- A retry or restart occurs after a role model has already been resolved.
- A worker completes successfully but the reviewer model is invalid or unavailable.
- Model identifiers contain provider-specific punctuation, version segments, or capability suffixes.
- Configuration display, logs, transcripts, and error messages must not expose credential values or secret-bearing provider settings.
- A role is not exercised during a run, so no model is resolved for that role session.

## Constitution Coverage *(mandatory)*

- **Authority Boundary**: Symphony owns model selection for planner, worker, and reviewer sessions. Runtime agents must receive the model assignment resolved for their role and must not choose or override their own model outside the configured service path. The planner role is the existing user-facing planning agent/template on the main dashboard; `orchestrator` remains the service-owned coordination concept, not a role-model key.
- **Credential And Secret Handling**: Model identifiers may be shown in configuration summaries, run records, and validation errors. Secret-bearing provider credentials, tokens, profile values, or environment material must not be stored in specs, prompts, logs, transcripts, or operator-facing errors.
- **Audit And Replay Evidence**: Each role session should leave durable evidence of the resolved model identifier, whether it came from an explicit role override or default behavior, and any role-specific configuration failure. Retries and replay must preserve or reconstruct the same role model decision for the affected session.
- **Protected Or Vendored Surfaces**: The feature may touch Symphony-owned configuration, orchestration, runtime profile generation, run records, and validation surfaces. Vendored runtime source and operator-controlled secrets are out of scope unless a later plan explicitly ratifies a protected-surface change.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST allow operators to configure separate model identifiers for planner, worker, and reviewer roles.
- **FR-002**: The system MUST resolve the planner model independently from the worker and reviewer model settings.
- **FR-003**: The system MUST resolve the worker model independently from the planner and reviewer model settings.
- **FR-004**: The system MUST resolve the reviewer model independently from the planner and worker model settings.
- **FR-005**: The system MUST preserve existing default model behavior for any role without an explicit role-specific model setting.
- **FR-006**: The system MUST allow multiple roles to intentionally use the same model identifier without treating that as a configuration error.
- **FR-007**: The system MUST reject empty, malformed, or unavailable role model settings before delegating work to the affected role.
- **FR-008**: The system MUST identify the affected role when reporting an invalid or unavailable model setting.
- **FR-009**: The system MUST prevent worker and reviewer agents from overriding their assigned model through their own runtime instructions, prompts, or delegated command surfaces.
- **FR-010**: The system MUST record the resolved model identifier for each role session that starts.
- **FR-011**: The system MUST record whether each resolved model came from an explicit role-specific setting or default behavior.
- **FR-012**: The system MUST preserve the resolved model decision for in-progress role sessions when configuration changes occur after the session starts.
- **FR-013**: The system MUST keep model identifiers visible only as non-secret configuration metadata and must not expose credential values or secret-bearing provider settings in run records, prompts, logs, transcripts, or errors.
- **FR-014**: The system MUST include validation coverage for distinct role assignments, partial overrides, shared model identifiers, invalid settings, mid-run configuration changes, retries or restarts, and run-record evidence.

### Key Entities

- **Role Model Configuration**: The operator-controlled model assignment settings for planner, worker, and reviewer roles.
- **Role Model Resolution**: The decision that selects the effective model for a specific role session, including whether it used an explicit role override or default behavior.
- **Role Session**: A planner, worker, or reviewer execution session that receives one resolved model assignment before it begins work.
- **Configuration Problem**: A role-specific model setting that cannot be used and must be reported before work is delegated to the affected role.
- **Run Evidence**: Durable, redacted run information that shows which model each started role session used.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In validation runs with three distinct configured model identifiers, 100% of planner, worker, and reviewer sessions use the model assigned to their own role.
- **SC-002**: In validation runs with partial role overrides, 100% of explicitly configured roles use their configured model and 100% of unconfigured roles use the documented default behavior.
- **SC-003**: 100% of invalid, empty, malformed, or unavailable role model settings are reported before work begins for the affected role.
- **SC-004**: 100% of started role sessions record the resolved model identifier and whether it came from an explicit override or default behavior.
- **SC-005**: Configuration changes made after a role session starts do not alter that in-progress session's resolved model in 100% of retry and restart validation cases.
- **SC-006**: Operator-facing model configuration errors identify the affected role and recommended correction path without exposing credentials or secret-bearing provider settings.
- **SC-007**: Existing workflows with no role-specific model configuration continue to start successfully using current default model behavior.

## Assumptions

- Operators already have at least one default model path configured today; this feature adds role-specific overrides on top of that behavior.
- Model identifiers are non-secret metadata, while provider credentials and account configuration remain managed through existing secret-bearing paths.
- Role-specific settings apply when a new role session starts; they do not retroactively change sessions that are already in progress.
- The initial scope is the three named roles: planner, worker, and reviewer.
- Planner refers to the existing user-facing planning agent/template and dashboard communication surface. Do not introduce a separate `orchestrator` role-model key or runtime role as part of this feature.
- The feature does not require a hardcoded list of model names in the specification; planning will define how availability is validated against the configured provider environment.

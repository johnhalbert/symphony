# Data Model: Configure Agent Role Models

## Role Model Configuration

Represents operator-provided model assignments in workflow configuration.

**Fields**:

- `planner`: Optional model identifier for the existing user-facing planner template and main-dashboard planning/chat sessions.
- `worker`: Optional model identifier for worker implementation and worker repair sessions.
- `reviewer`: Optional model identifier for reviewer sessions.

**Validation Rules**:

- Omitted fields are allowed and trigger documented fallback behavior.
- Present fields must resolve to a non-empty string after environment-variable expansion and trimming.
- Values must not contain line breaks or control characters.
- Values are non-secret metadata; provider credentials and profile secrets remain outside this entity.
- Multiple roles may use the same model identifier.

## Role Model Resolution

Represents the effective model decision for a specific role at a specific session boundary.

**Fields**:

- `role`: `planner`, `worker`, or `reviewer`.
- `model`: Resolved model identifier, or `null` only when the active runtime's existing behavior has no known model before session startup.
- `source`: `explicit` when selected from `role_models.<role>`, otherwise `default`.
- `sourcePath`: Human-readable configuration source such as `role_models.worker`, `hermes.model`, `cursor.model`, or host ACP session metadata.
- `providerId`: Runtime provider when known.
- `resolvedAt`: Timestamp when the role session claim was made.

**Relationships**:

- One role model configuration can produce many role model resolutions.
- Each started role session has one role model resolution.
- A run record stores the resolution model and source markers for audit.

## Role Session

Represents a unit of work or command handling that receives a model assignment before doing work.

**Fields**:

- `role`: Role receiving the model assignment.
- `runId` or `conversationId`: Durable identifier for the role session or planner conversation command.
- `harnessId`: Runtime harness for worker/reviewer sessions, when applicable.
- `runPhase`: Implementation, review, issue breakdown, merge-conflict resolution, or service-owned planner command phase.
- `resolvedModel`: Role model resolution snapshot.
- `startedAt`: Timestamp when the session was accepted.

**State Transitions**:

- `configured` -> `resolved`: The service resolves the role model at session start.
- `resolved` -> `preflight_failed`: The runtime rejects the model before prompt/work delegation.
- `resolved` -> `started`: The runtime confirms or accepts the selected model and begins work.
- `started` -> terminal run state: The session completes, fails, or is cancelled without changing the stored model resolution.

## Configuration Problem

Represents a role-specific model setting that prevents work from starting for the affected role.

**Fields**:

- `role`: Affected role.
- `configPath`: Configuration path that produced the failure.
- `reason`: `empty_model`, `malformed_model`, `unavailable_model`, or `runtime_model_switch_failed`.
- `message`: Redacted operator-facing explanation.
- `modelPreview`: The model identifier when safe to display.
- `observedAt`: Timestamp.

**Validation Rules**:

- Messages must identify the affected role.
- Messages must not include provider tokens, API keys, auth home contents, private profile paths containing secrets, or raw environment values.

## Run Evidence

Represents durable evidence that a role session used a specific resolved model.

**Fields**:

- `runtimeModel`: Effective runtime model recorded on the run.
- `runtimeModelParams`: Runtime model parameters where applicable.
- `runtimeSettingSources`: Includes role model source markers and existing harness/provider markers.
- `cursorModel`: Existing Cursor compatibility metadata.
- `cursorModelParams`: Existing Cursor compatibility metadata.
- `harnessId`: Runtime harness that executed the role session.
- `role`: Worker/reviewer run role.
- `runPhase`: Run phase.

**Replay Behavior**:

- Rebuilding a run from transcript events must preserve the same runtime model evidence recorded for the started session.
- Configuration changes after session start must not rewrite the stored model for that run.

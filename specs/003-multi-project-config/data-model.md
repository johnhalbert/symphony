# Data Model: Multi-Project Configuration

## ProjectContextConfig

Operator-authored configuration unit.

**Fields**:

- `id`: Stable unique context id. Required for explicit contexts. Legacy single-project config normalizes to `default`.
- `label`: Optional display label. Defaults to `id`.
- `enabled`: Optional boolean. Defaults to true.
- `tracker`: Linear tracker settings for this context, including project slug, endpoint, state buckets, assignee routing, and capability references.
- `workspace`: Workspace root, state directory, source, branch template, cache, and cleanup policy for this context.
- `github`: GitHub publication, review, merge, and PR handoff settings for this context.
- `reviewLoop`: Review states, blocked states, pass state, prompt extensions, transcript limits, and review counters for this context.
- `issueBreakdown`: Issue breakdown routing and writeback settings for this context.
- `agent`: Context-specific protected paths, routing labels, concurrency limits, and harness-related overrides that naturally differ by project.
- `credentialProfiles`: Context-specific capability profile assignments or inherited defaults.

**Validation Rules**:

- `id` must be unique after normalization and safe for display and file/key prefixes.
- Enabled contexts must have a usable codebase source and Linear project slug.
- Context reuse of a codebase or Linear project is allowed only when identifiers are explicit and routing remains unambiguous.
- Credential references must identify profiles or environment variables, never raw secret values.

## NormalizedProjectContext

Service-owned normalized context used after workflow parsing.

**Fields**:

- `id`
- `label`
- `enabled`
- `source`: `explicit` or `legacy_default`
- `tracker`
- `workspace`
- `github`
- `reviewLoop`
- `issueBreakdown`
- `agent`
- `credentialProfiles`
- `codebaseIdentity`
- `linearProjectIdentity`

**Relationships**:

- One normalized context can create many project-scoped issues, workspaces, runs, lifecycle records, approvals, writebacks, and projections.
- A workflow has one or more normalized contexts.

## ProjectContextRegistry

Service-owned collection of normalized contexts.

**Fields**:

- `contexts`: Ordered enabled and disabled contexts.
- `defaultContextId`: Context id used for legacy records and legacy single-project configuration.
- `byId`: Lookup by context id.
- `routingIndex`: Lookup helpers for Linear project identity, issue source, and workspace/source identity.

**Validation Rules**:

- Must contain at least one enabled context for ordinary service startup.
- Duplicate ids fail config validation.
- Ambiguous routing entries fail closed unless they require an explicit operator selection.

## ProjectScopedIssue

Tracker issue plus resolved project context.

**Fields**:

- `issue`: Normalized tracker issue.
- `projectContextId`
- `linearProjectIdentity`
- `routingSource`: `candidate_poll`, `state_refresh`, `legacy_default`, `operator_request`, or `replay`
- `resolvedAt`

**Validation Rules**:

- Must reference an enabled normalized context before dispatch or writeback.
- Must not be accepted from an agent as an authority-changing value.

## ProjectContextResolution

The durable routing decision used by action paths.

**Fields**:

- `projectContextId`
- `projectContextLabel`
- `codebaseIdentity`
- `linearProjectIdentity`
- `workspacePolicySummary`
- `routingSource`
- `lockedAt`
- `configRevision` or equivalent reload evidence when available.

**State Rules**:

- Created before workspace creation, dispatch, writeback, review, approval, publication, merge, or cleanup.
- Persisted on started runs and related durable records.
- Reused during retry and replay instead of recomputing from changed config.

## ProjectScopedWorkspace

Workspace record belonging to a project context.

**Fields**:

- `projectContextId`
- `workspaceKey`
- `issueId`
- `issueIdentifier`
- `path`
- `sourceKind`
- `repoPath`
- `baseRef`
- `gitBranchName`
- `createdAt`
- `updatedAt`

**Validation Rules**:

- Workspace key and path must include enough context to avoid collisions between projects.
- Existing legacy records without context read as the default/legacy context.
- Worktree cleanup must use the workspace policy and repository metadata from the persisted context.

## ProjectScopedRunEvidence

Run metadata and transcript evidence with project attribution.

**Fields**:

- `projectContextId`
- `projectContextLabel`
- `runId`
- `sessionId`
- `issueId`
- `issueIdentifier`
- `workspaceKey`
- `workspacePath`
- `linearProjectIdentity`
- `codebaseIdentity`
- `routingSource`
- existing runtime, model, PR, approval, and status metadata.

**Validation Rules**:

- Every new started run must include context attribution.
- Historical records without context default for display and replay compatibility.
- Transcript projections must preserve attribution without exposing secrets.

## ProjectScopedLifecycle

Issue lifecycle record with context attribution.

**Fields**:

- `projectContextId`
- `issueId`
- `issueIdentifier`
- `phase`
- `summaryPointers`
- completion reports, review verdicts, review feedback, merge state, issue breakdown plans, and handoff memo.

**Validation Rules**:

- Lookup by issue identifier alone is ambiguous across contexts and must require a context-aware alias when duplicates exist.
- Phase computation uses the context-specific tracker and review-loop state buckets.

## ProjectScopedWriteback

Writeback operation bound to one context.

**Fields**:

- `projectContextId`
- `idempotencyKey`
- `kind`
- `issueId`
- `runId`
- `payload`
- `status`
- retry and result fields.

**Validation Rules**:

- Idempotency keys must include or derive from context to avoid cross-project collisions.
- Processing uses the context-specific tracker writer and credential capability.
- Lifecycle guards compare against the context-bound lifecycle record.

## RoutingProblem

Durable record or event describing unsafe routing.

**Fields**:

- `reason`: `missing_context`, `ambiguous_context`, `disabled_context`, `credential_unavailable`, `codebase_unavailable`, or `stale_context`.
- `issueId`
- `issueIdentifier`
- `candidateContextIds`
- `safeMessage`
- `createdAt`

**Validation Rules**:

- Must be recorded before any workspace creation, dispatch, or Linear mutation is skipped due to routing.
- Must redact credential values and secret-bearing configuration.

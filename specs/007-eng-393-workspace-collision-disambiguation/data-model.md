# Data Model: ENG-393 Workspace Collision Disambiguation

## ExactIssueIdentity

Unambiguous issue identity used for workspace and branch decisions.

**Fields**:

- `projectContextId`
- `trackerIssueId`
- `visibleIssueIdentifier`
- `linearProjectIdentity`
- `routingSource`

**Validation Rules**:

- Must be present before workspace creation, lookup, reuse, cleanup, and branch fallback.
- Visible identifier alone is not sufficient when multiple contexts exist.

## WorkspaceIdentity

Durable workspace key/path ownership record.

**Fields**:

- `workspaceKey`
- `workspacePath`
- `projectContextId`
- `trackerIssueId`
- `visibleIssueIdentifier`
- `sourceKind`
- `repositoryIdentity`
- `createdFromLegacy`: boolean.

**Validation Rules**:

- Key and path must be distinct for duplicate visible identifiers across contexts.
- Lookup must use exact identity when available.
- Cleanup must not remove sibling context workspaces.

## BranchSafetyInput

Complete input used to evaluate whether a branch candidate is safe.

**Fields**:

- `projectContextId`
- `trackerIssueId`
- `visibleIssueIdentifier`
- `branchTemplate`
- `trackerBranchName`
- `candidateBranchName`
- `repositoryIdentity`

**Validation Rules**:

- Cache keys, if used, must include all fields that affect safety.
- A null tracker branch name is a meaningful input, not a shared global state.

## BranchCandidate

Candidate branch selected for a workspace.

**Fields**:

- `name`
- `source`: `tracker_metadata`, `configured_template`, `context_safe_fallback`, or `legacy`.
- `safe`: boolean.
- `collisionReason`: Optional safe reason when rejected.

**Validation Rules**:

- Must be deterministic for the same exact issue identity and repository state.
- Must not collide with a sibling context issue.

## LegacyWorkspaceArtifact

Existing workspace-related artifact created before context-safe identity rules.

**Fields**:

- `artifactType`: `workspace_record`, `path`, `summary`, `status_pointer`, or `continuation`.
- `legacyIdentifier`
- `inferredContextId`
- `readbackMode`: `legacy_default`, `escaped`, `migrated`, or `ambiguous`.

**Validation Rules**:

- Must remain readable where possible.
- Must not block creation of a new exact-identity workspace.
- Ambiguous legacy artifacts require safe operator evidence rather than destructive repair.

## CollisionValidationCase

Planned test case for duplicate-context workspace behavior.

**Fields**:

- `name`
- `firstIssue`
- `secondIssue`
- `branchTemplate`
- `trackerBranchMetadata`
- `preexistingArtifacts`
- `expectedOutcome`

**Validation Rules**:

- Must include duplicate visible identifiers across contexts.
- Must include null tracker branch metadata.
- Must include a cache-priming or ordering-sensitive case.

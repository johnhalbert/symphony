# Data Model: ENG-372 Context Credential Routing

## CredentialProfileAssignment

Capability-scoped assignment of a credential profile to a project context.

**Fields**:

- `projectContextId`: Context that owns the assignment.
- `capability`: Service capability such as tracker read, tracker write, GitHub publication, GitHub review, or runtime handoff.
- `profileName`: Non-secret profile reference.
- `source`: `context_override`, `inherited_default`, or `legacy_default`.

**Validation Rules**:

- Must not contain raw secret values.
- Missing required assignment fails closed for the capability.

## StructuredCredentialProfile

Credential profile after inherited fields and context overrides are resolved.

**Fields**:

- `profileName`: Non-secret profile name.
- `service`: Service family.
- `publicAttributes`: Non-secret attributes safe for diagnostics.
- `secretAttributes`: Secret-backed values available only to authorized service paths.
- `resolutionSource`: How the final profile was assembled.

**Validation Rules**:

- Required service fields must be present after merge.
- Secret attributes must not be exposed through public metadata or evidence.

## ContextTrackerRoute

Resolved tracker client route for a target issue or action.

**Fields**:

- `projectContextId`
- `trackerCapability`
- `trackerProjectIdentity`
- `canonicalIssueId`
- `visibleIssueIdentifier`
- `routingSource`

**Validation Rules**:

- Must be resolved before live tracker reads or mutation precursor checks.
- Must fail closed when zero or multiple contexts match.

## IdentifierResolutionRequest

Input for actions that begin with only an issue identifier or partial issue reference.

**Fields**:

- `inputIdentifier`
- `requestedAction`
- `knownProjectContextId`
- `knownWorkspaceKey`
- `knownRunId`

**Validation Rules**:

- Must resolve to exactly one context and canonical tracker identity before live tracker use.
- Must not rely on visible identifier alone when duplicate identifiers are possible.

## TrackerRoutingEvidence

Redacted evidence recorded for validation and operator diagnosis.

**Fields**:

- `projectContextId`
- `capability`
- `routingSource`
- `canonicalIssueIdPresent`
- `visibleIdentifier`
- `result`: `resolved`, `ambiguous`, `missing`, or `credential_unavailable`.

**Validation Rules**:

- Must not include tokens, private keys, raw profile values, or provider account contents.
- Must be sufficient for reviewers to identify which route was exercised.

## ValidationMatrixCase

Planned proof case for child issues.

**Fields**:

- `name`
- `contexts`
- `capabilities`
- `entryPoint`
- `expectedRoute`
- `expectedFailure`

**Validation Rules**:

- Must include at least two contexts with distinct credentials.
- Must cover polling, review/status, identifier-only fallback, and issue-breakdown entry points.

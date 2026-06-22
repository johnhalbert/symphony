# Data Model: ENG-443 Legacy Backfill Resolution

## LegacyRunRecord

Historical run record created before project-context metadata was mandatory.

**Fields**:

- `runId`
- `issueId`
- `issueIdentifier`
- `workspaceKey`
- `createdAt`
- `existingMetadata`

**Validation Rules**:

- Missing project-context metadata must not prevent readback.
- Readback must attach stable non-secret default or legacy attribution.

## LegacyWorkspaceRecord

Historical workspace record created before project-context metadata was mandatory.

**Fields**:

- `workspaceKey`
- `issueId`
- `issueIdentifier`
- `path`
- `sourceSummary`
- `existingMetadata`

**Validation Rules**:

- Missing project-context metadata must not prevent workspace display or diagnosis.
- Fallback attribution must not leak credential values.

## BackfilledProjectContext

Read-time context attribution supplied for legacy records.

**Fields**:

- `projectContextId`
- `projectContextLabel`
- `source`: `legacy_default`, `configured_default`, or `inferred_legacy`.
- `codebaseSummary`
- `trackerSummary`
- `redacted`: boolean.

**Validation Rules**:

- Must be stable for the same record and configuration.
- Must contain only non-secret diagnostic metadata.

## BackfillDecision

Decision record for whether ENG-443 needs code changes.

**Fields**:

- `baseRevision`
- `runRecordResult`: `satisfied`, `missing`, or `not_applicable`.
- `workspaceRecordResult`: `satisfied`, `missing`, or `not_applicable`.
- `requiredAction`: `close_with_evidence`, `retarget_pr`, `replace_pr`, or `implement_missing_path`.
- `evidenceSummary`

**Validation Rules**:

- Must be recorded before implementation work proceeds.
- Must distinguish current-main proof from branch behavior.

## NoOpPullRequestDisposition

Resolution state for a PR that does not materially change issue behavior.

**Fields**:

- `pullRequestUrl`
- `diffStatus`: `empty`, `behaviorally_redundant`, or `non_empty`.
- `issueContractSatisfiedOnBase`: boolean.
- `disposition`: `close`, `retarget`, `replace`, or `continue`.

**Validation Rules**:

- Empty or redundant PRs must not be promoted as implementation evidence unless the chosen disposition is explicit.

## BackfillValidationEvidence

Evidence attached to ENG-443 or a child issue.

**Fields**:

- `scenario`
- `baseBehavior`
- `beforeResult`
- `afterResult`
- `commands`
- `redactionCheck`

**Validation Rules**:

- Must not include credentials or raw private configuration.
- Must show either satisfied-on-base or failing-before/passing-after behavior.

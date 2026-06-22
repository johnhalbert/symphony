# Data Model: ENG-392 Routing Reload Decomposition

## Decomposition Decision

Represents the operator-facing classification for ENG-392 after reviewing the original contract, Linear comments, review failures, and publication surface.

**Fields**:

- `parentIssueId`: Linear issue id or identifier for ENG-392.
- `decision`: One of `split_retarget`, `widen_with_child_contracts`, `close_or_replace_with_evidence`.
- `rationale`: Human-readable explanation tied to review evidence.
- `selectedAt`: Timestamp of the recorded decision.
- `evidenceRefs`: Links or durable pointers to comments, validation output, or review records.

**Validation Rules**:

- A decision is required before ENG-392 is re-dispatched.
- `widen_with_child_contracts` requires every added obligation to have a child contract before dispatch.
- `close_or_replace_with_evidence` requires current-base proof that no implementation remains.

## Child Issue Contract

Represents one independently reviewable work unit derived from the ENG-392 decomposition.

**Fields**:

- `id`: Stable requirement family id, such as `REQ-392-TEST-PROOF`.
- `title`: Child issue title.
- `description`: Linear-ready issue description with required sections.
- `contractJson`: Fenced JSON issue contract.
- `requirements`: Non-empty list of stable requirement ids and requirement text.
- `proofHints`: Optional evidence guidance for workers and reviewers.
- `authorizedSurfaces`: Bounded source, test, documentation, or fixture surfaces.
- `dependencies`: Other child contracts that must be resolved first.

**Validation Rules**:

- `contractJson.schemaVersion` must be a positive integer.
- `contractJson.contractVersion` must be non-empty.
- `requirements` must be non-empty and use unique stable ids.
- `authorizedSurfaces` must not include vendored upstream source unless a later plan explicitly ratifies that exception.

## Publication Candidate

Represents the files and behavior proposed for review under one active child issue contract.

**Fields**:

- `issueContractId`: Child contract that authorizes the candidate.
- `changedSurfaces`: File or behavior surfaces in the publication candidate.
- `surfaceComparison`: Mapping from each changed surface to the authorizing requirement.
- `unmappedSurfaces`: Changed surfaces not authorized by the active contract.
- `validationRefs`: Evidence that the candidate satisfies its contract.

**Validation Rules**:

- `unmappedSurfaces` must be empty before review.
- Runtime, status, workspace, cursor, approval, and writeback surfaces require explicit authorization.
- Temporary debug captures are not allowed unless converted into referenced redacted fixtures.

## Runtime Prerequisite

Represents behavior that the test proof requires but the original ENG-392 contract did not authorize.

**Fields**:

- `name`: Behavior family, such as runtime routing or approval writeback recovery.
- `owningChildContract`: Child issue that owns the behavior.
- `requiredBy`: Child issue or validation scenario depending on the behavior.
- `baseBehaviorStatus`: One of `unknown`, `already_satisfied`, `missing`, `partially_satisfied`.
- `proof`: Failing-before, passing-after, or base-behavior evidence.

**Validation Rules**:

- A missing prerequisite must be represented by a child issue before the test-proof child is accepted.
- Already-satisfied prerequisites require durable evidence rather than implementation work.

## Validation Evidence

Represents proof attached to a child issue or decomposition decision.

**Fields**:

- `scope`: `base_behavior`, `failing_before`, `passing_after`, `surface_comparison`, or `publication_hygiene`.
- `commands`: Local commands or review steps used for validation.
- `result`: Pass, fail, blocked, or intentionally unverified.
- `redactionStatus`: Confirmation that secrets and unnecessary local paths are absent.
- `unverifiedAreas`: Live integrations or scenarios intentionally left out of local validation.

**Validation Rules**:

- Evidence must distinguish base proof from failing-before and passing-after proof.
- Evidence must identify intentionally unverified live Linear or GitHub effects when they are out of scope.
- Evidence must not expose credential values or secret-backed configuration.

## Debug Artifact Disposition

Represents cleanup or fixture conversion for transient files produced during diagnosis.

**Fields**:

- `artifactPath`: Candidate path or path pattern.
- `disposition`: `removed`, `converted_to_fixture`, or `blocked`.
- `redactionNotes`: Description of local paths, tracker data, or workflow state removed.
- `referencingTests`: Tests that deliberately consume the fixture, if converted.

**Validation Rules**:

- Orphaned debug artifacts must not remain in the publication candidate.
- Converted fixtures must be redacted, named intentionally, and referenced by validation.

## State Transitions

```text
ENG-392 blocked
  -> decomposition_decision_recorded
  -> child_contracts_preflighted
  -> child_dependencies_resolved
  -> test_proof_validated
  -> publication_surface_clean
  -> ready_for_review_or_parent_resolution
```

Blocked transitions:

- `blocked -> re-dispatched` without a decomposition decision.
- `child_contracts_preflighted -> ready_for_review` with unmapped publication surfaces.
- `test_proof_validated -> ready_for_review` when tests pass only because out-of-contract runtime changes are present.

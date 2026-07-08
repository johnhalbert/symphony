# Data Model: Routing Reload Split Decomposition

## DecompositionDecision

Represents the durable decision that an ENG-392 publication candidate must be decomposed before review or re-dispatch can continue.

**Fields**:

- `decisionId`: Stable identifier for the decomposition decision.
- `issueIdentifier`: Parent issue or task identifier, such as `ENG-392`.
- `candidateId`: Publication candidate under evaluation, such as a branch, PR, or scoped diff identifier.
- `triggerEvidenceIds`: Validation evidence proving why the current publication candidate is blocked.
- `requiredSurfaceFamilies`: Protected-surface family labels that must be mapped before the candidate can proceed, such as `routing-reload-core`, `publication-handoff`, `writeback-guardrails`, `workspace-lifecycle`, or `operator-http-entrypoints`.
- `requiredSurfacePaths`: Concrete repo-relative paths or path families coupled to the blocked candidate.
- `resolution`: `decompose`, `retarget_publication`, or `expand_contract`.
- `status`: `proposed`, `confirmed`, `satisfied`, or `superseded`.
- `blockedReason`: Operator-facing summary of the scope or validation mismatch.
- `decidedAt`: Timestamp for the durable decision.

**State Rules**:

- A record starts as `proposed` when validation evidence shows the published diff depends on non-contract runtime paths, protected publication surfaces, or non-fixture debug artifacts.
- `confirmed` requires linked `ValidationEvidence` plus at least one mapped `RuntimePrerequisite`; a decision based only on branch-tip green tests is insufficient.
- While `status` is `confirmed` and not yet `satisfied`, the linked `PublicationCandidate` remains in an intentional non-dispatch state. Worker re-dispatch, reviewer dispatch, and review-ready publication are blocked.
- `satisfied` is allowed only after every linked `RuntimePrerequisite` is mapped to an authorized child contract or explicit exclusion and the candidate surface map is stable.
- Replays, reloads, or later focused reruns preserve the decision until newer durable evidence marks it `superseded`; retries do not silently clear a confirmed decomposition requirement.

## PublicationCandidate

Represents the branch, PR, or scoped diff that is being decomposed into contract-authorized child publications.

**Fields**:

- `candidateId`: Stable identifier for the branch, PR, or scoped publication attempt.
- `issueIdentifier`: Parent issue or child issue currently claiming the candidate.
- `baseRef`: Merge-base or comparison ref used for surface inventory.
- `changedSurfacePaths`: Repo-relative paths currently in scope for the candidate.
- `contractRequirementIds`: Requirement ids that the candidate claims to satisfy.
- `surfaceMap`: Mapping from each changed or coupled path to an authorized surface family or explicit exclusion.
- `decompositionDecisionId`: Active decomposition decision governing the candidate.
- `runtimePrerequisiteIds`: Coupled runtime prerequisites discovered during review or validation.
- `validationEvidenceIds`: Durable evidence supporting scope, blocking, or unblocking decisions.
- `debugArtifactIds`: Temporary captures or artifacts that still need classification.
- `status`: `observed`, `blocked_for_decomposition`, `scoped`, `review_ready`, `redispatch_ready`, or `superseded`.
- `lastValidatedAt`: Timestamp of the latest scope validation pass.

**State Rules**:

- A candidate starts as `observed` when its diff is inventoried against the current issue contract.
- `blocked_for_decomposition` is required when evidence shows a contract/publication mismatch, an unmapped coupled runtime path, or an unexplained debug artifact.
- `scoped` requires a `confirmed` `DecompositionDecision` and a non-empty `surfaceMap` covering every changed or coupled path.
- `review_ready` requires a `scoped` candidate, `confirmed` validation evidence, and no linked `DebugArtifact` left in `observed` or `triaged`.
- `redispatch_ready` requires everything needed for `review_ready` plus no linked `RuntimePrerequisite` left in `observed`, `mapped`, or otherwise unresolved state.
- Discovery of a new coupled path, stale validation evidence, or a stray debug artifact returns the candidate to `blocked_for_decomposition` even if a previous focused rerun looked green.
- `blocked_for_decomposition` is an intentional human-required state. While it is active, the system must not re-dispatch worker or reviewer runs and must not treat the non-dispatch interval as a failed review or incomplete-turn burn.

## RuntimePrerequisite

Represents a coupled runtime behavior or protected implementation surface that must be mapped before a child publication can proceed.

**Fields**:

- `prerequisiteId`: Stable identifier for the runtime prerequisite.
- `description`: Human-readable summary of the coupled runtime behavior.
- `surfaceFamily`: Authorized surface family, such as `routing-reload-core`, `publication-handoff`, `writeback-guardrails`, `workspace-lifecycle`, or `operator-http-entrypoints`.
- `surfacePaths`: Concrete repo-relative paths or path families carrying the prerequisite.
- `requiredForCandidateId`: Publication candidate currently blocked on this prerequisite.
- `childContractTarget`: Child issue, requirement id, or explicit exclusion expected to own the prerequisite.
- `sourceEvidenceIds`: Validation evidence that proved the prerequisite exists.
- `status`: `observed`, `mapped`, `authorized`, `satisfied`, or `excluded`.
- `validatedAt`: Timestamp of the latest prerequisite check.

**State Rules**:

- A prerequisite starts as `observed` when review feedback, diff inventory, or restore-based validation shows the current candidate depends on coupled runtime behavior.
- `mapped` requires both a `surfaceFamily` and concrete `surfacePaths`; family-only or path-only guesses are insufficient.
- `authorized` requires an explicit child contract or current touched-surface list that names the mapped family or path. Adjacent runtime behavior does not inherit authorization implicitly.
- `satisfied` requires `confirmed` validation evidence proving the prerequisite is either handled by the authorized child candidate or removed from the current candidate diff.
- `excluded` is valid only when the prerequisite is explicitly deferred or ruled out by a documented decomposition decision; exclusion without evidence does not unblock publication.
- Any prerequisite left in `observed`, `mapped`, or unauthorized state blocks the linked `PublicationCandidate` from entering `review_ready` or `redispatch_ready`.
- If a later diff or replay changes the coupled surface, the prerequisite falls back to `mapped` or `observed` until the new surface map is revalidated.

## ValidationEvidence

Represents durable proof used to justify decomposition, scope mapping, and unblock decisions.

**Fields**:

- `evidenceId`: Stable identifier for the evidence item.
- `sourceKind`: `review_timeline`, `focused_test_sweep`, `merge_base_restore`, `diff_inventory`, or `planning_note`.
- `locator`: Public URL, exact command string, or repo-relative file path that lets an operator reproduce the proof.
- `assertion`: Claim supported by the evidence.
- `relatedPrerequisiteIds`: Runtime prerequisites or publication candidates supported by the evidence.
- `status`: `collected`, `confirmed`, `superseded`, or `rejected`.
- `observedAt`: Timestamp when the evidence was recorded.

**State Rules**:

- Evidence begins as `collected` and becomes `confirmed` only when it includes enough durable detail to reopen the review, rerun the command, or reread the planning artifact without private environment data.
- A branch-tip green test can confirm current behavior, but it does not clear a decomposition block when merge-base restore, diff inventory, or review-timeline evidence still shows coupled runtime dependency.
- Only `confirmed` evidence may move a `DecompositionDecision`, `PublicationCandidate`, or `RuntimePrerequisite` into an unblocked state.
- When later proof contradicts an earlier claim, the earlier record becomes `superseded` or `rejected` but remains linked for audit and replay.
- Validation evidence must never store secrets, raw credential values, or machine-local private paths.

## DebugArtifact

Represents a temporary capture, scratch directory, or non-fixture artifact discovered while building decomposition evidence.

**Fields**:

- `artifactPath`: Repo-relative path or ignored local capture name.
- `origin`: Review, debugging, or reproduction workflow that created the artifact.
- `reason`: Why the artifact exists.
- `classification`: `local_only`, `fixture_candidate`, or `published_fixture`.
- `relatedCandidateId`: Publication candidate currently affected by the artifact.
- `redactionStatus`: `clean`, `needs_redaction`, or `unknown`.
- `status`: `observed`, `triaged`, `excluded`, or `fixtureized`.
- `validatedAt`: Timestamp of the latest artifact review.

**State Rules**:

- A debug artifact starts as `observed` with `classification` set to `local_only` until someone proves it belongs in an authorized fixture or removes it from the candidate surface.
- `triaged` requires an explicit decision to exclude the artifact from publication or to promote it into a contract-authorized fixture path.
- `excluded` means the artifact is absent from the candidate diff and no longer expands the touched-surface inventory.
- `fixtureized` is allowed only when a later child contract explicitly authorizes the artifact's destination path and the artifact is safe for publication.
- Debug artifacts never count as validation evidence by themselves and never justify expanding a candidate's authorized surface area.
- Any artifact left in `observed`, `triaged`, or `needs_redaction` state blocks the linked `PublicationCandidate` from `review_ready` and `redispatch_ready`.

## Blocked Transitions

```text
DecompositionDecision proposed
  -> confirmed                 [allowed only when linked validation evidence is confirmed and at least one runtime prerequisite is mapped]
  -> satisfied                 [blocked: unmapped prerequisites cannot be skipped]

DecompositionDecision confirmed
  -> satisfied                 [allowed only when every linked runtime prerequisite is authorized, satisfied, or explicitly excluded with evidence]
  -> superseded                [allowed when newer durable evidence replaces the current decomposition map]
```

```text
PublicationCandidate observed
  -> review_ready              [blocked: requires a confirmed decomposition decision, complete surface mapping, confirmed validation evidence, and no open debug artifacts]
  -> redispatch_ready          [blocked: requires everything needed for review_ready plus no unresolved runtime prerequisites]
  -> blocked_for_decomposition [required when contract/publication mismatch or unmapped coupled runtime behavior is discovered]

PublicationCandidate blocked_for_decomposition
  -> scoped                    [allowed only when decomposition is confirmed and every changed or coupled path has a mapped surface family/path]
  -> review_ready              [blocked]
  -> redispatch_ready          [blocked]

PublicationCandidate scoped
  -> review_ready              [allowed only when evidence is confirmed and debug artifacts are resolved]
  -> redispatch_ready          [allowed only when the same review gate passes and runtime prerequisites are no longer open]
  -> blocked_for_decomposition [required when new coupled paths, stale evidence, or stray debug artifacts appear]
```

```text
RuntimePrerequisite observed
  -> mapped                    [allowed only when both a surface family and concrete path map are recorded]
  -> authorized                [blocked: authorization cannot happen before mapping]

RuntimePrerequisite mapped
  -> authorized                [allowed only when a child contract or touched-surface list explicitly authorizes the mapped family/path]
  -> satisfied                 [blocked: validation cannot skip authorization]

RuntimePrerequisite authorized
  -> satisfied                 [allowed only when confirmed validation evidence proves the prerequisite is handled or removed]
```

# Data Model: ENG-2479 Runtime Child Preflight Decomposition

## Parent Issue Chain

Represents the tracker hierarchy and source context that justifies the decomposition.

**Fields**:

- `rootIssueId`: `ENG-347`
- `routingParentIssueId`: `ENG-351`
- `decompositionParentIssueId`: `ENG-392`
- `targetIssueId`: `ENG-2479`
- `evidenceSources`: issue descriptions, review comments, blocked triage comments, and existing ENG-392 planning records

**Validation Rules**:

- The chain must terminate at ENG-347 for this feature.
- Child body source context must cite ENG-2479 and at least one relevant ancestor.
- Spec Kit artifacts remain planning records until issue-sync.

## Decomposition Child Issue Body

Represents one Linear-ready issue description prepared for later issue-sync.

**Fields**:

- `bodyId`: stable local identifier, such as `T033A`
- `title`: child issue title
- `ownerCategory`: proof matrix, execution path, preflight evidence, or review handoff
- `intendedParentId`: `ENG-2479`
- `intendedBlocks`: normally `ENG-2479`
- `intendedBlockedBy`: zero or more child body IDs
- `contract`: fenced JSON Issue Contract
- `sourceContext`: issue and requirement references that justify the body
- `acceptanceCriteria`: concrete reviewable outcomes
- `outOfScope`: boundaries that prevent runtime or lifecycle drift

**Validation Rules**:

- Exactly four child bodies are expected unless later research identifies a duplicate or merged category.
- Each body must include exactly one fenced JSON Issue Contract.
- Requirement IDs must be non-empty and unique within the body.
- The body must state intended parent and blocking relationships but must not create live Linear state during planning.

## Issue Contract

Represents the fenced JSON block required for any agent-eligible issue.

**Fields**:

- `schemaVersion`: positive integer
- `contractVersion`: non-empty opaque version string
- `requirements`: non-empty list of requirement entries
- `requirements[].id`: stable unique requirement identifier
- `requirements[].requirement`: human-readable obligation
- `requirements[].proofHint`: optional non-authoritative evidence guidance

**Validation Rules**:

- The contract must parse as JSON.
- `requirements` must not be empty.
- Each `id` must be unique within the contract.
- Contract prose must not include secrets or credential values.

## Proof Matrix

Represents the mapping from ENG-2479 review failures to planned runtime child contract families and evidence fields.

**Fields**:

- `families`: `REQ-392-RUNTIME-ROUTING`, `REQ-392-RELOAD-PRESERVATION`, `REQ-392-APPROVAL-WRITEBACK`
- `sourceFallbackOrder`: Linear issue contract, ENG-2479 triage comments, ENG-392 child contract planning records, ENG-392 validation evidence records
- `requiredEvidenceFields`: command string, outcome status, per-family coverage signal, findings if any, redaction statement
- `insufficientEvidence`: broad CI without focused preflight output, code inspection alone, denied command attempts alone

**Validation Rules**:

- The proof matrix must not authorize runtime implementation.
- It must name what to do when `spec.md`, `plan.md`, or `tasks.md` are absent from a worker workspace.

## Validation Path

Represents the approved way to produce focused preflight evidence.

**Fields**:

- `executorType`: service-owned workflow, unrestricted operator run, or other explicitly approved executor
- `requiredCommand`: `npm test -- tests/issue-contract-lint.test.ts`
- `artifactLocation`: lifecycle-bound completion evidence, review evidence, or linked redacted validation artifact
- `policyBoundary`: reason restricted worker/reviewer direct package-command execution is not sufficient

**Validation Rules**:

- The path must not rely on a denied restricted-role package command.
- The path must explain where future workers and reviewers find the result.

## Evidence Artifact

Represents the final focused preflight evidence required by ENG-2479.

**Fields**:

- `command`: focused command string or approved equivalent
- `outcomeStatus`: pass, fail, blocked, or findings recorded
- `familyCoverage`: status for each runtime contract family
- `redactionStatement`: confirms secrets and unnecessary local absolute paths are absent
- `broadCiStatus`: optional note when public CI is broad-only and insufficient

**Validation Rules**:

- A pass claim requires focused preflight output, not only broad public validation.
- A failed preflight must record findings instead of claiming success.

## Parent Handoff

Represents the parent-facing summary prepared after child evidence exists.

**Fields**:

- `targetIssueId`: `ENG-2479`
- `linkedChildBodies`: proof matrix, execution path, evidence capture, review handoff
- `supersededReviewGate`: failed review or blocker evidence intended to be superseded
- `remainingAction`: focused re-review or operator action through normal service-owned lifecycle
- `intentionallyUnverifiedEffects`: live Linear, GitHub, publication, or merge effects not exercised

**Validation Rules**:

- Must not claim lifecycle state changes that did not happen.
- Must distinguish verified focused evidence from unverified live effects.

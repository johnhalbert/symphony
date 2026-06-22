# Research: ENG-2479 Runtime Child Preflight Decomposition

## Decision: Keep Planning Inside Spec Kit Until Issue Sync

**Rationale**: The user explicitly rejected live child issue creation outside the Spec Kit flow. Spec Kit artifacts should prepare Linear-ready child issue bodies and dependency intent, while actual tracker mutation should wait for `/speckit-tasks`, `/speckit-taskstoissues`, or another explicit service-owned issue-sync workflow.

**Alternatives considered**:

- Create live Linear children during planning: rejected because it bypasses the requested flow.
- Leave only prose recommendations: rejected because later issue-sync needs concrete fenced JSON contracts and dependency notes.

## Decision: Prepare Four Child Body Families

**Rationale**: ENG-2479's blocked triage and review history identify four distinct blocker categories: underspecified proof matrix, missing approved execution path, missing focused preflight evidence, and parent review-unblock handoff. One issue per category keeps actors and acceptance evidence independently reviewable.

**Alternatives considered**:

- One replacement T033 issue: rejected because it would repeat the mixed planning/orchestrator/worker/reviewer scope.
- Three child bodies only: rejected because parent review-unblock remains a separate downstream gate after evidence capture.
- Reuse ENG-392 runtime child families directly: rejected because ENG-2479 owns the validation preflight slice, not the runtime implementation children themselves.

## Decision: Preserve ENG-2479 As The Parent

**Rationale**: ENG-2479 is the issue flagged for decomposition. Prepared child bodies should state that they are intended to parent under ENG-2479 and block ENG-2479 after issue-sync. Ancestor issues provide context but should not become the immediate parent for this split.

**Alternatives considered**:

- Parent new bodies under ENG-392: rejected because ENG-392 already has a broader decomposition tree and ENG-2479 has its own blocked review ledger.
- Treat ENG-347 as the parent: rejected because ENG-347 is the feature root, too broad for the T033 validation slice.

## Decision: Use Existing Issue Contract Governance Shape

**Rationale**: The constitution defines the fenced JSON contract shape and makes it authoritative for agent-eligible issues. Each prepared child body will include exactly one fenced JSON block with `schemaVersion`, `contractVersion`, and a non-empty `requirements` array.

**Alternatives considered**:

- Store contracts only in a table: rejected because the project requires fenced JSON contracts before delegation.
- Use one shared contract for all children: rejected because each child needs separate requirement IDs and proof hints.

## Decision: Treat Focused Preflight Evidence As A Later Child Responsibility

**Rationale**: Planning should define the expected evidence but not run validation. ENG-2479's prior failure was partly caused by command-policy mismatch; the execution path must be defined before evidence capture.

**Alternatives considered**:

- Run `npm test -- tests/issue-contract-lint.test.ts` during plan: rejected because planning artifacts are not the lifecycle-bound worker evidence and the command-policy issue is part of the decomposition.
- Record broad public CI as sufficient: rejected because review evidence explicitly required focused preflight output.

## Decision: Redact Local Evidence And Avoid Absolute Paths

**Rationale**: The constitution and existing ENG-392 validation evidence contract prohibit secret values and unnecessary local absolute paths. Prepared issue bodies should cite issue IDs, requirement IDs, and relative repo paths where needed.

**Alternatives considered**:

- Copy full local workspace paths from previous triage comments: rejected because they are not needed for future issue-sync and make artifacts less portable.

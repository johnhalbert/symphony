# Tasks: ENG-2479 Runtime Child Preflight Decomposition

**Input**: Design documents from `specs/010-eng-2479-decomposition/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `quickstart.md`, and `contracts/`

**Tests**: This is a planning-only feature. Concrete validation tasks are included for every user story before the artifact work they protect; no runtime tests are required by this task set.

**Organization**: Tasks are grouped by user story so each prepared child body can be validated independently before any later issue-sync flow.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel because it touches different files or has no dependency on incomplete tasks.
- **[Story]**: Maps the task to a specific user story from `spec.md`.
- Every task includes an exact file path.

## Phase 1: Setup (Shared Planning Scope)

**Purpose**: Confirm the active feature, scope boundaries, and source inventory before artifact work begins.

- [ ] T001 Confirm the active feature pointer and planning-only scope in `.specify/feature.json` and `specs/010-eng-2479-decomposition/quickstart.md`
- [ ] T002 [P] Record the ENG-2479 -> ENG-392 -> ENG-351 -> ENG-347 source inventory in `specs/010-eng-2479-decomposition/quickstart.md`
- [ ] T003 [P] Record the issue-sync duplicate-check requirement for existing ENG-2479 children in `specs/010-eng-2479-decomposition/contracts/issue-sync-gate.md`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish shared contract, authority, redaction, and dependency checks before any child body is finalized.

**CRITICAL**: No user story artifact work should begin until these checks are complete.

- [ ] T004 Normalize shared child-body metadata for parent, blocker, labels, delegation, and out-of-scope boundaries in `specs/010-eng-2479-decomposition/contracts/child-issue-bodies.md`
- [ ] T005 [P] Validate that each fenced JSON issue contract parses and record the validation rule in `specs/010-eng-2479-decomposition/contracts/issue-sync-gate.md`
- [ ] T006 [P] Validate authority-boundary and credential-redaction checks in `specs/010-eng-2479-decomposition/contracts/issue-sync-gate.md`
- [ ] T007 [P] Align the parent handoff template identifiers with the prepared child body IDs in `specs/010-eng-2479-decomposition/contracts/parent-handoff.md`

**Checkpoint**: Foundation ready. Child body phases can proceed in dependency order.

---

## Phase 3: User Story 1 - Define The Decomposition Matrix (Priority: P1) MVP

**Goal**: Produce the proof-matrix child body that owns ENG-2479's hidden validation matrix, source fallback order, and runtime family coverage expectations.

**Independent Test**: Compare T033A against ENG-2479's blocked triage context and the ancestor chain. It passes when every proof-matrix blocker has one owner, cites ENG-2479 plus relevant ancestors, and has one valid fenced JSON issue contract.

### Validation for User Story 1

- [ ] T008 [P] [US1] Validate T033A contract shape, non-empty `contractVersion`, and unique requirement IDs in `specs/010-eng-2479-decomposition/contracts/issue-sync-gate.md`

### Implementation for User Story 1

- [ ] T009 [US1] Finalize the ENG-2479 -> ENG-392 -> ENG-351 -> ENG-347 source chain for T033A in `specs/010-eng-2479-decomposition/contracts/child-issue-bodies.md`
- [ ] T010 [US1] Finalize the runtime family matrix for `REQ-392-RUNTIME-ROUTING`, `REQ-392-RELOAD-PRESERVATION`, and `REQ-392-APPROVAL-WRITEBACK` in `specs/010-eng-2479-decomposition/contracts/child-issue-bodies.md`
- [ ] T011 [P] [US1] Finalize the source fallback order for absent `spec.md`, `plan.md`, or `tasks.md` in `specs/010-eng-2479-decomposition/data-model.md`
- [ ] T012 [US1] Finalize T033A acceptance criteria and runtime-implementation out-of-scope language in `specs/010-eng-2479-decomposition/contracts/child-issue-bodies.md`

**Checkpoint**: T033A is ready for later issue-sync review without creating a live Linear issue.

---

## Phase 4: User Story 2 - Establish An Approved Validation Path (Priority: P2)

**Goal**: Produce the execution-path child body that resolves the restricted worker/reviewer command-policy mismatch before evidence capture.

**Independent Test**: Review T033B and the validation-path model. It passes when it names an approved executor or service-owned route, explains where the focused result must be captured, and does not rely on a denied restricted-role package command.

### Validation for User Story 2

- [ ] T013 [P] [US2] Add the denied restricted-role package-command check for T033B in `specs/010-eng-2479-decomposition/contracts/issue-sync-gate.md`

### Implementation for User Story 2

- [ ] T014 [US2] Finalize the restricted worker/reviewer policy blocker and approved execution route in T033B in `specs/010-eng-2479-decomposition/contracts/child-issue-bodies.md`
- [ ] T015 [P] [US2] Finalize `Validation Path` fields for executor type, required command, artifact location, and policy boundary in `specs/010-eng-2479-decomposition/data-model.md`
- [ ] T016 [US2] Add the future worker and reviewer reference path for focused results in `specs/010-eng-2479-decomposition/quickstart.md`

**Checkpoint**: T033B can be reviewed as the approved route for producing lifecycle-bound focused preflight evidence.

---

## Phase 5: User Story 3 - Capture Exact Preflight Evidence (Priority: P3)

**Goal**: Produce the evidence-capture child body that requires exact focused preflight output or concrete findings for the planned runtime child contracts.

**Independent Test**: Review T033C against the proof matrix and validation path. It passes when it requires the exact command, outcome status, per-family coverage signal, findings on failure, and redaction of secrets and unnecessary local absolute paths.

### Validation for User Story 3

- [ ] T017 [P] [US3] Add the focused-evidence redaction and broad-CI-insufficiency validation rule for T033C in `specs/010-eng-2479-decomposition/contracts/issue-sync-gate.md`

### Implementation for User Story 3

- [ ] T018 [US3] Finalize the exact command, outcome, and runtime-family coverage obligations in T033C in `specs/010-eng-2479-decomposition/contracts/child-issue-bodies.md`
- [ ] T019 [US3] Finalize the failed-preflight findings behavior and broad-public-CI insufficiency language in `specs/010-eng-2479-decomposition/contracts/child-issue-bodies.md`
- [ ] T020 [P] [US3] Finalize `Evidence Artifact` fields for command, outcome status, family coverage, redaction, and broad CI status in `specs/010-eng-2479-decomposition/data-model.md`

**Checkpoint**: T033C can be reviewed as the child that owns exact focused preflight evidence after T033A and T033B are complete.

---

## Phase 6: User Story 4 - Unblock Parent Review Deliberately (Priority: P4)

**Goal**: Produce the parent handoff child body and template that explain what supersedes the failed review and what remains intentionally unverified.

**Independent Test**: Review T033D and the handoff template. It passes when the parent-facing summary links proof, execution path, evidence, and remaining review action without claiming lifecycle state changes or unverified live effects.

### Validation for User Story 4

- [ ] T021 [P] [US4] Add the no-unverified-live-effects validation rule for T033D in `specs/010-eng-2479-decomposition/contracts/parent-handoff.md`

### Implementation for User Story 4

- [ ] T022 [US4] Finalize the parent handoff template fields for superseded review gate, focused evidence summary, and next action in `specs/010-eng-2479-decomposition/contracts/parent-handoff.md`
- [ ] T023 [US4] Finalize the intentionally unverified Linear, GitHub, publication, merge, and lifecycle-state effects section in `specs/010-eng-2479-decomposition/contracts/parent-handoff.md`
- [ ] T024 [P] [US4] Finalize `Parent Handoff` fields and dependency on T033C in `specs/010-eng-2479-decomposition/data-model.md`

**Checkpoint**: T033D and the parent handoff template are ready for review after prerequisite child evidence exists.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Validate cross-artifact consistency and prepare the feature for later `/speckit-taskstoissues` or another approved issue-sync path.

- [ ] T025 Run a cross-artifact consistency review across `specs/010-eng-2479-decomposition/spec.md`, `specs/010-eng-2479-decomposition/plan.md`, `specs/010-eng-2479-decomposition/research.md`, `specs/010-eng-2479-decomposition/data-model.md`, `specs/010-eng-2479-decomposition/contracts/`, and `specs/010-eng-2479-decomposition/quickstart.md`
- [ ] T026 Validate every task line has a checkbox, sequential task ID, required story label, parallel marker only when safe, and file path in `specs/010-eng-2479-decomposition/tasks.md`
- [ ] T027 Verify no unresolved clarification markers, sample-template placeholders, or direct live Linear creation instructions remain under `specs/010-eng-2479-decomposition/`
- [ ] T028 Prepare readiness notes for `/speckit-taskstoissues` or manual approved issue-sync in `specs/010-eng-2479-decomposition/quickstart.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2)**: Depends on Setup completion and blocks all child body phases.
- **User Story 1 (Phase 3)**: Depends on Foundational completion.
- **User Story 2 (Phase 4)**: Depends on User Story 1 because the execution path references the proof matrix.
- **User Story 3 (Phase 5)**: Depends on User Story 1 and User Story 2 because evidence capture needs the proof matrix and approved execution path.
- **User Story 4 (Phase 6)**: Depends on User Story 3 because parent review handoff must link completed evidence.
- **Polish (Phase 7)**: Depends on all desired child body phases.

### User Story Dependencies

- **User Story 1 (P1)**: MVP. Can start after Foundational and has no dependency on later stories.
- **User Story 2 (P2)**: Depends on US1.
- **User Story 3 (P3)**: Depends on US1 and US2.
- **User Story 4 (P4)**: Depends on US3.

### Parallel Opportunities

- T002 and T003 can run in parallel after T001.
- T005, T006, and T007 can run in parallel after T004.
- T008 and T011 can run in parallel within US1.
- T013 and T015 can run in parallel within US2.
- T017 and T020 can run in parallel within US3.
- T021 and T024 can run in parallel within US4.

---

## Parallel Examples

### User Story 1

```text
Task: "Validate T033A contract shape, non-empty `contractVersion`, and unique requirement IDs in specs/010-eng-2479-decomposition/contracts/issue-sync-gate.md"
Task: "Finalize the source fallback order for absent `spec.md`, `plan.md`, or `tasks.md` in specs/010-eng-2479-decomposition/data-model.md"
```

### User Story 2

```text
Task: "Add the denied restricted-role package-command check for T033B in specs/010-eng-2479-decomposition/contracts/issue-sync-gate.md"
Task: "Finalize `Validation Path` fields for executor type, required command, artifact location, and policy boundary in specs/010-eng-2479-decomposition/data-model.md"
```

### User Story 3

```text
Task: "Add the focused-evidence redaction and broad-CI-insufficiency validation rule for T033C in specs/010-eng-2479-decomposition/contracts/issue-sync-gate.md"
Task: "Finalize `Evidence Artifact` fields for command, outcome status, family coverage, redaction, and broad CI status in specs/010-eng-2479-decomposition/data-model.md"
```

### User Story 4

```text
Task: "Add the no-unverified-live-effects validation rule for T033D in specs/010-eng-2479-decomposition/contracts/parent-handoff.md"
Task: "Finalize `Parent Handoff` fields and dependency on T033C in specs/010-eng-2479-decomposition/data-model.md"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational.
3. Complete Phase 3: User Story 1.
4. Stop and validate T033A independently against ENG-2479 and ancestor context.

### Incremental Delivery

1. Complete Setup and Foundational tasks.
2. Complete US1 proof matrix and validate independently.
3. Complete US2 execution path and validate independently.
4. Complete US3 evidence capture requirements and validate independently.
5. Complete US4 parent handoff and validate independently.
6. Complete Polish checks before any later issue-sync flow.

### Issue-Sync Guardrail

These tasks prepare Spec Kit artifacts only. Live Linear child creation, tracker writeback, lifecycle state changes, publication, merge, and protected branch updates remain out of scope until an explicit approved issue-sync or service-owned workflow is invoked.

---

## Notes

- [P] tasks use different files or validation surfaces and can be executed in parallel when prerequisite phases are complete.
- User story labels map to `specs/010-eng-2479-decomposition/spec.md`.
- Any later tracker issue generated from these artifacts must include exactly one fenced JSON Issue Contract with `schemaVersion`, `contractVersion`, and stable requirement IDs.
- Validation must preserve authority boundaries, credential hygiene, durable audit evidence, idempotent duplicate checks, and protected-surface exclusions.

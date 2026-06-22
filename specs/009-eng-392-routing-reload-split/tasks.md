# Tasks: ENG-392 Routing Reload Decomposition

**Input**: Design documents from `specs/009-eng-392-routing-reload-split/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`

**Tests**: Validation tasks are required and appear before the implementation or writeback tasks they protect.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing. When any task is converted into a Linear issue, that issue body MUST include the mandatory fenced `json` Issue Contract with `schemaVersion`, `contractVersion`, and non-empty stable requirements.

## Phase 1: Setup

**Purpose**: Reconstruct the ENG-392 blocked state and establish the evidence baseline before decomposition decisions.

- [ ] T001 Inspect ENG-392 issue contract, Linear review comments, blocked-state evidence, and PR #286 surface notes; record source links in `specs/009-eng-392-routing-reload-split/quickstart.md`
- [ ] T002 [P] Inventory current decomposition-related services in `src/core/IssueBreakdownPlanService.ts`, `src/core/IssueBreakdownPlanApplyService.ts`, and `src/core/IssueContractLint.ts`
- [ ] T003 [P] Inventory current routing/reload and approval recovery coverage in `tests/orchestrator.test.ts`
- [ ] T004 [P] Inventory protected publication surfaces in `src/core/orchestrator/Orchestrator.ts`, `src/core/CompletionReportService.ts`, `src/core/writeback/WritebackOutbox.ts`, `src/core/workspace/WorkspaceManager.ts`, `src/app/http.ts`, and `cursor/src/CursorWorkspaceOpener.ts`
- [ ] T005 Verify no planned task authorizes changes under `hermes/upstream-src/**`

---

## Phase 2: Foundational

**Purpose**: Define reusable issue-contract, validation, and publication-gate anchors that all stories depend on.

**Critical**: No user story implementation should start until this phase is complete.

- [ ] T006 [P] Finalize child issue contract family templates for `REQ-392-DECISION`, `REQ-392-TEST-PROOF`, `REQ-392-RUNTIME-ROUTING`, `REQ-392-RELOAD-PRESERVATION`, `REQ-392-APPROVAL-WRITEBACK`, and `REQ-392-PUBLICATION-HYGIENE` in `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md`
- [ ] T007 [P] Finalize publication surface comparison format and pass/fail criteria in `specs/009-eng-392-routing-reload-split/contracts/publication-surface-gate.md`
- [ ] T008 [P] Finalize base-behavior, failing-before, passing-after, surface-comparison, and hygiene evidence formats in `specs/009-eng-392-routing-reload-split/contracts/validation-evidence.md`
- [ ] T009 Add decomposition decision, publication candidate, runtime prerequisite, validation evidence, and debug artifact state rules to `specs/009-eng-392-routing-reload-split/data-model.md`
- [ ] T010 Add quickstart instructions for running issue contract lint, orchestrator validation, diff surface checks, and redaction checks in `specs/009-eng-392-routing-reload-split/quickstart.md`
- [ ] T011 Run planning artifact consistency review against `specs/009-eng-392-routing-reload-split/spec.md`, `specs/009-eng-392-routing-reload-split/plan.md`, `specs/009-eng-392-routing-reload-split/data-model.md`, and `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md`

**Checkpoint**: Foundational contract templates, evidence formats, and surface gates are ready for story work.

---

## Phase 3: User Story 1 - Choose a decomposition path (Priority: P1) MVP

**Goal**: Record an explicit ENG-392 path before any renewed worker dispatch.

**Independent Test**: Compare ENG-392's original contract, Linear comments, review findings, and publication surface, then record one decision: split/retarget, widen through child contracts, or close/replace with base-behavior evidence.

### Tests for User Story 1

- [ ] T012 [US1] Validate the original ENG-392 fenced JSON contract and required sections with `npm test -- tests/issue-contract-lint.test.ts` using `package.json`
- [ ] T013 [US1] Capture the PR #286 contract-to-surface mismatch using `git diff --name-status` and `git diff --stat` evidence in `specs/009-eng-392-routing-reload-split/quickstart.md`
- [ ] T014 [P] [US1] Capture the bounded contradiction proof requirements for tests-only versus runtime-dependent behavior in `specs/009-eng-392-routing-reload-split/contracts/validation-evidence.md`
- [ ] T015 [P] [US1] Capture the operator decision checklist and allowed outcomes in `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md`

### Implementation for User Story 1

- [ ] T016 [US1] Record the selected ENG-392 decomposition decision in `specs/009-eng-392-routing-reload-split/quickstart.md`
- [ ] T017 [US1] Prepare the `REQ-392-DECISION` Linear-ready child issue body with fenced JSON contract in `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md`
- [ ] T018 [US1] If the selected path is split/retarget, record parent-to-child dependency notes in `specs/009-eng-392-routing-reload-split/quickstart.md`
- [ ] T019 [US1] If the selected path is widened, record the widened contract boundary and child contract list in `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md`
- [ ] T020 [US1] If the selected path is close/replace, record current-base proof requirements and no-implementation disposition in `specs/009-eng-392-routing-reload-split/contracts/validation-evidence.md`

**Checkpoint**: User Story 1 is complete when ENG-392 has a recorded decision and automation is not re-dispatched against the old ambiguous contract.

---

## Phase 4: User Story 2 - Preserve the original test proof as a narrow deliverable (Priority: P2)

**Goal**: Keep the original routing/reload proof independently reviewable and limited to its authorized test-proof surface.

**Independent Test**: Run focused and broader orchestrator validation after declared dependencies are satisfied, then prove the publication candidate contains only test-proof-authorized surfaces.

### Tests for User Story 2

- [ ] T021 [US2] Validate or add focused multi-project routing test proof in `tests/orchestrator.test.ts`
- [ ] T022 [US2] Validate or add focused config-reload in-progress context preservation proof in `tests/orchestrator.test.ts`
- [ ] T023 [P] [US2] Validate or add worker retry redispatch preservation proof in `tests/orchestrator.test.ts`
- [ ] T024 [P] [US2] Validate or add reviewer redispatch preservation proof in `tests/orchestrator.test.ts`
- [ ] T025 [US2] Run focused routing/reload validation from `specs/009-eng-392-routing-reload-split/quickstart.md` using `package.json`

### Implementation for User Story 2

- [ ] T026 [US2] Prepare the `REQ-392-TEST-PROOF` Linear-ready child issue body with fenced JSON contract in `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md`
- [ ] T027 [US2] Record runtime prerequisite dependencies for the test-proof child in `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md`
- [ ] T028 [US2] Record focused and full orchestrator validation evidence for the test-proof child in `specs/009-eng-392-routing-reload-split/contracts/validation-evidence.md`
- [ ] T029 [US2] Record the test-proof publication surface comparison in `specs/009-eng-392-routing-reload-split/contracts/publication-surface-gate.md`

**Checkpoint**: User Story 2 is complete when the original test proof has a child contract, dependency list, validation evidence, and no out-of-contract publication surface.

---

## Phase 5: User Story 3 - Extract runtime prerequisites into child work (Priority: P3)

**Goal**: Give each runtime behavior discovered during review its own issue contract and validation path.

**Independent Test**: Prove every runtime prerequisite is either already satisfied on current base or represented by a child issue with focused validation and no unrelated surfaces.

### Tests for User Story 3

- [ ] T030 [US3] Capture runtime routing base-behavior or failing-before evidence for dispatch, retry, reconciliation, handoff, continuation, and readback in `specs/009-eng-392-routing-reload-split/contracts/validation-evidence.md`
- [ ] T031 [US3] Capture reload preservation base-behavior or failing-before evidence for worker and reviewer redispatch in `specs/009-eng-392-routing-reload-split/contracts/validation-evidence.md`
- [ ] T032 [US3] Capture approval/writeback base-behavior or failing-before evidence for approved, rejected, stale, and expired outcomes in `specs/009-eng-392-routing-reload-split/contracts/validation-evidence.md`
- [ ] T033 [P] [US3] Run issue-contract preflight validation for planned runtime child contracts with `npm test -- tests/issue-contract-lint.test.ts` using `package.json`
- [ ] T034 [P] [US3] Identify any status, workspace, cursor, or editor-adjacent behavior requiring separate child authorization in `specs/009-eng-392-routing-reload-split/contracts/publication-surface-gate.md`

### Implementation for User Story 3

- [ ] T035 [US3] Prepare the `REQ-392-RUNTIME-ROUTING` Linear-ready child issue body with fenced JSON contract in `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md`
- [ ] T036 [US3] Prepare the `REQ-392-RELOAD-PRESERVATION` Linear-ready child issue body with fenced JSON contract in `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md`
- [ ] T037 [US3] Prepare the `REQ-392-APPROVAL-WRITEBACK` Linear-ready child issue body with fenced JSON contract in `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md`
- [ ] T038 [US3] Record dependency ordering among runtime, reload, approval/writeback, and test-proof children in `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md`
- [ ] T039 [US3] Record service-owned writeback or manual-apply path for child issue creation in `specs/009-eng-392-routing-reload-split/quickstart.md`
- [ ] T040 [US3] If runtime implementation is authorized by a child issue, scope source changes to `src/core/orchestrator/Orchestrator.ts`, `src/core/config/Config.ts`, `src/core/workspace/WorkspaceManager.ts`, `src/core/CompletionReportService.ts`, `src/core/approval/OperatorApprovalService.ts`, and `src/core/writeback/WritebackOutbox.ts`

**Checkpoint**: User Story 3 is complete when every runtime prerequisite is either proven satisfied or owned by a child contract with explicit dependencies and authorized surfaces.

---

## Phase 6: User Story 4 - Keep evidence and publication clean (Priority: P4)

**Goal**: Ensure decomposed work leaves durable, redacted evidence and clean publication candidates.

**Independent Test**: Inspect final publication candidate and evidence for authorized scope, no orphaned debug artifacts, redaction, and validation tied to the active contract.

### Tests for User Story 4

- [ ] T041 [US4] Run publication surface gate commands from `specs/009-eng-392-routing-reload-split/quickstart.md` and record results in `specs/009-eng-392-routing-reload-split/contracts/publication-surface-gate.md`
- [ ] T042 [US4] Search for orphaned debug artifact paths and record disposition in `specs/009-eng-392-routing-reload-split/contracts/publication-surface-gate.md`
- [ ] T043 [P] [US4] Verify validation evidence contains no credential values, secret-backed profile values, or unnecessary local absolute paths in `specs/009-eng-392-routing-reload-split/contracts/validation-evidence.md`
- [ ] T044 [P] [US4] Verify final changed surfaces exclude unauthorized `src/app/http.ts`, `cursor/src/CursorWorkspaceOpener.ts`, `tests/status-api.test.ts`, and `tests/cursor-workspace-opener.test.ts` changes unless a child contract authorizes them in `specs/009-eng-392-routing-reload-split/contracts/publication-surface-gate.md`

### Implementation for User Story 4

- [ ] T045 [US4] Prepare the `REQ-392-PUBLICATION-HYGIENE` Linear-ready child issue body with fenced JSON contract in `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md`
- [ ] T046 [US4] Remove or convert any debug artifacts into deliberate redacted fixtures referenced by tests in `specs/009-eng-392-routing-reload-split/contracts/publication-surface-gate.md`
- [ ] T047 [US4] Record final parent resolution evidence and remaining intentionally unverified live integrations in `specs/009-eng-392-routing-reload-split/quickstart.md`

**Checkpoint**: User Story 4 is complete when evidence is redacted, publication surfaces are authorized, and no orphaned debug captures remain.

---

## Phase 7: Polish & Cross-Cutting Validation

**Purpose**: Final validation, protected-surface checks, and readiness for `/speckit-taskstoissues` or manual Linear issue creation.

- [ ] T048 [P] Run issue contract validation with `npm test -- tests/issue-contract-lint.test.ts` using `package.json`
- [ ] T049 [P] Run focused orchestrator validation with `npm test -- tests/orchestrator.test.ts` using `package.json`
- [ ] T050 Run TypeScript validation with `npm run typecheck` using `tsconfig.json`
- [ ] T051 Verify every child issue body in `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md` includes a valid fenced JSON contract with stable requirement IDs
- [ ] T052 Verify validation evidence and quickstart notes in `specs/009-eng-392-routing-reload-split/contracts/validation-evidence.md` and `specs/009-eng-392-routing-reload-split/quickstart.md` are redacted
- [ ] T053 Verify git diff contains no changes under `hermes/upstream-src/**`
- [ ] T054 Prepare `/speckit-taskstoissues` readiness notes and child issue dependency order in `specs/009-eng-392-routing-reload-split/quickstart.md`

---

## Dependencies & Execution Order

### Requirement Coverage

- **FR-001, FR-002, FR-010, FR-011**: Covered by setup, foundational, and US1 tasks T001-T020.
- **FR-003, FR-004, FR-009, FR-012**: Covered by US2 tasks T021-T029 and final validation T049.
- **FR-005, FR-006, FR-007**: Covered by US3 tasks T030-T040.
- **FR-008, FR-012, FR-013**: Covered by US4 tasks T041-T047 and polish tasks T051-T053.

### Phase Dependencies

- Phase 1 Setup has no dependencies.
- Phase 2 Foundational depends on Phase 1 and blocks all user stories.
- Phase 3 US1 depends on Phase 2 and is the MVP.
- Phase 4 US2 depends on US1 because the test-proof child needs a selected decomposition path.
- Phase 5 US3 depends on US1 and can proceed before US2 implementation, but US2 cannot be accepted until required runtime prerequisites are satisfied or declared dependencies.
- Phase 6 US4 depends on US1 and should run before any publication candidate is sent to review.
- Phase 7 Polish depends on selected stories being complete.

### User Story Dependencies

- **US1**: Starts after Foundational and records the required operator-facing decision.
- **US2**: Starts after US1 and preserves the original ENG-392 test proof as a narrow child.
- **US3**: Starts after US1 and decomposes runtime prerequisites into child contracts.
- **US4**: Starts after US1 and gates publication hygiene for any child candidate.

### Parallel Opportunities

- T002, T003, and T004 can run in parallel after T001.
- T006, T007, and T008 can run in parallel in Foundational.
- T014 and T015 can run in parallel with T012 and T013 after source evidence is gathered.
- T023 and T024 can run in parallel during US2 because they inspect separate redispatch scenarios.
- T033 and T034 can run in parallel during US3.
- T043 and T044 can run in parallel during US4.
- T048 and T049 can run in parallel during final validation.

---

## Parallel Example: User Story 3

```text
Task: "T030 [US3] Capture runtime routing base-behavior or failing-before evidence for dispatch, retry, reconciliation, handoff, continuation, and readback in specs/009-eng-392-routing-reload-split/contracts/validation-evidence.md"
Task: "T031 [US3] Capture reload preservation base-behavior or failing-before evidence for worker and reviewer redispatch in specs/009-eng-392-routing-reload-split/contracts/validation-evidence.md"
Task: "T032 [US3] Capture approval/writeback base-behavior or failing-before evidence for approved, rejected, stale, and expired outcomes in specs/009-eng-392-routing-reload-split/contracts/validation-evidence.md"
Task: "T034 [US3] Identify any status, workspace, cursor, or editor-adjacent behavior requiring separate child authorization in specs/009-eng-392-routing-reload-split/contracts/publication-surface-gate.md"
```

---

## Implementation Strategy

### MVP First

1. Complete Phase 1 and Phase 2.
2. Complete Phase 3 to record the decomposition decision and prevent another ambiguous ENG-392 dispatch.
3. Stop and validate the selected path before generating or applying child issues.

### Incremental Delivery

1. Decision and contract preflight first.
2. Narrow test-proof child second.
3. Runtime prerequisite children third.
4. Publication hygiene and redaction gate before any review or parent resolution.

### Parallel Team Strategy

1. One owner prepares decision evidence and operator path notes.
2. One owner prepares test-proof validation and dependency evidence.
3. One owner prepares runtime prerequisite child contracts.
4. One owner checks surface mapping, debug artifacts, and redaction before review.

## Notes

- `[P]` tasks touch different files or independent evidence sections and can run in parallel.
- `[US#]` labels map tasks to user stories in `spec.md`.
- Spec Kit artifacts are planning records; Linear issue descriptions with fenced JSON contracts remain canonical for delegated agent work.
- Do not re-dispatch ENG-392 as-is while the original contract/publication mismatch remains unresolved.
- Do not modify vendored upstream source under `hermes/upstream-src/**`.

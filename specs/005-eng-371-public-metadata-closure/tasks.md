# Tasks: ENG-371 Public Metadata Redaction Closure

**Input**: Design documents from `specs/005-eng-371-public-metadata-closure/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`

**Tests**: Validation tasks are required and appear before the implementation tasks they protect.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing. When any task is split into a Linear issue, that issue body MUST include the mandatory fenced `json` issue contract with `schemaVersion`, `contractVersion`, and non-empty stable requirements.

## Phase 1: Setup

**Purpose**: Establish the current redaction and merge-gate baseline before changing behavior.

- [ ] T001 Inspect current public metadata helpers, config normalization, and metadata consumers in `src/core/config/ProjectContexts.ts`, `src/core/config/Config.ts`, `src/core/persistence/RunTranscriptStore.ts`, `src/app/webProjection.ts`, and `src/app/http.ts`
- [ ] T002 [P] Inventory existing redaction tests and missing fixture boundaries in `tests/workflow.test.ts`, `tests/doctor.test.ts`, and `tests/credential-profiles.test.ts`
- [ ] T003 [P] Record the ENG-371 closure classification inputs in `specs/005-eng-371-public-metadata-closure/quickstart.md`
- [ ] T004 Verify no planned task requires real credential values or changes under `hermes/upstream-src/**`

---

## Phase 2: Foundational

**Purpose**: Shared redaction fixtures and contract anchors that all stories depend on.

**Critical**: No user story implementation should start until this phase is complete.

- [ ] T005 [P] Add synthetic public metadata fixture builders for tokens, private keys, env values, profile contents, and repository credentials in `tests/helpers.ts`
- [ ] T006 [P] Add forbidden-substring assertion helpers for public metadata redaction in `tests/helpers.ts`
- [ ] T007 Update public metadata contract seeds and requirement mapping in `specs/005-eng-371-public-metadata-closure/contracts/public-metadata-redaction.md`
- [ ] T008 Verify the redaction fixture set uses only synthetic values in `tests/helpers.ts`

**Checkpoint**: Shared redaction fixtures and issue-contract mapping are ready.

---

## Phase 3: User Story 1 - Prove public metadata is non-secret (Priority: P1) MVP

**Goal**: Public project-context metadata exposes useful diagnostic identity while omitting credential-bearing values.

**Independent Test**: Build public metadata from synthetic secret-bearing context inputs and confirm no forbidden values appear through either direct helper or normalized workflow paths.

### Tests for User Story 1

- [ ] T009 [US1] Add direct helper redaction tests for tokens, private keys, env values, profile contents, and capability profile values in `tests/workflow.test.ts`
- [ ] T010 [US1] Add normalized workflow configuration redaction tests that prove parity with direct helper output in `tests/workflow.test.ts`
- [ ] T011 [P] [US1] Add repository/source redaction tests for user-info, query, fragment, pathless, single-label, and ambiguous `@` values in `tests/workflow.test.ts`
- [ ] T012 [P] [US1] Add doctor/config summary redaction tests that prove validation output stays non-secret in `tests/doctor.test.ts`

### Implementation for User Story 1

- [ ] T013 [US1] Centralize public project-context metadata creation in `src/core/config/ProjectContexts.ts`
- [ ] T014 [US1] Route normalized workflow public metadata through the same helper as direct metadata calls in `src/core/config/Config.ts`
- [ ] T015 [US1] Implement safe repository/source public summaries with fail-closed redaction in `src/core/config/ProjectContexts.ts`
- [ ] T016 [US1] Update public metadata consumers to use the safe helper in `src/core/persistence/RunTranscriptStore.ts`, `src/app/webProjection.ts`, and `src/app/http.ts`

**Checkpoint**: User Story 1 is complete when public metadata passes the synthetic redaction matrix through both direct and normalized paths.

---

## Phase 4: User Story 2 - Close the merge-gate blocker without expanding scope (Priority: P2)

**Goal**: Resolve ENG-371's current merge-gate blocker while preserving reviewed redaction behavior.

**Independent Test**: Classify the current branch as conflict-only, redaction-fix, or mixed, then rerun focused redaction and merge-gate validation.

### Tests for User Story 2

- [ ] T017 [US2] Add or update focused regression coverage for any still-reproducible ENG-371 review finding in `tests/workflow.test.ts`
- [ ] T018 [P] [US2] Add validation notes for conflict-only versus behavior-changing closure in `specs/005-eng-371-public-metadata-closure/quickstart.md`

### Implementation for User Story 2

- [ ] T019 [US2] Reconcile current-base conflicts without unrelated behavior changes in `src/core/config/ProjectContexts.ts`
- [ ] T020 [US2] Update any current-base integration adjustments required by the conflict repair in `src/core/config/Config.ts`
- [ ] T021 [US2] Record merge-gate closure evidence and final change classification in `specs/005-eng-371-public-metadata-closure/quickstart.md`

**Checkpoint**: User Story 2 is complete when the ENG-371 branch can return to review or merge-ready with bounded evidence.

---

## Phase 5: User Story 3 - Preserve review evidence for future child work (Priority: P3)

**Goal**: Make discovered redaction boundaries reusable as child issue contracts and review proof targets.

**Independent Test**: Convert the redaction and merge-gate closure obligations into stable requirement IDs that can be used for Linear child issues.

### Tests for User Story 3

- [ ] T022 [US3] Add issue-contract lint coverage for ENG-371 child contract examples in `tests/issue-contract-lint.test.ts`

### Implementation for User Story 3

- [ ] T023 [US3] Finalize child issue contract requirement IDs for redaction parity, repository ambiguity, and merge-gate closure in `specs/005-eng-371-public-metadata-closure/contracts/public-metadata-redaction.md`
- [ ] T024 [US3] Add child issue creation guidance and blocking relationship notes in `specs/005-eng-371-public-metadata-closure/quickstart.md`

**Checkpoint**: User Story 3 is complete when future Linear child issues can be generated without rediscovering ENG-371 review scope.

---

## Phase 6: Polish & Cross-Cutting Validation

**Purpose**: Final validation, protected-surface checks, and promotion readiness.

- [ ] T025 [P] Run focused redaction validation with `npm test -- tests/workflow.test.ts tests/doctor.test.ts tests/credential-profiles.test.ts` using `package.json`
- [ ] T026 [P] Run public metadata consumer validation with `npm test -- tests/transcript-store.test.ts tests/web-projection-context.test.ts` using `package.json`
- [ ] T027 Run issue contract validation with `npm test -- tests/issue-contract-lint.test.ts` using `package.json`
- [ ] T028 Verify generated prompts, logs, transcripts, validation errors, and docs do not expose credential values in `src/core/`, `src/app/`, and `docs/`
- [ ] T029 Verify git diff contains no changes under `hermes/upstream-src/**`

---

## Dependencies & Execution Order

### Phase Dependencies

- Phase 1 Setup has no dependencies.
- Phase 2 Foundational depends on Phase 1 and blocks all user stories.
- Phase 3 US1 is the MVP and depends on Phase 2.
- Phase 4 US2 depends on US1 because merge-gate closure must preserve redaction behavior.
- Phase 5 US3 depends on US1 and can proceed in parallel with US2 after redaction requirements are stable.
- Phase 6 Polish depends on selected stories being complete.

### Parallel Opportunities

- T002 and T003 can run in parallel after T001.
- T005 and T006 can run in parallel.
- T011 and T012 can run in parallel with T009 and T010 after fixtures exist.
- T018 can run in parallel with T017.
- T025 and T026 can run in parallel during final validation.

## Implementation Strategy

### MVP First

1. Complete Phase 1 and Phase 2.
2. Complete Phase 3 to prove redaction behavior independently.
3. Stop and validate the redaction matrix before merge-gate repair.

### Incremental Delivery

1. Redaction proof first.
2. Merge-gate closure second.
3. Child issue contract preservation third.

# Tasks: ENG-443 Legacy Backfill Resolution

**Input**: Design documents from `specs/008-eng-443-legacy-backfill-resolution/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`

**Tests**: Validation tasks are required and appear before the implementation tasks they protect.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing. When any task is split into a Linear issue, that issue body MUST include the mandatory fenced `json` issue contract with `schemaVersion`, `contractVersion`, and non-empty stable requirements.

## Phase 1: Setup

**Purpose**: Establish current base behavior and PR disposition inputs before implementation.

- [ ] T001 Inspect current legacy run/workspace backfill behavior in `src/core/persistence/RunTranscriptStore.ts`, `src/core/workspace/WorkspaceManager.ts`, `src/app/WebHistoryProjection.ts`, `src/app/WebTranscriptProjection.ts`, and `src/app/WebProjectionContext.ts`
- [ ] T002 [P] Inventory existing historical readback tests in `tests/transcript-store.test.ts`, `tests/transcript-replay.test.ts`, `tests/workspace.test.ts`, and `tests/web-history-projection.test.ts`
- [ ] T003 [P] Record the current-main proof method and no-op PR classification checklist in `specs/008-eng-443-legacy-backfill-resolution/quickstart.md`
- [ ] T004 Verify no planned task requires destructive migration of historical records or changes under `hermes/upstream-src/**`

---

## Phase 2: Foundational

**Purpose**: Shared legacy fixtures and decision evidence shapes that all stories depend on.

**Critical**: No user story implementation should start until this phase is complete.

- [ ] T005 [P] Add legacy run record fixture builders without project-context metadata in `tests/helpers.ts`
- [ ] T006 [P] Add legacy workspace record fixture builders without project-context metadata in `tests/helpers.ts`
- [ ] T007 [P] Add synthetic default/legacy project-context metadata assertions in `tests/helpers.ts`
- [ ] T008 Add backfill decision and no-op disposition evidence shapes to `specs/008-eng-443-legacy-backfill-resolution/data-model.md`
- [ ] T009 Update legacy backfill and no-op PR contract seeds in `specs/008-eng-443-legacy-backfill-resolution/contracts/legacy-backfill-readback.md` and `specs/008-eng-443-legacy-backfill-resolution/contracts/no-op-pr-disposition.md`

**Checkpoint**: Shared fixtures and evidence contract anchors are ready.

---

## Phase 3: User Story 1 - Decide whether the backfill requirement is already satisfied (Priority: P1) MVP

**Goal**: Prove whether current `main` already satisfies legacy run and workspace project-context backfill on read.

**Independent Test**: Run current-base readback scenarios for legacy run and workspace records and classify the active PR before implementation proceeds.

### Tests for User Story 1

- [ ] T010 [US1] Add current-base legacy run readback proof tests in `tests/transcript-store.test.ts`
- [ ] T011 [US1] Add current-base legacy workspace readback proof tests in `tests/workspace.test.ts`
- [ ] T012 [P] [US1] Add projection readback proof tests for satisfied-on-base behavior in `tests/web-history-projection.test.ts`
- [ ] T013 [P] [US1] Add no-op PR disposition checklist validation notes in `specs/008-eng-443-legacy-backfill-resolution/quickstart.md`

### Implementation for User Story 1

- [ ] T014 [US1] Run the current-base proof tests and record run/workspace results in `specs/008-eng-443-legacy-backfill-resolution/quickstart.md`
- [ ] T015 [US1] Compare the active ENG-443 PR against current base and record `empty`, `behaviorally_redundant`, or `non_empty` disposition in `specs/008-eng-443-legacy-backfill-resolution/quickstart.md`
- [ ] T016 [US1] If current base satisfies the contract, prepare close, retarget, or replace guidance in `specs/008-eng-443-legacy-backfill-resolution/contracts/no-op-pr-disposition.md`
- [ ] T017 [US1] Apply or record the selected service-owned ENG-443 disposition with exact Linear/GitHub follow-up evidence in `specs/008-eng-443-legacy-backfill-resolution/quickstart.md`

**Checkpoint**: User Story 1 is complete when ENG-443 has a recorded base-behavior decision and PR disposition.

---

## Phase 4: User Story 2 - Implement only a proven missing backfill path (Priority: P2)

**Goal**: If current base does not satisfy the contract, repair only the exact failing legacy-read path.

**Independent Test**: Capture failing-before evidence for a specific legacy path, implement the smallest repair, and capture passing-after evidence.

### Tests for User Story 2

- [ ] T018 [US2] If run readback is missing, add a failing-before legacy run context test in `tests/transcript-store.test.ts`
- [ ] T019 [US2] If workspace readback is missing, add a failing-before legacy workspace context test in `tests/workspace.test.ts`
- [ ] T020 [P] [US2] If projection readback is missing, add a failing-before projection context test in `tests/web-history-projection.test.ts`

### Implementation for User Story 2

- [ ] T021 [US2] Implement missing legacy run read-time default or legacy attribution in `src/core/persistence/RunTranscriptStore.ts`
- [ ] T022 [US2] Implement missing legacy workspace read-time default or legacy attribution in `src/core/workspace/WorkspaceManager.ts`
- [ ] T023 [US2] Implement missing projection readback attribution in `src/app/WebHistoryProjection.ts`, `src/app/WebTranscriptProjection.ts`, and `src/app/WebProjectionContext.ts`
- [ ] T024 [US2] Record failing-before and passing-after evidence for any implemented path in `specs/008-eng-443-legacy-backfill-resolution/quickstart.md`

**Checkpoint**: User Story 2 is complete only if a proven missing read path exists and is repaired with before/after evidence.

---

## Phase 5: User Story 3 - Preserve historical readability without leaking secrets (Priority: P3)

**Goal**: Historical records remain readable with stable non-secret default or legacy attribution.

**Independent Test**: Read representative older run, workspace, transcript, and projection records and confirm safe attribution without credential exposure.

### Tests for User Story 3

- [ ] T025 [US3] Add redaction assertions for backfilled legacy context metadata in `tests/transcript-store.test.ts`
- [ ] T026 [P] [US3] Add transcript replay tests for legacy/default attribution in `tests/transcript-replay.test.ts`
- [ ] T027 [P] [US3] Add web transcript projection tests for legacy/default attribution in `tests/web-transcript-projection.test.ts`
- [ ] T028 [P] [US3] Add issue-contract lint coverage for ENG-443 child contract examples in `tests/issue-contract-lint.test.ts`

### Implementation for User Story 3

- [ ] T029 [US3] Ensure backfilled project-context metadata uses only non-secret public metadata in `src/core/persistence/RunTranscriptStore.ts`
- [ ] T030 [US3] Ensure transcript and projection readback surfaces mark attribution source as legacy/default in `src/app/WebTranscriptProjection.ts` and `src/app/WebHistoryProjection.ts`
- [ ] T031 [US3] Finalize child issue contract requirement IDs for base proof, missing-path repair, no-op disposition, and validation evidence in `specs/008-eng-443-legacy-backfill-resolution/contracts/legacy-backfill-readback.md`
- [ ] T032 [US3] Add child issue creation guidance and blocking relationship notes in `specs/008-eng-443-legacy-backfill-resolution/quickstart.md`

**Checkpoint**: User Story 3 is complete when historical readback is safe, attributable, and ready for child issue generation.

---

## Phase 6: Polish & Cross-Cutting Validation

**Purpose**: Final validation, protected-surface checks, and promotion readiness.

- [ ] T033 [P] Run legacy readback validation with `npm test -- tests/transcript-store.test.ts tests/transcript-replay.test.ts tests/workspace.test.ts` using `package.json`
- [ ] T034 [P] Run projection readback validation with `npm test -- tests/web-history-projection.test.ts tests/web-transcript-projection.test.ts tests/web-projection-context.test.ts` using `package.json`
- [ ] T035 Run issue contract validation with `npm test -- tests/issue-contract-lint.test.ts` using `package.json`
- [ ] T036 Verify readback evidence, logs, transcripts, and projection output do not expose credential values in `src/core/`, `src/app/`, and `specs/008-eng-443-legacy-backfill-resolution/quickstart.md`
- [ ] T037 Verify no task rewrote historical records during ordinary readback in `src/core/persistence/RunTranscriptStore.ts` and `src/core/workspace/WorkspaceManager.ts`
- [ ] T038 Verify git diff contains no changes under `hermes/upstream-src/**`

---

## Dependencies & Execution Order

### Phase Dependencies

- Phase 1 Setup has no dependencies.
- Phase 2 Foundational depends on Phase 1 and blocks all user stories.
- Phase 3 US1 is the MVP and depends on Phase 2.
- Phase 4 US2 depends on US1 and should run only if US1 proves a missing read path.
- Phase 5 US3 depends on US1 and any selected US2 repair.
- Phase 6 Polish depends on selected stories being complete.

### Parallel Opportunities

- T002 and T003 can run in parallel after T001.
- T005, T006, and T007 can run in parallel.
- T012 and T013 can run in parallel with T010 and T011.
- T018, T019, and T020 can run in parallel if US1 proves multiple missing paths.
- T025, T026, T027, and T028 can run in parallel.
- T033 and T034 can run in parallel during final validation.

## Implementation Strategy

### MVP First

1. Complete Phase 1 and Phase 2.
2. Complete Phase 3 to classify current-base behavior and PR disposition.
3. Stop and resolve, retarget, or continue based on evidence.

### Incremental Delivery

1. Base proof and no-op disposition first.
2. Missing-path implementation only if proven.
3. Historical readability and child issue contract polish last.

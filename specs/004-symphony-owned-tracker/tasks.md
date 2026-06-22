# Tasks: Symphony Owned Tracker

**Input**: Design documents from `/specs/004-symphony-owned-tracker/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: Tests and concrete validation tasks are required before implementation tasks they protect.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel with other marked tasks in the same phase because it touches different files and has no dependency on incomplete tasks.
- **[Story]**: User story label for story phases only.
- Every task includes exact repository paths.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Prepare the native tracker implementation surface and test scaffolding.

- [ ] T001 Verify active Spec Kit pointers for this feature in `.specify/feature.json` and `AGENTS.md`
- [ ] T002 Create native tracker integration module placeholders in `src/integrations/symphony/SymphonyTrackerRepository.ts` and `src/integrations/symphony/SymphonyTrackerClient.ts`
- [ ] T003 [P] Create shared native tracker fixtures and helpers in `tests/symphony-tracker.test.ts`
- [ ] T004 [P] Create tracker factory module placeholder in `src/core/tracker/TrackerFactory.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish datastore schema, provider selection, and native tracker skeletons required by all stories.

**CRITICAL**: No user story work can begin until this phase is complete.

- [ ] T005 [P] Add failing native tracker schema assertions for issue, blocker, comment, and transition storage in `tests/postgres-schema.test.ts`
- [ ] T006 Add checksum-safe native tracker migration with authoritative issue, blocker, comment, and transition tables in `migrations/postgres/0007_symphony_owned_tracker.sql`
- [ ] T007 Update configured migration ordering and checksum expectations for `0007_symphony_owned_tracker` in `tests/postgres-schema.test.ts`
- [ ] T008 [P] Add failing workflow config tests for `tracker.kind = "symphony"` and unknown tracker kinds in `tests/workflow.test.ts`
- [ ] T009 Generalize tracker config parsing for `linear` and `symphony` providers in `src/core/config/Config.ts`
- [ ] T010 [P] Add failing provider-selection and datastore-unavailable startup tests for native tracker runtime construction in `tests/runtime-dependencies.test.ts`
- [ ] T011 Implement tracker provider factory selection in `src/core/tracker/TrackerFactory.ts`
- [ ] T012 Wire runtime tracker and writeback construction through the provider factory in `src/app/RuntimeDependencies.ts`
- [ ] T013 Define native tracker repository query interfaces, row types, and row-to-domain mapping boundaries in `src/integrations/symphony/SymphonyTrackerRepository.ts`
- [ ] T014 Define native tracker client class skeleton implementing `TrackerClient` and `TrackerWriter` in `src/integrations/symphony/SymphonyTrackerClient.ts`

**Checkpoint**: Native provider can be selected by configuration, migrations include authoritative tracker storage, and user story implementation can begin.

---

## Phase 3: User Story 1 - Run From Symphony-Owned Issues (Priority: P1) MVP

**Goal**: Configure Symphony to use the native tracker, seed one eligible issue, and dispatch through the existing worker path without Linear.

**Independent Test**: Configure `tracker.kind = "symphony"`, seed one eligible issue with a valid issue contract, start or simulate runtime polling, and confirm the issue is selected for worker dispatch without Linear credentials.

### Tests for User Story 1

- [ ] T015 [P] [US1] Add candidate read tests for one seeded eligible native issue and malformed native rows missing required issue fields in `tests/symphony-tracker.test.ts`
- [ ] T016 [P] [US1] Add no-Linear runtime provider selection test for native tracker in `tests/runtime-dependencies.test.ts`
- [ ] T017 [P] [US1] Add worker dispatch regression using a native tracker issue in `tests/orchestrator.test.ts`

### Implementation for User Story 1

- [ ] T018 [US1] Implement native issue insert/read helpers and candidate query in `src/integrations/symphony/SymphonyTrackerRepository.ts`
- [ ] T019 [US1] Implement `fetchCandidateIssues` and `fetchIssuesByStates` for native issues in `src/integrations/symphony/SymphonyTrackerClient.ts`
- [ ] T020 [US1] Construct native tracker clients from configured Postgres access in `src/core/tracker/TrackerFactory.ts`
- [ ] T021 [US1] Normalize returned `Issue` fields, labels, timestamps, and worker routing in `src/integrations/symphony/SymphonyTrackerClient.ts`
- [ ] T022 [US1] Ensure native tracker runtime construction does not require Linear credentials in `src/app/RuntimeDependencies.ts`
- [ ] T023 [US1] Implement native issue seed helper utilities for valid issue-contract descriptions in `tests/symphony-tracker.test.ts`

**Checkpoint**: User Story 1 works independently as the MVP replacement path.

---

## Phase 4: User Story 2 - Preserve Tracker Semantics (Priority: P2)

**Goal**: Match existing Symphony runtime expectations for blockers, ID/identifier refresh, labels, states, and dispatch eligibility.

**Independent Test**: Create representative native issues across active, review, blocked, handoff, and terminal states with open and resolved blockers, then confirm dispatch and refresh decisions match the current tracker semantics.

### Tests for User Story 2

- [ ] T024 [US2] Add open and terminal blocker semantics tests in `tests/symphony-tracker.test.ts`
- [ ] T025 [US2] Add durable ID, human identifier, missing issue, and duplicate identifier refresh tests in `tests/symphony-tracker.test.ts`
- [ ] T026 [P] [US2] Add label, state, and blocker dispatch eligibility regression tests in `tests/orchestrator.test.ts`

### Implementation for User Story 2

- [ ] T027 [US2] Implement blocker reference persistence and self-block/duplicate validation in `src/integrations/symphony/SymphonyTrackerRepository.ts`
- [ ] T028 [US2] Implement blocker loading and `IssueBlockerRef` mapping in `src/integrations/symphony/SymphonyTrackerClient.ts`
- [ ] T029 [US2] Implement durable ID and human identifier refresh semantics in `src/integrations/symphony/SymphonyTrackerRepository.ts`
- [ ] T030 [US2] Implement `fetchIssueStatesByIds` duplicate-identifier fail-closed behavior in `src/integrations/symphony/SymphonyTrackerClient.ts`
- [ ] T031 [US2] Tighten state and label normalization for native tracker comparisons in `src/integrations/symphony/SymphonyTrackerClient.ts`

**Checkpoint**: User Stories 1 and 2 both work independently with native issue semantics aligned to current runtime expectations.

---

## Phase 5: User Story 3 - Service-Owned Tracker Mutations (Priority: P3)

**Goal**: Support minimum native tracker writeback for state transitions and idempotent comments while failing closed for unsupported optional operations.

**Independent Test**: Complete or simulate a worker/reviewer flow that requests a transition and comment, restart or retry writeback, and confirm no duplicate logical tracker effects.

### Tests for User Story 3

- [ ] T032 [US3] Add atomic transition, allowed-source-state, already-target-state, and conflict tests in `tests/symphony-tracker.test.ts`
- [ ] T033 [US3] Add idempotent comment writeback and redacted message tests in `tests/symphony-tracker.test.ts`
- [ ] T034 [P] [US3] Add native writer retry and datastore-unavailable writeback integration tests through the writeback processor in `tests/writeback-outbox.test.ts`

### Implementation for User Story 3

- [ ] T035 [US3] Implement transactional issue state transition and transition evidence writes in `src/integrations/symphony/SymphonyTrackerRepository.ts`
- [ ] T036 [US3] Implement `transitionIssueState` result mapping and conflict handling in `src/integrations/symphony/SymphonyTrackerClient.ts`
- [ ] T037 [US3] Implement idempotent comment insert/verify by issue and dedupe key in `src/integrations/symphony/SymphonyTrackerRepository.ts`
- [ ] T038 [US3] Implement `createIssueComment` result mapping and secret-safe messages in `src/integrations/symphony/SymphonyTrackerClient.ts`
- [ ] T039 [US3] Implement explicit unsupported handling for `createIssueFromPlan` and `createIssueRelation` in `src/integrations/symphony/SymphonyTrackerClient.ts`

**Checkpoint**: Native tracker can perform minimum service-owned writeback and preserves idempotent retry behavior.

---

## Phase 6: User Story 4 - Keep Linear Available (Priority: P4)

**Goal**: Preserve existing Linear behavior while native tracker selection bypasses Linear-specific startup, diagnostic, and credential assumptions.

**Independent Test**: Run Linear-backed config and tracker tests after adding the native provider, then run native provider diagnostics without Linear credentials.

### Tests for User Story 4

- [ ] T040 [P] [US4] Add Linear credential and project slug regression tests for `tracker.kind = "linear"` in `tests/workflow.test.ts`
- [ ] T041 [P] [US4] Add Linear provider construction regression tests in `tests/runtime-dependencies.test.ts`
- [ ] T042 [P] [US4] Add provider-specific doctor diagnostics tests for Linear and Symphony trackers in `tests/doctor.test.ts`
- [ ] T043 [P] [US4] Add gated merge policy credential regression for non-Linear tracker selection in `tests/merge-policy-service.test.ts`

### Implementation for User Story 4

- [ ] T044 [US4] Keep Linear tracker construction routed through existing resolver when selected in `src/core/tracker/TrackerFactory.ts`
- [ ] T045 [US4] Refactor doctor tracker checks to branch by selected provider in `src/doctor.ts`
- [ ] T046 [US4] Refactor gated merge policy tracker credential checks away from Linear-only assumptions in `src/core/merge/MergePolicyService.ts`
- [ ] T047 [US4] Preserve Linear credential resolver behavior and update imports only where needed in `src/integrations/linear/LinearCredentialResolver.ts`

**Checkpoint**: Linear-backed workflows remain compatible and native tracker diagnostics do not fail because Linear is absent.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Validate the complete feature and guard scope boundaries.

- [ ] T048 [P] Run TypeScript typecheck using `package.json` script `npm run typecheck`
- [ ] T049 Run focused tracker/config tests using `package.json` script `npx vitest run tests/symphony-tracker.test.ts tests/workflow.test.ts tests/runtime-dependencies.test.ts tests/doctor.test.ts tests/merge-policy-service.test.ts tests/writeback-outbox.test.ts --no-file-parallelism`
- [ ] T050 Run Postgres migration validation using `package.json` script `npm run migrations:validate -- WORKFLOW.md`
- [ ] T051 Run full test suite using `package.json` script `npm test`
- [ ] T052 [P] Confirm no projection-layer files were modified outside documented scope using `src/app/webProjection.ts`, `src/app/WebProjectionContext.ts`, and `migrations/postgres/0003_projection_freshness_indexes.sql`
- [ ] T053 [P] Update implementation notes in `specs/004-symphony-owned-tracker/quickstart.md` if validation commands or config snippets change during implementation

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2)**: Depends on Setup; blocks all user stories.
- **User Story 1 (Phase 3)**: Depends on Foundational; MVP target.
- **User Story 2 (Phase 4)**: Depends on Foundational; can be developed independently but will touch the same native tracker files as US1.
- **User Story 3 (Phase 5)**: Depends on Foundational; writeback tests can be developed independently after repository/client skeletons exist.
- **User Story 4 (Phase 6)**: Depends on Foundational; can proceed in parallel with native tracker behavior work when file ownership is coordinated.
- **Polish (Phase 7)**: Depends on all desired user stories.

### User Story Dependencies

- **US1 Run From Symphony-Owned Issues**: Required MVP; no dependency on US2-US4.
- **US2 Preserve Tracker Semantics**: Builds on the same provider skeleton; does not require US3 or US4.
- **US3 Service-Owned Tracker Mutations**: Requires the native provider skeleton and datastore tables; does not require US2 beyond shared issue identity behavior.
- **US4 Keep Linear Available**: Requires provider selection foundation; does not require native read/write behavior to be complete for Linear regression work.

### Parallel Opportunities

- T003 and T004 can run in parallel after T001.
- T005, T008, and T010 can run in parallel because they touch different test files.
- T015, T016, and T017 can run in parallel for US1.
- T026 can run in parallel with T024/T025 for US2.
- T034 can run in parallel with T032/T033 for US3.
- T040, T041, T042, and T043 can run in parallel for US4.
- T048, T052, and T053 can run in parallel during polish.

---

## Parallel Example: User Story 1

```text
Task: "T015 [P] [US1] Add candidate read tests for one seeded eligible native issue in tests/symphony-tracker.test.ts"
Task: "T016 [P] [US1] Add no-Linear runtime provider selection test for native tracker in tests/runtime-dependencies.test.ts"
Task: "T017 [P] [US1] Add worker dispatch regression using a native tracker issue in tests/orchestrator.test.ts"
```

---

## Parallel Example: User Story 4

```text
Task: "T040 [P] [US4] Add Linear credential and project slug regression tests for tracker.kind = linear in tests/workflow.test.ts"
Task: "T041 [P] [US4] Add Linear provider construction regression tests in tests/runtime-dependencies.test.ts"
Task: "T042 [P] [US4] Add provider-specific doctor diagnostics tests for Linear and Symphony trackers in tests/doctor.test.ts"
Task: "T043 [P] [US4] Add gated merge policy credential regression for non-Linear tracker selection in tests/merge-policy-service.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1 setup.
2. Complete Phase 2 foundation.
3. Complete Phase 3 US1.
4. Stop and validate: native tracker selected, Linear absent, one eligible native issue dispatches.
5. Do not begin projection work.

### Incremental Delivery

1. Foundation enables provider selection and authoritative native tracker storage.
2. US1 proves Linear replacement for worker candidate dispatch.
3. US2 tightens semantics for blockers, labels, states, and refresh behavior.
4. US3 adds minimum state/comment writeback with idempotency.
5. US4 confirms Linear compatibility and provider-specific diagnostics.
6. Polish validates typecheck, migrations, focused tests, full tests, and scope boundaries.

### Issue Contract Reminder

If any task is converted into a tracker issue, the issue body must include a fenced `json` issue contract with `schemaVersion`, `contractVersion`, and one stable requirement entry per obligation. Do not promote or delegate prose-only task issues.

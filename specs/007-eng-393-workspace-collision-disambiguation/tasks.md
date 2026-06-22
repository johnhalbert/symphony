# Tasks: ENG-393 Workspace Collision Disambiguation

**Input**: Design documents from `specs/007-eng-393-workspace-collision-disambiguation/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`

**Tests**: Validation tasks are required and appear before the implementation tasks they protect.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing. When any task is split into a Linear issue, that issue body MUST include the mandatory fenced `json` issue contract with `schemaVersion`, `contractVersion`, and non-empty stable requirements.

## Phase 1: Setup

**Purpose**: Map current workspace, branch, and readback collision assumptions before changing behavior.

- [ ] T001 Inspect current workspace identity, branch fallback, branch-template safety, summary lookup, status pointer, and cleanup behavior in `src/core/workspace/WorkspaceManager.ts`, `src/core/workspace/GitWorktreeManager.ts`, `src/core/persistence/RunTranscriptStore.ts`, `src/core/persistence/IssueLifecycleStore.ts`, `src/app/http.ts`, and `src/app/WebProjectionContext.ts`
- [ ] T002 [P] Inventory existing collision and workspace tests in `tests/git-worktree.test.ts`, `tests/workspace.test.ts`, `tests/transcript-store.test.ts`, and `tests/status-api.test.ts`
- [ ] T003 [P] Document the duplicate-identifier and cache-poisoning validation matrix in `specs/007-eng-393-workspace-collision-disambiguation/quickstart.md`
- [ ] T004 Verify no planned task mutates operator workspaces destructively or changes `hermes/upstream-src/**`

---

## Phase 2: Foundational

**Purpose**: Shared exact-identity and duplicate-context fixtures that all stories depend on.

**Critical**: No user story implementation should start until this phase is complete.

- [ ] T005 [P] Add duplicate-context issue fixture builders with exact issue identity and visible identifier variants in `tests/helpers.ts`
- [ ] T006 [P] Add null tracker branch metadata and branch-template fixture builders in `tests/helpers.ts`
- [ ] T007 [P] Add legacy workspace artifact fixture builders for records, summaries, and status pointers in `tests/helpers.ts`
- [ ] T008 Add exact issue identity and branch safety input types needed by workspace decisions in `src/core/types.ts`
- [ ] T009 Update workspace identity and branch fallback contract seeds in `specs/007-eng-393-workspace-collision-disambiguation/contracts/workspace-identity.md` and `specs/007-eng-393-workspace-collision-disambiguation/contracts/branch-fallback-safety.md`

**Checkpoint**: Shared collision fixtures and contract anchors are ready.

---

## Phase 3: User Story 1 - Keep duplicate issue identifiers separate (Priority: P1) MVP

**Goal**: Duplicate visible issue identifiers in different contexts produce distinct workspace identity, paths, readback, and cleanup behavior.

**Independent Test**: Create two workspaces for duplicate visible identifiers across contexts, then open, summarize, resume, and clean up one without affecting the other.

### Tests for User Story 1

- [ ] T010 [US1] Add workspace key and path collision tests for duplicate visible issue identifiers across contexts in `tests/git-worktree.test.ts`
- [ ] T011 [US1] Add exact-id workspace open and reuse tests for duplicate identifiers in `tests/workspace.test.ts`
- [ ] T012 [P] [US1] Add cleanup isolation tests proving one context cannot remove a sibling workspace in `tests/git-worktree.test.ts`
- [ ] T013 [P] [US1] Add summary and resume readback tests for exact issue identity in `tests/transcript-store.test.ts`

### Implementation for User Story 1

- [ ] T014 [US1] Derive workspace keys from exact issue identity and project context in `src/core/workspace/WorkspaceManager.ts`
- [ ] T015 [US1] Derive workspace paths from exact issue identity and project context in `src/core/workspace/WorkspaceManager.ts`
- [ ] T016 [US1] Update workspace open, reuse, and cleanup lookups to require exact identity when duplicates exist in `src/core/workspace/WorkspaceManager.ts`
- [ ] T017 [US1] Persist exact issue identity on workspace and run readback records in `src/core/persistence/RunTranscriptStore.ts`
- [ ] T018 [US1] Update HTTP workspace/status lookups to avoid visible-identifier-only selection in `src/app/http.ts`

**Checkpoint**: User Story 1 is complete when duplicate visible identifiers cannot collide in workspace keys, paths, lookup, or cleanup.

---

## Phase 4: User Story 2 - Make branch fallback collision-safe (Priority: P2)

**Goal**: Null branch metadata and branch-template safety checks remain safe for every configured branch template and issue context.

**Independent Test**: Prime branch safety with one contextual issue, then process a duplicate-identifier sibling and prove the sibling receives an independently evaluated safe branch.

### Tests for User Story 2

- [ ] T019 [US2] Add null tracker branch metadata fallback tests for duplicate-context issues in `tests/git-worktree.test.ts`
- [ ] T020 [US2] Add branch-template collision tests for duplicate visible identifiers across contexts in `tests/git-worktree.test.ts`
- [ ] T021 [US2] Add branch-safety cache poisoning regression that primes one issue before evaluating a sibling in `tests/git-worktree.test.ts`
- [ ] T022 [P] [US2] Add branch fallback evidence assertions for selected branch source and collision reason in `tests/git-worktree.test.ts`

### Implementation for User Story 2

- [ ] T023 [US2] Build branch safety input from project context, canonical issue identity, visible identifier, template, repository, tracker branch metadata, and candidate branch in `src/core/workspace/WorkspaceManager.ts`
- [ ] T024 [US2] Scope or remove branch-template safety caching so one issue cannot poison another issue's branch decision in `src/core/workspace/WorkspaceManager.ts`
- [ ] T025 [US2] Generate deterministic context-safe fallback branches when tracker branch metadata is null or unsafe in `src/core/workspace/WorkspaceManager.ts`
- [ ] T026 [US2] Ensure Git worktree creation receives the selected safe branch and source evidence in `src/core/workspace/GitWorktreeManager.ts`

**Checkpoint**: User Story 2 is complete when branch fallback is deterministic, context-safe, and immune to cache poisoning.

---

## Phase 5: User Story 3 - Preserve legacy workspace readability (Priority: P3)

**Goal**: Older workspace records and summaries remain readable without blocking new context-safe workspace names.

**Independent Test**: Seed legacy artifacts, create or read exact-context workspaces with duplicate identifiers, and confirm legacy readback is safe and unambiguous.

### Tests for User Story 3

- [ ] T027 [US3] Add legacy workspace record readback tests with reserved-prefix and missing-context artifacts in `tests/transcript-store.test.ts`
- [ ] T028 [US3] Add exact-id status pointer and continuation summary tests with duplicate visible identifiers in `tests/status-api.test.ts`
- [ ] T029 [P] [US3] Add web projection alias tests for legacy and exact-context workspace references in `tests/web-projection-context.test.ts`
- [ ] T030 [P] [US3] Add transcript replay tests for legacy workspace attribution in `tests/transcript-replay.test.ts`

### Implementation for User Story 3

- [ ] T031 [US3] Implement legacy workspace artifact readback modes without destructive mutation in `src/core/persistence/RunTranscriptStore.ts`
- [ ] T032 [US3] Prevent legacy reserved-prefix or ambiguous workspace artifacts from blocking new context-safe workspace creation in `src/core/workspace/WorkspaceManager.ts`
- [ ] T033 [US3] Update lifecycle summary pointer lookup to use exact issue identity where available in `src/core/persistence/IssueLifecycleStore.ts`
- [ ] T034 [US3] Update status and continuation summary routes to resolve exact issue identity before readback in `src/app/http.ts`
- [ ] T035 [US3] Update projection alias handling for context-qualified and legacy workspace references in `src/app/WebProjectionContext.ts`
- [ ] T036 [US3] Finalize child issue contract requirement IDs for workspace identity, branch fallback, legacy artifacts, and exact-id readback in `specs/007-eng-393-workspace-collision-disambiguation/contracts/workspace-identity.md`

**Checkpoint**: User Story 3 is complete when legacy artifacts remain readable and cannot collide with new exact-context workspace identity.

---

## Phase 6: Polish & Cross-Cutting Validation

**Purpose**: Final validation, protected-surface checks, and promotion readiness.

- [ ] T037 [P] Run workspace and branch validation with `npm test -- tests/git-worktree.test.ts tests/workspace.test.ts` using `package.json`
- [ ] T038 [P] Run readback validation with `npm test -- tests/transcript-store.test.ts tests/transcript-replay.test.ts tests/status-api.test.ts` using `package.json`
- [ ] T039 [P] Run projection alias validation with `npm test -- tests/web-projection-context.test.ts` using `package.json`
- [ ] T040 Run issue contract validation with `npm test -- tests/issue-contract-lint.test.ts` using `package.json`
- [ ] T041 Verify workspace cleanup and migration behavior never deletes or rewrites operator-controlled artifacts implicitly in `src/core/workspace/WorkspaceManager.ts` and `src/core/persistence/RunTranscriptStore.ts`
- [ ] T042 Verify git diff contains no changes under `hermes/upstream-src/**`

---

## Dependencies & Execution Order

### Phase Dependencies

- Phase 1 Setup has no dependencies.
- Phase 2 Foundational depends on Phase 1 and blocks all user stories.
- Phase 3 US1 is the MVP and depends on Phase 2.
- Phase 4 US2 depends on US1 because branch fallback needs exact issue identity.
- Phase 5 US3 depends on US1 and can proceed in parallel with US2 after exact identity is available.
- Phase 6 Polish depends on selected stories being complete.

### Parallel Opportunities

- T002 and T003 can run in parallel after T001.
- T005, T006, and T007 can run in parallel.
- T012 and T013 can run in parallel with T010 and T011.
- T022 can run in parallel with other US2 tests.
- T029 and T030 can run in parallel with T027 and T028.
- T037, T038, and T039 can run in parallel during final validation.

## Implementation Strategy

### MVP First

1. Complete Phase 1 and Phase 2.
2. Complete Phase 3 to make workspace identity collision-safe.
3. Stop and validate duplicate visible identifier workspace behavior.

### Incremental Delivery

1. Workspace identity first.
2. Branch fallback safety second.
3. Legacy readback compatibility third.

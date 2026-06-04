# Tasks: Configure Agent Role Models

**Input**: Design documents from `specs/002-agent-role-models/`

**Prerequisites**: `specs/002-agent-role-models/plan.md`, `specs/002-agent-role-models/spec.md`, `specs/002-agent-role-models/research.md`, `specs/002-agent-role-models/data-model.md`, `specs/002-agent-role-models/contracts/role-model-configuration.md`

**Tests**: Required. Each story includes failing tests or concrete validation tasks before implementation work.

**Organization**: Tasks are grouped by user story so the MVP can ship with User Story 1 while later stories remain independently testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel because it touches different files or independent assertions
- **[Story]**: Maps task to a user story from `specs/002-agent-role-models/spec.md`
- **BLOCKED**: Must not be implemented until the named dependency is complete

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish the implementation footing and protect existing dirty worktree surfaces.

- [ ] T001 Inspect existing model configuration and metadata paths in `src/core/config/Config.ts`, `src/core/orchestrator/Orchestrator.ts`, `cursor/src/CursorHarness.ts`, and `hermes/src/HermesHarness.ts`
- [ ] T002 [P] Inspect existing run evidence and projection paths in `src/core/persistence/RunTranscriptStore.ts`, `src/app/webProjection.ts`, `src/app/WebHistoryProjection.ts`, and `src/app/WebTranscriptProjection.ts`
- [ ] T003 [P] Inspect dirty orchestrator conversation changes before editing `src/core/persistence/OrchestratorConversationStore.ts` and `tests/orchestrator-conversation-store.test.ts`
- [ ] T004 [P] Confirm no task requires vendored Hermes edits by checking `hermes/upstream-src/` and documenting any read-only evidence in `specs/002-agent-role-models/quickstart.md`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Add the shared role-model contract used by all stable harnesses and metadata paths.

**CRITICAL**: No user story implementation should begin until these tasks are complete.

### Tests And Validation

- [ ] T005 [P] Add workflow config tests for accepting optional `role_models.orchestrator`, `role_models.worker`, and `role_models.reviewer` in `tests/workflow.test.ts`
- [ ] T006 [P] Add resolver unit tests for explicit source markers, default source markers, same-model reuse, and environment expansion in `tests/role-model-resolution.test.ts`
- [ ] T007 [P] Add type-level coverage or compile fixtures for role model roles remaining separate from `AgentRunRole` in `tests/provider-neutrality.test.ts`

### Implementation

- [ ] T008 Add raw and normalized `role_models` configuration schema fields to `src/core/config/Config.ts`
- [ ] T009 Create shared role model resolver types and helpers in `src/core/config/RoleModelResolution.ts`
- [ ] T010 Export role model configuration and resolution types from `src/core/config/Config.ts` and `src/index.ts`
- [ ] T011 Wire config string resolution and non-secret trimming semantics for `role_models` in `src/core/config/Config.ts`
- [ ] T012 Add role model display/readiness diagnostics without secret-bearing values in `src/doctor.ts`

**Checkpoint**: Shared config parsing and resolution are ready for stable harness integration.

---

## Phase 3: User Story 1 - Assign Distinct Models By Role (Priority: P1) MVP

**Goal**: Configure different models for orchestrator, worker, and reviewer and ensure each stable role session uses its own resolved model.

**Independent Test**: Configure three different role models, start a run that exercises orchestrator, worker, and reviewer roles on Cursor or Hermes TUI/JSON-RPC, and confirm each role session uses its configured model.

### Tests For User Story 1

- [ ] T013 [P] [US1] Add workflow fixture coverage for three distinct explicit role models in `tests/workflow.test.ts`
- [ ] T014 [P] [US1] Add Cursor harness tests proving worker and reviewer `ModelSelection` use their resolved role models in `tests/cursor-harness.test.ts`
- [ ] T015 [P] [US1] Add Hermes TUI/JSON-RPC tests proving worker and reviewer gateway environment models come from resolved role models in `tests/hermes-harness.test.ts`
- [ ] T016 [P] [US1] Add Hermes provider-limit default tests proving provider scope uses the resolved role model in `tests/hermes-harness.test.ts`
- [ ] T017 [P] [US1] Add orchestrator runtime metadata tests for explicit `role_models.orchestrator` in `tests/orchestrator.test.ts`
- [ ] T018 [P] [US1] Add orchestrator chat API tests for explicit orchestrator model metadata in `tests/web-orchestrator-chat-api.test.ts`

### Implementation For User Story 1

- [ ] T019 [US1] Replace Cursor worker/reviewer model selection with the shared role model resolver in `cursor/src/CursorHarness.ts`
- [ ] T020 [US1] Replace Hermes TUI/JSON-RPC gateway model selection with the shared role model resolver in `hermes/src/HermesHarness.ts`
- [ ] T021 [US1] Include the resolved Hermes role model in worker lease compatibility so changed models do not reuse stale sessions in `hermes/src/HermesHarness.ts`
- [ ] T022 [US1] Use resolved role models for runtime model metadata and cursor compatibility metadata in `src/core/orchestrator/Orchestrator.ts`
- [ ] T023 [US1] Record explicit orchestrator model metadata for accepted and rejected chat commands in `src/core/orchestrator/OrchestratorChatCommand.ts`
- [ ] T024 [US1] Preserve orchestrator chat command model metadata in `src/core/persistence/OrchestratorConversationStore.ts`

**Checkpoint**: User Story 1 is complete when distinct configured models are used by orchestrator chat, Cursor worker/reviewer sessions, and Hermes TUI/JSON-RPC worker/reviewer sessions.

---

## Phase 4: User Story 2 - Preserve Safe Defaults And Clear Overrides (Priority: P2)

**Goal**: Missing role-specific settings fall back to existing behavior while explicit role overrides continue to apply.

**Independent Test**: Remove one or more role model settings, start runs that exercise those roles, and confirm each missing role uses documented defaults while configured roles keep their assignments.

### Tests For User Story 2

- [ ] T025 [P] [US2] Add workflow config tests for absent `role_models`, partial role maps, and removed role entries in `tests/workflow.test.ts`
- [ ] T026 [P] [US2] Add resolver tests for orchestrator defaulting to `cursor.model` in `tests/role-model-resolution.test.ts`
- [ ] T027 [P] [US2] Add resolver tests for worker and reviewer defaulting to active harness defaults in `tests/role-model-resolution.test.ts`
- [ ] T028 [P] [US2] Add harness regression tests proving absent role models preserve current Cursor and Hermes behavior in `tests/cursor-harness.test.ts` and `tests/hermes-harness.test.ts`

### Implementation For User Story 2

- [ ] T029 [US2] Implement documented default fallback paths for orchestrator, worker, and reviewer in `src/core/config/RoleModelResolution.ts`
- [ ] T030 [US2] Add `role_model:<role>:default:<sourcePath>` setting source markers in `src/core/config/RoleModelResolution.ts`
- [ ] T031 [US2] Preserve existing Cursor model params behavior when Cursor roles default through `cursor.model` in `cursor/src/CursorHarness.ts`
- [ ] T032 [US2] Preserve existing Hermes provider and template defaults when Hermes roles default through `hermes.model` in `hermes/src/HermesHarness.ts`

**Checkpoint**: User Story 2 is complete when workflows without `role_models` and workflows with partial overrides behave like existing configurations except for explicitly configured roles.

---

## Phase 5: User Story 3 - Detect Unusable Role Model Settings Before Delegation (Priority: P2)

**Goal**: Reject invalid or unavailable role model settings with role-specific, redacted errors before the affected agent receives work.

**Independent Test**: Configure unusable model identifiers for worker and reviewer roles, start runs that need those roles, and confirm the affected role fails before prompt/work delegation while preserving completed prior work.

### Tests For User Story 3

- [ ] T033 [P] [US3] Add config parsing tests for empty, whitespace-only, multiline, and control-character role model values in `tests/workflow.test.ts`
- [ ] T034 [P] [US3] Add Cursor preflight failure tests that identify worker or reviewer role before prompt submission in `tests/cursor-harness.test.ts`
- [ ] T035 [P] [US3] Add Hermes TUI/JSON-RPC preflight failure tests that identify worker or reviewer role before gateway prompt submission in `tests/hermes-harness.test.ts`
- [ ] T036 [P] [US3] Add review-phase regression test proving completed worker output is preserved when reviewer model validation fails in `tests/orchestrator.test.ts`
- [ ] T037 [P] [US3] Add redaction tests proving provider tokens, auth homes, and secret-bearing env values do not appear in role model errors in `tests/doctor.test.ts`

### Implementation For User Story 3

- [ ] T038 [US3] Reject empty, multiline, and control-character explicit role model settings in `src/core/config/Config.ts`
- [ ] T039 [US3] Add role-specific configuration problem helpers and redacted messages in `src/core/config/RoleModelResolution.ts`
- [ ] T040 [US3] Map Cursor unavailable-model failures to role-specific pre-delegation errors in `cursor/src/CursorHarness.ts`
- [ ] T041 [US3] Map Hermes TUI/JSON-RPC unavailable-model failures to role-specific pre-delegation errors in `hermes/src/HermesHarness.ts`

**Checkpoint**: User Story 3 is complete when invalid or unavailable role models fail before affected work is delegated and errors name the role without exposing secrets.

---

## Phase 6: User Story 4 - Show Which Model Each Role Used (Priority: P3)

**Goal**: Persist and project resolved model evidence for every started role session, including explicit versus default source.

**Independent Test**: Run workflows with explicit and defaulted role models, inspect stored run records and web projections, and confirm each started role session preserves its resolved model and source marker.

### Tests For User Story 4

- [ ] T042 [P] [US4] Add transcript replay tests for `runtimeModel` and `runtimeSettingSources` preservation in `tests/transcript-store.test.ts`
- [ ] T043 [P] [US4] Add web history projection tests for explicit and default role model evidence in `tests/web-history-projection.test.ts`
- [ ] T044 [P] [US4] Add current status projection tests for role model evidence in `tests/web-projection.test.ts`
- [ ] T045 [P] [US4] Add transcript projection tests for role model evidence visibility in `tests/web-transcript-projection.test.ts`
- [ ] T046 [P] [US4] Add mid-run configuration change tests proving started sessions keep their frozen resolved model in `tests/orchestrator.test.ts`

### Implementation For User Story 4

- [ ] T047 [US4] Persist resolved model and source markers on run start events in `src/core/persistence/RunTranscriptStore.ts`
- [ ] T048 [US4] Project resolved model and source markers in web status output from `src/app/webProjection.ts`
- [ ] T049 [US4] Project resolved model and source markers in historical run output from `src/app/WebHistoryProjection.ts`
- [ ] T050 [US4] Project resolved model and source markers in transcript output from `src/app/WebTranscriptProjection.ts`

**Checkpoint**: User Story 4 is complete when run records and projections distinguish explicit role model selection from defaulted selection for each started role session.

---

## Phase 7: Hermes ACP Role Models (Blocked Follow-Up)

**Purpose**: Preserve the intended ACP path without implementing it before ACP harness/session stabilization lands.

**Dependency**: BLOCKED by stable Hermes ACP feature implementation. Do not begin these tasks until ACP session creation, prompt submission, and model-switch behavior are complete and covered by ACP feature tests.

- [ ] T051 [P] BLOCKED Add fake ACP client tests for session model switching before `session/prompt` in `tests/hermes-acp-harness.test.ts`
- [ ] T052 [P] BLOCKED Add ACP host profile lease compatibility tests for resolved role models in `tests/host-hermes-acp-profile-lease.test.ts`
- [ ] T053 BLOCKED Implement ACP role model switch and confirmed session model recording in `hermes/src/HermesAcpHarness.ts`
- [ ] T054 BLOCKED Update ACP stabilization notes and unblock criteria in `docs/hermes-acp-integration-spec.md`

**Checkpoint**: ACP role model support remains explicitly deferred until the ACP implementation is stable enough for role-model behavior to be tested independently.

---

## Phase 8: Polish And Cross-Cutting Validation

**Purpose**: Documentation, protected-surface checks, and end-to-end validation across all completed non-blocked stories.

- [ ] T055 [P] Update operator documentation for `role_models` examples and defaults in `WORKFLOW.md`
- [ ] T056 [P] Update dogfood validation guidance for role model runs in `docs/dogfood-runbook.md`
- [ ] T057 [P] Add or update quickstart validation notes after implementation in `specs/002-agent-role-models/quickstart.md`
- [ ] T058 Run targeted role model test suite from `specs/002-agent-role-models/quickstart.md` and fix failures in `package.json`
- [ ] T059 Run `npm run typecheck` and fix compile issues in `tsconfig.json`
- [ ] T060 Confirm protected surfaces remain untouched by reviewing `hermes/upstream-src/` and any generated diff output before final delivery in `specs/002-agent-role-models/plan.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 Setup**: No dependencies.
- **Phase 2 Foundational**: Depends on Phase 1 and blocks all non-blocked user stories.
- **Phase 3 US1**: Depends on Phase 2 and is the MVP.
- **Phase 4 US2**: Depends on Phase 2. It can be implemented in parallel with US1 after the resolver contract is stable, but should be validated against US1 before release.
- **Phase 5 US3**: Depends on Phase 2. It can be implemented in parallel with US1/US2 but must be validated before live runtime use.
- **Phase 6 US4**: Depends on Phase 2 and consumes run metadata emitted by US1/US2/US3.
- **Phase 7 ACP Blocked Follow-Up**: Depends on stable Hermes ACP implementation and is excluded from the initial implementation wave.
- **Phase 8 Polish**: Depends on all completed non-blocked stories selected for delivery.

### User Story Dependencies

- **US1 (P1)**: Independent after Phase 2; delivers the core role model behavior for stable harnesses.
- **US2 (P2)**: Independent after Phase 2; preserves default behavior and partial overrides.
- **US3 (P2)**: Independent after Phase 2; adds invalid/unavailable model protection before delegation.
- **US4 (P3)**: Depends on the run metadata emitted by role sessions but can be tested with fake runs and transcript fixtures.

### Within Each User Story

- Tests and validation tasks must be written before implementation tasks.
- Resolver behavior should be implemented before harness-specific use.
- Harness model selection must happen before prompt submission or work delegation.
- Metadata persistence should happen when a role session is accepted or started.
- Each story checkpoint should pass before moving to the next priority story for a sequential implementation.

---

## Parallel Opportunities

- Setup inspections T002, T003, and T004 can run in parallel with T001 once implementation surfaces are known.
- Foundational tests T005, T006, and T007 can run in parallel because they cover separate files.
- US1 tests T013 through T018 can run in parallel before implementation.
- US2 tests T025 through T028 can run in parallel before implementation.
- US3 tests T033 through T037 can run in parallel before implementation.
- US4 tests T042 through T046 can run in parallel before implementation.
- ACP blocked tests T051 and T052 can run in parallel only after the ACP stabilization dependency is cleared.
- Documentation tasks T055 through T057 can run in parallel after non-blocked implementation behavior is settled.

---

## Parallel Example: User Story 1

```powershell
# Launch US1 tests first:
npm test -- tests/workflow.test.ts tests/cursor-harness.test.ts tests/hermes-harness.test.ts tests/orchestrator.test.ts tests/web-orchestrator-chat-api.test.ts

# Then implement stable harness integration:
# T019 cursor/src/CursorHarness.ts
# T020-T021 hermes/src/HermesHarness.ts
# T022 src/core/orchestrator/Orchestrator.ts
# T023 src/core/orchestrator/OrchestratorChatCommand.ts
# T024 src/core/persistence/OrchestratorConversationStore.ts
```

---

## Implementation Strategy

### MVP First (US1 Only)

1. Complete Phase 1 setup.
2. Complete Phase 2 foundational resolver and config contract.
3. Complete Phase 3 US1 for orchestrator, Cursor, and Hermes TUI/JSON-RPC.
4. Stop and validate US1 independently with the tests listed in the Phase 3 checkpoint.

### Incremental Delivery

1. Add US1 to enable distinct role models for stable surfaces.
2. Add US2 to preserve safe partial rollout and default behavior.
3. Add US3 to harden invalid/unavailable model failure behavior.
4. Add US4 to complete durable run evidence and projections.
5. Keep Phase 7 blocked until ACP stabilization is complete.

### Validation Commands

```powershell
npm run typecheck
npm test -- tests/workflow.test.ts tests/orchestrator.test.ts tests/cursor-harness.test.ts tests/hermes-harness.test.ts tests/transcript-store.test.ts tests/web-history-projection.test.ts tests/web-projection.test.ts tests/web-transcript-projection.test.ts tests/web-orchestrator-chat-api.test.ts
```

Run `npm test -- tests/hermes-acp-harness.test.ts tests/host-hermes-acp-profile-lease.test.ts` only after the ACP blocked follow-up tasks are unblocked.

---

## Notes

- Role models are non-secret identifiers; credentials and provider auth material remain in existing secret-bearing paths.
- Do not modify `hermes/upstream-src/`.
- `role_models.orchestrator` is a service-owned orchestration/chat model role and must remain separate from delegated `AgentRunRole` values.
- Optional Spec Kit git commit hooks exist before and after task generation, but they are not auto-run here unless explicitly requested.

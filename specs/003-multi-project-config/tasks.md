# Tasks: Multi-Project Configuration

**Input**: Design documents from `specs/003-multi-project-config/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`

**Tests**: Validation tasks are required and appear before the implementation tasks they protect.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing. When any task is split into a Linear issue, that issue body MUST include the mandatory fenced `json` issue contract with `schemaVersion`, `contractVersion`, and non-empty stable requirements.

## Phase 1: Setup

**Purpose**: Establish shared fixtures and map current single-project assumptions before changing behavior.

- [ ] T001 Inspect current single-project config, tracker, workspace, writeback, persistence, and projection assumptions in `src/core/config/Config.ts`, `src/integrations/linear/LinearTrackerClient.ts`, `src/core/workspace/WorkspaceManager.ts`, `src/core/orchestrator/Orchestrator.ts`, `src/core/persistence/RunTranscriptStore.ts`, and `src/app/webProjection.ts`
- [ ] T002 [P] Add reusable multi-project workflow fixture helpers in `tests/helpers.ts`
- [ ] T003 [P] Add multi-project tracker and issue fixture builders in `tests/helpers.ts`
- [ ] T004 [P] Add a protected-surface inventory note for this feature in `specs/003-multi-project-config/research.md`
- [ ] T005 Verify no implementation task requires changes under `hermes/upstream-src/**`

---

## Phase 2: Foundational

**Purpose**: Shared project-context contracts and durable value shapes that all stories depend on.

**Critical**: No user story implementation should start until this phase is complete.

- [ ] T006 [P] Add project context config contract tests for id normalization, duplicate ids, disabled contexts, missing tracker, and missing workspace source in `tests/workflow.test.ts`
- [ ] T007 [P] Add project context redaction tests for validation errors and config summaries in `tests/workflow.test.ts`
- [ ] T008 [P] Add project context type, normalization, legacy default mapping, and durable attribution contract tests in `tests/project-contexts.test.ts`, `tests/transcript-store.test.ts`, `tests/issue-lifecycle-store.test.ts`, `tests/writeback-outbox.test.ts`, and `tests/operator-approval-service.test.ts`
- [ ] T009 Create `ProjectContextId`, `ProjectContextConfig`, `NormalizedProjectContext`, `ProjectContextRegistry`, and `ProjectContextResolution` types in `src/core/config/ProjectContexts.ts`
- [ ] T010 Implement safe project context id normalization and validation in `src/core/config/ProjectContexts.ts`
- [ ] T011 Implement legacy top-level config to default-context normalization in `src/core/config/ProjectContexts.ts`
- [ ] T012 Implement explicit `project_contexts` normalization with context-specific override merging in `src/core/config/ProjectContexts.ts`
- [ ] T013 Integrate `ProjectContextRegistry` into `RawWorkflowConfig` and `ServiceConfig` in `src/core/config/Config.ts`
- [ ] T014 Preserve legacy `config.tracker`, `config.workspace`, `config.github`, `config.reviewLoop`, and `config.issueBreakdown` as default-context compatibility views in `src/core/config/Config.ts`
- [ ] T015 Add context-safe public metadata helpers that omit credential values in `src/core/config/ProjectContexts.ts`
- [ ] T016 Update credential profile registry integration for context-specific capability assignments in `src/core/config/CredentialProfiles.ts`
- [ ] T017 [P] Add context attribution fields to `WorkspaceRecord`, `RunRecord`, and start/update input types in `src/core/persistence/RunTranscriptStore.ts`
- [ ] T018 [P] Add context attribution fields to `IssueLifecycleRecord`, summary pointers, and normalizers in `src/core/persistence/IssueLifecycleStore.ts`
- [ ] T019 [P] Add context attribution fields to writeback operation shapes in `src/core/writeback/WritebackOutbox.ts`
- [ ] T020 [P] Add context attribution fields to operator approval records in `src/core/approval/OperatorApprovalService.ts`
- [ ] T021 [P] Add Postgres migration tests for project context columns and indexes in `tests/postgres-schema.test.ts`
- [ ] T022 Add Postgres migration for project context attribution on owned state and projection tables in `migrations/postgres/0007_project_context_attribution.sql`

**Checkpoint**: Shared context registry, type shapes, legacy default mapping, redaction helpers, and persistence schema contracts are ready.

---

## Phase 3: User Story 1 - Configure Multiple Project Contexts (Priority: P1) MVP

**Goal**: Operators can define multiple named project contexts in one workflow and receive safe validation.

**Independent Test**: Configure at least two named project contexts, each with its own codebase source and Linear project, then validate that Symphony accepts and reports both contexts.

### Tests for User Story 1

- [ ] T023 [US1] Add workflow parse test for two contexts with different codebases and Linear projects in `tests/workflow.test.ts`
- [ ] T024 [US1] Add workflow parse test for three contexts with shared codebase but different Linear projects in `tests/workflow.test.ts`
- [ ] T025 [US1] Add workflow validation tests for duplicate context ids, missing Linear project slug, and missing codebase source in `tests/workflow.test.ts`
- [ ] T026 [P] [US1] Add doctor validation and three-context normalization performance tests for configured context summaries and context-specific errors in `tests/doctor.test.ts` and `tests/workflow.test.ts`
- [ ] T027 [P] [US1] Add MCP environment tests for context-specific tracker/workspace/GitHub env values without secret leakage in `tests/mcp-subprocess-environment.test.ts`

### Implementation for User Story 1

- [ ] T028 [US1] Extend `rawConfigSchema` with `project_contexts` in `src/core/config/Config.ts`
- [ ] T029 [US1] Resolve context-specific path, repository, branch template, and state directory values in `src/core/config/ProjectContexts.ts`
- [ ] T030 [US1] Resolve context-specific tracker, review-loop, issue-breakdown, GitHub, agent, and credential profile values in `src/core/config/ProjectContexts.ts`
- [ ] T031 [US1] Update `parseServiceConfig` to populate `config.projectContexts` and the compatibility default context view in `src/core/config/Config.ts`
- [ ] T032 [US1] Update workflow reload behavior to report context-specific validation errors without printing secret-bearing values in `src/core/workflow/WorkflowLoader.ts`
- [ ] T033 [US1] Update doctor checks to list configured project contexts and context-specific validation failures in `src/doctor.ts`
- [ ] T034 [US1] Update generated MCP subprocess environment selection to accept a resolved context in `src/core/harness/McpSubprocessEnvironment.ts`
- [ ] T035 [US1] Document multi-project workflow configuration examples and redaction rules in `docs/dogfood-runbook.md`

**Checkpoint**: User Story 1 is complete when explicit multi-project config loads, validates, summarizes safely, and legacy config still presents one default context.

---

## Phase 4: User Story 2 - Route Work To The Correct Codebase And Linear Project (Priority: P1)

**Goal**: Every issue, run, workspace, review, approval, publication, merge, and writeback resolves to exactly one project context before action.

**Independent Test**: Provide eligible issues from two Linear projects, start work for each, and confirm each run uses the resolved context's codebase, workspace, lifecycle states, and Linear writeback target.

### Tests for User Story 2

- [ ] T036 [US2] Add project context resolution contract tests for zero-match, one-match, duplicate-match, disabled-context, replay sources, and persisted-context reuse after config reload in `tests/project-context-routing.test.ts`
- [ ] T037 [US2] Add orchestrator dispatch and config-reload preservation tests for two Linear projects routing to distinct workspaces, state buckets, and persisted in-progress run contexts in `tests/orchestrator.test.ts`
- [ ] T038 [US2] Add workspace key/path collision tests for duplicate issue identifiers across contexts in `tests/git-worktree.test.ts`
- [ ] T039 [US2] Add writeback processor tests for context-scoped tracker writer selection and idempotency keys in `tests/writeback-outbox.test.ts`
- [ ] T040 [US2] Add completion report MCP context mismatch rejection tests in `tests/completion-report-mcp.test.ts`
- [ ] T041 [P] [US2] Add review verdict MCP context mismatch rejection tests in `tests/review-verdict-mcp.test.ts`
- [ ] T042 [P] [US2] Add review feedback MCP context mismatch rejection tests in `tests/review-feedback-mcp.test.ts`

### Implementation for User Story 2

- [ ] T043 [US2] Implement issue-to-context resolution helpers, persisted-context reuse, and routing problem results in `src/core/config/ProjectContexts.ts`
- [ ] T044 [US2] Add project context id and Linear project identity to normalized tracker issues in `src/core/types.ts`
- [ ] T045 [US2] Add context-aware Linear tracker client factory and credential resolution in `src/integrations/linear/LinearCredentialResolver.ts`
- [ ] T046 [US2] Update `LinearTrackerClient` usage so candidate polling and state refresh carry project context metadata in `src/integrations/linear/LinearTrackerClient.ts`
- [ ] T047 [US2] Update `WorkspaceManager` to derive context-qualified workspace keys, paths, branch templates, and metadata in `src/core/workspace/WorkspaceManager.ts`
- [ ] T048 [US2] Update orchestrator polling and workflow reload handling to iterate context-scoped tracker clients, preserve in-progress resolved contexts, and produce project-scoped dispatch entries in `src/core/orchestrator/Orchestrator.ts`
- [ ] T049 [US2] Update worker, reviewer, issue-breakdown, and merge-repair dispatch to pass resolved project context into prompts and harness contexts in `src/core/orchestrator/Orchestrator.ts`
- [ ] T050 [US2] Update `TransitionPolicy` to evaluate state buckets and writeback targets from the resolved context in `src/core/writeback/TransitionPolicy.ts`
- [ ] T051 [US2] Update `WritebackProcessor` to process context-scoped operations with the correct tracker writer in `src/core/writeback/WritebackOutbox.ts`
- [ ] T052 [US2] Update GitHub publication, review evidence, feedback, and merge client resolution to use context-specific GitHub settings in `src/integrations/github/GitHubCredentialResolver.ts`
- [ ] T053 [US2] Validate completion reports, review verdicts, and review feedback against service-owned context before accepting handoff data in `src/core/harness/HandoffMcp.ts`
- [ ] T054 [US2] Record routing failures as redacted run activity or lifecycle events before skipping dispatch in `src/core/orchestrator/Orchestrator.ts`

**Checkpoint**: User Story 2 is complete when each workflow-affecting action uses exactly one resolved context and ambiguous routing fails closed before workspace creation, agent dispatch, or Linear mutation.

---

## Phase 5: User Story 3 - Run Multiple Projects Simultaneously (Priority: P2)

**Goal**: Symphony can poll, dispatch, review, and record activity across multiple healthy contexts while isolating context-specific failures.

**Independent Test**: Run active worker and reviewer work for at least two contexts at the same time and confirm separate queue eligibility, workspace state, run records, transcripts, and lifecycle writeback.

### Tests for User Story 3

- [ ] T055 [US3] Add orchestrator polling test that discovers candidates from two Linear projects in one service cycle in `tests/orchestrator.test.ts`
- [ ] T056 [US3] Add concurrent worker/reviewer dispatch test with distinct context run records and transcripts in `tests/orchestrator.test.ts`
- [ ] T057 [US3] Add context-specific failure isolation test where one context has a credential or tracker failure and another context still dispatches in `tests/orchestrator.test.ts`
- [ ] T058 [P] [US3] Add status API tests for active agents grouped by project context in `tests/status-api.test.ts`
- [ ] T059 [P] [US3] Add provider gate tests for project-context source attribution in `tests/provider-gates.test.ts`

### Implementation for User Story 3

- [ ] T060 [US3] Update orchestrator scheduling to apply global and context-specific concurrency limits in `src/core/orchestrator/Orchestrator.ts`
- [ ] T061 [US3] Isolate context-specific tracker and credential failures without stopping unrelated healthy contexts in `src/core/orchestrator/Orchestrator.ts`
- [ ] T062 [US3] Include project context metadata in runtime snapshots and running-agent models in `src/core/orchestrator/Orchestrator.ts`
- [ ] T063 [US3] Persist project context metadata on provider gate sources in `src/core/persistence/ProviderGateStore.ts`
- [ ] T064 [US3] Update status API responses for running agents, provider gates, workspaces, and runs to include project context attribution in `src/app/http.ts`
- [ ] T065 [US3] Update Cursor harness contexts to preserve project context in session keys and metadata in `cursor/src/CursorHarness.ts`
- [ ] T066 [US3] Update Hermes TUI harness contexts to preserve project context in profile/session keys and metadata in `hermes/src/HermesHarness.ts`
- [ ] T067 [US3] Update Hermes ACP harness contexts to preserve project context in profile/session keys and metadata in `hermes/src/HermesAcpHarness.ts`

**Checkpoint**: User Story 3 is complete when multiple contexts can be active concurrently and a failure in one context does not block safe work in another.

---

## Phase 6: User Story 4 - Preserve Project Attribution In Operator Views And History (Priority: P2)

**Goal**: Operator-facing board, history, transcript, workspace, approval, review, and writeback views show project context and support context filtering.

**Independent Test**: Seed records for two contexts with overlapping issue identifiers and confirm all views remain distinguishable by context.

### Tests for User Story 4

- [ ] T068 [US4] Add web projection tests for board and issue detail project attribution with duplicate issue identifiers in `tests/web-projection.test.ts`
- [ ] T069 [US4] Add web history tests for project context display and filtering in `tests/web-history-projection.test.ts`
- [ ] T070 [US4] Add web transcript projection tests for project context prelude and source metadata in `tests/web-transcript-projection.test.ts`
- [ ] T071 [US4] Add web route contract tests for context-qualified issue, run, workspace, transcript, and approval routes in `tests/web-route-contract.test.ts`
- [ ] T072 [US4] Add projection source index tests for context-aware aliases in `tests/web-projection-context.test.ts`
- [ ] T073 [P] [US4] Add realtime projection event tests for project context metadata in `tests/realtime-projection-events.test.ts`

### Implementation for User Story 4

- [ ] T074 [US4] Add `projectContext` display models to board, issue, session, running-agent, provider-gate, workspace, and activity models in `src/app/webProjection.ts`
- [ ] T075 [US4] Update web projection source indexes to include context-qualified aliases for issue id, issue identifier, workspace key, and run id in `src/app/WebProjectionContext.ts`
- [ ] T076 [US4] Update web dashboard, board, sidebar, and issue detail projection builders for project attribution in `src/app/webProjection.ts`
- [ ] T077 [US4] Update history projection filtering and rows for project context attribution in `src/app/WebHistoryProjection.ts`
- [ ] T078 [US4] Update transcript projection run prelude and system/status messages for project context attribution in `src/app/WebTranscriptProjection.ts`
- [ ] T079 [US4] Update durable projection repository scope keys and project-context filters in `src/app/WebProjectionRepository.ts`
- [ ] T080 [US4] Update HTTP route parsing to accept context-qualified aliases and project context filters in `src/app/http.ts`
- [ ] T081 [US4] Update realtime projection events to carry project context metadata in `src/app/RealtimeProjectionEvents.ts`
- [ ] T082 [US4] Update Postgres projection transaction metadata and selectors for context-aware scopes in `src/core/persistence/ProjectionTransactionService.ts`

**Checkpoint**: User Story 4 is complete when duplicate issue identifiers remain distinguishable across board, history, routes, workspaces, transcripts, approvals, writebacks, and projections.

---

## Phase 7: User Story 5 - Migrate From Single-Project Usage Safely (Priority: P3)

**Goal**: Existing single-project configurations and historical records continue to work as one default or legacy project context.

**Independent Test**: Load an existing single-project configuration, confirm it normalizes to one context, add a second context, and confirm historical records remain readable with legacy/default attribution.

### Tests for User Story 5

- [ ] T083 [US5] Add legacy workflow compatibility and legacy single-project dispatch tests with no `project_contexts` block in `tests/workflow.test.ts` and `tests/orchestrator.test.ts`
- [ ] T084 [US5] Add historical run and workspace fallback tests for missing project context metadata in `tests/transcript-store.test.ts`
- [ ] T085 [US5] Add historical lifecycle fallback tests for missing project context metadata in `tests/issue-lifecycle-store.test.ts`
- [ ] T086 [US5] Add status and web projection tests for legacy/default context attribution in `tests/status-api.test.ts`
- [ ] T087 [P] [US5] Add migration compatibility tests for older Postgres rows without context values in `tests/postgres-schema.test.ts`

### Implementation for User Story 5

- [ ] T088 [US5] Backfill read-time default project context metadata for legacy run and workspace records in `src/core/persistence/RunTranscriptStore.ts`
- [ ] T089 [US5] Backfill read-time default project context metadata for legacy lifecycle records in `src/core/persistence/IssueLifecycleStore.ts`
- [ ] T090 [US5] Backfill read-time default project context metadata for legacy writeback operations in `src/core/writeback/WritebackOutbox.ts`
- [ ] T091 [US5] Backfill read-time default project context metadata for legacy approval records in `src/core/approval/OperatorApprovalService.ts`
- [ ] T092 [US5] Update status and transcript APIs to resolve legacy aliases through the default context when unambiguous in `src/app/http.ts`
- [ ] T093 [US5] Update dogfood workflow guidance to describe Spec Kit as planning material and Linear issue contracts as agent work authority in `docs/dogfood-runbook.md`
- [ ] T094 [US5] Update state representation docs for project context attribution and legacy fallback in `docs/state-representation.md`

**Checkpoint**: User Story 5 is complete when current single-project workflows keep working and historical records display a default/legacy context instead of blank attribution.

---

## Phase 8: Polish & Cross-Cutting Validation

**Purpose**: Final validation, documentation, and promotion readiness across all stories.

- [ ] T095 [P] Run focused configuration, doctor, and normalization performance validation with `npm test -- tests/workflow.test.ts tests/doctor.test.ts`
- [ ] T096 [P] Run focused orchestration and workspace validation with `npm test -- tests/orchestrator.test.ts tests/git-worktree.test.ts tests/writeback-outbox.test.ts`
- [ ] T097 [P] Run focused MCP and harness validation with `npm test -- tests/completion-report-mcp.test.ts tests/review-verdict-mcp.test.ts tests/review-feedback-mcp.test.ts tests/mcp-subprocess-environment.test.ts tests/cursor-harness.test.ts tests/hermes-harness.test.ts tests/hermes-acp-harness.test.ts`
- [ ] T098 [P] Run focused web and projection validation with `npm test -- tests/status-api.test.ts tests/web-projection.test.ts tests/web-history-projection.test.ts tests/web-transcript-projection.test.ts tests/web-route-contract.test.ts tests/web-projection-context.test.ts`
- [ ] T099 [P] Run focused database validation with `npm test -- tests/postgres-schema.test.ts`
- [ ] T100 Run full repository validation with `npm test` using `package.json`
- [ ] T101 Run TypeScript validation with `npm run typecheck` using `tsconfig.json`
- [ ] T102 Run quickstart scenario validation from `specs/003-multi-project-config/quickstart.md`
- [ ] T103 Verify generated prompts, logs, transcripts, validation errors, and docs do not expose Linear/GitHub/runtime credential values in `src/core/orchestrator/Orchestrator.ts`, `src/core/harness/`, `src/app/`, and `docs/`
- [ ] T104 Verify git diff contains no changes under `hermes/upstream-src/**`
- [ ] T105 Prepare promotion notes with completed validation evidence and remaining risks in `specs/003-multi-project-config/quickstart.md`

---

## Dependencies & Execution Order

### Requirement Coverage

- **FR-001 - FR-004, FR-018, FR-023, FR-024**: Covered by Foundational and US1 tasks T006-T035.
- **FR-005 - FR-015, FR-020**: Covered by US2 routing, workspace, writeback, MCP, routing-problem, replay, and config-reload preservation tasks T036-T054.
- **FR-007 - FR-008, FR-019**: Covered by US3 polling, concurrency, failure isolation, and status tasks T055-T067.
- **FR-013 - FR-017, FR-024**: Covered by US4 projection, alias, filter, route, and redaction tasks T068-T082.
- **FR-021 - FR-022**: Covered by US5 legacy config and historical fallback tasks T083-T094.
- **FR-025**: Covered by story-specific tests and final validation tasks T095-T105.
- **Performance goals**: Covered by three-context normalization tests and focused validation tasks T026 and T095.

### Phase Dependencies

- Phase 1 Setup has no dependencies.
- Phase 2 Foundational depends on Phase 1 and blocks all user stories.
- Phase 3 US1 depends on Phase 2 and is the MVP.
- Phase 4 US2 depends on Phase 3 because routing requires normalized contexts.
- Phase 5 US3 depends on Phase 4 because concurrency requires safe routing.
- Phase 6 US4 depends on Phase 4 because projections require durable context attribution.
- Phase 7 US5 depends on Phase 3 and can proceed after context normalization exists, but final validation should include US2/US4 surfaces.
- Phase 8 Polish depends on the stories selected for implementation.

### User Story Dependencies

- US1: No dependency after Foundational; delivers config loading and validation MVP.
- US2: Depends on US1; delivers safe context resolution before workflow-affecting actions.
- US3: Depends on US2; delivers simultaneous healthy-context activity and failure isolation.
- US4: Depends on US2; delivers operator-facing attribution and filtering.
- US5: Depends on US1; delivers single-project compatibility and historical fallback.

### Parallel Opportunities

- T002, T003, T004 can run in parallel after T001.
- T006, T007, T008, and T021 can run in parallel after the setup phase.
- T017, T018, T019, and T020 can run in parallel after T008 durable attribution tests exist.
- US2 MCP mismatch tests T040, T041, and T042 can run in parallel after routing test fixtures exist.
- US3 status/provider-gate tests T058 and T059 can run in parallel with orchestrator tests.
- US4 projection tests T068 through T073 can run in parallel because they touch different test files.
- Phase 8 focused validation tasks T095 through T099 can run in parallel.

---

## Parallel Example: User Story 4

```text
Task: "T068 [US4] Add web projection tests for board and issue detail project attribution with duplicate issue identifiers in tests/web-projection.test.ts"
Task: "T069 [US4] Add web history tests for project context display and filtering in tests/web-history-projection.test.ts"
Task: "T070 [US4] Add web transcript projection tests for project context prelude and source metadata in tests/web-transcript-projection.test.ts"
Task: "T071 [US4] Add web route contract tests for context-qualified issue, run, workspace, transcript, and approval routes in tests/web-route-contract.test.ts"
Task: "T072 [US4] Add projection source index tests for context-aware aliases in tests/web-projection-context.test.ts"
Task: "T073 [US4] Add realtime projection event tests for project context metadata in tests/realtime-projection-events.test.ts"
```

---

## Implementation Strategy

### MVP First

1. Complete Phase 1 setup.
2. Complete Phase 2 foundational types, schema, and persistence contracts.
3. Complete Phase 3 US1.
4. Stop and validate: `npm test -- tests/workflow.test.ts tests/doctor.test.ts tests/mcp-subprocess-environment.test.ts`.

### Incremental Delivery

1. US1 establishes multi-project configuration without changing runtime behavior.
2. US2 adds service-owned context routing and makes workflow-affecting actions safe.
3. US3 adds concurrent multi-context activity and failure isolation.
4. US4 adds operator-facing attribution and filtering.
5. US5 hardens legacy compatibility and historical fallback.

### Validation Discipline

- Write tests before implementation tasks in each story.
- Keep context identifiers and routing evidence non-secret.
- Treat ambiguous routing as a human-required service state, not an agent decision.
- Preserve current single-project behavior until explicit multi-project configuration is present.
- Do not change vendored Hermes source under `hermes/upstream-src/**`.

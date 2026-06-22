# Tasks: ENG-372 Context Credential Routing

**Input**: Design documents from `specs/006-eng-372-context-credential-routing/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`

**Tests**: Validation tasks are required and appear before the implementation tasks they protect.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing. When any task is split into a Linear issue, that issue body MUST include the mandatory fenced `json` issue contract with `schemaVersion`, `contractVersion`, and non-empty stable requirements.

## Phase 1: Setup

**Purpose**: Map current credential and tracker-routing assumptions before changing behavior.

- [ ] T001 Inspect context credential assignment, credential resolver, tracker client, status, workspace, and issue-breakdown entry points in `src/core/config/CredentialProfiles.ts`, `src/core/config/ProjectContexts.ts`, `src/integrations/linear/LinearTrackerClient.ts`, `src/app/http.ts`, `src/core/IssueBreakdownPlanService.ts`, and `src/core/IssueBreakdownPlanApplyService.ts`
- [ ] T002 [P] Inventory current credential and Linear routing tests in `tests/credential-profiles.test.ts`, `tests/linear-credential-resolver.test.ts`, `tests/linear.test.ts`, and `tests/orchestrator.test.ts`
- [ ] T003 [P] Document the live tracker entry-point matrix in `specs/006-eng-372-context-credential-routing/quickstart.md`
- [ ] T004 Verify no planned task requires raw tokens, private keys, profile contents, or changes under `hermes/upstream-src/**`

---

## Phase 2: Foundational

**Purpose**: Shared fixtures and route evidence shapes that all stories depend on.

**Critical**: No user story implementation should start until this phase is complete.

- [ ] T005 [P] Add multi-context credential assignment fixture helpers in `tests/helpers.ts`
- [ ] T006 [P] Add context-aware Linear tracker fixture builders with distinct default and secondary credentials in `tests/helpers.ts`
- [ ] T007 [P] Add identifier-only and duplicate-identifier route fixture builders in `tests/helpers.ts`
- [ ] T008 Add redacted tracker-routing evidence shape definitions in `src/core/types.ts`
- [ ] T009 Update credential and live tracker contract seeds in `specs/006-eng-372-context-credential-routing/contracts/credential-profile-assignment.md` and `specs/006-eng-372-context-credential-routing/contracts/live-tracker-routing.md`

**Checkpoint**: Shared fixtures, evidence shape, and issue-contract mapping are ready.

---

## Phase 3: User Story 1 - Resolve credentials by project context (Priority: P1) MVP

**Goal**: Each project context resolves only the credentials assigned to that context and capability.

**Independent Test**: Configure at least two contexts with different credentials for the same capability and prove each context resolves only its own assignment without exposing secret values.

### Tests for User Story 1

- [ ] T010 [US1] Add context-specific capability assignment tests in `tests/credential-profiles.test.ts`
- [ ] T011 [US1] Add structured profile inheritance and partial override tests in `tests/credential-profiles.test.ts`
- [ ] T012 [P] [US1] Add fail-closed missing capability credential tests in `tests/credential-profiles.test.ts`
- [ ] T013 [P] [US1] Add Linear credential resolver tests for distinct context credentials in `tests/linear-credential-resolver.test.ts`
- [ ] T014 [P] [US1] Add GitHub credential resolver inheritance tests for context-specific settings in `tests/github-credential-resolver.test.ts`

### Implementation for User Story 1

- [ ] T015 [US1] Implement context-specific credential profile assignment resolution in `src/core/config/CredentialProfiles.ts`
- [ ] T016 [US1] Implement structured profile inheritance and required-field validation in `src/core/config/CredentialProfiles.ts`
- [ ] T017 [US1] Integrate context credential assignments into project context normalization in `src/core/config/ProjectContexts.ts`
- [ ] T018 [US1] Update Linear credential resolution to require a target project context and capability in `src/integrations/linear/LinearCredentialResolver.ts`
- [ ] T019 [US1] Update GitHub credential resolution to require a target project context and capability in `src/integrations/github/GitHubCredentialResolver.ts`
- [ ] T020 [US1] Update MCP subprocess and runtime handoff environment generation to consume context-specific credential assignments in `src/core/harness/McpSubprocessEnvironment.ts`

**Checkpoint**: User Story 1 is complete when context-specific credential resolution is least-privilege and redacted.

---

## Phase 4: User Story 2 - Route live tracker and status reads through the issue context (Priority: P2)

**Goal**: Candidate polling, review polling, status lookup, workspace actions, and issue-breakdown flows use the tracker client for the issue's resolved project context.

**Independent Test**: Exercise each live-read path for a non-default context and prove the selected tracker client and canonical issue identity match that context.

### Tests for User Story 2

- [ ] T021 [US2] Add candidate polling and reviewer polling route tests for non-default contexts in `tests/orchestrator.test.ts`
- [ ] T022 [US2] Add status lookup tests proving identifier-only input resolves before live tracker fetch in `tests/status-api.test.ts`
- [ ] T023 [P] [US2] Add workspace status/open route tests for identifier-only and duplicate-identifier inputs in `tests/workspace.test.ts`
- [ ] T024 [P] [US2] Add issue-breakdown request routing tests for non-default contexts in `tests/issue-breakdown-plan-service.test.ts`
- [ ] T025 [P] [US2] Add issue-breakdown apply routing tests for non-default contexts in `tests/issue-breakdown-plan-apply-service.test.ts`
- [ ] T026 [US2] Add Linear client tests proving canonical Linear id filters are used where required in `tests/linear.test.ts`
- [ ] T027 [P] [US2] Add missing-context, ambiguous-context, and credential-unavailable route failure tests with redacted operator-facing reasons in `tests/status-api.test.ts` and `tests/orchestrator.test.ts`

### Implementation for User Story 2

- [ ] T028 [US2] Implement a service-owned tracker route resolver for exact issue identities and identifier-only actions in `src/core/config/ProjectContexts.ts`
- [ ] T029 [US2] Implement fail-closed missing-context, ambiguous-context, and credential-unavailable tracker route results in `src/core/config/ProjectContexts.ts` and `src/app/http.ts`
- [ ] T030 [US2] Update Linear tracker client state fetches to distinguish canonical issue ids from visible identifiers in `src/integrations/linear/LinearTrackerClient.ts`
- [ ] T031 [US2] Update orchestrator candidate and reviewer polling to use context-scoped tracker routes in `src/core/orchestrator/Orchestrator.ts`
- [ ] T032 [US2] Update status and workspace HTTP actions to resolve context and canonical tracker identity before live reads in `src/app/http.ts`
- [ ] T033 [US2] Update issue-breakdown request generation to use the tracker route contract in `src/core/IssueBreakdownPlanService.ts`
- [ ] T034 [US2] Update issue-breakdown apply/writeback preparation to use the tracker route contract in `src/core/IssueBreakdownPlanApplyService.ts`

**Checkpoint**: User Story 2 is complete when no covered live tracker path silently falls back to the default context.

---

## Phase 5: User Story 3 - Give reviewers a stable validation matrix (Priority: P3)

**Goal**: Reviewers receive deterministic evidence for credential resolution, live routing, identifier fallback, and issue-breakdown paths.

**Independent Test**: Run one validation matrix that proves each known review-loop boundary and records redacted route evidence.

### Tests for User Story 3

- [ ] T035 [US3] Add an end-to-end credential and tracker routing matrix test in `tests/linear.test.ts`
- [ ] T036 [P] [US3] Add validation that routing evidence excludes tokens, private keys, raw profile values, and environment values in `tests/linear.test.ts`
- [ ] T037 [P] [US3] Add issue-contract lint coverage for ENG-372 child contract examples in `tests/issue-contract-lint.test.ts`

### Implementation for User Story 3

- [ ] T038 [US3] Emit redacted tracker-routing evidence for resolved, ambiguous, missing, and credential-unavailable cases in `src/core/types.ts`
- [ ] T039 [US3] Record route evidence from orchestrator and status paths in `src/core/orchestrator/Orchestrator.ts` and `src/app/http.ts`
- [ ] T040 [US3] Finalize child issue contract requirement IDs for credential assignment, tracker routing, identifier fallback, and validation matrix coverage in `specs/006-eng-372-context-credential-routing/contracts/live-tracker-routing.md`
- [ ] T041 [US3] Add child issue creation guidance and blocking relationship notes in `specs/006-eng-372-context-credential-routing/quickstart.md`

**Checkpoint**: User Story 3 is complete when reviewers can validate the whole ENG-372 scope without discovering another default-context path.

---

## Phase 6: Polish & Cross-Cutting Validation

**Purpose**: Final validation, protected-surface checks, and promotion readiness.

- [ ] T042 [P] Run credential validation with `npm test -- tests/credential-profiles.test.ts tests/linear-credential-resolver.test.ts tests/github-credential-resolver.test.ts` using `package.json`
- [ ] T043 [P] Run live tracker route validation with `npm test -- tests/linear.test.ts tests/orchestrator.test.ts tests/status-api.test.ts tests/workspace.test.ts` using `package.json`
- [ ] T044 [P] Run issue-breakdown route validation with `npm test -- tests/issue-breakdown-plan-service.test.ts tests/issue-breakdown-plan-apply-service.test.ts` using `package.json`
- [ ] T045 Run MCP environment validation with `npm test -- tests/mcp-subprocess-environment.test.ts` using `package.json`
- [ ] T046 Run issue contract validation with `npm test -- tests/issue-contract-lint.test.ts` using `package.json`
- [ ] T047 Verify validation output, route evidence, logs, prompts, and docs do not expose credential values in `src/core/`, `src/integrations/`, `src/app/`, and `docs/`
- [ ] T048 Verify git diff contains no changes under `hermes/upstream-src/**`

---

## Dependencies & Execution Order

### Phase Dependencies

- Phase 1 Setup has no dependencies.
- Phase 2 Foundational depends on Phase 1 and blocks all user stories.
- Phase 3 US1 is the MVP and depends on Phase 2.
- Phase 4 US2 depends on US1 because live tracker routing needs context credential resolution.
- Phase 5 US3 depends on US1 and US2.
- Phase 6 Polish depends on selected stories being complete.

### Parallel Opportunities

- T002 and T003 can run in parallel after T001.
- T005, T006, and T007 can run in parallel.
- T012, T013, and T014 can run in parallel with T010 and T011 after fixtures exist.
- T023, T024, T025, and T027 can run in parallel with other US2 tests.
- T042, T043, and T044 can run in parallel during final validation.

## Implementation Strategy

### MVP First

1. Complete Phase 1 and Phase 2.
2. Complete Phase 3 to lock down context-specific credential resolution.
3. Stop and validate before routing live tracker paths.

### Incremental Delivery

1. Credential assignment first.
2. Live tracker route coverage second.
3. Reviewer validation matrix third.

# Tasks: Block Worker and Reviewer Upstream GitHub Commands

**Input**: Design documents from `specs/001-block-agent-github/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/agent-command-policy.md](contracts/agent-command-policy.md), [quickstart.md](quickstart.md)

**Tests**: Required by FR-014 and quickstart validation. Test tasks are listed before implementation work in each user-story phase.

**Organization**: Tasks are grouped by user story and then mapped into smaller Linear subissues under `ENG-243` for agent-sized implementation.

**Hard Constraint**: Do not modify vendored Hermes source under `hermes/upstream-src/**`. If a required surface cannot be enforced through Symphony-owned code, generated profile assets, hooks/plugins, MCP/service boundaries, or configuration, fail closed and report the gap as blocked.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish owned files and test fixtures without touching vendored Hermes source.

- [ ] T001 Create shared command policy fixture builders in `tests/agent-command-policy-fixtures.ts`
- [ ] T002 [P] Create shared command policy module skeleton in `src/core/harness/AgentCommandPolicy.ts`
- [ ] T003 [P] Create policy hook runner module skeleton in `src/core/harness/AgentCommandPolicyHookRunner.ts`
- [ ] T004 Add `agent-command-policy-hook` CLI command scaffold in `src/cli.ts`
- [ ] T005 Add a no-vendored-Hermes-source guard in `tests/hermes-template-policy.test.ts`, proving ENG-243 enforcement is configured through Symphony-owned code/templates and no policy fixture, generated profile hook, or enforcement path is rooted under `hermes/upstream-src/**`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core policy contracts and hook plumbing that must exist before any story can be implemented.

**CRITICAL**: No user story work should begin until this phase is complete.

- [ ] T006 Define `AgentCommandPolicyInput`, `AgentCommandPolicyDecision`, reason kinds, command surfaces, and audit payload types in `src/core/harness/AgentCommandPolicy.ts`
- [ ] T007 Implement redacted preview and environment-key extraction helpers in `src/core/harness/AgentCommandPolicy.ts`
- [ ] T008 Implement Windows/POSIX executable normalization helpers in `src/core/harness/AgentCommandPolicy.ts`
- [ ] T009 Implement JSON stdin/stdout handling for Hermes `pre_tool_call` hook payloads in `src/core/harness/AgentCommandPolicyHookRunner.ts`
- [ ] T010 Add hook runner unit tests for block/allow JSON responses in `tests/agent-command-policy-hook-runner.test.ts`
- [ ] T011 Add CLI command tests for `agent-command-policy-hook` in `tests/agent-command-policy-cli.test.ts`
- [ ] T012 Update `src/core/harness/HarnessFactory.ts` so Hermes ACP can receive a Symphony-owned permission resolver

**Checkpoint**: Foundation ready. The policy module, CLI hook runner, and ACP resolver injection point exist without vendored Hermes source edits.

---

## Phase 3: User Story 1 - Prevent Agent-Owned Upstream GitHub Activity (Priority: P1) MVP

**Goal**: Worker and reviewer command-capable surfaces deny upstream GitHub activity before GitHub contact, credential prompts, helper execution, or remote mutation.

**Independent Test**: Attempt direct and disguised upstream GitHub commands through classifier, ACP permission, Hermes profile hook, delegated subagent, command reducer, and `execute_code` surfaces. Every attempt is denied before execution.

### Tests for User Story 1

- [ ] T013 [P] [US1] Add direct upstream Git/GitHub deny cases in `tests/agent-command-policy-upstream.test.ts`
- [ ] T014 [P] [US1] Add absolute path, nested shell, interpreter, package-script, and script-wrapper deny cases in `tests/agent-command-policy-disguised.test.ts`
- [ ] T015 [P] [US1] Add Hermes ACP terminal permission denial coverage in `tests/hermes-acp-command-policy.test.ts`
- [ ] T016 [P] [US1] Add Hermes gateway/TUI profile hook installation coverage in `tests/hermes-command-policy-profile.test.ts`
- [ ] T017 [P] [US1] Add delegated subagent and command reducer inheritance coverage in `tests/hermes-delegated-command-policy.test.ts`, proving worker/reviewer delegated research tools, bounded reducer commands, and child command-capable sessions receive the same policy hook or fail closed
- [ ] T018 [P] [US1] Add `execute_code` denial coverage in `tests/agent-command-policy-execute-code.test.ts` for subprocess spawning, network clients, Git/GitHub access, credential-backed paths, dynamically constructed commands, and ambiguous code that cannot be proven local-only

### Implementation for User Story 1

- [ ] T019 [US1] Implement direct upstream executable and host denial in `src/core/harness/AgentCommandPolicy.ts`
- [ ] T020 [US1] Implement nested shell, interpreter, package-script, script-wrapper, and absolute-path classification in `src/core/harness/AgentCommandPolicy.ts`
- [ ] T021 [US1] Implement `execute_code` command classification in `src/core/harness/AgentCommandPolicy.ts`, denying code that can spawn subprocesses, contact GitHub, access credential-backed GitHub paths, or cannot be classified as local-only and helper-free
- [ ] T022 [US1] Create ACP permission resolver adapter in `src/core/harness/AgentCommandPolicyAcpResolver.ts`
- [ ] T023 [US1] Wire `HermesAcpHarness` permission requests to the policy resolver in `hermes/src/HermesAcpHarness.ts`
- [ ] T024 [US1] Pass the default ACP policy resolver from harness creation in `src/core/harness/HarnessFactory.ts`
- [ ] T025 [US1] Add generated Hermes profile hook configuration support in `hermes/src/HermesMcpConfig.ts`
- [ ] T026 [US1] Configure worker and reviewer Hermes gateway profiles to call `agent-command-policy-hook` in `hermes/src/HermesHarness.ts`
- [ ] T027 [US1] Ensure worker/reviewer delegated subagent profiles and command reducer surfaces inherit the generated `agent-command-policy-hook` configuration in `hermes/src/HermesHarness.ts` and related profile materialization code
- [ ] T028 [US1] Update worker/reviewer role template policy assertions for generated hook configuration in `tests/hermes-template-policy.test.ts`
- [ ] T029 [US1] Run US1 targeted validation commands listed in `specs/001-block-agent-github/quickstart.md`

**Checkpoint**: User Story 1 is independently functional. Worker/reviewer upstream GitHub commands are denied across classifier, ACP permission, Hermes profile hook, delegated subagent, command reducer, and `execute_code` paths.

---

## Phase 4: User Story 2 - Preserve Safe Local Repository Inspection (Priority: P1)

**Goal**: Worker and reviewer agents can still run helper-free local repository inspection while unsafe Git config and environment bypasses fail closed.

**Independent Test**: Safe local Git inspection commands succeed when local-only and helper-free; commands with unsafe inline env, inherited env, inline config, or persisted Git config are denied and fake helpers do not execute.

### Tests for User Story 2

- [ ] T030 [P] [US2] Add safe local Git inspection allow cases in `tests/agent-command-policy-local-inspection.test.ts`
- [ ] T031 [P] [US2] Add inline environment and per-command Git config denial cases in `tests/agent-command-policy-git-config.test.ts`
- [ ] T032 [P] [US2] Add persisted Git config fake-helper side-effect tests in `tests/agent-command-policy-fake-helper.test.ts`
- [ ] T033 [P] [US2] Add hook runner local-inspection allow/deny tests in `tests/agent-command-policy-hook-runner-local.test.ts`

### Implementation for User Story 2

- [ ] T034 [US2] Implement helper-free local Git inspection allowlist in `src/core/harness/AgentCommandPolicy.ts`
- [ ] T035 [US2] Implement inline environment assignment parsing and unsafe `GIT_*` environment detection in `src/core/harness/AgentCommandPolicy.ts`
- [ ] T036 [US2] Implement per-command Git config parsing including `GIT_CONFIG_COUNT` keys in `src/core/harness/AgentCommandPolicy.ts`
- [ ] T037 [US2] Create persisted Git config inspection helper in `src/core/harness/AgentCommandPolicyGitConfig.ts`
- [ ] T038 [US2] Integrate persisted Git config fail-closed decisions in `src/core/harness/AgentCommandPolicy.ts`
- [ ] T039 [US2] Pass effective working directory and environment keys through the hook runner in `src/core/harness/AgentCommandPolicyHookRunner.ts`
- [ ] T040 [US2] Preserve local-only denial and allow messages for agents in `src/core/harness/AgentCommandPolicy.ts`
- [ ] T041 [US2] Run US2 targeted validation commands listed in `specs/001-block-agent-github/quickstart.md`

**Checkpoint**: User Story 2 is independently functional. Safe local inspection works, and unsafe Git helper/config bypasses are blocked before helper execution.

---

## Phase 5: User Story 3 - Keep Service-Owned GitHub Workflow Actions Separate (Priority: P1)

**Goal**: Symphony service-owned GitHub publication, review feedback, mergeability, CI, and writeback paths remain functional while direct worker/reviewer attempts are denied.

**Independent Test**: Service-owned MCP and publication/review writeback flows retain their scoped GitHub credentials; equivalent worker/reviewer terminal or code-execution attempts are denied and redirected to service-owned workflow.

### Tests for User Story 3

- [ ] T042 [P] [US3] Add MCP subprocess credential-slice regression coverage in `tests/mcp-subprocess-environment-command-policy.test.ts`
- [ ] T043 [P] [US3] Add completion report publication boundary coverage in `tests/completion-report-mcp-command-policy.test.ts`
- [ ] T044 [P] [US3] Add review feedback service boundary coverage in `tests/review-feedback-mcp-command-policy.test.ts`
- [ ] T045 [P] [US3] Add mergeability and CI service boundary coverage in `tests/github-service-boundary-command-policy.test.ts`, proving service-owned mergeability checks and CI check reads/writes are not intercepted by worker/reviewer command policy while equivalent agent-owned terminal or `execute_code` attempts are denied

### Implementation for User Story 3

- [ ] T046 [US3] Ensure service-owned surfaces are outside agent command policy in `src/core/harness/AgentCommandPolicy.ts`
- [ ] T047 [US3] Preserve GitHub capability environment slicing for service MCP commands in `src/core/harness/McpSubprocessEnvironment.ts`
- [ ] T048 [US3] Preserve mergeability and CI check service paths outside `AgentCommandPolicy` while keeping worker/reviewer direct GitHub command attempts denied and redirected to service-owned workflow handling
- [ ] T049 [US3] Update worker completion handoff prompt text to identify service-owned GitHub workflow as the allowed path in `src/core/harness/HandoffMcp.ts`
- [ ] T050 [US3] Update reviewer handoff or denial messaging for service-owned review feedback workflow in `src/core/harness/HandoffMcp.ts`
- [ ] T051 [US3] Run US3 targeted validation commands listed in `specs/001-block-agent-github/quickstart.md`

**Checkpoint**: User Story 3 is independently functional. Agent-owned GitHub activity is blocked, and service-owned GitHub workflow actions remain separate and usable.

---

## Phase 6: User Story 4 - Provide Auditable Policy Evidence (Priority: P2)

**Goal**: Allow/deny decisions are visible in durable run activity and replay without exposing secrets, so operators can distinguish policy enforcement from implementation defects and service failures.

**Independent Test**: Run policy allow and deny scenarios, then inspect durable run activity and replayed transcript state. Each decision includes role, phase, surface, normalized command class, outcome, structured reason, redacted evidence, and upstream-contact status.

### Tests for User Story 4

- [ ] T052 [P] [US4] Add command policy run activity schema tests in `tests/run-activity-event-command-policy.test.ts`
- [ ] T053 [P] [US4] Add command policy transcript replay tests in `tests/transcript-replay-command-policy.test.ts`
- [ ] T054 [P] [US4] Add command policy redaction tests in `tests/web-transcript-projection-command-policy.test.ts`

### Implementation for User Story 4

- [ ] T055 [US4] Extend run activity event taxonomy for command policy decisions in `src/core/runActivity/RunActivityEvent.ts`
- [ ] T056 [US4] Map command policy decisions into transcript events in `src/core/transcript/RunActivityEventMapper.ts`
- [ ] T057 [US4] Persist and replay command policy events in `src/core/persistence/RunTranscriptStore.ts`
- [ ] T058 [US4] Emit command policy events from ACP resolver in `src/core/harness/AgentCommandPolicyAcpResolver.ts`
- [ ] T059 [US4] Emit command policy events from hook runner or Hermes harness path in `src/core/harness/AgentCommandPolicyHookRunner.ts`
- [ ] T060 [US4] Ensure command policy payloads are redacted in transcript projections in `src/core/transcript/TranscriptProjection.ts`
- [ ] T061 [US4] Run US4 targeted validation commands listed in `specs/001-block-agent-github/quickstart.md`

**Checkpoint**: User Story 4 is independently functional. Policy decisions survive replay and are useful for operator audit without credential exposure.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Final validation, documentation, and readiness for promotion through the Linear subissue checkpoints.

- [ ] T062 [P] Update final validation instructions in `specs/001-block-agent-github/quickstart.md`
- [ ] T063 [P] Update agent command policy contract examples in `specs/001-block-agent-github/contracts/agent-command-policy.md`
- [ ] T064 Capture dogfood validation evidence for SC-004, confirming worker/reviewer runs produce zero desktop OAuth prompts, SSH key confirmation prompts, or GitHub credential prompts caused by agent-owned command attempts
- [ ] T065 Run `npm run typecheck` per `specs/001-block-agent-github/quickstart.md`
- [ ] T066 Run targeted policy test suite, including lightweight command-policy latency regression coverage, per `specs/001-block-agent-github/quickstart.md`
- [ ] T067 Run full CI-equivalent validation commands per `specs/001-block-agent-github/quickstart.md`
- [ ] T068 Confirm no implementation changes touched vendored Hermes source under `hermes/upstream-src/**` using the constraint in `specs/001-block-agent-github/quickstart.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies. Can start immediately.
- **Foundational (Phase 2)**: Depends on Setup completion. Blocks all user stories.
- **User Story 1 (Phase 3)**: Depends on Foundational completion. This is the MVP.
- **User Story 2 (Phase 4)**: Depends on Foundational completion and the classifier shape from User Story 1.
- **User Story 3 (Phase 5)**: Depends on Foundational completion and the denial/message semantics from User Story 1.
- **User Story 4 (Phase 6)**: Depends on policy decisions from User Stories 1 and 2 and service-boundary semantics from User Story 3.
- **Polish (Phase 7)**: Depends on all desired user stories being complete.

### User Story Dependencies

- **US1 Prevent upstream GitHub activity (P1)**: MVP; should complete first because it establishes deny enforcement across surfaces.
- **US2 Preserve safe local inspection (P1)**: Builds on US1 classifier and extends it with allow rules and Git config fail-closed behavior.
- **US3 Keep service-owned workflow separate (P1)**: Can proceed after US1 because it validates service-owned boundaries against direct-deny behavior.
- **US4 Provide auditable policy evidence (P2)**: Should follow US1-US3 so audit records reflect final decision semantics.

### Linear Subissue Breakdown

Use these as agent-sized Linear subissues under `ENG-243`. Each row should be independently reviewable and should carry its own focused validation command or acceptance check.

- **Issue 1**: T001, T002, T006-T008 - shared policy fixtures, type contracts, redaction helpers, and Windows/POSIX executable normalization.
- **Issue 2**: T003, T004, T009-T011 - hook runner and `agent-command-policy-hook` CLI contract.
- **Issue 3**: T005 - no-vendored-Hermes-source guard for Symphony-owned enforcement paths.
- **Issue 4**: T013, T019 - direct upstream Git/GitHub denial.
- **Issue 5**: T014, T020 - disguised command denial for shell wrappers, interpreters, package scripts, script wrappers, and absolute paths.
- **Issue 6**: T018, T021 - `execute_code` denial for subprocess, network, credential-backed, and ambiguous code paths.
- **Issue 7**: T012, T015, T022-T024 - Hermes ACP permission resolver enforcement.
- **Issue 8**: T016, T025, T026, T028 - Hermes gateway/TUI profile hook configuration and template assertions.
- **Issue 9**: T017, T027 - delegated subagent and command reducer policy inheritance.
- **Issue 10**: T029 - US1 targeted validation across classifier, ACP, profile hook, delegated, reducer, and `execute_code` surfaces.
- **Issue 11**: T030, T034, T040 - helper-free local Git inspection allowlist and messages.
- **Issue 12**: T031, T035, T036 - unsafe inline environment and per-command Git config denial.
- **Issue 13**: T032, T037, T038 - persisted Git config fake-helper fail-closed behavior.
- **Issue 14**: T033, T039 - hook runner local-inspection allow/deny context handling.
- **Issue 15**: T041 - US2 targeted validation for local inspection and unsafe Git config.
- **Issue 16**: T042, T046, T047 - service MCP credential boundary and environment slicing.
- **Issue 17**: T043, T044, T049, T050 - publication/review writeback boundary and handoff messaging.
- **Issue 18**: T045, T048 - mergeability and CI service boundary.
- **Issue 19**: T051 - US3 targeted validation for service-owned workflow separation.
- **Issue 20**: T052, T055, T056 - command policy run activity schema and transcript mapping.
- **Issue 21**: T053, T057 - transcript replay and persistence.
- **Issue 22**: T054, T060 - redaction and transcript projection.
- **Issue 23**: T058, T059 - policy event emission from ACP resolver and hook runner paths.
- **Issue 24**: T061 - US4 targeted validation for audit and replay.
- **Issue 25**: T062-T064 - final documentation, contract examples, and SC-004 dogfood evidence capture.
- **Issue 26**: T065-T068 - final typecheck, targeted suite, CI-equivalent validation, and vendored Hermes source diff/status check.

### Promotion Checkpoints

- **Checkpoint A**: Issues 1-10 complete. US1 MVP is ready to dogfood for upstream GitHub denial across worker/reviewer command surfaces.
- **Checkpoint B**: Issues 11-15 complete. Safe local inspection and unsafe Git config fail-closed behavior are ready to dogfood.
- **Checkpoint C**: Issues 16-19 complete. Service-owned GitHub workflow boundaries are ready to dogfood.
- **Checkpoint D**: Issues 20-24 complete. Durable audit and replay behavior is ready to dogfood.
- **Checkpoint E**: Issues 25-26 complete. ENG-243 final validation is ready for completion.

### Parallel Opportunities

- T002 and T003 can run in parallel after T001.
- T013-T018 can be written in parallel because they use separate test files.
- T030-T033 can be written in parallel because they use separate test files.
- T042-T045 can be written in parallel because they use separate test files.
- T052-T054 can be written in parallel because they use separate test files.
- T062 and T063 can run in parallel because they update separate spec artifacts.

---

## Parallel Example: User Story 1

```text
Task: "Add direct upstream Git/GitHub deny cases in tests/agent-command-policy-upstream.test.ts"
Task: "Add absolute path, nested shell, interpreter, package-script, and script-wrapper deny cases in tests/agent-command-policy-disguised.test.ts"
Task: "Add Hermes ACP terminal permission denial coverage in tests/hermes-acp-command-policy.test.ts"
Task: "Add Hermes gateway/TUI profile hook installation coverage in tests/hermes-command-policy-profile.test.ts"
Task: "Add delegated subagent and command reducer inheritance coverage in tests/hermes-delegated-command-policy.test.ts"
Task: "Add execute_code denial coverage in tests/agent-command-policy-execute-code.test.ts"
```

---

## Parallel Example: User Story 2

```text
Task: "Add safe local Git inspection allow cases in tests/agent-command-policy-local-inspection.test.ts"
Task: "Add inline environment and per-command Git config denial cases in tests/agent-command-policy-git-config.test.ts"
Task: "Add persisted Git config fake-helper side-effect tests in tests/agent-command-policy-fake-helper.test.ts"
Task: "Add hook runner local-inspection allow/deny tests in tests/agent-command-policy-hook-runner-local.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1 setup.
2. Complete Phase 2 foundational policy contracts and hook runner plumbing.
3. Complete Phase 3 User Story 1.
4. Stop and validate upstream GitHub denials across classifier, ACP permission, Hermes profile hook, delegated subagent, command reducer, and `execute_code` paths.
5. Promote Checkpoint A after Issues 1-10 land locally so Symphony can dogfood the upstream-deny boundary before safe-local inspection is fully refined.

### Incremental Delivery

1. Add the shared classifier foundation.
2. Add upstream-deny MVP.
3. Add safe local inspection.
4. Add service-owned workflow separation.
5. Add durable audit/replay.
6. Run final validation and then consider ENG-243 complete.

### Guardrail Strategy

If any implementation task appears to require changes under vendored Hermes source at `hermes/upstream-src/**`, stop that task and mark the relevant Linear subissue blocked. The accepted alternatives are Symphony-owned code, generated profile assets, hooks/plugins, MCP/service boundaries, and configuration. Vendored Hermes source edits are not part of this feature.

At final validation, confirm both commands produce no changed paths:

```powershell
git diff --name-only -- hermes/upstream-src
git status --short -- hermes/upstream-src
```

---

## Notes

- `[P]` tasks touch different files and can run in parallel after their dependencies are satisfied.
- `[US1]`, `[US2]`, `[US3]`, and `[US4]` labels map directly to the user stories in `spec.md`.
- Test tasks are included because FR-014 requires validation coverage.
- Keep each Linear subissue small enough that one worker can implement, validate, and hand off without needing to understand the entire feature at once.

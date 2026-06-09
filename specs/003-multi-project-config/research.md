# Research: Multi-Project Configuration

## Decision: Normalize legacy single-project config into one default project context

**Rationale**: Current `ServiceConfig` exposes one `tracker`, one `workspace`, one `github`, one review loop, one issue-breakdown config, and one set of protected paths. Existing workflows and tests depend on those values. Normalizing legacy top-level settings into a stable default context preserves current behavior while making the internal model multi-project from the start.

**Alternatives considered**:

- Require all workflows to migrate immediately to `project_contexts`. Rejected because it breaks current dogfood and test fixtures.
- Keep legacy single-project code paths beside a new multi-project path. Rejected because every dispatch, writeback, and projection path would need dual semantics.

## Decision: Use `projectContextId` as the durable discriminator

**Rationale**: Issue identifiers can collide across Linear projects. Workspace keys, lifecycle records, run aliases, projection source indexes, approval records, and writeback keys currently rely heavily on `issueIdentifier` or global scopes. A short, stable, operator-defined context id gives every durable record and operator view a consistent namespace without exposing secrets.

**Alternatives considered**:

- Use Linear project slug as the durable discriminator. Rejected because project slugs may change and do not represent codebase or credential settings.
- Use repository URL/path. Rejected because multiple contexts may intentionally share a codebase while differing by Linear project.

## Decision: Route every issue through a service-owned project context resolver before action

**Rationale**: The orchestrator currently polls one tracker client and uses one config object for lifecycle state checks. Multi-project support needs a single resolution step that produces exactly one context before workspace creation, dispatch, review, writeback, or cleanup. Routing failures become human-required service states, not agent decisions.

**Alternatives considered**:

- Let agents infer the project from issue text. Rejected by the constitution authority boundary and because it is unsafe for writeback.
- Dispatch per-context workers without a shared resolver. Rejected because duplicate issue identifiers and replay would remain ambiguous.

## Decision: Instantiate context-scoped service helpers from the shared registry

**Rationale**: Linear clients, GitHub clients, workspace managers, transition policy, credential resolution, and MCP environment generation need context-specific settings. Creating context-scoped helper views keeps existing modules understandable while avoiding a global mutable config switch.

**Alternatives considered**:

- Clone the entire orchestrator per project context. Rejected because global concurrency, provider gates, status APIs, and durable projections still need cross-project coordination.
- Mutate `config.tracker` and related fields while iterating contexts. Rejected because it is fragile during concurrent runs and configuration reloads.

## Decision: Persist project context attribution alongside existing records with legacy fallback

**Rationale**: File-backed records and Postgres projections power restart, replay, web views, approvals, writeback, and diagnostics. New records should include `projectContextId`, context label, Linear project identity, codebase source identity, workspace identity, and routing source. Old records should read as a legacy/default context so history remains usable.

**Alternatives considered**:

- Store attribution only in run metadata. Rejected because workspaces, lifecycle records, approvals, writebacks, and projections can be read independently of a run.
- Migrate historical files eagerly. Rejected for v1 because read-time defaulting/backfill is lower risk and avoids touching operator-controlled state unnecessarily.

## Decision: Namespace operator-facing aliases and projection scopes by context

**Rationale**: The current web projection source indexes and route lookups use aliases such as issue id, issue identifier, and workspace key. In a multi-project service, `ENG-123` can exist in more than one Linear project. Context-aware aliases and filters prevent accidental cross-project reads and make project filtering possible.

**Alternatives considered**:

- Keep a global board only and rely on title/labels for disambiguation. Rejected because it does not satisfy durable attribution or filtering requirements.
- Split every web endpoint into separate project-only endpoints. Rejected because operators still need aggregate views across contexts.

## Decision: Keep one primary project context per run for this feature

**Rationale**: The spec explicitly scopes out cross-project runs. Single-context runs keep workspace ownership, PR publication, Linear writeback, and replay deterministic.

**Alternatives considered**:

- Support one run mutating multiple contexts. Rejected as a separate orchestration feature because it changes agent scope, proof, writeback, and merge semantics.

## Decision: Use existing dependencies and validation style

**Rationale**: `yaml`, `zod`, file-backed stores, `pg`, and `vitest` already support the needed config, persistence, migration, and validation work. No new package is required for project context normalization or routing.

**Alternatives considered**:

- Add a config-merge or schema composition dependency. Rejected because existing parsing patterns in `src/core/config/Config.ts` are sufficient.

## Phase 1 protected-surface inventory note

Current single-project assumptions that downstream multi-project work must unwind carefully:

- `src/core/config/Config.ts` normalizes one top-level `tracker`, `workspace`, `github`, `review_loop`, `issue_breakdown`, and protected-path set into `ServiceConfig`, so multi-project support starts by introducing a context registry without breaking the legacy single-project compatibility view.
- `src/integrations/linear/LinearTrackerClient.ts` scopes candidate polling and state refresh queries to one `tracker.projectSlug` per client instance, which makes tracker client creation a primary context-resolution seam.
- `src/core/workspace/WorkspaceManager.ts` derives `workspaceKey` from `issue.identifier` (plus `-planning` for planning workspaces) and resolves one workspace root/state directory from `options.workspace`, so duplicate issue identifiers across contexts will collide unless workspace identity becomes context-qualified.
- `src/core/orchestrator/Orchestrator.ts` accepts one `TrackerClient`, one `WorkspaceManager`, and records one issue/workspace tuple per dispatch, which means routing must stay service-owned and become explicit before polling, workspace creation, or handoff.
- `src/core/persistence/RunTranscriptStore.ts` persists `WorkspaceRecord` and `RunRecord` entries keyed by issue/workspace metadata without a project-context discriminator today, so future durable attribution needs to extend runs, workspaces, and replay paths together.
- `src/app/webProjection.ts` and related projection indexing build operator-facing aliases from `issueIdentifier`, `workspaceKey`, and `runId`, so duplicate identifiers across Linear projects will require context-aware aliases in board, history, detail, and transcript views.
- `tests/helpers.ts` is the shared test-fixture seam for future config and tracker coverage, so Phase 1 adds reusable multi-project workflow, tracker, and issue builders there before behavior-changing implementation starts.

Protected-surface constraints for downstream implementation:

- Project-context resolution, workspace selection, writeback targeting, lifecycle transitions, and MCP handoff validation remain Symphony-owned service decisions; agents only receive already-resolved metadata.
- The credential boundary, operator-controlled secret stores, runtime credentials, profile contents, and other private access material remain out of scope for this feature unless a later plan explicitly ratifies a protected-surface change.
- Existing dirty workspaces, protected branches, and external Linear/GitHub project state remain out of scope for this feature unless a later plan explicitly ratifies a protected-surface change.
- `hermes/upstream-src/**` does not require changes for this feature. Phase 1 inventory found no setup or routing prerequisite that depends on modifying vendored Hermes sources.

### T005 verification note: no vendored Hermes upstream implementation changes required

- Checked the multi-project task and plan surfaces in `specs/003-multi-project-config/tasks.md` and `specs/003-multi-project-config/plan.md` before foundational implementation proceeds.
- All implementation-targeted task paths for T006-T105 stay in Symphony-owned surfaces such as `src/core/**`, `src/integrations/**`, `src/app/**`, `tests/**`, `migrations/postgres/**`, `docs/**`, `scripts/**`, and supporting spec artifacts; none names `hermes/upstream-src/**` as an edit target.
- The only task references to `hermes/upstream-src/**` are safety guardrails: T005 requires this up-front verification, T104 requires a final git-diff audit, and the plan/task constraints explicitly say not to modify vendored Hermes source.
- Caveat: this verification is scoped to the multi-project feature plan. It does not change any existing vendored-Hermes integration elsewhere in the repository, and follow-on multi-project issues should stay within Symphony-owned surfaces unless a separate issue explicitly authorizes upstream changes.

## Inspection note: current single-project assumptions (T001)

**Scope**: Inspected the six source files called out by the issue contract to capture the current single-project assumptions before multi-project implementation begins.

### File-by-file findings

- **`src/core/config/Config.ts`**
  - `TrackerConfig` and `ServiceConfig` expose one `tracker` and one `workspace` object.
  - `parseServiceConfig` requires exactly one `tracker.project_slug`, resolves one `workspace.root` plus one `workspace.state_dir`, and returns singleton `config.tracker` / `config.workspace` values for the rest of the service.
  - **Constraint for follow-on work**: multi-project support needs a compatibility layer that preserves a default context view for callers that still read `config.tracker`, `config.workspace`, `config.github`, or other top-level singletons.

- **`src/integrations/linear/LinearTrackerClient.ts`**
  - `CANDIDATE_QUERY`, `ISSUES_BY_STATES_QUERY`, and `PROJECT_WORKFLOW_STATES_QUERY` all filter by one `$projectSlug`.
  - `fetchCandidateIssues`, `fetchIssuesByStates`, and `fetchWorkflowStatesByTeam` always use `this.config.projectSlug`, so polling and workflow-state discovery are scoped to one configured Linear project at a time.
  - `createIssueFromPlan` reuses the parent issue's `projectId` when it is present, which means child-issue writeback already assumes the service has selected the correct tracker/project context before the write path runs.
  - **Constraint for follow-on work**: routing must select the correct context before both polling and writeback, and the selected context must remain stable across replay or retries.

- **`src/core/workspace/WorkspaceManager.ts`**
  - `createForIssue` derives `workspaceKey` directly from `issue.identifier` via `sanitizeWorkspaceKey()` and resolves the workspace beneath one configured `workspace.root`.
  - `createForPlanning` uses the same issue-derived key with a `-planning` suffix.
  - `resolveBranchName` defaults to `symphony/{{ issue.identifier }}` when the issue does not already provide a branch name.
  - **Constraint for follow-on work**: duplicate issue identifiers from different Linear projects would currently collide in workspace keys, workspace paths, and default branch namespaces.

- **`src/core/orchestrator/Orchestrator.ts`**
  - The orchestrator stores one `ServiceConfig`, scopes the provider-gate store from `config.workspace.stateDir`, and dispatches through one injected tracker / workspace-manager pairing.
  - `tick()` polls worker candidates through `this.options.tracker.fetchCandidateIssues()` and reviewer candidates through `fetchIssuesByStates(this.config.reviewLoop.reviewStates)`.
  - `runWorker()` / `runReviewer()` create one workspace per issue and persist one set of workspace summary pointers on the lifecycle record.
  - **Constraint for follow-on work**: project resolution must happen before polling and dispatch, and in-progress runs need persisted context so reload, retry, and reviewer handoff paths do not reroute to a different project later.

- **`src/core/persistence/RunTranscriptStore.ts`**
  - `WorkspaceRecord`, `StartRunInput`, and `RunRecord` persist `issueId`, `issueIdentifier`, `workspaceKey`, `workspacePath`, and repository metadata, but no project-context identifier or Linear project identity.
  - `findWorkspace()` looks up records by `issueId`, `issueIdentifier`, or `workspaceKey`.
  - `listRunsForIssue()` groups history by `issueId` or `issueIdentifier` only.
  - **Constraint for follow-on work**: durable state, replay, and lookup paths cannot currently disambiguate duplicate issue identifiers across project contexts.

- **`src/app/webProjection.ts`**
  - `projectIssueModel()` builds public issue ids, session ids, and workspace labels from `issueIdentifier`, `runId`, and workspace path/key, while the projected `project` field remains empty.
  - `projectSessionModel()` titles sessions with `run.issueIdentifier`.
  - `projectRunningAgents()` and `projectDurableRunningAgents()` label running work from `issueIdentifier`, `issueId`, or `workspaceKey`.
  - **Constraint for follow-on work**: operator views currently assume a global issue namespace and cannot safely disambiguate activity from two projects that share the same issue identifier pattern.

### Cross-cutting risks and downstream constraints

1. **Identity collisions are the main invariant break**. `issueIdentifier`, `workspaceKey`, branch names, run lookups, and web aliases all assume one global namespace.
2. **Routing currently happens implicitly through singleton config**. Candidate polling, workflow-state discovery, workspace creation, and writeback all depend on one injected tracker/workspace pair rather than an explicit resolved project context.
3. **Replay durability is incomplete for multi-project routing**. Once a run or workspace is recorded, the durable record does not contain enough information to prove which project context should be reused after restart or configuration reload.
4. **Operator projections need context attribution, not just filtering**. The web/status surfaces currently expose issue- and workspace-centric labels, so adding multiple projects without new public attribution would make diagnostics and history ambiguous.
5. **Compatibility work needs to preserve the legacy single-project view**. Existing callers and tests expect top-level singleton config fields and issue-centric workspace naming, so the migration should normalize legacy workflows into a default context rather than fork behavior abruptly.

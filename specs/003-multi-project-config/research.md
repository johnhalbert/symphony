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

## Protected-surface inventory and current single-project assumptions

The current implementation has several project-specific assumptions that must be converted carefully rather than changed opportunistically:

- `src/core/config/Config.ts` currently normalizes one top-level `tracker`, `workspace`, `github`, `review_loop`, `issue_breakdown`, `agent`, and `credential_profiles` set into one `ServiceConfig`.
- `src/app/RuntimeDependencies.ts` and `src/integrations/linear/LinearCredentialResolver.ts` currently construct one Linear tracker/writeback client flow from that single config view.
- `src/integrations/linear/LinearTrackerClient.ts` scopes candidate discovery, state refresh, transitions, comments, and issue creation to one `tracker.projectSlug`.
- `src/core/workspace/WorkspaceManager.ts` derives workspace identity from the issue identifier, which becomes a collision risk when two contexts can contain the same issue identifier.
- `src/core/persistence/RunTranscriptStore.ts`, `src/app/WebProjectionContext.ts`, and `src/app/http.ts` build or resolve aliases from issue id, issue identifier, and workspace key without project-context namespacing.

These are protected multi-system surfaces because they cross configuration, tracker routing, workspace ownership, durable persistence, and operator-facing reads. Multi-project work should treat the following as the minimum review surface:

- configuration parsing and legacy compatibility (`src/core/config/**`)
- tracker client and credential resolution (`src/integrations/linear/**`)
- workspace keying and metadata (`src/core/workspace/**`)
- run/lifecycle/writeback persistence and replay (`src/core/persistence/**`, `src/core/writeback/**`, `src/core/approval/**`)
- operator projections and HTTP alias resolution (`src/app/**`)
- orchestration and dispatch handoff boundaries (`src/core/orchestrator/**`, `src/core/harness/**`)

Protected or out-of-scope surfaces for the initial feature:

- `hermes/upstream-src/**` remains vendored and should not be modified for this feature.
- operator-managed secret stores, credential values, and external project state remain outside repo-authored migration work.
- existing dirty workspaces and protected-branch publication behavior stay service-owned and must continue to fail closed on ambiguous routing.

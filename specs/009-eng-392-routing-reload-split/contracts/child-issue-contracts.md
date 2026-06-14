# ENG-392 child issue contract family templates

These templates finalize the child-issue decomposition units for the blocked ENG-392 repair. Each family below freezes:

- one stable primary requirement ID,
- a suggested child-issue title for title-based dependency wiring,
- the exact authorized surfaces that the child issue may list in `Touched Surfaces`,
- a copyable issue body that already matches the shared fenced-JSON issue-contract shape, and
- promotion-readiness guidance that keeps protected workflow surfaces manual-only.

Use these as planning references, not as already-created Linear issues. Keep the primary requirement IDs and suggested titles stable if you copy a template into a child issue.

## Dependency order at a glance

The current apply path resolves sibling dependencies by normalized child title, so the suggested titles below are part of the contract guidance.

| Order | Suggested child title | Primary requirement ID | Depends on title(s) | Why this comes here |
| --- | --- | --- | --- | --- |
| 1 | `ENG-392 child — decision and scope lock` | `REQ-392-DECISION` | none | Freezes whether the repair stays split into child issues and keeps later scope expansions explicit instead of recreating the original tests-only/runtime mismatch. |
| 2 | `ENG-392 child — runtime routing repair` | `REQ-392-RUNTIME-ROUTING` | `ENG-392 child — decision and scope lock` | Establishes project-context-qualified routing and workspace identity before reload, approval, or proof work tries to preserve or validate it. |
| 3 | `ENG-392 child — reload preservation repair` | `REQ-392-RELOAD-PRESERVATION` | `ENG-392 child — runtime routing repair` | Builds on stable routing identity so an in-progress worker or reviewer context can survive config reload without bucket drift or duplicate dispatch. |
| 4 | `ENG-392 child — approval writeback repair` | `REQ-392-APPROVAL-WRITEBACK` | `ENG-392 child — runtime routing repair`, `ENG-392 child — reload preservation repair` | Repairs pending-publication approval and writeback recovery only after routed runtime identity and reload preservation are stable. |
| 5 | `ENG-392 child — orchestrator proof` | `REQ-392-TEST-PROOF` | `ENG-392 child — runtime routing repair`, `ENG-392 child — reload preservation repair`, `ENG-392 child — approval writeback repair` | Adds the final focused orchestrator proof after the underlying runtime and approval invariants are explicit and deterministic. |
| 6 | `ENG-392 child — publication hygiene closure` | `REQ-392-PUBLICATION-HYGIENE` | `ENG-392 child — decision and scope lock`, `ENG-392 child — orchestrator proof`, `ENG-392 child — approval writeback repair` | Closes the loop by keeping the final diff, evidence packet, and repository hygiene aligned with the declared child scopes. |

## Cross-artifact consistency review — T011

This review compared the expected planning surfaces `specs/009-eng-392-routing-reload-split/spec.md`, `specs/009-eng-392-routing-reload-split/plan.md`, `specs/009-eng-392-routing-reload-split/data-model.md`, and `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md`.

- `spec.md` and `plan.md` are not tracked in the current `009-eng-392-routing-reload-split` snapshot. Treat that absence as an explicit planning gap rather than implicit agreement with the generic Spec Kit layout.
- Until those files exist or the task source is retargeted, use `data-model.md` plus this contract family as the durable baseline for decomposition scope, dependency order, and runtime prerequisite mapping.
- Family A dependency validation is evaluated over direct or transitive dependency edges unless a later family is intentionally independent and says so explicitly.

### Runtime prerequisite crosswalk

The table below supplies the minimum prerequisite map referenced by `data-model.md` for a confirmed decomposition decision.

| Data-model surface family | Child contract owner(s) | Consistency note |
| --- | --- | --- |
| `routing-reload-core` | `REQ-392-RUNTIME-ROUTING`, `REQ-392-RELOAD-PRESERVATION`, `REQ-392-TEST-PROOF` | Family B establishes routed identity, Family C preserves it across reload, and Family E proves it end to end. |
| `workspace-lifecycle` | `REQ-392-RUNTIME-ROUTING`, `REQ-392-RELOAD-PRESERVATION`, `REQ-392-APPROVAL-WRITEBACK` | Family B separates routed workspace and lifecycle buckets, Family C preserves them, and Family D reuses them during approval and writeback recovery. |
| `operator-http-entrypoints` | `REQ-392-RUNTIME-ROUTING`, `REQ-392-APPROVAL-WRITEBACK` | Routed status or workspace entrypoints land in Family B and routed approval or status recovery lands in Family D. |
| `publication-handoff` | `REQ-392-APPROVAL-WRITEBACK`, `REQ-392-PUBLICATION-HYGIENE` | Family D repairs completion-report, approval, and writeback recovery; Family F closes the publication-facing evidence surface. |
| `writeback-guardrails` | `REQ-392-APPROVAL-WRITEBACK`, `REQ-392-PUBLICATION-HYGIENE` | Family D restores durable audit and writeback invariants while Family F confirms no unauthorized closure surface remains. |

## Family A — `REQ-392-DECISION`

- Suggested child title: `ENG-392 child — decision and scope lock`
- Dependency order: **1 of 6**
- Authorized surfaces to list in `Touched Surfaces`:
  - `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md`
  - `specs/009-eng-392-routing-reload-split/quickstart.md`
  - `specs/009-eng-392-routing-reload-split/research.md`

````markdown
## Problem / Goal

Record the ENG-392 decomposition decision before any child implementation work starts so later child issues either stay split into contract-scoped siblings or explicitly document any authorized scope expansion instead of reintroducing the original tests-only/runtime mismatch.

## Issue Contract

```json
{"schemaVersion":1,"contractVersion":"2026-06-14.1","requirements":[{"id":"REQ-392-DECISION","requirement":"The child issue must record the ENG-392 decomposition decision, the sibling dependency order it unblocks, and the exact surfaces that remain excluded until a later child contract authorizes them.","proofHint":"Cite the dependency table plus the named included and excluded surfaces in specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md and quickstart.md."}]}
```

## Touched Surfaces

- [X] Docs only
- specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md
- specs/009-eng-392-routing-reload-split/quickstart.md
- specs/009-eng-392-routing-reload-split/research.md

## Acceptance Criteria

- The issue names the chosen decomposition path and the child titles or superseding replacement that depend on it.
- The issue limits operator outcomes to split/retarget, widened child-contract authorization, or close/replace with durable proof.
- The issue states the evidence required before renewed worker or reviewer dispatch can resume.
- The issue keeps excluded runtime, test, publication, and debug-capture surfaces explicit until a later child contract names them directly or replacement evidence retires them.

### Operator decision checklist

1. Restate the blocking evidence that forced decomposition, including the current candidate or diff reference plus the coupled protected surfaces.
2. Choose exactly one allowed outcome and cite proof:
   - **Split or retarget**: identify the scoped child title(s), requirement ID(s), and diff or surface-map proof showing the renewed candidate stays within those authorized surfaces.
   - **Widen child contract(s)**: name the widened child contract(s), newly authorized surface families or paths, and validation proof showing the broader scope is intentional and fully owned.
   - **Close or replace**: record why the blocked candidate will not resume, plus the superseding issue, branch, PR, or explicit closure record that replaces it.
3. Record what remains excluded after the choice, including runtime, publication, and debug-capture surfaces not yet authorized.
4. Confirm renewed worker or reviewer dispatch stays blocked until the cited proof is present and the dependency order or superseding replacement is stable.

## Contract Checklist

- Happy path: the decision freezes exactly one allowed outcome and lists the child titles, requirement IDs, or replacement reference it unblocks.
- Negative/error path: ambiguous or contradictory scope language is removed instead of leaving multiple incompatible repair paths open or allowing renewed dispatch without proof.
- Adjacent sibling surface: the decision keeps the tests-only proof slice and the protected runtime/publication slices distinct, even when a widened contract or replacement path is chosen.
- Empty/missing/stale/fallback state: the issue says what remains excluded and that the blocked non-dispatch state persists when no later child contract or replacement proof exists yet.
- Replay/restart/idempotency: repeated plan review points back to the same stable child titles, requirement IDs, or superseding replacement record.
- Credential/security boundary: no secret values, local absolute paths, or credential-bearing URLs appear in the planning notes.
- Side-effect verification: review the recorded proof bundle before renewed dispatch instead of inferring scope from a nearby PR diff.

## Validation Requirements

- Review `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md` and confirm the operator decision checklist lists all three allowed outcomes and the proof each one requires before redispatch.
- Review `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md` and confirm every later family depends on this title directly or transitively, or stays intentionally independent.
- Review `specs/009-eng-392-routing-reload-split/quickstart.md` and confirm excluded surfaces remain explicitly excluded until a later child contract authorizes them.

## Out Of Scope

- Implementing runtime, approval, or test repairs.
- Creating or applying Linear child issues directly.

## Promotion Readiness

- Ready for `dogfood-ready`: yes
- Remaining blocker: none
````

## Family B — `REQ-392-RUNTIME-ROUTING`

- Suggested child title: `ENG-392 child — runtime routing repair`
- Dependency order: **2 of 6**
- Declare dependency on: `ENG-392 child — decision and scope lock`
- Authorized surfaces to list in `Touched Surfaces`:
  - `src/core/orchestrator/Orchestrator.ts`
  - `src/core/config/ProjectContexts.ts`
  - `src/core/config/ProjectContextServiceConfig.ts`
  - `src/core/workspace/WorkspaceManager.ts`
  - `src/app/http.ts`
  - `cursor/src/CursorWorkspaceOpener.ts`
  - `tests/orchestrator.test.ts`
  - `tests/status-api.test.ts`
  - `tests/cursor-workspace-opener.test.ts`

````markdown
## Problem / Goal

Repair the routed runtime path so two different Linear project contexts resolve to distinct issue, workspace, and lifecycle buckets instead of sharing a default bucket or reusing the wrong routed workspace.

## Issue Contract

```json
{"schemaVersion":1,"contractVersion":"2026-06-14.1","requirements":[{"id":"REQ-392-RUNTIME-ROUTING","requirement":"Routed worker, reviewer, and open-workspace flows must keep project-context-qualified issue lookup, workspace identity, and lifecycle state distinct so two Linear project contexts never share a workspace or state bucket by accident.","proofHint":"Cite focused orchestrator, status, or workspace-opening evidence that shows distinct projectContext-qualified workspace keys and fail-closed handling for wrong-context or ambiguous routes."}]}
```

## Touched Surfaces

- [X] Runtime harness/transcript mapping
- [X] Lifecycle/persistence/replay
- [X] API/projection
- src/core/orchestrator/Orchestrator.ts
- src/core/config/ProjectContexts.ts
- src/core/config/ProjectContextServiceConfig.ts
- src/core/workspace/WorkspaceManager.ts
- src/app/http.ts
- cursor/src/CursorWorkspaceOpener.ts
- tests/orchestrator.test.ts
- tests/status-api.test.ts
- tests/cursor-workspace-opener.test.ts

## Acceptance Criteria

- Distinct project contexts produce distinct routed workspace and lifecycle identities.
- Wrong-context, ambiguous, or missing routes fail closed instead of reusing another context's workspace or state bucket.

## Contract Checklist

- Happy path: two valid project contexts route to separate workspace/state buckets.
- Negative/error path: wrong-context or ambiguous routing is rejected instead of silently falling back to another context.
- Adjacent sibling surface: routed open-workspace and status/readback views stay aligned with orchestrator dispatch identity.
- Empty/missing/stale/fallback state: legacy/default-context fallback stays explicit and does not overwrite non-default routed state.
- Replay/restart/idempotency: re-reading routed issue/workspace identity after restart yields the same project-context-qualified bucket.
- Credential/security boundary: public route evidence cites only safe identifiers and sanitized project-context metadata.
- Side-effect verification: validate emitted workspace keys, project-context identifiers, and routed state buckets rather than inferring behavior from helper names.

## Validation Requirements

- `npm test -- tests/orchestrator.test.ts tests/status-api.test.ts tests/cursor-workspace-opener.test.ts`
- Manual or API inspection that the routed issue and workspace identity differ across at least two project contexts without sharing one bucket.

## Out Of Scope

- Pending-publication approval recovery.
- Final publication-hygiene cleanup.

## Promotion Readiness

- Ready for `dogfood-ready`: no
- Remaining blocker: Manual operator review required because this child authorizes protected routing and workspace surfaces in `src/core/orchestrator/Orchestrator.ts`, `src/core/workspace/WorkspaceManager.ts`, `src/app/http.ts`, and `cursor/src/CursorWorkspaceOpener.ts`.
````

## Family C — `REQ-392-RELOAD-PRESERVATION`

- Suggested child title: `ENG-392 child — reload preservation repair`
- Dependency order: **3 of 6**
- Declare dependency on: `ENG-392 child — runtime routing repair`
- Authorized surfaces to list in `Touched Surfaces`:
  - `src/core/orchestrator/Orchestrator.ts`
  - `src/core/workspace/WorkspaceManager.ts`
  - `src/core/persistence/RunTranscriptStore.ts`
  - `src/core/types.ts`
  - `tests/orchestrator.test.ts`
  - `tests/status-api.test.ts`

````markdown
## Problem / Goal

Preserve the in-progress routed worker or reviewer context across config reload so the same project-context-qualified workspace, prompt identity, and lifecycle state survive restart without duplicate dispatch or bucket drift.

## Issue Contract

```json
{"schemaVersion":1,"contractVersion":"2026-06-14.1","requirements":[{"id":"REQ-392-RELOAD-PRESERVATION","requirement":"Config reload and restart handling must preserve an already-running routed worker or reviewer context with the same project-context-qualified workspace identity, lifecycle bucket, and non-redispatch invariants.","proofHint":"Cite orchestrator evidence for pre-reload and post-reload workspace identity, lifecycle state, and the absence of duplicate redispatch or incomplete-turn burn while the preserved run remains active."}]}
```

## Touched Surfaces

- [X] Runtime harness/transcript mapping
- [X] Lifecycle/persistence/replay
- [X] Config/workflow prompt
- src/core/orchestrator/Orchestrator.ts
- src/core/workspace/WorkspaceManager.ts
- src/core/persistence/RunTranscriptStore.ts
- src/core/types.ts
- tests/orchestrator.test.ts
- tests/status-api.test.ts

## Acceptance Criteria

- Reload or restart preserves the in-progress routed run with the same workspace and lifecycle identity.
- Preservation does not redispatch a second run, burn incomplete-turn counters, or discard the routed prompt/context while the original run is still intentional.

## Contract Checklist

- Happy path: an active routed run survives reload with the same workspace and lifecycle identity.
- Negative/error path: stale, missing, or terminal runs do not get falsely treated as preservable in-progress contexts.
- Adjacent sibling surface: reviewer and worker routed contexts follow the same preservation rule instead of diverging.
- Empty/missing/stale/fallback state: missing persistence falls back safely without reusing another issue's active context.
- Replay/restart/idempotency: repeated reloads preserve the same active routed context instead of spawning duplicates.
- Credential/security boundary: proof cites run IDs, workspace keys, and lifecycle fields, not secret prompt bodies or credential values.
- Side-effect verification: check run state, transcript/lifecycle evidence, and redispatch counters directly instead of assuming preservation from restart code paths.

## Validation Requirements

- `npm test -- tests/orchestrator.test.ts tests/status-api.test.ts`
- Manual or API inspection that reload leaves the active routed run in one preserved bucket and does not create a duplicate run.

## Out Of Scope

- Creating the final cross-context proof scenario after the runtime invariants are fixed.
- Approval-terminal writeback repair.

## Promotion Readiness

- Ready for `dogfood-ready`: no
- Remaining blocker: Manual operator review required because this child changes protected orchestrator and persistence surfaces that preserve active routed run state across reload.
````

## Family D — `REQ-392-APPROVAL-WRITEBACK`

- Suggested child title: `ENG-392 child — approval writeback repair`
- Dependency order: **4 of 6**
- Declare dependency on: `ENG-392 child — runtime routing repair`, `ENG-392 child — reload preservation repair`
- Authorized surfaces to list in `Touched Surfaces`:
  - `src/core/orchestrator/Orchestrator.ts`
  - `src/core/CompletionReportService.ts`
  - `src/core/approval/OperatorApprovalService.ts`
  - `src/core/writeback/WritebackOutbox.ts`
  - `src/app/http.ts`
  - `tests/orchestrator.test.ts`
  - `tests/completion-report-service.test.ts`
  - `tests/operator-approval-service.test.ts`
  - `tests/approval-status-api.test.ts`
  - `tests/status-api.test.ts`

````markdown
## Problem / Goal

Repair the pending-publication approval and writeback path so routed runtime identity, approval wait state, writeback audit records, and after-worker-exit recovery stay aligned without duplicate publication or redispatch.

## Issue Contract

```json
{"schemaVersion":1,"contractVersion":"2026-06-14.1","requirements":[{"id":"REQ-392-APPROVAL-WRITEBACK","requirement":"Pending-publication approval, terminal approval replay, and writeback recovery must preserve routed project-context identity, durable audit state, and no-redispatch invariants across live waits, worker exit, and orchestrator resume paths.","proofHint":"Cite approval, completion-report, orchestrator, or status evidence for pending, approved, rejected, cancelled, replayed, and after-worker-exit recovery cases, including lifecycle state and durable writeback outcomes."}]}
```

## Touched Surfaces

- [X] Lifecycle/persistence/replay
- [X] Writeback/tracker
- [X] Publication/GitHub/merge gate
- [X] API/projection
- src/core/orchestrator/Orchestrator.ts
- src/core/CompletionReportService.ts
- src/core/approval/OperatorApprovalService.ts
- src/core/writeback/WritebackOutbox.ts
- src/app/http.ts
- tests/orchestrator.test.ts
- tests/completion-report-service.test.ts
- tests/operator-approval-service.test.ts
- tests/approval-status-api.test.ts
- tests/status-api.test.ts

## Acceptance Criteria

- Pending, approved, rejected, cancelled, and replayed approval paths keep the correct routed lifecycle state and durable writeback records.
- Intentional pending-approval or blocked states do not redispatch worker/reviewer runs or lose publication-handoff audit data after reload or worker exit.

## Contract Checklist

- Happy path: routed pending approval resumes or finalizes with the expected writeback and lifecycle state.
- Negative/error path: rejected, cancelled, stale, expired, or already-terminal approvals stay distinguishable and do not trigger duplicate publication.
- Adjacent sibling surface: HTTP approval routes, completion-report handoff, and writeback outbox agree on the same approval identity and terminal result.
- Empty/missing/stale/fallback state: missing run links or unsettled audit operations remain blocked instead of being treated as complete.
- Replay/restart/idempotency: replaying an approval or reprocessing the same writeback does not create duplicate terminalization or redispatch.
- Credential/security boundary: validation cites public-safe run, approval, writeback, and PR metadata without leaking tokens or private repository credentials.
- Side-effect verification: inspect lifecycle fields, transcript events, and durable writeback results rather than assuming success from enqueue intent.

## Validation Requirements

- `npm test -- tests/orchestrator.test.ts tests/completion-report-service.test.ts tests/operator-approval-service.test.ts tests/approval-status-api.test.ts tests/status-api.test.ts`
- Manual or API inspection that pending approval and after-worker-exit resume keep one routed lifecycle record and one durable approval/writeback trail.

## Out Of Scope

- General repository publishing policy changes unrelated to ENG-392.
- Docs-only cleanup that can happen after the runtime and approval repair lands.

## Promotion Readiness

- Ready for `dogfood-ready`: no
- Remaining blocker: Manual operator review required because this child authorizes protected completion-report, approval, writeback, and publication-recovery surfaces.
````

## Family E — `REQ-392-TEST-PROOF`

- Suggested child title: `ENG-392 child — orchestrator proof`
- Dependency order: **5 of 6**
- Declare dependency on: `ENG-392 child — runtime routing repair`, `ENG-392 child — reload preservation repair`, `ENG-392 child — approval writeback repair`
- Authorized surfaces to list in `Touched Surfaces`:
  - `tests/orchestrator.test.ts`

````markdown
## Problem / Goal

Add the focused orchestrator proof for ENG-392 after the runtime siblings land so the published evidence shows both cross-project routing isolation and in-progress reload preservation in the single contract-scoped test surface.

## Issue Contract

```json
{"schemaVersion":1,"contractVersion":"2026-06-14.1","requirements":[{"id":"REQ-392-TEST-PROOF","requirement":"Focused orchestrator coverage must prove that at least two Linear project contexts route to distinct workspaces or lifecycle buckets and that an already-running routed context survives config reload without duplicate redispatch or identity drift.","proofHint":"Cite the focused orchestrator scenarios and the specific workspace, project-context, run-state, or redispatch assertions they add."}]}
```

## Touched Surfaces

- [X] Runtime harness/transcript mapping
- tests/orchestrator.test.ts

## Acceptance Criteria

- One focused proof path demonstrates distinct routed workspace/state buckets across at least two project contexts.
- One focused proof path demonstrates reload preservation for an already-running routed context without duplicate redispatch or state drift.

## Contract Checklist

- Happy path: the new orchestrator proof passes with the intended routed runtime behavior present.
- Negative/error path: wrong-context or duplicate-dispatch regressions fail the proof instead of remaining implicit.
- Adjacent sibling surface: the test stays contract-scoped to `tests/orchestrator.test.ts` while relying on runtime siblings for implementation.
- Empty/missing/stale/fallback state: the proof distinguishes preserved active state from missing or terminal state.
- Replay/restart/idempotency: rerunning the same proof still shows one preserved routed context and stable bucket identity.
- Credential/security boundary: assertions use safe identifiers and route metadata, not raw prompt bodies or credential values.
- Side-effect verification: the test checks emitted workspace/lifecycle/run assertions directly instead of inferring preservation from unrelated helpers.

## Validation Requirements

- `npm test -- tests/orchestrator.test.ts`
- Review the new assertions and confirm they cite routed workspace identity plus non-redispatch behavior explicitly.

## Out Of Scope

- Runtime implementation changes outside the test file.
- Publication or quickstart cleanup.

## Promotion Readiness

- Ready for `dogfood-ready`: yes
- Remaining blocker: none
````

## Family F — `REQ-392-PUBLICATION-HYGIENE`

- Suggested child title: `ENG-392 child — publication hygiene closure`
- Dependency order: **6 of 6**
- Declare dependency on: `ENG-392 child — decision and scope lock`, `ENG-392 child — orchestrator proof`, `ENG-392 child — approval writeback repair`
- Authorized surfaces to list in `Touched Surfaces`:
  - `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md`
  - `specs/009-eng-392-routing-reload-split/quickstart.md`
  - `tmp-debug-*/**`

````markdown
## Problem / Goal

Close the ENG-392 decomposition loop by keeping the final publication and evidence surface aligned with the declared child scopes, removing stray non-fixture debug captures, and documenting the exact proof paths reviewers should rely on.

## Issue Contract

```json
{"schemaVersion":1,"contractVersion":"2026-06-14.1","requirements":[{"id":"REQ-392-PUBLICATION-HYGIENE","requirement":"The final ENG-392 follow-up must keep the published diff and evidence packet limited to the authorized child surfaces, remove stray non-fixture debug captures, and document the proof paths that justify the final contract-scoped publication surface.","proofHint":"Cite the final file list, any removed tmp-debug paths, and the quickstart or child-contract references that explain why the remaining surfaces are authorized."}]}
```

## Touched Surfaces

- [X] Docs only
- specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md
- specs/009-eng-392-routing-reload-split/quickstart.md
- tmp-debug-*/**

## Acceptance Criteria

- The final evidence packet points reviewers to the approved child scopes and removes stray non-fixture debug artifacts.
- Publication-facing notes explain why the remaining diff surface is contract-scoped instead of repeating the original mismatch.

## Contract Checklist

- Happy path: the final diff contains only the authorized proof, planning, or cleanup surfaces for the child set.
- Negative/error path: stray debug captures or unauthorized runtime paths block closure instead of being waved through as incidental.
- Adjacent sibling surface: the quickstart evidence stays aligned with the proof and approval siblings that actually landed.
- Empty/missing/stale/fallback state: if a sibling child is still unfinished, the publication-hygiene issue says so instead of claiming closure.
- Replay/restart/idempotency: rerunning the hygiene review yields the same authorized file list and zero stray debug captures.
- Credential/security boundary: the evidence packet records only repo-relative paths and public-safe notes.
- Side-effect verification: review the file list and quickstart references directly rather than assuming the published diff is clean.

## Validation Requirements

- `git diff --name-only origin/main...HEAD`
- `git status --short -- tmp-debug-*`
- Review `specs/009-eng-392-routing-reload-split/quickstart.md` and `specs/009-eng-392-routing-reload-split/contracts/child-issue-contracts.md` for the final authorized-surface explanation.

## Out Of Scope

- Reopening the runtime or approval repair once those child issues are already accepted.
- Editing vendored Hermes source.

## Promotion Readiness

- Ready for `dogfood-ready`: yes
- Remaining blocker: none
````

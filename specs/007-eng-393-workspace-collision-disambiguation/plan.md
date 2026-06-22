# Implementation Plan: ENG-393 Workspace Collision Disambiguation

**Branch**: `[007-eng-393-workspace-collision-disambiguation]` | **Date**: 2026-06-11 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/007-eng-393-workspace-collision-disambiguation/spec.md`

## Summary

Complete ENG-393 by making workspace identity, branch fallback, branch-template safety, legacy workspace compatibility, and exact-id readback explicitly context-aware. The plan decomposes the repeated review findings into separate contracts so duplicate visible issue identifiers across project contexts cannot collide in workspace keys, paths, branches, status pointers, summaries, cleanup, or continuation records.

## Technical Context

**Language/Version**: TypeScript 6.x on Node.js ES2022/NodeNext.

**Primary Dependencies**: Existing workspace, git worktree, persistence, and test dependencies only. No new runtime package is planned.

**Storage**: File-backed workspace records, run transcripts, lifecycle records, continuation summaries, status pointers, and any projection aliases that refer to workspaces or issues. No database migration is assumed for this issue unless later planning finds a projection collision that cannot be solved at read/write boundaries.

**Testing**: Focused `vitest` suites through `npm test`, primarily `tests/git-worktree.test.ts`, `tests/workspace.test.ts`, `tests/transcript-store.test.ts`, `tests/transcript-replay.test.ts`, `tests/status-api.test.ts`, and `tests/web-projection-context.test.ts`.

**Target Platform**: Windows local development with PowerShell paths and Git worktree paths; branch names must remain portable across supported Git remotes.

**Project Type**: Local orchestration service with workspace management, Git worktree management, run transcript persistence, status APIs, and web/status projections.

**Performance Goals**: Workspace identity and branch safety decisions should remain local and deterministic. Collision checks must not scan unrelated repositories once the exact issue/context key is known.

**Constraints**: Visible issue identifiers can duplicate across contexts and must not be used alone as durable identity. Branch-safety caches must not reuse a decision across different issue identities. Legacy artifacts must remain readable and must not be silently deleted or overwritten.

**Scale/Scope**: At least two project contexts with duplicate visible issue identifiers, null tracker branch metadata, and configured branch-template fallback. Covers both new workspace creation and legacy readback.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. Service-Owned Authority Boundaries**: PASS. Symphony owns workspace identity, branch fallback, cleanup, status pointer resolution, and readback. Agents must not manually rename or delete workspaces to fix collisions.
- **II. Least-Privilege Credentials And Secret Hygiene**: PASS. Workspace and branch metadata may include non-secret context ids and issue identifiers but must not include credential values or secret-backed routing material.
- **III. Testable Contracts Before Implementation**: PASS. The spec defines user stories, acceptance scenarios, edge cases, and measurable outcomes. Child issues must include fenced JSON contracts for every collision boundary before delegation.
- **IV. Durable Audit, Replay, And Idempotence**: PASS. Workspace creation, reuse, cleanup, readback, and branch fallback must leave durable evidence of exact issue identity and context so replay does not re-route by visible identifier alone.
- **V. Scoped Change Ownership And Protected Surfaces**: PASS. Work stays in Symphony-owned workspace, git, persistence, status/projection, and tests. Vendored source and operator-controlled dirty workspaces are out of scope.

Pre-design gate result: PASS, no constitution violations.

Post-design gate result: PASS, no constitution violations. Phase 1 artifacts require exact issue identity for workspace and branch decisions, and require legacy compatibility rather than destructive cleanup.

## Project Structure

### Documentation (this feature)

```text
specs/007-eng-393-workspace-collision-disambiguation/
- spec.md
- plan.md
- research.md
- data-model.md
- quickstart.md
- contracts/
  - workspace-identity.md
  - branch-fallback-safety.md
- checklists/
  - requirements.md
```

### Source Code (repository root)

```text
src/
- core/
  - workspace/
    - WorkspaceManager.ts
    - GitWorktreeManager.ts
  - persistence/
    - RunTranscriptStore.ts
    - IssueLifecycleStore.ts
  - orchestrator/
    - Orchestrator.ts
  - types.ts
- app/
  - http.ts
  - webProjection.ts
  - WebProjectionContext.ts

tests/
- git-worktree.test.ts
- workspace.test.ts
- transcript-store.test.ts
- transcript-replay.test.ts
- status-api.test.ts
- web-projection-context.test.ts
- issue-contract-lint.test.ts
```

**Structure Decision**: Use exact issue identity plus project context as the durable discriminator for workspace keys, workspace paths, branch fallback inputs, status pointers, and summary/readback aliases. Keep legacy readback explicit instead of destructively renaming or deleting existing artifacts during normal operation.

## Complexity Tracking

No constitution-driven complexity exceptions are recorded.

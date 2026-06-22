# Implementation Plan: ENG-443 Legacy Backfill Resolution

**Branch**: `[008-eng-443-legacy-backfill-resolution]` | **Date**: 2026-06-11 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/008-eng-443-legacy-backfill-resolution/spec.md`

## Summary

Resolve ENG-443 by proving whether current `main` already satisfies legacy run/workspace project-context backfill on read, then either closing/retargeting the no-op pull request with evidence or implementing only a demonstrated missing legacy-read path. The plan makes no-op resolution an explicit outcome so the parent issue stops cycling through review without a meaningful diff.

## Technical Context

**Language/Version**: TypeScript 6.x on Node.js ES2022/NodeNext.

**Primary Dependencies**: Existing persistence, projection, workflow config, and test dependencies only. No new runtime package is planned.

**Storage**: File-backed run transcripts, workspace records, historical lifecycle evidence, and web/projection readback. Existing PostgreSQL projection behavior may be validated if current-main evidence shows the gap is database-specific.

**Testing**: Focused `vitest` suites through `npm test`, primarily `tests/transcript-store.test.ts`, `tests/transcript-replay.test.ts`, `tests/workspace.test.ts`, `tests/web-history-projection.test.ts`, `tests/web-transcript-projection.test.ts`, and `tests/web-projection-context.test.ts`.

**Target Platform**: Windows local development and existing persisted file formats from prior Symphony runs.

**Project Type**: Local orchestration service with run transcript persistence, workspace persistence, historical readback, and web/status projections.

**Performance Goals**: Read-time legacy backfill should be local and should not rewrite historical records during normal reads.

**Constraints**: Do not merge a behaviorally empty pull request as the issue resolution. Do not expose credentials in default or legacy project-context metadata. Preserve historical readability. Do not destructively migrate operator-controlled records without a separate plan.

**Scale/Scope**: Legacy records lacking project-context metadata for run and workspace readback. This plan does not cover broad multi-project persistence migration unless a failing read path proves it is required.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. Service-Owned Authority Boundaries**: PASS. Symphony owns historical readback, issue evidence, pull-request publication state, and tracker writeback. Worker agents must not merge, close, or mutate issue lifecycle directly.
- **II. Least-Privilege Credentials And Secret Hygiene**: PASS. Backfilled context metadata must use non-secret default or legacy attribution and must not expose credential profile values, tokens, private keys, or raw environment values.
- **III. Testable Contracts Before Implementation**: PASS. The spec defines acceptance scenarios for current-main proof, missing-path implementation, no-op rejection, and child issue contracts.
- **IV. Durable Audit, Replay, And Idempotence**: PASS. The plan requires evidence that distinguishes current-main proof, failing-before behavior, passing-after behavior, and no-op PR disposition.
- **V. Scoped Change Ownership And Protected Surfaces**: PASS. Work stays in persistence/readback/projection/test surfaces and issue evidence. Vendored source, operator secrets, and unrelated workflow state are out of scope.

Pre-design gate result: PASS, no constitution violations.

Post-design gate result: PASS, no constitution violations. Phase 1 artifacts require a base-behavior decision before implementation and avoid destructive historical migration.

## Project Structure

### Documentation (this feature)

```text
specs/008-eng-443-legacy-backfill-resolution/
- spec.md
- plan.md
- research.md
- data-model.md
- quickstart.md
- contracts/
  - legacy-backfill-readback.md
  - no-op-pr-disposition.md
- checklists/
  - requirements.md
```

### Source Code (repository root)

```text
src/
- core/
  - persistence/
    - RunTranscriptStore.ts
  - workspace/
    - WorkspaceManager.ts
  - config/
    - ProjectContexts.ts
  - types.ts
- app/
  - webProjection.ts
  - WebHistoryProjection.ts
  - WebTranscriptProjection.ts
  - WebProjectionContext.ts

tests/
- transcript-store.test.ts
- transcript-replay.test.ts
- workspace.test.ts
- web-history-projection.test.ts
- web-transcript-projection.test.ts
- web-projection-context.test.ts
- issue-contract-lint.test.ts
```

**Structure Decision**: Treat ENG-443 as a resolution-first plan. The first child task should prove whether current `main` satisfies the issue contract. Implementation tasks are created only for a failing legacy-read path, not for an empty PR.

## Complexity Tracking

No constitution-driven complexity exceptions are recorded.

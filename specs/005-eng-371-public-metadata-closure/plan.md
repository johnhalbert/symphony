# Implementation Plan: ENG-371 Public Metadata Redaction Closure

**Branch**: `[005-eng-371-public-metadata-closure]` | **Date**: 2026-06-11 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/005-eng-371-public-metadata-closure/spec.md`

## Summary

Close ENG-371 by preserving a single, service-owned public project-context metadata contract that redacts all credential-bearing values, proves the discovered repository-value edge cases, and separates any merge-gate conflict repair from new behavior. The implementation should keep public metadata safe for prompts, logs, summaries, transcripts, projections, and issue comments while attaching enough validation evidence for the parent issue to leave its blocked state without another broad review loop.

## Technical Context

**Language/Version**: TypeScript 6.x on Node.js ES2022/NodeNext.

**Primary Dependencies**: Existing configuration, validation, YAML, and test dependencies only. No new runtime package is planned.

**Storage**: Workflow configuration and durable evidence surfaces that may render public context metadata. No database migration is expected.

**Testing**: Focused `vitest` suites through `npm test`, primarily `tests/workflow.test.ts`, `tests/doctor.test.ts`, `tests/credential-profiles.test.ts`, and any existing redaction coverage that exercises project context metadata.

**Target Platform**: Windows local development with PowerShell paths, plus POSIX-like runtime paths where harnesses or repositories expose them.

**Project Type**: Local orchestration service with configuration parsing, credential profile resolution, tracker/GitHub/runtime handoff metadata, durable records, and web/status projections.

**Performance Goals**: Public metadata creation should remain a local in-memory operation with no tracker, GitHub, runtime, or provider calls.

**Constraints**: Never expose tokens, private keys, raw credential profile values, raw environment values, or repository credentials. Preserve operator-diagnostic identifiers that are safe to display. Do not expand ENG-371 beyond redaction proof and merge-gate closure unless a redaction gap still reproduces on current base.

**Scale/Scope**: One parent issue closure plan that can split into redaction-proof and merge-gate repair children. This plan does not introduce new project-context configuration semantics beyond safe public metadata.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. Service-Owned Authority Boundaries**: PASS. Public metadata policy and merge-gate state remain Symphony-owned service concerns. Worker or reviewer agents can provide code and evidence, but they cannot choose tracker state, merge the PR, or bypass service-owned writeback.
- **II. Least-Privilege Credentials And Secret Hygiene**: PASS. The whole feature is a secret-hygiene boundary. The plan requires redaction for credential profile values, environment values, tokens, private keys, repository user-info, and ambiguous source values.
- **III. Testable Contracts Before Implementation**: PASS. The spec defines prioritized stories, acceptance scenarios, measurable outcomes, edge cases, and issue-contract obligations. Child issues must include fenced JSON contracts before delegation.
- **IV. Durable Audit, Replay, And Idempotence**: PASS. Completion evidence must record the redaction matrix and whether the final ENG-371 change is behavior-changing or conflict-only repair.
- **V. Scoped Change Ownership And Protected Surfaces**: PASS. Work stays in Symphony-owned configuration/redaction surfaces, validation tests, and issue evidence. Vendored source, operator secrets, and unrelated workflow state are out of scope.

Pre-design gate result: PASS, no constitution violations.

Post-design gate result: PASS, no constitution violations. Phase 1 artifacts keep redaction behavior centralized, require synthetic fixtures, and preserve service-owned merge-gate authority.

## Project Structure

### Documentation (this feature)

```text
specs/005-eng-371-public-metadata-closure/
- spec.md
- plan.md
- research.md
- data-model.md
- quickstart.md
- contracts/
  - public-metadata-redaction.md
- checklists/
  - requirements.md
```

### Source Code (repository root)

```text
src/
- core/
  - config/
    - ProjectContexts.ts
    - Config.ts
    - CredentialProfiles.ts
  - persistence/
    - RunTranscriptStore.ts
  - orchestrator/
    - Orchestrator.ts
  - types.ts
- app/
  - http.ts
  - webProjection.ts

tests/
- workflow.test.ts
- doctor.test.ts
- credential-profiles.test.ts
- transcript-store.test.ts
- web-projection-context.test.ts
- issue-contract-lint.test.ts
```

**Structure Decision**: Keep redaction as a shared configuration/public-metadata contract consumed by existing orchestration, persistence, and projection surfaces. Do not add a second metadata shape for merge-gate repair; merge-gate work should only resolve conflicts while preserving this contract.

## Complexity Tracking

No constitution-driven complexity exceptions are recorded.

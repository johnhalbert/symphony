# Implementation Plan: ENG-392 Routing Reload Decomposition

**Branch**: `main` | **Date**: 2026-06-14 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/009-eng-392-routing-reload-split/spec.md`

## Summary

Resolve blocked ENG-392 by decomposing the original test-only routing/reload proof from the broader runtime, approval/writeback, publication hygiene, and adjacent-surface concerns raised in Linear review comments. The plan uses Symphony's existing issue breakdown, issue contract linting, writeback, and orchestrator validation surfaces to produce child issue contracts before any renewed implementation or publication work.

## Technical Context

**Language/Version**: TypeScript 6.x on Node.js ES2022/NodeNext.

**Primary Dependencies**: Existing Symphony runtime, issue breakdown, tracker writeback, orchestration, persistence, approval, workspace, cursor, and test dependencies. No new runtime package is planned.

**Storage**: File-backed run transcripts, issue lifecycle records, writeback outbox state, workspace records, issue breakdown plan records, and redacted validation evidence. Existing PostgreSQL-backed projections are out of scope unless a child issue explicitly expands status/projection behavior.

**Testing**: Focused `vitest` suites through `npm test`, primarily `tests/issue-contract-lint.test.ts`, `tests/orchestrator.test.ts`, `tests/status-api.test.ts`, and `tests/cursor-workspace-opener.test.ts` when a child contract authorizes those surfaces.

**Target Platform**: Windows local development with PowerShell paths, Git worktrees, local file state, Linear tracker work, and GitHub publication/review surfaces controlled by Symphony.

**Project Type**: Local orchestration service with tracker-driven issue breakdown, worker/reviewer dispatch, durable run and lifecycle state, publication approval, writeback, status APIs, and editor workspace opening.

**Performance Goals**: Decomposition and contract checks should remain local and deterministic. Focused validation should finish in the same order of magnitude as the existing issue-contract and orchestrator test suites, and should not require live Linear or GitHub round trips unless a child contract explicitly opts in.

**Constraints**: Do not re-dispatch ENG-392 as-is while the contract/publication mismatch remains unresolved. Do not silently widen a test-only issue. Do not publish runtime, status, workspace, cursor, or debug-artifact surfaces unless the active child issue contract authorizes them. Do not store or expose credentials, secret-backed profile values, or unnecessary local absolute paths in evidence.

**Scale/Scope**: One blocked parent issue, one original test-proof obligation, and a bounded set of child concerns: operator decision, narrow routing/reload test proof, runtime routing prerequisites, reload/redispatch preservation, approval/writeback recovery, and publication hygiene. Broader multi-project configuration work remains governed by its existing feature artifacts and Linear contracts.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. Service-Owned Authority Boundaries**: PASS. Symphony owns issue breakdown plan acceptance, child issue writeback, tracker lifecycle writeback, publication, review writeback, and merge gates. Workers and reviewers may propose evidence or child contracts but must not close, merge, publish, or silently widen ENG-392 outside service-owned paths.
- **II. Least-Privilege Credentials And Secret Hygiene**: PASS. The plan requires redacted validation evidence and excludes credential values, secret-backed profiles, private keys, and unnecessary local absolute paths from comments, fixtures, transcripts, and Spec Kit artifacts.
- **III. Testable Contracts Before Implementation**: PASS. The spec defines prioritized stories, acceptance scenarios, measurable success criteria, and child issue-contract source obligations. Every generated or delegated child issue must include a fenced `json` issue contract with stable requirement IDs before worker dispatch or promotion.
- **IV. Durable Audit, Replay, And Idempotence**: PASS. The plan requires a recorded operator decision, contract-to-surface comparison, dependency map, contradiction proof when applicable, validation evidence, and writeback idempotency through existing issue breakdown and writeback records.
- **V. Scoped Change Ownership And Protected Surfaces**: PASS. The plan keeps vendored upstream source out of scope and treats orchestration, approval recovery, writeback, workspace, cursor, status, tracker writeback, and debug artifacts as protected surfaces that require explicit child-contract coverage.

Pre-design gate result: PASS, no constitution violations.

Post-design gate result: PASS, no constitution violations. Phase 1 artifacts require child contracts before implementation, preserve service-owned authority, and keep publication hygiene as a separate gate.

## Project Structure

### Documentation (this feature)

```text
specs/009-eng-392-routing-reload-split/
- spec.md
- plan.md
- research.md
- data-model.md
- quickstart.md
- contracts/
  - child-issue-contracts.md
  - publication-surface-gate.md
  - validation-evidence.md
- checklists/
  - requirements.md
```

### Source Code (repository root)

```text
src/
- core/
  - IssueBreakdownPlanService.ts
  - IssueBreakdownPlanApplyService.ts
  - IssueContractLint.ts
  - orchestrator/
    - Orchestrator.ts
  - CompletionReportService.ts
  - approval/
    - OperatorApprovalService.ts
  - writeback/
    - WritebackOutbox.ts
  - workspace/
    - WorkspaceManager.ts
  - config/
    - Config.ts
- app/
  - http.ts
  - WorkspaceOpener.ts
cursor/
- src/
  - CursorWorkspaceOpener.ts

tests/
- issue-contract-lint.test.ts
- orchestrator.test.ts
- status-api.test.ts
- cursor-workspace-opener.test.ts
```

**Structure Decision**: Treat ENG-392 as a decomposition-first planning record. The first implementation phase should create or apply child issue contracts through Symphony-owned issue breakdown/writeback paths. Runtime code or test changes should proceed only under the child contract that authorizes the touched surface.

## Complexity Tracking

No constitution-driven complexity exceptions are recorded.

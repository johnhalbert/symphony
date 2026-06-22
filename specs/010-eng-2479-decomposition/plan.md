# Implementation Plan: ENG-2479 Runtime Child Preflight Decomposition

**Branch**: `010-eng-2479-decomposition` | **Date**: 2026-06-16 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/010-eng-2479-decomposition/spec.md`

## Summary

Prepare a Spec Kit driven decomposition plan for blocked Linear issue ENG-2479 without performing live Linear issue creation during planning. The plan turns the current blocked review evidence into four Linear-ready child issue bodies: proof matrix, service-owned preflight execution path, focused preflight evidence, and parent review-unblock handoff. Later task generation and issue-sync work can apply these bodies through the project-owned flow.

## Technical Context

**Language/Version**: TypeScript 6.x on Node.js ES2022/NodeNext for the underlying Symphony service; this planning slice edits Markdown Spec Kit artifacts only.

**Primary Dependencies**: Existing Spec Kit templates and extension scripts, Symphony issue-contract governance, Linear issue body conventions, and current ENG-2479 / ENG-392 / ENG-351 / ENG-347 tracker context. No new runtime package is planned.

**Storage**: Spec Kit Markdown artifacts under `specs/010-eng-2479-decomposition/`; live Linear state remains external and must be changed only by a later authorized issue-sync or service-owned workflow.

**Testing**: Markdown review, fenced JSON contract validation by inspection and later `tests/issue-contract-lint.test.ts` coverage when issue bodies are synchronized or added to lint fixtures. No runtime tests are required for this planning-only phase.

**Target Platform**: Windows local development with PowerShell paths, Git worktree state, Spec Kit scripts, and Linear tracker context controlled through service-owned or explicit connector workflows.

**Project Type**: Local orchestration service planning record for tracker-driven issue decomposition.

**Performance Goals**: A reviewer should identify the next actor and required evidence for each prepared child body in under 5 minutes.

**Constraints**: Do not create, reopen, close, or mutate live Linear child issues during `/speckit-plan`. Do not move ENG-2479 out of Blocked. Do not authorize runtime implementation, publication, merge, protected branch updates, or vendored upstream changes. Do not include secrets, credential values, secret-backed profiles, customer-private data, or unnecessary local absolute paths in artifacts.

**Scale/Scope**: One blocked issue (`ENG-2479`), one parent chain (`ENG-2479 -> ENG-392 -> ENG-351 -> ENG-347`), four prepared child issue bodies, one parent handoff template, and one issue-sync gate.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. Service-Owned Authority Boundaries**: PASS. This plan prepares Markdown artifacts only. Live Linear child creation, tracker writeback, lifecycle transitions, worker/reviewer validation, publication, and merge remain service-owned or later explicit workflow actions. Workers and reviewers are not granted bypass paths.
- **II. Least-Privilege Credentials And Secret Hygiene**: PASS. The plan requires redacted issue descriptions and evidence, excludes credential values and secret-backed profile contents, and avoids unnecessary local absolute paths.
- **III. Testable Contracts Before Implementation**: PASS. The spec has prioritized user stories, acceptance scenarios, measurable outcomes, and issue-contract source obligations. Each prepared child body will include a fenced `json` Issue Contract with `schemaVersion`, `contractVersion`, and stable requirement IDs before any issue-sync or delegation.
- **IV. Durable Audit, Replay, And Idempotence**: PASS. The durable record is the Spec Kit artifact set: plan, research, data model, child-body contracts, sync gate, and quickstart. Live tracker changes are deferred until a later idempotent issue-sync path can re-check existing children and avoid duplicates.
- **V. Scoped Change Ownership And Protected Surfaces**: PASS. The plan touches only `specs/010-eng-2479-decomposition/**` and the managed Spec Kit pointer in `AGENTS.md`. It does not authorize runtime, status, workspace, cursor/editor, publication, protected branch, or vendored upstream changes.

Pre-design gate result: PASS, no constitution violations.

Post-design gate result: PASS, no constitution violations. Phase 1 artifacts keep live tracker mutation behind an explicit issue-sync gate, define fenced JSON contracts for prepared child bodies, and keep implementation surfaces out of scope.

## Project Structure

### Documentation (this feature)

```text
specs/010-eng-2479-decomposition/
- spec.md
- plan.md
- research.md
- data-model.md
- quickstart.md
- contracts/
  - child-issue-bodies.md
  - issue-sync-gate.md
  - parent-handoff.md
- checklists/
  - requirements.md
```

### Source Code (repository root)

```text
AGENTS.md

specs/
- 010-eng-2479-decomposition/

.specify/
- feature.json
- extensions/
  - agent-context/
  - git/
```

**Structure Decision**: Treat this as a planning-only Spec Kit feature. Runtime source and test files may be referenced as evidence context but are not implementation targets for this plan.

## Complexity Tracking

No constitution-driven complexity exceptions are recorded.

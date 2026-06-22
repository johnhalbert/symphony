# Implementation Plan: Symphony Owned Tracker

**Branch**: `004-symphony-owned-tracker` | **Date**: 2026-06-08 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/004-symphony-owned-tracker/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command. See `.specify/templates/plan-template.md` for the execution workflow.

## Summary

Introduce a Postgres-backed Symphony-owned tracker that can replace Linear for runtime issue reads and minimum writeback while keeping the existing Linear integration unchanged. The implementation keeps the current `TrackerClient` and `TrackerWriter` contracts as the runtime seam, adds authoritative native tracker storage for `Issue` and `IssueBlockerRef`, and refactors only the Linear-coupled factory, config, diagnostics, and merge-policy credential checks needed to select the new tracker.

## Technical Context

**Language/Version**: TypeScript 6.x, Node.js ES2022/NodeNext.

**Primary Dependencies**: Existing runtime dependencies: `pg` for Postgres access, `zod` for workflow/config validation, `commander` for CLI entrypoints, `vitest` for tests.

**Storage**: Configured Postgres datastore under the active `migrations/postgres` path. Existing file-backed lifecycle/writeback stores remain in place unless already used by the runtime; projection tables and projection rebuild behavior are out of scope.

**Testing**: Vitest unit/integration tests, TypeScript typecheck, migration validation through the existing migration runner, and targeted Postgres schema assertions.

**Target Platform**: Symphony CLI/orchestration service on Windows PowerShell and POSIX-like shells, with local and service-owned runtime operation.

**Project Type**: Node.js CLI/orchestration service with runtime harness, tracker integrations, writeback processing, status API, and optional Postgres persistence.

**Performance Goals**: Tracker polling and explicit issue refresh must remain bounded and suitable for the existing polling loop. Candidate/state queries should use indexed state and identifier lookups and avoid projection scans.

**Constraints**: Tight MVP scope; no projection-layer schema or projection rebuild changes; no vendored upstream changes; no migration/import from Linear; no worker-owned direct datastore mutation; unsupported optional issue creation/relation flows must fail closed.

**Scale/Scope**: MVP for replacing Linear in Symphony runtime issue selection and minimum writeback. Target hundreds to low thousands of tracker issues per workspace/project with state-filtered polling and point refreshes.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Evaluate each Symphony constitution principle for this feature. Mark every gate
PASS or FAIL and cite the plan evidence that supports the decision.

- **I. Service-Owned Authority Boundaries**: PASS. Tracker reads and mutations are owned by the Symphony service through `TrackerClient` and `TrackerWriter`. Workers/reviewers continue to receive issue context through prompts/MCP service paths and do not get a direct tracker datastore mutation path. Linear remains owned by the existing Linear integration when selected.
- **II. Least-Privilege Credentials And Secret Hygiene**: PASS. The native tracker uses the configured Postgres datastore capability and does not require Linear credentials. Datastore connection strings remain configuration/secret material and must not be copied into issue data, prompts, logs, transcripts, or diagnostics.
- **III. Testable Contracts Before Implementation**: PASS. The spec includes prioritized user stories, acceptance scenarios, success criteria, issue-contract obligations, and scope limits. This plan identifies touched runtime/config/tracker/persistence surfaces, and tasks must include regression tests before implementation tasks for each story.
- **IV. Durable Audit, Replay, And Idempotence**: PASS. State transitions and comments are stored with durable evidence and idempotency boundaries. Existing writeback outbox idempotency remains in use, while native tracker tables provide authoritative issue state, blockers, comments, and transition history for replay.
- **V. Scoped Change Ownership And Protected Surfaces**: PASS. Touched surfaces are limited to tracker integration, config/runtime construction, doctor/merge credential checks, Postgres migrations, and targeted tests. Projection-layer behavior, vendored source, generated templates, and unrelated dirty files are out of scope.

Pre-design gate result: PASS. No constitution violations are required for the MVP.

Post-design gate result: PASS. Phase 1 design preserves service-owned tracker writes, uses additive datastore changes, documents idempotency and unsupported optional flows, and leaves projections out of scope.

## Project Structure

### Documentation (this feature)

```text
specs/004-symphony-owned-tracker/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── tracker-provider-contract.md
└── tasks.md
```

### Source Code (repository root)

```text
migrations/postgres/
└── 0007_symphony_owned_tracker.sql

src/
├── app/
│   └── RuntimeDependencies.ts
├── core/
│   ├── config/
│   │   └── Config.ts
│   ├── merge/
│   │   └── MergePolicyService.ts
│   └── tracker/
│       ├── TrackerClient.ts
│       ├── TrackerWriter.ts
│       └── TrackerFactory.ts
├── doctor.ts
└── integrations/
    ├── linear/
    │   ├── LinearCredentialResolver.ts
    │   └── LinearTrackerClient.ts
    └── symphony/
        ├── SymphonyTrackerClient.ts
        └── SymphonyTrackerRepository.ts

tests/
├── symphony-tracker.test.ts
├── orchestrator.test.ts
├── writeback-outbox.test.ts
├── runtime-dependencies.test.ts
├── workflow.test.ts
├── doctor.test.ts
├── merge-policy-service.test.ts
└── postgres-schema.test.ts
```

**Structure Decision**: Use a small native tracker integration under `src/integrations/symphony` so Linear remains untouched and the provider switch lives at the existing runtime construction seam. Put shared provider selection in `src/core/tracker/TrackerFactory.ts` only if `RuntimeDependencies.ts` would otherwise accumulate provider-specific logic. Add schema through a new checksum-safe migration rather than editing published migrations.

## Complexity Tracking

No constitution violations or complexity exceptions are planned.

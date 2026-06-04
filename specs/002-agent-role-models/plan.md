# Implementation Plan: Configure Agent Role Models

**Branch**: `002-agent-role-models` | **Date**: 2026-06-04 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/002-agent-role-models/spec.md`

## Summary

Add a role-scoped model resolution contract so Symphony operators can configure independent model identifiers for orchestrator, worker, and reviewer responsibilities while preserving existing harness-level defaults. The implementation should introduce a shared resolver for non-secret `role_models` workflow configuration, feed resolved worker/reviewer models into Cursor and stable Hermes TUI/JSON-RPC role sessions before prompt submission, and record each role session's resolved model plus selection source in existing run metadata. Orchestrator chat uses the same resolver for service-owned orchestrator command/session metadata without granting runtime agents authority to choose their own model. Hermes ACP role-model wiring is planned as a blocked follow-up lane and must not be implemented until the underlying ACP feature work is complete and stable.

## Technical Context

**Language/Version**: TypeScript 6.x on Node.js ES2022/NodeNext for Symphony orchestration, harnesses, config parsing, web/status API, and tests.

**Primary Dependencies**: Existing runtime dependencies only: `@cursor/sdk`, `@modelcontextprotocol/sdk`, `commander`, `liquidjs`, `pg`, `yaml`, and `zod`. No new runtime dependency is planned.

**Storage**: Workflow YAML configuration; existing local run records/transcripts under `workspace.state_dir`; existing PostgreSQL run-session columns where Postgres projections are configured. No new database table is required because current run metadata already stores `runtimeModel`, `runtimeModelParams`, and `runtimeSettingSources`.

**Testing**: Root `vitest` suite via `npm test`; targeted tests under `tests/workflow.test.ts`, `tests/orchestrator.test.ts`, `tests/cursor-harness.test.ts`, `tests/hermes-harness.test.ts`, `tests/hermes-acp-harness.test.ts`, `tests/transcript-store.test.ts`, and web projection/API tests that expose run-session model metadata.

**Target Platform**: Local Windows development is first-class. Model identifiers are provider metadata and must work with Windows paths/env expansion in workflow config as well as POSIX-like runtime workspaces.

**Project Type**: Local orchestration service, CLI, runtime harness integration, MCP handoff, web status API, and VS Code/Cursor extension-facing projections.

**Performance Goals**: Role model resolution must be synchronous and effectively free compared with runtime startup. Target: config parsing and per-role model resolution under 5 ms, with no provider/network calls during ordinary config parsing.

**Constraints**: Preserve existing behavior when `role_models` is absent. Treat role model identifiers as non-secret metadata, but do not expose provider tokens, API keys, auth home contents, profile secrets, or environment values. Reject explicitly empty or malformed role model values. Confirm unavailable model errors before prompt/work is delegated to the affected role for implemented harnesses. Do not modify vendored Hermes source under `hermes/upstream-src/**`. Do not implement Hermes ACP role-model wiring until the ACP harness/session feature implementation is stable; represent that work as blocked/dependent tasks rather than mixing it into the first implementation slice.

**Scale/Scope**: Three first-class model roles for this feature: `orchestrator`, `worker`, and `reviewer`. Worker/reviewer coverage must work across supported runtime harnesses. Merge-conflict repair workers use the worker model unless a future feature adds a separate role.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. Service-Owned Authority Boundaries**: PASS. Symphony owns role model resolution and injects the resolved model into runtime/session creation. Workers and reviewers receive their assigned model through the service-owned harness path and cannot select or override their own model through prompts or command surfaces.
- **II. Least-Privilege Credentials And Secret Hygiene**: PASS. `role_models` stores only model identifiers. Provider credentials remain in existing secret-bearing credential/profile paths. Errors, run records, and docs must display model identifiers only and redact credential/profile values.
- **III. Testable Contracts Before Implementation**: PASS. The spec defines prioritized stories, acceptance scenarios, measurable outcomes, and validation scope. This plan identifies concrete config, harness, run-record, and API projection surfaces before task generation.
- **IV. Durable Audit, Replay, And Idempotence**: PASS. Started role sessions will persist the resolved model and whether it was explicit or defaulted in existing run metadata, with `runtimeSettingSources` preserving the selection source for replay and diagnostics.
- **V. Scoped Change Ownership And Protected Surfaces**: PASS. Work stays in Symphony-owned config, orchestrator, stable harness adapters, runtime profile/session wiring, tests, and documentation. Vendored Hermes source is read-only evidence and is not modified. Hermes ACP changes are explicitly gated behind ACP stabilization work and must not be advanced by this feature until that dependency is satisfied.

Pre-design gate result: PASS, no constitution violations.

Post-design gate result: PASS, no constitution violations. Phase 1 artifacts keep credential handling, run evidence, and protected-surface boundaries explicit.

## Project Structure

### Documentation (this feature)

```text
specs/002-agent-role-models/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── role-model-configuration.md
├── checklists/
│   └── requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
src/
├── core/
│   ├── config/
│   │   ├── Config.ts
│   │   └── [new role model resolution module]
│   ├── orchestrator/
│   │   ├── Orchestrator.ts
│   │   └── OrchestratorChatCommand.ts
│   ├── persistence/
│   │   ├── RunTranscriptStore.ts
│   │   └── OrchestratorConversationStore.ts
│   └── provider/
│       └── ProviderLimits.ts
├── app/
│   ├── webProjection.ts
│   ├── WebHistoryProjection.ts
│   └── WebTranscriptProjection.ts

cursor/
└── src/
    └── CursorHarness.ts

hermes/
└── src/
    ├── HermesHarness.ts
    ├── HermesAcpHarness.ts      # blocked follow-up only until ACP stabilization lands
    ├── HostHermesAcpProfileLease.ts
    └── HermesMcpConfig.ts

tests/
├── workflow.test.ts
├── orchestrator.test.ts
├── cursor-harness.test.ts
├── hermes-harness.test.ts
├── hermes-acp-harness.test.ts
├── transcript-store.test.ts
├── web-history-projection.test.ts
├── web-projection.test.ts
└── web-orchestrator-chat-api.test.ts
```

**Structure Decision**: Implement model selection as a Symphony-owned shared resolver used by config parsing, orchestrator run metadata, Cursor SDK options, and Hermes TUI/JSON-RPC gateway environment. Do not encode role-specific branching directly in each harness beyond passing a resolved model. Do not change vendored Hermes upstream code. Record Hermes ACP integration as a blocked follow-up task dependent on completion of the ACP harness/session feature, because ACP implementation is still in flight and should stabilize before role-model behavior is layered onto it.

## Complexity Tracking

No constitution-driven complexity exceptions are recorded. The shared resolver is justified by the need for consistent defaults, validation, and audit evidence across multiple runtime surfaces. Hermes ACP role-model support is a deferred dependency, not an accepted complexity exception for the initial implementation.

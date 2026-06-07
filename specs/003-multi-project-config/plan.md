# Implementation Plan: Multi-Project Configuration

**Branch**: `003-multi-project-config` | **Date**: 2026-06-07 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/003-multi-project-config/spec.md`

## Summary

Add a first-class project context model so one Symphony workflow can configure, poll, dispatch, review, write back, and display activity for multiple codebases and Linear projects at the same time. The implementation should normalize today's single-project `tracker`, `workspace`, `github`, review-loop, issue-breakdown, protected-path, and credential settings into a default project context for compatibility, then support an explicit `project_contexts` collection whose named contexts can override project-specific settings. Every candidate issue and every workflow-affecting action must resolve to exactly one project context before workspace creation, agent dispatch, service writeback, publication, review, or projection, and durable records must preserve the resolved context for replay and operator diagnosis.

## Technical Context

**Language/Version**: TypeScript 6.x on Node.js ES2022/NodeNext for configuration parsing, orchestration, tracker clients, harness integration, file-backed state, Postgres projections, CLI, and web/status APIs.

**Primary Dependencies**: Existing runtime dependencies only: `@cursor/sdk`, `@modelcontextprotocol/sdk`, `chokidar`, `commander`, `liquidjs`, `pg`, `yaml`, and `zod`. No new runtime dependency is planned.

**Storage**: Workflow YAML configuration; existing file-backed state under `workspace.state_dir` for runs, transcripts, workspaces, issue lifecycle, writeback, approvals, provider gates, MCP diagnostics, and conversations; existing PostgreSQL projection/state tables where configured. A Postgres migration is expected to add project-context attribution columns and indexes to owned state/projection tables rather than creating a separate database mode.

**Testing**: Root `vitest` suite via `npm test`; targeted tests under `tests/workflow.test.ts`, `tests/doctor.test.ts`, `tests/orchestrator.test.ts`, `tests/git-worktree.test.ts`, `tests/status-api.test.ts`, `tests/web-projection.test.ts`, `tests/web-history-projection.test.ts`, `tests/web-transcript-projection.test.ts`, `tests/web-route-contract.test.ts`, `tests/web-projection-context.test.ts`, `tests/completion-report-mcp.test.ts`, `tests/review-verdict-mcp.test.ts`, `tests/review-feedback-mcp.test.ts`, `tests/writeback-outbox.test.ts`, `tests/postgres-schema.test.ts`, `tests/mcp-subprocess-environment.test.ts`, `tests/cursor-harness.test.ts`, `tests/hermes-harness.test.ts`, and `tests/hermes-acp-harness.test.ts`.

**Target Platform**: Local Windows development is first-class. Path resolution, workspace root/state directory handling, cache paths, branch templates, generated MCP environments, and validation commands must work with Windows PowerShell paths and with POSIX-like workspaces used by runtime harnesses.

**Project Type**: Local orchestration service with CLI, runtime harness integration, MCP handoff, Linear tracker integration, GitHub publication/review/merge integration, web status API, durable projections, and VS Code/Cursor extension-facing projections.

**Performance Goals**: Configuration normalization for three project contexts should complete in under 20 ms without provider or tracker network calls. Polling across project contexts should be bounded by configured concurrency and should not serialize healthy contexts behind an unhealthy context. Project-context attribution in projections should add no more than one indexed lookup/filter pass over existing in-memory collections for file-backed reads.

**Constraints**: Preserve current behavior when `project_contexts` is absent. Fail closed when an issue has zero or multiple possible project contexts. Do not let agents choose or change project context. Do not expose Linear/GitHub/runtime tokens, environment values, private keys, or profile contents in context metadata, errors, prompts, logs, transcripts, or Spec Kit artifacts. Preserve in-progress run routing when configuration reloads. Namespace state so duplicate Linear identifiers from different projects cannot collide. Do not modify vendored Hermes source under `hermes/upstream-src/**`.

**Scale/Scope**: Initial scope supports at least three configured project contexts in one workflow, at least two distinct codebases, at least two distinct Linear projects, and concurrent worker/reviewer activity across at least two contexts. Each run has one primary resolved project context. Cross-project runs that intentionally mutate multiple codebases or trackers are out of scope.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. Service-Owned Authority Boundaries**: PASS. Project context resolution is a Symphony-owned service decision performed before tracker polling, workspace creation, dispatch, review, publication, merge, and writeback. Workers and reviewers receive resolved context metadata through Symphony-owned runtime and MCP paths and must not select, infer, or override project context through prompts, terminal commands, completion reports, or review verdicts.
- **II. Least-Privilege Credentials And Secret Hygiene**: PASS. Context identifiers, labels, codebase labels, Linear project slugs, and routing evidence are non-secret metadata. Credential values continue to flow through environment references and credential profiles. Context-specific failures identify the context and capability without printing token, private key, env, profile, or provider values.
- **III. Testable Contracts Before Implementation**: PASS. The spec defines prioritized stories, acceptance scenarios, measurable outcomes, edge cases, and assumptions. This plan names touched config, tracker, workspace, orchestrator, persistence, writeback, MCP, projection, database, and test surfaces before task generation. Generated Linear issues from this feature must include fenced JSON contracts per constitution governance.
- **IV. Durable Audit, Replay, And Idempotence**: PASS. The design requires `projectContextId` plus codebase, Linear project, workspace, and routing source evidence on run, workspace, lifecycle, writeback, approval, review, transcript, and projection records. Retries and replay use the persisted context rather than re-routing from changed configuration.
- **V. Scoped Change Ownership And Protected Surfaces**: PASS. Work stays in Symphony-owned configuration, workflow loading, tracker integration, orchestration, workspace management, MCP/harness wiring, persistence, projections, migrations, tests, and documentation. Vendored Hermes source, dirty workspaces, protected branches, and external Linear/GitHub state are not directly modified outside existing service-owned paths.

Pre-design gate result: PASS, no constitution violations.

Post-design gate result: PASS, no constitution violations. Phase 1 artifacts preserve service-owned routing, secret redaction, issue-contract obligations, durable context evidence, and protected-surface boundaries.

## Project Structure

### Documentation (this feature)

```text
specs/003-multi-project-config/
- plan.md
- research.md
- data-model.md
- quickstart.md
- contracts/
  - multi-project-configuration.md
  - project-context-resolution.md
  - web-projection-project-attribution.md
- checklists/
  - requirements.md
- tasks.md
```

### Source Code (repository root)

```text
src/
- core/
  - config/
    - Config.ts
    - CredentialProfiles.ts
    - ProjectContexts.ts
  - workflow/
    - WorkflowLoader.ts
  - tracker/
    - TrackerClient.ts
    - TrackerWriter.ts
  - workspace/
    - WorkspaceManager.ts
    - GitWorktreeManager.ts
  - orchestrator/
    - Orchestrator.ts
    - OrchestratorChatCommand.ts
  - persistence/
    - RunTranscriptStore.ts
    - IssueLifecycleStore.ts
    - ProjectionTransactionService.ts
    - ProviderGateStore.ts
    - OrchestratorConversationStore.ts
  - writeback/
    - TransitionPolicy.ts
    - WritebackOutbox.ts
  - approval/
    - OperatorApprovalService.ts
  - harness/
    - CompletionReportMcpServer.ts
    - ReviewVerdictMcpServer.ts
    - ReviewFeedbackMcpServer.ts
    - IssueBreakdownPlanMcpServer.ts
    - MergeConflictResolutionMcpServer.ts
    - McpSubprocessEnvironment.ts
    - HandoffMcp.ts
- integrations/
  - linear/
    - LinearTrackerClient.ts
    - LinearCredentialResolver.ts
  - github/
    - GitHubCredentialResolver.ts
- app/
  - http.ts
  - webProjection.ts
  - WebProjectionContext.ts
  - WebHistoryProjection.ts
  - WebTranscriptProjection.ts
  - WebProjectionRepository.ts
  - RealtimeProjectionEvents.ts

cursor/
- src/
  - CursorHarness.ts
  - CursorWorkspaceOpener.ts

hermes/
- src/
  - HermesHarness.ts
  - HermesAcpHarness.ts
  - HermesMcpConfig.ts

migrations/postgres/
- 0007_project_context_attribution.sql

tests/
- workflow.test.ts
- doctor.test.ts
- orchestrator.test.ts
- git-worktree.test.ts
- status-api.test.ts
- web-projection.test.ts
- web-history-projection.test.ts
- web-transcript-projection.test.ts
- web-route-contract.test.ts
- web-projection-context.test.ts
- completion-report-mcp.test.ts
- review-verdict-mcp.test.ts
- review-feedback-mcp.test.ts
- writeback-outbox.test.ts
- postgres-schema.test.ts
- mcp-subprocess-environment.test.ts
- cursor-harness.test.ts
- hermes-harness.test.ts
- hermes-acp-harness.test.ts
```

**Structure Decision**: Implement a shared Symphony-owned project context registry and resolution contract in configuration/workflow code, then adapt orchestration, tracker clients, workspace management, persistence, writeback, MCP/harness context, and projections to consume a resolved `projectContextId` instead of reading one global `config.tracker`, `config.workspace`, or `config.github` value at action time. Keep legacy top-level config as a compatibility source that normalizes into one default context. Do not fork the service into one orchestrator process per project and do not move authority into agents.

## Complexity Tracking

No constitution-driven complexity exceptions are recorded. The shared project context registry is necessary because the current single-project assumptions cross configuration, tracker, workspace, persistence, writeback, and projection boundaries. The migration/backfill work is part of preserving backward compatibility, not an accepted governance exception.

# Implementation Plan: ENG-372 Context Credential Routing

**Branch**: `[006-eng-372-context-credential-routing]` | **Date**: 2026-06-11 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/006-eng-372-context-credential-routing/spec.md`

## Summary

Complete ENG-372 by turning context-specific credential assignment and live tracker routing into explicit service-owned contracts. The plan covers capability-scoped credential profile resolution, structured profile inheritance, context-aware tracker reads for polling/status/issue-breakdown paths, identifier-only fallback resolution, and a real validation matrix that prevents reviewers from discovering one default-context fallback per review loop.

## Technical Context

**Language/Version**: TypeScript 6.x on Node.js ES2022/NodeNext.

**Primary Dependencies**: Existing config, Linear/GitHub integration, runtime dependency, MCP, and validation dependencies. No new runtime package is planned.

**Storage**: Workflow configuration, credential profile references, run/workspace/lifecycle evidence, issue-breakdown records, and tracker routing evidence. No schema migration is expected unless an implementation plan later identifies missing durable context fields.

**Testing**: Focused `vitest` suites through `npm test`, primarily `tests/credential-profiles.test.ts`, `tests/linear-credential-resolver.test.ts`, `tests/github-credential-resolver.test.ts`, `tests/linear.test.ts`, `tests/orchestrator.test.ts`, `tests/status-api.test.ts`, `tests/workspace.test.ts`, `tests/issue-breakdown-plan-service.test.ts`, and `tests/issue-breakdown-plan-apply-service.test.ts`.

**Target Platform**: Windows local development with PowerShell paths and existing cross-platform runtime harness behavior.

**Project Type**: Local orchestration service with workflow config, credential resolution, Linear tracker integration, GitHub integration, status APIs, issue-breakdown services, and runtime handoff.

**Performance Goals**: Credential and tracker route resolution should be local and bounded by configured context count. It must not add provider calls before a route is selected.

**Constraints**: Fail closed when context or credential assignment is missing or ambiguous. Never expose credential values. Do not let workers or reviewers select credentials or tracker clients. Do not rely on stubs that can pass while real Linear id-filtered behavior remains broken.

**Scale/Scope**: At least two project contexts with distinct tracker credentials and one default context. Covers live reads and mutation precursor paths known from ENG-372 review comments.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. Service-Owned Authority Boundaries**: PASS. Symphony owns credential resolution, tracker client selection, status lookup, issue-breakdown tracker access, and lifecycle writeback. Agents receive resolved context outputs but cannot override routing.
- **II. Least-Privilege Credentials And Secret Hygiene**: PASS. Capability credentials stay profile/env backed and are never copied into public metadata, logs, prompts, issue descriptions, validation output, or completion evidence.
- **III. Testable Contracts Before Implementation**: PASS. The spec defines testable user stories, acceptance scenarios, measurable outcomes, and required child issue contracts. This plan names the known live-read paths and validation matrix before tasks are generated.
- **IV. Durable Audit, Replay, And Idempotence**: PASS. Tracker routing evidence must show the selected context and capability without secret values. Identifier-only actions must resolve to canonical tracker identity before use.
- **V. Scoped Change Ownership And Protected Surfaces**: PASS. Work stays in Symphony-owned config, credential resolver, tracker routing, status, issue-breakdown, orchestrator, and tests. Vendored source and operator secrets are out of scope.

Pre-design gate result: PASS, no constitution violations.

Post-design gate result: PASS, no constitution violations. Phase 1 artifacts require a single route-resolution contract across polling, status, workspace, and issue-breakdown paths.

## Project Structure

### Documentation (this feature)

```text
specs/006-eng-372-context-credential-routing/
- spec.md
- plan.md
- research.md
- data-model.md
- quickstart.md
- contracts/
  - credential-profile-assignment.md
  - live-tracker-routing.md
- checklists/
  - requirements.md
```

### Source Code (repository root)

```text
src/
- core/
  - config/
    - Config.ts
    - CredentialProfiles.ts
    - ProjectContexts.ts
  - orchestrator/
    - Orchestrator.ts
  - persistence/
    - RunTranscriptStore.ts
  - IssueBreakdownPlanService.ts
  - IssueBreakdownPlanApplyService.ts
  - types.ts
- integrations/
  - linear/
    - LinearTrackerClient.ts
    - LinearCredentialResolver.ts
  - github/
    - GitHubCredentialResolver.ts
- app/
  - http.ts

tests/
- credential-profiles.test.ts
- linear-credential-resolver.test.ts
- github-credential-resolver.test.ts
- linear.test.ts
- orchestrator.test.ts
- status-api.test.ts
- workspace.test.ts
- issue-breakdown-plan-service.test.ts
- issue-breakdown-plan-apply-service.test.ts
- mcp-subprocess-environment.test.ts
```

**Structure Decision**: Use the project-context registry as the source of credential assignments and tracker route decisions. Every live tracker access path should accept or derive a resolved context before it creates or uses a tracker client. Identifier-only entry points must resolve to canonical tracker identity before fetching state.

## Complexity Tracking

No constitution-driven complexity exceptions are recorded.

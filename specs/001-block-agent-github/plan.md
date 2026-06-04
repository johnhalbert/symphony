# Implementation Plan: Block Worker and Reviewer Upstream GitHub Commands

**Branch**: `main` | **Date**: 2026-06-01 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-block-agent-github/spec.md`

## Summary

Implement a role-scoped command policy that prevents worker and reviewer agents from initiating upstream GitHub contact or mutation through terminal-like and code-execution surfaces, while preserving safe local repository inspection and keeping Symphony service-owned GitHub publication/review/writeback paths separate. The plan uses a shared policy classifier, wires it into Hermes ACP permission handling and Hermes gateway/TUI pre-tool-call hooks, records redacted policy decisions for audit, and expands validation around disguised commands, unsafe Git configuration, service credential separation, and replay.

## Technical Context

**Language/Version**: TypeScript 6.x on Node.js ES2022/NodeNext for Symphony orchestration; Hermes host integration is TypeScript with profile/template assets; profile hooks may execute Python or Node scripts inside Hermes profiles.

**Primary Dependencies**: Existing Symphony runtime dependencies: `@modelcontextprotocol/sdk`, `@cursor/sdk`, `commander`, `liquidjs`, `pg`, `yaml`, `zod`; test stack uses `vitest`. No new external runtime dependency is planned for command classification.

**Storage**: Existing local durable files and PostgreSQL-backed projections where already configured. Policy decisions should be persisted through existing run activity/transcript event paths before adding new storage.

**Testing**: Root `vitest` suite via `npm test`; targeted tests under `tests/` for Hermes ACP harness, Hermes templates, MCP subprocess environment, MCP exposure probes, transcript/run activity replay, and new command policy classifier tests.

**Target Platform**: Local Windows development is first-class; policy parsing and tests must also handle POSIX path forms because worker workspaces and Hermes profiles may execute in POSIX-like shells.

**Project Type**: Local orchestration service, CLI, Hermes/Cursor agent harness integration, web status API, and VS Code/Cursor extension. ENG-243 primarily touches orchestration/harness/security policy, not web UI.

**Performance Goals**: Command policy checks complete fast enough to run before every command-capable tool call without noticeable run latency. Target: normal policy decisions under 50 ms for direct commands and under 250 ms when local Git config inspection is required.

**Constraints**: Fail closed for unknown or ambiguous command forms that could contact GitHub, execute helper programs, or use credentials. Do not rely on prompt-only instructions. Do not expose credential values in denial messages, run events, logs, Linear notes, or test output. Do not block service-owned GitHub publication/review/writeback paths. Do not modify vendored Hermes source under `hermes/upstream-src/**`; any implementation path that requires vendored Hermes source changes is blocked for ENG-243.

**Scale/Scope**: Worker, reviewer, and merge-conflict-repair worker runs; terminal-like tools, shell commands, ACP permission requests, Hermes gateway/TUI tool calls, delegated subagent command surfaces, and command-capable code execution. Planning/issue-breakdown agents are out of scope unless they share the same worker/reviewer command surfaces.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The installed constitution is now `1.0.0` and defines enforceable Symphony
gates. ENG-243 satisfies them as follows:

- **I. Service-Owned Authority Boundaries**: PASS. The feature explicitly denies
  worker/reviewer upstream GitHub command ownership while preserving
  service-owned publication, review feedback, mergeability, CI, and writeback
  paths.
- **II. Least-Privilege Credentials And Secret Hygiene**: PASS. Requirements and
  tasks fail closed for ambiguous GitHub or credential paths, preserve service
  credential slicing, and require redacted denial/audit output.
- **III. Testable Contracts Before Implementation**: PASS. The spec defines P1
  and P2 independently testable stories, acceptance scenarios, measurable
  outcomes, and FR-014 validation coverage; tasks place test work before
  implementation in every story.
- **IV. Durable Audit, Replay, And Idempotence**: PASS. US4 requires durable
  policy evidence, transcript replay coverage, redaction, and persisted run
  activity events.
- **V. Scoped Change Ownership And Protected Surfaces**: PASS. The plan and
  tasks make vendored Hermes source edits under `hermes/upstream-src/**` a hard
  blocker and route enforcement through Symphony-owned code, generated profile
  assets, hooks/plugins, MCP/service boundaries, or configuration.

Pre-design gate result: PASS, no constitution violations.

Post-design gate result: PASS, no constitution violations.

## Project Structure

### Documentation (this feature)

```text
specs/001-block-agent-github/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── agent-command-policy.md
├── checklists/
│   └── requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
src/
├── core/
│   ├── harness/
│   │   ├── AgentHarness.ts
│   │   ├── HandoffMcp.ts
│   │   ├── McpSubprocessEnvironment.ts
│   │   ├── McpToolExposureProbe.ts
│   │   └── [new shared worker/reviewer command policy module]
│   ├── runActivity/
│   │   └── RunActivityEvent.ts
│   ├── persistence/
│   │   └── RunTranscriptStore.ts
│   └── transcript/
│       └── RunActivityEventMapper.ts

hermes/
├── src/
│   ├── HermesAcpHarness.ts
│   ├── HermesAcpPermissions.ts
│   ├── HermesHarness.ts
│   ├── HermesMcpConfig.ts
│   └── HermesProfileManager.ts
└── templates/
    ├── worker/
    │   ├── config.yaml
    │   ├── SOUL.md
    │   └── skills/
    └── reviewer/
        └── config.yaml

tests/
├── hermes-acp-harness.test.ts
├── hermes-harness.test.ts
├── hermes-template-policy.test.ts
├── hermes-mcp-config.test.ts
├── mcp-tool-exposure-probe.test.ts
├── mcp-subprocess-environment.test.ts
├── run-activity-event.test.ts
├── transcript-replay.test.ts
└── [new command policy tests]
```

**Structure Decision**: Implement the classifier as a Symphony-owned shared policy module and adapt each harness/tool surface to it. For Hermes ACP, use the existing permission request resolver path. For Hermes gateway/TUI, install a profile-scoped `pre_tool_call` hook/plugin from the Symphony-managed role templates so terminal and code-execution tool calls are checked before execution. Vendored Hermes source changes under `hermes/upstream-src/**` are not permitted. If a command-capable surface cannot be enforced through Symphony-owned code, generated profile assets, hooks/plugins, MCP/service boundaries, or configuration, that surface must fail closed and the gap must be reported as blocked rather than patched in vendored Hermes source.

## Complexity Tracking

No constitution-driven complexity exceptions are recorded. The additional policy module and profile hook are justified by the requirement that enforcement happen before tool execution and across multiple harness surfaces. Vendored Hermes source modification is not an allowed complexity exception for this feature.

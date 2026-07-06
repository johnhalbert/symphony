# ENG-452 T097 Focused MCP And Harness Validation

Captured on `2026-07-06T22:48:05Z` for branch `sinfonista/eng-452-t097-run-focused-mcp-and-harness-validation`.

## Purpose

Record the focused validation required by ENG-452 / `REQ-T097`:

- run `npm test -- tests/completion-report-mcp.test.ts tests/review-verdict-mcp.test.ts tests/review-feedback-mcp.test.ts tests/mcp-subprocess-environment.test.ts tests/cursor-harness.test.ts tests/hermes-harness.test.ts tests/hermes-acp-harness.test.ts`
- capture durable evidence that project context is preserved, generated environment metadata remains non-secret, and agent-provided MCP context mismatches are rejected

## Scenario Matrix Covered

- **Happy path / preservation**: same-context metadata drift remains accepted while the service-owned context is preserved for completion-report and reviewer-verdict handoff flows.
- **Negative / error path**: completion-report, reviewer-verdict, and reviewer-feedback MCP submissions reject issue-context and project-context mismatches instead of trusting agent-supplied handoff data.
- **Boundary / integration**: generated MCP subprocess environments retain only the project-context metadata needed for child parsing while omitting GitHub secrets and profile values.
- **Harness session attribution**: Cursor, Hermes, and Hermes ACP harnesses all preserve project context in session/profile keys and runtime metadata so same-identifier issues in different projects stay isolated.
- **Security / redaction**: review-feedback and harness surfaces continue to redact tokens and secret-like payloads while still returning durable structured metadata.
- **Adjacent / sibling surfaces**: the focused packet exercises completion-report MCP, review-verdict MCP, review-feedback MCP, MCP subprocess environment generation, and all three harness implementations together, covering the project-context contract across handoff, environment, and session boundaries.
- **Intentionally out of scope**: orchestration/worktree validation, web/projection validation, full-repository validation, typecheck, quickstart, and broader promotion tasks remain covered by follow-on tasks `T095`, `T096`, and `T098` through `T105`.

## Validation Command

```text
$ npm test -- tests/completion-report-mcp.test.ts tests/review-verdict-mcp.test.ts tests/review-feedback-mcp.test.ts tests/mcp-subprocess-environment.test.ts tests/cursor-harness.test.ts tests/hermes-harness.test.ts tests/hermes-acp-harness.test.ts
> symphony@0.1.0 test
> vitest run --no-file-parallelism tests/completion-report-mcp.test.ts tests/review-verdict-mcp.test.ts tests/review-feedback-mcp.test.ts tests/mcp-subprocess-environment.test.ts tests/cursor-harness.test.ts tests/hermes-harness.test.ts tests/hermes-acp-harness.test.ts

RUN  v4.1.5 C:/Users/john/src/github.com/johnhalbert/symphony/symphony_workspaces/ENG-452

✓ tests/hermes-acp-harness.test.ts (76 tests) 675ms
✓ tests/mcp-subprocess-environment.test.ts (36 tests) 80ms
✓ tests/completion-report-mcp.test.ts (17 tests) 2147ms
    ✓ uses service GitHub publication profile for default PR publication  831ms
    ✓ uses the active project context GitHub publication profile for direct PR publication  733ms
✓ tests/cursor-harness.test.ts (30 tests) 136ms
✓ tests/hermes-harness.test.ts (12 tests) 517ms
✓ tests/review-verdict-mcp.test.ts (4 tests) 152ms
✓ tests/review-feedback-mcp.test.ts (5 tests) 162ms

Test Files  7 passed (7)
Tests       180 passed (180)
Duration    9.13s
# exit 0
```

## Coverage Pointers

### Completion report MCP (`tests/completion-report-mcp.test.ts`)

- `511` — `rejects completion report MCP submission when the issue context does not match the active run`
- `570` — `rejects completion report MCP submission when the project context does not match the active run`
- `633` — `accepts completion report MCP submission when only same-context metadata drifts and preserves the service-owned context`
- `1501` — `uses the active run project context for authoritative tracker lookups`

### Review verdict and feedback MCP (`tests/review-verdict-mcp.test.ts`, `tests/review-feedback-mcp.test.ts`)

- `tests/review-verdict-mcp.test.ts:178` — `rejects reviewer verdict submissions when the handoff project context mismatches the persisted lifecycle context`
- `tests/review-verdict-mcp.test.ts:234` — `accepts reviewer verdict submissions when only same-context metadata drifts and preserves the service-owned context`
- `tests/review-feedback-mcp.test.ts:60` — `submits PR review feedback with project-context GitHub credentials and returns durable structured URLs without exposing tokens`
- `tests/review-feedback-mcp.test.ts:119` — `rejects review feedback when the MCP context issue identifier does not match the lifecycle record`
- `tests/review-feedback-mcp.test.ts:152` — `rejects review feedback when the MCP context project context mismatches the lifecycle record`

### MCP subprocess environment (`tests/mcp-subprocess-environment.test.ts`)

- `1463` — `exports only non-secret project-context parse refs while omitting project-context GitHub secrets and profile values`
- `775` — `does not expose publication credentials to completion report MCP when publication approval is required`
- `843` — `keeps reviewer verdict MCP free of GitHub credentials even when reviewer profiles are configured`
- `883` — `injects reviewer feedback profile credentials and metadata only for review feedback MCP`

### Harness project-context preservation (`tests/cursor-harness.test.ts`, `tests/hermes-harness.test.ts`, `tests/hermes-acp-harness.test.ts`)

- `tests/cursor-harness.test.ts:547` — `context-qualifies project-scoped Cursor sessions and preserves issue-derived project context metadata`
- `tests/cursor-harness.test.ts:689` — `does not collide project-scoped Cursor session ids across projects with the same issue identifier`
- `tests/hermes-harness.test.ts:136` — `qualifies reusable worker profile and session metadata by project context`
- `tests/hermes-acp-harness.test.ts:751` — `preserves project context in ACP profile/session keys and runtime metadata`
- `tests/hermes-acp-harness.test.ts:1576` — `does not reuse a worker lease when the resolved host context is incompatible`

## Reviewer Notes

- This issue is validation-only. No production code changes were required; this document is the durable evidence artifact needed to make the focused validation committable in the assigned worktree.
- The focused command came directly from `specs/003-multi-project-config/tasks.md:209` and was run unchanged in the ENG-452 worktree.
- The worktree remained otherwise clean after validation aside from this evidence artifact.
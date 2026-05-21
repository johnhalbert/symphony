# Symphony Dogfood Trust And Safety

This document describes the safety posture for running Symphony against its own Engineering Linear project and repository.

## Authority Boundaries

Symphony owns orchestration lifecycle decisions: issue dispatch, run records, workspace records, transcript persistence, Linear lifecycle writeback, and handoff status.

Cursor workers own implementation work inside their assigned worktree. Workers must not directly mutate Linear lifecycle state, change assignees, mark work `Done`, or merge PRs when service-owned writeback is enabled.

Humans can always override Linear state or stop Symphony. Symphony should observe external state changes and back off rather than fight them.

## Linear Writeback

Dogfood v1 uses service-owned Linear writeback.

Symphony may write:

- Dispatch transition, such as `Todo` to `In Progress`, when policy allows.
- Run-start and run-end comments.
- Failure and cancellation comments.
- Verified completion handoff transition, such as `In Progress` to `In Review`.
- Escalation transition to `Blocked` when review loops, incomplete turns, or other operator-required failures exceed policy limits.

Symphony must not write:

- Broad planning issue creation in v1.
- Auto-merge, auto-close, or direct `Done` transitions.
- Arbitrary Linear field edits.

Linear writeback should be idempotent and should re-check current Linear state before applying transitions.

## Dispatch Guardrails

Dogfood dispatch is opt-in. The reference `WORKFLOW.md` requires `dogfood-ready` and excludes `dogfood-blocked` and `safety-blocked`.

All issues in the dogfood epic remain `Backlog` with `dogfood-blocked` until an operator manually promotes exactly the next issue intended for dispatch.

Protected areas require human implementation until guardrails and the smoke checkpoint are proven:

- `WORKFLOW.md`
- `docs/dogfood-runbook.md`
- `docs/trust-and-safety.md`
- `src/core/orchestrator/**`
- `src/core/config/**`
- `src/core/workflow/**`
- `src/integrations/linear/**`
- `cursor/src/**`

Gate issues that touch those areas should be implemented manually through Cursor chat, not through Symphony workers.

## State Model

Dogfood uses these state groups:

- Worker implementation queue: `Todo`, `In Progress`
- Reviewer-agent queue: `In Review`
- Human-required escalation: `Blocked`
- Terminal: `Done`, `Closed`, `Cancelled`, `Canceled`, `Duplicate`

`In Review` is not active and not terminal. Reaching `In Review` stops worker dispatch and queues the work for independent reviewer-agent review.

Reviewer pass does not use a separate `Ready` or `Ready for Human` Linear state in the current dogfood loop. The reviewer records a structured pass verdict with supporting evidence, such as a Linear comment or PR review, while the issue remains `In Review`; after the PR is merged, Symphony transitions the issue to `Done`.

Review failures continue through the review loop. Policy exhaustion, repeated incomplete worker turns, or other human-required escalation moves the issue to `Blocked`.

## Workspace Safety

Dogfood uses `git_worktree` workspaces and `cleanup: refuse_dirty`.

Symphony refuses dirty worktree cleanup unless explicitly configured otherwise. Operators should inspect and recover dirty worktrees manually.

## Operator Controls

The status API exposes token-protected workspace opening, pause, resume, and cancel controls. Configure `server.open_workspace_token` with `SYMPHONY_OPEN_WORKSPACE_TOKEN` for local operator actions.

During early dogfood, run a single Symphony process and keep `max_concurrent_agents: 1`.

## Cursor Runtime

The current baseline model is `gpt-5.5` with thinking effort `xhigh`. This applies to direct Cursor work now and Symphony-managed workers later.

Workers run through Cursor SDK local runtime in the assigned worktree. Project and user settings are loaded by default.

## Non-Goals

- Native Cursor chat-history injection.
- Multi-process distributed claiming.
- Autonomous planning issue creation.
- Auto-merge or auto-close behavior.

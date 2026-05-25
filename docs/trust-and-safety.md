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
- Verified PR handoff transition, such as `In Progress` to `Human Review`, after an accepted completion report and configured handoff checks.
- Escalation transition to `Blocked` when review loops, incomplete turns, or other operator-required failures exceed policy limits.

Symphony must not write:

- Broad planning issue creation in v1.
- Auto-merge, auto-close, or direct `Done` transitions.
- Arbitrary Linear field edits.

Linear writeback should be idempotent and should re-check current Linear state before applying transitions.

## Dispatch Guardrails

Dogfood dispatch is opt-in. The reference `WORKFLOW.md` requires `dogfood-ready` and excludes `dogfood-blocked` and `safety-blocked`.

All issues in the dogfood epic remain `Backlog` with `dogfood-blocked` until an operator manually promotes exactly the next issue intended for dispatch.

Continuation search and richer summarization are roadmap placeholders only. Their feature flags default off, doctor warns if an operator enables them before implementation, and their placeholder Linear issues stay `Backlog` with `dogfood-blocked` and without `dogfood-ready`.

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
- PR-driven human review handoff: `Human Review`
- Reviewer-agent queue: `In Review`
- Human-required escalation: `Blocked`
- Terminal: `Done`, `Closed`, `Cancelled`, `Canceled`, `Duplicate`

`Human Review` is not active and not terminal. Reaching `Human Review` stops worker dispatch and leaves the lifecycle-bound pull request for human review. Handoff checks are evaluated at completion-report submission time; a PR can exist without a Linear handoff when those checks are still pending or failing. A human operator moves the issue to `In Review` when reviewer-agent review should start.

`In Review` is not active and not terminal. Reaching `In Review` queues the work for independent reviewer-agent review and requires a stored worker completion report.

Reviewer pass uses the configured `Ready to Merge` Linear state in the current dogfood loop. The reviewer records a structured pass verdict with supporting evidence, such as a Linear comment or PR review, and Symphony transitions the issue from `In Review` to `Ready to Merge`.

Review failures continue through the review loop. Policy exhaustion, repeated incomplete worker turns, or other human-required escalation moves the issue to `Blocked`.

## GitHub PR Review Feedback

Reviewer agents do not receive raw GitHub write credentials directly in their prompts or lifecycle context files. When a reviewer needs to leave PR feedback, Cursor mounts a separate Symphony-owned `review-feedback-mcp` server alongside the GitHub-free `review-verdict-mcp` server. The reviewer first calls `submit_pull_request_review_feedback`; Symphony resolves the lifecycle-bound PR and head SHA service-side, writes feedback through a scoped GitHub client, and returns durable PR review/comment URLs. The reviewer then passes those returned URLs to `submit_review_verdict.evidence`.

The feedback context file contains only local reviewer handoff identity: issue, active run id, reviewer role, reviewer identity, review phase, and optional local handoff token fields. It must not contain PR number, PR URL, head SHA, GitHub token, repository owner/name, or other GitHub credential material.

The feedback MCP service fails closed unless the caller is an active reviewer, the lifecycle is in review, the active run matches the lifecycle summary, and a lifecycle-bound PR exists. Inline review feedback and PR reviews use the lifecycle-bound head SHA; if the head SHA is absent, Symphony rejects the request instead of letting the reviewer supply commit identity. Feedback writes are idempotent by issue, run, and idempotency key, so retries replay stored URLs without duplicate GitHub writes.

## Workspace Safety

Dogfood uses `git_worktree` workspaces and `cleanup: refuse_dirty`.

Symphony refuses dirty worktree cleanup unless explicitly configured otherwise. Operators should inspect and recover dirty worktrees manually.

## Operator Controls

The status API exposes token-protected workspace opening, pause, resume, and cancel controls. Configure `server.open_workspace_token` with `SYMPHONY_OPEN_WORKSPACE_TOKEN` for local operator actions.

During early dogfood, run a single Symphony process and keep `max_concurrent_agents: 1`.

## Credential Profiles

Symphony supports optional named credential profiles as a config-only foundation for future least-privilege execution. Profiles must point at environment variables; do not put secret material directly in workflow config.

```yaml
credential_profiles:
  profiles:
    github-read:
      value: $GITHUB_READ_TOKEN
      capabilities:
        - github.discovery
        - github.review_evidence_read
    github-publish:
      value: $GITHUB_PUBLISH_TOKEN
      capabilities:
        - github.publication
    github-feedback:
      value: $GITHUB_FEEDBACK_TOKEN
      capabilities:
        - github.review_feedback_write
  roles:
    worker:
      github.discovery: github-read
      github.publication: github-publish
    reviewer:
      github.review_evidence_read: github-read
      github.review_feedback_write: github-feedback
```

The closed capability inventory is `github.discovery`, `github.publication`, `github.review_evidence_read`, `github.review_feedback_write`, `linear.tracker`, `linear.writeback`, `cursor.runtime`, and `server.open_workspace`. `github.review_feedback_write` is consumed only by the reviewer feedback MCP server.

When `credential_profiles` is absent, current behavior is unchanged. GitHub capabilities fall back to `github.token` or `GITHUB_TOKEN`; both Linear capabilities fall back to `tracker.api_key` or `LINEAR_API_KEY`; `cursor.runtime` falls back to env-only `CURSOR_API_KEY`; and `server.open_workspace` falls back only to `server.open_workspace_token`. Workflow config may still point `server.open_workspace_token` at `SYMPHONY_OPEN_WORKSPACE_TOKEN`.

Default role capability sets are intentionally narrow: workers use GitHub discovery/publication, Linear tracker/writeback, Cursor runtime, and workspace-open credentials; reviewers use GitHub review-evidence read, GitHub review-feedback write, Linear tracker/writeback, and Cursor runtime. MCP context `token` and `expectedToken` fields in completion-report, review-feedback, and review-verdict handoff files are local handoff authentication, not GitHub, Linear, Cursor, or server credentials, and must not be modeled as credential profiles.

## Cursor Runtime

The current baseline model is `gpt-5.5` with thinking effort `xhigh`. This applies to direct Cursor work now and Symphony-managed workers later.

Workers run through Cursor SDK local runtime in the assigned worktree. Project and user settings are loaded by default.

## Non-Goals

- Native Cursor chat-history injection.
- Multi-process distributed claiming.
- Autonomous planning issue creation.
- Auto-merge or auto-close behavior.

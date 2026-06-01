# Symphony Dogfood Trust And Safety

This document describes the safety posture for running Symphony against its own Engineering Linear project and repository.

## Authority Boundaries

Symphony owns orchestration lifecycle decisions: issue dispatch, run records, workspace records, transcript persistence, Linear lifecycle writeback, and handoff status.

Runtime-harness workers own implementation work inside their assigned worktree. Workers must not directly mutate Linear lifecycle state, change assignees, mark work `Done`, or merge PRs when service-owned writeback is enabled.

Humans can always override Linear state or stop Symphony. Symphony should observe external state changes and back off rather than fight them.

## Linear Writeback

Dogfood v1 uses service-owned Linear writeback.

Symphony may write:

- Dispatch transition, such as `Todo` to `In Progress`, when policy allows.
- Run-start and run-end comments.
- Failure and cancellation comments.
- Review-queue handoff transition, such as `In Progress` to `In Review`, after an accepted completion report and PR publication/reuse when the PR handoff gate is disabled.
- Escalation transition to `Blocked` when review loops, incomplete turns, or other operator-required failures exceed policy limits.

Symphony must not write:

- Broad planning issue creation in v1.
- Auto-merge, auto-close, or direct `Done` transitions.
- Arbitrary Linear field edits.

Linear writeback should be idempotent and should re-check current Linear state before applying transitions.

## Dispatch Guardrails

Dogfood dispatch is opt-in. The reference `WORKFLOW.md` requires `dogfood-ready` and excludes `dogfood-blocked` and `safety-blocked`.

Operators must not add `dogfood-ready` or remove `dogfood-blocked` for an agent-eligible issue until the issue uses the required authoring sections from [`agent-eligible-issue-template.md`](./agent-eligible-issue-template.md): `Problem / Goal`, `Touched Surfaces`, `Acceptance Criteria`, `Contract Checklist`, `Validation Requirements`, `Out Of Scope`, and `Promotion Readiness`. The `Validation Requirements` section must include a concrete validation plan, and the `Contract Checklist` must be reviewed for the touched surfaces before promotion.

The template explicitly forbids secrets, tokens, private keys, credential values, and private customer data in issue descriptions. Issues should describe credential/security variants without including credential material.

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
- `hermes/src/**`

Gate issues that touch those areas should be implemented manually by an operator, not through Symphony workers.

## State Model

Dogfood uses these state groups:

- Worker implementation queue: `Todo`, `In Progress`
- Reviewer-agent queue: `In Review`
- Human-required escalation: `Blocked`
- Terminal: `Done`, `Closed`, `Cancelled`, `Canceled`, `Duplicate`

The current dogfood workflow has `github.pr_handoff.enabled: false`, so `Human Review` is not part of the active loop. After an accepted worker completion report, Symphony publishes or reuses the lifecycle-bound pull request and moves the issue directly to `In Review`.

`In Review` is not active and not terminal. Reaching `In Review` queues the work for independent reviewer-agent review and requires a stored worker completion report.

Reviewer pass uses the configured `Ready to Merge` Linear state in the current dogfood loop. The reviewer records a structured pass verdict with supporting evidence, such as a Linear comment or PR review, and Symphony transitions the issue from `In Review` to `Ready to Merge`.

Review failures continue through the review loop. Policy exhaustion, repeated incomplete worker turns, or other human-required escalation moves the issue to `Blocked`.

## GitHub PR Review Feedback

Reviewer agents do not receive raw GitHub write credentials directly in their prompts or lifecycle context files. When a reviewer needs to leave PR feedback, the runtime harness mounts a separate Symphony-owned `review-feedback-mcp` server alongside the GitHub-free `review-verdict-mcp` server. The reviewer first calls `submit_pull_request_review_feedback`; Symphony resolves the lifecycle-bound PR and head SHA service-side, writes feedback through a scoped GitHub client, and returns durable PR review/comment URLs. The reviewer then passes those returned URLs to `submit_review_verdict.evidence`.

The feedback context file contains only local reviewer handoff identity: issue, active run id, reviewer role, reviewer identity, review phase, and optional local handoff token fields. It must not contain PR number, PR URL, head SHA, GitHub token, repository owner/name, or other GitHub credential material.

The feedback MCP service fails closed unless the caller is an active reviewer, the lifecycle is in review, the active run matches the lifecycle summary, and a lifecycle-bound PR exists. Inline review feedback and PR reviews use the lifecycle-bound head SHA; if the head SHA is absent, Symphony rejects the request instead of letting the reviewer supply commit identity. Feedback writes are idempotent by issue, run, and idempotency key, so retries replay stored URLs without duplicate GitHub writes.

## Workspace Safety

Dogfood uses `git_worktree` workspaces and `cleanup: refuse_dirty`.

Symphony refuses dirty worktree cleanup unless explicitly configured otherwise. Operators should inspect and recover dirty worktrees manually.

## Operator Controls

The status API exposes token-protected workspace opening, pause, resume, and cancel controls. The reference workflow points `server.open_workspace_token` at `SYMPHONY_WORKSPACE_TOKEN` for local operator actions.

During early Hermes dogfood, run a single Symphony process and keep `max_concurrent_agents: 1`.

## Credential Profiles

Symphony supports optional named credential profiles as a config-only foundation for least-privilege execution. Static-token profiles must point at environment variables; do not put secret material directly in workflow config.

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
    service:
      github.publication: github-publish
    reviewer:
      github.review_evidence_read: github-read
      github.review_feedback_write: github-feedback
```

GitHub capabilities may also use app-backed profiles. The dogfood workflow uses one GitHub App profile for service-owned publication/merge and a separate reviewer app profile for PR review feedback so GitHub does not reject self-approval attempts from the app that authored the PR.

```yaml
credential_profiles:
  profiles:
    publication-app:
      kind: github_app
      app_id: $GITHUB_APP_ID
      client_id: $GITHUB_APP_CLIENT_ID
      installation_id: $GITHUB_APP_INSTALLATION_ID
      private_key_path: $GITHUB_APP_PRIVATE_KEY_PATH
      capabilities:
        - github.publication
        - github.merge
    reviewer-app:
      kind: github_app
      app_id: $GITHUB_REVIEW_APP_ID
      client_id: $GITHUB_REVIEW_APP_CLIENT_ID
      installation_id: $GITHUB_REVIEW_APP_INSTALLATION_ID
      private_key_path: $GITHUB_REVIEW_APP_PRIVATE_KEY_PATH
      capabilities:
        - github.review_feedback_write
  roles:
    service:
      github.publication: publication-app
      github.merge: publication-app
    reviewer:
      github.review_feedback_write: reviewer-app
```

The closed capability inventory is `github.discovery`, `github.publication`, `github.review_evidence_read`, `github.review_feedback_write`, `github.merge`, `linear.tracker`, `linear.writeback`, `runtime.cursor`, `runtime.hermes`, legacy alias `cursor.runtime`, and `server.open_workspace`. `github.review_feedback_write` is consumed only by the reviewer feedback MCP server.

When `credential_profiles` is absent, current behavior is unchanged. GitHub capabilities fall back to `github.token` or `GITHUB_TOKEN`; both Linear capabilities fall back to `tracker.api_key` or `LINEAR_API_KEY`; `runtime.cursor` and legacy `cursor.runtime` fall back to env-only `CURSOR_API_KEY`; `runtime.hermes` has no legacy fallback and must be assigned explicitly when the Hermes harness needs a runtime API key; and `server.open_workspace` falls back only to `server.open_workspace_token`. The reference workflow points `server.open_workspace_token` at `SYMPHONY_WORKSPACE_TOKEN`. Hermes `openai-codex` uses Hermes-owned OAuth instead of `runtime.hermes`: Symphony bootstraps selected provider state into `hermes.auth.managed_root` and passes it to generated profiles with `HERMES_AUTH_HOME`.

Default role capability sets are intentionally narrow: workers use GitHub discovery, Linear tracker/writeback, runtime harness, and workspace-open credentials; service code uses GitHub publication/merge and Linear writeback credentials; reviewers use GitHub review-evidence read, GitHub review-feedback write, Linear tracker/writeback, and runtime harness credentials. Implementation workers hand off with `submit_completion_report`; they must not commit, push, or mutate lifecycle-bound PRs directly because service-owned publication performs the commit, push, and PR creation/reuse after acceptance. MCP context `token` and `expectedToken` fields in completion-report, review-feedback, and review-verdict handoff files are local handoff authentication, not GitHub, Linear, runtime, or server credentials, and must not be modeled as credential profiles.

## Runtime Harness

Hermes is the dogfood runtime harness in the reference workflow. Cursor remains supported as `agent.harness: cursor` with the current Cursor baseline model `gpt-5.5` and thinking effort `xhigh`. Hermes uses generated per-role Hermes homes under the workflow state directory. For OpenAI Codex OAuth, those generated homes remain isolated while sharing the Symphony-managed Hermes auth root.

Workers run through the selected runtime harness in the assigned worktree. The Cursor provider uses the Cursor SDK local runtime. The Hermes provider uses the upstream TUI stdio gateway through a Symphony facade and mounts Symphony MCP handoff tools into each generated profile.

Hermes dogfood requires a nonempty `hermes.model`, so the upstream gateway cannot fall back to an unrelated default model. The reference workflow uses `gpt-5.5`, while the generated worker, reviewer, and planner templates set Hermes `agent.reasoning_effort: xhigh`. Native Windows is supported for Symphony's stdio gateway path with Node 22+ and Python 3.11+; configure `hermes.python` when the desired Python executable is not the default `python`.

## Non-Goals

- Native Cursor chat-history injection.
- Multi-process distributed claiming.
- Autonomous planning issue creation.
- Auto-merge or auto-close behavior.

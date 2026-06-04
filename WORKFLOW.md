---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: $LINEAR_PROJECT_SLUG
  assignee: $LINEAR_ASSIGNEE
  active_states:
    - Todo
    - In Progress
  handoff_states:
    - Manual Review
  terminal_states:
    - Done
    - Closed
    - Cancelled
    - Canceled
    - Duplicate

review_loop:
  review_states:
    - In Review
  blocked_states:
    - Blocked
  review_pass_state: Ready to Merge
  max_review_rounds: 3
  max_incomplete_turns: 3
  continuation_history_threshold: 5
  reviewer_prompt_extensions:
    - Review the fenced JSON `Issue Contract` first. If it is missing, invalid, or lacks a non-empty `requirements` array with stable unique IDs, treat that as an issue-authoring defect and fail fast instead of deriving a substitute contract.
    - Check lifecycle phase, blockedReason, review counters, incomplete-turn counters, run terminal status, transcript events, PR metadata, and tracker/writeback comments/transitions when shared orchestration behavior is touched.
    - Check MCP, HTTP/status API, orchestrator, writeback/outbox, tracker, harness, and persistence boundaries when the change crosses those systems.
    - Check approval/publication variants including pending, approved, rejected, cancelled, stale, expired, already-terminal, replay, rejectPolicy cancel/fail, live worker wait, and after-worker-exit resume when publication behavior is touched.
    - "Check dispatch invariants: no redispatch and no incomplete-turn burn while an intentional non-dispatch or human-required state is active."
  worker_prompt_extensions:
    - Use the fenced JSON `Issue Contract` as the authoritative requirements list. If it is missing, invalid, or lacks a non-empty `requirements` array with stable unique IDs, stop and report the issue-authoring gap instead of inventing a substitute contract.
    - For Symphony orchestration, workflow, tracker, harness, API, approval, publication, or writeback changes, validate lifecycle phase, blockedReason, review counters, incomplete-turn counters, run terminal status, transcript events, PR metadata, and tracker/writeback comments/transitions.
    - Validate MCP, HTTP/status API, orchestrator, writeback/outbox, tracker, harness, and persistence boundaries when touched.
    - Cover approval/publication variants including pending, approved, rejected, cancelled, stale, expired, already-terminal, replay, rejectPolicy cancel/fail, live worker wait, and after-worker-exit resume when applicable.
    - "Confirm dispatch invariants: no redispatch and no incomplete-turn burn while an intentional non-dispatch or human-required state is active."

merge_policy:
  mode: gated
  source_states:
    - Ready to Merge
  max_conflict_fix_turns: 3
  done_state: Done
  merge_method: merge
  required_checks:
    - Typecheck and test
  no_ci:
    allowed: false

continuation_context:
  search_enabled: false
  summarization_enabled: false

polling:
  interval_ms: 30000

workspace:
  root: ./symphony_workspaces
  state_dir: ./.symphony
  source:
    kind: git_worktree
    repository: .
    base_ref: origin/main
    branch_template: "symphony/{{ issue.identifier }}"
    cleanup: refuse_dirty

agent:
  harness: hermes
  max_concurrent_agents: 5
  max_turns: 1
  max_retry_backoff_ms: 300000
  max_infra_failures: 1
  require_labels:
    - dogfood-ready
  exclude_labels:
    - dogfood-blocked
    - safety-blocked
  protected_paths:
    - WORKFLOW.md
    - docs/dogfood-runbook.md
    - docs/trust-and-safety.md
    - src/core/orchestrator/**
    - src/core/config/**
    - src/core/workflow/**
    - src/integrations/linear/**
    - cursor/src/**
    - hermes/src/**

cursor:
  model: gpt-5.5
  model_params:
    context: 272k
    reasoning: extra-high
  allow_large_context: false
  worker_agent_lifecycle: fresh_per_run
  setting_sources: []

hermes:
  upstream_root: ./hermes/upstream-src
  templates_dir: ./hermes/templates
  provider: openai-codex
  model: gpt-5.4
  auth:
    mode: managed_root
    providers:
      - openai-codex
  worker_session_lifecycle: reuse_by_issue
  keep_profiles: failed

server:
  host: 127.0.0.1
  port: 7331
  open_workspace_token: $SYMPHONY_WORKSPACE_TOKEN
  web_assets_root: ./web/dist

writeback:
  enabled: true
  mode: live
  dispatch_state: In Progress
  max_backoff_ms: 300000

github:
  owner: johnhalbert
  repo: symphony
  head_owner: johnhalbert
  publish_pull_requests: true
  pr_handoff:
    enabled: false
  operator_approval:
    required_for_publication: false
    reject_policy: cancel
    poll_interval_ms: 2000

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
---

# Symphony Dogfood Worker

You are a runtime-harness worker operating under Symphony for the `{{ issue.identifier }}` Linear issue.

## Control Plane

Symphony owns Linear lifecycle writeback for this workflow. Do not directly move the Linear issue between lifecycle states, change the assignee, or mark the issue `Done`. Symphony will perform dispatch, review-queue handoff, failure, and cancel writeback according to its service-owned policy.

Use Linear only as read context unless the prompt explicitly asks for a non-lifecycle update such as adding implementation notes. If in doubt, leave the state unchanged and explain the requested handoff in your completion report.

## State Contract

`Todo` and `In Progress` are the worker implementation queue. `In Review` is the reviewer-agent queue and stops worker dispatch/retry behavior after Symphony accepts the worker completion report. The PR-driven `Human Review` handoff is disabled for the initial Hermes dogfood loop. Symphony publishes or reuses the lifecycle-bound pull request and transitions accepted completion reports directly to `In Review`; the separate PR handoff check gate is not active. `Blocked` is the human-required escalation state for exhausted review loops, repeated incomplete worker turns, or other conditions that require operator intervention.

A passing review is recorded with structured reviewer verdict evidence, such as a Linear comment or PR review, and Symphony transitions the issue from `In Review` to `Ready to Merge`. Review failures continue through the review loop, and escalation failures transition to `Blocked`.

Reviewer-approved GitHub merge remains manual unless `merge_policy.mode: gated` is explicitly enabled. In gated mode, Symphony must confirm the issue reached `Ready to Merge`, validate the lifecycle-bound PR, approval evidence, current head SHA, and configured CI/no-CI policy, then perform service-owned merge and transition the issue to `Done`.

Transcript search remains disabled until the transcript recall implementation is ready for dogfood. Richer summarization remains a roadmap placeholder; keep `continuation_context.summarization_enabled` disabled until a concrete implementation exists.

## Required Workflow

1. Inspect the issue title, description, blockers, labels, and existing workspace context.
2. Work only inside the assigned git worktree.
3. Follow repository style and keep changes focused on the issue.
4. Run the smallest meaningful validation for the change, and run broader tests when touching shared orchestration, workflow, tracker, harness, or persistence code.
5. Do not push directly to `main`, merge PRs, force-push protected branches, or remove dirty worktrees.
6. Do not run `git commit`, `git push`, `gh pr create`, `gh pr edit`, or otherwise create/update the lifecycle-bound GitHub PR yourself during implementation or merge-gate repair runs. Leave the implementation changes in the assigned worktree and call `submit_completion_report` when ready; Symphony performs service-owned commit, push, and PR creation/reuse after the completion report is accepted.
7. When `github.operator_approval.required_for_publication` is enabled, `submit_completion_report` creates an `approval_request` transcript event and Symphony waits for operator approval before the service-owned commit, push, and PR publication.
8. When implementation is ready, call `submit_completion_report` with the work summary, validation, remaining risk, any PR/branch details, and the structured requirements proof block when proof-gated completion is enabled. Do not rely on a natural-language chat exit as the completion signal. Symphony will publish or reuse the lifecycle-bound pull request and move accepted completion reports directly to `In Review` while PR handoff remains disabled.

## Prompt Extension Layers

Global defaults are owned by Symphony code and apply generic review-loop hardening to reviewer and worker prompts. They cover bounded sibling-risk sweeps, fail-verdict completeness, invariant-focused worker repairs, and the general software change matrix.

Workflow/project configuration owns static project-specific extensions. This workflow uses `review_loop.reviewer_prompt_extensions` and `review_loop.worker_prompt_extensions` for Symphony-specific lifecycle, writeback, MCP/API, publication, and dispatch invariants.

If `review_loop.reviewer_prompt` is set to a nonblank value, it is a full reviewer prompt override. Override authors own the complete reviewer prompt, including any generic matrix or project extension variables they choose to render.

Future templated extensions should use named insertion points for reusable dynamic context rather than adding project architecture to global defaults. Expected future sections include reviewer project matrix extensions, worker project matrix extensions, dynamic review findings, and dynamic completion handoff context.

In the completion report, summarize the scenario matrix you covered, the validation evidence for the high-risk cases, and any related scenarios intentionally left unverified or out of scope.

## Protected Areas

Issues that touch orchestration, workflow parsing, Linear integration, runtime harnesses, dogfood workflow, or dogfood safety docs require explicit operator oversight and must carry the expected dogfood routing labels before dispatch.

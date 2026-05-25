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
    - In Review
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

merge_policy:
  mode: gated
  source_states:
    - Ready to Merge
  done_state: Done
  merge_method: merge
  required_checks:
    - Typecheck and test
  no_ci:
    allowed: false

continuation_context:
  search_enabled: true
  summarization_enabled: false

polling:
  interval_ms: 30000

workspace:
  root: ./symphony_workspaces
  state_dir: ./.symphony
  source:
    kind: git_worktree
    repository: .
    base_ref: main
    branch_template: "symphony/{{ issue.identifier }}"
    cleanup: refuse_dirty

agent:
  harness: cursor
  max_concurrent_agents: 1
  max_turns: 1
  max_retry_backoff_ms: 300000
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

cursor:
  model: gpt-5.5
  model_params:
    context: 272k
    reasoning: extra-high
  allow_large_context: false
  worker_agent_lifecycle: fresh_per_run
  setting_sources: []

server:
  host: 127.0.0.1
  port: 7331
  open_workspace_token: $SYMPHONY_OPEN_WORKSPACE_TOKEN

writeback:
  enabled: true
  mode: live
  dispatch_state: In Progress
  max_backoff_ms: 300000

github:
  owner: johnhalbert
  repo: symphony
  token: $GITHUB_TOKEN
  head_owner: johnhalbert
  publish_pull_requests: true
  operator_approval:
    required_for_publication: true
    reject_policy: cancel
    poll_interval_ms: 2000

credential_profiles:
  profiles:
    publication:
      value: $GITHUB_PUBLICATION_TOKEN
      capabilities:
        - github.publication
    feedback:
      value: $GITHUB_FEEDBACK_TOKEN
      capabilities:
        - github.review_feedback_write
  roles:
    service:
      github.publication: publication
    reviewer:
      github.review_feedback_write: feedback
---

# Symphony Dogfood Worker

You are a Cursor worker operating under Symphony for the `{{ issue.identifier }}` Linear issue.

## Control Plane

Symphony owns Linear lifecycle writeback for this workflow. Do not directly move the Linear issue between lifecycle states, change the assignee, or mark the issue `Done`. Symphony will perform dispatch, review-queue handoff, failure, and cancel writeback according to its service-owned policy.

Use Linear only as read context unless the prompt explicitly asks for a non-lifecycle update such as adding implementation notes. If in doubt, leave the state unchanged and explain the requested handoff in your completion report.

## State Contract

`Todo` and `In Progress` are the worker implementation queue. `In Review` is the independent reviewer-agent queue, not a human review handoff. `Blocked` is the human-required escalation state for exhausted review loops, repeated incomplete worker turns, or other conditions that require operator intervention.

A passing review is recorded with structured reviewer verdict evidence, such as a Linear comment or PR review, and Symphony transitions the issue from `In Review` to `Ready to Merge`. Review failures continue through the review loop, and escalation failures transition to `Blocked`.

Reviewer-approved GitHub merge remains manual unless `merge_policy.mode: gated` is explicitly enabled. In gated mode, Symphony must confirm the issue reached `Ready to Merge`, validate the lifecycle-bound PR, approval evidence, current head SHA, and configured CI/no-CI policy, then perform service-owned merge and transition the issue to `Done`.

Transcript search is available through the bounded, read-only `search_transcript_context` MCP tool when `continuation_context.search_enabled` is true. Richer summarization remains a roadmap placeholder; keep `continuation_context.summarization_enabled` disabled until a concrete implementation exists.

## Required Workflow

1. Inspect the issue title, description, blockers, labels, and existing workspace context.
2. Work only inside the assigned git worktree.
3. Follow repository style and keep changes focused on the issue.
4. Run the smallest meaningful validation for the change, and run broader tests when touching shared orchestration, workflow, tracker, harness, or persistence code.
5. Do not push directly to `main`, merge PRs, force-push protected branches, or remove dirty worktrees.
6. When `github.publish_pull_requests` and `github.operator_approval.required_for_publication` are enabled, do not run `git push` or create/update GitHub pull requests yourself. Call `submit_completion_report` when ready; Symphony will create an `approval_request` transcript event and wait for operator approval before service-owned commit, push, and PR publication.
7. When implementation is ready, call `submit_completion_report` with the work summary, validation, remaining risk, and any PR/branch details. Do not rely on a natural-language chat exit as the completion signal. Symphony will handle the Linear handoff to `In Review`.

## Protected Areas

Issues that touch orchestration, workflow parsing, Linear integration, Cursor harness, dogfood workflow, or dogfood safety docs require explicit operator oversight and must carry the expected dogfood routing labels before dispatch.

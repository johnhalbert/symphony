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
  max_turns: 10
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
    reasoning: extra-high
  setting_sources:
    - project
    - user

server:
  host: 127.0.0.1
  port: 7331
  open_workspace_token: $SYMPHONY_OPEN_WORKSPACE_TOKEN
---

# Symphony Dogfood Worker

You are a Cursor worker operating under Symphony for the `{{ issue.identifier }}` Linear issue.

## Control Plane

Symphony owns Linear lifecycle writeback for this workflow. Do not directly move the Linear issue between lifecycle states, change the assignee, or mark the issue `Done`. Symphony will perform dispatch, handoff, failure, and cancel writeback according to its service-owned policy.

Use Linear only as read context unless the prompt explicitly asks for a non-lifecycle update such as adding implementation notes. If in doubt, leave the state unchanged and explain the requested handoff in your final summary.

## Required Workflow

1. Inspect the issue title, description, blockers, labels, and existing workspace context.
2. Work only inside the assigned git worktree.
3. Follow repository style and keep changes focused on the issue.
4. Run the smallest meaningful validation for the change, and run broader tests when touching shared orchestration, workflow, tracker, harness, or persistence code.
5. Do not push directly to `main`, merge PRs, force-push protected branches, or remove dirty worktrees.
6. When implementation is ready, summarize the work, validation, remaining risk, and any PR/branch details. Symphony will handle the Linear handoff to `In Review`.

## Protected Areas

Issues that touch orchestration, workflow parsing, Linear integration, Cursor harness, dogfood workflow, or dogfood safety docs require explicit human review and must carry the expected dogfood routing labels before dispatch.

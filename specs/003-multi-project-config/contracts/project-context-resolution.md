# Contract: Project Context Resolution

## Purpose

Ensure every issue, workspace, run, review, approval, publication, merge, and Linear writeback is bound to exactly one project context before Symphony acts.

## Resolution Output

```json
{
  "projectContextId": "symphony",
  "projectContextLabel": "Symphony",
  "routingSource": "candidate_poll",
  "linearProject": {
    "kind": "linear",
    "slug": "ENG",
    "id": "optional-redacted-external-id"
  },
  "codebase": {
    "sourceKind": "git_worktree",
    "label": "johnhalbert/symphony",
    "baseRef": "origin/main"
  },
  "workspace": {
    "workspaceKey": "symphony--ENG-123",
    "path": "C:\\Users\\john\\src\\github.com\\johnhalbert\\symphony\\symphony_workspaces\\symphony--ENG-123"
  },
  "lockedAt": "2026-06-07T00:00:00.000Z"
}
```

## Required Call Sites

Resolution MUST happen before:

- tracker candidate dispatch
- tracker state refresh for active runs
- workspace creation, reuse, lookup, or cleanup
- worker, reviewer, planner, issue-breakdown, and merge-repair dispatch
- completion report acceptance
- review verdict acceptance
- review feedback writeback
- issue breakdown writeback
- GitHub publication, review evidence read, feedback write, and merge checks
- operator approval creation or decision handling
- durable projection read/write where aliases can collide

## Failure Behavior

If zero contexts match:

- do not create a workspace
- do not dispatch an agent
- do not mutate Linear
- record a safe routing problem
- continue processing unrelated healthy contexts

If more than one context matches:

- do not choose by array order
- do not ask the agent to decide
- record a safe ambiguous-routing problem with candidate context ids
- require operator correction or an explicit context selector

If a persisted run has a context id that is no longer enabled:

- continue replay and diagnostics using the persisted context evidence
- do not dispatch new work unless the current configuration still provides a safe context or the operator explicitly restores/rebinds the context

## Agent Boundary

Agents may receive context metadata needed for local work, such as workspace path, codebase label, issue id, and project label. Agents MUST NOT be allowed to change:

- `projectContextId`
- Linear project target
- GitHub publication target
- workspace root/source policy
- service-owned writeback target

Completion reports and review verdicts that contain mismatched context claims are treated as non-authoritative and must be validated against the service-owned context.

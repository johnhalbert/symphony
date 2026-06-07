# Contract: Multi-Project Configuration

## Purpose

Define how a workflow declares multiple project contexts while preserving current single-project workflow behavior.

## Legacy Compatibility

When `project_contexts` is absent, Symphony MUST normalize existing top-level project-specific settings into one context:

```yaml
project_contexts:
  - id: default
    label: Default
    tracker: <top-level tracker>
    workspace: <top-level workspace>
    github: <top-level github>
    review_loop: <top-level review_loop>
    issue_breakdown: <top-level issue_breakdown>
    agent: <top-level project-specific agent settings>
    credential_profiles: <top-level credential profile assignments>
```

This compatibility mapping is internal. Operators do not need to edit existing valid workflows to keep using one project.

## Explicit Multi-Project Shape

```yaml
project_contexts:
  - id: symphony
    label: Symphony
    tracker:
      kind: linear
      project_slug: $SYMPHONY_LINEAR_PROJECT
      active_states:
        - Todo
        - In Progress
    workspace:
      root: ./symphony_workspaces
      state_dir: ./.symphony
      source:
        kind: git_worktree
        repository: .
        base_ref: origin/main
        branch_template: "symphony/{{ project.id }}/{{ issue.identifier }}"
        cleanup: refuse_dirty
    github:
      owner: johnhalbert
      repo: symphony

  - id: docs
    label: Documentation Site
    tracker:
      kind: linear
      project_slug: $DOCS_LINEAR_PROJECT
    workspace:
      root: ./symphony_workspaces
      source:
        kind: git_worktree
        repository: ../docs-site
        base_ref: origin/main
        branch_template: "symphony/{{ project.id }}/{{ issue.identifier }}"
```

## Inheritance Rules

- Global settings that are truly service-wide remain global, such as server host/port, polling interval, database configuration, and global runtime defaults.
- Project-specific settings MAY inherit from top-level defaults when a context omits them.
- A project context override MUST be evaluated before any workflow-affecting action for that context.
- Secret-bearing values MUST remain environment references or credential profile references.

## Validation Rules

- `project_contexts` must be a non-empty array when present.
- `id` must be unique after trimming and normalization.
- `id` must be safe for durable keys and display.
- Enabled contexts must provide a Linear project slug.
- Enabled contexts must provide a workspace codebase source sufficient for the selected source kind.
- A repeated Linear project or repeated codebase source is allowed only when context ids make routing unambiguous.
- If a top-level and context-specific setting conflict, the context-specific setting wins for that context.
- Unknown context ids in persisted inputs, operator requests, or context filters fail closed with a safe error.

## Redaction Rules

Operator-facing validation output MAY include:

- project context id
- project context label
- Linear project slug
- codebase label or repository/path summary
- missing capability/profile name

Operator-facing output MUST NOT include:

- API keys
- tokens
- private keys
- raw environment variable values
- credential profile secret material
- provider account contents

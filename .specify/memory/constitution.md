<!--
Sync Impact Report
Version change: 1.0.0 -> 1.1.0
Modified principles:
- III. Testable Contracts Before Implementation: expanded to require the
  fenced JSON issue contract before issue delegation or promotion
Added sections:
- Issue Contract Governance
Removed sections:
- None
Templates requiring updates:
- UPDATED .specify/templates/plan-template.md
- UPDATED .specify/templates/spec-template.md
- UPDATED .specify/templates/tasks-template.md
- N/A .specify/templates/commands/*.md (directory is absent in this checkout)
- INSPECTED .specify/extensions/*/commands/*.md (no stale single-agent command references)
Runtime guidance updated:
- UPDATED docs/agent-eligible-issue-template.md
- UPDATED docs/dogfood-runbook.md
- UPDATED docs/trust-and-safety.md
- UPDATED WORKFLOW.md
Follow-up TODOs:
- None
-->

# Symphony Constitution

## Core Principles

### I. Service-Owned Authority Boundaries

Symphony MUST own orchestration lifecycle decisions, run records, workspace
records, transcript persistence, tracker writeback, pull-request publication,
review writeback, merge gates, and other external workflow mutations. Runtime
workers and reviewers MUST work only inside their assigned scope and hand off
through Symphony-owned MCP, completion-report, review-verdict, or configured
service paths. Agents MUST NOT directly change Linear lifecycle state, publish
or mutate lifecycle-bound pull requests, merge branches, push to protected
branches, force-push, or perform service-owned writeback unless a feature
explicitly defines and gates a new service-owned path.

Rationale: Symphony is an orchestrator. Keeping external authority in the
service layer preserves auditability, prevents credential prompts and hidden
side effects, and lets workers and reviewers remain delegated execution roles
rather than uncontrolled workflow owners.

### II. Least-Privilege Credentials And Secret Hygiene

Credential use MUST be capability-scoped by role and service path. Secrets,
tokens, private keys, credential values, customer-private data, and raw external
credential material MUST NOT appear in issue descriptions, generated prompts,
workflow configuration values, denial messages, logs, transcripts, test output,
or Spec Kit artifacts. Workflow configuration MUST reference secret-bearing
environment variables or configured credential profiles rather than storing
secret values. Ambiguous access paths that could use credentials or contact an
upstream service MUST fail closed until the service-owned capability boundary is
clear and testable.

Rationale: Dogfood runs exercise real local and external integrations. Narrow
capabilities and redacted evidence let Symphony operate safely without turning
agent prompts or durable records into credential stores.

### III. Testable Contracts Before Implementation

Every feature MUST define prioritized, independently testable user stories,
acceptance scenarios, measurable success criteria, and explicit assumptions
before implementation work begins. Every Symphony-tracked issue intended for
planning, implementation, review, tracker writeback, or agent dispatch MUST
include the fenced JSON issue contract defined in Issue Contract Governance
before promotion or delegation. Implementation plans MUST identify the concrete
touched surfaces, contract boundaries, and smallest meaningful validation for
each story. Tasks MUST list required tests or validation work before the
implementation tasks they protect. Shared orchestration, workflow, tracker,
harness, persistence, credential, policy, or public API changes MUST include
targeted regression tests and broader validation proportional to their blast
radius.

Rationale: Symphony coordinates autonomous implementation and review. Clear
contracts and early validation keep delegated work reviewable, incrementally
deliverable, and less likely to drift from operator intent.

### IV. Durable Audit, Replay, And Idempotence

Workflow-affecting decisions MUST leave durable, redacted evidence sufficient to
reconstruct what happened during replay, review, and operator diagnosis.
Lifecycle writeback, publication, review feedback, merge checks, policy
decisions, cancellation, and retry behavior MUST be idempotent or guarded by
stored state and current-state rechecks. Features that change run activity,
transcripts, projections, tracker writeback, or service-owned external effects
MUST validate replay or restart behavior and ensure records distinguish policy
enforcement, implementation defects, service failures, and human-required
states.

Rationale: Symphony's reliability depends on understanding prior runs and
continuing safely after retries, restarts, and external state changes. Durable
evidence turns orchestration behavior into something operators can inspect
rather than guess about.

### V. Scoped Change Ownership And Protected Surfaces

Changes MUST stay within the ownership boundaries and modules identified by the
plan. Protected areas, including workflow safety docs, orchestration, runtime
harnesses, tracker integration, credential configuration, and generated runtime
templates, require explicit plan coverage and validation before dispatch or
promotion. Vendored upstream source, especially `hermes/upstream-src/**`, MUST
NOT be changed for Symphony policy enforcement unless the feature explicitly
ratifies that ownership change, documents why no Symphony-owned path can work,
and includes a migration and rollback plan. Dirty worktrees, protected branches,
and operator-controlled workflow state MUST NOT be cleaned up, reset, or mutated
implicitly.

Rationale: Symphony composes local service code, generated profiles, vendored
runtime code, and external systems. Respecting ownership boundaries keeps fixes
focused and prevents subtle regressions in upstream or operator-controlled
surfaces.

## Operational Constraints

Symphony is a TypeScript 6.x, Node.js ES2022/NodeNext orchestration service with
CLI, runtime harness, MCP, web status API, VS Code/Cursor extension, local file
state, and PostgreSQL-backed projections where configured. Feature plans MUST
record the actual runtime, storage, harness, and platform assumptions they touch
instead of relying on generic template defaults.

Windows local development is first-class. Command policies, path handling,
workspace management, generated profiles, and validation instructions MUST
account for Windows PowerShell paths and POSIX-like shell paths when those
surfaces are in scope.

External workflow mutations MUST flow through configured service-owned paths:
Linear tracker/writeback, GitHub publication/review feedback/merge, runtime
handoff MCP tools, and operator controls. Agent-owned terminal or code-execution
paths MUST NOT be used to bypass those services.

## Issue Contract Governance

Every new Symphony-tracked issue MUST include a fenced `json` block in the
issue description before it is promoted, delegated, split into subtasks, or
accepted for agent work. That block is the authoritative issue requirements
contract. Linear form templates, labels, prose acceptance criteria, checklists,
and validation notes MAY help authors and reviewers, but they MUST NOT replace
the fenced JSON contract.

The issue contract MUST use this shape:

```json
{
  "schemaVersion": 1,
  "contractVersion": "2026-06-04.1",
  "requirements": [
    {
      "id": "REQ-001",
      "requirement": "Worker completion must prove the required behavior.",
      "proofHint": "Optional non-authoritative evidence guidance."
    }
  ]
}
```

`schemaVersion` MUST be a positive integer. `contractVersion` MUST be a
non-empty, human-managed opaque version string and MUST be updated when the
issue's obligations materially change. `requirements` MUST be a non-empty array
of required obligations. Each requirement `id` MUST be non-empty, stable, and
unique within the issue. Each `requirement` MUST be non-empty, human-readable
requirement text. `proofHint` MAY be supplied only as non-authoritative guidance
for useful worker evidence.

Symphony MUST treat the parsed issue description JSON as the source of truth,
canonicalize it, and compute a machine `contractHash` so stale or unversioned
contract edits can be detected. Agent-eligible issue preflight MUST fail closed
when the fenced JSON block is missing, invalid, empty, duplicated, or otherwise
fails schema validation. Completion-report and reviewer flows that enforce issue
proof MUST compare worker proof against the active `schemaVersion`,
`contractVersion`, `contractHash`, and exact requirement ID set before
writeback, PR handoff, or reviewer dispatch.

## Development Workflow And Quality Gates

Spec Kit artifacts MUST remain aligned:

- `spec.md` defines the user stories, requirements, authority boundaries,
  credential and redaction constraints, issue-contract source obligations,
  success criteria, and assumptions.
- `plan.md` defines the implementation surfaces, Constitution Check, complexity
  exceptions, validation strategy, and any protected-surface handling.
- `tasks.md` orders work by setup, foundational gates, independently testable
  user stories, validation, promotion checkpoints, and issue-contract coverage
  for any generated tracker issues.

The Constitution Check in every plan MUST explicitly evaluate the five core
principles. A plan that violates a principle MUST record the violation in
Complexity Tracking with the reason, simpler alternative rejected, risk, and
validation required to accept the exception.

Before promotion, each feature MUST run the smallest meaningful validation for
the changed surface and broader validation for shared orchestration, workflow,
tracker, harness, persistence, credential, policy, or public API changes.
Validation evidence MUST be recorded in completion reports, review evidence, or
the relevant Spec Kit artifact.

## Governance

This constitution supersedes conflicting informal project practices and Spec
Kit template defaults. Direct user instructions and session contracts can
choose scope for a specific task, but they do not waive these principles unless
the waiver is explicit, documented in the plan, and accepted as a complexity
exception.

Amendments MUST update this file, include a Sync Impact Report, and reconcile
dependent Spec Kit templates, active feature plans, runtime guidance docs, and
agent-context guidance when they are affected. Amendments MUST state the version
bump rationale using semantic versioning:

- MAJOR for backward-incompatible governance changes, removed principles, or
  redefined authority boundaries.
- MINOR for new principles, new mandatory gates, or materially expanded
  governance guidance.
- PATCH for clarifications, typo fixes, or non-semantic refinements.

Compliance review is required during planning and review. Reviewers MUST check
that the plan's Constitution Check is accurate, that tasks include the required
validation gates, and that implemented changes preserve service authority,
credential hygiene, issue-contract coverage, durable auditability, and ownership
boundaries. Any principle violation discovered during implementation MUST be
resolved or documented as an accepted complexity exception before promotion.

**Version**: 1.1.0 | **Ratified**: 2026-06-02 | **Last Amended**: 2026-06-04

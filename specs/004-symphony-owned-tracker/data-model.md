# Data Model: Symphony Owned Tracker

## Symphony Issue

Represents a tracker-owned work item returned as the existing runtime `Issue` shape.

### Fields

- `issue_key`: Durable Symphony issue key used for lifecycle, run, and writeback correlation.
- `tracker_source`: Provider identifier; native tracker rows use `symphony`.
- `issue_identifier`: Human-readable issue identifier used in prompts, routes, and operator workflows.
- `title`: Required non-empty title.
- `description`: Optional issue description; agent-eligible issues must include the fenced JSON issue contract before dispatch.
- `priority`: Optional numeric priority compatible with current issue sorting semantics.
- `state`: Required workflow state name.
- `branch_name`: Optional branch hint used by workspace and PR flows.
- `url`: Optional operator-facing URL or route.
- `assignee_id`: Optional assignee route key.
- `delegate_id`: Optional delegate route key.
- `assigned_to_worker`: Boolean worker-routing eligibility produced by native tracker semantics.
- `labels`: Set of normalized label names used by include/exclude guardrails.
- `tracker_created_at`: Source creation timestamp.
- `tracker_updated_at`: Source update timestamp.
- `created_at`: Datastore row creation timestamp.
- `updated_at`: Datastore row update timestamp.

### Validation Rules

- `issue_key`, `issue_identifier`, `title`, and `state` are required.
- `issue_identifier` is unique within the native tracker source.
- Labels are trimmed, lower-case normalized for comparisons, and have no empty values.
- State names are stored as configured display names but comparisons remain case-insensitive.
- `assigned_to_worker` must be deterministic from configured routing fields or explicit native tracker row data.
- `description` may be null for non-agent-eligible issues, but agent-eligible dispatch still fails closed through existing issue contract linting when the fenced JSON contract is missing or invalid.

## Issue Blocker Reference

Represents the native tracker relationship that one issue is blocked by another issue.

### Fields

- `blocked_issue_key`: Durable issue key for the issue being blocked.
- `blocker_issue_key`: Durable issue key for the blocking issue, when known.
- `blocker_identifier`: Human-readable blocker identifier.
- `blocker_state`: Current blocker state, nullable when unknown.
- `created_at`: Relationship creation timestamp.
- `updated_at`: Relationship update timestamp.

### Validation Rules

- A blocked issue cannot block itself.
- Duplicate blocker references for the same blocked issue and blocker identity are rejected or verified as already present.
- A null blocker state is treated as open.
- A blocker state matching a configured terminal state is treated as resolved for dispatch.
- Unknown blocker issues may be represented only when an identifier or external reference exists and the state is null.

## Issue Comment

Represents a service-owned tracker comment written by Symphony.

### Fields

- `comment_id`: Durable comment key.
- `issue_key`: Issue that owns the comment.
- `body`: Comment body.
- `dedupe_key`: Idempotency key from the writeback request.
- `created_at`: Comment creation timestamp.
- `updated_at`: Comment update timestamp.

### Validation Rules

- `issue_key`, `body`, and `dedupe_key` are required.
- `dedupe_key` is unique per issue.
- Retrying the same comment dedupe key verifies the existing comment instead of creating a duplicate.
- Comment body must not store credential values or raw secret material.

## Issue State Transition

Represents durable evidence for a native tracker state transition.

### Fields

- `transition_id`: Durable transition key.
- `issue_key`: Issue transitioned.
- `from_state`: Prior state.
- `to_state`: New state.
- `reason`: Optional service-owned reason.
- `dedupe_key`: Optional idempotency key when supplied by the caller or derived from the writeback operation.
- `created_at`: Transition timestamp.

### Validation Rules

- `issue_key`, `from_state`, and `to_state` are required.
- `from_state` must match the current issue state when the caller supplies allowed source states.
- Transition writes must be atomic with the issue's current `state` and `updated_at` update.
- Retries must verify an already-applied transition or fail closed when the current state conflicts with the requested transition.

## Tracker Selection

Represents the workflow configuration choice for tracker provider.

### Values

- `linear`: Existing Linear tracker integration.
- `symphony`: Native Symphony-owned tracker using the configured datastore.

### Validation Rules

- `linear` preserves existing Linear endpoint, API key, project slug, and assignee validation.
- `symphony` requires a configured Postgres connection and must not require Linear credentials or project slug.
- Unknown tracker kinds fail configuration validation.

## Relationships

- One Symphony Issue can have many Issue Blocker References.
- One Symphony Issue can have many Issue Comments.
- One Symphony Issue can have many Issue State Transitions.
- Issue Blocker References can point to another Symphony Issue by durable key or represent an unknown external blocker by identifier with null state.

## State Transitions

The native tracker does not define its own workflow vocabulary. It stores configured state names and lets existing Symphony runtime state lists classify active, review, blocked, handoff, and terminal behavior.

Transition requests follow current writeback semantics:

1. Fetch current issue by durable ID.
2. If allowed source states were supplied, verify the current state is one of them.
3. If current state already equals the target state, return verified/skipped behavior.
4. Otherwise update issue state and record transition evidence atomically.
5. If the issue cannot be found, state cannot be proven, or a concurrent change conflicts, fail closed.

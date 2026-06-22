# Contract: Symphony Tracker Provider

This contract defines the MVP behavior a tracker provider must satisfy to stand in for Linear in Symphony runtime flows.

## Provider Selection

- `tracker.kind = "linear"` selects the existing Linear provider and keeps current Linear credential validation.
- `tracker.kind = "symphony"` selects the Symphony-owned provider.
- Unknown tracker kinds fail workflow configuration validation.
- The Symphony-owned provider requires configured Postgres datastore access and fails closed when the datastore is unavailable at startup or during writeback.

## Read Contract

The selected provider must implement the existing `TrackerClient` behavior:

```ts
fetchCandidateIssues(): Promise<Issue[]>
fetchIssuesByStates(stateNames: string[]): Promise<Issue[]>
fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]>
```

### `fetchCandidateIssues`

- Returns issues in configured active states that are eligible for worker routing.
- Applies provider-specific routing so `Issue.assignedToWorker` has the same meaning as the current runtime expects.
- Returns only normalized `Issue` values with required identity, title, and state fields.

### `fetchIssuesByStates`

- Returns issues whose current state matches any requested state name.
- State matching is case-insensitive for comparisons while preserving configured display names in returned issues.
- Empty state input returns an empty list.

### `fetchIssueStatesByIds`

- Returns current issue state snapshots for each requested durable ID.
- For the Symphony-owned provider, also resolves human identifiers because runtime/operator APIs accept issue ID or identifier.
- Duplicate identifier matches fail closed instead of returning an arbitrary issue.
- Missing issues are omitted from the result, matching current tracker behavior.

## Returned `Issue` Semantics

Returned issues must satisfy the runtime compatibility contract:

- `id`: Stable durable issue key used for lifecycle, run, and writeback records.
- `identifier`: Stable human-readable key used for prompts and operator routes.
- `title`: Non-empty title.
- `description`: Nullable description; agent-eligible issues still require the fenced JSON issue contract.
- `priority`: Nullable priority compatible with existing issue sorting.
- `state`: Current state name.
- `branchName`: Nullable branch hint.
- `url`: Nullable operator-facing URL.
- `assigneeId`: Nullable assignee route key.
- `delegateId`: Nullable delegate route key.
- `assignedToWorker`: Boolean worker-routing eligibility.
- `labels`: Normalized label names for guardrails.
- `blockedBy`: Blocker references with blocker ID, identifier, and state.
- `createdAt`: Nullable tracker creation timestamp.
- `updatedAt`: Nullable tracker update timestamp.

## Blocker Semantics

- A blocker with `state = null` is open.
- A blocker whose state does not match configured terminal states is open.
- A blocker whose state matches configured terminal states is resolved.
- Candidate worker issues in todo-like active states and reviewer issues must not dispatch while any blocker is open.

## Write Contract

The selected provider must implement required `TrackerWriter` methods for MVP writeback:

```ts
transitionIssueState(input: TrackerTransitionInput): Promise<TrackerWriteResult>
createIssueComment(input: TrackerCommentInput): Promise<TrackerWriteResult>
```

### State Transition

- Verifies the issue exists.
- Verifies allowed source states when supplied.
- Applies the transition atomically with durable evidence.
- Returns `verified` when the requested target state has already been reached through the same logical effect.
- Fails closed when the current state cannot be proven or conflicts with requested allowed source states.

### Comment Writeback

- Requires a non-empty body and dedupe key.
- Creates one logical comment per issue and dedupe key.
- Returns `verified` on retry when the same dedupe key already exists.
- Does not expose datastore credentials or raw secret material in result messages.

## Optional Write Methods

The MVP may leave these unsupported:

```ts
createIssueFromPlan?(input: TrackerIssueCreateInput): Promise<TrackerWriteResult>
createIssueRelation?(input: TrackerIssueRelationInput): Promise<TrackerWriteResult>
```

Unsupported optional methods must fail closed with an explicit unsupported-operation result or error at the existing writeback boundary. They must not be silently ignored.

## Diagnostics Contract

Tracker diagnostics must report:

- selected tracker kind;
- datastore availability for the Symphony-owned tracker;
- candidate read health;
- state-list compatibility with configured workflow states;
- writeback capability status for transitions and comments;
- unsupported optional writeback capabilities when applicable.

Linear-specific diagnostics must run only when Linear is selected.

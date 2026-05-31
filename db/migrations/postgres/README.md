# Symphony Postgres owned-state schema

`0001_symphony_owned_state.sql` is the first migration-ready Postgres schema for Symphony-owned operational state and durable frontend projection/read models.

## Source-of-truth boundaries

External systems remain authoritative for their own records and side effects:

- **Linear** remains authoritative for tracker issues, labels, blockers, lifecycle state names, and tracker comments/transitions.
- **GitHub** remains authoritative for pull requests, reviews, checks, mergeability, and merge outcomes.
- **Git worktrees** remain authoritative for repository contents, branch checkouts, and local filesystem state.
- **Runtime harnesses and external agent sessions** remain authoritative for live execution and raw session streams while they are running.

Symphony stores durable local state that it owns: snapshots, cursors, correlations, normalized transcript/activity events, writeback and approval operation state, lifecycle counters/handoff summaries, and frontend projections derived from those inputs.

## Transition policy for file-backed state

This migration is additive. It does not add a database configuration switch and does not change the existing `FileRunTranscriptStore`, `FileIssueLifecycleStore`, writeback outbox, or approval-store code paths. During the transition, existing JSON/JSONL state under the workspace `stateDir` can continue to run as the active persistence mechanism.

A later persistence layer can import or dual-write file-backed records into these tables. The schema intentionally keeps cross-table references loose for externally sourced identifiers so partial durable records can be migrated in dependency-safe order.

## Table coverage

Owned operational tables:

- `workspace`
- `issue`
- `run_session`
- `run_activity_event`
- `chat_message`
- `writeback_operation`
- `approval_request`
- `external_sync_cursor`

Durable frontend projection tables:

- `projection_revision`
- `dashboard_projection`
- `issue_board_projection`
- `sidebar_projection`
- `history_projection`
- `transcript_projection`
- `orchestrator_chat_projection`

The migration also adds `raw_payload_reference`, a policy/support table for oversized raw harness payloads.

## Oversized raw harness payload policy

Projection payload JSONB and event payload JSONB are for normalized, redacted, size-capped data that is safe to serve to frontend/status clients. Raw harness payloads must not be blindly embedded into projection JSON.

When raw tool output, harness payloads, or diagnostic payloads exceed the inline cap or need byte-for-byte retention:

1. Store the raw bytes in controlled file/object storage using the existing secret-redaction rules.
2. Record a `raw_payload_reference` row with `storage_uri`, `sha256`, `byte_length`, `media_type`, optional compression, and redaction status.
3. Link operational rows with `raw_payload_ref_id` or projection rows with `raw_payload_refs` arrays.
4. Keep projection `payload` fields sanitized and bounded; use previews/counts/digests instead of raw bodies.

## Validation

The static Vitest coverage in `tests/postgres-schema.test.ts` asserts required tables, indexes, source-boundary notes, transition policy, and oversized-payload policy. The same test file includes an opt-in Docker-backed validation that applies the migration to an empty `postgres:16-alpine` database:

```bash
SYMPHONY_POSTGRES_SCHEMA_VALIDATE_DOCKER=1 npx vitest run tests/postgres-schema.test.ts --no-file-parallelism
```

Without that environment variable, the Docker-backed case is skipped so the default repository test suite does not require Docker. Worker/release validation for this migration should run the opt-in command when a local Docker engine or Postgres validation environment is available.

# Postgres migrations

This directory is the configured Symphony Postgres migration path. `database.postgres.migrations_dir` defaults here (`migrations/postgres`) when `WORKFLOW.md` does not override it, and the `migrations:validate` / `migrations:apply` CLI commands discover SQL files from this directory in filename order.

Migration files use the `NNNN_description.sql` naming convention. The migration runner stores applied checksums in `symphony_schema_migrations` inside the target database and wraps each migration file in its own transaction, so migration SQL files should not include explicit `BEGIN` / `COMMIT` statements.

See [State Ownership and Migration Compatibility](../../docs/state-ownership-and-migration.md) for the canonical/snapshot/projection ownership map, external authority boundaries, startup recovery scenarios, and file-backed migration constraints that apply to this configured migration surface.

Current migrations:

- `0001_migration_foundation.sql` establishes the runner baseline.
- `0002_symphony_owned_state.sql` creates Symphony-owned operational state and durable frontend projection tables, including the `symphony.run_session` and `symphony.run_activity_event` tables used by `PostgresRunActivityAppendStore`. This migration is published and checksum-stable; do not edit it after release.
- `0003_projection_freshness_indexes.sql` adds projection `updated_at` freshness columns and replaces projection read indexes so databases that already applied `0002` can upgrade without migration-checksum conflicts.
- `0004_run_activity_canonical_channels.sql` updates the `symphony.run_activity_event.channel` constraint from adapter-facing `message` / `status` aliases to the canonical frontend `chat` / `diagnostic` channels, and rewrites existing rows during upgrade.
- `0005_projection_source_freshness.sql` adds durable `projection_revision.source_freshness` metadata, backfills rows that already embedded freshness in `source_cursors`, and indexes per-source freshness for status/projection readers.
- `0006_projection_build_modes.sql` adds durable `projection_revision.build_mode` metadata so readers and rebuild reports can distinguish first-scope bootstrap revisions, on-demand incremental/read-repair revisions, and explicit rebuild/backfill revisions.
- `0007_project_context_attribution.sql` adds `project_context_id`, `project_context_label`, and `tracker_project_slug` columns plus lookup indexes on `workspace`, `issue`, and `run_session` so Postgres-backed reads can disambiguate overlapping identifiers across configured project contexts.

Common development commands:

- `npm run migrations:validate -- WORKFLOW.md` checks configured migration discovery and ordering without opening a database connection.
- `npm run migrations:apply -- WORKFLOW.md` applies configured migrations when `database.postgres.url` or `SYMPHONY_POSTGRES_URL` is configured.

The database URL is optional. When it is unset, normal file-backed Symphony startup continues to use the existing stores, and migrations are only validated or applied when these commands are run explicitly.

## Source-of-truth boundaries

External systems remain authoritative for their own records and side effects:

- **Linear** remains authoritative for tracker issues, labels, blockers, lifecycle state names, and tracker comments/transitions.
- **GitHub** remains authoritative for pull requests, reviews, checks, mergeability, and merge outcomes.
- **Git worktrees** remain authoritative for repository contents, branch checkouts, and local filesystem state.
- **Runtime harnesses and external agent sessions** remain authoritative for live execution and raw session streams while they are running.

Symphony stores durable local state that it owns: snapshots, cursors, correlations, normalized transcript/activity events, writeback and approval operation state, lifecycle counters/handoff summaries, and frontend projections derived from those inputs.

## Transition policy for file-backed state

`0002_symphony_owned_state.sql` is additive. It does not add a database configuration switch and does not change the existing `FileRunTranscriptStore`, `FileIssueLifecycleStore`, writeback outbox, or approval-store code paths. During the transition, existing JSON/JSONL state under the workspace `stateDir` can continue to run as the active persistence mechanism.

A later persistence layer can import or dual-write file-backed records into these tables. The schema intentionally keeps cross-table references loose for externally sourced identifiers so partial durable records can be migrated in dependency-safe order.

## Table coverage

Owned operational tables:

- `raw_payload_reference`
- `workspace`
- `issue`
- `run_session`
- `run_activity_event` (stable `event_id`, explicit `run_session_id` ordering/idempotency scope, preserved-or-assigned `sequence` with `sequence_source`, append revision identity, actor/channel/kind taxonomy fields, optional `external_event_id`, structured payload, text, and oversized raw payload reference hooks)
- `chat_message` (thread/message ordering, role/status/body fields, event sequence range pointers for reconstruction, metadata, and oversized raw payload reference hooks)
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

## Oversized raw harness payload policy

Projection payload JSONB and event payload JSONB are for normalized, redacted, size-capped data that is safe to serve to frontend/status clients. Raw harness payloads must not be blindly embedded into projection JSON.

When raw tool output, harness payloads, or diagnostic payloads exceed the inline cap or need byte-for-byte retention:

1. Store the raw bytes in controlled file/object storage using the existing secret-redaction rules.
2. Record a `raw_payload_reference` row with `storage_uri`, `sha256`, `byte_length`, `media_type`, optional compression, and redaction status.
3. Link operational rows with `raw_payload_ref_id` or projection rows with `raw_payload_refs` arrays.
4. Keep projection `payload` fields sanitized and bounded; use previews/counts/digests instead of raw bodies.

## Validation

Static Vitest coverage in `tests/postgres-schema.test.ts` asserts that the configured migration path contains the owned-state schema and that it declares the required tables, indexes, source-boundary notes, transition policy, run activity/chat reconstruction fields, run-session scoped duplicate constraints, and oversized-payload policy.

The opt-in Docker-backed validation applies the configured migrations to an empty `postgres:16-alpine` database, verifies the migration ledger, exercises basic operational/projection insert and query paths, checks projection `updated_at` columns, source freshness metadata, build-mode metadata, project-context attribution columns, and read-index definitions, and runs a real `PostgresRunActivityAppendStore` append plus duplicate/no-op replay path against the migrated schema. It also validates the upgrade path from a database that already recorded the published `0002_symphony_owned_state.sql` checksum before applying the follow-up projection freshness, canonical run-activity-channel, projection source-freshness, projection build-mode, and project-context attribution migrations:

```bash
SYMPHONY_POSTGRES_SCHEMA_VALIDATE_DOCKER=1 npx vitest run tests/postgres-schema.test.ts --no-file-parallelism
```

Without that environment variable, the Docker-backed case is skipped so the default repository test suite does not require Docker. Worker/release validation for this migration should run the opt-in command when a local Docker engine or Postgres validation environment is available.

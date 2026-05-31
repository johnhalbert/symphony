import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  applyConfiguredPostgresMigrations,
  discoverPostgresMigrations,
} from "../src/core/database/PostgresMigrations.js";
import {
  PostgresRunActivityAppendStore,
  type PostgresRunActivityAppendClient,
  type RunActivityAppendInput,
} from "../src/core/persistence/RunActivityAppendStore.js";

const execFileAsync = promisify(execFile);

const configuredMigrationsDirUrl = new URL("../migrations/postgres/", import.meta.url);
const configuredMigrationsDir = fileURLToPath(configuredMigrationsDirUrl);
const migrationUrl = new URL("../migrations/postgres/0002_symphony_owned_state.sql", import.meta.url);
const readmeUrl = new URL("../migrations/postgres/README.md", import.meta.url);

const operationalTables = [
  "workspace",
  "issue",
  "run_session",
  "run_activity_event",
  "chat_message",
  "writeback_operation",
  "approval_request",
  "external_sync_cursor",
] as const;

const projectionTables = [
  "projection_revision",
  "dashboard_projection",
  "issue_board_projection",
  "sidebar_projection",
  "history_projection",
  "transcript_projection",
  "orchestrator_chat_projection",
] as const;

const requiredLookupIndexes = [
  "run_session_lookup_idx",
  "run_session_issue_status_idx",
  "issue_status_lookup_idx",
  "run_activity_event_ordering_idx",
  "run_activity_event_run_ordering_idx",
  "run_activity_event_kind_time_idx",
  "run_activity_event_channel_kind_time_idx",
  "chat_message_ordering_idx",
  "chat_message_event_range_idx",
  "writeback_operation_state_idx",
  "approval_request_state_idx",
  "projection_revision_reads_idx",
] as const;

const requiredProjectionLookupIndexes = [
  "projection_revision_current_unique_idx",
  "dashboard_projection_scope_revision_idx",
  "dashboard_projection_revision_reads_idx",
  "issue_board_projection_scope_revision_idx",
  "issue_board_projection_revision_reads_idx",
  "sidebar_projection_scope_revision_idx",
  "sidebar_projection_revision_reads_idx",
  "history_projection_scope_revision_idx",
  "history_projection_revision_reads_idx",
  "history_projection_run_lookup_idx",
  "transcript_projection_scope_revision_idx",
  "transcript_projection_revision_reads_idx",
  "transcript_projection_session_reads_idx",
  "orchestrator_chat_projection_scope_revision_idx",
  "orchestrator_chat_projection_revision_reads_idx",
  "orchestrator_chat_projection_issue_idx",
] as const;

async function migrationSql(): Promise<string> {
  return readFile(migrationUrl, "utf8");
}

async function migrationReadme(): Promise<string> {
  return readFile(readmeUrl, "utf8");
}

function normalizedSql(sql: string): string {
  return sql.replace(/\s+/g, " ").toLowerCase();
}

describe("Postgres Symphony-owned state migration", () => {
  it("keeps the owned-state schema on the configured migration path after the runner baseline", async () => {
    const migrations = await discoverPostgresMigrations(configuredMigrationsDir);

    expect(migrations.map((migration) => migration.id)).toEqual(["0001_migration_foundation", "0002_symphony_owned_state"]);
    const ownedState = migrations.find((migration) => migration.id === "0002_symphony_owned_state");
    expect(ownedState?.filePath).toBe(fileURLToPath(migrationUrl));
    expect(ownedState?.sql).toContain("CREATE TABLE IF NOT EXISTS symphony.run_session");
    expect(ownedState?.sql).toContain("CREATE TABLE IF NOT EXISTS symphony.run_activity_event");
    expect(ownedState?.sql).toContain("run_activity_event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY");
    expect(ownedState?.sql).toContain("UNIQUE (run_session_id, sequence)");
    expect(ownedState?.sql).toContain("run_activity_event_external_event_unique_idx");
    expect(ownedState?.sql).not.toMatch(/^\s*(BEGIN|COMMIT);/im);
  });

  it("declares all required operational and projection tables", async () => {
    const normalized = normalizedSql(await migrationSql());

    for (const table of [...operationalTables, ...projectionTables]) {
      expect(normalized, `missing symphony.${table}`).toContain(`create table if not exists symphony.${table}`);
    }

    expect(normalized).toContain("create table if not exists symphony.raw_payload_reference");
  });

  it("declares lookup indexes for high-volume runtime and projection reads", async () => {
    const normalized = normalizedSql(await migrationSql());

    for (const indexName of [...requiredLookupIndexes, ...requiredProjectionLookupIndexes]) {
      expect(normalized, `missing ${indexName}`).toContain(`index if not exists ${indexName}`);
    }

    expect(normalized).toContain("on symphony.run_activity_event (run_session_id, sequence)");
    expect(normalized).toContain("on symphony.run_activity_event (run_id, run_session_id, sequence)");
    expect(normalized).toContain("on symphony.run_activity_event (kind, event_at desc)");
    expect(normalized).toContain("on symphony.run_activity_event (channel, kind, event_at desc)");
    expect(normalized).toContain("create unique index if not exists run_activity_event_external_event_unique_idx");
    expect(normalized).toContain("on symphony.run_activity_event (run_session_id, external_event_id)");
    expect(normalized).toContain("where external_event_id is not null");
    expect(normalized).toContain("on symphony.chat_message (thread_key, message_index)");
    expect(normalized).toContain("on symphony.chat_message (run_id, event_sequence_start, event_sequence_end)");
    expect(normalized).toContain("on symphony.writeback_operation (status, next_attempt_at, created_at)");
    expect(normalized).toContain("on symphony.approval_request (status, expires_at, requested_at)");
    expect(normalized).toContain("on symphony.projection_revision (projection_name, scope_kind, scope_key, revision desc, updated_at desc, generated_at desc)");
    expect(normalized).toContain("on symphony.dashboard_projection (scope_key, revision desc, updated_at desc, generated_at desc)");
    expect(normalized).toContain("on symphony.transcript_projection (run_id, revision desc, updated_at desc, generated_at desc)");
    expect(normalized).toContain("on symphony.orchestrator_chat_projection (scope_key, conversation_key, revision desc, updated_at desc, generated_at desc)");
  });

  it("declares run activity and chat message fields for replay, reconstruction, and idempotency", async () => {
    const normalized = normalizedSql(await migrationSql());

    for (const fragment of [
      "event_id text not null",
      "run_session_id text not null",
      "sequence_source text not null check",
      "protocol text not null check",
      "external_event_id text",
      "actor text not null check",
      "channel text not null check",
      "kind text not null",
      "text text",
      "payload jsonb not null default '{}'::jsonb",
      "payload_truncated boolean not null default false",
      "payload_byte_length bigint check",
      "raw_payload_ref_id bigint references symphony.raw_payload_reference(raw_payload_ref_id)",
      "unique (event_id)",
      "unique (run_session_id, sequence)",
    ]) {
      expect(normalized, `missing run_activity_event fragment: ${fragment}`).toContain(fragment);
    }

    for (const fragment of [
      "message_id text not null",
      "role text not null check",
      "status text not null default 'completed' check",
      "body text not null default ''",
      "body_truncated boolean not null default false",
      "event_sequence_start integer check",
      "event_sequence_end integer check",
      "metadata jsonb not null default '{}'::jsonb",
      "unique (message_id)",
      "unique (thread_key, message_index)",
      "check (event_sequence_end is null or event_sequence_start is not null)",
      "check (event_sequence_start is null or event_sequence_end is null or event_sequence_end >= event_sequence_start)",
    ]) {
      expect(normalized, `missing chat_message fragment: ${fragment}`).toContain(fragment);
    }
  });

  it("documents external authorities, file-backed transition, and oversized raw payload references", async () => {
    const sql = (await migrationSql()).toLowerCase();
    const readme = (await migrationReadme()).toLowerCase();
    const combined = `${sql}\n${readme}`;

    for (const authority of ["linear", "github", "git worktrees", "runtime harnesses", "external agent sessions"]) {
      expect(combined).toContain(authority);
    }

    expect(combined).toContain("file-backed");
    expect(combined).toContain("existing json/jsonl state");
    expect(combined).toContain("raw_payload_reference");
    expect(combined).toContain("raw harness payloads must not be blindly embedded into projection json");
    expect(sql).toContain("raw_payload_refs jsonb not null default '[]'::jsonb");
  });

  it("keeps projection payloads tied to durable revision metadata", async () => {
    const normalized = normalizedSql(await migrationSql());

    expect(normalized).toContain("create table if not exists symphony.projection_revision");
    expect(normalized).toContain("projection_name text not null check");
    expect(normalized).toContain("unique (projection_name, scope_kind, scope_key, revision)");
    expect(normalized).toContain("updated_at timestamptz not null default now()");

    for (const table of projectionTables.filter((table) => table !== "projection_revision")) {
      expect(normalized, `missing revision FK for ${table}`).toContain(
        `create table if not exists symphony.${table} ( projection_revision_id bigint primary key references symphony.projection_revision(projection_revision_id) on delete cascade`,
      );
      expect(normalized, `missing read index for ${table}`).toContain(`${table}_revision_reads_idx`);
    }

    for (const table of projectionTables) {
      const tableStart = normalized.indexOf(`create table if not exists symphony.${table}`);
      expect(tableStart, `missing ${table}`).toBeGreaterThanOrEqual(0);
      const tableEnd = normalized.indexOf(");", tableStart);
      expect(tableEnd, `unterminated table definition for ${table}`).toBeGreaterThan(tableStart);
      const definition = normalized.slice(tableStart, tableEnd);
      expect(definition, `missing revision column for ${table}`).toContain("revision bigint not null check (revision > 0)");
      expect(definition, `missing updated_at for ${table}`).toContain("updated_at timestamptz not null default now()");
    }
  });

  const liveIt = process.env.SYMPHONY_POSTGRES_SCHEMA_VALIDATE_DOCKER === "1" ? it : it.skip;

  liveIt(
    "applies configured migrations and supports append-store paths via Docker",
    async () => {
      const containerName = `symphony-postgres-schema-${process.pid}-${Date.now()}`;
      try {
        await docker(
          [
            "run",
            "--rm",
            "--name",
            containerName,
            "-e",
            "POSTGRES_HOST_AUTH_METHOD=trust",
            "-p",
            "127.0.0.1::5432",
            "-d",
            "postgres:16-alpine",
          ],
          60_000,
        );
        await waitForPostgres(containerName);
        const connectionString = await postgresConnectionString(containerName);
        await applyConfiguredMigrations(connectionString);

        const appliedMigrations = await psql(containerName, "select id from symphony_schema_migrations order by id;");
        expect(appliedMigrations.trim().split(/\s+/)).toEqual(["0001_migration_foundation", "0002_symphony_owned_state"]);

        const tableCount = await psql(
          containerName,
          "select count(*) from information_schema.tables where table_schema = 'symphony';",
        );
        expect(Number(tableCount.trim())).toBe([...operationalTables, ...projectionTables, "raw_payload_reference"].length);

        const indexes = await psql(containerName, "select indexname from pg_indexes where schemaname = 'symphony' order by indexname;");
        for (const indexName of [...requiredLookupIndexes, ...requiredProjectionLookupIndexes]) {
          expect(indexes).toContain(indexName);
        }

        await expectOperationalAndProjectionInsertQueryPaths(containerName);
        await expectRunActivityAndChatMessageReplayAndDuplicateHandling(containerName);
        await expectDuplicateWorkspaceAndExternalIssueConstraints(containerName);
        await expectPostgresRunActivityAppendStoreAppendAndDuplicatePath(connectionString);
      } finally {
        await docker(["rm", "-f", containerName]).catch(() => undefined);
      }
    },
    120_000,
  );
});

async function applyConfiguredMigrations(connectionString: string): Promise<void> {
  await applyConfiguredPostgresMigrations({
    database: {
      postgres: {
        connectionString,
        migrationsDir: configuredMigrationsDir,
        migrationsTable: "symphony_schema_migrations",
        ssl: false,
      },
    },
  });
}

async function expectOperationalAndProjectionInsertQueryPaths(containerName: string): Promise<void> {
  const counts = await psql(
    containerName,
    String.raw`
      with inserted_workspace as (
        insert into symphony.workspace (
          workspace_key,
          issue_key,
          external_issue_id,
          issue_identifier,
          path,
          source_kind,
          repo_path,
          base_ref,
          git_branch_name,
          branch_name,
          snapshot,
          created_at,
          updated_at
        ) values (
          'workspace:eng-187',
          'issue:eng-187',
          '5596b099-7d43-4f09-92f2-5682db606189',
          'ENG-187',
          '/tmp/symphony/ENG-187',
          'git_worktree',
          '/tmp/symphony',
          'main',
          'sinfonista/eng-187-eng-175b-create-owned-operational-state-tables',
          'sinfonista/eng-187-eng-175b-create-owned-operational-state-tables',
          '{"source":"insert-query-smoke"}'::jsonb,
          now(),
          now()
        ) returning workspace_key
      ), inserted_issue as (
        insert into symphony.issue (
          issue_key,
          tracker_source,
          external_issue_id,
          issue_identifier,
          title_snapshot,
          description_snapshot,
          tracker_state,
          tracker_state_classification,
          priority_snapshot,
          labels_snapshot,
          blockers_snapshot,
          tracker_url,
          tracker_created_at,
          tracker_updated_at,
          tracker_fetched_at,
          phase,
          review_round,
          incomplete_turn_count,
          created_at,
          updated_at
        ) values (
          'issue:eng-187',
          'linear',
          '5596b099-7d43-4f09-92f2-5682db606189',
          'ENG-187',
          'ENG-175B: Create owned operational state tables',
          'Create the core tables for Symphony-owned operational state.',
          'In Progress',
          'active',
          2,
          '["observability","status-api","feature","dogfood","dogfood-ready"]'::jsonb,
          '[{"identifier":"ENG-186","state":"Done"}]'::jsonb,
          'https://linear.app/john-halbert/issue/ENG-187/eng-175b-create-owned-operational-state-tables',
          now(),
          now(),
          now(),
          'implementation',
          0,
          0,
          now(),
          now()
        ) returning issue_key
      ), inserted_run as (
        insert into symphony.run_session (
          run_id,
          session_id,
          agent_id,
          role,
          issue_key,
          external_issue_id,
          issue_identifier,
          workspace_key,
          workspace_path,
          turn_number,
          harness_id,
          runtime_model,
          git_branch_name,
          repo_path,
          base_ref,
          status,
          started_at,
          updated_at,
          activity_snapshot,
          metadata
        ) values (
          'run:eng-187:1',
          'session:eng-187:1',
          'agent:worker',
          'worker',
          'issue:eng-187',
          '5596b099-7d43-4f09-92f2-5682db606189',
          'ENG-187',
          'workspace:eng-187',
          '/tmp/symphony/ENG-187',
          1,
          'hermes',
          'gpt-5.5',
          'sinfonista/eng-187-eng-175b-create-owned-operational-state-tables',
          '/tmp/symphony',
          'main',
          'running',
          now(),
          now(),
          '{"lastTranscriptEventAt":"2026-05-31T02:40:47.400Z"}'::jsonb,
          '{"scenario":"insert-query-smoke"}'::jsonb
        ) returning run_id
      ), inserted_activity as (
        insert into symphony.run_activity_event (
          event_id,
          run_id,
          session_id,
          run_session_id,
          sequence,
          sequence_source,
          event_at,
          protocol,
          harness_id,
          external_event_id,
          actor,
          channel,
          kind,
          text,
          text_char_count,
          payload,
          metadata
        ) values (
          'activity:eng-187:1',
          'run:eng-187:1',
          'session:eng-187:1',
          'run:eng-187:1:session:eng-187:1',
          1,
          'harness',
          now(),
          'symphony',
          'hermes',
          'hermes:event:eng-187:1',
          'harness',
          'lifecycle',
          'run_started',
          'worker run started',
          18,
          '{"status":"running"}'::jsonb,
          '{"scenario":"insert-query-smoke"}'::jsonb
        ) returning run_activity_event_id
      ), inserted_chat_message as (
        insert into symphony.chat_message (
          message_id,
          thread_key,
          issue_key,
          issue_identifier,
          run_id,
          session_id,
          message_index,
          role,
          message_kind,
          status,
          body,
          body_preview,
          body_char_count,
          event_sequence_start,
          event_sequence_end,
          payload,
          metadata,
          created_at,
          updated_at
        ) values (
          'message:eng-187:0',
          'thread:eng-187',
          'issue:eng-187',
          'ENG-187',
          'run:eng-187:1',
          'session:eng-187:1',
          0,
          'user',
          'message',
          'completed',
          'Create owned operational state tables',
          'Create owned operational state tables',
          39,
          1,
          1,
          '{"safe":true}'::jsonb,
          '{"scenario":"insert-query-smoke"}'::jsonb,
          now(),
          now()
        ) returning chat_message_id
      ), inserted_writeback as (
        insert into symphony.writeback_operation (
          idempotency_key,
          kind,
          issue_key,
          external_issue_id,
          issue_identifier,
          run_id,
          status,
          created_at,
          updated_at,
          next_attempt_at,
          payload,
          payload_sha256
        ) values (
          'writeback:eng-187:comment:1',
          'comment',
          'issue:eng-187',
          '5596b099-7d43-4f09-92f2-5682db606189',
          'ENG-187',
          'run:eng-187:1',
          'pending',
          now(),
          now(),
          now(),
          '{"body":"Implementation ready"}'::jsonb,
          'sha256:insert-query-smoke'
        ) returning idempotency_key
      ), inserted_approval as (
        insert into symphony.approval_request (
          request_id,
          status,
          issue_key,
          external_issue_id,
          issue_identifier,
          run_id,
          evidence_cursor,
          dedupe_key,
          action,
          requested_at
        ) values (
          'approval:eng-187:publish:1',
          'pending',
          'issue:eng-187',
          '5596b099-7d43-4f09-92f2-5682db606189',
          'ENG-187',
          'run:eng-187:1',
          'run:eng-187:1/transcript/1',
          'approval:eng-187:publish',
          '{"kind":"publish_pull_request"}'::jsonb,
          now()
        ) returning request_id
      ), inserted_cursor as (
        insert into symphony.external_sync_cursor (
          source_system,
          cursor_key,
          cursor_value,
          high_watermark,
          external_snapshot_at,
          last_sync_started_at,
          last_sync_completed_at
        ) values (
          'linear',
          'issues:eng-team',
          '{"after":"cursor-1"}'::jsonb,
          'cursor-1',
          now(),
          now(),
          now()
        ) returning source_system, cursor_key
      ), dashboard_revision as (
        insert into symphony.projection_revision (projection_name, scope_kind, scope_key, revision, generated_at)
        values ('dashboard_projection', 'global', 'global', 1, now())
        returning projection_revision_id
      ), inserted_dashboard_projection as (
        insert into symphony.dashboard_projection (projection_revision_id, revision, payload, generated_at)
        select projection_revision_id, 1, '{"agents":[]}'::jsonb, now() from dashboard_revision
        returning projection_revision_id
      ), issue_board_revision as (
        insert into symphony.projection_revision (projection_name, scope_kind, scope_key, revision, generated_at)
        values ('issue_board_projection', 'board', 'default-board', 1, now())
        returning projection_revision_id
      ), inserted_issue_board_projection as (
        insert into symphony.issue_board_projection (projection_revision_id, revision, payload, generated_at)
        select projection_revision_id, 1, '{"issues":[]}'::jsonb, now() from issue_board_revision
        returning projection_revision_id
      ), sidebar_revision as (
        insert into symphony.projection_revision (projection_name, scope_kind, scope_key, revision, generated_at)
        values ('sidebar_projection', 'global', 'global', 1, now())
        returning projection_revision_id
      ), inserted_sidebar_projection as (
        insert into symphony.sidebar_projection (projection_revision_id, revision, payload, generated_at)
        select projection_revision_id, 1, '{"items":[]}'::jsonb, now() from sidebar_revision
        returning projection_revision_id
      ), history_revision as (
        insert into symphony.projection_revision (projection_name, scope_kind, scope_key, revision, generated_at)
        values ('history_projection', 'global', 'global', 1, now())
        returning projection_revision_id
      ), inserted_history_projection as (
        insert into symphony.history_projection (projection_revision_id, revision, payload, generated_at)
        select projection_revision_id, 1, '{"sessions":[]}'::jsonb, now() from history_revision
        returning projection_revision_id
      ), transcript_revision as (
        insert into symphony.projection_revision (projection_name, scope_kind, scope_key, revision, generated_at)
        values ('transcript_projection', 'run', 'run:eng-187:1', 1, now())
        returning projection_revision_id
      ), inserted_transcript_projection as (
        insert into symphony.transcript_projection (projection_revision_id, scope_key, run_id, revision, payload, generated_at)
        select projection_revision_id, 'run:eng-187:1', 'run:eng-187:1', 1, '{"messages":[]}'::jsonb, now() from transcript_revision
        returning projection_revision_id
      ), orchestrator_chat_revision as (
        insert into symphony.projection_revision (projection_name, scope_kind, scope_key, revision, generated_at)
        values ('orchestrator_chat_projection', 'conversation', 'global', 1, now())
        returning projection_revision_id
      ), inserted_orchestrator_chat_projection as (
        insert into symphony.orchestrator_chat_projection (projection_revision_id, revision, payload, generated_at)
        select projection_revision_id, 1, '{"messages":[]}'::jsonb, now() from orchestrator_chat_revision
        returning projection_revision_id
      )
      select jsonb_build_object(
        'workspace', (select count(*) from inserted_workspace),
        'issue', (select count(*) from inserted_issue),
        'run_session', (select count(*) from inserted_run),
        'run_activity_event', (select count(*) from inserted_activity),
        'chat_message', (select count(*) from inserted_chat_message),
        'writeback_operation', (select count(*) from inserted_writeback),
        'approval_request', (select count(*) from inserted_approval),
        'external_sync_cursor', (select count(*) from inserted_cursor),
        'projection_revision', (
          select count(*)
          from (
            select projection_revision_id from dashboard_revision
            union all select projection_revision_id from issue_board_revision
            union all select projection_revision_id from sidebar_revision
            union all select projection_revision_id from history_revision
            union all select projection_revision_id from transcript_revision
            union all select projection_revision_id from orchestrator_chat_revision
          ) revisions
        ),
        'dashboard_projection', (select count(*) from inserted_dashboard_projection),
        'issue_board_projection', (select count(*) from inserted_issue_board_projection),
        'sidebar_projection', (select count(*) from inserted_sidebar_projection),
        'history_projection', (select count(*) from inserted_history_projection),
        'transcript_projection', (select count(*) from inserted_transcript_projection),
        'orchestrator_chat_projection', (select count(*) from inserted_orchestrator_chat_projection)
      )::text;
    `,
  );

  expect(JSON.parse(counts.trim())).toEqual({
    workspace: 1,
    issue: 1,
    run_session: 1,
    run_activity_event: 1,
    chat_message: 1,
    writeback_operation: 1,
    approval_request: 1,
    external_sync_cursor: 1,
    projection_revision: projectionTables.length - 1,
    dashboard_projection: 1,
    issue_board_projection: 1,
    sidebar_projection: 1,
    history_projection: 1,
    transcript_projection: 1,
    orchestrator_chat_projection: 1,
  });
}

async function expectRunActivityAndChatMessageReplayAndDuplicateHandling(containerName: string): Promise<void> {
  await psql(
    containerName,
    String.raw`
      insert into symphony.raw_payload_reference (
        owner_table,
        owner_key,
        storage_uri,
        sha256,
        byte_length,
        media_type,
        compression,
        redaction_status,
        metadata
      ) values (
        'symphony.run_activity_event',
        'activity:eng-187:large',
        'file:///var/lib/symphony/raw/run-activity-large.json',
        '1111111111111111111111111111111111111111111111111111111111111111',
        8388608,
        'application/json',
        'gzip',
        'redacted',
        '{"policy":"oversized-run-activity"}'::jsonb
      );

      insert into symphony.raw_payload_reference (
        owner_table,
        owner_key,
        storage_uri,
        sha256,
        byte_length,
        media_type,
        compression,
        redaction_status,
        metadata
      ) values (
        'symphony.chat_message',
        'message:eng-187:1',
        'file:///var/lib/symphony/raw/chat-message-large.json',
        '2222222222222222222222222222222222222222222222222222222222222222',
        4194304,
        'application/json',
        'gzip',
        'redacted',
        '{"policy":"oversized-chat-message"}'::jsonb
      );

      insert into symphony.run_activity_event (
        event_id,
        run_id,
        session_id,
        run_session_id,
        sequence,
        sequence_source,
        event_at,
        protocol,
        harness_id,
        external_event_id,
        actor,
        channel,
        kind,
        text,
        text_char_count,
        payload,
        payload_schema,
        payload_truncated,
        payload_byte_length,
        raw_payload_ref_id,
        metadata
      ) values (
        'activity:eng-187:large',
        'run:eng-187:1',
        'session:eng-187:1',
        'run:eng-187:1:session:eng-187:1',
        2,
        'harness',
        now(),
        'json_rpc',
        'hermes',
        'hermes:event:eng-187:large',
        'assistant',
        'message',
        'assistant_message_delta',
        'large assistant delta stored externally',
        41,
        '{"preview":"large assistant delta"}'::jsonb,
        'symphony.run_activity_event.v1',
        true,
        8388608,
        (select raw_payload_ref_id from symphony.raw_payload_reference where owner_key = 'activity:eng-187:large'),
        '{"source":"range-smoke"}'::jsonb
      );

      insert into symphony.chat_message (
        message_id,
        thread_key,
        issue_key,
        issue_identifier,
        run_id,
        session_id,
        message_index,
        role,
        message_kind,
        status,
        body,
        body_preview,
        body_char_count,
        body_truncated,
        event_sequence_start,
        event_sequence_end,
        payload,
        raw_payload_ref_id,
        metadata,
        created_at,
        updated_at
      ) values (
        'message:eng-187:1',
        'thread:eng-187',
        'issue:eng-187',
        'ENG-187',
        'run:eng-187:1',
        'session:eng-187:1',
        1,
        'assistant',
        'assistant_response',
        'streaming',
        'large response preview',
        'large response preview',
        1048576,
        true,
        1,
        2,
        '{"preview":"large response"}'::jsonb,
        (select raw_payload_ref_id from symphony.raw_payload_reference where owner_key = 'message:eng-187:1'),
        '{"source":"range-smoke"}'::jsonb,
        now(),
        now()
      );
    `,
  );

  const replay = await psql(
    containerName,
    String.raw`
      select jsonb_build_object(
        'sequences', (
          select jsonb_agg(sequence order by sequence)
          from symphony.run_activity_event
          where run_id = 'run:eng-187:1'
        ),
        'largeActivity', (
          select jsonb_build_object(
            'externalEventId', event.external_event_id,
            'payloadTruncated', event.payload_truncated,
            'payloadByteLength', event.payload_byte_length,
            'rawStorageUri', raw.storage_uri
          )
          from symphony.run_activity_event event
          join symphony.raw_payload_reference raw on raw.raw_payload_ref_id = event.raw_payload_ref_id
          where event.event_id = 'activity:eng-187:large'
        ),
        'message', (
          select jsonb_build_object(
            'role', role,
            'status', status,
            'body', body,
            'range', jsonb_build_array(event_sequence_start, event_sequence_end),
            'bodyTruncated', body_truncated,
            'rawPayloadReferenced', raw_payload_ref_id is not null
          )
          from symphony.chat_message
          where message_id = 'message:eng-187:1'
        )
      )::text;
    `,
  );

  expect(JSON.parse(replay.trim())).toEqual({
    sequences: [1, 2],
    largeActivity: {
      externalEventId: "hermes:event:eng-187:large",
      payloadTruncated: true,
      payloadByteLength: 8388608,
      rawStorageUri: "file:///var/lib/symphony/raw/run-activity-large.json",
    },
    message: {
      role: "assistant",
      status: "streaming",
      body: "large response preview",
      range: [1, 2],
      bodyTruncated: true,
      rawPayloadReferenced: true,
    },
  });

  await expect(
    psql(
      containerName,
      String.raw`
        insert into symphony.run_activity_event (
          event_id,
          run_id,
          session_id,
          run_session_id,
          sequence,
          sequence_source,
          event_at,
          protocol,
          harness_id,
          external_event_id,
          actor,
          channel,
          kind,
          payload
        ) values (
          'activity:eng-187:duplicate-sequence',
          'run:eng-187:1',
          'session:eng-187:1',
          'run:eng-187:1:session:eng-187:1',
          2,
          'harness',
          now(),
          'json_rpc',
          'hermes',
          'hermes:event:eng-187:duplicate-sequence',
          'runtime',
          'status',
          'runtime_status_update',
          '{"status":"duplicate"}'::jsonb
        );
      `,
    ),
  ).rejects.toThrow(/duplicate key value violates unique constraint/i);

  await expect(
    psql(
      containerName,
      String.raw`
        insert into symphony.run_activity_event (
          event_id,
          run_id,
          session_id,
          run_session_id,
          sequence,
          sequence_source,
          event_at,
          protocol,
          harness_id,
          external_event_id,
          actor,
          channel,
          kind,
          payload
        ) values (
          'activity:eng-187:duplicate-external',
          'run:eng-187:1',
          'session:eng-187:1',
          'run:eng-187:1:session:eng-187:1',
          3,
          'harness',
          now(),
          'json_rpc',
          'hermes',
          'hermes:event:eng-187:large',
          'runtime',
          'status',
          'runtime_status_update',
          '{"status":"duplicate"}'::jsonb
        );
      `,
    ),
  ).rejects.toThrow(/duplicate key value violates unique constraint/i);

  await expect(
    psql(
      containerName,
      String.raw`
        insert into symphony.chat_message (
          message_id,
          thread_key,
          run_id,
          session_id,
          message_index,
          role,
          created_at
        ) values (
          'message:eng-187:1',
          'thread:eng-187:duplicate-message-id',
          'run:eng-187:1',
          'session:eng-187:1',
          0,
          'assistant',
          now()
        );
      `,
    ),
  ).rejects.toThrow(/duplicate key value violates unique constraint/i);

  await expect(
    psql(
      containerName,
      String.raw`
        insert into symphony.chat_message (
          message_id,
          thread_key,
          run_id,
          session_id,
          message_index,
          role,
          event_sequence_start,
          event_sequence_end,
          created_at
        ) values (
          'message:eng-187:invalid-range',
          'thread:eng-187',
          'run:eng-187:1',
          'session:eng-187:1',
          2,
          'assistant',
          2,
          1,
          now()
        );
      `,
    ),
  ).rejects.toThrow(/violates check constraint/i);

  await expect(
    psql(
      containerName,
      String.raw`
        insert into symphony.chat_message (
          message_id,
          thread_key,
          run_id,
          session_id,
          message_index,
          role,
          event_sequence_end,
          created_at
        ) values (
          'message:eng-187:end-without-start',
          'thread:eng-187',
          'run:eng-187:1',
          'session:eng-187:1',
          3,
          'assistant',
          2,
          now()
        );
      `,
    ),
  ).rejects.toThrow(/violates check constraint/i);
}

async function expectDuplicateWorkspaceAndExternalIssueConstraints(containerName: string): Promise<void> {
  await expect(
    psql(
      containerName,
      String.raw`
        insert into symphony.workspace (workspace_key, issue_identifier, path, source_kind, created_at, updated_at)
        values ('workspace:duplicate', 'DUP-1', '/tmp/dup-a', 'git_worktree', now(), now());
        insert into symphony.workspace (workspace_key, issue_identifier, path, source_kind, created_at, updated_at)
        values ('workspace:duplicate', 'DUP-2', '/tmp/dup-b', 'git_worktree', now(), now());
      `,
    ),
  ).rejects.toThrow(/duplicate key value violates unique constraint/i);

  await expect(
    psql(
      containerName,
      String.raw`
        insert into symphony.issue (issue_key, tracker_source, external_issue_id, issue_identifier, created_at, updated_at)
        values ('issue:duplicate-external-a', 'linear', 'external-duplicate', 'DUP-A', now(), now());
        insert into symphony.issue (issue_key, tracker_source, external_issue_id, issue_identifier, created_at, updated_at)
        values ('issue:duplicate-external-b', 'linear', 'external-duplicate', 'DUP-B', now(), now());
      `,
    ),
  ).rejects.toThrow(/duplicate key value violates unique constraint/i);

  const nullableExternalIds = await psql(
    containerName,
    String.raw`
      insert into symphony.issue (issue_key, tracker_source, external_issue_id, issue_identifier, created_at, updated_at)
      values ('issue:null-external-a', 'linear', null, 'NULL-A', now(), now());
      insert into symphony.issue (issue_key, tracker_source, external_issue_id, issue_identifier, created_at, updated_at)
      values ('issue:null-external-b', 'linear', null, 'NULL-B', now(), now());
      select count(*) from symphony.issue where issue_key in ('issue:null-external-a', 'issue:null-external-b');
    `,
  );
  expect(Number(nullableExternalIds.trim())).toBe(2);
}

async function expectPostgresRunActivityAppendStoreAppendAndDuplicatePath(connectionString: string): Promise<void> {
  const pool = new Pool({ connectionString });
  const runId = "run:configured-append";
  const sessionId = "session:configured-append";
  const runSessionId = `${runId}:${sessionId}`;
  try {
    await pool.query(
      `
        INSERT INTO symphony.run_session (
          run_id,
          session_id,
          agent_id,
          role,
          issue_key,
          issue_identifier,
          workspace_key,
          workspace_path,
          turn_number,
          harness_id,
          status,
          started_at,
          updated_at
        ) VALUES (
          $1,
          $2,
          'agent:configured-append',
          'worker',
          'issue:configured-append',
          'APPEND-1',
          'workspace:configured-append',
          '/tmp/symphony/APPEND-1',
          1,
          'hermes',
          'running',
          now(),
          now()
        )
      `,
      [runId, sessionId],
    );

    const store = new PostgresRunActivityAppendStore({
      connect: async () => (await pool.connect()) as PostgresRunActivityAppendClient,
    });
    const first = await store.appendEvent(
      runActivityAppendInput({
        id: "activity:configured-append:1",
        runId,
        sessionId,
        sequence: null,
        externalEventId: "external:configured-append:1",
      }),
    );
    expect(first).toMatchObject({
      status: "accepted",
      event: { runSessionId, sequence: 1, sequenceSource: "symphony" },
    });
    if (first.status !== "accepted") throw new Error("expected first append to be accepted");

    const duplicate = await store.appendEvent(
      runActivityAppendInput({
        id: "activity:configured-append:duplicate-external",
        runId,
        sessionId,
        sequence: null,
        externalEventId: "external:configured-append:1",
      }),
    );
    expect(duplicate).toMatchObject({
      status: "duplicate",
      reason: "external_event_id",
      metadata: { appendRevision: first.metadata.appendRevision, sequence: 1 },
    });

    const persisted = await pool.query<{ count: string; max_sequence: number }>(
      `
        SELECT count(*)::text AS count, max(sequence)::int AS max_sequence
        FROM symphony.run_activity_event
        WHERE run_session_id = $1
      `,
      [runSessionId],
    );
    expect(persisted.rows[0]).toMatchObject({ count: "1", max_sequence: 1 });
  } finally {
    await pool.end();
  }
}

function runActivityAppendInput(overrides: Record<string, unknown> = {}): RunActivityAppendInput {
  return {
    id: "activity:configured-append",
    runId: "run:configured-append",
    sessionId: "session:configured-append",
    at: "2026-05-31T00:00:00.000Z",
    harnessId: "hermes",
    actor: "runtime",
    channel: "status",
    kind: "runtime_log",
    text: "configured migration append",
    payload: { source: "configured-migration-test" },
    protocol: "json_rpc",
    ...overrides,
  } as RunActivityAppendInput;
}

async function postgresConnectionString(containerName: string): Promise<string> {
  const { stdout } = await docker(["port", containerName, "5432/tcp"]);
  const endpoint = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && /:\d+$/.test(line));
  const port = endpoint?.match(/:(\d+)$/)?.[1];
  if (port === undefined) throw new Error(`Could not resolve mapped Postgres port for ${containerName}: ${stdout}`);
  return `postgres://postgres@127.0.0.1:${port}/postgres`;
}

async function waitForPostgres(containerName: string): Promise<void> {
  let lastError = "";
  for (let attempt = 0; attempt < 45; attempt += 1) {
    try {
      await docker(["exec", containerName, "pg_isready", "-U", "postgres"], 10_000);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await delay(1_000);
    }
  }
  throw new Error(`Postgres container did not become ready: ${lastError}`);
}

async function psql(containerName: string, sql: string, timeout = 30_000): Promise<string> {
  const result = await docker(
    ["exec", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-qAtc", sql],
    timeout,
  );
  return result.stdout;
}

async function docker(args: readonly string[], timeout = 30_000): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("docker", [...args], { timeout, maxBuffer: 1_000_000 });
}

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const migrationUrl = new URL("../db/migrations/postgres/0001_symphony_owned_state.sql", import.meta.url);
const readmeUrl = new URL("../db/migrations/postgres/README.md", import.meta.url);

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
  "chat_message_ordering_idx",
  "writeback_operation_state_idx",
  "approval_request_state_idx",
  "projection_revision_reads_idx",
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
  it("declares all required operational and projection tables", async () => {
    const normalized = normalizedSql(await migrationSql());

    for (const table of [...operationalTables, ...projectionTables]) {
      expect(normalized, `missing symphony.${table}`).toContain(`create table if not exists symphony.${table}`);
    }

    expect(normalized).toContain("create table if not exists symphony.raw_payload_reference");
  });

  it("declares lookup indexes for high-volume runtime and projection reads", async () => {
    const normalized = normalizedSql(await migrationSql());

    for (const indexName of requiredLookupIndexes) {
      expect(normalized, `missing ${indexName}`).toContain(`create index if not exists ${indexName}`);
    }

    expect(normalized).toContain("on symphony.run_activity_event (run_id, sequence)");
    expect(normalized).toContain("on symphony.chat_message (thread_key, message_index)");
    expect(normalized).toContain("on symphony.writeback_operation (status, next_attempt_at, created_at)");
    expect(normalized).toContain("on symphony.approval_request (status, expires_at, requested_at)");
    expect(normalized).toContain("on symphony.projection_revision (projection_name, scope_kind, scope_key, revision desc, generated_at desc)");
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

    for (const table of projectionTables.filter((table) => table !== "projection_revision")) {
      expect(normalized, `missing revision FK for ${table}`).toContain(
        `create table if not exists symphony.${table} ( projection_revision_id bigint primary key references symphony.projection_revision(projection_revision_id) on delete cascade`,
      );
      expect(normalized, `missing read index for ${table}`).toContain(`${table}_revision_reads_idx`);
    }
  });

  const liveIt = process.env.SYMPHONY_POSTGRES_SCHEMA_VALIDATE_DOCKER === "1" ? it : it.skip;

  liveIt(
    "applies cleanly and supports basic insert/query paths via Docker",
    async () => {
      const containerName = `symphony-postgres-schema-${process.pid}-${Date.now()}`;
      try {
        await docker(["run", "--rm", "--name", containerName, "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-d", "postgres:16-alpine"], 60_000);
        await waitForPostgres(containerName);
        await applyMigration(containerName);

        const tableCount = await psql(
          containerName,
          "select count(*) from information_schema.tables where table_schema = 'symphony';",
        );
        expect(Number(tableCount.trim())).toBe([...operationalTables, ...projectionTables, "raw_payload_reference"].length);

        const indexes = await psql(containerName, "select indexname from pg_indexes where schemaname = 'symphony' order by indexname;");
        for (const indexName of requiredLookupIndexes) {
          expect(indexes).toContain(indexName);
        }

        await expectOperationalAndProjectionInsertQueryPaths(containerName);
        await expectDuplicateWorkspaceAndExternalIssueConstraints(containerName);
      } finally {
        await docker(["rm", "-f", containerName]).catch(() => undefined);
      }
    },
    120_000,
  );
});

async function applyMigration(containerName: string): Promise<void> {
  await docker(["cp", fileURLToPath(migrationUrl), `${containerName}:/tmp/0001_symphony_owned_state.sql`]);
  await docker([
    "exec",
    containerName,
    "psql",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-f",
    "/tmp/0001_symphony_owned_state.sql",
  ]);
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
          run_id,
          sequence,
          event_at,
          source,
          event_type,
          message_preview,
          payload
        ) values (
          'run:eng-187:1',
          1,
          now(),
          'harness',
          'completion_report_ready',
          'worker produced completion report',
          '{"status":"ready"}'::jsonb
        ) returning run_activity_event_id
      ), inserted_chat_message as (
        insert into symphony.chat_message (
          thread_key,
          issue_key,
          issue_identifier,
          run_id,
          session_id,
          message_index,
          speaker,
          message_kind,
          body_preview,
          body_char_count,
          payload,
          created_at
        ) values (
          'thread:eng-187',
          'issue:eng-187',
          'ENG-187',
          'run:eng-187:1',
          'session:eng-187:1',
          0,
          'user',
          'message',
          'Create owned operational state tables',
          39,
          '{"safe":true}'::jsonb,
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

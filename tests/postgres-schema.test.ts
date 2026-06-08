import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  applyConfiguredPostgresMigrations,
  applyPostgresMigrationsWithClient,
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
const ownedStateMigrationUrl = new URL("../migrations/postgres/0002_symphony_owned_state.sql", import.meta.url);
const projectionFreshnessMigrationUrl = new URL(
  "../migrations/postgres/0003_projection_freshness_indexes.sql",
  import.meta.url,
);
const canonicalChannelMigrationUrl = new URL(
  "../migrations/postgres/0004_run_activity_canonical_channels.sql",
  import.meta.url,
);
const projectionSourceFreshnessMigrationUrl = new URL(
  "../migrations/postgres/0005_projection_source_freshness.sql",
  import.meta.url,
);
const projectionBuildModesMigrationUrl = new URL(
  "../migrations/postgres/0006_projection_build_modes.sql",
  import.meta.url,
);
const projectContextAttributionMigrationUrl = new URL(
  "../migrations/postgres/0007_project_context_attribution.sql",
  import.meta.url,
);
const readmeUrl = new URL("../migrations/postgres/README.md", import.meta.url);
const stateOwnershipUrl = new URL("../docs/state-ownership-and-migration.md", import.meta.url);
const publishedOwnedStateChecksumSha256 = "8e10c03c6cfa34e9672e350c59ff4998459989529a82c98cbd9f714469799298";

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
  "projection_revision_build_mode_idx",
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

const projectionFreshnessIndexes = [
  "projection_revision_reads_idx",
  "dashboard_projection_revision_reads_idx",
  "issue_board_projection_revision_reads_idx",
  "sidebar_projection_revision_reads_idx",
  "history_projection_revision_reads_idx",
  "history_projection_run_lookup_idx",
  "transcript_projection_revision_reads_idx",
  "transcript_projection_session_reads_idx",
  "orchestrator_chat_projection_revision_reads_idx",
  "orchestrator_chat_projection_issue_idx",
] as const;

async function ownedStateMigrationSql(): Promise<string> {
  return readFile(ownedStateMigrationUrl, "utf8");
}

async function projectionFreshnessMigrationSql(): Promise<string> {
  return readFile(projectionFreshnessMigrationUrl, "utf8");
}

async function canonicalChannelMigrationSql(): Promise<string> {
  return readFile(canonicalChannelMigrationUrl, "utf8");
}

async function projectionSourceFreshnessMigrationSql(): Promise<string> {
  return readFile(projectionSourceFreshnessMigrationUrl, "utf8");
}

async function projectionBuildModesMigrationSql(): Promise<string> {
  return readFile(projectionBuildModesMigrationUrl, "utf8");
}

async function configuredMigrationSql(): Promise<string> {
  const migrations = await discoverPostgresMigrations(configuredMigrationsDir);
  return migrations.map((migration) => migration.sql).join("\n");
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

async function migrationReadme(): Promise<string> {
  return readFile(readmeUrl, "utf8");
}

async function stateOwnershipDoc(): Promise<string> {
  return readFile(stateOwnershipUrl, "utf8");
}

function normalizedSql(sql: string): string {
  return sql.replace(/\s+/g, " ").toLowerCase();
}

describe("Postgres Symphony-owned state migration", () => {
  it("keeps the owned-state schema on the configured migration path after the runner baseline", async () => {
    const migrations = await discoverPostgresMigrations(configuredMigrationsDir);

    expect(migrations.map((migration) => migration.id)).toEqual([
      "0001_migration_foundation",
      "0002_symphony_owned_state",
      "0003_projection_freshness_indexes",
      "0004_run_activity_canonical_channels",
      "0005_projection_source_freshness",
      "0006_projection_build_modes",
      "0007_project_context_attribution",
    ]);
    const ownedState = migrations.find((migration) => migration.id === "0002_symphony_owned_state");
    const projectionFreshness = migrations.find((migration) => migration.id === "0003_projection_freshness_indexes");
    const canonicalChannels = migrations.find((migration) => migration.id === "0004_run_activity_canonical_channels");
    const projectionSourceFreshness = migrations.find((migration) => migration.id === "0005_projection_source_freshness");
    const projectionBuildModes = migrations.find((migration) => migration.id === "0006_projection_build_modes");
    const projectContextAttribution = migrations.find((migration) => migration.id === "0007_project_context_attribution");
    expect(ownedState?.filePath).toBe(fileURLToPath(ownedStateMigrationUrl));
    expect(projectionFreshness?.filePath).toBe(fileURLToPath(projectionFreshnessMigrationUrl));
    expect(canonicalChannels?.filePath).toBe(fileURLToPath(canonicalChannelMigrationUrl));
    expect(projectionSourceFreshness?.filePath).toBe(fileURLToPath(projectionSourceFreshnessMigrationUrl));
    expect(projectionBuildModes?.filePath).toBe(fileURLToPath(projectionBuildModesMigrationUrl));
    expect(projectContextAttribution?.filePath).toBe(fileURLToPath(projectContextAttributionMigrationUrl));
    expect(sha256(ownedState?.sql ?? "")).toBe(publishedOwnedStateChecksumSha256);
    expect(ownedState?.checksumSha256).toBe(publishedOwnedStateChecksumSha256);
    expect(ownedState?.sql).toContain("CREATE TABLE IF NOT EXISTS symphony.run_session");
    expect(ownedState?.sql).toContain("CREATE TABLE IF NOT EXISTS symphony.run_activity_event");
    expect(ownedState?.sql).toContain("run_activity_event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY");
    expect(ownedState?.sql).toContain("UNIQUE (run_session_id, sequence)");
    expect(ownedState?.sql).toContain("run_activity_event_external_event_unique_idx");
    expect(projectionFreshness?.sql).toContain("ALTER TABLE symphony.projection_revision");
    expect(ownedState?.sql).not.toMatch(/^\s*(BEGIN|COMMIT);/im);
    expect(projectionFreshness?.sql).not.toMatch(/^\s*(BEGIN|COMMIT);/im);
    expect(canonicalChannels?.sql).not.toMatch(/^\s*(BEGIN|COMMIT);/im);
    expect(projectionSourceFreshness?.sql).not.toMatch(/^\s*(BEGIN|COMMIT);/im);
    expect(projectionBuildModes?.sql).not.toMatch(/^\s*(BEGIN|COMMIT);/im);
    expect(projectContextAttribution?.sql).not.toMatch(/^\s*(BEGIN|COMMIT);/im);
  });

  it("delivers projection updated_at columns and freshness indexes through the follow-up migration", async () => {
    const normalized = normalizedSql(await projectionFreshnessMigrationSql());

    for (const table of projectionTables) {
      expect(normalized, `missing updated_at upgrade for ${table}`).toContain(
        `alter table symphony.${table} add column if not exists updated_at timestamptz not null default now()`,
      );
    }

    for (const indexName of projectionFreshnessIndexes) {
      expect(normalized, `missing drop for ${indexName}`).toContain(`drop index if exists symphony.${indexName}`);
      expect(normalized, `missing recreated ${indexName}`).toContain(`index if not exists ${indexName}`);
    }

    expect(normalized).toContain(
      "on symphony.projection_revision (projection_name, scope_kind, scope_key, revision desc, updated_at desc, generated_at desc)",
    );
    expect(normalized).toContain(
      "on symphony.orchestrator_chat_projection (issue_key, revision desc, updated_at desc)",
    );
  });

  it("delivers canonical run activity channels through a checksum-safe follow-up migration", async () => {
    const normalized = normalizedSql(await canonicalChannelMigrationSql());

    expect(normalized).toContain("alter table symphony.run_activity_event drop constraint if exists run_activity_event_channel_check");
    expect(normalized).toContain("when 'message' then 'chat'");
    expect(normalized).toContain("when 'status' then 'diagnostic'");
    expect(normalized).toContain("where channel in ('message', 'status')");
    expect(normalized).toContain(
      "add constraint run_activity_event_channel_check check (channel in ('lifecycle', 'chat', 'tool', 'diagnostic', 'token', 'rate_limit', 'terminal'))",
    );
  });

  it("delivers durable projection source freshness metadata through a checksum-safe follow-up migration", async () => {
    const normalized = normalizedSql(await projectionSourceFreshnessMigrationSql());

    expect(normalized).toContain("alter table symphony.projection_revision add column if not exists source_freshness jsonb not null default '[]'::jsonb");
    expect(normalized).toContain("source_cursors ? 'sourcefreshness'");
    expect(normalized).toContain("projection_revision_source_freshness_array_check");
    expect(normalized).toContain("check (jsonb_typeof(source_freshness) = 'array')");
    expect(normalized).toContain("create index if not exists projection_revision_source_freshness_gin_idx");
    expect(normalized).toContain("using gin (source_freshness jsonb_path_ops)");
  });

  it("delivers durable projection build mode metadata through a checksum-safe follow-up migration", async () => {
    const normalized = normalizedSql(await projectionBuildModesMigrationSql());

    expect(normalized).toContain("alter table symphony.projection_revision add column if not exists build_mode text not null default 'incremental'");
    expect(normalized).toContain("when revision = 1 then 'bootstrap'");
    expect(normalized).toContain("projection_revision_build_mode_check");
    expect(normalized).toContain("check (build_mode in ('bootstrap', 'incremental', 'rebuild'))");
    expect(normalized).toContain("create index if not exists projection_revision_build_mode_idx");
    expect(normalized).toContain("on symphony.projection_revision (build_mode, projection_name, updated_at desc, generated_at desc)");
  });

  it("reserves owned-state project context attribution columns and collision-safe lookup indexes before the migration is implemented", async () => {
    const normalized = normalizedSql(await configuredMigrationSql());

    for (const fragment of [
      "alter table symphony.workspace add column if not exists project_context_id text",
      "alter table symphony.issue add column if not exists project_context_id text",
      "alter table symphony.run_session add column if not exists project_context_id text",
      "alter table symphony.run_session add column if not exists project_context_label text",
      "alter table symphony.run_session add column if not exists linear_project_identity jsonb",
      "alter table symphony.run_session add column if not exists codebase_identity jsonb",
      "alter table symphony.run_session add column if not exists routing_source text",
      "alter table symphony.writeback_operation add column if not exists project_context_id text",
      "alter table symphony.approval_request add column if not exists project_context_id text",
    ]) {
      expect(normalized, `missing owned-state project context fragment: ${fragment}`).toContain(fragment);
    }

    for (const fragment of [
      "on symphony.issue (project_context_id, tracker_source, issue_identifier)",
      "on symphony.issue (project_context_id, tracker_source, tracker_state, phase, updated_at desc)",
      "on symphony.issue (project_context_id, phase, blocked_reason, updated_at desc)",
      "on symphony.run_session (project_context_id, issue_key, status, started_at desc)",
      "on symphony.run_session (project_context_id, issue_identifier, started_at desc)",
      "on symphony.run_session (project_context_id, workspace_key, started_at desc)",
      "on symphony.writeback_operation (project_context_id, status, next_attempt_at, created_at)",
      "on symphony.writeback_operation (project_context_id, issue_key, created_at desc)",
      "on symphony.writeback_operation (project_context_id, run_id, created_at desc)",
      "on symphony.approval_request (project_context_id, status, expires_at, requested_at)",
      "on symphony.approval_request (project_context_id, issue_key, requested_at desc)",
      "on symphony.approval_request (project_context_id, run_id, requested_at desc)",
    ]) {
      expect(normalized, `missing owned-state project context lookup fragment: ${fragment}`).toContain(fragment);
    }
  });

  it("reserves projection project context attribution columns and context-aware read indexes before the migration is implemented", async () => {
    const normalized = normalizedSql(await configuredMigrationSql());

    for (const table of [
      "projection_revision",
      "dashboard_projection",
      "issue_board_projection",
      "sidebar_projection",
      "history_projection",
      "transcript_projection",
      "orchestrator_chat_projection",
    ]) {
      expect(normalized, `missing projection context column for ${table}`).toContain(
        `alter table symphony.${table} add column if not exists project_context_id text`,
      );
    }

    for (const fragment of [
      "on symphony.projection_revision (project_context_id, projection_name, scope_kind, scope_key, revision desc, updated_at desc, generated_at desc)",
      "on symphony.projection_revision (project_context_id, projection_name, scope_kind, scope_key)",
      "on symphony.dashboard_projection (project_context_id, scope_key, revision desc, updated_at desc, generated_at desc)",
      "on symphony.issue_board_projection (project_context_id, scope_key, revision desc, updated_at desc, generated_at desc)",
      "on symphony.sidebar_projection (project_context_id, scope_key, revision desc, updated_at desc, generated_at desc)",
      "on symphony.history_projection (project_context_id, scope_key, revision desc, updated_at desc, generated_at desc)",
      "on symphony.history_projection (project_context_id, run_id, session_id, revision desc)",
      "on symphony.transcript_projection (project_context_id, run_id, revision desc, updated_at desc, generated_at desc)",
      "on symphony.transcript_projection (project_context_id, session_id, revision desc)",
      "on symphony.orchestrator_chat_projection (project_context_id, scope_key, conversation_key, revision desc, updated_at desc, generated_at desc)",
      "on symphony.orchestrator_chat_projection (project_context_id, issue_key, revision desc)",
    ]) {
      expect(normalized, `missing projection context index fragment: ${fragment}`).toContain(fragment);
    }
  });

  it("declares all required operational and projection tables", async () => {
    const normalized = normalizedSql(await configuredMigrationSql());

    for (const table of [...operationalTables, ...projectionTables]) {
      expect(normalized, `missing symphony.${table}`).toContain(`create table if not exists symphony.${table}`);
    }

    expect(normalized).toContain("create table if not exists symphony.raw_payload_reference");
  });

  it("declares lookup indexes for high-volume runtime and projection reads", async () => {
    const normalized = normalizedSql(await configuredMigrationSql());

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
    const normalized = normalizedSql(await configuredMigrationSql());

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
    const sql = (await configuredMigrationSql()).toLowerCase();
    const readme = (await migrationReadme()).toLowerCase();
    const ownership = (await stateOwnershipDoc()).toLowerCase();
    const combined = `${sql}\n${readme}\n${ownership}`;

    for (const authority of ["linear", "github", "git worktrees", "runtime harnesses", "external agent sessions"]) {
      expect(combined).toContain(authority);
    }

    expect(combined).toContain("file-backed");
    expect(combined).toContain("existing json/jsonl state");
    expect(combined).toContain("raw_payload_reference");
    expect(combined).toContain("raw harness payloads must not be blindly embedded into projection json");
    expect(sql).toContain("raw_payload_refs jsonb not null default '[]'::jsonb");
    expect(readme).toContain("docs/state-ownership-and-migration.md");
  });

  it("links the ownership guide to the configured migration surface", async () => {
    const ownership = (await stateOwnershipDoc()).toLowerCase();
    const readme = (await migrationReadme()).toLowerCase();

    for (const fragment of [
      "configured postgres migration path",
      "migrations/postgres/0002_symphony_owned_state.sql",
      "migrations/postgres/0003_projection_freshness_indexes.sql",
      "migrations/postgres/0004_run_activity_canonical_channels.sql",
      "migrations/postgres/0005_projection_source_freshness.sql",
      "migrations/postgres/0006_projection_build_modes.sql",
      "checksum-stable",
      "projection `updated_at` freshness columns",
      "canonical run activity channel names",
      "projection_revision.source_freshness",
      "projection_revision.build_mode",
    ]) {
      expect(ownership, `missing ownership guide fragment: ${fragment}`).toContain(fragment);
    }

    expect(readme).toContain("state ownership and migration compatibility");
    expect(readme).toContain("docs/state-ownership-and-migration.md");
  });

  it("classifies current Postgres tables by canonical, snapshot, and projection ownership", async () => {
    const ownership = (await stateOwnershipDoc()).toLowerCase();

    for (const table of [...operationalTables, ...projectionTables, "raw_payload_reference"]) {
      expect(ownership, `missing ownership guidance for ${table}`).toContain(`symphony.${table}`);
    }

    for (const term of ["canonical symphony state", "external snapshots", "projection/read-model state", "external authority boundaries"]) {
      expect(ownership).toContain(term);
    }

    for (const currentShape of [
      "run_session_id",
      "sequence_source",
      "external_event_id",
      "run_activity_event_id",
      "event_sequence_start",
      "event_sequence_end",
      "updated_at",
    ]) {
      expect(ownership, `missing current schema shape ${currentShape}`).toContain(currentShape);
    }
  });

  it("documents startup compatibility for absent, empty, stale, and replayed Postgres states", async () => {
    const ownership = (await stateOwnershipDoc()).toLowerCase();

    for (const scenario of [
      "postgres absent",
      "postgres present but empty",
      "postgres present with stale projections",
      "projection rows exist without matching canonical rows",
      "existing file-backed state is newer than postgres",
      "interrupted import or dual-write replay",
      "external authority is unavailable at startup",
      "large raw artifact encountered during migration",
    ]) {
      expect(ownership).toContain(scenario);
    }

    for (const fileStore of ["fileruntranscriptstore", "fileissuelifecyclestore", "filewritebackoutboxstore", "fileoperatorapprovalstore"]) {
      expect(ownership).toContain(fileStore);
    }

    expect(ownership).toContain("missing postgres must not make the current file-backed workflow unavailable");
    expect(ownership).toContain("stale projections may affect ui freshness only");
    expect(ownership).toContain("importers must be side-effect free");
    expect(ownership).toContain("replays must not duplicate transcript events");
  });

  it("keeps projection payloads tied to durable revision metadata", async () => {
    const normalized = normalizedSql(await configuredMigrationSql());

    expect(normalized).toContain("create table if not exists symphony.projection_revision");
    expect(normalized).toContain("projection_name text not null check");
    expect(normalized).toContain("unique (projection_name, scope_kind, scope_key, revision)");
    expect(normalized).toContain(
      "alter table symphony.projection_revision add column if not exists updated_at timestamptz not null default now()",
    );
    expect(normalized).toContain("alter table symphony.projection_revision add column if not exists build_mode text not null default 'incremental'");

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
      expect(normalized, `missing updated_at upgrade for ${table}`).toContain(
        `alter table symphony.${table} add column if not exists updated_at timestamptz not null default now()`,
      );
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
        expect(appliedMigrations.trim().split(/\s+/)).toEqual([
          "0001_migration_foundation",
          "0002_symphony_owned_state",
          "0003_projection_freshness_indexes",
          "0004_run_activity_canonical_channels",
          "0005_projection_source_freshness",
          "0006_projection_build_modes",
          "0007_project_context_attribution",
        ]);

        const tableCount = await psql(
          containerName,
          "select count(*) from information_schema.tables where table_schema = 'symphony';",
        );
        expect(Number(tableCount.trim())).toBe([...operationalTables, ...projectionTables, "raw_payload_reference"].length);

        const indexes = await psql(containerName, "select indexname from pg_indexes where schemaname = 'symphony' order by indexname;");
        for (const indexName of [...requiredLookupIndexes, ...requiredProjectionLookupIndexes]) {
          expect(indexes).toContain(indexName);
        }
        await expectProjectionFreshnessCatalog(containerName);

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

  liveIt(
    "upgrades a database that already applied the published 0002 migration without checksum conflicts",
    async () => {
      const containerName = `symphony-postgres-schema-upgrade-${process.pid}-${Date.now()}`;
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

        await applyPublishedOwnedStateBaselineMigrations(connectionString);
        expect(await appliedMigrationIds(containerName)).toEqual(["0001_migration_foundation", "0002_symphony_owned_state"]);
        expect(await appliedMigrationChecksum(containerName, "0002_symphony_owned_state")).toBe(
          publishedOwnedStateChecksumSha256,
        );
        await seedLegacyRunActivityChannelAliases(containerName);
        await seedLegacyProjectionSourceFreshness(containerName);

        const result = await applyConfiguredMigrations(connectionString);
        expect(result.skipped).toEqual(["0001_migration_foundation", "0002_symphony_owned_state"]);
        expect(result.applied).toEqual([
          "0003_projection_freshness_indexes",
          "0004_run_activity_canonical_channels",
          "0005_projection_source_freshness",
          "0006_projection_build_modes",
          "0007_project_context_attribution",
        ]);
        expect(await appliedMigrationIds(containerName)).toEqual([
          "0001_migration_foundation",
          "0002_symphony_owned_state",
          "0003_projection_freshness_indexes",
          "0004_run_activity_canonical_channels",
          "0005_projection_source_freshness",
          "0006_projection_build_modes",
          "0007_project_context_attribution",
        ]);
        expect(await appliedMigrationChecksum(containerName, "0002_symphony_owned_state")).toBe(
          publishedOwnedStateChecksumSha256,
        );
        await expectProjectionFreshnessCatalog(containerName);
        await expectLegacyRunActivityChannelsMigrated(containerName);
        await expectLegacyProjectionSourceFreshnessMigrated(containerName);
        await expectOperationalAndProjectionInsertQueryPaths(containerName);
      } finally {
        await docker(["rm", "-f", containerName]).catch(() => undefined);
      }
    },
    120_000,
  );
});

async function applyConfiguredMigrations(connectionString: string) {
  return applyConfiguredPostgresMigrations({
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

async function applyPublishedOwnedStateBaselineMigrations(connectionString: string): Promise<void> {
  const migrations = await discoverPostgresMigrations(configuredMigrationsDir);
  const baselineMigrations = migrations.filter((migration) =>
    ["0001_migration_foundation", "0002_symphony_owned_state"].includes(migration.id),
  );
  expect(baselineMigrations.map((migration) => migration.id)).toEqual([
    "0001_migration_foundation",
    "0002_symphony_owned_state",
  ]);

  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  try {
    await applyPostgresMigrationsWithClient(client, baselineMigrations, {
      migrationsDir: configuredMigrationsDir,
      migrationsTable: "symphony_schema_migrations",
    });
  } finally {
    client.release();
    await pool.end();
  }
}

async function appliedMigrationIds(containerName: string): Promise<string[]> {
  const appliedMigrations = await psql(containerName, "select id from symphony_schema_migrations order by id;");
  return appliedMigrations.trim().split(/\s+/).filter(Boolean);
}

async function appliedMigrationChecksum(containerName: string, migrationId: string): Promise<string> {
  const checksum = await psql(
    containerName,
    `select checksum_sha256 from symphony_schema_migrations where id = '${migrationId}';`,
  );
  return checksum.trim();
}

async function seedLegacyRunActivityChannelAliases(containerName: string): Promise<void> {
  await psql(
    containerName,
    String.raw`
      insert into symphony.run_session (
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
      ) values (
        'run:canonical-channel-upgrade',
        'session:canonical-channel-upgrade',
        'agent:canonical-channel-upgrade',
        'worker',
        'issue:canonical-channel-upgrade',
        'CANONICAL-CHANNEL-UPGRADE',
        'workspace:canonical-channel-upgrade',
        '/tmp/symphony/CANONICAL-CHANNEL-UPGRADE',
        1,
        'hermes',
        'running',
        now(),
        now()
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
        payload
      ) values
      (
        'activity:canonical-channel-upgrade:message',
        'run:canonical-channel-upgrade',
        'session:canonical-channel-upgrade',
        'run:canonical-channel-upgrade:session:canonical-channel-upgrade',
        1,
        'harness',
        now(),
        'json_rpc',
        'hermes',
        'external:canonical-channel-upgrade:message',
        'assistant',
        'message',
        'assistant_message_delta',
        'legacy message alias',
        20,
        '{"legacyChannel":"message"}'::jsonb
      ),
      (
        'activity:canonical-channel-upgrade:status',
        'run:canonical-channel-upgrade',
        'session:canonical-channel-upgrade',
        'run:canonical-channel-upgrade:session:canonical-channel-upgrade',
        2,
        'harness',
        now(),
        'json_rpc',
        'hermes',
        'external:canonical-channel-upgrade:status',
        'runtime',
        'status',
        'runtime_status_update',
        'legacy status alias',
        19,
        '{"legacyChannel":"status"}'::jsonb
      );
    `,
  );
}

async function seedLegacyProjectionSourceFreshness(containerName: string): Promise<void> {
  await psql(
    containerName,
    String.raw`
      insert into symphony.projection_revision (
        projection_name,
        scope_kind,
        scope_key,
        revision,
        source_revisions,
        source_cursors,
        content_sha256,
        generated_at
      ) values (
        'dashboard_projection',
        'upgrade-test',
        'legacy-source-freshness',
        1,
        jsonb_build_array(
          jsonb_build_object('source', 'github', 'revision', 'gh-55', 'observedAt', '2026-01-02T03:04:05.000Z'),
          jsonb_build_object('source', 'harness', 'revision', 'harness-run-7', 'observedAt', '2026-01-02T03:04:05.000Z'),
          jsonb_build_object('source', 'linear', 'revision', 'lin-42', 'observedAt', '2026-01-02T03:04:05.000Z'),
          jsonb_build_object('source', 'local', 'revision', 'local-snapshot-0', 'observedAt', null)
        ),
        jsonb_build_object(
          'sourceFreshness',
          jsonb_build_array(
            jsonb_build_object(
              'source', 'github',
              'status', 'stale',
              'checkedAt', '2026-01-02T03:04:05.000Z',
              'revision', 'gh-55',
              'lastSuccessAt', '2026-01-02T03:00:05.000Z',
              'lastErrorAt', null,
              'staleMs', 240000,
              'detail', 'legacy GitHub cursor is behind'
            ),
            jsonb_build_object(
              'source', 'harness',
              'status', 'error',
              'checkedAt', '2026-01-02T03:04:05.000Z',
              'revision', 'harness-run-7',
              'lastSuccessAt', null,
              'lastErrorAt', '2026-01-02T03:04:05.000Z',
              'staleMs', null,
              'detail', 'legacy harness transcript ingest failed'
            ),
            jsonb_build_object(
              'source', 'linear',
              'status', 'fresh',
              'checkedAt', '2026-01-02T03:04:05.000Z',
              'revision', 'lin-42',
              'lastSuccessAt', '2026-01-02T03:04:05.000Z',
              'lastErrorAt', null,
              'staleMs', null,
              'detail', 'legacy Linear import is current'
            ),
            jsonb_build_object(
              'source', 'local',
              'status', 'never_synced',
              'checkedAt', '2026-01-02T03:04:05.000Z',
              'revision', null,
              'lastSuccessAt', null,
              'lastErrorAt', null,
              'staleMs', null,
              'detail', 'legacy local snapshot has not run'
            ),
            jsonb_build_object(
              'source', 'runs',
              'status', 'loading',
              'checkedAt', '2026-01-02T03:04:05.000Z',
              'revision', null,
              'lastSuccessAt', null,
              'lastErrorAt', null,
              'staleMs', null,
              'detail', 'legacy run projection is loading'
            ),
            jsonb_build_object(
              'source', 'workspaces',
              'status', 'empty',
              'checkedAt', '2026-01-02T03:04:05.000Z',
              'revision', 0,
              'lastSuccessAt', '2026-01-02T03:04:05.000Z',
              'lastErrorAt', null,
              'staleMs', null,
              'detail', 'legacy workspace source is empty'
            )
          )
        ),
        'legacy-source-freshness-sha',
        '2026-01-02T03:04:05.000Z'
      );
    `,
  );
}

async function expectLegacyRunActivityChannelsMigrated(containerName: string): Promise<void> {
  const channelCounts = await psql(
    containerName,
    String.raw`
      select coalesce(jsonb_object_agg(channel, event_count order by channel), '{}'::jsonb)::text
      from (
        select channel, count(*)::int as event_count
        from symphony.run_activity_event
        where run_id = 'run:canonical-channel-upgrade'
        group by channel
      ) counts;
    `,
  );
  expect(JSON.parse(channelCounts.trim())).toEqual({ chat: 1, diagnostic: 1 });

  const constraintDefinition = await psql(
    containerName,
    String.raw`
      select pg_get_constraintdef(oid)
      from pg_constraint
      where conrelid = 'symphony.run_activity_event'::regclass
        and conname = 'run_activity_event_channel_check';
    `,
  );
  const normalizedConstraint = normalizedSql(constraintDefinition);
  expect(normalizedConstraint).toContain("'chat'::text");
  expect(normalizedConstraint).toContain("'diagnostic'::text");
  expect(normalizedConstraint).not.toContain("'message'::text");
  expect(normalizedConstraint).not.toContain("'status'::text");

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
          'activity:canonical-channel-upgrade:rejected-status',
          'run:canonical-channel-upgrade',
          'session:canonical-channel-upgrade',
          'run:canonical-channel-upgrade:session:canonical-channel-upgrade',
          3,
          'harness',
          now(),
          'json_rpc',
          'hermes',
          'external:canonical-channel-upgrade:rejected-status',
          'runtime',
          'status',
          'runtime_status_update',
          '{"legacyChannel":"status"}'::jsonb
        );
      `,
    ),
  ).rejects.toThrow(/run_activity_event_channel_check|violates check constraint/i);
}

async function expectLegacyProjectionSourceFreshnessMigrated(containerName: string): Promise<void> {
  const sourceFreshness = await psql(
    containerName,
    String.raw`
      select source_freshness::text
      from symphony.projection_revision
      where projection_name = 'dashboard_projection'
        and scope_kind = 'upgrade-test'
        and scope_key = 'legacy-source-freshness';
    `,
  );
  expect(JSON.parse(sourceFreshness.trim())).toEqual([
    {
      source: "github",
      status: "stale",
      checkedAt: "2026-01-02T03:04:05.000Z",
      revision: "gh-55",
      lastSuccessAt: "2026-01-02T03:00:05.000Z",
      lastErrorAt: null,
      staleMs: 240_000,
      detail: "legacy GitHub cursor is behind",
    },
    {
      source: "harness",
      status: "error",
      checkedAt: "2026-01-02T03:04:05.000Z",
      revision: "harness-run-7",
      lastSuccessAt: null,
      lastErrorAt: "2026-01-02T03:04:05.000Z",
      staleMs: null,
      detail: "legacy harness transcript ingest failed",
    },
    {
      source: "linear",
      status: "fresh",
      checkedAt: "2026-01-02T03:04:05.000Z",
      revision: "lin-42",
      lastSuccessAt: "2026-01-02T03:04:05.000Z",
      lastErrorAt: null,
      staleMs: null,
      detail: "legacy Linear import is current",
    },
    {
      source: "local",
      status: "never_synced",
      checkedAt: "2026-01-02T03:04:05.000Z",
      revision: null,
      lastSuccessAt: null,
      lastErrorAt: null,
      staleMs: null,
      detail: "legacy local snapshot has not run",
    },
    {
      source: "runs",
      status: "loading",
      checkedAt: "2026-01-02T03:04:05.000Z",
      revision: null,
      lastSuccessAt: null,
      lastErrorAt: null,
      staleMs: null,
      detail: "legacy run projection is loading",
    },
    {
      source: "workspaces",
      status: "empty",
      checkedAt: "2026-01-02T03:04:05.000Z",
      revision: 0,
      lastSuccessAt: "2026-01-02T03:04:05.000Z",
      lastErrorAt: null,
      staleMs: null,
      detail: "legacy workspace source is empty",
    },
  ]);
}

async function expectProjectionFreshnessCatalog(containerName: string): Promise<void> {
  const columnMetadata = await psql(
    containerName,
    String.raw`
      select coalesce(
        jsonb_object_agg(
          table_name,
          jsonb_build_object('nullable', is_nullable, 'default', column_default)
          order by table_name
        ),
        '{}'::jsonb
      )::text
      from information_schema.columns
      where table_schema = 'symphony'
        and column_name = 'updated_at'
        and table_name in (${sqlStringList(projectionTables)});
    `,
  );
  const columns = JSON.parse(columnMetadata.trim()) as Record<string, { nullable: string; default: string | null }>;
  expect(Object.keys(columns).sort()).toEqual([...projectionTables].sort());
  for (const table of projectionTables) {
    expect(columns[table], `missing updated_at metadata for ${table}`).toMatchObject({ nullable: "NO" });
    expect(columns[table]?.default, `missing updated_at default for ${table}`).toContain("now()");
  }

  const sourceFreshnessColumnMetadata = await psql(
    containerName,
    String.raw`
      select coalesce(jsonb_build_object('nullable', is_nullable, 'default', column_default), '{}'::jsonb)::text
      from information_schema.columns
      where table_schema = 'symphony'
        and table_name = 'projection_revision'
        and column_name = 'source_freshness';
    `,
  );
  const sourceFreshnessColumn = JSON.parse(sourceFreshnessColumnMetadata.trim()) as { nullable?: string; default?: string | null };
  expect(sourceFreshnessColumn).toMatchObject({ nullable: "NO" });
  expect(sourceFreshnessColumn.default?.toLowerCase()).toContain("'[]'::jsonb");

  const sourceFreshnessIndex = await psql(
    containerName,
    String.raw`
      select coalesce(indexdef, '')
      from pg_indexes
      where schemaname = 'symphony'
        and indexname = 'projection_revision_source_freshness_gin_idx';
    `,
  );
  expect(sourceFreshnessIndex.toLowerCase()).toContain("using gin");
  expect(sourceFreshnessIndex.toLowerCase()).toContain("source_freshness");

  const indexMetadata = await psql(
    containerName,
    String.raw`
      select coalesce(jsonb_object_agg(indexname, indexdef order by indexname), '{}'::jsonb)::text
      from pg_indexes
      where schemaname = 'symphony'
        and indexname in (${sqlStringList(projectionFreshnessIndexes)});
    `,
  );
  const indexes = JSON.parse(indexMetadata.trim()) as Record<string, string>;
  expect(Object.keys(indexes).sort()).toEqual([...projectionFreshnessIndexes].sort());
  for (const indexName of projectionFreshnessIndexes) {
    expect(indexes[indexName]?.toLowerCase(), `missing updated_at ordering for ${indexName}`).toContain(
      "updated_at desc",
    );
  }
}

function sqlStringList(values: readonly string[]): string {
  return values.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ");
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
        'chat',
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
          'diagnostic',
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
          'diagnostic',
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

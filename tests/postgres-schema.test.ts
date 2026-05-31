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
    "applies cleanly to an empty PostgreSQL database via Docker",
    async () => {
      const containerName = `symphony-postgres-schema-${process.pid}-${Date.now()}`;
      try {
        await docker(["run", "--rm", "--name", containerName, "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-d", "postgres:16-alpine"], 60_000);
        await waitForPostgres(containerName);
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

        const tableCount = await docker([
          "exec",
          containerName,
          "psql",
          "-U",
          "postgres",
          "-d",
          "postgres",
          "-Atc",
          "select count(*) from information_schema.tables where table_schema = 'symphony';",
        ]);
        expect(Number(tableCount.stdout.trim())).toBe([...operationalTables, ...projectionTables, "raw_payload_reference"].length);

        const indexes = await docker([
          "exec",
          containerName,
          "psql",
          "-U",
          "postgres",
          "-d",
          "postgres",
          "-Atc",
          "select indexname from pg_indexes where schemaname = 'symphony' order by indexname;",
        ]);
        for (const indexName of requiredLookupIndexes) {
          expect(indexes.stdout).toContain(indexName);
        }
      } finally {
        await docker(["rm", "-f", containerName]).catch(() => undefined);
      }
    },
    120_000,
  );
});

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

async function docker(args: readonly string[], timeout = 30_000): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("docker", [...args], { timeout, maxBuffer: 1_000_000 });
}

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { QueryResultRow } from "pg";
import { SymphonyError } from "../src/core/errors.js";
import {
  applyPostgresMigrationsWithClient,
  discoverPostgresMigrations,
  validatePostgresMigrationOrdering,
  type PostgresMigration,
  type PostgresQueryClient,
} from "../src/core/database/PostgresMigrations.js";

describe("Postgres migration foundation", () => {
  it("discovers migrations from the configured directory in deterministic order", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-postgres-migrations-"));
    try {
      await writeFile(path.join(root, "0002_second.sql"), "SELECT 2;\n", "utf8");
      await writeFile(path.join(root, "0001_first.sql"), "SELECT 1;\n", "utf8");
      await writeFile(path.join(root, "README.md"), "ignored\n", "utf8");

      const migrations = await discoverPostgresMigrations(root);

      expect(migrations.map((migration) => migration.id)).toEqual(["0001_first", "0002_second"]);
      expect(migrations.map((migration) => migration.filename)).toEqual(["0001_first.sql", "0002_second.sql"]);
      expect(migrations.every((migration) => /^[a-f0-9]{64}$/.test(migration.checksumSha256))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid names, duplicate versions, and caller-provided out-of-order migration lists", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-postgres-migrations-invalid-"));
    try {
      await writeFile(path.join(root, "not-ordered.sql"), "SELECT 1;\n", "utf8");
      await expect(discoverPostgresMigrations(root)).rejects.toThrow("NNNN_name.sql");
      await rm(root, { recursive: true, force: true });

      await mkdir(root, { recursive: true });
      await writeFile(path.join(root, "0001_first.sql"), "SELECT 1;\n", "utf8");
      await writeFile(path.join(root, "0001_duplicate.sql"), "SELECT 1;\n", "utf8");
      await expect(discoverPostgresMigrations(root)).rejects.toThrow("Duplicate Postgres migration version: 0001");

      const first = migration("0001_first", "0001", "0001_first.sql");
      const second = migration("0002_second", "0002", "0002_second.sql");
      expect(() => validatePostgresMigrationOrdering([second, first])).toThrow("must be sorted by id");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("migrates an empty Postgres client from zero and records migrations idempotently", async () => {
    const first = migration("0001_foundation", "0001", "0001_foundation.sql", "SELECT 1;");
    const second = migration("0002_next", "0002", "0002_next.sql", "SELECT 2;");
    const client = new FakePostgresClient();

    const firstRun = await applyPostgresMigrationsWithClient(client, [first, second], {
      migrationsDir: "/migrations/postgres",
      migrationsTable: "symphony_schema_migrations",
    });

    expect(firstRun.applied).toEqual(["0001_foundation", "0002_next"]);
    expect(firstRun.skipped).toEqual([]);
    expect(client.appliedRows()).toEqual([
      ["0001_foundation", first.checksumSha256],
      ["0002_next", second.checksumSha256],
    ]);
    expect(client.statements).toEqual([
      "SELECT pg_advisory_lock($1)",
      "CREATE TABLE IF NOT EXISTS \"symphony_schema_migrations\" ( id text PRIMARY KEY, checksum_sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now() )",
      "SELECT id, checksum_sha256 FROM \"symphony_schema_migrations\" ORDER BY id",
      "BEGIN",
      "SELECT 1;",
      "INSERT INTO \"symphony_schema_migrations\" (id, checksum_sha256, applied_at) VALUES ($1, $2, now())",
      "COMMIT",
      "BEGIN",
      "SELECT 2;",
      "INSERT INTO \"symphony_schema_migrations\" (id, checksum_sha256, applied_at) VALUES ($1, $2, now())",
      "COMMIT",
      "SELECT pg_advisory_unlock($1)",
    ]);

    const replay = await applyPostgresMigrationsWithClient(client, [first, second], {
      migrationsDir: "/migrations/postgres",
      migrationsTable: "symphony_schema_migrations",
    });

    expect(replay.applied).toEqual([]);
    expect(replay.skipped).toEqual(["0001_foundation", "0002_next"]);
    expect(client.appliedRows()).toHaveLength(2);
  });

  it("stops rather than replaying a migration whose applied checksum changed", async () => {
    const original = migration("0001_foundation", "0001", "0001_foundation.sql", "SELECT 1;");
    const edited = migration("0001_foundation", "0001", "0001_foundation.sql", "SELECT 42;");
    const client = new FakePostgresClient([[original.id, original.checksumSha256]]);

    await expect(
      applyPostgresMigrationsWithClient(client, [edited], {
        migrationsDir: "/migrations/postgres",
        migrationsTable: "symphony_schema_migrations",
      }),
    ).rejects.toBeInstanceOf(SymphonyError);
    expect(client.statements).not.toContain("SELECT 42;");
  });
});

function migration(id: string, version: string, filename: string, sql = "SELECT 1;"): PostgresMigration {
  return {
    id,
    version,
    name: id.slice(version.length + 1),
    filename,
    filePath: `/migrations/postgres/${filename}`,
    checksumSha256: checksum(sql),
    sql,
  };
}

function checksum(input: string): string {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(64, "0");
}

class FakePostgresClient implements PostgresQueryClient {
  readonly statements: string[] = [];
  private readonly applied = new Map<string, string>();

  constructor(appliedRows: Array<[string, string]> = []) {
    for (const [id, migrationChecksum] of appliedRows) {
      this.applied.set(id, migrationChecksum);
    }
  }

  async query<T extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }> {
    this.statements.push(normalizeSql(text));
    const normalized = normalizeSql(text);
    if (normalized.startsWith("SELECT id, checksum_sha256 FROM")) {
      const rows = this.appliedRows().map(([id, migrationChecksum]) => ({ id, checksum_sha256: migrationChecksum }));
      return { rows: rows as unknown as T[] };
    }
    if (normalized.startsWith("INSERT INTO")) {
      const id = String(values?.[0] ?? "");
      const migrationChecksum = String(values?.[1] ?? "");
      this.applied.set(id, migrationChecksum);
    }
    return { rows: [] as T[] };
  }

  appliedRows(): Array<[string, string]> {
    return [...this.applied.entries()].sort(([left], [right]) => left.localeCompare(right));
  }
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

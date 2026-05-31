import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { PoolClient, QueryResultRow } from "pg";
import type { DatabaseConfig } from "../config/Config.js";
import { SymphonyError } from "../errors.js";

export const POSTGRES_MIGRATION_FILENAME_PATTERN = /^(\d{4})_([a-z0-9][a-z0-9_-]*)\.sql$/;
export const POSTGRES_MIGRATION_LOCK_ID = 186_000_001;

export interface PostgresMigration {
  id: string;
  version: string;
  name: string;
  filename: string;
  filePath: string;
  checksumSha256: string;
  sql: string;
}

export interface PostgresMigrationSummaryItem {
  id: string;
  filename: string;
  checksumSha256: string;
}

export interface PostgresMigrationValidationResult {
  migrationsDir: string;
  count: number;
  migrations: PostgresMigrationSummaryItem[];
}

export interface PostgresMigrationApplyResult extends PostgresMigrationValidationResult {
  applied: string[];
  skipped: string[];
}

export interface PostgresQueryClient {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
}

interface AppliedMigrationRow extends QueryResultRow {
  id: string;
  checksum_sha256: string;
}

export async function discoverPostgresMigrations(migrationsDir: string): Promise<PostgresMigration[]> {
  const resolvedDir = path.resolve(migrationsDir);
  let entries;
  try {
    entries = await fs.readdir(resolvedDir, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new SymphonyError("config_validation_error", `Postgres migrations directory does not exist: ${resolvedDir}`, error);
    }
    throw error;
  }

  const migrations: PostgresMigration[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".sql")) continue;
    const match = POSTGRES_MIGRATION_FILENAME_PATTERN.exec(entry.name);
    if (!match?.[1] || !match[2]) {
      throw new SymphonyError(
        "config_validation_error",
        `Postgres migration filename must match NNNN_name.sql: ${entry.name}`,
      );
    }
    const filePath = path.join(resolvedDir, entry.name);
    const sql = normalizePostgresMigrationSql(await fs.readFile(filePath, "utf8"));
    migrations.push({
      id: path.basename(entry.name, ".sql"),
      version: match[1],
      name: match[2],
      filename: entry.name,
      filePath,
      checksumSha256: sha256(sql),
      sql,
    });
  }

  migrations.sort((left, right) => left.version.localeCompare(right.version) || left.id.localeCompare(right.id));
  validatePostgresMigrationOrdering(migrations);
  return migrations;
}

function normalizePostgresMigrationSql(sql: string): string {
  return sql.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function validatePostgresMigrationOrdering(migrations: readonly PostgresMigration[]): void {
  const seenIds = new Set<string>();
  const seenVersions = new Set<string>();
  let previousId: string | null = null;

  for (const migration of migrations) {
    const match = POSTGRES_MIGRATION_FILENAME_PATTERN.exec(migration.filename);
    if (!match?.[1]) {
      throw new SymphonyError(
        "config_validation_error",
        `Postgres migration filename must match NNNN_name.sql: ${migration.filename}`,
      );
    }
    const expectedId = path.basename(migration.filename, ".sql");
    if (migration.id !== expectedId || migration.version !== match[1]) {
      throw new SymphonyError(
        "config_validation_error",
        `Postgres migration metadata must match filename: ${migration.filename}`,
      );
    }
    if (seenIds.has(migration.id)) {
      throw new SymphonyError("config_validation_error", `Duplicate Postgres migration id: ${migration.id}`);
    }
    if (seenVersions.has(migration.version)) {
      throw new SymphonyError("config_validation_error", `Duplicate Postgres migration version: ${migration.version}`);
    }
    if (previousId !== null && migration.id.localeCompare(previousId) <= 0) {
      throw new SymphonyError(
        "config_validation_error",
        `Postgres migrations must be sorted by id: ${migration.id} appears after ${previousId}`,
      );
    }
    seenIds.add(migration.id);
    seenVersions.add(migration.version);
    previousId = migration.id;
  }
}

export async function validateConfiguredPostgresMigrations(
  config: { database: DatabaseConfig },
): Promise<PostgresMigrationValidationResult> {
  const migrations = await discoverPostgresMigrations(config.database.postgres.migrationsDir);
  return summarizeMigrations(config.database.postgres.migrationsDir, migrations);
}

export async function applyConfiguredPostgresMigrations(config: { database: DatabaseConfig }): Promise<PostgresMigrationApplyResult> {
  const connectionString = config.database.postgres.connectionString;
  if (connectionString === null) {
    throw new SymphonyError(
      "config_validation_error",
      "database.postgres.url or SYMPHONY_POSTGRES_URL is required to apply Postgres migrations",
    );
  }

  const migrations = await discoverPostgresMigrations(config.database.postgres.migrationsDir);
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString, ssl: config.database.postgres.ssl });
  const client = await pool.connect();
  try {
    return await applyPostgresMigrationsWithClient(client, migrations, {
      migrationsDir: config.database.postgres.migrationsDir,
      migrationsTable: config.database.postgres.migrationsTable,
    });
  } finally {
    releasePoolClient(client);
    await pool.end();
  }
}

export async function applyPostgresMigrationsWithClient(
  client: PostgresQueryClient,
  migrations: readonly PostgresMigration[],
  options: { migrationsDir: string; migrationsTable: string },
): Promise<PostgresMigrationApplyResult> {
  validatePostgresMigrationOrdering(migrations);
  const tableName = quotePostgresIdentifier(options.migrationsTable);
  const applied: string[] = [];
  const skipped: string[] = [];

  await client.query("SELECT pg_advisory_lock($1)", [POSTGRES_MIGRATION_LOCK_ID]);
  try {
    await ensurePostgresMigrationTable(client, tableName);
    const appliedRows = await client.query<AppliedMigrationRow>(`SELECT id, checksum_sha256 FROM ${tableName} ORDER BY id`);
    const appliedById = new Map(appliedRows.rows.map((row) => [row.id, row.checksum_sha256]));

    for (const migration of migrations) {
      const appliedChecksum = appliedById.get(migration.id);
      if (appliedChecksum !== undefined) {
        if (appliedChecksum !== migration.checksumSha256) {
          throw new SymphonyError(
            "conflict",
            `Applied Postgres migration ${migration.id} has checksum ${appliedChecksum}, expected ${migration.checksumSha256}`,
          );
        }
        skipped.push(migration.id);
        continue;
      }

      await client.query("BEGIN");
      try {
        if (migration.sql.trim().length > 0) {
          await client.query(migration.sql);
        }
        await client.query(
          `INSERT INTO ${tableName} (id, checksum_sha256, applied_at) VALUES ($1, $2, now())`,
          [migration.id, migration.checksumSha256],
        );
        await client.query("COMMIT");
        applied.push(migration.id);
      } catch (error) {
        await rollbackQuietly(client);
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [POSTGRES_MIGRATION_LOCK_ID]);
  }

  return {
    ...summarizeMigrations(options.migrationsDir, migrations),
    applied,
    skipped,
  };
}

function summarizeMigrations(
  migrationsDir: string,
  migrations: readonly PostgresMigration[],
): PostgresMigrationValidationResult {
  return {
    migrationsDir: path.resolve(migrationsDir),
    count: migrations.length,
    migrations: migrations.map((migration) => ({
      id: migration.id,
      filename: migration.filename,
      checksumSha256: migration.checksumSha256,
    })),
  };
}

async function ensurePostgresMigrationTable(client: PostgresQueryClient, tableName: string): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${tableName} (
      id text PRIMARY KEY,
      checksum_sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function rollbackQuietly(client: PostgresQueryClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original migration failure.
  }
}

function quotePostgresIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new SymphonyError(
      "config_validation_error",
      "database.postgres.migrations_table must be a single PostgreSQL identifier using letters, numbers, and underscores",
    );
  }
  return `"${identifier}"`;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function releasePoolClient(client: PoolClient): void {
  client.release();
}

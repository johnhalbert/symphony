import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import sqlite3 from "sqlite3";

import type { Issue } from "../types.js";

type SqliteDatabase = InstanceType<typeof sqlite3.Database>;

export type MergeQueueClaimStatus =
  | "claimed"
  | "already_active"
  | "blocked_by_active_issue";

export type MergeQueueReleaseStatus =
  | "released"
  | "not_active"
  | "not_active_issue";

export interface MergeQueueSnapshot {
  version: 1;
  activeIssueId: string | null;
  activeIssueIdentifier: string | null;
  leaseId: string | null;
  claimedAt: string | null;
  updatedAt: string;
  sequence: number;
  reason: string | null;
}

export interface MergeQueueHistorySnapshot extends MergeQueueSnapshot {
  event: "claim" | "release";
  issueId: string;
  issueIdentifier: string;
}

export interface MergeQueueClaimResult {
  status: MergeQueueClaimStatus;
  snapshot: MergeQueueSnapshot;
}

export interface MergeQueueReleaseResult {
  status: MergeQueueReleaseStatus;
  snapshot: MergeQueueSnapshot;
}

export interface MergeQueueStore {
  close?(): Promise<void>;
  getCurrent(): Promise<MergeQueueSnapshot>;
  claim(
    issue: Pick<Issue, "id" | "identifier">,
    reason: string,
  ): Promise<MergeQueueClaimResult>;
  releaseIfActive(
    issue: Pick<Issue, "id" | "identifier">,
    reason: string,
  ): Promise<MergeQueueReleaseResult>;
  listHistory?(): Promise<MergeQueueHistorySnapshot[]>;
}

interface MergeQueueCurrentRow {
  active_issue_id: string | null;
  active_issue_identifier: string | null;
  lease_id: string | null;
  claimed_at: string | null;
  updated_at: string;
  sequence: number;
  reason: string | null;
}

interface MergeQueueHistoryRow {
  snapshot_json: string;
}

export class SqliteMergeQueueStore implements MergeQueueStore {
  private writeLock: Promise<void> = Promise.resolve();
  private database: SqliteDatabase | null = null;
  private databaseReady: Promise<SqliteDatabase> | null = null;

  constructor(
    private readonly stateDir: string,
    private readonly databaseFileName = "merge-queue.sqlite",
  ) {}

  async close(): Promise<void> {
    await this.writeLock.catch(() => undefined);
    const database = this.database;
    this.database = null;
    this.databaseReady = null;
    if (database) {
      await this.closeDatabase(database);
      await delay(25);
    }
  }

  async getCurrent(): Promise<MergeQueueSnapshot> {
    return this.withStore((database) => this.currentUnlocked(database));
  }

  async claim(
    issue: Pick<Issue, "id" | "identifier">,
    reason: string,
  ): Promise<MergeQueueClaimResult> {
    let result: MergeQueueClaimResult | null = null;
    await this.withWrite(async (database) => {
      const current = await this.currentUnlocked(database);
      if (current.activeIssueId === issue.id) {
        result = { status: "already_active", snapshot: current };
        return;
      }
      if (current.activeIssueId !== null) {
        result = { status: "blocked_by_active_issue", snapshot: current };
        return;
      }

      const now = new Date().toISOString();
      const snapshot: MergeQueueSnapshot = {
        version: 1,
        activeIssueId: issue.id,
        activeIssueIdentifier: issue.identifier,
        leaseId: `merge-queue-lease:${randomUUID()}`,
        claimedAt: now,
        updatedAt: now,
        sequence: current.sequence + 1,
        reason,
      };
      await this.updateCurrentUnlocked(database, snapshot);
      await this.insertHistoryUnlocked(database, "claim", issue, snapshot);
      result = { status: "claimed", snapshot };
    });
    if (!result) throw new Error("Merge queue claim did not produce a result");
    return result;
  }

  async releaseIfActive(
    issue: Pick<Issue, "id" | "identifier">,
    reason: string,
  ): Promise<MergeQueueReleaseResult> {
    let result: MergeQueueReleaseResult | null = null;
    await this.withWrite(async (database) => {
      const current = await this.currentUnlocked(database);
      if (current.activeIssueId === null) {
        result = { status: "not_active", snapshot: current };
        return;
      }
      if (current.activeIssueId !== issue.id) {
        result = { status: "not_active_issue", snapshot: current };
        return;
      }

      const snapshot: MergeQueueSnapshot = {
        version: 1,
        activeIssueId: null,
        activeIssueIdentifier: null,
        leaseId: null,
        claimedAt: null,
        updatedAt: new Date().toISOString(),
        sequence: current.sequence + 1,
        reason,
      };
      await this.updateCurrentUnlocked(database, snapshot);
      await this.insertHistoryUnlocked(database, "release", issue, snapshot);
      result = { status: "released", snapshot };
    });
    if (!result) throw new Error("Merge queue release did not produce a result");
    return result;
  }

  async listHistory(): Promise<MergeQueueHistorySnapshot[]> {
    return this.withStore(async (database) => {
      const rows = await this.allRows<MergeQueueHistoryRow>(
        database,
        "SELECT snapshot_json FROM merge_queue_history ORDER BY sequence",
      );
      return rows.map((row) =>
        normalizeHistorySnapshot(
          JSON.parse(row.snapshot_json) as MergeQueueHistorySnapshot,
        ),
      );
    });
  }

  private async db(): Promise<SqliteDatabase> {
    if (this.database) return this.database;
    this.databaseReady ??= this.open();
    return this.databaseReady;
  }

  private async open(): Promise<SqliteDatabase> {
    await fs.mkdir(this.stateDir, { recursive: true });
    const databasePath = path.join(this.stateDir, this.databaseFileName);
    const database = await new Promise<SqliteDatabase>((resolve, reject) => {
      let created: SqliteDatabase | null = null;
      created = new sqlite3.Database(
        databasePath,
        sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE | sqlite3.OPEN_FULLMUTEX,
        (error) => {
          if (error) {
            created?.close(() => undefined);
            reject(error);
            return;
          }
          if (created === null) {
            reject(
              new Error(
                "SQLite database open callback fired before database assignment",
              ),
            );
            return;
          }
          resolve(created);
        },
      );
    });
    database.configure("busyTimeout", 5000);
    try {
      await this.exec(
        database,
        `
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS merge_queue_current (
          singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
          active_issue_id TEXT,
          active_issue_identifier TEXT,
          lease_id TEXT,
          claimed_at TEXT,
          updated_at TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          reason TEXT
        );

        CREATE TABLE IF NOT EXISTS merge_queue_history (
          sequence INTEGER PRIMARY KEY,
          event TEXT NOT NULL,
          issue_id TEXT NOT NULL,
          issue_identifier TEXT NOT NULL,
          active_issue_id TEXT,
          active_issue_identifier TEXT,
          lease_id TEXT,
          claimed_at TEXT,
          updated_at TEXT NOT NULL,
          reason TEXT,
          snapshot_json TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS merge_queue_history_issue_idx
          ON merge_queue_history(issue_id, sequence);
      `,
      );
      await this.run(
        database,
        `
          INSERT OR IGNORE INTO merge_queue_current (
            singleton_id,
            active_issue_id,
            active_issue_identifier,
            lease_id,
            claimed_at,
            updated_at,
            sequence,
            reason
          )
          VALUES (1, NULL, NULL, NULL, NULL, ?, 0, ?)
        `,
        [new Date().toISOString(), "initialized"],
      );
    } catch (error) {
      await this.closeDatabase(database).catch(() => undefined);
      throw error;
    }
    this.database = database;
    return database;
  }

  private async withStore<T>(
    operation: (database: SqliteDatabase) => Promise<T> | T,
  ): Promise<T> {
    const previous = this.writeLock;
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        const database = await this.db();
        return operation(database);
      });
    this.writeLock = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }

  private async withWrite(
    operation: (database: SqliteDatabase) => Promise<void> | void,
  ): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.withStore(async (database) => {
          await this.exec(database, "BEGIN IMMEDIATE");
          try {
            await operation(database);
            await this.exec(database, "COMMIT");
          } catch (error) {
            await this.exec(database, "ROLLBACK").catch(() => undefined);
            throw error;
          }
        });
        return;
      } catch (error) {
        if (!isSqliteBusyError(error) || attempt >= 10) throw error;
        await delay(25 * (attempt + 1));
      }
    }
  }

  private async currentUnlocked(
    database: SqliteDatabase,
  ): Promise<MergeQueueSnapshot> {
    const row = await this.getRow<MergeQueueCurrentRow>(
      database,
      `
        SELECT active_issue_id, active_issue_identifier, lease_id, claimed_at, updated_at, sequence, reason
        FROM merge_queue_current
        WHERE singleton_id = 1
      `,
    );
    if (!row) throw new Error("Merge queue current row does not exist");
    return snapshotFromCurrentRow(row);
  }

  private async updateCurrentUnlocked(
    database: SqliteDatabase,
    snapshot: MergeQueueSnapshot,
  ): Promise<void> {
    await this.run(
      database,
      `
        UPDATE merge_queue_current
        SET
          active_issue_id = ?,
          active_issue_identifier = ?,
          lease_id = ?,
          claimed_at = ?,
          updated_at = ?,
          sequence = ?,
          reason = ?
        WHERE singleton_id = 1
      `,
      [
        snapshot.activeIssueId,
        snapshot.activeIssueIdentifier,
        snapshot.leaseId,
        snapshot.claimedAt,
        snapshot.updatedAt,
        snapshot.sequence,
        snapshot.reason,
      ],
    );
  }

  private async insertHistoryUnlocked(
    database: SqliteDatabase,
    event: MergeQueueHistorySnapshot["event"],
    issue: Pick<Issue, "id" | "identifier">,
    snapshot: MergeQueueSnapshot,
  ): Promise<void> {
    const history: MergeQueueHistorySnapshot = {
      ...snapshot,
      event,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
    };
    await this.run(
      database,
      `
        INSERT INTO merge_queue_history (
          sequence,
          event,
          issue_id,
          issue_identifier,
          active_issue_id,
          active_issue_identifier,
          lease_id,
          claimed_at,
          updated_at,
          reason,
          snapshot_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        snapshot.sequence,
        event,
        issue.id,
        issue.identifier,
        snapshot.activeIssueId,
        snapshot.activeIssueIdentifier,
        snapshot.leaseId,
        snapshot.claimedAt,
        snapshot.updatedAt,
        snapshot.reason,
        JSON.stringify(history),
      ],
    );
  }

  private async exec(database: SqliteDatabase, sql: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      database.exec(sql, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private async run(
    database: SqliteDatabase,
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      database.run(sql, [...params], (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private async getRow<T>(
    database: SqliteDatabase,
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve, reject) => {
      database.get<T>(sql, [...params], (error, row) => {
        if (error) reject(error);
        else resolve(row);
      });
    });
  }

  private async allRows<T>(
    database: SqliteDatabase,
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    return new Promise<T[]>((resolve, reject) => {
      database.all<T>(sql, [...params], (error, rows) => {
        if (error) reject(error);
        else resolve(rows);
      });
    });
  }

  private async closeDatabase(database: SqliteDatabase): Promise<void> {
    await this.exec(database, "PRAGMA wal_checkpoint(TRUNCATE)").catch(
      () => undefined,
    );
    await this.exec(database, "PRAGMA journal_mode = DELETE").catch(
      () => undefined,
    );
    await new Promise<void>((resolve, reject) => {
      database.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

function snapshotFromCurrentRow(row: MergeQueueCurrentRow): MergeQueueSnapshot {
  return {
    version: 1,
    activeIssueId:
      typeof row.active_issue_id === "string" ? row.active_issue_id : null,
    activeIssueIdentifier:
      typeof row.active_issue_identifier === "string"
        ? row.active_issue_identifier
        : null,
    leaseId: typeof row.lease_id === "string" ? row.lease_id : null,
    claimedAt: typeof row.claimed_at === "string" ? row.claimed_at : null,
    updatedAt:
      typeof row.updated_at === "string"
        ? row.updated_at
        : new Date().toISOString(),
    sequence:
      typeof row.sequence === "number" && Number.isFinite(row.sequence)
        ? row.sequence
        : 0,
    reason: typeof row.reason === "string" ? row.reason : null,
  };
}

function normalizeHistorySnapshot(
  snapshot: MergeQueueHistorySnapshot,
): MergeQueueHistorySnapshot {
  return {
    version: 1,
    event: snapshot.event === "release" ? "release" : "claim",
    issueId: typeof snapshot.issueId === "string" ? snapshot.issueId : "",
    issueIdentifier:
      typeof snapshot.issueIdentifier === "string"
        ? snapshot.issueIdentifier
        : "",
    activeIssueId:
      typeof snapshot.activeIssueId === "string"
        ? snapshot.activeIssueId
        : null,
    activeIssueIdentifier:
      typeof snapshot.activeIssueIdentifier === "string"
        ? snapshot.activeIssueIdentifier
        : null,
    leaseId: typeof snapshot.leaseId === "string" ? snapshot.leaseId : null,
    claimedAt:
      typeof snapshot.claimedAt === "string" ? snapshot.claimedAt : null,
    updatedAt:
      typeof snapshot.updatedAt === "string"
        ? snapshot.updatedAt
        : new Date().toISOString(),
    sequence:
      typeof snapshot.sequence === "number" &&
      Number.isFinite(snapshot.sequence)
        ? snapshot.sequence
        : 0,
    reason: typeof snapshot.reason === "string" ? snapshot.reason : null,
  };
}

function isSqliteBusyError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === "SQLITE_BUSY" ||
    (typeof candidate.message === "string" &&
      candidate.message.includes("SQLITE_BUSY"))
  );
}

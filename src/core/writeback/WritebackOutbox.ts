import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import sqlite3 from "sqlite3";
import type { Logger } from "../logging/StructuredLogger.js";
import type { ServiceConfig } from "../config/Config.js";
import { latestFreshIssueBreakdownPlan } from "../IssueBreakdownPlanService.js";
import { mapWithFileReadConcurrency } from "../persistence/FileReadConcurrency.js";
import {
  isSupersededLifecycleRecord,
  latestCurrentCompletionReport,
  type IssueLifecycleStore,
} from "../persistence/IssueLifecycleStore.js";
import { ProjectionRevisionNotifier, type ProjectionChangeListener, type ProjectionChangeUnsubscribe } from "../persistence/ProjectionRevision.js";
import type { TrackerWriteEvidence, TrackerWriteResult, TrackerWriter } from "../tracker/TrackerWriter.js";
import type { Issue } from "../types.js";
import { errorMessage, SymphonyError } from "../errors.js";

export type WritebackStatus = "pending" | "in_flight" | "succeeded" | "skipped" | "retrying" | "dead_letter";

export type WritebackLifecycleBinding =
  | {
      kind:
        | "completion_report"
        | "completion_report_rejection"
        | "issue_triage_report"
        | "issue_post_mortem_report"
        | "merge_conflict_resolution_report";
      recordId: string;
    }
  | {
      kind: "merge_conflict";
      recordId: string;
    }
  | {
      kind: "review_verdict";
      recordId: string;
    }
  | {
      kind: "merge_gate_result";
      recordId: string;
      resultIdempotencyKey: string;
    }
  | {
      kind: "merge_gate";
      recordId: string;
      status: "superseded";
      headSha: string;
      supersededByHeadSha: string;
    }
  | {
      kind: "issue_checkpoint";
      phase: string;
      prHeadSha: string | null;
      gitBranchName: string | null;
      baseRef: string | null;
      resolvedBlockerProvenanceId: string | null;
    };

export type WritebackOperation =
  | {
      idempotencyKey: string;
      kind: "transition";
      issueId: string;
      runId?: string;
      lifecycleBinding?: WritebackLifecycleBinding;
      status: WritebackStatus;
      attempt: number;
      createdAt: string;
      updatedAt: string;
      nextAttemptAt: string;
      lastError: string | null;
      resultStatus: TrackerWriteResult["status"] | null;
      resultMessage: string | null;
      resultEvidence: TrackerWriteEvidence | null;
      payload: {
        toState: string;
        fromStates?: string[];
        reason?: string;
        issueBreakdownPlanId?: string;
        acceptedArtifactId?: string;
      };
    }
  | {
      idempotencyKey: string;
      kind: "comment";
      issueId: string;
      runId?: string;
      lifecycleBinding?: WritebackLifecycleBinding;
      status: WritebackStatus;
      attempt: number;
      createdAt: string;
      updatedAt: string;
      nextAttemptAt: string;
      lastError: string | null;
      resultStatus: TrackerWriteResult["status"] | null;
      resultMessage: string | null;
      resultEvidence: TrackerWriteEvidence | null;
      payload: { body: string; dedupeKey: string; issueBreakdownPlanId?: string; acceptedArtifactId?: string };
    }
  | {
      idempotencyKey: string;
      kind: "issue_create";
      issueId: string;
      runId?: string;
      lifecycleBinding?: WritebackLifecycleBinding;
      status: WritebackStatus;
      attempt: number;
      createdAt: string;
      updatedAt: string;
      nextAttemptAt: string;
      lastError: string | null;
      resultStatus: TrackerWriteResult["status"] | null;
      resultMessage: string | null;
      resultEvidence: TrackerWriteEvidence | null;
      payload: {
        parentIssueId: string;
        planId: string;
        proposedIssueIndex: number;
        title: string;
        description: string;
        acceptanceCriteria: string[];
        requestedLabels: string[];
        dependencies: string[];
        dedupeKey: string;
        payloadHash: string;
      };
    }
  | {
      idempotencyKey: string;
      kind: "issue_relation";
      issueId: string;
      runId?: string;
      lifecycleBinding?: WritebackLifecycleBinding;
      status: WritebackStatus;
      attempt: number;
      createdAt: string;
      updatedAt: string;
      nextAttemptAt: string;
      lastError: string | null;
      resultStatus: TrackerWriteResult["status"] | null;
      resultMessage: string | null;
      resultEvidence: TrackerWriteEvidence | null;
      payload: {
        planId: string;
        sourceIssueId: string;
        sourceIssueIdentifier: string | null;
        targetIssueId: string;
        targetIssueIdentifier: string | null;
        type: "blocks";
        dependency: string;
        dedupeKey: string;
        sourceProposedIssueIndex: number;
        targetProposedIssueIndex: number;
      };
    };

type PersistedWritebackFields =
  | "status"
  | "attempt"
  | "createdAt"
  | "updatedAt"
  | "nextAttemptAt"
  | "lastError"
  | "resultStatus"
  | "resultMessage"
  | "resultEvidence";

export type NewWritebackOperation =
  | Omit<Extract<WritebackOperation, { kind: "transition" }>, PersistedWritebackFields>
  | Omit<Extract<WritebackOperation, { kind: "comment" }>, PersistedWritebackFields>
  | Omit<Extract<WritebackOperation, { kind: "issue_create" }>, PersistedWritebackFields>
  | Omit<Extract<WritebackOperation, { kind: "issue_relation" }>, PersistedWritebackFields>;

export function bindWritebackOperationToLifecycle<
  T extends NewWritebackOperation,
>(operation: T, binding: WritebackLifecycleBinding): T {
  return { ...operation, lifecycleBinding: binding } as T;
}

export const ISSUE_BREAKDOWN_PLAN_STALE_REASON = "issue breakdown plan is no longer fresh";
export const ISSUE_BREAKDOWN_WRITEBACK_NOT_CURRENT_REASON = "issue breakdown writeback is not bound to the current plan";
export const ACCEPTED_ARTIFACT_WRITEBACK_NOT_CURRENT_REASON =
  "accepted-artifact writeback is not bound to the current completed artifact";

export type IssueBreakdownIssueLookupResult =
  | { status: "ok"; issue: Issue }
  | { status: "not_found" }
  | { status: "transient_error"; message: string };

export type IssueBreakdownFreshnessGuard = {
  getConfig: () => ServiceConfig;
  resolveIssue: (issueId: string) => Promise<IssueBreakdownIssueLookupResult>;
};

export type ProcessDueOptions = {
  idempotencyKeys?: readonly string[];
};

export type EnqueueWritebackOptions = {
  retrySkipped?: boolean;
  retrySkippedMessages?: readonly string[];
};

export interface WritebackOutboxStore {
  close?(): Promise<void>;
  enqueueOnce(operation: NewWritebackOperation): Promise<WritebackOperation>;
  claimDue(now?: Date, options?: { idempotencyKeys?: readonly string[] }): Promise<WritebackOperation[]>;
  markSucceeded(record: WritebackOperation, result?: TrackerWriteResult): Promise<WritebackOperation>;
  markSkipped(record: WritebackOperation, message: string, result?: TrackerWriteResult): Promise<WritebackOperation>;
  requeueSkipped(record: WritebackOperation): Promise<WritebackOperation>;
  markRetry(record: WritebackOperation, error: string, nextAttemptAt: string): Promise<WritebackOperation>;
  markDeadLetter(record: WritebackOperation, error: string): Promise<WritebackOperation>;
  get(idempotencyKey: string): Promise<WritebackOperation | null>;
  list(): Promise<WritebackOperation[]>;
}

type LifecycleGuardResult =
  | { status: "ready" }
  | { status: "blocked"; message: string }
  | { status: "retry"; message: string };

export class FileWritebackOutboxStore implements WritebackOutboxStore {
  private readonly claimLocks = new Set<string>();
  private readonly writeLocks = new Map<string, Promise<void>>();
  private readonly projectionNotifier = new ProjectionRevisionNotifier();

  constructor(private readonly stateDir: string) {}

  projectionRevision(): number {
    return this.projectionNotifier.currentRevision();
  }

  onProjectionChanged(listener: ProjectionChangeListener): ProjectionChangeUnsubscribe {
    return this.projectionNotifier.subscribe(listener);
  }

  async enqueueOnce(operation: NewWritebackOperation): Promise<WritebackOperation> {
    const existing = await this.get(operation.idempotencyKey);
    if (existing) {
      const upgraded = compatibleExistingWriteback(existing, operation);
      if (upgraded === existing) return existing;
      await this.write(upgraded);
      this.notifyProjectionChanged();
      return upgraded;
    }
    const now = new Date().toISOString();
    const record = {
      ...operation,
      status: "pending",
      attempt: 0,
      createdAt: now,
      updatedAt: now,
      nextAttemptAt: now,
      lastError: null,
      resultStatus: null,
      resultMessage: null,
      resultEvidence: null,
    } as WritebackOperation;
    await this.write(record);
    this.notifyProjectionChanged();
    return record;
  }

  async claimDue(now = new Date(), options: { idempotencyKeys?: readonly string[] } = {}): Promise<WritebackOperation[]> {
    const records = await this.list();
    const allowed = options.idempotencyKeys === undefined ? null : new Set(options.idempotencyKeys);
    const due = records
      .filter((record) => ["pending", "retrying"].includes(record.status))
      .filter((record) => Date.parse(record.nextAttemptAt) <= now.getTime())
      .filter((record) => allowed === null || allowed.has(record.idempotencyKey))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const claimed: WritebackOperation[] = [];
    for (const record of due) {
      if (this.claimLocks.has(record.idempotencyKey)) continue;
      this.claimLocks.add(record.idempotencyKey);
      try {
        const current = await this.get(record.idempotencyKey);
        if (!current) continue;
        if (!["pending", "retrying"].includes(current.status)) continue;
        if (Date.parse(current.nextAttemptAt) > now.getTime()) continue;
        if (allowed !== null && !allowed.has(current.idempotencyKey)) continue;
        current.status = "in_flight";
        current.updatedAt = new Date().toISOString();
        await this.write(current);
        this.notifyProjectionChanged();
        claimed.push(current);
      } finally {
        this.claimLocks.delete(record.idempotencyKey);
      }
    }
    return claimed;
  }

  async markSucceeded(record: WritebackOperation, result?: TrackerWriteResult): Promise<WritebackOperation> {
    return this.update(record, {
      status: "succeeded",
      lastError: null,
      resultStatus: result?.status ?? null,
      resultMessage: result?.message ?? null,
      resultEvidence: result?.evidence ?? null,
    });
  }

  async markSkipped(record: WritebackOperation, message: string, result?: TrackerWriteResult): Promise<WritebackOperation> {
    return this.update(record, {
      status: "skipped",
      lastError: message,
      resultStatus: result?.status ?? null,
      resultMessage: result?.message ?? message,
      resultEvidence: result?.evidence ?? null,
    });
  }

  async requeueSkipped(record: WritebackOperation): Promise<WritebackOperation> {
    if (record.status !== "skipped") return record;
    return this.update(record, {
      status: "pending",
      nextAttemptAt: new Date().toISOString(),
      lastError: null,
    });
  }

  async markRetry(record: WritebackOperation, error: string, nextAttemptAt: string): Promise<WritebackOperation> {
    return this.update(record, {
      status: "retrying",
      attempt: record.attempt + 1,
      lastError: error,
      nextAttemptAt,
    });
  }

  async markDeadLetter(record: WritebackOperation, error: string): Promise<WritebackOperation> {
    return this.update(record, { status: "dead_letter", attempt: record.attempt + 1, lastError: error });
  }

  async get(idempotencyKey: string): Promise<WritebackOperation | null> {
    const current = await readJsonIfExists<WritebackOperation>(this.recordPath(idempotencyKey));
    if (current) return current;
    const legacy = this.legacyRecordPath(idempotencyKey);
    if (legacy === this.recordPath(idempotencyKey)) return null;
    return readJsonIfExists<WritebackOperation>(legacy);
  }

  async list(): Promise<WritebackOperation[]> {
    await fs.mkdir(this.recordsDir(), { recursive: true });
    const entries = await fs.readdir(this.recordsDir());
    const records = await mapWithFileReadConcurrency(
      entries.filter((entry) => entry.endsWith(".json")).map((entry) => path.join(this.recordsDir(), entry)),
      (filePath) => readJsonIfExists<WritebackOperation>(filePath),
    );
    return dedupeWritebackRecords(records.filter((record): record is WritebackOperation => record !== null));
  }

  private async update(record: WritebackOperation, patch: Partial<WritebackOperation>): Promise<WritebackOperation> {
    const updated = { ...record, ...patch, updatedAt: new Date().toISOString() } as WritebackOperation;
    await this.write(updated);
    this.notifyProjectionChanged();
    return updated;
  }

  private notifyProjectionChanged(): void {
    this.projectionNotifier.notify("writeback");
  }

  private async write(record: WritebackOperation): Promise<void> {
    const previous = this.writeLocks.get(record.idempotencyKey) ?? Promise.resolve();
    let current!: Promise<void>;
    current = (async () => {
      await previous.catch(() => undefined);
      try {
        await this.writeUnlocked(record);
      } finally {
        if (this.writeLocks.get(record.idempotencyKey) === current) {
          this.writeLocks.delete(record.idempotencyKey);
        }
      }
    })();
    this.writeLocks.set(record.idempotencyKey, current);
    await current;
  }

  private async writeUnlocked(record: WritebackOperation): Promise<void> {
    await fs.mkdir(this.recordsDir(), { recursive: true });
    const target = this.recordPath(record.idempotencyKey);
    const temp = path.join(this.recordsDir(), `${path.basename(target)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
    await fs.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    if (process.platform === "win32") {
      await fs.rm(target, { force: true });
    }
    await fs.rename(temp, target);
    const legacy = this.legacyRecordPath(record.idempotencyKey);
    if (legacy !== target) await rmIfExists(legacy);
  }

  private recordsDir(): string {
    return path.join(this.stateDir, "writeback");
  }

  private recordPath(idempotencyKey: string): string {
    return path.join(this.recordsDir(), shortRecordFileName(idempotencyKey));
  }

  private legacyRecordPath(idempotencyKey: string): string {
    return path.join(this.recordsDir(), `${safeFileName(idempotencyKey)}.json`);
  }
}

type SqliteDatabase = InstanceType<typeof sqlite3.Database>;

interface WritebackOperationRow {
  idempotency_key: string;
  kind: WritebackOperation["kind"];
  issue_id: string;
  run_id: string | null;
  status: WritebackStatus;
  attempt: number;
  created_at: string;
  updated_at: string;
  next_attempt_at: string;
  last_error: string | null;
  result_status: TrackerWriteResult["status"] | null;
  result_message: string | null;
  result_evidence_json: string | null;
  lifecycle_binding_json: string | null;
  payload_json: string;
}

export class SqliteWritebackOutboxStore implements WritebackOutboxStore {
  private writeLock: Promise<void> = Promise.resolve();
  private database: SqliteDatabase | null = null;
  private databaseReady: Promise<SqliteDatabase> | null = null;
  private readonly projectionNotifier = new ProjectionRevisionNotifier();

  constructor(
    private readonly stateDir: string,
    private readonly databaseFileName = "writeback.sqlite",
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

  projectionRevision(): number {
    return this.projectionNotifier.currentRevision();
  }

  onProjectionChanged(listener: ProjectionChangeListener): ProjectionChangeUnsubscribe {
    return this.projectionNotifier.subscribe(listener);
  }

  async enqueueOnce(operation: NewWritebackOperation): Promise<WritebackOperation> {
    let changed = false;
    const record = await this.withWrite(async (database) => {
      const existing = await this.getUnlocked(database, operation.idempotencyKey);
      if (existing) {
        const upgraded = compatibleExistingWriteback(existing, operation);
        if (upgraded === existing) return existing;
        await this.upsertRecordUnlocked(database, upgraded);
        changed = true;
        return upgraded;
      }
      const now = new Date().toISOString();
      const next = {
        ...operation,
        status: "pending",
        attempt: 0,
        createdAt: now,
        updatedAt: now,
        nextAttemptAt: now,
        lastError: null,
        resultStatus: null,
        resultMessage: null,
        resultEvidence: null,
      } as WritebackOperation;
      await this.upsertRecordUnlocked(database, next);
      changed = true;
      return next;
    });
    if (changed) this.notifyProjectionChanged();
    return record;
  }

  async claimDue(now = new Date(), options: { idempotencyKeys?: readonly string[] } = {}): Promise<WritebackOperation[]> {
    const idempotencyKeys = options.idempotencyKeys === undefined ? null : Array.from(new Set(options.idempotencyKeys));
    if (idempotencyKeys !== null && idempotencyKeys.length === 0) return [];
    let changed = false;
    const claimed = await this.withWrite(async (database) => {
      const allowedClause = idempotencyKeys === null ? "" : ` AND idempotency_key IN (${idempotencyKeys.map(() => "?").join(", ")})`;
      const rows = await this.allRows<WritebackOperationRow>(
        database,
        `
          SELECT *
          FROM writeback_operations
          WHERE status IN ('pending', 'retrying')
            AND next_attempt_at <= ?
            ${allowedClause}
          ORDER BY created_at, idempotency_key
        `,
        [now.toISOString(), ...(idempotencyKeys ?? [])],
      );
      const updates: WritebackOperation[] = [];
      for (const row of rows) {
        const updatedAt = new Date().toISOString();
        const result = await this.run(
          database,
          `
            UPDATE writeback_operations
            SET status = 'in_flight',
                updated_at = ?
            WHERE idempotency_key = ?
              AND status IN ('pending', 'retrying')
              AND next_attempt_at <= ?
          `,
          [updatedAt, row.idempotency_key, now.toISOString()],
        );
        if (result.changes !== 1) continue;
        changed = true;
        updates.push(
          this.recordFromRow({
            ...row,
            status: "in_flight",
            updated_at: updatedAt,
          }),
        );
      }
      return updates;
    });
    if (changed) this.notifyProjectionChanged();
    return claimed;
  }

  async markSucceeded(record: WritebackOperation, result?: TrackerWriteResult): Promise<WritebackOperation> {
    return this.update(record, {
      status: "succeeded",
      lastError: null,
      resultStatus: result?.status ?? null,
      resultMessage: result?.message ?? null,
      resultEvidence: result?.evidence ?? null,
    });
  }

  async markSkipped(record: WritebackOperation, message: string, result?: TrackerWriteResult): Promise<WritebackOperation> {
    return this.update(record, {
      status: "skipped",
      lastError: message,
      resultStatus: result?.status ?? null,
      resultMessage: result?.message ?? message,
      resultEvidence: result?.evidence ?? null,
    });
  }

  async requeueSkipped(record: WritebackOperation): Promise<WritebackOperation> {
    if (record.status !== "skipped") return record;
    return this.update(record, {
      status: "pending",
      nextAttemptAt: new Date().toISOString(),
      lastError: null,
    });
  }

  async markRetry(record: WritebackOperation, error: string, nextAttemptAt: string): Promise<WritebackOperation> {
    return this.update(record, {
      status: "retrying",
      attempt: record.attempt + 1,
      lastError: error,
      nextAttemptAt,
    });
  }

  async markDeadLetter(record: WritebackOperation, error: string): Promise<WritebackOperation> {
    return this.update(record, { status: "dead_letter", attempt: record.attempt + 1, lastError: error });
  }

  async get(idempotencyKey: string): Promise<WritebackOperation | null> {
    return this.withStore((database) => this.getUnlocked(database, idempotencyKey));
  }

  async list(): Promise<WritebackOperation[]> {
    return this.withStore(async (database) => {
      const rows = await this.allRows<WritebackOperationRow>(
        database,
        "SELECT * FROM writeback_operations ORDER BY created_at, idempotency_key",
      );
      return rows.map((row) => this.recordFromRow(row));
    });
  }

  private async update(record: WritebackOperation, patch: Partial<WritebackOperation>): Promise<WritebackOperation> {
    const updated = { ...record, ...patch, updatedAt: new Date().toISOString() } as WritebackOperation;
    await this.withWrite((database) => this.upsertRecordUnlocked(database, updated));
    this.notifyProjectionChanged();
    return updated;
  }

  private notifyProjectionChanged(): void {
    this.projectionNotifier.notify("writeback");
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
            reject(new Error("SQLite database open callback fired before database assignment"));
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

          CREATE TABLE IF NOT EXISTS writeback_operations (
            idempotency_key TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            issue_id TEXT NOT NULL,
            run_id TEXT NULL,
            status TEXT NOT NULL,
            attempt INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            next_attempt_at TEXT NOT NULL,
            last_error TEXT NULL,
            result_status TEXT NULL,
            result_message TEXT NULL,
            result_evidence_json TEXT NULL,
            lifecycle_binding_json TEXT NULL,
            payload_json TEXT NOT NULL
          );

          CREATE INDEX IF NOT EXISTS writeback_operations_due_idx
            ON writeback_operations(status, next_attempt_at, created_at);

          CREATE INDEX IF NOT EXISTS writeback_operations_issue_idx
            ON writeback_operations(issue_id);

          CREATE INDEX IF NOT EXISTS writeback_operations_run_idx
            ON writeback_operations(run_id);
        `,
      );
      const columns = await this.allRows<{ name: string }>(
        database,
        "PRAGMA table_info(writeback_operations)",
      );
      if (!columns.some((column) => column.name === "lifecycle_binding_json")) {
        await this.exec(
          database,
          "ALTER TABLE writeback_operations ADD COLUMN lifecycle_binding_json TEXT NULL",
        );
      }
      await this.importLegacyRecords(database);
    } catch (error) {
      await this.closeDatabase(database).catch(() => undefined);
      throw error;
    }
    this.database = database;
    return database;
  }

  private async withStore<T>(operation: (database: SqliteDatabase) => Promise<T> | T): Promise<T> {
    const previous = this.writeLock;
    const current = previous.catch(() => undefined).then(async () => {
      const database = await this.db();
      return operation(database);
    });
    this.writeLock = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }

  private async withWrite<T>(operation: (database: SqliteDatabase) => Promise<T> | T): Promise<T> {
    return this.withStore(async (database) => {
      await this.exec(database, "BEGIN IMMEDIATE");
      try {
        const result = await operation(database);
        await this.exec(database, "COMMIT");
        return result;
      } catch (error) {
        await this.exec(database, "ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
  }

  private async importLegacyRecords(database: SqliteDatabase): Promise<void> {
    const legacyStore = new FileWritebackOutboxStore(this.stateDir);
    const records = await legacyStore.list();
    if (records.length === 0) return;

    await this.exec(database, "BEGIN IMMEDIATE");
    try {
      for (const record of records) {
        const existing = await this.getUnlocked(database, record.idempotencyKey);
        if (existing && Date.parse(existing.updatedAt) > Date.parse(record.updatedAt)) continue;
        await this.upsertRecordUnlocked(database, record);
      }
      await this.exec(database, "COMMIT");
    } catch (error) {
      await this.exec(database, "ROLLBACK").catch(() => undefined);
      throw error;
    }
  }

  private async getUnlocked(database: SqliteDatabase, idempotencyKey: string): Promise<WritebackOperation | null> {
    const row = await this.getRow<WritebackOperationRow>(
      database,
      "SELECT * FROM writeback_operations WHERE idempotency_key = ?",
      [idempotencyKey],
    );
    return row ? this.recordFromRow(row) : null;
  }

  private async upsertRecordUnlocked(database: SqliteDatabase, record: WritebackOperation): Promise<void> {
    await this.run(
      database,
      `
        INSERT INTO writeback_operations (
          idempotency_key,
          kind,
          issue_id,
          run_id,
          status,
          attempt,
          created_at,
          updated_at,
          next_attempt_at,
          last_error,
          result_status,
          result_message,
          result_evidence_json,
          lifecycle_binding_json,
          payload_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(idempotency_key) DO UPDATE SET
          kind = excluded.kind,
          issue_id = excluded.issue_id,
          run_id = excluded.run_id,
          status = excluded.status,
          attempt = excluded.attempt,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          next_attempt_at = excluded.next_attempt_at,
          last_error = excluded.last_error,
          result_status = excluded.result_status,
          result_message = excluded.result_message,
          result_evidence_json = excluded.result_evidence_json,
          lifecycle_binding_json = excluded.lifecycle_binding_json,
          payload_json = excluded.payload_json
      `,
      this.paramsForRecord(record),
    );
  }

  private paramsForRecord(record: WritebackOperation): readonly unknown[] {
    return [
      record.idempotencyKey,
      record.kind,
      record.issueId,
      record.runId ?? null,
      record.status,
      record.attempt,
      record.createdAt,
      record.updatedAt,
      record.nextAttemptAt,
      record.lastError,
      record.resultStatus,
      record.resultMessage,
      record.resultEvidence === null ? null : JSON.stringify(record.resultEvidence),
      record.lifecycleBinding === undefined
        ? null
        : JSON.stringify(record.lifecycleBinding),
      JSON.stringify(record.payload),
    ];
  }

  private recordFromRow(row: WritebackOperationRow): WritebackOperation {
    return {
      idempotencyKey: row.idempotency_key,
      kind: row.kind,
      issueId: row.issue_id,
      ...(row.run_id === null ? {} : { runId: row.run_id }),
      ...(row.lifecycle_binding_json === null
        ? {}
        : {
            lifecycleBinding: JSON.parse(
              row.lifecycle_binding_json,
            ) as WritebackLifecycleBinding,
          }),
      status: row.status,
      attempt: row.attempt,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      nextAttemptAt: row.next_attempt_at,
      lastError: row.last_error,
      resultStatus: row.result_status,
      resultMessage: row.result_message,
      resultEvidence: row.result_evidence_json === null ? null : (JSON.parse(row.result_evidence_json) as TrackerWriteEvidence),
      payload: JSON.parse(row.payload_json) as WritebackOperation["payload"],
    } as WritebackOperation;
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
  ): Promise<{ changes: number; lastID: number }> {
    return new Promise<{ changes: number; lastID: number }>((resolve, reject) => {
      database.run(sql, [...params], function (this: sqlite3.RunResult, error) {
        if (error) reject(error);
        else resolve({ changes: this.changes, lastID: this.lastID });
      });
    });
  }

  private async getRow<T>(database: SqliteDatabase, sql: string, params: readonly unknown[] = []): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve, reject) => {
      database.get<T>(sql, [...params], (error, row) => {
        if (error) reject(error);
        else resolve(row);
      });
    });
  }

  private async allRows<T>(database: SqliteDatabase, sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return new Promise<T[]>((resolve, reject) => {
      database.all<T>(sql, [...params], (error, rows) => {
        if (error) reject(error);
        else resolve(rows);
      });
    });
  }

  private async closeDatabase(database: SqliteDatabase): Promise<void> {
    await this.exec(database, "PRAGMA wal_checkpoint(TRUNCATE)").catch(() => undefined);
    await this.exec(database, "PRAGMA journal_mode = DELETE").catch(() => undefined);
    await new Promise<void>((resolve, reject) => {
      database.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

export class WritebackProcessor {
  constructor(
    private readonly store: WritebackOutboxStore,
    private readonly writer: TrackerWriter,
    private readonly logger: Logger,
    private readonly maxBackoffMs: number,
    private lifecycleStore?: Pick<IssueLifecycleStore, "get">,
    private readonly dryRun = false,
    private readonly issueBreakdownFreshnessGuard?: IssueBreakdownFreshnessGuard,
  ) {}

  bindLifecycleStore(lifecycleStore: Pick<IssueLifecycleStore, "get">): void {
    this.lifecycleStore ??= lifecycleStore;
  }

  async close(): Promise<void> {
    await this.store.close?.();
  }

  async enqueue(operation: NewWritebackOperation): Promise<WritebackOperation> {
    return this.store.enqueueOnce(operation);
  }

  async enqueueAndProcess(operation: NewWritebackOperation, options: EnqueueWritebackOptions = {}): Promise<WritebackOperation> {
    let record = await this.store.enqueueOnce(operation);
    if (record.status === "succeeded") return record;
    if (canRetrySkipped(record, operation, options)) {
      record = await this.store.requeueSkipped(record);
    }
    await this.processDue();
    return (await this.store.get(record.idempotencyKey)) ?? record;
  }

  async retryRegistered(
    idempotencyKeys: readonly string[],
    options: EnqueueWritebackOptions = {},
  ): Promise<WritebackOperation[]> {
    const records = await Promise.all(
      idempotencyKeys.map((idempotencyKey) => this.store.get(idempotencyKey)),
    );
    const missingIndex = records.findIndex((record) => record === null);
    if (missingIndex >= 0) {
      throw new SymphonyError(
        "invalid_request",
        `Registered writeback does not exist: ${idempotencyKeys[missingIndex]}`,
      );
    }
    for (const record of records) {
      if (
        record?.status === "skipped" &&
        options.retrySkipped === true &&
        (options.retrySkippedMessages === undefined ||
          options.retrySkippedMessages.some(
            (message) =>
              record.lastError === message || record.resultMessage === message,
          ))
      ) {
        await this.store.requeueSkipped(record);
      }
    }
    await this.processDue({ idempotencyKeys });
    return Promise.all(
      idempotencyKeys.map(async (idempotencyKey, index) =>
        (await this.store.get(idempotencyKey)) ?? records[index]!,
      ),
    );
  }

  async processDue(options: ProcessDueOptions = {}): Promise<void> {
    const claimOptions = options.idempotencyKeys === undefined ? {} : { idempotencyKeys: options.idempotencyKeys };
    for (const record of await this.store.claimDue(new Date(), claimOptions)) {
      try {
        const guard = await this.verifyLifecycleBoundOperation(record);
        if (guard.status === "blocked") {
          await this.store.markSkipped(record, guard.message);
          continue;
        }
        if (guard.status === "retry") {
          const nextAttemptAt =
            record.lifecycleBinding === undefined
              ? new Date(
                  Date.now() +
                    computeWritebackBackoffMs(
                      record.attempt + 1,
                      this.maxBackoffMs,
                    ),
                ).toISOString()
              : new Date().toISOString();
          await this.store.markRetry(record, guard.message, nextAttemptAt);
          continue;
        }
        const result = await this.execute(record);
        if (result.status === "applied" || result.status === "verified") {
          await this.store.markSucceeded(record, result);
        } else {
          await this.store.markSkipped(record, result.message ?? `Writeback ${result.status}`, result);
        }
      } catch (error) {
        const message = errorMessage(error);
        const nextAttemptAt = new Date(Date.now() + computeWritebackBackoffMs(record.attempt + 1, this.maxBackoffMs)).toISOString();
        await this.store.markRetry(record, message, nextAttemptAt);
        this.logger.warn("writeback operation failed", {
          issue_id: record.issueId,
          kind: record.kind,
          idempotency_key: record.idempotencyKey,
          error: message,
        });
      }
    }
  }

  private async verifyLifecycleBoundOperation(record: WritebackOperation): Promise<LifecycleGuardResult> {
    const explicitBindingGuard = await this.verifyExplicitLifecycleBinding(record);
    if (explicitBindingGuard.status !== "ready") return explicitBindingGuard;
    const acceptedArtifactBinding = acceptedArtifactBindingForOperation(record);
    if (acceptedArtifactBinding.status === "blocked") {
      return { status: "blocked", message: acceptedArtifactBinding.message };
    }
    if (acceptedArtifactBinding.status === "bound") {
      const acceptedArtifactId = acceptedArtifactBinding.artifactId;
      if (!this.lifecycleStore) {
        return { status: "blocked", message: "accepted-artifact writeback requires lifecycle guard" };
      }
      const lifecycle = await this.lifecycleStore.get(record.issueId);
      const artifact = lifecycle?.acceptedArtifact ?? null;
      if (!artifact || artifact.id !== acceptedArtifactId) {
        return { status: "blocked", message: ACCEPTED_ARTIFACT_WRITEBACK_NOT_CURRENT_REASON };
      }
      if (isSupersededLifecycleRecord(artifact)) {
        return { status: "blocked", message: ACCEPTED_ARTIFACT_WRITEBACK_NOT_CURRENT_REASON };
      }
      if (artifact.status !== "completed_unmerged") {
        return { status: "retry", message: "accepted-artifact writeback is waiting for verified PR closure" };
      }
      const registeredKey =
        record.kind === "comment"
          ? artifact.commentOperationKey
          : record.kind === "transition"
            ? artifact.doneTransitionOperationKey
            : null;
      if (registeredKey !== record.idempotencyKey) {
        return { status: "blocked", message: "accepted-artifact writeback is not registered on the current artifact" };
      }
      return { status: "ready" };
    }
    const issueBreakdownBinding = issueBreakdownPlanBindingForOperation(record);
    if (issueBreakdownBinding.status === "blocked") {
      return { status: "blocked", message: issueBreakdownBinding.message };
    }
    if (issueBreakdownBinding.status === "bound") {
      const issueBreakdownPlanId = issueBreakdownBinding.planId;
      if (!this.lifecycleStore) return { status: "blocked", message: "issue breakdown writeback requires lifecycle guard" };
      const lifecycle = await this.lifecycleStore.get(record.issueId);
      const plan = lifecycle?.issueBreakdownPlans.find((candidate) => candidate.id === issueBreakdownPlanId);
      if (!lifecycle || !plan || lifecycle.lastIssueBreakdownPlanId !== issueBreakdownPlanId) {
        return { status: "blocked", message: ISSUE_BREAKDOWN_WRITEBACK_NOT_CURRENT_REASON };
      }
      const dispositionComment = isIssueBreakdownDispositionComment(record);
      if (plan.applicationStatus === "stale" && !dispositionComment) {
        return { status: "blocked", message: ISSUE_BREAKDOWN_PLAN_STALE_REASON };
      }
      if (!plan.applicationOperationKeys.includes(record.idempotencyKey)) {
        return { status: "blocked", message: "issue breakdown writeback is not registered on the current plan" };
      }
      if (dispositionComment) return { status: "ready" };
      if (
        (record.kind === "comment" || record.kind === "issue_relation" || record.kind === "transition") &&
        plan.createdIssueRefs.length < plan.proposedIssues.length
      ) {
        return { status: "blocked", message: "issue breakdown finalization writeback requires durable child refs" };
      }
      if (!this.issueBreakdownFreshnessGuard) {
        return { status: "blocked", message: "issue breakdown writeback requires freshness guard" };
      }
      const config = this.issueBreakdownFreshnessGuard.getConfig();
      const lookup = await this.issueBreakdownFreshnessGuard.resolveIssue(record.issueId);
      if (lookup.status === "transient_error") {
        return { status: "retry", message: `issue breakdown freshness lookup failed: ${lookup.message}` };
      }
      if (lookup.status === "not_found") {
        return { status: "blocked", message: ISSUE_BREAKDOWN_PLAN_STALE_REASON };
      }
      const freshPlan = latestFreshIssueBreakdownPlan(lifecycle, lookup.issue, config);
      if (freshPlan?.id !== issueBreakdownPlanId) {
        return { status: "blocked", message: ISSUE_BREAKDOWN_PLAN_STALE_REASON };
      }
      return { status: "ready" };
    }
    if (!isPullRequestHandoffOperation(record) || !this.lifecycleStore) return { status: "ready" };
    const lifecycle = await this.lifecycleStore.get(record.issueId);
    const acceptedReport = lifecycle === null
      ? null
      : latestCurrentCompletionReport(lifecycle);
    if (!acceptedReport || !acceptedReport.writebackOperationKeys.includes(record.idempotencyKey) || acceptedReport.pullRequest === null) {
      return {
        status: "blocked",
        message: "pull request handoff requires a durable accepted completion report with matching PR evidence",
      };
    }
    return { status: "ready" };
  }

  private async verifyExplicitLifecycleBinding(
    record: WritebackOperation,
  ): Promise<LifecycleGuardResult> {
    const binding = record.lifecycleBinding;
    if (binding === undefined) return { status: "ready" };
    if (!this.lifecycleStore) {
      return {
        status: "blocked",
        message: "lifecycle-bound writeback requires a lifecycle guard",
      };
    }
    const lifecycle = await this.lifecycleStore.get(record.issueId);
    if (lifecycle === null) {
      return {
        status: "retry",
        message: "lifecycle-bound writeback is waiting for its durable record",
      };
    }
    if (binding.kind === "merge_conflict") {
      const conflict = lifecycle.mergeConflict;
      if (conflict === null || conflict.id !== binding.recordId) {
        return {
          status: "retry",
          message: "merge-conflict writeback is waiting for its durable conflict record",
        };
      }
      return conflict.writebackOperationKeys.includes(record.idempotencyKey)
        ? { status: "ready" }
        : {
            status: "retry",
            message: "merge-conflict writeback is waiting for operation registration",
          };
    }
    if (binding.kind === "merge_gate") {
      const gate = lifecycle.mergeGate;
      if (gate == null) {
        return {
          status: "retry",
          message: "merge-gate writeback is waiting for its durable gate record",
        };
      }
      if (gate.id !== binding.recordId) {
        return {
          status: "blocked",
          message: "merge-gate writeback is no longer bound to the current gate",
        };
      }
      if (
        gate.status !== binding.status ||
        gate.headSha !== binding.headSha ||
        gate.supersededByHeadSha !== binding.supersededByHeadSha
      ) {
        return {
          status: "retry",
          message: "merge-gate writeback is waiting for its durable supersession state",
        };
      }
      return gate.writebackOperationKeys.includes(record.idempotencyKey)
        ? { status: "ready" }
        : {
            status: "retry",
            message: "merge-gate writeback is waiting for operation registration",
          };
    }
    if (binding.kind === "issue_checkpoint") {
      const pointers = lifecycle.summaryPointers;
      const provenanceResolved =
        binding.resolvedBlockerProvenanceId === null ||
        (lifecycle.blockerProvenances ?? []).some(
          (candidate) =>
            candidate.id === binding.resolvedBlockerProvenanceId &&
            candidate.resolvedAt !== null,
        );
      if (
        lifecycle.phase !== binding.phase ||
        (pointers.prHeadSha ?? null) !== binding.prHeadSha ||
        (pointers.gitBranchName ?? null) !== binding.gitBranchName ||
        (pointers.baseRef ?? null) !== binding.baseRef ||
        !provenanceResolved
      ) {
        return {
          status: "retry",
          message: "writeback is waiting for its durable lifecycle checkpoint",
        };
      }
      return { status: "ready" };
    }
    if (binding.kind === "merge_gate_result") {
      const owner = (lifecycle.mergeGateResults ?? []).find(
        (candidate) => candidate.id === binding.recordId,
      );
      if (owner === undefined) {
        return {
          status: "retry",
          message: "merge-gate-result writeback is waiting for its durable result",
        };
      }
      if (isSupersededLifecycleRecord(owner)) {
        return {
          status: "blocked",
          message: "merge-gate-result writeback owner has been superseded",
        };
      }
      if (owner.idempotencyKey !== binding.resultIdempotencyKey) {
        return {
          status: "blocked",
          message: "merge-gate-result writeback is bound to a different durable result",
        };
      }
      return owner.writebackOperationKeys.includes(record.idempotencyKey)
        ? { status: "ready" }
        : {
            status: "retry",
            message: "merge-gate-result writeback is waiting for operation registration",
          };
    }

    const collection =
      binding.kind === "completion_report"
        ? lifecycle.completionReports
        : binding.kind === "completion_report_rejection"
          ? lifecycle.completionReportRejections
          : binding.kind === "issue_triage_report"
            ? lifecycle.issueTriageReports
          : binding.kind === "issue_post_mortem_report"
            ? lifecycle.postMortemReports
            : binding.kind === "review_verdict"
              ? lifecycle.reviewVerdicts
              : lifecycle.mergeConflictResolutionReports;
    const owner = collection.find((candidate) => candidate.id === binding.recordId);
    if (owner === undefined) {
      return {
        status: "retry",
        message: `${binding.kind.replaceAll("_", "-")} writeback is waiting for its durable report`,
      };
    }
    if ("supersededAt" in owner && isSupersededLifecycleRecord(owner)) {
      return {
        status: "blocked",
        message: `${binding.kind.replaceAll("_", "-")} writeback owner has been superseded`,
      };
    }
    if (
      binding.kind === "review_verdict" &&
      lifecycle.lastReviewVerdictId !== owner.id
    ) {
      return {
        status: "blocked",
        message: "review-verdict writeback is no longer bound to the current verdict",
      };
    }
    return owner.writebackOperationKeys.includes(record.idempotencyKey)
      ? { status: "ready" }
      : {
          status: "retry",
          message: `${binding.kind.replaceAll("_", "-")} writeback is waiting for operation registration`,
        };
  }

  private async execute(record: WritebackOperation) {
    if (this.dryRun) {
      return dryRunResult(record);
    }
    if (record.kind === "transition") {
      if (acceptedArtifactBindingForOperation(record).status === "bound") {
        const freshGuard = await this.verifyLifecycleBoundOperation(record);
        if (freshGuard.status === "blocked") {
          return { status: "skipped" as const, message: freshGuard.message };
        }
        if (freshGuard.status === "retry") {
          throw new Error(freshGuard.message);
        }
      }
      return this.writer.transitionIssueState({
        issueId: record.issueId,
        toState: record.payload.toState,
        ...(record.payload.fromStates === undefined ? {} : { fromStates: record.payload.fromStates }),
        ...(record.payload.reason === undefined ? {} : { reason: record.payload.reason }),
      });
    }
    if (record.kind === "comment") {
      return this.writer.createIssueComment({
        issueId: record.issueId,
        body: record.payload.body,
        dedupeKey: record.payload.dedupeKey,
      });
    }
    if (record.kind === "issue_relation") {
      if (!this.writer.createIssueRelation) {
        throw new Error("Tracker writer does not support issue_relation writeback operations");
      }
      return this.writer.createIssueRelation({
        sourceIssueId: record.payload.sourceIssueId,
        targetIssueId: record.payload.targetIssueId,
        type: record.payload.type,
        dedupeKey: record.payload.dedupeKey,
        planId: record.payload.planId,
        dependency: record.payload.dependency,
      });
    }
    if (!this.writer.createIssueFromPlan) {
      throw new Error("Tracker writer does not support issue_create writeback operations");
    }
    return this.writer.createIssueFromPlan({
      parentIssueId: record.payload.parentIssueId,
      planId: record.payload.planId,
      proposedIssueIndex: record.payload.proposedIssueIndex,
      title: record.payload.title,
      description: record.payload.description,
      acceptanceCriteria: record.payload.acceptanceCriteria,
      requestedLabels: record.payload.requestedLabels,
      dependencies: record.payload.dependencies,
      dedupeKey: record.payload.dedupeKey,
      payloadHash: record.payload.payloadHash,
    });
  }
}

export function acceptedArtifactIdForOperation(record: WritebackOperation): string | null {
  const binding = acceptedArtifactBindingForOperation(record);
  return binding.status === "bound" ? binding.artifactId : null;
}

type AcceptedArtifactBinding =
  | { status: "none" }
  | { status: "bound"; artifactId: string }
  | { status: "blocked"; message: string };

function acceptedArtifactBindingForOperation(record: WritebackOperation): AcceptedArtifactBinding {
  if (record.kind !== "comment" && record.kind !== "transition") return { status: "none" };
  if (!("acceptedArtifactId" in record.payload)) return { status: "none" };
  const artifactId = record.payload.acceptedArtifactId?.trim() ?? "";
  return artifactId.length > 0
    ? { status: "bound", artifactId }
    : { status: "blocked", message: "accepted-artifact writeback has an invalid lifecycle binding" };
}

function dryRunResult(record: WritebackOperation): TrackerWriteResult {
  if (record.kind !== "issue_create") return { status: "dry_run", message: "Writeback dry_run" };
  return {
    status: "dry_run",
    message: "Writeback dry_run",
    evidence: {
      kind: "issue_create",
      issue: null,
      issueCreateStatus: "dry_run",
      parentIssueId: record.payload.parentIssueId,
      dedupeKey: record.payload.dedupeKey,
      payloadHash: record.payload.payloadHash,
      unresolvedLabelNames: record.payload.requestedLabels,
      message: "Writeback dry_run",
    },
  };
}

function isPullRequestHandoffOperation(record: WritebackOperation): boolean {
  if (record.idempotencyKey.includes(":pull-request-handoff:")) return true;
  return record.kind === "comment" && record.payload.dedupeKey.startsWith("pull-request-handoff:");
}

function compatibleExistingWriteback(
  existing: WritebackOperation,
  operation: NewWritebackOperation,
): WritebackOperation {
  const sameCoreIntent =
    existing.idempotencyKey === operation.idempotencyKey &&
    existing.kind === operation.kind &&
    existing.issueId === operation.issueId &&
    (existing.runId ?? null) === (operation.runId ?? null) &&
    isDeepStrictEqual(existing.payload, operation.payload);
  if (!sameCoreIntent) {
    throw new SymphonyError(
      "conflict",
      "Writeback idempotency key was reused with different intent",
      {
        idempotencyKey: operation.idempotencyKey,
        existingKind: existing.kind,
        incomingKind: operation.kind,
        existingIssueId: existing.issueId,
        incomingIssueId: operation.issueId,
      },
    );
  }
  const existingBinding = existing.lifecycleBinding;
  const incomingBinding = operation.lifecycleBinding;
  if (existingBinding === undefined && incomingBinding !== undefined) {
    return { ...existing, lifecycleBinding: incomingBinding };
  }
  if (
    existingBinding !== undefined &&
    incomingBinding !== undefined &&
    !isDeepStrictEqual(existingBinding, incomingBinding)
  ) {
    throw new SymphonyError(
      "conflict",
      "Writeback idempotency key was reused with a different lifecycle binding",
      { idempotencyKey: operation.idempotencyKey },
    );
  }
  return existing;
}

export function issueBreakdownPlanIdForOperation(record: WritebackOperation): string | null {
  const binding = issueBreakdownPlanBindingForOperation(record);
  return binding.status === "bound" ? binding.planId : null;
}

type IssueBreakdownPlanBinding =
  | { status: "none" }
  | { status: "bound"; planId: string }
  | { status: "blocked"; message: string };

function issueBreakdownPlanBindingForOperation(record: WritebackOperation): IssueBreakdownPlanBinding {
  if (record.kind === "transition") {
    const planId = record.payload.issueBreakdownPlanId?.trim();
    return planId ? { status: "bound", planId } : { status: "none" };
  }
  if (record.kind === "issue_create") return { status: "bound", planId: record.payload.planId };
  if (record.kind === "issue_relation") return { status: "bound", planId: record.payload.planId };
  if (record.kind === "comment") return issueBreakdownPlanBindingForComment(record);
  return { status: "none" };
}

function issueBreakdownPlanBindingForComment(record: Extract<WritebackOperation, { kind: "comment" }>): IssueBreakdownPlanBinding {
  const explicit = record.payload.issueBreakdownPlanId?.trim();
  if (explicit) return { status: "bound", planId: explicit };

  const dedupePlanId = parseIssueBreakdownChildrenDedupeKey(record.payload.dedupeKey);
  const idempotencyPlanId = parseIssueBreakdownChildrenIdempotencyKey(record.idempotencyKey);
  if (dedupePlanId && idempotencyPlanId && dedupePlanId !== idempotencyPlanId) {
    return { status: "blocked", message: "issue breakdown comment plan binding is ambiguous" };
  }
  const planId = dedupePlanId ?? idempotencyPlanId;
  return planId ? { status: "bound", planId } : { status: "none" };
}

function isIssueBreakdownDispositionComment(record: WritebackOperation): boolean {
  if (record.kind !== "comment") return false;
  const planId = record.payload.issueBreakdownPlanId?.trim();
  if (!planId) return false;
  return (
    record.payload.dedupeKey === `issue-breakdown-disposition:${planId}` &&
    record.idempotencyKey.endsWith(`:issue-breakdown:${planId}:disposition`)
  );
}

function parseIssueBreakdownChildrenDedupeKey(dedupeKey: string): string | null {
  return dedupeKey.match(/^issue-breakdown-children:(.+)$/)?.[1] ?? null;
}

function parseIssueBreakdownChildrenIdempotencyKey(idempotencyKey: string): string | null {
  return idempotencyKey.match(/^comment:[^:]+:issue-breakdown:([^:]+):children$/)?.[1] ?? null;
}

export function computeWritebackBackoffMs(attempt: number, maxBackoffMs: number): number {
  return Math.min(1_000 * 2 ** Math.max(attempt - 1, 0), maxBackoffMs);
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_") || "record";
}

function shortRecordFileName(idempotencyKey: string): string {
  const [rawKind, rawIssueId] = idempotencyKey.split(":");
  const kind = truncateFileSegment(safeFileName(rawKind ?? "record"), 16);
  const issueId = truncateFileSegment(safeFileName(rawIssueId ?? "unknown"), 48);
  const digest = createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 20);
  return `wb_${kind}_${issueId}_${digest}.json`;
}

function truncateFileSegment(value: string, maxLength: number): string {
  const trimmed = value.slice(0, maxLength);
  return trimmed.length > 0 ? trimmed : "record";
}

function dedupeWritebackRecords(records: WritebackOperation[]): WritebackOperation[] {
  const byKey = new Map<string, WritebackOperation>();
  for (const record of records) {
    const existing = byKey.get(record.idempotencyKey);
    if (!existing || Date.parse(record.updatedAt) >= Date.parse(existing.updatedAt)) {
      byKey.set(record.idempotencyKey, record);
    }
  }
  return Array.from(byKey.values());
}

function matchesNewWritebackOperation(record: WritebackOperation, operation: NewWritebackOperation): boolean {
  if (record.idempotencyKey !== operation.idempotencyKey || record.kind !== operation.kind || record.issueId !== operation.issueId) {
    return false;
  }
  if (record.runId !== operation.runId) return false;
  if (record.kind === "transition" && operation.kind === "transition") {
    return (
      record.payload.toState === operation.payload.toState &&
      record.payload.reason === operation.payload.reason &&
      record.payload.issueBreakdownPlanId === operation.payload.issueBreakdownPlanId &&
      record.payload.acceptedArtifactId === operation.payload.acceptedArtifactId &&
      stringArraysEqual(record.payload.fromStates, operation.payload.fromStates)
    );
  }
  if (record.kind === "comment" && operation.kind === "comment") {
    return (
      record.payload.body === operation.payload.body &&
      record.payload.dedupeKey === operation.payload.dedupeKey &&
      record.payload.issueBreakdownPlanId === operation.payload.issueBreakdownPlanId &&
      record.payload.acceptedArtifactId === operation.payload.acceptedArtifactId
    );
  }
  if (record.kind === "issue_create" && operation.kind === "issue_create") {
    return JSON.stringify(record.payload) === JSON.stringify(operation.payload);
  }
  if (record.kind === "issue_relation" && operation.kind === "issue_relation") {
    return JSON.stringify(record.payload) === JSON.stringify(operation.payload);
  }
  return false;
}

function stringArraysEqual(left: string[] | undefined, right: string[] | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function canRetrySkipped(
  record: WritebackOperation,
  operation: NewWritebackOperation,
  options: EnqueueWritebackOptions,
): boolean {
  if (options.retrySkipped !== true || record.status !== "skipped" || !matchesNewWritebackOperation(record, operation)) {
    return false;
  }
  if (options.retrySkippedMessages === undefined) return true;
  return options.retrySkippedMessages.some((message) => record.lastError === message || record.resultMessage === message);
}

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (isAbsentPathError(error)) return null;
    throw error;
  }
}

async function rmIfExists(filePath: string): Promise<void> {
  try {
    await fs.rm(filePath, { force: true });
  } catch (error) {
    if (isAbsentPathError(error)) return;
    throw error;
  }
}

function isAbsentPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENAMETOOLONG";
}

import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import sqlite3 from "sqlite3";
import type { Logger } from "../logging/StructuredLogger.js";
import type { ServiceConfig } from "../config/Config.js";
import {
  normalizeProjectContextResolution,
  type ProjectContextResolution,
} from "../config/ProjectContexts.js";
import { latestFreshIssueBreakdownPlan } from "../IssueBreakdownPlanService.js";
import { mapWithFileReadConcurrency } from "../persistence/FileReadConcurrency.js";
import type { IssueLifecycleStore } from "../persistence/IssueLifecycleStore.js";
import { ProjectionRevisionNotifier, type ProjectionChangeListener, type ProjectionChangeUnsubscribe } from "../persistence/ProjectionRevision.js";
import type { TrackerWriteEvidence, TrackerWriteResult, TrackerWriter } from "../tracker/TrackerWriter.js";
import type { Issue } from "../types.js";
import { errorMessage } from "../errors.js";

export type WritebackStatus = "pending" | "in_flight" | "succeeded" | "skipped" | "retrying" | "dead_letter";

export type WritebackOperation =
  | {
      idempotencyKey: string;
      kind: "transition";
      issueId: string;
      projectContext?: ProjectContextResolution | undefined;
      runId?: string;
      status: WritebackStatus;
      attempt: number;
      createdAt: string;
      updatedAt: string;
      nextAttemptAt: string;
      lastError: string | null;
      resultStatus: TrackerWriteResult["status"] | null;
      resultMessage: string | null;
      resultEvidence: TrackerWriteEvidence | null;
      payload: { toState: string; fromStates?: string[]; reason?: string };
    }
  | {
      idempotencyKey: string;
      kind: "comment";
      issueId: string;
      projectContext?: ProjectContextResolution | undefined;
      runId?: string;
      status: WritebackStatus;
      attempt: number;
      createdAt: string;
      updatedAt: string;
      nextAttemptAt: string;
      lastError: string | null;
      resultStatus: TrackerWriteResult["status"] | null;
      resultMessage: string | null;
      resultEvidence: TrackerWriteEvidence | null;
      payload: { body: string; dedupeKey: string; issueBreakdownPlanId?: string };
    }
  | {
      idempotencyKey: string;
      kind: "issue_create";
      issueId: string;
      projectContext?: ProjectContextResolution | undefined;
      runId?: string;
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
      projectContext?: ProjectContextResolution | undefined;
      runId?: string;
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

export const ISSUE_BREAKDOWN_PLAN_STALE_REASON = "issue breakdown plan is no longer fresh";
export const ISSUE_BREAKDOWN_WRITEBACK_NOT_CURRENT_REASON = "issue breakdown writeback is not bound to the current plan";

export type IssueBreakdownIssueLookupResult =
  | { status: "ok"; issue: Issue }
  | { status: "not_found" }
  | { status: "transient_error"; message: string };

export type IssueBreakdownFreshnessGuard = {
  getConfig: (projectContext?: ProjectContextResolution) => ServiceConfig;
  resolveIssue: (issueId: string, projectContext?: ProjectContextResolution) => Promise<IssueBreakdownIssueLookupResult>;
};

export type ProcessDueOptions = {
  idempotencyKeys?: readonly string[];
  projectContext?: ProjectContextResolution | undefined;
};

export type EnqueueWritebackOptions = {
  retrySkipped?: boolean;
  retrySkippedMessages?: readonly string[];
};

export interface WritebackOutboxStore {
  close?(): Promise<void>;
  enqueueOnce(operation: NewWritebackOperation): Promise<WritebackOperation>;
  claimDue(now?: Date, options?: { idempotencyKeys?: readonly string[]; projectContext?: ProjectContextResolution | undefined }): Promise<WritebackOperation[]>;
  markSucceeded(record: WritebackOperation, result?: TrackerWriteResult): Promise<WritebackOperation>;
  markSkipped(record: WritebackOperation, message: string, result?: TrackerWriteResult): Promise<WritebackOperation>;
  requeueSkipped(record: WritebackOperation): Promise<WritebackOperation>;
  markRetry(record: WritebackOperation, error: string, nextAttemptAt: string): Promise<WritebackOperation>;
  markDeadLetter(record: WritebackOperation, error: string): Promise<WritebackOperation>;
  get(idempotencyKey: string, projectContext?: ProjectContextResolution): Promise<WritebackOperation | null>;
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
    let existing = await this.readPreferredStoredRecord(operation.idempotencyKey, operation.projectContext);
    if (!existing && !isDefaultProjectContext(operation.projectContext)) {
      const legacyExisting = await this.readPreferredStoredRecord(
        operation.idempotencyKey,
        normalizeProjectContextResolution(undefined),
      );
      if (legacyExisting && needsProjectContextBackfill(legacyExisting.rawRecord)) {
        await this.repairProjectContextIfMissing(legacyExisting.record, undefined, legacyExisting.rawRecord);
        existing = await this.readPreferredStoredRecord(operation.idempotencyKey, operation.projectContext);
      }
    }
    if (existing) {
      const replay = await this.backfillProjectContextOnReplay(existing.record, operation, existing.rawRecord);
      if (replay) return replay;
    }
    const now = new Date().toISOString();
    const record = normalizeWritebackOperation({
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
    } as WritebackOperation);
    await this.write(record);
    this.notifyProjectionChanged();
    return record;
  }

  async claimDue(
    now = new Date(),
    options: { idempotencyKeys?: readonly string[]; projectContext?: ProjectContextResolution | undefined } = {},
  ): Promise<WritebackOperation[]> {
    const records = await this.list();
    const allowed = options.idempotencyKeys === undefined ? null : new Set(options.idempotencyKeys);
    const expectedProjectContext = options.projectContext;
    const due = records
      .filter((record) => ["pending", "retrying"].includes(record.status))
      .filter((record) => Date.parse(record.nextAttemptAt) <= now.getTime())
      .filter((record) => allowed === null || allowed.has(record.idempotencyKey))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const claimed: WritebackOperation[] = [];
    for (const record of due) {
      const identityKey = writebackIdentityKey(record.idempotencyKey, record.projectContext);
      if (this.claimLocks.has(identityKey)) continue;
      this.claimLocks.add(identityKey);
      try {
        let current = await this.get(record.idempotencyKey, record.projectContext);
        if (!current) continue;
        if (!["pending", "retrying"].includes(current.status)) continue;
        if (Date.parse(current.nextAttemptAt) > now.getTime()) continue;
        if (allowed !== null && !allowed.has(current.idempotencyKey)) continue;
        current = await this.repairProjectContextIfMissing(current);
        if (!matchesProjectContextScope(current.projectContext, expectedProjectContext)) continue;
        current.status = "in_flight";
        current.updatedAt = new Date().toISOString();
        await this.write(current);
        this.notifyProjectionChanged();
        claimed.push(current);
      } finally {
        this.claimLocks.delete(identityKey);
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

  async get(idempotencyKey: string, projectContext?: ProjectContextResolution): Promise<WritebackOperation | null> {
    const stored = await this.readPreferredStoredRecord(idempotencyKey, projectContext);
    if (stored === null) return null;
    return this.repairProjectContextIfMissing(stored.record, projectContext, stored.rawRecord);
  }

  async list(): Promise<WritebackOperation[]> {
    await fs.mkdir(this.recordsDir(), { recursive: true });
    const entries = await fs.readdir(this.recordsDir());
    const records = await mapWithFileReadConcurrency(
      entries.filter((entry) => entry.endsWith(".json")).map((entry) => path.join(this.recordsDir(), entry)),
      async (filePath): Promise<StoredWritebackRecord | null> => {
        const rawRecord = await readJsonIfExists<Record<string, unknown>>(filePath);
        if (rawRecord === null) return null;
        return this.toStoredWritebackRecord(filePath, rawRecord);
      },
    );
    return Promise.all(
      dedupeStoredWritebackRecords(records.filter((record): record is StoredWritebackRecord => record !== null)).map(
        ({ record, rawRecord }) => this.repairProjectContextIfMissing(record, undefined, rawRecord),
      ),
    );
  }

  private async readStoredRecord(
    idempotencyKey: string,
    projectContext?: ProjectContextResolution,
  ): Promise<Record<string, unknown> | null> {
    return (await this.readPreferredStoredRecord(idempotencyKey, projectContext))?.rawRecord ?? null;
  }

  private async readPreferredStoredRecord(
    idempotencyKey: string,
    projectContext?: ProjectContextResolution,
  ): Promise<StoredWritebackRecord | null> {
    const directRecords = await mapWithFileReadConcurrency(
      this.recordCandidatePaths(idempotencyKey, projectContext),
      async (filePath): Promise<StoredWritebackRecord | null> => {
        const rawRecord = await readJsonIfExists<Record<string, unknown>>(filePath);
        if (rawRecord === null || !matchesReplayLookupScope(rawRecord, projectContext)) return null;
        return this.toStoredWritebackRecord(filePath, rawRecord);
      },
    );
    const directMatches = dedupeStoredWritebackRecords(
      directRecords.filter((record): record is StoredWritebackRecord => record !== null),
    );
    if (projectContext !== undefined && directMatches.length > 0) return directMatches[0] ?? null;

    const entries = await fs.readdir(this.recordsDir()).catch(() => [] as string[]);
    const scannedRecords = await mapWithFileReadConcurrency(
      entries.filter((entry) => entry.endsWith(".json")).map((entry) => path.join(this.recordsDir(), entry)),
      async (filePath): Promise<StoredWritebackRecord | null> => {
        const rawRecord = await readJsonIfExists<Record<string, unknown>>(filePath);
        if (rawRecord === null || rawRecord.idempotencyKey !== idempotencyKey) return null;
        return this.toStoredWritebackRecord(filePath, rawRecord);
      },
    );
    const matches = dedupeStoredWritebackRecords(
      scannedRecords.filter((record): record is StoredWritebackRecord => record !== null),
    );
    if (projectContext === undefined) {
      return matches.length === 1 ? (matches[0] ?? null) : null;
    }
    const scopedMatches = matches.filter(({ rawRecord }) => matchesReplayLookupScope(rawRecord, projectContext));
    return scopedMatches.length === 1 ? (scopedMatches[0] ?? null) : null;
  }

  private async toStoredWritebackRecord(
    filePath: string,
    rawRecord: Record<string, unknown>,
  ): Promise<StoredWritebackRecord> {
    const record = normalizeWritebackOperation(rawRecord as WritebackOperation);
    const dedupeProjectContext = needsProjectContextBackfill(rawRecord)
      ? normalizeProjectContextResolution(undefined)
      : normalizeProjectContextResolution(record.projectContext);
    return {
      filePath,
      rawRecord,
      record,
      dedupeProjectContext,
    };
  }

  private async backfillProjectContextOnReplay(
    existing: WritebackOperation,
    operation: NewWritebackOperation,
    rawRecord: Record<string, unknown> | null | undefined = undefined,
  ): Promise<WritebackOperation | null> {
    const raw = rawRecord ?? (await this.readStoredRecord(existing.idempotencyKey, operation.projectContext ?? existing.projectContext));
    const repaired = await this.repairProjectContextIfMissing(existing, undefined, raw);
    if (needsProjectContextBackfill(raw) && !matchesNewWritebackOperationIgnoringProjectContext(repaired, operation)) {
      return null;
    }
    return matchesProjectContextScope(repaired.projectContext, operation.projectContext) ? repaired : null;
  }

  private async repairProjectContextIfMissing(
    record: WritebackOperation,
    projectContext: ProjectContextResolution | undefined = undefined,
    rawRecord: Record<string, unknown> | null | undefined = undefined,
  ): Promise<WritebackOperation> {
    const raw = rawRecord ?? (await this.readStoredRecord(record.idempotencyKey, projectContext ?? record.projectContext));
    if (!needsProjectContextBackfill(raw)) return record;
    const resolvedProjectContext = normalizeProjectContextResolution(undefined);
    let repaired = record;
    await this.withWriteLock(writebackIdentityKey(record.idempotencyKey, resolvedProjectContext), async () => {
      const latest = await this.readPreferredStoredRecord(record.idempotencyKey, resolvedProjectContext);
      const currentRecord = latest?.record ?? record;
      const currentRaw = latest?.rawRecord ?? raw ?? null;
      if (!needsProjectContextBackfill(currentRaw)) {
        repaired = currentRecord;
        return;
      }
      repaired = normalizeWritebackOperation({
        ...currentRecord,
        projectContext: resolvedProjectContext,
      } as WritebackOperation);
      await this.writeUnlocked(repaired);
      const repairedPath = this.recordPath(repaired.idempotencyKey, repaired.projectContext);
      if (latest?.filePath && latest.filePath !== repairedPath) {
        await fs.unlink(latest.filePath).catch(() => undefined);
      }
    });
    return repaired;
  }

  private async update(record: WritebackOperation, patch: Partial<WritebackOperation>): Promise<WritebackOperation> {
    const current = await this.repairProjectContextIfMissing(record, patch.projectContext);
    const updated = normalizeWritebackOperation({ ...current, ...patch, updatedAt: new Date().toISOString() } as WritebackOperation);
    await this.write(updated);
    this.notifyProjectionChanged();
    return updated;
  }

  private notifyProjectionChanged(): void {
    this.projectionNotifier.notify("writeback");
  }

  private async withWriteLock(identityKey: string, action: () => Promise<void>): Promise<void> {
    const previous = this.writeLocks.get(identityKey) ?? Promise.resolve();
    let current!: Promise<void>;
    current = (async () => {
      await previous.catch(() => undefined);
      try {
        await action();
      } finally {
        if (this.writeLocks.get(identityKey) === current) {
          this.writeLocks.delete(identityKey);
        }
      }
    })();
    this.writeLocks.set(identityKey, current);
    await current;
  }

  private async write(record: WritebackOperation): Promise<void> {
    await this.withWriteLock(writebackIdentityKey(record.idempotencyKey, record.projectContext), () => this.writeUnlocked(record));
  }

  private async writeUnlocked(record: WritebackOperation): Promise<void> {
    await fs.mkdir(this.recordsDir(), { recursive: true });
    const target = this.recordPath(record.idempotencyKey, record.projectContext);
    const temp = path.join(this.recordsDir(), `${path.basename(target)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
    await fs.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    if (process.platform === "win32") {
      await fs.rm(target, { force: true });
    }
    await fs.rename(temp, target);
    for (const legacy of [this.previousShortRecordPath(record.idempotencyKey), this.legacyRecordPath(record.idempotencyKey)]) {
      if (legacy !== target) await rmIfExists(legacy);
    }
  }

  private recordsDir(): string {
    return path.join(this.stateDir, "writeback");
  }

  private recordPath(idempotencyKey: string, projectContext?: ProjectContextResolution): string {
    return path.join(this.recordsDir(), shortRecordFileName(idempotencyKey, projectContext));
  }

  private recordCandidatePaths(idempotencyKey: string, projectContext?: ProjectContextResolution): string[] {
    return Array.from(
      new Set([
        this.recordPath(idempotencyKey, projectContext),
        this.previousShortRecordPath(idempotencyKey),
        this.legacyRecordPath(idempotencyKey),
      ]),
    );
  }

  private previousShortRecordPath(idempotencyKey: string): string {
    return path.join(this.recordsDir(), legacyShortRecordFileName(idempotencyKey));
  }

  private legacyRecordPath(idempotencyKey: string): string {
    return path.join(this.recordsDir(), `${safeFileName(idempotencyKey)}.json`);
  }
}

type SqliteDatabase = InstanceType<typeof sqlite3.Database>;

interface WritebackOperationRow {
  identity_key: string;
  idempotency_key: string;
  project_context_id: string;
  project_context_json: string;
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
  payload_json: string;
}

type LegacyWritebackOperationRow = Omit<WritebackOperationRow, "identity_key" | "project_context_id" | "project_context_json"> &
  Partial<Pick<WritebackOperationRow, "identity_key" | "project_context_id" | "project_context_json">>;

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
      const existing = await this.getUnlocked(database, operation.idempotencyKey, operation.projectContext);
      if (existing) return existing;
      const now = new Date().toISOString();
      const next = normalizeWritebackOperation({
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
      } as WritebackOperation);
      await this.upsertRecordUnlocked(database, next);
      changed = true;
      return next;
    });
    if (changed) this.notifyProjectionChanged();
    return record;
  }

  async claimDue(
    now = new Date(),
    options: { idempotencyKeys?: readonly string[]; projectContext?: ProjectContextResolution | undefined } = {},
  ): Promise<WritebackOperation[]> {
    const idempotencyKeys = options.idempotencyKeys === undefined ? null : Array.from(new Set(options.idempotencyKeys));
    if (idempotencyKeys !== null && idempotencyKeys.length === 0) return [];
    let changed = false;
    const claimed = await this.withWrite(async (database) => {
      const projectContextId =
        options.projectContext === undefined ? null : normalizeProjectContextResolution(options.projectContext).projectContextId;
      const allowedClause = idempotencyKeys === null ? "" : ` AND idempotency_key IN (${idempotencyKeys.map(() => "?").join(", ")})`;
      const projectContextClause = projectContextId === null ? "" : " AND project_context_id = ?";
      const rows = await this.allRows<WritebackOperationRow>(
        database,
        `
          SELECT *
          FROM writeback_operations
          WHERE status IN ('pending', 'retrying')
            AND next_attempt_at <= ?
            ${allowedClause}
            ${projectContextClause}
          ORDER BY created_at, idempotency_key
        `,
        [now.toISOString(), ...(idempotencyKeys ?? []), ...(projectContextId === null ? [] : [projectContextId])],
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
            WHERE identity_key = ?
              AND status IN ('pending', 'retrying')
              AND next_attempt_at <= ?
          `,
          [updatedAt, row.identity_key, now.toISOString()],
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

  async get(idempotencyKey: string, projectContext?: ProjectContextResolution): Promise<WritebackOperation | null> {
    return this.withStore((database) => this.getUnlocked(database, idempotencyKey, projectContext));
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
            identity_key TEXT PRIMARY KEY,
            idempotency_key TEXT NOT NULL,
            project_context_id TEXT NOT NULL,
            project_context_json TEXT NOT NULL,
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
            payload_json TEXT NOT NULL
          );
        `,
      );
      await this.migrateLegacySqliteSchema(database);
      await this.exec(
        database,
        `

          CREATE INDEX IF NOT EXISTS writeback_operations_due_idx
            ON writeback_operations(status, next_attempt_at, created_at);

          CREATE INDEX IF NOT EXISTS writeback_operations_idempotency_idx
            ON writeback_operations(idempotency_key);

          CREATE INDEX IF NOT EXISTS writeback_operations_project_context_idx
            ON writeback_operations(project_context_id);

          CREATE INDEX IF NOT EXISTS writeback_operations_issue_idx
            ON writeback_operations(issue_id);

          CREATE INDEX IF NOT EXISTS writeback_operations_run_idx
            ON writeback_operations(run_id);
        `,
      );
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

  private async migrateLegacySqliteSchema(database: SqliteDatabase): Promise<void> {
    const columns = await this.allRows<{ name: string }>(database, "PRAGMA table_info(writeback_operations)");
    const columnNames = new Set(columns.map((column) => column.name));
    if (columnNames.has("identity_key") && columnNames.has("project_context_id") && columnNames.has("project_context_json")) {
      return;
    }

    const legacyRows = await this.allRows<LegacyWritebackOperationRow>(
      database,
      "SELECT * FROM writeback_operations ORDER BY created_at, idempotency_key",
    );
    await this.exec(database, "DROP TABLE IF EXISTS writeback_operations_legacy_migration");
    await this.exec(database, "ALTER TABLE writeback_operations RENAME TO writeback_operations_legacy_migration");
    await this.exec(
      database,
      `
        CREATE TABLE writeback_operations (
          identity_key TEXT PRIMARY KEY,
          idempotency_key TEXT NOT NULL,
          project_context_id TEXT NOT NULL,
          project_context_json TEXT NOT NULL,
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
          payload_json TEXT NOT NULL
        )
      `,
    );
    for (const row of legacyRows) {
      await this.upsertRecordUnlocked(database, this.recordFromRow(row));
    }
    await this.exec(database, "DROP TABLE IF EXISTS writeback_operations_legacy_migration");
  }

  private async importLegacyRecords(database: SqliteDatabase): Promise<void> {
    const legacyStore = new FileWritebackOutboxStore(this.stateDir);
    const records = await legacyStore.list();
    if (records.length === 0) return;

    await this.exec(database, "BEGIN IMMEDIATE");
    try {
      for (const record of records) {
        const existing = await this.getUnlocked(database, record.idempotencyKey, record.projectContext);
        if (existing && Date.parse(existing.updatedAt) > Date.parse(record.updatedAt)) continue;
        await this.upsertRecordUnlocked(database, record);
      }
      await this.exec(database, "COMMIT");
    } catch (error) {
      await this.exec(database, "ROLLBACK").catch(() => undefined);
      throw error;
    }
  }

  private async getUnlocked(
    database: SqliteDatabase,
    idempotencyKey: string,
    projectContext?: ProjectContextResolution,
  ): Promise<WritebackOperation | null> {
    if (projectContext !== undefined) {
      const row = await this.getRow<WritebackOperationRow>(
        database,
        "SELECT * FROM writeback_operations WHERE identity_key = ?",
        [writebackIdentityKey(idempotencyKey, projectContext)],
      );
      return row ? this.recordFromRow(row) : null;
    }
    const rows = await this.allRows<WritebackOperationRow>(
      database,
      "SELECT * FROM writeback_operations WHERE idempotency_key = ? ORDER BY created_at, identity_key",
      [idempotencyKey],
    );
    const records = rows.map((row) => this.recordFromRow(row));
    const deduped = dedupeWritebackRecords(records);
    if (deduped.length === 1) return deduped[0] ?? null;
    const defaultMatches = deduped.filter((record) => isDefaultProjectContext(record.projectContext));
    const nonDefaultMatches = deduped.filter((record) => !isDefaultProjectContext(record.projectContext));
    if (defaultMatches.length === 1 && nonDefaultMatches.length === 0) return defaultMatches[0] ?? null;
    return null;
  }

  private async upsertRecordUnlocked(database: SqliteDatabase, record: WritebackOperation): Promise<void> {
    await this.run(
      database,
      `
        INSERT INTO writeback_operations (
          identity_key,
          idempotency_key,
          project_context_id,
          project_context_json,
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
          payload_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(identity_key) DO UPDATE SET
          idempotency_key = excluded.idempotency_key,
          project_context_id = excluded.project_context_id,
          project_context_json = excluded.project_context_json,
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
          payload_json = excluded.payload_json
      `,
      this.paramsForRecord(record),
    );
  }

  private paramsForRecord(record: WritebackOperation): readonly unknown[] {
    const projectContext = normalizeProjectContextResolution(record.projectContext);
    return [
      writebackIdentityKey(record.idempotencyKey, projectContext),
      record.idempotencyKey,
      projectContext.projectContextId,
      JSON.stringify(projectContext),
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
      JSON.stringify(record.payload),
    ];
  }

  private recordFromRow(row: WritebackOperationRow | LegacyWritebackOperationRow): WritebackOperation {
    const projectContext = normalizeProjectContextResolution(
      row.project_context_json ? (JSON.parse(row.project_context_json) as ProjectContextResolution) : undefined,
    );
    return {
      idempotencyKey: row.idempotency_key,
      projectContext,
      kind: row.kind,
      issueId: row.issue_id,
      ...(row.run_id === null ? {} : { runId: row.run_id }),
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
    private readonly lifecycleStore?: Pick<IssueLifecycleStore, "get">,
    private readonly dryRun = false,
    private readonly issueBreakdownFreshnessGuard?: IssueBreakdownFreshnessGuard,
    private readonly writerResolver?: (projectContext?: ProjectContextResolution) => TrackerWriter,
  ) {}

  async close(): Promise<void> {
    await this.store.close?.();
  }

  async enqueueAndProcess(operation: NewWritebackOperation, options: EnqueueWritebackOptions = {}): Promise<WritebackOperation> {
    let record = await this.store.enqueueOnce(operation);
    if (record.status === "succeeded") return record;
    if (canRetrySkipped(record, operation, options)) {
      record = await this.store.requeueSkipped(record);
    }
    const executionProjectContext = resolveScopedExecutionProjectContext(record.projectContext, operation.projectContext);
    await this.processDue({ idempotencyKeys: [record.idempotencyKey], projectContext: executionProjectContext });
    return (await this.store.get(record.idempotencyKey, record.projectContext)) ?? record;
  }

  async processDue(options: ProcessDueOptions = {}): Promise<void> {
    const claimOptions = {
      ...(options.idempotencyKeys === undefined ? {} : { idempotencyKeys: options.idempotencyKeys }),
      ...(options.projectContext === undefined ? {} : { projectContext: options.projectContext }),
    };
    for (const record of await this.store.claimDue(new Date(), claimOptions)) {
      const executionProjectContext = resolveScopedExecutionProjectContext(record.projectContext, options.projectContext);
      try {
        const guard = await this.verifyLifecycleBoundOperation(record, executionProjectContext);
        if (guard.status === "blocked") {
          await this.store.markSkipped(record, guard.message);
          continue;
        }
        if (guard.status === "retry") {
          const nextAttemptAt = new Date(Date.now() + computeWritebackBackoffMs(record.attempt + 1, this.maxBackoffMs)).toISOString();
          await this.store.markRetry(record, guard.message, nextAttemptAt);
          continue;
        }
        const result = await this.execute(record, executionProjectContext);
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

  private async verifyLifecycleBoundOperation(
    record: WritebackOperation,
    executionProjectContext: ProjectContextResolution | undefined = record.projectContext,
  ): Promise<LifecycleGuardResult> {
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
      if (plan.applicationStatus === "stale") {
        return { status: "blocked", message: ISSUE_BREAKDOWN_PLAN_STALE_REASON };
      }
      if (!hasRegisteredWritebackKey(plan.applicationOperationKeys, record)) {
        return { status: "blocked", message: "issue breakdown writeback is not registered on the current plan" };
      }
      if ((record.kind === "comment" || record.kind === "issue_relation") && plan.createdIssueRefs.length < plan.proposedIssues.length) {
        return { status: "blocked", message: "issue breakdown relation/comment writeback requires durable child refs" };
      }
      if (!this.issueBreakdownFreshnessGuard) {
        return { status: "blocked", message: "issue breakdown writeback requires freshness guard" };
      }
      const config = this.issueBreakdownFreshnessGuard.getConfig(executionProjectContext);
      const lookup = await this.issueBreakdownFreshnessGuard.resolveIssue(record.issueId, executionProjectContext);
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
    const acceptedReport = lifecycle?.completionReports.find((report) => report.id === lifecycle.lastCompletionReportId);
    if (!acceptedReport || !hasRegisteredWritebackKey(acceptedReport.writebackOperationKeys, record) || acceptedReport.pullRequest === null) {
      return {
        status: "blocked",
        message: "pull request handoff requires a durable accepted completion report with matching PR evidence",
      };
    }
    return { status: "ready" };
  }

  private async execute(
    record: WritebackOperation,
    executionProjectContext: ProjectContextResolution | undefined = record.projectContext,
  ) {
    if (this.dryRun) {
      return dryRunResult(record);
    }
    const writer = this.writerResolver?.(executionProjectContext) ?? this.writer;
    if (record.kind === "transition") {
      return writer.transitionIssueState({
        issueId: record.issueId,
        toState: record.payload.toState,
        ...(record.payload.fromStates === undefined ? {} : { fromStates: record.payload.fromStates }),
        ...(record.payload.reason === undefined ? {} : { reason: record.payload.reason }),
      });
    }
    if (record.kind === "comment") {
      return writer.createIssueComment({
        issueId: record.issueId,
        body: record.payload.body,
        dedupeKey: record.payload.dedupeKey,
      });
    }
    if (record.kind === "issue_relation") {
      if (!writer.createIssueRelation) {
        throw new Error("Tracker writer does not support issue_relation writeback operations");
      }
      return writer.createIssueRelation({
        sourceIssueId: record.payload.sourceIssueId,
        targetIssueId: record.payload.targetIssueId,
        type: record.payload.type,
        dedupeKey: record.payload.dedupeKey,
        planId: record.payload.planId,
        dependency: record.payload.dependency,
      });
    }
    if (!writer.createIssueFromPlan) {
      throw new Error("Tracker writer does not support issue_create writeback operations");
    }
    return writer.createIssueFromPlan({
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

export function issueBreakdownPlanIdForOperation(record: WritebackOperation): string | null {
  const binding = issueBreakdownPlanBindingForOperation(record);
  return binding.status === "bound" ? binding.planId : null;
}

type IssueBreakdownPlanBinding =
  | { status: "none" }
  | { status: "bound"; planId: string }
  | { status: "blocked"; message: string };

function issueBreakdownPlanBindingForOperation(record: WritebackOperation): IssueBreakdownPlanBinding {
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

function shortRecordFileName(idempotencyKey: string, projectContext?: ProjectContextResolution): string {
  return buildShortRecordFileName(idempotencyKey, writebackIdentityKey(idempotencyKey, projectContext));
}

function legacyShortRecordFileName(idempotencyKey: string): string {
  return buildShortRecordFileName(idempotencyKey, idempotencyKey);
}

function buildShortRecordFileName(idempotencyKey: string, digestSource: string): string {
  const [rawKind, rawIssueId] = idempotencyKey.split(":");
  const kind = truncateFileSegment(safeFileName(rawKind ?? "record"), 16);
  const issueId = truncateFileSegment(safeFileName(rawIssueId ?? "unknown"), 48);
  const digest = createHash("sha256").update(digestSource).digest("hex").slice(0, 20);
  return `wb_${kind}_${issueId}_${digest}.json`;
}

function truncateFileSegment(value: string, maxLength: number): string {
  const trimmed = value.slice(0, maxLength);
  return trimmed.length > 0 ? trimmed : "record";
}

function normalizeWritebackOperation(record: WritebackOperation): WritebackOperation {
  return {
    ...record,
    projectContext: normalizeProjectContextResolution(record.projectContext),
  };
}

function needsProjectContextBackfill(record: Record<string, unknown> | null): boolean {
  return record !== null && (!Object.prototype.hasOwnProperty.call(record, "projectContext") || record.projectContext === null);
}

function matchesReplayLookupScope(
  record: Record<string, unknown> | null,
  expectedProjectContext: ProjectContextResolution | undefined,
): boolean {
  return needsProjectContextBackfill(record)
    ? isDefaultProjectContext(expectedProjectContext)
    : matchesProjectContextScope(record?.projectContext as ProjectContextResolution | undefined, expectedProjectContext);
}

function isDefaultProjectContext(projectContext: ProjectContextResolution | undefined): boolean {
  return normalizeProjectContextResolution(projectContext).projectContextId === normalizeProjectContextResolution(undefined).projectContextId;
}

function projectContextEquals(
  left: ProjectContextResolution | undefined,
  right: ProjectContextResolution | undefined,
): boolean {
  return normalizeProjectContextResolution(left).projectContextId === normalizeProjectContextResolution(right).projectContextId;
}

function matchesProjectContextScope(
  recordProjectContext: ProjectContextResolution | undefined,
  expectedProjectContext: ProjectContextResolution | undefined,
): boolean {
  if (!expectedProjectContext) return true;
  return (
    normalizeProjectContextResolution(recordProjectContext).projectContextId ===
    normalizeProjectContextResolution(expectedProjectContext).projectContextId
  );
}

function resolveScopedExecutionProjectContext(
  recordProjectContext: ProjectContextResolution | undefined,
  requestedProjectContext: ProjectContextResolution | undefined,
): ProjectContextResolution | undefined {
  if (!requestedProjectContext) return recordProjectContext;
  return matchesProjectContextScope(recordProjectContext, requestedProjectContext)
    ? normalizeProjectContextResolution(requestedProjectContext)
    : recordProjectContext;
}

type StoredWritebackRecord = {
  filePath: string;
  rawRecord: Record<string, unknown>;
  record: WritebackOperation;
  dedupeProjectContext: ProjectContextResolution;
};

function dedupeStoredWritebackRecords(records: StoredWritebackRecord[]): StoredWritebackRecord[] {
  const byKey = new Map<string, StoredWritebackRecord>();
  for (const record of records) {
    const key = writebackIdentityKey(record.record.idempotencyKey, record.dedupeProjectContext);
    const existing = byKey.get(key);
    if (!existing || compareStoredWritebackRecords(record, existing) >= 0) {
      byKey.set(key, record);
    }
  }
  return Array.from(byKey.values());
}

function compareStoredWritebackRecords(left: StoredWritebackRecord, right: StoredWritebackRecord): number {
  const updatedAtDelta = Date.parse(left.record.updatedAt) - Date.parse(right.record.updatedAt);
  if (updatedAtDelta !== 0) return updatedAtDelta;
  const pathRankDelta = storedRecordPathRank(left) - storedRecordPathRank(right);
  if (pathRankDelta !== 0) return pathRankDelta;
  return 0;
}

function storedRecordPathRank(record: StoredWritebackRecord): number {
  const fileName = path.basename(record.filePath);
  if (fileName === shortRecordFileName(record.record.idempotencyKey, record.dedupeProjectContext)) return 2;
  if (fileName === legacyShortRecordFileName(record.record.idempotencyKey)) return 1;
  if (fileName === `${safeFileName(record.record.idempotencyKey)}.json`) return 0;
  return -1;
}

function dedupeWritebackRecords(records: WritebackOperation[]): WritebackOperation[] {
  const byKey = new Map<string, WritebackOperation>();
  for (const record of records) {
    const key = writebackIdentityKey(record.idempotencyKey, record.projectContext);
    const existing = byKey.get(key);
    if (!existing || Date.parse(record.updatedAt) >= Date.parse(existing.updatedAt)) {
      byKey.set(key, record);
    }
  }
  return Array.from(byKey.values());
}

export function writebackIdentityKey(idempotencyKey: string, projectContext?: ProjectContextResolution): string {
  return `${normalizeProjectContextResolution(projectContext).projectContextId}\u0000${idempotencyKey}`;
}

function hasRegisteredWritebackKey(
  registeredKeys: string[],
  record: Pick<WritebackOperation, "idempotencyKey" | "projectContext">,
): boolean {
  const scopedKey = writebackIdentityKey(record.idempotencyKey, record.projectContext);
  return registeredKeys.includes(scopedKey) || registeredKeys.includes(record.idempotencyKey);
}

function matchesNewWritebackOperation(record: WritebackOperation, operation: NewWritebackOperation): boolean {
  if (record.idempotencyKey !== operation.idempotencyKey || record.kind !== operation.kind || record.issueId !== operation.issueId) {
    return false;
  }
  if (!projectContextEquals(record.projectContext, operation.projectContext)) return false;
  if (record.runId !== operation.runId) return false;
  if (record.kind === "transition" && operation.kind === "transition") {
    return (
      record.payload.toState === operation.payload.toState &&
      record.payload.reason === operation.payload.reason &&
      stringArraysEqual(record.payload.fromStates, operation.payload.fromStates)
    );
  }
  if (record.kind === "comment" && operation.kind === "comment") {
    return (
      record.payload.body === operation.payload.body &&
      record.payload.dedupeKey === operation.payload.dedupeKey &&
      record.payload.issueBreakdownPlanId === operation.payload.issueBreakdownPlanId
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

function matchesNewWritebackOperationIgnoringProjectContext(
  record: WritebackOperation,
  operation: NewWritebackOperation,
): boolean {
  if (!record.runId || !operation.runId) return false;
  return matchesNewWritebackOperation(
    {
      ...record,
      projectContext: normalizeProjectContextResolution(operation.projectContext),
    } as WritebackOperation,
    operation,
  );
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

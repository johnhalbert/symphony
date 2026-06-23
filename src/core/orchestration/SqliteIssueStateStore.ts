import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import sqlite3 from "sqlite3";

import type { Issue } from "../types.js";
import { FileIssueStateStore } from "./FileIssueStateStore.js";
import {
  normalizeIssueHistorySnapshotEvidenceFields,
  type IssueCurrentFields,
  type IssueHistorySnapshot,
  type IssueStateRecord,
  type IssueStateStore,
  type TransitionActionRecord,
  type TransitionErrorRecord,
} from "./IssueOrchestrationState.js";

type SqliteDatabase = InstanceType<typeof sqlite3.Database>;

interface IssueStateRow {
  issue_id: string;
  issue_identifier: string;
}

interface IssueCurrentCacheRow {
  // Compatibility cache for pre-history/bootstrap records. Normal reads prefer
  // the latest issue_history snapshot when any history exists.
  current_json: string;
}

interface IssueHistoryRow {
  snapshot_json: string;
}

interface TableInfoRow {
  name: string;
}

export class SqliteIssueStateStore implements IssueStateStore {
  private writeLock: Promise<void> = Promise.resolve();
  private database: SqliteDatabase | null = null;
  private databaseReady: Promise<SqliteDatabase> | null = null;

  constructor(
    private readonly stateDir: string,
    private readonly databaseFileName = "issue-state.sqlite",
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

  async get(issueIdOrIdentifier: string): Promise<IssueStateRecord | null> {
    return this.withStore(async (database) => {
      const row = await this.getRow<IssueStateRow>(
        database,
        `
          SELECT issue_id, issue_identifier
          FROM issue_state
          WHERE issue_id = ? OR issue_identifier = ?
          ORDER BY CASE WHEN issue_id = ? THEN 0 ELSE 1 END
          LIMIT 1
        `,
        [issueIdOrIdentifier, issueIdOrIdentifier, issueIdOrIdentifier],
      );
      return row ? this.recordFromRow(database, row) : null;
    });
  }

  async getHistory(
    issueIdOrIdentifier: string,
  ): Promise<IssueHistorySnapshot[] | null> {
    return this.withStore(async (database) => {
      const row = await this.getRow<IssueStateRow>(
        database,
        `
          SELECT issue_id, issue_identifier
          FROM issue_state
          WHERE issue_id = ? OR issue_identifier = ?
          ORDER BY CASE WHEN issue_id = ? THEN 0 ELSE 1 END
          LIMIT 1
        `,
        [issueIdOrIdentifier, issueIdOrIdentifier, issueIdOrIdentifier],
      );
      return row ? this.historyFromIssueIdUnlocked(database, row.issue_id) : null;
    });
  }

  async list(): Promise<IssueStateRecord[]> {
    return this.withStore(async (database) => {
      const rows = await this.allRows<IssueStateRow>(
        database,
        "SELECT issue_id, issue_identifier FROM issue_state ORDER BY issue_identifier",
      );
      return Promise.all(rows.map((row) => this.recordFromRow(database, row)));
    });
  }

  async ensureIssue(current: IssueCurrentFields): Promise<IssueStateRecord> {
    await this.withWrite(current.issueId, async (database) => {
      const existing = await this.findUnlocked(
        database,
        current.issueId,
        current.issueIdentifier,
      );
      const now = new Date().toISOString();
      const record: IssueCurrentFields = {
        ...current,
        version: 1,
        recordCreatedAt:
          existing?.recordCreatedAt ?? current.recordCreatedAt ?? now,
        recordUpdatedAt: now,
      };
      await this.run(
        database,
        `
          INSERT INTO issue_state (issue_id, issue_identifier, current_json, record_created_at, record_updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(issue_id) DO UPDATE SET
            issue_identifier = excluded.issue_identifier,
            current_json = excluded.current_json,
            record_updated_at = excluded.record_updated_at
        `,
        [
          record.issueId,
          record.issueIdentifier,
          JSON.stringify(record),
          record.recordCreatedAt,
          record.recordUpdatedAt,
        ],
      );
    });
    const record = await this.get(current.issueId);
    if (!record)
      throw new Error(
        `Issue state was not persisted for ${current.issueIdentifier}`,
      );
    return record;
  }

  async updateCurrent(
    issue: Pick<Issue, "id" | "identifier">,
    patch: Partial<IssueCurrentFields>,
  ): Promise<IssueStateRecord> {
    await this.withWrite(issue.id, async (database) => {
      const existing = await this.findUnlocked(
        database,
        issue.id,
        issue.identifier,
      );
      if (!existing)
        throw new Error(`Issue state does not exist for ${issue.identifier}`);
      const current: IssueCurrentFields = {
        ...existing,
        ...patch,
        issueId: existing.issueId,
        issueIdentifier: existing.issueIdentifier,
        version: 1,
        recordUpdatedAt: new Date().toISOString(),
      };
      delete (current as { history?: unknown }).history;
      await this.run(
        database,
        `
          UPDATE issue_state
          SET current_json = ?, record_updated_at = ?
          WHERE issue_id = ?
        `,
        [JSON.stringify(current), current.recordUpdatedAt, current.issueId],
      );
    });
    const record = await this.get(issue.id);
    if (!record)
      throw new Error(`Issue state does not exist for ${issue.identifier}`);
    return record;
  }

  async appendSnapshot(
    issue: Pick<Issue, "id" | "identifier">,
    snapshot: IssueHistorySnapshot,
  ): Promise<IssueStateRecord> {
    await this.withWrite(issue.id, async (database) => {
      const existing = await this.findUnlocked(
        database,
        issue.id,
        issue.identifier,
      );
      if (!existing)
        throw new Error(`Issue state does not exist for ${issue.identifier}`);
      const row = await this.getRow<{ max_sequence: number }>(
        database,
        "SELECT COALESCE(MAX(sequence), 0) AS max_sequence FROM issue_history WHERE issue_id = ?",
        [existing.issueId],
      );
      const sequence = (row?.max_sequence ?? 0) + 1;
      await this.insertSnapshotUnlocked(
        database,
        existing.issueId,
        existing.issueIdentifier,
        sequence,
        normalizeIssueHistorySnapshot(snapshot),
      );
      await this.touchIssue(database, existing.issueId);
    });
    const record = await this.get(issue.id);
    if (!record)
      throw new Error(`Issue state does not exist for ${issue.identifier}`);
    return record;
  }

  async updateSnapshotActions(
    issue: Pick<Issue, "id" | "identifier">,
    historySnapshotId: string,
    patch: {
      actions?: readonly TransitionActionRecord[];
      errors?: readonly TransitionErrorRecord[];
    },
  ): Promise<IssueStateRecord | null> {
    await this.withWrite(issue.id, async (database) => {
      const existing = await this.findUnlocked(
        database,
        issue.id,
        issue.identifier,
      );
      if (!existing) return;
      const snapshot = await this.findSnapshotUnlocked(
        database,
        existing.issueId,
        historySnapshotId,
      );
      if (!snapshot) return;
      const next: IssueHistorySnapshot = {
        ...snapshot,
        actions:
          patch.actions === undefined ? snapshot.actions : [...patch.actions],
        errors:
          patch.errors === undefined ? snapshot.errors : [...patch.errors],
      };
      await this.updateSnapshotUnlocked(
        database,
        existing.issueId,
        historySnapshotId,
        next,
      );
    });
    return this.get(issue.id);
  }

  async appendSnapshotAction(
    issue: Pick<Issue, "id" | "identifier">,
    historySnapshotId: string,
    action: TransitionActionRecord,
  ): Promise<IssueStateRecord | null> {
    await this.withWrite(issue.id, async (database) => {
      const existing = await this.findUnlocked(
        database,
        issue.id,
        issue.identifier,
      );
      if (!existing) return;
      const snapshot = await this.findSnapshotUnlocked(
        database,
        existing.issueId,
        historySnapshotId,
      );
      if (!snapshot) return;
      await this.updateSnapshotUnlocked(
        database,
        existing.issueId,
        historySnapshotId,
        {
          ...snapshot,
          actions: [...snapshot.actions, action],
        },
      );
    });
    return this.get(issue.id);
  }

  async appendSnapshotError(
    issue: Pick<Issue, "id" | "identifier">,
    historySnapshotId: string,
    error: TransitionErrorRecord,
  ): Promise<IssueStateRecord | null> {
    await this.withWrite(issue.id, async (database) => {
      const existing = await this.findUnlocked(
        database,
        issue.id,
        issue.identifier,
      );
      if (!existing) return;
      const snapshot = await this.findSnapshotUnlocked(
        database,
        existing.issueId,
        historySnapshotId,
      );
      if (!snapshot) return;
      await this.updateSnapshotUnlocked(
        database,
        existing.issueId,
        historySnapshotId,
        {
          ...snapshot,
          errors: [...snapshot.errors, error],
        },
      );
    });
    return this.get(issue.id);
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

        CREATE TABLE IF NOT EXISTS issue_state (
          issue_id TEXT PRIMARY KEY,
          issue_identifier TEXT NOT NULL UNIQUE,
          current_json TEXT NOT NULL,
          record_created_at TEXT NOT NULL,
          record_updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS issue_state_identifier_idx
          ON issue_state(issue_identifier);

        CREATE TABLE IF NOT EXISTS issue_history (
          history_snapshot_id TEXT PRIMARY KEY,
          issue_id TEXT NOT NULL,
          issue_identifier TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          transition_kind TEXT NOT NULL,
          ruleset_id TEXT NOT NULL,
          ruleset_version TEXT NOT NULL DEFAULT 'legacy',
          ruleset_fingerprint TEXT NOT NULL DEFAULT 'legacy',
          snapshot_at TEXT NOT NULL,
          trigger_type TEXT NOT NULL,
          candidate_source TEXT NOT NULL,
          snapshot_json TEXT NOT NULL,
          FOREIGN KEY(issue_id) REFERENCES issue_state(issue_id) ON DELETE CASCADE
        );

        CREATE UNIQUE INDEX IF NOT EXISTS issue_history_issue_sequence_idx
          ON issue_history(issue_id, sequence);

        CREATE INDEX IF NOT EXISTS issue_history_issue_snapshot_idx
          ON issue_history(issue_id, history_snapshot_id);

        CREATE INDEX IF NOT EXISTS issue_history_transition_kind_idx
          ON issue_history(transition_kind, ruleset_id);
      `,
      );
      await this.ensureHistoryAuditColumns(database);
      await this.migrateLegacyFileIssueState(database);
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
    _key: string,
    operation: (database: SqliteDatabase) => Promise<void> | void,
  ): Promise<void> {
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
  }

  private async findUnlocked(
    database: SqliteDatabase,
    issueId: string,
    issueIdentifier: string,
  ): Promise<IssueStateRecord | null> {
    const row = await this.getRow<IssueStateRow>(
      database,
      `
        SELECT issue_id, issue_identifier
        FROM issue_state
        WHERE issue_id = ? OR issue_identifier = ?
        ORDER BY CASE WHEN issue_id = ? THEN 0 ELSE 1 END
        LIMIT 1
      `,
      [issueId, issueIdentifier, issueId],
    );
    return row ? this.recordFromRow(database, row) : null;
  }

  private async ensureHistoryAuditColumns(
    database: SqliteDatabase,
  ): Promise<void> {
    const columns = new Set(
      (
        await this.allRows<TableInfoRow>(
          database,
          "PRAGMA table_info(issue_history)",
        )
      ).map((row) => row.name),
    );
    if (!columns.has("ruleset_version")) {
      await this.run(
        database,
        "ALTER TABLE issue_history ADD COLUMN ruleset_version TEXT NOT NULL DEFAULT 'legacy'",
      );
    }
    if (!columns.has("ruleset_fingerprint")) {
      await this.run(
        database,
        "ALTER TABLE issue_history ADD COLUMN ruleset_fingerprint TEXT NOT NULL DEFAULT 'legacy'",
      );
    }
  }

  private async migrateLegacyFileIssueState(
    database: SqliteDatabase,
  ): Promise<void> {
    const legacyStore = new FileIssueStateStore(this.stateDir);
    const records = await legacyStore.list();
    if (records.length === 0) return;

    await this.exec(database, "BEGIN IMMEDIATE");
    try {
      for (const record of records) {
        const existing = await this.getRow<IssueStateRow>(
          database,
          "SELECT issue_id, issue_identifier FROM issue_state WHERE issue_id = ?",
          [record.issueId],
        );
        if (existing) continue;
        await this.insertRecordUnlocked(database, record);
      }
      await this.exec(database, "COMMIT");
    } catch (error) {
      await this.exec(database, "ROLLBACK").catch(() => undefined);
      throw error;
    }
  }

  private async insertRecordUnlocked(
    database: SqliteDatabase,
    record: IssueStateRecord,
  ): Promise<void> {
    const { history: _history, ...currentFields } = record;
    const current = normalizeIssueCurrentFields(
      currentFields as IssueCurrentFields,
    );
    await this.run(
      database,
      `
        INSERT INTO issue_state (issue_id, issue_identifier, current_json, record_created_at, record_updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(issue_id) DO UPDATE SET
          issue_identifier = excluded.issue_identifier,
          current_json = excluded.current_json,
          record_updated_at = excluded.record_updated_at
      `,
      [
        current.issueId,
        current.issueIdentifier,
        JSON.stringify(current),
        current.recordCreatedAt,
        current.recordUpdatedAt,
      ],
    );
    let sequence = 1;
    for (const rawSnapshot of record.history) {
      const snapshot = normalizeIssueHistorySnapshot(rawSnapshot);
      await this.insertSnapshotUnlocked(
        database,
        current.issueId,
        current.issueIdentifier,
        sequence,
        snapshot,
      );
      sequence += 1;
    }
  }

  private async findSnapshotUnlocked(
    database: SqliteDatabase,
    issueId: string,
    historySnapshotId: string,
  ): Promise<IssueHistorySnapshot | null> {
    const row = await this.getRow<IssueHistoryRow>(
      database,
      "SELECT snapshot_json FROM issue_history WHERE issue_id = ? AND history_snapshot_id = ?",
      [issueId, historySnapshotId],
    );
    return row
      ? normalizeIssueHistorySnapshot(
          JSON.parse(row.snapshot_json) as IssueHistorySnapshot,
        )
      : null;
  }

  private async updateSnapshotUnlocked(
    database: SqliteDatabase,
    issueId: string,
    historySnapshotId: string,
    snapshot: IssueHistorySnapshot,
  ): Promise<void> {
    await this.run(
      database,
      "UPDATE issue_history SET snapshot_json = ? WHERE issue_id = ? AND history_snapshot_id = ?",
      [JSON.stringify(snapshot), issueId, historySnapshotId],
    );
    await this.touchIssue(database, issueId);
  }

  private async insertSnapshotUnlocked(
    database: SqliteDatabase,
    issueId: string,
    issueIdentifier: string,
    sequence: number,
    snapshot: IssueHistorySnapshot,
  ): Promise<void> {
    await this.run(
      database,
      `
        INSERT INTO issue_history (
          history_snapshot_id,
          issue_id,
          issue_identifier,
          sequence,
          transition_kind,
          ruleset_id,
          ruleset_version,
          ruleset_fingerprint,
          snapshot_at,
          trigger_type,
          candidate_source,
          snapshot_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(history_snapshot_id) DO UPDATE SET
          snapshot_json = excluded.snapshot_json
      `,
      [
        snapshot.historySnapshotId,
        issueId,
        issueIdentifier,
        sequence,
        snapshot.transitionKind,
        snapshot.rulesetId,
        snapshot.rulesetVersion,
        snapshot.rulesetFingerprint,
        snapshot.snapshotAt,
        snapshot.triggerType,
        snapshot.candidateSource,
        JSON.stringify(snapshot),
      ],
    );
  }

  private async touchIssue(
    database: SqliteDatabase,
    issueId: string,
  ): Promise<void> {
    await this.run(
      database,
      "UPDATE issue_state SET record_updated_at = ? WHERE issue_id = ?",
      [new Date().toISOString(), issueId],
    );
  }

  private async recordFromRow(
    database: SqliteDatabase,
    row: IssueStateRow,
  ): Promise<IssueStateRecord> {
    const history = await this.historyFromIssueIdUnlocked(
      database,
      row.issue_id,
    );
    const current =
      currentFieldsFromLatestHistory(history) ??
      (await this.currentFromCacheUnlocked(database, row.issue_id));
    return {
      ...current,
      history,
    };
  }

  private async historyFromIssueIdUnlocked(
    database: SqliteDatabase,
    issueId: string,
  ): Promise<IssueHistorySnapshot[]> {
    const historyRows = await this.allRows<IssueHistoryRow>(
      database,
      "SELECT snapshot_json FROM issue_history WHERE issue_id = ? ORDER BY sequence",
      [issueId],
    );
    return historyRows.map((historyRow) =>
      normalizeIssueHistorySnapshot(
        JSON.parse(historyRow.snapshot_json) as IssueHistorySnapshot,
      ),
    );
  }

  private async currentFromCacheUnlocked(
    database: SqliteDatabase,
    issueId: string,
  ): Promise<IssueCurrentFields> {
    const row = await this.getRow<IssueCurrentCacheRow>(
      database,
      "SELECT current_json FROM issue_state WHERE issue_id = ?",
      [issueId],
    );
    if (!row) throw new Error(`Issue state does not exist for ${issueId}`);
    return normalizeIssueCurrentFields(
      JSON.parse(row.current_json) as IssueCurrentFields,
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

function normalizeIssueCurrentFields(
  record: IssueCurrentFields,
): IssueCurrentFields {
  return {
    ...record,
    version: 1,
    lastPlanningFailureAt:
      typeof record.lastPlanningFailureAt === "string"
        ? record.lastPlanningFailureAt
        : null,
    planningRetryDueAt:
      typeof record.planningRetryDueAt === "string"
        ? record.planningRetryDueAt
        : null,
    runtimeRetryDueAt:
      typeof record.runtimeRetryDueAt === "string"
        ? record.runtimeRetryDueAt
        : null,
    issueTriageCurrentTriggerReportIds: Array.isArray(
      record.issueTriageCurrentTriggerReportIds,
    )
      ? record.issueTriageCurrentTriggerReportIds.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
    latestIssueTriageReportBlockers: Array.isArray(
      record.latestIssueTriageReportBlockers,
    )
      ? record.latestIssueTriageReportBlockers
      : [],
    postMortemCurrentTriggerReportIds: Array.isArray(
      record.postMortemCurrentTriggerReportIds,
    )
      ? record.postMortemCurrentTriggerReportIds.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
    latestCompletionReport: record.latestCompletionReport ?? null,
    latestApprovalPassVerdict: record.latestApprovalPassVerdict ?? null,
    mergeGate: record.mergeGate ?? null,
    mergeConflict: record.mergeConflict ?? null,
    lifecycleSummaryCiStatus:
      typeof record.lifecycleSummaryCiStatus === "string"
        ? record.lifecycleSummaryCiStatus
        : null,
    lifecyclePersistenceAvailable:
      record.lifecyclePersistenceAvailable === true,
    mergePolicyMode:
      typeof record.mergePolicyMode === "string"
        ? record.mergePolicyMode
        : "manual",
    mergePolicySourceStates: Array.isArray(record.mergePolicySourceStates)
      ? record.mergePolicySourceStates
      : [],
    mergePolicyDoneState:
      typeof record.mergePolicyDoneState === "string"
        ? record.mergePolicyDoneState
        : null,
    mergePolicyConflictsState:
      typeof record.mergePolicyConflictsState === "string"
        ? record.mergePolicyConflictsState
        : null,
    mergePolicyRequiredChecks: Array.isArray(record.mergePolicyRequiredChecks)
      ? record.mergePolicyRequiredChecks
      : [],
    mergePolicyMaxMergeGateFailures:
      typeof record.mergePolicyMaxMergeGateFailures === "number" &&
      Number.isFinite(record.mergePolicyMaxMergeGateFailures)
        ? record.mergePolicyMaxMergeGateFailures
        : 0,
    mergePolicyConfigFingerprint:
      typeof record.mergePolicyConfigFingerprint === "string"
        ? record.mergePolicyConfigFingerprint
        : "legacy",
    currentMergePolicyObservationInputFingerprint:
      typeof record.currentMergePolicyObservationInputFingerprint === "string"
        ? record.currentMergePolicyObservationInputFingerprint
        : null,
    lastMergePolicyObservationFingerprint:
      typeof record.lastMergePolicyObservationFingerprint === "string"
        ? record.lastMergePolicyObservationFingerprint
        : null,
    lastMergePolicyObservationStatus:
      typeof record.lastMergePolicyObservationStatus === "string"
        ? record.lastMergePolicyObservationStatus
        : null,
    lastMergePolicyObservation: record.lastMergePolicyObservation ?? null,
    mergePolicyMerge: record.mergePolicyMerge ?? null,
    mergePolicyMergeGate: record.mergePolicyMergeGate ?? null,
    mergePolicyMergeGateResults: Array.isArray(
      record.mergePolicyMergeGateResults,
    )
      ? record.mergePolicyMergeGateResults
      : [],
    mergePolicyMergeConflict: record.mergePolicyMergeConflict ?? null,
    mergePolicyLatestCompletionReport:
      record.mergePolicyLatestCompletionReport ?? null,
    mergePolicyLatestApprovalVerdict:
      record.mergePolicyLatestApprovalVerdict ?? null,
    mergePolicyReviewFeedback: Array.isArray(record.mergePolicyReviewFeedback)
      ? record.mergePolicyReviewFeedback
      : [],
    mergePolicyLatestCompletionRun:
      record.mergePolicyLatestCompletionRun ?? null,
  };
}

function currentFieldsFromLatestHistory(
  history: readonly IssueHistorySnapshot[],
): IssueCurrentFields | null {
  const latest = history.at(-1);
  return latest === undefined
    ? null
    : normalizeIssueCurrentFields(latest as IssueCurrentFields);
}

function normalizeIssueHistorySnapshot(
  snapshot: IssueHistorySnapshot,
): IssueHistorySnapshot {
  return normalizeIssueHistorySnapshotEvidenceFields({
    ...snapshot,
    snapshotKind:
      snapshot.snapshotKind === "evidence" ||
      snapshot.transitionKind === "record_evidence"
        ? "evidence"
        : "transition",
    triggerSource:
      snapshot.triggerSource === "manual_cli" ||
      snapshot.triggerSource === "transition"
        ? snapshot.triggerSource
        : "orchestrator",
    transitionRequestContext: snapshot.transitionRequestContext ?? null,
    rulesetVersion:
      typeof snapshot.rulesetVersion === "string" &&
      snapshot.rulesetVersion.length > 0
        ? snapshot.rulesetVersion
        : "legacy",
    rulesetFingerprint:
      typeof snapshot.rulesetFingerprint === "string" &&
      snapshot.rulesetFingerprint.length > 0
        ? snapshot.rulesetFingerprint
        : `${snapshot.rulesetId}@legacy:${snapshot.rulesetPriority}`,
    actions: Array.isArray(snapshot.actions) ? snapshot.actions : [],
    errors: Array.isArray(snapshot.errors) ? snapshot.errors : [],
  });
}

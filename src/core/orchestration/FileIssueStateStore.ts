import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { Issue } from "../types.js";
import {
  normalizeIssueHistorySnapshotEvidenceFields,
  type IssueCurrentFields,
  type IssueHistorySnapshot,
  type IssueStateRecord,
  type IssueStateStore,
  type TransitionActionRecord,
  type TransitionErrorRecord,
} from "./IssueOrchestrationState.js";

export class FileIssueStateStore implements IssueStateStore {
  private readonly writeLocks = new Map<string, Promise<void>>();

  constructor(private readonly stateDir: string) {}

  async get(issueIdOrIdentifier: string): Promise<IssueStateRecord | null> {
    const direct = await readJsonIfExists<IssueStateRecord>(
      this.recordPath(issueIdOrIdentifier),
    );
    if (direct) return normalizeIssueStateRecord(direct);
    const records = await this.list();
    return (
      records.find(
        (record) =>
          record.issueId === issueIdOrIdentifier ||
          record.issueIdentifier === issueIdOrIdentifier,
      ) ?? null
    );
  }

  async list(): Promise<IssueStateRecord[]> {
    await fs.mkdir(this.recordsDir(), { recursive: true });
    const entries = await fs.readdir(this.recordsDir());
    const records = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) =>
          readJsonIfExists<IssueStateRecord>(
            path.join(this.recordsDir(), entry),
          ),
        ),
    );
    return records
      .filter((record): record is IssueStateRecord => record !== null)
      .map((record) => normalizeIssueStateRecord(record));
  }

  async ensureIssue(current: IssueCurrentFields): Promise<IssueStateRecord> {
    const existing = await this.find(current.issueId, current.issueIdentifier);
    const now = new Date().toISOString();
    const record: IssueStateRecord = {
      ...(existing ?? {}),
      ...current,
      version: 1,
      recordCreatedAt:
        existing?.recordCreatedAt ?? current.recordCreatedAt ?? now,
      recordUpdatedAt: now,
      history: existing?.history ?? [],
    };
    await this.write(record);
    return record;
  }

  async updateCurrent(
    issue: Pick<Issue, "id" | "identifier">,
    patch: Partial<IssueCurrentFields>,
  ): Promise<IssueStateRecord> {
    const existing = await this.find(issue.id, issue.identifier);
    if (!existing) {
      throw new Error(`Issue state does not exist for ${issue.identifier}`);
    }
    const record: IssueStateRecord = {
      ...existing,
      ...patch,
      issueId: existing.issueId,
      issueIdentifier: existing.issueIdentifier,
      version: 1,
      recordUpdatedAt: new Date().toISOString(),
      history: existing.history,
    };
    await this.write(record);
    return record;
  }

  async appendSnapshot(
    issue: Pick<Issue, "id" | "identifier">,
    snapshot: IssueHistorySnapshot,
  ): Promise<IssueStateRecord> {
    const existing = await this.find(issue.id, issue.identifier);
    if (!existing) {
      throw new Error(`Issue state does not exist for ${issue.identifier}`);
    }
    const record: IssueStateRecord = {
      ...existing,
      recordUpdatedAt: new Date().toISOString(),
      history: [...existing.history, snapshot],
    };
    await this.write(record);
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
    const existing = await this.find(issue.id, issue.identifier);
    if (!existing) return null;
    let found = false;
    const history = existing.history.map((snapshot) => {
      if (snapshot.historySnapshotId !== historySnapshotId) return snapshot;
      found = true;
      return {
        ...snapshot,
        actions:
          patch.actions === undefined ? snapshot.actions : [...patch.actions],
        errors:
          patch.errors === undefined ? snapshot.errors : [...patch.errors],
      };
    });
    if (!found) return existing;
    const record: IssueStateRecord = {
      ...existing,
      recordUpdatedAt: new Date().toISOString(),
      history,
    };
    await this.write(record);
    return record;
  }

  async appendSnapshotAction(
    issue: Pick<Issue, "id" | "identifier">,
    historySnapshotId: string,
    action: TransitionActionRecord,
  ): Promise<IssueStateRecord | null> {
    const existing = await this.find(issue.id, issue.identifier);
    if (!existing) return null;
    const snapshot = existing.history.find(
      (candidate) => candidate.historySnapshotId === historySnapshotId,
    );
    if (!snapshot) return existing;
    return this.updateSnapshotActions(issue, historySnapshotId, {
      actions: [...snapshot.actions, action],
    });
  }

  async appendSnapshotError(
    issue: Pick<Issue, "id" | "identifier">,
    historySnapshotId: string,
    error: TransitionErrorRecord,
  ): Promise<IssueStateRecord | null> {
    const existing = await this.find(issue.id, issue.identifier);
    if (!existing) return null;
    const snapshot = existing.history.find(
      (candidate) => candidate.historySnapshotId === historySnapshotId,
    );
    if (!snapshot) return existing;
    return this.updateSnapshotActions(issue, historySnapshotId, {
      errors: [...snapshot.errors, error],
    });
  }

  private async find(
    issueId: string,
    issueIdentifier: string,
  ): Promise<IssueStateRecord | null> {
    const direct = await this.get(issueId);
    if (direct) return direct;
    return this.get(issueIdentifier);
  }

  private async write(record: IssueStateRecord): Promise<void> {
    const key = record.issueId;
    const previous = this.writeLocks.get(key) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.writeUnlocked(record);
        } finally {
          if (this.writeLocks.get(key) === current) this.writeLocks.delete(key);
        }
      });
    this.writeLocks.set(key, current);
    await current;
  }

  private async writeUnlocked(record: IssueStateRecord): Promise<void> {
    await fs.mkdir(this.recordsDir(), { recursive: true });
    const target = this.recordPath(record.issueId);
    const temp = path.join(
      this.recordsDir(),
      `${path.basename(target)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
    );
    await fs.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    if (process.platform === "win32") {
      await fs.rm(target, { force: true });
    }
    await fs.rename(temp, target);
  }

  private recordsDir(): string {
    return path.join(this.stateDir, "issue-state");
  }

  private recordPath(issueIdOrIdentifier: string): string {
    return path.join(
      this.recordsDir(),
      `${safeFileName(issueIdOrIdentifier)}.json`,
    );
  }
}

function normalizeIssueStateRecord(record: IssueStateRecord): IssueStateRecord {
  const { history: rawHistory, ...rawCurrent } = record;
  const current = normalizeIssueCurrentFields(rawCurrent as IssueCurrentFields);
  return {
    ...current,
    history: Array.isArray(rawHistory)
      ? rawHistory.map(normalizeIssueHistorySnapshot)
      : [],
  };
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

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "issue";
}

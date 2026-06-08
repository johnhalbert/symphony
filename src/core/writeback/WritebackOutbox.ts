import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { Logger } from "../logging/StructuredLogger.js";
import type { ServiceConfig } from "../config/Config.js";
import { projectScopedKey } from "../config/ProjectContexts.js";
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
      projectContextId?: string | null;
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
      projectContextId?: string | null;
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
      projectContextId?: string | null;
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
      projectContextId?: string | null;
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
  getConfig: () => ServiceConfig;
  resolveIssue: (issueId: string, projectContextId?: string | null) => Promise<IssueBreakdownIssueLookupResult>;
};

export type ProcessDueOptions = {
  idempotencyKeys?: readonly string[];
  operations?: readonly WritebackIdentityInput[];
};

export type EnqueueWritebackOptions = {
  retrySkipped?: boolean;
  retrySkippedMessages?: readonly string[];
};

type WritebackIdentityInput = { idempotencyKey: string; projectContextId?: string | null };

type LifecycleGuardResult =
  | { status: "ready" }
  | { status: "blocked"; message: string }
  | { status: "retry"; message: string };

export class FileWritebackOutboxStore {
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
    const existing = await this.get(operation.idempotencyKey, operation.projectContextId);
    if (existing) return existing;
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

  async claimDue(
    now = new Date(),
    options: { idempotencyKeys?: readonly string[]; operations?: readonly WritebackIdentityInput[] } = {},
  ): Promise<WritebackOperation[]> {
    const records = await this.list();
    const allowedIdentities = options.operations === undefined ? null : new Set(options.operations.map(writebackOperationIdentity));
    const allowedIdempotencyKeys =
      allowedIdentities === null && options.idempotencyKeys !== undefined ? new Set(options.idempotencyKeys) : null;
    const due = records
      .filter((record) => ["pending", "retrying"].includes(record.status))
      .filter((record) => Date.parse(record.nextAttemptAt) <= now.getTime())
      .filter((record) => matchesRequestedWriteback(record, allowedIdentities, allowedIdempotencyKeys))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const claimed: WritebackOperation[] = [];
    for (const record of due) {
      const identityKey = writebackOperationIdentity(record);
      if (this.claimLocks.has(identityKey)) continue;
      this.claimLocks.add(identityKey);
      try {
        const current = await this.get(record.idempotencyKey, record.projectContextId);
        if (!current) continue;
        if (!["pending", "retrying"].includes(current.status)) continue;
        if (Date.parse(current.nextAttemptAt) > now.getTime()) continue;
        if (!matchesRequestedWriteback(current, allowedIdentities, allowedIdempotencyKeys)) continue;
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

  async get(idempotencyKey: string, projectContextId?: string | null): Promise<WritebackOperation | null> {
    for (const candidate of this.lookupPaths(idempotencyKey, projectContextId)) {
      const record = await readJsonIfExists<WritebackOperation>(candidate);
      if (record) return record;
    }
    return null;
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
    const identityKey = writebackOperationIdentity(record);
    const previous = this.writeLocks.get(identityKey) ?? Promise.resolve();
    let current!: Promise<void>;
    current = (async () => {
      await previous.catch(() => undefined);
      try {
        await this.writeUnlocked(record);
      } finally {
        if (this.writeLocks.get(identityKey) === current) {
          this.writeLocks.delete(identityKey);
        }
      }
    })();
    this.writeLocks.set(identityKey, current);
    await current;
  }

  private async writeUnlocked(record: WritebackOperation): Promise<void> {
    await fs.mkdir(this.recordsDir(), { recursive: true });
    const target = this.recordPath(writebackOperationIdentity(record));
    const temp = path.join(this.recordsDir(), `${path.basename(target)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
    await fs.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    if (process.platform === "win32") {
      await fs.rm(target, { force: true });
    }
    await fs.rename(temp, target);
    for (const identity of writebackLookupIdentities(record)) {
      const alternateRecordPath = this.recordPath(identity);
      if (alternateRecordPath !== target) await rmIfExists(alternateRecordPath);
      const legacy = this.legacyRecordPath(identity);
      if (legacy !== target) await rmIfExists(legacy);
    }
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

  private lookupPaths(idempotencyKey: string, projectContextId?: string | null): string[] {
    const candidates: string[] = [];
    for (const identity of writebackLookupIdentities({ idempotencyKey, ...(projectContextId === undefined ? {} : { projectContextId }) })) {
      candidates.push(this.recordPath(identity));
    }
    for (const identity of writebackLookupIdentities({ idempotencyKey, ...(projectContextId === undefined ? {} : { projectContextId }) })) {
      const legacy = this.legacyRecordPath(identity);
      if (!candidates.includes(legacy)) candidates.push(legacy);
    }
    return candidates;
  }
}

export class WritebackProcessor {
  constructor(
    private readonly store: FileWritebackOutboxStore,
    private readonly writer: TrackerWriter,
    private readonly logger: Logger,
    private readonly maxBackoffMs: number,
    private readonly lifecycleStore?: Pick<IssueLifecycleStore, "get">,
    private readonly dryRun = false,
    private readonly issueBreakdownFreshnessGuard?: IssueBreakdownFreshnessGuard,
  ) {}

  async enqueueAndProcess(operation: NewWritebackOperation, options: EnqueueWritebackOptions = {}): Promise<WritebackOperation> {
    let record = await this.store.enqueueOnce(operation);
    if (record.status === "succeeded") return record;
    if (canRetrySkipped(record, operation, options)) {
      record = await this.store.requeueSkipped(record);
    }
    await this.processDue();
    return (await this.store.get(record.idempotencyKey, record.projectContextId)) ?? record;
  }

  async processDue(options: ProcessDueOptions = {}): Promise<void> {
    const claimOptions = {
      ...(options.idempotencyKeys === undefined ? {} : { idempotencyKeys: options.idempotencyKeys }),
      ...(options.operations === undefined ? {} : { operations: options.operations }),
    };
    for (const record of await this.store.claimDue(new Date(), claimOptions)) {
      try {
        const guard = await this.verifyLifecycleBoundOperation(record);
        if (guard.status === "blocked") {
          await this.store.markSkipped(record, guard.message);
          continue;
        }
        if (guard.status === "retry") {
          const nextAttemptAt = new Date(Date.now() + computeWritebackBackoffMs(record.attempt + 1, this.maxBackoffMs)).toISOString();
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
      if (!plan.applicationOperationKeys.includes(record.idempotencyKey)) {
        return { status: "blocked", message: "issue breakdown writeback is not registered on the current plan" };
      }
      if ((record.kind === "comment" || record.kind === "issue_relation") && plan.createdIssueRefs.length < plan.proposedIssues.length) {
        return { status: "blocked", message: "issue breakdown relation/comment writeback requires durable child refs" };
      }
      if (!this.issueBreakdownFreshnessGuard) {
        return { status: "blocked", message: "issue breakdown writeback requires freshness guard" };
      }
      const config = this.issueBreakdownFreshnessGuard.getConfig();
      const lookup = await this.issueBreakdownFreshnessGuard.resolveIssue(record.issueId, record.projectContextId ?? null);
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
    if (!acceptedReport || !acceptedReport.writebackOperationKeys.includes(record.idempotencyKey) || acceptedReport.pullRequest === null) {
      return {
        status: "blocked",
        message: "pull request handoff requires a durable accepted completion report with matching PR evidence",
      };
    }
    return { status: "ready" };
  }

  private async execute(record: WritebackOperation) {
    if (this.dryRun) {
      return dryRunResult(record);
    }
    if (record.kind === "transition") {
      return this.writer.transitionIssueState({
        issueId: record.issueId,
        projectContextId: record.projectContextId ?? null,
        toState: record.payload.toState,
        ...(record.payload.fromStates === undefined ? {} : { fromStates: record.payload.fromStates }),
        ...(record.payload.reason === undefined ? {} : { reason: record.payload.reason }),
      });
    }
    if (record.kind === "comment") {
      return this.writer.createIssueComment({
        issueId: record.issueId,
        projectContextId: record.projectContextId ?? null,
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
        projectContextId: record.projectContextId ?? null,
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
      projectContextId: record.projectContextId ?? null,
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
    const identityKey = writebackOperationIdentity(record);
    const existing = byKey.get(identityKey);
    if (!existing || Date.parse(record.updatedAt) >= Date.parse(existing.updatedAt)) {
      byKey.set(identityKey, record);
    }
  }
  return Array.from(byKey.values());
}

function matchesNewWritebackOperation(record: WritebackOperation, operation: NewWritebackOperation): boolean {
  if (record.idempotencyKey !== operation.idempotencyKey || record.kind !== operation.kind || record.issueId !== operation.issueId) {
    return false;
  }
  if (normalizeProjectContextId(record.projectContextId) !== normalizeProjectContextId(operation.projectContextId)) return false;
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

function matchesRequestedWriteback(
  record: WritebackOperation,
  allowedIdentities: ReadonlySet<string> | null,
  allowedIdempotencyKeys: ReadonlySet<string> | null,
): boolean {
  if (allowedIdentities) return allowedIdentities.has(writebackOperationIdentity(record));
  if (allowedIdempotencyKeys) return allowedIdempotencyKeys.has(record.idempotencyKey);
  return true;
}

function writebackLookupIdentities(input: WritebackIdentityInput): string[] {
  const identityKey = writebackOperationIdentity(input);
  return identityKey === input.idempotencyKey ? [input.idempotencyKey] : [identityKey, input.idempotencyKey];
}

function writebackOperationIdentity(input: WritebackIdentityInput): string {
  const projectContextId = normalizeProjectContextId(input.projectContextId);
  return projectContextId ? projectScopedKey(projectContextId, input.idempotencyKey) : input.idempotencyKey;
}

function normalizeProjectContextId(projectContextId: string | null | undefined): string | null {
  const trimmed = projectContextId?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
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

import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "../logging/StructuredLogger.js";
import type { ServiceConfig } from "../config/Config.js";
import { latestFreshIssueBreakdownPlan } from "../IssueBreakdownPlanService.js";
import type { IssueLifecycleStore } from "../persistence/IssueLifecycleStore.js";
import type { TrackerWriteEvidence, TrackerWriteResult, TrackerWriter } from "../tracker/TrackerWriter.js";
import type { Issue } from "../types.js";
import { errorMessage } from "../errors.js";

export type WritebackStatus = "pending" | "in_flight" | "succeeded" | "skipped" | "retrying" | "dead_letter";

export type WritebackOperation =
  | {
      idempotencyKey: string;
      kind: "transition";
      issueId: string;
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

type LifecycleGuardResult =
  | { status: "ready" }
  | { status: "blocked"; message: string }
  | { status: "retry"; message: string };

export class FileWritebackOutboxStore {
  constructor(private readonly stateDir: string) {}

  async enqueueOnce(operation: NewWritebackOperation): Promise<WritebackOperation> {
    const existing = await this.get(operation.idempotencyKey);
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
    return record;
  }

  async claimDue(now = new Date(), options: { idempotencyKeys?: readonly string[] } = {}): Promise<WritebackOperation[]> {
    const records = await this.list();
    const allowed = options.idempotencyKeys === undefined ? null : new Set(options.idempotencyKeys);
    const due = records
      .filter((record) => ["pending", "retrying", "in_flight"].includes(record.status))
      .filter((record) => Date.parse(record.nextAttemptAt) <= now.getTime())
      .filter((record) => allowed === null || allowed.has(record.idempotencyKey))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    for (const record of due) {
      record.status = "in_flight";
      record.updatedAt = new Date().toISOString();
      await this.write(record);
    }
    return due;
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
    return readJsonIfExists<WritebackOperation>(this.recordPath(idempotencyKey));
  }

  async list(): Promise<WritebackOperation[]> {
    await fs.mkdir(this.recordsDir(), { recursive: true });
    const entries = await fs.readdir(this.recordsDir());
    const records = await Promise.all(
      entries.filter((entry) => entry.endsWith(".json")).map((entry) => readJsonIfExists<WritebackOperation>(path.join(this.recordsDir(), entry))),
    );
    return records.filter((record): record is WritebackOperation => record !== null);
  }

  private async update(record: WritebackOperation, patch: Partial<WritebackOperation>): Promise<WritebackOperation> {
    const updated = { ...record, ...patch, updatedAt: new Date().toISOString() } as WritebackOperation;
    await this.write(updated);
    return updated;
  }

  private async write(record: WritebackOperation): Promise<void> {
    await fs.mkdir(this.recordsDir(), { recursive: true });
    const target = this.recordPath(record.idempotencyKey);
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    if (process.platform === "win32") {
      await fs.rm(target, { force: true });
    }
    await fs.rename(temp, target);
  }

  private recordsDir(): string {
    return path.join(this.stateDir, "writeback");
  }

  private recordPath(idempotencyKey: string): string {
    return path.join(this.recordsDir(), `${safeFileName(idempotencyKey)}.json`);
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

  async enqueueAndProcess(operation: NewWritebackOperation, options: { retrySkipped?: boolean } = {}): Promise<WritebackOperation> {
    let record = await this.store.enqueueOnce(operation);
    if (record.status === "succeeded") return record;
    if (options.retrySkipped === true && record.status === "skipped" && matchesNewWritebackOperation(record, operation)) {
      record = await this.store.requeueSkipped(record);
    }
    await this.processDue();
    return (await this.store.get(record.idempotencyKey)) ?? record;
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
        return { status: "blocked", message: "issue breakdown writeback is not bound to the current plan" };
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

function matchesNewWritebackOperation(record: WritebackOperation, operation: NewWritebackOperation): boolean {
  if (record.idempotencyKey !== operation.idempotencyKey || record.kind !== operation.kind || record.issueId !== operation.issueId) {
    return false;
  }
  if (record.runId !== operation.runId) return false;
  if (record.kind === "transition" && operation.kind === "transition") {
    return (
      record.payload.toState === operation.payload.toState &&
      record.payload.reason === operation.payload.reason &&
      stringArraysEqual(record.payload.fromStates, operation.payload.fromStates)
    );
  }
  if (record.kind === "comment" && operation.kind === "comment") {
    return record.payload.body === operation.payload.body && record.payload.dedupeKey === operation.payload.dedupeKey;
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

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

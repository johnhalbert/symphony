import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "../logging/StructuredLogger.js";
import type { TrackerWriter } from "../tracker/TrackerWriter.js";
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
      payload: { body: string; dedupeKey: string };
    };

type PersistedWritebackFields = "status" | "attempt" | "createdAt" | "updatedAt" | "nextAttemptAt" | "lastError";

export type NewWritebackOperation =
  | Omit<Extract<WritebackOperation, { kind: "transition" }>, PersistedWritebackFields>
  | Omit<Extract<WritebackOperation, { kind: "comment" }>, PersistedWritebackFields>;

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
    } as WritebackOperation;
    await this.write(record);
    return record;
  }

  async claimDue(now = new Date()): Promise<WritebackOperation[]> {
    const records = await this.list();
    const due = records
      .filter((record) => ["pending", "retrying", "in_flight"].includes(record.status))
      .filter((record) => Date.parse(record.nextAttemptAt) <= now.getTime())
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    for (const record of due) {
      record.status = "in_flight";
      record.updatedAt = new Date().toISOString();
      await this.write(record);
    }
    return due;
  }

  async markSucceeded(record: WritebackOperation): Promise<WritebackOperation> {
    return this.update(record, { status: "succeeded", lastError: null });
  }

  async markSkipped(record: WritebackOperation, message: string): Promise<WritebackOperation> {
    return this.update(record, { status: "skipped", lastError: message });
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
    await fs.writeFile(this.recordPath(record.idempotencyKey), `${JSON.stringify(record, null, 2)}\n`, "utf8");
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

  async processDue(): Promise<void> {
    for (const record of await this.store.claimDue()) {
      try {
        const result = await this.execute(record);
        if (result.status === "applied" || result.status === "verified") {
          await this.store.markSucceeded(record);
        } else {
          await this.store.markSkipped(record, result.message ?? `Writeback ${result.status}`);
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

  private async execute(record: WritebackOperation) {
    if (record.kind === "transition") {
      return this.writer.transitionIssueState({
        issueId: record.issueId,
        toState: record.payload.toState,
        ...(record.payload.fromStates === undefined ? {} : { fromStates: record.payload.fromStates }),
        ...(record.payload.reason === undefined ? {} : { reason: record.payload.reason }),
      });
    }
    return this.writer.createIssueComment({
      issueId: record.issueId,
      body: record.payload.body,
      dedupeKey: record.payload.dedupeKey,
    });
  }
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

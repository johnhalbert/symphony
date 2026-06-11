import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ServiceConfig } from "../config/Config.js";
import {
  normalizeProjectContextResolution,
  type ProjectContextResolution,
} from "../config/ProjectContexts.js";
import { SymphonyError } from "../errors.js";
import type { RunTranscriptStore, TranscriptEvent } from "../persistence/RunTranscriptStore.js";

export type OperatorApprovalDecision = "approve" | "reject";
export type OperatorApprovalRejectPolicy = "cancel" | "fail";
export type OperatorApprovalStatus = "pending" | "approved" | "rejected" | "stale" | "expired" | "cancelled";

export interface OperatorApprovalAction {
  kind: "push_and_pr";
  branchName: string;
  baseBranch: string;
  workspacePath: string;
  title: string;
  evidenceCursor: string;
  summaryPreview: string;
  changedFiles: string[];
  plannedOperations: Array<"commit_if_needed" | "git_push" | "pull_request_create_or_reuse">;
}

export interface OperatorApprovalRecord {
  requestId: string;
  status: OperatorApprovalStatus;
  issueId: string;
  issueIdentifier: string;
  projectContext?: ProjectContextResolution | undefined;
  runId: string;
  evidenceCursor: string;
  dedupeKey: string;
  action: OperatorApprovalAction;
  requestedAt: string;
  expiresAt: string | null;
  resolvedAt: string | null;
  resolvedBy: "operator" | "system" | null;
  decision: OperatorApprovalDecision | null;
  staleReason: string | null;
}

export interface OperatorApprovalResolution {
  request: OperatorApprovalRecord;
  replayed: boolean;
}

export interface OperatorApprovalRequestInput {
  issueId: string;
  issueIdentifier: string;
  projectContext?: ProjectContextResolution | undefined;
  runId: string;
  evidenceCursor: string;
  action: OperatorApprovalAction;
}

export const OPERATOR_REJECTED_PUBLICATION_ERROR = "Operator rejected push/PR publication";

export class FileOperatorApprovalStore {
  constructor(private readonly stateDir: string) {}

  async requestOrGetPending(input: OperatorApprovalRequestInput, timeoutMs: number | null): Promise<{ record: OperatorApprovalRecord; created: boolean }> {
    await fs.mkdir(this.recordsDir(), { recursive: true });
    const requestId = requestIdFor(dedupeKey(input.runId, input.evidenceCursor));
    const projectContext = await this.resolveProjectContext(input.projectContext, input.runId);
    const existing = await this.get(requestId);
    if (existing) {
      return {
        record: await this.backfillProjectContextOnReplay(existing, projectContext),
        created: false,
      };
    }

    const requestedAt = new Date().toISOString();
    const record: OperatorApprovalRecord = normalizeOperatorApprovalRecord({
      requestId,
      status: "pending",
      issueId: input.issueId,
      issueIdentifier: input.issueIdentifier,
      projectContext,
      runId: input.runId,
      evidenceCursor: input.evidenceCursor,
      dedupeKey: dedupeKey(input.runId, input.evidenceCursor),
      action: input.action,
      requestedAt,
      expiresAt: timeoutMs === null ? null : new Date(Date.now() + timeoutMs).toISOString(),
      resolvedAt: null,
      resolvedBy: null,
      decision: null,
      staleReason: null,
    });
    await this.write(record);
    return { record, created: true };
  }

  async get(requestId: string): Promise<OperatorApprovalRecord | null> {
    const record = await readJsonIfExists<OperatorApprovalRecord>(this.recordPath(requestId));
    if (record === null) return null;
    return this.repairProjectContextIfMissing(
      normalizeOperatorApprovalRecord(record),
      undefined,
      record as unknown as Record<string, unknown>,
    );
  }

  async getByDedupe(runId: string, evidenceCursor: string): Promise<OperatorApprovalRecord | null> {
    return this.get(requestIdFor(dedupeKey(runId, evidenceCursor)));
  }

  async findPendingForRun(runId: string): Promise<OperatorApprovalRecord | null> {
    const records = await this.list();
    return latestPending(records.filter((record) => record.runId === runId));
  }

  async findPendingForIssue(
    keys: string[],
    projectContext: ProjectContextResolution | undefined = undefined,
  ): Promise<OperatorApprovalRecord | null> {
    const normalized = new Set(keys.map((key) => key.toLowerCase()));
    const records = await this.list();
    return latestPending(
      records.filter(
        (record) =>
          (normalized.has(record.issueId.toLowerCase()) || normalized.has(record.issueIdentifier.toLowerCase())) &&
          matchesProjectContext(record.projectContext, projectContext),
      ),
    );
  }

  async list(): Promise<OperatorApprovalRecord[]> {
    try {
      await fs.mkdir(this.recordsDir(), { recursive: true });
      const entries = await fs.readdir(this.recordsDir());
      const records = await Promise.all(
        entries.filter((entry) => entry.endsWith(".json")).map((entry) => readJsonIfExists<OperatorApprovalRecord>(path.join(this.recordsDir(), entry))),
      );
      return Promise.all(
        records
          .filter((record): record is OperatorApprovalRecord => record !== null)
          .map((record) =>
            this.repairProjectContextIfMissing(
              normalizeOperatorApprovalRecord(record),
              undefined,
              record as unknown as Record<string, unknown>,
            ),
          ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async readStoredRecord(requestId: string): Promise<Record<string, unknown> | null> {
    return readJsonIfExists<Record<string, unknown>>(this.recordPath(requestId));
  }

  async resolve(requestId: string, decision: OperatorApprovalDecision): Promise<OperatorApprovalResolution> {
    const existing = await this.get(requestId);
    if (!existing) throw new SymphonyError("not_found", `Approval request not found: ${requestId}`);
    const repaired = await this.repairProjectContextIfMissing(existing);
    if (repaired.status === "approved" || repaired.status === "rejected") {
      if ((repaired.status === "approved" && decision === "approve") || (repaired.status === "rejected" && decision === "reject")) {
        return { request: repaired, replayed: true };
      }
      throw new SymphonyError("conflict", `Approval request is already ${repaired.status}`);
    }
    if (repaired.status !== "pending") {
      throw new SymphonyError("conflict", `Approval request is ${repaired.status}`);
    }
    const resolved = await this.markTerminal(repaired, decision === "approve" ? "approved" : "rejected", {
      decision,
      resolvedBy: "operator",
    });
    return { request: resolved, replayed: false };
  }

  async markStale(requestId: string, reason: string): Promise<OperatorApprovalRecord> {
    const existing = await this.require(requestId);
    const repaired = await this.repairProjectContextIfMissing(existing);
    if (repaired.status !== "pending") return repaired;
    return this.markTerminal(repaired, "stale", { staleReason: reason, resolvedBy: "system" });
  }

  async markExpired(requestId: string): Promise<OperatorApprovalRecord> {
    const existing = await this.require(requestId);
    const repaired = await this.repairProjectContextIfMissing(existing);
    if (repaired.status !== "pending") return repaired;
    return this.markTerminal(repaired, "expired", { staleReason: "approval request expired", resolvedBy: "system" });
  }

  async markCancelled(requestId: string, reason: string): Promise<OperatorApprovalRecord> {
    const existing = await this.require(requestId);
    const repaired = await this.repairProjectContextIfMissing(existing);
    if (repaired.status !== "pending") return repaired;
    return this.markTerminal(repaired, "cancelled", { staleReason: reason, resolvedBy: "system" });
  }

  private async require(requestId: string): Promise<OperatorApprovalRecord> {
    const record = await this.get(requestId);
    if (!record) throw new SymphonyError("not_found", `Approval request not found: ${requestId}`);
    return record;
  }

  private async markTerminal(
    record: OperatorApprovalRecord,
    status: OperatorApprovalStatus,
    patch: Partial<Pick<OperatorApprovalRecord, "decision" | "resolvedBy" | "staleReason">>,
  ): Promise<OperatorApprovalRecord> {
    const resolved: OperatorApprovalRecord = normalizeOperatorApprovalRecord({
      ...record,
      status,
      decision: patch.decision ?? record.decision,
      resolvedBy: patch.resolvedBy ?? record.resolvedBy,
      staleReason: patch.staleReason ?? record.staleReason,
      resolvedAt: new Date().toISOString(),
    });
    await this.write(resolved);
    return resolved;
  }

  private async backfillProjectContextOnReplay(
    existing: OperatorApprovalRecord,
    projectContext: ProjectContextResolution | undefined,
  ): Promise<OperatorApprovalRecord> {
    return this.repairProjectContextIfMissing(existing, projectContext);
  }

  private async repairProjectContextIfMissing(
    existing: OperatorApprovalRecord,
    projectContext: ProjectContextResolution | undefined = undefined,
    rawRecord: Record<string, unknown> | null | undefined = undefined,
  ): Promise<OperatorApprovalRecord> {
    const raw = rawRecord ?? (await this.readStoredRecord(existing.requestId));
    if (!needsProjectContextBackfill(raw)) return existing;
    const runProjectContext = projectContext ?? (await this.readRunProjectContext(existing.runId));
    const repaired = normalizeOperatorApprovalRecord({
      ...existing,
      projectContext: projectContextBackfillSource(raw, runProjectContext, existing.projectContext),
    });
    await this.write(repaired);
    return repaired;
  }

  private async readRunProjectContext(runId: string): Promise<ProjectContextResolution | undefined> {
    const run = await readJsonIfExists<{ projectContext?: ProjectContextResolution | undefined }>(
      path.join(this.stateDir, "runs", safeFileName(runId), "meta.json"),
    );
    return run?.projectContext;
  }

  private async resolveProjectContext(
    projectContext: ProjectContextResolution | undefined,
    runId: string,
  ): Promise<ProjectContextResolution> {
    if (projectContext) {
      return normalizeProjectContextResolution(projectContext);
    }
    return normalizeProjectContextResolution(await this.readRunProjectContext(runId));
  }

  private async write(record: OperatorApprovalRecord): Promise<void> {
    await fs.mkdir(this.recordsDir(), { recursive: true });
    await fs.writeFile(this.recordPath(record.requestId), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  }

  private recordsDir(): string {
    return path.join(this.stateDir, "approval-requests");
  }

  private recordPath(requestId: string): string {
    return path.join(this.recordsDir(), `${safeFileName(requestId)}.json`);
  }
}

export class OperatorApprovalService {
  constructor(
    private readonly options: {
      config: ServiceConfig;
      store: FileOperatorApprovalStore;
      runStore: Pick<RunTranscriptStore, "appendEvent" | "getRun" | "updateRun">;
    },
  ) {}

  get rejectPolicy(): OperatorApprovalRejectPolicy {
    return operatorApprovalConfig(this.options.config).rejectPolicy;
  }

  async requestPublicationApproval(input: OperatorApprovalRequestInput): Promise<OperatorApprovalRecord> {
    const projectContext = await this.resolveProjectContext(input);
    if (!this.isRequired()) {
      return normalizeOperatorApprovalRecord({
        requestId: "",
        status: "approved",
        issueId: input.issueId,
        issueIdentifier: input.issueIdentifier,
        projectContext,
        runId: input.runId,
        evidenceCursor: input.evidenceCursor,
        dedupeKey: dedupeKey(input.runId, input.evidenceCursor),
        action: input.action,
        requestedAt: new Date().toISOString(),
        expiresAt: null,
        resolvedAt: new Date().toISOString(),
        resolvedBy: "system",
        decision: "approve",
        staleReason: null,
      });
    }

    await this.staleOtherPendingRequests(input.runId, input.evidenceCursor);
    const requestInput = { ...input, projectContext };
    const { record, created } = await this.options.store.requestOrGetPending(
      requestInput,
      operatorApprovalConfig(this.options.config).timeoutMs,
    );
    if (record.status === "pending") {
      await this.recordPendingRun(record);
    }
    if (created) {
      await this.appendApprovalRequestEvent(record);
    }

    return record;
  }

  async waitForPublicationApprovalRequest(record: OperatorApprovalRecord): Promise<OperatorApprovalRecord> {
    return this.waitForResolution(record);
  }

  async waitForPublicationApproval(input: OperatorApprovalRequestInput): Promise<OperatorApprovalRecord> {
    return this.waitForPublicationApprovalRequest(await this.requestPublicationApproval(input));
  }

  async resolve(requestId: string, decision: OperatorApprovalDecision): Promise<OperatorApprovalResolution> {
    const existing = await this.options.store.get(requestId);
    if (!existing) throw new SymphonyError("not_found", `Approval request not found: ${requestId}`);
    if (existing.status === "pending") {
      if (existing.expiresAt !== null && Date.parse(existing.expiresAt) <= Date.now()) {
        const expired = await this.options.store.markExpired(requestId);
        await this.clearPendingRun(expired);
        await this.appendApprovalResolvedEvent(expired);
        throw new SymphonyError("conflict", "Approval request is expired", expired);
      }

      const staleReason = await this.staleReason(existing);
      if (staleReason !== null) {
        const stale = await this.options.store.markStale(requestId, staleReason);
        await this.clearPendingRun(stale);
        await this.appendApprovalResolvedEvent(stale);
        throw new SymphonyError("conflict", `Approval request is stale: ${staleReason}`, stale);
      }
    }

    const result = await this.options.store.resolve(requestId, decision);
    if (!result.replayed) {
      if (decision === "reject" && this.rejectPolicy === "fail") {
        await this.clearPendingRun(result.request);
        await this.markRunFailedForRejection(result.request);
      } else {
        await this.clearPendingRun(result.request);
      }
      await this.appendApprovalResolvedEvent(result.request);
    }
    return result;
  }

  async get(requestId: string): Promise<OperatorApprovalRecord | null> {
    return this.options.store.get(requestId);
  }

  async getByDedupe(runId: string, evidenceCursor: string): Promise<OperatorApprovalRecord | null> {
    return this.options.store.getByDedupe(runId, evidenceCursor);
  }

  async findPendingForRun(runId: string): Promise<OperatorApprovalRecord | null> {
    return this.options.store.findPendingForRun(runId);
  }

  async findPendingForIssue(
    keys: string[],
    projectContext: ProjectContextResolution | undefined = undefined,
  ): Promise<OperatorApprovalRecord | null> {
    return this.options.store.findPendingForIssue(keys, projectContext);
  }

  isRequired(): boolean {
    return this.options.config.github.publishPullRequests && operatorApprovalConfig(this.options.config).requiredForPublication;
  }

  private async waitForResolution(initial: OperatorApprovalRecord): Promise<OperatorApprovalRecord> {
    let current = initial;
    while (true) {
      if (current.status === "approved") {
        await this.clearPendingRun(current);
        return current;
      }
      if (current.status === "rejected") {
        await this.clearPendingRun(current);
        throw new SymphonyError("invalid_request", OPERATOR_REJECTED_PUBLICATION_ERROR, current);
      }
      if (current.status === "stale" || current.status === "expired" || current.status === "cancelled") {
        await this.clearPendingRun(current);
        throw new SymphonyError("invalid_request", `Approval request is ${current.status}`, current);
      }

      const staleReason = await this.staleReason(current);
      if (staleReason !== null) {
        current = await this.options.store.markStale(current.requestId, staleReason);
        await this.clearPendingRun(current);
        await this.appendApprovalResolvedEvent(current);
        continue;
      }
      if (current.expiresAt !== null && Date.parse(current.expiresAt) <= Date.now()) {
        current = await this.options.store.markExpired(current.requestId);
        await this.clearPendingRun(current);
        await this.appendApprovalResolvedEvent(current);
        continue;
      }

      await sleep(operatorApprovalConfig(this.options.config).pollIntervalMs);
      current = (await this.options.store.get(current.requestId)) ?? current;
    }
  }

  private async staleOtherPendingRequests(runId: string, evidenceCursor: string): Promise<void> {
    const pending = await this.options.store.findPendingForRun(runId);
    if (!pending || pending.evidenceCursor === evidenceCursor) return;
    const stale = await this.options.store.markStale(pending.requestId, "superseded by newer completion report evidence cursor");
    await this.appendApprovalResolvedEvent(stale);
  }

  private async staleReason(record: OperatorApprovalRecord): Promise<string | null> {
    const run = await this.getRun(record.runId);
    if (!run) return "run record is missing";
    if (run.cancellationRequestedAt) return "run cancellation has been requested";
    const latest = await this.options.store.findPendingForRun(record.runId);
    if (latest && latest.requestId !== record.requestId) return "approval request was superseded";
    return null;
  }

  private async clearPendingRun(record: OperatorApprovalRecord): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const run = await this.getRun(record.runId);
        if (run?.pendingApprovalRequestId !== record.requestId) return;
        await this.options.runStore.updateRun(record.runId, {
          metadata: {
            pendingApprovalRequestId: null,
            pendingApprovalRequestedAt: null,
          },
        });
        return;
      } catch (error) {
        if (!(error instanceof SyntaxError) || attempt === 2) throw error;
        await sleep(5);
      }
    }
  }

  private async recordPendingRun(record: OperatorApprovalRecord): Promise<void> {
    const run = await this.getRun(record.runId);
    if (
      run?.pendingApprovalRequestId === record.requestId &&
      run.pendingApprovalRequestedAt === record.requestedAt
    ) {
      return;
    }
    await this.options.runStore.updateRun(record.runId, {
      metadata: {
        pendingApprovalRequestId: record.requestId,
        pendingApprovalRequestedAt: record.requestedAt,
      },
    });
  }

  private async resolveProjectContext(
    input: OperatorApprovalRequestInput,
  ): Promise<ProjectContextResolution> {
    if (input.projectContext) {
      return normalizeProjectContextResolution(input.projectContext);
    }
    const run = await this.getRun(input.runId);
    return normalizeProjectContextResolution(run?.projectContext);
  }

  private async getRun(runId: string) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.options.runStore.getRun(runId);
      } catch (error) {
        if (!(error instanceof SyntaxError) || attempt === 2) throw error;
        await sleep(5);
      }
    }
    return null;
  }

  private async markRunFailedForRejection(record: OperatorApprovalRecord): Promise<void> {
    const run = await this.getRun(record.runId);
    if (run?.status !== "running") return;
    await this.options.runStore.updateRun(record.runId, {
      status: "failed",
      completedAt: new Date().toISOString(),
      error: OPERATOR_REJECTED_PUBLICATION_ERROR,
    });
  }

  private async appendApprovalRequestEvent(record: OperatorApprovalRecord): Promise<TranscriptEvent> {
    return this.options.runStore.appendEvent({
      runId: record.runId,
      at: record.requestedAt,
      source: "orchestrator",
      eventType: "approval_request",
      message: `Operator approval required before push/PR publication: ${record.action.branchName} -> ${record.action.baseBranch}`,
      payload: approvalRequestPayload(record),
    });
  }

  private async appendApprovalResolvedEvent(record: OperatorApprovalRecord): Promise<TranscriptEvent> {
    return this.options.runStore.appendEvent({
      runId: record.runId,
      at: record.resolvedAt ?? new Date().toISOString(),
      source: "orchestrator",
      eventType: "approval_resolved",
      message: `Operator approval ${record.status}: ${record.action.branchName} -> ${record.action.baseBranch}`,
      payload: approvalResolvedPayload(record, operatorApprovalConfig(this.options.config).rejectPolicy),
    });
  }
}

export function approvalRequestPayload(record: OperatorApprovalRecord): Record<string, unknown> {
  return {
    requestId: record.requestId,
    status: record.status,
    reason: "workflow_policy",
    prompt: `Approve service-owned push and PR publication for ${record.action.branchName} targeting ${record.action.baseBranch}?`,
    actions: [
      { id: "approve", label: "Approve and publish", decision: "approve" },
      { id: "reject", label: "Reject", decision: "reject" },
    ],
    action: record.action,
    projectContext: record.projectContext,
    dedupeKey: { runId: record.runId, evidenceCursor: record.evidenceCursor },
    requestedAt: record.requestedAt,
    expiresAt: record.expiresAt,
    resolve: approvalResolve(record),
  };
}

export function approvalResolve(record: OperatorApprovalRecord): Record<string, unknown> {
  return {
    method: "POST",
    path: `/api/v1/approval-requests/${encodeURIComponent(record.requestId)}`,
    header: "X-Symphony-Token",
  };
}

function approvalResolvedPayload(record: OperatorApprovalRecord, rejectPolicy: OperatorApprovalRejectPolicy): Record<string, unknown> {
  return {
    requestId: record.requestId,
    status: record.status,
    decision: record.decision,
    resolvedAt: record.resolvedAt,
    resolvedBy: record.resolvedBy,
    staleReason: record.staleReason,
    projectContext: record.projectContext,
    rejectPolicy: record.status === "rejected" ? rejectPolicy : undefined,
  };
}

function normalizeOperatorApprovalRecord(record: OperatorApprovalRecord): OperatorApprovalRecord {
  return {
    ...record,
    projectContext: normalizeProjectContextResolution(record.projectContext),
  };
}

function needsProjectContextBackfill(record: Record<string, unknown> | null): boolean {
  if (record === null) return false;
  if (!Object.prototype.hasOwnProperty.call(record, "projectContext") || record.projectContext === null) return true;
  if (typeof record.projectContext !== "object") return true;

  const projectContext = record.projectContext as Record<string, unknown>;
  return (
    !hasNonEmptyString(projectContext.projectContextId) ||
    !hasNonEmptyString(projectContext.projectContextLabel) ||
    !hasNonEmptyString(projectContext.routingSource) ||
    !Object.prototype.hasOwnProperty.call(projectContext, "linearProjectSlug") ||
    !hasNullableString(projectContext.linearProjectSlug)
  );
}

function projectContextBackfillSource(
  record: Record<string, unknown> | null,
  runProjectContext: ProjectContextResolution | undefined,
  existingProjectContext: ProjectContextResolution | undefined,
): ProjectContextResolution {
  if (runProjectContext) return normalizeProjectContextResolution(runProjectContext);
  const recordProjectContext = readProjectContextRecord(record);
  if (recordProjectContext) return normalizeProjectContextResolution(recordProjectContext);
  return normalizeProjectContextResolution(existingProjectContext);
}

function readProjectContextRecord(record: Record<string, unknown> | null): Partial<ProjectContextResolution> | undefined {
  if (record === null || typeof record.projectContext !== "object" || record.projectContext === null) {
    return undefined;
  }
  return record.projectContext as Partial<ProjectContextResolution>;
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function matchesProjectContext(
  recordProjectContext: ProjectContextResolution | undefined,
  expectedProjectContext: ProjectContextResolution | undefined,
): boolean {
  if (!expectedProjectContext) return true;
  return normalizeProjectContextResolution(recordProjectContext).projectContextId === normalizeProjectContextResolution(expectedProjectContext).projectContextId;
}

function dedupeKey(runId: string, evidenceCursor: string): string {
  return `${runId}:${evidenceCursor}:push_and_pr`;
}

function requestIdFor(value: string): string {
  return `approval_${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function latestPending(records: OperatorApprovalRecord[]): OperatorApprovalRecord | null {
  return (
    records
      .filter((record) => record.status === "pending")
      .sort((left, right) => Date.parse(right.requestedAt) - Date.parse(left.requestedAt))[0] ?? null
  );
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_") || "approval";
}

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (!(error instanceof SyntaxError) || attempt === 2) throw error;
      await sleep(5);
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function operatorApprovalConfig(config: ServiceConfig) {
  return (
    config.github.operatorApproval ?? {
      requiredForPublication: false,
      rejectPolicy: "cancel" as const,
      pollIntervalMs: 2_000,
      timeoutMs: null,
    }
  );
}

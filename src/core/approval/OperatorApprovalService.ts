import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { serviceConfigForProjectContext, type ServiceConfig } from "../config/Config.js";
import {
  DEFAULT_PROJECT_CONTEXT_ID,
  DEFAULT_PROJECT_CONTEXT_LABEL,
  normalizeProjectContextResolution,
  type ProjectContextResolution,
} from "../config/ProjectContexts.js";
import { SymphonyError } from "../errors.js";
import { FileIssueLifecycleStore } from "../persistence/IssueLifecycleStore.js";
import { FileRunTranscriptStore, type RunTranscriptStore, type TranscriptEvent } from "../persistence/RunTranscriptStore.js";

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
  projectContextId?: string;
  projectContextLabel?: string | null;
  projectContext?: ProjectContextResolution | null;
}

export interface OperatorApprovalResolution {
  request: OperatorApprovalRecord;
  replayed: boolean;
}

export interface OperatorApprovalRequestInput {
  issueId: string;
  issueIdentifier: string;
  runId: string;
  evidenceCursor: string;
  action: OperatorApprovalAction;
  projectContextId?: string;
  projectContextLabel?: string | null;
  projectContext?: ProjectContextResolution | null;
}

export const OPERATOR_REJECTED_PUBLICATION_ERROR = "Operator rejected push/PR publication";

export class FileOperatorApprovalStore {
  constructor(private readonly stateDir: string) {}

  async requestOrGetPending(input: OperatorApprovalRequestInput, timeoutMs: number | null): Promise<{ record: OperatorApprovalRecord; created: boolean }> {
    await fs.mkdir(this.recordsDir(), { recursive: true });
    const existing = await this.getByDedupe(input.runId, input.evidenceCursor);
    if (existing) return { record: existing, created: false };

    const requestedAt = new Date().toISOString();
    const requestId = requestIdFor(dedupeKey(input.runId, input.evidenceCursor));
    const activeRun = await new FileRunTranscriptStore(this.stateDir).getRun(input.runId).catch(() => null);
    const lifecycle =
      (await new FileIssueLifecycleStore(this.stateDir).get(input.issueId).catch(() => null)) ??
      (input.issueIdentifier ? await new FileIssueLifecycleStore(this.stateDir).get(input.issueIdentifier).catch(() => null) : null);
    const resolvedProjectContext =
      input.projectContext ?? lifecycle?.projectContext ?? lifecycle?.summaryPointers.projectContext ?? activeRun?.projectContext ?? undefined;
    const projectContextId = resolvedProjectContext?.projectContextId ?? input.projectContextId ?? DEFAULT_PROJECT_CONTEXT_ID;
    const projectContextLabel =
      resolvedProjectContext?.projectContextLabel ?? input.projectContextLabel ?? defaultProjectContextLabel(projectContextId);
    const projectContext = normalizeStoredProjectContext(resolvedProjectContext, projectContextId, projectContextLabel);
    const record: OperatorApprovalRecord = {
      requestId,
      status: "pending",
      issueId: input.issueId,
      issueIdentifier: input.issueIdentifier,
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
      projectContextId,
      ...(projectContextLabel === undefined ? {} : { projectContextLabel }),
      ...(projectContext === null ? {} : { projectContext }),
    };
    await this.write(record);
    return { record, created: true };
  }

  async get(requestId: string): Promise<OperatorApprovalRecord | null> {
    const record = await readJsonIfExists<OperatorApprovalRecord>(this.recordPath(requestId));
    return record ? this.repairProjectContext(record) : null;
  }

  async getByDedupe(runId: string, evidenceCursor: string): Promise<OperatorApprovalRecord | null> {
    return this.get(requestIdFor(dedupeKey(runId, evidenceCursor)));
  }

  async findPendingForRun(runId: string): Promise<OperatorApprovalRecord | null> {
    const records = await this.list();
    return latestPending(records.filter((record) => record.runId === runId));
  }

  async findPendingForIssue(keys: string[], projectContext?: ProjectContextResolution | null): Promise<OperatorApprovalRecord | null> {
    const normalized = new Set(keys.map((key) => key.toLowerCase()));
    const records = await this.list();
    const filtered = records.filter(
      (record) => normalized.has(record.issueId.toLowerCase()) || normalized.has(record.issueIdentifier.toLowerCase()),
    );
    if (!projectContext) return latestPending(filtered);
    return latestPending(filtered.filter((record) => (record.projectContext?.projectContextId ?? record.projectContextId) === projectContext.projectContextId));
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
          .map((record) => this.repairProjectContext(record)),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async resolve(requestId: string, decision: OperatorApprovalDecision): Promise<OperatorApprovalResolution> {
    const existing = await this.get(requestId);
    if (!existing) throw new SymphonyError("not_found", `Approval request not found: ${requestId}`);
    if (existing.status === "approved" || existing.status === "rejected") {
      if ((existing.status === "approved" && decision === "approve") || (existing.status === "rejected" && decision === "reject")) {
        return { request: existing, replayed: true };
      }
      throw new SymphonyError("conflict", `Approval request is already ${existing.status}`);
    }
    if (existing.status !== "pending") {
      throw new SymphonyError("conflict", `Approval request is ${existing.status}`);
    }
    const resolved = await this.markTerminal(existing, decision === "approve" ? "approved" : "rejected", {
      decision,
      resolvedBy: "operator",
    });
    return { request: resolved, replayed: false };
  }

  async markStale(requestId: string, reason: string): Promise<OperatorApprovalRecord> {
    const existing = await this.require(requestId);
    if (existing.status !== "pending") return existing;
    return this.markTerminal(existing, "stale", { staleReason: reason, resolvedBy: "system" });
  }

  async markExpired(requestId: string): Promise<OperatorApprovalRecord> {
    const existing = await this.require(requestId);
    if (existing.status !== "pending") return existing;
    return this.markTerminal(existing, "expired", { staleReason: "approval request expired", resolvedBy: "system" });
  }

  async markCancelled(requestId: string, reason: string): Promise<OperatorApprovalRecord> {
    const existing = await this.require(requestId);
    if (existing.status !== "pending") return existing;
    return this.markTerminal(existing, "cancelled", { staleReason: reason, resolvedBy: "system" });
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
    const resolved: OperatorApprovalRecord = {
      ...record,
      status,
      decision: patch.decision ?? record.decision,
      resolvedBy: patch.resolvedBy ?? record.resolvedBy,
      staleReason: patch.staleReason ?? record.staleReason,
      resolvedAt: new Date().toISOString(),
    };
    await this.write(resolved);
    return resolved;
  }

  private async write(record: OperatorApprovalRecord): Promise<void> {
    await fs.mkdir(this.recordsDir(), { recursive: true });
    await fs.writeFile(this.recordPath(record.requestId), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  }

  private recordsDir(): string {
    return path.join(this.stateDir, "approval-requests");
  }

  private async repairProjectContext(record: OperatorApprovalRecord): Promise<OperatorApprovalRecord> {
    const normalized = normalizeOperatorApprovalRecord(record);
    if (normalized.projectContext?.linearProjectSlug !== null && normalized.projectContext?.linearProjectSlug !== undefined) {
      return normalized;
    }
    if (record.projectContextId === undefined && record.projectContextLabel === undefined && record.projectContext !== undefined) {
      return normalized;
    }
    const run = await new FileRunTranscriptStore(this.stateDir).getRun(normalized.runId).catch(() => null);
    const lifecycle =
      (await new FileIssueLifecycleStore(this.stateDir).get(normalized.issueId).catch(() => null)) ??
      (normalized.issueIdentifier ? await new FileIssueLifecycleStore(this.stateDir).get(normalized.issueIdentifier).catch(() => null) : null);
    const runProjectContext = lifecycle?.projectContext ?? lifecycle?.summaryPointers.projectContext ?? run?.projectContext;
    if (!runProjectContext) return normalized;
    const repaired = normalizeOperatorApprovalRecord({
      ...normalized,
      projectContextId: runProjectContext.projectContextId,
      projectContextLabel: runProjectContext.projectContextLabel,
      projectContext: runProjectContext,
    });
    if (JSON.stringify(repaired) !== JSON.stringify(normalized)) {
      await this.write(repaired);
    }
    return repaired;
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
    return this.rejectPolicyForProjectContext();
  }

  rejectPolicyForProjectContext(projectContextId?: string | null): OperatorApprovalRejectPolicy {
    return operatorApprovalConfig(this.options.config, projectContextId).rejectPolicy;
  }

  async requestPublicationApproval(input: OperatorApprovalRequestInput): Promise<OperatorApprovalRecord> {
    const activeRun = await this.getRun(input.runId);
    const activeProjectContext = input.projectContext ?? activeRun?.projectContext ?? undefined;
    const resolvedInput: OperatorApprovalRequestInput = {
      ...input,
      ...(activeProjectContext === undefined ? {} : { projectContext: activeProjectContext }),
      ...(input.projectContextId === undefined && activeProjectContext !== undefined
        ? { projectContextId: activeProjectContext.projectContextId }
        : {}),
      ...(input.projectContextLabel === undefined && activeProjectContext !== undefined
        ? { projectContextLabel: activeProjectContext.projectContextLabel }
        : {}),
    };
    const policyContextId = this.effectivePolicyContextId(resolvedInput.projectContextId ?? resolvedInput.projectContext?.projectContextId);
    if (!this.isRequired(policyContextId)) {
      return {
        requestId: "",
        status: "approved",
        issueId: resolvedInput.issueId,
        issueIdentifier: resolvedInput.issueIdentifier,
        runId: resolvedInput.runId,
        evidenceCursor: resolvedInput.evidenceCursor,
        dedupeKey: dedupeKey(resolvedInput.runId, resolvedInput.evidenceCursor),
        action: resolvedInput.action,
        requestedAt: new Date().toISOString(),
        expiresAt: null,
        resolvedAt: new Date().toISOString(),
        resolvedBy: "system",
        decision: "approve",
        staleReason: null,
        ...(resolvedInput.projectContextId === undefined ? {} : { projectContextId: resolvedInput.projectContextId }),
        ...(resolvedInput.projectContextLabel === undefined ? {} : { projectContextLabel: resolvedInput.projectContextLabel }),
        ...(resolvedInput.projectContext === undefined ? {} : { projectContext: resolvedInput.projectContext }),
      };
    }

    await this.staleOtherPendingRequests(resolvedInput.runId, resolvedInput.evidenceCursor);
    const { record, created } = await this.options.store.requestOrGetPending(
      resolvedInput,
      operatorApprovalConfig(this.options.config, policyContextId).timeoutMs,
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
      if (decision === "reject" && this.rejectPolicyForProjectContext(this.effectivePolicyContextId(result.request.projectContextId)) === "fail") {
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

  async findPendingForIssue(keys: string[], projectContext?: ProjectContextResolution | null): Promise<OperatorApprovalRecord | null> {
    return this.options.store.findPendingForIssue(keys, projectContext);
  }

  isRequired(projectContextId?: string | null): boolean {
    const config = serviceConfigForProjectContext(this.options.config, projectContextId);
    return config.github.publishPullRequests && operatorApprovalConfig(this.options.config, projectContextId).requiredForPublication;
  }

  private effectivePolicyContextId(projectContextId?: string | null): string | undefined {
    if (projectContextId === undefined || projectContextId === null) return undefined;
    if (projectContextId === DEFAULT_PROJECT_CONTEXT_ID) return projectContextId;
    return this.options.config.projectContexts.byId.has(projectContextId) ? projectContextId : undefined;
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

      await sleep(operatorApprovalConfig(this.options.config, this.effectivePolicyContextId(current.projectContextId)).pollIntervalMs);
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
      payload: approvalResolvedPayload(record, operatorApprovalConfig(this.options.config, this.effectivePolicyContextId(record.projectContextId)).rejectPolicy),
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
    dedupeKey: { runId: record.runId, evidenceCursor: record.evidenceCursor },
    requestedAt: record.requestedAt,
    expiresAt: record.expiresAt,
    ...(record.projectContext === undefined ? {} : { projectContext: record.projectContext }),
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
    ...(record.projectContext === undefined ? {} : { projectContext: record.projectContext }),
    rejectPolicy: record.status === "rejected" ? rejectPolicy : undefined,
  };
}

function dedupeKey(runId: string, evidenceCursor: string): string {
  return `${runId}:${evidenceCursor}:push_and_pr`;
}

function requestIdFor(value: string): string {
  return `approval_${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function normalizeOperatorApprovalRecord(record: OperatorApprovalRecord): OperatorApprovalRecord {
  const projectContextId = record.projectContextId ?? DEFAULT_PROJECT_CONTEXT_ID;
  const projectContextLabel = record.projectContextLabel ?? defaultProjectContextLabel(projectContextId);
  const projectContext = normalizeStoredProjectContext(
    record.projectContextId === undefined && record.projectContextLabel === undefined ? undefined : record.projectContext,
    projectContextId,
    projectContextLabel,
  );
  return {
    ...record,
    projectContextId,
    ...(projectContextLabel === undefined ? {} : { projectContextLabel }),
    ...(projectContext === null ? {} : { projectContext }),
  };
}

function defaultProjectContextLabel(projectContextId: string): string | null {
  return projectContextId === DEFAULT_PROJECT_CONTEXT_ID ? DEFAULT_PROJECT_CONTEXT_LABEL : null;
}

function normalizeStoredProjectContext(
  projectContext: Partial<ProjectContextResolution> | null | undefined,
  projectContextId: string | undefined,
  projectContextLabel: string | null | undefined,
): ProjectContextResolution | null {
  const resolvedId = projectContext?.projectContextId ?? projectContextId;
  if (!resolvedId) return null;
  const base = {
    ...(projectContext ?? {}),
    projectContextId: resolvedId,
    ...(projectContext?.projectContextLabel !== undefined
      ? { projectContextLabel: projectContext.projectContextLabel }
      : projectContextLabel === undefined || projectContextLabel === null
        ? {}
        : { projectContextLabel }),
  };
  const normalized = normalizeProjectContextResolution(base);
  return projectContextLabel === null && projectContext?.projectContextLabel === undefined
    ? ({ ...normalized, projectContextLabel: null } as unknown as ProjectContextResolution)
    : normalized;
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

function operatorApprovalConfig(config: ServiceConfig, projectContextId?: string | null) {
  return (
    serviceConfigForProjectContext(config, projectContextId).github.operatorApproval ?? {
      requiredForPublication: false,
      rejectPolicy: "cancel" as const,
      pollIntervalMs: 2_000,
      timeoutMs: null,
    }
  );
}

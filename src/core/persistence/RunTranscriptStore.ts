import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { runKindForPhase, type AgentRunKind, type AgentRunPhase, type AgentRunRole, type TokenCounts } from "../types.js";
import { projectTranscriptEventForPublicRead } from "../transcript/TranscriptProjection.js";

export type RunStatus = "running" | "succeeded" | "failed" | "cancelled";
export type PersistedRunCancellationSource = "operator" | "state_change" | "stalled" | "service_stop";
export type PersistedCancelFailedSource = "harness_stop" | "cancel_ignored";
export type PersistedCancellationOutcome = "none" | "requested" | "cancelled" | "harness_stop_failed" | "cancel_ignored";
export type PersistedSdkRunStatus = "running" | "finished" | "error" | "cancelled";
export type PersistedSdkRunStatusSource = "initial" | "onDidChangeStatus" | "wait";

export interface RunActivitySnapshot {
  lastHarnessActivityAt: string | null;
  lastStreamActivityAt: string | null;
  lastDeltaOrToolActivityAt: string | null;
  lastToolActivityAt: string | null;
}

export interface PersistedCursorModelParam {
  id: string;
  value: string;
}

export interface WorkspaceRecord {
  workspaceKey: string;
  issueId: string | null;
  issueIdentifier: string;
  path: string;
  sourceKind: string;
  repoPath?: string;
  baseRef?: string;
  gitBranchName?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunMetadata {
  prUrl?: string | null;
  prNumber?: number | null;
  prHeadSha?: string | null;
  prBranch?: string | null;
  ciStatus?: string | null;
  lastPushedAt?: string | null;
  lastEvidenceCursor?: string | null;
  gitBranchName?: string | null;
  repoPath?: string | null;
  baseRef?: string | null;
  cancellationRequestedAt?: string | null;
  cancellationSource?: PersistedRunCancellationSource | null;
  cancellationReason?: string | null;
  harnessStopRequestedAt?: string | null;
  harnessStopFailedAt?: string | null;
  harnessStopFailedReason?: string | null;
  cancellationOutcome?: PersistedCancellationOutcome;
  cancelFailed?: boolean;
  cancelFailedAt?: string | null;
  cancelFailedReason?: string | null;
  cancelFailedSource?: PersistedCancelFailedSource | null;
  activitySnapshot?: RunActivitySnapshot;
  sdkRunStatus?: PersistedSdkRunStatus | null;
  sdkRunStatusObservedAt?: string | null;
  sdkRunStatusSource?: PersistedSdkRunStatusSource | null;
  failureKind?: string | null;
  failureDiagnosticCode?: string | null;
  failureDiagnosticMessage?: string | null;
  failureDiagnosticAt?: string | null;
  failureDiagnosticPayload?: unknown;
  pendingApprovalRequestId?: string | null;
  pendingApprovalRequestedAt?: string | null;
}

export interface RunRecord {
  runId: string;
  sessionId: string | null;
  agentId: string | null;
  role: AgentRunRole;
  runPhase?: AgentRunPhase;
  runKind?: AgentRunKind;
  issueId: string;
  issueIdentifier: string;
  attempt: number | null;
  turnNumber: number;
  prompt: string;
  promptCharCount?: number;
  cursorModel?: string | null;
  cursorModelParams?: PersistedCursorModelParam[];
  cursorSettingSources?: string[];
  cursorMode?: string | null;
  cursorAllowLargeContext?: boolean;
  cursorWorkerAgentLifecycle?: string;
  workspaceKey: string;
  workspacePath: string;
  gitBranchName?: string | null;
  repoPath?: string | null;
  baseRef?: string | null;
  status: RunStatus;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
  tokens: TokenCounts;
  transcriptEventCount?: number;
  prUrl?: string | null;
  prNumber?: number | null;
  prHeadSha?: string | null;
  prBranch?: string | null;
  ciStatus?: string | null;
  lastPushedAt?: string | null;
  lastEvidenceCursor?: string | null;
  cancellationRequestedAt?: string | null;
  cancellationSource?: PersistedRunCancellationSource | null;
  cancellationReason?: string | null;
  harnessStopRequestedAt?: string | null;
  harnessStopFailedAt?: string | null;
  harnessStopFailedReason?: string | null;
  cancellationOutcome?: PersistedCancellationOutcome;
  cancelFailed?: boolean;
  cancelFailedAt?: string | null;
  cancelFailedReason?: string | null;
  cancelFailedSource?: PersistedCancelFailedSource | null;
  activitySnapshot?: RunActivitySnapshot;
  sdkRunStatus?: PersistedSdkRunStatus | null;
  sdkRunStatusObservedAt?: string | null;
  sdkRunStatusSource?: PersistedSdkRunStatusSource | null;
  failureKind?: string | null;
  failureDiagnosticCode?: string | null;
  failureDiagnosticMessage?: string | null;
  failureDiagnosticAt?: string | null;
  failureDiagnosticPayload?: unknown;
  pendingApprovalRequestId?: string | null;
  pendingApprovalRequestedAt?: string | null;
}

export interface TranscriptEvent {
  runId: string;
  sequence: number;
  at: string;
  source: "harness" | "cursor" | "orchestrator";
  eventType: string;
  message?: string;
  payload?: unknown;
}

export interface TranscriptPage {
  runId: string;
  offset: number;
  limit: number;
  nextOffset: number | null;
  events: TranscriptEvent[];
}

export interface StartRunInput {
  runId: string;
  sessionId?: string | null;
  agentId?: string | null;
  role: AgentRunRole;
  runPhase?: AgentRunPhase;
  runKind?: AgentRunKind;
  issueId: string;
  issueIdentifier: string;
  attempt: number | null;
  turnNumber: number;
  prompt: string;
  cursorModel?: string | null;
  cursorModelParams?: PersistedCursorModelParam[];
  cursorSettingSources?: string[];
  cursorMode?: string | null;
  cursorAllowLargeContext?: boolean;
  cursorWorkerAgentLifecycle?: string;
  workspaceKey: string;
  workspacePath: string;
  gitBranchName?: string;
  repoPath?: string;
  baseRef?: string;
}

export interface UpdateRunInput {
  sessionId?: string | null;
  agentId?: string | null;
  status?: RunStatus;
  completedAt?: string | null;
  error?: string | null;
  tokens?: TokenCounts;
  metadata?: RunMetadata;
}

export interface PullRequestTranscriptInput extends RunMetadata {
  runId: string;
  action: "opened" | "updated";
  at?: string;
}

export interface CiStatusTranscriptInput extends RunMetadata {
  runId: string;
  ciStatus: string | null;
  at?: string;
}

export class FileRunTranscriptStore {
  private readonly runUpdateLocks = new Map<string, Promise<void>>();

  constructor(private readonly stateDir: string) {}

  async upsertWorkspace(record: WorkspaceRecord): Promise<void> {
    await fs.mkdir(this.workspacesDir(), { recursive: true });
    const existing = await this.getWorkspace(record.workspaceKey);
    await writeJson(this.workspacePath(record.workspaceKey), {
      ...record,
      createdAt: existing?.createdAt ?? record.createdAt,
      updatedAt: record.updatedAt,
    });
  }

  async getWorkspace(workspaceKey: string): Promise<WorkspaceRecord | null> {
    return readJsonIfExists<WorkspaceRecord>(this.workspacePath(workspaceKey));
  }

  async deleteWorkspace(workspaceKey: string): Promise<void> {
    await fs.rm(this.workspacePath(workspaceKey), { force: true });
  }

  async listWorkspaces(): Promise<WorkspaceRecord[]> {
    await fs.mkdir(this.workspacesDir(), { recursive: true });
    const entries = await fs.readdir(this.workspacesDir());
    const records = await Promise.all(
      entries.filter((entry) => entry.endsWith(".json")).map((entry) => readJsonIfExists<WorkspaceRecord>(path.join(this.workspacesDir(), entry))),
    );
    return records.filter((record): record is WorkspaceRecord => record !== null);
  }

  async findWorkspace(issueIdOrIdentifierOrKey: string): Promise<WorkspaceRecord | null> {
    const direct = await this.getWorkspace(issueIdOrIdentifierOrKey);
    if (direct) return direct;
    const records = await this.listWorkspaces();
    return (
      records.find(
        (record) =>
          record.issueId === issueIdOrIdentifierOrKey ||
          record.issueIdentifier === issueIdOrIdentifierOrKey ||
          record.workspaceKey === issueIdOrIdentifierOrKey,
      ) ?? null
    );
  }

  async startRun(input: StartRunInput): Promise<RunRecord> {
    const now = new Date().toISOString();
    const existing = await this.getRun(input.runId);
    const record: RunRecord = {
      ...existing,
      runId: input.runId,
      sessionId: input.sessionId ?? existing?.sessionId ?? null,
      agentId: input.agentId ?? existing?.agentId ?? null,
      role: input.role,
      runPhase: input.runPhase ?? existing?.runPhase ?? defaultRunPhase(input.role),
      runKind: input.runKind ?? existing?.runKind ?? runKindForPhase(input.runPhase ?? existing?.runPhase ?? defaultRunPhase(input.role)),
      issueId: input.issueId,
      issueIdentifier: input.issueIdentifier,
      attempt: input.attempt,
      turnNumber: input.turnNumber,
      prompt: promptPreview(input.prompt),
      promptCharCount: input.prompt.length,
      ...(input.cursorModel === undefined ? {} : { cursorModel: input.cursorModel }),
      ...(input.cursorModelParams === undefined ? {} : { cursorModelParams: input.cursorModelParams }),
      ...(input.cursorSettingSources === undefined ? {} : { cursorSettingSources: input.cursorSettingSources }),
      ...(input.cursorMode === undefined ? {} : { cursorMode: input.cursorMode }),
      ...(input.cursorAllowLargeContext === undefined ? {} : { cursorAllowLargeContext: input.cursorAllowLargeContext }),
      ...(input.cursorWorkerAgentLifecycle === undefined ? {} : { cursorWorkerAgentLifecycle: input.cursorWorkerAgentLifecycle }),
      workspaceKey: input.workspaceKey,
      workspacePath: input.workspacePath,
      ...(input.gitBranchName === undefined ? {} : { gitBranchName: input.gitBranchName }),
      ...(input.repoPath === undefined ? {} : { repoPath: input.repoPath }),
      ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
      status: existing?.status ?? "running",
      startedAt: existing?.startedAt ?? now,
      updatedAt: now,
      completedAt: existing?.completedAt ?? null,
      error: existing?.error ?? null,
      tokens: existing?.tokens ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      transcriptEventCount: existing?.transcriptEventCount ?? 0,
    };
    await this.writeRun(record);
    return record;
  }

  async updateRun(runId: string, input: UpdateRunInput): Promise<RunRecord | null> {
    return this.withRunUpdateLock(runId, async () => {
      const existing = await this.getRun(runId);
      if (!existing) return null;
      const updated: RunRecord = {
        ...existing,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.completedAt === undefined ? {} : { completedAt: input.completedAt }),
        ...(input.error === undefined ? {} : { error: input.error }),
        ...(input.tokens === undefined ? {} : { tokens: input.tokens }),
        ...metadataPatch(input.metadata),
        updatedAt: new Date().toISOString(),
      };
      await this.writeRun(updated);
      return updated;
    });
  }

  async recordPullRequestEvent(input: PullRequestTranscriptInput): Promise<TranscriptEvent | null> {
    const updated = await this.updateRun(input.runId, { metadata: input });
    if (!updated) return null;
    return this.appendEvent({
      runId: input.runId,
      at: input.at ?? new Date().toISOString(),
      source: "orchestrator",
      eventType: input.action === "opened" ? "pr_opened" : "pr_updated",
      message: formatPullRequestMessage(input),
      payload: metadataPayload(input),
    });
  }

  async recordCiStatusEvent(input: CiStatusTranscriptInput): Promise<TranscriptEvent | null> {
    const updated = await this.updateRun(input.runId, { metadata: input });
    if (!updated) return null;
    return this.appendEvent({
      runId: input.runId,
      at: input.at ?? new Date().toISOString(),
      source: "orchestrator",
      eventType: "ci_status_changed",
      message: input.ciStatus === null ? "CI status cleared" : `CI status changed to ${input.ciStatus}`,
      payload: metadataPayload(input),
    });
  }

  async appendEvent(input: Omit<TranscriptEvent, "sequence"> & { sequence?: number }): Promise<TranscriptEvent> {
    return this.withRunUpdateLock(input.runId, async () => {
      await fs.mkdir(this.runDir(input.runId), { recursive: true });
      const count = await this.ensureTranscriptEventCountUnlocked(input.runId);
      const sequence = input.sequence ?? count + 1;
      const event: TranscriptEvent = {
        ...input,
        sequence,
        payload: sanitizeJson(input.payload),
      };
      await fs.appendFile(this.eventsPath(input.runId), `${JSON.stringify(event)}\n`, "utf8");
      const record = await this.getRun(input.runId);
      if (record) await this.writeRun({ ...record, transcriptEventCount: count + 1, updatedAt: new Date().toISOString() });
      return event;
    });
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const record = await readJsonIfExists<RunRecord>(this.metaPath(runId));
    return record === null ? null : normalizeRunRecord(record);
  }

  async listRunsForIssue(issueIdOrIdentifier: string): Promise<RunRecord[]> {
    const records = await this.listRuns();
    return records
      .filter((record) => record.issueId === issueIdOrIdentifier || record.issueIdentifier === issueIdOrIdentifier)
      .sort(compareRunChronology);
  }

  async latestRunForIssue(
    issueIdOrIdentifier: string,
    options: { role?: AgentRunRole; runPhase?: AgentRunPhase; runKind?: AgentRunKind } = {},
  ): Promise<RunRecord | null> {
    const records = await this.listRunsForIssue(issueIdOrIdentifier);
    const filtered = records.filter(
      (record) =>
        (options.role === undefined || record.role === options.role) &&
        (options.runPhase === undefined || record.runPhase === options.runPhase) &&
        (options.runKind === undefined || record.runKind === options.runKind),
    );
    return filtered[filtered.length - 1] ?? null;
  }

  async readTranscript(runId: string, options: { offset?: number; limit?: number } = {}): Promise<TranscriptPage> {
    const offset = Math.max(options.offset ?? 0, 0);
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 1_000);
    const total = await this.readTranscriptEventCount(runId);
    const events = (await readJsonlPage<TranscriptEvent>(this.eventsPath(runId), offset, limit)).map(projectTranscriptEventForPublicRead);
    const nextOffset = offset + events.length < total ? offset + events.length : null;
    return { runId, offset, limit, nextOffset, events };
  }

  async readTranscriptEventCount(runId: string): Promise<number> {
    const record = await this.getRun(runId);
    if (typeof record?.transcriptEventCount === "number") return record.transcriptEventCount;
    return countJsonlLines(this.eventsPath(runId));
  }

  async ensureTranscriptEventCount(runId: string): Promise<number> {
    return this.withRunUpdateLock(runId, () => this.ensureTranscriptEventCountUnlocked(runId));
  }

  async listRuns(): Promise<RunRecord[]> {
    await fs.mkdir(this.runsDir(), { recursive: true });
    const entries = await fs.readdir(this.runsDir());
    const records = await Promise.all(entries.map((entry) => readJsonIfExists<RunRecord>(this.metaPath(entry))));
    return records.filter((record): record is RunRecord => record !== null).map(normalizeRunRecord);
  }

  private async writeRun(record: RunRecord): Promise<void> {
    await fs.mkdir(this.runDir(record.runId), { recursive: true });
    await writeJson(this.metaPath(record.runId), record);
  }

  private async withRunUpdateLock<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.runUpdateLocks.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.catch(() => undefined).then(() => current);
    this.runUpdateLocks.set(runId, chained);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.runUpdateLocks.get(runId) === chained) this.runUpdateLocks.delete(runId);
    }
  }

  private async ensureTranscriptEventCountUnlocked(runId: string): Promise<number> {
    const record = await this.getRun(runId);
    if (typeof record?.transcriptEventCount === "number") return record.transcriptEventCount;
    const count = await countJsonlLines(this.eventsPath(runId));
    if (record) await this.writeRun({ ...record, transcriptEventCount: count });
    return count;
  }

  private workspacesDir(): string {
    return path.join(this.stateDir, "workspaces");
  }

  private workspacePath(workspaceKey: string): string {
    return path.join(this.workspacesDir(), `${safeFileName(workspaceKey)}.json`);
  }

  private runsDir(): string {
    return path.join(this.stateDir, "runs");
  }

  private runDir(runId: string): string {
    return path.join(this.runsDir(), safeFileName(runId));
  }

  private metaPath(runId: string): string {
    return path.join(this.runDir(runId), "meta.json");
  }

  private eventsPath(runId: string): string {
    return path.join(this.runDir(runId), "events.jsonl");
  }
}

export type RunTranscriptStore = FileRunTranscriptStore;

export function compareRunChronology(left: RunRecord, right: RunRecord): number {
  return (
    compareNumber(Date.parse(left.startedAt), Date.parse(right.startedAt)) ||
    compareString(left.startedAt, right.startedAt) ||
    compareNullableNumber(left.attempt, right.attempt) ||
    compareNumber(left.turnNumber, right.turnNumber) ||
    compareString(left.runId, right.runId)
  );
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_") || "record";
}

function compareNumber(left: number, right: number): number {
  if (Number.isNaN(left) && Number.isNaN(right)) return 0;
  if (Number.isNaN(left)) return -1;
  if (Number.isNaN(right)) return 1;
  return left - right;
}

function compareNullableNumber(left: number | null, right: number | null): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return compareNumber(left, right);
}

function compareString(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function promptPreview(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  return oneLine.length <= 240 ? oneLine : `${oneLine.slice(0, 225)}...[truncated]`;
}

function normalizeRunRecord(record: RunRecord): RunRecord {
  const runPhase = record.runPhase ?? defaultRunPhase(record.role);
  return {
    ...record,
    runPhase,
    runKind: record.runKind ?? runKindForPhase(runPhase),
  };
}

function defaultRunPhase(role: AgentRunRole): AgentRunPhase {
  return role === "reviewer" ? "review" : "implementation";
}

function metadataPatch(metadata: RunMetadata | undefined): Partial<RunRecord> {
  if (!metadata) return {};
  return {
    ...(metadata.prUrl === undefined ? {} : { prUrl: metadata.prUrl }),
    ...(metadata.prNumber === undefined ? {} : { prNumber: metadata.prNumber }),
    ...(metadata.prHeadSha === undefined ? {} : { prHeadSha: metadata.prHeadSha }),
    ...(metadata.prBranch === undefined ? {} : { prBranch: metadata.prBranch }),
    ...(metadata.ciStatus === undefined ? {} : { ciStatus: metadata.ciStatus }),
    ...(metadata.lastPushedAt === undefined ? {} : { lastPushedAt: metadata.lastPushedAt }),
    ...(metadata.lastEvidenceCursor === undefined ? {} : { lastEvidenceCursor: metadata.lastEvidenceCursor }),
    ...(metadata.gitBranchName === undefined ? {} : { gitBranchName: metadata.gitBranchName }),
    ...(metadata.repoPath === undefined ? {} : { repoPath: metadata.repoPath }),
    ...(metadata.baseRef === undefined ? {} : { baseRef: metadata.baseRef }),
    ...(metadata.cancellationRequestedAt === undefined ? {} : { cancellationRequestedAt: metadata.cancellationRequestedAt }),
    ...(metadata.cancellationSource === undefined ? {} : { cancellationSource: metadata.cancellationSource }),
    ...(metadata.cancellationReason === undefined ? {} : { cancellationReason: metadata.cancellationReason }),
    ...(metadata.harnessStopRequestedAt === undefined ? {} : { harnessStopRequestedAt: metadata.harnessStopRequestedAt }),
    ...(metadata.harnessStopFailedAt === undefined ? {} : { harnessStopFailedAt: metadata.harnessStopFailedAt }),
    ...(metadata.harnessStopFailedReason === undefined ? {} : { harnessStopFailedReason: metadata.harnessStopFailedReason }),
    ...(metadata.cancellationOutcome === undefined ? {} : { cancellationOutcome: metadata.cancellationOutcome }),
    ...(metadata.cancelFailed === undefined ? {} : { cancelFailed: metadata.cancelFailed }),
    ...(metadata.cancelFailedAt === undefined ? {} : { cancelFailedAt: metadata.cancelFailedAt }),
    ...(metadata.cancelFailedReason === undefined ? {} : { cancelFailedReason: metadata.cancelFailedReason }),
    ...(metadata.cancelFailedSource === undefined ? {} : { cancelFailedSource: metadata.cancelFailedSource }),
    ...(metadata.activitySnapshot === undefined ? {} : { activitySnapshot: metadata.activitySnapshot }),
    ...(metadata.sdkRunStatus === undefined ? {} : { sdkRunStatus: metadata.sdkRunStatus }),
    ...(metadata.sdkRunStatusObservedAt === undefined ? {} : { sdkRunStatusObservedAt: metadata.sdkRunStatusObservedAt }),
    ...(metadata.sdkRunStatusSource === undefined ? {} : { sdkRunStatusSource: metadata.sdkRunStatusSource }),
    ...(metadata.failureKind === undefined ? {} : { failureKind: metadata.failureKind }),
    ...(metadata.failureDiagnosticCode === undefined ? {} : { failureDiagnosticCode: metadata.failureDiagnosticCode }),
    ...(metadata.failureDiagnosticMessage === undefined ? {} : { failureDiagnosticMessage: metadata.failureDiagnosticMessage }),
    ...(metadata.failureDiagnosticAt === undefined ? {} : { failureDiagnosticAt: metadata.failureDiagnosticAt }),
    ...(metadata.failureDiagnosticPayload === undefined ? {} : { failureDiagnosticPayload: metadata.failureDiagnosticPayload }),
    ...(metadata.pendingApprovalRequestId === undefined ? {} : { pendingApprovalRequestId: metadata.pendingApprovalRequestId }),
    ...(metadata.pendingApprovalRequestedAt === undefined ? {} : { pendingApprovalRequestedAt: metadata.pendingApprovalRequestedAt }),
  };
}

function metadataPayload(metadata: RunMetadata): RunMetadata {
  return metadataPatch(metadata);
}

function formatPullRequestMessage(input: PullRequestTranscriptInput): string {
  const label = input.action === "opened" ? "opened" : "updated";
  const parts = [
    input.prNumber === undefined || input.prNumber === null ? null : `#${input.prNumber}`,
    input.prUrl === undefined || input.prUrl === null ? null : input.prUrl,
  ].filter((value): value is string => value !== null);
  return parts.length === 0 ? `PR ${label}` : `PR ${label}: ${parts.join(" ")}`;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  const previous = writeJsonLocks.get(filePath) ?? Promise.resolve();
  const write = previous.catch(() => undefined).then(() => writeJsonUnlocked(filePath, value));
  writeJsonLocks.set(filePath, write);
  try {
    await write;
  } finally {
    if (writeJsonLocks.get(filePath) === write) writeJsonLocks.delete(filePath);
  }
}

async function writeJsonUnlocked(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (process.platform === "win32") {
    await fs.copyFile(tempPath, filePath);
    await fs.rm(tempPath, { force: true });
    return;
  }
  await fs.rename(tempPath, filePath);
}

const writeJsonLocks = new Map<string, Promise<void>>();

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      const retryable = code === "EBUSY" || code === "EPERM" || error instanceof SyntaxError;
      if (!retryable || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  return null;
}

async function readJsonlPage<T>(filePath: string, offset: number, limit: number): Promise<T[]> {
  const events: T[] = [];
  let lineIndex = 0;
  try {
    const stream = createReadStream(filePath, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.length === 0) continue;
      if (lineIndex >= offset && events.length < limit) {
        events.push(JSON.parse(line) as T);
      }
      lineIndex += 1;
      if (events.length >= limit) {
        lines.close();
        stream.destroy();
        break;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return events;
}

async function countJsonlLines(filePath: string): Promise<number> {
  let count = 0;
  try {
    const stream = createReadStream(filePath, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.length > 0) count += 1;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  return count;
}

function sanitizeJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value);
  }
}

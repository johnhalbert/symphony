import { promises as fs } from "node:fs";
import path from "node:path";
import type { TokenCounts } from "../types.js";

export type RunStatus = "running" | "succeeded" | "failed" | "cancelled";

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

export interface RunRecord {
  runId: string;
  sessionId: string | null;
  agentId: string | null;
  issueId: string;
  issueIdentifier: string;
  attempt: number | null;
  turnNumber: number;
  prompt: string;
  workspaceKey: string;
  workspacePath: string;
  gitBranchName?: string;
  repoPath?: string;
  baseRef?: string;
  status: RunStatus;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
  tokens: TokenCounts;
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
  issueId: string;
  issueIdentifier: string;
  attempt: number | null;
  turnNumber: number;
  prompt: string;
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
}

export class FileRunTranscriptStore {
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
      issueId: input.issueId,
      issueIdentifier: input.issueIdentifier,
      attempt: input.attempt,
      turnNumber: input.turnNumber,
      prompt: input.prompt,
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
    };
    await this.writeRun(record);
    return record;
  }

  async updateRun(runId: string, input: UpdateRunInput): Promise<RunRecord | null> {
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
      updatedAt: new Date().toISOString(),
    };
    await this.writeRun(updated);
    return updated;
  }

  async appendEvent(input: Omit<TranscriptEvent, "sequence"> & { sequence?: number }): Promise<TranscriptEvent> {
    await fs.mkdir(this.runDir(input.runId), { recursive: true });
    const sequence = input.sequence ?? (await this.nextSequence(input.runId));
    const event: TranscriptEvent = {
      ...input,
      sequence,
      payload: sanitizeJson(input.payload),
    };
    await fs.appendFile(this.eventsPath(input.runId), `${JSON.stringify(event)}\n`, "utf8");
    return event;
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    return readJsonIfExists<RunRecord>(this.metaPath(runId));
  }

  async listRunsForIssue(issueIdOrIdentifier: string): Promise<RunRecord[]> {
    const records = await this.listRuns();
    return records
      .filter((record) => record.issueId === issueIdOrIdentifier || record.issueIdentifier === issueIdOrIdentifier)
      .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  }

  async latestRunForIssue(issueIdOrIdentifier: string): Promise<RunRecord | null> {
    const records = await this.listRunsForIssue(issueIdOrIdentifier);
    return records[records.length - 1] ?? null;
  }

  async readTranscript(runId: string, options: { offset?: number; limit?: number } = {}): Promise<TranscriptPage> {
    const offset = Math.max(options.offset ?? 0, 0);
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 1_000);
    const lines = await readLinesIfExists(this.eventsPath(runId));
    const events = lines
      .slice(offset, offset + limit)
      .map((line) => JSON.parse(line) as TranscriptEvent);
    const nextOffset = offset + events.length < lines.length ? offset + events.length : null;
    return { runId, offset, limit, nextOffset, events };
  }

  async listRuns(): Promise<RunRecord[]> {
    await fs.mkdir(this.runsDir(), { recursive: true });
    const entries = await fs.readdir(this.runsDir());
    const records = await Promise.all(entries.map((entry) => readJsonIfExists<RunRecord>(this.metaPath(entry))));
    return records.filter((record): record is RunRecord => record !== null);
  }

  private async writeRun(record: RunRecord): Promise<void> {
    await fs.mkdir(this.runDir(record.runId), { recursive: true });
    await writeJson(this.metaPath(record.runId), record);
  }

  private async nextSequence(runId: string): Promise<number> {
    const lines = await readLinesIfExists(this.eventsPath(runId));
    return lines.length + 1;
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

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_") || "record";
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readLinesIfExists(filePath: string): Promise<string[]> {
  try {
    const body = await fs.readFile(filePath, "utf8");
    return body.split(/\r?\n/).filter((line) => line.length > 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function sanitizeJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value);
  }
}

import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { runKindForPhase, type AgentRunKind, type AgentRunPhase, type AgentRunRole, type TokenCounts } from "../types.js";
import { projectTranscriptEventForPublicRead } from "../transcript/TranscriptProjection.js";
import type { ProviderLimitSignal } from "../provider/ProviderLimits.js";
import { isRunActivityCommandPolicyDecisionPayload } from "../runActivity/RunActivityEvent.js";
import { mapWithFileReadConcurrency } from "./FileReadConcurrency.js";
import { ProjectionRevisionNotifier, type ProjectionChangeListener, type ProjectionChangeUnsubscribe } from "./ProjectionRevision.js";

export type RunStatus = "running" | "succeeded" | "failed" | "cancelled";
export type PersistedRunRole = AgentRunRole | "planner";
export type PersistedRunCancellationSource = "operator" | "state_change" | "stalled" | "service_stop";
export type PersistedCancelFailedSource = "harness_stop" | "cancel_ignored";
export type PersistedCancellationOutcome = "none" | "requested" | "cancelled" | "harness_stop_failed" | "cancel_ignored";
export type PersistedSdkRunStatus = "running" | "finished" | "error" | "cancelled";
export type PersistedSdkRunStatusSource = "initial" | "onDidChangeStatus" | "wait";

const PLANNING_NO_PLAN_ERROR = "Planning run completed without submit_issue_breakdown_plan";
const PLANNING_FAILURE_DIAGNOSTIC_CODE = "planning_run_failed";

export interface RunActivitySnapshot {
  lastHarnessActivityAt: string | null;
  lastStreamActivityAt: string | null;
  lastDeltaOrToolActivityAt: string | null;
  lastToolActivityAt: string | null;
}

export interface PersistedCommandPolicyDecisionRecord {
  sequence: number;
  at: string;
  source: TranscriptEvent["source"];
  decisionId: string | null;
  attemptId: string | null;
  activityId: string | null;
  runId: string | null;
  issueId: string | null;
  surface: string;
  role: string;
  phase: string;
  outcome: "allow" | "deny";
  reasonKind: string;
  commandClass: string;
  message: string;
  upstreamContactAttempted: boolean;
  redacted: true;
  payloadSchema?: string;
  requiresCodeChange?: boolean;
  requiresUserOrServiceFix?: boolean;
  requestKind?: string | null;
  toolCallId?: string | null;
  selectedOptionId?: string | null;
  permissionOutcome?: string | null;
  hookAction?: string | null;
  normalizedCommand?: unknown;
  audit: unknown;
}

export interface PersistedMalformedCommandPolicyDecisionRecord {
  sequence: number;
  at: string;
  source: TranscriptEvent["source"];
  eventType: "command_policy_decision";
  payloadSchema?: string;
  payloadPresent: boolean;
  failureKind: "malformed_persisted_policy_data";
  safeOutcome: "deny";
  message: string;
  redacted: true;
}

export interface PersistedCommandPolicyReplayState {
  decisionCount: number;
  malformedEventCount: number;
  lastDecisionAt: string | null;
  lastMalformedAt: string | null;
  decisions: PersistedCommandPolicyDecisionRecord[];
  malformedEvents: PersistedMalformedCommandPolicyDecisionRecord[];
}

export interface PersistedCursorModelParam {
  id: string;
  value: string;
}

export type PersistedRuntimeModelParam = PersistedCursorModelParam;

export interface WorkspaceRecord {
  workspaceKey: string;
  issueId: string | null;
  issueIdentifier: string;
  path: string;
  sourceKind: string;
  repoPath?: string;
  baseRef?: string;
  gitBranchName?: string;
  projectContextId?: string | undefined;
  projectContextLabel?: string | undefined;
  trackerProjectSlug?: string | undefined;
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
  providerLimit?: ProviderLimitSignal | null;
  commandPolicy?: PersistedCommandPolicyReplayState;
}

export interface RunRecord {
  runId: string;
  sessionId: string | null;
  agentId: string | null;
  role: PersistedRunRole;
  runPhase?: AgentRunPhase;
  runKind?: AgentRunKind;
  issueId: string;
  issueIdentifier: string;
  attempt: number | null;
  turnNumber: number;
  prompt: string;
  promptCharCount?: number;
  harnessId?: string;
  runtimeModel?: string | null;
  runtimeModelParams?: PersistedRuntimeModelParam[];
  runtimeSettingSources?: string[];
  runtimeMode?: string | null;
  runtimeAllowLargeContext?: boolean;
  runtimeAgentLifecycle?: string;
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
  projectContextId?: string | null;
  projectContextLabel?: string | null;
  trackerProjectSlug?: string | null;
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
  providerLimit?: ProviderLimitSignal | null;
  commandPolicy?: PersistedCommandPolicyReplayState;
}

export interface TranscriptEvent {
  runId: string;
  sequence: number;
  at: string;
  source: "harness" | "runtime" | "cursor" | "orchestrator";
  eventType: string;
  message?: string;
  payload?: unknown;
  payloadSchema?: string;
  payloadTruncated?: boolean;
  payloadByteLength?: number;
  rawPayloadRefId?: number | string | null;
}

export interface TranscriptPage {
  runId: string;
  offset: number;
  limit: number;
  nextOffset: number | null;
  events: TranscriptEvent[];
  /** Total event count when the source can provide it without unbounded scanning. */
  total?: number | null;
  /** Number of source events represented by this window. Defaults to events.length. */
  eventCount?: number;
  /** Previous page/window offset for UI/API navigation, or null when this is the first window. */
  previousOffset?: number | null;
  hasPrevious?: boolean;
  hasNext?: boolean;
  windowKind?: "page" | "tail";
  firstSequence?: number | null;
  lastSequence?: number | null;
  lastEventAt?: string | null;
}

function transcriptPage(input: {
  runId: string;
  offset: number;
  limit: number;
  nextOffset: number | null;
  total: number;
  events: TranscriptEvent[];
  windowKind: "page" | "tail";
}): TranscriptPage {
  const firstEvent = input.events[0] ?? null;
  const lastEvent = input.events.at(-1) ?? null;
  const previousOffset = input.offset > 0 ? Math.max(0, input.offset - input.limit) : null;
  return {
    ...input,
    eventCount: input.events.length,
    previousOffset,
    hasPrevious: previousOffset !== null,
    hasNext: input.nextOffset !== null,
    firstSequence: firstEvent?.sequence ?? null,
    lastSequence: lastEvent?.sequence ?? null,
    lastEventAt: lastEvent?.at ?? null,
  };
}

export interface StartRunInput {
  runId: string;
  sessionId?: string | null;
  agentId?: string | null;
  role: PersistedRunRole;
  runPhase?: AgentRunPhase;
  runKind?: AgentRunKind;
  issueId: string;
  issueIdentifier: string;
  attempt: number | null;
  turnNumber: number;
  prompt: string;
  harnessId?: string;
  runtimeModel?: string | null;
  runtimeModelParams?: PersistedRuntimeModelParam[];
  runtimeSettingSources?: string[];
  runtimeMode?: string | null;
  runtimeAllowLargeContext?: boolean;
  runtimeAgentLifecycle?: string;
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
  projectContextId?: string | null;
  projectContextLabel?: string | null;
  trackerProjectSlug?: string | null;
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
  private readonly projectionNotifier = new ProjectionRevisionNotifier();

  constructor(private readonly stateDir: string) {}

  projectionRevision(): number {
    return this.projectionNotifier.currentRevision();
  }

  onProjectionChanged(listener: ProjectionChangeListener): ProjectionChangeUnsubscribe {
    return this.projectionNotifier.subscribe(listener);
  }

  async upsertWorkspace(record: WorkspaceRecord): Promise<void> {
    await fs.mkdir(this.workspacesDir(), { recursive: true });
    const existing = await this.getWorkspace(record.workspaceKey);
    await writeJson(this.workspacePath(record.workspaceKey), {
      ...record,
      createdAt: existing?.createdAt ?? record.createdAt,
      updatedAt: record.updatedAt,
    });
    this.notifyProjectionChanged("workspaces");
  }

  async getWorkspace(workspaceKey: string): Promise<WorkspaceRecord | null> {
    return readJsonIfExists<WorkspaceRecord>(this.workspacePath(workspaceKey));
  }

  async deleteWorkspace(workspaceKey: string): Promise<void> {
    const existing = await this.getWorkspace(workspaceKey);
    if (!existing) return;
    await fs.rm(this.workspacePath(workspaceKey), { force: true });
    this.notifyProjectionChanged("workspaces");
  }

  async listWorkspaces(): Promise<WorkspaceRecord[]> {
    await fs.mkdir(this.workspacesDir(), { recursive: true });
    const entries = await fs.readdir(this.workspacesDir());
    const records = await Promise.all(
      entries.filter((entry) => entry.endsWith(".json")).map((entry) => readJsonIfExists<WorkspaceRecord>(path.join(this.workspacesDir(), entry))),
    );
    return records.filter((record): record is WorkspaceRecord => record !== null);
  }

  async findWorkspace(issueIdOrIdentifierOrKey: string, projectContextId?: string | null): Promise<WorkspaceRecord | null> {
    const direct = await this.getWorkspace(issueIdOrIdentifierOrKey);
    if (direct) return direct;
    const records = await this.listWorkspaces();
    return (
      records.find(
        (record) =>
          (projectContextId === undefined || projectContextId === null || (record.projectContextId ?? null) === projectContextId) &&
          (record.issueId === issueIdOrIdentifierOrKey ||
            record.issueIdentifier === issueIdOrIdentifierOrKey ||
            record.workspaceKey === issueIdOrIdentifierOrKey),
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
      ...(input.harnessId === undefined ? {} : { harnessId: input.harnessId }),
      ...(input.runtimeModel === undefined ? {} : { runtimeModel: input.runtimeModel }),
      ...(input.runtimeModelParams === undefined ? {} : { runtimeModelParams: input.runtimeModelParams }),
      ...(input.runtimeSettingSources === undefined ? {} : { runtimeSettingSources: input.runtimeSettingSources }),
      ...(input.runtimeMode === undefined ? {} : { runtimeMode: input.runtimeMode }),
      ...(input.runtimeAllowLargeContext === undefined ? {} : { runtimeAllowLargeContext: input.runtimeAllowLargeContext }),
      ...(input.runtimeAgentLifecycle === undefined ? {} : { runtimeAgentLifecycle: input.runtimeAgentLifecycle }),
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
      ...(input.projectContextId === undefined ? {} : { projectContextId: input.projectContextId }),
      ...(input.projectContextLabel === undefined ? {} : { projectContextLabel: input.projectContextLabel }),
      ...(input.trackerProjectSlug === undefined ? {} : { trackerProjectSlug: input.trackerProjectSlug }),
      status: existing?.status ?? "running",
      startedAt: existing?.startedAt ?? now,
      updatedAt: now,
      completedAt: existing?.completedAt ?? null,
      error: existing?.error ?? null,
      tokens: existing?.tokens ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      transcriptEventCount: existing?.transcriptEventCount ?? 0,
    };
    await this.writeRun(record);
    this.notifyProjectionChanged("runs");
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
      this.notifyProjectionChanged("runs");
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
      const reduced = reduceRunActivityEvent(record, event, count + 1, { terminalEvents: true });
      if (reduced) {
        await this.writeRun(reduced);
      }
      this.notifyProjectionChanged("runs", {
        runId: event.runId,
        sessionId: (reduced ?? record)?.sessionId ?? event.runId,
        afterSequence: count,
        eventCount: 1,
        events: [projectTranscriptEventForPublicRead(event)],
      });
      return event;
    });
  }

  async rebuildRunFromTranscript(runId: string): Promise<RunRecord | null> {
    return this.withRunUpdateLock(runId, async () => {
      const existing = await this.getRun(runId);
      let reduced: RunRecord | null = existing === null ? null : resetReplayableRunState(existing);
      let count = 0;
      try {
        const stream = createReadStream(this.eventsPath(runId), { encoding: "utf8" });
        const lines = createInterface({ input: stream, crlfDelay: Infinity });
        for await (const line of lines) {
          if (line.length === 0) continue;
          count += 1;
          reduced = reduceRunActivityEvent(reduced, JSON.parse(line) as TranscriptEvent, count, { terminalEvents: true });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (!reduced) return null;
      await this.writeRun(reduced);
      this.notifyProjectionChanged("runs");
      return reduced;
    });
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const record = await readJsonIfExists<RunRecord>(this.metaPath(runId));
    return record === null ? null : normalizeRunRecord(record);
  }

  async listRunsForIssue(issueIdOrIdentifier: string, projectContextId?: string | null): Promise<RunRecord[]> {
    const records = await this.listRuns();
    return records
      .filter(
        (record) =>
          (projectContextId === undefined || projectContextId === null || (record.projectContextId ?? null) === projectContextId) &&
          (record.issueId === issueIdOrIdentifier || record.issueIdentifier === issueIdOrIdentifier),
      )
      .sort(compareRunChronology);
  }

  async latestRunForIssue(
    issueIdOrIdentifier: string,
    options: { role?: PersistedRunRole; runPhase?: AgentRunPhase; runKind?: AgentRunKind; projectContextId?: string | null } = {},
  ): Promise<RunRecord | null> {
    const records = await this.listRunsForIssue(issueIdOrIdentifier, options.projectContextId);
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
    return transcriptPage({ runId, offset, limit, nextOffset, total, events, windowKind: "page" });
  }

  async readTranscriptTail(runId: string, options: { limit?: number } = {}): Promise<TranscriptPage> {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 1_000);
    const total = await this.readTranscriptEventCount(runId);
    const events = (await readJsonlTailPage<TranscriptEvent>(this.eventsPath(runId), limit)).map(projectTranscriptEventForPublicRead);
    const offset = Math.max(0, total - events.length);
    return transcriptPage({ runId, offset, limit, nextOffset: null, total, events, windowKind: "tail" });
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
    const records = await mapWithFileReadConcurrency(entries, (entry) => readJsonIfExists<RunRecord>(this.metaPath(entry)));
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
    if (record) {
      await this.writeRun({ ...record, transcriptEventCount: count });
      this.notifyProjectionChanged("runs");
    }
    return count;
  }

  private notifyProjectionChanged(source: "runs" | "workspaces", detail: Record<string, unknown> | null = null): void {
    this.projectionNotifier.notify(source, detail);
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
  const harnessId =
    record.harnessId ??
    (record.cursorModel !== undefined ||
    record.cursorModelParams !== undefined ||
    record.cursorMode !== undefined ||
    record.cursorSettingSources !== undefined
      ? "cursor"
      : undefined);
  const shouldBackfillCursorRuntime = harnessId === "cursor";
  return {
    ...record,
    ...(record.projectContextId === undefined ? { projectContextId: null } : {}),
    ...(record.projectContextLabel === undefined ? { projectContextLabel: null } : {}),
    ...(record.trackerProjectSlug === undefined ? { trackerProjectSlug: null } : {}),
    runPhase,
    runKind: record.runKind ?? runKindForPhase(runPhase),
    ...(harnessId === undefined ? {} : { harnessId }),
    ...(record.runtimeModel !== undefined
      ? {}
      : { runtimeModel: shouldBackfillCursorRuntime ? (record.cursorModel ?? null) : null }),
    ...(record.runtimeModelParams !== undefined
      ? {}
      : { runtimeModelParams: shouldBackfillCursorRuntime ? (record.cursorModelParams ?? []) : [] }),
    ...(record.runtimeSettingSources !== undefined
      ? {}
      : { runtimeSettingSources: shouldBackfillCursorRuntime ? (record.cursorSettingSources ?? []) : [] }),
    ...(record.runtimeMode !== undefined
      ? {}
      : { runtimeMode: shouldBackfillCursorRuntime ? (record.cursorMode ?? null) : null }),
    ...(record.runtimeAllowLargeContext !== undefined
      ? {}
      : shouldBackfillCursorRuntime && record.cursorAllowLargeContext !== undefined
        ? { runtimeAllowLargeContext: record.cursorAllowLargeContext }
        : {}),
    ...(record.runtimeAgentLifecycle !== undefined
      ? {}
      : shouldBackfillCursorRuntime && record.cursorWorkerAgentLifecycle !== undefined
        ? { runtimeAgentLifecycle: record.cursorWorkerAgentLifecycle }
        : {}),
    ...(record.commandPolicy === undefined ? {} : { commandPolicy: commandPolicyReplayStateFromExisting(record.commandPolicy) }),
  };
}

function defaultRunPhase(role: PersistedRunRole): AgentRunPhase {
  if (role === "planner") return "issue_breakdown";
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
    ...(metadata.providerLimit === undefined ? {} : { providerLimit: metadata.providerLimit }),
    ...(metadata.commandPolicy === undefined ? {} : { commandPolicy: commandPolicyReplayStateFromExisting(metadata.commandPolicy) }),
  };
}

function metadataPayload(metadata: RunMetadata): RunMetadata {
  return metadataPatch(metadata);
}

interface RunActivityReductionOptions {
  terminalEvents: boolean;
}

type UnknownRecord = Record<string, unknown>;

function reduceRunActivityEvent(
  record: RunRecord | null,
  event: TranscriptEvent,
  transcriptEventCount: number,
  options: RunActivityReductionOptions,
): RunRecord | null {
  if (!record) return null;
  const payload = recordPayload(event.payload);
  const activitySnapshot = reduceActivitySnapshot(record.activitySnapshot, event);
  let next: RunRecord = {
    ...record,
    transcriptEventCount,
    ...(activitySnapshot === undefined ? {} : { activitySnapshot }),
    updatedAt: new Date().toISOString(),
  };

  if (payload) {
    next = applyRunMetadataPayload(next, payload);
  }

  switch (normalizeTranscriptEventType(event.eventType)) {
    case "session_started":
      next = reduceSessionStarted(next, event, payload);
      break;
    case "run_status":
      next = reduceRunStatus(next, event, payload);
      break;
    case "tokens":
      next = reduceTokenEvent(next, payload);
      break;
    case "run_diagnostic":
      next = reduceRunDiagnostic(next, event, payload);
      break;
    case "command_policy_decision":
      next = reduceCommandPolicyDecision(next, event);
      break;
    case "provider_limit":
      next = reduceProviderLimit(next, event, payload, options);
      break;
    case "approval_request":
      next = reduceApprovalRequest(next, event, payload);
      break;
    case "approval_resolved":
      next = reduceApprovalResolved(next, payload);
      break;
    case "handoff_terminal":
      next = reduceHandoffTerminalEvent(next, event, payload, options);
      break;
    case "planning_run_failed":
      next = reducePlanningRunFailedEvent(next, event, payload, options, "Planning run failed");
      break;
    case "completed":
      next = reduceCompletedEvent(next, event, payload, options);
      break;
    case "failed":
      next = reduceFailedEvent(next, event, payload, options);
      break;
    case "cancelled":
      next = reduceTerminalEvent(next, event, "cancelled", null, options);
      break;
    default:
      break;
  }

  return normalizeRunRecord(next);
}

function resetReplayableRunState(record: RunRecord): RunRecord {
  return normalizeRunRecord({
    ...record,
    status: "running",
    completedAt: null,
    error: null,
    tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    transcriptEventCount: 0,
    prUrl: null,
    prNumber: null,
    prHeadSha: null,
    prBranch: null,
    ciStatus: null,
    lastPushedAt: null,
    lastEvidenceCursor: null,
    cancellationRequestedAt: null,
    cancellationSource: null,
    cancellationReason: null,
    harnessStopRequestedAt: null,
    harnessStopFailedAt: null,
    harnessStopFailedReason: null,
    cancellationOutcome: "none",
    cancelFailed: false,
    cancelFailedAt: null,
    cancelFailedReason: null,
    cancelFailedSource: null,
    activitySnapshot: emptyActivitySnapshot(),
    sdkRunStatus: null,
    sdkRunStatusObservedAt: null,
    sdkRunStatusSource: null,
    failureKind: null,
    failureDiagnosticCode: null,
    failureDiagnosticMessage: null,
    failureDiagnosticAt: null,
    failureDiagnosticPayload: null,
    pendingApprovalRequestId: null,
    pendingApprovalRequestedAt: null,
    providerLimit: null,
    commandPolicy: emptyCommandPolicyReplayState(),
    updatedAt: record.startedAt,
  });
}

function applyRunMetadataPayload(record: RunRecord, payload: UnknownRecord): RunRecord {
  const patch = metadataPatch(payload as RunMetadata);
  return Object.keys(patch).length === 0 ? record : { ...record, ...patch };
}

function reduceSessionStarted(record: RunRecord, event: TranscriptEvent, payload: UnknownRecord | null): RunRecord {
  const sessionId = stringField(payload, "sessionId");
  const agentId = stringField(payload, "threadId");
  const runtimeMetadataPatch = sessionStartedRuntimeMetadataPatch(record, payload);
  const runningPatch: Partial<RunRecord> = isTerminalRunStatus(record.status)
    ? {}
    : { status: "running", completedAt: null, error: null };
  return {
    ...record,
    ...runningPatch,
    ...runtimeMetadataPatch,
    startedAt: event.at,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(agentId === undefined ? {} : { agentId }),
  };
}

function sessionStartedRuntimeMetadataPatch(record: RunRecord, payload: UnknownRecord | null): Partial<RunRecord> {
  const runtimeModel = cleanStringField(payload, "model");
  const providerId = cleanStringField(payload, "providerId");
  const patch: Partial<RunRecord> = {};
  if (runtimeModel !== undefined) patch.runtimeModel = runtimeModel;
  if (providerId !== undefined) {
    patch.runtimeSettingSources = runtimeSettingSourcesWithProvider(record.runtimeSettingSources, providerId);
  }
  return patch;
}

function runtimeSettingSourcesWithProvider(sources: string[] | undefined, providerId: string): string[] {
  return [...(sources ?? []).filter((source) => !source.startsWith("provider:")), `provider:${providerId}`];
}

function reduceRunStatus(record: RunRecord, event: TranscriptEvent, payload: UnknownRecord | null): RunRecord {
  const sdkRunStatus = persistedSdkRunStatus(stringField(payload, "sdkStatus"));
  if (!sdkRunStatus) return record;
  const sdkRunStatusSource = persistedSdkRunStatusSource(
    stringField(payload, "sdkStatusSource") ?? stringField(payload, "source"),
  );
  return {
    ...record,
    sdkRunStatus,
    sdkRunStatusObservedAt: event.at,
    ...(sdkRunStatusSource === null ? {} : { sdkRunStatusSource }),
  };
}

function reduceTokenEvent(record: RunRecord, payload: UnknownRecord | null): RunRecord {
  const tokens = recordPayload(payload?.tokens);
  if (!tokens) return record;
  return { ...record, tokens: reduceTokenCounts(record.tokens, tokens) };
}

function reduceRunDiagnostic(record: RunRecord, event: TranscriptEvent, payload: UnknownRecord | null): RunRecord {
  const code = stringField(payload, "code");
  const message = event.message ?? stringField(payload, "message");
  if (code === undefined && message === undefined) return record;
  const next: RunRecord = {
    ...record,
    ...(code === undefined ? {} : { failureKind: failureKindForDiagnosticCode(code), failureDiagnosticCode: code }),
    ...(message === undefined ? {} : { failureDiagnosticMessage: message }),
    failureDiagnosticAt: event.at,
  };
  return payload && Object.hasOwn(payload, "payload") ? { ...next, failureDiagnosticPayload: payload.payload } : next;
}

function reduceCommandPolicyDecision(record: RunRecord, event: TranscriptEvent): RunRecord {
  return {
    ...record,
    commandPolicy: reduceCommandPolicyReplayState(record.commandPolicy, event),
  };
}

export function emptyCommandPolicyReplayState(): PersistedCommandPolicyReplayState {
  return commandPolicyReplayState([], []);
}

export function reduceCommandPolicyReplayState(
  existing: PersistedCommandPolicyReplayState | undefined,
  event: TranscriptEvent,
): PersistedCommandPolicyReplayState {
  const current = commandPolicyReplayStateFromExisting(existing);
  if (normalizeTranscriptEventType(event.eventType) !== "command_policy_decision") return current;

  if (!isRunActivityCommandPolicyDecisionPayload(event.payload)) {
    const malformed = malformedCommandPolicyDecisionRecord(event);
    if (current.malformedEvents.some((item) => malformedCommandPolicyEventKey(item) === malformedCommandPolicyEventKey(malformed))) {
      return current;
    }
    return commandPolicyReplayState(current.decisions, [...current.malformedEvents, malformed]);
  }

  const decision = commandPolicyDecisionRecord(event, event.payload);
  if (current.decisions.some((item) => commandPolicyDecisionKey(item) === commandPolicyDecisionKey(decision))) {
    return current;
  }
  return commandPolicyReplayState([...current.decisions, decision], current.malformedEvents);
}

function commandPolicyReplayStateFromExisting(
  existing: PersistedCommandPolicyReplayState | undefined,
): PersistedCommandPolicyReplayState {
  if (!existing) return emptyCommandPolicyReplayState();
  const decisions = dedupeCommandPolicyDecisionRecords(
    Array.isArray(existing.decisions) ? existing.decisions.filter(isPersistedCommandPolicyDecisionRecord) : [],
  );
  const malformedEvents = dedupeMalformedCommandPolicyEventRecords(
    Array.isArray(existing.malformedEvents) ? existing.malformedEvents.filter(isPersistedMalformedCommandPolicyDecisionRecord) : [],
  );
  return commandPolicyReplayState(decisions, malformedEvents);
}

function commandPolicyReplayState(
  decisions: PersistedCommandPolicyDecisionRecord[],
  malformedEvents: PersistedMalformedCommandPolicyDecisionRecord[],
): PersistedCommandPolicyReplayState {
  return {
    decisionCount: decisions.length,
    malformedEventCount: malformedEvents.length,
    lastDecisionAt: decisions.at(-1)?.at ?? null,
    lastMalformedAt: malformedEvents.at(-1)?.at ?? null,
    decisions,
    malformedEvents,
  };
}

function commandPolicyDecisionRecord(
  event: TranscriptEvent,
  payload: Record<string, unknown>,
): PersistedCommandPolicyDecisionRecord {
  return {
    sequence: event.sequence,
    at: event.at,
    source: event.source,
    decisionId: stringField(payload, "decisionId") ?? null,
    attemptId: stringField(payload, "attemptId") ?? null,
    activityId: stringField(payload, "activityId") ?? null,
    runId: stringField(payload, "runId") ?? event.runId,
    issueId: stringField(payload, "issueId") ?? null,
    surface: payload.surface as string,
    role: payload.role as string,
    phase: payload.phase as string,
    outcome: payload.outcome as "allow" | "deny",
    reasonKind: payload.reasonKind as string,
    commandClass: payload.commandClass as string,
    message: payload.message as string,
    upstreamContactAttempted: payload.upstreamContactAttempted as boolean,
    redacted: true,
    ...(event.payloadSchema === undefined ? {} : { payloadSchema: event.payloadSchema }),
    ...(typeof payload.requiresCodeChange === "boolean" ? { requiresCodeChange: payload.requiresCodeChange } : {}),
    ...(typeof payload.requiresUserOrServiceFix === "boolean" ? { requiresUserOrServiceFix: payload.requiresUserOrServiceFix } : {}),
    ...optionalStringRecordPatch(payload, "requestKind"),
    ...optionalStringRecordPatch(payload, "toolCallId"),
    ...optionalStringRecordPatch(payload, "selectedOptionId"),
    ...optionalStringRecordPatch(payload, "permissionOutcome"),
    ...optionalStringRecordPatch(payload, "hookAction"),
    ...(payload.normalizedCommand === undefined ? {} : { normalizedCommand: sanitizeJson(payload.normalizedCommand) }),
    audit: sanitizeJson(payload.audit),
  };
}

function malformedCommandPolicyDecisionRecord(event: TranscriptEvent): PersistedMalformedCommandPolicyDecisionRecord {
  return {
    sequence: event.sequence,
    at: event.at,
    source: event.source,
    eventType: "command_policy_decision",
    ...(event.payloadSchema === undefined ? {} : { payloadSchema: event.payloadSchema }),
    payloadPresent: event.payload !== undefined && event.payload !== null,
    failureKind: "malformed_persisted_policy_data",
    safeOutcome: "deny",
    message: "Malformed persisted command-policy decision could not be replayed; treating the policy attempt as denied for audit.",
    redacted: true,
  };
}

function commandPolicyDecisionKey(decision: PersistedCommandPolicyDecisionRecord): string {
  if (decision.decisionId) return `decision:${decision.decisionId}`;
  if (decision.activityId) return `activity:${decision.activityId}`;
  return `sequence:${decision.sequence}`;
}

function malformedCommandPolicyEventKey(event: PersistedMalformedCommandPolicyDecisionRecord): string {
  return `sequence:${event.sequence}`;
}

function isPersistedCommandPolicyDecisionRecord(value: unknown): value is PersistedCommandPolicyDecisionRecord {
  const record = recordPayload(value);
  return (
    record !== null &&
    typeof record.sequence === "number" &&
    typeof record.at === "string" &&
    typeof record.source === "string" &&
    isNullableString(record.decisionId) &&
    isNullableString(record.attemptId) &&
    isNullableString(record.activityId) &&
    isNullableString(record.runId) &&
    isNullableString(record.issueId) &&
    record.redacted === true &&
    (record.outcome === "allow" || record.outcome === "deny") &&
    typeof record.surface === "string" &&
    typeof record.role === "string" &&
    typeof record.phase === "string" &&
    typeof record.reasonKind === "string" &&
    typeof record.commandClass === "string" &&
    typeof record.message === "string" &&
    typeof record.upstreamContactAttempted === "boolean" &&
    Object.hasOwn(record, "audit")
  );
}

function isPersistedMalformedCommandPolicyDecisionRecord(
  value: unknown,
): value is PersistedMalformedCommandPolicyDecisionRecord {
  const record = recordPayload(value);
  return (
    record !== null &&
    typeof record.sequence === "number" &&
    typeof record.at === "string" &&
    typeof record.source === "string" &&
    record.eventType === "command_policy_decision" &&
    record.failureKind === "malformed_persisted_policy_data" &&
    record.safeOutcome === "deny" &&
    typeof record.payloadPresent === "boolean" &&
    typeof record.message === "string" &&
    record.redacted === true
  );
}

function optionalStringRecordPatch(record: UnknownRecord, key: string): Record<string, string | null> {
  if (!(key in record)) return {};
  const value = record[key];
  return value === null || typeof value === "string" ? { [key]: value } : {};
}

function dedupeCommandPolicyDecisionRecords(
  decisions: PersistedCommandPolicyDecisionRecord[],
): PersistedCommandPolicyDecisionRecord[] {
  const seen = new Set<string>();
  const deduped: PersistedCommandPolicyDecisionRecord[] = [];
  for (const decision of decisions) {
    const key = commandPolicyDecisionKey(decision);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(decision);
  }
  return deduped;
}

function dedupeMalformedCommandPolicyEventRecords(
  events: PersistedMalformedCommandPolicyDecisionRecord[],
): PersistedMalformedCommandPolicyDecisionRecord[] {
  const seen = new Set<string>();
  const deduped: PersistedMalformedCommandPolicyDecisionRecord[] = [];
  for (const event of events) {
    const key = malformedCommandPolicyEventKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(event);
  }
  return deduped;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function reduceProviderLimit(
  record: RunRecord,
  event: TranscriptEvent,
  payload: UnknownRecord | null,
  options: RunActivityReductionOptions,
): RunRecord {
  if (options.terminalEvents && record.status !== "running") return record;
  const signal = providerLimitSignal(payload);
  const message = signal?.message ?? event.message ?? "Provider limit reached";
  const observedAt = signal?.observedAt ?? event.at;
  const next: RunRecord = {
    ...record,
    ...(signal === null ? {} : { providerLimit: signal }),
    failureKind: "provider_limit",
    failureDiagnosticCode: "provider_limit",
    failureDiagnosticMessage: message,
    failureDiagnosticAt: observedAt,
  };
  return reduceTerminalEvent(next, event, "failed", message, options);
}

function reduceApprovalRequest(record: RunRecord, event: TranscriptEvent, payload: UnknownRecord | null): RunRecord {
  const requestId = stringField(payload, "requestId");
  return {
    ...record,
    ...(requestId === undefined ? {} : { pendingApprovalRequestId: requestId }),
    pendingApprovalRequestedAt: stringField(payload, "requestedAt") ?? event.at,
  };
}

function reduceApprovalResolved(record: RunRecord, payload: UnknownRecord | null): RunRecord {
  const requestId = stringField(payload, "requestId");
  if (requestId !== undefined && record.pendingApprovalRequestId != null && record.pendingApprovalRequestId !== requestId) return record;
  return { ...record, pendingApprovalRequestId: null, pendingApprovalRequestedAt: null };
}

function reduceHandoffTerminalEvent(
  record: RunRecord,
  event: TranscriptEvent,
  payload: UnknownRecord | null,
  options: RunActivityReductionOptions,
): RunRecord {
  const status = terminalStatusField(stringField(payload, "status")) ?? "succeeded";
  const tokens = recordPayload(payload?.tokens);
  const withTokens = tokens ? { ...record, tokens: reduceTokenCounts(record.tokens, tokens) } : record;
  const error = status === "failed" ? stringField(payload, "error") ?? event.message ?? "Agent run failed" : null;
  return reduceTerminalEvent(withTokens, event, status, error, options);
}

function reduceCompletedEvent(
  record: RunRecord,
  event: TranscriptEvent,
  payload: UnknownRecord | null,
  options: RunActivityReductionOptions,
): RunRecord {
  if (record.runPhase === "issue_breakdown") {
    return reducePlanningRunFailedEvent(record, event, payload, options, PLANNING_NO_PLAN_ERROR, true);
  }
  return reduceTerminalEvent(record, event, "succeeded", null, options);
}

function reducePlanningRunFailedEvent(
  record: RunRecord,
  event: TranscriptEvent,
  payload: UnknownRecord | null,
  options: RunActivityReductionOptions,
  fallbackError: string,
  preferFallbackError = false,
): RunRecord {
  const tokens = recordPayload(payload?.tokens);
  const withTokens = tokens ? { ...record, tokens: reduceTokenCounts(record.tokens, tokens) } : record;
  const payloadError = stringField(payload, "error");
  const error = payloadError ?? (preferFallbackError ? fallbackError : event.message ?? fallbackError);
  const withDiagnostic = withTokens.failureKind
    ? withTokens
    : {
        ...withTokens,
        failureKind: PLANNING_FAILURE_DIAGNOSTIC_CODE,
        failureDiagnosticCode: PLANNING_FAILURE_DIAGNOSTIC_CODE,
        failureDiagnosticMessage: error,
        failureDiagnosticAt: event.at,
      };
  if (withDiagnostic.status !== "running") return withDiagnostic.status === "failed" ? withDiagnostic : record;
  return reduceTerminalEvent(withDiagnostic, event, "failed", error, options);
}

function reduceFailedEvent(
  record: RunRecord,
  event: TranscriptEvent,
  payload: UnknownRecord | null,
  options: RunActivityReductionOptions,
): RunRecord {
  if (options.terminalEvents && record.status !== "running") return record;
  const error = stringField(payload, "error") ?? event.message ?? "Agent run failed";
  const withDiagnostic = record.failureKind
    ? record
    : {
        ...record,
        failureKind: "agent_error",
        failureDiagnosticMessage: error,
        failureDiagnosticAt: event.at,
      };
  return reduceTerminalEvent(withDiagnostic, event, "failed", error, options);
}

function reduceTerminalEvent(
  record: RunRecord,
  event: TranscriptEvent,
  status: Exclude<RunStatus, "running">,
  error: string | null,
  options: RunActivityReductionOptions,
): RunRecord {
  if (!options.terminalEvents || record.status !== "running") return record;
  const cancellationOutcome = record.cancellationOutcome ?? "none";
  return {
    ...record,
    status,
    completedAt: event.at,
    error,
    ...(status === "cancelled" && (cancellationOutcome === "none" || cancellationOutcome === "requested")
      ? { cancellationOutcome: "cancelled" as const }
      : {}),
  };
}

function reduceActivitySnapshot(existing: RunActivitySnapshot | undefined, event: TranscriptEvent): RunActivitySnapshot | undefined {
  const isHarnessActivity = event.source === "harness" || event.source === "runtime" || event.source === "cursor";
  if (!existing && !isHarnessActivity) return undefined;
  const next = existing ? { ...emptyActivitySnapshot(), ...existing } : emptyActivitySnapshot();
  if (isHarnessActivity) next.lastHarnessActivityAt = event.at;

  if (event.eventType === "progress") {
    const source = activitySourceForEvent(event);
    if (source === "stream") next.lastStreamActivityAt = event.at;
    if (source === "delta" || source === "tool") next.lastDeltaOrToolActivityAt = event.at;
    if (source === "tool") next.lastToolActivityAt = event.at;
  }
  return next;
}

function activitySourceForEvent(event: TranscriptEvent): "stream" | "delta" | "tool" {
  const source = stringField(recordPayload(event.payload), "activitySource");
  return source === "delta" || source === "tool" || source === "stream" ? source : "stream";
}

function emptyActivitySnapshot(): RunActivitySnapshot {
  return {
    lastHarnessActivityAt: null,
    lastStreamActivityAt: null,
    lastDeltaOrToolActivityAt: null,
    lastToolActivityAt: null,
  };
}

function reduceTokenCounts(current: TokenCounts, tokens: UnknownRecord): TokenCounts {
  return {
    inputTokens: finiteNumber(tokens.inputTokens) ?? current.inputTokens,
    outputTokens: finiteNumber(tokens.outputTokens) ?? current.outputTokens,
    totalTokens: finiteNumber(tokens.totalTokens) ?? current.totalTokens,
  };
}

function providerLimitSignal(payload: UnknownRecord | null): ProviderLimitSignal | null {
  const signal = recordPayload(payload?.signal);
  if (!signal || typeof signal.message !== "string" || typeof signal.kind !== "string" || !recordPayload(signal.scope)) return null;
  return signal as unknown as ProviderLimitSignal;
}

function persistedSdkRunStatus(value: string | undefined): PersistedSdkRunStatus | null {
  return value === "running" || value === "finished" || value === "error" || value === "cancelled" ? value : null;
}

function persistedSdkRunStatusSource(value: string | undefined): PersistedSdkRunStatusSource | null {
  return value === "initial" || value === "onDidChangeStatus" || value === "wait" ? value : null;
}

function failureKindForDiagnosticCode(code: string): string {
  if (code === "cursor_run_wait_terminal_error") return "cursor_sdk_terminal_error";
  if (code === "cursor_run_wait_threw") return "cursor_sdk_wait_error";
  if (code === "cursor_stream_error" || code.startsWith("cursor_stream_status_")) return "cursor_stream_error";
  return "harness_diagnostic";
}

function isTerminalRunStatus(status: RunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function terminalStatusField(value: string | undefined): Exclude<RunStatus, "running"> | null {
  return value === "succeeded" || value === "failed" || value === "cancelled" ? value : null;
}

function stringField(record: UnknownRecord | null | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function normalizeTranscriptEventType(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function cleanStringField(record: UnknownRecord | null | undefined, key: string): string | undefined {
  const value = stringField(record, key)?.trim();
  return value && value.length > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function recordPayload(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as UnknownRecord) : null;
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

async function readJsonlTailPage<T>(filePath: string, limit: number): Promise<T[]> {
  if (limit <= 0) return [];
  const chunkSize = 64 * 1024;
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(filePath, "r");
    const stat = await handle.stat();
    let position = stat.size;
    let pendingPrefix = Buffer.alloc(0);
    let lines: Buffer[] = [];

    while (position > 0 && lines.length < limit) {
      const readLength = Math.min(chunkSize, position);
      position -= readLength;
      const buffer = Buffer.allocUnsafe(readLength);
      const { bytesRead } = await handle.read(buffer, 0, readLength, position);
      const combined = Buffer.concat([buffer.subarray(0, bytesRead), pendingPrefix]);
      const completeLines: Buffer[] = [];
      let lineEnd = combined.length;
      for (let index = combined.length - 1; index >= 0; index -= 1) {
        if (combined[index] === 0x0a) {
          const line = trimJsonlCarriageReturn(combined.subarray(index + 1, lineEnd));
          if (line.length > 0) completeLines.unshift(line);
          lineEnd = index;
        }
      }
      pendingPrefix = combined.subarray(0, lineEnd);
      if (completeLines.length > 0) {
        lines = [...completeLines, ...lines].slice(-limit);
      }
    }

    if (position === 0 && pendingPrefix.length > 0 && lines.length < limit) {
      lines = [trimJsonlCarriageReturn(pendingPrefix), ...lines].slice(-limit);
    }

    return lines.slice(-limit).map((line) => JSON.parse(line.toString("utf8")) as T);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  } finally {
    await handle?.close();
  }
}

function trimJsonlCarriageReturn(line: Buffer): Buffer {
  return line.at(-1) === 0x0d ? line.subarray(0, -1) : line;
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

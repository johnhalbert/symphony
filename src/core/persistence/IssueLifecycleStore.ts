import { promises as fs } from "node:fs";
import path from "node:path";
import type { ServiceConfig } from "../config/Config.js";
import { SymphonyError, errorMessage } from "../errors.js";
import type { Issue } from "../types.js";

export type IssueLifecyclePhase = "implementation" | "review" | "passed" | "blocked" | "terminal" | "unknown";

export interface IssueLifecycleSummaryPointers {
  workspaceKey: string | null;
  workspacePath: string | null;
  branchName: string | null;
  lastRunId: string | null;
}

export interface CompletionReportChecklistItem {
  text: string;
  satisfied: boolean;
  evidence: string | null;
}

export interface CompletionReportPullRequestRef {
  url: string | null;
  number: number | null;
}

export interface IssueCompletionReportRecord {
  id: string;
  idempotencyKey: string;
  runId: string;
  issueId: string;
  issueIdentifier: string;
  summary: string;
  validationEvidence: string[];
  acceptanceChecklist: CompletionReportChecklistItem[];
  changedFiles: string[];
  branchName: string | null;
  pullRequest: CompletionReportPullRequestRef | null;
  risks: string[];
  acceptedAt: string;
  writebackOperationKeys: string[];
}

export interface IssueLifecycleRecord {
  issueId: string;
  issueIdentifier: string;
  phase: IssueLifecyclePhase;
  reviewRound: number;
  incompleteTurnCount: number;
  lastCompletionReportId: string | null;
  lastReviewVerdictId: string | null;
  blockedReason: string | null;
  summaryPointers: IssueLifecycleSummaryPointers;
  completionReports: IssueCompletionReportRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface IssueLifecyclePatch {
  phase?: IssueLifecyclePhase;
  reviewRound?: number;
  incompleteTurnCount?: number;
  lastCompletionReportId?: string | null;
  lastReviewVerdictId?: string | null;
  blockedReason?: string | null;
  summaryPointers?: Partial<IssueLifecycleSummaryPointers>;
  completionReports?: IssueCompletionReportRecord[];
}

export type IssueLifecycleStore = FileIssueLifecycleStore;

export class FileIssueLifecycleStore {
  constructor(private readonly stateDir: string) {}

  async ensureIssue(issue: Pick<Issue, "id" | "identifier">, patch: IssueLifecyclePatch = {}): Promise<IssueLifecycleRecord> {
    const existing = await this.find(issue.id, issue.identifier);
    const now = new Date().toISOString();
    const record: IssueLifecycleRecord = {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      phase: patch.phase ?? existing?.phase ?? "implementation",
      reviewRound: patch.reviewRound ?? existing?.reviewRound ?? 0,
      incompleteTurnCount: patch.incompleteTurnCount ?? existing?.incompleteTurnCount ?? 0,
      lastCompletionReportId: patchValue(patch, "lastCompletionReportId", existing?.lastCompletionReportId ?? null),
      lastReviewVerdictId: patchValue(patch, "lastReviewVerdictId", existing?.lastReviewVerdictId ?? null),
      blockedReason: patchValue(patch, "blockedReason", existing?.blockedReason ?? null),
      summaryPointers: {
        ...defaultSummaryPointers(),
        ...existing?.summaryPointers,
        ...patch.summaryPointers,
      },
      completionReports: patch.completionReports ?? existing?.completionReports ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.write(record);
    return record;
  }

  async updateIssue(
    issue: Pick<Issue, "id" | "identifier">,
    patch: IssueLifecyclePatch,
  ): Promise<IssueLifecycleRecord> {
    return this.ensureIssue(issue, patch);
  }

  async get(issueIdOrIdentifier: string): Promise<IssueLifecycleRecord | null> {
    const direct = await readLifecycleJsonIfExists(this.recordPath(issueIdOrIdentifier));
    if (direct) return direct;
    const records = await this.list();
    return (
      records.find(
        (record) => record.issueId === issueIdOrIdentifier || record.issueIdentifier === issueIdOrIdentifier,
      ) ?? null
    );
  }

  async list(): Promise<IssueLifecycleRecord[]> {
    await fs.mkdir(this.recordsDir(), { recursive: true });
    const entries = await fs.readdir(this.recordsDir());
    const records = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => readLifecycleJsonIfExists(path.join(this.recordsDir(), entry))),
    );
    return records.filter((record): record is IssueLifecycleRecord => record !== null);
  }

  private async find(issueId: string, issueIdentifier: string): Promise<IssueLifecycleRecord | null> {
    const direct = await this.get(issueId);
    if (direct) return direct;
    return this.get(issueIdentifier);
  }

  private async write(record: IssueLifecycleRecord): Promise<void> {
    await fs.mkdir(this.recordsDir(), { recursive: true });
    await fs.writeFile(this.recordPath(record.issueId), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  }

  private recordsDir(): string {
    return path.join(this.stateDir, "issue-lifecycle");
  }

  private recordPath(issueIdOrIdentifier: string): string {
    return path.join(this.recordsDir(), `${safeFileName(issueIdOrIdentifier)}.json`);
  }
}

export function phaseForIssueState(state: string, config: ServiceConfig): IssueLifecyclePhase {
  if (isStateIn(state, config.reviewLoop.blockedStates)) return "blocked";
  if (isStateIn(state, config.reviewLoop.reviewStates)) return "review";
  if (config.reviewLoop.reviewPassState && statesEqual(state, config.reviewLoop.reviewPassState)) return "passed";
  if (isStateIn(state, config.tracker.terminalStates)) return "terminal";
  if (isStateIn(state, config.tracker.activeStates)) return "implementation";
  return "unknown";
}

function defaultSummaryPointers(): IssueLifecycleSummaryPointers {
  return {
    workspaceKey: null,
    workspacePath: null,
    branchName: null,
    lastRunId: null,
  };
}

function patchValue<K extends keyof IssueLifecyclePatch>(
  patch: IssueLifecyclePatch,
  key: K,
  fallback: NonNullable<IssueLifecyclePatch[K]> | null,
): NonNullable<IssueLifecyclePatch[K]> | null {
  if (!Object.prototype.hasOwnProperty.call(patch, key)) return fallback;
  const value = patch[key];
  return value === undefined ? fallback : (value as NonNullable<IssueLifecyclePatch[K]> | null);
}

async function readLifecycleJsonIfExists(filePath: string): Promise<IssueLifecycleRecord | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    return normalizeLifecycleRecord(parsed, filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SymphonyError) throw error;
    throw new SymphonyError("lifecycle_store_corrupt", `Issue lifecycle record is unreadable: ${filePath}`, {
      cause: errorMessage(error),
    });
  }
}

function normalizeLifecycleRecord(value: unknown, filePath: string): IssueLifecycleRecord {
  if (!isRecord(value)) {
    throw corruptLifecycle(filePath, "record is not an object");
  }
  if (typeof value.issueId !== "string" || value.issueId.length === 0) {
    throw corruptLifecycle(filePath, "issueId is missing");
  }
  if (typeof value.issueIdentifier !== "string" || value.issueIdentifier.length === 0) {
    throw corruptLifecycle(filePath, "issueIdentifier is missing");
  }
  if (!isLifecyclePhase(value.phase)) {
    throw corruptLifecycle(filePath, "phase is invalid");
  }

  return {
    issueId: value.issueId,
    issueIdentifier: value.issueIdentifier,
    phase: value.phase,
    reviewRound: nonNegativeInteger(value.reviewRound, filePath, "reviewRound"),
    incompleteTurnCount: nonNegativeInteger(value.incompleteTurnCount, filePath, "incompleteTurnCount"),
    lastCompletionReportId: nullableString(value.lastCompletionReportId, filePath, "lastCompletionReportId"),
    lastReviewVerdictId: nullableString(value.lastReviewVerdictId, filePath, "lastReviewVerdictId"),
    blockedReason: nullableString(value.blockedReason, filePath, "blockedReason"),
    summaryPointers: normalizeSummaryPointers(value.summaryPointers, filePath),
    completionReports: normalizeCompletionReports(value.completionReports, filePath),
    createdAt: requiredString(value.createdAt, filePath, "createdAt"),
    updatedAt: requiredString(value.updatedAt, filePath, "updatedAt"),
  };
}

function normalizeSummaryPointers(value: unknown, filePath: string): IssueLifecycleSummaryPointers {
  if (!isRecord(value)) return defaultSummaryPointers();
  return {
    workspaceKey: nullableString(value.workspaceKey, filePath, "summaryPointers.workspaceKey"),
    workspacePath: nullableString(value.workspacePath, filePath, "summaryPointers.workspacePath"),
    branchName: nullableString(value.branchName, filePath, "summaryPointers.branchName"),
    lastRunId: nullableString(value.lastRunId, filePath, "summaryPointers.lastRunId"),
  };
}

function normalizeCompletionReports(value: unknown, filePath: string): IssueCompletionReportRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw corruptLifecycle(filePath, "completionReports is invalid");
  return value.map((item, index) => normalizeCompletionReport(item, filePath, index));
}

function normalizeCompletionReport(value: unknown, filePath: string, index: number): IssueCompletionReportRecord {
  if (!isRecord(value)) throw corruptLifecycle(filePath, `completionReports[${index}] is invalid`);
  return {
    id: requiredString(value.id, filePath, `completionReports[${index}].id`),
    idempotencyKey: requiredString(value.idempotencyKey, filePath, `completionReports[${index}].idempotencyKey`),
    runId: requiredString(value.runId, filePath, `completionReports[${index}].runId`),
    issueId: requiredString(value.issueId, filePath, `completionReports[${index}].issueId`),
    issueIdentifier: requiredString(value.issueIdentifier, filePath, `completionReports[${index}].issueIdentifier`),
    summary: requiredString(value.summary, filePath, `completionReports[${index}].summary`),
    validationEvidence: requiredStringArray(value.validationEvidence, filePath, `completionReports[${index}].validationEvidence`),
    acceptanceChecklist: normalizeChecklist(value.acceptanceChecklist, filePath, index),
    changedFiles: requiredStringArray(value.changedFiles, filePath, `completionReports[${index}].changedFiles`),
    branchName: nullableString(value.branchName, filePath, `completionReports[${index}].branchName`),
    pullRequest: normalizePullRequest(value.pullRequest, filePath, index),
    risks: requiredStringArray(value.risks, filePath, `completionReports[${index}].risks`),
    acceptedAt: requiredString(value.acceptedAt, filePath, `completionReports[${index}].acceptedAt`),
    writebackOperationKeys: requiredStringArray(value.writebackOperationKeys, filePath, `completionReports[${index}].writebackOperationKeys`),
  };
}

function normalizeChecklist(value: unknown, filePath: string, reportIndex: number): CompletionReportChecklistItem[] {
  if (!Array.isArray(value)) {
    throw corruptLifecycle(filePath, `completionReports[${reportIndex}].acceptanceChecklist is invalid`);
  }
  return value.map((item, itemIndex) => {
    if (!isRecord(item)) {
      throw corruptLifecycle(filePath, `completionReports[${reportIndex}].acceptanceChecklist[${itemIndex}] is invalid`);
    }
    if (typeof item.satisfied !== "boolean") {
      throw corruptLifecycle(filePath, `completionReports[${reportIndex}].acceptanceChecklist[${itemIndex}].satisfied is invalid`);
    }
    return {
      text: requiredString(item.text, filePath, `completionReports[${reportIndex}].acceptanceChecklist[${itemIndex}].text`),
      satisfied: item.satisfied,
      evidence: nullableString(item.evidence, filePath, `completionReports[${reportIndex}].acceptanceChecklist[${itemIndex}].evidence`),
    };
  });
}

function normalizePullRequest(value: unknown, filePath: string, reportIndex: number): CompletionReportPullRequestRef | null {
  if (value === null) return null;
  if (!isRecord(value)) throw corruptLifecycle(filePath, `completionReports[${reportIndex}].pullRequest is invalid`);
  return {
    url: nullableString(value.url, filePath, `completionReports[${reportIndex}].pullRequest.url`),
    number: nullableNumber(value.number, filePath, `completionReports[${reportIndex}].pullRequest.number`),
  };
}

function nonNegativeInteger(value: unknown, filePath: string, field: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  throw corruptLifecycle(filePath, `${field} is invalid`);
}

function nullableString(value: unknown, filePath: string, field: string): string | null {
  if (value === null) return null;
  if (typeof value === "string") return value;
  throw corruptLifecycle(filePath, `${field} is invalid`);
}

function nullableNumber(value: unknown, filePath: string, field: string): number | null {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw corruptLifecycle(filePath, `${field} is invalid`);
}

function requiredStringArray(value: unknown, filePath: string, field: string): string[] {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  throw corruptLifecycle(filePath, `${field} is invalid`);
}

function requiredString(value: unknown, filePath: string, field: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw corruptLifecycle(filePath, `${field} is missing`);
}

function corruptLifecycle(filePath: string, reason: string): SymphonyError {
  return new SymphonyError("lifecycle_store_corrupt", `Issue lifecycle record is corrupt: ${filePath} (${reason})`);
}

function isLifecyclePhase(value: unknown): value is IssueLifecyclePhase {
  return (
    value === "implementation" ||
    value === "review" ||
    value === "passed" ||
    value === "blocked" ||
    value === "terminal" ||
    value === "unknown"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_") || "record";
}

function isStateIn(state: string, states: string[]): boolean {
  return states.some((candidate) => statesEqual(state, candidate));
}

function statesEqual(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

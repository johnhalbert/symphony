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
  gitBranchName: string | null;
  repoPath: string | null;
  baseRef: string | null;
  lastRunId: string | null;
  prUrl: string | null;
  prNumber: number | null;
  prHeadSha: string | null;
  prBranch: string | null;
  ciStatus: string | null;
  lastPushedAt: string | null;
  lastEvidenceCursor: string | null;
}

export type IssueLifecycleSummaryReferenceKind = "continuation_history";

export interface IssueLifecycleSummaryReference {
  id: string;
  kind: IssueLifecycleSummaryReferenceKind;
  summary: string;
  runIds: string[];
  transcriptEventCount: number;
  transcriptPointers: string[];
  statusApiPointers: string[];
  createdAt: string;
}

export interface CompletionReportChecklistItem {
  text: string;
  satisfied: boolean;
  evidence: string | null;
}

export interface CompletionReportPullRequestRef {
  url: string | null;
  number: number | null;
  headSha: string | null;
  branch: string | null;
}

export type PullRequestReviewEvidenceSource = "review" | "review_comment" | "issue_comment";

export interface PullRequestReviewEvidenceItem {
  id: string;
  source: PullRequestReviewEvidenceSource;
  githubId: string;
  pullRequestNumber: number;
  pullRequestUrl: string | null;
  url: string | null;
  reviewer: string | null;
  body: string;
  state: string | null;
  path: string | null;
  line: number | null;
  originalLine: number | null;
  side: string | null;
  threadId: string | null;
  inReplyToId: string | null;
  isResolved: boolean | null;
  isOutdated: boolean | null;
  createdAt: string | null;
  updatedAt: string | null;
  submittedAt: string | null;
  cursor: string;
}

export interface PullRequestReviewEvidenceState {
  pullRequest: CompletionReportPullRequestRef | null;
  lastIngestedCursor: string | null;
  lastWorkerEvidenceCursor: string | null;
  items: PullRequestReviewEvidenceItem[];
  updatedAt: string | null;
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

export type IssueReviewVerdict = "pass" | "fail";

export interface ReviewVerdictAcceptanceResult {
  text: string;
  satisfied: boolean;
  evidence: string | null;
}

export interface IssueReviewVerdictRecord {
  id: string;
  idempotencyKey: string;
  runId: string;
  issueId: string;
  issueIdentifier: string;
  verdict: IssueReviewVerdict;
  acceptanceResults: ReviewVerdictAcceptanceResult[];
  findings: string[];
  evidence: string[];
  reviewer: string | null;
  submittedAt: string;
  writebackOperationKeys: string[];
}

export type PullRequestReviewFeedbackKind = "review" | "review_comment" | "issue_comment";
export type PullRequestReviewFeedbackEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export interface IssueReviewFeedbackRecord {
  id: string;
  idempotencyKey: string;
  requestHash: string;
  runId: string;
  issueId: string;
  issueIdentifier: string;
  kind: PullRequestReviewFeedbackKind;
  event: PullRequestReviewFeedbackEvent | null;
  body: string;
  pullRequest: CompletionReportPullRequestRef;
  reviewer: string | null;
  reviewUrl: string | null;
  commentUrls: string[];
  submittedAt: string;
}

export interface IssueMergeMetadata {
  id: string;
  pullRequest: CompletionReportPullRequestRef;
  headSha: string;
  mergeCommitSha: string;
  mergedAt: string;
  mergedBy: {
    login: string | null;
    profile: string | null;
    capability: "github.merge";
  };
  checkStatus: {
    requiredChecks: string[];
    passedChecks: string[];
    noCiEvidence: string | null;
  };
  mergeOperationKey: string;
  doneTransitionOperationKey: string;
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
  summaryReferences: IssueLifecycleSummaryReference[];
  completionReports: IssueCompletionReportRecord[];
  reviewVerdicts: IssueReviewVerdictRecord[];
  reviewFeedback: IssueReviewFeedbackRecord[];
  reviewEvidence: PullRequestReviewEvidenceState;
  merge: IssueMergeMetadata | null;
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
  summaryReferences?: IssueLifecycleSummaryReference[];
  completionReports?: IssueCompletionReportRecord[];
  reviewVerdicts?: IssueReviewVerdictRecord[];
  reviewFeedback?: IssueReviewFeedbackRecord[];
  reviewEvidence?: PullRequestReviewEvidenceState;
  merge?: IssueMergeMetadata | null;
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
      summaryReferences: patch.summaryReferences ?? existing?.summaryReferences ?? [],
      completionReports: patch.completionReports ?? existing?.completionReports ?? [],
      reviewVerdicts: patch.reviewVerdicts ?? existing?.reviewVerdicts ?? [],
      reviewFeedback: patch.reviewFeedback ?? existing?.reviewFeedback ?? [],
      reviewEvidence: patch.reviewEvidence ?? existing?.reviewEvidence ?? defaultReviewEvidence(),
      merge: patchValue(patch, "merge", existing?.merge ?? null),
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
    gitBranchName: null,
    repoPath: null,
    baseRef: null,
    lastRunId: null,
    prUrl: null,
    prNumber: null,
    prHeadSha: null,
    prBranch: null,
    ciStatus: null,
    lastPushedAt: null,
    lastEvidenceCursor: null,
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
    summaryReferences: normalizeSummaryReferences(value.summaryReferences, filePath),
    completionReports: normalizeCompletionReports(value.completionReports, filePath),
    reviewVerdicts: normalizeReviewVerdicts(value.reviewVerdicts, filePath),
    reviewFeedback: normalizeReviewFeedback(value.reviewFeedback, filePath),
    reviewEvidence: normalizeReviewEvidence(value.reviewEvidence, filePath),
    merge: normalizeMergeMetadata(value.merge, filePath),
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
    gitBranchName: optionalNullableString(value.gitBranchName, filePath, "summaryPointers.gitBranchName"),
    repoPath: optionalNullableString(value.repoPath, filePath, "summaryPointers.repoPath"),
    baseRef: optionalNullableString(value.baseRef, filePath, "summaryPointers.baseRef"),
    lastRunId: nullableString(value.lastRunId, filePath, "summaryPointers.lastRunId"),
    prUrl: optionalNullableString(value.prUrl, filePath, "summaryPointers.prUrl"),
    prNumber: optionalNullableNumber(value.prNumber, filePath, "summaryPointers.prNumber"),
    prHeadSha: optionalNullableString(value.prHeadSha, filePath, "summaryPointers.prHeadSha"),
    prBranch: optionalNullableString(value.prBranch, filePath, "summaryPointers.prBranch"),
    ciStatus: optionalNullableString(value.ciStatus, filePath, "summaryPointers.ciStatus"),
    lastPushedAt: optionalNullableString(value.lastPushedAt, filePath, "summaryPointers.lastPushedAt"),
    lastEvidenceCursor: optionalNullableString(value.lastEvidenceCursor, filePath, "summaryPointers.lastEvidenceCursor"),
  };
}

function normalizeSummaryReferences(value: unknown, filePath: string): IssueLifecycleSummaryReference[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw corruptLifecycle(filePath, "summaryReferences is invalid");
  return value.map((item, index) => normalizeSummaryReference(item, filePath, index));
}

function normalizeSummaryReference(value: unknown, filePath: string, index: number): IssueLifecycleSummaryReference {
  if (!isRecord(value)) throw corruptLifecycle(filePath, `summaryReferences[${index}] is invalid`);
  if (value.kind !== "continuation_history") {
    throw corruptLifecycle(filePath, `summaryReferences[${index}].kind is invalid`);
  }
  return {
    id: requiredString(value.id, filePath, `summaryReferences[${index}].id`),
    kind: value.kind,
    summary: requiredString(value.summary, filePath, `summaryReferences[${index}].summary`),
    runIds: requiredStringArray(value.runIds, filePath, `summaryReferences[${index}].runIds`),
    transcriptEventCount: nonNegativeInteger(
      value.transcriptEventCount,
      filePath,
      `summaryReferences[${index}].transcriptEventCount`,
    ),
    transcriptPointers: requiredStringArray(
      value.transcriptPointers,
      filePath,
      `summaryReferences[${index}].transcriptPointers`,
    ),
    statusApiPointers: requiredStringArray(
      value.statusApiPointers,
      filePath,
      `summaryReferences[${index}].statusApiPointers`,
    ),
    createdAt: requiredString(value.createdAt, filePath, `summaryReferences[${index}].createdAt`),
  };
}

function normalizeCompletionReports(value: unknown, filePath: string): IssueCompletionReportRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw corruptLifecycle(filePath, "completionReports is invalid");
  return value.map((item, index) => normalizeCompletionReport(item, filePath, index));
}

function normalizeReviewVerdicts(value: unknown, filePath: string): IssueReviewVerdictRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw corruptLifecycle(filePath, "reviewVerdicts is invalid");
  return value.map((item, index) => normalizeReviewVerdict(item, filePath, index));
}

function normalizeReviewFeedback(value: unknown, filePath: string): IssueReviewFeedbackRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw corruptLifecycle(filePath, "reviewFeedback is invalid");
  return value.map((item, index) => normalizeReviewFeedbackRecord(item, filePath, index));
}

function defaultReviewEvidence(): PullRequestReviewEvidenceState {
  return {
    pullRequest: null,
    lastIngestedCursor: null,
    lastWorkerEvidenceCursor: null,
    items: [],
    updatedAt: null,
  };
}

function normalizeReviewEvidence(value: unknown, filePath: string): PullRequestReviewEvidenceState {
  if (value === undefined) return defaultReviewEvidence();
  if (!isRecord(value)) throw corruptLifecycle(filePath, "reviewEvidence is invalid");
  return {
    pullRequest: normalizeReviewEvidencePullRequest(value.pullRequest, filePath),
    lastIngestedCursor: optionalNullableString(value.lastIngestedCursor, filePath, "reviewEvidence.lastIngestedCursor"),
    lastWorkerEvidenceCursor: optionalNullableString(
      value.lastWorkerEvidenceCursor,
      filePath,
      "reviewEvidence.lastWorkerEvidenceCursor",
    ),
    items: normalizeReviewEvidenceItems(value.items, filePath),
    updatedAt: optionalNullableString(value.updatedAt, filePath, "reviewEvidence.updatedAt"),
  };
}

function normalizeReviewEvidencePullRequest(value: unknown, filePath: string): CompletionReportPullRequestRef | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw corruptLifecycle(filePath, "reviewEvidence.pullRequest is invalid");
  return {
    url: nullableString(value.url, filePath, "reviewEvidence.pullRequest.url"),
    number: nullableNumber(value.number, filePath, "reviewEvidence.pullRequest.number"),
    headSha: optionalNullableString(value.headSha, filePath, "reviewEvidence.pullRequest.headSha"),
    branch: optionalNullableString(value.branch, filePath, "reviewEvidence.pullRequest.branch"),
  };
}

function normalizeReviewEvidenceItems(value: unknown, filePath: string): PullRequestReviewEvidenceItem[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw corruptLifecycle(filePath, "reviewEvidence.items is invalid");
  return value.map((item, index) => normalizeReviewEvidenceItem(item, filePath, index));
}

function normalizeReviewEvidenceItem(value: unknown, filePath: string, index: number): PullRequestReviewEvidenceItem {
  if (!isRecord(value)) throw corruptLifecycle(filePath, `reviewEvidence.items[${index}] is invalid`);
  const source = value.source;
  if (source !== "review" && source !== "review_comment" && source !== "issue_comment") {
    throw corruptLifecycle(filePath, `reviewEvidence.items[${index}].source is invalid`);
  }
  return {
    id: requiredString(value.id, filePath, `reviewEvidence.items[${index}].id`),
    source,
    githubId: requiredString(value.githubId, filePath, `reviewEvidence.items[${index}].githubId`),
    pullRequestNumber: nonNegativeInteger(value.pullRequestNumber, filePath, `reviewEvidence.items[${index}].pullRequestNumber`),
    pullRequestUrl: optionalNullableString(value.pullRequestUrl, filePath, `reviewEvidence.items[${index}].pullRequestUrl`),
    url: optionalNullableString(value.url, filePath, `reviewEvidence.items[${index}].url`),
    reviewer: optionalNullableString(value.reviewer, filePath, `reviewEvidence.items[${index}].reviewer`),
    body: requiredString(value.body, filePath, `reviewEvidence.items[${index}].body`),
    state: optionalNullableString(value.state, filePath, `reviewEvidence.items[${index}].state`),
    path: optionalNullableString(value.path, filePath, `reviewEvidence.items[${index}].path`),
    line: optionalNullableNumber(value.line, filePath, `reviewEvidence.items[${index}].line`),
    originalLine: optionalNullableNumber(value.originalLine, filePath, `reviewEvidence.items[${index}].originalLine`),
    side: optionalNullableString(value.side, filePath, `reviewEvidence.items[${index}].side`),
    threadId: optionalNullableString(value.threadId, filePath, `reviewEvidence.items[${index}].threadId`),
    inReplyToId: optionalNullableString(value.inReplyToId, filePath, `reviewEvidence.items[${index}].inReplyToId`),
    isResolved: optionalNullableBoolean(value.isResolved, filePath, `reviewEvidence.items[${index}].isResolved`),
    isOutdated: optionalNullableBoolean(value.isOutdated, filePath, `reviewEvidence.items[${index}].isOutdated`),
    createdAt: optionalNullableString(value.createdAt, filePath, `reviewEvidence.items[${index}].createdAt`),
    updatedAt: optionalNullableString(value.updatedAt, filePath, `reviewEvidence.items[${index}].updatedAt`),
    submittedAt: optionalNullableString(value.submittedAt, filePath, `reviewEvidence.items[${index}].submittedAt`),
    cursor: requiredString(value.cursor, filePath, `reviewEvidence.items[${index}].cursor`),
  };
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

function normalizeReviewVerdict(value: unknown, filePath: string, index: number): IssueReviewVerdictRecord {
  if (!isRecord(value)) throw corruptLifecycle(filePath, `reviewVerdicts[${index}] is invalid`);
  if (value.verdict !== "pass" && value.verdict !== "fail") {
    throw corruptLifecycle(filePath, `reviewVerdicts[${index}].verdict is invalid`);
  }
  return {
    id: requiredString(value.id, filePath, `reviewVerdicts[${index}].id`),
    idempotencyKey: requiredString(value.idempotencyKey, filePath, `reviewVerdicts[${index}].idempotencyKey`),
    runId: requiredString(value.runId, filePath, `reviewVerdicts[${index}].runId`),
    issueId: requiredString(value.issueId, filePath, `reviewVerdicts[${index}].issueId`),
    issueIdentifier: requiredString(value.issueIdentifier, filePath, `reviewVerdicts[${index}].issueIdentifier`),
    verdict: value.verdict,
    acceptanceResults: normalizeReviewVerdictAcceptanceResults(value.acceptanceResults, filePath, index),
    findings: requiredStringArray(value.findings, filePath, `reviewVerdicts[${index}].findings`),
    evidence: requiredStringArray(value.evidence, filePath, `reviewVerdicts[${index}].evidence`),
    reviewer: nullableString(value.reviewer, filePath, `reviewVerdicts[${index}].reviewer`),
    submittedAt: requiredString(value.submittedAt, filePath, `reviewVerdicts[${index}].submittedAt`),
    writebackOperationKeys: requiredStringArray(value.writebackOperationKeys, filePath, `reviewVerdicts[${index}].writebackOperationKeys`),
  };
}

function normalizeReviewFeedbackRecord(value: unknown, filePath: string, index: number): IssueReviewFeedbackRecord {
  if (!isRecord(value)) throw corruptLifecycle(filePath, `reviewFeedback[${index}] is invalid`);
  const kind = value.kind;
  if (kind !== "review" && kind !== "review_comment" && kind !== "issue_comment") {
    throw corruptLifecycle(filePath, `reviewFeedback[${index}].kind is invalid`);
  }
  const event = optionalNullableString(value.event, filePath, `reviewFeedback[${index}].event`);
  if (event !== null && event !== "APPROVE" && event !== "REQUEST_CHANGES" && event !== "COMMENT") {
    throw corruptLifecycle(filePath, `reviewFeedback[${index}].event is invalid`);
  }
  return {
    id: requiredString(value.id, filePath, `reviewFeedback[${index}].id`),
    idempotencyKey: requiredString(value.idempotencyKey, filePath, `reviewFeedback[${index}].idempotencyKey`),
    requestHash: requiredString(value.requestHash, filePath, `reviewFeedback[${index}].requestHash`),
    runId: requiredString(value.runId, filePath, `reviewFeedback[${index}].runId`),
    issueId: requiredString(value.issueId, filePath, `reviewFeedback[${index}].issueId`),
    issueIdentifier: requiredString(value.issueIdentifier, filePath, `reviewFeedback[${index}].issueIdentifier`),
    kind,
    event,
    body: requiredString(value.body, filePath, `reviewFeedback[${index}].body`),
    pullRequest: normalizeReviewFeedbackPullRequest(value.pullRequest, filePath, index),
    reviewer: optionalNullableString(value.reviewer, filePath, `reviewFeedback[${index}].reviewer`),
    reviewUrl: optionalNullableString(value.reviewUrl, filePath, `reviewFeedback[${index}].reviewUrl`),
    commentUrls: requiredStringArray(value.commentUrls, filePath, `reviewFeedback[${index}].commentUrls`),
    submittedAt: requiredString(value.submittedAt, filePath, `reviewFeedback[${index}].submittedAt`),
  };
}

function normalizeMergeMetadata(value: unknown, filePath: string): IssueMergeMetadata | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw corruptLifecycle(filePath, "merge is invalid");
  const mergedBy = value.mergedBy;
  if (!isRecord(mergedBy)) throw corruptLifecycle(filePath, "merge.mergedBy is invalid");
  if (mergedBy.capability !== "github.merge") throw corruptLifecycle(filePath, "merge.mergedBy.capability is invalid");
  const checkStatus = value.checkStatus;
  if (!isRecord(checkStatus)) throw corruptLifecycle(filePath, "merge.checkStatus is invalid");
  return {
    id: requiredString(value.id, filePath, "merge.id"),
    pullRequest: normalizeMergePullRequest(value.pullRequest, filePath),
    headSha: requiredString(value.headSha, filePath, "merge.headSha"),
    mergeCommitSha: requiredString(value.mergeCommitSha, filePath, "merge.mergeCommitSha"),
    mergedAt: requiredString(value.mergedAt, filePath, "merge.mergedAt"),
    mergedBy: {
      login: optionalNullableString(mergedBy.login, filePath, "merge.mergedBy.login"),
      profile: optionalNullableString(mergedBy.profile, filePath, "merge.mergedBy.profile"),
      capability: "github.merge",
    },
    checkStatus: {
      requiredChecks: requiredStringArray(checkStatus.requiredChecks, filePath, "merge.checkStatus.requiredChecks"),
      passedChecks: requiredStringArray(checkStatus.passedChecks, filePath, "merge.checkStatus.passedChecks"),
      noCiEvidence: optionalNullableString(checkStatus.noCiEvidence, filePath, "merge.checkStatus.noCiEvidence"),
    },
    mergeOperationKey: requiredString(value.mergeOperationKey, filePath, "merge.mergeOperationKey"),
    doneTransitionOperationKey: requiredString(
      value.doneTransitionOperationKey,
      filePath,
      "merge.doneTransitionOperationKey",
    ),
  };
}

function normalizeMergePullRequest(value: unknown, filePath: string): CompletionReportPullRequestRef {
  if (!isRecord(value)) throw corruptLifecycle(filePath, "merge.pullRequest is invalid");
  return {
    url: nullableString(value.url, filePath, "merge.pullRequest.url"),
    number: nullableNumber(value.number, filePath, "merge.pullRequest.number"),
    headSha: optionalNullableString(value.headSha, filePath, "merge.pullRequest.headSha"),
    branch: optionalNullableString(value.branch, filePath, "merge.pullRequest.branch"),
  };
}

function normalizeReviewFeedbackPullRequest(
  value: unknown,
  filePath: string,
  index: number,
): CompletionReportPullRequestRef {
  if (!isRecord(value)) throw corruptLifecycle(filePath, `reviewFeedback[${index}].pullRequest is invalid`);
  return {
    url: nullableString(value.url, filePath, `reviewFeedback[${index}].pullRequest.url`),
    number: nullableNumber(value.number, filePath, `reviewFeedback[${index}].pullRequest.number`),
    headSha: optionalNullableString(value.headSha, filePath, `reviewFeedback[${index}].pullRequest.headSha`),
    branch: optionalNullableString(value.branch, filePath, `reviewFeedback[${index}].pullRequest.branch`),
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

function normalizeReviewVerdictAcceptanceResults(
  value: unknown,
  filePath: string,
  verdictIndex: number,
): ReviewVerdictAcceptanceResult[] {
  if (!Array.isArray(value)) {
    throw corruptLifecycle(filePath, `reviewVerdicts[${verdictIndex}].acceptanceResults is invalid`);
  }
  return value.map((item, itemIndex) => {
    if (!isRecord(item)) {
      throw corruptLifecycle(filePath, `reviewVerdicts[${verdictIndex}].acceptanceResults[${itemIndex}] is invalid`);
    }
    if (typeof item.satisfied !== "boolean") {
      throw corruptLifecycle(
        filePath,
        `reviewVerdicts[${verdictIndex}].acceptanceResults[${itemIndex}].satisfied is invalid`,
      );
    }
    return {
      text: requiredString(item.text, filePath, `reviewVerdicts[${verdictIndex}].acceptanceResults[${itemIndex}].text`),
      satisfied: item.satisfied,
      evidence: nullableString(
        item.evidence,
        filePath,
        `reviewVerdicts[${verdictIndex}].acceptanceResults[${itemIndex}].evidence`,
      ),
    };
  });
}

function normalizePullRequest(value: unknown, filePath: string, reportIndex: number): CompletionReportPullRequestRef | null {
  if (value === null) return null;
  if (!isRecord(value)) throw corruptLifecycle(filePath, `completionReports[${reportIndex}].pullRequest is invalid`);
  return {
    url: nullableString(value.url, filePath, `completionReports[${reportIndex}].pullRequest.url`),
    number: nullableNumber(value.number, filePath, `completionReports[${reportIndex}].pullRequest.number`),
    headSha: optionalNullableString(value.headSha, filePath, `completionReports[${reportIndex}].pullRequest.headSha`),
    branch: optionalNullableString(value.branch, filePath, `completionReports[${reportIndex}].pullRequest.branch`),
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

function optionalNullableString(value: unknown, filePath: string, field: string): string | null {
  if (value === undefined) return null;
  return nullableString(value, filePath, field);
}

function nullableNumber(value: unknown, filePath: string, field: string): number | null {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw corruptLifecycle(filePath, `${field} is invalid`);
}

function optionalNullableNumber(value: unknown, filePath: string, field: string): number | null {
  if (value === undefined) return null;
  return nullableNumber(value, filePath, field);
}

function optionalNullableBoolean(value: unknown, filePath: string, field: string): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value;
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

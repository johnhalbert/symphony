import { promises as fs } from "node:fs";
import path from "node:path";
import type { ServiceConfig } from "../config/Config.js";
import { SymphonyError, errorMessage } from "../errors.js";
import type { Issue } from "../types.js";

export type IssueLifecyclePhase =
  | "implementation"
  | "merge_conflict_resolution"
  | "review"
  | "passed"
  | "blocked"
  | "terminal"
  | "unknown";

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

export type IssueLifecycleSummaryReferenceKind = "continuation_history" | "issue_breakdown_plan";

export interface IssueLifecycleSummaryReference {
  id: string;
  kind: IssueLifecycleSummaryReferenceKind;
  summary: string;
  planId?: string;
  runIds: string[];
  transcriptEventCount: number;
  transcriptPointers: string[];
  statusApiPointers: string[];
  issueUpdatedAt?: string | null;
  issueContentFingerprint?: string | null;
  configFingerprint?: string | null;
  cursorMode?: string | null;
  createdAt: string;
}

export interface ProposedIssueRecord {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  dependencies: string[];
  labels: string[];
}

export type IssueBreakdownPlanApplicationStatus =
  | "not_requested"
  | "pending"
  | "applied"
  | "blocked"
  | "stale";

export interface IssueBreakdownCreatedIssueRef {
  proposedIssueIndex: number;
  operationKey: string;
  status: "created" | "verified";
  id: string;
  identifier: string | null;
  url: string | null;
}

export interface IssueBreakdownPlanRecord {
  id: string;
  idempotencyKey: string;
  requestHash: string;
  runId: string;
  issueId: string;
  issueIdentifier: string;
  summary: string;
  proposedIssues: ProposedIssueRecord[];
  transcriptPointers: string[];
  statusApiPointers: string[];
  issueUpdatedAt: string | null;
  issueContentFingerprint: string;
  configFingerprint: string;
  cursorMode: string;
  acceptedAt: string;
  applicationStatus: IssueBreakdownPlanApplicationStatus;
  applicationOperationKeys: string[];
  createdIssueRefs: IssueBreakdownCreatedIssueRef[];
  appliedAt: string | null;
  applicationBlockedReason: string | null;
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
  draft?: boolean | null;
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

export type IssueMergeGateStatus = "observing" | "repair_dispatched" | "blocked" | "resolved" | "superseded";
export type IssueMergeGateCheckOutcome =
  | "passing"
  | "pending"
  | "missing_observed"
  | "missing_actionable"
  | "failing"
  | "unknown";
export type IssueMergeGateRawCheckStatus = "success" | "failure" | "pending" | "missing" | "unknown";

export interface IssueMergeGateCheckState {
  name: string;
  outcome: IssueMergeGateCheckOutcome;
  rawStatus: IssueMergeGateRawCheckStatus;
  conclusion: string | null;
  url: string | null;
  firstObservedAt: string | null;
  actionableSince: string | null;
}

export interface IssueMergeGateState {
  id: string;
  status: IssueMergeGateStatus;
  headSha: string;
  pullRequest: CompletionReportPullRequestRef;
  requiredChecks: string[];
  checks: IssueMergeGateCheckState[];
  reviewRound: number;
  gateRunId: string | null;
  gateReportId: string | null;
  repairRunId: string | null;
  repairReportId: string | null;
  blockerFingerprint: string | null;
  writebackOperationKeys: string[];
  supersededByHeadSha: string | null;
  updatedAt: string;
}

export type IssueMergeConflictResolutionStatus = "pending" | "still_conflicted" | "resolved" | "blocked";

export interface IssueMergeConflictResolutionReportRecord {
  id: string;
  idempotencyKey: string;
  runId: string;
  issueId: string;
  issueIdentifier: string;
  resolutionStatus: "resolved" | "still_conflicted" | "blocked";
  summary: string;
  validationEvidence: string[];
  changedFiles: string[];
  pullRequest: CompletionReportPullRequestRef;
  previousHeadSha: string | null;
  newHeadSha: string | null;
  baseBranch: string | null;
  baseHeadSha: string | null;
  blockedReason: string | null;
  risks: string[];
  submittedAt: string;
}

export interface IssueMergeConflictMetadata {
  id: string;
  status: "open" | "resolved" | "blocked";
  resolutionStatus: IssueMergeConflictResolutionStatus;
  pullRequest: CompletionReportPullRequestRef;
  approvedHeadSha: string;
  currentHeadSha: string;
  resolvedHeadSha: string | null;
  baseBranch: string | null;
  baseHeadSha: string | null;
  sourceState: string;
  conflictsState: string;
  reason: string;
  mergeableState: string | null;
  detectedAt: string;
  updatedAt: string;
  fixTurnCount: number;
  maxFixTurns: number;
  lastConflictFixRunId: string | null;
  lastConflictResolutionReportId: string | null;
  attemptRunIds: string[];
  writebackOperationKeys: string[];
  blockedAt: string | null;
  blockedReason: string | null;
}

export interface IssueWorkerOutputContract {
  version: 1;
  reportId: string;
  runId: string;
  summary: string;
  changedFiles: string[];
  validationEvidence: string[];
  risks: string[];
  pullRequest: CompletionReportPullRequestRef | null;
  acceptedAt: string;
}

export interface IssueReviewerOutputContract {
  version: 1;
  verdictId: string;
  runId: string;
  verdict: IssueReviewVerdict;
  findings: string[];
  acceptanceResults: ReviewVerdictAcceptanceResult[];
  evidence: string[];
  submittedAt: string;
}

export interface IssueLaneMemo {
  version: 1;
  issueId: string;
  issueIdentifier: string;
  updatedAt: string;
  reviewRound: number;
  incompleteTurnCount: number;
  sizeChars: number;
  entries: string[];
  openFindings: string[];
  pointers: IssueLifecycleSummaryPointers;
  lastWorkerRunId: string | null;
  lastReviewerRunId: string | null;
}

export interface IssueHandoffState {
  version: 1;
  memo: IssueLaneMemo;
  lastWorkerOutput: IssueWorkerOutputContract | null;
  lastReviewerOutput: IssueReviewerOutputContract | null;
}

export interface WorkerHandoffPacket {
  version: 1;
  issueId: string;
  issueIdentifier: string;
  generatedAt: string;
  memo: IssueLaneMemo;
  lastWorkerOutput: IssueWorkerOutputContract | null;
  lastReviewerOutput: IssueReviewerOutputContract | null;
  pointers: IssueLifecycleSummaryPointers;
}

export interface IssueLifecycleRecord {
  issueId: string;
  issueIdentifier: string;
  phase: IssueLifecyclePhase;
  reviewRound: number;
  incompleteTurnCount: number;
  lastIssueBreakdownPlanId: string | null;
  planningFailureCount: number;
  planningDispatchRetryCount: number;
  lastPlanningFailureRunId: string | null;
  lastPlanningFailureAt: string | null;
  lastCompletionReportId: string | null;
  lastReviewVerdictId: string | null;
  blockedReason: string | null;
  summaryPointers: IssueLifecycleSummaryPointers;
  summaryReferences: IssueLifecycleSummaryReference[];
  issueBreakdownPlans: IssueBreakdownPlanRecord[];
  completionReports: IssueCompletionReportRecord[];
  reviewVerdicts: IssueReviewVerdictRecord[];
  reviewFeedback: IssueReviewFeedbackRecord[];
  reviewEvidence: PullRequestReviewEvidenceState;
  mergeGate?: IssueMergeGateState | null;
  merge: IssueMergeMetadata | null;
  mergeConflict: IssueMergeConflictMetadata | null;
  mergeConflictResolutionReports: IssueMergeConflictResolutionReportRecord[];
  handoff: IssueHandoffState;
  createdAt: string;
  updatedAt: string;
}

export interface IssueLifecyclePatch {
  phase?: IssueLifecyclePhase;
  reviewRound?: number;
  incompleteTurnCount?: number;
  lastIssueBreakdownPlanId?: string | null;
  planningFailureCount?: number;
  planningDispatchRetryCount?: number;
  lastPlanningFailureRunId?: string | null;
  lastPlanningFailureAt?: string | null;
  lastCompletionReportId?: string | null;
  lastReviewVerdictId?: string | null;
  blockedReason?: string | null;
  summaryPointers?: Partial<IssueLifecycleSummaryPointers>;
  summaryReferences?: IssueLifecycleSummaryReference[];
  issueBreakdownPlans?: IssueBreakdownPlanRecord[];
  completionReports?: IssueCompletionReportRecord[];
  reviewVerdicts?: IssueReviewVerdictRecord[];
  reviewFeedback?: IssueReviewFeedbackRecord[];
  reviewEvidence?: PullRequestReviewEvidenceState;
  mergeGate?: IssueMergeGateState | null;
  merge?: IssueMergeMetadata | null;
  mergeConflict?: IssueMergeConflictMetadata | null;
  mergeConflictResolutionReports?: IssueMergeConflictResolutionReportRecord[];
  handoff?: IssueHandoffState;
}

export type IssueLifecycleStore = FileIssueLifecycleStore;

export class FileIssueLifecycleStore {
  constructor(private readonly stateDir: string) {}

  async ensureIssue(issue: Pick<Issue, "id" | "identifier">, patch: IssueLifecyclePatch = {}): Promise<IssueLifecycleRecord> {
    const existing = await this.find(issue.id, issue.identifier);
    const now = new Date().toISOString();
    const baseRecord = {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      phase: patch.phase ?? existing?.phase ?? "implementation",
      reviewRound: patch.reviewRound ?? existing?.reviewRound ?? 0,
      incompleteTurnCount: patch.incompleteTurnCount ?? existing?.incompleteTurnCount ?? 0,
      lastIssueBreakdownPlanId: patchValue(
        patch,
        "lastIssueBreakdownPlanId",
        existing?.lastIssueBreakdownPlanId ?? null,
      ),
      planningFailureCount: patch.planningFailureCount ?? existing?.planningFailureCount ?? 0,
      planningDispatchRetryCount: patch.planningDispatchRetryCount ?? existing?.planningDispatchRetryCount ?? 0,
      lastPlanningFailureRunId: patchValue(
        patch,
        "lastPlanningFailureRunId",
        existing?.lastPlanningFailureRunId ?? null,
      ),
      lastPlanningFailureAt: patchValue(patch, "lastPlanningFailureAt", existing?.lastPlanningFailureAt ?? null),
      lastCompletionReportId: patchValue(patch, "lastCompletionReportId", existing?.lastCompletionReportId ?? null),
      lastReviewVerdictId: patchValue(patch, "lastReviewVerdictId", existing?.lastReviewVerdictId ?? null),
      blockedReason: patchValue(patch, "blockedReason", existing?.blockedReason ?? null),
      summaryPointers: {
        ...defaultSummaryPointers(),
        ...existing?.summaryPointers,
        ...patch.summaryPointers,
      },
      summaryReferences: patch.summaryReferences ?? existing?.summaryReferences ?? [],
      issueBreakdownPlans: patch.issueBreakdownPlans ?? existing?.issueBreakdownPlans ?? [],
      completionReports: patch.completionReports ?? existing?.completionReports ?? [],
      reviewVerdicts: patch.reviewVerdicts ?? existing?.reviewVerdicts ?? [],
      reviewFeedback: patch.reviewFeedback ?? existing?.reviewFeedback ?? [],
      reviewEvidence: patch.reviewEvidence ?? existing?.reviewEvidence ?? defaultReviewEvidence(),
      mergeGate: patchValue(patch, "mergeGate", existing?.mergeGate ?? null),
      merge: patchValue(patch, "merge", existing?.merge ?? null),
      mergeConflict: patchValue(patch, "mergeConflict", existing?.mergeConflict ?? null),
      mergeConflictResolutionReports:
        patch.mergeConflictResolutionReports ?? existing?.mergeConflictResolutionReports ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const record: IssueLifecycleRecord = {
      ...baseRecord,
      handoff: patch.handoff ?? buildIssueHandoffState(baseRecord),
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
    const target = this.recordPath(record.issueId);
    const temp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    if (process.platform === "win32") {
      await fs.rm(target, { force: true });
    }
    await fs.rename(temp, target);
  }

  private recordsDir(): string {
    return path.join(this.stateDir, "issue-lifecycle");
  }

  private recordPath(issueIdOrIdentifier: string): string {
    return path.join(this.recordsDir(), `${safeFileName(issueIdOrIdentifier)}.json`);
  }
}

export function phaseForIssueState(state: string, config: ServiceConfig): IssueLifecyclePhase {
  if (config.mergePolicy.mode === "gated" && config.mergePolicy.conflictsState !== null && statesEqual(state, config.mergePolicy.conflictsState)) {
    return "merge_conflict_resolution";
  }
  if (isStateIn(state, config.reviewLoop.blockedStates)) return "blocked";
  if (isStateIn(state, config.tracker.handoffStates)) return "review";
  if (isStateIn(state, config.reviewLoop.reviewStates)) return "review";
  if (config.reviewLoop.reviewPassState && statesEqual(state, config.reviewLoop.reviewPassState)) return "passed";
  if (isStateIn(state, config.tracker.terminalStates)) return "terminal";
  if (isStateIn(state, config.tracker.activeStates)) return "implementation";
  return "unknown";
}

export function buildWorkerHandoffPacket(
  record: IssueLifecycleRecord,
  generatedAt = new Date().toISOString(),
): WorkerHandoffPacket {
  return {
    version: 1,
    issueId: record.issueId,
    issueIdentifier: record.issueIdentifier,
    generatedAt,
    memo: record.handoff.memo,
    lastWorkerOutput: record.handoff.lastWorkerOutput,
    lastReviewerOutput: record.handoff.lastReviewerOutput,
    pointers: record.summaryPointers,
  };
}

export function buildIssueHandoffState(record: Omit<IssueLifecycleRecord, "handoff">): IssueHandoffState {
  const lastWorkerOutput = workerOutputFromReport(latestCompletionReport(record));
  const lastReviewerOutput = reviewerOutputFromVerdict(latestHumanReviewVerdict(record));
  return {
    version: 1,
    memo: buildLaneMemo(record, lastWorkerOutput, lastReviewerOutput),
    lastWorkerOutput,
    lastReviewerOutput,
  };
}

function buildLaneMemo(
  record: Omit<IssueLifecycleRecord, "handoff">,
  lastWorkerOutput: IssueWorkerOutputContract | null,
  lastReviewerOutput: IssueReviewerOutputContract | null,
): IssueLaneMemo {
  const openFindings = lastReviewerOutput?.verdict === "fail" ? lastReviewerOutput.findings.slice(0, 8) : [];
  const mergeGateEntry = mergeGateMemoEntry(record);
  const acceptedDecisions = [
    ...(lastReviewerOutput?.verdict === "pass"
      ? lastReviewerOutput.acceptanceResults
          .filter((result) => result.satisfied)
          .map((result) => `Accepted by reviewer: ${clip(result.text)}`)
      : []),
    ...(record.merge ? [`Merged PR ${record.merge.pullRequest.number === null ? record.merge.pullRequest.url : `#${record.merge.pullRequest.number}`}.`] : []),
    ...(record.mergeConflict
      ? [
          `Merge conflict status: ${record.mergeConflict.resolutionStatus}; attempts ${record.mergeConflict.fixTurnCount}/${record.mergeConflict.maxFixTurns}.`,
        ]
      : []),
    ...record.reviewEvidence.items
      .filter((item) => item.isResolved === true && item.isOutdated !== true)
      .slice(0, 4)
      .map((item) => `Resolved PR evidence: ${clip(item.body)}`),
  ];
  const entries = [
    `Lifecycle phase: ${record.phase}; review round: ${record.reviewRound}; incomplete worker turns: ${record.incompleteTurnCount}.`,
    lastWorkerOutput
      ? `Latest worker output ${lastWorkerOutput.reportId} (${lastWorkerOutput.runId}): ${clip(lastWorkerOutput.summary)}`
      : "No accepted worker output is available yet.",
    lastReviewerOutput
      ? `Latest reviewer output ${lastReviewerOutput.verdictId} (${lastReviewerOutput.runId}): ${lastReviewerOutput.verdict}.`
      : "No reviewer output is available yet.",
    ...(mergeGateEntry === null ? [] : [mergeGateEntry]),
    ...acceptedDecisions.map((decision) => clip(decision)),
    ...openFindings.map((finding) => `Open reviewer finding: ${clip(finding)}`),
  ].slice(0, 12);
  const memoWithoutSize = {
    version: 1 as const,
    issueId: record.issueId,
    issueIdentifier: record.issueIdentifier,
    updatedAt: record.updatedAt,
    reviewRound: record.reviewRound,
    incompleteTurnCount: record.incompleteTurnCount,
    entries,
    openFindings,
    pointers: record.summaryPointers,
    lastWorkerRunId: lastWorkerOutput?.runId ?? null,
    lastReviewerRunId: lastReviewerOutput?.runId ?? null,
  };
  return {
    ...memoWithoutSize,
    sizeChars: JSON.stringify(memoWithoutSize).length,
  };
}

function latestCompletionReport(
  record: Pick<IssueLifecycleRecord, "completionReports" | "lastCompletionReportId">,
): IssueCompletionReportRecord | null {
  if (record.lastCompletionReportId) {
    return record.completionReports.find((report) => report.id === record.lastCompletionReportId) ?? null;
  }
  return record.completionReports.at(-1) ?? null;
}

export function latestCurrentApprovalPassVerdict(
  record: Pick<
    IssueLifecycleRecord,
    | "issueId"
    | "issueIdentifier"
    | "completionReports"
    | "lastCompletionReportId"
    | "reviewVerdicts"
    | "reviewFeedback"
    | "summaryPointers"
  >,
): IssueReviewVerdictRecord | null {
  const pullRequest = currentPullRequestForReview(record);
  if (!pullRequest) return latestHumanPassVerdict(record);
  for (const verdict of record.reviewVerdicts.slice().reverse()) {
    if (!isHumanPassVerdictForIssue(record, verdict)) continue;
    if (hasApprovalFeedback(record, verdict, pullRequest) || !hasAnyApprovalFeedbackForRun(record, verdict)) return verdict;
  }
  return null;
}

function latestReviewVerdict(
  record: Pick<IssueLifecycleRecord, "reviewVerdicts" | "lastReviewVerdictId">,
): IssueReviewVerdictRecord | null {
  if (record.lastReviewVerdictId) {
    return record.reviewVerdicts.find((verdict) => verdict.id === record.lastReviewVerdictId) ?? null;
  }
  return record.reviewVerdicts.at(-1) ?? null;
}

function latestHumanReviewVerdict(
  record: Pick<
    IssueLifecycleRecord,
    | "issueId"
    | "issueIdentifier"
    | "completionReports"
    | "lastCompletionReportId"
    | "reviewVerdicts"
    | "reviewFeedback"
    | "lastReviewVerdictId"
    | "summaryPointers"
  >,
): IssueReviewVerdictRecord | null {
  const pointed = latestReviewVerdict(record);
  if (pointed && !isMergeGateVerdict(pointed) && isCurrentHumanVerdict(record, pointed)) return pointed;
  for (const verdict of record.reviewVerdicts.slice().reverse()) {
    if (!isMergeGateVerdict(verdict) && isCurrentHumanVerdict(record, verdict)) return verdict;
  }
  return null;
}

function latestHumanPassVerdict(
  record: Pick<IssueLifecycleRecord, "issueId" | "issueIdentifier" | "reviewVerdicts">,
): IssueReviewVerdictRecord | null {
  for (const verdict of record.reviewVerdicts.slice().reverse()) {
    if (isHumanPassVerdictForIssue(record, verdict)) return verdict;
  }
  return null;
}

function isCurrentHumanVerdict(
  record: Pick<
    IssueLifecycleRecord,
    | "issueId"
    | "issueIdentifier"
    | "completionReports"
    | "lastCompletionReportId"
    | "reviewFeedback"
    | "summaryPointers"
  >,
  verdict: IssueReviewVerdictRecord,
): boolean {
  if (verdict.issueId !== record.issueId || verdict.issueIdentifier !== record.issueIdentifier) return false;
  if (verdict.verdict !== "pass") return true;
  const pullRequest = currentPullRequestForReview(record);
  return pullRequest === null || hasApprovalFeedback(record, verdict, pullRequest) || !hasAnyApprovalFeedbackForRun(record, verdict);
}

function isHumanPassVerdictForIssue(
  record: Pick<IssueLifecycleRecord, "issueId" | "issueIdentifier">,
  verdict: IssueReviewVerdictRecord,
): boolean {
  return (
    verdict.verdict === "pass" &&
    !isMergeGateVerdict(verdict) &&
    verdict.issueId === record.issueId &&
    verdict.issueIdentifier === record.issueIdentifier
  );
}

function currentPullRequestForReview(
  record: Pick<IssueLifecycleRecord, "completionReports" | "lastCompletionReportId" | "summaryPointers">,
): CompletionReportPullRequestRef | null {
  const reportPullRequest = latestCompletionReport(record)?.pullRequest ?? null;
  const pointerPullRequest =
    record.summaryPointers.prNumber !== null && record.summaryPointers.prUrl !== null && record.summaryPointers.prHeadSha !== null
      ? {
          number: record.summaryPointers.prNumber,
          url: record.summaryPointers.prUrl,
          headSha: record.summaryPointers.prHeadSha,
          branch: record.summaryPointers.prBranch,
        }
      : null;
  if (
    pointerPullRequest &&
    reportPullRequest &&
    pointerPullRequest.number === reportPullRequest.number &&
    pointerPullRequest.headSha !== reportPullRequest.headSha
  ) {
    return pointerPullRequest;
  }
  return reportPullRequest ?? pointerPullRequest;
}

function hasApprovalFeedback(
  record: Pick<IssueLifecycleRecord, "reviewFeedback">,
  verdict: IssueReviewVerdictRecord,
  pullRequest: CompletionReportPullRequestRef,
): boolean {
  return record.reviewFeedback.some(
    (feedback) =>
      feedback.runId === verdict.runId &&
      feedback.kind === "review" &&
      feedback.event === "APPROVE" &&
      feedback.pullRequest.number === pullRequest.number &&
      feedback.pullRequest.url === pullRequest.url &&
      feedback.pullRequest.headSha === pullRequest.headSha,
  );
}

function hasAnyApprovalFeedbackForRun(
  record: Pick<IssueLifecycleRecord, "reviewFeedback">,
  verdict: IssueReviewVerdictRecord,
): boolean {
  return record.reviewFeedback.some(
    (feedback) => feedback.runId === verdict.runId && feedback.kind === "review" && feedback.event === "APPROVE",
  );
}

function isMergeGateVerdict(verdict: IssueReviewVerdictRecord): boolean {
  return verdict.reviewer === "symphony-merge-gate" || verdict.id.startsWith("merge-gate:");
}

function mergeGateMemoEntry(record: Pick<IssueLifecycleRecord, "mergeGate">): string | null {
  const gate = record.mergeGate;
  if (!gate || gate.status === "resolved" || gate.status === "superseded") return null;
  const blockers = gate.checks
    .filter((check) => check.outcome === "failing" || check.outcome === "missing_actionable")
    .map((check) => `${check.name} (${check.outcome})`);
  const observing = gate.checks
    .filter((check) => check.outcome === "pending" || check.outcome === "missing_observed" || check.outcome === "unknown")
    .map((check) => `${check.name} (${check.outcome})`);
  return `Merge gate ${gate.status} on head ${gate.headSha}; blockers: ${
    blockers.length === 0 ? "none" : blockers.join(", ")
  }; observing: ${observing.length === 0 ? "none" : observing.join(", ")}.`;
}

function workerOutputFromReport(report: IssueCompletionReportRecord | null): IssueWorkerOutputContract | null {
  if (!report) return null;
  return {
    version: 1,
    reportId: report.id,
    runId: report.runId,
    summary: clip(report.summary),
    changedFiles: report.changedFiles.slice(0, 25),
    validationEvidence: report.validationEvidence.map((item) => clip(item)).slice(0, 10),
    risks: report.risks.map((item) => clip(item)).slice(0, 10),
    pullRequest: report.pullRequest,
    acceptedAt: report.acceptedAt,
  };
}

function reviewerOutputFromVerdict(verdict: IssueReviewVerdictRecord | null): IssueReviewerOutputContract | null {
  if (!verdict) return null;
  return {
    version: 1,
    verdictId: verdict.id,
    runId: verdict.runId,
    verdict: verdict.verdict,
    findings: verdict.findings.map((item) => clip(item)).slice(0, 10),
    acceptanceResults: verdict.acceptanceResults.slice(0, 20),
    evidence: verdict.evidence.map((item) => clip(item)).slice(0, 10),
    submittedAt: verdict.submittedAt,
  };
}

function clip(value: string, maxChars = 500): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 15)}...[truncated]`;
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

  const normalized = {
    issueId: value.issueId,
    issueIdentifier: value.issueIdentifier,
    phase: value.phase,
    reviewRound: nonNegativeInteger(value.reviewRound, filePath, "reviewRound"),
    incompleteTurnCount: nonNegativeInteger(value.incompleteTurnCount, filePath, "incompleteTurnCount"),
    lastIssueBreakdownPlanId: optionalNullableString(
      value.lastIssueBreakdownPlanId,
      filePath,
      "lastIssueBreakdownPlanId",
    ),
    planningFailureCount:
      value.planningFailureCount === undefined
        ? 0
        : nonNegativeInteger(value.planningFailureCount, filePath, "planningFailureCount"),
    planningDispatchRetryCount:
      value.planningDispatchRetryCount === undefined
        ? 0
        : nonNegativeInteger(value.planningDispatchRetryCount, filePath, "planningDispatchRetryCount"),
    lastPlanningFailureRunId:
      value.lastPlanningFailureRunId === undefined
        ? null
        : nullableString(value.lastPlanningFailureRunId, filePath, "lastPlanningFailureRunId"),
    lastPlanningFailureAt:
      value.lastPlanningFailureAt === undefined
        ? null
        : nullableString(value.lastPlanningFailureAt, filePath, "lastPlanningFailureAt"),
    lastCompletionReportId: nullableString(value.lastCompletionReportId, filePath, "lastCompletionReportId"),
    lastReviewVerdictId: nullableString(value.lastReviewVerdictId, filePath, "lastReviewVerdictId"),
    blockedReason: nullableString(value.blockedReason, filePath, "blockedReason"),
    summaryPointers: normalizeSummaryPointers(value.summaryPointers, filePath),
    summaryReferences: normalizeSummaryReferences(value.summaryReferences, filePath),
    issueBreakdownPlans: normalizeIssueBreakdownPlans(value.issueBreakdownPlans, filePath),
    completionReports: normalizeCompletionReports(value.completionReports, filePath),
    reviewVerdicts: normalizeReviewVerdicts(value.reviewVerdicts, filePath),
    reviewFeedback: normalizeReviewFeedback(value.reviewFeedback, filePath),
    reviewEvidence: normalizeReviewEvidence(value.reviewEvidence, filePath),
    mergeGate: normalizeMergeGateState(value.mergeGate, filePath),
    merge: normalizeMergeMetadata(value.merge, filePath),
    mergeConflict: normalizeMergeConflictMetadata(value.mergeConflict, filePath),
    mergeConflictResolutionReports: normalizeMergeConflictResolutionReports(
      value.mergeConflictResolutionReports,
      filePath,
    ),
    createdAt: requiredString(value.createdAt, filePath, "createdAt"),
    updatedAt: requiredString(value.updatedAt, filePath, "updatedAt"),
  };
  return {
    ...normalized,
    handoff: normalizeHandoffState(value.handoff, normalized, filePath),
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
  if (value.kind !== "continuation_history" && value.kind !== "issue_breakdown_plan") {
    throw corruptLifecycle(filePath, `summaryReferences[${index}].kind is invalid`);
  }
  const normalized: IssueLifecycleSummaryReference = {
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
  if (value.planId !== undefined) {
    normalized.planId = requiredString(value.planId, filePath, `summaryReferences[${index}].planId`);
  }
  if (value.issueUpdatedAt !== undefined) {
    normalized.issueUpdatedAt = optionalNullableString(value.issueUpdatedAt, filePath, `summaryReferences[${index}].issueUpdatedAt`);
  }
  if (value.issueContentFingerprint !== undefined) {
    normalized.issueContentFingerprint = optionalNullableString(
      value.issueContentFingerprint,
      filePath,
      `summaryReferences[${index}].issueContentFingerprint`,
    );
  }
  if (value.configFingerprint !== undefined) {
    normalized.configFingerprint = optionalNullableString(value.configFingerprint, filePath, `summaryReferences[${index}].configFingerprint`);
  }
  if (value.cursorMode !== undefined) {
    normalized.cursorMode = optionalNullableString(value.cursorMode, filePath, `summaryReferences[${index}].cursorMode`);
  }
  return normalized;
}

function normalizeIssueBreakdownPlans(value: unknown, filePath: string): IssueBreakdownPlanRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw corruptLifecycle(filePath, "issueBreakdownPlans is invalid");
  return value.map((item, index) => normalizeIssueBreakdownPlan(item, filePath, index));
}

function normalizeIssueBreakdownPlan(value: unknown, filePath: string, index: number): IssueBreakdownPlanRecord {
  if (!isRecord(value)) throw corruptLifecycle(filePath, `issueBreakdownPlans[${index}] is invalid`);
  return {
    id: requiredString(value.id, filePath, `issueBreakdownPlans[${index}].id`),
    idempotencyKey: requiredString(value.idempotencyKey, filePath, `issueBreakdownPlans[${index}].idempotencyKey`),
    requestHash:
      value.requestHash === undefined
        ? ""
        : requiredString(value.requestHash, filePath, `issueBreakdownPlans[${index}].requestHash`),
    runId: requiredString(value.runId, filePath, `issueBreakdownPlans[${index}].runId`),
    issueId: requiredString(value.issueId, filePath, `issueBreakdownPlans[${index}].issueId`),
    issueIdentifier: requiredString(value.issueIdentifier, filePath, `issueBreakdownPlans[${index}].issueIdentifier`),
    summary: requiredString(value.summary, filePath, `issueBreakdownPlans[${index}].summary`),
    proposedIssues: normalizeProposedIssues(value.proposedIssues, filePath, index),
    transcriptPointers: requiredStringArray(value.transcriptPointers, filePath, `issueBreakdownPlans[${index}].transcriptPointers`),
    statusApiPointers: requiredStringArray(value.statusApiPointers, filePath, `issueBreakdownPlans[${index}].statusApiPointers`),
    issueUpdatedAt: nullableString(value.issueUpdatedAt, filePath, `issueBreakdownPlans[${index}].issueUpdatedAt`),
    issueContentFingerprint:
      value.issueContentFingerprint === undefined
        ? ""
        : requiredString(
            value.issueContentFingerprint,
            filePath,
            `issueBreakdownPlans[${index}].issueContentFingerprint`,
          ),
    configFingerprint: requiredString(value.configFingerprint, filePath, `issueBreakdownPlans[${index}].configFingerprint`),
    cursorMode: requiredString(value.cursorMode, filePath, `issueBreakdownPlans[${index}].cursorMode`),
    acceptedAt: requiredString(value.acceptedAt, filePath, `issueBreakdownPlans[${index}].acceptedAt`),
    applicationStatus: normalizeIssueBreakdownPlanApplicationStatus(
      value.applicationStatus,
      filePath,
      `issueBreakdownPlans[${index}].applicationStatus`,
    ),
    applicationOperationKeys:
      value.applicationOperationKeys === undefined
        ? []
        : requiredStringArray(value.applicationOperationKeys, filePath, `issueBreakdownPlans[${index}].applicationOperationKeys`),
    createdIssueRefs: normalizeCreatedIssueRefs(value.createdIssueRefs, filePath, index),
    appliedAt:
      value.appliedAt === undefined
        ? null
        : nullableString(value.appliedAt, filePath, `issueBreakdownPlans[${index}].appliedAt`),
    applicationBlockedReason:
      value.applicationBlockedReason === undefined
        ? null
        : nullableString(
            value.applicationBlockedReason,
            filePath,
            `issueBreakdownPlans[${index}].applicationBlockedReason`,
          ),
  };
}

function normalizeProposedIssues(value: unknown, filePath: string, planIndex: number): ProposedIssueRecord[] {
  if (!Array.isArray(value)) throw corruptLifecycle(filePath, `issueBreakdownPlans[${planIndex}].proposedIssues is invalid`);
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw corruptLifecycle(filePath, `issueBreakdownPlans[${planIndex}].proposedIssues[${index}] is invalid`);
    }
    return {
      title: requiredString(item.title, filePath, `issueBreakdownPlans[${planIndex}].proposedIssues[${index}].title`),
      description: requiredString(
        item.description,
        filePath,
        `issueBreakdownPlans[${planIndex}].proposedIssues[${index}].description`,
      ),
      acceptanceCriteria: requiredStringArray(
        item.acceptanceCriteria,
        filePath,
        `issueBreakdownPlans[${planIndex}].proposedIssues[${index}].acceptanceCriteria`,
      ),
      dependencies: requiredStringArray(
        item.dependencies,
        filePath,
        `issueBreakdownPlans[${planIndex}].proposedIssues[${index}].dependencies`,
      ),
      labels: requiredStringArray(item.labels, filePath, `issueBreakdownPlans[${planIndex}].proposedIssues[${index}].labels`),
    };
  });
}

function normalizeIssueBreakdownPlanApplicationStatus(
  value: unknown,
  filePath: string,
  field: string,
): IssueBreakdownPlanApplicationStatus {
  if (value === undefined) return "not_requested";
  if (value === "not_requested" || value === "pending" || value === "applied" || value === "blocked" || value === "stale") {
    return value;
  }
  throw corruptLifecycle(filePath, `${field} is invalid`);
}

function normalizeCreatedIssueRefs(value: unknown, filePath: string, planIndex: number): IssueBreakdownCreatedIssueRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw corruptLifecycle(filePath, `issueBreakdownPlans[${planIndex}].createdIssueRefs is invalid`);
  return value.map((item, index) => {
    if (!isRecord(item)) throw corruptLifecycle(filePath, `issueBreakdownPlans[${planIndex}].createdIssueRefs[${index}] is invalid`);
    const status = item.status;
    if (status !== "created" && status !== "verified") {
      throw corruptLifecycle(filePath, `issueBreakdownPlans[${planIndex}].createdIssueRefs[${index}].status is invalid`);
    }
    return {
      proposedIssueIndex: nonNegativeInteger(
        item.proposedIssueIndex,
        filePath,
        `issueBreakdownPlans[${planIndex}].createdIssueRefs[${index}].proposedIssueIndex`,
      ),
      operationKey: requiredString(
        item.operationKey,
        filePath,
        `issueBreakdownPlans[${planIndex}].createdIssueRefs[${index}].operationKey`,
      ),
      status,
      id: requiredString(item.id, filePath, `issueBreakdownPlans[${planIndex}].createdIssueRefs[${index}].id`),
      identifier: nullableString(
        item.identifier,
        filePath,
        `issueBreakdownPlans[${planIndex}].createdIssueRefs[${index}].identifier`,
      ),
      url: nullableString(item.url, filePath, `issueBreakdownPlans[${planIndex}].createdIssueRefs[${index}].url`),
    };
  });
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

function normalizeMergeConflictResolutionReports(
  value: unknown,
  filePath: string,
): IssueMergeConflictResolutionReportRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw corruptLifecycle(filePath, "mergeConflictResolutionReports is invalid");
  return value.map((item, index) => normalizeMergeConflictResolutionReport(item, filePath, index));
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

function normalizeHandoffState(
  value: unknown,
  record: Omit<IssueLifecycleRecord, "handoff">,
  filePath: string,
): IssueHandoffState {
  if (value === undefined) return buildIssueHandoffState(record);
  if (!isRecord(value)) throw corruptLifecycle(filePath, "handoff is invalid");
  if (value.version !== 1) throw corruptLifecycle(filePath, "handoff.version is invalid");
  return {
    version: 1,
    memo: normalizeLaneMemo(value.memo, filePath),
    lastWorkerOutput: normalizeWorkerOutputContract(value.lastWorkerOutput, filePath),
    lastReviewerOutput: normalizeReviewerOutputContract(value.lastReviewerOutput, filePath),
  };
}

function normalizeLaneMemo(value: unknown, filePath: string): IssueLaneMemo {
  if (!isRecord(value)) throw corruptLifecycle(filePath, "handoff.memo is invalid");
  if (value.version !== 1) throw corruptLifecycle(filePath, "handoff.memo.version is invalid");
  return {
    version: 1,
    issueId: requiredString(value.issueId, filePath, "handoff.memo.issueId"),
    issueIdentifier: requiredString(value.issueIdentifier, filePath, "handoff.memo.issueIdentifier"),
    updatedAt: requiredString(value.updatedAt, filePath, "handoff.memo.updatedAt"),
    reviewRound: nonNegativeInteger(value.reviewRound, filePath, "handoff.memo.reviewRound"),
    incompleteTurnCount: nonNegativeInteger(value.incompleteTurnCount, filePath, "handoff.memo.incompleteTurnCount"),
    sizeChars:
      value.sizeChars === undefined
        ? JSON.stringify(value).length
        : nonNegativeInteger(value.sizeChars, filePath, "handoff.memo.sizeChars"),
    entries: requiredStringArray(value.entries, filePath, "handoff.memo.entries"),
    openFindings: requiredStringArray(value.openFindings, filePath, "handoff.memo.openFindings"),
    pointers: normalizeSummaryPointers(value.pointers, filePath),
    lastWorkerRunId: nullableString(value.lastWorkerRunId, filePath, "handoff.memo.lastWorkerRunId"),
    lastReviewerRunId: nullableString(value.lastReviewerRunId, filePath, "handoff.memo.lastReviewerRunId"),
  };
}

function normalizeWorkerOutputContract(value: unknown, filePath: string): IssueWorkerOutputContract | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw corruptLifecycle(filePath, "handoff.lastWorkerOutput is invalid");
  if (value.version !== 1) throw corruptLifecycle(filePath, "handoff.lastWorkerOutput.version is invalid");
  return {
    version: 1,
    reportId: requiredString(value.reportId, filePath, "handoff.lastWorkerOutput.reportId"),
    runId: requiredString(value.runId, filePath, "handoff.lastWorkerOutput.runId"),
    summary: requiredString(value.summary, filePath, "handoff.lastWorkerOutput.summary"),
    changedFiles: requiredStringArray(value.changedFiles, filePath, "handoff.lastWorkerOutput.changedFiles"),
    validationEvidence: requiredStringArray(value.validationEvidence, filePath, "handoff.lastWorkerOutput.validationEvidence"),
    risks: requiredStringArray(value.risks, filePath, "handoff.lastWorkerOutput.risks"),
    pullRequest: normalizePullRequest(value.pullRequest, filePath, 0),
    acceptedAt: requiredString(value.acceptedAt, filePath, "handoff.lastWorkerOutput.acceptedAt"),
  };
}

function normalizeReviewerOutputContract(value: unknown, filePath: string): IssueReviewerOutputContract | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw corruptLifecycle(filePath, "handoff.lastReviewerOutput is invalid");
  if (value.version !== 1) throw corruptLifecycle(filePath, "handoff.lastReviewerOutput.version is invalid");
  const verdict = value.verdict;
  if (verdict !== "pass" && verdict !== "fail") {
    throw corruptLifecycle(filePath, "handoff.lastReviewerOutput.verdict is invalid");
  }
  return {
    version: 1,
    verdictId: requiredString(value.verdictId, filePath, "handoff.lastReviewerOutput.verdictId"),
    runId: requiredString(value.runId, filePath, "handoff.lastReviewerOutput.runId"),
    verdict,
    findings: requiredStringArray(value.findings, filePath, "handoff.lastReviewerOutput.findings"),
    acceptanceResults: normalizeReviewVerdictAcceptanceResults(value.acceptanceResults, filePath, 0),
    evidence: requiredStringArray(value.evidence, filePath, "handoff.lastReviewerOutput.evidence"),
    submittedAt: requiredString(value.submittedAt, filePath, "handoff.lastReviewerOutput.submittedAt"),
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

function normalizeMergeGateState(value: unknown, filePath: string): IssueMergeGateState | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw corruptLifecycle(filePath, "mergeGate is invalid");
  const status = value.status;
  if (!isMergeGateStatus(status)) throw corruptLifecycle(filePath, "mergeGate.status is invalid");
  return {
    id: requiredString(value.id, filePath, "mergeGate.id"),
    status,
    headSha: requiredString(value.headSha, filePath, "mergeGate.headSha"),
    pullRequest: normalizeMergeGatePullRequest(value.pullRequest, filePath),
    requiredChecks: requiredStringArray(value.requiredChecks, filePath, "mergeGate.requiredChecks"),
    checks: normalizeMergeGateChecks(value.checks, filePath),
    reviewRound: nonNegativeInteger(value.reviewRound, filePath, "mergeGate.reviewRound"),
    gateRunId: optionalNullableString(value.gateRunId, filePath, "mergeGate.gateRunId"),
    gateReportId: optionalNullableString(value.gateReportId, filePath, "mergeGate.gateReportId"),
    repairRunId: optionalNullableString(value.repairRunId, filePath, "mergeGate.repairRunId"),
    repairReportId: optionalNullableString(value.repairReportId, filePath, "mergeGate.repairReportId"),
    blockerFingerprint: optionalNullableString(value.blockerFingerprint, filePath, "mergeGate.blockerFingerprint"),
    writebackOperationKeys: requiredStringArray(value.writebackOperationKeys, filePath, "mergeGate.writebackOperationKeys"),
    supersededByHeadSha: optionalNullableString(value.supersededByHeadSha, filePath, "mergeGate.supersededByHeadSha"),
    updatedAt: requiredString(value.updatedAt, filePath, "mergeGate.updatedAt"),
  };
}

function normalizeMergeGateChecks(value: unknown, filePath: string): IssueMergeGateCheckState[] {
  if (!Array.isArray(value)) throw corruptLifecycle(filePath, "mergeGate.checks is invalid");
  return value.map((item, index) => {
    if (!isRecord(item)) throw corruptLifecycle(filePath, `mergeGate.checks[${index}] is invalid`);
    const outcome = item.outcome;
    if (!isMergeGateCheckOutcome(outcome)) throw corruptLifecycle(filePath, `mergeGate.checks[${index}].outcome is invalid`);
    const rawStatus = item.rawStatus;
    if (!isMergeGateRawCheckStatus(rawStatus)) throw corruptLifecycle(filePath, `mergeGate.checks[${index}].rawStatus is invalid`);
    return {
      name: requiredString(item.name, filePath, `mergeGate.checks[${index}].name`),
      outcome,
      rawStatus,
      conclusion: optionalNullableString(item.conclusion, filePath, `mergeGate.checks[${index}].conclusion`),
      url: optionalNullableString(item.url, filePath, `mergeGate.checks[${index}].url`),
      firstObservedAt: optionalNullableString(item.firstObservedAt, filePath, `mergeGate.checks[${index}].firstObservedAt`),
      actionableSince: optionalNullableString(item.actionableSince, filePath, `mergeGate.checks[${index}].actionableSince`),
    };
  });
}

function normalizeMergeGatePullRequest(value: unknown, filePath: string): CompletionReportPullRequestRef {
  if (!isRecord(value)) throw corruptLifecycle(filePath, "mergeGate.pullRequest is invalid");
  return {
    url: nullableString(value.url, filePath, "mergeGate.pullRequest.url"),
    number: nullableNumber(value.number, filePath, "mergeGate.pullRequest.number"),
    headSha: optionalNullableString(value.headSha, filePath, "mergeGate.pullRequest.headSha"),
    branch: optionalNullableString(value.branch, filePath, "mergeGate.pullRequest.branch"),
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

function normalizeMergeConflictMetadata(value: unknown, filePath: string): IssueMergeConflictMetadata | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw corruptLifecycle(filePath, "mergeConflict is invalid");
  const status = value.status;
  if (status !== "open" && status !== "resolved" && status !== "blocked") {
    throw corruptLifecycle(filePath, "mergeConflict.status is invalid");
  }
  const resolutionStatus = value.resolutionStatus;
  if (
    resolutionStatus !== "pending" &&
    resolutionStatus !== "still_conflicted" &&
    resolutionStatus !== "resolved" &&
    resolutionStatus !== "blocked"
  ) {
    throw corruptLifecycle(filePath, "mergeConflict.resolutionStatus is invalid");
  }
  return {
    id: requiredString(value.id, filePath, "mergeConflict.id"),
    status,
    resolutionStatus,
    pullRequest: normalizeMergePullRequest(value.pullRequest, filePath, "mergeConflict.pullRequest"),
    approvedHeadSha: requiredString(value.approvedHeadSha, filePath, "mergeConflict.approvedHeadSha"),
    currentHeadSha: requiredString(value.currentHeadSha, filePath, "mergeConflict.currentHeadSha"),
    resolvedHeadSha: optionalNullableString(value.resolvedHeadSha, filePath, "mergeConflict.resolvedHeadSha"),
    baseBranch: optionalNullableString(value.baseBranch, filePath, "mergeConflict.baseBranch"),
    baseHeadSha: optionalNullableString(value.baseHeadSha, filePath, "mergeConflict.baseHeadSha"),
    sourceState: requiredString(value.sourceState, filePath, "mergeConflict.sourceState"),
    conflictsState: requiredString(value.conflictsState, filePath, "mergeConflict.conflictsState"),
    reason: requiredString(value.reason, filePath, "mergeConflict.reason"),
    mergeableState: optionalNullableString(value.mergeableState, filePath, "mergeConflict.mergeableState"),
    detectedAt: requiredString(value.detectedAt, filePath, "mergeConflict.detectedAt"),
    updatedAt: requiredString(value.updatedAt, filePath, "mergeConflict.updatedAt"),
    fixTurnCount: nonNegativeInteger(value.fixTurnCount, filePath, "mergeConflict.fixTurnCount"),
    maxFixTurns: nonNegativeInteger(value.maxFixTurns, filePath, "mergeConflict.maxFixTurns"),
    lastConflictFixRunId: optionalNullableString(
      value.lastConflictFixRunId,
      filePath,
      "mergeConflict.lastConflictFixRunId",
    ),
    lastConflictResolutionReportId: optionalNullableString(
      value.lastConflictResolutionReportId,
      filePath,
      "mergeConflict.lastConflictResolutionReportId",
    ),
    attemptRunIds: value.attemptRunIds === undefined ? [] : requiredStringArray(value.attemptRunIds, filePath, "mergeConflict.attemptRunIds"),
    writebackOperationKeys:
      value.writebackOperationKeys === undefined
        ? []
        : requiredStringArray(value.writebackOperationKeys, filePath, "mergeConflict.writebackOperationKeys"),
    blockedAt: optionalNullableString(value.blockedAt, filePath, "mergeConflict.blockedAt"),
    blockedReason: optionalNullableString(value.blockedReason, filePath, "mergeConflict.blockedReason"),
  };
}

function normalizeMergeConflictResolutionReport(
  value: unknown,
  filePath: string,
  index: number,
): IssueMergeConflictResolutionReportRecord {
  if (!isRecord(value)) throw corruptLifecycle(filePath, `mergeConflictResolutionReports[${index}] is invalid`);
  const resolutionStatus = value.resolutionStatus;
  if (resolutionStatus !== "resolved" && resolutionStatus !== "still_conflicted" && resolutionStatus !== "blocked") {
    throw corruptLifecycle(filePath, `mergeConflictResolutionReports[${index}].resolutionStatus is invalid`);
  }
  return {
    id: requiredString(value.id, filePath, `mergeConflictResolutionReports[${index}].id`),
    idempotencyKey: requiredString(value.idempotencyKey, filePath, `mergeConflictResolutionReports[${index}].idempotencyKey`),
    runId: requiredString(value.runId, filePath, `mergeConflictResolutionReports[${index}].runId`),
    issueId: requiredString(value.issueId, filePath, `mergeConflictResolutionReports[${index}].issueId`),
    issueIdentifier: requiredString(value.issueIdentifier, filePath, `mergeConflictResolutionReports[${index}].issueIdentifier`),
    resolutionStatus,
    summary: requiredString(value.summary, filePath, `mergeConflictResolutionReports[${index}].summary`),
    validationEvidence: requiredStringArray(value.validationEvidence, filePath, `mergeConflictResolutionReports[${index}].validationEvidence`),
    changedFiles: requiredStringArray(value.changedFiles, filePath, `mergeConflictResolutionReports[${index}].changedFiles`),
    pullRequest: normalizeMergePullRequest(
      value.pullRequest,
      filePath,
      `mergeConflictResolutionReports[${index}].pullRequest`,
    ),
    previousHeadSha: optionalNullableString(
      value.previousHeadSha,
      filePath,
      `mergeConflictResolutionReports[${index}].previousHeadSha`,
    ),
    newHeadSha:
      value.newHeadSha === undefined
        ? normalizeMergePullRequest(
            value.pullRequest,
            filePath,
            `mergeConflictResolutionReports[${index}].pullRequest`,
          ).headSha
        : optionalNullableString(value.newHeadSha, filePath, `mergeConflictResolutionReports[${index}].newHeadSha`),
    baseBranch: optionalNullableString(value.baseBranch, filePath, `mergeConflictResolutionReports[${index}].baseBranch`),
    baseHeadSha: optionalNullableString(value.baseHeadSha, filePath, `mergeConflictResolutionReports[${index}].baseHeadSha`),
    blockedReason: optionalNullableString(
      value.blockedReason,
      filePath,
      `mergeConflictResolutionReports[${index}].blockedReason`,
    ),
    risks: requiredStringArray(value.risks, filePath, `mergeConflictResolutionReports[${index}].risks`),
    submittedAt: requiredString(value.submittedAt, filePath, `mergeConflictResolutionReports[${index}].submittedAt`),
  };
}

function normalizeMergePullRequest(
  value: unknown,
  filePath: string,
  field = "merge.pullRequest",
): CompletionReportPullRequestRef {
  if (!isRecord(value)) throw corruptLifecycle(filePath, `${field} is invalid`);
  return {
    url: nullableString(value.url, filePath, `${field}.url`),
    number: nullableNumber(value.number, filePath, `${field}.number`),
    headSha: optionalNullableString(value.headSha, filePath, `${field}.headSha`),
    branch: optionalNullableString(value.branch, filePath, `${field}.branch`),
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
    value === "merge_conflict_resolution" ||
    value === "review" ||
    value === "passed" ||
    value === "blocked" ||
    value === "terminal" ||
    value === "unknown"
  );
}

function isMergeGateStatus(value: unknown): value is IssueMergeGateStatus {
  return (
    value === "observing" ||
    value === "repair_dispatched" ||
    value === "blocked" ||
    value === "resolved" ||
    value === "superseded"
  );
}

function isMergeGateCheckOutcome(value: unknown): value is IssueMergeGateCheckOutcome {
  return (
    value === "passing" ||
    value === "pending" ||
    value === "missing_observed" ||
    value === "missing_actionable" ||
    value === "failing" ||
    value === "unknown"
  );
}

function isMergeGateRawCheckStatus(value: unknown): value is IssueMergeGateRawCheckStatus {
  return value === "success" || value === "failure" || value === "pending" || value === "missing" || value === "unknown";
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

import type {
  CompletionReportPullRequestRef,
  IssueCompletionReportRecord,
  IssueLifecycleRecord,
  IssueLifecycleStore,
  PullRequestReviewEvidenceItem,
  PullRequestReviewEvidenceState,
  PullRequestReviewEvidenceSource,
} from "../persistence/IssueLifecycleStore.js";
import type { Issue } from "../types.js";

export interface PullRequestReviewEvidenceClient {
  listPullRequestReviewEvidence(input: { pullRequestNumber: number }): Promise<RemotePullRequestReviewEvidence[]>;
}

export interface RemotePullRequestReviewEvidence {
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
}

export interface PullRequestReviewEvidenceIngestionResult {
  lifecycle: IssueLifecycleRecord;
  pullRequest: CompletionReportPullRequestRef;
  ingested: PullRequestReviewEvidenceItem[];
  newItems: PullRequestReviewEvidenceItem[];
}

export interface WorkerReviewEvidencePromptContext {
  pullRequest: CompletionReportPullRequestRef;
  verdict: "fail" | "feedback";
  acceptanceCriteriaGaps: string[];
  evidence: PullRequestReviewEvidenceItem[];
}

export class PullRequestReviewEvidenceService {
  constructor(
    private readonly options: {
      lifecycleStore: IssueLifecycleStore;
      client: PullRequestReviewEvidenceClient;
      fullHistoryThreshold: number;
    },
  ) {}

  async ingestForIssue(issue: Pick<Issue, "id" | "identifier">): Promise<PullRequestReviewEvidenceIngestionResult | null> {
    const lifecycle = await this.options.lifecycleStore.get(issue.id);
    if (!lifecycle) return null;
    const pullRequest = pullRequestForLifecycle(lifecycle);
    if (!pullRequest?.number) return null;

    const remote = await this.options.client.listPullRequestReviewEvidence({ pullRequestNumber: pullRequest.number });
    const existing = lifecycle.reviewEvidence.items;
    const ingested = remote
      .map((item) => normalizeRemoteEvidence(item, pullRequest))
      .filter((item): item is PullRequestReviewEvidenceItem => item !== null);
    const merged = mergeEvidence(existing, ingested);
    const updated = await this.options.lifecycleStore.updateIssue(issue, {
      reviewEvidence: {
        pullRequest,
        lastIngestedCursor: latestCursor(merged),
        lastWorkerEvidenceCursor: lifecycle.reviewEvidence.lastWorkerEvidenceCursor,
        items: merged,
        updatedAt: new Date().toISOString(),
      },
    });

    return {
      lifecycle: updated,
      pullRequest,
      ingested,
      newItems: ingested.filter((item) => !existing.some((existingItem) => sameEvidence(existingItem, item))),
    };
  }

  async prepareWorkerPromptContext(
    issue: Pick<Issue, "id" | "identifier">,
  ): Promise<WorkerReviewEvidencePromptContext | null> {
    const ingestion = await this.ingestForIssue(issue);
    if (!ingestion) return null;
    const context = buildWorkerReviewEvidencePromptContext(ingestion.lifecycle, this.options.fullHistoryThreshold);
    if (!context || context.evidence.length === 0) return null;
    await this.markWorkerEvidenceDelivered(issue, context.evidence);
    return context;
  }

  async markWorkerEvidenceDelivered(
    issue: Pick<Issue, "id" | "identifier">,
    evidence: PullRequestReviewEvidenceItem[],
  ): Promise<void> {
    const lifecycle = await this.options.lifecycleStore.get(issue.id);
    if (!lifecycle || evidence.length === 0) return;
    await this.options.lifecycleStore.updateIssue(issue, {
      reviewEvidence: {
        ...lifecycle.reviewEvidence,
        lastWorkerEvidenceCursor: latestCursor(evidence),
        updatedAt: new Date().toISOString(),
      },
    });
  }
}

export function buildWorkerReviewEvidencePromptContext(
  lifecycle: IssueLifecycleRecord,
  fullHistoryThreshold: number,
): WorkerReviewEvidencePromptContext | null {
  const pullRequest = lifecycle.reviewEvidence.pullRequest ?? pullRequestForLifecycle(lifecycle);
  if (!pullRequest) return null;
  const visibleEvidence = selectEvidenceForWorker(lifecycle.reviewEvidence, fullHistoryThreshold);
  if (visibleEvidence.length === 0) return null;
  const activeEvidence = activeReviewEvidence(lifecycle.reviewEvidence);
  return {
    pullRequest,
    verdict: activeEvidence.some((item) => item.state === "CHANGES_REQUESTED") ? "fail" : "feedback",
    acceptanceCriteriaGaps: acceptanceCriteriaGaps(latestCompletionReport(lifecycle)),
    evidence: visibleEvidence,
  };
}

export function selectEvidenceForWorker(
  state: PullRequestReviewEvidenceState,
  fullHistoryThreshold: number,
): PullRequestReviewEvidenceItem[] {
  const active = activeReviewEvidence(state);
  if (active.length <= fullHistoryThreshold) return active;
  const cursor = state.lastWorkerEvidenceCursor;
  if (!cursor) return active;
  return active.filter((item) => compareCursor(item.cursor, cursor) > 0 || item.isResolved === false);
}

function activeReviewEvidence(state: PullRequestReviewEvidenceState): PullRequestReviewEvidenceItem[] {
  return state.items.filter((item) => item.body.trim().length > 0 && item.isResolved !== true && item.isOutdated !== true);
}

export function formatWorkerReviewEvidencePrompt(context: WorkerReviewEvidencePromptContext): string {
  const lines = [
    "",
    "PR review feedback to address before submitting another completion report:",
    `Reviewer verdict: ${context.verdict === "fail" ? "fail / requested changes" : "feedback"}`,
    `Pull request: ${formatPullRequest(context.pullRequest)}`,
    "",
    "Acceptance criteria gaps:",
    ...(context.acceptanceCriteriaGaps.length === 0
      ? ["- No explicit acceptance criteria gaps were recorded."]
      : context.acceptanceCriteriaGaps.map((gap) => `- ${gap}`)),
    "",
    "GitHub PR review evidence:",
    ...context.evidence.flatMap(formatEvidenceItem),
  ];
  return lines.join("\n");
}

export function summarizeReviewEvidenceForLinear(evidence: PullRequestReviewEvidenceItem[]): string[] {
  const active = evidence.filter((item) => item.isResolved !== true && item.isOutdated !== true);
  if (active.length === 0) return ["No active PR review evidence was found."];
  return active.map((item) => {
    const location = evidenceLocation(item);
    const link = item.url ?? item.pullRequestUrl ?? "n/a";
    return `${item.source}${location === "PR" ? "" : ` ${location}`}: ${oneLine(item.body).slice(0, 160)} (${link})`;
  });
}

function normalizeRemoteEvidence(
  item: RemotePullRequestReviewEvidence,
  pullRequest: CompletionReportPullRequestRef,
): PullRequestReviewEvidenceItem | null {
  const body = item.body.trim();
  if (body.length === 0) return null;
  return {
    id: `${item.source}:${item.pullRequestNumber}:${item.githubId}`,
    source: item.source,
    githubId: item.githubId,
    pullRequestNumber: item.pullRequestNumber,
    pullRequestUrl: pullRequest.url ?? item.pullRequestUrl,
    url: item.url,
    reviewer: item.reviewer,
    body,
    state: item.state,
    path: item.path,
    line: item.line,
    originalLine: item.originalLine,
    side: item.side,
    threadId: item.threadId,
    inReplyToId: item.inReplyToId,
    isResolved: item.isResolved,
    isOutdated: item.isOutdated,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    submittedAt: item.submittedAt,
    cursor: evidenceCursor(item),
  };
}

function mergeEvidence(
  existing: PullRequestReviewEvidenceItem[],
  ingested: PullRequestReviewEvidenceItem[],
): PullRequestReviewEvidenceItem[] {
  const byId = new Map(existing.map((item) => [item.id, item]));
  for (const item of ingested) {
    byId.set(item.id, { ...byId.get(item.id), ...item });
  }
  return [...byId.values()].sort((left, right) => compareCursor(left.cursor, right.cursor) || left.id.localeCompare(right.id));
}

function pullRequestForLifecycle(lifecycle: IssueLifecycleRecord): CompletionReportPullRequestRef | null {
  const reportPullRequest = latestCompletionReport(lifecycle)?.pullRequest ?? null;
  if (reportPullRequest?.number) return reportPullRequest;
  if (lifecycle.summaryPointers.prNumber === null) return null;
  return {
    url: lifecycle.summaryPointers.prUrl,
    number: lifecycle.summaryPointers.prNumber,
    headSha: lifecycle.summaryPointers.prHeadSha,
    branch: lifecycle.summaryPointers.prBranch ?? lifecycle.summaryPointers.gitBranchName,
  };
}

function latestCompletionReport(lifecycle: IssueLifecycleRecord): IssueCompletionReportRecord | null {
  if (lifecycle.lastCompletionReportId) {
    const exact = lifecycle.completionReports.find((report) => report.id === lifecycle.lastCompletionReportId);
    if (exact) return exact;
  }
  return lifecycle.completionReports[lifecycle.completionReports.length - 1] ?? null;
}

function acceptanceCriteriaGaps(report: IssueCompletionReportRecord | null): string[] {
  return (
    report?.acceptanceChecklist
      .filter((item) => !item.satisfied)
      .map((item) => `${item.text}${item.evidence === null ? "" : ` (${item.evidence})`}`) ?? []
  );
}

function latestCursor(items: PullRequestReviewEvidenceItem[]): string | null {
  return items.reduce<string | null>((latest, item) => (latest === null || compareCursor(item.cursor, latest) > 0 ? item.cursor : latest), null);
}

function evidenceCursor(item: RemotePullRequestReviewEvidence): string {
  return item.updatedAt ?? item.submittedAt ?? item.createdAt ?? `${item.source}:${item.pullRequestNumber}:${item.githubId}`;
}

function compareCursor(left: string, right: string): number {
  return left.localeCompare(right);
}

function sameEvidence(left: PullRequestReviewEvidenceItem, right: PullRequestReviewEvidenceItem): boolean {
  return left.id === right.id;
}

function formatPullRequest(pullRequest: CompletionReportPullRequestRef): string {
  const parts = [
    pullRequest.number === null ? null : `#${pullRequest.number}`,
    pullRequest.url === null ? null : pullRequest.url,
  ].filter((value): value is string => value !== null);
  return parts.length === 0 ? "n/a" : parts.join(" ");
}

function formatEvidenceItem(item: PullRequestReviewEvidenceItem): string[] {
  return [
    `- ${item.source} by ${item.reviewer ?? "unknown"} (${evidenceLocation(item)})`,
    `  Link: ${item.url ?? item.pullRequestUrl ?? "n/a"}`,
    `  State: ${item.state ?? "n/a"}; thread: ${item.threadId ?? "n/a"}; cursor: ${item.cursor}`,
    `  Body: ${item.body}`,
  ];
}

function evidenceLocation(item: PullRequestReviewEvidenceItem): string {
  if (!item.path) return "PR";
  const line = item.line ?? item.originalLine;
  const lineSuffix = line === null ? "" : `:${line}`;
  return `${item.path}${lineSuffix}`;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

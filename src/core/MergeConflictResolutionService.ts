import { z } from "zod";
import type { ServiceConfig } from "./config/Config.js";
import {
  normalizeProjectContextResolution,
  projectContextResolutionFromIssue,
  type ProjectContextResolution,
} from "./config/ProjectContexts.js";
import { SymphonyError } from "./errors.js";
import type {
  CompletionReportPullRequestRef,
  IssueLifecycleStore,
  IssueMergeConflictMetadata,
  IssueMergeConflictResolutionReportRecord,
} from "./persistence/IssueLifecycleStore.js";
import type { Issue, Workspace } from "./types.js";
import { planBlockedEscalationWritebacks } from "./writeback/TransitionPolicy.js";
import type {
  FileWritebackOutboxStore,
  WritebackOperation,
  WritebackProcessor,
} from "./writeback/WritebackOutbox.js";

const mergeConflictResolutionSchema = z.object({
  runId: z.string().trim().min(1),
  issueId: z.string().trim().min(1),
  resolutionStatus: z.enum(["resolved", "still_conflicted", "blocked"]),
  summary: z.string().trim().min(1),
  validationEvidence: z.array(z.string().trim().min(1)).min(1),
  changedFiles: z.array(z.string().trim().min(1)),
  pullRequest: z.object({
    url: z.string().trim().min(1).nullable(),
    number: z.number().int().positive().nullable(),
    headSha: z.string().trim().min(1),
    branch: z.string().trim().min(1).nullable(),
  }),
  previousHeadSha: z.string().trim().min(1),
  newHeadSha: z.string().trim().min(1),
  baseBranch: z.string().trim().min(1),
  baseHeadSha: z.string().trim().min(1),
  blockedReason: z.string().trim().min(1).nullable().optional(),
  risks: z.array(z.string().trim().min(1)),
  idempotencyKey: z.string().trim().min(1),
});

export type MergeConflictResolutionInput = z.infer<typeof mergeConflictResolutionSchema>;
export type MergeConflictResolutionSubmitterRole = "worker" | string;

export interface MergeConflictResolutionActiveContext {
  issue: Issue;
  projectContext?: ProjectContextResolution | undefined;
  activeRunId: string;
  role: MergeConflictResolutionSubmitterRole;
  token?: string | null;
  expectedToken?: string | null;
  sessionId?: string | null;
  workspacePath?: string | null;
  workspace?: Workspace | null;
  phase?: "merge_conflict_resolution" | null;
}

export interface MergeConflictResolutionServiceOptions {
  config: ServiceConfig;
  lifecycleStore: IssueLifecycleStore;
  writebackOutbox: Pick<FileWritebackOutboxStore, "enqueueOnce">;
  writebackProcessor?: Pick<WritebackProcessor, "processDue">;
}

export interface MergeConflictResolutionResult {
  accepted: true;
  replayed: boolean;
  report: IssueMergeConflictResolutionReportRecord;
  mergeConflict: IssueMergeConflictMetadata;
  writebackOperations: WritebackOperation[];
}

export class MergeConflictResolutionService {
  constructor(private readonly options: MergeConflictResolutionServiceOptions) {}

  async submit_merge_conflict_resolution(
    input: unknown,
    context: MergeConflictResolutionActiveContext,
  ): Promise<MergeConflictResolutionResult> {
    return this.submitMergeConflictResolution(input, context);
  }

  async submitMergeConflictResolution(
    input: unknown,
    context: MergeConflictResolutionActiveContext,
  ): Promise<MergeConflictResolutionResult> {
    const report = parseMergeConflictResolution(input);
    this.validateCaller(report, context);
    this.validateConflictState(context);

    const lifecycle = await this.options.lifecycleStore.get(context.issue.id);
    const mergeConflict = lifecycle?.mergeConflict ?? null;
    const existing = lifecycle?.mergeConflictResolutionReports.find((item) => item.idempotencyKey === report.idempotencyKey);
    if (existing && mergeConflict) {
      assertPullRequestMatchesConflict(report.pullRequest, mergeConflict);
      assertReportMatchesConflict(report, mergeConflict);
      assertReplayMatchesReport(report, existing);
      return { accepted: true, replayed: true, report: existing, mergeConflict, writebackOperations: [] };
    }
    if (!lifecycle || !mergeConflict || mergeConflict.status === "blocked") {
      throw new SymphonyError("invalid_request", "Merge conflict resolution requires an open merge conflict lifecycle record");
    }

    assertPullRequestMatchesConflict(report.pullRequest, mergeConflict);
    assertReportMatchesConflict(report, mergeConflict);
    const storedReport = buildMergeConflictResolutionReport({
      report,
      issue: context.issue,
      projectContext: resolveMergeConflictProjectContext(context, lifecycle),
    });
    const now = new Date().toISOString();
    const countedRunIds = new Set(mergeConflict.attemptRunIds);
    const shouldCountAttempt = report.resolutionStatus !== "resolved" && !countedRunIds.has(report.runId);
    if (shouldCountAttempt) countedRunIds.add(report.runId);
    const fixTurnCount = mergeConflict.fixTurnCount + (shouldCountAttempt ? 1 : 0);
    const blocked =
      report.resolutionStatus === "blocked" ||
      (report.resolutionStatus === "still_conflicted" && fixTurnCount >= mergeConflict.maxFixTurns);
    const blockedReason = blocked
      ? report.blockedReason ?? conflictBlockedReason(fixTurnCount, mergeConflict.maxFixTurns)
      : null;
    const nextConflict: IssueMergeConflictMetadata = {
      ...mergeConflict,
      status: blocked ? "blocked" : report.resolutionStatus === "resolved" ? "resolved" : "open",
      resolutionStatus: blocked ? "blocked" : report.resolutionStatus,
      pullRequest: { ...report.pullRequest },
      currentHeadSha: report.newHeadSha,
      resolvedHeadSha: report.resolutionStatus === "resolved" ? report.newHeadSha : mergeConflict.resolvedHeadSha,
      baseBranch: report.baseBranch,
      baseHeadSha: report.baseHeadSha,
      updatedAt: now,
      fixTurnCount,
      lastConflictFixRunId: report.runId,
      lastConflictResolutionReportId: storedReport.id,
      attemptRunIds: [...countedRunIds],
      blockedAt: blocked ? now : mergeConflict.blockedAt,
      blockedReason,
    };

    const writebackOperations = blocked ? await this.enqueueBlockedWritebacks(context, nextConflict) : [];
    const updated = await this.options.lifecycleStore.updateIssue(context.issue, {
      projectContext: resolveMergeConflictProjectContext(context, lifecycle),
      phase: blocked ? "blocked" : report.resolutionStatus === "resolved" ? "passed" : "merge_conflict_resolution",
      blockedReason: blocked ? nextConflict.blockedReason : null,
      mergeConflict: {
        ...nextConflict,
        writebackOperationKeys: writebackOperations.map((operation) => operation.idempotencyKey),
      },
      mergeConflictResolutionReports: upsertMergeConflictResolutionReport(
        lifecycle.mergeConflictResolutionReports,
        storedReport,
      ),
      summaryPointers: {
        lastRunId: report.runId,
        prUrl: report.pullRequest.url,
        prNumber: report.pullRequest.number,
        prHeadSha: report.pullRequest.headSha,
        prBranch: report.pullRequest.branch,
        lastEvidenceCursor: report.idempotencyKey,
      },
    });

    await this.options.writebackProcessor?.processDue();
    return {
      accepted: true,
      replayed: false,
      report: storedReport,
      mergeConflict: updated.mergeConflict ?? nextConflict,
      writebackOperations,
    };
  }

  private validateCaller(report: MergeConflictResolutionInput, context: MergeConflictResolutionActiveContext): void {
    if (context.role !== "worker") {
      throw new SymphonyError("invalid_request", "Only active conflict-fix workers may submit merge conflict resolutions");
    }
    if (context.expectedToken !== undefined && context.expectedToken !== null && context.token !== context.expectedToken) {
      throw new SymphonyError("invalid_request", "Missing or invalid merge conflict resolution token");
    }
    if (report.runId !== context.activeRunId) {
      throw new SymphonyError("invalid_request", "Merge conflict resolution run does not match the active worker run");
    }
    if (report.issueId !== context.issue.id && report.issueId !== context.issue.identifier) {
      throw new SymphonyError("invalid_request", "Merge conflict resolution issue does not match the active worker issue");
    }
  }

  private validateConflictState(context: MergeConflictResolutionActiveContext): void {
    const conflictsState = this.options.config.mergePolicy.conflictsState;
    if (
      this.options.config.mergePolicy.mode !== "gated" ||
      conflictsState === null ||
      !sameState(context.issue.state, conflictsState)
    ) {
      throw new SymphonyError("invalid_request", "Merge conflict resolution requires the configured conflict-fix state");
    }
    if (context.phase !== undefined && context.phase !== null && context.phase !== "merge_conflict_resolution") {
      throw new SymphonyError("invalid_request", `Merge conflict resolution cannot be accepted while lifecycle phase is ${context.phase}`);
    }
  }

  private async enqueueBlockedWritebacks(
    context: MergeConflictResolutionActiveContext,
    mergeConflict: IssueMergeConflictMetadata,
  ): Promise<WritebackOperation[]> {
    const operations = planBlockedEscalationWritebacks(
      {
        issue: context.issue,
        projectContext: resolveMergeConflictProjectContext(context),
        runId: context.activeRunId,
        reason: mergeConflict.blockedReason ?? conflictBlockedReason(mergeConflict.fixTurnCount, mergeConflict.maxFixTurns),
        requiredAction: [
          "Merge conflicts remain unresolved after the configured conflict-fix attempts.",
          `Pull request: ${formatPullRequest(mergeConflict.pullRequest)}`,
          `Approved head SHA: ${mergeConflict.approvedHeadSha}`,
          `Latest reported head SHA: ${mergeConflict.currentHeadSha}`,
          "Inspect the branch, resolve conflicts manually or reset approval, then move the issue when Symphony should continue.",
        ].join("\n"),
      },
      this.options.config,
    );
    const enqueued: WritebackOperation[] = [];
    for (const operation of operations) enqueued.push(await this.options.writebackOutbox.enqueueOnce(operation));
    return enqueued;
  }
}

function parseMergeConflictResolution(input: unknown): MergeConflictResolutionInput {
  const parsed = mergeConflictResolutionSchema.safeParse(input);
  if (!parsed.success) {
    throw new SymphonyError("invalid_request", "Merge conflict resolution report is invalid", parsed.error.flatten());
  }
  return parsed.data;
}


function resolveMergeConflictProjectContext(
  context: MergeConflictResolutionActiveContext,
  lifecycle: IssueLifecycleStore extends { get(issueIdOrIdentifier: string): Promise<infer T> } ? T | null : never = null,
): ProjectContextResolution {
  return normalizeProjectContextResolution(
    context.projectContext ?? lifecycle?.projectContext ?? projectContextResolutionFromIssue(context.issue),
  );
}

function buildMergeConflictResolutionReport(input: {
  report: MergeConflictResolutionInput;
  issue: Issue;
  projectContext: ProjectContextResolution;
}): IssueMergeConflictResolutionReportRecord {
  return {
    id: `merge-conflict-resolution:${input.issue.id}:${input.report.idempotencyKey}`,
    idempotencyKey: input.report.idempotencyKey,
    runId: input.report.runId,
    issueId: input.issue.id,
    issueIdentifier: input.issue.identifier,
    projectContext: input.projectContext,
    resolutionStatus: input.report.resolutionStatus,
    summary: input.report.summary,
    validationEvidence: input.report.validationEvidence,
    changedFiles: input.report.changedFiles,
    pullRequest: input.report.pullRequest,
    previousHeadSha: input.report.previousHeadSha,
    newHeadSha: input.report.newHeadSha,
    baseBranch: input.report.baseBranch,
    baseHeadSha: input.report.baseHeadSha,
    blockedReason: input.report.resolutionStatus === "blocked" ? input.report.blockedReason ?? null : null,
    risks: input.report.risks,
    submittedAt: new Date().toISOString(),
  };
}

function upsertMergeConflictResolutionReport(
  reports: IssueMergeConflictResolutionReportRecord[],
  report: IssueMergeConflictResolutionReportRecord,
): IssueMergeConflictResolutionReportRecord[] {
  return [...reports.filter((item) => item.idempotencyKey !== report.idempotencyKey), report];
}

function assertPullRequestMatchesConflict(
  pullRequest: CompletionReportPullRequestRef,
  mergeConflict: IssueMergeConflictMetadata,
): void {
  requireMatches("conflict resolution PR number", pullRequest.number, mergeConflict.pullRequest.number);
  requireMatches("conflict resolution PR URL", pullRequest.url, mergeConflict.pullRequest.url);
  requireMatches("conflict resolution PR branch", pullRequest.branch, mergeConflict.pullRequest.branch);
}

function assertReportMatchesConflict(
  report: MergeConflictResolutionInput,
  mergeConflict: IssueMergeConflictMetadata,
): void {
  requireMatches("conflict resolution previous head SHA", report.previousHeadSha, mergeConflict.currentHeadSha);
  requireMatches("conflict resolution new head SHA", report.newHeadSha, report.pullRequest.headSha);
  if (mergeConflict.baseBranch !== null) requireMatches("conflict resolution base branch", report.baseBranch, mergeConflict.baseBranch);
  if (mergeConflict.baseHeadSha !== null) {
    requireMatches("conflict resolution base head SHA", report.baseHeadSha, mergeConflict.baseHeadSha);
  }
}

function assertReplayMatchesReport(
  report: MergeConflictResolutionInput,
  existing: IssueMergeConflictResolutionReportRecord,
): void {
  const expected = {
    runId: existing.runId,
    resolutionStatus: existing.resolutionStatus,
    summary: existing.summary,
    validationEvidence: existing.validationEvidence,
    changedFiles: existing.changedFiles,
    pullRequest: existing.pullRequest,
    previousHeadSha: existing.previousHeadSha,
    newHeadSha: existing.newHeadSha,
    baseBranch: existing.baseBranch,
    baseHeadSha: existing.baseHeadSha,
    blockedReason: existing.blockedReason,
    risks: existing.risks,
  };
  const actual = {
    runId: report.runId,
    resolutionStatus: report.resolutionStatus,
    summary: report.summary,
    validationEvidence: report.validationEvidence,
    changedFiles: report.changedFiles,
    pullRequest: report.pullRequest,
    previousHeadSha: report.previousHeadSha,
    newHeadSha: report.newHeadSha,
    baseBranch: report.baseBranch,
    baseHeadSha: report.baseHeadSha,
    blockedReason: report.resolutionStatus === "blocked" ? report.blockedReason ?? null : null,
    risks: report.risks,
  };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new SymphonyError("invalid_request", "Merge conflict resolution idempotency key was reused with different report metadata");
  }
}

function requireMatches(label: string, actual: string | number | null | undefined, expected: string | number | null | undefined): void {
  if (actual === expected) return;
  throw new SymphonyError("invalid_request", `${label} does not match merge conflict metadata`);
}

function conflictBlockedReason(fixTurnCount: number, maxFixTurns: number): string {
  return `merge conflicts remain unresolved (${fixTurnCount}/${maxFixTurns} conflict-fix attempts)`;
}

function formatPullRequest(pullRequest: CompletionReportPullRequestRef): string {
  if (pullRequest.number !== null && pullRequest.url !== null) return `#${pullRequest.number} (${pullRequest.url})`;
  if (pullRequest.number !== null) return `#${pullRequest.number}`;
  return pullRequest.url ?? "unknown";
}

function sameState(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

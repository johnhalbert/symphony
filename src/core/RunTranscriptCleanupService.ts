import { SymphonyError } from "./errors.js";
import {
  compareRunChronology,
  type RunRecord,
  type RunStatus,
  type RunTranscriptStore,
} from "./persistence/RunTranscriptStore.js";

export interface RunTranscriptCleanupTarget {
  issueIdOrIdentifier: string;
  issueId?: string | null;
  issueIdentifier?: string | null;
}

export interface RunTranscriptCleanupInput {
  targets: RunTranscriptCleanupTarget[];
  keepLatestRuns: number;
  apply: boolean;
  reason: string;
}

export type RunTranscriptCleanupAction = "kept" | "skipped_running" | "deletable" | "deleted";

export interface RunTranscriptCleanupRunResult {
  runId: string;
  status: RunStatus;
  startedAt: string;
  action: RunTranscriptCleanupAction;
  bytes: number;
}

export interface RunTranscriptCleanupIssueResult {
  issueIdOrIdentifier: string;
  issueId: string | null;
  issueIdentifier: string | null;
  considered: number;
  kept: number;
  skippedRunning: number;
  deletable: number;
  deleted: number;
  bytesDeletable: number;
  bytesRemoved: number;
  runs: RunTranscriptCleanupRunResult[];
}

export interface RunTranscriptCleanupTotals {
  issues: number;
  considered: number;
  kept: number;
  skippedRunning: number;
  deletable: number;
  deleted: number;
  bytesDeletable: number;
  bytesRemoved: number;
}

export interface RunTranscriptCleanupResult {
  apply: boolean;
  reason: string;
  keepLatestRuns: number;
  issues: RunTranscriptCleanupIssueResult[];
  totals: RunTranscriptCleanupTotals;
}

export class RunTranscriptCleanupService {
  constructor(private readonly options: { runStore: RunTranscriptStore }) {}

  async cleanup(input: RunTranscriptCleanupInput): Promise<RunTranscriptCleanupResult> {
    if (!Number.isInteger(input.keepLatestRuns) || input.keepLatestRuns < 0) {
      throw new SymphonyError("invalid_request", "keepLatestRuns must be a nonnegative integer");
    }

    const issues: RunTranscriptCleanupIssueResult[] = [];
    for (const target of input.targets) {
      issues.push(await this.cleanupIssue(target, input));
    }

    return {
      apply: input.apply,
      reason: input.reason,
      keepLatestRuns: input.keepLatestRuns,
      issues,
      totals: summarizeIssues(issues),
    };
  }

  private async cleanupIssue(
    target: RunTranscriptCleanupTarget,
    input: RunTranscriptCleanupInput,
  ): Promise<RunTranscriptCleanupIssueResult> {
    const runs = await this.listRunsForTarget(target);
    const keptRunIds = new Set(
      input.keepLatestRuns <= 0 ? [] : runs.slice(-input.keepLatestRuns).map((run) => run.runId),
    );
    const issue: RunTranscriptCleanupIssueResult = {
      issueIdOrIdentifier: target.issueIdOrIdentifier,
      issueId: target.issueId ?? runs[0]?.issueId ?? null,
      issueIdentifier: target.issueIdentifier ?? runs[0]?.issueIdentifier ?? null,
      considered: runs.length,
      kept: 0,
      skippedRunning: 0,
      deletable: 0,
      deleted: 0,
      bytesDeletable: 0,
      bytesRemoved: 0,
      runs: [],
    };

    for (const run of runs) {
      if (keptRunIds.has(run.runId)) {
        issue.kept += 1;
        issue.runs.push(await this.runResult(run, "kept"));
        continue;
      }
      if (run.status === "running") {
        issue.skippedRunning += 1;
        issue.runs.push(await this.runResult(run, "skipped_running"));
        continue;
      }

      const usage = await this.options.runStore.getRunStorageUsage(run.runId);
      issue.deletable += 1;
      issue.bytesDeletable += usage.bytes;
      if (!input.apply) {
        issue.runs.push({
          runId: run.runId,
          status: run.status,
          startedAt: run.startedAt,
          action: "deletable",
          bytes: usage.bytes,
        });
        continue;
      }

      const deleted = await this.options.runStore.deleteRun(run.runId);
      if (deleted.deleted) {
        issue.deleted += 1;
        issue.bytesRemoved += deleted.bytesRemoved;
      }
      issue.runs.push({
        runId: run.runId,
        status: run.status,
        startedAt: run.startedAt,
        action: "deleted",
        bytes: deleted.bytesRemoved,
      });
    }

    return issue;
  }

  private async listRunsForTarget(target: RunTranscriptCleanupTarget): Promise<RunRecord[]> {
    const keys = [target.issueIdOrIdentifier, target.issueId, target.issueIdentifier].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    const runsById = new Map<string, RunRecord>();
    for (const key of keys) {
      for (const run of await this.options.runStore.listRunsForIssue(key)) {
        runsById.set(run.runId, run);
      }
    }
    return [...runsById.values()].sort(compareRunChronology);
  }

  private async runResult(run: RunRecord, action: RunTranscriptCleanupAction): Promise<RunTranscriptCleanupRunResult> {
    const usage = await this.options.runStore.getRunStorageUsage(run.runId);
    return {
      runId: run.runId,
      status: run.status,
      startedAt: run.startedAt,
      action,
      bytes: usage.bytes,
    };
  }
}

function summarizeIssues(issues: RunTranscriptCleanupIssueResult[]): RunTranscriptCleanupTotals {
  return issues.reduce(
    (totals, issue) => ({
      issues: totals.issues + 1,
      considered: totals.considered + issue.considered,
      kept: totals.kept + issue.kept,
      skippedRunning: totals.skippedRunning + issue.skippedRunning,
      deletable: totals.deletable + issue.deletable,
      deleted: totals.deleted + issue.deleted,
      bytesDeletable: totals.bytesDeletable + issue.bytesDeletable,
      bytesRemoved: totals.bytesRemoved + issue.bytesRemoved,
    }),
    {
      issues: 0,
      considered: 0,
      kept: 0,
      skippedRunning: 0,
      deletable: 0,
      deleted: 0,
      bytesDeletable: 0,
      bytesRemoved: 0,
    },
  );
}

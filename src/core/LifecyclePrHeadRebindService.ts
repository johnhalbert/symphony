import { spawn } from "node:child_process";
import { access } from "node:fs/promises";

import type { ServiceConfig } from "./config/Config.js";
import { errorMessage } from "./errors.js";
import type { Logger } from "./logging/StructuredLogger.js";
import { IssueLifecycleEvidenceRecorder } from "./orchestration/IssueLifecycleEvidenceRecorder.js";
import type { IssueStateStore } from "./orchestration/IssueOrchestrationState.js";
import type {
  IssueCompletionReportRecord,
  IssueLifecyclePatch,
  IssueLifecycleRecord,
  IssueLifecycleStore,
} from "./persistence/IssueLifecycleStore.js";
import type { RunTranscriptStore } from "./persistence/RunTranscriptStore.js";
import type { TrackerClient } from "./tracker/TrackerClient.js";
import type { Issue } from "./types.js";

const GIT_TIMEOUT_MS = 10_000;

export interface PullRequestHeadLookupClient {
  getPullRequest?(input: { pullRequestNumber: number }): Promise<{
    number: number;
    url: string;
    headBranch: string;
    headSha: string | null;
  }>;
  getBranchHeadSha?(input: { branchName: string }): Promise<string>;
}

export interface LifecyclePrHeadRebindServiceOptions {
  config: ServiceConfig;
  tracker: Pick<TrackerClient, "fetchIssueStatesByIds">;
  lifecycleStore: IssueLifecycleStore;
  issueStateStore: IssueStateStore;
  runStore?: RunTranscriptStore;
  pullRequestClient?: PullRequestHeadLookupClient;
  localGit?: LocalWorktreeInspector;
  logger: Pick<Logger, "warn">;
}

export interface LifecyclePrHeadRebindInput {
  issueIdOrIdentifier: string;
  apply?: boolean;
  headSha?: string | null;
  force?: boolean;
}

export type LifecyclePrHeadRebindStatus =
  | "applied"
  | "preview"
  | "no_change"
  | "blocked"
  | "not_found";

export interface LifecyclePrHeadRebindResult {
  status: LifecyclePrHeadRebindStatus;
  applied: boolean;
  changed: boolean;
  issue: Pick<Issue, "id" | "identifier"> | null;
  targetHeadSha: string | null;
  targetHeadSource: "explicit" | "github_pull_request" | "github_branch" | null;
  pullRequestNumber: number | null;
  branchName: string | null;
  oldSummaryPrHeadSha: string | null;
  oldLatestCompletionReportPrHeadSha: string | null;
  oldHandoffPrHeadSha: string | null;
  latestCompletionReportId: string | null;
  localWorktreeHeadSha: string | null;
  localWorktreeBranch: string | null;
  observedWorktreeHeadSha: string | null;
  clearedBaseRefObservation: boolean;
  blockingReason: string | null;
  warnings: string[];
  patch: IssueLifecyclePatch | null;
  auditHistorySnapshotId: string | null;
}

interface TargetHead {
  sha: string;
  source: "explicit" | "github_pull_request" | "github_branch";
  pullRequestNumber: number | null;
  branchName: string | null;
}

interface LocalWorktreeInspector {
  inspect(workspacePath: string | null | undefined): Promise<LocalWorktreeSnapshot>;
}

interface LocalWorktreeSnapshot {
  headSha: string | null;
  branchName: string | null;
  warnings: string[];
}

export class LifecyclePrHeadRebindService {
  private readonly evidenceRecorder: IssueLifecycleEvidenceRecorder;

  constructor(private readonly options: LifecyclePrHeadRebindServiceOptions) {
    this.evidenceRecorder = new IssueLifecycleEvidenceRecorder({
      config: options.config,
      lifecycleStore: options.lifecycleStore,
      issueStateStore: options.issueStateStore,
      logger: options.logger,
      ...(options.runStore === undefined ? {} : { runStore: options.runStore }),
    });
  }

  async rebind(input: LifecyclePrHeadRebindInput): Promise<LifecyclePrHeadRebindResult> {
    const issue = await this.fetchIssue(input.issueIdOrIdentifier);
    if (issue === null) return emptyResult("not_found", "issue_not_found");

    const lifecycle = await this.loadLifecycle(input.issueIdOrIdentifier, issue);
    if (lifecycle === null) return emptyResult("not_found", "lifecycle_not_found", issue);

    const latestReport = latestCompletionReport(lifecycle);
    const oldSummaryPrHeadSha = lifecycle.summaryPointers.prHeadSha;
    const oldLatestCompletionReportPrHeadSha = latestReport?.pullRequest?.headSha ?? null;
    const oldHandoffPrHeadSha = lifecycle.handoff.memo.pointers.prHeadSha;
    const localWorktree = await (this.options.localGit ?? defaultLocalGit).inspect(lifecycle.summaryPointers.workspacePath);
    const warnings = [...localWorktree.warnings];

    const target = await this.discoverTargetHead(lifecycle, latestReport, input.headSha ?? null);
    if (target.status === "blocked") {
      return {
        ...baseResult(issue, lifecycle, latestReport, localWorktree, warnings),
        status: "blocked",
        blockingReason: target.reason,
      };
    }

    const targetHeadSha = target.target.sha;
    const branchSafety = localWorktreeBranchSafety(localWorktree, target.target.branchName);
    warnings.push(...branchSafety.warnings);
    const observedWorktreeHeadSha =
      branchSafety.applies ? localWorktree.headSha : lifecycle.baseRefObservation?.worktreeHeadSha ?? null;
    if (observedWorktreeHeadSha !== null && observedWorktreeHeadSha !== targetHeadSha && input.force !== true) {
      return {
        ...baseResult(issue, lifecycle, latestReport, localWorktree, warnings),
        status: "blocked",
        targetHeadSha,
        targetHeadSource: target.target.source,
        pullRequestNumber: target.target.pullRequestNumber,
        branchName: target.target.branchName,
        observedWorktreeHeadSha,
        blockingReason: "worktree_head_does_not_match_target_head",
      };
    }

    const { patch, changed } = buildPatch(lifecycle, latestReport, targetHeadSha);
    const resultBase: LifecyclePrHeadRebindResult = {
      ...baseResult(issue, lifecycle, latestReport, localWorktree, warnings),
      status: changed ? (input.apply === true ? "applied" : "preview") : "no_change",
      applied: false,
      changed,
      targetHeadSha,
      targetHeadSource: target.target.source,
      pullRequestNumber: target.target.pullRequestNumber,
      branchName: target.target.branchName,
      observedWorktreeHeadSha,
      clearedBaseRefObservation: (lifecycle.baseRefObservation ?? null) !== null,
      patch: changed ? patch : null,
      blockingReason: null,
    };
    if (!changed || input.apply !== true) return resultBase;

    const updated = await this.options.lifecycleStore.updateIssue(issue, patch);
    const auditHistorySnapshotId = await this.evidenceRecorder.record({
      issue,
      lifecycle: updated,
      patch,
      eventType: "manual_pr_head_rebind",
      sourceId: input.issueIdOrIdentifier,
      reason: "manual_pr_head_rebind",
      triggerType: "manual.cli_admin_action",
      triggerSource: "manual_cli",
      audit: {
        action: "manual_pr_head_rebind",
        force: input.force === true,
        targetHeadSha,
        targetHeadSource: target.target.source,
        pullRequestNumber: target.target.pullRequestNumber,
        branchName: target.target.branchName,
        latestCompletionReportId: latestReport?.id ?? null,
        oldSummaryPrHeadSha,
        oldLatestCompletionReportPrHeadSha,
        oldHandoffPrHeadSha,
        localWorktreeHeadSha: localWorktree.headSha,
        localWorktreeBranch: localWorktree.branchName,
        observedWorktreeHeadSha,
        clearedBaseRefObservation: (lifecycle.baseRefObservation ?? null) === null
          ? null
          : {
              inputFingerprint: lifecycle.baseRefObservation?.inputFingerprint ?? null,
              classification: lifecycle.baseRefObservation?.classification ?? null,
              worktreeHeadSha: lifecycle.baseRefObservation?.worktreeHeadSha ?? null,
            },
      },
    });

    return {
      ...resultBase,
      applied: true,
      auditHistorySnapshotId,
    };
  }

  private async fetchIssue(issueIdOrIdentifier: string): Promise<Issue | null> {
    try {
      return (await this.options.tracker.fetchIssueStatesByIds([issueIdOrIdentifier]))[0] ?? null;
    } catch (error) {
      this.options.logger.warn("manual PR head rebind issue lookup failed", {
        issue: issueIdOrIdentifier,
        error: errorMessage(error),
      });
      return null;
    }
  }

  private async loadLifecycle(issueIdOrIdentifier: string, issue: Issue): Promise<IssueLifecycleRecord | null> {
    return (
      (await this.options.lifecycleStore.get(issue.id)) ??
      (await this.options.lifecycleStore.get(issue.identifier)) ??
      (await this.options.lifecycleStore.get(issueIdOrIdentifier))
    );
  }

  private async discoverTargetHead(
    lifecycle: IssueLifecycleRecord,
    latestReport: IssueCompletionReportRecord | null,
    explicitHeadSha: string | null,
  ): Promise<{ status: "ready"; target: TargetHead } | { status: "blocked"; reason: string }> {
    const explicit = nonEmptyString(explicitHeadSha);
    const pullRequestNumber = latestReport?.pullRequest?.number ?? lifecycle.summaryPointers.prNumber;
    const branchName =
      nonEmptyString(latestReport?.pullRequest?.branch) ??
      nonEmptyString(lifecycle.summaryPointers.prBranch) ??
      nonEmptyString(lifecycle.summaryPointers.gitBranchName) ??
      nonEmptyString(lifecycle.summaryPointers.branchName);

    if (explicit !== null) {
      return {
        status: "ready",
        target: {
          sha: explicit,
          source: "explicit",
          pullRequestNumber: pullRequestNumber ?? null,
          branchName,
        },
      };
    }

    if (pullRequestNumber !== null && this.options.pullRequestClient?.getPullRequest) {
      try {
        const pullRequest = await this.options.pullRequestClient.getPullRequest({ pullRequestNumber });
        const headSha = nonEmptyString(pullRequest.headSha);
        if (headSha === null) return { status: "blocked", reason: "github_pull_request_head_missing" };
        return {
          status: "ready",
          target: {
            sha: headSha,
            source: "github_pull_request",
            pullRequestNumber,
            branchName: nonEmptyString(pullRequest.headBranch) ?? branchName,
          },
        };
      } catch (error) {
        return { status: "blocked", reason: `github_pull_request_lookup_failed: ${errorMessage(error)}` };
      }
    }

    if (branchName !== null && this.options.pullRequestClient?.getBranchHeadSha) {
      try {
        const headSha = nonEmptyString(await this.options.pullRequestClient.getBranchHeadSha({ branchName }));
        if (headSha === null) return { status: "blocked", reason: "github_branch_head_missing" };
        return {
          status: "ready",
          target: {
            sha: headSha,
            source: "github_branch",
            pullRequestNumber: pullRequestNumber ?? null,
            branchName,
          },
        };
      } catch (error) {
        return { status: "blocked", reason: `github_branch_lookup_failed: ${errorMessage(error)}` };
      }
    }

    return { status: "blocked", reason: "target_head_unavailable" };
  }
}

function buildPatch(
  lifecycle: IssueLifecycleRecord,
  latestReport: IssueCompletionReportRecord | null,
  targetHeadSha: string,
): { patch: IssueLifecyclePatch; changed: boolean } {
  const patch: IssueLifecyclePatch = {};
  const summaryNeedsUpdate = lifecycle.summaryPointers.prHeadSha !== targetHeadSha;
  const handoffNeedsRebuild = lifecycle.handoff.memo.pointers.prHeadSha !== targetHeadSha;
  if (summaryNeedsUpdate || handoffNeedsRebuild) {
    patch.summaryPointers = { prHeadSha: targetHeadSha };
  }

  if (latestReport?.pullRequest && latestReport.pullRequest.headSha !== targetHeadSha) {
    patch.completionReports = lifecycle.completionReports.map((report) =>
      report.id === latestReport.id
        ? {
            ...report,
            pullRequest: report.pullRequest
              ? { ...report.pullRequest, headSha: targetHeadSha }
              : report.pullRequest,
          }
        : report,
    );
  }

  if ((lifecycle.baseRefObservation ?? null) !== null) {
    patch.baseRefObservation = null;
  }

  return {
    patch,
    changed: Object.keys(patch).length > 0,
  };
}

function latestCompletionReport(lifecycle: IssueLifecycleRecord): IssueCompletionReportRecord | null {
  if (lifecycle.lastCompletionReportId) {
    return lifecycle.completionReports.find((report) => report.id === lifecycle.lastCompletionReportId) ?? null;
  }
  return lifecycle.completionReports.at(-1) ?? null;
}

function baseResult(
  issue: Pick<Issue, "id" | "identifier">,
  lifecycle: IssueLifecycleRecord,
  latestReport: IssueCompletionReportRecord | null,
  localWorktree: LocalWorktreeSnapshot,
  warnings: string[],
): LifecyclePrHeadRebindResult {
  return {
    status: "preview",
    applied: false,
    changed: false,
    issue: { id: issue.id, identifier: issue.identifier },
    targetHeadSha: null,
    targetHeadSource: null,
    pullRequestNumber: latestReport?.pullRequest?.number ?? lifecycle.summaryPointers.prNumber,
    branchName:
      nonEmptyString(latestReport?.pullRequest?.branch) ??
      nonEmptyString(lifecycle.summaryPointers.prBranch) ??
      nonEmptyString(lifecycle.summaryPointers.gitBranchName) ??
      nonEmptyString(lifecycle.summaryPointers.branchName),
    oldSummaryPrHeadSha: lifecycle.summaryPointers.prHeadSha,
    oldLatestCompletionReportPrHeadSha: latestReport?.pullRequest?.headSha ?? null,
    oldHandoffPrHeadSha: lifecycle.handoff.memo.pointers.prHeadSha,
    latestCompletionReportId: latestReport?.id ?? null,
    localWorktreeHeadSha: localWorktree.headSha,
    localWorktreeBranch: localWorktree.branchName,
    observedWorktreeHeadSha: lifecycle.baseRefObservation?.worktreeHeadSha ?? null,
    clearedBaseRefObservation: false,
    blockingReason: null,
    warnings,
    patch: null,
    auditHistorySnapshotId: null,
  };
}

function emptyResult(
  status: Extract<LifecyclePrHeadRebindStatus, "not_found">,
  blockingReason: string,
  issue: Pick<Issue, "id" | "identifier"> | null = null,
): LifecyclePrHeadRebindResult {
  return {
    status,
    applied: false,
    changed: false,
    issue,
    targetHeadSha: null,
    targetHeadSource: null,
    pullRequestNumber: null,
    branchName: null,
    oldSummaryPrHeadSha: null,
    oldLatestCompletionReportPrHeadSha: null,
    oldHandoffPrHeadSha: null,
    latestCompletionReportId: null,
    localWorktreeHeadSha: null,
    localWorktreeBranch: null,
    observedWorktreeHeadSha: null,
    clearedBaseRefObservation: false,
    blockingReason,
    warnings: [],
    patch: null,
    auditHistorySnapshotId: null,
  };
}

const defaultLocalGit: LocalWorktreeInspector = {
  async inspect(workspacePath: string | null | undefined): Promise<LocalWorktreeSnapshot> {
    const path = nonEmptyString(workspacePath);
    if (path === null) return { headSha: null, branchName: null, warnings: [] };
    try {
      await access(path);
    } catch {
      return { headSha: null, branchName: null, warnings: [`workspace_not_found:${path}`] };
    }
    try {
      const [headSha, branchName] = await Promise.all([
        runGit(path, ["rev-parse", "HEAD"]),
        runGit(path, ["branch", "--show-current"]),
      ]);
      return {
        headSha,
        branchName: nonEmptyString(branchName),
        warnings: [],
      };
    } catch (error) {
      return { headSha: null, branchName: null, warnings: [`local_head_unavailable:${errorMessage(error)}`] };
    }
  },
};

function localWorktreeBranchSafety(
  localWorktree: LocalWorktreeSnapshot,
  expectedBranchName: string | null,
): { applies: boolean; warnings: string[] } {
  if (localWorktree.headSha === null) return { applies: false, warnings: [] };
  if (expectedBranchName === null) return { applies: true, warnings: [] };
  if (localWorktree.branchName === null) {
    return {
      applies: false,
      warnings: [`workspace_branch_unavailable:${expectedBranchName}`],
    };
  }
  if (localWorktree.branchName === expectedBranchName) {
    return { applies: true, warnings: [] };
  }
  return {
    applies: false,
    warnings: [`workspace_branch_mismatch:${localWorktree.branchName}->${expectedBranchName}`],
  };
}

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let settled = false;
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`git command timed out after ${GIT_TIMEOUT_MS}ms`));
    }, GIT_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || `git exited with code ${code ?? "unknown"}`));
      }
    });
  });
}

function nonEmptyString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
}

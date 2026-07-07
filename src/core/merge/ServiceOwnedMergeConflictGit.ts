import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fetchAndVerifyLocalRemoteBaseRef } from "../BaseRefVerification.js";
import { SymphonyError } from "../errors.js";
import type {
  IssuePreservedWorktreeStash,
  IssuePreservedWorktreeStashSource,
} from "../persistence/IssueLifecycleStore.js";

const DEFAULT_GIT_TIMEOUT_MS = 120_000;
const SERVICE_GIT_NAME = "Symphony";
const SERVICE_GIT_EMAIL = "symphony@users.noreply.github.com";

export interface ServiceOwnedMergeConflictPreparationInput {
  workspacePath: string;
  branchName: string;
  expectedHeadSha: string;
  baseBranch: string;
  observedPrBaseHeadSha: string | null;
  liveBaseHeadSha: string;
  authHeader: string;
}

export interface ServiceOwnedLocalBaseRefreshInput {
  workspacePath: string;
  branchName: string;
  expectedHeadSha: string;
  baseBranch: string;
  liveBaseHeadSha: string;
  authHeader: string;
}

export type ServiceOwnedMergeConflictPreparationResult =
  | {
      status: "clean";
      originalHeadSha: string;
      observedPrBaseHeadSha: string | null;
      liveBaseHeadSha: string;
      preparedBaseHeadSha: string;
      mergeBaseSha: string;
      squashCommitSha: string | null;
      rebasedHeadSha: string;
      conflictedFiles: [];
    }
  | {
      status: "conflicted";
      originalHeadSha: string;
      observedPrBaseHeadSha: string | null;
      liveBaseHeadSha: string;
      preparedBaseHeadSha: string;
      mergeBaseSha: string;
      squashCommitSha: string | null;
      conflictedFiles: string[];
    };

export interface ServiceOwnedLocalBaseRefreshResult {
  status: "refreshed";
  originalHeadSha: string;
  liveBaseHeadSha: string;
  refreshedHeadSha: string;
  aheadCommitCount: number;
  behindCommitCount: number;
}

export interface ServiceOwnedMergeConflictFinalizationInput {
  workspacePath: string;
  branchName: string;
  previousRemoteHeadSha: string;
  preparedBaseHeadSha: string;
  baseBranch: string;
  conflictedFiles: string[];
  changedFiles: string[];
  authHeader: string;
}

export interface ServiceOwnedMergeConflictFinalizationResult {
  newHeadSha: string;
}

export interface ServiceOwnedPreserveWorktreeInput {
  workspacePath: string;
  branchName: string;
  baseBranch: string | null;
  operationId: string;
  source: IssuePreservedWorktreeStashSource;
  message?: string;
}

export type ServiceOwnedPreservedStashApplyResult =
  | {
      status: "clean";
      stash: IssuePreservedWorktreeStash;
      changedFiles: string[];
      headSha: string;
    }
  | {
      status: "conflicted";
      stash: IssuePreservedWorktreeStash;
      changedFiles: string[];
      conflictedFiles: string[];
      headSha: string;
    };

export interface ServiceOwnedStashApplyFinalizationInput {
  workspacePath: string;
  branchName: string;
  previousRemoteHeadSha: string;
  allowedFiles: string[];
  conflictedFiles: string[];
  changedFiles: string[];
  preservedStash: IssuePreservedWorktreeStash;
  authHeader: string;
  remoteBacked?: boolean;
}

export interface ServiceOwnedStashApplyFinalizationResult {
  newHeadSha: string;
  preservedStash: IssuePreservedWorktreeStash;
}

export interface PreparedBaseRefDriftDetails {
  kind: "prepared_base_ref_drift";
  refName: string;
  actualSha: string;
  expectedSha: string;
  baseBranch: string;
}

export class ServiceOwnedMergeConflictGit {
  async preserveDirtyWorktree(
    input: ServiceOwnedPreserveWorktreeInput,
  ): Promise<IssuePreservedWorktreeStash | null> {
    validateRefName(input.branchName, "PR branch");
    if (input.baseBranch !== null) validateRefName(input.baseBranch, "base branch");
    const git = new ServiceGit(input.workspacePath);
    await git.assertCurrentBranch(input.branchName);
    const dirtyFiles = await git.statusFiles();
    if (dirtyFiles.length === 0) return null;
    const originalHeadSha = await git.headSha();
    const stashId = `preserved-stash:${input.operationId}:${randomUUID()}`;
    const refName = `refs/symphony/preserved-stashes/${safeRefSegment(input.operationId)}/${randomUUID()}`;
    const message =
      input.message ??
      `Symphony preserved local changes for ${input.operationId}`;
    await git.stashPush(message);
    const stashSha = await git.refSha("refs/stash");
    await git.updateRef(refName, stashSha);
    await git.dropLatestStashStackEntry();
    await git.assertClean();
    return {
      version: 1,
      id: stashId,
      operationId: input.operationId,
      source: input.source,
      stashRef: refName,
      stashSha,
      message,
      workspacePath: input.workspacePath,
      branchName: input.branchName,
      baseBranch: input.baseBranch,
      originalHeadSha,
      dirtyFiles,
      status: "created",
      conflictedFiles: [],
      createdAt: new Date().toISOString(),
      appliedAt: null,
      droppedAt: null,
      dropError: null,
    };
  }

  async applyPreservedStash(input: {
    workspacePath: string;
    branchName: string;
    preservedStash: IssuePreservedWorktreeStash;
  }): Promise<ServiceOwnedPreservedStashApplyResult> {
    validateRefName(input.branchName, "PR branch");
    const git = new ServiceGit(input.workspacePath);
    await git.assertCurrentBranch(input.branchName);
    const appliedAt = new Date().toISOString();
    const apply = await git.applyStash(input.preservedStash.stashRef);
    const conflictedFiles = await git.conflictedFiles();
    const changedFiles = await git.workerTouchedFiles();
    const headSha = await git.headSha();
    if (apply.code === 0 && conflictedFiles.length === 0) {
      return {
        status: "clean",
        stash: {
          ...input.preservedStash,
          status: "applied_clean",
          appliedAt,
          conflictedFiles: [],
          dropError: null,
        },
        changedFiles,
        headSha,
      };
    }
    if (conflictedFiles.length === 0) {
      throw new SymphonyError(
        "invalid_request",
        `Preserved worktree stash apply failed without file conflicts: ${apply.stderr.trim() || apply.stdout.trim()}`,
      );
    }
    return {
      status: "conflicted",
      stash: {
        ...input.preservedStash,
        status: "apply_conflicted",
        appliedAt,
        conflictedFiles,
        dropError: null,
      },
      changedFiles,
      conflictedFiles,
      headSha,
    };
  }

  async dropPreservedStash(input: {
    workspacePath: string;
    preservedStash: IssuePreservedWorktreeStash;
  }): Promise<IssuePreservedWorktreeStash> {
    const git = new ServiceGit(input.workspacePath);
    const droppedAt = new Date().toISOString();
    try {
      await git.deleteRef(input.preservedStash.stashRef);
      return {
        ...input.preservedStash,
        status: "dropped",
        droppedAt,
        dropError: null,
      };
    } catch (error) {
      return {
        ...input.preservedStash,
        status: "drop_failed",
        droppedAt: null,
        dropError: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async prepare(
    input: ServiceOwnedMergeConflictPreparationInput,
  ): Promise<ServiceOwnedMergeConflictPreparationResult> {
    validateRefName(input.branchName, "PR branch");
    validateRefName(input.baseBranch, "base branch");
    const git = new ServiceGit(input.workspacePath);
    await git.assertCurrentBranch(input.branchName);
    await git.assertClean();

    return prepareFromCleanWorkspace(git, input);
  }

  async reprepareAfterBaseDrift(
    input: ServiceOwnedMergeConflictPreparationInput,
  ): Promise<ServiceOwnedMergeConflictPreparationResult> {
    validateRefName(input.branchName, "PR branch");
    validateRefName(input.baseBranch, "base branch");
    const git = new ServiceGit(input.workspacePath);
    await git.assertCurrentBranch(input.branchName);
    await git.abortRebaseIfInProgress();
    await git.resetHard(input.expectedHeadSha);
    await git.assertClean();

    return prepareFromCleanWorkspace(git, input);
  }

  async publishPreparedHead(input: {
    workspacePath: string;
    branchName: string;
    previousRemoteHeadSha: string;
    authHeader: string;
  }): Promise<void> {
    validateRefName(input.branchName, "PR branch");
    const git = new ServiceGit(input.workspacePath);
    await git.assertCurrentBranch(input.branchName);
    await git.pushForceWithLease(input.branchName, input.previousRemoteHeadSha, input.authHeader);
  }

  async refreshLocalBranchBase(
    input: ServiceOwnedLocalBaseRefreshInput,
  ): Promise<ServiceOwnedLocalBaseRefreshResult> {
    validateRefName(input.branchName, "worktree branch");
    validateRefName(input.baseBranch, "base branch");
    const git = new ServiceGit(input.workspacePath);
    await git.assertCurrentBranch(input.branchName);
    await git.assertClean();
    await git.assertRefSha("HEAD", input.expectedHeadSha, "expected worktree head");
    await fetchAndVerifyLocalRemoteBaseRef({
      workspacePath: input.workspacePath,
      baseRef: input.baseBranch,
      expectedBaseHeadSha: input.liveBaseHeadSha,
      authHeader: input.authHeader,
      errorMessageLabel: "expected live base",
    });
    await git.ensureCommit(input.expectedHeadSha);
    await git.ensureCommit(input.liveBaseHeadSha);
    const counts = await git.revListLeftRightCount(
      input.expectedHeadSha,
      input.liveBaseHeadSha,
    );
    if (counts.left > 0) {
      throw new SymphonyError(
        "invalid_request",
        `Local-only base refresh would discard ${counts.left} local commit(s) not in the live base; worker inspection is required`,
      );
    }
    await git.resetHard(input.liveBaseHeadSha);
    return {
      status: "refreshed",
      originalHeadSha: input.expectedHeadSha,
      liveBaseHeadSha: input.liveBaseHeadSha,
      refreshedHeadSha: await git.headSha(),
      aheadCommitCount: counts.left,
      behindCommitCount: counts.right,
    };
  }

  async finalize(
    input: ServiceOwnedMergeConflictFinalizationInput,
  ): Promise<ServiceOwnedMergeConflictFinalizationResult> {
    validateRefName(input.branchName, "PR branch");
    validateRefName(input.baseBranch, "base branch");
    const allowed = new Set(input.conflictedFiles.map(normalizeRepoPath));
    const changed = input.changedFiles.map(normalizeRepoPath);
    const outside = changed.filter((file) => !allowed.has(file));
    if (outside.length > 0) {
      throw new SymphonyError(
        "invalid_request",
        `Merge conflict repair changed files outside the service-prepared conflict set: ${outside.join(", ")}`,
      );
    }

    const git = new ServiceGit(input.workspacePath);
    await git.assertCurrentBranch(input.branchName);
    await git.fetchBranch(input.branchName, input.authHeader);
    await git.assertRefSha(`refs/remotes/origin/${input.branchName}`, input.previousRemoteHeadSha, "expected PR head");
    await fetchAndVerifyLocalRemoteBaseRef({
      workspacePath: input.workspacePath,
      baseRef: input.baseBranch,
      expectedBaseHeadSha: input.preparedBaseHeadSha,
      authHeader: input.authHeader,
      createMismatchError: ({ refName, actualSha, expectedSha, baseBranch }) =>
        preparedBaseRefDriftError(refName, actualSha, expectedSha, baseBranch),
    });
    const workerTouchedFiles = await git.workerTouchedFiles();
    const actualOutside = workerTouchedFiles.filter((file) => !allowed.has(file));
    if (actualOutside.length > 0) {
      throw new SymphonyError(
        "invalid_request",
        `Merge conflict repair touched files outside the service-prepared conflict set: ${actualOutside.join(", ")}`,
      );
    }
    for (const file of input.conflictedFiles) await assertNoConflictMarkers(path.join(input.workspacePath, file));
    await git.add(input.conflictedFiles);
    if ((await git.unmergedEntries()).length > 0) {
      throw new SymphonyError("invalid_request", "Merge conflict repair still has unmerged index entries");
    }
    if (await git.hasStagedDiff()) {
      await git.rebaseContinue();
    } else {
      await git.rebaseSkip();
    }
    await git.assertNoRebaseInProgress();
    const newHeadSha = await git.headSha();
    await git.pushForceWithLease(input.branchName, input.previousRemoteHeadSha, input.authHeader);
    return { newHeadSha };
  }

  async finalizeStashApply(
    input: ServiceOwnedStashApplyFinalizationInput,
  ): Promise<ServiceOwnedStashApplyFinalizationResult> {
    validateRefName(input.branchName, "PR branch");
    const allowed = new Set(input.allowedFiles.map(normalizeRepoPath));
    const changed = input.changedFiles.map(normalizeRepoPath);
    const outside = changed.filter((file) => !allowed.has(file));
    if (outside.length > 0) {
      throw new SymphonyError(
        "invalid_request",
        `Stash-apply repair changed files outside the preserved local changes set: ${outside.join(", ")}`,
      );
    }

    const git = new ServiceGit(input.workspacePath);
    await git.assertCurrentBranch(input.branchName);
    const remoteBacked = input.remoteBacked !== false;
    if (remoteBacked) {
      await git.fetchBranch(input.branchName, input.authHeader);
      await git.assertRefSha(`refs/remotes/origin/${input.branchName}`, input.previousRemoteHeadSha, "expected PR head");
    }
    const actualTouchedFiles = await git.workerTouchedFiles();
    const actualOutside = actualTouchedFiles.filter((file) => !allowed.has(file));
    if (actualOutside.length > 0) {
      throw new SymphonyError(
        "invalid_request",
        `Stash-apply repair touched files outside the preserved local changes set: ${actualOutside.join(", ")}`,
      );
    }
    for (const file of input.conflictedFiles) await assertNoConflictMarkers(path.join(input.workspacePath, file));
    await git.add(actualTouchedFiles.filter((file) => allowed.has(file)));
    if ((await git.unmergedEntries()).length > 0) {
      throw new SymphonyError("invalid_request", "Stash-apply repair still has unmerged index entries");
    }
    if (await git.hasStagedDiff()) {
      await git.commit(
        "Symphony preserved local changes repair",
        "Finalize preserved local changes after service-owned base-ref repair.",
      );
      if (remoteBacked) {
        await git.pushForceWithLease(input.branchName, input.previousRemoteHeadSha, input.authHeader);
      }
    }
    const newHeadSha = await git.headSha();
    const dropped = await this.dropPreservedStash({
      workspacePath: input.workspacePath,
      preservedStash: {
        ...input.preservedStash,
        status: "finalized",
      },
    });
    return {
      newHeadSha,
      preservedStash: dropped.status === "drop_failed" ? dropped : { ...dropped, status: "dropped" },
    };
  }
}

class ServiceGit {
  constructor(private readonly workspacePath: string) {}

  async assertCurrentBranch(branchName: string): Promise<void> {
    const current = (await this.git(["branch", "--show-current"])).stdout.trim();
    if (current === branchName) return;
    const rebaseHeadName = await this.rebaseHeadName();
    if (normalizeBranchRef(rebaseHeadName) === branchName) return;
    throw new SymphonyError("invalid_request", `Worktree is on ${current || "detached HEAD"}, not ${branchName}`);
  }

  async assertClean(): Promise<void> {
    const status = (await this.git(["status", "--porcelain=v1", "-uall"])).stdout.trim();
    if (status.length > 0) throw new SymphonyError("invalid_request", "Service-owned conflict preparation requires a clean worktree");
  }

  async statusFiles(): Promise<string[]> {
    return normalizeGitPathLines((await this.git(["status", "--porcelain=v1", "-uall"])).stdout);
  }

  async stashPush(message: string): Promise<void> {
    await this.git(["stash", "push", "--include-untracked", "-m", message]);
  }

  async dropLatestStashStackEntry(): Promise<void> {
    await this.git(["stash", "drop", "stash@{0}"]);
  }

  async applyStash(stashRef: string): Promise<GitResult> {
    return this.git(["stash", "apply", stashRef], { allowFailure: true });
  }

  async updateRef(refName: string, sha: string): Promise<void> {
    await this.git(["update-ref", refName, sha]);
  }

  async deleteRef(refName: string): Promise<void> {
    await this.git(["update-ref", "-d", refName]);
  }

  async fetchBranch(branchName: string, authHeader: string): Promise<void> {
    await this.git([
      "-c",
      `http.extraheader=${authHeader}`,
      "fetch",
      "origin",
      `+refs/heads/${branchName}:refs/remotes/origin/${branchName}`,
    ]);
  }

  async assertRefSha(refName: string, expectedSha: string, label: string): Promise<void> {
    const actual = await this.refSha(refName);
    if (actual !== expectedSha) {
      throw new SymphonyError("invalid_request", `${refName} resolved to ${actual}, not ${label} ${expectedSha}`);
    }
  }

  async refSha(refName: string): Promise<string> {
    return (await this.git(["rev-parse", `${refName}^{commit}`])).stdout.trim();
  }

  async ensureCommit(sha: string): Promise<void> {
    await this.git(["cat-file", "-e", `${sha}^{commit}`]);
  }

  async resetHard(sha: string): Promise<void> {
    await this.git(["reset", "--hard", sha]);
  }

  async resetSoft(sha: string): Promise<void> {
    await this.git(["reset", "--soft", sha]);
  }

  async mergeBase(left: string, right: string): Promise<string> {
    return (await this.git(["merge-base", left, right])).stdout.trim();
  }

  async revListLeftRightCount(
    left: string,
    right: string,
  ): Promise<{ left: number; right: number }> {
    const output = (
      await this.git(["rev-list", "--left-right", "--count", `${left}...${right}`])
    ).stdout.trim();
    const counts = output.split(/\s+/).map((value) => Number(value));
    const leftCount = counts[0];
    const rightCount = counts[1];
    if (
      !Number.isFinite(leftCount) ||
      !Number.isFinite(rightCount)
    ) {
      throw new SymphonyError(
        "invalid_request",
        `Unable to parse local branch divergence: ${output}`,
      );
    }
    return { left: leftCount!, right: rightCount! };
  }

  async hasStagedDiff(): Promise<boolean> {
    const result = await this.git(["diff", "--cached", "--quiet"], { allowFailure: true });
    if (result.code === 0) return false;
    if (result.code === 1) return true;
    throw new SymphonyError("invalid_request", "Unable to inspect staged service-owned conflict repair changes");
  }

  async commit(title: string, body: string): Promise<void> {
    await this.git([
      "-c",
      `user.name=${SERVICE_GIT_NAME}`,
      "-c",
      `user.email=${SERVICE_GIT_EMAIL}`,
      "commit",
      "-m",
      title,
      "-m",
      body,
    ]);
  }

  async rebaseOnto(newBaseSha: string, oldBaseSha: string): Promise<GitResult> {
    return this.git(["rebase", "--onto", newBaseSha, oldBaseSha], { allowFailure: true });
  }

  async conflictedFiles(): Promise<string[]> {
    return normalizeGitPathLines((await this.git(["diff", "--name-only", "--diff-filter=U"])).stdout);
  }

  async workerTouchedFiles(): Promise<string[]> {
    return sortedUnique([
      ...normalizeGitPathLines((await this.git(["diff", "--name-only"])).stdout),
      ...normalizeGitPathLines((await this.git(["ls-files", "--others", "--exclude-standard"])).stdout),
    ]);
  }

  async add(files: string[]): Promise<void> {
    if (files.length === 0) return;
    await this.git(["add", "--", ...files]);
  }

  async unmergedEntries(): Promise<string[]> {
    return normalizeGitPathLines((await this.git(["ls-files", "-u"])).stdout);
  }

  async rebaseContinue(): Promise<void> {
    await this.git([
      "-c",
      `user.name=${SERVICE_GIT_NAME}`,
      "-c",
      `user.email=${SERVICE_GIT_EMAIL}`,
      "-c",
      "core.editor=true",
      "rebase",
      "--continue",
    ]);
  }

  async rebaseSkip(): Promise<void> {
    await this.git(["rebase", "--skip"]);
  }

  async assertNoRebaseInProgress(): Promise<void> {
    const rebaseMerge = (await this.git(["rev-parse", "--git-path", "rebase-merge"])).stdout.trim();
    const rebaseApply = (await this.git(["rev-parse", "--git-path", "rebase-apply"])).stdout.trim();
    if (await exists(resolveGitPath(this.workspacePath, rebaseMerge))) {
      throw new SymphonyError("invalid_request", "Service-owned rebase is still in progress");
    }
    if (await exists(resolveGitPath(this.workspacePath, rebaseApply))) {
      throw new SymphonyError("invalid_request", "Service-owned rebase is still in progress");
    }
  }

  async abortRebaseIfInProgress(): Promise<void> {
    const rebaseMerge = (await this.git(["rev-parse", "--git-path", "rebase-merge"])).stdout.trim();
    const rebaseApply = (await this.git(["rev-parse", "--git-path", "rebase-apply"])).stdout.trim();
    if (!(await exists(resolveGitPath(this.workspacePath, rebaseMerge))) && !(await exists(resolveGitPath(this.workspacePath, rebaseApply)))) {
      return;
    }
    await this.git(["rebase", "--abort"]);
  }

  private async rebaseHeadName(): Promise<string | null> {
    const rebaseMerge = (await this.git(["rev-parse", "--git-path", "rebase-merge/head-name"])).stdout.trim();
    const rebaseApply = (await this.git(["rev-parse", "--git-path", "rebase-apply/head-name"])).stdout.trim();
    for (const filePath of [resolveGitPath(this.workspacePath, rebaseMerge), resolveGitPath(this.workspacePath, rebaseApply)]) {
      try {
        const value = (await fs.readFile(filePath, "utf8")).trim();
        if (value.length > 0) return value;
      } catch {
        // Not in this rebase mode.
      }
    }
    return null;
  }

  async pushForceWithLease(branchName: string, expectedRemoteHeadSha: string, authHeader: string): Promise<void> {
    await this.git([
      "-c",
      `http.extraheader=${authHeader}`,
      "push",
      `--force-with-lease=refs/heads/${branchName}:${expectedRemoteHeadSha}`,
      "origin",
      `HEAD:refs/heads/${branchName}`,
    ]);
  }

  async headSha(): Promise<string> {
    return (await this.git(["rev-parse", "HEAD"])).stdout.trim();
  }

  private git(args: string[], options: { allowFailure?: boolean } = {}): Promise<GitResult> {
    return runCommand("git", args, this.workspacePath, DEFAULT_GIT_TIMEOUT_MS, options);
  }
}

async function prepareFromCleanWorkspace(
  git: ServiceGit,
  input: ServiceOwnedMergeConflictPreparationInput,
): Promise<ServiceOwnedMergeConflictPreparationResult> {
  await git.fetchBranch(input.branchName, input.authHeader);
  await git.assertRefSha(`refs/remotes/origin/${input.branchName}`, input.expectedHeadSha, "expected PR head");
  await fetchAndVerifyLocalRemoteBaseRef({
    workspacePath: input.workspacePath,
    baseRef: input.baseBranch,
    expectedBaseHeadSha: input.liveBaseHeadSha,
    authHeader: input.authHeader,
    errorMessageLabel: "expected live base",
  });
  await git.ensureCommit(input.expectedHeadSha);
  await git.resetHard(input.expectedHeadSha);

  const mergeBaseSha = await git.mergeBase(input.expectedHeadSha, input.liveBaseHeadSha);
  await git.resetSoft(mergeBaseSha);
  const hasSquashDiff = await git.hasStagedDiff();
  if (!hasSquashDiff) {
    await git.resetHard(input.expectedHeadSha);
    throw new SymphonyError("invalid_request", "Service-owned conflict preparation found no PR-side changes to squash");
  }
  await git.commit("Symphony service-owned merge-conflict prep", "Squash lifecycle-bound PR changes before rebasing onto the live base.");
  const squashCommitSha = await git.headSha();

  const rebase = await git.rebaseOnto(input.liveBaseHeadSha, mergeBaseSha);
  if (rebase.code === 0) {
    return {
      status: "clean",
      originalHeadSha: input.expectedHeadSha,
      observedPrBaseHeadSha: input.observedPrBaseHeadSha,
      liveBaseHeadSha: input.liveBaseHeadSha,
      preparedBaseHeadSha: input.liveBaseHeadSha,
      mergeBaseSha,
      squashCommitSha,
      rebasedHeadSha: await git.headSha(),
      conflictedFiles: [],
    };
  }

  const conflictedFiles = await git.conflictedFiles();
  if (conflictedFiles.length === 0) {
    throw new SymphonyError("invalid_request", `Service-owned rebase failed without file conflicts: ${rebase.stderr.trim() || rebase.stdout.trim()}`);
  }
  return {
    status: "conflicted",
    originalHeadSha: input.expectedHeadSha,
    observedPrBaseHeadSha: input.observedPrBaseHeadSha,
    liveBaseHeadSha: input.liveBaseHeadSha,
    preparedBaseHeadSha: input.liveBaseHeadSha,
    mergeBaseSha,
    squashCommitSha,
    conflictedFiles,
  };
}

export function isPreparedBaseRefDriftError(error: unknown): error is SymphonyError & { details: PreparedBaseRefDriftDetails } {
  return (
    error instanceof SymphonyError &&
    typeof error.details === "object" &&
    error.details !== null &&
    (error.details as { kind?: unknown }).kind === "prepared_base_ref_drift" &&
    typeof (error.details as { actualSha?: unknown }).actualSha === "string" &&
    typeof (error.details as { expectedSha?: unknown }).expectedSha === "string"
  );
}

function preparedBaseRefDriftError(
  refName: string,
  actualSha: string,
  expectedSha: string,
  baseBranch: string,
): SymphonyError {
  return new SymphonyError("conflict", `${refName} resolved to ${actualSha}, not prepared base ${expectedSha}`, {
    kind: "prepared_base_ref_drift",
    refName,
    actualSha,
    expectedSha,
    baseBranch,
  } satisfies PreparedBaseRefDriftDetails);
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  options: { allowFailure?: boolean },
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let settled = false;
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8").slice(0, 64_000);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8").slice(0, 64_000);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = { code: code ?? 1, stdout, stderr };
      if (result.code === 0 || options.allowFailure) {
        resolve(result);
      } else {
        reject(new Error(`git exited with ${result.code}: ${stderr}`));
      }
    });
  });
}

function validateRefName(refName: string, label: string): void {
  const trimmed = refName.trim();
  if (
    trimmed.length === 0 ||
    trimmed.startsWith("-") ||
    trimmed.includes("..") ||
    trimmed.includes("\\") ||
    trimmed.includes("~") ||
    trimmed.includes("^") ||
    trimmed.includes(":") ||
    trimmed.includes("?") ||
    trimmed.includes("*") ||
    trimmed.includes("[") ||
    trimmed.endsWith("/") ||
    trimmed.endsWith(".lock")
  ) {
    throw new SymphonyError("invalid_request", `Unsafe ${label}: ${refName}`);
  }
}

function normalizeGitPathLines(output: string): string[] {
  return output
    .split(/\r?\n/u)
    .map((line) => normalizeRepoPath(line.trim().split(/\s+/u).pop() ?? ""))
    .filter((line) => line.length > 0);
}

function normalizeRepoPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\/+/u, "");
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function normalizeBranchRef(value: string | null): string | null {
  if (value === null) return null;
  return value.replace(/^refs\/heads\//u, "");
}

function safeRefSegment(value: string): string {
  const safe = value
    .replace(/\\/g, "/")
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/\.\.+/g, ".")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.lock$/u, "-lock");
  return safe.length > 0 ? safe : "operation";
}

async function assertNoConflictMarkers(filePath: string): Promise<void> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch {
    return;
  }
  if (/^(<<<<<<<|=======|>>>>>>>)(?: .*)?$/mu.test(content)) {
    throw new SymphonyError("invalid_request", `Conflict markers remain in ${filePath}`);
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function resolveGitPath(workspacePath: string, gitPath: string): string {
  return path.isAbsolute(gitPath) ? gitPath : path.join(workspacePath, gitPath);
}

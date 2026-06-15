import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { SymphonyError } from "../errors.js";

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

export class ServiceOwnedMergeConflictGit {
  async prepare(
    input: ServiceOwnedMergeConflictPreparationInput,
  ): Promise<ServiceOwnedMergeConflictPreparationResult> {
    validateRefName(input.branchName, "PR branch");
    validateRefName(input.baseBranch, "base branch");
    const git = new ServiceGit(input.workspacePath);
    await git.assertCurrentBranch(input.branchName);
    await git.assertClean();

    await git.fetchBranch(input.branchName, input.authHeader);
    await git.fetchBranch(input.baseBranch, input.authHeader);
    await git.assertRefSha(`refs/remotes/origin/${input.branchName}`, input.expectedHeadSha, "expected PR head");
    await git.assertRefSha(`refs/remotes/origin/${input.baseBranch}`, input.liveBaseHeadSha, "expected live base");
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
    await git.fetchBranch(input.baseBranch, input.authHeader);
    await git.assertRefSha(`refs/remotes/origin/${input.baseBranch}`, input.preparedBaseHeadSha, "prepared base");
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
    const actual = (await this.git(["rev-parse", `${refName}^{commit}`])).stdout.trim();
    if (actual !== expectedSha) {
      throw new SymphonyError("invalid_request", `${refName} resolved to ${actual}, not ${label} ${expectedSha}`);
    }
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

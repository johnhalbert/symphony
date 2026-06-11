import { constants as fsConstants, promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import type { WorkspaceSourceConfig } from "../config/Config.js";
import { SymphonyError } from "../errors.js";
import type { Logger } from "../logging/StructuredLogger.js";

export interface CreateWorktreeOptions {
  source: WorkspaceSourceConfig;
  stateDir: string;
  workspacePath: string;
  branchName: string;
  timeoutMs: number;
  logger: Logger;
}

export interface RemoveWorktreeOptions {
  repoPath: string;
  workspacePath: string;
  cleanup: "refuse_dirty" | "force";
  timeoutMs: number;
  logger: Logger;
}

export interface MoveWorktreeOptions {
  repoPath: string;
  workspacePath: string;
  nextWorkspacePath: string;
  timeoutMs: number;
}

export interface WorktreeResult {
  repoPath: string;
  branchName: string;
  baseRef: string;
}

export interface CreatePlanningCheckoutOptions {
  source: WorkspaceSourceConfig;
  stateDir: string;
  workspacePath: string;
  timeoutMs: number;
  logger: Logger;
}

export interface PlanningCheckoutResult {
  repoPath: string;
  baseRef: string;
}

export async function createGitWorktree(options: CreateWorktreeOptions): Promise<WorktreeResult> {
  const repository = options.source.repository;
  const baseRef = options.source.baseRef;
  if (!repository) throw new SymphonyError("workspace_error", "workspace.source.repository is required");
  if (!baseRef) throw new SymphonyError("workspace_error", "workspace.source.base_ref is required");

  await fs.mkdir(options.stateDir, { recursive: true });
  const repoPath = await ensureSharedRepo(repository, options.source.cachePath, options.stateDir, options.timeoutMs);
  await withBranchLock(options.stateDir, repoPath, options.branchName, options.timeoutMs, async () => {
    await runGit(["check-ref-format", "--branch", options.branchName], repoPath, options.timeoutMs);
    await fetchRepo(repoPath, options.timeoutMs, options.logger);
    await ensureBranch(repoPath, options.branchName, baseRef, options.timeoutMs);
    await runGit(["worktree", "add", options.workspacePath, options.branchName], repoPath, options.timeoutMs);
  });

  return { repoPath, branchName: options.branchName, baseRef };
}

export async function createGitPlanningCheckout(options: CreatePlanningCheckoutOptions): Promise<PlanningCheckoutResult> {
  const repository = options.source.repository;
  const baseRef = options.source.baseRef;
  if (!repository) throw new SymphonyError("workspace_error", "workspace.source.repository is required");
  if (!baseRef) throw new SymphonyError("workspace_error", "workspace.source.base_ref is required");

  await fs.mkdir(options.stateDir, { recursive: true });
  const repoPath = await ensureSharedRepo(repository, options.source.cachePath, options.stateDir, options.timeoutMs);
  await fetchRepo(repoPath, options.timeoutMs, options.logger);
  const base = await resolveBaseRef(repoPath, baseRef, options.timeoutMs);
  await runGit(["worktree", "add", "--detach", options.workspacePath, base], repoPath, options.timeoutMs);
  return { repoPath, baseRef };
}

export async function removeGitWorktree(options: RemoveWorktreeOptions): Promise<void> {
  const status = await runGit(["status", "--porcelain"], options.workspacePath, options.timeoutMs, { allowFailure: true });
  if (options.cleanup === "refuse_dirty") {
    if (status.code !== 0) {
      throw new SymphonyError(
        "workspace_error",
        `Unable to determine worktree cleanliness; refusing to remove: ${options.workspacePath}`,
      );
    }
    if (status.stdout.trim().length > 0) {
      throw new SymphonyError("workspace_error", `Refusing to remove dirty worktree: ${options.workspacePath}`);
    }
  }

  const args = ["worktree", "remove"];
  if (options.cleanup === "force") args.push("--force");
  args.push(options.workspacePath);
  const removed = await runGit(args, options.repoPath, options.timeoutMs, { allowFailure: true });
  if (removed.code !== 0) {
    if (options.cleanup === "refuse_dirty") {
      throw new SymphonyError("workspace_error", `git worktree remove failed: ${removed.stderr}`);
    }
    options.logger.warn("git worktree remove failed; falling back to directory removal", {
      workspace_path: options.workspacePath,
      repo_path: options.repoPath,
      error: removed.stderr,
    });
    await fs.rm(options.workspacePath, { recursive: true, force: true });
  }
  await runGit(["worktree", "prune"], options.repoPath, options.timeoutMs, { allowFailure: true });
}

export async function moveGitWorktree(options: MoveWorktreeOptions): Promise<void> {
  await runGit(["worktree", "move", options.workspacePath, options.nextWorkspacePath], options.repoPath, options.timeoutMs);
}

async function ensureSharedRepo(
  repository: string,
  configuredCachePath: string | undefined,
  stateDir: string,
  timeoutMs: number,
): Promise<string> {
  if (await isLocalGitRepository(repository)) return path.resolve(repository);
  const repoPath =
    configuredCachePath ?? path.join(stateDir, "repos", crypto.createHash("sha256").update(repository).digest("hex").slice(0, 16));
  if (await pathExists(repoPath)) return repoPath;
  await fs.mkdir(path.dirname(repoPath), { recursive: true });
  await runCommand("git", ["clone", "--bare", repository, repoPath], path.dirname(repoPath), timeoutMs);
  return repoPath;
}

async function fetchRepo(repoPath: string, timeoutMs: number, logger: Logger): Promise<void> {
  const result = await runGit(["fetch", "--all", "--prune"], repoPath, timeoutMs, { allowFailure: true });
  if (result.code !== 0) {
    logger.warn("git fetch failed while preparing worktree", { repo_path: repoPath, error: result.stderr });
  }
}

async function ensureBranch(repoPath: string, branchName: string, baseRef: string, timeoutMs: number): Promise<void> {
  const localBranch = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], repoPath, timeoutMs, {
    allowFailure: true,
  });
  if (localBranch.code === 0) return;

  const remoteBranch = await runGit(
    ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branchName}`],
    repoPath,
    timeoutMs,
    { allowFailure: true },
  );
  if (remoteBranch.code === 0) {
    await runGit(["branch", "--track", branchName, `origin/${branchName}`], repoPath, timeoutMs);
    return;
  }

  const base = await resolveBaseRef(repoPath, baseRef, timeoutMs);
  await runGit(["branch", branchName, base], repoPath, timeoutMs);
}

async function resolveBaseRef(repoPath: string, baseRef: string, timeoutMs: number): Promise<string> {
  const candidates = [baseRef, `origin/${baseRef}`];
  for (const candidate of candidates) {
    const result = await runGit(["rev-parse", "--verify", `${candidate}^{commit}`], repoPath, timeoutMs, {
      allowFailure: true,
    });
    if (result.code === 0) return result.stdout.trim();
  }
  throw new SymphonyError("workspace_error", `Unable to resolve git_worktree base_ref: ${baseRef}`);
}

async function withBranchLock<T>(
  stateDir: string,
  repoPath: string,
  branchName: string,
  timeoutMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const locksDir = path.join(stateDir, "locks");
  await fs.mkdir(locksDir, { recursive: true });
  const lockName = crypto.createHash("sha256").update(`${repoPath}\0${branchName}`).digest("hex");
  const lockPath = path.join(locksDir, `${lockName}.lock`);
  const deadline = Date.now() + timeoutMs;
  let handle: fs.FileHandle | null = null;
  while (!handle) {
    try {
      handle = await fs.open(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
    return await fn();
  } finally {
    await handle.close();
    await fs.rm(lockPath, { force: true });
  }
}

async function isLocalGitRepository(repository: string): Promise<boolean> {
  const resolved = path.resolve(repository);
  if (!(await pathExists(resolved))) return false;
  if (await pathExists(path.join(resolved, ".git"))) return true;
  const headPath = path.join(resolved, "HEAD");
  const objectsPath = path.join(resolved, "objects");
  return (await pathExists(headPath)) && (await pathExists(objectsPath));
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runGit(
  args: string[],
  cwd: string,
  timeoutMs: number,
  options: { allowFailure?: boolean } = {},
): Promise<GitResult> {
  return runCommand("git", args, cwd, timeoutMs, options);
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  options: { allowFailure?: boolean } = {},
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

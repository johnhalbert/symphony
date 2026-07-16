import { constants as fsConstants, promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import type { WorkspaceSourceConfig } from "../config/Config.js";
import { SymphonyError } from "../errors.js";
import type { Logger } from "../logging/StructuredLogger.js";
import type {
  AcceptedArtifactWorkspaceSeed,
  ArtifactFileManifestEntry,
  WorkspaceSeedBinding,
} from "../types.js";
import {
  inspectAcceptedArtifactManifestAtHead,
  inspectAcceptedArtifactWorktreePath,
  type AcceptedArtifactManifestVerificationFailure,
} from "../AcceptedArtifactManifestVerification.js";

export interface CreateWorktreeOptions {
  source: WorkspaceSourceConfig;
  stateDir: string;
  workspacePath: string;
  branchName: string;
  seed?: AcceptedArtifactWorkspaceSeed;
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

export interface WorktreeResult {
  repoPath: string;
  branchName: string;
  baseRef: string;
  seed?: WorkspaceSeedBinding;
}

export interface SeededWorktreeCreationOptions {
  stateDir: string;
  repoPath: string;
  workspacePath: string;
  branchName: string;
  seed: AcceptedArtifactWorkspaceSeed;
  timeoutMs: number;
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

export interface AcceptedArtifactSeedConflictDetails {
  kind: "accepted_artifact_seed_conflict";
  artifactId: string;
  sourceIssueId: string;
  sourceIssueIdentifier: string;
  sourceBranch: string;
  sourceBaseHeadSha: string;
  sourceHeadSha: string;
  preparedBaseHeadSha: string;
  targetBranch: string;
  conflictedFiles: string[];
}

export class AcceptedArtifactSeedConflictError extends SymphonyError {
  readonly conflictDetails: AcceptedArtifactSeedConflictDetails;

  constructor(details: AcceptedArtifactSeedConflictDetails) {
    super(
      "conflict",
      `Accepted-artifact seed rebase conflicted in ${details.conflictedFiles.join(", ")}`,
      details,
    );
    this.name = "AcceptedArtifactSeedConflictError";
    this.conflictDetails = details;
  }

  static fromBinding(binding: WorkspaceSeedBinding): AcceptedArtifactSeedConflictError {
    return new AcceptedArtifactSeedConflictError({
      kind: "accepted_artifact_seed_conflict",
      artifactId: binding.artifactId,
      sourceIssueId: binding.sourceIssueId,
      sourceIssueIdentifier: binding.sourceIssueIdentifier,
      sourceBranch: binding.sourceBranch,
      sourceBaseHeadSha: binding.sourceBaseHeadSha,
      sourceHeadSha: binding.sourceHeadSha,
      preparedBaseHeadSha: binding.preparedBaseHeadSha,
      targetBranch: binding.targetBranch,
      conflictedFiles: [...binding.conflictedFiles],
    });
  }
}

export async function verifyGitWorktreeSeedBinding(
  workspacePath: string,
  binding: WorkspaceSeedBinding,
  timeoutMs: number,
): Promise<WorkspaceSeedBinding> {
  if (binding.conflictedFiles.length > 0) {
    return verifyConflictedSeedBinding(workspacePath, binding, timeoutMs);
  }
  if (binding.preparedHeadSha === null) {
    throw new SymphonyError(
      "workspace_error",
      "Prepared accepted-artifact workspace is missing its prepared head",
    );
  }
  assertFullGitObjectId(
    binding.preparedHeadSha,
    "Persisted accepted-artifact prepared head",
  );
  if ((await activeRebaseState(workspacePath, timeoutMs)) !== null) {
    throw new SymphonyError(
      "workspace_error",
      "Prepared accepted-artifact workspace unexpectedly has a rebase in progress",
    );
  }
  await assertNoUnmergedFiles(workspacePath, timeoutMs);
  const branch = await runGit(["branch", "--show-current"], workspacePath, timeoutMs);
  if (branch.stdout.trim() !== binding.targetBranch) {
    throw new SymphonyError(
      "workspace_error",
      `Seeded workspace is on branch ${branch.stdout.trim() || "(detached)"}, expected ${binding.targetBranch}`,
    );
  }
  const failure = await inspectAcceptedArtifactManifestAtHead({
    manifest: binding.fileManifest,
    runGit: async (args) => {
      const result = await runGit(args, workspacePath, timeoutMs, {
        allowFailure: true,
      });
      return result.code === 0 ? result.stdout : null;
    },
    inspectWorktreePath: (filePath) =>
      inspectAcceptedArtifactWorktreePath(workspacePath, filePath),
  });
  if (failure !== null) throw seedManifestVerificationError(failure);
  return binding;
}

function seedManifestVerificationError(
  failure: AcceptedArtifactManifestVerificationFailure,
): SymphonyError {
  if (failure.kind === "empty_manifest") {
    return new SymphonyError(
      "workspace_error",
      "Prepared accepted-artifact workspace has an empty manifest",
    );
  }
  if (failure.kind === "invalid_manifest") {
    return new SymphonyError("workspace_error", failure.message);
  }
  if (failure.kind === "worktree_inspection_failed") {
    return new SymphonyError(
      "workspace_error",
      "Unable to inspect accepted-artifact files in the prepared workspace",
    );
  }
  if (failure.kind === "worktree_dirty") {
    return new SymphonyError(
      "workspace_error",
      "Prepared accepted-artifact files have uncommitted changes",
    );
  }
  if (failure.kind === "tree_inspection_failed") {
    return new SymphonyError(
      "workspace_error",
      `Unable to inspect accepted-artifact file ${failure.path} at the current workspace head`,
    );
  }
  if (failure.kind === "deleted_path_present") {
    return new SymphonyError(
      "workspace_error",
      `Accepted-artifact deleted path ${failure.path} is present at the current workspace head`,
    );
  }
  if (failure.kind === "mode_mismatch") {
    return new SymphonyError(
      "workspace_error",
      `Accepted-artifact Git mode for ${failure.path} does not match its reviewed manifest at the current workspace head`,
    );
  }
  return new SymphonyError(
    "workspace_error",
    `Accepted-artifact blob for ${failure.path} does not match its reviewed manifest at the current workspace head`,
  );
}

export async function finalizeGitWorktreeSeedConflict(
  workspacePath: string,
  binding: WorkspaceSeedBinding,
  timeoutMs: number,
): Promise<WorkspaceSeedBinding> {
  if (binding.conflictedFiles.length === 0 || binding.preparedHeadSha !== null) {
    throw new SymphonyError(
      "workspace_error",
      "Accepted-artifact workspace does not have a seed conflict to finalize",
    );
  }
  let rebase = await activeRebaseState(workspacePath, timeoutMs);
  if (rebase !== null) {
    await verifyConflictedSeedBinding(
      workspacePath,
      binding,
      timeoutMs,
    );
    assertExactConflictPaths(
      binding.conflictedFiles,
      await seedConflictResolutionPaths(workspacePath, timeoutMs),
    );
    await assertOnlyExpectedConflictPathsModified(
      workspacePath,
      binding.conflictedFiles,
      timeoutMs,
    );
    await assertConflictMarkersRemoved(
      workspacePath,
      binding.conflictedFiles,
    );
    await assertConflictResolutionMatchesManifest(
      workspacePath,
      binding.conflictedFiles,
      binding.fileManifest,
      timeoutMs,
    );
    await runGit(
      [
        "add",
        "-A",
        "--",
        ...binding.conflictedFiles.map(literalPathspec),
      ],
      workspacePath,
      timeoutMs,
    );
    await assertNoUnmergedFiles(workspacePath, timeoutMs);

    for (let step = 0; rebase !== null && step < 1_000; step += 1) {
      const continued = await runGit(
        [
          "-c",
          "user.name=Symphony",
          "-c",
          "user.email=symphony@localhost",
          "-c",
          "core.editor=true",
          "rebase",
          "--continue",
        ],
        workspacePath,
        timeoutMs,
        { allowFailure: true },
      );
      const nextConflicts = await conflictedFiles(workspacePath, timeoutMs);
      if (nextConflicts.length > 0) {
        return verifyConflictedSeedBinding(
          workspacePath,
          {
            ...binding,
            conflictedFiles: await seedConflictResolutionPaths(
              workspacePath,
              timeoutMs,
            ),
          },
          timeoutMs,
        );
      }
      if (continued.code !== 0) {
        throw new SymphonyError(
          "workspace_error",
          `Unable to continue accepted-artifact seed rebase: ${continued.stderr.trim() || continued.stdout.trim()}`,
        );
      }
      rebase = await activeRebaseState(workspacePath, timeoutMs);
      if (rebase !== null) assertRebaseMatchesBinding(rebase, binding);
    }
    if (rebase !== null) {
      throw new SymphonyError(
        "workspace_error",
        "Accepted-artifact seed rebase continuation exceeded its step limit",
      );
    }
  }
  await assertNoUnmergedFiles(workspacePath, timeoutMs);
  await assertTargetBranch(workspacePath, binding.targetBranch, timeoutMs);
  const preparedHeadSha = (
    await runGit(["rev-parse", "--verify", "HEAD^{commit}"], workspacePath, timeoutMs)
  ).stdout.trim();
  const preparedBaseHeadSha = await resolveExactCommit(
    workspacePath,
    binding.preparedBaseHeadSha,
    "persisted accepted-artifact prepared base",
    timeoutMs,
  );
  await assertCommitAncestor(
    workspacePath,
    preparedBaseHeadSha,
    preparedHeadSha,
    "Resolved accepted-artifact seed no longer contains the current live base",
    timeoutMs,
  );
  await verifyPreparedArtifactFiles(
    workspacePath,
    preparedHeadSha,
    binding.fileManifest,
    timeoutMs,
  );
  await verifyPreparedArtifactDiff(
    workspacePath,
    preparedBaseHeadSha,
    preparedHeadSha,
    binding.fileManifest,
    timeoutMs,
  );
  return {
    ...binding,
    preparedBaseHeadSha,
    preparedHeadSha,
    conflictedFiles: [],
  };
}

export async function createGitWorktree(options: CreateWorktreeOptions): Promise<WorktreeResult> {
  const repository = options.source.repository;
  const baseRef = options.source.baseRef;
  if (!repository) throw new SymphonyError("workspace_error", "workspace.source.repository is required");
  if (!baseRef) throw new SymphonyError("workspace_error", "workspace.source.base_ref is required");
  if (options.seed) validateSeedConfiguration(options.seed, repository, baseRef);

  await fs.mkdir(options.stateDir, { recursive: true });
  const repoPath = await ensureSharedRepo(repository, options.source.cachePath, options.stateDir, options.timeoutMs);
  let seedBinding: WorkspaceSeedBinding | undefined;
  await withBranchLock(options.stateDir, repoPath, options.branchName, options.timeoutMs, async () => {
    await runGit(["check-ref-format", "--branch", options.branchName], repoPath, options.timeoutMs);
    await fetchRepo(repoPath, options.timeoutMs, options.logger, options.seed !== undefined);
    if (options.seed) {
      seedBinding = await createOrRecoverSeededWorktree({
        stateDir: options.stateDir,
        repoPath,
        workspacePath: options.workspacePath,
        branchName: options.branchName,
        baseRef,
        seed: options.seed,
        timeoutMs: options.timeoutMs,
      });
      return;
    }
    await ensureBranch(repoPath, options.branchName, baseRef, options.timeoutMs);
    await runGit(["worktree", "add", options.workspacePath, options.branchName], repoPath, options.timeoutMs);
  });

  return {
    repoPath,
    branchName: options.branchName,
    baseRef,
    ...(seedBinding === undefined ? {} : { seed: seedBinding }),
  };
}

export async function completeGitWorktreeCreation(
  options: SeededWorktreeCreationOptions,
): Promise<void> {
  await withBranchLock(
    options.stateDir,
    options.repoPath,
    options.branchName,
    options.timeoutMs,
    async () => {
      const transaction = await readSeedCreationTransaction(options);
      if (transaction === null) return;
      assertMatchingSeedCreationTransaction(transaction, options);
      if (transaction.binding === null) {
        throw new SymphonyError(
          "workspace_error",
          "Accepted-artifact worktree creation journal has no completed seed binding",
        );
      }
      await fs.rm(seedCreationTransactionPath(options), { force: true });
    },
  );
}

export async function rollbackGitWorktreeCreation(
  options: SeededWorktreeCreationOptions,
): Promise<void> {
  await withBranchLock(
    options.stateDir,
    options.repoPath,
    options.branchName,
    options.timeoutMs,
    async () => {
      const transaction = await readSeedCreationTransaction(options);
      if (transaction === null) return;
      assertMatchingSeedCreationTransaction(transaction, options);
      await rollbackSeedCreationTransaction(transaction, options.timeoutMs);
      await fs.rm(seedCreationTransactionPath(options), { force: true });
    },
  );
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

async function fetchRepo(
  repoPath: string,
  timeoutMs: number,
  logger: Logger,
  required = false,
): Promise<void> {
  const result = await runGit(["fetch", "--all", "--prune"], repoPath, timeoutMs, { allowFailure: true });
  if (result.code !== 0) {
    if (required) {
      throw new SymphonyError(
        "workspace_error",
        `git fetch failed while preparing accepted-artifact workspace: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    logger.warn("git fetch failed while preparing worktree", { repo_path: repoPath, error: result.stderr });
  }
}

interface CreateSeededWorktreeInput {
  stateDir: string;
  repoPath: string;
  workspacePath: string;
  branchName: string;
  baseRef: string;
  seed: AcceptedArtifactWorkspaceSeed;
  timeoutMs: number;
}

interface ResolvedSeedCreationPlan extends CreateSeededWorktreeInput {
  sourceBaseHeadSha: string;
  sourceHeadSha: string;
  preparedBaseHeadSha: string;
}

interface SeedCreationTransaction {
  version: 1;
  repoPath: string;
  workspacePath: string;
  branchName: string;
  baseRef: string;
  seed: AcceptedArtifactWorkspaceSeed;
  sourceBaseHeadSha: string;
  sourceHeadSha: string;
  preparedBaseHeadSha: string;
  binding: WorkspaceSeedBinding | null;
}

async function createOrRecoverSeededWorktree(
  input: CreateSeededWorktreeInput,
): Promise<WorkspaceSeedBinding> {
  const plan = await resolveSeedCreationPlan(input);
  let transaction = await readSeedCreationTransaction(input);
  if (transaction !== null) {
    assertMatchingSeedCreationTransaction(transaction, input);
    if (
      transaction.sourceBaseHeadSha !== plan.sourceBaseHeadSha ||
      transaction.sourceHeadSha !== plan.sourceHeadSha
    ) {
      throw new SymphonyError(
        "workspace_error",
        "Accepted-artifact worktree creation journal changed its reviewed source checkpoint",
      );
    }
    if (transaction.preparedBaseHeadSha !== plan.preparedBaseHeadSha) {
      await rollbackSeedCreationTransaction(transaction, input.timeoutMs);
      await fs.rm(seedCreationTransactionPath(input), { force: true });
      transaction = null;
    } else {
      const binding = await recoverSeededWorktree(transaction, input);
      await writeSeedCreationTransaction(input, { ...transaction, binding });
      return binding;
    }
  }

  await assertBranchDoesNotExist(input.repoPath, input.branchName, input.timeoutMs);
  transaction = {
    version: 1,
    repoPath: input.repoPath,
    workspacePath: input.workspacePath,
    branchName: input.branchName,
    baseRef: input.baseRef,
    seed: input.seed,
    sourceBaseHeadSha: plan.sourceBaseHeadSha,
    sourceHeadSha: plan.sourceHeadSha,
    preparedBaseHeadSha: plan.preparedBaseHeadSha,
    binding: null,
  };
  await writeSeedCreationTransaction(input, transaction);
  try {
    const binding = await executeSeedCreationPlan(plan);
    await writeSeedCreationTransaction(input, { ...transaction, binding });
    return binding;
  } catch (error) {
    try {
      await rollbackSeedCreationTransaction(transaction, input.timeoutMs);
      await fs.rm(seedCreationTransactionPath(input), { force: true });
    } catch {
      // Keep the journal when rollback cannot complete so restart recovery remains fail-closed.
    }
    throw error;
  }
}

async function resolveSeedCreationPlan(
  input: CreateSeededWorktreeInput,
): Promise<ResolvedSeedCreationPlan> {
  const sourceBaseHeadSha = await resolveExactCommit(
    input.repoPath,
    input.seed.sourceBaseHeadSha,
    "accepted artifact source base",
    input.timeoutMs,
  );
  const sourceHeadSha = await resolveExactCommit(
    input.repoPath,
    input.seed.sourceHeadSha,
    "accepted artifact source head",
    input.timeoutMs,
  );
  await assertCommitAncestor(
    input.repoPath,
    sourceBaseHeadSha,
    sourceHeadSha,
    "Accepted artifact source base is not an ancestor of its source head",
    input.timeoutMs,
  );
  await assertSourceBranchContainsCheckpoint(
    input.repoPath,
    input.seed.sourceBranch,
    sourceHeadSha,
    input.timeoutMs,
  );
  await verifySourceManifest(
    input.repoPath,
    sourceBaseHeadSha,
    sourceHeadSha,
    input.seed.fileManifest,
    input.timeoutMs,
  );
  const preparedBaseHeadSha = await resolveBaseRef(input.repoPath, input.baseRef, input.timeoutMs);
  return { ...input, sourceBaseHeadSha, sourceHeadSha, preparedBaseHeadSha };
}

async function executeSeedCreationPlan(
  input: ResolvedSeedCreationPlan,
): Promise<WorkspaceSeedBinding> {
  let branchCreated = false;
  let worktreeCreated = false;
  try {
    await runGit(["branch", input.branchName, input.sourceHeadSha], input.repoPath, input.timeoutMs);
    branchCreated = true;
    await runGit(["worktree", "add", input.workspacePath, input.branchName], input.repoPath, input.timeoutMs);
    worktreeCreated = true;
    return await finishSeedRebase(input);
  } catch (error) {
    if (worktreeCreated) {
      await runGit(
        ["worktree", "remove", "--force", input.workspacePath],
        input.repoPath,
        input.timeoutMs,
        { allowFailure: true },
      );
    }
    if (branchCreated) {
      await runGit(["branch", "-D", input.branchName], input.repoPath, input.timeoutMs, { allowFailure: true });
    }
    throw error;
  }
}

async function finishSeedRebase(
  input: ResolvedSeedCreationPlan,
): Promise<WorkspaceSeedBinding> {
  if (input.sourceBaseHeadSha !== input.preparedBaseHeadSha) {
    const rebase = await runGit(
      [
        "-c",
        "user.name=Symphony",
        "-c",
        "user.email=symphony@localhost",
        "rebase",
        "--onto",
        input.preparedBaseHeadSha,
        input.sourceBaseHeadSha,
      ],
      input.workspacePath,
      input.timeoutMs,
      { allowFailure: true },
    );
    if (rebase.code !== 0) {
      const conflicted = await conflictedFiles(input.workspacePath, input.timeoutMs);
      if (conflicted.length > 0) {
        return conflictedSeedBinding(
          input,
          await seedConflictResolutionPaths(
            input.workspacePath,
            input.timeoutMs,
          ),
        );
      }
      throw new SymphonyError(
        "workspace_error",
        `Accepted-artifact seed rebase failed: ${rebase.stderr.trim() || rebase.stdout.trim()}`,
      );
    }
  }
  return preparedSeedBinding(input);
}

async function preparedSeedBinding(
  input: ResolvedSeedCreationPlan,
): Promise<WorkspaceSeedBinding> {
  await assertTargetBranch(input.workspacePath, input.branchName, input.timeoutMs);
  await assertNoUnmergedFiles(input.workspacePath, input.timeoutMs);
  const preparedHeadSha = await resolveExactCommit(
    input.repoPath,
    (
      await runGit(
        ["rev-parse", "--verify", "HEAD^{commit}"],
        input.workspacePath,
        input.timeoutMs,
      )
    ).stdout.trim(),
    "prepared workspace head",
    input.timeoutMs,
  );
  await assertCommitAncestor(
    input.repoPath,
    input.preparedBaseHeadSha,
    preparedHeadSha,
    "Prepared accepted-artifact workspace no longer contains its planned live base",
    input.timeoutMs,
  );
  await verifyPreparedArtifactFiles(
    input.repoPath,
    preparedHeadSha,
    input.seed.fileManifest,
    input.timeoutMs,
  );
  await verifyPreparedArtifactDiff(
    input.repoPath,
    input.preparedBaseHeadSha,
    preparedHeadSha,
    input.seed.fileManifest,
    input.timeoutMs,
  );
  return {
    ...input.seed,
    targetBranch: input.branchName,
    preparedBaseHeadSha: input.preparedBaseHeadSha,
    preparedHeadSha,
    conflictedFiles: [],
  };
}

function conflictedSeedBinding(
  input: ResolvedSeedCreationPlan,
  conflicted: string[],
): WorkspaceSeedBinding {
  return {
    ...input.seed,
    preparedBaseHeadSha: input.preparedBaseHeadSha,
    targetBranch: input.branchName,
    preparedHeadSha: null,
    conflictedFiles: conflicted,
  };
}

async function recoverSeededWorktree(
  transaction: SeedCreationTransaction,
  input: CreateSeededWorktreeInput,
): Promise<WorkspaceSeedBinding> {
  const plan: ResolvedSeedCreationPlan = {
    ...input,
    sourceBaseHeadSha: transaction.sourceBaseHeadSha,
    sourceHeadSha: transaction.sourceHeadSha,
    preparedBaseHeadSha: transaction.preparedBaseHeadSha,
  };
  if (transaction.binding !== null) {
    assertBindingMatchesTransaction(transaction.binding, transaction);
    if (
      transaction.binding.conflictedFiles.length > 0 &&
      (await activeRebaseState(transaction.workspacePath, input.timeoutMs)) === null
    ) {
      throw new SymphonyError(
        "workspace_error",
        "Journaled accepted-artifact seed conflict lost its service-prepared rebase",
      );
    }
    const verified = await verifyGitWorktreeSeedBinding(
      transaction.workspacePath,
      transaction.binding,
      input.timeoutMs,
    );
    if (verified.preparedHeadSha !== null) {
      const currentHead = (
        await runGit(
          ["rev-parse", "--verify", "HEAD^{commit}"],
          transaction.workspacePath,
          input.timeoutMs,
        )
      ).stdout.trim();
      if (currentHead.toLowerCase() !== verified.preparedHeadSha.toLowerCase()) {
        throw new SymphonyError(
          "workspace_error",
          "Journaled accepted-artifact worktree advanced before workspace metadata was persisted",
        );
      }
    }
    return verified;
  }

  if (!(await pathExists(transaction.workspacePath))) {
    const branchHead = await branchHeadSha(
      transaction.repoPath,
      transaction.branchName,
      input.timeoutMs,
    );
    if (branchHead === null) return executeSeedCreationPlan(plan);
    if (branchHead.toLowerCase() !== transaction.sourceHeadSha.toLowerCase()) {
      throw new SymphonyError(
        "workspace_error",
        "Interrupted accepted-artifact creation left an unexpected target branch head",
      );
    }
    await runGit(
      ["branch", "-D", transaction.branchName],
      transaction.repoPath,
      input.timeoutMs,
    );
    return executeSeedCreationPlan(plan);
  }

  await assertRegisteredSeedWorktree(transaction, input.timeoutMs);
  let rebase = await activeRebaseState(transaction.workspacePath, input.timeoutMs);
  if (rebase !== null) {
    assertRebaseMatchesTransaction(rebase, transaction);
    let conflicted = await conflictedFiles(transaction.workspacePath, input.timeoutMs);
    if (conflicted.length > 0) {
      return conflictedSeedBinding(
        plan,
        await seedConflictResolutionPaths(
          transaction.workspacePath,
          input.timeoutMs,
        ),
      );
    }
    for (let step = 0; rebase !== null && step < 1_000; step += 1) {
      const continued = await runGit(
        [
          "-c",
          "user.name=Symphony",
          "-c",
          "user.email=symphony@localhost",
          "-c",
          "core.editor=true",
          "rebase",
          "--continue",
        ],
        transaction.workspacePath,
        input.timeoutMs,
        { allowFailure: true },
      );
      conflicted = await conflictedFiles(transaction.workspacePath, input.timeoutMs);
      if (conflicted.length > 0) {
        return conflictedSeedBinding(
          plan,
          await seedConflictResolutionPaths(
            transaction.workspacePath,
            input.timeoutMs,
          ),
        );
      }
      if (continued.code !== 0) {
        throw new SymphonyError(
          "workspace_error",
          `Unable to resume interrupted accepted-artifact seed rebase: ${continued.stderr.trim() || continued.stdout.trim()}`,
        );
      }
      rebase = await activeRebaseState(transaction.workspacePath, input.timeoutMs);
      if (rebase !== null) assertRebaseMatchesTransaction(rebase, transaction);
    }
    if (rebase !== null) {
      throw new SymphonyError(
        "workspace_error",
        "Interrupted accepted-artifact seed rebase exceeded its recovery step limit",
      );
    }
    return preparedSeedBinding(plan);
  }

  await assertTargetBranch(
    transaction.workspacePath,
    transaction.branchName,
    input.timeoutMs,
  );
  const currentHead = (
    await runGit(
      ["rev-parse", "--verify", "HEAD^{commit}"],
      transaction.workspacePath,
      input.timeoutMs,
    )
  ).stdout.trim();
  if (
    transaction.sourceBaseHeadSha !== transaction.preparedBaseHeadSha &&
    currentHead.toLowerCase() === transaction.sourceHeadSha.toLowerCase()
  ) {
    return finishSeedRebase(plan);
  }
  if (
    transaction.sourceBaseHeadSha === transaction.preparedBaseHeadSha &&
    currentHead.toLowerCase() !== transaction.sourceHeadSha.toLowerCase()
  ) {
    throw new SymphonyError(
      "workspace_error",
      "Interrupted accepted-artifact creation changed its unrebased target branch head",
    );
  }
  return preparedSeedBinding(plan);
}

function assertRebaseMatchesTransaction(
  rebase: ActiveRebaseState,
  transaction: SeedCreationTransaction,
): void {
  if (
    rebase.headName !== `refs/heads/${transaction.branchName}` ||
    rebase.onto.toLowerCase() !== transaction.preparedBaseHeadSha.toLowerCase() ||
    rebase.originalHead.toLowerCase() !== transaction.sourceHeadSha.toLowerCase()
  ) {
    throw new SymphonyError(
      "workspace_error",
      "Interrupted accepted-artifact rebase does not match its durable creation journal",
    );
  }
}

async function assertRegisteredSeedWorktree(
  transaction: SeedCreationTransaction,
  timeoutMs: number,
): Promise<void> {
  const listed = await runGit(
    ["worktree", "list", "--porcelain"],
    transaction.repoPath,
    timeoutMs,
  );
  const expectedPath = path.resolve(transaction.workspacePath);
  const registered = listed.stdout
    .split(/\n\n+/)
    .map((entry) => entry.split("\n"))
    .find((lines) => {
      const worktree = lines.find((line) => line.startsWith("worktree "));
      return worktree !== undefined && path.resolve(worktree.slice("worktree ".length)) === expectedPath;
    });
  if (registered === undefined) {
    throw new SymphonyError(
      "workspace_error",
      "Interrupted accepted-artifact workspace is not registered at its journaled path",
    );
  }
}

async function branchHeadSha(
  repoPath: string,
  branchName: string,
  timeoutMs: number,
): Promise<string | null> {
  const result = await runGit(
    ["rev-parse", "--verify", `refs/heads/${branchName}^{commit}`],
    repoPath,
    timeoutMs,
    { allowFailure: true },
  );
  return result.code === 0 ? result.stdout.trim() : null;
}

async function rollbackSeedCreationTransaction(
  transaction: SeedCreationTransaction,
  timeoutMs: number,
): Promise<void> {
  if (await pathExists(transaction.workspacePath)) {
    await assertRegisteredSeedWorktree(transaction, timeoutMs);
    const removed = await runGit(
      ["worktree", "remove", "--force", transaction.workspacePath],
      transaction.repoPath,
      timeoutMs,
      { allowFailure: true },
    );
    if (removed.code !== 0) {
      throw new SymphonyError(
        "workspace_error",
        `Unable to rollback accepted-artifact worktree: ${removed.stderr.trim() || removed.stdout.trim()}`,
      );
    }
  }
  if ((await branchHeadSha(transaction.repoPath, transaction.branchName, timeoutMs)) !== null) {
    await runGit(
      ["branch", "-D", transaction.branchName],
      transaction.repoPath,
      timeoutMs,
    );
  }
  await runGit(
    ["worktree", "prune"],
    transaction.repoPath,
    timeoutMs,
    { allowFailure: true },
  );
}

function assertBindingMatchesTransaction(
  binding: WorkspaceSeedBinding,
  transaction: SeedCreationTransaction,
): void {
  if (
    !sameAcceptedArtifactSeed(binding, transaction.seed) ||
    binding.targetBranch !== transaction.branchName ||
    binding.preparedBaseHeadSha !== transaction.preparedBaseHeadSha
  ) {
    throw new SymphonyError(
      "workspace_error",
      "Accepted-artifact worktree creation journal contains a mismatched seed binding",
    );
  }
}

function seedCreationTransactionPath(
  input: Pick<SeededWorktreeCreationOptions, "stateDir" | "repoPath" | "workspacePath" | "branchName">,
): string {
  const key = crypto
    .createHash("sha256")
    .update(`${path.resolve(input.repoPath)}\0${path.resolve(input.workspacePath)}\0${input.branchName}`)
    .digest("hex");
  return path.join(input.stateDir, "seed-worktree-creations", `${key}.json`);
}

async function readSeedCreationTransaction(
  input: Pick<SeededWorktreeCreationOptions, "stateDir" | "repoPath" | "workspacePath" | "branchName">,
): Promise<SeedCreationTransaction | null> {
  const filePath = seedCreationTransactionPath(input);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const value = JSON.parse(raw) as SeedCreationTransaction;
    if (value?.version !== 1 || typeof value.repoPath !== "string") throw new Error("invalid journal");
    return value;
  } catch (error) {
    throw new SymphonyError(
      "workspace_error",
      `Unable to read accepted-artifact worktree creation journal: ${String(error)}`,
      error,
    );
  }
}

async function writeSeedCreationTransaction(
  input: Pick<SeededWorktreeCreationOptions, "stateDir" | "repoPath" | "workspacePath" | "branchName">,
  transaction: SeedCreationTransaction,
): Promise<void> {
  const filePath = seedCreationTransactionPath(input);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(transaction, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
}

function assertMatchingSeedCreationTransaction(
  transaction: SeedCreationTransaction,
  input: Pick<SeededWorktreeCreationOptions, "repoPath" | "workspacePath" | "branchName" | "seed"> & { baseRef?: string },
): void {
  if (
    path.resolve(transaction.repoPath) !== path.resolve(input.repoPath) ||
    path.resolve(transaction.workspacePath) !== path.resolve(input.workspacePath) ||
    transaction.branchName !== input.branchName ||
    (input.baseRef !== undefined && transaction.baseRef !== input.baseRef) ||
    !sameAcceptedArtifactSeed(transaction.seed, input.seed)
  ) {
    throw new SymphonyError(
      "workspace_error",
      "Accepted-artifact worktree creation journal does not match the requested seed",
    );
  }
}

function sameAcceptedArtifactSeed(
  left: AcceptedArtifactWorkspaceSeed,
  right: AcceptedArtifactWorkspaceSeed,
): boolean {
  return (
    left.version === right.version &&
    left.kind === right.kind &&
    left.artifactId === right.artifactId &&
    left.sourceIssueId === right.sourceIssueId &&
    left.sourceIssueIdentifier === right.sourceIssueIdentifier &&
    left.repositoryFingerprint === right.repositoryFingerprint &&
    left.sourceBranch === right.sourceBranch &&
    left.sourceHeadSha === right.sourceHeadSha &&
    left.sourceBaseHeadSha === right.sourceBaseHeadSha &&
    left.configuredBaseRef === right.configuredBaseRef &&
    JSON.stringify(left.fileManifest) === JSON.stringify(right.fileManifest)
  );
}

interface ActiveRebaseState {
  headName: string;
  onto: string;
  originalHead: string;
}

async function verifyConflictedSeedBinding(
  workspacePath: string,
  binding: WorkspaceSeedBinding,
  timeoutMs: number,
): Promise<WorkspaceSeedBinding> {
  if (binding.preparedHeadSha !== null) {
    throw new SymphonyError(
      "workspace_error",
      "Conflicted accepted-artifact workspace unexpectedly has a prepared head",
    );
  }
  const rebase = await activeRebaseState(workspacePath, timeoutMs);
  const currentConflicts = await conflictedFiles(workspacePath, timeoutMs);
  const currentResolutionPaths =
    currentConflicts.length === 0
      ? []
      : await seedConflictResolutionPaths(workspacePath, timeoutMs);
  if (rebase === null) {
    if (currentConflicts.length > 0) {
      throw new SymphonyError(
        "workspace_error",
        "Accepted-artifact workspace has unmerged files without its seed rebase",
      );
    }
    await assertTargetBranch(workspacePath, binding.targetBranch, timeoutMs);
    const currentHead = (
      await runGit(["rev-parse", "--verify", "HEAD^{commit}"], workspacePath, timeoutMs)
    ).stdout.trim();
    await assertCommitAncestor(
      workspacePath,
      binding.preparedBaseHeadSha,
      currentHead,
      "Resolved accepted-artifact workspace no longer contains its prepared base",
      timeoutMs,
    );
    await verifyPreparedArtifactFiles(
      workspacePath,
      currentHead,
      binding.fileManifest,
      timeoutMs,
    );
    return binding;
  }

  assertRebaseMatchesBinding(rebase, binding);
  const currentBranch = (
    await runGit(["branch", "--show-current"], workspacePath, timeoutMs)
  ).stdout.trim();
  if (currentBranch.length > 0) {
    throw new SymphonyError(
      "workspace_error",
      `Accepted-artifact seed rebase unexpectedly has branch ${currentBranch} checked out`,
    );
  }
  const currentHead = (
    await runGit(["rev-parse", "--verify", "HEAD^{commit}"], workspacePath, timeoutMs)
  ).stdout.trim();
  await assertCommitAncestor(
    workspacePath,
    binding.preparedBaseHeadSha,
    currentHead,
    "Accepted-artifact seed rebase no longer descends from its persisted prepared base",
    timeoutMs,
  );
  for (const filePath of currentResolutionPaths) {
    assertRepositoryRelativePath(filePath);
  }
  return currentConflicts.length === 0
    ? binding
    : { ...binding, conflictedFiles: currentResolutionPaths };
}

function assertRebaseMatchesBinding(
  rebase: ActiveRebaseState,
  binding: WorkspaceSeedBinding,
): void {
  if (rebase.headName !== `refs/heads/${binding.targetBranch}`) {
    throw new SymphonyError(
      "workspace_error",
      `Accepted-artifact seed rebase targets ${rebase.headName}, expected refs/heads/${binding.targetBranch}`,
    );
  }
  if (rebase.onto.toLowerCase() !== binding.preparedBaseHeadSha.toLowerCase()) {
    throw new SymphonyError(
      "workspace_error",
      "Accepted-artifact seed rebase no longer targets its persisted prepared base",
    );
  }
  if (rebase.originalHead.toLowerCase() !== binding.sourceHeadSha.toLowerCase()) {
    throw new SymphonyError(
      "workspace_error",
      "Accepted-artifact seed rebase no longer replays its persisted source head",
    );
  }
}

function assertExactConflictPaths(
  expectedPaths: string[],
  actualPaths: string[],
): void {
  const expected = [...new Set(expectedPaths)].sort();
  const actual = [...new Set(actualPaths)].sort();
  if (
    expected.length !== actual.length ||
    expected.some((filePath, index) => filePath !== actual[index])
  ) {
    throw new SymphonyError(
      "workspace_error",
      `Accepted-artifact seed conflict paths changed outside Symphony control (expected: ${expected.join(", ") || "none"}; actual: ${actual.join(", ") || "none"})`,
    );
  }
}

async function assertOnlyExpectedConflictPathsModified(
  workspacePath: string,
  expectedPaths: string[],
  timeoutMs: number,
): Promise<void> {
  const expected = new Set(expectedPaths);
  const unstaged = await runGit(
    ["diff", "--name-only", "-z", "--"],
    workspacePath,
    timeoutMs,
  );
  const untracked = await runGit(
    ["ls-files", "--others", "--exclude-standard", "-z", "--"],
    workspacePath,
    timeoutMs,
  );
  const modified = [...unstaged.stdout.split("\0"), ...untracked.stdout.split("\0")]
    .filter((filePath) => filePath.length > 0);
  const unexpected = [...new Set(modified)]
    .filter((filePath) => !expected.has(filePath))
    .sort();
  if (unexpected.length > 0) {
    throw new SymphonyError(
      "workspace_error",
      `Accepted-artifact conflict turn modified paths outside its persisted conflict set: ${unexpected.join(", ")}`,
    );
  }
}

async function assertConflictMarkersRemoved(
  workspacePath: string,
  expectedPaths: string[],
): Promise<void> {
  const unresolved: string[] = [];
  for (const filePath of expectedPaths) {
    let contents: string;
    try {
      contents = await fs.readFile(path.join(workspacePath, filePath), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (/^(?:<{7}|\|{7}|={7}|>{7})(?: |$)/m.test(contents)) {
      unresolved.push(filePath);
    }
  }
  if (unresolved.length > 0) {
    throw new SymphonyError(
      "workspace_error",
      `Accepted-artifact conflict resolution still contains conflict markers: ${unresolved.join(", ")}`,
    );
  }
}

async function assertConflictResolutionMatchesManifest(
  workspacePath: string,
  conflictPaths: string[],
  manifest: ArtifactFileManifestEntry[],
  timeoutMs: number,
): Promise<void> {
  const conflicts = new Set(conflictPaths);
  for (const entry of manifest) {
    if (!conflicts.has(entry.path)) continue;
    if (entry.status === "deleted") {
      const observation = await inspectAcceptedArtifactWorktreePath(
        workspacePath,
        entry.path,
      );
      if (observation.kind !== "missing") {
        throw new SymphonyError(
          "workspace_error",
          `Accepted-artifact conflict resolution retained reviewed deletion ${entry.path}`,
        );
      }
      continue;
    }
    const observation = await inspectAcceptedArtifactWorktreePath(
      workspacePath,
      entry.path,
    );
    const actualMode = worktreeGitMode(observation);
    if (entry.mode !== undefined && actualMode !== entry.mode) {
      throw new SymphonyError(
        "workspace_error",
        `Accepted-artifact conflict resolution for ${entry.path} does not match its reviewed Git mode`,
      );
    }
    let matchesReviewedBlob = false;
    if (observation.kind === "symlink") {
      const expectedTarget = await runGit(
        ["cat-file", "blob", entry.blobSha!],
        workspacePath,
        timeoutMs,
        { allowFailure: true },
      );
      matchesReviewedBlob =
        expectedTarget.code === 0 && expectedTarget.stdout === observation.target;
    } else if (observation.kind === "file") {
      const hashed = await runGit(
        ["hash-object", "--", entry.path],
        workspacePath,
        timeoutMs,
        { allowFailure: true },
      );
      matchesReviewedBlob =
        hashed.code === 0 &&
        hashed.stdout.trim().toLowerCase() === entry.blobSha?.toLowerCase();
    }
    if (!matchesReviewedBlob) {
      throw new SymphonyError(
        "workspace_error",
        `Accepted-artifact conflict resolution for ${entry.path} does not match its reviewed blob`,
      );
    }
  }
}

function worktreeGitMode(
  observation: Awaited<ReturnType<typeof inspectAcceptedArtifactWorktreePath>>,
): ArtifactFileManifestEntry["mode"] | undefined {
  if (observation.kind === "symlink") return "120000";
  if (observation.kind === "file") {
    return observation.executable ? "100755" : "100644";
  }
  return undefined;
}

function literalPathspec(filePath: string): string {
  assertRepositoryRelativePath(filePath);
  return `:(literal)${filePath}`;
}

async function assertTargetBranch(
  workspacePath: string,
  targetBranch: string,
  timeoutMs: number,
): Promise<void> {
  const branch = await runGit(["branch", "--show-current"], workspacePath, timeoutMs);
  if (branch.stdout.trim() !== targetBranch) {
    throw new SymphonyError(
      "workspace_error",
      `Seeded workspace is on branch ${branch.stdout.trim() || "(detached)"}, expected ${targetBranch}`,
    );
  }
}

async function assertNoUnmergedFiles(workspacePath: string, timeoutMs: number): Promise<void> {
  const unmerged = await conflictedFiles(workspacePath, timeoutMs);
  if (unmerged.length > 0) {
    throw new SymphonyError(
      "workspace_error",
      `Accepted-artifact workspace still has unmerged files: ${unmerged.join(", ")}`,
    );
  }
}

async function activeRebaseState(
  workspacePath: string,
  timeoutMs: number,
): Promise<ActiveRebaseState | null> {
  for (const marker of ["rebase-merge", "rebase-apply"]) {
    const gitPath = (
      await runGit(["rev-parse", "--git-path", marker], workspacePath, timeoutMs)
    ).stdout.trim();
    const rebasePath = path.resolve(workspacePath, gitPath);
    if (!(await pathExists(rebasePath))) continue;
    const readRequired = async (name: string): Promise<string> => {
      try {
        const value = (await fs.readFile(path.join(rebasePath, name), "utf8")).trim();
        if (value.length > 0) return value;
      } catch {
        // Report all malformed interrupted-rebase state through one fail-closed error.
      }
      throw new SymphonyError(
        "workspace_error",
        `Accepted-artifact seed rebase is missing ${marker}/${name}`,
      );
    };
    return {
      headName: await readRequired("head-name"),
      onto: await readRequired("onto"),
      originalHead: await readRequired("orig-head"),
    };
  }
  return null;
}

export function workspaceRepositoryFingerprint(repository: string): string {
  return `sha256:${crypto.createHash("sha256").update(repository.trim()).digest("hex")}`;
}

function validateSeedConfiguration(
  seed: AcceptedArtifactWorkspaceSeed,
  repository: string,
  baseRef: string,
): void {
  if (seed.configuredBaseRef !== baseRef) {
    throw new SymphonyError(
      "workspace_error",
      `Accepted-artifact seed base_ref ${seed.configuredBaseRef} does not match configured base_ref ${baseRef}`,
    );
  }
  const fingerprint = workspaceRepositoryFingerprint(repository);
  if (seed.repositoryFingerprint !== fingerprint) {
    throw new SymphonyError(
      "workspace_error",
      "Accepted-artifact seed repository does not match the configured workspace repository",
    );
  }
  if (seed.fileManifest.length === 0) {
    throw new SymphonyError("workspace_error", "Accepted-artifact seed file manifest is empty");
  }
}

async function assertBranchDoesNotExist(
  repoPath: string,
  branchName: string,
  timeoutMs: number,
): Promise<void> {
  for (const ref of [`refs/heads/${branchName}`, `refs/remotes/origin/${branchName}`]) {
    const result = await runGit(["show-ref", "--verify", "--quiet", ref], repoPath, timeoutMs, {
      allowFailure: true,
    });
    if (result.code === 0) {
      throw new SymphonyError(
        "workspace_error",
        `Refusing to prepare accepted-artifact seed on existing target branch ${branchName}`,
      );
    }
  }
}

async function resolveExactCommit(
  repoPath: string,
  expectedSha: string,
  label: string,
  timeoutMs: number,
): Promise<string> {
  assertFullGitObjectId(expectedSha, label);
  const result = await runGit(["rev-parse", "--verify", `${expectedSha}^{commit}`], repoPath, timeoutMs, {
    allowFailure: true,
  });
  if (result.code !== 0) {
    throw new SymphonyError("workspace_error", `Unable to resolve ${label} ${expectedSha}`);
  }
  const resolved = result.stdout.trim();
  if (resolved.toLowerCase() !== expectedSha.toLowerCase()) {
    throw new SymphonyError("workspace_error", `${label} did not resolve to the exact accepted object ID`);
  }
  return resolved;
}

function assertFullGitObjectId(value: string, label: string): void {
  if (!/^[0-9a-f]{40,64}$/i.test(value)) {
    throw new SymphonyError(
      "workspace_error",
      `${label} must be a full git object ID`,
    );
  }
}

async function assertCommitAncestor(
  repoPath: string,
  ancestor: string,
  descendant: string,
  message: string,
  timeoutMs: number,
): Promise<void> {
  const result = await runGit(["merge-base", "--is-ancestor", ancestor, descendant], repoPath, timeoutMs, {
    allowFailure: true,
  });
  if (result.code !== 0) throw new SymphonyError("workspace_error", message);
}

async function assertSourceBranchContainsCheckpoint(
  repoPath: string,
  sourceBranch: string,
  sourceHeadSha: string,
  timeoutMs: number,
): Promise<void> {
  const trimmed = sourceBranch.trim();
  if (trimmed.length === 0) {
    throw new SymphonyError("workspace_error", "Accepted-artifact source branch is empty");
  }
  const candidates = trimmed.startsWith("refs/") ? [trimmed] : [trimmed, `origin/${trimmed}`];
  for (const candidate of candidates) {
    const resolved = await runGit(["rev-parse", "--verify", `${candidate}^{commit}`], repoPath, timeoutMs, {
      allowFailure: true,
    });
    if (resolved.code !== 0) continue;
    const contains = await runGit(
      ["merge-base", "--is-ancestor", sourceHeadSha, resolved.stdout.trim()],
      repoPath,
      timeoutMs,
      { allowFailure: true },
    );
    if (contains.code === 0) return;
  }
  throw new SymphonyError(
    "workspace_error",
    `Accepted-artifact source branch ${sourceBranch} does not contain checkpoint ${sourceHeadSha}`,
  );
}

async function verifySourceManifest(
  repoPath: string,
  sourceBaseHeadSha: string,
  sourceHeadSha: string,
  manifest: ArtifactFileManifestEntry[],
  timeoutMs: number,
): Promise<void> {
  const actual = await sourceDiffManifest(repoPath, sourceBaseHeadSha, sourceHeadSha, timeoutMs);
  const expectedByPath = validatedManifestByPath(manifest);
  if (actual.size !== expectedByPath.size) {
    throw new SymphonyError(
      "workspace_error",
      "Accepted-artifact file manifest does not match the source checkpoint diff",
    );
  }
  for (const [filePath, status] of actual) {
    if (expectedByPath.get(filePath)?.status !== status) {
      throw new SymphonyError(
        "workspace_error",
        `Accepted-artifact file manifest does not match source change ${filePath}`,
      );
    }
  }
  await verifyManifestObjects(repoPath, sourceHeadSha, manifest, timeoutMs, "source checkpoint");
}

async function verifyPreparedArtifactFiles(
  repoPath: string,
  preparedHeadSha: string,
  manifest: ArtifactFileManifestEntry[],
  timeoutMs: number,
): Promise<void> {
  validatedManifestByPath(manifest);
  for (const entry of manifest) {
    const preparedObject = await treeObjectEntry(
      repoPath,
      preparedHeadSha,
      entry.path,
      timeoutMs,
    );
    if (entry.status === "deleted") {
      if (preparedObject !== null) {
        throw new SymphonyError(
          "workspace_error",
          `Accepted-artifact deleted path ${entry.path} is present in prepared workspace`,
        );
      }
      continue;
    }
    if (preparedObject === null) {
      throw new SymphonyError(
        "workspace_error",
        `Accepted-artifact path ${entry.path} is missing from prepared workspace`,
      );
    }
    if (
      preparedObject.objectType !== "blob" ||
      preparedObject.objectSha.toLowerCase() !== entry.blobSha?.toLowerCase()
    ) {
      throw new SymphonyError(
        "workspace_error",
        `Accepted-artifact blob for ${entry.path} does not match its reviewed manifest`,
      );
    }
    if (entry.mode !== undefined && preparedObject.mode !== entry.mode) {
      throw new SymphonyError(
        "workspace_error",
        `Accepted-artifact Git mode for ${entry.path} does not match its reviewed manifest`,
      );
    }
  }
}

async function verifyPreparedArtifactDiff(
  repoPath: string,
  preparedBaseHeadSha: string,
  preparedHeadSha: string,
  manifest: ArtifactFileManifestEntry[],
  timeoutMs: number,
): Promise<void> {
  const actual = await sourceDiffManifest(
    repoPath,
    preparedBaseHeadSha,
    preparedHeadSha,
    timeoutMs,
  );
  const expected = validatedManifestByPath(manifest);
  if (actual.size !== expected.size) {
    throw new SymphonyError(
      "workspace_error",
      "Prepared accepted-artifact diff contains changes outside its reviewed manifest",
    );
  }
  for (const [filePath, status] of actual) {
    if (expected.get(filePath)?.status !== status) {
      throw new SymphonyError(
        "workspace_error",
        `Prepared accepted-artifact diff changed the reviewed status of ${filePath}`,
      );
    }
  }
}

function validatedManifestByPath(
  manifest: ArtifactFileManifestEntry[],
): Map<string, ArtifactFileManifestEntry> {
  const entries = new Map<string, ArtifactFileManifestEntry>();
  for (const entry of manifest) {
    assertRepositoryRelativePath(entry.path);
    if (entries.has(entry.path)) {
      throw new SymphonyError("workspace_error", `Accepted-artifact manifest repeats path ${entry.path}`);
    }
    if (entry.status === "deleted") {
      if (entry.blobSha !== null) {
        throw new SymphonyError(
          "workspace_error",
          `Deleted accepted-artifact path ${entry.path} must have a null blob SHA`,
        );
      }
      if (entry.mode !== undefined && entry.mode !== null) {
        throw new SymphonyError(
          "workspace_error",
          `Deleted accepted-artifact path ${entry.path} must have a null Git mode`,
        );
      }
    } else if (entry.blobSha === null || !/^[0-9a-f]{40,64}$/i.test(entry.blobSha)) {
      throw new SymphonyError(
        "workspace_error",
        `Accepted-artifact path ${entry.path} must have a full blob SHA`,
      );
    } else if (
      entry.mode !== undefined &&
      entry.mode !== "100644" &&
      entry.mode !== "100755" &&
      entry.mode !== "120000"
    ) {
      throw new SymphonyError(
        "workspace_error",
        `Accepted-artifact path ${entry.path} has an invalid Git mode`,
      );
    }
    entries.set(entry.path, entry);
  }
  return entries;
}

function assertRepositoryRelativePath(filePath: string): void {
  if (
    filePath.length === 0 ||
    filePath.includes("\0") ||
    path.posix.isAbsolute(filePath) ||
    path.posix.normalize(filePath).startsWith("../") ||
    path.posix.normalize(filePath) !== filePath
  ) {
    throw new SymphonyError("workspace_error", `Invalid accepted-artifact manifest path ${JSON.stringify(filePath)}`);
  }
}

async function sourceDiffManifest(
  repoPath: string,
  sourceBaseHeadSha: string,
  sourceHeadSha: string,
  timeoutMs: number,
): Promise<Map<string, ArtifactFileManifestEntry["status"]>> {
  const result = await runGit(
    ["diff", "--name-status", "-z", "--find-renames", sourceBaseHeadSha, sourceHeadSha, "--"],
    repoPath,
    timeoutMs,
  );
  const fields = result.stdout.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const changes = new Map<string, ArtifactFileManifestEntry["status"]>();
  for (let index = 0; index < fields.length; ) {
    const rawStatus = fields[index++];
    const code = rawStatus?.[0];
    if (!code) break;
    if (code === "R") {
      index += 1;
      const destination = fields[index++];
      if (!destination) throw new SymphonyError("workspace_error", "Unable to parse accepted-artifact rename");
      changes.set(destination, "renamed");
      continue;
    }
    const filePath = fields[index++];
    if (!filePath) throw new SymphonyError("workspace_error", "Unable to parse accepted-artifact source diff");
    if (code === "A") changes.set(filePath, "added");
    else if (code === "M" || code === "T") changes.set(filePath, "modified");
    else if (code === "D") changes.set(filePath, "deleted");
    else {
      throw new SymphonyError(
        "workspace_error",
        `Unsupported accepted-artifact source change status ${rawStatus}`,
      );
    }
  }
  return changes;
}

async function verifyManifestObjects(
  repoPath: string,
  commitSha: string,
  manifest: ArtifactFileManifestEntry[],
  timeoutMs: number,
  label: string,
): Promise<void> {
  validatedManifestByPath(manifest);
  for (const entry of manifest) {
    const actualObject = await treeObjectEntry(repoPath, commitSha, entry.path, timeoutMs);
    if (entry.status === "deleted") {
      if (actualObject !== null) {
        throw new SymphonyError(
          "workspace_error",
          `Accepted-artifact deleted path ${entry.path} is present in ${label}`,
        );
      }
      continue;
    }
    if (
      actualObject?.objectType !== "blob" ||
      actualObject.objectSha.toLowerCase() !== entry.blobSha?.toLowerCase()
    ) {
      throw new SymphonyError(
        "workspace_error",
        `Accepted-artifact blob for ${entry.path} did not survive in ${label}`,
      );
    }
    if (entry.mode !== undefined && actualObject.mode !== entry.mode) {
      throw new SymphonyError(
        "workspace_error",
        `Accepted-artifact Git mode for ${entry.path} did not survive in ${label}`,
      );
    }
  }
}

interface ArtifactTreeObjectEntry {
  mode: string;
  objectType: string;
  objectSha: string;
}

async function treeObjectEntry(
  repoPath: string,
  commitSha: string,
  filePath: string,
  timeoutMs: number,
): Promise<ArtifactTreeObjectEntry | null> {
  const result = await runGit(
    ["ls-tree", "-z", commitSha, "--", `:(literal)${filePath}`],
    repoPath,
    timeoutMs,
  );
  if (result.stdout.length === 0) return null;
  const tab = result.stdout.indexOf("\t");
  const match =
    tab < 0
      ? null
      : /^([0-7]{6}) (blob|tree|commit) ([0-9a-f]{40,64})$/i.exec(
          result.stdout.slice(0, tab),
        );
  if (match === null || result.stdout.slice(tab + 1).replace(/\0$/, "") !== filePath) {
    throw new SymphonyError(
      "workspace_error",
      `Unable to inspect accepted-artifact tree object for ${filePath}`,
    );
  }
  return {
    mode: match[1]!,
    objectType: match[2]!.toLowerCase(),
    objectSha: match[3]!,
  };
}

async function conflictedFiles(workspacePath: string, timeoutMs: number): Promise<string[]> {
  const result = await runGit(
    ["diff", "--name-only", "--diff-filter=U", "-z"],
    workspacePath,
    timeoutMs,
  );
  const files = result.stdout.split("\0").filter((filePath) => filePath.length > 0);
  for (const filePath of files) assertRepositoryRelativePath(filePath);
  return files;
}

async function seedConflictResolutionPaths(
  workspacePath: string,
  timeoutMs: number,
): Promise<string[]> {
  const unstaged = await runGit(
    ["diff", "--name-only", "-z", "--"],
    workspacePath,
    timeoutMs,
  );
  const untracked = await runGit(
    ["ls-files", "--others", "--exclude-standard", "-z", "--"],
    workspacePath,
    timeoutMs,
  );
  const paths = new Set(
    [...unstaged.stdout.split("\0"), ...untracked.stdout.split("\0")].filter(
      (filePath) => filePath.length > 0,
    ),
  );
  for (const filePath of paths) assertRepositoryRelativePath(filePath);
  return [...paths].sort();
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
      if (await branchLockOwnerIsDead(lockPath, timeoutMs)) {
        await fs.rm(lockPath, { force: true });
        continue;
      }
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

async function branchLockOwnerIsDead(lockPath: string, timeoutMs: number): Promise<boolean> {
  let raw: string;
  let stats;
  try {
    [raw, stats] = await Promise.all([
      fs.readFile(lockPath, "utf8"),
      fs.stat(lockPath),
    ]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const ownerPid = Number.parseInt(raw.split("\n", 1)[0] ?? "", 10);
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) {
    return Date.now() - stats.mtimeMs > timeoutMs;
  }
  try {
    process.kill(ownerPid, 0);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return true;
    if (code === "EPERM") return false;
    throw error;
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
    child.on("close", (code) => {
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

import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Liquid } from "liquidjs";
import type { HookConfig, WorkspaceConfig } from "../config/Config.js";
import { SymphonyError, errorMessage } from "../errors.js";
import type {
  AcceptedArtifactWorkspaceSeed,
  Issue,
  Workspace,
  WorkspaceSeedBinding,
} from "../types.js";
import type { Logger } from "../logging/StructuredLogger.js";
import {
  AcceptedArtifactSeedConflictError,
  createGitPlanningCheckout,
  createGitWorktree,
  completeGitWorktreeCreation,
  finalizeGitWorktreeSeedConflict,
  removeGitWorktree,
  rollbackGitWorktreeCreation,
  verifyGitWorktreeSeedBinding,
} from "./GitWorktreeManager.js";
import { FileRunTranscriptStore, type WorkspaceRecord } from "../persistence/RunTranscriptStore.js";

export interface WorkspaceManagerOptions {
  workspace: WorkspaceConfig;
  hooks: HookConfig;
  logger: Logger;
  planningWorkspaceMode?: "none" | "readonly_checkout" | "writable_checkout";
}

export interface WorkspaceMetadata {
  workspaceKey: string;
  issueId: string | null;
  issueIdentifier: string;
  path: string;
  createdAt: string;
  updatedAt: string;
  sourceKind: string;
  repoPath?: string;
  baseRef?: string;
  gitBranchName?: string;
  seed?: WorkspaceSeedBinding;
}

export interface CreateIssueWorkspaceOptions {
  seed?: AcceptedArtifactWorkspaceSeed | null;
}

export interface IssueWorkspaceRecord {
  workspaceKey: string;
  issueId: string | null;
  issueIdentifier: string;
  path: string;
  metadata: WorkspaceRecord | null;
}

export class WorkspaceManager {
  private readonly branchRenderer = new Liquid({ strictVariables: true });
  private readonly store: FileRunTranscriptStore;

  constructor(private readonly options: WorkspaceManagerOptions) {
    this.store = new FileRunTranscriptStore(options.workspace.stateDir);
  }

  async createForIssue(
    issueInput: WorkspaceIssueInput,
    options: CreateIssueWorkspaceOptions = {},
  ): Promise<Workspace> {
    const issue = normalizeIssueInput(issueInput);
    const issueIdentifier = issue.identifier;
    const workspaceKey = sanitizeWorkspaceKey(issueIdentifier);
    const workspacePath = path.resolve(this.options.workspace.root, workspaceKey);
    assertPathInsideRoot(workspacePath, this.options.workspace.root);

    await fs.mkdir(this.options.workspace.root, { recursive: true });
    await fs.mkdir(this.options.workspace.stateDir, { recursive: true });
    await assertWorkspaceParentInsideRoot(workspacePath, this.options.workspace.root);
    const createdNow = !(await pathExists(workspacePath));
    if (this.options.workspace.source.kind === "git_worktree") {
      const branchName = await this.resolveBranchName(issue);
      const existing = await this.store.getWorkspace(workspaceKey);
      const recoverSeedCreation =
        !createdNow && existing === null && options.seed != null;
      if (createdNow || recoverSeedCreation) {
        const result = await createGitWorktree({
          source: this.options.workspace.source,
          stateDir: this.options.workspace.stateDir,
          workspacePath,
          branchName,
          ...(options.seed == null ? {} : { seed: options.seed }),
          timeoutMs: this.options.hooks.timeoutMs,
          logger: this.options.logger,
        });
        await assertRealPathInsideRoot(workspacePath, this.options.workspace.root);
        try {
          await this.writeMetadata({
            workspaceKey,
            issueId: issue.id,
            issueIdentifier,
            path: workspacePath,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            sourceKind: this.options.workspace.source.kind,
            repoPath: result.repoPath,
            baseRef: result.baseRef,
            gitBranchName: result.branchName,
            ...(result.seed === undefined ? {} : { seed: result.seed }),
          });
        } catch (error) {
          if (options.seed != null) {
            try {
              await rollbackGitWorktreeCreation({
                stateDir: this.options.workspace.stateDir,
                repoPath: result.repoPath,
                workspacePath,
                branchName,
                seed: options.seed,
                timeoutMs: this.options.hooks.timeoutMs,
              });
            } catch (cleanupError) {
              this.options.logger.error("seeded worktree rollback failed", {
                workspace_path: workspacePath,
                branch_name: branchName,
                error: errorMessage(cleanupError),
              });
            }
          }
          throw error;
        }
        if (options.seed != null) {
          await completeGitWorktreeCreation({
            stateDir: this.options.workspace.stateDir,
            repoPath: result.repoPath,
            workspacePath,
            branchName,
            seed: options.seed,
            timeoutMs: this.options.hooks.timeoutMs,
          });
        }
        if ((result.seed?.conflictedFiles.length ?? 0) === 0) {
          await this.runHook("after_create", this.options.hooks.afterCreate, workspacePath, true);
        }
      } else {
        await this.assertExistingWorktree(
          workspaceKey,
          workspacePath,
          options.seed ?? null,
        );
      }
    } else if (options.seed != null) {
      throw new SymphonyError(
        "workspace_error",
        "Accepted-artifact workspace seeds require workspace.source.kind git_worktree",
      );
    } else {
      await ensureDirectory(workspacePath);
      await assertRealPathInsideRoot(workspacePath, this.options.workspace.root);

      if (createdNow) {
        await this.bootstrapWorkspace(workspacePath);
        await assertRealPathInsideRoot(workspacePath, this.options.workspace.root);
        await this.runHook("after_create", this.options.hooks.afterCreate, workspacePath, true);
      }
    }

    await assertRealPathInsideRoot(workspacePath, this.options.workspace.root);
    const existing = await this.store.getWorkspace(workspaceKey);
    const metadata: WorkspaceMetadata = {
      workspaceKey,
      issueId: issue.id,
      issueIdentifier,
      path: workspacePath,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sourceKind: this.options.workspace.source.kind,
      ...(existing?.repoPath === undefined ? {} : { repoPath: existing.repoPath }),
      ...(existing?.baseRef === undefined ? {} : { baseRef: existing.baseRef }),
      ...(existing?.gitBranchName === undefined ? {} : { gitBranchName: existing.gitBranchName }),
      ...(existing?.seed === undefined ? {} : { seed: existing.seed }),
    };
    await this.writeMetadata(metadata);

    return {
      path: workspacePath,
      workspaceKey,
      createdNow,
      issueIdentifier,
      sourceKind: metadata.sourceKind,
      ...(issue.id === null ? {} : { issueId: issue.id }),
      ...(metadata.gitBranchName === undefined ? {} : { gitBranchName: metadata.gitBranchName }),
      ...(metadata.repoPath === undefined ? {} : { repoPath: metadata.repoPath }),
      ...(metadata.baseRef === undefined ? {} : { baseRef: metadata.baseRef }),
      ...(metadata.seed === undefined ? {} : { seed: metadata.seed }),
    };
  }

  async resolveBranchNameForIssue(issueInput: WorkspaceIssueInput): Promise<string> {
    return this.resolveBranchName(normalizeIssueInput(issueInput));
  }

  async finalizeAcceptedArtifactSeedConflict(
    issueInput: WorkspaceIssueInput,
  ): Promise<WorkspaceSeedBinding> {
    const issue = normalizeIssueInput(issueInput);
    const workspaceKey = sanitizeWorkspaceKey(issue.identifier);
    const workspacePath = path.resolve(this.options.workspace.root, workspaceKey);
    assertPathInsideRoot(workspacePath, this.options.workspace.root);
    await assertRealPathInsideRoot(workspacePath, this.options.workspace.root);
    const metadata = await this.store.getWorkspace(workspaceKey);
    if (
      metadata?.sourceKind !== "git_worktree" ||
      !metadata.repoPath ||
      !metadata.gitBranchName ||
      !metadata.seed
    ) {
      throw new SymphonyError(
        "workspace_error",
        `Workspace has no managed accepted-artifact seed conflict: ${workspacePath}`,
      );
    }
    const seed = await finalizeGitWorktreeSeedConflict(
      workspacePath,
      metadata.seed,
      this.options.hooks.timeoutMs,
    );
    if (seed.conflictedFiles.length > 0 || seed.preparedHeadSha === null) {
      await this.writeMetadata({
        ...metadata,
        seed,
        updatedAt: new Date().toISOString(),
      });
      throw AcceptedArtifactSeedConflictError.fromBinding(seed);
    }
    await this.runHook("after_create", this.options.hooks.afterCreate, workspacePath, true);
    await this.writeMetadata({
      ...metadata,
      seed,
      updatedAt: new Date().toISOString(),
    });
    return seed;
  }

  async createForPlanning(issueInput: WorkspaceIssueInput): Promise<Workspace> {
    const issue = normalizeIssueInput(issueInput);
    const issueIdentifier = issue.identifier;
    const workspaceKey = `${sanitizeWorkspaceKey(issueIdentifier)}-planning`;
    const workspacePath = path.resolve(this.options.workspace.root, workspaceKey);
    assertPathInsideRoot(workspacePath, this.options.workspace.root);

    await fs.mkdir(this.options.workspace.root, { recursive: true });
    await fs.mkdir(this.options.workspace.stateDir, { recursive: true });
    await assertWorkspaceParentInsideRoot(workspacePath, this.options.workspace.root);
    const source = this.options.workspace.source;
    const createdNow = !(await pathExists(workspacePath));
    const existing = await this.store.getWorkspace(workspaceKey);
    let repoPath = existing?.repoPath;
    let baseRef = existing?.baseRef;
    let sourceKind: string = source.kind;
    const planningMode = this.options.planningWorkspaceMode ?? "none";
    assertSupportedPlanningWorkspaceMode(planningMode, source.kind);

    if (planningMode === "none") {
      if (!createdNow) {
        await this.removePlanningWorkspace(workspaceKey, workspacePath, existing);
      }
      await ensureDirectory(workspacePath);
      await assertRealPathInsideRoot(workspacePath, this.options.workspace.root);
      await fs.writeFile(
        path.join(workspacePath, ".symphony-planning.json"),
        `${JSON.stringify(
          {
            issueId: issue.id,
            issueIdentifier,
            mode: "none",
            createdAt: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      repoPath = undefined;
      baseRef = undefined;
      sourceKind = "planning_none";
    } else if (source.kind === "git_worktree") {
      if (!createdNow) {
        await this.removePlanningWorkspace(workspaceKey, workspacePath, existing);
      }
      const result = await createGitPlanningCheckout({
        source,
        stateDir: this.options.workspace.stateDir,
        workspacePath,
        timeoutMs: this.options.hooks.timeoutMs,
        logger: this.options.logger,
      });
      repoPath = result.repoPath;
      baseRef = result.baseRef;
      sourceKind = planningMode === "readonly_checkout" ? "planning_readonly" : "planning_writable";
      await assertRealPathInsideRoot(workspacePath, this.options.workspace.root);
      await fs.writeFile(
        path.join(
          workspacePath,
          planningMode === "readonly_checkout" ? ".symphony-planning-readonly.json" : ".symphony-planning-writable.json",
        ),
        `${JSON.stringify(
          {
            issueId: issue.id,
            issueIdentifier,
            mode: planningMode,
            createdAt: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      if (planningMode === "readonly_checkout") {
        await applyPlanningReadOnly(workspacePath, this.options.logger);
      }
    }

    const metadata: WorkspaceMetadata = {
      workspaceKey,
      issueId: issue.id,
      issueIdentifier,
      path: workspacePath,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sourceKind,
      ...(repoPath === undefined ? {} : { repoPath }),
      ...(baseRef === undefined ? {} : { baseRef }),
    };
    await this.writeMetadata(metadata);

    return {
      path: workspacePath,
      workspaceKey,
      createdNow,
      issueIdentifier,
      sourceKind: metadata.sourceKind,
      ...(issue.id === null ? {} : { issueId: issue.id }),
      ...(metadata.repoPath === undefined ? {} : { repoPath: metadata.repoPath }),
      ...(metadata.baseRef === undefined ? {} : { baseRef: metadata.baseRef }),
    };
  }

  async removeForPlanning(issueInput: WorkspaceIssueInput): Promise<void> {
    const issue = normalizeIssueInput(issueInput);
    const issueIdentifier = issue.identifier;
    const workspaceKey = `${sanitizeWorkspaceKey(issueIdentifier)}-planning`;
    const workspacePath = path.resolve(this.options.workspace.root, workspaceKey);
    assertPathInsideRoot(workspacePath, this.options.workspace.root);
    const metadata = await this.store.getWorkspace(workspaceKey);
    await this.removePlanningWorkspace(workspaceKey, workspacePath, metadata);
  }

  async beforeRun(workspacePath: string): Promise<void> {
    assertPathInsideRoot(workspacePath, this.options.workspace.root);
    await assertRealPathInsideRoot(workspacePath, this.options.workspace.root);
    await this.runHook("before_run", this.options.hooks.beforeRun, workspacePath, true);
  }

  async afterRun(workspacePath: string): Promise<void> {
    assertPathInsideRoot(workspacePath, this.options.workspace.root);
    await assertRealPathInsideRoot(workspacePath, this.options.workspace.root);
    await this.runHook("after_run", this.options.hooks.afterRun, workspacePath, false);
  }

  async removeForIssue(issueInput: WorkspaceIssueInput): Promise<boolean> {
    const issue = normalizeIssueInput(issueInput);
    const issueIdentifier = issue.identifier;
    const workspaceKey = sanitizeWorkspaceKey(issueIdentifier);
    const workspacePath = path.resolve(this.options.workspace.root, workspaceKey);
    assertPathInsideRoot(workspacePath, this.options.workspace.root);

    if (!(await pathExists(workspacePath))) {
      await this.store.deleteWorkspace(workspaceKey);
      return false;
    }
    await assertRealPathInsideRoot(workspacePath, this.options.workspace.root);
    await this.runHook("before_remove", this.options.hooks.beforeRemove, workspacePath, false);
    const metadata = await this.store.getWorkspace(workspaceKey);
    if (metadata?.sourceKind === "git_worktree" && metadata.repoPath) {
      if (metadata.seed && metadata.gitBranchName) {
        await completeGitWorktreeCreation({
          stateDir: this.options.workspace.stateDir,
          repoPath: metadata.repoPath,
          workspacePath,
          branchName: metadata.gitBranchName,
          seed: metadata.seed,
          timeoutMs: this.options.hooks.timeoutMs,
        });
      }
      await removeGitWorktree({
        repoPath: metadata.repoPath,
        workspacePath,
        cleanup: this.options.workspace.source.cleanup ?? "refuse_dirty",
        timeoutMs: this.options.hooks.timeoutMs,
        logger: this.options.logger,
      });
    } else if (this.options.workspace.source.kind === "git_worktree") {
      if ((this.options.workspace.source.cleanup ?? "refuse_dirty") === "refuse_dirty") {
        throw new SymphonyError("workspace_error", `Refusing to remove worktree without metadata: ${workspacePath}`);
      }
      this.options.logger.warn("worktree metadata missing; removing workspace directory directly", {
        issue_identifier: issueIdentifier,
        workspace_path: workspacePath,
      });
      await fs.rm(workspacePath, { recursive: true, force: true });
    } else {
      await fs.rm(workspacePath, { recursive: true, force: true });
    }
    await this.store.deleteWorkspace(workspaceKey);
    this.options.logger.info("workspace removed", {
      issue_identifier: issueIdentifier,
      workspace_path: workspacePath,
    });
    return true;
  }

  private async removePlanningWorkspace(
    workspaceKey: string,
    workspacePath: string,
    metadata: WorkspaceRecord | null,
  ): Promise<void> {
    if (!(await pathExists(workspacePath))) {
      await this.store.deleteWorkspace(workspaceKey);
      return;
    }
    await assertRealPathInsideRoot(workspacePath, this.options.workspace.root);
    await applyPlanningWritable(workspacePath, this.options.logger);
    if (metadata?.sourceKind === "planning_none") {
      await fs.rm(workspacePath, { recursive: true, force: true });
    } else if (
      (metadata?.sourceKind === "planning_readonly" || metadata?.sourceKind === "planning_writable") &&
      metadata.repoPath &&
      this.options.workspace.source.kind === "git_worktree"
    ) {
      await removeGitWorktree({
        repoPath: metadata.repoPath,
        workspacePath,
        cleanup: "force",
        timeoutMs: this.options.hooks.timeoutMs,
        logger: this.options.logger,
      });
    } else if (this.options.workspace.source.kind === "git_worktree") {
      await fs.rm(workspacePath, { recursive: true, force: true });
    } else {
      await applyPlanningReadOnly(workspacePath, this.options.logger);
      return;
    }
    await this.store.deleteWorkspace(workspaceKey);
  }

  getPathForIssue(issueIdentifier: string): string {
    const workspacePath = path.resolve(this.options.workspace.root, sanitizeWorkspaceKey(issueIdentifier));
    assertPathInsideRoot(workspacePath, this.options.workspace.root);
    return workspacePath;
  }

  async getWorkspaceRecord(workspaceKeyOrIssue: string): Promise<WorkspaceRecord | null> {
    return this.store.findWorkspace(workspaceKeyOrIssue);
  }

  async listIssueWorkspaces(): Promise<IssueWorkspaceRecord[]> {
    await fs.mkdir(this.options.workspace.root, { recursive: true });
    const root = path.resolve(this.options.workspace.root);
    const stateDir = path.resolve(this.options.workspace.stateDir);
    const metadata = await this.store.listWorkspaces();
    const metadataByKey = new Map(metadata.map((record) => [record.workspaceKey, record]));
    const entries = await fs.readdir(root, { withFileTypes: true });
    const records: IssueWorkspaceRecord[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const workspacePath = path.resolve(root, entry.name);
      if (workspacePath === stateDir) continue;
      if (entry.name === path.basename(stateDir)) continue;
      if (entry.name.endsWith("-planning")) continue;
      assertPathInsideRoot(workspacePath, root);

      const record = metadataByKey.get(entry.name) ?? null;
      records.push({
        workspaceKey: entry.name,
        issueId: record?.issueId ?? null,
        issueIdentifier: record?.issueIdentifier ?? entry.name,
        path: workspacePath,
        metadata: record,
      });
    }

    return records.sort((left, right) =>
      left.workspaceKey.localeCompare(right.workspaceKey),
    );
  }

  isInsideRoot(workspacePath: string): boolean {
    try {
      assertPathInsideRoot(workspacePath, this.options.workspace.root);
      return true;
    } catch {
      return false;
    }
  }

  private async bootstrapWorkspace(workspacePath: string): Promise<void> {
    const source = this.options.workspace.source;
    if (source.kind === "none") return;

    if (source.kind === "copy") {
      if (!source.path) {
        throw new SymphonyError("workspace_error", "workspace.source.path is required for copy bootstrap");
      }
      await fs.cp(source.path, workspacePath, {
        recursive: true,
        force: false,
        errorOnExist: false,
      });
      return;
    }

    if (source.kind === "git") {
      if (!source.repository) {
        throw new SymphonyError("workspace_error", "workspace.source.repository is required for git bootstrap");
      }
      const args = ["clone", source.repository, workspacePath];
      if (source.ref) args.splice(1, 0, "--branch", source.ref);
      await runCommand("git", args, path.dirname(workspacePath), this.options.hooks.timeoutMs);
    }
  }

  private async runHook(
    hookName: string,
    script: string | null,
    workspacePath: string,
    fatal: boolean,
  ): Promise<void> {
    if (!script) return;
    this.options.logger.info("hook started", { hook: hookName, workspace_path: workspacePath });
    try {
      await runShellScript(script, workspacePath, this.options.hooks.timeoutMs);
      this.options.logger.info("hook completed", { hook: hookName, workspace_path: workspacePath });
    } catch (error) {
      this.options.logger.warn("hook failed", {
        hook: hookName,
        workspace_path: workspacePath,
        error: errorMessage(error),
      });
      if (fatal) {
        throw new SymphonyError("hook_error", `${hookName} hook failed: ${errorMessage(error)}`, error);
      }
    }
  }

  private async writeMetadata(metadata: WorkspaceMetadata): Promise<void> {
    await this.store.upsertWorkspace(metadata);
  }

  private async resolveBranchName(issue: WorkspaceIssue): Promise<string> {
    const source = this.options.workspace.source;
    const template = source.branchTemplate ?? "symphony/{{ issue.identifier }}";
    const branchName =
      issue.branchName ??
      (await this.branchRenderer.parseAndRender(template, {
        issue: {
          id: issue.id,
          identifier: issue.identifier,
          branchName: issue.branchName,
        },
      }));
    const trimmed = String(branchName).trim();
    if (trimmed.length === 0) throw new SymphonyError("workspace_error", "Resolved git branch name is empty");
    return trimmed;
  }

  private async assertExistingWorktree(
    workspaceKey: string,
    workspacePath: string,
    requestedSeed: AcceptedArtifactWorkspaceSeed | null,
  ): Promise<void> {
    await ensureDirectory(workspacePath);
    await assertRealPathInsideRoot(workspacePath, this.options.workspace.root);
    const metadata = await this.store.getWorkspace(workspaceKey);
    if (metadata?.sourceKind !== "git_worktree" || !metadata.repoPath || !metadata.gitBranchName) {
      throw new SymphonyError("workspace_error", `Existing workspace is not a managed git worktree: ${workspacePath}`);
    }
    if (!(await pathExists(path.join(workspacePath, ".git")))) {
      throw new SymphonyError("workspace_error", `Existing workspace is missing git worktree metadata: ${workspacePath}`);
    }
    assertMatchingWorkspaceSeed(metadata.seed, requestedSeed, workspacePath);
    if (metadata.seed !== undefined) {
      const seed = await verifyGitWorktreeSeedBinding(
        workspacePath,
        metadata.seed,
        this.options.hooks.timeoutMs,
      );
      if (!sameWorkspaceSeedBinding(seed, metadata.seed)) {
        await this.writeMetadata({
          ...metadata,
          seed,
          updatedAt: new Date().toISOString(),
        });
      }
      await completeGitWorktreeCreation({
        stateDir: this.options.workspace.stateDir,
        repoPath: metadata.repoPath,
        workspacePath,
        branchName: metadata.gitBranchName,
        seed,
        timeoutMs: this.options.hooks.timeoutMs,
      });
    }
  }
}

function assertMatchingWorkspaceSeed(
  existing: WorkspaceSeedBinding | undefined,
  requested: AcceptedArtifactWorkspaceSeed | null,
  workspacePath: string,
): void {
  if (requested === null) return;
  if (existing === undefined) {
    throw new SymphonyError(
      "workspace_error",
      `Existing workspace has no persisted accepted-artifact seed binding: ${workspacePath}`,
    );
  }
  const fields: Array<keyof AcceptedArtifactWorkspaceSeed> = [
    "version",
    "kind",
    "artifactId",
    "sourceIssueId",
    "sourceIssueIdentifier",
    "repositoryFingerprint",
    "sourceBranch",
    "sourceHeadSha",
    "sourceBaseHeadSha",
    "configuredBaseRef",
  ];
  const mismatch = fields.find((field) => existing[field] !== requested[field]);
  if (mismatch !== undefined || !sameArtifactManifest(existing.fileManifest, requested.fileManifest)) {
    throw new SymphonyError(
      "workspace_error",
      `Existing workspace accepted-artifact seed does not match requested seed: ${workspacePath}`,
    );
  }
}

function sameArtifactManifest(
  left: AcceptedArtifactWorkspaceSeed["fileManifest"],
  right: AcceptedArtifactWorkspaceSeed["fileManifest"],
): boolean {
  if (left.length !== right.length) return false;
  const normalize = (entries: AcceptedArtifactWorkspaceSeed["fileManifest"]) =>
    entries
      .map((entry) => `${entry.path}\0${entry.status}\0${entry.blobSha ?? ""}`)
      .sort();
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return normalizedLeft.every((entry, index) => entry === normalizedRight[index]);
}

function sameWorkspaceSeedBinding(
  left: WorkspaceSeedBinding,
  right: WorkspaceSeedBinding,
): boolean {
  return (
    left.preparedHeadSha === right.preparedHeadSha &&
    left.preparedBaseHeadSha === right.preparedBaseHeadSha &&
    left.targetBranch === right.targetBranch &&
    left.conflictedFiles.length === right.conflictedFiles.length &&
    left.conflictedFiles.every((filePath, index) => filePath === right.conflictedFiles[index]) &&
    (left.absorbedPaths ?? []).length === (right.absorbedPaths ?? []).length &&
    (left.absorbedPaths ?? []).every(
      (filePath, index) => filePath === (right.absorbedPaths ?? [])[index],
    )
  );
}

export interface WorkspaceIssue {
  id: string | null;
  identifier: string;
  branchName: string | null;
}

export type WorkspaceIssueInput = string | Pick<Issue, "id" | "identifier" | "branchName">;

function normalizeIssueInput(input: WorkspaceIssueInput): WorkspaceIssue {
  if (typeof input === "string") return { id: null, identifier: input, branchName: null };
  return { id: input.id, identifier: input.identifier, branchName: input.branchName };
}

export function sanitizeWorkspaceKey(identifier: string): string {
  const sanitized = identifier.replace(/[^A-Za-z0-9._-]/g, "_");
  return sanitized.length > 0 ? sanitized : "issue";
}

export function assertPathInsideRoot(workspacePath: string, workspaceRoot: string): void {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(workspacePath);
  const relative = path.relative(root, target);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new SymphonyError("workspace_error", `Workspace path escapes workspace root: ${target}`);
}

export async function assertRealPathInsideRoot(workspacePath: string, workspaceRoot: string): Promise<void> {
  assertPathInsideRoot(workspacePath, workspaceRoot);
  const root = await fs.realpath(workspaceRoot);
  const target = await fs.realpath(workspacePath);
  assertPathInsideRoot(target, root);
}

async function assertWorkspaceParentInsideRoot(workspacePath: string, workspaceRoot: string): Promise<void> {
  assertPathInsideRoot(workspacePath, workspaceRoot);
  const root = await fs.realpath(workspaceRoot);
  const parent = await fs.realpath(path.dirname(workspacePath));
  assertPathInsideRoot(parent, root);
}

async function ensureDirectory(directoryPath: string): Promise<void> {
  try {
    const stats = await fs.stat(directoryPath);
    if (!stats.isDirectory()) {
      throw new SymphonyError("workspace_error", `Workspace path exists but is not a directory: ${directoryPath}`);
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await fs.mkdir(directoryPath, { recursive: true });
      return;
    }
    throw error;
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function applyPlanningReadOnly(workspacePath: string, logger: Logger): Promise<void> {
  await applyModeRecursive(workspacePath, { directoryMode: 0o555, fileMode: 0o444 }, logger, "read_only");
}

function assertSupportedPlanningWorkspaceMode(
  mode: "none" | "readonly_checkout" | "writable_checkout",
  sourceKind: WorkspaceConfig["source"]["kind"],
): void {
  if (mode === "none") return;
  if (sourceKind !== "git_worktree") {
    throw new SymphonyError(
      "config_validation_error",
      `issue_breakdown.workspace_mode ${mode} requires workspace.source.kind git_worktree`,
    );
  }
  if (mode !== "readonly_checkout") return;
  if (process.platform === "win32") {
    throw new SymphonyError(
      "config_validation_error",
      "issue_breakdown.workspace_mode readonly_checkout is not supported on Windows; use workspace_mode none",
    );
  }
}

async function applyPlanningWritable(workspacePath: string, logger: Logger): Promise<void> {
  await applyModeRecursive(workspacePath, { directoryMode: 0o755, fileMode: 0o644 }, logger, "writable");
}

async function applyModeRecursive(
  targetPath: string,
  mode: { directoryMode: number; fileMode: number },
  logger: Logger,
  operation: "read_only" | "writable",
): Promise<void> {
  let stats;
  try {
    stats = await fs.lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  if (stats.isDirectory()) {
    const entries = await fs.readdir(targetPath);
    await Promise.all(entries.map((entry) => applyModeRecursive(path.join(targetPath, entry), mode, logger, operation)));
    await chmodBestEffort(targetPath, mode.directoryMode, logger, operation);
    return;
  }
  await chmodBestEffort(targetPath, mode.fileMode, logger, operation);
}

async function chmodBestEffort(
  targetPath: string,
  mode: number,
  logger: Logger,
  operation: "read_only" | "writable",
): Promise<void> {
  try {
    await fs.chmod(targetPath, mode);
  } catch (error) {
    logger.warn("planning workspace chmod failed", {
      workspace_path: targetPath,
      operation,
      error: errorMessage(error),
    });
  }
}

function runShellScript(script: string, cwd: string, timeoutMs: number): Promise<void> {
  if (process.platform === "win32") {
    return runCommand("cmd.exe", ["/d", "/s", "/c", script], cwd, timeoutMs);
  }
  return runCommand("sh", ["-lc", script], cwd, timeoutMs);
}

function runCommand(command: string, args: string[], cwd: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let settled = false;
    let stderr = "";
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8").slice(0, 8_000);
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
        resolve();
      } else {
        reject(new Error(`command exited with ${code}: ${stderr}`));
      }
    });
  });
}

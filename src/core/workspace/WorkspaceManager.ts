import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Liquid } from "liquidjs";
import {
  LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
  projectContextResolutionFromIssue,
  type ProjectContextIssueLike,
  type ProjectContextResolution,
} from "../config/ProjectContexts.js";
import type { HookConfig, WorkspaceConfig } from "../config/Config.js";
import { SymphonyError, errorMessage } from "../errors.js";
import type { Issue, Workspace } from "../types.js";
import type { Logger } from "../logging/StructuredLogger.js";
import { createGitPlanningCheckout, createGitWorktree, moveGitWorktree, removeGitWorktree } from "./GitWorktreeManager.js";
import { FileRunTranscriptStore, type WorkspaceRecord } from "../persistence/RunTranscriptStore.js";

export interface WorkspaceManagerOptions {
  workspace: WorkspaceConfig;
  hooks: HookConfig;
  logger: Logger;
  planningWorkspaceMode?: "none" | "readonly_checkout";
}

export interface WorkspaceMetadata {
  workspaceKey: string;
  issueId: string | null;
  issueIdentifier: string;
  projectContext?: ProjectContextResolution;
  path: string;
  createdAt: string;
  updatedAt: string;
  sourceKind: string;
  repoPath?: string;
  baseRef?: string;
  gitBranchName?: string;
}

const CONTEXTUAL_WORKSPACE_KEY_PREFIX = "ctx";
const CONTEXTUAL_WORKSPACE_KEY_NAMESPACE = `${CONTEXTUAL_WORKSPACE_KEY_PREFIX}__`;
const LEGACY_RESERVED_WORKSPACE_KEY_ESCAPE_PREFIX = "~";

export class WorkspaceManager {
  private readonly branchRenderer = new Liquid({ strictVariables: true });
  private readonly store: FileRunTranscriptStore;

  constructor(private readonly options: WorkspaceManagerOptions) {
    this.store = new FileRunTranscriptStore(options.workspace.stateDir);
  }

  async createForIssue(issueInput: WorkspaceIssueInput): Promise<Workspace> {
    const issue = normalizeIssueInput(issueInput);
    const issueIdentifier = issue.identifier;
    const workspaceKey = workspaceKeyForIssue(issue);
    const workspacePath = path.resolve(this.options.workspace.root, workspaceKey);
    assertPathInsideRoot(workspacePath, this.options.workspace.root);

    await fs.mkdir(this.options.workspace.root, { recursive: true });
    await fs.mkdir(this.options.workspace.stateDir, { recursive: true });
    await assertWorkspaceParentInsideRoot(workspacePath, this.options.workspace.root);
    await this.prepareWorkspaceTarget(issue, "implementation");
    const createdNow = !(await pathExists(workspacePath));
    if (createdNow && this.options.workspace.source.kind === "git_worktree") {
      const branchName = await this.resolveBranchName(issue);
      const result = await createGitWorktree({
        source: this.options.workspace.source,
        stateDir: this.options.workspace.stateDir,
        workspacePath,
        branchName,
        timeoutMs: this.options.hooks.timeoutMs,
        logger: this.options.logger,
      });
      await assertRealPathInsideRoot(workspacePath, this.options.workspace.root);
      await this.writeMetadata({
        workspaceKey,
        issueId: issue.id,
        issueIdentifier,
        ...(issue.projectContext === undefined ? {} : { projectContext: issue.projectContext }),
        path: workspacePath,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sourceKind: this.options.workspace.source.kind,
        repoPath: result.repoPath,
        baseRef: result.baseRef,
        gitBranchName: result.branchName,
      });
      await this.runHook("after_create", this.options.hooks.afterCreate, workspacePath, true);
    } else if (!createdNow && this.options.workspace.source.kind === "git_worktree") {
      await this.assertExistingWorktree(workspaceKey, workspacePath);
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
      ...(issue.projectContext === undefined ? {} : { projectContext: issue.projectContext }),
      path: workspacePath,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sourceKind: this.options.workspace.source.kind,
      ...(existing?.repoPath === undefined ? {} : { repoPath: existing.repoPath }),
      ...(existing?.baseRef === undefined ? {} : { baseRef: existing.baseRef }),
      ...(existing?.gitBranchName === undefined ? {} : { gitBranchName: existing.gitBranchName }),
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
    };
  }

  async createForPlanning(issueInput: WorkspaceIssueInput): Promise<Workspace> {
    const issue = normalizeIssueInput(issueInput);
    const issueIdentifier = issue.identifier;
    const workspaceKey = workspaceKeyForPlanning(issue);
    const workspacePath = path.resolve(this.options.workspace.root, workspaceKey);
    assertPathInsideRoot(workspacePath, this.options.workspace.root);

    await fs.mkdir(this.options.workspace.root, { recursive: true });
    await fs.mkdir(this.options.workspace.stateDir, { recursive: true });
    await assertWorkspaceParentInsideRoot(workspacePath, this.options.workspace.root);
    await this.prepareWorkspaceTarget(issue, "planning");
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
      sourceKind = "planning_readonly";
      await assertRealPathInsideRoot(workspacePath, this.options.workspace.root);
      await fs.writeFile(
        path.join(workspacePath, ".symphony-planning-readonly.json"),
        `${JSON.stringify(
          {
            issueId: issue.id,
            issueIdentifier,
            mode: "readonly_checkout",
            createdAt: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await applyPlanningReadOnly(workspacePath, this.options.logger);
    }

    const metadata: WorkspaceMetadata = {
      workspaceKey,
      issueId: issue.id,
      issueIdentifier,
      ...(issue.projectContext === undefined ? {} : { projectContext: issue.projectContext }),
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
    const workspaceKey = workspaceKeyForPlanning(issue);
    const workspacePath = path.resolve(this.options.workspace.root, workspaceKey);
    assertPathInsideRoot(workspacePath, this.options.workspace.root);
    await this.prepareWorkspaceTarget(issue, "planning");
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

  async removeForIssue(issueInput: WorkspaceIssueInput): Promise<void> {
    const issue = normalizeIssueInput(issueInput);
    const issueIdentifier = issue.identifier;
    const workspaceKey = workspaceKeyForIssue(issue);
    const workspacePath = path.resolve(this.options.workspace.root, workspaceKey);
    assertPathInsideRoot(workspacePath, this.options.workspace.root);
    await this.prepareWorkspaceTarget(issue, "implementation");

    if (!(await pathExists(workspacePath))) {
      await this.store.deleteWorkspace(workspaceKey);
      return;
    }
    await assertRealPathInsideRoot(workspacePath, this.options.workspace.root);
    await this.runHook("before_remove", this.options.hooks.beforeRemove, workspacePath, false);
    const metadata = await this.store.getWorkspace(workspaceKey);
    if (metadata?.sourceKind === "git_worktree" && metadata.repoPath) {
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
    } else if (metadata?.sourceKind === "planning_readonly" && metadata.repoPath && this.options.workspace.source.kind === "git_worktree") {
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

  getPathForIssue(issueInput: WorkspaceIssueInput): string {
    const issue = normalizeIssueInput(issueInput);
    const workspacePath = path.resolve(this.options.workspace.root, workspaceKeyForIssue(issue));
    assertPathInsideRoot(workspacePath, this.options.workspace.root);
    return workspacePath;
  }

  async getWorkspaceRecord(workspaceKey: string): Promise<WorkspaceRecord | null> {
    return this.store.getWorkspace(workspaceKey);
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

  private async prepareWorkspaceTarget(issue: WorkspaceIssue, purpose: WorkspacePurpose): Promise<void> {
    const migrationPlan = legacyWorkspaceMigrationPlanForIssue(issue, purpose, this.options.workspace.root);
    if (!migrationPlan) return;

    const metadata = await this.store.getWorkspace(migrationPlan.fromWorkspaceKey);
    const sourceExists = await pathExists(migrationPlan.fromWorkspacePath);
    if (!metadata) {
      if (migrationPlan.reason === "contextual_conflict" && sourceExists) {
        throw new SymphonyError(
          "workspace_error",
          `Existing reserved-prefix workspace lacks metadata and cannot be safely claimed: ${migrationPlan.fromWorkspacePath}`,
        );
      }
      return;
    }
    if (!isLegacyWorkspaceMigrationCandidate(metadata, migrationPlan)) return;
    if (!sourceExists) {
      await this.store.deleteWorkspace(migrationPlan.fromWorkspaceKey);
      this.options.logger.warn("deleted stale pre-upgrade workspace metadata while preparing workspace target", {
        workspace_key: migrationPlan.fromWorkspaceKey,
        workspace_path: migrationPlan.fromWorkspacePath,
        migration_target_key: migrationPlan.toWorkspaceKey,
        migration_reason: migrationPlan.reason,
        workspace_purpose: migrationPlan.purpose,
      });
      return;
    }
    if ((await pathExists(migrationPlan.toWorkspacePath)) || (await this.store.getWorkspace(migrationPlan.toWorkspaceKey))) {
      throw new SymphonyError(
        "workspace_error",
        `Cannot migrate pre-upgrade workspace artifact because the destination already exists: ${migrationPlan.toWorkspacePath}`,
      );
    }

    await assertRealPathInsideRoot(migrationPlan.fromWorkspacePath, this.options.workspace.root);
    await assertWorkspaceParentInsideRoot(migrationPlan.toWorkspacePath, this.options.workspace.root);
    await this.moveWorkspaceArtifact(metadata, migrationPlan.fromWorkspacePath, migrationPlan.toWorkspacePath);
    await this.writeMetadata({
      workspaceKey: migrationPlan.toWorkspaceKey,
      issueId: metadata.issueId,
      issueIdentifier: metadata.issueIdentifier,
      ...(metadata.projectContext === undefined ? {} : { projectContext: metadata.projectContext }),
      path: migrationPlan.toWorkspacePath,
      sourceKind: metadata.sourceKind,
      ...(metadata.repoPath === undefined ? {} : { repoPath: metadata.repoPath }),
      ...(metadata.baseRef === undefined ? {} : { baseRef: metadata.baseRef }),
      ...(metadata.gitBranchName === undefined ? {} : { gitBranchName: metadata.gitBranchName }),
      createdAt: metadata.createdAt,
      updatedAt: new Date().toISOString(),
    });
    await this.store.deleteWorkspace(migrationPlan.fromWorkspaceKey);

    this.options.logger.info("migrated pre-upgrade workspace artifact away from reserved contextual namespace", {
      workspace_key: migrationPlan.fromWorkspaceKey,
      workspace_path: migrationPlan.fromWorkspacePath,
      migrated_workspace_key: migrationPlan.toWorkspaceKey,
      migrated_workspace_path: migrationPlan.toWorkspacePath,
      migration_reason: migrationPlan.reason,
      workspace_purpose: migrationPlan.purpose,
    });
  }

  private async moveWorkspaceArtifact(metadata: WorkspaceRecord, fromWorkspacePath: string, toWorkspacePath: string): Promise<void> {
    if ((metadata.sourceKind === "git_worktree" || metadata.sourceKind === "planning_readonly") && metadata.repoPath) {
      await moveGitWorktree({
        repoPath: metadata.repoPath,
        workspacePath: fromWorkspacePath,
        nextWorkspacePath: toWorkspacePath,
        timeoutMs: this.options.hooks.timeoutMs,
      });
      return;
    }
    if (metadata.sourceKind === "git_worktree" || metadata.sourceKind === "planning_readonly") {
      throw new SymphonyError(
        "workspace_error",
        `Cannot migrate git-backed workspace without repository metadata: ${fromWorkspacePath}`,
      );
    }
    await fs.rename(fromWorkspacePath, toWorkspacePath);
  }

  private async resolveBranchName(issue: WorkspaceIssue): Promise<string> {
    const source = this.options.workspace.source;
    const template = source.branchTemplate ?? defaultBranchTemplateForIssue(issue);
    const branchName =
      issue.branchName ??
      (await this.branchRenderer.parseAndRender(template, {
        issue: {
          id: issue.id,
          identifier: issue.identifier,
          branchName: issue.branchName,
          projectContext: issue.projectContext,
        },
      }));
    const trimmed = String(branchName).trim();
    if (trimmed.length === 0) throw new SymphonyError("workspace_error", "Resolved git branch name is empty");
    return trimmed;
  }

  private async assertExistingWorktree(workspaceKey: string, workspacePath: string): Promise<void> {
    await ensureDirectory(workspacePath);
    await assertRealPathInsideRoot(workspacePath, this.options.workspace.root);
    const metadata = await this.store.getWorkspace(workspaceKey);
    if (metadata?.sourceKind !== "git_worktree" || !metadata.repoPath || !metadata.gitBranchName) {
      throw new SymphonyError("workspace_error", `Existing workspace is not a managed git worktree: ${workspacePath}`);
    }
    if (!(await pathExists(path.join(workspacePath, ".git")))) {
      throw new SymphonyError("workspace_error", `Existing workspace is missing git worktree metadata: ${workspacePath}`);
    }
  }
}

export interface WorkspaceIssue {
  id: string | null;
  identifier: string;
  branchName: string | null;
  projectContext?: ProjectContextResolution;
}

export type WorkspaceIssueInput = string | (Pick<Issue, "id" | "identifier" | "branchName"> & ProjectContextIssueLike);

type WorkspacePurpose = "implementation" | "planning";

type LegacyWorkspaceMigrationReason = "legacy_self" | "contextual_conflict";

interface LegacyWorkspaceMigrationPlan {
  reason: LegacyWorkspaceMigrationReason;
  purpose: WorkspacePurpose;
  fromWorkspaceKey: string;
  fromWorkspacePath: string;
  toWorkspaceKey: string;
  toWorkspacePath: string;
  expectedIssueIdentifierKey: string;
}

function normalizeIssueInput(input: WorkspaceIssueInput): WorkspaceIssue {
  if (typeof input === "string") return { id: null, identifier: input, branchName: null };
  const projectContext = projectContextResolutionFromIssue(input) ?? undefined;
  return {
    id: input.id,
    identifier: input.identifier,
    branchName: input.branchName,
    ...(projectContext === undefined ? {} : { projectContext }),
  };
}

function workspaceKeyForIssue(issue: WorkspaceIssue): string {
  const identifierKey = sanitizeWorkspaceKey(issue.identifier);
  const projectContextId = issue.projectContext?.projectContextId;
  if (!projectContextId || projectContextId === LEGACY_DEFAULT_PROJECT_CONTEXT_ID) {
    return escapeReservedLegacyWorkspaceKey(identifierKey);
  }
  return workspaceKeyForContextualIssue(projectContextId, identifierKey);
}

function workspaceKeyForPlanning(issue: WorkspaceIssue): string {
  return `${workspaceKeyForIssue(issue)}-planning`;
}

function workspaceKeyForContextualIssue(projectContextId: string, identifierKey: string): string {
  return `${CONTEXTUAL_WORKSPACE_KEY_NAMESPACE}${sanitizeWorkspaceKey(projectContextId)}__${identifierKey}`;
}

function workspaceKeyForPreUpgradeLegacyIssue(identifierKey: string, purpose: WorkspacePurpose): string {
  return purpose === "planning" ? `${identifierKey}-planning` : identifierKey;
}

function workspaceKeyForPurpose(issue: WorkspaceIssue, purpose: WorkspacePurpose): string {
  return purpose === "planning" ? workspaceKeyForPlanning(issue) : workspaceKeyForIssue(issue);
}

function legacyWorkspaceMigrationPlanForIssue(
  issue: WorkspaceIssue,
  purpose: WorkspacePurpose,
  workspaceRoot: string,
): LegacyWorkspaceMigrationPlan | null {
  const identifierKey = sanitizeWorkspaceKey(issue.identifier);
  const projectContextId = issue.projectContext?.projectContextId;
  if (!projectContextId || projectContextId === LEGACY_DEFAULT_PROJECT_CONTEXT_ID) {
    const currentWorkspaceKey = workspaceKeyForPurpose(issue, purpose);
    const preUpgradeWorkspaceKey = workspaceKeyForPreUpgradeLegacyIssue(identifierKey, purpose);
    if (currentWorkspaceKey === preUpgradeWorkspaceKey) return null;
    return {
      reason: "legacy_self",
      purpose,
      fromWorkspaceKey: preUpgradeWorkspaceKey,
      fromWorkspacePath: path.resolve(workspaceRoot, preUpgradeWorkspaceKey),
      toWorkspaceKey: currentWorkspaceKey,
      toWorkspacePath: path.resolve(workspaceRoot, currentWorkspaceKey),
      expectedIssueIdentifierKey: identifierKey,
    };
  }

  const contextualIdentifierKey = workspaceKeyForContextualIssue(projectContextId, identifierKey);
  const contextualWorkspaceKey = workspaceKeyForPreUpgradeLegacyIssue(contextualIdentifierKey, purpose);
  const escapedLegacyWorkspaceKey = workspaceKeyForPreUpgradeLegacyIssue(
    escapeReservedLegacyWorkspaceKey(contextualIdentifierKey),
    purpose,
  );
  return {
    reason: "contextual_conflict",
    purpose,
    fromWorkspaceKey: contextualWorkspaceKey,
    fromWorkspacePath: path.resolve(workspaceRoot, contextualWorkspaceKey),
    toWorkspaceKey: escapedLegacyWorkspaceKey,
    toWorkspacePath: path.resolve(workspaceRoot, escapedLegacyWorkspaceKey),
    expectedIssueIdentifierKey: contextualIdentifierKey,
  };
}

function isLegacyWorkspaceMigrationCandidate(record: WorkspaceRecord, plan: LegacyWorkspaceMigrationPlan): boolean {
  return (
    record.workspaceKey === plan.fromWorkspaceKey &&
    path.resolve(record.path) === plan.fromWorkspacePath &&
    sanitizeWorkspaceKey(record.issueIdentifier) === plan.expectedIssueIdentifierKey &&
    (record.projectContext?.projectContextId ?? LEGACY_DEFAULT_PROJECT_CONTEXT_ID) === LEGACY_DEFAULT_PROJECT_CONTEXT_ID
  );
}

export function sanitizeWorkspaceKey(identifier: string): string {
  const sanitized = identifier.replace(/[^A-Za-z0-9._-]/g, "_");
  return sanitized.length > 0 ? sanitized : "issue";
}

function escapeReservedLegacyWorkspaceKey(identifierKey: string): string {
  return identifierKey.startsWith(CONTEXTUAL_WORKSPACE_KEY_NAMESPACE)
    ? `${LEGACY_RESERVED_WORKSPACE_KEY_ESCAPE_PREFIX}${identifierKey}`
    : identifierKey;
}

function defaultBranchTemplateForIssue(issue: WorkspaceIssue): string {
  const projectContextId = issue.projectContext?.projectContextId;
  if (!projectContextId || projectContextId === LEGACY_DEFAULT_PROJECT_CONTEXT_ID) {
    return "symphony/{{ issue.identifier }}";
  }
  return "symphony/{{ issue.projectContext.projectContextId }}/{{ issue.identifier }}";
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

function assertSupportedPlanningWorkspaceMode(mode: "none" | "readonly_checkout", sourceKind: WorkspaceConfig["source"]["kind"]): void {
  if (mode !== "readonly_checkout") return;
  if (sourceKind !== "git_worktree") {
    throw new SymphonyError(
      "config_validation_error",
      "issue_breakdown.workspace_mode readonly_checkout requires workspace.source.kind git_worktree",
    );
  }
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
    child.on("exit", (code) => {
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

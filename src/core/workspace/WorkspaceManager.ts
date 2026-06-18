import { constants as fsConstants, existsSync, promises as fs, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Liquid } from "liquidjs";
import type { HookConfig, WorkspaceConfig } from "../config/Config.js";
import {
  LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
  normalizeProjectContextResolution,
  projectContextResolutionFromIssue,
  type ProjectContextResolution,
} from "../config/ProjectContexts.js";
import { SymphonyError, errorMessage } from "../errors.js";
import type { Issue, Workspace } from "../types.js";
import type { Logger } from "../logging/StructuredLogger.js";
import {
  createGitPlanningCheckout,
  createGitWorktree,
  removeGitWorktree,
  type GitBranchCollisionReason,
  type ResolvedGitBranchSelection,
} from "./GitWorktreeManager.js";
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
  projectContext?: ProjectContextResolution | undefined;
  path: string;
  createdAt: string;
  updatedAt: string;
  sourceKind: string;
  repoPath?: string;
  baseRef?: string;
  gitBranchName?: string;
}

interface ResolvedWorkspaceTarget {
  workspaceKey: string;
  workspacePath: string;
  existing: WorkspaceRecord | null;
  createdNow: boolean;
}

export class WorkspaceManager {
  private readonly branchRenderer = new Liquid({ strictVariables: true });
  private readonly branchTemplateSafetyCache = new Map<string, ScopedBranchNameDecision>();
  private readonly store: FileRunTranscriptStore;

  constructor(private readonly options: WorkspaceManagerOptions) {
    this.store = new FileRunTranscriptStore(options.workspace.stateDir);
  }

  async createForIssue(issueInput: WorkspaceIssueInput): Promise<Workspace> {
    const issue = normalizeIssueInput(issueInput);
    const issueIdentifier = issue.identifier;

    await fs.mkdir(this.options.workspace.root, { recursive: true });
    await fs.mkdir(this.options.workspace.stateDir, { recursive: true });
    const { workspaceKey, workspacePath, existing, createdNow } = await this.resolveWorkspaceTarget(issue);
    await assertWorkspaceParentInsideRoot(workspacePath, this.options.workspace.root);
    let repoPath = existing?.repoPath;
    let baseRef = existing?.baseRef;
    let gitBranchName = existing?.gitBranchName;
    const sourceKind = this.options.workspace.source.kind;
    if (createdNow && this.options.workspace.source.kind === "git_worktree") {
      const branch = await this.resolveBranchSelection(issue);
      const result = await createGitWorktree({
        source: this.options.workspace.source,
        stateDir: this.options.workspace.stateDir,
        workspacePath,
        branch,
        timeoutMs: this.options.hooks.timeoutMs,
        logger: this.options.logger,
      });
      repoPath = result.repoPath;
      baseRef = result.baseRef;
      gitBranchName = result.branchName;
      await assertRealPathInsideRoot(workspacePath, this.options.workspace.root);
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
    const metadata: WorkspaceMetadata = {
      workspaceKey,
      issueId: issue.id,
      issueIdentifier,
      projectContext: issue.projectContext ?? existing?.projectContext,
      path: workspacePath,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sourceKind,
      ...(repoPath === undefined ? {} : { repoPath }),
      ...(baseRef === undefined ? {} : { baseRef }),
      ...(gitBranchName === undefined ? {} : { gitBranchName }),
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

    await fs.mkdir(this.options.workspace.root, { recursive: true });
    await fs.mkdir(this.options.workspace.stateDir, { recursive: true });
    const { workspaceKey, workspacePath, existing, createdNow } = await this.resolveWorkspaceTarget(issue, { planning: true });
    await assertWorkspaceParentInsideRoot(workspacePath, this.options.workspace.root);
    const source = this.options.workspace.source;
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
            ...(issue.projectContext === null ? {} : { projectContext: issue.projectContext }),
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
            ...(issue.projectContext === null ? {} : { projectContext: issue.projectContext }),
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
      projectContext: issue.projectContext ?? existing?.projectContext,
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
    const persistedWorkspace = await this.findPlanningWorkspaceForRemoval(issue);
    const resolvedIssue =
      !issue.projectContext && persistedWorkspace?.projectContext ? { ...issue, projectContext: persistedWorkspace.projectContext } : issue;
    const workspaceKey = persistedWorkspace?.workspaceKey ?? workspaceKeyForPlanningIssue(resolvedIssue);
    const workspacePath = persistedWorkspace?.path ?? path.resolve(this.options.workspace.root, workspaceKey);
    assertPathInsideRoot(workspacePath, this.options.workspace.root);
    const metadata = persistedWorkspace ?? (await this.store.getWorkspace(workspaceKey));
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
    const persistedWorkspace = await this.findWorkspaceForRemoval(issue);
    const resolvedIssue =
      !issue.projectContext && persistedWorkspace?.projectContext ? { ...issue, projectContext: persistedWorkspace.projectContext } : issue;
    const workspaceKey = persistedWorkspace?.workspaceKey ?? workspaceKeyForIssue(resolvedIssue);
    const workspacePath = persistedWorkspace?.path ?? path.resolve(this.options.workspace.root, workspaceKey);
    assertPathInsideRoot(workspacePath, this.options.workspace.root);

    if (!(await pathExists(workspacePath))) {
      await this.store.deleteWorkspace(workspaceKey);
      return;
    }
    await assertRealPathInsideRoot(workspacePath, this.options.workspace.root);
    await this.runHook("before_remove", this.options.hooks.beforeRemove, workspacePath, false);
    const metadata = persistedWorkspace ?? (await this.store.getWorkspace(workspaceKey));
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

  private async findWorkspaceForRemoval(issue: WorkspaceIssue): Promise<WorkspaceRecord | null> {
    if (issue.id) {
      return issue.projectContext
        ? this.store.findWorkspace(issue.id, { projectContext: issue.projectContext })
        : this.store.findWorkspace(issue.id);
    }
    if (issue.projectContext) {
      return this.store.findWorkspace(issue.identifier, { projectContext: issue.projectContext });
    }
    return null;
  }

  private async findPlanningWorkspaceForRemoval(issue: WorkspaceIssue): Promise<WorkspaceRecord | null> {
    if (!issue.id && !issue.projectContext) return null;
    const records = await this.store.listWorkspaces();
    return (
      records.find(
        (record) =>
          isPlanningWorkspaceKey(record.workspaceKey) &&
          (issue.id ? record.issueId === issue.id : record.issueIdentifier === issue.identifier) &&
          matchesWorkspaceProjectContext(record.projectContext, issue.projectContext),
      ) ?? null
    );
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

  private async resolveWorkspaceTarget(
    issue: WorkspaceIssue,
    options: { planning?: boolean } = {},
  ): Promise<ResolvedWorkspaceTarget> {
    const planningSuffix = options.planning ? "-planning" : "";
    const requestedWorkspaceKeyBase = workspaceKeyForIssue(issue);
    const requestedWorkspaceKey = `${requestedWorkspaceKeyBase}${planningSuffix}`;
    const fallbackWorkspaceKeys = fallbackWorkspaceKeysForIssue(issue, requestedWorkspaceKeyBase, planningSuffix);
    const numberedFallbackBase = fallbackWorkspaceKeys.at(-1) ?? `${requestedWorkspaceKey}__alt`;
    const candidateWorkspaceKeys = [requestedWorkspaceKey, ...fallbackWorkspaceKeys];
    let fallbackOrdinal = 2;
    while (true) {
      const nextCandidate = candidateWorkspaceKeys.shift();
      const workspaceKey = nextCandidate ?? numberedWorkspaceCollisionKey(numberedFallbackBase, fallbackOrdinal++);
      const workspacePath = path.resolve(this.options.workspace.root, workspaceKey);
      assertPathInsideRoot(workspacePath, this.options.workspace.root);
      const existing = await this.store.getWorkspace(workspaceKey);
      const createdNow = !(await pathExists(workspacePath));
      if (!requiresWorkspaceCollisionFallback(issue) || !workspaceTargetConflictsWithIssue(existing, issue, createdNow)) {
        if (workspaceKey !== requestedWorkspaceKey) {
          this.options.logger.warn("workspace key collision avoided", {
            issue_id: issue.id,
            issue_identifier: issue.identifier,
            project_context_id: issue.projectContext?.projectContextId ?? null,
            requested_workspace_key: requestedWorkspaceKey,
            resolved_workspace_key: workspaceKey,
          });
        }
        return { workspaceKey, workspacePath, existing, createdNow };
      }
    }
  }

  getPathForIssue(issueInput: WorkspaceIssueInput): string {
    const issue = normalizeIssueInput(issueInput);
    const persistedWorkspace = this.findPersistedWorkspaceRecordSync(issue);
    const workspacePath = persistedWorkspace?.path ?? path.resolve(this.options.workspace.root, this.resolveWorkspaceKeyForPathLookup(issue));
    assertPathInsideRoot(workspacePath, this.options.workspace.root);
    return workspacePath;
  }

  async getWorkspaceRecord(workspaceKeyOrIssue: string): Promise<WorkspaceRecord | null> {
    return this.store.findWorkspace(workspaceKeyOrIssue);
  }

  private findPersistedWorkspaceRecordSync(issue: WorkspaceIssue): WorkspaceRecord | null {
    const requestedWorkspaceKey = workspaceKeyForIssue(issue);
    const direct = this.readPersistedWorkspaceRecordSync(requestedWorkspaceKey);
    if (direct && workspaceRecordMatchesLookupIssue(direct, issue)) return direct;
    if (issue.id === null && issue.projectContext === null) return direct;

    const matches = this.listPersistedWorkspaceRecordsSync()
      .filter((record) => workspaceRecordMatchesLookupIssue(record, issue))
      .sort(comparePersistedWorkspaceRecencyDesc);
    return matches[0] ?? null;
  }

  private listPersistedWorkspaceRecordsSync(): WorkspaceRecord[] {
    const workspacesDir = path.join(this.options.workspace.stateDir, "workspaces");
    if (!existsSync(workspacesDir)) return [];
    return readdirSync(workspacesDir)
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => this.readPersistedWorkspaceRecordSync(path.basename(entry, ".json")))
      .filter((record): record is WorkspaceRecord => record !== null);
  }

  private readPersistedWorkspaceRecordSync(workspaceKey: string): WorkspaceRecord | null {
    const workspaceRecordPath = path.join(this.options.workspace.stateDir, "workspaces", `${workspaceKey}.json`);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const record = JSON.parse(readFileSync(workspaceRecordPath, "utf8")) as WorkspaceRecord;
        return {
          ...record,
          projectContext: normalizeProjectContextResolution(record.projectContext),
        };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return null;
        const retryable = code === "EBUSY" || code === "EPERM" || error instanceof SyntaxError;
        if (!retryable || attempt === 4) throw error;
        sleepSync(10);
      }
    }
    return null;
  }

  private resolveWorkspaceKeyForPathLookup(issue: WorkspaceIssue): string {
    const requestedWorkspaceKeyBase = workspaceKeyForIssue(issue);
    const fallbackWorkspaceKeys = fallbackWorkspaceKeysForIssue(issue, requestedWorkspaceKeyBase, "");
    const numberedFallbackBase = fallbackWorkspaceKeys.at(-1) ?? `${requestedWorkspaceKeyBase}__alt`;
    const candidateWorkspaceKeys = [requestedWorkspaceKeyBase, ...fallbackWorkspaceKeys];
    let fallbackOrdinal = 2;
    while (true) {
      const workspaceKey = candidateWorkspaceKeys.shift() ?? numberedWorkspaceCollisionKey(numberedFallbackBase, fallbackOrdinal++);
      const workspacePath = path.resolve(this.options.workspace.root, workspaceKey);
      assertPathInsideRoot(workspacePath, this.options.workspace.root);
      const existing = this.readPersistedWorkspaceRecordSync(workspaceKey);
      const createdNow = !existsSync(workspacePath);
      if (!requiresWorkspaceCollisionFallback(issue) || !workspaceTargetConflictsWithIssue(existing, issue, createdNow)) {
        return workspaceKey;
      }
    }
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

  private async resolveBranchSelection(issue: WorkspaceIssue): Promise<ResolvedGitBranchSelection> {
    const source = this.options.workspace.source;
    const template = source.branchTemplate ?? null;
    const trackerBranchName = issue.branchName ?? null;
    const branchSource: ResolvedGitBranchSelection["source"] = trackerBranchName !== null
      ? "tracker_metadata"
      : template
        ? "branch_template"
        : "default_fallback";
    const candidateBranchName = trackerBranchName !== null
      ? trackerBranchName
      : template
        ? await this.branchRenderer.parseAndRender(template, {
            issue: {
              id: issue.id,
              identifier: issue.identifier,
              branchName: issue.branchName,
              projectContext: issue.projectContext,
              projectContextId: issue.projectContext?.projectContextId ?? null,
              projectContextLabel: issue.projectContext?.projectContextLabel ?? null,
            },
          })
        : defaultBranchNameForIssue(issue);
    const trimmedCandidateBranchName = String(candidateBranchName).trim();
    if (trimmedCandidateBranchName.length === 0) {
      throw new SymphonyError("workspace_error", "Resolved git branch name is empty");
    }

    const scopedBranch =
      branchSource === "branch_template"
        ? this.resolveBranchTemplateSafetyDecision(issue, template, trackerBranchName, trimmedCandidateBranchName)
        : scopeBranchNameToProjectContext(trimmedCandidateBranchName, issue);

    return {
      branchName: scopedBranch.branchName,
      candidateBranchName: trimmedCandidateBranchName,
      source: branchSource,
      collisionReason: scopedBranch.collisionReason,
      trackerBranchName,
      branchTemplate: branchSource === "branch_template" ? template : null,
    };
  }

  private resolveBranchTemplateSafetyDecision(
    issue: WorkspaceIssue,
    template: string | null,
    trackerBranchName: string | null,
    candidateBranchName: string,
  ): ScopedBranchNameDecision {
    const cacheKey = JSON.stringify({
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      projectContextId: issue.projectContext?.projectContextId ?? null,
      projectContextLabel: issue.projectContext?.projectContextLabel ?? null,
      repository: this.options.workspace.source.kind === "git_worktree" ? this.options.workspace.source.repository ?? null : null,
      template,
      trackerBranchName,
      candidateBranchName,
    });
    const cached = this.branchTemplateSafetyCache.get(cacheKey);
    if (cached) return cached;
    const decision = scopeBranchNameToProjectContext(candidateBranchName, issue, { renderedFromTemplate: true });
    this.branchTemplateSafetyCache.set(cacheKey, decision);
    return decision;
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
  projectContext: ProjectContextResolution | null;
}

export interface WorkspaceIssueInput {
  id: string | null;
  identifier: string;
  branchName?: string | null;
  projectContext?: ProjectContextResolution | null;
}

function normalizeIssueInput(input: WorkspaceIssueInput): WorkspaceIssue {
  return {
    id: input.id,
    identifier: input.identifier,
    branchName: input.branchName ?? null,
    projectContext: projectContextResolutionFromIssue(input),
  };
}

interface ScopedBranchNameDecision {
  branchName: string;
  collisionReason: GitBranchCollisionReason | null;
}

function workspaceKeyForIssue(issue: WorkspaceIssue): string {
  return scopedWorkspaceKey(sanitizeWorkspaceKey(issue.identifier), issue.projectContext);
}

function workspaceKeyForPlanningIssue(issue: WorkspaceIssue): string {
  return `${workspaceKeyForIssue(issue)}-planning`;
}

function isPlanningWorkspaceKey(workspaceKey: string): boolean {
  return workspaceKey.endsWith("-planning");
}

function matchesWorkspaceProjectContext(
  recordProjectContext: ProjectContextResolution | undefined,
  issueProjectContext: ProjectContextResolution | null,
): boolean {
  if (!issueProjectContext) return true;
  const recordProjectContextId = recordProjectContext?.projectContextId ?? LEGACY_DEFAULT_PROJECT_CONTEXT_ID;
  return recordProjectContextId === issueProjectContext.projectContextId;
}

function scopedWorkspaceKey(baseWorkspaceKey: string, projectContext: ProjectContextResolution | null): string {
  if (!projectContext || projectContext.projectContextId === LEGACY_DEFAULT_PROJECT_CONTEXT_ID) return baseWorkspaceKey;
  return `${sanitizeWorkspaceKey(projectContext.projectContextId)}__${baseWorkspaceKey}`;
}

function requiresWorkspaceCollisionFallback(issue: WorkspaceIssue): boolean {
  return issue.projectContext !== null && issue.projectContext.projectContextId !== LEGACY_DEFAULT_PROJECT_CONTEXT_ID;
}

function fallbackWorkspaceKeysForIssue(
  issue: WorkspaceIssue,
  baseWorkspaceKey: string,
  planningSuffix: string,
): string[] {
  const exactIssueId = issue.id ? sanitizeWorkspaceKey(issue.id) : null;
  if (exactIssueId) {
    return [`${baseWorkspaceKey}__id__${exactIssueId}${planningSuffix}`];
  }
  return [`${baseWorkspaceKey}__alt${planningSuffix}`];
}

function numberedWorkspaceCollisionKey(baseWorkspaceKey: string, ordinal: number): string {
  return `${baseWorkspaceKey}__${ordinal}`;
}

function workspaceTargetConflictsWithIssue(
  existing: WorkspaceRecord | null,
  issue: WorkspaceIssue,
  createdNow: boolean,
): boolean {
  if (existing) return !workspaceRecordMatchesIssue(existing, issue);
  return !createdNow;
}

function workspaceRecordMatchesIssue(record: WorkspaceRecord, issue: WorkspaceIssue): boolean {
  if (issue.id !== null) return record.issueId === issue.id;
  return record.issueIdentifier === issue.identifier && matchesWorkspaceProjectContext(record.projectContext, issue.projectContext);
}

function workspaceRecordMatchesLookupIssue(record: WorkspaceRecord, issue: WorkspaceIssue): boolean {
  if (isPlanningWorkspaceKey(record.workspaceKey)) return false;
  if (issue.id !== null && record.issueId !== issue.id) return false;
  if (issue.id === null && record.issueIdentifier !== issue.identifier) return false;
  return matchesWorkspaceProjectContext(record.projectContext, issue.projectContext);
}

function comparePersistedWorkspaceRecencyDesc(left: WorkspaceRecord, right: WorkspaceRecord): number {
  const updatedAtDifference = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  if (!Number.isNaN(updatedAtDifference) && updatedAtDifference !== 0) return updatedAtDifference;
  if (right.updatedAt !== left.updatedAt) return right.updatedAt.localeCompare(left.updatedAt);

  const createdAtDifference = Date.parse(right.createdAt) - Date.parse(left.createdAt);
  if (!Number.isNaN(createdAtDifference) && createdAtDifference !== 0) return createdAtDifference;
  if (right.createdAt !== left.createdAt) return right.createdAt.localeCompare(left.createdAt);

  return left.workspaceKey.localeCompare(right.workspaceKey);
}

function sleepSync(milliseconds: number): void {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    // Busy-wait intentionally so sync workspace lookup can mirror the store's transient read retries.
  }
}

function defaultBranchNameForIssue(issue: WorkspaceIssue): string {
  const projectContextId = issue.projectContext?.projectContextId;
  if (projectContextId && projectContextId !== LEGACY_DEFAULT_PROJECT_CONTEXT_ID) {
    return `symphony/${projectContextId}/${issue.identifier}`;
  }
  return `symphony/${issue.identifier}`;
}

function scopeBranchNameToProjectContext(
  branchName: string,
  issue: WorkspaceIssue,
  options: { renderedFromTemplate?: boolean } = {},
): ScopedBranchNameDecision {
  const projectContextId = issue.projectContext?.projectContextId;
  if (!projectContextId || projectContextId === LEGACY_DEFAULT_PROJECT_CONTEXT_ID) {
    return { branchName, collisionReason: null };
  }

  const contextPart = sanitizeGitBranchPart(projectContextId);
  const branchParts = branchName.split("/").filter((part) => part.length > 0);
  const identifierParts = issue.identifier.split("/").filter((part) => part.length > 0);
  const unscopedDefaultParts = ["symphony", ...identifierParts];
  const matchesUnscopedDefault =
    branchParts.length === unscopedDefaultParts.length && branchParts.every((part, index) => part === unscopedDefaultParts[index]);
  if (options.renderedFromTemplate && !matchesUnscopedDefault && branchParts.some((part) => branchPartContainsContextToken(part, contextPart))) {
    return { branchName, collisionReason: "template_already_contextualized" };
  }
  const identifierIndex = findBranchPartSequence(branchParts, identifierParts);
  if (identifierIndex >= 0) {
    if (!matchesUnscopedDefault && identifierIndex > 0 && branchParts[identifierIndex - 1] === contextPart) {
      return { branchName, collisionReason: "already_contextualized_before_identifier" };
    }
    return {
      branchName: [...branchParts.slice(0, identifierIndex), contextPart, ...branchParts.slice(identifierIndex)].join("/"),
      collisionReason: "scoped_before_identifier",
    };
  }

  return {
    branchName: [...branchParts, contextPart].join("/"),
    collisionReason: "appended_context_suffix",
  };
}

function sanitizeGitBranchPart(value: string): string {
  const sanitized = value.trim().replace(/[^A-Za-z0-9._-]/g, "_");
  return sanitized.length > 0 ? sanitized : "context";
}

function findBranchPartSequence(parts: readonly string[], sequence: readonly string[]): number {
  if (sequence.length === 0 || parts.length < sequence.length) return -1;
  for (let start = 0; start <= parts.length - sequence.length; start += 1) {
    if (sequence.every((part, index) => parts[start + index] === part)) return start;
  }
  return -1;
}

function branchPartContainsContextToken(part: string, contextPart: string): boolean {
  return part.split(/[-_.]/).includes(contextPart);
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

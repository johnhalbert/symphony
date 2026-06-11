import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseServiceConfig } from "../src/core/config/Config.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import { FileRunTranscriptStore } from "../src/core/persistence/RunTranscriptStore.js";
import { WorkspaceManager } from "../src/core/workspace/WorkspaceManager.js";
import { issue, trackerIssue } from "./helpers.js";

describe("git worktree workspace source", () => {
  let root: string;
  let repo: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony worktree-"));
    repo = path.join(root, "source repo");
    await initRepo(repo);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates a branch worktree using Linear branch metadata", async () => {
    const manager = newManager(root, repo);

    const workspace = await manager.createForIssue(issue({ branchName: "symphony/TEST-1" }));
    const currentBranch = await git(["branch", "--show-current"], workspace.path);
    const readme = await readFile(path.join(workspace.path, "README.md"), "utf8");
    const record = await manager.getWorkspaceRecord("TEST-1");

    expect(currentBranch.trim()).toBe("symphony/TEST-1");
    expect(readme).toContain("hello");
    expect(workspace.gitBranchName).toBe("symphony/TEST-1");
    expect(record?.gitBranchName).toBe("symphony/TEST-1");
  });

  it("renders a fallback branch when the issue has no branch name", async () => {
    const manager = newManager(root, repo);

    const workspace = await manager.createForIssue(issue({ identifier: "TEST-2", branchName: null }));
    const currentBranch = await git(["branch", "--show-current"], workspace.path);

    expect(currentBranch.trim()).toBe("symphony/TEST-2");
    expect(workspace.workspaceKey).toBe("TEST-2");
  });

  it("uses distinct contextual fallback branches when tracker branch metadata is truly absent", async () => {
    const manager = newManager(root, repo);
    const symphonyIssue = trackerIssue({
      id: "issue-symphony-branch",
      identifier: "ENG-BRANCH-CTX",
      branchName: null,
      projectContextId: "symphony",
      projectContextLabel: "Symphony",
      linearProjectSlug: "SYMPHONY",
    });
    const docsIssue = trackerIssue({
      id: "issue-docs-branch",
      identifier: "ENG-BRANCH-CTX",
      branchName: null,
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      linearProjectSlug: "DOCS",
    });

    expect(symphonyIssue.branchName).toBeNull();
    expect(docsIssue.branchName).toBeNull();

    const symphonyWorkspace = await manager.createForIssue(symphonyIssue);
    const docsWorkspace = await manager.createForIssue(docsIssue);
    const symphonyBranch = await git(["branch", "--show-current"], symphonyWorkspace.path);
    const docsBranch = await git(["branch", "--show-current"], docsWorkspace.path);

    expect(symphonyWorkspace.createdNow).toBe(true);
    expect(docsWorkspace.createdNow).toBe(true);
    expect(symphonyBranch.trim()).toBe("symphony/symphony/ENG-BRANCH-CTX");
    expect(docsBranch.trim()).toBe("symphony/docs/ENG-BRANCH-CTX");
    expect(symphonyWorkspace.gitBranchName).toBe("symphony/symphony/ENG-BRANCH-CTX");
    expect(docsWorkspace.gitBranchName).toBe("symphony/docs/ENG-BRANCH-CTX");
    expect(symphonyWorkspace.workspaceKey).toBe("ctx__symphony__ENG-BRANCH-CTX");
    expect(docsWorkspace.workspaceKey).toBe("ctx__docs__ENG-BRANCH-CTX");
  });

  it("escapes reserved contextual prefixes for legacy implementation workspaces and preserves cleanup isolation", async () => {
    const manager = newManager(root, repo);
    const legacyIssue = issue({
      id: "issue-legacy-collision",
      identifier: "ctx__docs__ENG-LEGACY",
      branchName: "symphony/ctx__docs__ENG-LEGACY",
    });
    const docsIssue = trackerIssue({
      id: "issue-docs-collision",
      identifier: "ENG-LEGACY",
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      linearProjectSlug: "DOCS",
    });

    const legacyWorkspace = await manager.createForIssue(legacyIssue);
    const docsWorkspace = await manager.createForIssue(docsIssue);
    const legacyRecord = await manager.getWorkspaceRecord(legacyWorkspace.workspaceKey);
    const docsRecord = await manager.getWorkspaceRecord(docsWorkspace.workspaceKey);

    expect(legacyWorkspace.workspaceKey).toBe("~ctx__docs__ENG-LEGACY");
    expect(docsWorkspace.workspaceKey).toBe("ctx__docs__ENG-LEGACY");
    expect(legacyWorkspace.path).not.toBe(docsWorkspace.path);
    expect(legacyRecord?.issueId).toBe("issue-legacy-collision");
    expect(docsRecord?.issueId).toBe("issue-docs-collision");
    expect(docsRecord?.projectContext?.projectContextId).toBe("docs");

    await manager.removeForIssue(docsIssue);

    await expect(readFile(path.join(legacyWorkspace.path, "README.md"), "utf8")).resolves.toContain("hello");
    await expect(readFile(path.join(docsWorkspace.path, "README.md"), "utf8")).rejects.toThrow();
    await expect(manager.getWorkspaceRecord(legacyWorkspace.workspaceKey)).resolves.toMatchObject({
      issueId: "issue-legacy-collision",
      issueIdentifier: "ctx__docs__ENG-LEGACY",
    });
    expect(await manager.getWorkspaceRecord(docsWorkspace.workspaceKey)).toBeNull();
  });

  it("escapes reserved contextual prefixes for legacy planning workspaces and preserves cleanup isolation", async () => {
    const manager = newManager(root, repo, "force");
    const legacyIssue = issue({
      id: "issue-legacy-plan-collision",
      identifier: "ctx__docs__ENG-PLAN",
      branchName: "symphony/ctx__docs__ENG-PLAN",
    });
    const docsIssue = trackerIssue({
      id: "issue-docs-plan-collision",
      identifier: "ENG-PLAN",
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      linearProjectSlug: "DOCS",
    });

    const legacyWorkspace = await manager.createForPlanning(legacyIssue);
    const docsWorkspace = await manager.createForPlanning(docsIssue);
    const legacyRecord = await manager.getWorkspaceRecord(legacyWorkspace.workspaceKey);
    const docsRecord = await manager.getWorkspaceRecord(docsWorkspace.workspaceKey);

    expect(legacyWorkspace.workspaceKey).toBe("~ctx__docs__ENG-PLAN-planning");
    expect(docsWorkspace.workspaceKey).toBe("ctx__docs__ENG-PLAN-planning");
    expect(legacyWorkspace.path).not.toBe(docsWorkspace.path);
    expect(legacyRecord?.issueId).toBe("issue-legacy-plan-collision");
    expect(docsRecord?.issueId).toBe("issue-docs-plan-collision");
    expect(docsRecord?.projectContext?.projectContextId).toBe("docs");

    await manager.removeForPlanning(docsIssue);

    await expect(readFile(path.join(legacyWorkspace.path, ".symphony-planning.json"), "utf8")).resolves.toContain(
      '"issueIdentifier": "ctx__docs__ENG-PLAN"',
    );
    await expect(readFile(path.join(docsWorkspace.path, ".symphony-planning.json"), "utf8")).rejects.toThrow();
    await expect(manager.getWorkspaceRecord(legacyWorkspace.workspaceKey)).resolves.toMatchObject({
      issueId: "issue-legacy-plan-collision",
      issueIdentifier: "ctx__docs__ENG-PLAN",
    });
    expect(await manager.getWorkspaceRecord(docsWorkspace.workspaceKey)).toBeNull();
  });

  it("migrates pre-upgrade legacy implementation artifacts before contextual creation claims the reserved namespace", async () => {
    const manager = newManager(root, repo);
    const seededLegacy = await seedPreUpgradeLegacyImplementationArtifact(root, repo, {
      issueId: "issue-legacy-upgrade",
      identifier: "ctx__docs__ENG-UPGRADE",
      branchName: "symphony/ctx__docs__ENG-UPGRADE",
    });
    const docsIssue = trackerIssue({
      id: "issue-docs-upgrade",
      identifier: "ENG-UPGRADE",
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      linearProjectSlug: "DOCS",
    });

    const docsWorkspace = await manager.createForIssue(docsIssue);
    const migratedLegacyRecord = await manager.getWorkspaceRecord(seededLegacy.migratedKey);
    const docsRecord = await manager.getWorkspaceRecord(docsWorkspace.workspaceKey);
    const legacyBranch = await git(["branch", "--show-current"], seededLegacy.migratedPath);
    const docsBranch = await git(["branch", "--show-current"], docsWorkspace.path);

    expect(docsWorkspace.createdNow).toBe(true);
    expect(docsWorkspace.workspaceKey).toBe("ctx__docs__ENG-UPGRADE");
    expect(docsWorkspace.path).toBe(seededLegacy.originalPath);
    expect(migratedLegacyRecord?.issueId).toBe("issue-legacy-upgrade");
    expect(migratedLegacyRecord?.path).toBe(seededLegacy.migratedPath);
    expect(docsRecord?.issueId).toBe("issue-docs-upgrade");
    expect(docsRecord?.projectContext?.projectContextId).toBe("docs");
    expect(legacyBranch.trim()).toBe("symphony/ctx__docs__ENG-UPGRADE");
    expect(docsBranch.trim()).toBe("symphony/docs/ENG-UPGRADE");

    await manager.removeForIssue(docsIssue);

    await expect(readFile(path.join(seededLegacy.migratedPath, "README.md"), "utf8")).resolves.toContain("hello");
    await expect(readFile(path.join(docsWorkspace.path, "README.md"), "utf8")).rejects.toThrow();
    await expect(manager.getWorkspaceRecord(seededLegacy.migratedKey)).resolves.toMatchObject({
      issueId: "issue-legacy-upgrade",
      issueIdentifier: "ctx__docs__ENG-UPGRADE",
    });
    expect(await manager.getWorkspaceRecord(docsWorkspace.workspaceKey)).toBeNull();
  });

  it("migrates pre-upgrade legacy planning artifacts before contextual planning claims the reserved namespace", async () => {
    const manager = newManager(root, repo, "force");
    const seededLegacy = await seedPreUpgradeLegacyPlanningArtifact(root, {
      issueId: "issue-legacy-plan-upgrade",
      identifier: "ctx__docs__ENG-UPGRADE-PLAN",
    });
    const docsIssue = trackerIssue({
      id: "issue-docs-plan-upgrade",
      identifier: "ENG-UPGRADE-PLAN",
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      linearProjectSlug: "DOCS",
    });

    const docsWorkspace = await manager.createForPlanning(docsIssue);
    const migratedLegacyRecord = await manager.getWorkspaceRecord(seededLegacy.migratedKey);
    const docsRecord = await manager.getWorkspaceRecord(docsWorkspace.workspaceKey);

    expect(docsWorkspace.createdNow).toBe(true);
    expect(docsWorkspace.workspaceKey).toBe("ctx__docs__ENG-UPGRADE-PLAN-planning");
    expect(docsWorkspace.path).toBe(seededLegacy.originalPath);
    expect(migratedLegacyRecord?.issueId).toBe("issue-legacy-plan-upgrade");
    expect(migratedLegacyRecord?.path).toBe(seededLegacy.migratedPath);
    expect(docsRecord?.issueId).toBe("issue-docs-plan-upgrade");
    expect(docsRecord?.projectContext?.projectContextId).toBe("docs");
    await expect(readFile(path.join(seededLegacy.migratedPath, ".symphony-planning.json"), "utf8")).resolves.toContain(
      '"issueIdentifier": "ctx__docs__ENG-UPGRADE-PLAN"',
    );
    await expect(readFile(path.join(docsWorkspace.path, ".symphony-planning.json"), "utf8")).resolves.toContain(
      '"issueIdentifier": "ENG-UPGRADE-PLAN"',
    );

    await manager.removeForPlanning(docsIssue);

    await expect(readFile(path.join(seededLegacy.migratedPath, ".symphony-planning.json"), "utf8")).resolves.toContain(
      '"issueIdentifier": "ctx__docs__ENG-UPGRADE-PLAN"',
    );
    await expect(readFile(path.join(docsWorkspace.path, ".symphony-planning.json"), "utf8")).rejects.toThrow();
    await expect(manager.getWorkspaceRecord(seededLegacy.migratedKey)).resolves.toMatchObject({
      issueId: "issue-legacy-plan-upgrade",
      issueIdentifier: "ctx__docs__ENG-UPGRADE-PLAN",
    });
    expect(await manager.getWorkspaceRecord(docsWorkspace.workspaceKey)).toBeNull();
  });

  it("namespaces workspace keys, paths, and durable metadata for overlapping identifiers across project contexts", async () => {
    const manager = newManager(root, repo);
    const symphonyIssue = trackerIssue({
      id: "issue-symphony",
      identifier: "ENG-123",
      projectContextId: "symphony",
      projectContextLabel: "Symphony",
      linearProjectSlug: "SYMPHONY",
    });
    const docsIssue = trackerIssue({
      id: "issue-docs",
      identifier: "ENG-123",
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      linearProjectSlug: "DOCS",
    });

    const symphonyWorkspace = await manager.createForIssue(symphonyIssue);
    const docsWorkspace = await manager.createForIssue(docsIssue);
    const symphonyRecord = await manager.getWorkspaceRecord(symphonyWorkspace.workspaceKey);
    const docsRecord = await manager.getWorkspaceRecord(docsWorkspace.workspaceKey);

    expect(symphonyWorkspace.workspaceKey).toContain("symphony");
    expect(docsWorkspace.workspaceKey).toContain("docs");
    expect(symphonyWorkspace.workspaceKey).toContain("ENG-123");
    expect(docsWorkspace.workspaceKey).toContain("ENG-123");
    expect(symphonyWorkspace.workspaceKey).not.toBe(docsWorkspace.workspaceKey);
    expect(symphonyWorkspace.path).not.toBe(docsWorkspace.path);
    expect(symphonyRecord?.projectContext?.projectContextId).toBe("symphony");
    expect(docsRecord?.projectContext?.projectContextId).toBe("docs");
    expect(symphonyRecord?.path).toBe(symphonyWorkspace.path);
    expect(docsRecord?.path).toBe(docsWorkspace.path);
  });

  it("reuses the same context-scoped workspace while keeping sibling contexts isolated on cleanup", async () => {
    const manager = newManager(root, repo);
    const symphonyIssue = trackerIssue({
      id: "issue-symphony",
      identifier: "ENG-124",
      projectContextId: "symphony",
      projectContextLabel: "Symphony",
      linearProjectSlug: "SYMPHONY",
    });
    const docsIssue = trackerIssue({
      id: "issue-docs",
      identifier: "ENG-124",
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      linearProjectSlug: "DOCS",
    });

    const firstWorkspace = await manager.createForIssue(symphonyIssue);
    const reusedWorkspace = await manager.createForIssue(symphonyIssue);
    const docsWorkspace = await manager.createForIssue(docsIssue);

    expect(reusedWorkspace.createdNow).toBe(false);
    expect(reusedWorkspace.workspaceKey).toBe(firstWorkspace.workspaceKey);
    expect(reusedWorkspace.path).toBe(firstWorkspace.path);
    expect(docsWorkspace.path).not.toBe(firstWorkspace.path);

    await manager.removeForIssue(symphonyIssue);

    await expect(readFile(path.join(firstWorkspace.path, "README.md"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(docsWorkspace.path, "README.md"), "utf8")).resolves.toContain("hello");
    expect(await manager.getWorkspaceRecord(firstWorkspace.workspaceKey)).toBeNull();
    expect(await manager.getWorkspaceRecord(docsWorkspace.workspaceKey)).not.toBeNull();
  });

  it("namespaces planning workspaces across project contexts with overlapping identifiers", async () => {
    const manager = newManager(root, repo, "force");
    const symphonyIssue = trackerIssue({
      id: "issue-symphony-plan",
      identifier: "ENG-PLAN",
      projectContextId: "symphony",
      projectContextLabel: "Symphony",
      linearProjectSlug: "SYMPHONY",
    });
    const docsIssue = trackerIssue({
      id: "issue-docs-plan",
      identifier: "ENG-PLAN",
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      linearProjectSlug: "DOCS",
    });

    const symphonyWorkspace = await manager.createForPlanning(symphonyIssue);
    const docsWorkspace = await manager.createForPlanning(docsIssue);
    const symphonyRecord = await manager.getWorkspaceRecord(symphonyWorkspace.workspaceKey);
    const docsRecord = await manager.getWorkspaceRecord(docsWorkspace.workspaceKey);

    expect(symphonyWorkspace.workspaceKey).toContain("symphony");
    expect(docsWorkspace.workspaceKey).toContain("docs");
    expect(symphonyWorkspace.workspaceKey).toContain("ENG-PLAN");
    expect(docsWorkspace.workspaceKey).toContain("ENG-PLAN");
    expect(symphonyWorkspace.workspaceKey).toContain("planning");
    expect(docsWorkspace.workspaceKey).toContain("planning");
    expect(symphonyWorkspace.path).not.toBe(docsWorkspace.path);
    expect(symphonyRecord?.projectContext?.projectContextId).toBe("symphony");
    expect(docsRecord?.projectContext?.projectContextId).toBe("docs");

    await manager.removeForPlanning(symphonyIssue);
    await manager.removeForPlanning(docsIssue);
  });

  it("refuses to remove dirty worktrees by default", async () => {
    const manager = newManager(root, repo);
    const dirtyIssue = issue({ identifier: "TEST-3", branchName: "symphony/TEST-3" });
    const workspace = await manager.createForIssue(dirtyIssue);
    await writeFile(path.join(workspace.path, "dirty.txt"), "changed", "utf8");

    await expect(manager.removeForIssue(dirtyIssue)).rejects.toThrow(/dirty worktree/);
  });

  it("removes clean worktrees and deletes durable metadata", async () => {
    const manager = newManager(root, repo);
    const cleanIssue = issue({ identifier: "TEST-4", branchName: "symphony/TEST-4" });
    const workspace = await manager.createForIssue(cleanIssue);

    await manager.removeForIssue(cleanIssue);

    await expect(readFile(path.join(workspace.path, "README.md"), "utf8")).rejects.toThrow();
    expect(await manager.getWorkspaceRecord("TEST-4")).toBeNull();
  });

  it("force removes dirty worktrees when configured", async () => {
    const manager = newManager(root, repo, "force");
    const dirtyIssue = issue({ identifier: "TEST-5", branchName: "symphony/TEST-5" });
    const workspace = await manager.createForIssue(dirtyIssue);
    await writeFile(path.join(workspace.path, "dirty.txt"), "changed", "utf8");

    await manager.removeForIssue(dirtyIssue);

    expect(await manager.getWorkspaceRecord("TEST-5")).toBeNull();
  });

  it("creates default no-worktree planning workspaces", async () => {
    const manager = newManager(root, repo, "force");
    const planningIssue = issue({ identifier: "TEST-PLAN-NONE", branchName: "symphony/TEST-PLAN-NONE" });

    const workspace = await manager.createForPlanning(planningIssue);
    const marker = await readFile(path.join(workspace.path, ".symphony-planning.json"), "utf8");
    const record = await manager.getWorkspaceRecord("TEST-PLAN-NONE-planning");

    expect(workspace.workspaceKey).toBe("TEST-PLAN-NONE-planning");
    expect(workspace.sourceKind).toBe("planning_none");
    expect(workspace.gitBranchName).toBeUndefined();
    expect(workspace.repoPath).toBeUndefined();
    expect(marker).toContain('"mode": "none"');
    expect(record?.sourceKind).toBe("planning_none");
    await expect(readFile(path.join(workspace.path, ".git"), "utf8")).rejects.toThrow();

    await manager.removeForPlanning(planningIssue);

    await expect(readFile(path.join(workspace.path, ".symphony-planning.json"), "utf8")).rejects.toThrow();
    expect(await manager.getWorkspaceRecord("TEST-PLAN-NONE-planning")).toBeNull();
  });

  it("creates read-only detached planning checkouts and removes their planning metadata when opted in", async () => {
    const manager = newManager(root, repo, "force", "readonly_checkout");
    const planningIssue = issue({ identifier: "TEST-PLAN", branchName: "symphony/TEST-PLAN" });

    if (process.platform === "win32") {
      await expect(manager.createForPlanning(planningIssue)).rejects.toThrow("readonly_checkout is not supported on Windows");
      return;
    }

    const workspace = await manager.createForPlanning(planningIssue);
    const currentBranch = await git(["branch", "--show-current"], workspace.path);
    const readme = await readFile(path.join(workspace.path, "README.md"), "utf8");
    const marker = await readFile(path.join(workspace.path, ".symphony-planning-readonly.json"), "utf8");
    const record = await manager.getWorkspaceRecord("TEST-PLAN-planning");

    expect(currentBranch.trim()).toBe("");
    expect(readme).toContain("hello");
    expect(marker).toContain('"mode": "readonly_checkout"');
    expect(workspace.workspaceKey).toBe("TEST-PLAN-planning");
    expect(workspace.gitBranchName).toBeUndefined();
    expect(workspace.sourceKind).toBe("planning_readonly");
    expect(record?.sourceKind).toBe("planning_readonly");
    expect(record?.gitBranchName).toBeUndefined();
    await expect(writeFile(path.join(workspace.path, "write.txt"), "blocked", "utf8")).rejects.toThrow();

    await manager.removeForPlanning(planningIssue);

    await expect(readFile(path.join(workspace.path, "README.md"), "utf8")).rejects.toThrow();
    expect(await manager.getWorkspaceRecord("TEST-PLAN-planning")).toBeNull();
    expect(await manager.getWorkspaceRecord("TEST-PLAN")).toBeNull();
  });
});

function newManager(
  root: string,
  repository: string,
  cleanup: "refuse_dirty" | "force" = "refuse_dirty",
  planningWorkspaceMode: "none" | "readonly_checkout" = "none",
): WorkspaceManager {
  const config = parseServiceConfig(
    {
      tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
      workspace: {
        root: path.join(root, "workspaces"),
        source: {
          kind: "git_worktree",
          repository,
          base_ref: "main",
          branch_template: "symphony/{{ issue.identifier }}",
          cleanup,
        },
      },
      hooks: { timeout_ms: 30_000 },
    },
    path.join(root, "WORKFLOW.md"),
    { LINEAR_API_KEY: "linear-test-key" },
  );
  return new WorkspaceManager({
    workspace: config.workspace,
    hooks: config.hooks,
    logger: new StructuredLogger(() => undefined),
    planningWorkspaceMode,
  });
}

async function initRepo(repository: string): Promise<void> {
  await mkdir(repository, { recursive: true });
  await git(["init"], repository);
  await git(["checkout", "-b", "main"], repository);
  await writeFile(path.join(repository, "README.md"), "hello\n", "utf8");
  await git(["add", "README.md"], repository);
  await git(["-c", "user.name=Symphony Test", "-c", "user.email=symphony@example.com", "commit", "-m", "initial"], repository);
}

function workspaceStore(root: string): FileRunTranscriptStore {
  return new FileRunTranscriptStore(path.join(root, "workspaces", ".symphony"));
}

async function seedPreUpgradeLegacyImplementationArtifact(
  root: string,
  repository: string,
  options: { issueId: string; identifier: string; branchName: string },
): Promise<{ originalKey: string; migratedKey: string; originalPath: string; migratedPath: string }> {
  const originalKey = options.identifier;
  const migratedKey = `~${options.identifier}`;
  const originalPath = path.join(root, "workspaces", originalKey);
  const migratedPath = path.join(root, "workspaces", migratedKey);
  await mkdir(path.join(root, "workspaces"), { recursive: true });
  await git(["worktree", "add", "-b", options.branchName, originalPath, "main"], repository);
  const now = new Date().toISOString();
  await workspaceStore(root).upsertWorkspace({
    workspaceKey: originalKey,
    issueId: options.issueId,
    issueIdentifier: options.identifier,
    path: originalPath,
    sourceKind: "git_worktree",
    repoPath: repository,
    baseRef: "main",
    gitBranchName: options.branchName,
    createdAt: now,
    updatedAt: now,
  });
  return { originalKey, migratedKey, originalPath, migratedPath };
}

async function seedPreUpgradeLegacyPlanningArtifact(
  root: string,
  options: { issueId: string; identifier: string },
): Promise<{ originalKey: string; migratedKey: string; originalPath: string; migratedPath: string }> {
  const originalKey = `${options.identifier}-planning`;
  const migratedKey = `~${options.identifier}-planning`;
  const originalPath = path.join(root, "workspaces", originalKey);
  const migratedPath = path.join(root, "workspaces", migratedKey);
  await mkdir(originalPath, { recursive: true });
  const now = new Date().toISOString();
  await writeFile(
    path.join(originalPath, ".symphony-planning.json"),
    `${JSON.stringify({ issueId: options.issueId, issueIdentifier: options.identifier, mode: "none", createdAt: now }, null, 2)}
`,
    "utf8",
  );
  await workspaceStore(root).upsertWorkspace({
    workspaceKey: originalKey,
    issueId: options.issueId,
    issueIdentifier: options.identifier,
    path: originalPath,
    sourceKind: "planning_none",
    createdAt: now,
    updatedAt: now,
  });
  return { originalKey, migratedKey, originalPath, migratedPath };
}

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`git exited with ${code}: ${stderr}`));
    });
  });
}

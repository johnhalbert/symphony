import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseServiceConfig } from "../src/core/config/Config.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
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

  it("creates duplicate-identifier context worktrees without collision and cleans up only the targeted sibling", async () => {
    const manager = newManager(root, repo);
    const docsIssue = trackerIssue({
      id: "issue-docs-1",
      identifier: "ENG-123",
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      branchName: "symphony/docs/ENG-123",
    });
    const symphonyIssue = trackerIssue({
      id: "issue-symphony-1",
      identifier: "ENG-123",
      projectContextId: "symphony",
      projectContextLabel: "Symphony",
      branchName: "symphony/symphony/ENG-123",
    });

    const docsWorkspace = await manager.createForIssue(docsIssue);
    const symphonyWorkspace = await manager.createForIssue(symphonyIssue);

    expect(docsWorkspace.workspaceKey).toBe("docs__ENG-123");
    expect(symphonyWorkspace.workspaceKey).toBe("symphony__ENG-123");
    expect(docsWorkspace.path).not.toBe(symphonyWorkspace.path);
    expect((await git(["branch", "--show-current"], docsWorkspace.path)).trim()).toBe("symphony/docs/ENG-123");
    expect((await git(["branch", "--show-current"], symphonyWorkspace.path)).trim()).toBe("symphony/symphony/ENG-123");
    expect(await manager.getWorkspaceRecord(docsWorkspace.workspaceKey)).toMatchObject({
      issueId: docsIssue.id,
      issueIdentifier: docsIssue.identifier,
      projectContext: { projectContextId: "docs" },
    });
    expect(await manager.getWorkspaceRecord(symphonyWorkspace.workspaceKey)).toMatchObject({
      issueId: symphonyIssue.id,
      issueIdentifier: symphonyIssue.identifier,
      projectContext: { projectContextId: "symphony" },
    });

    await manager.removeForIssue(docsIssue);

    await expect(readFile(path.join(docsWorkspace.path, "README.md"), "utf8")).rejects.toThrow();
    expect(await manager.getWorkspaceRecord(docsWorkspace.workspaceKey)).toBeNull();
    await expect(readFile(path.join(symphonyWorkspace.path, "README.md"), "utf8")).resolves.toContain("hello");
    expect(await manager.getWorkspaceRecord(symphonyWorkspace.workspaceKey)).toMatchObject({
      issueId: symphonyIssue.id,
      issueIdentifier: symphonyIssue.identifier,
      projectContext: { projectContextId: "symphony" },
    });
  });

  it("scopes identical upstream branch names by project context and cleans up only the targeted sibling", async () => {
    const manager = newManager(root, repo);
    const docsIssue = trackerIssue({
      id: "issue-docs-2",
      identifier: "ENG-123",
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      branchName: "symphony/ENG-123",
    });
    const symphonyIssue = trackerIssue({
      id: "issue-symphony-2",
      identifier: "ENG-123",
      projectContextId: "symphony",
      projectContextLabel: "Symphony",
      branchName: "symphony/ENG-123",
    });

    const docsWorkspace = await manager.createForIssue(docsIssue);
    const symphonyWorkspace = await manager.createForIssue(symphonyIssue);

    expect(docsWorkspace.workspaceKey).toBe("docs__ENG-123");
    expect(symphonyWorkspace.workspaceKey).toBe("symphony__ENG-123");
    expect(docsWorkspace.gitBranchName).toBe("symphony/docs/ENG-123");
    expect(symphonyWorkspace.gitBranchName).toBe("symphony/symphony/ENG-123");
    expect((await git(["branch", "--show-current"], docsWorkspace.path)).trim()).toBe("symphony/docs/ENG-123");
    expect((await git(["branch", "--show-current"], symphonyWorkspace.path)).trim()).toBe("symphony/symphony/ENG-123");

    await manager.removeForIssue(docsIssue);

    await expect(readFile(path.join(docsWorkspace.path, "README.md"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(symphonyWorkspace.path, "README.md"), "utf8")).resolves.toContain("hello");
    expect(await manager.getWorkspaceRecord(symphonyWorkspace.workspaceKey)).toMatchObject({
      issueId: symphonyIssue.id,
      issueIdentifier: symphonyIssue.identifier,
      gitBranchName: "symphony/symphony/ENG-123",
      projectContext: { projectContextId: "symphony" },
    });
  });

  it("scopes identifier-only fallback branches by project context and cleans up only the targeted sibling", async () => {
    const manager = newManager(root, repo);
    const docsIssue = trackerIssue({
      id: "issue-docs-3",
      identifier: "ENG-123",
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      branchName: null,
    });
    const symphonyIssue = trackerIssue({
      id: "issue-symphony-3",
      identifier: "ENG-123",
      projectContextId: "symphony",
      projectContextLabel: "Symphony",
      branchName: null,
    });

    const docsWorkspace = await manager.createForIssue(docsIssue);
    const symphonyWorkspace = await manager.createForIssue(symphonyIssue);

    expect(docsWorkspace.workspaceKey).toBe("docs__ENG-123");
    expect(symphonyWorkspace.workspaceKey).toBe("symphony__ENG-123");
    expect(docsWorkspace.gitBranchName).toBe("symphony/docs/ENG-123");
    expect(symphonyWorkspace.gitBranchName).toBe("symphony/symphony/ENG-123");
    expect((await git(["branch", "--show-current"], docsWorkspace.path)).trim()).toBe("symphony/docs/ENG-123");
    expect((await git(["branch", "--show-current"], symphonyWorkspace.path)).trim()).toBe("symphony/symphony/ENG-123");

    await manager.removeForIssue(docsIssue);

    await expect(readFile(path.join(docsWorkspace.path, "README.md"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(symphonyWorkspace.path, "README.md"), "utf8")).resolves.toContain("hello");
    expect(await manager.getWorkspaceRecord(symphonyWorkspace.workspaceKey)).toMatchObject({
      issueId: symphonyIssue.id,
      issueIdentifier: symphonyIssue.identifier,
      gitBranchName: "symphony/symphony/ENG-123",
      projectContext: { projectContextId: "symphony" },
    });
  });

  it("does not rescope branch templates that already embed project context", async () => {
    const manager = newManager(
      root,
      repo,
      "refuse_dirty",
      "none",
      "symphony/{{ issue.identifier }}-{{ issue.projectContextId }}",
    );
    const docsIssue = trackerIssue({
      id: "issue-docs-template-1",
      identifier: "ENG-123",
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      branchName: null,
    });
    const symphonyIssue = trackerIssue({
      id: "issue-symphony-template-1",
      identifier: "ENG-123",
      projectContextId: "symphony",
      projectContextLabel: "Symphony",
      branchName: null,
    });

    const docsWorkspace = await manager.createForIssue(docsIssue);
    const symphonyWorkspace = await manager.createForIssue(symphonyIssue);

    expect(docsWorkspace.gitBranchName).toBe("symphony/ENG-123-docs");
    expect(symphonyWorkspace.gitBranchName).toBe("symphony/ENG-123-symphony");
    expect((await git(["branch", "--show-current"], docsWorkspace.path)).trim()).toBe("symphony/ENG-123-docs");
    expect((await git(["branch", "--show-current"], symphonyWorkspace.path)).trim()).toBe("symphony/ENG-123-symphony");
  });

  it("backfills persisted project context when removing duplicate-identifier worktrees without incoming context", async () => {
    const manager = newManager(root, repo);
    const docsIssue = trackerIssue({
      id: "issue-docs-4",
      identifier: "ENG-123",
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      branchName: "symphony/docs/ENG-123",
    });
    const symphonyIssue = trackerIssue({
      id: "issue-symphony-4",
      identifier: "ENG-123",
      projectContextId: "symphony",
      projectContextLabel: "Symphony",
      branchName: "symphony/symphony/ENG-123",
    });

    const docsWorkspace = await manager.createForIssue(docsIssue);
    const symphonyWorkspace = await manager.createForIssue(symphonyIssue);

    await manager.removeForIssue(
      issue({
        id: docsIssue.id,
        identifier: docsIssue.identifier,
        branchName: docsIssue.branchName,
      }),
    );

    await expect(readFile(path.join(docsWorkspace.path, "README.md"), "utf8")).rejects.toThrow();
    expect(await manager.getWorkspaceRecord(docsWorkspace.workspaceKey)).toBeNull();
    await expect(readFile(path.join(symphonyWorkspace.path, "README.md"), "utf8")).resolves.toContain("hello");
    expect(await manager.getWorkspaceRecord(symphonyWorkspace.workspaceKey)).toMatchObject({
      issueId: symphonyIssue.id,
      issueIdentifier: symphonyIssue.identifier,
      projectContext: { projectContextId: "symphony" },
    });
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
    expect((await stat(workspace.path)).mode & 0o222).toBe(0);
    expect((await stat(path.join(workspace.path, "README.md"))).mode & 0o222).toBe(0);

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
  branchTemplate = "symphony/{{ issue.identifier }}",
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
          branch_template: branchTemplate,
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

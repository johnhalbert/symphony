import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseServiceConfig } from "../src/core/config/Config.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import { WorkspaceManager } from "../src/core/workspace/WorkspaceManager.js";
import {
  createGitWorktree,
  verifyGitWorktreeSeedBinding,
  workspaceRepositoryFingerprint,
} from "../src/core/workspace/GitWorktreeManager.js";
import type { AcceptedArtifactWorkspaceSeed } from "../src/core/types.js";
import { FileRunTranscriptStore } from "../src/core/persistence/RunTranscriptStore.js";
import { issue } from "./helpers.js";

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
    const target = issue({ identifier: "TEST-2", branchName: null });

    expect(await manager.resolveBranchNameForIssue(target)).toBe("symphony/TEST-2");
    const workspace = await manager.createForIssue(target);
    const currentBranch = await git(["branch", "--show-current"], workspace.path);

    expect(currentBranch.trim()).toBe("symphony/TEST-2");
    expect(workspace.workspaceKey).toBe("TEST-2");
  });

  it("rebases an accepted artifact range onto the live base and persists its binding", async () => {
    const sourceBaseHeadSha = (await git(["rev-parse", "HEAD"], repo)).trim();
    await git(["checkout", "-b", "artifact/TEST-ARTIFACT"], repo);
    await mkdir(path.join(repo, "tests"), { recursive: true });
    await writeFile(path.join(repo, "tests", "expected-red.test.ts"), "expected red\n", "utf8");
    await commitAll(repo, "add expected-red test");
    const sourceHeadSha = (await git(["rev-parse", "HEAD"], repo)).trim();
    const blobSha = (await git(["rev-parse", "HEAD:tests/expected-red.test.ts"], repo)).trim();

    await git(["checkout", "main"], repo);
    await writeFile(path.join(repo, "LIVE_BASE.md"), "current base\n", "utf8");
    await commitAll(repo, "advance main");
    const preparedBaseHeadSha = (await git(["rev-parse", "HEAD"], repo)).trim();
    const seed = artifactSeed(repo, {
      sourceBaseHeadSha,
      sourceHeadSha,
      fileManifest: [
        { path: "tests/expected-red.test.ts", status: "added", blobSha },
      ],
    });
    const manager = newManager(root, repo);
    const target = issue({
      identifier: "TEST-SEED-1",
      branchName: "symphony/TEST-SEED-1",
    });

    const workspace = await manager.createForIssue(target, { seed });
    const preparedHeadSha = (await git(["rev-parse", "HEAD"], workspace.path)).trim();
    const record = await manager.getWorkspaceRecord("TEST-SEED-1");

    expect(await readFile(path.join(workspace.path, "LIVE_BASE.md"), "utf8")).toBe("current base\n");
    expect(await readFile(path.join(workspace.path, "tests", "expected-red.test.ts"), "utf8")).toBe(
      "expected red\n",
    );
    expect(preparedHeadSha).not.toBe(sourceHeadSha);
    expect(workspace.baseRef).toBe("main");
    expect(workspace.seed).toMatchObject({
      artifactId: "artifact-1",
      sourceBaseHeadSha,
      sourceHeadSha,
      preparedBaseHeadSha,
      preparedHeadSha,
      targetBranch: "symphony/TEST-SEED-1",
    });
    expect(record?.seed).toEqual(workspace.seed);
    await git(["merge-base", "--is-ancestor", preparedBaseHeadSha, preparedHeadSha], repo);
  });

  it("supports reviewed rename destinations and deletions in an artifact manifest", async () => {
    await writeFile(path.join(repo, "old.test.ts"), "renamed test\n", "utf8");
    await writeFile(path.join(repo, "obsolete.test.ts"), "obsolete test\n", "utf8");
    await commitAll(repo, "add test fixtures");
    const sourceBaseHeadSha = (await git(["rev-parse", "HEAD"], repo)).trim();
    await git(["checkout", "-b", "artifact/rename"], repo);
    await git(["mv", "old.test.ts", "renamed.test.ts"], repo);
    await git(["rm", "obsolete.test.ts"], repo);
    await commitAll(repo, "rename and delete tests");
    const sourceHeadSha = (await git(["rev-parse", "HEAD"], repo)).trim();
    const renamedBlobSha = (await git(["rev-parse", "HEAD:renamed.test.ts"], repo)).trim();
    await git(["checkout", "main"], repo);
    const seed = artifactSeed(repo, {
      artifactId: "artifact-rename",
      sourceBranch: "artifact/rename",
      sourceBaseHeadSha,
      sourceHeadSha,
      fileManifest: [
        { path: "renamed.test.ts", status: "renamed", blobSha: renamedBlobSha },
        { path: "obsolete.test.ts", status: "deleted", blobSha: null },
      ],
    });

    const workspace = await newManager(root, repo).createForIssue(
      issue({ identifier: "TEST-SEED-RENAME", branchName: "symphony/TEST-SEED-RENAME" }),
      { seed },
    );

    expect(await readFile(path.join(workspace.path, "renamed.test.ts"), "utf8")).toBe("renamed test\n");
    await expect(readFile(path.join(workspace.path, "old.test.ts"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(workspace.path, "obsolete.test.ts"), "utf8")).rejects.toThrow();
  });

  it("rejects a rename-conflict resolution that retains the reviewed source path", async () => {
    const baseTest = [
      "suite header",
      "shared line 1",
      "shared line 2",
      "behavior=base",
      "shared line 3",
      "shared line 4",
      "shared line 5",
      "",
    ].join("\n");
    const artifactTest = baseTest.replace("behavior=base", "behavior=artifact");
    const liveTest = baseTest.replace("behavior=base", "behavior=live");
    await writeFile(path.join(repo, "old-feature.test.ts"), baseTest, "utf8");
    await commitAll(repo, "add original expected-red test");
    const sourceBaseHeadSha = (await git(["rev-parse", "HEAD"], repo)).trim();
    await git(["checkout", "-b", "artifact/rename-conflict"], repo);
    await git(["mv", "old-feature.test.ts", "new-feature.test.ts"], repo);
    await writeFile(path.join(repo, "new-feature.test.ts"), artifactTest, "utf8");
    await commitAll(repo, "rename expected-red test");
    const sourceHeadSha = (await git(["rev-parse", "HEAD"], repo)).trim();
    const blobSha = (await git(["rev-parse", "HEAD:new-feature.test.ts"], repo)).trim();
    await git(["checkout", "main"], repo);
    await writeFile(path.join(repo, "old-feature.test.ts"), liveTest, "utf8");
    await commitAll(repo, "change original test on live base");

    const seed = artifactSeed(repo, {
      artifactId: "artifact-rename-conflict",
      sourceBranch: "artifact/rename-conflict",
      sourceBaseHeadSha,
      sourceHeadSha,
      fileManifest: [{ path: "new-feature.test.ts", status: "renamed", blobSha }],
    });
    const manager = newManager(root, repo);
    const target = issue({
      identifier: "TEST-SEED-RENAME-CONFLICT",
      branchName: "symphony/TEST-SEED-RENAME-CONFLICT",
    });
    const workspace = await manager.createForIssue(target, { seed });
    expect(workspace.seed?.conflictedFiles).toContain("new-feature.test.ts");

    await writeFile(path.join(workspace.path, "old-feature.test.ts"), liveTest, "utf8");
    await writeFile(path.join(workspace.path, "new-feature.test.ts"), artifactTest, "utf8");
    await expect(
      manager.finalizeAcceptedArtifactSeedConflict(target),
    ).rejects.toThrow(/outside Symphony control.*old-feature\.test\.ts/);

    await rm(path.join(workspace.path, "old-feature.test.ts"));
    const finalized = await manager.finalizeAcceptedArtifactSeedConflict(target);

    expect(finalized.conflictedFiles).toEqual([]);
    await expect(readFile(path.join(workspace.path, "old-feature.test.ts"), "utf8"))
      .rejects.toThrow();
    expect(await readFile(path.join(workspace.path, "new-feature.test.ts"), "utf8"))
      .toBe(artifactTest);
  });

  it("rejects a manifest that does not match the accepted source checkpoint", async () => {
    const sourceBaseHeadSha = (await git(["rev-parse", "HEAD"], repo)).trim();
    const wrongBlobSha = (await git(["rev-parse", "HEAD:README.md"], repo)).trim();
    await git(["checkout", "-b", "artifact/bad-manifest"], repo);
    await writeFile(path.join(repo, "artifact.test.ts"), "artifact test\n", "utf8");
    await commitAll(repo, "add artifact test");
    const sourceHeadSha = (await git(["rev-parse", "HEAD"], repo)).trim();
    await git(["checkout", "main"], repo);
    const manager = newManager(root, repo);
    const seed = artifactSeed(repo, {
      artifactId: "artifact-bad-manifest",
      sourceBranch: "artifact/bad-manifest",
      sourceBaseHeadSha,
      sourceHeadSha,
      fileManifest: [{ path: "artifact.test.ts", status: "added", blobSha: wrongBlobSha }],
    });

    await expect(
      manager.createForIssue(
        issue({ identifier: "TEST-SEED-BAD", branchName: "symphony/TEST-SEED-BAD" }),
        { seed },
      ),
    ).rejects.toThrow(/blob/);
    await expect(git(["show-ref", "--verify", "refs\/heads\/symphony\/TEST-SEED-BAD"], repo)).rejects.toThrow();
    await expect(readFile(path.join(root, "workspaces", "TEST-SEED-BAD", ".git"), "utf8")).rejects.toThrow();
  });

  it("preserves, resolves, finalizes, and reuses an accepted-artifact seed conflict", async () => {
    const sourceBaseHeadSha = (await git(["rev-parse", "HEAD"], repo)).trim();
    await git(["checkout", "-b", "artifact/conflict"], repo);
    await writeFile(path.join(repo, "README.md"), "artifact version\n", "utf8");
    await commitAll(repo, "change readme in artifact");
    const sourceHeadSha = (await git(["rev-parse", "HEAD"], repo)).trim();
    const blobSha = (await git(["rev-parse", "HEAD:README.md"], repo)).trim();
    await git(["checkout", "main"], repo);
    await writeFile(path.join(repo, "README.md"), "live base version\n", "utf8");
    await commitAll(repo, "change readme on main");
    const manager = newManager(root, repo);
    const seed = artifactSeed(repo, {
      artifactId: "artifact-conflict",
      sourceBranch: "artifact/conflict",
      sourceBaseHeadSha,
      sourceHeadSha,
      fileManifest: [{ path: "README.md", status: "modified", blobSha }],
    });

    const target = issue({
      identifier: "TEST-SEED-CONFLICT",
      branchName: "symphony/TEST-SEED-CONFLICT",
    });
    const workspace = await manager.createForIssue(target, { seed });
    const record = await manager.getWorkspaceRecord("TEST-SEED-CONFLICT");

    expect(workspace.seed).toMatchObject({
      artifactId: "artifact-conflict",
      targetBranch: "symphony/TEST-SEED-CONFLICT",
      preparedHeadSha: null,
      conflictedFiles: ["README.md"],
    });
    const preparedBaseHeadSha = workspace.seed!.preparedBaseHeadSha;
    expect(record?.seed).toEqual(workspace.seed);
    expect(await readFile(path.join(workspace.path, ".git"), "utf8")).toContain("gitdir:");
    expect(await git(["status", "--porcelain"], workspace.path)).toContain("UU README.md");

    const reusedConflict = await manager.createForIssue(target, { seed });
    expect(reusedConflict.createdNow).toBe(false);
    expect(reusedConflict.seed?.conflictedFiles).toEqual(["README.md"]);

    await expect(
      manager.finalizeAcceptedArtifactSeedConflict(target),
    ).rejects.toThrow(
      /conflict markers/,
    );
    await writeFile(
      path.join(workspace.path, "README.md"),
      "live base version\nweakened assertion\n",
      "utf8",
    );
    await writeFile(path.join(workspace.path, "outside.txt"), "out of scope\n", "utf8");
    await expect(
      manager.finalizeAcceptedArtifactSeedConflict(target),
    ).rejects.toThrow(/outside Symphony control.*outside\.txt/);
    await rm(path.join(workspace.path, "outside.txt"));

    await writeFile(path.join(repo, "BASE_ADVANCED.md"), "advanced during conflict turn\n", "utf8");
    await commitAll(repo, "advance main during seed conflict resolution");
    expect((await git(["rev-parse", "main"], repo)).trim()).not.toBe(preparedBaseHeadSha);

    await expect(
      manager.finalizeAcceptedArtifactSeedConflict(target),
    ).rejects.toThrow(/README\.md.*reviewed blob/);
    expect(await git(["status", "--porcelain"], workspace.path)).toContain(
      "UU README.md",
    );

    await writeFile(
      path.join(workspace.path, "README.md"),
      "artifact version\n",
      "utf8",
    );

    const finalized = await manager.finalizeAcceptedArtifactSeedConflict(target);
    const finalizedHead = (await git(["rev-parse", "HEAD"], workspace.path)).trim();
    expect(finalized).toMatchObject({
      preparedHeadSha: finalizedHead,
      targetBranch: "symphony/TEST-SEED-CONFLICT",
      conflictedFiles: [],
    });
    expect(finalized.preparedBaseHeadSha).toBe(preparedBaseHeadSha);
    expect(await readFile(path.join(workspace.path, "README.md"), "utf8")).toBe(
      "artifact version\n",
    );

    const reusedPrepared = await manager.createForIssue(target, { seed });
    expect(reusedPrepared.createdNow).toBe(false);
    expect(reusedPrepared.seed).toEqual(finalized);
    expect((await manager.getWorkspaceRecord("TEST-SEED-CONFLICT"))?.seed).toEqual(finalized);
  });

  it("service-stages bounded resolutions and persists each successive rebase conflict", async () => {
    await writeFile(path.join(repo, "first.test.ts"), "first=base\n", "utf8");
    await writeFile(path.join(repo, "second.test.ts"), "second=base\n", "utf8");
    await commitAll(repo, "add successive conflict fixtures");
    const sourceBaseHeadSha = (await git(["rev-parse", "HEAD"], repo)).trim();
    await git(["checkout", "-b", "artifact/successive-conflicts"], repo);
    await writeFile(path.join(repo, "first.test.ts"), "first=artifact\n", "utf8");
    await commitAll(repo, "change first artifact test");
    await writeFile(path.join(repo, "second.test.ts"), "second=artifact\n", "utf8");
    await commitAll(repo, "change second artifact test");
    const sourceHeadSha = (await git(["rev-parse", "HEAD"], repo)).trim();
    const firstBlobSha = (await git(["rev-parse", "HEAD:first.test.ts"], repo)).trim();
    const secondBlobSha = (await git(["rev-parse", "HEAD:second.test.ts"], repo)).trim();
    await git(["checkout", "main"], repo);
    await writeFile(path.join(repo, "first.test.ts"), "first=live\n", "utf8");
    await writeFile(path.join(repo, "second.test.ts"), "second=live\n", "utf8");
    await commitAll(repo, "change both tests on live base");
    const seed = artifactSeed(repo, {
      artifactId: "artifact-successive-conflicts",
      sourceBranch: "artifact/successive-conflicts",
      sourceBaseHeadSha,
      sourceHeadSha,
      fileManifest: [
        { path: "first.test.ts", status: "modified", blobSha: firstBlobSha },
        { path: "second.test.ts", status: "modified", blobSha: secondBlobSha },
      ],
    });
    const target = issue({
      identifier: "TEST-SEED-SUCCESSIVE",
      branchName: "symphony/TEST-SEED-SUCCESSIVE",
    });
    const manager = newManager(root, repo);
    const workspace = await manager.createForIssue(target, { seed });
    expect(workspace.seed?.conflictedFiles).toEqual(["first.test.ts"]);
    await writeFile(
      path.join(workspace.path, "first.test.ts"),
      "first=artifact\n",
      "utf8",
    );
    await git(["add", "--", "first.test.ts"], workspace.path);
    await expect(
      manager.finalizeAcceptedArtifactSeedConflict(target),
    ).rejects.toThrow(/expected: first\.test\.ts; actual: none/);
    await git(["reset", "HEAD", "--", "first.test.ts"], workspace.path);
    await expect(
      manager.finalizeAcceptedArtifactSeedConflict(target),
    ).rejects.toThrow(/second\.test\.ts/);
    await expect(manager.getWorkspaceRecord(target.identifier)).resolves.toMatchObject({
      seed: {
        preparedHeadSha: null,
        conflictedFiles: ["second.test.ts"],
      },
    });
    expect(await git(["status", "--porcelain"], workspace.path)).toContain(
      "UU second.test.ts",
    );

    await writeFile(
      path.join(workspace.path, "second.test.ts"),
      "second=artifact\n",
      "utf8",
    );
    const finalized = await manager.finalizeAcceptedArtifactSeedConflict(target);

    expect(finalized).toMatchObject({
      artifactId: seed.artifactId,
      preparedHeadSha: expect.any(String),
      conflictedFiles: [],
    });
    expect(await git(["status", "--porcelain"], workspace.path)).toBe("");
    await expect(manager.getWorkspaceRecord(target.identifier)).resolves.toMatchObject({
      seed: finalized,
    });
  });

  it("rejects mutation of a reviewed artifact blob in a prepared workspace", async () => {
    const { seed, target } = await reusableSeedFixture(repo, "immutable-blob");
    const manager = newManager(root, repo);
    const workspace = await manager.createForIssue(target, { seed });
    const testFile = seed.fileManifest[0]!.path;
    await writeFile(path.join(workspace.path, testFile), "weakened test\n", "utf8");
    await commitAll(workspace.path, "weaken reviewed artifact test");
    const mutatedHead = (await git(["rev-parse", "HEAD"], workspace.path)).trim();

    await expect(
      verifyGitWorktreeSeedBinding(
        workspace.path,
        { ...workspace.seed!, preparedHeadSha: mutatedHead },
        10_000,
      ),
    ).rejects.toThrow(new RegExp(`${testFile}.*reviewed manifest`));
  });

  it("keeps reviewed artifact command execution out of workspace finalization", async () => {
    const source = await readFile(
      path.resolve("src/core/workspace/WorkspaceManager.ts"),
      "utf8",
    );

    expect(source).not.toContain("ExpectedRedArtifactEvidence");
    expect(source).not.toContain("verifyExpectedRedEvidence");
    expect(source).not.toContain("runShellCommandWithOutput");
  });

  it("reuses a matching persisted seed binding and rejects a different artifact", async () => {
    const sourceBaseHeadSha = (await git(["rev-parse", "HEAD"], repo)).trim();
    await git(["checkout", "-b", "artifact/reuse"], repo);
    await writeFile(path.join(repo, "reuse.test.ts"), "reuse test\n", "utf8");
    await commitAll(repo, "add reusable artifact");
    const sourceHeadSha = (await git(["rev-parse", "HEAD"], repo)).trim();
    const blobSha = (await git(["rev-parse", "HEAD:reuse.test.ts"], repo)).trim();
    await git(["checkout", "main"], repo);
    const seed = artifactSeed(repo, {
      artifactId: "artifact-reuse",
      sourceBranch: "artifact/reuse",
      sourceBaseHeadSha,
      sourceHeadSha,
      fileManifest: [{ path: "reuse.test.ts", status: "added", blobSha }],
    });
    const manager = newManager(root, repo);
    const target = issue({ identifier: "TEST-SEED-REUSE", branchName: "symphony/TEST-SEED-REUSE" });
    const created = await manager.createForIssue(target, { seed });
    await writeFile(path.join(created.path, "implementation.ts"), "implemented\n", "utf8");
    await commitAll(created.path, "implement target");

    const reused = await manager.createForIssue(target, { seed });
    const reusedWithoutInput = await manager.createForIssue(target);

    expect(reused.createdNow).toBe(false);
    expect(reused.seed).toEqual(created.seed);
    expect(reusedWithoutInput.seed).toEqual(created.seed);
    await expect(
      manager.createForIssue(target, { seed: { ...seed, artifactId: "different-artifact" } }),
    ).rejects.toThrow(/does not match requested seed/);
  });

  it("refuses to apply an accepted artifact over an existing unbound target branch", async () => {
    const sourceBaseHeadSha = (await git(["rev-parse", "HEAD"], repo)).trim();
    await git(["checkout", "-b", "artifact/existing-target"], repo);
    await writeFile(path.join(repo, "existing-target.test.ts"), "test\n", "utf8");
    await commitAll(repo, "add artifact");
    const sourceHeadSha = (await git(["rev-parse", "HEAD"], repo)).trim();
    const blobSha = (await git(["rev-parse", "HEAD:existing-target.test.ts"], repo)).trim();
    await git(["checkout", "main"], repo);
    await git(["branch", "symphony/TEST-SEED-EXISTING"], repo);
    const seed = artifactSeed(repo, {
      artifactId: "artifact-existing-target",
      sourceBranch: "artifact/existing-target",
      sourceBaseHeadSha,
      sourceHeadSha,
      fileManifest: [{ path: "existing-target.test.ts", status: "added", blobSha }],
    });

    await expect(
      newManager(root, repo).createForIssue(
        issue({ identifier: "TEST-SEED-EXISTING", branchName: "symphony/TEST-SEED-EXISTING" }),
        { seed },
      ),
    ).rejects.toThrow(/existing target branch/);
  });

  it("adopts an exact journaled seeded worktree after a restart before metadata persistence", async () => {
    const { seed, target } = await reusableSeedFixture(repo, "restart-before-metadata");
    const config = worktreeConfig(root, repo);
    const workspacePath = path.join(config.workspace.root, target.identifier);
    const logger = new StructuredLogger(() => undefined);
    const created = await createGitWorktree({
      source: config.workspace.source,
      stateDir: config.workspace.stateDir,
      workspacePath,
      branchName: target.branchName!,
      seed,
      timeoutMs: config.hooks.timeoutMs,
      logger,
    });

    expect(created.seed?.artifactId).toBe(seed.artifactId);
    const journalFiles = await seedCreationJournalFiles(config.workspace.stateDir);
    expect(journalFiles).toHaveLength(1);
    const journalPath = path.join(
      config.workspace.stateDir,
      "seed-worktree-creations",
      journalFiles[0]!,
    );
    const interruptedJournal = JSON.parse(await readFile(journalPath, "utf8"));
    interruptedJournal.binding = null;
    await writeFile(journalPath, `${JSON.stringify(interruptedJournal, null, 2)}\n`, "utf8");
    const lockKey = crypto
      .createHash("sha256")
      .update(`${path.resolve(repo)}\0${target.branchName}`)
      .digest("hex");
    const lockPath = path.join(config.workspace.stateDir, "locks", `${lockKey}.lock`);
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(lockPath, `2147483647\n${new Date().toISOString()}\n`, "utf8");

    const recovered = await new WorkspaceManager({
      workspace: config.workspace,
      hooks: config.hooks,
      logger,
    }).createForIssue(target, { seed });

    expect(recovered.createdNow).toBe(false);
    expect(recovered.seed).toEqual(created.seed);
    expect(await seedCreationJournalFiles(config.workspace.stateDir)).toEqual([]);
  });

  it("refuses to adopt a journaled seeded worktree that advanced before metadata", async () => {
    const { seed, target } = await reusableSeedFixture(repo, "restart-advanced");
    const config = worktreeConfig(root, repo);
    const workspacePath = path.join(config.workspace.root, target.identifier);
    const logger = new StructuredLogger(() => undefined);
    await createGitWorktree({
      source: config.workspace.source,
      stateDir: config.workspace.stateDir,
      workspacePath,
      branchName: target.branchName!,
      seed,
      timeoutMs: config.hooks.timeoutMs,
      logger,
    });
    await writeFile(path.join(workspacePath, "unexpected.txt"), "unexpected\n", "utf8");
    await commitAll(workspacePath, "unexpected pre-metadata commit");

    await expect(
      new WorkspaceManager({
        workspace: config.workspace,
        hooks: config.hooks,
        logger,
      }).createForIssue(target, { seed }),
    ).rejects.toThrow(/advanced before workspace metadata was persisted/);
  });

  it("clears a journal left after workspace metadata was persisted", async () => {
    const { seed, target } = await reusableSeedFixture(repo, "restart-after-metadata");
    const config = worktreeConfig(root, repo);
    const workspacePath = path.join(config.workspace.root, target.identifier);
    const logger = new StructuredLogger(() => undefined);
    const created = await createGitWorktree({
      source: config.workspace.source,
      stateDir: config.workspace.stateDir,
      workspacePath,
      branchName: target.branchName!,
      seed,
      timeoutMs: config.hooks.timeoutMs,
      logger,
    });
    if (!created.seed) throw new Error("expected seeded worktree binding");
    const now = new Date().toISOString();
    await new FileRunTranscriptStore(config.workspace.stateDir).upsertWorkspace({
      workspaceKey: target.identifier,
      issueId: target.id,
      issueIdentifier: target.identifier,
      path: workspacePath,
      createdAt: now,
      updatedAt: now,
      sourceKind: "git_worktree",
      repoPath: created.repoPath,
      baseRef: created.baseRef,
      gitBranchName: created.branchName,
      seed: created.seed,
    });

    expect(await seedCreationJournalFiles(config.workspace.stateDir)).toHaveLength(1);
    await new WorkspaceManager({
      workspace: config.workspace,
      hooks: config.hooks,
      logger,
    }).createForIssue(target, { seed });

    expect(await seedCreationJournalFiles(config.workspace.stateDir)).toEqual([]);
  });

  it("rolls back a seeded branch and worktree when metadata persistence fails", async () => {
    const { seed, target } = await reusableSeedFixture(repo, "metadata-failure");
    const config = worktreeConfig(root, repo);
    const manager = new WorkspaceManager({
      workspace: config.workspace,
      hooks: config.hooks,
      logger: new StructuredLogger(() => undefined),
    });
    const persistence = vi
      .spyOn(FileRunTranscriptStore.prototype, "upsertWorkspace")
      .mockRejectedValueOnce(new Error("simulated metadata failure"));
    try {
      await expect(manager.createForIssue(target, { seed })).rejects.toThrow(
        /simulated metadata failure/,
      );
    } finally {
      persistence.mockRestore();
    }

    await expect(
      git(["show-ref", "--verify", `refs/heads/${target.branchName}`], repo),
    ).rejects.toThrow();
    await expect(readFile(path.join(config.workspace.root, target.identifier, ".git"), "utf8"))
      .rejects.toThrow();
    expect(await seedCreationJournalFiles(config.workspace.stateDir)).toEqual([]);

    const retried = await manager.createForIssue(target, { seed });
    expect(retried.seed?.artifactId).toBe(seed.artifactId);
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
  const config = worktreeConfig(root, repository, cleanup);
  return new WorkspaceManager({
    workspace: config.workspace,
    hooks: config.hooks,
    logger: new StructuredLogger(() => undefined),
    planningWorkspaceMode,
  });
}

function worktreeConfig(
  root: string,
  repository: string,
  cleanup: "refuse_dirty" | "force" = "refuse_dirty",
) {
  return parseServiceConfig(
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
}

async function reusableSeedFixture(repository: string, suffix: string) {
  const sourceBaseHeadSha = (await git(["rev-parse", "HEAD"], repository)).trim();
  const sourceBranch = `artifact/${suffix}`;
  const testFile = `${suffix}.test.ts`;
  await git(["checkout", "-b", sourceBranch], repository);
  await writeFile(path.join(repository, testFile), `${suffix} expected red\n`, "utf8");
  await commitAll(repository, `add ${suffix} artifact`);
  const sourceHeadSha = (await git(["rev-parse", "HEAD"], repository)).trim();
  const blobSha = (await git(["rev-parse", `HEAD:${testFile}`], repository)).trim();
  await git(["checkout", "main"], repository);
  await writeFile(path.join(repository, `${suffix}.base.txt`), "live base\n", "utf8");
  await commitAll(repository, `advance base for ${suffix}`);
  const identifier = `TEST-${suffix.toUpperCase()}`;
  return {
    target: issue({ identifier, branchName: `symphony/${identifier}` }),
    seed: artifactSeed(repository, {
      artifactId: `artifact-${suffix}`,
      sourceBranch,
      sourceBaseHeadSha,
      sourceHeadSha,
      fileManifest: [{ path: testFile, status: "added", blobSha }],
    }),
  };
}

async function seedCreationJournalFiles(stateDir: string): Promise<string[]> {
  try {
    return await readdir(path.join(stateDir, "seed-worktree-creations"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function initRepo(repository: string): Promise<void> {
  await mkdir(repository, { recursive: true });
  await git(["init"], repository);
  await git(["checkout", "-b", "main"], repository);
  await writeFile(path.join(repository, "README.md"), "hello\n", "utf8");
  await git(["add", "README.md"], repository);
  await git(["-c", "user.name=Symphony Test", "-c", "user.email=symphony@example.com", "commit", "-m", "initial"], repository);
}

function artifactSeed(
  repository: string,
  overrides: Partial<AcceptedArtifactWorkspaceSeed> &
    Pick<AcceptedArtifactWorkspaceSeed, "sourceHeadSha" | "sourceBaseHeadSha" | "fileManifest">,
): AcceptedArtifactWorkspaceSeed {
  return {
    version: 1,
    kind: "accepted_artifact",
    artifactId: "artifact-1",
    sourceIssueId: "source-issue-1",
    sourceIssueIdentifier: "TEST-ARTIFACT",
    repositoryFingerprint: workspaceRepositoryFingerprint(repository),
    sourceBranch: "artifact/TEST-ARTIFACT",
    configuredBaseRef: "main",
    ...overrides,
  };
}

async function commitAll(repository: string, message: string): Promise<void> {
  await git(["add", "-A"], repository);
  await git(
    [
      "-c",
      "user.name=Symphony Test",
      "-c",
      "user.email=symphony@example.com",
      "commit",
      "-m",
      message,
    ],
    repository,
  );
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

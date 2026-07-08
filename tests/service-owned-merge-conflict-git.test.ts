import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ServiceOwnedMergeConflictGit } from "../src/core/merge/ServiceOwnedMergeConflictGit.js";

describe("ServiceOwnedMergeConflictGit", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-service-merge-conflict-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("prepares a conflicted squash rebase and finalizes it with a force-with-lease push", async () => {
    const { workspace, featureHeadSha, liveBaseHeadSha, initialSha, branchName } = await conflictedRepo(root);
    const serviceGit = new ServiceOwnedMergeConflictGit();

    const prepared = await serviceGit.prepare({
      workspacePath: workspace,
      branchName,
      expectedHeadSha: featureHeadSha,
      baseBranch: "main",
      observedPrBaseHeadSha: initialSha,
      liveBaseHeadSha,
      authHeader: "AUTHORIZATION: bearer test-token",
    });

    expect(prepared).toMatchObject({
      status: "conflicted",
      originalHeadSha: featureHeadSha,
      observedPrBaseHeadSha: initialSha,
      liveBaseHeadSha,
      preparedBaseHeadSha: liveBaseHeadSha,
      mergeBaseSha: initialSha,
      conflictedFiles: ["file.txt"],
    });
    expect(prepared.squashCommitSha).toMatch(/^[0-9a-f]{40}$/);

    await writeFile(path.join(workspace, "file.txt"), "main\nfeature\n", "utf8");
    const finalized = await serviceGit.finalize({
      workspacePath: workspace,
      branchName,
      previousRemoteHeadSha: featureHeadSha,
      preparedBaseHeadSha: liveBaseHeadSha,
      baseBranch: "main",
      conflictedFiles: ["file.txt"],
      changedFiles: ["file.txt"],
      authHeader: "AUTHORIZATION: bearer test-token",
    });

    expect(finalized.newHeadSha).toMatch(/^[0-9a-f]{40}$/);
    expect(finalized.newHeadSha).not.toBe(featureHeadSha);
    expect((await readFile(path.join(workspace, "other.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("feature-only\n");
    expect((await git(["status", "--porcelain=v1", "-uall"], workspace)).trim()).toBe("");
    expect(await git(["rev-parse", "refs/heads/symphony/TEST-1"], path.join(root, "remote.git"))).toBe(
      `${finalized.newHeadSha}\n`,
    );
  });

  it("rejects unrelated worktree changes during service-owned finalization", async () => {
    const { workspace, featureHeadSha, liveBaseHeadSha, initialSha, branchName } = await conflictedRepo(root);
    const serviceGit = new ServiceOwnedMergeConflictGit();
    await serviceGit.prepare({
      workspacePath: workspace,
      branchName,
      expectedHeadSha: featureHeadSha,
      baseBranch: "main",
      observedPrBaseHeadSha: initialSha,
      liveBaseHeadSha,
      authHeader: "AUTHORIZATION: bearer test-token",
    });

    await writeFile(path.join(workspace, "file.txt"), "main\nfeature\n", "utf8");
    await writeFile(path.join(workspace, "unrelated.txt"), "not part of the conflict\n", "utf8");

    await expect(
      serviceGit.finalize({
        workspacePath: workspace,
        branchName,
        previousRemoteHeadSha: featureHeadSha,
        preparedBaseHeadSha: liveBaseHeadSha,
        baseBranch: "main",
        conflictedFiles: ["file.txt"],
        changedFiles: ["file.txt"],
        authHeader: "AUTHORIZATION: bearer test-token",
      }),
    ).rejects.toThrow(/outside the service-prepared conflict set/);
  });

  it("reports prepared base drift after finalizing and publishing the prepared repair", async () => {
    const { workspace, remote, featureHeadSha, liveBaseHeadSha, initialSha, branchName } = await conflictedRepo(root);
    const serviceGit = new ServiceOwnedMergeConflictGit();
    await serviceGit.prepare({
      workspacePath: workspace,
      branchName,
      expectedHeadSha: featureHeadSha,
      baseBranch: "main",
      observedPrBaseHeadSha: initialSha,
      liveBaseHeadSha,
      authHeader: "AUTHORIZATION: bearer test-token",
    });
    const updater = path.join(root, "updater");
    await git(["clone", remote, updater], root);
    await git(["checkout", "main"], updater);
    await writeFile(path.join(updater, "drift.txt"), "new base\n", "utf8");
    await git(["add", "drift.txt"], updater);
    await commit(updater, "base drift");
    await git(["push", "origin", "main"], updater);

    await writeFile(path.join(workspace, "file.txt"), "main\nfeature\n", "utf8");
    const finalized = await serviceGit.finalize({
      workspacePath: workspace,
      branchName,
      previousRemoteHeadSha: featureHeadSha,
      preparedBaseHeadSha: liveBaseHeadSha,
      baseBranch: "main",
      conflictedFiles: ["file.txt"],
      changedFiles: ["file.txt"],
      authHeader: "AUTHORIZATION: bearer test-token",
    });

    expect(finalized).toMatchObject({
      status: "prepared_base_ref_drift",
      newHeadSha: expect.stringMatching(/^[0-9a-f]{40}$/),
      expectedSha: liveBaseHeadSha,
      baseBranch: "main",
    });
    expect((await git(["status", "--porcelain=v1", "-uall"], workspace)).trim()).toBe("");
    expect(await git(["rev-parse", "refs/heads/symphony/TEST-1"], path.join(root, "remote.git"))).toBe(
      `${finalized.newHeadSha}\n`,
    );
  });

  it("preserves dirty worktree changes in a custom stash ref, reapplies them, and drops the ref", async () => {
    const { workspace, branchName } = await conflictedRepo(root);
    const serviceGit = new ServiceOwnedMergeConflictGit();
    await writeFile(path.join(workspace, "local.txt"), "local edits\n", "utf8");

    const stash = await serviceGit.preserveDirtyWorktree({
      workspacePath: workspace,
      branchName,
      baseBranch: "main",
      operationId: "base-ref:issue-1:head-sha:base-sha",
      source: "base_ref_repair",
    });

    expect(stash).toMatchObject({
      status: "created",
      dirtyFiles: ["local.txt"],
      branchName,
      baseBranch: "main",
    });
    expect((await git(["status", "--porcelain=v1", "-uall"], workspace)).trim()).toBe("");
    expect((await git(["rev-parse", stash!.stashRef], workspace)).trim()).toBe(stash!.stashSha);

    const applied = await serviceGit.applyPreservedStash({
      workspacePath: workspace,
      branchName,
      preservedStash: stash!,
    });

    expect(applied.status).toBe("clean");
    expect((await readFile(path.join(workspace, "local.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("local edits\n");
    const dropped = await serviceGit.dropPreservedStash({
      workspacePath: workspace,
      preservedStash: applied.stash,
    });
    expect(dropped.status).toBe("dropped");
    await expect(git(["rev-parse", stash!.stashRef], workspace)).rejects.toThrow(/git exited/);
  });

  it("refreshes a local-only branch to the live base without fetching the issue branch", async () => {
    const { workspace, branchName, initialSha, liveBaseHeadSha } = await localOnlyBehindRepo(root);
    const serviceGit = new ServiceOwnedMergeConflictGit();

    const result = await serviceGit.refreshLocalBranchBase({
      workspacePath: workspace,
      branchName,
      expectedHeadSha: initialSha,
      baseBranch: "main",
      liveBaseHeadSha,
      authHeader: "AUTHORIZATION: bearer test-token",
    });

    expect(result).toMatchObject({
      status: "refreshed",
      originalHeadSha: initialSha,
      liveBaseHeadSha,
      refreshedHeadSha: liveBaseHeadSha,
      aheadCommitCount: 0,
    });
    expect((await git(["rev-parse", "HEAD"], workspace)).trim()).toBe(liveBaseHeadSha);
    await expect(
      git(["rev-parse", `refs/remotes/origin/${branchName}`], workspace),
    ).rejects.toThrow(/git exited/);
  });
});

async function conflictedRepo(root: string): Promise<{
  remote: string;
  workspace: string;
  branchName: string;
  initialSha: string;
  featureHeadSha: string;
  liveBaseHeadSha: string;
}> {
  const remote = path.join(root, "remote.git");
  const workspace = path.join(root, "workspace");
  const branchName = "symphony/TEST-1";
  await git(["init", "--bare", remote], root);
  await mkdir(workspace, { recursive: true });
  await git(["init"], workspace);
  await git(["checkout", "-b", "main"], workspace);
  await writeFile(path.join(workspace, "file.txt"), "base\n", "utf8");
  await writeFile(path.join(workspace, "other.txt"), "base-other\n", "utf8");
  await git(["add", "file.txt", "other.txt"], workspace);
  await commit(workspace, "initial");
  const initialSha = (await git(["rev-parse", "HEAD"], workspace)).trim();
  await git(["remote", "add", "origin", remote], workspace);
  await git(["push", "-u", "origin", "main"], workspace);

  await git(["checkout", "-b", branchName], workspace);
  await writeFile(path.join(workspace, "file.txt"), "feature\n", "utf8");
  await writeFile(path.join(workspace, "other.txt"), "feature-only\n", "utf8");
  await git(["add", "file.txt", "other.txt"], workspace);
  await commit(workspace, "feature");
  const featureHeadSha = (await git(["rev-parse", "HEAD"], workspace)).trim();
  await git(["push", "-u", "origin", branchName], workspace);

  await git(["checkout", "main"], workspace);
  await writeFile(path.join(workspace, "file.txt"), "main\n", "utf8");
  await git(["add", "file.txt"], workspace);
  await commit(workspace, "main");
  const liveBaseHeadSha = (await git(["rev-parse", "HEAD"], workspace)).trim();
  await git(["push", "origin", "main"], workspace);
  await git(["checkout", branchName], workspace);

  return { remote, workspace, branchName, initialSha, featureHeadSha, liveBaseHeadSha };
}

async function localOnlyBehindRepo(root: string): Promise<{
  remote: string;
  workspace: string;
  branchName: string;
  initialSha: string;
  liveBaseHeadSha: string;
}> {
  const remote = path.join(root, "remote.git");
  const workspace = path.join(root, "workspace");
  const updater = path.join(root, "updater");
  const branchName = "symphony/TEST-LOCAL";
  await git(["init", "--bare", remote], root);
  await mkdir(workspace, { recursive: true });
  await git(["init"], workspace);
  await git(["checkout", "-b", "main"], workspace);
  await writeFile(path.join(workspace, "file.txt"), "base\n", "utf8");
  await git(["add", "file.txt"], workspace);
  await commit(workspace, "initial");
  const initialSha = (await git(["rev-parse", "HEAD"], workspace)).trim();
  await git(["remote", "add", "origin", remote], workspace);
  await git(["push", "-u", "origin", "main"], workspace);
  await git(["checkout", "-b", branchName], workspace);

  await git(["clone", remote, updater], root);
  await git(["checkout", "main"], updater);
  await writeFile(path.join(updater, "file.txt"), "base\nnew base\n", "utf8");
  await git(["add", "file.txt"], updater);
  await commit(updater, "advance base");
  const liveBaseHeadSha = (await git(["rev-parse", "HEAD"], updater)).trim();
  await git(["push", "origin", "main"], updater);

  return { remote, workspace, branchName, initialSha, liveBaseHeadSha };
}

function commit(cwd: string, message: string): Promise<string> {
  return git(["-c", "user.name=Symphony Test", "-c", "user.email=symphony@example.com", "commit", "-m", message], cwd);
}

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
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

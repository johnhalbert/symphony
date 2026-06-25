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

  it("reports prepared base drift through shared local base verification", async () => {
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
    ).rejects.toMatchObject({
      code: "conflict",
      details: {
        kind: "prepared_base_ref_drift",
        expectedSha: liveBaseHeadSha,
        baseBranch: "main",
      },
    });
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

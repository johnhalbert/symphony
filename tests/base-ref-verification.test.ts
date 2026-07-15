import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BaseRefVerifier,
  baseRefObservationIsTransient,
  runBaseRefCommand,
  type BaseRefGitHubClient,
} from "../src/core/BaseRefVerification.js";

describe("BaseRefVerifier", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-base-ref-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("refreshes a stale local origin base before allowing a based worktree", async () => {
    const repo = await createRepo();
    const initialOriginMain = await git(["rev-parse", "refs/remotes/origin/main"], repo.workspace);
    await updateMainFromWorkspace(repo, "remote-main");
    await git(["checkout", "feature"], repo.workspace);
    await git(["rebase", "main"], repo.workspace);
    await git(["update-ref", "refs/remotes/origin/main", initialOriginMain], repo.workspace);

    const beforeFetch = await git(["rev-parse", "refs/remotes/origin/main"], repo.workspace);
    const githubBase = await git(["rev-parse", "main"], repo.workspace);
    expect(beforeFetch).not.toBe(githubBase);

    const observation = await new BaseRefVerifier().verify({
      workspacePath: repo.workspace,
      branchName: "feature",
      baseRef: "origin/main",
      operation: "dispatch_worker",
      client: clientFor(repo.workspace, "main"),
    });

    expect(observation).toMatchObject({
      classification: "ok",
      normalizedBaseBranch: "main",
      localBaseHeadShaBeforeFetch: beforeFetch,
      localBaseHeadShaAfterFetch: githubBase,
      githubBaseHeadSha: githubBase,
      localBaseIsAncestorOfHead: true,
    });
  });

  it("classifies a branch that is not based on the live origin base", async () => {
    const repo = await createRepo();
    await updateMainFromWorkspace(repo, "remote-main");
    await git(["checkout", "feature"], repo.workspace);

    const githubBase = await git(["rev-parse", "main"], repo.workspace);
    const observation = await new BaseRefVerifier().verify({
      workspacePath: repo.workspace,
      branchName: "feature",
      baseRef: "main",
      operation: "dispatch_worker",
      client: clientFor(repo.workspace, "main"),
    });

    expect(observation).toMatchObject({
      classification: "branch_not_based_on_live_base",
      githubBaseHeadSha: githubBase,
      localBaseHeadShaAfterFetch: githubBase,
      localBaseIsAncestorOfHead: false,
    });
  });

  it("classifies local base mismatch when GitHub reports a different base SHA", async () => {
    const repo = await createRepo();
    const bogusSha = "0123456789012345678901234567890123456789";

    const observation = await new BaseRefVerifier().verify({
      workspacePath: repo.workspace,
      branchName: "feature",
      baseRef: "main",
      operation: "dispatch_worker",
      client: {
        ...clientFor(repo.workspace, "main"),
        getBranchHeadSha: async () => bogusSha,
      },
    });

    expect(observation).toMatchObject({
      classification: "local_base_mismatch",
      githubBaseHeadSha: bogusSha,
    });
    expect(observation.localBaseHeadShaAfterFetch).not.toBe(bogusSha);
  });

  it("waits for inherited stdout pipes to close before resolving a command", async () => {
    const delayedWriter = `setTimeout(() => process.stdout.write("late-output"), 25);`;
    const parent = [
      `const { spawn } = require("node:child_process");`,
      `const child = spawn(${JSON.stringify(process.execPath)}, ["-e", ${JSON.stringify(delayedWriter)}], { detached: true, stdio: ["ignore", "inherit", "inherit"] });`,
      "child.unref();",
    ].join("\n");

    const result = await runBaseRefCommand(
      process.execPath,
      ["-e", parent],
      root,
      2_000,
      {},
    );

    expect(result).toMatchObject({ code: 0, stdout: "late-output" });
  });

  it("distinguishes transient remote failures from missing local metadata", () => {
    const remoteFailure = {
      version: 1 as const,
      inputFingerprint: "remote",
      classification: "base_ref_unavailable" as const,
      operation: "dispatch_worker",
      checkedAt: "2026-01-01T00:00:00.000Z",
      workspacePath: "/tmp/workspace",
      branchName: "feature",
      baseRef: "origin/main",
      normalizedBaseBranch: "main",
      localBaseRef: "refs/remotes/origin/main",
      githubBaseHeadSha: null,
      localBaseHeadShaBeforeFetch: "abc",
      localBaseHeadShaAfterFetch: null,
      worktreeHeadSha: null,
      localBaseIsAncestorOfHead: null,
      reason: "Unable to resolve GitHub live base ref",
      error: "fetch failed",
    };

    expect(baseRefObservationIsTransient(remoteFailure)).toBe(true);
    expect(
      baseRefObservationIsTransient({
        ...remoteFailure,
        inputFingerprint: "metadata",
        reason: "Base ref verification requires a workspace path, branch, and base ref",
        error: null,
      }),
    ).toBe(false);
  });

  async function createRepo(): Promise<{ workspace: string; remote: string }> {
    const remote = path.join(root, "remote.git");
    const workspace = path.join(root, "workspace");
    await git(["init", "--bare", remote], root);
    await git(["init", workspace], root);
    await git(["checkout", "-b", "main"], workspace);
    await writeFile(path.join(workspace, "README.md"), "initial\n", "utf8");
    await git(["add", "README.md"], workspace);
    await commit("initial", workspace);
    await git(["remote", "add", "origin", remote], workspace);
    await git(["push", "-u", "origin", "main"], workspace);
    await git(["checkout", "-b", "feature"], workspace);
    await writeFile(path.join(workspace, "feature.txt"), "feature\n", "utf8");
    await git(["add", "feature.txt"], workspace);
    await commit("feature", workspace);
    return { workspace, remote };
  }

  async function updateMainFromWorkspace(
    repo: { workspace: string },
    content: string,
  ): Promise<void> {
    await git(["checkout", "main"], repo.workspace);
    await writeFile(path.join(repo.workspace, "README.md"), `${content}\n`, "utf8");
    await git(["add", "README.md"], repo.workspace);
    await commit(content, repo.workspace);
    await git(["push", "origin", "main"], repo.workspace);
  }
});

function clientFor(workspace: string, branchName: string): BaseRefGitHubClient {
  return {
    getBranchHeadSha: async () => git(["rev-parse", branchName], workspace),
    gitAuthHeader: async () => "AUTHORIZATION: bearer test-token",
  };
}

function commit(message: string, cwd: string): Promise<string> {
  return git([
    "-c",
    "user.name=Symphony Test",
    "-c",
    "user.email=symphony@example.com",
    "commit",
    "-m",
    message,
  ], cwd);
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
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`git ${args.join(" ")} failed: ${stderr}`));
      }
    });
  });
}

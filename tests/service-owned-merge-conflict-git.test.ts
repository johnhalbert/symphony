import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ServiceOwnedMergeConflictGit,
  type ServiceOwnedMergeConflictGitMutation,
} from "../src/core/merge/ServiceOwnedMergeConflictGit.js";

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
    const serviceGit = serviceGitFor(root);

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

    const resumed = await serviceGit.finalize({
      workspacePath: workspace,
      branchName,
      previousRemoteHeadSha: featureHeadSha,
      preparedBaseHeadSha: liveBaseHeadSha,
      baseBranch: "main",
      conflictedFiles: ["file.txt"],
      changedFiles: ["file.txt"],
      authHeader: "AUTHORIZATION: bearer test-token",
    });
    expect(resumed).toEqual(finalized);
  });

  it("rejects unrelated worktree changes during service-owned finalization", async () => {
    const { workspace, featureHeadSha, liveBaseHeadSha, initialSha, branchName } = await conflictedRepo(root);
    const serviceGit = serviceGitFor(root);
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

  it("recovers a conflicted preparation when the process dies before recording the rebase result", async () => {
    const { workspace, featureHeadSha, liveBaseHeadSha, initialSha, branchName } =
      await conflictedRepo(root);
    const input = {
      workspacePath: workspace,
      branchName,
      expectedHeadSha: featureHeadSha,
      baseBranch: "main",
      observedPrBaseHeadSha: initialSha,
      liveBaseHeadSha,
      authHeader: "AUTHORIZATION: bearer test-token",
    };
    const crashing = serviceGitFor(root, (mutation) => {
      if (mutation === "prepare_rebase") throw new Error("simulated SIGKILL");
    });

    await expect(crashing.prepare(input)).rejects.toThrow(/simulated SIGKILL/);

    await expect(serviceGitFor(root).prepare(input)).resolves.toMatchObject({
      status: "conflicted",
      originalHeadSha: featureHeadSha,
      liveBaseHeadSha,
      conflictedFiles: ["file.txt"],
    });
  });

  it("recovers finalization when the process dies after rebase completion but before the finalized journal write", async () => {
    const { workspace, featureHeadSha, liveBaseHeadSha, initialSha, branchName } =
      await conflictedRepo(root);
    await serviceGitFor(root).prepare({
      workspacePath: workspace,
      branchName,
      expectedHeadSha: featureHeadSha,
      baseBranch: "main",
      observedPrBaseHeadSha: initialSha,
      liveBaseHeadSha,
      authHeader: "AUTHORIZATION: bearer test-token",
    });
    await writeFile(path.join(workspace, "file.txt"), "main\nfeature\n", "utf8");
    const input = {
      workspacePath: workspace,
      branchName,
      previousRemoteHeadSha: featureHeadSha,
      preparedBaseHeadSha: liveBaseHeadSha,
      baseBranch: "main",
      conflictedFiles: ["file.txt"],
      changedFiles: ["file.txt"],
      authHeader: "AUTHORIZATION: bearer test-token",
    };
    const crashing = serviceGitFor(root, (mutation) => {
      if (mutation === "finalize_rebase") throw new Error("simulated SIGKILL");
    });

    await expect(crashing.finalize(input)).rejects.toThrow(/simulated SIGKILL/);
    const finalized = await serviceGitFor(root).finalize(input);

    expect(finalized.newHeadSha).toMatch(/^[0-9a-f]{40}$/);
    expect((await git(["status", "--porcelain=v1", "-uall"], workspace)).trim()).toBe("");
    expect(
      (await git(["rev-parse", `refs/heads/${branchName}`], path.join(root, "remote.git"))).trim(),
    ).toBe(finalized.newHeadSha);
  });

  it("ignores a forged legacy Git checkpoint ref and rejects an unjournaled head", async () => {
    const { workspace, featureHeadSha, liveBaseHeadSha, initialSha, branchName } =
      await conflictedRepo(root);
    const serviceGit = serviceGitFor(root);
    await serviceGit.prepare({
      workspacePath: workspace,
      branchName,
      expectedHeadSha: featureHeadSha,
      baseBranch: "main",
      observedPrBaseHeadSha: initialSha,
      liveBaseHeadSha,
      authHeader: "AUTHORIZATION: bearer test-token",
    });
    await git(["rebase", "--abort"], workspace);
    await git(["reset", "--hard", liveBaseHeadSha], workspace);
    await writeFile(path.join(workspace, "owned.txt"), "outside repair scope\n", "utf8");
    await git(["add", "owned.txt"], workspace);
    await commit(workspace, "forged repair");
    const forgedHeadSha = (await git(["rev-parse", "HEAD"], workspace)).trim();
    const digest = createHash("sha256")
      .update(JSON.stringify([branchName, featureHeadSha, liveBaseHeadSha]))
      .digest("hex");
    await git(
      [
        "update-ref",
        `refs/symphony/service-checkpoints/finalize/${digest}`,
        forgedHeadSha,
      ],
      workspace,
    );

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
    ).rejects.toThrow(/does not match prepared base/);
    expect(
      (await git(["rev-parse", `refs/heads/${branchName}`], path.join(root, "remote.git"))).trim(),
    ).toBe(featureHeadSha);
  });

  it("resumes a checkpointed clean preparation before or after publication", async () => {
    const { workspace, featureHeadSha, liveBaseHeadSha, initialSha, branchName } =
      await cleanRepo(root);
    const serviceGit = serviceGitFor(root);
    const input = {
      workspacePath: workspace,
      branchName,
      expectedHeadSha: featureHeadSha,
      baseBranch: "main",
      observedPrBaseHeadSha: initialSha,
      liveBaseHeadSha,
      authHeader: "AUTHORIZATION: bearer test-token",
    };

    const prepared = await serviceGit.prepare(input);
    expect(prepared).toMatchObject({ status: "clean" });
    if (prepared.status !== "clean") throw new Error("expected clean preparation");

    await expect(serviceGit.prepare(input)).resolves.toMatchObject({
      status: "clean",
      rebasedHeadSha: prepared.rebasedHeadSha,
    });
    await serviceGit.publishPreparedHead({
      workspacePath: workspace,
      branchName,
      previousRemoteHeadSha: featureHeadSha,
      authHeader: "AUTHORIZATION: bearer test-token",
    });
    await expect(
      serviceGit.publishPreparedHead({
        workspacePath: workspace,
        branchName,
        previousRemoteHeadSha: featureHeadSha,
        authHeader: "AUTHORIZATION: bearer test-token",
      }),
    ).resolves.toBeUndefined();
    await expect(serviceGit.prepare(input)).resolves.toMatchObject({
      status: "clean",
      rebasedHeadSha: prepared.rebasedHeadSha,
    });
  });

  it("recomputes an unfinished clean preparation and resumes publication after a post-push crash", async () => {
    const { workspace, featureHeadSha, liveBaseHeadSha, initialSha, branchName } =
      await cleanRepo(root);
    const input = {
      workspacePath: workspace,
      branchName,
      expectedHeadSha: featureHeadSha,
      baseBranch: "main",
      observedPrBaseHeadSha: initialSha,
      liveBaseHeadSha,
      authHeader: "AUTHORIZATION: bearer test-token",
    };
    const crashingPreparation = serviceGitFor(root, (mutation) => {
      if (mutation === "prepare_rebase") throw new Error("simulated SIGKILL");
    });
    await expect(crashingPreparation.prepare(input)).rejects.toThrow(/simulated SIGKILL/);

    const prepared = await serviceGitFor(root).prepare(input);
    expect(prepared).toMatchObject({ status: "clean" });
    if (prepared.status !== "clean") throw new Error("expected clean preparation");

    const publishInput = {
      workspacePath: workspace,
      branchName,
      previousRemoteHeadSha: featureHeadSha,
      authHeader: "AUTHORIZATION: bearer test-token",
    };
    const crashingPublication = serviceGitFor(root, (mutation) => {
      if (mutation === "publish_prepared_head") throw new Error("simulated SIGKILL");
    });
    await expect(
      crashingPublication.publishPreparedHead(publishInput),
    ).rejects.toThrow(/simulated SIGKILL/);
    await expect(
      serviceGitFor(root).publishPreparedHead(publishInput),
    ).resolves.toBeUndefined();
    expect(
      (await git(["rev-parse", `refs/heads/${branchName}`], path.join(root, "remote.git"))).trim(),
    ).toBe(prepared.rebasedHeadSha);
    await expect(serviceGitFor(root).prepare(input)).resolves.toMatchObject({
      status: "clean",
      rebasedHeadSha: prepared.rebasedHeadSha,
    });
  });

  it("reports prepared base drift after finalizing and publishing the prepared repair", async () => {
    const { workspace, remote, featureHeadSha, liveBaseHeadSha, initialSha, branchName } = await conflictedRepo(root);
    const serviceGit = serviceGitFor(root);
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
    const serviceGit = serviceGitFor(root);
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

  it("recovers preservation and clean application without pushing or applying the stash twice", async () => {
    const { workspace, branchName } = await conflictedRepo(root);
    const journalDir = path.join(root, "state", "service-git-journal");
    await mkdir(journalDir, { recursive: true });
    await chmod(journalDir, 0o777);
    await writeFile(path.join(workspace, "local.txt"), "local edits\n", "utf8");
    const preserveInput = {
      workspacePath: workspace,
      branchName,
      baseBranch: "main",
      operationId: "base-ref:issue-1:preserve-crash",
      source: "base_ref_repair" as const,
    };
    const crashingPreserve = serviceGitFor(root, (mutation) => {
      if (mutation === "preserve_stash") throw new Error("simulated SIGKILL");
    });

    await expect(
      crashingPreserve.preserveDirtyWorktree(preserveInput),
    ).rejects.toThrow(/simulated SIGKILL/);
    const stash = await serviceGitFor(root).preserveDirtyWorktree(preserveInput);
    if (stash === null) throw new Error("expected recovered stash");
    expect((await git(["stash", "list"], workspace)).trim()).toBe("");
    expect((await git(["rev-parse", stash.stashRef], workspace)).trim()).toBe(
      stash.stashSha,
    );
    expect((await stat(journalDir)).mode & 0o777).toBe(0o700);
    const journalFiles = (await readdir(journalDir)).filter((entry) =>
      entry.endsWith(".json"),
    );
    expect(journalFiles.length).toBeGreaterThan(0);
    for (const journalFile of journalFiles) {
      expect((await stat(path.join(journalDir, journalFile))).mode & 0o777).toBe(
        0o600,
      );
    }

    const applyInput = {
      workspacePath: workspace,
      branchName,
      preservedStash: stash,
    };
    const crashingApply = serviceGitFor(root, (mutation) => {
      if (mutation === "apply_stash") throw new Error("simulated SIGKILL");
    });
    await expect(crashingApply.applyPreservedStash(applyInput)).rejects.toThrow(
      /simulated SIGKILL/,
    );
    const applied = await serviceGitFor(root).applyPreservedStash(applyInput);

    expect(applied.status).toBe("clean");
    expect(await readFile(path.join(workspace, "local.txt"), "utf8")).toBe(
      "local edits\n",
    );
    const dropped = await serviceGitFor(root).dropPreservedStash({
      workspacePath: workspace,
      preservedStash: applied.stash,
    });
    expect(dropped.status).toBe("dropped");
    await expect(
      serviceGitFor(root).dropPreservedStash({
        workspacePath: workspace,
        preservedStash: dropped,
      }),
    ).resolves.toMatchObject({ status: "dropped", dropError: null });
  });

  it("rejects unrelated worktree files injected before an in-progress stash application replay", async () => {
    const { workspace, branchName } = await conflictedRepo(root);
    const serviceGit = serviceGitFor(root);
    await writeFile(path.join(workspace, "local.txt"), "local edits\n", "utf8");
    const stash = await serviceGit.preserveDirtyWorktree({
      workspacePath: workspace,
      branchName,
      baseBranch: "main",
      operationId: "base-ref:issue-1:apply-scope",
      source: "base_ref_repair",
    });
    if (stash === null) throw new Error("expected preserved stash");
    const applyInput = {
      workspacePath: workspace,
      branchName,
      preservedStash: stash,
    };
    const crashingApply = serviceGitFor(root, (mutation) => {
      if (mutation === "apply_stash") throw new Error("simulated SIGKILL");
    });
    await expect(crashingApply.applyPreservedStash(applyInput)).rejects.toThrow(
      /simulated SIGKILL/,
    );
    await writeFile(path.join(workspace, "unrelated.txt"), "forged\n", "utf8");

    await expect(
      serviceGitFor(root).applyPreservedStash(applyInput),
    ).rejects.toThrow(/outside the preserved stash set: unrelated.txt/);
  });

  it("refreshes a local-only branch to the live base without fetching the issue branch", async () => {
    const { workspace, branchName, initialSha, liveBaseHeadSha } = await localOnlyBehindRepo(root);
    const serviceGit = serviceGitFor(root);

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

    await expect(
      serviceGit.refreshLocalBranchBase({
        workspacePath: workspace,
        branchName,
        expectedHeadSha: initialSha,
        baseBranch: "main",
        liveBaseHeadSha,
        authHeader: "AUTHORIZATION: bearer test-token",
      }),
    ).resolves.toEqual(result);
  });

  it("recovers a local-only refresh when the process dies after reset but before finalization", async () => {
    const { workspace, branchName, initialSha, liveBaseHeadSha } =
      await localOnlyBehindRepo(root);
    const input = {
      workspacePath: workspace,
      branchName,
      expectedHeadSha: initialSha,
      baseBranch: "main",
      liveBaseHeadSha,
      authHeader: "AUTHORIZATION: bearer test-token",
    };
    const crashing = serviceGitFor(root, (mutation) => {
      if (mutation === "local_refresh_reset") throw new Error("simulated SIGKILL");
    });

    await expect(crashing.refreshLocalBranchBase(input)).rejects.toThrow(/simulated SIGKILL/);
    await expect(serviceGitFor(root).refreshLocalBranchBase(input)).resolves.toMatchObject({
      status: "refreshed",
      originalHeadSha: initialSha,
      refreshedHeadSha: liveBaseHeadSha,
    });
  });

  it("recovers stash finalization from its exact journaled tree after a post-commit crash", async () => {
    const { workspace, branchName, initialSha, liveBaseHeadSha } =
      await localOnlyBehindRepo(root);
    const serviceGit = serviceGitFor(root);
    await writeFile(path.join(workspace, "file.txt"), "local edit\n", "utf8");
    const stash = await serviceGit.preserveDirtyWorktree({
      workspacePath: workspace,
      branchName,
      baseBranch: "main",
      operationId: "base-ref:issue-1:stash-replay",
      source: "base_ref_repair",
    });
    if (stash === null) throw new Error("expected preserved stash");
    await serviceGit.refreshLocalBranchBase({
      workspacePath: workspace,
      branchName,
      expectedHeadSha: initialSha,
      baseBranch: "main",
      liveBaseHeadSha,
      authHeader: "AUTHORIZATION: bearer test-token",
    });
    const applyInput = {
      workspacePath: workspace,
      branchName,
      preservedStash: stash,
    };
    const crashingApply = serviceGitFor(root, (mutation) => {
      if (mutation === "apply_stash") throw new Error("simulated SIGKILL");
    });
    await expect(crashingApply.applyPreservedStash(applyInput)).rejects.toThrow(
      /simulated SIGKILL/,
    );
    const applied = await serviceGitFor(root).applyPreservedStash(applyInput);
    expect(applied.status).toBe("conflicted");
    if (applied.status !== "conflicted") throw new Error("expected stash conflict");
    await writeFile(
      path.join(workspace, "file.txt"),
      "base\nnew base\nlocal edit\n",
      "utf8",
    );
    const input = {
      workspacePath: workspace,
      branchName,
      previousRemoteHeadSha: liveBaseHeadSha,
      allowedFiles: ["file.txt"],
      conflictedFiles: ["file.txt"],
      changedFiles: ["file.txt"],
      preservedStash: applied.stash,
      authHeader: "AUTHORIZATION: bearer test-token",
      remoteBacked: false,
    };
    const crashing = serviceGitFor(root, (mutation) => {
      if (mutation === "finalize_stash_apply") throw new Error("simulated SIGKILL");
    });

    await expect(crashing.finalizeStashApply(input)).rejects.toThrow(/simulated SIGKILL/);
    const finalized = await serviceGitFor(root).finalizeStashApply(input);

    expect(finalized.newHeadSha).toMatch(/^[0-9a-f]{40}$/);
    expect(finalized.preservedStash.status).toBe("dropped");
    expect((await git(["rev-parse", `${finalized.newHeadSha}^`], workspace)).trim()).toBe(
      liveBaseHeadSha,
    );
    expect(await readFile(path.join(workspace, "file.txt"), "utf8")).toBe(
      "base\nnew base\nlocal edit\n",
    );
  });
});

function serviceGitFor(
  root: string,
  afterMutation?: (
    mutation: ServiceOwnedMergeConflictGitMutation,
  ) => void | Promise<void>,
): ServiceOwnedMergeConflictGit {
  return new ServiceOwnedMergeConflictGit({
    journalDir: path.join(root, "state"),
    ...(afterMutation === undefined ? {} : { afterMutation }),
  });
}

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

async function cleanRepo(root: string): Promise<{
  workspace: string;
  branchName: string;
  initialSha: string;
  featureHeadSha: string;
  liveBaseHeadSha: string;
}> {
  const remote = path.join(root, "remote.git");
  const workspace = path.join(root, "workspace");
  const branchName = "symphony/TEST-CLEAN";
  await git(["init", "--bare", remote], root);
  await mkdir(workspace, { recursive: true });
  await git(["init"], workspace);
  await git(["checkout", "-b", "main"], workspace);
  await writeFile(path.join(workspace, "base.txt"), "base\n", "utf8");
  await git(["add", "base.txt"], workspace);
  await commit(workspace, "initial");
  const initialSha = (await git(["rev-parse", "HEAD"], workspace)).trim();
  await git(["remote", "add", "origin", remote], workspace);
  await git(["push", "-u", "origin", "main"], workspace);
  await git(["checkout", "-b", branchName], workspace);
  await writeFile(path.join(workspace, "feature.txt"), "feature\n", "utf8");
  await git(["add", "feature.txt"], workspace);
  await commit(workspace, "feature");
  const featureHeadSha = (await git(["rev-parse", "HEAD"], workspace)).trim();
  await git(["push", "-u", "origin", branchName], workspace);
  await git(["checkout", "main"], workspace);
  await writeFile(path.join(workspace, "base.txt"), "base\nadvanced\n", "utf8");
  await git(["add", "base.txt"], workspace);
  await commit(workspace, "advance base");
  const liveBaseHeadSha = (await git(["rev-parse", "HEAD"], workspace)).trim();
  await git(["push", "origin", "main"], workspace);
  await git(["checkout", branchName], workspace);
  return { workspace, branchName, initialSha, featureHeadSha, liveBaseHeadSha };
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

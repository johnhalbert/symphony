import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import { WorkspaceManager, assertPathInsideRoot, sanitizeWorkspaceKey } from "../src/core/workspace/WorkspaceManager.js";
import type { AcceptedArtifactWorkspaceSeed } from "../src/core/types.js";
import { issue, testConfig } from "./helpers.js";

describe("WorkspaceManager", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-workspace-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("sanitizes issue identifiers and writes metadata", async () => {
    const config = testConfig(root);
    const manager = new WorkspaceManager({
      workspace: config.workspace,
      hooks: config.hooks,
      logger: new StructuredLogger(() => undefined),
    });

    const workspace = await manager.createForIssue(issue({ id: "abc-123", identifier: "ABC/123" }));
    const metadata = JSON.parse(
      await readFile(path.join(config.workspace.stateDir, "workspaces", "ABC_123.json"), "utf8"),
    );

    expect(workspace.workspaceKey).toBe("ABC_123");
    expect(workspace.issueId).toBe("abc-123");
    expect(metadata.issueIdentifier).toBe("ABC/123");
    expect(metadata.issueId).toBe("abc-123");
  });

  it("rejects paths outside the workspace root", () => {
    expect(() => assertPathInsideRoot(path.dirname(root), root)).toThrow();
    expect(sanitizeWorkspaceKey("A B")).toBe("A_B");
  });

  it("rejects symlinked workspaces that escape the root", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "symphony-outside-"));
    try {
      const escapedWorkspace = path.join(root, "ESCAPE-1");
      await mkdir(outside, { recursive: true });
      await symlink(outside, escapedWorkspace, process.platform === "win32" ? "junction" : "dir");
      const config = testConfig(root);
      const manager = new WorkspaceManager({
        workspace: config.workspace,
        hooks: config.hooks,
        logger: new StructuredLogger(() => undefined),
      });

      await expect(manager.createForIssue(issue({ identifier: "ESCAPE-1" }))).rejects.toThrow();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects accepted-artifact seeds for non-worktree workspace sources", async () => {
    const config = testConfig(root);
    const manager = new WorkspaceManager({
      workspace: config.workspace,
      hooks: config.hooks,
      logger: new StructuredLogger(() => undefined),
    });
    const seed: AcceptedArtifactWorkspaceSeed = {
      version: 1,
      kind: "accepted_artifact",
      artifactId: "artifact-1",
      sourceIssueId: "source-1",
      sourceIssueIdentifier: "TEST-SOURCE",
      repositoryFingerprint: "sha256:unused",
      sourceBranch: "artifact/TEST-SOURCE",
      sourceHeadSha: "a".repeat(40),
      sourceBaseHeadSha: "b".repeat(40),
      configuredBaseRef: "main",
      fileManifest: [
        { path: "tests/expected-red.test.ts", status: "added", blobSha: "c".repeat(40) },
      ],
    };

    await expect(
      manager.createForIssue(issue({ identifier: "TEST-SEED-NONE" }), { seed }),
    ).rejects.toThrow(/require workspace\.source\.kind git_worktree/);
  });
});

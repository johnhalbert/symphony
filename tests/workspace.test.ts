import { mkdir, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import { WorkspaceManager, assertPathInsideRoot, sanitizeWorkspaceKey } from "../src/core/workspace/WorkspaceManager.js";
import { issue, testConfig, trackerIssue } from "./helpers.js";

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

  it("scopes duplicate identifier workspaces by resolved project context and persists contextual metadata", async () => {
    const config = testConfig(root);
    const manager = new WorkspaceManager({
      workspace: config.workspace,
      hooks: config.hooks,
      logger: new StructuredLogger(() => undefined),
    });
    const docsIssue = trackerIssue({
      id: "issue-docs-1",
      identifier: "ENG-123",
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      branchName: null,
    });
    const platformIssue = trackerIssue({
      id: "issue-platform-1",
      identifier: "ENG-123",
      projectContextId: "platform",
      projectContextLabel: "Platform Services",
      branchName: null,
    });

    const docsWorkspace = await manager.createForIssue(docsIssue);
    const platformWorkspace = await manager.createForIssue(platformIssue);
    const docsMetadata = JSON.parse(
      await readFile(path.join(config.workspace.stateDir, "workspaces", "docs__ENG-123.json"), "utf8"),
    ) as { projectContext?: { projectContextId?: string } };
    const platformMetadata = JSON.parse(
      await readFile(path.join(config.workspace.stateDir, "workspaces", "platform__ENG-123.json"), "utf8"),
    ) as { projectContext?: { projectContextId?: string } };

    expect(docsWorkspace.workspaceKey).toBe("docs__ENG-123");
    expect(platformWorkspace.workspaceKey).toBe("platform__ENG-123");
    expect(docsWorkspace.path).toBe(path.join(config.workspace.root, "docs__ENG-123"));
    expect(platformWorkspace.path).toBe(path.join(config.workspace.root, "platform__ENG-123"));
    expect(docsWorkspace.path).not.toBe(platformWorkspace.path);
    expect(manager.getPathForIssue(docsIssue)).toBe(docsWorkspace.path);
    expect(manager.getPathForIssue(platformIssue)).toBe(platformWorkspace.path);
    expect(docsMetadata.projectContext?.projectContextId).toBe("docs");
    expect(platformMetadata.projectContext?.projectContextId).toBe("platform");
  });

  it("preserves legacy reserved-prefix workspaces by allocating an exact-id fallback and only removing the new contextual sibling", async () => {
    const config = testConfig(root);
    const manager = new WorkspaceManager({
      workspace: config.workspace,
      hooks: config.hooks,
      logger: new StructuredLogger(() => undefined),
    });
    const legacyIssue = issue({ id: "legacy-docs-prefix-1", identifier: "docs__ENG-123" });
    const docsIssue = trackerIssue({
      id: "issue-docs-collision-1",
      identifier: "ENG-123",
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      branchName: null,
    });

    const legacyWorkspace = await manager.createForIssue(legacyIssue);
    const legacyMetadataPath = path.join(config.workspace.stateDir, "workspaces", "docs__ENG-123.json");
    const legacyMetadataBefore = JSON.parse(await readFile(legacyMetadataPath, "utf8")) as {
      issueId: string | null;
      issueIdentifier: string;
      projectContext?: { projectContextId?: string };
    };

    const docsWorkspace = await manager.createForIssue(docsIssue);
    const docsLookupPath = manager.getPathForIssue({
      id: null,
      identifier: docsIssue.identifier,
      branchName: null,
      projectContext: {
        projectContextId: "docs",
        projectContextLabel: "Documentation Site",
        linearProjectSlug: null,
        routingSource: "explicit",
      },
    });
    const docsMetadata = JSON.parse(
      await readFile(
        path.join(config.workspace.stateDir, "workspaces", "docs__ENG-123__id__issue-docs-collision-1.json"),
        "utf8",
      ),
    ) as {
      issueId: string | null;
      issueIdentifier: string;
      projectContext?: { projectContextId?: string };
    };
    const legacyMetadataAfter = JSON.parse(await readFile(legacyMetadataPath, "utf8")) as {
      issueId: string | null;
      issueIdentifier: string;
      projectContext?: { projectContextId?: string };
    };

    expect(legacyWorkspace.workspaceKey).toBe("docs__ENG-123");
    expect(docsWorkspace.workspaceKey).toBe("docs__ENG-123__id__issue-docs-collision-1");
    expect(docsWorkspace.path).not.toBe(legacyWorkspace.path);
    expect(manager.getPathForIssue(docsIssue)).toBe(docsWorkspace.path);
    expect(docsLookupPath).toBe(docsWorkspace.path);
    expect(legacyMetadataBefore).toMatchObject({
      issueId: "legacy-docs-prefix-1",
      issueIdentifier: "docs__ENG-123",
      projectContext: { projectContextId: "default" },
    });
    expect(legacyMetadataAfter).toEqual(legacyMetadataBefore);
    expect(docsMetadata.issueId).toBe("issue-docs-collision-1");
    expect(docsMetadata.issueIdentifier).toBe("ENG-123");
    expect(docsMetadata.projectContext?.projectContextId).toBe("docs");

    await manager.removeForIssue(docsIssue);

    await expect(stat(docsWorkspace.path)).rejects.toThrow();
    await expect(stat(legacyWorkspace.path)).resolves.toBeDefined();
    expect(await manager.getWorkspaceRecord(docsWorkspace.workspaceKey)).toBeNull();
    expect(await manager.getWorkspaceRecord(legacyWorkspace.workspaceKey)).toMatchObject({
      issueId: "legacy-docs-prefix-1",
      issueIdentifier: "docs__ENG-123",
    });
    expect(JSON.parse(await readFile(legacyMetadataPath, "utf8"))).toEqual(legacyMetadataBefore);
  });

  it("prefers the implementation workspace over a newer planning sibling when resolving legacy-collision lookup paths", async () => {
    const config = testConfig(root);
    const manager = new WorkspaceManager({
      workspace: config.workspace,
      hooks: config.hooks,
      logger: new StructuredLogger(() => undefined),
    });
    const legacyIssue = issue({ id: "legacy-docs-prefix-planning-1", identifier: "docs__ENG-123" });
    const docsIssue = trackerIssue({
      id: "issue-docs-planning-lookup-1",
      identifier: "ENG-123",
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      branchName: null,
    });

    const legacyWorkspace = await manager.createForIssue(legacyIssue);
    const docsWorkspace = await manager.createForIssue(docsIssue);
    const planningWorkspace = await manager.createForPlanning(docsIssue);
    const docsLookupPath = manager.getPathForIssue({
      id: null,
      identifier: docsIssue.identifier,
      branchName: null,
      projectContext: {
        projectContextId: "docs",
        projectContextLabel: "Documentation Site",
        linearProjectSlug: null,
        routingSource: "explicit",
      },
    });

    expect(legacyWorkspace.workspaceKey).toBe("docs__ENG-123");
    expect(docsWorkspace.workspaceKey).toBe("docs__ENG-123__id__issue-docs-planning-lookup-1");
    expect(docsWorkspace.path).not.toBe(legacyWorkspace.path);
    expect(planningWorkspace.path).not.toBe(docsWorkspace.path);
    expect(manager.getPathForIssue(docsIssue)).toBe(docsWorkspace.path);
    expect(docsLookupPath).toBe(docsWorkspace.path);
    expect(docsLookupPath).not.toBe(planningWorkspace.path);
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
});

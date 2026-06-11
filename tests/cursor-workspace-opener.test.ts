import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CursorWorkspaceOpener } from "../cursor/src/CursorWorkspaceOpener.js";

describe("CursorWorkspaceOpener", () => {
  it("rejects paths outside the configured workspace root", async () => {
    const opener = new CursorWorkspaceOpener({
      workspaceRoot: "/tmp/symphony-root",
      openerCommand: "cursor",
    });

    await expect(opener.open("/tmp/elsewhere")).rejects.toThrow();
  });

  it("rejects symlinked workspace paths that escape the root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-open-root-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "symphony-open-outside-"));
    try {
      const link = path.join(root, "ESCAPE-1");
      await mkdir(outside, { recursive: true });
      await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
      const opener = new CursorWorkspaceOpener({
        workspaceRoot: root,
        openerCommand: "cursor",
      });

      await expect(opener.open(link)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
  it("accepts workspace paths inside any configured routed root", async () => {
    const rootA = await mkdtemp(path.join(os.tmpdir(), "symphony-open-root-a-"));
    const rootB = await mkdtemp(path.join(os.tmpdir(), "symphony-open-root-b-"));
    try {
      const workspace = path.join(rootB, "DOCS-123");
      await mkdir(workspace, { recursive: true });
      const opener = new CursorWorkspaceOpener({
        workspaceRoot: () => [rootA, rootB],
        openerCommand: process.execPath,
      });

      await expect(opener.open(workspace)).resolves.toBeUndefined();
    } finally {
      await rm(rootA, { recursive: true, force: true });
      await rm(rootB, { recursive: true, force: true });
    }
  });
});

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HermesProfileManager, safeProfileKey } from "../hermes/src/HermesProfileManager.js";

let root: string;

describe("HermesProfileManager", () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-hermes-profile-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("copies a template into an isolated profile directory", async () => {
    const templatesDir = path.join(root, "templates");
    const stateDir = path.join(root, "state");
    await mkdir(path.join(templatesDir, "worker"), { recursive: true });
    await writeFile(path.join(templatesDir, "worker", "SOUL.md"), "worker soul\n", "utf8");

    const manager = new HermesProfileManager({ templatesDir, stateDir });
    const profile = await manager.materialize({
      workspaceKey: "workspace/one",
      role: "worker",
      phase: "implementation",
      template: "worker",
      profileKey: "issue-1",
      mode: "fresh",
    });

    expect(profile.profileDir.replace(/\\/g, "/")).toContain("/profiles/workspace_one/worker/implementation/issue-1");
    await expect(readFile(path.join(profile.profileDir, "SOUL.md"), "utf8")).resolves.toBe("worker soul\n");
    await expect(readFile(path.join(profile.profileDir, ".symphony-hermes-profile.json"), "utf8")).resolves.toContain(
      '"template": "worker"',
    );
    expect((await stat(path.join(profile.profileDir, "memories"))).isDirectory()).toBe(true);
  });

  it("sanitizes profile segments", () => {
    expect(safeProfileKey("TEST/1 review:round")).toBe("TEST_1_review_round");
  });

  it("compacts long profile segments with a stable hash suffix", () => {
    const compact = safeProfileKey("MCP-CONFLICT/merge_conflict_resolution/" + "x".repeat(80));

    expect(compact.length).toBeLessThanOrEqual(40);
    expect(compact.startsWith("MCP-CONFLICT")).toBe(true);
    expect(compact).toMatch(/_[a-f0-9]{10}$/);
    expect(safeProfileKey("MCP-CONFLICT/merge_conflict_resolution/" + "x".repeat(80))).toBe(compact);
  });
});

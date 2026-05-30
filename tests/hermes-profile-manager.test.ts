import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HermesProfileManager, hermesAcpProfileName, safeProfileKey } from "../hermes/src/HermesProfileManager.js";

let root: string;

const HERMES_PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

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

  it("sanitizes profile names to Hermes-safe lowercase identifiers", () => {
    expect(safeProfileKey("TEST/1 review:round")).toBe("test_1_review_round");
    expect(safeProfileKey("  .Bad Name 😺 / NEXT  ")).toBe("bad_name_next");
    expect(safeProfileKey("___")).toBe("sym_profile");
    expect(safeProfileKey("123-OK_name")).toBe("123-ok_name");
  });

  it("compacts long profile names with a stable hash suffix", () => {
    const source = "MCP-CONFLICT/merge_conflict_resolution/" + "x".repeat(80);
    const compact = safeProfileKey(source);

    expect(compact).toMatch(HERMES_PROFILE_NAME_RE);
    expect(compact.length).toBeLessThanOrEqual(64);
    expect(compact.startsWith("mcp-conflict")).toBe(true);
    expect(compact).toMatch(/_[a-f0-9]{16}$/);
    expect(safeProfileKey(source)).toBe(compact);
    expect(safeProfileKey("MCP-CONFLICT/merge_conflict_resolution/" + "y".repeat(80))).not.toBe(compact);
  });

  it("uses a deterministic fallback for reserved names and command collisions", () => {
    expect(safeProfileKey("default")).toBe("sym_default");
    expect(safeProfileKey("AcP")).toBe("sym_acp");
    expect(safeProfileKey("git")).toBe("sym_git");
    expect(safeProfileKey("sym_acp")).toBe("sym_acp");
  });

  it("generates deterministic reusable Hermes ACP profile names from the lease inputs", () => {
    const input = {
      workspaceKey: "workspace-1",
      role: "Worker",
      issueIdentifier: "TEST-1",
      phase: "Implementation",
      reuseMode: "reuse_by_issue" as const,
    };

    const name = hermesAcpProfileName(input);

    expect(name).toBe("sym_workspace-1_worker_test-1_implementation_reuse_by_issue");
    expect(name).toMatch(HERMES_PROFILE_NAME_RE);
    expect(hermesAcpProfileName(input)).toBe(name);
    expect(hermesAcpProfileName({ ...input, workspaceKey: "workspace-2" })).not.toBe(name);
    expect(hermesAcpProfileName({ ...input, role: "reviewer" })).not.toBe(name);
    expect(hermesAcpProfileName({ ...input, issueIdentifier: "TEST-2" })).not.toBe(name);
    expect(hermesAcpProfileName({ ...input, phase: "review" })).not.toBe(name);
  });

  it("uses the fresh lease id to make fresh Hermes ACP profile names unique", () => {
    const input = {
      workspaceKey: "workspace-1",
      role: "reviewer",
      issueIdentifier: "TEST-1",
      phase: "review",
      reuseMode: "fresh_per_run" as const,
    };

    const freshOne = hermesAcpProfileName({ ...input, freshLeaseId: "lease-one" });
    const freshTwo = hermesAcpProfileName({ ...input, freshLeaseId: "lease-two" });

    expect(freshOne).toMatch(HERMES_PROFILE_NAME_RE);
    expect(freshTwo).toMatch(HERMES_PROFILE_NAME_RE);
    expect(freshOne).not.toBe(freshTwo);
    expect(hermesAcpProfileName({ ...input, freshLeaseId: "lease-one" })).toBe(freshOne);
    expect(() => hermesAcpProfileName(input)).toThrow(/fresh lease id/i);
  });

  it("preserves entropy for truncated Hermes ACP profile names", () => {
    const longInput = {
      workspaceKey: `WORKSPACE/${"a".repeat(80)}`,
      role: "worker",
      issueIdentifier: `ENG-${"b".repeat(80)}`,
      phase: "merge_conflict_resolution",
      reuseMode: "reuse_by_issue" as const,
    };

    const name = hermesAcpProfileName(longInput);

    expect(name).toMatch(HERMES_PROFILE_NAME_RE);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name.startsWith("sym_workspace")).toBe(true);
    expect(name).toMatch(/_[a-f0-9]{16}$/);
    expect(hermesAcpProfileName(longInput)).toBe(name);
    expect(hermesAcpProfileName({ ...longInput, issueIdentifier: `ENG-${"c".repeat(80)}` })).not.toBe(name);
  });
});

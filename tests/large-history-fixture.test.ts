import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { projectWebHistory } from "../src/app/WebHistoryProjection.js";
import { FileIssueLifecycleStore } from "../src/core/persistence/IssueLifecycleStore.js";
import { FileRunTranscriptStore } from "../src/core/persistence/RunTranscriptStore.js";
import { FileWritebackOutboxStore } from "../src/core/writeback/WritebackOutbox.js";
import { generateLargeHistoryFixture } from "../scripts/generate-large-history-fixture.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("generateLargeHistoryFixture", () => {
  it("writes a deterministic large-history state tree that existing stores and web projection can read", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "large-history-fixture-state");

    const manifest = await generateLargeHistoryFixture({
      outputDir: stateDir,
      issueCount: 6,
      runsPerIssue: 4,
      eventsPerRun: 8,
      writebacksPerIssue: 5,
      baseTimestamp: "2026-02-03T04:05:06.000Z",
      issuePrefix: "LH",
    });

    expect(manifest.stateDir).toBe(stateDir);
    expect(manifest.counts).toEqual({
      issues: 6,
      workspaces: 6,
      lifecycleRecords: 6,
      runs: 24,
      transcriptEvents: 192,
      writebackOperations: 30,
    });
    expect(manifest.issues[0]).toMatchObject({
      id: "fixture-issue-0001",
      identifier: "LH-0001",
      workspaceKey: "LH-0001",
      runIds: ["fixture-run-0001-01", "fixture-run-0001-02", "fixture-run-0001-03", "fixture-run-0001-04"],
    });

    const runStore = new FileRunTranscriptStore(stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const writebackStore = new FileWritebackOutboxStore(stateDir);

    const runs = await runStore.listRuns();
    expect(runs).toHaveLength(24);
    expect(new Set(runs.map((run) => run.status))).toEqual(new Set(["running", "failed", "cancelled", "succeeded"]));
    expect(await runStore.findWorkspace("LH-0001")).toMatchObject({
      workspaceKey: "LH-0001",
      issueId: "fixture-issue-0001",
      gitBranchName: "fixture/lh-0001",
    });
    expect(await runStore.listRunsForIssue("LH-0001")).toHaveLength(4);
    expect(await runStore.listRunsForIssue("fixture-issue-0001")).toHaveLength(4);

    const transcriptPage = await runStore.readTranscript("fixture-run-0001-01", { offset: 0, limit: 2 });
    expect(await runStore.readTranscriptEventCount("fixture-run-0001-01")).toBe(8);
    expect(transcriptPage.nextOffset).toBe(2);
    expect(transcriptPage.events.map((event) => event.sequence)).toEqual([1, 2]);
    const transcriptTail = await runStore.readTranscriptTail("fixture-run-0001-01", { limit: 3 });
    expect(transcriptTail.offset).toBe(5);
    expect(transcriptTail.events.map((event) => event.sequence)).toEqual([6, 7, 8]);

    const lifecycles = await lifecycleStore.list();
    expect(lifecycles).toHaveLength(6);
    expect(new Set(lifecycles.map((record) => record.phase))).toEqual(
      new Set(["implementation", "review", "passed", "blocked", "terminal", "merge_conflict_resolution"]),
    );
    const lifecycleByIdentifier = await lifecycleStore.get("LH-0003");
    expect(lifecycleByIdentifier).toMatchObject({
      issueId: "fixture-issue-0003",
      issueIdentifier: "LH-0003",
      phase: "passed",
      handoff: { version: 1 },
      summaryPointers: { workspaceKey: "LH-0003", branchName: "fixture/lh-0003" },
    });

    const writebacks = await writebackStore.list();
    expect(writebacks).toHaveLength(30);
    expect(new Set(writebacks.map((operation) => operation.status))).toEqual(
      new Set(["pending", "succeeded", "skipped", "retrying", "dead_letter"]),
    );
    expect(await writebackStore.get("fixture:LH-0001:writeback:02")).toMatchObject({
      kind: "comment",
      status: "succeeded",
      issueId: "fixture-issue-0001",
    });

    const history = projectWebHistory(runs);
    expect(history.sessions).toHaveLength(24);
    expect(history.defaultSessionId).not.toBe("");
    expect(history.sessions.some((session) => session.runSession.runtime.agentLifecycle === "reuse_by_issue")).toBe(true);
  });

  it("supports empty transcript/writeback boundaries without omitting durable run and lifecycle records", async () => {
    const root = await makeTempRoot();
    const stateDir = path.join(root, "large-history-fixture-boundary");

    const manifest = await generateLargeHistoryFixture({
      outputDir: stateDir,
      issueCount: 1,
      runsPerIssue: 1,
      eventsPerRun: 0,
      writebacksPerIssue: 0,
      issuePrefix: "BD",
    });

    expect(manifest.counts).toMatchObject({ issues: 1, runs: 1, transcriptEvents: 0, writebackOperations: 0 });
    const runStore = new FileRunTranscriptStore(stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const writebackStore = new FileWritebackOutboxStore(stateDir);
    expect(await runStore.readTranscriptEventCount("fixture-run-0001-01")).toBe(0);
    expect((await runStore.readTranscript("fixture-run-0001-01", { offset: 0, limit: 10 })).events).toEqual([]);
    expect(await lifecycleStore.get("BD-0001")).toMatchObject({ issueIdentifier: "BD-0001" });
    expect(await writebackStore.list()).toEqual([]);
  });

  it("refuses accidental overwrites and only force-replaces safe fixture-looking directories by default", async () => {
    const root = await makeTempRoot();
    const safeStateDir = path.join(root, "safe-large-history-fixture");
    await generateLargeHistoryFixture({ outputDir: safeStateDir, issueCount: 1, runsPerIssue: 1, eventsPerRun: 1 });
    await fs.writeFile(path.join(safeStateDir, "stale-marker.txt"), "stale", "utf8");

    await expect(
      generateLargeHistoryFixture({ outputDir: safeStateDir, issueCount: 1, runsPerIssue: 1, eventsPerRun: 1 }),
    ).rejects.toThrow("Output directory is not empty");

    await generateLargeHistoryFixture({
      outputDir: safeStateDir,
      issueCount: 1,
      runsPerIssue: 1,
      eventsPerRun: 1,
      force: true,
    });
    await expect(fs.access(path.join(safeStateDir, "stale-marker.txt"))).rejects.toThrow();

    const nonFixtureDir = path.join(root, "state");
    await fs.mkdir(nonFixtureDir, { recursive: true });
    await fs.writeFile(path.join(nonFixtureDir, "data.txt"), "important", "utf8");
    await expect(
      generateLargeHistoryFixture({ outputDir: nonFixtureDir, issueCount: 1, runsPerIssue: 1, eventsPerRun: 1, force: true }),
    ).rejects.toThrow("Refusing to force-remove non-fixture-looking path");

    await generateLargeHistoryFixture({
      outputDir: nonFixtureDir,
      issueCount: 1,
      runsPerIssue: 1,
      eventsPerRun: 1,
      force: true,
      allowDestructiveOverwrite: true,
    });
    expect((await new FileRunTranscriptStore(nonFixtureDir).listRuns())).toHaveLength(1);
  });
});

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-large-history-fixture-"));
  tempRoots.push(root);
  return root;
}

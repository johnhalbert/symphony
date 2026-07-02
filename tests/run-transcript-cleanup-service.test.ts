import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunTranscriptCleanupService } from "../src/core/RunTranscriptCleanupService.js";
import { FileRunTranscriptStore, type RunStatus } from "../src/core/persistence/RunTranscriptStore.js";

describe("RunTranscriptCleanupService", () => {
  let root: string;
  let store: FileRunTranscriptStore;
  let service: RunTranscriptCleanupService;

  beforeEach(async () => {
    vi.useFakeTimers();
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-transcript-cleanup-"));
    store = new FileRunTranscriptStore(root);
    service = new RunTranscriptCleanupService({ runStore: store });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  });

  it("reports dry-run candidates without deleting runs", async () => {
    await createRun(store, "run-1", "2026-01-01T00:00:00.000Z");
    await createRun(store, "run-2", "2026-01-01T00:01:00.000Z");
    await createRun(store, "run-3", "2026-01-01T00:02:00.000Z");

    const result = await service.cleanup({
      targets: [{ issueIdOrIdentifier: "TEST-1" }],
      keepLatestRuns: 1,
      apply: false,
      reason: "test",
    });

    expect(result.totals).toMatchObject({
      considered: 3,
      kept: 1,
      skippedRunning: 0,
      deletable: 2,
      deleted: 0,
      bytesRemoved: 0,
    });
    expect(result.totals.bytesDeletable).toBeGreaterThan(0);
    expect(result.issues[0]?.runs.map((run) => [run.runId, run.action])).toEqual([
      ["run-1", "deletable"],
      ["run-2", "deletable"],
      ["run-3", "kept"],
    ]);
    await expect(store.listRunsForIssue("TEST-1")).resolves.toHaveLength(3);
  });

  it("deletes old non-running runs and keeps the newest run", async () => {
    await createRun(store, "run-1", "2026-01-01T00:00:00.000Z");
    await createRun(store, "run-2", "2026-01-01T00:01:00.000Z");
    await createRun(store, "run-3", "2026-01-01T00:02:00.000Z");

    const result = await service.cleanup({
      targets: [{ issueIdOrIdentifier: "issue-1", issueId: "issue-1", issueIdentifier: "TEST-1" }],
      keepLatestRuns: 1,
      apply: true,
      reason: "test",
    });

    expect(result.totals).toMatchObject({
      considered: 3,
      kept: 1,
      skippedRunning: 0,
      deletable: 2,
      deleted: 2,
    });
    expect(result.totals.bytesRemoved).toBeGreaterThan(0);
    await expect(store.listRunsForIssue("TEST-1")).resolves.toMatchObject([{ runId: "run-3" }]);
  });

  it("never deletes running runs even when they are older than retention", async () => {
    await createRun(store, "run-running", "2026-01-01T00:00:00.000Z", "running");
    await createRun(store, "run-done", "2026-01-01T00:01:00.000Z");
    await createRun(store, "run-latest", "2026-01-01T00:02:00.000Z");

    const result = await service.cleanup({
      targets: [{ issueIdOrIdentifier: "TEST-1" }],
      keepLatestRuns: 1,
      apply: true,
      reason: "test",
    });

    expect(result.issues[0]?.runs.map((run) => [run.runId, run.action])).toEqual([
      ["run-running", "skipped_running"],
      ["run-done", "deleted"],
      ["run-latest", "kept"],
    ]);
    expect(result.totals).toMatchObject({
      considered: 3,
      kept: 1,
      skippedRunning: 1,
      deletable: 1,
      deleted: 1,
    });
    await expect(store.listRunsForIssue("TEST-1")).resolves.toMatchObject([
      { runId: "run-running" },
      { runId: "run-latest" },
    ]);
  });

  it("deletes all non-running runs when keepLatestRuns is zero", async () => {
    await createRun(store, "run-1", "2026-01-01T00:00:00.000Z");
    await createRun(store, "run-2", "2026-01-01T00:01:00.000Z");

    const result = await service.cleanup({
      targets: [{ issueIdOrIdentifier: "TEST-1" }],
      keepLatestRuns: 0,
      apply: true,
      reason: "test",
    });

    expect(result.totals).toMatchObject({
      considered: 2,
      kept: 0,
      deletable: 2,
      deleted: 2,
    });
    await expect(store.listRunsForIssue("TEST-1")).resolves.toEqual([]);
  });
});

async function createRun(
  store: FileRunTranscriptStore,
  runId: string,
  startedAt: string,
  status: RunStatus = "succeeded",
): Promise<void> {
  vi.setSystemTime(new Date(startedAt));
  await store.startRun({
    runId,
    role: "worker",
    issueId: "issue-1",
    issueIdentifier: "TEST-1",
    attempt: null,
    turnNumber: 1,
    prompt: "work",
    workspaceKey: "TEST-1",
    workspacePath: "/tmp/workspace",
  });
  await store.appendEvent({
    runId,
    at: startedAt,
    source: "harness",
    eventType: "progress",
    message: `event for ${runId}`,
  });
  if (status !== "running") {
    await store.updateRun(runId, { status, completedAt: startedAt });
  }
}

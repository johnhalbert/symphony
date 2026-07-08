import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileRunTranscriptStore } from "../src/core/persistence/RunTranscriptStore.js";
import { TranscriptRecallService } from "../src/core/recall/TranscriptRecallService.js";

describe("TranscriptRecallService", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-transcript-recall-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns bounded matches with bookends and enforces per-process call budget", async () => {
    const runStore = new FileRunTranscriptStore(root);
    await runStore.startRun({
      runId: "run-1",
      role: "worker",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      attempt: null,
      turnNumber: 1,
      prompt: "prompt",
      workspaceKey: "TEST-1",
      workspacePath: "/workspace",
    });
    await runStore.appendEvent({
      runId: "run-1",
      at: "2026-01-01T00:00:00.000Z",
      source: "harness",
      eventType: "started",
      message: "Started worker",
    });
    await runStore.appendEvent({
      runId: "run-1",
      at: "2026-01-01T00:00:01.000Z",
      source: "cursor",
      eventType: "progress",
      message: "Implemented bounded context policy",
    });
    await runStore.appendEvent({
      runId: "run-1",
      at: "2026-01-01T00:00:02.000Z",
      source: "harness",
      eventType: "completed",
      message: "Completed worker",
    });
    const service = new TranscriptRecallService({
      runStore,
      budget: { maxCalls: 1, maxEvents: 5, maxChars: 500, bookendEvents: 1 },
    });

    const result = await service.search({
      issue: { id: "issue-1", identifier: "TEST-1" },
      query: "bounded context",
      maxEvents: 10,
    });
    const exhausted = await service.search({
      issue: { id: "issue-1", identifier: "TEST-1" },
      query: "bounded context",
    });

    expect(result.callsRemaining).toBe(0);
    expect(result.denied).toBe(false);
    expect(result.returnedEvents).toBeLessThanOrEqual(5);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.matches).toEqual([
      expect.objectContaining({ eventType: "progress", text: "Implemented bounded context policy" }),
    ]);
    expect(result.runs[0]?.bookends.first).toEqual([expect.objectContaining({ eventType: "started" })]);
    expect(result.runs[0]?.bookends.latest).toEqual([expect.objectContaining({ eventType: "completed" })]);
    expect(exhausted).toMatchObject({ callsRemaining: 0, denied: true, truncated: true, returnedEvents: 0, runs: [] });
  });

  it("returns match-centered context windows with run and transcript pointers", async () => {
    const runStore = new FileRunTranscriptStore(root);
    await runStore.startRun({
      runId: "run-window",
      role: "worker",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      attempt: null,
      turnNumber: 1,
      prompt: "prompt",
      workspaceKey: "TEST-1",
      workspacePath: "/workspace",
    });
    for (const [sequence, message] of [
      [1, "before context"],
      [2, "needle match"],
      [3, "after context"],
    ] as const) {
      await runStore.appendEvent({
        runId: "run-window",
        sequence,
        at: "2026-01-01T00:00:00.000Z",
        source: "cursor",
        eventType: "progress",
        message,
      });
    }
    const service = new TranscriptRecallService({
      runStore,
      budget: { maxCalls: 3, maxEvents: 5, maxChars: 1000, bookendEvents: 1 },
    });

    const result = await service.search({
      issue: { id: "issue-1", identifier: "TEST-1" },
      query: "needle",
    });

    expect(result.returnedEvents).toBeGreaterThanOrEqual(3);
    expect(result.runs[0]).toMatchObject({
      runPointer: "/api/v1/runs/run-window",
      transcriptPointer: "/api/v1/runs/run-window/transcript",
      windows: [
        {
          matchSequence: 2,
          before: [expect.objectContaining({ sequence: 1, text: "before context" })],
          after: [expect.objectContaining({ sequence: 3, text: "after context" })],
        },
      ],
    });
  });

  it("searches beyond the first transcript page and reports true latest bookends", async () => {
    const runStore = new FileRunTranscriptStore(root);
    await runStore.startRun({
      runId: "run-long",
      role: "worker",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      attempt: null,
      turnNumber: 1,
      prompt: "prompt",
      workspaceKey: "TEST-1",
      workspacePath: "/workspace",
    });
    for (let index = 1; index <= 1_005; index += 1) {
      await runStore.appendEvent({
        runId: "run-long",
        sequence: index,
        at: `2026-01-01T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
        source: "cursor",
        eventType: "progress",
        message: index === 1_003 ? "Needle appears after first page" : `event ${index}`,
      });
    }
    const service = new TranscriptRecallService({
      runStore,
      budget: { maxCalls: 3, maxEvents: 5, maxChars: 1000, bookendEvents: 1 },
    });

    const result = await service.search({
      issue: { id: "issue-1", identifier: "TEST-1" },
      query: "Needle",
    });

    expect(result.runs[0]?.matches).toEqual([expect.objectContaining({ sequence: 1003, text: "Needle appears after first page" })]);
    expect(result.runs[0]?.bookends.latest).toEqual([expect.objectContaining({ sequence: 1005, text: "event 1005" })]);
  }, 60_000);

  it("keeps recall text within the character budget when truncating near the cap", async () => {
    const runStore = new FileRunTranscriptStore(root);
    await runStore.startRun({
      runId: "run-budget",
      role: "worker",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      attempt: null,
      turnNumber: 1,
      prompt: "prompt",
      workspaceKey: "TEST-1",
      workspacePath: "/workspace",
    });
    await runStore.appendEvent({
      runId: "run-budget",
      sequence: 1,
      at: "2026-01-01T00:00:00.000Z",
      source: "cursor",
      eventType: "progress",
      message: `needle ${"x".repeat(488)}`,
    });
    await runStore.appendEvent({
      runId: "run-budget",
      sequence: 2,
      at: "2026-01-01T00:00:01.000Z",
      source: "cursor",
      eventType: "progress",
      message: "latest event with extra text",
    });
    const service = new TranscriptRecallService({
      runStore,
      budget: { maxCalls: 3, maxEvents: 5, maxChars: 500, bookendEvents: 1 },
    });

    const result = await service.search({
      issue: { id: "issue-1", identifier: "TEST-1" },
      query: "needle",
    });
    const totalTextLength = result.runs.flatMap((run) => [
      ...run.matches,
      ...run.bookends.first,
      ...run.bookends.latest,
    ]).reduce((total, event) => total + event.text.length, 0);

    expect(totalTextLength).toBeLessThanOrEqual(500);
    expect(result.truncated).toBe(true);
  });

  it("does not search unsanitized harness progress text", async () => {
    const runStore = new FileRunTranscriptStore(root);
    await runStore.startRun({
      runId: "run-harness-progress",
      role: "worker",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      attempt: null,
      turnNumber: 1,
      prompt: "prompt",
      workspaceKey: "TEST-1",
      workspacePath: "/workspace",
    });
    await runStore.appendEvent({
      runId: "run-harness-progress",
      at: "2026-01-01T00:00:00.000Z",
      source: "harness",
      eventType: "progress",
      message: "SECRET_HARNESS_PROGRESS",
    });
    const service = new TranscriptRecallService({ runStore });

    const result = await service.search({
      issue: { id: "issue-1", identifier: "TEST-1" },
      query: "SECRET_HARNESS_PROGRESS",
    });

    expect(result.runs).toEqual([]);
  });
});

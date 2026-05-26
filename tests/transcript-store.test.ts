import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileRunTranscriptStore } from "../src/core/persistence/RunTranscriptStore.js";

describe("FileRunTranscriptStore", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-store-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  });

  it("persists runs and paginates transcript events across store instances", async () => {
    const store = new FileRunTranscriptStore(root);
    await store.startRun({
      runId: "run-1",
      sessionId: "session-1",
      agentId: "agent-1",
      role: "worker",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      attempt: null,
      turnNumber: 1,
      prompt: "work",
      cursorModel: "gpt-5.5",
      cursorModelParams: [
        { id: "context", value: "272k" },
        { id: "reasoning", value: "extra-high" },
      ],
      cursorSettingSources: [],
      cursorMode: "plan",
      cursorAllowLargeContext: false,
      cursorWorkerAgentLifecycle: "fresh_per_run",
      workspaceKey: "TEST-1",
      workspacePath: "/tmp/workspace",
      gitBranchName: "symphony/TEST-1",
      repoPath: "/repo",
      baseRef: "origin/main",
    });
    await store.appendEvent({ runId: "run-1", at: "2026-01-01T00:00:00.000Z", source: "harness", eventType: "progress", message: "one" });
    await store.appendEvent({ runId: "run-1", at: "2026-01-01T00:00:01.000Z", source: "harness", eventType: "completed" });
    await store.recordPullRequestEvent({
      runId: "run-1",
      action: "opened",
      at: "2026-01-01T00:00:01.500Z",
      prUrl: "https://github.com/acme/repo/pull/7",
      prNumber: 7,
      lastPushedAt: "2026-01-01T00:00:01.250Z",
    });
    await store.recordPullRequestEvent({
      runId: "run-1",
      action: "updated",
      at: "2026-01-01T00:00:01.600Z",
      prUrl: "https://github.com/acme/repo/pull/7",
      prNumber: 7,
      lastPushedAt: "2026-01-01T00:00:01.500Z",
    });
    await store.recordCiStatusEvent({
      runId: "run-1",
      at: "2026-01-01T00:00:01.750Z",
      ciStatus: "success",
    });
    await store.updateRun("run-1", { status: "succeeded", completedAt: "2026-01-01T00:00:02.000Z" });

    const reloaded = new FileRunTranscriptStore(root);
    const run = await reloaded.getRun("run-1");
    const page = await reloaded.readTranscript("run-1", { offset: 0, limit: 10 });

    expect(run).toMatchObject({
      status: "succeeded",
      transcriptEventCount: 5,
      gitBranchName: "symphony/TEST-1",
      repoPath: "/repo",
      baseRef: "origin/main",
      promptCharCount: 4,
      cursorModel: "gpt-5.5",
      cursorModelParams: [
        { id: "context", value: "272k" },
        { id: "reasoning", value: "extra-high" },
      ],
      cursorSettingSources: [],
      cursorMode: "plan",
      cursorAllowLargeContext: false,
      cursorWorkerAgentLifecycle: "fresh_per_run",
      prUrl: "https://github.com/acme/repo/pull/7",
      prNumber: 7,
      ciStatus: "success",
      lastPushedAt: "2026-01-01T00:00:01.500Z",
    });
    expect(await reloaded.listRunsForIssue("TEST-1")).toHaveLength(1);
    expect(page.events.map((event) => event.eventType)).toEqual([
      "progress",
      "completed",
      "pr_opened",
      "pr_updated",
      "ci_status_changed",
    ]);
    expect(page.nextOffset).toBeNull();
  });

  it("assigns contiguous sequences when appends race", async () => {
    const store = new FileRunTranscriptStore(root);
    await store.startRun({
      runId: "run-race",
      role: "worker",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      attempt: null,
      turnNumber: 1,
      prompt: "work",
      workspaceKey: "TEST-1",
      workspacePath: "/tmp/workspace",
    });

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.appendEvent({
          runId: "run-race",
          at: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
          source: "harness",
          eventType: "progress",
          message: `event ${index}`,
        }),
      ),
    );

    const run = await store.getRun("run-race");
    const page = await store.readTranscript("run-race", { offset: 0, limit: 25 });
    expect(run?.transcriptEventCount).toBe(20);
    expect(page.events.map((event) => event.sequence).sort((left, right) => left - right)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    expect(page.nextOffset).toBeNull();
  });

  it("reads legacy missing transcript counts without mutating metadata and projects public events", async () => {
    const store = new FileRunTranscriptStore(root);
    await store.startRun({
      runId: "run-legacy",
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
      runId: "run-legacy",
      at: "2026-01-01T00:00:00.000Z",
      source: "harness",
      eventType: "progress",
      message: "assistant token=SECRET_TOKEN",
      payload: { token: "SECRET_PAYLOAD", nested: { authorization: "Bearer SECRET_AUTH" } },
    });
    const metaPath = path.join(root, "runs", "run-legacy", "meta.json");
    const metadata = JSON.parse(await readFile(metaPath, "utf8")) as { transcriptEventCount?: number };
    delete metadata.transcriptEventCount;
    await writeFile(metaPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    const beforeRead = await readFile(metaPath, "utf8");

    const page = await store.readTranscript("run-legacy", { offset: 0, limit: 10 });

    expect(await store.readTranscriptEventCount("run-legacy")).toBe(1);
    expect(await readFile(metaPath, "utf8")).toBe(beforeRead);
    expect(page.nextOffset).toBeNull();
    expect(JSON.stringify(page)).not.toContain("SECRET_TOKEN");
    expect(JSON.stringify(page)).not.toContain("SECRET_PAYLOAD");
    expect(JSON.stringify(page)).not.toContain("SECRET_AUTH");
    expect(page.events[0]).toMatchObject({
      message: "assistant token=[redacted]",
      payload: { token: "[redacted]", nested: { authorization: "[redacted]" } },
    });
  });

  it("can scope latest issue run lookup by role", async () => {
    const store = new FileRunTranscriptStore(root);
    await store.startRun({
      runId: "worker-run",
      sessionId: "worker-session",
      agentId: "worker-agent",
      role: "worker",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      attempt: null,
      turnNumber: 1,
      prompt: "work",
      workspaceKey: "TEST-1",
      workspacePath: "/tmp/workspace",
    });
    await store.startRun({
      runId: "reviewer-run",
      sessionId: "reviewer-session",
      agentId: "reviewer-agent",
      role: "reviewer",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      attempt: null,
      turnNumber: 2,
      prompt: "review",
      workspaceKey: "TEST-1",
      workspacePath: "/tmp/workspace",
    });

    await expect(store.latestRunForIssue("TEST-1")).resolves.toMatchObject({ runId: "reviewer-run" });
    await expect(store.latestRunForIssue("TEST-1", { role: "worker" })).resolves.toMatchObject({ runId: "worker-run" });
  });

  it("orders equal-timestamp issue runs deterministically", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const store = new FileRunTranscriptStore(root);
    await store.startRun({
      runId: "run-z-worker-turn",
      sessionId: "worker-turn-session",
      agentId: "worker-turn-agent",
      role: "worker",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      attempt: null,
      turnNumber: 2,
      prompt: "continue work",
      workspaceKey: "TEST-1",
      workspacePath: "/tmp/workspace",
    });
    await store.startRun({
      runId: "run-c-worker-retry",
      sessionId: "worker-retry-session",
      agentId: "worker-retry-agent",
      role: "worker",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      attempt: 1,
      turnNumber: 1,
      prompt: "retry work",
      workspaceKey: "TEST-1",
      workspacePath: "/tmp/workspace",
    });
    await store.startRun({
      runId: "run-b-reviewer",
      sessionId: "reviewer-session",
      agentId: "reviewer-agent",
      role: "reviewer",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      attempt: null,
      turnNumber: 1,
      prompt: "review",
      workspaceKey: "TEST-1",
      workspacePath: "/tmp/workspace",
    });
    await store.startRun({
      runId: "run-a-worker",
      sessionId: "worker-session",
      agentId: "worker-agent",
      role: "worker",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      attempt: null,
      turnNumber: 1,
      prompt: "work",
      workspaceKey: "TEST-1",
      workspacePath: "/tmp/workspace",
    });

    await expect(store.listRunsForIssue("TEST-1")).resolves.toMatchObject([
      { runId: "run-a-worker" },
      { runId: "run-b-reviewer" },
      { runId: "run-z-worker-turn" },
      { runId: "run-c-worker-retry" },
    ]);
    await expect(store.latestRunForIssue("TEST-1")).resolves.toMatchObject({ runId: "run-c-worker-retry" });
    await expect(store.latestRunForIssue("TEST-1", { role: "worker" })).resolves.toMatchObject({
      runId: "run-c-worker-retry",
    });
  });
});

import { promises as nodeFs } from "node:fs";
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
    vi.restoreAllMocks();
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
      harnessId: "cursor",
      runtimeModel: "gpt-5.5",
      runtimeModelParams: [
        { id: "context", value: "272k" },
        { id: "reasoning", value: "extra-high" },
      ],
      runtimeSettingSources: [],
      runtimeMode: "plan",
      runtimeAllowLargeContext: false,
      runtimeAgentLifecycle: "fresh_per_run",
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

  it("reads bounded file-backed transcript tails without parsing the whole JSONL body", async () => {
    const store = new FileRunTranscriptStore(root);
    await store.startRun({
      runId: "run-tail",
      sessionId: "session-tail",
      agentId: "agent-tail",
      role: "worker",
      issueId: "issue-tail",
      issueIdentifier: "TEST-TAIL",
      attempt: null,
      turnNumber: 1,
      prompt: "tail",
      workspaceKey: "TEST-TAIL",
      workspacePath: "/tmp/workspace",
    });
    const metaPath = path.join(root, "runs", "run-tail", "meta.json");
    const eventsPath = path.join(root, "runs", "run-tail", "events.jsonl");
    const metadata = JSON.parse(await readFile(metaPath, "utf8")) as { transcriptEventCount?: number };
    metadata.transcriptEventCount = 1_205;
    await writeFile(metaPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

    const malformedHugeFirstLine = `{not-json:${"x".repeat(2 * 1024 * 1024)}}\n`;
    const validTailLines = Array.from({ length: 1_204 }, (_, index) => {
      const sequence = index + 2;
      return JSON.stringify({
        runId: "run-tail",
        sequence,
        at: `2026-01-01T00:00:${String(sequence % 60).padStart(2, "0")}.000Z`,
        source: "harness",
        eventType: "progress",
        message: `event ${sequence}`,
      });
    }).join("\n");
    await writeFile(eventsPath, `${malformedHugeFirstLine}${validTailLines}\n`, "utf8");

    const tail = await store.readTranscriptTail("run-tail", { limit: 5 });
    expect(tail).toMatchObject({ runId: "run-tail", offset: 1_200, limit: 5, nextOffset: null });
    expect(tail.events.map((event) => event.sequence)).toEqual([1_201, 1_202, 1_203, 1_204, 1_205]);
    expect(tail.events.map((event) => event.message)).toEqual([
      "event 1201",
      "event 1202",
      "event 1203",
      "event 1204",
      "event 1205",
    ]);

    const capped = await store.readTranscriptTail("run-tail", { limit: 9_999 });
    expect(capped).toMatchObject({ runId: "run-tail", offset: 205, limit: 1_000, nextOffset: null });
    expect(capped.events).toHaveLength(1_000);
    expect(capped.events[0]?.sequence).toBe(206);
    expect(capped.events.at(-1)?.sequence).toBe(1_205);

    await expect(store.readTranscriptTail("missing-run", { limit: 5 })).resolves.toMatchObject({
      runId: "missing-run",
      offset: 0,
      limit: 5,
      nextOffset: null,
      events: [],
    });
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
      message:
        "assistant token=SECRET_TOKEN access_token=legacy-access refreshToken: legacy-refresh github_token=legacy-github client_secret: legacy-client private_key=legacy-private ghp_ABCDEFGH1 sk-ABCDEFGH1 inputTokens: 7 totalTokens: 9 tokenConfigured: true",
      payload: {
        token: "SECRET_PAYLOAD",
        nested: {
          authorization: "Bearer SECRET_AUTH",
          access_token: "legacy-access-payload",
          refreshToken: "legacy-refresh-payload",
          github_token: "legacy-github-payload",
          client_secret: "legacy-client-payload",
          private_key: "legacy-private-payload",
          tokens: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
          tokenConfigured: true,
        },
      },
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
    expect(JSON.stringify(page)).not.toContain("legacy-access");
    expect(JSON.stringify(page)).not.toContain("legacy-refresh");
    expect(JSON.stringify(page)).not.toContain("legacy-github");
    expect(JSON.stringify(page)).not.toContain("legacy-client");
    expect(JSON.stringify(page)).not.toContain("legacy-private");
    expect(JSON.stringify(page)).not.toContain("ghp_ABCDEFGH1");
    expect(JSON.stringify(page)).not.toContain("sk-ABCDEFGH1");
    expect(page.events[0]).toMatchObject({
      message: expect.stringContaining("token=[redacted]"),
      payload: {
        token: "[redacted]",
        nested: {
          authorization: "[redacted]",
          access_token: "[redacted]",
          refreshToken: "[redacted]",
          github_token: "[redacted]",
          client_secret: "[redacted]",
          private_key: "[redacted]",
          tokens: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
          tokenConfigured: true,
        },
      },
    });
    expect(page.events[0]?.message).toContain("inputTokens: 7");
    expect(page.events[0]?.message).toContain("totalTokens: 9");
    expect(page.events[0]?.message).toContain("tokenConfigured: true");
  });


  it("tracks projection revisions for successful run and workspace writes only", async () => {
    const store = new FileRunTranscriptStore(root);
    const events: Array<{ source: string; revision: number }> = [];
    store.onProjectionChanged(() => {
      throw new Error("listener failure must not affect durable writes");
    });
    const unsubscribe = store.onProjectionChanged((event) => events.push(event));

    expect(store.projectionRevision()).toBe(0);
    await expect(store.getRun("missing-run")).resolves.toBeNull();
    await expect(store.updateRun("missing-run", { status: "failed" })).resolves.toBeNull();
    await expect(store.findWorkspace("missing-workspace")).resolves.toBeNull();
    await store.deleteWorkspace("missing-workspace");
    await expect(store.listRuns()).resolves.toEqual([]);
    expect(store.projectionRevision()).toBe(0);
    expect(events).toEqual([]);

    await store.startRun({
      runId: "run-projection",
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
      runId: "run-projection",
      at: "2026-01-01T00:00:00.000Z",
      source: "harness",
      eventType: "progress",
    });
    await store.updateRun("run-projection", { status: "succeeded", completedAt: "2026-01-01T00:00:01.000Z" });
    await store.upsertWorkspace({
      workspaceKey: "TEST-1",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      path: "/tmp/workspace",
      sourceKind: "dogfood",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await store.deleteWorkspace("TEST-1");

    expect(store.projectionRevision()).toBe(5);
    expect(events).toEqual([
      { source: "runs", revision: 1 },
      { source: "runs", revision: 2 },
      { source: "runs", revision: 3 },
      { source: "workspaces", revision: 4 },
      { source: "workspaces", revision: 5 },
    ]);

    await expect(store.getRun("run-projection")).resolves.toMatchObject({ runId: "run-projection" });
    await expect(store.listRunsForIssue("TEST-1")).resolves.toHaveLength(1);
    await expect(store.readTranscript("run-projection", { offset: 0, limit: 10 })).resolves.toMatchObject({
      events: [{ eventType: "progress" }],
    });
    await expect(store.readTranscriptEventCount("run-projection")).resolves.toBe(1);
    await expect(store.listWorkspaces()).resolves.toEqual([]);
    await expect(store.findWorkspace("TEST-1")).resolves.toBeNull();
    expect(store.projectionRevision()).toBe(5);
    expect(events).toHaveLength(5);

    unsubscribe();
    await store.updateRun("run-projection", { status: "failed", error: "after unsubscribe" });
    expect(store.projectionRevision()).toBe(6);
    expect(events).toHaveLength(5);
  });

  it("tracks transcript event count repairs as projection writes while read-only counts stay stable", async () => {
    const store = new FileRunTranscriptStore(root);
    await store.startRun({
      runId: "run-repair",
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
      runId: "run-repair",
      at: "2026-01-01T00:00:00.000Z",
      source: "harness",
      eventType: "progress",
    });
    const events: Array<{ source: string; revision: number }> = [];
    store.onProjectionChanged((event) => events.push(event));
    const beforeLegacyEditRevision = store.projectionRevision();
    const metaPath = path.join(root, "runs", "run-repair", "meta.json");
    const metadata = JSON.parse(await readFile(metaPath, "utf8")) as { transcriptEventCount?: number };
    delete metadata.transcriptEventCount;
    await writeFile(metaPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

    await expect(store.readTranscriptEventCount("run-repair")).resolves.toBe(1);
    expect(store.projectionRevision()).toBe(beforeLegacyEditRevision);
    expect(events).toEqual([]);

    await expect(store.ensureTranscriptEventCount("run-repair")).resolves.toBe(1);
    expect(store.projectionRevision()).toBe(beforeLegacyEditRevision + 1);
    expect(events).toEqual([{ source: "runs", revision: beforeLegacyEditRevision + 1 }]);
  });

  it("does not advance projection revisions when run writes fail", async () => {
    const store = new FileRunTranscriptStore(root);
    const events: Array<{ source: string; revision: number }> = [];
    store.onProjectionChanged((event) => events.push(event));
    vi.spyOn(nodeFs, "writeFile").mockRejectedValueOnce(new Error("disk full"));

    await expect(
      store.startRun({
        runId: "run-fail",
        role: "worker",
        issueId: "issue-1",
        issueIdentifier: "TEST-1",
        attempt: null,
        turnNumber: 1,
        prompt: "work",
        workspaceKey: "TEST-1",
        workspacePath: "/tmp/workspace",
      }),
    ).rejects.toThrow("disk full");
    expect(store.projectionRevision()).toBe(0);
    expect(events).toEqual([]);
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

import { promises as nodeFs } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileRunTranscriptStore } from "../src/core/persistence/RunTranscriptStore.js";

async function startBasicRun(
  store: FileRunTranscriptStore,
  runId: string,
  overrides: Partial<Parameters<FileRunTranscriptStore["startRun"]>[0]> = {},
): Promise<void> {
  await store.startRun({
    ...overrides,
    runId,
    role: "worker",
    issueId: "issue-1",
    issueIdentifier: "TEST-1",
    attempt: null,
    turnNumber: 1,
    prompt: "work",
    harnessId: "codex",
    runtimeModel: "gpt-5.5",
    runtimeMode: "agent",
    workspaceKey: "TEST-1",
    workspacePath: "/tmp/workspace",
    gitBranchName: "symphony/TEST-1",
    repoPath: "/repo",
    baseRef: "main",
  });
}

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
    expect(page).toMatchObject({
      offset: 0,
      limit: 10,
      total: 5,
      eventCount: 5,
      previousOffset: null,
      hasPrevious: false,
      hasNext: false,
      windowKind: "page",
      firstSequence: 1,
      lastSequence: 5,
      lastEventAt: "2026-01-01T00:00:01.750Z",
    });
  });

  it("backfills default project context attribution for legacy run and workspace records", async () => {
    const store = new FileRunTranscriptStore(root);
    await startBasicRun(store, "run-legacy");
    await store.upsertWorkspace({
      workspaceKey: "TEST-1",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      path: "/tmp/workspace",
      sourceKind: "git_worktree",
      repoPath: "/repo",
      baseRef: "origin/main",
      gitBranchName: "symphony/TEST-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const metaPath = path.join(root, "runs", "run-legacy", "meta.json");
    const workspacePath = path.join(root, "workspaces", "TEST-1.json");
    const runJson = JSON.parse(await readFile(metaPath, "utf8")) as Record<string, unknown>;
    delete runJson.projectContextId;
    delete runJson.projectContextLabel;
    await writeFile(metaPath, `${JSON.stringify(runJson, null, 2)}
`, "utf8");
    const workspaceJson = JSON.parse(await readFile(workspacePath, "utf8")) as Record<string, unknown>;
    delete workspaceJson.projectContextId;
    delete workspaceJson.projectContextLabel;
    await writeFile(workspacePath, `${JSON.stringify(workspaceJson, null, 2)}
`, "utf8");

    const reloaded = new FileRunTranscriptStore(root);
    await expect(reloaded.getRun("run-legacy")).resolves.toMatchObject({
      projectContextId: "default",
      projectContextLabel: "Default",
    });
    await expect(reloaded.getWorkspace("TEST-1")).resolves.toMatchObject({
      projectContextId: "default",
      projectContextLabel: "Default",
    });
  });


  it("preserves explicit non-default project context attribution on fresh run and workspace records", async () => {
    const store = new FileRunTranscriptStore(root);
    await store.startRun({
      runId: "run-docs",
      sessionId: "session-docs",
      agentId: "agent-docs",
      role: "worker",
      issueId: "issue-1",
      issueIdentifier: "DOCS-1",
      attempt: null,
      turnNumber: 1,
      prompt: "work",
      workspaceKey: "DOCS-1",
      workspacePath: "/tmp/docs-workspace",
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
    });
    await store.upsertWorkspace({
      workspaceKey: "DOCS-1",
      issueId: "issue-1",
      issueIdentifier: "DOCS-1",
      path: "/tmp/docs-workspace",
      sourceKind: "git_worktree",
      repoPath: "/repo",
      baseRef: "origin/main",
      gitBranchName: "symphony/DOCS-1",
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const reloaded = new FileRunTranscriptStore(root);
    await expect(reloaded.getRun("run-docs")).resolves.toMatchObject({
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
    });
    await expect(reloaded.getWorkspace("DOCS-1")).resolves.toMatchObject({
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
    });
  });

  it("does not backfill Cursor runtime fields onto explicit non-Cursor harness records", async () => {
    const store = new FileRunTranscriptStore(root);
    await store.startRun({
      runId: "run-hermes-acp-legacy-cursor",
      sessionId: "session-hermes-acp",
      agentId: "agent-hermes-acp",
      role: "worker",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      attempt: null,
      turnNumber: 1,
      prompt: "work",
      harnessId: "hermes_acp",
      cursorModel: "cursor-model-should-not-leak",
      cursorModelParams: [{ id: "reasoning", value: "high" }],
      cursorSettingSources: ["cursor:settings"],
      cursorMode: "plan",
      cursorAllowLargeContext: true,
      cursorWorkerAgentLifecycle: "fresh_per_run",
      workspaceKey: "TEST-1",
      workspacePath: "/tmp/workspace",
    });

    const run = await new FileRunTranscriptStore(root).getRun("run-hermes-acp-legacy-cursor");

    expect(run).toMatchObject({
      harnessId: "hermes_acp",
      runtimeModel: null,
      runtimeModelParams: [],
      runtimeSettingSources: [],
      runtimeMode: null,
      cursorModel: "cursor-model-should-not-leak",
      cursorModelParams: [{ id: "reasoning", value: "high" }],
      cursorSettingSources: ["cursor:settings"],
      cursorMode: "plan",
    });
    expect(run).not.toHaveProperty("runtimeAllowLargeContext");
    expect(run).not.toHaveProperty("runtimeAgentLifecycle");
  });

  it("replays ACP session_started runtime metadata into durable run records", async () => {
    const store = new FileRunTranscriptStore(root);
    await store.startRun({
      runId: "run-hermes-acp-runtime-replay",
      sessionId: "session-before-replay",
      agentId: "agent-before-replay",
      role: "worker",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      attempt: null,
      turnNumber: 1,
      prompt: "work",
      harnessId: "hermes_acp",
      runtimeModel: null,
      runtimeModelParams: [],
      runtimeSettingSources: ["host_hermes:PATH:hermes", "source_profile:active", "profile_prefix:symphony"],
      runtimeMode: null,
      cursorModel: "cursor-model-should-not-leak",
      cursorMode: "agent",
      workspaceKey: "TEST-1",
      workspacePath: "/tmp/workspace",
    });
    await store.appendEvent({
      runId: "run-hermes-acp-runtime-replay",
      at: "2026-01-01T00:00:00.000Z",
      source: "harness",
      eventType: "session_started",
      payload: {
        type: "session_started",
        sessionId: "profile:acp-session:run-hermes-acp-runtime-replay",
        threadId: "acp-session",
        providerId: "openrouter",
        model: "anthropic/claude-sonnet-acp",
      },
    });

    const metaPath = path.join(root, "runs", "run-hermes-acp-runtime-replay", "meta.json");
    const staleMeta = JSON.parse(await readFile(metaPath, "utf8")) as Record<string, unknown>;
    staleMeta.runtimeModel = null;
    staleMeta.runtimeSettingSources = ["host_hermes:PATH:hermes", "source_profile:active", "profile_prefix:symphony"];
    await writeFile(metaPath, `${JSON.stringify(staleMeta, null, 2)}\n`, "utf8");

    await expect(store.rebuildRunFromTranscript("run-hermes-acp-runtime-replay")).resolves.toMatchObject({
      harnessId: "hermes_acp",
      sessionId: "profile:acp-session:run-hermes-acp-runtime-replay",
      agentId: "acp-session",
      runtimeModel: "anthropic/claude-sonnet-acp",
      runtimeSettingSources: ["host_hermes:PATH:hermes", "source_profile:active", "profile_prefix:symphony", "provider:openrouter"],
      runtimeMode: null,
      cursorModel: "cursor-model-should-not-leak",
      cursorMode: "agent",
    });
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
    expect(tail).toMatchObject({
      runId: "run-tail",
      offset: 1_200,
      limit: 5,
      nextOffset: null,
      total: 1_205,
      eventCount: 5,
      previousOffset: 1_195,
      hasPrevious: true,
      hasNext: false,
      windowKind: "tail",
      firstSequence: 1_201,
      lastSequence: 1_205,
      lastEventAt: "2026-01-01T00:00:05.000Z",
    });
    expect(tail.events.map((event) => event.sequence)).toEqual([1_201, 1_202, 1_203, 1_204, 1_205]);
    expect(tail.events.map((event) => event.message)).toEqual([
      "event 1201",
      "event 1202",
      "event 1203",
      "event 1204",
      "event 1205",
    ]);

    const capped = await store.readTranscriptTail("run-tail", { limit: 9_999 });
    expect(capped).toMatchObject({
      runId: "run-tail",
      offset: 205,
      limit: 1_000,
      nextOffset: null,
      total: 1_205,
      eventCount: 1_000,
      previousOffset: 0,
      hasPrevious: true,
      hasNext: false,
      windowKind: "tail",
      firstSequence: 206,
      lastSequence: 1_205,
    });
    expect(capped.events).toHaveLength(1_000);
    expect(capped.events[0]?.sequence).toBe(206);
    expect(capped.events.at(-1)?.sequence).toBe(1_205);

    await expect(store.readTranscriptTail("missing-run", { limit: 5 })).resolves.toMatchObject({
      runId: "missing-run",
      offset: 0,
      limit: 5,
      nextOffset: null,
      total: 0,
      eventCount: 0,
      previousOffset: null,
      hasPrevious: false,
      hasNext: false,
      windowKind: "tail",
      firstSequence: null,
      lastSequence: null,
      lastEventAt: null,
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

  it("reduces activity, status, token, provider-limit, and metadata events into run state", async () => {
    const store = new FileRunTranscriptStore(root);
    await startBasicRun(store, "run-reduce");

    await store.appendEvent({
      runId: "run-reduce",
      at: "2026-01-01T00:00:00.000Z",
      source: "harness",
      eventType: "session_started",
      payload: { type: "session_started", sessionId: "session-reduce", threadId: "thread-reduce", runId: "run-reduce" },
    });
    await store.appendEvent({
      runId: "run-reduce",
      at: "2026-01-01T00:00:00.100Z",
      source: "harness",
      eventType: "run_status",
      payload: { type: "run_status", runId: "run-reduce", sdkStatus: "running", source: "initial" },
    });
    await store.appendEvent({
      runId: "run-reduce",
      at: "2026-01-01T00:00:00.200Z",
      source: "harness",
      eventType: "progress",
      message: "stream activity",
      payload: { type: "progress", message: "stream activity", activitySource: "stream" },
    });
    await store.appendEvent({
      runId: "run-reduce",
      at: "2026-01-01T00:00:00.300Z",
      source: "harness",
      eventType: "progress",
      message: "tool activity",
      payload: { type: "progress", message: "tool activity", activitySource: "tool" },
    });
    await store.appendEvent({
      runId: "run-reduce",
      at: "2026-01-01T00:00:00.400Z",
      source: "harness",
      eventType: "tokens",
      payload: { type: "tokens", tokens: { inputTokens: 7, totalTokens: 9 } },
    });
    await store.appendEvent({
      runId: "run-reduce",
      at: "2026-01-01T00:00:00.500Z",
      source: "harness",
      eventType: "tokens",
      payload: { type: "tokens", tokens: { outputTokens: 4, totalTokens: 11 } },
    });
    await store.appendEvent({
      runId: "run-reduce",
      at: "2026-01-01T00:00:00.600Z",
      source: "harness",
      eventType: "run_diagnostic",
      message: "stream reported 500",
      payload: { type: "run_diagnostic", code: "cursor_stream_status_500", message: "stream reported 500", payload: { status: 500 } },
    });
    await store.appendEvent({
      runId: "run-reduce",
      at: "2026-01-01T00:00:00.700Z",
      source: "harness",
      eventType: "provider_limit",
      payload: {
        type: "provider_limit",
        signal: {
          scope: { harnessId: "codex", providerId: "openai", model: "gpt-5.5" },
          kind: "windowed_bucket_exhausted",
          message: "provider window exhausted",
          observedAt: "2026-01-01T00:00:00.700Z",
        },
      },
    });
    await store.recordPullRequestEvent({
      runId: "run-reduce",
      action: "updated",
      at: "2026-01-01T00:00:00.750Z",
      prUrl: "https://github.com/acme/repo/pull/7",
      prNumber: 7,
      prHeadSha: "abc123",
      prBranch: "symphony/TEST-1",
      lastPushedAt: "2026-01-01T00:00:00.740Z",
    });
    await store.recordCiStatusEvent({
      runId: "run-reduce",
      at: "2026-01-01T00:00:00.800Z",
      ciStatus: "pending",
    });
    await store.appendEvent({
      runId: "run-reduce",
      at: "2026-01-01T00:00:00.850Z",
      source: "orchestrator",
      eventType: "approval_request",
      payload: { requestId: "approval-1", requestedAt: "2026-01-01T00:00:00.850Z" },
    });
    await store.appendEvent({
      runId: "run-reduce",
      at: "2026-01-01T00:00:00.875Z",
      source: "orchestrator",
      eventType: "approval_resolved",
      payload: { requestId: "approval-1", status: "approved" },
    });
    await store.appendEvent({
      runId: "run-reduce",
      at: "2026-01-01T00:00:00.900Z",
      source: "harness",
      eventType: "completed",
      payload: { type: "completed" },
    });

    const run = await store.getRun("run-reduce");

    expect(run).toMatchObject({
      sessionId: "session-reduce",
      agentId: "thread-reduce",
      status: "failed",
      completedAt: "2026-01-01T00:00:00.700Z",
      error: "provider window exhausted",
      tokens: { inputTokens: 7, outputTokens: 4, totalTokens: 11 },
      transcriptEventCount: 13,
      sdkRunStatus: "running",
      sdkRunStatusObservedAt: "2026-01-01T00:00:00.100Z",
      sdkRunStatusSource: "initial",
      activitySnapshot: {
        lastHarnessActivityAt: "2026-01-01T00:00:00.900Z",
        lastStreamActivityAt: "2026-01-01T00:00:00.200Z",
        lastDeltaOrToolActivityAt: "2026-01-01T00:00:00.300Z",
        lastToolActivityAt: "2026-01-01T00:00:00.300Z",
      },
      failureKind: "provider_limit",
      failureDiagnosticCode: "provider_limit",
      failureDiagnosticMessage: "provider window exhausted",
      failureDiagnosticAt: "2026-01-01T00:00:00.700Z",
      providerLimit: {
        message: "provider window exhausted",
        scope: { harnessId: "codex", providerId: "openai", model: "gpt-5.5" },
      },
      prUrl: "https://github.com/acme/repo/pull/7",
      prNumber: 7,
      prHeadSha: "abc123",
      prBranch: "symphony/TEST-1",
      lastPushedAt: "2026-01-01T00:00:00.740Z",
      ciStatus: "pending",
      pendingApprovalRequestId: null,
      pendingApprovalRequestedAt: null,
    });
  });

  it("rebuilds run state from persisted events after restart with deterministic terminal transitions", async () => {
    const store = new FileRunTranscriptStore(root);
    await startBasicRun(store, "run-replay");
    await store.appendEvent({
      runId: "run-replay",
      at: "2026-01-01T00:00:00.000Z",
      source: "harness",
      eventType: "session_started",
      payload: { type: "session_started", sessionId: "session-replay", threadId: "thread-replay", runId: "run-replay" },
    });
    await store.appendEvent({
      runId: "run-replay",
      at: "2026-01-01T00:00:00.050Z",
      source: "harness",
      eventType: "run_status",
      payload: { type: "run_status", runId: "run-replay", sdkStatus: "running", source: "initial" },
    });
    await store.appendEvent({
      runId: "run-replay",
      at: "2026-01-01T00:00:00.100Z",
      source: "harness",
      eventType: "progress",
      message: "used a tool",
      payload: { type: "progress", message: "used a tool", activitySource: "tool" },
    });
    await store.appendEvent({
      runId: "run-replay",
      at: "2026-01-01T00:00:00.200Z",
      source: "harness",
      eventType: "tokens",
      payload: { type: "tokens", tokens: { inputTokens: 3, outputTokens: 5, totalTokens: 8 } },
    });
    await store.recordPullRequestEvent({
      runId: "run-replay",
      action: "opened",
      at: "2026-01-01T00:00:00.300Z",
      prUrl: "https://github.com/acme/repo/pull/8",
      prNumber: 8,
      prBranch: "symphony/TEST-1",
    });
    await store.recordCiStatusEvent({ runId: "run-replay", at: "2026-01-01T00:00:00.400Z", ciStatus: "success" });
    await store.appendEvent({
      runId: "run-replay",
      at: "2026-01-01T00:00:00.500Z",
      source: "harness",
      eventType: "run_diagnostic",
      message: "wait threw",
      payload: { type: "run_diagnostic", code: "cursor_run_wait_threw", message: "wait threw" },
    });
    await store.appendEvent({
      runId: "run-replay",
      at: "2026-01-01T00:00:00.600Z",
      source: "harness",
      eventType: "failed",
      payload: { type: "failed", error: "boom" },
    });
    await store.appendEvent({
      runId: "run-replay",
      at: "2026-01-01T00:00:00.700Z",
      source: "harness",
      eventType: "completed",
      payload: { type: "completed" },
    });

    const reloaded = new FileRunTranscriptStore(root);
    const rebuilt = await reloaded.rebuildRunFromTranscript("run-replay");

    expect(rebuilt).toMatchObject({
      status: "failed",
      completedAt: "2026-01-01T00:00:00.600Z",
      error: "boom",
      tokens: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
      transcriptEventCount: 9,
      sdkRunStatus: "running",
      sdkRunStatusObservedAt: "2026-01-01T00:00:00.050Z",
      failureKind: "cursor_sdk_wait_error",
      failureDiagnosticCode: "cursor_run_wait_threw",
      failureDiagnosticMessage: "wait threw",
      activitySnapshot: {
        lastHarnessActivityAt: "2026-01-01T00:00:00.700Z",
        lastDeltaOrToolActivityAt: "2026-01-01T00:00:00.100Z",
        lastToolActivityAt: "2026-01-01T00:00:00.100Z",
      },
      prUrl: "https://github.com/acme/repo/pull/8",
      prNumber: 8,
      prBranch: "symphony/TEST-1",
      ciStatus: "success",
      gitBranchName: "symphony/TEST-1",
      repoPath: "/repo",
      baseRef: "main",
    });

    for (const scenario of [
      { runId: "run-replay-completed", eventType: "completed", status: "succeeded", completedAt: "2026-01-01T00:00:01.100Z" },
      { runId: "run-replay-cancelled", eventType: "cancelled", status: "cancelled", completedAt: "2026-01-01T00:00:02.100Z" },
    ] as const) {
      await startBasicRun(store, scenario.runId);
      await store.appendEvent({
        runId: scenario.runId,
        at: scenario.completedAt.replace(".100Z", ".000Z"),
        source: "harness",
        eventType: "session_started",
        payload: { type: "session_started", sessionId: `${scenario.runId}-session`, runId: scenario.runId },
      });
      await store.appendEvent({
        runId: scenario.runId,
        at: scenario.completedAt,
        source: "harness",
        eventType: scenario.eventType,
        payload: { type: scenario.eventType },
      });
      await expect(reloaded.rebuildRunFromTranscript(scenario.runId)).resolves.toMatchObject({
        status: scenario.status,
        completedAt: scenario.completedAt,
        transcriptEventCount: 2,
        ...(scenario.status === "cancelled" ? { cancellationOutcome: "cancelled" } : {}),
      });
    }

    for (const scenario of [
      {
        runId: "run-replay-handoff-completion-failed",
        kind: "completion_report",
        handoffAt: "2026-01-01T00:00:03.100Z",
        laterEventType: "failed",
      },
      {
        runId: "run-replay-handoff-pr-cancelled",
        kind: "pull_request_handoff",
        handoffAt: "2026-01-01T00:00:04.100Z",
        laterEventType: "cancelled",
      },
      {
        runId: "run-replay-handoff-issue-breakdown-throw",
        kind: "issue_breakdown_plan",
        handoffAt: "2026-01-01T00:00:05.100Z",
        laterEventType: null,
      },
      {
        runId: "run-replay-handoff-merge-conflict-failed",
        kind: "merge_conflict_resolution",
        handoffAt: "2026-01-01T00:00:06.100Z",
        laterEventType: "failed",
      },
    ] as const) {
      await startBasicRun(store, scenario.runId);
      await store.appendEvent({
        runId: scenario.runId,
        at: scenario.handoffAt.replace(".100Z", ".000Z"),
        source: "harness",
        eventType: "session_started",
        payload: { type: "session_started", sessionId: `${scenario.runId}-session`, runId: scenario.runId },
      });
      await store.appendEvent({
        runId: scenario.runId,
        at: scenario.handoffAt,
        source: "orchestrator",
        eventType: "handoff_terminal",
        payload: {
          kind: scenario.kind,
          status: "succeeded",
          tokens: { inputTokens: 13, outputTokens: 17, totalTokens: 30 },
          failureKind: null,
          failureDiagnosticCode: null,
          failureDiagnosticMessage: null,
          failureDiagnosticAt: null,
        },
      });
      if (scenario.laterEventType) {
        await store.appendEvent({
          runId: scenario.runId,
          at: scenario.handoffAt.replace(".100Z", ".200Z"),
          source: "harness",
          eventType: scenario.laterEventType,
          payload:
            scenario.laterEventType === "failed"
              ? { type: "failed", error: "post-handoff harness failure" }
              : { type: "cancelled" },
        });
      }
      await expect(reloaded.rebuildRunFromTranscript(scenario.runId)).resolves.toMatchObject({
        status: "succeeded",
        completedAt: scenario.handoffAt,
        error: null,
        tokens: { inputTokens: 13, outputTokens: 17, totalTokens: 30 },
        transcriptEventCount: scenario.laterEventType ? 3 : 2,
        failureKind: null,
        failureDiagnosticCode: null,
        failureDiagnosticMessage: null,
        failureDiagnosticAt: null,
      });
    }
  });

  it("rebuilds issue-breakdown planning failures that complete or exit without an accepted plan", async () => {
    const store = new FileRunTranscriptStore(root);
    const reloaded = new FileRunTranscriptStore(root);

    await startBasicRun(store, "plan-completed-no-plan", { runPhase: "issue_breakdown", runKind: "planning" });
    await store.appendEvent({
      runId: "plan-completed-no-plan",
      at: "2026-01-01T00:01:00.000Z",
      source: "harness",
      eventType: "session_started",
      payload: { type: "session_started", sessionId: "plan-completed-session", runId: "plan-completed-no-plan" },
    });
    await store.appendEvent({
      runId: "plan-completed-no-plan",
      at: "2026-01-01T00:01:00.050Z",
      source: "harness",
      eventType: "tokens",
      payload: { type: "tokens", tokens: { inputTokens: 5, outputTokens: 8, totalTokens: 13 } },
    });
    await store.appendEvent({
      runId: "plan-completed-no-plan",
      at: "2026-01-01T00:01:00.100Z",
      source: "harness",
      eventType: "completed",
      payload: { type: "completed" },
    });
    await store.appendEvent({
      runId: "plan-completed-no-plan",
      at: "2026-01-01T00:01:00.200Z",
      source: "orchestrator",
      eventType: "planning_run_failed",
      message: "Planning run completed without submit_issue_breakdown_plan",
      payload: {
        status: "failed",
        error: "Planning run completed without submit_issue_breakdown_plan",
        tokens: { inputTokens: 5, outputTokens: 8, totalTokens: 13 },
        planningFailureCount: 1,
      },
    });

    await expect(reloaded.rebuildRunFromTranscript("plan-completed-no-plan")).resolves.toMatchObject({
      status: "failed",
      completedAt: "2026-01-01T00:01:00.100Z",
      error: "Planning run completed without submit_issue_breakdown_plan",
      tokens: { inputTokens: 5, outputTokens: 8, totalTokens: 13 },
      transcriptEventCount: 4,
      runPhase: "issue_breakdown",
      runKind: "planning",
      failureKind: "planning_run_failed",
      failureDiagnosticCode: "planning_run_failed",
      failureDiagnosticMessage: "Planning run completed without submit_issue_breakdown_plan",
    });

    await startBasicRun(store, "plan-throw-no-plan", { runPhase: "issue_breakdown", runKind: "planning" });
    await store.appendEvent({
      runId: "plan-throw-no-plan",
      at: "2026-01-01T00:02:00.000Z",
      source: "harness",
      eventType: "session_started",
      payload: { type: "session_started", sessionId: "plan-throw-session", runId: "plan-throw-no-plan" },
    });
    await store.appendEvent({
      runId: "plan-throw-no-plan",
      at: "2026-01-01T00:02:00.100Z",
      source: "orchestrator",
      eventType: "planning_run_failed",
      message: "planning harness threw before submitting a plan",
      payload: {
        status: "failed",
        error: "planning harness threw before submitting a plan",
        planningFailureCount: 1,
      },
    });

    await expect(reloaded.rebuildRunFromTranscript("plan-throw-no-plan")).resolves.toMatchObject({
      status: "failed",
      completedAt: "2026-01-01T00:02:00.100Z",
      error: "planning harness threw before submitting a plan",
      transcriptEventCount: 2,
      runPhase: "issue_breakdown",
      runKind: "planning",
      failureKind: "planning_run_failed",
      failureDiagnosticCode: "planning_run_failed",
      failureDiagnosticMessage: "planning harness threw before submitting a plan",
    });
  });


  it("tracks projection revisions for successful run and workspace writes only", async () => {
    const store = new FileRunTranscriptStore(root);
    const events: Array<{ source: string; revision: number; detail?: Readonly<Record<string, unknown>> | null }> = [];
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
    expect(events).toMatchObject([
      { source: "runs", revision: 1 },
      {
        source: "runs",
        revision: 2,
        detail: { runId: "run-projection", sessionId: "run-projection", afterSequence: 0, eventCount: 1 },
      },
      { source: "runs", revision: 3 },
      { source: "workspaces", revision: 4 },
      { source: "workspaces", revision: 5 },
    ]);
    const appendDetailEvents = events[1]?.detail?.events;
    expect(Array.isArray(appendDetailEvents) ? appendDetailEvents[0] : null).toMatchObject({
      runId: "run-projection",
      sequence: 1,
      at: "2026-01-01T00:00:00.000Z",
      source: "harness",
      eventType: "progress",
    });

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
    const events: Array<{ source: string; revision: number; detail?: Readonly<Record<string, unknown>> | null }> = [];
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
    const events: Array<{ source: string; revision: number; detail?: Readonly<Record<string, unknown>> | null }> = [];
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

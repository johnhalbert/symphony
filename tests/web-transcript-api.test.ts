import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StatusServer } from "../src/app/http.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import type { Orchestrator } from "../src/core/orchestrator/Orchestrator.js";
import { FileRunTranscriptStore, type TranscriptEvent } from "../src/core/persistence/RunTranscriptStore.js";
import type { TrackerStateLists } from "../src/core/types.js";
import { WorkspaceManager } from "../src/core/workspace/WorkspaceManager.js";
import { CursorWorkspaceOpener } from "../cursor/src/CursorWorkspaceOpener.js";
import { testConfig } from "./helpers.js";

describe("GET /api/v1/web/sessions/:sessionId/transcript", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-web-transcript-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("serves direct runId transcripts before falling back to matching sessionId", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await startRun(runStore, config, { runId: "shared-id", sessionId: "direct-session", issueIdentifier: "TEST-1" });
    await runStore.appendEvent({
      runId: "shared-id",
      at: "2026-01-01T00:00:01.000Z",
      source: "harness",
      eventType: "progress",
      message: "direct run transcript",
    });
    await startRun(runStore, config, { runId: "fallback-run", sessionId: "shared-id", issueIdentifier: "TEST-2" });
    await runStore.appendEvent({
      runId: "fallback-run",
      at: "2026-01-01T00:00:02.000Z",
      source: "harness",
      eventType: "progress",
      message: "fallback session transcript",
    });

    const server = createServer(config, runStore);
    const address = await server.start();
    try {
      const directResponse = await fetch(`${baseUrl(address)}/api/v1/web/sessions/shared-id/transcript`);
      expect(directResponse.status).toBe(200);
      const directBody = (await directResponse.json()) as Array<Record<string, unknown>>;
      expectRunPrelude(directBody, { session: "direct-session", issue: "TEST-1" });
      expect(directBody.at(-1)).toMatchObject({ kind: "assistant", text: "direct run transcript" });

      const fallbackResponse = await fetch(`${baseUrl(address)}/api/v1/web/sessions/direct-session/transcript`);
      expect(fallbackResponse.status).toBe(200);
      const fallbackBody = (await fallbackResponse.json()) as Array<Record<string, unknown>>;
      expectRunPrelude(fallbackBody, { session: "direct-session", issue: "TEST-1" });
      expect(fallbackBody.at(-1)).toMatchObject({ kind: "assistant", text: "direct run transcript" });
    } finally {
      await server.stop();
    }
  });

  it("returns exact empty arrays for missing, blank, or unavailable transcript stores", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const server = createServer(config, runStore);
    const address = await server.start();
    try {
      const missingResponse = await fetch(`${baseUrl(address)}/api/v1/web/sessions/missing-run/transcript`);
      expect(missingResponse.status).toBe(200);
      expect(await missingResponse.json()).toEqual([]);

      const blankResponse = await fetch(`${baseUrl(address)}/api/v1/web/sessions/%20/transcript`);
      expect(blankResponse.status).toBe(200);
      expect(await blankResponse.json()).toEqual([]);
    } finally {
      await server.stop();
    }

    const noStoreServer = createServer(config, undefined);
    const noStoreAddress = await noStoreServer.start();
    try {
      const response = await fetch(`${baseUrl(noStoreAddress)}/api/v1/web/sessions/anything/transcript`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([]);
    } finally {
      await noStoreServer.stop();
    }
  });

  it("defaults web transcripts to a bounded recent tail instead of walking every page", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await startRun(runStore, config, { runId: "paged-run", sessionId: "paged-session", issueIdentifier: "TEST-1" });
    const tailCalls: Array<{ limit: number | undefined }> = [];
    runStore.readTranscriptEventCount = async () => {
      throw new Error("default web transcripts should use the bounded tail reader instead of counting every event");
    };
    runStore.readTranscript = async () => {
      throw new Error("default web transcripts should not use offset pagination");
    };
    runStore.readTranscriptTail = async (runId, options = {}) => {
      tailCalls.push({ limit: options.limit });
      const limit = options.limit ?? 100;
      return {
        runId,
        offset: 100,
        limit,
        nextOffset: null,
        events: Array.from({ length: limit }, (_, index) => {
          const sequence = index + 101;
          return transcriptEvent({
            runId,
            sequence,
            at: "2026-01-01T00:00:01.000Z",
            message: `event ${sequence}`,
          });
        }),
      };
    };

    const server = createServer(config, runStore);
    const address = await server.start();
    try {
      const response = await fetch(`${baseUrl(address)}/api/v1/web/sessions/paged-run/transcript`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Array<Record<string, unknown>>;
      expectRunPrelude(body, { session: "paged-session", issue: "TEST-1" });
      expect(body.slice(2)).toHaveLength(500);
      expect(body[2]).toMatchObject({ kind: "assistant", text: "event 101" });
      expect(body.at(-1)).toMatchObject({ kind: "assistant", text: "event 600" });
      expect(tailCalls).toEqual([{ limit: 500 }]);
    } finally {
      await server.stop();
    }
  });

  it("honors explicit bounded transcript pagination", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await startRun(runStore, config, { runId: "query-run", sessionId: "query-session", issueIdentifier: "TEST-1" });
    const readCalls: Array<{ offset: number | undefined; limit: number | undefined }> = [];
    runStore.readTranscriptEventCount = async () => {
      throw new Error("explicit transcript pages should not need a total count");
    };
    runStore.readTranscriptTail = async () => {
      throw new Error("explicit transcript pages should not use the tail reader");
    };
    runStore.readTranscript = async (runId, options = {}) => {
      readCalls.push({ offset: options.offset, limit: options.limit });
      const offset = options.offset ?? 0;
      const limit = options.limit ?? 100;
      return {
        runId,
        offset,
        limit,
        nextOffset: null,
        events: Array.from({ length: Math.min(limit, 3) }, (_, index) => {
          const sequence = offset + index + 1;
          return transcriptEvent({
            runId,
            sequence,
            at: "2026-01-01T00:00:01.000Z",
            message: `query event ${sequence}`,
          });
        }),
      };
    };

    const server = createServer(config, runStore);
    const address = await server.start();
    try {
      const response = await fetch(`${baseUrl(address)}/api/v1/web/sessions/query-run/transcript?offset=2&limit=9999`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Array<Record<string, unknown>>;
      expectRunPrelude(body, { session: "query-session", issue: "TEST-1" });
      expect(body.slice(2).map((message) => message.text)).toEqual(["query event 3", "query event 4", "query event 5"]);

      for (const query of ["?offset=&limit=", "?offset=bogus&limit=0", "?offset=-2&limit=-1"]) {
        const invalidResponse = await fetch(`${baseUrl(address)}/api/v1/web/sessions/query-run/transcript${query}`);
        expect(invalidResponse.status).toBe(200);
        const invalidBody = (await invalidResponse.json()) as Array<Record<string, unknown>>;
        expectRunPrelude(invalidBody, { session: "query-session", issue: "TEST-1" });
        expect(invalidBody.slice(2).map((message) => message.text)).toEqual([
          "query event 1",
          "query event 2",
          "query event 3",
        ]);
      }

      expect(readCalls).toEqual([
        { offset: 2, limit: 1_000 },
        { offset: 0, limit: 500 },
        { offset: 0, limit: 500 },
        { offset: 0, limit: 500 },
      ]);
    } finally {
      await server.stop();
    }
  });

  it("projects representative Cursor public preview payloads returned by readTranscript", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await startRun(runStore, config, { runId: "cursor-run", sessionId: "cursor-session", issueIdentifier: "TEST-1" });
    await runStore.appendEvent({
      runId: "cursor-run",
      at: "2026-01-01T00:00:01.000Z",
      source: "cursor",
      eventType: "assistant",
      message: "Cursor assistant message",
      payload: { kind: "assistant", textPreview: "actual assistant text", internalOnly: "SECRET_ASSISTANT_INTERNAL" },
    });
    await runStore.appendEvent({
      runId: "cursor-run",
      at: "2026-01-01T00:00:02.000Z",
      source: "cursor",
      eventType: "thinking",
      message: "Cursor thinking event",
      payload: { kind: "thinking", summary: "actual reasoning summary", rawThought: "SECRET_REASONING_INTERNAL" },
    });
    await runStore.appendEvent({
      runId: "cursor-run",
      at: "2026-01-01T00:00:03.000Z",
      source: "cursor",
      eventType: "tool_call",
      message: "tool shell completed",
      payload: {
        kind: "tool_call",
        name: "shell",
        status: "completed",
        callId: "call-1",
        argumentsPreview: 'command="npm test" token=[redacted]',
        resultPreview: "result preview",
        outputPreview: "output preview",
        errorPreview: "error preview",
        truncated: true,
        result: "SECRET_RAW_TOOL_RESULT",
        privateArgs: "SECRET_RAW_TOOL_ARGS",
      },
    });

    const server = createServer(config, runStore);
    const address = await server.start();
    try {
      const response = await fetch(`${baseUrl(address)}/api/v1/web/sessions/cursor-run/transcript`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Array<Record<string, unknown>>;
      expectRunPrelude(body, { session: "cursor-session", issue: "TEST-1" });
      expect(body.slice(2)).toEqual([
        { kind: "assistant", ts: "2026-01-01T00:00:01.000Z", text: "actual assistant text" },
        { kind: "thinking", ts: "2026-01-01T00:00:02.000Z", text: "actual reasoning summary" },
        {
          kind: "tool_call",
          ts: "2026-01-01T00:00:03.000Z",
          call_id: "call-1",
          name: "shell",
          status: "completed",
          args: { preview: 'command="npm test" token=[redacted]' },
          result: "result preview",
          output: "output preview",
          error: "error preview",
          truncated: true,
        },
      ]);
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("Cursor assistant message");
      expect(serialized).not.toContain("Cursor thinking event");
      expect(serialized).not.toContain("SECRET_ASSISTANT_INTERNAL");
      expect(serialized).not.toContain("SECRET_REASONING_INTERNAL");
      expect(serialized).not.toContain("SECRET_RAW_TOOL_RESULT");
      expect(serialized).not.toContain("SECRET_RAW_TOOL_ARGS");
    } finally {
      await server.stop();
    }
  });

  it("coalesces Hermes runtime assistant and tool transcript events returned by readTranscript", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await startRun(runStore, config, { runId: "hermes-run", sessionId: "hermes-session", issueIdentifier: "TEST-1" });
    await runStore.appendEvent({
      runId: "hermes-run",
      at: "2026-01-01T00:00:01.000Z",
      source: "runtime",
      eventType: "message_delta",
      message: "Hermes message delta",
      payload: { textPreview: "partial assistant text" },
    });
    await runStore.appendEvent({
      runId: "hermes-run",
      at: "2026-01-01T00:00:02.000Z",
      source: "runtime",
      eventType: "message_complete",
      message: "Hermes message complete",
      payload: { textPreview: "final assistant text", status: "completed", token: "SECRET_MESSAGE_TOKEN" },
    });
    await runStore.appendEvent({
      runId: "hermes-run",
      at: "2026-01-01T00:00:03.000Z",
      source: "runtime",
      eventType: "tool_start",
      message: "Hermes tool terminal started",
      payload: { toolId: "tool-1", name: "terminal", argsPreview: 'cmd="npm test" token=[redacted]' },
    });
    await runStore.appendEvent({
      runId: "hermes-run",
      at: "2026-01-01T00:00:04.000Z",
      source: "runtime",
      eventType: "tool_complete",
      message: "Hermes tool terminal completed",
      payload: { toolId: "tool-1", name: "terminal", resultPreview: "tests passed", rawResult: "SECRET_TOOL_RESULT" },
    });
    await runStore.appendEvent({
      runId: "hermes-run",
      at: "2026-01-01T00:00:05.000Z",
      source: "orchestrator",
      eventType: "approval_resolved",
      message: "Operator approval approved: branch -> main",
      payload: { status: "approved", decision: "approve" },
    });

    const server = createServer(config, runStore);
    const address = await server.start();
    try {
      const response = await fetch(`${baseUrl(address)}/api/v1/web/sessions/hermes-run/transcript`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Array<Record<string, unknown>>;
      expectRunPrelude(body, { session: "hermes-session", issue: "TEST-1" });
      expect(body.slice(2)).toEqual([
        { kind: "assistant", ts: "2026-01-01T00:00:02.000Z", text: "final assistant text" },
        {
          kind: "tool_call",
          ts: "2026-01-01T00:00:03.000Z",
          call_id: "tool-1",
          name: "terminal",
          status: "completed",
          args: { preview: 'cmd="npm test" token=[redacted]' },
          result: "tests passed",
        },
        {
          kind: "status",
          state: "approved",
          ts: "2026-01-01T00:00:05.000Z",
          text: "Operator approval approved: branch -> main",
        },
      ]);
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("partial assistant text");
      expect(serialized).not.toContain("SECRET_MESSAGE_TOKEN");
      expect(serialized).not.toContain("SECRET_TOOL_RESULT");
    } finally {
      await server.stop();
    }
  });

  it("serves Cursor status, system, and unknown transcript events without assistant fallback", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await startRun(runStore, config, {
      runId: "cursor-nonassistant-run",
      sessionId: "cursor-nonassistant-session",
      issueIdentifier: "TEST-1",
    });
    await runStore.appendEvent({
      runId: "cursor-nonassistant-run",
      at: "2026-01-01T00:00:01.000Z",
      source: "cursor",
      eventType: "status",
      message: "Cursor status warming",
      payload: { kind: "status", status: "warming", messagePreview: "status public preview", truncated: false },
    });
    await runStore.appendEvent({
      runId: "cursor-nonassistant-run",
      at: "2026-01-01T00:00:02.000Z",
      source: "cursor",
      eventType: "system",
      message: "Cursor system event: bootstrap",
      payload: { kind: "system", subtype: "bootstrap", messagePreview: "system public preview", truncated: false },
    });
    await runStore.appendEvent({
      runId: "cursor-nonassistant-run",
      at: "2026-01-01T00:00:03.000Z",
      source: "cursor",
      eventType: "novel_cursor_event",
    });

    const server = createServer(config, runStore);
    const address = await server.start();
    try {
      const response = await fetch(`${baseUrl(address)}/api/v1/web/sessions/cursor-nonassistant-run/transcript`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Array<Record<string, unknown>>;
      expect(body).toEqual([
        {
          kind: "user",
          ts: expect.any(String),
          from: "orchestrator",
          issue: "TEST-1",
          text: "Implement the requested web transcript route",
        },
        { kind: "status", state: "warming", ts: "2026-01-01T00:00:01.000Z", text: "status public preview" },
        {
          kind: "system",
          ts: "2026-01-01T00:00:02.000Z",
          model: "",
          cwd: "",
          workspace: "",
          session: "cursor-nonassistant-run",
          tools: [],
          note: "system public preview",
        },
        {
          kind: "status",
          state: "novel_cursor_event",
          ts: "2026-01-01T00:00:03.000Z",
          text: "novel_cursor_event",
        },
      ]);
      expect(body.map((message) => message.kind)).not.toContain("assistant");
    } finally {
      await server.stop();
    }
  });

});

function createServer(config: ReturnType<typeof testConfig>, runStore: FileRunTranscriptStore | undefined): StatusServer {
  const workspaceManager = new WorkspaceManager({
    workspace: config.workspace,
    hooks: config.hooks,
    logger: new StructuredLogger(() => undefined),
  });
  return new StatusServer({
    orchestrator: fakeOrchestrator(),
    workspaceManager,
    workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
    ...(runStore === undefined ? {} : { runStore }),
    host: "127.0.0.1",
    port: 0,
    openWorkspaceToken: "secret",
    trackerStateLists: testTrackerStateLists(),
    staleThresholdMs: 300_000,
  });
}

async function startRun(
  runStore: FileRunTranscriptStore,
  config: ReturnType<typeof testConfig>,
  input: { runId: string; sessionId: string; issueIdentifier: string },
): Promise<void> {
  await runStore.startRun({
    runId: input.runId,
    sessionId: input.sessionId,
    agentId: `agent-${input.runId}`,
    role: "worker",
    runPhase: "implementation",
    issueId: input.issueIdentifier.toLowerCase(),
    issueIdentifier: input.issueIdentifier,
    attempt: null,
    turnNumber: 1,
    prompt: "Implement the requested web transcript route",
    cursorModel: "claude-sonnet-4",
    workspaceKey: input.issueIdentifier,
    workspacePath: path.join(config.workspace.root, input.issueIdentifier),
    gitBranchName: `symphony/${input.issueIdentifier}`,
    repoPath: "/repo",
    baseRef: "main",
  });
}

function transcriptEvent(overrides: Partial<TranscriptEvent>): TranscriptEvent {
  return {
    runId: "run-1",
    sequence: 1,
    at: "2026-01-01T00:00:00.000Z",
    source: "harness",
    eventType: "progress",
    message: "message",
    ...overrides,
  };
}

function baseUrl(address: { host: string; port: number }): string {
  return `http://${address.host}:${address.port}`;
}

function expectRunPrelude(body: Array<Record<string, unknown>>, expected: { session: string; issue: string }): void {
  expect(body.slice(0, 2)).toEqual([
    {
      kind: "system",
      ts: expect.any(String),
      model: "claude-sonnet-4",
      cwd: expect.any(String),
      workspace: expected.issue,
      session: expected.session,
      tools: [],
      note: "Initialized implementation run from persisted run metadata. System prompt redacted.",
    },
    {
      kind: "user",
      ts: expect.any(String),
      from: "orchestrator",
      issue: expected.issue,
      text: "Implement the requested web transcript route",
    },
  ]);
}

function testTrackerStateLists(): TrackerStateLists {
  return {
    activeStates: ["Todo", "In Progress"],
    handoffStates: ["In Review"],
    reviewStates: ["In Review"],
    blockedStates: ["Blocked"],
    terminalStates: ["Done", "Closed", "Cancelled", "Canceled", "Duplicate"],
  };
}

function fakeOrchestrator(): Orchestrator {
  return {
    snapshot() {
      return {
        generatedAt: "2026-01-01T00:10:00.000Z",
        counts: { running: 0, retrying: 0, paused: 0 },
        running: [],
        retrying: [],
        paused: [],
        totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
        rateLimits: null,
      };
    },
    async refreshNow() {
      return undefined;
    },
  } as unknown as Orchestrator;
}

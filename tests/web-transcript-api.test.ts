import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StatusServer, type StatusServerProjectionWriter } from "../src/app/http.js";
import type { WebProjectionPayloadReader } from "../src/app/WebProjectionRepository.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import type { Orchestrator } from "../src/core/orchestrator/Orchestrator.js";
import { FileRunTranscriptStore, type TranscriptEvent } from "../src/core/persistence/RunTranscriptStore.js";
import { mapAgentEventToRunActivityEvent } from "../src/core/transcript/RunActivityEventMapper.js";
import type { RunActivityEvent } from "../src/core/runActivity/RunActivityEvent.js";
import type {
  ProjectionPayloadRecord,
  ProjectionPayloadWriteInput,
  ProjectionRevisionSelector,
  ProjectionWriteResult,
} from "../src/core/persistence/ProjectionTransactionService.js";
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
      const directBody = transcriptMessages(await directResponse.json());
      expectRunPrelude(directBody, { session: "direct-session", issue: "TEST-1" });
      expect(directBody.at(-1)).toMatchObject({ kind: "assistant", text: "direct run transcript" });

      const fallbackResponse = await fetch(`${baseUrl(address)}/api/v1/web/sessions/direct-session/transcript`);
      expect(fallbackResponse.status).toBe(200);
      const fallbackBody = transcriptMessages(await fallbackResponse.json());
      expectRunPrelude(fallbackBody, { session: "direct-session", issue: "TEST-1" });
      expect(fallbackBody.at(-1)).toMatchObject({ kind: "assistant", text: "direct run transcript" });
    } finally {
      await server.stop();
    }
  });

  it("returns empty transcript windows for missing, blank, or unavailable transcript stores", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const server = createServer(config, runStore);
    const address = await server.start();
    try {
      const missingResponse = await fetch(`${baseUrl(address)}/api/v1/web/sessions/missing-run/transcript`);
      expect(missingResponse.status).toBe(200);
      expectEmptyTranscriptWindow(await missingResponse.json(), { kind: "tail", limit: 500 });

      const blankResponse = await fetch(`${baseUrl(address)}/api/v1/web/sessions/%20/transcript`);
      expect(blankResponse.status).toBe(200);
      expectEmptyTranscriptWindow(await blankResponse.json(), { kind: "tail", limit: 500 });
    } finally {
      await server.stop();
    }

    const noStoreServer = createServer(config, undefined);
    const noStoreAddress = await noStoreServer.start();
    try {
      const response = await fetch(`${baseUrl(noStoreAddress)}/api/v1/web/sessions/anything/transcript`);
      expect(response.status).toBe(200);
      expectEmptyTranscriptWindow(await response.json(), { kind: "tail", limit: 500 });
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
      const body = transcriptMessages(await response.json());
      expectRunPrelude(body, { session: "paged-session", issue: "TEST-1" });
      expect(body.slice(2)).toHaveLength(500);
      expect(body[2]).toMatchObject({ kind: "assistant", text: "event 101" });
      expect(body.at(-1)).toMatchObject({ kind: "assistant", text: "event 600" });
      expect(tailCalls).toEqual([{ limit: 500 }]);
    } finally {
      await server.stop();
    }
  });

  it("honors full transcript requests by walking every page and projecting the combined event stream", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await startRun(runStore, config, { runId: "full-run", sessionId: "full-session", issueIdentifier: "TEST-1" });
    const readCalls: Array<{ offset: number | undefined; limit: number | undefined }> = [];
    runStore.readTranscriptTail = async () => {
      throw new Error("full transcript requests should not use the bounded tail reader");
    };
    runStore.readTranscript = async (runId, options = {}) => {
      readCalls.push({ offset: options.offset, limit: options.limit });
      if ((options.offset ?? 0) === 0) {
        return {
          runId,
          offset: 0,
          limit: options.limit ?? 1_000,
          nextOffset: 2,
          total: 4,
          events: [
            transcriptEvent({
              runId,
              sequence: 1,
              at: "2026-01-01T00:00:01.000Z",
              eventType: "tool_start",
              payload: { callId: "call-1", name: "shell", argumentsPreview: "npm test" },
            }),
            transcriptEvent({
              runId,
              sequence: 2,
              at: "2026-01-01T00:00:02.000Z",
              eventType: "message_delta",
              payload: { text: "this" },
            }),
          ],
        };
      }
      return {
        runId,
        offset: options.offset ?? 2,
        limit: options.limit ?? 1_000,
        nextOffset: null,
        total: 4,
        events: [
          transcriptEvent({
            runId,
            sequence: 3,
            at: "2026-01-01T00:00:03.000Z",
            eventType: "message_delta",
            payload: { text: "works" },
          }),
          transcriptEvent({
            runId,
            sequence: 4,
            at: "2026-01-01T00:00:04.000Z",
            eventType: "tool_complete",
            payload: { callId: "call-1", name: "shell", resultPreview: "tests passed" },
          }),
        ],
      };
    };

    const server = createServer(config, runStore);
    const address = await server.start();
    try {
      const response = await fetch(`${baseUrl(address)}/api/v1/web/sessions/full-run/transcript?full=1`);
      expect(response.status).toBe(200);
      const responseBody = await response.json();
      const body = transcriptMessages(responseBody);
      expectRunPrelude(body, { session: "full-session", issue: "TEST-1" });
      expect(body.slice(2)).toEqual([
        {
          kind: "tool_call",
          ts: "2026-01-01T00:00:01.000Z",
          call_id: "call-1",
          name: "shell",
          status: "completed",
          args: { preview: "npm test" },
          result: "tests passed",
        },
        { kind: "assistant", ts: "2026-01-01T00:00:02.000Z", text: "this works" },
      ]);
      expect(responseBody).toMatchObject({
        page: {
          offset: 0,
          limit: 4,
          size: 4,
          total: 4,
          nextOffset: null,
          hasNext: false,
        },
        window: {
          kind: "page",
          requested: { offset: 0, limit: 4 },
          messageCount: 4,
        },
        activeTail: {
          enabled: false,
          canAppend: false,
          runStatus: "running",
        },
      });
      expect(readCalls).toEqual([
        { offset: 0, limit: 1_000 },
        { offset: 2, limit: 1_000 },
      ]);
    } finally {
      await server.stop();
    }
  });

  it("bypasses durable projections for running default transcript tails but still honors explicit durable pages", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await startRun(runStore, config, { runId: "active-run", sessionId: "active-session", issueIdentifier: "TEST-1" });
    await runStore.appendEvent({
      runId: "active-run",
      at: "2026-01-01T00:00:01.000Z",
      source: "harness",
      eventType: "progress",
      message: "live event 1",
    });
    await runStore.appendEvent({
      runId: "active-run",
      at: "2026-01-01T00:00:02.000Z",
      source: "harness",
      eventType: "progress",
      message: "live event 2",
    });
    const durablePayload = [{ kind: "assistant", text: "stale durable transcript" }];
    const projectionReader = new StaticProjectionReader(durablePayload, [
      { source: "runStore", revision: 0, observedAt: null },
    ]);
    const projectionWriter = new RecordingProjectionWriter();
    const server = createServer(config, runStore, { projectionReader, projectionWriter });
    const address = await server.start();
    try {
      const liveResponse = await fetch(`${baseUrl(address)}/api/v1/web/sessions/active-run/transcript`);
      expect(liveResponse.status).toBe(200);
      const liveBodyJson = await liveResponse.json();
      const liveBody = transcriptMessages(liveBodyJson);
      expectRunPrelude(liveBody, { session: "active-session", issue: "TEST-1" });
      expect(liveBody.slice(2).map((message) => message.text)).toEqual(["live event 1", "live event 2"]);
      expect(liveBody.map((message) => message.text)).not.toContain("stale durable transcript");
      expect(liveBodyJson).toMatchObject({
        window: {
          kind: "tail",
          requested: { offset: null, limit: 500 },
          tailLimit: 500,
        },
        activeTail: {
          enabled: true,
          canAppend: true,
          tailLimit: 500,
          runStatus: "running",
        },
      });
      expect(projectionReader.selectors).toEqual([]);
      expect(projectionWriter.writes.at(-1)).toMatchObject({
        projectionName: "transcript_projection",
        scopeKind: "run_page",
        scopeKey: "active-run:offset:0:limit:500",
        fields: { runId: "active-run", sessionId: "active-session", offsetStart: 0, offsetLimit: 500 },
      });

      const explicitResponse = await fetch(`${baseUrl(address)}/api/v1/web/sessions/active-run/transcript?offset=0&limit=1`);
      expect(explicitResponse.status).toBe(200);
      const explicitBody = await explicitResponse.json();
      expect(transcriptMessages(explicitBody)).toEqual(durablePayload);
      expect(explicitBody).toMatchObject({
        window: {
          kind: "page",
          requested: { offset: 0, limit: 1 },
          tailLimit: 1,
        },
        activeTail: {
          enabled: false,
          canAppend: false,
          tailLimit: 1,
          runStatus: "running",
        },
      });
      expect(projectionReader.selectors).toEqual([
        { projectionName: "transcript_projection", scopeKind: "run_page", scopeKey: "active-run:offset:0:limit:1" },
      ]);
    } finally {
      await server.stop();
    }
  });

  it("normalizes incomplete durable transcript window envelopes before returning explicit pages", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await startRun(runStore, config, { runId: "envelope-run", sessionId: "envelope-session", issueIdentifier: "TEST-1" });
    const durableMessages = [{ kind: "assistant", text: "durable page event" }];
    const projectionReader = new StaticProjectionReader(
      {
        schemaVersion: 1,
        messages: durableMessages,
        page: {
          offset: 0,
          limit: 1,
          size: 1,
          total: 1,
          nextOffset: null,
          previousOffset: null,
          hasNext: false,
          hasPrevious: false,
          firstSequence: null,
          lastSequence: null,
          lastEventAt: null,
        },
        window: {
          kind: "page",
          tailLimit: 1,
          messageCount: 1,
          requested: { offset: 0, limit: 1 },
        },
        compatibility: { responseShape: "transcript_window", messagesField: "messages" },
      },
      [{ source: "runStore", revision: 0, observedAt: null }],
    );
    const server = createServer(config, runStore, { projectionReader });
    const address = await server.start();
    try {
      const response = await fetch(`${baseUrl(address)}/api/v1/web/sessions/envelope-run/transcript?offset=0&limit=1`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(transcriptMessages(body)).toEqual(durableMessages);
      expect(body).toMatchObject({
        window: {
          kind: "page",
          requested: { offset: 0, limit: 1 },
          tailLimit: 1,
        },
        activeTail: {
          enabled: false,
          canAppend: false,
          afterSequence: null,
          tailLimit: 1,
          runStatus: "running",
        },
        recovery: {
          strategy: "refetch",
          reason: "tail-gap",
        },
      });
      expect(projectionReader.selectors).toEqual([
        { projectionName: "transcript_projection", scopeKind: "run_page", scopeKey: "envelope-run:offset:0:limit:1" },
      ]);
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

    const projectionWriter = new RecordingProjectionWriter();
    const server = createServer(config, runStore, { projectionWriter });
    const address = await server.start();
    try {
      const response = await fetch(`${baseUrl(address)}/api/v1/web/sessions/query-run/transcript?offset=2&limit=9999`);
      expect(response.status).toBe(200);
      const responseBody = await response.json();
      const body = transcriptMessages(responseBody);
      expectRunPrelude(body, { session: "query-session", issue: "TEST-1" });
      expect(body.slice(2).map((message) => message.text)).toEqual(["query event 3", "query event 4", "query event 5"]);
      expect(responseBody).toMatchObject({
        window: {
          kind: "page",
          requested: { offset: 2, limit: 1000 },
          tailLimit: 1000,
        },
        activeTail: {
          enabled: false,
          canAppend: false,
          tailLimit: 1000,
          runStatus: "running",
        },
      });

      for (const query of ["?offset=&limit=", "?offset=bogus&limit=0", "?offset=-2&limit=-1"]) {
        const invalidResponse = await fetch(`${baseUrl(address)}/api/v1/web/sessions/query-run/transcript${query}`);
        expect(invalidResponse.status).toBe(200);
        const invalidBodyJson = await invalidResponse.json();
        const invalidBody = transcriptMessages(invalidBodyJson);
        expect(invalidBodyJson).toMatchObject({
          window: {
            requested: { offset: 0, limit: 500 },
            tailLimit: 500,
          },
          activeTail: {
            enabled: false,
            canAppend: false,
            tailLimit: 500,
          },
        });
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
      expect(projectionWriter.writes).toHaveLength(4);
      expect(projectionWriter.writes[0]).toMatchObject({
        projectionName: "transcript_projection",
        scopeKind: "run_page",
        scopeKey: "query-run:offset:2:limit:1000",
        fields: {
          issueKey: "TEST-1",
          runId: "query-run",
          sessionId: "query-session",
          offsetStart: 2,
          offsetLimit: 1_000,
          nextOffset: null,
          messageCount: 5,
        },
        sourceCursors: {
          runId: "query-run",
          sessionId: "query-session",
          issueKey: "TEST-1",
          offset: 2,
          limit: 1_000,
          nextOffset: null,
          eventCount: 3,
          firstSequence: 3,
          lastSequence: 5,
        },
      });
      expect(projectionWriter.writes[0]?.sourceRevisions?.map((revision) => revision.source)).toEqual(
        expect.arrayContaining(["runs", "transcript:query-run"]),
      );
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
      const body = transcriptMessages(await response.json());
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
      const body = transcriptMessages(await response.json());
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

  it("serves explicitly unsafe full Hermes tool details through the web transcript API", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const longArgs = `{\n  "command": "echo SECRET_UNSAFE_ARGUMENT",\n  "filler": "${"a".repeat(700)}"\n}`;
    const longResult = `SECRET_UNSAFE_RESULT\n${"b".repeat(700)}`;
    await startRun(runStore, config, { runId: "unsafe-hermes-run", sessionId: "unsafe-hermes-session", issueIdentifier: "TEST-1" });
    await runStore.appendEvent({
      runId: "unsafe-hermes-run",
      at: "2026-01-01T00:00:01.000Z",
      source: "runtime",
      eventType: "tool_start",
      message: "Hermes tool terminal started",
      payload: {
        toolId: "tool-unsafe",
        name: "terminal",
        argsPreview: longArgs,
        redacted: false,
        unsafeToolDetails: true,
      },
    });
    await runStore.appendEvent({
      runId: "unsafe-hermes-run",
      at: "2026-01-01T00:00:02.000Z",
      source: "runtime",
      eventType: "tool_complete",
      message: "Hermes tool terminal completed",
      payload: {
        toolId: "tool-unsafe",
        name: "terminal",
        resultPreview: longResult,
        redacted: false,
        unsafeToolDetails: true,
      },
    });

    const server = createServer(config, runStore);
    const address = await server.start();
    try {
      const response = await fetch(`${baseUrl(address)}/api/v1/web/sessions/unsafe-hermes-run/transcript?full=1`);
      expect(response.status).toBe(200);
      const body = transcriptMessages(await response.json());
      expectRunPrelude(body, { session: "unsafe-hermes-session", issue: "TEST-1" });
      expect(body.slice(2)).toEqual([
        {
          kind: "tool_call",
          ts: "2026-01-01T00:00:01.000Z",
          call_id: "tool-unsafe",
          name: "terminal",
          status: "completed",
          args: { preview: longArgs },
          result: longResult,
        },
      ]);
    } finally {
      await server.stop();
    }
  });

  it("serves persisted Hermes ACP progress deltas as one readable assistant message", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await startRun(runStore, config, { runId: "hermes-acp-run", sessionId: "hermes-acp-session", issueIdentifier: "TEST-1" });
    await runStore.appendEvent({
      runId: "hermes-acp-run",
      at: "2026-01-01T00:00:01.000Z",
      source: "harness",
      eventType: "progress",
      message: "Hel",
      payload: { type: "progress", activitySource: "delta", message: "Hel" },
    });
    await runStore.appendEvent({
      runId: "hermes-acp-run",
      at: "2026-01-01T00:00:02.000Z",
      source: "harness",
      eventType: "progress",
      message: "lo",
      payload: { type: "progress", activitySource: "delta", message: "lo" },
    });
    await runStore.appendEvent({
      runId: "hermes-acp-run",
      at: "2026-01-01T00:00:03.000Z",
      source: "harness",
      eventType: "progress",
      message: "Hermes ACP tool terminal: SECRET_TOOL_PROGRESS",
      payload: { type: "progress", activitySource: "tool", message: "Hermes ACP tool terminal: SECRET_TOOL_PROGRESS" },
    });
    await runStore.appendEvent({
      runId: "hermes-acp-run",
      at: "2026-01-01T00:00:04.000Z",
      source: "harness",
      eventType: "cancelled",
      payload: { type: "cancelled" },
    });

    const server = createServer(config, runStore);
    const address = await server.start();
    try {
      const response = await fetch(`${baseUrl(address)}/api/v1/web/sessions/hermes-acp-run/transcript`);
      expect(response.status).toBe(200);
      const body = transcriptMessages(await response.json());
      expectRunPrelude(body, { session: "hermes-acp-session", issue: "TEST-1" });
      expect(body.slice(2)).toEqual([
        { kind: "assistant", ts: "2026-01-01T00:00:01.000Z", text: "Hello" },
        { kind: "status", state: "cancelled", ts: "2026-01-01T00:00:04.000Z", text: "Run cancelled" },
      ]);
      expect(JSON.stringify(body)).not.toContain("SECRET_TOOL_PROGRESS");
    } finally {
      await server.stop();
    }
  });

  it("serves orchestrator-mapped ACP runActivity deltas with exact whitespace through the durable API", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const runId = "mapped-acp-delta-run";
    await startRun(runStore, config, { runId, sessionId: "mapped-acp-delta-session", issueIdentifier: "TEST-1" });
    const appendMappedEvent = async (event: Parameters<typeof mapAgentEventToRunActivityEvent>[0]) => {
      await runStore.appendEvent({
        runId,
        at: event.at ?? "2026-01-01T00:00:01.000Z",
        source: "harness",
        ...mapAgentEventToRunActivityEvent(event),
      });
    };
    const acpDeltaActivity = (sequence: number, text: string, at: string): RunActivityEvent => ({
      eventId: `${runId}:activity:${sequence}`,
      runSessionId: `profile:acp-session-1:${runId}`,
      occurredAt: at,
      sequence,
      sequenceSource: "harness",
      externalEventId: `external-${sequence}`,
      protocol: "acp",
      harness: "hermes_acp",
      actor: "assistant",
      channel: "chat",
      kind: "assistant_message_delta",
      text,
      payload: { runtimeSessionId: "acp-session-1", delta: true, messagePreview: text, redacted: true },
    });
    const deltaChunks = ["H", "ello", " ", "world", " token=api-delta-value", ""];
    for (const [index, text] of deltaChunks.entries()) {
      const sequence = index + 1;
      const at = `2026-01-01T00:00:0${sequence}.000Z`;
      await appendMappedEvent({
        type: "progress",
        activitySource: "delta",
        message: "legacy fallback should not persist",
        at,
        runActivity: acpDeltaActivity(sequence, text, at),
      });
    }
    await appendMappedEvent({ type: "failed", error: "Run failed before message.complete", at: "2026-01-01T00:00:07.000Z" });

    const server = createServer(config, runStore);
    const address = await server.start();
    try {
      const response = await fetch(`${baseUrl(address)}/api/v1/web/sessions/${runId}/transcript`);
      expect(response.status).toBe(200);
      const body = transcriptMessages(await response.json());
      expectRunPrelude(body, { session: "mapped-acp-delta-session", issue: "TEST-1" });
      expect(body.slice(2)).toEqual([
        { kind: "assistant", ts: "2026-01-01T00:00:01.000Z", text: "Hello world token=[redacted]" },
        { kind: "status", state: "failed", ts: "2026-01-01T00:00:07.000Z", text: "Run failed before message.complete" },
      ]);
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("api-delta-value");
      expect(serialized).not.toContain("legacy fallback should not persist");
    } finally {
      await server.stop();
    }
  });

  it("serves real Hermes runtime and harness mirrored deltas as one readable assistant message without completion", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await startRun(runStore, config, { runId: "hermes-dual-run", sessionId: "hermes-dual-session", issueIdentifier: "TEST-1" });
    await runStore.appendEvent({
      runId: "hermes-dual-run",
      at: "2026-01-01T00:00:01.000Z",
      source: "runtime",
      eventType: "message_delta",
      message: "Hermes message delta",
      payload: { harnessId: "hermes", textPreview: "Hel", redacted: true },
    });
    await runStore.appendEvent({
      runId: "hermes-dual-run",
      at: "2026-01-01T00:00:01.100Z",
      source: "harness",
      eventType: "progress",
      message: "Hel",
      payload: {
        kind: "assistant_delta",
        activitySource: "delta",
        progressKind: "assistant_delta",
        messagePreview: "Hel",
        truncated: false,
        redacted: false,
      },
    });
    await runStore.appendEvent({
      runId: "hermes-dual-run",
      at: "2026-01-01T00:00:02.000Z",
      source: "runtime",
      eventType: "message_delta",
      message: "Hermes message delta",
      payload: { harnessId: "hermes", textPreview: "lo", redacted: true },
    });
    await runStore.appendEvent({
      runId: "hermes-dual-run",
      at: "2026-01-01T00:00:02.100Z",
      source: "harness",
      eventType: "progress",
      message: "lo",
      payload: {
        kind: "assistant_delta",
        activitySource: "delta",
        progressKind: "assistant_delta",
        messagePreview: "lo",
        truncated: false,
        redacted: false,
      },
    });
    await runStore.appendEvent({
      runId: "hermes-dual-run",
      at: "2026-01-01T00:00:03.000Z",
      source: "harness",
      eventType: "failed",
      message: "Run failed before message.complete",
      payload: { kind: "terminal", status: "failed", errorPreview: "Run failed before message.complete" },
    });

    const server = createServer(config, runStore);
    const address = await server.start();
    try {
      const response = await fetch(`${baseUrl(address)}/api/v1/web/sessions/hermes-dual-run/transcript`);
      expect(response.status).toBe(200);
      const body = transcriptMessages(await response.json());
      expectRunPrelude(body, { session: "hermes-dual-session", issue: "TEST-1" });
      expect(body.slice(2)).toEqual([
        { kind: "assistant", ts: "2026-01-01T00:00:01.000Z", text: "Hello" },
        { kind: "status", state: "failed", ts: "2026-01-01T00:00:03.000Z", text: "Run failed before message.complete" },
      ]);
    } finally {
      await server.stop();
    }
  });

  it("serves whitespace-preserving assistant delta streams from persisted public transcript events", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await startRun(runStore, config, { runId: "hermes-whitespace-run", sessionId: "hermes-whitespace-session", issueIdentifier: "TEST-1" });
    await runStore.appendEvent({
      runId: "hermes-whitespace-run",
      at: "2026-01-01T00:00:01.000Z",
      source: "harness",
      eventType: "progress",
      message: "Hello",
      payload: { type: "progress", activitySource: "delta", message: "Hello" },
    });
    await runStore.appendEvent({
      runId: "hermes-whitespace-run",
      at: "2026-01-01T00:00:02.000Z",
      source: "harness",
      eventType: "progress",
      message: " ",
      payload: { type: "progress", activitySource: "delta", message: " " },
    });
    await runStore.appendEvent({
      runId: "hermes-whitespace-run",
      at: "2026-01-01T00:00:03.000Z",
      source: "harness",
      eventType: "progress",
      message: "world",
      payload: { type: "progress", activitySource: "delta", message: "world" },
    });
    await runStore.appendEvent({
      runId: "hermes-whitespace-run",
      at: "2026-01-01T00:00:04.000Z",
      source: "runtime",
      eventType: "message_delta",
      message: "Hermes message delta",
      payload: { harnessId: "hermes", textPreview: " Safe", redacted: true },
    });
    await runStore.appendEvent({
      runId: "hermes-whitespace-run",
      at: "2026-01-01T00:00:05.000Z",
      source: "runtime",
      eventType: "message_delta",
      message: "Hermes message delta",
      payload: { harnessId: "hermes", textPreview: " SECRET_API_DELTA_TOKEN", redacted: true },
    });
    await runStore.appendEvent({
      runId: "hermes-whitespace-run",
      at: "2026-01-01T00:00:06.000Z",
      source: "runtime",
      eventType: "message_delta",
      message: "Hermes message delta",
      payload: { harnessId: "hermes", textPreview: "", redacted: true },
    });

    const server = createServer(config, runStore);
    const address = await server.start();
    try {
      const response = await fetch(`${baseUrl(address)}/api/v1/web/sessions/hermes-whitespace-run/transcript`);
      expect(response.status).toBe(200);
      const body = transcriptMessages(await response.json());
      expectRunPrelude(body, { session: "hermes-whitespace-session", issue: "TEST-1" });
      expect(body.slice(2)).toEqual([
        { kind: "assistant", ts: "2026-01-01T00:00:01.000Z", text: "Hello world Safe [redacted]" },
      ]);
      expect(JSON.stringify(body)).not.toContain("SECRET_API_DELTA_TOKEN");
    } finally {
      await server.stop();
    }
  });

  it("serves persisted harness stream progress text as assistant messages", async () => {
    const config = testConfig(path.join(root, "workspaces"));
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    await startRun(runStore, config, { runId: "stream-progress-run", sessionId: "stream-progress-session", issueIdentifier: "TEST-1" });
    await runStore.appendEvent({
      runId: "stream-progress-run",
      at: "2026-01-01T00:00:01.000Z",
      source: "harness",
      eventType: "progress",
      message: "hello from stream",
      payload: { type: "progress", activitySource: "stream", message: "hello from stream" },
    });
    await runStore.appendEvent({
      runId: "stream-progress-run",
      at: "2026-01-01T00:00:02.000Z",
      source: "harness",
      eventType: "progress",
      message: "legacy progress text",
      payload: { type: "progress", message: "legacy progress text" },
    });
    await runStore.appendEvent({
      runId: "stream-progress-run",
      at: "2026-01-01T00:00:03.000Z",
      source: "harness",
      eventType: "progress",
      message: "Workspace warming",
      payload: { type: "progress", activitySource: "status", status: "warming", message: "Workspace warming" },
    });

    const server = createServer(config, runStore);
    const address = await server.start();
    try {
      const response = await fetch(`${baseUrl(address)}/api/v1/web/sessions/stream-progress-run/transcript`);
      expect(response.status).toBe(200);
      const body = transcriptMessages(await response.json());
      expectRunPrelude(body, { session: "stream-progress-session", issue: "TEST-1" });
      expect(body.slice(2)).toEqual([
        { kind: "assistant", ts: "2026-01-01T00:00:01.000Z", text: "hello from stream" },
        { kind: "assistant", ts: "2026-01-01T00:00:02.000Z", text: "legacy progress text" },
        { kind: "status", state: "warming", ts: "2026-01-01T00:00:03.000Z", text: "Workspace warming" },
      ]);
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
      const body = transcriptMessages(await response.json());
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

interface CreateServerOptions {
  projectionReader?: WebProjectionPayloadReader;
  projectionWriter?: StatusServerProjectionWriter;
}

function createServer(
  config: ReturnType<typeof testConfig>,
  runStore: FileRunTranscriptStore | undefined,
  options: CreateServerOptions = {},
): StatusServer {
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
    ...(options.projectionReader ? { projectionReader: options.projectionReader } : {}),
    ...(options.projectionWriter ? { projectionWriter: options.projectionWriter } : {}),
  });
}

class StaticProjectionReader implements WebProjectionPayloadReader {
  readonly selectors: ProjectionRevisionSelector[] = [];

  constructor(
    private readonly payload: unknown,
    private readonly sourceRevisions: ProjectionPayloadRecord["revision"]["sourceRevisions"] = [],
  ) {}

  async readCurrentPayload<TPayload = unknown>(selector: ProjectionRevisionSelector): Promise<ProjectionPayloadRecord<TPayload> | null> {
    this.selectors.push({ ...selector });
    return projectionPayloadRecord(selector, this.payload as TPayload, this.sourceRevisions);
  }
}

function projectionPayloadRecord<TPayload>(
  selector: ProjectionRevisionSelector,
  payload: TPayload,
  sourceRevisions: ProjectionPayloadRecord["revision"]["sourceRevisions"],
): ProjectionPayloadRecord<TPayload> {
  const generatedAt = "2026-01-01T00:00:00.000Z";
  return {
    revision: {
      projectionRevisionId: "test-projection-revision",
      projectionName: selector.projectionName,
      scopeKind: selector.scopeKind ?? "global",
      scopeKey: selector.scopeKey ?? "global",
      revision: 1,
      buildMode: "bootstrap",
      sourceRevisions,
      sourceCursors: {},
      sourceFreshness: [],
      contentSha256: null,
      generatedAt,
      expiresAt: null,
      supersededAt: null,
      createdAt: generatedAt,
    },
    payload,
    payloadSha256: null,
    rawPayloadRefs: [],
    generatedAt,
    expiresAt: null,
  };
}

class RecordingProjectionWriter implements StatusServerProjectionWriter {
  readonly writes: ProjectionPayloadWriteInput[] = [];

  async writeProjection(input: ProjectionPayloadWriteInput): Promise<ProjectionWriteResult> {
    this.writes.push(JSON.parse(JSON.stringify(input)) as ProjectionPayloadWriteInput);
    const requestedBuildMode = input.buildMode ?? "incremental";
    const buildMode = this.writes.length === 1 ? "bootstrap" : requestedBuildMode;
    return {
      status: "written",
      revision: {
        projectionRevisionId: this.writes.length,
        projectionName: input.projectionName,
        scopeKind: input.scopeKind ?? "global",
        scopeKey: input.scopeKey ?? "global",
        revision: this.writes.length,
        buildMode,
        sourceRevisions: [],
        sourceCursors: {},
        sourceFreshness: [],
        contentSha256: "0".repeat(64),
        generatedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: null,
        supersededAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      previousRevision: null,
      requestedBuildMode,
      buildMode,
      contentSha256: "0".repeat(64),
      payloadSha256: "1".repeat(64),
      event: null,
    };
  }
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

function transcriptMessages(body: unknown): Array<Record<string, unknown>> {
  expect(body).toMatchObject({
    schemaVersion: 1,
    messages: expect.any(Array),
    page: expect.any(Object),
    window: expect.any(Object),
    activeTail: expect.any(Object),
    recovery: expect.any(Object),
    compatibility: { responseShape: "transcript_window", messagesField: "messages" },
  });
  return (body as { messages: Array<Record<string, unknown>> }).messages;
}

function expectEmptyTranscriptWindow(body: unknown, expected: { kind: "page" | "tail"; limit: number }): void {
  expect(transcriptMessages(body)).toEqual([]);
  expect(body).toMatchObject({
    page: {
      offset: 0,
      limit: expected.limit,
      size: 0,
      total: 0,
      nextOffset: null,
      previousOffset: null,
      hasNext: false,
      hasPrevious: false,
      firstSequence: null,
      lastSequence: null,
      lastEventAt: null,
    },
    window: {
      kind: expected.kind,
      requested: { offset: expected.kind === "tail" ? null : 0, limit: expected.limit },
      tailLimit: expected.limit,
      messageCount: 0,
    },
    activeTail: {
      enabled: false,
      canAppend: false,
      afterSequence: null,
      tailLimit: expected.limit,
    },
  });
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

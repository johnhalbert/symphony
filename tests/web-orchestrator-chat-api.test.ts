import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CursorWorkspaceOpener } from "../cursor/src/CursorWorkspaceOpener.js";
import { StatusServer } from "../src/app/http.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import type { Orchestrator } from "../src/core/orchestrator/Orchestrator.js";
import { FileOrchestratorChatStore, type OrchestratorChatStore } from "../src/core/persistence/OrchestratorChatStore.js";
import type { TrackerStateLists } from "../src/core/types.js";
import { WorkspaceManager } from "../src/core/workspace/WorkspaceManager.js";
import { testConfig } from "./helpers.js";

describe("web orchestrator chat API", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-web-chat-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("serves GET HTTP 200 with the exact empty chat array before any durable messages exist", async () => {
    const { server } = createStatusServer(root);
    const address = await server.start();
    try {
      const response = await fetch(chatUrl(address));
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(JSON.parse(text)).toEqual([]);
      expect(Array.isArray(JSON.parse(text))).toBe(true);
      expect(text.trim()).toBe("[]");
      expect(text).not.toMatch(/assistant|suggestion|mock|transcript/i);
    } finally {
      await server.stop();
    }
  });

  it("persists free-form chat messages without dispatching orchestrator side effects", async () => {
    const { server, calls } = createStatusServer(root);
    const address = await server.start();
    try {
      const response = await postJson(chatUrl(address), { input: "summarize ENG-113" });
      const body = (await response.json()) as Array<{ who: string; text: string; suggestions?: string[] }>;

      expect(response.status).toBe(200);
      expect(body).toHaveLength(2);
      expect(body[0]).toMatchObject({ who: "user", text: "summarize ENG-113" });
      expect(body[1]?.who).toBe("agent");
      expect(body[1]?.text).toContain("Message saved");
      expect(body[1]?.text).toContain("No orchestration command was run");
      expect(body[1]?.suggestions).toContain("status");
      expect(calls).toEqual(zeroCallCounts());
    } finally {
      await server.stop();
    }
  });

  it("executes read-only status and inspect commands while preserving the chat transcript", async () => {
    const { server, calls } = createStatusServer(root);
    const address = await server.start();
    const url = chatUrl(address);
    try {
      const statusResponse = await postJson(url, { input: "status" });
      const statusBody = (await statusResponse.json()) as Array<{ who: string; text: string }>;
      expect(statusResponse.status).toBe(200);
      expect(statusBody.at(-1)).toMatchObject({ who: "agent" });
      expect(statusBody.at(-1)?.text).toContain("Status: 0 running");

      const inspectResponse = await postJson(url, { input: "inspect ENG-404" });
      const inspectBody = (await inspectResponse.json()) as Array<{ who: string; text: string }>;
      expect(inspectResponse.status).toBe(200);
      expect(inspectBody).toHaveLength(4);
      expect(inspectBody.at(-1)?.text).toContain("No running orchestrator issue matched ENG-404");
      expect(calls).toMatchObject({ ...zeroCallCounts(), snapshot: 1, getIssueDetails: 1 });
    } finally {
      await server.stop();
    }
  });

  it("executes explicit mutation commands only through their existing orchestrator control methods", async () => {
    const { server, calls } = createStatusServer(root);
    const address = await server.start();
    const url = chatUrl(address);
    try {
      await postJson(url, { input: "refresh" });
      await postJson(url, { input: "pause ENG-10" });
      await postJson(url, { input: "resume ENG-10" });
      const cancelResponse = await postJson(url, { input: "cancel ENG-10" });
      const body = (await cancelResponse.json()) as Array<{ who: string; text: string }>;

      expect(cancelResponse.status).toBe(200);
      expect(body.at(-1)?.text).toContain("Cancellation requested for ENG-10");
      expect(calls).toEqual({ ...zeroCallCounts(), refreshNow: 1, pauseIssue: 1, resumeIssue: 1, cancelIssue: 1 });
    } finally {
      await server.stop();
    }
  });

  it("requires the existing mutation token before chat mutation commands are persisted or executed", async () => {
    const { server, calls } = createStatusServer(root, { openWorkspaceToken: "secret" });
    const address = await server.start();
    const url = chatUrl(address);
    const rejectedRequests: Array<{ name: string; input: string; headers?: Record<string, string> }> = [
      { name: "missing token", input: "pause ENG-10" },
      { name: "empty token", input: "resume ENG-10", headers: { "x-symphony-token": "" } },
      { name: "invalid token", input: "cancel ENG-10", headers: { "x-symphony-token": "wrong" } },
      { name: "missing issue mutation", input: "pause" },
    ];
    try {
      for (const rejectedRequest of rejectedRequests) {
        const rejected = await postJson(url, { input: rejectedRequest.input }, rejectedRequest.headers);
        const rejectedBody = (await rejected.json()) as { error?: { code?: string; message?: string } };
        expect({ name: rejectedRequest.name, status: rejected.status }).toEqual({ name: rejectedRequest.name, status: 401 });
        expect(rejectedBody.error).toMatchObject({ code: "invalid_request", message: "Missing or invalid open-workspace token" });
        expect(calls).toEqual(zeroCallCounts());
        expect(await (await fetch(url)).json()).toEqual([]);
      }

      const accepted = await postJson(url, { input: "pause ENG-10" }, { "x-symphony-token": "secret" });
      const acceptedBody = (await accepted.json()) as Array<{ who: string; text: string }>;
      expect(accepted.status).toBe(200);
      expect(acceptedBody.at(-1)?.text).toContain("Pause requested for ENG-10");
      expect(calls).toEqual({ ...zeroCallCounts(), pauseIssue: 1 });
    } finally {
      await server.stop();
    }
  });

  it("reloads durable chat history from the file-backed store after server restart", async () => {
    const stateDir = path.join(root, "state");
    const first = createStatusServer(root, { orchestratorChatStore: new FileOrchestratorChatStore(stateDir) });
    const firstAddress = await first.server.start();
    try {
      await postJson(chatUrl(firstAddress), { input: "help" });
    } finally {
      await first.server.stop();
    }

    const second = createStatusServer(root, { orchestratorChatStore: new FileOrchestratorChatStore(stateDir) });
    const secondAddress = await second.server.start();
    try {
      const body = (await (await fetch(chatUrl(secondAddress))).json()) as Array<{ who: string; text: string }>;
      expect(body).toHaveLength(2);
      expect(body[0]).toMatchObject({ who: "user", text: "help" });
      expect(body[1]?.text).toContain("Supported commands");
    } finally {
      await second.server.stop();
    }
  });

  it("streams durable chat snapshots to connected web clients after message appends", async () => {
    const { server } = createStatusServer(root);
    const address = await server.start();
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      const stream = await fetch(`${chatUrl(address)}/events`, {
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      });
      expect(stream.status).toBe(200);
      expect(stream.headers.get("content-type")).toContain("text/event-stream");
      expect(stream.body).not.toBeNull();
      reader = stream.body!.getReader();

      const initial = await readStreamUntil(reader, (text) => text.includes("event: orchestrator_chat") && text.includes("data: []"));
      expect(initial).toContain(": connected");

      const posted = await postJson(chatUrl(address), { input: "status" });
      expect(posted.status).toBe(200);
      await posted.json();

      const update = await readStreamUntil(reader, (text) => text.includes("Status: 0 running"));
      expect(update).toContain("event: orchestrator_chat");
      expect(update).toContain("status");
    } finally {
      await reader?.cancel().catch(() => undefined);
      controller.abort();
      await server.stop();
    }
  });

  it("rejects invalid POST bodies with deterministic 400 error payloads and no orchestration side effects", async () => {
    const { server, calls } = createStatusServer(root);
    const address = await server.start();
    const url = chatUrl(address);
    const invalidRequests: Array<{ name: string; body?: string }> = [
      { name: "missing body" },
      { name: "missing input", body: JSON.stringify({}) },
      { name: "non-string input", body: JSON.stringify({ input: 123 }) },
      { name: "empty input", body: JSON.stringify({ input: "" }) },
      { name: "blank input", body: JSON.stringify({ input: "   " }) },
      { name: "array body", body: JSON.stringify([{ input: "hello" }]) },
      { name: "null body", body: "null" },
      { name: "malformed json", body: "{not-json" },
    ];

    try {
      for (const invalidRequest of invalidRequests) {
        const response = await fetch(
          url,
          invalidRequest.body === undefined
            ? { method: "POST" }
            : {
                method: "POST",
                headers: {
                  Accept: "application/json",
                  "Content-Type": "application/json",
                },
                body: invalidRequest.body,
              },
        );
        const body = (await response.json()) as { error?: { code?: string; message?: string } };

        expect({ name: invalidRequest.name, status: response.status }).toEqual({ name: invalidRequest.name, status: 400 });
        expect(response.headers.get("content-type")).toContain("application/json");
        expect(body.error?.code).toBe("invalid_request");
        expect(body.error?.message).toMatch(/^Web orchestrator chat request body must /);
      }
      expect(calls).toEqual(zeroCallCounts());
      expect(await (await fetch(url)).json()).toEqual([]);
    } finally {
      await server.stop();
    }
  });
});

interface OrchestratorCallCounts {
  snapshot: number;
  getIssueDetails: number;
  refreshNow: number;
  pauseIssue: number;
  resumeIssue: number;
  cancelIssue: number;
}

interface TestServerOptions {
  openWorkspaceToken?: string | null;
  orchestratorChatStore?: OrchestratorChatStore;
}

function zeroCallCounts(): OrchestratorCallCounts {
  return {
    snapshot: 0,
    getIssueDetails: 0,
    refreshNow: 0,
    pauseIssue: 0,
    resumeIssue: 0,
    cancelIssue: 0,
  };
}

function chatUrl(address: { host: string; port: number }): string {
  return "http://" + address.host + ":" + String(address.port) + "/api/v1/web/orchestrator-chat";
}

function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function readStreamUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Timed out waiting for orchestrator chat stream event")), remainingMs);
      }),
    ]);
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
    if (predicate(text)) return text;
  }
  throw new Error(`Timed out waiting for orchestrator chat stream event. Received: ${text}`);
}

function createStatusServer(root: string, options: TestServerOptions = {}): { server: StatusServer; calls: OrchestratorCallCounts } {
  const config = testConfig(path.join(root, "workspaces"));
  const { orchestrator, calls } = instrumentedOrchestrator();
  const server = new StatusServer({
    orchestrator,
    workspaceManager: new WorkspaceManager({
      workspace: config.workspace,
      hooks: config.hooks,
      logger: new StructuredLogger(() => undefined),
    }),
    workspaceOpener: new CursorWorkspaceOpener({ workspaceRoot: config.workspace.root, openerCommand: null }),
    host: "127.0.0.1",
    port: 0,
    openWorkspaceToken: options.openWorkspaceToken ?? null,
    ...(options.orchestratorChatStore ? { orchestratorChatStore: options.orchestratorChatStore } : {}),
    trackerStateLists: testTrackerStateLists(),
    staleThresholdMs: 300_000,
  });
  return { server, calls };
}

function instrumentedOrchestrator(): { orchestrator: Orchestrator; calls: OrchestratorCallCounts } {
  const calls = zeroCallCounts();
  return {
    calls,
    orchestrator: {
      snapshot() {
        calls.snapshot += 1;
        return {
          generatedAt: "2026-01-01T00:00:00.000Z",
          counts: { running: 0, retrying: 0, paused: 0, providerGates: 0 },
          providerGates: [],
          providerGateCounts: { active: 0, manual: 0, autoResume: 0 },
          running: [],
          retrying: [],
          paused: [],
          totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
          rateLimits: null,
        };
      },
      getIssueDetails() {
        calls.getIssueDetails += 1;
        return null;
      },
      async refreshNow() {
        calls.refreshNow += 1;
        return undefined;
      },
      pauseIssue() {
        calls.pauseIssue += 1;
        return undefined;
      },
      resumeIssue() {
        calls.resumeIssue += 1;
        return undefined;
      },
      async cancelIssue() {
        calls.cancelIssue += 1;
        return undefined;
      },
    } as unknown as Orchestrator,
  };
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

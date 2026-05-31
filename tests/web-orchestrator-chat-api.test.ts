import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CursorWorkspaceOpener } from "../cursor/src/CursorWorkspaceOpener.js";
import { StatusServer } from "../src/app/http.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import type { Orchestrator } from "../src/core/orchestrator/Orchestrator.js";
import {
  DEFAULT_ORCHESTRATOR_CONVERSATION_ID,
  FileOrchestratorConversationStore,
  type OrchestratorConversationStore,
} from "../src/core/persistence/OrchestratorConversationStore.js";
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

  it("serves GET HTTP 200 with the exact empty chat array and no mock response text", async () => {
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
      expect(text).not.toMatch(/assistant|suggestion|mock|command|transcript/i);
    } finally {
      await server.stop();
    }
  });

  it("accepts a valid POST body as a no-side-effect placeholder returning the exact empty chat array", async () => {
    const { server, calls } = createStatusServer(root);
    const address = await server.start();
    try {
      const response = await fetch(chatUrl(address), {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ input: "please inspect ENG-94" }),
      });
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(JSON.parse(text)).toEqual([]);
      expect(Array.isArray(JSON.parse(text))).toBe(true);
      expect(text.trim()).toBe("[]");
      expect(text).not.toContain("please inspect ENG-94");
      expect(text).not.toMatch(/assistant|suggestion|mock|command|transcript/i);
      expect(calls).toEqual(zeroCallCounts());
    } finally {
      await server.stop();
    }
  });

  it("persists valid POST messages into durable orchestrator chat without orchestration side effects", async () => {
    const store = new FileOrchestratorConversationStore(path.join(root, "state"));
    const { server, calls } = createStatusServer(root, { orchestratorConversationStore: store });
    const address = await server.start();
    try {
      const response = await fetch(chatUrl(address), {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ input: "please inspect ENG-94", messageId: "client-message-1" }),
      });
      const posted = (await response.json()) as Array<Record<string, unknown>>;

      expect(response.status).toBe(200);
      expect(posted).toHaveLength(1);
      expect(posted[0]).toMatchObject({
        id: "client-message-1",
        conversationId: DEFAULT_ORCHESTRATOR_CONVERSATION_ID,
        who: "user",
        role: "user",
        text: "please inspect ENG-94",
        status: "completed",
        metadata: {
          source: "web_orchestrator_chat",
          actionDispatched: false,
        },
      });
      expect(calls).toEqual(zeroCallCounts());

      const getResponse = await fetch(chatUrl(address));
      expect(getResponse.status).toBe(200);
      expect(await getResponse.json()).toEqual(posted);

      const replayResponse = await fetch(chatUrl(address), {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ input: "please inspect ENG-94", messageId: "client-message-1" }),
      });
      const replayed = (await replayResponse.json()) as Array<Record<string, unknown>>;
      expect(replayResponse.status).toBe(200);
      expect(replayed).toEqual(posted);
      expect(await store.listMessages()).toHaveLength(1);

      const alphaUrl = chatUrl(address) + "?conversationId=alpha";
      const alphaResponse = await fetch(alphaUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ input: "alpha scoped message" }),
      });
      const alphaPosted = (await alphaResponse.json()) as Array<Record<string, unknown>>;
      expect(alphaResponse.status).toBe(200);
      expect(alphaPosted).toMatchObject([
        {
          conversationId: "alpha",
          who: "user",
          role: "user",
          text: "alpha scoped message",
        },
      ]);
      expect(await (await fetch(alphaUrl)).json()).toEqual(alphaPosted);
      expect(await (await fetch(chatUrl(address))).json()).toEqual(posted);
      expect(calls).toEqual(zeroCallCounts());
    } finally {
      await server.stop();
    }
  });

  it("keeps web chat histories isolated for unsafe and previously colliding conversation ids", async () => {
    const stateDir = path.join(root, "state");
    const store = new FileOrchestratorConversationStore(stateDir);
    const { server, calls } = createStatusServer(root, { orchestratorConversationStore: store });
    const address = await server.start();
    const scopedUrl = (conversationId: string) => chatUrl(address) + "?conversationId=" + encodeURIComponent(conversationId);
    const postMessage = async (conversationId: string, input: string) => {
      const response = await fetch(scopedUrl(conversationId), {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ input }),
      });
      const body = (await response.json()) as Array<Record<string, unknown>>;
      expect(response.status).toBe(200);
      return body;
    };
    const readMessages = async (conversationId: string) => {
      const response = await fetch(scopedUrl(conversationId));
      const body = (await response.json()) as Array<Record<string, unknown>>;
      expect(response.status).toBe(200);
      return body;
    };

    try {
      await postMessage("a/b", "slash scoped");
      await postMessage("a_b", "underscore scoped");
      await postMessage("CaseOnly", "upper case scoped");
      await postMessage("caseonly", "lower case scoped");

      expect(await readMessages("a/b")).toMatchObject([{ conversationId: "a/b", text: "slash scoped" }]);
      expect(await readMessages("a_b")).toMatchObject([{ conversationId: "a_b", text: "underscore scoped" }]);
      expect(await readMessages("CaseOnly")).toMatchObject([{ conversationId: "CaseOnly", text: "upper case scoped" }]);
      expect(await readMessages("caseonly")).toMatchObject([{ conversationId: "caseonly", text: "lower case scoped" }]);
      expect(await (await fetch(chatUrl(address))).json()).toEqual([]);
      expect((await store.listMessages("a/b")).map((message) => message.body)).toEqual(["slash scoped"]);
      expect((await store.listMessages("a_b")).map((message) => message.body)).toEqual(["underscore scoped"]);

      const files = await readdir(path.join(stateDir, "orchestrator-conversations"));
      expect(files).toHaveLength(4);
      expect(new Set(files.map((file) => file.toLowerCase())).size).toBe(4);
      expect(files).not.toContain("a_b.json");
      expect(calls).toEqual(zeroCallCounts());
    } finally {
      await server.stop();
    }
  });

  it("serves sidebar chat from persisted orchestrator conversation messages", async () => {
    const store = new FileOrchestratorConversationStore(path.join(root, "state"));
    await store.appendMessage({
      role: "assistant",
      body: "Durable orchestration status is available.",
      status: "completed",
      metadata: { token: "SECRET_VALUE", safe: "visible" },
    });
    const { server } = createStatusServer(root, { orchestratorConversationStore: store });
    const address = await server.start();
    try {
      const response = await fetch("http://" + address.host + ":" + String(address.port) + "/api/v1/web/sidebar");
      const body = (await response.json()) as { chat?: Array<Record<string, unknown>> };

      expect(response.status).toBe(200);
      expect(body.chat).toEqual([
        expect.objectContaining({
          conversationId: DEFAULT_ORCHESTRATOR_CONVERSATION_ID,
          who: "agent",
          role: "assistant",
          text: "Durable orchestration status is available.",
          metadata: { token: "[redacted]", safe: "visible" },
        }),
      ]);
    } finally {
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

function createStatusServer(
  root: string,
  options: { orchestratorConversationStore?: OrchestratorConversationStore } = {},
): { server: StatusServer; calls: OrchestratorCallCounts } {
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
    ...(options.orchestratorConversationStore === undefined
      ? {}
      : { orchestratorConversationStore: options.orchestratorConversationStore }),
    host: "127.0.0.1",
    port: 0,
    openWorkspaceToken: null,
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
          counts: { running: 0, retrying: 0, paused: 0 },
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

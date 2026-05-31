import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CursorWorkspaceOpener } from "../cursor/src/CursorWorkspaceOpener.js";
import { StatusServer } from "../src/app/http.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import type { Orchestrator } from "../src/core/orchestrator/Orchestrator.js";
import type {
  OrchestratorChatCommand,
  OrchestratorChatCommandResult,
} from "../src/core/orchestrator/OrchestratorChatCommand.js";
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

  it("rejects POST when durable orchestrator chat storage is unavailable", async () => {
    const { server, calls, commands } = createStatusServer(root);
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
      const body = (await response.json()) as { error?: { code?: string; message?: string }; chat?: unknown[] };

      expect(response.status).toBe(503);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(body.error).toEqual({
        code: "orchestrator_chat_unavailable",
        message: "Web orchestrator chat is unavailable because durable conversation storage is not configured",
      });
      expect(body.chat).toEqual([]);
      expect(calls).toEqual(zeroCallCounts());
      expect(commands).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  it("persists valid POST messages, dispatches a bounded command, and returns pending accepted state", async () => {
    const store = new FileOrchestratorConversationStore(path.join(root, "state"));
    const { server, calls, commands } = createStatusServer(root, { orchestratorConversationStore: store });
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

      expect(response.status).toBe(202);
      expect(posted).toHaveLength(1);
      expect(posted[0]).toMatchObject({
        id: "client-message-1",
        conversationId: DEFAULT_ORCHESTRATOR_CONVERSATION_ID,
        who: "user",
        role: "user",
        text: "please inspect ENG-94",
        status: "pending",
        metadata: {
          source: "web_orchestrator_chat",
          action: "orchestrator.chat.post",
          actionDispatched: true,
          commandStatus: "accepted",
          commandReason: "accepted",
        },
      });
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        action: "orchestrator.chat.post",
        source: "web",
        conversationId: DEFAULT_ORCHESTRATOR_CONVERSATION_ID,
        messageId: "client-message-1",
        input: "please inspect ENG-94",
      });
      expect(commands[0]?.requestedAt).toEqual(expect.any(String));
      expect(calls).toEqual({ ...zeroCallCounts(), dispatchOrchestratorChatCommand: 1 });

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
      expect(commands).toHaveLength(1);

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
      expect(alphaResponse.status).toBe(202);
      expect(alphaPosted).toMatchObject([
        {
          conversationId: "alpha",
          who: "user",
          role: "user",
          text: "alpha scoped message",
          status: "pending",
          metadata: { actionDispatched: true, commandStatus: "accepted" },
        },
      ]);
      expect(commands.at(-1)).toMatchObject({ conversationId: "alpha", input: "alpha scoped message" });
      expect(await (await fetch(alphaUrl)).json()).toEqual(alphaPosted);
      expect(await (await fetch(chatUrl(address))).json()).toEqual(posted);
      expect(calls).toEqual({ ...zeroCallCounts(), dispatchOrchestratorChatCommand: 2 });
    } finally {
      await server.stop();
    }
  });

  it("deduplicates concurrent POST replays for the same client message id", async () => {
    const store = new FileOrchestratorConversationStore(path.join(root, "state"));
    const { server, calls, commands } = createStatusServer(root, {
      orchestratorConversationStore: store,
      dispatchDelayMs: 50,
    });
    const address = await server.start();
    try {
      const request = {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ input: "run this once", messageId: "client-message-concurrent" }),
      };
      const responses = await Promise.all([fetch(chatUrl(address), request), fetch(chatUrl(address), request)]);
      const bodies = (await Promise.all(responses.map((response) => response.json()))) as Array<
        Array<Record<string, unknown>>
      >;

      expect(responses.map((response) => response.status).sort()).toEqual([200, 202]);
      expect(bodies[0]).toEqual(bodies[1]);
      expect(bodies[0]).toHaveLength(1);
      expect(bodies[0]?.[0]).toMatchObject({
        id: "client-message-concurrent",
        conversationId: DEFAULT_ORCHESTRATOR_CONVERSATION_ID,
        text: "run this once",
        status: "pending",
        metadata: {
          actionDispatched: true,
          commandStatus: "accepted",
          commandReason: "accepted",
        },
      });
      expect(await store.listMessages()).toHaveLength(1);
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        action: "orchestrator.chat.post",
        messageId: "client-message-concurrent",
        input: "run this once",
      });
      expect(calls).toEqual({ ...zeroCallCounts(), dispatchOrchestratorChatCommand: 1 });
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
      expect(response.status).toBe(202);
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
      expect(calls).toEqual({ ...zeroCallCounts(), dispatchOrchestratorChatCommand: 4 });
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

  it("persists an unavailable response when the orchestrator command boundary is unavailable", async () => {
    const store = new FileOrchestratorConversationStore(path.join(root, "state"));
    const { server, calls, commands } = createStatusServer(root, {
      orchestratorConversationStore: store,
      dispatchResult: { status: "unavailable", reason: "token=SECRET_VALUE" },
    });
    const address = await server.start();
    try {
      const response = await fetch(chatUrl(address), {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ input: "queue this when available", messageId: "client-message-unavailable" }),
      });
      const body = (await response.json()) as {
        error?: { code?: string; message?: string };
        chat?: Array<Record<string, unknown>>;
      };

      expect(response.status).toBe(503);
      expect(body.error).toEqual({
        code: "orchestrator_chat_unavailable",
        message: "Web orchestrator chat command dispatch is unavailable",
      });
      expect(body.chat).toHaveLength(1);
      expect(body.chat?.[0]).toMatchObject({
        id: "client-message-unavailable",
        who: "user",
        text: "queue this when available",
        status: "unavailable",
        metadata: {
          source: "web_orchestrator_chat",
          action: "orchestrator.chat.post",
          actionDispatched: true,
          commandStatus: "unavailable",
          commandReason: "token=[redacted]",
        },
      });
      expect(await store.listMessages()).toMatchObject([{ id: "client-message-unavailable", status: "unavailable" }]);
      expect(commands).toHaveLength(1);
      expect(calls).toEqual({ ...zeroCallCounts(), dispatchOrchestratorChatCommand: 1 });
    } finally {
      await server.stop();
    }
  });

  it("returns an explicit persistence error and does not dispatch when the dispatch claim update fails", async () => {
    const backingStore = new FileOrchestratorConversationStore(path.join(root, "state"));
    const store = new FailingNumberedUpdateOrchestratorConversationStore(backingStore, new Set([1]));
    const { server, calls, commands } = createStatusServer(root, { orchestratorConversationStore: store });
    const address = await server.start();
    try {
      const response = await fetch(chatUrl(address), {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ input: "claim before dispatch", messageId: "client-message-claim-fail" }),
      });
      const body = (await response.json()) as {
        error?: { code?: string; message?: string };
        chat?: Array<Record<string, unknown>>;
      };

      expect(response.status).toBe(500);
      expect(body.error).toEqual({
        code: "orchestrator_chat_persistence_failed",
        message: "Web orchestrator chat could not persist the command dispatch claim",
      });
      expect(body.chat).toHaveLength(1);
      expect(body.chat?.[0]).toMatchObject({
        id: "client-message-claim-fail",
        status: "pending",
        metadata: { actionDispatched: false, commandStatus: "pending" },
      });
      expect(await backingStore.listMessages()).toMatchObject([
        {
          id: "client-message-claim-fail",
          status: "pending",
          metadata: { actionDispatched: false, commandStatus: "pending" },
        },
      ]);
      expect(commands).toEqual([]);
      expect(calls).toEqual(zeroCallCounts());
    } finally {
      await server.stop();
    }
  });

  it("repairs durable command state when result persistence fails after dispatch", async () => {
    const backingStore = new FileOrchestratorConversationStore(path.join(root, "state"));
    const store = new FailingNumberedUpdateOrchestratorConversationStore(backingStore, new Set([2]));
    const { server, calls, commands } = createStatusServer(root, { orchestratorConversationStore: store });
    const address = await server.start();
    try {
      const response = await fetch(chatUrl(address), {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ input: "persist the outcome", messageId: "client-message-update-fail" }),
      });
      const body = (await response.json()) as {
        error?: { code?: string; message?: string };
        chat?: Array<Record<string, unknown>>;
      };

      expect(response.status).toBe(500);
      expect(body.error).toEqual({
        code: "orchestrator_chat_persistence_failed",
        message: "Web orchestrator chat could not persist the command state update",
      });
      expect(body.chat).toHaveLength(1);
      expect(body.chat?.[0]).toMatchObject({
        id: "client-message-update-fail",
        status: "failed",
        metadata: {
          actionDispatched: true,
          commandStatus: "failed",
          commandReason: "orchestrator_chat_command_state_persistence_failed",
        },
      });
      expect(commands).toHaveLength(1);
      expect(calls).toEqual({ ...zeroCallCounts(), dispatchOrchestratorChatCommand: 1 });

      const stored = await backingStore.listMessages();
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        id: "client-message-update-fail",
        status: "failed",
        metadata: {
          actionDispatched: true,
          commandStatus: "failed",
          commandReason: "orchestrator_chat_command_state_persistence_failed",
        },
      });
      expect(stored[0]?.metadata).not.toMatchObject({ actionDispatched: false, commandStatus: "pending" });

      const replay = await fetch(chatUrl(address), {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ input: "persist the outcome", messageId: "client-message-update-fail" }),
      });
      const replayed = (await replay.json()) as Array<Record<string, unknown>>;
      expect(replay.status).toBe(200);
      expect(replayed).toHaveLength(1);
      expect(replayed[0]).toMatchObject({
        id: "client-message-update-fail",
        status: "failed",
        metadata: {
          actionDispatched: true,
          commandStatus: "failed",
          commandReason: "orchestrator_chat_command_state_persistence_failed",
        },
      });
      expect(commands).toHaveLength(1);
      expect(await backingStore.listMessages()).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  it("returns an explicit persistence error and does not dispatch when durable append fails", async () => {
    const store = new FailingOrchestratorConversationStore();
    const { server, calls, commands } = createStatusServer(root, { orchestratorConversationStore: store });
    const address = await server.start();
    try {
      const response = await fetch(chatUrl(address), {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ input: "persist me first", messageId: "client-message-fail" }),
      });
      const body = (await response.json()) as { error?: { code?: string; message?: string }; chat?: unknown[] };

      expect(response.status).toBe(500);
      expect(body.error).toEqual({
        code: "orchestrator_chat_persistence_failed",
        message: "Web orchestrator chat could not persist the user message",
      });
      expect(body.chat).toEqual([]);
      expect(calls).toEqual(zeroCallCounts());
      expect(commands).toEqual([]);
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
  dispatchOrchestratorChatCommand: number;
}

function zeroCallCounts(): OrchestratorCallCounts {
  return {
    snapshot: 0,
    getIssueDetails: 0,
    refreshNow: 0,
    pauseIssue: 0,
    resumeIssue: 0,
    cancelIssue: 0,
    dispatchOrchestratorChatCommand: 0,
  };
}

function chatUrl(address: { host: string; port: number }): string {
  return "http://" + address.host + ":" + String(address.port) + "/api/v1/web/orchestrator-chat";
}

function createStatusServer(
  root: string,
  options: {
    orchestratorConversationStore?: OrchestratorConversationStore;
    dispatchResult?: OrchestratorChatCommandResult;
    dispatchDelayMs?: number;
  } = {},
): { server: StatusServer; calls: OrchestratorCallCounts; commands: OrchestratorChatCommand[] } {
  const config = testConfig(path.join(root, "workspaces"));
  const { orchestrator, calls, commands } = instrumentedOrchestrator(options.dispatchResult, options.dispatchDelayMs ?? 0);
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
  return { server, calls, commands };
}

function instrumentedOrchestrator(
  dispatchResult: OrchestratorChatCommandResult = { status: "accepted", reason: "accepted", acceptedAt: "2026-01-01T00:00:00.000Z" },
  dispatchDelayMs = 0,
): { orchestrator: Orchestrator; calls: OrchestratorCallCounts; commands: OrchestratorChatCommand[] } {
  const calls = zeroCallCounts();
  const commands: OrchestratorChatCommand[] = [];
  return {
    calls,
    commands,
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
      async dispatchOrchestratorChatCommand(command: OrchestratorChatCommand) {
        calls.dispatchOrchestratorChatCommand += 1;
        commands.push(command);
        if (dispatchDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, dispatchDelayMs));
        return dispatchResult;
      },
    } as unknown as Orchestrator,
  };
}

class FailingNumberedUpdateOrchestratorConversationStore implements OrchestratorConversationStore {
  private updateCount = 0;

  constructor(
    private readonly delegate: OrchestratorConversationStore,
    private readonly failingUpdates: ReadonlySet<number>,
  ) {}

  projectionRevision(): number {
    return this.delegate.projectionRevision();
  }

  onProjectionChanged(listener: Parameters<OrchestratorConversationStore["onProjectionChanged"]>[0]) {
    return this.delegate.onProjectionChanged(listener);
  }

  createConversation(input?: Parameters<OrchestratorConversationStore["createConversation"]>[0]) {
    return this.delegate.createConversation(input);
  }

  getConversation(input?: Parameters<OrchestratorConversationStore["getConversation"]>[0]) {
    return this.delegate.getConversation(input);
  }

  appendMessage(input: Parameters<OrchestratorConversationStore["appendMessage"]>[0]) {
    return this.delegate.appendMessage(input);
  }

  updateMessage(input: Parameters<OrchestratorConversationStore["updateMessage"]>[0]) {
    this.updateCount += 1;
    if (this.failingUpdates.has(this.updateCount)) {
      throw new Error(`forced update failure ${this.updateCount}`);
    }
    return this.delegate.updateMessage(input);
  }

  listMessages(input?: Parameters<OrchestratorConversationStore["listMessages"]>[0]) {
    return this.delegate.listMessages(input);
  }
}

class FailingOrchestratorConversationStore implements OrchestratorConversationStore {
  projectionRevision(): number {
    return 0;
  }

  onProjectionChanged(): () => void {
    return () => undefined;
  }

  async createConversation(): Promise<never> {
    throw new Error("forced persistence failure");
  }

  async getConversation(): Promise<null> {
    return null;
  }

  async appendMessage(): Promise<never> {
    throw new Error("forced persistence failure");
  }

  async updateMessage(): Promise<never> {
    throw new Error("forced persistence failure");
  }

  async listMessages(): Promise<[]> {
    return [];
  }
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

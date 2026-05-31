import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ORCHESTRATOR_CONVERSATION_ID,
  FileOrchestratorConversationStore,
} from "../src/core/persistence/OrchestratorConversationStore.js";

describe("FileOrchestratorConversationStore", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-orchestrator-conversation-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("persists conversations, sequences messages, and reloads from disk", async () => {
    const store = new FileOrchestratorConversationStore(root);
    const revisions: Array<{ source: string; revision: number }> = [];
    const unsubscribe = store.onProjectionChanged((event) => revisions.push(event));

    await store.createConversation({ metadata: { source: "test" }, at: "2026-01-01T00:00:00.000Z" });
    const user = await store.appendMessage({
      id: "message-1",
      role: "user",
      body: "hello orchestrator",
      at: "2026-01-01T00:00:01.000Z",
    });
    const assistant = await store.appendMessage({
      id: "message-2",
      role: "assistant",
      body: "hello human",
      at: "2026-01-01T00:00:02.000Z",
    });
    unsubscribe();

    expect(user.sequence).toBe(1);
    expect(assistant.sequence).toBe(2);
    expect(revisions.map((event) => event.source)).toEqual([
      "orchestrator_conversations",
      "orchestrator_conversations",
      "orchestrator_conversations",
    ]);
    expect(store.projectionRevision()).toBe(3);

    const reloaded = new FileOrchestratorConversationStore(root);
    expect(await reloaded.listMessages()).toMatchObject([
      {
        id: "message-1",
        conversationId: DEFAULT_ORCHESTRATOR_CONVERSATION_ID,
        sequence: 1,
        role: "user",
        body: "hello orchestrator",
      },
      {
        id: "message-2",
        conversationId: DEFAULT_ORCHESTRATOR_CONVERSATION_ID,
        sequence: 2,
        role: "assistant",
        body: "hello human",
      },
    ]);
  });

  it("deduplicates explicit message ids for replay-safe appends", async () => {
    const store = new FileOrchestratorConversationStore(root);

    await store.appendMessage({ id: "client-1", role: "user", body: "first request" });
    const revisionAfterFirstAppend = store.projectionRevision();
    await store.appendMessage({ id: "client-1", role: "user", body: "first request" });

    expect(await store.listMessages()).toHaveLength(1);
    expect(store.projectionRevision()).toBe(revisionAfterFirstAppend);
  });

  it("redacts sensitive bodies and metadata before durable projection", async () => {
    const store = new FileOrchestratorConversationStore(root);

    const message = await store.appendMessage({
      role: "server",
      body: ["Authorization:", "Bearer", "placeholder"].join(" "),
      metadata: {
        token: "placeholder",
        nested: {
          apiKey: "placeholder",
          safe: "visible",
        },
      },
    });

    expect(message.body).not.toContain("placeholder");
    expect(message.body).toContain("[redacted]");
    expect(message.metadata).toEqual({
      token: "[redacted]",
      nested: {
        apiKey: "[redacted]",
        safe: "visible",
      },
    });
  });

  it("supports status changes and server/system roles", async () => {
    const store = new FileOrchestratorConversationStore(root);

    const pending = await store.appendMessage({
      id: "assistant-1",
      role: "assistant",
      body: "thinking",
      status: "pending",
      transcriptLinks: [{ runId: "run-1", sequence: 1, eventType: "assistant", token: "placeholder" } as never],
    });
    expect(pending.status).toBe("pending");

    await store.updateMessage({
      messageId: "assistant-1",
      status: "streaming",
      body: "partial response",
      metadata: { phase: "streaming" },
    });
    const completed = await store.updateMessage({
      messageId: "assistant-1",
      status: "completed",
      body: "final response",
      metadata: { token: "placeholder" },
      transcriptLinks: [{ runId: "run-1", sequence: 2, eventType: "assistant_done", token: "placeholder" } as never],
    });
    const system = await store.appendMessage({ role: "system", body: "chat disabled", status: "disabled" });
    const server = await store.appendMessage({ role: "server", body: "service unavailable", status: "unavailable" });
    await store.appendMessage({ conversationId: "failure", role: "server", body: "failed", status: "failed" });

    expect(completed).toMatchObject({
      role: "assistant",
      status: "completed",
      body: "final response",
      metadata: { phase: "streaming", token: "[redacted]" },
      transcriptLinks: [{ runId: "run-1", sequence: 2, eventType: "assistant_done" }],
    });
    expect(system).toMatchObject({ role: "system", status: "disabled" });
    expect(server).toMatchObject({ role: "server", status: "unavailable" });
    expect(await store.getConversation()).toMatchObject({ status: "unavailable" });
    expect(await store.getConversation("failure")).toMatchObject({ status: "failed" });

    const reloaded = new FileOrchestratorConversationStore(root);
    expect(await reloaded.listMessages()).toMatchObject([
      { id: "assistant-1", role: "assistant", status: "completed", body: "final response" },
      { role: "system", status: "disabled", body: "chat disabled" },
      { role: "server", status: "unavailable", body: "service unavailable" },
    ]);
  });

  it("keeps independent durable histories per conversation id", async () => {
    const store = new FileOrchestratorConversationStore(root);

    await store.appendMessage({ conversationId: "alpha", role: "user", body: "alpha one" });
    await store.appendMessage({ conversationId: "beta", role: "user", body: "beta one" });

    expect((await store.listMessages("alpha")).map((message) => message.body)).toEqual(["alpha one"]);
    expect((await store.listMessages("beta")).map((message) => message.body)).toEqual(["beta one"]);
    expect(await store.listMessages()).toEqual([]);
  });
});

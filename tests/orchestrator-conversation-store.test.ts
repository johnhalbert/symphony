import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectionChangeEvent } from "../src/core/persistence/ProjectionRevision.js";
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

  it("bounds realtime projection message text to the public chat preview limit", async () => {
    const store = new FileOrchestratorConversationStore(root);
    const changes: unknown[] = [];
    const unsubscribe = store.onProjectionChanged((event) => changes.push(event.detail));

    await store.appendMessage({
      id: "large-message",
      role: "assistant",
      body: "A".repeat(12_000),
      status: "completed",
    });
    unsubscribe();

    const detail = changes.at(-1) as { chat?: Array<{ text?: unknown }> } | undefined;
    const text = detail?.chat?.[0]?.text;
    expect(typeof text).toBe("string");
    expect((text as string).length).toBeLessThanOrEqual(10_000);
    expect(text).toMatch(/\.\.\.\[truncated\]$/);
    expect(text).not.toBe("A".repeat(12_000));
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

  it("caps realtime projection chat text to the public 10,000-character preview", async () => {
    const store = new FileOrchestratorConversationStore(root);
    const events: ProjectionChangeEvent[] = [];
    store.onProjectionChanged((event) => events.push(event));

    const longBody = `operator ${"x".repeat(10_200)}`;
    await store.appendMessage({ role: "assistant", body: longBody, status: "streaming" });

    const latestEvent = events.at(-1);
    const text = (latestEvent?.detail as { chat?: Array<{ text?: string }> } | undefined)?.chat?.[0]?.text;
    expect(text).toBe(`${longBody.slice(0, 9_985)}...[truncated]`);
    expect(text).toContain("...[truncated]");
  });

  it("keeps independent durable histories per conversation id, including ids that would collide in lossy filenames", async () => {
    const store = new FileOrchestratorConversationStore(root);
    const conversations: Array<{ conversationId: string; body: string }> = [
      { conversationId: "alpha", body: "alpha one" },
      { conversationId: "beta", body: "beta one" },
      { conversationId: "a/b", body: "slash scoped" },
      { conversationId: "a_b", body: "underscore scoped" },
      { conversationId: "CaseOnly", body: "upper case scoped" },
      { conversationId: "caseonly", body: "lower case scoped" },
    ];

    for (const conversation of conversations) {
      await store.appendMessage({
        conversationId: conversation.conversationId,
        role: "user",
        body: conversation.body,
      });
    }

    for (const conversation of conversations) {
      expect((await store.listMessages(conversation.conversationId)).map((message) => message.body)).toEqual([
        conversation.body,
      ]);
    }
    expect(await store.listMessages()).toEqual([]);

    const files = await readdir(path.join(root, "orchestrator-conversations"));
    expect(files).toHaveLength(conversations.length);
    expect(new Set(files).size).toBe(conversations.length);
    expect(new Set(files.map((file) => file.toLowerCase())).size).toBe(conversations.length);
    expect(files).not.toContain("a_b.json");

    const reloaded = new FileOrchestratorConversationStore(root);
    expect((await reloaded.listMessages("a/b")).map((message) => message.body)).toEqual(["slash scoped"]);
    expect((await reloaded.listMessages("a_b")).map((message) => message.body)).toEqual(["underscore scoped"]);
    expect((await reloaded.listMessages("CaseOnly")).map((message) => message.body)).toEqual(["upper case scoped"]);
    expect((await reloaded.listMessages("caseonly")).map((message) => message.body)).toEqual(["lower case scoped"]);
  });

  it("rejects a durable record whose stored conversation id does not match the requested id", async () => {
    const store = new FileOrchestratorConversationStore(root);
    await store.appendMessage({ conversationId: "requested", role: "user", body: "request scoped" });
    const conversationsDir = path.join(root, "orchestrator-conversations");
    const [fileName] = await readdir(conversationsDir);
    if (!fileName) throw new Error("expected a persisted orchestrator conversation file");

    await writeFile(
      path.join(conversationsDir, fileName),
      `${JSON.stringify(
        {
          conversationId: "different",
          status: "completed",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          metadata: {},
          messages: [],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await expect(store.getConversation("requested")).rejects.toThrow(/conversationId.*different.*expected.*requested/);
  });
});

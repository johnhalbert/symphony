import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LEGACY_DEFAULT_PROJECT_CONTEXT_ID } from "../src/core/config/ProjectContexts.js";
import {
  OrchestratorChatProjectionReducer,
  projectOrchestratorChatProjectionPayload,
} from "../src/core/persistence/OrchestratorChatProjectionReducer.js";
import {
  DEFAULT_ORCHESTRATOR_CONVERSATION_ID,
  FileOrchestratorConversationStore,
} from "../src/core/persistence/OrchestratorConversationStore.js";
import {
  ProjectionTransactionService,
  type DurableProjectionName,
  type NormalizedProjectionRevisionSelector,
  type ProjectionPayloadInsertInput,
  type ProjectionRevisionInsertInput,
  type ProjectionRevisionRecord,
  type ProjectionRevisionSelector,
  type ProjectionTransactionRevisionPort,
  type ProjectionTransactionStore,
} from "../src/core/persistence/ProjectionTransactionService.js";

const fixedTime = "2026-01-02T03:04:05.000Z";
const defaultsByProjectionName: Record<DurableProjectionName, string> = {
  dashboard_projection: "global",
  issue_board_projection: "default-board",
  sidebar_projection: "global",
  history_projection: "global",
  transcript_projection: "global",
  orchestrator_chat_projection: "global",
};

describe("OrchestratorChatProjectionReducer", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-orchestrator-chat-projection-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("projects empty, unavailable, and disabled conversations without fabricating chat messages", async () => {
    const conversations = new FileOrchestratorConversationStore(root);
    const projectionStore = new CapturingProjectionTransactionStore();
    const reducer = new OrchestratorChatProjectionReducer(
      conversations,
      new ProjectionTransactionService(projectionStore, { clock: () => new Date(fixedTime) }),
    );

    const empty = await reducer.reduceConversation();
    await conversations.createConversation({
      conversationId: "offline",
      status: "unavailable",
      at: "2026-01-02T03:00:00.000Z",
      metadata: { reason: "orchestrator offline", apiKey: "placeholder" },
    });
    const unavailable = await reducer.reduceConversation("offline");
    await conversations.createConversation({
      conversationId: "disabled",
      status: "disabled",
      at: "2026-01-02T03:01:00.000Z",
      metadata: { reason: "operator disabled chat" },
    });
    const disabled = await reducer.reduceConversation("disabled");

    expect(empty.payload).toMatchObject({
      conversation: { id: DEFAULT_ORCHESTRATOR_CONVERSATION_ID, status: "completed", messageCount: 0 },
      state: "empty",
      status: { state: "empty", empty: true, active: false, terminal: false, messageCount: 0 },
      chat: [],
      source: { source: "orchestrator_conversations", conversationId: DEFAULT_ORCHESTRATOR_CONVERSATION_ID },
    });
    expect(empty.write.revision.sourceRevisions).toEqual([
      {
        source: `orchestrator_conversations:${DEFAULT_ORCHESTRATOR_CONVERSATION_ID}`,
        revision: empty.payload.source.revision,
        observedAt: null,
      },
    ]);

    expect(unavailable.payload).toMatchObject({
      conversation: { id: "offline", status: "unavailable", messageCount: 0, metadata: { apiKey: "[redacted]" } },
      state: "unavailable",
      status: { state: "unavailable", empty: true, active: false, terminal: true, messageCount: 0 },
      chat: [],
    });
    expect(disabled.payload).toMatchObject({
      conversation: { id: "disabled", status: "disabled", messageCount: 0 },
      state: "disabled",
      status: { state: "disabled", empty: true, active: false, terminal: true, messageCount: 0 },
      chat: [],
    });
    expect(projectionStore.payloadWrites()).toHaveLength(3);
    expect(projectionStore.payloadWrites().map((write) => write.scopeKey)).toEqual([
      DEFAULT_ORCHESTRATOR_CONVERSATION_ID,
      "offline",
      "disabled",
    ]);
  });

  it("projects append, streaming status changes, completed replies, failures, and projection lookup fields", async () => {
    const conversations = new FileOrchestratorConversationStore(root);
    const projectionStore = new CapturingProjectionTransactionStore();
    const reducer = new OrchestratorChatProjectionReducer(
      conversations,
      new ProjectionTransactionService(projectionStore, { clock: () => new Date(fixedTime) }),
    );

    await conversations.createConversation({
      metadata: { issueKey: "ENG-204", runId: "run-204", projectContextId: "docs" },
      at: "2026-01-02T03:00:00.000Z",
    });
    await conversations.appendMessage({
      id: "user-1",
      role: "user",
      body: "Please summarize ENG-204",
      at: "2026-01-02T03:00:01.000Z",
      metadata: { clientMessageId: "client-1", token: "placeholder" },
    });
    const afterUserAppend = await reducer.reduceConversation();

    await conversations.appendMessage({
      id: "assistant-1",
      role: "assistant",
      body: "Working on it",
      status: "pending",
      at: "2026-01-02T03:00:02.000Z",
    });
    const pending = await reducer.reduceConversation();

    await conversations.updateMessage({
      messageId: "assistant-1",
      status: "streaming",
      body: "Partial answer",
      at: "2026-01-02T03:00:03.000Z",
    });
    const streaming = await reducer.reduceConversation();

    await conversations.updateMessage({
      messageId: "assistant-1",
      status: "completed",
      body: "Final answer",
      at: "2026-01-02T03:00:04.000Z",
    });
    const completed = await reducer.reduceConversation();

    await conversations.appendMessage({
      conversationId: "failure",
      id: "server-1",
      role: "server",
      body: "Orchestrator command failed",
      status: "failed",
      at: "2026-01-02T03:00:05.000Z",
    });
    const failed = await reducer.reduceConversation("failure");

    expect(afterUserAppend.payload.chat).toEqual([
      expect.objectContaining({
        id: "user-1",
        conversationId: DEFAULT_ORCHESTRATOR_CONVERSATION_ID,
        who: "user",
        role: "user",
        text: "Please summarize ENG-204",
        status: "completed",
        metadata: { clientMessageId: "client-1", token: "[redacted]" },
        suggestions: [],
      }),
    ]);
    expect(afterUserAppend.payload.status).toMatchObject({ state: "completed", active: false, terminal: true, messageCount: 1 });
    expect(afterUserAppend.payload.chat).toHaveLength(1);

    expect(pending.payload.status).toMatchObject({ state: "pending", latestMessageStatus: "pending", active: true, terminal: false });
    expect(streaming.payload.status).toMatchObject({ state: "streaming", latestMessageStatus: "streaming", active: true, terminal: false });
    expect(completed.payload.status).toMatchObject({ state: "completed", latestMessageStatus: "completed", active: false, terminal: true });
    expect(completed.payload.chat).toMatchObject([
      { who: "user", text: "Please summarize ENG-204" },
      { who: "agent", role: "assistant", text: "Final answer", status: "completed" },
    ]);

    expect(failed.payload.status).toMatchObject({ state: "failed", latestMessageStatus: "failed", active: false, terminal: true });
    expect(failed.payload.chat).toMatchObject([{ who: "agent", role: "server", text: "Orchestrator command failed", status: "failed" }]);

    const defaultConversationWrites = projectionStore.payloadWrites().filter((write) => write.scopeKey === DEFAULT_ORCHESTRATOR_CONVERSATION_ID);
    expect(defaultConversationWrites.map((write) => write.revision)).toEqual([1, 2, 3, 4]);
    expect(defaultConversationWrites.at(-1)?.projectContextId).toBe("docs");
    expect(defaultConversationWrites.at(-1)?.fields).toMatchObject({
      conversationKey: DEFAULT_ORCHESTRATOR_CONVERSATION_ID,
      issueKey: "ENG-204",
      runId: "run-204",
      messageCount: 2,
    });
    expect(completed.write.revision.sourceCursors).toMatchObject({
      conversationId: DEFAULT_ORCHESTRATOR_CONVERSATION_ID,
      conversationStatus: "completed",
      state: "completed",
      messageCount: 2,
      latestMessageSequence: 2,
      latestMessageUpdatedAt: "2026-01-02T03:00:04.000Z",
      sourceRevision: completed.payload.source.revision,
    });
  });

  it("keeps a stable durable projection after restart and only advances when source content changes", async () => {
    const projectionStore = new CapturingProjectionTransactionStore();
    const firstProcessConversations = new FileOrchestratorConversationStore(root);
    await firstProcessConversations.appendMessage({
      id: "user-1",
      role: "user",
      body: "Persist me",
      at: "2026-01-02T03:00:01.000Z",
    });
    const firstReducer = new OrchestratorChatProjectionReducer(
      firstProcessConversations,
      new ProjectionTransactionService(projectionStore, { clock: () => new Date("2026-01-02T03:04:05.000Z") }),
    );
    const first = await firstReducer.reduceConversation();

    const restartedConversations = new FileOrchestratorConversationStore(root);
    const restartedReducer = new OrchestratorChatProjectionReducer(
      restartedConversations,
      new ProjectionTransactionService(projectionStore, { clock: () => new Date("2026-01-02T04:04:05.000Z") }),
    );
    const replayed = await restartedReducer.reduceConversation();
    await restartedConversations.appendMessage({
      id: "assistant-1",
      role: "assistant",
      body: "Recovered response",
      at: "2026-01-02T04:05:00.000Z",
    });
    const changed = await restartedReducer.reduceConversation();

    expect(first.write.status).toBe("written");
    expect(replayed.write.status).toBe("unchanged");
    expect(replayed.write.revision.projectionRevisionId).toBe(first.write.revision.projectionRevisionId);
    expect(replayed.payload).toEqual(first.payload);
    expect(projectionStore.payloadWrites()).toHaveLength(2);
    expect(changed.write.status).toBe("written");
    expect(changed.write.revision.revision).toBe(2);
    expect(changed.payload.chat).toMatchObject([
      { id: "user-1", who: "user", text: "Persist me" },
      { id: "assistant-1", who: "agent", text: "Recovered response" },
    ]);
  });

  it("uses canonical source revisions for direct projection payloads", () => {
    const payload = projectOrchestratorChatProjectionPayload({
      conversationId: "manual",
      status: "unavailable",
      createdAt: "2026-01-02T03:00:00.000Z",
      updatedAt: "2026-01-02T03:00:00.000Z",
      metadata: { nested: { secret: "placeholder", safe: "visible" } },
      messages: [],
    });

    expect(payload).toMatchObject({
      schemaVersion: 1,
      state: "unavailable",
      conversation: {
        id: "manual",
        status: "unavailable",
        metadata: { nested: { secret: "[redacted]", safe: "visible" } },
      },
      status: { empty: true, terminal: true },
      source: { observedAt: "2026-01-02T03:00:00.000Z" },
    });
    expect(payload.source.revision).toMatch(/^[a-f0-9]{64}$/);
  });
});

class CapturingProjectionTransactionStore implements ProjectionTransactionStore {
  private revisionRecords: ProjectionRevisionRecord[] = [];
  private payloadRecords: ProjectionPayloadInsertInput[] = [];
  private nextProjectionRevisionId = 1;

  payloadWrites(): ProjectionPayloadInsertInput[] {
    return this.payloadRecords.map(clonePayloadInsertInput);
  }

  async readCurrentRevision(selector: ProjectionRevisionSelector): Promise<ProjectionRevisionRecord | null> {
    return readCurrentRevisionFrom(this.revisionRecords, normalizeSelectorForTest(selector));
  }

  async readLatestRevision(selector: ProjectionRevisionSelector): Promise<ProjectionRevisionRecord | null> {
    return readLatestRevisionFrom(this.revisionRecords, normalizeSelectorForTest(selector));
  }

  async withTransaction<T>(operation: (transaction: ProjectionTransactionRevisionPort) => Promise<T>): Promise<T> {
    const transaction = new CapturingProjectionTransaction(
      this.revisionRecords.map(cloneRevisionRecord),
      this.payloadRecords.map(clonePayloadInsertInput),
      this.nextProjectionRevisionId,
    );
    const result = await operation(transaction);
    this.revisionRecords = transaction.revisions().map(cloneRevisionRecord);
    this.payloadRecords = transaction.payloadWrites().map(clonePayloadInsertInput);
    this.nextProjectionRevisionId = transaction.nextId();
    return result;
  }
}

class CapturingProjectionTransaction implements ProjectionTransactionRevisionPort {
  constructor(
    private readonly revisionRecords: ProjectionRevisionRecord[],
    private readonly payloadRecords: ProjectionPayloadInsertInput[],
    private nextProjectionRevisionId: number,
  ) {}

  revisions(): ProjectionRevisionRecord[] {
    return this.revisionRecords.map(cloneRevisionRecord);
  }

  payloadWrites(): ProjectionPayloadInsertInput[] {
    return this.payloadRecords.map(clonePayloadInsertInput);
  }

  nextId(): number {
    return this.nextProjectionRevisionId;
  }

  async readCurrentRevision(selector: NormalizedProjectionRevisionSelector): Promise<ProjectionRevisionRecord | null> {
    return readCurrentRevisionFrom(this.revisionRecords, selector);
  }

  async readLatestRevision(selector: NormalizedProjectionRevisionSelector): Promise<ProjectionRevisionRecord | null> {
    return readLatestRevisionFrom(this.revisionRecords, selector);
  }

  async supersedeCurrentRevision(selector: NormalizedProjectionRevisionSelector, supersededAt: string): Promise<void> {
    this.revisionRecords.splice(
      0,
      this.revisionRecords.length,
      ...this.revisionRecords.map((record) =>
        matchesSelector(record, selector) && record.supersededAt === null ? { ...record, supersededAt } : record,
      ),
    );
  }

  async insertProjectionRevision(input: ProjectionRevisionInsertInput): Promise<ProjectionRevisionRecord> {
    const record: ProjectionRevisionRecord = {
      projectionRevisionId: this.nextProjectionRevisionId,
      projectionName: input.projectionName,
      projectContextId: input.projectContextId,
      scopeKind: input.scopeKind,
      scopeKey: input.scopeKey,
      revision: input.revision,
      buildMode: input.buildMode,
      sourceRevisions: input.sourceRevisions.map((revision) => ({ ...revision })),
      sourceCursors: cloneJson(input.sourceCursors),
      sourceFreshness: input.sourceFreshness.map((freshness) => ({ ...freshness })),
      contentSha256: input.contentSha256,
      generatedAt: input.generatedAt,
      expiresAt: input.expiresAt,
      supersededAt: null,
      createdAt: input.generatedAt,
    };
    this.nextProjectionRevisionId += 1;
    this.revisionRecords.push(record);
    return cloneRevisionRecord(record);
  }

  async insertProjectionPayload(input: ProjectionPayloadInsertInput): Promise<void> {
    this.payloadRecords.push(clonePayloadInsertInput(input));
  }
}

function normalizeSelectorForTest(selector: ProjectionRevisionSelector): NormalizedProjectionRevisionSelector {
  return {
    projectionName: selector.projectionName,
    projectContextId: normalizeStringForTest(selector.projectContextId, LEGACY_DEFAULT_PROJECT_CONTEXT_ID),
    scopeKind: normalizeStringForTest(selector.scopeKind, "global"),
    scopeKey: normalizeStringForTest(selector.scopeKey, defaultsByProjectionName[selector.projectionName]),
  };
}

function normalizeStringForTest(value: string | null | undefined, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function readCurrentRevisionFrom(
  records: readonly ProjectionRevisionRecord[],
  selector: NormalizedProjectionRevisionSelector,
): ProjectionRevisionRecord | null {
  const current = records
    .filter((record) => matchesSelector(record, selector) && record.supersededAt === null)
    .sort(compareRevisionDescending)[0];
  return current ? cloneRevisionRecord(current) : null;
}

function readLatestRevisionFrom(
  records: readonly ProjectionRevisionRecord[],
  selector: NormalizedProjectionRevisionSelector,
): ProjectionRevisionRecord | null {
  const latest = records.filter((record) => matchesSelector(record, selector)).sort(compareRevisionDescending)[0];
  return latest ? cloneRevisionRecord(latest) : null;
}

function compareRevisionDescending(left: ProjectionRevisionRecord, right: ProjectionRevisionRecord): number {
  return right.revision - left.revision || right.generatedAt.localeCompare(left.generatedAt);
}

function matchesSelector(record: ProjectionRevisionRecord, selector: NormalizedProjectionRevisionSelector): boolean {
  return (
    record.projectionName === selector.projectionName &&
    record.projectContextId === selector.projectContextId &&
    record.scopeKind === selector.scopeKind &&
    record.scopeKey === selector.scopeKey
  );
}

function cloneRevisionRecord(record: ProjectionRevisionRecord): ProjectionRevisionRecord {
  return {
    ...record,
    sourceRevisions: record.sourceRevisions.map((revision) => ({ ...revision })),
    sourceCursors: cloneJson(record.sourceCursors),
  };
}

function clonePayloadInsertInput(input: ProjectionPayloadInsertInput): ProjectionPayloadInsertInput {
  return {
    ...input,
    payload: cloneJson(input.payload),
    rawPayloadRefs: cloneJson(input.rawPayloadRefs),
    fields: cloneJson(input.fields),
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

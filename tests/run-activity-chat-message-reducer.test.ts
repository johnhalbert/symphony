import { describe, expect, it } from "vitest";
import type { QueryResultRow } from "pg";
import {
  InMemoryRunActivityChatMessageReducer,
  PostgresRunActivityChatMessageReducer,
  reduceRunActivityEventsToChatMessages,
  type PostgresRunActivityChatMessageReducerClient,
} from "../src/core/persistence/RunActivityChatMessageReducer.js";
import {
  PostgresRunActivityAppendStore,
  type RunActivityAppendInput,
  type RunActivityStoredEvent,
} from "../src/core/persistence/RunActivityAppendStore.js";
import type { RunActivityEvent, RunActivityMessageKind } from "../src/core/runActivity/RunActivityEvent.js";

function messageActivity(overrides: Record<string, unknown> = {}): RunActivityEvent {
  return {
    id: "activity-message-1",
    runId: "run-chat",
    sessionId: "session-chat",
    runSessionId: "run-chat:session-chat",
    at: "2026-05-31T00:00:00.000Z",
    sequence: 1,
    sequenceSource: "harness",
    externalEventId: null,
    protocol: "json_rpc",
    harnessId: "hermes",
    actor: "assistant",
    channel: "message",
    kind: "assistant_message_delta",
    text: "Hello",
    payload: {},
    ...overrides,
  } as RunActivityEvent;
}

function statusActivity(overrides: Record<string, unknown> = {}): RunActivityEvent {
  return {
    id: "activity-status-1",
    runId: "run-chat",
    sessionId: "session-chat",
    runSessionId: "run-chat:session-chat",
    at: "2026-05-31T00:00:03.000Z",
    sequence: 4,
    sequenceSource: "harness",
    externalEventId: null,
    protocol: "json_rpc",
    harnessId: "hermes",
    actor: "runtime",
    channel: "status",
    kind: "runtime_log",
    text: "ignored status",
    payload: {},
    ...overrides,
  } as RunActivityEvent;
}

function toolActivity(overrides: Record<string, unknown> = {}): RunActivityEvent {
  return {
    id: "activity-tool-1",
    runId: "run-chat",
    sessionId: "session-chat",
    runSessionId: "run-chat:session-chat",
    at: "2026-05-31T00:00:01.000Z",
    sequence: 2,
    sequenceSource: "harness",
    externalEventId: null,
    protocol: "json_rpc",
    harnessId: "hermes",
    actor: "assistant",
    channel: "tool",
    kind: "tool_call_requested",
    text: "Run shell command",
    payload: { toolCallId: "tool-call-1", toolName: "shell.run" },
    ...overrides,
  } as RunActivityEvent;
}

function terminalActivity(overrides: Record<string, unknown> = {}): RunActivityEvent {
  return {
    id: "activity-terminal-1",
    runId: "run-chat",
    sessionId: "session-chat",
    runSessionId: "run-chat:session-chat",
    at: "2026-05-31T00:00:04.000Z",
    sequence: 4,
    sequenceSource: "harness",
    externalEventId: null,
    protocol: "json_rpc",
    harnessId: "hermes",
    actor: "runtime",
    channel: "terminal",
    kind: "run_failed",
    text: "run failed",
    payload: { reason: "run_failed" },
    ...overrides,
  } as RunActivityEvent;
}

function stored(event: RunActivityEvent, overrides: Partial<RunActivityStoredEvent["storage"]> = {}): RunActivityStoredEvent {
  return {
    event,
    metadata: {
      eventId: event.id,
      runId: event.runId,
      runSessionId: event.runSessionId,
      sequence: event.sequence,
      sequenceSource: event.sequenceSource,
      appendRevision: String(event.sequence),
      createdAt: event.at,
      externalEventId: event.externalEventId ?? null,
    },
    storage: {
      payloadSchema: null,
      payloadTruncated: false,
      payloadByteLength: null,
      rawPayloadRefId: null,
      metadata: {},
      ...overrides,
    },
  };
}

describe("RunActivityChatMessageReducer", () => {
  it("reduces ordered message events into sanitized chat_message records while ignoring non-message activity", () => {
    const messages = reduceRunActivityEventsToChatMessages(
      [
        stored(statusActivity()),
        stored(
          messageActivity({
            id: "activity-assistant-complete",
            sequence: 3,
            at: "2026-05-31T00:00:02.000Z",
            kind: "assistant_message_completed",
            text: "Hello from the assistant",
            payload: { messageId: "assistant-1", final: true, token: "SECRET_ASSISTANT_TOKEN" },
          }),
        ),
        stored(
          messageActivity({
            id: "activity-user",
            sequence: 1,
            at: "2026-05-31T00:00:00.000Z",
            actor: "user",
            kind: "user_message_submitted",
            text: "Use api_key=SECRET_USER_TOKEN for the run",
            payload: { messageId: "user-1", authorization: "Bearer sk-user-secret" },
          }),
        ),
        stored(
          messageActivity({
            id: "activity-assistant-delta",
            sequence: 2,
            at: "2026-05-31T00:00:01.000Z",
            kind: "assistant_message_delta",
            text: "Hello",
            payload: { messageId: "assistant-1", delta: true, redacted: true },
          }),
        ),
      ],
      { threadKey: "thread:eng-198", issueKey: "issue:eng-198", issueIdentifier: "ENG-198" },
    );

    expect(messages).toHaveLength(2);
    expect(messages.map((message) => [message.messageIndex, message.role, message.messageKind, message.status])).toEqual([
      [0, "user", "message", "completed"],
      [1, "assistant", "assistant_response", "completed"],
    ]);
    expect(messages[0]).toMatchObject({
      threadKey: "thread:eng-198",
      issueKey: "issue:eng-198",
      issueIdentifier: "ENG-198",
      body: "Use api_key=[redacted] for the run",
      eventSequenceStart: 1,
      eventSequenceEnd: 1,
    });
    expect(messages[1]).toMatchObject({
      body: "Hello from the assistant",
      eventSequenceStart: 2,
      eventSequenceEnd: 3,
      metadata: {
        reducedFromRunActivity: true,
        reducer: "run_activity_chat_message_v1",
        sourceEventIds: ["activity-assistant-delta", "activity-assistant-complete"],
        bodyRedacted: true,
      },
    });
    expect(JSON.stringify(messages)).not.toContain("SECRET_USER_TOKEN");
    expect(JSON.stringify(messages)).not.toContain("SECRET_ASSISTANT_TOKEN");
    expect(JSON.stringify(messages)).not.toContain("sk-user-secret");
  });

  it("reduces tool call and permission activity into coherent tool chat_message rows", () => {
    const messages = reduceRunActivityEventsToChatMessages([
      stored(
        toolActivity({
          id: "activity-tool-requested",
          sequence: 1,
          text: "shell.run requested with token=SECRET_TOOL_TOKEN",
          payload: { toolCallId: "tool-call-1", toolName: "shell.run", inputPreview: "token=SECRET_TOOL_TOKEN" },
        }),
      ),
      stored(
        toolActivity({
          id: "activity-tool-started",
          sequence: 2,
          kind: "tool_call_started",
          text: "shell.run started",
          payload: { toolCallId: "tool-call-1", toolName: "shell.run", status: "running" },
        }),
      ),
      stored(
        toolActivity({
          id: "activity-tool-progress",
          sequence: 3,
          kind: "tool_call_progress",
          text: "downloaded ",
          payload: { toolCallId: "tool-call-1", toolName: "shell.run", status: "running" },
        }),
      ),
      stored(
        toolActivity({
          id: "activity-tool-completed",
          sequence: 4,
          kind: "tool_call_completed",
          text: "done token=SECRET_TOOL_TOKEN",
          payload: { toolCallId: "tool-call-1", toolName: "shell.run", status: "succeeded" },
        }),
      ),
      stored(
        toolActivity({
          id: "activity-permission-requested",
          sequence: 5,
          kind: "tool_permission_requested",
          text: "permission requested",
          payload: { toolCallId: "permission-1", toolName: "shell.run", status: "requested" },
        }),
      ),
      stored(
        toolActivity({
          id: "activity-permission-resolved",
          sequence: 6,
          kind: "tool_permission_resolved",
          text: "permission denied token=SECRET_PERMISSION_TOKEN",
          payload: { toolCallId: "permission-1", toolName: "shell.run", status: "denied" },
        }),
      ),
    ]);

    expect(messages).toHaveLength(2);
    expect(messages.map((message) => [message.role, message.messageKind, message.status, message.eventSequenceStart, message.eventSequenceEnd])).toEqual([
      ["tool", "tool_call", "completed", 1, 4],
      ["tool", "tool_permission", "failed", 5, 6],
    ]);
    expect(messages[0]).toMatchObject({
      messageId: "run_activity:run-chat:session-chat:tool_call:tool-call-1",
      body: "done token=[redacted]",
      metadata: { sourceEventIds: ["activity-tool-requested", "activity-tool-started", "activity-tool-progress", "activity-tool-completed"], bodyRedacted: true },
    });
    expect(messages[1]).toMatchObject({
      messageId: "run_activity:run-chat:session-chat:tool_permission:permission-1",
      body: "permission denied token=[redacted]",
      metadata: { sourceEventIds: ["activity-permission-requested", "activity-permission-resolved"], bodyRedacted: true },
    });
    expect(JSON.stringify(messages)).not.toContain("SECRET_TOOL_TOKEN");
    expect(JSON.stringify(messages)).not.toContain("SECRET_PERMISSION_TOKEN");
  });

  it("marks active assistant and tool messages failed when terminal failure activity ends the run", () => {
    const messages = reduceRunActivityEventsToChatMessages([
      stored(messageActivity({ id: "activity-assistant-delta", sequence: 1, kind: "assistant_message_delta", text: "partial" })),
      stored(toolActivity({ id: "activity-tool-requested", sequence: 2, text: "shell.run requested", payload: { toolCallId: "tool-call-1", toolName: "shell.run" } })),
      stored(terminalActivity({ id: "activity-run-failed", sequence: 3, kind: "run_failed", text: "runtime failed" })),
    ]);

    expect(messages.map((message) => [message.role, message.messageKind, message.status, message.body, message.eventSequenceStart, message.eventSequenceEnd])).toEqual([
      ["assistant", "assistant_response", "failed", "partial", 1, 3],
      ["tool", "tool_call", "failed", "shell.run requested", 2, 3],
    ]);
    expect(messages[0]?.metadata).toMatchObject({ sourceEventIds: ["activity-assistant-delta", "activity-run-failed"], sourceEventSequences: [1, 3] });
    expect(messages[1]?.metadata).toMatchObject({ sourceEventIds: ["activity-tool-requested", "activity-run-failed"], sourceEventSequences: [2, 3] });
  });

  it("marks active assistant messages cancelled for terminal cancellation while missing completion remains streaming", () => {
    const missingCompletion = reduceRunActivityEventsToChatMessages([
      stored(messageActivity({ id: "activity-missing-completion", sequence: 1, kind: "assistant_message_delta", text: "partial" })),
      stored(statusActivity({ id: "activity-status", sequence: 2 })),
    ]);
    expect(missingCompletion).toHaveLength(1);
    expect(missingCompletion[0]).toMatchObject({ status: "streaming", body: "partial", eventSequenceStart: 1, eventSequenceEnd: 1 });

    const cancelled = reduceRunActivityEventsToChatMessages([
      stored(messageActivity({ id: "activity-assistant-delta", sequence: 1, kind: "assistant_message_delta", text: "partial" })),
      stored(terminalActivity({ id: "activity-run-cancelled", sequence: 2, kind: "run_cancelled", text: "operator cancelled" })),
    ]);

    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toMatchObject({ status: "cancelled", body: "partial", eventSequenceStart: 1, eventSequenceEnd: 2 });
    expect(cancelled[0]?.metadata).toMatchObject({ sourceEventIds: ["activity-assistant-delta", "activity-run-cancelled"], sourceEventSequences: [1, 2] });
  });

  it("coalesces implicit assistant delta streams, reasoning, and source truncation metadata", () => {
    const messages = reduceRunActivityEventsToChatMessages([
      stored(messageActivity({ id: "activity-reasoning-1", sequence: 1, kind: "assistant_reasoning_delta", text: "Thinking " })),
      stored(
        messageActivity({
          id: "activity-reasoning-2",
          sequence: 2,
          kind: "assistant_reasoning_available",
          text: "Thinking privately",
          payload: { final: true },
        }),
        { payloadTruncated: true, payloadByteLength: 1_000_000, rawPayloadRefId: "42" },
      ),
      stored(messageActivity({ id: "activity-delta-1", sequence: 3, kind: "assistant_message_delta", text: "Hel" })),
      stored(messageActivity({ id: "activity-delta-2", sequence: 4, kind: "assistant_message_delta", text: "lo" })),
      stored(
        messageActivity({
          id: "activity-done",
          sequence: 5,
          kind: "assistant_message_completed",
          text: null,
          payload: { final: true, messageId: "assistant-final" },
        }),
      ),
    ]);

    expect(messages.map((message) => [message.messageKind, message.status, message.body])).toEqual([
      ["assistant_reasoning", "completed", "Thinking privately"],
      ["assistant_response", "completed", "Hello"],
    ]);
    expect(messages[0]).toMatchObject({
      bodyTruncated: true,
      rawPayloadRefId: "42",
      eventSequenceStart: 1,
      eventSequenceEnd: 2,
      metadata: { sourcePayloadTruncated: true, sourcePayloadByteLength: 1_000_000 },
    });
    expect(messages[1]).toMatchObject({
      messageId: "run_activity:run-chat:session-chat:assistant_response:assistant-final",
      eventSequenceStart: 3,
      eventSequenceEnd: 5,
      metadata: { upstreamMessageId: "assistant-final" },
    });
  });

  it("rebuilds in-memory rows idempotently when an explicit pre-existing event range is replayed with backfill", async () => {
    const reducer = new InMemoryRunActivityChatMessageReducer();
    await reducer.reduceEvents([
      stored(messageActivity({ id: "activity-user", sequence: 1, actor: "user", kind: "user_message_submitted", text: "first" })),
      stored(messageActivity({ id: "activity-assistant", sequence: 3, kind: "assistant_message_completed", text: "third" })),
    ]);

    const result = await reducer.reduceEvents([
      stored(messageActivity({ id: "activity-user", sequence: 1, actor: "user", kind: "user_message_submitted", text: "first" })),
      stored(messageActivity({ id: "activity-system-backfill", sequence: 2, actor: "system", kind: "system_message", text: "second" })),
      stored(messageActivity({ id: "activity-assistant", sequence: 3, kind: "assistant_message_completed", text: "third" })),
    ]);

    expect(result).toMatchObject({ reducedEventCount: 3, ignoredEventCount: 0, upsertedCount: 3 });
    expect(reducer.listMessages().map((message) => [message.messageIndex, message.role, message.body])).toEqual([
      [0, "user", "first"],
      [1, "system", "second"],
      [2, "assistant", "third"],
    ]);
  });

  it("wraps Postgres reduction in a transaction and upserts reducer-owned chat_message rows", async () => {
    const client = new FakeChatReducerPostgresClient([
      postgresActivityRow({
        event_id: "activity:pg:user",
        sequence: 1,
        actor: "user",
        kind: "user_message_submitted",
        text: "Persist this request",
        payload: { messageId: "user-pg" },
      }),
      postgresActivityRow({
        event_id: "activity:pg:assistant",
        sequence: 2,
        actor: "assistant",
        kind: "assistant_message_completed",
        text: "Persist this response",
        payload: { messageId: "assistant-pg", final: true },
        raw_payload_ref_id: "77",
      }),
    ]);
    const reducer = new PostgresRunActivityChatMessageReducer({ connect: async () => client });

    const result = await reducer.reduceRunSession("run-chat:session-chat", { threadKey: "thread:pg" });

    expect(result).toMatchObject({ runSessionId: "run-chat:session-chat", threadKey: "thread:pg", upsertedCount: 2, deletedCount: 0 });
    expect(client.released).toBe(true);
    expect(client.normalizedStatements[0]).toBe("BEGIN");
    expect(client.normalizedStatements.at(-1)).toBe("COMMIT");
    expect(client.normalizedStatements).not.toContain("ROLLBACK");
    expect(client.insertValues).toHaveLength(2);
    expect(client.insertValues[0]?.slice(0, 13)).toEqual([
      "run_activity:run-chat:session-chat:message:user-pg",
      "thread:pg",
      "issue:eng-198",
      "ENG-198",
      "run-chat",
      "session-chat",
      0,
      "user",
      "message",
      "completed",
      "Persist this request",
      "Persist this request",
      20,
    ]);
    expect(client.insertValues[1]?.[17]).toBe("77");
    const metadata = JSON.parse(String(client.insertValues[1]?.[18]));
    expect(metadata).toMatchObject({
      reducedFromRunActivity: true,
      sourceEventIds: ["activity:pg:assistant"],
      sourceEventSequences: [2],
    });
  });

  it("reduces accepted message appends into chat_message rows in the same Postgres append transaction", async () => {
    const client = new FakeAppendAndChatReducerPostgresClient();
    const store = new PostgresRunActivityAppendStore({ connect: async () => client });

    const result = await store.appendEvent(
      messageAppendInput({
        id: "activity:append:user",
        actor: "user",
        kind: "user_message_submitted",
        text: "Append and reduce me",
        payload: { messageId: "append-user" },
      }),
    );

    expect(result.status).toBe("accepted");
    expect(client.released).toBe(true);
    expect(client.normalizedStatements[0]).toBe("BEGIN");
    expect(client.normalizedStatements.at(-1)).toBe("COMMIT");
    expect(client.activityRows).toHaveLength(1);
    expect(client.chatInsertValues).toHaveLength(1);
    expect(client.chatInsertValues[0]?.slice(0, 11)).toEqual([
      "run_activity:run-chat:session-chat:message:append-user",
      "run-chat:session-chat",
      "issue:eng-198",
      "ENG-198",
      "run-chat",
      "session-chat",
      0,
      "user",
      "message",
      "completed",
      "Append and reduce me",
    ]);
    expect(
      client.normalizedStatements.findIndex((statement) => statement.startsWith("INSERT INTO symphony.run_activity_event")),
    ).toBeLessThan(client.normalizedStatements.findIndex((statement) => statement.startsWith("INSERT INTO symphony.chat_message")));
  });

  it("reduces accepted tool appends into chat_message rows in the same Postgres append transaction", async () => {
    const client = new FakeAppendAndChatReducerPostgresClient();
    const store = new PostgresRunActivityAppendStore({ connect: async () => client });

    const result = await store.appendEvents([
      toolAppendInput({ id: "activity:append:tool-request", kind: "tool_call_requested", text: "shell requested", payload: { toolCallId: "append-tool", toolName: "shell.run" } }),
      toolAppendInput({ id: "activity:append:tool-complete", kind: "tool_call_completed", text: "shell completed", payload: { toolCallId: "append-tool", toolName: "shell.run", status: "succeeded" } }),
    ]);

    expect(result.accepted).toHaveLength(2);
    expect(client.activityRows).toHaveLength(2);
    expect(client.chatInsertValues).toHaveLength(1);
    expect(client.chatInsertValues[0]?.slice(0, 16)).toEqual([
      "run_activity:run-chat:session-chat:tool_call:append-tool",
      "run-chat:session-chat",
      "issue:eng-198",
      "ENG-198",
      "run-chat",
      "session-chat",
      0,
      "tool",
      "tool_call",
      "completed",
      "shell completed",
      "shell completed",
      15,
      false,
      1,
      2,
    ]);
  });

  it("re-runs reduction for accepted terminal failure appends but not duplicate appends", async () => {
    const client = new FakeAppendAndChatReducerPostgresClient();
    const store = new PostgresRunActivityAppendStore({ connect: async () => client });

    const first = await store.appendEvents([
      messageAppendInput({ id: "activity:append:assistant-delta", kind: "assistant_message_delta", text: "partial", payload: { delta: true } }),
      terminalAppendInput({ id: "activity:append:run-failed", kind: "run_failed", text: "runtime failed" }),
    ]);
    expect(first.accepted).toHaveLength(2);
    expect(client.chatInsertValues).toHaveLength(1);
    expect(client.chatInsertValues[0]?.slice(7, 16)).toEqual([
      "assistant",
      "assistant_response",
      "failed",
      "partial",
      "partial",
      7,
      false,
      1,
      2,
    ]);
    const metadata = JSON.parse(String(client.chatInsertValues[0]?.[18]));
    expect(metadata).toMatchObject({ sourceEventIds: ["activity:append:assistant-delta", "activity:append:run-failed"], sourceEventSequences: [1, 2] });

    const duplicate = await store.appendEvent(
      messageAppendInput({ id: "activity:append:assistant-delta", kind: "assistant_message_delta", text: "partial", payload: { delta: true } }),
    );
    expect(duplicate.status).toBe("duplicate");
    expect(client.chatInsertValues).toHaveLength(1);
  });
});

class FakeChatReducerPostgresClient implements PostgresRunActivityChatMessageReducerClient {
  readonly normalizedStatements: string[] = [];
  readonly insertValues: readonly unknown[][] = [];
  released = false;

  constructor(private readonly rows: QueryResultRow[]) {}

  async query<T extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }> {
    const normalized = text.replace(/\s+/g, " ").trim();
    this.normalizedStatements.push(normalized);

    if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
      return { rows: [] as T[] };
    }

    if (normalized.startsWith("SELECT event.run_activity_event_id::text AS append_revision")) {
      expect(values).toEqual(["run-chat:session-chat"]);
      return { rows: this.rows as T[] };
    }

    if (normalized.startsWith("WITH numbered AS")) {
      return { rows: [] as T[] };
    }

    if (normalized.startsWith("INSERT INTO symphony.chat_message")) {
      (this.insertValues as unknown[][]).push([...(values ?? [])]);
      return { rows: [] as T[] };
    }

    if (normalized.startsWith("WITH deleted AS")) {
      return { rows: [{ deleted_count: "0" } as unknown as T] };
    }

    throw new Error(`Unexpected query: ${normalized}`);
  }

  release(): void {
    this.released = true;
  }
}

class FakeAppendAndChatReducerPostgresClient implements PostgresRunActivityChatMessageReducerClient {
  readonly normalizedStatements: string[] = [];
  readonly activityRows: QueryResultRow[] = [];
  readonly chatInsertValues: readonly unknown[][] = [];
  released = false;

  async query<T extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }> {
    const normalized = text.replace(/\s+/g, " ").trim();
    this.normalizedStatements.push(normalized);

    if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
      return { rows: [] as T[] };
    }

    if (normalized.startsWith("SELECT run_id FROM symphony.run_session")) {
      const runIds = values?.[0] as readonly string[];
      return { rows: runIds.map((run_id) => ({ run_id }) as unknown as T) };
    }

    if (normalized.startsWith("SELECT run_activity_event_id::text AS append_revision")) {
      return { rows: this.activityRows as T[] };
    }

    if (normalized.startsWith("INSERT INTO symphony.run_activity_event")) {
      const insertValues = [...(values ?? [])];
      const row = postgresActivityRow({
        append_revision: String(this.activityRows.length + 1),
        event_id: insertValues[0],
        run_id: insertValues[1],
        session_id: insertValues[2],
        run_session_id: insertValues[3],
        sequence: insertValues[4],
        sequence_source: insertValues[5],
        event_at: insertValues[6],
        protocol: insertValues[7],
        harness_id: insertValues[8],
        external_event_id: insertValues[9],
        actor: insertValues[10],
        channel: insertValues[11],
        kind: insertValues[12],
        text: insertValues[13],
        payload: JSON.parse(String(insertValues[15])),
        payload_schema: insertValues[16],
        payload_truncated: insertValues[17],
        payload_byte_length: insertValues[18],
        raw_payload_ref_id: insertValues[19],
        metadata: JSON.parse(String(insertValues[20])),
        created_at: "2026-05-31T00:00:01.000Z",
      });
      this.activityRows.push(row);
      return { rows: [row as T] };
    }

    if (normalized.startsWith("SELECT event.run_activity_event_id::text AS append_revision")) {
      return { rows: this.activityRows as T[] };
    }

    if (normalized.startsWith("WITH numbered AS")) {
      return { rows: [] as T[] };
    }

    if (normalized.startsWith("INSERT INTO symphony.chat_message")) {
      (this.chatInsertValues as unknown[][]).push([...(values ?? [])]);
      return { rows: [] as T[] };
    }

    if (normalized.startsWith("WITH deleted AS")) {
      return { rows: [{ deleted_count: "0" } as unknown as T] };
    }

    throw new Error(`Unexpected query: ${normalized}`);
  }

  release(): void {
    this.released = true;
  }
}

function messageAppendInput(overrides: Record<string, unknown> = {}): RunActivityAppendInput {
  return {
    id: "activity:append:message",
    runId: "run-chat",
    sessionId: "session-chat",
    at: "2026-05-31T00:00:01.000Z",
    harnessId: "hermes",
    actor: "assistant",
    channel: "message",
    kind: "assistant_message_completed",
    text: "append message",
    payload: {},
    protocol: "json_rpc",
    sequence: null,
    ...overrides,
  } as RunActivityAppendInput;
}

function toolAppendInput(overrides: Record<string, unknown> = {}): RunActivityAppendInput {
  return {
    id: "activity:append:tool",
    runId: "run-chat",
    sessionId: "session-chat",
    at: "2026-05-31T00:00:01.000Z",
    harnessId: "hermes",
    actor: "assistant",
    channel: "tool",
    kind: "tool_call_requested",
    text: "tool append",
    payload: { toolCallId: "append-tool", toolName: "shell.run" },
    protocol: "json_rpc",
    sequence: null,
    ...overrides,
  } as RunActivityAppendInput;
}

function terminalAppendInput(overrides: Record<string, unknown> = {}): RunActivityAppendInput {
  return {
    id: "activity:append:terminal",
    runId: "run-chat",
    sessionId: "session-chat",
    at: "2026-05-31T00:00:02.000Z",
    harnessId: "hermes",
    actor: "runtime",
    channel: "terminal",
    kind: "run_failed",
    text: "terminal append",
    payload: { reason: "run_failed" },
    protocol: "json_rpc",
    sequence: null,
    ...overrides,
  } as RunActivityAppendInput;
}

function postgresActivityRow(overrides: Record<string, unknown> = {}): QueryResultRow {
  const sequence = Number(overrides.sequence ?? 1);
  return {
    append_revision: String(sequence),
    event_id: `activity:pg:${sequence}`,
    run_id: "run-chat",
    session_id: "session-chat",
    run_session_id: "run-chat:session-chat",
    sequence,
    sequence_source: "harness",
    event_at: `2026-05-31T00:00:0${sequence}.000Z`,
    protocol: "json_rpc",
    harness_id: "hermes",
    external_event_id: null,
    actor: "assistant",
    channel: "message",
    kind: "assistant_message_completed" satisfies RunActivityMessageKind,
    text: "message",
    payload: {},
    payload_schema: null,
    payload_truncated: false,
    payload_byte_length: null,
    raw_payload_ref_id: null,
    metadata: {},
    created_at: `2026-05-31T00:00:0${sequence}.000Z`,
    issue_key: "issue:eng-198",
    issue_identifier: "ENG-198",
    ...overrides,
  } satisfies QueryResultRow;
}

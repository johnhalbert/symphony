import type { QueryResultRow } from "pg";
import type { PostgresQueryClient } from "../database/PostgresMigrations.js";
import { SymphonyError } from "../errors.js";
import {
  RUN_ACTIVITY_TERMINAL_CANCEL_KINDS,
  RUN_ACTIVITY_TERMINAL_FAILURE_KINDS,
  compareRunActivityEvents,
  normalizeRunActivityChannel,
  type RunActivityChannelInput,
  type RunActivityEvent,
  type RunActivityMessageKind,
  type RunActivityToolKind,
  type RunMessageActivityEvent,
  type RunTerminalActivityEvent,
  type RunToolActivityEvent,
} from "../runActivity/RunActivityEvent.js";
import { redactTranscriptText, sanitizePublicJson, sanitizedPreviewValue } from "../transcript/TranscriptProjection.js";
import type { RunActivityStoredEvent } from "./RunActivityAppendStore.js";

const CHAT_MESSAGE_REDUCER = "run_activity_chat_message_v1";
const DEFAULT_PREVIEW_LENGTH = 500;
const MAX_INLINE_CHAT_BODY_CHARS = 100_000;
const DEFAULT_PROJECT_CONTEXT_ID = "default";

export type ChatMessageRole = "system" | "user" | "assistant" | "agent" | "orchestrator" | "tool";
export type ChatMessageStatus = "pending" | "streaming" | "completed" | "failed" | "cancelled";

export interface ChatMessageRecord {
  readonly messageId: string;
  readonly projectContextId: string;
  readonly threadKey: string;
  readonly issueKey: string | null;
  readonly issueIdentifier: string | null;
  readonly runId: string | null;
  readonly sessionId: string | null;
  readonly messageIndex: number;
  readonly role: ChatMessageRole;
  readonly messageKind: string;
  readonly status: ChatMessageStatus;
  readonly body: string;
  readonly bodyPreview: string;
  readonly bodyCharCount: number;
  readonly bodyTruncated: boolean;
  readonly eventSequenceStart: number | null;
  readonly eventSequenceEnd: number | null;
  readonly payload: Record<string, unknown>;
  readonly rawPayloadRefId: string | null;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RunActivityChatMessageContext {
  /** Defaults to the event runSessionId so ordering and reduction stay scoped to one run attempt. */
  readonly threadKey?: string | null;
  readonly issueKey?: string | null;
  readonly issueIdentifier?: string | null;
  readonly projectContextId?: string | null;
}

export interface RunActivityChatReductionResult {
  readonly runSessionId: string | null;
  readonly threadKey: string | null;
  readonly messages: readonly ChatMessageRecord[];
  readonly reducedEventCount: number;
  readonly ignoredEventCount: number;
  readonly upsertedCount: number;
  readonly deletedCount: number;
}

export type RunActivityChatSourceEvent = RunActivityStoredEvent | RunActivityEvent;

interface RunActivityChatEventEnvelope {
  readonly event: RunActivityEvent;
  readonly appendRevision: string | null;
  readonly runId: string | null;
  readonly sessionId: string | null;
  readonly projectContextId: string;
  readonly storage: {
    readonly payloadSchema: string | null;
    readonly payloadTruncated: boolean;
    readonly payloadByteLength: number | null;
    readonly rawPayloadRefId: string | null;
    readonly metadata: Record<string, unknown>;
  };
}

interface MutableChatMessage {
  messageId: string;
  projectContextId: string;
  threadKey: string;
  issueKey: string | null;
  issueIdentifier: string | null;
  runId: string | null;
  sessionId: string | null;
  role: ChatMessageRole;
  messageKind: string;
  status: ChatMessageStatus;
  body: string;
  eventSequenceStart: number;
  eventSequenceEnd: number;
  createdAt: string;
  updatedAt: string;
  rawPayloadRefId: string | null;
  upstreamMessageId: string | null;
  sourcePayloadTruncated: boolean;
  sourcePayloadByteLength: number | null;
  sourceRedacted: boolean;
  sourceEvents: RunActivityChatEventEnvelope[];
}

interface ChatMessageReducerState {
  readonly messages: MutableChatMessage[];
  readonly byMessageId: Map<string, MutableChatMessage>;
  openAssistantResponse: MutableChatMessage | null;
  openAssistantReasoning: MutableChatMessage | null;
  readonly openToolMessages: Map<string, MutableChatMessage>;
}

export interface PostgresRunActivityChatMessageReducerClient extends PostgresQueryClient {
  release?(): void;
}

export interface PostgresRunActivityChatMessageReducerConnectionProvider {
  connect(): Promise<PostgresRunActivityChatMessageReducerClient>;
}

interface RunActivityChatReducerPostgresRow extends QueryResultRow {
  append_revision: string | number | bigint;
  project_context_id: string;
  event_id: string;
  run_id: string;
  session_id: string | null;
  run_session_id: string;
  sequence: number;
  sequence_source: RunActivityEvent["sequenceSource"];
  event_at: string | Date;
  protocol: RunActivityEvent["protocol"];
  harness_id: string;
  external_event_id: string | null;
  actor: RunActivityEvent["actor"];
  channel: RunActivityChannelInput;
  kind: RunActivityEvent["kind"];
  text: string | null;
  payload: unknown;
  payload_schema: string | null;
  payload_truncated: boolean;
  payload_byte_length: string | number | bigint | null;
  raw_payload_ref_id: string | number | bigint | null;
  metadata: unknown;
  created_at: string | Date;
  issue_key: string | null;
  issue_identifier: string | null;
}

export class InMemoryRunActivityChatMessageReducer {
  private readonly messagesById = new Map<string, ChatMessageRecord>();

  async reduceEvents(
    sources: readonly RunActivityChatSourceEvent[],
    context: RunActivityChatMessageContext = {},
  ): Promise<RunActivityChatReductionResult> {
    const envelopes = normalizeSourceEvents(sources);
    const messages = reduceRunActivityEventsToChatMessages(sources, context);
    const threadKey = messages[0]?.threadKey ?? resolveThreadKey(envelopes[0]?.event.runSessionId ?? null, context.threadKey);
    const runId = messages[0]?.runId ?? envelopes[0]?.runId ?? null;
    const projectContextId = messages[0]?.projectContextId ?? envelopes[0]?.projectContextId ?? DEFAULT_PROJECT_CONTEXT_ID;

    if (threadKey !== null) {
      for (const [messageId, message] of [...this.messagesById.entries()]) {
        if (
          message.threadKey === threadKey &&
          message.runId === runId &&
          message.projectContextId === projectContextId &&
          message.metadata.reducedFromRunActivity === true
        ) {
          this.messagesById.delete(messageId);
        }
      }
    }
    for (const message of messages) this.messagesById.set(message.messageId, message);

    return {
      runSessionId: envelopes[0]?.event.runSessionId ?? null,
      threadKey,
      messages,
      reducedEventCount: messages.reduce((count, message) => count + sourceEventIdsFromMetadata(message.metadata).length, 0),
      ignoredEventCount: envelopes.length - messages.reduce((count, message) => count + sourceEventIdsFromMetadata(message.metadata).length, 0),
      upsertedCount: messages.length,
      deletedCount: 0,
    };
  }

  listMessages(threadKey?: string | null): readonly ChatMessageRecord[] {
    return [...this.messagesById.values()]
      .filter((message) => threadKey === undefined || message.threadKey === threadKey)
      .sort((left, right) => left.threadKey.localeCompare(right.threadKey) || left.messageIndex - right.messageIndex);
  }
}

export class PostgresRunActivityChatMessageReducer {
  constructor(private readonly connections: PostgresRunActivityChatMessageReducerConnectionProvider) {}

  async reduceRunSession(
    runSessionId: string,
    context: RunActivityChatMessageContext = {},
  ): Promise<RunActivityChatReductionResult> {
    const client = await this.connections.connect();
    try {
      await client.query("BEGIN");
      try {
        const result = await reduceRunActivityChatMessagesWithPostgresClient(client, runSessionId, context);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await rollbackRunActivityChatReductionQuietly(client);
        throw error;
      }
    } finally {
      client.release?.();
    }
  }
}

export function reduceRunActivityEventsToChatMessages(
  sources: readonly RunActivityChatSourceEvent[],
  context: RunActivityChatMessageContext = {},
): ChatMessageRecord[] {
  const envelopes = normalizeSourceEvents(sources).sort((left, right) => compareRunActivityEvents(left.event, right.event));
  assertSingleRunSession(envelopes);
  assertSingleProjectContext(envelopes);

  const runSessionId = envelopes[0]?.event.runSessionId ?? null;
  const threadKey = resolveThreadKey(runSessionId, context.threadKey);
  if (threadKey === null) return [];

  const state: ChatMessageReducerState = {
    messages: [],
    byMessageId: new Map<string, MutableChatMessage>(),
    openAssistantResponse: null,
    openAssistantReasoning: null,
    openToolMessages: new Map<string, MutableChatMessage>(),
  };

  for (const envelope of envelopes) {
    reduceChatActivityEvent(envelope, state, threadKey, context);
  }

  return state.messages.map((message, index) => finalizeChatMessage(message, index));
}

export async function reduceRunActivityChatMessagesWithPostgresClient(
  client: PostgresQueryClient,
  runSessionId: string,
  context: RunActivityChatMessageContext = {},
): Promise<RunActivityChatReductionResult> {
  const normalizedRunSessionId = normalizeRequiredString(runSessionId, "runSessionId");
  const normalizedProjectContextId = normalizeOptionalString(context.projectContextId);
  const rows = await client.query<RunActivityChatReducerPostgresRow>(
    `
      SELECT
        event.run_activity_event_id::text AS append_revision,
        event.project_context_id,
        event.event_id,
        event.run_id,
        event.session_id,
        event.run_session_id,
        event.sequence,
        event.sequence_source,
        event.event_at,
        event.protocol,
        event.harness_id,
        event.external_event_id,
        event.actor,
        event.channel,
        event.kind,
        event.text,
        event.payload,
        event.payload_schema,
        event.payload_truncated,
        event.payload_byte_length,
        event.raw_payload_ref_id,
        event.metadata,
        event.created_at,
        run.issue_key,
        run.issue_identifier
      FROM symphony.run_activity_event event
      JOIN symphony.run_session run ON run.project_context_id = event.project_context_id AND run.run_id = event.run_id
      WHERE event.run_session_id = $1
        AND ($2::text IS NULL OR event.project_context_id = $2)
      ORDER BY event.sequence, event.event_at, event.event_id
      FOR UPDATE OF event
    `,
    [normalizedRunSessionId, normalizedProjectContextId],
  );

  const envelopes = rows.rows.map(envelopeFromPostgresRow);
  const firstRow = rows.rows[0];
  const resolvedContext: RunActivityChatMessageContext = {
    ...(context.threadKey === undefined ? {} : { threadKey: context.threadKey }),
    issueKey: context.issueKey ?? firstRow?.issue_key ?? null,
    issueIdentifier: context.issueIdentifier ?? firstRow?.issue_identifier ?? null,
  };
  const messages = reduceRunActivityEventsToChatMessages(envelopes.map(storedEventFromEnvelope), resolvedContext);
  const threadKey = messages[0]?.threadKey ?? resolveThreadKey(normalizedRunSessionId, context.threadKey);
  const runId = messages[0]?.runId ?? firstRow?.run_id ?? null;
  const projectContextId = messages[0]?.projectContextId ?? firstRow?.project_context_id ?? null;

  let deletedCount = 0;
  let upsertedCount = 0;
  if (threadKey !== null && runId !== null && projectContextId !== null) {
    await moveExistingReducedChatRowsOutOfMessageIndexRange(client, projectContextId, runId, threadKey);
    for (const message of messages) {
      await upsertChatMessage(client, message);
      upsertedCount += 1;
    }
    deletedCount = await deleteStaleReducedChatRows(
      client,
      projectContextId,
      runId,
      threadKey,
      messages.map((message) => message.messageId),
    );
  }

  const reducedEventIds = new Set(messages.flatMap((message) => sourceEventIdsFromMetadata(message.metadata)));
  return {
    runSessionId: normalizedRunSessionId,
    threadKey,
    messages,
    reducedEventCount: reducedEventIds.size,
    ignoredEventCount: envelopes.length - reducedEventIds.size,
    upsertedCount,
    deletedCount,
  };
}

function reduceChatActivityEvent(
  envelope: RunActivityChatEventEnvelope,
  state: ChatMessageReducerState,
  threadKey: string,
  context: RunActivityChatMessageContext,
): void {
  if (isMessageActivityEvent(envelope.event)) {
    reduceMessageEvent(envelope, state, threadKey, context);
    return;
  }
  if (isToolActivityEvent(envelope.event)) {
    reduceToolEvent(envelope, state, threadKey, context);
    return;
  }
  if (isTerminalActivityEvent(envelope.event)) {
    reduceTerminalEvent(envelope, state);
  }
}

function reduceMessageEvent(
  envelope: RunActivityChatEventEnvelope,
  state: ChatMessageReducerState,
  threadKey: string,
  context: RunActivityChatMessageContext,
): void {
  const event = envelope.event;
  if (!isMessageActivityEvent(event)) return;
  const role = roleForMessageEvent(event);
  const messageKind = chatMessageKindForRunActivityMessageKind(event.kind);
  const upstreamMessageId = normalizeOptionalString(event.payload.messageId);
  const status = statusForMessageEvent(event);
  const text = normalizeEventText(event.text);

  if (role !== "assistant") {
    state.openAssistantResponse = null;
    state.openAssistantReasoning = null;
  }

  const message = resolveMutableMessage({ envelope, state, threadKey, context, role, messageKind, upstreamMessageId, status });
  applyEnvelopeToMutableMessage(message, envelope, text, status);

  if (messageKind === "assistant_response") {
    state.openAssistantResponse = message.status === "completed" ? null : message;
  } else if (messageKind === "assistant_reasoning") {
    state.openAssistantReasoning = message.status === "completed" ? null : message;
  }
}

function reduceToolEvent(
  envelope: RunActivityChatEventEnvelope,
  state: ChatMessageReducerState,
  threadKey: string,
  context: RunActivityChatMessageContext,
): void {
  const event = envelope.event;
  if (!isToolActivityEvent(event)) return;
  const messageKind = chatMessageKindForRunActivityToolKind(event.kind);
  const upstreamMessageId = normalizeOptionalString(event.payload.toolCallId);
  const status = statusForToolEvent(event);
  const text = textForToolEvent(event);
  const message = resolveMutableMessage({
    envelope,
    state,
    threadKey,
    context,
    role: "tool",
    messageKind,
    upstreamMessageId,
    status,
  });

  applyEnvelopeToMutableMessage(message, envelope, text, status);

  if (isActiveChatMessage(message)) {
    state.openToolMessages.set(message.messageId, message);
  } else {
    state.openToolMessages.delete(message.messageId);
  }
}

function reduceTerminalEvent(envelope: RunActivityChatEventEnvelope, state: ChatMessageReducerState): void {
  const event = envelope.event;
  if (!isTerminalActivityEvent(event)) return;
  const status = statusForTerminalEvent(event);
  if (status === null) return;

  const activeMessages = state.messages.filter(isActiveChatMessage);

  for (const message of activeMessages) {
    applyEnvelopeToMutableMessage(message, envelope, "", status);
  }

  state.openAssistantResponse = null;
  state.openAssistantReasoning = null;
  state.openToolMessages.clear();
}

function resolveMutableMessage(input: {
  readonly envelope: RunActivityChatEventEnvelope;
  readonly state: ChatMessageReducerState;
  readonly threadKey: string;
  readonly context: RunActivityChatMessageContext;
  readonly role: ChatMessageRole;
  readonly messageKind: string;
  readonly upstreamMessageId: string | null;
  readonly status: ChatMessageStatus;
}): MutableChatMessage {
  const { envelope, state, threadKey, context, role, messageKind, upstreamMessageId, status } = input;
  const scopedMessageId = upstreamMessageId === null
    ? null
    : scopedUpstreamMessageId(envelope.event, upstreamMessageId, messageKind);
  const existing = scopedMessageId === null ? implicitOpenMessage(state, messageKind) : state.byMessageId.get(scopedMessageId);
  if (existing !== undefined && existing !== null) return existing;

  const implicit = scopedMessageId === null ? null : implicitOpenMessage(state, messageKind);
  if (
    scopedMessageId !== null &&
    upstreamMessageId !== null &&
    implicit !== null &&
    implicit.upstreamMessageId === null &&
    implicit.role === role &&
    implicit.messageKind === messageKind
  ) {
    state.byMessageId.delete(implicit.messageId);
    implicit.messageId = scopedMessageId;
    implicit.upstreamMessageId = upstreamMessageId;
    state.byMessageId.set(implicit.messageId, implicit);
    return implicit;
  }

  const messageId = scopedMessageId ?? implicitMessageId(envelope.event, messageKind);
  const message: MutableChatMessage = {
    messageId,
    projectContextId: envelope.projectContextId,
    threadKey,
    issueKey: context.issueKey ?? null,
    issueIdentifier: context.issueIdentifier ?? null,
    runId: envelope.runId,
    sessionId: envelope.sessionId,
    role,
    messageKind,
    status,
    body: "",
    eventSequenceStart: eventSequence(envelope.event),
    eventSequenceEnd: eventSequence(envelope.event),
    createdAt: envelope.event.occurredAt,
    updatedAt: envelope.event.occurredAt,
    rawPayloadRefId: envelope.storage.rawPayloadRefId,
    upstreamMessageId,
    sourcePayloadTruncated: envelope.storage.payloadTruncated,
    sourcePayloadByteLength: envelope.storage.payloadByteLength,
    sourceRedacted: payloadDeclaresRedaction(envelope.event.payload),
    sourceEvents: [],
  };
  state.messages.push(message);
  state.byMessageId.set(message.messageId, message);
  return message;
}

function applyEnvelopeToMutableMessage(
  message: MutableChatMessage,
  envelope: RunActivityChatEventEnvelope,
  text: string,
  status: ChatMessageStatus,
): void {
  const event = envelope.event;
  const shouldReplaceBody =
    event.kind === "assistant_message_completed" ||
    event.kind === "assistant_reasoning_available" ||
    event.kind === "tool_call_completed" ||
    event.kind === "tool_call_failed" ||
    event.kind === "tool_permission_resolved";
  const shouldAppendBody =
    event.kind === "assistant_message_delta" ||
    event.kind === "assistant_reasoning_delta" ||
    event.kind === "tool_call_progress";

  if (text.length > 0) {
    if (shouldReplaceBody && event.payload.delta !== true) {
      message.body = text;
    } else if (shouldAppendBody || event.payload.delta === true) {
      message.body = `${message.body}${text}`;
    } else {
      message.body = text;
    }
  }

  message.status = terminalStatus(message.status, status);
  message.eventSequenceStart = Math.min(message.eventSequenceStart, eventSequence(event));
  message.eventSequenceEnd = Math.max(message.eventSequenceEnd, eventSequence(event));
  message.createdAt = minIsoTimestamp(message.createdAt, event.occurredAt);
  message.updatedAt = maxIsoTimestamp(message.updatedAt, event.occurredAt);
  message.rawPayloadRefId = message.rawPayloadRefId ?? envelope.storage.rawPayloadRefId;
  message.sourcePayloadTruncated = message.sourcePayloadTruncated || envelope.storage.payloadTruncated;
  message.sourcePayloadByteLength = maxNullableNumber(message.sourcePayloadByteLength, envelope.storage.payloadByteLength);
  message.sourceRedacted = message.sourceRedacted || payloadDeclaresRedaction(event.payload);
  message.sourceEvents.push(envelope);
}

function finalizeChatMessage(message: MutableChatMessage, messageIndex: number): ChatMessageRecord {
  const body = redactAndCapBody(message.body);
  const preview = sanitizedPreviewValue(body.body, DEFAULT_PREVIEW_LENGTH).preview ?? "";
  const sourceEvents = message.sourceEvents.map((envelope) => ({
    eventId: envelope.event.eventId,
    appendRevision: envelope.appendRevision,
    sequence: eventSequence(envelope.event),
    kind: envelope.event.kind,
    at: envelope.event.occurredAt,
    payload: payloadObject(envelope.event.payload),
    payloadSchema: envelope.storage.payloadSchema,
    payloadTruncated: envelope.storage.payloadTruncated,
  }));
  const eventIds = sourceEvents.map((event) => event.eventId);
  const eventSequences = sourceEvents.map((event) => event.sequence);
  const appendRevisions = sourceEvents
    .map((event) => event.appendRevision)
    .filter((appendRevision): appendRevision is string => appendRevision !== null);
  return {
    messageId: message.messageId,
    projectContextId: message.projectContextId,
    threadKey: message.threadKey,
    issueKey: message.issueKey,
    issueIdentifier: message.issueIdentifier,
    runId: message.runId,
    sessionId: message.sessionId,
    messageIndex,
    role: message.role,
    messageKind: message.messageKind,
    status: message.status,
    body: body.body,
    bodyPreview: preview,
    bodyCharCount: body.charCount,
    bodyTruncated: body.truncated || message.sourcePayloadTruncated,
    eventSequenceStart: message.eventSequenceStart,
    eventSequenceEnd: message.eventSequenceEnd,
    payload: payloadObject({
      source: "run_activity",
      reducer: CHAT_MESSAGE_REDUCER,
      upstreamMessageId: message.upstreamMessageId,
      sourceEvents,
    }),
    rawPayloadRefId: message.rawPayloadRefId,
    metadata: payloadObject({
      reducedFromRunActivity: true,
      reducer: CHAT_MESSAGE_REDUCER,
      runSessionId: message.sourceEvents[0]?.event.runSessionId ?? null,
      upstreamMessageId: message.upstreamMessageId,
      sourceEventIds: eventIds,
      sourceEventSequences: eventSequences,
      sourceAppendRevisions: appendRevisions,
      sourcePayloadTruncated: message.sourcePayloadTruncated,
      sourcePayloadByteLength: message.sourcePayloadByteLength,
      bodyRedacted: body.redacted || message.sourceRedacted,
    }),
    createdAt: message.createdAt,
    updatedAt: maxIsoTimestamp(message.createdAt, message.updatedAt),
  };
}

function normalizeSourceEvents(sources: readonly RunActivityChatSourceEvent[]): RunActivityChatEventEnvelope[] {
  return sources.map((source) => {
    if (isStoredRunActivityEvent(source)) {
      return {
        event: source.event,
        appendRevision: source.metadata.appendRevision,
        runId: source.metadata.runId,
        sessionId: sessionIdFromRunSessionId(source.event.runSessionId),
        projectContextId: source.metadata.projectContextId,
        storage: {
          payloadSchema: source.storage.payloadSchema,
          payloadTruncated: source.storage.payloadTruncated,
          payloadByteLength: source.storage.payloadByteLength,
          rawPayloadRefId: source.storage.rawPayloadRefId,
          metadata: source.storage.metadata,
        },
      };
    }
    return {
      event: source,
      appendRevision: null,
      runId: runIdFromRunSessionId(source.runSessionId),
      sessionId: sessionIdFromRunSessionId(source.runSessionId),
      projectContextId: DEFAULT_PROJECT_CONTEXT_ID,
      storage: {
        payloadSchema: null,
        payloadTruncated: false,
        payloadByteLength: null,
        rawPayloadRefId: null,
        metadata: {},
      },
    };
  });
}

function storedEventFromEnvelope(envelope: RunActivityChatEventEnvelope): RunActivityStoredEvent {
  return {
    event: envelope.event,
    metadata: {
      eventId: envelope.event.eventId,
      runId: envelope.runId ?? runIdFromRunSessionId(envelope.event.runSessionId) ?? "unknown-run",
      projectContextId: envelope.projectContextId,
      runSessionId: envelope.event.runSessionId,
      sequence: eventSequence(envelope.event),
      sequenceSource: envelope.event.sequenceSource,
      appendRevision: envelope.appendRevision ?? `${eventSequence(envelope.event)}`,
      createdAt: envelope.event.occurredAt,
      externalEventId: envelope.event.externalEventId ?? null,
    },
    storage: envelope.storage,
  };
}

function envelopeFromPostgresRow(row: RunActivityChatReducerPostgresRow): RunActivityChatEventEnvelope {
  const event = {
    eventId: row.event_id,
    runSessionId: row.run_session_id,
    occurredAt: toIsoString(row.event_at),
    sequence: Number(row.sequence),
    sequenceSource: row.sequence_source,
    externalEventId: row.external_event_id,
    protocol: row.protocol,
    harness: row.harness_id,
    actor: row.actor,
    channel: normalizeRunActivityChannel(row.channel),
    kind: row.kind,
    text: row.text,
    payload: payloadObject(row.payload),
  } as RunActivityEvent;
  return {
    event,
    appendRevision: String(row.append_revision),
    runId: row.run_id,
    sessionId: row.session_id,
    projectContextId: row.project_context_id,
    storage: {
      payloadSchema: row.payload_schema,
      payloadTruncated: row.payload_truncated,
      payloadByteLength: nullableNumber(row.payload_byte_length),
      rawPayloadRefId: nullableString(row.raw_payload_ref_id),
      metadata: payloadObject(row.metadata),
    },
  };
}

function isStoredRunActivityEvent(source: RunActivityChatSourceEvent): source is RunActivityStoredEvent {
  return typeof source === "object" && source !== null && "event" in source && "metadata" in source && "storage" in source;
}

function isMessageActivityEvent(event: RunActivityEvent): event is RunMessageActivityEvent {
  return event.channel === "chat";
}

function isToolActivityEvent(event: RunActivityEvent): event is RunToolActivityEvent {
  return event.channel === "tool";
}

function isTerminalActivityEvent(event: RunActivityEvent): event is RunTerminalActivityEvent {
  return event.channel === "terminal";
}

function assertSingleRunSession(envelopes: readonly RunActivityChatEventEnvelope[]): void {
  const runSessionIds = new Set(envelopes.map((envelope) => envelope.event.runSessionId));
  if (runSessionIds.size > 1) {
    throw new SymphonyError("invalid_request", "Run activity chat message reduction requires one runSessionId per reduction");
  }
}

function assertSingleProjectContext(envelopes: readonly RunActivityChatEventEnvelope[]): void {
  const projectContextIds = new Set(envelopes.map((envelope) => envelope.projectContextId));
  if (projectContextIds.size > 1) {
    throw new SymphonyError(
      "invalid_request",
      "Run activity chat message reduction requires one projectContextId per reduction",
    );
  }
}

function resolveThreadKey(runSessionId: string | null, explicitThreadKey: string | null | undefined): string | null {
  const explicit = normalizeOptionalString(explicitThreadKey);
  if (explicit !== null) return explicit;
  return runSessionId;
}

function roleForMessageEvent(event: RunMessageActivityEvent): ChatMessageRole {
  switch (event.kind) {
    case "user_message_submitted":
      return "user";
    case "system_message":
      return "system";
    case "task_update":
    case "plan_update":
      return event.actor === "system" ? "system" : "agent";
    case "assistant_message_delta":
    case "assistant_message_completed":
    case "assistant_reasoning_delta":
    case "assistant_reasoning_available":
      return "assistant";
  }
}

function chatMessageKindForRunActivityMessageKind(kind: RunActivityMessageKind): string {
  switch (kind) {
    case "assistant_message_delta":
    case "assistant_message_completed":
      return "assistant_response";
    case "assistant_reasoning_delta":
    case "assistant_reasoning_available":
      return "assistant_reasoning";
    case "task_update":
      return "task_update";
    case "plan_update":
      return "plan_update";
    case "system_message":
    case "user_message_submitted":
      return "message";
  }
}

function chatMessageKindForRunActivityToolKind(kind: RunActivityToolKind): string {
  switch (kind) {
    case "tool_call_requested":
    case "tool_call_started":
    case "tool_call_progress":
    case "tool_call_completed":
    case "tool_call_failed":
      return "tool_call";
    case "tool_permission_requested":
    case "tool_permission_resolved":
      return "tool_permission";
  }
}

function statusForMessageEvent(event: RunMessageActivityEvent): ChatMessageStatus {
  if (event.payload.final === true) return "completed";
  switch (event.kind) {
    case "assistant_message_delta":
    case "assistant_reasoning_delta":
      return "streaming";
    case "assistant_message_completed":
    case "assistant_reasoning_available":
    case "user_message_submitted":
    case "system_message":
    case "task_update":
    case "plan_update":
      return "completed";
  }
}

function statusForToolEvent(event: RunToolActivityEvent): ChatMessageStatus {
  switch (event.kind) {
    case "tool_call_requested":
    case "tool_permission_requested":
      return statusFromToolPayload(event.payload.status, "pending");
    case "tool_call_started":
    case "tool_call_progress":
      return statusFromToolPayload(event.payload.status, "streaming");
    case "tool_call_completed":
      return "completed";
    case "tool_call_failed":
      return "failed";
    case "tool_permission_resolved":
      return statusFromToolPayload(event.payload.status, "completed");
  }
}

function statusForTerminalEvent(event: RunTerminalActivityEvent): ChatMessageStatus | null {
  if (RUN_ACTIVITY_TERMINAL_FAILURE_KINDS.includes(event.kind as (typeof RUN_ACTIVITY_TERMINAL_FAILURE_KINDS)[number])) {
    return "failed";
  }
  if (RUN_ACTIVITY_TERMINAL_CANCEL_KINDS.includes(event.kind as (typeof RUN_ACTIVITY_TERMINAL_CANCEL_KINDS)[number])) {
    return "cancelled";
  }
  return null;
}

function statusFromToolPayload(value: unknown, fallback: ChatMessageStatus): ChatMessageStatus {
  const status = normalizeOptionalString(value)?.toLowerCase();
  if (status === "failed" || status === "error" || status === "errored" || status === "denied" || status === "rejected") {
    return "failed";
  }
  if (status === "cancelled" || status === "canceled" || status === "aborted" || status === "interrupted") {
    return "cancelled";
  }
  if (status === "completed" || status === "complete" || status === "succeeded" || status === "success" || status === "approved" || status === "granted" || status === "resolved") {
    return "completed";
  }
  if (status === "running" || status === "streaming" || status === "in_progress") return "streaming";
  if (status === "pending" || status === "requested" || status === "queued") return "pending";
  return fallback;
}

function terminalStatus(current: ChatMessageStatus, next: ChatMessageStatus): ChatMessageStatus {
  if (current === "failed" || current === "cancelled" || current === "completed") return current;
  if (next === "failed" || next === "cancelled" || next === "completed") return next;
  if (current === "streaming" || next === "streaming") return "streaming";
  return next;
}

function isActiveChatMessage(message: MutableChatMessage): boolean {
  return message.status === "pending" || message.status === "streaming";
}

function textForToolEvent(event: RunToolActivityEvent): string {
  const directText = normalizeEventText(event.text);
  if (directText.length > 0) return directText;

  const preview = previewForToolEvent(event);
  const toolName = normalizeOptionalString(event.payload.toolName) ?? "tool";
  if (preview !== null) return `${toolName}: ${preview}`;
  return `${toolName} ${toolStatusLabelForKind(event.kind)}`;
}

function previewForToolEvent(event: RunToolActivityEvent): string | null {
  switch (event.kind) {
    case "tool_call_failed":
      return normalizeOptionalString(event.payload.errorPreview) ?? normalizeOptionalString(event.payload.outputPreview);
    case "tool_call_completed":
    case "tool_call_progress":
      return normalizeOptionalString(event.payload.outputPreview) ?? normalizeOptionalString(event.payload.inputPreview);
    case "tool_call_requested":
    case "tool_call_started":
    case "tool_permission_requested":
    case "tool_permission_resolved":
      return normalizeOptionalString(event.payload.inputPreview)
        ?? normalizeOptionalString(event.payload.outputPreview)
        ?? normalizeOptionalString(event.payload.errorPreview);
  }
}

function toolStatusLabelForKind(kind: RunActivityToolKind): string {
  switch (kind) {
    case "tool_call_requested":
      return "requested";
    case "tool_call_started":
      return "started";
    case "tool_call_progress":
      return "progress";
    case "tool_call_completed":
      return "completed";
    case "tool_call_failed":
      return "failed";
    case "tool_permission_requested":
      return "permission requested";
    case "tool_permission_resolved":
      return "permission resolved";
  }
}

function implicitOpenMessage(state: ChatMessageReducerState, messageKind: string): MutableChatMessage | null {
  if (messageKind === "assistant_response") return state.openAssistantResponse;
  if (messageKind === "assistant_reasoning") return state.openAssistantReasoning;
  return null;
}

function implicitMessageId(event: RunActivityEvent, messageKind: string): string {
  if (messageKind === "assistant_response" || messageKind === "assistant_reasoning") {
    return `run_activity:${event.runSessionId}:${messageKind}:${event.sequence}`;
  }
  return `run_activity:${event.runSessionId}:event:${event.sequence}`;
}

function scopedUpstreamMessageId(event: RunActivityEvent, upstreamMessageId: string, messageKind: string): string {
  return `run_activity:${event.runSessionId}:${messageKind}:${upstreamMessageId}`;
}

function normalizeEventText(value: string | null): string {
  return value ?? "";
}

function eventSequence(event: RunActivityEvent): number {
  return typeof event.sequence === "number" && Number.isSafeInteger(event.sequence) && event.sequence > 0 ? event.sequence : 0;
}

function runIdFromRunSessionId(runSessionId: string): string | null {
  const normalized = normalizeOptionalString(runSessionId);
  if (normalized === null) return null;
  return normalized.split(":", 1)[0] ?? normalized;
}

function sessionIdFromRunSessionId(runSessionId: string): string | null {
  const normalized = normalizeOptionalString(runSessionId);
  if (normalized === null) return null;
  const separatorIndex = normalized.indexOf(":");
  return separatorIndex < 0 ? null : normalizeOptionalString(normalized.slice(separatorIndex + 1));
}

function redactAndCapBody(value: string): { body: string; charCount: number; truncated: boolean; redacted: boolean } {
  const redacted = redactTranscriptText(value);
  if (redacted.text.length <= MAX_INLINE_CHAT_BODY_CHARS) {
    return { body: redacted.text, charCount: redacted.text.length, truncated: false, redacted: redacted.redacted };
  }
  const suffix = "...[truncated]";
  const limit = Math.max(MAX_INLINE_CHAT_BODY_CHARS - suffix.length, 0);
  return {
    body: `${redacted.text.slice(0, limit)}${suffix}`,
    charCount: redacted.text.length,
    truncated: true,
    redacted: redacted.redacted,
  };
}

function payloadObject(value: unknown): Record<string, unknown> {
  const sanitized = sanitizePublicJson(value ?? {});
  return isRecord(sanitized) ? sanitized : { value: sanitized };
}

function payloadDeclaresRedaction(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.redacted === true;
}

function sourceEventIdsFromMetadata(metadata: Record<string, unknown>): string[] {
  const value = metadata.sourceEventIds;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

async function moveExistingReducedChatRowsOutOfMessageIndexRange(
  client: PostgresQueryClient,
  projectContextId: string,
  runId: string,
  threadKey: string,
): Promise<void> {
  await client.query(
    `
      WITH numbered AS (
        SELECT
          chat_message_id,
          (2147483647 - row_number() OVER (ORDER BY chat_message_id))::integer AS temporary_message_index
        FROM symphony.chat_message
        WHERE project_context_id = $1
          AND run_id = $2
          AND thread_key = $3
          AND metadata->>'reducedFromRunActivity' = 'true'
      )
      UPDATE symphony.chat_message message
      SET message_index = numbered.temporary_message_index
      FROM numbered
      WHERE message.chat_message_id = numbered.chat_message_id
    `,
    [projectContextId, runId, threadKey],
  );
}

async function upsertChatMessage(client: PostgresQueryClient, message: ChatMessageRecord): Promise<void> {
  await client.query(
    `
      INSERT INTO symphony.chat_message (
        project_context_id,
        message_id,
        thread_key,
        issue_key,
        issue_identifier,
        run_id,
        session_id,
        message_index,
        role,
        message_kind,
        status,
        body,
        body_preview,
        body_char_count,
        body_truncated,
        event_sequence_start,
        event_sequence_end,
        payload,
        raw_payload_ref_id,
        metadata,
        created_at,
        updated_at
      ) VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12,
        $13,
        $14,
        $15,
        $16,
        $17,
        $18::jsonb,
        $19,
        $20::jsonb,
        $21,
        $22
      )
      ON CONFLICT (project_context_id, message_id) DO UPDATE SET
        thread_key = EXCLUDED.thread_key,
        issue_key = EXCLUDED.issue_key,
        issue_identifier = EXCLUDED.issue_identifier,
        run_id = EXCLUDED.run_id,
        session_id = EXCLUDED.session_id,
        message_index = EXCLUDED.message_index,
        role = EXCLUDED.role,
        message_kind = EXCLUDED.message_kind,
        status = EXCLUDED.status,
        body = EXCLUDED.body,
        body_preview = EXCLUDED.body_preview,
        body_char_count = EXCLUDED.body_char_count,
        body_truncated = EXCLUDED.body_truncated,
        event_sequence_start = EXCLUDED.event_sequence_start,
        event_sequence_end = EXCLUDED.event_sequence_end,
        payload = EXCLUDED.payload,
        raw_payload_ref_id = EXCLUDED.raw_payload_ref_id,
        metadata = EXCLUDED.metadata,
        created_at = LEAST(symphony.chat_message.created_at, EXCLUDED.created_at),
        updated_at = GREATEST(symphony.chat_message.updated_at, EXCLUDED.updated_at)
    `,
    [
      message.projectContextId,
      message.messageId,
      message.threadKey,
      message.issueKey,
      message.issueIdentifier,
      message.runId,
      message.sessionId,
      message.messageIndex,
      message.role,
      message.messageKind,
      message.status,
      message.body,
      message.bodyPreview,
      message.bodyCharCount,
      message.bodyTruncated,
      message.eventSequenceStart,
      message.eventSequenceEnd,
      JSON.stringify(message.payload),
      message.rawPayloadRefId,
      JSON.stringify(message.metadata),
      message.createdAt,
      message.updatedAt,
    ],
  );
}

async function deleteStaleReducedChatRows(
  client: PostgresQueryClient,
  projectContextId: string,
  runId: string,
  threadKey: string,
  messageIds: readonly string[],
): Promise<number> {
  const rows = await client.query<{ deleted_count: string }>(
    `
      WITH deleted AS (
        DELETE FROM symphony.chat_message
        WHERE project_context_id = $1
          AND run_id = $2
          AND thread_key = $3
          AND metadata->>'reducedFromRunActivity' = 'true'
          AND NOT (message_id = ANY($4::text[]))
        RETURNING 1
      )
      SELECT count(*)::text AS deleted_count FROM deleted
    `,
    [projectContextId, runId, threadKey, messageIds],
  );
  return Number(rows.rows[0]?.deleted_count ?? 0);
}

async function rollbackRunActivityChatReductionQuietly(client: PostgresQueryClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original reducer error.
  }
}

function normalizeRequiredString(value: string, label: string): string {
  const normalized = normalizeOptionalString(value);
  if (normalized === null) throw new SymphonyError("invalid_request", `${label} must be non-empty`);
  return normalized;
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function nullableString(value: string | number | bigint | null): string | null {
  return value === null ? null : String(value);
}

function nullableNumber(value: string | number | bigint | null): number | null {
  if (value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function maxNullableNumber(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

function minIsoTimestamp(left: string, right: string): string {
  return new Date(left).getTime() <= new Date(right).getTime() ? left : right;
}

function maxIsoTimestamp(left: string, right: string): string {
  return new Date(left).getTime() >= new Date(right).getTime() ? left : right;
}

function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

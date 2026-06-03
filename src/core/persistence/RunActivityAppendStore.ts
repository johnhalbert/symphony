import type { QueryResultRow } from "pg";
import type { PostgresQueryClient } from "../database/PostgresMigrations.js";
import { SymphonyError } from "../errors.js";
import { reduceRunActivityChatMessagesWithPostgresClient } from "./RunActivityChatMessageReducer.js";
import { ProjectionRevisionNotifier, type ProjectionChangeListener, type ProjectionChangeUnsubscribe } from "./ProjectionRevision.js";
import {
  applyRunActivityOrdering,
  createRunActivityOrderingState,
  deriveRunActivityRunSessionId,
  normalizeRunActivityChannel,
  type RunActivityChannelInput,
  type RunActivityDuplicateReason,
  type RunActivityEvent,
  type RunActivityEventInput,
  type RunActivityOrderingState,
  type RunActivityRejectReason,
} from "../runActivity/RunActivityEvent.js";

export interface RunActivityAppendStorageMetadata {
  readonly payloadSchema?: string | null;
  readonly payloadTruncated?: boolean;
  readonly payloadByteLength?: number | null;
  readonly rawPayloadRefId?: string | number | bigint | null;
  readonly metadata?: Readonly<Record<string, unknown>> | null;
}

export type RunActivityAppendInput = RunActivityEventInput & {
  readonly storage?: RunActivityAppendStorageMetadata;
};

export interface RunActivityAppendMetadata {
  readonly eventId: string;
  readonly runId: string;
  readonly sessionId?: string | null;
  readonly runSessionId: string;
  readonly sequence: number;
  readonly sequenceSource: RunActivityEvent["sequenceSource"];
  readonly appendRevision: string;
  readonly createdAt: string;
  readonly externalEventId: string | null;
}

export interface RunActivityStoredEvent {
  readonly event: RunActivityEvent;
  readonly metadata: RunActivityAppendMetadata;
  readonly storage: RequiredRunActivityAppendStorageMetadata;
}

export interface RunActivityEventsPage {
  readonly runId: string;
  readonly offset: number;
  readonly limit: number;
  readonly nextOffset: number | null;
  readonly total: number;
  readonly events: readonly RunActivityStoredEvent[];
}

export interface RunActivityEventSourceStore {
  readRunEvents(runId: string, options?: { offset?: number; limit?: number }): Promise<RunActivityEventsPage>;
  projectionRevision?(): number;
  onProjectionChanged?(listener: ProjectionChangeListener): ProjectionChangeUnsubscribe;
}

export type RunActivityAcceptedAppendResult = {
  readonly status: "accepted";
  readonly event: RunActivityEvent;
  readonly metadata: RunActivityAppendMetadata;
  readonly state: RunActivityOrderingState;
};

export type RunActivityDuplicateAppendResult = {
  readonly status: "duplicate";
  readonly reason: RunActivityDuplicateReason;
  readonly existingEvent: RunActivityEvent;
  readonly metadata: RunActivityAppendMetadata;
  readonly state: RunActivityOrderingState;
};

export type RunActivityRejectedAppendResult = {
  readonly status: "rejected";
  readonly reason: RunActivityRejectReason;
  readonly runSessionId: string;
  readonly state: RunActivityOrderingState;
};

export type RunActivityAppendResult =
  | RunActivityAcceptedAppendResult
  | RunActivityDuplicateAppendResult
  | RunActivityRejectedAppendResult;

export interface RunActivityAppendBatchResult {
  readonly results: readonly RunActivityAppendResult[];
  readonly accepted: readonly RunActivityAcceptedAppendResult[];
  readonly duplicates: readonly RunActivityDuplicateAppendResult[];
  readonly rejected: readonly RunActivityRejectedAppendResult[];
}

export interface RunActivityAppendStore {
  appendEvent(input: RunActivityAppendInput): Promise<RunActivityAppendResult>;
  appendEvents(inputs: readonly RunActivityAppendInput[]): Promise<RunActivityAppendBatchResult>;
  projectionRevision(): number;
  onProjectionChanged(listener: ProjectionChangeListener): ProjectionChangeUnsubscribe;
}

export interface PostgresRunActivityAppendClient extends PostgresQueryClient {
  release?(): void;
}

export interface PostgresRunActivityAppendConnectionProvider {
  connect(): Promise<PostgresRunActivityAppendClient>;
}

export interface PostgresRunActivityAppendStoreOptions {
  /**
   * When enabled (default), accepted chat-relevant activity is reduced into
   * symphony.chat_message rows inside the same Postgres transaction. This covers
   * message events, tool-facing events, and terminal failure/cancel events that
   * can finalize active streaming chat rows.
   */
  readonly reduceChatMessages?: boolean;
}

interface RequiredRunActivityAppendStorageMetadata {
  readonly payloadSchema: string | null;
  readonly payloadTruncated: boolean;
  readonly payloadByteLength: number | null;
  readonly rawPayloadRefId: string | null;
  readonly metadata: Record<string, unknown>;
}

interface RunActivityAppendPersistenceContext {
  readonly runId: string;
  readonly sessionId: string | null;
}

type PersistAcceptedRunActivityEvent = (
  event: RunActivityEvent,
  storage: RequiredRunActivityAppendStorageMetadata,
  context: RunActivityAppendPersistenceContext,
) => Promise<RunActivityStoredEvent>;

interface RunActivityEventRow extends QueryResultRow {
  append_revision: string | number | bigint;
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
}

export class InMemoryRunActivityAppendStore implements RunActivityAppendStore {
  private revision = 0;
  private readonly projectionNotifier = new ProjectionRevisionNotifier();
  private readonly storedEvents: RunActivityStoredEvent[] = [];

  projectionRevision(): number {
    return this.projectionNotifier.currentRevision();
  }

  onProjectionChanged(listener: ProjectionChangeListener): ProjectionChangeUnsubscribe {
    return this.projectionNotifier.subscribe(listener);
  }

  async appendEvent(input: RunActivityAppendInput): Promise<RunActivityAppendResult> {
    const batch = await this.appendEvents([input]);
    const result = batch.results[0];
    if (result === undefined) throw new SymphonyError("invalid_request", "Expected one append result for one run activity input");
    return result;
  }

  async appendEvents(inputs: readonly RunActivityAppendInput[]): Promise<RunActivityAppendBatchResult> {
    const state = new RunActivityAppendAccumulator(this.storedEvents);
    const result = await appendRunActivityEventsWithState(inputs, state, async (event, storage, context) => {
      const stored = storedEventFromAcceptedEvent(event, storage, {
        appendRevision: String(this.revision + 1),
        createdAt: event.occurredAt,
        runId: context.runId,
        sessionId: context.sessionId,
      });
      this.revision += 1;
      this.storedEvents.push(stored);
      return stored;
    });
    notifyAcceptedRunActivityProjectionChanges(this.projectionNotifier, result.accepted);
    return result;
  }

  readEvents(runSessionId: string): readonly RunActivityStoredEvent[] {
    return this.storedEvents
      .filter((stored) => stored.event.runSessionId === runSessionId)
      .sort((left, right) => compareAppendRevision(left.metadata.appendRevision, right.metadata.appendRevision));
  }

  async readRunEvents(runId: string, options: { offset?: number; limit?: number } = {}): Promise<RunActivityEventsPage> {
    const page = normalizeRunActivityReadPageOptions(options);
    const events = this.storedEvents
      .filter((stored) => stored.metadata.runId === runId)
      .sort(compareRunActivityTranscriptOrder);
    const pageEvents = events.slice(page.offset, page.offset + page.limit);
    const nextOffset = page.offset + pageEvents.length < events.length ? page.offset + pageEvents.length : null;
    return { runId, offset: page.offset, limit: page.limit, nextOffset, total: events.length, events: pageEvents };
  }
}

export class PostgresRunActivityAppendStore implements RunActivityAppendStore {
  private readonly projectionNotifier = new ProjectionRevisionNotifier();

  constructor(
    private readonly connections: PostgresRunActivityAppendConnectionProvider,
    private readonly options: PostgresRunActivityAppendStoreOptions = {},
  ) {}

  projectionRevision(): number {
    return this.projectionNotifier.currentRevision();
  }

  onProjectionChanged(listener: ProjectionChangeListener): ProjectionChangeUnsubscribe {
    return this.projectionNotifier.subscribe(listener);
  }

  async appendEvent(input: RunActivityAppendInput): Promise<RunActivityAppendResult> {
    const batch = await this.appendEvents([input]);
    const result = batch.results[0];
    if (result === undefined) throw new SymphonyError("invalid_request", "Expected one append result for one run activity input");
    return result;
  }

  async appendEvents(inputs: readonly RunActivityAppendInput[]): Promise<RunActivityAppendBatchResult> {
    if (inputs.length === 0) return emptyAppendBatchResult();

    const client = await this.connections.connect();
    try {
      await client.query("BEGIN");
      try {
        const result = await appendRunActivityEventsWithPostgresClient(client, inputs);
        if (this.options.reduceChatMessages !== false) {
          await reduceAcceptedRunActivityMessageEventsWithPostgresClient(client, result.accepted);
        }
        await client.query("COMMIT");
        notifyAcceptedRunActivityProjectionChanges(this.projectionNotifier, result.accepted);
        return result;
      } catch (error) {
        await rollbackRunActivityAppendQuietly(client);
        throw error;
      }
    } finally {
      client.release?.();
    }
  }

  async readRunEvents(runId: string, options: { offset?: number; limit?: number } = {}): Promise<RunActivityEventsPage> {
    const page = normalizeRunActivityReadPageOptions(options);
    const client = await this.connections.connect();
    try {
      const rows = await client.query<RunActivityEventRow>(
        `
          SELECT ${runActivityEventSelectColumns()}
          FROM symphony.run_activity_event
          WHERE run_id = $1
          ORDER BY sequence ASC, event_at ASC, run_activity_event_id ASC
          LIMIT $2 OFFSET $3
        `,
        [runId, page.limit, page.offset],
      );
      const count = await client.query<{ total: string | number | bigint }>(
        `SELECT count(*)::bigint AS total FROM symphony.run_activity_event WHERE run_id = $1`,
        [runId],
      );
      const total = nullableNumber(count.rows[0]?.total ?? 0) ?? 0;
      const events = rows.rows.map(storedEventFromPostgresRow);
      const nextOffset = page.offset + events.length < total ? page.offset + events.length : null;
      return { runId, offset: page.offset, limit: page.limit, nextOffset, total, events };
    } finally {
      client.release?.();
    }
  }
}

export async function appendRunActivityEventsWithPostgresClient(
  client: PostgresQueryClient,
  inputs: readonly RunActivityAppendInput[],
): Promise<RunActivityAppendBatchResult> {
  if (inputs.length === 0) return emptyAppendBatchResult();

  const runIds = sortedUnique(inputs.map(runIdForAppendInput));
  await lockRunActivityAppendRuns(client, runIds);

  const runSessionIds = sortedUnique(inputs.map((input) => deriveRunActivityRunSessionId(input)));
  const eventIds = sortedUnique(inputs.map(eventIdForAppendInput));
  const existingRows = await client.query<RunActivityEventRow>(
    `
      SELECT
        run_activity_event_id::text AS append_revision,
        event_id,
        run_id,
        session_id,
        run_session_id,
        sequence,
        sequence_source,
        event_at,
        protocol,
        harness_id,
        external_event_id,
        actor,
        channel,
        kind,
        text,
        payload,
        payload_schema,
        payload_truncated,
        payload_byte_length,
        raw_payload_ref_id,
        metadata,
        created_at
      FROM symphony.run_activity_event
      WHERE run_session_id = ANY($1::text[]) OR event_id = ANY($2::text[])
      ORDER BY run_activity_event_id
      FOR UPDATE
    `,
    [runSessionIds, eventIds],
  );
  const state = new RunActivityAppendAccumulator(existingRows.rows.map(storedEventFromPostgresRow));

  return appendRunActivityEventsWithState(inputs, state, async (event, storage, context) => {
    const row = await insertRunActivityEventRow(client, event, storage, context);
    return storedEventFromPostgresRow(row);
  });
}

async function reduceAcceptedRunActivityMessageEventsWithPostgresClient(
  client: PostgresQueryClient,
  accepted: readonly RunActivityAcceptedAppendResult[],
): Promise<void> {
  const runSessionIds = sortedUnique(
    accepted.filter((result) => isChatMessageReductionTrigger(result.event)).map((result) => result.event.runSessionId),
  );
  for (const runSessionId of runSessionIds) {
    await reduceRunActivityChatMessagesWithPostgresClient(client, runSessionId);
  }
}

function isChatMessageReductionTrigger(event: RunActivityEvent): boolean {
  if (event.channel === "chat" || event.channel === "tool") return true;
  if (event.channel !== "terminal") return false;
  return event.kind !== "run_succeeded";
}

async function appendRunActivityEventsWithState(
  inputs: readonly RunActivityAppendInput[],
  state: RunActivityAppendAccumulator,
  persistAcceptedEvent: PersistAcceptedRunActivityEvent,
): Promise<RunActivityAppendBatchResult> {
  const results: RunActivityAppendResult[] = [];
  const accepted: RunActivityAcceptedAppendResult[] = [];
  const duplicates: RunActivityDuplicateAppendResult[] = [];
  const rejected: RunActivityRejectedAppendResult[] = [];

  for (const input of inputs) {
    const eventInput = eventInputForAppend(input);
    const runSessionId = deriveRunActivityRunSessionId(eventInput);
    const persistenceContext = persistenceContextForAppendInput(eventInput);
    const currentState = state.orderingStateFor(runSessionId);
    const existingByEventId = state.findByEventId(eventIdForAppendInput(eventInput));
    if (existingByEventId !== null) {
      const duplicateResult: RunActivityDuplicateAppendResult = {
        status: "duplicate",
        reason: "event_id",
        existingEvent: existingByEventId.event,
        metadata: existingByEventId.metadata,
        state: currentState,
      };
      results.push(duplicateResult);
      duplicates.push(duplicateResult);
      continue;
    }

    const ordering = applyRunActivityOrdering(eventInput, currentState);
    if (ordering.status === "duplicate") {
      const existing = state.findDuplicate(eventInput, ordering.reason, currentState);
      const duplicateResult: RunActivityDuplicateAppendResult = {
        status: "duplicate",
        reason: ordering.reason,
        existingEvent: existing.event,
        metadata: existing.metadata,
        state: ordering.state,
      };
      results.push(duplicateResult);
      duplicates.push(duplicateResult);
      continue;
    }

    if (ordering.status === "rejected") {
      const rejectedResult: RunActivityRejectedAppendResult = {
        status: "rejected",
        reason: ordering.reason,
        runSessionId,
        state: ordering.state,
      };
      results.push(rejectedResult);
      rejected.push(rejectedResult);
      continue;
    }

    const stored = await persistAcceptedEvent(
      ordering.event,
      normalizeStorageMetadata(input.storage, ordering.event),
      persistenceContext,
    );
    state.accept(stored, ordering.state);
    const acceptedResult: RunActivityAcceptedAppendResult = {
      status: "accepted",
      event: stored.event,
      metadata: stored.metadata,
      state: ordering.state,
    };
    results.push(acceptedResult);
    accepted.push(acceptedResult);
  }

  return { results, accepted, duplicates, rejected };
}

function eventInputForAppend(input: RunActivityAppendInput): RunActivityEventInput {
  const { storage: _storage, ...eventInput } = input;
  return eventInput;
}

function persistenceContextForAppendInput(input: RunActivityEventInput): RunActivityAppendPersistenceContext {
  return {
    runId: runIdForAppendInput(input),
    sessionId: sessionIdForAppendInput(input),
  };
}

function eventIdForAppendInput(input: RunActivityEventInput): string {
  return normalizeRequiredString(input.eventId ?? input.id, "run activity eventId");
}

function runIdForAppendInput(input: RunActivityEventInput): string {
  const explicit = normalizeOptionalString(input.runId);
  if (explicit !== null) return explicit;
  const runSessionId = normalizeOptionalString(input.runSessionId);
  if (runSessionId !== null) return runSessionId.split(":", 1)[0] ?? runSessionId;
  return "unknown-run";
}

function sessionIdForAppendInput(input: RunActivityEventInput): string | null {
  const explicit = normalizeOptionalString(input.sessionId);
  if (explicit !== null) return explicit;
  const runSessionId = normalizeOptionalString(input.runSessionId);
  if (runSessionId === null) return null;
  const separatorIndex = runSessionId.indexOf(":");
  return separatorIndex < 0 ? null : normalizeOptionalString(runSessionId.slice(separatorIndex + 1));
}

class RunActivityAppendAccumulator {
  private readonly stateByRunSessionId = new Map<string, RunActivityOrderingState>();
  private readonly byEventId = new Map<string, RunActivityStoredEvent>();
  private readonly byRunSessionSequence = new Map<string, RunActivityStoredEvent>();
  private readonly byRunSessionExternalId = new Map<string, RunActivityStoredEvent>();

  constructor(initialEvents: readonly RunActivityStoredEvent[]) {
    const eventsByRunSessionId = new Map<string, RunActivityStoredEvent[]>();
    for (const stored of initialEvents) {
      this.index(stored);
      const events = eventsByRunSessionId.get(stored.event.runSessionId) ?? [];
      events.push(stored);
      eventsByRunSessionId.set(stored.event.runSessionId, events);
    }

    for (const [runSessionId, events] of eventsByRunSessionId) {
      this.stateByRunSessionId.set(runSessionId, orderingStateFromStoredEvents(runSessionId, events));
    }
  }

  orderingStateFor(runSessionId: string): RunActivityOrderingState {
    return this.stateByRunSessionId.get(runSessionId) ?? createRunActivityOrderingState(runSessionId);
  }

  findByEventId(eventId: string): RunActivityStoredEvent | null {
    return this.byEventId.get(eventId) ?? null;
  }

  findDuplicate(
    input: RunActivityEventInput,
    reason: RunActivityDuplicateReason,
    currentState: RunActivityOrderingState,
  ): RunActivityStoredEvent {
    const runSessionId = currentState.runSessionId;
    const stored = (() => {
      if (reason === "event_id") return this.byEventId.get(eventIdForAppendInput(input));
      if (reason === "external_event_id") {
        const externalEventId = normalizeOptionalString(input.externalEventId);
        return externalEventId === null ? undefined : this.byRunSessionExternalId.get(scopedKey(runSessionId, externalEventId));
      }
      const sequence = positiveIntegerOrNull(input.sequence) ?? currentState.highWatermark + 1;
      return this.byRunSessionSequence.get(scopedKey(runSessionId, String(sequence)));
    })();

    if (stored === undefined) {
      throw new SymphonyError(
        "conflict",
        `Run activity duplicate ${reason} was detected but no existing persisted event was found`,
      );
    }
    return stored;
  }

  accept(stored: RunActivityStoredEvent, nextState: RunActivityOrderingState): void {
    this.index(stored);
    this.stateByRunSessionId.set(stored.event.runSessionId, nextState);
  }

  private index(stored: RunActivityStoredEvent): void {
    this.byEventId.set(stored.event.eventId, stored);
    this.byRunSessionSequence.set(scopedKey(stored.event.runSessionId, String(runActivityEventSequence(stored.event))), stored);
    const externalEventId = normalizeOptionalString(stored.event.externalEventId);
    if (externalEventId !== null) {
      this.byRunSessionExternalId.set(scopedKey(stored.event.runSessionId, externalEventId), stored);
    }
  }
}

function orderingStateFromStoredEvents(
  runSessionId: string,
  storedEvents: readonly RunActivityStoredEvent[],
): RunActivityOrderingState {
  const events = [...storedEvents].sort((left, right) => compareAppendRevision(left.metadata.appendRevision, right.metadata.appendRevision));
  const sequences = events
    .map((stored) => positiveIntegerOrNull(stored.event.sequence))
    .filter((sequence): sequence is number => sequence !== null);
  const terminalEvent = events.find((stored) => stored.event.channel === "terminal");
  return {
    runSessionId,
    highWatermark: sequences.reduce((max, sequence) => Math.max(max, sequence), 0),
    terminalSequence: terminalEvent === undefined ? null : runActivityEventSequence(terminalEvent.event),
    eventIds: events.map((stored) => stored.event.eventId),
    externalEventIds: events
      .map((stored) => normalizeOptionalString(stored.event.externalEventId))
      .filter((externalEventId): externalEventId is string => externalEventId !== null),
    sequences,
  };
}

async function lockRunActivityAppendRuns(client: PostgresQueryClient, runIds: readonly string[]): Promise<void> {
  const rows = await client.query<{ run_id: string }>(
    `
      SELECT run_id
      FROM symphony.run_session
      WHERE run_id = ANY($1::text[])
      ORDER BY run_id
      FOR UPDATE
    `,
    [runIds],
  );
  const locked = new Set(rows.rows.map((row) => row.run_id));
  const missing = runIds.filter((runId) => !locked.has(runId));
  if (missing.length > 0) {
    throw new SymphonyError("not_found", `Cannot append run activity events for unknown run(s): ${missing.join(", ")}`);
  }
}

async function insertRunActivityEventRow(
  client: PostgresQueryClient,
  event: RunActivityEvent,
  storage: RequiredRunActivityAppendStorageMetadata,
  context: RunActivityAppendPersistenceContext,
): Promise<RunActivityEventRow> {
  const payload = stringifyJsonObject(event.payload, "run activity payload");
  const metadata = stringifyJsonObject(storage.metadata, "run activity metadata");
  const row = await client.query<RunActivityEventRow>(
    `
      INSERT INTO symphony.run_activity_event (
        event_id,
        run_id,
        session_id,
        run_session_id,
        sequence,
        sequence_source,
        event_at,
        protocol,
        harness_id,
        external_event_id,
        actor,
        channel,
        kind,
        text,
        text_char_count,
        payload,
        payload_schema,
        payload_truncated,
        payload_byte_length,
        raw_payload_ref_id,
        metadata
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
        $16::jsonb,
        $17,
        $18,
        $19,
        $20,
        $21::jsonb
      )
      RETURNING
        run_activity_event_id::text AS append_revision,
        event_id,
        run_id,
        session_id,
        run_session_id,
        sequence,
        sequence_source,
        event_at,
        protocol,
        harness_id,
        external_event_id,
        actor,
        channel,
        kind,
        text,
        payload,
        payload_schema,
        payload_truncated,
        payload_byte_length,
        raw_payload_ref_id,
        metadata,
        created_at
    `,
    [
      event.eventId,
      context.runId,
      context.sessionId,
      event.runSessionId,
      runActivityEventSequence(event),
      event.sequenceSource,
      event.occurredAt,
      event.protocol,
      event.harness,
      event.externalEventId,
      event.actor,
      event.channel,
      event.kind,
      event.text,
      textCharCount(event.text),
      payload,
      storage.payloadSchema,
      storage.payloadTruncated,
      storage.payloadByteLength,
      storage.rawPayloadRefId,
      metadata,
    ],
  );
  const inserted = row.rows[0];
  if (inserted === undefined) {
    throw new SymphonyError("conflict", `Run activity event insert returned no row for event ${event.eventId}`);
  }
  return inserted;
}

function storedEventFromAcceptedEvent(
  event: RunActivityEvent,
  storage: RequiredRunActivityAppendStorageMetadata,
  metadata: Pick<RunActivityAppendMetadata, "appendRevision" | "createdAt" | "runId"> & { readonly sessionId: string | null },
): RunActivityStoredEvent {
  return {
    event,
    metadata: {
      eventId: event.eventId,
      runId: metadata.runId,
      sessionId: metadata.sessionId,
      runSessionId: event.runSessionId,
      sequence: runActivityEventSequence(event),
      sequenceSource: event.sequenceSource,
      appendRevision: metadata.appendRevision,
      createdAt: metadata.createdAt,
      externalEventId: event.externalEventId ?? null,
    },
    storage,
  };
}

function storedEventFromPostgresRow(row: RunActivityEventRow): RunActivityStoredEvent {
  const event = {
    eventId: row.event_id,
    runSessionId: row.run_session_id,
    occurredAt: toIsoString(row.event_at),
    sequence: Number(row.sequence),
    sequenceSource: row.sequence_source,
    externalEventId: normalizeOptionalString(row.external_event_id),
    protocol: row.protocol,
    harness: row.harness_id,
    actor: row.actor,
    channel: normalizeRunActivityChannel(row.channel),
    kind: row.kind,
    text: row.text,
    payload: sanitizeJsonObject(row.payload, "persisted run activity payload"),
  } as RunActivityEvent;
  return {
    event,
    metadata: {
      eventId: event.eventId,
      runId: row.run_id,
      sessionId: normalizeOptionalString(row.session_id),
      runSessionId: event.runSessionId,
      sequence: runActivityEventSequence(event),
      sequenceSource: event.sequenceSource,
      appendRevision: String(row.append_revision),
      createdAt: toIsoString(row.created_at),
      externalEventId: event.externalEventId ?? null,
    },
    storage: {
      payloadSchema: row.payload_schema,
      payloadTruncated: row.payload_truncated,
      payloadByteLength: nullableNumber(row.payload_byte_length),
      rawPayloadRefId: row.raw_payload_ref_id === null ? null : String(row.raw_payload_ref_id),
      metadata: sanitizeJsonObject(row.metadata, "persisted run activity metadata"),
    },
  };
}

function normalizeStorageMetadata(
  storage: RunActivityAppendStorageMetadata | undefined,
  event: RunActivityEvent,
): RequiredRunActivityAppendStorageMetadata {
  const metadata = sanitizeJsonObject(storage?.metadata ?? {}, "run activity metadata");
  const payloadJson = stringifyJsonObject(event.payload, "run activity payload");
  return {
    payloadSchema: normalizeOptionalString(storage?.payloadSchema),
    payloadTruncated: storage?.payloadTruncated ?? false,
    payloadByteLength: storage?.payloadByteLength ?? Buffer.byteLength(payloadJson, "utf8"),
    rawPayloadRefId: storage?.rawPayloadRefId === null || storage?.rawPayloadRefId === undefined ? null : String(storage.rawPayloadRefId),
    metadata,
  };
}

function notifyAcceptedRunActivityProjectionChanges(
  notifier: ProjectionRevisionNotifier,
  accepted: readonly RunActivityAcceptedAppendResult[],
): void {
  if (accepted.length === 0) return;
  for (const group of groupAcceptedRunActivityChanges(accepted)) {
    notifier.notify("run_activity", runActivityProjectionChangeDetail(group));
  }
}

function groupAcceptedRunActivityChanges(
  accepted: readonly RunActivityAcceptedAppendResult[],
): RunActivityAcceptedAppendResult[][] {
  const groups = new Map<string, RunActivityAcceptedAppendResult[]>();
  for (const result of accepted) {
    const key = `${result.metadata.runId}\u0000${result.metadata.runSessionId}`;
    const group = groups.get(key);
    if (group) {
      group.push(result);
    } else {
      groups.set(key, [result]);
    }
  }
  return Array.from(groups.values());
}

function runActivityProjectionChangeDetail(
  accepted: readonly RunActivityAcceptedAppendResult[],
): Readonly<Record<string, unknown>> {
  const first = accepted[0];
  if (!first) return { source: "run_activity", eventCount: 0 };
  const last = accepted[accepted.length - 1] ?? first;
  const sequences = accepted.map((result) => result.metadata.sequence).filter((sequence) => Number.isFinite(sequence));
  const firstSequence = sequences.length > 0 ? Math.min(...sequences) : null;
  const lastSequence = sequences.length > 0 ? Math.max(...sequences) : null;
  return {
    source: "run_activity",
    runId: first.metadata.runId,
    sessionId: first.metadata.sessionId ?? null,
    runSessionId: first.metadata.runSessionId,
    afterSequence: firstSequence === null ? null : Math.max(0, firstSequence - 1),
    firstSequence,
    lastSequence,
    eventCount: accepted.length,
    appendRevisionStart: first.metadata.appendRevision,
    appendRevisionEnd: last.metadata.appendRevision,
    status: runStatusForActivityProjectionChange(accepted.map((result) => result.event)),
    channels: sortedUnique(accepted.map((result) => result.event.channel)),
    kinds: sortedUnique(accepted.map((result) => String(result.event.kind))),
    resourcesChanged: ["history", "session-transcript", "dashboard", "sidebar"],
  };
}

function runStatusForActivityProjectionChange(events: readonly RunActivityEvent[]): string | null {
  for (const event of [...events].reverse()) {
    if (event.channel === "terminal") {
      if (event.kind === "run_succeeded") return "succeeded";
      if (event.kind === "run_cancelled" || event.kind === "run_interrupted" || event.kind === "run_aborted") return "cancelled";
      return "failed";
    }
    if (event.kind === "run_started" || event.kind === "session_started" || event.kind === "session_ready") return "running";
  }
  return null;
}

function emptyAppendBatchResult(): RunActivityAppendBatchResult {
  return { results: [], accepted: [], duplicates: [], rejected: [] };
}

async function rollbackRunActivityAppendQuietly(client: PostgresQueryClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original append failure.
  }
}

function runActivityEventSelectColumns(): string {
  return [
    "run_activity_event_id::text AS append_revision",
    "event_id",
    "run_id",
    "session_id",
    "run_session_id",
    "sequence",
    "sequence_source",
    "event_at",
    "protocol",
    "harness_id",
    "external_event_id",
    "actor",
    "channel",
    "kind",
    "text",
    "payload",
    "payload_schema",
    "payload_truncated",
    "payload_byte_length",
    "raw_payload_ref_id",
    "metadata",
    "created_at",
  ].join(", ");
}

function normalizeRunActivityReadPageOptions(options: { offset?: number; limit?: number }): { offset: number; limit: number } {
  return {
    offset: normalizeInteger(options.offset ?? 0, 0),
    limit: normalizeInteger(options.limit ?? 100, 1, 1_000),
  };
}

function compareRunActivityTranscriptOrder(left: RunActivityStoredEvent, right: RunActivityStoredEvent): number {
  return (
    runActivityEventSequence(left.event) - runActivityEventSequence(right.event) ||
    compareString(left.event.occurredAt, right.event.occurredAt) ||
    compareAppendRevision(left.metadata.appendRevision, right.metadata.appendRevision) ||
    compareString(left.event.eventId, right.event.eventId)
  );
}

function normalizeInteger(value: number, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const integer = Number.isFinite(value) ? Math.trunc(value) : minimum;
  return Math.min(Math.max(integer, minimum), maximum);
}

function compareString(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function runActivityEventSequence(event: RunActivityEvent): number {
  const sequence = positiveIntegerOrNull(event.sequence);
  if (sequence === null) throw new SymphonyError("invalid_request", `Run activity event ${event.eventId} must have a positive sequence`);
  return sequence;
}

function normalizeRequiredString(value: string | null | undefined, label: string): string {
  const normalized = normalizeOptionalString(value);
  if (normalized === null) throw new SymphonyError("invalid_request", `${label} must be non-empty`);
  return normalized;
}

function scopedKey(scope: string, value: string): string {
  return `${scope}\u0000${value}`;
}

function textCharCount(value: string | null): number {
  return value === null ? 0 : Array.from(value).length;
}

function positiveIntegerOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sanitizeJsonObject(value: unknown, label: string): Record<string, unknown> {
  const sanitized = sanitizeJson(value, label);
  if (isRecord(sanitized)) return sanitized;
  throw new SymphonyError("invalid_request", `${label} must be a JSON object`);
}

function stringifyJsonObject(value: unknown, label: string): string {
  return JSON.stringify(sanitizeJsonObject(value, label));
}

function sanitizeJson(value: unknown, label: string): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    throw new SymphonyError("invalid_request", `${label} must be JSON-serializable`, error);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableNumber(value: string | number | bigint | null): number | null {
  if (value === null) return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function toIsoString(value: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function compareAppendRevision(left: string, right: string): number {
  const leftNumber = BigInt(left);
  const rightNumber = BigInt(right);
  if (leftNumber < rightNumber) return -1;
  if (leftNumber > rightNumber) return 1;
  return 0;
}

import { describe, expect, it } from "vitest";
import type { QueryResultRow } from "pg";
import {
  InMemoryRunActivityAppendStore,
  PostgresRunActivityAppendStore,
  type PostgresRunActivityAppendClient,
  type RunActivityAppendInput,
} from "../src/core/persistence/RunActivityAppendStore.js";

function statusActivityInput(overrides: Record<string, unknown> = {}): RunActivityAppendInput {
  return {
    id: "activity-status-1",
    runId: "run-append",
    sessionId: "session-append",
    at: "2026-05-31T00:00:00.000Z",
    harnessId: "runtime-adapter",
    actor: "runtime",
    channel: "status",
    kind: "runtime_log",
    text: "runtime event",
    payload: {},
    protocol: "json_rpc",
    ...overrides,
  } as RunActivityAppendInput;
}

function terminalActivityInput(overrides: Record<string, unknown> = {}): RunActivityAppendInput {
  return statusActivityInput({
    id: "activity-terminal-1",
    actor: "orchestrator",
    channel: "terminal",
    kind: "run_succeeded",
    text: "run succeeded",
    payload: { reason: "run_succeeded" },
    protocol: "symphony",
    ...overrides,
  });
}

describe("RunActivityAppendStore", () => {
  it("appends a single missing-sequence event and returns sequence plus revision metadata", async () => {
    const store = new InMemoryRunActivityAppendStore();

    const result = await store.appendEvent(
      statusActivityInput({
        id: "activity-single",
        sequence: null,
        externalEventId: " upstream-single ",
        storage: { metadata: { adapter: "unit-test" } },
      }),
    );

    expect(result).toMatchObject({
      status: "accepted",
      event: {
        eventId: "activity-single",
        runSessionId: "run-append:session-append",
        occurredAt: "2026-05-31T00:00:00.000Z",
        harness: "runtime-adapter",
        channel: "diagnostic",
        sequence: 1,
        sequenceSource: "symphony",
        externalEventId: "upstream-single",
      },
      metadata: {
        eventId: "activity-single",
        runSessionId: "run-append:session-append",
        sequence: 1,
        sequenceSource: "symphony",
        appendRevision: "1",
      },
    });
    if (result.status !== "accepted") throw new Error("expected accepted append");
    expect("storage" in result.event).toBe(false);
  });

  it("appends batches in input order while assigning stable missing sequences above the high-water mark", async () => {
    const store = new InMemoryRunActivityAppendStore();

    const batch = await store.appendEvents([
      statusActivityInput({ id: "activity-sequence-1", sequence: 1 }),
      statusActivityInput({ id: "activity-sequence-3", sequence: 3 }),
      statusActivityInput({ id: "activity-missing-after-3", sequence: null }),
    ]);

    expect(batch.rejected).toEqual([]);
    expect(batch.duplicates).toEqual([]);
    expect(batch.accepted.map((result) => result.event.sequence)).toEqual([1, 3, 4]);
    expect(batch.accepted.map((result) => result.event.sequenceSource)).toEqual(["harness", "harness", "symphony"]);
    expect(batch.accepted.map((result) => result.metadata.appendRevision)).toEqual(["1", "2", "3"]);
  });

  it("treats duplicate event, external id, and sequence appends as idempotent no-ops", async () => {
    const store = new InMemoryRunActivityAppendStore();
    const first = await store.appendEvent(
      statusActivityInput({ id: "activity-unique", sequence: 1, externalEventId: "upstream-unique" }),
    );
    expect(first.status).toBe("accepted");

    const duplicateEventId = await store.appendEvent(statusActivityInput({ id: "activity-unique", sequence: 2 }));
    const duplicateExternalId = await store.appendEvent(
      statusActivityInput({ id: "activity-new-external", sequence: 2, externalEventId: "upstream-unique" }),
    );
    const duplicateSequence = await store.appendEvent(
      statusActivityInput({ id: "activity-new-sequence", sequence: 1, externalEventId: "upstream-new" }),
    );
    const afterDuplicates = await store.appendEvent(statusActivityInput({ id: "activity-after-duplicates", sequence: null }));

    expect(duplicateEventId).toMatchObject({ status: "duplicate", reason: "event_id", metadata: { appendRevision: "1" } });
    expect(duplicateExternalId).toMatchObject({
      status: "duplicate",
      reason: "external_event_id",
      metadata: { appendRevision: "1" },
    });
    expect(duplicateSequence).toMatchObject({ status: "duplicate", reason: "sequence", metadata: { appendRevision: "1" } });
    expect(afterDuplicates).toMatchObject({
      status: "accepted",
      event: { sequence: 2, sequenceSource: "symphony" },
      metadata: { appendRevision: "2" },
    });
  });

  it("preserves out-of-order explicit sequences and assigns later missing events after the high-water mark", async () => {
    const store = new InMemoryRunActivityAppendStore();

    const batch = await store.appendEvents([
      statusActivityInput({ id: "activity-1", sequence: 1 }),
      statusActivityInput({ id: "activity-4", sequence: 4 }),
      statusActivityInput({ id: "activity-2", sequence: 2 }),
      statusActivityInput({ id: "activity-missing-after-backfill", sequence: null }),
    ]);

    expect(batch.accepted.map((result) => result.event.sequence)).toEqual([1, 4, 2, 5]);
    expect(batch.accepted[2]).toMatchObject({ status: "accepted", event: { sequenceSource: "harness" } });
    expect(batch.accepted[3]).toMatchObject({ status: "accepted", event: { sequenceSource: "symphony" } });
  });

  it("enforces terminal boundaries while allowing explicit pre-terminal backfill", async () => {
    const store = new InMemoryRunActivityAppendStore();

    const batch = await store.appendEvents([
      statusActivityInput({ id: "activity-before-terminal", sequence: 1 }),
      terminalActivityInput({ id: "activity-terminal", sequence: 3 }),
      statusActivityInput({ id: "activity-post-terminal-missing", sequence: null }),
      statusActivityInput({ id: "activity-pre-terminal-backfill", sequence: 2 }),
      terminalActivityInput({ id: "activity-second-terminal", sequence: 4 }),
    ]);

    expect(batch.accepted.map((result) => result.event.eventId)).toEqual([
      "activity-before-terminal",
      "activity-terminal",
      "activity-pre-terminal-backfill",
    ]);
    expect(batch.rejected).toHaveLength(2);
    expect(batch.rejected.map((result) => result.reason)).toEqual(["terminal_already_accepted", "terminal_already_accepted"]);
    expect(store.readEvents("run-append:session-append").map((stored) => stored.event.sequence)).toEqual([1, 3, 2]);
  });

  it("wraps Postgres appends in one transaction and persists normalized ordering metadata", async () => {
    const client = new FakeRunActivityPostgresClient();
    const store = new PostgresRunActivityAppendStore({ connect: async () => client });

    const result = await store.appendEvent(
      statusActivityInput({
        id: "activity-postgres",
        runId: "run-postgres",
        sessionId: "session-postgres",
        runSessionId: "run-postgres:custom-scope",
        sequence: null,
        protocol: "acp",
        storage: { metadata: { source: "unit-test" } },
      }),
    );

    expect(result).toMatchObject({
      status: "accepted",
      event: {
        eventId: "activity-postgres",
        runSessionId: "run-postgres:custom-scope",
        occurredAt: "2026-05-31T00:00:00.000Z",
        harness: "runtime-adapter",
        channel: "diagnostic",
        sequence: 1,
        sequenceSource: "symphony",
        protocol: "acp",
      },
      metadata: { appendRevision: "1" },
    });
    expect(client.released).toBe(true);
    expect(client.normalizedStatements[0]).toBe("BEGIN");
    expect(client.normalizedStatements.at(-1)).toBe("COMMIT");
    expect(client.normalizedStatements).not.toContain("ROLLBACK");
    expect(client.insertValues[0]?.slice(0, 10)).toEqual([
      "activity-postgres",
      "run-postgres",
      "session-postgres",
      "run-postgres:custom-scope",
      1,
      "symphony",
      "2026-05-31T00:00:00.000Z",
      "acp",
      "runtime-adapter",
      null,
    ]);
  });

  it("reads paginated Postgres source-table events by run id for projection rebuilds", async () => {
    const client = new FakeRunActivityPostgresClient();
    const store = new PostgresRunActivityAppendStore({ connect: async () => client });

    await store.appendEvents([
      statusActivityInput({ id: "activity-page-1", runId: "run-postgres", sessionId: "session-postgres", sequence: 1 }),
      statusActivityInput({ id: "activity-other-run", runId: "run-other", sessionId: "session-other", sequence: 1 }),
      statusActivityInput({ id: "activity-page-2", runId: "run-postgres", sessionId: "session-postgres", sequence: 2 }),
    ]);

    const page = await store.readRunEvents("run-postgres", { offset: 0, limit: 1 });

    expect(page).toMatchObject({ runId: "run-postgres", offset: 0, limit: 1, nextOffset: 1, total: 2 });
    expect(page.events.map((stored) => stored.event.eventId)).toEqual(["activity-page-1"]);
    expect(client.released).toBe(true);
    expect(client.normalizedStatements.some((statement) => statement.includes("WHERE run_id = $1"))).toBe(true);
  });

  it("rolls back and releases the Postgres client when a transactional append fails", async () => {
    const client = new FakeRunActivityPostgresClient({ failInserts: true });
    const store = new PostgresRunActivityAppendStore({ connect: async () => client });

    await expect(store.appendEvent(statusActivityInput({ id: "activity-fails" }))).rejects.toThrow("insert failed");

    expect(client.released).toBe(true);
    expect(client.normalizedStatements).toContain("BEGIN");
    expect(client.normalizedStatements).toContain("ROLLBACK");
    expect(client.normalizedStatements).not.toContain("COMMIT");
  });
});

class FakeRunActivityPostgresClient implements PostgresRunActivityAppendClient {
  readonly normalizedStatements: string[] = [];
  readonly insertValues: readonly unknown[][] = [];
  released = false;
  private readonly rows: QueryResultRow[] = [];
  private readonly failInserts: boolean;

  constructor(options: { failInserts?: boolean } = {}) {
    this.failInserts = options.failInserts ?? false;
  }

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

    if (normalized.startsWith("SELECT count(*)::bigint AS total FROM symphony.run_activity_event")) {
      const runId = values?.[0];
      const total = this.rows.filter((row) => row.run_id === runId).length;
      return { rows: [{ total: String(total) } as unknown as T] };
    }

    if (normalized.startsWith("SELECT run_activity_event_id::text AS append_revision")) {
      if (normalized.includes("WHERE run_id = $1")) {
        const runId = values?.[0];
        const limit = Number(values?.[1] ?? 100);
        const offset = Number(values?.[2] ?? 0);
        return {
          rows: this.rows
            .filter((row) => row.run_id === runId)
            .sort((left, right) => Number(left.sequence) - Number(right.sequence))
            .slice(offset, offset + limit) as T[],
        };
      }
      return { rows: this.rows as T[] };
    }

    if (normalized.startsWith("INSERT INTO symphony.run_activity_event")) {
      if (this.failInserts) throw new Error("insert failed");
      const insertValues = [...(values ?? [])];
      (this.insertValues as unknown[][]).push(insertValues);
      const row = {
        append_revision: String(this.rows.length + 1),
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
      } satisfies QueryResultRow;
      this.rows.push(row);
      return { rows: [row as unknown as T] };
    }

    throw new Error(`Unexpected query: ${normalized}`);
  }

  release(): void {
    this.released = true;
  }
}

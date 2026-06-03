import { createHash } from "node:crypto";
import {
  mergeProjectionSourceFreshness,
  normalizeProjectionSourceFreshnessList,
  projectionSourceFreshnessFromCursors,
  projectionSourceFreshnessFromRevisions,
  sourceCursorsWithFreshness,
  type ProjectionSourceFreshness,
  type ProjectionSourceFreshnessInput,
} from "./ProjectionSourceFreshness.js";

export const DURABLE_PROJECTION_NAMES = [
  "dashboard_projection",
  "issue_board_projection",
  "sidebar_projection",
  "history_projection",
  "transcript_projection",
  "orchestrator_chat_projection",
] as const;

export type DurableProjectionName = (typeof DURABLE_PROJECTION_NAMES)[number];

export type ProjectionJsonObject = Record<string, unknown>;

export interface ProjectionSourceRevision {
  source: string;
  revision: string | number;
  observedAt: string | null;
}

export type ProjectionBuildMode = "bootstrap" | "incremental" | "rebuild";
export type ProjectionWriteMode = Exclude<ProjectionBuildMode, "bootstrap">;

export interface ProjectionRevisionSelector {
  projectionName: DurableProjectionName;
  scopeKind?: string | null;
  scopeKey?: string | null;
}

export interface ProjectionRevisionRecord {
  projectionRevisionId: string | number;
  projectionName: DurableProjectionName;
  scopeKind: string;
  scopeKey: string;
  revision: number;
  buildMode: ProjectionBuildMode;
  sourceRevisions: readonly ProjectionSourceRevision[];
  sourceCursors: ProjectionJsonObject;
  sourceFreshness: readonly ProjectionSourceFreshness[];
  contentSha256: string | null;
  generatedAt: string;
  expiresAt: string | null;
  supersededAt: string | null;
  createdAt: string | null;
}

export interface ProjectionPayloadFields {
  fetchedStates?: readonly unknown[];
  issueKey?: string | null;
  runId?: string | null;
  sessionId?: string | null;
  offsetStart?: number;
  offsetLimit?: number;
  nextOffset?: number | null;
  messageCount?: number;
  conversationKey?: string | null;
}

export interface ProjectionPayloadWriteInput extends ProjectionRevisionSelector {
  payload: unknown;
  /**
   * Identifies whether this write was requested by on-demand/read-repair maintenance
   * or by an explicit rebuild/backfill. The service derives `bootstrap` for the
   * first durable revision of a projection scope, regardless of the requested mode.
   */
  buildMode?: ProjectionWriteMode;
  sourceRevisions?: readonly (Partial<ProjectionSourceRevision> & Pick<ProjectionSourceRevision, "source" | "revision">)[];
  sourceCursors?: ProjectionJsonObject;
  sourceFreshness?: readonly ProjectionSourceFreshnessInput[];
  rawPayloadRefs?: readonly unknown[];
  contentSha256?: string | null;
  payloadSha256?: string | null;
  generatedAt?: Date | string;
  expiresAt?: Date | string | null;
  fields?: ProjectionPayloadFields;
}

export interface ProjectionRevisionInsertInput {
  projectionName: DurableProjectionName;
  scopeKind: string;
  scopeKey: string;
  revision: number;
  buildMode: ProjectionBuildMode;
  sourceRevisions: readonly ProjectionSourceRevision[];
  sourceCursors: ProjectionJsonObject;
  sourceFreshness: readonly ProjectionSourceFreshness[];
  contentSha256: string;
  generatedAt: string;
  expiresAt: string | null;
}

export interface ProjectionPayloadInsertInput {
  projectionName: DurableProjectionName;
  projectionRevisionId: string | number;
  scopeKey: string;
  revision: number;
  payload: unknown;
  payloadSha256: string;
  rawPayloadRefs: readonly unknown[];
  generatedAt: string;
  expiresAt: string | null;
  fields: NormalizedProjectionPayloadFields;
}

export interface ProjectionTransactionRevisionPort {
  readCurrentRevision(selector: NormalizedProjectionRevisionSelector, options?: { lock?: boolean }): Promise<ProjectionRevisionRecord | null>;
  readLatestRevision(selector: NormalizedProjectionRevisionSelector, options?: { lock?: boolean }): Promise<ProjectionRevisionRecord | null>;
  supersedeCurrentRevision(selector: NormalizedProjectionRevisionSelector, supersededAt: string): Promise<void>;
  insertProjectionRevision(input: ProjectionRevisionInsertInput): Promise<ProjectionRevisionRecord>;
  insertProjectionPayload(input: ProjectionPayloadInsertInput): Promise<void>;
}

export interface ProjectionTransactionStore {
  readCurrentRevision(selector: ProjectionRevisionSelector): Promise<ProjectionRevisionRecord | null>;
  readLatestRevision(selector: ProjectionRevisionSelector): Promise<ProjectionRevisionRecord | null>;
  withTransaction<T>(operation: (transaction: ProjectionTransactionRevisionPort) => Promise<T>): Promise<T>;
}

export interface ProjectionPayloadRecord<TPayload = unknown> {
  revision: ProjectionRevisionRecord;
  payload: TPayload;
  payloadSha256: string | null;
  rawPayloadRefs: readonly unknown[];
  generatedAt: string;
  expiresAt: string | null;
}

export interface ProjectionTranscriptDefaultPayloadSelector {
  runId: string;
  limit: number;
}

export interface ProjectionTransactionPayloadStore extends ProjectionTransactionStore {
  readCurrentPayload<TPayload = unknown>(selector: ProjectionRevisionSelector): Promise<ProjectionPayloadRecord<TPayload> | null>;
}

export interface ProjectionTranscriptDefaultPayloadStore extends ProjectionTransactionStore {
  readCurrentTranscriptDefaultPayload<TPayload = unknown>(
    selector: ProjectionTranscriptDefaultPayloadSelector,
  ): Promise<ProjectionPayloadRecord<TPayload> | null>;
}

export interface ProjectionRevisionPublication {
  projectionName: DurableProjectionName;
  scopeKind: string;
  scopeKey: string;
  projectionRevisionId: string | number;
  revision: number;
  buildMode: ProjectionBuildMode;
  contentSha256: string;
  generatedAt: string;
  expiresAt: string | null;
  sourceRevisions: readonly ProjectionSourceRevision[];
  sourceCursors: ProjectionJsonObject;
  sourceFreshness: readonly ProjectionSourceFreshness[];
}

export type ProjectionRevisionPublicationListener = (event: ProjectionRevisionPublication) => void;
export type ProjectionRevisionPublicationUnsubscribe = () => void;

export type ProjectionRevisionProviderListener = (revision: ProjectionSourceRevision) => void;

export interface ProjectionRevisionProvider {
  readonly source: string;
  getRevision(): ProjectionSourceRevision | Promise<ProjectionSourceRevision>;
  subscribe(listener: ProjectionRevisionProviderListener): ProjectionRevisionPublicationUnsubscribe;
}

export interface ProjectionRevisionProviderOptions {
  source?: string | null;
}

export type ProjectionWriteStatus = "written" | "unchanged";

export interface ProjectionWriteResult {
  status: ProjectionWriteStatus;
  revision: ProjectionRevisionRecord;
  previousRevision: ProjectionRevisionRecord | null;
  /** The caller-requested write mode. Rebuild attempts can still be `unchanged`. */
  requestedBuildMode: ProjectionWriteMode;
  /** The durable revision's actual build mode; first writes are reported as `bootstrap`. */
  buildMode: ProjectionBuildMode;
  contentSha256: string;
  payloadSha256: string;
  event: ProjectionRevisionPublication | null;
}

export interface ProjectionTransactionServiceOptions {
  clock?: () => Date;
  maxRetries?: number;
}

export interface ProjectionSqlQueryResult<TRow = Record<string, unknown>> {
  rows: TRow[];
}

export interface ProjectionSqlQueryRunner {
  query<TRow = Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<ProjectionSqlQueryResult<TRow>>;
}

export interface ProjectionSqlPool {
  connect(): Promise<ProjectionSqlQueryRunner & { release(): void }>;
}

export interface PostgresProjectionTransactionStoreOptions {
  schema?: string;
}

export interface NormalizedProjectionRevisionSelector {
  projectionName: DurableProjectionName;
  scopeKind: string;
  scopeKey: string;
}

interface NormalizedProjectionTranscriptDefaultPayloadSelector {
  runId: string;
  limit: number;
}

export interface NormalizedProjectionPayloadFields {
  fetchedStates: readonly unknown[];
  issueKey: string | null;
  runId: string | null;
  sessionId: string | null;
  offsetStart: number;
  offsetLimit: number;
  nextOffset: number | null;
  messageCount: number;
  conversationKey: string;
}

interface NormalizedProjectionPayloadWrite extends NormalizedProjectionRevisionSelector {
  payload: unknown;
  buildMode: ProjectionWriteMode;
  sourceRevisions: readonly ProjectionSourceRevision[];
  sourceCursors: ProjectionJsonObject;
  sourceFreshness: readonly ProjectionSourceFreshness[];
  rawPayloadRefs: readonly unknown[];
  contentSha256: string;
  payloadSha256: string;
  generatedAt: string;
  expiresAt: string | null;
  fields: NormalizedProjectionPayloadFields;
}

const DEFAULT_SCOPE_KIND = "global";
const DEFAULT_PROJECTION_SCOPE_KEYS: Record<DurableProjectionName, string> = {
  dashboard_projection: "global",
  issue_board_projection: "default-board",
  sidebar_projection: "global",
  history_projection: "global",
  transcript_projection: "global",
  orchestrator_chat_projection: "global",
};

const RETRYABLE_POSTGRES_ERROR_CODES = new Set(["23505", "40001", "40P01", "55P03"]);
const DEFAULT_MAX_RETRIES = 4;

export class ProjectionTransactionService {
  private readonly listeners = new Set<ProjectionRevisionPublicationListener>();
  private readonly clock: () => Date;
  private readonly maxRetries: number;

  constructor(
    private readonly store: ProjectionTransactionStore,
    options: ProjectionTransactionServiceOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  async readCurrentRevision(selector: ProjectionRevisionSelector): Promise<ProjectionRevisionRecord | null> {
    return this.store.readCurrentRevision(normalizeProjectionRevisionSelector(selector));
  }

  async readLatestRevision(selector: ProjectionRevisionSelector): Promise<ProjectionRevisionRecord | null> {
    return this.store.readLatestRevision(normalizeProjectionRevisionSelector(selector));
  }

  async readCurrentPayload<TPayload = unknown>(selector: ProjectionRevisionSelector): Promise<ProjectionPayloadRecord<TPayload> | null> {
    if (!isProjectionTransactionPayloadStore(this.store)) return null;
    return this.store.readCurrentPayload<TPayload>(normalizeProjectionRevisionSelector(selector));
  }

  async readCurrentTranscriptDefaultPayload<TPayload = unknown>(
    selector: ProjectionTranscriptDefaultPayloadSelector,
  ): Promise<ProjectionPayloadRecord<TPayload> | null> {
    if (!isProjectionTranscriptDefaultPayloadStore(this.store)) return null;
    return this.store.readCurrentTranscriptDefaultPayload<TPayload>(normalizeProjectionTranscriptDefaultPayloadSelector(selector));
  }

  async nextRevisionNumber(selector: ProjectionRevisionSelector): Promise<number> {
    const latest = await this.readLatestRevision(selector);
    return (latest?.revision ?? 0) + 1;
  }

  onProjectionChanged(listener: ProjectionRevisionPublicationListener): ProjectionRevisionPublicationUnsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  createRevisionProvider(
    selector: ProjectionRevisionSelector,
    options: ProjectionRevisionProviderOptions = {},
  ): ProjectionRevisionProvider {
    const normalized = normalizeProjectionRevisionSelector(selector);
    const source = normalizeNonEmptyString(options.source, projectionProviderSource(normalized), "projection revision provider source");
    return {
      source,
      getRevision: async () => {
        const record = await this.readCurrentRevision(normalized);
        return {
          source,
          revision: record?.revision ?? 0,
          observedAt: record?.generatedAt ?? null,
        };
      },
      subscribe: (listener) =>
        this.onProjectionChanged((event) => {
          if (!isProjectionPublicationForSelector(event, normalized)) return;
          listener({ source, revision: event.revision, observedAt: event.generatedAt });
        }),
    };
  }

  async writeProjection(input: ProjectionPayloadWriteInput): Promise<ProjectionWriteResult> {
    const normalized = normalizeProjectionPayloadWrite(input, this.clock);
    let attempt = 0;
    while (true) {
      try {
        const result = await this.writeProjectionOnce(normalized);
        if (result.event) this.publish(result.event);
        return result;
      } catch (error) {
        attempt += 1;
        if (attempt > this.maxRetries || !isRetryableProjectionWriteError(error)) throw error;
      }
    }
  }

  private async writeProjectionOnce(input: NormalizedProjectionPayloadWrite): Promise<ProjectionWriteResult> {
    return this.store.withTransaction(async (transaction) => {
      const selector = projectionSelectorFromNormalized(input);
      const current = await transaction.readCurrentRevision(selector, { lock: true });
      if (current && isSameProjectionInput(current, input)) {
        return {
          status: "unchanged",
          revision: current,
          previousRevision: current,
          requestedBuildMode: input.buildMode,
          buildMode: current.buildMode,
          contentSha256: input.contentSha256,
          payloadSha256: input.payloadSha256,
          event: null,
        } satisfies ProjectionWriteResult;
      }

      const latest = current ?? (await transaction.readLatestRevision(selector, { lock: true }));
      if (!current && latest && latest.supersededAt === null && isSameProjectionInput(latest, input)) {
        return {
          status: "unchanged",
          revision: latest,
          previousRevision: latest,
          requestedBuildMode: input.buildMode,
          buildMode: latest.buildMode,
          contentSha256: input.contentSha256,
          payloadSha256: input.payloadSha256,
          event: null,
        } satisfies ProjectionWriteResult;
      }
      const nextRevision = (latest?.revision ?? 0) + 1;
      const buildMode: ProjectionBuildMode = latest ? input.buildMode : "bootstrap";

      await transaction.supersedeCurrentRevision(selector, input.generatedAt);
      const revision = await transaction.insertProjectionRevision({
        projectionName: input.projectionName,
        scopeKind: input.scopeKind,
        scopeKey: input.scopeKey,
        revision: nextRevision,
        buildMode,
        sourceRevisions: input.sourceRevisions,
        sourceCursors: input.sourceCursors,
        sourceFreshness: input.sourceFreshness,
        contentSha256: input.contentSha256,
        generatedAt: input.generatedAt,
        expiresAt: input.expiresAt,
      });
      await transaction.insertProjectionPayload({
        projectionName: input.projectionName,
        projectionRevisionId: revision.projectionRevisionId,
        scopeKey: input.scopeKey,
        revision: nextRevision,
        payload: input.payload,
        payloadSha256: input.payloadSha256,
        rawPayloadRefs: input.rawPayloadRefs,
        generatedAt: input.generatedAt,
        expiresAt: input.expiresAt,
        fields: input.fields,
      });

      const event = revisionPublicationFromRecord(revision);
      return {
        status: "written",
        revision,
        previousRevision: current,
        requestedBuildMode: input.buildMode,
        buildMode: revision.buildMode,
        contentSha256: input.contentSha256,
        payloadSha256: input.payloadSha256,
        event,
      } satisfies ProjectionWriteResult;
    });
  }

  private publish(event: ProjectionRevisionPublication): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event);
      } catch {
        // Projection revision events invalidate API/SSE readers. The durable write
        // has already committed, so an observer failure must not corrupt writes.
      }
    }
  }
}

export class PostgresProjectionTransactionStore implements ProjectionTransactionPayloadStore {
  private readonly schema: string;
  private readonly directRunner: ProjectionSqlQueryRunner | null;
  private transactionQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly database: ProjectionSqlPool | ProjectionSqlQueryRunner,
    options: PostgresProjectionTransactionStoreOptions = {},
  ) {
    this.schema = options.schema ?? "symphony";
    assertSqlIdentifier(this.schema, "Postgres schema");
    this.directRunner = isProjectionSqlPool(database) ? null : database;
  }

  async readCurrentRevision(selector: ProjectionRevisionSelector): Promise<ProjectionRevisionRecord | null> {
    return this.withRunner((runner) => new PostgresProjectionTransaction(runner, this.schema).readCurrentRevision(normalizeProjectionRevisionSelector(selector)));
  }

  async readLatestRevision(selector: ProjectionRevisionSelector): Promise<ProjectionRevisionRecord | null> {
    return this.withRunner((runner) => new PostgresProjectionTransaction(runner, this.schema).readLatestRevision(normalizeProjectionRevisionSelector(selector)));
  }

  async readCurrentPayload<TPayload = unknown>(selector: ProjectionRevisionSelector): Promise<ProjectionPayloadRecord<TPayload> | null> {
    return this.withRunner((runner) => new PostgresProjectionTransaction(runner, this.schema).readCurrentPayload<TPayload>(normalizeProjectionRevisionSelector(selector)));
  }

  async readCurrentTranscriptDefaultPayload<TPayload = unknown>(
    selector: ProjectionTranscriptDefaultPayloadSelector,
  ): Promise<ProjectionPayloadRecord<TPayload> | null> {
    return this.withRunner((runner) =>
      new PostgresProjectionTransaction(runner, this.schema).readCurrentTranscriptDefaultPayload<TPayload>(
        normalizeProjectionTranscriptDefaultPayloadSelector(selector),
      ),
    );
  }

  async withTransaction<T>(operation: (transaction: ProjectionTransactionRevisionPort) => Promise<T>): Promise<T> {
    const run = () =>
      this.withRunner(async (runner) => {
        await runner.query("BEGIN");
        try {
          const result = await operation(new PostgresProjectionTransaction(runner, this.schema));
          await runner.query("COMMIT");
          return result;
        } catch (error) {
          await runner.query("ROLLBACK").catch(() => undefined);
          throw error;
        }
      });

    if (!this.directRunner) return run();
    const result = this.transactionQueue.then(run, run);
    this.transactionQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async withRunner<T>(operation: (runner: ProjectionSqlQueryRunner) => Promise<T>): Promise<T> {
    if (!isProjectionSqlPool(this.database)) return operation(this.database);
    const runner = await this.database.connect();
    try {
      return await operation(runner);
    } finally {
      runner.release();
    }
  }
}

class PostgresProjectionTransaction implements ProjectionTransactionRevisionPort {
  constructor(
    private readonly runner: ProjectionSqlQueryRunner,
    private readonly schema: string,
  ) {}

  async readCurrentRevision(
    selector: NormalizedProjectionRevisionSelector,
    options: { lock?: boolean } = {},
  ): Promise<ProjectionRevisionRecord | null> {
    const rows = await this.runner.query<ProjectionRevisionRow>(
      `SELECT ${projectionRevisionSelectColumns()}
       FROM ${this.table("projection_revision")}
       WHERE projection_name = $1 AND scope_kind = $2 AND scope_key = $3 AND superseded_at IS NULL
       ORDER BY revision DESC
       LIMIT 1${options.lock ? " FOR UPDATE" : ""}`,
      [selector.projectionName, selector.scopeKind, selector.scopeKey],
    );
    return mapProjectionRevisionRow(rows.rows[0]);
  }

  async readLatestRevision(
    selector: NormalizedProjectionRevisionSelector,
    options: { lock?: boolean } = {},
  ): Promise<ProjectionRevisionRecord | null> {
    const rows = await this.runner.query<ProjectionRevisionRow>(
      `SELECT ${projectionRevisionSelectColumns()}
       FROM ${this.table("projection_revision")}
       WHERE projection_name = $1 AND scope_kind = $2 AND scope_key = $3
       ORDER BY revision DESC, generated_at DESC
       LIMIT 1${options.lock ? " FOR UPDATE" : ""}`,
      [selector.projectionName, selector.scopeKind, selector.scopeKey],
    );
    return mapProjectionRevisionRow(rows.rows[0]);
  }

  async readCurrentPayload<TPayload = unknown>(selector: NormalizedProjectionRevisionSelector): Promise<ProjectionPayloadRecord<TPayload> | null> {
    const rows = await this.runner.query<ProjectionPayloadRow>(
      `SELECT ${projectionRevisionSelectColumns("revision")},
              payload.payload,
              payload.payload_sha256,
              payload.raw_payload_refs,
              payload.generated_at AS payload_generated_at,
              payload.expires_at AS payload_expires_at
       FROM ${this.table("projection_revision")} revision
       JOIN ${this.table(selector.projectionName)} payload
         ON payload.projection_revision_id = revision.projection_revision_id
       WHERE revision.projection_name = $1
         AND revision.scope_kind = $2
         AND revision.scope_key = $3
         AND revision.superseded_at IS NULL
       ORDER BY revision.revision DESC
       LIMIT 1`,
      [selector.projectionName, selector.scopeKind, selector.scopeKey],
    );
    return mapProjectionPayloadRow<TPayload>(rows.rows[0]);
  }

  async readCurrentTranscriptDefaultPayload<TPayload = unknown>(
    selector: NormalizedProjectionTranscriptDefaultPayloadSelector,
  ): Promise<ProjectionPayloadRecord<TPayload> | null> {
    const rows = await this.runner.query<ProjectionPayloadRow>(
      `SELECT ${projectionRevisionSelectColumns("revision")},
              payload.payload,
              payload.payload_sha256,
              payload.raw_payload_refs,
              payload.generated_at AS payload_generated_at,
              payload.expires_at AS payload_expires_at
       FROM ${this.table("projection_revision")} revision
       JOIN ${this.table("transcript_projection")} payload
         ON payload.projection_revision_id = revision.projection_revision_id
       WHERE revision.projection_name = 'transcript_projection'
         AND revision.scope_kind = 'run_page'
         AND revision.superseded_at IS NULL
         AND payload.run_id = $1
         AND payload.offset_limit = $2
       ORDER BY (payload.next_offset IS NULL) DESC,
                payload.message_count DESC,
                payload.offset_start DESC,
                revision.revision DESC,
                payload.generated_at DESC
       LIMIT 1`,
      [selector.runId, selector.limit],
    );
    return mapProjectionPayloadRow<TPayload>(rows.rows[0]);
  }

  async supersedeCurrentRevision(selector: NormalizedProjectionRevisionSelector, supersededAt: string): Promise<void> {
    await this.runner.query(
      `UPDATE ${this.table("projection_revision")}
       SET superseded_at = $4::timestamptz
       WHERE projection_name = $1 AND scope_kind = $2 AND scope_key = $3 AND superseded_at IS NULL`,
      [selector.projectionName, selector.scopeKind, selector.scopeKey, supersededAt],
    );
  }

  async insertProjectionRevision(input: ProjectionRevisionInsertInput): Promise<ProjectionRevisionRecord> {
    const rows = await this.runner.query<ProjectionRevisionRow>(
      `INSERT INTO ${this.table("projection_revision")} (
         projection_name,
         scope_kind,
         scope_key,
         revision,
         build_mode,
         source_revisions,
         source_cursors,
         source_freshness,
         content_sha256,
         generated_at,
         expires_at
       ) VALUES ($1, $2, $3, $4::bigint, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10::timestamptz, $11::timestamptz)
       RETURNING ${projectionRevisionSelectColumns()}`,
      [
        input.projectionName,
        input.scopeKind,
        input.scopeKey,
        input.revision,
        input.buildMode,
        stableJsonStringify(input.sourceRevisions),
        stableJsonStringify(input.sourceCursors),
        stableJsonStringify(input.sourceFreshness),
        input.contentSha256,
        input.generatedAt,
        input.expiresAt,
      ],
    );
    const row = mapProjectionRevisionRow(rows.rows[0]);
    if (!row) throw new Error("Projection revision insert returned no row");
    return row;
  }

  async insertProjectionPayload(input: ProjectionPayloadInsertInput): Promise<void> {
    const statement = projectionPayloadInsertStatement(this.schema, input);
    await this.runner.query(statement.sql, statement.values);
  }

  private table(tableName: string): string {
    assertSqlIdentifier(tableName, "Postgres table");
    return `${quoteSqlIdentifier(this.schema)}.${quoteSqlIdentifier(tableName)}`;
  }
}

interface ProjectionRevisionRow {
  projection_revision_id: string | number;
  projection_name: string;
  scope_kind: string;
  scope_key: string;
  revision: string | number;
  build_mode?: string | null;
  source_revisions: unknown;
  source_cursors: unknown;
  source_freshness?: unknown;
  content_sha256: string | null;
  generated_at: string | Date;
  expires_at: string | Date | null;
  superseded_at: string | Date | null;
  created_at: string | Date | null;
}

interface ProjectionPayloadInsertStatement {
  sql: string;
  values: unknown[];
}

interface ProjectionPayloadRow extends ProjectionRevisionRow {
  payload: unknown;
  payload_sha256: string | null;
  raw_payload_refs: unknown;
  payload_generated_at: string | Date;
  payload_expires_at: string | Date | null;
}

function projectionSelectorFromNormalized(input: NormalizedProjectionRevisionSelector): NormalizedProjectionRevisionSelector {
  return { projectionName: input.projectionName, scopeKind: input.scopeKind, scopeKey: input.scopeKey };
}

function normalizeProjectionRevisionSelector(selector: ProjectionRevisionSelector): NormalizedProjectionRevisionSelector {
  assertDurableProjectionName(selector.projectionName);
  const scopeKind = normalizeNonEmptyString(selector.scopeKind, DEFAULT_SCOPE_KIND, "projection scope kind");
  const scopeKey = normalizeNonEmptyString(
    selector.scopeKey,
    DEFAULT_PROJECTION_SCOPE_KEYS[selector.projectionName],
    "projection scope key",
  );
  return { projectionName: selector.projectionName, scopeKind, scopeKey };
}

function normalizeProjectionTranscriptDefaultPayloadSelector(
  selector: ProjectionTranscriptDefaultPayloadSelector,
): NormalizedProjectionTranscriptDefaultPayloadSelector {
  return {
    runId: normalizeNonEmptyString(selector.runId, null, "transcript projection runId"),
    limit: normalizeInteger(selector.limit, { minimum: 1, name: "transcript projection limit" }),
  };
}

function normalizeProjectionPayloadWrite(input: ProjectionPayloadWriteInput, clock: () => Date): NormalizedProjectionPayloadWrite {
  const selector = normalizeProjectionRevisionSelector(input);
  const generatedAt = dateLikeToIso(input.generatedAt ?? clock(), "generatedAt");
  const expiresAt = input.expiresAt === undefined || input.expiresAt === null ? null : dateLikeToIso(input.expiresAt, "expiresAt");
  const payload = canonicalJsonValue(input.payload);
  const buildMode = normalizeProjectionWriteMode(input.buildMode);
  const contentSha256 = normalizeOptionalSha256(input.contentSha256, "contentSha256") ?? sha256Hex(stableJsonStringify(payload));
  const payloadSha256 = normalizeOptionalSha256(input.payloadSha256, "payloadSha256") ?? contentSha256;
  const sourceRevisions = normalizeSourceRevisions(input.sourceRevisions ?? []);
  const baseSourceCursors = normalizeJsonObject(input.sourceCursors ?? {}, "sourceCursors");
  const sourceFreshness = normalizePayloadSourceFreshness(input.sourceFreshness, baseSourceCursors, sourceRevisions, generatedAt);
  const sourceCursors = sourceCursorsWithFreshness(baseSourceCursors, sourceFreshness);
  const rawPayloadRefs = normalizeJsonArray(input.rawPayloadRefs ?? [], "rawPayloadRefs");
  const fields = normalizePayloadFields(input.fields ?? {}, selector.projectionName);
  return {
    ...selector,
    payload,
    buildMode,
    sourceRevisions,
    sourceCursors,
    sourceFreshness,
    rawPayloadRefs,
    contentSha256,
    payloadSha256,
    generatedAt,
    expiresAt,
    fields,
  };
}

function normalizePayloadFields(fields: ProjectionPayloadFields, projectionName: DurableProjectionName): NormalizedProjectionPayloadFields {
  const normalized: NormalizedProjectionPayloadFields = {
    fetchedStates: normalizeJsonArray(fields.fetchedStates ?? [], "fetchedStates"),
    issueKey: normalizeNullableString(fields.issueKey, "issueKey"),
    runId: normalizeNullableString(fields.runId, "runId"),
    sessionId: normalizeNullableString(fields.sessionId, "sessionId"),
    offsetStart: normalizeInteger(fields.offsetStart ?? 0, { minimum: 0, name: "offsetStart" }),
    offsetLimit: normalizeInteger(fields.offsetLimit ?? 100, { minimum: 1, name: "offsetLimit" }),
    nextOffset: fields.nextOffset === undefined || fields.nextOffset === null ? null : normalizeInteger(fields.nextOffset, { minimum: 0, name: "nextOffset" }),
    messageCount: normalizeInteger(fields.messageCount ?? 0, { minimum: 0, name: "messageCount" }),
    conversationKey: normalizeNonEmptyString(fields.conversationKey, "default", "conversationKey"),
  };

  if (projectionName === "transcript_projection" && normalized.runId === null) {
    normalized.runId = normalized.issueKey ?? "global";
  }
  return normalized;
}

function isSameProjectionInput(current: ProjectionRevisionRecord, input: NormalizedProjectionPayloadWrite): boolean {
  return (
    current.contentSha256 === input.contentSha256 &&
    stableJsonStringify(current.sourceRevisions) === stableJsonStringify(input.sourceRevisions) &&
    stableJsonStringify(current.sourceCursors) === stableJsonStringify(input.sourceCursors) &&
    stableJsonStringify(current.sourceFreshness) === stableJsonStringify(input.sourceFreshness)
  );
}

function isProjectionPublicationForSelector(
  event: ProjectionRevisionPublication,
  selector: NormalizedProjectionRevisionSelector,
): boolean {
  return event.projectionName === selector.projectionName && event.scopeKind === selector.scopeKind && event.scopeKey === selector.scopeKey;
}

function projectionProviderSource(selector: NormalizedProjectionRevisionSelector): string {
  return `${selector.projectionName}:${selector.scopeKind}:${selector.scopeKey}`;
}

function revisionPublicationFromRecord(record: ProjectionRevisionRecord): ProjectionRevisionPublication {
  return {
    projectionName: record.projectionName,
    scopeKind: record.scopeKind,
    scopeKey: record.scopeKey,
    projectionRevisionId: record.projectionRevisionId,
    revision: record.revision,
    buildMode: record.buildMode,
    contentSha256: record.contentSha256 ?? "",
    generatedAt: record.generatedAt,
    expiresAt: record.expiresAt,
    sourceRevisions: record.sourceRevisions,
    sourceCursors: record.sourceCursors,
    sourceFreshness: record.sourceFreshness,
  };
}

function projectionRevisionSelectColumns(tableAlias?: string): string {
  const columns = [
    "projection_revision_id",
    "projection_name",
    "scope_kind",
    "scope_key",
    "revision",
    "build_mode",
    "source_revisions",
    "source_cursors",
    "source_freshness",
    "content_sha256",
    "generated_at",
    "expires_at",
    "superseded_at",
    "created_at",
  ];
  if (!tableAlias) return columns.join(", ");
  assertSqlIdentifier(tableAlias, "projection revision table alias");
  return columns.map((column) => `${quoteSqlIdentifier(tableAlias)}.${quoteSqlIdentifier(column)} AS ${quoteSqlIdentifier(column)}`).join(", ");
}

function projectionPayloadInsertStatement(schema: string, input: ProjectionPayloadInsertInput): ProjectionPayloadInsertStatement {
  assertDurableProjectionName(input.projectionName);
  const columns: string[] = [];
  const expressions: string[] = [];
  const values: unknown[] = [];
  const push = (column: string, value: unknown, cast?: string) => {
    assertSqlIdentifier(column, "projection payload column");
    values.push(value);
    columns.push(quoteSqlIdentifier(column));
    expressions.push(`$${values.length}${cast ? `::${cast}` : ""}`);
  };

  push("projection_revision_id", input.projectionRevisionId, "bigint");
  push("scope_key", input.scopeKey);
  push("revision", input.revision, "bigint");

  switch (input.projectionName) {
    case "dashboard_projection":
    case "sidebar_projection":
      break;
    case "issue_board_projection":
      push("fetched_states", stableJsonStringify(input.fields.fetchedStates), "jsonb");
      break;
    case "history_projection":
      push("issue_key", input.fields.issueKey);
      push("run_id", input.fields.runId);
      push("session_id", input.fields.sessionId);
      break;
    case "transcript_projection":
      push("run_id", input.fields.runId ?? input.scopeKey);
      push("session_id", input.fields.sessionId);
      push("offset_start", input.fields.offsetStart, "integer");
      push("offset_limit", input.fields.offsetLimit, "integer");
      push("next_offset", input.fields.nextOffset, "integer");
      push("message_count", input.fields.messageCount, "integer");
      break;
    case "orchestrator_chat_projection":
      push("issue_key", input.fields.issueKey);
      push("run_id", input.fields.runId);
      push("conversation_key", input.fields.conversationKey);
      break;
  }

  push("payload", stableJsonStringify(input.payload), "jsonb");
  push("payload_sha256", input.payloadSha256);
  push("raw_payload_refs", stableJsonStringify(input.rawPayloadRefs), "jsonb");
  push("generated_at", input.generatedAt, "timestamptz");
  push("expires_at", input.expiresAt, "timestamptz");

  return {
    sql: `INSERT INTO ${quoteSqlIdentifier(schema)}.${quoteSqlIdentifier(input.projectionName)} (${columns.join(", ")}) VALUES (${expressions.join(", ")})`,
    values,
  };
}

function mapProjectionRevisionRow(row: ProjectionRevisionRow | undefined): ProjectionRevisionRecord | null {
  if (!row) return null;
  assertDurableProjectionName(row.projection_name);
  const revision = numberFromDb(row.revision, "projection revision");
  return {
    projectionRevisionId: row.projection_revision_id,
    projectionName: row.projection_name,
    scopeKind: row.scope_kind,
    scopeKey: row.scope_key,
    revision,
    buildMode: projectionBuildModeFromDb(row.build_mode, revision),
    sourceRevisions: normalizeSourceRevisions(jsonFromDb(row.source_revisions, "source_revisions")),
    sourceCursors: normalizeJsonObject(jsonFromDb(row.source_cursors, "source_cursors"), "source_cursors"),
    sourceFreshness: mapProjectionRevisionSourceFreshness(row),
    contentSha256: row.content_sha256,
    generatedAt: dateLikeToIso(row.generated_at, "generated_at"),
    expiresAt: row.expires_at === null ? null : dateLikeToIso(row.expires_at, "expires_at"),
    supersededAt: row.superseded_at === null ? null : dateLikeToIso(row.superseded_at, "superseded_at"),
    createdAt: row.created_at === null ? null : dateLikeToIso(row.created_at, "created_at"),
  };
}

function mapProjectionPayloadRow<TPayload = unknown>(row: ProjectionPayloadRow | undefined): ProjectionPayloadRecord<TPayload> | null {
  if (!row) return null;
  const revision = mapProjectionRevisionRow(row);
  if (!revision) return null;
  return {
    revision,
    payload: jsonFromDb(row.payload, "payload") as TPayload,
    payloadSha256: row.payload_sha256,
    rawPayloadRefs: normalizeJsonArray(jsonFromDb(row.raw_payload_refs, "raw_payload_refs"), "raw_payload_refs"),
    generatedAt: dateLikeToIso(row.payload_generated_at, "payload_generated_at"),
    expiresAt: row.payload_expires_at === null ? null : dateLikeToIso(row.payload_expires_at, "payload_expires_at"),
  };
}

function mapProjectionRevisionSourceFreshness(row: ProjectionRevisionRow): ProjectionSourceFreshness[] {
  const generatedAt = dateLikeToIso(row.generated_at, "generated_at");
  const sourceRevisions = normalizeSourceRevisions(jsonFromDb(row.source_revisions, "source_revisions"));
  const sourceCursors = normalizeJsonObject(jsonFromDb(row.source_cursors, "source_cursors"), "source_cursors");
  if (row.source_freshness !== undefined && row.source_freshness !== null) {
    return normalizeProjectionSourceFreshnessList(jsonFromDb(row.source_freshness, "source_freshness"), { defaultCheckedAt: generatedAt });
  }
  return normalizePayloadSourceFreshness(undefined, sourceCursors, sourceRevisions, generatedAt);
}

function normalizePayloadSourceFreshness(
  explicit: readonly ProjectionSourceFreshnessInput[] | undefined,
  sourceCursors: ProjectionJsonObject,
  sourceRevisions: readonly ProjectionSourceRevision[],
  generatedAt: string,
): ProjectionSourceFreshness[] {
  const defaultCheckedAt = generatedAt;
  const explicitFreshness = explicit === undefined ? [] : normalizeProjectionSourceFreshnessList(explicit, { defaultCheckedAt });
  return mergeProjectionSourceFreshness([
    projectionSourceFreshnessFromRevisions(sourceRevisions, { defaultCheckedAt }),
    projectionSourceFreshnessFromCursors(sourceCursors, { defaultCheckedAt }),
    explicitFreshness,
  ]);
}

function normalizeSourceRevisions(revisions: unknown): ProjectionSourceRevision[] {
  if (!Array.isArray(revisions)) throw new Error("sourceRevisions must be an array");
  return revisions
    .map((revision, index) => {
      if (!revision || typeof revision !== "object") throw new Error(`sourceRevisions[${index}] must be an object`);
      const record = revision as Record<string, unknown>;
      const source = normalizeNonEmptyString(record.source, null, `sourceRevisions[${index}].source`);
      const revisionValue = record.revision;
      if (typeof revisionValue !== "string" && typeof revisionValue !== "number") {
        throw new Error(`sourceRevisions[${index}].revision must be a string or number`);
      }
      return {
        source,
        revision: revisionValue,
        observedAt: record.observedAt === undefined || record.observedAt === null ? null : dateLikeToIso(record.observedAt as string | Date, `sourceRevisions[${index}].observedAt`),
      };
    })
    .sort(compareProjectionSourceRevision);
}

function compareProjectionSourceRevision(left: ProjectionSourceRevision, right: ProjectionSourceRevision): number {
  return (
    left.source.localeCompare(right.source) ||
    String(left.revision).localeCompare(String(right.revision)) ||
    (left.observedAt ?? "").localeCompare(right.observedAt ?? "")
  );
}

function normalizeJsonObject(value: unknown, name: string): ProjectionJsonObject {
  const normalized = canonicalJsonValue(value);
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) throw new Error(`${name} must be a JSON object`);
  return normalized as ProjectionJsonObject;
}

function normalizeJsonArray(value: unknown, name: string): readonly unknown[] {
  const normalized = canonicalJsonValue(value);
  if (!Array.isArray(normalized)) throw new Error(`${name} must be a JSON array`);
  return normalized;
}

function normalizeOptionalSha256(value: string | null | undefined, name: string): string | null {
  if (value === undefined || value === null) return null;
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error(`${name} must be a lowercase or uppercase SHA-256 hex digest`);
  return normalized;
}

function normalizeProjectionWriteMode(value: ProjectionWriteMode | null | undefined): ProjectionWriteMode {
  if (value === undefined || value === null) return "incremental";
  if (value === "incremental" || value === "rebuild") return value;
  throw new Error("buildMode must be incremental or rebuild");
}

function projectionBuildModeFromDb(value: string | null | undefined, revision: number): ProjectionBuildMode {
  if (value === undefined || value === null || value.trim().length === 0) {
    return revision === 1 ? "bootstrap" : "incremental";
  }
  const normalized = value.trim();
  if (normalized === "bootstrap" || normalized === "incremental" || normalized === "rebuild") return normalized;
  throw new Error(`Unsupported projection build mode: ${value}`);
}

function normalizeNullableString(value: string | null | undefined, name: string): string | null {
  if (value === undefined || value === null) return null;
  return normalizeNonEmptyString(value, null, name);
}

function normalizeNonEmptyString(value: unknown, fallback: string | null, name: string): string {
  if (value === undefined || value === null) {
    if (fallback === null) throw new Error(`${name} must be non-empty`);
    return fallback;
  }
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (normalized.length === 0) {
    if (fallback === null) throw new Error(`${name} must be non-empty`);
    return fallback;
  }
  return normalized;
}

function normalizeInteger(value: number, options: { minimum: number; name: string }): number {
  if (!Number.isInteger(value)) throw new Error(`${options.name} must be an integer`);
  if (value < options.minimum) throw new Error(`${options.name} must be >= ${options.minimum}`);
  return value;
}

function canonicalJsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => canonicalJsonValue(item));
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const child = record[key];
      if (child !== undefined) output[key] = canonicalJsonValue(child);
    }
    return output;
  }
  throw new Error(`Unsupported JSON value type: ${typeof value}`);
}

function stableJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function dateLikeToIso(value: Date | string, name: string): string {
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  if (!Number.isFinite(time)) throw new Error(`${name} must be a valid date`);
  return date.toISOString();
}

function jsonFromDb(value: unknown, name: string): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as unknown;
    } catch (error) {
      throw new Error(`${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return value;
}

function numberFromDb(value: string | number, name: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${name} is not a safe integer`);
  return number;
}

function assertDurableProjectionName(value: string): asserts value is DurableProjectionName {
  if (!(DURABLE_PROJECTION_NAMES as readonly string[]).includes(value)) throw new Error(`Unsupported projection name: ${value}`);
}

function assertSqlIdentifier(value: string, name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`${name} must be a safe SQL identifier`);
}

function quoteSqlIdentifier(value: string): string {
  assertSqlIdentifier(value, "SQL identifier");
  return `"${value}"`;
}

function isProjectionSqlPool(value: ProjectionSqlPool | ProjectionSqlQueryRunner): value is ProjectionSqlPool {
  return typeof (value as Partial<ProjectionSqlPool>).connect === "function";
}

function isProjectionTransactionPayloadStore(store: ProjectionTransactionStore): store is ProjectionTransactionPayloadStore {
  return typeof (store as Partial<ProjectionTransactionPayloadStore>).readCurrentPayload === "function";
}

function isProjectionTranscriptDefaultPayloadStore(
  store: ProjectionTransactionStore,
): store is ProjectionTranscriptDefaultPayloadStore {
  return typeof (store as Partial<ProjectionTranscriptDefaultPayloadStore>).readCurrentTranscriptDefaultPayload === "function";
}

function isRetryableProjectionWriteError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && RETRYABLE_POSTGRES_ERROR_CODES.has(code);
}

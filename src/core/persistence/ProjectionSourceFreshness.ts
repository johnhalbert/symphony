export const PROJECTION_SOURCE_FRESHNESS_STATUSES = [
  "fresh",
  "stale",
  "error",
  "empty",
  "loading",
  "never_synced",
] as const;

export type ProjectionSourceFreshnessStatus = (typeof PROJECTION_SOURCE_FRESHNESS_STATUSES)[number];

export interface ProjectionSourceFreshness {
  source: string;
  status: ProjectionSourceFreshnessStatus;
  checkedAt: string;
  revision: string | number | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  staleMs: number | null;
  detail: string | null;
}

export interface ProjectionSourceFreshnessInput {
  source: string;
  status?: ProjectionSourceFreshnessStatus | "failed" | "ok" | "success" | "pending" | "never-synced" | string;
  checkedAt?: Date | string | null;
  revision?: string | number | null;
  lastSuccessAt?: Date | string | null;
  lastErrorAt?: Date | string | null;
  staleMs?: number | null;
  detail?: string | null;
}

export interface ProjectionSourceRevisionLike {
  source: string;
  revision: string | number;
  observedAt?: Date | string | null;
}

export interface NormalizeProjectionSourceFreshnessOptions {
  defaultCheckedAt: Date | string;
}

export interface ProjectionSourceFreshnessFromRevisionsOptions extends NormalizeProjectionSourceFreshnessOptions {
  emptyRevisionSources?: readonly string[];
}

const DEFAULT_EMPTY_REVISION_SOURCES = ["runs", "workspaces", "lifecycles", "writebacks"] as const;
const STATUS_CODED_REVISION_SOURCES = new Set(["github", "harness", "linear", "trackerIssues"]);

export function normalizeProjectionSourceFreshnessList(
  input: unknown,
  options: NormalizeProjectionSourceFreshnessOptions,
): ProjectionSourceFreshness[] {
  const records = projectionSourceFreshnessInputs(input);
  return records
    .map((record, index) => normalizeProjectionSourceFreshness(record, options.defaultCheckedAt, `sourceFreshness[${index}]`))
    .sort(compareProjectionSourceFreshness);
}

export function mergeProjectionSourceFreshness(
  lists: readonly (readonly ProjectionSourceFreshness[])[],
): ProjectionSourceFreshness[] {
  const bySource = new Map<string, ProjectionSourceFreshness>();
  for (const list of lists) {
    for (const record of list) bySource.set(record.source, { ...record });
  }
  return [...bySource.values()].sort(compareProjectionSourceFreshness);
}

export function projectionSourceFreshnessFromRevisions(
  revisions: readonly ProjectionSourceRevisionLike[],
  options: ProjectionSourceFreshnessFromRevisionsOptions,
): ProjectionSourceFreshness[] {
  const emptySources = new Set((options.emptyRevisionSources ?? DEFAULT_EMPTY_REVISION_SOURCES).map((source) => source.trim()).filter(Boolean));
  const inputs = revisions.map((revision) => {
    const observedAt = revision.observedAt ?? null;
    const revisionText = String(revision.revision);
    const derivedFreshness = deriveSourceFreshnessFromRevision(revision.source, revision.revision, emptySources);
    return {
      source: revision.source,
      status: derivedFreshness.status,
      checkedAt: observedAt ?? options.defaultCheckedAt,
      revision: revision.revision,
      lastSuccessAt: sourceRevisionStatusCanHaveLastSuccess(derivedFreshness.status) ? observedAt : null,
      detail: derivedFreshness.detail ?? freshnessDetailForRevision(revision.source, derivedFreshness.status, revisionText),
    } satisfies ProjectionSourceFreshnessInput;
  });
  return normalizeProjectionSourceFreshnessList(inputs, options);
}

export function projectionSourceFreshnessFromCursors(
  cursors: Readonly<Record<string, unknown>>,
  options: NormalizeProjectionSourceFreshnessOptions,
): ProjectionSourceFreshness[] {
  const embedded = cursors.sourceFreshness ?? cursors.freshness;
  if (embedded !== undefined) return normalizeProjectionSourceFreshnessList(embedded, options);

  const records: ProjectionSourceFreshnessInput[] = [];
  for (const [source, cursor] of Object.entries(cursors)) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) continue;
    const record = cursor as Record<string, unknown>;
    if (!looksLikeFreshnessCursor(record)) continue;
    records.push({ source, ...record } as ProjectionSourceFreshnessInput);
  }
  return normalizeProjectionSourceFreshnessList(records, options);
}

export function sourceCursorsWithFreshness(
  sourceCursors: Readonly<Record<string, unknown>>,
  sourceFreshness: readonly ProjectionSourceFreshness[],
): Record<string, unknown> {
  if (sourceFreshness.length === 0) return { ...sourceCursors };
  return {
    ...sourceCursors,
    sourceFreshness: sourceFreshness.map((record) => ({ ...record })),
  };
}

export function compareProjectionSourceFreshness(left: ProjectionSourceFreshness, right: ProjectionSourceFreshness): number {
  return left.source.localeCompare(right.source) || left.status.localeCompare(right.status);
}

function normalizeProjectionSourceFreshness(
  input: ProjectionSourceFreshnessInput,
  defaultCheckedAt: Date | string,
  name: string,
): ProjectionSourceFreshness {
  const source = normalizeNonEmptyString(input.source, `${name}.source`);
  const checkedAt = normalizeDate(input.checkedAt ?? defaultCheckedAt, `${name}.checkedAt`);
  const status = normalizeFreshnessStatus(input.status, input, `${name}.status`);
  const revision = normalizeOptionalRevision(input.revision, `${name}.revision`);
  const lastSuccessAt = normalizeOptionalDate(input.lastSuccessAt, `${name}.lastSuccessAt`) ?? inferredLastSuccess(status, checkedAt);
  const lastErrorAt = normalizeOptionalDate(input.lastErrorAt, `${name}.lastErrorAt`) ?? inferredLastError(status, checkedAt);
  const staleMs = normalizeOptionalNonNegativeInteger(input.staleMs, `${name}.staleMs`) ?? inferredStaleMs(status, checkedAt, lastSuccessAt);
  return {
    source,
    status,
    checkedAt,
    revision,
    lastSuccessAt,
    lastErrorAt,
    staleMs,
    detail: normalizeOptionalDetail(input.detail),
  };
}

function projectionSourceFreshnessInputs(input: unknown): ProjectionSourceFreshnessInput[] {
  if (input === undefined || input === null) return [];
  if (Array.isArray(input)) return input.map((record) => freshnessInputFromUnknown(record));
  if (typeof input === "object") {
    return Object.entries(input as Record<string, unknown>).map(([source, record]) => {
      if (record && typeof record === "object" && !Array.isArray(record)) {
        return { source, ...(record as Record<string, unknown>) } as ProjectionSourceFreshnessInput;
      }
      return { source, status: String(record ?? "never_synced") } as ProjectionSourceFreshnessInput;
    });
  }
  throw new Error("sourceFreshness must be an array or object map");
}

function freshnessInputFromUnknown(value: unknown): ProjectionSourceFreshnessInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("sourceFreshness entries must be objects");
  return value as ProjectionSourceFreshnessInput;
}

function looksLikeFreshnessCursor(record: Readonly<Record<string, unknown>>): boolean {
  return ["status", "lastSuccessAt", "lastErrorAt", "staleMs", "detail", "checkedAt", "revision"].some((key) => record[key] !== undefined);
}

function normalizeFreshnessStatus(
  value: ProjectionSourceFreshnessInput["status"] | undefined,
  input: ProjectionSourceFreshnessInput,
  name: string,
): ProjectionSourceFreshnessStatus {
  if (value === undefined || value === null || String(value).trim().length === 0) {
    if (input.lastErrorAt || input.detail) return "error";
    if (input.lastSuccessAt || input.revision !== undefined) return "fresh";
    return "never_synced";
  }
  const normalized = String(value).trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "ok" || normalized === "success" || normalized === "synced") return "fresh";
  if (normalized === "failed" || normalized === "failure") return "error";
  if (normalized === "pending") return "loading";
  if ((PROJECTION_SOURCE_FRESHNESS_STATUSES as readonly string[]).includes(normalized)) return normalized as ProjectionSourceFreshnessStatus;
  throw new Error(`${name} must be one of ${PROJECTION_SOURCE_FRESHNESS_STATUSES.join(", ")}`);
}

function inferredLastSuccess(status: ProjectionSourceFreshnessStatus, checkedAt: string): string | null {
  return status === "fresh" || status === "empty" ? checkedAt : null;
}

function inferredLastError(status: ProjectionSourceFreshnessStatus, checkedAt: string): string | null {
  return status === "error" ? checkedAt : null;
}

function inferredStaleMs(status: ProjectionSourceFreshnessStatus, checkedAt: string, lastSuccessAt: string | null): number | null {
  if (status !== "stale" || !lastSuccessAt) return null;
  const elapsed = Date.parse(checkedAt) - Date.parse(lastSuccessAt);
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
}

function deriveSourceFreshnessFromRevision(
  source: string,
  revision: string | number,
  emptySources: ReadonlySet<string>,
): { status: ProjectionSourceFreshnessStatus; detail?: string } {
  const revisionText = String(revision);
  if (isEmptyRevision(revision) && emptySources.has(source)) return { status: "empty" };

  const encodedStatus = sourceRevisionCanEncodeFreshnessStatus(source) ? encodedRevisionFreshnessStatus(revisionText) : null;
  if (!encodedStatus) return { status: "fresh" };
  if (encodedStatus === "fresh" && sourceRevisionRepresentsEmptySuccess(source, revisionText)) return { status: "empty" };
  if (encodedStatus === "error") {
    return {
      status: "error",
      detail: sourceRevisionErrorDetail(source, revisionText),
    };
  }
  return { status: encodedStatus };
}

function encodedRevisionFreshnessStatus(revision: string): ProjectionSourceFreshnessStatus | null {
  const prefix = revision.split(":", 1)[0]?.trim();
  if (!prefix) return null;
  const normalized = prefix.toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "ok" || normalized === "success" || normalized === "synced") return "fresh";
  if (normalized === "failed" || normalized === "failure" || normalized === "unavailable") return "error";
  if (normalized === "pending") return "loading";
  if ((PROJECTION_SOURCE_FRESHNESS_STATUSES as readonly string[]).includes(normalized)) return normalized as ProjectionSourceFreshnessStatus;
  return null;
}

function sourceRevisionCanEncodeFreshnessStatus(source: string): boolean {
  return STATUS_CODED_REVISION_SOURCES.has(source);
}

function sourceRevisionRepresentsEmptySuccess(source: string, revision: string): boolean {
  return source === "trackerIssues" && /^(?:ok|success|synced|fresh):.*:0:none$/i.test(revision);
}

function sourceRevisionErrorDetail(source: string, revision: string): string {
  if (/^unavailable:/i.test(revision)) return `${source} source is unavailable (${revision})`;
  return `${source} source reported an error (${revision})`;
}

function sourceRevisionStatusCanHaveLastSuccess(status: ProjectionSourceFreshnessStatus): boolean {
  return status === "fresh" || status === "empty" || status === "stale";
}

function isEmptyRevision(revision: string | number): boolean {
  return revision === 0 || revision === "0" || String(revision).startsWith("0:");
}

function freshnessDetailForRevision(source: string, status: ProjectionSourceFreshnessStatus, revision: string): string {
  if (status === "empty") return `${source} source is empty`;
  if (status === "never_synced") return `${source} source has not synced yet`;
  if (status === "loading") return `${source} source is loading`;
  if (status === "stale") return `${source} source revision ${revision} is stale`;
  if (status === "error") return `${source} source reported an error (${revision})`;
  return `${source} source revision ${revision} observed`;
}

function normalizeNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${name} must be non-empty`);
  return normalized;
}

function normalizeOptionalRevision(value: unknown, name: string): string | number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`${name} must be a string, number, or null`);
}

function normalizeOptionalDate(value: Date | string | null | undefined, name: string): string | null {
  if (value === undefined || value === null) return null;
  return normalizeDate(value, name);
}

function normalizeDate(value: Date | string, name: string): string {
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  if (!Number.isFinite(time)) throw new Error(`${name} must be a valid date`);
  return date.toISOString();
}

function normalizeOptionalNonNegativeInteger(value: number | null | undefined, name: string): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function normalizeOptionalDetail(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

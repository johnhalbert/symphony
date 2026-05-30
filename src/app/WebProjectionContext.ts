import type { Issue } from "../core/types.js";
import type { IssueLifecycleRecord } from "../core/persistence/IssueLifecycleStore.js";
import type { RunRecord, WorkspaceRecord } from "../core/persistence/RunTranscriptStore.js";

export type WebProjectionClock = () => Date;
export type WebProjectionRefreshParam = string | boolean | number | null | undefined;
export type WebProjectionAliasValue = string | null | undefined;
export type WebProjectionCachePrimitive = string | number | boolean;
export type WebProjectionCacheKeyValue =
  | WebProjectionCachePrimitive
  | readonly WebProjectionCachePrimitive[]
  | null
  | undefined;

export interface WebProjectionIssueKeyAliasInput {
  issueId?: WebProjectionAliasValue;
  issueIdentifier?: WebProjectionAliasValue;
  workspaceKey?: WebProjectionAliasValue;
  runId?: WebProjectionAliasValue;
  sessionId?: WebProjectionAliasValue;
}

export type WebProjectionIssueKeyAliasField = keyof WebProjectionIssueKeyAliasInput;

export const WEB_PROJECTION_ISSUE_KEY_ALIAS_FIELDS: readonly WebProjectionIssueKeyAliasField[] = [
  "issueId",
  "issueIdentifier",
  "workspaceKey",
  "runId",
  "sessionId",
] as const;

export interface WebProjectionCacheKeyParts {
  namespace: string;
  aliases?: readonly WebProjectionAliasValue[];
  dimensions?: Readonly<Record<string, WebProjectionCacheKeyValue>>;
}

export interface WebProjectionSourceRevision {
  source: string;
  revision: string | number;
  observedAt: string | null;
}

export type WebProjectionRevisionListener = (revision: WebProjectionSourceRevision) => void;
export type WebProjectionRevisionUnsubscribe = () => void;

export interface WebProjectionRevisionProvider {
  readonly source: string;
  getRevision(): WebProjectionSourceRevision | Promise<WebProjectionSourceRevision>;
  subscribe?(listener: WebProjectionRevisionListener): WebProjectionRevisionUnsubscribe;
}

export interface WebProjectionCacheFingerprint {
  runtimeGeneratedAt: string | null;
  issueBoardStateKey: string;
  issueBoardColumnKey: string;
  durableSourceRevisions: readonly WebProjectionSourceRevision[];
}

export interface WebProjectionCacheMetadata {
  builtAt: string;
  expiresAt: string | null;
  maxAgeMs: number | null;
  fingerprint: WebProjectionCacheFingerprint;
}

export interface WebProjectionRuntimeSourceIndex<TRuntimeSnapshot = unknown, TRuntimeIssue = unknown> {
  generatedAt: string | null;
  snapshot: TRuntimeSnapshot;
  runningByAlias: ReadonlyMap<string, TRuntimeIssue>;
}

export interface WebProjectionIssueSourceIndex<TIssue = Issue> {
  fetchedStateKey: string;
  issues: readonly TIssue[];
  byAlias: ReadonlyMap<string, TIssue>;
}

export interface WebProjectionRunSourceIndex<TRun = RunRecord> {
  runs: readonly TRun[];
  byAlias: ReadonlyMap<string, readonly TRun[]>;
  latestByAlias: ReadonlyMap<string, TRun>;
  transcriptEventCountsByRunId: ReadonlyMap<string, number | null>;
}

export interface WebProjectionWorkspaceSourceIndex<TWorkspace = WorkspaceRecord> {
  workspaces: readonly TWorkspace[];
  byAlias: ReadonlyMap<string, TWorkspace>;
}

export interface WebProjectionLifecycleSourceIndex<TLifecycle = IssueLifecycleRecord> {
  records: readonly TLifecycle[];
  byAlias: ReadonlyMap<string, TLifecycle>;
}

export interface WebProjectionTranscriptSourceBoundary {
  /**
   * Shared web projections intentionally keep transcript hydration outside the
   * source index. Collection routes can use run-level event counts and fetch
   * full transcript events through transcript-specific endpoints when needed.
   */
  hydration: "excluded";
  eventCountsByRunId: ReadonlyMap<string, number | null>;
}

export interface WebProjectionSourceIndex<
  TIssue = Issue,
  TRun = RunRecord,
  TWorkspace = WorkspaceRecord,
  TLifecycle = IssueLifecycleRecord,
  TRuntimeSnapshot = unknown,
  TRuntimeIssue = unknown,
> {
  generatedAt: string;
  runtime: WebProjectionRuntimeSourceIndex<TRuntimeSnapshot, TRuntimeIssue>;
  trackerIssues: WebProjectionIssueSourceIndex<TIssue>;
  runs: WebProjectionRunSourceIndex<TRun>;
  workspaces: WebProjectionWorkspaceSourceIndex<TWorkspace>;
  lifecycles: WebProjectionLifecycleSourceIndex<TLifecycle>;
  transcript: WebProjectionTranscriptSourceBoundary;
  durableSourceRevisions: readonly WebProjectionSourceRevision[];
}

export interface WebProjectionContext<
  TSourceIndex extends WebProjectionSourceIndex = WebProjectionSourceIndex,
  TProjectionStore extends object = Record<string, never>,
> {
  metadata: WebProjectionCacheMetadata;
  sourceIndex: TSourceIndex;
  projections: TProjectionStore;
}

export interface WebProjectionBuildOptions {
  forceRefresh?: boolean;
  refresh?: WebProjectionRefreshParam;
  clock?: WebProjectionClock;
  maxAgeMs?: number | null;
}

export interface WebProjectionBuildInput<TSourceIndex extends WebProjectionSourceIndex = WebProjectionSourceIndex> {
  metadata: WebProjectionCacheMetadata;
  sourceIndex: TSourceIndex;
}

export type WebProjectionBuildHook<
  TSourceIndex extends WebProjectionSourceIndex = WebProjectionSourceIndex,
<<<<<<< HEAD
  TContext extends WebProjectionContext<TSourceIndex, object> = WebProjectionContext<TSourceIndex>,
=======
  TContext extends WebProjectionContext<TSourceIndex> = WebProjectionContext<TSourceIndex>,
>>>>>>> origin/main
> = (input: WebProjectionBuildInput<TSourceIndex>) => TContext | Promise<TContext>;

export interface WebProjectionAcquireOptions<
  TSourceIndex extends WebProjectionSourceIndex = WebProjectionSourceIndex,
<<<<<<< HEAD
  TContext extends WebProjectionContext<TSourceIndex, object> = WebProjectionContext<TSourceIndex>,
=======
  TContext extends WebProjectionContext<TSourceIndex> = WebProjectionContext<TSourceIndex>,
>>>>>>> origin/main
> extends WebProjectionBuildOptions {
  build?: WebProjectionBuildHook<TSourceIndex, TContext>;
}

<<<<<<< HEAD
export interface WebProjectionCacheAcquireRequest<
  TSourceIndex extends WebProjectionSourceIndex = WebProjectionSourceIndex,
  TContext extends WebProjectionContext<TSourceIndex, object> = WebProjectionContext<TSourceIndex>,
> extends WebProjectionAcquireOptions<TSourceIndex, TContext> {
  cacheKey: string;
  sourceIndex: TSourceIndex;
  fingerprint?: WebProjectionCacheFingerprint;
}

export interface WebProjectionCacheEntry<TContext> {
  cacheKey: string;
  storedAt: string;
  context: TContext;
}

interface WebProjectionInFlightEntry<TContext> {
  fingerprintKey: string;
  promise: Promise<TContext>;
}

export class WebProjectionContextCache<
  TSourceIndex extends WebProjectionSourceIndex = WebProjectionSourceIndex,
  TContext extends WebProjectionContext<TSourceIndex, object> = WebProjectionContext<TSourceIndex>,
> {
  private readonly entries = new Map<string, WebProjectionCacheEntry<TContext>>();
  private readonly inFlight = new Map<string, WebProjectionInFlightEntry<TContext>>();

  get(cacheKey: string, now: Date = new Date()): TContext | null {
    const entry = this.entries.get(cacheKey);
    if (!entry || isWebProjectionContextExpired(entry.context, now)) return null;
    return entry.context;
  }

  delete(cacheKey: string): boolean {
    this.inFlight.delete(cacheKey);
    return this.entries.delete(cacheKey);
  }

  clear(): void {
    this.inFlight.clear();
    this.entries.clear();
  }

  async acquire(request: WebProjectionCacheAcquireRequest<TSourceIndex, TContext>): Promise<TContext> {
    const clock = request.clock ?? (() => new Date());
    const now = clock();
    const forceRefresh = shouldForceWebProjectionRefresh(request);
    const fingerprint = request.fingerprint ?? createWebProjectionFingerprintFromSourceIndex(request.sourceIndex);
    const fingerprintKey = webProjectionFingerprintCacheKey(fingerprint);
    const cached = this.entries.get(request.cacheKey);
    if (
      cached &&
      !forceRefresh &&
      !isWebProjectionContextExpired(cached.context, now) &&
      webProjectionFingerprintCacheKey(cached.context.metadata.fingerprint) === fingerprintKey
    ) {
      return cached.context;
    }

    const active = this.inFlight.get(request.cacheKey);
    if (active && !forceRefresh && active.fingerprintKey === fingerprintKey) return active.promise;

    const promise = this.buildContext(request, fingerprint, clock);
    this.inFlight.set(request.cacheKey, { fingerprintKey, promise });
    try {
      const context = await promise;
      if (this.inFlight.get(request.cacheKey)?.promise === promise) {
        this.entries.set(request.cacheKey, { cacheKey: request.cacheKey, storedAt: context.metadata.builtAt, context });
      }
      return context;
    } finally {
      if (this.inFlight.get(request.cacheKey)?.promise === promise) this.inFlight.delete(request.cacheKey);
    }
  }

  private async buildContext(
    request: WebProjectionCacheAcquireRequest<TSourceIndex, TContext>,
    fingerprint: WebProjectionCacheFingerprint,
    clock: WebProjectionClock,
  ): Promise<TContext> {
    const metadata = createWebProjectionCacheMetadata({
      clock,
      ...(request.maxAgeMs !== undefined ? { maxAgeMs: request.maxAgeMs } : {}),
      fingerprint,
    });
    const build = request.build ?? defaultWebProjectionBuildHook<TSourceIndex, TContext>;
    return build({ metadata, sourceIndex: request.sourceIndex });
  }
}

=======
>>>>>>> origin/main
export function normalizeWebProjectionAlias(value: WebProjectionAliasValue): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

export function webProjectionIssueKeyAliases(...inputs: readonly WebProjectionIssueKeyAliasInput[]): string[] {
  const aliases: string[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    for (const field of WEB_PROJECTION_ISSUE_KEY_ALIAS_FIELDS) {
      const normalized = normalizeWebProjectionAlias(input[field]);
      if (normalized !== null && !seen.has(normalized)) {
        seen.add(normalized);
        aliases.push(normalized);
      }
    }
  }
  return aliases;
}

export function webProjectionAliasesFromValues(values: readonly WebProjectionAliasValue[]): string[] {
  const aliases: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeWebProjectionAlias(value);
    if (normalized !== null && !seen.has(normalized)) {
      seen.add(normalized);
      aliases.push(normalized);
    }
  }
  return aliases;
}

export function isWebProjectionRefreshRequested(refresh: WebProjectionRefreshParam): boolean {
  if (refresh === true || refresh === 1) return true;
  if (typeof refresh !== "string") return false;
  const normalized = refresh.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

export function shouldForceWebProjectionRefresh(options: WebProjectionBuildOptions = {}): boolean {
  return options.forceRefresh === true || isWebProjectionRefreshRequested(options.refresh);
}

export function createWebProjectionCacheKey(parts: WebProjectionCacheKeyParts): string {
  const namespace = normalizeWebProjectionAlias(parts.namespace);
  if (namespace === null) {
    throw new Error("Web projection cache key namespace must be non-empty");
  }
  const aliases = parts.aliases ? webProjectionAliasesFromValues(parts.aliases) : [];
  const dimensions = parts.dimensions ? stableCacheDimensions(parts.dimensions) : [];
  const encodedSegments = [
    encodeCacheKeySegment(namespace),
    `aliases=${aliases.map(encodeCacheKeySegment).join(",")}`,
    ...dimensions.map(([key, value]) => `${encodeCacheKeySegment(key)}=${value.map(encodeCacheKeySegment).join(",")}`),
  ];
  return encodedSegments.join("|");
}

export function createWebProjectionCacheMetadata(input: {
  builtAt?: Date | string;
  clock?: WebProjectionClock;
  maxAgeMs?: number | null;
  fingerprint: WebProjectionCacheFingerprint;
}): WebProjectionCacheMetadata {
  const builtAt = dateLikeToIso(input.builtAt ?? input.clock?.() ?? new Date());
  const maxAgeMs = input.maxAgeMs ?? null;
  return {
    builtAt,
    expiresAt: typeof maxAgeMs === "number" && Number.isFinite(maxAgeMs) ? new Date(Date.parse(builtAt) + maxAgeMs).toISOString() : null,
    maxAgeMs,
    fingerprint: input.fingerprint,
  };
}

export function createWebProjectionFingerprint(input: {
  runtimeGeneratedAt?: string | null;
  issueBoardStates?: readonly WebProjectionAliasValue[];
  issueBoardColumns?: readonly WebProjectionAliasValue[];
  durableSourceRevisions?: readonly WebProjectionSourceRevision[];
} = {}): WebProjectionCacheFingerprint {
  return {
    runtimeGeneratedAt: input.runtimeGeneratedAt ?? null,
    issueBoardStateKey: webProjectionAliasesFromValues(input.issueBoardStates ?? []).join(","),
    issueBoardColumnKey: webProjectionAliasesFromValues(input.issueBoardColumns ?? []).join(","),
    durableSourceRevisions: [...(input.durableSourceRevisions ?? [])].sort(compareSourceRevisions),
  };
}

<<<<<<< HEAD
export function createWebProjectionFingerprintFromSourceIndex(
  sourceIndex: Pick<WebProjectionSourceIndex, "runtime" | "trackerIssues" | "durableSourceRevisions">,
): WebProjectionCacheFingerprint {
  return createWebProjectionFingerprint({
    runtimeGeneratedAt: sourceIndex.runtime.generatedAt,
    issueBoardStates: [sourceIndex.trackerIssues.fetchedStateKey],
    durableSourceRevisions: sourceIndex.durableSourceRevisions,
  });
}

export function isWebProjectionContextExpired(
  context: Pick<WebProjectionContext<WebProjectionSourceIndex, object>, "metadata">,
  now: Date = new Date(),
): boolean {
  const expiresAt = context.metadata.expiresAt;
  return expiresAt !== null && Date.parse(expiresAt) <= now.getTime();
}

export function webProjectionFingerprintCacheKey(fingerprint: WebProjectionCacheFingerprint): string {
  return JSON.stringify({
    runtimeGeneratedAt: fingerprint.runtimeGeneratedAt ?? null,
    issueBoardStateKey: fingerprint.issueBoardStateKey,
    issueBoardColumnKey: fingerprint.issueBoardColumnKey,
    durableSourceRevisions: [...fingerprint.durableSourceRevisions].sort(compareSourceRevisions),
  });
}

function defaultWebProjectionBuildHook<
  TSourceIndex extends WebProjectionSourceIndex,
  TContext extends WebProjectionContext<TSourceIndex, object>,
>(input: WebProjectionBuildInput<TSourceIndex>): TContext {
  return { metadata: input.metadata, sourceIndex: input.sourceIndex, projections: {} } as TContext;
}

=======
>>>>>>> origin/main
function stableCacheDimensions(dimensions: Readonly<Record<string, WebProjectionCacheKeyValue>>): Array<[string, string[]]> {
  const entries: Array<[string, string[]]> = [];
  for (const key of Object.keys(dimensions).sort()) {
    const normalizedKey = normalizeWebProjectionAlias(key);
    if (normalizedKey === null) continue;
    const value = dimensions[key];
    const values = Array.isArray(value) ? value : [value];
    const normalizedValues = webProjectionAliasesFromValues(values.map((item) => primitiveToCacheValue(item)));
    if (normalizedValues.length > 0) entries.push([normalizedKey, normalizedValues]);
  }
  return entries;
}

function primitiveToCacheValue(value: WebProjectionCachePrimitive | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

function encodeCacheKeySegment(value: string): string {
  return encodeURIComponent(value);
}

function dateLikeToIso(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function compareSourceRevisions(left: WebProjectionSourceRevision, right: WebProjectionSourceRevision): number {
  const bySource = left.source.localeCompare(right.source);
  if (bySource !== 0) return bySource;
  return String(left.revision).localeCompare(String(right.revision));
}

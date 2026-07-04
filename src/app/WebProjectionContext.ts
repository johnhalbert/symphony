import type { RuntimeSnapshot } from "../core/orchestrator/Orchestrator.js";
import { LEGACY_DEFAULT_PROJECT_CONTEXT_ID, normalizeProjectContextId, projectContextResolutionFromIssue } from "../core/config/ProjectContexts.js";
import type { Issue, IssueBoardColumnId, IssueBoardColumnMapping, TrackerStateLists } from "../core/types.js";
import { errorMessage, SymphonyError } from "../core/errors.js";
import type { IssueLifecycleRecord, IssueLifecycleStore } from "../core/persistence/IssueLifecycleStore.js";
import { compareRunChronology, type RunRecord, type RunTranscriptStore, type WorkspaceRecord } from "../core/persistence/RunTranscriptStore.js";
import type { TrackerClient } from "../core/tracker/TrackerClient.js";
import { writebackIdentityKey, type FileWritebackOutboxStore, type WritebackOperation } from "../core/writeback/WritebackOutbox.js";

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

interface WebProjectionIssueKeyAliasDescriptor {
  alias: string;
  contextual: boolean;
}

interface WebProjectionContextAwareAliasBundle {
  projectContextId: string;
  rawAliases: readonly WebProjectionIssueKeyAliasDescriptor[];
  contextualAliases: readonly string[];
}

export const WEB_PROJECTION_ISSUE_KEY_ALIAS_FIELDS: readonly WebProjectionIssueKeyAliasField[] = [
  "issueId",
  "issueIdentifier",
  "workspaceKey",
  "runId",
  "sessionId",
] as const;

const WEB_PROJECTION_CONTEXTUAL_ALIAS_FIELDS: readonly WebProjectionIssueKeyAliasField[] = [
  "issueId",
  "issueIdentifier",
  "workspaceKey",
  "runId",
] as const;

const WEB_PROJECTION_CONTEXTUAL_ALIAS_FIELD_SET = new Set<WebProjectionIssueKeyAliasField>(WEB_PROJECTION_CONTEXTUAL_ALIAS_FIELDS);

export interface WebProjectionCacheKeyParts {
  namespace: string;
  aliases?: readonly WebProjectionAliasValue[];
  dimensions?: Readonly<Record<string, WebProjectionCacheKeyValue>>;
}

export interface WebProjectionSourceRevision {
  source: string;
  revision: string | number;
  observedAt: string | null;
  detail?: Readonly<Record<string, unknown>> | null;
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
  durableProjectionRevisions: readonly WebProjectionSourceRevision[];
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
  liveByIssueKey: ReadonlyMap<string, TRuntimeIssue>;
  runningByAlias: ReadonlyMap<string, TRuntimeIssue>;
}

export type WebProjectionTrackerStatus = "ok" | "unavailable" | "error";

export interface WebProjectionTrackerFailure {
  code: "tracker_unavailable" | "tracker_error";
  message: string;
}

export interface WebProjectionIssueSourceIndex<TIssue = Issue> {
  status: WebProjectionTrackerStatus;
  fetchedStates: readonly string[];
  fetchedStateKey: string;
  fetchedAt: string | null;
  cached: boolean;
  error: WebProjectionTrackerFailure | null;
  issues: readonly TIssue[];
  byAlias: ReadonlyMap<string, TIssue>;
}

export interface WebProjectionRunSourceIndex<TRun = RunRecord> {
  runs: readonly TRun[];
  runById: ReadonlyMap<string, TRun>;
  runBySessionId: ReadonlyMap<string, TRun>;
  runsByIssueKey: ReadonlyMap<string, readonly TRun[]>;
  latestRunByIssueKey: ReadonlyMap<string, TRun>;
  byAlias: ReadonlyMap<string, readonly TRun[]>;
  latestByAlias: ReadonlyMap<string, TRun>;
  transcriptEventCountsByRunId: ReadonlyMap<string, number | null>;
}

export interface WebProjectionWorkspaceSourceIndex<TWorkspace = WorkspaceRecord> {
  workspaces: readonly TWorkspace[];
  workspaceByIssueKey: ReadonlyMap<string, TWorkspace>;
  byAlias: ReadonlyMap<string, TWorkspace>;
}

export interface WebProjectionLifecycleSourceIndex<TLifecycle = IssueLifecycleRecord> {
  records: readonly TLifecycle[];
  lifecycleByIssueKey: ReadonlyMap<string, TLifecycle>;
  byAlias: ReadonlyMap<string, TLifecycle>;
}

export interface WebProjectionWritebackSourceIndex<TOperation = WritebackOperation> {
  operations: readonly TOperation[];
  writebacksByIssueKey: ReadonlyMap<string, readonly TOperation[]>;
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
  TWriteback = WritebackOperation,
> {
  generatedAt: string;
  runtime: WebProjectionRuntimeSourceIndex<TRuntimeSnapshot, TRuntimeIssue>;
  trackerIssues: WebProjectionIssueSourceIndex<TIssue>;
  runs: WebProjectionRunSourceIndex<TRun>;
  workspaces: WebProjectionWorkspaceSourceIndex<TWorkspace>;
  lifecycles: WebProjectionLifecycleSourceIndex<TLifecycle>;
  writebacks: WebProjectionWritebackSourceIndex<TWriteback>;
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

export interface WebProjectionIssueTrackerProjection<TIssue = Issue> {
  fetchedStates: readonly string[];
  trackerIssues: readonly TIssue[];
  fetchedAt: string;
  cached: boolean;
}

export interface WebProjectionTrackerProjectionFetchInput {
  columns: IssueBoardColumnMapping;
  fetchedStates: readonly string[];
  forceRefresh: boolean;
}

export type WebProjectionTrackerProjectionFetcher<TIssue = Issue> = (
  input: WebProjectionTrackerProjectionFetchInput,
) => WebProjectionIssueTrackerProjection<TIssue> | Promise<WebProjectionIssueTrackerProjection<TIssue>>;

export interface WebProjectionSourceIndexBuildOptions {
  snapshot?: RuntimeSnapshot;
  orchestrator?: { snapshot(): RuntimeSnapshot };
  defaultProjectContextId?: string | null | undefined;
  tracker?: Pick<TrackerClient, "fetchIssuesByStates"> | null;
  trackerProjection?: WebProjectionIssueTrackerProjection | null;
  fetchTrackerProjection?: WebProjectionTrackerProjectionFetcher;
  issueBoardColumns?: IssueBoardColumnMapping;
  trackerStateLists?: TrackerStateLists;
  fetchedStates?: readonly string[];
  forceRefresh?: boolean;
  runStore?: (Pick<RunTranscriptStore, "listRuns"> & Partial<Pick<RunTranscriptStore, "listWorkspaces">>) | null;
  lifecycleStore?: Pick<IssueLifecycleStore, "list"> | null;
  writebackOutbox?: Pick<FileWritebackOutboxStore, "list"> | null;
  clock?: WebProjectionClock;
  durableSourceRevisions?: readonly WebProjectionSourceRevision[];
}

export type BuiltWebProjectionSourceIndex = WebProjectionSourceIndex<
  Issue,
  RunRecord,
  WorkspaceRecord,
  IssueLifecycleRecord,
  RuntimeSnapshot,
  RuntimeSnapshot["running"][number],
  WritebackOperation
>;

const WEB_PROJECTION_ISSUE_BOARD_COLUMN_IDS: readonly IssueBoardColumnId[] = [
  "backlog",
  "todo",
  "progress",
  "review",
  "done",
  "canceled",
] as const;

export async function buildWebProjectionSourceIndex(
  options: WebProjectionSourceIndexBuildOptions = {},
): Promise<BuiltWebProjectionSourceIndex> {
  const clock = options.clock ?? (() => new Date());
  const snapshot = options.snapshot ?? options.orchestrator?.snapshot() ?? emptyRuntimeSnapshot(clock());
  const issueBoardColumns =
    options.issueBoardColumns ??
    (options.trackerStateLists
      ? defaultWebProjectionIssueBoardColumns(options.trackerStateLists)
      : emptyWebProjectionIssueBoardColumns());
  const fetchedStates = options.fetchedStates
    ? uniqueStateNames(options.fetchedStates)
    : webProjectionIssueBoardFetchStates(issueBoardColumns);

  const [trackerIssues, runs, workspaces, lifecycles, writebackOperations] = await Promise.all([
    buildTrackerIssueSourceIndex({
      defaultProjectContextId: options.defaultProjectContextId,
      tracker: options.tracker ?? null,
      trackerProjection: options.trackerProjection ?? null,
      ...(options.fetchTrackerProjection ? { fetchTrackerProjection: options.fetchTrackerProjection } : {}),
      issueBoardColumns,
      fetchedStates,
      forceRefresh: options.forceRefresh ?? false,
      clock,
    }),
    options.runStore ? options.runStore.listRuns() : Promise.resolve([]),
    options.runStore?.listWorkspaces ? options.runStore.listWorkspaces() : Promise.resolve([]),
    options.lifecycleStore ? options.lifecycleStore.list() : Promise.resolve([]),
    options.writebackOutbox ? options.writebackOutbox.list() : Promise.resolve([]),
  ]);

  const runtime = buildRuntimeSourceIndex(snapshot, options.defaultProjectContextId);
  const runIndex = buildRunSourceIndex(runs, options.defaultProjectContextId);
  const workspaceIndex = buildWorkspaceSourceIndex(workspaces, options.defaultProjectContextId);
  const lifecycleIndex = buildLifecycleSourceIndex(lifecycles, options.defaultProjectContextId);
  const writebackIndex = buildWritebackSourceIndex(writebackOperations, runIndex, lifecycleIndex);
  const transcriptCounts = runIndex.transcriptEventCountsByRunId;

  return {
    generatedAt: snapshot.generatedAt,
    runtime,
    trackerIssues,
    runs: runIndex,
    workspaces: workspaceIndex,
    lifecycles: lifecycleIndex,
    writebacks: writebackIndex,
    transcript: {
      hydration: "excluded",
      eventCountsByRunId: transcriptCounts,
    },
    durableSourceRevisions: buildSourceRevisions({
      trackerIssues,
      runs,
      workspaces,
      lifecycles,
      writebackOperations,
      extra: options.durableSourceRevisions ?? [],
    }),
  };
}

export function defaultWebProjectionIssueBoardColumns(stateLists: TrackerStateLists): IssueBoardColumnMapping {
  return {
    backlog: ["Backlog"],
    todo: stateLists.activeStates.filter((state) => isStateNameIn(state, ["Todo"])),
    progress: uniqueStateNames(
      [...stateLists.activeStates, ...stateLists.blockedStates].filter(
        (state) => !isStateNameIn(state, ["Todo", "Backlog"]),
      ),
    ),
    review: uniqueStateNames([...stateLists.handoffStates, ...stateLists.reviewStates]),
    done: stateLists.terminalStates.filter((state) => isStateNameIn(state, ["Done", "Closed"])),
    canceled: stateLists.terminalStates.filter((state) => isStateNameIn(state, ["Cancelled", "Canceled", "Duplicate"])),
  };
}

export function webProjectionIssueBoardFetchStates(columns: IssueBoardColumnMapping): string[] {
  return uniqueStateNames(WEB_PROJECTION_ISSUE_BOARD_COLUMN_IDS.flatMap((column) => columns[column]));
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
  TContext extends WebProjectionContext<TSourceIndex, object> = WebProjectionContext<TSourceIndex>,
> = (input: WebProjectionBuildInput<TSourceIndex>) => TContext | Promise<TContext>;

export interface WebProjectionAcquireOptions<
  TSourceIndex extends WebProjectionSourceIndex = WebProjectionSourceIndex,
  TContext extends WebProjectionContext<TSourceIndex, object> = WebProjectionContext<TSourceIndex>,
> extends WebProjectionBuildOptions {
  build?: WebProjectionBuildHook<TSourceIndex, TContext>;
}

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
  cacheKey: string;
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
    for (const [inFlightKey, entry] of this.inFlight.entries()) {
      if (entry.cacheKey === cacheKey) this.inFlight.delete(inFlightKey);
    }
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

    const inFlightKey = webProjectionInFlightCacheKey(request.cacheKey, forceRefresh, fingerprintKey);
    const active = this.inFlight.get(inFlightKey);
    if (active) return active.promise;

    const promise = this.buildContext(request, fingerprint, clock);
    this.inFlight.set(inFlightKey, { cacheKey: request.cacheKey, fingerprintKey, promise });
    try {
      const context = await promise;
      if (this.inFlight.get(inFlightKey)?.promise === promise) {
        this.entries.set(request.cacheKey, { cacheKey: request.cacheKey, storedAt: context.metadata.builtAt, context });
      }
      return context;
    } finally {
      if (this.inFlight.get(inFlightKey)?.promise === promise) this.inFlight.delete(inFlightKey);
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

function webProjectionInFlightCacheKey(cacheKey: string, forceRefresh: boolean, fingerprintKey: string): string {
  return `${cacheKey}\0${forceRefresh ? "refresh" : "default"}\0${fingerprintKey}`;
}

export function normalizeWebProjectionAlias(value: WebProjectionAliasValue): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

export function webProjectionIssueKeyAliases(...inputs: readonly WebProjectionIssueKeyAliasInput[]): string[] {
  return webProjectionIssueKeyAliasDescriptors(...inputs).map((descriptor) => descriptor.alias);
}

function webProjectionIssueKeyAliasDescriptors(...inputs: readonly WebProjectionIssueKeyAliasInput[]): WebProjectionIssueKeyAliasDescriptor[] {
  const aliases: string[] = [];
  const aliasDescriptors = new Map<string, WebProjectionIssueKeyAliasDescriptor>();
  for (const input of inputs) {
    for (const field of WEB_PROJECTION_ISSUE_KEY_ALIAS_FIELDS) {
      const normalized = normalizeWebProjectionAlias(input[field]);
      if (normalized !== null && !aliasDescriptors.has(normalized)) {
        aliasDescriptors.set(normalized, {
          alias: normalized,
          contextual: WEB_PROJECTION_CONTEXTUAL_ALIAS_FIELD_SET.has(field),
        });
        aliases.push(normalized);
        continue;
      }
      if (normalized !== null && WEB_PROJECTION_CONTEXTUAL_ALIAS_FIELD_SET.has(field)) {
        aliasDescriptors.set(normalized, { alias: normalized, contextual: true });
      }
    }
  }
  return aliases.map((alias) => aliasDescriptors.get(alias) ?? { alias, contextual: false });
}

function webProjectionContextAwareIssueKeyAliases(
  projectContextSource: unknown,
  ...inputs: readonly WebProjectionIssueKeyAliasInput[]
): string[] {
  const bundle = webProjectionContextAwareIssueKeyAliasBundle(projectContextSource, ...inputs);
  return [...bundle.rawAliases.map((descriptor) => descriptor.alias), ...bundle.contextualAliases];
}

function webProjectionContextAwareIssueKeyAliasBundle(
  projectContextSource: unknown,
  ...inputs: readonly WebProjectionIssueKeyAliasInput[]
): WebProjectionContextAwareAliasBundle {
  const rawAliases = webProjectionIssueKeyAliasDescriptors(...inputs);
  const projectContextId = projectContextResolutionFromIssue(projectContextSource)?.projectContextId ?? LEGACY_DEFAULT_PROJECT_CONTEXT_ID;
  if (projectContextId === LEGACY_DEFAULT_PROJECT_CONTEXT_ID) {
    return { projectContextId, rawAliases, contextualAliases: [] };
  }

  const contextualAliases: string[] = [];
  const seen = new Set(rawAliases.map((descriptor) => descriptor.alias));
  for (const input of inputs) {
    for (const field of WEB_PROJECTION_CONTEXTUAL_ALIAS_FIELDS) {
      const normalized = normalizeWebProjectionAlias(input[field]);
      if (normalized === null) continue;
      const contextualAlias = `${projectContextId}:${normalized}`;
      if (seen.has(contextualAlias)) continue;
      seen.add(contextualAlias);
      contextualAliases.push(contextualAlias);
    }
  }
  return { projectContextId, rawAliases, contextualAliases };
}

function normalizeWebProjectionDefaultProjectContextId(defaultProjectContextId: string | null | undefined): string {
  if (typeof defaultProjectContextId !== "string") return LEGACY_DEFAULT_PROJECT_CONTEXT_ID;
  const trimmed = defaultProjectContextId.trim();
  if (trimmed.length === 0) return LEGACY_DEFAULT_PROJECT_CONTEXT_ID;
  try {
    return normalizeProjectContextId(trimmed);
  } catch {
    return LEGACY_DEFAULT_PROJECT_CONTEXT_ID;
  }
}

function webProjectionDefaultContextCompatibilityIds(defaultProjectContextId: string | null | undefined): ReadonlySet<string> {
  const resolvedDefaultProjectContextId = normalizeWebProjectionDefaultProjectContextId(defaultProjectContextId);
  return resolvedDefaultProjectContextId === LEGACY_DEFAULT_PROJECT_CONTEXT_ID
    ? new Set([LEGACY_DEFAULT_PROJECT_CONTEXT_ID])
    : new Set([LEGACY_DEFAULT_PROJECT_CONTEXT_ID, resolvedDefaultProjectContextId]);
}

function webProjectionContextGroupId(projectContextId: string, defaultProjectContextId: string | null | undefined): string {
  const resolvedDefaultProjectContextId = normalizeWebProjectionDefaultProjectContextId(defaultProjectContextId);
  return webProjectionDefaultContextCompatibilityIds(resolvedDefaultProjectContextId).has(projectContextId)
    ? resolvedDefaultProjectContextId
    : projectContextId;
}

function rawAliasProjectContextWinners(
  bundles: readonly WebProjectionContextAwareAliasBundle[],
  defaultProjectContextId: string | null | undefined,
): ReadonlyMap<string, string | null> {
  const resolvedDefaultProjectContextId = normalizeWebProjectionDefaultProjectContextId(defaultProjectContextId);
  const groupsByAlias = new Map<string, Set<string>>();
  for (const bundle of bundles) {
    for (const descriptor of bundle.rawAliases) {
      if (!descriptor.contextual) continue;
      const existing = groupsByAlias.get(descriptor.alias) ?? new Set<string>();
      existing.add(webProjectionContextGroupId(bundle.projectContextId, resolvedDefaultProjectContextId));
      groupsByAlias.set(descriptor.alias, existing);
    }
  }

  const winners = new Map<string, string | null>();
  for (const [alias, groups] of groupsByAlias) {
    if (groups.size === 1) {
      winners.set(alias, groups.values().next().value ?? null);
      continue;
    }
    winners.set(alias, groups.has(resolvedDefaultProjectContextId) ? resolvedDefaultProjectContextId : null);
  }
  return winners;
}

function preferredIndexAliases(
  bundle: WebProjectionContextAwareAliasBundle,
  rawWinners: ReadonlyMap<string, string | null>,
  defaultProjectContextId: string | null | undefined,
): string[] {
  const bundleGroupId = webProjectionContextGroupId(bundle.projectContextId, defaultProjectContextId);
  const rawAliases = bundle.rawAliases
    .filter((descriptor) => !descriptor.contextual || rawWinners.get(descriptor.alias) === bundleGroupId)
    .map((descriptor) => descriptor.alias);
  return [...rawAliases, ...bundle.contextualAliases];
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
  durableProjectionRevisions?: readonly WebProjectionSourceRevision[];
} = {}): WebProjectionCacheFingerprint {
  return {
    runtimeGeneratedAt: input.runtimeGeneratedAt ?? null,
    issueBoardStateKey: webProjectionAliasesFromValues(input.issueBoardStates ?? []).join(","),
    issueBoardColumnKey: webProjectionAliasesFromValues(input.issueBoardColumns ?? []).join(","),
    durableSourceRevisions: [...(input.durableSourceRevisions ?? [])].sort(compareSourceRevisions),
    durableProjectionRevisions: [...(input.durableProjectionRevisions ?? [])].sort(compareSourceRevisions),
  };
}

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
    durableProjectionRevisions: [...fingerprint.durableProjectionRevisions].sort(compareSourceRevisions),
  });
}

async function buildTrackerIssueSourceIndex(input: {
  defaultProjectContextId: string | null | undefined;
  tracker: Pick<TrackerClient, "fetchIssuesByStates"> | null;
  trackerProjection: WebProjectionIssueTrackerProjection | null;
  fetchTrackerProjection?: WebProjectionTrackerProjectionFetcher;
  issueBoardColumns: IssueBoardColumnMapping;
  fetchedStates: readonly string[];
  forceRefresh: boolean;
  clock: WebProjectionClock;
}): Promise<WebProjectionIssueSourceIndex<Issue>> {
  if (input.trackerProjection) return trackerIssueSourceIndexFromProjection(input.trackerProjection, "ok", null, input.defaultProjectContextId);

  if (input.fetchTrackerProjection) {
    try {
      const projection = await input.fetchTrackerProjection({
        columns: input.issueBoardColumns,
        fetchedStates: input.fetchedStates,
        forceRefresh: input.forceRefresh,
      });
      return trackerIssueSourceIndexFromProjection(projection, "ok", null, input.defaultProjectContextId);
    } catch (error) {
      return trackerIssueSourceIndexFromFailure(input.fetchedStates, trackerIssueSourceFailureFromError(error));
    }
  }

  if (!input.tracker) {
    return trackerIssueSourceIndexFromFailure(input.fetchedStates, {
      code: "tracker_unavailable",
      message: "Issue board requires a configured tracker client",
    });
  }

  try {
    const trackerIssues = await input.tracker.fetchIssuesByStates([...input.fetchedStates]);
    return trackerIssueSourceIndexFromProjection(
      {
        fetchedStates: input.fetchedStates,
        trackerIssues,
        fetchedAt: input.clock().toISOString(),
        cached: false,
      },
      "ok",
      null,
      input.defaultProjectContextId,
    );
  } catch (error) {
    return trackerIssueSourceIndexFromFailure(input.fetchedStates, trackerIssueSourceFailureFromError(error));
  }
}

function trackerIssueSourceFailureFromError(error: unknown): WebProjectionTrackerFailure {
  if (error instanceof SymphonyError && error.code === "tracker_unavailable") {
    return { code: "tracker_unavailable", message: error.message };
  }
  if (error instanceof SymphonyError && error.code === "tracker_error") {
    return { code: "tracker_error", message: error.message };
  }
  return {
    code: "tracker_error",
    message: `Issue board tracker fetch failed: ${errorMessage(error)}`,
  };
}

function trackerIssueSourceIndexFromProjection(
  projection: WebProjectionIssueTrackerProjection,
  status: WebProjectionTrackerStatus,
  error: WebProjectionTrackerFailure | null,
  defaultProjectContextId: string | null | undefined,
): WebProjectionIssueSourceIndex<Issue> {
  const fetchedStates = uniqueStateNames(projection.fetchedStates);
  return {
    status,
    fetchedStates,
    fetchedStateKey: fetchedStateKey(fetchedStates),
    fetchedAt: projection.fetchedAt,
    cached: projection.cached,
    error,
    issues: [...projection.trackerIssues],
    byAlias: buildIssueAliasMap(projection.trackerIssues, defaultProjectContextId),
  };
}

function trackerIssueSourceIndexFromFailure(
  fetchedStates: readonly string[],
  error: WebProjectionTrackerFailure,
): WebProjectionIssueSourceIndex<Issue> {
  const normalizedStates = uniqueStateNames(fetchedStates);
  return {
    status: error.code === "tracker_unavailable" ? "unavailable" : "error",
    fetchedStates: normalizedStates,
    fetchedStateKey: fetchedStateKey(normalizedStates),
    fetchedAt: null,
    cached: false,
    error,
    issues: [],
    byAlias: new Map<string, Issue>(),
  };
}

function buildIssueAliasMap(
  issues: readonly Issue[],
  defaultProjectContextId: string | null | undefined,
): ReadonlyMap<string, Issue> {
  const issueBundles = issues.map((issue) => ({
    issue,
    aliasBundle: webProjectionContextAwareIssueKeyAliasBundle(issue, { issueId: issue.id, issueIdentifier: issue.identifier }),
  }));
  const rawWinners = rawAliasProjectContextWinners(issueBundles.map(({ aliasBundle }) => aliasBundle), defaultProjectContextId);
  const byAlias = new Map<string, Issue>();
  for (const { issue, aliasBundle } of issueBundles) {
    for (const alias of preferredIndexAliases(aliasBundle, rawWinners, defaultProjectContextId)) {
      if (!byAlias.has(alias)) byAlias.set(alias, issue);
    }
  }
  return byAlias;
}

function buildRuntimeSourceIndex(
  snapshot: RuntimeSnapshot,
  defaultProjectContextId: string | null | undefined,
): WebProjectionRuntimeSourceIndex<RuntimeSnapshot, RuntimeSnapshot["running"][number]> {
  const runningBundles = snapshot.running.map((row) => ({
    row,
    aliasBundle: webProjectionContextAwareIssueKeyAliasBundle(row, {
      issueId: row.issueId,
      issueIdentifier: row.issueIdentifier,
      runId: row.runId,
      sessionId: row.sessionId,
    }),
  }));
  const rawWinners = rawAliasProjectContextWinners(runningBundles.map(({ aliasBundle }) => aliasBundle), defaultProjectContextId);
  const liveByIssueKey = new Map<string, RuntimeSnapshot["running"][number]>();
  for (const { row, aliasBundle } of runningBundles) {
    for (const alias of preferredIndexAliases(aliasBundle, rawWinners, defaultProjectContextId)) {
      if (!liveByIssueKey.has(alias)) liveByIssueKey.set(alias, row);
    }
  }
  return {
    generatedAt: snapshot.generatedAt,
    snapshot,
    liveByIssueKey,
    runningByAlias: liveByIssueKey,
  };
}

function buildRunSourceIndex(
  runs: readonly RunRecord[],
  defaultProjectContextId: string | null | undefined,
): WebProjectionRunSourceIndex<RunRecord> {
  const sortedRuns = [...runs].sort(compareRunChronology);
  const runBundles = sortedRuns.map((run) => ({
    run,
    aliasBundle: webProjectionContextAwareIssueKeyAliasBundle(run, {
      issueId: run.issueId,
      issueIdentifier: run.issueIdentifier,
      workspaceKey: run.workspaceKey,
      runId: run.runId,
      sessionId: run.sessionId,
    }),
  }));
  const rawWinners = rawAliasProjectContextWinners(runBundles.map(({ aliasBundle }) => aliasBundle), defaultProjectContextId);
  const runById = new Map<string, RunRecord>();
  const runBySessionId = new Map<string, RunRecord>();
  const runsByIssueKey = new Map<string, RunRecord[]>();
  const latestRunByIssueKey = new Map<string, RunRecord>();
  const transcriptEventCountsByRunId = new Map<string, number | null>();

  for (const { run, aliasBundle } of runBundles) {
    runById.set(run.runId, run);
    const sessionAlias = normalizeWebProjectionAlias(run.sessionId);
    if (sessionAlias !== null) runBySessionId.set(sessionAlias, run);
    transcriptEventCountsByRunId.set(run.runId, typeof run.transcriptEventCount === "number" ? run.transcriptEventCount : null);
    for (const alias of preferredIndexAliases(aliasBundle, rawWinners, defaultProjectContextId)) {
      const existing = runsByIssueKey.get(alias) ?? [];
      if (!existing.some((candidate) => candidate.runId === run.runId)) existing.push(run);
      runsByIssueKey.set(alias, existing);
    }
  }

  for (const [alias, aliasRuns] of runsByIssueKey) {
    const latest = aliasRuns.at(-1);
    if (latest) latestRunByIssueKey.set(alias, latest);
  }

  return {
    runs: sortedRuns,
    runById,
    runBySessionId,
    runsByIssueKey,
    latestRunByIssueKey,
    byAlias: runsByIssueKey,
    latestByAlias: latestRunByIssueKey,
    transcriptEventCountsByRunId,
  };
}

function buildWorkspaceSourceIndex(
  workspaces: readonly WorkspaceRecord[],
  defaultProjectContextId: string | null | undefined,
): WebProjectionWorkspaceSourceIndex<WorkspaceRecord> {
  const workspaceByIssueKey = new Map<string, WorkspaceRecord>();
  const workspaceBundles = [...workspaces].sort(compareWorkspacePreference).map((workspace) => ({
    workspace,
    aliasBundle: webProjectionContextAwareIssueKeyAliasBundle(workspace, {
      issueId: workspace.issueId,
      issueIdentifier: workspace.issueIdentifier,
      workspaceKey: workspace.workspaceKey,
    }),
  }));
  const rawWinners = rawAliasProjectContextWinners(workspaceBundles.map(({ aliasBundle }) => aliasBundle), defaultProjectContextId);
  for (const { workspace, aliasBundle } of workspaceBundles) {
    for (const alias of preferredIndexAliases(aliasBundle, rawWinners, defaultProjectContextId)) {
      if (!workspaceByIssueKey.has(alias)) workspaceByIssueKey.set(alias, workspace);
    }
  }
  return { workspaces: [...workspaces], workspaceByIssueKey, byAlias: workspaceByIssueKey };
}

function buildLifecycleSourceIndex(
  lifecycles: readonly IssueLifecycleRecord[],
  defaultProjectContextId: string | null | undefined,
): WebProjectionLifecycleSourceIndex<IssueLifecycleRecord> {
  const lifecycleByIssueKey = new Map<string, IssueLifecycleRecord>();
  const lifecycleBundles = [...lifecycles].sort(compareLifecyclePreference).map((lifecycle) => ({
    lifecycle,
    aliasBundle: webProjectionContextAwareIssueKeyAliasBundle(lifecycle, { issueId: lifecycle.issueId, issueIdentifier: lifecycle.issueIdentifier }),
  }));
  const rawWinners = rawAliasProjectContextWinners(lifecycleBundles.map(({ aliasBundle }) => aliasBundle), defaultProjectContextId);
  for (const { lifecycle, aliasBundle } of lifecycleBundles) {
    for (const alias of preferredIndexAliases(aliasBundle, rawWinners, defaultProjectContextId)) {
      if (!lifecycleByIssueKey.has(alias)) lifecycleByIssueKey.set(alias, lifecycle);
    }
  }
  return { records: [...lifecycles], lifecycleByIssueKey, byAlias: lifecycleByIssueKey };
}

function buildWritebackSourceIndex(
  operations: readonly WritebackOperation[],
  runIndex: WebProjectionRunSourceIndex<RunRecord>,
  lifecycleIndex: WebProjectionLifecycleSourceIndex<IssueLifecycleRecord>,
): WebProjectionWritebackSourceIndex<WritebackOperation> {
  const sortedOperations = [...operations].sort(compareWritebackChronology);
  const writebacksByIssueKey = new Map<string, WritebackOperation[]>();
  for (const operation of sortedOperations) {
    for (const alias of issueAliasesForWriteback(operation, runIndex, lifecycleIndex)) {
      const existing = writebacksByIssueKey.get(alias) ?? [];
      const scopedKey = writebackIdentityKey(operation.idempotencyKey, operation.projectContext);
      if (!existing.some((candidate) => writebackIdentityKey(candidate.idempotencyKey, candidate.projectContext) === scopedKey)) {
        existing.push(operation);
      }
      writebacksByIssueKey.set(alias, existing);
    }
  }
  return { operations: sortedOperations, writebacksByIssueKey };
}

function issueAliasesForRun(run: RunRecord): string[] {
  return webProjectionContextAwareIssueKeyAliases(run, {
    issueId: run.issueId,
    issueIdentifier: run.issueIdentifier,
    workspaceKey: run.workspaceKey,
    runId: run.runId,
    sessionId: run.sessionId,
  });
}

function issueAliasesForWriteback(
  operation: WritebackOperation,
  runIndex: WebProjectionRunSourceIndex<RunRecord>,
  lifecycleIndex: WebProjectionLifecycleSourceIndex<IssueLifecycleRecord>,
): string[] {
  const aliases = new Set<string>(webProjectionContextAwareIssueKeyAliases(operation, { issueId: operation.issueId }));
  const addAliases = (values: readonly string[]) => values.forEach((alias) => aliases.add(alias));
  const operationRun = operation.runId ? runIndex.runById.get(operation.runId) : null;
  if (operationRun) addAliases(issueAliasesForRun(operationRun));
  for (const run of runIndex.runsByIssueKey.get(operation.issueId) ?? []) addAliases(issueAliasesForRun(run));

  const lifecycle = lifecycleIndex.lifecycleByIssueKey.get(operation.issueId);
  if (lifecycle) {
    addAliases(webProjectionContextAwareIssueKeyAliases(lifecycle, { issueId: lifecycle.issueId, issueIdentifier: lifecycle.issueIdentifier }));
    for (const run of runIndex.runsByIssueKey.get(lifecycle.issueId) ?? []) addAliases(issueAliasesForRun(run));
    for (const run of runIndex.runsByIssueKey.get(lifecycle.issueIdentifier) ?? []) addAliases(issueAliasesForRun(run));
  }

  return [...aliases];
}

function buildSourceRevisions(input: {
  trackerIssues: WebProjectionIssueSourceIndex<Issue>;
  runs: readonly RunRecord[];
  workspaces: readonly WorkspaceRecord[];
  lifecycles: readonly IssueLifecycleRecord[];
  writebackOperations: readonly WritebackOperation[];
  extra: readonly WebProjectionSourceRevision[];
}): WebProjectionSourceRevision[] {
  return [
    trackerSourceRevision(input.trackerIssues),
    collectionSourceRevision("runs", input.runs, (run) => [run.updatedAt, run.completedAt, run.startedAt, run.runId]),
    collectionSourceRevision("workspaces", input.workspaces, (workspace) => [workspace.updatedAt, workspace.createdAt, workspace.workspaceKey]),
    collectionSourceRevision("lifecycles", input.lifecycles, (lifecycle) => [lifecycle.updatedAt, lifecycle.createdAt, lifecycle.issueId]),
    collectionSourceRevision("writebacks", input.writebackOperations, (operation) => [
      operation.updatedAt,
      operation.createdAt,
      writebackIdentityKey(operation.idempotencyKey, operation.projectContext),
    ]),
    ...input.extra,
  ].sort(compareSourceRevisions);
}

function trackerSourceRevision(trackerIssues: WebProjectionIssueSourceIndex<Issue>): WebProjectionSourceRevision {
  const latestIssueUpdatedAt = latestValue(trackerIssues.issues.map((issue) => issue.updatedAt ?? issue.createdAt ?? issue.id));
  return {
    source: "trackerIssues",
    revision: [trackerIssues.status, trackerIssues.fetchedStateKey, trackerIssues.issues.length, latestIssueUpdatedAt ?? "none"].join(":"),
    observedAt: trackerIssues.fetchedAt ?? latestIssueUpdatedAt,
  };
}

function collectionSourceRevision<T>(
  source: string,
  records: readonly T[],
  revisionValues: (record: T) => readonly (string | number | null | undefined)[],
): WebProjectionSourceRevision {
  const latest = latestValue(records.flatMap((record) => revisionValues(record).map((value) => (value === null || value === undefined ? null : String(value)))));
  return {
    source,
    revision: records.length === 0 ? "0" : `${records.length}:${latest ?? "unknown"}`,
    observedAt: latest,
  };
}

function emptyRuntimeSnapshot(now: Date): RuntimeSnapshot {
  return {
    generatedAt: now.toISOString(),
    counts: { running: 0, retrying: 0, paused: 0, providerGates: 0 },
    providerGates: [],
    providerGateCounts: { active: 0, manual: 0, autoResume: 0 },
    running: [],
    retrying: [],
    paused: [],
    totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
    rateLimits: null,
  };
}

function emptyWebProjectionIssueBoardColumns(): IssueBoardColumnMapping {
  return { backlog: [], todo: [], progress: [], review: [], done: [], canceled: [] };
}

function fetchedStateKey(states: readonly string[]): string {
  return uniqueStateNames(states).join(",");
}

function uniqueStateNames(states: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const state of states) {
    const normalized = normalizeWebProjectionAlias(state);
    if (normalized === null) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function isStateNameIn(state: string, states: readonly string[]): boolean {
  return states.some((candidate) => candidate.toLowerCase() === state.toLowerCase());
}

function compareWorkspacePreference(left: WorkspaceRecord, right: WorkspaceRecord): number {
  return compareDateDesc(left.updatedAt, right.updatedAt) || compareDateDesc(left.createdAt, right.createdAt) || left.workspaceKey.localeCompare(right.workspaceKey);
}

function compareLifecyclePreference(left: IssueLifecycleRecord, right: IssueLifecycleRecord): number {
  return compareDateDesc(left.updatedAt, right.updatedAt) || compareDateDesc(left.createdAt, right.createdAt) || left.issueId.localeCompare(right.issueId);
}

function compareWritebackChronology(left: WritebackOperation, right: WritebackOperation): number {
  return (
    compareDateAsc(left.createdAt, right.createdAt) ||
    compareDateAsc(left.updatedAt, right.updatedAt) ||
    writebackIdentityKey(left.idempotencyKey, left.projectContext).localeCompare(
      writebackIdentityKey(right.idempotencyKey, right.projectContext),
    )
  );
}

function compareDateAsc(left: string | null | undefined, right: string | null | undefined): number {
  return compareNullableNumber(Date.parse(left ?? ""), Date.parse(right ?? ""));
}

function compareDateDesc(left: string | null | undefined, right: string | null | undefined): number {
  return -compareDateAsc(left, right);
}

function compareNullableNumber(left: number, right: number): number {
  const leftValid = Number.isFinite(left);
  const rightValid = Number.isFinite(right);
  if (!leftValid && !rightValid) return 0;
  if (!leftValid) return -1;
  if (!rightValid) return 1;
  return left - right;
}

function latestValue(values: readonly (string | null | undefined)[]): string | null {
  let latest: string | null = null;
  for (const value of values) {
    const normalized = normalizeWebProjectionAlias(value);
    if (normalized === null) continue;
    if (latest === null || compareDateAsc(latest, normalized) < 0 || (compareDateAsc(latest, normalized) === 0 && latest < normalized)) {
      latest = normalized;
    }
  }
  return latest;
}

function defaultWebProjectionBuildHook<
  TSourceIndex extends WebProjectionSourceIndex,
  TContext extends WebProjectionContext<TSourceIndex, object>,
>(input: WebProjectionBuildInput<TSourceIndex>): TContext {
  return { metadata: input.metadata, sourceIndex: input.sourceIndex, projections: {} } as TContext;
}

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

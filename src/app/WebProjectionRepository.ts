import type { projectWebDashboard, projectWebIssueBoard, projectWebSidebar, ChatMessage } from "./webProjection.js";
import type { projectWebHistory } from "./WebHistoryProjection.js";
import type { WebTranscriptProjectionPayload } from "./WebTranscriptProjection.js";
import {
  LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
  normalizeProjectContextId,
} from "../core/config/ProjectContexts.js";
import { DEFAULT_ORCHESTRATOR_CONVERSATION_ID } from "../core/persistence/OrchestratorConversationStore.js";
import type {
  ProjectionPayloadRecord,
  ProjectionRevisionSelector,
} from "../core/persistence/ProjectionTransactionService.js";

export type WebProjectionReadStatus =
  | "hit"
  | "refresh_bypass"
  | "unavailable"
  | "missing"
  | "expired"
  | "stale"
  | "error"
  | "missing_item";

export interface WebProjectionPayloadReader {
  readCurrentPayload<TPayload = unknown>(selector: ProjectionRevisionSelector): Promise<ProjectionPayloadRecord<TPayload> | null>;
  readCurrentTranscriptDefaultPayload?<TPayload = unknown>(
    selector: WebTranscriptProjectionDefaultPageSelector,
  ): Promise<ProjectionPayloadRecord<TPayload> | null>;
}

export interface WebProjectionReadResult<TPayload> {
  status: WebProjectionReadStatus;
  selector: ProjectionRevisionSelector;
  record?: ProjectionPayloadRecord<TPayload>;
  reason?: string;
}

export interface WebProjectionReadOptions {
  forceRefresh?: boolean;
}

export interface WebProjectionContextScopeOptions {
  projectContextId?: string | null | undefined;
  defaultProjectContextId?: string | null | undefined;
}

export type WebProjectionRecordCurrentChecker = (
  record: ProjectionPayloadRecord,
) => boolean | Promise<boolean>;

export interface WebProjectionReadRepositoryOptions {
  reader?: WebProjectionPayloadReader | null;
  isRecordCurrent?: WebProjectionRecordCurrentChecker | null;
  defaultProjectContextId?: string | null | undefined;
}

export interface WebHistoryProjectionLimits extends WebProjectionContextScopeOptions {
  sessionLimit: number;
  timelineLimit: number;
}

export interface WebTranscriptProjectionPageSelector extends WebProjectionContextScopeOptions {
  runId: string;
  offset: number;
  limit: number;
}

export interface WebTranscriptProjectionDefaultPageSelector extends WebProjectionContextScopeOptions {
  runId: string;
  limit: number;
  scopeKey?: string | null | undefined;
}

export interface WebProjectionReadRepositories {
  readonly dashboard: WebDashboardProjectionRepository;
  readonly issueBoard: WebIssueBoardProjectionRepository;
  readonly sidebar: WebSidebarProjectionRepository;
  readonly history: WebHistoryProjectionRepository;
  readonly transcript: WebTranscriptProjectionRepository;
  readonly orchestratorChat: WebOrchestratorChatProjectionRepository;
}

export type WebOrchestratorChatProjectionReadPayload = readonly ChatMessage[] | { readonly chat?: unknown };

export class WebProjectionReadRepository {
  private readonly reader: WebProjectionPayloadReader | null;
  private readonly isRecordCurrent: WebProjectionRecordCurrentChecker;
  private readonly defaultProjectContextId: string;

  constructor(options: WebProjectionReadRepositoryOptions = {}) {
    this.reader = options.reader ?? null;
    this.isRecordCurrent = options.isRecordCurrent ?? (() => true);
    this.defaultProjectContextId = resolveDefaultProjectContextId(options.defaultProjectContextId);
  }

  async read<TPayload>(
    selector: ProjectionRevisionSelector,
    options: WebProjectionReadOptions = {},
  ): Promise<WebProjectionReadResult<TPayload>> {
    return this.readSelectors([selector], options);
  }

  async readHistoryProjection(
    limits: WebHistoryProjectionLimits,
    options: WebProjectionReadOptions = {},
  ): Promise<WebProjectionReadResult<ReturnType<typeof projectWebHistory>>> {
    const scopeKeys = webProjectionScopeKeyCandidates(webHistoryProjectionBaseScopeKey(limits), {
      projectContextId: limits.projectContextId,
      defaultProjectContextId: limits.defaultProjectContextId ?? this.defaultProjectContextId,
    });
    return this.readSelectors(
      projectionRevisionSelectorsForScopeKeys("history_projection", "global_collection", scopeKeys),
      options,
    );
  }

  async readTranscriptPage(
    page: WebTranscriptProjectionPageSelector,
    options: WebProjectionReadOptions = {},
  ): Promise<WebProjectionReadResult<WebTranscriptProjectionPayload>> {
    const scopeKeys = webProjectionScopeKeyCandidates(webTranscriptProjectionBaseScopeKey(page), {
      projectContextId: page.projectContextId,
      defaultProjectContextId: page.defaultProjectContextId ?? this.defaultProjectContextId,
    });
    return this.readSelectors(
      projectionRevisionSelectorsForScopeKeys("transcript_projection", "run_page", scopeKeys),
      options,
    );
  }

  async readTranscriptDefaultPage<TPayload>(
    selector: WebTranscriptProjectionDefaultPageSelector,
    options: WebProjectionReadOptions = {},
  ): Promise<WebProjectionReadResult<TPayload>> {
    const readSelectors = webTranscriptDefaultProjectionReadCandidates({
      ...selector,
      defaultProjectContextId: selector.defaultProjectContextId ?? this.defaultProjectContextId,
    });
    return this.readUsingCandidates<TPayload, WebTranscriptProjectionDefaultPageSelector>(
      transcriptDefaultProjectionRevisionSelector(readSelectors[0]!),
      readSelectors,
      options,
      (reader, candidate) => {
        if (reader.readCurrentTranscriptDefaultPayload) {
          return reader.readCurrentTranscriptDefaultPayload<TPayload>({
            ...candidate,
            scopeKey: candidate.scopeKey ?? webTranscriptDefaultProjectionReadScopeKey(candidate),
          });
        }
        return Promise.resolve(null);
      },
    );
  }

  private async readSelectors<TPayload>(
    selectors: readonly ProjectionRevisionSelector[],
    options: WebProjectionReadOptions,
  ): Promise<WebProjectionReadResult<TPayload>> {
    return this.readUsingCandidates(selectors[0]!, selectors, options, (reader, selector) =>
      reader.readCurrentPayload<TPayload>(selector),
    );
  }

  private async readUsingCandidates<TPayload, TSelector>(
    selector: ProjectionRevisionSelector,
    selectors: readonly TSelector[],
    options: WebProjectionReadOptions,
    readRecord: (
      reader: WebProjectionPayloadReader,
      selector: TSelector,
    ) => Promise<ProjectionPayloadRecord<TPayload> | null>,
  ): Promise<WebProjectionReadResult<TPayload>> {
    if (options.forceRefresh === true) return { status: "refresh_bypass", selector };
    if (!this.reader) return { status: "unavailable", selector };
    try {
      let fallbackResult: WebProjectionReadResult<TPayload> | null = null;
      for (const candidate of selectors) {
        const record = await readRecord(this.reader, candidate);
        if (!record) continue;
        const resolvedSelector = projectionRevisionSelector(record);
        if (isWebProjectionPayloadExpired(record)) {
          fallbackResult ??= { status: "expired", selector: resolvedSelector, record };
          continue;
        }
        if (!(await this.isRecordCurrent(record))) {
          fallbackResult ??= { status: "stale", selector: resolvedSelector, record };
          continue;
        }
        return { status: "hit", selector: resolvedSelector, record };
      }
      return fallbackResult ?? { status: "missing", selector };
    } catch {
      return { status: "error", selector };
    }
  }
}

export class WebDashboardProjectionRepository {
  constructor(private readonly reads: WebProjectionReadRepository) {}

  readCurrent(
    options: WebProjectionReadOptions = {},
  ): Promise<WebProjectionReadResult<ReturnType<typeof projectWebDashboard>>> {
    return this.reads.read({ projectionName: "dashboard_projection", scopeKind: "global", scopeKey: "global" }, options);
  }
}

export class WebIssueBoardProjectionRepository {
  constructor(private readonly reads: WebProjectionReadRepository) {}

  readDefaultBoard(options: WebProjectionReadOptions = {}): Promise<WebProjectionReadResult<ReturnType<typeof projectWebIssueBoard>>> {
    return this.reads.read({ projectionName: "issue_board_projection", scopeKind: "board", scopeKey: "default-board" }, options);
  }
}

export class WebSidebarProjectionRepository {
  constructor(private readonly reads: WebProjectionReadRepository) {}

  readCurrent(options: WebProjectionReadOptions = {}): Promise<WebProjectionReadResult<ReturnType<typeof projectWebSidebar>>> {
    return this.reads.read({ projectionName: "sidebar_projection", scopeKind: "global", scopeKey: "global" }, options);
  }
}

export class WebHistoryProjectionRepository {
  constructor(private readonly reads: WebProjectionReadRepository) {}

  readGlobalCollection(
    limits: WebHistoryProjectionLimits,
    options: WebProjectionReadOptions = {},
  ): Promise<WebProjectionReadResult<ReturnType<typeof projectWebHistory>>> {
    return this.reads.readHistoryProjection(limits, options);
  }
}

export class WebTranscriptProjectionRepository {
  constructor(private readonly reads: WebProjectionReadRepository) {}

  readRunPage(
    page: WebTranscriptProjectionPageSelector,
    options: WebProjectionReadOptions = {},
  ): Promise<WebProjectionReadResult<WebTranscriptProjectionPayload>> {
    return this.reads.readTranscriptPage(page, options);
  }

  readRunDefaultPage(
    page: WebTranscriptProjectionDefaultPageSelector,
    options: WebProjectionReadOptions = {},
  ): Promise<WebProjectionReadResult<WebTranscriptProjectionPayload>> {
    return this.reads.readTranscriptDefaultPage(page, options);
  }
}

export class WebOrchestratorChatProjectionRepository {
  constructor(private readonly reads: WebProjectionReadRepository) {}

  readConversation(
    conversationId?: string | null,
    options: WebProjectionReadOptions = {},
  ): Promise<WebProjectionReadResult<WebOrchestratorChatProjectionReadPayload>> {
    return this.reads.read(
      {
        projectionName: "orchestrator_chat_projection",
        scopeKind: "conversation",
        scopeKey: webOrchestratorChatProjectionScopeKey(conversationId),
      },
      options,
    );
  }
}

export function createWebProjectionReadRepositories(
  options: WebProjectionReadRepositoryOptions = {},
): WebProjectionReadRepositories {
  const reads = new WebProjectionReadRepository(options);
  return {
    dashboard: new WebDashboardProjectionRepository(reads),
    issueBoard: new WebIssueBoardProjectionRepository(reads),
    sidebar: new WebSidebarProjectionRepository(reads),
    history: new WebHistoryProjectionRepository(reads),
    transcript: new WebTranscriptProjectionRepository(reads),
    orchestratorChat: new WebOrchestratorChatProjectionRepository(reads),
  };
}

export function webHistoryProjectionScopeKey(limits: WebHistoryProjectionLimits): string {
  return webProjectionScopeKeyCandidates(webHistoryProjectionBaseScopeKey(limits), limits)[0]!;
}

export function webTranscriptProjectionScopeKey(page: WebTranscriptProjectionPageSelector): string {
  return webProjectionScopeKeyCandidates(webTranscriptProjectionBaseScopeKey(page), page)[0]!;
}

export function webTranscriptDefaultProjectionScopeKey(page: WebTranscriptProjectionDefaultPageSelector): string {
  return webProjectionScopeKeyCandidates(webTranscriptDefaultProjectionBaseScopeKey(page), page)[0]!;
}

export function webOrchestratorChatProjectionScopeKey(conversationId?: string | null): string {
  const trimmed = conversationId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_ORCHESTRATOR_CONVERSATION_ID;
}

export function isWebProjectionPayloadExpired(record: Pick<ProjectionPayloadRecord, "expiresAt">): boolean {
  if (record.expiresAt === null) return false;
  const expiresAtMs = Date.parse(record.expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();
}

function projectionRevisionSelector(record: ProjectionPayloadRecord): ProjectionRevisionSelector {
  return {
    projectionName: record.revision.projectionName,
    scopeKind: record.revision.scopeKind,
    scopeKey: record.revision.scopeKey,
  };
}

function projectionRevisionSelectorsForScopeKeys(
  projectionName: ProjectionRevisionSelector["projectionName"],
  scopeKind: string,
  scopeKeys: readonly string[],
): ProjectionRevisionSelector[] {
  return scopeKeys.map((scopeKey) => {
    const projectContextId = webProjectionScopeKeyProjectContextId(scopeKey);
    return {
      projectionName,
      ...(projectContextId ? { projectContextId } : {}),
      scopeKind,
      scopeKey,
    };
  });
}

function transcriptDefaultProjectionRevisionSelector(
  selector: WebTranscriptProjectionDefaultPageSelector,
): ProjectionRevisionSelector {
  return {
    projectionName: "transcript_projection",
    scopeKind: "run_page",
    scopeKey: webTranscriptDefaultProjectionScopeKey(selector),
  };
}

function webTranscriptDefaultProjectionReadCandidates(
  selector: WebTranscriptProjectionDefaultPageSelector,
): WebTranscriptProjectionDefaultPageSelector[] {
  if (!shouldFallbackToLegacyDefaultScopeKey(selector.projectContextId, selector.defaultProjectContextId)) {
    return [selector];
  }
  return [
    ...compatibilityDefaultProjectContextScopeIds(selector.defaultProjectContextId).map((projectContextId) => ({
      ...selector,
      projectContextId,
    })),
    { ...selector, projectContextId: undefined },
  ];
}

function webHistoryProjectionBaseScopeKey(limits: Pick<WebHistoryProjectionLimits, "sessionLimit" | "timelineLimit">): string {
  return `global:session:${limits.sessionLimit}:timeline:${limits.timelineLimit}`;
}

function webTranscriptProjectionBaseScopeKey(page: Pick<WebTranscriptProjectionPageSelector, "runId" | "offset" | "limit">): string {
  return `${page.runId}:offset:${page.offset}:limit:${page.limit}`;
}

function webTranscriptDefaultProjectionBaseScopeKey(page: Pick<WebTranscriptProjectionDefaultPageSelector, "runId" | "limit">): string {
  return `${page.runId}:tail:limit:${page.limit}`;
}

function webTranscriptDefaultProjectionReadScopeKey(page: WebTranscriptProjectionDefaultPageSelector): string {
  return webProjectionScopedScopeKey(webTranscriptDefaultProjectionBaseScopeKey(page), page.projectContextId);
}

function webProjectionScopeKeyCandidates(baseScopeKey: string, options: WebProjectionContextScopeOptions): string[] {
  const projectContextId = normalizeOptionalProjectContextId(options.projectContextId);
  if (!projectContextId) return [baseScopeKey];
  const defaultProjectContextId = resolveDefaultProjectContextId(options.defaultProjectContextId);
  const compatibilityIds = compatibilityDefaultProjectContextIds(defaultProjectContextId);
  if (!compatibilityIds.has(projectContextId)) {
    return [`pc=${projectContextId}|${baseScopeKey}`];
  }
  return [...compatibilityDefaultProjectContextScopeIds(defaultProjectContextId).map((scopeContextId) => `pc=${scopeContextId}|${baseScopeKey}`), baseScopeKey];
}

function webProjectionScopedScopeKey(baseScopeKey: string, projectContextId: string | null | undefined): string {
  const normalizedProjectContextId = normalizeOptionalProjectContextId(projectContextId);
  return normalizedProjectContextId ? `pc=${normalizedProjectContextId}|${baseScopeKey}` : baseScopeKey;
}

function webProjectionScopeKeyProjectContextId(scopeKey: string): string | undefined {
  const match = /^pc=([^|]+)\|/.exec(scopeKey);
  return match?.[1];
}

function shouldFallbackToLegacyDefaultScopeKey(projectContextId: string | null | undefined, defaultProjectContextId: string | null | undefined): boolean {
  const normalizedProjectContextId = normalizeOptionalProjectContextId(projectContextId);
  return normalizedProjectContextId !== null && compatibilityDefaultProjectContextIds(defaultProjectContextId).has(normalizedProjectContextId);
}

function compatibilityDefaultProjectContextIds(defaultProjectContextId: string | null | undefined): ReadonlySet<string> {
  const resolvedDefaultProjectContextId = resolveDefaultProjectContextId(defaultProjectContextId);
  return resolvedDefaultProjectContextId === LEGACY_DEFAULT_PROJECT_CONTEXT_ID
    ? new Set([LEGACY_DEFAULT_PROJECT_CONTEXT_ID])
    : new Set([LEGACY_DEFAULT_PROJECT_CONTEXT_ID, resolvedDefaultProjectContextId]);
}

function compatibilityDefaultProjectContextScopeIds(defaultProjectContextId: string | null | undefined): readonly string[] {
  const resolvedDefaultProjectContextId = resolveDefaultProjectContextId(defaultProjectContextId);
  return resolvedDefaultProjectContextId === LEGACY_DEFAULT_PROJECT_CONTEXT_ID
    ? [LEGACY_DEFAULT_PROJECT_CONTEXT_ID]
    : [resolvedDefaultProjectContextId, LEGACY_DEFAULT_PROJECT_CONTEXT_ID];
}

function resolveDefaultProjectContextId(defaultProjectContextId: string | null | undefined): string {
  return normalizeOptionalProjectContextId(defaultProjectContextId) ?? LEGACY_DEFAULT_PROJECT_CONTEXT_ID;
}

function normalizeOptionalProjectContextId(projectContextId: string | null | undefined): string | null {
  if (typeof projectContextId !== "string") return null;
  const trimmed = projectContextId.trim();
  if (trimmed.length === 0) return null;
  return normalizeProjectContextId(trimmed);
}

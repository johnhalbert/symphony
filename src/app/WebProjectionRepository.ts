import type { projectWebDashboard, projectWebIssueBoard, projectWebSidebar, ChatMessage } from "./webProjection.js";
import type { projectWebHistory } from "./WebHistoryProjection.js";
import type { WebTranscriptProjectionPayload } from "./WebTranscriptProjection.js";
import { DEFAULT_ORCHESTRATOR_CONVERSATION_ID } from "../core/persistence/OrchestratorConversationStore.js";
import { LEGACY_DEFAULT_PROJECT_CONTEXT_ID, normalizeProjectContextId } from "../core/config/ProjectContexts.js";
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

export type WebProjectionRecordCurrentChecker = (
  record: ProjectionPayloadRecord,
) => boolean | Promise<boolean>;

export interface WebProjectionReadRepositoryOptions {
  reader?: WebProjectionPayloadReader | null;
  isRecordCurrent?: WebProjectionRecordCurrentChecker | null;
  resolveDefaultProjectContextId?: (() => string | null | undefined) | null;
}

export interface WebHistoryProjectionLimits {
  sessionLimit: number;
  timelineLimit: number;
}

export interface WebTranscriptProjectionPageSelector {
  runId: string;
  offset: number;
  limit: number;
  projectContextId?: string | null;
}

export interface WebTranscriptProjectionDefaultPageSelector {
  runId: string;
  limit: number;
  projectContextId?: string | null;
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
  private readonly resolveDefaultProjectContextId: () => string | null | undefined;

  constructor(options: WebProjectionReadRepositoryOptions = {}) {
    this.reader = options.reader ?? null;
    this.isRecordCurrent = options.isRecordCurrent ?? (() => true);
    this.resolveDefaultProjectContextId = options.resolveDefaultProjectContextId ?? (() => undefined);
  }

  async read<TPayload>(
    selector: ProjectionRevisionSelector,
    options: WebProjectionReadOptions = {},
  ): Promise<WebProjectionReadResult<TPayload>> {
    return this.readUsing(selector, options, (reader, attemptSelector) => reader.readCurrentPayload<TPayload>(attemptSelector));
  }

  async readTranscriptDefaultPage<TPayload>(
    selector: WebTranscriptProjectionDefaultPageSelector,
    options: WebProjectionReadOptions = {},
  ): Promise<WebProjectionReadResult<TPayload>> {
    const defaultSelector: ProjectionRevisionSelector = {
      projectionName: "transcript_projection",
      projectContextId: selector.projectContextId ?? null,
      scopeKind: "run_page",
      scopeKey: webTranscriptDefaultProjectionScopeKey(selector),
    };
    return this.readUsing<TPayload>(defaultSelector, options, (reader, attemptSelector) => {
      if (reader.readCurrentTranscriptDefaultPayload) {
        return reader.readCurrentTranscriptDefaultPayload<TPayload>({
          ...selector,
          projectContextId: attemptSelector.projectContextId ?? null,
        });
      }
      return Promise.resolve(null);
    });
  }

  private async readUsing<TPayload>(
    selector: ProjectionRevisionSelector,
    options: WebProjectionReadOptions,
    readRecord: (
      reader: WebProjectionPayloadReader,
      selector: ProjectionRevisionSelector,
    ) => Promise<ProjectionPayloadRecord<TPayload> | null>,
  ): Promise<WebProjectionReadResult<TPayload>> {
    if (options.forceRefresh === true) return { status: "refresh_bypass", selector };
    if (!this.reader) return { status: "unavailable", selector };
    const selectors = compatibleProjectionRevisionSelectors(selector, this.resolveDefaultProjectContextId());
    try {
      let record: ProjectionPayloadRecord<TPayload> | null = null;
      for (const attemptSelector of selectors) {
        record = await readRecord(this.reader, attemptSelector);
        if (record) break;
      }
      if (!record) return { status: "missing", selector };
      const resolvedSelector = projectionRevisionSelector(record);
      if (isWebProjectionPayloadExpired(record)) return { status: "expired", selector: resolvedSelector, record };
      if (!(await this.isRecordCurrent(record))) return { status: "stale", selector: resolvedSelector, record };
      return { status: "hit", selector: resolvedSelector, record };
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

  readDefaultBoard(
    options: WebProjectionReadOptions = {},
    projectContextId: string | null = null,
  ): Promise<WebProjectionReadResult<ReturnType<typeof projectWebIssueBoard>>> {
    return this.reads.read(
      {
        projectionName: "issue_board_projection",
        projectContextId,
        scopeKind: "board",
        scopeKey: "default-board",
      },
      options,
    );
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
    return this.reads.read(
      { projectionName: "history_projection", scopeKind: "global_collection", scopeKey: webHistoryProjectionScopeKey(limits) },
      options,
    );
  }
}

export class WebTranscriptProjectionRepository {
  constructor(private readonly reads: WebProjectionReadRepository) {}

  readRunPage(
    page: WebTranscriptProjectionPageSelector,
    options: WebProjectionReadOptions = {},
  ): Promise<WebProjectionReadResult<WebTranscriptProjectionPayload>> {
    return this.reads.read(
      {
        projectionName: "transcript_projection",
        projectContextId: page.projectContextId ?? null,
        scopeKind: "run_page",
        scopeKey: webTranscriptProjectionScopeKey(page),
      },
      options,
    );
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
  return `global:session:${limits.sessionLimit}:timeline:${limits.timelineLimit}`;
}

export function webTranscriptProjectionScopeKey(page: WebTranscriptProjectionPageSelector): string {
  return `${page.runId}:offset:${page.offset}:limit:${page.limit}`;
}

export function webTranscriptDefaultProjectionScopeKey(page: WebTranscriptProjectionDefaultPageSelector): string {
  return `${page.runId}:tail:limit:${page.limit}`;
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
    projectContextId: record.revision.projectContextId,
    scopeKind: record.revision.scopeKind,
    scopeKey: record.revision.scopeKey,
  };
}

export function compatibleProjectionRevisionSelectors(
  selector: ProjectionRevisionSelector,
  defaultProjectContextId: string | null | undefined,
): ProjectionRevisionSelector[] {
  const projectContextIds = compatibleProjectionContextIds(selector.projectContextId, defaultProjectContextId);
  return projectContextIds.map((projectContextId) => ({ ...selector, projectContextId }));
}

function compatibleProjectionContextIds(
  requestedProjectContextId: string | null | undefined,
  defaultProjectContextId: string | null | undefined,
): string[] {
  const resolvedDefaultProjectContextId = resolveDefaultProjectionProjectContextId(defaultProjectContextId);
  const normalizedRequestedProjectContextId = normalizeOptionalProjectContextId(requestedProjectContextId);

  if (normalizedRequestedProjectContextId === null) {
    return resolvedDefaultProjectContextId === LEGACY_DEFAULT_PROJECT_CONTEXT_ID
      ? [LEGACY_DEFAULT_PROJECT_CONTEXT_ID]
      : [resolvedDefaultProjectContextId, LEGACY_DEFAULT_PROJECT_CONTEXT_ID];
  }

  if (normalizedRequestedProjectContextId === LEGACY_DEFAULT_PROJECT_CONTEXT_ID) {
    return [LEGACY_DEFAULT_PROJECT_CONTEXT_ID];
  }

  if (normalizedRequestedProjectContextId === resolvedDefaultProjectContextId) {
    return resolvedDefaultProjectContextId === LEGACY_DEFAULT_PROJECT_CONTEXT_ID
      ? [LEGACY_DEFAULT_PROJECT_CONTEXT_ID]
      : [resolvedDefaultProjectContextId, LEGACY_DEFAULT_PROJECT_CONTEXT_ID];
  }

  return [normalizedRequestedProjectContextId];
}

function resolveDefaultProjectionProjectContextId(defaultProjectContextId: string | null | undefined): string {
  return normalizeOptionalProjectContextId(defaultProjectContextId) ?? LEGACY_DEFAULT_PROJECT_CONTEXT_ID;
}

function normalizeOptionalProjectContextId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  try {
    return normalizeProjectContextId(trimmed);
  } catch {
    return null;
  }
}

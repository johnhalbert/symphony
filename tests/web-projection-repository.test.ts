import { describe, expect, it } from "vitest";
import { LEGACY_DEFAULT_PROJECT_CONTEXT_ID } from "../src/core/config/ProjectContexts.js";
import {
  createWebProjectionReadRepositories,
  webHistoryProjectionScopeKey,
  webOrchestratorChatProjectionScopeKey,
  webTranscriptProjectionScopeKey,
  type WebProjectionPayloadReader,
} from "../src/app/WebProjectionRepository.js";
import type {
  DurableProjectionName,
  ProjectionPayloadRecord,
  ProjectionRevisionRecord,
  ProjectionRevisionSelector,
  ProjectionSourceRevision,
} from "../src/core/persistence/ProjectionTransactionService.js";

class RecordingWebProjectionPayloadReader implements WebProjectionPayloadReader {
  readonly selectors: ProjectionRevisionSelector[] = [];
  private readonly records = new Map<string, ProjectionPayloadRecord>();

  constructor(records: readonly ProjectionPayloadRecord[]) {
    for (const record of records) {
      this.records.set(projectionSelectorKey(record.revision), cloneJson(record));
    }
  }

  async readCurrentPayload<TPayload = unknown>(selector: ProjectionRevisionSelector): Promise<ProjectionPayloadRecord<TPayload> | null> {
    this.selectors.push({ ...selector });
    const record = this.records.get(projectionSelectorKey(selector));
    return record ? (cloneJson(record) as ProjectionPayloadRecord<TPayload>) : null;
  }
}

class FailingWebProjectionPayloadReader implements WebProjectionPayloadReader {
  readonly selectors: ProjectionRevisionSelector[] = [];

  async readCurrentPayload<TPayload = unknown>(selector: ProjectionRevisionSelector): Promise<ProjectionPayloadRecord<TPayload> | null> {
    this.selectors.push({ ...selector });
    throw new Error("simulated projection read failure");
  }
}

describe("web projection read repositories", () => {
  it("routes named web API reads through stable durable projection selectors", async () => {
    const dashboard = { projectName: "Durable Symphony" };
    const issueBoard = { issues: [], backlog: [], lanes: { todo: [], progress: [], review: [] }, cycleLabel: "", cycleDateRange: "", selectedIssueId: "" };
    const sidebar = { providerGates: [], runningAgents: [], reviewIssues: [], activity: [], sessions: [], chat: [], totals: {} };
    const history = { sessions: [], transcriptBySession: {}, timeline: [], defaultSessionId: "" };
    const transcript = [{ kind: "assistant", ts: "2026-01-01T00:00:00.000Z", text: "durable transcript" }];
    const chat = [{ id: "chat-1", who: "agent", text: "durable chat", createdAt: "2026-01-01T00:00:00.000Z" }];
    const reader = new RecordingWebProjectionPayloadReader([
      projectionPayloadRecordFixture({ projectionName: "dashboard_projection", scopeKind: "global", scopeKey: "global" }, dashboard),
      projectionPayloadRecordFixture({ projectionName: "issue_board_projection", scopeKind: "board", scopeKey: "default-board" }, issueBoard),
      projectionPayloadRecordFixture({ projectionName: "sidebar_projection", scopeKind: "global", scopeKey: "global" }, sidebar),
      projectionPayloadRecordFixture(
        { projectionName: "history_projection", scopeKind: "global_collection", scopeKey: "global:session:7:timeline:9" },
        history,
      ),
      projectionPayloadRecordFixture({ projectionName: "transcript_projection", scopeKind: "run_page", scopeKey: "run-1:offset:10:limit:25" }, transcript),
      projectionPayloadRecordFixture({ projectionName: "orchestrator_chat_projection", scopeKind: "conversation", scopeKey: "operator-room" }, chat),
    ]);
    const repositories = createWebProjectionReadRepositories({ reader, isRecordCurrent: () => true });

    const results = await Promise.all([
      repositories.dashboard.readCurrent(),
      repositories.issueBoard.readDefaultBoard(),
      repositories.sidebar.readCurrent(),
      repositories.history.readGlobalCollection({ sessionLimit: 7, timelineLimit: 9 }),
      repositories.transcript.readRunPage({ runId: "run-1", offset: 10, limit: 25 }),
      repositories.orchestratorChat.readConversation("operator-room"),
    ]);

    expect(results.map((result) => result.status)).toEqual(["hit", "hit", "hit", "hit", "hit", "hit"]);
    expect(results.map((result) => result.record?.payload)).toEqual([dashboard, issueBoard, sidebar, history, transcript, chat]);
    expect(reader.selectors.map(({ projectionName, projectContextId, scopeKind, scopeKey }) => ({ projectionName, projectContextId, scopeKind, scopeKey }))).toEqual([
      { projectionName: "dashboard_projection", projectContextId: LEGACY_DEFAULT_PROJECT_CONTEXT_ID, scopeKind: "global", scopeKey: "global" },
      { projectionName: "issue_board_projection", projectContextId: LEGACY_DEFAULT_PROJECT_CONTEXT_ID, scopeKind: "board", scopeKey: "default-board" },
      { projectionName: "sidebar_projection", projectContextId: LEGACY_DEFAULT_PROJECT_CONTEXT_ID, scopeKind: "global", scopeKey: "global" },
      { projectionName: "history_projection", projectContextId: LEGACY_DEFAULT_PROJECT_CONTEXT_ID, scopeKind: "global_collection", scopeKey: "global:session:7:timeline:9" },
      { projectionName: "transcript_projection", projectContextId: LEGACY_DEFAULT_PROJECT_CONTEXT_ID, scopeKind: "run_page", scopeKey: "run-1:offset:10:limit:25" },
      { projectionName: "orchestrator_chat_projection", projectContextId: LEGACY_DEFAULT_PROJECT_CONTEXT_ID, scopeKind: "conversation", scopeKey: "operator-room" },
    ]);
    expect(webHistoryProjectionScopeKey({ sessionLimit: 7, timelineLimit: 9 })).toBe("global:session:7:timeline:9");
    expect(webTranscriptProjectionScopeKey({ runId: "run-1", offset: 10, limit: 25 })).toBe("run-1:offset:10:limit:25");
    expect(webOrchestratorChatProjectionScopeKey("  ")).toBe("orchestrator-default");
  });

  it("preserves fallback statuses for unavailable, missing, refresh-bypassed, and failing projection readers", async () => {
    await expect(createWebProjectionReadRepositories().dashboard.readCurrent()).resolves.toMatchObject({
      status: "unavailable",
      selector: { projectionName: "dashboard_projection", scopeKind: "global", scopeKey: "global" },
    });

    const refreshReader = new RecordingWebProjectionPayloadReader([
      projectionPayloadRecordFixture({ projectionName: "dashboard_projection", scopeKind: "global", scopeKey: "global" }, { projectName: "do not read" }),
    ]);
    await expect(createWebProjectionReadRepositories({ reader: refreshReader }).dashboard.readCurrent({ forceRefresh: true })).resolves.toMatchObject({
      status: "refresh_bypass",
      selector: { projectionName: "dashboard_projection", scopeKind: "global", scopeKey: "global" },
    });
    expect(refreshReader.selectors).toEqual([]);

    const missingReader = new RecordingWebProjectionPayloadReader([]);
    await expect(createWebProjectionReadRepositories({ reader: missingReader }).issueBoard.readDefaultBoard()).resolves.toMatchObject({
      status: "missing",
      selector: { projectionName: "issue_board_projection", scopeKind: "board", scopeKey: "default-board" },
    });
    expect(missingReader.selectors).toEqual([{ projectionName: "issue_board_projection", projectContextId: LEGACY_DEFAULT_PROJECT_CONTEXT_ID, scopeKind: "board", scopeKey: "default-board" }]);

    const offsetZeroTranscriptReader = new RecordingWebProjectionPayloadReader([
      projectionPayloadRecordFixture(
        { projectionName: "transcript_projection", scopeKind: "run_page", scopeKey: "run-1:offset:0:limit:500" },
        [{ kind: "assistant", ts: "2026-01-01T00:00:00.000Z", text: "first page must not be a default-tail fallback" }],
      ),
    ]);
    await expect(
      createWebProjectionReadRepositories({ reader: offsetZeroTranscriptReader }).transcript.readRunDefaultPage({ runId: "run-1", limit: 500 }),
    ).resolves.toMatchObject({
      status: "missing",
      selector: { projectionName: "transcript_projection", scopeKind: "run_page", scopeKey: "run-1:tail:limit:500" },
    });
    expect(offsetZeroTranscriptReader.selectors).toEqual([]);

    const failingReader = new FailingWebProjectionPayloadReader();
    await expect(createWebProjectionReadRepositories({ reader: failingReader }).history.readGlobalCollection({ sessionLimit: 100, timelineLimit: 250 })).resolves.toMatchObject({
      status: "error",
      selector: { projectionName: "history_projection", scopeKind: "global_collection", scopeKey: "global:session:100:timeline:250" },
    });
    expect(failingReader.selectors).toEqual([
      { projectionName: "history_projection", projectContextId: LEGACY_DEFAULT_PROJECT_CONTEXT_ID, scopeKind: "global_collection", scopeKey: "global:session:100:timeline:250" },
    ]);
  });

  it("retries configured default projection contexts against legacy default rows while preserving explicit scoped selectors", async () => {
    const legacyIssueBoard = {
      issues: [],
      backlog: [],
      lanes: { todo: [], progress: [], review: [] },
      cycleLabel: "legacy",
      cycleDateRange: "legacy-range",
      selectedIssueId: "legacy-issue",
    };
    const docsIssueBoard = {
      issues: [],
      backlog: [],
      lanes: { todo: [], progress: [], review: [] },
      cycleLabel: "docs",
      cycleDateRange: "docs-range",
      selectedIssueId: "docs-issue",
    };
    const scopedReader = new RecordingWebProjectionPayloadReader([
      projectionPayloadRecordFixture(
        {
          projectionName: "issue_board_projection",
          projectContextId: "docs",
          scopeKind: "board",
          scopeKey: "default-board",
        },
        docsIssueBoard,
      ),
      projectionPayloadRecordFixture(
        {
          projectionName: "issue_board_projection",
          projectContextId: LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
          scopeKind: "board",
          scopeKey: "default-board",
        },
        legacyIssueBoard,
      ),
      projectionPayloadRecordFixture(
        {
          projectionName: "transcript_projection",
          projectContextId: "docs",
          scopeKind: "run_page",
          scopeKey: "run-1:offset:0:limit:500",
        },
        [],
      ),
    ]);
    const scopedRepositories = createWebProjectionReadRepositories({
      reader: scopedReader,
      isRecordCurrent: () => true,
      resolveDefaultProjectContextId: () => "docs",
    });

    await expect(scopedRepositories.issueBoard.readDefaultBoard()).resolves.toMatchObject({
      status: "hit",
      selector: {
        projectionName: "issue_board_projection",
        projectContextId: "docs",
        scopeKind: "board",
        scopeKey: "default-board",
      },
      record: { payload: docsIssueBoard },
    });
    await expect(scopedRepositories.issueBoard.readDefaultBoard({}, LEGACY_DEFAULT_PROJECT_CONTEXT_ID)).resolves.toMatchObject({
      status: "hit",
      selector: {
        projectionName: "issue_board_projection",
        projectContextId: LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
        scopeKind: "board",
        scopeKey: "default-board",
      },
      record: { payload: legacyIssueBoard },
    });
    await expect(scopedRepositories.transcript.readRunPage({ runId: "run-1", projectContextId: "docs", offset: 0, limit: 500 })).resolves.toMatchObject({
      status: "hit",
      selector: {
        projectionName: "transcript_projection",
        projectContextId: "docs",
        scopeKind: "run_page",
        scopeKey: "run-1:offset:0:limit:500",
      },
    });
    expect(scopedReader.selectors).toEqual([
      { projectionName: "issue_board_projection", projectContextId: "docs", scopeKind: "board", scopeKey: "default-board" },
      {
        projectionName: "issue_board_projection",
        projectContextId: LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
        scopeKind: "board",
        scopeKey: "default-board",
      },
      { projectionName: "transcript_projection", projectContextId: "docs", scopeKind: "run_page", scopeKey: "run-1:offset:0:limit:500" },
    ]);

    const fallbackReader = new RecordingWebProjectionPayloadReader([
      projectionPayloadRecordFixture(
        {
          projectionName: "issue_board_projection",
          projectContextId: LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
          scopeKind: "board",
          scopeKey: "default-board",
        },
        legacyIssueBoard,
      ),
    ]);
    const fallbackRepositories = createWebProjectionReadRepositories({
      reader: fallbackReader,
      isRecordCurrent: () => true,
      resolveDefaultProjectContextId: () => "docs",
    });

    await expect(fallbackRepositories.issueBoard.readDefaultBoard()).resolves.toMatchObject({
      status: "hit",
      selector: {
        projectionName: "issue_board_projection",
        projectContextId: LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
        scopeKind: "board",
        scopeKey: "default-board",
      },
      record: { payload: legacyIssueBoard },
    });
    await expect(fallbackRepositories.issueBoard.readDefaultBoard({}, "docs")).resolves.toMatchObject({
      status: "hit",
      selector: {
        projectionName: "issue_board_projection",
        projectContextId: LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
        scopeKind: "board",
        scopeKey: "default-board",
      },
      record: { payload: legacyIssueBoard },
    });
    expect(fallbackReader.selectors).toEqual([
      { projectionName: "issue_board_projection", projectContextId: "docs", scopeKind: "board", scopeKey: "default-board" },
      {
        projectionName: "issue_board_projection",
        projectContextId: LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
        scopeKind: "board",
        scopeKey: "default-board",
      },
      { projectionName: "issue_board_projection", projectContextId: "docs", scopeKind: "board", scopeKey: "default-board" },
      {
        projectionName: "issue_board_projection",
        projectContextId: LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
        scopeKind: "board",
        scopeKey: "default-board",
      },
    ]);
  });

  it("marks expired and stale durable projection rows as fallback reads", async () => {
    const expiredReader = new RecordingWebProjectionPayloadReader([
      projectionPayloadRecordFixture(
        { projectionName: "dashboard_projection", scopeKind: "global", scopeKey: "global" },
        { projectName: "expired dashboard" },
        { expiresAt: "2000-01-01T00:00:00.000Z" },
      ),
    ]);
    let currentChecks = 0;
    await expect(
      createWebProjectionReadRepositories({
        reader: expiredReader,
        isRecordCurrent: () => {
          currentChecks += 1;
          return true;
        },
      }).dashboard.readCurrent(),
    ).resolves.toMatchObject({ status: "expired", selector: { projectionName: "dashboard_projection" } });
    expect(currentChecks).toBe(0);

    const staleReader = new RecordingWebProjectionPayloadReader([
      projectionPayloadRecordFixture(
        { projectionName: "transcript_projection", scopeKind: "run_page", scopeKey: "run-1:offset:0:limit:500" },
        [],
      ),
    ]);
    await expect(
      createWebProjectionReadRepositories({ reader: staleReader, isRecordCurrent: () => false }).transcript.readRunPage({
        runId: "run-1",
        offset: 0,
        limit: 500,
      }),
    ).resolves.toMatchObject({ status: "stale", selector: { projectionName: "transcript_projection", scopeKind: "run_page" } });

    await expect(
      createWebProjectionReadRepositories({
        reader: staleReader,
        isRecordCurrent: () => {
          throw new Error("source revision read failed");
        },
      }).transcript.readRunPage({ runId: "run-1", offset: 0, limit: 500 }),
    ).resolves.toMatchObject({ status: "error", selector: { projectionName: "transcript_projection", scopeKind: "run_page" } });
  });
});

function projectionSelectorKey(selector: ProjectionRevisionSelector): string {
  return [
    selector.projectionName,
    selector.projectContextId ?? LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
    selector.scopeKind ?? "global",
    selector.scopeKey ?? "global",
  ].join(":");
}

function projectionPayloadRecordFixture<TPayload>(
  selector: { projectionName: DurableProjectionName; projectContextId?: string; scopeKind: string; scopeKey: string },
  payload: TPayload,
  options: { sourceRevisions?: ProjectionSourceRevision[]; expiresAt?: string | null; revision?: number } = {},
): ProjectionPayloadRecord<TPayload> {
  const generatedAt = "2026-01-01T00:00:00.000Z";
  const revision = options.revision ?? 1;
  return {
    revision: projectionRevisionRecordFixture(selector, revision, options.sourceRevisions ?? [], options.expiresAt ?? null),
    payload: cloneJson(payload),
    payloadSha256: "1".repeat(64),
    rawPayloadRefs: [],
    generatedAt,
    expiresAt: options.expiresAt ?? null,
  };
}

function projectionRevisionRecordFixture(
  selector: { projectionName: DurableProjectionName; projectContextId?: string; scopeKind: string; scopeKey: string },
  revision: number,
  sourceRevisions: readonly ProjectionSourceRevision[],
  expiresAt: string | null,
): ProjectionRevisionRecord {
  const generatedAt = "2026-01-01T00:00:00.000Z";
  return {
    projectionRevisionId: revision,
    projectionName: selector.projectionName,
    projectContextId: selector.projectContextId ?? LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
    scopeKind: selector.scopeKind,
    scopeKey: selector.scopeKey,
    revision,
    buildMode: revision === 1 ? "bootstrap" : "incremental",
    sourceRevisions,
    sourceCursors: {},
    sourceFreshness: [],
    contentSha256: "0".repeat(64),
    generatedAt,
    expiresAt,
    supersededAt: null,
    createdAt: generatedAt,
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

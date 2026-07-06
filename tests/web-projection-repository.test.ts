import { describe, expect, it } from "vitest";
import { LEGACY_DEFAULT_PROJECT_CONTEXT_ID } from "../src/core/config/ProjectContexts.js";
import {
  createWebProjectionReadRepositories,
  webHistoryProjectionScopeKey,
  webOrchestratorChatProjectionScopeKey,
  webTranscriptDefaultProjectionScopeKey,
  webTranscriptProjectionScopeKey,
  type WebProjectionPayloadReader,
  type WebTranscriptProjectionDefaultPageSelector,
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
  readonly defaultPageSelectors: WebTranscriptProjectionDefaultPageSelector[] = [];
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

  async readCurrentTranscriptDefaultPayload<TPayload = unknown>(
    selector: WebTranscriptProjectionDefaultPageSelector,
  ): Promise<ProjectionPayloadRecord<TPayload> | null> {
    this.defaultPageSelectors.push({ ...selector });
    const requestedScope = transcriptProjectionScopeParts(selector.scopeKey ?? webTranscriptDefaultProjectionScopeKey(selector));
    if (!requestedScope) return null;
    const record = [...this.records.values()].find((candidate) => {
      if (candidate.revision.projectionName !== "transcript_projection" || candidate.revision.scopeKind !== "run_page") return false;
      const candidateScope = transcriptProjectionScopeParts(candidate.revision.scopeKey);
      return (
        candidateScope !== null &&
        candidateScope.runId === selector.runId &&
        candidateScope.limit === selector.limit &&
        (candidateScope.isTail || candidateScope.offset > 0) &&
        candidateScope.projectContextId === requestedScope.projectContextId
      );
    });
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
    expect(reader.selectors.map(({ projectionName, scopeKind, scopeKey }) => ({ projectionName, scopeKind, scopeKey }))).toEqual([
      { projectionName: "dashboard_projection", scopeKind: "global", scopeKey: "global" },
      { projectionName: "issue_board_projection", scopeKind: "board", scopeKey: "default-board" },
      { projectionName: "sidebar_projection", scopeKind: "global", scopeKey: "global" },
      { projectionName: "history_projection", scopeKind: "global_collection", scopeKey: "global:session:7:timeline:9" },
      { projectionName: "transcript_projection", scopeKind: "run_page", scopeKey: "run-1:offset:10:limit:25" },
      { projectionName: "orchestrator_chat_projection", scopeKind: "conversation", scopeKey: "operator-room" },
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
    expect(missingReader.selectors).toEqual([{ projectionName: "issue_board_projection", scopeKind: "board", scopeKey: "default-board" }]);

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
      { projectionName: "history_projection", scopeKind: "global_collection", scopeKey: "global:session:100:timeline:250" },
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

  it("scopes durable history and transcript reads by project context while preserving legacy default-context fallbacks", async () => {
    const reader = new RecordingWebProjectionPayloadReader([
      projectionPayloadRecordFixture(
        {
          projectionName: "history_projection",
          scopeKind: "global_collection",
          scopeKey: "pc=docs|global:session:7:timeline:9",
        },
        { sessions: [{ id: "docs-session" }], transcriptBySession: {}, timeline: [], defaultSessionId: "docs-session" },
      ),
      projectionPayloadRecordFixture(
        {
          projectionName: "transcript_projection",
          scopeKind: "run_page",
          scopeKey: "pc=docs|shared-run:offset:10:limit:25",
        },
        [{ kind: "assistant", ts: "2026-01-01T00:00:00.000Z", text: "docs transcript" }],
      ),
      projectionPayloadRecordFixture(
        {
          projectionName: "transcript_projection",
          scopeKind: "run_page",
          scopeKey: "pc=default|legacy-scoped-run:offset:0:limit:500",
        },
        [{ kind: "assistant", ts: "2026-01-01T00:00:00.000Z", text: "legacy scoped default transcript" }],
      ),
      projectionPayloadRecordFixture(
        {
          projectionName: "transcript_projection",
          scopeKind: "run_page",
          scopeKey: "pc=default|legacy-scoped-run:offset:500:limit:500",
        },
        [{ kind: "assistant", ts: "2026-01-01T00:00:00.000Z", text: "legacy scoped default tail transcript" }],
      ),
      projectionPayloadRecordFixture(
        {
          projectionName: "transcript_projection",
          scopeKind: "run_page",
          scopeKey: "legacy-run:offset:0:limit:500",
        },
        [{ kind: "assistant", ts: "2026-01-01T00:00:00.000Z", text: "legacy default transcript" }],
      ),
      projectionPayloadRecordFixture(
        {
          projectionName: "transcript_projection",
          scopeKind: "run_page",
          scopeKey: "legacy-run:offset:500:limit:500",
        },
        [{ kind: "assistant", ts: "2026-01-01T00:00:00.000Z", text: "legacy default tail transcript" }],
      ),
    ]);
    const repositories = createWebProjectionReadRepositories({
      reader,
      defaultProjectContextId: "symphony",
      isRecordCurrent: () => true,
    });

    await expect(
      repositories.history.readGlobalCollection({ sessionLimit: 7, timelineLimit: 9, projectContextId: "docs" }),
    ).resolves.toMatchObject({
      status: "hit",
      selector: {
        projectionName: "history_projection",
        scopeKind: "global_collection",
        scopeKey: "pc=docs|global:session:7:timeline:9",
      },
    });

    await expect(
      repositories.transcript.readRunPage({ runId: "shared-run", offset: 10, limit: 25, projectContextId: "docs" }),
    ).resolves.toMatchObject({
      status: "hit",
      selector: {
        projectionName: "transcript_projection",
        scopeKind: "run_page",
        scopeKey: "pc=docs|shared-run:offset:10:limit:25",
      },
    });

    await expect(
      repositories.transcript.readRunPage({ runId: "legacy-scoped-run", offset: 0, limit: 500, projectContextId: "symphony" }),
    ).resolves.toMatchObject({
      status: "hit",
      selector: {
        projectionName: "transcript_projection",
        scopeKind: "run_page",
        scopeKey: "pc=default|legacy-scoped-run:offset:0:limit:500",
      },
    });

    await expect(
      repositories.transcript.readRunDefaultPage({ runId: "legacy-scoped-run", limit: 500, projectContextId: "symphony" }),
    ).resolves.toMatchObject({
      status: "hit",
      selector: {
        projectionName: "transcript_projection",
        scopeKind: "run_page",
        scopeKey: "pc=default|legacy-scoped-run:offset:500:limit:500",
      },
    });

    await expect(
      repositories.transcript.readRunPage({ runId: "legacy-run", offset: 0, limit: 500, projectContextId: "symphony" }),
    ).resolves.toMatchObject({
      status: "hit",
      selector: {
        projectionName: "transcript_projection",
        scopeKind: "run_page",
        scopeKey: "legacy-run:offset:0:limit:500",
      },
    });

    await expect(
      repositories.transcript.readRunDefaultPage({ runId: "legacy-run", limit: 500, projectContextId: "symphony" }),
    ).resolves.toMatchObject({
      status: "hit",
      selector: {
        projectionName: "transcript_projection",
        scopeKind: "run_page",
        scopeKey: "legacy-run:offset:500:limit:500",
      },
    });

    await expect(
      repositories.transcript.readRunPage({ runId: "legacy-scoped-run", offset: 0, limit: 500, projectContextId: "docs" }),
    ).resolves.toMatchObject({
      status: "missing",
      selector: {
        projectionName: "transcript_projection",
        scopeKind: "run_page",
        scopeKey: "pc=docs|legacy-scoped-run:offset:0:limit:500",
      },
    });

    expect(reader.selectors.map(({ projectionName, scopeKind, scopeKey }) => ({ projectionName, scopeKind, scopeKey }))).toEqual([
      { projectionName: "history_projection", scopeKind: "global_collection", scopeKey: "pc=docs|global:session:7:timeline:9" },
      { projectionName: "transcript_projection", scopeKind: "run_page", scopeKey: "pc=docs|shared-run:offset:10:limit:25" },
      { projectionName: "transcript_projection", scopeKind: "run_page", scopeKey: "pc=symphony|legacy-scoped-run:offset:0:limit:500" },
      { projectionName: "transcript_projection", scopeKind: "run_page", scopeKey: "pc=default|legacy-scoped-run:offset:0:limit:500" },
      { projectionName: "transcript_projection", scopeKind: "run_page", scopeKey: "pc=symphony|legacy-run:offset:0:limit:500" },
      { projectionName: "transcript_projection", scopeKind: "run_page", scopeKey: "pc=default|legacy-run:offset:0:limit:500" },
      { projectionName: "transcript_projection", scopeKind: "run_page", scopeKey: "legacy-run:offset:0:limit:500" },
      { projectionName: "transcript_projection", scopeKind: "run_page", scopeKey: "pc=docs|legacy-scoped-run:offset:0:limit:500" },
    ]);
    expect(reader.defaultPageSelectors.map(({ runId, limit, projectContextId }) => ({ runId, limit, projectContextId: projectContextId ?? null }))).toEqual([
      { runId: "legacy-scoped-run", limit: 500, projectContextId: "symphony" },
      { runId: "legacy-scoped-run", limit: 500, projectContextId: "default" },
      { runId: "legacy-run", limit: 500, projectContextId: "symphony" },
      { runId: "legacy-run", limit: 500, projectContextId: "default" },
      { runId: "legacy-run", limit: 500, projectContextId: null },
    ]);
    expect(webHistoryProjectionScopeKey({ sessionLimit: 7, timelineLimit: 9, projectContextId: "docs" })).toBe(
      "pc=docs|global:session:7:timeline:9",
    );
    expect(webTranscriptProjectionScopeKey({ runId: "shared-run", offset: 10, limit: 25, projectContextId: "docs" })).toBe(
      "pc=docs|shared-run:offset:10:limit:25",
    );
    expect(
      webTranscriptDefaultProjectionScopeKey({
        runId: "legacy-run",
        limit: 500,
        projectContextId: "symphony",
        defaultProjectContextId: "symphony",
      }),
    ).toBe("pc=symphony|legacy-run:tail:limit:500");
  });

  it("continues renamed-default compatibility probing past expired and stale candidates to readable legacy rows", async () => {
    const staleScopeKeys = new Set([
      "pc=symphony|global:session:5:timeline:7",
      "pc=symphony|fallback-run:offset:500:limit:500",
    ]);
    const reader = new RecordingWebProjectionPayloadReader([
      projectionPayloadRecordFixture(
        {
          projectionName: "history_projection",
          scopeKind: "global_collection",
          scopeKey: "pc=symphony|global:session:5:timeline:7",
        },
        { sessions: [{ id: "shadowed-session" }], transcriptBySession: {}, timeline: [], defaultSessionId: "shadowed-session" },
      ),
      projectionPayloadRecordFixture(
        {
          projectionName: "history_projection",
          scopeKind: "global_collection",
          scopeKey: "pc=default|global:session:5:timeline:7",
        },
        { sessions: [{ id: "legacy-session" }], transcriptBySession: {}, timeline: [], defaultSessionId: "legacy-session" },
      ),
      projectionPayloadRecordFixture(
        {
          projectionName: "transcript_projection",
          scopeKind: "run_page",
          scopeKey: "pc=symphony|shadowed-run:offset:0:limit:500",
        },
        [{ kind: "assistant", ts: "2026-01-01T00:00:00.000Z", text: "expired current-default transcript" }],
        { expiresAt: "2000-01-01T00:00:00.000Z" },
      ),
      projectionPayloadRecordFixture(
        {
          projectionName: "transcript_projection",
          scopeKind: "run_page",
          scopeKey: "pc=default|shadowed-run:offset:0:limit:500",
        },
        [{ kind: "assistant", ts: "2026-01-01T00:00:00.000Z", text: "legacy scoped transcript" }],
      ),
      projectionPayloadRecordFixture(
        {
          projectionName: "transcript_projection",
          scopeKind: "run_page",
          scopeKey: "pc=symphony|fallback-run:offset:500:limit:500",
        },
        [{ kind: "assistant", ts: "2026-01-01T00:00:00.000Z", text: "stale current-default tail transcript" }],
      ),
      projectionPayloadRecordFixture(
        {
          projectionName: "transcript_projection",
          scopeKind: "run_page",
          scopeKey: "fallback-run:offset:500:limit:500",
        },
        [{ kind: "assistant", ts: "2026-01-01T00:00:00.000Z", text: "legacy unscoped tail transcript" }],
      ),
    ]);
    const repositories = createWebProjectionReadRepositories({
      reader,
      defaultProjectContextId: "symphony",
      isRecordCurrent: (record) => !staleScopeKeys.has(record.revision.scopeKey),
    });

    await expect(
      repositories.history.readGlobalCollection({ sessionLimit: 5, timelineLimit: 7, projectContextId: "symphony" }),
    ).resolves.toMatchObject({
      status: "hit",
      selector: {
        projectionName: "history_projection",
        scopeKind: "global_collection",
        scopeKey: "pc=default|global:session:5:timeline:7",
      },
      record: { payload: { defaultSessionId: "legacy-session" } },
    });

    await expect(
      repositories.transcript.readRunPage({ runId: "shadowed-run", offset: 0, limit: 500, projectContextId: "symphony" }),
    ).resolves.toMatchObject({
      status: "hit",
      selector: {
        projectionName: "transcript_projection",
        scopeKind: "run_page",
        scopeKey: "pc=default|shadowed-run:offset:0:limit:500",
      },
      record: { payload: [{ text: "legacy scoped transcript" }] },
    });

    await expect(
      repositories.transcript.readRunDefaultPage({ runId: "fallback-run", limit: 500, projectContextId: "symphony" }),
    ).resolves.toMatchObject({
      status: "hit",
      selector: {
        projectionName: "transcript_projection",
        scopeKind: "run_page",
        scopeKey: "fallback-run:offset:500:limit:500",
      },
      record: { payload: [{ text: "legacy unscoped tail transcript" }] },
    });

    expect(reader.selectors.map(({ projectionName, scopeKind, scopeKey }) => ({ projectionName, scopeKind, scopeKey }))).toEqual([
      { projectionName: "history_projection", scopeKind: "global_collection", scopeKey: "pc=symphony|global:session:5:timeline:7" },
      { projectionName: "history_projection", scopeKind: "global_collection", scopeKey: "pc=default|global:session:5:timeline:7" },
      { projectionName: "transcript_projection", scopeKind: "run_page", scopeKey: "pc=symphony|shadowed-run:offset:0:limit:500" },
      { projectionName: "transcript_projection", scopeKind: "run_page", scopeKey: "pc=default|shadowed-run:offset:0:limit:500" },
    ]);
    expect(reader.defaultPageSelectors.map(({ runId, limit, projectContextId }) => ({ runId, limit, projectContextId: projectContextId ?? null }))).toEqual([
      { runId: "fallback-run", limit: 500, projectContextId: "symphony" },
      { runId: "fallback-run", limit: 500, projectContextId: "default" },
      { runId: "fallback-run", limit: 500, projectContextId: null },
    ]);
  });
});

function projectionSelectorKey(selector: ProjectionRevisionSelector): string {
  return [selector.projectionName, selector.scopeKind ?? "global", selector.scopeKey ?? "global"].join(":");
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

function transcriptProjectionScopeParts(
  scopeKey: string,
): { projectContextId: string | null; runId: string; limit: number; isTail: boolean; offset: number } | null {
  const scopedMatch = /^pc=([^|]+)\|(.*)$/.exec(scopeKey);
  const projectContextId = scopedMatch?.[1] ?? null;
  const unscopedKey = scopedMatch?.[2] ?? scopeKey;
  const match = /^(.*):(offset:\d+|tail):limit:(\d+)$/.exec(unscopedKey);
  if (!match) return null;
  const pageKind = match[2] ?? "";
  return {
    projectContextId,
    runId: match[1] ?? "",
    limit: Number(match[3]),
    isTail: pageKind === "tail",
    offset: pageKind === "tail" ? Number.MAX_SAFE_INTEGER : Number(pageKind.slice("offset:".length)),
  };
}

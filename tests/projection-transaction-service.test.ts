import { describe, expect, it } from "vitest";
import { createWebProjectionReadRepositories } from "../src/app/WebProjectionRepository.js";
import { LEGACY_DEFAULT_PROJECT_CONTEXT_ID } from "../src/core/config/ProjectContexts.js";
import {
  PostgresProjectionTransactionStore,
  ProjectionTransactionService,
  type DurableProjectionName,
  type NormalizedProjectionRevisionSelector,
  type ProjectionPayloadInsertInput,
  type ProjectionPayloadRecord,
  type ProjectionRevisionInsertInput,
  type ProjectionRevisionRecord,
  type ProjectionRevisionSelector,
  type ProjectionSourceRevision,
  type ProjectionSqlQueryResult,
  type ProjectionSqlQueryRunner,
  type ProjectionTransactionRevisionPort,
  type ProjectionTransactionStore,
} from "../src/core/persistence/ProjectionTransactionService.js";

const fixedTime = "2026-01-02T03:04:05.000Z";
const defaultsByProjectionName: Record<DurableProjectionName, string> = {
  dashboard_projection: "global",
  issue_board_projection: "default-board",
  sidebar_projection: "global",
  history_projection: "global",
  transcript_projection: "global",
  orchestrator_chat_projection: "global",
};

describe("ProjectionTransactionService", () => {
  it("writes a durable revision once for repeated canonical inputs and publishes matching revision metadata", async () => {
    const store = new InMemoryProjectionTransactionStore();
    const service = new ProjectionTransactionService(store, { clock: () => new Date(fixedTime) });
    const publications: ProjectionSourceRevision[] = [];
    const provider = service.createRevisionProvider({ projectionName: "issue_board_projection" });
    const unsubscribe = provider.subscribe((revision) => publications.push(revision));

    const first = await service.writeProjection({
      projectionName: "issue_board_projection",
      payload: { b: 2, a: 1 },
      sourceRevisions: [
        { source: "runs", revision: 2 },
        { source: "linear", revision: "10", observedAt: fixedTime },
      ],
      sourceCursors: { z: "cursor", a: 1 },
      sourceFreshness: [
        {
          source: "linear",
          status: "stale",
          checkedAt: fixedTime,
          revision: "10",
          lastSuccessAt: "2026-01-02T03:03:05.000Z",
          staleMs: 60_000,
          detail: "Linear import is outside the freshness SLA",
        },
      ],
      fields: { fetchedStates: [{ id: "started" }] },
    });
    const repeated = await service.writeProjection({
      projectionName: "issue_board_projection",
      payload: { a: 1, b: 2 },
      sourceRevisions: [
        { source: "linear", revision: "10", observedAt: fixedTime },
        { source: "runs", revision: 2 },
      ],
      sourceCursors: { a: 1, z: "cursor" },
      sourceFreshness: [
        {
          source: "linear",
          status: "stale",
          checkedAt: fixedTime,
          revision: "10",
          lastSuccessAt: "2026-01-02T03:03:05.000Z",
          staleMs: 60_000,
          detail: "Linear import is outside the freshness SLA",
        },
      ],
      fields: { fetchedStates: [{ id: "started" }] },
    });

    expect(first.status).toBe("written");
    expect(first.revision.revision).toBe(1);
    expect(first.requestedBuildMode).toBe("incremental");
    expect(first.buildMode).toBe("bootstrap");
    expect(first.revision.buildMode).toBe("bootstrap");
    expect(repeated.status).toBe("unchanged");
    expect(repeated.revision.revision).toBe(1);
    expect(repeated.requestedBuildMode).toBe("incremental");
    expect(repeated.buildMode).toBe("bootstrap");
    expect(repeated.revision.projectionRevisionId).toBe(first.revision.projectionRevisionId);
    expect(repeated.revision.contentSha256).toBe(first.revision.contentSha256);
    expect(store.revisions()).toHaveLength(1);
    expect(store.payloadWrites()).toHaveLength(1);
    expect(first.revision.sourceFreshness).toEqual([
      {
        source: "linear",
        status: "stale",
        checkedAt: fixedTime,
        revision: "10",
        lastSuccessAt: "2026-01-02T03:03:05.000Z",
        lastErrorAt: null,
        staleMs: 60_000,
        detail: "Linear import is outside the freshness SLA",
      },
      {
        source: "runs",
        status: "fresh",
        checkedAt: fixedTime,
        revision: 2,
        lastSuccessAt: fixedTime,
        lastErrorAt: null,
        staleMs: null,
        detail: "runs source revision 2 observed",
      },
    ]);
    expect(first.revision.sourceCursors.sourceFreshness).toEqual(first.revision.sourceFreshness);

    expect(publications).toEqual([
      {
        source: `issue_board_projection:${LEGACY_DEFAULT_PROJECT_CONTEXT_ID}:global:default-board`,
        revision: 1,
        observedAt: fixedTime,
      },
    ]);
    await expect(provider.getRevision()).resolves.toEqual({
      source: `issue_board_projection:${LEGACY_DEFAULT_PROJECT_CONTEXT_ID}:global:default-board`,
      revision: 1,
      observedAt: fixedTime,
    });

    unsubscribe();
  });

  it("isolates identical projection scopes by project context while persisting context metadata", async () => {
    const store = new InMemoryProjectionTransactionStore();
    const service = new ProjectionTransactionService(store, { clock: () => new Date(fixedTime) });

    const docs = await service.writeProjection({
      projectionName: "transcript_projection",
      projectContextId: "docs",
      scopeKind: "run_page",
      scopeKey: "run-1:offset:0:limit:500",
      payload: { messages: [{ text: "docs" }] },
      fields: { runId: "run-1", offsetStart: 0, offsetLimit: 500, messageCount: 1 },
    });
    const api = await service.writeProjection({
      projectionName: "transcript_projection",
      projectContextId: "api",
      scopeKind: "run_page",
      scopeKey: "run-1:offset:0:limit:500",
      payload: { messages: [{ text: "api" }] },
      fields: { runId: "run-1", offsetStart: 0, offsetLimit: 500, messageCount: 1 },
    });

    expect(docs.revision.revision).toBe(1);
    expect(api.revision.revision).toBe(1);
    expect(docs.revision.projectContextId).toBe("docs");
    expect(api.revision.projectContextId).toBe("api");
    expect(store.payloadWrites().map((write) => [write.projectContextId, write.scopeKey, write.revision])).toEqual([
      ["docs", "run-1:offset:0:limit:500", 1],
      ["api", "run-1:offset:0:limit:500", 1],
    ]);
    await expect(
      service.readCurrentRevision({
        projectionName: "transcript_projection",
        projectContextId: "docs",
        scopeKind: "run_page",
        scopeKey: "run-1:offset:0:limit:500",
      }),
    ).resolves.toMatchObject({ projectContextId: "docs", revision: 1 });
    await expect(
      service.readCurrentRevision({
        projectionName: "transcript_projection",
        projectContextId: "api",
        scopeKind: "run_page",
        scopeKey: "run-1:offset:0:limit:500",
      }),
    ).resolves.toMatchObject({ projectContextId: "api", revision: 1 });
  });

  it("normalizes omitted and blank selector project context ids to the legacy default scope", async () => {
    const store = new InMemoryProjectionTransactionStore();
    const service = new ProjectionTransactionService(store, { clock: () => new Date(fixedTime) });

    await service.writeProjection({
      projectionName: "dashboard_projection",
      projectContextId: LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
      payload: { totals: { open: 1 } },
    });

    await expect(service.readCurrentRevision({ projectionName: "dashboard_projection" })).resolves.toMatchObject({
      projectContextId: LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
      revision: 1,
    });
    await expect(
      service.readCurrentRevision({ projectionName: "dashboard_projection", projectContextId: "   " }),
    ).resolves.toMatchObject({
      projectContextId: LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
      revision: 1,
    });
  });

  it("reads scoped history and transcript web projections through store-backed project-context partitions", async () => {
    const store = new InMemoryProjectionTransactionStore();
    const service = new ProjectionTransactionService(store, { clock: () => new Date(fixedTime) });
    const repositories = createWebProjectionReadRepositories({
      reader: service,
      defaultProjectContextId: "symphony",
      isRecordCurrent: () => true,
    });

    await service.writeProjection({
      projectionName: "history_projection",
      projectContextId: "docs",
      scopeKind: "global_collection",
      scopeKey: "pc=docs|global:session:7:timeline:9",
      payload: { sessions: [{ id: "docs-session" }], transcriptBySession: {}, timeline: [], defaultSessionId: "docs-session" },
    });
    await service.writeProjection({
      projectionName: "history_projection",
      projectContextId: "api",
      scopeKind: "global_collection",
      scopeKey: "pc=api|global:session:7:timeline:9",
      payload: { sessions: [{ id: "api-session" }], transcriptBySession: {}, timeline: [], defaultSessionId: "api-session" },
    });
    await service.writeProjection({
      projectionName: "transcript_projection",
      projectContextId: "docs",
      scopeKind: "run_page",
      scopeKey: "pc=docs|shared-run:offset:10:limit:25",
      payload: [{ text: "docs page" }],
      fields: { runId: "shared-run", offsetStart: 10, offsetLimit: 25, nextOffset: 35, messageCount: 1 },
    });
    await service.writeProjection({
      projectionName: "transcript_projection",
      projectContextId: "api",
      scopeKind: "run_page",
      scopeKey: "pc=api|shared-run:offset:10:limit:25",
      payload: [{ text: "api page" }],
      fields: { runId: "shared-run", offsetStart: 10, offsetLimit: 25, nextOffset: 35, messageCount: 1 },
    });
    await service.writeProjection({
      projectionName: "transcript_projection",
      projectContextId: "docs",
      scopeKind: "run_page",
      scopeKey: "pc=docs|shared-run:offset:500:limit:500",
      payload: [{ text: "docs tail" }],
      fields: { runId: "shared-run", offsetStart: 500, offsetLimit: 500, nextOffset: null, messageCount: 1 },
    });
    await service.writeProjection({
      projectionName: "transcript_projection",
      projectContextId: "api",
      scopeKind: "run_page",
      scopeKey: "pc=api|shared-run:offset:500:limit:500",
      payload: [{ text: "api tail" }],
      fields: { runId: "shared-run", offsetStart: 500, offsetLimit: 500, nextOffset: null, messageCount: 1 },
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
      record: {
        revision: { projectContextId: "docs" },
        payload: { defaultSessionId: "docs-session" },
      },
    });
    await expect(
      repositories.history.readGlobalCollection({ sessionLimit: 7, timelineLimit: 9, projectContextId: "api" }),
    ).resolves.toMatchObject({
      status: "hit",
      selector: {
        projectionName: "history_projection",
        scopeKind: "global_collection",
        scopeKey: "pc=api|global:session:7:timeline:9",
      },
      record: {
        revision: { projectContextId: "api" },
        payload: { defaultSessionId: "api-session" },
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
      record: {
        revision: { projectContextId: "docs" },
        payload: [{ text: "docs page" }],
      },
    });
    await expect(
      repositories.transcript.readRunPage({ runId: "shared-run", offset: 10, limit: 25, projectContextId: "api" }),
    ).resolves.toMatchObject({
      status: "hit",
      selector: {
        projectionName: "transcript_projection",
        scopeKind: "run_page",
        scopeKey: "pc=api|shared-run:offset:10:limit:25",
      },
      record: {
        revision: { projectContextId: "api" },
        payload: [{ text: "api page" }],
      },
    });
    await expect(
      repositories.transcript.readRunDefaultPage({ runId: "shared-run", limit: 500, projectContextId: "docs" }),
    ).resolves.toMatchObject({
      status: "hit",
      selector: {
        projectionName: "transcript_projection",
        scopeKind: "run_page",
        scopeKey: "pc=docs|shared-run:offset:500:limit:500",
      },
      record: {
        revision: { projectContextId: "docs" },
        payload: [{ text: "docs tail" }],
      },
    });
    await expect(
      repositories.transcript.readRunDefaultPage({ runId: "shared-run", limit: 500, projectContextId: "api" }),
    ).resolves.toMatchObject({
      status: "hit",
      selector: {
        projectionName: "transcript_projection",
        scopeKind: "run_page",
        scopeKey: "pc=api|shared-run:offset:500:limit:500",
      },
      record: {
        revision: { projectContextId: "api" },
        payload: [{ text: "api tail" }],
      },
    });
  });

  it("records bootstrap, incremental, and rebuild modes without treating mode-only changes as new content", async () => {
    const store = new InMemoryProjectionTransactionStore();
    const service = new ProjectionTransactionService(store, { clock: () => new Date(fixedTime) });
    const publications: unknown[] = [];
    service.onProjectionChanged((event) => publications.push(event));

    const bootstrap = await service.writeProjection({
      projectionName: "history_projection",
      payload: { sessions: [] },
      buildMode: "rebuild",
    });
    const unchangedRebuild = await service.writeProjection({
      projectionName: "history_projection",
      payload: { sessions: [] },
      buildMode: "rebuild",
    });
    const incremental = await service.writeProjection({
      projectionName: "history_projection",
      payload: { sessions: [{ id: "session-1" }] },
      buildMode: "incremental",
    });
    const rebuild = await service.writeProjection({
      projectionName: "history_projection",
      payload: { sessions: [{ id: "session-1" }, { id: "session-2" }] },
      buildMode: "rebuild",
    });

    expect(bootstrap).toMatchObject({ status: "written", requestedBuildMode: "rebuild", buildMode: "bootstrap" });
    expect(unchangedRebuild).toMatchObject({ status: "unchanged", requestedBuildMode: "rebuild", buildMode: "bootstrap" });
    expect(incremental).toMatchObject({ status: "written", requestedBuildMode: "incremental", buildMode: "incremental" });
    expect(rebuild).toMatchObject({ status: "written", requestedBuildMode: "rebuild", buildMode: "rebuild" });
    expect(store.revisions().map((revision) => [revision.revision, revision.buildMode])).toEqual([
      [1, "bootstrap"],
      [2, "incremental"],
      [3, "rebuild"],
    ]);
    expect(publications.map((event) => (event as { buildMode?: string }).buildMode)).toEqual([
      "bootstrap",
      "incremental",
      "rebuild",
    ]);
  });

  it("derives non-success freshness from tracker failure source revisions without misclassifying run statuses", async () => {
    const store = new InMemoryProjectionTransactionStore();
    const service = new ProjectionTransactionService(store, { clock: () => new Date(fixedTime) });

    const trackerError = await service.writeProjection({
      projectionName: "issue_board_projection",
      payload: { issues: [] },
      sourceRevisions: [
        { source: "trackerIssues", revision: "error:Todo:0:none" },
        { source: "runs", revision: "failed:run-1", observedAt: fixedTime },
      ],
    });
    const trackerUnavailable = await service.writeProjection({
      projectionName: "dashboard_projection",
      payload: { totals: {} },
      sourceRevisions: [{ source: "trackerIssues", revision: "unavailable:Todo:0:none" }],
    });
    const trackerEmptySuccess = await service.writeProjection({
      projectionName: "sidebar_projection",
      payload: { reviewIssues: [] },
      sourceRevisions: [{ source: "trackerIssues", revision: "ok:Todo:0:none", observedAt: fixedTime }],
    });

    const errorFreshness = trackerError.revision.sourceFreshness.find((record) => record.source === "trackerIssues");
    expect(errorFreshness).toMatchObject({
      source: "trackerIssues",
      status: "error",
      checkedAt: fixedTime,
      revision: "error:Todo:0:none",
      lastSuccessAt: null,
      lastErrorAt: fixedTime,
      staleMs: null,
      detail: "trackerIssues source reported an error (error:Todo:0:none)",
    });
    expect(trackerError.revision.sourceFreshness.find((record) => record.source === "runs")).toMatchObject({
      source: "runs",
      status: "fresh",
      revision: "failed:run-1",
      lastSuccessAt: fixedTime,
      lastErrorAt: null,
    });
    expect(trackerUnavailable.revision.sourceFreshness).toContainEqual({
      source: "trackerIssues",
      status: "error",
      checkedAt: fixedTime,
      revision: "unavailable:Todo:0:none",
      lastSuccessAt: null,
      lastErrorAt: fixedTime,
      staleMs: null,
      detail: "trackerIssues source is unavailable (unavailable:Todo:0:none)",
    });
    expect(trackerEmptySuccess.revision.sourceFreshness).toContainEqual({
      source: "trackerIssues",
      status: "empty",
      checkedAt: fixedTime,
      revision: "ok:Todo:0:none",
      lastSuccessAt: fixedTime,
      lastErrorAt: null,
      staleMs: null,
      detail: "trackerIssues source is empty",
    });
  });

  it("normalizes, persists, and publishes freshness statuses for independent projection sources", async () => {
    const store = new InMemoryProjectionTransactionStore();
    const service = new ProjectionTransactionService(store, { clock: () => new Date(fixedTime) });
    const publications: unknown[] = [];
    service.onProjectionChanged((event) => publications.push(event));

    const expectedSourceFreshness = [
      {
        source: "github",
        status: "stale",
        checkedAt: fixedTime,
        revision: "gh-55",
        lastSuccessAt: "2026-01-02T03:00:05.000Z",
        lastErrorAt: null,
        staleMs: 240_000,
        detail: "GitHub webhook cursor is behind",
      },
      {
        source: "harness",
        status: "error",
        checkedAt: fixedTime,
        revision: "harness-run-7",
        lastSuccessAt: null,
        lastErrorAt: fixedTime,
        staleMs: null,
        detail: "Harness transcript ingest failed",
      },
      {
        source: "linear",
        status: "fresh",
        checkedAt: fixedTime,
        revision: "lin-42",
        lastSuccessAt: fixedTime,
        lastErrorAt: null,
        staleMs: null,
        detail: "Linear import is current",
      },
      {
        source: "local",
        status: "never_synced",
        checkedAt: fixedTime,
        revision: null,
        lastSuccessAt: null,
        lastErrorAt: null,
        staleMs: null,
        detail: "Local workspace snapshot has not run",
      },
      {
        source: "runs",
        status: "loading",
        checkedAt: fixedTime,
        revision: null,
        lastSuccessAt: null,
        lastErrorAt: null,
        staleMs: null,
        detail: "Run projection is still loading",
      },
      {
        source: "workspaces",
        status: "empty",
        checkedAt: fixedTime,
        revision: 0,
        lastSuccessAt: fixedTime,
        lastErrorAt: null,
        staleMs: null,
        detail: "No workspace rows are available yet",
      },
    ];

    const first = await service.writeProjection({
      projectionName: "dashboard_projection",
      payload: { agents: [] },
      sourceRevisions: [
        { source: "linear", revision: "lin-42", observedAt: fixedTime },
        { source: "github", revision: "gh-55", observedAt: fixedTime },
        { source: "harness", revision: "harness-run-7", observedAt: fixedTime },
        { source: "local", revision: "local-snapshot-0", observedAt: null },
      ],
      sourceFreshness: [
        {
          source: "linear",
          status: "fresh",
          revision: "lin-42",
          detail: "Linear import is current",
        },
        {
          source: "github",
          status: "stale",
          revision: "gh-55",
          lastSuccessAt: "2026-01-02T03:00:05.000Z",
          detail: "GitHub webhook cursor is behind",
        },
        {
          source: "harness",
          status: "failed",
          revision: "harness-run-7",
          detail: "Harness transcript ingest failed",
        },
        {
          source: "local",
          status: "never-synced",
          detail: "Local workspace snapshot has not run",
        },
        {
          source: "runs",
          status: "pending",
          detail: "Run projection is still loading",
        },
        {
          source: "workspaces",
          status: "empty",
          revision: 0,
          detail: "No workspace rows are available yet",
        },
      ],
    });
    const repeated = await service.writeProjection({
      projectionName: "dashboard_projection",
      payload: { agents: [] },
      sourceRevisions: [
        { source: "github", revision: "gh-55", observedAt: fixedTime },
        { source: "harness", revision: "harness-run-7", observedAt: fixedTime },
        { source: "linear", revision: "lin-42", observedAt: fixedTime },
        { source: "local", revision: "local-snapshot-0", observedAt: null },
      ],
      sourceFreshness: [
        {
          source: "github",
          status: "stale",
          revision: "gh-55",
          lastSuccessAt: "2026-01-02T03:00:05.000Z",
          detail: "GitHub webhook cursor is behind",
        },
        {
          source: "harness",
          status: "error",
          revision: "harness-run-7",
          detail: "Harness transcript ingest failed",
        },
        {
          source: "linear",
          status: "fresh",
          revision: "lin-42",
          detail: "Linear import is current",
        },
        {
          source: "local",
          status: "never_synced",
          detail: "Local workspace snapshot has not run",
        },
        {
          source: "runs",
          status: "loading",
          detail: "Run projection is still loading",
        },
        {
          source: "workspaces",
          status: "empty",
          revision: 0,
          detail: "No workspace rows are available yet",
        },
      ],
    });
    const current = await service.readCurrentRevision({ projectionName: "dashboard_projection" });

    expect(first.status).toBe("written");
    expect(repeated.status).toBe("unchanged");
    expect(repeated.revision.projectionRevisionId).toBe(first.revision.projectionRevisionId);
    expect(store.revisions()).toHaveLength(1);
    expect(first.revision.sourceFreshness).toEqual(expectedSourceFreshness);
    expect(first.revision.sourceCursors.sourceFreshness).toEqual(expectedSourceFreshness);
    expect(current?.sourceFreshness).toEqual(expectedSourceFreshness);
    expect(publications).toHaveLength(1);
    expect((publications[0] as { sourceFreshness?: unknown }).sourceFreshness).toEqual(expectedSourceFreshness);
  });

  it("keeps revisions monotonic across service instances and concurrent updates", async () => {
    const store = new InMemoryProjectionTransactionStore();
    const firstProcess = new ProjectionTransactionService(store, { clock: () => new Date(fixedTime) });
    const first = await firstProcess.writeProjection({
      projectionName: "sidebar_projection",
      payload: { value: "initial" },
    });

    const restartedProcess = new ProjectionTransactionService(store, { clock: () => new Date(fixedTime) });
    const concurrentResults = await Promise.all(
      ["second", "third", "fourth", "fifth"].map((value) =>
        restartedProcess.writeProjection({
          projectionName: "sidebar_projection",
          payload: { value },
        }),
      ),
    );
    const current = await restartedProcess.readCurrentRevision({ projectionName: "sidebar_projection" });

    expect(first.revision.revision).toBe(1);
    expect(concurrentResults.map((result) => result.revision.revision).sort((left, right) => left - right)).toEqual([2, 3, 4, 5]);
    expect(current?.revision).toBe(5);
    expect(store.revisions().map((revision) => revision.revision)).toEqual([1, 2, 3, 4, 5]);
  });

  it("rolls back revision metadata, payload writes, and publication when the payload write fails", async () => {
    const store = new InMemoryProjectionTransactionStore();
    const service = new ProjectionTransactionService(store, { clock: () => new Date(fixedTime) });
    const publications: unknown[] = [];
    service.onProjectionChanged((event) => publications.push(event));
    store.failNextPayloadWrite();

    await expect(
      service.writeProjection({
        projectionName: "dashboard_projection",
        payload: { broken: true },
      }),
    ).rejects.toThrow("simulated payload write failure");

    expect(store.revisions()).toEqual([]);
    expect(store.payloadWrites()).toEqual([]);
    expect(publications).toEqual([]);

    const recovery = await service.writeProjection({
      projectionName: "dashboard_projection",
      payload: { broken: false },
    });
    expect(recovery.status).toBe("written");
    expect(recovery.revision.revision).toBe(1);
    expect(store.payloadWrites()).toHaveLength(1);
  });

  it("uses one Postgres transaction for revision and payload inserts", async () => {
    const runner = new RecordingProjectionSqlRunner();
    const service = new ProjectionTransactionService(new PostgresProjectionTransactionStore(runner), { clock: () => new Date(fixedTime) });

    const result = await service.writeProjection({
      projectionName: "transcript_projection",
      scopeKey: "run-1",
      payload: { messages: [] },
      fields: {
        runId: "run-1",
        sessionId: "session-1",
        offsetStart: 0,
        offsetLimit: 50,
        messageCount: 0,
      },
    });

    const revisionInsertIndex = runner.sqls.findIndex((sql) => sql.includes('INSERT INTO "symphony"."projection_revision"'));
    const payloadInsertIndex = runner.sqls.findIndex((sql) => sql.includes('INSERT INTO "symphony"."transcript_projection"'));
    expect(result.status).toBe("written");
    expect(runner.sqls[0]).toBe("BEGIN");
    expect(revisionInsertIndex).toBeGreaterThan(-1);
    expect(payloadInsertIndex).toBeGreaterThan(revisionInsertIndex);
    expect(runner.sqls.at(-1)).toBe("COMMIT");
    expect(runner.sqls).not.toContain("ROLLBACK");
  });

  it("reads the current Postgres projection payload with its revision metadata", async () => {
    const runner = new RecordingProjectionSqlRunner({
      currentPayloadRow: {
        projection_revision_id: 42,
        projection_name: "dashboard_projection",
        project_context_id: LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
        scope_kind: "global",
        scope_key: "global",
        revision: 3,
        build_mode: "rebuild",
        source_revisions: [{ source: "runs", revision: "run-revision-3", observedAt: null }],
        source_cursors: { runCount: 2 },
        content_sha256: "a".repeat(64),
        generated_at: "2026-01-02T03:04:05.000Z",
        expires_at: null,
        superseded_at: null,
        created_at: "2026-01-02T03:04:05.000Z",
        payload: { projectName: "Durable Symphony" },
        payload_sha256: "b".repeat(64),
        raw_payload_refs: [{ table: "run_activity" }],
        payload_generated_at: "2026-01-02T03:04:06.000Z",
        payload_expires_at: null,
      },
    });
    const service = new ProjectionTransactionService(new PostgresProjectionTransactionStore(runner), { clock: () => new Date(fixedTime) });

    const payload = await service.readCurrentPayload<{ projectName: string }>({ projectionName: "dashboard_projection" });

    expect(payload).toEqual<ProjectionPayloadRecord<{ projectName: string }> | null>({
      revision: {
        projectionRevisionId: 42,
        projectionName: "dashboard_projection",
        projectContextId: LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
        scopeKind: "global",
        scopeKey: "global",
        revision: 3,
        buildMode: "rebuild",
        sourceRevisions: [{ source: "runs", revision: "run-revision-3", observedAt: null }],
        sourceCursors: { runCount: 2 },
        sourceFreshness: [
          {
            source: "runs",
            status: "fresh",
            checkedAt: "2026-01-02T03:04:05.000Z",
            revision: "run-revision-3",
            lastSuccessAt: "2026-01-02T03:04:05.000Z",
            lastErrorAt: null,
            staleMs: null,
            detail: "runs source revision run-revision-3 observed",
          },
        ],
        contentSha256: "a".repeat(64),
        generatedAt: "2026-01-02T03:04:05.000Z",
        expiresAt: null,
        supersededAt: null,
        createdAt: "2026-01-02T03:04:05.000Z",
      },
      payload: { projectName: "Durable Symphony" },
      payloadSha256: "b".repeat(64),
      rawPayloadRefs: [{ table: "run_activity" }],
      generatedAt: "2026-01-02T03:04:06.000Z",
      expiresAt: null,
    });
    expect(runner.values[0]).toEqual([LEGACY_DEFAULT_PROJECT_CONTEXT_ID, "dashboard_projection", "global", "global"]);
    expect(runner.sqls[0]).toContain('FROM "symphony"."projection_revision" revision JOIN "symphony"."dashboard_projection" payload');
    expect(runner.sqls[0]).toContain("revision.superseded_at IS NULL");
  });

  it("reads the current Postgres transcript default page by run id, bounded tail limit, and scope-key compatibility", async () => {
    const runner = new RecordingProjectionSqlRunner({
      currentPayloadRow: {
        projection_revision_id: 43,
        projection_name: "transcript_projection",
        project_context_id: LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
        scope_kind: "run_page",
        scope_key: "run-1:offset:700:limit:500",
        revision: 4,
        source_revisions: [{ source: "transcript:run-1", revision: "events-1200", observedAt: null }],
        source_cursors: { eventCount: 500, nextOffset: null },
        content_sha256: "c".repeat(64),
        generated_at: "2026-01-02T03:04:05.000Z",
        expires_at: null,
        superseded_at: null,
        created_at: "2026-01-02T03:04:05.000Z",
        payload: [{ text: "tail event 701" }, { text: "tail event 1200" }],
        payload_sha256: "d".repeat(64),
        raw_payload_refs: [],
        payload_generated_at: "2026-01-02T03:04:07.000Z",
        payload_expires_at: null,
      },
    });
    const service = new ProjectionTransactionService(new PostgresProjectionTransactionStore(runner), { clock: () => new Date(fixedTime) });

    const payload = await service.readCurrentTranscriptDefaultPayload<readonly { text: string }[]>({ runId: "run-1", limit: 500 });

    expect(payload?.revision.projectContextId).toBe(LEGACY_DEFAULT_PROJECT_CONTEXT_ID);
    expect(payload?.revision.scopeKey).toBe("run-1:offset:700:limit:500");
    expect(payload?.payload).toEqual([{ text: "tail event 701" }, { text: "tail event 1200" }]);
    expect(runner.values[0]).toEqual(["run-1", 500, null]);
    expect(runner.sqls[0]).toContain('JOIN "symphony"."transcript_projection" payload');
    expect(runner.sqls[0]).toContain("payload.run_id = $1");
    expect(runner.sqls[0]).toContain("payload.offset_limit = $2");
    expect(runner.sqls[0]).toContain("$3::text IS NULL AND revision.scope_key NOT LIKE 'pc=%|%'");
    expect(runner.sqls[0]).toContain("ORDER BY (payload.next_offset IS NULL) DESC, payload.message_count DESC, payload.offset_start DESC");
  });

  it("reads the current Postgres transcript default page by scoped project context when overlapping run ids share a tail limit", async () => {
    const runner = new RecordingProjectionSqlRunner({
      currentPayloadRow: {
        projection_revision_id: 44,
        projection_name: "transcript_projection",
        project_context_id: "docs",
        scope_kind: "run_page",
        scope_key: "pc=docs|run-1:offset:700:limit:500",
        revision: 5,
        source_revisions: [{ source: "transcript:run-1", revision: "events-docs-1200", observedAt: null }],
        source_cursors: { eventCount: 500, nextOffset: null },
        content_sha256: "e".repeat(64),
        generated_at: "2026-01-02T03:04:05.000Z",
        expires_at: null,
        superseded_at: null,
        created_at: "2026-01-02T03:04:05.000Z",
        payload: [{ text: "docs tail event 701" }, { text: "docs tail event 1200" }],
        payload_sha256: "f".repeat(64),
        raw_payload_refs: [],
        payload_generated_at: "2026-01-02T03:04:07.000Z",
        payload_expires_at: null,
      },
    });
    const service = new ProjectionTransactionService(new PostgresProjectionTransactionStore(runner), { clock: () => new Date(fixedTime) });

    const payload = await service.readCurrentTranscriptDefaultPayload<readonly { text: string }[]>({
      runId: "run-1",
      limit: 500,
      projectContextId: "docs",
    });

    expect(payload?.revision.projectContextId).toBe("docs");
    expect(payload?.revision.scopeKey).toBe("pc=docs|run-1:offset:700:limit:500");
    expect(payload?.payload).toEqual([{ text: "docs tail event 701" }, { text: "docs tail event 1200" }]);
    expect(runner.values[0]).toEqual(["run-1", 500, "docs"]);
    expect(runner.sqls[0]).toContain("$3::text IS NOT NULL AND revision.scope_key LIKE ('pc=' || $3 || '|%')");
  });

  it("rolls back the Postgres transaction and suppresses publication on payload insert failure", async () => {
    const runner = new RecordingProjectionSqlRunner({ failPayloadInsert: true });
    const service = new ProjectionTransactionService(new PostgresProjectionTransactionStore(runner), { clock: () => new Date(fixedTime) });
    const publications: unknown[] = [];
    service.onProjectionChanged((event) => publications.push(event));

    await expect(
      service.writeProjection({
        projectionName: "history_projection",
        payload: { rows: [] },
        fields: { runId: "run-1", sessionId: "session-1", issueKey: "ENG-201" },
      }),
    ).rejects.toThrow("simulated postgres payload failure");

    expect(runner.sqls).toContain("ROLLBACK");
    expect(runner.sqls).not.toContain("COMMIT");
    expect(publications).toEqual([]);
  });
});

class InMemoryProjectionTransactionStore implements ProjectionTransactionStore {
  private revisionRecords: ProjectionRevisionRecord[] = [];
  private payloadRecords: ProjectionPayloadInsertInput[] = [];
  private nextProjectionRevisionId = 1;
  private queuedTransaction: Promise<void> = Promise.resolve();
  private payloadFailure: Error | null = null;

  revisions(): ProjectionRevisionRecord[] {
    return this.revisionRecords.map(cloneRevisionRecord);
  }

  payloadWrites(): ProjectionPayloadInsertInput[] {
    return this.payloadRecords.map(clonePayloadInsertInput);
  }

  failNextPayloadWrite(): void {
    this.payloadFailure = new Error("simulated payload write failure");
  }

  async readCurrentRevision(selector: ProjectionRevisionSelector): Promise<ProjectionRevisionRecord | null> {
    return readCurrentRevisionFrom(this.revisionRecords, normalizeSelectorForTest(selector));
  }

  async readLatestRevision(selector: ProjectionRevisionSelector): Promise<ProjectionRevisionRecord | null> {
    return readLatestRevisionFrom(this.revisionRecords, normalizeSelectorForTest(selector));
  }

  async readCurrentPayload<TPayload = unknown>(selector: ProjectionRevisionSelector): Promise<ProjectionPayloadRecord<TPayload> | null> {
    return readCurrentPayloadFrom(this.revisionRecords, this.payloadRecords, normalizeSelectorForTest(selector));
  }

  async readCurrentTranscriptDefaultPayload<TPayload = unknown>(selector: {
    runId: string;
    limit: number;
    projectContextId?: string | null;
  }): Promise<ProjectionPayloadRecord<TPayload> | null> {
    return readCurrentTranscriptDefaultPayloadFrom(this.revisionRecords, this.payloadRecords, selector);
  }

  async withTransaction<T>(operation: (transaction: ProjectionTransactionRevisionPort) => Promise<T>): Promise<T> {
    const run = async () => {
      const transaction = new InMemoryProjectionTransaction(
        this.revisionRecords.map(cloneRevisionRecord),
        this.payloadRecords.map(clonePayloadInsertInput),
        this.nextProjectionRevisionId,
        () => this.consumePayloadFailure(),
      );
      const result = await operation(transaction);
      this.revisionRecords = transaction.revisions().map(cloneRevisionRecord);
      this.payloadRecords = transaction.payloadWrites().map(clonePayloadInsertInput);
      this.nextProjectionRevisionId = transaction.nextId();
      return result;
    };
    const result = this.queuedTransaction.then(run, run);
    this.queuedTransaction = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private consumePayloadFailure(): Error | null {
    const failure = this.payloadFailure;
    this.payloadFailure = null;
    return failure;
  }
}

class InMemoryProjectionTransaction implements ProjectionTransactionRevisionPort {
  constructor(
    private readonly revisionRecords: ProjectionRevisionRecord[],
    private readonly payloadRecords: ProjectionPayloadInsertInput[],
    private nextProjectionRevisionId: number,
    private readonly consumePayloadFailure: () => Error | null,
  ) {}

  revisions(): ProjectionRevisionRecord[] {
    return this.revisionRecords.map(cloneRevisionRecord);
  }

  payloadWrites(): ProjectionPayloadInsertInput[] {
    return this.payloadRecords.map(clonePayloadInsertInput);
  }

  nextId(): number {
    return this.nextProjectionRevisionId;
  }

  async readCurrentRevision(selector: NormalizedProjectionRevisionSelector): Promise<ProjectionRevisionRecord | null> {
    return readCurrentRevisionFrom(this.revisionRecords, selector);
  }

  async readLatestRevision(selector: NormalizedProjectionRevisionSelector): Promise<ProjectionRevisionRecord | null> {
    return readLatestRevisionFrom(this.revisionRecords, selector);
  }

  async supersedeCurrentRevision(selector: NormalizedProjectionRevisionSelector, supersededAt: string): Promise<void> {
    this.revisionRecords.splice(
      0,
      this.revisionRecords.length,
      ...this.revisionRecords.map((record) =>
        matchesSelector(record, selector) && record.supersededAt === null ? { ...record, supersededAt } : record,
      ),
    );
  }

  async insertProjectionRevision(input: ProjectionRevisionInsertInput): Promise<ProjectionRevisionRecord> {
    if (
      this.revisionRecords.some(
        (record) =>
          record.projectionName === input.projectionName &&
          record.projectContextId === input.projectContextId &&
          record.scopeKind === input.scopeKind &&
          record.scopeKey === input.scopeKey &&
          record.revision === input.revision,
      )
    ) {
      throw postgresError("23505", "duplicate projection revision");
    }
    const record: ProjectionRevisionRecord = {
      projectionRevisionId: this.nextProjectionRevisionId,
      projectionName: input.projectionName,
      projectContextId: input.projectContextId,
      scopeKind: input.scopeKind,
      scopeKey: input.scopeKey,
      revision: input.revision,
      buildMode: input.buildMode,
      sourceRevisions: input.sourceRevisions.map((revision) => ({ ...revision })),
      sourceCursors: cloneJson(input.sourceCursors),
      sourceFreshness: input.sourceFreshness.map((freshness) => ({ ...freshness })),
      contentSha256: input.contentSha256,
      generatedAt: input.generatedAt,
      expiresAt: input.expiresAt,
      supersededAt: null,
      createdAt: input.generatedAt,
    };
    this.nextProjectionRevisionId += 1;
    this.revisionRecords.push(record);
    return cloneRevisionRecord(record);
  }

  async insertProjectionPayload(input: ProjectionPayloadInsertInput): Promise<void> {
    const failure = this.consumePayloadFailure();
    if (failure) throw failure;
    this.payloadRecords.push(clonePayloadInsertInput(input));
  }
}

interface RecordingProjectionSqlRunnerOptions {
  failPayloadInsert?: boolean;
  currentPayloadRow?: Record<string, unknown>;
}

class RecordingProjectionSqlRunner implements ProjectionSqlQueryRunner {
  readonly sqls: string[] = [];
  readonly values: unknown[][] = [];
  private nextProjectionRevisionId = 1;

  constructor(private readonly options: RecordingProjectionSqlRunnerOptions = {}) {}

  async query<TRow = Record<string, unknown>>(sql: string, values: readonly unknown[] = []): Promise<ProjectionSqlQueryResult<TRow>> {
    const normalizedSql = sql.trim().replace(/\s+/g, " ");
    this.sqls.push(normalizedSql);
    this.values.push([...values]);

    if (normalizedSql === "BEGIN" || normalizedSql === "COMMIT" || normalizedSql === "ROLLBACK") {
      return emptySqlResult<TRow>();
    }
    if (normalizedSql.startsWith("SELECT ") && this.options.currentPayloadRow) {
      return { rows: [this.options.currentPayloadRow as TRow] };
    }
    if (normalizedSql.startsWith('SELECT ') || normalizedSql.startsWith('UPDATE "symphony"."projection_revision"')) {
      return emptySqlResult<TRow>();
    }
    if (normalizedSql.startsWith('INSERT INTO "symphony"."projection_revision"')) {
      const row = {
        projection_revision_id: this.nextProjectionRevisionId,
        project_context_id: values[0],
        projection_name: values[1],
        scope_kind: values[2],
        scope_key: values[3],
        revision: values[4],
        build_mode: values[5],
        source_revisions: JSON.parse(String(values[6])) as unknown,
        source_cursors: JSON.parse(String(values[7])) as unknown,
        source_freshness: JSON.parse(String(values[8])) as unknown,
        content_sha256: values[9],
        generated_at: values[10],
        expires_at: values[11] ?? null,
        superseded_at: null,
        created_at: values[10],
      };
      this.nextProjectionRevisionId += 1;
      return { rows: [row as TRow] };
    }
    if (normalizedSql.startsWith('INSERT INTO "symphony".')) {
      if (this.options.failPayloadInsert) throw new Error("simulated postgres payload failure");
      return emptySqlResult<TRow>();
    }
    throw new Error(`unexpected SQL: ${normalizedSql}`);
  }
}

function emptySqlResult<TRow>(): ProjectionSqlQueryResult<TRow> {
  return { rows: [] };
}

function normalizeSelectorForTest(selector: ProjectionRevisionSelector): NormalizedProjectionRevisionSelector {
  return {
    projectionName: selector.projectionName,
    projectContextId: normalizeStringForTest(selector.projectContextId, LEGACY_DEFAULT_PROJECT_CONTEXT_ID),
    scopeKind: normalizeStringForTest(selector.scopeKind, "global"),
    scopeKey: normalizeStringForTest(selector.scopeKey, defaultsByProjectionName[selector.projectionName]),
  };
}

function normalizeStringForTest(value: string | null | undefined, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function readCurrentRevisionFrom(
  records: readonly ProjectionRevisionRecord[],
  selector: NormalizedProjectionRevisionSelector,
): ProjectionRevisionRecord | null {
  const current = records
    .filter((record) => matchesSelector(record, selector) && record.supersededAt === null)
    .sort(compareRevisionDescending)[0];
  return current ? cloneRevisionRecord(current) : null;
}

function readLatestRevisionFrom(
  records: readonly ProjectionRevisionRecord[],
  selector: NormalizedProjectionRevisionSelector,
): ProjectionRevisionRecord | null {
  const latest = records.filter((record) => matchesSelector(record, selector)).sort(compareRevisionDescending)[0];
  return latest ? cloneRevisionRecord(latest) : null;
}

function readCurrentPayloadFrom<TPayload>(
  revisions: readonly ProjectionRevisionRecord[],
  payloads: readonly ProjectionPayloadInsertInput[],
  selector: NormalizedProjectionRevisionSelector,
): ProjectionPayloadRecord<TPayload> | null {
  const revision = readCurrentRevisionFrom(revisions, selector);
  if (!revision) return null;
  const payload = payloads.find(
    (candidate) =>
      candidate.projectionRevisionId === revision.projectionRevisionId &&
      candidate.projectContextId === selector.projectContextId,
  );
  return payload ? projectionPayloadRecordFromWrite<TPayload>(revision, payload) : null;
}

function readCurrentTranscriptDefaultPayloadFrom<TPayload>(
  revisions: readonly ProjectionRevisionRecord[],
  payloads: readonly ProjectionPayloadInsertInput[],
  selector: { runId: string; limit: number; projectContextId?: string | null },
): ProjectionPayloadRecord<TPayload> | null {
  const currentByRevisionId = new Map(
    revisions
      .filter((revision) => revision.projectionName === "transcript_projection" && revision.scopeKind === "run_page" && revision.supersededAt === null)
      .map((revision) => [revision.projectionRevisionId, revision] as const),
  );
  const candidates = payloads
    .flatMap((payload) => {
      const revision = currentByRevisionId.get(payload.projectionRevisionId);
      if (!revision) return [];
      if (payload.projectionName !== "transcript_projection") return [];
      if (payload.fields.runId !== selector.runId || payload.fields.offsetLimit !== selector.limit) return [];
      if (!matchesTranscriptDefaultScope(revision.scopeKey, selector.projectContextId ?? null)) return [];
      return [{ revision, payload }] as const;
    })
    .sort(compareTranscriptDefaultWrites);
  const selected = candidates[0];
  return selected ? projectionPayloadRecordFromWrite<TPayload>(selected.revision, selected.payload) : null;
}

function compareTranscriptDefaultWrites(
  left: { revision: ProjectionRevisionRecord; payload: ProjectionPayloadInsertInput },
  right: { revision: ProjectionRevisionRecord; payload: ProjectionPayloadInsertInput },
): number {
  return (
    Number(right.payload.fields.nextOffset === null) - Number(left.payload.fields.nextOffset === null) ||
    right.payload.fields.messageCount - left.payload.fields.messageCount ||
    right.payload.fields.offsetStart - left.payload.fields.offsetStart ||
    right.revision.revision - left.revision.revision ||
    right.payload.generatedAt.localeCompare(left.payload.generatedAt)
  );
}

function matchesTranscriptDefaultScope(scopeKey: string, projectContextId: string | null): boolean {
  if (projectContextId === null) return !scopeKey.startsWith("pc=");
  return scopeKey.startsWith(`pc=${projectContextId}|`);
}

function projectionPayloadRecordFromWrite<TPayload>(
  revision: ProjectionRevisionRecord,
  payload: ProjectionPayloadInsertInput,
): ProjectionPayloadRecord<TPayload> {
  return {
    revision: cloneRevisionRecord(revision),
    payload: cloneJson(payload.payload) as TPayload,
    payloadSha256: payload.payloadSha256,
    rawPayloadRefs: cloneJson(payload.rawPayloadRefs),
    generatedAt: payload.generatedAt,
    expiresAt: payload.expiresAt,
  };
}

function compareRevisionDescending(left: ProjectionRevisionRecord, right: ProjectionRevisionRecord): number {
  return right.revision - left.revision || right.generatedAt.localeCompare(left.generatedAt);
}

function matchesSelector(record: ProjectionRevisionRecord, selector: NormalizedProjectionRevisionSelector): boolean {
  return (
    record.projectionName === selector.projectionName &&
    record.projectContextId === selector.projectContextId &&
    record.scopeKind === selector.scopeKind &&
    record.scopeKey === selector.scopeKey
  );
}

function cloneRevisionRecord(record: ProjectionRevisionRecord): ProjectionRevisionRecord {
  return {
    ...record,
    sourceRevisions: record.sourceRevisions.map((revision) => ({ ...revision })),
    sourceCursors: cloneJson(record.sourceCursors),
    sourceFreshness: record.sourceFreshness.map((freshness) => ({ ...freshness })),
  };
}

function clonePayloadInsertInput(input: ProjectionPayloadInsertInput): ProjectionPayloadInsertInput {
  return {
    ...input,
    payload: cloneJson(input.payload),
    rawPayloadRefs: cloneJson(input.rawPayloadRefs),
    fields: cloneJson(input.fields),
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function postgresError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

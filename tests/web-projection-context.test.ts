import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildWebProjectionSourceIndex,
  createWebProjectionCacheKey,
  createWebProjectionCacheMetadata,
  createWebProjectionFingerprint,
  isWebProjectionRefreshRequested,
  shouldForceWebProjectionRefresh,
  webProjectionAliasesFromValues,
  WebProjectionContextCache,
  webProjectionIssueKeyAliases,
  type WebProjectionContext,
  type WebProjectionSourceIndex,
} from "../src/app/WebProjectionContext.js";
import { FileIssueLifecycleStore } from "../src/core/persistence/IssueLifecycleStore.js";
import { FileRunTranscriptStore } from "../src/core/persistence/RunTranscriptStore.js";

type AssertFalse<T extends false> = T;
type SourceIndexRequiresTranscriptEvents = WebProjectionSourceIndex extends { transcriptEvents: readonly unknown[] } ? true : false;
const sourceIndexDoesNotRequireTranscriptEvents: AssertFalse<SourceIndexRequiresTranscriptEvents> = false;

describe("WebProjectionContext contracts and cache key utilities", () => {
  it("normalizes issue key aliases by trimming, dropping empty values, deduping, and preserving stable field order", () => {
    const aliases = webProjectionIssueKeyAliases(
      {
        issueId: " issue-id-1 ",
        issueIdentifier: " ENG-1 ",
        workspaceKey: "   ",
        runId: null,
        sessionId: " session-1 ",
      },
      {
        issueId: "issue-id-1",
        issueIdentifier: "ENG-1",
        workspaceKey: " ws-1 ",
        runId: " run-1 ",
        sessionId: "session-1",
      },
      {
        issueId: undefined,
        issueIdentifier: "ENG-1",
        workspaceKey: "ws-1",
        runId: "run-1",
        sessionId: "",
      },
    );

    expect(aliases).toEqual(["issue-id-1", "ENG-1", "session-1", "ws-1", "run-1"]);
    expect(webProjectionIssueKeyAliases(
      {
        issueId: " issue-id-1 ",
        issueIdentifier: " ENG-1 ",
        workspaceKey: "   ",
        runId: null,
        sessionId: " session-1 ",
      },
      {
        issueId: "issue-id-1",
        issueIdentifier: "ENG-1",
        workspaceKey: " ws-1 ",
        runId: " run-1 ",
        sessionId: "session-1",
      },
      {
        issueId: undefined,
        issueIdentifier: "ENG-1",
        workspaceKey: "ws-1",
        runId: "run-1",
        sessionId: "",
      },
    )).toEqual(aliases);
  });

  it("normalizes free-form alias lists for cache key construction", () => {
    expect(webProjectionAliasesFromValues([" ENG-1 ", null, "", "issue-id-1", "ENG-1", undefined, " session-1 "])).toEqual([
      "ENG-1",
      "issue-id-1",
      "session-1",
    ]);
  });

  it("creates deterministic cache keys with trimmed aliases and sorted dimensions", () => {
    const first = createWebProjectionCacheKey({
      namespace: " web/issues ",
      aliases: [" ENG-1 ", "", "ENG-1", " issue-id-1 "],
      dimensions: {
        state: [" Todo ", "In Review", "Todo"],
        refresh: false,
        empty: "   ",
        cursor: null,
        page: 2,
      },
    });
    const second = createWebProjectionCacheKey({
      namespace: "web/issues",
      aliases: ["ENG-1", "issue-id-1"],
      dimensions: {
        page: 2,
        cursor: null,
        empty: undefined,
        refresh: false,
        state: ["Todo", "In Review"],
      },
    });

    expect(first).toBe("web%2Fissues|aliases=ENG-1,issue-id-1|page=2|refresh=false|state=Todo,In%20Review");
    expect(second).toBe(first);
  });

  it("recognizes forced refresh query semantics without treating other values as refresh requests", () => {
    expect(isWebProjectionRefreshRequested("1")).toBe(true);
    expect(isWebProjectionRefreshRequested(" true ")).toBe(true);
    expect(isWebProjectionRefreshRequested(true)).toBe(true);
    expect(isWebProjectionRefreshRequested(1)).toBe(true);
    expect(isWebProjectionRefreshRequested("0")).toBe(false);
    expect(isWebProjectionRefreshRequested("false")).toBe(false);
    expect(isWebProjectionRefreshRequested(false)).toBe(false);
    expect(shouldForceWebProjectionRefresh({ refresh: "false", forceRefresh: true })).toBe(true);
  });

  it("allows a shared source index and context without hydrating full transcript event arrays", () => {
    expect(sourceIndexDoesNotRequireTranscriptEvents).toBe(false);

    const sourceIndex = {
      generatedAt: "2026-01-01T00:00:00.000Z",
      runtime: {
        generatedAt: "2026-01-01T00:00:00.000Z",
        snapshot: { running: [] },
        liveByIssueKey: new Map<string, never>(),
        runningByAlias: new Map<string, never>(),
      },
      trackerIssues: {
        status: "ok",
        fetchedStates: ["Todo", "In Progress", "In Review"],
        fetchedStateKey: "Todo,In Progress,In Review",
        fetchedAt: "2026-01-01T00:00:00.000Z",
        cached: false,
        error: null,
        issues: [],
        byAlias: new Map<string, never>(),
      },
      runs: {
        runs: [],
        runById: new Map<string, never>(),
        runBySessionId: new Map<string, never>(),
        runsByIssueKey: new Map<string, readonly never[]>(),
        latestRunByIssueKey: new Map<string, never>(),
        byAlias: new Map<string, readonly never[]>(),
        latestByAlias: new Map<string, never>(),
        transcriptEventCountsByRunId: new Map<string, number | null>([["run-1", 3]]),
      },
      workspaces: {
        workspaces: [],
        workspaceByIssueKey: new Map<string, never>(),
        byAlias: new Map<string, never>(),
      },
      lifecycles: {
        records: [],
        lifecycleByIssueKey: new Map<string, never>(),
        byAlias: new Map<string, never>(),
      },
      writebacks: {
        operations: [],
        writebacksByIssueKey: new Map<string, readonly never[]>(),
      },
      transcript: {
        hydration: "excluded",
        eventCountsByRunId: new Map<string, number | null>([["run-1", 3]]),
      },
      durableSourceRevisions: [],
    } satisfies WebProjectionSourceIndex;

    const context: WebProjectionContext<typeof sourceIndex> = {
      metadata: createWebProjectionCacheMetadata({
        builtAt: "2026-01-01T00:00:00.000Z",
        maxAgeMs: 1_000,
        fingerprint: createWebProjectionFingerprint({
          runtimeGeneratedAt: "2026-01-01T00:00:00.000Z",
          issueBoardStates: ["Todo", "In Progress", "In Review"],
          issueBoardColumns: ["todo", "progress", "review"],
          durableSourceRevisions: [{ source: "runs", revision: "run-1", observedAt: "2026-01-01T00:00:00.000Z" }],
        }),
      }),
      sourceIndex,
      projections: {},
    };

    expect(context.metadata).toMatchObject({
      builtAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:00:01.000Z",
      maxAgeMs: 1_000,
    });
    expect(context.sourceIndex.transcript).toEqual({
      hydration: "excluded",
      eventCountsByRunId: new Map<string, number | null>([["run-1", 3]]),
    });
    expect("events" in context.sourceIndex.transcript).toBe(false);
  });

  it("caches shared contexts until forced refresh, expiration, or source fingerprint changes", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    let builds = 0;
    const sourceIndex = sourceIndexFixture("2026-01-01T00:00:00.000Z");
    const cache = new WebProjectionContextCache<WebProjectionSourceIndex, WebProjectionContext<WebProjectionSourceIndex, { build: number }>>();
    const cacheKey = createWebProjectionCacheKey({ namespace: "web/dashboard", dimensions: { states: ["Todo", "In Review"] } });
    const acquire = (nextSourceIndex: WebProjectionSourceIndex, refresh?: string) =>
      cache.acquire({
        cacheKey,
        sourceIndex: nextSourceIndex,
        refresh,
        clock: () => now,
        maxAgeMs: 1_000,
        build: ({ metadata, sourceIndex }) => {
          builds += 1;
          return { metadata, sourceIndex, projections: { build: builds } };
        },
      });

    const first = await acquire(sourceIndex);
    const second = await acquire(sourceIndex);
    expect(second).toBe(first);
    expect(second.projections.build).toBe(1);
    expect(cache.get(cacheKey, now)).toBe(first);

    now = new Date("2026-01-01T00:00:00.500Z");
    const forced = await acquire(sourceIndex, "1");
    expect(forced).not.toBe(first);
    expect(forced.projections.build).toBe(2);
    expect(await acquire(sourceIndex)).toBe(forced);

    now = new Date("2026-01-01T00:00:02.000Z");
    expect(cache.get(cacheKey, now)).toBe(null);
    const expired = await acquire(sourceIndex);
    expect(expired).not.toBe(forced);
    expect(expired.projections.build).toBe(3);

    const changedSourceIndex = sourceIndexFixture("2026-01-01T00:00:03.000Z");
    const changed = await acquire(changedSourceIndex);
    expect(changed).not.toBe(expired);
    expect(changed.projections.build).toBe(4);
  });

  it("coalesces concurrent shared context builds for the same cache key and fingerprint", async () => {
    const sourceIndex = sourceIndexFixture("2026-01-01T00:00:00.000Z");
    const cache = new WebProjectionContextCache<WebProjectionSourceIndex, WebProjectionContext<WebProjectionSourceIndex, { build: number }>>();
    const cacheKey = createWebProjectionCacheKey({ namespace: "web/sidebar", dimensions: { states: ["Todo"] } });
    let builds = 0;
    let releaseBuild: (() => void) | null = null;
    const first = cache.acquire({
      cacheKey,
      sourceIndex,
      maxAgeMs: 1_000,
      build: async ({ metadata, sourceIndex }) => {
        builds += 1;
        await new Promise<void>((resolve) => {
          releaseBuild = resolve;
        });
        return { metadata, sourceIndex, projections: { build: builds } };
      },
    });
    const second = cache.acquire({
      cacheKey,
      sourceIndex,
      maxAgeMs: 1_000,
      build: () => {
        throw new Error("second acquire should reuse the in-flight build");
      },
    });

    expect(builds).toBe(1);
    const release = releaseBuild as (() => void) | null;
    expect(release).not.toBeNull();
    if (!release) throw new Error("build did not start");
    release();
    const [firstContext, secondContext] = await Promise.all([first, second]);
    expect(secondContext).toBe(firstContext);
    expect(firstContext.projections.build).toBe(1);
    expect(cache.get(cacheKey)).toBe(firstContext);
  });

  it("builds a one-pass source index across tracker, runtime, durable stores, and writeback operations", async () => {
    let runListCalls = 0;
    let workspaceListCalls = 0;
    let lifecycleListCalls = 0;
    let writebackListCalls = 0;
    const issue = {
      id: "issue-id-1",
      identifier: "ENG-1",
      title: "Build projection indexes",
      description: null,
      priority: null,
      state: "Todo",
      branchName: null,
      url: null,
      assigneeId: null,
      delegateId: null,
      assignedToWorker: true,
      labels: [],
      blockedBy: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:03.000Z",
    };
    const olderRun = runRecordFixture({ runId: "run-older", sessionId: "session-older", updatedAt: "2026-01-01T00:00:01.000Z" });
    const latestRun = runRecordFixture({ runId: "run-latest", sessionId: "session-latest", updatedAt: "2026-01-01T00:00:02.000Z" });
    const workspace = {
      workspaceKey: "workspace-1",
      issueId: "issue-id-1",
      issueIdentifier: "ENG-1",
      path: "/tmp/workspace",
      sourceKind: "git",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:02.000Z",
    };
    const lifecycle = lifecycleRecordFixture({ updatedAt: "2026-01-01T00:00:04.000Z" });
    const writeback = writebackOperationFixture({ issueId: "issue-id-1", runId: "run-latest" });
    const snapshot = runtimeSnapshotFixture({ runId: "run-latest", sessionId: "session-latest" });

    const sourceIndex = await buildWebProjectionSourceIndex({
      snapshot,
      trackerProjection: {
        fetchedStates: ["Todo", "Todo", "In Review"],
        trackerIssues: [issue],
        fetchedAt: "2026-01-01T00:00:05.000Z",
        cached: true,
      },
      runStore: {
        async listRuns() {
          runListCalls += 1;
          return [latestRun, olderRun];
        },
        async listWorkspaces() {
          workspaceListCalls += 1;
          return [workspace];
        },
      },
      lifecycleStore: {
        async list() {
          lifecycleListCalls += 1;
          return [lifecycle];
        },
      },
      writebackOutbox: {
        async list() {
          writebackListCalls += 1;
          return [writeback];
        },
      },
      clock: () => new Date("2026-01-01T00:00:06.000Z"),
    });

    expect(runListCalls).toBe(1);
    expect(workspaceListCalls).toBe(1);
    expect(lifecycleListCalls).toBe(1);
    expect(writebackListCalls).toBe(1);
    expect(sourceIndex.trackerIssues).toMatchObject({
      status: "ok",
      fetchedStates: ["Todo", "In Review"],
      fetchedStateKey: "Todo,In Review",
      fetchedAt: "2026-01-01T00:00:05.000Z",
      cached: true,
      error: null,
    });
    expect(sourceIndex.trackerIssues.byAlias.get("ENG-1")).toBe(issue);
    expect(sourceIndex.runtime.liveByIssueKey.get("issue-id-1")?.runId).toBe("run-latest");
    expect(sourceIndex.runtime.liveByIssueKey.get("session-latest")?.issueIdentifier).toBe("ENG-1");
    expect(sourceIndex.runs.runById.get("run-latest")).toBe(latestRun);
    expect(sourceIndex.runs.runBySessionId.get("session-latest")).toBe(latestRun);
    expect(sourceIndex.runs.runsByIssueKey.get("ENG-1")?.map((run) => run.runId)).toEqual(["run-older", "run-latest"]);
    expect(sourceIndex.runs.latestRunByIssueKey.get("issue-id-1")).toBe(latestRun);
    expect(sourceIndex.transcript.eventCountsByRunId.get("run-latest")).toBe(7);
    expect(sourceIndex.workspaces.workspaceByIssueKey.get("workspace-1")).toBe(workspace);
    expect(sourceIndex.lifecycles.lifecycleByIssueKey.get("ENG-1")).toBe(lifecycle);
    expect(sourceIndex.writebacks.writebacksByIssueKey.get("ENG-1")?.map((operation) => operation.idempotencyKey)).toEqual([
      "writeback-1",
    ]);
    expect(sourceIndex.transcript.hydration).toBe("excluded");
    expect(sourceIndex.durableSourceRevisions.map((revision) => revision.source)).toEqual([
      "lifecycles",
      "runs",
      "trackerIssues",
      "workspaces",
      "writebacks",
    ]);
  });

  it("records tracker unavailability in the source index while still indexing local durable sources", async () => {
    const sourceIndex = await buildWebProjectionSourceIndex({
      fetchedStates: ["Todo", "In Review"],
      runStore: {
        async listRuns() {
          return [runRecordFixture({ runId: "run-1", updatedAt: "2026-01-01T00:00:01.000Z" })];
        },
        async listWorkspaces() {
          return [];
        },
      },
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(sourceIndex.trackerIssues).toMatchObject({
      status: "unavailable",
      fetchedStates: ["Todo", "In Review"],
      fetchedAt: null,
      cached: false,
      error: {
        code: "tracker_unavailable",
        message: "Issue board requires a configured tracker client",
      },
    });
    expect(sourceIndex.runs.runById.has("run-1")).toBe(true);
  });

  it("indexes normalized project context metadata from durable run and lifecycle stores", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-web-projection-"));
    try {
      const runStore = new FileRunTranscriptStore(root);
      const lifecycleStore = new FileIssueLifecycleStore(root);
      const expectedProjectContext = {
        projectContextId: "docs",
        projectContextLabel: "Documentation Site",
        linearProjectSlug: "DOCS",
        routingSource: "candidate_poll",
      } as const;

      await runStore.upsertWorkspace({
        workspaceKey: "workspace-projection",
        issueId: "issue-projection",
        issueIdentifier: "DOCS-PROJECTION-1",
        projectContext: expectedProjectContext,
        path: "/tmp/projection-workspace",
        sourceKind: "git_worktree",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      await runStore.startRun({
        runId: "run-projection",
        sessionId: "session-projection",
        agentId: "agent-projection",
        role: "worker",
        issueId: "issue-projection",
        issueIdentifier: "DOCS-PROJECTION-1",
        attempt: null,
        turnNumber: 1,
        prompt: "work",
        workspaceKey: "workspace-projection",
        workspacePath: "/tmp/projection-workspace",
        projectContext: expectedProjectContext,
      });
      await lifecycleStore.ensureIssue(
        { id: "issue-projection", identifier: "DOCS-PROJECTION-1" },
        { phase: "implementation", projectContext: expectedProjectContext },
      );

      const injectedProjectContext = {
        ...expectedProjectContext,
        repository: "https://x-access-token:repo-secret@example.com/org/docs.git",
        path: "packages/site",
        token: "projection-secret",
      };
      const runPath = path.join(root, "runs", "run-projection", "meta.json");
      const rawRun = JSON.parse(await readFile(runPath, "utf8")) as Record<string, unknown>;
      rawRun.projectContext = injectedProjectContext;
      await writeFile(runPath, `${JSON.stringify(rawRun, null, 2)}\n`, "utf8");

      const workspacePath = path.join(root, "workspaces", "workspace-projection.json");
      const rawWorkspace = JSON.parse(await readFile(workspacePath, "utf8")) as Record<string, unknown>;
      rawWorkspace.projectContext = injectedProjectContext;
      await writeFile(workspacePath, `${JSON.stringify(rawWorkspace, null, 2)}\n`, "utf8");

      const lifecyclePath = path.join(root, "issue-lifecycle", "issue-projection.json");
      const rawLifecycle = JSON.parse(await readFile(lifecyclePath, "utf8")) as Record<string, unknown>;
      rawLifecycle.projectContext = injectedProjectContext;
      await writeFile(lifecyclePath, `${JSON.stringify(rawLifecycle, null, 2)}\n`, "utf8");

      const sourceIndex = await buildWebProjectionSourceIndex({
        runStore,
        lifecycleStore,
        clock: () => new Date("2026-01-01T00:00:01.000Z"),
      });

      const run = sourceIndex.runs.runById.get("run-projection");
      const workspace = sourceIndex.workspaces.workspaces.find((item) => item.workspaceKey === "workspace-projection") ?? null;
      const lifecycle = sourceIndex.lifecycles.records.find((item) => item.issueId === "issue-projection") ?? null;
      expect(run?.projectContext).toEqual(expectedProjectContext);
      expect(workspace?.projectContext).toEqual(expectedProjectContext);
      expect(lifecycle?.projectContext).toEqual(expectedProjectContext);

      const serialized = JSON.stringify({ run, workspace, lifecycle });
      expect(serialized).not.toContain("repo-secret");
      expect(serialized).not.toContain("x-access-token");
      expect(serialized).not.toContain("projection-secret");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function sourceIndexFixture(runtimeGeneratedAt: string): WebProjectionSourceIndex {
  return {
    generatedAt: runtimeGeneratedAt,
    runtime: {
      generatedAt: runtimeGeneratedAt,
      snapshot: { running: [] },
      liveByIssueKey: new Map<string, never>(),
      runningByAlias: new Map<string, never>(),
    },
    trackerIssues: {
      status: "ok",
      fetchedStates: ["Todo", "In Review"],
      fetchedStateKey: "Todo,In Review",
      fetchedAt: runtimeGeneratedAt,
      cached: false,
      error: null,
      issues: [],
      byAlias: new Map<string, never>(),
    },
    runs: {
      runs: [],
      runById: new Map<string, never>(),
      runBySessionId: new Map<string, never>(),
      runsByIssueKey: new Map<string, readonly never[]>(),
      latestRunByIssueKey: new Map<string, never>(),
      byAlias: new Map<string, readonly never[]>(),
      latestByAlias: new Map<string, never>(),
      transcriptEventCountsByRunId: new Map<string, number | null>(),
    },
    workspaces: {
      workspaces: [],
      workspaceByIssueKey: new Map<string, never>(),
      byAlias: new Map<string, never>(),
    },
    lifecycles: {
      records: [],
      lifecycleByIssueKey: new Map<string, never>(),
      byAlias: new Map<string, never>(),
    },
    writebacks: {
      operations: [],
      writebacksByIssueKey: new Map<string, readonly never[]>(),
    },
    transcript: {
      hydration: "excluded",
      eventCountsByRunId: new Map<string, number | null>(),
    },
    durableSourceRevisions: [{ source: "runs", revision: runtimeGeneratedAt, observedAt: runtimeGeneratedAt }],
  };
}

function runtimeSnapshotFixture(input: { runId: string; sessionId: string }) {
  const issueDetails = {
    id: "issue-id-1",
    identifier: "ENG-1",
    title: "Build projection indexes",
    description: null,
    priority: null,
    state: "In Progress",
    branchName: null,
    url: null,
    assigneeId: null,
    delegateId: null,
    labels: [],
    blockedBy: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:02.000Z",
  };
  return {
    generatedAt: "2026-01-01T00:00:06.000Z",
    counts: { running: 1, retrying: 0, paused: 0, providerGates: 0 },
    providerGates: [],
    providerGateCounts: { active: 0, manual: 0, autoResume: 0 },
    running: [
      {
        issueId: "issue-id-1",
        issueIdentifier: "ENG-1",
        role: "worker",
        runPhase: "implementation",
        runKind: "worker",
        state: "In Progress",
        workspacePath: "/tmp/workspace",
        sessionId: input.sessionId,
        runId: input.runId,
        turnCount: 1,
        lastEvent: null,
        lastMessage: null,
        startedAt: "2026-01-01T00:00:00.000Z",
        lastEventAt: "2026-01-01T00:00:05.000Z",
        liveness: {
          status: "active",
          activeRunId: input.runId,
          lastActivityAt: "2026-01-01T00:00:05.000Z",
          secondsSinceLastActivity: 1,
          stallTimeoutMs: null,
        },
        cancellation: {
          requested: false,
          requestedAt: null,
          source: null,
          reason: null,
          abortSignalled: false,
          harnessStopRequestedAt: null,
          suppressRetryOnExit: false,
        },
        tokens: { input: 0, output: 0, total: 0 },
        lifecycle: null,
        metadata: {
          workspaceKey: "workspace-1",
          workspacePath: "/tmp/workspace",
          branchName: null,
          gitBranchName: null,
          repoPath: null,
          baseRef: null,
          prUrl: null,
          prNumber: null,
          prHeadSha: null,
          prBranch: null,
          ciStatus: null,
          lastPushedAt: null,
        },
        issueDetails,
      },
    ],
    retrying: [],
    paused: [],
    totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 1 },
    rateLimits: null,
  } as any;
}

function runRecordFixture(input: { runId: string; sessionId?: string; updatedAt: string }) {
  return {
    runId: input.runId,
    sessionId: input.sessionId ?? `${input.runId}-session`,
    agentId: `agent-${input.runId}`,
    role: "worker",
    runPhase: "implementation",
    runKind: "worker",
    issueId: "issue-id-1",
    issueIdentifier: "ENG-1",
    attempt: 1,
    turnNumber: 1,
    prompt: "prompt",
    workspaceKey: "workspace-1",
    workspacePath: "/tmp/workspace",
    status: "running",
    startedAt: input.updatedAt,
    updatedAt: input.updatedAt,
    completedAt: null,
    error: null,
    tokens: { input: 0, output: 0, total: 0 },
    transcriptEventCount: input.runId === "run-latest" ? 7 : 3,
  } as any;
}

function lifecycleRecordFixture(input: { updatedAt: string }) {
  return {
    issueId: "issue-id-1",
    issueIdentifier: "ENG-1",
    phase: "implementation",
    reviewRound: 0,
    incompleteTurnCount: 0,
    lastIssueBreakdownPlanId: null,
    planningFailureCount: 0,
    planningDispatchRetryCount: 0,
    lastPlanningFailureRunId: null,
    lastPlanningFailureAt: null,
    lastCompletionReportId: null,
    lastReviewVerdictId: null,
    blockedReason: null,
    summaryPointers: {
      workspaceKey: null,
      workspacePath: null,
      branchName: null,
      gitBranchName: null,
      repoPath: null,
      baseRef: null,
      lastRunId: null,
      prUrl: null,
      prNumber: null,
      prHeadSha: null,
      prBranch: null,
      ciStatus: null,
      lastPushedAt: null,
      lastEvidenceCursor: null,
    },
    summaryReferences: [],
    issueBreakdownPlans: [],
    completionReports: [],
    reviewVerdicts: [],
    reviewFeedback: [],
    reviewEvidence: { pullRequest: null, lastIngestedCursor: null, lastWorkerEvidenceCursor: null, items: [], updatedAt: null },
    merge: null,
    mergeConflict: null,
    mergeConflictResolutionReports: [],
    handoff: { state: "none", reason: null, runId: null, updatedAt: null },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: input.updatedAt,
  } as any;
}

function writebackOperationFixture(input: { issueId: string; runId: string }) {
  return {
    idempotencyKey: "writeback-1",
    kind: "transition",
    issueId: input.issueId,
    runId: input.runId,
    status: "pending",
    attempt: 0,
    createdAt: "2026-01-01T00:00:01.000Z",
    updatedAt: "2026-01-01T00:00:02.000Z",
    nextAttemptAt: "2026-01-01T00:00:03.000Z",
    lastError: null,
    resultStatus: null,
    resultMessage: null,
    resultEvidence: null,
    payload: { toState: "In Review" },
  } as any;
}

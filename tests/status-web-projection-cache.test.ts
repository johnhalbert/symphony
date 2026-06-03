import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  StatusServer,
  WEB_PROJECTION_CONTEXT_TTL_MS,
  type StatusServerProjectionReader,
  type StatusServerWebProjectionContext,
  type StatusServerWebProjectionContextBuildInput,
  type StatusServerWebProjectionContextBuilder,
} from "../src/app/http.js";
import {
  isWebProjectionRefreshRequested,
  type WebProjectionRevisionListener,
  type WebProjectionRevisionProvider,
} from "../src/app/WebProjectionContext.js";
import { FileIssueLifecycleStore } from "../src/core/persistence/IssueLifecycleStore.js";
import { FileRunTranscriptStore, type StartRunInput, type WorkspaceRecord } from "../src/core/persistence/RunTranscriptStore.js";
import { FileWritebackOutboxStore, type NewWritebackOperation } from "../src/core/writeback/WritebackOutbox.js";
import type { TrackerStateLists } from "../src/core/types.js";

interface TestableStatusServer extends StatusServer {
  acquireWebProjectionContext(forceRefresh: boolean): Promise<StatusServerWebProjectionContext>;
}

describe("StatusServer web projection context cache", () => {
  it("bypasses a completed context before TTL expiry when runtime generatedAt changes and rebuilds after expiry", async () => {
    const startedAt = Date.parse("2026-01-01T00:00:00.000Z");
    let nowMs = startedAt;
    let generatedAtMs = startedAt;
    let builds = 0;
    const server = createStatusServer({
      generatedAt: () => new Date(generatedAtMs).toISOString(),
      clock: () => new Date(nowMs),
      builder: (input) => {
        builds += 1;
        return contextFixture(input, builds);
      },
    });
    const acquire = acquireFrom(server);

    const first = await acquire(false);
    generatedAtMs = startedAt + 5;
    nowMs = startedAt + WEB_PROJECTION_CONTEXT_TTL_MS - 1;
    const runtimeChanged = await acquire(false);
    expect(runtimeChanged).not.toBe(first);
    expect(projectedBuild(runtimeChanged)).toBe(2);

    await expect(acquire(false)).resolves.toBe(runtimeChanged);
    expect(builds).toBe(2);

    nowMs = startedAt + WEB_PROJECTION_CONTEXT_TTL_MS * 2;
    const expired = await acquire(false);
    expect(expired).not.toBe(runtimeChanged);
    expect(projectedBuild(expired)).toBe(3);
    expect(builds).toBe(3);
  });

  it("rebuilds before TTL expiry when stable runtime state or durable-source fingerprint changes", async () => {
    const generatedAt = "2026-01-01T00:00:00.000Z";
    let runningCount = 0;
    let durableRevision = "revision-1";
    let builds = 0;
    const server = createStatusServer({
      generatedAt: () => generatedAt,
      runtimeCounts: () => ({ running: runningCount }),
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
      revisionProvider: () => ({ source: "runs", revision: durableRevision, observedAt: generatedAt }),
      builder: (input) => {
        builds += 1;
        return contextFixture(input, builds);
      },
    });
    const acquire = acquireFrom(server);

    const first = await acquire(false);
    durableRevision = "revision-2";
    const revisionChanged = await acquire(false);
    expect(revisionChanged).not.toBe(first);
    expect(projectedBuild(revisionChanged)).toBe(2);

    runningCount = 1;
    const runtimeChanged = await acquire(false);
    expect(runtimeChanged).not.toBe(revisionChanged);
    expect(projectedBuild(runtimeChanged)).toBe(3);
    expect(builds).toBe(3);
  });

  it("rebuilds before TTL expiry when a durable projection revision changes", async () => {
    const generatedAt = "2026-01-01T00:00:00.000Z";
    let durableProjectionRevision = 1;
    let builds = 0;
    const server = createStatusServer({
      generatedAt: () => generatedAt,
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
      projectionReader: durableProjectionRevisionReader(() => durableProjectionRevision, generatedAt),
      builder: (input) => {
        builds += 1;
        return contextFixture(input, builds);
      },
    });
    const acquire = acquireFrom(server);

    const first = await acquire(false);
    expect(first.metadata.fingerprint.durableProjectionRevisions).toContainEqual({
      source: "projection:dashboard_projection:global:global",
      revision: 1,
      observedAt: generatedAt,
    });

    durableProjectionRevision = 2;
    const revisionChanged = await acquire(false);
    expect(revisionChanged).not.toBe(first);
    expect(projectedBuild(revisionChanged)).toBe(2);
    expect(revisionChanged.metadata.fingerprint.durableProjectionRevisions).toContainEqual({
      source: "projection:dashboard_projection:global:global",
      revision: 2,
      observedAt: generatedAt,
    });

    await expect(acquire(false)).resolves.toBe(revisionChanged);
    expect(builds).toBe(2);
  });

  it("coalesces concurrent non-refresh requests onto the same in-flight build", async () => {
    const pendingBuilds: Array<{
      build: number;
      input: StatusServerWebProjectionContextBuildInput;
      deferred: Deferred<StatusServerWebProjectionContext>;
    }> = [];
    const startedAt = Date.parse("2026-01-01T00:00:00.000Z");
    let generatedAtMs = startedAt;
    let builds = 0;
    const server = createStatusServer({
      generatedAt: () => new Date(generatedAtMs).toISOString(),
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
      builder: (input) => {
        builds += 1;
        const deferredBuild = deferred<StatusServerWebProjectionContext>();
        pendingBuilds.push({ build: builds, input, deferred: deferredBuild });
        return deferredBuild.promise;
      },
    });
    const acquire = acquireFrom(server);

    const first = acquire(false);
    const second = acquire(false);
    await settleMicrotasks();

    expect(builds).toBe(1);
    const pending = pendingBuilds[0];
    if (!pending) throw new Error("expected a pending build");
    const resolved = contextFixture(pending.input, pending.build);
    pending.deferred.resolve(resolved);

    const [firstContext, secondContext] = await Promise.all([first, second]);
    expect(firstContext).toBe(resolved);
    expect(secondContext).toBe(resolved);
  });

  it("treats refresh=1 and refresh=true as completed-cache bypasses", async () => {
    let builds = 0;
    const server = createStatusServer({
      generatedAt: () => "2026-01-01T00:00:00.000Z",
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
      builder: (input) => {
        builds += 1;
        return contextFixture(input, builds);
      },
    });
    const acquire = acquireFrom(server);

    const completed = await acquire(false);
    const refreshOne = await acquire(isWebProjectionRefreshRequested("1"));
    expect(refreshOne).not.toBe(completed);
    expect(projectedBuild(refreshOne)).toBe(2);
    expect(projectedForceRefresh(refreshOne)).toBe(true);
    await expect(acquire(false)).resolves.toBe(refreshOne);

    const refreshTrue = await acquire(isWebProjectionRefreshRequested("true"));
    expect(refreshTrue).not.toBe(refreshOne);
    expect(projectedBuild(refreshTrue)).toBe(3);
    expect(projectedForceRefresh(refreshTrue)).toBe(true);
    expect(builds).toBe(3);
  });

  it("bypasses a completed context for refresh requests and coalesces concurrent refresh builds", async () => {
    const startedAt = Date.parse("2026-01-01T00:00:00.000Z");
    let generatedAtMs = startedAt;
    let builds = 0;
    let deferRefresh = false;
    const pendingRefreshBuilds: Array<{
      build: number;
      input: StatusServerWebProjectionContextBuildInput;
      deferred: Deferred<StatusServerWebProjectionContext>;
    }> = [];
    const server = createStatusServer({
      generatedAt: () => new Date(generatedAtMs).toISOString(),
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
      builder: (input) => {
        builds += 1;
        if (deferRefresh && input.forceRefresh) {
          const deferredBuild = deferred<StatusServerWebProjectionContext>();
          pendingRefreshBuilds.push({ build: builds, input, deferred: deferredBuild });
          return deferredBuild.promise;
        }
        return contextFixture(input, builds);
      },
    });
    const acquire = acquireFrom(server);

    const completed = await acquire(false);
    expect(projectedBuild(completed)).toBe(1);

    deferRefresh = true;
    const firstRefresh = acquire(true);
    const secondRefresh = acquire(true);
    await settleMicrotasks();

    expect(builds).toBe(2);
    const pending = pendingRefreshBuilds[0];
    if (!pending) throw new Error("expected a pending refresh build");
    const refreshed = contextFixture(pending.input, pending.build);
    pending.deferred.resolve(refreshed);

    const [firstRefreshContext, secondRefreshContext] = await Promise.all([firstRefresh, secondRefresh]);
    expect(firstRefreshContext).toBe(refreshed);
    expect(secondRefreshContext).toBe(refreshed);
    expect(firstRefreshContext).not.toBe(completed);
    expect(projectedForceRefresh(firstRefreshContext)).toBe(true);
  });

  it("clears failed pending builds, preserves the last good completed context, and allows retry", async () => {
    const generatedAt = "2026-01-01T00:00:00.000Z";
    let durableRevision = "revision-1";
    let builds = 0;
    let failNext = false;
    const pendingFailure: { current: Deferred<StatusServerWebProjectionContext> | null } = { current: null };
    const server = createStatusServer({
      generatedAt: () => generatedAt,
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
      revisionProvider: () => ({ source: "runs", revision: durableRevision, observedAt: generatedAt }),
      builder: (input) => {
        builds += 1;
        if (failNext) {
          failNext = false;
          pendingFailure.current = deferred<StatusServerWebProjectionContext>();
          return pendingFailure.current.promise;
        }
        return contextFixture(input, builds);
      },
    });
    const acquire = acquireFrom(server);

    const completed = await acquire(false);
    expect(projectedBuild(completed)).toBe(1);

    durableRevision = "revision-2";
    failNext = true;
    const failedFirst = acquire(false);
    const failedSecond = acquire(false);
    await settleMicrotasks();
    expect(builds).toBe(2);
    const failure = pendingFailure.current;
    if (!failure) throw new Error("expected a pending failed build");
    failure.reject(new Error("context build failed"));

    await expect(failedFirst).rejects.toThrow("context build failed");
    await expect(failedSecond).rejects.toThrow("context build failed");

    durableRevision = "revision-1";
    await expect(acquire(false)).resolves.toBe(completed);
    expect(builds).toBe(2);

    durableRevision = "revision-2";
    const retried = await acquire(false);
    expect(projectedBuild(retried)).toBe(3);
    expect(retried).not.toBe(completed);
    expect(builds).toBe(3);
  });

  it("does not cache default-builder tracker failures and retries after recovery", async () => {
    const startedAt = Date.parse("2026-01-01T00:00:00.000Z");
    let generatedAtMs = startedAt;
    let durableRevision = "revision-1";
    let trackerMode: "ok" | "fail" = "ok";
    let trackerCalls = 0;
    const server = createStatusServer({
      generatedAt: () => new Date(generatedAtMs).toISOString(),
      clock: () => new Date(generatedAtMs),
      staleThresholdMs: -1,
      revisionProvider: () => ({
        source: "runs",
        revision: durableRevision,
        observedAt: null,
      }),
      tracker: {
        async fetchCandidateIssues() {
          return [];
        },
        async fetchIssuesByStates() {
          trackerCalls += 1;
          if (trackerMode === "fail") throw new Error("temporary tracker outage");
          return [];
        },
        async fetchIssueStatesByIds() {
          return [];
        },
      },
    });
    const acquire = acquireFrom(server);

    const completed = await acquire(false);
    expect(completed.sourceIndex.trackerIssues.status).toBe("ok");
    expect(trackerCalls).toBe(1);

    durableRevision = "revision-2";
    trackerMode = "fail";
    const failedFirst = acquire(false);
    const failedSecond = acquire(false);
    await settleMicrotasks();

    await expect(failedFirst).rejects.toMatchObject({ code: "tracker_error" });
    await expect(failedSecond).rejects.toMatchObject({ code: "tracker_error" });
    expect(trackerCalls).toBe(2);

    durableRevision = "revision-1";
    await expect(acquire(false)).resolves.toBe(completed);
    expect(trackerCalls).toBe(2);

    durableRevision = "revision-2";
    trackerMode = "ok";
    const recovered = await acquire(false);
    expect(recovered).not.toBe(completed);
    expect(recovered.sourceIndex.trackerIssues.status).toBe("ok");
    expect(trackerCalls).toBe(3);

    await expect(acquire(false)).resolves.toBe(recovered);
    expect(trackerCalls).toBe(3);
  });

  it("registers durable-store listeners and dirties completed contexts for run, workspace, lifecycle, and writeback writes", async () => {
    await withTempStateDir(async (stateDir) => {
      const runStore = new FileRunTranscriptStore(stateDir);
      const lifecycleStore = new FileIssueLifecycleStore(stateDir);
      const writebackOutbox = new FileWritebackOutboxStore(stateDir);
      let builds = 0;
      const server = createStatusServer({
        generatedAt: () => "2026-01-01T00:00:00.000Z",
        clock: () => new Date("2026-01-01T00:00:00.000Z"),
        runStore,
        lifecycleStore,
        writebackOutbox,
        builder: (input) => {
          builds += 1;
          return contextFixture(input, builds);
        },
      });
      const acquire = acquireFrom(server);
      await server.start();
      try {
        let current = await acquire(false);
        expect(projectedBuild(current)).toBe(1);

        const expectDirtyAfter = async (mutation: () => Promise<void>, expectedBuild: number): Promise<void> => {
          const previous = current;
          await mutation();
          current = await acquire(false);
          expect(current).not.toBe(previous);
          expect(projectedBuild(current)).toBe(expectedBuild);
        };

        await expectDirtyAfter(() => runStore.startRun(startRunInputFixture(stateDir, "run-1")).then(() => undefined), 2);
        await expectDirtyAfter(() => runStore.upsertWorkspace(workspaceRecordFixture(stateDir, "workspace-1")), 3);
        await expectDirtyAfter(() => runStore.deleteWorkspace("workspace-1"), 4);
        await expectDirtyAfter(
          () => lifecycleStore.ensureIssue({ id: "issue-lifecycle", identifier: "ENG-LIFE" }, { phase: "review" }).then(() => undefined),
          5,
        );
        const beforeWritebackEnqueue = current;
        let writeback = await writebackOutbox.enqueueOnce(writebackOperationFixture("writeback-1"));
        current = await acquire(false);
        expect(current).not.toBe(beforeWritebackEnqueue);
        expect(projectedBuild(current)).toBe(6);
        const beforeWritebackStatus = current;
        writeback = await writebackOutbox.markSucceeded(writeback, { status: "applied", message: "applied" });
        current = await acquire(false);
        expect(current).not.toBe(beforeWritebackStatus);
        expect(writeback.status).toBe("succeeded");
        expect(projectedBuild(current)).toBe(7);
        expect(builds).toBe(7);
      } finally {
        await server.stop();
      }
    });
  });

  it("unsubscribes projection listeners on stop so later notifications do not dirty the completed context", async () => {
    const revisionProvider = controllableRevisionProvider();
    let builds = 0;
    const server = createStatusServer({
      generatedAt: () => "2026-01-01T00:00:00.000Z",
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
      revisionProviders: [revisionProvider.provider],
      builder: (input) => {
        builds += 1;
        return contextFixture(input, builds);
      },
    });
    const acquire = acquireFrom(server);

    await server.start();
    const completed = await acquire(false);
    expect(projectedBuild(completed)).toBe(1);
    expect(revisionProvider.listenerCount()).toBe(1);
    await server.stop();
    expect(revisionProvider.listenerCount()).toBe(0);

    revisionProvider.emit(2);
    await expect(acquire(false)).resolves.toBe(completed);
    expect(builds).toBe(1);
  });

  it("does not promote an in-flight build as completed when a store changes during the build", async () => {
    await withTempStateDir(async (stateDir) => {
      const runStore = new FileRunTranscriptStore(stateDir);
      const pendingBuilds: Array<{
        build: number;
        input: StatusServerWebProjectionContextBuildInput;
        deferred: Deferred<StatusServerWebProjectionContext>;
      }> = [];
      let builds = 0;
      let deferNextBuild = false;
      const server = createStatusServer({
        generatedAt: () => "2026-01-01T00:00:00.000Z",
        clock: () => new Date("2026-01-01T00:00:00.000Z"),
        runStore,
        builder: (input) => {
          builds += 1;
          if (deferNextBuild) {
            const deferredBuild = deferred<StatusServerWebProjectionContext>();
            pendingBuilds.push({ build: builds, input, deferred: deferredBuild });
            return deferredBuild.promise;
          }
          return contextFixture(input, builds);
        },
      });
      const acquire = acquireFrom(server);
      await server.start();
      try {
        const completed = await acquire(false);
        expect(projectedBuild(completed)).toBe(1);

        deferNextBuild = true;
        const rebuilding = acquire(true);
        await settleMicrotasks();
        const pending = pendingBuilds[0];
        if (!pending) throw new Error("expected a pending build");
        await runStore.startRun(startRunInputFixture(stateDir, "run-during-build"));
        const staleBuild = contextFixture(pending.input, pending.build);
        pending.deferred.resolve(staleBuild);

        await expect(rebuilding).resolves.toBe(staleBuild);
        expect(projectedBuild(staleBuild)).toBe(2);

        deferNextBuild = false;
        const current = await acquire(false);
        expect(current).not.toBe(staleBuild);
        expect(projectedBuild(current)).toBe(3);
        expect(builds).toBe(3);
      } finally {
        await server.stop();
      }
    });
  });

  it("streams durable projection revisions over the web events endpoint and closes clients on stop", async () => {
    const revisions = controllableRevisionProvider();
    const server = createStatusServer({
      generatedAt: () => "2026-01-01T00:00:00.000Z",
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
      revisionProviders: [revisions.provider],
    });
    const address = await server.start();
    let stopped = false;
    try {
      const response = await fetch(`http://${address.host}:${address.port}/api/v1/web/events`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(response.headers.get("cache-control")).toContain("no-cache");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("expected web events response body");

      const ready = await readResponseBodyUntil(reader, "event: projection_ready");
      expect(ready).toContain('data: {"type":"projection_ready","generation":0}');

      revisions.emit(2);
      const revision = await readResponseBodyUntil(reader, "revision\":2");
      expect(revision).toContain("id: 1");
      expect(revision).toContain("event: projection_revision");
      expect(revision).toContain('"source":"controllable"');
      expect(revision).toContain('"generation":1');

      const closed = readResponseBodyUntil(reader, "event: projection_closed");
      stopped = true;
      await server.stop();
      expect(await closed).toContain('data: {"type":"projection_closed"}');
    } finally {
      if (!stopped) await server.stop();
    }
  });

  it("functions without optional durable stores using TTL and runtime fingerprint behavior", async () => {
    let builds = 0;
    const server = createStatusServer({
      generatedAt: () => "2026-01-01T00:00:00.000Z",
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
      builder: (input) => {
        builds += 1;
        return contextFixture(input, builds);
      },
    });
    const acquire = acquireFrom(server);

    const completed = await acquire(false);
    await expect(acquire(false)).resolves.toBe(completed);
    expect(builds).toBe(1);
  });
});

function createStatusServer(input: {
  generatedAt: () => string;
  clock: () => Date;
  builder?: StatusServerWebProjectionContextBuilder;
  runtimeCounts?: () => Partial<ReturnType<ConstructorParameters<typeof StatusServer>[0]["orchestrator"]["snapshot"]>["counts"]>;
  revisionProvider?: () => { source: string; revision: string | number; observedAt: string | null };
  revisionProviders?: readonly WebProjectionRevisionProvider[];
  projectionReader?: StatusServerProjectionReader;
  runStore?: ConstructorParameters<typeof StatusServer>[0]["runStore"];
  lifecycleStore?: ConstructorParameters<typeof StatusServer>[0]["lifecycleStore"];
  writebackOutbox?: ConstructorParameters<typeof StatusServer>[0]["writebackOutbox"];
  tracker?: ConstructorParameters<typeof StatusServer>[0]["tracker"];
  staleThresholdMs?: number;
}): StatusServer {
  const revisionProviders: WebProjectionRevisionProvider[] = [...(input.revisionProviders ?? [])];
  if (input.revisionProvider) {
    revisionProviders.push({
      source: "test",
      getRevision: input.revisionProvider,
    });
  }
  const options: ConstructorParameters<typeof StatusServer>[0] = {
    orchestrator: fakeOrchestrator(input.generatedAt, input.runtimeCounts),
    workspaceManager: {} as ConstructorParameters<typeof StatusServer>[0]["workspaceManager"],
    workspaceOpener: {} as ConstructorParameters<typeof StatusServer>[0]["workspaceOpener"],
    host: "127.0.0.1",
    port: 0,
    openWorkspaceToken: null,
    trackerStateLists: testTrackerStateLists(),
    staleThresholdMs: input.staleThresholdMs ?? 300_000,
    webAssetsRoot: null,
    webProjectionContextClock: input.clock,
    ...(input.builder ? { webProjectionContextBuilder: input.builder } : {}),
    ...(input.tracker ? { tracker: input.tracker } : {}),
    ...(input.projectionReader ? { projectionReader: input.projectionReader } : {}),
    ...(input.runStore ? { runStore: input.runStore } : {}),
    ...(input.lifecycleStore ? { lifecycleStore: input.lifecycleStore } : {}),
    ...(input.writebackOutbox ? { writebackOutbox: input.writebackOutbox } : {}),
    ...(revisionProviders.length > 0 ? { webProjectionRevisionProviders: revisionProviders } : {}),
  };
  return new StatusServer(options);
}

function acquireFrom(server: StatusServer): (forceRefresh: boolean) => Promise<StatusServerWebProjectionContext> {
  const testable = server as TestableStatusServer;
  return (forceRefresh) => testable.acquireWebProjectionContext(forceRefresh);
}

function durableProjectionRevisionReader(revision: () => number, generatedAt: string): StatusServerProjectionReader {
  return {
    async readCurrentPayload() {
      return null;
    },
    async readCurrentRevision(selector) {
      const currentRevision = revision();
      return {
        projectionRevisionId: `${selector.projectionName}:${selector.scopeKind ?? "global"}:${selector.scopeKey ?? "global"}:${currentRevision}`,
        projectionName: selector.projectionName,
        scopeKind: selector.scopeKind ?? "global",
        scopeKey: selector.scopeKey ?? "global",
        revision: currentRevision,
        buildMode: currentRevision === 1 ? "bootstrap" : "incremental",
        sourceRevisions: [],
        sourceCursors: {},
        sourceFreshness: [],
        contentSha256: "0".repeat(64),
        generatedAt,
        expiresAt: null,
        supersededAt: null,
        createdAt: generatedAt,
      };
    },
  };
}

function contextFixture(
  input: StatusServerWebProjectionContextBuildInput,
  build: number,
): StatusServerWebProjectionContext {
  return {
    metadata: input.metadata,
    sourceIndex: sourceIndexFixture(input.snapshot.generatedAt, build, input.fingerprint.durableSourceRevisions),
    projections: { build, forceRefresh: input.forceRefresh },
  };
}

function projectedBuild(context: StatusServerWebProjectionContext): number {
  return context.projections.build as number;
}

function projectedForceRefresh(context: StatusServerWebProjectionContext): boolean {
  return context.projections.forceRefresh as boolean;
}

function sourceIndexFixture(
  generatedAt: string,
  build: number,
  durableSourceRevisions: StatusServerWebProjectionContext["sourceIndex"]["durableSourceRevisions"] = [
    { source: "test", revision: build, observedAt: generatedAt },
  ],
): StatusServerWebProjectionContext["sourceIndex"] {
  const snapshot = runtimeSnapshot(generatedAt);
  return {
    generatedAt,
    runtime: {
      generatedAt,
      snapshot,
      liveByIssueKey: new Map<string, never>(),
      runningByAlias: new Map<string, never>(),
    },
    trackerIssues: {
      status: "ok",
      fetchedStates: ["Todo", "In Progress", "In Review"],
      fetchedStateKey: "todo\0in progress\0in review",
      fetchedAt: generatedAt,
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
    durableSourceRevisions,
  };
}

function runtimeSnapshot(
  generatedAt: string,
  counts: Partial<ReturnType<ConstructorParameters<typeof StatusServer>[0]["orchestrator"]["snapshot"]>["counts"]> = {},
): ReturnType<ConstructorParameters<typeof StatusServer>[0]["orchestrator"]["snapshot"]> {
  return {
    generatedAt,
    counts: {
      running: counts.running ?? 0,
      retrying: counts.retrying ?? 0,
      paused: counts.paused ?? 0,
      providerGates: counts.providerGates ?? 0,
    },
    providerGates: [],
    providerGateCounts: { active: 0, manual: 0, autoResume: 0 },
    running: [],
    retrying: [],
    paused: [],
    totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
    rateLimits: null,
  };
}

function fakeOrchestrator(
  generatedAt: () => string,
  runtimeCounts?: () => Partial<ReturnType<ConstructorParameters<typeof StatusServer>[0]["orchestrator"]["snapshot"]>["counts"]>,
): ConstructorParameters<typeof StatusServer>[0]["orchestrator"] {
  return {
    snapshot() {
      return runtimeSnapshot(generatedAt(), runtimeCounts?.());
    },
    getIssueDetails() {
      return null;
    },
    async refreshNow() {
      return undefined;
    },
    pauseIssue() {
      return undefined;
    },
    resumeIssue() {
      return undefined;
    },
    async cancelIssue() {
      return undefined;
    },
    async createContinuationSummary(issueId: string) {
      return {
        summaryReference: {
          id: `summary:${issueId}`,
          kind: "continuation_history",
          summary: "summary",
          runIds: [],
          transcriptEventCount: 0,
          transcriptPointers: [],
          statusApiPointers: [],
          createdAt: generatedAt(),
        },
        lifecycle: { summaryReferences: [] },
      };
    },
  } as unknown as ConstructorParameters<typeof StatusServer>[0]["orchestrator"];
}

function testTrackerStateLists(): TrackerStateLists {
  return {
    activeStates: ["Todo", "In Progress"],
    handoffStates: ["In Review"],
    reviewStates: ["In Review"],
    blockedStates: ["Blocked"],
    terminalStates: ["Done", "Closed", "Cancelled", "Canceled", "Duplicate"],
  };
}

async function withTempStateDir<T>(fn: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(tmpdir(), "symphony-status-cache-"));
  try {
    return await fn(stateDir);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function startRunInputFixture(stateDir: string, runId: string): StartRunInput {
  return {
    runId,
    role: "worker",
    issueId: `issue-${runId}`,
    issueIdentifier: `ENG-${runId.toUpperCase()}`,
    attempt: 1,
    turnNumber: 1,
    prompt: `Prompt for ${runId}`,
    workspaceKey: `workspace-${runId}`,
    workspacePath: path.join(stateDir, `workspace-${runId}`),
  };
}

function workspaceRecordFixture(stateDir: string, workspaceKey: string): WorkspaceRecord {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    workspaceKey,
    issueId: `issue-${workspaceKey}`,
    issueIdentifier: `ENG-${workspaceKey.toUpperCase()}`,
    path: path.join(stateDir, workspaceKey),
    sourceKind: "worktree",
    createdAt: now,
    updatedAt: now,
  };
}

function writebackOperationFixture(id: string): NewWritebackOperation {
  return {
    idempotencyKey: `writeback:${id}`,
    kind: "comment",
    issueId: `issue-${id}`,
    payload: {
      body: `Body for ${id}`,
      dedupeKey: `dedupe:${id}`,
    },
  };
}

function controllableRevisionProvider(): {
  provider: WebProjectionRevisionProvider;
  emit(revision: number): void;
  listenerCount(): number;
} {
  const listeners = new Set<WebProjectionRevisionListener>();
  return {
    provider: {
      source: "controllable",
      getRevision: () => ({ source: "controllable", revision: 1, observedAt: null }),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    emit(revision: number) {
      for (const listener of Array.from(listeners)) {
        listener({ source: "controllable", revision, observedAt: null });
      }
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

async function readResponseBodyUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string): Promise<string> {
  const decoder = new TextDecoder();
  let body = "";
  while (!body.includes(needle)) {
    const next = await withTimeout(reader.read(), `timed out waiting for ${needle} in SSE body:\n${body}`);
    if (next.done) throw new Error(`response body closed before ${needle}:\n${body}`);
    body += decoder.decode(next.value, { stream: true });
  }
  return body;
}

async function withTimeout<T>(promise: Promise<T>, message: string, timeoutMs = 1_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function settleMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

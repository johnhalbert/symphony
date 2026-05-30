import { describe, expect, it } from "vitest";
import {
  StatusServer,
  WEB_PROJECTION_CONTEXT_TTL_MS,
  type StatusServerWebProjectionContext,
  type StatusServerWebProjectionContextBuildInput,
  type StatusServerWebProjectionContextBuilder,
} from "../src/app/http.js";
import { isWebProjectionRefreshRequested } from "../src/app/WebProjectionContext.js";
import type { TrackerStateLists } from "../src/core/types.js";

interface TestableStatusServer extends StatusServer {
  acquireWebProjectionContext(forceRefresh: boolean): Promise<StatusServerWebProjectionContext>;
}

describe("StatusServer web projection context cache", () => {
  it("reuses a completed context before the fixed TTL and rebuilds after expiry", async () => {
    const startedAt = Date.parse("2026-01-01T00:00:00.000Z");
    let nowMs = startedAt;
    let builds = 0;
    const server = createStatusServer({
      generatedAt: () => "2026-01-01T00:00:00.000Z",
      clock: () => new Date(nowMs),
      builder: (input) => {
        builds += 1;
        return contextFixture(input, builds);
      },
    });
    const acquire = acquireFrom(server);

    const first = await acquire(false);
    nowMs = startedAt + WEB_PROJECTION_CONTEXT_TTL_MS - 1;
    const second = await acquire(false);
    expect(second).toBe(first);
    expect(builds).toBe(1);

    nowMs = startedAt + WEB_PROJECTION_CONTEXT_TTL_MS;
    const expired = await acquire(false);
    expect(expired).not.toBe(first);
    expect(projectedBuild(expired)).toBe(2);
    expect(builds).toBe(2);
  });

  it("rebuilds before TTL expiry when the runtime or durable-source fingerprint changes", async () => {
    let generatedAt = "2026-01-01T00:00:00.000Z";
    let durableRevision = "revision-1";
    let builds = 0;
    const server = createStatusServer({
      generatedAt: () => generatedAt,
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

    generatedAt = "2026-01-01T00:00:01.000Z";
    const runtimeChanged = await acquire(false);
    expect(runtimeChanged).not.toBe(revisionChanged);
    expect(projectedBuild(runtimeChanged)).toBe(3);
    expect(builds).toBe(3);
  });

  it("coalesces concurrent non-refresh requests onto the same in-flight build", async () => {
    const pendingBuilds: Array<{
      build: number;
      input: StatusServerWebProjectionContextBuildInput;
      deferred: Deferred<StatusServerWebProjectionContext>;
    }> = [];
    let builds = 0;
    const server = createStatusServer({
      generatedAt: () => "2026-01-01T00:00:00.000Z",
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
    let builds = 0;
    let deferRefresh = false;
    const pendingRefreshBuilds: Array<{
      build: number;
      input: StatusServerWebProjectionContextBuildInput;
      deferred: Deferred<StatusServerWebProjectionContext>;
    }> = [];
    const server = createStatusServer({
      generatedAt: () => "2026-01-01T00:00:00.000Z",
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
    let generatedAt = "2026-01-01T00:00:00.000Z";
    let builds = 0;
    let failNext = false;
    const pendingFailure: { current: Deferred<StatusServerWebProjectionContext> | null } = { current: null };
    const server = createStatusServer({
      generatedAt: () => generatedAt,
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
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

    generatedAt = "2026-01-01T00:00:01.000Z";
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

    generatedAt = "2026-01-01T00:00:00.000Z";
    await expect(acquire(false)).resolves.toBe(completed);
    expect(builds).toBe(2);

    generatedAt = "2026-01-01T00:00:01.000Z";
    const retried = await acquire(false);
    expect(projectedBuild(retried)).toBe(3);
    expect(retried).not.toBe(completed);
    expect(builds).toBe(3);
  });
});

function createStatusServer(input: {
  generatedAt: () => string;
  clock: () => Date;
  builder: StatusServerWebProjectionContextBuilder;
  revisionProvider?: () => { source: string; revision: string | number; observedAt: string | null };
}): StatusServer {
  const options: ConstructorParameters<typeof StatusServer>[0] = {
    orchestrator: fakeOrchestrator(input.generatedAt),
    workspaceManager: {} as ConstructorParameters<typeof StatusServer>[0]["workspaceManager"],
    workspaceOpener: {} as ConstructorParameters<typeof StatusServer>[0]["workspaceOpener"],
    host: "127.0.0.1",
    port: 0,
    openWorkspaceToken: null,
    trackerStateLists: testTrackerStateLists(),
    staleThresholdMs: 300_000,
    webAssetsRoot: null,
    webProjectionContextClock: input.clock,
    webProjectionContextBuilder: input.builder,
    ...(input.revisionProvider
      ? {
          webProjectionRevisionProviders: [
            {
              source: "test",
              getRevision: input.revisionProvider,
            },
          ],
        }
      : {}),
  };
  return new StatusServer(options);
}

function acquireFrom(server: StatusServer): (forceRefresh: boolean) => Promise<StatusServerWebProjectionContext> {
  const testable = server as TestableStatusServer;
  return (forceRefresh) => testable.acquireWebProjectionContext(forceRefresh);
}

function contextFixture(
  input: StatusServerWebProjectionContextBuildInput,
  build: number,
): StatusServerWebProjectionContext {
  return {
    metadata: input.metadata,
    sourceIndex: sourceIndexFixture(input.snapshot.generatedAt, build),
    projections: { build, forceRefresh: input.forceRefresh },
  };
}

function projectedBuild(context: StatusServerWebProjectionContext): number {
  return context.projections.build as number;
}

function projectedForceRefresh(context: StatusServerWebProjectionContext): boolean {
  return context.projections.forceRefresh as boolean;
}

function sourceIndexFixture(generatedAt: string, build: number): StatusServerWebProjectionContext["sourceIndex"] {
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
    durableSourceRevisions: [{ source: "test", revision: build, observedAt: generatedAt }],
  };
}

function runtimeSnapshot(generatedAt: string): ReturnType<ConstructorParameters<typeof StatusServer>[0]["orchestrator"]["snapshot"]> {
  return {
    generatedAt,
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

function fakeOrchestrator(
  generatedAt: () => string,
): ConstructorParameters<typeof StatusServer>[0]["orchestrator"] {
  return {
    snapshot() {
      return runtimeSnapshot(generatedAt());
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

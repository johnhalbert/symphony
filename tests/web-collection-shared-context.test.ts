import { describe, expect, it } from "vitest";
import { StatusServer } from "../src/app/http.js";
import type { IssueLifecycleStore } from "../src/core/persistence/IssueLifecycleStore.js";
import type {
  RunRecord,
  RunTranscriptStore,
  TranscriptEvent,
  WorkspaceRecord,
} from "../src/core/persistence/RunTranscriptStore.js";
import type { TrackerClient } from "../src/core/tracker/TrackerClient.js";
import type { TrackerStateLists } from "../src/core/types.js";
import type { FileWritebackOutboxStore, WritebackOperation } from "../src/core/writeback/WritebackOutbox.js";

interface SourceCalls {
  fetchIssuesByStates: number;
  listRuns: number;
  listWorkspaces: number;
  listLifecycles: number;
  listWritebacks: number;
  getRun: number;
  readTranscript: number;
  readTranscriptTail: number;
  readTranscriptEventCount: number;
}

describe("/api/v1/web collection endpoints shared projection context", () => {
  it("coalesces a cold web collection burst through one context build and one raw source scan", async () => {
    const gate = deferred<void>();
    const { calls, tracker, runStore, lifecycleStore, writebackOutbox } = recordingSources({ gate });
    const server = createStatusServer({ tracker, runStore, lifecycleStore, writebackOutbox });
    const address = await server.start();
    const baseUrl = baseUrlFor(address);

    try {
      const requests = [
        "/api/v1/web/reference-data",
        "/api/v1/web/issues",
        "/api/v1/web/dashboard",
        "/api/v1/web/history",
        "/api/v1/web/sidebar",
      ].map((route) => getJson(`${baseUrl}${route}`));

      await waitFor(() =>
        calls.fetchIssuesByStates === 1 &&
        calls.listRuns === 1 &&
        calls.listWorkspaces === 1 &&
        calls.listLifecycles === 1 &&
        calls.listWritebacks === 1,
      );
      gate.resolve();

      const responses = await Promise.all(requests);
      expect(responses.map(({ response }) => response.status)).toEqual([200, 200, 200, 200, 200]);
      expect(Object.keys(responses[0]?.body as Record<string, unknown>).sort()).toEqual(["labels", "users"]);
      expect(Object.keys(responses[1]?.body as Record<string, unknown>).sort()).toEqual([
        "backlog",
        "cycleDateRange",
        "cycleLabel",
        "issues",
        "lanes",
        "selectedIssueId",
      ]);
      expect(Object.keys(responses[2]?.body as Record<string, unknown>)).toContain("activity");
      expect(Object.keys(responses[3]?.body as Record<string, unknown>).sort()).toEqual([
        "defaultSessionId",
        "sessions",
        "timeline",
        "transcriptBySession",
      ]);
      expect(Object.keys(responses[4]?.body as Record<string, unknown>)).toContain("reviewIssues");
      expect(calls).toMatchObject({
        fetchIssuesByStates: 1,
        listRuns: 1,
        listWorkspaces: 1,
        listLifecycles: 1,
        listWritebacks: 1,
        readTranscript: 0,
        readTranscriptTail: 0,
        readTranscriptEventCount: 0,
      });
    } finally {
      gate.resolve();
      await server.stop();
    }
  });

  it("routes refresh=1 and refresh=true through forced context rebuilds", async () => {
    const { calls, tracker, runStore, lifecycleStore, writebackOutbox } = recordingSources();
    const server = createStatusServer({ tracker, runStore, lifecycleStore, writebackOutbox });
    const address = await server.start();
    const baseUrl = baseUrlFor(address);

    try {
      await expectOk(getJson(`${baseUrl}/api/v1/web/dashboard`));
      expect(calls).toMatchObject({ fetchIssuesByStates: 1, listRuns: 1, listWorkspaces: 1 });

      await expectOk(getJson(`${baseUrl}/api/v1/web/history`));
      expect(calls).toMatchObject({ fetchIssuesByStates: 1, listRuns: 1, listWorkspaces: 1 });

      await expectOk(getJson(`${baseUrl}/api/v1/web/issues?refresh=1`));
      expect(calls).toMatchObject({ fetchIssuesByStates: 2, listRuns: 2, listWorkspaces: 2 });

      await expectOk(getJson(`${baseUrl}/api/v1/web/sidebar?refresh=true`));
      expect(calls).toMatchObject({ fetchIssuesByStates: 3, listRuns: 3, listWorkspaces: 3 });
    } finally {
      await server.stop();
    }
  });

  it("keeps the transcript endpoint outside shared collection context acquisition", async () => {
    const run = runFixture({ runId: "run-1", sessionId: "session-1" });
    const event = transcriptEventFixture(run.runId);
    const { calls, runStore } = recordingSources({ runs: [run], transcriptEventsByRunId: new Map([[run.runId, [event]]]) });
    let contextBuilds = 0;
    const server = createStatusServer({
      runStore,
      webProjectionContextBuilder: () => {
        contextBuilds += 1;
        throw new Error("transcript endpoint must not acquire the shared web projection context");
      },
    });
    const address = await server.start();

    try {
      const { response, body } = await getJson(`${baseUrlFor(address)}/api/v1/web/sessions/run-1/transcript`);
      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        messages: expect.arrayContaining([
          expect.objectContaining({ kind: "assistant", text: "transcript message" }),
        ]),
      });
      expect(contextBuilds).toBe(0);
      expect(calls).toMatchObject({ getRun: 1, listRuns: 0, readTranscript: 0, readTranscriptTail: 1 });
    } finally {
      await server.stop();
    }
  });
});

function createStatusServer(
  overrides: Partial<ConstructorParameters<typeof StatusServer>[0]> = {},
): StatusServer {
  const options: ConstructorParameters<typeof StatusServer>[0] = {
    orchestrator: fakeOrchestrator(),
    workspaceManager: {} as ConstructorParameters<typeof StatusServer>[0]["workspaceManager"],
    workspaceOpener: {} as ConstructorParameters<typeof StatusServer>[0]["workspaceOpener"],
    host: "127.0.0.1",
    port: 0,
    openWorkspaceToken: null,
    trackerStateLists: testTrackerStateLists(),
    staleThresholdMs: 300_000,
    webAssetsRoot: null,
    ...overrides,
  };
  return new StatusServer(options);
}

function recordingSources(options: {
  gate?: Deferred<void>;
  runs?: readonly RunRecord[];
  workspaces?: readonly WorkspaceRecord[];
  writebacks?: readonly WritebackOperation[];
  transcriptEventsByRunId?: ReadonlyMap<string, readonly TranscriptEvent[]>;
} = {}): {
  calls: SourceCalls;
  tracker: TrackerClient;
  runStore: RunTranscriptStore;
  lifecycleStore: IssueLifecycleStore;
  writebackOutbox: Pick<FileWritebackOutboxStore, "list">;
} {
  const calls: SourceCalls = {
    fetchIssuesByStates: 0,
    listRuns: 0,
    listWorkspaces: 0,
    listLifecycles: 0,
    listWritebacks: 0,
    getRun: 0,
    readTranscript: 0,
    readTranscriptTail: 0,
    readTranscriptEventCount: 0,
  };
  const waitForGate = async () => {
    await options.gate?.promise;
  };
  const runs = [...(options.runs ?? [])];
  const workspaces = [...(options.workspaces ?? [])];
  const writebacks = [...(options.writebacks ?? [])];
  const transcriptEventsByRunId = options.transcriptEventsByRunId ?? new Map<string, readonly TranscriptEvent[]>();

  return {
    calls,
    tracker: {
      async fetchIssuesByStates() {
        calls.fetchIssuesByStates += 1;
        await waitForGate();
        return [];
      },
    } as unknown as TrackerClient,
    runStore: {
      async listRuns() {
        calls.listRuns += 1;
        await waitForGate();
        return [...runs];
      },
      async listWorkspaces() {
        calls.listWorkspaces += 1;
        await waitForGate();
        return [...workspaces];
      },
      async getRun(runId: string) {
        calls.getRun += 1;
        return runs.find((run) => run.runId === runId) ?? null;
      },
      async readTranscriptEventCount(runId: string) {
        calls.readTranscriptEventCount += 1;
        return transcriptEventsByRunId.get(runId)?.length ?? 0;
      },
      async readTranscript(runId: string, input: { offset?: number; limit?: number } = {}) {
        calls.readTranscript += 1;
        const offset = input.offset ?? 0;
        const limit = input.limit ?? 100;
        const events = [...(transcriptEventsByRunId.get(runId) ?? [])];
        const page = events.slice(offset, offset + limit);
        const nextOffset = offset + page.length < events.length ? offset + page.length : null;
        return { runId, offset, limit, nextOffset, events: page };
      },
      async readTranscriptTail(runId: string, input: { limit?: number } = {}) {
        calls.readTranscriptTail += 1;
        const limit = input.limit ?? 100;
        const events = [...(transcriptEventsByRunId.get(runId) ?? [])];
        const offset = Math.max(0, events.length - limit);
        return { runId, offset, limit, nextOffset: null, events: events.slice(offset) };
      },
    } as unknown as RunTranscriptStore,
    lifecycleStore: {
      async list() {
        calls.listLifecycles += 1;
        await waitForGate();
        return [];
      },
    } as unknown as IssueLifecycleStore,
    writebackOutbox: {
      async list() {
        calls.listWritebacks += 1;
        await waitForGate();
        return writebacks;
      },
    },
  };
}

function fakeOrchestrator(): ConstructorParameters<typeof StatusServer>[0]["orchestrator"] {
  return {
    snapshot() {
      return {
        generatedAt: "2026-01-01T00:00:00.000Z",
        counts: { running: 0, retrying: 0, paused: 0, providerGates: 0 },
        providerGates: [],
        providerGateCounts: { active: 0, manual: 0, autoResume: 0 },
        running: [],
        retrying: [],
        paused: [],
        totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
        rateLimits: null,
      };
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

function runFixture(input: { runId: string; sessionId: string | null }): RunRecord {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    runId: input.runId,
    sessionId: input.sessionId,
    agentId: "agent-1",
    role: "worker",
    runPhase: "implementation",
    runKind: "implementation",
    issueId: "issue-1",
    issueIdentifier: "ENG-1",
    attempt: 1,
    turnNumber: 1,
    prompt: "Implement ENG-1",
    workspaceKey: "ENG-1",
    workspacePath: "/tmp/ENG-1",
    status: "running",
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    error: null,
    tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    transcriptEventCount: 1,
  };
}

function transcriptEventFixture(runId: string): TranscriptEvent {
  return {
    runId,
    sequence: 1,
    at: "2026-01-01T00:00:01.000Z",
    source: "harness",
    eventType: "progress",
    message: "transcript message",
  };
}

function baseUrlFor(address: { host: string; port: number }): string {
  return `http://${address.host}:${address.port}`;
}

async function getJson(url: string): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  expect(response.headers.get("content-type")).toContain("application/json");
  return { response, body: (await response.json()) as unknown };
}

async function expectOk(result: Promise<{ response: Response }>): Promise<void> {
  await expect(result.then(({ response }) => response.status)).resolves.toBe(200);
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for expected source calls");
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let settled = false;
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    reject = (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };
  });
  return { promise, resolve, reject };
}

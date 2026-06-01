import { describe, expect, it } from "vitest";
import { StatusServer, type StatusServerProjectionWriter } from "../src/app/http.js";
import type { ProjectionPayloadWriteInput, ProjectionWriteResult } from "../src/core/persistence/ProjectionTransactionService.js";
import type { RunRecord, RunTranscriptStore, TranscriptEvent } from "../src/core/persistence/RunTranscriptStore.js";
import type { TrackerStateLists } from "../src/core/types.js";

describe("web history/transcript durable projection writes", () => {
  it("persists bounded history projection rows after serving the canonical response", async () => {
    const projectionWriter = recordingProjectionWriter();
    const server = createStatusServer({
      runStore: runStoreFixture({
        runs: [
          runFixture({ runId: "run-older", issueIdentifier: "TEST-1", updatedAt: "2026-01-01T00:00:00.000Z" }),
          runFixture({ runId: "run-newer", issueIdentifier: "TEST-2", updatedAt: "2026-01-01T00:01:00.000Z" }),
        ],
      }),
      projectionWriter,
    });
    const address = await server.start();

    try {
      const { response, body } = await getJson(`${baseUrlFor(address)}/api/v1/web/history?sessionLimit=1&timelineLimit=5`);

      expect(response.status).toBe(200);
      expect(body.sessions.map((session: { id: string }) => session.id)).toEqual(["run-newer"]);
      expect(projectionWriter.writes).toHaveLength(1);
      expect(projectionWriter.writes[0]).toMatchObject({
        projectionName: "history_projection",
        scopeKind: "global_collection",
        scopeKey: "global:session:1:timeline:5",
        payload: body,
        sourceCursors: {
          sessionLimit: 1,
          timelineLimit: 5,
          sessionCount: 1,
          timelineCount: 4,
          activityCount: 4,
          defaultSessionId: "run-newer",
          runIds: ["run-newer"],
        },
        fields: { messageCount: 1 },
      });
      expect(projectionWriter.writes[0]?.sourceRevisions?.map((revision) => revision.source)).toEqual(
        expect.arrayContaining(["runs", "trackerIssues", "workspaces", "lifecycles", "writebacks"]),
      );
    } finally {
      await server.stop();
    }
  });

  it("persists transcript page projections with run/session/page fields and sanitized payload", async () => {
    const projectionWriter = recordingProjectionWriter();
    const run = runFixture({ runId: "run-1", sessionId: "session-1", transcriptEventCount: 3 });
    const server = createStatusServer({
      runStore: runStoreFixture({
        runs: [run],
        transcriptEventsByRunId: new Map([
          [
            run.runId,
            [
              transcriptEventFixture({ runId: run.runId, sequence: 1, message: "first" }),
              transcriptEventFixture({ runId: run.runId, sequence: 2, message: "visible assistant message" }),
              transcriptEventFixture({ runId: run.runId, sequence: 3, message: "third" }),
            ],
          ],
        ]),
      }),
      projectionWriter,
    });
    const address = await server.start();

    try {
      const { response, body } = await getJson(
        `${baseUrlFor(address)}/api/v1/web/sessions/session-1/transcript?offset=1&limit=1`,
      );

      expect(response.status).toBe(200);
      expect(body).toEqual(projectionWriter.writes[0]?.payload);
      expect(JSON.stringify(body)).toContain("visible assistant message");
      expect(projectionWriter.writes).toHaveLength(1);
      expect(projectionWriter.writes[0]).toMatchObject({
        projectionName: "transcript_projection",
        scopeKind: "run_page",
        scopeKey: "run-1:offset:1:limit:1",
        sourceCursors: {
          runId: "run-1",
          sessionId: "session-1",
          issueKey: "TEST-1",
          offset: 1,
          limit: 1,
          nextOffset: 2,
          eventCount: 1,
          firstSequence: 2,
          lastSequence: 2,
          lastEventAt: "2026-01-01T00:00:02.000Z",
        },
        fields: {
          issueKey: "TEST-1",
          runId: "run-1",
          sessionId: "session-1",
          offsetStart: 1,
          offsetLimit: 1,
          nextOffset: 2,
          messageCount: 3,
        },
      });
      expect(projectionWriter.writes[0]?.sourceRevisions?.map((revision) => revision.source)).toEqual([
        "runs",
        "transcript:run-1",
      ]);
    } finally {
      await server.stop();
    }
  });

  it("does not block status responses when optional projection persistence fails or no transcript run exists", async () => {
    const projectionWriter = recordingProjectionWriter({ fail: true });
    const server = createStatusServer({
      runStore: runStoreFixture({ runs: [runFixture({ runId: "run-1" })] }),
      projectionWriter,
    });
    const address = await server.start();

    try {
      const history = await getJson(`${baseUrlFor(address)}/api/v1/web/history`);
      const missingTranscript = await getJson(`${baseUrlFor(address)}/api/v1/web/sessions/missing/transcript`);

      expect(history.response.status).toBe(200);
      expect(history.body.sessions.map((session: { id: string }) => session.id)).toEqual(["run-1"]);
      expect(missingTranscript.response.status).toBe(200);
      expect(missingTranscript.body).toEqual([]);
      expect(projectionWriter.writes).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });
});

function createStatusServer(overrides: Partial<ConstructorParameters<typeof StatusServer>[0]> = {}): StatusServer {
  return new StatusServer({
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
  });
}

function recordingProjectionWriter(options: { fail?: boolean } = {}): StatusServerProjectionWriter & {
  writes: ProjectionPayloadWriteInput[];
} {
  const writes: ProjectionPayloadWriteInput[] = [];
  return {
    writes,
    async writeProjection(input: ProjectionPayloadWriteInput): Promise<ProjectionWriteResult> {
      writes.push(JSON.parse(JSON.stringify(input)) as ProjectionPayloadWriteInput);
      if (options.fail) throw new Error("simulated projection persistence failure");
      return { status: "written", revision: {} as ProjectionWriteResult["revision"], previousRevision: null, contentSha256: "", payloadSha256: "", event: null };
    },
  };
}

function runStoreFixture(options: {
  runs?: readonly RunRecord[];
  transcriptEventsByRunId?: ReadonlyMap<string, readonly TranscriptEvent[]>;
} = {}): RunTranscriptStore {
  const runs = [...(options.runs ?? [])];
  const transcriptEventsByRunId = options.transcriptEventsByRunId ?? new Map<string, readonly TranscriptEvent[]>();
  return {
    projectionRevision: () => 7,
    onProjectionChanged: () => () => undefined,
    async listRuns() {
      return [...runs];
    },
    async listWorkspaces() {
      return [];
    },
    async getRun(runId: string) {
      return runs.find((run) => run.runId === runId) ?? null;
    },
    async readTranscript(runId: string, input: { offset?: number; limit?: number } = {}) {
      const offset = input.offset ?? 0;
      const limit = input.limit ?? 100;
      const events = [...(transcriptEventsByRunId.get(runId) ?? [])];
      const page = events.slice(offset, offset + limit);
      const nextOffset = offset + page.length < events.length ? offset + page.length : null;
      return { runId, offset, limit, nextOffset, events: page };
    },
    async readTranscriptTail(runId: string, input: { limit?: number } = {}) {
      const limit = input.limit ?? 100;
      const events = [...(transcriptEventsByRunId.get(runId) ?? [])];
      const offset = Math.max(0, events.length - limit);
      return { runId, offset, limit, nextOffset: null, events: events.slice(offset) };
    },
    async readTranscriptEventCount(runId: string) {
      return transcriptEventsByRunId.get(runId)?.length ?? 0;
    },
  } as unknown as RunTranscriptStore;
}

function runFixture(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: "run-1",
    sessionId: "session-1",
    agentId: "agent-1",
    role: "worker",
    runPhase: "implementation",
    runKind: "implementation",
    issueId: "issue-1",
    issueIdentifier: "TEST-1",
    attempt: 1,
    turnNumber: 1,
    prompt: "Implement the issue",
    harnessId: "harness-1",
    runtimeModel: "claude-sonnet-4",
    workspaceKey: "TEST-1",
    workspacePath: "/tmp/workspaces/TEST-1",
    gitBranchName: "symphony/TEST-1",
    repoPath: "/tmp/repo",
    baseRef: "main",
    status: "succeeded",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:05:00.000Z",
    error: null,
    tokens: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    transcriptEventCount: 0,
    cancellationOutcome: "none",
    cancelFailed: false,
    ...overrides,
  };
}

function transcriptEventFixture(overrides: Partial<TranscriptEvent> = {}): TranscriptEvent {
  const sequence = overrides.sequence ?? 1;
  return {
    runId: "run-1",
    sequence,
    at: `2026-01-01T00:00:0${sequence}.000Z`,
    source: "runtime",
    eventType: "assistant",
    message: "assistant message",
    payload: { textPreview: overrides.message ?? "assistant message" },
    ...overrides,
  };
}

function fakeOrchestrator(): ConstructorParameters<typeof StatusServer>[0]["orchestrator"] {
  return {
    snapshot: () => ({
      generatedAt: "2026-01-01T00:00:00.000Z",
      counts: { running: 0, retrying: 0, paused: 0, providerGates: 0 },
      providerGates: [],
      providerGateCounts: { active: 0, manual: 0, autoResume: 0 },
      running: [],
      retrying: [],
      paused: [],
      totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
      rateLimits: null,
    }),
    refreshNow: async () => undefined,
  } as unknown as ConstructorParameters<typeof StatusServer>[0]["orchestrator"];
}

function testTrackerStateLists(): TrackerStateLists {
  return {
    activeStates: ["Todo", "In Progress"],
    blockedStates: ["Blocked"],
    handoffStates: ["In Review"],
    reviewStates: ["Ready to Merge"],
    terminalStates: ["Done", "Canceled"],
  };
}

function baseUrlFor(address: { host: string; port: number }): string {
  return `http://${address.host}:${address.port}`;
}

async function getJson(url: string): Promise<{ response: Response; body: any }> {
  const response = await fetch(url);
  return { response, body: await response.json() };
}

import { describe, expect, it } from "vitest";
import {
  StatusServer,
  type StatusServerOptions,
  type StatusServerProjectionWriter,
} from "../src/app/http.js";
import {
  RealtimeProjectionEventBus,
  serializeRealtimeEventData,
  type RealtimeProjectionEvent,
  type RealtimeProjectionEventType,
} from "../src/app/RealtimeProjectionEvents.js";
import {
  LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
  LEGACY_DEFAULT_PROJECT_CONTEXT_LABEL,
  LEGACY_DEFAULT_PROJECT_CONTEXT_ROUTING_SOURCE,
} from "../src/core/config/ProjectContexts.js";
import type { Orchestrator } from "../src/core/orchestrator/Orchestrator.js";
import type {
  ProjectionPayloadWriteInput,
  ProjectionSourceRevision,
  ProjectionRevisionPublication,
  ProjectionWriteResult,
} from "../src/core/persistence/ProjectionTransactionService.js";
import { normalizeProjectionSourceFreshnessList } from "../src/core/persistence/ProjectionSourceFreshness.js";
import {
  InMemoryRunActivityAppendStore,
  type RunActivityAppendInput,
  type RunActivityEventSourceStore,
} from "../src/core/persistence/RunActivityAppendStore.js";
import type { RunRecord, RunTranscriptStore } from "../src/core/persistence/RunTranscriptStore.js";
import type { TrackerStateLists } from "../src/core/types.js";

describe("StatusServer realtime projection events", () => {
  it("carry production-generated project context metadata across typed durable transcript publication events", async () => {
    const expectedPublicProjectContext = {
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      linearProjectSlug: "DOCS",
      routingSource: "candidate_poll",
    } as const;
    const projectionWriter = publishingProjectionWriter();
    const run = runFixture({
      runId: "run-docs-projection",
      sessionId: "session-docs-projection",
      issueId: "issue-docs-projection",
      issueIdentifier: "docs:ENG-428",
      transcriptEventCount: 2,
      projectContext: expectedPublicProjectContext,
    });
    const durableActivityStore = new InMemoryRunActivityAppendStore();
    const appended = await durableActivityStore.appendEvents([
      runActivityInputFixture({
        id: "activity-docs-1",
        runId: run.runId,
        projectContextId: "docs",
        sessionId: run.sessionId,
        sequence: 1,
        at: "2026-01-01T00:00:01.000Z",
        text: "durable transcript project context message 1",
      }),
      runActivityInputFixture({
        id: "activity-docs-2",
        runId: run.runId,
        projectContextId: "docs",
        sessionId: run.sessionId,
        sequence: 2,
        at: "2026-01-01T00:00:02.000Z",
        text: "durable transcript project context message 2",
      }),
    ]);
    expect(appended.rejected).toEqual([]);

    const durableReadCalls: Array<{
      runId: string;
      offset: number | undefined;
      limit: number | undefined;
      projectContextId: string | null;
    }> = [];
    let rawTranscriptReads = 0;
    const runActivitySourceStore: RunActivityEventSourceStore = {
      async readRunEvents(runId, options = {}) {
        durableReadCalls.push({
          runId,
          offset: options.offset,
          limit: options.limit,
          projectContextId: options.projectContextId ?? null,
        });
        return durableActivityStore.readRunEvents(runId, {
          ...(options.offset === undefined ? {} : { offset: options.offset }),
          ...(options.limit === undefined ? {} : { limit: options.limit }),
        });
      },
    };
    const server = createRealtimeServer({
      projectionWriter,
      runStore: runStoreFixture({
        runs: [run],
        beforeReadTranscript: () => {
          rawTranscriptReads += 1;
          throw new Error("project-context durable rebuild should use the run-activity source store");
        },
      }),
      runActivitySourceStore,
    });
    const address = await server.start();

    try {
      const client = await openSseClient(`http://${address.host}:${address.port}/api/v1/realtime`);
      try {
        await waitFor(() => server.activeRealtimeSubscriberCount() === 1, "SSE subscriber to register");

        const result = await server.rebuildDurableWebProjections({
          projections: ["transcript_projection"],
          transcriptPageLimit: 50,
        });

        expect(result.failed).toBe(0);
        expect(result.written).toBeGreaterThan(0);
        expect(rawTranscriptReads).toBe(0);
        expect(durableReadCalls.length).toBeGreaterThan(0);
        expect(durableReadCalls.every((call) => call.projectContextId === "docs")).toBe(true);

        const transcriptWrites = projectionWriter.writes.filter((write) => write.projectionName === "transcript_projection");
        expect(transcriptWrites.length).toBeGreaterThan(0);
        for (const write of transcriptWrites) {
          expect(projectContextFromSourceCursors(write.sourceCursors)).toEqual(expectedPublicProjectContext);
        }

        const projectionEvent = (await client.nextEventOfType("projection.updated")).data as RealtimeProjectionEvent;
        const sourceStatusEvent = (await client.nextEventOfType("source.status")).data as RealtimeProjectionEvent;
        const runEvent = (await client.nextEventOfType("run.updated")).data as RealtimeProjectionEvent;
        const transcriptEvent = (await client.nextEventOfType("transcript.delta")).data as RealtimeProjectionEvent;

        expect(projectionEvent).toMatchObject({
          type: "projection.updated",
          payload: {
            detail: {
              sourceCursors: {
                projectContext: expectedPublicProjectContext,
              },
            },
          },
        });
        expect(sourceStatusEvent).toMatchObject({
          type: "source.status",
          payload: {
            sourceCursors: {
              projectContext: expectedPublicProjectContext,
            },
          },
        });
        expect(runEvent).toMatchObject({
          type: "run.updated",
          payload: {
            issueIdentifier: "docs:ENG-428",
            detail: {
              sourceCursors: {
                projectContext: expectedPublicProjectContext,
              },
            },
          },
        });
        expect(transcriptEvent).toMatchObject({
          type: "transcript.delta",
          payload: {
            runId: "run-docs-projection",
            sessionId: "session-docs-projection",
            detail: {
              sourceCursors: {
                projectContext: expectedPublicProjectContext,
              },
            },
          },
        });

        expect(projectContextFromPayload(projectionEvent)).toEqual(expectedPublicProjectContext);
        expect(projectContextFromPayload(sourceStatusEvent)).toEqual(expectedPublicProjectContext);
        expect(projectContextFromPayload(runEvent)).toEqual(expectedPublicProjectContext);
        expect(projectContextFromPayload(transcriptEvent)).toEqual(expectedPublicProjectContext);
        expect(projectContextFromPayloadDetail(projectionEvent)).toEqual(expectedPublicProjectContext);
        expect(projectContextFromSourceStatusPayload(sourceStatusEvent)).toEqual(expectedPublicProjectContext);
        expect(projectContextFromPayloadDetail(runEvent)).toEqual(expectedPublicProjectContext);
        expect(projectContextFromPayloadDetail(transcriptEvent)).toEqual(expectedPublicProjectContext);
      } finally {
        await client.close();
        await waitFor(() => server.activeRealtimeSubscriberCount() === 0, "SSE subscriber to disconnect");
      }
    } finally {
      await server.stop();
    }
  });

  it("carry sanitized manually published project context metadata across typed durable transcript publication events", async () => {
    const projectionWriter = publishingProjectionWriter();
    const server = createRealtimeServer({ projectionWriter });
    const address = await server.start();

    try {
      const client = await openSseClient(`http://${address.host}:${address.port}/api/v1/realtime`);
      const expectedPublicProjectContext = {
        projectContextId: "docs",
        projectContextLabel: "Documentation Site",
        linearProjectSlug: "DOCS",
        routingSource: "candidate_poll",
        repository: "https://[redacted]@example.com/org/docs.git",
        path: "packages/site",
      } as const;

      try {
        await waitFor(() => server.activeRealtimeSubscriberCount() === 1, "SSE subscriber to register");

        projectionWriter.publish(
          projectionPublication({
            projectionName: "transcript_projection",
            scopeKind: "run_page",
            scopeKey: "run-docs-projection:0:50",
            projectionRevisionId: "projection-revision-docs-transcript",
            revision: 11,
            contentSha256: "transcript-sha",
            generatedAt: "2026-01-01T00:00:03.000Z",
            sourceRevisions: [
              { source: "runs", revision: 10, observedAt: "2026-01-01T00:00:02.000Z" },
              {
                source: "transcript:run-docs-projection",
                revision: "2:5:2026-01-01T00:00:02.500Z",
                observedAt: "2026-01-01T00:00:02.500Z",
              },
            ],
            sourceCursors: {
              runId: "run-docs-projection",
              sessionId: "session-docs-projection",
              issueKey: "docs:ENG-428",
              offset: 0,
              limit: 50,
              nextOffset: 2,
              eventCount: 2,
              firstSequence: 4,
              lastSequence: 5,
              lastEventAt: "2026-01-01T00:00:02.500Z",
              projectContext: {
                projectContextId: "docs",
                projectContextLabel: "Documentation Site",
                linearProjectSlug: "DOCS",
                routingSource: "candidate_poll",
                repository: "https://x-access-token:repo-secret@example.com/org/docs.git",
                path: "packages/site",
              },
            },
            sourceFreshness: [
              {
                source: "run_activity",
                status: "fresh",
                checkedAt: "2026-01-01T00:00:03.000Z",
                revision: 10,
                lastSuccessAt: "2026-01-01T00:00:03.000Z",
                lastErrorAt: null,
                staleMs: null,
                detail: "durable transcript projection is current",
              },
            ],
          }),
        );

        const projectionEvent = (await client.nextEventOfType("projection.updated")).data as RealtimeProjectionEvent;
        const sourceStatusEvent = (await client.nextEventOfType("source.status")).data as RealtimeProjectionEvent;
        const runEvent = (await client.nextEventOfType("run.updated")).data as RealtimeProjectionEvent;
        const transcriptEvent = (await client.nextEventOfType("transcript.delta")).data as RealtimeProjectionEvent;

        expect(projectionEvent).toMatchObject({
          type: "projection.updated",
          payload: {
            detail: {
              sourceCursors: {
                projectContext: expectedPublicProjectContext,
              },
            },
          },
        });
        expect(sourceStatusEvent).toMatchObject({
          type: "source.status",
          payload: {
            sourceCursors: {
              projectContext: expectedPublicProjectContext,
            },
          },
        });
        expect(runEvent).toMatchObject({
          type: "run.updated",
          payload: {
            issueIdentifier: "docs:ENG-428",
            detail: {
              sourceCursors: {
                projectContext: expectedPublicProjectContext,
              },
            },
          },
        });
        expect(transcriptEvent).toMatchObject({
          type: "transcript.delta",
          payload: {
            runId: "run-docs-projection",
            sessionId: "session-docs-projection",
            detail: {
              sourceCursors: {
                projectContext: expectedPublicProjectContext,
              },
            },
          },
        });

        expect(projectContextFromPayload(projectionEvent)).toEqual(expectedPublicProjectContext);
        expect(projectContextFromPayload(sourceStatusEvent)).toEqual(expectedPublicProjectContext);
        expect(projectContextFromPayload(runEvent)).toEqual(expectedPublicProjectContext);
        expect(projectContextFromPayload(transcriptEvent)).toEqual(expectedPublicProjectContext);
        expect(projectContextFromPayloadDetail(projectionEvent)).toEqual(expectedPublicProjectContext);
        expect(projectContextFromSourceStatusPayload(sourceStatusEvent)).toEqual(expectedPublicProjectContext);
        expect(projectContextFromPayloadDetail(runEvent)).toEqual(expectedPublicProjectContext);
        expect(projectContextFromPayloadDetail(transcriptEvent)).toEqual(expectedPublicProjectContext);

        const serialized = JSON.stringify([projectionEvent, sourceStatusEvent, runEvent, transcriptEvent]);
        expect(serialized).not.toContain("repo-secret");
        expect(serialized).not.toContain("x-access-token");
        expect(serialized).not.toContain("https://x-access-token:repo-secret@example.com/org/docs.git");
      } finally {
        await client.close();
        await waitFor(() => server.activeRealtimeSubscriberCount() === 0, "SSE subscriber to disconnect");
      }
    } finally {
      await server.stop();
    }
  });


  it("redacts raw project context metadata everywhere in published realtime event payloads", () => {
    const bus = new RealtimeProjectionEventBus({ clock: () => new Date("2026-01-01T00:00:00.000Z") });
    const secretUrl = "https://token:secret@example.com/org/docs.git";
    const expectedPublicProjectContext = {
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      linearProjectSlug: "DOCS",
      routingSource: "candidate_poll",
      repository: "https://[redacted]@example.com/org/docs.git",
      path: "packages/site",
    } as const;

    const event = bus.publish({
      type: "source.status",
      source: {
        source: "trackerIssues",
        revision: 1,
        observedAt: "2026-01-01T00:00:00.000Z",
      },
      detail: {
        status: "fresh",
        projectContext: {
          projectContextId: "docs",
          projectContextLabel: "Documentation Site",
          linearProjectSlug: "DOCS",
          routingSource: "candidate_poll",
          repository: secretUrl,
          path: "packages/site",
        },
        sourceCursors: {
          projectContext: {
            projectContextId: "docs",
            projectContextLabel: "Documentation Site",
            linearProjectSlug: "DOCS",
            routingSource: "candidate_poll",
            repository: secretUrl,
            path: "packages/site",
          },
        },
      },
    });

    expect(event.payload).toMatchObject({
      projectContext: expectedPublicProjectContext,
      detail: {
        projectContext: expectedPublicProjectContext,
        sourceCursors: {
          projectContext: expectedPublicProjectContext,
        },
      },
      sourceCursors: {
        projectContext: expectedPublicProjectContext,
      },
    });
    expect(event.detail).toMatchObject({
      projectContext: expectedPublicProjectContext,
      sourceCursors: {
        projectContext: expectedPublicProjectContext,
      },
    });

    const serialized = serializeRealtimeEventData(event);
    expect(serialized).not.toContain(secretUrl);
    expect(serialized).not.toContain("token:secret");
    expect(serialized).toContain("https://[redacted]@example.com/org/docs.git");
  });

  it("preserves duplicate identifier separation by carrying legacy/default project context on typed realtime projection events", () => {
    const bus = new RealtimeProjectionEventBus({ clock: () => new Date("2026-01-01T00:00:00.000Z") });
    const legacyDefaultProjectContext = {
      projectContextId: LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
      projectContextLabel: LEGACY_DEFAULT_PROJECT_CONTEXT_LABEL,
      linearProjectSlug: null,
      routingSource: LEGACY_DEFAULT_PROJECT_CONTEXT_ROUTING_SOURCE,
    } as const;
    const docsProjectContext = {
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      linearProjectSlug: "DOCS",
      routingSource: "candidate_poll",
    } as const;

    const legacyDefaultEvents = bus.publishProjectionRevision({
      source: "projection:transcript_projection:run_page",
      revision: 1,
      observedAt: "2026-01-01T00:00:00.000Z",
      detail: {
        projectionName: "transcript_projection",
        runId: "run-default-duplicate",
        sessionId: "session-default-duplicate",
        issueIdentifier: "ENG-428",
        sourceCursors: {
          runId: "run-default-duplicate",
          sessionId: "session-default-duplicate",
          issueKey: "ENG-428",
          projectContext: legacyDefaultProjectContext,
        },
      },
    });
    const docsEvents = bus.publishProjectionRevision({
      source: "projection:transcript_projection:run_page",
      revision: 2,
      observedAt: "2026-01-01T00:00:01.000Z",
      detail: {
        projectionName: "transcript_projection",
        runId: "run-docs-duplicate",
        sessionId: "session-docs-duplicate",
        issueIdentifier: "ENG-428",
        sourceCursors: {
          runId: "run-docs-duplicate",
          sessionId: "session-docs-duplicate",
          issueKey: "ENG-428",
          projectContext: docsProjectContext,
        },
      },
    });

    for (const type of ["projection.updated", "source.status", "run.updated", "transcript.delta"] as const) {
      expect(projectContextFromPayload(eventOfType(legacyDefaultEvents, type))).toEqual(legacyDefaultProjectContext);
      expect(projectContextFromPayload(eventOfType(docsEvents, type))).toEqual(docsProjectContext);
    }

    const legacyDefaultRunEvent = eventOfType(legacyDefaultEvents, "run.updated");
    const docsRunEvent = eventOfType(docsEvents, "run.updated");
    expect(legacyDefaultRunEvent.payload).toMatchObject({
      issueIdentifier: "ENG-428",
      projectContext: legacyDefaultProjectContext,
    });
    expect(docsRunEvent.payload).toMatchObject({
      issueIdentifier: "ENG-428",
      projectContext: docsProjectContext,
    });
    expect(projectContextFromPayload(legacyDefaultRunEvent)).not.toEqual(projectContextFromPayload(docsRunEvent));

    expect(eventOfType(legacyDefaultEvents, "transcript.delta").payload).toMatchObject({
      runId: "run-default-duplicate",
      sessionId: "session-default-duplicate",
      projectContext: legacyDefaultProjectContext,
    });
    expect(eventOfType(docsEvents, "transcript.delta").payload).toMatchObject({
      runId: "run-docs-duplicate",
      sessionId: "session-docs-duplicate",
      projectContext: docsProjectContext,
    });
  });

});

type ProjectionWriterForTest = StatusServerProjectionWriter & {
  writes: ProjectionPayloadWriteInput[];
  publish(publication: ProjectionRevisionPublication): void;
};

type ParsedSseEvent = {
  id: string;
  event: string;
  data: unknown;
  raw: string;
};

type SseTestClient = {
  nextEvent(timeoutMs?: number): Promise<ParsedSseEvent>;
  nextEventOfType(type: RealtimeProjectionEventType, timeoutMs?: number): Promise<ParsedSseEvent>;
  close(): Promise<void>;
};

function createRealtimeServer(options: {
  projectionWriter: ProjectionWriterForTest;
  runStore?: RunTranscriptStore;
  runActivitySourceStore?: RunActivityEventSourceStore;
}): StatusServer {
  return new StatusServer({
    orchestrator: fakeOrchestrator(),
    workspaceManager: {} as StatusServerOptions["workspaceManager"],
    workspaceOpener: {} as StatusServerOptions["workspaceOpener"],
    ...(options.runStore ? { runStore: options.runStore } : {}),
    ...(options.runActivitySourceStore ? { runActivitySourceStore: options.runActivitySourceStore } : {}),
    projectionWriter: options.projectionWriter,
    host: "127.0.0.1",
    port: 0,
    openWorkspaceToken: null,
    trackerStateLists: testTrackerStateLists(),
    staleThresholdMs: 300_000,
  });
}

function projectionPublication(overrides: Partial<ProjectionRevisionPublication> = {}): ProjectionRevisionPublication {
  return {
    projectionName: "history_projection",
    projectContextId: "default",
    scopeKind: "global",
    scopeKey: "global",
    projectionRevisionId: "projection-revision-default",
    revision: 1,
    buildMode: "bootstrap",
    contentSha256: "projection-sha",
    generatedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    sourceRevisions: [],
    sourceCursors: {},
    sourceFreshness: [],
    ...overrides,
  };
}

function publishingProjectionWriter(): ProjectionWriterForTest {
  const listeners = new Set<(event: ProjectionRevisionPublication) => void>();
  const writes: ProjectionPayloadWriteInput[] = [];
  const revisionsByKey = new Map<string, number>();
  const publish = (publication: ProjectionRevisionPublication): void => {
    const cloned = cloneJson(publication);
    for (const listener of Array.from(listeners)) listener(cloned);
  };
  return {
    writes,
    async writeProjection(input: ProjectionPayloadWriteInput): Promise<ProjectionWriteResult> {
      const stored = cloneJson(input);
      writes.push(stored);
      const key = projectionRowKey(stored);
      const revisionNumber = (revisionsByKey.get(key) ?? 0) + 1;
      revisionsByKey.set(key, revisionNumber);
      const requestedBuildMode = stored.buildMode ?? "incremental";
      const buildMode = revisionNumber === 1 ? "bootstrap" : requestedBuildMode;
      const generatedAt = normalizeGeneratedAt(stored.generatedAt);
      const publication = projectionPublication({
        projectionName: stored.projectionName,
        projectContextId: stored.projectContextId ?? "default",
        scopeKind: stored.scopeKind ?? "global",
        scopeKey: stored.scopeKey ?? "global",
        projectionRevisionId: `${key}:${revisionNumber}`,
        revision: revisionNumber,
        buildMode,
        contentSha256:
          typeof stored.contentSha256 === "string" && stored.contentSha256.length > 0
            ? stored.contentSha256
            : `${key}:content:${revisionNumber}`,
        generatedAt,
        expiresAt: normalizeOptionalTimestamp(stored.expiresAt),
        sourceRevisions: normalizeSourceRevisionsForPublication(stored.sourceRevisions),
        sourceCursors: cloneJson(stored.sourceCursors ?? {}),
        sourceFreshness: normalizeSourceFreshnessForPublication(stored.sourceFreshness, generatedAt),
      });
      publish(publication);
      return {
        status: "written",
        revision: { revision: revisionNumber, buildMode } as ProjectionWriteResult["revision"],
        previousRevision: null,
        requestedBuildMode,
        buildMode,
        contentSha256: publication.contentSha256,
        payloadSha256: typeof stored.payloadSha256 === "string" ? stored.payloadSha256 : "",
        event: publication,
      };
    },
    onProjectionChanged(listener: (event: ProjectionRevisionPublication) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish,
  };
}

function projectionRowKey(input: ProjectionPayloadWriteInput): string {
  return [input.projectionName, input.projectContextId ?? "default", input.scopeKind ?? "global", input.scopeKey ?? "global"].join("::");
}

function normalizeGeneratedAt(value: ProjectionPayloadWriteInput["generatedAt"]): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim().length > 0) return value;
  return "2026-01-01T00:00:00.000Z";
}

function normalizeOptionalTimestamp(value: ProjectionPayloadWriteInput["expiresAt"]): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function normalizeSourceRevisionsForPublication(
  value: ProjectionPayloadWriteInput["sourceRevisions"],
): ProjectionRevisionPublication["sourceRevisions"] {
  return (value ?? []).map((revision): ProjectionSourceRevision => ({
    source: revision.source,
    revision: revision.revision,
    observedAt: typeof revision.observedAt === "string" && revision.observedAt.trim().length > 0 ? revision.observedAt : null,
  }));
}

function normalizeSourceFreshnessForPublication(
  value: ProjectionPayloadWriteInput["sourceFreshness"],
  defaultCheckedAt: string,
): ProjectionRevisionPublication["sourceFreshness"] {
  return normalizeProjectionSourceFreshnessList(value ?? [], { defaultCheckedAt });
}

function cloneJson<T>(input: T): T {
  return JSON.parse(JSON.stringify(input)) as T;
}

function runStoreFixture(options: {
  runs?: readonly RunRecord[];
  beforeReadTranscript?: () => void;
} = {}): RunTranscriptStore {
  const runs = [...(options.runs ?? [])];
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
      options.beforeReadTranscript?.();
      return {
        runId,
        offset: input.offset ?? 0,
        limit: input.limit ?? 100,
        nextOffset: null,
        events: [],
      };
    },
    async readTranscriptTail(runId: string, input: { limit?: number } = {}) {
      options.beforeReadTranscript?.();
      return {
        runId,
        offset: 0,
        limit: input.limit ?? 100,
        nextOffset: null,
        events: [],
      };
    },
    async readTranscriptEventCount(runId: string) {
      return runs.find((run) => run.runId === runId)?.transcriptEventCount ?? 0;
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

function runActivityInputFixture(overrides: Record<string, unknown> = {}): RunActivityAppendInput {
  return {
    id: "activity-1",
    runId: "run-1",
    projectContextId: "default",
    sessionId: "session-1",
    at: "2026-01-01T00:00:01.000Z",
    harnessId: "runtime-adapter",
    actor: "runtime",
    channel: "status",
    kind: "runtime_log",
    text: "runtime event",
    payload: {},
    protocol: "json_rpc",
    ...overrides,
  } as RunActivityAppendInput;
}

function fakeOrchestrator(): Orchestrator {
  return {
    snapshot() {
      return {
        generatedAt: "2026-01-01T00:10:00.000Z",
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
    async createContinuationSummary(issueId: string) {
      return {
        summaryReference: {
          id: `fake-summary:${issueId}`,
          kind: "continuation_history",
          summary: "fake summary",
          runIds: [],
          transcriptEventCount: 0,
          transcriptPointers: [],
          statusApiPointers: [],
          createdAt: "2026-01-01T00:00:00Z",
        },
        lifecycle: { summaryReferences: [] },
      };
    },
    async dispatchOrchestratorChatCommand() {
      return { status: "accepted", reason: "accepted", acceptedAt: "2026-01-01T00:00:00.000Z" };
    },
  } as unknown as Orchestrator;
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

async function openSseClient(url: string, headers: Record<string, string> = {}): Promise<SseTestClient> {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  const body = response.body;
  if (!body) throw new Error("SSE response did not include a body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const nextRawBlock = async (timeoutMs = 2_000, description = "SSE block"): Promise<string> => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const delimiter = buffer.indexOf("\n\n");
      if (delimiter >= 0) {
        const raw = buffer.slice(0, delimiter);
        buffer = buffer.slice(delimiter + 2);
        return raw;
      }
      const chunk = await withTimeout(reader.read(), timeoutMs - (Date.now() - startedAt), description);
      if (chunk.done) throw new Error(`SSE stream closed before ${description === "SSE event" ? "an event" : "a block"} was available`);
      buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
    }
    throw new Error(`Timed out waiting for ${description}`);
  };

  const nextEvent = async (timeoutMs = 2_000): Promise<ParsedSseEvent> => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const event = parseSseBlock(await nextRawBlock(timeoutMs - (Date.now() - startedAt), "SSE event"));
      if (event) return event;
    }
    throw new Error("Timed out waiting for SSE event");
  };

  return {
    nextEvent,
    async nextEventOfType(type: RealtimeProjectionEventType, timeoutMs = 2_000): Promise<ParsedSseEvent> {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        const event = await nextEvent(timeoutMs - (Date.now() - startedAt));
        if (event.event === type) return event;
      }
      throw new Error(`Timed out waiting for SSE event type ${type}`);
    },
    async close(): Promise<void> {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    },
  };
}

function parseSseBlock(raw: string): ParsedSseEvent | null {
  let id = "";
  let event = "";
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0 || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator >= 0 ? line.slice(0, separator) : line;
    const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, "") : "";
    if (field === "id") id = value;
    if (field === "event") event = value;
    if (field === "data") data.push(value);
  }
  if (data.length === 0) return null;
  return { id, event, data: JSON.parse(data.join("\n")), raw };
}

async function waitFor(predicate: () => boolean, description: string, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate(), `Timed out waiting for ${description}`).toBe(true);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, description: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function eventOfType<TType extends RealtimeProjectionEventType>(
  events: readonly RealtimeProjectionEvent[],
  type: TType,
): RealtimeProjectionEvent<TType> {
  const event = events.find((candidate) => candidate.type === type);
  if (!event) throw new Error(`Expected realtime event of type ${type}`);
  return event as RealtimeProjectionEvent<TType>;
}

function projectContextFromPayload(event: RealtimeProjectionEvent): Readonly<Record<string, unknown>> | null {
  const payload = asRecord(event.payload);
  return asRecord(payload?.projectContext);
}

function projectContextFromPayloadDetail(event: RealtimeProjectionEvent): Readonly<Record<string, unknown>> | null {
  const payload = asRecord(event.payload);
  const detail = asRecord(payload?.detail);
  const sourceCursors = asRecord(detail?.sourceCursors);
  return asRecord(sourceCursors?.projectContext);
}

function projectContextFromSourceStatusPayload(event: RealtimeProjectionEvent): Readonly<Record<string, unknown>> | null {
  const payload = asRecord(event.payload);
  const sourceCursors = asRecord(payload?.sourceCursors);
  return asRecord(sourceCursors?.projectContext);
}

function projectContextFromSourceCursors(sourceCursors: unknown): Readonly<Record<string, unknown>> | null {
  const record = asRecord(sourceCursors);
  return asRecord(record?.projectContext);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

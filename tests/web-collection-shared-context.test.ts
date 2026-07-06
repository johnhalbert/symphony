import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StatusServer, type StatusServerProjectionWriter } from "../src/app/http.js";
import { FileIssueLifecycleStore } from "../src/core/persistence/IssueLifecycleStore.js";
import type { IssueLifecycleStore } from "../src/core/persistence/IssueLifecycleStore.js";
import {
  DEFAULT_ORCHESTRATOR_CONVERSATION_ID,
  FileOrchestratorConversationStore,
  type OrchestratorConversationStore,
} from "../src/core/persistence/OrchestratorConversationStore.js";
import { FileRunTranscriptStore } from "../src/core/persistence/RunTranscriptStore.js";
import type {
  RunRecord,
  RunTranscriptStore,
  TranscriptEvent,
  WorkspaceRecord,
} from "../src/core/persistence/RunTranscriptStore.js";
import type { ProjectionPayloadRecord, ProjectionRevisionSelector } from "../src/core/persistence/ProjectionTransactionService.js";
import type { TrackerClient } from "../src/core/tracker/TrackerClient.js";
import type { Issue, TrackerStateLists } from "../src/core/types.js";
import { FileWritebackOutboxStore, type WritebackOperation } from "../src/core/writeback/WritebackOutbox.js";
import { generateLargeHistoryFixture } from "../scripts/generate-large-history-fixture.js";

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
  getConversation: number;
  listMessages: number;
}

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

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

  it("coalesces large fixture collection routes through one shared projection scan and bounded sidebar chat tail", async () => {
    const { calls, tracker, runStore, lifecycleStore, writebackOutbox, orchestratorConversationStore, manifest } = await largeFixtureSources({
      issueCount: 18,
      runsPerIssue: 5,
      eventsPerRun: 16,
      writebacksPerIssue: 4,
      issuePrefix: "BP",
    });
    const server = createStatusServer({ tracker, runStore, lifecycleStore, writebackOutbox, orchestratorConversationStore });
    const address = await server.start();
    const baseUrl = baseUrlFor(address);

    try {
      const [referenceDataResult, issueBoardResult, dashboardResult, historyResult, sidebarResult] = await Promise.all([
        getJson(`${baseUrl}/api/v1/web/reference-data`),
        getJson(`${baseUrl}/api/v1/web/issues`),
        getJson(`${baseUrl}/api/v1/web/dashboard`),
        getJson(`${baseUrl}/api/v1/web/history?sessionLimit=12&timelineLimit=18`),
        getJson(`${baseUrl}/api/v1/web/sidebar`),
      ]);

      const referenceData = referenceDataResult.body as { labels: Record<string, unknown>; users: Record<string, unknown> };
      const issueBoard = issueBoardResult.body as { issues: Array<{ id: string }>; lanes: Record<string, unknown> };
      const dashboard = dashboardResult.body as { activity: unknown[]; totals: Record<string, unknown> };
      const history = historyResult.body as {
        sessions: Array<{ id: string }>;
        timeline: unknown[];
        transcriptBySession: Record<string, unknown[]>;
      };
      const sidebar = sidebarResult.body as { reviewIssues: unknown[]; sessions: unknown[]; chat: unknown[] };
      const endpointDiagnostics = {
        referenceData: {
          status: referenceDataResult.response.status,
          labelCount: Object.keys(referenceData.labels).length,
          hasUnassigned: Object.keys(referenceData.users).includes("unassigned"),
        },
        issueBoard: {
          status: issueBoardResult.response.status,
          issueCount: issueBoard.issues.length,
          laneKeys: Object.keys(issueBoard.lanes).sort(),
        },
        dashboard: {
          status: dashboardResult.response.status,
          activityCount: dashboard.activity.length,
          hasOpenTotal: Object.keys(dashboard.totals).includes("open"),
        },
        history: {
          status: historyResult.response.status,
          sessionCount: history.sessions.length,
          timelineCount: history.timeline.length,
          transcriptSessionCount: Object.keys(history.transcriptBySession).length,
        },
        sidebar: {
          status: sidebarResult.response.status,
          reviewIssueCount: sidebar.reviewIssues.length,
          sessionCount: sidebar.sessions.length,
          chatCount: sidebar.chat.length,
        },
      };

      expect(endpointDiagnostics).toMatchObject({
        referenceData: { status: 200, hasUnassigned: true },
        issueBoard: { status: 200, issueCount: manifest.counts.issues, laneKeys: ["progress", "review", "todo"] },
        dashboard: { status: 200, hasOpenTotal: true },
        history: { status: 200, sessionCount: 12, timelineCount: 18 },
        sidebar: { status: 200, chatCount: 100 },
      });
      expect(endpointDiagnostics.referenceData.labelCount).toBeGreaterThan(0);
      expect(endpointDiagnostics.dashboard.activityCount).toBeGreaterThan(0);
      expect(endpointDiagnostics.sidebar.reviewIssueCount).toBeGreaterThan(0);
      expect(endpointDiagnostics.sidebar.sessionCount).toBeGreaterThan(0);
      expect(calls).toMatchObject({
        fetchIssuesByStates: 1,
        listRuns: 1,
        listWorkspaces: 1,
        listLifecycles: 1,
        listWritebacks: 1,
        getConversation: 1,
        listMessages: 1,
        readTranscript: 0,
        readTranscriptTail: 0,
        readTranscriptEventCount: 0,
      });
    } finally {
      await server.stop();
    }
  });

  it("keeps large fixture transcript reads bounded across cold, warm durable, and refresh reads", async () => {
    const { calls, tracker, runStore, lifecycleStore, writebackOutbox, orchestratorConversationStore, manifest } = await largeFixtureSources({
      issueCount: 4,
      runsPerIssue: 2,
      eventsPerRun: 640,
      writebacksPerIssue: 1,
      issuePrefix: "TX",
    });
    const runId = manifest.issues[0]?.runIds.at(-1);
    if (!runId) throw new Error("expected transcript fixture run id");
    const transcriptOffset = 640 - 500;
    const coldServer = createStatusServer({ tracker, runStore, lifecycleStore, writebackOutbox, orchestratorConversationStore });
    const coldAddress = await coldServer.start();
    const coldBaseUrl = baseUrlFor(coldAddress);
    const coldUrl = `${coldBaseUrl}/api/v1/web/sessions/${runId}/transcript`;
    let coldBody: { messages: Array<{ kind?: string; text?: string }> } = { messages: [] };
    let coldDelta: SourceCalls;

    try {
      const coldBefore = copySourceCalls(calls);
      const coldResult = await getJson(coldUrl);
      coldDelta = diffSourceCalls(coldBefore, calls);
      coldBody = coldResult.body as { messages: Array<{ kind?: string; text?: string }> };
      const coldMessages = coldBody.messages;
      expect(coldResult.response.status).toBe(200);
      expect(coldMessages.length).toBeLessThanOrEqual(502);
      expect(coldMessages.slice(0, 2).map((message) => message.kind ?? null)).toEqual(["system", "user"]);
      expect(coldMessages.some((message) => message.kind === "assistant")).toBe(true);
    } finally {
      await coldServer.stop();
    }

    const warmTranscriptSelector = {
      projectionName: "transcript_projection",
      scopeKind: "run_page",
      scopeKey: `${runId}:offset:${transcriptOffset}:limit:500`,
    };
    const durableReader = new StaticProjectionRecordReader([
      projectionPayloadRecord(warmTranscriptSelector, coldBody, [
        { source: "runStore", revision: runStore.projectionRevision(), observedAt: null },
      ]),
    ]);
    const warmServer = createStatusServer({
      tracker,
      runStore,
      lifecycleStore,
      writebackOutbox,
      orchestratorConversationStore,
      projectionReader: durableReader,
      webProjectionRevisionProviders: [],
    });
    const warmAddress = await warmServer.start();
    const warmBaseUrl = baseUrlFor(warmAddress);
    const warmTranscriptUrl = `${warmBaseUrl}/api/v1/web/sessions/${runId}/transcript?offset=${transcriptOffset}&limit=500`;

    try {
      const warmBefore = copySourceCalls(calls);
      const warmResult = await getJson(warmTranscriptUrl);
      const warmDelta = diffSourceCalls(warmBefore, calls);
      const warmBody = warmResult.body as { messages: Array<{ kind?: string; text?: string }> };
      const warmMessages = warmBody.messages;

      const refreshBefore = copySourceCalls(calls);
      const refreshResult = await getJson(`${warmTranscriptUrl}&refresh=1`);
      const refreshDelta = diffSourceCalls(refreshBefore, calls);
      const refreshBody = refreshResult.body as { messages: Array<{ kind?: string; text?: string }> };
      const refreshMessages = refreshBody.messages;

      const transcriptDiagnostics = {
        cold: {
          status: 200,
          messageCount: coldBody.messages.length,
          delta: coldDelta,
        },
        warm: {
          status: warmResult.response.status,
          messageCount: warmMessages.length,
          delta: warmDelta,
          selectors: durableReader.selectors.map((selector) => selector.scopeKey),
        },
        refresh: {
          status: refreshResult.response.status,
          messageCount: refreshMessages.length,
          delta: refreshDelta,
        },
      };

      expect(transcriptDiagnostics).toMatchObject({
        cold: {
          status: 200,
          delta: { getRun: 2, listRuns: 0, readTranscript: 0, readTranscriptTail: 1, readTranscriptEventCount: 1 },
        },
        warm: {
          status: 200,
          delta: { getRun: 1, listRuns: 0, readTranscript: 0, readTranscriptTail: 0, readTranscriptEventCount: 0 },
          selectors: [`pc=default|${warmTranscriptSelector.scopeKey}`, warmTranscriptSelector.scopeKey],
        },
        refresh: {
          status: 200,
          delta: { getRun: 2, listRuns: 0, readTranscript: 1, readTranscriptTail: 0, readTranscriptEventCount: 1 },
        },
      });
      expect(warmMessages).toEqual(coldBody.messages);
      expect(refreshMessages).toEqual(coldBody.messages);
    } finally {
      await warmServer.stop();
    }
  });

  it("keeps large fixture orchestrator chat reads bounded across cold, warm durable, and refresh reads", async () => {
    const { calls, tracker, runStore, lifecycleStore, writebackOutbox, orchestratorConversationStore, manifest } = await largeFixtureSources({
      issueCount: 12,
      runsPerIssue: 4,
      eventsPerRun: 18,
      writebacksPerIssue: 2,
      issuePrefix: "OC",
    });
    expect(manifest.counts.orchestratorMessages).toBeGreaterThan(100);
    const chatUrlPath = `/api/v1/web/orchestrator-chat?conversationId=${encodeURIComponent(DEFAULT_ORCHESTRATOR_CONVERSATION_ID)}`;

    const coldServer = createStatusServer({ tracker, runStore, lifecycleStore, writebackOutbox, orchestratorConversationStore });
    const coldAddress = await coldServer.start();
    const coldBaseUrl = baseUrlFor(coldAddress);
    let coldBody: {
      chat: Array<{ text?: string; conversationId?: string }>;
      source?: { conversationId?: string; revision?: string };
    } = { chat: [] };
    let coldDelta: SourceCalls;

    try {
      const coldBefore = copySourceCalls(calls);
      const coldResult = await getJson(`${coldBaseUrl}${chatUrlPath}`);
      coldDelta = diffSourceCalls(coldBefore, calls);
      coldBody = coldResult.body as {
        chat: Array<{ text?: string; conversationId?: string }>;
        source?: { conversationId?: string; revision?: string };
      };
      expect(coldResult.response.status).toBe(200);
      expect(coldBody.chat).toHaveLength(100);
      expect(coldBody.source?.conversationId).toBe(DEFAULT_ORCHESTRATOR_CONVERSATION_ID);
      expect(coldBody.chat.map((message) => message.text ?? "")).not.toContain(
        "Summarize durable projection coverage for OC-0001 run 01.",
      );
      expect(coldBody.chat.at(-1)?.text).toBe(
        "Cached dashboard, issue board, history, sidebar, transcript, and chat projections are ready for OC-0012.",
      );
    } finally {
      await coldServer.stop();
    }

    const warmChatSelector = {
      projectionName: "orchestrator_chat_projection",
      scopeKind: "conversation",
      scopeKey: DEFAULT_ORCHESTRATOR_CONVERSATION_ID,
    };
    const durableReader = new StaticProjectionRecordReader([
      projectionPayloadRecord(warmChatSelector, coldBody, [
        {
          source: `orchestrator_conversations:${DEFAULT_ORCHESTRATOR_CONVERSATION_ID}`,
          revision: coldBody.source?.revision ?? String(orchestratorConversationStore.projectionRevision()),
          observedAt: null,
        },
      ]),
    ]);
    const projectionWriter = recordingProjectionWriter();
    const warmServer = createStatusServer({
      tracker,
      runStore,
      lifecycleStore,
      writebackOutbox,
      orchestratorConversationStore,
      projectionReader: durableReader,
      projectionWriter,
      webProjectionRevisionProviders: [],
    });
    const warmAddress = await warmServer.start();
    const warmBaseUrl = baseUrlFor(warmAddress);
    const warmChatUrl = `${warmBaseUrl}${chatUrlPath}`;

    try {
      const warmBefore = copySourceCalls(calls);
      const warmResult = await getJson(warmChatUrl);
      const warmDelta = diffSourceCalls(warmBefore, calls);
      const warmBody = warmResult.body as {
        chat: Array<{ text?: string; conversationId?: string }>;
        source?: { conversationId?: string; revision?: string };
      };

      const refreshBefore = copySourceCalls(calls);
      const refreshResult = await getJson(`${warmChatUrl}&refresh=1`);
      const refreshDelta = diffSourceCalls(refreshBefore, calls);
      const refreshBody = refreshResult.body as {
        chat: Array<{ text?: string; conversationId?: string }>;
        source?: { conversationId?: string; revision?: string };
      };

      const chatDiagnostics = {
        cold: {
          status: 200,
          chatCount: coldBody.chat.length,
          delta: coldDelta,
        },
        warm: {
          status: warmResult.response.status,
          chatCount: warmBody.chat.length,
          delta: warmDelta,
          selectors: durableReader.selectors.map((selector) => selector.scopeKey),
        },
        refresh: {
          status: refreshResult.response.status,
          chatCount: refreshBody.chat.length,
          delta: refreshDelta,
        },
      };

      expect(chatDiagnostics).toMatchObject({
        cold: {
          status: 200,
          chatCount: 100,
          delta: { getConversation: 1, listMessages: 0 },
        },
        warm: {
          status: 200,
          chatCount: 100,
          delta: { getConversation: 1, listMessages: 0 },
          selectors: [warmChatSelector.scopeKey],
        },
        refresh: {
          status: 200,
          chatCount: 100,
          delta: { getConversation: 1, listMessages: 0 },
        },
      });
      expect(warmBody).toEqual(coldBody);
      expect(refreshBody).toEqual(coldBody);
    } finally {
      await warmServer.stop();
    }
  });

  it("reuses the completed large fixture projection context until explicit refresh requests a rebuild", async () => {
    const { calls, tracker, runStore, lifecycleStore, writebackOutbox, orchestratorConversationStore } = await largeFixtureSources({
      issueCount: 12,
      runsPerIssue: 4,
      eventsPerRun: 12,
      writebacksPerIssue: 3,
      issuePrefix: "RF",
    });
    const server = createStatusServer({ tracker, runStore, lifecycleStore, writebackOutbox, orchestratorConversationStore });
    const address = await server.start();
    const baseUrl = baseUrlFor(address);

    try {
      await expectOk(getJson(`${baseUrl}/api/v1/web/dashboard`));
      expect(calls).toMatchObject({
        fetchIssuesByStates: 1,
        listRuns: 1,
        listWorkspaces: 1,
        listLifecycles: 1,
        listWritebacks: 1,
        listMessages: 0,
      });

      await expectOk(getJson(`${baseUrl}/api/v1/web/history?sessionLimit=10&timelineLimit=15`));
      await expectOk(getJson(`${baseUrl}/api/v1/web/sidebar`));
      expect(calls).toMatchObject({
        fetchIssuesByStates: 1,
        listRuns: 1,
        listWorkspaces: 1,
        listLifecycles: 1,
        listWritebacks: 1,
        listMessages: 1,
      });

      await expectOk(getJson(`${baseUrl}/api/v1/web/issues?refresh=1`));
      expect(calls).toMatchObject({
        fetchIssuesByStates: 2,
        listRuns: 2,
        listWorkspaces: 2,
        listLifecycles: 2,
        listWritebacks: 2,
        listMessages: 1,
      });

      await expectOk(getJson(`${baseUrl}/api/v1/web/reference-data`));
      expect(calls).toMatchObject({
        fetchIssuesByStates: 2,
        listRuns: 2,
        listWorkspaces: 2,
        listLifecycles: 2,
        listWritebacks: 2,
        listMessages: 1,
        readTranscript: 0,
        readTranscriptTail: 0,
        readTranscriptEventCount: 0,
      });
    } finally {
      await server.stop();
    }
  });
});


async function largeFixtureSources(options: {
  issueCount: number;
  runsPerIssue: number;
  eventsPerRun: number;
  writebacksPerIssue: number;
  issuePrefix: string;
}): Promise<{
  calls: SourceCalls;
  tracker: TrackerClient;
  runStore: RunTranscriptStore;
  lifecycleStore: IssueLifecycleStore;
  orchestratorConversationStore: OrchestratorConversationStore;
  writebackOutbox: Pick<FileWritebackOutboxStore, "list">;
  manifest: Awaited<ReturnType<typeof generateLargeHistoryFixture>>;
}> {
  const root = await makeTempRoot();
  const stateDir = path.join(root, `${options.issuePrefix.toLowerCase()}-large-history-fixture`);
  const manifest = await generateLargeHistoryFixture({
    outputDir: stateDir,
    issueCount: options.issueCount,
    runsPerIssue: options.runsPerIssue,
    eventsPerRun: options.eventsPerRun,
    writebacksPerIssue: options.writebacksPerIssue,
    baseTimestamp: "2026-02-03T04:05:06.000Z",
    issuePrefix: options.issuePrefix,
  });
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
    getConversation: 0,
    listMessages: 0,
  };
  const issues = trackerIssuesFromManifest(manifest);
  const tracker: TrackerClient = {
    async fetchIssuesByStates(states: string[]) {
      calls.fetchIssuesByStates += 1;
      return issues.filter((issue) => states.includes(issue.state));
    },
  } as TrackerClient;
  const runStore = instrumentMethods(new FileRunTranscriptStore(stateDir), {
    listRuns: () => {
      calls.listRuns += 1;
    },
    listWorkspaces: () => {
      calls.listWorkspaces += 1;
    },
    getRun: () => {
      calls.getRun += 1;
    },
    readTranscript: () => {
      calls.readTranscript += 1;
    },
    readTranscriptTail: () => {
      calls.readTranscriptTail += 1;
    },
    readTranscriptEventCount: () => {
      calls.readTranscriptEventCount += 1;
    },
  }) as unknown as RunTranscriptStore;
  const lifecycleStore = instrumentMethods(new FileIssueLifecycleStore(stateDir), {
    list: () => {
      calls.listLifecycles += 1;
    },
  }) as unknown as IssueLifecycleStore;
  const orchestratorConversationStore = instrumentMethods(new FileOrchestratorConversationStore(stateDir), {
    getConversation: () => {
      calls.getConversation += 1;
    },
    listMessages: () => {
      calls.listMessages += 1;
    },
  }) as unknown as OrchestratorConversationStore;
  const writebackOutbox = instrumentMethods(new FileWritebackOutboxStore(stateDir), {
    list: () => {
      calls.listWritebacks += 1;
    },
  }) as Pick<FileWritebackOutboxStore, "list">;
  return { calls, tracker, runStore, lifecycleStore, orchestratorConversationStore, writebackOutbox, manifest };
}

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
    getConversation: 0,
    listMessages: 0,
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


function trackerIssuesFromManifest(manifest: Awaited<ReturnType<typeof generateLargeHistoryFixture>>): Issue[] {
  const trackerStates = ["Todo", "In Progress", "In Review"] as const;
  const baseTimestamp = Date.parse("2026-02-03T04:05:06.000Z");
  return manifest.issues.map((issue, index) => {
    const state = trackerStates[index % trackerStates.length] ?? "Todo";
    return {
      id: issue.id,
      identifier: issue.identifier,
      title: `Backend projection fixture ${issue.identifier}`,
      description: `Generated large-history fixture issue ${issue.identifier}`,
      priority: null,
      state,
      branchName: `fixture/${issue.identifier.toLowerCase()}`,
      url: `https://example.test/issues/${issue.identifier}`,
      assigneeId: null,
      delegateId: null,
      assignedToWorker: state !== "In Review",
      labels: [index % 2 === 0 ? "dogfood-ready" : "projection-perf", `bucket-${index % 3}`],
      blockedBy: [],
      createdAt: new Date(baseTimestamp + index * 60_000).toISOString(),
      updatedAt: new Date(baseTimestamp + index * 120_000).toISOString(),
    } satisfies Issue;
  });
}

function instrumentMethods<T extends object>(target: T, hooks: Partial<Record<string, () => void>>): T {
  return new Proxy(target, {
    get(original, prop, receiver) {
      const value = Reflect.get(original, prop, receiver);
      if (typeof prop !== "string" || typeof value !== "function") return value;
      return (...args: unknown[]) => {
        hooks[prop]?.();
        return Reflect.apply(value, receiver, args);
      };
    },
  });
}

function copySourceCalls(calls: SourceCalls): SourceCalls {
  return { ...calls };
}

function diffSourceCalls(before: SourceCalls, after: SourceCalls): SourceCalls {
  return {
    fetchIssuesByStates: after.fetchIssuesByStates - before.fetchIssuesByStates,
    listRuns: after.listRuns - before.listRuns,
    listWorkspaces: after.listWorkspaces - before.listWorkspaces,
    listLifecycles: after.listLifecycles - before.listLifecycles,
    listWritebacks: after.listWritebacks - before.listWritebacks,
    getRun: after.getRun - before.getRun,
    readTranscript: after.readTranscript - before.readTranscript,
    readTranscriptTail: after.readTranscriptTail - before.readTranscriptTail,
    readTranscriptEventCount: after.readTranscriptEventCount - before.readTranscriptEventCount,
    getConversation: after.getConversation - before.getConversation,
    listMessages: after.listMessages - before.listMessages,
  };
}

function projectionSelectorKey(selector: ProjectionRevisionSelector): string {
  return `${selector.projectionName} ${selector.scopeKind ?? "global"} ${selector.scopeKey ?? "global"}`;
}

function projectionPayloadRecord<TPayload>(
  selector: { projectionName: string; scopeKind: string; scopeKey: string },
  payload: TPayload,
  sourceRevisions: Array<{ source: string; revision: string | number; observedAt: string | null }> = [],
): ProjectionPayloadRecord<TPayload> {
  const generatedAt = "2026-01-01T00:00:00.000Z";
  return {
    revision: {
      projectionRevisionId: `test:${selector.projectionName}:${selector.scopeKey}`,
      projectionName: selector.projectionName as ProjectionPayloadRecord<TPayload>["revision"]["projectionName"],
      projectContextId: /^pc=([^|]+)\|/.exec(selector.scopeKey)?.[1] ?? "default",
      scopeKind: selector.scopeKind,
      scopeKey: selector.scopeKey,
      revision: 1,
      buildMode: "bootstrap",
      sourceRevisions,
      sourceCursors: {},
      sourceFreshness: [],
      contentSha256: null,
      generatedAt,
      expiresAt: null,
      supersededAt: null,
      createdAt: generatedAt,
    },
    payload,
    payloadSha256: null,
    rawPayloadRefs: [],
    generatedAt,
    expiresAt: null,
  };
}

class StaticProjectionRecordReader {
  readonly selectors: Array<{ projectionName: string; scopeKind: string; scopeKey: string }> = [];
  private readonly records = new Map<string, ProjectionPayloadRecord>();

  constructor(records: readonly ProjectionPayloadRecord[]) {
    for (const record of records) {
      this.records.set(projectionSelectorKey(record.revision), JSON.parse(JSON.stringify(record)) as ProjectionPayloadRecord);
    }
  }

  async readCurrentPayload<TPayload = unknown>(selector: ProjectionRevisionSelector): Promise<ProjectionPayloadRecord<TPayload> | null> {
    const normalizedSelector = {
      projectionName: selector.projectionName,
      scopeKind: selector.scopeKind ?? "global",
      scopeKey: selector.scopeKey ?? "global",
    };
    this.selectors.push(normalizedSelector);
    const record = this.records.get(projectionSelectorKey(normalizedSelector));
    return record ? (JSON.parse(JSON.stringify(record)) as ProjectionPayloadRecord<TPayload>) : null;
  }

  async readCurrentTranscriptDefaultPayload<TPayload = unknown>(selector: {
    runId: string;
    limit: number;
    scopeKey?: string | null | undefined;
  }): Promise<ProjectionPayloadRecord<TPayload> | null> {
    const requestedProjectContextId = /^pc=([^|]+)\|/.exec(selector.scopeKey ?? "")?.[1] ?? null;
    const record = [...this.records.values()]
      .filter((candidate) => {
        if (candidate.revision.projectionName !== "transcript_projection" || candidate.revision.scopeKind !== "run_page") return false;
        const scopedMatch = /^pc=([^|]+)\|(.*)$/.exec(candidate.revision.scopeKey);
        const projectContextId = scopedMatch?.[1] ?? null;
        const unscopedScopeKey = scopedMatch?.[2] ?? candidate.revision.scopeKey;
        const match = /^(.+):(offset:\d+|tail):limit:(\d+)$/.exec(unscopedScopeKey);
        if (!match) return false;
        const [, runId, _pageKind, limitText] = match;
        return (
          runId === selector.runId &&
          Number(limitText) == selector.limit &&
          projectContextId === requestedProjectContextId
        );
      })
      .at(0);
    if (record) {
      this.selectors.push({
        projectionName: record.revision.projectionName,
        scopeKind: record.revision.scopeKind,
        scopeKey: record.revision.scopeKey,
      });
    } else {
      this.selectors.push({
        projectionName: "transcript_projection",
        scopeKind: "run_page",
        scopeKey: selector.scopeKey ?? `${selector.runId}:tail:limit:${selector.limit}`,
      });
    }
    return record ? (JSON.parse(JSON.stringify(record)) as ProjectionPayloadRecord<TPayload>) : null;
  }
}

function recordingProjectionWriter(): StatusServerProjectionWriter {
  return {
    async writeProjection(
      input: Parameters<StatusServerProjectionWriter["writeProjection"]>[0],
    ): Promise<Awaited<ReturnType<StatusServerProjectionWriter["writeProjection"]>>> {
      const generatedAt = "2026-01-01T00:00:00.000Z";
      const requestedBuildMode = input.buildMode ?? "incremental";
      const buildMode = input.buildMode ?? "bootstrap";
      const sourceRevisions = (input.sourceRevisions ?? []).map((revision) => ({
        source: revision.source,
        revision: revision.revision,
        observedAt: revision.observedAt ?? null,
      }));
      return {
        status: "written",
        revision: {
          projectionRevisionId: `test-write:${input.projectionName}:${input.scopeKey ?? "global"}`,
          projectionName: input.projectionName,
          projectContextId: input.projectContextId ?? (/^pc=([^|]+)\|/.exec(input.scopeKey ?? "global")?.[1] ?? "default"),
          scopeKind: input.scopeKind ?? "global",
          scopeKey: input.scopeKey ?? "global",
          revision: 1,
          buildMode,
          sourceRevisions,
          sourceCursors: input.sourceCursors ?? {},
          sourceFreshness: [],
          contentSha256: null,
          generatedAt,
          expiresAt: null,
          supersededAt: null,
          createdAt: generatedAt,
        },
        previousRevision: null,
        requestedBuildMode,
        buildMode,
        contentSha256: "0".repeat(64),
        payloadSha256: "1".repeat(64),
        event: null,
      };
    },
  };
}

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-web-projection-perf-"));
  tempRoots.push(root);
  return root;
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

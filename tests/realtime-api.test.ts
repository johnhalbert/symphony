import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StatusServer, type StatusServerOptions } from "../src/app/http.js";
import {
  RealtimeProjectionEventBus,
  serializeSseComment,
  serializeSseEvent,
  type RealtimeProjectionEvent,
  type RealtimeProjectionEventType,
} from "../src/app/RealtimeProjectionEvents.js";
import type { Orchestrator } from "../src/core/orchestrator/Orchestrator.js";
import { FileOrchestratorConversationStore } from "../src/core/persistence/OrchestratorConversationStore.js";
import { FileRunTranscriptStore } from "../src/core/persistence/RunTranscriptStore.js";
import type { TrackerClient } from "../src/core/tracker/TrackerClient.js";
import type { Issue, TrackerStateLists } from "../src/core/types.js";

describe("StatusServer realtime SSE API", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-realtime-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("serializes revisioned projection-contract SSE events and is safe with no subscribers", () => {
    const bus = new RealtimeProjectionEventBus({
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
      historyLimit: 4,
    });

    const events = bus.publishProjectionRevision({
      source: "runs",
      revision: 7,
      observedAt: "2026-01-01T00:00:00.000Z",
    });
    const projection = requireEvent(events.find((event) => event.type === "projection.updated"));
    const run = requireEvent(events.find((event) => event.type === "run.updated"));
    const transcript = requireEvent(events.find((event) => event.type === "transcript.delta"));
    const source = requireEvent(events.find((event) => event.type === "source.status"));

    expect(bus.subscriberCount()).toBe(0);
    expect([projection.revision, source.revision, run.revision, transcript.revision]).toEqual([1, 2, 3, 4]);
    expect(projection).toMatchObject({
      id: "1",
      type: "projection.updated",
      source: { source: "runs", revision: 7, observedAt: "2026-01-01T00:00:00.000Z" },
      recovery: { strategy: "refetch", reason: "event", lastEventId: null },
      missedEvents: false,
    });
    expect(projection.recovery.endpoints).toEqual(
      expect.arrayContaining(["/api/v1/web/dashboard", "/api/v1/web/issues", "/api/v1/web/sidebar"]),
    );
    expect(transcript.recovery.endpoints).toContain("/api/v1/web/sessions/{sessionId}/transcript");

    const serialized = serializeSseEvent(projection);
    expect(serialized).toContain("id: 1\n");
    expect(serialized).toContain("event: projection.updated\n");
    expect(JSON.parse(requireDataLine(serialized))).toMatchObject({
      type: "projection.updated",
      revision: 1,
      source: { source: "runs", revision: 7 },
    });
    expect(serializeSseComment("keepalive\nignored")).toBe(": keepalive ignored\n\n");
  });

  it("streams projection, source, run, and transcript updates, replays known Last-Event-ID, and cleans up disconnects", async () => {
    const runStore = new FileRunTranscriptStore(root);
    const server = createRealtimeServer({ runStore });
    const address = await server.start();
    const baseUrl = `http://${address.host}:${address.port}`;
    const client = await openSseClient(`${baseUrl}/api/v1/realtime`);

    try {
      expect(client.response.status).toBe(200);
      expect(client.response.headers.get("content-type")).toContain("text/event-stream");
      await waitFor(() => server.activeRealtimeSubscriberCount() === 1, "SSE subscriber to register");

      await runStore.startRun({
        runId: "run-realtime-1",
        sessionId: "session-realtime-1",
        agentId: "agent-1",
        role: "worker",
        issueId: "issue-1",
        issueIdentifier: "TEST-1",
        attempt: null,
        turnNumber: 1,
        prompt: "work",
        workspaceKey: "TEST-1",
        workspacePath: "/tmp/workspace",
      });

      const projection = await client.nextEventOfType("projection.updated");
      const source = await client.nextEventOfType("source.status");
      const run = await client.nextEventOfType("run.updated");
      const transcript = await client.nextEventOfType("transcript.delta");

      expect(projection.data).toMatchObject({ type: "projection.updated", revision: 1, source: { source: "runs", revision: 1 } });
      expect(source.data).toMatchObject({ type: "source.status", revision: 2, source: { source: "runs", revision: 1 } });
      expect(run.data).toMatchObject({ type: "run.updated", revision: 3, source: { source: "runs", revision: 1 } });
      expect(transcript.data).toMatchObject({ type: "transcript.delta", revision: 4, source: { source: "runs", revision: 1 } });
      expect((run.data as RealtimeProjectionEvent).recovery.endpoints).toContain("/api/v1/web/history");
      expect((transcript.data as RealtimeProjectionEvent).recovery.endpoints).toContain(
        "/api/v1/web/sessions/{sessionId}/transcript",
      );

      await client.close();
      await waitFor(() => server.activeRealtimeSubscriberCount() === 0, "SSE subscriber to disconnect");

      const replayClient = await openSseClient(`${baseUrl}/api/v1/realtime`, { "Last-Event-ID": projection.id });
      try {
        const replayedSource = await replayClient.nextEvent();
        expect(replayedSource.id).toBe(source.id);
        expect(replayedSource.event).toBe("source.status");
      } finally {
        await replayClient.close();
      }
    } finally {
      await client.close();
      await server.stop();
    }
  });

  it("publishes tracker source freshness changes from reference-data, issues, and dashboard refresh paths", async () => {
    let currentIssue = testIssue();
    const tracker = mutableTracker(() => [currentIssue]);
    const server = createRealtimeServer({ tracker });
    const address = await server.start();
    const baseUrl = `http://${address.host}:${address.port}`;
    const client = await openSseClient(`${baseUrl}/api/v1/realtime`);

    try {
      await waitFor(() => server.activeRealtimeSubscriberCount() === 1, "SSE subscriber to register");

      const referenceResponse = await fetch(`${baseUrl}/api/v1/web/reference-data?refresh=1`);
      expect(referenceResponse.status).toBe(200);
      const fresh = await client.nextEventOfType("source.status");
      expect(fresh.data).toMatchObject({
        type: "source.status",
        source: { source: "trackerIssues", revision: 1 },
        detail: {
          source: "trackerIssues",
          status: "ok",
          cached: false,
          error: null,
          issueCount: 1,
        },
        recovery: { strategy: "refetch", reason: "event" },
      });
      expect((fresh.data as RealtimeProjectionEvent).recovery.endpoints).toEqual(
        expect.arrayContaining([
          "/api/v1/web/reference-data?refresh=1",
          "/api/v1/web/issues?refresh=1",
          "/api/v1/web/dashboard?refresh=1",
        ]),
      );

      const issuesResponse = await fetch(`${baseUrl}/api/v1/web/issues`);
      expect(issuesResponse.status).toBe(200);
      const cached = await client.nextEventOfType("source.status");
      expect(cached.data).toMatchObject({
        type: "source.status",
        source: { source: "trackerIssues", revision: 2 },
        detail: { status: "ok", cached: true, error: null, issueCount: 1 },
      });

      currentIssue = testIssue({ updatedAt: "2026-01-01T00:00:01.000Z" });
      const dashboardResponse = await fetch(`${baseUrl}/api/v1/web/dashboard?refresh=1`);
      expect(dashboardResponse.status).toBe(200);
      const refreshed = await client.nextEventOfType("source.status");
      expect(refreshed.data).toMatchObject({
        type: "source.status",
        source: { source: "trackerIssues", revision: 3 },
        detail: { status: "ok", cached: false, error: null, issueCount: 1 },
      });
      expect((refreshed.data as RealtimeProjectionEvent).resources).toEqual(
        expect.arrayContaining([{ kind: "dashboard", href: "/api/v1/web/dashboard?refresh=1", relation: "refetch" }]),
      );
    } finally {
      await client.close();
      await server.stop();
    }
  });

  it("recovers unknown high Last-Event-ID values without replaying an exact current ID", async () => {
    const runStore = new FileRunTranscriptStore(root);
    const server = createRealtimeServer({ runStore });
    const address = await server.start();
    const baseUrl = `http://${address.host}:${address.port}`;

    try {
      await runStore.startRun({
        runId: "run-realtime-current-id",
        sessionId: "session-realtime-current-id",
        agentId: "agent-1",
        role: "worker",
        issueId: "issue-1",
        issueIdentifier: "TEST-1",
        attempt: null,
        turnNumber: 1,
        prompt: "work",
        workspaceKey: "TEST-1",
        workspacePath: "/tmp/workspace",
      });

      const currentClient = await openSseClient(`${baseUrl}/api/v1/realtime`, { "Last-Event-ID": "4" });
      try {
        await expect(currentClient.nextEvent(150)).rejects.toThrow(/Timed out waiting for SSE event/);
      } finally {
        await currentClient.close();
      }

      const recoveryClient = await openSseClient(`${baseUrl}/api/v1/realtime`, { "Last-Event-ID": "200" });
      try {
        const recovery = await recoveryClient.nextEvent();
        expect(recovery.event).toBe("projection.updated");
        expect(recovery.data).toMatchObject({
          type: "projection.updated",
          missedEvents: true,
          recovery: { strategy: "refetch", reason: "missed-events", lastEventId: "200" },
        });
        expect((recovery.data as RealtimeProjectionEvent).recovery.endpoints).toEqual(
          expect.arrayContaining(["/api/v1/web/dashboard", "/api/v1/web/issues", "/api/v1/web/history"]),
        );
      } finally {
        await recoveryClient.close();
      }
    } finally {
      await server.stop();
    }
  });

  it("emits missed-event recovery hints and orchestrator chat message events", async () => {
    const orchestratorConversationStore = new FileOrchestratorConversationStore(path.join(root, "chat-state"));
    const server = createRealtimeServer({ orchestratorConversationStore });
    const address = await server.start();
    const baseUrl = `http://${address.host}:${address.port}`;

    try {
      const recoveryClient = await openSseClient(`${baseUrl}/api/v1/realtime`, { "Last-Event-ID": "0" });
      try {
        const recovery = await recoveryClient.nextEvent();
        expect(recovery.event).toBe("projection.updated");
        expect(recovery.data).toMatchObject({
          type: "projection.updated",
          missedEvents: true,
          recovery: { strategy: "refetch", reason: "missed-events", lastEventId: "0" },
        });
        expect((recovery.data as RealtimeProjectionEvent).recovery.endpoints).toEqual(
          expect.arrayContaining(["/api/v1/web/dashboard", "/api/v1/web/issues", "/api/v1/web/history"]),
        );
      } finally {
        await recoveryClient.close();
      }

      const chatClient = await openSseClient(`${baseUrl}/api/v1/realtime`);
      try {
        const chatResponse = await fetch(`${baseUrl}/api/v1/web/orchestrator-chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input: "hello from the operator" }),
        });
        expect(chatResponse.status).toBe(202);
        await expect(chatResponse.json()).resolves.toMatchObject([{ text: "hello from the operator" }]);

        const chat = await chatClient.nextEventOfType("orchestrator.message");
        expect(chat.data).toMatchObject({
          type: "orchestrator.message",
          source: { source: "orchestrator-chat" },
          detail: {
            inputLength: "hello from the operator".length,
            messageCount: 1,
            conversationId: "orchestrator-default",
            status: 202,
          },
          recovery: { strategy: "refetch", reason: "event" },
        });
        expect((chat.data as RealtimeProjectionEvent).recovery.endpoints).toContain("/api/v1/web/orchestrator-chat");
      } finally {
        await chatClient.close();
      }
    } finally {
      await server.stop();
    }
  });
});

interface ParsedSseEvent {
  id: string;
  event: string;
  data: unknown;
  raw: string;
}

interface SseTestClient {
  response: Response;
  nextEvent(timeoutMs?: number): Promise<ParsedSseEvent>;
  nextEventOfType(type: RealtimeProjectionEventType, timeoutMs?: number): Promise<ParsedSseEvent>;
  close(): Promise<void>;
}

function createRealtimeServer(
  options: {
    runStore?: FileRunTranscriptStore;
    tracker?: TrackerClient;
    orchestratorConversationStore?: FileOrchestratorConversationStore;
  } = {},
): StatusServer {
  return new StatusServer({
    orchestrator: fakeOrchestrator(),
    workspaceManager: {} as StatusServerOptions["workspaceManager"],
    workspaceOpener: {} as StatusServerOptions["workspaceOpener"],
    ...(options.runStore ? { runStore: options.runStore } : {}),
    ...(options.tracker ? { tracker: options.tracker } : {}),
    ...(options.orchestratorConversationStore
      ? { orchestratorConversationStore: options.orchestratorConversationStore }
      : {}),
    host: "127.0.0.1",
    port: 0,
    openWorkspaceToken: null,
    trackerStateLists: testTrackerStateLists(),
    staleThresholdMs: 300_000,
  });
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

function mutableTracker(getIssues: () => readonly Issue[]): TrackerClient {
  const matchingIssues = (states: readonly string[]) => {
    const wanted = new Set(states.map((state) => state.toLowerCase()));
    return getIssues().filter((issue) => wanted.has(issue.state.toLowerCase()));
  };
  return {
    async fetchCandidateIssues() {
      return [...getIssues()];
    },
    async fetchIssuesByStates(states) {
      return matchingIssues(states);
    },
    async fetchIssueStatesByIds(issueIds) {
      const wanted = new Set(issueIds);
      return getIssues().filter((issue) => wanted.has(issue.id));
    },
  };
}

function testIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-realtime-1",
    identifier: "TEST-1",
    title: "Realtime issue",
    description: null,
    priority: null,
    state: "Todo",
    branchName: null,
    url: null,
    assigneeId: null,
    delegateId: null,
    assignedToWorker: false,
    labels: ["dogfood-ready"],
    blockedBy: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
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

  const nextEvent = async (timeoutMs = 2_000): Promise<ParsedSseEvent> => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const delimiter = buffer.indexOf("\n\n");
      if (delimiter >= 0) {
        const raw = buffer.slice(0, delimiter);
        buffer = buffer.slice(delimiter + 2);
        const event = parseSseBlock(raw);
        if (event) return event;
        continue;
      }
      const chunk = await withTimeout(reader.read(), timeoutMs - (Date.now() - startedAt), "SSE event");
      if (chunk.done) throw new Error("SSE stream closed before an event was available");
      buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
    }
    throw new Error("Timed out waiting for SSE event");
  };

  return {
    response,
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

function requireEvent(event: RealtimeProjectionEvent | undefined): RealtimeProjectionEvent {
  if (!event) throw new Error("Expected realtime event to be present");
  return event;
}

function requireDataLine(serialized: string): string {
  const line = serialized.split("\n").find((candidate) => candidate.startsWith("data: "));
  if (!line) throw new Error("Expected serialized SSE event to contain a data line");
  return line.slice("data: ".length);
}

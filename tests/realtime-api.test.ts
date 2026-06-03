import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StatusServer, type StatusServerOptions } from "../src/app/http.js";
import {
  REALTIME_EVENT_SCHEMA,
  REALTIME_EVENT_SCHEMA_VERSION,
  RealtimeProjectionEventBus,
  serializeRealtimeEventData,
  serializeSseComment,
  serializeSseEvent,
  type RealtimeProjectionEvent,
  type RealtimeProjectionEventType,
} from "../src/app/RealtimeProjectionEvents.js";
import type { Orchestrator } from "../src/core/orchestrator/Orchestrator.js";
import { FileOrchestratorConversationStore } from "../src/core/persistence/OrchestratorConversationStore.js";
import { FileIssueLifecycleStore } from "../src/core/persistence/IssueLifecycleStore.js";
import { FileRunTranscriptStore } from "../src/core/persistence/RunTranscriptStore.js";
import { FileOperatorApprovalStore, OperatorApprovalService } from "../src/core/approval/OperatorApprovalService.js";
import { PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON } from "../src/core/CompletionReportService.js";
import type { TrackerClient } from "../src/core/tracker/TrackerClient.js";
import type { Issue, TrackerStateLists } from "../src/core/types.js";
import { FileWritebackOutboxStore } from "../src/core/writeback/WritebackOutbox.js";
import { testConfig } from "./helpers.js";

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
      schema: REALTIME_EVENT_SCHEMA,
      schemaVersion: REALTIME_EVENT_SCHEMA_VERSION,
      id: "1",
      type: "projection.updated",
      scope: "global",
      key: null,
      source: { source: "runs", revision: 7, observedAt: "2026-01-01T00:00:00.000Z" },
      recovery: { strategy: "refetch", reason: "event", lastEventId: null },
      missedEvents: false,
      payload: {
        source: "runs",
        sourceRevision: 7,
        resourceKinds: ["dashboard", "issue-board", "sidebar", "history"],
        resourcesChanged: ["dashboard", "issue-board", "sidebar", "history"],
        detail: null,
      },
      detail: null,
    });
    expect(source).toMatchObject({
      type: "source.status",
      scope: "source",
      key: "runs",
      payload: { source: "runs", sourceRevision: 7, status: null, fetchedStates: [], cached: null, issueCount: null },
    });
    expect(run).toMatchObject({
      type: "run.updated",
      scope: "run",
      key: null,
      payload: { source: "runs", sourceRevision: 7, runId: null, issueId: null, status: null },
    });
    expect(transcript).toMatchObject({
      type: "transcript.delta",
      scope: "session",
      key: null,
      payload: { source: "runs", sourceRevision: 7, runId: null, sessionId: null, afterSequence: null },
    });
    expect(projection.recovery.endpoints).toEqual(
      expect.arrayContaining(["/api/v1/web/dashboard", "/api/v1/web/issues", "/api/v1/web/sidebar"]),
    );
    expect(transcript.recovery.endpoints).toContain("/api/v1/web/sessions/{sessionId}/transcript");

    for (const chatSource of [
      "orchestrator_conversations",
      "orchestrator_conversations:orchestrator-default",
      "orchestrator_chat:orchestrator-default",
      "orchestrator-chat",
    ]) {
      const chatEvents = bus.publishProjectionRevision({
        source: chatSource,
        revision: `revision-for-${chatSource}`,
        observedAt: "2026-01-01T00:00:00.000Z",
      });
      const chatMessage = requireEvent(chatEvents.find((event) => event.type === "orchestrator.message"));
      expect(chatMessage).toMatchObject({
        type: "orchestrator.message",
        source: { source: chatSource },
        recovery: { strategy: "refetch", reason: "event", lastEventId: null },
      });
      expect(chatMessage.resources).toEqual(
        expect.arrayContaining([{ kind: "orchestrator-chat", href: "/api/v1/web/orchestrator-chat", relation: "refetch" }]),
      );
      expect(chatMessage.recovery.endpoints).toContain("/api/v1/web/orchestrator-chat");
    }

    const serialized = serializeSseEvent(projection);
    expect(serialized).toContain("id: 1\n");
    expect(serialized).toContain("event: projection.updated\n");
    expect(requireDataLine(serialized)).toBe(serializeRealtimeEventData(projection));
    expect(JSON.parse(requireDataLine(serialized))).toMatchObject({
      schema: REALTIME_EVENT_SCHEMA,
      schemaVersion: REALTIME_EVENT_SCHEMA_VERSION,
      type: "projection.updated",
      revision: 1,
      scope: "global",
      key: null,
      source: { source: "runs", revision: 7 },
      payload: { source: "runs", sourceRevision: 7, resourcesChanged: ["dashboard", "issue-board", "sidebar", "history"] },
    });
    expect(serializeSseComment("keepalive\nignored")).toBe(": keepalive ignored\n\n");
  });

  it("streams keepalive comments with SSE headers and cleans up disconnects", async () => {
    const server = createRealtimeServer({ realtime: { keepAliveIntervalMs: 20 } });
    const address = await server.start();
    const baseUrl = `http://${address.host}:${address.port}`;
    const client = await openSseClient(`${baseUrl}/api/v1/realtime`);

    try {
      expect(client.response.status).toBe(200);
      expect(client.response.headers.get("content-type")).toContain("text/event-stream");
      expect(client.response.headers.get("cache-control")).toContain("no-cache");
      expect(client.response.headers.get("cache-control")).toContain("no-transform");
      expect(client.response.headers.get("x-accel-buffering")).toBe("no");
      await waitFor(() => server.activeRealtimeSubscriberCount() === 1, "SSE subscriber to register");

      await expect(client.nextRawBlock()).resolves.toBe("retry: 5000");
      await expect(client.nextRawBlock(500)).resolves.toBe(": keepalive");

      await client.close();
      await waitFor(() => server.activeRealtimeSubscriberCount() === 0, "SSE subscriber to disconnect");
    } finally {
      await client.close();
      await server.stop();
    }
  });

  it("returns a clear JSON error when realtime transport is unavailable", async () => {
    const server = createRealtimeServer({ realtime: { enabled: false } });
    const address = await server.start();
    const baseUrl = `http://${address.host}:${address.port}`;

    try {
      const response = await fetch(`${baseUrl}/api/v1/realtime`);
      expect(response.status).toBe(503);
      expect(response.headers.get("content-type")).toContain("application/json");
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "realtime_unavailable",
          message: "Realtime event stream is unavailable",
        },
      });
      expect(server.activeRealtimeSubscriberCount()).toBe(0);
    } finally {
      await server.stop();
    }
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
        scope: "source",
        key: "trackerIssues",
        source: { source: "trackerIssues", revision: 1 },
        detail: {
          source: "trackerIssues",
          status: "ok",
          cached: false,
          error: null,
          issueCount: 1,
        },
        payload: {
          source: "trackerIssues",
          sourceRevision: 1,
          status: "ok",
          fetchedStates: expect.arrayContaining(["Todo", "In Progress"]),
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

  it("publishes ordered writeback outbox realtime events without duplicating idempotent replays", async () => {
    const writebackOutbox = new FileWritebackOutboxStore(path.join(root, "writeback-state"));
    const server = createRealtimeServer({ writebackOutbox });
    const address = await server.start();
    const baseUrl = `http://${address.host}:${address.port}`;
    const client = await openSseClient(`${baseUrl}/api/v1/realtime`);
    const operation = {
      idempotencyKey: "writeback:TEST-1:completion-note",
      kind: "comment" as const,
      issueId: "issue-1",
      runId: "run-writeback-1",
      payload: {
        body: "Durable completion report writeback is ready.",
        dedupeKey: "writeback-sse-dedupe",
      },
    };

    try {
      await waitFor(() => server.activeRealtimeSubscriberCount() === 1, "SSE subscriber to register");

      const enqueued = await writebackOutbox.enqueueOnce(operation);
      const enqueueEvents = await readOrderedRealtimeEvents(client, "writeback", 1, ["projection.updated", "source.status"]);
      expect(enqueueEvents[0]?.resources).toEqual(
        expect.arrayContaining([{ kind: "dashboard", href: "/api/v1/web/dashboard", relation: "refetch" }]),
      );
      expect(enqueueEvents[1]?.resources).toEqual(
        expect.arrayContaining([{ kind: "source", href: "/api/v1/web/reference-data?refresh=1", relation: "refetch" }]),
      );

      const [claimed] = await writebackOutbox.claimDue(new Date(), { idempotencyKeys: [operation.idempotencyKey] });
      expect(claimed).toMatchObject({ idempotencyKey: operation.idempotencyKey, status: "in_flight" });
      await readOrderedRealtimeEvents(client, "writeback", 2, ["projection.updated", "source.status"]);

      await writebackOutbox.markSucceeded(claimed ?? enqueued);
      await readOrderedRealtimeEvents(client, "writeback", 3, ["projection.updated", "source.status"]);

      await expect(writebackOutbox.enqueueOnce(operation)).resolves.toMatchObject({
        idempotencyKey: operation.idempotencyKey,
        status: "succeeded",
      });
      await expect(client.nextEvent(150)).rejects.toThrow(/Timed out waiting for SSE event/);
    } finally {
      await client.close();
      await server.stop();
    }
  });

  it("publishes approval request, lifecycle, and rejected-publication realtime events once across route replay", async () => {
    const config = testConfig(root);
    config.github.publishPullRequests = true;
    config.github.operatorApproval!.requiredForPublication = true;
    config.github.operatorApproval!.rejectPolicy = "cancel";
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const approvalStore = new FileOperatorApprovalStore(config.workspace.stateDir);
    const operatorApproval = new OperatorApprovalService({ config, store: approvalStore, runStore });
    await runStore.startRun({
      runId: "run-approval-1",
      sessionId: "session-approval-1",
      agentId: "agent-1",
      role: "worker",
      issueId: "issue-approval-1",
      issueIdentifier: "TEST-APPROVAL",
      attempt: null,
      turnNumber: 1,
      prompt: "publish completion report",
      workspaceKey: "TEST-APPROVAL",
      workspacePath: path.join(root, "workspace"),
    });
    const server = createRealtimeServer({
      runStore,
      lifecycleStore,
      operatorApproval,
      openWorkspaceToken: "secret",
    });
    const address = await server.start();
    const baseUrl = `http://${address.host}:${address.port}`;
    const client = await openSseClient(`${baseUrl}/api/v1/realtime`);

    try {
      await waitFor(() => server.activeRealtimeSubscriberCount() === 1, "SSE subscriber to register");

      const approval = await operatorApproval.requestPublicationApproval({
        issueId: "issue-approval-1",
        issueIdentifier: "TEST-APPROVAL",
        runId: "run-approval-1",
        evidenceCursor: "approval-evidence-1",
        action: {
          kind: "push_and_pr",
          branchName: "symphony/TEST-APPROVAL",
          baseBranch: "main",
          workspacePath: path.join(root, "workspace"),
          title: "TEST-APPROVAL durable publication",
          evidenceCursor: "approval-evidence-1",
          summaryPreview: "Publication approval required",
          changedFiles: ["tests/realtime-api.test.ts"],
          plannedOperations: ["commit_if_needed", "git_push", "pull_request_create_or_reuse"],
        },
      });
      await readOrderedRealtimeEvents(client, "runs", 2, [
        "projection.updated",
        "source.status",
        "run.updated",
        "transcript.delta",
      ]);
      const requestTranscriptEvents = await readOrderedRealtimeEvents(client, "runs", 3, [
        "projection.updated",
        "source.status",
        "run.updated",
        "transcript.delta",
      ]);
      expect(requestTranscriptEvents[3]?.recovery.endpoints).toContain("/api/v1/web/sessions/{sessionId}/transcript");
      await expect(runStore.readTranscript("run-approval-1", { offset: 0, limit: 10 })).resolves.toMatchObject({
        events: [expect.objectContaining({ eventType: "approval_request" })],
      });

      await lifecycleStore.ensureIssue(
        { id: "issue-approval-1", identifier: "TEST-APPROVAL" },
        {
          phase: "blocked",
          blockedReason: PUBLICATION_APPROVAL_AWAITING_OPERATOR_REASON,
          lastCompletionReportId: "report-approval-1",
          completionReports: [
            {
              id: "report-approval-1",
              idempotencyKey: "approval-evidence-1",
              runId: "run-approval-1",
              issueId: "issue-approval-1",
              issueIdentifier: "TEST-APPROVAL",
              summary: "Publication is waiting for operator approval.",
              validationEvidence: ["approval realtime route test"],
              acceptanceChecklist: [{ text: "approval requested", satisfied: true, evidence: "approval request created" }],
              changedFiles: ["tests/realtime-api.test.ts"],
              branchName: "symphony/TEST-APPROVAL",
              pullRequest: null,
              risks: [],
              acceptedAt: "2026-01-01T00:00:00.000Z",
              writebackOperationKeys: [],
            },
          ],
        },
      );
      const lifecycleEvents = await readOrderedRealtimeEvents(client, "lifecycle", 1, ["projection.updated", "source.status"]);
      expect(lifecycleEvents[0]?.resources).toEqual(
        expect.arrayContaining([{ kind: "issue-board", href: "/api/v1/web/issues", relation: "refetch" }]),
      );

      const rejected = await fetch(`${baseUrl}/api/v1/approval-requests/${approval.requestId}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-symphony-token": "secret" },
        body: JSON.stringify({ decision: "reject" }),
      });
      await expect(rejected.json()).resolves.toMatchObject({ replayed: false, request: { status: "rejected" } });
      expect(rejected.status).toBe(200);
      await readOrderedRealtimeEvents(client, "runs", 4, [
        "projection.updated",
        "source.status",
        "run.updated",
        "transcript.delta",
      ]);
      await readOrderedRealtimeEvents(client, "runs", 5, [
        "projection.updated",
        "source.status",
        "run.updated",
        "transcript.delta",
      ]);
      const terminalEvents = await readOrderedRealtimeEvents(client, "runs", 6, [
        "projection.updated",
        "source.status",
        "run.updated",
        "transcript.delta",
      ]);
      expect(terminalEvents[2]?.resources).toEqual(
        expect.arrayContaining([{ kind: "history", href: "/api/v1/web/history", relation: "refetch" }]),
      );
      await expect(runStore.getRun("run-approval-1")).resolves.toMatchObject({
        status: "cancelled",
        pendingApprovalRequestId: null,
        pendingApprovalRequestedAt: null,
      });
      await expect(runStore.readTranscript("run-approval-1", { offset: 0, limit: 10 })).resolves.toMatchObject({
        events: [
          expect.objectContaining({ eventType: "approval_request" }),
          expect.objectContaining({ eventType: "approval_resolved" }),
        ],
      });

      const replay = await fetch(`${baseUrl}/api/v1/approval-requests/${approval.requestId}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-symphony-token": "secret" },
        body: JSON.stringify({ decision: "reject" }),
      });
      await expect(replay.json()).resolves.toMatchObject({ replayed: true, request: { status: "rejected" } });
      expect(replay.status).toBe(200);
      await expect(client.nextEvent(150)).rejects.toThrow(/Timed out waiting for SSE event/);
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

  it("publishes store-driven transcript deltas with patchable message payloads", async () => {
    const runStore = new FileRunTranscriptStore(root);
    await runStore.startRun({
      runId: "run-transcript-patch-1",
      sessionId: "session-transcript-patch-1",
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
    const server = createRealtimeServer({ runStore });
    const address = await server.start();
    const baseUrl = `http://${address.host}:${address.port}`;
    const client = await openSseClient(`${baseUrl}/api/v1/realtime`);

    try {
      await waitFor(() => server.activeRealtimeSubscriberCount() === 1, "SSE subscriber to register");
      await runStore.appendEvent({
        runId: "run-transcript-patch-1",
        at: "2026-01-01T00:00:01.000Z",
        source: "runtime",
        eventType: "assistant_delta",
        message: "live transcript patch",
        payload: { kind: "assistant", type: "assistant_delta", text: "live transcript patch", delta: "live transcript patch" },
      });

      const transcript = await client.nextEventOfType("transcript.delta");
      expect(transcript.data).toMatchObject({
        type: "transcript.delta",
        scope: "session",
        key: "session-transcript-patch-1",
        source: { source: "runs", revision: 2 },
        payload: {
          source: "runs",
          sourceRevision: 2,
          runId: "run-transcript-patch-1",
          sessionId: "session-transcript-patch-1",
          afterSequence: 0,
          eventCount: 1,
          messages: [
            {
              sequence: 1,
              operation: "merge-assistant-delta",
              joinMode: "spaced",
              message: { kind: "assistant", ts: "2026-01-01T00:00:01.000Z", text: "live transcript patch" },
            },
          ],
        },
      });
      expect((transcript.data as RealtimeProjectionEvent).recovery.endpoints).toContain("/api/v1/web/sessions/{sessionId}/transcript");
    } finally {
      await client.close();
      await server.stop();
    }
  });

  it("publishes store-driven assistant and system conversation writes as orchestrator chat realtime events", async () => {
    const orchestratorConversationStore = new FileOrchestratorConversationStore(path.join(root, "chat-state"));
    const server = createRealtimeServer({ orchestratorConversationStore });
    const address = await server.start();
    const baseUrl = `http://${address.host}:${address.port}`;
    const client = await openSseClient(`${baseUrl}/api/v1/realtime`);

    try {
      await waitFor(() => server.activeRealtimeSubscriberCount() === 1, "SSE subscriber to register");

      const assistant = await orchestratorConversationStore.appendMessage({
        conversationId: "operator-room",
        role: "assistant",
        body: "I can help inspect the queue.",
        status: "streaming",
        at: "2026-01-01T00:00:00.000Z",
      });
      const assistantAppend = await client.nextEventOfType("orchestrator.message");
      expect(assistantAppend.data).toMatchObject({
        type: "orchestrator.message",
        source: { source: "orchestrator_conversations", revision: 1 },
        recovery: { strategy: "refetch", reason: "event" },
      });
      expect((assistantAppend.data as RealtimeProjectionEvent).payload).toMatchObject({
        conversationId: "operator-room",
        messageCount: 1,
        message: { id: assistant.id, conversationId: "operator-room", who: "agent", role: "assistant", text: "I can help inspect the queue.", status: "streaming" },
        messages: [
          { id: assistant.id, conversationId: "operator-room", who: "agent", role: "assistant", text: "I can help inspect the queue.", status: "streaming" },
        ],
      });
      expect((assistantAppend.data as RealtimeProjectionEvent).resources).toEqual(
        expect.arrayContaining([{ kind: "orchestrator-chat", href: "/api/v1/web/orchestrator-chat", relation: "refetch" }]),
      );
      expect((assistantAppend.data as RealtimeProjectionEvent).recovery.endpoints).toContain(
        "/api/v1/web/orchestrator-chat",
      );

      await orchestratorConversationStore.updateMessage({
        conversationId: assistant.conversationId,
        messageId: assistant.id,
        status: "completed",
        body: "I found the queue summary.",
        at: "2026-01-01T00:00:01.000Z",
      });
      const assistantUpdate = await client.nextEventOfType("orchestrator.message");
      expect(assistantUpdate.data).toMatchObject({
        type: "orchestrator.message",
        source: { source: "orchestrator_conversations", revision: 2 },
        recovery: { strategy: "refetch", reason: "event" },
      });
      expect((assistantUpdate.data as RealtimeProjectionEvent).payload).toMatchObject({
        conversationId: "operator-room",
        messageCount: 1,
        message: { id: assistant.id, conversationId: "operator-room", who: "agent", role: "assistant", text: "I found the queue summary.", status: "completed" },
        messages: [
          { id: assistant.id, conversationId: "operator-room", who: "agent", role: "assistant", text: "I found the queue summary.", status: "completed" },
        ],
      });
      expect((assistantUpdate.data as RealtimeProjectionEvent).recovery.endpoints).toContain(
        "/api/v1/web/orchestrator-chat",
      );

      await orchestratorConversationStore.appendMessage({
        conversationId: "operator-room",
        role: "system",
        body: "System note: summary persisted.",
        status: "completed",
        at: "2026-01-01T00:00:02.000Z",
      });
      const systemAppend = await client.nextEventOfType("orchestrator.message");
      expect(systemAppend.data).toMatchObject({
        type: "orchestrator.message",
        source: { source: "orchestrator_conversations", revision: 3 },
        recovery: { strategy: "refetch", reason: "event" },
      });
      expect((systemAppend.data as RealtimeProjectionEvent).resources).toEqual(
        expect.arrayContaining([{ kind: "orchestrator-chat", href: "/api/v1/web/orchestrator-chat", relation: "refetch" }]),
      );
    } finally {
      await client.close();
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

        const storeChat = await chatClient.nextEventOfType("orchestrator.message");
        expect(storeChat.data).toMatchObject({
          type: "orchestrator.message",
          source: { source: "orchestrator_conversations" },
          recovery: { strategy: "refetch", reason: "event" },
        });
        expect((storeChat.data as RealtimeProjectionEvent).recovery.endpoints).toContain(
          "/api/v1/web/orchestrator-chat",
        );

        const chat = await nextEventOfTypeFromSource(chatClient, "orchestrator.message", "orchestrator-chat");
        expect(chat.data).toMatchObject({
          type: "orchestrator.message",
          scope: "orchestrator",
          key: "orchestrator-default",
          source: { source: "orchestrator-chat" },
          detail: {
            inputLength: "hello from the operator".length,
            messageCount: 1,
            conversationId: "orchestrator-default",
            status: 202,
          },
          payload: {
            source: "orchestrator-chat",
            conversationId: "orchestrator-default",
            inputLength: "hello from the operator".length,
            messageCount: 1,
            status: 202,
            message: { text: "hello from the operator" },
            messages: [{ text: "hello from the operator" }],
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
  nextRawBlock(timeoutMs?: number): Promise<string>;
  nextEvent(timeoutMs?: number): Promise<ParsedSseEvent>;
  nextEventOfType(type: RealtimeProjectionEventType, timeoutMs?: number): Promise<ParsedSseEvent>;
  close(): Promise<void>;
}

function createRealtimeServer(
  options: {
    runStore?: FileRunTranscriptStore;
    tracker?: TrackerClient;
    orchestratorConversationStore?: FileOrchestratorConversationStore;
    lifecycleStore?: FileIssueLifecycleStore;
    writebackOutbox?: FileWritebackOutboxStore;
    operatorApproval?: StatusServerOptions["operatorApproval"];
    orchestrator?: Orchestrator;
    openWorkspaceToken?: string | null;
    realtime?: StatusServerOptions["realtime"];
  } = {},
): StatusServer {
  return new StatusServer({
    orchestrator: options.orchestrator ?? fakeOrchestrator(),
    workspaceManager: {} as StatusServerOptions["workspaceManager"],
    workspaceOpener: {} as StatusServerOptions["workspaceOpener"],
    ...(options.runStore ? { runStore: options.runStore } : {}),
    ...(options.tracker ? { tracker: options.tracker } : {}),
    ...(options.orchestratorConversationStore
      ? { orchestratorConversationStore: options.orchestratorConversationStore }
      : {}),
    ...(options.lifecycleStore ? { lifecycleStore: options.lifecycleStore } : {}),
    ...(options.writebackOutbox ? { writebackOutbox: options.writebackOutbox } : {}),
    ...(options.operatorApproval ? { operatorApproval: options.operatorApproval } : {}),
    host: "127.0.0.1",
    port: 0,
    openWorkspaceToken: options.openWorkspaceToken ?? null,
    trackerStateLists: testTrackerStateLists(),
    staleThresholdMs: 300_000,
    ...(options.realtime ? { realtime: options.realtime } : {}),
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
    response,
    nextRawBlock,
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

async function nextEventOfTypeFromSource(
  client: SseTestClient,
  type: RealtimeProjectionEventType,
  source: string,
  timeoutMs = 2_000,
): Promise<ParsedSseEvent> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const remaining = timeoutMs - (Date.now() - startedAt);
    const event = await client.nextEventOfType(type, remaining);
    if ((event.data as RealtimeProjectionEvent).source.source === source) return event;
  }
  throw new Error(`Timed out waiting for SSE event type ${type} from source ${source}`);
}

async function readOrderedRealtimeEvents(
  client: SseTestClient,
  source: string,
  sourceRevision: number,
  expectedTypes: readonly RealtimeProjectionEventType[],
): Promise<RealtimeProjectionEvent[]> {
  const events: RealtimeProjectionEvent[] = [];
  for (const type of expectedTypes) {
    const event = await client.nextEvent();
    expect(event.event).toBe(type);
    const data = event.data as RealtimeProjectionEvent;
    expect(data).toMatchObject({
      type,
      source: { source, revision: sourceRevision },
      recovery: { strategy: "refetch", reason: "event" },
      missedEvents: false,
    });
    expect(data.resources.length).toBeGreaterThan(0);
    expect(data.recovery.endpoints.length).toBeGreaterThan(0);
    events.push(data);
  }
  expect(events.map((event) => event.revision)).toEqual(
    events.map((event) => event.revision).slice().sort((left, right) => left - right),
  );
  expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
  return events;
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

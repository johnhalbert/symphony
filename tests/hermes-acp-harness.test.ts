import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  HermesAcpHarness,
  mapHermesAcpSessionUpdate,
  type HermesAcpHarnessOptions,
  type HermesAcpPermissionResolver,
  type HermesAcpRuntimeClient,
  type HermesAcpRuntimeClientOptions,
} from "../hermes/src/HermesAcpHarness.js";
import type {
  HostHermesAcpDiagnostic,
  HostHermesAcpJsonRpcNotification,
  HostHermesAcpJsonRpcRequest,
  HostHermesAcpProcessExit,
  HostHermesAcpRequestOptions,
} from "../hermes/src/HostHermesAcpFacade.js";
import type {
  HostHermesAcpProcessCommand,
  HostHermesAcpProfileLease,
  HostHermesAcpProfileLeaseOptions,
  HostHermesAcpTerminalStatus,
} from "../hermes/src/HostHermesAcpProfileLease.js";
import { parseServiceConfig, type HermesWorkerSessionLifecycle, type ServiceConfig } from "../src/core/config/Config.js";
import type { AgentEvent, AgentRunContext } from "../src/core/harness/AgentHarness.js";
import type { RunTranscriptStore, TranscriptEvent } from "../src/core/persistence/RunTranscriptStore.js";
import type { Issue } from "../src/core/types.js";

interface RecordedRequest {
  method: string;
  params: unknown;
  options: HostHermesAcpRequestOptions | undefined;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

interface FakeLeaseRecord {
  lease: HostHermesAcpProfileLease;
  disposeStatuses: HostHermesAcpTerminalStatus[];
}

type NotificationHandler = (params: unknown, notification: HostHermesAcpJsonRpcNotification) => void;
type ClientRequestHandler = (params: unknown, request: HostHermesAcpJsonRpcRequest) => unknown | Promise<unknown>;

class FakeAcpClient extends EventEmitter implements HermesAcpRuntimeClient {
  readonly requests: RecordedRequest[] = [];
  readonly kills: string[] = [];
  readonly cancelledParams: unknown[] = [];
  initializeResult: Record<string, unknown> = {
    authMethods: [{ id: "openai-codex", name: "OpenAI Codex", type: "provider" }],
  };
  sessionId = "acp-session-1";
  promptResult: Record<string, unknown> | null = { stopReason: "end_turn", usage: { input: 1, output: 2, total: 3 } };
  promptNotificationParams: unknown | unknown[] | null = {
    sessionId: "acp-session-1",
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } },
  };
  sessionNewNotificationParams: unknown | unknown[] | null = null;
  promptDeferred: Deferred<Record<string, unknown> | null> | null = null;
  promptStarted: Deferred<void> | null = null;
  logTail = "";
  private readonly notificationHandlers = new Map<string, Set<NotificationHandler>>();
  private readonly clientRequestHandlers = new Map<string, Set<ClientRequestHandler>>();

  async request<T = unknown>(method: string, params?: unknown, options?: HostHermesAcpRequestOptions): Promise<T> {
    this.requests.push({ method, params, options });
    switch (method) {
      case "initialize":
        return this.initializeResult as T;
      case "authenticate":
        return {} as T;
      case "session/new":
        this.emitSessionUpdateNotifications(this.sessionNewNotificationParams);
        return { sessionId: this.sessionId } as T;
      case "session/prompt":
        this.promptStarted?.resolve();
        this.emitSessionUpdateNotifications(this.promptNotificationParams);
        if (this.promptDeferred) return (await this.promptDeferred.promise) as T;
        return this.promptResult as T;
      case "session/cancel":
        this.cancelledParams.push(params);
        this.promptDeferred?.resolve({ stopReason: "cancelled" });
        return {} as T;
      default:
        return {} as T;
    }
  }

  onNotification(method: string, handler: NotificationHandler): () => void {
    let handlers = this.notificationHandlers.get(method);
    if (!handlers) {
      handlers = new Set<NotificationHandler>();
      this.notificationHandlers.set(method, handlers);
    }
    handlers.add(handler);
    return () => handlers?.delete(handler);
  }

  onClientRequest(method: string, handler: ClientRequestHandler): () => void {
    let handlers = this.clientRequestHandlers.get(method);
    if (!handlers) {
      handlers = new Set<ClientRequestHandler>();
      this.clientRequestHandlers.set(method, handlers);
    }
    handlers.add(handler);
    return () => handlers?.delete(handler);
  }

  on(event: "diagnostic", listener: (diagnostic: HostHermesAcpDiagnostic) => void): this;
  on(event: "exit", listener: (exit: HostHermesAcpProcessExit) => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  off(event: "diagnostic", listener: (diagnostic: HostHermesAcpDiagnostic) => void): this;
  off(event: "exit", listener: (exit: HostHermesAcpProcessExit) => void): this;
  off(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.off(event, listener);
  }

  kill(reason?: string): void {
    this.kills.push(reason ?? "");
  }

  getLogTail(_limit?: number): string {
    return this.logTail;
  }

  emitSessionUpdateNotifications(params: unknown | unknown[] | null): void {
    if (params === null) return;
    for (const item of Array.isArray(params) ? params : [params]) {
      this.emitNotification("session/update", item);
    }
  }

  emitNotification(method: string, params: unknown): void {
    const notification: HostHermesAcpJsonRpcNotification = { jsonrpc: "2.0", method, params };
    for (const handler of this.notificationHandlers.get(method) ?? []) {
      handler(params, notification);
    }
  }

  emitDiagnostic(diagnostic: HostHermesAcpDiagnostic): void {
    this.emit("diagnostic", diagnostic);
  }

  emitExit(exit: HostHermesAcpProcessExit): void {
    this.promptDeferred?.reject(new Error("process exited"));
    this.emit("exit", exit);
  }

  async invokeClientRequest(method: string, params: unknown): Promise<unknown[]> {
    const request: HostHermesAcpJsonRpcRequest = { jsonrpc: "2.0", id: 1, method, params };
    return Promise.all([...this.clientRequestHandlers.get(method) ?? []].map((handler) => handler(params, request)));
  }
}

describe("HermesAcpHarness", () => {
  it("starts a fresh ACP session, wires MCP handoff, sends text prompts, and cleans up on success", async () => {
    const { client, ctx, harness, leases } = await fixture();

    const events = await collectEvents(harness.run(ctx, "Do work"));

    expect(client.requests.map((request) => request.method)).toEqual([
      "initialize",
      "authenticate",
      "session/new",
      "session/prompt",
    ]);
    expect(client.requests[1]?.params).toEqual({ methodId: "openai-codex" });
    expect(client.requests[2]?.params).toMatchObject({ cwd: ctx.workspace.path });
    const sessionNewParams = client.requests[2]?.params as { mcpServers: Array<{ name: string; env: Array<{ name: string; value: string }> }> };
    expect(sessionNewParams.mcpServers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "symphony",
          env: expect.arrayContaining([expect.objectContaining({ name: "LINEAR_API_KEY", value: "secret" })]),
        }),
      ]),
    );
    expect(client.requests[3]?.params).toEqual({
      sessionId: "acp-session-1",
      prompt: [{ type: "text", text: "Do work" }],
    });
    expect(events[0]).toMatchObject({ type: "session_started", threadId: "acp-session-1" });
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "completed", message: "done" })]));
    expect(events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "tokens", tokens: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } })]),
    );
    expect(leases[0]?.disposeStatuses).toEqual(["succeeded"]);
    expect(client.kills).toEqual(expect.arrayContaining([expect.stringContaining("run_finished")]))

    const activeContext = JSON.parse(
      await readFile(path.join(ctx.config.workspace.stateDir, "completion-report-mcp", "issue-1-1.json"), "utf8"),
    ) as { activeRunId: string | null; sessionId: string | null; workspacePath: string | null };
    expect(activeContext.activeRunId).toMatch(/^hermes-acp-/);
    expect(activeContext.sessionId).toContain("acp-session-1");
    expect(activeContext.workspacePath).toBe(ctx.workspace.path);
  });

  it("maps ACP session update payloads to activity-aware Symphony run events", () => {
    expect(mapHermesAcpSessionUpdate({ sessionUpdate: "agentMessageChunk", content: { type: "text", text: "hello" } })).toEqual([
      { type: "progress", activitySource: "delta", message: "hello" },
    ]);
    expect(mapHermesAcpSessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: " " } })).toEqual([
      { type: "progress", activitySource: "delta", message: " " },
    ]);
    expect(mapHermesAcpSessionUpdate({ sessionUpdate: "agent_message_chunk", content: "" })).toEqual([]);
    expect(mapHermesAcpSessionUpdate({ session_update: "agent_thought_chunk", content: { type: "text", text: "private" } })).toEqual([
      { type: "progress", activitySource: "stream", message: "Hermes ACP thought update" },
    ]);
    expect(mapHermesAcpSessionUpdate({ sessionUpdate: "user_message_chunk", content: "do not echo user replay" })).toEqual([]);
    expect(mapHermesAcpSessionUpdate({ sessionUpdate: "usage_update", used: 42, size: 200 })).toEqual([
      { type: "progress", activitySource: "stream", message: "Hermes ACP usage update: 42/200 context tokens" },
    ]);
    expect(mapHermesAcpSessionUpdate({ sessionUpdate: "usage_update", final: true, usage: { input: 4, output: 5, total: 9 } })).toEqual([
      { type: "tokens", tokens: { inputTokens: 4, outputTokens: 5, totalTokens: 9 } },
    ]);
    expect(mapHermesAcpSessionUpdate({ sessionUpdate: "tool_call", toolCall: { title: "terminal", status: "pending" } })).toEqual([
      { type: "progress", activitySource: "tool", message: "Hermes ACP tool started: terminal (pending)" },
    ]);
    expect(mapHermesAcpSessionUpdate({ sessionUpdate: "tool_call_update", toolCall: { title: "terminal" }, status: "completed" })).toEqual([
      { type: "progress", activitySource: "tool", message: "Hermes ACP tool completed: terminal (completed)" },
    ]);
    expect(
      mapHermesAcpSessionUpdate({
        sessionUpdate: "plan",
        entries: [
          { status: "in_progress", content: "Implement mapping" },
          { status: "completed", content: "Inspect context" },
        ],
      }),
    ).toEqual([
      {
        type: "progress",
        activitySource: "stream",
        message: "Hermes ACP plan updated: 1 in_progress, 1 completed; active: Implement mapping",
      },
    ]);
    expect(mapHermesAcpSessionUpdate({ sessionUpdate: "currentModeUpdate", currentMode: "agent" })).toEqual([
      { type: "progress", activitySource: "stream", message: "Hermes ACP mode: agent" },
    ]);
    expect(mapHermesAcpSessionUpdate({ sessionUpdate: "session_info_update", title: "ENG-140" })).toEqual([
      { type: "progress", activitySource: "stream", message: "Hermes ACP session: ENG-140" },
    ]);
    expect(
      mapHermesAcpSessionUpdate({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "/help" }, { name: "/model" }] }),
    ).toEqual([{ type: "progress", activitySource: "stream", message: "Hermes ACP commands available: /help, /model" }]);
    expect(mapHermesAcpSessionUpdate({ sessionUpdate: "future_update", secret: "redacted" })).toEqual([
      expect.objectContaining({ type: "run_diagnostic", code: "hermes_acp_session_update_unmapped" }),
    ]);
  });

  it("streams and persists only active ACP session updates as Symphony run events", async () => {
    const client = new FakeAcpClient();
    const transcriptEvents: TranscriptEvent[] = [];
    const runStore = {
      appendEvent: vi.fn(async (event: Omit<TranscriptEvent, "sequence"> & { sequence?: number }): Promise<TranscriptEvent> => {
        const recorded = { ...event, sequence: transcriptEvents.length + 1 };
        transcriptEvents.push(recorded);
        return recorded;
      }),
    } as unknown as RunTranscriptStore;
    client.sessionNewNotificationParams = {
      sessionId: "acp-session-1",
      update: { sessionUpdate: "agent_message_chunk", content: "before active session" },
    };
    client.promptNotificationParams = [
      { sessionId: "other-session", update: { sessionUpdate: "agent_message_chunk", content: "wrong session" } },
      { sessionId: "acp-session-1", update: { sessionUpdate: "tool_call", toolCall: { title: "terminal", status: "started" } } },
      { sessionId: "acp-session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } } },
      { sessionId: "acp-session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " " } } },
      { sessionId: "acp-session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } } },
      { sessionId: "acp-session-1", update: { sessionUpdate: "usage_update", used: 9, size: 100 } },
      { sessionId: "acp-session-1", update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "/help" }] } },
      { sessionId: "acp-session-1", update: { sessionUpdate: "future_update", details: "still visible as diagnostic" } },
    ];
    client.promptResult = { stopReason: "end_turn", usage: { input: 1, output: 2, total: 3 } };
    const { ctx, harness } = await fixture({ client, runStore });

    const events = await collectEvents(harness.run(ctx, "Do work"));

    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "session_started", threadId: "acp-session-1" })]));
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "progress", activitySource: "tool", message: "Hermes ACP tool started: terminal (started)" }),
        expect.objectContaining({ type: "progress", activitySource: "stream", message: "Hermes ACP usage update: 9/100 context tokens" }),
        expect.objectContaining({ type: "tokens", tokens: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } }),
        expect.objectContaining({ type: "progress", activitySource: "stream", message: "Hermes ACP commands available: /help" }),
        expect.objectContaining({ type: "run_diagnostic", code: "hermes_acp_session_update_unmapped" }),
        expect.objectContaining({ type: "completed", message: "hello world" }),
      ]),
    );
    expect(events.flatMap((event) => event.type === "progress" && event.activitySource === "delta" ? [event.message] : [])).toEqual([
      "hello",
      " ",
      "world",
    ]);
    expect(events).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "tokens", tokens: { totalTokens: 9 } })]));
    expect(events.map((event) => "message" in event ? event.message : "").join("\n")).not.toContain("before active session");
    expect(events.map((event) => "message" in event ? event.message : "").join("\n")).not.toContain("wrong session");
    expect(transcriptEvents.map((event) => event.eventType)).toEqual([
      "hermes_acp_profile",
      "acp_session_update",
      "acp_session_update",
      "acp_session_update",
      "acp_session_update",
      "acp_session_update",
      "acp_session_update",
      "acp_session_update",
    ]);
    expect(JSON.stringify(transcriptEvents.map((event) => event.payload))).not.toContain("before active session");
    expect(JSON.stringify(transcriptEvents.map((event) => event.payload))).not.toContain("wrong session");
  });

  it("uses final ACP usage updates as token fallback only when prompt usage is absent", async () => {
    const client = new FakeAcpClient();
    client.promptNotificationParams = {
      sessionId: "acp-session-1",
      update: { sessionUpdate: "usage_update", final: true, usage: { input: 8, output: 13, total: 21 } },
    };
    client.promptResult = { stopReason: "end_turn" };
    const { ctx, harness } = await fixture({ client });

    const events = await collectEvents(harness.run(ctx, "Do work"));

    const tokenEvents = events.flatMap((event) => event.type === "tokens" ? [event.tokens] : []);
    expect(tokenEvents).toEqual([{ inputTokens: 8, outputTokens: 13, totalTokens: 21 }]);
  });

  it("prefers final prompt usage over final ACP usage update fallback", async () => {
    const client = new FakeAcpClient();
    client.promptNotificationParams = {
      sessionId: "acp-session-1",
      update: { sessionUpdate: "usage_update", final: true, usage: { input: 80, output: 130, total: 210 } },
    };
    client.promptResult = { stopReason: "end_turn", usage: { input: 1, output: 2, total: 3 } };
    const { ctx, harness } = await fixture({ client });

    const events = await collectEvents(harness.run(ctx, "Do work"));

    const tokenEvents = events.flatMap((event) => event.type === "tokens" ? [event.tokens] : []);
    expect(tokenEvents).toEqual([{ inputTokens: 1, outputTokens: 2, totalTokens: 3 }]);
  });

  it("rejects unattended setup-only authentication before creating sessions", async () => {
    const client = new FakeAcpClient();
    client.initializeResult = { authMethods: [{ id: "hermes-setup", type: "terminal" }] };
    const { ctx, harness, leases } = await fixture({ client });

    const events = await collectEvents(harness.run(ctx, "Do work"));

    expect(client.requests.map((request) => request.method)).toEqual(["initialize"]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "run_diagnostic", code: "hermes_acp_run_error" }),
        expect.objectContaining({ type: "failed" }),
      ]),
    );
    expect(leases[0]?.disposeStatuses).toEqual(["failed"]);
  });

  it("maps prompt refusal to failed terminal outcome and failed-profile cleanup", async () => {
    const client = new FakeAcpClient();
    client.promptNotificationParams = null;
    client.promptResult = { stopReason: "refusal" };
    const { ctx, harness, leases } = await fixture({ client });

    const events = await collectEvents(harness.run(ctx, "Do work"));

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "run_diagnostic", code: "hermes_acp_refusal" }),
        expect.objectContaining({ type: "failed", error: "Host Hermes ACP refused the prompt." }),
      ]),
    );
    expect(leases[0]?.disposeStatuses).toEqual(["failed"]);
  });

  it("emits provider-limit events for credible ACP prompt response payloads scoped to the selected provider", async () => {
    const client = new FakeAcpClient();
    client.promptNotificationParams = null;
    client.promptResult = {
      stopReason: "error",
      provider_limit: {
        kind: "usage_limit_reached",
        message: "Usage limit reached for the selected provider.",
        retry_after_ms: 60_000,
      },
    };
    const { ctx, harness, leases } = await fixture({ client });

    const events = await collectEvents(harness.run(ctx, "Do work"));

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "provider_limit",
          signal: expect.objectContaining({
            kind: "windowed_bucket_exhausted",
            message: "Usage limit reached for the selected provider.",
            scope: { harnessId: "hermes_acp", providerId: "openai-codex", model: "gpt-5.5", accountScopeKey: null },
          }),
        }),
        expect.objectContaining({ type: "run_diagnostic", code: "hermes_acp_provider_limit" }),
        expect.objectContaining({ type: "failed", error: "Usage limit reached for the selected provider." }),
      ]),
    );
    expect(leases[0]?.disposeStatuses).toEqual(["failed"]);
  });

  it("emits provider-limit events for credible ACP provider-limit text", async () => {
    const client = new FakeAcpClient();
    client.promptNotificationParams = null;
    client.promptResult = { status: "error", text: "429 rate limit from provider", retry_after: 1 };
    const { ctx, harness } = await fixture({ client });

    const events = await collectEvents(harness.run(ctx, "Do work"));

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "provider_limit",
          signal: expect.objectContaining({
            kind: "transient_rate_limit",
            message: "429 rate limit from provider",
            scope: { harnessId: "hermes_acp", providerId: "openai-codex", model: "gpt-5.5", accountScopeKey: null },
          }),
        }),
        expect.objectContaining({ type: "failed", error: "429 rate limit from provider" }),
      ]),
    );
  });

  it("emits provider-limit events for credible ACP prompt errors", async () => {
    const client = new FakeAcpClient();
    client.promptDeferred = deferred<Record<string, unknown> | null>();
    client.promptStarted = deferred<void>();
    client.promptNotificationParams = null;
    const { ctx, harness } = await fixture({ client });
    const runPromise = collectEvents(harness.run(ctx, "Do work"));
    await client.promptStarted.promise;
    const error = Object.assign(new Error("Provider returned a rate limit"), {
      code: "provider.limit",
      data: {
        provider_limit: {
          kind: "rate_limit",
          message: "Provider returned a rate limit",
          retry_after: 2,
        },
      },
    });
    client.promptDeferred.reject(error);

    const events = await runPromise;

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "provider_limit",
          signal: expect.objectContaining({
            kind: "transient_rate_limit",
            message: "Provider returned a rate limit",
            scope: { harnessId: "hermes_acp", providerId: "openai-codex", model: "gpt-5.5", accountScopeKey: null },
          }),
        }),
        expect.objectContaining({ type: "run_diagnostic", code: "hermes_acp_run_error" }),
        expect.objectContaining({ type: "failed", error: "Host Hermes ACP run failed: Provider returned a rate limit" }),
      ]),
    );
  });

  it("does not emit provider-limit events for non-terminal assistant text about limits", async () => {
    const client = new FakeAcpClient();
    client.promptNotificationParams = {
      sessionId: "acp-session-1",
      update: { sessionUpdate: "agent_message_chunk", content: "Here are docs about provider rate limits." },
    };
    client.promptResult = { stopReason: "end_turn", text: "429 rate limit from provider" };
    const { ctx, harness, leases } = await fixture({ client });

    const events = await collectEvents(harness.run(ctx, "Do work"));

    expect(events).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "provider_limit" })]));
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "completed", message: "Here are docs about provider rate limits." })]));
    expect(leases[0]?.disposeStatuses).toEqual(["succeeded"]);
  });

  it("implements stop(runId) by cancelling the active ACP session", async () => {
    const client = new FakeAcpClient();
    client.promptDeferred = deferred<Record<string, unknown> | null>();
    client.promptStarted = deferred<void>();
    client.promptNotificationParams = null;
    const { ctx, harness, leases } = await fixture({ client });
    const started = deferred<string>();

    const runPromise = collectEvents(harness.run(ctx, "Do work"), (event) => {
      if (event.type === "session_started" && event.runId) started.resolve(event.runId);
    });
    const runId = await started.promise;
    await client.promptStarted.promise;
    await harness.stop(runId);
    const events = await runPromise;

    expect(client.cancelledParams).toEqual([{ sessionId: "acp-session-1" }]);
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "cancelled" })]));
    expect(leases[0]?.disposeStatuses).toEqual(["cancelled"]);
  });

  it("fails the run and disposes the lease when the ACP process exits mid-run", async () => {
    const client = new FakeAcpClient();
    client.promptDeferred = deferred<Record<string, unknown> | null>();
    client.promptStarted = deferred<void>();
    client.promptNotificationParams = null;
    client.logTail = "stderr with api_key=should-not-leak";
    const { ctx, harness, leases } = await fixture({ client });
    const started = deferred<void>();

    const runPromise = collectEvents(harness.run(ctx, "Do work"), (event) => {
      if (event.type === "session_started") started.resolve();
    });
    await started.promise;
    await client.promptStarted.promise;
    client.emitExit({ code: 2, signal: null });
    const events = await runPromise;

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "run_diagnostic", code: "hermes_acp_run_error" }),
        expect.objectContaining({ type: "failed" }),
      ]),
    );
    const diagnostic = events.find((event) => event.type === "run_diagnostic" && event.code === "hermes_acp_run_error");
    expect(diagnostic).toMatchObject({
      payload: { acpLogTail: { lines: ["stderr with api_key=[redacted]"], lineCount: 1 } },
    });
    expect(JSON.stringify(diagnostic)).not.toContain("should-not-leak");
    expect(leases[0]?.disposeStatuses).toEqual(["failed"]);
  });

  it("reuses the profile-scoped ACP process across successful worker implementation runs but creates fresh ACP sessions", async () => {
    const client = new FakeAcpClient();
    const { ctx, harness, leaseFactory, leases } = await fixture({ client, lifecycle: "reuse_by_issue" });

    await collectEvents(harness.run(ctx, "First"));
    client.promptNotificationParams = { sessionId: "acp-session-2", update: { sessionUpdate: "agent_message_chunk", content: "again" } };
    client.sessionId = "acp-session-2";
    await collectEvents(harness.run({ ...ctx, turnNumber: 2 }, "Second"));
    await harness.dispose();

    expect(leaseFactory).toHaveBeenCalledTimes(1);
    expect(client.requests.map((request) => request.method)).toEqual([
      "initialize",
      "authenticate",
      "session/new",
      "session/prompt",
      "session/new",
      "session/prompt",
    ]);
    expect(leases[0]?.disposeStatuses).toEqual([null]);
  });

  it("fails ACP permission requests closed when no approval bridge is configured", async () => {
    const client = new FakeAcpClient();
    client.promptDeferred = deferred<Record<string, unknown> | null>();
    client.promptStarted = deferred<void>();
    client.promptNotificationParams = null;
    const transcript = recordingRunStore();
    const { ctx, harness } = await fixture({ client, runStore: transcript.runStore });
    const { runPromise } = await startPendingRun({ client, ctx, harness });

    const responses = await client.invokeClientRequest("session/request_permission", terminalPermissionRequest());
    client.promptDeferred.resolve({ stopReason: "end_turn" });
    const events = await runPromise;

    expect(responses).toEqual([{ outcome: { outcome: "cancelled" } }]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "run_diagnostic",
          code: "hermes_acp_permission_denied",
          message: "Host Hermes ACP permission request denied: permission_bridge_not_configured",
        }),
      ]),
    );
    expect(transcript.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "acp_permission_denied",
          message: "Host Hermes ACP permission denied: permission_bridge_not_configured",
        }),
      ]),
    );
  });

  it("returns the explicit bridge permission selection only when the resolver chooses an offered option", async () => {
    const client = new FakeAcpClient();
    client.promptDeferred = deferred<Record<string, unknown> | null>();
    client.promptStarted = deferred<void>();
    client.promptNotificationParams = null;
    const transcript = recordingRunStore();
    const permissionResolver = vi.fn((input: Parameters<HermesAcpPermissionResolver>[0]) => {
      expect(input.acpSessionId).toBe("acp-session-1");
      expect(input.symphonySessionId).toContain("acp-session-1");
      expect(input.request).toMatchObject({
        sessionId: "acp-session-1",
        toolCallId: "perm-tool-1",
        requestKind: "terminal_execute",
      });
      return { optionId: "allow_once" };
    });
    const { ctx, harness } = await fixture({ client, permissionResolver, runStore: transcript.runStore });
    const { runPromise } = await startPendingRun({ client, ctx, harness });

    const responses = await client.invokeClientRequest("session/request_permission", terminalPermissionRequest());
    client.promptDeferred.resolve({ stopReason: "end_turn" });
    const events = await runPromise;

    expect(permissionResolver).toHaveBeenCalledTimes(1);
    expect(responses).toEqual([{ outcome: { outcome: "selected", optionId: "allow_once" } }]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "progress",
          activitySource: "tool",
          message: "Host Hermes ACP permission allow_once for terminal_execute",
        }),
      ]),
    );
    expect(events).not.toEqual(expect.arrayContaining([expect.objectContaining({ code: "hermes_acp_permission_denied" })]));
    expect(transcript.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "acp_permission_selected",
          message: "Host Hermes ACP permission selected: allow_once",
          payload: expect.objectContaining({ selectedOptionId: "allow_once", requestKind: "terminal_execute" }),
        }),
      ]),
    );
  });

  it("rejects malformed permission requests before consulting the bridge", async () => {
    const client = new FakeAcpClient();
    client.promptDeferred = deferred<Record<string, unknown> | null>();
    client.promptStarted = deferred<void>();
    client.promptNotificationParams = null;
    const permissionResolver = vi.fn(() => "allow_once");
    const { ctx, harness } = await fixture({ client, permissionResolver });
    const { runPromise } = await startPendingRun({ client, ctx, harness });

    const responses = await client.invokeClientRequest("session/request_permission", {
      sessionId: "acp-session-1",
      toolCall: { toolCallId: "perm-tool-1", kind: "execute" },
    });
    client.promptDeferred.resolve({ stopReason: "end_turn" });
    const events = await runPromise;

    expect(permissionResolver).not.toHaveBeenCalled();
    expect(responses).toEqual([{ outcome: { outcome: "cancelled" } }]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "run_diagnostic",
          code: "hermes_acp_permission_denied",
          message: "Host Hermes ACP permission request denied: missing_permission_options",
        }),
      ]),
    );
  });

  it.each([
    {
      name: "unoffered option",
      resolver: () => "allow_always",
      params: () => editPermissionRequest(),
      reason: "permission_option_not_offered",
    },
    {
      name: "resolver exception",
      resolver: () => {
        throw new Error("operator approval service unavailable");
      },
      params: () => terminalPermissionRequest(),
      reason: "permission_bridge_error",
    },
    {
      name: "resolver timeout",
      resolver: () => new Promise<string>(() => undefined),
      params: () => terminalPermissionRequest(),
      reason: "permission_bridge_error",
      timeoutMs: 5,
    },
  ])("fails ACP permission requests closed on $name", async ({ resolver, params, reason, timeoutMs }) => {
    const client = new FakeAcpClient();
    client.promptDeferred = deferred<Record<string, unknown> | null>();
    client.promptStarted = deferred<void>();
    client.promptNotificationParams = null;
    const permissionResolver = vi.fn(resolver);
    const { ctx, harness } = await fixture({
      client,
      permissionResolver,
      ...(timeoutMs === undefined ? {} : { permissionRequestTimeoutMs: timeoutMs }),
    });
    const { runPromise } = await startPendingRun({ client, ctx, harness });

    const responses = await client.invokeClientRequest("session/request_permission", params());
    client.promptDeferred.resolve({ stopReason: "end_turn" });
    const events = await runPromise;

    expect(permissionResolver).toHaveBeenCalledTimes(1);
    expect(responses).toEqual([{ outcome: { outcome: "cancelled" } }]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "run_diagnostic",
          code: "hermes_acp_permission_denied",
          message: `Host Hermes ACP permission request denied: ${reason}`,
        }),
      ]),
    );
  });
});

async function startPendingRun(input: {
  client: FakeAcpClient;
  ctx: AgentRunContext;
  harness: HermesAcpHarness;
}): Promise<{ runId: string; runPromise: Promise<AgentEvent[]> }> {
  const started = deferred<string>();
  const runPromise = collectEvents(input.harness.run(input.ctx, "Do work"), (event) => {
    if (event.type === "session_started" && event.runId) started.resolve(event.runId);
  });
  const runId = await started.promise;
  if (!input.client.promptStarted) throw new Error("startPendingRun requires client.promptStarted to be configured");
  await input.client.promptStarted.promise;
  return { runId, runPromise };
}

function terminalPermissionRequest(): Record<string, unknown> {
  return {
    sessionId: "acp-session-1",
    toolCall: {
      toolCallId: "perm-tool-1",
      kind: "execute",
      title: "dangerous command",
      rawInput: { command: "rm -rf /" },
    },
    options: terminalPermissionOptions(),
  };
}

function terminalPermissionOptions(): Array<Record<string, unknown>> {
  return [
    { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
    { optionId: "allow_session", kind: "allow_always", name: "Allow for session" },
    { optionId: "allow_always", kind: "allow_always", name: "Allow always" },
    { optionId: "deny", kind: "reject_once", name: "Deny" },
    { optionId: "deny_always", kind: "reject_always", name: "Deny always" },
  ];
}

function editPermissionRequest(): Record<string, unknown> {
  return {
    session_id: "acp-session-1",
    tool_call: {
      tool_call_id: "edit-tool-1",
      kind: "edit",
      title: "edit file",
      rawInput: { path: "README.md" },
    },
    permission_options: [
      { option_id: "allow_once", kind: "allow_once", name: "Allow edit" },
      { option_id: "deny", kind: "reject_once", name: "Deny" },
    ],
  };
}

async function fixture(
  input: {
    client?: FakeAcpClient;
    lifecycle?: HermesWorkerSessionLifecycle;
    permissionResolver?: HermesAcpPermissionResolver;
    permissionRequestTimeoutMs?: number;
    runStore?: HermesAcpHarnessOptions["runStore"];
  } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "symphony-hermes-acp-"));
  const config = serviceConfig(root, input.lifecycle ?? "fresh_per_run");
  const ctx = runContext(config, root);
  const client = input.client ?? new FakeAcpClient();
  const leases: FakeLeaseRecord[] = [];
  const leaseFactory = vi.fn(async (options: HostHermesAcpProfileLeaseOptions): Promise<HostHermesAcpProfileLease> => {
    const disposeStatuses: HostHermesAcpTerminalStatus[] = [];
    const profileName = `profile-${leases.length + 1}`;
    const lease: HostHermesAcpProfileLease = {
      profileName,
      sourceProfile: options.sourceProfile ?? "host-source",
      acpCommand: {
        file: options.binaryPath,
        args: ["-p", profileName, "acp"],
        cwd: options.cwd,
        env: {},
      },
      dispose: vi.fn(async (terminalStatus: HostHermesAcpTerminalStatus) => {
        disposeStatuses.push(terminalStatus);
        return { profileName, reason: "deleted" as const, deleted: true };
      }),
    };
    leases.push({ lease, disposeStatuses });
    return lease;
  });
  const acpClientFactory = vi.fn(
    (_command: HostHermesAcpProcessCommand, _options: HermesAcpRuntimeClientOptions): HermesAcpRuntimeClient => client,
  );
  const harnessOptions = {
    cliPath: path.join(root, "src", "cli.ts"),
    profileLeaseFactory: leaseFactory,
    acpClientFactory,
    ...(input.runStore === undefined ? {} : { runStore: input.runStore }),
    ...(input.permissionResolver === undefined ? {} : { permissionResolver: input.permissionResolver }),
    ...(input.permissionRequestTimeoutMs === undefined ? {} : { permissionRequestTimeoutMs: input.permissionRequestTimeoutMs }),
  } satisfies HermesAcpHarnessOptions;
  const harness = new HermesAcpHarness(harnessOptions);
  return { root, config, ctx, client, harness, leaseFactory, acpClientFactory, leases };
}

function serviceConfig(root: string, lifecycle: HermesWorkerSessionLifecycle): ServiceConfig {
  return parseServiceConfig(
    {
      tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
      agent: { harness: "hermes_acp", max_turns: 2 },
      workspace: {
        root: path.join(root, "workspaces"),
        state_dir: path.join(root, "state"),
        source: { kind: "none" },
      },
      github: { publish_pull_requests: false },
      hermes: {
        upstream_root: path.join(root, "hermes-src"),
        templates_dir: path.join(root, "templates"),
        provider: "openai-codex",
        model: "gpt-5.5",
        keep_profiles: "never",
        worker_session_lifecycle: lifecycle,
        startup_timeout_ms: 1_000,
        request_timeout_ms: 1_000,
        acp_binary_path: "/host/bin/hermes",
        acp_source_profile: "host-source",
      },
    },
    path.join(root, "WORKFLOW.md"),
    { LINEAR_API_KEY: "secret" },
  );
}

function runContext(config: ServiceConfig, root: string): AgentRunContext {
  const workspacePath = path.join(root, "workspace");
  return {
    issue: issue(),
    role: "worker",
    runPhase: "implementation",
    attempt: 1,
    workspace: {
      path: workspacePath,
      workspaceKey: "ENG-139",
      createdNow: false,
      issueId: "issue-1",
      issueIdentifier: "ENG-139",
      sourceKind: "git_worktree",
      gitBranchName: "symphony/ENG-139",
      repoPath: root,
      baseRef: "main",
    },
    config,
    turnNumber: 1,
    abortSignal: new AbortController().signal,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  };
}

function issue(): Issue {
  return {
    id: "issue-1",
    identifier: "ENG-139",
    title: "Implement Hermes ACP harness",
    description: null,
    priority: null,
    state: "In Progress",
    branchName: "symphony/ENG-139",
    url: null,
    assigneeId: null,
    delegateId: null,
    assignedToWorker: true,
    labels: ["dogfood-ready"],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
  };
}

async function collectEvents(
  iterable: AsyncIterable<AgentEvent>,
  onEvent: (event: AgentEvent) => void | Promise<void> = () => undefined,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
    await onEvent(event);
  }
  return events;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function recordingRunStore(): { events: TranscriptEvent[]; runStore: NonNullable<HermesAcpHarnessOptions["runStore"]> } {
  const events: TranscriptEvent[] = [];
  const runStore = {
    appendEvent: vi.fn(async (input: Omit<TranscriptEvent, "sequence"> & { sequence?: number }) => {
      const event: TranscriptEvent = { ...input, sequence: input.sequence ?? events.length + 1 };
      events.push(event);
      return event;
    }),
  } as unknown as NonNullable<HermesAcpHarnessOptions["runStore"]>;
  return { events, runStore };
}

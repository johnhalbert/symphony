import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  HermesAcpHarness,
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
import type { TranscriptEvent } from "../src/core/persistence/RunTranscriptStore.js";
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
  promptNotificationParams: unknown = {
    sessionId: "acp-session-1",
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } },
  };
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
        return { sessionId: this.sessionId } as T;
      case "session/prompt":
        this.promptStarted?.resolve();
        if (this.promptNotificationParams !== null) this.emitNotification("session/update", this.promptNotificationParams);
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
    client.logTail = "stderr with SECRET_TOKEN=should-not-leak";
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

  it.each([
    { optionId: "allow_once", params: () => terminalPermissionRequest(), requestKind: "terminal_execute" },
    { optionId: "allow_session", params: () => terminalPermissionRequest(), requestKind: "terminal_execute" },
    { optionId: "allow_always", params: () => terminalPermissionRequest(), requestKind: "terminal_execute" },
    { optionId: "deny", params: () => terminalPermissionRequest(), requestKind: "terminal_execute" },
    { optionId: "deny_always", params: () => terminalPermissionRequest(), requestKind: "terminal_execute" },
    { optionId: "allow_once", params: () => editPermissionRequest(), requestKind: "file_edit" },
    { optionId: "deny", params: () => editPermissionRequest(), requestKind: "file_edit" },
  ])(
    "preserves offered ACP permission option $optionId for $requestKind bridge decisions",
    async ({ optionId, params, requestKind }) => {
      const client = new FakeAcpClient();
      client.promptDeferred = deferred<Record<string, unknown> | null>();
      client.promptStarted = deferred<void>();
      client.promptNotificationParams = null;
      const transcript = recordingRunStore();
      const permissionResolver = vi.fn((input: Parameters<HermesAcpPermissionResolver>[0]) => {
        expect(input.request.requestKind).toBe(requestKind);
        return { optionId };
      });
      const { ctx, harness } = await fixture({ client, permissionResolver, runStore: transcript.runStore });
      const { runPromise } = await startPendingRun({ client, ctx, harness });

      const responses = await client.invokeClientRequest("session/request_permission", params());
      client.promptDeferred.resolve({ stopReason: "end_turn" });
      const events = await runPromise;

      expect(permissionResolver).toHaveBeenCalledTimes(1);
      expect(responses).toEqual([{ outcome: { outcome: "selected", optionId } }]);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "progress",
            activitySource: "tool",
            message: `Host Hermes ACP permission ${optionId} for ${requestKind}`,
          }),
        ]),
      );
      expect(transcript.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventType: "acp_permission_selected",
            message: `Host Hermes ACP permission selected: ${optionId}`,
            payload: expect.objectContaining({ selectedOptionId: optionId, requestKind }),
          }),
        ]),
      );
    },
  );

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
      name: "missing terminal toolCall",
      params: () => ({ sessionId: "acp-session-1", options: terminalPermissionOptions() }),
      reason: "missing_permission_tool_call",
    },
    {
      name: "missing edit toolCall",
      params: () => ({ session_id: "acp-session-1", permission_options: editPermissionOptions() }),
      reason: "missing_permission_tool_call",
    },
    {
      name: "missing terminal toolCall kind",
      params: () => ({
        ...terminalPermissionRequest(),
        toolCall: { toolCallId: "perm-tool-1", rawInput: { command: "rm -rf /" } },
      }),
      reason: "missing_permission_tool_call_kind",
    },
    {
      name: "missing edit toolCall kind",
      params: () => ({
        ...editPermissionRequest(),
        tool_call: { tool_call_id: "edit-tool-1", rawInput: { path: "README.md" } },
      }),
      reason: "missing_permission_tool_call_kind",
    },
    {
      name: "unknown terminal toolCall kind",
      params: () => ({
        ...terminalPermissionRequest(),
        toolCall: { toolCallId: "perm-tool-1", kind: "web_search", rawInput: { command: "rm -rf /" } },
      }),
      reason: "unsupported_permission_tool_call",
    },
    {
      name: "unknown edit toolCall kind",
      params: () => ({
        ...editPermissionRequest(),
        tool_call: { tool_call_id: "edit-tool-1", kind: "database_write", rawInput: { path: "README.md" } },
      }),
      reason: "unsupported_permission_tool_call",
    },
    {
      name: "missing terminal toolCall id",
      params: () => ({
        ...terminalPermissionRequest(),
        toolCall: { kind: "execute", title: "dangerous command", rawInput: { command: "rm -rf /" } },
      }),
      reason: "missing_permission_tool_call_id",
    },
    {
      name: "missing edit toolCall id",
      params: () => ({
        ...editPermissionRequest(),
        tool_call: { kind: "edit", title: "edit file", rawInput: { path: "README.md" } },
      }),
      reason: "missing_permission_tool_call_id",
    },
    {
      name: "missing terminal toolCall content",
      params: () => ({
        ...terminalPermissionRequest(),
        toolCall: { toolCallId: "perm-tool-1", kind: "execute" },
      }),
      reason: "missing_permission_tool_call_content",
    },
    {
      name: "missing edit toolCall content",
      params: () => ({
        ...editPermissionRequest(),
        tool_call: { tool_call_id: "edit-tool-1", kind: "edit" },
      }),
      reason: "missing_permission_tool_call_content",
    },
  ])("rejects unsupported permission tool-call shape before consulting the bridge: $name", async ({ params, reason }) => {
    const client = new FakeAcpClient();
    client.promptDeferred = deferred<Record<string, unknown> | null>();
    client.promptStarted = deferred<void>();
    client.promptNotificationParams = null;
    const permissionResolver = vi.fn(() => "allow_once");
    const { ctx, harness } = await fixture({ client, permissionResolver });
    const { runPromise } = await startPendingRun({ client, ctx, harness });

    const responses = await client.invokeClientRequest("session/request_permission", params());
    client.promptDeferred.resolve({ stopReason: "end_turn" });
    const events = await runPromise;

    expect(permissionResolver).not.toHaveBeenCalled();
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

  it("rejects unknown permission option shapes before consulting the bridge", async () => {
    const client = new FakeAcpClient();
    client.promptDeferred = deferred<Record<string, unknown> | null>();
    client.promptStarted = deferred<void>();
    client.promptNotificationParams = null;
    const permissionResolver = vi.fn(() => "allow_once");
    const { ctx, harness } = await fixture({ client, permissionResolver });
    const { runPromise } = await startPendingRun({ client, ctx, harness });

    const responses = await client.invokeClientRequest("session/request_permission", {
      ...terminalPermissionRequest(),
      options: [...terminalPermissionOptions(), { optionId: "unknown", kind: "unknown", name: "Unknown" }],
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
          message: "Host Hermes ACP permission request denied: unsupported_permission_options",
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

  it("fails closed when a run is cancelled while the permission resolver is pending", async () => {
    const client = new FakeAcpClient();
    client.promptDeferred = deferred<Record<string, unknown> | null>();
    client.promptStarted = deferred<void>();
    client.promptNotificationParams = null;
    const transcript = recordingRunStore();
    const resolverStarted = deferred<void>();
    const permissionDecision = deferred<string>();
    const permissionResolver = vi.fn(() => {
      resolverStarted.resolve();
      return permissionDecision.promise;
    });
    const { ctx, harness } = await fixture({ client, permissionResolver, runStore: transcript.runStore });
    const { runId, runPromise } = await startPendingRun({ client, ctx, harness });

    const responsePromise = client.invokeClientRequest("session/request_permission", terminalPermissionRequest());
    await resolverStarted.promise;
    await harness.stop(runId);
    permissionDecision.resolve("allow_always");
    const responses = await responsePromise;
    const events = await runPromise;

    expect(permissionResolver).toHaveBeenCalledTimes(1);
    expect(client.cancelledParams).toEqual([{ sessionId: "acp-session-1" }]);
    expect(responses).toEqual([{ outcome: { outcome: "cancelled" } }]);
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "cancelled" })]));
    expect(events).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "progress" })]));
    expect(transcript.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "acp_permission_denied",
          message: "Host Hermes ACP permission denied: run_cancelled",
          payload: expect.objectContaining({ reason: "run_cancelled" }),
        }),
      ]),
    );
    expect(transcript.events).not.toEqual(expect.arrayContaining([expect.objectContaining({ eventType: "acp_permission_selected" })]));
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
    permission_options: editPermissionOptions(),
  };
}

function editPermissionOptions(): Array<Record<string, unknown>> {
  return [
    { option_id: "allow_once", kind: "allow_once", name: "Allow edit" },
    { option_id: "deny", kind: "reject_once", name: "Deny" },
  ];
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

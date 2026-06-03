import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  HermesAcpHarness,
  mapHermesAcpSessionUpdate,
  mcpServersToAcpStdioServers,
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
import { projectWebTranscript } from "../src/app/WebTranscriptProjection.js";
import { parseServiceConfig, type HermesWorkerSessionLifecycle, type ServiceConfig } from "../src/core/config/Config.js";
import type { AgentEvent, AgentRunContext } from "../src/core/harness/AgentHarness.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import { Orchestrator } from "../src/core/orchestrator/Orchestrator.js";
import { FileRunTranscriptStore, type TranscriptEvent } from "../src/core/persistence/RunTranscriptStore.js";
import type { TrackerClient } from "../src/core/tracker/TrackerClient.js";
import type { Issue } from "../src/core/types.js";
import { mapAgentEventToRunActivityEvent } from "../src/core/transcript/RunActivityEventMapper.js";
import { WorkspaceManager } from "../src/core/workspace/WorkspaceManager.js";

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
  authenticateResult: unknown = {};
  authenticateError: unknown = null;
  sessionId = "acp-session-1";
  promptResult: Record<string, unknown> | null = { stopReason: "end_turn", usage: { input: 1, output: 2, total: 3 } };
  sessionNewError: Error | null = null;
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
        if (this.authenticateError !== null) throw this.authenticateError;
        return this.authenticateResult as T;
      case "session/new":
        if (this.sessionNewError) throw this.sessionNewError;
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

describe("mcpServersToAcpStdioServers", () => {
  it("converts an empty role MCP server map into an empty ACP mcpServers payload", () => {
    expect(mcpServersToAcpStdioServers({})).toEqual([]);
  });

  it("converts one stdio role MCP server into the ACP session/new payload shape", () => {
    const servers = {
      symphony: {
        type: "stdio",
        command: "/usr/bin/node",
        args: ["cli.js", "completion-report-mcp"],
        cwd: "/workspace",
        env: { LINEAR_API_KEY: "secret", EMPTY_ALLOWED: "" },
      },
    } satisfies Parameters<typeof mcpServersToAcpStdioServers>[0];

    expect(mcpServersToAcpStdioServers(servers)).toEqual([
      {
        name: "symphony",
        command: "/usr/bin/node",
        args: ["cli.js", "completion-report-mcp"],
        env: [
          { name: "LINEAR_API_KEY", value: "secret" },
          { name: "EMPTY_ALLOWED", value: "" },
        ],
      },
    ]);
  });

  it("rejects malformed or unsupported role MCP server configs before session creation", () => {
    const missingCommand = {
      symphony: { type: "stdio", args: [], cwd: "/workspace", env: {} },
    } as unknown as Parameters<typeof mcpServersToAcpStdioServers>[0];
    const httpStyleUnsupported = {
      remote: { type: "http", url: "https://mcp.example.test", headers: {} },
    } as unknown as Parameters<typeof mcpServersToAcpStdioServers>[0];

    expect(() => mcpServersToAcpStdioServers(missingCommand)).toThrow(/MCP server symphony command/);
    expect(() => mcpServersToAcpStdioServers(httpStyleUnsupported)).toThrow(
      /MCP server remote uses unsupported MCP server type http/,
    );
  });
});

describe("HermesAcpHarness", () => {
  it("constructs with default dependencies, prepares handoff context, and disposes before acquiring leases", async () => {
    const defaultHarness = new HermesAcpHarness();
    expect(defaultHarness.id).toBe("hermes_acp");
    expect(defaultHarness.capabilities).toEqual({
      continuation: true,
      mcpHandoff: true,
      runStatus: false,
      liveDiagnostics: true,
    });
    expect(defaultHarness.supportsContinuation).toBe(true);
    await defaultHarness.dispose();
    await defaultHarness.dispose();

    const { acpClientFactory, ctx, harness, leaseFactory, leases } = await fixture();

    await harness.prepare(ctx);
    await harness.dispose();
    await harness.dispose();

    const initialContext = JSON.parse(
      await readFile(path.join(ctx.config.workspace.stateDir, "completion-report-mcp", "issue-1-1.json"), "utf8"),
    ) as { activeRunId: string | null; sessionId: string | null; workspacePath: string | null };
    expect(initialContext.activeRunId).toBeNull();
    expect(initialContext.sessionId).toBeNull();
    expect(initialContext.workspacePath).toBe(ctx.workspace.path);
    expect(leaseFactory).not.toHaveBeenCalled();
    expect(acpClientFactory).not.toHaveBeenCalled();
    expect(leases).toEqual([]);
  });

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
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "completed",
          message: "done",
          payload: {
            acpResponse: expect.objectContaining({
              stopReason: "end_turn",
              terminalStatus: "succeeded",
              usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
              responseTextPreview: "done",
              resultPreview: expect.stringContaining("stopReason"),
              redacted: true,
            }),
          },
        }),
      ]),
    );
    expect(events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "tokens", tokens: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } })]),
    );
    expect(leases[0]?.disposeStatuses).toEqual(["succeeded"]);
    expect(client.kills).toEqual(expect.arrayContaining([expect.stringContaining("run_finished")]));

    const activeContext = JSON.parse(
      await readFile(path.join(ctx.config.workspace.stateDir, "completion-report-mcp", "issue-1-1.json"), "utf8"),
    ) as { activeRunId: string | null; sessionId: string | null; workspacePath: string | null };
    expect(activeContext.activeRunId).toMatch(/^hermes-acp-/);
    expect(activeContext.sessionId).toContain("acp-session-1");
    expect(activeContext.workspacePath).toBe(ctx.workspace.path);
  });

  it("selects the expected provider auth method even when it is not advertised first", async () => {
    const client = new FakeAcpClient();
    client.initializeResult = {
      authMethods: [
        { id: "anthropic", name: "Anthropic", type: "agent" },
        { id: "openai-codex", name: "OpenAI Codex", type: "agent" },
        { id: "hermes-setup", name: "Configure Hermes", type: "terminal" },
      ],
    };
    const { ctx, harness } = await fixture({ client });

    const events = await collectEvents(harness.run(ctx, "Do work"));

    expect(client.requests.map((request) => request.method)).toEqual([
      "initialize",
      "authenticate",
      "session/new",
      "session/prompt",
    ]);
    expect(client.requests[1]?.params).toEqual({ methodId: "openai-codex" });
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "completed" })]));
  });

  it("selects the source-profile provider when the configured provider is unset", async () => {
    const client = new FakeAcpClient();
    client.initializeResult = {
      authMethods: [
        { id: "anthropic", name: "Anthropic", type: "agent" },
        { id: "openai-codex", name: "OpenAI Codex", type: "agent" },
      ],
    };
    const { ctx, harness } = await fixture({ client, provider: null, sourceProfile: "openai-codex" });

    await collectEvents(harness.run(ctx, "Do work"));

    expect(client.requests[1]?.params).toEqual({ methodId: "openai-codex" });
  });

  it("prioritizes the configured provider over a different source-profile hint", async () => {
    const client = new FakeAcpClient();
    client.initializeResult = {
      authMethods: [
        { id: "anthropic", name: "Anthropic", type: "agent" },
        { id: "openai-codex", name: "OpenAI Codex", type: "agent" },
      ],
    };
    const { ctx, harness } = await fixture({ client, provider: "openai-codex", sourceProfile: "anthropic" });

    await collectEvents(harness.run(ctx, "Do work"));

    expect(client.requests[1]?.params).toEqual({ methodId: "openai-codex" });
  });

  it("falls back to the sole non-terminal provider method when selection is otherwise not explicit", async () => {
    const client = new FakeAcpClient();
    client.initializeResult = {
      authMethods: [
        { id: "anthropic", name: "Anthropic", type: "agent" },
        { id: "hermes-setup", name: "Configure Hermes", type: "terminal" },
      ],
    };
    const { ctx, harness } = await fixture({ client, provider: null });

    await collectEvents(harness.run(ctx, "Do work"));

    expect(client.requests.map((request) => request.method)).toEqual([
      "initialize",
      "authenticate",
      "session/new",
      "session/prompt",
    ]);
    expect(client.requests[1]?.params).toEqual({ methodId: "anthropic" });
  });

  it("fails before creating sessions when initialize advertises no provider auth methods", async () => {
    const client = new FakeAcpClient();
    client.initializeResult = { authMethods: [] };
    const { ctx, harness, leases } = await fixture({ client });

    const events = await collectEvents(harness.run(ctx, "Do work"));
    const text = eventText(events);

    expect(client.requests.map((request) => request.method)).toEqual(["initialize"]);
    expect(text).toContain("did not advertise a non-terminal provider auth method");
    expect(text).toContain("advertised authMethods=[]");
    expect(text).toContain("expectedProviders");
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "failed" })]));
    expect(leases[0]?.disposeStatuses).toEqual(["failed"]);
  });

  it("fails before creating sessions when multiple provider auth methods are ambiguous", async () => {
    const client = new FakeAcpClient();
    client.initializeResult = {
      authMethods: [
        { id: "anthropic", label: "Anthropic", type: "agent", access_token: "sk-should-not-appear" },
        { id: "gemini", label: "Gemini", type: "agent", providerSecret: "SECRET_PROVIDER_TOKEN" },
      ],
    };
    const { ctx, harness, leases } = await fixture({ client });

    const events = await collectEvents(harness.run(ctx, "Do work"));
    const text = eventText(events);

    expect(client.requests.map((request) => request.method)).toEqual(["initialize"]);
    expect(text).toContain("multiple non-terminal provider auth methods");
    expect(text).toContain("advertised authMethods");
    expect(text).toContain("anthropic");
    expect(text).toContain("gemini");
    expect(text).not.toContain("sk-should-not-appear");
    expect(text).not.toContain("SECRET_PROVIDER_TOKEN");
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "failed" })]));
    expect(leases[0]?.disposeStatuses).toEqual(["failed"]);
  });

  it("rejects unattended setup-only authentication before creating sessions with sanitized advertised-method diagnostics", async () => {
    const client = new FakeAcpClient();
    const secret = `sk-${"x".repeat(32)}`;
    client.initializeResult = {
      authMethods: [{ id: "hermes-setup", type: "terminal", name: `Configure Hermes ${secret}`, access_token: secret }],
    };
    const { ctx, harness, leases } = await fixture({ client });

    const events = await collectEvents(harness.run(ctx, "Do work"));
    const text = eventText(events);

    expect(client.requests.map((request) => request.method)).toEqual(["initialize"]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "run_diagnostic", code: "hermes_acp_run_error" }),
        expect.objectContaining({ type: "failed" }),
      ]),
    );
    expect(text).toContain("advertised authMethods");
    expect(text).toContain("hermes-setup");
    expect(text).toContain("terminal");
    expect(text).toContain("[redacted]");
    expect(text).not.toContain(secret);
    expect(leases[0]?.disposeStatuses).toEqual(["failed"]);
  });

  it("fails before creating sessions when provider authentication is rejected with null", async () => {
    const client = new FakeAcpClient();
    client.authenticateResult = null;
    const { ctx, harness, leases } = await fixture({ client });

    const events = await collectEvents(harness.run(ctx, "Do work"));
    const text = eventText(events);

    expect(client.requests.map((request) => request.method)).toEqual(["initialize", "authenticate"]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "run_diagnostic", code: "hermes_acp_run_error" }),
        expect.objectContaining({ type: "failed", error: expect.stringContaining("authenticate rejected auth method") }),
      ]),
    );
    expect(text).toContain("advertised authMethods");
    expect(text).toContain("openai-codex");
    expect(leases[0]?.disposeStatuses).toEqual(["failed"]);
  });

  it("fails before creating sessions when provider authentication returns false", async () => {
    const client = new FakeAcpClient();
    client.authenticateResult = false;
    const { ctx, harness, leases } = await fixture({ client });

    const events = await collectEvents(harness.run(ctx, "Do work"));
    const text = eventText(events);

    expect(client.requests.map((request) => request.method)).toEqual(["initialize", "authenticate"]);
    expect(text).toContain("authenticate rejected auth method");
    expect(text).toContain("advertised authMethods");
    expect(client.requests.some((request) => request.method === "session/new")).toBe(false);
    expect(leases[0]?.disposeStatuses).toEqual(["failed"]);
  });

  it("redacts authenticate errors while preserving advertised-method diagnostics", async () => {
    const client = new FakeAcpClient();
    const secret = `sk-${"y".repeat(32)}`;
    client.authenticateError = new Error(`upstream auth failed access_token=${secret}`);
    const { ctx, harness, leases } = await fixture({ client });

    const events = await collectEvents(harness.run(ctx, "Do work"));
    const text = eventText(events);

    expect(client.requests.map((request) => request.method)).toEqual(["initialize", "authenticate"]);
    expect(text).toContain("authenticate failed for auth method");
    expect(text).toContain("advertised authMethods");
    expect(text).toContain("[redacted]");
    expect(text).not.toContain(secret);
    expect(client.requests.some((request) => request.method === "session/new")).toBe(false);
    expect(leases[0]?.disposeStatuses).toEqual(["failed"]);
  });

  it.each([
    {
      name: "throws with a secret-bearing selected label",
      displayField: "label",
      authenticate: "throw",
      expectedText: "authenticate failed for auth method",
    },
    {
      name: "returns null with a secret-bearing selected name",
      displayField: "name",
      authenticate: "null",
      expectedText: "authenticate rejected auth method",
    },
    {
      name: "returns false with a secret-bearing selected label",
      displayField: "label",
      authenticate: "false",
      expectedText: "authenticate rejected auth method",
    },
    {
      name: "returns an invalid primitive with a secret-bearing selected name",
      displayField: "name",
      authenticate: "invalidPrimitive",
      expectedText: "authenticate returned an invalid response",
    },
  ] as const)("redacts selected auth method display values when authenticate $name", async ({
    displayField,
    authenticate,
    expectedText,
  }) => {
    const client = new FakeAcpClient();
    const secret = `sk-${"z".repeat(32)}`;
    const methodId = `openai-codex-${secret}`;
    const selectedMethod: Record<string, unknown> = {
      id: methodId,
      provider: "openai-codex",
      type: "agent",
    };
    selectedMethod[displayField] = `OpenAI Codex ${secret}`;
    client.initializeResult = { authMethods: [selectedMethod] };
    switch (authenticate) {
      case "throw":
        client.authenticateError = new Error(`upstream auth failed access_token=${secret}`);
        break;
      case "null":
        client.authenticateResult = null;
        break;
      case "false":
        client.authenticateResult = false;
        break;
      case "invalidPrimitive":
        client.authenticateResult = "unexpected authenticate response";
        break;
    }
    const { ctx, harness, leases } = await fixture({ client });

    const events = await collectEvents(harness.run(ctx, "Do work"));
    const text = eventText(events);

    expect(client.requests.map((request) => request.method)).toEqual(["initialize", "authenticate"]);
    expect(text).toContain(expectedText);
    expect(text).toContain("advertised authMethods");
    expect(text).toContain("openai-codex");
    expect(text).toContain("[redacted]");
    expect(text).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "run_diagnostic", code: "hermes_acp_run_error" }),
        expect.objectContaining({ type: "failed" }),
      ]),
    );
    expect(client.requests.some((request) => request.method === "session/new")).toBe(false);
    expect(leases[0]?.disposeStatuses).toEqual(["failed"]);
  });

  it("passes the profile lease command into the ACP facade and records run-start profile metadata", async () => {
    const { acpClientFactory, ctx, harness, leaseFactory, leases } = await fixture();

    const events = await collectEvents(harness.run(ctx, "Do work"));

    expect(leaseFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        binaryPath: "/host/bin/hermes",
        cwd: ctx.workspace.path,
        timeoutMs: 1_000,
        sourceProfile: "host-source",
        keepProfiles: "never",
        nameInput: expect.objectContaining({
          workspaceKey: "ENG-139",
          issueIdentifier: "ENG-139",
          role: "worker",
          phase: "implementation",
          attempt: 1,
          prefix: "symphony",
        }),
      }),
    );
    expect(acpClientFactory).toHaveBeenCalledWith(leases[0]?.lease.acpCommand, { requestTimeoutMs: 1_000 });
    const sessionStarted = events.find((event) => event.type === "session_started");
    const profileEvent = events.find((event) => event.type === "progress" && event.message === "Host Hermes ACP profile profile-1");
    expect(profileEvent).toMatchObject({
      type: "progress",
      activitySource: "stream",
      message: "Host Hermes ACP profile profile-1",
      runActivity: {
        runSessionId: expect.stringContaining("profile-1:acp-session-1"),
        sequence: 2,
        sequenceSource: "harness",
        protocol: "acp",
        harness: "hermes_acp",
        actor: "runtime",
        channel: "diagnostic",
        kind: "runtime_ready",
        text: "Host Hermes runtime profile profile-1",
        payload: expect.objectContaining({
          profileName: "profile-1",
          sourceProfile: "host-source",
          acpSessionId: "acp-session-1",
          runtimeSessionId: "acp-session-1",
          reusable: false,
          redacted: true,
        }),
      },
    });
    expect(profileEvent?.runActivity?.eventId).toBe(`${sessionStarted?.runId}:activity:2`);
  });

  it("creates fresh leases for fresh_per_run worker turns and only disposes each lease once", async () => {
    const { ctx, harness, leaseFactory, leases } = await fixture({ lifecycle: "fresh_per_run" });

    await collectEvents(harness.run(ctx, "First"));
    await collectEvents(harness.run({ ...ctx, turnNumber: 2 }, "Second"));
    await harness.dispose();
    await harness.dispose();

    expect(leaseFactory).toHaveBeenCalledTimes(2);
    expect(leases.map((lease) => lease.disposeStatuses)).toEqual([["succeeded"], ["succeeded"]]);
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
    expect(mapHermesAcpSessionUpdate({ sessionUpdate: "user_message_chunk", content: "do not echo user replay" })).toEqual([
      { type: "progress", activitySource: "stream", message: "Hermes ACP user message replay" },
    ]);
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
      expect.objectContaining({ type: "run_diagnostic", code: "hermes_acp_unknown_session_update" }),
      expect.objectContaining({ type: "progress", message: "Hermes ACP future_update" }),
    ]);
    expect(mapHermesAcpSessionUpdate({ content: "missing discriminator" })).toEqual([
      expect.objectContaining({ type: "run_diagnostic", code: "hermes_acp_malformed_session_update" }),
    ]);
  });

  it("attaches normalized ACP run activity metadata to streamed harness events", async () => {
    const client = new FakeAcpClient();
    client.promptNotificationParams = [
      { sessionId: "acp-session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } } },
      { sessionId: "acp-session-1", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Do work" } } },
      { sessionId: "acp-session-1", update: { session_update: "agent_thought_chunk", content: { type: "text", text: "private" } } },
      { sessionId: "acp-session-1", update: { sessionUpdate: "tool_call", toolCall: { title: "terminal", status: "pending" } } },
      { sessionId: "acp-session-1", update: { sessionUpdate: "tool_call_update", toolCall: { title: "terminal" }, status: "completed" } },
      { sessionId: "acp-session-1", update: { sessionUpdate: "usage_update", final: true, usage: { input: 4, output: 5, total: 9 } } },
    ];
    client.promptResult = { stopReason: "end_turn" };
    const { ctx, harness } = await fixture({ client });

    const events = await collectEvents(harness.run(ctx, "Do work"));
    const activities = events.map((event) => event.runActivity);

    expect(events.map((event) => event.type)).toEqual([
      "session_started",
      "progress",
      "run_diagnostic",
      "progress",
      "progress",
      "progress",
      "progress",
      "progress",
      "tokens",
      "completed",
    ]);
    expect(activities.every(Boolean)).toBe(true);
    expect(activities.map((activity) => activity?.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(activities[0]).toMatchObject({
      protocol: "acp",
      harness: "hermes_acp",
      eventId: expect.stringMatching(/^hermes-acp-.*:activity:1$/),
      runSessionId: expect.stringContaining("acp-session-1"),
      sequenceSource: "harness",
      channel: "lifecycle",
      kind: "session_started",
      payload: expect.objectContaining({ runtimeSessionId: "acp-session-1" }),
    });
    expect(activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ protocol: "acp", harness: "hermes_acp", actor: "runtime", channel: "diagnostic", kind: "runtime_ready" }),
        expect.objectContaining({
          protocol: "acp",
          harness: "hermes_acp",
          actor: "assistant",
          channel: "chat",
          kind: "assistant_message_delta",
          text: "hello",
          payload: expect.objectContaining({ updateKind: "agent_message_chunk", updateCategory: "message_chunk" }),
        }),
        expect.objectContaining({
          protocol: "acp",
          harness: "hermes_acp",
          actor: "user",
          channel: "chat",
          kind: "user_message_submitted",
          text: "Do work",
          payload: expect.objectContaining({ replay: true, updateKind: "user_message_chunk", updateCategory: "message_chunk" }),
        }),
        expect.objectContaining({ protocol: "acp", harness: "hermes_acp", actor: "assistant", channel: "chat", kind: "assistant_reasoning_delta" }),
        expect.objectContaining({
          protocol: "acp",
          harness: "hermes_acp",
          actor: "tool",
          channel: "tool",
          kind: "tool_call_started",
          payload: expect.objectContaining({ updateKind: "tool_call", updateCategory: "tool" }),
        }),
        expect.objectContaining({
          protocol: "acp",
          harness: "hermes_acp",
          actor: "tool",
          channel: "tool",
          kind: "tool_call_completed",
          payload: expect.objectContaining({ updateKind: "tool_call_update", updateCategory: "tool" }),
        }),
        expect.objectContaining({
          protocol: "acp",
          harness: "hermes_acp",
          actor: "runtime",
          channel: "token",
          kind: "token_usage_reported",
          payload: expect.objectContaining({ inputTokens: 4, outputTokens: 5, totalTokens: 9 }),
        }),
        expect.objectContaining({ protocol: "acp", harness: "hermes_acp", actor: "runtime", channel: "terminal", kind: "run_succeeded", text: "hello" }),
      ]),
    );
    expect(activities.map((activity) => activity?.kind)).not.toEqual(expect.arrayContaining(["agent_message_chunk", "agent_thought_chunk", "user_message_chunk", "tool_call", "usage_update"]));
  });

  it("streams active ACP session updates with projection-compatible normalized run activity", async () => {
    const client = new FakeAcpClient();
    client.sessionNewNotificationParams = {
      sessionId: "acp-session-1",
      update: { sessionUpdate: "agent_message_chunk", content: "before active session" },
    };
    client.promptNotificationParams = [
      { sessionId: "other-session", update: { sessionUpdate: "agent_message_chunk", content: "wrong session" } },
      {
        sessionId: "acp-session-1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-1",
          kind: "execute",
          title: "terminal",
          status: "started",
          content: { command: "npm test", apiKey: "not-a-real-token-placeholder" },
        },
      },
      {
        sessionId: "acp-session-1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-1",
          kind: "execute",
          content: "tests passed",
          result: { exitCode: 0 },
          status: "completed",
        },
      },
      {
        sessionId: "acp-session-1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-2",
          kind: "execute",
          title: "terminal",
          status: "started",
          content: { command: "rm -rf /tmp" },
        },
      },
      {
        sessionId: "acp-session-1",
        update: { sessionUpdate: "tool_call_update", toolCallId: "call-2", kind: "execute", status: "failed", content: "permission denied" },
      },
      {
        sessionId: "acp-session-1",
        update: {
          sessionUpdate: "plan",
          entries: [
            { status: "in_progress", content: "Implement mapping SECRET_ACP_PLAN_TOKEN" },
            { status: "completed", title: "Inspect context" },
          ],
        },
      },
      { sessionId: "acp-session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } } },
      { sessionId: "acp-session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " " } } },
      { sessionId: "acp-session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } } },
      { sessionId: "acp-session-1", update: { sessionUpdate: "usage_update", used: 9, size: 100 } },
      { sessionId: "acp-session-1", update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "/help" }] } },
      { sessionId: "acp-session-1", update: { sessionUpdate: "future_update", details: "still visible as diagnostic" } },
    ];
    client.promptResult = { stopReason: "end_turn", usage: { input: 1, output: 2, total: 3 } };
    const { ctx, harness } = await fixture({ client });

    const events = await collectEvents(harness.run(ctx, "Do work"));
    const transcriptEvents = transcriptEventsFromAgentEvents(events);

    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "session_started", threadId: "acp-session-1" })]));
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "progress", activitySource: "tool", message: "Hermes ACP tool started: terminal (started)" }),
        expect.objectContaining({ type: "progress", activitySource: "tool", message: "Hermes ACP tool completed: terminal (completed)" }),
        expect.objectContaining({ type: "progress", activitySource: "tool", message: "Hermes ACP tool failed: terminal (failed)" }),
        expect.objectContaining({
          type: "progress",
          activitySource: "stream",
          message: "Hermes ACP plan updated: 1 in_progress, 1 completed; active: Implement mapping [redacted]",
        }),
        expect.objectContaining({ type: "progress", activitySource: "stream", message: "Hermes ACP usage update: 9/100 context tokens" }),
        expect.objectContaining({ type: "tokens", tokens: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } }),
        expect.objectContaining({ type: "progress", activitySource: "stream", message: "Hermes ACP commands available: /help" }),
        expect.objectContaining({ type: "run_diagnostic", code: "hermes_acp_unknown_session_update" }),
        expect.objectContaining({ type: "progress", message: "Hermes ACP future_update" }),
        expect.objectContaining({ type: "completed", message: "hello world" }),
      ]),
    );
    expect(events.flatMap((event) => event.type === "progress" && event.activitySource === "delta" ? [event.message] : [])).toEqual([
      "hello",
      " ",
      "world",
    ]);
    expect(events).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "tokens", tokens: { totalTokens: 9 } })]));

    const eventMessages = events.map((event) => "message" in event ? event.message : "").join("\n");
    expect(eventMessages).not.toContain("before active session");
    expect(eventMessages).not.toContain("wrong session");
    expect(eventMessages).not.toContain("SECRET_ACP_PLAN_TOKEN");

    const transcriptEventTypes = transcriptEvents.map((event) => event.eventType);
    expect(transcriptEventTypes).toEqual([
      "session_started",
      "runtime_ready",
      "runtime_diagnostic",
      "tool_call_started",
      "tool_call_completed",
      "tool_call_started",
      "tool_call_failed",
      "plan_update",
      "assistant_message_delta",
      "assistant_message_delta",
      "assistant_message_delta",
      "runtime_status_update",
      "available_commands_update",
      "runtime_diagnostic",
      "runtime_status_update",
      "token_usage_reported",
      "run_succeeded",
    ]);
    expect(transcriptEventTypes).not.toEqual(
      expect.arrayContaining(["hermes_acp_profile", "acp_session_update", "acp_permission_denied", "acp_diagnostic", "session_update"]),
    );
    const assistantTranscriptEvents = transcriptEvents.filter((event) => event.eventType === "assistant_message_delta");
    expect(assistantTranscriptEvents.map((event) => event.message)).toEqual(["hello", " ", "world"]);
    expect(assistantTranscriptEvents.map((event) => (event.payload as Record<string, unknown> | undefined)?.messagePreview)).toEqual([
      "hello",
      " ",
      "world",
    ]);
    const call1Events = transcriptEvents.filter((event) => (event.payload as Record<string, unknown> | undefined)?.toolCallId === "call-1");
    expect(call1Events.map((event) => event.eventType)).toEqual(["tool_call_started", "tool_call_completed"]);
    expect(call1Events.map((event) => event.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolCallId: "call-1",
          toolName: "terminal",
          toolKind: "execute",
          status: "running",
          inputPreview: expect.stringContaining("npm test"),
        }),
        expect.objectContaining({
          toolCallId: "call-1",
          toolName: "terminal",
          toolKind: "execute",
          status: "succeeded",
          outputPreview: "tests passed",
          resultPreview: expect.stringContaining("exitCode"),
        }),
      ]),
    );
    const call2Events = transcriptEvents.filter((event) => (event.payload as Record<string, unknown> | undefined)?.toolCallId === "call-2");
    expect(call2Events.map((event) => event.eventType)).toEqual(["tool_call_started", "tool_call_failed"]);
    expect(call2Events[0]?.payload).toEqual(
      expect.objectContaining({
        toolCallId: "call-2",
        toolName: "terminal",
        toolKind: "execute",
        status: "running",
        inputPreview: expect.stringContaining("rm -rf /tmp"),
      }),
    );
    const call2Failure = call2Events[1];
    expect(call2Failure?.payload).toEqual(
      expect.objectContaining({ toolCallId: "call-2", toolName: "terminal", toolKind: "execute", status: "failed", errorPreview: "permission denied" }),
    );
    expect(call2Failure?.payload).not.toHaveProperty("outputPreview");
    const planUpdate = transcriptEvents.find((event) => event.eventType === "plan_update");
    expect(planUpdate).toMatchObject({
      eventType: "plan_update",
      message: "Hermes ACP plan updated: 1 in_progress, 1 completed; active: Implement mapping [redacted]",
      payload: expect.objectContaining({
        updateKind: "plan",
        updateCategory: "plan",
        statusCounts: { in_progress: 1, completed: 1 },
        activeEntries: ["Implement mapping [redacted]"],
        entries: [
          expect.objectContaining({ index: 0, status: "in_progress", contentPreview: "Implement mapping [redacted]" }),
          expect.objectContaining({ index: 1, status: "completed", contentPreview: "Inspect context" }),
        ],
      }),
    });
    const transcriptPayloadJson = JSON.stringify(transcriptEvents.map((event) => event.payload));
    expect(transcriptPayloadJson).not.toContain("before active session");
    expect(transcriptPayloadJson).not.toContain("wrong session");
    expect(transcriptPayloadJson).not.toContain("not-a-real-token-placeholder");
    expect(transcriptPayloadJson).not.toContain("SECRET_ACP_PLAN_TOKEN");
    expect(transcriptPayloadJson).toContain("[redacted]");

    const projected = projectWebTranscript(transcriptEvents);
    expect(projected.flatMap((message) => message.kind === "assistant" ? [message.text] : [])).toEqual(["hello world"]);
    const projectedToolMessages = projected.filter((message) => message.kind === "tool_call");
    expect(projectedToolMessages).toEqual([
      expect.objectContaining({
        kind: "tool_call",
        call_id: "call-1",
        name: "terminal",
        status: "succeeded",
        args: { preview: expect.stringContaining("npm test") },
        result: expect.stringContaining("exitCode"),
        output: "tests passed",
      }),
      expect.objectContaining({
        kind: "tool_call",
        call_id: "call-2",
        name: "terminal",
        status: "failed",
        args: { preview: expect.stringContaining("rm -rf /tmp") },
        error: "permission denied",
      }),
    ]);
    expect(projected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "status", state: "plan_update", text: "Hermes ACP plan updated: 1 in_progress, 1 completed; active: Implement mapping [redacted]" }),
      ]),
    );
    expect(projected.flatMap((message) => message.kind === "status" ? [message.state] : [])).not.toEqual(
      expect.arrayContaining(["hermes_acp_profile", "acp_session_update", "acp_permission_denied", "acp_diagnostic", "session_update", "tool_call", "tool_call_update"]),
    );
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

  it("treats missing usage as unknown and continues after recoverable update diagnostics", async () => {
    const client = new FakeAcpClient();
    client.promptNotificationParams = [
      { sessionId: "acp-session-1", update: { sessionUpdate: "usage_update", used: 42, size: 100 } },
      { sessionId: "acp-session-1", update: { content: "missing discriminator" } },
      { sessionId: "acp-session-1", update: { sessionUpdate: "agent_message_chunk", content: "done without usage" } },
    ];
    client.promptResult = { stopReason: "end_turn" };
    const { ctx, harness, leases } = await fixture({ client });

    const events = await collectEvents(harness.run(ctx, "Do work"));

    const tokenEvents = events.flatMap((event) => event.type === "tokens" ? [event.tokens] : []);
    expect(tokenEvents).toEqual([]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "progress", activitySource: "stream", message: "Hermes ACP usage update: 42/100 context tokens" }),
        expect.objectContaining({ type: "run_diagnostic", code: "hermes_acp_malformed_session_update" }),
        expect.objectContaining({ type: "completed", message: "done without usage" }),
      ]),
    );
    expect(events).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "failed" })]));
    expect(leases[0]?.disposeStatuses).toEqual(["succeeded"]);
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

  it("maps model or provider prompt failures to failed terminal outcome and failed-profile cleanup", async () => {
    const client = new FakeAcpClient();
    client.promptDeferred = deferred<Record<string, unknown> | null>();
    client.promptStarted = deferred<void>();
    client.promptNotificationParams = null;
    client.logTail = "provider error: model unavailable";
    const { ctx, harness, leases } = await fixture({ client });
    const started = deferred<void>();

    const runPromise = collectEvents(harness.run(ctx, "Do work"), (event) => {
      if (event.type === "session_started") started.resolve();
    });
    await started.promise;
    await client.promptStarted.promise;
    client.promptDeferred.reject(new Error("provider rejected configured model"));
    const events = await runPromise;

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "run_diagnostic",
          code: "hermes_acp_run_error",
          message: expect.stringContaining("provider rejected configured model"),
        }),
        expect.objectContaining({ type: "failed", error: expect.stringContaining("provider rejected configured model") }),
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
    await Promise.all([harness.stop(runId), harness.stop(runId)]);
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

  it("surfaces session creation failures with profile, cwd, and stderr context", async () => {
    const client = new FakeAcpClient();
    client.sessionNewError = new Error("session failed");
    client.logTail = "fatal: session new failed";
    const { ctx, harness, leases } = await fixture({ client });

    const events = await collectEvents(harness.run(ctx, "Do work"));
    const diagnostic = events.find((event) => event.type === "run_diagnostic" && event.code === "hermes_acp_run_error");

    expect(client.requests.map((request) => request.method)).toEqual(["initialize", "authenticate", "session/new"]);
    expect(diagnostic).toMatchObject({
      type: "run_diagnostic",
      message: "Host Hermes ACP run failed: session failed",
      payload: {
        sessionId: null,
        profileName: "profile-1",
        cwd: ctx.workspace.path,
        acpLogTail: { lines: ["fatal: session new failed"], lineCount: 1 },
      },
    });
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "failed" })]));
    expect(leases[0]?.disposeStatuses).toEqual(["failed"]);
  });

  it("reuses the profile-scoped ACP process across successful worker implementation runs but creates fresh ACP sessions", async () => {
    const client = new FakeAcpClient();
    const { ctx, harness, leaseFactory, leases } = await fixture({ client, lifecycle: "reuse_by_issue" });

    const firstEvents = await collectEvents(harness.run(ctx, "First"));
    client.promptNotificationParams = { sessionId: "acp-session-2", update: { sessionUpdate: "agent_message_chunk", content: "again" } };
    client.sessionId = "acp-session-2";
    const secondEvents = await collectEvents(harness.run({ ...ctx, turnNumber: 2 }, "Second"));
    await harness.dispose();
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
    expect(leaseDecisionPayloads(firstEvents)).toEqual([
      expect.objectContaining({
        outcome: "created",
        reuseMode: "reuse_by_issue",
        reason: "fresh_no_existing_reusable_lease",
        reusable: true,
        profileName: "profile-1",
      }),
    ]);
    expect(leaseDecisionPayloads(secondEvents)).toEqual([
      expect.objectContaining({
        outcome: "reused",
        reuseMode: "reuse_by_issue",
        reason: "compatible_reusable_worker_implementation",
        reusable: true,
        profileName: "profile-1",
        existingProfileName: "profile-1",
      }),
    ]);
    expect(leases[0]?.disposeStatuses).toEqual([null]);
  });

  it("uses fresh leases for isolated reviewer contexts and explains the reuse decision", async () => {
    const { ctx, harness, leaseFactory, leases } = await fixture({ lifecycle: "reuse_by_issue" });
    const reviewerCtx: AgentRunContext = { ...ctx, role: "reviewer", runPhase: "review" };

    const firstEvents = await collectEvents(harness.run(reviewerCtx, "Review"));
    const secondEvents = await collectEvents(harness.run({ ...reviewerCtx, turnNumber: 2 }, "Review again"));

    expect(leaseFactory).toHaveBeenCalledTimes(2);
    expect(leases[0]?.disposeStatuses).toEqual(["succeeded"]);
    expect(leases[1]?.disposeStatuses).toEqual(["succeeded"]);
    expect(leaseDecisionPayloads(firstEvents)).toEqual([
      expect.objectContaining({
        outcome: "created",
        reuseMode: "fresh_per_run",
        reason: "fresh_isolated_role",
        reusable: false,
        profileName: "profile-1",
      }),
    ]);
    expect(leaseDecisionPayloads(secondEvents)).toEqual([
      expect.objectContaining({
        outcome: "created",
        reuseMode: "fresh_per_run",
        reason: "fresh_isolated_role",
        reusable: false,
        profileName: "profile-2",
      }),
    ]);
  });

  it("does not reuse a worker lease when the resolved host context is incompatible", async () => {
    const firstClient = new FakeAcpClient();
    const secondClient = new FakeAcpClient();
    secondClient.sessionId = "acp-session-2";
    secondClient.promptNotificationParams = {
      sessionId: "acp-session-2",
      update: { sessionUpdate: "agent_message_chunk", content: "second" },
    };
    const { ctx, harness, leaseFactory, leases, root } = await fixture({
      clients: [firstClient, secondClient],
      lifecycle: "reuse_by_issue",
      sourceProfile: "host-source",
    });

    await collectEvents(harness.run(ctx, "First"));
    const nextConfig = serviceConfig(root, "reuse_by_issue", { sourceProfile: "other-source" });
    const secondEvents = await collectEvents(harness.run({ ...runContext(nextConfig, root), turnNumber: 2 }, "Second"));

    expect(leaseFactory).toHaveBeenCalledTimes(2);
    expect(firstClient.kills).toEqual(expect.arrayContaining([expect.stringContaining("reuse_incompatible")]));
    expect(leases[0]?.disposeStatuses).toEqual([null]);
    expect(leases[1]?.disposeStatuses).toEqual([]);
    expect(leaseDecisionPayloads(secondEvents)).toEqual([
      expect.objectContaining({
        outcome: "created",
        reuseMode: "reuse_by_issue",
        reason: "fresh_incompatible_context",
        reusable: true,
        profileName: "profile-2",
        existingProfileName: "profile-1",
        incompatibleFields: expect.arrayContaining(["sourceProfile"]),
      }),
    ]);
  });

  it("keeps reusable worker leases isolated by workspace as well as issue and phase", async () => {
    const firstClient = new FakeAcpClient();
    const secondClient = new FakeAcpClient();
    secondClient.sessionId = "acp-session-2";
    secondClient.promptNotificationParams = {
      sessionId: "acp-session-2",
      update: { sessionUpdate: "agent_message_chunk", content: "second" },
    };
    const { ctx, harness, leaseFactory, leases, root } = await fixture({
      clients: [firstClient, secondClient],
      lifecycle: "reuse_by_issue",
    });

    await collectEvents(harness.run(ctx, "First"));
    const otherWorkspaceCtx: AgentRunContext = {
      ...ctx,
      workspace: { ...ctx.workspace, path: path.join(root, "workspace-two"), workspaceKey: "ENG-139-other" },
      turnNumber: 2,
    };
    const secondEvents = await collectEvents(harness.run(otherWorkspaceCtx, "Second"));

    expect(leaseFactory).toHaveBeenCalledTimes(2);
    expect(firstClient.kills).toEqual([]);
    expect(leases[0]?.disposeStatuses).toEqual([]);
    expect(leases[1]?.disposeStatuses).toEqual([]);
    expect(leaseDecisionPayloads(secondEvents)).toEqual([
      expect.objectContaining({
        outcome: "created",
        reuseMode: "reuse_by_issue",
        reason: "fresh_no_existing_reusable_lease",
        reusable: true,
        profileName: "profile-2",
      }),
    ]);
    await harness.dispose();
  });

  it("creates a new reusable lease and repeats the ACP handshake after a process restart", async () => {
    const firstClient = new FakeAcpClient();
    const secondClient = new FakeAcpClient();
    secondClient.sessionId = "acp-session-2";
    secondClient.promptNotificationParams = {
      sessionId: "acp-session-2",
      update: { sessionUpdate: "agent_message_chunk", content: "after restart" },
    };
    const { ctx, harness, acpClientFactory, leaseFactory, leases } = await fixture({
      clients: [firstClient, secondClient],
      lifecycle: "reuse_by_issue",
    });

    await collectEvents(harness.run(ctx, "First"));
    firstClient.emitExit({ code: 0, signal: null });
    await Promise.resolve();
    const secondEvents = await collectEvents(harness.run({ ...ctx, turnNumber: 2 }, "Second"));
    await harness.dispose();

    expect(leaseFactory).toHaveBeenCalledTimes(2);
    expect(acpClientFactory).toHaveBeenCalledTimes(2);
    expect(firstClient.requests.map((request) => request.method)).toEqual([
      "initialize",
      "authenticate",
      "session/new",
      "session/prompt",
    ]);
    expect(secondClient.requests.map((request) => request.method)).toEqual([
      "initialize",
      "authenticate",
      "session/new",
      "session/prompt",
    ]);
    expect(leases[0]?.disposeStatuses).toEqual(["failed"]);
    expect(leases[1]?.disposeStatuses).toEqual([null]);
    expect(leaseDecisionPayloads(secondEvents)).toEqual([
      expect.objectContaining({
        outcome: "created",
        reuseMode: "reuse_by_issue",
        reason: "fresh_previous_process_exited",
        reusable: true,
        profileName: "profile-2",
      }),
    ]);
  });

  it("persists actual ACP harness updates exactly once through the orchestrator shared runStore", async () => {
    const client = new FakeAcpClient();
    client.sessionNewNotificationParams = {
      sessionId: "acp-session-1",
      update: { sessionUpdate: "agent_message_chunk", content: "before active session" },
    };
    client.promptDeferred = deferred<Record<string, unknown> | null>();
    client.promptStarted = deferred<void>();
    client.promptNotificationParams = [
      { sessionId: "other-session", update: { sessionUpdate: "agent_message_chunk", content: "wrong session" } },
      { sessionId: "acp-session-1", update: { session_update: "agent_thought_chunk", content: { type: "text", text: "thinking" } } },
      {
        sessionId: "acp-session-1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-1",
          kind: "execute",
          title: "terminal",
          status: "started",
          content: { command: "npm test", apiKey: "not-a-real-token-placeholder" },
        },
      },
      {
        sessionId: "acp-session-1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-1",
          kind: "execute",
          content: "tests passed",
          result: { exitCode: 0 },
          status: "completed",
        },
      },
      {
        sessionId: "acp-session-1",
        update: { sessionUpdate: "tool_call", toolCallId: "call-2", kind: "execute", title: "terminal", status: "started", content: { command: "rm -rf /tmp" } },
      },
      {
        sessionId: "acp-session-1",
        update: { sessionUpdate: "tool_call_update", toolCallId: "call-2", kind: "execute", status: "failed", content: "permission denied" },
      },
      {
        sessionId: "acp-session-1",
        update: {
          sessionUpdate: "plan",
          entries: [
            { status: "in_progress", content: "Persist plan SECRET_ACP_PLAN_TOKEN" },
            { status: "completed", title: "Persist tools" },
          ],
        },
      },
      { sessionId: "acp-session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello " } } },
      { sessionId: "acp-session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } } },
      { sessionId: "acp-session-1", update: { sessionUpdate: "usage_update", used: 9, size: 100 } },
      { sessionId: "acp-session-1", update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "/help" }] } },
      { sessionId: "acp-session-1", update: { sessionUpdate: "future_update", details: "still visible as diagnostic" } },
    ];
    const { config, harness } = await fixture({ client });
    const candidate: Issue = { ...issue(), id: "issue-acp-orchestrated", identifier: "ENG-194", state: "Todo", branchName: "symphony/ENG-194" };
    let active = true;
    let refreshes = 0;
    const tracker: TrackerClient = {
      async fetchCandidateIssues() {
        return active ? [candidate] : [];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        refreshes += 1;
        if (refreshes === 1) return [candidate];
        active = false;
        return [{ ...candidate, state: "Done" }];
      },
    };
    const logger = new StructuredLogger(() => undefined);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const workspaceManager = new WorkspaceManager({ workspace: config.workspace, hooks: config.hooks, logger });
    const orchestrator = new Orchestrator({
      config,
      tracker,
      workspaceManager,
      harness,
      logger,
      promptTemplate: "Work on {{ issue.identifier }}",
      runStore,
    });

    const refreshPromise = orchestrator.refreshNow();
    await client.promptStarted.promise;
    client.emitDiagnostic({ code: "host_hermes_notice", message: "runtime notice", details: { apiKey: "not-a-real-token-placeholder" } });
    const permissionResponses = await client.invokeClientRequest("session/request_permission", {
      sessionId: "acp-session-1",
      toolCall: { name: "dangerous" },
    });
    client.promptDeferred.resolve({ stopReason: "end_turn", usage: { input: 1, output: 2, total: 3 } });
    await refreshPromise;
    await waitFor(() => orchestrator.snapshot().counts.running === 0, "orchestrated ACP run to finish");
    await orchestrator.stop();

    expect(permissionResponses).toEqual([{ outcome: { outcome: "cancelled" } }]);
    const run = await runStore.latestRunForIssue(candidate.id);
    expect(run).toMatchObject({ status: "succeeded", tokens: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } });
    expect(run?.runId).toMatch(/^hermes-acp-/);
    const transcript = await runStore.readTranscript(run?.runId ?? "missing-run");
    const counts = eventTypeCounts(transcript.events);
    expect(counts).toEqual({
      session_started: 1,
      runtime_ready: 1,
      assistant_reasoning_delta: 1,
      tool_call_started: 2,
      tool_call_completed: 1,
      tool_call_failed: 1,
      plan_update: 1,
      assistant_message_delta: 2,
      runtime_status_update: 2,
      available_commands_update: 1,
      runtime_diagnostic: 4,
      token_usage_reported: 1,
      run_succeeded: 1,
    });
    expect(transcript.events.every((event) => event.source === "harness")).toBe(true);
    expect(transcript.events.map((event) => event.eventType)).not.toEqual(
      expect.arrayContaining(["hermes_acp_profile", "acp_session_update", "acp_permission_denied", "acp_diagnostic", "session/update", "tool_call", "tool_call_update"]),
    );
    const payloadJson = JSON.stringify(transcript.events.map((event) => event.payload));
    expect(payloadJson).not.toContain("before active session");
    expect(payloadJson).not.toContain("wrong session");
    expect(payloadJson).not.toContain("not-a-real-token-placeholder");
    expect(payloadJson).not.toContain("SECRET_ACP_PLAN_TOKEN");
    expect(payloadJson).toContain("[redacted]");

    const call1Events = transcript.events.filter((event) => (event.payload as Record<string, unknown> | undefined)?.toolCallId === "call-1");
    expect(call1Events.map((event) => event.eventType)).toEqual(["tool_call_started", "tool_call_completed"]);
    expect(call1Events.map((event) => event.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolCallId: "call-1", toolName: "terminal", toolKind: "execute", status: "running", inputPreview: expect.stringContaining("npm test") }),
        expect.objectContaining({ toolCallId: "call-1", toolName: "terminal", toolKind: "execute", status: "succeeded", outputPreview: "tests passed" }),
      ]),
    );
    const call2Events = transcript.events.filter((event) => (event.payload as Record<string, unknown> | undefined)?.toolCallId === "call-2");
    expect(call2Events.map((event) => event.eventType)).toEqual(["tool_call_started", "tool_call_failed"]);
    expect(call2Events.map((event) => event.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolCallId: "call-2", toolName: "terminal", toolKind: "execute", status: "running", inputPreview: expect.stringContaining("rm -rf /tmp") }),
        expect.objectContaining({ toolCallId: "call-2", toolName: "terminal", toolKind: "execute", status: "failed", errorPreview: "permission denied" }),
      ]),
    );
    expect(call2Events[1]?.payload).not.toHaveProperty("outputPreview");
    const persistedPlanUpdate = transcript.events.find((event) => event.eventType === "plan_update");
    expect(persistedPlanUpdate).toMatchObject({
      eventType: "plan_update",
      message: "Hermes ACP plan updated: 1 in_progress, 1 completed; active: Persist plan [redacted]",
      payload: expect.objectContaining({
        updateKind: "plan",
        updateCategory: "plan",
        statusCounts: { in_progress: 1, completed: 1 },
        activeEntries: ["Persist plan [redacted]"],
      }),
    });
    expect(transcript.events.filter((event) => event.eventType === "runtime_diagnostic").map((event) => event.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "hermes_acp_lease_reuse_decision" }),
        expect.objectContaining({ code: "hermes_acp_unknown_session_update" }),
        expect.objectContaining({ code: "host_hermes_notice", severity: "info" }),
        expect.objectContaining({ code: "hermes_acp_permission_denied", severity: "warning" }),
      ]),
    );

    const projected = projectWebTranscript(transcript.events, { includeRunPrelude: false });
    expect(projected.flatMap((message) => message.kind === "assistant" ? [message.text] : [])).toEqual(["hello world"]);
    const projectedToolMessages = projected.filter((message) => message.kind === "tool_call");
    expect(projectedToolMessages).toEqual([
      expect.objectContaining({
        kind: "tool_call",
        call_id: "call-1",
        name: "terminal",
        status: "succeeded",
        args: { preview: expect.stringContaining("npm test") },
        output: "tests passed",
        result: expect.stringContaining("exitCode"),
      }),
      expect.objectContaining({
        kind: "tool_call",
        call_id: "call-2",
        name: "terminal",
        status: "failed",
        args: { preview: expect.stringContaining("rm -rf /tmp") },
        error: "permission denied",
      }),
    ]);
    expect(projected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "status", state: "plan_update", text: "Hermes ACP plan updated: 1 in_progress, 1 completed; active: Persist plan [redacted]" }),
      ]),
    );
    expect(projected.flatMap((message) => message.kind === "status" ? [message.state] : [])).not.toEqual(
      expect.arrayContaining(["acp_session_update", "acp_permission_denied", "acp_diagnostic", "session/update", "tool_call", "tool_call_update"]),
    );
  });

  it("fails ACP permission requests closed when no approval bridge is configured and maps normalized diagnostics", async () => {
    const client = new FakeAcpClient();
    client.promptDeferred = deferred<Record<string, unknown> | null>();
    client.promptStarted = deferred<void>();
    client.promptNotificationParams = null;
    const { ctx, harness } = await fixture({ client });
    const { runPromise } = await startPendingRun({ client, ctx, harness });

    client.emitDiagnostic({ code: "host_hermes_notice", message: "runtime notice", details: { apiKey: "not-a-real-token-placeholder" } });
    const responses = await client.invokeClientRequest("session/request_permission", terminalPermissionRequest());
    client.promptDeferred.resolve({ stopReason: "end_turn" });
    const events = await runPromise;
    const transcriptEvents = transcriptEventsFromAgentEvents(events);

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
    expect(transcriptEvents.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["runtime_ready", "runtime_diagnostic", "runtime_diagnostic"]),
    );
    expect(transcriptEvents.map((event) => event.eventType)).not.toEqual(expect.arrayContaining(["acp_permission_denied", "acp_diagnostic"]));
    expect(transcriptEvents.map((event) => event.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "runtime_diagnostic", code: "host_hermes_notice", severity: "info" }),
        expect.objectContaining({
          kind: "runtime_diagnostic",
          code: "hermes_acp_permission_denied",
          severity: "warning",
          outcome: "cancelled",
        }),
      ]),
    );
    const projectedStates = projectWebTranscript(transcriptEvents).flatMap((message) => message.kind === "status" ? [message.state] : []);
    expect(projectedStates).not.toEqual(expect.arrayContaining(["acp_permission_denied", "acp_diagnostic"]));
    expect(JSON.stringify(transcriptEvents.map((event) => event.payload))).not.toContain("not-a-real-token-placeholder");
  });

  it("returns the explicit bridge permission selection only when the resolver chooses an offered option", async () => {
    const client = new FakeAcpClient();
    client.promptDeferred = deferred<Record<string, unknown> | null>();
    client.promptStarted = deferred<void>();
    client.promptNotificationParams = null;
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
    const { ctx, harness } = await fixture({ client, permissionResolver });
    const { runPromise } = await startPendingRun({ client, ctx, harness });

    const responses = await client.invokeClientRequest("session/request_permission", terminalPermissionRequest());
    client.promptDeferred.resolve({ stopReason: "end_turn" });
    const events = await runPromise;
    const transcriptEvents = transcriptEventsFromAgentEvents(events);

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
    expect(transcriptEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "runtime_status_update",
          message: "Host Hermes ACP permission allow_once for terminal_execute",
          payload: expect.objectContaining({
            kind: "runtime_status_update",
            status: "permission_selected",
            outcome: "selected",
            selectedOptionId: "allow_once",
            requestKind: "terminal_execute",
          }),
        }),
      ]),
    );
    expect(transcriptEvents.map((event) => event.eventType)).not.toEqual(
      expect.arrayContaining(["acp_permission_selected", "acp_permission_denied"]),
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
      const permissionResolver = vi.fn((input: Parameters<HermesAcpPermissionResolver>[0]) => {
        expect(input.request.requestKind).toBe(requestKind);
        return { optionId };
      });
      const { ctx, harness } = await fixture({ client, permissionResolver });
      const { runPromise } = await startPendingRun({ client, ctx, harness });

      const responses = await client.invokeClientRequest("session/request_permission", params());
      client.promptDeferred.resolve({ stopReason: "end_turn" });
      const events = await runPromise;
      const transcriptEvents = transcriptEventsFromAgentEvents(events);

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
      expect(transcriptEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventType: "runtime_status_update",
            message: `Host Hermes ACP permission ${optionId} for ${requestKind}`,
            payload: expect.objectContaining({
              kind: "runtime_status_update",
              status: "permission_selected",
              selectedOptionId: optionId,
              requestKind,
            }),
          }),
        ]),
      );
      expect(transcriptEvents.map((event) => event.eventType)).not.toEqual(
        expect.arrayContaining(["acp_permission_selected", "acp_permission_denied"]),
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
    const resolverStarted = deferred<void>();
    const permissionDecision = deferred<string>();
    const permissionResolver = vi.fn(() => {
      resolverStarted.resolve();
      return permissionDecision.promise;
    });
    const { ctx, harness } = await fixture({ client, permissionResolver });
    const { runId, runPromise } = await startPendingRun({ client, ctx, harness });

    const responsePromise = client.invokeClientRequest("session/request_permission", terminalPermissionRequest());
    await resolverStarted.promise;
    await harness.stop(runId);
    permissionDecision.resolve("allow_always");
    const responses = await responsePromise;
    const events = await runPromise;
    const transcriptEvents = transcriptEventsFromAgentEvents(events);

    expect(permissionResolver).toHaveBeenCalledTimes(1);
    expect(client.cancelledParams).toEqual([{ sessionId: "acp-session-1" }]);
    expect(responses).toEqual([{ outcome: { outcome: "cancelled" } }]);
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "cancelled" })]));
    expect(events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "progress",
          activitySource: "tool",
          message: expect.stringContaining("Host Hermes ACP permission"),
        }),
      ]),
    );
    expect(transcriptEvents).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "runtime_status_update",
          payload: expect.objectContaining({ status: "permission_selected" }),
        }),
      ]),
    );
    expect(transcriptEvents.map((event) => event.eventType)).not.toEqual(
      expect.arrayContaining(["acp_permission_selected", "acp_permission_denied"]),
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
    clients?: FakeAcpClient[];
    lifecycle?: HermesWorkerSessionLifecycle;
    provider?: string | null;
    sourceProfile?: string | null;
    permissionResolver?: HermesAcpPermissionResolver;
    permissionRequestTimeoutMs?: number;
  } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "symphony-hermes-acp-"));
  const config = serviceConfig(root, input.lifecycle ?? "fresh_per_run", {
    provider: input.provider,
    sourceProfile: input.sourceProfile,
  });
  const ctx = runContext(config, root);
  const clients = input.clients ?? [input.client ?? new FakeAcpClient()];
  const client = clients[0] ?? new FakeAcpClient();
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
  let clientIndex = 0;
  const acpClientFactory = vi.fn((_command: HostHermesAcpProcessCommand, _options: HermesAcpRuntimeClientOptions): HermesAcpRuntimeClient => {
    const nextClient = clients[Math.min(clientIndex, clients.length - 1)] ?? client;
    clientIndex += 1;
    return nextClient;
  });
  const harnessOptions = {
    cliPath: path.join(root, "src", "cli.ts"),
    profileLeaseFactory: leaseFactory,
    acpClientFactory,
    ...(input.permissionResolver === undefined ? {} : { permissionResolver: input.permissionResolver }),
    ...(input.permissionRequestTimeoutMs === undefined ? {} : { permissionRequestTimeoutMs: input.permissionRequestTimeoutMs }),
  } satisfies HermesAcpHarnessOptions;
  const harness = new HermesAcpHarness(harnessOptions);
  return { root, config, ctx, client, harness, leaseFactory, acpClientFactory, leases };
}

function serviceConfig(
  root: string,
  lifecycle: HermesWorkerSessionLifecycle,
  options: { provider?: string | null | undefined; sourceProfile?: string | null | undefined } = {},
): ServiceConfig {
  const hermesConfig: Record<string, unknown> = {
    upstream_root: path.join(root, "hermes-src"),
    templates_dir: path.join(root, "templates"),
    model: "gpt-5.5",
    keep_profiles: "never",
    worker_session_lifecycle: lifecycle,
    startup_timeout_ms: 1_000,
    request_timeout_ms: 1_000,
    acp_binary_path: "/host/bin/hermes",
  };
  if (options.provider !== null) hermesConfig.provider = options.provider ?? "openai-codex";
  if (options.sourceProfile !== null) hermesConfig.acp_source_profile = options.sourceProfile ?? "host-source";
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
      hermes: hermesConfig,
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

function eventText(events: AgentEvent[]): string {
  return events
    .map((event) => {
      switch (event.type) {
        case "run_diagnostic":
        case "progress":
        case "completed":
          return event.message ?? "";
        case "failed":
          return event.error;
        default:
          return "";
      }
    })
    .join("\n");
}

function transcriptEventsFromAgentEvents(events: AgentEvent[]): TranscriptEvent[] {
  const started = events.find((event): event is Extract<AgentEvent, { type: "session_started" }> => event.type === "session_started");
  const runId = started?.runId ?? started?.sessionId ?? "hermes-acp-test-run";
  return events.map((event, index) => ({
    runId,
    sequence: index + 1,
    at: event.at ?? new Date(index).toISOString(),
    source: "harness",
    ...mapAgentEventToRunActivityEvent(event),
  }));
}

function leaseDecisionPayloads(events: AgentEvent[]): unknown[] {
  return events.flatMap((event) =>
    event.type === "run_diagnostic" && event.code === "hermes_acp_lease_reuse_decision" ? [event.payload] : [],
  );
}

function eventTypeCounts(events: TranscriptEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) counts[event.eventType] = (counts[event.eventType] ?? 0) + 1;
  return counts;
}

async function waitFor(condition: () => boolean | Promise<boolean>, label: string, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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

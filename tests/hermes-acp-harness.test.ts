import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  HermesAcpHarness,
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
  authenticateResult: unknown = {};
  authenticateError: unknown = null;
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
        if (this.authenticateError) throw this.authenticateError;
        return this.authenticateResult as T;
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

  it("creates a new reusable lease and repeats the ACP handshake after a process restart", async () => {
    const firstClient = new FakeAcpClient();
    const secondClient = new FakeAcpClient();
    secondClient.sessionId = "acp-session-2";
    secondClient.promptNotificationParams = {
      sessionId: "acp-session-2",
      update: { sessionUpdate: "agent_message_chunk", content: "after restart" },
    };
    const { ctx, harness, acpClientFactory, leaseFactory } = await fixture({
      clients: [firstClient, secondClient],
      lifecycle: "reuse_by_issue",
    });

    await collectEvents(harness.run(ctx, "First"));
    firstClient.emitExit({ code: 0, signal: null });
    await Promise.resolve();
    await collectEvents(harness.run({ ...ctx, turnNumber: 2 }, "Second"));
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
  });

  it("denies ACP permission requests until Symphony has an approval bridge", async () => {
    const client = new FakeAcpClient();
    client.promptDeferred = deferred<Record<string, unknown> | null>();
    client.promptStarted = deferred<void>();
    client.promptNotificationParams = null;
    const { ctx, harness } = await fixture({ client });
    const started = deferred<string>();

    const runPromise = collectEvents(harness.run(ctx, "Do work"), (event) => {
      if (event.type === "session_started" && event.runId) started.resolve(event.runId);
    });
    await started.promise;
    await client.promptStarted.promise;
    const responses = await client.invokeClientRequest("session/request_permission", {
      sessionId: "acp-session-1",
      toolCall: { name: "dangerous" },
    });
    client.promptDeferred.resolve({ stopReason: "end_turn" });
    const events = await runPromise;

    expect(responses).toEqual([{ outcome: { outcome: "cancelled" } }]);
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ code: "hermes_acp_permission_denied" })]));
  });
});

async function fixture(
  input: {
    client?: FakeAcpClient;
    clients?: FakeAcpClient[];
    lifecycle?: HermesWorkerSessionLifecycle;
    provider?: string | null;
    sourceProfile?: string | null;
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
  const harness = new HermesAcpHarness({
    cliPath: path.join(root, "src", "cli.ts"),
    profileLeaseFactory: leaseFactory,
    acpClientFactory,
  });
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

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

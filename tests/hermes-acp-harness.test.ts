import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  HermesAcpHarness,
  mcpServersToAcpStdioServers,
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
  sessionId = "acp-session-1";
  promptResult: Record<string, unknown> | null = { stopReason: "end_turn", usage: { input: 1, output: 2, total: 3 } };
  sessionNewError: Error | null = null;
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
        if (this.sessionNewError) throw this.sessionNewError;
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

async function fixture(input: { client?: FakeAcpClient; lifecycle?: HermesWorkerSessionLifecycle } = {}) {
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
  const harness = new HermesAcpHarness({
    cliPath: path.join(root, "src", "cli.ts"),
    profileLeaseFactory: leaseFactory,
    acpClientFactory,
  });
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

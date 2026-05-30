import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HermesAcpHarness } from "../hermes/src/HermesAcpHarness.js";
import type {
  HermesAcpClient,
  HermesAcpFacadeEvent,
  HermesAcpFacadeOptions,
  HermesAcpPromptResult,
  HermesAcpSession,
} from "../hermes/src/HermesAcpFacade.js";
import type {
  HostHermesAcpProcessCommand,
  HostHermesAcpProfileLease,
  HostHermesAcpProfileLeaseOptions,
  HostHermesAcpTerminalStatus,
} from "../hermes/src/HostHermesAcpProfileLease.js";
import { parseServiceConfig } from "../src/core/config/Config.js";
import type { AgentEvent, AgentRunContext } from "../src/core/harness/AgentHarness.js";
import type { ServiceConfig } from "../src/core/config/Config.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import { issue } from "./helpers.js";

let root: string;

describe("HermesAcpHarness", () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-hermes-acp-harness-"));
  });

  afterEach(async () => {
    delete process.env.HERMES_ACP_TEST_TOKEN;
    await rm(root, { recursive: true, force: true });
  });

  it("runs worker turns through a cloned host Hermes ACP profile and reuses the issue session when configured", async () => {
    const clients: FakeHermesAcpClient[] = [];
    const leaseOptions: HostHermesAcpProfileLeaseOptions[] = [];
    const disposals: Array<{ profileName: string; status: HostHermesAcpTerminalStatus }> = [];
    const harness = new HermesAcpHarness({
      cliPath: path.join(root, "cli.js"),
      profileLeaseFactory: async (options) => {
        leaseOptions.push(options);
        return fakeLease(`profile-${leaseOptions.length}`, disposals);
      },
      acpClientFactory: (command, options) => {
        const client = new FakeHermesAcpClient(command, options);
        clients.push(client);
        return client;
      },
    });
    const config = configForHarness({ worker_session_lifecycle: "reuse_by_issue", keep_profiles: "never" });
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });

    const first = await collect(harness.run(context(config, { workspacePath, turnNumber: 1 }), "first prompt"));
    const second = await collect(harness.run(context(config, { workspacePath, turnNumber: 2 }), "second prompt"));

    expect(first.map((event) => event.type)).toEqual(
      expect.arrayContaining(["session_started", "progress", "tokens", "completed"]),
    );
    expect(first.find((event): event is Extract<AgentEvent, { type: "completed" }> => event.type === "completed")?.message).toBe(
      "reply:first prompt",
    );
    expect(second.find((event): event is Extract<AgentEvent, { type: "completed" }> => event.type === "completed")?.message).toBe(
      "reply:second prompt",
    );
    expect(leaseOptions).toHaveLength(1);
    expect(leaseOptions[0]).toMatchObject({
      binaryPath: "/usr/local/bin/hermes",
      sourceProfile: "operator",
      keepProfiles: "never",
      nameInput: expect.objectContaining({
        prefix: "dogfood",
        issueIdentifier: "TEST-1",
        role: "worker",
        phase: "implementation",
        runId: null,
      }),
    });
    expect(clients).toHaveLength(1);
    expect(clients[0]?.initializeCalls).toBe(1);
    expect(clients[0]?.sessions).toHaveLength(1);
    expect(clients[0]?.sessions[0]?.mcpServers.map((server) => server.name)).toEqual(["symphony"]);
    expect(clients[0]?.prompts.map((prompt) => prompt.prompt)).toEqual(["first prompt", "second prompt"]);
    expect(disposals).toEqual([]);

    await harness.dispose();
    expect(disposals).toEqual([{ profileName: "profile-1", status: null }]);
  });

  it("retires a reusable worker lease after an idle ACP exit and creates a fresh session on the next turn", async () => {
    const clients: FakeHermesAcpClient[] = [];
    const leaseOptions: HostHermesAcpProfileLeaseOptions[] = [];
    const disposals: Array<{ profileName: string; status: HostHermesAcpTerminalStatus }> = [];
    const harness = new HermesAcpHarness({
      cliPath: path.join(root, "cli.js"),
      profileLeaseFactory: async (options) => {
        leaseOptions.push(options);
        return fakeLease(`profile-${leaseOptions.length}`, disposals);
      },
      acpClientFactory: (command, options) => {
        const client = new FakeHermesAcpClient(command, options);
        clients.push(client);
        return client;
      },
    });
    const config = configForHarness({ worker_session_lifecycle: "reuse_by_issue", keep_profiles: "never" });
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });

    const first = await collect(harness.run(context(config, { workspacePath, turnNumber: 1 }), "first prompt"));
    expect(first.map((event) => event.type)).toContain("completed");
    expect(clients).toHaveLength(1);
    expect(leaseOptions).toHaveLength(1);
    expect(clients[0]?.prompts).toEqual([{ sessionId: "sess-1", prompt: "first prompt" }]);

    clients[0]?.emitIdleExit(0);
    await flushAsyncDisposal();

    const second = await collect(harness.run(context(config, { workspacePath, turnNumber: 2 }), "second prompt"));

    expect(second.map((event) => event.type)).toContain("completed");
    expect(leaseOptions).toHaveLength(2);
    expect(clients).toHaveLength(2);
    expect(clients[0]?.prompts).toEqual([{ sessionId: "sess-1", prompt: "first prompt" }]);
    expect(clients[1]?.initializeCalls).toBe(1);
    expect(clients[1]?.sessions).toHaveLength(1);
    expect(clients[1]?.prompts).toEqual([{ sessionId: "sess-1", prompt: "second prompt" }]);
    expect(disposals).toContainEqual({ profileName: "profile-1", status: "failed" });

    await harness.dispose();
    expect(disposals).toContainEqual({ profileName: "profile-2", status: null });
  });

  it("uses fresh reviewer ACP profiles and disposes them after each review run", async () => {
    const clients: FakeHermesAcpClient[] = [];
    const disposals: Array<{ profileName: string; status: HostHermesAcpTerminalStatus }> = [];
    const harness = new HermesAcpHarness({
      cliPath: path.join(root, "cli.js"),
      profileLeaseFactory: async () => fakeLease(`profile-${disposals.length + clients.length + 1}`, disposals),
      acpClientFactory: (command, options) => {
        const client = new FakeHermesAcpClient(command, options);
        clients.push(client);
        return client;
      },
    });
    const config = configForHarness({ worker_session_lifecycle: "reuse_by_issue", keep_profiles: "never" });
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });

    const one = await collect(harness.run(context(config, { workspacePath, role: "reviewer", runPhase: "review", turnNumber: 1 }), "review one"));
    const two = await collect(harness.run(context(config, { workspacePath, role: "reviewer", runPhase: "review", turnNumber: 2 }), "review two"));

    expect(one.map((event) => event.type)).toContain("completed");
    expect(two.map((event) => event.type)).toContain("completed");
    expect(clients).toHaveLength(2);
    expect(disposals).toEqual([
      { profileName: "profile-1", status: "succeeded" },
      { profileName: "profile-3", status: "succeeded" },
    ]);
    expect(clients[0]?.sessions[0]?.mcpServers.map((server) => server.name)).toEqual([
      "symphony_review_verdict",
      "symphony_review_feedback",
    ]);
  });

  it("retires a reusable lease after premature ACP exit, redacts the log tail, and recovers on the next run", async () => {
    const clients: FakeHermesAcpClient[] = [];
    const disposals: Array<{ profileName: string; status: HostHermesAcpTerminalStatus }> = [];
    const leakedSecret = "very-secret-hermes-acp-token";
    process.env.HERMES_ACP_TEST_TOKEN = leakedSecret;
    const harness = new HermesAcpHarness({
      cliPath: path.join(root, "cli.js"),
      profileLeaseFactory: async () => fakeLease(`profile-${clients.length + 1}`, disposals),
      acpClientFactory: (command, options) => {
        const client = new FakeHermesAcpClient(command, options, {
          exitOnPrompt: clients.length === 0,
          logTail: `line one\nleaked ${leakedSecret}`,
        });
        clients.push(client);
        return client;
      },
    });
    const config = configForHarness({ worker_session_lifecycle: "reuse_by_issue", keep_profiles: "failed" });
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });

    const failed = await collect(harness.run(context(config, { workspacePath, turnNumber: 1 }), "boom"));
    const recovered = await collect(harness.run(context(config, { workspacePath, turnNumber: 2 }), "recover"));

    expect(failed.map((event) => event.type)).toContain("failed");
    const diagnostic = failed.find(
      (event): event is Extract<AgentEvent, { type: "run_diagnostic" }> =>
        event.type === "run_diagnostic" && event.code === "hermes_acp_run_error",
    );
    expect(diagnostic?.payload).toMatchObject({
      profileName: "profile-1",
      acpLogTail: { lines: ["line one", "leaked [redacted]"] },
    });
    expect(JSON.stringify(diagnostic?.payload)).not.toContain(leakedSecret);
    expect(recovered.map((event) => event.type)).toContain("completed");
    expect(clients).toHaveLength(2);
    expect(disposals).toEqual([{ profileName: "profile-1", status: "failed" }]);
  });
});

function fakeLease(
  profileName: string,
  disposals: Array<{ profileName: string; status: HostHermesAcpTerminalStatus }>,
): HostHermesAcpProfileLease {
  return {
    profileName,
    sourceProfile: "operator",
    acpCommand: { file: "/usr/local/bin/hermes", args: ["-p", profileName, "acp"], cwd: root, env: { PATH: process.env.PATH } },
    dispose: async (status) => {
      disposals.push({ profileName, status });
      return { profileName, reason: status === "failed" ? "retained" : "deleted", deleted: status !== "failed" };
    },
  };
}

class FakeHermesAcpClient implements HermesAcpClient {
  readonly sessions: Array<{ cwd: string; mcpServers: Array<{ name: string }> }> = [];
  readonly prompts: Array<{ sessionId: string; prompt: string }> = [];
  readonly closeReasons: string[] = [];
  readonly killReasons: string[] = [];
  initializeCalls = 0;
  private readonly emitter = new EventEmitter();

  constructor(
    readonly command: HostHermesAcpProcessCommand,
    readonly options: HermesAcpFacadeOptions,
    private readonly behavior: { exitOnPrompt?: boolean; logTail?: string } = {},
  ) {}

  on(event: "event", listener: (event: HermesAcpFacadeEvent) => void): this;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "event" | "exit", listener: (...args: any[]) => void): this {
    this.emitter.on(event, listener);
    return this;
  }

  off(event: "event", listener: (event: HermesAcpFacadeEvent) => void): this;
  off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  off(event: "event" | "exit", listener: (...args: any[]) => void): this {
    this.emitter.off(event, listener);
    return this;
  }

  async initialize(): Promise<Record<string, unknown>> {
    this.initializeCalls += 1;
    return { protocolVersion: 1 };
  }

  async newSession(input: { cwd: string; mcpServers: Array<{ name: string }> }): Promise<HermesAcpSession> {
    this.sessions.push(input);
    return { sessionId: `sess-${this.sessions.length}`, raw: { sessionId: `sess-${this.sessions.length}` } };
  }

  async prompt(input: { sessionId: string; prompt: string }): Promise<HermesAcpPromptResult> {
    this.prompts.push(input);
    if (this.behavior.exitOnPrompt) {
      this.emitter.emit("exit", 0, null);
      return new Promise(() => undefined);
    }
    this.emitter.emit("event", {
      type: "session.update",
      sessionId: input.sessionId,
      update: { sessionUpdate: "agent_thought_chunk", content: { text: `thinking:${input.prompt}` } },
      raw: {},
    } satisfies HermesAcpFacadeEvent);
    this.emitter.emit("event", {
      type: "session.update",
      sessionId: input.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { text: `reply:${input.prompt}` } },
      raw: {},
    } satisfies HermesAcpFacadeEvent);
    return { stopReason: "end_turn", usage: { input: 1, output: 2, total: 3 }, raw: { stopReason: "end_turn" } };
  }

  async cancel(_sessionId: string): Promise<void> {
    return;
  }

  async close(reason?: string): Promise<void> {
    this.closeReasons.push(reason ?? "close");
  }

  kill(reason?: string): void {
    this.killReasons.push(reason ?? "kill");
  }

  getLogTail(): string {
    return this.behavior.logTail ?? "";
  }

  emitIdleExit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.emitter.emit("exit", code, signal);
  }
}

async function flushAsyncDisposal(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function configForHarness(hermesAcp: Record<string, unknown> = {}): ServiceConfig {
  return parseServiceConfig(
    {
      tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
      workspace: { root, state_dir: path.join(root, "state") },
      agent: { harness: "hermes_acp" },
      hermes_acp: {
        binary: "/usr/local/bin/hermes",
        source_profile: "operator",
        profile_name_prefix: "dogfood",
        ...hermesAcp,
      },
    },
    path.join(root, "WORKFLOW.md"),
    { LINEAR_API_KEY: "linear-secret" },
  );
}

function context(
  config: ServiceConfig,
  overrides: Partial<Pick<AgentRunContext, "role" | "runPhase" | "turnNumber">> & { workspacePath: string },
): AgentRunContext {
  return {
    issue: issue({ id: "issue-1", identifier: "TEST-1" }),
    role: overrides.role ?? "worker",
    runPhase: overrides.runPhase ?? "implementation",
    attempt: null,
    workspace: { path: overrides.workspacePath, workspaceKey: "workspace-key", createdNow: true },
    config,
    turnNumber: overrides.turnNumber ?? 1,
    abortSignal: new AbortController().signal,
    logger: new StructuredLogger(() => undefined),
  };
}

async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

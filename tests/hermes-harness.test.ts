import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HermesHarness } from "../hermes/src/HermesHarness.js";
import type { GatewayEvent, HermesGatewayClient, HermesGatewayEnvironment } from "../hermes/src/GatewayFacade.js";
import { parseServiceConfig } from "../src/core/config/Config.js";
import type { AgentEvent, AgentRunContext } from "../src/core/harness/AgentHarness.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import { issue } from "./helpers.js";

let root: string;

describe("HermesHarness", () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-hermes-harness-"));
    for (const template of ["worker", "reviewer", "planner"]) {
      const templateDir = path.join(root, "templates", template);
      await mkdir(templateDir, { recursive: true });
      await writeFile(path.join(templateDir, "SOUL.md"), `${template} soul\n`, "utf8");
      await writeFile(
        path.join(templateDir, "config.yaml"),
        YAML.stringify({
          memory_enabled: template === "worker",
          ...(template === "reviewer" ? { agent: { disabled_toolsets: ["tts", "delegation"] } } : {}),
        }),
        "utf8",
      );
    }
  });

  afterEach(async () => {
    delete process.env.HERMES_TEST_TOKEN;
    await rm(root, { recursive: true, force: true });
  });

  it("acts as a parent harness over reusable workers and fresh reviewer profiles", async () => {
    const clients: FakeGatewayClient[] = [];
    const harness = new HermesHarness({
      cliPath: path.join(root, "cli.js"),
      gatewayFactory: (env) => {
        const client = new FakeGatewayClient(env, `gw-${clients.length + 1}`);
        clients.push(client);
        return client;
      },
    });

    const config = configForHarness();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });

    const workerOne = await collect(harness.run(context(config, { workspacePath, turnNumber: 1 }), "first worker prompt"));
    const workerTwo = await collect(harness.run(context(config, { workspacePath, turnNumber: 2 }), "second worker prompt"));
    const reviewerOne = await collect(
      harness.run(context(config, { workspacePath, role: "reviewer", runPhase: "review", turnNumber: 3 }), "first review"),
    );
    const reviewerTwo = await collect(
      harness.run(context(config, { workspacePath, role: "reviewer", runPhase: "review", turnNumber: 4 }), "second review"),
    );

    expect(workerOne.map((event) => event.type)).toContain("completed");
    expect(workerTwo.map((event) => event.type)).toContain("completed");
    expect(reviewerOne.map((event) => event.type)).toContain("completed");
    expect(reviewerTwo.map((event) => event.type)).toContain("completed");
    expect(clients).toHaveLength(3);
    expect(clients[0]?.requests.filter((request) => request.method === "session.create")).toHaveLength(1);
    expect(clients[0]?.env.extraEnv).toMatchObject({ HERMES_API_KEY: "worker-hermes-secret" });
    expect(new Set(clients.slice(1).map((client) => client.env.hermesHome)).size).toBe(2);
    expect(clients.slice(1).every((client) => client.env.extraEnv?.HERMES_API_KEY === "reviewer-hermes-secret")).toBe(true);

    const workerConfig = YAML.parse(await readFile(path.join(clients[0]!.env.hermesHome, "config.yaml"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(workerConfig).toMatchObject({
      memory_enabled: true,
      mcp_servers: {
        symphony: {
          command: process.execPath,
        },
      },
    });

    const reviewerConfig = YAML.parse(await readFile(path.join(clients[1]!.env.hermesHome, "config.yaml"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(reviewerConfig).toMatchObject({
      memory_enabled: false,
      agent: {
        disabled_toolsets: ["tts", "delegation"],
      },
      mcp_servers: {
        symphony_review_verdict: {
          command: process.execPath,
        },
        symphony_review_feedback: {
          command: process.execPath,
        },
      },
    });

    await harness.dispose();
    expect(clients[0]?.killed).toContain("hermes.harness_dispose");
  });

  it("uses managed Hermes auth for openai-codex without injecting API-key credentials", async () => {
    const clients: FakeGatewayClient[] = [];
    const harness = new HermesHarness({
      cliPath: path.join(root, "cli.js"),
      gatewayFactory: (env) => {
        const client = new FakeGatewayClient(env, `gw-${clients.length + 1}`);
        clients.push(client);
        return client;
      },
    });
    const bootstrapFrom = path.join(root, "local-hermes");
    await mkdir(bootstrapFrom, { recursive: true });
    await writeFile(
      path.join(bootstrapFrom, "auth.json"),
      JSON.stringify({
        version: 1,
        active_provider: "openai-codex",
        providers: {
          "openai-codex": {
            tokens: { access_token: "access-token", refresh_token: "refresh-token" },
            last_refresh: "2026-05-27T00:00:00Z",
            auth_mode: "chatgpt",
          },
        },
      }),
      "utf8",
    );
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        workspace: { root, state_dir: path.join(root, "state") },
        agent: { harness: "hermes" },
        hermes: {
          upstream_root: path.join(root, "upstream"),
          templates_dir: path.join(root, "templates"),
          state_dir: path.join(root, "state", "hermes"),
          python: "python-test",
          provider: "openai-codex",
          model: "gpt-5-test",
          keep_profiles: "always",
          auth: { bootstrap_from: bootstrapFrom },
        },
      },
      path.join(root, "WORKFLOW.md"),
      { LINEAR_API_KEY: "linear-secret" },
    );
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });

    const events = await collect(harness.run(context(config, { workspacePath, turnNumber: 1 }), "codex prompt"));

    expect(events.map((event) => event.type)).toContain("completed");
    expect(clients[0]?.env.authHome).toBe(config.hermes.auth.managedRoot);
    expect(clients[0]?.env.hermesHome).not.toBe(config.hermes.auth.managedRoot);
    expect(clients[0]?.env.cwd).toBe(workspacePath);
    expect(clients[0]?.env.python).toBe("python-test");
    expect(clients[0]?.env.model).toBe("gpt-5-test");
    expect(clients[0]?.env.provider).toBe("openai-codex");
    expect(clients[0]?.env.extraEnv?.HERMES_API_KEY).toBeUndefined();
    const managedAuth = JSON.parse(await readFile(path.join(config.hermes.auth.managedRoot, "auth.json"), "utf8")) as Record<
      string,
      any
    >;
    expect(managedAuth.providers["openai-codex"].tokens.access_token).toBe("access-token");
  });

  it("retires a reusable worker lease when its gateway exits before completion", async () => {
    const clients: FakeGatewayClient[] = [];
    const leakedSecret = "very-secret-token-123";
    process.env.HERMES_TEST_TOKEN = leakedSecret;
    const harness = new HermesHarness({
      cliPath: path.join(root, "cli.js"),
      gatewayFactory: (env) => {
        const client = new FakeGatewayClient(env, `gw-${clients.length + 1}`, {
          exitOnPrompt: clients.length === 0,
          logTail: ["[lifecycle] child exit code=0", `leaked ${leakedSecret}`].join("\n"),
        });
        clients.push(client);
        return client;
      },
    });

    const config = configForHarness();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });

    const failed = await collect(harness.run(context(config, { workspacePath, turnNumber: 1 }), "first worker prompt"));
    const recovered = await collect(harness.run(context(config, { workspacePath, turnNumber: 2 }), "second worker prompt"));

    expect(failed.map((event) => event.type)).toContain("failed");
    const diagnostic = failed.find(
      (event): event is Extract<AgentEvent, { type: "run_diagnostic" }> => event.type === "run_diagnostic" && event.code === "hermes_gateway_exit",
    );
    expect(diagnostic?.payload).toMatchObject({
      gatewayExitCode: 0,
      gatewayLogTail: {
        lines: expect.arrayContaining(["[lifecycle] child exit code=0", "leaked [redacted]"]),
      },
    });
    expect(JSON.stringify(diagnostic?.payload)).not.toContain(leakedSecret);
    expect(recovered.map((event) => event.type)).toContain("completed");
    expect(clients).toHaveLength(2);
    expect(clients[0]?.requests.filter((request) => request.method === "session.create")).toHaveLength(1);
    expect(clients[1]?.requests.filter((request) => request.method === "session.create")).toHaveLength(1);
    expect(clients[1]?.requests.find((request) => request.method === "prompt.submit")?.params.session_id).toBe("gw-2");
    delete process.env.HERMES_TEST_TOKEN;
  });

  it("submits the prompt before yielding session_started to avoid the Hermes deferred-build race", async () => {
    const clients: FakeGatewayClient[] = [];
    const harness = new HermesHarness({
      cliPath: path.join(root, "cli.js"),
      gatewayFactory: (env) => {
        const client = new FakeGatewayClient(env, `gw-${clients.length + 1}`);
        clients.push(client);
        return client;
      },
    });

    const config = configForHarness();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });

    const iterator = harness.run(context(config, { workspacePath, turnNumber: 1 }), "worker prompt")[Symbol.asyncIterator]();
    const first = await iterator.next();

    expect(first.value?.type).toBe("session_started");
    expect(clients[0]?.requests.map((request) => request.method)).toEqual(["session.create", "prompt.submit"]);

    const remaining: AgentEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      remaining.push(next.value);
    }
    expect(remaining.map((event) => event.type)).toContain("completed");
    await harness.dispose();
  });
});

class FakeGatewayClient extends EventEmitter implements HermesGatewayClient {
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly killed: string[] = [];

  constructor(
    readonly env: HermesGatewayEnvironment,
    private readonly sessionId: string,
    private readonly options: { exitOnPrompt?: boolean; logTail?: string } = {},
  ) {
    super();
  }

  on(event: "event", listener: (event: GatewayEvent) => void): this;
  on(event: "exit", listener: (code: number | null) => void): this;
  on(event: "event" | "exit", listener: ((event: GatewayEvent) => void) | ((code: number | null) => void)): this {
    return super.on(event, listener);
  }

  off(event: "event", listener: (event: GatewayEvent) => void): this;
  off(event: "exit", listener: (code: number | null) => void): this;
  off(event: "event" | "exit", listener: ((event: GatewayEvent) => void) | ((code: number | null) => void)): this {
    return super.off(event, listener);
  }

  drain(): void {
    return;
  }

  async request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.requests.push({ method, params });
    if (method === "session.create") return { session_id: this.sessionId } as T;
    if (method === "prompt.submit") {
      if (this.options.exitOnPrompt) {
        queueMicrotask(() => this.emit("exit", 0));
        return { ok: true } as T;
      }
      queueMicrotask(() => {
        this.emit("event", {
          type: "message.complete",
          session_id: this.sessionId,
          payload: { text: "done", usage: { calls: 1, input: 1, output: 2, total: 3 } },
        } satisfies GatewayEvent);
      });
      return { ok: true } as T;
    }
    return { ok: true } as T;
  }

  kill(reason?: string): void {
    this.killed.push(reason ?? "");
  }

  getLogTail(): string {
    return this.options.logTail ?? "";
  }
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function configForHarness() {
  return parseServiceConfig(
    {
      tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
      workspace: { root, state_dir: path.join(root, "state") },
      agent: { harness: "hermes" },
      hermes: {
        upstream_root: path.join(root, "upstream"),
        templates_dir: path.join(root, "templates"),
        state_dir: path.join(root, "state", "hermes"),
        keep_profiles: "always",
      },
      credential_profiles: {
        profiles: {
          "worker-hermes": { value: "$WORKER_HERMES_TOKEN", capabilities: ["runtime.hermes"] },
          "reviewer-hermes": { value: "$REVIEWER_HERMES_TOKEN", capabilities: ["runtime.hermes"] },
        },
        roles: {
          worker: { "runtime.hermes": "worker-hermes" },
          reviewer: { "runtime.hermes": "reviewer-hermes" },
        },
      },
    },
    path.join(root, "WORKFLOW.md"),
    {
      LINEAR_API_KEY: "linear-secret",
      WORKER_HERMES_TOKEN: "worker-hermes-secret",
      REVIEWER_HERMES_TOKEN: "reviewer-hermes-secret",
    },
  );
}

function context(
  config: ReturnType<typeof configForHarness>,
  input: {
    workspacePath: string;
    role?: "worker" | "reviewer";
    runPhase?: "implementation" | "review";
    turnNumber: number;
  },
): AgentRunContext {
  return {
    issue: issue(),
    role: input.role ?? "worker",
    runPhase: input.runPhase ?? "implementation",
    attempt: null,
    workspace: { path: input.workspacePath, workspaceKey: "workspace-1", createdNow: true },
    config,
    turnNumber: input.turnNumber,
    runModeOverride: null,
    abortSignal: new AbortController().signal,
    logger: new StructuredLogger(() => undefined),
  };
}

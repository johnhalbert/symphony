import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HermesHarness } from "../hermes/src/HermesHarness.js";
import {
  SYMPHONY_AGENT_COMMAND_POLICY_HOOK_MATCHER,
  SYMPHONY_AGENT_COMMAND_POLICY_HOOK_TIMEOUT_SECONDS,
} from "../hermes/src/HermesMcpConfig.js";
import type { GatewayEvent, HermesGatewayClient, HermesGatewayEnvironment } from "../hermes/src/GatewayFacade.js";
import { parseServiceConfig, type ServiceConfig } from "../src/core/config/Config.js";
import type { AgentEvent, AgentRunContext } from "../src/core/harness/AgentHarness.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import type { AgentRunPhase, AgentRunRole } from "../src/core/types.js";
import { issue } from "./helpers.js";

let root: string;

describe("Hermes delegated command policy inheritance", () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-hermes-delegated-command-policy-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("keeps worker delegated research and terminal reducers inside a verified command-policy-hooked profile", async () => {
    const clients: FakeGatewayClient[] = [];
    const operations: string[] = [];
    const cliPath = path.join(root, "cli.js");
    const harness = new HermesHarness({
      cliPath,
      commandPolicyHookVerifier: async (options) => {
        operations.push(`verify:${options.profileDir}`);
        expect(options.role).toBe("worker");
        expect(options.phase).toBe("implementation");
      },
      gatewayFactory: (env) => {
        operations.push(`gateway:${env.hermesHome}`);
        const client = new FakeGatewayClient(env, `gw-${clients.length + 1}`);
        clients.push(client);
        return client;
      },
    });
    const config = configForHarness();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });

    await collect(harness.run(context(config, { workspacePath, role: "worker", runPhase: "implementation", turnNumber: 1 }), "worker"));

    expect(clients).toHaveLength(1);
    expect(operations).toEqual([`verify:${clients[0]!.env.hermesHome}`, `gateway:${clients[0]!.env.hermesHome}`]);
    const generatedConfig = await readProfileConfig(clients[0]!.env.hermesHome);
    expectPolicyHook(generatedConfig, { role: "worker", phase: "implementation", issueId: "issue-1", cliPath });
    expect(disabledToolsets(generatedConfig)).not.toContain("delegation");
    expect(delegationMaxIterations(generatedConfig)).toBe(15);

    const copiedWorkerSkill = await readFile(
      path.join(
        clients[0]!.env.hermesHome,
        "skills",
        "orchestration",
        "symphony-worker-implementation",
        "SKILL.md",
      ),
      "utf8",
    );
    expect(copiedWorkerSkill).toContain('toolsets: ["terminal"]');
    expect(copiedWorkerSkill).toContain("Use the `terminal` tool for repo exploration");
    expect(copiedWorkerSkill).toContain("Do not include the `file` toolset");
    expect(copiedWorkerSkill).toContain("child research must be leaf-only");
    expect(copiedWorkerSkill).toContain("capped `terminal` reducer commands");

    await harness.dispose();
  });

  it("fails closed for reviewer delegated child sessions while retaining the review command-policy hook", async () => {
    const clients: FakeGatewayClient[] = [];
    const operations: string[] = [];
    const cliPath = path.join(root, "cli.js");
    const harness = new HermesHarness({
      cliPath,
      commandPolicyHookVerifier: async (options) => {
        operations.push(`verify:${options.profileDir}`);
        expect(options.role).toBe("reviewer");
        expect(options.phase).toBe("review");
      },
      gatewayFactory: (env) => {
        operations.push(`gateway:${env.hermesHome}`);
        const client = new FakeGatewayClient(env, `gw-${clients.length + 1}`);
        clients.push(client);
        return client;
      },
    });
    const config = configForHarness();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });

    await collect(harness.run(context(config, { workspacePath, role: "reviewer", runPhase: "review", turnNumber: 1 }), "reviewer"));

    expect(clients).toHaveLength(1);
    expect(operations).toEqual([`verify:${clients[0]!.env.hermesHome}`, `gateway:${clients[0]!.env.hermesHome}`]);
    const generatedConfig = await readProfileConfig(clients[0]!.env.hermesHome);
    expectPolicyHook(generatedConfig, { role: "reviewer", phase: "review", issueId: "issue-1", cliPath });
    expect(disabledToolsets(generatedConfig)).toEqual(expect.arrayContaining(["delegation"]));

    await harness.dispose();
  });
});

class FakeGatewayClient extends EventEmitter implements HermesGatewayClient {
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly killed: string[] = [];

  constructor(
    readonly env: HermesGatewayEnvironment,
    private readonly sessionId: string,
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
    return "";
  }

  isClosed(): boolean {
    return false;
  }
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

async function readProfileConfig(profileDir: string): Promise<Record<string, any>> {
  return YAML.parse(await readFile(path.join(profileDir, "config.yaml"), "utf8")) as Record<string, any>;
}

function configForHarness(): ServiceConfig {
  return parseServiceConfig(
    {
      tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
      workspace: { root, state_dir: path.join(root, "state") },
      agent: { harness: "hermes" },
      hermes: {
        upstream_root: path.resolve("hermes", "upstream-src"),
        templates_dir: path.resolve("hermes", "templates"),
        state_dir: path.join(root, "state", "hermes"),
        keep_profiles: "always",
      },
    },
    path.join(root, "WORKFLOW.md"),
    { LINEAR_API_KEY: "linear-secret" },
  );
}

function context(
  config: ServiceConfig,
  input: { workspacePath: string; role: AgentRunRole; runPhase: AgentRunPhase; turnNumber: number },
): AgentRunContext {
  return {
    issue: issue({ title: "ENG-265 delegated subagent and reducer policy inheritance" }),
    role: input.role,
    runPhase: input.runPhase,
    attempt: null,
    workspace: { path: input.workspacePath, workspaceKey: "workspace-1", createdNow: true },
    config,
    turnNumber: input.turnNumber,
    runModeOverride: null,
    abortSignal: new AbortController().signal,
    logger: new StructuredLogger(() => undefined),
  };
}

function expectPolicyHook(
  config: Record<string, any>,
  expected: { role: AgentRunRole; phase: AgentRunPhase; issueId: string; cliPath: string },
): void {
  expect(config.hooks_auto_accept).toBe(true);
  expect(config.hooks?.pre_tool_call).toHaveLength(1);
  const hook = config.hooks.pre_tool_call[0] as { matcher: string; command: string; timeout: number };
  expect(hook.matcher).toBe(SYMPHONY_AGENT_COMMAND_POLICY_HOOK_MATCHER);
  expect(hook.timeout).toBe(SYMPHONY_AGENT_COMMAND_POLICY_HOOK_TIMEOUT_SECONDS);
  expect(hook.command).toContain("agent-command-policy-hook");
  expect(hook.command).toContain(`--role ${expected.role}`);
  expect(hook.command).toContain(`--phase ${expected.phase}`);
  expect(hook.command).toContain(`--issue-id ${expected.issueId}`);
  expect(hook.command).toContain(expected.cliPath);
}

function disabledToolsets(config: Record<string, any>): string[] {
  return Array.isArray(config.agent?.disabled_toolsets) ? config.agent.disabled_toolsets : [];
}

function delegationMaxIterations(config: Record<string, any>): number | null {
  return typeof config.delegation?.max_iterations === "number" ? config.delegation.max_iterations : null;
}

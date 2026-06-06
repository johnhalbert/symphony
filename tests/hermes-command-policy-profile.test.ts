import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HermesHarness } from "../hermes/src/HermesHarness.js";
import {
  buildHermesAgentCommandPolicyDecisionJournalPath,
  SYMPHONY_AGENT_COMMAND_POLICY_HOOK_MATCHER,
  SYMPHONY_AGENT_COMMAND_POLICY_HOOK_TIMEOUT_SECONDS,
} from "../hermes/src/HermesMcpConfig.js";
import { buildAgentCommandPolicyHookDecisionJournalFallbackPath } from "../src/core/harness/AgentCommandPolicyHookRunner.js";
import type { GatewayEvent, HermesGatewayClient, HermesGatewayEnvironment } from "../hermes/src/GatewayFacade.js";
import { parseServiceConfig, type ServiceConfig } from "../src/core/config/Config.js";
import type { AgentEvent, AgentRunContext } from "../src/core/harness/AgentHarness.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import type { AgentRunPhase, AgentRunRole } from "../src/core/types.js";
import { issue } from "./helpers.js";

let root: string;

describe("Hermes command policy profile hooks", () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-hermes-command-policy-profile-"));
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
    await rm(root, { recursive: true, force: true });
  });

  it("installs gateway/TUI pre_tool_call command-policy hooks for worker and reviewer profiles", async () => {
    const clients: FakeGatewayClient[] = [];
    const verifications: unknown[] = [];
    const cliPath = path.join(root, "cli.js");
    const harness = new HermesHarness({
      cliPath,
      commandPolicyHookVerifier: async (options) => {
        verifications.push(options);
      },
      gatewayFactory: (env) => {
        const client = new FakeGatewayClient(env, `gw-${clients.length + 1}`);
        clients.push(client);
        return client;
      },
    });
    const config = configForHarness();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });

    await collect(harness.run(context(config, { workspacePath, role: "worker", runPhase: "implementation", turnNumber: 1 }), "worker"));
    await collect(harness.run(context(config, { workspacePath, role: "reviewer", runPhase: "review", turnNumber: 2 }), "reviewer"));
    await collect(
      harness.run(context(config, { workspacePath, role: "worker", runPhase: "merge_conflict_resolution", turnNumber: 3 }), "merge"),
    );
    await collect(harness.run(context(config, { workspacePath, role: "worker", runPhase: "issue_breakdown", turnNumber: 4 }), "planner"));

    expect(clients).toHaveLength(4);
    const workerConfig = await readProfileConfig(clients[0]!.env.hermesHome);
    const reviewerConfig = await readProfileConfig(clients[1]!.env.hermesHome);
    const mergeConflictConfig = await readProfileConfig(clients[2]!.env.hermesHome);
    const plannerConfig = await readProfileConfig(clients[3]!.env.hermesHome);

    expectPolicyHook(workerConfig, { role: "worker", phase: "implementation", issueId: "issue-1", cliPath });
    expectPolicyHook(reviewerConfig, { role: "reviewer", phase: "review", issueId: "issue-1", cliPath });
    expectPolicyHook(mergeConflictConfig, { role: "worker", phase: "merge_conflict_resolution", issueId: "issue-1", cliPath });
    expect(verifications).toHaveLength(3);
    expect(plannerConfig.hooks).toBeUndefined();
    expect(plannerConfig.hooks_auto_accept).toBeUndefined();

    await harness.dispose();
  });
  it("emits durable command_policy_decision activity from journaled hook decisions", async () => {
    const cliPath = path.join(root, "cli.js");
    const harness = new HermesHarness({
      cliPath,
      commandPolicyHookVerifier: async () => undefined,
      gatewayFactory: (env) =>
        new FakeGatewayClient(env, "gw-journal", {
          onPromptSubmit: async (client) => {
            const entry = {
              version: 1,
              recordedAt: "2026-06-04T10:00:00.000Z",
              runId: "test-session",
              issueId: "issue-1",
              requestKind: "terminal_execute",
              toolCallId: "tool-call-1",
              permissionOutcome: "denied",
              hookAction: "block",
              decision: {
                outcome: "deny",
                reasonKind: "direct_upstream_github",
                commandClass: "direct_upstream_git_operation",
                message: "blocked by test policy",
                audit: {
                  redacted: true,
                  role: "worker",
                  phase: "implementation",
                  surface: "terminal",
                  upstreamContactAttempted: false,
                },
              },
            };
            await writeFile(
              buildHermesAgentCommandPolicyDecisionJournalPath(client.env.hermesHome),
              `${JSON.stringify(entry)}\n`,
              "utf8",
            );
          },
        }),
    });
    const config = configForHarness();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });

    const events = await collect(
      harness.run(context(config, { workspacePath, role: "worker", runPhase: "implementation", turnNumber: 1 }), "worker"),
    );

    const decisionEvent = events.find((event) => event.type === "run_diagnostic" && event.code === "command_policy_decision");
    expect(decisionEvent).toMatchObject({
      type: "run_diagnostic",
      code: "command_policy_decision",
      message: expect.stringContaining("direct_upstream_github") as string,
      runActivity: {
        kind: "command_policy_decision",
        payload: {
          requestKind: "terminal_execute",
          toolCallId: "tool-call-1",
          hookAction: "block",
          permissionOutcome: "denied",
          outcome: "deny",
          reasonKind: "direct_upstream_github",
        },
      },
    });

    await harness.dispose();
  });

  it("emits blocked hook-path command_policy_decision activity before any follow-up gateway event arrives", async () => {
    const cliPath = path.join(root, "cli.js");
    let client: FakeGatewayClient | null = null;
    const harness = new HermesHarness({
      cliPath,
      commandPolicyHookVerifier: async () => undefined,
      gatewayFactory: (env) => {
        client = new FakeGatewayClient(env, "gw-blocked-without-followup", {
          emitPromptCompleteEvent: false,
          onPromptSubmit: async (gatewayClient) => {
            const entry = hookJournalEntry("direct_upstream_github", "deny", {
              permissionOutcome: "denied",
              hookAction: "block",
            });
            await writeFile(
              buildHermesAgentCommandPolicyDecisionJournalPath(gatewayClient.env.hermesHome),
              `${JSON.stringify(entry)}\n`,
              "utf8",
            );
          },
        });
        return client;
      },
    });
    const config = configForHarness();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });

    const iterator = harness
      .run(context(config, { workspacePath, role: "worker", runPhase: "implementation", turnNumber: 1 }), "worker")
      [Symbol.asyncIterator]();

    const started = await iterator.next();
    expect(started.value).toMatchObject({ type: "session_started" });

    const blockedDecision = await Promise.race([
      iterator.next(),
      new Promise<IteratorResult<AgentEvent>>((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for blocked hook decision")), 200)),
    ]);
    expect(blockedDecision.done).toBe(false);
    expect(blockedDecision.value).toMatchObject({
      type: "run_diagnostic",
      code: "command_policy_decision",
      payload: expect.objectContaining({
        outcome: "deny",
        reasonKind: "direct_upstream_github",
        permissionOutcome: "denied",
        hookAction: "block",
      }),
    });

    expect(client).not.toBeNull();
    client!.emit("event", {
      type: "message.complete",
      session_id: "gw-blocked-without-followup",
      payload: { text: "done", usage: { calls: 1, input: 1, output: 2, total: 3 } },
    } satisfies GatewayEvent);

    const nextEvents = [await iterator.next(), await iterator.next()];
    expect(nextEvents.map((entry) => entry.value?.type)).toEqual(expect.arrayContaining(["tokens", "completed"]));
    const done = await iterator.next();
    expect(done.done).toBe(true);

    await harness.dispose();
  });

  it("emits durable command_policy_decision activity from fallback hook journals when primary journaling fails", async () => {
    const cliPath = path.join(root, "cli.js");
    const harness = new HermesHarness({
      cliPath,
      commandPolicyHookVerifier: async () => undefined,
      gatewayFactory: (env) =>
        new FakeGatewayClient(env, "gw-fallback-journal", {
          onPromptSubmit: async (client) => {
            const journalPath = buildHermesAgentCommandPolicyDecisionJournalPath(client.env.hermesHome);
            await mkdir(journalPath, { recursive: true });
            const fallbackPath = buildAgentCommandPolicyHookDecisionJournalFallbackPath(journalPath);
            const entries = [
              hookJournalEntry("local_only_inspection", "allow", {
                permissionOutcome: "allowed",
                hookAction: null,
              }),
              hookJournalEntry("direct_upstream_github", "deny", {
                permissionOutcome: "denied",
                hookAction: "block",
              }),
              hookJournalEntry("malformed_hook_payload", "deny", {
                requestKind: null,
                surface: "unknown",
                permissionOutcome: "fail_closed",
                hookAction: "block",
              }),
            ];
            await writeFile(fallbackPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
          },
        }),
    });
    const config = configForHarness();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });

    const events = await collect(
      harness.run(context(config, { workspacePath, role: "worker", runPhase: "implementation", turnNumber: 1 }), "worker"),
    );

    const decisionEvents = events.filter((event) => event.type === "run_diagnostic" && event.code === "command_policy_decision");
    expect(decisionEvents).toHaveLength(3);
    expect(decisionEvents.map((event) => event.runActivity?.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outcome: "allow",
          reasonKind: "local_only_inspection",
          surface: "terminal_execute",
          audit: expect.objectContaining({ surface: "terminal_execute" }),
        }),
        expect.objectContaining({
          outcome: "deny",
          reasonKind: "direct_upstream_github",
          surface: "terminal_execute",
          audit: expect.objectContaining({ surface: "terminal_execute" }),
        }),
        expect.objectContaining({
          outcome: "deny",
          reasonKind: "malformed_hook_payload",
          surface: "unknown",
          permissionOutcome: "fail_closed",
        }),
      ]),
    );

    await harness.dispose();
  });

  it("fails closed before creating a gateway client when command-policy hook validation is unverifiable", async () => {
    const clients: FakeGatewayClient[] = [];
    const cliPath = path.join(root, "cli.js");
    const harness = new HermesHarness({
      cliPath,
      commandPolicyHookVerifier: async () => {
        throw new Error("simulated hook registration failure");
      },
      gatewayFactory: (env) => {
        const client = new FakeGatewayClient(env, `gw-${clients.length + 1}`);
        clients.push(client);
        return client;
      },
    });
    const config = configForHarness();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });

    await expect(
      collect(harness.run(context(config, { workspacePath, role: "worker", runPhase: "implementation", turnNumber: 1 }), "worker")),
    ).rejects.toThrow(/simulated hook registration failure/);

    expect(clients).toHaveLength(0);
    await harness.dispose();
  });
});

function hookJournalEntry(
  reasonKind: string,
  outcome: "allow" | "deny",
  options: {
    requestKind?: string | null;
    surface?: string;
    permissionOutcome: string;
    hookAction: string | null;
  },
): Record<string, unknown> {
  return {
    version: 1,
    recordedAt: "2026-06-04T10:00:00.000Z",
    runId: "test-session",
    issueId: "issue-1",
    requestKind: options.requestKind === undefined ? "terminal_execute" : options.requestKind,
    toolCallId: "tool-call-1",
    permissionOutcome: options.permissionOutcome,
    hookAction: options.hookAction,
    decision: {
      outcome,
      reasonKind,
      commandClass: reasonKind,
      message: `${outcome} by fallback test policy`,
      audit: {
        redacted: true,
        role: "worker",
        phase: "implementation",
        surface: options.surface ?? "terminal",
        upstreamContactAttempted: false,
      },
    },
  };
}

class FakeGatewayClient extends EventEmitter implements HermesGatewayClient {
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly killed: string[] = [];

  constructor(
    readonly env: HermesGatewayEnvironment,
    private readonly sessionId: string,
    private readonly options: {
      onPromptSubmit?: (client: FakeGatewayClient) => Promise<void> | void;
      emitPromptCompleteEvent?: boolean;
    } = {},
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
    if (method === "session.create") return { session_id: this.sessionId, session_key: `hermes-${this.sessionId}` } as T;
    if (method === "prompt.submit") {
      await this.options.onPromptSubmit?.(this);
      if (this.options.emitPromptCompleteEvent !== false) {
        queueMicrotask(() => {
          this.emit("event", {
            type: "message.complete",
            session_id: this.sessionId,
            payload: { text: "done", usage: { calls: 1, input: 1, output: 2, total: 3 }, session_key: `hermes-${this.sessionId}` },
          } satisfies GatewayEvent);
        });
      }
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
        upstream_root: path.join(root, "upstream"),
        templates_dir: path.join(root, "templates"),
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
    issue: issue(),
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
  expect(hook.command).toContain("--decision-journal");
  expect(hook.command).toContain("agent-command-policy-decisions.ndjson");
  expect(hook.command).toContain(expected.cliPath);
}

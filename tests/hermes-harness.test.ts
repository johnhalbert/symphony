import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HermesHarness } from "../hermes/src/HermesHarness.js";
import type { HermesAuthManager } from "../hermes/src/HermesAuthManager.js";
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
      commandPolicyHookVerifier: acceptingCommandPolicyHookVerifier,
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
    expect(clients).toHaveLength(4);
    expect(clients[0]?.requests.map((request) => request.method).slice(0, 2)).toEqual(["setup.status", "session.create"]);
    expect(clients[1]?.requests.map((request) => request.method).slice(0, 2)).toEqual(["setup.status", "session.resume"]);
    expect(clients[0]?.requests.filter((request) => request.method === "session.create")).toHaveLength(1);
    expect(clients[1]?.requests).toContainEqual({
      method: "session.resume",
      params: { cols: 120, session_id: "hermes-gw-1" },
    });
    expect(clients[1]?.requests.find((request) => request.method === "prompt.submit")?.params.session_id).toBe("gw-2");
    expect(clients[0]?.env.extraEnv).toMatchObject({ HERMES_API_KEY: "worker-hermes-secret" });
    expect(clients[1]?.env.extraEnv).toMatchObject({ HERMES_API_KEY: "worker-hermes-secret" });
    expect(clients[1]?.env.hermesHome).toBe(clients[0]?.env.hermesHome);
    expect(new Set(clients.slice(2).map((client) => client.env.hermesHome)).size).toBe(2);
    expect(clients.slice(2).every((client) => client.env.extraEnv?.HERMES_API_KEY === "reviewer-hermes-secret")).toBe(true);

    const workerProfile = JSON.parse(
      await readFile(path.join(clients[0]!.env.hermesHome, ".symphony-hermes-profile.json"), "utf8"),
    ) as { profileKey: string };
    const reviewerProfileKeys = await Promise.all(
      clients.slice(2).map(async (client) => {
        const profile = JSON.parse(await readFile(path.join(client.env.hermesHome, ".symphony-hermes-profile.json"), "utf8")) as {
          profileKey: string;
        };
        return profile.profileKey;
      }),
    );
    expect(workerProfile.profileKey).toBe("sym_workspace-1_worker_test-1_implementation_reuse_by_issue");
    expect(reviewerProfileKeys).toHaveLength(2);
    expect(reviewerProfileKeys[0]).toMatch(/^[a-z0-9][a-z0-9_-]{0,63}$/);
    expect(reviewerProfileKeys[1]).toMatch(/^[a-z0-9][a-z0-9_-]{0,63}$/);
    expect(reviewerProfileKeys[0]).not.toBe(reviewerProfileKeys[1]);

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

    const reviewerConfig = YAML.parse(await readFile(path.join(clients[2]!.env.hermesHome, "config.yaml"), "utf8")) as Record<
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
    expect(clients[0]?.killed).toContain("hermes.run_finished");
    expect(clients[1]?.killed).toContain("hermes.run_finished");
  });

  it("stops before creating a session when Hermes setup reports no provider configured", async () => {
    const clients: FakeGatewayClient[] = [];
    const harness = new HermesHarness({
      cliPath: path.join(root, "cli.js"),
      commandPolicyHookVerifier: acceptingCommandPolicyHookVerifier,
      gatewayFactory: (env) => {
        const client = new FakeGatewayClient(env, `gw-${clients.length + 1}`, {
          setupProviderConfigured: false,
        });
        clients.push(client);
        return client;
      },
    });

    const config = configForHarness();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });

    const events = await collect(harness.run(context(config, { workspacePath, turnNumber: 1 }), "worker prompt"));

    expect(events.map((event) => event.type)).toEqual(["run_diagnostic", "failed"]);
    expect(clients[0]?.requests.map((request) => request.method)).toEqual(["setup.status"]);
    expect(events.find((event) => event.type === "run_diagnostic")).toMatchObject({
      code: "hermes_run_error",
      message: expect.stringContaining("no provider configured"),
    });
  });

  it("uses managed Hermes auth for openai-codex without injecting API-key credentials", async () => {
    const clients: FakeGatewayClient[] = [];
    const harness = new HermesHarness({
      cliPath: path.join(root, "cli.js"),
      commandPolicyHookVerifier: acceptingCommandPolicyHookVerifier,
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
        hermes_acp: {
          binary_path: path.join(root, "host", "bin", "hermes"),
          source_profile: "host-dogfood",
          profile_prefix: "host-acp",
          worker_session_lifecycle: "fresh_per_run",
          keep_profiles: "never",
          startup_timeout_ms: 1234,
          request_timeout_ms: 2345,
          permission_timeout_ms: 3456,
        },
      },
      path.join(root, "WORKFLOW.md"),
      { LINEAR_API_KEY: "linear-secret" },
    );
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });

    const events = await collect(harness.run(context(config, { workspacePath, turnNumber: 1 }), "codex prompt"));

    expect(events.map((event) => event.type)).toContain("completed");
    expect(config.hermesAcp).toMatchObject({
      binaryPath: path.join(root, "host", "bin", "hermes"),
      sourceProfile: "host-dogfood",
      profilePrefix: "host-acp",
      workerSessionLifecycle: "fresh_per_run",
      keepProfiles: "never",
      startupTimeoutMs: 1234,
      requestTimeoutMs: 2345,
      permissionTimeoutMs: 3456,
    });
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

  it("persists full unsafe Hermes tool detail payloads when the gateway emits them", async () => {
    const clients: FakeGatewayClient[] = [];
    const appended: Array<Record<string, any>> = [];
    const longArgs = JSON.stringify({ command: "node -e \"console.log('SECRET_TOOL_ARGUMENT')\"", filler: "a".repeat(700) }, null, 2);
    const longResult = `SECRET_TOOL_RESULT\n${"b".repeat(700)}`;
    const harness = new HermesHarness({
      cliPath: path.join(root, "cli.js"),
      commandPolicyHookVerifier: acceptingCommandPolicyHookVerifier,
      gatewayFactory: (env) => {
        const client = new FakeGatewayClient(env, `gw-${clients.length + 1}`, {
          eventsOnPrompt: [
            {
              type: "tool.start",
              session_id: "gw-1",
              payload: {
                tool_id: "tool-1",
                name: "terminal",
                args_text: longArgs,
                redacted: false,
                unsafe_tool_details: true,
              },
            } as GatewayEvent,
            {
              type: "tool.complete",
              session_id: "gw-1",
              payload: {
                tool_id: "tool-1",
                name: "terminal",
                result_text: longResult,
                redacted: false,
                unsafe_tool_details: true,
              },
            } as GatewayEvent,
            {
              type: "message.complete",
              session_id: "gw-1",
              payload: { text: "done", session_key: "hermes-gw-1" },
            } as GatewayEvent,
          ],
        });
        clients.push(client);
        return client;
      },
      runStore: {
        appendEvent: async (input: Record<string, any>) => {
          appended.push(input);
          return { ...input, sequence: appended.length };
        },
      } as any,
    });

    const config = configForHarness();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });

    const events = await collect(harness.run(context(config, { workspacePath, turnNumber: 1 }), "worker prompt"));

    expect(events.map((event) => event.type)).toContain("completed");
    const start = appended.find((event) => event.eventType === "tool_start");
    const complete = appended.find((event) => event.eventType === "tool_complete");
    expect(start?.payload).toMatchObject({ argsPreview: longArgs, redacted: false, unsafeToolDetails: true });
    expect(complete?.payload).toMatchObject({ resultPreview: longResult, redacted: false, unsafeToolDetails: true });
  });

  it("retires a reusable worker lease when its gateway exits before completion", async () => {
    const clients: FakeGatewayClient[] = [];
    const leakedSecret = "very-secret-token-123";
    process.env.HERMES_TEST_TOKEN = leakedSecret;
    const harness = new HermesHarness({
      cliPath: path.join(root, "cli.js"),
      commandPolicyHookVerifier: acceptingCommandPolicyHookVerifier,
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
    expect(clients[1]?.requests.filter((request) => request.method === "session.resume")).toHaveLength(1);
    expect(clients[1]?.requests.find((request) => request.method === "session.resume")?.params.session_id).toBe("hermes-gw-1");
    expect(clients[1]?.requests.find((request) => request.method === "prompt.submit")?.params.session_id).toBe("gw-2");
    delete process.env.HERMES_TEST_TOKEN;
  });

  it("does not reuse a reusable worker lease after the gateway exits between runs", async () => {
    const clients: FakeGatewayClient[] = [];
    const harness = new HermesHarness({
      cliPath: path.join(root, "cli.js"),
      commandPolicyHookVerifier: acceptingCommandPolicyHookVerifier,
      gatewayFactory: (env) => {
        const client = new FakeGatewayClient(env, `gw-${clients.length + 1}`);
        clients.push(client);
        return client;
      },
    });

    const config = configForHarness();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });

    const first = await collect(harness.run(context(config, { workspacePath, turnNumber: 1 }), "first worker prompt"));
    clients[0]?.closeTransport(0);
    const second = await collect(harness.run(context(config, { workspacePath, turnNumber: 2 }), "second worker prompt"));

    expect(first.map((event) => event.type)).toContain("completed");
    expect(second.map((event) => event.type)).toContain("completed");
    expect(clients).toHaveLength(2);
    expect(clients[0]?.requests.filter((request) => request.method === "prompt.submit")).toHaveLength(1);
    expect(clients[1]?.requests.find((request) => request.method === "session.resume")?.params.session_id).toBe("hermes-gw-1");
    expect(clients[1]?.requests.find((request) => request.method === "prompt.submit")?.params.session_id).toBe("gw-2");
  });

  it("persists reusable worker Hermes session keys across harness instances", async () => {
    const clients: FakeGatewayClient[] = [];
    const gatewayFactory = (env: HermesGatewayEnvironment) => {
      const client = new FakeGatewayClient(env, `gw-${clients.length + 1}`);
      clients.push(client);
      return client;
    };

    const config = configForHarness();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });

    const firstHarness = new HermesHarness({
      cliPath: path.join(root, "cli.js"),
      commandPolicyHookVerifier: acceptingCommandPolicyHookVerifier,
      gatewayFactory,
    });
    const first = await collect(firstHarness.run(context(config, { workspacePath, turnNumber: 1 }), "first worker prompt"));
    await firstHarness.dispose();

    const secondHarness = new HermesHarness({
      cliPath: path.join(root, "cli.js"),
      commandPolicyHookVerifier: acceptingCommandPolicyHookVerifier,
      gatewayFactory,
    });
    const second = await collect(secondHarness.run(context(config, { workspacePath, turnNumber: 2 }), "second worker prompt"));

    expect(first.map((event) => event.type)).toContain("completed");
    expect(second.map((event) => event.type)).toContain("completed");
    expect(clients).toHaveLength(2);
    expect(clients[1]?.requests.find((request) => request.method === "session.resume")?.params.session_id).toBe("hermes-gw-1");
    expect(clients[1]?.requests.find((request) => request.method === "prompt.submit")?.params.session_id).toBe("gw-2");
  });

  it("uses the rotated Hermes session key from message.complete on the next reusable worker run", async () => {
    const clients: FakeGatewayClient[] = [];
    const harness = new HermesHarness({
      cliPath: path.join(root, "cli.js"),
      commandPolicyHookVerifier: acceptingCommandPolicyHookVerifier,
      gatewayFactory: (env) => {
        const options = clients.length === 0 ? { completedSessionKey: "rotated-hermes-session" } : {};
        const client = new FakeGatewayClient(env, `gw-${clients.length + 1}`, options);
        clients.push(client);
        return client;
      },
    });

    const config = configForHarness();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });

    const first = await collect(harness.run(context(config, { workspacePath, turnNumber: 1 }), "first worker prompt"));
    const second = await collect(harness.run(context(config, { workspacePath, turnNumber: 2 }), "second worker prompt"));

    expect(first.map((event) => event.type)).toContain("completed");
    expect(second.map((event) => event.type)).toContain("completed");
    expect(clients[1]?.requests.find((request) => request.method === "session.resume")?.params.session_id).toBe("rotated-hermes-session");
    expect(clients[1]?.requests.find((request) => request.method === "prompt.submit")?.params.session_id).toBe("gw-2");
  });

  it("submits the prompt before yielding session_started to avoid the Hermes deferred-build race", async () => {
    const clients: FakeGatewayClient[] = [];
    const harness = new HermesHarness({
      cliPath: path.join(root, "cli.js"),
      commandPolicyHookVerifier: acceptingCommandPolicyHookVerifier,
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
    expect(clients[0]?.requests.map((request) => request.method)).toEqual(["setup.status", "session.create", "prompt.submit"]);

    const remaining: AgentEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      remaining.push(next.value);
    }
    expect(remaining.map((event) => event.type)).toContain("completed");
    await harness.dispose();
  });

  it("maps Hermes provider.limit events into provider_limit harness events", async () => {
    const clients: FakeGatewayClient[] = [];
    const resumeAt = "2026-05-28T18:00:00.000Z";
    const harness = new HermesHarness({
      cliPath: path.join(root, "cli.js"),
      commandPolicyHookVerifier: acceptingCommandPolicyHookVerifier,
      authManager: acceptingHermesAuthManager(),
      gatewayFactory: (env) => {
        const client = new FakeGatewayClient(env, `gw-${clients.length + 1}`, {
          providerLimitOnPrompt: {
            provider_id: "openai-codex",
            model: "gpt-5-test",
            kind: "windowed_bucket_exhausted",
            message: "Codex session allotment exhausted",
            resume_at: resumeAt,
            window_label: "Session",
            window_kind: "codex_5h",
          },
        });
        clients.push(client);
        return client;
      },
    });
    const config = configForHarness();
    config.hermes.provider = "openai-codex";
    config.hermes.model = "gpt-5-test";
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });

    const events = await collect(harness.run(context(config, { workspacePath, turnNumber: 1 }), "worker prompt"));
    const limit = events.find((event): event is Extract<AgentEvent, { type: "provider_limit" }> => event.type === "provider_limit");

    expect(limit?.signal).toMatchObject({
      scope: { harnessId: "hermes", providerId: "openai-codex", model: "gpt-5-test" },
      kind: "windowed_bucket_exhausted",
      message: "Codex session allotment exhausted",
      window: { resumeAt, windowLabel: "Session", windowKind: "codex_5h" },
      resumePolicy: "auto_at_window_close",
    });
    expect(events.map((event) => event.type)).toContain("failed");
  });

  it("ignores Hermes provider.limit events without structured limit evidence", async () => {
    const clients: FakeGatewayClient[] = [];
    const message = "Review approved: https://github.com/johnhalbert/symphony/pull/89#pullrequestreview-4394293143";
    const providerLimit = {
      provider_id: "openai-codex",
      model: "gpt-5-test",
      kind: "unknown_limit",
      message,
      resume_policy: "manual",
      resume_at: null,
      retry_after_ms: null,
      raw: {
        reason: null,
        status_code: null,
        error_context: {},
      },
    };
    const harness = new HermesHarness({
      cliPath: path.join(root, "cli.js"),
      commandPolicyHookVerifier: acceptingCommandPolicyHookVerifier,
      authManager: acceptingHermesAuthManager(),
      gatewayFactory: (env) => {
        const client = new FakeGatewayClient(env, `gw-${clients.length + 1}`, {
          eventsOnPrompt: [
            {
              type: "provider.limit",
              session_id: `gw-${clients.length + 1}`,
              payload: providerLimit,
            } as GatewayEvent,
            {
              type: "message.complete",
              session_id: `gw-${clients.length + 1}`,
              payload: {
                text: message,
                status: "complete",
                provider_limit: providerLimit,
                usage: { calls: 1, input: 1, output: 2, total: 3 },
              },
            } as GatewayEvent,
          ],
        });
        clients.push(client);
        return client;
      },
    });
    const config = configForHarness();
    config.hermes.provider = "openai-codex";
    config.hermes.model = "gpt-5-test";
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });

    const events = await collect(harness.run(context(config, { workspacePath, turnNumber: 1 }), "worker prompt"));

    expect(events.map((event) => event.type)).not.toContain("provider_limit");
    expect(events.map((event) => event.type)).not.toContain("failed");
    expect(events.find((event) => event.type === "completed")).toMatchObject({ message });
  });

  it("maps structured Hermes JSON-RPC provider-limit errors into provider_limit harness events", async () => {
    const clients: FakeGatewayClient[] = [];
    const harness = new HermesHarness({
      cliPath: path.join(root, "cli.js"),
      commandPolicyHookVerifier: acceptingCommandPolicyHookVerifier,
      authManager: acceptingHermesAuthManager(),
      gatewayFactory: (env) => {
        const client = new FakeGatewayClient(env, `gw-${clients.length + 1}`, {
          promptError: Object.assign(new Error("Codex usage limit reached"), {
            code: "usage_limit_reached",
            data: {
              provider_id: "openai-codex",
              model: "gpt-5-test",
              reset_at: "2026-05-28T19:00:00.000Z",
              message: "Codex usage limit reached",
            },
          }),
        });
        clients.push(client);
        return client;
      },
    });
    const config = configForHarness();
    config.hermes.provider = "openai-codex";
    config.hermes.model = "gpt-5-test";
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });

    const events = await collect(harness.run(context(config, { workspacePath, turnNumber: 1 }), "worker prompt"));
    const limit = events.find((event): event is Extract<AgentEvent, { type: "provider_limit" }> => event.type === "provider_limit");

    expect(limit?.signal).toMatchObject({
      scope: { harnessId: "hermes", providerId: "openai-codex", model: "gpt-5-test" },
      kind: "windowed_bucket_exhausted",
      message: "Codex usage limit reached",
      window: { resumeAt: "2026-05-28T19:00:00.000Z" },
      resumePolicy: "auto_at_window_close",
    });
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["provider_limit", "run_diagnostic", "failed"]));
  });
});

class FakeGatewayClient extends EventEmitter implements HermesGatewayClient {
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly killed: string[] = [];
  private closed = false;

  constructor(
    readonly env: HermesGatewayEnvironment,
    private readonly sessionId: string,
    private readonly options: {
      exitOnPrompt?: boolean;
      logTail?: string;
      promptError?: Error;
      providerLimitOnPrompt?: Record<string, unknown>;
      eventsOnPrompt?: GatewayEvent[];
      completedSessionKey?: string;
      setupProviderConfigured?: boolean;
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
    if (this.closed) throw new Error("gateway exited (0)");
    this.requests.push({ method, params });
    if (method === "setup.status") return { provider_configured: this.options.setupProviderConfigured ?? true } as T;
    if (method === "session.create") return { session_id: this.sessionId, session_key: `hermes-${this.sessionId}` } as T;
    if (method === "session.resume") {
      return {
        info: { model: "test/model" },
        message_count: 0,
        messages: [],
        resumed: params.session_id,
        session_id: this.sessionId,
      } as T;
    }
    if (method === "prompt.submit") {
      if (this.options.promptError) throw this.options.promptError;
      if (this.options.exitOnPrompt) {
        queueMicrotask(() => this.closeTransport(0));
        return { ok: true } as T;
      }
      queueMicrotask(() => {
        if (this.options.eventsOnPrompt) {
          for (const event of this.options.eventsOnPrompt) this.emit("event", event);
        } else if (this.options.providerLimitOnPrompt) {
          this.emit("event", {
            type: "provider.limit",
            session_id: this.sessionId,
            payload: this.options.providerLimitOnPrompt,
          } as GatewayEvent);
        } else {
          this.emit("event", {
            type: "message.complete",
            session_id: this.sessionId,
            payload: {
              text: "done",
              usage: { calls: 1, input: 1, output: 2, total: 3 },
              session_key: this.options.completedSessionKey ?? `hermes-${this.sessionId}`,
            },
          } satisfies GatewayEvent);
        }
      });
      return { ok: true } as T;
    }
    return { ok: true } as T;
  }

  kill(reason?: string): void {
    this.closed = true;
    this.killed.push(reason ?? "");
  }

  getLogTail(): string {
    return this.options.logTail ?? "";
  }

  isClosed(): boolean {
    return this.closed;
  }

  closeTransport(code: number | null): void {
    this.closed = true;
    this.emit("exit", code);
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

function acceptingCommandPolicyHookVerifier(): Promise<void> {
  return Promise.resolve();
}

function acceptingHermesAuthManager(): HermesAuthManager {
  return {
    requireProviders: async (providers = ["openai-codex"]) => ({
      managedRoot: path.join(root, "state", "hermes", "auth"),
      bootstrapFrom: path.join(root, "local-hermes"),
      presentProviders: providers,
      copiedProviders: [],
      missingProviders: [],
    }),
  } as unknown as HermesAuthManager;
}

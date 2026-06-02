import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildHermesAgentCommandPolicyHookConfig,
  SYMPHONY_AGENT_COMMAND_POLICY_HOOK_MATCHER,
  SYMPHONY_AGENT_COMMAND_POLICY_HOOK_TIMEOUT_SECONDS,
  SYMPHONY_HERMES_AGENT_MAX_TURNS,
  toHermesMcpServers,
  writeHermesMcpConfig,
} from "../hermes/src/HermesMcpConfig.js";

let root: string;

describe("Hermes MCP config", () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-hermes-mcp-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("translates Symphony subprocess servers into Hermes mcp_servers", () => {
    expect(
      toHermesMcpServers(
        {
          symphony: {
            type: "stdio",
            command: "node",
            args: ["dist/cli.js", "completion-report-mcp"],
            cwd: root,
            env: { LINEAR_API_KEY: "secret" },
          },
        },
        { timeoutSeconds: 30, connectTimeoutSeconds: 5 },
      ),
    ).toEqual({
      symphony: {
        command: "node",
        args: ["dist/cli.js", "completion-report-mcp"],
        env: { LINEAR_API_KEY: "secret" },
        timeout: 30,
        connect_timeout: 5,
      },
    });
  });

  it("merges mcp_servers into an existing Hermes config file", async () => {
    const profileDir = path.join(root, "profile");
    await writeHermesMcpConfig({
      profileDir,
      servers: {
        symphony_review: {
          type: "stdio",
          command: "node",
          args: ["cli.js", "review-verdict-mcp"],
          cwd: root,
          env: {},
        },
      },
    });

    const parsed = YAML.parse(await readFile(path.join(profileDir, "config.yaml"), "utf8")) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      mcp_servers: {
        symphony_review: {
          command: "node",
          args: ["cli.js", "review-verdict-mcp"],
          timeout: 120,
          connect_timeout: 60,
        },
      },
    });
  });

  it("can stamp the Symphony agent turn budget into an existing profile config", async () => {
    const profileDir = path.join(root, "profile");
    await mkdir(profileDir, { recursive: true });
    await writeFile(
      path.join(profileDir, "config.yaml"),
      YAML.stringify({
        agent: {
          max_turns: 90,
          reasoning_effort: "xhigh",
        },
        display: {
          show_reasoning: true,
        },
      }),
      "utf8",
    );

    await writeHermesMcpConfig({
      profileDir,
      servers: {},
      agentMaxTurns: SYMPHONY_HERMES_AGENT_MAX_TURNS,
    });

    const parsed = YAML.parse(await readFile(path.join(profileDir, "config.yaml"), "utf8")) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      agent: {
        max_turns: SYMPHONY_HERMES_AGENT_MAX_TURNS,
        reasoning_effort: "xhigh",
      },
      display: {
        show_reasoning: true,
      },
    });
  });

  it("merges generated command-policy shell hooks into an existing Hermes profile config", async () => {
    const profileDir = path.join(root, "profile");
    await mkdir(profileDir, { recursive: true });
    await writeFile(
      path.join(profileDir, "config.yaml"),
      YAML.stringify({
        hooks_auto_accept: false,
        hooks: {
          pre_tool_call: [{ matcher: "write_file", command: "format-hook", timeout: 3 }],
          post_tool_call: [{ matcher: "patch", command: "post-hook", timeout: 4 }],
        },
        display: { show_tool_calls: true },
      }),
      "utf8",
    );
    const cliPath = path.join(root, "cli with spaces.js");

    const generatedHooks = buildHermesAgentCommandPolicyHookConfig({
      cliPath,
      role: "worker",
      phase: "implementation",
      issueId: "issue-1",
    });
    await writeHermesMcpConfig({
      profileDir,
      servers: {},
      hooks: generatedHooks,
      hooksAutoAccept: true,
    });
    await writeHermesMcpConfig({
      profileDir,
      servers: {},
      hooks: generatedHooks,
      hooksAutoAccept: true,
    });

    const parsed = YAML.parse(await readFile(path.join(profileDir, "config.yaml"), "utf8")) as Record<string, any>;
    expect(parsed.hooks_auto_accept).toBe(true);
    expect(parsed.display).toEqual({ show_tool_calls: true });
    expect(parsed.hooks.post_tool_call).toEqual([{ matcher: "patch", command: "post-hook", timeout: 4 }]);
    expect(parsed.hooks.pre_tool_call).toEqual([
      { matcher: "write_file", command: "format-hook", timeout: 3 },
      {
        matcher: SYMPHONY_AGENT_COMMAND_POLICY_HOOK_MATCHER,
        command: expect.stringContaining("agent-command-policy-hook") as string,
        timeout: SYMPHONY_AGENT_COMMAND_POLICY_HOOK_TIMEOUT_SECONDS,
      },
    ]);
    const policyHook = parsed.hooks.pre_tool_call[1] as { command: string };
    expect(policyHook.command).toContain("--role worker");
    expect(policyHook.command).toContain("--phase implementation");
    expect(policyHook.command).toContain("--issue-id issue-1");
    expect(policyHook.command).toContain("cli with spaces.js");
  });
});

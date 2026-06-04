import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertHermesAgentCommandPolicyHookProfileConfig,
  buildHermesAgentCommandPolicyDecisionJournalPath,
  buildHermesAgentCommandPolicyHookConfig,
  SYMPHONY_AGENT_COMMAND_POLICY_HOOK_MATCHER,
  SYMPHONY_AGENT_COMMAND_POLICY_HOOK_TIMEOUT_SECONDS,
  SYMPHONY_HERMES_AGENT_MAX_TURNS,
  toHermesMcpServers,
  verifyHermesAgentCommandPolicyHookCommandRunnable,
  verifyHermesAgentCommandPolicyHookRegistration,
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
      decisionJournalPath: buildHermesAgentCommandPolicyDecisionJournalPath(profileDir),
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

  it("validates the generated command-policy hook profile config and runnable hook command", async () => {
    const profileDir = path.join(root, "profile");
    const cliPath = await writeFakeHookCli(path.join(root, "fake-hook-cli.js"));
    const options = {
      profileDir,
      cliPath,
      role: "worker",
      phase: "implementation",
      issueId: "issue-1",
      decisionJournalPath: buildHermesAgentCommandPolicyDecisionJournalPath(profileDir),
    };

    await writeHermesMcpConfig({
      profileDir,
      servers: {},
      hooks: buildHermesAgentCommandPolicyHookConfig(options),
      hooksAutoAccept: true,
    });

    await expect(assertHermesAgentCommandPolicyHookProfileConfig(options)).resolves.toMatchObject({
      matcher: SYMPHONY_AGENT_COMMAND_POLICY_HOOK_MATCHER,
      timeout: SYMPHONY_AGENT_COMMAND_POLICY_HOOK_TIMEOUT_SECONDS,
    });
    await expect(verifyHermesAgentCommandPolicyHookCommandRunnable({ ...options, commandTimeoutMs: 2_000 })).resolves.toBeUndefined();
  });

  it.each([
    {
      name: "missing hooks",
      mutate: (config: Record<string, any>) => {
        delete config.hooks;
      },
      message: /hooks\.pre_tool_call/,
    },
    {
      name: "hooks_auto_accept false",
      mutate: (config: Record<string, any>) => {
        config.hooks_auto_accept = false;
      },
      message: /hooks_auto_accept must be true/,
    },
    {
      name: "invalid matcher",
      mutate: (config: Record<string, any>) => {
        config.hooks.pre_tool_call[0].matcher = "terminal";
      },
      message: /expected exactly one generated pre_tool_call/,
    },
    {
      name: "invalid event",
      mutate: (config: Record<string, any>) => {
        config.hooks = { post_tool_call: config.hooks.pre_tool_call };
      },
      message: /hooks\.pre_tool_call/,
    },
    {
      name: "unparseable generated command",
      mutate: (config: Record<string, any>) => {
        config.hooks.pre_tool_call[0].command = "'unterminated";
      },
      message: /expected exactly one generated pre_tool_call/,
    },
  ])("rejects invalid command-policy hook profile config: $name", async ({ mutate, message }) => {
    const profileDir = path.join(root, "profile");
    const cliPath = await writeFakeHookCli(path.join(root, "fake-hook-cli.js"));
    const options = {
      profileDir,
      cliPath,
      role: "worker",
      phase: "implementation",
      issueId: "issue-1",
      decisionJournalPath: buildHermesAgentCommandPolicyDecisionJournalPath(profileDir),
    };
    await writeHermesMcpConfig({
      profileDir,
      servers: {},
      hooks: buildHermesAgentCommandPolicyHookConfig(options),
      hooksAutoAccept: true,
    });
    const configPath = path.join(profileDir, "config.yaml");
    const config = YAML.parse(await readFile(configPath, "utf8")) as Record<string, any>;
    mutate(config);
    await writeFile(configPath, YAML.stringify(config), "utf8");

    await expect(assertHermesAgentCommandPolicyHookProfileConfig(options)).rejects.toThrow(message);
  });

  it("rejects a generated command-policy hook whose CLI command is not runnable", async () => {
    const profileDir = path.join(root, "profile");
    const cliPath = path.join(root, "missing-cli.js");
    const options = {
      profileDir,
      cliPath,
      role: "worker",
      phase: "implementation",
      issueId: "issue-1",
      decisionJournalPath: buildHermesAgentCommandPolicyDecisionJournalPath(profileDir),
    };
    await writeHermesMcpConfig({
      profileDir,
      servers: {},
      hooks: buildHermesAgentCommandPolicyHookConfig(options),
      hooksAutoAccept: true,
    });

    await expect(verifyHermesAgentCommandPolicyHookCommandRunnable({ ...options, commandTimeoutMs: 2_000 })).rejects.toThrow(
      /not readable/,
    );
  });

  it("fails closed when Hermes shell-hook registration cannot be verified", async () => {
    const profileDir = path.join(root, "profile");
    const cliPath = await writeFakeHookCli(path.join(root, "fake-hook-cli.js"));
    const options = {
      profileDir,
      cliPath,
      role: "reviewer",
      phase: "review",
      issueId: "issue-1",
      decisionJournalPath: buildHermesAgentCommandPolicyDecisionJournalPath(profileDir),
    };
    await writeHermesMcpConfig({
      profileDir,
      servers: {},
      hooks: buildHermesAgentCommandPolicyHookConfig(options),
      hooksAutoAccept: true,
    });

    await expect(
      verifyHermesAgentCommandPolicyHookRegistration({
        ...options,
        upstreamRoot: path.join(root, "missing-upstream"),
        python: "python",
        registrationTimeoutMs: 1_000,
      }),
    ).rejects.toThrow(/cannot verify Hermes shell-hook registration/);
  });
});

async function writeFakeHookCli(cliPath: string): Promise<string> {
  await writeFile(
    cliPath,
    `#!/usr/bin/env node\nlet stdin = "";\nprocess.stdin.setEncoding("utf8");\nprocess.stdin.on("data", (chunk) => { stdin += chunk; });\nprocess.stdin.on("end", () => {\n  if (!process.argv.includes("agent-command-policy-hook")) {\n    console.error("missing agent-command-policy-hook subcommand");\n    process.exit(2);\n  }\n  process.stdout.write(JSON.stringify({ action: "block", message: "synthetic hook validation block" }) + "\\n");\n});\n`,
    "utf8",
  );
  return cliPath;
}

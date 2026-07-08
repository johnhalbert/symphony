import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_COMMAND_POLICY_HOOK_STDIN_MAX_BYTES,
  buildAgentCommandPolicyHookDecisionJournalFallbackPath,
} from "../src/core/harness/AgentCommandPolicyHookRunner.js";

describe("agent-command-policy-hook CLI", () => {
  it("emits Hermes block JSON for a worker upstream Git command", async () => {
    const result = await runPolicyHookCli({
      args: ["--role", "worker", "--phase", "implementation", "--issue-id", "issue-1", "--run-id", "run-1"],
      input: JSON.stringify(hermesPayload("git push origin main")),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout) as unknown).toMatchObject({
      action: "block",
      message: expect.stringContaining("upstream GitHub contact") as string,
    });
  }, 60_000);

  it("writes a structured decision journal when the CLI is given --decision-journal", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-hook-cli-journal-"));
    const journalPath = path.join(tempRoot, "policy-decisions.ndjson");
    try {
      const result = await runPolicyHookCli({
        args: [
          "--role",
          "worker",
          "--phase",
          "implementation",
          "--issue-id",
          "issue-1",
          "--run-id",
          "run-1",
          "--decision-journal",
          journalPath,
        ],
        input: JSON.stringify(hermesPayload("git push origin main")),
      });

      expect(result.exitCode).toBe(0);
      const lines = (await readFile(journalPath, "utf8")).trim().split(/\r?\n/g);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] as string) as unknown).toMatchObject({
        version: 1,
        runId: "run-1",
        issueId: "issue-1",
        requestKind: "terminal_execute",
        toolCallId: "tool-call-1",
        hookAction: "block",
        decision: {
          outcome: "deny",
          reasonKind: "upstream_github",
        },
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it.each([
    { name: "allow", input: JSON.stringify(hermesPayload("git status --short")) },
    { name: "deny", input: JSON.stringify(hermesPayload("git push origin main")) },
    { name: "fail-closed malformed payload", input: '{"tool_name":"terminal","tool_input":' },
  ])("writes fallback audit and blocks when decision journaling fails for $name outcomes", async ({ name, input }) => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-hook-cli-journal-error-"));
    try {
      const result = await runPolicyHookCli({
        args: [
          "--role",
          "worker",
          "--phase",
          "implementation",
          "--issue-id",
          "issue-1",
          "--run-id",
          "run-1",
          "--decision-journal",
          tempRoot,
        ],
        input,
      });

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout) as unknown).toMatchObject({ action: "block" });
      expect(result.stderr).toContain("wrote fallback journal");
      const fallbackPath = buildAgentCommandPolicyHookDecisionJournalFallbackPath(tempRoot);
      const lines = (await readFile(fallbackPath, "utf8")).trim().split(/\r?\n/g);
      expect(lines).toHaveLength(1);
      const entry = JSON.parse(lines[0] as string) as {
        permissionOutcome: string;
        hookAction: string;
        decision: { outcome: string; reasonKind: string };
      };
      expect(entry.hookAction).toBe("block");
      if (name === "allow") {
        expect(entry).toMatchObject({
          permissionOutcome: "fail_closed",
          decision: { outcome: "deny", reasonKind: "command_policy_journal_error" },
        });
      } else if (name === "deny") {
        expect(entry).toMatchObject({
          permissionOutcome: "denied",
          decision: { outcome: "deny", reasonKind: "upstream_github" },
        });
      } else {
        expect(entry).toMatchObject({
          permissionOutcome: "fail_closed",
          decision: { outcome: "deny", reasonKind: "malformed_hook_payload" },
        });
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
      await rm(buildAgentCommandPolicyHookDecisionJournalFallbackPath(tempRoot), { force: true });
    }
  });

  it("uses environment context and keeps stdout empty for allowed local Git inspection", async () => {
    const result = await runPolicyHookCli({
      env: {
        SYMPHONY_AGENT_ROLE: "worker",
        SYMPHONY_RUN_PHASE: "implementation",
        SYMPHONY_ISSUE_ID: "issue-1",
        SYMPHONY_RUN_ID: "run-1",
      },
      input: JSON.stringify(hermesPayload("git status --short")),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("");
  });

  it("blocks inherited unsafe Git environment for otherwise local Git inspection", async () => {
    const result = await runPolicyHookCli({
      env: {
        SYMPHONY_AGENT_ROLE: "worker",
        SYMPHONY_RUN_PHASE: "implementation",
        SYMPHONY_ISSUE_ID: "issue-1",
        SYMPHONY_RUN_ID: "run-1",
        GIT_PAGER: "sh -c echo blocked",
      },
      input: JSON.stringify(hermesPayload("git log -1")),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout) as unknown).toMatchObject({
      action: "block",
      message: expect.stringContaining("local Git inspection would execute a configured helper") as string,
    });
    expect(result.stdout).not.toContain("sh -c echo blocked");
  });

  it.each([
    { name: "command and cmd", toolInput: { command: "git status --short", cmd: "gh pr create" } },
    { name: "command and code", toolInput: { command: "git status --short", code: "gh pr create" } },
    { name: "cmd and code", toolInput: { cmd: "git status --short", code: "gh pr create" } },
  ])("fails closed for ambiguous command-bearing hook payloads instead of selecting the first field ($name)", async ({ toolInput }) => {
    const result = await runPolicyHookCli({
      args: ["--role", "worker", "--phase", "implementation", "--issue-id", "issue-1", "--run-id", "run-1"],
      input: JSON.stringify(hermesPayload(toolInput)),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout) as unknown).toMatchObject({
      action: "block",
      message: expect.stringContaining("multiple command-bearing fields") as string,
    });
  });

  it.each([
    {
      name: "terminal payload with code instead of command",
      payload: hermesPayload({ code: "git status --short" }),
      expectedKey: "command",
    },
    {
      name: "execute_code payload with command instead of code",
      payload: hermesPayload({ command: "git status --short" }, { toolName: "execute_code" }),
      expectedKey: "code",
    },
  ])("fails closed for mismatched tool name and raw-input shape ($name)", async ({ payload, expectedKey }) => {
    const result = await runPolicyHookCli({
      args: ["--role", "reviewer", "--phase", "review", "--issue-id", "issue-1", "--run-id", "run-1"],
      input: JSON.stringify(payload),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout) as unknown).toMatchObject({
      action: "block",
      message: expect.stringContaining(`requires '${expectedKey}'`) as string,
    });
  });

  it("fails closed with block JSON instead of Commander option errors when context is missing", async () => {
    const result = await runPolicyHookCli({
      input: JSON.stringify(hermesPayload("git status --short")),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout) as unknown).toMatchObject({
      action: "block",
      message: expect.stringContaining("context is incomplete") as string,
    });
  });

  it("fails closed with canonical block JSON when stdin exceeds the bounded payload size", async () => {
    const oversizedSecret = "oversized-cli-secret-value";
    const oversizedToken = "ghp_OVERSIZEDCLISECRET123";
    const oversizedCommand = `git status --short ${oversizedSecret} ${oversizedToken} ${"x".repeat(
      AGENT_COMMAND_POLICY_HOOK_STDIN_MAX_BYTES,
    )}`;
    const result = await runPolicyHookCli({
      args: ["--role", "worker", "--phase", "implementation", "--issue-id", "issue-1", "--run-id", "run-1"],
      input: JSON.stringify(hermesPayload(oversizedCommand)),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const blockResponse = JSON.parse(result.stdout) as { action: string; message: string };
    expect(blockResponse).toMatchObject({
      action: "block",
      message: expect.stringContaining("exceeded the maximum accepted size") as string,
    });
    expect(result.stdout).not.toContain(oversizedSecret);
    expect(result.stdout).not.toContain(oversizedToken);
  });

  it("does not expose credential values in CLI block stdout for token-bearing commands", async () => {
    const ambientSecret = "ambient-cli-secret-value";
    const ambientApiSecret = "ambient-cli-api-secret-value";
    const inlineSecret = "inline-cli-secret-value";
    const openAiApiKey = "openai-cli-api-key-value";
    const awsAccessKey = "aws-cli-access-key-value";
    const quotedAccessKey = "quoted-cli-access-key-value";
    const urlSecret = "url-cli-secret-value";
    const githubToken = "ghp_SYNTHETICCLITOKEN12345";
    const result = await runPolicyHookCli({
      env: {
        SYMPHONY_AGENT_ROLE: "worker",
        SYMPHONY_RUN_PHASE: "implementation",
        SYMPHONY_ISSUE_ID: "issue-1",
        SYMPHONY_RUN_ID: "run-1",
        GITHUB_TOKEN: ambientSecret,
        OPENAI_API_KEY: ambientApiSecret,
      },
      input: JSON.stringify(
        hermesPayload(
          [
            `GITHUB_TOKEN=${inlineSecret}`,
            `OPENAI_API_KEY=${openAiApiKey}`,
            `AWS_ACCESS_KEY_ID="${awsAccessKey}"`,
            `'ACCESS_KEY_ID=${quotedAccessKey}'`,
            `git ls-remote https://${urlSecret}@github.com/org/repo.git`,
            githubToken,
          ].join(" "),
        ),
      ),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout) as unknown).toMatchObject({
      action: "block",
      message: expect.stringContaining("upstream GitHub contact") as string,
    });
    for (const secret of [
      ambientSecret,
      ambientApiSecret,
      inlineSecret,
      openAiApiKey,
      awsAccessKey,
      quotedAccessKey,
      urlSecret,
      githubToken,
    ]) {
      expect(result.stdout).not.toContain(secret);
    }
  });
});

function hermesPayload(commandOrToolInput: string | Record<string, unknown>, options: { toolName?: string } = {}) {
  const toolInput =
    typeof commandOrToolInput === "string"
      ? { command: commandOrToolInput, workdir: os.tmpdir() }
      : { workdir: os.tmpdir(), ...commandOrToolInput };
  return {
    hook_event_name: "pre_tool_call",
    tool_name: options.toolName ?? "terminal",
    tool_input: toolInput,
    session_id: "test-session",
    cwd: os.tmpdir(),
    extra: { task_id: "task-1", tool_call_id: "tool-call-1" },
  };
}

const UNSAFE_POLICY_HOOK_CLI_ENVIRONMENT_KEYS = new Set([
  "GIT_EXTERNAL_DIFF",
  "GIT_PAGER",
  "PAGER",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "GIT_CREDENTIAL_HELPER",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_PAT",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_PRIVATE_KEY",
  "GITHUB_CREDENTIALS",
  "GH_HOSTS",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_PROXY_COMMAND",
  "GIT_EXEC_PATH",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  "BASH_ENV",
  "ENV",
]);

function policyHookCliBaseEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    const normalizedKey = key.toUpperCase();
    if (/^(?:GIT|GH|GITHUB)_/u.test(normalizedKey)) continue;
    if (UNSAFE_POLICY_HOOK_CLI_ENVIRONMENT_KEYS.has(normalizedKey)) continue;
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(normalizedKey)) continue;
    environment[key] = value;
  }
  return environment;
}

async function runPolicyHookCli(options: {
  args?: string[];
  env?: Record<string, string>;
  input: string;
}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const cliPath = path.resolve(process.cwd(), "src", "cli.ts");
  const neutralHome = await mkdtemp(path.join(os.tmpdir(), "symphony-hook-cli-home-"));
  try {
    const child = spawn(process.execPath, ["--import", "tsx", cliPath, "agent-command-policy-hook", ...(options.args ?? [])], {
      cwd: process.cwd(),
      env: {
        ...policyHookCliBaseEnvironment(),
        FORCE_COLOR: "0",
        HOME: neutralHome,
        USERPROFILE: neutralHome,
        XDG_CONFIG_HOME: neutralHome,
        SYMPHONY_AGENT_ROLE: "",
        SYMPHONY_RUN_PHASE: "",
        SYMPHONY_ISSUE_ID: "",
        SYMPHONY_RUN_ID: "",
        ...(options.env ?? {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.stdin.end(options.input);

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });

    return { exitCode, stdout, stderr };
  } finally {
    await rm(neutralHome, { recursive: true, force: true });
  }
}

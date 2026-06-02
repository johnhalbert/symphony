import { spawn } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_COMMAND_POLICY_HOOK_STDIN_MAX_BYTES } from "../src/core/harness/AgentCommandPolicyHookRunner.js";

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
  const toolInput = typeof commandOrToolInput === "string" ? { command: commandOrToolInput } : commandOrToolInput;
  return {
    hook_event_name: "pre_tool_call",
    tool_name: options.toolName ?? "terminal",
    tool_input: toolInput,
    session_id: "test-session",
    cwd: path.resolve(process.cwd()),
    extra: { task_id: "task-1", tool_call_id: "tool-call-1" },
  };
}

async function runPolicyHookCli(options: {
  args?: string[];
  env?: Record<string, string>;
  input: string;
}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const cliPath = path.resolve(process.cwd(), "src", "cli.ts");
  const child = spawn(process.execPath, ["--import", "tsx", cliPath, "agent-command-policy-hook", ...(options.args ?? [])], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      FORCE_COLOR: "0",
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
}

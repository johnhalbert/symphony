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
    const inlineSecret = "inline-cli-secret-value";
    const urlSecret = "url-cli-secret-value";
    const githubToken = "ghp_CLIREDACTIONSECRET123";
    const result = await runPolicyHookCli({
      env: {
        SYMPHONY_AGENT_ROLE: "worker",
        SYMPHONY_RUN_PHASE: "implementation",
        SYMPHONY_ISSUE_ID: "issue-1",
        SYMPHONY_RUN_ID: "run-1",
        GITHUB_TOKEN: ambientSecret,
      },
      input: JSON.stringify(
        hermesPayload(`GITHUB_TOKEN=${inlineSecret} git ls-remote https://${urlSecret}@github.com/org/repo.git ${githubToken}`),
      ),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout) as unknown).toMatchObject({
      action: "block",
      message: expect.stringContaining("direct GitHub host") as string,
    });
    for (const secret of [ambientSecret, inlineSecret, urlSecret, githubToken]) {
      expect(result.stdout).not.toContain(secret);
    }
  });
});

function hermesPayload(command: string) {
  return {
    hook_event_name: "pre_tool_call",
    tool_name: "terminal",
    tool_input: { command },
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

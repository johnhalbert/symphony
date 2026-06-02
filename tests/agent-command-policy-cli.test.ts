import { spawn } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

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

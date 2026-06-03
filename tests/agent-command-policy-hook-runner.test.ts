import { PassThrough, Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  AGENT_COMMAND_POLICY_HOOK_STDIN_MAX_BYTES,
  evaluateAgentCommandPolicyHookPayload,
  runAgentCommandPolicyHookStdio,
  type AgentCommandPolicyHookRunnerContext,
} from "../src/core/harness/AgentCommandPolicyHookRunner.js";
import type {
  AgentCommandPolicyDecision,
  AgentCommandPolicyInput,
} from "../src/core/harness/AgentCommandPolicy.js";

describe("AgentCommandPolicyHookRunner", () => {
  it("maps Hermes pre_tool_call payloads to policy input and emits block JSON for denied decisions", async () => {
    const seenInputs: AgentCommandPolicyInput[] = [];
    const payload = hermesPayload({ command: "git push origin main" }, { cwd: "/repo/worktree" });

    const evaluation = await evaluateAgentCommandPolicyHookPayload(JSON.stringify(payload), {
      role: "worker",
      phase: "implementation",
      issueId: "issue-1",
      environment: { GITHUB_TOKEN: "secret-value", PATH: "/bin" },
      classify: (input) => {
        seenInputs.push(input);
        return decisionFor(input, "deny", {
          reasonKind: "direct_upstream_github",
          commandClass: "direct_upstream_git_operation",
          message: "blocked by test policy",
        });
      },
    });

    expect(seenInputs).toHaveLength(1);
    expect(seenInputs[0]).toMatchObject({
      role: "worker",
      phase: "implementation",
      issueId: "issue-1",
      runId: "test-session",
      surface: "terminal",
      workingDirectory: "/repo/worktree",
      rawInput: { command: "git push origin main" },
      environment: { keysOnly: ["GITHUB_TOKEN", "PATH"] },
    });
    expect(evaluation.policyInput).toBe(seenInputs[0]);
    expect(evaluation.hookResponse).toEqual({ action: "block", message: "blocked by test policy" });
    expect(evaluation.stdout).toBe(`${JSON.stringify({ action: "block", message: "blocked by test policy" })}\n`);
  });

  it("emits empty stdout for allowed local-only decisions", async () => {
    const payload = hermesPayload({ command: "git status --short" });

    const evaluation = await evaluateAgentCommandPolicyHookPayload(JSON.stringify(payload), {
      role: "reviewer",
      phase: "review",
      runId: "run-from-context",
      classify: (input) =>
        decisionFor(input, "allow", {
          reasonKind: "local_only_inspection",
          commandClass: "local_git_inspection",
          message: "allowed by test policy",
        }),
    });

    expect(evaluation.policyInput).toMatchObject({
      role: "reviewer",
      phase: "review",
      runId: "run-from-context",
      surface: "terminal",
      rawInput: { command: "git status --short" },
    });
    expect(evaluation.hookResponse).toBeNull();
    expect(evaluation.stdout).toBe("");
  });

  it.each([
    { name: "command and cmd", toolInput: { command: "git status --short", cmd: "gh pr create" } },
    { name: "command and code", toolInput: { command: "git status --short", code: "gh pr create" } },
    { name: "cmd and code", toolInput: { cmd: "git status --short", code: "gh pr create" } },
    { name: "string command and non-string code", toolInput: { command: "git status --short", code: ["gh pr create"] } },
    { name: "non-string command and string code", toolInput: { command: ["git status --short"], code: "git status --short" } },
  ])("fails closed for ambiguous command-bearing hook payloads ($name)", async ({ toolInput }) => {
    const evaluation = await evaluateAgentCommandPolicyHookPayload(JSON.stringify(hermesPayload(toolInput)), {
      role: "worker",
      phase: "implementation",
    });

    expect(evaluation.policyInput).toMatchObject({
      role: "worker",
      phase: "implementation",
      surface: "terminal",
      rawInput: toolInput,
    });
    expect(evaluation.decision).toMatchObject({
      outcome: "deny",
      reasonKind: "ambiguous_command",
      commandClass: "ambiguous_command_input",
    });
    expect(evaluation.decision.audit.commandPreview).toBeUndefined();
    expect(evaluation.hookResponse?.action).toBe("block");
    expect(JSON.parse(evaluation.stdout) as unknown).toMatchObject({
      action: "block",
      message: expect.stringContaining("multiple command-bearing fields") as string,
    });
    expect(JSON.stringify(evaluation.decision.audit)).not.toContain("gh pr create");
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
    const evaluation = await evaluateAgentCommandPolicyHookPayload(JSON.stringify(payload), {
      role: "reviewer",
      phase: "review",
    });

    expect(evaluation.decision).toMatchObject({
      outcome: "deny",
      reasonKind: "malformed_command",
      commandClass: "mismatched_command_input",
    });
    expect(evaluation.hookResponse?.action).toBe("block");
    expect(JSON.parse(evaluation.stdout) as unknown).toMatchObject({
      action: "block",
      message: expect.stringContaining(`requires '${expectedKey}'`) as string,
    });
  });

  it("blocks execute_code hook payloads with code before execution", async () => {
    const code = `import subprocess
subprocess.run(["gh", "pr", "create", "--fill"])`;
    const evaluation = await evaluateAgentCommandPolicyHookPayload(
      JSON.stringify(hermesPayload({ code }, { toolName: "execute_code" })),
      {
        role: "worker",
        phase: "implementation",
      },
    );

    expect(evaluation.policyInput).toMatchObject({
      role: "worker",
      phase: "implementation",
      surface: "execute_code",
      rawInput: { code },
    });
    expect(evaluation.decision).toMatchObject({
      outcome: "deny",
      reasonKind: "upstream_github",
      commandClass: "execute_code_subprocess_github_cli",
      audit: {
        surface: "execute_code",
        hasNestedCommand: true,
        upstreamContactAttempted: false,
      },
    });
    expect(evaluation.hookResponse?.action).toBe("block");
    expect(JSON.parse(evaluation.stdout) as unknown).toMatchObject({
      action: "block",
      message: expect.stringContaining("service-owned workflow") as string,
    });
  });

  it("fails closed with block JSON for malformed hook payloads before policy classification", async () => {
    const evaluation = await evaluateAgentCommandPolicyHookPayload("{not-json", {
      role: "worker",
      phase: "implementation",
      workingDirectory: "/repo/worktree",
      classify: () => {
        throw new Error("classifier should not be called for malformed JSON");
      },
    });

    expect(evaluation.policyInput).toBeNull();
    expect(evaluation.decision).toMatchObject({
      outcome: "deny",
      reasonKind: "malformed_hook_payload",
      commandClass: "malformed_hermes_hook_payload",
    });
    expect(evaluation.hookResponse?.action).toBe("block");
    expect(evaluation.stdout).toContain("\"action\":\"block\"");
  });

  it("fails closed when required Symphony role or phase context is missing", async () => {
    const evaluation = await evaluateAgentCommandPolicyHookPayload(JSON.stringify(hermesPayload({ command: "git status" })), {
      role: "worker",
    });

    expect(evaluation.policyInput).toBeNull();
    expect(evaluation.decision).toMatchObject({
      outcome: "deny",
      reasonKind: "missing_hook_context",
      commandClass: "missing_agent_command_policy_context",
    });
    expect(evaluation.hookResponse).toEqual({
      action: "block",
      message: expect.stringContaining("agent command policy context is incomplete") as string,
    });
  });

  it("reads stdin completely and writes only deny hook responses to stdout", async () => {
    const payload = JSON.stringify(hermesPayload({ command: "git push origin main" }));
    const output = new CapturingWritable();

    const evaluation = await runAgentCommandPolicyHookStdio({
      input: Readable.from([payload.slice(0, 10), payload.slice(10)]),
      output,
      role: "worker",
      phase: "implementation",
      classify: (input) =>
        decisionFor(input, "deny", {
          reasonKind: "direct_upstream_github",
          commandClass: "direct_upstream_git_operation",
          message: "blocked through stdio",
        }),
    });

    expect(evaluation.hookResponse).toEqual({ action: "block", message: "blocked through stdio" });
    expect(output.text).toBe(`${JSON.stringify({ action: "block", message: "blocked through stdio" })}\n`);
  });

  it("keeps stdout empty for allowed stdio evaluations", async () => {
    const output = new CapturingWritable();

    const evaluation = await runAgentCommandPolicyHookStdio({
      input: Readable.from([JSON.stringify(hermesPayload({ command: "git status --short" }))]),
      output,
      role: "worker",
      phase: "implementation",
      classify: (input) =>
        decisionFor(input, "allow", {
          reasonKind: "local_only_inspection",
          commandClass: "local_git_inspection",
          message: "allowed through stdio",
        }),
    });

    expect(evaluation.hookResponse).toBeNull();
    expect(output.text).toBe("");
  });

  it("fails closed without classification when stdin exceeds the bounded payload size", async () => {
    const output = new CapturingWritable();
    let classifyCalls = 0;
    const oversizedSecret = "oversized-secret-value";
    const oversizedToken = "ghp_OVERSIZEDSECRET123";
    const maxStdinBytes = 256;
    const oversizedPayload = JSON.stringify(
      hermesPayload({
        command: `git status --short ${oversizedSecret} ${oversizedToken} ${"x".repeat(maxStdinBytes)}`,
      }),
    );

    expect(Buffer.byteLength(oversizedPayload, "utf8")).toBeGreaterThan(maxStdinBytes);
    expect(maxStdinBytes).toBeLessThan(AGENT_COMMAND_POLICY_HOOK_STDIN_MAX_BYTES);

    const evaluation = await runAgentCommandPolicyHookStdio({
      input: Readable.from([oversizedPayload]),
      output,
      role: "worker",
      phase: "implementation",
      maxStdinBytes,
      classify: () => {
        classifyCalls += 1;
        throw new Error("classifier should not be called for oversized stdin");
      },
    });

    expect(classifyCalls).toBe(0);
    expect(evaluation.policyInput).toBeNull();
    expect(evaluation.decision).toMatchObject({
      outcome: "deny",
      reasonKind: "oversized_hook_payload",
      commandClass: "oversized_hermes_hook_payload",
    });
    const blockResponse = JSON.parse(output.text) as { action: string; message: string };
    expect(blockResponse).toMatchObject({
      action: "block",
      message: expect.stringContaining("exceeded the maximum accepted size") as string,
    });
    expect(output.text).toBe(evaluation.stdout);
    expect(output.text).not.toContain(oversizedSecret);
    expect(output.text).not.toContain(oversizedToken);
  });

  it("redacts credential values from default policy audit previews and hook stdout", async () => {
    const ambientSecret = "ambient-secret-value";
    const ambientApiSecret = "ambient-api-secret-value";
    const inlineSecret = "inline-secret-value";
    const openAiApiKey = "openai-api-key-value";
    const awsAccessKey = "aws-access-key-value";
    const quotedAccessKey = "quoted-access-key-value";
    const urlSecret = "url-secret-value";
    const githubToken = "ghp_SECRET12345";
    const evaluation = await evaluateAgentCommandPolicyHookPayload(
      JSON.stringify(
        hermesPayload({
          command: [
            `GITHUB_TOKEN=${inlineSecret}`,
            `OPENAI_API_KEY=${openAiApiKey}`,
            `AWS_ACCESS_KEY_ID="${awsAccessKey}"`,
            `'ACCESS_KEY_ID=${quotedAccessKey}'`,
            `git ls-remote https://${urlSecret}@github.com/org/repo.git`,
            githubToken,
          ].join(" "),
        }),
      ),
      {
        role: "worker",
        phase: "implementation",
        environment: { GITHUB_TOKEN: ambientSecret, OPENAI_API_KEY: ambientApiSecret, PATH: "/bin" },
      },
    );

    expect(evaluation.policyInput?.environment).toEqual({ keysOnly: ["GITHUB_TOKEN", "OPENAI_API_KEY", "PATH"] });
    expect(JSON.stringify(evaluation.policyInput?.environment)).not.toContain(ambientSecret);
    expect(JSON.stringify(evaluation.policyInput?.environment)).not.toContain(ambientApiSecret);
    expect(evaluation.decision).toMatchObject({
      outcome: "deny",
      reasonKind: "upstream_github",
      commandClass: "git_ls_remote",
    });
    expect(evaluation.hookResponse?.action).toBe("block");

    const stdoutJson = JSON.stringify(evaluation.hookResponse);
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
      expect(evaluation.stdout).not.toContain(secret);
      expect(stdoutJson).not.toContain(secret);
      expect(JSON.stringify(evaluation.decision.audit)).not.toContain(secret);
    }

    expect(evaluation.decision.audit.inlineEnvironmentKeys).toEqual([
      "ACCESS_KEY_ID",
      "AWS_ACCESS_KEY_ID",
      "GITHUB_TOKEN",
      "OPENAI_API_KEY",
    ]);
    expect(evaluation.decision.audit.commandPreview).toContain("GITHUB_TOKEN=[redacted]");
    expect(evaluation.decision.audit.commandPreview).toContain("OPENAI_API_KEY=[redacted]");
    expect(evaluation.decision.audit.commandPreview).toContain("AWS_ACCESS_KEY_ID=[redacted]");
    expect(evaluation.decision.audit.commandPreview).toContain("ACCESS_KEY_ID=[redacted]");
    expect(evaluation.decision.audit.commandPreview).toContain("https://[redacted]@github.com");
    expect(evaluation.decision.audit.commandPreview).toContain("[redacted-github-token]");
  });

  it("blocks local inspection when inherited hook environment contains unsafe Git variables", async () => {
    const pagerValue = "sh -c echo blocked";
    const evaluation = await evaluateAgentCommandPolicyHookPayload(JSON.stringify(hermesPayload({ command: "git log -1" })), {
      role: "worker",
      phase: "implementation",
      environment: { HOME: "/tmp/home", PATH: "/bin", GIT_PAGER: pagerValue },
    });

    expect(evaluation.policyInput?.environment).toEqual({
      keysOnly: ["GIT_PAGER", "HOME", "PATH"],
      inherited: { HOME: "/tmp/home" },
    });
    expect(evaluation.decision).toMatchObject({
      outcome: "deny",
      reasonKind: "unsafe_git_config",
      commandClass: "git_local_inspection_with_helper",
      audit: {
        inheritedEnvironmentKeys: ["GIT_PAGER", "HOME", "PATH"],
        unsafeConfigCategories: ["pager"],
        upstreamContactAttempted: false,
      },
    });
    expect(evaluation.hookResponse).toEqual({
      action: "block",
      message:
        "Blocked worker/reviewer Git command: local Git inspection would execute a configured helper. Use local inspection without helper configuration or rely on Symphony service-owned GitHub workflow actions.",
    });
    expect(evaluation.stdout).toContain("local Git inspection would execute a configured helper");
    expect(evaluation.stdout).not.toContain(pagerValue);
  });
});

function hermesPayload(toolInput: Record<string, unknown>, options: { toolName?: string; cwd?: string } = {}) {
  return {
    hook_event_name: "pre_tool_call",
    tool_name: options.toolName ?? "terminal",
    tool_input: toolInput,
    session_id: "test-session",
    cwd: options.cwd ?? process.cwd(),
    extra: { task_id: "task-1", tool_call_id: "tool-call-1" },
  };
}

function decisionFor(
  input: AgentCommandPolicyInput,
  outcome: "allow" | "deny",
  details: Pick<AgentCommandPolicyDecision, "reasonKind" | "commandClass" | "message">,
): AgentCommandPolicyDecision {
  return {
    outcome,
    reasonKind: details.reasonKind,
    commandClass: details.commandClass,
    message: details.message,
    audit: {
      redacted: true,
      role: input.role,
      phase: input.phase,
      surface: input.surface,
      commandClass: details.commandClass,
      inlineEnvironmentKeys: [],
      unsafeConfigCategories: [],
      upstreamContactAttempted: false,
    },
  };
}

class CapturingWritable extends Writable {
  text = "";

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    callback();
  }
}

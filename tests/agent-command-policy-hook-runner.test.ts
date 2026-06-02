import { PassThrough, Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
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
    const payload = hermesPayload({ command: "git push origin main" });

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
});

function hermesPayload(toolInput: Record<string, unknown>) {
  return {
    hook_event_name: "pre_tool_call",
    tool_name: "terminal",
    tool_input: toolInput,
    session_id: "test-session",
    cwd: "/repo/worktree",
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

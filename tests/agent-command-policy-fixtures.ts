import {
  type AgentCommandPolicyAuditPayload,
  type AgentCommandPolicyCommandClass,
  type AgentCommandPolicyDecision,
  type AgentCommandPolicyEnvironmentInput,
  type AgentCommandPolicyInput,
  type AgentCommandPolicyNormalizedCommand,
  type AgentCommandPolicyOutcome,
  type AgentCommandPolicyReasonKind,
  type AgentCommandPolicySurface,
  normalizeAgentCommandPolicyExecutable,
} from "../src/core/harness/AgentCommandPolicy.js";
import type { AgentRunPhase, AgentRunRole } from "../src/core/types.js";

export function agentCommandPolicyInput(overrides: Partial<AgentCommandPolicyInput> = {}): AgentCommandPolicyInput {
  return {
    runId: "run-agent-command-policy-1",
    issueId: "issue-agent-command-policy-1",
    attemptId: "attempt-agent-command-policy-1",
    role: "worker",
    phase: "implementation",
    surface: "terminal",
    workingDirectory: "/workspace/symphony",
    rawInput: { kind: "command", command: "git status --short" },
    environment: agentCommandPolicyEnvironmentInput(),
    ...overrides,
  };
}

export function terminalPolicyInput(
  command = "git status --short",
  overrides: Partial<AgentCommandPolicyInput> = {},
): AgentCommandPolicyInput {
  return agentCommandPolicyInput({
    surface: "terminal",
    rawInput: { kind: "command", command },
    ...overrides,
  });
}

export function executeCodePolicyInput(
  code = "print('local inspection only')",
  overrides: Partial<AgentCommandPolicyInput> = {},
): AgentCommandPolicyInput {
  return agentCommandPolicyInput({
    surface: "execute_code",
    rawInput: { kind: "code", code, language: "python" },
    ...overrides,
  });
}

export function gatewayToolCallPolicyInput(
  params: unknown,
  overrides: Partial<AgentCommandPolicyInput> = {},
): AgentCommandPolicyInput {
  return agentCommandPolicyInput({
    surface: "gateway_pre_tool_call",
    rawInput: { kind: "tool_call", toolName: "terminal", params },
    ...overrides,
  });
}

export function agentCommandPolicyEnvironmentInput(
  overrides: AgentCommandPolicyEnvironmentInput = {},
): AgentCommandPolicyEnvironmentInput {
  return {
    keysOnly: ["PATH", "HOME"],
    ...overrides,
  };
}

export function agentCommandPolicyDecision(overrides: Partial<AgentCommandPolicyDecision> = {}): AgentCommandPolicyDecision {
  const outcome = overrides.outcome ?? "deny";
  const reasonKind = overrides.reasonKind ?? (outcome === "allow" ? "safe_local_inspection" : "upstream_github");
  const commandClass = overrides.commandClass ?? (outcome === "allow" ? "safe_local_inspection" : "direct_upstream_git");
  const normalizedCommand = overrides.normalizedCommand ?? agentCommandPolicyNormalizedCommand({ commandClass });

  return {
    attemptId: "attempt-agent-command-policy-1",
    outcome,
    reasonKind,
    commandClass,
    message: defaultPolicyMessage(outcome, reasonKind),
    requiresCodeChange: false,
    requiresUserOrServiceFix: outcome === "deny",
    normalizedCommand,
    audit: agentCommandPolicyAuditPayload({
      outcome,
      reasonKind,
      commandClass,
      normalizedExecutable: normalizedCommand.executable,
      executableKind: normalizedCommand.executableKind,
      gitSubcommand: normalizedCommand.gitSubcommand,
    }),
    ...overrides,
  };
}

export function allowPolicyDecision(overrides: Partial<AgentCommandPolicyDecision> = {}): AgentCommandPolicyDecision {
  return agentCommandPolicyDecision({
    outcome: "allow",
    reasonKind: "safe_local_inspection",
    commandClass: "safe_local_inspection",
    requiresUserOrServiceFix: false,
    ...overrides,
  });
}

export function denyPolicyDecision(overrides: Partial<AgentCommandPolicyDecision> = {}): AgentCommandPolicyDecision {
  return agentCommandPolicyDecision({
    outcome: "deny",
    reasonKind: "upstream_github",
    commandClass: "direct_upstream_git",
    requiresUserOrServiceFix: true,
    ...overrides,
  });
}

export function agentCommandPolicyNormalizedCommand(
  overrides: Partial<AgentCommandPolicyNormalizedCommand> & { commandClass?: AgentCommandPolicyCommandClass } = {},
): AgentCommandPolicyNormalizedCommand {
  const executable = overrides.commandClass === "github_cli_operation" ? "gh" : "git";
  const normalizedExecutable = normalizeAgentCommandPolicyExecutable(executable);

  return {
    executable: normalizedExecutable.normalizedExecutable,
    executableKind: normalizedExecutable.executableKind,
    argumentsPreview: null,
    gitSubcommand: executable === "git" ? "status" : null,
    targetHosts: [],
    hasNestedCommand: false,
    hasInlineEnvironment: false,
    hasUnsafeGitConfig: false,
    ...overrides,
  };
}

export function agentCommandPolicyAuditPayload(
  overrides: Partial<AgentCommandPolicyAuditPayload> = {},
): AgentCommandPolicyAuditPayload {
  return {
    redacted: true,
    surface: "terminal",
    role: "worker",
    phase: "implementation",
    outcome: "deny",
    reasonKind: "upstream_github",
    rawInputPreview: "git push origin HEAD",
    rawInputPreviewTruncated: false,
    rawInputPreviewRedacted: false,
    normalizedExecutable: "git",
    executableKind: "git",
    gitSubcommand: "push",
    commandClass: "direct_upstream_git",
    inheritedEnvironmentKeys: ["HOME", "PATH"],
    inlineEnvironmentKeys: [],
    unsafeConfigCategories: [],
    upstreamContactAttempted: false,
    ...overrides,
  };
}

export function policyInputForRoleAndSurface(
  role: AgentRunRole,
  surface: AgentCommandPolicySurface,
  phase: AgentRunPhase = "implementation",
): AgentCommandPolicyInput {
  return agentCommandPolicyInput({ role, phase, surface });
}

function defaultPolicyMessage(outcome: AgentCommandPolicyOutcome, reasonKind: AgentCommandPolicyReasonKind): string {
  if (outcome === "allow") return "Allowed local-only, helper-free repository inspection.";
  if (reasonKind === "upstream_github") {
    return "Blocked worker/reviewer upstream GitHub activity. Use Symphony service-owned publication, review, and writeback workflow actions instead.";
  }
  return "Blocked worker/reviewer command because it is not proven local-only and helper-free.";
}

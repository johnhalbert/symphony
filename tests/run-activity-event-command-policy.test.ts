import { describe, expect, it } from "vitest";
import type { AgentCommandPolicyDecision } from "../src/core/harness/AgentCommandPolicy.js";
import {
  RUN_ACTIVITY_KIND_BY_CHANNEL,
  isRunActivityEvent,
  type RunActivityCommandPolicyDecisionPayload,
  type RunCommandPolicyDecisionActivityEvent,
} from "../src/core/runActivity/RunActivityEvent.js";
import { agentCommandPolicyAuditPayload, allowPolicyDecision, denyPolicyDecision } from "./agent-command-policy-fixtures.js";

const deniedNormalizedCommand = {
  executable: "git",
  executableKind: "git" as const,
  argumentsPreview: "push origin HEAD",
  gitSubcommand: "push",
  targetHosts: ["github.com"],
  hasNestedCommand: false,
  hasInlineEnvironment: false,
  hasUnsafeGitConfig: false,
};

function commandPolicyPayload(
  decision: AgentCommandPolicyDecision,
  overrides: Partial<RunActivityCommandPolicyDecisionPayload> = {},
): RunActivityCommandPolicyDecisionPayload {
  const base = {
    redacted: true,
    decisionId: decision.decisionId ?? null,
    attemptId: decision.attemptId ?? null,
    surface: decision.audit.surface,
    role: decision.audit.role,
    phase: decision.audit.phase,
    outcome: decision.outcome,
    reasonKind: decision.reasonKind,
    commandClass: decision.commandClass,
    message: decision.message,
    upstreamContactAttempted: decision.audit.upstreamContactAttempted,
    ...(decision.requiresCodeChange === undefined ? {} : { requiresCodeChange: decision.requiresCodeChange }),
    ...(decision.requiresUserOrServiceFix === undefined ? {} : { requiresUserOrServiceFix: decision.requiresUserOrServiceFix }),
    ...(decision.normalizedCommand === undefined ? {} : { normalizedCommand: decision.normalizedCommand }),
    audit: decision.audit,
  } satisfies RunActivityCommandPolicyDecisionPayload;
  return { ...base, ...overrides } as RunActivityCommandPolicyDecisionPayload;
}

function commandPolicyEvent(
  decision: AgentCommandPolicyDecision,
  overrides: Partial<RunCommandPolicyDecisionActivityEvent> = {},
): RunCommandPolicyDecisionActivityEvent {
  const base = {
    eventId: `command-policy:${decision.decisionId ?? decision.attemptId ?? "decision"}`,
    runSessionId: "run-command-policy:session-1",
    occurredAt: "2026-06-01T12:00:00.000Z",
    sequence: 7,
    sequenceSource: "symphony" as const,
    protocol: "symphony" as const,
    harness: "hermes-command-policy",
    actor: "harness" as const,
    channel: "diagnostic" as const,
    kind: "command_policy_decision" as const,
    text: `Command policy ${decision.outcome}: ${decision.reasonKind}`,
    payload: commandPolicyPayload(decision),
  } satisfies RunCommandPolicyDecisionActivityEvent;
  return { ...base, ...overrides } as RunCommandPolicyDecisionActivityEvent;
}

describe("command policy run activity schema", () => {
  it("defines command policy decisions as diagnostic run activity events with structured audit fields", () => {
    const decision = denyPolicyDecision({
      decisionId: "decision-deny-upstream-1",
      attemptId: "tool-call-terminal-1",
      commandClass: "direct_upstream_git_operation",
      normalizedCommand: deniedNormalizedCommand,
      audit: agentCommandPolicyAuditPayload({
        surface: "terminal_execute",
        role: "worker",
        phase: "implementation",
        outcome: "deny",
        reasonKind: "upstream_github",
        commandClass: "direct_upstream_git_operation",
        normalizedExecutable: "git",
        executableKind: "git",
        gitSubcommand: "push",
        commandPreview: "git push origin HEAD",
        targetHosts: ["github.com"],
        upstreamContactAttempted: false,
      }),
    });

    const event = commandPolicyEvent(decision, {
      payload: commandPolicyPayload(decision, {
        runId: "run-command-policy-1",
        issueId: "issue-command-policy-1",
        requestKind: "terminal_execute",
        toolCallId: "tool-call-terminal-1",
        permissionOutcome: "denied",
        hookAction: "block",
      }),
    });

    expect(RUN_ACTIVITY_KIND_BY_CHANNEL.diagnostic).toContain("command_policy_decision");
    expect(isRunActivityEvent(event)).toBe(true);
    expect(event).toMatchObject({
      actor: "harness",
      channel: "diagnostic",
      kind: "command_policy_decision",
      payload: {
        redacted: true,
        decisionId: "decision-deny-upstream-1",
        attemptId: "tool-call-terminal-1",
        surface: "terminal_execute",
        role: "worker",
        phase: "implementation",
        outcome: "deny",
        reasonKind: "upstream_github",
        commandClass: "direct_upstream_git_operation",
        upstreamContactAttempted: false,
        requestKind: "terminal_execute",
        toolCallId: "tool-call-terminal-1",
        permissionOutcome: "denied",
        hookAction: "block",
        audit: {
          redacted: true,
          commandClass: "direct_upstream_git_operation",
          reasonKind: "upstream_github",
          upstreamContactAttempted: false,
          targetHosts: ["github.com"],
        },
      },
    });
  });

  it("supports allow decisions for helper-free local inspection without marking upstream contact", () => {
    const decision = allowPolicyDecision({
      decisionId: "decision-allow-local-1",
      attemptId: "tool-call-terminal-2",
      reasonKind: "local_only_inspection",
      commandClass: "local_git_inspection",
      message: "Allowed helper-free local Git inspection command.",
      requiresUserOrServiceFix: false,
      normalizedCommand: {
        executable: "git",
        executableKind: "git",
        argumentsPreview: "status --short",
        gitSubcommand: "status",
        targetHosts: [],
        hasNestedCommand: false,
        hasInlineEnvironment: false,
        hasUnsafeGitConfig: false,
      },
      audit: agentCommandPolicyAuditPayload({
        surface: "terminal_execute",
        role: "reviewer",
        phase: "review",
        outcome: "allow",
        reasonKind: "local_only_inspection",
        commandClass: "local_git_inspection",
        rawInputPreview: "git status --short",
        normalizedExecutable: "git",
        executableKind: "git",
        gitSubcommand: "status",
        commandPreview: "git status --short",
        upstreamContactAttempted: false,
      }),
    });

    const event = commandPolicyEvent(decision, {
      eventId: "command-policy:decision-allow-local-1",
      text: "Command policy allowed local inspection",
      payload: commandPolicyPayload(decision, { selectedOptionId: "allow_once", permissionOutcome: "allow_once" }),
    });

    expect(isRunActivityEvent(event)).toBe(true);
    expect(event.payload).toMatchObject({
      outcome: "allow",
      reasonKind: "local_only_inspection",
      commandClass: "local_git_inspection",
      role: "reviewer",
      phase: "review",
      upstreamContactAttempted: false,
      selectedOptionId: "allow_once",
      permissionOutcome: "allow_once",
      audit: {
        outcome: "allow",
        reasonKind: "local_only_inspection",
        commandClass: "local_git_inspection",
        upstreamContactAttempted: false,
      },
    });
  });

  it("keeps policy evidence bounded to redacted previews, environment keys, categories, and outcomes", () => {
    const decision = denyPolicyDecision({
      decisionId: "decision-deny-env-1",
      attemptId: "tool-call-terminal-3",
      reasonKind: "unsafe_environment",
      commandClass: "git_local_inspection_with_helper",
      normalizedCommand: {
        executable: "git",
        executableKind: "git",
        argumentsPreview: "diff",
        gitSubcommand: "diff",
        targetHosts: [],
        hasNestedCommand: false,
        hasInlineEnvironment: true,
        hasUnsafeGitConfig: true,
      },
      audit: agentCommandPolicyAuditPayload({
        outcome: "deny",
        reasonKind: "unsafe_environment",
        commandClass: "git_local_inspection_with_helper",
        rawInputPreview: "GIT_ASKPASS=[redacted] git diff",
        rawInputPreviewRedacted: true,
        commandPreview: "GIT_ASKPASS=[redacted] git diff",
        inlineEnvironmentKeys: ["GIT_ASKPASS"],
        inheritedEnvironmentKeys: ["HOME", "PATH"],
        unsafeConfigCategories: ["credential_helper"],
        unsafeConfigFindings: [
          {
            source: "inline_env",
            key: "GIT_ASKPASS",
            category: "credential_helper",
            effect: "uses_credentials",
          },
        ],
        upstreamContactAttempted: false,
      }),
    });

    const event = commandPolicyEvent(decision);
    const serialized = JSON.stringify(event);

    expect(event.payload.audit.inlineEnvironmentKeys).toEqual(["GIT_ASKPASS"]);
    expect(event.payload.audit.unsafeConfigCategories).toEqual(["credential_helper"]);
    expect(event.payload.audit.unsafeConfigFindings).toEqual([
      { source: "inline_env", key: "GIT_ASKPASS", category: "credential_helper", effect: "uses_credentials" },
    ]);
    expect(serialized).toContain("[redacted]");
    expect(serialized).not.toContain("SECRET_");
    expect(serialized).not.toContain("ghp_");
    expect(serialized).not.toContain("askpass-helper-value");
  });
});

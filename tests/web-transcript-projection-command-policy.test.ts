import { describe, expect, it } from "vitest";
import { projectWebTranscript } from "../src/app/WebTranscriptProjection.js";
import type { AgentEvent } from "../src/core/harness/AgentHarness.js";
import type { PersistedCommandPolicyReplayState, TranscriptEvent } from "../src/core/persistence/RunTranscriptStore.js";
import {
  projectTranscriptEventForPublicRead,
  sanitizeAgentEventForPublicOutput,
  sanitizeCommandPolicyReplayStateForPublicOutput,
} from "../src/core/transcript/TranscriptProjection.js";

const RAW_DENIED_COMMAND =
  "GIT_ASKPASS=/tmp/secret-askpass GITHUB_TOKEN=SECRET_ENV_TOKEN git push https://user:SECRET_STATUS_PASSWORD@github.com/acme/repo.git HEAD";
const RAW_GH_COMMAND = "gh pr create --title repair --body raw-body";
const RAW_BEARER = "Bearer raw-status-token";
const SENSITIVE_SUBSTRINGS = [
  "git push",
  "gh pr create",
  "SECRET_",
  "raw-status-token",
  "user:SECRET_STATUS_PASSWORD",
  "/tmp/secret",
  "raw-body",
  "credential-helper-secret",
];

describe("command-policy public transcript projection", () => {
  it.each([
    {
      name: "denied upstream command",
      outcome: "deny",
      reasonKind: "upstream_github",
      commandClass: "direct_upstream_git_operation",
      surface: "terminal_execute",
      role: "worker",
      phase: "implementation",
      requestKind: "pre_tool_call",
      hookAction: "block",
      permissionOutcome: "denied",
      upstreamContactAttempted: false,
      expectedText: "Command policy deny: upstream_github (worker · implementation · terminal_execute)",
    },
    {
      name: "service-owned allowed publication boundary",
      outcome: "allow",
      reasonKind: "service_owned_github_operation",
      commandClass: "service_owned_publication",
      surface: "symphony_service_publication",
      role: "worker",
      phase: "publication",
      requestKind: "service_boundary",
      hookAction: "allow",
      permissionOutcome: "allowed",
      upstreamContactAttempted: true,
      expectedText: "Command policy allow: service_owned_github_operation (worker · publication · symphony_service_publication)",
    },
    {
      name: "ambiguous command fail-closed",
      outcome: "deny",
      reasonKind: "ambiguous_upstream_contact",
      commandClass: "unknown_upstream_risk",
      surface: "execute_code",
      role: "reviewer",
      phase: "review",
      requestKind: "mcp_tool_call",
      hookAction: "block",
      permissionOutcome: "denied",
      upstreamContactAttempted: false,
      expectedText: "Command policy deny: ambiguous_upstream_contact (reviewer · review · execute_code)",
    },
  ])("projects $name as safe web status metadata without display text leaks", (variant) => {
    const messages = projectWebTranscript([
      event({
        eventType: "command_policy_decision",
        source: "harness",
        message: `Denied raw display event message: ${RAW_DENIED_COMMAND}`,
        payload: commandPolicyPayload({
          ...variant,
          message: `payload.message has raw command ${RAW_DENIED_COMMAND}`,
          text: `payload.text has raw command ${RAW_GH_COMMAND}`,
          textPreview: `payload.textPreview has ${RAW_BEARER} and ${RAW_DENIED_COMMAND}`,
          messagePreview: `payload.messagePreview has helper /tmp/secret-credential-helper and ${RAW_GH_COMMAND}`,
        }),
      }),
    ]);

    expect(messages).toEqual([
      {
        kind: "status",
        state: "command_policy_decision",
        ts: "2026-01-01T00:00:00.000Z",
        text: variant.expectedText,
        policy: {
          outcome: variant.outcome,
          reasonKind: variant.reasonKind,
          role: variant.role,
          phase: variant.phase,
          surface: variant.surface,
          commandClass: variant.commandClass,
          upstreamContactAttempted: variant.upstreamContactAttempted,
          requiresUserOrServiceFix: true,
          requestKind: variant.requestKind,
          hookAction: variant.hookAction,
          permissionOutcome: variant.permissionOutcome,
        },
      },
    ]);
    expectNoSensitiveSubstrings(JSON.stringify(messages));
  });

  it("redacts command display fields and raw command metadata from public transcript reads", () => {
    const publicEvent = projectTranscriptEventForPublicRead(
      event({
        eventType: "command_policy_decision",
        source: "harness",
        message: `top-level event.message has raw command ${RAW_DENIED_COMMAND}`,
        payload: commandPolicyPayload({
          outcome: "deny",
          reasonKind: "upstream_github",
          commandClass: "direct_upstream_git_operation",
          surface: "terminal_execute",
          role: "worker",
          phase: "implementation",
          message: `payload.message has raw command ${RAW_DENIED_COMMAND}`,
          text: `payload.text has raw command ${RAW_GH_COMMAND}`,
          textPreview: `payload.textPreview has ${RAW_BEARER}`,
          messagePreview: "payload.messagePreview has /tmp/secret-helper and credential-helper-secret",
        }),
      }),
    );
    const payload = publicEvent.payload as Record<string, unknown>;
    const audit = payload.audit as Record<string, unknown>;
    const normalizedCommand = payload.normalizedCommand as Record<string, unknown>;

    expect(publicEvent.message).toBe("Command policy deny: upstream_github (worker · implementation · terminal_execute)");
    expect(payload).toMatchObject({
      outcome: "deny",
      reasonKind: "upstream_github",
      role: "worker",
      phase: "implementation",
      surface: "terminal_execute",
      commandClass: "direct_upstream_git_operation",
      message: "[redacted command payload]",
      text: "[redacted command payload]",
      textPreview: "[redacted command payload]",
      messagePreview: "[redacted command payload]",
      commandPreview: "[redacted command payload]",
      rawInputPreview: "[redacted command payload]",
      env: "[redacted environment values]",
      helperPath: "[redacted helper path]",
      redacted: true,
    });
    expect(payload).not.toHaveProperty("raw");
    expect(payload).not.toHaveProperty("protocolPayload");
    expect(audit).toMatchObject({
      commandPreview: "[redacted command payload]",
      rawInputPreview: "[redacted command payload]",
      rawInputPreviewRedacted: true,
      helperPath: "[redacted helper path]",
      redacted: true,
    });
    expect(normalizedCommand.argumentsPreview).toBe("[redacted command payload]");
    expectNoSensitiveSubstrings(JSON.stringify(publicEvent));
  });

  it("redacts persisted replay-state decisions and malformed command-policy records for public run status", () => {
    const publicState = sanitizeCommandPolicyReplayStateForPublicOutput({
      decisionCount: 1,
      malformedEventCount: 1,
      lastDecisionAt: "2026-01-01T00:00:00.000Z",
      lastMalformedAt: "2026-01-01T00:00:01.000Z",
      decisions: [
        {
          sequence: 1,
          at: "2026-01-01T00:00:00.000Z",
          source: "harness",
          decisionId: "decision-1",
          attemptId: "attempt-1",
          activityId: "command-policy:decision-1",
          runId: "run-1",
          issueId: "issue-1",
          surface: "terminal_execute",
          role: "worker",
          phase: "implementation",
          outcome: "deny",
          reasonKind: "upstream_github",
          commandClass: "direct_upstream_git_operation",
          message: `persisted decision.message has raw command ${RAW_DENIED_COMMAND}`,
          upstreamContactAttempted: false,
          redacted: true,
          requiresUserOrServiceFix: true,
          normalizedCommand: { argumentsPreview: RAW_DENIED_COMMAND },
          audit: { rawInputPreview: RAW_DENIED_COMMAND, helperPath: "/tmp/secret-credential-helper" },
        },
      ],
      malformedEvents: [
        {
          sequence: 2,
          at: "2026-01-01T00:00:01.000Z",
          source: "harness",
          eventType: "command_policy_decision",
          payloadPresent: true,
          failureKind: "malformed_persisted_policy_data",
          safeOutcome: "deny",
          message: `malformed message has raw command ${RAW_GH_COMMAND}`,
          redacted: true,
          raw: { params: { command: RAW_GH_COMMAND } },
        } as PersistedCommandPolicyReplayState["malformedEvents"][number] & { raw: unknown },
      ],
    });

    expect(publicState.decisions[0]).toMatchObject({
      outcome: "deny",
      reasonKind: "upstream_github",
      message: "[redacted command payload]",
      normalizedCommand: { argumentsPreview: "[redacted command payload]" },
    });
    expect(publicState.malformedEvents[0]).toMatchObject({
      eventType: "command_policy_decision",
      safeOutcome: "deny",
      message: "[redacted command payload]",
      redacted: true,
    });
    expect(publicState.malformedEvents[0]).not.toHaveProperty("raw");
    expectNoSensitiveSubstrings(JSON.stringify(publicState));
  });

  it("redacts command-policy run-activity display fields before public agent event output", () => {
    const publicAgentEvent = sanitizeAgentEventForPublicOutput({
      type: "progress",
      message: `progress message has raw command ${RAW_DENIED_COMMAND}`,
      runActivity: {
        kind: "command_policy_decision",
        text: `runActivity.text has raw command ${RAW_DENIED_COMMAND}`,
        message: `runActivity.message has ${RAW_GH_COMMAND}`,
        textPreview: `runActivity.textPreview has ${RAW_BEARER}`,
        messagePreview: "runActivity.messagePreview has /tmp/secret-helper",
        payload: commandPolicyPayload({
          outcome: "deny",
          reasonKind: "upstream_github",
          commandClass: "direct_upstream_git_operation",
          surface: "terminal_execute",
          role: "worker",
          phase: "implementation",
          message: `nested payload.message has raw command ${RAW_DENIED_COMMAND}`,
        }),
      },
    } as unknown as AgentEvent);
    const runActivity = (publicAgentEvent as AgentEvent & { runActivity: Record<string, unknown> }).runActivity;
    const payload = runActivity.payload as Record<string, unknown>;

    expect(publicAgentEvent).toMatchObject({ type: "progress", message: "[redacted command payload]" });
    expect(runActivity).toMatchObject({
      text: "[redacted command payload]",
      message: "[redacted command payload]",
      textPreview: "[redacted command payload]",
      messagePreview: "[redacted command payload]",
    });
    expect(payload.message).toBe("[redacted command payload]");
    expect(payload.commandPreview).toBe("[redacted command payload]");
    expectNoSensitiveSubstrings(JSON.stringify(publicAgentEvent));
  });
});

function commandPolicyPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "command_policy_decision",
    decisionId: "decision-public-policy",
    surface: "terminal_execute",
    role: "worker",
    phase: "implementation",
    outcome: "deny",
    reasonKind: "upstream_github",
    commandClass: "direct_upstream_git_operation",
    upstreamContactAttempted: false,
    requiresUserOrServiceFix: true,
    requestKind: "pre_tool_call",
    permissionOutcome: "denied",
    hookAction: "block",
    commandPreview: RAW_DENIED_COMMAND,
    rawInputPreview: RAW_DENIED_COMMAND,
    raw: { params: { command: RAW_DENIED_COMMAND, token: "SECRET_RAW_TOKEN" } },
    protocolPayload: { jsonrpc: "2.0", params: { command: RAW_GH_COMMAND } },
    env: { GIT_ASKPASS: "/tmp/secret-askpass", GITHUB_TOKEN: "SECRET_ENV_TOKEN" },
    helperPath: "/tmp/secret-credential-helper",
    normalizedCommand: {
      executable: "git",
      argumentsPreview: RAW_DENIED_COMMAND,
      targetHosts: ["github.com"],
    },
    audit: {
      redacted: true,
      rawInputPreview: RAW_DENIED_COMMAND,
      commandPreview: RAW_DENIED_COMMAND,
      helperPath: "/tmp/secret-credential-helper",
      inlineEnvironmentKeys: ["GIT_ASKPASS"],
      upstreamContactAttempted: false,
    },
    ...overrides,
  };
}

function event(overrides: Partial<TranscriptEvent>): TranscriptEvent {
  return {
    runId: "run-1",
    sequence: 1,
    at: "2026-01-01T00:00:00.000Z",
    source: "harness",
    eventType: "progress",
    ...overrides,
  };
}

function expectNoSensitiveSubstrings(serialized: string): void {
  for (const substring of SENSITIVE_SUBSTRINGS) {
    expect(serialized).not.toContain(substring);
  }
}

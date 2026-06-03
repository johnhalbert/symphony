import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/core/harness/AgentHarness.js";
import type { RunActivityCommandPolicyDecisionPayload, RunActivityEvent } from "../src/core/runActivity/RunActivityEvent.js";
import {
  mapAgentEventToRunActivityEvent,
  mapRunActivityEventToTranscriptEvent,
  RUN_ACTIVITY_AGENT_EVENT_SCHEMA_PREFIX,
} from "../src/core/transcript/RunActivityEventMapper.js";

const providerLimitSignal = {
  scope: { harnessId: "hermes", providerId: "openai-codex", model: "gpt-5.5" },
  kind: "windowed_bucket_exhausted" as const,
  window: { resumeAt: "2026-06-01T00:00:00.000Z", windowKind: "codex_5h" },
  resumePolicy: "auto_at_window_close" as const,
  message: "Hermes provider usage limit reached",
  observedAt: "2026-05-31T00:00:00.000Z",
  source: { issueIdentifier: "ENG-193", runId: "run-1", sessionId: "session-1", role: "worker" as const },
  raw: { jsonrpc: "2.0", token: "SECRET_PROVIDER_TOKEN" },
};

describe("mapAgentEventToRunActivityEvent", () => {
  it("maps every existing AgentEvent variant into schema-tagged normalized run activity events", () => {
    const fixtures: AgentEvent[] = [
      { type: "session_started", sessionId: "profile:gateway:run", threadId: "gateway-session", runId: "run-1" },
      { type: "progress", message: "Hermes gateway ready" },
      { type: "progress", activitySource: "delta", message: "assistant response chunk" },
      { type: "progress", activitySource: "tool", message: "Hermes tool terminal completed" },
      { type: "tokens", tokens: { inputTokens: 11, outputTokens: 13, totalTokens: 24 } },
      { type: "rate_limits", payload: { requests: { remaining: 4, reset: "soon" }, authorization: "Bearer SECRET_RATE_TOKEN" } },
      { type: "provider_limit", signal: providerLimitSignal },
      { type: "run_status", runId: "run-1", sdkStatus: "running", source: "onDidChangeStatus" },
      {
        type: "run_diagnostic",
        code: "hermes_gateway_protocol_error",
        message: "Hermes gateway emitted malformed JSON-RPC output",
        payload: { preview: "malformed line", rawPayload: { token: "SECRET_RAW_TOKEN" } },
      },
      { type: "completed", message: "final assistant answer" },
      { type: "failed", error: "Hermes run failed: token=SECRET_FAILURE_TOKEN" },
      { type: "cancelled" },
    ];

    const mapped = fixtures.map(mapAgentEventToRunActivityEvent);

    expect(mapped.map((event) => event.eventType)).toEqual([
      "session_started",
      "progress",
      "progress",
      "progress",
      "tokens",
      "rate_limits",
      "provider_limit",
      "run_status",
      "run_diagnostic",
      "completed",
      "failed",
      "cancelled",
    ]);
    for (const event of mapped) {
      expect(event.payloadSchema).toBe(`${RUN_ACTIVITY_AGENT_EVENT_SCHEMA_PREFIX}.${event.eventType}.v1`);
      expect(event.payloadByteLength).toEqual(expect.any(Number));
      expect(event.payloadByteLength).toBeGreaterThan(0);
    }
    expect(mapped[0]).toMatchObject({
      message: "Session started",
      payload: { kind: "system", sessionId: "profile:gateway:run", threadId: "gateway-session", runId: "run-1" },
    });
    expect(mapped[4]?.payload).toEqual({ kind: "usage", tokens: { inputTokens: 11, outputTokens: 13, totalTokens: 24 } });
    expect(mapped[7]).toMatchObject({
      message: "Run status: running",
      payload: { kind: "status", runId: "run-1", sdkStatus: "running", sdkStatusSource: "onDidChangeStatus" },
    });
    expect(mapped[9]).toMatchObject({
      message: "final assistant answer",
      payload: { kind: "terminal", status: "succeeded", textPreview: "final assistant answer" },
    });
    expect(mapped[10]).toMatchObject({
      message: "Hermes run failed: token=[redacted]",
      payload: { kind: "terminal", status: "failed", errorPreview: "Hermes run failed: token=[redacted]", redacted: true },
    });
    expect(mapped[11]).toMatchObject({ message: "Run cancelled", payload: { kind: "terminal", status: "cancelled" } });
  });

  it("documents ambiguous progress mapping: explicit deltas are assistant_delta, tool activity is tool, and stream/missing source stays generic progress", () => {
    const stream = mapAgentEventToRunActivityEvent({ type: "progress", activitySource: "stream", message: "Cursor assistant or Hermes status stream" });
    const missing = mapAgentEventToRunActivityEvent({ type: "progress", message: "legacy progress without activity source" });
    const delta = mapAgentEventToRunActivityEvent({ type: "progress", activitySource: "delta", message: "partial assistant text" });
    const tool = mapAgentEventToRunActivityEvent({ type: "progress", activitySource: "tool", message: "Hermes tool terminal started" });

    expect(stream.payload).toMatchObject({ kind: "progress", activitySource: "stream", progressKind: "progress" });
    expect(missing.payload).toMatchObject({ kind: "progress", activitySource: "stream", progressKind: "progress" });
    expect(delta.payload).toMatchObject({ kind: "assistant_delta", activitySource: "delta", progressKind: "assistant_delta" });
    expect(tool.payload).toMatchObject({ kind: "tool", activitySource: "tool", progressKind: "tool" });
  });

  it("preserves meaningful assistant delta whitespace while redacting secrets in mapped transcript rows", () => {
    const whitespace = mapAgentEventToRunActivityEvent({ type: "progress", activitySource: "delta", message: " " });
    const empty = mapAgentEventToRunActivityEvent({ type: "progress", activitySource: "delta", message: "" });
    const redacted = mapAgentEventToRunActivityEvent({ type: "progress", activitySource: "delta", message: " token=delta-value " });
    const acpWhitespace = mapAgentEventToRunActivityEvent({
      type: "progress",
      activitySource: "delta",
      message: "legacy fallback should not persist",
      runActivity: acpRunActivity({
        text: null,
        payload: { messagePreview: " ", textPreview: "", deltaPreview: "", message: "", text: "" },
      }),
    });

    expect(whitespace).toMatchObject({
      eventType: "progress",
      message: " ",
      payload: { kind: "assistant_delta", activitySource: "delta", progressKind: "assistant_delta", messagePreview: " " },
    });
    expect(empty).toMatchObject({
      eventType: "progress",
      message: "",
      payload: { kind: "assistant_delta", activitySource: "delta", progressKind: "assistant_delta", messagePreview: "" },
    });
    expect(redacted).toMatchObject({
      message: " token=[redacted] ",
      payload: { messagePreview: " token=[redacted] ", redacted: true },
    });
    expect(acpWhitespace).toMatchObject({
      eventType: "assistant_message_delta",
      message: " ",
      payload: {
        kind: "assistant_message_delta",
        actor: "assistant",
        channel: "chat",
        delta: true,
        messagePreview: " ",
        textPreview: " ",
        deltaPreview: "",
        message: "",
        text: "",
      },
    });
    const serialized = JSON.stringify([redacted, acpWhitespace]);
    expect(serialized).not.toContain("delta-value");
    expect(serialized).not.toContain("legacy fallback should not persist");
  });

  it("prefers valid harness-provided RunActivityEvent metadata for the shared persisted taxonomy", () => {
    const mapped = mapAgentEventToRunActivityEvent({
      type: "progress",
      activitySource: "delta",
      message: "legacy assistant chunk token=SECRET_LEGACY_TOKEN",
      runActivity: acpRunActivity({
        text: "assistant chunk token=SECRET_TEXT_TOKEN",
        payload: {
          delta: true,
          messagePreview: "assistant chunk token=SECRET_PAYLOAD_TOKEN",
          rawPayload: { token: "SECRET_RAW_TOKEN" },
          redacted: true,
        },
      }),
    });

    expect(mapped.eventType).toBe("assistant_message_delta");
    expect(mapped.payloadSchema).toBe(`${RUN_ACTIVITY_AGENT_EVENT_SCHEMA_PREFIX}.assistant_message_delta.v1`);
    expect(mapped.message).toBe("assistant chunk token=[redacted]");
    expect(mapped.payload).toMatchObject({
      kind: "assistant_message_delta",
      actor: "assistant",
      channel: "chat",
      protocol: "acp",
      harnessId: "hermes-acp",
      activityId: "run-1:activity:2",
      activitySessionId: "acp-session-1",
      runSessionId: "profile:acp-session-1:run-1",
      activitySequence: 2,
      sequenceSource: "harness",
      externalEventId: "upstream-2",
      delta: true,
      messagePreview: "assistant chunk token=[redacted]",
      textPreview: "assistant chunk token=[redacted]",
      redacted: true,
    });
    const serialized = JSON.stringify(mapped);
    expect(serialized).not.toContain("SECRET_");
    expect(serialized).not.toContain("rawPayload");
    expect(serialized).not.toContain("SECRET_RAW_TOKEN");
    expect(serialized).not.toContain("legacy assistant chunk");
  });

  it("maps command policy decisions into schema-tagged redacted transcript events", () => {
    const activity = commandPolicyRunActivity();
    const mapped = mapAgentEventToRunActivityEvent({
      type: "progress",
      activitySource: "tool",
      message: "legacy command policy fallback token=SECRET_LEGACY_TOKEN",
      runActivity: activity,
    });
    const durable = mapRunActivityEventToTranscriptEvent(activity, { runId: "run-1", source: "harness" });

    expect(mapped.eventType).toBe("command_policy_decision");
    expect(mapped.payloadSchema).toBe(`${RUN_ACTIVITY_AGENT_EVENT_SCHEMA_PREFIX}.command_policy_decision.v1`);
    expect(mapped.message).not.toContain("SECRET_TEXT_TOKEN");
    expect(mapped.message).toContain("[redacted]");
    expect(mapped.payload).toMatchObject({
      kind: "command_policy_decision",
      actor: "harness",
      channel: "diagnostic",
      protocol: "symphony",
      harnessId: "hermes-command-policy",
      activityId: "run-1:policy:1",
      runSessionId: "run-1:policy-session",
      activitySequence: 8,
      sequenceSource: "symphony",
      decisionId: "policy-decision-1",
      attemptId: "tool-call-1",
      surface: "terminal_execute",
      role: "worker",
      phase: "implementation",
      outcome: "deny",
      reasonKind: "upstream_github",
      commandClass: "direct_upstream_git_operation",
      upstreamContactAttempted: false,
      redacted: true,
      audit: {
        redacted: true,
        surface: "terminal_execute",
        role: "worker",
        phase: "implementation",
        outcome: "deny",
        reasonKind: "upstream_github",
        commandClass: "direct_upstream_git_operation",
        upstreamContactAttempted: false,
        targetHosts: ["github.com"],
      },
      normalizedCommand: {
        executable: "git",
        executableKind: "git",
        gitSubcommand: "push",
        targetHosts: ["github.com"],
      },
    });
    expect(durable).toMatchObject({
      runId: "run-1",
      sequence: 8,
      at: "2026-06-01T12:00:00.000Z",
      source: "harness",
      eventType: "command_policy_decision",
      payloadSchema: `${RUN_ACTIVITY_AGENT_EVENT_SCHEMA_PREFIX}.command_policy_decision.v1`,
      payload: {
        kind: "command_policy_decision",
        activityId: "run-1:policy:1",
        outcome: "deny",
        reasonKind: "upstream_github",
        upstreamContactAttempted: false,
      },
    });
    const serialized = JSON.stringify([mapped, durable]);
    expect(serialized).not.toContain("SECRET_");
    expect(serialized).not.toContain("rawPayload");
    expect(serialized).not.toContain("legacy command policy fallback");
  });

  it("maps ACP user replay and reasoning chunks without coercing them into assistant message deltas", () => {
    const userReplay = mapAgentEventToRunActivityEvent({
      type: "progress",
      activitySource: "stream",
      message: "Hermes ACP user message replay",
      runActivity: {
        eventId: "run-1:activity:3",
        runSessionId: "profile:acp-session-1:run-1",
        occurredAt: "2026-05-31T00:00:03.000Z",
        sequence: 3,
        sequenceSource: "harness",
        externalEventId: "upstream-3",
        protocol: "acp",
        harness: "hermes-acp",
        actor: "user",
        channel: "chat",
        kind: "user_message_submitted",
        text: "Do work token=SECRET_USER_TOKEN",
        payload: { runtimeSessionId: "acp-session-1", replay: true, messagePreview: "Do work token=SECRET_USER_TOKEN" },
      },
    });
    const reasoning = mapAgentEventToRunActivityEvent({
      type: "progress",
      activitySource: "stream",
      message: "Hermes ACP thought update",
      runActivity: acpRunActivity({
        eventId: "run-1:activity:4",
        sequence: 4,
        externalEventId: "upstream-4",
        kind: "assistant_reasoning_delta",
        text: "Hermes ACP thought update",
        payload: { runtimeSessionId: "acp-session-1", delta: true, reasoning: true, messagePreview: "private thought token=SECRET_THOUGHT_TOKEN" },
      }),
    });

    expect(userReplay).toMatchObject({
      eventType: "user_message_submitted",
      message: "Do work token=[redacted]",
      payload: {
        kind: "user_message_submitted",
        actor: "user",
        channel: "chat",
        replay: true,
        messagePreview: "Do work token=[redacted]",
        textPreview: "Do work token=[redacted]",
        redacted: true,
      },
    });
    expect(reasoning).toMatchObject({
      eventType: "assistant_reasoning_delta",
      message: "Hermes ACP thought update",
      payload: {
        kind: "assistant_reasoning_delta",
        actor: "assistant",
        channel: "chat",
        delta: true,
        reasoning: true,
        messagePreview: "private thought token=[redacted]",
        textPreview: "Hermes ACP thought update",
        redacted: true,
      },
    });
    expect([userReplay.eventType, reasoning.eventType]).not.toEqual(expect.arrayContaining(["assistant_message_delta"]));
    const serialized = JSON.stringify([userReplay, reasoning]);
    expect(serialized).not.toContain("SECRET_USER_TOKEN");
    expect(serialized).not.toContain("SECRET_THOUGHT_TOKEN");
  });

  it("falls back to legacy AgentEvent mapping when harness-provided activity metadata is malformed", () => {
    const malformedActivity = { ...acpRunActivity(), channel: "message" } as unknown as RunActivityEvent;

    const mapped = mapAgentEventToRunActivityEvent({
      type: "progress",
      activitySource: "delta",
      message: "legacy assistant chunk",
      runActivity: malformedActivity,
    });

    expect(mapped.eventType).toBe("progress");
    expect(mapped.payload).toMatchObject({ kind: "assistant_delta", activitySource: "delta", progressKind: "assistant_delta" });
  });

  it("redacts secrets, marks truncated previews, and omits raw protocol fields from frontend payloads", () => {
    const longSecret = `${"x".repeat(560)} SECRET_LONG_TOKEN`;
    const diagnostic = mapAgentEventToRunActivityEvent({
      type: "run_diagnostic",
      code: "hermes_gateway_error",
      message: longSecret,
      payload: {
        message: "safe diagnostic metadata",
        protocolPayload: { raw: "json-rpc body", apiKey: "SECRET_DIAGNOSTIC_KEY" },
        nested: { rpcError: { token: "SECRET_RPC_TOKEN" }, retained: "yes" },
      },
    });

    expect(diagnostic.payloadTruncated).toBe(true);
    expect(diagnostic.message).toContain("...[truncated]");
    const serialized = JSON.stringify(diagnostic);
    expect(serialized).toContain("safe diagnostic metadata");
    expect(serialized).toContain("retained");
    expect(serialized).not.toContain("SECRET_LONG_TOKEN");
    expect(serialized).not.toContain("SECRET_DIAGNOSTIC_KEY");
    expect(serialized).not.toContain("SECRET_RPC_TOKEN");
    expect(serialized).not.toContain("protocolPayload");
    expect(serialized).not.toContain("rpcError");
    expect(serialized).not.toContain("json-rpc body");
  });
});

function commandPolicyRunActivity(overrides: Partial<RunActivityEvent> = {}): RunActivityEvent {
  const payload =
    overrides.payload && typeof overrides.payload === "object" && !Array.isArray(overrides.payload) ? overrides.payload : {};
  const commandPolicyPayload = {
    runtimeSessionId: "policy-session-1",
    redacted: true,
    decisionId: "policy-decision-1",
    attemptId: "tool-call-1",
    runId: "run-1",
    issueId: "issue-1",
    surface: "terminal_execute",
    role: "worker",
    phase: "implementation",
    outcome: "deny",
    reasonKind: "upstream_github",
    commandClass: "direct_upstream_git_operation",
    message: "Blocked worker/reviewer upstream GitHub contact: token=SECRET_MESSAGE_TOKEN",
    upstreamContactAttempted: false,
    requiresCodeChange: false,
    requiresUserOrServiceFix: true,
    normalizedCommand: {
      executable: "git",
      executableKind: "git",
      argumentsPreview: "push https://[redacted]@github.com/owner/repo.git",
      gitSubcommand: "push",
      targetHosts: ["github.com"],
      hasNestedCommand: false,
      hasInlineEnvironment: false,
      hasUnsafeGitConfig: false,
    },
    audit: {
      redacted: true,
      surface: "terminal_execute",
      role: "worker",
      phase: "implementation",
      outcome: "deny",
      reasonKind: "upstream_github",
      commandClass: "direct_upstream_git_operation",
      inlineEnvironmentKeys: [],
      unsafeConfigCategories: [],
      upstreamContactAttempted: false,
      rawInputPreview: "git push https://SECRET_AUDIT_TOKEN@github.com/owner/repo.git",
      rawInputPreviewTruncated: false,
      rawInputPreviewRedacted: true,
      normalizedExecutable: "git",
      executableKind: "git",
      gitSubcommand: "push",
      commandPreview: "git push https://[redacted]@github.com/owner/repo.git",
      targetHosts: ["github.com"],
      inheritedEnvironmentKeys: ["HOME", "PATH"],
    },
    rawPayload: { token: "SECRET_RAW_TOKEN" },
    ...(payload as Record<string, unknown>),
  } as RunActivityCommandPolicyDecisionPayload;
  return {
    eventId: "run-1:policy:1",
    runSessionId: "run-1:policy-session",
    occurredAt: "2026-06-01T12:00:00.000Z",
    sequence: 8,
    sequenceSource: "symphony",
    protocol: "symphony",
    harness: "hermes-command-policy",
    actor: "harness",
    channel: "diagnostic",
    kind: "command_policy_decision",
    text: "Blocked worker/reviewer upstream GitHub contact: token=SECRET_TEXT_TOKEN",
    ...overrides,
    payload: commandPolicyPayload,
  } as RunActivityEvent;
}

function acpRunActivity(overrides: Partial<RunActivityEvent> = {}): RunActivityEvent {
  const payload =
    overrides.payload && typeof overrides.payload === "object" && !Array.isArray(overrides.payload) ? overrides.payload : {};
  return {
    eventId: "run-1:activity:2",
    runSessionId: "profile:acp-session-1:run-1",
    occurredAt: "2026-05-31T00:00:02.000Z",
    sequence: 2,
    sequenceSource: "harness",
    externalEventId: "upstream-2",
    protocol: "acp",
    harness: "hermes-acp",
    actor: "assistant",
    channel: "chat",
    kind: "assistant_message_delta",
    text: "assistant chunk",
    ...overrides,
    payload: { runtimeSessionId: "acp-session-1", delta: true, messagePreview: "assistant chunk", redacted: true, ...payload },
  } as RunActivityEvent;
}

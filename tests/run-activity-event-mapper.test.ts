import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/core/harness/AgentHarness.js";
import { mapAgentEventToRunActivityEvent, RUN_ACTIVITY_AGENT_EVENT_SCHEMA_PREFIX } from "../src/core/transcript/RunActivityEventMapper.js";

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

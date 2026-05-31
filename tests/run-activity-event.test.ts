import { describe, expect, it } from "vitest";
import {
  RUN_ACTIVITY_ACTORS,
  RUN_ACTIVITY_CHANNELS,
  RUN_ACTIVITY_KIND_BY_CHANNEL,
  isRunActivityActor,
  isRunActivityActorForChannel,
  isRunActivityChannel,
  isRunActivityKind,
  isRunActivityKindForChannel,
} from "../src/core/runActivity/RunActivityEvent.js";
import type {
  RunActivityActorForChannel,
  RunActivityEvent,
  RunActivityKindForChannel,
} from "../src/core/runActivity/RunActivityEvent.js";
import type { RunActivityEvent as PublicRunActivityEvent } from "../src/index.js";

const typedToolActivity = {
  id: "activity-tool-1",
  runId: "run-1",
  sessionId: "session-1",
  at: "2026-05-31T00:00:00.000Z",
  sequence: 3,
  harnessId: "runtime-adapter",
  actor: "tool",
  channel: "tool",
  kind: "tool_call_completed",
  text: "tool completed",
  payload: { toolCallId: "call-1", toolName: "execute", status: "succeeded" },
} satisfies RunActivityEvent;

const typedRateLimitActivity = {
  id: "activity-limit-1",
  runId: "run-1",
  sessionId: "session-1",
  at: "2026-05-31T00:00:01.000Z",
  harnessId: "runtime-adapter",
  actor: "provider",
  channel: "rate_limit",
  kind: "provider_limit_detected",
  text: "provider limit detected",
  payload: { providerId: "provider", model: "model", limitKind: "transient_rate_limit" },
} satisfies PublicRunActivityEvent;

const typedTerminalActivity = {
  id: "activity-terminal-1",
  runId: "run-1",
  sessionId: null,
  at: "2026-05-31T00:00:02.000Z",
  harnessId: "runtime-adapter",
  actor: "orchestrator",
  channel: "terminal",
  kind: "run_cancelled",
  text: "run cancelled",
  payload: { reason: "run_cancelled", cancellationSource: "operator" },
} satisfies RunActivityEvent;

const toolKind: RunActivityKindForChannel<"tool"> = "tool_call_started";
const statusActor: RunActivityActorForChannel<"status"> = "runtime";
void [typedToolActivity, typedRateLimitActivity, typedTerminalActivity, toolKind, statusActor];

// @ts-expect-error Message kinds are not valid tool-channel kinds.
const invalidToolKind: RunActivityKindForChannel<"tool"> = "assistant_message_delta";
void invalidToolKind;

// @ts-expect-error Assistant actors do not emit rate-limit channel events in the normalized taxonomy.
const invalidRateLimitActor: RunActivityActorForChannel<"rate_limit"> = "assistant";
void invalidRateLimitActor;

// @ts-expect-error The discriminated event union rejects channel/kind mismatches.
const invalidKindChannelEvent: RunActivityEvent = {
  id: "activity-invalid-kind-channel",
  runId: "run-1",
  sessionId: "session-1",
  at: "2026-05-31T00:00:03.000Z",
  harnessId: "runtime-adapter",
  actor: "tool",
  channel: "tool",
  kind: "assistant_message_delta",
  text: null,
  payload: {},
};
void invalidKindChannelEvent;

// @ts-expect-error The discriminated event union rejects channel/actor mismatches.
const invalidActorChannelEvent: RunActivityEvent = {
  id: "activity-invalid-actor-channel",
  runId: "run-1",
  sessionId: "session-1",
  at: "2026-05-31T00:00:04.000Z",
  harnessId: "runtime-adapter",
  actor: "assistant",
  channel: "rate_limit",
  kind: "provider_limit_detected",
  text: null,
  payload: {},
};
void invalidActorChannelEvent;

describe("RunActivityEvent taxonomy", () => {
  it("exposes complete neutral actor, channel, and kind sets", () => {
    expect(RUN_ACTIVITY_ACTORS).toContain("assistant");
    expect(RUN_ACTIVITY_ACTORS).toContain("provider");
    expect(RUN_ACTIVITY_CHANNELS).toEqual(["lifecycle", "message", "tool", "status", "token", "rate_limit", "terminal"]);
    expect(Object.keys(RUN_ACTIVITY_KIND_BY_CHANNEL).sort()).toEqual([...RUN_ACTIVITY_CHANNELS].sort());
    expect(RUN_ACTIVITY_KIND_BY_CHANNEL.lifecycle).toContain("session_started");
    expect(RUN_ACTIVITY_KIND_BY_CHANNEL.message).toContain("assistant_message_delta");
    expect(RUN_ACTIVITY_KIND_BY_CHANNEL.message).toContain("assistant_reasoning_delta");
    expect(RUN_ACTIVITY_KIND_BY_CHANNEL.tool).toContain("tool_call_started");
    expect(RUN_ACTIVITY_KIND_BY_CHANNEL.tool).toContain("tool_permission_requested");
    expect(RUN_ACTIVITY_KIND_BY_CHANNEL.status).toContain("runtime_diagnostic");
    expect(RUN_ACTIVITY_KIND_BY_CHANNEL.status).toContain("available_commands_update");
    expect(RUN_ACTIVITY_KIND_BY_CHANNEL.status).toContain("mode_update");
    expect(RUN_ACTIVITY_KIND_BY_CHANNEL.token).toContain("token_usage_reported");
    expect(RUN_ACTIVITY_KIND_BY_CHANNEL.rate_limit).toContain("provider_limit_detected");
    expect(RUN_ACTIVITY_KIND_BY_CHANNEL.terminal).toContain("run_failed");
    expect(RUN_ACTIVITY_KIND_BY_CHANNEL.terminal).toContain("run_cancelled");
  });

  it("keeps protocol method names out of frontend-facing taxonomy values", () => {
    const taxonomyValues = [
      ...RUN_ACTIVITY_ACTORS,
      ...RUN_ACTIVITY_CHANNELS,
      ...Object.values(RUN_ACTIVITY_KIND_BY_CHANNEL).flat(),
    ];

    for (const value of taxonomyValues) {
      expect(value).not.toMatch(/\bacp\b/i);
      expect(value).not.toMatch(/json[-_]?rpc/i);
      expect(value).not.toMatch(/\//);
      expect(value).not.toMatch(/\./);
      expect(value).not.toMatch(/^session_update$/i);
    }
  });

  it("guards unknown actor, channel, kind, and channel-specific combinations", () => {
    expect(isRunActivityActor("assistant")).toBe(true);
    expect(isRunActivityActor("jsonrpc")).toBe(false);
    expect(isRunActivityChannel("tool")).toBe(true);
    expect(isRunActivityChannel("chat")).toBe(false);
    expect(isRunActivityKind("tool_call_completed")).toBe(true);
    expect(isRunActivityKind("session/update")).toBe(false);
    expect(isRunActivityKindForChannel("tool", "tool_call_completed")).toBe(true);
    expect(isRunActivityKindForChannel("tool", "assistant_message_delta")).toBe(false);
    expect(isRunActivityActorForChannel("rate_limit", "provider")).toBe(true);
    expect(isRunActivityActorForChannel("rate_limit", "assistant")).toBe(false);
  });
});

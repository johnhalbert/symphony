import { describe, expect, it } from "vitest";
import {
  RUN_ACTIVITY_ADAPTER_ORDERING_PROFILES,
  RUN_ACTIVITY_ACTORS,
  RUN_ACTIVITY_CHANNELS,
  RUN_ACTIVITY_KIND_BY_CHANNEL,
  applyRunActivityOrdering,
  compareRunActivityEvents,
  createRunActivityOrderingState,
  deriveRunActivityRunSessionId,
  isRunActivityActor,
  isRunActivityActorForChannel,
  isRunActivityChannel,
  isRunActivityKind,
  isRunActivityKindForChannel,
  runActivityIdempotencyKeys,
} from "../src/core/runActivity/RunActivityEvent.js";
import type {
  RunActivityActorForChannel,
  RunActivityEvent,
  RunActivityEventInput,
  RunActivityKindForChannel,
  RunActivityOrderingState,
} from "../src/core/runActivity/RunActivityEvent.js";
import type { RunActivityEvent as PublicRunActivityEvent } from "../src/index.js";

const typedToolActivity = {
  id: "activity-tool-1",
  runId: "run-1",
  sessionId: "session-1",
  runSessionId: "run-1:session-1",
  at: "2026-05-31T00:00:00.000Z",
  sequence: 3,
  sequenceSource: "harness",
  externalEventId: "jsonrpc-activity-tool-1",
  protocol: "json_rpc",
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
  runSessionId: "run-1:session-1",
  at: "2026-05-31T00:00:01.000Z",
  sequence: 4,
  sequenceSource: "symphony",
  protocol: "acp",
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
  runSessionId: "run-1",
  at: "2026-05-31T00:00:02.000Z",
  sequence: 5,
  sequenceSource: "harness",
  protocol: "symphony",
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
  runSessionId: "run-1:session-1",
  at: "2026-05-31T00:00:03.000Z",
  sequence: 6,
  sequenceSource: "harness",
  protocol: "json_rpc",
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
  runSessionId: "run-1:session-1",
  at: "2026-05-31T00:00:04.000Z",
  sequence: 7,
  sequenceSource: "harness",
  protocol: "json_rpc",
  harnessId: "runtime-adapter",
  actor: "assistant",
  channel: "rate_limit",
  kind: "provider_limit_detected",
  text: null,
  payload: {},
};
void invalidActorChannelEvent;

function statusActivityInput(overrides: Record<string, unknown> = {}): RunActivityEventInput {
  return {
    id: "activity-status-1",
    runId: "run-order",
    sessionId: "session-order",
    at: "2026-05-31T00:00:00.000Z",
    harnessId: "runtime-adapter",
    actor: "runtime",
    channel: "status",
    kind: "runtime_log",
    text: "runtime event",
    payload: {},
    protocol: "json_rpc",
    ...overrides,
  } as RunActivityEventInput;
}

function terminalActivityInput(overrides: Record<string, unknown> = {}): RunActivityEventInput {
  return statusActivityInput({
    id: "activity-terminal-order",
    actor: "orchestrator",
    channel: "terminal",
    kind: "run_succeeded",
    text: "run succeeded",
    payload: { reason: "run_succeeded" },
    protocol: "symphony",
    ...overrides,
  });
}

function accepted(result: ReturnType<typeof applyRunActivityOrdering>) {
  if (result.status !== "accepted") throw new Error(`expected accepted result, got ${result.status}`);
  return result;
}

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

  it("defines adapter-agnostic ordering profiles for JSON-RPC and ACP sources", () => {
    expect(RUN_ACTIVITY_ADAPTER_ORDERING_PROFILES.json_rpc).toMatchObject({
      protocol: "json_rpc",
      sequenceRule: "preserve_positive_integer_or_assign_next",
      externalEventIdRule: "preserve_when_available_optional_otherwise",
      terminalRule: "first_terminal_wins_backfill_before_terminal_allowed",
    });
    expect(RUN_ACTIVITY_ADAPTER_ORDERING_PROFILES.acp).toMatchObject({
      protocol: "acp",
      sequenceRule: "preserve_positive_integer_or_assign_next",
      externalEventIdRule: "preserve_when_available_optional_otherwise",
    });
    expect(deriveRunActivityRunSessionId(statusActivityInput({ runSessionId: " explicit-scope " }))).toBe("explicit-scope");
    expect(deriveRunActivityRunSessionId(statusActivityInput({ runSessionId: null }))).toBe("run-order:session-order");
    expect(deriveRunActivityRunSessionId(statusActivityInput({ sessionId: null, runSessionId: null }))).toBe("run-order");
  });

  it("assigns missing sequences and exposes stable idempotency keys", () => {
    const result = accepted(
      applyRunActivityOrdering(
        statusActivityInput({ id: "activity-missing-sequence", sequence: null, externalEventId: " upstream-event-1 " }),
      ),
    );

    expect(result.event).toMatchObject({
      runSessionId: "run-order:session-order",
      sequence: 1,
      sequenceSource: "symphony",
      externalEventId: "upstream-event-1",
      protocol: "json_rpc",
    });
    expect(result.state).toMatchObject({
      runSessionId: "run-order:session-order",
      highWatermark: 1,
      terminalSequence: null,
      eventIds: ["activity-missing-sequence"],
      externalEventIds: ["upstream-event-1"],
      sequences: [1],
    });
    expect(runActivityIdempotencyKeys(result.event)).toEqual([
      "event_id:activity-missing-sequence",
      "run_sequence:run-order:session-order:1",
      "external_event_id:run-order:session-order:upstream-event-1",
    ]);
  });

  it("deduplicates by event id, external event id, and runSessionId sequence", () => {
    let state: RunActivityOrderingState = createRunActivityOrderingState("run-order:session-order");
    const first = accepted(
      applyRunActivityOrdering(
        statusActivityInput({ id: "activity-unique", sequence: 1, externalEventId: "upstream-unique" }),
        state,
      ),
    );
    state = first.state;

    expect(applyRunActivityOrdering(statusActivityInput({ id: "activity-unique", sequence: 2 }), state)).toMatchObject({
      status: "duplicate",
      reason: "event_id",
      state,
    });
    expect(
      applyRunActivityOrdering(statusActivityInput({ id: "activity-new-id", sequence: 2, externalEventId: "upstream-unique" }), state),
    ).toMatchObject({ status: "duplicate", reason: "external_event_id", state });
    expect(
      applyRunActivityOrdering(statusActivityInput({ id: "activity-new-sequence-conflict", sequence: 1, externalEventId: "upstream-new" }), state),
    ).toMatchObject({ status: "duplicate", reason: "sequence", state });
  });

  it("preserves out-of-order harness sequences for durable and realtime ordering", () => {
    let state: RunActivityOrderingState = createRunActivityOrderingState("run-order:session-order");
    const first = accepted(applyRunActivityOrdering(statusActivityInput({ id: "activity-1", sequence: 1 }), state));
    state = first.state;
    const third = accepted(applyRunActivityOrdering(statusActivityInput({ id: "activity-3", sequence: 3 }), state));
    state = third.state;
    const second = accepted(applyRunActivityOrdering(statusActivityInput({ id: "activity-2", sequence: 2 }), state));
    state = second.state;

    expect(state.highWatermark).toBe(3);
    expect([third.event, first.event, second.event].sort(compareRunActivityEvents).map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(second.event.sequenceSource).toBe("harness");
  });

  it("makes the first terminal event authoritative while allowing explicit pre-terminal replay backfill", () => {
    let state: RunActivityOrderingState = createRunActivityOrderingState("run-order:session-order");
    state = accepted(applyRunActivityOrdering(statusActivityInput({ id: "activity-before-terminal", sequence: 1 }), state)).state;
    const terminal = accepted(applyRunActivityOrdering(terminalActivityInput({ id: "activity-terminal", sequence: 3 }), state));
    state = terminal.state;

    expect(state.terminalSequence).toBe(3);
    expect(applyRunActivityOrdering(terminalActivityInput({ id: "activity-terminal", sequence: 3 }), state)).toMatchObject({
      status: "duplicate",
      reason: "event_id",
      state,
    });
    expect(applyRunActivityOrdering(statusActivityInput({ id: "activity-after-terminal-missing", sequence: null }), state)).toMatchObject({
      status: "rejected",
      reason: "terminal_already_accepted",
      state,
    });
    expect(applyRunActivityOrdering(statusActivityInput({ id: "activity-after-terminal", sequence: 4 }), state)).toMatchObject({
      status: "rejected",
      reason: "terminal_already_accepted",
      state,
    });
    expect(applyRunActivityOrdering(terminalActivityInput({ id: "activity-second-terminal-earlier", sequence: 2 }), state)).toMatchObject({
      status: "rejected",
      reason: "terminal_already_accepted",
      state,
    });

    const backfill = accepted(applyRunActivityOrdering(statusActivityInput({ id: "activity-before-terminal-backfill", sequence: 2 }), state));
    expect(backfill.state).toMatchObject({ highWatermark: 3, terminalSequence: 3, sequences: [1, 3, 2] });
    expect(applyRunActivityOrdering(terminalActivityInput({ id: "activity-second-terminal", sequence: 2 }), backfill.state)).toMatchObject({
      status: "duplicate",
      reason: "sequence",
    });
  });
});

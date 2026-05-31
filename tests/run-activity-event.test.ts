import { describe, expect, it } from "vitest";
import {
  RUN_ACTIVITY_ACTORS,
  RUN_ACTIVITY_ACTORS_BY_CHANNEL,
  RUN_ACTIVITY_ADAPTER_ORDERING_PROFILES,
  RUN_ACTIVITY_CHANNEL_ALIASES,
  RUN_ACTIVITY_CHANNELS,
  RUN_ACTIVITY_KIND_BY_CHANNEL,
  applyRunActivityOrdering,
  compareRunActivityEvents,
  createRunActivityOrderingState,
  dedupeRunActivityEvents,
  deriveRunActivityRunSessionId,
  isRunActivityActor,
  isRunActivityActorForChannel,
  isRunActivityChannel,
  isRunActivityChannelAlias,
  isRunActivityChannelInput,
  isRunActivityEvent,
  isRunActivityKind,
  isRunActivityKindForChannel,
  normalizeRunActivityChannel,
  runActivityEventIdentityKey,
  runActivityIdempotencyKeys,
  sortRunActivityEvents,
} from "../src/core/runActivity/RunActivityEvent.js";
import type {
  RunActivityActorForChannel,
  RunActivityEvent,
  RunActivityEventForChannel,
  RunActivityEventInput,
  RunActivityEventOrderingFields,
  RunActivityKindForChannel,
  RunActivityOrderingState,
} from "../src/core/runActivity/RunActivityEvent.js";
import type { RunActivityEvent as PublicRunActivityEvent } from "../src/index.js";

const typedChatActivity = {
  eventId: "activity-chat-1",
  runSessionId: "run-session-1",
  occurredAt: "2026-05-31T00:00:00.000Z",
  sequence: 2,
  harness: "runtime-adapter",
  actor: "assistant",
  channel: "chat",
  kind: "assistant_message_delta",
  text: "assistant delta",
  payload: { runtimeSessionId: "runtime-session-1", messageId: "msg-1", delta: true, redacted: true },
} satisfies RunActivityEventForChannel<"chat">;

const typedToolActivity = {
  eventId: "activity-tool-1",
  runSessionId: "run-session-1",
  occurredAt: "2026-05-31T00:00:01.000Z",
  sequence: 3,
  harness: "runtime-adapter",
  actor: "tool",
  channel: "tool",
  kind: "tool_call_completed",
  text: "tool completed",
  payload: { runtimeSessionId: "runtime-session-1", toolCallId: "call-1", toolName: "execute", status: "succeeded" },
} satisfies RunActivityEvent;

const typedDiagnosticActivity = {
  eventId: "activity-diagnostic-1",
  runSessionId: "run-session-1",
  occurredAt: "2026-05-31T00:00:01.500Z",
  sequence: 4,
  harness: "runtime-adapter",
  actor: "runtime",
  channel: "diagnostic",
  kind: "runtime_status_update",
  text: "runtime is working",
  payload: { runtimeSessionId: "runtime-session-1", status: "working" },
} satisfies RunActivityEventForChannel<"diagnostic">;

const typedRateLimitActivity = {
  eventId: "activity-limit-1",
  runSessionId: "run-session-1",
  occurredAt: "2026-05-31T00:00:02.000Z",
  harness: "runtime-adapter",
  actor: "provider",
  channel: "rate_limit",
  kind: "provider_limit_detected",
  text: "provider limit detected",
  payload: { runtimeSessionId: "runtime-session-1", providerId: "provider", model: "model", limitKind: "transient_rate_limit" },
} satisfies PublicRunActivityEvent;

const typedTerminalActivity = {
  eventId: "activity-terminal-1",
  runSessionId: "run-session-1",
  occurredAt: "2026-05-31T00:00:03.000Z",
  harness: "runtime-adapter",
  actor: "orchestrator",
  channel: "terminal",
  kind: "run_cancelled",
  text: "run cancelled",
  payload: { reason: "run_cancelled", cancellationSource: "operator" },
} satisfies RunActivityEvent;

const toolKind: RunActivityKindForChannel<"tool"> = "tool_call_started";
const diagnosticActor: RunActivityActorForChannel<"diagnostic"> = "runtime";
void [typedChatActivity, typedToolActivity, typedDiagnosticActivity, typedRateLimitActivity, typedTerminalActivity, toolKind, diagnosticActor];

// @ts-expect-error Chat kinds are not valid tool-channel kinds.
const invalidToolKind: RunActivityKindForChannel<"tool"> = "assistant_message_delta";
void invalidToolKind;

// @ts-expect-error Assistant actors do not emit rate-limit channel events in the normalized taxonomy.
const invalidRateLimitActor: RunActivityActorForChannel<"rate_limit"> = "assistant";
void invalidRateLimitActor;

// @ts-expect-error The discriminated event union rejects channel/kind mismatches.
const invalidKindChannelEvent: RunActivityEvent = {
  eventId: "activity-invalid-kind-channel",
  runSessionId: "run-session-1",
  occurredAt: "2026-05-31T00:00:04.000Z",
  harness: "runtime-adapter",
  actor: "tool",
  channel: "tool",
  kind: "assistant_message_delta",
  text: null,
  payload: {},
};
void invalidKindChannelEvent;

// @ts-expect-error The discriminated event union rejects channel/actor mismatches.
const invalidActorChannelEvent: RunActivityEvent = {
  eventId: "activity-invalid-actor-channel",
  runSessionId: "run-session-1",
  occurredAt: "2026-05-31T00:00:05.000Z",
  harness: "runtime-adapter",
  actor: "assistant",
  channel: "rate_limit",
  kind: "provider_limit_detected",
  text: null,
  payload: {},
};
void invalidActorChannelEvent;

type HermesGatewayEventFixture =
  | { payload?: { rendered?: string; text?: string }; session_id?: string; type: "message.delta" }
  | { payload: { args_text?: string; name?: string; tool_id: string }; session_id?: string; type: "tool.start" }
  | {
      payload: { error?: string; name?: string; result_text?: string; summary?: string; tool_id: string };
      session_id?: string;
      type: "tool.complete";
    }
  | { payload?: { kind?: string; text?: string }; session_id?: string; type: "status.update" }
  | {
      payload: {
        kind?: string;
        message?: string;
        model?: string | null;
        provider_id?: string | null;
        resume_at?: string | null;
        window_kind?: string | null;
      };
      session_id?: string;
      type: "provider.limit";
    }
  | {
      payload?: {
        status?: string;
        text?: string;
        usage?: { input?: number; output?: number; total?: number };
      };
      session_id?: string;
      type: "message.complete";
    };

interface HermesJsonRpcEventFixture {
  jsonrpc: "2.0";
  method: "gateway/event";
  params: HermesGatewayEventFixture;
}

type AcpJsonRpcFixture =
  | {
      jsonrpc: "2.0";
      method: "session/update";
      params: {
        sessionId: string;
        update: {
          available_commands: { description?: string; name: string }[];
          session_update: "available_commands_update";
        };
      };
    }
  | {
      jsonrpc: "2.0";
      method: "session/update";
      params: {
        sessionId: string;
        update: {
          session_update: "usage_update";
          size: number;
          used: number;
        };
      };
    }
  | {
      id: number;
      jsonrpc: "2.0";
      method: "session/set_mode";
      params: {
        modeId: string;
        sessionId: string;
      };
    };

interface MappingBase {
  eventId: string;
  harness: string;
  occurredAt: string;
  runSessionId: string;
  sequence?: number | null;
}

function baseFields(base: MappingBase, sequenceOffset = 0): RunActivityEventOrderingFields {
  return {
    eventId: sequenceOffset === 0 ? base.eventId : `${base.eventId}-${sequenceOffset + 1}`,
    runSessionId: base.runSessionId,
    occurredAt: base.occurredAt,
    harness: base.harness,
    ...(base.sequence === undefined ? {} : { sequence: base.sequence === null ? null : base.sequence + sequenceOffset }),
  };
}

function mapHermesJsonRpcFixture(fixture: HermesJsonRpcEventFixture, base: MappingBase): RunActivityEvent[] {
  const event = fixture.params;
  const runtimeSessionId = event.session_id ?? null;
  switch (event.type) {
    case "message.delta":
      return [
        {
          ...baseFields(base),
          actor: "assistant",
          channel: "chat",
          kind: "assistant_message_delta",
          text: textOrNull(event.payload?.text ?? event.payload?.rendered),
          payload: { runtimeSessionId, delta: true, redacted: true },
        },
      ];
    case "tool.start":
      return [
        {
          ...baseFields(base),
          actor: "tool",
          channel: "tool",
          kind: "tool_call_started",
          text: `Tool ${event.payload.name ?? "unknown"} started`,
          payload: {
            runtimeSessionId,
            toolCallId: event.payload.tool_id,
            toolName: event.payload.name ?? null,
            status: "running",
            inputPreview: event.payload.args_text ?? null,
            redacted: true,
          },
        },
      ];
    case "tool.complete":
      return [
        {
          ...baseFields(base),
          actor: "tool",
          channel: "tool",
          kind: event.payload.error ? "tool_call_failed" : "tool_call_completed",
          text: `Tool ${event.payload.name ?? "unknown"} ${event.payload.error ? "failed" : "completed"}`,
          payload: {
            runtimeSessionId,
            toolCallId: event.payload.tool_id,
            toolName: event.payload.name ?? null,
            status: event.payload.error ? "failed" : "succeeded",
            outputPreview: event.payload.result_text ?? event.payload.summary ?? null,
            errorPreview: event.payload.error ?? null,
            redacted: true,
          },
        },
      ];
    case "status.update":
      return [
        {
          ...baseFields(base),
          actor: "runtime",
          channel: "diagnostic",
          kind: "runtime_status_update",
          text: textOrNull(event.payload?.text ?? event.payload?.kind),
          payload: { runtimeSessionId, status: event.payload?.kind ?? null },
        },
      ];
    case "provider.limit":
      return [
        {
          ...baseFields(base),
          actor: "provider",
          channel: "rate_limit",
          kind: "provider_limit_detected",
          text: event.payload.message ?? "Provider limit detected",
          payload: {
            runtimeSessionId,
            providerId: event.payload.provider_id ?? null,
            model: event.payload.model ?? null,
            limitKind: event.payload.kind ?? null,
            resumePolicy: event.payload.resume_at ? "auto_at_window_close" : "manual",
            window: {
              resumeAt: event.payload.resume_at ?? null,
              windowKind: event.payload.window_kind ?? null,
            },
          },
        },
      ];
    case "message.complete": {
      const usage = event.payload?.usage;
      const terminalKind = event.payload?.status === "interrupted" ? "run_cancelled" : event.payload?.status === "error" ? "run_failed" : "run_succeeded";
      const terminalText = terminalKind === "run_succeeded" ? event.payload?.text ?? "Run completed" : event.payload?.text ?? terminalKind;
      const events: RunActivityEvent[] = [];
      if (usage) {
        events.push({
          ...baseFields(base),
          eventId: `${base.eventId}-usage`,
          actor: "runtime",
          channel: "token",
          kind: "token_usage_reported",
          text: "Token usage reported",
          payload: {
            runtimeSessionId,
            usageSource: "stream",
            ...(usage.input === undefined ? {} : { inputTokens: usage.input }),
            ...(usage.output === undefined ? {} : { outputTokens: usage.output }),
            ...(usage.total === undefined ? {} : { totalTokens: usage.total }),
          },
        });
      }
      events.push({
        ...baseFields(base, usage ? 1 : 0),
        eventId: `${base.eventId}-terminal`,
        actor: "runtime",
        channel: "terminal",
        kind: terminalKind,
        text: terminalText,
        payload: {
          runtimeSessionId,
          reason: terminalKind,
          ...(terminalKind === "run_failed" ? { error: terminalText } : {}),
          ...(terminalKind === "run_cancelled" ? { cancellationSource: "runtime" } : {}),
        },
      });
      return events;
    }
  }
}

function mapAcpJsonRpcFixture(fixture: AcpJsonRpcFixture, base: MappingBase): RunActivityEvent[] {
  switch (fixture.method) {
    case "session/update": {
      const update = fixture.params.update;
      if (update.session_update === "available_commands_update") {
        return [
          {
            ...baseFields(base),
            actor: "runtime",
            channel: "diagnostic",
            kind: "available_commands_update",
            text: "Available commands changed",
            payload: {
              runtimeSessionId: fixture.params.sessionId,
              commands: update.available_commands.map((command) => ({
                name: command.name,
                ...(command.description === undefined ? {} : { description: command.description }),
              })),
            },
          },
        ];
      }
      return [
        {
          ...baseFields(base),
          actor: "runtime",
          channel: "token",
          kind: "token_usage_reported",
          text: "Context usage updated",
          payload: {
            runtimeSessionId: fixture.params.sessionId,
            usageSource: "context_window",
            totalTokens: update.used,
            contextWindowTokens: update.size,
          },
        },
      ];
    }
    case "session/set_mode":
      return [
        {
          ...baseFields(base),
          actor: "runtime",
          channel: "diagnostic",
          kind: "mode_update",
          text: "Session mode changed",
          payload: {
            runtimeSessionId: fixture.params.sessionId,
            mode: fixture.params.modeId,
          },
        },
      ];
  }
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function assertNoProtocolLeak(events: readonly RunActivityEvent[], markers: readonly string[]): void {
  const frontendShape = events.map((event) => ({
    eventId: event.eventId,
    runSessionId: event.runSessionId,
    occurredAt: event.occurredAt,
    sequence: event.sequence ?? null,
    harness: event.harness,
    actor: event.actor,
    channel: event.channel,
    kind: event.kind,
    text: event.text,
    payload: event.payload,
  }));
  const rendered = JSON.stringify(frontendShape);
  for (const marker of markers) {
    expect(rendered).not.toContain(marker);
  }
}

function diagnosticActivityInput(overrides: Record<string, unknown> = {}): RunActivityEventInput {
  return {
    eventId: "activity-diagnostic-order-1",
    runId: "run-order",
    sessionId: "session-order",
    occurredAt: "2026-05-31T00:00:00.000Z",
    harness: "runtime-adapter",
    actor: "runtime",
    channel: "diagnostic",
    kind: "runtime_log",
    text: "runtime event",
    payload: {},
    protocol: "json_rpc",
    ...overrides,
  } as RunActivityEventInput;
}

function terminalActivityInput(overrides: Record<string, unknown> = {}): RunActivityEventInput {
  return diagnosticActivityInput({
    eventId: "activity-terminal-order",
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
  it("exposes complete neutral actor, channel, kind, and required alias sets", () => {
    expect(RUN_ACTIVITY_ACTORS).toContain("assistant");
    expect(RUN_ACTIVITY_ACTORS).toContain("provider");
    expect(RUN_ACTIVITY_CHANNELS).toEqual(["lifecycle", "chat", "tool", "diagnostic", "token", "rate_limit", "terminal"]);
    expect(RUN_ACTIVITY_CHANNEL_ALIASES).toEqual({ message: "chat", status: "diagnostic" });
    expect(Object.keys(RUN_ACTIVITY_KIND_BY_CHANNEL).sort()).toEqual([...RUN_ACTIVITY_CHANNELS].sort());
    expect(Object.keys(RUN_ACTIVITY_ACTORS_BY_CHANNEL).sort()).toEqual([...RUN_ACTIVITY_CHANNELS].sort());
    expect(RUN_ACTIVITY_KIND_BY_CHANNEL.lifecycle).toContain("session_started");
    expect(RUN_ACTIVITY_KIND_BY_CHANNEL.chat).toContain("assistant_message_delta");
    expect(RUN_ACTIVITY_KIND_BY_CHANNEL.chat).toContain("assistant_reasoning_delta");
    expect(RUN_ACTIVITY_KIND_BY_CHANNEL.tool).toContain("tool_call_started");
    expect(RUN_ACTIVITY_KIND_BY_CHANNEL.tool).toContain("tool_permission_requested");
    expect(RUN_ACTIVITY_KIND_BY_CHANNEL.diagnostic).toContain("runtime_diagnostic");
    expect(RUN_ACTIVITY_KIND_BY_CHANNEL.diagnostic).toContain("available_commands_update");
    expect(RUN_ACTIVITY_KIND_BY_CHANNEL.diagnostic).toContain("mode_update");
    expect(RUN_ACTIVITY_KIND_BY_CHANNEL.token).toContain("token_usage_reported");
    expect(RUN_ACTIVITY_KIND_BY_CHANNEL.rate_limit).toContain("provider_limit_detected");
    expect(RUN_ACTIVITY_KIND_BY_CHANNEL.terminal).toContain("run_failed");
    expect(RUN_ACTIVITY_KIND_BY_CHANNEL.terminal).toContain("run_cancelled");
  });

  it("keeps upstream protocol method names out of frontend-facing taxonomy values", () => {
    const taxonomyValues = [
      ...RUN_ACTIVITY_ACTORS,
      ...RUN_ACTIVITY_CHANNELS,
      ...Object.keys(RUN_ACTIVITY_CHANNEL_ALIASES),
      ...Object.values(RUN_ACTIVITY_CHANNEL_ALIASES),
      ...Object.values(RUN_ACTIVITY_KIND_BY_CHANNEL).flat(),
    ];

    for (const value of taxonomyValues) {
      expect(value).not.toMatch(/\bacp\b/i);
      expect(value).not.toMatch(/json[-_]?rpc/i);
      expect(value).not.toMatch(/\//);
      expect(value).not.toMatch(/\./);
      expect(value).not.toMatch(/^session_update$/i);
      expect(value).not.toMatch(/^message\.delta$/i);
      expect(value).not.toMatch(/^tool\.start$/i);
    }
  });

  it("guards unknown actor, channel, alias, kind, event shape, and channel-specific combinations", () => {
    expect(isRunActivityActor("assistant")).toBe(true);
    expect(isRunActivityActor("jsonrpc")).toBe(false);
    expect(isRunActivityChannel("chat")).toBe(true);
    expect(isRunActivityChannel("message")).toBe(false);
    expect(isRunActivityChannelAlias("message")).toBe(true);
    expect(isRunActivityChannelInput("status")).toBe(true);
    expect(normalizeRunActivityChannel("message")).toBe("chat");
    expect(normalizeRunActivityChannel("status")).toBe("diagnostic");
    expect(isRunActivityKind("tool_call_completed")).toBe(true);
    expect(isRunActivityKind("session/update")).toBe(false);
    expect(isRunActivityKindForChannel("tool", "tool_call_completed")).toBe(true);
    expect(isRunActivityKindForChannel("tool", "assistant_message_delta")).toBe(false);
    expect(isRunActivityActorForChannel("rate_limit", "provider")).toBe(true);
    expect(isRunActivityActorForChannel("rate_limit", "assistant")).toBe(false);
    expect(isRunActivityEvent(typedChatActivity)).toBe(true);
    expect(isRunActivityEvent({ ...typedChatActivity, id: typedChatActivity.eventId, eventId: undefined })).toBe(false);
    expect(isRunActivityEvent({ ...typedChatActivity, channel: "message" })).toBe(false);
  });

  it("does not reuse a kind across multiple canonical channels", () => {
    const kindChannels = new Map<string, string>();
    for (const [channel, kinds] of Object.entries(RUN_ACTIVITY_KIND_BY_CHANNEL)) {
      for (const kind of kinds) {
        expect(kindChannels.get(kind)).toBeUndefined();
        kindChannels.set(kind, channel);
      }
    }
  });

  it("demonstrates JSON-RPC/Hermes event mapping into neutral contract fields", () => {
    const runSessionId = "run-session-hermes";
    const harness = "hermes";
    const mapped = [
      ...mapHermesJsonRpcFixture(
        { jsonrpc: "2.0", method: "gateway/event", params: { type: "message.delta", session_id: "gw-session-1", payload: { text: "hello" } } },
        { eventId: "hermes-chat-delta", runSessionId, occurredAt: "2026-05-31T00:10:00.000Z", sequence: 1, harness },
      ),
      ...mapHermesJsonRpcFixture(
        {
          jsonrpc: "2.0",
          method: "gateway/event",
          params: { type: "tool.start", session_id: "gw-session-1", payload: { tool_id: "tool-1", name: "read_file", args_text: "path only" } },
        },
        { eventId: "hermes-tool-start", runSessionId, occurredAt: "2026-05-31T00:10:01.000Z", sequence: 2, harness },
      ),
      ...mapHermesJsonRpcFixture(
        {
          jsonrpc: "2.0",
          method: "gateway/event",
          params: { type: "tool.complete", session_id: "gw-session-1", payload: { tool_id: "tool-1", name: "read_file", result_text: "ok" } },
        },
        { eventId: "hermes-tool-complete", runSessionId, occurredAt: "2026-05-31T00:10:02.000Z", sequence: 3, harness },
      ),
      ...mapHermesJsonRpcFixture(
        { jsonrpc: "2.0", method: "gateway/event", params: { type: "status.update", session_id: "gw-session-1", payload: { kind: "working", text: "Running tool" } } },
        { eventId: "hermes-status", runSessionId, occurredAt: "2026-05-31T00:10:03.000Z", sequence: 4, harness },
      ),
      ...mapHermesJsonRpcFixture(
        {
          jsonrpc: "2.0",
          method: "gateway/event",
          params: {
            type: "provider.limit",
            session_id: "gw-session-1",
            payload: {
              provider_id: "openrouter",
              model: "model-a",
              kind: "transient_rate_limit",
              message: "Provider limit detected",
              resume_at: "2026-05-31T00:20:00.000Z",
              window_kind: "retry_after",
            },
          },
        },
        { eventId: "hermes-provider-limit", runSessionId, occurredAt: "2026-05-31T00:10:04.000Z", sequence: 5, harness },
      ),
      ...mapHermesJsonRpcFixture(
        {
          jsonrpc: "2.0",
          method: "gateway/event",
          params: { type: "message.complete", session_id: "gw-session-1", payload: { status: "error", text: "Runtime failed", usage: { input: 10, output: 5, total: 15 } } },
        },
        { eventId: "hermes-complete", runSessionId, occurredAt: "2026-05-31T00:10:05.000Z", sequence: 6, harness },
      ),
    ];

    expect(mapped).toEqual([
      {
        eventId: "hermes-chat-delta",
        runSessionId,
        occurredAt: "2026-05-31T00:10:00.000Z",
        sequence: 1,
        harness,
        actor: "assistant",
        channel: "chat",
        kind: "assistant_message_delta",
        text: "hello",
        payload: { runtimeSessionId: "gw-session-1", delta: true, redacted: true },
      },
      {
        eventId: "hermes-tool-start",
        runSessionId,
        occurredAt: "2026-05-31T00:10:01.000Z",
        sequence: 2,
        harness,
        actor: "tool",
        channel: "tool",
        kind: "tool_call_started",
        text: "Tool read_file started",
        payload: { runtimeSessionId: "gw-session-1", toolCallId: "tool-1", toolName: "read_file", status: "running", inputPreview: "path only", redacted: true },
      },
      {
        eventId: "hermes-tool-complete",
        runSessionId,
        occurredAt: "2026-05-31T00:10:02.000Z",
        sequence: 3,
        harness,
        actor: "tool",
        channel: "tool",
        kind: "tool_call_completed",
        text: "Tool read_file completed",
        payload: {
          runtimeSessionId: "gw-session-1",
          toolCallId: "tool-1",
          toolName: "read_file",
          status: "succeeded",
          outputPreview: "ok",
          errorPreview: null,
          redacted: true,
        },
      },
      {
        eventId: "hermes-status",
        runSessionId,
        occurredAt: "2026-05-31T00:10:03.000Z",
        sequence: 4,
        harness,
        actor: "runtime",
        channel: "diagnostic",
        kind: "runtime_status_update",
        text: "Running tool",
        payload: { runtimeSessionId: "gw-session-1", status: "working" },
      },
      {
        eventId: "hermes-provider-limit",
        runSessionId,
        occurredAt: "2026-05-31T00:10:04.000Z",
        sequence: 5,
        harness,
        actor: "provider",
        channel: "rate_limit",
        kind: "provider_limit_detected",
        text: "Provider limit detected",
        payload: {
          runtimeSessionId: "gw-session-1",
          providerId: "openrouter",
          model: "model-a",
          limitKind: "transient_rate_limit",
          resumePolicy: "auto_at_window_close",
          window: { resumeAt: "2026-05-31T00:20:00.000Z", windowKind: "retry_after" },
        },
      },
      {
        eventId: "hermes-complete-usage",
        runSessionId,
        occurredAt: "2026-05-31T00:10:05.000Z",
        sequence: 6,
        harness,
        actor: "runtime",
        channel: "token",
        kind: "token_usage_reported",
        text: "Token usage reported",
        payload: { runtimeSessionId: "gw-session-1", usageSource: "stream", inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
      {
        eventId: "hermes-complete-terminal",
        runSessionId,
        occurredAt: "2026-05-31T00:10:05.000Z",
        sequence: 7,
        harness,
        actor: "runtime",
        channel: "terminal",
        kind: "run_failed",
        text: "Runtime failed",
        payload: { runtimeSessionId: "gw-session-1", reason: "run_failed", error: "Runtime failed" },
      },
    ]);
    for (const event of mapped) expect(isRunActivityEvent(event)).toBe(true);
    assertNoProtocolLeak(mapped, ["jsonrpc", "gateway/event", "message.delta", "tool.start", "tool.complete", "status.update", "provider.limit", "message.complete", "session_update"]);
  });

  it("demonstrates ACP update mapping without leaking ACP method names into frontend fields", () => {
    const runSessionId = "run-session-editor";
    const harness = "hermes";
    const mapped = [
      ...mapAcpJsonRpcFixture(
        {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "editor-session-1",
            update: {
              session_update: "available_commands_update",
              available_commands: [
                { name: "model", description: "Change model" },
                { name: "tools", description: "Show tools" },
              ],
            },
          },
        },
        { eventId: "editor-commands", runSessionId, occurredAt: "2026-05-31T00:11:00.000Z", sequence: 1, harness },
      ),
      ...mapAcpJsonRpcFixture(
        {
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId: "editor-session-1", update: { session_update: "usage_update", size: 200_000, used: 42_000 } },
        },
        { eventId: "editor-usage", runSessionId, occurredAt: "2026-05-31T00:11:01.000Z", sequence: 2, harness },
      ),
      ...mapAcpJsonRpcFixture(
        { id: 17, jsonrpc: "2.0", method: "session/set_mode", params: { sessionId: "editor-session-1", modeId: "accept_edits" } },
        { eventId: "editor-mode", runSessionId, occurredAt: "2026-05-31T00:11:02.000Z", sequence: 3, harness },
      ),
    ];

    expect(mapped).toEqual([
      {
        eventId: "editor-commands",
        runSessionId,
        occurredAt: "2026-05-31T00:11:00.000Z",
        sequence: 1,
        harness,
        actor: "runtime",
        channel: "diagnostic",
        kind: "available_commands_update",
        text: "Available commands changed",
        payload: {
          runtimeSessionId: "editor-session-1",
          commands: [
            { name: "model", description: "Change model" },
            { name: "tools", description: "Show tools" },
          ],
        },
      },
      {
        eventId: "editor-usage",
        runSessionId,
        occurredAt: "2026-05-31T00:11:01.000Z",
        sequence: 2,
        harness,
        actor: "runtime",
        channel: "token",
        kind: "token_usage_reported",
        text: "Context usage updated",
        payload: { runtimeSessionId: "editor-session-1", usageSource: "context_window", totalTokens: 42_000, contextWindowTokens: 200_000 },
      },
      {
        eventId: "editor-mode",
        runSessionId,
        occurredAt: "2026-05-31T00:11:02.000Z",
        sequence: 3,
        harness,
        actor: "runtime",
        channel: "diagnostic",
        kind: "mode_update",
        text: "Session mode changed",
        payload: { runtimeSessionId: "editor-session-1", mode: "accept_edits" },
      },
    ]);
    for (const event of mapped) expect(isRunActivityEvent(event)).toBe(true);
    assertNoProtocolLeak(mapped, ["acp", "jsonrpc", "session/update", "session/set_mode", "session_update"]);
  });

  it("specifies replay idempotency and ordering fallback behavior", () => {
    const sequencedTwo: RunActivityEventOrderingFields = {
      eventId: "sequenced-two",
      runSessionId: "run-session-ordering",
      occurredAt: "2026-05-31T00:12:00.000Z",
      sequence: 2,
      harness: "hermes",
    };
    const replayedSequencedTwo: RunActivityEventOrderingFields = {
      eventId: "sequenced-two",
      runSessionId: "run-session-ordering",
      occurredAt: "2026-05-31T00:12:09.000Z",
      sequence: 99,
      harness: "hermes",
    };
    const sequencedOne: RunActivityEventOrderingFields = {
      eventId: "sequenced-one",
      runSessionId: "run-session-ordering",
      occurredAt: "2026-05-31T00:12:01.000Z",
      sequence: 1,
      harness: "hermes",
    };
    const unsequencedEarlier: RunActivityEventOrderingFields = {
      eventId: "unsequenced-earlier",
      runSessionId: "run-session-ordering",
      occurredAt: "2026-05-31T00:11:59.000Z",
      harness: "hermes",
    };
    const sameTimestampBeta: RunActivityEventOrderingFields = {
      eventId: "same-timestamp-beta",
      runSessionId: "run-session-ordering",
      occurredAt: "2026-05-31T00:12:02.000Z",
      sequence: null,
      harness: "hermes",
    };
    const sameTimestampAlpha: RunActivityEventOrderingFields = {
      eventId: "same-timestamp-alpha",
      runSessionId: "run-session-ordering",
      occurredAt: "2026-05-31T00:12:02.000Z",
      sequence: null,
      harness: "hermes",
    };

    expect(runActivityEventIdentityKey(sequencedTwo)).toBe("sequenced-two");
    expect(compareRunActivityEvents(sequencedTwo, sequencedOne)).toBeGreaterThan(0);

    const deduped = dedupeRunActivityEvents([
      sequencedTwo,
      replayedSequencedTwo,
      sequencedOne,
      unsequencedEarlier,
      sameTimestampBeta,
      sameTimestampAlpha,
    ]);
    expect(deduped).toEqual([sequencedTwo, sequencedOne, unsequencedEarlier, sameTimestampBeta, sameTimestampAlpha]);
    expect(sortRunActivityEvents(deduped).map((event) => event.eventId)).toEqual([
      "unsequenced-earlier",
      "sequenced-one",
      "sequenced-two",
      "same-timestamp-alpha",
      "same-timestamp-beta",
    ]);
  });

  it("defines adapter-agnostic ordering profiles and derives legacy input scopes", () => {
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
    expect(deriveRunActivityRunSessionId(diagnosticActivityInput({ runSessionId: " explicit-scope " }))).toBe("explicit-scope");
    expect(deriveRunActivityRunSessionId(diagnosticActivityInput({ runSessionId: null }))).toBe("run-order:session-order");
    expect(deriveRunActivityRunSessionId(diagnosticActivityInput({ sessionId: null, runSessionId: null }))).toBe("run-order");
  });

  it("assigns missing sequences and exposes stable idempotency keys for the public field names", () => {
    const result = accepted(
      applyRunActivityOrdering(
        diagnosticActivityInput({ eventId: "activity-missing-sequence", sequence: null, externalEventId: " upstream-event-1 " }),
      ),
    );

    expect(result.event).toMatchObject({
      eventId: "activity-missing-sequence",
      runSessionId: "run-order:session-order",
      sequence: 1,
      sequenceSource: "symphony",
      externalEventId: "upstream-event-1",
      protocol: "json_rpc",
      channel: "diagnostic",
    });
    expect(result.event).not.toHaveProperty("id");
    expect(result.event).not.toHaveProperty("runId");
    expect(result.event).not.toHaveProperty("sessionId");
    expect(result.event).not.toHaveProperty("at");
    expect(result.event).not.toHaveProperty("harnessId");
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

  it("deduplicates ordered inputs by event id, external event id, and runSessionId sequence", () => {
    let state: RunActivityOrderingState = createRunActivityOrderingState("run-order:session-order");
    const first = accepted(
      applyRunActivityOrdering(
        diagnosticActivityInput({ eventId: "activity-unique", sequence: 1, externalEventId: "upstream-unique" }),
        state,
      ),
    );
    state = first.state;

    expect(applyRunActivityOrdering(diagnosticActivityInput({ eventId: "activity-unique", sequence: 2 }), state)).toMatchObject({
      status: "duplicate",
      reason: "event_id",
      state,
    });
    expect(
      applyRunActivityOrdering(diagnosticActivityInput({ eventId: "activity-new-id", sequence: 2, externalEventId: "upstream-unique" }), state),
    ).toMatchObject({ status: "duplicate", reason: "external_event_id", state });
    expect(
      applyRunActivityOrdering(diagnosticActivityInput({ eventId: "activity-new-sequence-conflict", sequence: 1, externalEventId: "upstream-new" }), state),
    ).toMatchObject({ status: "duplicate", reason: "sequence", state });
  });

  it("preserves out-of-order harness sequences for durable and realtime ordering", () => {
    let state: RunActivityOrderingState = createRunActivityOrderingState("run-order:session-order");
    const first = accepted(applyRunActivityOrdering(diagnosticActivityInput({ eventId: "activity-1", sequence: 1 }), state));
    state = first.state;
    const third = accepted(applyRunActivityOrdering(diagnosticActivityInput({ eventId: "activity-3", sequence: 3 }), state));
    state = third.state;
    const second = accepted(applyRunActivityOrdering(diagnosticActivityInput({ eventId: "activity-2", sequence: 2 }), state));
    state = second.state;

    expect(state.highWatermark).toBe(3);
    expect([third.event, first.event, second.event].sort(compareRunActivityEvents).map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(second.event.sequenceSource).toBe("harness");
  });

  it("makes the first terminal event authoritative while allowing explicit pre-terminal replay backfill", () => {
    let state: RunActivityOrderingState = createRunActivityOrderingState("run-order:session-order");
    state = accepted(applyRunActivityOrdering(diagnosticActivityInput({ eventId: "activity-before-terminal", sequence: 1 }), state)).state;
    const terminal = accepted(applyRunActivityOrdering(terminalActivityInput({ eventId: "activity-terminal", sequence: 3 }), state));
    state = terminal.state;

    expect(state.terminalSequence).toBe(3);
    expect(applyRunActivityOrdering(terminalActivityInput({ eventId: "activity-terminal", sequence: 3 }), state)).toMatchObject({
      status: "duplicate",
      reason: "event_id",
      state,
    });
    expect(applyRunActivityOrdering(diagnosticActivityInput({ eventId: "activity-after-terminal-missing", sequence: null }), state)).toMatchObject({
      status: "rejected",
      reason: "terminal_already_accepted",
      state,
    });
    expect(applyRunActivityOrdering(diagnosticActivityInput({ eventId: "activity-after-terminal", sequence: 4 }), state)).toMatchObject({
      status: "rejected",
      reason: "terminal_already_accepted",
      state,
    });
    expect(applyRunActivityOrdering(terminalActivityInput({ eventId: "activity-second-terminal-earlier", sequence: 2 }), state)).toMatchObject({
      status: "rejected",
      reason: "terminal_already_accepted",
      state,
    });

    const backfill = accepted(applyRunActivityOrdering(diagnosticActivityInput({ eventId: "activity-before-terminal-backfill", sequence: 2 }), state));
    expect(backfill.state).toMatchObject({ highWatermark: 3, terminalSequence: 3, sequences: [1, 3, 2] });
    expect(applyRunActivityOrdering(terminalActivityInput({ eventId: "activity-second-terminal", sequence: 2 }), backfill.state)).toMatchObject({
      status: "duplicate",
      reason: "sequence",
    });
  });

  it("rejects a first terminal event that would sort before already accepted events", () => {
    let state: RunActivityOrderingState = createRunActivityOrderingState("run-order:session-order");
    state = accepted(applyRunActivityOrdering(diagnosticActivityInput({ eventId: "activity-before-late-terminal", sequence: 1 }), state)).state;
    state = accepted(applyRunActivityOrdering(diagnosticActivityInput({ eventId: "activity-after-late-terminal", sequence: 4 }), state)).state;

    const lateTerminal = terminalActivityInput({ eventId: "activity-terminal-too-low", sequence: 3, externalEventId: "terminal-too-low" });
    expect(applyRunActivityOrdering(lateTerminal, state)).toMatchObject({
      status: "rejected",
      reason: "terminal_sequence_precedes_accepted_event",
      state,
    });
    expect(state).toMatchObject({ highWatermark: 4, terminalSequence: null, sequences: [1, 4] });

    expect(applyRunActivityOrdering(lateTerminal, state)).toMatchObject({
      status: "rejected",
      reason: "terminal_sequence_precedes_accepted_event",
      state,
    });

    const boundaryTerminal = accepted(applyRunActivityOrdering(terminalActivityInput({ eventId: "activity-terminal-boundary", sequence: null }), state));
    state = boundaryTerminal.state;
    expect(boundaryTerminal.event).toMatchObject({ sequence: 5, sequenceSource: "symphony" });
    expect(state).toMatchObject({ highWatermark: 5, terminalSequence: 5, sequences: [1, 4, 5] });

    const preTerminalBackfill = accepted(
      applyRunActivityOrdering(diagnosticActivityInput({ eventId: "activity-pre-terminal-backfill-after-boundary", sequence: 3 }), state),
    );
    expect(preTerminalBackfill.state).toMatchObject({ highWatermark: 5, terminalSequence: 5, sequences: [1, 4, 5, 3] });
    expect(applyRunActivityOrdering(diagnosticActivityInput({ eventId: "activity-post-terminal-after-boundary", sequence: 6 }), preTerminalBackfill.state)).toMatchObject({
      status: "rejected",
      reason: "terminal_already_accepted",
      state: preTerminalBackfill.state,
    });
  });
});

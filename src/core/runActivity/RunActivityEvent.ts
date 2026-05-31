import type { ProviderLimitKind, ProviderLimitResumePolicy, ProviderLimitWindow } from "../provider/ProviderLimits.js";
import type { AgentRunKind, AgentRunPhase, AgentRunRole, TokenCounts } from "../types.js";

/**
 * Symphony-owned, frontend-facing run activity taxonomy.
 *
 * The values below intentionally describe observable run behavior rather than
 * upstream protocol events. Harness adapters may map runtime protocol events,
 * SDK streams, diagnostics, or future runtime updates into these neutral
 * actors/channels/kinds before persistence or realtime projection code exposes
 * them to clients.
 */
export const RUN_ACTIVITY_ACTORS = [
  "orchestrator",
  "harness",
  "runtime",
  "assistant",
  "user",
  "tool",
  "operator",
  "provider",
  "system",
] as const;

export type RunActivityActor = (typeof RUN_ACTIVITY_ACTORS)[number];

export const RUN_ACTIVITY_CHANNELS = ["lifecycle", "message", "tool", "status", "token", "rate_limit", "terminal"] as const;

export type RunActivityChannel = (typeof RUN_ACTIVITY_CHANNELS)[number];

export const RUN_ACTIVITY_LIFECYCLE_KINDS = [
  "run_created",
  "run_started",
  "session_started",
  "session_ready",
  "session_reused",
  "prompt_submitted",
  "run_resumed",
  "run_paused",
] as const;

export type RunActivityLifecycleKind = (typeof RUN_ACTIVITY_LIFECYCLE_KINDS)[number];

export const RUN_ACTIVITY_MESSAGE_KINDS = [
  "user_message_submitted",
  "assistant_message_delta",
  "assistant_message_completed",
  "assistant_reasoning_delta",
  "assistant_reasoning_available",
  "system_message",
  "task_update",
  "plan_update",
] as const;

export type RunActivityMessageKind = (typeof RUN_ACTIVITY_MESSAGE_KINDS)[number];

export const RUN_ACTIVITY_TOOL_KINDS = [
  "tool_call_requested",
  "tool_call_started",
  "tool_call_progress",
  "tool_call_completed",
  "tool_call_failed",
  "tool_permission_requested",
  "tool_permission_resolved",
] as const;

export type RunActivityToolKind = (typeof RUN_ACTIVITY_TOOL_KINDS)[number];

export const RUN_ACTIVITY_STATUS_KINDS = [
  "runtime_ready",
  "runtime_log",
  "runtime_warning",
  "runtime_error",
  "runtime_diagnostic",
  "runtime_status_update",
  "sdk_status_update",
  "available_commands_update",
  "mode_update",
] as const;

export type RunActivityStatusKind = (typeof RUN_ACTIVITY_STATUS_KINDS)[number];

export const RUN_ACTIVITY_TOKEN_KINDS = ["token_usage_reported", "token_budget_warning", "token_budget_exceeded"] as const;

export type RunActivityTokenKind = (typeof RUN_ACTIVITY_TOKEN_KINDS)[number];

export const RUN_ACTIVITY_RATE_LIMIT_KINDS = [
  "provider_limit_detected",
  "rate_limit_retry_scheduled",
  "rate_limit_recovered",
] as const;

export type RunActivityRateLimitKind = (typeof RUN_ACTIVITY_RATE_LIMIT_KINDS)[number];

export const RUN_ACTIVITY_TERMINAL_FAILURE_KINDS = [
  "run_failed",
  "run_timed_out",
  "run_stalled",
  "provider_limit_failed",
  "runtime_crashed",
  "transport_failed",
  "harness_stop_failed",
] as const;

export type RunActivityTerminalFailureKind = (typeof RUN_ACTIVITY_TERMINAL_FAILURE_KINDS)[number];

export const RUN_ACTIVITY_TERMINAL_CANCEL_KINDS = ["run_cancelled", "run_interrupted", "run_aborted"] as const;

export type RunActivityTerminalCancelKind = (typeof RUN_ACTIVITY_TERMINAL_CANCEL_KINDS)[number];

export const RUN_ACTIVITY_TERMINAL_KINDS = [
  "run_succeeded",
  ...RUN_ACTIVITY_TERMINAL_FAILURE_KINDS,
  ...RUN_ACTIVITY_TERMINAL_CANCEL_KINDS,
] as const;

export type RunActivityTerminalKind = (typeof RUN_ACTIVITY_TERMINAL_KINDS)[number];

export type RunActivityKind =
  | RunActivityLifecycleKind
  | RunActivityMessageKind
  | RunActivityToolKind
  | RunActivityStatusKind
  | RunActivityTokenKind
  | RunActivityRateLimitKind
  | RunActivityTerminalKind;

export const RUN_ACTIVITY_KIND_BY_CHANNEL = {
  lifecycle: RUN_ACTIVITY_LIFECYCLE_KINDS,
  message: RUN_ACTIVITY_MESSAGE_KINDS,
  tool: RUN_ACTIVITY_TOOL_KINDS,
  status: RUN_ACTIVITY_STATUS_KINDS,
  token: RUN_ACTIVITY_TOKEN_KINDS,
  rate_limit: RUN_ACTIVITY_RATE_LIMIT_KINDS,
  terminal: RUN_ACTIVITY_TERMINAL_KINDS,
} as const satisfies Record<RunActivityChannel, readonly RunActivityKind[]>;

export type RunActivityKindForChannel<TChannel extends RunActivityChannel> =
  (typeof RUN_ACTIVITY_KIND_BY_CHANNEL)[TChannel][number];

export const RUN_ACTIVITY_ACTORS_BY_CHANNEL = {
  lifecycle: ["orchestrator", "harness", "runtime", "operator", "system"],
  message: ["user", "assistant", "system", "runtime"],
  tool: ["assistant", "tool", "runtime", "operator", "harness"],
  status: ["orchestrator", "harness", "runtime", "provider", "system"],
  token: ["runtime", "provider", "harness"],
  rate_limit: ["provider", "runtime", "harness", "orchestrator"],
  terminal: ["orchestrator", "harness", "runtime", "operator", "provider", "system"],
} as const satisfies Record<RunActivityChannel, readonly RunActivityActor[]>;

export type RunActivityActorForChannel<TChannel extends RunActivityChannel> =
  (typeof RUN_ACTIVITY_ACTORS_BY_CHANNEL)[TChannel][number];

export interface RunActivityPayload extends Readonly<Record<string, unknown>> {
  /** True when payload text/previews were sanitized before persistence or projection. */
  redacted?: boolean;
}

export interface RunActivityLifecyclePayload extends RunActivityPayload {
  role?: AgentRunRole | null;
  runPhase?: AgentRunPhase | null;
  runKind?: AgentRunKind | null;
  attempt?: number | null;
  turnNumber?: number | null;
  workspaceKey?: string | null;
}

export interface RunActivityMessagePayload extends RunActivityPayload {
  messageId?: string | null;
  partIndex?: number | null;
  delta?: boolean;
  final?: boolean;
  reasoning?: boolean;
}

export interface RunActivityToolPayload extends RunActivityPayload {
  toolCallId?: string | null;
  toolName?: string | null;
  status?: "requested" | "running" | "succeeded" | "failed" | "cancelled" | string;
  inputPreview?: string | null;
  outputPreview?: string | null;
  errorPreview?: string | null;
}

export interface RunActivityStatusPayload extends RunActivityPayload {
  code?: string | null;
  severity?: "debug" | "info" | "warning" | "error";
  status?: string | null;
}

export interface RunActivityTokenPayload extends RunActivityPayload, Partial<TokenCounts> {
  usageSource?: "stream" | "turn" | "summary" | string;
}

export interface RunActivityRateLimitPayload extends RunActivityPayload {
  providerId?: string | null;
  model?: string | null;
  limitKind?: ProviderLimitKind | string | null;
  resumePolicy?: ProviderLimitResumePolicy | null;
  window?: ProviderLimitWindow | null;
}

export interface RunActivityTerminalPayload extends RunActivityPayload {
  reason?: RunActivityTerminalKind | string | null;
  error?: string | null;
  exitCode?: number | null;
  signal?: string | null;
  cancellationSource?: "operator" | "state_change" | "stalled" | "service_stop" | string | null;
}

export type RunActivityPayloadForChannel<TChannel extends RunActivityChannel> = TChannel extends "lifecycle"
  ? RunActivityLifecyclePayload
  : TChannel extends "message"
    ? RunActivityMessagePayload
    : TChannel extends "tool"
      ? RunActivityToolPayload
      : TChannel extends "status"
        ? RunActivityStatusPayload
        : TChannel extends "token"
          ? RunActivityTokenPayload
          : TChannel extends "rate_limit"
            ? RunActivityRateLimitPayload
            : TChannel extends "terminal"
              ? RunActivityTerminalPayload
              : never;

export interface RunActivityEventBase<
  TChannel extends RunActivityChannel,
  TKind extends RunActivityKindForChannel<TChannel>,
  TActor extends RunActivityActorForChannel<TChannel>,
  TPayload extends RunActivityPayloadForChannel<TChannel>,
> {
  /** Stable unique activity-event identity, suitable for idempotent replay. */
  id: string;
  /** Symphony run id that owns this event. */
  runId: string;
  /** Runtime session/thread id when one exists; null before or outside runtime session creation. */
  sessionId: string | null;
  /** ISO-8601 timestamp for when this normalized activity was observed. */
  at: string;
  /**
   * Monotonic sequence within the run/session when known. Consumers should use
   * id for idempotency and sequence+at for stable ordering when sequence is present.
   */
  sequence?: number | null;
  /** Neutral runtime adapter id; intentionally opaque to frontend taxonomy reducers. */
  harnessId: string;
  actor: TActor;
  channel: TChannel;
  kind: TKind;
  /** Frontend-safe display text; use null for structured-only events. */
  text: string | null;
  /** Structured, sanitized payload for persistence/reducers/realtime consumers. */
  payload: TPayload;
}

export type RunLifecycleActivityEvent = RunActivityEventBase<
  "lifecycle",
  RunActivityLifecycleKind,
  RunActivityActorForChannel<"lifecycle">,
  RunActivityLifecyclePayload
>;

export type RunMessageActivityEvent = RunActivityEventBase<
  "message",
  RunActivityMessageKind,
  RunActivityActorForChannel<"message">,
  RunActivityMessagePayload
>;

export type RunToolActivityEvent = RunActivityEventBase<
  "tool",
  RunActivityToolKind,
  RunActivityActorForChannel<"tool">,
  RunActivityToolPayload
>;

export type RunStatusActivityEvent = RunActivityEventBase<
  "status",
  RunActivityStatusKind,
  RunActivityActorForChannel<"status">,
  RunActivityStatusPayload
>;

export type RunTokenActivityEvent = RunActivityEventBase<
  "token",
  RunActivityTokenKind,
  RunActivityActorForChannel<"token">,
  RunActivityTokenPayload
>;

export type RunRateLimitActivityEvent = RunActivityEventBase<
  "rate_limit",
  RunActivityRateLimitKind,
  RunActivityActorForChannel<"rate_limit">,
  RunActivityRateLimitPayload
>;

export type RunTerminalActivityEvent = RunActivityEventBase<
  "terminal",
  RunActivityTerminalKind,
  RunActivityActorForChannel<"terminal">,
  RunActivityTerminalPayload
>;

export type RunActivityEvent =
  | RunLifecycleActivityEvent
  | RunMessageActivityEvent
  | RunToolActivityEvent
  | RunStatusActivityEvent
  | RunTokenActivityEvent
  | RunRateLimitActivityEvent
  | RunTerminalActivityEvent;

export type RunActivityEventForChannel<TChannel extends RunActivityChannel> = Extract<RunActivityEvent, { channel: TChannel }>;

export function isRunActivityActor(value: unknown): value is RunActivityActor {
  return typeof value === "string" && (RUN_ACTIVITY_ACTORS as readonly string[]).includes(value);
}

export function isRunActivityChannel(value: unknown): value is RunActivityChannel {
  return typeof value === "string" && (RUN_ACTIVITY_CHANNELS as readonly string[]).includes(value);
}

export function isRunActivityKind(value: unknown): value is RunActivityKind {
  return (
    typeof value === "string" &&
    Object.values(RUN_ACTIVITY_KIND_BY_CHANNEL).some((kinds) => (kinds as readonly string[]).includes(value))
  );
}

export function isRunActivityActorForChannel<TChannel extends RunActivityChannel>(
  channel: TChannel,
  actor: unknown,
): actor is RunActivityActorForChannel<TChannel> {
  return typeof actor === "string" && (RUN_ACTIVITY_ACTORS_BY_CHANNEL[channel] as readonly string[]).includes(actor);
}

export function isRunActivityKindForChannel<TChannel extends RunActivityChannel>(
  channel: TChannel,
  kind: unknown,
): kind is RunActivityKindForChannel<TChannel> {
  return typeof kind === "string" && (RUN_ACTIVITY_KIND_BY_CHANNEL[channel] as readonly string[]).includes(kind);
}

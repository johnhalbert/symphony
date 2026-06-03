import type { ProviderLimitKind, ProviderLimitResumePolicy, ProviderLimitWindow } from "../provider/ProviderLimits.js";
import type { AgentRunKind, AgentRunPhase, AgentRunRole, TokenCounts } from "../types.js";
import type {
  AgentCommandPolicyAuditPayload,
  AgentCommandPolicyCommandClass,
  AgentCommandPolicyNormalizedCommand,
  AgentCommandPolicyOutcome,
  AgentCommandPolicyReasonKind,
  AgentCommandPolicySurface,
} from "../harness/AgentCommandPolicy.js";

const RUN_ACTIVITY_COMMAND_POLICY_REASON_KINDS = [
  "safe_local_inspection",
  "upstream_github",
  "unsafe_git_config",
  "unsafe_environment",
  "unknown_command",
  "service_owned_not_applicable",
  "local_only_inspection",
  "role_not_restricted",
  "direct_upstream_github",
  "github_cli",
  "github_host_reference",
  "ambiguous_command",
  "malformed_command",
  "malformed_hook_payload",
  "oversized_hook_payload",
  "missing_hook_context",
  "classifier_error",
] as const satisfies readonly AgentCommandPolicyReasonKind[];

/**
 * Symphony-owned, harness-neutral run activity taxonomy.
 *
 * These values describe observable run behavior rather than upstream protocol
 * methods. Runtime adapters may map gateway updates, SDK stream callbacks,
 * diagnostics, or future runtime events into this contract before persistence,
 * realtime projection, or frontend reducers expose activity to clients.
 *
 * Canonical frontend channels intentionally include `chat` and `diagnostic`.
 * Runtime-facing names used by older code or upstream adapters are preserved as
 * explicit channel aliases via RUN_ACTIVITY_CHANNEL_ALIASES and must be
 * normalized before an event is emitted to clients.
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

export const RUN_ACTIVITY_CHANNELS = ["lifecycle", "chat", "tool", "diagnostic", "token", "rate_limit", "terminal"] as const;

export type RunActivityChannel = (typeof RUN_ACTIVITY_CHANNELS)[number];

export const RUN_ACTIVITY_CHANNEL_ALIASES = {
  /** Older harness/transcript surfaces that say "message" project to the frontend `chat` channel. */
  message: "chat",
  /** Older harness/transcript surfaces that say "status" project to the frontend `diagnostic` channel. */
  status: "diagnostic",
} as const satisfies Record<string, RunActivityChannel>;

export type RunActivityChannelAlias = keyof typeof RUN_ACTIVITY_CHANNEL_ALIASES;
export type RunActivityChannelInput = RunActivityChannel | RunActivityChannelAlias;

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

export const RUN_ACTIVITY_CHAT_KINDS = [
  "user_message_submitted",
  "assistant_message_delta",
  "assistant_message_completed",
  "assistant_reasoning_delta",
  "assistant_reasoning_available",
  "system_message",
  "task_update",
  "plan_update",
] as const;

export type RunActivityChatKind = (typeof RUN_ACTIVITY_CHAT_KINDS)[number];

/** @deprecated Use RUN_ACTIVITY_CHAT_KINDS with the canonical `chat` channel. */
export const RUN_ACTIVITY_MESSAGE_KINDS = RUN_ACTIVITY_CHAT_KINDS;
/** @deprecated Use RunActivityChatKind with the canonical `chat` channel. */
export type RunActivityMessageKind = RunActivityChatKind;

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

export const RUN_ACTIVITY_DIAGNOSTIC_KINDS = [
  "runtime_ready",
  "runtime_log",
  "runtime_warning",
  "runtime_error",
  "runtime_diagnostic",
  "runtime_status_update",
  "sdk_status_update",
  "available_commands_update",
  "mode_update",
  "command_policy_decision",
] as const;

export type RunActivityDiagnosticKind = (typeof RUN_ACTIVITY_DIAGNOSTIC_KINDS)[number];
export type RunActivityGenericDiagnosticKind = Exclude<RunActivityDiagnosticKind, "command_policy_decision">;

/** @deprecated Use RUN_ACTIVITY_DIAGNOSTIC_KINDS with the canonical `diagnostic` channel. */
export const RUN_ACTIVITY_STATUS_KINDS = RUN_ACTIVITY_DIAGNOSTIC_KINDS;
/** @deprecated Use RunActivityDiagnosticKind with the canonical `diagnostic` channel. */
export type RunActivityStatusKind = RunActivityDiagnosticKind;

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
  | RunActivityChatKind
  | RunActivityToolKind
  | RunActivityDiagnosticKind
  | RunActivityTokenKind
  | RunActivityRateLimitKind
  | RunActivityTerminalKind;

export const RUN_ACTIVITY_KIND_BY_CHANNEL = {
  lifecycle: RUN_ACTIVITY_LIFECYCLE_KINDS,
  chat: RUN_ACTIVITY_CHAT_KINDS,
  tool: RUN_ACTIVITY_TOOL_KINDS,
  diagnostic: RUN_ACTIVITY_DIAGNOSTIC_KINDS,
  token: RUN_ACTIVITY_TOKEN_KINDS,
  rate_limit: RUN_ACTIVITY_RATE_LIMIT_KINDS,
  terminal: RUN_ACTIVITY_TERMINAL_KINDS,
} as const satisfies Record<RunActivityChannel, readonly RunActivityKind[]>;

export type RunActivityKindForChannel<TChannel extends RunActivityChannel> =
  (typeof RUN_ACTIVITY_KIND_BY_CHANNEL)[TChannel][number];

export const RUN_ACTIVITY_ACTORS_BY_CHANNEL = {
  lifecycle: ["orchestrator", "harness", "runtime", "operator", "system"],
  chat: ["user", "assistant", "system", "runtime"],
  tool: ["assistant", "tool", "runtime", "operator", "harness"],
  diagnostic: ["orchestrator", "harness", "runtime", "provider", "system"],
  token: ["runtime", "provider", "harness"],
  rate_limit: ["provider", "runtime", "harness", "orchestrator"],
  terminal: ["orchestrator", "harness", "runtime", "operator", "provider", "system"],
} as const satisfies Record<RunActivityChannel, readonly RunActivityActor[]>;

export type RunActivityActorForChannel<TChannel extends RunActivityChannel> =
  (typeof RUN_ACTIVITY_ACTORS_BY_CHANNEL)[TChannel][number];

export interface RunActivityPayload extends Readonly<Record<string, unknown>> {
  /** Runtime provider/session/thread id when one exists; null before or outside runtime session creation. */
  runtimeSessionId?: string | null;
  /** True when payload text/previews were sanitized before persistence or projection. */
  redacted?: boolean;
}

export const RUN_ACTIVITY_PROTOCOLS = ["json_rpc", "acp", "symphony", "unknown"] as const;

export type RunActivityProtocol = (typeof RUN_ACTIVITY_PROTOCOLS)[number];

export const RUN_ACTIVITY_SEQUENCE_SOURCES = ["harness", "symphony"] as const;

export type RunActivitySequenceSource = (typeof RUN_ACTIVITY_SEQUENCE_SOURCES)[number];

export interface RunActivityAdapterOrderingProfile {
  readonly protocol: Extract<RunActivityProtocol, "json_rpc" | "acp">;
  readonly sequenceRule: "preserve_positive_integer_or_assign_next";
  readonly externalEventIdRule: "preserve_when_available_optional_otherwise";
  readonly terminalRule: "first_terminal_wins_backfill_before_terminal_allowed";
}

export const RUN_ACTIVITY_ADAPTER_ORDERING_PROFILES = {
  json_rpc: {
    protocol: "json_rpc",
    sequenceRule: "preserve_positive_integer_or_assign_next",
    externalEventIdRule: "preserve_when_available_optional_otherwise",
    terminalRule: "first_terminal_wins_backfill_before_terminal_allowed",
  },
  acp: {
    protocol: "acp",
    sequenceRule: "preserve_positive_integer_or_assign_next",
    externalEventIdRule: "preserve_when_available_optional_otherwise",
    terminalRule: "first_terminal_wins_backfill_before_terminal_allowed",
  },
} as const satisfies Record<Extract<RunActivityProtocol, "json_rpc" | "acp">, RunActivityAdapterOrderingProfile>;

export interface RunActivityLifecyclePayload extends RunActivityPayload {
  role?: AgentRunRole | null;
  runPhase?: AgentRunPhase | null;
  runKind?: AgentRunKind | null;
  attempt?: number | null;
  turnNumber?: number | null;
  workspaceKey?: string | null;
}

export interface RunActivityChatPayload extends RunActivityPayload {
  messageId?: string | null;
  partIndex?: number | null;
  delta?: boolean;
  final?: boolean;
  reasoning?: boolean;
}

/** @deprecated Use RunActivityChatPayload with the canonical `chat` channel. */
export type RunActivityMessagePayload = RunActivityChatPayload;

export interface RunActivityToolPayload extends RunActivityPayload {
  toolCallId?: string | null;
  toolName?: string | null;
  status?: "requested" | "running" | "succeeded" | "failed" | "cancelled" | string;
  inputPreview?: string | null;
  outputPreview?: string | null;
  errorPreview?: string | null;
}

export interface RunActivityDiagnosticPayload extends RunActivityPayload {
  code?: string | null;
  severity?: "debug" | "info" | "warning" | "error";
  status?: string | null;
}

export interface RunActivityCommandPolicyDecisionPayload extends RunActivityDiagnosticPayload {
  /** Stable policy decision id when the emitting surface can provide one. */
  decisionId?: string | null;
  /** Stable command attempt/tool-call id correlated with the policy decision. */
  attemptId?: string | null;
  /** Symphony run id associated with the command attempt when known. */
  runId?: string | null;
  /** Issue id associated with the command attempt when known. */
  issueId?: string | null;
  /** Command-capable surface that requested classification, e.g. terminal, ACP, or pre_tool_call. */
  surface: AgentCommandPolicySurface;
  /** Agent role whose command surface produced the decision. */
  role: string;
  /** Run phase whose command surface produced the decision. */
  phase: string;
  /** Structured allow/deny outcome, never inferred from message text. */
  outcome: AgentCommandPolicyOutcome;
  /** Structured redacted policy reason for audit and replay. */
  reasonKind: AgentCommandPolicyReasonKind;
  /** Normalized classifier bucket for the attempted command. */
  commandClass: AgentCommandPolicyCommandClass;
  /** Redacted actionable message returned to the agent. */
  message: string;
  /** True only when the policy observed contact evidence; correct pre-execution denials should be false. */
  upstreamContactAttempted: boolean;
  /** Whether the decision indicates implementation code should change instead of retrying the command. */
  requiresCodeChange?: boolean;
  /** Whether service-owned workflow or human action is needed instead of an agent command retry. */
  requiresUserOrServiceFix?: boolean;
  /** Bounded normalized command evidence with arguments already redacted/truncated. */
  normalizedCommand?: AgentCommandPolicyNormalizedCommand;
  /** Bounded, redacted audit payload; environment values and raw command values must not be present. */
  audit: AgentCommandPolicyAuditPayload;
  /** Optional ACP/gateway request kind for permission/hook decisions. */
  requestKind?: string | null;
  /** Optional runtime tool-call id correlated with the policy attempt. */
  toolCallId?: string | null;
  /** Optional ACP option selected for allow decisions; null/absent for denials. */
  selectedOptionId?: string | null;
  /** Optional permission outcome label emitted by ACP/gateway adapters. */
  permissionOutcome?: string | null;
  /** Optional gateway hook response action, such as block or allow. */
  hookAction?: string | null;
  /** Command policy payloads are always intended to be frontend-safe/redacted. */
  redacted: true;
}

/** @deprecated Use RunActivityDiagnosticPayload with the canonical `diagnostic` channel. */
export type RunActivityStatusPayload = RunActivityDiagnosticPayload;

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
  : TChannel extends "chat"
    ? RunActivityChatPayload
    : TChannel extends "tool"
      ? RunActivityToolPayload
      : TChannel extends "diagnostic"
        ? RunActivityDiagnosticPayload
        : TChannel extends "token"
          ? RunActivityTokenPayload
          : TChannel extends "rate_limit"
            ? RunActivityRateLimitPayload
            : TChannel extends "terminal"
              ? RunActivityTerminalPayload
              : never;

/**
 * Run activity replay and ordering contract.
 *
 * Idempotency:
 * - `eventId` is the identity key for persistence, replay, reducers, and
 *   realtime clients. A replayed activity with an already-seen `eventId` is the
 *   same logical event and must be ignored or replace the previous copy without
 *   producing another user-visible activity row.
 *
 * Ordering:
 * - `sequence` is optional. When present, it is monotonic only within one
 *   `(runSessionId, harness)` stream. Consumers must not compare sequence values
 *   from different run sessions or harnesses as causal order.
 * - If two events are in the same sequence scope and both have a numeric
 *   sequence, order by `sequence` first.
 * - If either event has no sequence, or the events are from different sequence
 *   scopes, order by `occurredAt` as an ISO-8601 timestamp/string.
 * - Equal sequences or timestamps are tie-broken by `runSessionId`, then
 *   `harness`, then `eventId` lexicographically so replay is deterministic even
 *   when an upstream runtime omits or reuses sequence numbers.
 */
export interface RunActivityEventBase<
  TChannel extends RunActivityChannel,
  TKind extends RunActivityKindForChannel<TChannel>,
  TActor extends RunActivityActorForChannel<TChannel>,
  TPayload extends RunActivityPayloadForChannel<TChannel>,
> {
  /** Stable unique activity-event identity and idempotency/replay dedupe key. */
  eventId: string;
  /** Symphony run-session stream identity; scopes optional sequence values. */
  runSessionId: string;
  /** ISO-8601 timestamp for when this normalized activity occurred. */
  occurredAt: string;
  /** Optional monotonic sequence scoped to the `(runSessionId, harness)` stream. */
  sequence?: number | null;
  /** Whether sequence came from the harness/protocol or was assigned by Symphony. */
  sequenceSource?: RunActivitySequenceSource | null;
  /** Optional opaque upstream event id for reconnect/replay idempotency. */
  externalEventId?: string | null;
  /** Runtime protocol/adapter family that produced the source event. */
  protocol?: RunActivityProtocol | null;
  /** Neutral runtime adapter id; intentionally opaque to frontend taxonomy reducers. */
  harness: string;
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

export type RunChatActivityEvent = RunActivityEventBase<
  "chat",
  RunActivityChatKind,
  RunActivityActorForChannel<"chat">,
  RunActivityChatPayload
>;

/** @deprecated Use RunChatActivityEvent with the canonical `chat` channel. */
export type RunMessageActivityEvent = RunChatActivityEvent;

export type RunToolActivityEvent = RunActivityEventBase<
  "tool",
  RunActivityToolKind,
  RunActivityActorForChannel<"tool">,
  RunActivityToolPayload
>;

export type RunDiagnosticActivityEvent = RunActivityEventBase<
  "diagnostic",
  RunActivityGenericDiagnosticKind,
  RunActivityActorForChannel<"diagnostic">,
  RunActivityDiagnosticPayload
>;

export type RunCommandPolicyDecisionActivityEvent = RunActivityEventBase<
  "diagnostic",
  "command_policy_decision",
  RunActivityActorForChannel<"diagnostic">,
  RunActivityCommandPolicyDecisionPayload
>;

/** @deprecated Use RunDiagnosticActivityEvent with the canonical `diagnostic` channel. */
export type RunStatusActivityEvent = RunDiagnosticActivityEvent;

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
  | RunChatActivityEvent
  | RunToolActivityEvent
  | RunDiagnosticActivityEvent
  | RunCommandPolicyDecisionActivityEvent
  | RunTokenActivityEvent
  | RunRateLimitActivityEvent
  | RunTerminalActivityEvent;

export type RunActivityEventForChannel<TChannel extends RunActivityChannel> = Extract<RunActivityEvent, { channel: TChannel }>;

export interface RunActivityEventIdentityFields {
  eventId: string;
}

export interface RunActivityEventOrderingFields extends RunActivityEventIdentityFields {
  runSessionId: string;
  occurredAt: string;
  sequence?: number | null;
  harness: string;
  sequenceSource?: RunActivitySequenceSource | null;
  externalEventId?: string | null;
  protocol?: RunActivityProtocol | null;
}

type DistributiveOmit<T, TKeys extends keyof any> = T extends unknown ? Omit<T, TKeys> : never;

type RunActivityEventInputTaxonomy = DistributiveOmit<
  RunActivityEvent,
  "eventId" | "runSessionId" | "occurredAt" | "sequence" | "sequenceSource" | "externalEventId" | "protocol" | "harness" | "channel"
>;

export type RunActivityEventInput = RunActivityEventInputTaxonomy & {
  /** Stable event identity. Older adapter inputs may provide `id`; emitted RunActivityEvent objects always use `eventId`. */
  eventId?: string | null;
  /** @deprecated Runtime-facing alias normalized into `eventId` before persistence/projection. */
  id?: string | null;
  /** Explicit scope from the adapter; defaults to a Symphony-derived run/session scope when omitted. */
  runSessionId?: string | null;
  /** Symphony run id used only to derive runSessionId/persistence metadata for older adapter inputs. */
  runId?: string | null;
  /** Raw runtime session/thread id used only to derive runSessionId/persistence metadata for older adapter inputs. */
  sessionId?: string | null;
  /** ISO-8601 event timestamp. Older adapter inputs may provide `at`; emitted RunActivityEvent objects always use `occurredAt`. */
  occurredAt?: string | null;
  /** @deprecated Runtime-facing alias normalized into `occurredAt` before persistence/projection. */
  at?: string | null;
  /** Positive harness/protocol sequence. Missing, null, or non-positive values are assigned by Symphony. */
  sequence?: number | null;
  sequenceSource?: RunActivitySequenceSource | null;
  externalEventId?: string | null;
  protocol?: RunActivityProtocol | null;
  /** Neutral runtime adapter id. Older adapter inputs may provide `harnessId`; emitted RunActivityEvent objects always use `harness`. */
  harness?: string | null;
  /** @deprecated Runtime-facing alias normalized into `harness` before persistence/projection. */
  harnessId?: string | null;
  /** Canonical frontend channel or a documented runtime-facing channel alias. */
  channel: RunActivityChannelInput;
};

export interface RunActivityOrderingState {
  /** Scope that owns every accepted idempotency key in this state. */
  readonly runSessionId: string;
  /** Highest accepted sequence in the scope, including out-of-order arrivals. */
  readonly highWatermark: number;
  /** First accepted terminal sequence, or null while the run/session remains open. */
  readonly terminalSequence: number | null;
  /** Accepted stable event ids. Kept serializable so persistence code can snapshot/rebuild state. */
  readonly eventIds: readonly string[];
  /** Accepted upstream ids, scoped by runSessionId. Empty/null upstream ids are ignored. */
  readonly externalEventIds: readonly string[];
  /** Accepted sequence numbers, scoped by runSessionId. */
  readonly sequences: readonly number[];
}

export type RunActivityDuplicateReason = "event_id" | "external_event_id" | "sequence";

export type RunActivityRejectReason =
  | "invalid_event"
  | "run_session_scope_mismatch"
  | "terminal_already_accepted"
  | "terminal_sequence_precedes_accepted_event";

export type RunActivityOrderingResult =
  | {
      readonly status: "accepted";
      readonly event: RunActivityEvent;
      readonly state: RunActivityOrderingState;
    }
  | {
      readonly status: "duplicate";
      readonly reason: RunActivityDuplicateReason;
      readonly state: RunActivityOrderingState;
    }
  | {
      readonly status: "rejected";
      readonly reason: RunActivityRejectReason;
      readonly state: RunActivityOrderingState;
    };

export function createRunActivityOrderingState(runSessionId: string): RunActivityOrderingState {
  return {
    runSessionId,
    highWatermark: 0,
    terminalSequence: null,
    eventIds: [],
    externalEventIds: [],
    sequences: [],
  };
}

export function deriveRunActivityRunSessionId(input: Pick<RunActivityEventInput, "runId" | "sessionId" | "runSessionId">): string {
  const explicit = normalizeOptionalString(input.runSessionId);
  if (explicit) return explicit;
  const runId = normalizeOptionalString(input.runId);
  if (!runId) return "unknown-run";
  const sessionId = normalizeOptionalString(input.sessionId);
  return sessionId ? `${runId}:${sessionId}` : runId;
}

export function runActivityEventIdentityKey(event: RunActivityEventIdentityFields): string {
  return event.eventId;
}

export function runActivityIdempotencyKeys(
  input: Pick<RunActivityEventOrderingFields, "eventId" | "runSessionId" | "sequence" | "externalEventId">,
): readonly string[] {
  const sequence = normalizedRunActivitySequence(input.sequence);
  return [
    `event_id:${input.eventId}`,
    ...(sequence === null ? [] : [`run_sequence:${input.runSessionId}:${sequence}`]),
    ...(normalizeOptionalString(input.externalEventId) ? [`external_event_id:${input.runSessionId}:${normalizeOptionalString(input.externalEventId)}`] : []),
  ];
}

/**
 * Applies the RunActivityEvent ordering and idempotency contract.
 *
 * Rules:
 * - runSessionId scopes ordering and idempotency, not raw runtime session ids.
 * - Positive harness/protocol sequences are preserved, including out-of-order
 *   backfill. Missing, null, or non-positive sequences are assigned to the next
 *   high-watermark value in the runSessionId scope.
 * - Duplicate eventId, runSessionId+sequence, or runSessionId+externalEventId
 *   inputs are no-op duplicates and must not be re-emitted to realtime clients.
 * - The first terminal event wins only when it does not sort before already
 *   accepted events. A terminal whose sequence is below an accepted sequence is
 *   rejected so durable and realtime projections never contain accepted
 *   post-terminal events. Replayed duplicates remain no-ops; explicit
 *   pre-terminal backfill may still be accepted, but missing-sequence or
 *   post-terminal events are rejected after a terminal sequence exists.
 */
export function applyRunActivityOrdering(input: RunActivityEventInput, state?: RunActivityOrderingState): RunActivityOrderingResult {
  const runSessionId = deriveRunActivityRunSessionId(input);
  const current = state ?? createRunActivityOrderingState(runSessionId);
  if (current.runSessionId !== runSessionId) return { status: "rejected", reason: "run_session_scope_mismatch", state: current };

  const eventId = normalizeRequiredActivityInputString(input.eventId ?? input.id, "eventId");
  const occurredAt = normalizeRequiredActivityInputString(input.occurredAt ?? input.at, "occurredAt");
  const harness = normalizeRequiredActivityInputString(input.harness ?? input.harnessId, "harness");
  const channel = normalizeRunActivityChannel(input.channel);
  const providedSequence = normalizedRunActivitySequence(input.sequence);
  const sequence = providedSequence ?? current.highWatermark + 1;
  const externalEventId = normalizeOptionalString(input.externalEventId);

  if (current.eventIds.includes(eventId)) return { status: "duplicate", reason: "event_id", state: current };
  if (externalEventId && current.externalEventIds.includes(externalEventId)) {
    return { status: "duplicate", reason: "external_event_id", state: current };
  }
  if (current.sequences.includes(sequence)) return { status: "duplicate", reason: "sequence", state: current };

  if (
    current.terminalSequence === null &&
    channel === "terminal" &&
    current.sequences.some((acceptedSequence) => acceptedSequence > sequence)
  ) {
    return { status: "rejected", reason: "terminal_sequence_precedes_accepted_event", state: current };
  }

  if (current.terminalSequence !== null) {
    const canBackfillBeforeTerminal = providedSequence !== null && sequence < current.terminalSequence && channel !== "terminal";
    if (!canBackfillBeforeTerminal) return { status: "rejected", reason: "terminal_already_accepted", state: current };
  }

  const {
    runId: _runId,
    sessionId: _sessionId,
    id: _id,
    at: _at,
    harnessId: _harnessId,
    ...eventInput
  } = input;
  const event = {
    ...eventInput,
    eventId,
    runSessionId,
    occurredAt,
    sequence,
    sequenceSource: providedSequence === null ? "symphony" : (input.sequenceSource ?? "harness"),
    externalEventId,
    protocol: input.protocol ?? "unknown",
    harness,
    channel,
  } as RunActivityEvent;
  if (!isRunActivityEvent(event)) return { status: "rejected", reason: "invalid_event", state: current };

  const nextState: RunActivityOrderingState = {
    runSessionId,
    highWatermark: Math.max(current.highWatermark, sequence),
    terminalSequence: event.channel === "terminal" ? sequence : current.terminalSequence,
    eventIds: [...current.eventIds, event.eventId],
    externalEventIds: externalEventId ? [...current.externalEventIds, externalEventId] : current.externalEventIds,
    sequences: [...current.sequences, sequence],
  };
  return { status: "accepted", event, state: nextState };
}

export function compareRunActivityEvents(
  left: RunActivityEventOrderingFields,
  right: RunActivityEventOrderingFields,
): number {
  const leftSequence = normalizedRunActivitySequence(left.sequence);
  const rightSequence = normalizedRunActivitySequence(right.sequence);
  const sameSequenceScope = left.runSessionId === right.runSessionId && left.harness === right.harness;

  if (sameSequenceScope && leftSequence !== null && rightSequence !== null && leftSequence !== rightSequence) {
    return leftSequence - rightSequence;
  }

  const occurredAtComparison = compareRunActivityText(left.occurredAt, right.occurredAt);
  if (occurredAtComparison !== 0) return occurredAtComparison;

  const runSessionComparison = compareRunActivityText(left.runSessionId, right.runSessionId);
  if (runSessionComparison !== 0) return runSessionComparison;

  const harnessComparison = compareRunActivityText(left.harness, right.harness);
  if (harnessComparison !== 0) return harnessComparison;

  if (leftSequence !== null && rightSequence !== null && leftSequence !== rightSequence) {
    return leftSequence - rightSequence;
  }

  return compareRunActivityText(left.eventId, right.eventId);
}

export function sortRunActivityEvents<TEvent extends RunActivityEventOrderingFields>(events: readonly TEvent[]): TEvent[] {
  return [...events].sort(compareRunActivityEvents);
}

export function dedupeRunActivityEvents<TEvent extends RunActivityEventIdentityFields>(events: readonly TEvent[]): TEvent[] {
  const seen = new Set<string>();
  const deduped: TEvent[] = [];
  for (const event of events) {
    const key = runActivityEventIdentityKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(event);
  }
  return deduped;
}

export function normalizeRunActivityChannel(channel: RunActivityChannelInput): RunActivityChannel {
  return isRunActivityChannelAlias(channel) ? RUN_ACTIVITY_CHANNEL_ALIASES[channel] : channel;
}

export function isRunActivityActor(value: unknown): value is RunActivityActor {
  return typeof value === "string" && (RUN_ACTIVITY_ACTORS as readonly string[]).includes(value);
}

export function isRunActivityChannel(value: unknown): value is RunActivityChannel {
  return typeof value === "string" && (RUN_ACTIVITY_CHANNELS as readonly string[]).includes(value);
}

export function isRunActivityChannelAlias(value: unknown): value is RunActivityChannelAlias {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(RUN_ACTIVITY_CHANNEL_ALIASES, value);
}

export function isRunActivityChannelInput(value: unknown): value is RunActivityChannelInput {
  return isRunActivityChannel(value) || isRunActivityChannelAlias(value);
}

export function isRunActivityProtocol(value: unknown): value is RunActivityProtocol {
  return typeof value === "string" && (RUN_ACTIVITY_PROTOCOLS as readonly string[]).includes(value);
}

export function isRunActivitySequenceSource(value: unknown): value is RunActivitySequenceSource {
  return typeof value === "string" && (RUN_ACTIVITY_SEQUENCE_SOURCES as readonly string[]).includes(value);
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

export function isRunActivityEvent(value: unknown): value is RunActivityEvent {
  if (!isRunActivityRecord(value)) return false;
  if (typeof value.eventId !== "string" || value.eventId.length === 0) return false;
  if (typeof value.runSessionId !== "string" || value.runSessionId.length === 0) return false;
  if (typeof value.occurredAt !== "string" || value.occurredAt.length === 0) return false;
  if (typeof value.harness !== "string" || value.harness.length === 0) return false;
  if (value.sequence !== undefined && value.sequence !== null && normalizedRunActivitySequence(value.sequence) === null) return false;
  if (value.sequenceSource !== undefined && value.sequenceSource !== null && !isRunActivitySequenceSource(value.sequenceSource)) return false;
  if (value.externalEventId !== undefined && value.externalEventId !== null && typeof value.externalEventId !== "string") return false;
  if (value.protocol !== undefined && value.protocol !== null && !isRunActivityProtocol(value.protocol)) return false;
  if (value.text !== null && typeof value.text !== "string") return false;
  if (!isRunActivityRecord(value.payload)) return false;

  const channel = value.channel;
  if (!isRunActivityChannel(channel)) return false;
  if (!isRunActivityActorForChannel(channel, value.actor) || !isRunActivityKindForChannel(channel, value.kind)) return false;
  if (channel === "diagnostic" && value.kind === "command_policy_decision") {
    return isRunActivityCommandPolicyDecisionPayload(value.payload);
  }
  return true;
}

export function isRunActivityCommandPolicyDecisionPayload(value: unknown): value is RunActivityCommandPolicyDecisionPayload {
  if (!isRunActivityRecord(value)) return false;
  if (value.redacted !== true) return false;
  if (!isNonEmptyRunActivityString(value.surface)) return false;
  if (!isNonEmptyRunActivityString(value.role)) return false;
  if (!isNonEmptyRunActivityString(value.phase)) return false;
  if (!isRunActivityCommandPolicyOutcome(value.outcome)) return false;
  if (!isRunActivityCommandPolicyReasonKind(value.reasonKind)) return false;
  if (!isNonEmptyRunActivityString(value.commandClass)) return false;
  if (!isNonEmptyRunActivityString(value.message)) return false;
  if (typeof value.upstreamContactAttempted !== "boolean") return false;
  if (!isRunActivityCommandPolicyAuditPayload(value.audit, value)) return false;

  if (value.decisionId !== undefined && value.decisionId !== null && !isNonEmptyRunActivityString(value.decisionId)) return false;
  if (value.attemptId !== undefined && value.attemptId !== null && !isNonEmptyRunActivityString(value.attemptId)) return false;
  if (value.runId !== undefined && value.runId !== null && !isNonEmptyRunActivityString(value.runId)) return false;
  if (value.issueId !== undefined && value.issueId !== null && !isNonEmptyRunActivityString(value.issueId)) return false;
  if (value.requestKind !== undefined && value.requestKind !== null && !isNonEmptyRunActivityString(value.requestKind)) return false;
  if (value.toolCallId !== undefined && value.toolCallId !== null && !isNonEmptyRunActivityString(value.toolCallId)) return false;
  if (value.selectedOptionId !== undefined && value.selectedOptionId !== null && !isNonEmptyRunActivityString(value.selectedOptionId)) return false;
  if (value.permissionOutcome !== undefined && value.permissionOutcome !== null && !isNonEmptyRunActivityString(value.permissionOutcome)) return false;
  if (value.hookAction !== undefined && value.hookAction !== null && !isNonEmptyRunActivityString(value.hookAction)) return false;
  if (value.requiresCodeChange !== undefined && typeof value.requiresCodeChange !== "boolean") return false;
  if (value.requiresUserOrServiceFix !== undefined && typeof value.requiresUserOrServiceFix !== "boolean") return false;
  if (value.normalizedCommand !== undefined && !isRunActivityCommandPolicyNormalizedCommand(value.normalizedCommand)) return false;

  return true;
}

function isRunActivityCommandPolicyAuditPayload(
  value: unknown,
  decision: Readonly<Record<string, unknown>>,
): value is AgentCommandPolicyAuditPayload {
  if (!isRunActivityRecord(value)) return false;
  if (value.redacted !== true) return false;
  if (value.surface !== decision.surface) return false;
  if (value.role !== decision.role) return false;
  if (value.phase !== decision.phase) return false;
  if (value.outcome !== decision.outcome) return false;
  if (value.reasonKind !== decision.reasonKind) return false;
  if (value.commandClass !== decision.commandClass) return false;
  if (value.upstreamContactAttempted !== decision.upstreamContactAttempted) return false;
  if (!isReadonlyStringArray(value.inlineEnvironmentKeys)) return false;
  if (!isReadonlyStringArray(value.unsafeConfigCategories)) return false;
  if (value.unsafeConfigFindings !== undefined && !isReadonlyRecordArray(value.unsafeConfigFindings)) return false;
  if (value.rawInputPreview !== undefined && value.rawInputPreview !== null && typeof value.rawInputPreview !== "string") return false;
  if (value.rawInputPreviewTruncated !== undefined && typeof value.rawInputPreviewTruncated !== "boolean") return false;
  if (value.rawInputPreviewRedacted !== undefined && typeof value.rawInputPreviewRedacted !== "boolean") return false;
  if (value.normalizedExecutable !== undefined && value.normalizedExecutable !== null && typeof value.normalizedExecutable !== "string") return false;
  if (value.executableKind !== undefined && !isNonEmptyRunActivityString(value.executableKind)) return false;
  if (value.targetHosts !== undefined && !isReadonlyStringArray(value.targetHosts)) return false;
  if (value.inheritedEnvironmentKeys !== undefined && !isReadonlyStringArray(value.inheritedEnvironmentKeys)) return false;
  if (value.commandPreview !== undefined && typeof value.commandPreview !== "string") return false;
  if (value.gitSubcommand !== undefined && value.gitSubcommand !== null && typeof value.gitSubcommand !== "string") return false;
  if (value.hasNestedCommand !== undefined && typeof value.hasNestedCommand !== "boolean") return false;
  return true;
}

function isRunActivityCommandPolicyOutcome(value: unknown): value is AgentCommandPolicyOutcome {
  return value === "allow" || value === "deny";
}

function isRunActivityCommandPolicyReasonKind(value: unknown): value is AgentCommandPolicyReasonKind {
  return typeof value === "string" && (RUN_ACTIVITY_COMMAND_POLICY_REASON_KINDS as readonly string[]).includes(value);
}

function isRunActivityCommandPolicyNormalizedCommand(value: unknown): value is AgentCommandPolicyNormalizedCommand {
  if (!isRunActivityRecord(value)) return false;
  if (value.executable !== null && !isNonEmptyRunActivityString(value.executable)) return false;
  if (!isNonEmptyRunActivityString(value.executableKind)) return false;
  if (value.argumentsPreview === undefined || (value.argumentsPreview !== null && typeof value.argumentsPreview !== "string")) return false;
  if (value.gitSubcommand === undefined || (value.gitSubcommand !== null && typeof value.gitSubcommand !== "string")) return false;
  if (!isReadonlyStringArray(value.targetHosts)) return false;
  if (typeof value.hasNestedCommand !== "boolean") return false;
  if (typeof value.hasInlineEnvironment !== "boolean") return false;
  if (typeof value.hasUnsafeGitConfig !== "boolean") return false;
  return true;
}

function isReadonlyStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isReadonlyRecordArray(value: unknown): value is readonly Readonly<Record<string, unknown>>[] {
  return Array.isArray(value) && value.every(isRunActivityRecord);
}

function isNonEmptyRunActivityString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizedRunActivitySequence(sequence: unknown): number | null {
  return typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence > 0 ? sequence : null;
}

function normalizeRequiredActivityInputString(value: string | null | undefined, label: string): string {
  const normalized = normalizeOptionalString(value);
  if (normalized === null) throw new Error(`RunActivityEventInput ${label} must be non-empty`);
  return normalized;
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function compareRunActivityText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isRunActivityRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

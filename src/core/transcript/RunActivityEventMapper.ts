import type { AgentActivitySource, AgentEvent } from "../harness/AgentHarness.js";
import type { TranscriptEvent } from "../persistence/RunTranscriptStore.js";
import {
  isRunActivityEvent,
  type RunActivityEvent,
} from "../runActivity/RunActivityEvent.js";
import type { TokenCounts } from "../types.js";
import { redactTextPreserveFormatting, sanitizePublicJson, sanitizedPreviewValue } from "./TranscriptProjection.js";

export const RUN_ACTIVITY_AGENT_EVENT_SCHEMA_PREFIX = "symphony.run_activity.agent_event";

type RunActivityEventPatch = Pick<TranscriptEvent, "eventType"> &
  Partial<Pick<TranscriptEvent, "message" | "payload" | "payloadSchema" | "payloadTruncated" | "payloadByteLength">>;

const RAW_PROTOCOL_KEYS = new Set(["raw", "rawpayload", "protocolpayload", "jsonrpc", "rpcerror"]);
const TRANSCRIPT_MESSAGE_PREVIEW_LENGTH = 10_000;
const ASSISTANT_DELTA_TEXT_KEYS = ["textPreview", "deltaPreview", "messagePreview", "delta", "text", "message"] as const;

interface PreviewText {
  preview: string;
  truncated: boolean;
  redacted: boolean;
}

/**
 * Convert harness-neutral AgentEvent values into normalized RunActivityEvent
 * transcript rows. The payloads intentionally preserve dashboard state (session
 * ids, activity source, tokens, limits, status, diagnostics, terminal messages)
 * without embedding the raw JSON-RPC/SDK event envelope.
 */
export function mapAgentEventToRunActivityEvent(event: AgentEvent): RunActivityEventPatch {
  const harnessActivity = runActivityPatchFromHarnessMetadata(event.runActivity);
  if (harnessActivity) return harnessActivity;

  switch (event.type) {
    case "session_started":
      return activity("session_started", "Session started", {
        kind: "system",
        sessionId: event.sessionId,
        ...(event.threadId === undefined ? {} : { threadId: event.threadId }),
        ...(event.runId === undefined ? {} : { runId: event.runId }),
        ...(event.providerId === undefined ? {} : { providerId: event.providerId }),
        ...(event.model === undefined ? {} : { model: event.model }),
      });
    case "progress": {
      const message = event.activitySource === "delta" ? deltaPreviewText(event.message, 500) : previewText(event.message, 500);
      return activity("progress", message.preview, {
        // Hermes JSON-RPC status/tool/delta notifications all arrive as
        // progress AgentEvents. Only explicit activitySource="delta" is an
        // assistant response delta; tool progress remains tool activity, while
        // missing activitySource is the legacy status/stream bucket.
        kind: progressPayloadKind(event.activitySource),
        activitySource: event.activitySource ?? "stream",
        progressKind: progressPayloadKind(event.activitySource),
        messagePreview: message.preview,
        truncated: message.truncated,
        redacted: message.redacted,
      });
    }
    case "tokens":
      return activity("tokens", "Token usage updated", {
        kind: "usage",
        tokens: normalizedTokenCounts(event.tokens),
      });
    case "rate_limits":
      return activity("rate_limits", "Rate limits updated", {
        kind: "rate_limits",
        rateLimits: publicPayload(event.payload),
        redacted: true,
      });
    case "provider_limit": {
      const message = previewText(event.signal.message, 500);
      return activity("provider_limit", message.preview, {
        kind: "provider_limit",
        signal: publicPayload(event.signal),
        truncated: message.truncated,
        redacted: message.redacted,
      });
    }
    case "run_status":
      return activity("run_status", `Run status: ${event.sdkStatus}`, {
        kind: "status",
        runId: event.runId,
        sdkStatus: event.sdkStatus,
        sdkStatusSource: event.source,
      });
    case "run_diagnostic": {
      const message = previewText(event.message, 500);
      const payload = {
        kind: "diagnostic",
        code: event.code,
        messagePreview: message.preview,
        truncated: message.truncated,
        redacted: message.redacted,
        ...(event.payload === undefined ? {} : { details: publicPayload(event.payload) }),
      };
      return activity("run_diagnostic", message.preview, payload);
    }
    case "completed": {
      const message = event.message === undefined ? undefined : previewText(event.message, TRANSCRIPT_MESSAGE_PREVIEW_LENGTH);
      return activity("completed", message?.preview ?? "Run completed", {
        kind: "terminal",
        status: "succeeded",
        ...(message === undefined
          ? {}
          : {
              textPreview: message.preview,
              truncated: message.truncated,
              redacted: message.redacted,
            }),
      });
    }
    case "failed": {
      const error = previewText(event.error, 500);
      return activity("failed", error.preview, {
        kind: "terminal",
        status: "failed",
        errorPreview: error.preview,
        truncated: error.truncated,
        redacted: error.redacted,
      });
    }
    case "cancelled":
      return activity("cancelled", "Run cancelled", {
        kind: "terminal",
        status: "cancelled",
      });
  }
  return assertNever(event);
}

function assertNever(event: never): never {
  throw new Error(`Unhandled AgentEvent variant: ${JSON.stringify(event)}`);
}

export function mapRunActivityEventToTranscriptEvent(
  runActivity: RunActivityEvent,
  options: { runId: string; source?: TranscriptEvent["source"] },
): TranscriptEvent {
  const patch = runActivityPatchFromHarnessMetadata(runActivity);
  if (!patch) {
    throw new Error(`Invalid run activity event for transcript projection: ${runActivity.eventId}`);
  }
  if (!positiveInteger(runActivity.sequence)) {
    throw new Error(`Run activity event ${runActivity.eventId} must have a positive sequence for transcript projection`);
  }
  return {
    runId: options.runId,
    sequence: runActivity.sequence,
    at: runActivity.occurredAt,
    source: options.source ?? "harness",
    ...patch,
  };
}

function runActivityPatchFromHarnessMetadata(runActivity: RunActivityEvent | undefined): RunActivityEventPatch | null {
  if (!isValidRunActivityEvent(runActivity)) return null;

  const assistantDelta = isAssistantDeltaRunActivity(runActivity);
  const text = runActivity.text === null ? null : assistantDelta ? deltaPreviewText(runActivity.text, 500) : previewText(runActivity.text, 500);
  const payloadText = assistantDelta ? firstDeltaPreviewFromPayload(runActivity.payload, 500) : null;
  const displayText = text ?? payloadText;
  const publicRunActivityPayload = publicPayload(runActivity.payload);
  const payload = isRecord(publicRunActivityPayload) ? publicRunActivityPayload : { value: publicRunActivityPayload };
  const transcriptPayload: Record<string, unknown> = {
    ...payload,
    // Keep the frontend-facing taxonomy visible to transcript/UI reducers while
    // preserving protocol/harness details as bounded metadata, not as top-level
    // event names from ACP or JSON-RPC.
    kind: runActivity.kind,
    actor: runActivity.actor,
    channel: runActivity.channel,
    protocol: runActivity.protocol,
    harnessId: runActivity.harness,
    activityId: runActivity.eventId,
    ...(runActivity.payload.runtimeSessionId === undefined ? {} : { activitySessionId: runActivity.payload.runtimeSessionId }),
    runSessionId: runActivity.runSessionId,
    activitySequence: runActivity.sequence,
    sequenceSource: runActivity.sequenceSource,
    ...(runActivity.externalEventId === undefined ? {} : { externalEventId: runActivity.externalEventId }),
    ...(displayText === null
      ? {}
      : {
          textPreview: displayText.preview,
          textTruncated: displayText.truncated,
          redacted: payload.redacted === true || displayText.redacted,
        }),
  };

  if (assistantDelta) {
    const deltaPayload = assistantDeltaPayloadOverrides(runActivity.payload, 500);
    Object.assign(transcriptPayload, deltaPayload.fields);
    if (displayText !== null) {
      transcriptPayload.messagePreview = displayText.preview;
      transcriptPayload.textPreview = displayText.preview;
      transcriptPayload.textTruncated = displayText.truncated;
    }
    if (payload.redacted === true || displayText?.redacted || deltaPayload.redacted) transcriptPayload.redacted = true;
  }

  return activity(runActivity.kind, displayText?.preview, transcriptPayload);
}

function isAssistantDeltaRunActivity(runActivity: RunActivityEvent): boolean {
  return runActivity.actor === "assistant" && runActivity.channel === "chat" && runActivity.kind === "assistant_message_delta";
}

function isValidRunActivityEvent(value: unknown): value is RunActivityEvent {
  return isRunActivityEvent(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function activity(eventType: string, message: string | undefined, payload: Record<string, unknown>): RunActivityEventPatch {
  return {
    eventType,
    ...(message === undefined ? {} : { message }),
    payload,
    payloadSchema: `${RUN_ACTIVITY_AGENT_EVENT_SCHEMA_PREFIX}.${eventType}.v1`,
    payloadTruncated: payloadContainsTruncatedPreview(payload),
    payloadByteLength: Buffer.byteLength(JSON.stringify(payload), "utf8"),
  };
}

function publicPayload(value: unknown): unknown {
  return stripRawProtocolFields(sanitizePublicJson(value));
}

function stripRawProtocolFields(value: unknown): unknown {
  if (!isRecord(value)) {
    if (!Array.isArray(value)) return value;
    return value.map(stripRawProtocolFields);
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (RAW_PROTOCOL_KEYS.has(normalizeKey(key))) continue;
    output[key] = stripRawProtocolFields(item);
  }
  return output;
}

function progressPayloadKind(activitySource: AgentActivitySource | undefined): "assistant_delta" | "tool" | "progress" {
  if (activitySource === "delta") return "assistant_delta";
  if (activitySource === "tool") return "tool";
  return "progress";
}

function normalizedTokenCounts(tokens: Partial<TokenCounts>): Partial<TokenCounts> {
  const output: Partial<TokenCounts> = {};
  const inputTokens = finiteNumber(tokens.inputTokens);
  const outputTokens = finiteNumber(tokens.outputTokens);
  const totalTokens = finiteNumber(tokens.totalTokens);
  if (inputTokens !== null) output.inputTokens = inputTokens;
  if (outputTokens !== null) output.outputTokens = outputTokens;
  if (totalTokens !== null) output.totalTokens = totalTokens;
  return output;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function previewText(value: unknown, maxLength: number): PreviewText {
  const preview = sanitizedPreviewValue(value, maxLength);
  return { preview: preview.preview ?? "", truncated: preview.truncated, redacted: preview.redacted };
}

function deltaPreviewText(value: unknown, maxLength: number): PreviewText {
  const preview = redactTextPreserveFormatting(value, maxLength);
  return { preview: preview.text ?? "", truncated: preview.truncated, redacted: preview.redacted };
}

function firstDeltaPreviewFromPayload(payload: Record<string, unknown>, maxLength: number): PreviewText | null {
  let emptyCandidate: PreviewText | null = null;
  for (const key of ASSISTANT_DELTA_TEXT_KEYS) {
    const value = payload[key];
    if (typeof value !== "string") continue;
    const preview = deltaPreviewText(value, maxLength);
    if (preview.preview.length > 0) return preview;
    emptyCandidate ??= preview;
  }
  return emptyCandidate;
}

function assistantDeltaPayloadOverrides(payload: Record<string, unknown>, maxLength: number): { fields: Record<string, unknown>; redacted: boolean } {
  const fields: Record<string, unknown> = {};
  let redacted = false;
  for (const key of ASSISTANT_DELTA_TEXT_KEYS) {
    const value = payload[key];
    if (typeof value !== "string") continue;
    const preview = deltaPreviewText(value, maxLength);
    fields[key] = preview.preview;
    if (preview.redacted) redacted = true;
  }
  return { fields, redacted };
}

function payloadContainsTruncatedPreview(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(payloadContainsTruncatedPreview);
  if (!isRecord(value)) return false;
  if (value.truncated === true) return true;
  return Object.values(value).some(payloadContainsTruncatedPreview);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

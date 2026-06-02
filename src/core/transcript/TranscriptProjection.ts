import type { AgentEvent } from "../harness/AgentHarness.js";
import type { TranscriptEvent } from "../persistence/RunTranscriptStore.js";

const DEFAULT_PREVIEW_LENGTH = 500;
const MAX_JSON_DEPTH = 8;
const REDACTED = "[redacted]";
const TOKEN_PREFIX_PATTERN = /\b(?:ghp_[A-Za-z0-9_]{8,}|sk-[A-Za-z0-9_-]{8,})\b/g;
const SENSITIVE_NORMALIZED_KEYS = new Set([
  "apikey",
  "authorization",
  "token",
  "secret",
  "password",
  "accesstoken",
  "refreshtoken",
  "githubtoken",
  "clientsecret",
  "privatekey",
]);
const SAFE_NORMALIZED_KEYS = new Set(["tokens", "inputtokens", "outputtokens", "totaltokens", "tokenconfigured"]);

export interface RedactedPreview {
  preview: string | null;
  truncated: boolean;
  redacted: boolean;
}

export function sanitizedPreviewValue(value: unknown, maxLength = DEFAULT_PREVIEW_LENGTH): RedactedPreview {
  if (value === undefined || value === null) return { preview: null, truncated: false, redacted: false };
  const text = typeof value === "string" ? value : safeJsonPreview(value);
  const redacted = redactTranscriptText(text);
  const oneLine = redacted.text.replace(/\s+/g, " ").trim();
  return {
    preview: oneLine.length <= maxLength ? oneLine : `${oneLine.slice(0, Math.max(maxLength - 15, 0))}...[truncated]`,
    truncated: oneLine.length > maxLength,
    redacted: redacted.redacted,
  };
}

export function sanitizedDeltaTextValue(value: unknown, maxLength = DEFAULT_PREVIEW_LENGTH): RedactedPreview {
  if (value === undefined || value === null) return { preview: null, truncated: false, redacted: false };
  const text = typeof value === "string" ? value : safeJsonPreview(value);
  const redacted = redactTranscriptText(text);
  return {
    preview: redacted.text.length <= maxLength ? redacted.text : `${redacted.text.slice(0, Math.max(maxLength - 15, 0))}...[truncated]`,
    truncated: redacted.text.length > maxLength,
    redacted: redacted.redacted,
  };
}

export function redactTranscriptText(value: string): { text: string; redacted: boolean } {
  let text = value;
  text = text.replace(/SECRET_[A-Z0-9_]+/g, REDACTED);
  text = text.replace(/\bBearer\s+[^\s"',}]+/gi, `Bearer ${REDACTED}`);
  text = text.replace(TOKEN_PREFIX_PATTERN, REDACTED);
  text = text.replace(
    /(\b([A-Za-z][A-Za-z0-9_-]*)\b\s*=\s*)("(?:[^"\\]|\\.)*(?:"|$)|'(?:[^'\\]|\\.)*(?:'|$)|[^\s"',}]+)/g,
    (match: string, prefix: string, label: string, value: string) => redactKeyValueAssignment(match, prefix, label, value),
  );
  text = text.replace(
    /((?:"([A-Za-z][A-Za-z0-9_-]*)"|([A-Za-z][A-Za-z0-9_-]*))\s*:\s*)("[^"]*"|'[^']*'|[^\s"',}]+)/g,
    (match: string, prefix: string, quotedLabel: string | undefined, bareLabel: string | undefined) =>
      isSensitivePreviewKey(quotedLabel ?? bareLabel ?? "") ? `${prefix}"${REDACTED}"` : match,
  );
  return { text, redacted: text !== value };
}

export function sanitizePublicJson(value: unknown, maxStringLength = DEFAULT_PREVIEW_LENGTH, depth = 0): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return sanitizedPreviewValue(value, maxStringLength).preview ?? "";
  if (typeof value !== "object") return sanitizedPreviewValue(value, maxStringLength).preview ?? "";
  if (depth >= MAX_JSON_DEPTH) return sanitizedPreviewValue(value, maxStringLength).preview ?? "";
  if (Array.isArray(value)) return value.map((item) => sanitizePublicJson(item, maxStringLength, depth + 1));

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = isSensitivePreviewKey(key) ? REDACTED : sanitizePublicJson(item, maxStringLength, depth + 1);
  }
  return output;
}

export function sanitizeAgentEventForPublicOutput(event: AgentEvent): AgentEvent {
  switch (event.type) {
    case "progress":
      return withSanitizedAgentEventExtras({ ...event, message: sanitizedProgressMessage(event) });
    case "run_diagnostic":
      return withSanitizedAgentEventExtras({
        ...event,
        message: sanitizedPreviewValue(event.message).preview ?? "",
        ...(event.payload === undefined ? {} : { payload: sanitizePublicJson(event.payload) }),
      });
    case "completed":
      return withSanitizedAgentEventExtras({
        ...event,
        ...(event.message === undefined ? {} : { message: sanitizedPreviewValue(event.message).preview ?? "" }),
        ...(event.payload === undefined ? {} : { payload: sanitizePublicJson(event.payload) }),
      });
    case "failed":
      return withSanitizedAgentEventExtras({ ...event, error: sanitizedPreviewValue(event.error).preview ?? "" });
    case "rate_limits":
      return withSanitizedAgentEventExtras({ ...event, payload: sanitizePublicJson(event.payload) });
    case "provider_limit":
      return withSanitizedAgentEventExtras({ ...event, signal: sanitizePublicJson(event.signal) as typeof event.signal });
    default:
      return withSanitizedAgentEventExtras(event);
  }
}

function withSanitizedAgentEventExtras<T extends AgentEvent>(event: T): T {
  const runActivity = (event as { runActivity?: unknown }).runActivity;
  if (runActivity === undefined) return event;
  return { ...event, runActivity: sanitizeRunActivityForPublicOutput(runActivity) } as T;
}

function sanitizedProgressMessage(event: Extract<AgentEvent, { type: "progress" }>): string {
  const preview = event.activitySource === "delta" ? sanitizedDeltaTextValue(event.message) : sanitizedPreviewValue(event.message);
  return preview.preview ?? "";
}

function sanitizeRunActivityForPublicOutput(runActivity: unknown): unknown {
  const sanitized = sanitizePublicJson(runActivity, 1_000);
  if (!isRecord(runActivity) || !isRecord(sanitized) || !isAssistantDeltaRunActivity(runActivity)) return sanitized;

  const output: Record<string, unknown> = { ...sanitized };
  const text = sanitizedDeltaTextValue(runActivity.text, 1_000);
  if (text.preview !== null) output.text = text.preview;

  if (isRecord(runActivity.payload)) {
    const payload = isRecord(output.payload) ? { ...output.payload } : {};
    for (const key of ["messagePreview", "textPreview", "deltaPreview", "delta", "text", "message"]) {
      const value = runActivity.payload[key];
      if (typeof value !== "string") continue;
      payload[key] = sanitizedDeltaTextValue(value, 1_000).preview ?? "";
    }
    output.payload = payload;
  }

  return output;
}

function isAssistantDeltaRunActivity(value: Record<string, unknown>): boolean {
  const payload = isRecord(value.payload) ? value.payload : {};
  return (
    normalizePublicToken(value.actor) === "assistant" &&
    (normalizePublicToken(value.channel) === "chat" || normalizePublicToken(value.channel) === "message") &&
    (normalizePublicToken(value.kind) === "assistant_message_delta" || payload.delta === true)
  );
}

export function projectTranscriptEventForPublicRead(event: TranscriptEvent): TranscriptEvent {
  const assistantDelta = isTranscriptAssistantDeltaEvent(event);
  return {
    ...event,
    ...(event.message === undefined ? {} : { message: sanitizedEventMessageForPublicRead(event.message, assistantDelta) }),
    ...(event.payload === undefined ? {} : { payload: sanitizedEventPayloadForPublicRead(event.payload, assistantDelta) }),
  };
}

function sanitizedEventMessageForPublicRead(message: string, assistantDelta: boolean): string {
  const preview = assistantDelta ? sanitizedDeltaTextValue(message) : sanitizedPreviewValue(message);
  return preview.preview ?? "";
}

function sanitizedEventPayloadForPublicRead(payload: unknown, assistantDelta: boolean): unknown {
  if (!assistantDelta) return sanitizePublicJson(payload);
  const sanitized = sanitizePublicJson(payload);
  if (!isRecord(payload) || !isRecord(sanitized)) return sanitized;
  const output: Record<string, unknown> = { ...sanitized };
  for (const key of ["textPreview", "deltaPreview", "messagePreview", "delta", "text", "message"]) {
    const value = payload[key];
    if (typeof value !== "string") continue;
    output[key] = sanitizedDeltaTextValue(value).preview ?? "";
  }
  return output;
}

function isTranscriptAssistantDeltaEvent(event: TranscriptEvent): boolean {
  const eventType = normalizePublicToken(event.eventType);
  const payload = isRecord(event.payload) ? event.payload : {};
  const payloadKind = normalizePublicToken(payload.kind) ?? normalizePublicToken(payload.type);
  const actor = normalizePublicToken(payload.actor);
  const channel = normalizePublicToken(payload.channel);
  const activitySource = normalizePublicToken(payload.activitySource) ?? normalizePublicToken(payload.activity_source);
  const progressKind = normalizePublicToken(payload.progressKind) ?? normalizePublicToken(payload.progress_kind);
  const assistantChannel = channel === "message" || channel === "chat" || channel === "assistant";
  return (
    eventType === "message_delta" ||
    eventType === "assistant_delta" ||
    eventType === "assistant_message_delta" ||
    eventType === "response_delta" ||
    payloadKind === "assistant_delta" ||
    payloadKind === "assistant_message_delta" ||
    payloadKind === "response_delta" ||
    (payloadKind === "progress" && actor === "assistant" && assistantChannel && payload.delta === true) ||
    (payloadKind === "progress" && (activitySource === "delta" || progressKind === "assistant_delta"))
  );
}

function safeJsonPreview(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function redactKeyValueAssignment(match: string, prefix: string, label: string, value: string): string {
  if (!isSensitivePreviewKey(label)) return match;
  const quote = value[0] === '"' || value[0] === "'" ? value[0] : "";
  if (!quote) return `${prefix}${REDACTED}`;
  return `${prefix}${quote}${REDACTED}${value.endsWith(quote) ? quote : ""}`;
}

function normalizeSensitiveLabel(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function normalizePublicToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSensitivePreviewKey(key: string): boolean {
  const normalized = normalizeSensitiveLabel(key);
  if (SAFE_NORMALIZED_KEYS.has(normalized)) return false;
  if (SENSITIVE_NORMALIZED_KEYS.has(normalized)) return true;
  return (
    (normalized.endsWith("token") && !normalized.endsWith("tokens")) ||
    normalized.endsWith("secret") ||
    normalized.endsWith("privatekey") ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("accesskey") ||
    normalized.endsWith("accesskeyid")
  );
}

import type { AgentEvent } from "../harness/AgentHarness.js";
import type { TranscriptEvent } from "../persistence/RunTranscriptStore.js";

const DEFAULT_PREVIEW_LENGTH = 500;
const MAX_JSON_DEPTH = 8;
const REDACTED = "[redacted]";
const SENSITIVE_KEY_PATTERN = /^(?:api[_-]?key|apikey|token|secret|password|authorization)$/i;

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

export function redactTranscriptText(value: string): { text: string; redacted: boolean } {
  let text = value;
  text = text.replace(/SECRET_[A-Z0-9_]+/g, REDACTED);
  text = text.replace(/\bBearer\s+[^\s"',}]+/gi, `Bearer ${REDACTED}`);
  text = text.replace(
    /(\b(?:api[_-]?key|apikey|token|secret|password|authorization)\b\s*=\s*)([^\s"',}]+)/gi,
    `$1${REDACTED}`,
  );
  text = text.replace(
    /((?:"(?:api[_-]?key|apikey|token|secret|password|authorization)"|(?:api[_-]?key|apikey|token|secret|password|authorization))\s*:\s*)("[^"]*"|'[^']*'|[^\s"',}]+)/gi,
    `$1"${REDACTED}"`,
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
    output[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : sanitizePublicJson(item, maxStringLength, depth + 1);
  }
  return output;
}

export function sanitizeAgentEventForPublicOutput(event: AgentEvent): AgentEvent {
  switch (event.type) {
    case "progress":
      return { ...event, message: sanitizedPreviewValue(event.message).preview ?? "" };
    case "run_diagnostic":
      return {
        ...event,
        message: sanitizedPreviewValue(event.message).preview ?? "",
        ...(event.payload === undefined ? {} : { payload: sanitizePublicJson(event.payload) }),
      };
    case "completed":
      return event.message === undefined ? event : { ...event, message: sanitizedPreviewValue(event.message).preview ?? "" };
    case "failed":
      return { ...event, error: sanitizedPreviewValue(event.error).preview ?? "" };
    case "rate_limits":
      return { ...event, payload: sanitizePublicJson(event.payload) };
    default:
      return event;
  }
}

export function projectTranscriptEventForPublicRead(event: TranscriptEvent): TranscriptEvent {
  return {
    ...event,
    ...(event.message === undefined ? {} : { message: sanitizedPreviewValue(event.message).preview ?? "" }),
    ...(event.payload === undefined ? {} : { payload: sanitizePublicJson(event.payload) }),
  };
}

function safeJsonPreview(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

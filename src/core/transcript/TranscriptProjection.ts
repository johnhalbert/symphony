import type { AgentEvent } from "../harness/AgentHarness.js";
import type {
  PersistedCommandPolicyDecisionRecord,
  PersistedCommandPolicyReplayState,
  TranscriptEvent,
} from "../persistence/RunTranscriptStore.js";

const DEFAULT_PREVIEW_LENGTH = 500;
const MAX_JSON_DEPTH = 8;
const REDACTED = "[redacted]";
const REDACTED_COMMAND_PAYLOAD = "[redacted command payload]";
const REDACTED_ENVIRONMENT_VALUES = "[redacted environment values]";
const REDACTED_HELPER_PATH = "[redacted helper path]";
const TOKEN_PREFIX_PATTERN = /\b(?:ghp_[A-Za-z0-9_]{8,}|sk-[A-Za-z0-9_-]{8,})\b/g;
const URL_USERINFO_PATTERN = /\b((?:https?|ssh|git):\/\/)([^\s/@"']+(?::[^\s/@"']*)?)@/gi;
const SENSITIVE_NORMALIZED_KEYS = new Set([
  "apikey",
  "authorization",
  "credential",
  "token",
  "secret",
  "password",
  "accesstoken",
  "refreshtoken",
  "ghtoken",
  "ghpat",
  "githubtoken",
  "githubpat",
  "githubcredentials",
  "githubappprivatekey",
  "githubprivatekey",
  "gitaskpass",
  "gitcredentialhelper",
  "gitssh",
  "gitsshcommand",
  "sshaskpass",
  "clientsecret",
  "privatekey",
]);
const SAFE_NORMALIZED_KEYS = new Set(["tokens", "inputtokens", "outputtokens", "totaltokens", "tokenconfigured"]);
const COMMAND_POLICY_RAW_PROTOCOL_KEYS = new Set(["raw", "rawpayload", "protocolpayload", "jsonrpc", "rpcerror"]);
const COMMAND_POLICY_COMMAND_VALUE_KEYS = new Set([
  "args",
  "argspreview",
  "arguments",
  "argumentspreview",
  "cmd",
  "code",
  "command",
  "commandpayload",
  "commandpreview",
  "input",
  "inputpreview",
  "params",
  "parameters",
  "rawcommand",
  "rawcommandpayload",
  "rawinput",
  "rawinputpreview",
  "toolinput",
  "toolparams",
  "toolparameters",
]);
const COMMAND_POLICY_ENVIRONMENT_VALUE_KEYS = new Set([
  "env",
  "environ",
  "environment",
  "environmentvalues",
  "inheritedenvironment",
  "inlineenvironment",
  "processenv",
]);
const COMMAND_POLICY_HELPER_PATH_KEYS = new Set([
  "askpass",
  "askpasspath",
  "credentialhelper",
  "credentialhelpercommand",
  "credentialhelperpath",
  "credentialhelperpaths",
  "gitaskpass",
  "gitcredentialhelper",
  "gitssh",
  "gitsshcommand",
  "helper",
  "helpercommand",
  "helperpath",
  "helperpaths",
  "sshaskpass",
  "sshcommand",
]);

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
  text = text.replace(URL_USERINFO_PATTERN, `$1${REDACTED}@`);
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

export function sanitizeCommandPolicyPayloadForPublicOutput(
  value: unknown,
  maxStringLength = DEFAULT_PREVIEW_LENGTH,
): unknown {
  const sanitized = sanitizePublicJson(value, maxStringLength);
  const publicPayload = sanitizeCommandPolicyPublicValue(sanitized, null, 0);
  if (!isRecord(publicPayload)) return publicPayload;

  const output: Record<string, unknown> = { ...publicPayload, redacted: true };
  const audit: Record<string, unknown> | null = isRecord(output.audit) ? { ...output.audit, redacted: true } : null;
  if (audit) {
    if ("rawInputPreview" in audit) audit.rawInputPreviewRedacted = true;
    output.audit = audit;
  }
  return output;
}

export function sanitizeCommandPolicyReplayStateForPublicOutput(
  value: PersistedCommandPolicyReplayState,
): PersistedCommandPolicyReplayState {
  return {
    ...value,
    decisions: value.decisions.map(
      (decision) => sanitizeCommandPolicyPayloadForPublicOutput(decision, 1_000) as PersistedCommandPolicyDecisionRecord,
    ),
    malformedEvents: sanitizePublicJson(value.malformedEvents, 1_000) as PersistedCommandPolicyReplayState["malformedEvents"],
  };
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
  if (isCommandPolicyRunActivity(runActivity)) {
    const sanitized = sanitizePublicJson(runActivity, 1_000);
    if (!isRecord(runActivity) || !isRecord(sanitized)) return sanitized;
    const output: Record<string, unknown> = { ...sanitized };
    output.payload = sanitizeCommandPolicyPayloadForPublicOutput(runActivity.payload, 1_000);
    const text = sanitizedPreviewValue(runActivity.text, 1_000);
    if (text.preview !== null) output.text = text.preview;
    return output;
  }

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

function isCommandPolicyRunActivity(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return normalizePublicToken(value.kind) === "command_policy_decision" || isCommandPolicyPayload(value.payload);
}

function isCommandPolicyTranscriptEvent(event: TranscriptEvent): boolean {
  return normalizePublicToken(event.eventType) === "command_policy_decision" || isCommandPolicyPayload(event.payload);
}

function isCommandPolicyPayload(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const kind = normalizePublicToken(value.kind) ?? normalizePublicToken(value.type);
  return (
    kind === "command_policy_decision" ||
    (typeof value.outcome === "string" &&
      typeof value.reasonKind === "string" &&
      typeof value.role === "string" &&
      typeof value.phase === "string" &&
      typeof value.surface === "string")
  );
}

export function projectTranscriptEventForPublicRead(event: TranscriptEvent): TranscriptEvent {
  const assistantDelta = isTranscriptAssistantDeltaEvent(event);
  return {
    ...event,
    ...(event.message === undefined ? {} : { message: sanitizedEventMessageForPublicRead(event.message, assistantDelta) }),
    ...(event.payload === undefined ? {} : { payload: sanitizedEventPayloadForPublicRead(event.payload, assistantDelta, event) }),
  };
}

function sanitizedEventMessageForPublicRead(message: string, assistantDelta: boolean): string {
  const preview = assistantDelta ? sanitizedDeltaTextValue(message) : sanitizedPreviewValue(message);
  return preview.preview ?? "";
}

function sanitizedEventPayloadForPublicRead(payload: unknown, assistantDelta: boolean, event: TranscriptEvent): unknown {
  if (isCommandPolicyTranscriptEvent(event) || isCommandPolicyPayload(payload)) return sanitizeCommandPolicyPayloadForPublicOutput(payload);
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

function sanitizeCommandPolicyPublicValue(value: unknown, key: string | null, depth: number): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;

  const normalizedKey = key === null ? null : normalizeSensitiveLabel(key);
  if (normalizedKey !== null) {
    if (COMMAND_POLICY_RAW_PROTOCOL_KEYS.has(normalizedKey)) return undefined;
    if (COMMAND_POLICY_COMMAND_VALUE_KEYS.has(normalizedKey)) return value === null ? null : REDACTED_COMMAND_PAYLOAD;
    if (COMMAND_POLICY_ENVIRONMENT_VALUE_KEYS.has(normalizedKey)) return value === null ? null : REDACTED_ENVIRONMENT_VALUES;
    if (COMMAND_POLICY_HELPER_PATH_KEYS.has(normalizedKey)) return value === null ? null : REDACTED_HELPER_PATH;
  }

  if (typeof value === "string") return sanitizedPreviewValue(value).preview ?? "";
  if (typeof value !== "object") return sanitizedPreviewValue(value).preview ?? "";
  if (depth >= MAX_JSON_DEPTH) return sanitizedPreviewValue(value).preview ?? "";
  if (Array.isArray(value)) return value.map((item) => sanitizeCommandPolicyPublicValue(item, key, depth + 1));

  const output: Record<string, unknown> = {};
  for (const [childKey, item] of Object.entries(value)) {
    const child = sanitizeCommandPolicyPublicValue(item, childKey, depth + 1);
    if (child !== undefined) output[childKey] = child;
  }
  return output;
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
    normalized.endsWith("credential") ||
    normalized.endsWith("credentials") ||
    normalized.endsWith("privatekey") ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("accesskey") ||
    normalized.endsWith("accesskeyid")
  );
}

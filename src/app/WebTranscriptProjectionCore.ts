// Shared pure transcript projector so web tests can consume the same realistic fixture/projection path as the root app/tests.

const DEFAULT_PREVIEW_LENGTH = 500;
const MAX_JSON_DEPTH = 8;
const REDACTED = "[redacted]";
const REDACTED_COMMAND_PAYLOAD = "[redacted command payload]";
const REDACTED_ENVIRONMENT_VALUES = "[redacted environment values]";
const REDACTED_HELPER_PATH = "[redacted helper path]";
const UNSAFE_TOOL_DETAIL_TEXT_FIELDS = [
  "argsPreview",
  "argumentsPreview",
  "inputPreview",
  "resultPreview",
  "outputPreview",
  "errorPreview",
  "summary",
] as const;
const TOKEN_PREFIX_PATTERN =
  /\b(?:ghp_[A-Za-z0-9_-]{8,}|gho_[A-Za-z0-9_-]{8,}|ghr_[A-Za-z0-9_-]{8,}|ghu_[A-Za-z0-9_-]{8,}|ghs_[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_-]{8,}|lin_[A-Za-z0-9_-]{8,}|sk(?:-|_)[A-Za-z0-9_-]{8,})\b/g;
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
const COMMAND_POLICY_DISPLAY_TEXT_FIELDS = ["message", "messagePreview", "text", "textPreview"] as const;
const COMMAND_POLICY_DISPLAY_TEXT_KEYS = new Set([
  "message",
  "messagepreview",
  "statustext",
  "statusmessage",
  "statusmessagepreview",
  "text",
  "textpreview",
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

function sanitizeCommandPolicyPublicValue(value: unknown, key: string | null, depth: number): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;

  const normalizedKey = key === null ? null : normalizeSensitiveLabel(key);
  if (normalizedKey !== null) {
    if (COMMAND_POLICY_RAW_PROTOCOL_KEYS.has(normalizedKey)) return undefined;
    if (COMMAND_POLICY_COMMAND_VALUE_KEYS.has(normalizedKey)) return value === null ? null : REDACTED_COMMAND_PAYLOAD;
    if (COMMAND_POLICY_ENVIRONMENT_VALUE_KEYS.has(normalizedKey)) return value === null ? null : REDACTED_ENVIRONMENT_VALUES;
    if (COMMAND_POLICY_HELPER_PATH_KEYS.has(normalizedKey)) return value === null ? null : REDACTED_HELPER_PATH;
    if (COMMAND_POLICY_DISPLAY_TEXT_KEYS.has(normalizedKey)) return value === null ? null : REDACTED_COMMAND_PAYLOAD;
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

export interface CommandPolicyStatusDetails {
  outcome?: string;
  reasonKind?: string;
  role?: string;
  phase?: string;
  surface?: string;
  commandClass?: string;
  upstreamContactAttempted?: boolean;
  requiresCodeChange?: boolean;
  requiresUserOrServiceFix?: boolean;
  requestKind?: string;
  hookAction?: string;
  permissionOutcome?: string;
}

export type TranscriptMessage =
  | {
      kind: "system";
      ts: string;
      model: string;
      cwd: string;
      workspace: string;
      session: string;
      tools: string[];
      note: string;
    }
  | { kind: "user"; ts: string; from: string; issue: string; text: string }
  | { kind: "assistant"; ts: string; text: string }
  | { kind: "thinking"; ts: string; text: string }
  | {
      kind: "tool_call";
      ts: string;
      call_id: string;
      name: string;
      status: string;
      args: Record<string, unknown>;
      result: string | null;
      output?: string | null;
      error?: string | null;
      truncated?: boolean;
    }
  | { kind: "status"; state: string; ts: string; text: string; policy?: CommandPolicyStatusDetails }
  | { kind: "task"; ts: string; title: string; desc: string }
  | { kind: "request"; ts: string; reason: string; q: string; actions: string[] };

export interface WebTranscriptEvent {
  runId: string;
  sequence: number;
  at: string;
  source: "harness" | "runtime" | "cursor" | "orchestrator";
  eventType: string;
  message?: string;
  payload?: unknown;
  payloadSchema?: string;
  payloadTruncated?: boolean;
  payloadByteLength?: number;
  rawPayloadRefId?: number | string | null;
}

export function projectWebTranscript(events: readonly WebTranscriptEvent[]): TranscriptMessage[] {
  return projectTranscriptEvents(events);
}

function projectTranscriptEvents(events: readonly WebTranscriptEvent[]): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  const toolMessageIndexByCallId = new Map<string, number>();
  const seenAssistantDeltaReplayKeys = new Set<string>();
  const assistantDeltaMirrorCounts = createAssistantDeltaMirrorCounts();
  let pendingAssistantDeltaIndex: number | null = null;

  const resetAssistantDeltaGroup = () => {
    pendingAssistantDeltaIndex = null;
    assistantDeltaMirrorCounts.runtime.clear();
    assistantDeltaMirrorCounts.harness.clear();
  };

  for (const event of events) {
    const harnessToolProgress = harnessToolProgressPreview(event);
    if (harnessToolProgress) {
      mergeHarnessToolProgressPreview(messages, harnessToolProgress);
      continue;
    }

    const projected = projectWebTranscriptEvent(event);
    if (projected === null) continue;
    if (projected.kind === "tool_call") {
      const existingIndex = toolMessageIndexByCallId.get(projected.call_id);
      if (existingIndex !== undefined) {
        const existing = messages[existingIndex];
        if (existing?.kind === "tool_call") messages[existingIndex] = mergeToolMessages(existing, projected);
      } else {
        toolMessageIndexByCallId.set(projected.call_id, messages.length);
        messages.push(projected);
      }
      resetAssistantDeltaGroup();
      continue;
    }

    if (projected.kind === "assistant" && isAssistantDeltaEvent(event)) {
      const replayKey = assistantDeltaReplayKey(event, projected.text);
      if (seenAssistantDeltaReplayKeys.has(replayKey)) continue;
      seenAssistantDeltaReplayKeys.add(replayKey);
      const mirrorSource = assistantDeltaMirrorSource(event);
      if (mirrorSource && consumeAssistantDeltaMirror(mirrorSource, projected.text, assistantDeltaMirrorCounts)) continue;
      if (pendingAssistantDeltaIndex !== null) {
        const existing = messages[pendingAssistantDeltaIndex];
        if (existing?.kind === "assistant") {
          messages[pendingAssistantDeltaIndex] = {
            ...existing,
            text: combineAssistantDeltaText(existing.text, projected.text, assistantDeltaJoinMode(event)),
          };
          continue;
        }
      }
      pendingAssistantDeltaIndex = messages.length;
      messages.push(projected);
      continue;
    }

    if (projected.kind === "assistant" && isAssistantCompleteEvent(event) && pendingAssistantDeltaIndex !== null) {
      const existing = messages[pendingAssistantDeltaIndex];
      if (existing?.kind === "assistant") {
        messages[pendingAssistantDeltaIndex] = projected;
        resetAssistantDeltaGroup();
        continue;
      }
    }

    messages.push(projected);
    resetAssistantDeltaGroup();
  }

  return messages;
}

function mergeHarnessToolProgressPreview(
  messages: TranscriptMessage[],
  progress: { name: string; preview: string; truncated: boolean },
): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.kind !== "tool_call" || message.name !== progress.name) continue;
    if (Object.keys(message.args).length > 0) return;
    messages[index] = {
      ...message,
      args: { preview: progress.preview },
      ...(message.truncated || progress.truncated ? { truncated: true } : {}),
    };
    return;
  }
}

function projectWebTranscriptEvent(event: WebTranscriptEvent): TranscriptMessage | null {
  const eventType = normalizeToken(event.eventType);
  const payload = sanitizedPayloadRecord(event);
  const payloadKind = normalizedPayloadKind(payload);
  const activitySource = normalizedActivitySource(payload);
  if (isHiddenMetadataEvent(event, eventType, payloadKind, activitySource, payload)) return null;
  if (isToolEvent(eventType, payloadKind, payload)) return projectToolCallMessage(event, payload, eventType);
  if (isCommandPolicyDecisionEvent(eventType, payloadKind, payload)) return projectCommandPolicyStatusMessage(event, payload);
  if (isDiagnosticEvent(eventType, payloadKind)) return projectDiagnosticStatusMessage(event, payload, eventType);
  if (isTokenUsageEvent(eventType, payloadKind) && isDisplayableTokenStatusEvent(event, payload)) {
    return projectTokenUsageStatusMessage(event, payload, eventType);
  }
  if (isProviderLimitEvent(eventType, payloadKind)) return projectProviderLimitStatusMessage(event, payload, eventType);
  if (isRateLimitEvent(eventType, payloadKind)) return projectRateLimitStatusMessage(event, payload, eventType);
  if (isTerminalStatusEvent(eventType)) return projectTerminalStatusMessage(event, payload, eventType);
  if (isLegacyAcpProtocolEvent(eventType)) {
    return { ...projectStatusMessage(event, payload, "runtime_diagnostic"), state: "runtime_diagnostic" };
  }
  if (isThinkingEvent(eventType, payloadKind)) return { kind: "thinking", ts: event.at, text: thinkingText(event, payload) };
  if (isTaskEvent(eventType, payloadKind)) return projectTaskMessage(event, payload);
  if (isRequestEvent(eventType, payloadKind)) return projectRequestMessage(event, payload);
  if (isUserEvent(eventType, payloadKind)) return projectUserMessage(event, payload);
  if (isSystemEvent(eventType, payloadKind)) return projectSystemMessage(event, payload);
  if (isStatusEvent(eventType, payloadKind, payload)) return projectStatusMessage(event, payload, eventType);
  if (isAssistantEvent(event, eventType, payloadKind, payload)) {
    const isDelta = isAssistantDeltaEventParts(eventType, payloadKind, payload);
    const text = isDelta ? assistantDeltaText(event, payload) : assistantMessageText(event, payload);
    if (isDelta && text.length === 0) return null;
    return { kind: "assistant", ts: event.at, text };
  }
  return projectStatusMessage(event, payload, eventType);
}

function projectToolCallMessage(event: WebTranscriptEvent, payload: Record<string, unknown>, eventType: string): TranscriptMessage {
  const progressTool = progressToolSummary(event, payload);
  const unsafeToolDetails = payload.unsafeToolDetails === true && payload.redacted === false;
  const argsPreview = firstToolDetailPreview(
    unsafeToolDetails,
    payload.argumentsPreview,
    payload.argsPreview,
    payload.inputPreview,
    payload.args,
    payload.arguments,
    payload.input,
  );
  const resultPreview = firstToolDetailPreview(unsafeToolDetails, payload.resultPreview, payload.result, payload.summary);
  const outputPreview = firstToolDetailPreview(unsafeToolDetails, payload.outputPreview, payload.output);
  const errorPreview = firstToolDetailPreview(unsafeToolDetails, payload.errorPreview, payload.error);
  return {
    kind: "tool_call",
    ts: event.at,
    call_id: firstCleanString(payload.call_id, payload.callId, payload.toolCallId, payload.id, payload.toolId, payload.tool_id) ?? `${event.runId}:${event.sequence}`,
    name: firstCleanString(payload.name, payload.tool, payload.toolName, progressTool?.name) ?? event.eventType,
    status: inferredToolStatus(eventType, payload, errorPreview !== null, progressTool?.status),
    args: argsPreview ? { preview: argsPreview.preview } : {},
    result: resultPreview?.preview ?? outputPreview?.preview ?? errorPreview?.preview ?? null,
    ...(outputPreview ? { output: outputPreview.preview } : {}),
    ...(errorPreview ? { error: errorPreview.preview } : {}),
    ...(payload.truncated === true || argsPreview?.truncated || resultPreview?.truncated || outputPreview?.truncated || errorPreview?.truncated
      ? { truncated: true }
      : {}),
  };
}

function mergeToolMessages(existing: Extract<TranscriptMessage, { kind: "tool_call" }>, next: Extract<TranscriptMessage, { kind: "tool_call" }>): TranscriptMessage {
  return {
    kind: "tool_call",
    ts: existing.ts,
    call_id: existing.call_id,
    name: next.name && next.name !== "unknown" ? next.name : existing.name,
    status: mergeToolStatus(existing.status, next.status),
    args: Object.keys(next.args).length > 0 ? next.args : existing.args,
    result: next.result ?? existing.result,
    ...(next.output !== undefined || existing.output !== undefined ? { output: next.output ?? existing.output ?? null } : {}),
    ...(next.error !== undefined || existing.error !== undefined ? { error: next.error ?? existing.error ?? null } : {}),
    ...(existing.truncated || next.truncated ? { truncated: true } : {}),
  };
}

function mergeToolStatus(existingStatus: string, nextStatus: string): string {
  if (!nextStatus || nextStatus === "unknown") return existingStatus;
  if (nextStatus === "running" && existingStatus && existingStatus !== "unknown") return existingStatus;
  return nextStatus;
}

function inferredToolStatus(
  eventType: string,
  payload: Record<string, unknown>,
  hasErrorPreview: boolean,
  fallbackStatus?: string | null,
): string {
  const explicit = firstCleanString(payload.status, payload.state);
  if (explicit) return explicit;
  if (fallbackStatus) return fallbackStatus;
  if (eventType.includes("start") || eventType.includes("progress")) return "running";
  if (eventType.includes("complete") || eventType.includes("completed") || eventType.includes("finish")) {
    return hasErrorPreview ? "failed" : "completed";
  }
  return "unknown";
}

function projectTaskMessage(event: WebTranscriptEvent, payload: Record<string, unknown>): TranscriptMessage {
  return {
    kind: "task",
    ts: event.at,
    title: firstCleanString(payload.title, payload.name, payload.status) ?? event.eventType,
    desc: eventText(event, payload),
  };
}

function projectRequestMessage(event: WebTranscriptEvent, payload: Record<string, unknown>): TranscriptMessage {
  return {
    kind: "request",
    ts: event.at,
    reason: firstCleanString(payload.reason, payload.status, payload.type) ?? event.eventType,
    q: firstCleanString(payload.prompt, payload.question, payload.q) ?? eventText(event, payload),
    actions: actionLabels(payload.actions),
  };
}

function projectUserMessage(event: WebTranscriptEvent, payload: Record<string, unknown>): TranscriptMessage {
  return {
    kind: "user",
    ts: event.at,
    from: firstCleanString(payload.from, payload.actor, payload.source) ?? event.source,
    issue: firstCleanString(payload.issue, payload.issueIdentifier, payload.issueId) ?? "",
    text: firstCleanString(payload.prompt, payload.question, payload.q, payload.textPreview, payload.text, payload.message, event.message) ?? event.eventType,
  };
}

function projectSystemMessage(event: WebTranscriptEvent, payload: Record<string, unknown>): TranscriptMessage {
  return {
    kind: "system",
    ts: event.at,
    model: firstCleanString(payload.model, payload.modelName, payload.runtimeModel, payload.cursorModel) ?? "",
    cwd: firstCleanString(payload.cwd, payload.workingDirectory, payload.profileDir) ?? "",
    workspace: firstCleanString(payload.workspace, payload.workspaceKey, payload.workspacePath, payload.templateDir) ?? "",
    session: firstCleanString(payload.session, payload.sessionId, payload.gatewaySessionId, payload.threadId) ?? event.runId,
    tools: stringLabels(payload.tools),
    note: firstCleanString(payload.note, payload.messagePreview, payload.summary, payload.subtype, event.message) ?? event.eventType,
  };
}

function projectStatusMessage(
  event: WebTranscriptEvent,
  payload: Record<string, unknown>,
  eventType: string,
): Extract<TranscriptMessage, { kind: "status" }> {
  return {
    kind: "status",
    state: firstCleanString(payload.state, payload.status, payload.subtype, payload.kind) ?? eventType,
    ts: event.at,
    text: eventText(event, payload),
  };
}

function projectCommandPolicyStatusMessage(
  event: WebTranscriptEvent,
  payload: Record<string, unknown>,
): Extract<TranscriptMessage, { kind: "status" }> {
  const policy = commandPolicyStatusDetails(payload);
  return {
    kind: "status",
    state: "command_policy_decision",
    ts: event.at,
    text: commandPolicyStatusFallbackText(policy),
    policy,
  };
}

function commandPolicyStatusDetails(payload: Record<string, unknown>): CommandPolicyStatusDetails {
  const details: CommandPolicyStatusDetails = {};
  const outcome = firstCleanString(payload.outcome);
  const reasonKind = firstCleanString(payload.reasonKind, payload.reason_kind);
  const role = firstCleanString(payload.role);
  const phase = firstCleanString(payload.phase);
  const surface = firstCleanString(payload.surface);
  const commandClass = firstCleanString(payload.commandClass, payload.command_class);
  const requestKind = firstCleanString(payload.requestKind, payload.request_kind);
  const hookAction = firstCleanString(payload.hookAction, payload.hook_action);
  const permissionOutcome = firstCleanString(payload.permissionOutcome, payload.permission_outcome);
  const upstreamContactAttempted = booleanFromUnknown(payload.upstreamContactAttempted ?? payload.upstream_contact_attempted);
  const requiresCodeChange = booleanFromUnknown(payload.requiresCodeChange ?? payload.requires_code_change);
  const requiresUserOrServiceFix = booleanFromUnknown(payload.requiresUserOrServiceFix ?? payload.requires_user_or_service_fix);

  if (outcome) details.outcome = outcome;
  if (reasonKind) details.reasonKind = reasonKind;
  if (role) details.role = role;
  if (phase) details.phase = phase;
  if (surface) details.surface = surface;
  if (commandClass) details.commandClass = commandClass;
  if (upstreamContactAttempted !== null) details.upstreamContactAttempted = upstreamContactAttempted;
  if (requiresCodeChange !== null) details.requiresCodeChange = requiresCodeChange;
  if (requiresUserOrServiceFix !== null) details.requiresUserOrServiceFix = requiresUserOrServiceFix;
  if (requestKind) details.requestKind = requestKind;
  if (hookAction) details.hookAction = hookAction;
  if (permissionOutcome) details.permissionOutcome = permissionOutcome;
  return details;
}

function commandPolicyStatusFallbackText(policy: CommandPolicyStatusDetails): string {
  const outcome = policy.outcome ?? "decision";
  const reason = policy.reasonKind ? `: ${policy.reasonKind}` : "";
  const scope = compactStrings([policy.role, policy.phase, policy.surface]).join(" · ");
  return `Command policy ${outcome}${reason}${scope ? ` (${scope})` : ""}`;
}

function projectDiagnosticStatusMessage(
  event: WebTranscriptEvent,
  payload: Record<string, unknown>,
  eventType: string,
): TranscriptMessage {
  return {
    kind: "status",
    state: firstCleanString(payload.code, payload.diagnosticCode, payload.state, payload.status) ?? eventType,
    ts: event.at,
    text: firstCleanString(payload.message, payload.messagePreview, payload.textPreview, event.message) ?? eventText(event, payload),
  };
}

function projectTokenUsageStatusMessage(
  event: WebTranscriptEvent,
  payload: Record<string, unknown>,
  eventType: string,
): TranscriptMessage {
  const tokens = tokenCountsFrom(payload.tokens) ?? tokenCountsFrom(payload.usage) ?? tokenCountsFrom(payload);
  const tokenText = tokens ? formatTokenCounts(tokens) : null;
  return {
    kind: "status",
    state: firstCleanString(payload.state, payload.status, payload.kind, payload.type) ?? "tokens",
    ts: event.at,
    text: tokenText ? `Tokens: ${tokenText}` : eventText(event, payload) || eventType,
  };
}

function projectProviderLimitStatusMessage(
  event: WebTranscriptEvent,
  payload: Record<string, unknown>,
  eventType: string,
): TranscriptMessage {
  const signal = providerLimitSignal(payload);
  const scope = recordValue(signal?.scope) ?? recordValue(payload.scope);
  const window = recordValue(signal?.window) ?? recordValue(payload.window);
  const kind = firstCleanString(signal?.kind, payload.limitKind, payload.providerLimitKind, payload.state, payload.status) ?? eventType;
  const message = firstCleanString(signal?.message, payload.message, event.message) ?? eventText(event, payload);
  const resumeAt = firstCleanString(window?.resumeAt, payload.resumeAt);
  const details = compactStrings([
    firstCleanString(scope?.providerId, scope?.provider, payload.providerId, payload.provider),
    firstCleanString(scope?.model, payload.model),
    resumeAt ? `resume ${resumeAt}` : null,
  ]);
  return {
    kind: "status",
    state: kind,
    ts: event.at,
    text: `Provider limit: ${message}${details.length > 0 ? ` (${details.join(" · ")})` : ""}`,
  };
}

function projectRateLimitStatusMessage(
  event: WebTranscriptEvent,
  payload: Record<string, unknown>,
  eventType: string,
): TranscriptMessage {
  const preview = firstPublicPreview(payload.payload, payload.rateLimits, payload.rate_limits, payload.limits);
  return {
    kind: "status",
    state: firstCleanString(payload.state, payload.status, payload.kind, payload.type) ?? "rate_limits",
    ts: event.at,
    text: preview?.preview ? `Rate limits: ${preview.preview}` : eventText(event, payload) || eventType,
  };
}

function projectTerminalStatusMessage(
  event: WebTranscriptEvent,
  payload: Record<string, unknown>,
  eventType: string,
): TranscriptMessage {
  return {
    kind: "status",
    state: eventType,
    ts: event.at,
    text: firstCleanString(payload.message, payload.error, payload.reason, event.message) ?? terminalStatusText(eventType),
  };
}


function isToolEvent(eventType: string, payloadKind: string | null, payload: Record<string, unknown>): boolean {
  return eventType.includes("tool") || payloadKindIncludes(payloadKind, "tool") || normalizedActivitySource(payload) === "tool";
}

function isThinkingEvent(eventType: string, payloadKind: string | null): boolean {
  return (
    eventType.includes("thinking") ||
    eventType.includes("reasoning") ||
    eventType.includes("thought") ||
    payloadKindIncludes(payloadKind, "thinking") ||
    payloadKindIncludes(payloadKind, "reasoning") ||
    payloadKindIncludes(payloadKind, "thought")
  );
}

function isTaskEvent(eventType: string, payloadKind: string | null): boolean {
  return eventType.includes("task") || payloadKindIncludes(payloadKind, "task");
}

function isRequestEvent(eventType: string, payloadKind: string | null): boolean {
  return (
    eventType === "approval_request" ||
    eventType === "human_required" ||
    eventType === "humanrequired" ||
    eventType === "request" ||
    payloadKindIncludes(payloadKind, "approval_request") ||
    payloadKindIncludes(payloadKind, "human_required") ||
    payloadKindIncludes(payloadKind, "humanrequired") ||
    payloadKindIncludes(payloadKind, "request")
  );
}

function isUserEvent(eventType: string, payloadKind: string | null): boolean {
  return (
    eventType === "user" ||
    eventType === "prompt" ||
    eventType === "user_prompt" ||
    eventType === "user_message_submitted" ||
    eventType === "user_message_chunk" ||
    payloadKind === "user" ||
    payloadKind === "user_message_submitted" ||
    payloadKind === "user_message_chunk"
  );
}

function isSystemEvent(eventType: string, payloadKind: string | null): boolean {
  return eventType === "system" || eventType === "session_info" || eventType === "hermes_profile" || payloadKind === "system";
}

function isStatusEvent(eventType: string, payloadKind: string | null, payload: Record<string, unknown>): boolean {
  if (isAssistantDeltaLikePayload(payloadKind, payload)) return false;
  return (
    eventType === "status" ||
    eventType === "status_update" ||
    eventType === "runtime_diagnostic" ||
    eventType === "diagnostic" ||
    eventType === "token_usage_reported" ||
    eventType === "token_budget_warning" ||
    eventType === "token_budget_exceeded" ||
    eventType === "rate_limit_updated" ||
    eventType === "provider_limit_updated" ||
    eventType === "run_cancelled" ||
    eventType === "run_canceled" ||
    eventType === "run_failed" ||
    eventType === "run_completed" ||
    eventType === "run_status" ||
    (eventType === "progress" && isStatusLikePayload(payloadKind, payload)) ||
    isStatusLikePayload(payloadKind, payload)
  );
}

function isHiddenMetadataEvent(
  event: WebTranscriptEvent,
  eventType: string,
  payloadKind: string | null,
  activitySource: string | null,
  payload: Record<string, unknown>,
): boolean {
  if (isTokenUsageEvent(eventType, payloadKind)) return !isDisplayableTokenStatusEvent(event, payload);
  if (isHarnessToolProgressMetadata(event, eventType, payloadKind, activitySource)) return true;
  return eventType === "session_started" || eventType === "run_status";
}

function isHarnessToolProgressMetadata(
  event: WebTranscriptEvent,
  eventType: string,
  payloadKind: string | null,
  activitySource: string | null,
): boolean {
  return event.source === "harness" && eventType === "progress" && (activitySource === "tool" || payloadKindIncludes(payloadKind, "tool"));
}

function isDisplayableTokenStatusEvent(event: WebTranscriptEvent, payload: Record<string, unknown>): boolean {
  const tokenCounts = tokenCountsFrom(payload.tokens) ?? tokenCountsFrom(payload.usage) ?? tokenCountsFrom(payload);
  if (tokenCounts) return true;
  return firstCleanString(payload.messagePreview, payload.textPreview, payload.summary, payload.message, event.message) !== null;
}

function isDiagnosticEvent(eventType: string, payloadKind: string | null): boolean {
  return eventType === "run_diagnostic" || payloadKindIncludes(payloadKind, "run_diagnostic") || payloadKind === "diagnostic";
}

function isCommandPolicyDecisionEvent(
  eventType: string,
  payloadKind: string | null,
  payload: Record<string, unknown>,
): boolean {
  const reasonKind = payload.reasonKind ?? payload.reason_kind;
  return (
    eventType === "command_policy_decision" ||
    payloadKind === "command_policy_decision" ||
    (typeof payload.outcome === "string" &&
      typeof reasonKind === "string" &&
      typeof payload.role === "string" &&
      typeof payload.phase === "string" &&
      typeof payload.surface === "string")
  );
}

function isTokenUsageEvent(eventType: string, payloadKind: string | null): boolean {
  return (
    eventType === "tokens" ||
    eventType === "token_usage" ||
    eventType === "token_usage_reported" ||
    eventType === "usage_update" ||
    payloadKind === "tokens" ||
    payloadKind === "token_usage" ||
    payloadKind === "token_usage_reported" ||
    payloadKind === "usage_update" ||
    payloadKindIncludes(payloadKind, "token_budget")
  );
}

function isProviderLimitEvent(eventType: string, payloadKind: string | null): boolean {
  return eventType === "provider_limit" || eventType === "provider_limit_updated" || payloadKindIncludes(payloadKind, "provider_limit");
}

function isRateLimitEvent(eventType: string, payloadKind: string | null): boolean {
  return (
    eventType === "rate_limit" ||
    eventType === "rate_limits" ||
    eventType === "rate_limit_updated" ||
    payloadKindIncludes(payloadKind, "rate_limit")
  );
}

function isTerminalStatusEvent(eventType: string): boolean {
  return eventType === "completed" || eventType === "failed" || eventType === "cancelled";
}

function isLegacyAcpProtocolEvent(eventType: string): boolean {
  return eventType === "acp_session_update" || eventType === "acp_permission_denied" || eventType === "acp_diagnostic" || eventType === "hermes_acp_profile";
}

function isAssistantEvent(
  event: WebTranscriptEvent,
  eventType: string,
  payloadKind: string | null,
  payload: Record<string, unknown>,
): boolean {
  if (eventType === "assistant" || payloadKind === "assistant") return true;
  if (isAssistantDeltaLikePayload(payloadKind, payload)) return true;
  if (
    eventType === "message_delta" ||
    eventType === "message_complete" ||
    eventType === "assistant_delta" ||
    eventType === "assistant_complete" ||
    eventType === "assistant_message_delta" ||
    eventType === "assistant_message_completed" ||
    eventType === "response_delta" ||
    eventType === "response_complete"
  ) {
    return true;
  }
  return event.source === "harness" && !isStatusLikePayload(payloadKind, payload) && eventType === "progress";
}

function isAssistantDeltaEvent(event: WebTranscriptEvent): boolean {
  const eventType = normalizeToken(event.eventType);
  const payload = sanitizedPayloadRecord(event);
  const payloadKind = normalizedPayloadKind(payload);
  return isAssistantDeltaEventParts(eventType, payloadKind, payload);
}

function isAssistantDeltaEventParts(
  eventType: string,
  payloadKind: string | null,
  payload: Record<string, unknown>,
): boolean {
  return (
    eventType === "message_delta" ||
    eventType === "assistant_delta" ||
    eventType === "assistant_message_delta" ||
    eventType === "response_delta" ||
    isAssistantDeltaLikePayload(payloadKind, payload)
  );
}

function assistantDeltaText(event: WebTranscriptEvent, payload: Record<string, unknown>): string {
  const rawPayload = firstDeltaTextFromRecord(rawPayloadRecord(event));
  if (rawPayload.foundCandidate) return rawPayload.text ?? "";
  const publicPayload = firstDeltaTextFromRecord(payload);
  if (publicPayload.foundCandidate) return publicPayload.text ?? "";
  if (isLabelOnlyRuntimeDeltaEvent(event)) return "";
  return firstDeltaText(event.message) ?? "";
}

type AssistantDeltaMirrorSource = "runtime" | "harness";

type AssistantDeltaMirrorCounts = Record<AssistantDeltaMirrorSource, Map<string, number>>;
const COMMON_SHORT_WORD_TOKENS = new Set([
  "a",
  "am",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "can",
  "do",
  "for",
  "get",
  "git",
  "go",
  "had",
  "has",
  "he",
  "her",
  "his",
  "i",
  "if",
  "in",
  "is",
  "it",
  "me",
  "my",
  "no",
  "not",
  "of",
  "on",
  "or",
  "our",
  "out",
  "pr",
  "run",
  "so",
  "the",
  "to",
  "up",
  "us",
  "use",
  "was",
  "we",
  "you",
]);
const KNOWN_LOWERCASE_WORDPIECE_PREFIXES = new Set(["lat", "orches", "rer"]);

function createAssistantDeltaMirrorCounts(): AssistantDeltaMirrorCounts {
  return { runtime: new Map<string, number>(), harness: new Map<string, number>() };
}

function assistantDeltaMirrorSource(event: WebTranscriptEvent): AssistantDeltaMirrorSource | null {
  const eventType = normalizeToken(event.eventType);
  const payload = sanitizedPayloadRecord(event);
  if (event.source === "runtime" && eventType === "message_delta") return "runtime";
  if (event.source === "harness" && eventType === "progress" && normalizedActivitySource(payload) === "delta") return "harness";
  return null;
}

function consumeAssistantDeltaMirror(source: AssistantDeltaMirrorSource, text: string, counts: AssistantDeltaMirrorCounts): boolean {
  const opposite = source === "runtime" ? "harness" : "runtime";
  const sourceCount = counts[source].get(text) ?? 0;
  const oppositeCount = counts[opposite].get(text) ?? 0;
  counts[source].set(text, sourceCount + 1);
  return oppositeCount > sourceCount;
}

function assistantDeltaReplayKey(event: WebTranscriptEvent, text: string): string {
  return `${event.runId}:${event.sequence}:${normalizeToken(event.eventType)}:${text}`;
}

function isAssistantCompleteEvent(event: WebTranscriptEvent): boolean {
  const eventType = normalizeToken(event.eventType);
  return (
    eventType === "message_complete" ||
    eventType === "assistant_complete" ||
    eventType === "assistant_message_completed" ||
    eventType === "response_complete" ||
    eventType === "completed"
  );
}

type AssistantDeltaJoinMode = "spaced" | "exact" | "token";

function assistantDeltaJoinMode(event: WebTranscriptEvent): AssistantDeltaJoinMode {
  const eventType = normalizeToken(event.eventType);
  const payload = sanitizedPayloadRecord(event);
  const payloadKind = normalizedPayloadKind(payload);
  if (eventType === "assistant_message_delta") return "exact";
  if (eventType === "progress" && normalizedActivitySource(payload) === "delta") {
    return payloadKind === "assistant_delta" || normalizedOptionalToken(payload.progressKind) === "assistant_delta" ? "token" : "exact";
  }
  if (eventType === "message_delta" && isHermesRuntimeMessageDelta(event, payload)) return "exact";
  if (eventType === "message_delta") return "token";
  return "spaced";
}

function isHermesRuntimeMessageDelta(event: WebTranscriptEvent, payload: Record<string, unknown>): boolean {
  return event.source === "runtime" && (typeof payload.harnessId === "string" || (typeof event.message === "string" && normalizeToken(event.message) === "hermes_message_delta"));
}

function combineAssistantDeltaText(existing: string, next: string, mode: AssistantDeltaJoinMode = "spaced"): string {
  if (existing.length === 0) return next;
  if (next.length === 0) return existing;
  if (mode === "exact" || (mode === "token" && shouldJoinTokenFragmentWithoutSpace(existing, next))) return existing + next;
  if (/\s$/.test(existing) || /^\s/.test(next)) return existing + next;
  return `${existing} ${next}`;
}

function shouldJoinTokenFragmentWithoutSpace(existing: string, next: string): boolean {
  const previous = lastNonWhitespaceToken(existing);
  if (!previous) return false;
  if (/^[,.;:!?)}\]]/.test(next)) return true;
  if (/^[’'][\p{L}]/u.test(next)) return true;
  if (next.startsWith("`") && hasOpenInlineCodeSpan(existing)) return true;
  if (next.startsWith('"') && hasOpenDoubleQuoteSpan(existing)) return true;
  if (/[({\[]$/.test(previous)) return true;
  if (previous.endsWith("`") && hasOpenInlineCodeSpan(existing)) return true;
  if (previous.endsWith('"') && hasOpenDoubleQuoteSpan(existing)) return true;
  if (hasOpenInlineCodeSpan(existing) && /^[\p{L}\p{N}_-]/u.test(next) && /[`./\\-]$/.test(previous)) return true;
  if (next === "-") return true;
  if (/^-[\p{L}\p{N}_]/u.test(next)) return true;
  if (/^[A-Z]{1,4}$/.test(previous) && /^[A-Z]$/.test(next)) return true;
  if (shouldJoinLowercaseWordpiece(previous, next)) return true;
  if (previous === "--" || previous.endsWith("-")) return true;
  if (/^[/\\]/.test(next) && /[\p{L}\p{N}._-]$/u.test(previous)) return true;
  if (/^\.[\p{L}\p{N}_-]/u.test(next) && /[\p{L}\p{N}_-]$/u.test(previous)) return true;
  if (/[/\\][\p{L}\p{N}._-]*$/u.test(previous) && /^[\p{L}\p{N}._-]+$/u.test(next)) return true;
  return false;
}

function lastNonWhitespaceToken(value: string): string | null {
  return value.match(/\S+$/)?.[0] ?? null;
}

function hasOpenInlineCodeSpan(value: string): boolean {
  const matches = value.match(/`/g);
  return matches !== null && matches.length % 2 === 1;
}

function hasOpenDoubleQuoteSpan(value: string): boolean {
  const matches = value.match(/"/g);
  return matches !== null && matches.length % 2 === 1;
}

function shouldJoinLowercaseWordpiece(previous: string, next: string): boolean {
  if (!/^[a-z]{2,8}$/.test(previous) || !/^[a-z]{2,8}$/.test(next)) return false;
  if (COMMON_SHORT_WORD_TOKENS.has(previous) || COMMON_SHORT_WORD_TOKENS.has(next)) return false;
  return KNOWN_LOWERCASE_WORDPIECE_PREFIXES.has(previous);
}

function isAssistantDeltaLikePayload(payloadKind: string | null, payload: Record<string, unknown>): boolean {
  const actor = normalizedOptionalToken(payload.actor);
  const channel = normalizedOptionalToken(payload.channel);
  const activitySource = normalizedOptionalToken(payload.activitySource);
  const progressKind = normalizedOptionalToken(payload.progressKind);
  const assistantChannel = channel === "message" || channel === "chat" || channel === "assistant";
  return (
    payloadKind === "assistant_delta" ||
    payloadKind === "assistant_message_delta" ||
    payloadKind === "response_delta" ||
    (payloadKind === "progress" && actor === "assistant" && assistantChannel && payload.delta === true) ||
    (payloadKind === "progress" && (activitySource === "delta" || progressKind === "assistant_delta"))
  );
}

function isStatusLikePayload(payloadKind: string | null, payload: Record<string, unknown>): boolean {
  const actor = normalizedOptionalToken(payload.actor);
  const channel = normalizedOptionalToken(payload.channel);
  const activitySource = normalizedOptionalToken(payload.activitySource);
  const progressKind = normalizedOptionalToken(payload.progressKind);
  return (
    payloadKind === "status" ||
    (payloadKind === "progress" &&
      (isStatusActivitySource(activitySource) ||
        payloadKindIncludes(progressKind, "token") ||
        payloadKindIncludes(progressKind, "rate_limit") ||
        payloadKindIncludes(progressKind, "provider_limit") ||
        payloadKindIncludes(progressKind, "runtime") ||
        payloadKindIncludes(progressKind, "diagnostic") ||
        payloadKindIncludes(progressKind, "run_"))) ||
    payloadKind === "usage" ||
    payloadKind === "diagnostic" ||
    payloadKind === "terminal" ||
    payloadKindIncludes(payloadKind, "token") ||
    payloadKindIncludes(payloadKind, "rate_limit") ||
    payloadKindIncludes(payloadKind, "provider_limit") ||
    payloadKindIncludes(payloadKind, "runtime") ||
    payloadKindIncludes(payloadKind, "diagnostic") ||
    payloadKindIncludes(payloadKind, "run_") ||
    actor === "runtime" ||
    channel === "status" ||
    channel === "token" ||
    channel === "runtime" ||
    channel === "terminal"
  );
}

function isStatusActivitySource(activitySource: string | null): boolean {
  return (
    activitySource === "status" ||
    activitySource === "runtime" ||
    activitySource === "telemetry" ||
    activitySource === "token" ||
    activitySource === "tokens" ||
    activitySource === "rate_limit" ||
    activitySource === "rate_limits" ||
    activitySource === "provider_limit" ||
    activitySource === "provider_limits"
  );
}

function normalizedOptionalToken(value: unknown): string | null {
  const text = firstCleanString(value);
  return text ? normalizeToken(text) : null;
}

function sanitizedPayloadRecord(event: WebTranscriptEvent): Record<string, unknown> {
  const eventType = normalizeToken(event.eventType);
  const rawPayload = rawPayloadRecord(event);
  const rawPayloadKind = normalizedPayloadKind(rawPayload);
  const payload = isCommandPolicyDecisionEvent(eventType, rawPayloadKind, rawPayload)
    ? sanitizeCommandPolicyPayloadForPublicOutput(event.payload)
    : isUnsafeToolDetailPayload(eventType, rawPayload)
      ? sanitizeUnsafeToolDetailPayload(rawPayload)
    : sanitizePublicJson(event.payload);
  return isRecord(payload) ? payload : {};
}

function rawPayloadRecord(event: WebTranscriptEvent): Record<string, unknown> {
  return isRecord(event.payload) ? event.payload : {};
}

function isUnsafeToolDetailPayload(eventType: string, payload: Record<string, unknown>): boolean {
  return (
    payload.unsafeToolDetails === true &&
    payload.redacted === false &&
    (eventType === "tool_start" || eventType === "tool_complete" || eventType === "tool_call" || eventType === "tool_call_update")
  );
}

function sanitizeUnsafeToolDetailPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizePublicJson(payload);
  const output: Record<string, unknown> = isRecord(sanitized) ? { ...sanitized } : {};
  output.unsafeToolDetails = true;
  output.redacted = false;
  for (const key of UNSAFE_TOOL_DETAIL_TEXT_FIELDS) {
    const value = payload[key];
    if (typeof value === "string") output[key] = unsafeToolDetailText(value);
  }
  return output;
}

function eventText(event: WebTranscriptEvent, payload: Record<string, unknown>): string {
  return (
    firstCleanString(payload.textPreview, payload.summary, payload.messagePreview, payload.text, payload.message, event.message) ??
    event.eventType
  );
}

function thinkingText(event: WebTranscriptEvent, payload: Record<string, unknown>): string {
  return (
    firstCleanString(
      payload.summary,
      payload.reasoningPreview,
      payload.thoughtPreview,
      payload.messagePreview,
      payload.textPreview,
      payload.text,
      payload.message,
      event.message,
    ) ?? event.eventType
  );
}

function terminalStatusText(eventType: string): string {
  switch (eventType) {
    case "completed":
      return "Run completed";
    case "failed":
      return "Run failed";
    case "cancelled":
      return "Run cancelled";
    default:
      return eventType;
  }
}

function actionLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const labels: string[] = [];
  for (const action of value) {
    const label = isRecord(action)
      ? firstCleanString(action.label, action.name, action.id, action.decision)
      : firstCleanString(action);
    if (label) labels.push(label);
  }
  return labels;
}

function stringLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const labels: string[] = [];
  for (const item of value) {
    const label = isRecord(item) ? firstCleanString(item.label, item.name, item.id) : firstCleanString(item);
    if (label) labels.push(label);
  }
  return labels;
}

function normalizedPayloadKind(payload: Record<string, unknown>): string | null {
  const kind = firstCleanString(payload.kind, payload.type);
  return kind ? normalizeToken(kind) : null;
}

function normalizedActivitySource(payload: Record<string, unknown>): string | null {
  const source = firstCleanString(payload.activitySource, payload.activity_source);
  return source ? normalizeToken(source) : null;
}

function payloadKindIncludes(payloadKind: string | null, token: string): boolean {
  return payloadKind?.includes(token) ?? false;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function booleanFromUnknown(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function firstDeltaText(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const preview = sanitizedDeltaTextValue(value).preview;
    if (preview !== null && preview.length > 0) return preview;
  }
  return null;
}

const ASSISTANT_DELTA_TEXT_KEYS = ["textPreview", "deltaPreview", "delta", "messagePreview", "text", "message"] as const;

interface AssistantDeltaTextLookup {
  foundCandidate: boolean;
  text: string | null;
}

function firstDeltaTextFromRecord(record: Record<string, unknown>): AssistantDeltaTextLookup {
  let foundCandidate = false;
  for (const key of ASSISTANT_DELTA_TEXT_KEYS) {
    const value = record[key];
    if (typeof value !== "string") continue;
    foundCandidate = true;
    const preview = sanitizedDeltaTextValue(value).preview;
    if (preview !== null && preview.length > 0) return { foundCandidate: true, text: preview };
  }
  return { foundCandidate, text: null };
}

const ASSISTANT_MESSAGE_TEXT_KEYS = ["textPreview", "summary", "messagePreview", "text", "message"] as const;

function assistantMessageText(event: WebTranscriptEvent, payload: Record<string, unknown>): string {
  return (
    firstDisplayTextFromRecord(rawPayloadRecord(event), ASSISTANT_MESSAGE_TEXT_KEYS) ??
    firstDisplayTextFromRecord(payload, ASSISTANT_MESSAGE_TEXT_KEYS) ??
    firstDisplayText(event.message) ??
    event.eventType
  );
}

function firstDisplayTextFromRecord(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    const preview = firstDisplayText(value);
    if (preview !== null) return preview;
  }
  return null;
}

function firstDisplayText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const preview = sanitizedDeltaTextValue(value).preview;
  return preview !== null && preview.length > 0 ? preview : null;
}

function isLabelOnlyRuntimeDeltaEvent(event: WebTranscriptEvent): boolean {
  return event.source === "runtime" && normalizeToken(event.eventType) === "message_delta" && normalizeToken(event.message ?? "") === "hermes_message_delta";
}

function firstCleanString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const preview = sanitizedPreviewValue(value).preview;
    if (preview && preview.length > 0) return preview;
  }
  return null;
}

function publicMultilineText(value: string, maxLength: number): string | null {
  const redacted = redactTranscriptText(value).text.replace(/\r\n/g, "\n").trim();
  if (redacted.length === 0) return null;
  if (redacted.length <= maxLength) return redacted;
  return `${redacted.slice(0, Math.max(maxLength - 15, 0))}...[truncated]`;
}


function progressToolSummary(
  event: WebTranscriptEvent,
  payload: Record<string, unknown>,
): { name: string | null; status: string | null } | null {
  if (normalizedActivitySource(payload) !== "tool") return null;
  const explicitName = firstCleanString(payload.name, payload.tool, payload.toolName);
  const message = firstCleanString(payload.message, event.message);
  const parsed = parseProgressToolMessage(message);
  return { name: explicitName ?? parsed.name ?? "tool", status: parsed.status ?? "running" };
}

function parseProgressToolMessage(message: string | null): { name: string | null; status: string | null } {
  if (!message) return { name: null, status: null };
  let text = message.replace(/^Hermes\s+(?:ACP\s+)?/i, "").trim();
  text = text.replace(/^tool\s+/i, "").trim();
  const statusMatch = text.match(/\(([^()]*)\)\s*$/);
  const statusText = statusMatch?.[1] ?? null;
  const status = statusText ? toolStatusFromText(statusText) ?? firstCleanString(statusText) : toolStatusFromText(text);
  if (statusMatch) text = text.slice(0, statusMatch.index).trim();
  const colonIndex = text.indexOf(":");
  if (colonIndex >= 0) {
    const before = text.slice(0, colonIndex).trim();
    const after = text.slice(colonIndex + 1).trim();
    text = toolStatusFromText(before) && after.length > 0 ? after : before;
  }
  text = text.replace(/\b(started|starting|running|completed|complete|finished|failed|error|cancelled|canceled)\b$/i, "").trim();
  return { name: firstCleanString(text), status };
}

function harnessToolProgressPreview(event: WebTranscriptEvent): { name: string; preview: string; truncated: boolean } | null {
  const eventType = normalizeToken(event.eventType);
  const payload = sanitizedPayloadRecord(event);
  const payloadKind = normalizedPayloadKind(payload);
  const activitySource = normalizedActivitySource(payload);
  if (!isHarnessToolProgressMetadata(event, eventType, payloadKind, activitySource)) return null;
  const message = firstCleanString(payload.messagePreview, payload.message, event.message);
  const preview = toolProgressDetailPreview(message);
  if (!preview) return null;
  const tool = progressToolSummary(event, payload);
  const name = tool?.name ?? "tool";
  return { name, preview, truncated: payload.truncated === true };
}

function toolProgressDetailPreview(message: string | null): string | null {
  if (!message) return null;
  let text = message.replace(/^Hermes\s+(?:ACP\s+)?/i, "").trim();
  text = text.replace(/^tool\s+/i, "").trim();
  const colonIndex = text.indexOf(":");
  if (colonIndex < 0) return null;
  const preview = text.slice(colonIndex + 1).trim();
  return firstCleanString(preview);
}

function toolStatusFromText(value: string): string | null {
  const token = normalizeToken(value);
  if (token.includes("fail") || token.includes("error")) return "failed";
  if (token.includes("cancel")) return "cancelled";
  if (token.includes("complete") || token.includes("finish") || token.includes("succeed")) return "completed";
  if (token.includes("start") || token.includes("running")) return "running";
  return null;
}

interface ProjectedTokenCounts {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

function tokenCountsFrom(value: unknown): ProjectedTokenCounts | null {
  if (!isRecord(value)) return null;
  const inputTokens = numberFromUnknown(value.inputTokens) ?? numberFromUnknown(value.input_tokens) ?? numberFromUnknown(value.input);
  const outputTokens = numberFromUnknown(value.outputTokens) ?? numberFromUnknown(value.output_tokens) ?? numberFromUnknown(value.output);
  const totalTokens = numberFromUnknown(value.totalTokens) ?? numberFromUnknown(value.total_tokens) ?? numberFromUnknown(value.total);
  if (inputTokens === null && outputTokens === null && totalTokens === null) return null;
  return {
    ...(inputTokens === null ? {} : { inputTokens }),
    ...(outputTokens === null ? {} : { outputTokens }),
    ...(totalTokens === null ? {} : { totalTokens }),
  };
}

function formatTokenCounts(tokens: ProjectedTokenCounts): string {
  return compactStrings([
    tokens.inputTokens === undefined ? null : `input ${tokens.inputTokens}`,
    tokens.outputTokens === undefined ? null : `output ${tokens.outputTokens}`,
    tokens.totalTokens === undefined ? null : `total ${tokens.totalTokens}`,
  ]).join(" · ");
}

function providerLimitSignal(payload: Record<string, unknown>): Record<string, unknown> | null {
  return recordValue(payload.signal) ?? recordValue(payload.providerLimit) ?? recordValue(payload.provider_limit) ?? null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function compactStrings(values: Array<string | null | undefined>): string[] {
  return values.filter((value): value is string => typeof value === "string" && value.length > 0);
}

function numberFromUnknown(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstPublicPreview(...values: unknown[]): { preview: string; truncated: boolean } | null {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const preview = sanitizedPreviewValue(value);
    if (preview.preview && preview.preview.length > 0) return { preview: preview.preview, truncated: preview.truncated };
  }
  return null;
}

function firstToolDetailPreview(unsafeToolDetails: boolean, ...values: unknown[]): { preview: string; truncated: boolean } | null {
  if (!unsafeToolDetails) return firstPublicPreview(...values);
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const preview = unsafeToolDetailText(value);
    if (preview.length > 0) return { preview, truncated: false };
  }
  return null;
}

function unsafeToolDetailText(value: unknown): string {
  const text = typeof value === "string" ? value : safeJsonPreview(value);
  return text.replace(/\r\n/g, "\n").trim();
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "status";
}

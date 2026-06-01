import { redactTranscriptText, sanitizePublicJson, sanitizedPreviewValue } from "../core/transcript/TranscriptProjection.js";
import type { RunRecord, TranscriptEvent } from "../core/persistence/RunTranscriptStore.js";

const USER_PROMPT_MAX_LENGTH = 5_000;

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
  | { kind: "status"; state: string; ts: string; text: string }
  | { kind: "task"; ts: string; title: string; desc: string }
  | { kind: "request"; ts: string; reason: string; q: string; actions: string[] };

export interface WebTranscriptProjectionOptions {
  run?: RunRecord | null;
  includeRunPrelude?: boolean;
}

export function projectWebTranscript(
  events: readonly TranscriptEvent[],
  options: WebTranscriptProjectionOptions = {},
): TranscriptMessage[] {
  const messages = projectTranscriptEvents(events);
  if (!options.run || options.includeRunPrelude === false) return messages;
  return [...projectRunPreludeMessages(options.run, messages), ...messages];
}

function projectTranscriptEvents(events: readonly TranscriptEvent[]): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  const toolMessageIndexByCallId = new Map<string, number>();
  const seenAssistantDeltaReplayKeys = new Set<string>();
  let pendingAssistantDeltaIndex: number | null = null;

  for (const event of events) {
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
      pendingAssistantDeltaIndex = null;
      continue;
    }

    if (projected.kind === "assistant" && isAssistantDeltaEvent(event)) {
      const replayKey = assistantDeltaReplayKey(event, projected.text);
      if (seenAssistantDeltaReplayKeys.has(replayKey)) continue;
      seenAssistantDeltaReplayKeys.add(replayKey);
      if (pendingAssistantDeltaIndex !== null) {
        const existing = messages[pendingAssistantDeltaIndex];
        if (existing?.kind === "assistant") {
          messages[pendingAssistantDeltaIndex] = {
            ...existing,
            text: combineAssistantDeltaText(existing.text, projected.text, shouldConcatenateAssistantDeltaExactly(event)),
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
        pendingAssistantDeltaIndex = null;
        continue;
      }
    }

    messages.push(projected);
    pendingAssistantDeltaIndex = null;
  }

  return messages;
}

function projectWebTranscriptEvent(event: TranscriptEvent): TranscriptMessage | null {
  const eventType = normalizeToken(event.eventType);
  const payload = sanitizedPayloadRecord(event);
  const payloadKind = normalizedPayloadKind(payload);
  const activitySource = normalizedActivitySource(payload);
  if (isHiddenMetadataEvent(eventType, payloadKind, activitySource)) return null;
  if (isDiagnosticEvent(eventType)) return projectDiagnosticStatusMessage(event, payload, eventType);
  if (isProviderLimitEvent(eventType)) return projectProviderLimitStatusMessage(event, payload, eventType);
  if (isTerminalStatusEvent(eventType)) return projectTerminalStatusMessage(event, payload, eventType);
  if (isLegacyAcpProtocolEvent(eventType)) {
    return { ...projectStatusMessage(event, payload, "runtime_diagnostic"), state: "runtime_diagnostic" };
  }
  if (isToolEvent(eventType, payloadKind)) return projectToolCallMessage(event, payload, eventType);
  if (isThinkingEvent(eventType, payloadKind)) return { kind: "thinking", ts: event.at, text: eventText(event, payload) };
  if (isTaskEvent(eventType, payloadKind)) return projectTaskMessage(event, payload);
  if (isRequestEvent(eventType, payloadKind)) return projectRequestMessage(event, payload);
  if (isUserEvent(eventType, payloadKind)) return projectUserMessage(event, payload);
  if (isSystemEvent(eventType, payloadKind)) return projectSystemMessage(event, payload);
  if (isStatusEvent(eventType, payloadKind, payload)) return projectStatusMessage(event, payload, eventType);
  if (isAssistantEvent(event, eventType, payloadKind, payload)) {
    const isDelta = isAssistantDeltaEventParts(eventType, payloadKind, payload);
    const text = isDelta ? assistantDeltaText(event, payload) : eventText(event, payload);
    if (isDelta && text.length === 0) return null;
    return { kind: "assistant", ts: event.at, text };
  }
  return projectStatusMessage(event, payload, eventType);
}

function projectToolCallMessage(event: TranscriptEvent, payload: Record<string, unknown>, eventType: string): TranscriptMessage {
  const argsPreview = firstPublicPreview(payload.argumentsPreview, payload.argsPreview, payload.inputPreview, payload.args, payload.arguments, payload.input);
  const resultPreview = firstPublicPreview(payload.resultPreview, payload.result, payload.summary);
  const outputPreview = firstPublicPreview(payload.outputPreview, payload.output);
  const errorPreview = firstPublicPreview(payload.errorPreview, payload.error);
  return {
    kind: "tool_call",
    ts: event.at,
    call_id: firstCleanString(payload.call_id, payload.callId, payload.toolCallId, payload.id, payload.toolId, payload.tool_id) ?? `${event.runId}:${event.sequence}`,
    name: firstCleanString(payload.name, payload.tool, payload.toolName) ?? event.eventType,
    status: inferredToolStatus(eventType, payload, errorPreview !== null),
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

function inferredToolStatus(eventType: string, payload: Record<string, unknown>, hasErrorPreview: boolean): string {
  const explicit = firstCleanString(payload.status, payload.state);
  if (explicit) return explicit;
  if (eventType.includes("start") || eventType.includes("progress")) return "running";
  if (eventType.includes("complete") || eventType.includes("completed") || eventType.includes("finish")) {
    return hasErrorPreview ? "failed" : "completed";
  }
  return "unknown";
}

function projectTaskMessage(event: TranscriptEvent, payload: Record<string, unknown>): TranscriptMessage {
  return {
    kind: "task",
    ts: event.at,
    title: firstCleanString(payload.title, payload.name, payload.status) ?? event.eventType,
    desc: eventText(event, payload),
  };
}

function projectRequestMessage(event: TranscriptEvent, payload: Record<string, unknown>): TranscriptMessage {
  return {
    kind: "request",
    ts: event.at,
    reason: firstCleanString(payload.reason, payload.status, payload.type) ?? event.eventType,
    q: firstCleanString(payload.prompt, payload.question, payload.q) ?? eventText(event, payload),
    actions: actionLabels(payload.actions),
  };
}

function projectUserMessage(event: TranscriptEvent, payload: Record<string, unknown>): TranscriptMessage {
  return {
    kind: "user",
    ts: event.at,
    from: firstCleanString(payload.from, payload.actor, payload.source) ?? event.source,
    issue: firstCleanString(payload.issue, payload.issueIdentifier, payload.issueId) ?? "",
    text: firstCleanString(payload.prompt, payload.question, payload.q, payload.textPreview, payload.text, payload.message, event.message) ?? event.eventType,
  };
}

function projectSystemMessage(event: TranscriptEvent, payload: Record<string, unknown>): TranscriptMessage {
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
  event: TranscriptEvent,
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

function projectDiagnosticStatusMessage(
  event: TranscriptEvent,
  payload: Record<string, unknown>,
  eventType: string,
): TranscriptMessage {
  return {
    kind: "status",
    state: firstCleanString(payload.code, payload.state, payload.status) ?? eventType,
    ts: event.at,
    text: firstCleanString(payload.message, payload.messagePreview, payload.textPreview, event.message) ?? eventText(event, payload),
  };
}

function projectProviderLimitStatusMessage(
  event: TranscriptEvent,
  payload: Record<string, unknown>,
  eventType: string,
): TranscriptMessage {
  const signal = isRecord(payload.signal) ? payload.signal : {};
  return {
    kind: "status",
    state: firstCleanString(signal.kind, payload.state, payload.status) ?? eventType,
    ts: event.at,
    text: firstCleanString(signal.message, payload.message, event.message) ?? "Provider limit reached",
  };
}

function projectTerminalStatusMessage(
  event: TranscriptEvent,
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

function projectRunPreludeMessages(run: RunRecord, existingMessages: readonly TranscriptMessage[]): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  if (!existingMessages.some((message) => message.kind === "system")) messages.push(projectRunSystemMessage(run));
  const promptText = publicMultilineText(run.prompt, USER_PROMPT_MAX_LENGTH);
  if (promptText && !existingMessages.some((message) => message.kind === "user")) {
    messages.push({
      kind: "user",
      ts: run.startedAt,
      from: "orchestrator",
      issue: firstCleanString(run.issueIdentifier, run.issueId) ?? "",
      text: promptText,
    });
  }
  return messages;
}

function projectRunSystemMessage(run: RunRecord): TranscriptMessage {
  const phase = firstCleanString(run.runPhase, run.runKind, run.role) ?? run.role;
  const note = `Initialized ${phase} run from persisted run metadata. System prompt redacted.`;
  return {
    kind: "system",
    ts: run.startedAt,
    model: firstCleanString(run.runtimeModel, run.cursorModel) ?? "",
    cwd: firstCleanString(run.workspacePath) ?? "",
    workspace: firstCleanString(run.workspaceKey) ?? "",
    session: firstCleanString(run.sessionId, run.runId) ?? run.runId,
    tools: [],
    note: firstCleanString(note) ?? note,
  };
}

function isToolEvent(eventType: string, payloadKind: string | null): boolean {
  return eventType.includes("tool") || payloadKindIncludes(payloadKind, "tool");
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
  return eventType === "user" || eventType === "prompt" || eventType === "user_prompt" || payloadKind === "user";
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

function isHiddenMetadataEvent(eventType: string, _payloadKind: string | null, activitySource: string | null): boolean {
  return (
    eventType === "session_started" ||
    eventType === "tokens" ||
    eventType === "rate_limits" ||
    eventType === "run_status" ||
    (eventType === "progress" && activitySource === "tool")
  );
}

function isDiagnosticEvent(eventType: string): boolean {
  return eventType === "run_diagnostic";
}

function isProviderLimitEvent(eventType: string): boolean {
  return eventType === "provider_limit";
}

function isTerminalStatusEvent(eventType: string): boolean {
  return eventType === "completed" || eventType === "failed" || eventType === "cancelled";
}

function isLegacyAcpProtocolEvent(eventType: string): boolean {
  return eventType === "acp_session_update" || eventType === "acp_permission_denied" || eventType === "acp_diagnostic" || eventType === "hermes_acp_profile";
}

function isAssistantEvent(
  event: TranscriptEvent,
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

function isAssistantDeltaEvent(event: TranscriptEvent): boolean {
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

function assistantDeltaText(event: TranscriptEvent, payload: Record<string, unknown>): string {
  return firstCleanString(payload.textPreview, payload.deltaPreview, payload.delta, payload.messagePreview, payload.text, payload.message, event.message) ?? "";
}

function assistantDeltaReplayKey(event: TranscriptEvent, text: string): string {
  return `${event.runId}:${event.sequence}:${normalizeToken(event.eventType)}:${text}`;
}

function isAssistantCompleteEvent(event: TranscriptEvent): boolean {
  const eventType = normalizeToken(event.eventType);
  return (
    eventType === "message_complete" ||
    eventType === "assistant_complete" ||
    eventType === "assistant_message_completed" ||
    eventType === "response_complete" ||
    eventType === "completed"
  );
}

function shouldConcatenateAssistantDeltaExactly(event: TranscriptEvent): boolean {
  return normalizeToken(event.eventType) === "progress" && normalizedActivitySource(sanitizedPayloadRecord(event)) === "delta";
}

function combineAssistantDeltaText(existing: string, next: string, exact = false): string {
  if (existing.length === 0) return next;
  if (next.length === 0) return existing;
  if (exact) return existing + next;
  if (/\s$/.test(existing) || /^\s/.test(next)) return existing + next;
  return `${existing} ${next}`;
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

function sanitizedPayloadRecord(event: TranscriptEvent): Record<string, unknown> {
  const payload = sanitizePublicJson(event.payload);
  return isRecord(payload) ? payload : {};
}

function eventText(event: TranscriptEvent, payload: Record<string, unknown>): string {
  return (
    firstCleanString(payload.textPreview, payload.summary, payload.messagePreview, payload.text, payload.message, event.message) ??
    event.eventType
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
  const source = firstCleanString(payload.activitySource);
  return source ? normalizeToken(source) : null;
}

function payloadKindIncludes(payloadKind: string | null, token: string): boolean {
  return payloadKind?.includes(token) ?? false;
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

function firstPublicPreview(...values: unknown[]): { preview: string; truncated: boolean } | null {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const preview = sanitizedPreviewValue(value);
    if (preview.preview && preview.preview.length > 0) return { preview: preview.preview, truncated: preview.truncated };
  }
  return null;
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "status";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import { sanitizePublicJson, sanitizedPreviewValue } from "../core/transcript/TranscriptProjection.js";
import type { TranscriptEvent } from "../core/persistence/RunTranscriptStore.js";

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

export function projectWebTranscript(events: readonly TranscriptEvent[]): TranscriptMessage[] {
  return events.map(projectWebTranscriptEvent);
}

function projectWebTranscriptEvent(event: TranscriptEvent): TranscriptMessage {
  const eventType = normalizeToken(event.eventType);
  const payload = sanitizedPayloadRecord(event);
  const payloadKind = normalizedPayloadKind(payload);
  if (isToolEvent(eventType, payloadKind)) return projectToolCallMessage(event, payload);
  if (isThinkingEvent(eventType, payloadKind)) return { kind: "thinking", ts: event.at, text: eventText(event, payload) };
  if (isTaskEvent(eventType, payloadKind)) return projectTaskMessage(event, payload);
  if (isRequestEvent(eventType, payloadKind)) return projectRequestMessage(event, payload);
  if (isSystemEvent(eventType, payloadKind)) return projectSystemMessage(event, payload);
  if (isStatusEvent(eventType, payloadKind)) return projectStatusMessage(event, payload, eventType);
  if (isAssistantEvent(event, eventType, payloadKind)) {
    return { kind: "assistant", ts: event.at, text: eventText(event, payload) };
  }
  return projectStatusMessage(event, payload, eventType);
}

function projectToolCallMessage(event: TranscriptEvent, payload: Record<string, unknown>): TranscriptMessage {
  const argsPreview = firstPublicPreview(payload.argumentsPreview, payload.args, payload.arguments, payload.input);
  const resultPreview = firstPublicPreview(payload.resultPreview, payload.result);
  const outputPreview = firstPublicPreview(payload.outputPreview, payload.output);
  const errorPreview = firstPublicPreview(payload.errorPreview, payload.error);
  return {
    kind: "tool_call",
    ts: event.at,
    call_id: firstCleanString(payload.call_id, payload.callId, payload.id) ?? `${event.runId}:${event.sequence}`,
    name: firstCleanString(payload.name, payload.tool, payload.toolName) ?? event.eventType,
    status: firstCleanString(payload.status, payload.state) ?? "unknown",
    args: argsPreview ? { preview: argsPreview.preview } : {},
    result: resultPreview?.preview ?? outputPreview?.preview ?? errorPreview?.preview ?? null,
    ...(outputPreview ? { output: outputPreview.preview } : {}),
    ...(errorPreview ? { error: errorPreview.preview } : {}),
    ...(payload.truncated === true || argsPreview?.truncated || resultPreview?.truncated || outputPreview?.truncated || errorPreview?.truncated
      ? { truncated: true }
      : {}),
  };
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

function projectSystemMessage(event: TranscriptEvent, payload: Record<string, unknown>): TranscriptMessage {
  return {
    kind: "system",
    ts: event.at,
    model: firstCleanString(payload.model, payload.modelName) ?? "",
    cwd: firstCleanString(payload.cwd, payload.workingDirectory) ?? "",
    workspace: firstCleanString(payload.workspace, payload.workspaceKey, payload.workspacePath) ?? "",
    session: firstCleanString(payload.session, payload.sessionId, payload.threadId) ?? event.runId,
    tools: stringLabels(payload.tools),
    note: firstCleanString(payload.note, payload.messagePreview, payload.summary, payload.subtype, event.message) ?? event.eventType,
  };
}

function projectStatusMessage(
  event: TranscriptEvent,
  payload: Record<string, unknown>,
  eventType: string,
): TranscriptMessage {
  return {
    kind: "status",
    state: firstCleanString(payload.state, payload.status, payload.subtype) ?? eventType,
    ts: event.at,
    text: eventText(event, payload),
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
    eventType.includes("approval") ||
    eventType.includes("human_required") ||
    eventType.includes("humanrequired") ||
    eventType.includes("request") ||
    payloadKindIncludes(payloadKind, "approval") ||
    payloadKindIncludes(payloadKind, "human_required") ||
    payloadKindIncludes(payloadKind, "humanrequired") ||
    payloadKindIncludes(payloadKind, "request")
  );
}

function isSystemEvent(eventType: string, payloadKind: string | null): boolean {
  return eventType === "system" || payloadKind === "system";
}

function isStatusEvent(eventType: string, payloadKind: string | null): boolean {
  return eventType === "status" || payloadKind === "status";
}

function isAssistantEvent(event: TranscriptEvent, eventType: string, payloadKind: string | null): boolean {
  if (eventType === "assistant" || payloadKind === "assistant") return true;
  return event.source === "harness" && (eventType === "progress" || eventType === "completed");
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

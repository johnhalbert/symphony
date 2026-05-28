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
  if (eventType.includes("tool")) return projectToolCallMessage(event, payload);
  if (isThinkingEvent(eventType)) return { kind: "thinking", ts: event.at, text: eventText(event, payload) };
  if (isTaskEvent(eventType)) return projectTaskMessage(event, payload);
  if (isRequestEvent(eventType)) return projectRequestMessage(event, payload);
  if (event.source === "cursor" || event.source === "harness") {
    return { kind: "assistant", ts: event.at, text: eventText(event, payload) };
  }
  return {
    kind: "status",
    state: firstCleanString(payload.state, payload.status) ?? eventType,
    ts: event.at,
    text: eventText(event, payload),
  };
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

function isThinkingEvent(eventType: string): boolean {
  return eventType.includes("thinking") || eventType.includes("reasoning") || eventType.includes("thought");
}

function isTaskEvent(eventType: string): boolean {
  return eventType.includes("task");
}

function isRequestEvent(eventType: string): boolean {
  return (
    eventType.includes("approval") ||
    eventType.includes("human_required") ||
    eventType.includes("humanrequired") ||
    eventType.includes("request")
  );
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

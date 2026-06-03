import type {
  RealtimeOrchestratorMessagePayload,
  RealtimeProjectionEvent,
  RealtimeTranscriptDeltaPayload,
  RealtimeTranscriptPatchMessage,
} from "./realtimeEvents";
import type { ChatMessage, TranscriptMessage } from "../types/symphony";

export const DEFAULT_ORCHESTRATOR_CONVERSATION_ID = "orchestrator-default";
export const REALTIME_TRANSCRIPT_PATCH_TAIL_LIMIT = 500;
export const REALTIME_ORCHESTRATOR_CHAT_PATCH_TAIL_LIMIT = 100;
export const REALTIME_PATCH_TAIL_LIMIT = REALTIME_ORCHESTRATOR_CHAT_PATCH_TAIL_LIMIT;

export type RealtimePatchFallbackReason = "missed-events" | "missing-target" | "missing-payload" | "gap" | "incompatible";

export type RealtimePatchResult<TData, TCursor extends object = object> =
  | ({ action: "applied"; data: TData; lastRevision: number } & TCursor)
  | ({ action: "ignored"; lastRevision?: number } & Partial<TCursor>)
  | ({ action: "fallback"; reason: RealtimePatchFallbackReason; lastRevision: number } & Partial<TCursor>);

export function realtimeEventHasDirectPatchPayload(event: RealtimeProjectionEvent): boolean {
  if (isMissedEventsRecovery(event)) return false;
  if (event.type === "transcript.delta") {
    const payload = event.payload as RealtimeTranscriptDeltaPayload;
    return Array.isArray(payload.messages) && payload.messages.length > 0;
  }
  if (event.type === "orchestrator.message") {
    const payload = event.payload as RealtimeOrchestratorMessagePayload;
    return Boolean(payload.message) || (Array.isArray(payload.messages) && payload.messages.length > 0);
  }
  return false;
}

export function applyTranscriptDeltaEvent({
  event,
  sessionId,
  current,
  lastSequence,
  lastRevision,
  tailLimit = REALTIME_TRANSCRIPT_PATCH_TAIL_LIMIT,
}: {
  event: RealtimeProjectionEvent;
  sessionId: string | null;
  current: readonly TranscriptMessage[] | null;
  lastSequence: number | null;
  lastRevision: number | null;
  tailLimit?: number;
}): RealtimePatchResult<TranscriptMessage[], { lastSequence: number | null }> {
  if (event.type !== "transcript.delta") return { action: "ignored", lastSequence };
  if (lastRevision !== null && event.revision <= lastRevision) return { action: "ignored", lastRevision, lastSequence };
  if (isMissedEventsRecovery(event)) return { action: "fallback", reason: "missed-events", lastRevision: event.revision, lastSequence };
  if (!sessionId) return { action: "ignored", lastSequence };

  const payload = event.payload as RealtimeTranscriptDeltaPayload;
  if (!transcriptEventTargetsSession(payload, event, sessionId)) return { action: "ignored", lastSequence };

  if (!Array.isArray(payload.messages) || payload.messages.length === 0) return { action: "fallback", reason: "missing-payload", lastRevision: event.revision, lastSequence };
  const patches = normalizeTranscriptPatchMessages(payload.messages);
  if (!patches) return { action: "fallback", reason: "incompatible", lastRevision: event.revision, lastSequence };
  if (current === null) return { action: "fallback", reason: "missing-payload", lastRevision: event.revision, lastSequence };

  let expectedSequence = lastSequence;
  const afterSequence = finiteNumberOrNull(payload.afterSequence);
  if (expectedSequence !== null && afterSequence !== null) {
    if (afterSequence > expectedSequence) return { action: "fallback", reason: "gap", lastRevision: event.revision, lastSequence };
    if (afterSequence < expectedSequence) {
      const expectedAfterSequence = expectedSequence;
      if (patches.some((patch) => patch.sequence > expectedAfterSequence)) {
        return { action: "fallback", reason: "incompatible", lastRevision: event.revision, lastSequence };
      }
    }
    expectedSequence = Math.max(expectedSequence, afterSequence);
  } else if (expectedSequence === null && afterSequence !== null) {
    if (current.length === 0 && afterSequence > 0) return { action: "fallback", reason: "gap", lastRevision: event.revision, lastSequence };
    expectedSequence = afterSequence;
  }

  let next = [...current];
  let applied = false;
  for (const patch of patches) {
    if (expectedSequence !== null && patch.sequence <= expectedSequence) continue;
    if (expectedSequence !== null && patch.sequence !== expectedSequence + 1) {
      return { action: "fallback", reason: "gap", lastRevision: event.revision, lastSequence };
    }
    if (patch.message !== null) {
      next = applyTranscriptMessagePatch(next, patch);
      applied = true;
    }
    expectedSequence = patch.sequence;
  }

  if (!applied && expectedSequence === lastSequence) return { action: "ignored", lastRevision: event.revision, lastSequence };
  return {
    action: "applied",
    data: tail(next, tailLimit),
    lastRevision: event.revision,
    lastSequence: expectedSequence,
  };
}

export function applyOrchestratorMessageEvent({
  event,
  conversationId = DEFAULT_ORCHESTRATOR_CONVERSATION_ID,
  current,
  lastRevision,
  tailLimit = REALTIME_ORCHESTRATOR_CHAT_PATCH_TAIL_LIMIT,
}: {
  event: RealtimeProjectionEvent;
  conversationId?: string | null;
  current: readonly ChatMessage[] | null;
  lastRevision: number | null;
  tailLimit?: number;
}): RealtimePatchResult<ChatMessage[]> {
  if (event.type !== "orchestrator.message") return { action: "ignored" };
  if (lastRevision !== null && event.revision <= lastRevision) return { action: "ignored", lastRevision };
  if (isMissedEventsRecovery(event)) return { action: "fallback", reason: "missed-events", lastRevision: event.revision };

  const activeConversationId = normalizeConversationId(conversationId);
  const payload = event.payload as RealtimeOrchestratorMessagePayload;
  if (!orchestratorEventTargetsConversation(payload, event, activeConversationId)) return { action: "ignored" };

  const rawMessages = payload.messages ?? (payload.message ? [payload.message] : []);
  if (rawMessages.length === 0) return { action: "fallback", reason: "missing-payload", lastRevision: event.revision };
  const patches = normalizeChatPatchMessages(rawMessages);
  if (!patches) return { action: "fallback", reason: "incompatible", lastRevision: event.revision };
  if (current === null) return { action: "fallback", reason: "missing-payload", lastRevision: event.revision };
  if (patches.some((message) => !message.id)) return { action: "fallback", reason: "missing-payload", lastRevision: event.revision };
  if (patches.some((message) => message.conversationId && normalizeConversationId(message.conversationId) !== activeConversationId)) {
    return { action: "fallback", reason: "incompatible", lastRevision: event.revision };
  }

  const currentMessageIds = new Set(current.flatMap((message) => (message.id ? [message.id] : [])));
  const absentPatches = patches.filter((message) => !currentMessageIds.has(message.id ?? ""));
  const operation = orchestratorPatchOperation(payload.operation);
  if (absentPatches.length > 0 && operation === "update") {
    return { action: "fallback", reason: "gap", lastRevision: event.revision };
  }
  if (absentPatches.length > 0 && operation === null && current.length >= tailLimit) {
    return { action: "fallback", reason: "gap", lastRevision: event.revision };
  }

  const newMessageCount = absentPatches.length;
  const messageCount = finiteNumberOrNull(payload.messageCount);
  if (messageCount !== null) {
    const expectedBefore = Math.max(0, messageCount - newMessageCount);
    if (current.length < Math.min(expectedBefore, tailLimit)) {
      return { action: "fallback", reason: "gap", lastRevision: event.revision };
    }
  }

  let next = [...current];
  for (const message of patches) {
    const index = next.findIndex((existing) => existing.id && existing.id === message.id);
    if (index >= 0) {
      next[index] = mergeChatMessage(next[index]!, message);
    } else {
      next.push(message);
    }
  }

  return { action: "applied", data: tail(next, tailLimit), lastRevision: event.revision };
}

function applyTranscriptMessagePatch(current: TranscriptMessage[], patch: RealtimeTranscriptPatchMessage): TranscriptMessage[] {
  if (patch.message === null) return current;
  const message = patch.message;
  if (message.kind === "assistant" && patch.operation === "merge-assistant-delta") {
    const previous = current.at(-1);
    if (previous?.kind === "assistant") {
      return [
        ...current.slice(0, -1),
        {
          ...previous,
          ts: message.ts || previous.ts,
          text: combineAssistantDeltaText(previous.text, message.text, patch.joinMode),
        },
      ];
    }
    return [...current, message];
  }
  if (message.kind === "assistant" && patch.operation === "replace-assistant") {
    const previous = current.at(-1);
    if (previous?.kind === "assistant") return [...current.slice(0, -1), message];
    return [...current, message];
  }
  if (message.kind === "tool_call") {
    const existingIndex = current.findIndex((existing) => existing.kind === "tool_call" && existing.call_id === message.call_id);
    if (existingIndex >= 0) {
      const next = [...current];
      const existing = next[existingIndex];
      if (existing?.kind === "tool_call") next[existingIndex] = mergeToolCallMessage(existing, message);
      return next;
    }
  }
  return [...current, message];
}

function mergeToolCallMessage(
  existing: Extract<TranscriptMessage, { kind: "tool_call" }>,
  patch: Extract<TranscriptMessage, { kind: "tool_call" }>,
): TranscriptMessage {
  return {
    ...existing,
    ...patch,
    args: Object.keys(patch.args).length > 0 ? patch.args : existing.args,
    result: patch.result ?? existing.result,
    output: patch.output ?? existing.output,
    error: patch.error ?? existing.error,
    truncated: existing.truncated || patch.truncated || undefined,
  };
}

function mergeChatMessage(existing: ChatMessage, patch: ChatMessage): ChatMessage {
  return { ...existing, ...patch, metadata: { ...(existing.metadata ?? {}), ...(patch.metadata ?? {}) } };
}

function normalizeTranscriptPatchMessages(
  messages: readonly RealtimeTranscriptPatchMessage[] | undefined,
): readonly RealtimeTranscriptPatchMessage[] | null {
  if (!Array.isArray(messages)) return null;
  const normalized = messages.filter(
    (message): message is RealtimeTranscriptPatchMessage =>
      typeof message.sequence === "number" &&
      Number.isFinite(message.sequence) &&
      (message.message === null || isTranscriptMessage(message.message)) &&
      isTranscriptPatchOperation(message.operation) &&
      isTranscriptPatchJoinMode(message.joinMode),
  );
  return normalized.length === messages.length ? normalized : null;
}

function isTranscriptPatchOperation(value: unknown): boolean {
  return value === undefined || value === "append" || value === "merge-assistant-delta" || value === "replace-assistant";
}

function isTranscriptPatchJoinMode(value: unknown): boolean {
  return value === undefined || value === "spaced" || value === "exact" || value === "token";
}

function orchestratorPatchOperation(value: unknown): RealtimeOrchestratorMessagePayload["operation"] | null {
  return value === "append" || value === "update" ? value : null;
}

function normalizeChatPatchMessages(messages: readonly ChatMessage[]): readonly ChatMessage[] | null {
  const normalized = messages.filter(isChatMessage);
  return normalized.length === messages.length ? normalized : null;
}

function combineAssistantDeltaText(
  existing: string,
  next: string,
  mode: RealtimeTranscriptPatchMessage["joinMode"] = "spaced",
): string {
  if (existing.length === 0) return next;
  if (next.length === 0) return existing;
  if (mode === "exact" || (mode === "token" && shouldJoinTokenFragmentWithoutSpace(existing, next))) return existing + next;
  if (/\s$/.test(existing) || /^\s/.test(next)) return existing + next;
  return `${existing} ${next}`;
}

function shouldJoinTokenFragmentWithoutSpace(existing: string, next: string): boolean {
  if (/^[,.;:!?)}\]"']/.test(next)) return true;
  if (/[({\["']$/.test(existing)) return true;
  return /^[\p{L}\p{N}]+$/u.test(existing) && /^[\p{L}\p{N}]+$/u.test(next) && existing.length >= 2 && existing.length <= 4 && next.length <= 3;
}

function transcriptEventTargetsSession(
  payload: RealtimeTranscriptDeltaPayload,
  event: RealtimeProjectionEvent,
  sessionId: string,
): boolean {
  const candidates = [payload.sessionId, payload.runId, event.scope === "session" ? event.key : null]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  if (candidates.length === 0) return false;
  return candidates.includes(sessionId);
}

function orchestratorEventTargetsConversation(
  payload: RealtimeOrchestratorMessagePayload,
  event: RealtimeProjectionEvent,
  conversationId: string,
): boolean {
  const candidates = [payload.conversationId, event.scope === "orchestrator" ? event.key : null]
    .map((value) => normalizeConversationId(value))
    .filter((value): value is string => Boolean(value));
  if (candidates.length === 0) return false;
  return candidates.includes(conversationId);
}

function normalizeConversationId(conversationId: string | null | undefined): string {
  const normalized = conversationId?.trim();
  return normalized && normalized.length > 0 ? normalized : DEFAULT_ORCHESTRATOR_CONVERSATION_ID;
}

function isMissedEventsRecovery(event: RealtimeProjectionEvent): boolean {
  return event.missedEvents || event.recovery.reason === "missed-events";
}

function finiteNumberOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function tail<T>(values: readonly T[], limit: number): T[] {
  const normalizedLimit = Math.max(1, Math.trunc(limit));
  return values.slice(-normalizedLimit);
}

function isTranscriptMessage(value: unknown): value is TranscriptMessage {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as { kind?: unknown }).kind === "string";
}

function isChatMessage(value: unknown): value is ChatMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    ((value as { who?: unknown }).who === "agent" || (value as { who?: unknown }).who === "user") &&
    typeof (value as { text?: unknown }).text === "string"
  );
}

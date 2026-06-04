import type {
  ChatMessage,
  OrchestratorChatConversationStatus,
  OrchestratorChatModel,
  OrchestratorChatState,
  OrchestratorChatStatusCounts,
} from "../types/symphony";

export const DEFAULT_ORCHESTRATOR_CHAT_CONVERSATION_ID = "orchestrator-default";

const ORCHESTRATOR_CHAT_STATUSES: readonly OrchestratorChatConversationStatus[] = [
  "pending",
  "streaming",
  "completed",
  "failed",
  "disabled",
  "unavailable",
];

export function normalizeOrchestratorChatModel(body: unknown, conversationId = DEFAULT_ORCHESTRATOR_CHAT_CONVERSATION_ID): OrchestratorChatModel {
  if (isChatMessages(body)) return orchestratorChatModelFromMessages(body, { conversationId, sourceShape: "legacy_chat_array" });
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    if (isChatMessages(record.chat)) return orchestratorChatModelFromRecord(record, record.chat, conversationId);
  }
  return orchestratorChatModelFromMessages([], { conversationId, state: "unavailable", sourceShape: "fallback" });
}

export function orchestratorChatModelFromMessages(
  chat: readonly ChatMessage[] = [],
  options: {
    conversationId?: string | null;
    state?: OrchestratorChatState;
    conversationStatus?: OrchestratorChatConversationStatus;
    sourceShape?: "reducer_envelope" | "legacy_chat_array" | "fallback";
  } = {},
): OrchestratorChatModel {
  const normalizedChat = chat.map((message) => ({ ...message }));
  const conversationId = normalizeConversationId(options.conversationId);
  const conversationStatus = options.conversationStatus ?? conversationStatusFromState(options.state) ?? "completed";
  const status = summarizeOrchestratorChatStatus(normalizedChat, conversationStatus, options.state);
  const latestMessage = normalizedChat.at(-1) ?? null;
  return {
    schemaVersion: 1,
    conversation: {
      id: conversationId,
      status: conversationStatus,
      createdAt: null,
      updatedAt: latestMessage?.updatedAt ?? latestMessage?.createdAt ?? null,
      messageCount: normalizedChat.length,
      metadata: {},
    },
    state: status.state,
    status,
    chat: normalizedChat,
    source: {
      source: options.sourceShape === "legacy_chat_array" ? "legacy_chat_array" : "orchestrator_conversations",
      revision: [conversationId, normalizedChat.length, latestMessage?.id ?? "none", latestMessage?.updatedAt ?? latestMessage?.createdAt ?? "unknown"].join(":"),
      observedAt: latestMessage?.updatedAt ?? latestMessage?.createdAt ?? null,
      conversationId,
      latestMessageSequence: null,
      latestMessageUpdatedAt: latestMessage?.updatedAt ?? latestMessage?.createdAt ?? null,
    },
    compatibility: {
      responseShape: "orchestrator_chat_projection",
      sourceShape: options.sourceShape ?? "legacy_chat_array",
    },
  };
}

function orchestratorChatModelFromRecord(
  record: Record<string, unknown>,
  chat: ChatMessage[],
  fallbackConversationId: string,
): OrchestratorChatModel {
  const rawConversation = objectRecord(record.conversation);
  const rawStatus = objectRecord(record.status);
  const rawSource = objectRecord(record.source);
  const bodyState = normalizeOrchestratorChatState(record.state);
  const statusState = normalizeOrchestratorChatState(rawStatus?.state);
  const conversationStatus =
    normalizeConversationStatus(rawConversation?.status) ??
    normalizeConversationStatus(rawStatus?.conversationStatus) ??
    conversationStatusFromState(bodyState ?? statusState) ??
    "completed";
  const summarizedStatus = summarizeOrchestratorChatStatus(chat, conversationStatus, bodyState ?? statusState ?? undefined);
  const state = bodyState ?? statusState ?? summarizedStatus.state;
  const latestMessage = chat.at(-1) ?? null;
  return {
    schemaVersion: nonNegativeInteger(record.schemaVersion) ?? 1,
    conversation: {
      id: stringValue(rawConversation?.id) ?? fallbackConversationId,
      status: conversationStatus,
      createdAt: nullableString(rawConversation?.createdAt),
      updatedAt: nullableString(rawConversation?.updatedAt),
      messageCount: nonNegativeInteger(rawConversation?.messageCount) ?? chat.length,
      metadata: objectRecord(rawConversation?.metadata) ?? {},
    },
    state,
    status: {
      state,
      conversationStatus,
      latestMessageStatus: normalizeConversationStatus(rawStatus?.latestMessageStatus) ?? summarizedStatus.latestMessageStatus,
      active: typeof rawStatus?.active === "boolean" ? rawStatus.active : summarizedStatus.active,
      terminal: typeof rawStatus?.terminal === "boolean" ? rawStatus.terminal : summarizedStatus.terminal,
      empty: typeof rawStatus?.empty === "boolean" ? rawStatus.empty : summarizedStatus.empty,
      messageCount: nonNegativeInteger(rawStatus?.messageCount) ?? summarizedStatus.messageCount,
      statusCounts: normalizeStatusCounts(rawStatus?.statusCounts) ?? summarizedStatus.statusCounts,
    },
    chat: chat.map((message) => ({ ...message })),
    source: {
      source: stringValue(rawSource?.source) ?? "orchestrator_conversations",
      revision: stringValue(rawSource?.revision) ?? [fallbackConversationId, chat.length, latestMessage?.id ?? "none"].join(":"),
      observedAt: nullableString(rawSource?.observedAt),
      conversationId: stringValue(rawSource?.conversationId) ?? fallbackConversationId,
      latestMessageSequence: nonNegativeInteger(rawSource?.latestMessageSequence),
      latestMessageUpdatedAt: nullableString(rawSource?.latestMessageUpdatedAt) ?? latestMessage?.updatedAt ?? latestMessage?.createdAt ?? null,
    },
    ...(objectRecord(record.compatibility)
      ? {
          compatibility: {
            responseShape: "orchestrator_chat_projection" as const,
            sourceShape: normalizeSourceShape(objectRecord(record.compatibility)?.sourceShape) ?? "reducer_envelope",
          },
        }
      : {}),
  };
}

export function orchestratorChatStateNotice(model: OrchestratorChatModel, compact = false): string | null {
  const noun = compact ? "chat" : "orchestrator conversation";
  const messageCount = model.status.messageCount;
  const messageCopy = messageCount === 1 ? "1 durable message" : `${messageCount} durable messages`;
  if (model.state === "completed" && messageCount > 0) return null;
  if (model.state === "empty") return `No durable orchestrator chat messages are available yet. The ${noun} is empty for ${model.conversation.id}.`;
  if (model.state === "pending") return `The ${noun} is pending with ${messageCopy}; no invented completion message is being shown.`;
  if (model.state === "streaming") return `The ${noun} is streaming with ${messageCopy}; partial durable state is being shown as-is.`;
  if (model.state === "failed") return `The ${noun} failed with ${messageCopy}; durable failure state is being shown without an invented reply.`;
  if (model.state === "disabled") return `The ${noun} is disabled; durable state is shown without invented messages.`;
  if (model.state === "unavailable") return `The ${noun} is unavailable; durable state is shown without invented messages.`;
  return null;
}

export function orchestratorChatCommandUnavailableNotice(model: OrchestratorChatModel | null | undefined, compact = false): string | null {
  const noun = compact ? "Compact chat" : "Orchestrator chat";
  if (model?.state === "disabled") {
    return `${noun} commands are disabled by the backend; no orchestrator action will be dispatched.`;
  }
  if (model?.state === "unavailable") {
    return `${noun} commands are unavailable because the backend reports no active command dispatcher; no orchestrator action will be dispatched.`;
  }
  return null;
}

function summarizeOrchestratorChatStatus(
  chat: readonly ChatMessage[],
  conversationStatus: OrchestratorChatConversationStatus,
  stateOverride?: OrchestratorChatState,
): OrchestratorChatModel["status"] {
  const statusCounts = emptyStatusCounts();
  for (const message of chat) statusCounts[messageStatus(message)] += 1;
  const latestMessageStatus = chat.length > 0 ? messageStatus(chat[chat.length - 1]!) : null;
  const state = stateOverride ?? (chat.length === 0 && conversationStatus === "completed" ? "empty" : deriveState(conversationStatus, latestMessageStatus, statusCounts));
  const active = state === "pending" || state === "streaming";
  return {
    state,
    conversationStatus,
    latestMessageStatus,
    active,
    terminal: !active && state !== "empty",
    empty: chat.length === 0,
    messageCount: chat.length,
    statusCounts,
  };
}

function deriveState(
  conversationStatus: OrchestratorChatConversationStatus,
  latestMessageStatus: OrchestratorChatConversationStatus | null,
  statusCounts: OrchestratorChatStatusCounts,
): OrchestratorChatState {
  if (latestMessageStatus === "pending" || latestMessageStatus === "streaming") return latestMessageStatus;
  if (conversationStatus === "pending" || conversationStatus === "streaming") return conversationStatus;
  if (latestMessageStatus === "failed" || latestMessageStatus === "unavailable" || latestMessageStatus === "disabled") return latestMessageStatus;
  if (conversationStatus === "failed" || conversationStatus === "unavailable" || conversationStatus === "disabled") return conversationStatus;
  if (statusCounts.streaming > 0) return "streaming";
  if (statusCounts.pending > 0) return "pending";
  if (statusCounts.failed > 0) return "failed";
  if (statusCounts.unavailable > 0) return "unavailable";
  if (statusCounts.disabled > 0) return "disabled";
  return "completed";
}

function messageStatus(message: ChatMessage): OrchestratorChatConversationStatus {
  return normalizeConversationStatus(message.status) ?? "completed";
}

function emptyStatusCounts(): OrchestratorChatStatusCounts {
  return {
    pending: 0,
    streaming: 0,
    completed: 0,
    failed: 0,
    disabled: 0,
    unavailable: 0,
  };
}

function isChatMessages(value: unknown): value is ChatMessage[] {
  return Array.isArray(value) && value.every((item) => item && typeof item === "object" && typeof (item as ChatMessage).text === "string");
}

function normalizeOrchestratorChatState(value: unknown): OrchestratorChatState | null {
  if (value === "empty") return "empty";
  return normalizeConversationStatus(value);
}

function normalizeConversationStatus(value: unknown): OrchestratorChatConversationStatus | null {
  return typeof value === "string" && ORCHESTRATOR_CHAT_STATUSES.includes(value as OrchestratorChatConversationStatus)
    ? (value as OrchestratorChatConversationStatus)
    : null;
}

function conversationStatusFromState(state: OrchestratorChatState | null | undefined): OrchestratorChatConversationStatus | null {
  if (!state) return null;
  return state === "empty" ? "completed" : state;
}

function normalizeStatusCounts(value: unknown): OrchestratorChatStatusCounts | null {
  const record = objectRecord(value);
  if (!record) return null;
  const counts = emptyStatusCounts();
  for (const status of ORCHESTRATOR_CHAT_STATUSES) counts[status] = nonNegativeInteger(record[status]) ?? 0;
  return counts;
}

function normalizeSourceShape(value: unknown): NonNullable<OrchestratorChatModel["compatibility"]>["sourceShape"] | null {
  return value === "reducer_envelope" || value === "legacy_chat_array" || value === "fallback" ? value : null;
}

function normalizeConversationId(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_ORCHESTRATOR_CHAT_CONVERSATION_ID;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

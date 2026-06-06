export function createOrchestratorChatProjection(chat, {
  conversationId = "orchestrator-default",
  observedAt = "2026-01-01T00:00:00.000Z",
  revisionPrefix = "browser-smoke",
  state: stateOverride,
  conversationStatus: conversationStatusOverride,
} = {}) {
  const statusCounts = {
    pending: 0,
    streaming: 0,
    completed: 0,
    failed: 0,
    disabled: 0,
    unavailable: 0,
  };
  const normalizedChat = chat.map((message, index) => {
    const messageObservedAt = message.updatedAt ?? message.createdAt ?? observedAt;
    const status = message.status ?? "completed";
    if (Object.hasOwn(statusCounts, status)) statusCounts[status] += 1;
    return {
      ...message,
      id: message.id ?? `${revisionPrefix}-message-${index + 1}`,
      createdAt: message.createdAt ?? messageObservedAt,
      updatedAt: message.updatedAt ?? messageObservedAt,
      status,
    };
  });
  const latestMessage = normalizedChat.at(-1) ?? null;
  const latestMessageStatus = latestMessage?.status ?? null;
  const conversationStatus = conversationStatusOverride ?? conversationStatusFromState(stateOverride) ?? deriveConversationStatus(latestMessageStatus, statusCounts);
  const state = stateOverride ?? (normalizedChat.length === 0 && conversationStatus === "completed" ? "empty" : deriveState(conversationStatus, latestMessageStatus, statusCounts));
  return {
    schemaVersion: 1,
    conversation: {
      id: conversationId,
      status: conversationStatus,
      createdAt: normalizedChat[0]?.createdAt ?? null,
      updatedAt: latestMessage?.updatedAt ?? latestMessage?.createdAt ?? null,
      messageCount: normalizedChat.length,
      metadata: {},
    },
    state,
    status: {
      state,
      conversationStatus,
      latestMessageStatus,
      active: state === "pending" || state === "streaming",
      terminal: state !== "pending" && state !== "streaming" && state !== "empty",
      empty: normalizedChat.length === 0,
      messageCount: normalizedChat.length,
      statusCounts,
    },
    chat: normalizedChat,
    source: {
      source: "orchestrator_conversations",
      revision: `${revisionPrefix}:${normalizedChat.length}:${latestMessage?.id ?? "none"}`,
      observedAt: latestMessage?.updatedAt ?? latestMessage?.createdAt ?? observedAt,
      conversationId,
      latestMessageSequence: normalizedChat.length,
      latestMessageUpdatedAt: latestMessage?.updatedAt ?? latestMessage?.createdAt ?? null,
    },
    compatibility: {
      responseShape: "orchestrator_chat_projection",
      sourceShape: "reducer_envelope",
    },
  };
}

function conversationStatusFromState(state) {
  if (!state || state === "empty") return null;
  return state;
}

function deriveConversationStatus(latestMessageStatus, statusCounts) {
  if (isConversationStatus(latestMessageStatus)) return latestMessageStatus;
  if (statusCounts.streaming > 0) return "streaming";
  if (statusCounts.pending > 0) return "pending";
  if (statusCounts.failed > 0) return "failed";
  if (statusCounts.unavailable > 0) return "unavailable";
  if (statusCounts.disabled > 0) return "disabled";
  return "completed";
}

function deriveState(conversationStatus, latestMessageStatus, statusCounts) {
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

function isConversationStatus(status) {
  return status === "pending" || status === "streaming" || status === "completed" || status === "failed" || status === "disabled" || status === "unavailable";
}

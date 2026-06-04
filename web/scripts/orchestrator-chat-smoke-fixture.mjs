export function createOrchestratorChatProjection(chat, {
  conversationId = "orchestrator-default",
  observedAt = "2026-01-01T00:00:00.000Z",
  revisionPrefix = "browser-smoke",
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
  const conversationStatus = latestMessageStatus === "pending" || latestMessageStatus === "streaming" ? latestMessageStatus : "completed";
  const state = normalizedChat.length === 0 ? "empty" : conversationStatus;
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

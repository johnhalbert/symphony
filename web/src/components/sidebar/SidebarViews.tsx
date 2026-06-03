import { useEffect, useMemo, useState } from "react";
import { SidebarChrome } from "../../app/SidebarChrome";
import { useDataSource } from "../../data/dataSourceContext";
import { normalizeOrchestratorChatModel, orchestratorChatModelFromMessages } from "../../data/orchestratorChat";
import type { ChatMessage, OrchestratorChatModel, SidebarModel, SidebarVariant } from "../../types/symphony";
import { SidebarChat } from "./SidebarChat";
import { SidebarHistory } from "./SidebarHistory";
import { SidebarPrimary } from "./SidebarPrimary";

export function SidebarViews({
  orchestratorChat,
  orchestratorChatError = null,
  orchestratorChatLoading = false,
  orchestratorChatReadOnly = false,
  sidebar,
  variant,
}: {
  orchestratorChat?: OrchestratorChatModel | ChatMessage[];
  orchestratorChatError?: string | null;
  orchestratorChatLoading?: boolean;
  orchestratorChatReadOnly?: boolean;
  sidebar: SidebarModel;
  variant: SidebarVariant;
}) {
  const dataSource = useDataSource();
  const sourceChat = useMemo(() => normalizeOrchestratorChatModel(orchestratorChat ?? sidebar.chat), [orchestratorChat, sidebar.chat]);
  const [chatMessages, setChatMessages] = useState(sourceChat);

  useEffect(() => {
    setChatMessages(sourceChat);
  }, [sourceChat]);

  async function sendChat(input: string) {
    if (orchestratorChatReadOnly) return;
    const nextMessages = await dataSource.sendOrchestratorMessage(input);
    setChatMessages(orchestratorChatModelFromMessages(nextMessages, { conversationId: chatMessages.conversation.id }));
  }

  const sidebarChatSubtitle = sidebar.runningAgents[0]
    ? `${sidebar.runningAgents[0].id} · ${sidebar.runningAgents[0].issue}`
    : undefined;
  const child =
    variant === "chat" ? (
      <SidebarChat
        projection={chatMessages}
        messages={chatMessages.chat}
        onSend={sendChat}
        loading={orchestratorChatLoading}
        error={orchestratorChatError}
        readOnly={orchestratorChatReadOnly}
        subtitle={sidebarChatSubtitle}
      />
    ) : variant === "history" ? (
      <SidebarHistory sessions={sidebar.sessions} />
    ) : (
      <SidebarPrimary sidebar={sidebar} />
    );

  return (
    <div className="sidebar-preview">
      <div className="sidebar-preview__rail">
        <SidebarChrome>{child}</SidebarChrome>
      </div>
      <div className="state-card-grid">
        <p style={{ color: "var(--text-3)", fontSize: 13, lineHeight: 1.6, maxWidth: 480 }}>
          Narrow views render from the same active data source as the full app. Use the view switcher in the title bar to inspect status, chat, and history variants.
        </p>
      </div>
    </div>
  );
}

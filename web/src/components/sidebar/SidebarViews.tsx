import { SidebarChrome } from "../../app/SidebarChrome";
import type { ChatMessage, SidebarModel, SidebarVariant } from "../../types/symphony";
import { SidebarChat } from "./SidebarChat";
import { SidebarHistory } from "./SidebarHistory";
import { SidebarPrimary } from "./SidebarPrimary";

export function SidebarViews({
  orchestratorChat,
  orchestratorChatError = null,
  orchestratorChatLoading = false,
  sidebar,
  variant,
}: {
  orchestratorChat?: ChatMessage[];
  orchestratorChatError?: string | null;
  orchestratorChatLoading?: boolean;
  sidebar: SidebarModel;
  variant: SidebarVariant;
}) {
  const chatMessages = orchestratorChat ?? sidebar.chat;
  const child =
    variant === "chat" ? (
      <SidebarChat messages={chatMessages} loading={orchestratorChatLoading} error={orchestratorChatError} />
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

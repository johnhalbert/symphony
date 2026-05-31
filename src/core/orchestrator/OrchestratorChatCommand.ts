export const ORCHESTRATOR_CHAT_POST_ACTION = "orchestrator.chat.post" as const;

export type OrchestratorChatCommandAction = typeof ORCHESTRATOR_CHAT_POST_ACTION;
export type OrchestratorChatCommandSource = "web";

export interface OrchestratorChatPostCommand {
  action: OrchestratorChatCommandAction;
  source: OrchestratorChatCommandSource;
  conversationId: string;
  messageId: string;
  input: string;
  requestedAt: string;
}

export type OrchestratorChatCommand = OrchestratorChatPostCommand;

export type OrchestratorChatCommandResultStatus = "accepted" | "disabled" | "unavailable" | "failed";

export interface OrchestratorChatCommandResult {
  status: OrchestratorChatCommandResultStatus;
  reason: string;
  acceptedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface OrchestratorChatCommandDispatcher {
  dispatchOrchestratorChatCommand(command: OrchestratorChatCommand): Promise<OrchestratorChatCommandResult>;
}

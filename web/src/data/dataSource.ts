import type {
  ChatMessage,
  DashboardModel,
  HistoryModel,
  IssueBoardModel,
  IssueDetailModel,
  ReferenceData,
  SidebarModel,
  TranscriptMessage,
} from "../types/symphony";

export type OrchestratorChatListener = (messages: ChatMessage[]) => void;
export type OrchestratorChatErrorListener = (message: string) => void;

export interface SymphonyDataSource {
  getReferenceData(signal?: AbortSignal): Promise<ReferenceData>;
  getDashboard(signal?: AbortSignal): Promise<DashboardModel>;
  getIssueBoard(signal?: AbortSignal): Promise<IssueBoardModel>;
  getIssueDetail(issueId: string, signal?: AbortSignal): Promise<IssueDetailModel | null>;
  getHistory(signal?: AbortSignal): Promise<HistoryModel>;
  getSessions(signal?: AbortSignal): Promise<HistoryModel["sessions"]>;
  getTranscript(sessionId: string, signal?: AbortSignal): Promise<TranscriptMessage[]>;
  getSidebar(signal?: AbortSignal): Promise<SidebarModel>;
  getOrchestratorChat(signal?: AbortSignal): Promise<ChatMessage[]>;
  sendOrchestratorMessage(input: string): Promise<ChatMessage[]>;
  subscribeOrchestratorChat?(onMessages: OrchestratorChatListener, onError?: OrchestratorChatErrorListener): () => void;
}

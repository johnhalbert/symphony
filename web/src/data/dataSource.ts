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

export interface SymphonyDataSource {
  getReferenceData(): Promise<ReferenceData>;
  getDashboard(): Promise<DashboardModel>;
  getIssueBoard(): Promise<IssueBoardModel>;
  getIssueDetail(issueId: string): Promise<IssueDetailModel | null>;
  getHistory(): Promise<HistoryModel>;
  getSessions(): Promise<HistoryModel["sessions"]>;
  getTranscript(sessionId: string): Promise<TranscriptMessage[]>;
  getSidebar(): Promise<SidebarModel>;
  getOrchestratorChat(): Promise<ChatMessage[]>;
  sendOrchestratorMessage(input: string): Promise<ChatMessage[]>;
}

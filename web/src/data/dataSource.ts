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
import type { RealtimeEventListener, RealtimeEventUnsubscribe, RealtimeSubscriptionOptions } from "./realtimeEvents";

export type {
  RealtimeEventListener,
  RealtimeEventUnsubscribe,
  RealtimeProjectionEvent,
  RealtimeProjectionEventType,
  RealtimeProjectionRecoveryHint,
  RealtimeProjectionResource,
  RealtimeResourceKind,
  RealtimeSubscriptionOptions,
} from "./realtimeEvents";

export interface ProjectionChangeEvent {
  type: string;
  generation?: number;
  source?: string;
  revision?: number;
  observedAt?: string;
}

export type ProjectionChangeListener = (event: ProjectionChangeEvent) => void;
export type ProjectionChangeUnsubscribe = () => void;

export interface CacheInvalidationOptions {
  forceRefreshHrefs?: readonly string[];
}

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
  invalidateCachedReads?(options?: CacheInvalidationOptions): void;
  subscribeToProjectionChanges?(listener: ProjectionChangeListener): ProjectionChangeUnsubscribe;
  subscribeToRealtimeEvents?(listener: RealtimeEventListener, options?: RealtimeSubscriptionOptions): RealtimeEventUnsubscribe;
}

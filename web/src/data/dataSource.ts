import type {
  ChatMessage,
  DashboardModel,
  HistoryModel,
  IssueBoardModel,
  IssueDetailModel,
  OrchestratorChatModel,
  ReferenceData,
  SidebarModel,
  TranscriptMessage,
} from "../types/symphony";
import type { RealtimeEventListener, RealtimeEventUnsubscribe, RealtimeSubscriptionOptions } from "./realtimeEvents";

export type {
  RealtimeConnectionStatus,
  RealtimeConnectionStatusKind,
  RealtimeConnectionStatusListener,
  RealtimeEventListener,
  RealtimeEventUnsubscribe,
  RealtimeProjectionEvent,
  RealtimeProjectionEventPayload,
  RealtimeProjectionEventScope,
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
  /** API hrefs affected by a realtime update. Listed paths are invalidated selectively; refresh=1 hints are replayed on the next GET. */
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
  getOrchestratorChat(signal?: AbortSignal): Promise<OrchestratorChatModel>;
  sendOrchestratorMessage(input: string): Promise<ChatMessage[]>;
  invalidateCachedReads?(options?: CacheInvalidationOptions): void;
  subscribeToProjectionChanges?(listener: ProjectionChangeListener): ProjectionChangeUnsubscribe;
  subscribeToRealtimeEvents?(listener: RealtimeEventListener, options?: RealtimeSubscriptionOptions): RealtimeEventUnsubscribe;
}

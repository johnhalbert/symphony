import type { ReactNode } from "react";

export type IssueStatus = "backlog" | "todo" | "progress" | "review" | "done" | "cancelled";
export type RunState =
  | "creating"
  | "running"
  | "queued"
  | "review"
  | "finished"
  | "error"
  | "cancelled"
  | "not_live"
  | "expired";
export type PriorityLevel = 0 | 1 | 2 | 3 | "urgent";
export type AppTab = "dashboard" | "issues" | "history" | "sidebar" | "states";
export type DashboardVariant = "cards" | "command-center" | "grid";
export type IssuesVariant = "balanced" | "detail-heavy";
export type HistoryVariant = "list" | "timeline" | "focused";
export type SidebarVariant = "primary" | "chat" | "history";

export interface LabelDef {
  name: string;
  color: string | null;
}

export interface UserDef {
  name: string;
  color: string | null;
}

export type LabelMap = Record<string, LabelDef>;
export type UserMap = Record<string, UserDef>;

export interface IssueModel {
  id: string;
  title: string;
  status: IssueStatus;
  priority: PriorityLevel;
  labels: string[];
  assignee: string;
  agent?: string | null;
  project: string;
  cycle: string;
  desc?: string[];
  activity?: Array<{ t: string; verb: string; val: string; who: string }>;
  pr?: string | null;
  ci?: string | null;
  workspace?: string | null;
  session?: string | null;
}

export interface RunningAgentProjectContextModel {
  projectContextId: string;
  projectContextLabel: string;
  linearProjectSlug: string | null;
  routingSource: string;
}

export interface RunningAgentModel {
  id: string;
  issue: string;
  title: string;
  state: RunState | "running";
  step: string;
  duration: string;
  tokens: string;
  projectContext?: RunningAgentProjectContextModel | undefined;
}

export interface ProviderGateModel {
  id: string;
  provider: string;
  kind: string;
  message: string;
  resumeAt: string | null;
  resumePolicy: string;
  sourceIssue: string | null;
  sourceRunId: string | null;
  affected: string;
}

export interface ActivityModel {
  t: string;
  who: string;
  verb: string;
  id: string;
  extra: string;
}

export interface RunSessionModelParam {
  id: string;
  value: string;
}

export interface RunSessionModelSettings {
  model: string | null;
  modelParams: RunSessionModelParam[];
  settingSources: string[];
  mode: string | null;
  allowLargeContext: boolean | null;
}

export interface RunSessionProviderLimitModel {
  provider: string | null;
  providerId: string | null;
  harnessId: string | null;
  model: string | null;
  kind: string | null;
  message: string | null;
  observedAt: string | null;
  resumePolicy: string | null;
  window: {
    resumeAt: string | null;
    retryAfterMs: number | null;
    windowLabel: string | null;
    windowKind: string | null;
  } | null;
  source: {
    issueId: string | null;
    issueIdentifier: string | null;
    runId: string | null;
    sessionId: string | null;
    role: string | null;
    runPhase: string | null;
  } | null;
}

export interface RunSessionModel {
  runId: string;
  sessionId: string | null;
  agentId: string | null;
  role: string;
  runPhase: string | null;
  runKind: string | null;
  attempt: number | null;
  turnNumber: number;
  harnessId: string | null;
  status: string;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
  transcriptEventCount: number;
  tokens: { inputTokens: number; outputTokens: number; totalTokens: number };
  runtime: RunSessionModelSettings & { agentLifecycle: string | null };
  cursor: RunSessionModelSettings & { workerAgentLifecycle: string | null };
  workspace: { key: string; path: string; repoPath: string | null; baseRef: string | null; branch: string | null };
  pullRequest: {
    url: string | null;
    number: number | null;
    headSha: string | null;
    branch: string | null;
    ciStatus: string | null;
    lastPushedAt: string | null;
    lastEvidenceCursor: string | null;
  };
  approval: { pendingRequestId: string | null; requestedAt: string | null };
  cancellation: {
    requestedAt: string | null;
    source: string | null;
    reason: string | null;
    outcome: string | null;
    harnessStopRequestedAt: string | null;
    harnessStopFailedAt: string | null;
    harnessStopFailedReason: string | null;
    cancelFailed: boolean;
    cancelFailedAt: string | null;
    cancelFailedReason: string | null;
    cancelFailedSource: string | null;
  };
  failure: { kind: string | null; diagnosticCode: string | null; diagnosticMessage: string | null; diagnosticAt: string | null };
  providerLimit: RunSessionProviderLimitModel | null;
  links: { issue: string; run: string; transcript: string };
}

export interface SessionModel {
  id: string;
  issue: string;
  title: string;
  state: "running" | "finished" | "error" | "cancelled" | "queued" | "not_live";
  model: string;
  startedAt: string;
  updatedAt: string;
  msgCount: number;
  lastEvent: string;
  toolCount: number;
  runSession?: RunSessionModel;
}

export interface ChatMessage {
  id?: string;
  conversationId?: string;
  who: "agent" | "user";
  role?: "user" | "assistant" | "system" | "server";
  text: string;
  status?: "pending" | "streaming" | "completed" | "failed" | "disabled" | "unavailable";
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
  suggestions?: string[];
}

export type OrchestratorChatConversationStatus = NonNullable<ChatMessage["status"]>;
export type OrchestratorChatState = "empty" | OrchestratorChatConversationStatus;
export type OrchestratorChatStatusCounts = Record<OrchestratorChatConversationStatus, number>;

export interface OrchestratorChatStatusSummary {
  state: OrchestratorChatState;
  conversationStatus: OrchestratorChatConversationStatus;
  latestMessageStatus: OrchestratorChatConversationStatus | null;
  active: boolean;
  terminal: boolean;
  empty: boolean;
  messageCount: number;
  statusCounts: OrchestratorChatStatusCounts;
}

export interface OrchestratorChatConversationSummary {
  id: string;
  status: OrchestratorChatConversationStatus;
  createdAt: string | null;
  updatedAt: string | null;
  messageCount: number;
  metadata: Record<string, unknown>;
}

export interface OrchestratorChatSourceSummary {
  source: string;
  revision: string;
  observedAt: string | null;
  conversationId: string;
  latestMessageSequence: number | null;
  latestMessageUpdatedAt: string | null;
}

export interface OrchestratorChatModel {
  schemaVersion: number;
  conversation: OrchestratorChatConversationSummary;
  state: OrchestratorChatState;
  status: OrchestratorChatStatusSummary;
  chat: ChatMessage[];
  source: OrchestratorChatSourceSummary;
  compatibility?: {
    responseShape: "orchestrator_chat_projection";
    sourceShape: "reducer_envelope" | "legacy_chat_array" | "fallback";
  };
}

export type TranscriptMessage =
  | {
      kind: "system";
      ts: string;
      model: string;
      cwd: string;
      workspace: string;
      session: string;
      tools: string[];
      note: string;
    }
  | { kind: "user"; ts: string; from: string; issue: string; text: string }
  | { kind: "assistant"; ts: string; text: string }
  | { kind: "thinking"; ts: string; text: string }
  | {
      kind: "tool_call";
      ts: string;
      call_id: string;
      name: string;
      status: string;
      args: Record<string, unknown>;
      result: string | null;
      output?: string | null;
      error?: string | null;
      truncated?: boolean;
    }
  | { kind: "status"; state: string; ts: string; text: string }
  | { kind: "task"; ts: string; title: string; desc: string }
  | { kind: "request"; ts: string; reason: string; q: string; actions: string[] };

export interface TranscriptWindowPageModel {
  offset: number;
  limit: number;
  size: number;
  total: number | null;
  nextOffset: number | null;
  previousOffset: number | null;
  hasNext: boolean;
  hasPrevious: boolean;
  firstSequence: number | null;
  lastSequence: number | null;
  lastEventAt: string | null;
}

export interface TranscriptWindowModel extends TranscriptWindowPageModel {
  kind: "page" | "tail";
  tailLimit: number;
  messageCount: number;
  requested: {
    offset: number | null;
    limit: number;
  };
}

export interface TranscriptActiveTailModel {
  enabled: boolean;
  canAppend: boolean;
  runStatus: string | null;
  tailLimit: number;
  afterSequence: number | null;
  lastEventAt: string | null;
  refetchHref: string | null;
  gapFallback: {
    strategy: "refetch";
    reason: "tail-gap";
    href: string | null;
  };
}

export interface TranscriptWindowResponse {
  schemaVersion: number;
  messages: TranscriptMessage[];
  page: TranscriptWindowPageModel;
  window: TranscriptWindowModel;
  activeTail: TranscriptActiveTailModel;
  recovery: {
    strategy: "refetch";
    reason: "tail-gap";
    href: string | null;
  };
  compatibility?: {
    responseShape?: string;
    messagesField?: string;
  };
}

export interface TranscriptRequestOptions {
  offset?: number | null;
  limit?: number | null;
  tail?: boolean;
  full?: boolean;
}

export interface TimelineEvent {
  t: string;
  sess: string;
  kind: TranscriptMessage["kind"];
  text: string;
  state?: string;
}

export interface DashboardTotals {
  backlog: number;
  todo: number;
  progress: number;
  review: number;
  done: number;
  cancelled: number;
  open: number;
  all: number;
  completeness: number;
}

export interface DashboardCycleMetrics {
  label?: string | null;
  dateRange?: string | null;
  remainingLabel?: string | null;
  completenessDeltaLabel?: string | null;
  projectedCompletionLabel?: string | null;
}

export interface DashboardVelocityMetrics {
  valueLabel?: string | null;
  unitLabel?: string | null;
  etaLabel?: string | null;
  windowLabel?: string | null;
  deltaLabel?: string | null;
  trendLabel?: string | null;
  sparkline?: number[] | null;
}

export interface DashboardBurnupMetrics {
  title?: string | null;
  remainingLabel?: string | null;
  completedSeries?: number[] | null;
  targetSeries?: number[] | null;
  completedEnd?: number | null;
  targetEnd?: number | null;
  currentIndex?: number | null;
  totalPoints?: number | null;
}

export interface DashboardHealthMetrics {
  connectionLabel?: string | null;
  stateLabel?: string | null;
  errorSummaryLabel?: string | null;
  reviewQueueLabel?: string | null;
}

export interface DashboardMetrics {
  cycle?: DashboardCycleMetrics | null;
  velocity?: DashboardVelocityMetrics | null;
  burnup?: DashboardBurnupMetrics | null;
  health?: DashboardHealthMetrics | null;
}

export type DashboardSourceStatus = "fresh" | "empty" | "stale" | "error" | "unavailable";

export interface DashboardSourceModel {
  status: DashboardSourceStatus;
  label: string;
  detail: string;
  generatedAt: string | null;
  trackerFetchedAt: string | null;
  issueCount: number;
  runCount: number;
  lifecycleCount: number;
  activityCount: number;
  writebackCount: number;
  cached: boolean;
  error: string | null;
}

export interface DashboardModel {
  projectName: string;
  repoLabel: string;
  branch: string;
  workflowLabel: string;
  pollLabel: string;
  agentUsageLabel: string;
  concurrencyCap: number;
  providerGates: ProviderGateModel[];
  runningAgents: RunningAgentModel[];
  activity: ActivityModel[];
  chat: ChatMessage[];
  totals: DashboardTotals;
  metrics?: DashboardMetrics | null;
  source?: DashboardSourceModel | null;
}

export interface IssueBoardModel {
  issues: IssueModel[];
  backlog: IssueModel[];
  lanes: {
    todo: IssueModel[];
    progress: IssueModel[];
    review: IssueModel[];
  };
  cycleLabel: string;
  cycleDateRange: string;
  selectedIssueId: string;
}

export interface IssueDetailModel {
  issue: IssueModel;
  activity: ActivityModel[];
  runs: SessionModel[];
  transcript: TranscriptMessage[];
}

export interface HistoryModel {
  sessions: SessionModel[];
  transcriptBySession: Record<string, TranscriptMessage[]>;
  timeline: TimelineEvent[];
  defaultSessionId: string;
}

export interface SidebarModel {
  providerGates: ProviderGateModel[];
  runningAgents: RunningAgentModel[];
  reviewIssues: IssueModel[];
  activity: ActivityModel[];
  sessions: SessionModel[];
  chat: ChatMessage[];
  totals: DashboardTotals;
}

export interface ReferenceData {
  users: UserMap;
  labels: LabelMap;
}

export interface Loadable<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

export type SafeFormattedText = ReactNode;

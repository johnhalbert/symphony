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
  | "expired";
export type PriorityLevel = 0 | 1 | 2 | 3 | "urgent";
export type AppTab = "dashboard" | "issues" | "history" | "sidebar" | "states";
export type DashboardVariant = "cards" | "command-center" | "grid";
export type IssuesVariant = "balanced" | "detail-heavy";
export type HistoryVariant = "list" | "timeline" | "focused";
export type SidebarVariant = "primary" | "chat" | "history";

export interface LabelDef {
  name: string;
  color: string;
}

export interface UserDef {
  name: string;
  color: string;
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

export interface RunningAgentModel {
  id: string;
  issue: string;
  title: string;
  state: RunState | "running";
  step: string;
  duration: string;
  tokens: string;
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
  links: { issue: string; run: string; transcript: string };
}

export interface SessionModel {
  id: string;
  issue: string;
  title: string;
  state: "running" | "finished" | "error" | "cancelled" | "queued";
  model: string;
  startedAt: string;
  updatedAt: string;
  msgCount: number;
  lastEvent: string;
  toolCount: number;
  runSession?: RunSessionModel;
}

export interface ChatMessage {
  who: "agent" | "user";
  text: string;
  suggestions?: string[];
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

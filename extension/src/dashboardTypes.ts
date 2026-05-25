import type { ConnectionState } from "./connectionState";

export interface DashboardViewState {
  connection: ConnectionState;
  sections: DashboardSections | null;
}

export interface DashboardSections {
  activeSessions: ActiveSessionsSection;
  operatorQueues: OperatorQueuesSection;
  board: BoardSection;
  workspaces: WorkspaceSection;
  activity: ActivitySection;
}

export type ActiveSessionsSection =
  | { status: "ready"; data: ActiveSessionsSummary }
  | { status: "partial"; detail: string; data: ActiveSessionsSummary };

export interface ActiveSessionsSummary {
  sessions: ActiveAgentSession[];
}

export interface ActiveAgentSession {
  issueIdentifier: string;
  issueKey: string;
  role: string | null;
  statusLabel: string | null;
  runId: string | null;
  detail: string | null;
  workspace: WorkspaceContext | null;
}

export type OperatorQueuesSection =
  | { status: "ready"; data: OperatorQueuesSummary }
  | { status: "partial"; detail: string; data: OperatorQueuesSummary };

export interface OperatorQueuesSummary {
  running: OperatorRow[];
  paused: OperatorRow[];
  orphaned: OperatorRow[];
  retrying: RetryingRow[];
}

export interface OperatorRow {
  issueIdentifier: string;
  issueKey: string;
  role: string | null;
  statusLabel: string | null;
  detail: string | null;
  workspace: WorkspaceContext | null;
}

export interface RetryingRow {
  issueIdentifier: string;
  attempt: number | null;
  dueAt: string | null;
  error: string | null;
}

export type BoardSection =
  | { status: "ready"; data: BoardSummary }
  | { status: "unavailable"; detail: string }
  | { status: "error"; detail: string };

export interface BoardSummary {
  generatedAt: string | null;
  columns: BoardColumnSummary[];
  counts: BoardCounts | null;
  issues: BoardIssueSummary[];
}

export interface BoardColumnSummary {
  id: string;
  title: string;
  count: number;
}

export interface BoardCounts {
  total: number | null;
  live: number | null;
  paused: number | null;
  blocked: number | null;
}

export interface BoardIssueSummary {
  issueIdentifier: string;
  issueKey: string;
  title: string | null;
  state: string | null;
  workspace: WorkspaceContext | null;
}

export type WorkspaceSection =
  | { status: "ready"; data: WorkspaceSummary }
  | { status: "error"; detail: string };

export interface WorkspaceSummary {
  rows: WorkspaceRow[];
}

export interface WorkspaceRow {
  workspaceKey: string;
  issueIdentifier: string;
  issueKey: string;
  path: string;
  sourceKind: string | null;
  branchName: string | null;
}

export interface WorkspaceContext {
  workspaceKey: string | null;
  issueId: string | null;
  issueIdentifier: string | null;
  path: string | null;
  sourceKind: string | null;
  branchName: string | null;
}

export type ActivitySection =
  | { status: "ready"; data: ActivitySummary }
  | { status: "error"; detail: string };

export interface ActivitySummary {
  items: ActivityItemSummary[];
  totalItems: number | null;
}

export interface ActivityItemSummary {
  at: string;
  kind: string;
  issueIdentifier: string;
  summary: string | null;
}

export type DashboardRefreshTrigger = "activate" | "poll" | "visible" | "config" | "retry" | "command" | "openPanel" | "openWorkspace";

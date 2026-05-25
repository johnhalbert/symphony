import type { ConnectionState } from "./connectionState";

export interface DashboardViewState {
  connection: ConnectionState;
  sections: DashboardSections | null;
}

export interface DashboardSections {
  operatorQueues: OperatorQueuesSection;
  board: BoardSection;
  activity: ActivitySection;
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
  role: string | null;
  statusLabel: string | null;
  detail: string | null;
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

export type DashboardRefreshTrigger = "activate" | "poll" | "visible" | "config" | "retry" | "command" | "openPanel";

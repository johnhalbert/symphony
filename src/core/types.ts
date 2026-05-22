export interface IssueBlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface IssueAssigneeRef {
  id: string | null;
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branchName: string | null;
  url: string | null;
  assigneeId: string | null;
  assignedToWorker: boolean;
  labels: string[];
  blockedBy: IssueBlockerRef[];
  createdAt: string | null;
  updatedAt: string | null;
}

export interface Workspace {
  path: string;
  workspaceKey: string;
  createdNow: boolean;
  issueId?: string;
  issueIdentifier?: string;
  sourceKind?: string;
  gitBranchName?: string;
  repoPath?: string;
  baseRef?: string;
}

export type AgentRunRole = "worker" | "reviewer";

export type RunAttempt = number | null;

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface RuntimeTotals extends TokenCounts {
  secondsRunning: number;
}

export type RunTerminalReason =
  | "succeeded"
  | "failed"
  | "timed_out"
  | "stalled"
  | "cancelled";

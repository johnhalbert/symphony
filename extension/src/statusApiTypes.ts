export type JsonObject = Record<string, unknown>;

export interface IssueStatusView extends JsonObject {
  id: string | null;
  identifier: string | null;
  title: string | null;
  description: string | null;
  priority: number | null;
  state: string | null;
  branchName: string | null;
  url: string | null;
  assigneeId: string | null;
  delegateId: string | null;
  labels: string[];
  blockedBy: Array<{ id: string | null; identifier: string | null; state: string | null }>;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface IssueDetailsEnvelope extends JsonObject {
  source: string;
  completeness: string;
  issue: IssueStatusView;
  tracker: JsonObject;
  blockers: {
    available: boolean;
    totalCount: number;
    openCount: number;
    open: Array<{ id: string | null; identifier: string | null; state: string | null }>;
    blocked: boolean;
    humanBlockedReason: string | null;
  };
  workspace: {
    workspaceKey: string | null;
    path: string | null;
    sourceKind: string | null;
    branchName: string | null;
    gitBranchName: string | null;
    repoPath: string | null;
    baseRef: string | null;
  };
  pullRequest: {
    url: string | null;
    number: number | null;
    headSha: string | null;
    branch: string | null;
    ciStatus: string | null;
    lastPushedAt: string | null;
  };
  latestRun: {
    runId: string | null;
    runPhase: string | null;
    runKind: string | null;
    status: string | null;
    terminalReason: string | null;
    error: string | null;
    completedAt: string | null;
  };
}

export interface IssueBoardCard extends JsonObject {
  key: string;
  issueId: string | null;
  issueIdentifier: string | null;
  origin: string;
  lane: string;
  issueDetails: IssueDetailsEnvelope;
  paused: boolean;
  live: JsonObject | null;
  operatorLiveness: JsonObject | null;
  reviewLoop: JsonObject;
  metadata: JsonObject;
  capabilities: {
    detail?: string | null;
    runs?: string | null;
    openWorkspace?: boolean;
    mutationsRequireToken?: boolean;
    humanRequired?: { active: boolean; reason: string | null; continuationSummaryRecommended?: boolean };
    continuationSummary?: JsonObject;
    [key: string]: unknown;
  };
}

export interface IssueBoardColumn extends JsonObject {
  id: string;
  title: string;
  states: string[];
  count: number;
  issues: IssueBoardCard[];
}

export interface IssueBoardResponse extends JsonObject {
  generatedAt: string;
  tracker: JsonObject;
  columns: IssueBoardColumn[];
  issues: IssueBoardCard[];
  counts: JsonObject;
}

export interface BoardIssueDetailResponse extends JsonObject {
  issue: string;
  boardCard: IssueBoardCard | null;
  issueDetails: IssueDetailsEnvelope;
  live: JsonObject | null;
  workspace: JsonObject | null;
  latestRun: JsonObject | null;
  runs: JsonObject[];
  lifecycle: JsonObject | null;
  reviewLoop: JsonObject;
  metadata: JsonObject;
  pullRequest: IssueDetailsEnvelope["pullRequest"];
  blockers: IssueDetailsEnvelope["blockers"];
  operatorLiveness: JsonObject | null;
  capabilities: IssueBoardCard["capabilities"] & {
    transcript?: boolean;
    openWorkspace?: boolean;
    mutationsRequireToken?: boolean;
    mutationHeader?: string;
  };
}

export interface ActivityItem extends JsonObject {
  id: string;
  at: string;
  kind: string;
  source: string;
  issue: { id: string | null; identifier: string | null } | null;
  run: JsonObject | null;
  transcript: { sequence: number; eventType: string; message: string | null } | null;
  writeback: JsonObject | null;
  links: JsonObject;
}

export interface ActivityFeedResponse extends JsonObject {
  generatedAt: string;
  offset: number;
  limit: number;
  nextOffset: number | null;
  activity: ActivityItem[];
  counts: JsonObject;
  source: JsonObject;
  filter: { issue: string | null };
}

export interface TranscriptEvent extends JsonObject {
  runId: string;
  sequence: number;
  at: string;
  source: string;
  eventType: string;
  message?: string;
  payload?: unknown;
}

export interface TranscriptPage extends JsonObject {
  runId: string;
  offset: number;
  limit: number;
  nextOffset: number | null;
  events: TranscriptEvent[];
}

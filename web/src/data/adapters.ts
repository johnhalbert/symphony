import type {
  ActivityModel,
  ChatMessage,
  DashboardModel,
  DashboardTotals,
  HistoryModel,
  IssueBoardModel,
  IssueDetailModel,
  IssueModel,
  LabelMap,
  PriorityLevel,
  ReferenceData,
  RunningAgentModel,
  SessionModel,
  SidebarModel,
  TimelineEvent,
  TranscriptMessage,
  UserMap,
  ProviderGateModel,
} from "../types/symphony";

export interface RawData {
  issues: IssueModel[];
  users: UserMap;
  labels: LabelMap;
  providerGates?: ProviderGateModel[];
  runningAgents: RunningAgentModel[];
  activity: ActivityModel[];
  sessions: SessionModel[];
  transcript: TranscriptMessage[];
  dashChat: ChatMessage[];
}

export function toReferenceData(raw: Pick<RawData, "users" | "labels">): ReferenceData {
  return {
    users: raw.users,
    labels: raw.labels,
  };
}

export function computeTotals(issues: Pick<IssueModel, "status">[]): DashboardTotals {
  const totals: DashboardTotals = {
    backlog: 0,
    todo: 0,
    progress: 0,
    review: 0,
    done: 0,
    cancelled: 0,
    open: 0,
    all: 0,
    completeness: 0,
  };

  for (const issue of issues) {
    totals[issue.status] += 1;
  }

  totals.open = totals.backlog + totals.todo + totals.progress + totals.review;
  totals.all = totals.open + totals.done + totals.cancelled;
  totals.completeness = totals.all === 0 ? 0 : Math.round((totals.done / totals.all) * 100);
  return totals;
}

export function toDashboardModel(raw: RawData): DashboardModel {
  return {
    projectName: "Symphony",
    repoLabel: "openai/symphony",
    branch: "main",
    workflowLabel: "WORKFLOW.md@main",
    pollLabel: "poll 22s",
    agentUsageLabel: "4/6 agents",
    concurrencyCap: 6,
    providerGates: raw.providerGates ?? [],
    runningAgents: raw.runningAgents,
    activity: raw.activity,
    chat: raw.dashChat,
    totals: computeTotals(raw.issues),
    metrics: {
      cycle: {
        label: "Cycle 14",
        dateRange: "May 15 - May 29",
        remainingLabel: "7 days remaining",
        completenessDeltaLabel: "▲ 12% this cycle",
        projectedCompletionLabel: "96%",
      },
      velocity: {
        valueLabel: "3.2",
        unitLabel: "PR/day",
        etaLabel: "ETA: cycle ends ~3 days early",
        windowLabel: "last 14 days",
        deltaLabel: "+24",
        trendLabel: "7d avg · 14d trend ↑",
        sparkline: [1, 3, 2, 4, 3, 5, 4, 6, 5, 7, 6, 3, 8, 5],
      },
      burnup: {
        title: "Burn-up · Cycle 14",
        remainingLabel: "7 days left",
        completedSeries: [0, 2, 3, 5, 6, 8, 11, 13],
        targetSeries: [0, 2.4, 4.8, 7.2, 9.6, 12, 14.4, 16.8],
        completedEnd: 13,
        targetEnd: 17,
        currentIndex: 7,
        totalPoints: 14,
      },
      health: {
        connectionLabel: "linear · connected",
        stateLabel: "nominal",
        errorSummaryLabel: "0 errors in 24h",
        reviewQueueLabel: "3 issues in In Review agent queue · oldest 24m",
      },
    },
  };
}

export function priorityWeight(priority: PriorityLevel): number {
  return priority === "urgent" ? 4 : priority;
}

export function toIssueBoardModel(raw: RawData): IssueBoardModel {
  const sortedBacklog = raw.issues
    .filter((issue) => issue.status === "backlog" || issue.status === "todo")
    .sort((a, b) => priorityWeight(b.priority) - priorityWeight(a.priority));

  return {
    issues: raw.issues,
    backlog: sortedBacklog,
    lanes: {
      todo: raw.issues.filter((issue) => issue.status === "todo"),
      progress: raw.issues.filter((issue) => issue.status === "progress"),
      review: raw.issues.filter((issue) => issue.status === "review"),
    },
    cycleLabel: "Symphony · Cycle 14",
    cycleDateRange: "May 15 - May 29",
    selectedIssueId: "SYM-12",
  };
}

export function toIssueDetailModel(raw: RawData, issueId: string): IssueDetailModel | null {
  const issue = raw.issues.find((candidate) => candidate.id === issueId);
  if (!issue) return null;
  const runs = raw.sessions.filter((session) => session.issue === issueId);
  const sessionIds = new Set(runs.map((session) => session.id));
  return {
    issue,
    activity: raw.activity.filter((item) => item.id === issueId),
    runs,
    transcript: sessionIds.size === 0 ? [] : raw.transcript,
  };
}

export function toHistoryModel(raw: RawData): HistoryModel {
  const defaultSessionId = raw.sessions[0]?.id ?? "";
  const transcriptBySession = Object.fromEntries(raw.sessions.map((session) => [session.id, raw.transcript]));
  return {
    sessions: raw.sessions,
    transcriptBySession,
    timeline: createTimeline(raw),
    defaultSessionId,
  };
}

export function toSidebarModel(raw: RawData): SidebarModel {
  return {
    providerGates: raw.providerGates ?? [],
    runningAgents: raw.runningAgents,
    reviewIssues: raw.issues.filter((issue) => issue.status === "review").slice(0, 3),
    activity: raw.activity,
    sessions: raw.sessions,
    chat: raw.dashChat,
    totals: computeTotals(raw.issues),
  };
}

export function createTimeline(raw: Pick<RawData, "activity">): TimelineEvent[] {
  return [
    { t: "just now", sess: "SYM-12", kind: "tool_call", text: "shell.run · mix test", state: "running" },
    { t: "30s ago", sess: "SYM-42", kind: "request", text: "awaiting operator approval" },
    { t: "1m ago", sess: "SYM-18", kind: "tool_call", text: "read_file lib/symphony/tracker.ex", state: "finished" },
    { t: "1m ago", sess: "SYM-25", kind: "assistant", text: "Editing dispatcher.ex - replacing constant with backoff_ms/1" },
    { t: "2m ago", sess: "SYM-12", kind: "task", text: "Tests pass - 12/12 examples, 0 failures" },
    { t: "3m ago", sess: "SYM-12", kind: "tool_call", text: "edit_file · test/symphony/dispatcher_test.exs", state: "finished" },
    { t: "4m ago", sess: "SYM-25", kind: "thinking", text: "The semaphore should be per-workflow, not per-orchestrator. Adjusting interface..." },
    { t: "5m ago", sess: "SYM-37", kind: "task", text: "Opened PR #1255 -> main" },
    { t: "8m ago", sess: "SYM-42", kind: "tool_call", text: "shell.run · iex -S mix · stalled", state: "running" },
    { t: "12m ago", sess: "SYM-25", kind: "tool_call", text: "apply_patch · lib/symphony/dispatcher.ex", state: "finished" },
    { t: "14m ago", sess: "SYM-12", kind: "status", text: "CREATING -> RUNNING" },
    { t: "14m ago", sess: "SYM-12", kind: "user", text: "Issue: Add exponential backoff to retry queue with jitter..." },
    { t: "18m ago", sess: "SYM-15", kind: "task", text: "Entered In Review agent queue - PR #1248" },
    { t: "22m ago", sess: "SYM-42", kind: "status", text: "CREATING -> RUNNING" },
    { t: "48m ago", sess: "SYM-25", kind: "status", text: "RETRY (attempt 2/3, backoff 8s)" },
    ...raw.activity.slice(0, 0).map((item) => ({
      t: item.t,
      sess: item.id,
      kind: "status" as const,
      text: `${item.who} ${item.verb} ${item.id}`,
    })),
  ];
}

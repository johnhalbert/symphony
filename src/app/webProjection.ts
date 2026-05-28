import type { Orchestrator } from "../core/orchestrator/Orchestrator.js";
import type { RunRecord, TranscriptEvent, TranscriptPage, WorkspaceRecord } from "../core/persistence/RunTranscriptStore.js";
import type {
  AgentRunKind,
  AgentRunPhase,
  AgentRunRole,
  IssueBoardColumnId,
  IssueDetailsEnvelope,
  IssuePullRequestSummary,
  IssueStateClassification,
  IssueStatusView,
  IssueWorkspaceSummary,
} from "../core/types.js";

export type RuntimeSnapshot = ReturnType<Orchestrator["snapshot"]>;
export type RuntimeRunningIssue = RuntimeSnapshot["running"][number];

export type IssueStatus = "backlog" | "todo" | "progress" | "review" | "done" | "cancelled";
export type IssuePriority = 0 | 1 | 2 | 3 | "urgent";
export type TranscriptMessageKind = "system" | "user" | "assistant" | "thinking" | "tool_call" | "status" | "task" | "request";

export interface ReferenceLabelModel {
  name: string;
  color: string | null;
}

export interface ReferenceUserModel {
  name: string;
  color: string | null;
}

export interface ReferenceData {
  labels: Record<string, ReferenceLabelModel>;
  users: Record<string, ReferenceUserModel>;
}

export interface IssueModel {
  id: string;
  title: string;
  status: IssueStatus;
  priority: IssuePriority;
  labels: string[];
  assignee: string;
  agent: string | null;
  project: string;
  cycle: string;
  activity: IssueActivityModel[];
  pr: string | null;
  ci: string | null;
  workspace: string | null;
  session: string | null;
  desc?: string[];
}

export interface IssueActivityModel {
  t: string;
  verb: string;
  val: string | null;
  who: string | null;
}

export interface IssueBoardColumnModel {
  id: IssueStatus;
  title: string;
  count: number;
  issues: IssueModel[];
}

export interface IssueBoardCountsModel {
  total: number;
  backlog: number;
  todo: number;
  progress: number;
  review: number;
  done: number;
  cancelled: number;
  live: number;
  paused: number;
  blocked: number;
}

export interface IssueBoardModel {
  generatedAt: string | null;
  columns: IssueBoardColumnModel[];
  issues: IssueModel[];
  counts: IssueBoardCountsModel;
}

export interface WebIssueBoardLanesModel {
  todo: IssueModel[];
  progress: IssueModel[];
  review: IssueModel[];
}

export interface WebIssueBoardModel {
  issues: IssueModel[];
  backlog: IssueModel[];
  lanes: WebIssueBoardLanesModel;
  cycleLabel: string;
  cycleDateRange: string;
  selectedIssueId: string;
}

export interface RunningAgentModel {
  id: string;
  issue: string;
  title: string;
  state: string;
  step: string | null;
  duration: string | null;
  tokens: string | null;
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
  id: string;
  at: string;
  who: string | null;
  verb: string;
  issue: string | null;
  runId: string | null;
  text: string | null;
}

export interface SessionModel {
  id: string;
  issue: string;
  title: string;
  state: string;
  model: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  msgCount: number;
  lastEvent: string | null;
  toolCount: number;
}

export interface TranscriptMessage {
  kind: TranscriptMessageKind;
  ts: string;
  text: string | null;
  runId: string;
  sequence: number;
  source: TranscriptEvent["source"] | string;
  eventType: string;
  payload: unknown | null;
}

export interface ChatMessage {
  who: "agent" | "user" | "system";
  text: string;
  suggestions: string[];
}

export interface DashboardModel {
  generatedAt: string | null;
  reference: ReferenceData;
  board: IssueBoardModel;
  providerGates: ProviderGateModel[];
  runningAgents: RunningAgentModel[];
  activity: ActivityModel[];
  sessions: SessionModel[];
  chat: ChatMessage[];
}

export interface IssueDetailModel {
  issue: IssueModel;
  activity: ActivityModel[];
  runs: SessionModel[];
  transcript: TranscriptMessage[];
}

export interface WebIssueDetailModel {
  issue: IssueModel;
}

export interface HistoryModel {
  sessions: SessionModel[];
  selectedSessionId: string | null;
  transcript: TranscriptMessage[];
}

export interface SidebarModel {
  providerGates: ProviderGateModel[];
  runningAgents: RunningAgentModel[];
  reviewQueue: IssueModel[];
  recentActivity: ActivityModel[];
  poll: {
    nextPollAt: string | null;
    errorCount24h: number | null;
  };
}

export interface WebOperatorLivenessInput {
  agentId?: string | null;
  sessionId?: string | null;
  workspacePath?: string | null;
  runId?: string | null;
  activeRunId?: string | null;
  status?: string | null;
}

export interface IssueBoardCardLiveInput {
  role?: AgentRunRole | string | null;
  runPhase?: AgentRunPhase | string | null;
  runKind?: AgentRunKind | string | null;
  state?: string | null;
  runId?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
}

export interface IssueBoardCardMetadataInput {
  prUrl?: string | null | undefined;
  prNumber?: number | null | undefined;
  prHeadSha?: string | null | undefined;
  prBranch?: string | null | undefined;
  ciStatus?: string | null | undefined;
  lastPushedAt?: string | null | undefined;
  branchName?: string | null | undefined;
  gitBranchName?: string | null | undefined;
  repoPath?: string | null | undefined;
  baseRef?: string | null | undefined;
}

export interface IssueBoardCardProjectionInput {
  key: string;
  issueId: string | null;
  issueIdentifier: string | null;
  origin?: "tracker" | "symphony" | string;
  lane: IssueBoardColumnId | "cancelled" | string;
  issueDetails: IssueDetailsEnvelope;
  paused?: boolean;
  live?: IssueBoardCardLiveInput | null;
  operatorLiveness?: WebOperatorLivenessInput | null;
  metadata?: IssueBoardCardMetadataInput | null;
}

export interface IssueBoardColumnProjectionInput {
  id: IssueBoardColumnId | "cancelled" | string;
  title: string;
  states?: string[];
  count?: number;
  issues: IssueBoardCardProjectionInput[];
}

export interface IssueBoardResponseProjectionInput {
  generatedAt?: string | null;
  columns?: IssueBoardColumnProjectionInput[];
  lanes?: IssueBoardColumnProjectionInput[];
  issues?: IssueBoardCardProjectionInput[];
  counts?: Record<string, unknown>;
}

export interface BoardIssueDetailProjectionInput {
  issue: string;
  boardCard: IssueBoardCardProjectionInput | null;
  issueDetails: IssueDetailsEnvelope;
  live?: RuntimeRunningIssue | IssueBoardCardLiveInput | null;
  workspace?: IssueWorkspaceSummary | WorkspaceRecord | null;
  latestRun?: RunRecord | null;
  runs?: RunRecord[];
  pullRequest?: IssuePullRequestSummary;
  operatorLiveness?: WebOperatorLivenessInput | null;
}

export interface ActivityItemProjectionInput {
  id: string;
  at: string;
  kind: string;
  source: string;
  issue: { id: string | null; identifier: string | null } | null;
  run: {
    runId?: string | null;
    role?: AgentRunRole | string | null;
    runPhase?: AgentRunPhase | string | null;
    runKind?: AgentRunKind | string | null;
    status?: RunRecord["status"] | string | null;
    agentId?: string | null;
    sessionId?: string | null;
  } | null;
  transcript: { sequence: number; eventType: string; message: string | null } | null;
  writeback: { operationKind?: string; status?: string; skipReason?: unknown } | null;
  links?: Record<string, unknown>;
}

export interface ActivityFeedResponseProjectionInput {
  generatedAt?: string | null;
  offset?: number;
  limit?: number;
  nextOffset?: number | null;
  activity?: ActivityItemProjectionInput[];
  counts?: Record<string, unknown>;
  source?: Record<string, unknown>;
  filter?: { issue?: string | null };
}

export interface ProjectIssueModelOptions {
  requestKey?: string;
  lane?: IssueBoardColumnId | "cancelled" | string | null;
  operatorLiveness?: WebOperatorLivenessInput | null;
  latestRun?: RunRecord | null;
}

export interface DashboardProjectionInput {
  generatedAt?: string | null;
  reference?: ReferenceData;
  runtime?: RuntimeSnapshot | null;
  board?: IssueBoardResponseProjectionInput | IssueBoardModel | null;
  activity?: ActivityFeedResponseProjectionInput | ActivityModel[] | null;
  runs?: RunRecord[];
  chat?: ChatMessage[];
}

export interface SidebarProjectionInput {
  runtime?: RuntimeSnapshot | null;
  board?: IssueBoardResponseProjectionInput | IssueBoardModel | null;
  activity?: ActivityFeedResponseProjectionInput | ActivityModel[] | null;
  nextPollAt?: string | null;
  errorCount24h?: number | null;
}

const ISSUE_STATUS_ORDER: IssueStatus[] = ["backlog", "todo", "progress", "review", "done", "cancelled"];
const ISSUE_STATUS_TITLES: Record<IssueStatus, string> = {
  backlog: "Backlog",
  todo: "Todo",
  progress: "In Progress",
  review: "Review",
  done: "Done",
  cancelled: "Cancelled",
};

export function emptyReferenceData(): ReferenceData {
  return { labels: {}, users: {} };
}

export function emptyIssueModel(id = ""): IssueModel {
  return {
    id,
    title: id,
    status: "backlog",
    priority: 0,
    labels: [],
    assignee: "unassigned",
    agent: null,
    project: "",
    cycle: "",
    activity: [],
    pr: null,
    ci: null,
    workspace: null,
    session: null,
  };
}

export function emptyIssueBoardModel(generatedAt: string | null = null): IssueBoardModel {
  const columns = ISSUE_STATUS_ORDER.map((status) => ({
    id: status,
    title: ISSUE_STATUS_TITLES[status],
    count: 0,
    issues: [],
  }));
  return {
    generatedAt,
    columns,
    issues: [],
    counts: emptyIssueBoardCounts(),
  };
}

export function emptyWebIssueBoardModel(): WebIssueBoardModel {
  return {
    issues: [],
    backlog: [],
    lanes: {
      todo: [],
      progress: [],
      review: [],
    },
    cycleLabel: "",
    cycleDateRange: "",
    selectedIssueId: "",
  };
}

export function emptyDashboardModel(): DashboardModel {
  return {
    generatedAt: null,
    reference: emptyReferenceData(),
    board: emptyIssueBoardModel(),
    providerGates: [],
    runningAgents: [],
    activity: [],
    sessions: [],
    chat: [],
  };
}

export function emptyIssueDetailModel(issueId = ""): IssueDetailModel {
  return {
    issue: emptyIssueModel(issueId),
    activity: [],
    runs: [],
    transcript: [],
  };
}

export function emptyHistoryModel(): HistoryModel {
  return {
    sessions: [],
    selectedSessionId: null,
    transcript: [],
  };
}

export function emptySidebarModel(): SidebarModel {
  return {
    providerGates: [],
    runningAgents: [],
    reviewQueue: [],
    recentActivity: [],
    poll: {
      nextPollAt: null,
      errorCount24h: null,
    },
  };
}

export function emptyChatMessages(): ChatMessage[] {
  return [];
}

export function projectIssueModel(
  source: IssueBoardCardProjectionInput | IssueDetailsEnvelope,
  options: ProjectIssueModelOptions = {},
): IssueModel {
  let card: IssueBoardCardProjectionInput | null = null;
  let details: IssueDetailsEnvelope;
  if (isIssueBoardCardProjectionInput(source)) {
    card = source;
    details = source.issueDetails;
  } else {
    details = source;
  }
  const issue = details.issue;
  const id =
    firstNonEmpty(issue.identifier, card?.issueIdentifier, issue.id, card?.issueId, card?.key, options.requestKey) ?? "";
  const description = normalizeDescription(issue.description);
  const operatorLiveness = options.operatorLiveness ?? card?.operatorLiveness ?? null;
  const pullRequest = details.pullRequest;
  const model: IssueModel = {
    id,
    title: firstNonEmpty(issue.title) ?? id,
    status: deriveIssueStatus({ lane: options.lane ?? card?.lane ?? null, state: issue.state, classification: details.tracker.classification }),
    priority: clampIssuePriority(issue.priority),
    labels: Array.isArray(issue.labels) ? [...issue.labels] : [],
    assignee: firstNonEmpty(issue.assigneeId) ?? "unassigned",
    agent: agentIdFromInputs(card, operatorLiveness),
    project: "",
    cycle: "",
    activity: [],
    pr: formatPullRequest(pullRequest),
    ci: pullRequest.ciStatus ?? card?.metadata?.ciStatus ?? null,
    workspace:
      firstNonEmpty(details.workspace.path, operatorLiveness?.workspacePath, options.latestRun?.workspacePath) ?? null,
    session: firstNonEmpty(operatorLiveness?.sessionId, options.latestRun?.sessionId) ?? null,
  };
  if (description.length > 0) model.desc = description;
  return model;
}

export function projectIssueBoardModel(input: IssueBoardResponseProjectionInput | IssueBoardModel | null | undefined): IssueBoardModel {
  if (isIssueBoardModel(input)) return cloneIssueBoardModel(input);
  const generatedAt = input?.generatedAt ?? null;
  const cards = uniqueIssueCards(input);
  const issues = cards.map((card) => projectIssueModel(card));
  const model = emptyIssueBoardModel(generatedAt);
  for (const issue of issues) {
    model.issues.push(issue);
    const column = model.columns.find((candidate) => candidate.id === issue.status);
    if (column) column.issues.push(issue);
  }
  recomputeIssueBoardCounts(model);
  return model;
}

export function projectWebIssueDetail(
  input: BoardIssueDetailProjectionInput | null | undefined,
  requestKey: string,
): WebIssueDetailModel | null {
  if (!input) return null;
  return {
    issue: projectIssueModel(input.boardCard ?? input.issueDetails, {
      requestKey,
      lane: input.boardCard?.lane ?? null,
      operatorLiveness: input.operatorLiveness ?? input.boardCard?.operatorLiveness ?? null,
      latestRun: input.latestRun ?? null,
    }),
  };
}

export function projectWebIssueBoard(
  input: IssueBoardResponseProjectionInput | IssueBoardModel | WebIssueBoardModel | null | undefined,
): WebIssueBoardModel {
  if (isWebIssueBoardModel(input)) return cloneWebIssueBoardModel(input);
  const issues = isIssueBoardModel(input)
    ? input.issues.map(cloneIssueModel)
    : uniqueIssueCards(input).map((card) => projectIssueModel(card));
  const lanes: WebIssueBoardLanesModel = {
    todo: issues.filter((issue) => issue.status === "todo"),
    progress: issues.filter((issue) => issue.status === "progress"),
    review: issues.filter((issue) => issue.status === "review"),
  };
  const backlog = issues
    .map((issue, index) => ({ issue, index }))
    .filter(({ issue }) => issue.status === "backlog" || issue.status === "todo")
    .sort((left, right) => priorityWeight(right.issue.priority) - priorityWeight(left.issue.priority) || left.index - right.index)
    .map(({ issue }) => issue);
  const selectedIssue = lanes.progress[0] ?? lanes.todo[0] ?? backlog[0] ?? issues[0] ?? null;
  return {
    issues,
    backlog,
    lanes,
    cycleLabel: "",
    cycleDateRange: "",
    selectedIssueId: selectedIssue?.id ?? "",
  };
}

export function projectIssueDetailModel(input: BoardIssueDetailProjectionInput | null | undefined): IssueDetailModel {
  if (!input) return emptyIssueDetailModel();
  const issue = projectIssueModel(input.boardCard ?? input.issueDetails, {
    requestKey: input.issue,
    lane: input.boardCard?.lane ?? null,
    operatorLiveness: input.operatorLiveness ?? input.boardCard?.operatorLiveness ?? null,
    latestRun: input.latestRun ?? null,
  });
  return {
    issue,
    activity: [],
    runs: (input.runs ?? []).map(projectSessionModel),
    transcript: [],
  };
}

export function projectDashboardModel(input: DashboardProjectionInput = {}): DashboardModel {
  const board = projectIssueBoardModel(input.board ?? null);
  const activity = projectActivityModels(input.activity ?? null);
  return {
    generatedAt: input.generatedAt ?? board.generatedAt ?? null,
    reference: cloneReferenceData(input.reference ?? emptyReferenceData()),
    board,
    providerGates: projectProviderGates(input.runtime ?? null),
    runningAgents: projectRunningAgents(input.runtime ?? null),
    activity,
    sessions: (input.runs ?? []).map(projectSessionModel),
    chat: cloneChatMessages(input.chat ?? []),
  };
}

export function projectHistoryModel(input: { runs?: RunRecord[]; transcript?: TranscriptPage | TranscriptEvent[] | null; selectedRunId?: string | null } = {}): HistoryModel {
  const transcript = projectTranscriptMessages(input.transcript ?? null);
  const selectedSessionId = input.selectedRunId ?? (isTranscriptPage(input.transcript) ? input.transcript.runId : null);
  return {
    sessions: (input.runs ?? []).map(projectSessionModel),
    selectedSessionId,
    transcript,
  };
}

export function projectSidebarModel(input: SidebarProjectionInput = {}): SidebarModel {
  const board = projectIssueBoardModel(input.board ?? null);
  return {
    providerGates: projectProviderGates(input.runtime ?? null),
    runningAgents: projectRunningAgents(input.runtime ?? null),
    reviewQueue: board.issues.filter((issue) => issue.status === "review"),
    recentActivity: projectActivityModels(input.activity ?? null),
    poll: {
      nextPollAt: input.nextPollAt ?? null,
      errorCount24h: input.errorCount24h ?? null,
    },
  };
}

export function projectActivityModels(input: ActivityFeedResponseProjectionInput | ActivityModel[] | null | undefined): ActivityModel[] {
  if (!input) return [];
  if (Array.isArray(input)) return input.map(cloneActivityModel);
  return (input.activity ?? []).map((item) => ({
    id: item.id,
    at: item.at,
    who: activityActor(item),
    verb: activityVerb(item),
    issue: firstNonEmpty(item.issue?.identifier, item.issue?.id) ?? null,
    runId: firstNonEmpty(item.run?.runId) ?? null,
    text: item.transcript?.message ?? null,
  }));
}

export function projectTranscriptMessages(input: TranscriptPage | TranscriptEvent[] | null | undefined): TranscriptMessage[] {
  const events = Array.isArray(input) ? input : input?.events ?? [];
  return events.map((event) => ({
    kind: transcriptKind(event),
    ts: event.at,
    text: event.message ?? null,
    runId: event.runId,
    sequence: event.sequence,
    source: event.source,
    eventType: event.eventType,
    payload: event.payload ?? null,
  }));
}

export function projectSessionModel(run: RunRecord): SessionModel {
  return {
    id: run.sessionId ?? run.runId,
    issue: run.issueIdentifier,
    title: run.issueIdentifier,
    state: run.status,
    model: run.cursorModel ?? null,
    startedAt: run.startedAt ?? null,
    updatedAt: run.updatedAt ?? null,
    msgCount: run.transcriptEventCount ?? 0,
    lastEvent: run.error ?? null,
    toolCount: 0,
  };
}

export function projectRunningAgents(snapshot: RuntimeSnapshot | null | undefined): RunningAgentModel[] {
  return (snapshot?.running ?? []).map((row) => ({
    id: row.runId ?? row.issueIdentifier,
    issue: row.issueIdentifier,
    title: row.issueDetails.title ?? row.issueIdentifier,
    state: row.liveness.status,
    step: row.lastMessage ?? row.lastEvent,
    duration: null,
    tokens: row.tokens.totalTokens > 0 ? String(row.tokens.totalTokens) : null,
  }));
}

export function projectProviderGates(snapshot: RuntimeSnapshot | null | undefined): ProviderGateModel[] {
  return (snapshot?.providerGates ?? []).map((gate) => ({
    id: gate.id,
    provider: gate.scope.providerId ?? gate.scope.harnessId,
    kind: gate.kind,
    message: gate.message,
    resumeAt: gate.window?.resumeAt ?? null,
    resumePolicy: gate.resumePolicy,
    sourceIssue: gate.source?.issueIdentifier ?? gate.source?.issueId ?? null,
    sourceRunId: gate.source?.runId ?? null,
    affected: [...gate.affectedRoles, ...gate.affectedRunPhases].join(", "),
  }));
}

export function normalizeDescription(description: string | null | undefined): string[] {
  if (!description) return [];
  return description
    .split(/\r?\n\s*\r?\n/g)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter((paragraph) => paragraph.length > 0);
}

export function clampIssuePriority(priority: IssueStatusView["priority"] | IssuePriority | string | null | undefined): IssuePriority {
  if (priority === "urgent") return "urgent";
  if (typeof priority !== "number" || !Number.isFinite(priority)) return 0;
  if (priority <= 0) return 0;
  if (priority >= 3) return 3;
  return Math.round(priority) as 1 | 2;
}

export function deriveIssueStatus(input: {
  lane?: IssueBoardColumnId | "cancelled" | string | null;
  state?: string | null;
  classification?: IssueStateClassification | null;
}): IssueStatus {
  const laneStatus = issueStatusFromLane(input.lane ?? null);
  if (laneStatus) return laneStatus;
  const stateStatus = issueStatusFromState(input.state ?? null);
  if (stateStatus) return stateStatus;
  switch (input.classification) {
    case "active":
      return "progress";
    case "blocked":
      return "progress";
    case "handoff":
      return "review";
    case "terminal":
      return "done";
    case "unknown":
    case null:
    case undefined:
      return "backlog";
    default:
      return "backlog";
  }
}

function emptyIssueBoardCounts(): IssueBoardCountsModel {
  return {
    total: 0,
    backlog: 0,
    todo: 0,
    progress: 0,
    review: 0,
    done: 0,
    cancelled: 0,
    live: 0,
    paused: 0,
    blocked: 0,
  };
}

function recomputeIssueBoardCounts(model: IssueBoardModel): void {
  const counts = emptyIssueBoardCounts();
  counts.total = model.issues.length;
  for (const column of model.columns) {
    column.count = column.issues.length;
    counts[column.id] = column.issues.length;
  }
  counts.live = model.issues.filter((issue) => issue.agent !== null).length;
  model.counts = counts;
}

function uniqueIssueCards(input: IssueBoardResponseProjectionInput | null | undefined): IssueBoardCardProjectionInput[] {
  const seen = new Set<string>();
  const cards: IssueBoardCardProjectionInput[] = [];
  for (const card of candidateIssueCards(input)) {
    const key = firstNonEmpty(card.issueIdentifier, card.issueId, card.key);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    cards.push(card);
  }
  return cards;
}

function candidateIssueCards(input: IssueBoardResponseProjectionInput | null | undefined): IssueBoardCardProjectionInput[] {
  if (!input) return [];
  const cards = [...(input.issues ?? [])];
  for (const column of [...(input.columns ?? []), ...(input.lanes ?? [])]) {
    cards.push(...column.issues);
  }
  return cards;
}

function isIssueBoardCardProjectionInput(source: IssueBoardCardProjectionInput | IssueDetailsEnvelope): source is IssueBoardCardProjectionInput {
  return "issueDetails" in source;
}

function isIssueBoardModel(
  input: IssueBoardResponseProjectionInput | IssueBoardModel | WebIssueBoardModel | null | undefined,
): input is IssueBoardModel {
  return Boolean(input && Array.isArray((input as IssueBoardModel).columns) && Array.isArray(input.issues) && isIssueBoardCounts((input as IssueBoardModel).counts));
}

function isWebIssueBoardModel(
  input: IssueBoardResponseProjectionInput | IssueBoardModel | WebIssueBoardModel | null | undefined,
): input is WebIssueBoardModel {
  return Boolean(
    input &&
      Array.isArray(input.issues) &&
      Array.isArray((input as WebIssueBoardModel).backlog) &&
      isRecord((input as WebIssueBoardModel).lanes) &&
      Array.isArray((input as WebIssueBoardModel).lanes.todo) &&
      Array.isArray((input as WebIssueBoardModel).lanes.progress) &&
      Array.isArray((input as WebIssueBoardModel).lanes.review) &&
      typeof (input as WebIssueBoardModel).cycleLabel === "string" &&
      typeof (input as WebIssueBoardModel).cycleDateRange === "string" &&
      typeof (input as WebIssueBoardModel).selectedIssueId === "string",
  );
}

function isIssueBoardCounts(value: unknown): value is IssueBoardCountsModel {
  if (!isRecord(value)) return false;
  return ISSUE_STATUS_ORDER.every((status) => typeof value[status] === "number") && typeof value.total === "number";
}

function cloneIssueBoardModel(input: IssueBoardModel): IssueBoardModel {
  return {
    generatedAt: input.generatedAt,
    columns: input.columns.map((column) => ({ ...column, issues: column.issues.map(cloneIssueModel) })),
    issues: input.issues.map(cloneIssueModel),
    counts: { ...input.counts },
  };
}

function cloneWebIssueBoardModel(input: WebIssueBoardModel): WebIssueBoardModel {
  return {
    issues: input.issues.map(cloneIssueModel),
    backlog: input.backlog.map(cloneIssueModel),
    lanes: {
      todo: input.lanes.todo.map(cloneIssueModel),
      progress: input.lanes.progress.map(cloneIssueModel),
      review: input.lanes.review.map(cloneIssueModel),
    },
    cycleLabel: input.cycleLabel,
    cycleDateRange: input.cycleDateRange,
    selectedIssueId: input.selectedIssueId,
  };
}

function cloneIssueModel(input: IssueModel): IssueModel {
  return {
    ...input,
    labels: [...input.labels],
    activity: input.activity.map((item) => ({ ...item })),
    ...(input.desc === undefined ? {} : { desc: [...input.desc] }),
  };
}

function cloneReferenceData(input: ReferenceData): ReferenceData {
  return {
    labels: Object.fromEntries(Object.entries(input.labels).map(([key, value]) => [key, { ...value }])),
    users: Object.fromEntries(Object.entries(input.users).map(([key, value]) => [key, { ...value }])),
  };
}

function cloneActivityModel(input: ActivityModel): ActivityModel {
  return { ...input };
}

function cloneChatMessages(input: ChatMessage[]): ChatMessage[] {
  return input.map((message) => ({ ...message, suggestions: [...message.suggestions] }));
}

function agentIdFromInputs(card: IssueBoardCardProjectionInput | null, operatorLiveness: WebOperatorLivenessInput | null): string | null {
  return firstNonEmpty(operatorLiveness?.agentId, card?.live?.agentId) ?? null;
}

function issueStatusFromLane(lane: IssueBoardColumnId | "cancelled" | string | null): IssueStatus | null {
  if (!lane) return null;
  const normalized = normalizeToken(lane);
  if (normalized === "canceled" || normalized === "cancelled") return "cancelled";
  if (isIssueStatus(normalized)) return normalized;
  return null;
}

function issueStatusFromState(state: string | null): IssueStatus | null {
  if (!state) return null;
  const normalized = normalizeToken(state);
  if (normalized === "backlog") return "backlog";
  if (normalized === "todo" || normalized === "to_do") return "todo";
  if (normalized === "in_progress" || normalized === "progress" || normalized === "blocked") return "progress";
  if (
    normalized === "review" ||
    normalized === "in_review" ||
    normalized === "ready_to_merge" ||
    normalized === "human_review" ||
    normalized === "approved_with_conflicts"
  ) {
    return "review";
  }
  if (normalized === "done" || normalized === "closed" || normalized === "merged") return "done";
  if (normalized === "canceled" || normalized === "cancelled" || normalized === "duplicate") return "cancelled";
  return null;
}

function isIssueStatus(value: string): value is IssueStatus {
  return ISSUE_STATUS_ORDER.includes(value as IssueStatus);
}

function priorityWeight(priority: IssuePriority): number {
  return priority === "urgent" ? 4 : priority;
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function formatPullRequest(pullRequest: IssuePullRequestSummary): string | null {
  if (pullRequest.number !== null) return "#" + String(pullRequest.number);
  return pullRequest.url ?? null;
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

function activityActor(item: ActivityItemProjectionInput): string | null {
  return firstNonEmpty(item.run?.agentId, item.source);
}

function activityVerb(item: ActivityItemProjectionInput): string {
  if (item.kind === "transcript_event") return item.transcript?.eventType ?? item.kind;
  if (item.kind === "writeback_operation") return item.writeback?.operationKind ?? item.kind;
  return item.kind;
}

function transcriptKind(event: TranscriptEvent): TranscriptMessageKind {
  const normalizedType = normalizeToken(event.eventType);
  if (normalizedType.includes("tool")) return "tool_call";
  if (normalizedType.includes("thought") || normalizedType.includes("thinking")) return "thinking";
  if (normalizedType.includes("request") || normalizedType.includes("approval")) return "request";
  if (normalizedType.includes("completed") || normalizedType.includes("task")) return "task";
  if (event.source === "orchestrator") return "system";
  if (event.source === "cursor") return "assistant";
  return "status";
}

function isTranscriptPage(value: TranscriptPage | TranscriptEvent[] | null | undefined): value is TranscriptPage {
  return Boolean(value && !Array.isArray(value) && Array.isArray(value.events));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import type { Orchestrator } from "../core/orchestrator/Orchestrator.js";
import type { IssueLifecycleRecord } from "../core/persistence/IssueLifecycleStore.js";
import type {
  OrchestratorConversationMessage,
  OrchestratorConversationRole,
  OrchestratorConversationStatus,
} from "../core/persistence/OrchestratorConversationStore.js";
import { sanitizedPreviewValue, sanitizePublicJson } from "../core/transcript/TranscriptProjection.js";
import type { RunRecord, TranscriptEvent, TranscriptPage, WorkspaceRecord } from "../core/persistence/RunTranscriptStore.js";
import type { HistoryModel as WebHistoryModel } from "./WebHistoryProjection.js";
import { projectWebTranscript, type TranscriptMessage as WebTranscriptMessage } from "./WebTranscriptProjection.js";
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
export type TranscriptMessageKind = WebTranscriptMessage["kind"];
export type TranscriptMessage = WebTranscriptMessage;

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

export interface ChatMessage {
  id?: string;
  conversationId?: string;
  who: "agent" | "user";
  role?: OrchestratorConversationRole;
  text: string;
  status?: OrchestratorConversationStatus;
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
  suggestions?: string[];
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

export interface DashboardSourceProjectionInput {
  status?: DashboardSourceStatus | "ok" | null;
  label?: string | null;
  detail?: string | null;
  generatedAt?: string | null;
  trackerFetchedAt?: string | null;
  issueCount?: number | null;
  runCount?: number | null;
  lifecycleCount?: number | null;
  activityCount?: number | null;
  writebackCount?: number | null;
  cached?: boolean | null;
  error?: string | null;
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
  source: DashboardSourceModel;
}

export interface IssueDetailModel {
  issue: IssueModel;
  activity: ActivityModel[];
  runs: SessionModel[];
  transcript: TranscriptMessage[];
}

export type WebIssueDetailModel = IssueDetailModel;

export interface HistoryModel {
  sessions: SessionModel[];
  selectedSessionId: string | null;
  transcript: TranscriptMessage[];
}

export interface SidebarModel {
  providerGates: ProviderGateModel[];
  runningAgents: RunningAgentModel[];
  reviewIssues: IssueModel[];
  activity: ActivityModel[];
  sessions: WebHistoryModel["sessions"];
  chat: ChatMessage[];
  totals: DashboardTotals;
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

interface IssueBoardCardReviewLoopInput {
  phase?: string | null;
  blockedReason?: string | null;
  reviewRound?: number | null;
  incompleteTurnCount?: number | null;
  lastCompletionReport?: { summary?: string | null; acceptedAt?: string | null; id?: string | null } | null;
  lastReviewVerdict?: {
    verdict?: string | null;
    findings?: string[] | null;
    evidence?: string[] | null;
    submittedAt?: string | null;
    id?: string | null;
  } | null;
  lastIssueTriageReport?: {
    disposition?: string | null;
    confidence?: string | null;
    summary?: string | null;
    recommendedAction?: string | null;
    submittedAt?: string | null;
    id?: string | null;
  } | null;
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
  reviewLoop?: IssueBoardCardReviewLoopInput | null;
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

type WebReferenceIssueInput = Pick<IssueStatusView, "assigneeId" | "delegateId" | "labels">;

interface WebReferenceIssueCardInput {
  key?: string | null;
  issueId?: string | null;
  issueIdentifier?: string | null;
  issueDetails: { issue: WebReferenceIssueInput };
}

interface WebReferenceBoardColumnInput {
  id?: string;
  title?: string;
  states?: string[];
  count?: number;
  issues?: WebReferenceIssueCardInput[];
}

interface WebReferenceBoardInput {
  generatedAt?: string | null;
  tracker?: unknown;
  counts?: Record<string, unknown>;
  issues?: WebReferenceIssueCardInput[];
  columns?: WebReferenceBoardColumnInput[];
  lanes?: WebReferenceBoardColumnInput[];
}

export interface BoardIssueDetailProjectionInput {
  issue: string;
  boardCard: IssueBoardCardProjectionInput | null;
  issueDetails: IssueDetailsEnvelope;
  live?: RuntimeRunningIssue | IssueBoardCardLiveInput | null;
  workspace?: IssueWorkspaceSummary | WorkspaceRecord | null;
  latestRun?: RunRecord | null;
  runs?: RunRecord[];
  activity?: ActivityFeedResponseProjectionInput | ActivityModel[] | null;
  transcript?: TranscriptPage | TranscriptEvent[] | null;
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

export interface DashboardRuntimeConfig {
  repoLabel?: string | null;
  branch?: string | null;
  workflowLabel?: string | null;
  pollIntervalMs?: number | null;
  concurrencyCap?: number | null;
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
  runs?: readonly RunRecord[];
  lifecycleRecords?: readonly IssueLifecycleRecord[];
  chat?: ChatMessage[];
  source?: DashboardSourceProjectionInput | null;
  config?: DashboardRuntimeConfig | null | undefined;
}

export interface SidebarProjectionInput {
  runtime?: RuntimeSnapshot | null;
  board?: IssueBoardResponseProjectionInput | IssueBoardModel | null;
  activity?: ActivityFeedResponseProjectionInput | ActivityModel[] | null;
  runs?: readonly RunRecord[];
  lifecycleRecords?: readonly IssueLifecycleRecord[];
  history?: WebHistoryModel | null;
  chat?: ChatMessage[] | null;
  config?: DashboardRuntimeConfig | null | undefined;
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

const REFERENCE_COLOR_PALETTE = [
  "#2563eb",
  "#7c3aed",
  "#db2777",
  "#dc2626",
  "#ea580c",
  "#ca8a04",
  "#16a34a",
  "#0891b2",
  "#4f46e5",
  "#64748b",
] as const;

export function deterministicColor(value: string): string {
  const key = normalizeReferenceKey(value) ?? "unassigned";
  let hash = 2_166_136_261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return REFERENCE_COLOR_PALETTE[hash % REFERENCE_COLOR_PALETTE.length] ?? REFERENCE_COLOR_PALETTE[0];
}

export function emptyReferenceData(): ReferenceData {
  return { labels: {}, users: { unassigned: referenceUser("unassigned", "Unassigned") } };
}

export function projectWebReferenceData(input: WebReferenceBoardInput | IssueBoardModel | WebIssueBoardModel | null | undefined): ReferenceData {
  const labels = new Map<string, ReferenceLabelModel>();
  const users = new Map<string, ReferenceUserModel>();
  addReferenceUser(users, "unassigned", "Unassigned");

  if (isIssueBoardModel(input)) {
    for (const issue of input.issues) {
      for (const label of issue.labels) addReferenceLabel(labels, label);
      addReferenceUser(users, issue.assignee);
    }
  } else if (isWebIssueBoardModel(input)) {
    for (const issue of input.issues) {
      for (const label of issue.labels) addReferenceLabel(labels, label);
      addReferenceUser(users, issue.assignee);
      addReferenceUser(users, issue.agent);
    }
  } else {
    for (const card of uniqueReferenceCards(input)) {
      const issue = card.issueDetails.issue;
      for (const label of issue.labels) addReferenceLabel(labels, label);
      addReferenceUser(users, issue.assigneeId);
      addReferenceUser(users, issue.delegateId);
    }
  }

  return {
    users: sortedReferenceRecord(users),
    labels: sortedReferenceRecord(labels),
  };
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
    projectName: "Symphony",
    repoLabel: "",
    branch: "",
    workflowLabel: "",
    pollLabel: "",
    agentUsageLabel: "0 agents",
    concurrencyCap: 0,
    providerGates: [],
    runningAgents: [],
    activity: [],
    chat: [],
    totals: emptyDashboardTotals(),
    source: emptyDashboardSourceModel(),
  };
}

export function emptyDashboardSourceModel(): DashboardSourceModel {
  return {
    status: "unavailable",
    label: "source unavailable",
    detail: "No dashboard source metadata is available.",
    generatedAt: null,
    trackerFetchedAt: null,
    issueCount: 0,
    runCount: 0,
    lifecycleCount: 0,
    activityCount: 0,
    writebackCount: 0,
    cached: false,
    error: null,
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
    reviewIssues: [],
    activity: [],
    sessions: [],
    chat: [],
    totals: emptyDashboardTotals(),
  };
}

export function emptyChatMessages(): ChatMessage[] {
  return [];
}

export function projectWebOrchestratorChat(
  messages: readonly OrchestratorConversationMessage[] | readonly ChatMessage[] = [],
): ChatMessage[] {
  return messages.map(projectWebOrchestratorChatMessage);
}

export function projectWebOrchestratorChatPost(
  input: string,
  messages: readonly OrchestratorConversationMessage[] | readonly ChatMessage[] = [],
): ChatMessage[] {
  if (messages.length > 0) return projectWebOrchestratorChat(messages);
  const trimmed = input.trim();
  return trimmed ? projectWebOrchestratorChat([{ who: "user", text: trimmed }]) : [];
}

function projectWebOrchestratorChatMessage(message: OrchestratorConversationMessage | ChatMessage): ChatMessage {
  if (isOrchestratorConversationMessage(message)) {
    return {
      id: message.id,
      conversationId: message.conversationId,
      who: message.role === "user" ? "user" : "agent",
      role: message.role,
      text: sanitizedPreviewValue(message.body, 10_000).preview ?? "",
      status: message.status,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
      metadata: sanitizePublicJson(message.metadata) as Record<string, unknown>,
    };
  }

  const projected: ChatMessage = {
    who: message.who === "user" ? "user" : "agent",
    text: message.text,
  };
  const suggestions = Array.isArray(message.suggestions)
    ? message.suggestions.map((suggestion) => suggestion.trim()).filter((suggestion) => suggestion.length > 0)
    : [];
  if (suggestions.length > 0) projected.suggestions = suggestions;
  return projected;
}

function isOrchestratorConversationMessage(
  message: OrchestratorConversationMessage | ChatMessage,
): message is OrchestratorConversationMessage {
  return "body" in message && typeof message.body === "string" && "role" in message && typeof message.role === "string";
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
  const operatorLiveness = options.operatorLiveness ?? card?.operatorLiveness ?? null;
  const pullRequest = details.pullRequest;
  const model: IssueModel = {
    id,
    title: firstNonEmpty(issue.title) ?? id,
    status: deriveIssueStatus({
      lane: options.lane ?? card?.lane ?? null,
      state: issue.state,
      classification: details.tracker.classification,
      lifecyclePhase: card?.reviewLoop?.phase ?? null,
      runStatus: details.latestRun.status,
    }),
    priority: clampIssuePriority(issue.priority),
    labels: Array.isArray(issue.labels) ? [...issue.labels] : [],
    assignee: firstNonEmpty(issue.assigneeId) ?? "unassigned",
    agent: agentIdFromInputs(card, operatorLiveness),
    project: "",
    cycle: "",
    activity: projectIssueActivity(details, card, operatorLiveness),
    pr: formatPullRequest(pullRequest, card?.metadata ?? null),
    ci: pullRequest.ciStatus ?? card?.metadata?.ciStatus ?? options.latestRun?.ciStatus ?? null,
    workspace:
      firstNonEmpty(details.workspace.path, operatorLiveness?.workspacePath, options.latestRun?.workspacePath, details.workspace.workspaceKey) ?? null,
    session:
      firstNonEmpty(
        operatorLiveness?.sessionId,
        card?.live?.sessionId,
        options.latestRun?.sessionId,
        operatorLiveness?.activeRunId,
        operatorLiveness?.runId,
        card?.live?.runId,
        options.latestRun?.runId,
        details.latestRun.runId,
      ) ?? null,
  };
  const description = projectIssueDescription(details, card?.reviewLoop ?? null);
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
  const transcriptEvents = Array.isArray(input.transcript) ? input.transcript : (input.transcript?.events ?? []);
  const includeRunPrelude = transcriptEvents.length > 0;
  return {
    issue: projectIssueModel(input.boardCard ?? input.issueDetails, {
      requestKey,
      lane: input.boardCard?.lane ?? null,
      operatorLiveness: input.operatorLiveness ?? input.boardCard?.operatorLiveness ?? null,
      latestRun: input.latestRun ?? null,
    }),
    activity: projectActivityModels(input.activity ?? null),
    runs: (input.runs ?? []).map(projectSessionModel),
    transcript: projectTranscriptMessages(input.transcript ?? null, {
      run: input.latestRun ?? null,
      includeRunPrelude,
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
  return projectWebIssueDetail(input, input.issue) ?? emptyIssueDetailModel(input.issue);
}

export function projectWebDashboard(input: DashboardProjectionInput = {}): DashboardModel {
  const board = projectIssueBoardModel(input.board ?? null);
  const runtime = input.runtime ?? null;
  const hasRuntimeSnapshot = input.runtime !== null && input.runtime !== undefined;
  const runs = input.runs ?? [];
  const lifecycleRecords = input.lifecycleRecords ?? [];
  const activity = projectActivityModels(input.activity ?? null);
  const generatedAt =
    runtime?.generatedAt ?? input.generatedAt ?? board.generatedAt ?? latestDurableActivityAt(runs, lifecycleRecords);
  const runningAgents = hasRuntimeSnapshot
    ? projectRunningAgents(runtime, generatedAt)
    : projectDurableRunningAgents(runs, generatedAt);
  const concurrencyCap = normalizeConcurrencyCap(input.config?.concurrencyCap);
  return {
    projectName: "Symphony",
    repoLabel: firstNonEmpty(input.config?.repoLabel) ?? "",
    branch: firstNonEmpty(input.config?.branch) ?? "",
    workflowLabel: firstNonEmpty(input.config?.workflowLabel) ?? "",
    pollLabel: formatPollLabel(input.config?.pollIntervalMs),
    agentUsageLabel: formatAgentUsageLabel(runningAgents.length, concurrencyCap),
    concurrencyCap,
    providerGates: projectProviderGates(runtime),
    runningAgents,
    activity,
    // Dashboard chat is intentionally out of scope; ignore any caller-supplied chat payloads.
    chat: emptyChatMessages(),
    totals: dashboardTotalsFromDurableState(board, runs, lifecycleRecords),
    source: projectDashboardSource(input.source ?? null, {
      generatedAt,
      issueCount: board.issues.length,
      runCount: runs.length,
      lifecycleCount: lifecycleRecords.length,
      activityCount: activity.length,
    }),
  };
}

export function projectDashboardModel(input: DashboardProjectionInput = {}): DashboardModel {
  return projectWebDashboard(input);
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
  return projectWebSidebar(
    projectWebDashboard({
      runtime: input.runtime ?? null,
      board: input.board ?? null,
      activity: input.activity ?? null,
      runs: input.runs ?? [],
      lifecycleRecords: input.lifecycleRecords ?? [],
      config: input.config ?? null,
    }),
    projectWebIssueBoard(input.board ?? null),
    input.history ?? { sessions: [], transcriptBySession: {}, timeline: [], defaultSessionId: "" },
    input.chat ?? emptyChatMessages(),
  );
}

export function projectWebSidebar(
  dashboard: DashboardModel,
  issues: WebIssueBoardModel,
  history: WebHistoryModel,
  chat: ChatMessage[],
): SidebarModel {
  return {
    providerGates: dashboard.providerGates,
    runningAgents: dashboard.runningAgents,
    reviewIssues: issues.lanes.review.slice(0, 3),
    activity: dashboard.activity,
    sessions: history.sessions,
    chat,
    totals: dashboard.totals,
  };
}

export function projectActivityModels(input: ActivityFeedResponseProjectionInput | ActivityModel[] | null | undefined): ActivityModel[] {
  if (!input) return [];
  if (Array.isArray(input)) return input.map(cloneActivityModel);
  return (input.activity ?? []).map((item) => ({
    t: item.at,
    who: activityActor(item) ?? "",
    verb: activityVerb(item),
    id: activityDisplayId(item),
    extra: activityExtra(item),
  }));
}

export function projectTranscriptMessages(
  input: TranscriptPage | TranscriptEvent[] | null | undefined,
  options: { run?: RunRecord | null; includeRunPrelude?: boolean } = {},
): TranscriptMessage[] {
  const events = Array.isArray(input) ? input : input?.events ?? [];
  return projectWebTranscript(events, options);
}

export function projectSessionModel(run: RunRecord): SessionModel {
  return {
    id: run.sessionId ?? run.runId,
    issue: run.issueIdentifier,
    title: run.issueIdentifier,
    state: run.status,
    model: firstNonEmpty(run.runtimeModel, legacyCursorRuntimeFallbackModel(run)),
    startedAt: run.startedAt ?? null,
    updatedAt: run.updatedAt ?? null,
    msgCount: run.transcriptEventCount ?? 0,
    lastEvent: run.error ?? null,
    toolCount: 0,
  };
}

function legacyCursorRuntimeFallbackModel(run: RunRecord): string | null {
  return shouldUseCursorRuntimeFallback(run) ? firstNonEmpty(run.cursorModel) : null;
}

function shouldUseCursorRuntimeFallback(run: RunRecord): boolean {
  const harnessId = firstNonEmpty(run.harnessId);
  if (harnessId === "cursor") return true;
  if (harnessId) return false;
  return (
    run.cursorModel !== undefined ||
    run.cursorModelParams !== undefined ||
    run.cursorMode !== undefined ||
    run.cursorSettingSources !== undefined
  );
}

export function projectRunningAgents(snapshot: RuntimeSnapshot | null | undefined, generatedAt: string | null | undefined = snapshot?.generatedAt ?? null): RunningAgentModel[] {
  return (snapshot?.running ?? []).map((row) => {
    const id = firstNonEmpty(row.runId, row.issueIdentifier, row.issueId) ?? "";
    const issue = firstNonEmpty(row.issueIdentifier, row.issueId) ?? "";
    const totalTokens = row.tokens?.totalTokens ?? 0;
    return {
      id,
      issue,
      title: firstNonEmpty(row.issueDetails?.title, row.issueIdentifier, row.issueId, row.runId) ?? "",
      state: firstNonEmpty(row.liveness?.status, row.state) ?? "",
      step: firstNonEmpty(row.lastMessage, row.lastEvent) ?? "",
      duration: formatRunDuration(row.startedAt, generatedAt),
      tokens: Number.isFinite(totalTokens) && totalTokens > 0 ? String(totalTokens) : "",
    };
  });
}

function projectDurableRunningAgents(runs: readonly RunRecord[], generatedAt: string | null | undefined): RunningAgentModel[] {
  return [...runs]
    .filter((run) => run.status === "running")
    .sort((left, right) => compareDashboardRunRecency(right, left))
    .map((run) => {
      const id = firstNonEmpty(run.runId, run.issueIdentifier, run.issueId, run.workspaceKey) ?? "";
      const issue = firstNonEmpty(run.issueIdentifier, run.issueId, run.workspaceKey) ?? "";
      const totalTokens = run.tokens?.totalTokens ?? 0;
      return {
        id,
        issue,
        title: firstNonEmpty(run.issueIdentifier, run.issueId, run.runId) ?? "",
        state: run.status,
        step: firstNonEmpty(run.runPhase, run.runKind, run.role) ?? "",
        duration: formatRunDuration(run.startedAt, generatedAt ?? run.updatedAt),
        tokens: Number.isFinite(totalTokens) && totalTokens > 0 ? String(totalTokens) : "",
      };
    });
}

export function projectProviderGates(snapshot: RuntimeSnapshot | null | undefined): ProviderGateModel[] {
  return (snapshot?.providerGates ?? []).map((gate) => {
    const affected = [
      ...(Array.isArray(gate.affectedRoles) ? gate.affectedRoles : []),
      ...(Array.isArray(gate.affectedRunPhases) ? gate.affectedRunPhases : []),
    ]
      .filter((value) => typeof value === "string" && value.trim().length > 0)
      .join(", ");
    return {
      id: firstNonEmpty(gate.id) ?? "",
      provider: firstNonEmpty(gate.scope?.providerId, gate.scope?.harnessId) ?? "",
      kind: firstNonEmpty(gate.kind) ?? "",
      message: firstNonEmpty(gate.message) ?? "",
      resumeAt: gate.window?.resumeAt ?? null,
      resumePolicy: firstNonEmpty(gate.resumePolicy) ?? "",
      sourceIssue: firstNonEmpty(gate.source?.issueIdentifier, gate.source?.issueId) ?? null,
      sourceRunId: firstNonEmpty(gate.source?.runId) ?? null,
      affected,
    };
  });
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
  lifecyclePhase?: string | null;
  runStatus?: RunRecord["status"] | string | null;
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
      break;
    default:
      break;
  }
  const lifecycleStatus = issueStatusFromLifecyclePhase(input.lifecyclePhase ?? null);
  if (lifecycleStatus) return lifecycleStatus;
  const runStatus = issueStatusFromRunStatus(input.runStatus ?? null);
  if (runStatus) return runStatus;
  return "backlog";
}

function emptyDashboardTotals(): DashboardTotals {
  return {
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
}

function projectDashboardSource(
  source: DashboardSourceProjectionInput | null,
  fallback: {
    generatedAt: string | null;
    issueCount: number;
    runCount: number;
    lifecycleCount: number;
    activityCount: number;
  },
): DashboardSourceModel {
  if (
    !source &&
    !fallback.generatedAt &&
    fallback.issueCount === 0 &&
    fallback.runCount === 0 &&
    fallback.lifecycleCount === 0 &&
    fallback.activityCount === 0
  ) {
    return emptyDashboardSourceModel();
  }
  const cached = source?.cached === true;
  const issueCount = normalizeCount(source?.issueCount, fallback.issueCount);
  const runCount = normalizeCount(source?.runCount, fallback.runCount);
  const lifecycleCount = normalizeCount(source?.lifecycleCount, fallback.lifecycleCount);
  const activityCount = normalizeCount(source?.activityCount, fallback.activityCount);
  const writebackCount = normalizeCount(source?.writebackCount, 0);
  const error = firstNonEmpty(source?.error) ?? null;
  const status = normalizeDashboardSourceStatus(source?.status ?? null, {
    cached,
    error,
    issueCount,
    hasSourceMetadata: Boolean(source),
  });

  return {
    status,
    label: firstNonEmpty(source?.label) ?? dashboardSourceLabel(status, issueCount),
    detail: firstNonEmpty(source?.detail) ?? dashboardSourceDetail(status, { runCount, lifecycleCount, activityCount, writebackCount, error }),
    generatedAt: source?.generatedAt ?? fallback.generatedAt ?? null,
    trackerFetchedAt: source?.trackerFetchedAt ?? null,
    issueCount,
    runCount,
    lifecycleCount,
    activityCount,
    writebackCount,
    cached,
    error,
  };
}

function normalizeDashboardSourceStatus(
  status: DashboardSourceProjectionInput["status"] | null,
  input: { cached: boolean; error: string | null; issueCount: number; hasSourceMetadata: boolean },
): DashboardSourceStatus {
  if (status === "fresh" || status === "empty" || status === "stale" || status === "error" || status === "unavailable") {
    return status;
  }
  if (status === "ok") return input.cached ? "stale" : input.issueCount === 0 ? "empty" : "fresh";
  if (input.error) return "error";
  if (!input.hasSourceMetadata) return "unavailable";
  if (input.cached) return "stale";
  return input.issueCount === 0 ? "empty" : "fresh";
}

function dashboardSourceLabel(status: DashboardSourceStatus, issueCount: number): string {
  switch (status) {
    case "fresh":
      return `tracker fresh · ${issueCount} issues`;
    case "empty":
      return "tracker empty · 0 issues";
    case "stale":
      return `tracker stale · ${issueCount} cached issues`;
    case "error":
      return "tracker error";
    case "unavailable":
      return "tracker unavailable";
  }
}

function dashboardSourceDetail(
  status: DashboardSourceStatus,
  input: { runCount: number; lifecycleCount: number; activityCount: number; writebackCount: number; error: string | null },
): string {
  if (input.error && (status === "error" || status === "unavailable")) return input.error;
  const durableSummary = `${input.runCount} runs · ${input.lifecycleCount} lifecycle records · ${input.activityCount} activity entries · ${input.writebackCount} writeback operations`;
  switch (status) {
    case "fresh":
      return `Issue board tracker source is current; ${durableSummary}.`;
    case "empty":
      return `Issue board tracker source returned no issues; ${durableSummary}.`;
    case "stale":
      return `Using a cached tracker source while refresh catches up; ${durableSummary}.`;
    case "error":
      return `Issue board tracker source failed; ${durableSummary}.`;
    case "unavailable":
      return `Issue board tracker source is unavailable; ${durableSummary}.`;
  }
}

function normalizeCount(value: number | null | undefined, fallback: number): number {
  const count = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return count > 0 ? Math.floor(count) : 0;
}

function dashboardTotalsFromBoard(board: IssueBoardModel): DashboardTotals {
  return finalizeDashboardTotals(
    board.issues.reduce((totals, issue) => {
      totals[issue.status] += 1;
      return totals;
    }, emptyDashboardTotals()),
  );
}

function dashboardTotalsFromDurableState(
  board: IssueBoardModel,
  runs: readonly RunRecord[],
  lifecycleRecords: readonly IssueLifecycleRecord[],
): DashboardTotals {
  if (runs.length === 0 && lifecycleRecords.length === 0) return dashboardTotalsFromBoard(board);

  const totals = emptyDashboardTotals();
  const representedAliases = new Set<string>();
  const latestRunByAlias = buildLatestRunByAlias(runs);

  for (const issue of board.issues) {
    addDashboardIssueStatus(totals, representedAliases, issue.status, [issue.id], `board:${issue.id}`);
  }

  for (const lifecycle of lifecycleRecords) {
    const aliases = dashboardLifecycleAliases(lifecycle);
    const latestRun = latestRunForAliases(latestRunByAlias, aliases);
    addDashboardIssueStatus(
      totals,
      representedAliases,
      deriveIssueStatus({ lifecyclePhase: lifecycle.phase, runStatus: latestRun?.status ?? null }),
      aliases,
      `lifecycle:${lifecycle.issueId}:${lifecycle.issueIdentifier}`,
    );
  }

  for (const run of [...runs].sort((left, right) => compareDashboardRunRecency(right, left))) {
    addDashboardIssueStatus(
      totals,
      representedAliases,
      deriveIssueStatus({ runStatus: run.status }),
      dashboardRunAliases(run),
      `run:${run.runId}`,
    );
  }

  return finalizeDashboardTotals(totals);
}

function addDashboardIssueStatus(
  totals: DashboardTotals,
  representedAliases: Set<string>,
  status: IssueStatus,
  aliases: readonly (string | null | undefined)[],
  fallbackAlias: string,
): void {
  const normalizedAliases = normalizedDashboardAliases(aliases);
  if (normalizedAliases.some((alias) => representedAliases.has(alias))) return;
  const aliasesToRecord = normalizedAliases.length > 0 ? normalizedAliases : normalizedDashboardAliases([fallbackAlias]);
  for (const alias of aliasesToRecord) representedAliases.add(alias);
  totals[status] += 1;
}

function finalizeDashboardTotals(totals: DashboardTotals): DashboardTotals {
  totals.open = totals.backlog + totals.todo + totals.progress + totals.review;
  totals.all = totals.open + totals.done + totals.cancelled;
  totals.completeness = totals.all === 0 ? 0 : Math.round((totals.done / totals.all) * 100);
  return totals;
}

function buildLatestRunByAlias(runs: readonly RunRecord[]): Map<string, RunRecord> {
  const latestRunByAlias = new Map<string, RunRecord>();
  for (const run of runs) {
    for (const alias of normalizedDashboardAliases(dashboardRunAliases(run))) {
      const existing = latestRunByAlias.get(alias);
      if (!existing || compareDashboardRunRecency(run, existing) > 0) latestRunByAlias.set(alias, run);
    }
  }
  return latestRunByAlias;
}

function latestRunForAliases(latestRunByAlias: ReadonlyMap<string, RunRecord>, aliases: readonly (string | null | undefined)[]): RunRecord | null {
  let latest: RunRecord | null = null;
  for (const alias of normalizedDashboardAliases(aliases)) {
    const candidate = latestRunByAlias.get(alias);
    if (!candidate) continue;
    if (!latest || compareDashboardRunRecency(candidate, latest) > 0) latest = candidate;
  }
  return latest;
}

function dashboardLifecycleAliases(lifecycle: IssueLifecycleRecord): string[] {
  return dashboardAliases(lifecycle.issueId, lifecycle.issueIdentifier, lifecycle.summaryPointers?.workspaceKey);
}

function dashboardRunAliases(run: RunRecord): string[] {
  return dashboardAliases(run.issueId, run.issueIdentifier, run.workspaceKey);
}

function dashboardAliases(...values: readonly (string | null | undefined)[]): string[] {
  const aliases: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeDashboardAlias(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    aliases.push(normalized);
  }
  return aliases;
}

function normalizedDashboardAliases(values: readonly (string | null | undefined)[]): string[] {
  return dashboardAliases(...values);
}

function normalizeDashboardAlias(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : null;
}

function latestDurableActivityAt(runs: readonly RunRecord[], lifecycleRecords: readonly IssueLifecycleRecord[]): string | null {
  let latestValue: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  const consider = (value: string | null | undefined) => {
    const ms = Date.parse(value ?? "");
    if (!Number.isFinite(ms) || ms <= latestMs) return;
    latestMs = ms;
    latestValue = value ?? null;
  };
  for (const run of runs) {
    consider(run.updatedAt);
    consider(run.completedAt);
    consider(run.startedAt);
  }
  for (const lifecycle of lifecycleRecords) {
    consider(lifecycle.updatedAt);
    consider(lifecycle.createdAt);
  }
  return latestValue;
}

function compareDashboardRunRecency(left: RunRecord, right: RunRecord): number {
  const delta = dashboardRunActivityMs(left) - dashboardRunActivityMs(right);
  if (delta !== 0) return delta;
  return left.runId.localeCompare(right.runId);
}

function dashboardRunActivityMs(run: RunRecord): number {
  const times = [run.updatedAt, run.completedAt, run.startedAt]
    .map((value) => Date.parse(value ?? ""))
    .filter((value) => Number.isFinite(value));
  return times.length === 0 ? Number.NEGATIVE_INFINITY : Math.max(...times);
}

function normalizeConcurrencyCap(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

export function formatAgentUsageLabel(runningCount: number, concurrencyCap: number): string {
  if (concurrencyCap > 0) return `${runningCount}/${concurrencyCap} agents`;
  return `${runningCount} ${runningCount === 1 ? "agent" : "agents"}`;
}

function formatPollLabel(intervalMs: number | null | undefined): string {
  if (typeof intervalMs !== "number" || !Number.isFinite(intervalMs) || intervalMs <= 0) return "";
  if (intervalMs % 1000 === 0) return `poll ${intervalMs / 1000}s`;
  return `poll ${intervalMs}ms`;
}

function formatRunDuration(startedAt: string | null | undefined, generatedAt: string | null | undefined): string {
  const startedMs = Date.parse(startedAt ?? "");
  const generatedMs = Date.parse(generatedAt ?? "");
  if (!Number.isFinite(startedMs) || !Number.isFinite(generatedMs) || generatedMs < startedMs) return "";
  const seconds = Math.floor((generatedMs - startedMs) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
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

function uniqueReferenceCards(input: WebReferenceBoardInput | null | undefined): WebReferenceIssueCardInput[] {
  const seen = new Set<string>();
  const cards: WebReferenceIssueCardInput[] = [];
  for (const card of candidateReferenceCards(input)) {
    const key = firstNonEmpty(card.issueIdentifier, card.issueId, card.key);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    cards.push(card);
  }
  return cards;
}

function candidateReferenceCards(input: WebReferenceBoardInput | null | undefined): WebReferenceIssueCardInput[] {
  if (!input) return [];
  const cards = [...(input.issues ?? [])];
  for (const column of [...(input.columns ?? []), ...(input.lanes ?? [])]) {
    cards.push(...(column.issues ?? []));
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

function isIssueBoardModel(input: unknown): input is IssueBoardModel {
  if (!isRecord(input)) return false;
  return Array.isArray(input.columns) && Array.isArray(input.issues) && isIssueBoardCounts(input.counts);
}

function isWebIssueBoardModel(input: unknown): input is WebIssueBoardModel {
  if (!isRecord(input) || !isRecord(input.lanes)) return false;
  return (
    Array.isArray(input.issues) &&
    Array.isArray(input.backlog) &&
    Array.isArray(input.lanes.todo) &&
    Array.isArray(input.lanes.progress) &&
    Array.isArray(input.lanes.review) &&
    typeof input.cycleLabel === "string" &&
    typeof input.cycleDateRange === "string" &&
    typeof input.selectedIssueId === "string"
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

function addReferenceLabel(labels: Map<string, ReferenceLabelModel>, value: string | null | undefined): void {
  const name = normalizeReferenceKey(value);
  if (!name || labels.has(name)) return;
  labels.set(name, { name, color: deterministicColor(name) });
}

function addReferenceUser(users: Map<string, ReferenceUserModel>, value: string | null | undefined, displayName?: string): void {
  const key = normalizeReferenceKey(value);
  if (!key || users.has(key)) return;
  users.set(key, referenceUser(key, displayName ?? key));
}

function referenceUser(key: string, name: string): ReferenceUserModel {
  return { name, color: deterministicColor(key) };
}

function sortedReferenceRecord<T>(items: Map<string, T>): Record<string, T> {
  return Object.fromEntries([...items.entries()].sort(([left], [right]) => compareReferenceKeys(left, right)));
}

function compareReferenceKeys(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function normalizeReferenceKey(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function agentIdFromInputs(card: IssueBoardCardProjectionInput | null, operatorLiveness: WebOperatorLivenessInput | null): string | null {
  return firstNonEmpty(operatorLiveness?.agentId, card?.live?.agentId, card?.issueDetails.issue.delegateId) ?? null;
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

function issueStatusFromLifecyclePhase(phase: string | null): IssueStatus | null {
  if (!phase) return null;
  const normalized = normalizeToken(phase);
  if (normalized === "implementation" || normalized === "merge_conflict_resolution" || normalized === "blocked") {
    return "progress";
  }
  if (normalized === "review" || normalized === "passed") return "review";
  if (normalized === "terminal") return "done";
  return null;
}

function issueStatusFromRunStatus(status: RunRecord["status"] | string | null): IssueStatus | null {
  if (!status) return null;
  const normalized = normalizeToken(status);
  if (normalized === "running") return "progress";
  if (normalized === "succeeded") return "done";
  if (normalized === "cancelled" || normalized === "canceled") return "cancelled";
  if (normalized === "failed") return "progress";
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

function projectIssueDescription(
  details: IssueDetailsEnvelope,
  reviewLoop: IssueBoardCardReviewLoopInput | null,
): string[] {
  const description = normalizeDescription(details.issue.description);
  const blockerText = issueBlockerDescription(details);
  if (blockerText) description.push(blockerText);
  addUniqueText(description, reviewLoop?.blockedReason ?? null);
  addUniqueText(description, reviewLoop?.lastCompletionReport?.summary ?? null);
  addUniqueText(description, reviewLoop?.lastIssueTriageReport?.summary ?? null);
  addUniqueText(description, reviewLoop?.lastIssueTriageReport?.recommendedAction ?? null);
  for (const finding of reviewLoop?.lastReviewVerdict?.findings ?? []) {
    addUniqueText(description, finding);
  }
  if (details.latestRun.error) addUniqueText(description, details.latestRun.error);
  return description;
}

function issueBlockerDescription(details: IssueDetailsEnvelope): string | null {
  if (details.blockers.humanBlockedReason) return `Blocked: ${details.blockers.humanBlockedReason}`;
  if (details.blockers.openCount <= 0) return null;
  const blockerIds = details.blockers.open
    .map((blocker) => firstNonEmpty(blocker.identifier, blocker.id))
    .filter((value): value is string => value !== null);
  if (blockerIds.length === 0) return null;
  return `Blocked by ${blockerIds.join(", ")}`;
}

function addUniqueText(target: string[], value: string | null | undefined): void {
  const normalized = firstNonEmpty(value);
  if (!normalized || target.includes(normalized)) return;
  target.push(normalized);
}

function projectIssueActivity(
  details: IssueDetailsEnvelope,
  card: IssueBoardCardProjectionInput | null,
  operatorLiveness: WebOperatorLivenessInput | null,
): NonNullable<IssueModel["activity"]> {
  const issue = details.issue;
  const actor = firstNonEmpty(operatorLiveness?.agentId, card?.live?.agentId, issue.delegateId, issue.assigneeId, details.source) ?? "";
  const activity: NonNullable<IssueModel["activity"]> = [];
  appendIssueActivity(activity, issue.createdAt, "created", firstNonEmpty(issue.state, issue.identifier, issue.id) ?? "", details.source);
  if (issue.updatedAt !== issue.createdAt) {
    appendIssueActivity(activity, issue.updatedAt, "updated", firstNonEmpty(issue.state, issue.identifier, issue.id) ?? "", actor);
  }
  appendIssueActivity(
    activity,
    details.pullRequest.lastPushedAt,
    "pr pushed",
    formatPullRequest(details.pullRequest, card?.metadata ?? null) ?? firstNonEmpty(details.pullRequest.branch, card?.metadata?.prBranch) ?? "",
    "github",
  );
  appendIssueActivity(
    activity,
    details.latestRun.completedAt,
    "run " + (details.latestRun.status ?? "completed"),
    details.latestRun.runId ?? "",
    actor,
  );
  return activity;
}

function appendIssueActivity(
  target: NonNullable<IssueModel["activity"]>,
  at: string | null | undefined,
  verb: string,
  value: string,
  who: string,
): void {
  const t = firstNonEmpty(at);
  if (!t) return;
  target.push({ t, verb, val: value, who });
}

function formatPullRequest(pullRequest: IssuePullRequestSummary, metadata?: IssueBoardCardMetadataInput | null): string | null {
  if (pullRequest.number !== null) return "#" + String(pullRequest.number);
  if (pullRequest.url !== null) return pullRequest.url;
  if (metadata?.prNumber !== null && metadata?.prNumber !== undefined) return "#" + String(metadata.prNumber);
  return metadata?.prUrl ?? null;
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

function activityDisplayId(item: ActivityItemProjectionInput): string {
  return firstNonEmpty(item.issue?.identifier, item.issue?.id, item.run?.runId, item.id) ?? "";
}

function activityExtra(item: ActivityItemProjectionInput): string {
  return firstNonEmpty(item.transcript?.message, item.writeback?.status, item.run?.status, item.source) ?? "";
}

function activityVerb(item: ActivityItemProjectionInput): string {
  if (item.kind === "transcript_event") return item.transcript?.eventType ?? item.kind;
  if (item.kind === "writeback_operation") return item.writeback?.operationKind ?? item.kind;
  return item.kind;
}

function isTranscriptPage(value: TranscriptPage | TranscriptEvent[] | null | undefined): value is TranscriptPage {
  return Boolean(value && !Array.isArray(value) && Array.isArray(value.events));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

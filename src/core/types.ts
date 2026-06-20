export interface IssueBlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface IssueAssigneeRef {
  id: string | null;
}

export interface IssueLinearProjectIdentity {
  kind: "linear";
  slug: string;
  id?: string | null;
}

export interface IssueProjectContextMetadata {
  projectContextId: string;
  projectContextLabel: string;
  linearProjectSlug: string | null;
  routingSource: string;
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
  delegateId: string | null;
  assignedToWorker: boolean;
  labels: string[];
  blockedBy: IssueBlockerRef[];
  createdAt: string | null;
  updatedAt: string | null;
  projectContext?: IssueProjectContextMetadata;
  projectContextId?: string;
  projectContextLabel?: string;
  linearProjectSlug?: string | null;
  linearProjectIdentity?: IssueLinearProjectIdentity;
  routingSource?: string;
}

export interface IssueStatusView {
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
  blockedBy: IssueBlockerRef[];
  createdAt: string | null;
  updatedAt: string | null;
  projectContext?: IssueProjectContextMetadata;
  projectContextId?: string;
  projectContextLabel?: string;
  linearProjectSlug?: string | null;
  linearProjectIdentity?: IssueLinearProjectIdentity;
  routingSource?: string;
}

export type IssueDetailsSource = "live" | "durable" | "tracker";
export type IssueDetailsCompleteness = "full" | "partial";
export type IssueStateClassification = "active" | "handoff" | "terminal" | "blocked" | "unknown";
export type RunTerminalReason = "succeeded" | "failed" | "timed_out" | "stalled" | "cancelled";
export type IssueBoardColumnId = "backlog" | "todo" | "progress" | "review" | "done" | "canceled";
export type IssueBoardColumnMapping = Record<IssueBoardColumnId, string[]>;

export interface TrackerStateLists {
  activeStates: readonly string[];
  handoffStates: readonly string[];
  reviewStates: readonly string[];
  blockedStates: readonly string[];
  terminalStates: readonly string[];
}

export interface IssueTrackerMetadata {
  generatedAt: string | null;
  updatedAt: string | null;
  ageMs: number | null;
  stale: boolean | null;
  staleThresholdMs: number;
  state: string | null;
  classification: IssueStateClassification | null;
}

export interface IssueBlockerSummary {
  available: boolean;
  totalCount: number;
  openCount: number;
  open: IssueBlockerRef[];
  blocked: boolean;
  humanBlockedReason: string | null;
}

export interface IssueWorkspaceSummary {
  workspaceKey: string | null;
  path: string | null;
  sourceKind: string | null;
  branchName: string | null;
  gitBranchName: string | null;
  repoPath: string | null;
  baseRef: string | null;
}

export type IssueRouteEvidenceKind = "issue_breakdown" | "issue_breakdown_apply" | "open_workspace";
export type IssueRouteEvidenceStatus = "resolved" | "ambiguous" | "wrong_context" | "missing" | "credential_unavailable";
export type IssueRouteEvidenceSource =
  | "alias_live"
  | "alias_workspace"
  | "alias_run"
  | "alias_lifecycle"
  | "tracker_direct"
  | "tracker_candidate"
  | "workspace_live"
  | "workspace_record"
  | "workspace_run"
  | "workspace_lifecycle"
  | "workspace_filesystem_fallback";

export interface IssueRouteEvidenceBase {
  requestKey: string;
  requestAlias: string;
  requestedProjectContextId: string | null;
  resolvedProjectContextId: string | null;
  lookupKey: string | null;
  sources: IssueRouteEvidenceSource[];
}

export interface IssueRouteEvidence extends IssueRouteEvidenceBase {
  kind: IssueRouteEvidenceKind;
  status: IssueRouteEvidenceStatus;
  reason: string | null;
  redacted: true;
}

export interface IssuePullRequestSummary {
  url: string | null;
  number: number | null;
  headSha: string | null;
  branch: string | null;
  ciStatus: string | null;
  lastPushedAt: string | null;
}

export type IssueMergeGateViewStatus = "observing" | "repair_dispatched" | "blocked" | "resolved" | "superseded";
export type IssueMergeGateViewCheckOutcome =
  | "passing"
  | "pending"
  | "missing_observed"
  | "missing_actionable"
  | "failing"
  | "unknown";

export interface IssueMergeGateCheckSummary {
  name: string;
  outcome: IssueMergeGateViewCheckOutcome;
  rawStatus: string;
  conclusion: string | null;
  url: string | null;
  firstObservedAt: string | null;
  actionableSince: string | null;
}

export type IssueMergeGateMergeabilityViewStatus = "mergeable" | "conflicted" | "unknown" | "blocked";

export interface IssueMergeGateMergeabilitySummary {
  status: IssueMergeGateMergeabilityViewStatus;
  pullRequest: IssuePullRequestSummary;
  mergeable: boolean | null;
  mergeableState: string | null;
  reason: string | null;
  baseBranch: string | null;
  baseHeadSha: string | null;
  checkedAt: string;
}

export interface IssueMergeGateSummary {
  active: boolean;
  id: string | null;
  status: IssueMergeGateViewStatus | null;
  headSha: string | null;
  pullRequest: IssuePullRequestSummary;
  repairRound: number | null;
  gateRunId: string | null;
  gateReportId: string | null;
  repairRunId: string | null;
  repairReportId: string | null;
  checks: IssueMergeGateCheckSummary[];
  mergeability: IssueMergeGateMergeabilitySummary | null;
  actionableCheckNames: string[];
  observingCheckNames: string[];
  blockerFingerprint: string | null;
  supersededByHeadSha: string | null;
  awaitingCi: boolean;
  automationBlocked: boolean;
  updatedAt: string | null;
}

export interface IssueLatestRunSummary {
  runId: string | null;
  runPhase: AgentRunPhase | null;
  runKind: AgentRunKind | null;
  status: "running" | "succeeded" | "failed" | "cancelled" | null;
  terminalReason: RunTerminalReason | null;
  error: string | null;
  completedAt: string | null;
}

export interface IssueDetailsEnvelope {
  source: IssueDetailsSource;
  completeness: IssueDetailsCompleteness;
  issue: IssueStatusView;
  tracker: IssueTrackerMetadata;
  blockers: IssueBlockerSummary;
  workspace: IssueWorkspaceSummary;
  pullRequest: IssuePullRequestSummary;
  mergeGate?: IssueMergeGateSummary | null;
  latestRun: IssueLatestRunSummary;
}

function projectContextIdForIssueStatusView(issue: Issue): string | undefined {
  return issue.projectContextId ?? issue.projectContext?.projectContextId;
}

function projectContextLabelForIssueStatusView(issue: Issue): string | undefined {
  return issue.projectContextLabel ?? issue.projectContext?.projectContextLabel;
}

function linearProjectSlugForIssueStatusView(issue: Issue): string | null | undefined {
  return issue.linearProjectSlug ?? issue.projectContext?.linearProjectSlug;
}

function routingSourceForIssueStatusView(issue: Issue): string | undefined {
  return issue.routingSource ?? issue.projectContext?.routingSource;
}

function linearProjectIdentityForIssueStatusView(issue: Issue): IssueLinearProjectIdentity | undefined {
  if (issue.linearProjectIdentity) {
    return { ...issue.linearProjectIdentity };
  }

  const slug = issue.projectContext?.linearProjectSlug;
  return slug === undefined || slug === null ? undefined : { kind: "linear", slug };
}

export function toIssueStatusView(issue: Issue): IssueStatusView {
  const projectContextId = projectContextIdForIssueStatusView(issue);
  const projectContextLabel = projectContextLabelForIssueStatusView(issue);
  const linearProjectSlug = linearProjectSlugForIssueStatusView(issue);
  const linearProjectIdentity = linearProjectIdentityForIssueStatusView(issue);
  const routingSource = routingSourceForIssueStatusView(issue);

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    state: issue.state,
    branchName: issue.branchName,
    url: issue.url,
    assigneeId: issue.assigneeId,
    delegateId: issue.delegateId,
    labels: [...issue.labels],
    blockedBy: issue.blockedBy.map((blocker) => ({ ...blocker })),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    ...(issue.projectContext === undefined ? {} : { projectContext: { ...issue.projectContext } }),
    ...(projectContextId === undefined ? {} : { projectContextId }),
    ...(projectContextLabel === undefined ? {} : { projectContextLabel }),
    ...(linearProjectSlug === undefined ? {} : { linearProjectSlug }),
    ...(linearProjectIdentity === undefined ? {} : { linearProjectIdentity }),
    ...(routingSource === undefined ? {} : { routingSource }),
  };
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
export type AgentRunPhase = "issue_breakdown" | "implementation" | "merge_conflict_resolution" | "review";
export type AgentRunKind = "planning" | "implementation" | "review";

export function runKindForPhase(runPhase: AgentRunPhase): AgentRunKind {
  switch (runPhase) {
    case "issue_breakdown":
      return "planning";
    case "review":
      return "review";
    case "merge_conflict_resolution":
    case "implementation":
      return "implementation";
  }
}

export type RunAttempt = number | null;

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface RuntimeTotals extends TokenCounts {
  secondsRunning: number;
}


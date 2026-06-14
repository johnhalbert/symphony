# Symphony State Representation

This document is a code-inspected map of the state Symphony needs in order to run. It separates authoritative state from projections, describes every durable file family Symphony writes, and gives TypeScript-shaped structures for each state source.

For the database/external-system/memory/disk placement decision, see `docs/state-ownership-and-durability.md`.

Scope note: `hermes/upstream-src` is vendored runtime code. Symphony treats most upstream Hermes state as opaque. This document includes the Hermes state Symphony directly configures, materializes, reads, or relies on.

## Source Index

- Workflow and config: `WORKFLOW.md`, `src/core/workflow/WorkflowLoader.ts`, `src/core/config/Config.ts`, `src/core/config/CredentialProfiles.ts`
- Canonical domain types: `src/core/types.ts`
- Orchestration state: `src/core/orchestrator/Orchestrator.ts`, `src/core/harness/AgentHarness.ts`
- Durable state stores: `src/core/persistence/RunTranscriptStore.ts`, `src/core/persistence/IssueLifecycleStore.ts`, `src/core/writeback/WritebackOutbox.ts`, `src/core/approval/OperatorApprovalService.ts`, `src/core/persistence/ProviderGateStore.ts`, `src/core/persistence/McpExposureDiagnosticsStore.ts`
- Runtime harnesses: `cursor/src/CursorHarness.ts`, `cursor/src/CursorEventMapper.ts`, `hermes/src/HermesHarness.ts`, `hermes/src/HermesProfileManager.ts`, `hermes/src/HermesAuthManager.ts`, `hermes/src/HermesMcpConfig.ts`, `hermes/src/GatewayFacade.ts`
- Workspaces and git: `src/core/workspace/WorkspaceManager.ts`, `src/core/workspace/GitWorktreeManager.ts`
- External systems: `src/integrations/linear/LinearTrackerClient.ts`, `src/core/tracker/TrackerClient.ts`, `src/core/tracker/TrackerWriter.ts`, `src/integrations/github/GitHubPullRequestClient.ts`, `src/integrations/github/GitHubCredentialResolver.ts`, `src/integrations/github/GitHubAppInstallationTokenProvider.ts`
- MCP handoff: `src/core/harness/HandoffMcp.ts`, `src/core/harness/*McpServer.ts`, `src/core/harness/McpSubprocessEnvironment.ts`, `src/core/harness/McpToolExposureProbe.ts`
- Web/API projections: `src/app/http.ts`, `src/app/webProjection.ts`, `src/app/WebHistoryProjection.ts`, `src/app/WebTranscriptProjection.ts`, `web/src/types/symphony.ts`, `web/src/data/*`
- Cursor extension projections: `extension/src/settings.ts`, `extension/src/connectionState.ts`, `extension/src/dashboardTypes.ts`, `extension/src/statusApiTypes.ts`, `extension/src/webviewModel.ts`, `extension/src/webviewMessages.ts`, `extension/src/webviewProvider.ts`

## State Layers

1. Configuration state tells Symphony what tracker, workspaces, runtime, credentials, writeback, review loop, merge policy, and server to use.
2. External authority state comes from Linear, GitHub, git remotes, Cursor SDK, and Hermes.
3. Local durable state lives under `ServiceConfig.workspace.stateDir` and is the recovery source for workspaces, runs, transcripts, lifecycle, writeback, approvals, provider gates, diagnostics, and MCP context.
4. Local workspace state lives under `ServiceConfig.workspace.root` plus git bare repo caches and branch locks under `stateDir`.
5. In-memory runtime state lives in the orchestrator, harnesses, stores, token providers, HTTP server, and extension panel.
6. Projection state is derived for HTTP, React web UI, and the VS Code/Cursor extension. It is useful to clients but is not the source of truth.

## Common Aliases

```ts
type IsoDateTime = string;
type FilePath = string;
type UrlString = string;
type IssueId = string;
type IssueIdentifier = string;
type RunId = string;
type WorkspaceKey = string;
type Sha = string;
type JsonObject = Record<string, unknown>;
```

## Configuration State

### Workflow File And Environment

Source: `WORKFLOW.md` plus `.env` next to the workflow file. `WorkflowLoader` parses front matter into raw config and body into the worker prompt template. Values may resolve environment variables with `$ENV_NAME`; parent process environment wins over `.env`.

```ts
interface WorkflowDefinition {
  workflowPath: FilePath;
  config: RawWorkflowConfig;
  promptTemplate: string;
}

interface LoadedWorkflow {
  definition: WorkflowDefinition;
  serviceConfig: ServiceConfig;
}

interface WorkflowReloadEvent {
  loaded: LoadedWorkflow | null;
  error: SymphonyError | null;
}

type DotEnv = Record<string, string>;
```

### Normalized Service Config

Source: `src/core/config/Config.ts`. This is the central configuration object passed through the runtime.

```ts
interface ServiceConfig {
  workflowPath: FilePath;
  workflowDir: FilePath;
  tracker: TrackerConfig;
  polling: { intervalMs: number };
  workspace: WorkspaceConfig;
  hooks: HookConfig;
  agent: AgentConfig;
  cursor: CursorConfig;
  hermes: HermesConfig;
  server: ServerConfig;
  writeback: WritebackConfig;
  github: GitHubConfig;
  credentialProfiles: CredentialProfileRegistry;
  reviewLoop: ReviewLoopConfig;
  mergePolicy: MergePolicyConfig;
  issueBoard: IssueBoardConfig;
  continuationContext: ContinuationContextConfig;
  issueBreakdown: IssueBreakdownConfig;
  raw: RawWorkflowConfig;
}

interface TrackerConfig {
  kind: "linear";
  endpoint: string;
  apiKey: string;
  projectSlug: string;
  assignee: string | null;
  activeStates: string[];
  handoffStates: string[];
  terminalStates: string[];
}

interface WorkspaceConfig {
  root: FilePath;
  stateDir: FilePath;
  source: WorkspaceSourceConfig;
}

interface WorkspaceSourceConfig {
  kind: "none" | "copy" | "git" | "git_worktree";
  path?: FilePath;
  repository?: string;
  ref?: string;
  baseRef?: string;
  branchTemplate?: string;
  cachePath?: FilePath;
  cleanup?: "refuse_dirty" | "force";
}

interface HookConfig {
  afterCreate: string | null;
  beforeRun: string | null;
  afterRun: string | null;
  beforeRemove: string | null;
  timeoutMs: number;
}

interface AgentConfig {
  harness: string;
  maxConcurrentAgents: number;
  maxTurns: number;
  maxRetryBackoffMs: number;
  maxSdkErrorRetries: number;
  maxConcurrentAgentsByState: Map<string, number>;
  requireLabels: string[];
  excludeLabels: string[];
  protectedPaths: string[];
}

interface CursorConfig {
  model: string;
  mode: "agent" | "plan" | null;
  modelParams: Array<{ id: string; value: string }>;
  settingSources: Array<"project" | "user" | "team" | "mdm" | "plugins" | "all">;
  openerCommand: string | null;
  allowLargeContext: boolean;
  workerAgentLifecycle: "fresh_per_run" | "resume_by_issue";
}

interface HermesConfig {
  upstreamRoot: FilePath;
  python: string | null;
  templatesDir: FilePath;
  stateDir: FilePath;
  auth: HermesAuthConfig;
  runtimeCredentialEnv: string;
  model: string | null;
  provider: string | null;
  workerSessionLifecycle: "fresh_per_run" | "reuse_by_issue";
  keepProfiles: "always" | "failed" | "never";
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  shutdownGraceMs: number;
  roleTemplates: {
    worker: string;
    reviewer: string;
    planner: string;
    mergeConflictResolution: string;
  };
}

interface HermesAuthConfig {
  mode: "managed_root";
  managedRoot: FilePath;
  bootstrapFrom: FilePath;
  providers: string[];
}

interface ServerConfig {
  port: number | null;
  host: string;
  openWorkspaceToken: string | null;
  webAssetsRoot: FilePath | null;
}

interface WritebackConfig {
  enabled: boolean;
  mode: "live" | "dry_run";
  dispatchState: string;
  maxBackoffMs: number;
}

interface GitHubConfig {
  owner: string | null;
  repo: string | null;
  token: string | null;
  app: GitHubAppConfig | null;
  headOwner: string | null;
  apiBaseUrl: string;
  publishPullRequests: boolean;
  operatorApproval?: {
    requiredForPublication: boolean;
    rejectPolicy: "cancel" | "fail";
    pollIntervalMs: number;
    timeoutMs: number | null;
  };
  prHandoff: {
    enabled: boolean;
    targetState: string | null;
    allowDrafts: boolean;
    requiredChecks: string[];
    noCiAllowed: boolean;
    noCiEvidence: string | null;
  };
}

interface GitHubAppConfig {
  appId: string | null;
  clientId: string | null;
  installationId: string | null;
  privateKey: string | null;
  privateKeyEnvVar: string | null;
  privateKeyPath: FilePath | null;
  tokenRefreshBufferSeconds: number;
}

interface ReviewLoopConfig {
  reviewStates: string[];
  blockedStates: string[];
  reviewPassState: string | null;
  reviewerPromptTemplate: string | null;
  reviewerPromptExtensions: string[];
  workerPromptExtensions: string[];
  maxReviewRounds: number;
  maxIncompleteTurns: number;
  continuationHistoryThreshold: number;
  transcriptHistoryLimit: number;
  prReviewEvidenceLimit: number;
}

interface MergePolicyConfig {
  mode: "disabled" | "manual" | "gated";
  sourceStates: string[];
  conflictsState: string | null;
  maxConflictFixTurns: number;
  doneState: string;
  mergeMethod: "merge" | "squash" | "rebase";
  requiredChecks: string[];
  missingCheckStabilizationMs: number;
  noCiAllowed: boolean;
  noCiEvidence: string | null;
}

interface ContinuationContextConfig {
  searchEnabled: boolean;
  summarizationEnabled: boolean;
}

interface IssueBreakdownConfig {
  enabled: boolean;
  cursorMode: "agent" | "plan";
  promptTemplate: string;
  planningLabels: string[];
  applyToLinear: { enabled: boolean; mode: "child_issues" };
  workspaceMode: "none" | "readonly_checkout";
  maxPlanningFailures: number;
  maxPlanningDispatchRetries: number;
  planningRetryBaseMs: number;
  planningRetryMaxMs: number;
}

interface IssueBoardConfig {
  columns: Record<"backlog" | "todo" | "progress" | "review" | "done" | "canceled", string[]>;
}
```

Key relationships:

- `tracker.*States`, `reviewLoop.*States`, `mergePolicy.sourceStates`, `mergePolicy.doneState`, and `issueBoard.columns` define how tracker states become dispatch queues, review queues, blocked states, terminal rows, and board lanes.
- `workspace.stateDir` owns durable Symphony state; `workspace.root` owns actual agent workspaces.
- `agent.harness` selects `CursorHarness` or `HermesHarness`.
- `cursor` and `hermes` config are both persisted into `RunRecord` so a run can be understood after reload.
- `github.operatorApproval` gates service-owned push and PR publication.

### Credential Profiles

Source: `src/core/config/CredentialProfiles.ts`, with env-backed static tokens and GitHub App definitions.

```ts
type CredentialCapability =
  | "github.discovery"
  | "github.publication"
  | "github.review_evidence_read"
  | "github.review_feedback_write"
  | "github.merge"
  | "linear.tracker"
  | "linear.writeback"
  | "runtime.cursor"
  | "runtime.hermes"
  | "cursor.runtime"
  | "server.open_workspace";

type CredentialRole = "worker" | "reviewer" | "service";

interface CredentialLegacyFallbacks {
  githubToken: string | null;
  linearApiKey: string | null;
  cursorRuntimeApiKey: string | null;
  openWorkspaceToken: string | null;
}

interface StaticTokenCredentialProfileDefinition {
  kind: "static_token";
  name: string;
  envVar: string;
  capabilities: CredentialCapability[];
}

interface GitHubAppCredentialProfileDefinition {
  kind: "github_app";
  name: string;
  app: CredentialProfileGitHubAppConfig;
  capabilities: CredentialCapability[];
}

type CredentialProfileDefinition =
  | StaticTokenCredentialProfileDefinition
  | GitHubAppCredentialProfileDefinition;

interface ResolvedCredential {
  kind: "static_token" | "github_app";
  role: CredentialRole;
  capability: CredentialCapability;
  value: string;
  app: CredentialProfileGitHubAppConfig | null;
  source: "profile" | "legacy";
  profileName: string | null;
}
```

Credential ownership:

- Worker owns `github.discovery`, `linear.tracker`, `runtime.cursor`, and `server.open_workspace`.
- Reviewer owns `github.review_evidence_read`, `github.review_feedback_write`, and reviewer `runtime.cursor`.
- Service owns `github.publication`, `github.merge`, and `linear.writeback`.
- Linear writeback is service-owned in the resolver even though default capability lists also expose it where needed for compatibility.

## Canonical Domain State

Source: `src/core/types.ts`.

```ts
interface IssueBlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

interface Issue {
  id: IssueId;
  identifier: IssueIdentifier;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branchName: string | null;
  url: UrlString | null;
  assigneeId: string | null;
  delegateId: string | null;
  assignedToWorker: boolean;
  labels: string[];
  blockedBy: IssueBlockerRef[];
  createdAt: IsoDateTime | null;
  updatedAt: IsoDateTime | null;
}

interface IssueStatusView {
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
}

type IssueDetailsSource = "live" | "durable" | "tracker";
type IssueDetailsCompleteness = "full" | "partial";
type IssueStateClassification = "active" | "handoff" | "terminal" | "blocked" | "unknown";
type RunTerminalReason = "succeeded" | "failed" | "timed_out" | "stalled" | "cancelled";

interface IssueTrackerMetadata {
  generatedAt: string | null;
  updatedAt: string | null;
  ageMs: number | null;
  stale: boolean | null;
  staleThresholdMs: number;
  state: string | null;
  classification: IssueStateClassification | null;
}

interface IssueBlockerSummary {
  available: boolean;
  totalCount: number;
  openCount: number;
  open: IssueBlockerRef[];
  blocked: boolean;
  humanBlockedReason: string | null;
}

interface IssueWorkspaceSummary {
  workspaceKey: string | null;
  path: string | null;
  sourceKind: string | null;
  branchName: string | null;
  gitBranchName: string | null;
  repoPath: string | null;
  baseRef: string | null;
}

interface IssuePullRequestSummary {
  url: string | null;
  number: number | null;
  headSha: string | null;
  branch: string | null;
  ciStatus: string | null;
  lastPushedAt: string | null;
}

interface IssueLatestRunSummary {
  runId: string | null;
  runPhase: AgentRunPhase | null;
  runKind: AgentRunKind | null;
  status: "running" | "succeeded" | "failed" | "cancelled" | null;
  terminalReason: RunTerminalReason | null;
  error: string | null;
  completedAt: string | null;
}

interface IssueDetailsEnvelope {
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

interface Workspace {
  path: FilePath;
  workspaceKey: WorkspaceKey;
  createdNow: boolean;
  issueId?: IssueId;
  issueIdentifier?: IssueIdentifier;
  sourceKind?: string;
  gitBranchName?: string;
  repoPath?: FilePath;
  baseRef?: string;
}

type AgentRunRole = "worker" | "reviewer";
type AgentRunPhase = "issue_breakdown" | "implementation" | "merge_conflict_resolution" | "review";
type AgentRunKind = "planning" | "implementation" | "review";

interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

interface RuntimeTotals extends TokenCounts {
  secondsRunning: number;
}
```

`Issue` is the canonical normalized tracker object. Most other state records carry `issueId` and `issueIdentifier` back to it.

## External Authority State

### Linear Tracker State

Source: `src/integrations/linear/LinearTrackerClient.ts`, normalized through `TrackerClient`.

```ts
interface TrackerClient {
  fetchCandidateIssues(): Promise<Issue[]>;
  fetchIssuesByStates(stateNames: string[]): Promise<Issue[]>;
  fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]>;
}

interface LinearIssueNode {
  id?: unknown;
  identifier?: unknown;
  title?: unknown;
  description?: unknown;
  priority?: unknown;
  branchName?: unknown;
  url?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  state?: { name?: unknown } | null;
  assignee?: { id?: unknown } | null;
  delegate?: { id?: unknown } | null;
  labels?: { nodes?: Array<{ name?: unknown }> } | null;
  inverseRelations?: { nodes?: LinearRelationNode[] } | null;
}

interface LinearRelationNode {
  type?: unknown;
  issue?: { id?: unknown; identifier?: unknown; state?: { name?: unknown } | null } | null;
}

interface LinearWorkflowTeamStates {
  teamId: string;
  teamKey: string;
  teamName: string | null;
  states: string[];
}
```

Linear relationship rules:

- `LinearIssueNode` becomes `Issue`.
- Labels are lowercased in the normalized `Issue.labels`.
- Inverse Linear relations of type `blocks` become `Issue.blockedBy`.
- `tracker.assignee` and Linear `assignee` or `delegate` decide `Issue.assignedToWorker`.
- Linear workflow state names must cover configured active, review, blocked, pass, merge, and terminal states for live operation.

### Linear Writeback State

Source: `src/core/tracker/TrackerWriter.ts`, implemented by `LinearTrackerClient`.

```ts
interface TrackerTransitionInput {
  issueId: IssueId;
  toState: string;
  fromStates?: string[];
  reason?: string;
}

interface TrackerCommentInput {
  issueId: IssueId;
  body: string;
  dedupeKey: string;
}

interface TrackerIssueCreateInput {
  parentIssueId: IssueId;
  planId?: string;
  proposedIssueIndex?: number;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  requestedLabels: string[];
  dependencies: string[];
  dedupeKey: string;
  payloadHash: string;
}

interface TrackerIssueRelationInput {
  sourceIssueId: IssueId;
  targetIssueId: IssueId;
  type: "blocks";
  dedupeKey: string;
  planId?: string;
  dependency: string;
}

interface TrackerWriteEvidence {
  kind: "issue_create";
  issue: { id: string; identifier: string | null; url: string | null } | null;
  issueCreateStatus: "created" | "verified" | "conflict" | "dry_run";
  parentIssueId: IssueId;
  dedupeKey: string;
  payloadHash: string;
  unresolvedLabelNames: string[];
  message?: string;
}

interface TrackerWriteResult {
  status: "applied" | "verified" | "skipped" | "dry_run";
  message?: string;
  evidence?: TrackerWriteEvidence;
}
```

Writeback operations are locally persisted first in the writeback outbox and then applied to Linear. Linear comments and issue-breakdown children use embedded HTML markers for idempotency.

### GitHub Pull Request State

Source: `src/integrations/github/GitHubPullRequestClient.ts`.

```ts
interface PullRequestMetadata {
  url: UrlString;
  number: number;
  headBranch: string;
  headSha: Sha | null;
  lastPushedAt: IsoDateTime | null;
  draft?: boolean;
}

interface PullRequestDetails extends PullRequestMetadata {
  state: string | null;
  merged: boolean | null;
  mergeCommitSha: Sha | null;
  mergedAt: IsoDateTime | null;
  mergedBy: string | null;
  mergeable: boolean | null;
  mergeableState: string | null;
  baseBranch: string;
  baseHeadSha: Sha;
}

interface PullRequestCheckResult {
  name: string;
  status: "success" | "failure" | "pending" | "missing" | "unknown";
  conclusion: string | null;
  url: UrlString | null;
}

interface PullRequestPublicationInput {
  workspacePath: FilePath;
  branchName: string;
  baseBranch: string;
  title: string;
  body: string;
  evidenceCursor: string;
}

interface PullRequestPublicationResult extends PullRequestMetadata {
  headSha: Sha;
  action: "reused" | "created";
  evidenceCursor: string;
}

interface GitHubPullRequestReviewEvidence {
  source: "review" | "review_comment" | "issue_comment";
  githubId: string;
  pullRequestNumber: number;
  pullRequestUrl: UrlString | null;
  url: UrlString | null;
  reviewer: string | null;
  body: string;
  state: string | null;
  path: string | null;
  line: number | null;
  originalLine: number | null;
  side: string | null;
  threadId: string | null;
  inReplyToId: string | null;
  isResolved: boolean | null;
  isOutdated: boolean | null;
  createdAt: IsoDateTime | null;
  updatedAt: IsoDateTime | null;
  submittedAt: IsoDateTime | null;
}

interface PullRequestMergeInput {
  pullRequestNumber: number;
  expectedHeadSha: Sha;
  method: "merge" | "squash" | "rebase";
}

interface PullRequestMergeResult {
  merged: boolean;
  mergeCommitSha: Sha;
  mergedAt: IsoDateTime;
  mergedBy: string | null;
}
```

GitHub relationships:

- Pull request data is denormalized into `RunRecord`, `IssueLifecycleSummaryPointers`, completion reports, review evidence, merge gates, merge conflict metadata, and final merge metadata.
- Service credentials publish PRs and merge PRs.
- Reviewer credentials read PR evidence and write review feedback.
- Worker credentials discover existing PRs by branch.

### GitHub App Token Cache

Source: `src/integrations/github/GitHubAppInstallationTokenProvider.ts`. This is in-memory only.

```ts
interface CachedInstallationToken {
  token: string;
  expiresAtMs: number;
}

class GitHubAppInstallationTokenProvider {
  cached: CachedInstallationToken | null;
  pending: Promise<CachedInstallationToken> | null;
}
```

The private key source can be inline config, `privateKeyEnvVar`, or `privateKeyPath`. Installation tokens are not written to disk by Symphony.

### Git And Worktree State

Source: `src/core/workspace/GitWorktreeManager.ts`.

```ts
interface WorktreeResult {
  repoPath: FilePath;
  branchName: string;
  baseRef: string;
}

interface PlanningCheckoutResult {
  repoPath: FilePath;
  baseRef: string;
}
```

For `workspace.source.kind: "git_worktree"`, Symphony maintains:

- A bare shared repo at `workspace.source.cachePath` or `<stateDir>/repos/<repository-sha>`.
- Per-branch lock files at `<stateDir>/locks/<repo-branch-sha>.lock` containing process id and timestamp.
- A git worktree under `workspace.root/<workspaceKey>`.
- `WorkspaceRecord.repoPath`, `baseRef`, and `gitBranchName` to reconnect durable state to git state.

## Durable State Directory

All paths here are relative to `ServiceConfig.workspace.stateDir`.

```text
workspaces/<workspaceKey>.json
runs/<runId>/meta.json
runs/<runId>/events.jsonl
issue-lifecycle/<issueId>.json
writeback/<safeIdempotencyKey>.json
approval-requests/<requestId>.json
provider-gates/<gateId>.json
diagnostics/mcp-tool-exposure/latest.json
completion-report-mcp/<issueId>-<turn>.json
merge-conflict-resolution-mcp/<issueId>-<turn>.json
issue-breakdown-plan-mcp/<issueId>-<turn>.json
review-verdict-mcp/<issueId>-<turn>.json
review-feedback-mcp/<issueId>-<turn>.json
transcript-recall-mcp/<issueId>-<role>-<turn>.json
repos/<repository-sha>
locks/<repo-branch-sha>.lock
```

### Project Context Attribution

Source: `src/core/config/ProjectContexts.ts`, `src/core/persistence/RunTranscriptStore.ts`, `src/core/persistence/IssueLifecycleStore.ts`, `src/core/writeback/WritebackOutbox.ts`, `src/core/approval/OperatorApprovalService.ts`.

```ts
interface ProjectContextResolution {
  projectContextId: string;
  projectContextLabel: string;
  linearProjectSlug: string | null;
  routingSource: string;
}
```

Common `routingSource` values:

- `candidate_poll`: current tracker polling/config matched the issue to an enabled project context.
- `replay` / `state_refresh`: durable state already carried explicit routing metadata, so reload/replay preserved that attribution even if current config drift later disables or removes the context.
- `legacy_default`: compatibility fallback for historical single-project records or workflows that still omit `project_contexts` and rely on the synthesized default context.

Compatibility contract:

- File-backed `WorkspaceRecord`, `RunRecord`, `IssueLifecycleRecord`, writeback operations, operator approval requests, handoff memo packets, and related status/API projections normalize a missing `projectContext` field to `{ projectContextId: "default", projectContextLabel: "Default", linearProjectSlug: null, routingSource: "legacy_default" }` on read.
- That normalization is a read-time compatibility repair. Legacy files are not rewritten just because the default context was synthesized.
- Durable transcript/history rebuilds and Postgres read paths scope lookups by `projectContextId`; historical runs without explicit attribution must still read through the synthesized `default` context rather than treating bare run/session ids as globally unique.

### Workspace Records

Source: `FileRunTranscriptStore` and `WorkspaceManager`.

```ts
interface WorkspaceRecord {
  workspaceKey: WorkspaceKey;
  issueId: IssueId | null;
  issueIdentifier: IssueIdentifier;
  projectContext?: ProjectContextResolution;
  path: FilePath;
  sourceKind: string;
  repoPath?: FilePath;
  baseRef?: string;
  gitBranchName?: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

interface WorkspaceMetadata extends WorkspaceRecord {}
```

Workspace records are keyed by sanitized issue identifier. Planning workspaces use `<identifier>-planning`.

`WorkspaceRecord.projectContext` preserves which workflow/codebase context owns the durable workspace. Legacy workspace files that predate explicit attribution read back as the synthesized legacy/default context.

Workspace marker files:

```ts
interface PlanningWorkspaceMarker {
  issueId: IssueId | null;
  issueIdentifier: IssueIdentifier;
  mode: "none" | "readonly_checkout";
  createdAt: IsoDateTime;
}
```

`mode: "none"` writes `.symphony-planning.json`; `mode: "readonly_checkout"` writes `.symphony-planning-readonly.json` and tries to chmod the checkout read-only.

### Run Records And Transcript Events

Source: `src/core/persistence/RunTranscriptStore.ts`.

```ts
type RunStatus = "running" | "succeeded" | "failed" | "cancelled";
type PersistedRunCancellationSource = "operator" | "state_change" | "stalled" | "service_stop";
type PersistedCancelFailedSource = "harness_stop" | "cancel_ignored";
type PersistedCancellationOutcome = "none" | "requested" | "cancelled" | "harness_stop_failed" | "cancel_ignored";
type PersistedSdkRunStatus = "running" | "finished" | "error" | "cancelled";
type PersistedSdkRunStatusSource = "initial" | "onDidChangeStatus" | "wait";

interface RunActivitySnapshot {
  lastHarnessActivityAt: IsoDateTime | null;
  lastStreamActivityAt: IsoDateTime | null;
  lastDeltaOrToolActivityAt: IsoDateTime | null;
  lastToolActivityAt: IsoDateTime | null;
}

interface RunRecord {
  runId: RunId;
  sessionId: string | null;
  agentId: string | null;
  role: AgentRunRole;
  runPhase?: AgentRunPhase;
  runKind?: AgentRunKind;
  issueId: IssueId;
  issueIdentifier: IssueIdentifier;
  projectContext?: ProjectContextResolution;
  attempt: number | null;
  turnNumber: number;
  prompt: string;
  promptCharCount?: number;
  harnessId?: string;
  runtimeModel?: string | null;
  runtimeModelParams?: Array<{ id: string; value: string }>;
  runtimeSettingSources?: string[];
  runtimeMode?: string | null;
  runtimeAllowLargeContext?: boolean;
  runtimeAgentLifecycle?: string;
  cursorModel?: string | null;
  cursorModelParams?: Array<{ id: string; value: string }>;
  cursorSettingSources?: string[];
  cursorMode?: string | null;
  cursorAllowLargeContext?: boolean;
  cursorWorkerAgentLifecycle?: string;
  workspaceKey: WorkspaceKey;
  workspacePath: FilePath;
  gitBranchName?: string | null;
  repoPath?: FilePath | null;
  baseRef?: string | null;
  status: RunStatus;
  startedAt: IsoDateTime;
  updatedAt: IsoDateTime;
  completedAt: IsoDateTime | null;
  error: string | null;
  tokens: TokenCounts;
  transcriptEventCount?: number;
  prUrl?: UrlString | null;
  prNumber?: number | null;
  prHeadSha?: Sha | null;
  prBranch?: string | null;
  ciStatus?: string | null;
  lastPushedAt?: IsoDateTime | null;
  lastEvidenceCursor?: string | null;
  cancellationRequestedAt?: IsoDateTime | null;
  cancellationSource?: PersistedRunCancellationSource | null;
  cancellationReason?: string | null;
  harnessStopRequestedAt?: IsoDateTime | null;
  harnessStopFailedAt?: IsoDateTime | null;
  harnessStopFailedReason?: string | null;
  cancellationOutcome?: PersistedCancellationOutcome;
  cancelFailed?: boolean;
  cancelFailedAt?: IsoDateTime | null;
  cancelFailedReason?: string | null;
  cancelFailedSource?: PersistedCancelFailedSource | null;
  activitySnapshot?: RunActivitySnapshot;
  sdkRunStatus?: PersistedSdkRunStatus | null;
  sdkRunStatusObservedAt?: IsoDateTime | null;
  sdkRunStatusSource?: PersistedSdkRunStatusSource | null;
  failureKind?: string | null;
  failureDiagnosticCode?: string | null;
  failureDiagnosticMessage?: string | null;
  failureDiagnosticAt?: IsoDateTime | null;
  failureDiagnosticPayload?: unknown;
  pendingApprovalRequestId?: string | null;
  pendingApprovalRequestedAt?: IsoDateTime | null;
  providerLimit?: ProviderLimitSignal | null;
}

interface TranscriptEvent {
  runId: RunId;
  sequence: number;
  at: IsoDateTime;
  source: "harness" | "runtime" | "cursor" | "orchestrator";
  eventType: string;
  message?: string;
  payload?: unknown;
}

interface TranscriptPage {
  runId: RunId;
  offset: number;
  limit: number;
  nextOffset: number | null;
  events: TranscriptEvent[];
}
```

Relationships:

- `RunRecord.runId` owns `runs/<runId>/events.jsonl`.
- `RunRecord.issueId` relates to `IssueLifecycleRecord.issueId`, writebacks, approvals, and provider gate sources.
- `RunRecord.projectContext` scopes durable transcript/run-activity reads and status projections; legacy run metadata missing that field is normalized to the legacy/default context on read.
- `RunRecord.workspaceKey` relates to `WorkspaceRecord.workspaceKey`.
- Harnesses provide `sessionId`, `agentId`, token counts, SDK/run status, provider-limit signals, and transcript events.

### Issue Lifecycle Records

Source: `src/core/persistence/IssueLifecycleStore.ts`. This is Symphony's central durable state per issue.

```ts
type IssueLifecyclePhase =
  | "implementation"
  | "merge_conflict_resolution"
  | "review"
  | "passed"
  | "blocked"
  | "terminal"
  | "unknown";

interface IssueLifecycleSummaryPointers {
  projectContext?: ProjectContextResolution;
  workspaceKey: WorkspaceKey | null;
  workspacePath: FilePath | null;
  branchName: string | null;
  gitBranchName: string | null;
  repoPath: FilePath | null;
  baseRef: string | null;
  lastRunId: RunId | null;
  prUrl: UrlString | null;
  prNumber: number | null;
  prHeadSha: Sha | null;
  prBranch: string | null;
  ciStatus: string | null;
  lastPushedAt: IsoDateTime | null;
  lastEvidenceCursor: string | null;
}

interface IssueLifecycleSummaryReference {
  id: string;
  kind: "continuation_history" | "issue_breakdown_plan";
  summary: string;
  planId?: string;
  runIds: RunId[];
  transcriptEventCount: number;
  transcriptPointers: string[];
  statusApiPointers: string[];
  issueUpdatedAt?: IsoDateTime | null;
  issueContentFingerprint?: string | null;
  configFingerprint?: string | null;
  cursorMode?: string | null;
  createdAt: IsoDateTime;
}

interface ProposedIssueRecord {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  dependencies: string[];
  labels: string[];
}

interface IssueBreakdownPlanRecord {
  id: string;
  idempotencyKey: string;
  requestHash: string;
  runId: RunId;
  issueId: IssueId;
  issueIdentifier: IssueIdentifier;
  projectContext?: ProjectContextResolution;
  summary: string;
  proposedIssues: ProposedIssueRecord[];
  transcriptPointers: string[];
  statusApiPointers: string[];
  issueUpdatedAt: IsoDateTime | null;
  issueContentFingerprint: string;
  configFingerprint: string;
  cursorMode: string;
  acceptedAt: IsoDateTime;
  applicationStatus: "not_requested" | "pending" | "applied" | "blocked" | "stale";
  applicationOperationKeys: string[];
  createdIssueRefs: Array<{
    proposedIssueIndex: number;
    operationKey: string;
    status: "created" | "verified";
    id: IssueId;
    identifier: IssueIdentifier | null;
    url: UrlString | null;
  }>;
  appliedAt: IsoDateTime | null;
  applicationBlockedReason: string | null;
}

interface CompletionReportPullRequestRef {
  url: UrlString | null;
  number: number | null;
  headSha: Sha | null;
  branch: string | null;
  draft?: boolean | null;
}

interface IssueCompletionReportRecord {
  id: string;
  idempotencyKey: string;
  runId: RunId;
  issueId: IssueId;
  issueIdentifier: IssueIdentifier;
  projectContext?: ProjectContextResolution;
  summary: string;
  validationEvidence: string[];
  acceptanceChecklist: Array<{ text: string; satisfied: boolean; evidence: string | null }>;
  changedFiles: string[];
  branchName: string | null;
  pullRequest: CompletionReportPullRequestRef | null;
  risks: string[];
  acceptedAt: IsoDateTime;
  writebackOperationKeys: string[];
}

interface IssueReviewVerdictRecord {
  id: string;
  idempotencyKey: string;
  runId: RunId;
  issueId: IssueId;
  issueIdentifier: IssueIdentifier;
  projectContext?: ProjectContextResolution;
  verdict: "pass" | "fail";
  acceptanceResults: Array<{ text: string; satisfied: boolean; evidence: string | null }>;
  findings: string[];
  evidence: string[];
  reviewer: string | null;
  submittedAt: IsoDateTime;
  writebackOperationKeys: string[];
}

interface IssueReviewFeedbackRecord {
  id: string;
  idempotencyKey: string;
  requestHash: string;
  runId: RunId;
  issueId: IssueId;
  issueIdentifier: IssueIdentifier;
  projectContext?: ProjectContextResolution;
  kind: "review" | "review_comment" | "issue_comment";
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT" | null;
  body: string;
  pullRequest: CompletionReportPullRequestRef;
  reviewer: string | null;
  reviewUrl: UrlString | null;
  commentUrls: UrlString[];
  submittedAt: IsoDateTime;
}

interface PullRequestReviewEvidenceState {
  pullRequest: CompletionReportPullRequestRef | null;
  lastIngestedCursor: string | null;
  lastWorkerEvidenceCursor: string | null;
  items: PullRequestReviewEvidenceItem[];
  updatedAt: IsoDateTime | null;
}

interface PullRequestReviewEvidenceItem {
  id: string;
  source: "review" | "review_comment" | "issue_comment";
  githubId: string;
  pullRequestNumber: number;
  pullRequestUrl: UrlString | null;
  url: UrlString | null;
  reviewer: string | null;
  body: string;
  state: string | null;
  path: string | null;
  line: number | null;
  originalLine: number | null;
  side: string | null;
  threadId: string | null;
  inReplyToId: string | null;
  isResolved: boolean | null;
  isOutdated: boolean | null;
  createdAt: IsoDateTime | null;
  updatedAt: IsoDateTime | null;
  submittedAt: IsoDateTime | null;
  cursor: string;
}

interface IssueMergeGateState {
  id: string;
  status: "observing" | "repair_dispatched" | "blocked" | "resolved" | "superseded";
  headSha: Sha;
  pullRequest: CompletionReportPullRequestRef;
  requiredChecks: string[];
  checks: Array<{
    name: string;
    outcome: "passing" | "pending" | "missing_observed" | "missing_actionable" | "failing" | "unknown";
    rawStatus: "success" | "failure" | "pending" | "missing" | "unknown";
    conclusion: string | null;
    url: UrlString | null;
    firstObservedAt: IsoDateTime | null;
    actionableSince: IsoDateTime | null;
  }>;
  mergeability: {
    status: "mergeable" | "conflicted" | "unknown" | "blocked";
    pullRequest: CompletionReportPullRequestRef;
    mergeable: boolean | null;
    mergeableState: string | null;
    reason: string | null;
    baseBranch: string | null;
    baseHeadSha: Sha | null;
    checkedAt: IsoDateTime;
  } | null;
  reviewRound: number;
  gateRunId: RunId | null;
  gateReportId: string | null;
  repairRunId: RunId | null;
  repairReportId: string | null;
  blockerFingerprint: string | null;
  writebackOperationKeys: string[];
  supersededByHeadSha: Sha | null;
  updatedAt: IsoDateTime;
}

interface IssueMergeMetadata {
  id: string;
  pullRequest: CompletionReportPullRequestRef;
  headSha: Sha;
  mergeCommitSha: Sha;
  mergedAt: IsoDateTime;
  mergedBy: { login: string | null; profile: string | null; capability: "github.merge" };
  checkStatus: { requiredChecks: string[]; passedChecks: string[]; noCiEvidence: string | null };
  mergeOperationKey: string;
  doneTransitionOperationKey: string;
}

interface IssueMergeConflictMetadata {
  id: string;
  status: "open" | "resolved" | "blocked";
  resolutionStatus: "pending" | "still_conflicted" | "resolved" | "blocked";
  pullRequest: CompletionReportPullRequestRef;
  approvedHeadSha: Sha;
  currentHeadSha: Sha;
  resolvedHeadSha: Sha | null;
  baseBranch: string | null;
  baseHeadSha: Sha | null;
  sourceState: string;
  conflictsState: string;
  reason: string;
  mergeableState: string | null;
  detectedAt: IsoDateTime;
  updatedAt: IsoDateTime;
  fixTurnCount: number;
  maxFixTurns: number;
  lastConflictFixRunId: RunId | null;
  lastConflictResolutionReportId: string | null;
  attemptRunIds: RunId[];
  writebackOperationKeys: string[];
  blockedAt: IsoDateTime | null;
  blockedReason: string | null;
}

interface IssueMergeConflictResolutionReportRecord {
  id: string;
  idempotencyKey: string;
  runId: RunId;
  issueId: IssueId;
  issueIdentifier: IssueIdentifier;
  projectContext?: ProjectContextResolution;
  resolutionStatus: "resolved" | "still_conflicted" | "blocked";
  summary: string;
  validationEvidence: string[];
  changedFiles: string[];
  pullRequest: CompletionReportPullRequestRef;
  previousHeadSha: Sha | null;
  newHeadSha: Sha | null;
  baseBranch: string | null;
  baseHeadSha: Sha | null;
  blockedReason: string | null;
  risks: string[];
  submittedAt: IsoDateTime;
}

interface IssueLaneMemo {
  version: 1;
  issueId: IssueId;
  issueIdentifier: IssueIdentifier;
  projectContext?: ProjectContextResolution;
  updatedAt: IsoDateTime;
  reviewRound: number;
  incompleteTurnCount: number;
  sizeChars: number;
  entries: string[];
  openFindings: string[];
  pointers: IssueLifecycleSummaryPointers;
  lastWorkerRunId: RunId | null;
  lastReviewerRunId: RunId | null;
}

interface IssueHandoffState {
  version: 1;
  memo: IssueLaneMemo;
  lastWorkerOutput: IssueWorkerOutputContract | null;
  lastReviewerOutput: IssueReviewerOutputContract | null;
}

interface WorkerHandoffPacket {
  version: 1;
  issueId: IssueId;
  issueIdentifier: IssueIdentifier;
  projectContext?: ProjectContextResolution;
  generatedAt: IsoDateTime;
  memo: IssueLaneMemo;
  lastWorkerOutput: IssueWorkerOutputContract | null;
  lastReviewerOutput: IssueReviewerOutputContract | null;
  pointers: IssueLifecycleSummaryPointers;
}

interface IssueLifecycleRecord {
  issueId: IssueId;
  issueIdentifier: IssueIdentifier;
  projectContext?: ProjectContextResolution;
  phase: IssueLifecyclePhase;
  reviewRound: number;
  incompleteTurnCount: number;
  lastIssueBreakdownPlanId: string | null;
  planningFailureCount: number;
  planningDispatchRetryCount: number;
  lastPlanningFailureRunId: RunId | null;
  lastPlanningFailureAt: IsoDateTime | null;
  lastCompletionReportId: string | null;
  lastReviewVerdictId: string | null;
  blockedReason: string | null;
  summaryPointers: IssueLifecycleSummaryPointers;
  summaryReferences: IssueLifecycleSummaryReference[];
  issueBreakdownPlans: IssueBreakdownPlanRecord[];
  completionReports: IssueCompletionReportRecord[];
  reviewVerdicts: IssueReviewVerdictRecord[];
  reviewFeedback: IssueReviewFeedbackRecord[];
  reviewEvidence: PullRequestReviewEvidenceState;
  mergeGate?: IssueMergeGateState | null;
  merge: IssueMergeMetadata | null;
  mergeConflict: IssueMergeConflictMetadata | null;
  mergeConflictResolutionReports: IssueMergeConflictResolutionReportRecord[];
  handoff: IssueHandoffState;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}
```

Lifecycle relationships:

- `lastCompletionReportId`, `lastReviewVerdictId`, `lastIssueBreakdownPlanId`, and merge conflict ids point into arrays inside the same lifecycle record.
- `summaryPointers` is the denormalized "latest known" bridge to project context, workspaces, runs, git, PR, and CI.
- `summaryReferences` points to transcript and status API locations that can rebuild context.
- `handoff.memo` and `WorkerHandoffPacket` preserve the currently attributed project context across worker/reviewer lane transitions.
- `reviewEvidence.lastWorkerEvidenceCursor` prevents workers from reusing stale PR review evidence.
- Merge automation uses completion report + review approval + PR details + required checks to update `mergeGate`, `mergeConflict`, or `merge`.

### Writeback Outbox Records

Source: `src/core/writeback/WritebackOutbox.ts`.

```ts
type WritebackStatus = "pending" | "in_flight" | "succeeded" | "skipped" | "retrying" | "dead_letter";

type WritebackOperation =
  | WritebackTransitionOperation
  | WritebackCommentOperation
  | WritebackIssueCreateOperation
  | WritebackIssueRelationOperation;

interface WritebackCommon {
  idempotencyKey: string;
  issueId: IssueId;
  projectContext?: ProjectContextResolution;
  runId?: RunId;
  status: WritebackStatus;
  attempt: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  nextAttemptAt: IsoDateTime;
  lastError: string | null;
  resultStatus: "applied" | "verified" | "skipped" | "dry_run" | null;
  resultMessage: string | null;
  resultEvidence: TrackerWriteEvidence | null;
}

interface WritebackTransitionOperation extends WritebackCommon {
  kind: "transition";
  payload: { toState: string; fromStates?: string[]; reason?: string };
}

interface WritebackCommentOperation extends WritebackCommon {
  kind: "comment";
  payload: { body: string; dedupeKey: string; issueBreakdownPlanId?: string };
}

interface WritebackIssueCreateOperation extends WritebackCommon {
  kind: "issue_create";
  payload: {
    parentIssueId: IssueId;
    planId: string;
    proposedIssueIndex: number;
    title: string;
    description: string;
    acceptanceCriteria: string[];
    requestedLabels: string[];
    dependencies: string[];
    dedupeKey: string;
    payloadHash: string;
  };
}

interface WritebackIssueRelationOperation extends WritebackCommon {
  kind: "issue_relation";
  payload: {
    planId: string;
    sourceIssueId: IssueId;
    sourceIssueIdentifier: IssueIdentifier | null;
    targetIssueId: IssueId;
    targetIssueIdentifier: IssueIdentifier | null;
    type: "blocks";
    dependency: string;
    dedupeKey: string;
    sourceProposedIssueIndex: number;
    targetProposedIssueIndex: number;
  };
}
```

Writeback relationships:

- `issueId` links to Linear and lifecycle.
- `projectContext` scopes idempotency and replay to the attributed workflow/codebase context even when issue identifiers or run ids overlap elsewhere.
- `runId` links to the run that generated the operation when applicable.
- Lifecycle records store operation keys in reports, plans, merge gates, merge conflict metadata, and final merge metadata.
- Issue-breakdown application freshness checks use the current `IssueBreakdownPlanRecord` and operation bindings.

### Operator Approval Records

Source: `src/core/approval/OperatorApprovalService.ts`.

```ts
type OperatorApprovalDecision = "approve" | "reject";
type OperatorApprovalStatus = "pending" | "approved" | "rejected" | "stale" | "expired" | "cancelled";

interface OperatorApprovalAction {
  kind: "push_and_pr";
  branchName: string;
  baseBranch: string;
  workspacePath: FilePath;
  title: string;
  evidenceCursor: string;
  summaryPreview: string;
  changedFiles: string[];
  plannedOperations: Array<"commit_if_needed" | "git_push" | "pull_request_create_or_reuse">;
}

interface OperatorApprovalRecord {
  requestId: string;
  status: OperatorApprovalStatus;
  issueId: IssueId;
  issueIdentifier: IssueIdentifier;
  projectContext?: ProjectContextResolution;
  runId: RunId;
  evidenceCursor: string;
  dedupeKey: string;
  action: OperatorApprovalAction;
  requestedAt: IsoDateTime;
  expiresAt: IsoDateTime | null;
  resolvedAt: IsoDateTime | null;
  resolvedBy: "operator" | "system" | null;
  decision: OperatorApprovalDecision | null;
  staleReason: string | null;
}
```

Approval relationships:

- Completion-report publication can create an approval request.
- `projectContext` preserves which workflow/codebase context requested publication and follows the same legacy/default readback contract as other durable records.
- `RunRecord.pendingApprovalRequestId` mirrors pending state.
- Approval creation and resolution also append transcript events to the run.
- Rejection can mark the run failed or cancelled depending on `github.operatorApproval.rejectPolicy`.

### Provider Gates

Source: `src/core/provider/ProviderLimits.ts`, `src/core/persistence/ProviderGateStore.ts`.

```ts
type ProviderLimitKind =
  | "transient_rate_limit"
  | "windowed_bucket_exhausted"
  | "credits_exhausted"
  | "subscription_required"
  | "unknown_limit";

type ProviderLimitResumePolicy = "auto_at_window_close" | "manual";

interface ProviderLimitScope {
  harnessId: string;
  providerId?: string | null;
  model?: string | null;
  accountScopeKey?: string | null;
}

interface ProviderLimitWindow {
  resumeAt?: IsoDateTime | null;
  retryAfterMs?: number | null;
  windowLabel?: string | null;
  windowKind?: string | null;
}

interface ProviderLimitSource {
  issueId?: IssueId | null;
  issueIdentifier?: IssueIdentifier | null;
  runId?: RunId | null;
  sessionId?: string | null;
  role?: AgentRunRole | null;
  runPhase?: AgentRunPhase | null;
}

interface ProviderLimitSignal {
  scope: ProviderLimitScope;
  kind: ProviderLimitKind;
  window?: ProviderLimitWindow | null;
  resumePolicy?: ProviderLimitResumePolicy;
  message: string;
  observedAt?: IsoDateTime;
  source?: ProviderLimitSource | null;
  raw?: unknown;
}

interface RuntimeProviderGate {
  id: string;
  scope: ProviderLimitScope;
  kind: ProviderLimitKind;
  window: ProviderLimitWindow | null;
  resumePolicy: ProviderLimitResumePolicy;
  message: string;
  observedAt: IsoDateTime;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  affectedRoles: AgentRunRole[];
  affectedRunPhases: AgentRunPhase[];
  source: ProviderLimitSource | null;
  raw?: unknown;
}
```

Provider gates are keyed by provider/model/scope/kind/window and block affected dispatch until cleared or auto-expired.

### MCP Exposure Diagnostics

Source: `src/core/harness/McpToolExposureProbe.ts`.

```ts
type McpToolExposureStage = "subprocess" | "sdk" | "hermes_gateway";
type McpToolExposureStatus = "success" | "failure" | "skipped";

interface McpToolExposureSpec {
  role: AgentRunRole;
  runPhase: AgentRunPhase;
  serverKey: "symphony" | "symphony_conflicts" | "symphony_review_verdict" | "symphony_review_feedback";
  command: McpSubprocessCommand;
  expectedTool: string;
}

interface McpToolExposureServerResult {
  role: AgentRunRole;
  serverKey: McpToolExposureSpec["serverKey"];
  command: McpSubprocessCommand;
  expectedTool: string;
  status: McpToolExposureStatus;
  failureCode: string | null;
  message: string;
  rawToolNames: string[];
  normalizedToolNames: string[];
  envKeyNames: string[];
  sdkRoleRunRole?: AgentRunRole;
  sdkRoleRunPhase?: AgentRunPhase;
  sdkRoleRunIndex?: number;
}

interface McpToolExposureStageResult {
  stage: McpToolExposureStage;
  status: McpToolExposureStatus;
  failureCode: string | null;
  message: string;
  results: McpToolExposureServerResult[];
  sdkRoleRuns?: SdkRoleRunResult[];
}

interface McpToolExposureReport {
  version: 1;
  generatedAt: IsoDateTime;
  workflowPath: FilePath;
  cliPath: FilePath;
  liveSmokeEnabled: boolean;
  probeConfig: McpToolExposureProbeConfig;
  ok: boolean;
  stages: McpToolExposureStageResult[];
}
```

## Runtime Orchestrator State

Source: `src/core/orchestrator/Orchestrator.ts`.

```ts
interface RunningEntry {
  issue: Issue;
  role: AgentRunRole;
  runPhase: AgentRunPhase;
  workspacePath: FilePath | null;
  workspace: Workspace | null;
  sessionId: string | null;
  runId: RunId | null;
  activeRunId: RunId | null;
  lifecycle: IssueLifecycleRecord | null;
  worker: Promise<void>;
  abortController: AbortController;
  startedAt: Date;
  lastEventAt: Date | null;
  lastEvent: string | null;
  lastMessage: string | null;
  sdkRunStatus: "running" | "finished" | "error" | "cancelled" | null;
  sdkRunStatusUpdatedAt: Date | null;
  sdkRunStatusSource: "initial" | "onDidChangeStatus" | "wait" | null;
  failureKind: string | null;
  failureDiagnosticCode: string | null;
  failureDiagnosticMessage: string | null;
  failureDiagnosticAt: Date | null;
  failureDiagnosticPayload: unknown;
  turnCount: number;
  retryAttempt: number;
  tokens: TokenCounts;
  activeRunTokens: TokenCounts;
  cleanupWorkspaceOnExit: boolean;
  suppressRetryOnExit: boolean;
  completionReportAccepted: boolean;
  mergeConflictResolutionAccepted: boolean;
  issueBreakdownPlanAccepted: boolean;
  pullRequestHandoffAccepted: boolean;
  reviewVerdictAccepted: boolean;
  reviewEvidence: ReviewerDispatchEvidence | null;
  cancellationRequestedAt: Date | null;
  cancellationSource: PersistedRunCancellationSource | null;
  cancellationReason: string | null;
  abortSignalledAt: Date | null;
  harnessStopRequestedAt: Date | null;
  harnessStopFailedAt: Date | null;
  harnessStopFailedReason: string | null;
  lastStreamActivityAt: Date | null;
  lastDeltaOrToolActivityAt: Date | null;
  lastToolActivityAt: Date | null;
  providerLimitSignal: ProviderLimitSignal | null;
}

interface RetryEntry {
  issueId: IssueId;
  identifier: IssueIdentifier;
  attempt: number;
  dueAtMs: number;
  timer: NodeJS.Timeout;
  error: string;
  runPhase: AgentRunPhase;
}

interface RuntimeSnapshot {
  generatedAt: IsoDateTime;
  counts: { running: number; retrying: number; paused: number; providerGates: number };
  providerGates: RuntimeProviderGate[];
  providerGateCounts: { active: number; manual: number; autoResume: number };
  running: RuntimeRunningIssue[];
  retrying: RuntimeRetryingIssue[];
  paused: PausedOperatorView[];
  totals: RuntimeTotals;
  rateLimits: unknown[];
}
```

In-memory fields not written directly to durable records:

- `pollTimer`, `ticking`, `stopped`, and `endedRuntimeSeconds`
- `running: Map<IssueId, RunningEntry>`
- `claimed: Set<IssueId>` to prevent duplicate dispatch
- `completed: Set<IssueId>` for current-process completion tracking
- `pausedIssues: Set<IssueId>`
- `retryAttempts: Map<IssueId, RetryEntry>`
- `activeProviderGates: RuntimeProviderGate[]`
- `rateLimits` and `totals`

Durability boundary:

- The orchestrator persists meaningful run, transcript, lifecycle, writeback, approval, and provider-gate events.
- Dispatch locks, active abort controllers, timers, and live liveness timestamps are in-memory and are reconstructed or dropped on restart.

## Harness State

### Agent Event Contract

Source: `src/core/harness/AgentHarness.ts`.

```ts
interface AgentRunContext {
  issue: Issue;
  role: AgentRunRole;
  runPhase?: AgentRunPhase;
  attempt: number | null;
  workspace: Workspace;
  config: ServiceConfig;
  turnNumber: number;
  runModeOverride?: "agent" | "plan" | null;
  abortSignal: AbortSignal;
  logger: Logger;
}

type AgentEvent =
  | { type: "session_started"; sessionId: string; threadId?: string; runId?: string; at?: string }
  | { type: "progress"; message: string; activitySource?: "stream" | "delta" | "tool"; at?: string }
  | { type: "tokens"; tokens: Partial<TokenCounts>; at?: string }
  | { type: "rate_limits"; payload: unknown; at?: string }
  | { type: "provider_limit"; signal: ProviderLimitSignal; at?: string }
  | { type: "run_status"; runId: RunId; sdkStatus: "running" | "finished" | "error" | "cancelled"; source: "initial" | "onDidChangeStatus" | "wait"; at?: string }
  | { type: "run_diagnostic"; code: string; message: string; payload?: unknown; at?: string }
  | { type: "completed"; message?: string; at?: string }
  | { type: "failed"; error: string; at?: string }
  | { type: "cancelled"; at?: string };
```

The orchestrator converts these events into `RunRecord` updates, transcript events, lifecycle changes, writeback operations, and provider gates.

### Cursor Harness State

Source: `cursor/src/CursorHarness.ts`, `cursor/src/CursorEventMapper.ts`.

```ts
interface CursorHarnessOptions {
  runStore?: RunTranscriptStore;
}

interface CursorAgentLease {
  agent: SDKAgent;
  created: boolean;
  resumeAttempted: boolean;
  resumeUsed: boolean;
  outcome: "created" | "resumed" | "reused";
}

interface CursorLastToolContext {
  name: string | null;
  status: string | null;
  observedAt: IsoDateTime;
}

interface CursorHarnessMemory {
  agents: Map<string, SDKAgent>;
  activeRuns: Map<RunId, Run>;
}
```

Cursor relationships:

- Agent key is workspace path + role + phase; worker implementation can reuse/resume when `cursor.workerAgentLifecycle: "resume_by_issue"`.
- Latest worker implementation `RunRecord.agentId` is used for Cursor `Agent.resume`.
- Cursor SDK stream messages become transcript events with `source: "cursor"`.
- Cursor status and wait results become `run_status`, `completed`, `failed`, or `cancelled` events.

Cursor transcript payload shapes:

```ts
type CursorTranscriptPayload =
  | { harnessId: "cursor"; kind: "thinking" | "task"; summary: string; truncated: boolean; redacted: true }
  | { harnessId: "cursor"; kind: "assistant"; textPreview: string; truncated: boolean }
  | { harnessId: "cursor"; kind: "tool_call"; name: string; status: string; callId?: string; argumentsPreview?: string; resultPreview?: string; outputPreview?: string; errorPreview?: string; redacted: true; truncated: boolean }
  | { harnessId: "cursor"; kind: "status"; status: string; messagePreview?: string; truncated: boolean }
  | { harnessId: "cursor"; kind: "system"; subtype: string; messagePreview?: string; truncated: boolean };
```

### Hermes Harness State

Source: `hermes/src/HermesHarness.ts`, `hermes/src/GatewayFacade.ts`.

```ts
interface HermesHarnessOptions {
  runStore?: RunTranscriptStore;
  cliPath?: FilePath;
  gatewayFactory?: (env: HermesGatewayEnvironment) => HermesGatewayClient;
  profileManager?: HermesProfileManager;
  authManager?: HermesAuthManager;
}

interface HermesLease {
  key: string;
  reusable: boolean;
  profile: HermesProfile;
  client: HermesGatewayClient;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  shutdownGraceMs: number;
  gatewaySessionId: string | null;
  disposed: boolean;
}

interface HermesHarnessMemory {
  leases: Map<string, HermesLease>;
  activeRuns: Map<RunId, HermesLease>;
  cancelledRuns: Set<RunId>;
}

interface HermesGatewayEnvironment {
  upstreamRoot: FilePath;
  hermesHome: FilePath;
  authHome?: FilePath | null;
  cwd: FilePath;
  python?: string | null;
  model?: string | null;
  provider?: string | null;
  startupTimeoutMs?: number | null;
  requestTimeoutMs?: number | null;
  extraEnv?: Record<string, string | null | undefined>;
}
```

Hermes relationships:

- Run id is generated as `hermes-<uuid>`.
- Symphony session id is `<profileKey>:<gatewaySessionId>:<runId>`.
- Reusable worker implementation leases are keyed by workspace path, issue, and phase when `hermes.workerSessionLifecycle: "reuse_by_issue"`.
- Hermes gateway events become `AgentEvent`s and transcript events with `source: "runtime"`.
- Provider limit events or errors become `ProviderLimitSignal` and then provider gates.

Hermes profile state:

```ts
interface HermesProfileRequest {
  workspaceKey: WorkspaceKey;
  role: string;
  phase: string;
  template: string;
  profileKey: string;
  mode: "reuse" | "fresh";
}

interface HermesProfile {
  profileDir: FilePath;
  templateDir: FilePath;
  profileKey: string;
  createdFresh: boolean;
}

interface HermesProfileMarker {
  profileKey: string;
  workspaceKey: WorkspaceKey;
  role: string;
  phase: string;
  template: string;
  materializedAt: IsoDateTime;
}
```

Profile layout under `hermes.stateDir`:

```text
profiles/<workspaceKey>/<role>/<phase>/<profileKey>/
  .symphony-hermes-profile.json
  config.yaml
  memories/
  sessions/
  skills/
  skins/
  logs/
  plans/
  workspace/
  cron/
  home/
  ...opaque Hermes runtime files, including upstream session state...
```

Hermes MCP config:

```ts
interface HermesMcpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
  timeout: number;
  connect_timeout: number;
}

type HermesMcpServersConfig = Record<string, HermesMcpServerConfig>;
```

`writeHermesMcpConfig` writes `config.yaml` with `mcp_servers` and `agent.max_turns`.

Hermes managed auth state:

```ts
interface HermesAuthPreparation {
  managedRoot: FilePath;
  bootstrapFrom: FilePath;
  presentProviders: string[];
  copiedProviders: string[];
  missingProviders: string[];
}

interface HermesAuthStore {
  version?: number;
  providers?: Record<string, unknown>;
  credential_pool?: Record<string, unknown>;
  suppressed_sources?: Record<string, unknown>;
  active_provider?: unknown;
  updated_at?: IsoDateTime;
}
```

`HermesAuthManager` reads `<bootstrapFrom>/auth.json`, copies configured provider material to `<managedRoot>/auth.json`, and writes with mode `0600` where supported. For `openai-codex`, Symphony requires managed auth instead of a raw runtime API key.

## MCP Handoff State

Source: `src/core/harness/HandoffMcp.ts` and `src/core/harness/*McpServer.ts`.

MCP subprocess config:

```ts
type McpSubprocessCommand =
  | "completion-report-mcp"
  | "merge-conflict-resolution-mcp"
  | "issue-breakdown-plan-mcp"
  | "review-verdict-mcp"
  | "review-feedback-mcp"
  | "transcript-recall-mcp";

interface McpSubprocessServerConfig {
  type: "stdio";
  command: string;
  args: string[];
  cwd: FilePath;
  env: Record<string, string>;
}
```

Context files:

```ts
interface CompletionReportMcpContextFile {
  issue: Issue;
  activeRunId: RunId | null;
  role: "worker";
  token?: string | null;
  expectedToken?: string | null;
  sessionId?: string | null;
  workspacePath: FilePath | null;
  workspace: Workspace;
  phase: "implementation";
}

interface MergeConflictResolutionMcpContextFile {
  issue: Issue;
  activeRunId: RunId | null;
  role: "worker";
  token?: string | null;
  expectedToken?: string | null;
  sessionId?: string | null;
  workspacePath: FilePath | null;
  workspace: Workspace;
  phase: "merge_conflict_resolution";
}

interface IssueBreakdownPlanMcpContextFile {
  issue: Issue;
  activeRunId: RunId | null;
  role: "worker";
  phase: "issue_breakdown";
  workspacePath: FilePath | null;
  workspace: Workspace;
}

interface ReviewVerdictMcpContextFile {
  issue: Issue;
  activeRunId: RunId | null;
  role: "reviewer";
  token?: string | null;
  expectedToken?: string | null;
  reviewer?: string | null;
  phase: "review";
}

interface ReviewFeedbackMcpContextFile {
  issue: Issue;
  activeRunId: RunId | null;
  role: "reviewer";
  token?: string | null;
  expectedToken?: string | null;
  reviewer?: string | null;
  phase: "review";
}

interface TranscriptRecallMcpContextFile {
  issue: Issue;
  activeRunId: RunId | null;
  role: "worker" | "reviewer";
  phase: AgentRunPhase;
}
```

Handoff relationships:

- Worker implementation gets `submit_completion_report`.
- Worker merge-conflict repair gets `submit_merge_conflict_resolution`.
- Worker issue planning gets `submit_issue_breakdown_plan`.
- Reviewer gets `submit_review_verdict` and `submit_pull_request_review_feedback`.
- If `continuationContext.searchEnabled`, any role can also get `search_transcript_context`.
- Context files are initially written with `activeRunId: null`, then rewritten after the runtime creates a concrete run id.

MCP tool outputs become lifecycle records, writeback operations, PR feedback, transcript telemetry, and run metadata.

## Completion, Review, Planning, And Merge Service State

These are not separate durable stores; they mutate lifecycle, run, writeback, approval, GitHub, and transcript state.

```ts
interface CompletionReportActiveContext {
  issue: Issue;
  activeRunId: RunId;
  role: "worker";
  token: string | null;
  expectedToken: string | null;
  sessionId: string | null;
  workspacePath: FilePath | null;
  workspace: Workspace;
  phase: "implementation";
}

interface ReviewVerdictActiveContext {
  issue: Issue;
  activeRunId: RunId;
  role: "reviewer";
  token: string | null;
  expectedToken: string | null;
  reviewer: string | null;
  phase: "review";
}

interface ReviewFeedbackActiveContext {
  issue: Issue;
  activeRunId: RunId;
  role: "reviewer";
  token: string | null;
  expectedToken: string | null;
  reviewer: string | null;
  phase: "review";
}

interface IssueBreakdownPlanActiveContext {
  issue: Issue;
  activeRunId: RunId;
  role: "worker";
  phase: "issue_breakdown";
  workspacePath: FilePath | null;
  workspace: Workspace;
}

interface MergeConflictResolutionActiveContext {
  issue: Issue;
  activeRunId: RunId;
  role: "worker";
  token: string | null;
  expectedToken: string | null;
  sessionId: string | null;
  workspacePath: FilePath | null;
  workspace: Workspace;
  phase: "merge_conflict_resolution";
}
```

Service relationships:

- `CompletionReportService` creates `IssueCompletionReportRecord`, may publish/reuse PRs, may create `OperatorApprovalRecord`, and enqueues review-state writeback.
- `ReviewVerdictService` creates `IssueReviewVerdictRecord`, increments review counters, and enqueues pass/fail/blocked writebacks.
- `PullRequestReviewFeedbackService` creates `IssueReviewFeedbackRecord` and writes GitHub review/comment state.
- `PullRequestReviewEvidenceService` ingests GitHub review/comment state into `PullRequestReviewEvidenceState`.
- `IssueBreakdownPlanService` creates `IssueBreakdownPlanRecord` and summary references.
- `IssueBreakdownPlanApplyService` enqueues Linear child issue and relation writebacks.
- `MergePolicyService` writes merge gate, merge conflict, final merge, and done-transition state.
- `MergeConflictResolutionService` creates conflict resolution reports and updates conflict metadata.

## Continuation And Recall State

Source: `src/core/summarization/ContinuationSummarizer.ts`, `src/core/recall/TranscriptRecallService.ts`, `src/core/context-governor/*`.

Current production continuation summary records are lifecycle `summaryReferences`:

```ts
interface ContinuationSummarizationInput {
  issue: Pick<Issue, "id" | "identifier" | "title">;
  runs: RunRecord[];
  transcriptEvents: TranscriptEvent[];
  transcriptPointers: string[];
  statusApiPointers: string[];
}
```

Transcript recall result:

```ts
interface TranscriptRecallSearchResult {
  issueId: IssueId;
  issueIdentifier: IssueIdentifier;
  query: string;
  callsRemaining: number;
  denied: boolean;
  truncated: boolean;
  returnedEvents: number;
  returnedChars: number;
  runs: TranscriptRecallRunResult[];
}

interface TranscriptRecallRunResult {
  runId: RunId;
  sessionId: string | null;
  role: AgentRunRole;
  runPhase: AgentRunPhase | null;
  status: RunStatus;
  startedAt: IsoDateTime;
  updatedAt: IsoDateTime;
  matches: TranscriptRecallMatchWindow[];
}
```

Recall telemetry is appended to the active run transcript as an orchestrator event:

```ts
interface TranscriptRecallTelemetryPayload {
  issueId: IssueId;
  issueIdentifier: IssueIdentifier;
  query: string;
  returnedEvents: number;
  returnedChars: number;
  truncated: boolean;
  denied: boolean;
  callsRemaining: number;
}
```

Context-governor proof-of-concept state:

```ts
interface PromptSource {
  kind: "file" | "stdin" | "inline";
  label: string;
  text: string;
  sha256: string;
  charCount: number;
  byteCount: number;
  lineCount: number;
}

interface KnownPromptTokenCount {
  method: "heuristic-v1";
  exact: false;
  tokens: number;
  charCount: number;
  byteCount: number;
  notes: string[];
}

interface StreamAccumulatorSnapshot {
  updateCounts: Record<string, number>;
  messageCounts: Record<string, number>;
  observedOutputTokenDeltas: number;
  estimatedOutputTokens: number;
  textDeltaChars: number;
  thinkingDeltaChars: number;
  assistantTextPreview: string;
  thinkingTextPreview: string;
  summaryTextPreview: string;
  latestUsage: SdkUsageTokenCounts | null;
  usages: SdkUsageTokenCounts[];
  systemModels: RuntimeModelSelection[];
}

interface GovernorDecision {
  action: "continue" | "block_before_send" | "cancel_and_summarize";
  reason: string | null;
  observedValue: number | null;
  threshold: number | null;
}

interface ContinuationSummary {
  version: 1;
  createdAt: IsoDateTime;
  reason: string;
  originalPrompt: {
    source: string;
    sha256: string;
    charCount: number;
    knownPromptTokens: number;
    tokenMethod: string;
    objectivePreview: string;
  };
  tokenStats: {
    observedOutputTokenDeltas: number;
    latestInputTokens: number | null;
    latestOutputTokens: number | null;
    latestTotalTokens: number | null;
  };
  summary: string;
  importantOutput: string[];
  openQuestions: string[];
  omissions: string[];
}
```

Only lifecycle summary references and transcript recall events are currently tied into normal orchestration.

## HTTP API And Projection State

Source: `src/app/http.ts`, `src/app/webProjection.ts`, `src/app/WebHistoryProjection.ts`, `src/app/WebTranscriptProjection.ts`.

The API merges live orchestrator state, Linear tracker state, and durable local state. Key routes:

- `GET /api/v1/state`: runtime snapshot plus operator controls and liveness contract
- `GET /api/v1/board` and `GET /api/v1/issue-board`: issue board projection
- `GET /api/v1/board/issues/:id`: board issue detail projection
- `GET /api/v1/activity`: run, transcript, and writeback activity feed
- `GET /api/v1/workspaces`, `GET /api/v1/workspaces/:key`
- `POST /api/v1/issues/:id/open-workspace`
- `GET /api/v1/issues/:id`, `GET /api/v1/issues/:id/runs`
- `GET /api/v1/runs/:id`, `GET /api/v1/runs/:id/transcript`
- `POST /api/v1/issues/:id/pause|resume|cancel`
- `POST /api/v1/provider-gates/:id/clear|resume`
- `GET/POST /api/v1/approval-requests/:id`
- `POST /api/v1/issues/:id/continuation-summary`
- `POST /api/v1/issues/:id/issue-breakdown`, `/apply`
- `GET /api/v1/web/*`: React web UI projection endpoints

Board and activity structures:

```ts
interface IssueBoardCard {
  key: string;
  issueId: IssueId | null;
  issueIdentifier: IssueIdentifier | null;
  origin: "tracker" | "symphony" | string;
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

interface IssueBoardColumn {
  id: string;
  title: string;
  states: string[];
  count: number;
  issues: IssueBoardCard[];
}

interface IssueBoardResponse {
  generatedAt: IsoDateTime;
  tracker: JsonObject;
  columns: IssueBoardColumn[];
  issues: IssueBoardCard[];
  counts: JsonObject;
}

interface BoardIssueDetailResponse {
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
  pullRequest: IssuePullRequestSummary;
  blockers: IssueBlockerSummary;
  operatorLiveness: JsonObject | null;
  capabilities: IssueBoardCard["capabilities"] & {
    transcript?: boolean;
    openWorkspace?: boolean;
    mutationsRequireToken?: boolean;
    mutationHeader?: string;
  };
}

interface ActivityItem {
  id: string;
  at: IsoDateTime;
  kind: string;
  source: string;
  issue: { id: IssueId | null; identifier: IssueIdentifier | null } | null;
  run: JsonObject | null;
  transcript: { sequence: number; eventType: string; message: string | null } | null;
  writeback: JsonObject | null;
  links: JsonObject;
}

interface ActivityFeedResponse {
  generatedAt: IsoDateTime;
  offset: number;
  limit: number;
  nextOffset: number | null;
  activity: ActivityItem[];
  counts: JsonObject;
  source: JsonObject;
  filter: { issue: string | null };
}
```

Operator liveness and controls:

```ts
type RunLivenessStatus = "starting" | "active" | "terminal_pending" | "stalled" | "cancelling";

interface RunIdleAlertState {
  active: boolean;
  thresholdMs: number | null;
  lastActivityAt: IsoDateTime;
  secondsSinceLastActivity: number;
  reason: "observe_only" | "suppressed" | null;
}

interface RunLivenessState {
  status: RunLivenessStatus;
  activeRunId: RunId | null;
  lastActivityAt: IsoDateTime;
  secondsSinceLastActivity: number;
  stallTimeoutMs: number | null;
  sdkRunStatus?: "running" | "finished" | "error" | "cancelled" | null;
  sdkRunStatusUpdatedAt?: IsoDateTime | null;
  sdkRunStatusSource?: "initial" | "onDidChangeStatus" | "wait" | null;
  idleAlert?: RunIdleAlertState;
}

type RunCancellationSource = "operator" | "state_change" | "stalled" | "service_stop";

interface CancelFailedState {
  tracked: true;
  active: boolean;
  phase: "none" | "requested" | "failed" | "resolved_cancelled" | "resolved_failed";
  at: IsoDateTime | null;
  reason: string | null;
  source: "harness_stop" | "cancel_ignored" | null;
}

interface RunCancellationState {
  requested: boolean;
  requestedAt: IsoDateTime | null;
  source: RunCancellationSource | null;
  reason: string | null;
  abortSignalled: boolean;
  harnessStopRequestedAt: IsoDateTime | null;
  harnessStopFailedAt?: IsoDateTime | null;
  harnessStopFailedReason?: string | null;
  cancelFailed?: CancelFailedState;
  suppressRetryOnExit: boolean;
}

interface RunActivityState extends RunActivitySnapshot {
  unavailable: string[];
}

interface IssueRunMetadata {
  prUrl: UrlString | null;
  prNumber: number | null;
  prHeadSha: Sha | null;
  prBranch: string | null;
  ciStatus: string | null;
  lastPushedAt: IsoDateTime | null;
  lastEvidenceCursor: string | null;
  branchName: string | null;
  gitBranchName: string | null;
  repoPath: FilePath | null;
  baseRef: string | null;
}

type OperatorLivenessStatus =
  | "running"
  | "possibly_stalled"
  | "cancelling"
  | "cancelled"
  | "blocked_human_required"
  | "not_live";

interface OperatorControls {
  pause: boolean;
  resume: boolean;
  cancel: boolean;
  mutationsRequireToken: boolean;
}

interface OperatorAffordances {
  humanRequired: {
    active: boolean;
    reason: string | null;
    continuationSummaryRecommended: boolean;
  };
  continuationSummary: {
    available: boolean;
    method: "POST";
    path: string;
    requiresToken: boolean;
  };
}

interface PausedOperatorView extends OperatorAffordances {
  issueId: IssueId;
  issueIdentifier: IssueIdentifier;
  label: string;
  paused: true;
  controls: OperatorControls;
  issueDetails: IssueDetailsEnvelope;
}
```

Web UI model:

```ts
type WebIssueStatus = "backlog" | "todo" | "progress" | "review" | "done" | "cancelled";
type IssuePriority = 0 | 1 | 2 | 3 | "urgent";

interface ReferenceData {
  labels: Record<string, { name: string; color: string | null }>;
  users: Record<string, { name: string; color: string | null }>;
}

interface IssueModel {
  id: string;
  title: string;
  status: WebIssueStatus;
  priority: IssuePriority;
  labels: string[];
  assignee: string;
  agent: string | null;
  project: string;
  cycle: string;
  activity: Array<{ t: string; verb: string; val: string | null; who: string | null }>;
  pr: string | null;
  ci: string | null;
  workspace: string | null;
  session: string | null;
  desc?: string[];
}

interface DashboardModel {
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

interface HistoryModel {
  sessions: SessionModel[];
  selectedSessionId: string | null;
  transcript: TranscriptMessage[];
}

interface SidebarModel {
  providerGates: ProviderGateModel[];
  runningAgents: RunningAgentModel[];
  reviewIssues: IssueModel[];
  activity: ActivityModel[];
  sessions: WebHistoryModel["sessions"];
  chat: ChatMessage[];
  totals: DashboardTotals;
}
```

Transcript projection:

```ts
type TranscriptMessage =
  | { kind: "system"; ts: string; model: string; cwd: string; workspace: string; session: string; tools: string[]; note: string }
  | { kind: "user"; ts: string; from: string; issue: string; text: string }
  | { kind: "assistant"; ts: string; text: string }
  | { kind: "thinking"; ts: string; text: string }
  | { kind: "tool_call"; ts: string; call_id: string; name: string; status: string; args: Record<string, unknown>; result: string | null; output?: string | null; error?: string | null; truncated?: boolean }
  | { kind: "status"; state: string; ts: string; text: string }
  | { kind: "task"; ts: string; title: string; desc: string }
  | { kind: "request"; ts: string; reason: string; q: string; actions: string[] };
```

Projection relationships:

- Projection state is recomputable from tracker, runtime snapshot, run store, lifecycle store, workspace store, and writeback outbox.
- Projection intentionally redacts unbounded prompt, transcript, writeback body, secrets, and raw payload data.
- Web chat endpoints are currently local projection stubs, not a persisted conversation.

## Web Client State

Source: `web/src/types/symphony.ts`, `web/src/data/*`.

```ts
interface SymphonyDataSource {
  getReferenceData(): Promise<ReferenceData>;
  getDashboard(): Promise<DashboardModel>;
  getIssueBoard(): Promise<IssueBoardModel>;
  getIssueDetail(issueId: string): Promise<IssueDetailModel | null>;
  getHistory(): Promise<HistoryModel>;
  getSessions(): Promise<HistoryModel["sessions"]>;
  getTranscript(sessionId: string): Promise<TranscriptMessage[]>;
  getSidebar(): Promise<SidebarModel>;
  getOrchestratorChat(): Promise<ChatMessage[]>;
  sendOrchestratorMessage(input: string): Promise<ChatMessage[]>;
}

interface DataSourceConfig {
  mode: "mock" | "api";
  apiBaseUrl: string;
}

interface Loadable<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}
```

Web state sources:

- `VITE_SYMPHONY_DATA_SOURCE` chooses `mock` or `api`.
- `VITE_SYMPHONY_API_BASE_URL` selects the API base URL.
- Production builds default to API mode.
- Mock mode uses static mock data in `web/src/data/mockData.ts`.
- React component state and hook `Loadable<T>` values are transient client state only.

## Cursor Extension State

Source: `extension/src/*`.

### Extension Settings

```ts
interface SymphonySettings {
  baseUrl: string;
  token: string;
}
```

Source is VS Code configuration keys:

- `symphony.baseUrl`, default `http://127.0.0.1:7331`
- `symphony.token`, optional mutation token sent as `X-Symphony-Token`

### Connection State

```ts
interface StateSummary {
  runningCount: number | null;
  retryingCount: number | null;
  tokenConfigured: boolean;
  mutationsRequireToken: boolean | null;
}

type ConnectionState =
  | { kind: "connected"; baseUrl: string; generatedAt: string; summary: StateSummary }
  | { kind: "offline"; baseUrl: string; reason: "timeout" | "dns" | "refused" | "network"; detail: string }
  | { kind: "error"; baseUrl: string; reason: "invalid_url" | "http_status" | "parse_failure" | "malformed_body"; detail: string };

type ProbeResult =
  | { kind: "http"; baseUrl: string; status: number; body: unknown }
  | { kind: "invalid_url"; baseUrl: string; detail: string }
  | { kind: "parse_failure"; baseUrl: string; detail: string }
  | { kind: "network"; baseUrl: string; reason: "timeout" | "dns" | "refused" | "network"; detail: string };
```

### Extension Dashboard Model

```ts
interface DashboardState {
  connection: ConnectionState | null;
  activeTab: "issues" | "history";
  board: IssueBoardResponse | null;
  boardLoading: boolean;
  boardError: string | null;
  dashboardGeneration: number;
  activityScopeKey: string | null;
  globalActivity: ActivityItem[];
  globalActivityNextOffset: number | null;
  activityError: string | null;
  selectedIssueKey: string | null;
  issueEpoch: number;
  issueDetail: BoardIssueDetailResponse | null;
  issueActivity: ActivityItem[];
  issueActivityNextOffset: number | null;
  issueError: string | null;
  issueActivityError: string | null;
  selectedRunId: string | null;
  runEpoch: number;
  runDetail: JsonObject | null;
  transcript: TranscriptEvent[];
  transcriptNextOffset: number | null;
  transcriptError: string | null;
  runError: string | null;
  operationMessage: { level: "info" | "error"; message: string } | null;
}
```

Extension provider memory:

```ts
interface SymphonyPanelProviderMemory {
  view: vscode.WebviewView | null;
  panel: vscode.WebviewPanel | null;
  currentState: ConnectionState | null;
  pollTimer: NodeJS.Timeout | null;
  activeProbe: AbortController | null;
  probeGeneration: number;
  dashboardGeneration: number;
  activityScopeKey: string | null;
  globalActivityLoaded: boolean;
  activeIssueKey: string | null;
  activeIssueActivityKey: string | null;
  issueEpoch: number;
  activeRunId: string | null;
  runEpoch: number;
}
```

Extension message protocol:

```ts
type WebviewMessage =
  | { type: "retry" }
  | { type: "refresh" }
  | { type: "openSettings" }
  | { type: "selectIssue"; issueKey: string }
  | { type: "loadMoreActivity"; offset: number }
  | { type: "loadMoreIssueActivity"; issueKey: string; offset: number }
  | { type: "selectRun"; runId: string }
  | { type: "loadMoreTranscript"; runId: string; offset: number }
  | { type: "openWorkspace"; issueKey: string };

type ExtensionMessage =
  | { type: "connectionState"; state: ConnectionState }
  | { type: "activityScopeReset"; scopeKey: string }
  | { type: "dashboardLoading"; dashboardGeneration: number }
  | { type: "dashboardState"; dashboardGeneration: number; board?: IssueBoardResponse | null; activity?: ActivityFeedResponse | null; boardError?: string; activityError?: string; appendActivity?: boolean; reconcileActivityHead?: boolean; offset?: number }
  | { type: "issueDetailState"; issueKey: string; issueEpoch: number; offset: number; detail?: BoardIssueDetailResponse | null; activity?: ActivityFeedResponse | null; error?: string; activityError?: string; appendActivity?: boolean; reconcileActivityHead?: boolean }
  | { type: "runState"; runId: string; runEpoch: number; offset: number; run?: JsonObject | null; transcript?: TranscriptPage | null; error?: string; transcriptError?: string; appendTranscript?: boolean }
  | { type: "operationResult"; level: "info" | "error"; message: string };
```

The extension is a client over the status API. It does not run agents, own workspaces, or mutate durable state except through status API mutation endpoints.

## Logging State

Source: `src/core/logging/StructuredLogger.ts`.

```ts
type LogLevel = "debug" | "info" | "warn" | "error";

interface LogRecord {
  level: LogLevel;
  message: string;
  at?: IsoDateTime;
  [key: string]: unknown;
}
```

Structured logs are written to the configured sink, defaulting to stderr. They are not persisted by Symphony stores unless captured externally. Fields with names matching token, api key, secret, or authorization are redacted.

## Relationship Graph

```text
WORKFLOW.md + .env + process.env
  -> ServiceConfig
  -> CredentialProfileRegistry
  -> Linear/GitHub/Cursor/Hermes clients
  -> Orchestrator

Linear Issue
  -> Issue
  -> WorkspaceRecord
  -> RunRecord
  -> IssueLifecycleRecord
  -> WritebackOperation
  -> IssueDetailsEnvelope
  -> Board/API/Web/Extension projections

WorkspaceRecord
  -> actual workspace path under workspace.root
  -> RunRecord.workspaceKey
  -> IssueLifecycleSummaryPointers
  -> Git worktree repoPath/baseRef/branch

RunRecord
  -> TranscriptEvent[]
  -> CompletionReport / ReviewVerdict / IssueBreakdownPlan / MergeConflictResolutionReport
  -> OperatorApprovalRecord
  -> ProviderLimitSignal / RuntimeProviderGate

IssueLifecycleRecord
  -> summaryPointers to workspace/run/PR/CI
  -> summaryReferences to transcripts and status APIs
  -> completionReports to PR publication and review dispatch
  -> reviewFeedback/reviewEvidence to GitHub review state
  -> reviewVerdicts to pass/fail writeback
  -> mergeGate/mergeConflict/merge to GitHub checks and merge state
  -> handoff memo to worker/reviewer continuation prompts

WritebackOperation
  -> Linear transition/comment/child issue/relation
  -> resultEvidence back into durable operation and sometimes lifecycle created refs

OperatorApprovalRecord
  -> run pending approval fields
  -> transcript approval_request/approval_resolved events
  -> PR publication execution or cancellation/failure

ProviderLimitSignal
  -> RunRecord.providerLimit
  -> RuntimeProviderGate
  -> Orchestrator dispatch blocking

MCP Context Files
  -> activeRunId/sessionId/issue/workspace
  -> MCP tool call
  -> services mutate lifecycle/run/writeback/GitHub/approval/transcript state

Hermes Profile
  -> config.yaml MCP servers
  -> managed auth home
  -> gateway session id
  -> runtime transcript events and provider-limit signals

Cursor SDK Agent
  -> agentId/sessionId/runId
  -> runtime transcript events and SDK run statuses
  -> optional resume via latest worker RunRecord.agentId
```

## Authoritative Versus Derived State

Authoritative:

- `ServiceConfig` for runtime behavior after load.
- Linear for issue fields, workflow state membership, comments, relations, and child issues.
- GitHub for pull request, check, review, comment, and merge state.
- Git repository and worktrees for code state.
- `RunRecord`, `TranscriptEvent`, `WorkspaceRecord`, `IssueLifecycleRecord`, `WritebackOperation`, `OperatorApprovalRecord`, `RuntimeProviderGate`, MCP context files, and Hermes profile/auth/config files for Symphony-owned local state.

Derived:

- `IssueDetailsEnvelope`, board cards, activity feed, web dashboard, web history, web sidebar, extension dashboard sections, and transcript projections.
- `RuntimeSnapshot` is live current-process state plus selected durable pointers.
- `IssueLifecycleSummaryPointers` is denormalized convenience state, but it is persisted and used as a recovery pointer.

Ephemeral:

- Timers, AbortControllers, active harness leases, Cursor SDK agent objects, Hermes gateway clients, store write locks, writeback claim locks, GitHub App token cache, HTTP request state, web React hook state, and extension webview selection/pagination state.

## Minimal State Needed For A Fully Functional Run

At startup:

1. `WORKFLOW.md` and any referenced `.env` variables resolve into `ServiceConfig`.
2. Required credential capabilities resolve for tracker reads, writeback, runtime, GitHub publication/review/merge, and optional open-workspace mutation.
3. `workspace.root` and `workspace.stateDir` are writable.
4. For `git_worktree`, the repository and base ref can be resolved; cache and lock paths are writable.
5. The chosen harness can create a runtime session:
   - Cursor needs SDK credentials/settings/model selection.
   - Hermes needs upstream root, templates, managed auth if provider-owned, profile state, gateway process, and MCP config.
6. MCP context files can be written and subprocess env can expose the correct scoped tool.

For each issue:

1. Linear issue state and labels make it eligible for dispatch.
2. Blocker summary does not mark it blocked.
3. Orchestrator can create or recover a workspace record.
4. A run record and transcript stream can be created.
5. Worker calls the scoped completion, planning, or conflict-resolution MCP tool before handoff.
6. Lifecycle and writeback state advance according to the accepted MCP result.
7. Reviewer and merge paths use lifecycle-bound PR state, review feedback/evidence, verdicts, checks, and merge policy.

For operator/UI visibility:

1. HTTP server has access to orchestrator snapshot and all durable stores.
2. Web or extension clients can fetch board, issue detail, runs, transcript, activity, and workspace records.
3. Mutation endpoints require `server.openWorkspaceToken` only when configured.

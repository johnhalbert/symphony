# Symphony State Ownership And Durability

This document reviews the state inventory in `docs/state-representation.md` and classifies each inspected data model by ownership and recommended persistence boundary.

The operating rule is:

- Symphony owns state it creates to coordinate automation, recover work, enforce idempotency, present operator controls, or connect multiple external facts into one workflow.
- Symphony does not own the canonical issue tracker, pull request, source control, runtime-provider account, or secret state. It stores only pointers, snapshots, evidence, and retry/outbox metadata needed to run safely.
- A database should hold queryable, transactional, recoverable Symphony-owned state. Files should hold workspace material, subprocess handoff material, credentials managed by another runtime, large append artifacts when a database is not the right primary store, and local developer configuration.

## Placement Summary

| Placement | Put here | Do not put here |
| --- | --- | --- |
| Database | Symphony-owned operational records that need recovery, idempotency, UI query, transactional updates, or multi-process coordination | Linear issue truth, GitHub PR truth, git repository contents, Cursor/Hermes account state, raw secrets |
| External systems | Linear issues/comments/states/relations, GitHub PR/check/review/merge state, git remotes and branches, Cursor SDK and Hermes provider state | Symphony retry queues, lifecycle decisions, approval records, outbox state |
| Disk | Worktrees, repo caches, lock files, MCP context files, Hermes profiles/auth/config, diagnostics artifacts, optional transcript payload archives | Transactional queues, approval state, lifecycle phase, idempotency state |
| Memory | Live run objects, timers, abort controllers, leases, process-local caches, loaded config, web UI state | Operator intent that must survive restart, outbox claims, durable lifecycle transitions |

## Recommended Database Core

The following Symphony-owned models should be database-backed if Symphony moves beyond the current single-process file-store implementation:

```ts
interface SymphonyDatabaseCore {
  workspaces: WorkspaceRecord[];
  runs: RunRecord[];
  transcriptEvents: TranscriptEvent[];
  issueLifecycles: IssueLifecycleRecord[];
  writebackOperations: WritebackOperation[];
  operatorApprovals: OperatorApprovalRecord[];
  providerGates: RuntimeProviderGate[];
  issueStates: IssueStateRecord[];
}

interface IssueRuntimeControlEvidence {
  issueId: IssueId;
  issueIdentifier: IssueIdentifier | null;
  eventType:
    | "running_entry_created"
    | "running_entry_released"
    | "claim_acquired"
    | "claim_released"
    | "pause_requested"
    | "pause_cleared"
    | "cancellation_requested"
    | "retry_scheduled"
    | "retry_fired"
    | "retry_cleared";
  recordedAt: IsoDateTime;
  reason: string | null;
}
```

Issue-owned runtime control facts are written through `IssueStateRecord.history` as runtime evidence snapshots. The live sets and timers remain process-local execution aids, but pause, claim, running, cancellation, and retry facts that affect transition decisions must have durable evidence.

For implementation, `IssueLifecycleRecord` can begin as a JSON document column plus indexed scalar columns for `issueId`, `issueIdentifier`, `phase`, last ids, PR number/url, branch, and updated time. The nested arrays can be normalized later when reporting or concurrency pressure requires it.

## Model Classification

| Model or state family | Owner | Current source/location | Recommended home | Durable? | Database? | Why |
| --- | --- | --- | --- | --- | --- | --- |
| `WorkflowDefinition`, raw workflow config, prompt template | Symphony/operator | `WORKFLOW.md`, `WorkflowLoader` | Disk config file | Yes, as config | No | It is deploy-time configuration and should remain human-editable on disk. Loaded config is derived memory. |
| `.env` and environment variables | Operator/environment | Workflow-adjacent `.env`, process env | Environment or secret manager | Yes, outside Symphony DB | No | These may contain secrets and deployment-specific settings. Symphony should resolve them, not own them. |
| `ServiceConfig` | Symphony derived state | `Config.ts` normalization in process | Memory, regenerated from workflow/env | No separate durability | No | It is the parsed runtime view of disk/env config. Persisting it creates stale copies. |
| `CredentialProfileRegistry` and credential bindings | Symphony config, external secret values | Workflow config plus env/profile files | Config on disk; secrets in env/secret store | Bindings yes, secret values outside DB | No for secrets | The profile names are config. API keys, app keys, and provider credentials should not be copied into Symphony tables. |
| GitHub App installation token cache | GitHub-derived runtime cache | `GitHubAppInstallationTokenProvider` memory | Memory | No | No | Tokens are short-lived credentials. Store app config externally, refresh tokens on demand. |
| `Issue`, `IssueStatusView`, Linear workflow states, blockers, labels, assignee, comments, children, relations | Linear | `LinearTrackerClient`, `TrackerClient` | Linear | Yes, externally | No canonical DB copy | Linear is authoritative. Symphony may cache snapshots, but any cache must be invalidatable and non-authoritative. |
| Linear write results and evidence | Shared: Linear result, Symphony operation metadata | `TrackerWriter`, `WritebackOperation.resultEvidence` | Linear plus Symphony writeback DB row | Yes | Yes, for operation row | Linear owns the applied change; Symphony owns idempotency, attempt, and evidence of what it tried. |
| GitHub PR/check/review/comment/merge state | GitHub | `GitHubPullRequestClient`, review and merge services | GitHub | Yes, externally | No canonical DB copy | GitHub remains authoritative. Symphony stores URLs, numbers, SHAs, cursors, and evidence needed to continue. |
| Git repository, branch, commit, worktree contents | Git and filesystem | `GitWorktreeManager`, workspace path, repo cache | Git remote plus disk worktree/cache | Yes, outside DB | No | Source contents belong in git and on disk. DB should store pointers, not file trees. |
| `WorkspaceRecord` | Symphony | `FileRunTranscriptStore`, `workspaces/<workspaceKey>.json` | Database metadata plus disk workspace | Yes | Yes | Symphony owns the mapping from issue to workspace path, repo path, branch, and base ref. It is needed for recovery and UI. |
| Planning workspace marker files | Symphony | `.symphony-planning*.json` inside workspace | Disk marker | Yes while workspace exists | No | These are local checkout markers and travel with the workspace directory. |
| Worktree repo cache paths and branch lock files | Symphony operational filesystem state | `stateDir/repos/*`, `stateDir/locks/*.lock` | Disk | Yes for cache, temporary for locks | No | Cache and lock files protect filesystem/git operations. In a multi-node service, replace locks with DB leases while leaving repo data on disk. |
| `RunRecord` | Symphony | `runs/<runId>/meta.json` | Database row; optional external archive for large prompt fields | Yes | Yes | This is the primary recovery and history record for an automation run. Prompt text may be sensitive or large, so schema should allow redaction/archive. |
| `TranscriptEvent` | Symphony | `runs/<runId>/events.jsonl` | Database event table or append log with DB index | Yes | Yes, at least indexed metadata | It is the durable run event stream used for UI, recall, evidence, and debugging. Large/raw payloads can be archived outside the relational row. |
| `IssueLifecycleRecord` | Symphony | `issue-lifecycle/<issueId>.json` | Database row/document with indexed fields | Yes | Yes | This is Symphony's central per-issue orchestration state: phase, reports, verdicts, evidence, merge state, handoff, summary pointers, and retry counters. |
| `IssueLifecycleSummaryPointers` | Symphony | Nested in lifecycle | Database columns or lifecycle document | Yes | Yes | These are denormalized recovery pointers to workspace, run, PR, CI, and evidence state. |
| `IssueLifecycleSummaryReference` and continuation summaries | Symphony | Nested in lifecycle | Database records or lifecycle document | Yes | Yes | They are durable compact memory for future turns and transcript recall. |
| `IssueBreakdownPlanRecord` and `ProposedIssueRecord` | Symphony | Nested in lifecycle | Database records or lifecycle document | Yes | Yes | Symphony owns generated plans and their application status; created Linear child issues remain external. |
| `IssueCompletionReportRecord` | Symphony | Nested in lifecycle | Database records or lifecycle document | Yes | Yes | It is the worker's durable handoff to PR publication, review, and merge policy. |
| `IssueReviewVerdictRecord` | Symphony | Nested in lifecycle | Database records or lifecycle document | Yes | Yes | It drives pass/fail/blocked transitions and review-loop decisions. |
| `IssueReviewFeedbackRecord` | Symphony | Nested in lifecycle | Database records or lifecycle document | Yes | Yes | It records Symphony's handling of GitHub review feedback and worker follow-up. |
| `PullRequestReviewEvidenceState` | Symphony snapshot of GitHub | Nested in lifecycle | Database records or lifecycle document | Yes | Yes | GitHub owns the comments; Symphony owns the cursoring, stale/fresh classification, and evidence consumed by workers. |
| `IssueMergeGateState`, `IssueMergeMetadata`, `IssueMergeConflictMetadata` | Symphony snapshot/decision state over GitHub | Nested in lifecycle | Database records or lifecycle document | Yes | Yes | GitHub owns checks and merges; Symphony owns its gate decisions, conflict reports, and final automation evidence. |
| `IssueHandoffState` and handoff memo | Symphony | Nested in lifecycle | Database record/document | Yes | Yes | This is compact cross-run memory and should survive restarts. |
| `WritebackOperation` | Symphony | `writeback.sqlite`; legacy `writeback/<safeIdempotencyKey>.json` files are imported and retained | SQLite-backed durable outbox | Yes | Yes | It needs idempotency, due-time queries, retries, dead-lettering, and atomic claim/update behavior. |
| Writeback in-flight claim locks | Symphony runtime coordination | SQLite transaction updates; legacy file store keeps process-local locks for compatibility tests | Database transaction/lease, or memory in single process | While processing only | Yes if multi-process | Single-process memory is sufficient today; DB claims are the right boundary for multiple workers. |
| `OperatorApprovalRecord` | Symphony | `approval-requests/<requestId>.json` | Database table | Yes | Yes | Pending approvals are operator intent/control-plane state and must survive restart. |
| `RuntimeProviderGate` and `ProviderLimitSignal` | Symphony over provider/runtime signals | `provider-gates/<gateId>.json`, run metadata | Database table | Yes | Yes | Gates throttle dispatch across issues and should be queryable, clearable, and restart-safe. |
| `McpToolExposureReport` | Symphony diagnostics | `diagnostics/mcp-tool-exposure/latest.json` | Disk diagnostics; optional database history | Optional | Usually no | It is health/diagnostic evidence, not core workflow state. Keep latest on disk unless historical reporting is required. |
| MCP active context files for completion, review, planning, merge conflict resolution, recall | Symphony subprocess handoff | `*-mcp/<issueId>-<turn>.json` under `stateDir` | Disk, derived from DB/runtime | Yes for active handoff; short retention | No primary DB | The subprocess needs file/env handoff. The durable source should be run/lifecycle/workspace records. |
| MCP tokens and expected scoped tool tokens | Symphony runtime guard | Active context file plus process memory | Memory/disk handoff only | Only for active run | No | These are scoped runtime capabilities and should expire with the run. |
| Cursor SDK agent/session/run objects | Cursor SDK | `CursorHarness` process objects | Cursor SDK/runtime memory | No | No | Symphony stores `agentId`, `sessionId`, run status, and transcript events, not SDK internals. |
| Cursor settings and model selections | Operator/runtime config | Workflow config, Cursor settings, run metadata | Config plus `RunRecord` snapshot | Config yes; snapshot yes | Only run snapshot | Settings remain external/config; Symphony snapshots chosen values for auditability. |
| Hermes profile marker, profile config, MCP server config | Symphony-managed Hermes runtime files | `HermesProfileManager`, `HermesMcpConfig` | Disk under Hermes profile/root | Yes | No | Hermes needs real files. DB should store only profile/session pointers in run metadata if needed. |
| Hermes auth JSON and provider session state | Hermes/provider/operator | `HermesAuthManager`, managed auth home | Disk or provider auth store | Yes, outside Symphony DB | No | Treat as secrets/runtime auth state. Do not copy into Symphony DB. |
| Hermes gateway process/session objects | Hermes runtime | `GatewayFacade`, `HermesHarness` memory | Memory | No | No | Restart creates or reconnects through durable run/profile pointers. |
| `RunningEntry` | Symphony runtime | `Orchestrator.running` | Memory | No as object | No | Live promises, abort controllers, activity timestamps, and harness leases are process-local. Durable facts inside it already flow to run/lifecycle records. |
| `RetryEntry` and retry timers | Symphony runtime plus issue evidence | `Orchestrator.retryAttempts`; runtime evidence in `IssueStateRecord.history` | Timer handles in memory; retry scheduled/fired/cleared facts in issue state | Retry facts yes; timer handles no | Yes for facts, no for handles | The timer object is process-local. The retry decision input and due time are durable issue facts, so restart can rebuild eligibility even though it does not resurrect the original timer. |
| `claimed` and `completed` issue sets | Symphony runtime plus issue evidence | `Orchestrator` memory; claim evidence in `IssueStateRecord.history` | Memory or DB lease in multi-process; claim acquired/released facts in issue state | Claim facts yes; process locks no | Yes for facts, lease table only for multi-process | These prevent duplicate dispatch inside one process. Startup closes stale durable claims when no live process owns them. A multi-process service should replace the set with durable leases/unique constraints. |
| `pausedIssues` | Symphony operator intent plus runtime cache | Runtime evidence in `IssueStateRecord.history`; `Orchestrator.pausedIssues` restored from it | Issue state history, with live set as cache | Yes | Yes | Pause/resume is a user-facing operator control and survives restart through issue-state runtime evidence. |
| Loaded workflow watcher last-good state | Symphony runtime | `WorkflowLoader` memory | Memory | No | No | Last-good config is useful process state; source remains workflow/env on disk. |
| HTTP status/detail/history/activity/dashboard models | Derived read model | `http.ts`, `webProjection.ts`, web types | Derived on request; optional cache | No | No | These merge Linear, live runtime, and local durable state. Store their inputs, not the rendered read model. |
| Web React state and extension panel state | Client runtime | `web/src/*`, `extension/src/*` | Browser/extension memory or local client settings | No for panel state | No | It is UI selection, pagination, filters, and connection state. |
| Extension settings | Operator/client | VS Code/Cursor configuration | Client settings storage | Yes, externally | No | These are client preferences, not orchestration state. |
| Structured logs | Symphony/observability pipeline | `StructuredLogger` output | Log stream/files/observability backend | Yes per retention policy | No core DB | Logs are append-only operational evidence; do not make the app DB the log sink unless deliberately building audit tables. |
| Context-governor accumulator snapshots and decisions | Symphony runtime/prototype | `context-governor/*` memory | Memory, with transcript/lifecycle summaries durable | Only summaries/telemetry | No for accumulator | Current production durability is via summary references and transcript recall telemetry. |

## Named Type Coverage

This table maps the remaining named types from `docs/state-representation.md` to the placement rows above.

| Names | Placement decision |
| --- | --- |
| `IsoDateTime`, `FilePath`, `UrlString`, `IssueId`, `IssueIdentifier`, `RunId`, `WorkspaceKey`, `Sha`, `JsonObject` | Scalar aliases. They are stored wherever their parent record is stored. |
| `LoadedWorkflow`, `WorkflowReloadEvent`, `DotEnv` | Workflow loading state. Source is disk/env; loaded values stay in memory. No DB. |
| `TrackerConfig`, `WorkspaceConfig`, `WorkspaceSourceConfig`, `HookConfig`, `AgentConfig`, `CursorConfig`, `HermesConfig`, `HermesAuthConfig`, `ServerConfig`, `WritebackConfig`, `GitHubConfig`, `GitHubAppConfig`, `ReviewLoopConfig`, `MergePolicyConfig`, `ContinuationContextConfig`, `IssueBreakdownConfig`, `IssueBoardConfig` | Subsections of `ServiceConfig`. Keep source in workflow/env config and loaded form in memory. No DB. |
| `CredentialCapability`, `CredentialRole`, `CredentialLegacyFallbacks`, `StaticTokenCredentialProfileDefinition`, `GitHubAppCredentialProfileDefinition`, `CredentialProfileDefinition`, `ResolvedCredential` | Credential profile configuration and resolved secret handles. Keep config outside DB and secret values in env/secret/auth stores. No DB for secrets. |
| `IssueBlockerRef`, `IssueTrackerMetadata`, `IssueBlockerSummary`, `IssueWorkspaceSummary`, `IssuePullRequestSummary`, `IssueLatestRunSummary`, `IssueDetailsSource`, `IssueDetailsCompleteness`, `IssueStateClassification`, `RunTerminalReason`, `IssueDetailsEnvelope` | Derived issue detail/read-model types. Rebuild from Linear plus local durable Symphony records. No canonical DB row. |
| `Workspace`, `AgentRunRole`, `AgentRunPhase`, `AgentRunKind`, `TokenCounts`, `RuntimeTotals` | Value objects nested in runtime, run, transcript, lifecycle, and read-model state. Store only through their parent records. |
| `TrackerClient`, `LinearIssueNode`, `LinearRelationNode`, `LinearWorkflowTeamStates`, `TrackerTransitionInput`, `TrackerCommentInput`, `TrackerIssueCreateInput`, `TrackerIssueRelationInput`, `TrackerWriteEvidence`, `TrackerWriteResult` | Linear client/input/result shapes. Linear remains authoritative; Symphony persists generated operation metadata and result evidence in `WritebackOperation`. |
| `PullRequestMetadata`, `PullRequestDetails`, `PullRequestCheckResult`, `PullRequestPublicationInput`, `PullRequestPublicationResult`, `GitHubPullRequestReviewEvidence`, `PullRequestReviewEvidenceItem`, `PullRequestMergeInput`, `PullRequestMergeResult` | GitHub client/input/result shapes. GitHub remains authoritative; Symphony persists pointers/evidence in run and lifecycle records. |
| `CachedInstallationToken` | Runtime credential cache. Memory only. No DB. |
| `WorktreeResult`, `PlanningCheckoutResult`, `WorkspaceMetadata`, `PlanningWorkspaceMarker` | Workspace creation result/metadata. Store workspace index in DB, actual checkout and marker files on disk. |
| `RunStatus`, `PersistedRunCancellationSource`, `PersistedCancelFailedSource`, `PersistedCancellationOutcome`, `PersistedSdkRunStatus`, `PersistedSdkRunStatusSource`, `RunActivitySnapshot`, `TranscriptPage` | Run/transcript value types. Persist through `RunRecord` and `TranscriptEvent`; `TranscriptPage` is a read model. |
| `IssueLifecyclePhase`, `CompletionReportPullRequestRef`, `IssueMergeConflictResolutionReportRecord`, `IssueLaneMemo` | Lifecycle value/subrecord types. Persist through `IssueLifecycleRecord`; index high-use fields if reporting needs them. |
| `WritebackStatus`, `WritebackCommon`, `WritebackTransitionOperation`, `WritebackCommentOperation`, `WritebackIssueCreateOperation`, `WritebackIssueRelationOperation` | Writeback outbox variants. Persist as database-backed `WritebackOperation` rows with kind-specific payloads. |
| `OperatorApprovalDecision`, `OperatorApprovalStatus`, `OperatorApprovalAction` | Approval value/subrecord types. Persist through `OperatorApprovalRecord`. |
| `ProviderLimitKind`, `ProviderLimitResumePolicy`, `ProviderLimitScope`, `ProviderLimitWindow`, `ProviderLimitSource` | Provider-gate value/subrecord types. Persist through `RuntimeProviderGate` and selected `RunRecord.providerLimit` snapshots. |
| `McpToolExposureStage`, `McpToolExposureStatus`, `McpToolExposureSpec`, `McpToolExposureServerResult`, `McpToolExposureStageResult` | Diagnostics subrecords. Keep latest report on disk unless historical diagnostics become a product feature. |
| `AgentRunContext`, `AgentEvent`, `CursorHarnessOptions`, `CursorAgentLease`, `CursorLastToolContext`, `CursorHarnessMemory`, `CursorTranscriptPayload`, `HermesHarnessOptions`, `HermesLease`, `HermesHarnessMemory`, `HermesGatewayEnvironment` | Harness runtime state. Keep live objects in memory; persist meaningful events and selected identifiers through run/transcript/lifecycle records. |
| `HermesProfileRequest`, `HermesProfile`, `HermesProfileMarker`, `HermesMcpServerConfig`, `HermesMcpServersConfig`, `HermesAuthPreparation`, `HermesAuthStore` | Hermes runtime profile/auth state. Keep profile/config/auth files on disk under the Hermes-managed locations. No DB for auth contents. |
| `McpSubprocessCommand`, `McpSubprocessServerConfig`, `CompletionReportMcpContextFile`, `MergeConflictResolutionMcpContextFile`, `IssueBreakdownPlanMcpContextFile`, `ReviewVerdictMcpContextFile`, `ReviewFeedbackMcpContextFile`, `TranscriptRecallMcpContextFile`, `CompletionReportActiveContext`, `ReviewVerdictActiveContext`, `ReviewFeedbackActiveContext`, `IssueBreakdownPlanActiveContext`, `MergeConflictResolutionActiveContext` | MCP subprocess and scoped active context state. Keep active handoff files on disk; reconstruct canonical data from DB/durable records. |
| `ContinuationSummarizationInput`, `TranscriptRecallSearchResult`, `TranscriptRecallRunResult`, `TranscriptRecallTelemetryPayload`, `PromptSource`, `KnownPromptTokenCount`, `StreamAccumulatorSnapshot`, `GovernorDecision`, `ContinuationSummary` | Continuation/recall/context-governor state. Persist summary references and recall telemetry through lifecycle/transcript records; keep accumulators and decisions in memory unless productized. |
| `RuntimeSnapshot`, `IssueBoardCard`, `IssueBoardColumn`, `IssueBoardResponse`, `BoardIssueDetailResponse`, `ActivityItem`, `ActivityFeedResponse`, `RunLivenessStatus`, `RunIdleAlertState`, `RunLivenessState`, `RunCancellationSource`, `CancelFailedState`, `RunCancellationState`, `RunActivityState`, `IssueRunMetadata`, `OperatorLivenessStatus`, `OperatorControls`, `OperatorAffordances`, `PausedOperatorView` | HTTP/API read-model state. Derive from Linear, local durable records, and live runtime. No separate DB row. |
| `WebIssueStatus`, `IssuePriority`, `ReferenceData`, `IssueModel`, `DashboardModel`, `HistoryModel`, `SidebarModel`, `TranscriptMessage`, `SymphonyDataSource`, `DataSourceConfig`, `Loadable` | Web client models. Derive client-side from API responses. No server DB. |
| `SymphonySettings`, `StateSummary`, `ConnectionState`, `ProbeResult`, `DashboardState`, `SymphonyPanelProviderMemory`, `WebviewMessage`, `ExtensionMessage` | Extension settings, connection, and webview state. Settings stay in client configuration; other values stay in extension memory or API responses. No DB. |
| `LogLevel`, `LogRecord` | Structured logging. Send to logs/files/observability retention, not the core application DB. |

## Database Versus External Authority

Symphony should not create a canonical `issues` table that competes with Linear. If a database needs issue rows for joins, make them local read caches:

```ts
interface IssueReadCache {
  issueId: IssueId;
  issueIdentifier: IssueIdentifier;
  title: string;
  stateName: string;
  labels: string[];
  assignee: string | null;
  linearUpdatedAt: IsoDateTime | null;
  fetchedAt: IsoDateTime;
  staleAfter: IsoDateTime;
}
```

This cache is disposable. The durable Symphony-owned issue state is `IssueLifecycleRecord`, not the Linear issue itself.

The same applies to GitHub:

```ts
interface PullRequestReadCache {
  prUrl: UrlString;
  prNumber: number;
  headBranch: string;
  headSha: Sha | null;
  ciStatus: string | null;
  reviewState: string | null;
  fetchedAt: IsoDateTime;
}
```

This can speed up dashboards, but GitHub remains authoritative. Durable Symphony records should keep the PR pointers and evidence cursors that explain what automation did.

## What Should Stay On Disk

Some state remains disk-backed even after adding a database:

- Workspaces and worktrees under `workspace.root`.
- Git bare repo caches under `stateDir/repos`.
- Git/worktree lock files for local filesystem operations, unless replaced by DB leases for multi-process coordination.
- MCP context files because subprocesses and MCP servers consume file paths and scoped env.
- Hermes profile config, managed auth files, gateway config, and runtime auth homes.
- Diagnostic snapshots such as MCP exposure reports.
- Optional transcript payload archives when payloads are too large or sensitive for relational rows.

Disk state should have a database pointer when Symphony needs to find it after restart. Disk should not be the only index for core workflow state once a DB exists.

## What Should Stay In Memory

Process memory should hold only reconstructable or short-lived execution state:

- Live `RunningEntry` objects, promises, `AbortController`s, and harness leases.
- Retry `timer` handles and current-process backoff queues when exact retry recovery is not required.
- Loaded `ServiceConfig` and workflow watcher last-good data.
- Token caches and provider SDK clients.
- Store write locks and claim locks in the current single-process file-store implementation.
- HTTP request state, React hook state, extension panel selection state, and polling connection status.

If multiple Symphony processes can dispatch the same issues, these in-memory locks must move to database leases or unique constraints. The live runtime objects still stay in memory.

## Migration Priority

1. Keep `WritebackOperation` database-backed. It is already an outbox and benefits most from transactional claim, due-time indexes, idempotency uniqueness, and dead-letter queries.
2. Move `RunRecord` and `TranscriptEvent` next. They are high-volume history and power API/history/recall behavior.
3. Move `IssueLifecycleRecord` with indexed scalar columns and a JSON document body. This preserves flexibility while making issue state queryable and recoverable.
4. Move `OperatorApprovalRecord` and `RuntimeProviderGate`. These are control-plane records that must survive restarts and be visible to operators.
5. Move `WorkspaceRecord`. Keep the actual worktree on disk; make the database the index.
6. Keep issue-owned runtime control evidence in `IssueStateRecord.history`; add a separate lease table only if Symphony becomes multi-process.
7. Leave config, secrets, worktrees, Hermes profile/auth, and external authority state outside the database.

## Current Gaps

- Retry timers are not restored as timer handles after restart. Retry due time is durable issue state, so the next tick can rebuild eligibility, but exact timer identity remains process-local.
- Writeback claim safety is SQLite-backed for the active outbox. It is appropriate for one process and local concurrent store instances, but a multi-node service would still need a stronger lease/coordination design.
- Run transcript storage is append-only file JSONL. That is simple and useful, but database indexing would make recall, UI pagination, and cross-run querying more reliable.
- `IssueLifecycleRecord` is a single file document. This keeps updates simple, but concurrent service actions would need transaction or version checks in a database-backed store.
- MCP handoff context files are durable files, but their canonical content should be reconstructable from run, lifecycle, workspace, and config state.

# Frontend Projection Performance Inventory

This document inventories the current frontend projection performance problem space after updating local `main` from `origin/main` to commit `b298230`.

The goal is not to solve the issues here. The goal is to make the current architecture, observed symptoms, and planning boundaries explicit enough to decide how a datastore, external-source caching, and push/streaming model should fit together.

## Scope And Evidence

Inspected code:

- Backend projection/cache layer: `src/app/WebProjectionContext.ts`, `src/app/http.ts`, `src/app/webProjection.ts`, `src/app/WebHistoryProjection.ts`, `src/app/WebTranscriptProjection.ts`
- Store invalidation changes: `src/core/persistence/ProjectionRevision.ts`, `src/core/persistence/RunTranscriptStore.ts`, `src/core/persistence/IssueLifecycleStore.ts`, `src/core/writeback/WritebackOutbox.ts`
- Frontend data access and UI: `web/src/App.tsx`, `web/src/app/resourceLoading.ts`, `web/src/data/apiDataSource.ts`, `web/src/hooks/useAsyncResource.ts`, `web/src/hooks/useSymphonyData.ts`, dashboard/issues/history/sidebar components
- Tests describing intended behavior: `tests/status-web-projection-cache.test.ts`, `tests/web-collection-shared-context.test.ts`, `tests/web-projection-context.test.ts`, `web/tests/apiDataSource.test.ts`, `web/tests/appApiModeRendering.test.tsx`

Local observation:

- Vite app: `http://127.0.0.1:5173`
- Status server: `http://127.0.0.1:7331`
- The status server process was already running before this pull, so local endpoint timings are a useful symptom baseline but should not be treated as a clean benchmark of the freshly pulled status-server code until the server is restarted on `b298230`.

Measured local state shape:

```txt
symphony_workspaces/.symphony/runs: 677 run directories
events.jsonl files: 675
total transcript event bytes: 1,305,903,725
largest transcript event file: 569.11 MB
run meta bytes: 2,497,855
issue lifecycle records: 85 files, 5,246,382 bytes
writeback records: 1,733 files, 3,963,952 bytes
workspace records: 55 files, 28,463 bytes
approval records: 4 files, 8,163 bytes
```

Observed local API behavior through both Vite proxy and status server:

| Endpoint | Observed result |
| --- | --- |
| `/api/v1/web/reference-data` | Timed out after 60s |
| `/api/v1/web/dashboard` | Timed out after 60s |
| `/api/v1/web/issues` | Timed out after 60s |
| `/api/v1/web/sidebar` | Timed out after 60s |
| `/api/v1/web/history` | 200 in about 1.6-1.7s, about 3.0 MB response in the already-running server |
| `/api/v1/web/orchestrator-chat` | 200 in about 70-113ms, body `[]` |
| `/api/v1/web/sessions/hermes-754b5592-0537-4bf3-8af6-d0b23c61cdfd/transcript` | 200 in about 4.9s, about 1.4 MB response |

Observed local UI behavior:

- Dashboard initially showed only `Loading...`; after enough time it rendered dashboard data.
- History tab rendered a large session list and then loaded the selected transcript separately.
- The selected transcript eventually expanded the page body to about 797k characters of text, with many tiny assistant/progress-token rows.
- Issues and Sidebars tabs remained in `Loading...` during the observation window because their web endpoints were still waiting.
- Dashboard orchestrator chat showed empty durable history and an explicit read-only notice.

## Current Backend Projection Architecture

The refactor introduced a shared web projection context:

```ts
interface WebProjectionSourceIndex {
  generatedAt: string;
  runtime: WebProjectionRuntimeSourceIndex;
  trackerIssues: WebProjectionIssueSourceIndex;
  runs: WebProjectionRunSourceIndex;
  workspaces: WebProjectionWorkspaceSourceIndex;
  lifecycles: WebProjectionLifecycleSourceIndex;
  writebacks: WebProjectionWritebackSourceIndex;
  transcript: { hydration: "excluded"; eventCountsByRunId: ReadonlyMap<string, number | null> };
  durableSourceRevisions: readonly WebProjectionSourceRevision[];
}
```

The source index is built from:

- `orchestrator.snapshot()`
- `tracker.fetchIssuesByStates(...)`, wrapped by `fetchIssueBoardTrackerProjection(...)`
- `runStore.listRuns()`
- `runStore.listWorkspaces()`
- `lifecycleStore.list()`
- `writebackOutbox.list()`

Transcript hydration is intentionally excluded from the shared source index. Collection routes use run-level transcript event counts and fetch actual transcript events only through transcript-specific endpoints.

The status server holds:

- `completedWebProjectionContext`: one completed in-memory context
- `pendingWebProjectionContexts`: in-flight build coalescing keyed by force-refresh and fingerprint
- `issueBoardTrackerCache`: short-lived Linear issue-board fetch cache keyed by fetched states
- Store revision providers for run/workspace, lifecycle, and writeback writes

The cache fingerprint includes:

- A stable runtime snapshot fingerprint that omits volatile duration fields
- Issue board state and column mappings
- Durable source revisions supplied by revision providers

The context TTL is 5 seconds. Store writes call projection notifiers and dirty the completed context.

## Review Of The In-Memory Cache Work

The refactor improves the immediate frontend burst problem:

- It coalesces concurrent cold loads for collection endpoints into one source scan.
- It gives `/api/v1/web/reference-data`, `/api/v1/web/issues`, `/api/v1/web/dashboard`, `/api/v1/web/history`, and `/api/v1/web/sidebar` a shared source index instead of independently scanning all stores.
- It keeps transcript events out of collection context hydration.
- It adds revision notifications from the file stores so local durable writes invalidate the completed context before TTL expiry.
- It gives refresh query parameters (`refresh=1`, `refresh=true`) explicit cache-bypass semantics.
- It avoids caching tracker errors as successful completed contexts.

The refactor does not eliminate the deeper performance boundary:

- A cold context build still scans file-backed stores across all runs, workspaces, lifecycles, and writebacks.
- A cold context build can still block on Linear issue fetching for the issue-board state set.
- The cache is process-local and disappears on restart.
- The cache is not a durable read model. It cannot answer indexed questions without reconstructing the source index.
- External changes in Linear and GitHub do not push invalidations into the frontend read model. They are observed only when Symphony polls, reconciles, fetches, or is forced to refresh.
- The frontend has no push channel and no recurring client refetch loop.

This makes the cache a reasonable interim patch, but not the target architecture for responsive frontend projections.

## Current Frontend Data Loading Model

API mode chooses a lazy tab-based loading strategy:

```txt
Dashboard tab -> dashboard + orchestrator chat + reference data
Issues tab -> issue board + selected issue detail + reference data
History tab -> history + selected transcript + reference data
Sidebars tab -> sidebar + orchestrator chat + reference data
States tab -> local hard-coded state cards
```

Important behavior:

- `useAsyncResource` loads once when a resource is enabled or its dependencies change.
- There is no frontend polling interval.
- There is no WebSocket, EventSource, or SSE client.
- There is no app-level query cache beyond the data source's short 5s successful GET cache and in-flight dedupe.
- Generic resources keep previous data while reloading, but there is no stale-while-revalidate metadata in the UI.
- `useIssueDetail` and `useTranscript` intentionally bypass the 5s GET success cache.
- Tab switching is currently the main way to trigger additional API loads.

The visible `poll 30s` label describes backend orchestrator polling, not frontend refresh behavior.

## Inventory Of Current Problems

### 1. Initial Dashboard Load Can Be Blocked By One Slow Source

Observed:

- The dashboard initially displayed only `Loading...`.
- `/api/v1/web/dashboard` and `/api/v1/web/reference-data` both exceeded 60s in the running local server.

Likely causes:

- Web dashboard depends on the shared projection context.
- The context build may wait on Linear tracker issue fetch, local store scans, and source indexing.
- The frontend waits for the dashboard resource before rendering dashboard content.

Datastore implication:

- The dashboard should read from a materialized local dashboard/read-model table, not synchronously fetch Linear or scan all durable files.
- External fetch status should be represented as freshness metadata, not a blocking precondition for rendering the last known dashboard.

### 2. Reference Data Is Not Blocking The Shell, But Still Adds Load

Current code:

- API mode starts with fallback reference data and loads reference data lazily.
- `resolveAppResourceLoading(...)` enables reference data on every tab in API mode.

Problem:

- Reference data may still kick off a slow issue-board-backed fetch even when the active tab could render without it.
- If reference fetch hangs, the shell survives, but the server still does unnecessary work.

Datastore implication:

- Reference data should be a small independently cached local projection, such as distinct users and labels from the latest Linear snapshot plus Symphony durable records.
- It should not require a full board build.

### 3. Web Collection Cache Helps Bursts, Not Cold Starts

Current code:

- `StatusServer.completedWebProjectionContext` caches one completed context.
- `pendingWebProjectionContexts` coalesces in-flight builds.

Problem:

- First request after startup or invalidation still pays the full scan/fetch cost.
- Context rebuild still allocates and indexes all source arrays in memory.

Datastore implication:

- Move from "build all source indexes on request" to "maintain read models on write/poll."
- The web request path should query indexed projections by route, page, and cursor.

### 4. File Stores Are Now Acting Like A Database Without Indexes

Current code:

- `listRuns()` reads every `runs/<runId>/meta.json`.
- `listWorkspaces()` reads every workspace file.
- `IssueLifecycleStore.list()` reads every lifecycle JSON file.
- `WritebackOutbox.list()` reads every writeback JSON file.

Observed state:

- 677 run dirs
- 1.3 GB transcript event logs
- 1,733 writeback files

Problem:

- File scans are acceptable for small local state, but not as primary web query paths.
- There are no indexes for "latest sessions", "runs for issue", "activity page", "issues requiring review", "running sessions", or "changed since revision".

Datastore implication:

- Store run summaries, issue lifecycle state, writeback status, and activity items in indexed tables.
- Keep raw workspaces and maybe raw transcript payloads on disk/object storage if needed, but keep query indexes in a datastore.

### 5. Linear Is Still In The Critical Rendering Path

Current code:

- Board state comes from `tracker.fetchIssuesByStates(...)`.
- `issueBoardTrackerCache` caches fetched tracker issues for `staleThresholdMs` (`polling.interval_ms`, currently 30s).

Problem:

- If Linear is slow or unavailable, board/dashboard/sidebar can fail or hang.
- Linear updates have no push invalidation into the web cache.
- The UI lacks explicit source freshness metadata.

Datastore implication:

- Treat Linear as external authority but ingest snapshots into a local `linear_issue_snapshot` or `issue_projection_cache`.
- The UI should render from local snapshots with `fetchedAt`, `linearUpdatedAt`, `staleAfter`, and `sourceStatus`.
- Polling or webhooks should refresh snapshots out of band.

### 6. GitHub State Is Snapshot-Only In The Web Layer

Current code:

- GitHub PR/check/review/merge fields appear through `RunRecord` metadata and `IssueLifecycleRecord` summary/evidence/merge state.
- The web request path does not fetch GitHub live for most projection routes.

Problem:

- This is good for performance, but the UI does not expose whether PR/check/review data is current, stale, or missing.
- GitHub webhooks or reconciliation updates are not represented as frontend event streams.

Datastore implication:

- Keep GitHub as authority.
- Store local PR/check/review snapshots with `fetchedAt`, `headSha`, `etag` or equivalent cursor, and `staleAfter`.
- Update projection rows from reconciliation or webhook ingestion, then push revision events to clients.

### 7. Session History Payloads Are Too Large For A Single Eager List

Current source code:

- Current main has `WEB_HISTORY_DEFAULT_SESSION_LIMIT = 100` and `WEB_HISTORY_DEFAULT_TIMELINE_LIMIT = 250`.
- History uses run summaries and activity, not full transcripts.

Observed already-running server:

- `/api/v1/web/history` returned about 3.0 MB and rendered 672 sessions.

Problem:

- Even with a 100-session default, the model is list-oriented, not cursor-oriented.
- The frontend renders the full returned session list without virtualization.
- The history model includes rich nested `runSession` objects for every row.
- Session history does not update unless the resource is loaded again.

Datastore implication:

- Use a paged session-summary endpoint backed by indexed run/session rows.
- Return a compact row shape first; fetch rich run detail only when selected.
- Add cursor or `updatedSince` support.
- Feed new/updated session rows to the client over a push channel.

### 8. Transcript Loading Is The Biggest Non-SQL Data Problem

Current code:

- `/api/v1/web/sessions/:sessionId/transcript` resolves run id or session id.
- Default transcript load returns the tail `WEB_TRANSCRIPT_DEFAULT_EVENT_LIMIT = 500`.
- Explicit pagination allows up to `WEB_TRANSCRIPT_PAGE_LIMIT = 1000`.

Observed:

- One selected transcript request returned about 1.4 MB in about 4.9s.
- Rendering that transcript expanded page text to about 797k characters.
- Many visible rows are tiny `progress` deltas, often single words or tokens.

Problem:

- Transcript is not naturally a relational document, but the UI needs indexed, incremental, compact views.
- The current projection maps many progress events into many rendered messages.
- The UI has no virtualized transcript list, no "load older" cursor, and no incremental live tail stream.
- Streaming agent updates are persisted as events, but the frontend consumes them as a bulk HTTP response.

Datastore implication:

- Keep raw transcript as append-only event log, but add indexed transcript read models:
  - `transcript_events(run_id, sequence, at, source, event_type, preview, payload_ref)`
  - `transcript_segments(run_id, start_sequence, end_sequence, kind, text_preview, token_count, tool_call_id)`
  - `session_tail(run_id, last_sequence, compact_messages_json, updated_at)`
- Store large/raw payloads in object/disk storage or compressed JSONL, with DB pointers.
- Stream new transcript events or compact segments via SSE/WebSocket.

### 9. Agent Streaming Is Persisted, But Not Delivered Incrementally

Current behavior:

- Harness events append to transcript.
- `RunRecord.transcriptEventCount` tracks count.
- Frontend transcript loads via request/response only.

Problem:

- Running session UI cannot show live deltas without re-fetching.
- There is no `afterSequence` or `sinceRevision` streaming contract in the frontend.
- There is no backpressure/compaction layer between token-level runtime deltas and UI messages.

Datastore and push implication:

- Persist every event durably, but push compact event notifications:
  - `run_started`
  - `run_updated`
  - `transcript_appended`
  - `tool_call_updated`
  - `run_completed`
  - `projection_revision_changed`
- Let clients subscribe by dashboard, issue, run, or global workspace.
- On reconnect, clients resume from last seen revision/sequence.

### 10. Activity Feed Is Derived Per Request

Current code:

- `buildActivityFeed(...)` synthesizes run-start/run-completed activity.
- It can include transcript tails, but web dashboard/history/sidebar call it with `includeTranscriptEvents: false`.
- It also projects writeback operations.

Problem:

- Activity is an obvious materialized read model, but it is currently rebuilt by scanning run/writeback/lifecycle inputs.
- There is no durable activity id/revision stream for frontend incremental updates.

Datastore implication:

- Materialize `activity_events` as an append/update projection sourced from run events, writeback changes, lifecycle changes, and external snapshots.
- Index by `at`, `issue_id`, `run_id`, `kind`, and `source`.
- Serve dashboard/history/sidebar from the same activity table with route-specific limits.

### 11. Issue Detail Does Not Reuse Enough Loaded Data On The Client

Current code:

- Issues tab loads `/api/v1/web/issues`.
- Selected issue detail loads `/api/v1/web/issues/:issueId` with client GET caching disabled.

Problem:

- The board already has a card-level issue projection, but the detail column waits for a separate request before showing most content.
- No local client cache keeps detail by issue id.
- Detail reloads on selection changes.

Datastore implication:

- Backend should serve detail from indexed local issue/run/lifecycle/read models.
- Frontend should immediately render the selected board card and hydrate detail sections progressively.
- Detail response should separate cheap fields from expensive sections like activity, runs, diagnostics, and transcript tail.

### 12. Fake Or Hard-Coded UI Data Remains Mixed With API Data

Examples:

- Dashboard velocity is hard-coded as `3.2 PR/day`.
- ETA text is hard-coded.
- Cycle labels and dates are hard-coded in several dashboard controls.
- Burn-up chart uses mock series shape scaled to real totals.
- Health line says `nominal` and `0 errors in 24h`.
- `StateCardsView` is entirely hard-coded.
- Some empty states still mention mock data, such as issue activity.
- Dashboard `Trigger poll` and `New issue` buttons have no handlers.

Problem:

- It is hard to tell which UI information is authoritative.
- Fake operational indicators can mask backend/source failures.

Datastore implication:

- Each visible operational metric should map to a named projection field with freshness and source.
- Until a field is real, the UI should mark it unavailable rather than rendering plausible fake values.

### 13. Orchestrator Chat Is A Stub

Current code:

- `projectWebOrchestratorChat()` returns `[]`.
- `projectWebOrchestratorChatPost(input)` ignores input and returns `[]`.
- API mode sets dashboard/sidebar chat to read-only.

Observed:

- Chat displays "No durable orchestrator chat messages are available yet."
- It explicitly says sending commands is unsupported.

Problem:

- The UI surface implies command/chat functionality, but there is no command execution or durable chat/session model behind it.

Datastore and push implication:

- Either remove/demote this surface or define a real command model:
  - `operator_conversations`
  - `operator_messages`
  - `operator_commands`
  - `command_status_events`
- Command execution should publish progress/status over the same push channel as other operator events.

### 14. Client Fetches Have No Timeout Policy

Current code:

- `apiDataSource` passes an `AbortSignal` only from component unmount or dependency changes.
- There is no request timeout.

Observed:

- API calls can wait longer than a minute while the UI shows only loading.

Problem:

- The user has no way to distinguish slow source, dead backend, and legitimate loading.

Datastore/push implication:

- Request path should be fast because it reads local projections.
- Client should still have timeout/error states and stale cached data display.
- Server should report source-level stale/error state instead of making the whole view wait.

### 15. Cache And Freshness Metadata Are Not Exposed To The Frontend

Current backend has:

- `WebProjectionCacheMetadata`
- source revisions
- tracker cached flags
- generated timestamps

Problem:

- Web response models mostly strip this away.
- The UI cannot show whether it is using cached tracker data, stale Linear data, local durable data, or live runtime data.
- The UI cannot make efficient conditional requests with ETags or revisions.

Datastore implication:

- Every web model should include a lightweight envelope:

```ts
interface WebProjectionEnvelope<T> {
  data: T;
  projectionRevision: string;
  generatedAt: string;
  sources: Array<{
    source: "runtime" | "linear" | "github" | "runs" | "lifecycles" | "writeback";
    status: "fresh" | "stale" | "unavailable" | "error";
    revision: string | number | null;
    observedAt: string | null;
    staleAfter: string | null;
  }>;
}
```

### 16. No Single Projection Contract Exists Across Web Endpoints

Current endpoints:

- `/api/v1/web/reference-data`
- `/api/v1/web/dashboard`
- `/api/v1/web/sidebar`
- `/api/v1/web/issues`
- `/api/v1/web/issues/:issueId`
- `/api/v1/web/history`
- `/api/v1/web/sessions/:sessionId/transcript`
- `/api/v1/web/orchestrator-chat`

Related legacy/operator endpoints also exist:

- `/api/v1/board`
- `/api/v1/issue-board`
- `/api/v1/board/issues/:issueId`
- `/api/v1/issues/:issueId`
- `/api/v1/issues/:issueId/runs`
- `/api/v1/runs/:runId`
- `/api/v1/runs/:runId/transcript`
- `/api/v1/activity`

Problem:

- Some routes share the new projection context.
- Some routes still build their own operator/details models.
- Some routes are optimized for web, others for operator/status debugging.
- Freshness, pagination, error, and caching semantics are not uniform.

Datastore implication:

- Define a web projection API contract separately from operator/status APIs.
- Keep operator endpoints for detailed debugging, but have the web app use read-model endpoints with consistent envelopes, cursors, and revisions.

## Endpoint Inventory

| UI/API surface | Current primary sources | Current performance risks | Needed datastore or push shape |
| --- | --- | --- | --- |
| Dashboard | Runtime snapshot, issue board, activity, config | Blocks on context build and Linear; activity derived per request; fake metrics mixed in | `dashboard_summary`, `activity_events`, source freshness envelope, push revision events |
| Reference data | Issue board labels/users | Can require board/tracker fetch; not independent | `reference_projection` refreshed from Linear snapshots and local records |
| Issue board | Linear issues, runtime, runs, workspaces, lifecycle, writebacks | Linear in critical path; full source index build; no push | `issue_projection` table keyed by issue id/identifier and lane; external snapshot freshness |
| Issue detail | Board detail, runs, lifecycle, activity, diagnostics, optional transcript | Separate uncached request per selection; mixed cheap/expensive sections | Split detail into core issue, run summary, activity page, diagnostics, transcript tail |
| History | Runs plus activity | Large payload; no cursor in UI; no live updates | Paged `session_summary` query and `activity_events` timeline |
| Transcript | Run meta plus transcript JSONL tail/page | Large payload; token-level events render as many rows; no streaming | Indexed transcript events, compact transcript segments, SSE/WebSocket tail |
| Sidebar | Dashboard, issue board, history, chat | Combines multiple expensive views; can block on same sources | Use already-materialized dashboard/sidebar summary and subscribe to revisions |
| Orchestrator chat | Stub projection | Empty read-only surface; no command model | Real conversation/command tables or remove from API mode |
| Activity feed | Runs, transcript events optionally, writebacks, lifecycle | Rebuilt by scanning inputs; no incremental event stream | Materialized activity log with issue/run/kind indexes |
| Running agents | Runtime snapshot | Live only in process; no push; cache invalidates on stable runtime changes | Runtime event stream plus latest runtime projection row |
| External Linear fields | Linear tracker fetch | Slow/unavailable external dependency; no webhook invalidation | Local Linear snapshot table with stale metadata and background refresh |
| External GitHub fields | Run/lifecycle snapshots of GitHub | No explicit freshness; no direct web invalidation | Local GitHub snapshot/evidence tables updated by reconciliation/webhooks |

## Datastore Boundary For Frontend Performance

The datastore should not become the source of truth for Linear, GitHub, git, Cursor, or Hermes. It should become the source of truth for Symphony's read models and the local cache of external snapshots.

Recommended database-backed read models:

```ts
interface FrontendReadModels {
  projectionRevisions: ProjectionRevisionRow[];
  issueProjections: IssueProjectionRow[];
  dashboardSummaries: DashboardSummaryRow[];
  referenceData: ReferenceDataRow[];
  sessionSummaries: SessionSummaryRow[];
  runSummaries: RunSummaryRow[];
  activityEvents: ActivityEventRow[];
  transcriptEvents: TranscriptEventIndexRow[];
  transcriptSegments: TranscriptSegmentRow[];
  linearIssueSnapshots: LinearIssueSnapshotRow[];
  githubPullRequestSnapshots: GitHubPullRequestSnapshotRow[];
}
```

Representative shapes:

```ts
interface ProjectionRevisionRow {
  scope: "global" | "dashboard" | "issues" | "history" | "run" | "issue";
  key: string;
  revision: number;
  updatedAt: IsoDateTime;
}

interface IssueProjectionRow {
  issueId: IssueId;
  issueIdentifier: IssueIdentifier;
  title: string;
  lane: "backlog" | "todo" | "progress" | "review" | "done" | "canceled";
  stateName: string;
  priority: number | "urgent";
  labelsJson: string;
  assignee: string | null;
  workspaceKey: string | null;
  latestRunId: RunId | null;
  latestRunStatus: string | null;
  prUrl: string | null;
  ciStatus: string | null;
  lifecyclePhase: string | null;
  blockedReason: string | null;
  sourceRevision: string;
  sourceFetchedAt: IsoDateTime | null;
  staleAfter: IsoDateTime | null;
  updatedAt: IsoDateTime;
}

interface SessionSummaryRow {
  runId: RunId;
  sessionId: string | null;
  issueId: IssueId;
  issueIdentifier: IssueIdentifier;
  title: string;
  status: RunStatus;
  role: AgentRunRole;
  runPhase: AgentRunPhase | null;
  startedAt: IsoDateTime;
  updatedAt: IsoDateTime;
  completedAt: IsoDateTime | null;
  transcriptEventCount: number;
  lastEventPreview: string | null;
  model: string | null;
  tokenTotal: number;
}

interface ActivityEventRow {
  id: string;
  at: IsoDateTime;
  kind: "run_started" | "run_completed" | "writeback_operation" | "transcript_event" | "external_snapshot";
  issueId: IssueId | null;
  issueIdentifier: IssueIdentifier | null;
  runId: RunId | null;
  source: string;
  summary: string;
  payloadJson: string;
}

interface TranscriptEventIndexRow {
  runId: RunId;
  sequence: number;
  at: IsoDateTime;
  source: string;
  eventType: string;
  messagePreview: string | null;
  payloadRef: string | null;
  byteOffset: number | null;
}

interface TranscriptSegmentRow {
  runId: RunId;
  segmentId: string;
  startSequence: number;
  endSequence: number;
  kind: "assistant" | "thinking" | "tool_call" | "status" | "user" | "system";
  textPreview: string;
  fullTextRef: string | null;
  toolCallId: string | null;
  updatedAt: IsoDateTime;
}
```

## Push And Streaming Boundary

The frontend needs both fast read models and a push channel. They solve different problems.

Use regular HTTP for:

- Initial dashboard snapshot
- Issue board pages
- Issue detail sections
- History pages
- Transcript page/tail backfill

Use SSE or WebSocket for:

- Projection revision changed
- Running agent status changed
- Run started/completed
- Transcript appended
- Tool call status changed
- Writeback status changed
- Provider gate changed
- External snapshot refreshed

A minimal resumable event shape:

```ts
interface WebProjectionEvent {
  id: string;
  revision: number;
  at: IsoDateTime;
  scope: "global" | "dashboard" | "issue" | "run" | "history";
  key: string | null;
  type:
    | "projection_revision_changed"
    | "run_started"
    | "run_updated"
    | "run_completed"
    | "transcript_appended"
    | "tool_call_updated"
    | "writeback_updated"
    | "external_snapshot_updated"
    | "provider_gate_updated";
  payload: Record<string, unknown>;
}
```

Clients should reconnect with the last event id or revision. The server can answer missed events from `activity_events` or a short retention event log.

## Planning Slices

1. Define web projection envelopes and freshness metadata.
   - Add `generatedAt`, `projectionRevision`, and `sources` to web responses.
   - Give frontend a consistent stale/error display.

2. Materialize local read models.
   - Start with run/session summaries, issue projections, and activity events.
   - Keep raw source records as the write source until the database migration is ready.

3. Decouple Linear from request rendering.
   - Persist Linear issue snapshots out of band.
   - Render last known data immediately.
   - Refresh snapshots by poll/webhook/force-refresh.

4. Redesign transcript delivery.
   - Add cursor/tail endpoints by sequence.
   - Add compact transcript segments.
   - Add UI virtualization and segment grouping.
   - Stream live tail updates.

5. Add a push channel.
   - Start with SSE for projection revision and transcript tail.
   - Upgrade to WebSocket only if bidirectional command/chat traffic requires it.

6. Split heavy web routes.
   - Dashboard should not need issue detail or transcript.
   - Sidebar should not rebuild dashboard plus history plus issue board.
   - Issue detail should hydrate expensive sections separately.

7. Replace fake UI fields with explicit unavailable states.
   - Velocity, ETA, health, cycle dates, state cards, and action buttons need real backing fields or visible disabled/unavailable states.

8. Decide the orchestrator chat product shape.
   - Either remove it from API mode for now or introduce durable conversations and commands.

## Open Questions

- Should Linear snapshots be updated by webhooks, polling only, or both?
- Is SSE sufficient for the first push model, or does orchestrator chat require bidirectional WebSocket from the start?
- How much raw transcript text should remain in JSONL files versus compressed object storage versus database rows?
- What is the expected retention policy for transcript events and compact segments?
- Should dashboard and issue board tolerate stale Linear data indefinitely when Linear is unavailable?
- Which fake dashboard metrics are product requirements versus temporary design placeholders?
- Should history default to "running and recent" rather than newest runs across all statuses?
- Should the frontend use a query library or a small custom cache/revision client?

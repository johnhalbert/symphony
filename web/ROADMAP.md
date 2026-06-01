# Symphony Web App Extraction Roadmap

## Objective

Create a standalone, production-deployable React application under `web/` that
recreates the layouts in `docs/design-system` with the same mock data, while
structuring the data layer so it can later be replaced with real backend API
calls.

This app is not a VS Code or Cursor extension webview. The word "Extension" in
the current design preview is historical and should not drive the architecture.

## Implementation Status

Status: implemented.

The standalone app has been scaffolded and wired with mock data, extracted
components, a data-source interface, an API-source placeholder, adapter tests,
and production build scripts.

## Current Source Artifacts

The design preview is currently composed from these files:

- `docs/design-system/Symphony Extension.html`: browser-only preview shell.
- `docs/design-system/app.jsx`: preview composition, theme frame, and app chrome.
- `docs/design-system/views.jsx`: dashboard, issues, and chat history views.
- `docs/design-system/messages.jsx`: transcript/message renderers.
- `docs/design-system/sidebars.jsx`: narrow sidebar variants and agent state cards.
- `docs/design-system/icons.jsx`: icon helpers and shared visual primitives.
- `docs/design-system/styles.css`: design tokens and view styling.
- `docs/design-system/data.js`: mock Symphony data stored on `window.SYM_DATA`.
- `docs/design-system/design-canvas.jsx`: preview-only artboard tooling.

Only the product UI should be extracted. `design-canvas.jsx`, `DCSection`,
`DCArtboard`, and the artboard gallery in `app.jsx` should not ship in the app.

## Target App Principles

- Keep the app under `web/`.
- Use Vite, React, and TypeScript.
- Preserve the design-system visuals first.
- Use real React modules, imports, exports, props, and state.
- Remove browser globals such as `window.SYM_DATA` and `Object.assign(window, ...)`.
- Keep mock data behind a replaceable data-source interface.
- Avoid API calls in the first working milestone.
- Do not depend on `extension/src/webview`.
- Do not require the backend to mimic the mock data shape exactly. Use adapters.

## Target File Structure

```text
web/
  ROADMAP.md
  package.json
  index.html
  vite.config.ts
  tsconfig.json
  tsconfig.node.json
  src/
    main.tsx
    App.tsx
    app/
      AppChrome.tsx
      ThemeFrame.tsx
      navigation.ts
    components/
      common/
        Avatar.tsx
        Button.tsx
        Icon.tsx
        Label.tsx
        Priority.tsx
        Status.tsx
      dashboard/
        DashboardView.tsx
        AgentRow.tsx
        OrchestratorChat.tsx
        Stats.tsx
      issues/
        IssuesView.tsx
        BacklogColumn.tsx
        DetailColumn.tsx
        IssueCard.tsx
        Swimlanes.tsx
      history/
        ChatHistoryView.tsx
        SessionsList.tsx
        Timeline.tsx
        TranscriptPane.tsx
      messages/
        Message.tsx
        messageFormat.tsx
      sidebar/
        AgentStateCard.tsx
        SidebarChat.tsx
        SidebarHistory.tsx
        SidebarPrimary.tsx
    data/
      dataSource.ts
      mockData.ts
      mockDataSource.ts
      adapters.ts
    types/
      symphony.ts
    styles/
      design-system.css
      app.css
```

## Source-To-Target Mapping

| Current file | Target location | Notes |
| --- | --- | --- |
| `styles.css` | `src/styles/design-system.css` | Move mostly intact first. Later remove preview-only selectors if unused. |
| `data.js` | `src/data/mockData.ts` | Convert `window.SYM_DATA` into typed named exports. |
| `icons.jsx` | `src/components/common/*` | Split `Icon`, `Avatar`, `Label`, `Priority`, `StatusBadge`, and status helpers. |
| `messages.jsx` | `src/components/messages/*` | Convert to typed React components. Replace unsafe HTML formatting with React-node formatting. |
| `views.jsx` | `src/components/dashboard`, `src/components/issues`, `src/components/history` | Extract by product surface. Replace direct data reads with props. |
| `sidebars.jsx` | `src/components/sidebar/*` | Keep as optional narrow views powered by the same data source. |
| `app.jsx` | `src/app/AppChrome.tsx`, `src/app/ThemeFrame.tsx`, `src/App.tsx` | Extract chrome and theme only. Do not port artboard gallery. |
| `design-canvas.jsx` | Not used | Keep only in docs preview. |

## Data Layer Design

Create one interface that the UI depends on:

```ts
export interface SymphonyDataSource {
  getDashboard(): Promise<DashboardModel>;
  getIssueBoard(): Promise<IssueBoardModel>;
  getIssueDetail(issueId: string): Promise<IssueDetailModel | null>;
  getSessions(): Promise<SessionModel[]>;
  getTranscript(sessionId: string): Promise<TranscriptMessage[]>;
  getOrchestratorChat(): Promise<ChatMessage[]>;
  sendOrchestratorMessage(input: string): Promise<ChatMessage[]>;
}
```

Initial implementation:

- `mockData.ts`: exact mock records from `docs/design-system/data.js`.
- `adapters.ts`: converts raw mock records into view models.
- `mockDataSource.ts`: implements `SymphonyDataSource` using mock data and
  small async delays to match real loading behavior.

Future implementation:

- `apiDataSource.ts`: implements the same `SymphonyDataSource` using `fetch`.
- The app switches data sources at composition time, not inside components.

## View Models

Define UI-facing types in `src/types/symphony.ts`.

Minimum first-pass models:

- `DashboardModel`
  - project name, repo label, branch, workflow label, poll label
  - totals
  - running agents
  - activity
  - orchestrator chat
- `IssueBoardModel`
  - backlog issues
  - todo, progress, review lanes
  - selected issue id
- `IssueDetailModel`
  - issue metadata
  - description
  - Symphony/runtime block
  - PR/CI
  - activity
  - comments
- `SessionModel`
  - session id, issue id, title, state, model, timestamps, counts
- `TranscriptMessage`
  - system, user, assistant, thinking, tool_call, status, task, request
- `ChatMessage`
  - speaker, text, suggestions

The model names can evolve, but components should not consume raw backend
responses directly.

## Implementation Roadmap

### Phase 0 - Planning Artifact

Status: complete.

Steps:

1. Create `web/`.
2. Add this roadmap.
3. Confirm `web/` is independent from `extension/src/webview`.

Acceptance criteria:

- `web/ROADMAP.md` exists.
- No extension webview files are changed.

### Phase 1 - Scaffold The Standalone App

Steps:

1. Add `web/package.json` with scripts:
   - `dev`: `vite`
   - `build`: `tsc -b && vite build`
   - `preview`: `vite preview`
   - `typecheck`: `tsc -b --pretty false`
2. Add dependencies:
   - `@vitejs/plugin-react`
   - `vite`
   - `typescript`
   - `react`
   - `react-dom`
   - `@types/react`
   - `@types/react-dom`
3. Add Vite and TypeScript config files.
4. Add `index.html`.
5. Add `src/main.tsx`.
6. Add `src/App.tsx` rendering a minimal placeholder inside the future app shell.
7. Import `src/styles/design-system.css` and `src/styles/app.css`.

Acceptance criteria:

- `npm install --prefix web` succeeds.
- `npm run dev --prefix web` starts the app.
- `npm run build --prefix web` succeeds.

### Phase 2 - Move CSS And Shared Primitives

Steps:

1. Copy `docs/design-system/styles.css` to `web/src/styles/design-system.css`.
2. Create `src/styles/app.css` for app-only layout rules.
3. Convert `icons.jsx` into typed modules:
   - `Icon.tsx`
   - `Avatar.tsx`
   - `Label.tsx`
   - `Priority.tsx`
   - `Status.tsx`
4. Remove all `Object.assign(window, ...)` patterns.
5. Replace global `Icon.foo()` access with imported `Icon`.
6. Keep class names unchanged where possible.

Acceptance criteria:

- Shared primitives render in a simple smoke view.
- No runtime globals are needed for shared primitives.
- Typecheck passes.

### Phase 3 - Mock Data And Data Source

Steps:

1. Convert `data.js` to `src/data/mockData.ts`.
2. Export the same mock data as typed constants:
   - `issues`
   - `users`
   - `labels`
   - `runningAgents`
   - `activity`
   - `sessions`
   - `transcript`
   - `dashChat`
3. Create `src/types/symphony.ts`.
4. Create `src/data/dataSource.ts` with `SymphonyDataSource`.
5. Create `src/data/adapters.ts`.
6. Create `src/data/mockDataSource.ts`.
7. Add a small hook layer:
   - `useDashboard()`
   - `useIssueBoard()`
   - `useSessions()`
   - `useTranscript(sessionId)`

Acceptance criteria:

- Mock data no longer lives on `window`.
- Components can request data through hooks or a provider.
- Replacing `mockDataSource` later does not require component rewrites.

### Phase 4 - App Shell And Navigation

Steps:

1. Extract `ThemeFrame` from `app.jsx`.
2. Extract `Chrome` as `AppChrome`.
3. Make tabs stateful:
   - dashboard
   - issues
   - history
4. Render one active view at a time.
5. Keep the amber theme as default.
6. Add a small internal development switch for alternate design variants if useful.

Acceptance criteria:

- Dashboard, Issues, and History tabs switch without reload.
- The shell visually matches the preview chrome.
- The app does not render the design canvas or artboard labels.

### Phase 5 - Dashboard Extraction

Steps:

1. Move `DashboardView` into `src/components/dashboard/DashboardView.tsx`.
2. Move helper components:
   - `StatsRow`
   - `StatsGridDense`
   - `BurndownPanel`
   - `BurndownCommandCenter`
   - `AgentRow`
   - `OrchestratorChat`
3. Replace `D()` and `window.SYM_DATA` with `DashboardModel` props.
4. Make dashboard variant explicit:
   - `cards`
   - `command-center`
   - `grid`
5. Wire chat input to `mockDataSource.sendOrchestratorMessage`.
6. Make suggestion buttons invoke mock actions.

Acceptance criteria:

- Dashboard renders with the same mock content as the preview.
- Running agent count and activity list come from the mock data source.
- Chat input can append a mock user message and mock response.

### Phase 6 - Issues View Extraction

Steps:

1. Move `IssuesView` into `src/components/issues/IssuesView.tsx`.
2. Move helper components:
   - `BacklogColumn`
   - `Swimlanes`
   - `IssueCard`
   - `DetailColumn`
3. Replace hard-coded `selectedId = 'SYM-12'` with React state.
4. Clicking issue cards updates the selected issue.
5. Make detail panel open/closed stateful.
6. Keep `balanced` and `detail-heavy` variants available.
7. Keep filters/search presentational first, then add mock filtering.

Acceptance criteria:

- Issues view renders backlog, lanes, and detail from mock data.
- Selecting a different issue updates card selection and detail content.
- Detail open/closed mode works.

### Phase 7 - History And Transcript Extraction

Steps:

1. Move `ChatHistoryView` into `src/components/history/ChatHistoryView.tsx`.
2. Move helper components:
   - `SessionsList`
   - `TranscriptPane`
   - `Timeline`
3. Move message renderers into `src/components/messages`.
4. Replace hard-coded selected session with React state.
5. Replace hard-coded expanded tool calls with local state.
6. Convert inline code formatting from `dangerouslySetInnerHTML` to safe React nodes.

Acceptance criteria:

- History list and transcript match the preview.
- Selecting sessions updates the transcript.
- Tool call expansion state is interactive.
- No user/API text is injected with unsafe HTML.

### Phase 8 - Sidebar Variants

Steps:

1. Extract `SidebarPrimary`, `SidebarChat`, `SidebarHistory`, and `AgentStateCard`.
2. Keep them in `src/components/sidebar`.
3. Add an app-level view mode or route for sidebar previews.
4. Reuse the same data source as the full app.

Acceptance criteria:

- Sidebar status, chat, and history variants render at narrow widths.
- The sidebar views do not duplicate mock data access logic.

### Phase 9 - Production Hardening

Steps:

1. Add loading and error states around data-source calls.
2. Add empty states for lists.
3. Add basic keyboard accessibility for tabs and selectable rows.
4. Ensure text truncation and wrapping match the design intent.
5. Remove unused preview-only CSS selectors if they create conflicts.
6. Consider self-hosting fonts for deployment stability.
7. Add unit tests for adapters and core data hooks.

Acceptance criteria:

- `npm run build --prefix web` passes.
- `npm run typecheck --prefix web` passes.
- Main views handle loading, empty, and error states.
- The app can be deployed as static assets.

### Phase 10 - API Swap

Steps:

1. Add `src/data/apiDataSource.ts`.
2. Configure build and runtime API mode with Vite/build-time environment variables:
   - Production builds default Vite `base` to `/web/`, so emitted JS and CSS asset URLs resolve when the built app is mounted at `/web/`; `SYMPHONY_WEB_BASE_PATH` (or `VITE_SYMPHONY_WEB_BASE_PATH`) can override that build-time base path, and dev-server mode keeps `/` by default.
   - Unset, empty, invalid, local-dev, and production data-source configuration defaults the React app to same-origin API mode (`/api/v1/web/*`). No runtime config file is required for the default production mount or the Vite dev proxy path.
   - `VITE_SYMPHONY_DATA_SOURCE=api` remains the explicit same-origin API mode selector, and `VITE_SYMPHONY_API_BASE_URL` keeps supporting absolute or relative API base URLs.
   - `VITE_SYMPHONY_DATA_SOURCE=mock`, `demo`, or `local` is the only non-production path that activates legacy design mock data. Production builds stay API-backed and do not bundle the hard-coded dashboard fixtures.
   - The data-source factory lazy-loads the mock source for explicit non-production demo runs so the default API path does not statically import hard-coded dashboard fixtures.
   - `SYMPHONY_WEB_API_PROXY_TARGET` or `SYMPHONY_API_PROXY_TARGET` can override the Vite dev proxy target; otherwise `/api` proxies to the default Symphony status server at `http://127.0.0.1:7331`.
   - These settings only configure the static web artifact and Vite dev/preview behavior; backend `StatusServer` static file serving remains outside this phase.
3. Implement the same `SymphonyDataSource` interface.
4. Keep legacy mock data available only as explicit local/demo/test fixtures.
5. Add adapters from API responses into view models.
6. Add request cancellation where long-running or rapidly changing selections matter.
7. Add auth/token handling only after the backend contract is clear.

Current dashboard mock-data inventory:

- `web/src/data/mockData.ts`: hard-coded legacy design fixture records (`issues`, `users`, `labels`, `runningAgents`, `activity`, `sessions`, `transcript`, `dashChat`); use only for explicit mock/demo/local mode and tests.
- `web/src/data/mockDataSource.ts`: adapts the fixture records to `SymphonyDataSource`; reached only through the lazy explicit non-production mock-mode factory.
- `web/src/data/adapters.ts`: contains legacy design-preview dashboard labels, cycle metadata, velocity/ETA/burn-up series, health/error status, timeline records, and issue-board cycle defaults for explicit mock/demo/test adapters. It must remain reachable only from `mockDataSource` or tests, not the default API data source.
- `web/src/data/dataSourceConfig.ts`: owns API-vs-mock selection. The default and invalid-fallback path is API-backed; mock data is never the implicit dashboard source.
- `web/src/components/dashboard/Stats.tsx`: renders real `DashboardModel` totals but treats optional velocity, ETA, burn-up, cycle, projection, review queue, health, and error metrics as unavailable until supplied by `dashboard.metrics`; it no longer embeds the legacy mock values in the component path.
- `web/src/components/dashboard/DashboardView.tsx`: renders the dashboard variant switcher, cycle filter, and dense-grid velocity panel from optional `dashboard.metrics` fields, with neutral unavailable placeholders in API/default mode when those fields are absent.
- `web/src/app/AppChrome.tsx`: renders connection and error status from explicit props sourced from optional dashboard health metrics; the API/default fallback is neutral (`connection unavailable`, `errors unavailable`) rather than hard-coded Linear/zero-error status.
- `web/src/app/navigation.ts` and `web/src/app/AppChrome.tsx`: tab definitions are label-only; navigation badges are optional props derived from loaded issue/history data and are omitted while those resources are unavailable, so production chrome no longer ships fixed issue/live counts.
- `web/src/App.tsx` `StateCardsView`: state cards render from loaded dashboard running-agent and history session models, or a neutral `Run state data unavailable.` empty state; legacy `SYM-*`/`codex-*` state-card examples remain only in explicit mock data/adapters and tests.
- `web/src/components/sidebar/SidebarChat.tsx`: compact chat subtitle is sourced from the active sidebar running-agent model when available, or a neutral `agent context unavailable`/read-only API label; it no longer embeds a fixed agent/cycle fallback.
- `web/src/components/dashboard/OrchestratorChat.tsx`: command input copy uses neutral examples and the agent footer is sourced from the active dashboard running-agent model or a neutral unavailable label, avoiding fixed mock issue/agent ids in runtime UI.
- `web/src/components/issues/DetailColumn.tsx`: real issue-detail empty activity renders neutral `No issue activity available.` copy and must not mention mock data outside the explicit fixture records.
- `web/tests/adapters.test.ts`, `web/tests/dashboardPresentation.test.tsx`, `web/tests/appApiModeRendering.test.tsx`, `web/tests/issuesComponents.test.tsx`, `web/tests/orchestratorChatIntegration.test.tsx`, and `web/tests/referenceData.test.ts`: retain fixture imports or rendered fixture expectations as test/design-preview coverage, not runtime defaults, and cover API/default unavailable placeholders.

Acceptance criteria:

- Switching between explicit mock/demo and API data is a composition/config change.
- Component props and view modules do not change.
- Mock mode remains available for deliberate design review and frontend fixture tests, but real/API-backed data is the default dashboard source.
- Unsupported dashboard/chrome metrics, navigation counts, state-card data, chat subtitles, and command placeholders in API/default mode render from active models when available or neutral unavailable placeholders until the backend supplies real fields; real issue-detail empty states avoid mock-data copy.

## Suggested Milestones

### Milestone 1 - Bootable Mock App

Phases: 1 through 4.

Deliverable:

- Standalone Vite app renders the Symphony shell with tab navigation.

### Milestone 2 - Dashboard Parity

Phase: 5.

Deliverable:

- Dashboard matches the preview using mock data.

### Milestone 3 - Issues Parity

Phase: 6.

Deliverable:

- Issues board, swimlanes, and detail panel match the preview and support selection.

### Milestone 4 - History Parity

Phase: 7.

Deliverable:

- Session list, transcript, timeline, and message types match the preview.

### Milestone 5 - Narrow Views

Phase: 8.

Deliverable:

- Sidebar status, chat, history, and agent state cards are available as React views.

### Milestone 6 - Ready For Backend Wiring

Phases: 9 and 10 preparation.

Deliverable:

- Data-source boundary is stable.
- Mock mode is complete.
- API mode can be implemented without rewriting components.

## Validation Checklist

Run these checks before considering the extraction complete:

1. `npm run typecheck --prefix web`
2. `npm run build --prefix web`
3. Start `npm run dev --prefix web`.
4. Compare these views against `docs/design-system/Symphony Extension.html`:
   - dashboard cards
   - dashboard command-center
   - dashboard dense grid
   - issues balanced
   - issues detail-heavy
   - issues detail closed
   - history list
   - history timeline
   - history focused
   - sidebar primary
   - sidebar chat
   - sidebar history
5. Check desktop at `1400x900`.
6. Check narrow sidebar at about `380x780`.
7. Check text overflow in tabs, cards, issue titles, transcript rows, and buttons.

## Explicit Non-Goals For The First Build

- No extension webview integration.
- No backend API calls.
- No authentication.
- No persistence beyond mock/local React state.
- No redesign beyond what is required to make the extracted app functional.
- No broad refactor of the backend repo.

## First Implementation Slice

The best first slice is:

1. Scaffold Vite/React/TypeScript in `web/`.
2. Port CSS and shared primitives.
3. Convert mock data to typed modules.
4. Build `AppChrome` with stateful tabs.
5. Render `DashboardView` from `mockDataSource`.

That creates a working app quickly and proves the extraction pattern before
moving the larger Issues and History surfaces.

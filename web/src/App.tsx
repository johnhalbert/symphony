import { useState } from "react";
import { AppChrome } from "./app/AppChrome";
import { resolveAppResourceLoading } from "./app/resourceLoading";
import { ThemeFrame } from "./app/ThemeFrame";
import { AgentStateCard } from "./components/sidebar/AgentStateCard";
import { SidebarViews } from "./components/sidebar/SidebarViews";
import { ChatHistoryView } from "./components/history/ChatHistoryView";
import { DashboardView } from "./components/dashboard/DashboardView";
import { IssuesView } from "./components/issues/IssuesView";
import { DataSourceProvider, defaultDataSourceConfig } from "./data/dataSourceContext";
import { fallbackReferenceData, ReferenceDataProvider } from "./data/referenceDataContext";
import {
  useDashboard,
  useHistory,
  useIssueBoard,
  useOrchestratorChat,
  useReferenceData as useReferenceResource,
  useSidebar,
} from "./hooks/useSymphonyData";
import { combineLiveResourceTokens, useLiveResourceState, type LiveResourceKey, type LiveResourceTokenMap } from "./hooks/useLiveResource";
import type {
  AppTab,
  DashboardModel,
  DashboardVariant,
  HistoryModel,
  HistoryVariant,
  IssueBoardModel,
  IssuesVariant,
  Loadable,
  ReferenceData,
  RunningAgentModel,
  RunState,
  SessionModel,
  SidebarModel,
  SidebarVariant,
} from "./types/symphony";

export function App() {
  return (
    <DataSourceProvider>
      <AppDataBoundary />
    </DataSourceProvider>
  );
}

function AppDataBoundary() {
  const apiMode = defaultDataSourceConfig.mode === "api";
  if (apiMode) {
    return <AppShell initialReferenceData={fallbackReferenceData} lazyReferenceData />;
  }
  return <MockReferenceDataBoundary />;
}

function MockReferenceDataBoundary() {
  const reference = useReferenceResource();
  if (reference.loading && !reference.data) {
    return (
      <ThemeFrame>
        <div className="view-loading">Loading Symphony design data...</div>
      </ThemeFrame>
    );
  }
  if (reference.error || !reference.data) {
    return (
      <ThemeFrame>
        <div className="view-error">{reference.error || "Reference data unavailable."}</div>
      </ThemeFrame>
    );
  }
  return <AppShell initialReferenceData={reference.data} />;
}

function referenceStatusLabel(reference: { data: ReferenceData | null; loading: boolean; error: string | null }) {
  if (reference.error && !reference.data) return "reference unavailable";
  if (reference.loading && !reference.data) return "reference loading";
  return null;
}

function liveRefreshToken(tokens: LiveResourceTokenMap, keys: readonly LiveResourceKey[]) {
  return combineLiveResourceTokens(tokens, keys);
}

function resourceOptions(enabled: boolean, refreshToken: number) {
  return refreshToken > 0 ? { enabled, refreshToken } : { enabled };
}

function resolveSidebarAgentUsageLabel(sidebar: Loadable<SidebarModel>): string {
  if (!sidebar.data) {
    if (sidebar.loading) return "agent usage loading";
    return "agent usage unavailable";
  }

  const count = sidebar.data.runningAgents.length;
  const agentNoun = count === 1 ? "agent" : "agents";
  const runningLabel = `${count} running ${agentNoun}`;
  if (sidebar.error) return `previous sidebar projection · ${runningLabel}`;
  if (sidebar.loading) return `refreshing sidebar projection · ${runningLabel}`;
  return `sidebar projection · ${runningLabel}`;
}

function fallbackDashboardAgentUsageLabel(dashboard: DashboardModel): string {
  const label = dashboard.agentUsageLabel?.trim();
  if (label) return label;
  const count = dashboard.runningAgents.length;
  const agentNoun = count === 1 ? "agent" : "agents";
  return `${count} running ${agentNoun}`;
}

function resolveDashboardAgentChrome(dashboard: Loadable<DashboardModel>): { runningCount: number; agentUsageLabel: string } | null {
  if (!dashboard.data) return null;

  const usageLabel = fallbackDashboardAgentUsageLabel(dashboard.data);
  const sourceStatus = dashboard.data.source?.status;
  const isFreshCurrentData = sourceStatus === "fresh" && !dashboard.loading && !dashboard.error;
  if (isFreshCurrentData) {
    return { runningCount: dashboard.data.runningAgents.length, agentUsageLabel: usageLabel };
  }

  if (dashboard.error) return { runningCount: 0, agentUsageLabel: `previous dashboard projection · ${usageLabel}` };
  if (dashboard.loading) return { runningCount: 0, agentUsageLabel: `refreshing dashboard projection · ${usageLabel}` };
  if (!sourceStatus) return { runningCount: 0, agentUsageLabel: `dashboard projection freshness unknown · ${usageLabel}` };
  return { runningCount: 0, agentUsageLabel: `${sourceStatus} dashboard projection · ${usageLabel}` };
}

function AppShell({
  initialReferenceData,
  lazyReferenceData = false,
}: {
  initialReferenceData: ReferenceData;
  lazyReferenceData?: boolean;
}) {
  const [activeTab, setActiveTab] = useState<AppTab>("dashboard");
  const [dashboardVariant, setDashboardVariant] = useState<DashboardVariant>("cards");
  const [issuesVariant, setIssuesVariant] = useState<IssuesVariant>("balanced");
  const [historyVariant, setHistoryVariant] = useState<HistoryVariant>("list");
  const [sidebarVariant, setSidebarVariant] = useState<SidebarVariant>("primary");
  const apiMode = defaultDataSourceConfig.mode === "api";
  const resourceLoading = resolveAppResourceLoading(activeTab, apiMode);
  const liveState = useLiveResourceState(apiMode);
  const liveTokens = liveState.tokens;
  const referenceRefreshToken = liveRefreshToken(liveTokens, ["referenceData"]);
  const dashboardRefreshToken = liveRefreshToken(liveTokens, ["dashboard"]);
  const issueBoardRefreshToken = liveRefreshToken(liveTokens, ["issueBoard"]);
  const issueDetailRefreshToken = liveRefreshToken(liveTokens, ["issueDetail", "issueBoard"]);
  const historyRefreshToken = liveRefreshToken(liveTokens, ["history"]);
  const transcriptRefreshToken = liveRefreshToken(liveTokens, ["sessionTranscript", "history"]);
  const sidebarRefreshToken = liveRefreshToken(liveTokens, ["sidebar"]);
  const orchestratorChatRefreshToken = liveRefreshToken(liveTokens, ["orchestratorChat"]);

  const reference = useReferenceResource(resourceOptions(lazyReferenceData && resourceLoading.referenceData, referenceRefreshToken));
  const referenceData = lazyReferenceData ? (reference.data ?? initialReferenceData) : initialReferenceData;
  const referenceLabel = lazyReferenceData ? referenceStatusLabel(reference) : null;
  const dashboard = useDashboard(resourceOptions(resourceLoading.dashboard, dashboardRefreshToken));
  const issueBoard = useIssueBoard(resourceOptions(resourceLoading.issueBoard, issueBoardRefreshToken));
  const history = useHistory(resourceOptions(resourceLoading.history, historyRefreshToken));
  const sidebarEnabled = resourceLoading.sidebar || (apiMode && Boolean(dashboard.error));
  const sidebar = useSidebar(resourceOptions(sidebarEnabled, sidebarRefreshToken));
  const orchestratorChat = useOrchestratorChat(resourceOptions(resourceLoading.orchestratorChat, orchestratorChatRefreshToken));
  const dashboardChrome = dashboard.data;
  const dashboardAgentChrome = resolveDashboardAgentChrome(dashboard);
  const statusbarRunningCount = dashboardAgentChrome?.runningCount ?? 0;
  const agentUsageLabel = dashboardAgentChrome?.agentUsageLabel ?? resolveSidebarAgentUsageLabel(sidebar);
  const tabBadges = resolveTabBadges(issueBoard.data, history.data);

  return (
    <ReferenceDataProvider value={referenceData}>
      <ThemeFrame>
        <AppChrome
          activeTab={activeTab}
          onTabChange={setActiveTab}
          tabBadges={tabBadges}
          runningCount={statusbarRunningCount}
          repoLabel={dashboardChrome?.repoLabel ?? "repository unavailable"}
          branch={dashboardChrome?.branch ?? ""}
          pollLabel={dashboardChrome?.pollLabel ?? "poll unavailable"}
          agentUsageLabel={agentUsageLabel}
          connectionStatusLabel={apiMode ? liveState.realtimeStatus.label : (dashboardChrome?.metrics?.health?.connectionLabel ?? undefined)}
          errorStatusLabel={dashboardChrome?.metrics?.health?.errorSummaryLabel ?? undefined}
          dataSourceLabel={[
            `api source · ${defaultDataSourceConfig.mode}`,
            apiMode ? referenceLabel : null,
          ]
            .filter(Boolean)
            .join(" · ")}
          rightSlot={
            <ViewControls
              activeTab={activeTab}
              dashboardVariant={dashboardVariant}
              historyVariant={historyVariant}
              issuesVariant={issuesVariant}
              sidebarVariant={sidebarVariant}
              onDashboardVariant={setDashboardVariant}
              onHistoryVariant={setHistoryVariant}
              onIssuesVariant={setIssuesVariant}
              onSidebarVariant={setSidebarVariant}
            />
          }
        >
          {activeTab === "dashboard"
            ? renderLoadable(dashboard, "dashboard", (data) => (
                <DashboardView
                  dashboard={data}
                  variant={dashboardVariant}
                  useModelBurnupTotals={apiMode}
                  orchestratorChat={orchestratorChat.data ?? []}
                  orchestratorChatError={orchestratorChat.error}
                  orchestratorChatLoading={orchestratorChat.loading}
                />
              ))
            : null}
          {activeTab === "issues"
            ? renderLoadable(issueBoard, "issue board", (data) => <IssuesView board={data} variant={issuesVariant} refreshToken={issueDetailRefreshToken} />)
            : null}
          {activeTab === "history"
            ? renderLoadable(history, "history", (data) => <ChatHistoryView history={data} variant={historyVariant} refreshToken={transcriptRefreshToken} />)
            : null}
          {activeTab === "sidebar"
            ? renderLoadable(sidebar, "sidebar", (data, state) => (
                <SidebarViews
                  sidebar={data}
                  sidebarError={state.error}
                  sidebarLoading={state.loading}
                  variant={sidebarVariant}
                  orchestratorChat={orchestratorChat.data ?? []}
                  orchestratorChatError={orchestratorChat.error}
                  orchestratorChatLoading={orchestratorChat.loading}
                />
              ))
            : null}
          {activeTab === "states" ? (
            <StateCardsView
              runningAgents={dashboard.data?.runningAgents ?? []}
              sessions={history.data?.sessions ?? []}
              loading={dashboard.loading || history.loading}
              error={dashboard.error ?? history.error}
            />
          ) : null}
        </AppChrome>
      </ThemeFrame>
    </ReferenceDataProvider>
  );
}

function renderLoadable<T>(
  resource: Loadable<T>,
  name: string,
  render: (data: T, resource: Loadable<T>) => JSX.Element,
) {
  if (resource.data !== null) {
    const content = render(resource.data, resource);
    if (resource.error) {
      return (
        <>
          <ResourceStatusBanner
            severity="error"
            title={`Could not refresh ${name}`}
            detail={`${resource.error} Showing previous ${name} data.`}
          />
          {content}
        </>
      );
    }
    if (resource.loading) {
      return (
        <>
          <ResourceStatusBanner severity="info" title={`Refreshing ${name}`} detail={`Showing previous ${name} data while Symphony reloads.`} />
          {content}
        </>
      );
    }
    return content;
  }
  if (resource.loading) return <div className="view-loading">Loading {name}...</div>;
  if (resource.error) return <div className="view-error">Could not load {name}: {resource.error}</div>;
  return <div className="view-empty">No {name} data.</div>;
}

function ResourceStatusBanner({
  severity,
  title,
  detail,
}: {
  severity: "info" | "error";
  title: string;
  detail: string;
}) {
  return (
    <div className="resource-status-banner" data-severity={severity}>
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

function ViewControls({
  activeTab,
  dashboardVariant,
  issuesVariant,
  historyVariant,
  sidebarVariant,
  onDashboardVariant,
  onIssuesVariant,
  onHistoryVariant,
  onSidebarVariant,
}: {
  activeTab: AppTab;
  dashboardVariant: DashboardVariant;
  issuesVariant: IssuesVariant;
  historyVariant: HistoryVariant;
  sidebarVariant: SidebarVariant;
  onDashboardVariant: (variant: DashboardVariant) => void;
  onIssuesVariant: (variant: IssuesVariant) => void;
  onHistoryVariant: (variant: HistoryVariant) => void;
  onSidebarVariant: (variant: SidebarVariant) => void;
}) {
  if (activeTab === "dashboard") {
    return (
      <label className="dev-switcher">
        <select value={dashboardVariant} onChange={(event) => onDashboardVariant(event.target.value as DashboardVariant)} aria-label="Dashboard variant">
          <option value="cards">Cards</option>
          <option value="command-center">Command</option>
          <option value="grid">Dense grid</option>
        </select>
      </label>
    );
  }
  if (activeTab === "issues") {
    return (
      <label className="dev-switcher">
        <select value={issuesVariant} onChange={(event) => onIssuesVariant(event.target.value as IssuesVariant)} aria-label="Issues variant">
          <option value="balanced">Balanced</option>
          <option value="detail-heavy">Detail heavy</option>
        </select>
      </label>
    );
  }
  if (activeTab === "history") {
    return (
      <label className="dev-switcher">
        <select value={historyVariant} onChange={(event) => onHistoryVariant(event.target.value as HistoryVariant)} aria-label="History variant">
          <option value="list">List</option>
          <option value="timeline">Timeline</option>
          <option value="focused">Focused</option>
        </select>
      </label>
    );
  }
  if (activeTab === "sidebar") {
    return (
      <label className="dev-switcher">
        <select value={sidebarVariant} onChange={(event) => onSidebarVariant(event.target.value as SidebarVariant)} aria-label="Sidebar variant">
          <option value="primary">Status</option>
          <option value="chat">Chat</option>
          <option value="history">History</option>
        </select>
      </label>
    );
  }
  return null;
}

function resolveTabBadges(issueBoard: IssueBoardModel | null, history: HistoryModel | null): Partial<Record<AppTab, string>> {
  const runningSessions = history?.sessions.filter((session) => session.state === "running").length ?? null;
  return {
    issues: issueBoard ? String(issueBoard.issues.length) : undefined,
    history: history ? (runningSessions ? `${runningSessions} running` : String(history.sessions.length)) : undefined,
  };
}

interface StateCardData {
  state: RunState;
  issue: string;
  title: string;
  agent: string | null;
  step: string;
  duration: string;
}

function textOrUnavailable(value: string | null | undefined, fallback: string) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function sessionStateToRunState(state: SessionModel["state"]): RunState {
  if (state === "finished" || state === "error" || state === "cancelled" || state === "queued" || state === "running") {
    return state;
  }
  return "running";
}

function createStateCards(runningAgents: RunningAgentModel[], sessions: SessionModel[]): StateCardData[] {
  const cards: StateCardData[] = runningAgents.map((agent) => ({
    state: agent.state,
    issue: textOrUnavailable(agent.issue, "Issue unavailable"),
    title: textOrUnavailable(agent.title, "Run title unavailable"),
    agent: textOrUnavailable(agent.id, "").trim() || null,
    step: textOrUnavailable(agent.step, "Step unavailable"),
    duration: textOrUnavailable(agent.duration, "duration unavailable"),
  }));

  const seenRunKeys = new Set(cards.map((card) => `${card.issue}:${card.agent ?? ""}`));
  for (const session of sessions) {
    if (cards.length >= 8) break;
    const agent = session.runSession?.agentId ?? null;
    const issue = textOrUnavailable(session.issue, "Issue unavailable");
    const runKey = `${issue}:${agent ?? ""}`;
    if (seenRunKeys.has(runKey)) continue;
    seenRunKeys.add(runKey);
    cards.push({
      state: sessionStateToRunState(session.state),
      issue,
      title: textOrUnavailable(session.title, "Run title unavailable"),
      agent,
      step: textOrUnavailable(session.lastEvent, "Status unavailable"),
      duration: textOrUnavailable(session.updatedAt, "updated time unavailable"),
    });
  }

  return cards.slice(0, 8);
}

export function StateCardsView({
  runningAgents = [],
  sessions = [],
  loading = false,
  error = null,
}: {
  runningAgents?: RunningAgentModel[];
  sessions?: SessionModel[];
  loading?: boolean;
  error?: string | null;
}) {
  const cards = createStateCards(runningAgents, sessions);

  if (loading && cards.length === 0) return <div className="view-loading">Loading run state data...</div>;
  if (error && cards.length === 0) return <div className="view-error">Run state data unavailable: {error}</div>;
  if (cards.length === 0) return <div className="view-empty">Run state data unavailable.</div>;

  return (
    <div className="state-card-grid">
      {cards.map((card) => (
        <div className="state-card-cell" key={`${card.state}-${card.issue}-${card.agent ?? card.title}`}>
          <AgentStateCard {...card} />
        </div>
      ))}
    </div>
  );
}

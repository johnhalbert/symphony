import { useEffect, useState } from "react";
import { AppChrome } from "./app/AppChrome";
import { resolveAppResourceLoading } from "./app/resourceLoading";
import { ThemeFrame } from "./app/ThemeFrame";
import { AgentStateCard } from "./components/sidebar/AgentStateCard";
import { SidebarViews } from "./components/sidebar/SidebarViews";
import { ChatHistoryView } from "./components/history/ChatHistoryView";
import { DashboardView } from "./components/dashboard/DashboardView";
import { IssuesView } from "./components/issues/IssuesView";
import { DataSourceProvider, defaultDataSourceConfig, useDataSource } from "./data/dataSourceContext";
import { fallbackReferenceData, ReferenceDataProvider } from "./data/referenceDataContext";
import {
  useDashboard,
  useHistory,
  useIssueBoard,
  useOrchestratorChat,
  useReferenceData as useReferenceResource,
  useSidebar,
} from "./hooks/useSymphonyData";
import type {
  AppTab,
  DashboardVariant,
  HistoryModel,
  HistoryVariant,
  IssueBoardModel,
  IssuesVariant,
  ReferenceData,
  RunningAgentModel,
  RunState,
  SessionModel,
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

function useProjectionRefreshToken(enabled: boolean): number {
  const dataSource = useDataSource();
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    if (!enabled || !dataSource.subscribeToProjectionChanges) return undefined;
    return dataSource.subscribeToProjectionChanges((event) => {
      if (event.type !== "projection_revision") return;
      dataSource.invalidateCachedReads?.();
      setRefreshToken((current) => current + 1);
    });
  }, [dataSource, enabled]);

  return refreshToken;
}

function resourceOptions(enabled: boolean, refreshToken: number) {
  return refreshToken > 0 ? { enabled, refreshToken } : { enabled };
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
  const projectionRefreshToken = useProjectionRefreshToken(apiMode);

  const reference = useReferenceResource(resourceOptions(lazyReferenceData && resourceLoading.referenceData, projectionRefreshToken));
  const referenceData = lazyReferenceData ? (reference.data ?? initialReferenceData) : initialReferenceData;
  const referenceLabel = lazyReferenceData ? referenceStatusLabel(reference) : null;
  const dashboard = useDashboard(resourceOptions(resourceLoading.dashboard, projectionRefreshToken));
  const issueBoard = useIssueBoard(resourceOptions(resourceLoading.issueBoard, projectionRefreshToken));
  const history = useHistory(resourceOptions(resourceLoading.history, projectionRefreshToken));
  const sidebarEnabled = resourceLoading.sidebar || (apiMode && Boolean(dashboard.error));
  const sidebar = useSidebar(resourceOptions(sidebarEnabled, projectionRefreshToken));
  const orchestratorChat = useOrchestratorChat(resourceOptions(resourceLoading.orchestratorChat, projectionRefreshToken));
  const dashboardChrome = dashboard.data;
  const runningCount = dashboardChrome?.runningAgents.length ?? sidebar.data?.runningAgents.length ?? 0;
  const tabBadges = resolveTabBadges(issueBoard.data, history.data);

  return (
    <ReferenceDataProvider value={referenceData}>
      <ThemeFrame>
        <AppChrome
          activeTab={activeTab}
          onTabChange={setActiveTab}
          tabBadges={tabBadges}
          runningCount={runningCount}
          repoLabel={dashboardChrome?.repoLabel ?? "repository unavailable"}
          branch={dashboardChrome?.branch ?? ""}
          pollLabel={dashboardChrome?.pollLabel ?? "poll unavailable"}
          agentUsageLabel={dashboardChrome?.agentUsageLabel ?? `${runningCount} agents running`}
          connectionStatusLabel={dashboardChrome?.metrics?.health?.connectionLabel ?? undefined}
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
            ? renderLoadable(dashboard, (data) => (
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
            ? renderLoadable(issueBoard, (data) => <IssuesView board={data} variant={issuesVariant} refreshToken={projectionRefreshToken} />)
            : null}
          {activeTab === "history"
            ? renderLoadable(history, (data) => <ChatHistoryView history={data} variant={historyVariant} refreshToken={projectionRefreshToken} />)
            : null}
          {activeTab === "sidebar"
            ? renderLoadable(sidebar, (data) => (
                <SidebarViews
                  sidebar={data}
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
  resource: { data: T | null; loading: boolean; error: string | null },
  render: (data: T) => JSX.Element,
) {
  if (resource.loading && !resource.data) return <div className="view-loading">Loading...</div>;
  if (resource.error) return <div className="view-error">{resource.error}</div>;
  if (!resource.data) return <div className="view-empty">No data.</div>;
  return render(resource.data);
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
  const liveSessions = history?.sessions.filter((session) => session.state === "running").length ?? null;
  return {
    issues: issueBoard ? String(issueBoard.issues.length) : undefined,
    history: history ? (liveSessions ? `${liveSessions} live` : String(history.sessions.length)) : undefined,
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

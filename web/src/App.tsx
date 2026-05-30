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
import type {
  AppTab,
  DashboardVariant,
  HistoryVariant,
  IssuesVariant,
  ReferenceData,
  RunState,
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

  const reference = useReferenceResource({ enabled: lazyReferenceData && resourceLoading.referenceData });
  const referenceData = lazyReferenceData ? (reference.data ?? initialReferenceData) : initialReferenceData;
  const referenceLabel = lazyReferenceData ? referenceStatusLabel(reference) : null;
  const dashboard = useDashboard({ enabled: resourceLoading.dashboard });
  const issueBoard = useIssueBoard({ enabled: resourceLoading.issueBoard });
  const history = useHistory({ enabled: resourceLoading.history });
  const sidebarEnabled = resourceLoading.sidebar || (apiMode && Boolean(dashboard.error));
  const sidebar = useSidebar({ enabled: sidebarEnabled });
  const orchestratorChat = useOrchestratorChat({ enabled: resourceLoading.orchestratorChat });
  const dashboardChrome = dashboard.data;
  const runningCount = dashboardChrome?.runningAgents.length ?? sidebar.data?.runningAgents.length ?? 0;

  return (
    <ReferenceDataProvider value={referenceData}>
      <ThemeFrame>
        <AppChrome
          activeTab={activeTab}
          onTabChange={setActiveTab}
          runningCount={apiMode ? runningCount : undefined}
          repoLabel={apiMode ? (dashboardChrome?.repoLabel ?? "") : undefined}
          branch={apiMode ? (dashboardChrome?.branch ?? "") : undefined}
          pollLabel={apiMode ? (dashboardChrome?.pollLabel ?? "poll pending") : undefined}
          agentUsageLabel={apiMode ? (dashboardChrome?.agentUsageLabel ?? `${runningCount} agents running`) : undefined}
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
                  orchestratorChatReadOnly={apiMode}
                  orchestratorChat={orchestratorChat.data ?? []}
                  orchestratorChatError={orchestratorChat.error}
                  orchestratorChatLoading={orchestratorChat.loading}
                />
              ))
            : null}
          {activeTab === "issues" ? renderLoadable(issueBoard, (data) => <IssuesView board={data} variant={issuesVariant} />) : null}
          {activeTab === "history" ? renderLoadable(history, (data) => <ChatHistoryView history={data} variant={historyVariant} />) : null}
          {activeTab === "sidebar"
            ? renderLoadable(sidebar, (data) => (
                <SidebarViews
                  sidebar={data}
                  variant={sidebarVariant}
                  orchestratorChatReadOnly={apiMode}
                  orchestratorChat={orchestratorChat.data ?? []}
                  orchestratorChatError={orchestratorChat.error}
                  orchestratorChatLoading={orchestratorChat.loading}
                />
              ))
            : null}
          {activeTab === "states" ? <StateCardsView /> : null}
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

function StateCardsView() {
  const cards: Array<{ state: RunState; issue: string; title: string; agent: string | null; step: string; duration: string }> = [
    { state: "creating", issue: "SYM-42", title: "Stream agent app-server updates to orchestrator", agent: "codex-08", step: "Acquiring workspace lock", duration: "3s" },
    { state: "running", issue: "SYM-12", title: "Add exponential backoff to retry queue with jitter", agent: "codex-04", step: "Running mix test", duration: "4m 41s" },
    { state: "queued", issue: "SYM-50", title: "Document trust & safety posture", agent: null, step: "Waiting for concurrency slot", duration: "--" },
    { state: "review", issue: "SYM-15", title: "Workspace cleanup hook for terminal-state issues", agent: "codex-02", step: "Agent review queue · PR #1248", duration: "24m" },
    { state: "finished", issue: "SYM-52", title: "Linear GraphQL query isolation + tests", agent: "codex-06", step: "Merged · #1190", duration: "1h 14m" },
    { state: "error", issue: "SYM-09", title: "Initial Linear tracker integration", agent: "codex-11", step: "rate-limit cascade - 429", duration: "18s" },
    { state: "cancelled", issue: "SYM-07", title: "WORKFLOW.md loader", agent: "codex-10", step: "Cancelled by operator", duration: "9s" },
    { state: "expired", issue: "SYM-03", title: "Workspace prune (terminal)", agent: "codex--", step: "Idle 30m - released", duration: "30m" },
  ];

  return (
    <div className="state-card-grid">
      {cards.map((card) => (
        <div className="state-card-cell" key={card.state}>
          <AgentStateCard {...card} />
        </div>
      ))}
    </div>
  );
}

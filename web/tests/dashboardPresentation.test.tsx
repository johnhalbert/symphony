import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppChrome } from "../src/app/AppChrome";
import { DashboardView } from "../src/components/dashboard/DashboardView";
import type { SymphonyDataSource } from "../src/data/dataSource";
import { DataSourceProvider } from "../src/data/dataSourceContext";
import { toDashboardModel } from "../src/data/adapters";
import { mockSymphonyData } from "../src/data/mockData";
import type { DashboardModel, DashboardVariant } from "../src/types/symphony";

const rawMockData = mockSymphonyData as unknown as Parameters<typeof toDashboardModel>[0];

const apiDashboard: DashboardModel = {
  projectName: "Symphony API",
  repoLabel: "api/repo",
  branch: "api-branch",
  workflowLabel: "WORKFLOW.api@api-branch",
  pollLabel: "poll 5s",
  agentUsageLabel: "2/9 agents",
  concurrencyCap: 9,
  providerGates: [],
  runningAgents: [
    {
      id: "run-api-1",
      issue: "API-1",
      title: "Implement API dashboard",
      state: "running",
      step: "Rendering dashboard model",
      duration: "5m",
      tokens: "1.2k",
    },
    {
      id: "run-api-2",
      issue: "API-2",
      title: "Verify live activity",
      state: "running",
      step: "Checking API activity feed",
      duration: "2m",
      tokens: "900",
    },
  ],
  activity: [
    {
      t: "just now",
      who: "api-worker",
      verb: "started",
      id: "API-1",
      extra: "from API activity",
    },
  ],
  chat: [{ who: "agent", text: "API hello", suggestions: ["API suggestion"] }],
  totals: {
    backlog: 1,
    todo: 2,
    progress: 3,
    review: 5,
    done: 8,
    cancelled: 13,
    open: 11,
    all: 32,
    completeness: 73,
  },
};

function dataSourceForDashboard(dashboard: DashboardModel): SymphonyDataSource {
  return {
    async getReferenceData() {
      return { users: {}, labels: {} };
    },
    async getDashboard() {
      return dashboard;
    },
    async getIssueBoard() {
      return { issues: [], backlog: [], lanes: { todo: [], progress: [], review: [] }, cycleLabel: "", cycleDateRange: "", selectedIssueId: "" };
    },
    async getIssueDetail() {
      return null;
    },
    async getHistory() {
      return { sessions: [], transcriptBySession: {}, timeline: [], defaultSessionId: "" };
    },
    async getSessions() {
      return [];
    },
    async getTranscript() {
      return [];
    },
    async getSidebar() {
      return { providerGates: [], runningAgents: dashboard.runningAgents, reviewIssues: [], activity: dashboard.activity, sessions: [], chat: dashboard.chat, totals: dashboard.totals };
    },
    async getOrchestratorChat() {
      return dashboard.chat;
    },
    async sendOrchestratorMessage(input: string) {
      return [...dashboard.chat, { who: "user", text: input }];
    },
  };
}

function renderDashboard(dashboard: DashboardModel, variant: DashboardVariant = "cards") {
  return renderToStaticMarkup(
    <DataSourceProvider value={dataSourceForDashboard(dashboard)}>
      <DashboardView dashboard={dashboard} variant={variant} />
    </DataSourceProvider>,
  );
}

describe("dashboard API presentation", () => {
  it("renders the API DashboardModel totals, agents, activity, and chrome labels without mock substitutions", () => {
    const markup = renderDashboard(apiDashboard);

    expect(markup).toContain("api/repo");
    expect(markup).toContain("api-branch");
    expect(markup).toContain("WORKFLOW.api@api-branch");
    expect(markup).toContain("poll 5s");
    expect(markup).toContain("2/9 agents");
    expect(markup).toContain("concurrency cap 9");
    expect(markup).toContain('<div class="stat__value">73<span class="suffix">%</span></div>');
    expect(markup).toContain('<div class="stat__value">11</div>');
    expect(markup).toContain("API-1");
    expect(markup).toContain("Implement API dashboard");
    expect(markup).toContain("Rendering dashboard model");
    expect(markup).toContain("api-worker");
    expect(markup).toContain("from API activity");
    expect(markup).toContain("API hello");
    expect(markup).toContain("API suggestion");

    expect(markup).not.toContain("openai/symphony");
    expect(markup).not.toContain("WORKFLOW.md@main");
    expect(markup).not.toContain("poll 22s");
    expect(markup).not.toContain("4/6 agents");
    expect(markup).not.toContain("Restart SYM-42");
  });

  it("uses an empty API dashboard chat array as empty initial chat instead of mock suggestions", () => {
    const markup = renderDashboard({ ...apiDashboard, chat: [] });

    expect(markup).toContain("Symphony orchestrator");
    expect(markup).not.toContain("API hello");
    expect(markup).not.toContain("API suggestion");
    expect(markup).not.toContain("Restart SYM-42");
    expect(markup).not.toContain("Show SYM-42 transcript");
  });

  it("wires command-center agent and poll text to the API dashboard fields", () => {
    const markup = renderDashboard(apiDashboard, "command-center");

    expect(markup).toContain("./symphony status --branch api-branch");
    expect(markup).toContain("2/9 agents");
    expect(markup).toContain("2 running / 9 cap");
    expect(markup).toContain("poll 5s");
    expect(markup).not.toContain("4 running");
    expect(markup).not.toContain("last poll 8s ago");
  });

  it("preserves mock dashboard data when rendering the mock model", () => {
    const mockDashboard = toDashboardModel(rawMockData);
    const markup = renderDashboard(mockDashboard);

    expect(markup).toContain("openai/symphony");
    expect(markup).toContain("main");
    expect(markup).toContain("WORKFLOW.md@main");
    expect(markup).toContain("poll 22s");
    expect(markup).toContain("4/6 agents");
    expect(markup).toContain("Restart SYM-42");
  });

  it("lets app chrome consume dashboard labels in API mode instead of fixed mock copy", () => {
    const markup = renderToStaticMarkup(
      <AppChrome
        activeTab="dashboard"
        onTabChange={() => undefined}
        runningCount={apiDashboard.runningAgents.length}
        repoLabel={apiDashboard.repoLabel}
        branch={apiDashboard.branch}
        pollLabel={apiDashboard.pollLabel}
        agentUsageLabel={apiDashboard.agentUsageLabel}
        dataSourceLabel="api source · api"
      >
        <div>Dashboard body</div>
      </AppChrome>,
    );

    expect(markup).toContain("api-branch");
    expect(markup).toContain("2/9 agents");
    expect(markup).toContain("api/repo@api-branch");
    expect(markup).toContain("poll 5s");
    expect(markup).toContain("api source · api");
    expect(markup).not.toContain("openai/symphony@main");
    expect(markup).not.toContain("poll 22s");
    expect(markup).not.toContain("api source · mock");
  });
});

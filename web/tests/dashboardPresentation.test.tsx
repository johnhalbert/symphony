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

function renderDashboard(dashboard: DashboardModel, variant: DashboardVariant = "cards", useModelBurnupTotals = true) {
  return renderToStaticMarkup(
    <DataSourceProvider value={dataSourceForDashboard(dashboard)}>
      <DashboardView dashboard={dashboard} variant={variant} useModelBurnupTotals={useModelBurnupTotals} />
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
    expect(markup).toContain("8/32 done · schedule unavailable");
    expect(markup).toContain("Burn-up unavailable");
    expect(markup).toContain("Trend unavailable");
    expect(markup).toContain("Velocity trend unavailable");
    expect(markup).toContain("ETA unavailable");
    expect(markup).toMatch(/API-1/);
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
    expect(markup).not.toMatch(/target\s+\d/);
    expect(markup).not.toMatch(/completed\s+\d/);
    expect(markup).not.toContain("Cycle 14");
    expect(markup).not.toContain("3.2");
    expect(markup).not.toContain("PR/day");
    expect(markup).not.toContain("7 days left");
    expect(markup).not.toContain("projected 96%");
    expect(markup).not.toContain("nominal");
    expect(markup).not.toContain("0 errors");
  });

  it("uses an empty API dashboard chat array as empty initial chat instead of mock suggestions", () => {
    const markup = renderDashboard({ ...apiDashboard, chat: [] });

    expect(markup).toContain("Symphony orchestrator");
    expect(markup).not.toContain("API hello");
    expect(markup).not.toContain("API suggestion");
    expect(markup).not.toContain("Restart SYM-42");
    expect(markup).not.toContain("Show SYM-42 transcript");
  });

  it("renders unavailable API grid velocity and burn-up placeholders without mock chart labels", () => {
    const markup = renderDashboard(apiDashboard, "grid");

    expect(markup).toContain("8/32 done · schedule unavailable");
    expect(markup).toContain("Burn-up unavailable");
    expect(markup).toContain("cycle unavailable");
    expect(markup).toContain("Velocity · metric unavailable");
    expect(markup).toContain("Velocity metric unavailable.");
    expect(markup).not.toMatch(/target\s+\d/);
    expect(markup).not.toMatch(/completed\s+\d/);
    expect(markup).not.toContain("Cycle 14");
    expect(markup).not.toContain("Velocity · last 14 days");
    expect(markup).not.toContain("+24");
  });

  it("wires command-center agent and poll text to the API dashboard fields", () => {
    const markup = renderDashboard(apiDashboard, "command-center");

    expect(markup).toContain("./symphony status --branch api-branch");
    expect(markup).toContain("2/9 agents");
    expect(markup).toContain("2 running / 9 cap");
    expect(markup).toContain("poll 5s");
    expect(markup).toContain("cycle unavailable · schedule unavailable ·");
    expect(markup).toContain("projection <span style=\"color:var(--text-3)\">unavailable</span>");
    expect(markup).toContain("backend metric unavailable");
    expect(markup).toContain("5 issues in review · queue age unavailable");
    expect(markup).toContain("status unavailable");
    expect(markup).toContain("errors unavailable");
    expect(markup).not.toContain("4 running");
    expect(markup).not.toContain("last poll 8s ago");
    expect(markup).not.toContain("3.2 PR/day");
    expect(markup).not.toContain("oldest 24m");
    expect(markup).not.toContain("nominal");
    expect(markup).not.toContain("0 errors");
  });

  it("preserves mock dashboard data when rendering the mock model", () => {
    const mockDashboard = toDashboardModel(rawMockData);
    const markup = renderDashboard(mockDashboard, "cards", false);

    expect(markup).toContain("openai/symphony");
    expect(markup).toContain("main");
    expect(markup).toContain("WORKFLOW.md@main");
    expect(markup).toContain("poll 22s");
    expect(markup).toContain("4/6 agents");
    expect(markup).toContain("Restart SYM-42");
    expect(markup).toContain("Cycle 14");
    expect(markup).toContain("3.2");
    expect(markup).toContain("PR/day");
    expect(markup).toContain("ETA: cycle ends ~3 days early");
    expect(markup).toMatch(/target\s+17/);
    expect(markup).toMatch(/completed\s+13/);
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
        tabBadges={{ issues: String(apiDashboard.totals.all), history: "2 live" }}
      >
        <div>Dashboard body</div>
      </AppChrome>,
    );

    expect(markup).toContain("api-branch");
    expect(markup).toContain("2/9 agents");
    expect(markup).toContain("api/repo@api-branch");
    expect(markup).toContain("poll 5s");
    expect(markup).toContain("api source · api");
    expect(markup).toContain('<span class="badge">32</span>');
    expect(markup).toContain('<span class="badge">2 live</span>');
    expect(markup).toContain("connection unavailable");
    expect(markup).toContain("errors unavailable");
    expect(markup).not.toContain("openai/symphony@main");
    expect(markup).not.toContain("poll 22s");
    expect(markup).not.toContain("api source · mock");
    expect(markup).not.toContain('badge">11</span>');
    expect(markup).not.toContain('badge">4 live</span>');
    expect(markup).not.toContain("linear · connected");
    expect(markup).not.toContain("0 errors · 24h");
  });
});

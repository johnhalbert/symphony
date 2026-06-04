import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppChrome } from "../src/app/AppChrome";
import { DashboardView } from "../src/components/dashboard/DashboardView";
import type { SymphonyDataSource } from "../src/data/dataSource";
import { orchestratorChatModelFromMessages } from "../src/data/orchestratorChat";
import { createTranscriptWindowResponse } from "../src/data/transcriptWindow";
import { DataSourceProvider } from "../src/data/dataSourceContext";
import { toDashboardModel } from "../src/data/adapters";
import { mockSymphonyData } from "../src/data/mockData";
import type { DashboardModel, DashboardTotals, DashboardVariant, ProviderGateModel } from "../src/types/symphony";

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
  source: {
    status: "stale",
    label: "tracker stale · 4 cached issues",
    detail: "Using a cached tracker source while refresh catches up; 2 runs · 3 lifecycle records · 1 activity entries · 0 writeback operations.",
    generatedAt: "2026-05-29T20:05:00.000Z",
    trackerFetchedAt: "2026-05-29T20:04:00.000Z",
    issueCount: 4,
    runCount: 2,
    lifecycleCount: 3,
    activityCount: 1,
    writebackCount: 0,
    cached: true,
    error: null,
  },
};

const zeroTotals: DashboardTotals = {
  backlog: 0,
  todo: 0,
  progress: 0,
  review: 0,
  done: 0,
  cancelled: 0,
  open: 0,
  all: 0,
  completeness: 0,
};

const writebackFailureGate: ProviderGateModel = {
  id: "writeback-failure",
  provider: "tracker writeback",
  kind: "failure",
  message: "writeback failed: tracker rejected the transition",
  resumeAt: null,
  resumePolicy: "manual",
  sourceIssue: "API-5",
  sourceRunId: "run-writeback-failure",
  affected: "API-5",
};

function dashboardFixture(overrides: Partial<DashboardModel> = {}): DashboardModel {
  return {
    ...apiDashboard,
    ...overrides,
    providerGates: overrides.providerGates ?? apiDashboard.providerGates,
    runningAgents: overrides.runningAgents ?? apiDashboard.runningAgents,
    activity: overrides.activity ?? apiDashboard.activity,
    chat: overrides.chat ?? apiDashboard.chat,
    totals: overrides.totals ?? apiDashboard.totals,
    source: overrides.source ?? apiDashboard.source,
  };
}

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
      return createTranscriptWindowResponse([]);
    },
    async getSidebar() {
      return { providerGates: [], runningAgents: dashboard.runningAgents, reviewIssues: [], activity: dashboard.activity, sessions: [], chat: dashboard.chat, totals: dashboard.totals };
    },
    async getOrchestratorChat() {
      return orchestratorChatModelFromMessages(dashboard.chat);
    },
    async sendOrchestratorMessage(input: string) {
      return [...dashboard.chat, { who: "user", text: input }];
    },
    async triggerPoll() {
      return { queued: true, coalesced: false, requested_at: "2026-06-03T13:30:00.000Z", operations: ["poll", "reconcile"] };
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

function renderChromeForDashboard(dashboard: DashboardModel, dataSourceLabel = "api source · api") {
  return renderToStaticMarkup(
    <AppChrome
      activeTab="dashboard"
      onTabChange={() => undefined}
      runningCount={dashboard.runningAgents.length}
      repoLabel={dashboard.repoLabel}
      branch={dashboard.branch}
      pollLabel={dashboard.pollLabel}
      agentUsageLabel={dashboard.agentUsageLabel}
      dataSourceLabel={dataSourceLabel}
    >
      <div>Dashboard body</div>
    </AppChrome>,
  );
}

function expectNoFabricatedDashboardMetrics(markup: string) {
  const forbiddenStrings = [
    "▲ 12% this cycle",
    "3.2",
    "PR/day",
    "ETA: cycle ends",
    "Cycle 14",
    "cycle 14",
    "7 days left",
    "7 days remaining",
    "May 15",
    "May 29",
    "96%",
    "oldest 24m",
    "nominal",
    "0 errors",
    "Velocity · last 14 days",
    "+24",
    "Day 7",
    "Day 14",
    "target 17",
    "completed 13",
    "linear · connected",
  ];

  for (const forbidden of forbiddenStrings) {
    expect(markup).not.toContain(forbidden);
  }
}

function expectNoDashboardBodyLiveIndicators(markup: string, expectedProjectionLabel: string) {
  expect(markup).toContain(expectedProjectionLabel);
  expect(markup).toContain("Projected running sessions");
  expect(markup).toContain("projected · concurrency cap");
  expect(markup).toContain("projected event");
  expect(markup).not.toContain("Active sessions");
  expect(markup).not.toContain("active · concurrency cap");
  expect(markup).not.toContain('class="spinner"');
  expect(markup).not.toContain("animation:pulse");
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
    expect(markup).toContain("8/32 done");
    expect(markup).toContain("8/32 done · schedule unavailable");
    expect(markup).toContain("done 8");
    expect(markup).toContain("total 32");
    expect(markup).toContain("Burn-up unavailable");
    expect(markup).toContain("Velocity trend unavailable");
    expect(markup).toContain("ETA unavailable");
    expect(markup).toMatch(/API-1/);
    expect(markup).toContain("Implement API dashboard");
    expect(markup).toContain("Rendering dashboard model");
    expect(markup).toContain("api-worker");
    expect(markup).toContain("from API activity");
    expect(markup).toContain("tracker stale · 4 cached issues");
    expect(markup).toContain("Using a cached tracker source while refresh catches up");
    expect(markup).toContain("tracker fetched 2026-05-29T20:04:00.000Z");
    expectNoDashboardBodyLiveIndicators(markup, "stale dashboard projection · 2/9 agents");
    expect(markup).toContain("API hello");
    expect(markup).toContain("API suggestion");
    expect(markup).toContain("unavailable: no durable throughput or ETA source");

    expect(markup).not.toContain("openai/symphony");
    expect(markup).not.toContain("WORKFLOW.md@main");
    expect(markup).not.toContain("poll 22s");
    expect(markup).not.toContain("4/6 agents");
    expect(markup).not.toContain("Restart SYM-42");
    expectNoFabricatedDashboardMetrics(markup);
  });

  it("uses an empty API dashboard chat array as empty initial chat instead of mock suggestions", () => {
    const markup = renderDashboard({ ...apiDashboard, chat: [] });

    expect(markup).toContain("Symphony orchestrator");
    expect(markup).not.toContain("API hello");
    expect(markup).not.toContain("API suggestion");
    expect(markup).not.toContain("Restart SYM-42");
    expect(markup).not.toContain("Show SYM-42 transcript");
    expectNoFabricatedDashboardMetrics(markup);
  });

  it("renders unknown freshness explicitly when dashboard source metadata is absent", () => {
    const markup = renderDashboard({ ...apiDashboard, source: null });

    expect(markup).toContain("source unavailable");
    expect(markup).toContain("Dashboard payload did not include freshness metadata");
    expectNoDashboardBodyLiveIndicators(markup, "dashboard projection freshness unknown · 2/9 agents");
    expect(markup).not.toContain("tracker fresh");
    expectNoFabricatedDashboardMetrics(markup);
  });

  it("uses API totals in the grid progress panel without mock chart or velocity labels", () => {
    const markup = renderDashboard(apiDashboard, "grid");

    expect(markup).toContain("8/32 done");
    expect(markup).toContain("8/32 done · schedule unavailable");
    expect(markup).toContain("done 8");
    expect(markup).toContain("total 32");
    expect(markup).toContain("Burn-up unavailable");
    expect(markup).toContain("Throughput history");
    expect(markup).toContain("Velocity trend unavailable; no durable throughput history is present.");
    expectNoFabricatedDashboardMetrics(markup);
  });

  it("wires command-center agent, poll, and status totals to the API dashboard fields while marking unsupported metrics unavailable", () => {
    const markup = renderDashboard(apiDashboard, "command-center");

    expect(markup).toContain("./symphony status --branch api-branch");
    expect(markup).toContain("non-live dashboard projection");
    expect(markup).toContain("73%");
    expect(markup).toContain("8/32");
    expect(markup).toContain("11 open");
    expect(markup).toContain("2 todo");
    expect(markup).toContain("3 in progress");
    expect(markup).toContain("5 in review");
    expect(markup).toContain("2/9 agents");
    expect(markup).toContain("2 projected / 9 cap");
    expect(markup).toContain("poll 5s");
    expect(markup).toContain("cycle unavailable · schedule unavailable ·");
    expect(markup).toContain('projection <span style="color:var(--text-3)">unavailable</span>');
    expect(markup).toContain("backend metric unavailable");
    expect(markup).toContain("5 issues in review · queue age unavailable");
    expect(markup).toContain("status unavailable");
    expect(markup).toContain("errors unavailable");
    expect(markup).toContain("cycle dates, throughput, ETA, health, and error-window metrics need durable source fields");
    expect(markup).not.toContain("4 running");
    expect(markup).not.toContain("last poll 8s ago");
    expectNoFabricatedDashboardMetrics(markup);
  });

  it("preserves mock dashboard data when rendering the mock model without fabricating unsupported dashboard metrics", () => {
    const mockDashboard = toDashboardModel(rawMockData);
    const markup = renderDashboard(mockDashboard, "cards", false);

    expect(markup).toContain("openai/symphony");
    expect(markup).toContain("main");
    expect(markup).toContain("WORKFLOW.md@main");
    expect(markup).toContain("poll 22s");
    expect(markup).toContain("4/6 agents");
    expect(markup).toContain("Restart SYM-42");
    expect(markup).toContain("trend unavailable");
    expectNoFabricatedDashboardMetrics(markup);
  });

  it("lets app chrome consume dashboard labels in API mode instead of fixed mock copy", () => {
    const markup = renderChromeForDashboard(apiDashboard, "api source · api");

    expect(markup).toContain("api-branch");
    expect(markup).toContain("2/9 agents");
    expect(markup).toContain("api/repo@api-branch");
    expect(markup).toContain("poll 5s");
    expect(markup).toContain("api source · api");
    expect(markup).toContain("connection unavailable");
    expect(markup).toContain("errors unavailable");
    expect(markup).not.toContain("openai/symphony@main");
    expect(markup).not.toContain("poll 22s");
    expect(markup).not.toContain("api source · mock");
    expectNoFabricatedDashboardMetrics(markup);
  });

  it("uses unavailable AppChrome defaults rather than fabricated tracker or error-window status", () => {
    const markup = renderToStaticMarkup(
      <AppChrome activeTab="dashboard" onTabChange={() => undefined}>
        <div>Dashboard body</div>
      </AppChrome>,
    );

    expect(markup).toContain("0 agents running");
    expect(markup).toContain("repository unavailable");
    expect(markup).toContain("poll unavailable");
    expect(markup).toContain("source unavailable");
    expect(markup).not.toContain("openai/symphony@main");
    expect(markup).not.toContain("poll 22s");
    expectNoFabricatedDashboardMetrics(markup);
  });

  it("keeps unsupported metrics unavailable across empty, active, failed, stale-source, writeback-failure, and healthy dashboard states", () => {
    const scenarios: Array<{ name: string; dashboard: DashboardModel; expected: string[] }> = [
      {
        name: "empty/fallback",
        dashboard: dashboardFixture({
          branch: "empty-branch",
          pollLabel: "poll unavailable",
          agentUsageLabel: "0/0 agents",
          concurrencyCap: 0,
          runningAgents: [],
          activity: [],
          chat: [],
          totals: zeroTotals,
        }),
        expected: ["0/0 agents", "0/0 done", "total 0", "0 projected events", "No activity entries are available from the current dashboard projection."],
      },
      {
        name: "active runs",
        dashboard: apiDashboard,
        expected: ["2/9 agents", "poll 5s"],
      },
      {
        name: "failed run",
        dashboard: dashboardFixture({
          branch: "failed-branch",
          pollLabel: "poll 9s",
          agentUsageLabel: "0/4 agents",
          concurrencyCap: 4,
          runningAgents: [],
          activity: [{ t: "1m ago", who: "worker", verb: "error", id: "API-FAIL", extra: "durable failed run" }],
          totals: { backlog: 0, todo: 1, progress: 0, review: 0, done: 0, cancelled: 0, open: 1, all: 1, completeness: 0 },
        }),
        expected: ["API-FAIL", "durable failed run", "0/1 done"],
      },
      {
        name: "stale source",
        dashboard: dashboardFixture({
          branch: "stale-branch",
          pollLabel: "source stale · last poll unavailable",
          agentUsageLabel: "1/4 agents",
          runningAgents: [apiDashboard.runningAgents[0]],
        }),
        expected: ["source stale · last poll unavailable", "1/4 agents"],
      },
      {
        name: "writeback failure",
        dashboard: dashboardFixture({
          branch: "writeback-branch",
          providerGates: [writebackFailureGate],
          activity: [{ t: "2m ago", who: "writeback", verb: "error", id: "API-5", extra: "tracker rejected the transition" }],
        }),
        expected: ["writeback failed: tracker rejected the transition", "tracker rejected the transition"],
      },
      {
        name: "normal healthy state",
        dashboard: dashboardFixture({
          branch: "healthy-branch",
          pollLabel: "poll 3s",
          agentUsageLabel: "1/4 agents",
          runningAgents: [apiDashboard.runningAgents[0]],
          activity: [{ t: "just now", who: "worker", verb: "finished", id: "API-OK", extra: "durable terminal run" }],
          totals: { backlog: 0, todo: 0, progress: 0, review: 0, done: 4, cancelled: 0, open: 0, all: 4, completeness: 100 },
        }),
        expected: ["API-OK", "durable terminal run", "4/4 done"],
      },
    ];

    for (const scenario of scenarios) {
      for (const variant of ["cards", "grid", "command-center"] as DashboardVariant[]) {
        const markup = renderDashboard(scenario.dashboard, variant);
        expect(markup, `${scenario.name}/${variant} should render unsupported metrics as unavailable`).toContain("unavailable");
        for (const expected of scenario.expected) {
          expect(markup, `${scenario.name}/${variant} should include ${expected}`).toContain(expected);
        }
        expectNoFabricatedDashboardMetrics(markup);
      }

      const chrome = renderChromeForDashboard(scenario.dashboard, `api source · ${scenario.name}`);
      expect(chrome).toContain(`api source · ${scenario.name}`);
      expect(chrome).toContain("connection unavailable");
      expect(chrome).toContain("errors unavailable");
      expectNoFabricatedDashboardMetrics(chrome);
    }
  });
});

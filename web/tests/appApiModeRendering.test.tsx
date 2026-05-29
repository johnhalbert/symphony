import { Fragment, createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SymphonyDataSource } from "../src/data/dataSource";
import type {
  ChatMessage,
  DashboardModel,
  HistoryModel,
  IssueBoardModel,
  Loadable,
  ReferenceData,
  SidebarModel,
} from "../src/types/symphony";

const apiChat: ChatMessage[] = [{ who: "agent", text: "API full-app chat", suggestions: ["Full-app suggestion"] }];

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
      extra: "API full-app activity",
    },
  ],
  chat: [{ who: "agent", text: "dashboard embedded fallback should not render", suggestions: ["dashboard stale suggestion"] }],
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

const emptyIssueBoard: IssueBoardModel = {
  issues: [],
  backlog: [],
  lanes: { todo: [], progress: [], review: [] },
  cycleLabel: "API cycle",
  cycleDateRange: "now",
  selectedIssueId: "",
};

const emptyHistory: HistoryModel = {
  sessions: [],
  transcriptBySession: {},
  timeline: [],
  defaultSessionId: "",
};

const emptySidebar: SidebarModel = {
  providerGates: [],
  runningAgents: [],
  reviewIssues: [],
  activity: [],
  sessions: [],
  chat: [],
  totals: apiDashboard.totals,
};

const sidebarWithOneAgent: SidebarModel = {
  ...emptySidebar,
  runningAgents: [
    {
      id: "sidebar-run-1",
      issue: "API-9",
      title: "Sidebar fallback agent count",
      state: "running",
      step: "Waiting for dashboard recovery",
      duration: "1m",
      tokens: "400",
    },
  ],
};

type AppHookState = {
  reference: Loadable<ReferenceData>;
  dashboard: Loadable<DashboardModel>;
  issueBoard: Loadable<IssueBoardModel>;
  history: Loadable<HistoryModel>;
  sidebar: Loadable<SidebarModel>;
  orchestratorChat: Loadable<ChatMessage[]>;
};

function loaded<T>(data: T): Loadable<T> {
  return { data, loading: false, error: null };
}

function failed<T>(message: string): Loadable<T> {
  return { data: null, loading: false, error: message };
}

function appHookState(overrides: Partial<AppHookState> = {}): AppHookState {
  return {
    reference: loaded({ users: {}, labels: {} }),
    dashboard: loaded(apiDashboard),
    issueBoard: loaded(emptyIssueBoard),
    history: loaded(emptyHistory),
    sidebar: loaded(emptySidebar),
    orchestratorChat: loaded(apiChat),
    ...overrides,
  };
}

async function renderAppWithMocks({
  mode = "api",
  hooks = appHookState(),
}: {
  mode?: "api" | "mock";
  hooks?: AppHookState;
} = {}) {
  vi.resetModules();

  const dataSource = {
    async sendOrchestratorMessage(input: string) {
      return [...apiChat, { who: "user", text: input } satisfies ChatMessage];
    },
  } as SymphonyDataSource;

  vi.doMock("../src/data/dataSourceContext", () => ({
    defaultDataSourceConfig: { mode, apiBaseUrl: "" },
    defaultDataSource: dataSource,
    DataSourceProvider: ({ children }: { children: ReactNode }) => createElement(Fragment, null, children),
    useDataSource: () => dataSource,
  }));

  vi.doMock("../src/hooks/useSymphonyData", () => ({
    useReferenceData: () => hooks.reference,
    useDashboard: () => hooks.dashboard,
    useIssueBoard: () => hooks.issueBoard,
    useHistory: () => hooks.history,
    useSidebar: () => hooks.sidebar,
    useOrchestratorChat: () => hooks.orchestratorChat,
  }));

  const { App } = await import("../src/App");
  return renderToStaticMarkup(<App />);
}

afterEach(() => {
  vi.doUnmock("../src/data/dataSourceContext");
  vi.doUnmock("../src/hooks/useSymphonyData");
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("App API-mode rendering", () => {
  it("renders the loaded API dashboard through the app shell without mock chrome or embedded chat fallbacks", async () => {
    const markup = await renderAppWithMocks();

    expect(markup).toContain("api source · api");
    expect(markup).toContain("api/repo@api-branch");
    expect(markup).toContain("Symphony · api-branch");
    expect(markup).toContain("WORKFLOW.api@api-branch");
    expect(markup).toContain("poll 5s");
    expect(markup).toContain("2/9 agents");
    expect(markup).toContain("concurrency cap 9");
    expect(markup).toContain("8/32 done");
    expect(markup).toMatch(/target\s+32/);
    expect(markup).toMatch(/completed\s+8/);
    expect(markup).toContain("API full-app activity");
    expect(markup).toContain("API full-app chat");
    expect(markup).toContain("Full-app suggestion");

    expect(markup).not.toContain("openai/symphony@main");
    expect(markup).not.toContain("poll 22s");
    expect(markup).not.toContain("dashboard embedded fallback should not render");
    expect(markup).not.toContain("dashboard stale suggestion");
    expect(markup).not.toContain("Restart SYM-42");
  });

  it("keeps API-mode chrome in an API state when the dashboard request fails", async () => {
    const markup = await renderAppWithMocks({
      hooks: appHookState({
        dashboard: failed("Symphony API returned HTTP 503"),
        sidebar: loaded(sidebarWithOneAgent),
        orchestratorChat: loaded([]),
      }),
    });

    expect(markup).toContain("Symphony API returned HTTP 503");
    expect(markup).toContain("api source · api");
    expect(markup).toContain("1 agents running");
    expect(markup).toContain("poll pending");

    expect(markup).not.toContain("openai/symphony@main");
    expect(markup).not.toContain("poll 22s");
    expect(markup).not.toContain("API full-app chat");
    expect(markup).not.toContain("dashboard embedded fallback should not render");
  });

  it("holds the reference-data loading boundary without rendering API or mock dashboard content", async () => {
    const markup = await renderAppWithMocks({
      hooks: appHookState({ reference: { data: null, loading: true, error: null } }),
    });

    expect(markup).toContain("Loading Symphony design data...");
    expect(markup).not.toContain("api/repo");
    expect(markup).not.toContain("openai/symphony");
    expect(markup).not.toContain("API full-app chat");
  });
});

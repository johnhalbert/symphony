import { Fragment, createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAppResourceLoading } from "../src/app/resourceLoading";
import type { SymphonyDataSource } from "../src/data/dataSource";
import { fallbackReferenceData } from "../src/data/referenceDataContext";
import type {
  AppTab,
  ChatMessage,
  DashboardModel,
  HistoryModel,
  IssueDetailModel,
  IssueBoardModel,
  IssueModel,
  Loadable,
  ReferenceData,
  SidebarModel,
  SessionModel,
  TranscriptMessage,
} from "../src/types/symphony";

const apiChat: ChatMessage[] = [{ who: "agent", text: "API full-app chat", suggestions: ["Full-app suggestion"] }];

const apiReferenceData: ReferenceData = {
  users: {
    "api-owner": { name: "API Owner", color: "#7aa7ff" },
    "api-reviewer": { name: "API Reviewer", color: "#7fc28b" },
    "api-unassigned": { name: "API Unassigned", color: null },
  },
  labels: {
    "api-render": { name: "api-render", color: "#7aa7ff" },
    "api-detail": { name: "api-detail", color: "#b78aff" },
    "api-empty": { name: "api-empty", color: null },
  },
};

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

function makeApiIssue(overrides: Partial<IssueModel> = {}): IssueModel {
  return {
    id: "API-BASE",
    title: "API issue base",
    status: "todo",
    priority: 2,
    labels: ["api-render"],
    assignee: "api-owner",
    agent: null,
    project: "API Project",
    cycle: "API Cycle 44",
    desc: ["API issue description from GET /api/v1/web/issues."],
    activity: [{ t: "now", verb: "reported", val: "API issue activity", who: "api-service" }],
    pr: null,
    ci: null,
    workspace: null,
    session: null,
    ...overrides,
  };
}

const apiBacklogIssue = makeApiIssue({
  id: "API-BACKLOG",
  title: "API backlog issue from board endpoint",
  status: "backlog",
  priority: 1,
  labels: ["api-render"],
  assignee: "api-unassigned",
});

const apiTodoIssue = makeApiIssue({
  id: "API-TODO",
  title: "API todo lane issue from board endpoint",
  status: "todo",
  priority: 2,
  labels: ["api-render"],
});

const apiSelectedIssue = makeApiIssue({
  id: "API-SELECTED",
  title: "API selected issue card from board endpoint",
  status: "progress",
  priority: "urgent",
  labels: ["api-render", "api-detail"],
  assignee: "api-owner",
  agent: "api-agent-2",
  workspace: "api-worktree/API-SELECTED",
  session: "run-api-selected",
  pr: "#909",
  ci: "green",
});

const apiReviewIssue = makeApiIssue({
  id: "API-REVIEW",
  title: "API review lane issue from board endpoint",
  status: "review",
  priority: 3,
  labels: ["api-render"],
  assignee: "api-reviewer",
  agent: "api-review-agent",
});

const apiIssueBoard: IssueBoardModel = {
  issues: [apiBacklogIssue, apiTodoIssue, apiSelectedIssue, apiReviewIssue],
  backlog: [apiBacklogIssue],
  lanes: { todo: [apiTodoIssue], progress: [apiSelectedIssue], review: [apiReviewIssue] },
  cycleLabel: "API Cycle 44",
  cycleDateRange: "May 29 - Jun 5",
  selectedIssueId: apiSelectedIssue.id,
};

const apiSelectedIssueDetail: IssueDetailModel = {
  issue: {
    ...apiSelectedIssue,
    title: "API issue detail title from GET /api/v1/web/issues/API-SELECTED",
    desc: ["API detail description loaded from the issue-detail endpoint."],
    activity: [{ t: "1m ago", verb: "loaded", val: "API detail activity", who: "api-detail-service" }],
  },
  activity: [],
  runs: [],
  transcript: [],
};

const emptyIssueBoard: IssueBoardModel = {
  issues: [],
  backlog: [],
  lanes: { todo: [], progress: [], review: [] },
  cycleLabel: "API empty cycle",
  cycleDateRange: "no active issues",
  selectedIssueId: "",
};

const apiTranscriptSession: SessionModel = {
  id: "run-api-transcript",
  issue: "API-HISTORY",
  title: "API selected transcript session",
  state: "finished",
  model: "gpt-api-history",
  startedAt: "2026-05-29T20:00:00.000Z",
  updatedAt: "2026-05-29T20:05:00.000Z",
  msgCount: 2,
  lastEvent: "assistant: API transcript rendered",
  toolCount: 1,
};

const apiEmptyTranscriptSession: SessionModel = {
  id: "run-api-empty-transcript",
  issue: "API-EMPTY-HISTORY",
  title: "API selected empty transcript session",
  state: "finished",
  model: "gpt-api-history",
  startedAt: "2026-05-29T20:10:00.000Z",
  updatedAt: "2026-05-29T20:11:00.000Z",
  msgCount: 0,
  lastEvent: "status: API empty transcript",
  toolCount: 0,
};

const apiTranscriptMessage: TranscriptMessage = {
  kind: "assistant",
  ts: "2026-05-29T20:04:00.000Z",
  text: "API transcript message rendered from selected session data.",
};

const apiHistory: HistoryModel = {
  sessions: [apiTranscriptSession, apiEmptyTranscriptSession],
  transcriptBySession: {
    [apiTranscriptSession.id]: [apiTranscriptMessage],
    [apiEmptyTranscriptSession.id]: [],
  },
  timeline: [
    {
      t: "2026-05-29T20:05:00.000Z",
      sess: apiTranscriptSession.id,
      kind: "assistant",
      text: "API timeline event rendered from history endpoint.",
    },
  ],
  defaultSessionId: apiTranscriptSession.id,
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

type HookOptions = { enabled?: boolean };

type AppHookCalls = {
  reference: HookOptions[];
  dashboard: HookOptions[];
  issueBoard: HookOptions[];
  history: HookOptions[];
  sidebar: HookOptions[];
  orchestratorChat: HookOptions[];
};

function loaded<T>(data: T): Loadable<T> {
  return { data, loading: false, error: null };
}

function failed<T>(message: string): Loadable<T> {
  return { data: null, loading: false, error: message };
}

function disabled<T>(): Loadable<T> {
  return { data: null, loading: false, error: null };
}

function maybeEnabled<T>(resource: Loadable<T>, options: HookOptions = {}): Loadable<T> {
  return options.enabled === false ? disabled<T>() : resource;
}

function appHookState(overrides: Partial<AppHookState> = {}): AppHookState {
  return {
    reference: loaded(apiReferenceData),
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

  const hookCalls: AppHookCalls = {
    reference: [],
    dashboard: [],
    issueBoard: [],
    history: [],
    sidebar: [],
    orchestratorChat: [],
  };

  vi.doMock("../src/hooks/useSymphonyData", () => ({
    useReferenceData: (options: HookOptions = {}) => {
      hookCalls.reference.push(options);
      return maybeEnabled(hooks.reference, options);
    },
    useDashboard: (options: HookOptions = {}) => {
      hookCalls.dashboard.push(options);
      return maybeEnabled(hooks.dashboard, options);
    },
    useIssueBoard: (options: HookOptions = {}) => {
      hookCalls.issueBoard.push(options);
      return maybeEnabled(hooks.issueBoard, options);
    },
    useIssueDetail: () => loaded(null),
    useHistory: (options: HookOptions = {}) => {
      hookCalls.history.push(options);
      return maybeEnabled(hooks.history, options);
    },
    useSidebar: (options: HookOptions = {}) => {
      hookCalls.sidebar.push(options);
      return maybeEnabled(hooks.sidebar, options);
    },
    useOrchestratorChat: (options: HookOptions = {}) => {
      hookCalls.orchestratorChat.push(options);
      return maybeEnabled(hooks.orchestratorChat, options);
    },
  }));

  const { App } = await import("../src/App");
  return { hookCalls, markup: renderToStaticMarkup(<App />) };
}

async function renderIssuesViewWithDetail({
  board,
  detail = loaded(apiSelectedIssueDetail),
  referenceData = apiReferenceData,
}: {
  board: IssueBoardModel;
  detail?: Loadable<IssueDetailModel | null>;
  referenceData?: ReferenceData;
}) {
  vi.resetModules();
  const requestedIssueIds: Array<string | null> = [];

  vi.doMock("../src/hooks/useSymphonyData", () => ({
    useIssueDetail: (issueId: string | null) => {
      requestedIssueIds.push(issueId);
      return detail;
    },
  }));

  const [{ IssuesView }, { ReferenceDataProvider }] = await Promise.all([
    import("../src/components/issues/IssuesView"),
    import("../src/data/referenceDataContext"),
  ]);

  const markup = renderToStaticMarkup(
    <ReferenceDataProvider value={referenceData}>
      <IssuesView board={board} />
    </ReferenceDataProvider>,
  );

  return { markup, requestedIssueIds };
}

async function renderHistoryView(history: HistoryModel, variant: "list" | "timeline" | "focused" = "list") {
  vi.resetModules();

  vi.doMock("../src/hooks/useSymphonyData", () => ({
    useTranscript: (sessionId: string | null): Loadable<TranscriptMessage[]> => {
      if (!sessionId) return loaded([]);
      if (Object.prototype.hasOwnProperty.call(history.transcriptBySession ?? {}, sessionId)) {
        return loaded(history.transcriptBySession?.[sessionId] ?? []);
      }
      return failed(`Unexpected transcript request for ${sessionId}`);
    },
  }));

  const { ChatHistoryView } = await import("../src/components/history/ChatHistoryView");
  return renderToStaticMarkup(<ChatHistoryView history={history} variant={variant} />);
}

afterEach(() => {
  vi.doUnmock("../src/data/dataSourceContext");
  vi.doUnmock("../src/hooks/useSymphonyData");
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("App API-mode rendering", () => {
  it("resolves global reference-data and tab-scoped resource loading for API mode while preserving mock-mode eager loading", () => {
    const allResourcesEnabled = {
      referenceData: true,
      dashboard: true,
      issueBoard: true,
      history: true,
      sidebar: true,
      orchestratorChat: true,
    };
    expect(resolveAppResourceLoading("dashboard", false)).toEqual(allResourcesEnabled);

    const expectedApiLoadingByTab: Record<AppTab, ReturnType<typeof resolveAppResourceLoading>> = {
      dashboard: {
        referenceData: true,
        dashboard: true,
        issueBoard: false,
        history: false,
        sidebar: false,
        orchestratorChat: true,
      },
      issues: {
        referenceData: true,
        dashboard: false,
        issueBoard: true,
        history: false,
        sidebar: false,
        orchestratorChat: false,
      },
      history: {
        referenceData: true,
        dashboard: false,
        issueBoard: false,
        history: true,
        sidebar: false,
        orchestratorChat: false,
      },
      sidebar: {
        referenceData: true,
        dashboard: false,
        issueBoard: false,
        history: false,
        sidebar: true,
        orchestratorChat: true,
      },
      states: {
        referenceData: true,
        dashboard: false,
        issueBoard: false,
        history: false,
        sidebar: false,
        orchestratorChat: false,
      },
    };

    for (const [tab, expected] of Object.entries(expectedApiLoadingByTab) as Array<[
      AppTab,
      ReturnType<typeof resolveAppResourceLoading>,
    ]>) {
      expect(resolveAppResourceLoading(tab, true)).toEqual(expected);
    }
  });

  it("renders the loaded API dashboard through the app shell without mock chrome or embedded chat fallbacks", async () => {
    const { hookCalls, markup } = await renderAppWithMocks();

    expect(hookCalls.reference).toEqual([{ enabled: true }]);
    expect(hookCalls.dashboard).toEqual([{ enabled: true }]);
    expect(hookCalls.issueBoard).toEqual([{ enabled: false }]);
    expect(hookCalls.history).toEqual([{ enabled: false }]);
    expect(hookCalls.sidebar).toEqual([{ enabled: false }]);
    expect(hookCalls.orchestratorChat).toEqual([{ enabled: true }]);
    expect(markup).toContain("api source · api");
    expect(markup).toContain("api/repo@api-branch");
    expect(markup).toContain("Symphony · api-branch");
    expect(markup).toContain("WORKFLOW.api@api-branch");
    expect(markup).toContain("poll 5s");
    expect(markup).toContain("2/9 agents");
    expect(markup).toContain("concurrency cap 9");
    expect(markup).toContain("8/32 done");
    expect(markup).toContain("total 32");
    expect(markup).toContain("done 8");
    expect(markup).toContain("API full-app activity");
    expect(markup).toContain("API full-app chat");
    expect(markup).toContain("Full-app suggestion");

    expect(markup).not.toContain("openai/symphony@main");
    expect(markup).not.toContain("poll 22s");
    expect(markup).not.toContain("dashboard embedded fallback should not render");
    expect(markup).not.toContain("dashboard stale suggestion");
    expect(markup).not.toContain("Restart SYM-42");
  });

  it("keeps mock-mode app-shell resources eager once reference data is loaded", async () => {
    const { hookCalls, markup } = await renderAppWithMocks({ mode: "mock" });

    expect(hookCalls.reference).toEqual([{}, { enabled: false }]);
    expect(hookCalls.dashboard).toEqual([{ enabled: true }]);
    expect(hookCalls.issueBoard).toEqual([{ enabled: true }]);
    expect(hookCalls.history).toEqual([{ enabled: true }]);
    expect(hookCalls.sidebar).toEqual([{ enabled: true }]);
    expect(hookCalls.orchestratorChat).toEqual([{ enabled: true }]);
    expect(markup).toContain("api source · mock");
  });

  it("keeps API-mode chrome in an API state when the dashboard request fails", async () => {
    const { hookCalls, markup } = await renderAppWithMocks({
      hooks: appHookState({
        dashboard: failed("Symphony API returned HTTP 503"),
        sidebar: loaded(sidebarWithOneAgent),
        orchestratorChat: loaded([]),
      }),
    });

    expect(hookCalls.reference).toEqual([{ enabled: true }]);
    expect(hookCalls.dashboard).toEqual([{ enabled: true }]);
    expect(hookCalls.issueBoard).toEqual([{ enabled: false }]);
    expect(hookCalls.history).toEqual([{ enabled: false }]);
    expect(hookCalls.sidebar).toEqual([{ enabled: true }]);
    expect(hookCalls.orchestratorChat).toEqual([{ enabled: true }]);
    expect(markup).toContain("Symphony API returned HTTP 503");
    expect(markup).toContain("api source · api");
    expect(markup).toContain("1 agents running");
    expect(markup).toContain("poll unavailable");

    expect(markup).not.toContain("openai/symphony@main");
    expect(markup).not.toContain("poll 22s");
    expect(markup).not.toContain("API full-app chat");
    expect(markup).not.toContain("dashboard embedded fallback should not render");
  });

  it("starts non-blocking API reference data while the dashboard is active and keeps inactive API views disabled", async () => {
    const { hookCalls, markup } = await renderAppWithMocks({
      hooks: appHookState({ reference: { data: null, loading: true, error: null } }),
    });

    expect(hookCalls.reference).toEqual([{ enabled: true }]);
    expect(hookCalls.dashboard).toEqual([{ enabled: true }]);
    expect(hookCalls.issueBoard).toEqual([{ enabled: false }]);
    expect(hookCalls.history).toEqual([{ enabled: false }]);
    expect(hookCalls.sidebar).toEqual([{ enabled: false }]);
    expect(hookCalls.orchestratorChat).toEqual([{ enabled: true }]);
    expect(markup).toContain("api source · api · reference loading");
    expect(markup).toContain("api/repo@api-branch");
    expect(markup).toContain("Symphony · api-branch");
    expect(markup).toContain("API full-app chat");
    expect(markup).not.toContain("Loading Symphony design data...");
    expect(markup).not.toContain("Reference data unavailable.");
    expect(markup).not.toContain("openai/symphony");
  });

  it("keeps the API app shell usable when reference data fails", async () => {
    const { hookCalls, markup } = await renderAppWithMocks({
      hooks: appHookState({ reference: failed("Symphony API returned HTTP 503 for reference data") }),
    });

    expect(hookCalls.reference).toEqual([{ enabled: true }]);
    expect(hookCalls.dashboard).toEqual([{ enabled: true }]);
    expect(hookCalls.issueBoard).toEqual([{ enabled: false }]);
    expect(hookCalls.history).toEqual([{ enabled: false }]);
    expect(hookCalls.sidebar).toEqual([{ enabled: false }]);
    expect(hookCalls.orchestratorChat).toEqual([{ enabled: true }]);
    expect(markup).toContain("api source · api · reference unavailable");
    expect(markup).toContain("api/repo@api-branch");
    expect(markup).toContain("Symphony · api-branch");
    expect(markup).toContain("API full-app chat");
    expect(markup).not.toContain("Loading Symphony design data...");
    expect(markup).not.toContain("Reference data unavailable.");
    expect(markup).not.toContain("openai/symphony");
  });

  it("preserves the mock-mode reference-data loading boundary before the mock app shell mounts", async () => {
    const { hookCalls, markup } = await renderAppWithMocks({
      mode: "mock",
      hooks: appHookState({ reference: { data: null, loading: true, error: null } }),
    });

    expect(hookCalls.reference).toEqual([{}]);
    expect(hookCalls.dashboard).toEqual([]);
    expect(hookCalls.issueBoard).toEqual([]);
    expect(hookCalls.history).toEqual([]);
    expect(hookCalls.sidebar).toEqual([]);
    expect(hookCalls.orchestratorChat).toEqual([]);
    expect(markup).toContain("Loading Symphony design data...");
    expect(markup).not.toContain("api source · mock");
    expect(markup).not.toContain("API full-app chat");
  });

  it("renders API issue board backlog, lanes, selected issue detail, and no mock detail fallbacks", async () => {
    const { markup, requestedIssueIds } = await renderIssuesViewWithDetail({ board: apiIssueBoard });

    expect(requestedIssueIds).toEqual([apiSelectedIssue.id]);
    expect(markup).toContain("API Cycle 44");
    expect(markup).toContain("May 29 - Jun 5");
    expect(markup).toContain("API backlog issue from board endpoint");
    expect(markup).toContain("API todo lane issue from board endpoint");
    expect(markup).toContain("API selected issue card from board endpoint");
    expect(markup).toContain("API review lane issue from board endpoint");
    expect(markup).toContain("data-selected=\"true\"");
    expect(markup).toContain("api-agent-2");
    expect(markup).toContain("api-review-agent");
    expect(markup).toContain("API issue detail title from GET /api/v1/web/issues/API-SELECTED");
    expect(markup).toContain("API detail description loaded from the issue-detail endpoint.");
    expect(markup).toContain("API detail activity");
    expect(markup).toContain("api-worktree/API-SELECTED");
    expect(markup).toContain("run-api-selected");
    expect(markup).toContain("#909");
    expect(markup).toContain("green");

    expect(markup).not.toContain("SYM-12");
    expect(markup).not.toContain("Add exponential backoff to retry queue with jitter");
    expect(markup).not.toContain("Backoff curve");
    expect(markup).not.toContain("No issue activity in the mock data.");
  });

  it("renders API issue references with deterministic fallback labels and users", async () => {
    const { markup } = await renderIssuesViewWithDetail({ board: apiIssueBoard, referenceData: fallbackReferenceData });

    expect(markup).toContain("api-render");
    expect(markup).toContain("api-detail");
    expect(markup).toContain("api-owner");
    expect(markup).toContain("API issue detail title from GET /api/v1/web/issues/API-SELECTED");

    expect(markup).not.toContain("API Owner");
    expect(markup).not.toContain("API Reviewer");
    expect(markup).not.toContain("orchestrator");
    expect(markup).not.toContain("feature");
  });

  it("renders API empty-board and 200-null issue-detail boundaries without mock fallbacks", async () => {
    const emptyBoard = await renderIssuesViewWithDetail({ board: emptyIssueBoard, detail: loaded(null) });

    expect(emptyBoard.requestedIssueIds).toEqual([null]);
    expect(emptyBoard.markup).toContain("API empty cycle");
    expect(emptyBoard.markup).toContain("no active issues");
    expect(emptyBoard.markup).toContain("Backlog");
    expect(emptyBoard.markup).toContain("Todo");
    expect(emptyBoard.markup).toContain("In Progress");
    expect(emptyBoard.markup).toContain("In Review");
    expect(emptyBoard.markup).toContain("Select an issue to inspect details.");
    expect(emptyBoard.markup).not.toContain("SYM-12");
    expect(emptyBoard.markup).not.toContain("Add exponential backoff to retry queue with jitter");

    const missingDetailIssue = makeApiIssue({
      id: "API-MISSING-DETAIL",
      title: "API selected issue whose detail endpoint returned 200 null",
      status: "progress",
      priority: 3,
      labels: ["api-empty"],
      assignee: "api-owner",
      agent: "api-null-detail-agent",
    });
    const missingDetailBoard: IssueBoardModel = {
      issues: [missingDetailIssue],
      backlog: [],
      lanes: { todo: [], progress: [missingDetailIssue], review: [] },
      cycleLabel: "API missing-detail cycle",
      cycleDateRange: "detail returned null",
      selectedIssueId: missingDetailIssue.id,
    };
    const missingDetail = await renderIssuesViewWithDetail({ board: missingDetailBoard, detail: loaded(null) });

    expect(missingDetail.requestedIssueIds).toEqual([missingDetailIssue.id]);
    expect(missingDetail.markup).toContain("API selected issue whose detail endpoint returned 200 null");
    expect(missingDetail.markup).toContain("api-null-detail-agent");
    expect(missingDetail.markup).toContain("Issue detail not found or unavailable.");
    expect(missingDetail.markup).not.toContain("Select an issue to inspect details.");
    expect(missingDetail.markup).not.toContain("Backoff curve");
    expect(missingDetail.markup).not.toContain("No issue activity in the mock data.");
  });

  it("renders API selected-session transcript messages and exact empty transcript arrays without embedded fallbacks", async () => {
    const transcriptMarkup = await renderHistoryView(apiHistory);

    expect(transcriptMarkup).toContain("API selected transcript session");
    expect(transcriptMarkup).toContain("API-HISTORY");
    expect(transcriptMarkup).toContain("gpt-api-history");
    expect(transcriptMarkup).toContain("API transcript message rendered from selected session data.");
    expect(transcriptMarkup).not.toContain("No transcript messages for this session.");
    expect(transcriptMarkup).not.toContain("Mock transcript remains embedded.");
    expect(transcriptMarkup).not.toContain("Exponential backoff for retry queue");

    const timelineMarkup = await renderHistoryView(apiHistory, "timeline");
    expect(timelineMarkup).toContain("API timeline event rendered from history endpoint.");
    expect(timelineMarkup).toContain("run-api-transcript");

    const emptyTranscriptMarkup = await renderHistoryView({
      ...apiHistory,
      defaultSessionId: apiEmptyTranscriptSession.id,
    });

    expect(emptyTranscriptMarkup).toContain("API selected empty transcript session");
    expect(emptyTranscriptMarkup).toContain("API-EMPTY-HISTORY");
    expect(emptyTranscriptMarkup).toContain("0 messages · 0 tools");
    expect(emptyTranscriptMarkup).toContain("No transcript messages for this session.");
    expect(emptyTranscriptMarkup).not.toContain("API transcript message rendered from selected session data.");
    expect(emptyTranscriptMarkup).not.toContain("Mock transcript remains embedded.");
  });
});

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SymphonyDataSource } from "../../src/data/dataSource";
import { DataSourceProvider } from "../../src/data/dataSourceContext";
import { ReferenceDataProvider } from "../../src/data/referenceDataContext";
import type {
  ChatMessage,
  DashboardModel,
  DashboardTotals,
  HistoryModel,
  IssueBoardModel,
  IssueDetailModel,
  IssueModel,
  ReferenceData,
  SidebarModel,
} from "../../src/types/symphony";

export const harnessReferenceData: ReferenceData = {
  users: {
    "fixture-worker": { name: "Fixture Worker", color: "#5da8ff" },
    "fixture-operator": { name: "Fixture Operator", color: "#8ec07c" },
  },
  labels: {
    "dogfood-ready": { name: "dogfood-ready", color: "#7fc28b" },
    frontend: { name: "frontend", color: "#d3869b" },
  },
};

export const harnessTotals: DashboardTotals = {
  backlog: 0,
  todo: 1,
  progress: 1,
  review: 0,
  done: 0,
  cancelled: 0,
  open: 2,
  all: 2,
  completeness: 25,
};

export function makeHarnessIssue(overrides: Partial<IssueModel> = {}): IssueModel {
  return {
    id: "ENG-84F",
    title: "Fixture issue loaded through API mode",
    status: "progress",
    priority: 2,
    labels: ["dogfood-ready", "frontend"],
    assignee: "fixture-worker",
    agent: "hermes-fixture",
    project: "Symphony",
    cycle: "Dogfood",
    desc: ["Deterministic issue fixture for web integration tests."],
    activity: [{ t: "now", verb: "loaded", val: "fixture", who: "web-test" }],
    pr: null,
    ci: "pending",
    workspace: "ENG-84F",
    session: "run-fixture",
    ...overrides,
  };
}

export function makeHarnessDashboard(overrides: Partial<DashboardModel> = {}): DashboardModel {
  return {
    projectName: "Symphony",
    repoLabel: "johnhalbert/symphony",
    branch: "fixture/web-integration",
    workflowLabel: "WORKFLOW.fixture@fixture/web-integration",
    pollLabel: "poll 30s",
    agentUsageLabel: "1/5 agents",
    concurrencyCap: 5,
    providerGates: [],
    runningAgents: [
      {
        id: "agent-fixture",
        issue: "ENG-84F",
        title: "Fixture browser smoke path",
        state: "running",
        step: "serving API fixture",
        duration: "1m",
        tokens: "0",
      },
    ],
    activity: [{ t: "now", who: "symphony", verb: "started", id: "ENG-84F", extra: "fixture" }],
    chat: [{ who: "agent", text: "Fixture chat from API-mode data source." }],
    totals: harnessTotals,
    ...overrides,
  };
}

export function makeHarnessIssueBoard(issue = makeHarnessIssue(), overrides: Partial<IssueBoardModel> = {}): IssueBoardModel {
  return {
    issues: [issue],
    backlog: [],
    lanes: { todo: [], progress: [issue], review: [] },
    cycleLabel: "Dogfood",
    cycleDateRange: "Fixture cycle",
    selectedIssueId: issue.id,
    ...overrides,
  };
}

export function makeHarnessHistory(overrides: Partial<HistoryModel> = {}): HistoryModel {
  return {
    sessions: [
      {
        id: "run-fixture",
        issue: "ENG-84F",
        title: "Fixture run",
        state: "running",
        model: "gpt-5.5",
        startedAt: "2026-05-29T00:00:00.000Z",
        updatedAt: "2026-05-29T00:01:00.000Z",
        msgCount: 1,
        lastEvent: "fixture started",
        toolCount: 0,
      },
    ],
    transcriptBySession: {
      "run-fixture": [{ kind: "assistant", ts: "2026-05-29T00:01:00.000Z", text: "Fixture transcript." }],
    },
    timeline: [{ t: "2026-05-29T00:01:00.000Z", sess: "run-fixture", kind: "assistant", text: "Fixture transcript." }],
    defaultSessionId: "run-fixture",
    ...overrides,
  };
}

export function makeHarnessSidebar(overrides: Partial<SidebarModel> = {}): SidebarModel {
  const dashboard = makeHarnessDashboard();
  return {
    providerGates: dashboard.providerGates,
    runningAgents: dashboard.runningAgents,
    reviewIssues: [],
    activity: dashboard.activity,
    sessions: makeHarnessHistory().sessions,
    chat: dashboard.chat,
    totals: harnessTotals,
    ...overrides,
  };
}

export interface ApiModeDataSourceOptions {
  referenceData?: ReferenceData;
  dashboard?: Partial<DashboardModel>;
  issueBoard?: Partial<IssueBoardModel>;
  issueDetails?: Record<string, IssueDetailModel | null>;
  history?: Partial<HistoryModel>;
  sidebar?: Partial<SidebarModel>;
  orchestratorChat?: ChatMessage[];
}

export function createApiModeDataSource(options: ApiModeDataSourceOptions = {}): SymphonyDataSource {
  const referenceData = options.referenceData ?? harnessReferenceData;
  const primaryIssue = makeHarnessIssue();
  const dashboard = makeHarnessDashboard(options.dashboard);
  const issueBoard = makeHarnessIssueBoard(primaryIssue, options.issueBoard);
  const history = makeHarnessHistory(options.history);
  const sidebar = makeHarnessSidebar(options.sidebar);
  const orchestratorChat = options.orchestratorChat ?? dashboard.chat;
  const issueDetails = options.issueDetails ?? {
    [primaryIssue.id]: {
      issue: primaryIssue,
      activity: dashboard.activity,
      runs: history.sessions,
      transcript: history.transcriptBySession[history.defaultSessionId] ?? [],
    },
  };

  return {
    async getReferenceData() {
      return referenceData;
    },
    async getDashboard() {
      return dashboard;
    },
    async getIssueBoard() {
      return issueBoard;
    },
    async getIssueDetail(issueId) {
      return issueDetails[issueId] ?? null;
    },
    async getHistory() {
      return history;
    },
    async getSessions() {
      return history.sessions;
    },
    async getTranscript(sessionId) {
      return history.transcriptBySession[sessionId] ?? [];
    },
    async getSidebar() {
      return sidebar;
    },
    async getOrchestratorChat() {
      return orchestratorChat;
    },
    async sendOrchestratorMessage(input) {
      return [...orchestratorChat, { who: "user", text: input }];
    },
  };
}

export interface RenderWithSymphonyProvidersOptions extends ApiModeDataSourceOptions {
  dataSource?: SymphonyDataSource;
}

export function renderWithSymphonyProviders(
  children: ReactNode,
  options: RenderWithSymphonyProvidersOptions = {},
): string {
  const referenceData = options.referenceData ?? harnessReferenceData;
  const dataSource = options.dataSource ?? createApiModeDataSource({ ...options, referenceData });
  return renderToStaticMarkup(
    <DataSourceProvider value={dataSource}>
      <ReferenceDataProvider value={referenceData}>{children}</ReferenceDataProvider>
    </DataSourceProvider>,
  );
}

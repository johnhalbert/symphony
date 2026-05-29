import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DashboardView } from "../src/components/dashboard/DashboardView";
import type { SymphonyDataSource } from "../src/data/dataSource";
import { DataSourceProvider } from "../src/data/dataSourceContext";
import type { ChatMessage, DashboardModel } from "../src/types/symphony";

const dashboardWithEmbeddedChat: DashboardModel = {
  projectName: "Symphony",
  repoLabel: "api/repo",
  branch: "api-branch",
  workflowLabel: "WORKFLOW.api@api-branch",
  pollLabel: "poll 5s",
  agentUsageLabel: "0/4 agents",
  concurrencyCap: 4,
  providerGates: [],
  runningAgents: [],
  activity: [],
  chat: [{ who: "agent", text: "dashboard embedded chat should not render", suggestions: ["dashboard stale suggestion"] }],
  totals: {
    backlog: 0,
    todo: 0,
    progress: 0,
    review: 0,
    done: 0,
    cancelled: 0,
    open: 0,
    all: 0,
    completeness: 0,
  },
};

function dataSourceForChat(chat: ChatMessage[]): SymphonyDataSource {
  return {
    async getReferenceData() {
      return { users: {}, labels: {} };
    },
    async getDashboard() {
      return dashboardWithEmbeddedChat;
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
      return { providerGates: [], runningAgents: [], reviewIssues: [], activity: [], sessions: [], chat, totals: dashboardWithEmbeddedChat.totals };
    },
    async getOrchestratorChat() {
      return chat;
    },
    async sendOrchestratorMessage(input: string) {
      return [...chat, { who: "user", text: input }];
    },
  };
}

function renderDashboardChat(props: {
  chat: ChatMessage[];
  loading?: boolean;
  error?: string | null;
}): string {
  return renderToStaticMarkup(
    <DataSourceProvider value={dataSourceForChat(props.chat)}>
      <DashboardView
        dashboard={dashboardWithEmbeddedChat}
        orchestratorChat={props.chat}
        orchestratorChatError={props.error ?? null}
        orchestratorChatLoading={props.loading ?? false}
      />
    </DataSourceProvider>,
  );
}

describe("dashboard orchestrator chat integration", () => {
  it("renders the dedicated orchestrator chat payload instead of embedded dashboard chat", () => {
    const markup = renderDashboardChat({
      chat: [{ who: "agent", text: "dedicated GET chat", suggestions: ["dedicated suggestion"] }],
    });

    expect(markup).toContain("dedicated GET chat");
    expect(markup).toContain("dedicated suggestion");
    expect(markup).not.toContain("dashboard embedded chat should not render");
    expect(markup).not.toContain("dashboard stale suggestion");
  });

  it("keeps an empty dedicated chat response empty instead of falling back to dashboard chat", () => {
    const markup = renderDashboardChat({ chat: [] });

    expect(markup).toContain("Symphony orchestrator");
    expect(markup).not.toContain("dashboard embedded chat should not render");
    expect(markup).not.toContain("dashboard stale suggestion");
  });

  it("surfaces loading and error states without substituting dashboard chat", () => {
    const markup = renderDashboardChat({ chat: [], loading: true, error: "Symphony API returned HTTP 503" });

    expect(markup).toContain("Loading orchestrator chat");
    expect(markup).toContain("Orchestrator chat unavailable: Symphony API returned HTTP 503");
    expect(markup).not.toContain("dashboard embedded chat should not render");
  });
});

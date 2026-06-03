import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DashboardView } from "../src/components/dashboard/DashboardView";
import { SidebarViews } from "../src/components/sidebar/SidebarViews";
import { normalizeOrchestratorChatModel, orchestratorChatModelFromMessages } from "../src/data/orchestratorChat";
import { createTranscriptWindowResponse } from "../src/data/transcriptWindow";
import type { SymphonyDataSource } from "../src/data/dataSource";
import { DataSourceProvider } from "../src/data/dataSourceContext";
import type { ChatMessage, DashboardModel, OrchestratorChatModel, OrchestratorChatState, SidebarModel } from "../src/types/symphony";

const emptyChatCopy = "No durable orchestrator chat messages are available yet.";

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

const sidebarWithEmbeddedChat: SidebarModel = {
  providerGates: [],
  runningAgents: [],
  reviewIssues: [],
  activity: [],
  sessions: [],
  chat: [{ who: "agent", text: "sidebar embedded chat should not render", suggestions: ["sidebar stale suggestion"] }],
  totals: dashboardWithEmbeddedChat.totals,
};

function dataSourceForChat(chat: OrchestratorChatModel | ChatMessage[]): SymphonyDataSource {
  const chatModel = normalizeOrchestratorChatModel(chat);
  const chatMessages = chatModel.chat;
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
      return createTranscriptWindowResponse([]);
    },
    async getSidebar() {
      return { providerGates: [], runningAgents: [], reviewIssues: [], activity: [], sessions: [], chat: chatMessages, totals: dashboardWithEmbeddedChat.totals };
    },
    async getOrchestratorChat() {
      return chatModel;
    },
    async sendOrchestratorMessage(input: string) {
      return [...chatMessages, { who: "user", text: input }];
    },
  };
}

function renderDashboardChat(props: {
  chat: OrchestratorChatModel | ChatMessage[];
  loading?: boolean;
  error?: string | null;
  readOnly?: boolean;
}): string {
  return renderToStaticMarkup(
    <DataSourceProvider value={dataSourceForChat(props.chat)}>
      <DashboardView
        dashboard={dashboardWithEmbeddedChat}
        orchestratorChat={props.chat}
        orchestratorChatError={props.error ?? null}
        orchestratorChatLoading={props.loading ?? false}
        orchestratorChatReadOnly={props.readOnly ?? false}
      />
    </DataSourceProvider>,
  );
}

function renderSidebarChat(props: {
  chat: OrchestratorChatModel | ChatMessage[];
  loading?: boolean;
  error?: string | null;
  readOnly?: boolean;
}): string {
  return renderToStaticMarkup(
    <DataSourceProvider value={dataSourceForChat(props.chat)}>
      <SidebarViews
        sidebar={sidebarWithEmbeddedChat}
        variant="chat"
        orchestratorChat={props.chat}
        orchestratorChatError={props.error ?? null}
        orchestratorChatLoading={props.loading ?? false}
        orchestratorChatReadOnly={props.readOnly ?? false}
      />
    </DataSourceProvider>,
  );
}

function chatModelForState(state: OrchestratorChatState, chat: ChatMessage[] = []): OrchestratorChatModel {
  return orchestratorChatModelFromMessages(chat, {
    conversationId: `${state}-room`,
    state,
    conversationStatus: state === "empty" ? "completed" : state,
    sourceShape: "reducer_envelope",
  });
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

  it("keeps an empty dedicated chat response empty with explicit loaded-empty copy", () => {
    const markup = renderDashboardChat({ chat: [] });

    expect(markup).toContain("Symphony orchestrator");
    expect(markup).toContain(emptyChatCopy);
    expect(markup).not.toContain("dashboard embedded chat should not render");
    expect(markup).not.toContain("dashboard stale suggestion");
  });

  it("renders reducer state metadata for empty, active, failed, disabled, and unavailable dashboard chat without fake messages", () => {
    const cases = [
      { state: "empty" as const, expected: "is empty" },
      { state: "pending" as const, expected: "is pending" },
      { state: "streaming" as const, expected: "is streaming" },
      { state: "failed" as const, expected: "failed" },
      { state: "disabled" as const, expected: "is disabled" },
      { state: "unavailable" as const, expected: "is unavailable" },
    ];

    for (const testCase of cases) {
      const chat =
        testCase.state === "pending" || testCase.state === "streaming" || testCase.state === "failed"
          ? [{ who: "agent" as const, text: `durable ${testCase.state} message`, status: testCase.state }]
          : [];
      const markup = renderDashboardChat({ chat: chatModelForState(testCase.state, chat) });

      expect(markup).toContain(testCase.expected);
      expect(markup).toContain(`data-orchestrator-chat-state=\"${testCase.state}\"`);
      if (chat.length > 0) expect(markup).toContain(`durable ${testCase.state} message`);
      expect(markup).not.toContain("dashboard embedded chat should not render");
      expect(markup).not.toContain("dashboard stale suggestion");
      expect(markup).not.toMatch(/fake message|placeholder message|mock message/i);
    }
  });

  it("surfaces loading and error states without substituting dashboard chat", () => {
    const markup = renderDashboardChat({ chat: [], loading: true, error: "Symphony API returned HTTP 503" });

    expect(markup).toContain("Loading orchestrator chat");
    expect(markup).toContain("Orchestrator chat unavailable: Symphony API returned HTTP 503");
    expect(markup).not.toContain("dashboard embedded chat should not render");
  });

  it("keeps stale dashboard chat messages visible while refreshes load or fail", () => {
    const markup = renderDashboardChat({
      chat: [{ who: "agent", text: "previous dashboard chat from API" }],
      loading: true,
      error: "Symphony API returned HTTP 503",
    });

    expect(markup).toContain("Refreshing orchestrator chat... showing previous messages.");
    expect(markup).toContain("Could not refresh orchestrator chat: Symphony API returned HTTP 503. Showing previous messages.");
    expect(markup).toContain("previous dashboard chat from API");
    expect(markup).not.toContain("Orchestrator chat unavailable: Symphony API returned HTTP 503");
    expect(markup).not.toContain("dashboard embedded chat should not render");
  });

  it("renders API-mode dashboard chat as read-only for the exact empty API response", () => {
    const markup = renderDashboardChat({ chat: [], readOnly: true });

    expect(markup).toContain("Symphony orchestrator");
    expect(markup).toContain(emptyChatCopy);
    expect(markup).toContain("API mode shows durable chat history only");
    expect(markup).toContain("Sending commands from this web chat is not supported yet");
    expect(markup).toContain("no orchestrator action will be dispatched");
    expect(markup).not.toContain("Ask about the project, or issue a command");
    expect(markup).not.toContain("/ commands");
    expect(markup).not.toContain("codex-1");
    expect(markup).not.toContain("type=\"submit\"");
  });

  it("preserves mock-mode dashboard chat send affordances", () => {
    const markup = renderDashboardChat({ chat: [] });

    expect(markup).toContain("Ask about the project, or issue a command");
    expect(markup).toContain("show stalled agents");
    expect(markup).toContain("/ commands");
    expect(markup).toContain("agent unavailable");
    expect(markup).not.toContain("codex-1");
    expect(markup).not.toContain("pause SYM-42");
    expect(markup).toContain("type=\"submit\"");
    expect(markup).not.toContain("API mode shows durable chat history only");
  });
});

describe("sidebar orchestrator chat integration", () => {
  it("renders the dedicated orchestrator chat payload instead of embedded sidebar chat", () => {
    const markup = renderSidebarChat({
      chat: [{ who: "agent", text: "dedicated sidebar GET chat", suggestions: ["dedicated sidebar suggestion"] }],
    });

    expect(markup).toContain("dedicated sidebar GET chat");
    expect(markup).toContain("dedicated sidebar suggestion");
    expect(markup).not.toContain("sidebar embedded chat should not render");
    expect(markup).not.toContain("sidebar stale suggestion");
  });

  it("keeps an empty dedicated sidebar chat response empty with explicit loaded-empty copy", () => {
    const markup = renderSidebarChat({ chat: [] });

    expect(markup).toContain(emptyChatCopy);
    expect(markup).not.toContain("sidebar embedded chat should not render");
    expect(markup).not.toContain("sidebar stale suggestion");
  });

  it("renders reducer state metadata for empty, active, failed, disabled, and unavailable sidebar chat without fake messages", () => {
    const cases = [
      { state: "empty" as const, expected: "is empty" },
      { state: "pending" as const, expected: "is pending" },
      { state: "streaming" as const, expected: "is streaming" },
      { state: "failed" as const, expected: "failed" },
      { state: "disabled" as const, expected: "is disabled" },
      { state: "unavailable" as const, expected: "is unavailable" },
    ];

    for (const testCase of cases) {
      const chat =
        testCase.state === "pending" || testCase.state === "streaming" || testCase.state === "failed"
          ? [{ who: "agent" as const, text: `compact durable ${testCase.state} message`, status: testCase.state }]
          : [];
      const markup = renderSidebarChat({ chat: chatModelForState(testCase.state, chat) });

      expect(markup).toContain(testCase.expected);
      expect(markup).toContain(`data-orchestrator-chat-state=\"${testCase.state}\"`);
      if (chat.length > 0) expect(markup).toContain(`compact durable ${testCase.state} message`);
      expect(markup).not.toContain("sidebar embedded chat should not render");
      expect(markup).not.toContain("sidebar stale suggestion");
      expect(markup).not.toMatch(/fake message|placeholder message|mock message/i);
    }
  });

  it("surfaces sidebar loading and error states without substituting embedded chat", () => {
    const markup = renderSidebarChat({ chat: [], loading: true, error: "Symphony API returned HTTP 503" });

    expect(markup).toContain("Loading orchestrator chat");
    expect(markup).toContain("Orchestrator chat unavailable: Symphony API returned HTTP 503");
    expect(markup).not.toContain("sidebar embedded chat should not render");
    expect(markup).not.toContain("sidebar stale suggestion");
  });

  it("keeps stale compact sidebar chat messages visible while refreshes load or fail", () => {
    const markup = renderSidebarChat({
      chat: [{ who: "agent", text: "previous compact sidebar chat from API" }],
      loading: true,
      error: "Symphony API returned HTTP 503",
    });

    expect(markup).toContain("Refreshing orchestrator chat... showing previous messages.");
    expect(markup).toContain("Could not refresh orchestrator chat: Symphony API returned HTTP 503. Showing previous messages.");
    expect(markup).toContain("previous compact sidebar chat from API");
    expect(markup).not.toContain("Orchestrator chat unavailable: Symphony API returned HTTP 503");
    expect(markup).not.toContain("sidebar embedded chat should not render");
  });

  it("renders API-mode compact sidebar chat as read-only for the exact empty API response", () => {
    const markup = renderSidebarChat({ chat: [], readOnly: true });

    expect(markup).toContain(emptyChatCopy);
    expect(markup).toContain("read-only API mode");
    expect(markup).toContain("API mode shows durable chat history only");
    expect(markup).toContain("Sending commands from this compact chat is not supported yet");
    expect(markup).toContain("no orchestrator action will be dispatched");
    expect(markup).not.toContain("Ask or command");
    expect(markup).not.toContain("@ context");
    expect(markup).not.toContain("codex-1 · cycle 14");
  });

  it("preserves mock-mode compact sidebar chat send affordances", () => {
    const markup = renderSidebarChat({ chat: [] });

    expect(markup).toContain("Ask or command");
    expect(markup).toContain("@ context");
    expect(markup).toContain("agent context unavailable");
    expect(markup).not.toContain("codex-1 · cycle 14");
    expect(markup).not.toContain("read-only API mode");
    expect(markup).not.toContain("Sending commands from this compact chat is not supported yet");
  });
});

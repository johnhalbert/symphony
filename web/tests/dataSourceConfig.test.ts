import { afterEach, describe, expect, it, vi } from "vitest";
import { createDataSource, resolveDataSourceConfig } from "../src/data/dataSourceConfig";
import { createTranscriptWindowResponse } from "../src/data/transcriptWindow";
import type { SymphonyDataSource } from "../src/data/dataSource";
import { orchestratorChatModelFromMessages } from "../src/data/orchestratorChat";
import type { DashboardModel } from "../src/types/symphony";

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

const demoDashboard: DashboardModel = {
  projectName: "Explicit Demo",
  repoLabel: "demo/repo",
  branch: "demo",
  workflowLabel: "WORKFLOW.md",
  pollLabel: "poll demo",
  agentUsageLabel: "0 agents",
  concurrencyCap: 0,
  providerGates: [],
  runningAgents: [],
  activity: [],
  chat: [],
  totals: { backlog: 0, todo: 0, progress: 0, review: 0, done: 0, cancelled: 0, open: 0, all: 0, completeness: 0 },
};

const demoDataSource: SymphonyDataSource = {
  async getReferenceData() {
    return { labels: {}, users: {} };
  },
  async getDashboard() {
    return demoDashboard;
  },
  async getIssueBoard() {
    return {
      issues: [],
      backlog: [],
      lanes: { todo: [], progress: [], review: [] },
      cycleLabel: "",
      cycleDateRange: "",
      selectedIssueId: "",
    };
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
    return { providerGates: [], runningAgents: [], reviewIssues: [], activity: [], sessions: [], chat: [], totals: demoDashboard.totals };
  },
  async getOrchestratorChat() {
    return orchestratorChatModelFromMessages([]);
  },
  async sendOrchestratorMessage(input) {
    return [{ who: "user", text: input }];
  },
};

describe("web data-source configuration", () => {
  it("defaults unset local and production builds to same-origin API mode", () => {
    expect(resolveDataSourceConfig({})).toEqual({ mode: "api", apiBaseUrl: "" });
    expect(resolveDataSourceConfig({ PROD: true })).toEqual({ mode: "api", apiBaseUrl: "" });
    expect(resolveDataSourceConfig({ MODE: " production " })).toEqual({ mode: "api", apiBaseUrl: "" });
  });

  it("treats empty data-source and base-URL values as unset API configuration", () => {
    expect(resolveDataSourceConfig({ VITE_SYMPHONY_DATA_SOURCE: "  ", VITE_SYMPHONY_API_BASE_URL: "  " })).toEqual({
      mode: "api",
      apiBaseUrl: "",
    });
  });

  it("preserves existing API activation when an absolute API base URL is configured", () => {
    expect(resolveDataSourceConfig({ VITE_SYMPHONY_API_BASE_URL: " https://symphony.test " })).toEqual({
      mode: "api",
      apiBaseUrl: "https://symphony.test",
    });
  });

  it("treats a slash API base URL as configured same-origin API mode", () => {
    expect(resolveDataSourceConfig({ VITE_SYMPHONY_API_BASE_URL: " / " })).toEqual({
      mode: "api",
      apiBaseUrl: "/",
    });
  });

  it("activates API mode with same-origin requests when Vite proxy mode is selected", () => {
    expect(resolveDataSourceConfig({ VITE_SYMPHONY_DATA_SOURCE: " api " })).toEqual({ mode: "api", apiBaseUrl: "" });
  });

  it("keeps mock/demo/local data sources as explicit opt-in modes for non-production demo runs", () => {
    expect(resolveDataSourceConfig({ VITE_SYMPHONY_DATA_SOURCE: "mock" })).toEqual({ mode: "mock", apiBaseUrl: "" });
    expect(resolveDataSourceConfig({ VITE_SYMPHONY_DATA_SOURCE: "demo" })).toEqual({ mode: "mock", apiBaseUrl: "" });
    expect(resolveDataSourceConfig({ VITE_SYMPHONY_DATA_SOURCE: "local" })).toEqual({ mode: "mock", apiBaseUrl: "" });
  });

  it("keeps production builds API-backed even when legacy mock aliases are configured", () => {
    expect(resolveDataSourceConfig({ PROD: true, VITE_SYMPHONY_DATA_SOURCE: "mock" })).toEqual({ mode: "api", apiBaseUrl: "" });
    expect(resolveDataSourceConfig({ MODE: " production ", VITE_SYMPHONY_DATA_SOURCE: "local" })).toEqual({ mode: "api", apiBaseUrl: "" });
  });

  it("lets an explicit mock mode override an API base URL for deliberate non-production demo runs", () => {
    expect(
      resolveDataSourceConfig({
        VITE_SYMPHONY_DATA_SOURCE: "mock",
        VITE_SYMPHONY_API_BASE_URL: "https://symphony.test",
      }),
    ).toEqual({ mode: "mock", apiBaseUrl: "https://symphony.test" });
  });

  it("treats invalid mode values as unset instead of disabling the API default", () => {
    expect(
      resolveDataSourceConfig({
        VITE_SYMPHONY_DATA_SOURCE: "not-a-mode",
        VITE_SYMPHONY_API_BASE_URL: "https://symphony.test",
      }),
    ).toEqual({ mode: "api", apiBaseUrl: "https://symphony.test" });
    expect(resolveDataSourceConfig({ VITE_SYMPHONY_DATA_SOURCE: "not-a-mode" })).toEqual({ mode: "api", apiBaseUrl: "" });
  });

  it("creates an API data source for unset config instead of falling back to mock dashboard fixtures", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ projectName: "Runtime API" }));

    await expect(createDataSource(resolveDataSourceConfig({})).getDashboard()).resolves.toEqual({ projectName: "Runtime API" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/web/dashboard", {
      headers: { Accept: "application/json" },
      signal: undefined,
    });
  });

  it("lazy-loads the mock data source only after explicit mock mode is used", async () => {
    const loadMockDataSource = vi.fn(async () => demoDataSource);
    const dataSource = createDataSource({ mode: "mock", apiBaseUrl: "" }, { loadMockDataSource });

    expect(loadMockDataSource).not.toHaveBeenCalled();
    await expect(dataSource.getDashboard()).resolves.toBe(demoDashboard);
    await expect(dataSource.getReferenceData()).resolves.toEqual({ labels: {}, users: {} });
    expect(loadMockDataSource).toHaveBeenCalledTimes(1);
  });

  it("keeps explicit mock/local mode isolated from API-mode SSE subscriptions", () => {
    const loadMockDataSource = vi.fn(async () => demoDataSource);
    const dataSource = createDataSource({ mode: "mock", apiBaseUrl: "https://symphony.test" }, { loadMockDataSource });

    expect(dataSource.subscribeToRealtimeEvents).toBeUndefined();
    expect(dataSource.subscribeToProjectionChanges).toBeUndefined();
    expect(loadMockDataSource).not.toHaveBeenCalled();
  });
});

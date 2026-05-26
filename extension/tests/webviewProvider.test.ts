import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardIssueDetailResponse } from "../src/statusApiTypes";
import type { ExtensionMessage } from "../src/webviewMessages";

const settings = vi.hoisted(() => ({ baseUrl: "http://127.0.0.1:7331", token: "" }));

vi.mock("vscode", () => ({
  commands: { executeCommand: vi.fn() },
  Uri: { joinPath: vi.fn() },
  window: {
    createWebviewPanel: vi.fn(),
  },
  workspace: {
    getConfiguration: () => ({
      get: (key: string) => (key === "baseUrl" ? settings.baseUrl : settings.token),
    }),
  },
}));

vi.mock("../src/settings.js", () => ({
  normalizeBaseUrl: (value: string) => new URL(value.trim().replace(/\/+$/, "")).toString().replace(/\/+$/, ""),
  readSymphonySettings: () => ({ baseUrl: settings.baseUrl, token: settings.token }),
}));

describe("SymphonyPanelProvider message handling", () => {
  beforeEach(() => {
    settings.baseUrl = "http://127.0.0.1:7331";
    settings.token = "";
    vi.clearAllMocks();
  });

  it("posts issue detail with an inline activity error when activity fails", async () => {
    const client = fakeClient();
    client.fetchBoardIssue.mockResolvedValue(issueDetail("ENG-8"));
    client.fetchActivity.mockRejectedValue(new Error("activity down"));
    const { provider, messages } = await testProvider(client);

    await provider.loadIssue("ENG-8");

    const state = messages.find((message) => message.type === "issueDetailState");
    expect(state).toMatchObject({
      type: "issueDetailState",
      issueKey: "ENG-8",
      offset: 0,
      detail: issueDetail("ENG-8"),
      activity: null,
      activityError: "activity down",
    });
    expect(state).not.toHaveProperty("error");
  });

  it("posts transcriptError without a run error when run metadata succeeds", async () => {
    const client = fakeClient();
    client.fetchRun.mockResolvedValue({ runId: "run-1" });
    client.fetchTranscript.mockRejectedValue(new Error("transcript down"));
    const { provider, messages } = await testProvider(client);

    await provider.loadRun("run-1");

    const state = messages.find((message) => message.type === "runState");
    expect(state).toMatchObject({
      type: "runState",
      runId: "run-1",
      offset: 0,
      run: { runId: "run-1" },
      transcript: null,
      transcriptError: "transcript down",
    });
    expect(state).not.toHaveProperty("error");
  });

  it("tags transcript append failures without clearing run metadata", async () => {
    const client = fakeClient();
    client.fetchRun.mockResolvedValue({ runId: "run-1" });
    client.fetchTranscript.mockResolvedValueOnce({ runId: "run-1", offset: 0, limit: 100, nextOffset: 100, events: [] });
    const { provider, messages } = await testProvider(client);
    await provider.loadRun("run-1");
    messages.length = 0;
    client.fetchTranscript.mockRejectedValueOnce(new Error("page down"));

    await provider.loadTranscript("run-1", 100);

    expect(messages).toEqual([
      expect.objectContaining({
        type: "runState",
        runId: "run-1",
        offset: 100,
        run: null,
        transcript: null,
        transcriptError: "page down",
        appendTranscript: true,
      }),
    ]);
    expect(messages[0]).not.toHaveProperty("error");
  });

  it("refetches and tags global activity head on later dashboard refreshes", async () => {
    const client = fakeClient();
    client.fetchBoard.mockResolvedValue({ generatedAt: "now", tracker: {}, columns: [], issues: [], counts: {} });
    client.fetchActivity.mockResolvedValue({ generatedAt: "now", offset: 0, limit: 50, nextOffset: 50, activity: [], counts: {}, source: {}, filter: { issue: null } });
    const { provider, messages } = await testProvider(client);

    await provider.loadDashboard({ refresh: false });
    messages.length = 0;
    await provider.loadDashboard({ refresh: true });

    expect(client.fetchActivity).toHaveBeenCalledTimes(2);
    expect(client.fetchActivity).toHaveBeenLastCalledWith(settings.baseUrl, expect.objectContaining({ offset: 0, limit: 50 }));
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "dashboardState",
        activity: expect.objectContaining({ offset: 0 }),
        reconcileActivityHead: true,
      }),
    );
  });

  it("refreshes selected issue activity head with the resolved activity key", async () => {
    const client = fakeClient();
    client.fetchBoard.mockResolvedValue({ generatedAt: "now", tracker: {}, columns: [], issues: [], counts: {} });
    client.fetchBoardIssue.mockResolvedValue(issueDetail("ENG-8", "issue-id"));
    client.fetchActivity.mockResolvedValue({ generatedAt: "now", offset: 0, limit: 50, nextOffset: null, activity: [], counts: {}, source: {}, filter: { issue: null } });
    const { provider, messages } = await testProvider(client);

    await provider.loadIssue("issue-id");
    messages.length = 0;
    await provider.loadDashboard({ refresh: true });

    expect(client.fetchActivity).toHaveBeenCalledWith(settings.baseUrl, expect.objectContaining({ issue: "ENG-8", offset: 0, limit: 50 }));
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "issueDetailState",
        issueKey: "issue-id",
        activity: expect.objectContaining({ offset: 0 }),
        reconcileActivityHead: true,
      }),
    );
  });
});

function fakeClient() {
  return {
    fetchBoard: vi.fn(),
    fetchBoardIssue: vi.fn(),
    fetchActivity: vi.fn(),
    fetchRun: vi.fn(),
    fetchTranscript: vi.fn(),
    openWorkspace: vi.fn(),
    probeState: vi.fn(),
  };
}

async function testProvider(client: ReturnType<typeof fakeClient>) {
  const { SymphonyPanelProvider } = await import("../src/webviewProvider.js");
  const provider = new SymphonyPanelProvider({} as never, client as never);
  const messages: ExtensionMessage[] = [];
  Object.defineProperty(provider, "postWebviewMessage", {
    value: async (message: ExtensionMessage) => {
      messages.push(message);
    },
  });
  return {
    provider: provider as unknown as {
      loadDashboard(options: { refresh: boolean }): Promise<void>;
      loadIssue(issueKey: string): Promise<void>;
      loadRun(runId: string): Promise<void>;
      loadTranscript(runId: string, offset: number): Promise<void>;
    },
    messages,
  };
}

function issueDetail(issue: string, id = issue): BoardIssueDetailResponse {
  return {
    issue,
    issueDetails: {
      issue: { identifier: issue, id },
    },
  } as BoardIssueDetailResponse;
}

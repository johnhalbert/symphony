import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscodeTypes from "vscode";
import type { DashboardViewState } from "../src/dashboardTypes";
import type { SymphonyClient } from "../src/symphonyClient";
import { SymphonyPanelProvider } from "../src/webviewProvider";

type MessageHandler = (message: unknown) => void;

const settingsState = vi.hoisted(() => ({
  baseUrl: "http://127.0.0.1:7331",
  token: "token",
}));

const vscodeMock = vi.hoisted(() => {
  return {
    commands: { executeCommand: vi.fn(async () => undefined) },
    window: {
      createWebviewPanel: vi.fn(),
      showInformationMessage: vi.fn(),
      showWarningMessage: vi.fn(),
    },
    workspace: {
      getConfiguration: vi.fn(() => ({
        get: vi.fn((key: string) => (key === "baseUrl" ? "http://127.0.0.1:7331" : "token")),
      })),
    },
    Uri: {
      joinPath: vi.fn((_base: unknown, ...parts: string[]) => ({ toString: () => parts.join("/") })),
    },
    ViewColumn: { Beside: 2 },
  };
});

vi.mock("vscode", () => vscodeMock);

vi.mock("../src/settings", () => ({
  readSymphonySettings: () => ({ ...settingsState }),
}));

describe("SymphonyPanelProvider", () => {
  beforeEach(() => {
    vi.useRealTimers();
    settingsState.baseUrl = "http://127.0.0.1:7331";
    settingsState.token = "token";
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("suppresses stale rapid refresh results", async () => {
    let resolveFirst!: (state: DashboardViewState) => void;
    const client = {
      fetchDashboard: vi
        .fn()
        .mockImplementationOnce(() => new Promise<DashboardViewState>((resolve) => {
          resolveFirst = resolve;
        }))
        .mockResolvedValueOnce(stateFor("new")),
      openWorkspace: vi.fn(),
    } satisfies Pick<SymphonyClient, "fetchDashboard" | "openWorkspace">;
    const provider = new SymphonyPanelProvider(extensionUri(), client as unknown as SymphonyClient);
    const view = webviewView(false);
    provider.resolveWebviewView(view);

    const first = provider.refreshDashboard("retry");
    const second = provider.refreshDashboard("retry");
    await second;
    resolveFirst(stateFor("old"));
    await first;

    expect(view.webview.postMessage).toHaveBeenCalledTimes(1);
    expect(view.webview.postMessage).toHaveBeenCalledWith({ type: "dashboardState", state: stateFor("new") });
  });

  it("starts fallback panel polling and stops it on dispose", async () => {
    vi.useFakeTimers();
    const client = {
      fetchDashboard: vi.fn(async () => stateFor("panel")),
      openWorkspace: vi.fn(),
    } satisfies Pick<SymphonyClient, "fetchDashboard" | "openWorkspace">;
    const panel = webviewPanel(true);
    vscodeMock.window.createWebviewPanel.mockReturnValue(panel);
    const provider = new SymphonyPanelProvider(extensionUri(), client as unknown as SymphonyClient);

    await provider.openPanel();

    expect(vi.getTimerCount()).toBe(1);
    panel.disposeCallback?.();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("handles open-workspace messages through the client and refreshes once", async () => {
    const client = {
      fetchDashboard: vi.fn(async () => stateFor("refreshed", { workspaceIssueKey: "ENG-6" })),
      openWorkspace: vi.fn(async () => undefined),
    } satisfies Pick<SymphonyClient, "fetchDashboard" | "openWorkspace">;
    const provider = new SymphonyPanelProvider(extensionUri(), client as unknown as SymphonyClient);
    const view = webviewView(false);
    provider.resolveWebviewView(view);
    await provider.refreshDashboard("visible");
    client.fetchDashboard.mockClear();

    view.webview.messageHandler?.({ type: "openWorkspace", issueKey: "ENG-6" });
    await vi.waitFor(() => expect(client.openWorkspace).toHaveBeenCalledWith("http://127.0.0.1:7331", "token", "ENG-6"));
    await vi.waitFor(() => expect(client.fetchDashboard).toHaveBeenCalledTimes(1));

    expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith("Opened Symphony workspace for ENG-6.");
  });

  it("rejects open-workspace messages before dashboard state is loaded", async () => {
    const client = {
      fetchDashboard: vi.fn(async () => stateFor("unused")),
      openWorkspace: vi.fn(async () => undefined),
    } satisfies Pick<SymphonyClient, "fetchDashboard" | "openWorkspace">;
    const provider = new SymphonyPanelProvider(extensionUri(), client as unknown as SymphonyClient);
    const view = webviewView(false);
    provider.resolveWebviewView(view);

    view.webview.messageHandler?.({ type: "openWorkspace", issueKey: "ENG-6" });

    await vi.waitFor(() =>
      expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith("Unable to open Symphony workspace: Dashboard state unavailable."),
    );
    expect(client.openWorkspace).not.toHaveBeenCalled();
  });

  it("rejects open-workspace messages when the dashboard is not connected", async () => {
    const client = {
      fetchDashboard: vi.fn(async (): Promise<DashboardViewState> => ({
        connection: { kind: "offline", baseUrl: "http://127.0.0.1:7331", reason: "network", detail: "offline" },
        sections: null,
      })),
      openWorkspace: vi.fn(async () => undefined),
    } satisfies Pick<SymphonyClient, "fetchDashboard" | "openWorkspace">;
    const provider = new SymphonyPanelProvider(extensionUri(), client as unknown as SymphonyClient);
    const view = webviewView(false);
    provider.resolveWebviewView(view);
    await provider.refreshDashboard("visible");

    view.webview.messageHandler?.({ type: "openWorkspace", issueKey: "ENG-6" });

    await vi.waitFor(() =>
      expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith("Unable to open Symphony workspace: Dashboard state unavailable."),
    );
    expect(client.openWorkspace).not.toHaveBeenCalled();
  });

  it("rejects unknown policy, required-token, and missing-workspace messages", async () => {
    const client = {
      fetchDashboard: vi.fn(async () => stateFor("unknown-policy", { mutationsRequireToken: null, workspaceIssueKey: "ENG-6" })),
      openWorkspace: vi.fn(async () => undefined),
    } satisfies Pick<SymphonyClient, "fetchDashboard" | "openWorkspace">;
    const provider = new SymphonyPanelProvider(extensionUri(), client as unknown as SymphonyClient);
    const view = webviewView(false);
    provider.resolveWebviewView(view);
    await provider.refreshDashboard("visible");

    view.webview.messageHandler?.({ type: "openWorkspace", issueKey: "ENG-6" });
    await vi.waitFor(() =>
      expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith("Unable to open Symphony workspace: Mutation policy unavailable."),
    );
    expect(client.openWorkspace).not.toHaveBeenCalled();

    vi.clearAllMocks();
    client.fetchDashboard.mockResolvedValueOnce(stateFor("missing-token", { mutationsRequireToken: true, tokenConfigured: true, workspaceIssueKey: "ENG-6" }));
    settingsState.token = "";
    await provider.refreshDashboard("visible");
    view.webview.messageHandler?.({ type: "openWorkspace", issueKey: "ENG-6" });
    await vi.waitFor(() =>
      expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith("Unable to open Symphony workspace: Configure symphony.token to enable."),
    );
    expect(client.openWorkspace).not.toHaveBeenCalled();

    vi.clearAllMocks();
    settingsState.token = "token";
    client.fetchDashboard.mockResolvedValueOnce(stateFor("missing-workspace", { workspaceIssueKey: null }));
    await provider.refreshDashboard("visible");
    view.webview.messageHandler?.({ type: "openWorkspace", issueKey: "CRAFTED-KEY" });
    await vi.waitFor(() =>
      expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith("Unable to open Symphony workspace: No workspace context."),
    );
    expect(client.openWorkspace).not.toHaveBeenCalled();
  });

  it("allows open-workspace without a token when policy does not require one", async () => {
    settingsState.token = "";
    const client = {
      fetchDashboard: vi.fn(async () => stateFor("allowed", { mutationsRequireToken: false, tokenConfigured: false, workspaceIssueKey: "ENG-6" })),
      openWorkspace: vi.fn(async () => undefined),
    } satisfies Pick<SymphonyClient, "fetchDashboard" | "openWorkspace">;
    const provider = new SymphonyPanelProvider(extensionUri(), client as unknown as SymphonyClient);
    const view = webviewView(false);
    provider.resolveWebviewView(view);
    await provider.refreshDashboard("visible");
    client.fetchDashboard.mockClear();

    view.webview.messageHandler?.({ type: "openWorkspace", issueKey: "ENG-6" });

    await vi.waitFor(() => expect(client.openWorkspace).toHaveBeenCalledWith("http://127.0.0.1:7331", "", "ENG-6"));
    expect(vscodeMock.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it("allows workspace context from board and operator rows", async () => {
    const client = {
      fetchDashboard: vi.fn(async () => stateFor("board", { workspaceIssueKey: "BOARD-1", workspaceSource: "board" })),
      openWorkspace: vi.fn(async () => undefined),
    } satisfies Pick<SymphonyClient, "fetchDashboard" | "openWorkspace">;
    const provider = new SymphonyPanelProvider(extensionUri(), client as unknown as SymphonyClient);
    const view = webviewView(false);
    provider.resolveWebviewView(view);
    await provider.refreshDashboard("visible");

    view.webview.messageHandler?.({ type: "openWorkspace", issueKey: "BOARD-1" });
    await vi.waitFor(() => expect(client.openWorkspace).toHaveBeenCalledWith("http://127.0.0.1:7331", "token", "BOARD-1"));
    await vi.waitFor(() => expect(client.fetchDashboard).toHaveBeenCalledTimes(2));

    client.openWorkspace.mockClear();
    client.fetchDashboard.mockClear();
    client.fetchDashboard.mockResolvedValueOnce(stateFor("operator", { workspaceIssueKey: "RUN-1", workspaceSource: "operator" }));
    await provider.refreshDashboard("visible");
    view.webview.messageHandler?.({ type: "openWorkspace", issueKey: "RUN-1" });
    await vi.waitFor(() => expect(client.openWorkspace).toHaveBeenCalledWith("http://127.0.0.1:7331", "token", "RUN-1"));
  });
});

function extensionUri(): vscodeTypes.Uri {
  return { toString: () => "extension:" } as vscodeTypes.Uri;
}

function webviewView(visible: boolean): vscodeTypes.WebviewView & { webview: TestWebview } {
  const webview = testWebview();
  return {
    visible,
    webview,
    onDidChangeVisibility: vi.fn(),
  } as unknown as vscodeTypes.WebviewView & { webview: TestWebview };
}

function webviewPanel(visible: boolean): vscodeTypes.WebviewPanel & { disposeCallback?: () => void } {
  const panel: {
    visible: boolean;
    webview: TestWebview;
    onDidDispose: ReturnType<typeof vi.fn>;
    onDidChangeViewState: ReturnType<typeof vi.fn>;
    reveal: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    disposeCallback?: () => void;
  } = {
    visible,
    webview: testWebview(),
    onDidDispose: vi.fn((callback: () => void) => {
      panel.disposeCallback = callback;
      return { dispose: vi.fn() };
    }),
    onDidChangeViewState: vi.fn(),
    reveal: vi.fn(),
    dispose: vi.fn(),
  };
  return panel as unknown as vscodeTypes.WebviewPanel & { disposeCallback?: () => void };
}

type TestWebview = vscodeTypes.Webview & {
  html: string;
  messageHandler?: MessageHandler;
  postMessage: ReturnType<typeof vi.fn>;
};

function testWebview(): TestWebview {
  const webview = {
    html: "",
    cspSource: "vscode-resource:",
    options: {},
    asWebviewUri: vi.fn((uri: vscodeTypes.Uri) => uri),
    onDidReceiveMessage: vi.fn((handler: MessageHandler) => {
      webview.messageHandler = handler;
      return { dispose: vi.fn() };
    }),
    postMessage: vi.fn(async () => true),
  } as unknown as TestWebview;
  return webview;
}

function stateFor(
  label: string,
  options: {
    mutationsRequireToken?: boolean | null;
    tokenConfigured?: boolean;
    workspaceIssueKey?: string | null;
    workspaceSource?: "active" | "operator" | "board" | "workspaces";
  } = {},
): DashboardViewState {
  const workspaceIssueKey = options.workspaceIssueKey;
  const issueKey = workspaceIssueKey ?? "";
  const workspaceSource = options.workspaceSource ?? "workspaces";
  const workspace = workspaceIssueKey ? workspaceContext(workspaceIssueKey) : null;
  return {
    connection: {
      kind: "connected",
      baseUrl: "http://127.0.0.1:7331",
      generatedAt: label,
      summary: {
        runningCount: 0,
        retryingCount: 0,
        tokenConfigured: options.tokenConfigured ?? true,
        mutationsRequireToken: options.mutationsRequireToken === undefined ? false : options.mutationsRequireToken,
      },
    },
    sections: {
      activeSessions: {
        status: "ready",
        data: {
          sessions:
            workspace && workspaceSource === "active"
              ? [
                  {
                    issueIdentifier: issueKey,
                    issueKey,
                    role: "worker",
                    statusLabel: "running",
                    runId: "run-1",
                    detail: null,
                    workspace,
                  },
                ]
              : [],
        },
      },
      operatorQueues: {
        status: "ready",
        data: {
          running:
            workspace && workspaceSource === "operator"
              ? [
                  {
                    issueIdentifier: issueKey,
                    issueKey,
                    role: "worker",
                    statusLabel: "running",
                    detail: null,
                    workspace,
                  },
                ]
              : [],
          paused: [],
          orphaned: [],
          retrying: [],
        },
      },
      board: {
        status: "ready",
        data: {
          generatedAt: label,
          columns: [],
          counts: null,
          issues:
            workspace && workspaceSource === "board"
              ? [{ issueIdentifier: issueKey, issueKey, title: null, state: null, workspace }]
              : [],
        },
      },
      workspaces: {
        status: "ready",
        data: {
          rows:
            workspace && workspaceSource === "workspaces"
              ? [
                  {
                    workspaceKey: workspace.workspaceKey ?? issueKey,
                    issueIdentifier: issueKey,
                    issueKey,
                    path: workspace.path ?? `C:\\workspaces\\${issueKey}`,
                    sourceKind: workspace.sourceKind,
                    branchName: workspace.branchName,
                  },
                ]
              : [],
        },
      },
      activity: { status: "ready", data: { items: [], totalItems: 0 } },
    },
  };
}

function workspaceContext(issueKey: string) {
  return {
    workspaceKey: issueKey,
    issueId: issueKey,
    issueIdentifier: issueKey,
    path: `C:\\workspaces\\${issueKey}`,
    sourceKind: "dogfood",
    branchName: "eng-6",
  };
}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscodeTypes from "vscode";
import type { DashboardViewState } from "../src/dashboardTypes";
import type { SymphonyClient } from "../src/symphonyClient";
import { SymphonyPanelProvider } from "../src/webviewProvider";

type MessageHandler = (message: unknown) => void;

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
  readSymphonySettings: () => ({ baseUrl: "http://127.0.0.1:7331", token: "token" }),
}));

describe("SymphonyPanelProvider", () => {
  beforeEach(() => {
    vi.useRealTimers();
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
      fetchDashboard: vi.fn(async () => stateFor("refreshed")),
      openWorkspace: vi.fn(async () => undefined),
    } satisfies Pick<SymphonyClient, "fetchDashboard" | "openWorkspace">;
    const provider = new SymphonyPanelProvider(extensionUri(), client as unknown as SymphonyClient);
    const view = webviewView(false);
    provider.resolveWebviewView(view);

    view.webview.messageHandler?.({ type: "openWorkspace", issueKey: "ENG-6" });
    await vi.waitFor(() => expect(client.openWorkspace).toHaveBeenCalledWith("http://127.0.0.1:7331", "token", "ENG-6"));
    await vi.waitFor(() => expect(client.fetchDashboard).toHaveBeenCalledTimes(1));

    expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith("Opened Symphony workspace for ENG-6.");
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

function stateFor(label: string): DashboardViewState {
  return {
    connection: {
      kind: "connected",
      baseUrl: "http://127.0.0.1:7331",
      generatedAt: label,
      summary: { runningCount: 0, tokenConfigured: true, mutationsRequireToken: false },
    },
    sections: {
      activeSessions: { status: "ready", data: { sessions: [] } },
      operatorQueues: { status: "ready", data: { running: [], paused: [], orphaned: [], retrying: [] } },
      board: { status: "ready", data: { generatedAt: label, columns: [], counts: null, issues: [] } },
      workspaces: { status: "ready", data: { rows: [] } },
      activity: { status: "ready", data: { items: [], totalItems: 0 } },
    },
  };
}

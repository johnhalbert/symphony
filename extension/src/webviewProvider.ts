import * as vscode from "vscode";
import type { DashboardRefreshTrigger, DashboardViewState } from "./dashboardTypes";
import { readSymphonySettings } from "./settings";
import type { SymphonyClient } from "./symphonyClient";
import { configureSymphonyWebview } from "./webviewHtml";

export class SymphonyPanelProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = "symphony.panel";
  private static readonly pollIntervalMs = 30_000;

  private view: vscode.WebviewView | null = null;
  private panel: vscode.WebviewPanel | null = null;
  private currentDashboardState: DashboardViewState | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private activeProbe: AbortController | null = null;
  private probeGeneration = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly client: SymphonyClient,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    const configured = configureSymphonyWebview(webviewView.webview, this.extensionUri, this.currentDashboardState);
    webviewView.webview.html = configured.html;
    this.registerWebviewMessages(webviewView.webview);

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        void this.refreshDashboard("visible");
        this.startPolling();
      } else {
        this.stopPolling();
      }
    });

    if (webviewView.visible) {
      void this.refreshDashboard("visible");
      this.startPolling();
    }
  }

  async openPanel(): Promise<void> {
    await vscode.commands.executeCommand("workbench.view.extension.symphony");
    if (this.view) {
      return;
    }

    this.panel = vscode.window.createWebviewPanel("symphony.panel", "Symphony", vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist", "webview")],
    });
    const configured = configureSymphonyWebview(this.panel.webview, this.extensionUri, this.currentDashboardState);
    this.panel.webview.html = configured.html;
    this.registerWebviewMessages(this.panel.webview);
    this.panel.onDidDispose(() => {
      this.panel = null;
    });
    void this.refreshDashboard("openPanel");
  }

  async reprobe(trigger: DashboardRefreshTrigger = "command"): Promise<void> {
    await this.refreshDashboard(trigger);
  }

  async refreshDashboard(trigger: DashboardRefreshTrigger = "command"): Promise<void> {
    this.activeProbe?.abort();
    const controller = new AbortController();
    this.activeProbe = controller;
    const generation = ++this.probeGeneration;
    const settings = readSymphonySettings();
    const state = await this.client.fetchDashboard(settings.baseUrl, settings.token, controller.signal, {
      refreshBoard: shouldRefreshBoard(trigger),
    });
    if (generation !== this.probeGeneration || controller.signal.aborted) return;
    this.currentDashboardState = state;
    await this.postDashboardState(state, generation, controller);
  }

  dispose(): void {
    this.stopPolling();
    this.activeProbe?.abort();
    this.panel?.dispose();
  }

  private registerWebviewMessages(webview: vscode.Webview): void {
    webview.onDidReceiveMessage((message: unknown) => {
      if (!isMessage(message)) return;
      if (message.type === "retry") void this.refreshDashboard("retry");
      if (message.type === "openSettings") void vscode.commands.executeCommand("symphony.openSettings");
    });
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => void this.refreshDashboard("poll"), SymphonyPanelProvider.pollIntervalMs);
  }

  private stopPolling(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private async postDashboardState(state: DashboardViewState, generation: number, controller: AbortController): Promise<void> {
    if (generation !== this.probeGeneration || controller.signal.aborted) return;
    await this.view?.webview.postMessage({ type: "dashboardState", state });
    if (generation !== this.probeGeneration || controller.signal.aborted) return;
    await this.panel?.webview.postMessage({ type: "dashboardState", state });
  }
}

function isMessage(value: unknown): value is { type: "retry" | "openSettings" } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    ((value as { type?: unknown }).type === "retry" || (value as { type?: unknown }).type === "openSettings")
  );
}

function shouldRefreshBoard(trigger: DashboardRefreshTrigger): boolean {
  return trigger === "retry" || trigger === "command";
}

import * as vscode from "vscode";
import { errorMessage } from "./connectionState";
import type { DashboardRefreshTrigger, DashboardViewState } from "./dashboardTypes";
import { openWorkspaceProviderBlockedReason } from "./openWorkspaceGate";
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
      }
      this.updatePolling();
    });

    if (webviewView.visible) {
      void this.refreshDashboard("visible");
    }
    this.updatePolling();
  }

  async openPanel(): Promise<void> {
    await vscode.commands.executeCommand("workbench.view.extension.symphony");
    if (this.view) {
      return;
    }
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      this.updatePolling();
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
      this.updatePolling();
    });
    this.panel.onDidChangeViewState(() => {
      this.updatePolling();
    });
    void this.refreshDashboard("openPanel");
    this.updatePolling();
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
      if (message.type === "openWorkspace") void this.openWorkspace(message.issueKey);
    });
  }

  private async openWorkspace(issueKey: string): Promise<void> {
    const settings = readSymphonySettings();
    const blockedReason = openWorkspaceProviderBlockedReason(this.currentDashboardState, issueKey, settings.token);
    if (blockedReason) {
      void vscode.window.showWarningMessage(`Unable to open Symphony workspace: ${blockedReason}`);
      return;
    }

    try {
      await this.client.openWorkspace(settings.baseUrl, settings.token, issueKey);
      void vscode.window.showInformationMessage(`Opened Symphony workspace for ${issueKey}.`);
      await this.refreshDashboard("openWorkspace");
    } catch (error) {
      void vscode.window.showWarningMessage(`Unable to open Symphony workspace: ${errorMessage(error)}`);
    }
  }

  private updatePolling(): void {
    const shouldPoll = Boolean(this.view?.visible || this.panel?.visible);
    if (!shouldPoll) {
      this.stopPolling();
      return;
    }
    this.startPolling();
  }

  private startPolling(): void {
    if (this.pollTimer) return;
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

function isMessage(value: unknown): value is { type: "retry" | "openSettings" } | { type: "openWorkspace"; issueKey: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    ((value as { type?: unknown }).type === "retry" ||
      (value as { type?: unknown }).type === "openSettings" ||
      ((value as { type?: unknown }).type === "openWorkspace" && typeof (value as { issueKey?: unknown }).issueKey === "string"))
  );
}

function shouldRefreshBoard(trigger: DashboardRefreshTrigger): boolean {
  return trigger === "retry" || trigger === "command" || trigger === "openWorkspace";
}

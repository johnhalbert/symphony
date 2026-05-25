import * as vscode from "vscode";
import type { ConnectionState } from "./connectionState";
import { readSymphonySettings } from "./settings";
import type { SymphonyClient } from "./symphonyClient";
import { configureSymphonyWebview } from "./webviewHtml";

export class SymphonyPanelProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = "symphony.panel";
  private static readonly pollIntervalMs = 30_000;

  private view: vscode.WebviewView | null = null;
  private panel: vscode.WebviewPanel | null = null;
  private currentState: ConnectionState | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private activeProbe: AbortController | null = null;
  private probeGeneration = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly client: SymphonyClient,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    const configured = configureSymphonyWebview(webviewView.webview, this.extensionUri, this.currentState);
    webviewView.webview.html = configured.html;
    this.registerWebviewMessages(webviewView.webview);

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        void this.reprobe();
        this.startPolling();
      } else {
        this.stopPolling();
      }
    });

    if (webviewView.visible) {
      void this.reprobe();
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
    const configured = configureSymphonyWebview(this.panel.webview, this.extensionUri, this.currentState);
    this.panel.webview.html = configured.html;
    this.registerWebviewMessages(this.panel.webview);
    this.panel.onDidDispose(() => {
      this.panel = null;
    });
    void this.reprobe();
  }

  async reprobe(): Promise<void> {
    this.activeProbe?.abort();
    const controller = new AbortController();
    this.activeProbe = controller;
    const generation = ++this.probeGeneration;
    const settings = readSymphonySettings();
    const state = await this.client.probeState(settings.baseUrl, settings.token, controller.signal);
    if (generation !== this.probeGeneration || controller.signal.aborted) return;
    this.currentState = state;
    await this.postState(state);
  }

  dispose(): void {
    this.stopPolling();
    this.activeProbe?.abort();
    this.panel?.dispose();
  }

  private registerWebviewMessages(webview: vscode.Webview): void {
    webview.onDidReceiveMessage((message: unknown) => {
      if (!isMessage(message)) return;
      if (message.type === "retry") void this.reprobe();
      if (message.type === "openSettings") void vscode.commands.executeCommand("symphony.openSettings");
    });
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => void this.reprobe(), SymphonyPanelProvider.pollIntervalMs);
  }

  private stopPolling(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private async postState(state: ConnectionState): Promise<void> {
    await this.view?.webview.postMessage({ type: "connectionState", state });
    await this.panel?.webview.postMessage({ type: "connectionState", state });
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

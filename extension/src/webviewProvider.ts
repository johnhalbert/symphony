import * as vscode from "vscode";
import { errorMessage } from "./connectionState";
import type { ConnectionState } from "./connectionState";
import { readSymphonySettings } from "./settings";
import type { ActivityFeedResponse, BoardIssueDetailResponse, IssueBoardResponse, TranscriptPage } from "./statusApiTypes";
import type { SymphonyClient } from "./symphonyClient";
import { configureSymphonyWebview } from "./webviewHtml";

type WebviewMessage =
  | { type: "retry" }
  | { type: "refresh" }
  | { type: "openSettings" }
  | { type: "selectIssue"; issueKey: string }
  | { type: "loadMoreActivity"; offset: number }
  | { type: "loadMoreIssueActivity"; issueKey: string; offset: number }
  | { type: "selectRun"; runId: string }
  | { type: "loadMoreTranscript"; runId: string; offset: number }
  | { type: "openWorkspace"; issueKey: string };

type ExtensionMessage =
  | { type: "connectionState"; state: ConnectionState }
  | { type: "dashboardLoading" }
  | { type: "dashboardState"; board: IssueBoardResponse | null; activity: ActivityFeedResponse | null; boardError?: string | undefined; activityError?: string | undefined; appendActivity?: boolean }
  | { type: "issueDetailState"; detail: BoardIssueDetailResponse | null; activity: ActivityFeedResponse | null; error?: string | undefined; activityError?: string | undefined; appendActivity?: boolean }
  | { type: "runState"; run: Record<string, unknown> | null; transcript: TranscriptPage | null; error?: string | undefined; appendTranscript?: boolean }
  | { type: "operationResult"; level: "info" | "error"; message: string };

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
    if (state.kind === "connected") {
      await this.loadDashboard({ refresh: false, signal: controller.signal });
    }
  }

  dispose(): void {
    this.stopPolling();
    this.activeProbe?.abort();
    this.panel?.dispose();
  }

  private registerWebviewMessages(webview: vscode.Webview): void {
    webview.onDidReceiveMessage((message: unknown) => {
      if (!isMessage(message)) return;
      switch (message.type) {
        case "retry":
          void this.reprobe();
          break;
        case "refresh":
          void this.loadDashboard({ refresh: true });
          break;
        case "openSettings":
          void vscode.commands.executeCommand("symphony.openSettings");
          break;
        case "selectIssue":
          void this.loadIssue(message.issueKey);
          break;
        case "loadMoreActivity":
          void this.loadGlobalActivity(message.offset);
          break;
        case "loadMoreIssueActivity":
          void this.loadIssueActivity(message.issueKey, message.offset);
          break;
        case "selectRun":
          void this.loadRun(message.runId);
          break;
        case "loadMoreTranscript":
          void this.loadTranscript(message.runId, message.offset);
          break;
        case "openWorkspace":
          void this.openWorkspace(message.issueKey);
          break;
      }
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
    await this.postWebviewMessage({ type: "connectionState", state });
  }

  private async loadDashboard(options: { refresh: boolean; signal?: AbortSignal | undefined }): Promise<void> {
    const settings = readSymphonySettings();
    await this.postWebviewMessage({ type: "dashboardLoading" });
    const [board, activity] = await Promise.allSettled([
      this.client.fetchBoard(settings.baseUrl, { refresh: options.refresh, signal: options.signal }),
      this.client.fetchActivity(settings.baseUrl, { offset: 0, limit: 50, signal: options.signal }),
    ]);
    await this.postWebviewMessage({
      type: "dashboardState",
      board: board.status === "fulfilled" ? board.value : null,
      activity: activity.status === "fulfilled" ? activity.value : null,
      boardError: board.status === "rejected" ? errorMessage(board.reason) : undefined,
      activityError: activity.status === "rejected" ? errorMessage(activity.reason) : undefined,
    });
  }

  private async loadGlobalActivity(offset: number): Promise<void> {
    try {
      const activity = await this.client.fetchActivity(readSymphonySettings().baseUrl, { offset, limit: 50 });
      await this.postWebviewMessage({ type: "dashboardState", board: null, activity, appendActivity: true });
    } catch (error) {
      await this.postWebviewMessage({
        type: "dashboardState",
        board: null,
        activity: null,
        activityError: errorMessage(error),
        appendActivity: true,
      });
    }
  }

  private async loadIssue(issueKey: string): Promise<void> {
    const settings = readSymphonySettings();
    try {
      const detail = await this.client.fetchBoardIssue(settings.baseUrl, issueKey);
      const activityIssue = detail.issueDetails.issue.identifier ?? detail.issueDetails.issue.id ?? issueKey;
      const activity = await this.client.fetchActivity(settings.baseUrl, { issue: activityIssue, offset: 0, limit: 50 });
      await this.postWebviewMessage({ type: "issueDetailState", detail, activity });
    } catch (error) {
      await this.postWebviewMessage({ type: "issueDetailState", detail: null, activity: null, error: errorMessage(error) });
    }
  }

  private async loadIssueActivity(issueKey: string, offset: number): Promise<void> {
    try {
      const activity = await this.client.fetchActivity(readSymphonySettings().baseUrl, { issue: issueKey, offset, limit: 50 });
      await this.postWebviewMessage({ type: "issueDetailState", detail: null, activity, appendActivity: true });
    } catch (error) {
      await this.postWebviewMessage({
        type: "issueDetailState",
        detail: null,
        activity: null,
        activityError: errorMessage(error),
        appendActivity: true,
      });
    }
  }

  private async loadRun(runId: string): Promise<void> {
    const settings = readSymphonySettings();
    const [run, transcript] = await Promise.allSettled([
      this.client.fetchRun(settings.baseUrl, runId),
      this.client.fetchTranscript(settings.baseUrl, runId, { offset: 0, limit: 100 }),
    ]);
    await this.postWebviewMessage({
      type: "runState",
      run: run.status === "fulfilled" ? run.value : null,
      transcript: transcript.status === "fulfilled" ? transcript.value : null,
      error: run.status === "rejected" ? errorMessage(run.reason) : transcript.status === "rejected" ? errorMessage(transcript.reason) : undefined,
    });
  }

  private async loadTranscript(runId: string, offset: number): Promise<void> {
    try {
      const transcript = await this.client.fetchTranscript(readSymphonySettings().baseUrl, runId, { offset, limit: 100 });
      await this.postWebviewMessage({ type: "runState", run: null, transcript, appendTranscript: true });
    } catch (error) {
      await this.postWebviewMessage({ type: "runState", run: null, transcript: null, error: errorMessage(error), appendTranscript: true });
    }
  }

  private async openWorkspace(issueKey: string): Promise<void> {
    const settings = readSymphonySettings();
    try {
      await this.client.openWorkspace(settings.baseUrl, issueKey, settings.token);
      await this.postWebviewMessage({ type: "operationResult", level: "info", message: "Workspace open request sent." });
    } catch (error) {
      await this.postWebviewMessage({ type: "operationResult", level: "error", message: errorMessage(error) });
    }
  }

  private async postWebviewMessage(message: ExtensionMessage): Promise<void> {
    await this.view?.webview.postMessage(message);
    await this.panel?.webview.postMessage(message);
  }
}

function isMessage(value: unknown): value is WebviewMessage {
  if (typeof value !== "object" || value === null || !("type" in value)) return false;
  const message = value as { type?: unknown; issueKey?: unknown; runId?: unknown; offset?: unknown };
  switch (message.type) {
    case "retry":
    case "refresh":
    case "openSettings":
      return true;
    case "selectIssue":
    case "openWorkspace":
      return typeof message.issueKey === "string" && message.issueKey.trim().length > 0;
    case "loadMoreIssueActivity":
      return typeof message.issueKey === "string" && typeof message.offset === "number";
    case "selectRun":
      return typeof message.runId === "string" && message.runId.trim().length > 0;
    case "loadMoreTranscript":
      return typeof message.runId === "string" && typeof message.offset === "number";
    case "loadMoreActivity":
      return typeof message.offset === "number";
    default:
      return false;
  }
}

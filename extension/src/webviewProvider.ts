import * as vscode from "vscode";
import { errorMessage } from "./connectionState";
import type { ConnectionState } from "./connectionState";
import { normalizeBaseUrl, readSymphonySettings } from "./settings";
import type { SymphonyClient } from "./symphonyClient";
import { configureSymphonyWebview } from "./webviewHtml";
import type { ExtensionMessage, WebviewMessage } from "./webviewMessages";

export class SymphonyPanelProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = "symphony.panel";
  private static readonly pollIntervalMs = 30_000;

  private view: vscode.WebviewView | null = null;
  private panel: vscode.WebviewPanel | null = null;
  private currentState: ConnectionState | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private activeProbe: AbortController | null = null;
  private probeGeneration = 0;
  private dashboardGeneration = 0;
  private activityScopeKey: string | null = null;
  private globalActivityLoaded = false;
  private activeIssueKey: string | null = null;
  private activeIssueActivityKey: string | null = null;
  private issueEpoch = 0;
  private activeRunId: string | null = null;
  private runEpoch = 0;

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
    await this.syncActivityScope(settings.baseUrl);
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
    const scopeKey = await this.syncActivityScope(settings.baseUrl);
    const dashboardGeneration = ++this.dashboardGeneration;
    const reconcileActivityHead = this.globalActivityLoaded;
    await this.postWebviewMessage({ type: "dashboardLoading", dashboardGeneration });
    const [board, activity] = await Promise.allSettled([
      this.client.fetchBoard(settings.baseUrl, { refresh: options.refresh, signal: options.signal }),
      this.client.fetchActivity(settings.baseUrl, { offset: 0, limit: 50, signal: options.signal }),
    ]);
    if (dashboardGeneration !== this.dashboardGeneration || scopeKey !== this.activityScopeKey) return;
    const activityValue = activity.status === "fulfilled" ? activity.value : null;
    if (activityValue) this.globalActivityLoaded = true;
    await this.postWebviewMessage({
      type: "dashboardState",
      dashboardGeneration,
      board: board.status === "fulfilled" ? board.value : null,
      activity: activityValue,
      boardError: board.status === "rejected" ? errorMessage(board.reason) : undefined,
      activityError: activity.status === "rejected" ? errorMessage(activity.reason) : undefined,
      offset: 0,
      reconcileActivityHead,
    });
    if (this.activeIssueKey) {
      await this.refreshIssueActivityHead(this.activeIssueKey, options.signal);
    }
  }

  private async loadGlobalActivity(offset: number): Promise<void> {
    const settings = readSymphonySettings();
    const scopeKey = await this.syncActivityScope(settings.baseUrl);
    const dashboardGeneration = this.dashboardGeneration;
    try {
      const activity = await this.client.fetchActivity(settings.baseUrl, { offset, limit: 50 });
      if (dashboardGeneration !== this.dashboardGeneration || scopeKey !== this.activityScopeKey) return;
      this.globalActivityLoaded = true;
      await this.postWebviewMessage({ type: "dashboardState", dashboardGeneration, board: null, activity, appendActivity: true, offset });
    } catch (error) {
      if (dashboardGeneration !== this.dashboardGeneration || scopeKey !== this.activityScopeKey) return;
      await this.postWebviewMessage({
        type: "dashboardState",
        dashboardGeneration,
        board: null,
        activity: null,
        activityError: errorMessage(error),
        appendActivity: true,
        offset,
      });
    }
  }

  private async loadIssue(issueKey: string): Promise<void> {
    const settings = readSymphonySettings();
    const scopeKey = await this.syncActivityScope(settings.baseUrl);
    this.activeIssueKey = issueKey;
    this.activeIssueActivityKey = null;
    const issueEpoch = ++this.issueEpoch;
    try {
      const detail = await this.client.fetchBoardIssue(settings.baseUrl, issueKey);
      if (!this.shouldPostIssue(issueKey, issueEpoch, scopeKey)) return;
      const activityIssue = detail.issueDetails.issue.identifier ?? detail.issueDetails.issue.id ?? issueKey;
      this.activeIssueActivityKey = activityIssue;
      try {
        const activity = await this.client.fetchActivity(settings.baseUrl, { issue: activityIssue, offset: 0, limit: 50 });
        if (!this.shouldPostIssue(issueKey, issueEpoch, scopeKey)) return;
        await this.postWebviewMessage({ type: "issueDetailState", issueKey, issueEpoch, offset: 0, detail, activity });
      } catch (activityError) {
        if (!this.shouldPostIssue(issueKey, issueEpoch, scopeKey)) return;
        await this.postWebviewMessage({
          type: "issueDetailState",
          issueKey,
          issueEpoch,
          offset: 0,
          detail,
          activity: null,
          activityError: errorMessage(activityError),
        });
      }
    } catch (error) {
      if (!this.shouldPostIssue(issueKey, issueEpoch, scopeKey)) return;
      await this.postWebviewMessage({ type: "issueDetailState", issueKey, issueEpoch, offset: 0, detail: null, activity: null, error: errorMessage(error) });
    }
  }

  private async loadIssueActivity(issueKey: string, offset: number): Promise<void> {
    const settings = readSymphonySettings();
    const scopeKey = await this.syncActivityScope(settings.baseUrl);
    const issueEpoch = this.issueEpoch;
    const activityIssue = this.activeIssueKey === issueKey ? (this.activeIssueActivityKey ?? issueKey) : issueKey;
    try {
      const activity = await this.client.fetchActivity(settings.baseUrl, { issue: activityIssue, offset, limit: 50 });
      if (!this.shouldPostIssue(issueKey, issueEpoch, scopeKey)) return;
      await this.postWebviewMessage({ type: "issueDetailState", issueKey, issueEpoch, offset, detail: null, activity, appendActivity: true });
    } catch (error) {
      if (!this.shouldPostIssue(issueKey, issueEpoch, scopeKey)) return;
      await this.postWebviewMessage({
        type: "issueDetailState",
        issueKey,
        issueEpoch,
        offset,
        detail: null,
        activity: null,
        activityError: errorMessage(error),
        appendActivity: true,
      });
    }
  }

  private async loadRun(runId: string): Promise<void> {
    const settings = readSymphonySettings();
    const scopeKey = await this.syncActivityScope(settings.baseUrl);
    this.activeRunId = runId;
    const runEpoch = ++this.runEpoch;
    const [run, transcript] = await Promise.allSettled([
      this.client.fetchRun(settings.baseUrl, runId),
      this.client.fetchTranscript(settings.baseUrl, runId, { offset: 0, limit: 100 }),
    ]);
    if (!this.shouldPostRun(runId, runEpoch, scopeKey)) return;
    await this.postWebviewMessage({
      type: "runState",
      runId,
      runEpoch,
      offset: 0,
      run: run.status === "fulfilled" ? run.value : null,
      transcript: transcript.status === "fulfilled" ? transcript.value : null,
      ...(run.status === "rejected" ? { error: errorMessage(run.reason) } : {}),
      ...(run.status === "fulfilled" && transcript.status === "rejected" ? { transcriptError: errorMessage(transcript.reason) } : {}),
    });
  }

  private async loadTranscript(runId: string, offset: number): Promise<void> {
    const settings = readSymphonySettings();
    const scopeKey = await this.syncActivityScope(settings.baseUrl);
    const runEpoch = this.runEpoch;
    try {
      const transcript = await this.client.fetchTranscript(settings.baseUrl, runId, { offset, limit: 100 });
      if (!this.shouldPostRun(runId, runEpoch, scopeKey)) return;
      await this.postWebviewMessage({ type: "runState", runId, runEpoch, offset, run: null, transcript, appendTranscript: true });
    } catch (error) {
      if (!this.shouldPostRun(runId, runEpoch, scopeKey)) return;
      await this.postWebviewMessage({ type: "runState", runId, runEpoch, offset, run: null, transcript: null, transcriptError: errorMessage(error), appendTranscript: true });
    }
  }

  private async refreshIssueActivityHead(issueKey: string, signal?: AbortSignal | undefined): Promise<void> {
    const settings = readSymphonySettings();
    const scopeKey = await this.syncActivityScope(settings.baseUrl);
    const issueEpoch = this.issueEpoch;
    const activityIssue = this.activeIssueActivityKey ?? issueKey;
    try {
      const activity = await this.client.fetchActivity(settings.baseUrl, { issue: activityIssue, offset: 0, limit: 50, signal });
      if (!this.shouldPostIssue(issueKey, issueEpoch, scopeKey)) return;
      await this.postWebviewMessage({
        type: "issueDetailState",
        issueKey,
        issueEpoch,
        offset: 0,
        detail: null,
        activity,
        reconcileActivityHead: true,
      });
    } catch (error) {
      if (!this.shouldPostIssue(issueKey, issueEpoch, scopeKey)) return;
      await this.postWebviewMessage({
        type: "issueDetailState",
        issueKey,
        issueEpoch,
        offset: 0,
        detail: null,
        activity: null,
        activityError: errorMessage(error),
        reconcileActivityHead: true,
      });
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

  private async syncActivityScope(baseUrl: string): Promise<string> {
    const scopeKey = safeScopeKey(baseUrl);
    if (this.activityScopeKey !== scopeKey) {
      this.activityScopeKey = scopeKey;
      this.globalActivityLoaded = false;
      this.activeIssueKey = null;
      this.activeIssueActivityKey = null;
      this.activeRunId = null;
      await this.postWebviewMessage({ type: "activityScopeReset", scopeKey });
    }
    return scopeKey;
  }

  private shouldPostIssue(issueKey: string, issueEpoch: number, scopeKey: string): boolean {
    return this.activeIssueKey === issueKey && this.issueEpoch === issueEpoch && this.activityScopeKey === scopeKey;
  }

  private shouldPostRun(runId: string, runEpoch: number, scopeKey: string): boolean {
    return this.activeRunId === runId && this.runEpoch === runEpoch && this.activityScopeKey === scopeKey;
  }
}

function safeScopeKey(baseUrl: string): string {
  try {
    return normalizeBaseUrl(baseUrl);
  } catch {
    return baseUrl.trim();
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

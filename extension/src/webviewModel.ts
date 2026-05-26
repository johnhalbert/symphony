import type { ConnectionState } from "./connectionState";
import type {
  ActivityItem,
  BoardIssueDetailResponse,
  IssueBoardResponse,
  JsonObject,
  TranscriptEvent,
} from "./statusApiTypes";
import type { ExtensionMessage } from "./webviewMessages";

export interface DashboardState {
  connection: ConnectionState | null;
  activeTab: "issues" | "history";
  board: IssueBoardResponse | null;
  boardLoading: boolean;
  boardError: string | null;
  dashboardGeneration: number;
  activityScopeKey: string | null;
  globalActivity: ActivityItem[];
  globalActivityNextOffset: number | null;
  activityError: string | null;
  selectedIssueKey: string | null;
  issueEpoch: number;
  issueDetail: BoardIssueDetailResponse | null;
  issueActivity: ActivityItem[];
  issueActivityNextOffset: number | null;
  issueError: string | null;
  issueActivityError: string | null;
  selectedRunId: string | null;
  runEpoch: number;
  runDetail: JsonObject | null;
  transcript: TranscriptEvent[];
  transcriptNextOffset: number | null;
  transcriptError: string | null;
  runError: string | null;
  operationMessage: { level: "info" | "error"; message: string } | null;
}

export function createInitialDashboardState(connection: ConnectionState | null = null): DashboardState {
  return {
    connection,
    activeTab: "issues",
    board: null,
    boardLoading: false,
    boardError: null,
    dashboardGeneration: 0,
    activityScopeKey: connection?.baseUrl ?? null,
    globalActivity: [],
    globalActivityNextOffset: null,
    activityError: null,
    selectedIssueKey: null,
    issueEpoch: 0,
    issueDetail: null,
    issueActivity: [],
    issueActivityNextOffset: null,
    issueError: null,
    issueActivityError: null,
    selectedRunId: null,
    runEpoch: 0,
    runDetail: null,
    transcript: [],
    transcriptNextOffset: null,
    transcriptError: null,
    runError: null,
    operationMessage: null,
  };
}

export function resetActivityScope(model: DashboardState, scopeKey: string): void {
  model.activityScopeKey = scopeKey;
  model.globalActivity = [];
  model.globalActivityNextOffset = null;
  model.activityError = null;
  model.selectedIssueKey = null;
  model.issueDetail = null;
  model.issueActivity = [];
  model.issueActivityNextOffset = null;
  model.issueError = null;
  model.issueActivityError = null;
  model.selectedRunId = null;
  model.runDetail = null;
  model.transcript = [];
  model.transcriptNextOffset = null;
  model.transcriptError = null;
  model.runError = null;
}

export function applyExtensionMessage(model: DashboardState, message: ExtensionMessage): void {
  switch (message.type) {
    case "connectionState":
      if (model.connection && model.connection.baseUrl !== message.state.baseUrl) {
        resetActivityScope(model, message.state.baseUrl);
        model.board = null;
        model.boardError = null;
        model.boardLoading = false;
      } else if (!model.activityScopeKey) {
        model.activityScopeKey = message.state.baseUrl;
      }
      model.connection = message.state;
      return;
    case "activityScopeReset":
      if (model.activityScopeKey !== message.scopeKey) {
        resetActivityScope(model, message.scopeKey);
        model.board = null;
        model.boardError = null;
        model.boardLoading = false;
      }
      return;
    case "dashboardLoading":
      if (message.dashboardGeneration < model.dashboardGeneration) return;
      model.dashboardGeneration = message.dashboardGeneration;
      model.boardLoading = true;
      model.boardError = null;
      return;
    case "dashboardState":
      if (message.dashboardGeneration < model.dashboardGeneration) return;
      if (message.appendActivity && message.offset !== model.globalActivityNextOffset) return;
      model.dashboardGeneration = message.dashboardGeneration;
      model.boardLoading = false;
      if (message.board) {
        model.board = message.board;
        model.boardError = null;
      }
      if (message.activity) {
        if (message.reconcileActivityHead) {
          const reconciled = reconcileActivityHead(model.globalActivity, model.globalActivityNextOffset, message.activity);
          model.globalActivity = reconciled.activity;
          model.globalActivityNextOffset = reconciled.nextOffset;
        } else {
          model.globalActivity = message.appendActivity ? [...model.globalActivity, ...message.activity.activity] : message.activity.activity;
          model.globalActivityNextOffset = message.activity.nextOffset;
        }
        model.activityError = null;
      }
      model.boardError = message.boardError ?? model.boardError;
      model.activityError = message.activityError ?? model.activityError;
      return;
    case "issueDetailState":
      if (message.issueKey !== model.selectedIssueKey) return;
      if (message.issueEpoch < model.issueEpoch) return;
      if (message.appendActivity && message.offset !== model.issueActivityNextOffset) return;
      model.issueEpoch = message.issueEpoch;
      if (message.detail) {
        model.issueDetail = message.detail;
        model.issueError = null;
      }
      if (message.activity) {
        if (message.reconcileActivityHead) {
          const reconciled = reconcileActivityHead(model.issueActivity, model.issueActivityNextOffset, message.activity);
          model.issueActivity = reconciled.activity;
          model.issueActivityNextOffset = reconciled.nextOffset;
        } else {
          model.issueActivity = message.appendActivity ? [...model.issueActivity, ...message.activity.activity] : message.activity.activity;
          model.issueActivityNextOffset = message.activity.nextOffset;
        }
        model.issueActivityError = null;
      }
      model.issueError = message.error ?? model.issueError;
      model.issueActivityError = message.activityError ?? model.issueActivityError;
      return;
    case "runState":
      if (message.runId !== model.selectedRunId) return;
      if (message.runEpoch < model.runEpoch) return;
      if (message.appendTranscript && message.offset !== model.transcriptNextOffset) return;
      model.runEpoch = message.runEpoch;
      if (message.run) {
        model.runDetail = message.run;
        model.runError = null;
      }
      if (message.transcript) {
        model.transcript = message.appendTranscript ? [...model.transcript, ...message.transcript.events] : message.transcript.events;
        model.transcriptNextOffset = message.transcript.nextOffset;
        model.transcriptError = null;
      }
      model.runError = message.error ?? model.runError;
      model.transcriptError = message.transcriptError ?? model.transcriptError;
      return;
    case "operationResult":
      model.operationMessage = { level: message.level, message: message.message };
      return;
  }
}

function reconcileActivityHead(
  existing: ActivityItem[],
  existingNextOffset: number | null,
  page: { activity: ActivityItem[]; limit: number; nextOffset: number | null },
): { activity: ActivityItem[]; nextOffset: number | null } {
  const headIds = new Set(page.activity.map((item) => item.id));
  const tail = existing.slice(page.limit).filter((item) => !headIds.has(item.id));
  return {
    activity: [...page.activity, ...tail],
    nextOffset: tail.length > 0 ? existingNextOffset : page.nextOffset,
  };
}

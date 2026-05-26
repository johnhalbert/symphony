import type { ConnectionState } from "./connectionState";
import type { ActivityFeedResponse, BoardIssueDetailResponse, IssueBoardResponse, JsonObject, TranscriptPage } from "./statusApiTypes";

export type WebviewMessage =
  | { type: "retry" }
  | { type: "refresh" }
  | { type: "openSettings" }
  | { type: "selectIssue"; issueKey: string }
  | { type: "loadMoreActivity"; offset: number }
  | { type: "loadMoreIssueActivity"; issueKey: string; offset: number }
  | { type: "selectRun"; runId: string }
  | { type: "loadMoreTranscript"; runId: string; offset: number }
  | { type: "openWorkspace"; issueKey: string };

export type ExtensionMessage =
  | { type: "connectionState"; state: ConnectionState }
  | { type: "activityScopeReset"; scopeKey: string }
  | { type: "dashboardLoading"; dashboardGeneration: number }
  | {
      type: "dashboardState";
      dashboardGeneration: number;
      board?: IssueBoardResponse | null | undefined;
      activity?: ActivityFeedResponse | null | undefined;
      boardError?: string | undefined;
      activityError?: string | undefined;
      appendActivity?: boolean | undefined;
      offset?: number | undefined;
    }
  | {
      type: "issueDetailState";
      issueKey: string;
      issueEpoch: number;
      offset: number;
      detail?: BoardIssueDetailResponse | null | undefined;
      activity?: ActivityFeedResponse | null | undefined;
      error?: string | undefined;
      activityError?: string | undefined;
      appendActivity?: boolean | undefined;
    }
  | {
      type: "runState";
      runId: string;
      runEpoch: number;
      offset: number;
      run?: JsonObject | null | undefined;
      transcript?: TranscriptPage | null | undefined;
      error?: string | undefined;
      transcriptError?: string | undefined;
      appendTranscript?: boolean | undefined;
    }
  | { type: "operationResult"; level: "info" | "error"; message: string };

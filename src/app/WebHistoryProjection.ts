import type { RunRecord, RunStatus } from "../core/persistence/RunTranscriptStore.js";

export type WebRunState = "running" | "finished" | "error" | "cancelled" | "queued";

export interface SessionModel {
  id: string;
  issue: string;
  title: string;
  state: WebRunState;
  model: string;
  startedAt: string;
  updatedAt: string;
  msgCount: number;
  lastEvent: string;
  toolCount: number;
}

export type TranscriptMessage =
  | {
      kind: "system";
      ts: string;
      model: string;
      cwd: string;
      workspace: string;
      session: string;
      tools: string[];
      note: string;
    }
  | { kind: "user"; ts: string; from: string; issue: string; text: string }
  | { kind: "assistant"; ts: string; text: string }
  | { kind: "thinking"; ts: string; text: string }
  | {
      kind: "tool_call";
      ts: string;
      call_id: string;
      name: string;
      status: string;
      args: Record<string, unknown>;
      result: string | null;
      truncated?: boolean;
    }
  | { kind: "status"; state: string; ts: string; text: string }
  | { kind: "task"; ts: string; title: string; desc: string }
  | { kind: "request"; ts: string; reason: string; q: string; actions: string[] };

export interface TimelineEvent {
  t: string;
  sess: string;
  kind: TranscriptMessage["kind"];
  text: string;
  state?: string;
}

export interface HistoryModel {
  sessions: SessionModel[];
  transcriptBySession: Record<string, TranscriptMessage[]>;
  timeline: TimelineEvent[];
  defaultSessionId: string;
}

export interface WebHistoryActivityItem {
  id: string;
  at: string;
  kind: string;
  issue: {
    id: string;
    identifier: string;
  };
  run: {
    runId: string;
    status: RunStatus;
  } | null;
  transcript: {
    eventType: string;
    message: string | null;
  } | null;
  writeback: {
    operationKind: string;
    status: string;
    skipReason?: { message: string } | null;
    transition?: { toState: string } | null;
    comment?: { bodyLength: number } | null;
  } | null;
}

type RunRecordWithOptionalWebFields = RunRecord & {
  runtimeModel?: string | null;
  issueTitle?: string | null;
  issue?: { title?: string | null } | null;
};

export function projectWebHistory(
  runs: readonly RunRecord[],
  activity: readonly WebHistoryActivityItem[] = [],
): HistoryModel {
  const sortedActivity = [...activity].sort(compareHistoryActivityItems);
  const latestActivityByRun = new Map<string, WebHistoryActivityItem>();
  for (const item of sortedActivity) {
    const runId = item.run?.runId;
    if (runId && !latestActivityByRun.has(runId)) latestActivityByRun.set(runId, item);
  }

  const sessions = [...runs].sort(compareHistoryRuns).map((run) => projectSession(run, latestActivityByRun.get(run.runId)));

  return {
    sessions,
    transcriptBySession: {},
    timeline: sortedActivity.map(projectTimelineEvent),
    defaultSessionId: sessions[0]?.id ?? "",
  };
}

export function mapRunStatusToWebState(status: RunStatus): Exclude<WebRunState, "queued"> {
  switch (status) {
    case "running":
      return "running";
    case "succeeded":
      return "finished";
    case "failed":
      return "error";
    case "cancelled":
      return "cancelled";
  }
}

function projectSession(run: RunRecord, latestActivity: WebHistoryActivityItem | undefined): SessionModel {
  return {
    id: run.runId,
    issue: run.issueIdentifier,
    title: sessionTitle(run),
    state: mapRunStatusToWebState(run.status),
    model: sessionModel(run),
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    msgCount: run.transcriptEventCount ?? 0,
    lastEvent: latestActivity ? timelineText(latestActivity) : fallbackLastEvent(run),
    toolCount: 0,
  };
}

function projectTimelineEvent(item: WebHistoryActivityItem): TimelineEvent {
  const state = timelineState(item);
  return {
    t: item.at,
    sess: item.run?.runId ?? "",
    kind: "status",
    text: timelineText(item),
    ...(state ? { state } : {}),
  };
}

function sessionTitle(run: RunRecord): string {
  const withOptionalFields = run as RunRecordWithOptionalWebFields;
  const issueTitle = cleanString(withOptionalFields.issueTitle) ?? cleanString(withOptionalFields.issue?.title);
  const issueIdentifier = cleanString(run.issueIdentifier);
  if (issueTitle && issueIdentifier) return issueIdentifier + ": " + issueTitle;
  if (issueTitle) return issueTitle;
  if (issueIdentifier) return issueIdentifier;
  return promptPreview(run.prompt);
}

function sessionModel(run: RunRecord): string {
  const withOptionalFields = run as RunRecordWithOptionalWebFields;
  return cleanString(withOptionalFields.runtimeModel) ?? cleanString(run.cursorModel) ?? "";
}

function fallbackLastEvent(run: RunRecord): string {
  const issue = cleanString(run.issueIdentifier) ?? cleanString(run.issueId) ?? "Run";
  return issue + " " + mapRunStatusToWebState(run.status);
}

function timelineState(item: WebHistoryActivityItem): string | undefined {
  if (item.kind === "run_started") return "running";
  if (item.run) return mapRunStatusToWebState(item.run.status);
  return item.writeback?.status;
}

function timelineText(item: WebHistoryActivityItem): string {
  const issueIdentifier = cleanString(item.issue.identifier) ?? cleanString(item.issue.id) ?? "Unknown issue";
  switch (item.kind) {
    case "run_started":
      return issueIdentifier + " run started";
    case "run_completed":
      return item.run ? issueIdentifier + " run " + mapRunStatusToWebState(item.run.status) : issueIdentifier + " run completed";
    case "transcript_event": {
      const eventType = cleanString(item.transcript?.eventType) ?? "transcript_event";
      const message = cleanString(item.transcript?.message);
      return message ? eventType + ": " + message : eventType;
    }
    case "writeback_operation": {
      const operationKind = cleanString(item.writeback?.operationKind) ?? "writeback";
      const status = cleanString(item.writeback?.status) ?? "unknown";
      const skipMessage = cleanString(item.writeback?.skipReason?.message);
      const transition = cleanString(item.writeback?.transition?.toState);
      const commentLength = item.writeback?.comment?.bodyLength;
      const detail = skipMessage
        ? ": " + skipMessage
        : transition
          ? " to " + transition
          : typeof commentLength === "number"
            ? " (" + commentLength + " chars)"
            : "";
      return issueIdentifier + " " + operationKind + " " + status + detail;
    }
    default:
      return issueIdentifier + " " + item.kind;
  }
}

function compareHistoryRuns(left: RunRecord, right: RunRecord): number {
  return compareIsoDesc(left.updatedAt, right.updatedAt) || compareString(left.runId, right.runId);
}

function compareHistoryActivityItems(left: WebHistoryActivityItem, right: WebHistoryActivityItem): number {
  return (
    compareIsoDesc(left.at, right.at) ||
    compareString(left.run?.runId ?? "", right.run?.runId ?? "") ||
    compareString(left.kind, right.kind) ||
    compareString(left.id, right.id)
  );
}

function compareIsoDesc(left: string, right: string): number {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (!Number.isNaN(leftMs) && !Number.isNaN(rightMs) && leftMs !== rightMs) return rightMs - leftMs;
  return compareString(right, left);
}

function compareString(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function cleanString(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function promptPreview(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  if (oneLine.length === 0) return "Untitled run";
  return oneLine.length <= 120 ? oneLine : oneLine.slice(0, 117) + "...";
}

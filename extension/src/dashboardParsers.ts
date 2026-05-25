import type {
  ActivitySection,
  ActivitySummary,
  BoardCounts,
  BoardSection,
  BoardSummary,
  OperatorQueuesSection,
  OperatorQueuesSummary,
  OperatorRow,
  RetryingRow,
} from "./dashboardTypes";

export interface JsonHttpResult {
  kind: "http";
  status: number;
  body: unknown;
}

export type JsonEndpointResult =
  | JsonHttpResult
  | { kind: "parse_failure"; detail: string; status: number }
  | { kind: "network"; detail: string };

const EMPTY_OPERATOR_QUEUES: OperatorQueuesSummary = {
  running: [],
  paused: [],
  orphaned: [],
  retrying: [],
};

export function parseOperatorQueues(stateBody: unknown): OperatorQueuesSection {
  if (!isRecord(stateBody) || !isRecord(stateBody.operatorView)) {
    return { status: "partial", detail: "Operator view unavailable.", data: EMPTY_OPERATOR_QUEUES };
  }

  const operatorView = stateBody.operatorView;
  return {
    status: "ready",
    data: {
      running: arrayValue(operatorView.running).flatMap(parseRunningRow),
      paused: arrayValue(operatorView.paused).flatMap(parsePausedRow),
      orphaned: arrayValue(operatorView.orphaned).flatMap(parseOrphanedRow),
      retrying: arrayValue(operatorView.retrying).flatMap(parseRetryingRow),
    },
  };
}

export function parseBoardSection(result: JsonEndpointResult): BoardSection {
  if (result.kind === "network") return { status: "error", detail: result.detail };
  if (result.kind === "parse_failure") return { status: "error", detail: `Unable to parse board response: ${result.detail}` };

  if (result.status === 503) {
    const error = parseErrorEnvelope(result.body);
    if (error.code === "tracker_unavailable" || error.code === "tracker_error") {
      return { status: "unavailable", detail: error.message ?? "Issue board requires a configured tracker client." };
    }
  }

  if (result.status !== 200) return { status: "error", detail: `Symphony returned HTTP ${result.status} for the board.` };

  const summary = parseBoardSummary(result.body);
  return summary ? { status: "ready", data: summary } : { status: "error", detail: "Board response was missing columns." };
}

export function parseActivitySection(result: JsonEndpointResult): ActivitySection {
  if (result.kind === "network") return { status: "error", detail: result.detail };
  if (result.kind === "parse_failure") return { status: "error", detail: `Unable to parse activity response: ${result.detail}` };
  if (result.status !== 200) return { status: "error", detail: `Symphony returned HTTP ${result.status} for activity.` };

  const summary = parseActivitySummary(result.body);
  return summary ? { status: "ready", data: summary } : { status: "error", detail: "Activity response was missing an activity list." };
}

function parseRunningRow(value: unknown): OperatorRow[] {
  if (!isRecord(value)) return [];
  const issueIdentifier = stringValue(value.issueIdentifier);
  if (!issueIdentifier) return [];
  const liveness = isRecord(value.liveness) ? value.liveness : null;
  return [
    {
      issueIdentifier,
      role: stringValue(value.role),
      statusLabel: liveness ? stringValue(liveness.status) : null,
      detail: detailFromIssueTitle(value) ?? stringValue(value.state),
    },
  ];
}

function parsePausedRow(value: unknown): OperatorRow[] {
  if (!isRecord(value)) return [];
  const issueIdentifier = stringValue(value.issueIdentifier) ?? stringValue(value.label);
  if (!issueIdentifier) return [];
  const humanRequired = isRecord(value.humanRequired) ? value.humanRequired : null;
  return [
    {
      issueIdentifier,
      role: null,
      statusLabel: "paused",
      detail: stringValue(value.label) ?? (humanRequired ? stringValue(humanRequired.reason) : null),
    },
  ];
}

function parseOrphanedRow(value: unknown): OperatorRow[] {
  if (!isRecord(value)) return [];
  const issueIdentifier = stringValue(value.issueIdentifier);
  if (!issueIdentifier) return [];
  return [
    {
      issueIdentifier,
      role: stringValue(value.role),
      statusLabel: stringValue(value.status) ?? stringValue(value.tracking),
      detail: stringValue(value.runId),
    },
  ];
}

function parseRetryingRow(value: unknown): RetryingRow[] {
  if (!isRecord(value)) return [];
  const issueIdentifier = stringValue(value.issueIdentifier) ?? stringValue(value.issueId);
  if (!issueIdentifier) return [];
  return [
    {
      issueIdentifier,
      attempt: numberValue(value.attempt),
      dueAt: stringValue(value.dueAt),
      error: stringValue(value.error),
    },
  ];
}

function parseBoardSummary(value: unknown): BoardSummary | null {
  if (!isRecord(value)) return null;
  const columns = arrayValue(value.columns).flatMap((column): BoardSummary["columns"] => {
    if (!isRecord(column)) return [];
    const id = stringValue(column.id);
    const title = stringValue(column.title);
    const count = numberValue(column.count);
    return id && title && count !== null ? [{ id, title, count }] : [];
  });
  if (columns.length === 0 && !Array.isArray(value.columns)) return null;

  return {
    generatedAt: stringValue(value.generatedAt),
    columns,
    counts: parseBoardCounts(value.counts),
  };
}

function parseBoardCounts(value: unknown): BoardCounts | null {
  if (!isRecord(value)) return null;
  return {
    total: numberValue(value.total),
    live: numberValue(value.live),
    paused: numberValue(value.paused),
    blocked: numberValue(value.blocked),
  };
}

function parseActivitySummary(value: unknown): ActivitySummary | null {
  if (!isRecord(value) || !Array.isArray(value.activity)) return null;
  return {
    items: value.activity.flatMap((item) => {
      if (!isRecord(item)) return [];
      const at = stringValue(item.at);
      const kind = stringValue(item.kind);
      const issue = isRecord(item.issue) ? item.issue : null;
      const issueIdentifier = issue ? stringValue(issue.identifier) : null;
      if (!at || !kind || !issueIdentifier) return [];
      return [
        {
          at,
          kind,
          issueIdentifier,
          summary: activitySummary(item, kind),
        },
      ];
    }),
    totalItems: isRecord(value.counts) ? numberValue(value.counts.totalItems) : null,
  };
}

function activitySummary(item: Record<string, unknown>, fallback: string): string | null {
  const transcript = isRecord(item.transcript) ? item.transcript : null;
  const transcriptMessage = transcript ? stringValue(transcript.message) : null;
  if (transcriptMessage) return sanitizeDisplayText(transcriptMessage);

  const writeback = isRecord(item.writeback) ? item.writeback : null;
  const operationKind = writeback ? stringValue(writeback.operationKind) : null;
  const status = writeback ? stringValue(writeback.status) : null;
  if (operationKind || status) return sanitizeDisplayText([operationKind, status].filter(Boolean).join(" "));

  return sanitizeDisplayText(fallback);
}

function detailFromIssueTitle(value: Record<string, unknown>): string | null {
  const issueDetails = isRecord(value.issueDetails) ? value.issueDetails : null;
  const issue = issueDetails && isRecord(issueDetails.issue) ? issueDetails.issue : null;
  return issue ? stringValue(issue.title) : null;
}

function parseErrorEnvelope(value: unknown): { code: string | null; message: string | null } {
  if (!isRecord(value) || !isRecord(value.error)) return { code: null, message: null };
  return { code: stringValue(value.error.code), message: stringValue(value.error.message) };
}

function sanitizeDisplayText(value: string): string {
  return value.replace(/[A-Za-z]:\\[^\s]+|\/[^\s]+/g, "[path]");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

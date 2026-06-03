import type { RunRecord, RunStatus } from "../core/persistence/RunTranscriptStore.js";
import type { ProviderLimitSignal } from "../core/provider/ProviderLimits.js";
import { sanitizedPreviewValue } from "../core/transcript/TranscriptProjection.js";
import { runKindForPhase } from "../core/types.js";

type PersistedModelParam = { id: string; value: string };

export type WebRunState = "running" | "finished" | "error" | "cancelled" | "queued";

export interface WebRunSessionRuntimeModel {
  model: string | null;
  modelParams: PersistedModelParam[];
  settingSources: string[];
  mode: string | null;
  allowLargeContext: boolean | null;
  agentLifecycle: string | null;
}

export interface WebRunSessionCursorModel {
  model: string | null;
  modelParams: PersistedModelParam[];
  settingSources: string[];
  mode: string | null;
  allowLargeContext: boolean | null;
  workerAgentLifecycle: string | null;
}

export interface WebRunSessionProviderLimitModel {
  provider: string | null;
  providerId: string | null;
  harnessId: string | null;
  model: string | null;
  kind: string | null;
  message: string | null;
  observedAt: string | null;
  resumePolicy: string | null;
  window: {
    resumeAt: string | null;
    retryAfterMs: number | null;
    windowLabel: string | null;
    windowKind: string | null;
  } | null;
  source: {
    issueId: string | null;
    issueIdentifier: string | null;
    runId: string | null;
    sessionId: string | null;
    role: string | null;
    runPhase: string | null;
  } | null;
}

export interface WebRunSessionModel {
  runId: string;
  sessionId: string | null;
  agentId: string | null;
  role: RunRecord["role"];
  runPhase: NonNullable<RunRecord["runPhase"]> | null;
  runKind: NonNullable<RunRecord["runKind"]> | null;
  attempt: number | null;
  turnNumber: number;
  harnessId: string | null;
  status: RunStatus;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
  transcriptEventCount: number;
  tokens: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  runtime: WebRunSessionRuntimeModel;
  cursor: WebRunSessionCursorModel;
  workspace: {
    key: string;
    path: string;
    repoPath: string | null;
    baseRef: string | null;
    branch: string | null;
  };
  pullRequest: {
    url: string | null;
    number: number | null;
    headSha: string | null;
    branch: string | null;
    ciStatus: string | null;
    lastPushedAt: string | null;
    lastEvidenceCursor: string | null;
  };
  approval: {
    pendingRequestId: string | null;
    requestedAt: string | null;
  };
  cancellation: {
    requestedAt: string | null;
    source: RunRecord["cancellationSource"] | null;
    reason: string | null;
    outcome: RunRecord["cancellationOutcome"] | null;
    harnessStopRequestedAt: string | null;
    harnessStopFailedAt: string | null;
    harnessStopFailedReason: string | null;
    cancelFailed: boolean;
    cancelFailedAt: string | null;
    cancelFailedReason: string | null;
    cancelFailedSource: RunRecord["cancelFailedSource"] | null;
  };
  failure: {
    kind: string | null;
    diagnosticCode: string | null;
    diagnosticMessage: string | null;
    diagnosticAt: string | null;
  };
  providerLimit: WebRunSessionProviderLimitModel | null;
  links: {
    issue: string;
    run: string;
    transcript: string;
  };
}

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
  runSession: WebRunSessionModel;
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
      output?: string | null;
      error?: string | null;
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
    runSession: projectRunSession(run),
  };
}

export function projectRunSession(run: RunRecord): WebRunSessionModel {
  const runPhase = run.runPhase ?? null;
  return {
    runId: run.runId,
    sessionId: cleanString(run.sessionId),
    agentId: cleanString(run.agentId),
    role: run.role,
    runPhase,
    runKind: run.runKind ?? (runPhase ? runKindForPhase(runPhase) : null),
    attempt: run.attempt,
    turnNumber: run.turnNumber,
    harnessId: cleanString(run.harnessId),
    status: run.status,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    completedAt: cleanString(run.completedAt),
    error: publicText(run.error),
    transcriptEventCount: run.transcriptEventCount ?? 0,
    tokens: {
      inputTokens: numericToken(run.tokens.inputTokens),
      outputTokens: numericToken(run.tokens.outputTokens),
      totalTokens: numericToken(run.tokens.totalTokens),
    },
    runtime: {
      model: cleanString(run.runtimeModel),
      modelParams: copyModelParams(run.runtimeModelParams),
      settingSources: copyStrings(run.runtimeSettingSources),
      mode: cleanString(run.runtimeMode),
      allowLargeContext: run.runtimeAllowLargeContext ?? null,
      agentLifecycle: cleanString(run.runtimeAgentLifecycle),
    },
    cursor: {
      model: cleanString(run.cursorModel),
      modelParams: copyModelParams(run.cursorModelParams),
      settingSources: copyStrings(run.cursorSettingSources),
      mode: cleanString(run.cursorMode),
      allowLargeContext: run.cursorAllowLargeContext ?? null,
      workerAgentLifecycle: cleanString(run.cursorWorkerAgentLifecycle),
    },
    workspace: {
      key: run.workspaceKey,
      path: run.workspacePath,
      repoPath: cleanString(run.repoPath),
      baseRef: cleanString(run.baseRef),
      branch: cleanString(run.gitBranchName),
    },
    pullRequest: {
      url: cleanString(run.prUrl),
      number: typeof run.prNumber === "number" ? run.prNumber : null,
      headSha: cleanString(run.prHeadSha),
      branch: cleanString(run.prBranch),
      ciStatus: cleanString(run.ciStatus),
      lastPushedAt: cleanString(run.lastPushedAt),
      lastEvidenceCursor: cleanString(run.lastEvidenceCursor),
    },
    approval: {
      pendingRequestId: cleanString(run.pendingApprovalRequestId),
      requestedAt: cleanString(run.pendingApprovalRequestedAt),
    },
    cancellation: {
      requestedAt: cleanString(run.cancellationRequestedAt),
      source: run.cancellationSource ?? null,
      reason: publicText(run.cancellationReason),
      outcome: run.cancellationOutcome ?? null,
      harnessStopRequestedAt: cleanString(run.harnessStopRequestedAt),
      harnessStopFailedAt: cleanString(run.harnessStopFailedAt),
      harnessStopFailedReason: publicText(run.harnessStopFailedReason),
      cancelFailed: run.cancelFailed ?? false,
      cancelFailedAt: cleanString(run.cancelFailedAt),
      cancelFailedReason: publicText(run.cancelFailedReason),
      cancelFailedSource: run.cancelFailedSource ?? null,
    },
    failure: {
      kind: cleanString(run.failureKind),
      diagnosticCode: cleanString(run.failureDiagnosticCode),
      diagnosticMessage: publicText(run.failureDiagnosticMessage),
      diagnosticAt: cleanString(run.failureDiagnosticAt),
    },
    providerLimit: projectProviderLimit(run.providerLimit),
    links: {
      issue: `/api/v1/web/issues/${encodeURIComponent(run.issueIdentifier)}`,
      run: `/api/v1/runs/${encodeURIComponent(run.runId)}`,
      transcript: `/api/v1/web/sessions/${encodeURIComponent(run.runId)}/transcript`,
    },
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
  return cleanString(withOptionalFields.runtimeModel) ?? cursorRuntimeFallbackModel(run) ?? "";
}

function cursorRuntimeFallbackModel(run: RunRecord): string | null {
  return shouldUseCursorRuntimeFallback(run) ? cleanString(run.cursorModel) : null;
}

function shouldUseCursorRuntimeFallback(run: RunRecord): boolean {
  const harnessId = cleanString(run.harnessId);
  if (harnessId === "cursor") return true;
  if (harnessId) return false;
  return (
    run.cursorModel !== undefined ||
    run.cursorModelParams !== undefined ||
    run.cursorMode !== undefined ||
    run.cursorSettingSources !== undefined
  );
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

function publicText(value: string | null | undefined): string | null {
  const cleaned = cleanString(value);
  if (!cleaned) return null;
  return sanitizedPreviewValue(cleaned).preview ?? null;
}

function numericToken(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function finiteNonNegativeNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function projectProviderLimit(signal: ProviderLimitSignal | null | undefined): WebRunSessionProviderLimitModel | null {
  if (!signal) return null;
  const providerId = publicText(signal.scope.providerId);
  const harnessId = publicText(signal.scope.harnessId);
  return {
    provider: providerId ?? harnessId,
    providerId,
    harnessId,
    model: publicText(signal.scope.model),
    kind: publicText(signal.kind),
    message: publicText(signal.message),
    observedAt: cleanString(signal.observedAt),
    resumePolicy: publicText(signal.resumePolicy),
    window: projectProviderLimitWindow(signal.window),
    source: projectProviderLimitSource(signal.source),
  };
}

function projectProviderLimitWindow(signalWindow: ProviderLimitSignal["window"]): WebRunSessionProviderLimitModel["window"] {
  if (!signalWindow) return null;
  return {
    resumeAt: cleanString(signalWindow.resumeAt),
    retryAfterMs: finiteNonNegativeNumber(signalWindow.retryAfterMs),
    windowLabel: publicText(signalWindow.windowLabel),
    windowKind: publicText(signalWindow.windowKind),
  };
}

function projectProviderLimitSource(signalSource: ProviderLimitSignal["source"]): WebRunSessionProviderLimitModel["source"] {
  if (!signalSource) return null;
  return {
    issueId: publicText(signalSource.issueId),
    issueIdentifier: publicText(signalSource.issueIdentifier),
    runId: publicText(signalSource.runId),
    sessionId: publicText(signalSource.sessionId),
    role: publicText(signalSource.role),
    runPhase: publicText(signalSource.runPhase),
  };
}

function copyStrings(values: readonly string[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return values.map((value) => publicText(value)).filter((value): value is string => value !== null);
}

function copyModelParams(values: readonly PersistedModelParam[] | undefined): PersistedModelParam[] {
  if (!Array.isArray(values)) return [];
  const params: PersistedModelParam[] = [];
  for (const param of values) {
    const rawId = typeof param.id === "string" ? param.id : "";
    const id = publicText(rawId);
    if (!id) continue;
    const sensitiveId = isSensitiveParamId(rawId) || isSensitiveParamId(id);
    const value = sensitiveId ? "[redacted]" : (publicText(param.value) ?? "");
    params.push({ id, value });
  }
  return params;
}

function isSensitiveParamId(id: string): boolean {
  const normalized = id.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return (
    normalized.includes("apikey") ||
    normalized.includes("authorization") ||
    normalized.includes("password") ||
    normalized.includes("secret") ||
    normalized.includes("privatekey") ||
    normalized.includes("accesstoken") ||
    normalized.includes("refreshtoken") ||
    (normalized.endsWith("token") && !normalized.endsWith("tokens"))
  );
}

function promptPreview(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  if (oneLine.length === 0) return "Untitled run";
  return oneLine.length <= 120 ? oneLine : oneLine.slice(0, 117) + "...";
}

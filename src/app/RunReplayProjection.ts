import { projectWebTranscript, type TranscriptMessage } from "./WebTranscriptProjection.js";
import type {
  PersistedSdkRunStatus,
  PersistedSdkRunStatusSource,
  RunRecord,
  RunStatus,
  TranscriptEvent,
} from "../core/persistence/RunTranscriptStore.js";
import type { TokenCounts } from "../core/types.js";

const ZERO_TOKENS: TokenCounts = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

export interface ReplayedRunSessionState {
  runId: string;
  sessionId: string | null;
  agentId: string | null;
  status: RunStatus;
  completedAt: string | null;
  error: string | null;
  tokens: TokenCounts;
  transcriptEventCount: number;
  lastEventAt: string | null;
  sdkRunStatus: PersistedSdkRunStatus | null;
  sdkRunStatusObservedAt: string | null;
  sdkRunStatusSource: PersistedSdkRunStatusSource | null;
  messages: TranscriptMessage[];
}

export function replayRunSessionState(
  run: RunRecord,
  events: readonly TranscriptEvent[],
): ReplayedRunSessionState {
  const replayEvents = canonicalRunReplayEvents(run.runId, events);
  let state = initialRunSessionReplayState(run);
  for (const event of replayEvents) {
    state = reduceRunSessionReplayEvent(state, event);
  }
  return {
    ...state,
    messages: projectWebTranscript(messageEventsForReplay(replayEvents), { run: runRecordForReplayProjection(run, state) }),
  };
}

export function canonicalRunReplayEvents(runId: string, events: readonly TranscriptEvent[]): TranscriptEvent[] {
  const seenSequences = new Set<number>();
  const ordered = events.filter((event) => event.runId === runId).slice().sort(compareTranscriptEvents);
  const unique: TranscriptEvent[] = [];
  for (const event of ordered) {
    if (seenSequences.has(event.sequence)) continue;
    seenSequences.add(event.sequence);
    unique.push(event);
  }
  return unique;
}

function messageEventsForReplay(events: readonly TranscriptEvent[]): TranscriptEvent[] {
  return events.filter((event) => !isReplayLifecycleEvent(normalizeEventType(event.eventType)));
}

function isReplayLifecycleEvent(eventType: string): boolean {
  return (
    eventType === "session_started" ||
    eventType === "tokens" ||
    eventType === "rate_limits" ||
    eventType === "provider_limit" ||
    eventType === "run_status" ||
    eventType === "run_diagnostic" ||
    eventType === "completed" ||
    eventType === "failed" ||
    eventType === "cancelled"
  );
}

export function initialRunSessionReplayState(run: RunRecord): ReplayedRunSessionState {
  return {
    runId: run.runId,
    sessionId: run.sessionId,
    agentId: run.agentId,
    status: "running",
    completedAt: null,
    error: null,
    tokens: { ...ZERO_TOKENS },
    transcriptEventCount: 0,
    lastEventAt: null,
    sdkRunStatus: null,
    sdkRunStatusObservedAt: null,
    sdkRunStatusSource: null,
    messages: [],
  };
}

export function reduceRunSessionReplayEvent(state: ReplayedRunSessionState, event: TranscriptEvent): ReplayedRunSessionState {
  const eventType = normalizeEventType(event.eventType);
  const payload = payloadRecord(event);
  let next: ReplayedRunSessionState = {
    ...state,
    transcriptEventCount: state.transcriptEventCount + 1,
    lastEventAt: event.at,
  };

  if (eventType === "session_started") {
    next = {
      ...next,
      sessionId: firstString(payload.sessionId, payload.session, next.sessionId),
      agentId: firstString(payload.threadId, payload.agentId, next.agentId),
    };
  }

  if (eventType === "tokens") {
    const tokens = tokenCountsFromEvent(event);
    if (tokens) next = { ...next, tokens: applyTokenUpdate(next.tokens, tokens) };
  }

  if (eventType === "run_status") {
    const sdkRunStatus = sdkRunStatusValue(payload.sdkStatus ?? payload.status);
    const sdkRunStatusSource = sdkRunStatusSourceValue(payload.source);
    if (sdkRunStatus !== null) {
      next = {
        ...next,
        sdkRunStatus,
        sdkRunStatusObservedAt: event.at,
        sdkRunStatusSource: sdkRunStatusSource ?? next.sdkRunStatusSource,
      };
    }
  }

  const terminalStatus = terminalStatusForEventType(eventType);
  if (terminalStatus && next.status === "running") {
    next = {
      ...next,
      status: terminalStatus,
      completedAt: event.at,
      error: terminalStatus === "failed" ? firstString(payload.error, payload.message, event.message, "Run failed") : null,
    };
  }

  return next;
}

function runRecordForReplayProjection(run: RunRecord, state: ReplayedRunSessionState): RunRecord {
  return {
    ...run,
    sessionId: state.sessionId,
    agentId: state.agentId,
    status: state.status,
    completedAt: state.completedAt,
    error: state.error,
    tokens: state.tokens,
    transcriptEventCount: state.transcriptEventCount,
    sdkRunStatus: state.sdkRunStatus,
    sdkRunStatusObservedAt: state.sdkRunStatusObservedAt,
    sdkRunStatusSource: state.sdkRunStatusSource,
  };
}

function compareTranscriptEvents(left: TranscriptEvent, right: TranscriptEvent): number {
  return left.sequence - right.sequence || left.at.localeCompare(right.at) || left.eventType.localeCompare(right.eventType);
}

function terminalStatusForEventType(eventType: string): RunStatus | null {
  if (eventType === "completed") return "succeeded";
  if (eventType === "failed") return "failed";
  if (eventType === "cancelled") return "cancelled";
  return null;
}

function applyTokenUpdate(current: TokenCounts, update: Partial<TokenCounts>): TokenCounts {
  return {
    inputTokens: update.inputTokens ?? current.inputTokens,
    outputTokens: update.outputTokens ?? current.outputTokens,
    totalTokens: update.totalTokens ?? current.totalTokens,
  };
}

function tokenCountsFromEvent(event: TranscriptEvent): Partial<TokenCounts> | null {
  const payload = payloadRecord(event);
  const candidate = isRecord(payload.tokens) ? payload.tokens : payload;
  const update: Partial<TokenCounts> = {};
  const inputTokens = finiteNumber(candidate.inputTokens);
  const outputTokens = finiteNumber(candidate.outputTokens);
  const totalTokens = finiteNumber(candidate.totalTokens);
  if (inputTokens !== null) update.inputTokens = inputTokens;
  if (outputTokens !== null) update.outputTokens = outputTokens;
  if (totalTokens !== null) update.totalTokens = totalTokens;
  return Object.keys(update).length === 0 ? null : update;
}

function sdkRunStatusValue(value: unknown): PersistedSdkRunStatus | null {
  if (value === "running" || value === "finished" || value === "error" || value === "cancelled") return value;
  return null;
}

function sdkRunStatusSourceValue(value: unknown): PersistedSdkRunStatusSource | null {
  if (value === "initial" || value === "onDidChangeStatus" || value === "wait") return value;
  return null;
}

function payloadRecord(event: TranscriptEvent): Record<string, unknown> {
  return isRecord(event.payload) ? event.payload : {};
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    if (value.length > 0) return value;
  }
  return null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function normalizeEventType(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

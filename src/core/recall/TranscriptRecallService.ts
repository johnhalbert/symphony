import type { RunTranscriptStore, TranscriptEvent } from "../persistence/RunTranscriptStore.js";
import type { Issue } from "../types.js";

export interface TranscriptRecallBudget {
  maxCalls: number;
  maxEvents: number;
  maxChars: number;
  bookendEvents: number;
}

export interface TranscriptRecallSearchInput {
  issue: Pick<Issue, "id" | "identifier">;
  query: string;
  maxEvents?: number;
  maxChars?: number;
}

export interface TranscriptRecallSearchResult {
  issueId: string;
  issueIdentifier: string;
  query: string;
  callsRemaining: number;
  denied: boolean;
  truncated: boolean;
  returnedEvents: number;
  returnedChars: number;
  runs: TranscriptRecallRunResult[];
}

export interface TranscriptRecallRunResult {
  runId: string;
  role: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  transcriptPointer: string;
  runPointer: string;
  matches: TranscriptRecallEvent[];
  windows: TranscriptRecallMatchWindow[];
  bookends: {
    first: TranscriptRecallEvent[];
    latest: TranscriptRecallEvent[];
  };
}

export interface TranscriptRecallMatchWindow {
  matchSequence: number;
  before: TranscriptRecallEvent[];
  after: TranscriptRecallEvent[];
}

export interface TranscriptRecallEvent {
  sequence: number;
  at: string;
  source: string;
  eventType: string;
  text: string;
}

export const DEFAULT_RECALL_BUDGET: TranscriptRecallBudget = {
  maxCalls: 3,
  maxEvents: 20,
  maxChars: 6_000,
  bookendEvents: 2,
};

export class TranscriptRecallService {
  private calls = 0;

  constructor(
    private readonly options: {
      runStore: Pick<RunTranscriptStore, "listRunsForIssue" | "readTranscript">;
      budget?: Partial<TranscriptRecallBudget>;
    },
  ) {}

  async search(input: TranscriptRecallSearchInput): Promise<TranscriptRecallSearchResult> {
    const budget = { ...DEFAULT_RECALL_BUDGET, ...this.options.budget };
    if (this.calls >= budget.maxCalls) {
      return {
        issueId: input.issue.id,
        issueIdentifier: input.issue.identifier,
        query: input.query,
        callsRemaining: 0,
        denied: true,
        truncated: true,
        returnedEvents: 0,
        returnedChars: 0,
        runs: [],
      };
    }
    this.calls += 1;

    const query = input.query.trim().toLowerCase();
    const maxEvents = Math.min(Math.max(input.maxEvents ?? budget.maxEvents, 1), budget.maxEvents);
    const maxChars = Math.min(Math.max(input.maxChars ?? budget.maxChars, 500), budget.maxChars);
    const runs = await this.options.runStore.listRunsForIssue(input.issue.id);
    const results: TranscriptRecallRunResult[] = [];
    let remainingEvents = maxEvents;
    let remainingChars = maxChars;
    let truncated = false;

    for (const run of runs) {
      if (remainingEvents <= 0 || remainingChars <= 0) {
        truncated = true;
        break;
      }
      const events = await readAllTranscriptEvents(this.options.runStore, run.runId);
      const matches = query.length === 0 ? [] : events.filter((event) => eventText(event).toLowerCase().includes(query));
      if (matches.length === 0 && results.length > 0) continue;
      if (matches.length === 0 && query.length > 0) continue;

      const selected = takeBudgetedMatchWindows(events, matches, remainingEvents, remainingChars);
      remainingEvents -= selected.eventCount;
      remainingChars -= selected.chars;
      truncated ||= selected.truncated;

      const firstBookendCount = Math.min(budget.bookendEvents, remainingEvents);
      const first = toRecallEvents(events.slice(0, firstBookendCount), remainingChars);
      remainingEvents -= first.events.length;
      remainingChars -= first.chars;
      const latestBookendCount = Math.min(budget.bookendEvents, remainingEvents);
      const latest = toRecallEvents(latestBookendCount === 0 ? [] : events.slice(-latestBookendCount), remainingChars);
      remainingEvents -= latest.events.length;
      remainingChars -= latest.chars;
      truncated ||= first.truncated || latest.truncated;

      results.push({
        runId: run.runId,
        role: run.role,
        status: run.status,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        transcriptPointer: `/api/v1/runs/${encodeURIComponent(run.runId)}/transcript`,
        runPointer: `/api/v1/runs/${encodeURIComponent(run.runId)}`,
        matches: selected.matches,
        windows: selected.windows,
        bookends: { first: first.events, latest: latest.events },
      });
    }

    return {
      issueId: input.issue.id,
      issueIdentifier: input.issue.identifier,
      query: input.query,
      callsRemaining: Math.max(budget.maxCalls - this.calls, 0),
      denied: false,
      truncated,
      returnedEvents: countReturnedEvents(results),
      returnedChars: countReturnedChars(results),
      runs: results,
    };
  }
}

function countReturnedEvents(runs: TranscriptRecallRunResult[]): number {
  return runs.reduce(
    (total, run) =>
      total +
      run.matches.length +
      run.windows.reduce((windowTotal, window) => windowTotal + window.before.length + window.after.length, 0) +
      run.bookends.first.length +
      run.bookends.latest.length,
    0,
  );
}

function countReturnedChars(runs: TranscriptRecallRunResult[]): number {
  return runs.reduce(
    (total, run) =>
      total +
      [
        ...run.matches,
        ...run.windows.flatMap((window) => [...window.before, ...window.after]),
        ...run.bookends.first,
        ...run.bookends.latest,
      ].reduce(
        (eventTotal, event) => eventTotal + event.text.length,
        0,
      ),
    0,
  );
}

function takeBudgetedMatchWindows(
  allEvents: TranscriptEvent[],
  matches: TranscriptEvent[],
  maxEvents: number,
  maxChars: number,
): { matches: TranscriptRecallEvent[]; windows: TranscriptRecallMatchWindow[]; eventCount: number; chars: number; truncated: boolean } {
  const selectedMatches: TranscriptRecallEvent[] = [];
  const windows: TranscriptRecallMatchWindow[] = [];
  let remainingEvents = maxEvents;
  let remainingChars = maxChars;
  let usedChars = 0;
  let truncated = false;

  for (const match of matches) {
    if (remainingEvents <= 0 || remainingChars <= 0) {
      truncated = true;
      break;
    }
    const matchConverted = toRecallEvents([match], remainingChars);
    if (matchConverted.events.length === 0) {
      truncated = true;
      break;
    }
    const matchEvent = matchConverted.events[0]!;
    selectedMatches.push(matchEvent);
    remainingEvents -= 1;
    remainingChars -= matchConverted.chars;
    usedChars += matchConverted.chars;
    truncated ||= matchConverted.truncated;

    const matchIndex = allEvents.findIndex((event) => event.sequence === match.sequence);
    const beforeSource = matchIndex <= 0 ? [] : allEvents.slice(Math.max(0, matchIndex - 1), matchIndex);
    const afterSource = matchIndex < 0 ? [] : allEvents.slice(matchIndex + 1, matchIndex + 2);
    const contextSource = [...beforeSource, ...afterSource].slice(0, remainingEvents);
    const contextConverted = toRecallEvents(contextSource, remainingChars);
    remainingEvents -= contextConverted.events.length;
    remainingChars -= contextConverted.chars;
    usedChars += contextConverted.chars;
    truncated ||= contextConverted.truncated;
    windows.push({
      matchSequence: match.sequence,
      before: contextConverted.events.filter((event) => event.sequence < match.sequence),
      after: contextConverted.events.filter((event) => event.sequence > match.sequence),
    });
  }
  truncated ||= matches.length > selectedMatches.length;

  return {
    matches: selectedMatches,
    windows,
    eventCount: selectedMatches.length + windows.reduce((total, window) => total + window.before.length + window.after.length, 0),
    chars: usedChars,
    truncated,
  };
}

function toRecallEvents(
  events: TranscriptEvent[],
  maxChars: number,
): { events: TranscriptRecallEvent[]; chars: number; truncated: boolean } {
  const results: TranscriptRecallEvent[] = [];
  let used = 0;
  let truncated = false;
  for (const event of events) {
    const text = eventText(event);
    const available = maxChars - used;
    if (available <= 0) {
      truncated = true;
      break;
    }
    const clipped = text.length > available ? clipToAvailable(text, available) : text;
    used += clipped.length;
    results.push({
      sequence: event.sequence,
      at: event.at,
      source: event.source,
      eventType: event.eventType,
      text: clipped,
    });
    truncated ||= clipped.length < text.length;
  }
  return { events: results, chars: used, truncated };
}

function clipToAvailable(value: string, available: number): string {
  const marker = "...[truncated]";
  if (available <= 0) return "";
  if (available <= marker.length) return value.slice(0, available);
  return `${value.slice(0, available - marker.length)}${marker}`;
}

function eventText(event: TranscriptEvent): string {
  if (event.source === "harness" && event.eventType === "progress") return "";
  return event.message ?? "";
}

async function readAllTranscriptEvents(
  runStore: Pick<RunTranscriptStore, "readTranscript">,
  runId: string,
): Promise<TranscriptEvent[]> {
  const events: TranscriptEvent[] = [];
  let offset = 0;
  do {
    const page = await runStore.readTranscript(runId, { offset, limit: 1_000 });
    events.push(...page.events);
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  } while (true);
  return events;
}

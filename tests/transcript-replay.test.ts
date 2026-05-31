import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalRunReplayEvents,
  initialRunSessionReplayState,
  reduceRunSessionReplayEvent,
  replayRunSessionState,
  type ReplayedRunSessionState,
} from "../src/app/RunReplayProjection.js";
import { FileRunTranscriptStore, type RunRecord, type RunStatus, type TranscriptEvent } from "../src/core/persistence/RunTranscriptStore.js";
import type { TokenCounts } from "../src/core/types.js";

interface FixtureEventInput extends Omit<TranscriptEvent, "runId" | "sequence"> {
  sequence?: number;
}

interface ReplayFixtureResult {
  incremental: ReplayedRunSessionState;
  replayed: ReplayedRunSessionState;
  persistedRun: RunRecord;
  persistedEvents: TranscriptEvent[];
  rawRestartEvents: TranscriptEvent[];
}

describe("run event replay reconstruction", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-run-replay-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    {
      label: "normal completion",
      events: [
        sessionStarted("2026-01-01T00:00:00.000Z", "session-normal", "agent-normal"),
        event({
          at: "2026-01-01T00:00:01.000Z",
          source: "runtime",
          eventType: "message_delta",
          message: "raw delta should not be final",
          payload: { textPreview: "partial implementation answer" },
        }),
        event({
          at: "2026-01-01T00:00:02.000Z",
          source: "runtime",
          eventType: "message_complete",
          message: "raw complete should not leak",
          payload: { textPreview: "final implementation answer", status: "completed" },
        }),
        tokenEvent("2026-01-01T00:00:03.000Z", { inputTokens: 120, outputTokens: 30, totalTokens: 150 }),
        completed("2026-01-01T00:00:04.000Z", "done"),
      ],
      expected: {
        sessionId: "session-normal",
        agentId: "agent-normal",
        status: "succeeded" as const,
        completedAt: "2026-01-01T00:00:04.000Z",
        error: null,
        tokens: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
        assistantTexts: ["final implementation answer"],
        absentMessageFragments: ["partial implementation answer", "raw delta should not be final"],
      },
    },
    {
      label: "failure",
      events: [
        sessionStarted("2026-01-02T00:00:00.000Z", "session-failure", "agent-failure"),
        event({
          at: "2026-01-02T00:00:01.000Z",
          source: "runtime",
          eventType: "message_delta",
          payload: { textPreview: "partial before failure" },
        }),
        tokenEvent("2026-01-02T00:00:02.000Z", { inputTokens: 50, outputTokens: 10, totalTokens: 60 }),
        event({
          at: "2026-01-02T00:00:03.000Z",
          source: "harness",
          eventType: "run_diagnostic",
          message: "Cursor wait failed",
          payload: { code: "cursor_run_wait_threw", message: "Cursor wait failed" },
        }),
        failed("2026-01-02T00:00:04.000Z", "Cursor SDK wait failed"),
      ],
      expected: {
        sessionId: "session-failure",
        agentId: "agent-failure",
        status: "failed" as const,
        completedAt: "2026-01-02T00:00:04.000Z",
        error: "Cursor SDK wait failed",
        tokens: { inputTokens: 50, outputTokens: 10, totalTokens: 60 },
        assistantTexts: ["partial before failure"],
        absentMessageFragments: [],
      },
    },
    {
      label: "cancellation",
      events: [
        sessionStarted("2026-01-03T00:00:00.000Z", "session-cancelled", "agent-cancelled"),
        runStatus("2026-01-03T00:00:01.000Z", "running", "initial"),
        tokenEvent("2026-01-03T00:00:02.000Z", { inputTokens: 75, outputTokens: 5, totalTokens: 80 }),
        cancelled("2026-01-03T00:00:03.000Z"),
      ],
      expected: {
        sessionId: "session-cancelled",
        agentId: "agent-cancelled",
        status: "cancelled" as const,
        completedAt: "2026-01-03T00:00:03.000Z",
        error: null,
        tokens: { inputTokens: 75, outputTokens: 5, totalTokens: 80 },
        assistantTexts: [],
        absentMessageFragments: [],
      },
    },
    {
      label: "missing completion",
      events: [
        sessionStarted("2026-01-04T00:00:00.000Z", "session-running", "agent-running"),
        event({
          at: "2026-01-04T00:00:01.000Z",
          source: "runtime",
          eventType: "message_delta",
          payload: { textPreview: "still" },
        }),
        event({
          at: "2026-01-04T00:00:02.000Z",
          source: "runtime",
          eventType: "message_delta",
          payload: { textPreview: "working" },
        }),
        tokenEvent("2026-01-04T00:00:03.000Z", { inputTokens: 25, outputTokens: 6, totalTokens: 31 }),
      ],
      expected: {
        sessionId: "session-running",
        agentId: "agent-running",
        status: "running" as const,
        completedAt: null,
        error: null,
        tokens: { inputTokens: 25, outputTokens: 6, totalTokens: 31 },
        assistantTexts: ["still working"],
        absentMessageFragments: [],
      },
    },
  ])(
    "rebuilds $label state from persisted events after restart and matches incremental reduction",
    async ({ label, events, expected }) => {
      const result = await persistAndReplay(label, events);

      expect(stateWithoutMessages(result.replayed)).toEqual(stateWithoutMessages(result.incremental));
      expect(result.replayed).toMatchObject({
        sessionId: expected.sessionId,
        agentId: expected.agentId,
        status: expected.status,
        completedAt: expected.completedAt,
        error: expected.error,
        tokens: expected.tokens,
      });
      expect(assistantTexts(result.replayed)).toEqual(expected.assistantTexts);
      for (const fragment of expected.absentMessageFragments) {
        expect(JSON.stringify(result.replayed.messages)).not.toContain(fragment);
      }
      expect(result.persistedRun.tokens).toEqual(expected.tokens);
      expect(result.persistedRun.status).toBe(expected.status);
    },
  );

  it("deduplicates persisted event sequences, coalesces noisy streams, and keeps first terminal state", async () => {
    const result = await persistAndReplay("noisy duplicate", [
      sessionStarted("2026-01-05T00:00:00.000Z", "session-noisy", "agent-noisy", 1),
      event({
        sequence: 2,
        at: "2026-01-05T00:00:01.000Z",
        source: "runtime",
        eventType: "message_delta",
        payload: { textPreview: "partial noisy answer" },
      }),
      event({
        sequence: 3,
        at: "2026-01-05T00:00:02.000Z",
        source: "runtime",
        eventType: "message_complete",
        payload: { textPreview: "final noisy answer", status: "completed" },
      }),
      event({
        sequence: 3,
        at: "2026-01-05T00:00:02.500Z",
        source: "runtime",
        eventType: "message_complete",
        payload: { textPreview: "duplicate final answer must be ignored", status: "completed" },
      }),
      event({
        sequence: 4,
        at: "2026-01-05T00:00:03.000Z",
        source: "runtime",
        eventType: "tool_start",
        message: "terminal started",
        payload: { toolId: "tool-1", name: "terminal", argsPreview: 'cmd="npm test"' },
      }),
      event({
        sequence: 5,
        at: "2026-01-05T00:00:04.000Z",
        source: "cursor",
        eventType: "status_update",
        message: "workspace indexing",
        payload: { status: "indexing", messagePreview: "workspace indexing" },
      }),
      runStatus("2026-01-05T00:00:05.000Z", "running", "initial", 6),
      event({
        sequence: 7,
        at: "2026-01-05T00:00:06.000Z",
        source: "runtime",
        eventType: "tool_complete",
        message: "terminal completed",
        payload: { toolId: "tool-1", name: "terminal", resultPreview: "tests passed" },
      }),
      runStatus("2026-01-05T00:00:07.000Z", "finished", "wait", 8),
      tokenEvent("2026-01-05T00:00:08.000Z", { inputTokens: 90, outputTokens: 20, totalTokens: 110 }, 9),
      tokenEvent("2026-01-05T00:00:09.000Z", { inputTokens: 90, outputTokens: 20, totalTokens: 110 }, 10),
      completed("2026-01-05T00:00:10.000Z", "completed first", 11),
      failed("2026-01-05T00:00:11.000Z", "late duplicate terminal failure must not win", 12),
    ]);

    expect(result.rawRestartEvents).toHaveLength(13);
    expect(canonicalRunReplayEvents(result.persistedRun.runId, result.rawRestartEvents)).toHaveLength(12);
    expect(stateWithoutMessages(result.replayed)).toEqual(stateWithoutMessages(result.incremental));
    expect(result.replayed).toMatchObject({
      sessionId: "session-noisy",
      agentId: "agent-noisy",
      status: "succeeded",
      completedAt: "2026-01-05T00:00:10.000Z",
      error: null,
      tokens: { inputTokens: 90, outputTokens: 20, totalTokens: 110 },
      transcriptEventCount: 12,
      sdkRunStatus: "finished",
      sdkRunStatusObservedAt: "2026-01-05T00:00:07.000Z",
      sdkRunStatusSource: "wait",
    });
    expect(assistantTexts(result.replayed)).toEqual(["final noisy answer"]);
    expect(JSON.stringify(result.replayed.messages)).not.toContain("partial noisy answer");
    expect(JSON.stringify(result.replayed.messages)).not.toContain("duplicate final answer must be ignored");
    expect(JSON.stringify(result.replayed.messages)).not.toContain("late duplicate terminal failure must not win");
    expect(toolMessages(result.replayed)).toEqual([
      expect.objectContaining({
        kind: "tool_call",
        call_id: "tool-1",
        name: "terminal",
        status: "completed",
        args: { preview: 'cmd="npm test"' },
        result: "tests passed",
      }),
    ]);
  });

  async function persistAndReplay(label: string, inputs: FixtureEventInput[]): Promise<ReplayFixtureResult> {
    const runId = `run-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
    const issueIdentifier = label.toUpperCase().replace(/[^A-Z0-9]+/g, "-");
    const store = new FileRunTranscriptStore(root);
    await store.startRun({
      runId,
      sessionId: null,
      agentId: null,
      role: "worker",
      issueId: `issue-${issueIdentifier}`,
      issueIdentifier,
      attempt: null,
      turnNumber: 1,
      prompt: `Implement ${issueIdentifier}`,
      harnessId: "hermes",
      runtimeModel: "gpt-5-test",
      workspaceKey: issueIdentifier,
      workspacePath: `/tmp/${issueIdentifier}`,
    });
    const initialRun = await mustGetRun(store, runId);
    const persistedEvents: TranscriptEvent[] = [];
    const incrementalEvents: TranscriptEvent[] = [];
    const seenSequences = new Set<number>();
    let incremental = initialRunSessionReplayState(initialRun);

    for (const input of inputs) {
      const persisted = await store.appendEvent({ runId, ...input });
      persistedEvents.push(persisted);
      if (!seenSequences.has(persisted.sequence)) {
        seenSequences.add(persisted.sequence);
        incrementalEvents.push(persisted);
        incremental = reduceRunSessionReplayEvent(incremental, persisted);
      }
      await persistReplayMetadata(store, runId, incremental);
    }
    incremental = { ...incremental, messages: replayRunSessionState(initialRun, incrementalEvents).messages };

    const reloaded = new FileRunTranscriptStore(root);
    const persistedRun = await mustGetRun(reloaded, runId);
    const page = await reloaded.readTranscript(runId, { offset: 0, limit: 1_000 });
    const replayed = replayRunSessionState(persistedRun, page.events);
    return { incremental, replayed, persistedRun, persistedEvents, rawRestartEvents: page.events };
  }
});

async function mustGetRun(store: FileRunTranscriptStore, runId: string): Promise<RunRecord> {
  const run = await store.getRun(runId);
  if (!run) throw new Error(`missing run ${runId}`);
  return run;
}

async function persistReplayMetadata(
  store: FileRunTranscriptStore,
  runId: string,
  state: ReplayedRunSessionState,
): Promise<void> {
  await store.updateRun(runId, {
    status: state.status,
    completedAt: state.completedAt,
    error: state.error,
    tokens: state.tokens,
    metadata: {
      sdkRunStatus: state.sdkRunStatus,
      sdkRunStatusObservedAt: state.sdkRunStatusObservedAt,
      sdkRunStatusSource: state.sdkRunStatusSource,
    },
  });
}

function stateWithoutMessages(state: ReplayedRunSessionState): Omit<ReplayedRunSessionState, "messages"> {
  const { messages: _messages, ...rest } = state;
  return rest;
}

function assistantTexts(state: ReplayedRunSessionState): string[] {
  return state.messages.filter((message) => message.kind === "assistant").map((message) => message.text);
}

function toolMessages(state: ReplayedRunSessionState): Array<Extract<ReplayedRunSessionState["messages"][number], { kind: "tool_call" }>> {
  return state.messages.filter((message): message is Extract<typeof message, { kind: "tool_call" }> => message.kind === "tool_call");
}

function sessionStarted(at: string, sessionId: string, threadId: string, sequence?: number): FixtureEventInput {
  return event({
    ...withSequence(sequence),
    at,
    source: "harness",
    eventType: "session_started",
    payload: { type: "session_started", sessionId, threadId },
  });
}

function tokenEvent(at: string, tokens: TokenCounts, sequence?: number): FixtureEventInput {
  return event({
    ...withSequence(sequence),
    at,
    source: "harness",
    eventType: "tokens",
    payload: { type: "tokens", tokens },
  });
}

function runStatus(
  at: string,
  sdkStatus: "running" | "finished" | "error" | "cancelled",
  source: "initial" | "onDidChangeStatus" | "wait",
  sequence?: number,
): FixtureEventInput {
  return event({
    ...withSequence(sequence),
    at,
    source: "harness",
    eventType: "run_status",
    payload: { type: "run_status", sdkStatus, source },
  });
}

function completed(at: string, message?: string, sequence?: number): FixtureEventInput {
  return event({
    ...withSequence(sequence),
    at,
    source: "harness",
    eventType: "completed",
    ...(message === undefined ? {} : { message }),
    payload: { type: "completed", ...(message === undefined ? {} : { message }) },
  });
}

function failed(at: string, error: string, sequence?: number): FixtureEventInput {
  return event({
    ...withSequence(sequence),
    at,
    source: "harness",
    eventType: "failed",
    payload: { type: "failed", error },
  });
}

function cancelled(at: string, sequence?: number): FixtureEventInput {
  return event({
    ...withSequence(sequence),
    at,
    source: "harness",
    eventType: "cancelled",
    payload: { type: "cancelled" },
  });
}

function event(overrides: FixtureEventInput): FixtureEventInput {
  const defaults = {
    at: "2026-01-01T00:00:00.000Z",
    source: "harness",
    eventType: "progress",
  };
  return { ...defaults, ...overrides };
}

function withSequence(sequence: number | undefined): Partial<Pick<TranscriptEvent, "sequence">> {
  return sequence === undefined ? {} : { sequence };
}

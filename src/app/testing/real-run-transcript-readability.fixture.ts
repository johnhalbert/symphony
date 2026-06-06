import { projectWebTranscript, type TranscriptMessage, type WebTranscriptEvent } from "../WebTranscriptProjectionCore.js";

const realRunId = "run-real-readability-01";
const largeRealRunId = "run-real-readability-large-01";
const baseTimestampMs = Date.parse("2026-03-01T09:00:00.000Z");

interface FixtureEventInput extends Omit<WebTranscriptEvent, "runId" | "sequence" | "at"> {
  atOffsetMs: number;
}

export interface LargeRealRunTranscriptReadabilityFixture {
  runId: string;
  cycleCount: number;
  eventCount: number;
  expectedMessageCount: number;
  expectedAssistantCount: number;
  expectedToolCallCount: number;
  expectedProviderLimitCount: number;
  events: readonly WebTranscriptEvent[];
}

function transcriptEvent(runId: string, sequence: number, input: FixtureEventInput): WebTranscriptEvent {
  const { atOffsetMs, ...event } = input;
  return {
    ...event,
    runId,
    sequence,
    at: new Date(baseTimestampMs + atOffsetMs).toISOString(),
  };
}

export const realRunTranscriptReadabilityEvents = [
  transcriptEvent(realRunId, 1, {
    atOffsetMs: 0,
    source: "harness",
    eventType: "assistant_message_delta",
    message: "Readability chunk",
    payload: {
      kind: "assistant_message_delta",
      actor: "assistant",
      channel: "chat",
      textPreview: "Readability pass: split tokens and wrap long lines",
      delta: true,
    },
  }),
  transcriptEvent(realRunId, 2, {
    atOffsetMs: 250,
    source: "harness",
    eventType: "assistant_message_delta",
    message: "Readability chunk",
    payload: {
      kind: "assistant_message_delta",
      actor: "assistant",
      channel: "chat",
      textPreview: " while preserving command output context.",
      delta: true,
    },
  }),
  transcriptEvent(realRunId, 3, {
    atOffsetMs: 1_000,
    source: "cursor",
    eventType: "tool_call",
    message: "cursor tool_call started",
    payload: {
      kind: "tool_call",
      callId: "tool-call-real-readability",
      name: "terminal",
      status: "running",
      inputPreview: 'cmd="cat .env" token=REAL_RUN_TOKEN_123456789',
      resultPreview: "starting...",
    },
  }),
  transcriptEvent(realRunId, 4, {
    atOffsetMs: 2_000,
    source: "cursor",
    eventType: "tool_call",
    message: "cursor tool_call complete",
    payload: {
      kind: "tool_call",
      callId: "tool-call-real-readability",
      name: "terminal",
      status: "succeeded",
      inputPreview: 'cmd="cat .env" token=REAL_RUN_TOKEN_123456789',
      outputPreview: "tests: 42 passed\ncoverage: 98.8%\nrunId: run-real-readability-01",
      resultPreview: "tests passed",
      result: "tests passed with no secret output",
    },
  }),
  transcriptEvent(realRunId, 5, {
    atOffsetMs: 3_000,
    source: "harness",
    eventType: "assistant",
    message: "Readability summary",
    payload: {
      kind: "assistant",
      text: "Long transcript lines are now grouped and rendered with stable whitespace.",
      redacted: true,
    },
  }),
  transcriptEvent(realRunId, 6, {
    atOffsetMs: 3_500,
    source: "runtime",
    eventType: "provider_limit",
    message: "Requests paused for provider window",
    payload: {
      kind: "provider_limit",
      signal: {
        kind: "windowed_bucket_exhausted",
        message: "Requests paused for provider window",
        scope: { providerId: "openai", model: "gpt-5.4" },
        window: { resumeAt: "2026-03-01T09:01:00.000Z" },
        apiKey: "SECRET_PROVIDER_LIMIT_KEY",
      },
    },
  }),
  transcriptEvent(realRunId, 7, {
    atOffsetMs: 4_000,
    source: "harness",
    eventType: "run_diagnostic",
    message: "Recovered from a transient stream condition",
    payload: {
      type: "run_diagnostic",
      code: "transcript_readability",
      message: "Recovered from a transient stream condition",
      messagePreview: "diagnostic: token=REAL_RUN_TOKEN_123456789",
      details: {
        token: "REAL_RUN_TOKEN_123456789",
        nested: {
          apiKey: "SECRET_REAL_RUN_API_KEY",
        },
      },
    },
  }),
  transcriptEvent(realRunId, 8, {
    atOffsetMs: 4_500,
    source: "harness",
    eventType: "tokens",
    message: "Fixture token update",
    payload: {
      type: "tokens",
      tokens: {
        inputTokens: 9,
        outputTokens: 7,
        totalTokens: 16,
      },
      details: { api_key: "PUBLIC_OK", token: "REAL_RUN_TOKEN_123456789" },
    },
  }),
  transcriptEvent(realRunId, 9, {
    atOffsetMs: 5_000,
    source: "harness",
    eventType: "run_cancelled",
    message: "Cancelled after operator stop request token=REAL_RUN_TOKEN_123456789",
    payload: {
      kind: "run_cancelled",
      message: "Cancelled after operator stop request token=REAL_RUN_TOKEN_123456789",
      reason: "operator stop",
    },
  }),
] as const satisfies readonly WebTranscriptEvent[];

export function buildLargeRealRunTranscriptReadabilityFixture(input: {
  cycleCount?: number;
} = {}): LargeRealRunTranscriptReadabilityFixture {
  const cycleCount = input.cycleCount ?? 18;
  const events: WebTranscriptEvent[] = [];
  let sequence = 1;
  let expectedProviderLimitCount = 0;

  for (let cycle = 0; cycle < cycleCount; cycle += 1) {
    const cycleNumber = cycle + 1;
    const cycleLabel = String(cycleNumber).padStart(2, "0");
    const offsetBaseMs = cycle * 15_000;
    const callId = `tool-call-large-readability-${cycleLabel}`;

    events.push(
      transcriptEvent(largeRealRunId, sequence++, {
        atOffsetMs: offsetBaseMs,
        source: "runtime",
        eventType: "run_status",
        message: `Cycle ${cycleLabel} metadata heartbeat`,
        payload: { kind: "run_status", status: "running", message: `Cycle ${cycleLabel} metadata heartbeat` },
      }),
      transcriptEvent(largeRealRunId, sequence++, {
        atOffsetMs: offsetBaseMs + 250,
        source: "harness",
        eventType: "assistant_message_delta",
        message: `Cycle ${cycleLabel} readability delta`,
        payload: {
          kind: "assistant_message_delta",
          actor: "assistant",
          channel: "chat",
          textPreview: `Cycle ${cycleLabel}: merge transcript deltas`,
          delta: true,
        },
      }),
      transcriptEvent(largeRealRunId, sequence++, {
        atOffsetMs: offsetBaseMs + 500,
        source: "harness",
        eventType: "assistant_message_delta",
        message: `Cycle ${cycleLabel} readability delta`,
        payload: {
          kind: "assistant_message_delta",
          actor: "assistant",
          channel: "chat",
          textPreview: " and keep output previews readable.",
          delta: true,
        },
      }),
      transcriptEvent(largeRealRunId, sequence++, {
        atOffsetMs: offsetBaseMs + 1_000,
        source: "cursor",
        eventType: "tool_call",
        message: `Cycle ${cycleLabel} tool call started`,
        payload: {
          kind: "tool_call",
          callId,
          name: "terminal",
          status: "running",
          inputPreview: `cmd=\"node cycle-${cycleLabel}.js\" token=LARGE_REAL_RUN_TOKEN_${cycleLabel}`,
          resultPreview: "starting...",
        },
      }),
      transcriptEvent(largeRealRunId, sequence++, {
        atOffsetMs: offsetBaseMs + 2_000,
        source: "cursor",
        eventType: "tool_call",
        message: `Cycle ${cycleLabel} tool call complete`,
        payload: {
          kind: "tool_call",
          callId,
          name: "terminal",
          status: "succeeded",
          inputPreview: `cmd=\"node cycle-${cycleLabel}.js\" token=LARGE_REAL_RUN_TOKEN_${cycleLabel}`,
          outputPreview: `cycle ${cycleLabel} output line 1\ncycle ${cycleLabel} output line 2`,
          resultPreview: `cycle ${cycleLabel} completed`,
          result: `cycle ${cycleLabel} completed without leaking secrets`,
        },
      }),
      transcriptEvent(largeRealRunId, sequence++, {
        atOffsetMs: offsetBaseMs + 2_500,
        source: "harness",
        eventType: "tokens",
        message: `Cycle ${cycleLabel} token usage`,
        payload: {
          type: "tokens",
          tokens: {
            inputTokens: 50 + cycle,
            outputTokens: 25 + cycle,
            totalTokens: 75 + cycle * 2,
          },
          details: {
            apiKey: `SECRET_TOKEN_DETAILS_${cycleLabel}`,
            traceToken: `LARGE_REAL_RUN_TOKEN_${cycleLabel}`,
          },
        },
      }),
      transcriptEvent(largeRealRunId, sequence++, {
        atOffsetMs: offsetBaseMs + 3_000,
        source: "harness",
        eventType: "run_diagnostic",
        message: `Cycle ${cycleLabel} recovered from stream backpressure`,
        payload: {
          type: "run_diagnostic",
          code: `cycle_${cycleLabel}_diagnostic`,
          message: `Cycle ${cycleLabel} recovered from stream backpressure`,
          details: {
            token: `LARGE_REAL_RUN_TOKEN_${cycleLabel}`,
            nested: { apiKey: `SECRET_DIAGNOSTIC_${cycleLabel}` },
          },
        },
      }),
    );

    if (cycleNumber % 3 === 0) {
      expectedProviderLimitCount += 1;
      events.push(
        transcriptEvent(largeRealRunId, sequence++, {
          atOffsetMs: offsetBaseMs + 3_500,
          source: "runtime",
          eventType: "provider_limit",
          message: `Cycle ${cycleLabel} paused for provider window`,
          payload: {
            kind: "provider_limit",
            signal: {
              kind: "windowed_bucket_exhausted",
              message: `Cycle ${cycleLabel} paused for provider window`,
              scope: { providerId: "openai", model: "gpt-5.4" },
              window: { resumeAt: `2026-03-01T09:${String(cycleNumber).padStart(2, "0")}:00.000Z` },
              apiKey: `SECRET_PROVIDER_LIMIT_${cycleLabel}`,
            },
          },
        }),
      );
    }
  }

  events.push(
    transcriptEvent(largeRealRunId, sequence++, {
      atOffsetMs: cycleCount * 15_000,
      source: "harness",
      eventType: "run_failed",
      message: "Run failed after provider interruption token=REAL_RUN_TOKEN_123456789",
      payload: {
        kind: "run_failed",
        error: "Run failed after provider interruption token=REAL_RUN_TOKEN_123456789",
      },
    }),
  );

  return {
    runId: largeRealRunId,
    cycleCount,
    eventCount: events.length,
    expectedMessageCount: cycleCount * 4 + expectedProviderLimitCount + 1,
    expectedAssistantCount: cycleCount,
    expectedToolCallCount: cycleCount,
    expectedProviderLimitCount,
    events,
  };
}

export const realRunTranscriptReadabilityFixtureRunId = realRunId;

export interface ProjectedLargeRealRunTranscriptReadabilityFixture extends LargeRealRunTranscriptReadabilityFixture {
  messages: TranscriptMessage[];
}

export const projectedRealRunTranscriptReadabilityMessages = projectWebTranscript([...realRunTranscriptReadabilityEvents]);

export function buildProjectedLargeRealRunTranscriptReadabilityFixture(input: {
  cycleCount?: number;
} = {}): ProjectedLargeRealRunTranscriptReadabilityFixture {
  const fixture = buildLargeRealRunTranscriptReadabilityFixture(input);
  return {
    ...fixture,
    messages: projectWebTranscript([...fixture.events]),
  };
}

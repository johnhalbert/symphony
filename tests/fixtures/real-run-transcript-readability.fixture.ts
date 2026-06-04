import type { TranscriptEvent } from "../../src/core/persistence/RunTranscriptStore.js";

const runId = "run-real-readability-01";

export const realRunTranscriptReadabilityEvents: readonly TranscriptEvent[] = [
  {
    runId,
    sequence: 1,
    at: "2026-03-01T09:00:00.000Z",
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
  },
  {
    runId,
    sequence: 2,
    at: "2026-03-01T09:00:00.250Z",
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
  },
  {
    runId,
    sequence: 3,
    at: "2026-03-01T09:00:01.000Z",
    source: "cursor",
    eventType: "tool_call",
    message: "cursor tool_call started",
    payload: {
      kind: "tool_call",
      callId: "tool-call-real-readability",
      name: "terminal",
      status: "running",
      inputPreview: "cmd=\"cat .env\" token=REAL_RUN_TOKEN_123456789",
      resultPreview: "starting...",
    },
  },
  {
    runId,
    sequence: 4,
    at: "2026-03-01T09:00:02.000Z",
    source: "cursor",
    eventType: "tool_call",
    message: "cursor tool_call complete",
    payload: {
      kind: "tool_call",
      callId: "tool-call-real-readability",
      name: "terminal",
      status: "succeeded",
      inputPreview: "cmd=\"cat .env\" token=REAL_RUN_TOKEN_123456789",
      outputPreview: "tests: 42 passed\ncoverage: 98.8%\nrunId: run-real-readability-01",
      resultPreview: "tests passed",
      result: "tests passed with no secret output",
    },
  },
  {
    runId,
    sequence: 5,
    at: "2026-03-01T09:00:03.000Z",
    source: "harness",
    eventType: "assistant",
    message: "Readability summary",
    payload: {
      kind: "assistant",
      text: "Long transcript lines are now grouped and rendered with stable whitespace.",
      redacted: true,
    },
  },
  {
    runId,
    sequence: 6,
    at: "2026-03-01T09:00:04.000Z",
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
  },
  {
    runId,
    sequence: 7,
    at: "2026-03-01T09:00:05.000Z",
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
  },
] as const;

export const realRunTranscriptReadabilityFixtureRunId = runId;

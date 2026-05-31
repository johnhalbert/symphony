import { describe, expect, it } from "vitest";
import { projectWebTranscript } from "../src/app/WebTranscriptProjection.js";
import type { RunRecord, TranscriptEvent } from "../src/core/persistence/RunTranscriptStore.js";

describe("projectWebTranscript", () => {
  it("maps sanitized Cursor transcript preview payloads into public web transcript messages", () => {
    const messages = projectWebTranscript([
      event({
        eventType: "tool_call",
        source: "cursor",
        message: "tool shell completed",
        payload: {
          kind: "tool_call",
          callId: "call-1",
          name: "shell",
          status: "completed",
          argumentsPreview: 'command="npm test" token=[redacted]',
          resultPreview: "tests passed",
          outputPreview: "stdout safe",
          errorPreview: "stderr safe",
          truncated: true,
          rawArgs: { command: "echo SECRET_TOOL_VALUE", apiKey: "SECRET_API_VALUE" },
          result: { stdout: "Bearer raw-secret-token", internalOnly: "result-only" },
          internalOnly: "payload-only",
        },
      }),
      event({
        eventType: "thinking",
        source: "cursor",
        message: "Cursor thinking event",
        payload: { kind: "thinking", summary: "actual reasoning from public summary", redacted: true },
      }),
      event({
        eventType: "assistant",
        source: "cursor",
        message: "Cursor assistant message",
        payload: { kind: "assistant", textPreview: "actual assistant text", truncated: false },
      }),
      event({ eventType: "progress", source: "harness", message: "harness response" }),
      event({
        eventType: "task",
        source: "cursor",
        message: "Cursor task event",
        payload: { kind: "task", summary: "actual task summary", redacted: true },
      }),
      event({
        eventType: "approval_request",
        source: "orchestrator",
        message: "Approval required",
        payload: {
          reason: "workflow_policy",
          prompt: "Approve publication?",
          actions: [{ label: "Approve" }, { id: "reject" }],
        },
      }),
      event({ eventType: "human_required", source: "orchestrator", message: "Human input needed" }),
      event({ eventType: "surprise_event", source: "orchestrator", message: "fallback status" }),
    ]);

    expect(messages.map((message) => message.kind)).toEqual([
      "tool_call",
      "thinking",
      "assistant",
      "assistant",
      "task",
      "request",
      "request",
      "status",
    ]);
    expect(messages[0]).toEqual({
      kind: "tool_call",
      ts: "2026-01-01T00:00:00.000Z",
      call_id: "call-1",
      name: "shell",
      status: "completed",
      args: { preview: 'command="npm test" token=[redacted]' },
      result: "tests passed",
      output: "stdout safe",
      error: "stderr safe",
      truncated: true,
    });
    expect(messages[1]).toMatchObject({ kind: "thinking", text: "actual reasoning from public summary" });
    expect(messages[2]).toMatchObject({ kind: "assistant", text: "actual assistant text" });
    expect(messages[3]).toMatchObject({ kind: "assistant", text: "harness response" });
    expect(messages[4]).toEqual({
      kind: "task",
      ts: "2026-01-01T00:00:00.000Z",
      title: "task",
      desc: "actual task summary",
    });
    expect(messages[5]).toEqual({
      kind: "request",
      ts: "2026-01-01T00:00:00.000Z",
      reason: "workflow_policy",
      q: "Approve publication?",
      actions: ["Approve", "reject"],
    });
    expect(messages[6]).toMatchObject({ kind: "request", q: "Human input needed" });
    expect(messages[7]).toEqual({
      kind: "status",
      state: "surprise_event",
      ts: "2026-01-01T00:00:00.000Z",
      text: "fallback status",
    });
    const serialized = JSON.stringify(messages);
    expect(serialized).not.toContain("SECRET_TOOL_VALUE");
    expect(serialized).not.toContain("SECRET_API_VALUE");
    expect(serialized).not.toContain("raw-secret-token");
    expect(serialized).not.toContain("payload-only");
    expect(serialized).not.toContain("internalOnly");
    expect(serialized).not.toContain("Cursor thinking event");
    expect(serialized).not.toContain("Cursor assistant message");
    expect(serialized).not.toContain("Cursor task event");
  });

  it("coalesces Hermes runtime deltas and tool pairs while preserving public-safe run prelude messages", () => {
    const messages = projectWebTranscript(
      [
        event({
          eventType: "message_delta",
          source: "runtime",
          message: "Hermes message delta",
          payload: { textPreview: "partial assistant text" },
        }),
        event({
          eventType: "message_complete",
          source: "runtime",
          message: "Hermes message complete",
          payload: { textPreview: "final assistant text", status: "completed" },
          at: "2026-01-01T00:00:01.000Z",
          sequence: 2,
        }),
        event({
          eventType: "tool_start",
          source: "runtime",
          message: "Hermes tool terminal started",
          payload: { toolId: "tool-1", name: "terminal", argsPreview: "cmd=\"npm test\" apiKey=[redacted]" },
          at: "2026-01-01T00:00:02.000Z",
          sequence: 3,
        }),
        event({
          eventType: "tool_complete",
          source: "runtime",
          message: "Hermes tool terminal completed",
          payload: { toolId: "tool-1", name: "terminal", resultPreview: "tests passed", errorPreview: null },
          at: "2026-01-01T00:00:03.000Z",
          sequence: 4,
        }),
        event({
          eventType: "approval_resolved",
          source: "orchestrator",
          message: "Operator approval approved: branch -> main",
          payload: { status: "approved", decision: "approve" },
          at: "2026-01-01T00:00:04.000Z",
          sequence: 5,
        }),
      ],
      { run: runRecord({ prompt: "Issue: publish safely\n\napiKey=SECRET_PROMPT_VALUE" }) },
    );

    expect(messages).toEqual([
      {
        kind: "system",
        ts: "2026-01-01T00:00:00.000Z",
        model: "gpt-5-test",
        cwd: "/tmp/workspaces/TEST-1",
        workspace: "TEST-1",
        session: "session-1",
        tools: [],
        note: "Initialized implementation run from persisted run metadata. System prompt redacted.",
      },
      {
        kind: "user",
        ts: "2026-01-01T00:00:00.000Z",
        from: "orchestrator",
        issue: "TEST-1",
        text: "Issue: publish safely\n\napiKey=[redacted]",
      },
      { kind: "assistant", ts: "2026-01-01T00:00:01.000Z", text: "final assistant text" },
      {
        kind: "tool_call",
        ts: "2026-01-01T00:00:02.000Z",
        call_id: "tool-1",
        name: "terminal",
        status: "completed",
        args: { preview: "cmd=\"npm test\" apiKey=[redacted]" },
        result: "tests passed",
      },
      {
        kind: "status",
        state: "approved",
        ts: "2026-01-01T00:00:04.000Z",
        text: "Operator approval approved: branch -> main",
      },
    ]);
    const serialized = JSON.stringify(messages);
    expect(serialized).not.toContain("partial assistant text");
    expect(serialized).not.toContain("SECRET_PROMPT_VALUE");
  });

  it("maps reasoning aliases to thinking with public text previews", () => {
    expect(
      projectWebTranscript([
        event({
          eventType: "reasoning_delta",
          source: "cursor",
          message: "Cursor thinking event",
          payload: { kind: "thinking", textPreview: "actual reasoning text preview" },
        }),
      ]),
    ).toEqual([{ kind: "thinking", ts: "2026-01-01T00:00:00.000Z", text: "actual reasoning text preview" }]);
  });

  it("projects Cursor status, system, and unknown events as non-assistant messages", () => {
    const messages = projectWebTranscript([
      event({
        eventType: "status",
        source: "cursor",
        message: "Cursor status running",
        payload: { kind: "status", status: "running", messagePreview: "workspace ready" },
      }),
      event({
        eventType: "system",
        source: "cursor",
        message: "Cursor system event: startup",
        payload: { kind: "system", subtype: "startup", messagePreview: "system public preview", truncated: false },
      }),
      event({ eventType: "some_new_cursor_kind", source: "cursor" }),
    ]);

    expect(messages).toEqual([
      { kind: "status", state: "running", ts: "2026-01-01T00:00:00.000Z", text: "workspace ready" },
      {
        kind: "system",
        ts: "2026-01-01T00:00:00.000Z",
        model: "",
        cwd: "",
        workspace: "",
        session: "run-1",
        tools: [],
        note: "system public preview",
      },
      {
        kind: "status",
        state: "some_new_cursor_kind",
        ts: "2026-01-01T00:00:00.000Z",
        text: "some_new_cursor_kind",
      },
    ]);
    expect(messages.map((message) => message.kind)).not.toContain("assistant");
  });

  it("projects persisted harness-provided ACP RunActivityEvent taxonomy without falling back to legacy progress", () => {
    const messages = projectWebTranscript([
      event({
        eventType: "assistant_message_delta",
        source: "harness",
        message: "Hello",
        payload: { kind: "assistant_message_delta", actor: "assistant", channel: "message", textPreview: "Hello", delta: true },
      }),
      event({
        eventType: "assistant_message_delta",
        source: "harness",
        message: "world",
        payload: { kind: "assistant_message_delta", actor: "assistant", channel: "message", textPreview: "world", delta: true },
        at: "2026-01-01T00:00:01.000Z",
        sequence: 2,
      }),
      event({
        eventType: "assistant_reasoning_delta",
        source: "harness",
        message: "Hermes ACP thought update",
        payload: { kind: "assistant_reasoning_delta", actor: "assistant", channel: "message", messagePreview: "public thought preview" },
        at: "2026-01-01T00:00:02.000Z",
        sequence: 3,
      }),
      event({
        eventType: "tool_call_started",
        source: "harness",
        message: "Hermes ACP tool started: terminal",
        payload: { kind: "tool_call_started", actor: "tool", channel: "tool", toolCallId: "call-1", toolName: "terminal", status: "running", inputPreview: 'cmd="npm test"' },
        at: "2026-01-01T00:00:03.000Z",
        sequence: 4,
      }),
      event({
        eventType: "tool_call_completed",
        source: "harness",
        message: "Hermes ACP tool completed: terminal",
        payload: { kind: "tool_call_completed", actor: "tool", channel: "tool", toolCallId: "call-1", toolName: "terminal", status: "succeeded", outputPreview: "tests passed" },
        at: "2026-01-01T00:00:04.000Z",
        sequence: 5,
      }),
      event({
        eventType: "token_usage_reported",
        source: "harness",
        message: "Token usage reported",
        payload: { kind: "token_usage_reported", actor: "runtime", channel: "token", inputTokens: 3, outputTokens: 5, totalTokens: 8 },
        at: "2026-01-01T00:00:05.000Z",
        sequence: 6,
      }),
      event({
        eventType: "runtime_diagnostic",
        source: "harness",
        message: "ACP permission denied",
        payload: { kind: "runtime_diagnostic", actor: "runtime", channel: "status", code: "hermes_acp_permission_denied", messagePreview: "permission denied" },
        at: "2026-01-01T00:00:06.000Z",
        sequence: 7,
      }),
      event({
        eventType: "run_cancelled",
        source: "harness",
        message: "Run cancelled",
        payload: { kind: "run_cancelled", actor: "runtime", channel: "terminal", reason: "run_cancelled" },
        at: "2026-01-01T00:00:07.000Z",
        sequence: 8,
      }),
      event({
        eventType: "run_failed",
        source: "harness",
        message: "Run failed token=SECRET_FAILURE_TOKEN",
        payload: { kind: "run_failed", actor: "runtime", channel: "terminal", errorPreview: "Run failed token=SECRET_FAILURE_TOKEN", redacted: true },
        at: "2026-01-01T00:00:08.000Z",
        sequence: 9,
      }),
    ]);

    expect(messages).toEqual([
      { kind: "assistant", ts: "2026-01-01T00:00:00.000Z", text: "Hello world" },
      { kind: "thinking", ts: "2026-01-01T00:00:02.000Z", text: "public thought preview" },
      {
        kind: "tool_call",
        ts: "2026-01-01T00:00:03.000Z",
        call_id: "call-1",
        name: "terminal",
        status: "succeeded",
        args: { preview: 'cmd="npm test"' },
        result: "tests passed",
        output: "tests passed",
      },
      { kind: "status", state: "token_usage_reported", ts: "2026-01-01T00:00:05.000Z", text: "Token usage reported" },
      { kind: "status", state: "runtime_diagnostic", ts: "2026-01-01T00:00:06.000Z", text: "permission denied" },
      { kind: "status", state: "run_cancelled", ts: "2026-01-01T00:00:07.000Z", text: "Run cancelled" },
      { kind: "status", state: "run_failed", ts: "2026-01-01T00:00:08.000Z", text: "Run failed token=[redacted]" },
    ]);
    expect(JSON.stringify(messages)).not.toContain("SECRET_FAILURE_TOKEN");
  });

  it("keeps unresolved request actions exact empty arrays and maps unknown payloads without leaking runtime fields", () => {
    const messages = projectWebTranscript([
      event({
        eventType: "approval_request",
        source: "orchestrator",
        message: "Approval requested",
        payload: {
          reason: "workflow_policy",
          prompt: "Operator approval requested",
          actions: [{ unresolvedId: "approve-secret" }, {}, null, ""],
          rawRequest: { token: "SECRET_ACTION_TOKEN" },
        },
      }),
      event({
        eventType: "brand_new_runtime_event",
        source: "runtime",
        message: "raw SECRET_RUNTIME_MESSAGE",
        payload: {
          textPreview: "Public fallback status",
          runId: "internal-run-id",
          toolArgs: { token: "SECRET_TOOL_ARG" },
          result: "SECRET_RESULT_PAYLOAD",
        },
      }),
    ]);

    expect(messages).toEqual([
      {
        kind: "request",
        ts: "2026-01-01T00:00:00.000Z",
        reason: "workflow_policy",
        q: "Operator approval requested",
        actions: [],
      },
      {
        kind: "status",
        state: "brand_new_runtime_event",
        ts: "2026-01-01T00:00:00.000Z",
        text: "Public fallback status",
      },
    ]);
    expect(messages[0]?.kind === "request" ? messages[0].actions : null).toEqual([]);
    expect(messages[0]?.kind === "request" ? messages[0].actions : null).not.toBeUndefined();
    const serialized = JSON.stringify(messages);
    expect(serialized).not.toContain("SECRET_");
    expect(serialized).not.toContain("internal-run-id");
    expect(serialized).not.toContain("rawRequest");
    expect(serialized).not.toContain("toolArgs");
  });

});

function runRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: "run-1",
    sessionId: "session-1",
    agentId: "agent-1",
    role: "worker",
    runPhase: "implementation",
    runKind: "implementation",
    issueId: "test-1",
    issueIdentifier: "TEST-1",
    attempt: null,
    turnNumber: 1,
    prompt: "Implement TEST-1",
    harnessId: "hermes",
    runtimeModel: "gpt-5-test",
    cursorModel: "claude-sonnet-4",
    workspaceKey: "TEST-1",
    workspacePath: "/tmp/workspaces/TEST-1",
    status: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    error: null,
    tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    transcriptEventCount: 0,
    ...overrides,
  };
}

function event(overrides: Partial<TranscriptEvent>): TranscriptEvent {
  return {
    runId: "run-1",
    sequence: 1,
    at: "2026-01-01T00:00:00.000Z",
    source: "harness",
    eventType: "progress",
    ...overrides,
  };
}

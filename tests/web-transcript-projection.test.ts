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

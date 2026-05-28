import { describe, expect, it } from "vitest";
import { projectWebTranscript } from "../src/app/WebTranscriptProjection.js";
import type { TranscriptEvent } from "../src/core/persistence/RunTranscriptStore.js";

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

});

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

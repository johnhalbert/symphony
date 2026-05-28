import { describe, expect, it } from "vitest";
import { projectWebTranscript } from "../src/app/WebTranscriptProjection.js";
import type { TranscriptEvent } from "../src/core/persistence/RunTranscriptStore.js";

describe("projectWebTranscript", () => {
  it("maps sanitized transcript events into public web transcript messages", () => {
    const messages = projectWebTranscript([
      event({
        eventType: "tool_call",
        source: "cursor",
        payload: {
          type: "tool_call",
          call_id: "call-1",
          name: "shell",
          status: "completed",
          args: { command: "echo SECRET_TOOL_VALUE", apiKey: "SECRET_API_VALUE" },
          result: { stdout: "Bearer raw-secret-token", internalOnly: "result-only" },
          internalOnly: "payload-only",
        },
      }),
      event({ eventType: "reasoning", source: "cursor", payload: { text: "thinking through the task" } }),
      event({ eventType: "message", source: "cursor", message: "assistant response" }),
      event({ eventType: "progress", source: "harness", message: "harness response" }),
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
      "request",
      "request",
      "status",
    ]);
    expect(messages[0]).toMatchObject({
      kind: "tool_call",
      call_id: "call-1",
      name: "shell",
      status: "completed",
      args: { command: "echo [redacted]", apiKey: "[redacted]" },
      result: null,
    });
    expect(messages[1]).toMatchObject({ kind: "thinking", text: "thinking through the task" });
    expect(messages[2]).toMatchObject({ kind: "assistant", text: "assistant response" });
    expect(messages[3]).toMatchObject({ kind: "assistant", text: "harness response" });
    expect(messages[4]).toEqual({
      kind: "request",
      ts: "2026-01-01T00:00:00.000Z",
      reason: "workflow_policy",
      q: "Approve publication?",
      actions: ["Approve", "reject"],
    });
    expect(messages[5]).toMatchObject({ kind: "request", q: "Human input needed" });
    expect(messages[6]).toEqual({
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

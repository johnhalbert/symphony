import { describe, expect, it } from "vitest";
import {
  projectTranscriptEventForPublicRead,
  redactTextPreserveFormatting,
  sanitizeAgentEventForPublicOutput,
} from "../src/core/transcript/TranscriptProjection.js";
import type { TranscriptEvent } from "../src/core/persistence/RunTranscriptStore.js";

describe("transcript public formatting redaction", () => {
  it("redacts secrets while preserving transcript-safe formatting", () => {
    const value = "Line one\r\n\tindented SECRET_DELTA_TOKEN\n\n```ts\nconst x = 1;\n```\x1b[31mred\x1b[0m\x07";

    expect(redactTextPreserveFormatting(value, 1_000)).toEqual({
      text: "Line one\n\tindented [redacted]\n\n```ts\nconst x = 1;\n```red",
      truncated: false,
      redacted: true,
    });
  });

  it("preserves the complete redacted terminal response before transcript persistence", () => {
    const response = `Final disposition\n\n${"complete finding\n".repeat(800)}token=SECRET_TERMINAL_TOKEN`;

    const sanitized = sanitizeAgentEventForPublicOutput({ type: "completed", message: response });

    expect(sanitized).toMatchObject({
      type: "completed",
      message: expect.stringContaining("...[truncated]"),
      payload: {
        finalResponseText: expect.stringContaining(
          "complete finding\ncomplete finding",
        ),
      },
    });
    expect(
      sanitized.type === "completed" &&
        typeof (sanitized.payload as Record<string, unknown>)
          .finalResponseText === "string"
        ? (sanitized.payload as Record<string, string>).finalResponseText
        : null,
    ).toHaveLength(
      response.replace("SECRET_TERMINAL_TOKEN", "[redacted]").length,
    );
    expect(sanitized.type === "completed" ? sanitized.message?.length : null).toBeLessThanOrEqual(500);
    expect(JSON.stringify(sanitized)).not.toContain("SECRET_TERMINAL_TOKEN");
  });

  it("preserves public transcript display fields without formatting arbitrary nested JSON", () => {
    const event: TranscriptEvent = {
      runId: "run-1",
      sequence: 1,
      at: "2026-01-01T00:00:00.000Z",
      source: "runtime",
      eventType: "tool_complete",
      message: "tool terminal completed",
      payload: {
        kind: "tool_call",
        name: "terminal",
        outputPreview: "line 1\n  SECRET_TOOL_OUTPUT\nline 3",
        nested: { messagePreview: "nested\n  stays one line" },
      },
    };

    const publicEvent = projectTranscriptEventForPublicRead(event);

    expect(publicEvent.payload).toMatchObject({
      outputPreview: "line 1\n  [redacted]\nline 3",
      nested: { messagePreview: "nested stays one line" },
      redacted: true,
    });
  });

  it("keeps long assistant completion display text readable for transcript pages", () => {
    const longText = `Pass.\n\n${"final answer ".repeat(80)}SECRET_FINAL_TOKEN`;
    const event: TranscriptEvent = {
      runId: "run-1",
      sequence: 2,
      at: "2026-01-01T00:00:01.000Z",
      source: "harness",
      eventType: "run_succeeded",
      message: longText,
      payload: {
        kind: "run_succeeded",
        textPreview: longText,
      },
    };

    const publicEvent = projectTranscriptEventForPublicRead(event);

    expect(publicEvent.message).toContain("final answer final answer");
    expect(publicEvent.message).not.toContain("...[truncated]");
    expect(publicEvent.message).not.toContain("SECRET_FINAL_TOKEN");
    expect(publicEvent.payload).toMatchObject({
      textPreview: expect.stringContaining("Pass.\n\nfinal answer"),
      redacted: true,
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  projectTranscriptEventForPublicRead,
  redactTextPreserveFormatting,
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
});

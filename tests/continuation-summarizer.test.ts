import { describe, expect, it } from "vitest";
import { PlaceholderContinuationSummarizer } from "../src/core/summarization/ContinuationSummarizer.js";

describe("PlaceholderContinuationSummarizer", () => {
  it("returns a continuation summary reference with transcript and status pointers", async () => {
    const reference = await new PlaceholderContinuationSummarizer().summarizeContinuationHistory({
      issue: { id: "issue-1", identifier: "TEST-1", title: "Do work" },
      runs: [
        {
          runId: "run-1",
          sessionId: "session-1",
          agentId: "agent-1",
          role: "worker",
          issueId: "issue-1",
          issueIdentifier: "TEST-1",
          attempt: null,
          turnNumber: 1,
          prompt: "work",
          workspaceKey: "TEST-1",
          workspacePath: "/tmp/TEST-1",
          status: "succeeded",
          startedAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:01Z",
          completedAt: "2026-01-01T00:00:01Z",
          error: null,
          tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        },
      ],
      transcriptEvents: [
        {
          runId: "run-1",
          sequence: 1,
          at: "2026-01-01T00:00:00Z",
          source: "harness",
          eventType: "progress",
          message: "started",
        },
      ],
      transcriptPointers: ["/api/v1/runs/run-1/transcript"],
      statusApiPointers: ["/api/v1/issues/TEST-1"],
    });

    expect(reference).toMatchObject({
      kind: "continuation_history",
      summary:
        "Continuation history summarization is not automated yet. Use the linked transcript and status records for full context.",
      runIds: ["run-1"],
      transcriptEventCount: 1,
      transcriptPointers: ["/api/v1/runs/run-1/transcript"],
      statusApiPointers: ["/api/v1/issues/TEST-1"],
    });
    expect(reference.id).toContain("continuation-summary:issue-1:");
  });
});

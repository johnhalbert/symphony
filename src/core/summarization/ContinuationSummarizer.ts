import type { IssueLifecycleSummaryReference } from "../persistence/IssueLifecycleStore.js";
import type { RunRecord, TranscriptEvent } from "../persistence/RunTranscriptStore.js";
import type { Issue } from "../types.js";

export interface ContinuationSummarizationInput {
  issue: Pick<Issue, "id" | "identifier" | "title">;
  runs: RunRecord[];
  transcriptEvents: TranscriptEvent[];
  transcriptPointers: string[];
  statusApiPointers: string[];
}

export interface ContinuationSummarizer {
  summarizeContinuationHistory(input: ContinuationSummarizationInput): Promise<IssueLifecycleSummaryReference>;
}

export class PlaceholderContinuationSummarizer implements ContinuationSummarizer {
  async summarizeContinuationHistory(input: ContinuationSummarizationInput): Promise<IssueLifecycleSummaryReference> {
    return {
      id: `continuation-summary:${input.issue.id}:${new Date().toISOString()}`,
      kind: "continuation_history",
      summary:
        "Continuation history summarization is not automated yet. Use the linked transcript and status records for full context.",
      runIds: input.runs.map((run) => run.runId),
      transcriptEventCount: input.transcriptEvents.length,
      transcriptPointers: input.transcriptPointers,
      statusApiPointers: input.statusApiPointers,
      createdAt: new Date().toISOString(),
    };
  }
}

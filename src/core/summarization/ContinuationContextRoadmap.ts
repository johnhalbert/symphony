import type { Issue } from "../types.js";
import type { RunRecord, TranscriptEvent } from "../persistence/RunTranscriptStore.js";

export type ContinuationContextFeatureFlag =
  | "continuation_context.search_enabled"
  | "continuation_context.summarization_enabled";

export type ContinuationContextImplementationStatus = "implemented" | "not_implemented";

export interface ContinuationSearchInput {
  issue: Pick<Issue, "id" | "identifier" | "title">;
  query: string;
  maxResults?: number;
  transcriptPointers: string[];
  statusApiPointers: string[];
}

export interface ContinuationSearchResult {
  title: string;
  summary: string;
  pointer: string;
  score: number | null;
}

export interface ContinuationSearchProvider {
  searchContinuationContext(input: ContinuationSearchInput): Promise<ContinuationSearchResult[]>;
}

export interface RichContinuationSummarizationInput {
  issue: Pick<Issue, "id" | "identifier" | "title">;
  runs: RunRecord[];
  transcriptEvents: TranscriptEvent[];
  searchResults: ContinuationSearchResult[];
  transcriptPointers: string[];
  statusApiPointers: string[];
}

export interface RichContinuationSummaryDraft {
  summary: string;
  supportingPointers: string[];
  unresolvedQuestions: string[];
}

export interface RichContinuationSummarizer {
  summarizeContinuationContext(input: RichContinuationSummarizationInput): Promise<RichContinuationSummaryDraft>;
}

export interface ContinuationContextRoadmapEntry {
  capability: "search" | "summarization";
  flag: ContinuationContextFeatureFlag;
  implementationStatus: ContinuationContextImplementationStatus;
  dispatchPolicy: "no_orchestrator_dispatch";
  roadmapIssue: {
    state: "Backlog";
    labels: readonly string[];
    forbiddenLabels: readonly string[];
  };
}

const blockedRoadmapIssue = {
  state: "Backlog",
  labels: ["dogfood-blocked"],
  forbiddenLabels: ["dogfood-ready"],
} as const;

export const CONTINUATION_CONTEXT_ROADMAP = {
  search: {
    capability: "search",
    flag: "continuation_context.search_enabled",
    implementationStatus: "implemented",
    dispatchPolicy: "no_orchestrator_dispatch",
    roadmapIssue: blockedRoadmapIssue,
  },
  summarization: {
    capability: "summarization",
    flag: "continuation_context.summarization_enabled",
    implementationStatus: "not_implemented",
    dispatchPolicy: "no_orchestrator_dispatch",
    roadmapIssue: blockedRoadmapIssue,
  },
} as const satisfies Record<"search" | "summarization", ContinuationContextRoadmapEntry>;

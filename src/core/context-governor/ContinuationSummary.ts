import type { PromptSource } from "./PromptSource.js";
import type { StreamAccumulatorSnapshot } from "./StreamingTokenAccumulator.js";
import type { KnownPromptTokenCount } from "./TokenCounting.js";

export interface ContinuationSummary {
  version: 1;
  createdAt: string;
  reason: string;
  originalPrompt: {
    source: string;
    sha256: string;
    charCount: number;
    knownPromptTokens: number;
    tokenMethod: string;
    objectivePreview: string;
  };
  tokenStats: {
    observedOutputTokenDeltas: number;
    latestInputTokens: number | null;
    latestOutputTokens: number | null;
    latestTotalTokens: number | null;
  };
  summary: string;
  importantOutput: string[];
  openQuestions: string[];
  omissions: string[];
}

export function buildContinuationSummary(input: {
  prompt: PromptSource;
  knownPromptTokens: KnownPromptTokenCount;
  snapshot: StreamAccumulatorSnapshot;
  reason: string;
  now?: Date;
  maxOutputChars?: number;
}): ContinuationSummary {
  const maxOutputChars = input.maxOutputChars ?? 1_200;
  const assistantPreview = clip(oneLine(input.snapshot.assistantTextPreview), maxOutputChars);
  const thinkingPreview = clip(oneLine(input.snapshot.thinkingTextPreview), 400);
  const summaryPreview = clip(oneLine(input.snapshot.summaryTextPreview), 600);
  const latestUsage = input.snapshot.latestUsage;
  const importantOutput = [
    ...(assistantPreview.length === 0 ? [] : [`Assistant output before interruption: ${assistantPreview}`]),
    ...(thinkingPreview.length === 0 ? [] : [`Thinking/status preview: ${thinkingPreview}`]),
    ...(summaryPreview.length === 0 ? [] : [`SDK summary preview: ${summaryPreview}`]),
  ];
  return {
    version: 1,
    createdAt: (input.now ?? new Date()).toISOString(),
    reason: input.reason,
    originalPrompt: {
      source: input.prompt.label,
      sha256: input.prompt.sha256,
      charCount: input.prompt.charCount,
      knownPromptTokens: input.knownPromptTokens.tokens,
      tokenMethod: input.knownPromptTokens.method,
      objectivePreview: clip(input.prompt.text.trim(), input.maxOutputChars ?? 1_200),
    },
    tokenStats: {
      observedOutputTokenDeltas: input.snapshot.observedOutputTokenDeltas,
      latestInputTokens: latestUsage?.inputTokens ?? null,
      latestOutputTokens: latestUsage?.outputTokens ?? null,
      latestTotalTokens: latestUsage?.totalTokens ?? null,
    },
    summary: `Continuation summary for ${input.prompt.label}; prior run stopped because ${input.reason}.`,
    importantOutput,
    openQuestions: ["Continue the original objective using only this compact summary and the original prompt hash as context."],
    omissions: [
      "This deterministic POC summary may omit low-salience details from the interrupted run.",
      "Raw transcript and full Cursor server-side context are not embedded in this continuation prompt.",
    ],
  };
}

export function renderContinuationPrompt(summary: ContinuationSummary): string {
  return [
    "You are continuing an interrupted Cursor SDK run from a compact Symphony context-governor summary.",
    "",
    "Original prompt:",
    `- Source: ${summary.originalPrompt.source}`,
    `- SHA-256: ${summary.originalPrompt.sha256}`,
    `- Characters: ${summary.originalPrompt.charCount}`,
    `- Known prompt tokens (${summary.originalPrompt.tokenMethod}): ${summary.originalPrompt.knownPromptTokens}`,
    "",
    "Original objective:",
    summary.originalPrompt.objectivePreview.length === 0 ? "- No original prompt text was captured." : summary.originalPrompt.objectivePreview,
    "",
    "Interruption:",
    `- Reason: ${summary.reason}`,
    `- Observed output token deltas: ${summary.tokenStats.observedOutputTokenDeltas}`,
    `- Latest SDK input/output/total: ${formatNullable(summary.tokenStats.latestInputTokens)} / ${formatNullable(
      summary.tokenStats.latestOutputTokens,
    )} / ${formatNullable(summary.tokenStats.latestTotalTokens)}`,
    "",
    "Summary:",
    `- ${summary.summary}`,
    "",
    "Important output:",
    ...(summary.importantOutput.length === 0 ? ["- No assistant output was captured before interruption."] : summary.importantOutput.map((item) => `- ${item}`)),
    "",
    "Open questions:",
    ...summary.openQuestions.map((item) => `- ${item}`),
    "",
    "Known omissions:",
    ...summary.omissions.map((item) => `- ${item}`),
    "",
    "Continue the task from this compact context. If required information is missing, state exactly what is missing instead of inventing it.",
  ].join("\n");
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clip(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 15))}...[truncated]`;
}

function formatNullable(value: number | null): string {
  return value === null ? "n/a" : String(value);
}

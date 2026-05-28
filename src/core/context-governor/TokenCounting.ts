export interface KnownPromptTokenCount {
  method: "heuristic-v1";
  exact: false;
  tokens: number;
  charCount: number;
  byteCount: number;
  notes: string[];
}

export interface SdkUsageTokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

export interface PromptTokenReconciliation {
  knownPromptTokens: number;
  sdkInputTokens: number;
  deltaTokens: number;
  ratio: number | null;
  note: string;
}

export function countKnownPromptTokens(text: string): KnownPromptTokenCount {
  const charCount = [...text].length;
  const byteCount = Buffer.byteLength(text, "utf8");
  if (charCount === 0) {
    return {
      method: "heuristic-v1",
      exact: false,
      tokens: 0,
      charCount,
      byteCount,
      notes: ["Empty prompt; no known prompt tokens estimated."],
    };
  }

  const segmentCount = text.match(/\p{L}+|\p{N}+|[^\s\p{L}\p{N}]/gu)?.length ?? 0;
  const charEstimate = Math.ceil(charCount / 4);
  const byteEstimate = Math.ceil(byteCount / 4);
  const tokens = Math.max(1, charEstimate, byteEstimate, segmentCount);
  return {
    method: "heuristic-v1",
    exact: false,
    tokens,
    charCount,
    byteCount,
    notes: [
      "Local estimate for known prompt text only.",
      "Cursor may add system, tool, workspace, or retained conversation context before the model call.",
    ],
  };
}

export function sdkUsageFromUnknown(value: unknown): SdkUsageTokenCounts | null {
  if (!isRecord(value)) return null;
  const inputTokens = numberValue(value.inputTokens);
  const outputTokens = numberValue(value.outputTokens);
  if (inputTokens === null || outputTokens === null) return null;
  const cacheReadTokens = numberValue(value.cacheReadTokens) ?? 0;
  const cacheWriteTokens = numberValue(value.cacheWriteTokens) ?? 0;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

export function reconcileKnownPromptTokens(
  knownPrompt: KnownPromptTokenCount,
  usage: Pick<SdkUsageTokenCounts, "inputTokens">,
): PromptTokenReconciliation {
  const deltaTokens = usage.inputTokens - knownPrompt.tokens;
  return {
    knownPromptTokens: knownPrompt.tokens,
    sdkInputTokens: usage.inputTokens,
    deltaTokens,
    ratio: knownPrompt.tokens === 0 ? null : usage.inputTokens / knownPrompt.tokens,
    note:
      "Delta includes heuristic error plus any Cursor-added system, tool, workspace, or retained conversation context.",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

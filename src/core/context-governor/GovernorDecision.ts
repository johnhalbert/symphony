import type { StreamAccumulatorSnapshot } from "./StreamingTokenAccumulator.js";

export type GovernorDecisionAction = "continue" | "block_before_send" | "cancel_and_summarize";

export interface GovernorThresholds {
  maxKnownPromptTokens?: number;
  maxObservedOutputTokens?: number;
  maxEstimatedRunTotalTokens?: number;
  maxTurnInputTokens?: number;
  maxTurnTotalTokens?: number;
}

export interface GovernorDecision {
  action: GovernorDecisionAction;
  reason: string | null;
  observedValue: number | null;
  threshold: number | null;
}

export interface EstimatedRunTokenTotal {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedTotalTokens: number;
  exact: false;
  notes: string[];
}

export function decideBeforeSend(input: {
  knownPromptTokens: number;
  inputReserveTokens?: number;
  thresholds: GovernorThresholds;
}): GovernorDecision {
  const estimatedTotalThreshold = input.thresholds.maxEstimatedRunTotalTokens;
  if (estimatedTotalThreshold !== undefined) {
    const estimate = estimateRunTokenTotal({
      knownPromptTokens: input.knownPromptTokens,
      inputReserveTokens: input.inputReserveTokens,
    });
    if (estimate.estimatedInputTokens >= estimatedTotalThreshold) {
      return {
        action: "block_before_send",
        reason: "estimated_run_input_tokens_exceeded",
        observedValue: estimate.estimatedInputTokens,
        threshold: estimatedTotalThreshold,
      };
    }
  }

  const threshold = input.thresholds.maxKnownPromptTokens;
  if (threshold !== undefined && input.knownPromptTokens > threshold) {
    return {
      action: "block_before_send",
      reason: "known_prompt_tokens_exceeded",
      observedValue: input.knownPromptTokens,
      threshold,
    };
  }
  return continueDecision();
}

export function decideDuringRun(input: {
  snapshot: StreamAccumulatorSnapshot;
  knownPromptTokens?: number;
  inputReserveTokens?: number;
  thresholds: GovernorThresholds;
}): GovernorDecision {
  const estimatedTotalThreshold = input.thresholds.maxEstimatedRunTotalTokens;
  if (estimatedTotalThreshold !== undefined && input.knownPromptTokens !== undefined) {
    const estimate = estimateRunTokenTotal({
      knownPromptTokens: input.knownPromptTokens,
      inputReserveTokens: input.inputReserveTokens,
      snapshot: input.snapshot,
    });
    if (estimate.estimatedTotalTokens >= estimatedTotalThreshold) {
      return {
        action: "cancel_and_summarize",
        reason: "estimated_run_total_tokens_exceeded",
        observedValue: estimate.estimatedTotalTokens,
        threshold: estimatedTotalThreshold,
      };
    }
  }

  const outputThreshold = input.thresholds.maxObservedOutputTokens;
  if (outputThreshold !== undefined && input.snapshot.observedOutputTokenDeltas >= outputThreshold) {
    return {
      action: "cancel_and_summarize",
      reason: "observed_output_tokens_exceeded",
      observedValue: input.snapshot.observedOutputTokenDeltas,
      threshold: outputThreshold,
    };
  }
  const usage = input.snapshot.latestUsage;
  const inputThreshold = input.thresholds.maxTurnInputTokens;
  if (usage && inputThreshold !== undefined && usage.inputTokens > inputThreshold) {
    return {
      action: "cancel_and_summarize",
      reason: "turn_input_tokens_exceeded",
      observedValue: usage.inputTokens,
      threshold: inputThreshold,
    };
  }
  const totalThreshold = input.thresholds.maxTurnTotalTokens;
  if (usage && totalThreshold !== undefined && usage.totalTokens > totalThreshold) {
    return {
      action: "cancel_and_summarize",
      reason: "turn_total_tokens_exceeded",
      observedValue: usage.totalTokens,
      threshold: totalThreshold,
    };
  }
  return continueDecision();
}

export function estimateRunTokenTotal(input: {
  knownPromptTokens: number;
  inputReserveTokens?: number | undefined;
  snapshot?: StreamAccumulatorSnapshot | undefined;
}): EstimatedRunTokenTotal {
  const reserve = input.inputReserveTokens ?? 0;
  const estimatedInputTokens = input.knownPromptTokens + reserve;
  const estimatedOutputTokens = input.snapshot?.estimatedOutputTokens ?? 0;
  return {
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedTotalTokens: estimatedInputTokens + estimatedOutputTokens,
    exact: false,
    notes: [
      "Estimated from local known-prompt tokens, configured input reserve, and live observed output tokens.",
      "Exact SDK input/total usage is only available after turn-ended when emitted.",
    ],
  };
}

function continueDecision(): GovernorDecision {
  return { action: "continue", reason: null, observedValue: null, threshold: null };
}

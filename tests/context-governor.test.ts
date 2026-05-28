import { describe, expect, it } from "vitest";
import {
  buildContinuationSummary,
  countKnownPromptTokens,
  decideBeforeSend,
  decideDuringRun,
  estimateRunTokenTotal,
  evidenceEvent,
  promptSourceFromText,
  reconcileKnownPromptTokens,
  renderContinuationPrompt,
  serializeEvidenceEvent,
  StreamingTokenAccumulator,
  type RuntimeModel,
  validateModelSelection,
} from "../src/core/context-governor/index.js";

describe("active context governor primitives", () => {
  it("records prompt metadata and local token estimates without claiming exactness", () => {
    const prompt = promptSourceFromText({ kind: "inline", label: "test", text: "Implement the governor.\nUse tests." });
    const count = countKnownPromptTokens(prompt.text);

    expect(prompt).toMatchObject({
      kind: "inline",
      label: "test",
      charCount: 34,
      lineCount: 2,
    });
    expect(prompt.sha256).toHaveLength(64);
    expect(count.exact).toBe(false);
    expect(count.tokens).toBeGreaterThan(0);
    expect(count.notes.join(" ")).toContain("known prompt text only");
  });

  it("reconciles known prompt estimates against SDK input tokens", () => {
    const known = countKnownPromptTokens("hello world");
    const reconciliation = reconcileKnownPromptTokens(known, { inputTokens: known.tokens + 7 });

    expect(reconciliation).toMatchObject({
      knownPromptTokens: known.tokens,
      sdkInputTokens: known.tokens + 7,
      deltaTokens: 7,
    });
    expect(reconciliation.note).toContain("Cursor-added");
  });

  it("validates requested model params and fails closed on implicit large context defaults", () => {
    const catalog: RuntimeModel[] = [
      {
        id: "gpt-5.5",
        displayName: "GPT-5.5",
        parameters: [
          { id: "context", values: [{ value: "272k" }, { value: "1m" }] },
          { id: "reasoning", values: [{ value: "medium" }, { value: "extra-high" }] },
        ],
        variants: [
          {
            displayName: "GPT-5.5",
            isDefault: true,
            params: [
              { id: "context", value: "1m" },
              { id: "reasoning", value: "medium" },
            ],
          },
        ],
      },
    ];

    expect(
      validateModelSelection(
        catalog,
        {
          id: "gpt-5.5",
          params: [
            { id: "context", value: "272k" },
            { id: "reasoning", value: "extra-high" },
          ],
        },
        { allowLargeContext: false },
      ),
    ).toMatchObject({ ok: true, errors: [] });
    expect(validateModelSelection(catalog, { id: "gpt-5.5" }, { allowLargeContext: false }).errors).toContain(
      "Model gpt-5.5 default context is 1m; specify a bounded context or allow large context explicitly",
    );
    expect(validateModelSelection(catalog, { id: "gpt-5.5", params: [{ id: "context", value: "2m" }] }, { allowLargeContext: false }).ok).toBe(
      false,
    );
  });

  it("accumulates streaming output deltas and reconciles turn-ended usage", () => {
    const accumulator = new StreamingTokenAccumulator();

    accumulator.recordUpdate({ type: "text-delta", text: "hello " });
    accumulator.recordUpdate({ type: "token-delta", tokens: 2 });
    accumulator.recordUpdate({ type: "thinking-delta", text: "thinking" });
    accumulator.recordUpdate({ type: "turn-ended", usage: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 4 } });
    accumulator.recordMessage({
      type: "system",
      subtype: "init",
      model: { id: "gpt-5.5", params: [{ id: "context", value: "272k" }] },
    });
    accumulator.recordMessage({
      type: "assistant",
      message: { content: [{ type: "text", text: "world" }] },
    });

    expect(accumulator.snapshot()).toMatchObject({
      observedOutputTokenDeltas: 2,
      estimatedOutputTokens: 4,
      textDeltaChars: 6,
      thinkingDeltaChars: 8,
      latestUsage: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 0, totalTokens: 13 },
      systemModels: [{ id: "gpt-5.5", params: [{ id: "context", value: "272k" }] }],
    });
    expect(accumulator.snapshot().assistantTextPreview).toContain("hello world");
  });

  it("makes pre-send and during-run threshold decisions", () => {
    expect(decideBeforeSend({ knownPromptTokens: 11, thresholds: { maxKnownPromptTokens: 10 } })).toMatchObject({
      action: "block_before_send",
      reason: "known_prompt_tokens_exceeded",
    });

    const accumulator = new StreamingTokenAccumulator();
    accumulator.recordUpdate({ type: "token-delta", tokens: 5 });
    expect(decideDuringRun({ snapshot: accumulator.snapshot(), thresholds: { maxObservedOutputTokens: 5 } })).toMatchObject({
      action: "cancel_and_summarize",
      reason: "observed_output_tokens_exceeded",
    });
  });

  it("gates runs on estimated total tokens before and during a run", () => {
    expect(
      decideBeforeSend({
        knownPromptTokens: 95,
        inputReserveTokens: 5,
        thresholds: { maxEstimatedRunTotalTokens: 100 },
      }),
    ).toMatchObject({
      action: "block_before_send",
      reason: "estimated_run_input_tokens_exceeded",
      observedValue: 100,
      threshold: 100,
    });

    const accumulator = new StreamingTokenAccumulator();
    accumulator.recordUpdate({ type: "token-delta", tokens: 20 });
    expect(
      decideDuringRun({
        snapshot: accumulator.snapshot(),
        knownPromptTokens: 75,
        inputReserveTokens: 5,
        thresholds: { maxEstimatedRunTotalTokens: 100 },
      }),
    ).toMatchObject({
      action: "cancel_and_summarize",
      reason: "estimated_run_total_tokens_exceeded",
      observedValue: 100,
      threshold: 100,
    });
  });

  it("estimates output from text deltas when token deltas are sparse", () => {
    const accumulator = new StreamingTokenAccumulator();
    accumulator.recordUpdate({ type: "text-delta", text: "a".repeat(40) });
    const estimate = estimateRunTokenTotal({
      knownPromptTokens: 25,
      inputReserveTokens: 5,
      snapshot: accumulator.snapshot(),
    });

    expect(accumulator.snapshot().observedOutputTokenDeltas).toBe(0);
    expect(accumulator.snapshot().estimatedOutputTokens).toBe(10);
    expect(estimate).toMatchObject({
      estimatedInputTokens: 30,
      estimatedOutputTokens: 10,
      estimatedTotalTokens: 40,
      exact: false,
    });
  });

  it("builds bounded continuation summaries and prompts", () => {
    const prompt = promptSourceFromText({ kind: "inline", label: "prompt.md", text: "Please do the work." });
    const knownPromptTokens = countKnownPromptTokens(prompt.text);
    const accumulator = new StreamingTokenAccumulator();
    accumulator.recordUpdate({ type: "text-delta", text: "I inspected the target and found the next step." });
    accumulator.recordUpdate({ type: "turn-ended", usage: { inputTokens: 20, outputTokens: 9 } });

    const summary = buildContinuationSummary({
      prompt,
      knownPromptTokens,
      snapshot: accumulator.snapshot(),
      reason: "observed_output_tokens_exceeded",
      now: new Date("2026-01-01T00:00:00Z"),
    });
    const continuationPrompt = renderContinuationPrompt(summary);

    expect(summary).toMatchObject({
      version: 1,
      reason: "observed_output_tokens_exceeded",
      originalPrompt: { objectivePreview: "Please do the work." },
      tokenStats: { latestInputTokens: 20, latestOutputTokens: 9, latestTotalTokens: 29 },
    });
    expect(continuationPrompt).toContain("compact Symphony context-governor summary");
    expect(continuationPrompt).toContain(prompt.sha256);
    expect(continuationPrompt).toContain("Please do the work.");
  });

  it("serializes JSONL evidence events", () => {
    const event = evidenceEvent("prompt_loaded", { ok: true }, new Date("2026-01-01T00:00:00Z"));

    expect(serializeEvidenceEvent(event)).toBe('{"at":"2026-01-01T00:00:00.000Z","kind":"prompt_loaded","payload":{"ok":true}}\n');
  });
});

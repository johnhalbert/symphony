import type { RuntimeModelSelection } from "./ModelCatalogPolicy.js";
import { sdkUsageFromUnknown, type SdkUsageTokenCounts } from "./TokenCounting.js";

export interface StreamAccumulatorSnapshot {
  updateCounts: Record<string, number>;
  messageCounts: Record<string, number>;
  observedOutputTokenDeltas: number;
  estimatedOutputTokens: number;
  textDeltaChars: number;
  thinkingDeltaChars: number;
  assistantTextPreview: string;
  thinkingTextPreview: string;
  summaryTextPreview: string;
  latestUsage: SdkUsageTokenCounts | null;
  usages: SdkUsageTokenCounts[];
  systemModels: RuntimeModelSelection[];
}

export class StreamingTokenAccumulator {
  private readonly updateCounts = new Map<string, number>();
  private readonly messageCounts = new Map<string, number>();
  private observedOutputTokenDeltas = 0;
  private textDeltaChars = 0;
  private thinkingDeltaChars = 0;
  private assistantTextPreview = "";
  private thinkingTextPreview = "";
  private summaryTextPreview = "";
  private readonly usages: SdkUsageTokenCounts[] = [];
  private readonly systemModels: RuntimeModelSelection[] = [];

  constructor(private readonly previewCharLimit = 4_000) {}

  recordUpdate(update: unknown): StreamAccumulatorSnapshot {
    const type = updateType(update);
    this.increment(this.updateCounts, type);
    if (!isRecord(update)) return this.snapshot();

    if (type === "token-delta") {
      const tokens = numberValue(update.tokens);
      if (tokens !== null && tokens > 0) this.observedOutputTokenDeltas += tokens;
    }
    if (type === "text-delta") {
      const text = stringValue(update.text);
      if (text !== null) {
        this.textDeltaChars += [...text].length;
        this.assistantTextPreview = appendPreview(this.assistantTextPreview, text, this.previewCharLimit);
      }
    }
    if (type === "thinking-delta") {
      const text = stringValue(update.text);
      if (text !== null) {
        this.thinkingDeltaChars += [...text].length;
        this.thinkingTextPreview = appendPreview(this.thinkingTextPreview, text, this.previewCharLimit);
      }
    }
    if (type.startsWith("summary")) {
      const text = stringValue(update.text) ?? stringValue(update.summary) ?? stringValue(update.message);
      if (text !== null) this.summaryTextPreview = appendPreview(this.summaryTextPreview, text, this.previewCharLimit);
    }
    if (type === "turn-ended") {
      const usage = sdkUsageFromUnknown(update.usage);
      if (usage) this.usages.push(usage);
    }
    return this.snapshot();
  }

  recordMessage(message: unknown): StreamAccumulatorSnapshot {
    const type = updateType(message);
    this.increment(this.messageCounts, type);
    if (!isRecord(message)) return this.snapshot();
    if (type === "system" && message.subtype === "init" && isRecord(message.model) && typeof message.model.id === "string") {
      this.systemModels.push(message.model as unknown as RuntimeModelSelection);
    }
    if (type === "assistant" && isRecord(message.message) && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
          this.assistantTextPreview = appendPreview(this.assistantTextPreview, block.text, this.previewCharLimit);
        }
      }
    }
    return this.snapshot();
  }

  snapshot(): StreamAccumulatorSnapshot {
    const charEstimatedOutputTokens = Math.ceil((this.textDeltaChars + this.thinkingDeltaChars) / 4);
    return {
      updateCounts: Object.fromEntries(this.updateCounts.entries()),
      messageCounts: Object.fromEntries(this.messageCounts.entries()),
      observedOutputTokenDeltas: this.observedOutputTokenDeltas,
      estimatedOutputTokens: Math.max(this.observedOutputTokenDeltas, charEstimatedOutputTokens),
      textDeltaChars: this.textDeltaChars,
      thinkingDeltaChars: this.thinkingDeltaChars,
      assistantTextPreview: this.assistantTextPreview,
      thinkingTextPreview: this.thinkingTextPreview,
      summaryTextPreview: this.summaryTextPreview,
      latestUsage: this.usages.at(-1) ?? null,
      usages: [...this.usages],
      systemModels: [...this.systemModels],
    };
  }

  private increment(target: Map<string, number>, type: string): void {
    target.set(type, (target.get(type) ?? 0) + 1);
  }
}

function updateType(value: unknown): string {
  return isRecord(value) && typeof value.type === "string" ? value.type : "unknown";
}

function appendPreview(current: string, next: string, limit: number): string {
  if (current.length >= limit) return current;
  const joined = `${current}${next}`;
  return joined.length <= limit ? joined : joined.slice(0, limit);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

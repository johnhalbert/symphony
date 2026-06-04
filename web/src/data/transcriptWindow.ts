import type { TranscriptMessage, TranscriptWindowResponse } from "../types/symphony";

export const DEFAULT_TRANSCRIPT_TAIL_LIMIT = 500;

export interface TranscriptWindowResponseInput {
  kind?: "page" | "tail";
  offset?: number | null;
  limit?: number | null;
  total?: number | null;
  nextOffset?: number | null;
  previousOffset?: number | null;
  hasNext?: boolean;
  hasPrevious?: boolean;
  firstSequence?: number | null;
  lastSequence?: number | null;
  lastEventAt?: string | null;
  runStatus?: string | null;
  refetchHref?: string | null;
}

export function createTranscriptWindowResponse(
  messages: readonly TranscriptMessage[],
  input: TranscriptWindowResponseInput = {},
): TranscriptWindowResponse {
  const limit = finiteNumberOrDefault(input.limit, DEFAULT_TRANSCRIPT_TAIL_LIMIT);
  const offset = finiteNumberOrDefault(input.offset, 0);
  const total = finiteNumberOrNull(input.total) ?? messages.length;
  const previousOffset = input.previousOffset !== undefined ? finiteNumberOrNull(input.previousOffset) : offset > 0 ? Math.max(0, offset - limit) : null;
  const nextOffset = input.nextOffset !== undefined ? finiteNumberOrNull(input.nextOffset) : null;
  const kind = input.kind ?? "tail";
  const firstSequence = finiteNumberOrNull(input.firstSequence);
  const lastSequence = finiteNumberOrNull(input.lastSequence);
  const lastEventAt = nonEmptyStringOrNull(input.lastEventAt);
  const refetchHref = nonEmptyStringOrNull(input.refetchHref);
  const activeTailEnabled = kind === "tail" && input.runStatus === "running";
  const page = {
    offset,
    limit,
    size: messages.length,
    total,
    nextOffset,
    previousOffset,
    hasNext: input.hasNext ?? nextOffset !== null,
    hasPrevious: input.hasPrevious ?? previousOffset !== null,
    firstSequence,
    lastSequence,
    lastEventAt,
  };
  return {
    schemaVersion: 1,
    messages: [...messages],
    page,
    window: {
      ...page,
      kind,
      tailLimit: limit,
      messageCount: messages.length,
      requested: { offset: kind === "tail" ? null : offset, limit },
    },
    activeTail: {
      enabled: activeTailEnabled,
      canAppend: activeTailEnabled,
      runStatus: input.runStatus ?? null,
      tailLimit: limit,
      afterSequence: lastSequence,
      lastEventAt,
      refetchHref,
      gapFallback: { strategy: "refetch", reason: "tail-gap", href: refetchHref },
    },
    recovery: { strategy: "refetch", reason: "tail-gap", href: refetchHref },
    compatibility: { responseShape: "transcript_window", messagesField: "messages" },
  };
}

function finiteNumberOrDefault(value: number | null | undefined, defaultValue: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : defaultValue;
}

function finiteNumberOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonEmptyStringOrNull(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

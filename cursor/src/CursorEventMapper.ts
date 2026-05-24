import type { InteractionUpdate, SDKMessage } from "@cursor/sdk";
import type { AgentEvent } from "../../src/core/harness/AgentHarness.js";

export function mapCursorMessage(message: SDKMessage): AgentEvent[] {
  switch (message.type) {
    case "system":
      return [{ type: "progress", message: `Cursor system event: ${message.subtype ?? "system"}`, activitySource: "stream" }];
    case "assistant":
      return message.message.content
        .filter((block) => block.type === "text")
        .map((block) => ({ type: "progress", message: block.text, activitySource: "stream" }));
    case "thinking":
      return [{ type: "progress", message: "Cursor thinking event", activitySource: "stream" }];
    case "task":
      return [{ type: "progress", message: "Cursor task event", activitySource: "stream" }];
    case "tool_call":
      return [
        {
          type: "progress",
          message: `tool ${message.name} ${message.status}`,
          activitySource: "tool",
        },
      ];
    case "status":
      if (message.status === "ERROR") return [{ type: "failed", error: message.message ?? "Cursor run failed" }];
      if (message.status === "CANCELLED" || message.status === "EXPIRED") return [{ type: "cancelled" }];
      return message.message ? [{ type: "progress", message: message.message, activitySource: "stream" }] : [];
    case "request":
      return [{ type: "failed", error: "Cursor requested external input" }];
    case "user":
      return [];
  }
}

export function mapCursorDelta(update: InteractionUpdate): AgentEvent[] {
  if (update.type === "turn-ended" && update.usage) {
    return [
      {
        type: "tokens",
        tokens: {
          inputTokens: update.usage.inputTokens,
          outputTokens: update.usage.outputTokens,
          totalTokens: update.usage.inputTokens + update.usage.outputTokens,
        },
      },
    ];
  }
  if (update.type === "text-delta" && update.text) {
    return [{ type: "progress", message: update.text, activitySource: "delta" }];
  }
  return [];
}

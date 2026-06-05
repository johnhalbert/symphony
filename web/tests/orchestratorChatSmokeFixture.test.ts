import { describe, expect, it } from "vitest";
import { normalizeOrchestratorChatModel } from "../src/data/orchestratorChat";
import type { ChatMessage, OrchestratorChatConversationStatus, OrchestratorChatState } from "../src/types/symphony";
// @ts-expect-error -- The smoke helper is authored as plain ESM; this focused test imports it directly to verify the browser fixture contract.
import { createOrchestratorChatProjection } from "../scripts/orchestrator-chat-smoke-fixture.mjs";

describe("createOrchestratorChatProjection", () => {
  it("preserves reducer-envelope chat state across empty, active, completed, and terminal variants", () => {
    const cases: Array<{
      label: string;
      chat: ChatMessage[];
      options?: { state?: OrchestratorChatState; conversationStatus?: OrchestratorChatConversationStatus };
      expectedState: OrchestratorChatState;
      expectedConversationStatus: OrchestratorChatConversationStatus;
      expectedLatestMessageStatus: OrchestratorChatConversationStatus | null;
      expectedTerminal: boolean;
      expectedEmpty: boolean;
    }> = [
      {
        label: "empty",
        chat: [],
        expectedState: "empty",
        expectedConversationStatus: "completed",
        expectedLatestMessageStatus: null,
        expectedTerminal: false,
        expectedEmpty: true,
      },
      {
        label: "pending",
        chat: [{ who: "agent", text: "Pending durable message", status: "pending" }],
        expectedState: "pending",
        expectedConversationStatus: "pending",
        expectedLatestMessageStatus: "pending",
        expectedTerminal: false,
        expectedEmpty: false,
      },
      {
        label: "streaming",
        chat: [{ who: "agent", text: "Streaming durable message", status: "streaming" }],
        expectedState: "streaming",
        expectedConversationStatus: "streaming",
        expectedLatestMessageStatus: "streaming",
        expectedTerminal: false,
        expectedEmpty: false,
      },
      {
        label: "completed",
        chat: [{ who: "agent", text: "Completed durable message", status: "completed" }],
        expectedState: "completed",
        expectedConversationStatus: "completed",
        expectedLatestMessageStatus: "completed",
        expectedTerminal: true,
        expectedEmpty: false,
      },
      {
        label: "failed",
        chat: [{ who: "agent", text: "Failed durable message", status: "failed" }],
        expectedState: "failed",
        expectedConversationStatus: "failed",
        expectedLatestMessageStatus: "failed",
        expectedTerminal: true,
        expectedEmpty: false,
      },
      {
        label: "disabled",
        chat: [],
        options: { state: "disabled" },
        expectedState: "disabled",
        expectedConversationStatus: "disabled",
        expectedLatestMessageStatus: null,
        expectedTerminal: true,
        expectedEmpty: true,
      },
      {
        label: "unavailable",
        chat: [],
        options: { state: "unavailable" },
        expectedState: "unavailable",
        expectedConversationStatus: "unavailable",
        expectedLatestMessageStatus: null,
        expectedTerminal: true,
        expectedEmpty: true,
      },
    ];

    for (const testCase of cases) {
      const projection = createOrchestratorChatProjection(testCase.chat, {
        conversationId: `${testCase.label}-conversation`,
        revisionPrefix: `fixture-${testCase.label}`,
        observedAt: "2026-06-05T00:00:00.000Z",
        ...testCase.options,
      });

      expect(projection).toMatchObject({
        conversation: {
          id: `${testCase.label}-conversation`,
          status: testCase.expectedConversationStatus,
          messageCount: testCase.chat.length,
        },
        state: testCase.expectedState,
        status: {
          state: testCase.expectedState,
          conversationStatus: testCase.expectedConversationStatus,
          latestMessageStatus: testCase.expectedLatestMessageStatus,
          active: testCase.expectedState === "pending" || testCase.expectedState === "streaming",
          terminal: testCase.expectedTerminal,
          empty: testCase.expectedEmpty,
          messageCount: testCase.chat.length,
        },
        compatibility: {
          responseShape: "orchestrator_chat_projection",
          sourceShape: "reducer_envelope",
        },
      });
      expect(projection.status.statusCounts[testCase.expectedConversationStatus]).toBeGreaterThanOrEqual(0);
      if (testCase.expectedLatestMessageStatus) {
        expect(projection.status.statusCounts[testCase.expectedLatestMessageStatus]).toBeGreaterThan(0);
      }

      const normalized = normalizeOrchestratorChatModel(projection, `${testCase.label}-fallback`);
      expect(normalized).toMatchObject({
        conversation: {
          id: `${testCase.label}-conversation`,
          status: testCase.expectedConversationStatus,
          messageCount: testCase.chat.length,
        },
        state: testCase.expectedState,
        status: {
          state: testCase.expectedState,
          conversationStatus: testCase.expectedConversationStatus,
          latestMessageStatus: testCase.expectedLatestMessageStatus,
          active: testCase.expectedState === "pending" || testCase.expectedState === "streaming",
          terminal: testCase.expectedTerminal,
          empty: testCase.expectedEmpty,
          messageCount: testCase.chat.length,
        },
      });
      expect(normalized.chat).toEqual(projection.chat);
    }
  });

  it("keeps failed state visible even when a later completed message exists", () => {
    const projection = createOrchestratorChatProjection([
      { who: "agent", text: "first failed attempt", status: "failed" },
      { who: "agent", text: "follow-up completion", status: "completed" },
    ]);

    expect(projection.conversation.status).toBe("completed");
    expect(projection.state).toBe("failed");
    expect(projection.status.conversationStatus).toBe("completed");
    expect(projection.status.latestMessageStatus).toBe("completed");
    expect(projection.status.statusCounts.failed).toBe(1);
    expect(projection.status.statusCounts.completed).toBe(1);

    const normalized = normalizeOrchestratorChatModel(projection);
    expect(normalized.conversation.status).toBe("completed");
    expect(normalized.state).toBe("failed");
    expect(normalized.status.state).toBe("failed");
    expect(normalized.status.conversationStatus).toBe("completed");
    expect(normalized.status.latestMessageStatus).toBe("completed");
  });
});

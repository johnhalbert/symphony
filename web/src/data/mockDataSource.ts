import { dashChat, mockSymphonyData } from "./mockData";
import {
  toDashboardModel,
  toHistoryModel,
  toIssueBoardModel,
  toIssueDetailModel,
  toReferenceData,
  toSidebarModel,
} from "./adapters";
import type { SymphonyDataSource } from "./dataSource";
import { orchestratorChatModelFromMessages } from "./orchestratorChat";
import { createTranscriptWindowResponse } from "./transcriptWindow";
import type { ChatMessage } from "../types/symphony";
import type { RawData } from "./adapters";

const rawData = mockSymphonyData as unknown as RawData;

let chatMessages: ChatMessage[] = [...(dashChat as ChatMessage[])];

function delay<T>(value: T, ms = 80): Promise<T> {
  return new Promise((resolve) => {
    globalThis.setTimeout(() => resolve(value), ms);
  });
}

function mockReply(input: string): ChatMessage {
  const trimmed = input.trim();
  const issueMatch = trimmed.match(/\bSYM-\d+\b/i)?.[0]?.toUpperCase();
  if (issueMatch) {
    return {
      who: "agent",
      text: `I found **${issueMatch}** in the mock project context. This local demo can select and inspect it now; the future API source will make that action live.`,
      suggestions: [`Open ${issueMatch}`, "Show transcript", "Acknowledge"],
    };
  }
  return {
    who: "agent",
    text: "Mock orchestrator received that. The data-source boundary is already shaped so this can become a real command response later.",
    suggestions: ["Show running agents", "Show review queue", "Acknowledge"],
  };
}

export const mockDataSource: SymphonyDataSource = {
  getReferenceData() {
    return delay(toReferenceData(rawData));
  },
  getDashboard() {
    return delay({ ...toDashboardModel(rawData), chat: chatMessages });
  },
  getIssueBoard() {
    return delay(toIssueBoardModel(rawData));
  },
  getIssueDetail(issueId) {
    return delay(toIssueDetailModel(rawData, issueId));
  },
  getHistory() {
    return delay(toHistoryModel(rawData));
  },
  async getSessions() {
    const history = await this.getHistory();
    return history.sessions;
  },
  async getTranscript(sessionId) {
    const history = await this.getHistory();
    return createTranscriptWindowResponse(history.transcriptBySession[sessionId] ?? []);
  },
  getSidebar() {
    return delay({ ...toSidebarModel(rawData), chat: chatMessages });
  },
  getOrchestratorChat() {
    return delay(orchestratorChatModelFromMessages(chatMessages));
  },
  sendOrchestratorMessage(input) {
    const trimmed = input.trim();
    if (!trimmed) return delay(chatMessages);
    chatMessages = [...chatMessages, { who: "user", text: trimmed }, mockReply(trimmed)];
    return delay(chatMessages, 120);
  },
};

import { createHash } from "node:crypto";
import { sanitizedPreviewValue, sanitizePublicJson } from "../transcript/TranscriptProjection.js";
import {
  DEFAULT_ORCHESTRATOR_CONVERSATION_ID,
  type OrchestratorConversationMessage,
  type OrchestratorConversationRecord,
  type OrchestratorConversationRole,
  type OrchestratorConversationStatus,
  type OrchestratorConversationStore,
} from "./OrchestratorConversationStore.js";
import { ProjectionTransactionService, type ProjectionWriteResult } from "./ProjectionTransactionService.js";

export const ORCHESTRATOR_CHAT_PROJECTION_SCHEMA_VERSION = 1;
export const ORCHESTRATOR_CHAT_PROJECTION_SOURCE = "orchestrator_conversations";

export type OrchestratorChatProjectionState = "empty" | OrchestratorConversationStatus;

export type OrchestratorChatProjectionStatusCounts = Record<OrchestratorConversationStatus, number>;

export interface OrchestratorChatProjectionMessage {
  id: string;
  conversationId: string;
  who: "agent" | "user";
  role: OrchestratorConversationRole;
  text: string;
  status: OrchestratorConversationStatus;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
  suggestions: string[];
}

export interface OrchestratorChatProjectionStatusSummary {
  state: OrchestratorChatProjectionState;
  conversationStatus: OrchestratorConversationStatus;
  latestMessageStatus: OrchestratorConversationStatus | null;
  active: boolean;
  terminal: boolean;
  empty: boolean;
  messageCount: number;
  statusCounts: OrchestratorChatProjectionStatusCounts;
}

export interface OrchestratorChatProjectionConversationSummary {
  id: string;
  status: OrchestratorConversationStatus;
  createdAt: string | null;
  updatedAt: string | null;
  messageCount: number;
  metadata: Record<string, unknown>;
}

export interface OrchestratorChatProjectionSourceSummary {
  source: string;
  revision: string;
  observedAt: string | null;
  conversationId: string;
  latestMessageSequence: number | null;
  latestMessageUpdatedAt: string | null;
}

export interface OrchestratorChatProjectionPayload {
  schemaVersion: typeof ORCHESTRATOR_CHAT_PROJECTION_SCHEMA_VERSION;
  conversation: OrchestratorChatProjectionConversationSummary;
  state: OrchestratorChatProjectionState;
  status: OrchestratorChatProjectionStatusSummary;
  chat: OrchestratorChatProjectionMessage[];
  source: OrchestratorChatProjectionSourceSummary;
}

export interface OrchestratorChatProjectionReducerOptions {
  /**
   * Defaults to a per-conversation revision scope so unrelated conversations do
   * not supersede each other's current projection revision.
   */
  scopeKind?: string | null;
  /** Defaults to the normalized conversation id. */
  scopeKey?: string | null;
}

export interface OrchestratorChatProjectionReductionResult {
  conversationId: string;
  scopeKind: string;
  scopeKey: string;
  payload: OrchestratorChatProjectionPayload;
  write: ProjectionWriteResult;
}

interface ConversationProjectionBasis {
  conversation: Omit<OrchestratorChatProjectionConversationSummary, "messageCount">;
  messages: readonly OrchestratorChatProjectionMessage[];
}

export class OrchestratorChatProjectionReducer {
  constructor(
    private readonly conversations: Pick<OrchestratorConversationStore, "getConversation">,
    private readonly projections: ProjectionTransactionService,
  ) {}

  async reduceConversation(
    conversationId?: string | null,
    options: OrchestratorChatProjectionReducerOptions = {},
  ): Promise<OrchestratorChatProjectionReductionResult> {
    const normalizedConversationId = normalizeConversationId(conversationId);
    const record = await this.conversations.getConversation(normalizedConversationId);
    const payload = projectOrchestratorChatProjectionPayload(record, normalizedConversationId);
    const scopeKind = normalizeProjectionScopeValue(options.scopeKind, "conversation");
    const scopeKey = normalizeProjectionScopeValue(options.scopeKey, normalizedConversationId);
    const write = await this.projections.writeProjection({
      projectionName: "orchestrator_chat_projection",
      scopeKind,
      scopeKey,
      payload,
      sourceRevisions: [
        {
          source: `${ORCHESTRATOR_CHAT_PROJECTION_SOURCE}:${normalizedConversationId}`,
          revision: payload.source.revision,
          observedAt: payload.source.observedAt,
        },
      ],
      sourceCursors: {
        conversationId: normalizedConversationId,
        conversationStatus: payload.conversation.status,
        state: payload.state,
        messageCount: payload.conversation.messageCount,
        latestMessageSequence: payload.source.latestMessageSequence,
        latestMessageUpdatedAt: payload.source.latestMessageUpdatedAt,
        sourceRevision: payload.source.revision,
      },
      fields: {
        conversationKey: normalizedConversationId,
        issueKey: firstProjectionMetadataString(payload, "issueKey", "issueIdentifier"),
        runId: firstProjectionMetadataString(payload, "runId"),
        messageCount: payload.conversation.messageCount,
      },
    });
    return { conversationId: normalizedConversationId, scopeKind, scopeKey, payload, write };
  }
}

export function projectOrchestratorChatProjectionPayload(
  record: OrchestratorConversationRecord | null,
  conversationId?: string | null,
): OrchestratorChatProjectionPayload {
  const normalizedConversationId = normalizeConversationId(record?.conversationId ?? conversationId);
  const messages = (record?.messages ?? []).map(projectOrchestratorChatProjectionMessage);
  const basis: ConversationProjectionBasis = {
    conversation: {
      id: normalizedConversationId,
      status: normalizeStatus(record?.status) ?? "completed",
      createdAt: normalizeString(record?.createdAt),
      updatedAt: normalizeString(record?.updatedAt),
      metadata: sanitizeMetadata(record?.metadata),
    },
    messages,
  };
  const sourceRevision = sha256Hex(stableJsonStringify(basis));
  const latestMessage = messages.at(-1) ?? null;
  const status = summarizeOrchestratorChatStatus(messages, basis.conversation.status);
  return {
    schemaVersion: ORCHESTRATOR_CHAT_PROJECTION_SCHEMA_VERSION,
    conversation: {
      ...basis.conversation,
      messageCount: messages.length,
    },
    state: status.state,
    status,
    chat: messages,
    source: {
      source: ORCHESTRATOR_CHAT_PROJECTION_SOURCE,
      revision: sourceRevision,
      observedAt: basis.conversation.updatedAt ?? latestMessage?.updatedAt ?? null,
      conversationId: normalizedConversationId,
      latestMessageSequence: lastConversationMessageSequence(record?.messages ?? []),
      latestMessageUpdatedAt: latestMessage?.updatedAt ?? null,
    },
  };
}

export function projectOrchestratorChatProjectionMessage(
  message: OrchestratorConversationMessage,
): OrchestratorChatProjectionMessage {
  return {
    id: message.id,
    conversationId: message.conversationId,
    who: message.role === "user" ? "user" : "agent",
    role: message.role,
    text: sanitizedPreviewValue(message.body, 10_000).preview ?? "",
    status: message.status,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    metadata: sanitizeMetadata(message.metadata),
    suggestions: [],
  };
}

export function summarizeOrchestratorChatStatus(
  messages: readonly Pick<OrchestratorChatProjectionMessage, "status">[],
  conversationStatus: OrchestratorConversationStatus,
): OrchestratorChatProjectionStatusSummary {
  const statusCounts = emptyStatusCounts();
  for (const message of messages) statusCounts[message.status] += 1;
  const latestMessageStatus = messages.at(-1)?.status ?? null;
  const noMessages = messages.length === 0;
  const state = noMessages && conversationStatus === "completed" ? "empty" : deriveProjectionState(conversationStatus, latestMessageStatus, statusCounts);
  const active = state === "pending" || state === "streaming";
  return {
    state,
    conversationStatus,
    latestMessageStatus,
    active,
    terminal: !active && state !== "empty",
    empty: noMessages,
    messageCount: messages.length,
    statusCounts,
  };
}

function deriveProjectionState(
  conversationStatus: OrchestratorConversationStatus,
  latestMessageStatus: OrchestratorConversationStatus | null,
  statusCounts: OrchestratorChatProjectionStatusCounts,
): OrchestratorConversationStatus {
  if (latestMessageStatus === "pending" || latestMessageStatus === "streaming") return latestMessageStatus;
  if (conversationStatus === "pending" || conversationStatus === "streaming") return conversationStatus;
  if (latestMessageStatus === "failed" || latestMessageStatus === "unavailable" || latestMessageStatus === "disabled") {
    return latestMessageStatus;
  }
  if (conversationStatus === "failed" || conversationStatus === "unavailable" || conversationStatus === "disabled") {
    return conversationStatus;
  }
  if (statusCounts.streaming > 0) return "streaming";
  if (statusCounts.pending > 0) return "pending";
  if (statusCounts.failed > 0) return "failed";
  if (statusCounts.unavailable > 0) return "unavailable";
  if (statusCounts.disabled > 0) return "disabled";
  return "completed";
}

function emptyStatusCounts(): OrchestratorChatProjectionStatusCounts {
  return {
    pending: 0,
    streaming: 0,
    completed: 0,
    failed: 0,
    disabled: 0,
    unavailable: 0,
  };
}

function normalizeConversationId(conversationId?: string | null): string {
  const trimmed = conversationId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_ORCHESTRATOR_CONVERSATION_ID;
}

function normalizeProjectionScopeValue(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizeStatus(value: unknown): OrchestratorConversationStatus | null {
  return value === "pending" ||
    value === "streaming" ||
    value === "completed" ||
    value === "failed" ||
    value === "disabled" ||
    value === "unavailable"
    ? value
    : null;
}

function sanitizeMetadata(value: unknown): Record<string, unknown> {
  const sanitized = sanitizePublicJson(value ?? {});
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized) ? (sanitized as Record<string, unknown>) : {};
}

function lastConversationMessageSequence(messages: readonly OrchestratorConversationMessage[]): number | null {
  return messages.reduce<number | null>((max, message) => (max === null || message.sequence > max ? message.sequence : max), null);
}

function firstProjectionMetadataString(payload: OrchestratorChatProjectionPayload, ...keys: readonly string[]): string | null {
  for (const key of keys) {
    const conversationValue = payload.conversation.metadata[key];
    if (typeof conversationValue === "string" && conversationValue.trim().length > 0) return conversationValue.trim();
    for (const message of payload.chat) {
      const messageValue = message.metadata[key];
      if (typeof messageValue === "string" && messageValue.trim().length > 0) return messageValue.trim();
    }
  }
  return null;
}

function canonicalJsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => canonicalJsonValue(item));
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const child = record[key];
      if (child !== undefined) output[key] = canonicalJsonValue(child);
    }
    return output;
  }
  return String(value);
}

function stableJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

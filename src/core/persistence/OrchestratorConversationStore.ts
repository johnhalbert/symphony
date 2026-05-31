import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  ProjectionRevisionNotifier,
  type ProjectionChangeListener,
  type ProjectionChangeUnsubscribe,
} from "./ProjectionRevision.js";
import { redactTranscriptText, sanitizePublicJson } from "../transcript/TranscriptProjection.js";

export const DEFAULT_ORCHESTRATOR_CONVERSATION_ID = "orchestrator-default";

export type OrchestratorConversationRole = "user" | "assistant" | "system" | "server";
export type OrchestratorConversationStatus =
  | "pending"
  | "streaming"
  | "completed"
  | "failed"
  | "disabled"
  | "unavailable";

export interface OrchestratorConversationTranscriptLink {
  runId: string;
  sequence?: number | null;
  eventType?: string | null;
}

export interface OrchestratorConversationMessage {
  id: string;
  conversationId: string;
  sequence: number;
  role: OrchestratorConversationRole;
  body: string;
  status: OrchestratorConversationStatus;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
  transcriptLinks: OrchestratorConversationTranscriptLink[];
}

export interface OrchestratorConversationRecord {
  conversationId: string;
  status: OrchestratorConversationStatus;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
  messages: OrchestratorConversationMessage[];
}

export interface CreateOrchestratorConversationInput {
  conversationId?: string | null;
  status?: OrchestratorConversationStatus;
  at?: string;
  metadata?: Record<string, unknown>;
}

export interface AppendOrchestratorConversationMessageInput {
  conversationId?: string | null;
  id?: string;
  role: OrchestratorConversationRole;
  body: string;
  status?: OrchestratorConversationStatus;
  at?: string;
  metadata?: Record<string, unknown>;
  transcriptLinks?: OrchestratorConversationTranscriptLink[];
}

export interface UpdateOrchestratorConversationMessageInput {
  conversationId?: string | null;
  messageId: string;
  status: OrchestratorConversationStatus;
  at?: string;
  body?: string;
  metadata?: Record<string, unknown>;
  transcriptLinks?: OrchestratorConversationTranscriptLink[];
}

export interface OrchestratorConversationStore {
  projectionRevision(): number;
  onProjectionChanged(listener: ProjectionChangeListener): ProjectionChangeUnsubscribe;
  createConversation(input?: CreateOrchestratorConversationInput): Promise<OrchestratorConversationRecord>;
  getConversation(conversationId?: string | null): Promise<OrchestratorConversationRecord | null>;
  appendMessage(input: AppendOrchestratorConversationMessageInput): Promise<OrchestratorConversationMessage>;
  updateMessage(input: UpdateOrchestratorConversationMessageInput): Promise<OrchestratorConversationMessage>;
  listMessages(conversationId?: string | null): Promise<OrchestratorConversationMessage[]>;
}

export class FileOrchestratorConversationStore implements OrchestratorConversationStore {
  private readonly updateLocks = new Map<string, Promise<unknown>>();
  private readonly projectionNotifier = new ProjectionRevisionNotifier();

  constructor(private readonly stateDir: string) {}

  projectionRevision(): number {
    return this.projectionNotifier.currentRevision();
  }

  onProjectionChanged(listener: ProjectionChangeListener): ProjectionChangeUnsubscribe {
    return this.projectionNotifier.subscribe(listener);
  }

  async createConversation(input: CreateOrchestratorConversationInput = {}): Promise<OrchestratorConversationRecord> {
    const conversationId = normalizeConversationId(input.conversationId);
    return this.withConversationLock(this.conversationPath(conversationId), async () => {
      const existing = await this.readConversation(conversationId);
      const now = input.at ?? new Date().toISOString();
      const record: OrchestratorConversationRecord = existing
        ? {
            ...existing,
            status: input.status ?? existing.status,
            updatedAt: now,
            metadata: mergeMetadata(existing.metadata, input.metadata),
          }
        : {
            conversationId,
            status: input.status ?? "completed",
            createdAt: now,
            updatedAt: now,
            metadata: sanitizeMetadata(input.metadata),
            messages: [],
          };
      await this.writeConversation(record);
      this.notifyProjectionChanged();
      return record;
    });
  }

  async getConversation(conversationId?: string | null): Promise<OrchestratorConversationRecord | null> {
    return this.readConversation(normalizeConversationId(conversationId));
  }

  async appendMessage(input: AppendOrchestratorConversationMessageInput): Promise<OrchestratorConversationMessage> {
    const conversationId = normalizeConversationId(input.conversationId);
    return this.withConversationLock(this.conversationPath(conversationId), async () => {
      const now = input.at ?? new Date().toISOString();
      const existing = await this.readConversation(conversationId);
      const record = existing ?? {
        conversationId,
        status: "completed" satisfies OrchestratorConversationStatus,
        createdAt: now,
        updatedAt: now,
        metadata: {},
        messages: [],
      };
      if (input.id) {
        const existingMessage = record.messages.find((message) => message.id === input.id);
        if (existingMessage) return existingMessage;
      }
      const message: OrchestratorConversationMessage = {
        id: input.id ?? createMessageId(),
        conversationId,
        sequence: nextMessageSequence(record.messages),
        role: input.role,
        body: redactConversationBody(input.body),
        status: input.status ?? "completed",
        createdAt: now,
        updatedAt: now,
        metadata: sanitizeMetadata(input.metadata),
        transcriptLinks: sanitizeTranscriptLinks(input.transcriptLinks),
      };
      const nextRecord: OrchestratorConversationRecord = {
        ...record,
        status: conversationStatusAfterMessage(record.status, message.status),
        updatedAt: now,
        messages: [...record.messages, message],
      };
      await this.writeConversation(nextRecord);
      this.notifyProjectionChanged();
      return message;
    });
  }

  async updateMessage(input: UpdateOrchestratorConversationMessageInput): Promise<OrchestratorConversationMessage> {
    const conversationId = normalizeConversationId(input.conversationId);
    return this.withConversationLock(this.conversationPath(conversationId), async () => {
      const existing = await this.readConversation(conversationId);
      if (!existing) throw new Error(`Orchestrator conversation not found: ${conversationId}`);
      const messageIndex = existing.messages.findIndex((message) => message.id === input.messageId);
      if (messageIndex < 0) {
        throw new Error(`Orchestrator conversation message not found: ${conversationId}/${input.messageId}`);
      }
      const now = input.at ?? new Date().toISOString();
      const previous = existing.messages[messageIndex];
      if (!previous) {
        throw new Error(`Orchestrator conversation message not found: ${conversationId}/${input.messageId}`);
      }
      const updated: OrchestratorConversationMessage = {
        ...previous,
        status: input.status,
        updatedAt: now,
        ...(input.body === undefined ? {} : { body: redactConversationBody(input.body) }),
        metadata: mergeMetadata(previous.metadata, input.metadata),
        ...(input.transcriptLinks === undefined ? {} : { transcriptLinks: sanitizeTranscriptLinks(input.transcriptLinks) }),
      };
      const messages = [...existing.messages];
      messages[messageIndex] = updated;
      const nextRecord: OrchestratorConversationRecord = {
        ...existing,
        status: conversationStatusFromMessages(messages, existing.status),
        updatedAt: now,
        messages,
      };
      await this.writeConversation(nextRecord);
      this.notifyProjectionChanged();
      return updated;
    });
  }

  async listMessages(conversationId?: string | null): Promise<OrchestratorConversationMessage[]> {
    const conversation = await this.getConversation(conversationId);
    return conversation?.messages ?? [];
  }

  private async withConversationLock<T>(lockKey: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.updateLocks.get(lockKey) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.updateLocks.set(lockKey, next);
    try {
      return await next;
    } finally {
      if (this.updateLocks.get(lockKey) === next) this.updateLocks.delete(lockKey);
    }
  }

  private conversationPath(conversationId: string): string {
    return path.join(this.stateDir, "orchestrator-conversations", conversationFileName(conversationId));
  }

  private async readConversation(conversationId: string): Promise<OrchestratorConversationRecord | null> {
    const filePath = this.conversationPath(conversationId);
    const record = await readJsonIfExists<OrchestratorConversationRecord>(filePath);
    return record ? normalizeConversationRecordForConversation(record, conversationId, filePath) : null;
  }

  private async writeConversation(record: OrchestratorConversationRecord): Promise<void> {
    const conversationId = normalizeConversationId(record.conversationId);
    const filePath = this.conversationPath(conversationId);
    await writeJson(filePath, normalizeConversationRecordForConversation(record, conversationId, filePath));
  }

  private notifyProjectionChanged(): void {
    this.projectionNotifier.notify("orchestrator_conversations");
  }
}

function normalizeConversationId(conversationId?: string | null): string {
  const trimmed = conversationId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_ORCHESTRATOR_CONVERSATION_ID;
}

function nextMessageSequence(messages: readonly OrchestratorConversationMessage[]): number {
  return messages.reduce((max, message) => Math.max(max, message.sequence), 0) + 1;
}

function conversationStatusAfterMessage(
  current: OrchestratorConversationStatus,
  next: OrchestratorConversationStatus,
): OrchestratorConversationStatus {
  if (next === "pending" || next === "streaming" || next === "failed" || next === "unavailable") return next;
  if (current === "pending" || current === "streaming") return current;
  return next;
}

function conversationStatusFromMessages(
  messages: readonly OrchestratorConversationMessage[],
  fallback: OrchestratorConversationStatus,
): OrchestratorConversationStatus {
  const latestActive = [...messages]
    .reverse()
    .find((message) => message.status === "pending" || message.status === "streaming" || message.status === "failed" || message.status === "unavailable");
  return latestActive?.status ?? messages.at(-1)?.status ?? fallback;
}

function createMessageId(): string {
  return `ocm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function mergeMetadata(
  existing: Record<string, unknown> | undefined,
  patch: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return sanitizeMetadata({ ...(existing ?? {}), ...(patch ?? {}) });
}

function normalizeConversationRecord(
  record: OrchestratorConversationRecord,
  fallbackConversationId: string,
): OrchestratorConversationRecord {
  const conversationId = normalizeConversationId(record.conversationId ?? fallbackConversationId);
  const createdAt = normalizeString(record.createdAt) ?? new Date(0).toISOString();
  const messages = Array.isArray(record.messages)
    ? record.messages.map((message, index) => normalizeMessage(message, conversationId, index + 1))
    : [];
  return {
    conversationId,
    status: normalizeStatus(record.status) ?? conversationStatusFromMessages(messages, "completed"),
    createdAt,
    updatedAt: normalizeString(record.updatedAt) ?? createdAt,
    metadata: sanitizeMetadata(record.metadata),
    messages,
  };
}

function normalizeConversationRecordForConversation(
  record: OrchestratorConversationRecord,
  expectedConversationId: string,
  filePath: string,
): OrchestratorConversationRecord {
  const storeFile = path.basename(filePath);
  const storedConversationId = normalizeString(record.conversationId);
  if (storedConversationId === null) {
    throw new Error(`Durable orchestrator conversation record ${storeFile} is missing a conversationId`);
  }
  if (normalizeConversationId(storedConversationId) !== expectedConversationId) {
    throw new Error(
      `Durable orchestrator conversation record ${storeFile} has conversationId ${JSON.stringify(
        storedConversationId,
      )}, expected ${JSON.stringify(expectedConversationId)}`,
    );
  }
  const normalized = normalizeConversationRecord(record, expectedConversationId);
  if (normalized.conversationId !== expectedConversationId) {
    throw new Error(
      `Durable orchestrator conversation record ${storeFile} normalized to conversationId ${JSON.stringify(
        normalized.conversationId,
      )}, expected ${JSON.stringify(expectedConversationId)}`,
    );
  }
  return normalized;
}

function normalizeMessage(
  message: OrchestratorConversationMessage,
  conversationId: string,
  fallbackSequence: number,
): OrchestratorConversationMessage {
  const createdAt = normalizeString(message.createdAt) ?? new Date(0).toISOString();
  return {
    id: normalizeString(message.id) ?? createMessageId(),
    conversationId,
    sequence: typeof message.sequence === "number" && Number.isFinite(message.sequence) ? message.sequence : fallbackSequence,
    role: normalizeRole(message.role) ?? "server",
    body: redactConversationBody(normalizeString(message.body) ?? ""),
    status: normalizeStatus(message.status) ?? "completed",
    createdAt,
    updatedAt: normalizeString(message.updatedAt) ?? createdAt,
    metadata: sanitizeMetadata(message.metadata),
    transcriptLinks: sanitizeTranscriptLinks(message.transcriptLinks),
  };
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizeRole(value: unknown): OrchestratorConversationRole | null {
  return value === "user" || value === "assistant" || value === "system" || value === "server" ? value : null;
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

function isTranscriptLink(value: unknown): value is OrchestratorConversationTranscriptLink {
  if (!isRecord(value)) return false;
  return typeof value.runId === "string" && value.runId.trim().length > 0;
}

function sanitizeTranscriptLinks(value: unknown): OrchestratorConversationTranscriptLink[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isTranscriptLink).map((link) => ({
    runId: link.runId,
    ...(typeof link.sequence === "number" && Number.isFinite(link.sequence) ? { sequence: link.sequence } : {}),
    ...(typeof link.eventType === "string" ? { eventType: link.eventType } : {}),
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeMetadata(value: unknown): Record<string, unknown> {
  const sanitized = sanitizePublicJson(value ?? {});
  return isRecord(sanitized) ? sanitized : {};
}

function redactConversationBody(value: string): string {
  return redactTranscriptText(value).text;
}

function conversationFileName(conversationId: string): string {
  // The web API accepts arbitrary non-empty conversation ids. A full SHA-256
  // content address keeps filesystem paths fixed-length and avoids lossy
  // sanitizer collisions, including case-only collisions on Windows.
  const digest = createHash("sha256").update(conversationId, "utf8").digest("hex");
  return `conversation-${digest}.json`;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (process.platform === "win32") {
    await fs.copyFile(tempPath, filePath);
    await fs.rm(tempPath, { force: true });
    return;
  }
  await fs.rename(tempPath, filePath);
}

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      const retryable = code === "EBUSY" || code === "EPERM" || error instanceof SyntaxError;
      if (!retryable || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  return null;
}

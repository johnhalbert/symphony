import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ProjectionRevisionNotifier, type ProjectionChangeListener, type ProjectionChangeUnsubscribe } from "./ProjectionRevision.js";

export const ORCHESTRATOR_CHAT_PROJECTION_SOURCE = "orchestratorChat";

export type OrchestratorChatMessageActor = "agent" | "user";

export interface OrchestratorChatMessageInput {
  who: OrchestratorChatMessageActor;
  text: string;
  suggestions?: readonly string[] | undefined;
  createdAt?: string | undefined;
}

export interface OrchestratorChatMessageRecord {
  id: string;
  who: OrchestratorChatMessageActor;
  text: string;
  suggestions?: string[];
  createdAt: string;
}

export interface OrchestratorChatSnapshot {
  version: 1;
  messages: OrchestratorChatMessageRecord[];
  updatedAt: string | null;
}

export interface OrchestratorChatStore {
  listMessages(): Promise<OrchestratorChatMessageRecord[]>;
  appendMessages(messages: readonly OrchestratorChatMessageInput[]): Promise<OrchestratorChatMessageRecord[]>;
  projectionRevision(): number;
  onProjectionChanged(listener: ProjectionChangeListener): ProjectionChangeUnsubscribe;
}

export class InMemoryOrchestratorChatStore implements OrchestratorChatStore {
  private readonly projectionNotifier = new ProjectionRevisionNotifier();
  private messages: OrchestratorChatMessageRecord[] = [];

  projectionRevision(): number {
    return this.projectionNotifier.currentRevision();
  }

  onProjectionChanged(listener: ProjectionChangeListener): ProjectionChangeUnsubscribe {
    return this.projectionNotifier.subscribe(listener);
  }

  async listMessages(): Promise<OrchestratorChatMessageRecord[]> {
    return cloneMessages(this.messages);
  }

  async appendMessages(messages: readonly OrchestratorChatMessageInput[]): Promise<OrchestratorChatMessageRecord[]> {
    const normalized = normalizeMessageInputs(messages);
    if (normalized.length === 0) return [];
    this.messages = [...this.messages, ...normalized];
    this.notifyProjectionChanged();
    return cloneMessages(normalized);
  }

  private notifyProjectionChanged(): void {
    this.projectionNotifier.notify(ORCHESTRATOR_CHAT_PROJECTION_SOURCE);
  }
}

export class FileOrchestratorChatStore implements OrchestratorChatStore {
  private readonly projectionNotifier = new ProjectionRevisionNotifier();
  private readonly filePath: string;
  private writeLock: Promise<void> = Promise.resolve();

  constructor(private readonly stateDir: string) {
    this.filePath = path.join(stateDir, "orchestrator-chat", "conversation.json");
  }

  projectionRevision(): number {
    return this.projectionNotifier.currentRevision();
  }

  onProjectionChanged(listener: ProjectionChangeListener): ProjectionChangeUnsubscribe {
    return this.projectionNotifier.subscribe(listener);
  }

  async listMessages(): Promise<OrchestratorChatMessageRecord[]> {
    return cloneMessages((await this.readSnapshot()).messages);
  }

  async appendMessages(messages: readonly OrchestratorChatMessageInput[]): Promise<OrchestratorChatMessageRecord[]> {
    const normalized = normalizeMessageInputs(messages);
    if (normalized.length === 0) return [];
    await this.withWriteLock(async () => {
      const snapshot = await this.readSnapshot();
      const updatedAt = normalized[normalized.length - 1]?.createdAt ?? new Date().toISOString();
      await writeJson(this.filePath, {
        version: 1,
        messages: [...snapshot.messages, ...normalized],
        updatedAt,
      } satisfies OrchestratorChatSnapshot);
    });
    this.notifyProjectionChanged();
    return cloneMessages(normalized);
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeLock;
    let release: () => void = () => undefined;
    this.writeLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async readSnapshot(): Promise<OrchestratorChatSnapshot> {
    const value = await readJsonIfExists<unknown>(this.filePath);
    if (!isSnapshot(value)) return emptySnapshot();
    return {
      version: 1,
      messages: value.messages.map(cloneMessage),
      updatedAt: value.updatedAt,
    };
  }

  private notifyProjectionChanged(): void {
    this.projectionNotifier.notify(ORCHESTRATOR_CHAT_PROJECTION_SOURCE);
  }
}

function normalizeMessageInputs(messages: readonly OrchestratorChatMessageInput[]): OrchestratorChatMessageRecord[] {
  return messages
    .map((message) => {
      const text = typeof message.text === "string" ? message.text.trim() : "";
      if (text.length === 0) return null;
      const createdAt = isIsoLikeTimestamp(message.createdAt) ? message.createdAt : new Date().toISOString();
      const record: OrchestratorChatMessageRecord = {
        id: randomUUID(),
        who: message.who === "user" ? "user" : "agent",
        text,
        createdAt,
      };
      const suggestions = normalizeSuggestions(message.suggestions);
      if (suggestions.length > 0) record.suggestions = suggestions;
      return record;
    })
    .filter((message): message is OrchestratorChatMessageRecord => message !== null);
}

function normalizeSuggestions(suggestions: readonly string[] | undefined): string[] {
  return (suggestions ?? [])
    .map((suggestion) => suggestion.trim())
    .filter((suggestion, index, all) => suggestion.length > 0 && all.indexOf(suggestion) === index)
    .slice(0, 5);
}

function cloneMessages(messages: readonly OrchestratorChatMessageRecord[]): OrchestratorChatMessageRecord[] {
  return messages.map(cloneMessage);
}

function cloneMessage(message: OrchestratorChatMessageRecord): OrchestratorChatMessageRecord {
  return {
    id: message.id,
    who: message.who,
    text: message.text,
    ...(message.suggestions === undefined ? {} : { suggestions: [...message.suggestions] }),
    createdAt: message.createdAt,
  };
}

function emptySnapshot(): OrchestratorChatSnapshot {
  return { version: 1, messages: [], updatedAt: null };
}

function isSnapshot(value: unknown): value is OrchestratorChatSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<OrchestratorChatSnapshot>;
  return record.version === 1 && Array.isArray(record.messages) && record.messages.every(isMessageRecord);
}

function isMessageRecord(value: unknown): value is OrchestratorChatMessageRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<OrchestratorChatMessageRecord>;
  return (
    typeof record.id === "string" &&
    (record.who === "agent" || record.who === "user") &&
    typeof record.text === "string" &&
    typeof record.createdAt === "string" &&
    (record.suggestions === undefined || (Array.isArray(record.suggestions) && record.suggestions.every((item) => typeof item === "string")))
  );
}

function isIsoLikeTimestamp(value: string | undefined): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text) as T;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (process.platform === "win32") {
    await fs.rm(filePath, { force: true });
  }
  await fs.rename(tempPath, filePath);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

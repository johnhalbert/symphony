import type { SymphonyDataSource } from "./dataSource";
import type { ChatMessage, ReferenceData } from "../types/symphony";

interface ApiReferenceEntry {
  name?: string | null;
  color?: string | null;
}

interface ApiReferenceData {
  users?: Record<string, ApiReferenceEntry | null> | null;
  labels?: Record<string, ApiReferenceEntry | null> | null;
}

async function fetchJson<T>(baseUrl: string, path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new Error(`Symphony API returned HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

function normalizeReferenceRecord(record: Record<string, ApiReferenceEntry | null> | null | undefined) {
  return Object.fromEntries(
    Object.entries(record ?? {}).map(([key, entry]) => [
      key,
      {
        name: entry?.name?.trim() || key,
        color: entry?.color ?? null,
      },
    ]),
  );
}

export function normalizeReferenceData(input: ApiReferenceData): ReferenceData {
  return {
    users: normalizeReferenceRecord(input.users),
    labels: normalizeReferenceRecord(input.labels),
  };
}

export function createApiDataSource(baseUrl: string): SymphonyDataSource {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");

  return {
    async getReferenceData() {
      return normalizeReferenceData(await fetchJson<ApiReferenceData>(normalizedBaseUrl, "/api/v1/web/reference-data"));
    },
    async getDashboard() {
      return fetchJson(normalizedBaseUrl, "/api/v1/web/dashboard");
    },
    async getIssueBoard() {
      return fetchJson(normalizedBaseUrl, "/api/v1/web/issues");
    },
    async getIssueDetail(issueId) {
      return fetchJson(normalizedBaseUrl, `/api/v1/web/issues/${encodeURIComponent(issueId)}`);
    },
    async getHistory() {
      return fetchJson(normalizedBaseUrl, "/api/v1/web/history");
    },
    async getSessions() {
      const history = await this.getHistory();
      return history.sessions;
    },
    async getTranscript(sessionId) {
      return fetchJson(normalizedBaseUrl, `/api/v1/web/sessions/${encodeURIComponent(sessionId)}/transcript`);
    },
    async getSidebar() {
      return fetchJson(normalizedBaseUrl, "/api/v1/web/sidebar");
    },
    async getOrchestratorChat() {
      return fetchJson<ChatMessage[]>(normalizedBaseUrl, "/api/v1/web/orchestrator-chat");
    },
    async sendOrchestratorMessage(input) {
      const response = await fetch(`${normalizedBaseUrl}/api/v1/web/orchestrator-chat`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ input }),
      });
      if (!response.ok) throw new Error(`Symphony API returned HTTP ${response.status}`);
      return response.json() as Promise<ChatMessage[]>;
    },
  };
}

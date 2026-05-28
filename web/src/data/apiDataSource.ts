import type { SymphonyDataSource } from "./dataSource";

async function fetchJson<T>(baseUrl: string, path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new Error(`Symphony API returned HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

export function createApiDataSource(baseUrl: string): SymphonyDataSource {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");

  return {
    async getReferenceData() {
      return fetchJson(normalizedBaseUrl, "/api/v1/web/reference-data");
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
      return fetchJson(normalizedBaseUrl, "/api/v1/web/orchestrator-chat");
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
      return response.json();
    },
  };
}

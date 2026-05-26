import {
  classifyNetworkError,
  classifyProbeResult,
  errorMessage,
  SYMPHONY_PROBE_TIMEOUT_MS,
  type ConnectionState,
  type ProbeResult,
} from "./connectionState";
import { normalizeBaseUrl } from "./settings";
import type { ActivityFeedResponse, BoardIssueDetailResponse, IssueBoardResponse, TranscriptPage } from "./statusApiTypes";

export const MUTATION_TOKEN_HEADER = "X-Symphony-Token";

export class SymphonyClient {
  async probeState(baseUrlSetting: string, token: string, signal?: AbortSignal): Promise<ConnectionState> {
    const tokenConfigured = token.trim().length > 0;
    const result = await this.fetchState(baseUrlSetting, signal);
    return classifyProbeResult(result, tokenConfigured);
  }

  async fetchBoard(baseUrlSetting: string, options: { refresh?: boolean; signal?: AbortSignal | undefined } = {}): Promise<IssueBoardResponse> {
    return this.fetchJson(baseUrlSetting, `/api/v1/board${options.refresh ? "?refresh=1" : ""}`, { signal: options.signal });
  }

  async fetchBoardIssue(
    baseUrlSetting: string,
    issueKey: string,
    options: { refresh?: boolean; signal?: AbortSignal | undefined } = {},
  ): Promise<BoardIssueDetailResponse> {
    const query = options.refresh ? "?refresh=1" : "";
    return this.fetchJson(baseUrlSetting, `/api/v1/board/issues/${encodeURIComponent(issueKey)}${query}`, { signal: options.signal });
  }

  async fetchActivity(
    baseUrlSetting: string,
    options: { issue?: string; offset?: number; limit?: number; signal?: AbortSignal | undefined } = {},
  ): Promise<ActivityFeedResponse> {
    const params = new URLSearchParams();
    if (options.issue) params.set("issue", options.issue);
    if (options.offset !== undefined) params.set("offset", String(options.offset));
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const queryString = params.toString();
    const query = queryString ? `?${queryString}` : "";
    return this.fetchJson(baseUrlSetting, `/api/v1/activity${query}`, { signal: options.signal });
  }

  async fetchRun(baseUrlSetting: string, runId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.fetchJson(baseUrlSetting, `/api/v1/runs/${encodeURIComponent(runId)}`, { signal });
  }

  async fetchTranscript(
    baseUrlSetting: string,
    runId: string,
    options: { offset?: number; limit?: number; signal?: AbortSignal | undefined } = {},
  ): Promise<TranscriptPage> {
    const params = new URLSearchParams();
    if (options.offset !== undefined) params.set("offset", String(options.offset));
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const queryString = params.toString();
    const query = queryString ? `?${queryString}` : "";
    return this.fetchJson(baseUrlSetting, `/api/v1/runs/${encodeURIComponent(runId)}/transcript${query}`, { signal: options.signal });
  }

  async openWorkspace(baseUrlSetting: string, issueKey: string, token: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.fetchJson(baseUrlSetting, `/api/v1/issues/${encodeURIComponent(issueKey)}/open-workspace`, {
      method: "POST",
      token,
      signal,
    });
  }

  buildMutationHeaders(token: string): Record<string, string> {
    const trimmed = token.trim();
    return trimmed ? { [MUTATION_TOKEN_HEADER]: trimmed } : {};
  }

  private async fetchState(baseUrlSetting: string, signal?: AbortSignal): Promise<ProbeResult> {
    let baseUrl: string;
    try {
      baseUrl = normalizeBaseUrl(baseUrlSetting);
    } catch (error) {
      return { kind: "invalid_url", baseUrl: baseUrlSetting, detail: errorMessage(error) };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SYMPHONY_PROBE_TIMEOUT_MS);
    const abortFromCaller = () => controller.abort();
    signal?.addEventListener("abort", abortFromCaller, { once: true });

    try {
      const response = await fetch(`${baseUrl}/api/v1/state`, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      const text = await response.text();
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : null;
      } catch (error) {
        return { kind: "parse_failure", baseUrl, detail: errorMessage(error) };
      }
      return { kind: "http", baseUrl, status: response.status, body };
    } catch (error) {
      const reason = classifyNetworkError(error);
      return { kind: "network", baseUrl, reason, detail: errorMessage(error) };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  private async fetchJson<T>(
    baseUrlSetting: string,
    path: string,
    options: { method?: "GET" | "POST"; token?: string; signal?: AbortSignal | undefined } = {},
  ): Promise<T> {
    const baseUrl = normalizeBaseUrl(baseUrlSetting);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SYMPHONY_PROBE_TIMEOUT_MS);
    const abortFromCaller = () => controller.abort();
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });

    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: options.method ?? "GET",
        headers: {
          Accept: "application/json",
          ...(options.method === "POST" ? { "Content-Type": "application/json" } : {}),
          ...(options.method === "POST" ? this.buildMutationHeaders(options.token ?? "") : {}),
        },
        signal: controller.signal,
      });
      const text = await response.text();
      const body = parseJsonResponse(text);
      if (!response.ok) {
        throw new Error(`Symphony returned HTTP ${response.status}${errorDetail(body)}`);
      }
      return body as T;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abortFromCaller);
    }
  }
}

function parseJsonResponse(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Failed to parse Symphony response: ${errorMessage(error)}`);
  }
}

function errorDetail(body: unknown): string {
  if (typeof body !== "object" || body === null || !("error" in body)) return ".";
  const error = (body as { error?: unknown }).error;
  if (typeof error === "string" && error.trim()) return `: ${error}`;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return `: ${message}`;
  }
  return ".";
}

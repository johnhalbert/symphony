import {
  classifyNetworkError,
  classifyProbeResult,
  errorMessage,
  isAbortLikeError,
  SYMPHONY_PROBE_TIMEOUT_MS,
  type ConnectionState,
  type ProbeResult,
} from "./connectionState";
import {
  parseActiveSessions,
  parseActivitySection,
  parseBoardSection,
  parseOperatorQueues,
  parseWorkspaceSection,
  type JsonEndpointResult,
} from "./dashboardParsers";
import type { DashboardViewState } from "./dashboardTypes";
import { normalizeBaseUrl } from "./settings";

export const MUTATION_TOKEN_HEADER = "X-Symphony-Token";

export class SymphonyClient {
  async fetchDashboard(
    baseUrlSetting: string,
    token: string,
    signal?: AbortSignal,
    options: { refreshBoard?: boolean } = {},
  ): Promise<DashboardViewState> {
    const tokenConfigured = token.trim().length > 0;
    const stateResult = await this.fetchState(baseUrlSetting, signal);
    const connection = classifyProbeResult(stateResult, tokenConfigured);
    if (connection.kind !== "connected" || stateResult.kind !== "http") return { connection, sections: null };

    const boardPath = options.refreshBoard ? "/api/v1/board?refresh=1" : "/api/v1/board";
    const [board, activity, workspaces] = await Promise.all([
      this.fetchJsonEndpoint(connection.baseUrl, boardPath, signal),
      this.fetchJsonEndpoint(connection.baseUrl, "/api/v1/activity?offset=0&limit=20", signal),
      this.fetchJsonEndpoint(connection.baseUrl, "/api/v1/workspaces", signal),
    ]);

    return {
      connection,
      sections: {
        activeSessions: parseActiveSessions(stateResult.body),
        operatorQueues: parseOperatorQueues(stateResult.body),
        board: parseBoardSection(board),
        workspaces: parseWorkspaceSection(workspaces),
        activity: parseActivitySection(activity),
      },
    };
  }

  async probeState(baseUrlSetting: string, token: string, signal?: AbortSignal): Promise<ConnectionState> {
    const tokenConfigured = token.trim().length > 0;
    const result = await this.fetchState(baseUrlSetting, signal);
    return classifyProbeResult(result, tokenConfigured);
  }

  buildMutationHeaders(token: string): Record<string, string> {
    const trimmed = token.trim();
    return trimmed ? { [MUTATION_TOKEN_HEADER]: trimmed } : {};
  }

  async openWorkspace(baseUrlSetting: string, token: string, issueKey: string, signal?: AbortSignal): Promise<void> {
    const baseUrl = normalizeBaseUrl(baseUrlSetting);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SYMPHONY_PROBE_TIMEOUT_MS);
    const abortFromCaller = () => controller.abort();
    signal?.addEventListener("abort", abortFromCaller, { once: true });

    try {
      const response = await fetch(`${baseUrl}/api/v1/issues/${encodeURIComponent(issueKey)}/open-workspace`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          ...this.buildMutationHeaders(token),
        },
        signal: controller.signal,
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Symphony returned HTTP ${response.status} for open-workspace.`);
      }
    } catch (error) {
      throw new Error(isAbortLikeError(error) ? "Open workspace request timed out." : errorMessage(error));
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromCaller);
    }
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

  private async fetchJsonEndpoint(baseUrl: string, path: string, signal?: AbortSignal): Promise<JsonEndpointResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SYMPHONY_PROBE_TIMEOUT_MS);
    const abortFromCaller = () => controller.abort();
    signal?.addEventListener("abort", abortFromCaller, { once: true });

    try {
      const response = await fetch(`${baseUrl}${path}`, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      const text = await response.text();
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : null;
      } catch (error) {
        return { kind: "parse_failure", status: response.status, detail: errorMessage(error) };
      }
      return { kind: "http", status: response.status, body };
    } catch (error) {
      return { kind: "network", detail: isAbortLikeError(error) ? "Request timed out." : errorMessage(error) };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }
}

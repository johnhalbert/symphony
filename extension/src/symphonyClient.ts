import {
  classifyNetworkError,
  classifyProbeResult,
  errorMessage,
  SYMPHONY_PROBE_TIMEOUT_MS,
  type ConnectionState,
  type ProbeResult,
} from "./connectionState";
import { normalizeBaseUrl } from "./settings";

export const MUTATION_TOKEN_HEADER = "X-Symphony-Token";

export class SymphonyClient {
  async probeState(baseUrlSetting: string, token: string, signal?: AbortSignal): Promise<ConnectionState> {
    const tokenConfigured = token.trim().length > 0;
    const result = await this.fetchState(baseUrlSetting, signal);
    return classifyProbeResult(result, tokenConfigured);
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
}

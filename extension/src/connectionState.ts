export const SYMPHONY_PROBE_TIMEOUT_MS = 5_000;

export type ConnectionKind = "connected" | "offline" | "error";

export interface StateSummary {
  runningCount: number | null;
  retryingCount: number | null;
  tokenConfigured: boolean;
  mutationsRequireToken: boolean | null;
}

export type ConnectionState =
  | {
      kind: "connected";
      baseUrl: string;
      generatedAt: string;
      summary: StateSummary;
    }
  | {
      kind: "offline";
      baseUrl: string;
      reason: "timeout" | "dns" | "refused" | "network";
      detail: string;
    }
  | {
      kind: "error";
      baseUrl: string;
      reason: "invalid_url" | "http_status" | "parse_failure" | "malformed_body";
      detail: string;
    };

export type ProbeResult =
  | { kind: "http"; baseUrl: string; status: number; body: unknown }
  | { kind: "invalid_url"; baseUrl: string; detail: string }
  | { kind: "parse_failure"; baseUrl: string; detail: string }
  | { kind: "network"; baseUrl: string; reason: "timeout" | "dns" | "refused" | "network"; detail: string };

export function classifyProbeResult(result: ProbeResult, tokenConfigured: boolean): ConnectionState {
  if (result.kind === "invalid_url") {
    return { kind: "error", baseUrl: result.baseUrl, reason: "invalid_url", detail: result.detail };
  }
  if (result.kind === "parse_failure") {
    return { kind: "error", baseUrl: result.baseUrl, reason: "parse_failure", detail: result.detail };
  }
  if (result.kind === "network") {
    return { kind: "offline", baseUrl: result.baseUrl, reason: result.reason, detail: result.detail };
  }
  if (result.status !== 200) {
    return {
      kind: "error",
      baseUrl: result.baseUrl,
      reason: "http_status",
      detail: `Symphony returned HTTP ${result.status}.`,
    };
  }
  if (!isRecord(result.body) || typeof result.body.generatedAt !== "string" || result.body.generatedAt.trim() === "") {
    return {
      kind: "error",
      baseUrl: result.baseUrl,
      reason: "malformed_body",
      detail: "Response was not a Symphony state snapshot with a generatedAt timestamp.",
    };
  }

  return {
    kind: "connected",
    baseUrl: result.baseUrl,
    generatedAt: result.body.generatedAt,
    summary: {
      runningCount: runningCount(result.body),
      retryingCount: retryingCount(result.body),
      tokenConfigured,
      mutationsRequireToken: mutationsRequireToken(result.body),
    },
  };
}

export function isAbortLikeError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === "AbortError"
  ) || (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

export function classifyNetworkError(error: unknown): "timeout" | "dns" | "refused" | "network" {
  if (isAbortLikeError(error)) return "timeout";
  const text = errorMessage(error).toLowerCase();
  if (text.includes("enotfound") || text.includes("eai_again")) return "dns";
  if (text.includes("econnrefused") || text.includes("econnreset")) return "refused";
  return "network";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runningCount(body: Record<string, unknown>): number | null {
  return operatorMetricCount(body, "running");
}

function retryingCount(body: Record<string, unknown>): number | null {
  return operatorMetricCount(body, "retrying");
}

function operatorMetricCount(body: Record<string, unknown>, metric: "running" | "retrying"): number | null {
  const counts = body.counts;
  if (isRecord(counts)) {
    const value = counts[metric];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  const operatorView = body.operatorView;
  if (!isRecord(operatorView)) return null;
  const rows = operatorView[metric];
  return Array.isArray(rows) ? rows.length : null;
}

function mutationsRequireToken(body: Record<string, unknown>): boolean | null {
  const operatorView = body.operatorView;
  if (!isRecord(operatorView)) return null;
  const controls = operatorView.controls;
  if (isRecord(controls) && typeof controls.mutationsRequireToken === "boolean") return controls.mutationsRequireToken;
  const mutationsRequireToken = operatorView.mutationsRequireToken;
  return typeof mutationsRequireToken === "boolean" ? mutationsRequireToken : null;
}

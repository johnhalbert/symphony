import type { ProjectContextResolution } from "../config/ProjectContexts.js";
import type { AgentRunPhase, AgentRunRole } from "../types.js";

export type ProviderLimitKind =
  | "transient_rate_limit"
  | "windowed_bucket_exhausted"
  | "credits_exhausted"
  | "subscription_required"
  | "unknown_limit";

export type ProviderLimitResumePolicy = "auto_at_window_close" | "manual";

export type ProviderLimitWindowKind =
  | "codex_5h"
  | "codex_weekly"
  | "daily"
  | "monthly"
  | "retry_after"
  | "unknown";

export interface ProviderLimitScope {
  harnessId: string;
  providerId?: string | null;
  model?: string | null;
  accountScopeKey?: string | null;
}

export interface ProviderLimitWindow {
  resumeAt?: string | null;
  retryAfterMs?: number | null;
  windowLabel?: string | null;
  windowKind?: ProviderLimitWindowKind | string | null;
}

export interface ProviderLimitSource {
  issueId?: string | null;
  issueIdentifier?: string | null;
  runId?: string | null;
  sessionId?: string | null;
  role?: AgentRunRole | null;
  runPhase?: AgentRunPhase | null;
  projectContext?: ProjectContextResolution | null;
}

export interface ProviderLimitSignal {
  scope: ProviderLimitScope;
  kind: ProviderLimitKind;
  window?: ProviderLimitWindow | null;
  resumePolicy?: ProviderLimitResumePolicy;
  message: string;
  observedAt?: string;
  source?: ProviderLimitSource | null;
  raw?: unknown;
}

export interface RuntimeProviderGate {
  id: string;
  scope: ProviderLimitScope;
  kind: ProviderLimitKind;
  window: ProviderLimitWindow | null;
  resumePolicy: ProviderLimitResumePolicy;
  message: string;
  observedAt: string;
  createdAt: string;
  updatedAt: string;
  affectedRoles: AgentRunRole[];
  affectedRunPhases: AgentRunPhase[];
  source: ProviderLimitSource | null;
  raw?: unknown;
}

export function normalizeProviderLimitSignal(
  signal: ProviderLimitSignal,
  defaults: Partial<ProviderLimitScope> = {},
  now = new Date(),
): ProviderLimitSignal {
  const observedAt = validIsoString(signal.observedAt) ?? now.toISOString();
  const window = normalizeProviderLimitWindow(signal.window ?? null, observedAt);
  return {
    ...signal,
    scope: {
      harnessId: nonEmptyString(signal.scope.harnessId) ?? nonEmptyString(defaults.harnessId) ?? "unknown",
      providerId: nonEmptyString(signal.scope.providerId) ?? nonEmptyString(defaults.providerId) ?? null,
      model: nonEmptyString(signal.scope.model) ?? nonEmptyString(defaults.model) ?? null,
      accountScopeKey: nonEmptyString(signal.scope.accountScopeKey) ?? nonEmptyString(defaults.accountScopeKey) ?? null,
    },
    window,
    resumePolicy: signal.resumePolicy ?? (window?.resumeAt ? "auto_at_window_close" : "manual"),
    observedAt,
    source: signal.source ?? null,
  };
}

export function providerLimitResumeAt(gateOrSignal: RuntimeProviderGate | ProviderLimitSignal): string | null {
  return gateOrSignal.window?.resumeAt ?? null;
}

export function providerLimitIsReadyToExpire(gate: RuntimeProviderGate, now = new Date()): boolean {
  if (gate.resumePolicy !== "auto_at_window_close") return false;
  const resumeAt = providerLimitResumeAt(gate);
  if (!resumeAt) return false;
  const resumeAtMs = Date.parse(resumeAt);
  return Number.isFinite(resumeAtMs) && resumeAtMs <= now.getTime();
}

export function providerLimitDelayMs(gate: RuntimeProviderGate, now = new Date()): number | null {
  const resumeAt = providerLimitResumeAt(gate);
  if (!resumeAt) return null;
  const resumeAtMs = Date.parse(resumeAt);
  if (!Number.isFinite(resumeAtMs)) return null;
  return Math.max(resumeAtMs - now.getTime(), 0);
}

function normalizeProviderLimitWindow(window: ProviderLimitWindow | null, observedAt: string): ProviderLimitWindow | null {
  if (!window) return null;
  const retryAfterMs =
    typeof window.retryAfterMs === "number" && Number.isFinite(window.retryAfterMs) && window.retryAfterMs >= 0
      ? window.retryAfterMs
      : null;
  const explicitResumeAt = validIsoString(window.resumeAt);
  const resumeAt =
    explicitResumeAt ??
    (retryAfterMs === null
      ? null
      : new Date(Date.parse(observedAt) + retryAfterMs).toISOString());
  return {
    resumeAt,
    retryAfterMs,
    windowLabel: nonEmptyString(window.windowLabel) ?? null,
    windowKind: nonEmptyString(window.windowKind) ?? null,
  };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function validIsoString(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { sanitizePublicJson } from "../transcript/TranscriptProjection.js";
import {
  normalizeProviderLimitSignal,
  providerLimitIsReadyToExpire,
  type ProviderLimitSignal,
  type RuntimeProviderGate,
} from "../provider/ProviderLimits.js";
import { mapWithFileReadConcurrency } from "./FileReadConcurrency.js";

export interface ProviderGateStore {
  upsert(signal: ProviderLimitSignal): Promise<RuntimeProviderGate>;
  listActive(now?: Date): Promise<RuntimeProviderGate[]>;
  expireReady(now?: Date): Promise<RuntimeProviderGate[]>;
  clear(gateId: string): Promise<RuntimeProviderGate | null>;
}

export class FileProviderGateStore implements ProviderGateStore {
  constructor(private readonly stateDir: string) {}

  async upsert(signal: ProviderLimitSignal): Promise<RuntimeProviderGate> {
    await fs.mkdir(this.providerGatesDir(), { recursive: true });
    const normalized = normalizeProviderLimitSignal(signal);
    const now = new Date().toISOString();
    const id = providerGateId(normalized);
    const existing = await this.readGate(id);
    const gate: RuntimeProviderGate = {
      id,
      scope: normalized.scope,
      kind: normalized.kind,
      window: normalized.window ?? null,
      resumePolicy: normalized.resumePolicy ?? (normalized.window?.resumeAt ? "auto_at_window_close" : "manual"),
      message: normalized.message,
      observedAt: normalized.observedAt ?? now,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      affectedRoles: ["worker", "reviewer"],
      affectedRunPhases: ["issue_breakdown", "implementation", "merge_conflict_resolution", "review"],
      source: normalized.source ?? null,
      ...(normalized.raw === undefined ? {} : { raw: sanitizePublicJson(normalized.raw, 1_000) }),
    };
    await writeJson(this.providerGatePath(id), gate);
    return gate;
  }

  async listActive(now = new Date()): Promise<RuntimeProviderGate[]> {
    await this.expireReady(now);
    const gates = await this.readAllGates();
    return gates.sort(compareGates);
  }

  async expireReady(now = new Date()): Promise<RuntimeProviderGate[]> {
    const gates = await this.readAllGates();
    const expired = gates.filter((gate) => providerLimitIsReadyToExpire(gate, now));
    await Promise.all(expired.map((gate) => fs.rm(this.providerGatePath(gate.id), { force: true })));
    return expired;
  }

  async clear(gateId: string): Promise<RuntimeProviderGate | null> {
    const gate = await this.readGate(gateId);
    if (!gate) return null;
    await fs.rm(this.providerGatePath(gateId), { force: true });
    return gate;
  }

  private async readAllGates(): Promise<RuntimeProviderGate[]> {
    try {
      const entries = await fs.readdir(this.providerGatesDir());
      const records = await mapWithFileReadConcurrency(
        entries.filter((entry) => entry.endsWith(".json")).map((entry) => path.join(this.providerGatesDir(), entry)),
        (filePath) => readJsonIfExists<RuntimeProviderGate>(filePath),
      );
      return records.filter((record): record is RuntimeProviderGate => record !== null && typeof record.id === "string");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async readGate(gateId: string): Promise<RuntimeProviderGate | null> {
    return readJsonIfExists<RuntimeProviderGate>(this.providerGatePath(gateId));
  }

  private providerGatesDir(): string {
    return path.join(this.stateDir, "provider-gates");
  }

  private providerGatePath(gateId: string): string {
    return path.join(this.providerGatesDir(), `${safeFileName(gateId)}.json`);
  }
}

export function providerGateId(signal: ProviderLimitSignal): string {
  const stable = {
    scope: signal.scope,
    kind: signal.kind,
    windowKind: signal.window?.windowKind ?? null,
    resumeAt: signal.window?.resumeAt ?? null,
    resumePolicy: signal.resumePolicy ?? (signal.window?.resumeAt ? "auto_at_window_close" : "manual"),
  };
  const digest = createHash("sha256").update(JSON.stringify(stable)).digest("hex").slice(0, 16);
  const provider = signal.scope.providerId ?? signal.scope.harnessId;
  return `provider-gate:${safeSegment(provider)}:${safeSegment(signal.kind)}:${digest}`;
}

function compareGates(left: RuntimeProviderGate, right: RuntimeProviderGate): number {
  return Date.parse(left.observedAt) - Date.parse(right.observedAt) || left.id.localeCompare(right.id);
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_") || "unknown";
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_") || "record";
}

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
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

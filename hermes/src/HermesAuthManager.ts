import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { errorMessage, SymphonyError } from "../../src/core/errors.js";

const execFileAsync = promisify(execFile);
const AUTH_STORE_VERSION = 1;
const HERMES_OWNED_AUTH_PROVIDERS = new Set(["openai-codex"]);

export interface HermesAuthManagerOptions {
  managedRoot: string;
  bootstrapFrom: string;
  providers: string[];
  upstreamRoot: string;
  python?: string | null;
  timeoutMs?: number | null;
}

export interface HermesAuthPreparation {
  managedRoot: string;
  bootstrapFrom: string;
  presentProviders: string[];
  copiedProviders: string[];
  missingProviders: string[];
}

export interface HermesCodexAuthValidation {
  provider: string;
  source: string | null;
  authMode: string | null;
}

type HermesAuthStore = Record<string, unknown> & {
  version?: number;
  providers?: Record<string, unknown>;
  credential_pool?: Record<string, unknown>;
  suppressed_sources?: Record<string, unknown>;
  active_provider?: unknown;
};

export class HermesAuthManager {
  constructor(private readonly options: HermesAuthManagerOptions) {}

  async prepare(providers = this.options.providers): Promise<HermesAuthPreparation> {
    const normalizedProviders = normalizeHermesAuthProviders(providers);
    await fs.mkdir(this.options.managedRoot, { recursive: true });

    const managed = (await readAuthStore(this.options.managedRoot, "managed")) ?? emptyAuthStore();
    let source: HermesAuthStore | null | undefined;
    let changed = false;
    const presentProviders: string[] = [];
    const copiedProviders: string[] = [];
    const missingProviders: string[] = [];

    for (const provider of normalizedProviders) {
      if (hasProviderAuthMaterial(managed, provider)) {
        presentProviders.push(provider);
        continue;
      }

      source = source === undefined ? await readAuthStore(this.options.bootstrapFrom, "bootstrap") : source;
      if (source && copyProviderAuth(source, managed, provider)) {
        copiedProviders.push(provider);
        changed = true;
      } else {
        missingProviders.push(provider);
      }
    }

    if (changed) await writeAuthStore(this.options.managedRoot, managed);

    return {
      managedRoot: this.options.managedRoot,
      bootstrapFrom: this.options.bootstrapFrom,
      presentProviders,
      copiedProviders,
      missingProviders,
    };
  }

  async requireProviders(providers = this.options.providers): Promise<HermesAuthPreparation> {
    const preparation = await this.prepare(providers);
    if (preparation.missingProviders.length > 0) {
      throw new SymphonyError(
        "config_validation_error",
        hermesManagedAuthMissingMessage(preparation.missingProviders[0]!, this.options.managedRoot, this.options.bootstrapFrom),
      );
    }
    return preparation;
  }

  async validateOpenAiCodex(options: { refreshIfExpiring?: boolean } = {}): Promise<HermesCodexAuthValidation> {
    await this.requireProviders(["openai-codex"]);
    const profileHome = await fs.mkdtemp(path.join(this.options.managedRoot, ".doctor-profile-"));
    const python = this.options.python ?? (process.platform === "win32" ? "python" : "python3");
    const script = [
      "import json",
      "import pathlib",
      "import sys",
      "root = pathlib.Path(sys.argv[1]).resolve()",
      "sys.path.insert(0, str(root))",
      "from hermes_cli.auth import resolve_codex_runtime_credentials",
      "creds = resolve_codex_runtime_credentials(refresh_if_expiring=(sys.argv[2] == '1'))",
      "print(json.dumps({'provider': creds.get('provider'), 'source': creds.get('source'), 'authMode': creds.get('auth_mode'), 'hasApiKey': bool(creds.get('api_key'))}))",
    ].join("\n");

    try {
      const result = await execFileAsync(python, ["-c", script, this.options.upstreamRoot, options.refreshIfExpiring ? "1" : "0"], {
        cwd: this.options.upstreamRoot,
        env: {
          ...process.env,
          HERMES_HOME: profileHome,
          HERMES_AUTH_HOME: this.options.managedRoot,
          HERMES_PYTHON_SRC_ROOT: this.options.upstreamRoot,
        },
        timeout: this.options.timeoutMs ?? 15_000,
      });
      const parsed = JSON.parse(result.stdout.trim()) as {
        provider?: unknown;
        source?: unknown;
        authMode?: unknown;
        hasApiKey?: unknown;
      };
      if (parsed.provider !== "openai-codex" || parsed.hasApiKey !== true) {
        throw new Error("Hermes returned an unexpected Codex auth resolution payload");
      }
      return {
        provider: parsed.provider,
        source: typeof parsed.source === "string" ? parsed.source : null,
        authMode: typeof parsed.authMode === "string" ? parsed.authMode : null,
      };
    } catch (error) {
      throw new SymphonyError(
        "config_validation_error",
        `Hermes managed auth for openai-codex at ${this.options.managedRoot} did not resolve: ${redactHermesAuthMessage(errorMessage(error))}`,
        error,
      );
    } finally {
      await fs.rm(profileHome, { recursive: true, force: true });
    }
  }
}

export function hermesOwnedAuthProvidersForRuntime(provider: string | null | undefined, configuredProviders: string[]): string[] {
  const runtimeProvider = normalizeHermesAuthProvider(provider ?? "");
  if (!runtimeProvider || !isHermesOwnedAuthProvider(runtimeProvider)) return [];
  return normalizeHermesAuthProviders(configuredProviders).filter((configured) => configured === runtimeProvider);
}

export function isHermesOwnedAuthProvider(provider: string | null | undefined): boolean {
  const normalized = normalizeHermesAuthProvider(provider ?? "");
  return normalized.length > 0 && HERMES_OWNED_AUTH_PROVIDERS.has(normalized);
}

export function normalizeHermesAuthProviders(providers: string[]): string[] {
  return [...new Set(providers.map(normalizeHermesAuthProvider).filter((provider) => provider.length > 0))];
}

export function normalizeHermesAuthProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "codex" || normalized === "openai_codex") return "openai-codex";
  return normalized;
}

export function hermesManagedAuthMissingMessage(provider: string, managedRoot: string, bootstrapFrom: string): string {
  return `Hermes managed auth for ${provider} is missing in ${managedRoot}. Run Hermes auth for ${bootstrapFrom}, then re-run npm run doctor.`;
}

export function redactHermesAuthMessage(message: string): string {
  return message
    .replace(/("(?:access|refresh|id)_token"\s*:\s*")[^"]+(")/gi, "$1[redacted]$2")
    .replace(/((?:access|refresh|id)_token=)[^\s,)]+/gi, "$1[redacted]")
    .replace(/\b[A-Za-z0-9_-]{80,}\b/g, "[redacted]");
}

async function readAuthStore(root: string, label: string): Promise<HermesAuthStore | null> {
  const authPath = path.join(root, "auth.json");
  let raw: string;
  try {
    raw = await fs.readFile(authPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw new SymphonyError("config_validation_error", `Hermes ${label} auth store is not readable at ${authPath}: ${errorMessage(error)}`, error);
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainObject(parsed)) {
      throw new Error("auth.json must contain a JSON object");
    }
    return { ...parsed };
  } catch (error) {
    throw new SymphonyError("config_validation_error", `Hermes ${label} auth store is malformed at ${authPath}: ${errorMessage(error)}`, error);
  }
}

async function writeAuthStore(root: string, store: HermesAuthStore): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  store.version = AUTH_STORE_VERSION;
  store.updated_at = new Date().toISOString();
  const authPath = path.join(root, "auth.json");
  const tempPath = path.join(root, `auth.json.tmp.${process.pid}.${randomUUID()}`);
  await fs.writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tempPath, authPath);
  try {
    await fs.chmod(authPath, 0o600);
  } catch {
    // Windows does not reliably honor POSIX mode bits; best effort only.
  }
}

function emptyAuthStore(): HermesAuthStore {
  return { version: AUTH_STORE_VERSION, providers: {} };
}

function hasProviderAuthMaterial(store: HermesAuthStore, provider: string): boolean {
  const providers = recordValue(store.providers);
  if (isPlainObject(providers?.[provider])) return true;
  const pool = recordValue(store.credential_pool);
  return pool?.[provider] !== undefined;
}

function copyProviderAuth(source: HermesAuthStore, managed: HermesAuthStore, provider: string): boolean {
  let copied = false;
  const sourceProviders = recordValue(source.providers);
  const providerState = sourceProviders?.[provider];
  if (isPlainObject(providerState)) {
    const managedProviders = ensureRecord(managed, "providers");
    managedProviders[provider] = cloneJson(providerState);
    copied = true;
  }

  const sourcePool = recordValue(source.credential_pool);
  if (sourcePool?.[provider] !== undefined) {
    const managedPool = ensureRecord(managed, "credential_pool");
    managedPool[provider] = cloneJson(sourcePool[provider]);
    copied = true;
  }

  const sourceSuppressed = recordValue(source.suppressed_sources);
  if (sourceSuppressed?.[provider] !== undefined) {
    const managedSuppressed = ensureRecord(managed, "suppressed_sources");
    managedSuppressed[provider] = cloneJson(sourceSuppressed[provider]);
  }

  if (copied && (managed.active_provider === undefined || source.active_provider === provider)) {
    managed.active_provider = provider;
  }
  return copied;
}

function ensureRecord(store: HermesAuthStore, key: "providers" | "credential_pool" | "suppressed_sources"): Record<string, unknown> {
  const existing = recordValue(store[key]);
  if (existing) return existing;
  const created: Record<string, unknown> = {};
  store[key] = created;
  return created;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isPlainObject(value) ? value : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

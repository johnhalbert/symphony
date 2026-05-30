import { execFile } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { errorMessage } from "../../src/core/errors.js";

export type HostHermesBinarySource = "config" | "path";
export type HostHermesSourceProfileSource = "config" | "active";
export type HostHermesDiagnosticSeverity = "info" | "warning" | "error";

export type HostHermesDiagnosticCode =
  | "host_hermes_binary_missing"
  | "host_hermes_version_probe_failed"
  | "host_hermes_active_profile_probe_failed"
  | "host_hermes_active_profile_unparseable";

export interface HostHermesDiagnostic {
  code: HostHermesDiagnosticCode;
  severity: HostHermesDiagnosticSeverity;
  message: string;
  details?: Record<string, unknown>;
}

export interface HostHermesBinaryDiscovery {
  path: string;
  source: HostHermesBinarySource;
  versionText: string | null;
}

export interface HostHermesSourceProfileDiscovery {
  name: string;
  source: HostHermesSourceProfileSource;
}

export interface HostHermesDiscoveryResult {
  ok: boolean;
  binary: HostHermesBinaryDiscovery | null;
  sourceProfile: HostHermesSourceProfileDiscovery | null;
  diagnostics: HostHermesDiagnostic[];
}

export interface HostHermesCommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface HostHermesCommandResult {
  stdout: string;
  stderr: string;
  exitCode?: number | null;
}

export type HostHermesCommandRunner = (
  file: string,
  args: readonly string[],
  options: HostHermesCommandOptions,
) => Promise<HostHermesCommandResult>;

export type HostHermesFileAccess = (candidatePath: string) => Promise<boolean>;

export interface HostHermesDiscoveryOptions {
  binaryPath?: string | null;
  sourceProfile?: string | null;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  runner?: HostHermesCommandRunner;
  accessFile?: HostHermesFileAccess;
  platform?: NodeJS.Platform;
}

const DEFAULT_HOST_HERMES_COMMAND = "hermes";
const DEFAULT_TIMEOUT_MS = 10_000;

const HOST_HERMES_STRIPPED_ENV_KEYS = [
  "HERMES_HOME",
  "HERMES_AUTH_HOME",
  "HERMES_PYTHON_SRC_ROOT",
  "PYTHONPATH",
  "HERMES_MODEL",
  "HERMES_TUI_PROVIDER",
] as const;

export async function discoverHostHermes(options: HostHermesDiscoveryOptions = {}): Promise<HostHermesDiscoveryResult> {
  const cwd = options.cwd ?? process.cwd();
  const env = hostHermesCommandEnvironment(options.env ?? process.env);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runner = options.runner ?? defaultHostHermesCommandRunner;
  const diagnostics: HostHermesDiagnostic[] = [];

  const binaryChoice = await resolveHostHermesBinary({
    configuredBinary: options.binaryPath,
    cwd,
    env,
    accessFile: options.accessFile ?? defaultFileAccess,
    platform: options.platform ?? process.platform,
  });

  if (!binaryChoice) {
    diagnostics.push({
      code: "host_hermes_binary_missing",
      severity: "error",
      message:
        "Host Hermes executable was not found. Configure a Hermes ACP binary path or add `hermes` to PATH before enabling the Hermes ACP harness.",
      details: { path: pathEnvironmentValue(env) ?? "" },
    });
    return { ok: false, binary: null, sourceProfile: configuredSourceProfile(options.sourceProfile), diagnostics };
  }

  const versionProbe = await runHostHermesCommand(runner, binaryChoice.path, ["--version"], { cwd, env, timeoutMs });
  const versionText = normalizeCommandText(versionProbe.stdout, versionProbe.stderr);
  if (!versionProbe.ok) {
    diagnostics.push({
      code: "host_hermes_version_probe_failed",
      severity: "error",
      message: `Host Hermes executable was found at ${binaryChoice.path}, but \`${DEFAULT_HOST_HERMES_COMMAND} --version\` failed: ${versionProbe.message}`,
      details: compactDetails({ binaryPath: binaryChoice.path, output: versionText, exitCode: versionProbe.exitCode }),
    });
  }

  const binary: HostHermesBinaryDiscovery = { path: binaryChoice.path, source: binaryChoice.source, versionText };
  const sourceProfile =
    configuredSourceProfile(options.sourceProfile) ??
    (await discoverActiveSourceProfile({ binaryPath: binary.path, cwd, env, timeoutMs, runner, diagnostics }));

  return {
    ok: sourceProfile !== null && diagnostics.every((diagnostic) => diagnostic.severity !== "error"),
    binary,
    sourceProfile,
    diagnostics,
  };
}

export async function resolveHostHermesBinary(input: {
  configuredBinary?: string | null | undefined;
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  accessFile?: HostHermesFileAccess | undefined;
  platform?: NodeJS.Platform | undefined;
}): Promise<{ path: string; source: HostHermesBinarySource } | null> {
  const configuredBinary = normalizeOptionalString(input.configuredBinary);
  if (configuredBinary) {
    return { path: normalizeConfiguredBinaryPath(configuredBinary, input.cwd ?? process.cwd()), source: "config" };
  }

  const env = input.env ?? process.env;
  const found = await findExecutableOnPath(DEFAULT_HOST_HERMES_COMMAND, {
    env,
    accessFile: input.accessFile ?? defaultFileAccess,
    platform: input.platform ?? process.platform,
  });
  return found ? { path: found, source: "path" } : null;
}

export async function findExecutableOnPath(
  command: string,
  options: { env?: NodeJS.ProcessEnv; accessFile?: HostHermesFileAccess; platform?: NodeJS.Platform } = {},
): Promise<string | null> {
  const env = options.env ?? process.env;
  const accessFile = options.accessFile ?? defaultFileAccess;
  const platform = options.platform ?? process.platform;
  const pathValue = pathEnvironmentValue(env);
  if (!pathValue) return null;

  const delimiter = platform === "win32" ? ";" : ":";
  const candidateNames = executableCandidateNames(command, env, platform);
  for (const entry of pathValue.split(delimiter)) {
    const searchDir = entry.trim();
    if (!searchDir) continue;
    for (const candidateName of candidateNames) {
      const candidatePath = path.resolve(searchDir, candidateName);
      if (await accessFile(candidatePath)) return candidatePath;
    }
  }
  return null;
}

export function parseHostHermesActiveProfile(output: string): string | null {
  const sanitized = stripAnsi(output).replace(/\r/g, "");
  const match = sanitized.match(/^\s*(?:Active\s+profile|Profile):\s*([^\s]+)\s*$/im);
  return normalizeOptionalString(match?.[1]) ?? null;
}

export function hostHermesCommandEnvironment(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of HOST_HERMES_STRIPPED_ENV_KEYS) {
    deleteCaseInsensitiveEnvKey(env, key);
  }
  return env;
}

async function discoverActiveSourceProfile(input: {
  binaryPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  runner: HostHermesCommandRunner;
  diagnostics: HostHermesDiagnostic[];
}): Promise<HostHermesSourceProfileDiscovery | null> {
  const profileProbe = await runHostHermesCommand(input.runner, input.binaryPath, ["profile"], {
    cwd: input.cwd,
    env: input.env,
    timeoutMs: input.timeoutMs,
  });
  const output = normalizeCommandText(profileProbe.stdout, profileProbe.stderr);
  if (!profileProbe.ok) {
    input.diagnostics.push({
      code: "host_hermes_active_profile_probe_failed",
      severity: "error",
      message: `Host Hermes active profile probe failed: ${profileProbe.message}`,
      details: compactDetails({ binaryPath: input.binaryPath, output, exitCode: profileProbe.exitCode }),
    });
    return null;
  }

  const activeProfile = parseHostHermesActiveProfile(output ?? "");
  if (!activeProfile) {
    input.diagnostics.push({
      code: "host_hermes_active_profile_unparseable",
      severity: "error",
      message: "Host Hermes active profile probe did not include a `Profile:` or `Active profile:` line.",
      details: compactDetails({ binaryPath: input.binaryPath, output }),
    });
    return null;
  }

  return { name: activeProfile, source: "active" };
}

function configuredSourceProfile(sourceProfile: string | null | undefined): HostHermesSourceProfileDiscovery | null {
  const normalized = normalizeOptionalString(sourceProfile);
  return normalized ? { name: normalized, source: "config" } : null;
}

async function runHostHermesCommand(
  runner: HostHermesCommandRunner,
  file: string,
  args: readonly string[],
  options: HostHermesCommandOptions,
): Promise<{ ok: true; stdout: string; stderr: string; exitCode: number | null } | { ok: false; stdout: string; stderr: string; exitCode: number | null; message: string }> {
  try {
    const result = await runner(file, args, options);
    const exitCode = result.exitCode ?? 0;
    if (exitCode !== 0) {
      return {
        ok: false,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode,
        message: `exit code ${exitCode}`,
      };
    }
    return { ok: true, stdout: result.stdout, stderr: result.stderr, exitCode };
  } catch (error) {
    return {
      ok: false,
      stdout: commandErrorText(error, "stdout"),
      stderr: commandErrorText(error, "stderr"),
      exitCode: commandErrorExitCode(error),
      message: errorMessage(error),
    };
  }
}

function defaultHostHermesCommandRunner(
  file: string,
  args: readonly string[],
  options: HostHermesCommandOptions,
): Promise<HostHermesCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { cwd: options.cwd, env: options.env, timeout: options.timeoutMs, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          Object.assign(error, { stdout, stderr });
          reject(error);
          return;
        }
        resolve({ stdout: commandOutputToString(stdout), stderr: commandOutputToString(stderr), exitCode: 0 });
      },
    );
  });
}

async function defaultFileAccess(candidatePath: string): Promise<boolean> {
  try {
    await fs.access(candidatePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executableCandidateNames(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform !== "win32" || path.extname(command)) return [command];
  const rawPathExt = lookupEnvValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD";
  const extensions = rawPathExt
    .split(";")
    .map((extension) => extension.trim())
    .filter((extension) => extension.length > 0)
    .map((extension) => (extension.startsWith(".") ? extension : `.${extension}`));
  return [...new Set([command, ...extensions.map((extension) => `${command}${extension}`)])];
}

function normalizeConfiguredBinaryPath(value: string, cwd: string): string {
  if (!isPathLike(value)) return value;
  return path.resolve(cwd, value);
}

function isPathLike(value: string): boolean {
  return path.isAbsolute(value) || value.includes("/") || value.includes("\\");
}

function pathEnvironmentValue(env: NodeJS.ProcessEnv): string | undefined {
  return lookupEnvValue(env, "PATH");
}

function lookupEnvValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const direct = env[key];
  if (direct !== undefined) return direct;
  const lowerKey = key.toLowerCase();
  for (const [candidateKey, value] of Object.entries(env)) {
    if (candidateKey.toLowerCase() === lowerKey) return value;
  }
  return undefined;
}

function deleteCaseInsensitiveEnvKey(env: NodeJS.ProcessEnv, key: string): void {
  const lowerKey = key.toLowerCase();
  for (const candidateKey of Object.keys(env)) {
    if (candidateKey.toLowerCase() === lowerKey) delete env[candidateKey];
  }
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function normalizeCommandText(...parts: Array<string | null | undefined>): string | null {
  const text = parts
    .map((part) => stripAnsi(part ?? "").trim())
    .filter((part) => part.length > 0)
    .join("\n")
    .trim();
  return text.length > 0 ? text : null;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function commandOutputToString(value: string | Buffer): string {
  return typeof value === "string" ? value : value.toString("utf8");
}

function commandErrorText(error: unknown, field: "stdout" | "stderr"): string {
  if (!isRecord(error)) return "";
  const value = error[field];
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return "";
}

function commandErrorExitCode(error: unknown): number | null {
  if (!isRecord(error)) return null;
  const code = error.code;
  return typeof code === "number" ? code : null;
}

function compactDetails(details: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(details).filter(([, value]) => value !== null && value !== undefined && value !== ""),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

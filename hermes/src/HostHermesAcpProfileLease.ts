import { execFile } from "node:child_process";
import { createHash } from "node:crypto";

export type HostHermesAcpProfileRetention = "always" | "failed" | "never";
export type HostHermesAcpTerminalStatus = "succeeded" | "failed" | "cancelled" | null;
export type HostHermesAcpLeaseDisposeReason = "already_disposed" | "retained" | "deleted";

export interface HostHermesAcpCommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface HostHermesAcpCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type HostHermesAcpCommandRunner = (
  file: string,
  args: readonly string[],
  options: HostHermesAcpCommandOptions,
) => Promise<HostHermesAcpCommandResult>;

export interface HostHermesAcpProfileNameInput {
  workspaceKey: string;
  issueIdentifier: string;
  role: string;
  phase: string;
  runId?: string | null;
  attempt?: number | null;
  prefix?: string | null;
  reservedNames?: Iterable<string>;
}

export interface HostHermesAcpProfileLeaseOptions {
  binaryPath: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  sourceProfile?: string | null;
  profileName?: string | null;
  nameInput?: HostHermesAcpProfileNameInput;
  reservedProfileNames?: Iterable<string>;
  keepProfiles?: HostHermesAcpProfileRetention;
  runner?: HostHermesAcpCommandRunner;
}

export interface HostHermesAcpProcessCommand {
  file: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface HostHermesAcpProfileLease {
  profileName: string;
  sourceProfile: string;
  acpCommand: HostHermesAcpProcessCommand;
  dispose(terminalStatus: HostHermesAcpTerminalStatus): Promise<HostHermesAcpProfileLeaseDisposeResult>;
}

export interface HostHermesAcpProfileLeaseDisposeResult {
  profileName: string;
  reason: HostHermesAcpLeaseDisposeReason;
  deleted: boolean;
}

export const HOST_HERMES_ACP_PROFILE_NAME_LIMIT = 64;

export const HOST_HERMES_ACP_STRIPPED_ENV_KEYS = [
  "HERMES_HOME",
  "HERMES_AUTH_HOME",
  "HERMES_PYTHON_SRC_ROOT",
  "PYTHONPATH",
  "HERMES_MODEL",
  "HERMES_TUI_PROVIDER",
] as const;

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_PROFILE_PREFIX = "symphony";
const DEFAULT_RESERVED_PROFILE_NAMES = new Set(["default"]);

type HostHermesAcpProfileLeaseProfileDisposition = "created" | "reused";

export async function createHostHermesAcpProfileLease(
  options: HostHermesAcpProfileLeaseOptions,
): Promise<HostHermesAcpProfileLease> {
  const binaryPath = requireNonEmpty(options.binaryPath, "Host Hermes binary path");
  const cwd = requireNonEmpty(options.cwd, "Host Hermes ACP working directory");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env = hostHermesAcpCommandEnvironment(options.env ?? process.env);
  const runner = options.runner ?? defaultHostHermesAcpCommandRunner;
  const keepProfiles = options.keepProfiles ?? "failed";
  const reservedProfileNames = combineReservedProfileNames(options.reservedProfileNames);
  const profileName = resolveRequestedProfileName(options, reservedProfileNames);
  const sourceProfile = await resolveHostHermesAcpSourceProfile({
    binaryPath,
    cwd,
    env,
    timeoutMs,
    ...(options.sourceProfile !== undefined ? { sourceProfile: options.sourceProfile } : {}),
    runner,
  });

  const profileDisposition = await acquireHostHermesAcpLeaseProfile(runner, binaryPath, profileName, sourceProfile, {
    cwd,
    env,
    timeoutMs,
  });

  const acpCommand = buildHostHermesAcpLaunchCommand({ binaryPath, profileName, cwd, env });
  let disposed = false;

  return {
    profileName,
    sourceProfile,
    acpCommand,
    async dispose(terminalStatus: HostHermesAcpTerminalStatus): Promise<HostHermesAcpProfileLeaseDisposeResult> {
      if (disposed) return { profileName, reason: "already_disposed", deleted: false };
      if (profileDisposition === "reused") {
        disposed = true;
        return { profileName, reason: "retained", deleted: false };
      }
      if (!shouldDeleteHostHermesAcpProfile({ keepProfiles, terminalStatus })) {
        disposed = true;
        return { profileName, reason: "retained", deleted: false };
      }
      await runRequiredHostHermesAcpCommand(runner, binaryPath, buildHostHermesAcpDeleteProfileArgs(profileName), {
        cwd,
        env,
        timeoutMs,
      });
      disposed = true;
      return { profileName, reason: "deleted", deleted: true };
    },
  };
}

export function buildHostHermesAcpProfileName(input: HostHermesAcpProfileNameInput): string {
  const reservedNames = combineReservedProfileNames(input.reservedNames);
  const components = [
    input.prefix ?? DEFAULT_PROFILE_PREFIX,
    input.workspaceKey,
    input.issueIdentifier,
    input.role,
    input.phase,
    input.attempt === null || input.attempt === undefined ? null : `attempt-${input.attempt}`,
    input.runId ?? null,
  ];
  const rawName = components.filter((component): component is string => typeof component === "string" && component.trim().length > 0).join("-");
  return normalizeHostHermesAcpProfileName(rawName, { reservedNames, hashSeed: JSON.stringify(components) });
}

export function normalizeHostHermesAcpProfileName(
  value: string,
  options: { reservedNames?: Iterable<string>; hashSeed?: string | null } = {},
): string {
  const reservedNames = combineReservedProfileNames(options.reservedNames);
  const hashSeed = options.hashSeed ?? value;
  const hash = createHash("sha256").update(hashSeed).digest("hex").slice(0, 10);
  const normalized = slugifyHostHermesProfileName(value);
  const base = normalized.length > 0 ? normalized : DEFAULT_PROFILE_PREFIX;
  let candidate = withStableHash(base, hash);
  if (isReservedHostHermesProfileName(candidate, reservedNames)) {
    candidate = withStableHash(`${DEFAULT_PROFILE_PREFIX}-${candidate}`, hash);
  }
  if (isReservedHostHermesProfileName(candidate, reservedNames)) {
    candidate = withStableHash(`${DEFAULT_PROFILE_PREFIX}-acp-${hash}`, hash);
  }
  return candidate;
}

export function buildHostHermesAcpCreateProfileArgs(profileName: string, sourceProfile: string): readonly string[] {
  return ["profile", "create", profileName, "--clone", "--clone-from", sourceProfile, "--no-alias"];
}

export function buildHostHermesAcpLaunchArgs(profileName: string): readonly string[] {
  return ["-p", profileName, "acp"];
}

export function buildHostHermesAcpDeleteProfileArgs(profileName: string): readonly string[] {
  return ["profile", "delete", profileName, "--yes"];
}

export function buildHostHermesAcpLaunchCommand(input: {
  binaryPath: string;
  profileName: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): HostHermesAcpProcessCommand {
  return {
    file: input.binaryPath,
    args: buildHostHermesAcpLaunchArgs(input.profileName),
    cwd: input.cwd,
    env: hostHermesAcpCommandEnvironment(input.env ?? process.env),
  };
}

export function hostHermesAcpCommandEnvironment(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of HOST_HERMES_ACP_STRIPPED_ENV_KEYS) {
    deleteCaseInsensitiveEnvKey(env, key);
  }
  return env;
}

export async function resolveHostHermesAcpSourceProfile(input: {
  binaryPath: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  sourceProfile?: string | null;
  runner?: HostHermesAcpCommandRunner;
}): Promise<string> {
  const configured = normalizeOptionalString(input.sourceProfile);
  if (configured) return configured;

  const env = hostHermesAcpCommandEnvironment(input.env ?? process.env);
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runner = input.runner ?? defaultHostHermesAcpCommandRunner;
  const probe = await runRequiredHostHermesAcpCommand(runner, input.binaryPath, ["profile"], {
    cwd: input.cwd,
    env,
    timeoutMs,
  });
  const activeProfile = parseHostHermesAcpActiveProfile(`${probe.stdout}\n${probe.stderr}`);
  if (!activeProfile) {
    throw new Error("Host Hermes active profile probe did not include an `Active profile:` line.");
  }
  return activeProfile;
}

export function parseHostHermesAcpActiveProfile(output: string): string | null {
  const sanitized = stripAnsi(output).replace(/\r/g, "");
  const match = sanitized.match(/^\s*Active profile:\s*([^\s]+)\s*$/im);
  return normalizeOptionalString(match?.[1]) ?? null;
}

export function shouldDeleteHostHermesAcpProfile(input: {
  keepProfiles: HostHermesAcpProfileRetention;
  terminalStatus: HostHermesAcpTerminalStatus;
}): boolean {
  if (input.keepProfiles === "always") return false;
  if (input.keepProfiles === "failed" && input.terminalStatus === "failed") return false;
  return true;
}

async function acquireHostHermesAcpLeaseProfile(
  runner: HostHermesAcpCommandRunner,
  file: string,
  profileName: string,
  sourceProfile: string,
  options: HostHermesAcpCommandOptions,
): Promise<HostHermesAcpProfileLeaseProfileDisposition> {
  if (isSameHostHermesAcpProfileName(profileName, sourceProfile)) return "reused";

  const args = buildHostHermesAcpCreateProfileArgs(profileName, sourceProfile);
  const result = await runHostHermesAcpCommand(runner, file, args, options);
  if (result.exitCode === 0) return "created";
  if (typeof result.exitCode === "number" && isExpectedExistingHostHermesAcpProfile(result, profileName)) return "reused";
  throw hostHermesAcpCommandResultError(result, file, args);
}

async function runRequiredHostHermesAcpCommand(
  runner: HostHermesAcpCommandRunner,
  file: string,
  args: readonly string[],
  options: HostHermesAcpCommandOptions,
): Promise<HostHermesAcpCommandResult> {
  const result = await runHostHermesAcpCommand(runner, file, args, options);
  if (result.exitCode !== 0) throw hostHermesAcpCommandResultError(result, file, args);
  return { ...result, exitCode: result.exitCode };
}

async function runHostHermesAcpCommand(
  runner: HostHermesAcpCommandRunner,
  file: string,
  args: readonly string[],
  options: HostHermesAcpCommandOptions,
): Promise<HostHermesAcpCommandResult> {
  try {
    return await runner(file, args, options);
  } catch (error) {
    const output = commandFailureOutput(commandErrorOutput(error, "stdout"), commandErrorOutput(error, "stderr"));
    throw new Error(`Host Hermes command failed: ${file} ${args.join(" ")}: ${errorMessage(error)}${output ? `\n${output}` : ""}`);
  }
}

function hostHermesAcpCommandResultError(result: HostHermesAcpCommandResult, file: string, args: readonly string[]): Error {
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const exitCode = result.exitCode;
  if (exitCode === null || exitCode === undefined) {
    const output = commandFailureOutput(stdout, stderr);
    return new Error(`Host Hermes command ended without an exit code: ${file} ${args.join(" ")}${output ? `\n${output}` : ""}`);
  }
  const output = commandFailureOutput(stdout, stderr);
  return new Error(
    `Host Hermes command failed with exit code ${exitCode}: ${file} ${args.join(" ")}${output ? `\n${output}` : ""}`,
  );
}

function isExpectedExistingHostHermesAcpProfile(result: HostHermesAcpCommandResult, profileName: string): boolean {
  const output = stripAnsi(`${result.stdout}\n${result.stderr}`).replace(/\r/g, "");
  const escapedProfileName = escapeRegExp(profileName);
  return (
    /\balready\s+exists\b/i.test(output) &&
    new RegExp(`(^|[^a-z0-9_-])${escapedProfileName}([^a-z0-9_-]|$)`, "i").test(output)
  );
}

function isSameHostHermesAcpProfileName(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function defaultHostHermesAcpCommandRunner(
  file: string,
  args: readonly string[],
  options: HostHermesAcpCommandOptions,
): Promise<HostHermesAcpCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { cwd: options.cwd, env: options.env, timeout: options.timeoutMs, windowsHide: true },
      (error, stdout, stderr) => {
        const stdoutText = commandOutputToString(stdout);
        const stderrText = commandOutputToString(stderr);
        if (error) {
          const commandError = error as NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals | string | null };
          if (typeof commandError.code === "number") {
            resolve({ stdout: stdoutText, stderr: stderrText, exitCode: commandError.code });
            return;
          }
          if (commandError.killed || commandError.signal) {
            resolve({ stdout: stdoutText, stderr: stderrText, exitCode: null });
            return;
          }
          Object.assign(error, { stdout: stdoutText, stderr: stderrText });
          reject(error);
          return;
        }
        resolve({ stdout: stdoutText, stderr: stderrText, exitCode: 0 });
      },
    );
  });
}

function resolveRequestedProfileName(options: HostHermesAcpProfileLeaseOptions, reservedProfileNames: ReadonlySet<string>): string {
  const explicit = normalizeOptionalString(options.profileName);
  if (explicit) return normalizeHostHermesAcpProfileName(explicit, { reservedNames: reservedProfileNames });
  if (options.nameInput) {
    return buildHostHermesAcpProfileName({ ...options.nameInput, reservedNames: reservedProfileNames });
  }
  throw new Error("Host Hermes ACP profile lease requires either profileName or nameInput.");
}

function combineReservedProfileNames(extra: Iterable<string> | undefined): ReadonlySet<string> {
  const names = new Set(DEFAULT_RESERVED_PROFILE_NAMES);
  for (const name of extra ?? []) {
    const normalized = slugifyHostHermesProfileName(name);
    if (normalized) names.add(normalized);
  }
  return names;
}

function isReservedHostHermesProfileName(profileName: string, reservedNames: ReadonlySet<string>): boolean {
  return reservedNames.has(profileName.toLowerCase());
}

function slugifyHostHermesProfileName(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/[-_]{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  if (/^[a-z0-9]/.test(slug)) return slug;
  return slug.length > 0 ? `${DEFAULT_PROFILE_PREFIX}-${slug}` : "";
}

function withStableHash(base: string, hash: string): string {
  const suffix = `-${hash}`;
  if (base.endsWith(suffix) && base.length <= HOST_HERMES_ACP_PROFILE_NAME_LIMIT) return base;
  const full = `${base}${suffix}`;
  if (full.length <= HOST_HERMES_ACP_PROFILE_NAME_LIMIT) return full;
  const prefixLength = HOST_HERMES_ACP_PROFILE_NAME_LIMIT - suffix.length;
  const prefix = (base.slice(0, prefixLength).replace(/[-_]+$/g, "") || DEFAULT_PROFILE_PREFIX).slice(0, prefixLength);
  return `${prefix}${suffix}`;
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

function requireNonEmpty(value: string, label: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function commandOutputToString(value: string | Buffer): string {
  return typeof value === "string" ? value : value.toString("utf8");
}

function commandFailureOutput(stdout: string, stderr: string): string {
  return [stdout, stderr]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n");
}

function commandErrorOutput(error: unknown, key: "stdout" | "stderr"): string {
  if (!error || typeof error !== "object") return "";
  const value = (error as Record<string, unknown>)[key];
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return "";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

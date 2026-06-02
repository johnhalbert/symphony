import { spawn } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import YAML from "yaml";
import { shouldIncludeNodeExecArgv, type McpSubprocessServerConfig } from "../../src/core/harness/McpSubprocessEnvironment.js";

export interface HermesMcpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
  timeout: number;
  connect_timeout: number;
}

export type HermesMcpServersConfig = Record<string, HermesMcpServerConfig>;

export interface HermesShellHookConfig {
  command: string;
  matcher?: string;
  timeout?: number;
}

export type HermesShellHooksConfig = Record<string, HermesShellHookConfig[]>;

export const SYMPHONY_HERMES_AGENT_MAX_TURNS = 999;
export const SYMPHONY_AGENT_COMMAND_POLICY_HOOK_MATCHER = "terminal|execute_code";
export const SYMPHONY_AGENT_COMMAND_POLICY_HOOK_TIMEOUT_SECONDS = 10;

export interface BuildHermesAgentCommandPolicyHookOptions {
  cliPath: string;
  role: string;
  phase: string;
  issueId?: string | null;
  matcher?: string;
  timeoutSeconds?: number;
}

export interface WriteHermesMcpConfigOptions {
  profileDir: string;
  servers: Record<string, McpSubprocessServerConfig>;
  timeoutSeconds?: number;
  connectTimeoutSeconds?: number;
  agentMaxTurns?: number;
  hooks?: HermesShellHooksConfig;
  hooksAutoAccept?: boolean;
}

export interface HermesAgentCommandPolicyHookInvocation {
  command: string;
  args: string[];
}

export interface HermesAgentCommandPolicyHookProfileValidationOptions extends BuildHermesAgentCommandPolicyHookOptions {
  profileDir: string;
}

export interface VerifyHermesAgentCommandPolicyHookInstallationOptions
  extends HermesAgentCommandPolicyHookProfileValidationOptions {
  upstreamRoot: string;
  python?: string | null;
  smokeCwd?: string;
  commandTimeoutMs?: number;
  registrationTimeoutMs?: number;
}

export type HermesAgentCommandPolicyHookVerifier = (
  options: VerifyHermesAgentCommandPolicyHookInstallationOptions,
) => Promise<void>;

export async function writeHermesMcpConfig(options: WriteHermesMcpConfigOptions): Promise<HermesMcpServersConfig> {
  const configPath = path.join(options.profileDir, "config.yaml");
  const existing = await readYamlObject(configPath);
  const mcpServers = toHermesMcpServers(options.servers, {
    timeoutSeconds: options.timeoutSeconds ?? 120,
    connectTimeoutSeconds: options.connectTimeoutSeconds ?? 60,
  });
  const next = {
    ...existing,
    ...(options.agentMaxTurns === undefined ? {} : { agent: { ...recordValue(existing.agent), max_turns: options.agentMaxTurns } }),
    ...(options.hooks === undefined ? {} : { hooks: mergeHermesShellHooks(existing.hooks, options.hooks) }),
    ...(options.hooksAutoAccept === undefined ? {} : { hooks_auto_accept: options.hooksAutoAccept }),
    mcp_servers: mcpServers,
  };

  await fs.mkdir(options.profileDir, { recursive: true });
  await fs.writeFile(configPath, YAML.stringify(next), "utf8");
  return mcpServers;
}

export function buildHermesAgentCommandPolicyHookConfig(options: BuildHermesAgentCommandPolicyHookOptions): HermesShellHooksConfig {
  return {
    pre_tool_call: [
      {
        matcher: options.matcher ?? SYMPHONY_AGENT_COMMAND_POLICY_HOOK_MATCHER,
        command: buildHermesAgentCommandPolicyHookCommand(options),
        timeout: options.timeoutSeconds ?? SYMPHONY_AGENT_COMMAND_POLICY_HOOK_TIMEOUT_SECONDS,
      },
    ],
  };
}

export function buildHermesAgentCommandPolicyHookCommand(options: BuildHermesAgentCommandPolicyHookOptions): string {
  const invocation = buildHermesAgentCommandPolicyHookInvocation(options);
  return [invocation.command, ...invocation.args].map(shellQuote).join(" ");
}

export function buildHermesAgentCommandPolicyHookInvocation(
  options: BuildHermesAgentCommandPolicyHookOptions,
): HermesAgentCommandPolicyHookInvocation {
  const args = [
    ...agentCommandPolicyHookNodeExecArgv(options.cliPath),
    options.cliPath,
    "agent-command-policy-hook",
    "--role",
    options.role,
    "--phase",
    options.phase,
  ];
  const issueId = nonEmptyString(options.issueId);
  if (issueId) args.push("--issue-id", issueId);
  return { command: process.execPath, args };
}

export async function verifyHermesAgentCommandPolicyHookInstallation(
  options: VerifyHermesAgentCommandPolicyHookInstallationOptions,
): Promise<void> {
  await assertHermesAgentCommandPolicyHookProfileConfig(options);
  await verifyHermesAgentCommandPolicyHookRegistration(options);
  await verifyHermesAgentCommandPolicyHookCommandRunnable(options);
}

export async function assertHermesAgentCommandPolicyHookProfileConfig(
  options: HermesAgentCommandPolicyHookProfileValidationOptions,
): Promise<HermesShellHookConfig> {
  const config = await readYamlObject(path.join(options.profileDir, "config.yaml"), { required: true });
  if (config.hooks_auto_accept !== true) {
    throw hookValidationError(
      options.profileDir,
      "hooks_auto_accept must be true so Hermes gateway/TUI startup can register the generated command-policy hook without an interactive prompt",
    );
  }

  const hooks = recordValue(config.hooks);
  const preToolCallHooks = hooks.pre_tool_call;
  if (!Array.isArray(preToolCallHooks)) {
    throw hookValidationError(options.profileDir, "hooks.pre_tool_call must contain the generated command-policy hook");
  }

  const expectedHook = buildHermesAgentCommandPolicyHookConfig(options).pre_tool_call?.[0];
  if (!expectedHook) {
    throw hookValidationError(options.profileDir, "could not build the expected generated command-policy hook");
  }
  const matchingHooks = preToolCallHooks.filter(isHermesShellHookConfig).filter((entry) => isExpectedHook(entry, expectedHook));
  if (matchingHooks.length !== 1) {
    throw hookValidationError(
      options.profileDir,
      `expected exactly one generated pre_tool_call command-policy hook matching matcher=${expectedHook.matcher}, timeout=${expectedHook.timeout}, and the generated agent-command-policy-hook command; found ${matchingHooks.length}`,
    );
  }
  assertCommandPolicyMatcherCoversRequiredTools(matchingHooks[0]!, options.profileDir);
  return matchingHooks[0]!;
}

export async function verifyHermesAgentCommandPolicyHookCommandRunnable(
  options: HermesAgentCommandPolicyHookProfileValidationOptions & { smokeCwd?: string; commandTimeoutMs?: number },
): Promise<void> {
  const cliPath = path.resolve(options.cliPath);
  try {
    await fs.access(cliPath, fsConstants.R_OK);
  } catch (error) {
    throw hookValidationError(options.profileDir, `generated hook CLI path is not readable: ${cliPath} (${errorMessage(error)})`);
  }

  const invocation = buildHermesAgentCommandPolicyHookInvocation(options);
  const result = await spawnWithInput(
    invocation.command,
    invocation.args,
    `${JSON.stringify(commandPolicyHookSmokePayload(options.profileDir))}\n`,
    {
      cwd: options.smokeCwd ?? process.cwd(),
      env: process.env,
      timeoutMs: options.commandTimeoutMs ?? Math.min(SYMPHONY_AGENT_COMMAND_POLICY_HOOK_TIMEOUT_SECONDS * 1_000, 10_000),
    },
  );
  if (result.timedOut) {
    throw hookValidationError(options.profileDir, `generated hook command smoke test timed out after ${result.timeoutMs}ms`);
  }
  if (result.error) {
    throw hookValidationError(options.profileDir, `generated hook command could not be spawned: ${errorMessage(result.error)}`);
  }
  if (result.exitCode !== 0) {
    throw hookValidationError(
      options.profileDir,
      `generated hook command smoke test exited with code ${result.exitCode ?? "null"}; stderr=${previewOutput(result.stderr)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch (error) {
    throw hookValidationError(
      options.profileDir,
      `generated hook command smoke test did not emit a JSON Hermes hook response: ${errorMessage(error)}; stdout=${previewOutput(result.stdout)} stderr=${previewOutput(result.stderr)}`,
    );
  }
  if (!isRecord(parsed) || parsed.action !== "block" || typeof parsed.message !== "string" || parsed.message.trim().length === 0) {
    throw hookValidationError(
      options.profileDir,
      `generated hook command smoke test did not fail closed with an action=block response; stdout=${previewOutput(result.stdout)}`,
    );
  }
}

export async function verifyHermesAgentCommandPolicyHookRegistration(
  options: HermesAgentCommandPolicyHookProfileValidationOptions & {
    upstreamRoot: string;
    python?: string | null;
    registrationTimeoutMs?: number;
  },
): Promise<void> {
  const upstreamRoot = path.resolve(options.upstreamRoot);
  for (const relativePath of [path.join("agent", "shell_hooks.py"), path.join("hermes_cli", "config.py")]) {
    const targetPath = path.join(upstreamRoot, relativePath);
    try {
      await fs.access(targetPath, fsConstants.R_OK);
    } catch (error) {
      throw hookValidationError(
        options.profileDir,
        `cannot verify Hermes shell-hook registration because upstream Hermes file is not readable: ${targetPath} (${errorMessage(error)})`,
      );
    }
  }

  const expectedHook = buildHermesAgentCommandPolicyHookConfig(options).pre_tool_call?.[0];
  if (!expectedHook) {
    throw hookValidationError(options.profileDir, "could not build the expected generated command-policy hook");
  }
  const python = nonEmptyString(options.python) ?? "python";
  const result = await spawnWithInput(
    python,
    ["-c", HERMES_HOOK_REGISTRATION_VALIDATION_PY, expectedHook.command, expectedHook.matcher ?? "", String(expectedHook.timeout ?? "")],
    "",
    {
      cwd: upstreamRoot,
      env: {
        ...process.env,
        HERMES_HOME: options.profileDir,
        HERMES_ACCEPT_HOOKS: "1",
        PYTHONPATH: [upstreamRoot, process.env.PYTHONPATH]
          .filter((value): value is string => nonEmptyString(value) !== null)
          .join(path.delimiter),
      },
      timeoutMs: options.registrationTimeoutMs ?? 10_000,
    },
  );
  if (result.timedOut) {
    throw hookValidationError(options.profileDir, `Hermes shell-hook registration validation timed out after ${result.timeoutMs}ms`);
  }
  if (result.error) {
    throw hookValidationError(options.profileDir, `Hermes shell-hook registration validator could not be spawned: ${errorMessage(result.error)}`);
  }
  if (result.exitCode !== 0) {
    throw hookValidationError(
      options.profileDir,
      `Hermes shell-hook registration validation failed with code ${result.exitCode ?? "null"}; stdout=${previewOutput(result.stdout)} stderr=${previewOutput(result.stderr)}`,
    );
  }
  try {
    const parsed = JSON.parse(result.stdout.trim()) as unknown;
    if (!isRecord(parsed) || parsed.ok !== true) throw new Error("registration validator did not report ok=true");
  } catch (error) {
    throw hookValidationError(
      options.profileDir,
      `Hermes shell-hook registration validator emitted an invalid response: ${errorMessage(error)}; stdout=${previewOutput(result.stdout)} stderr=${previewOutput(result.stderr)}`,
    );
  }
}

export function toHermesMcpServers(
  servers: Record<string, McpSubprocessServerConfig>,
  options: { timeoutSeconds?: number; connectTimeoutSeconds?: number } = {},
): HermesMcpServersConfig {
  const timeout = options.timeoutSeconds ?? 120;
  const connectTimeout = options.connectTimeoutSeconds ?? 60;
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      name,
      {
        command: server.command,
        args: server.args,
        env: stringEnv(server.env),
        timeout,
        connect_timeout: connectTimeout,
      },
    ]),
  );
}

async function readYamlObject(filePath: string, options: { required?: boolean } = {}): Promise<Record<string, unknown>> {
  let raw = "";
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (options.required) throw hookValidationError(path.dirname(filePath), `cannot read Hermes profile config: ${filePath} (${errorMessage(error)})`);
    return {};
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (error) {
    if (options.required) throw hookValidationError(path.dirname(filePath), `cannot parse Hermes profile config YAML: ${errorMessage(error)}`);
    throw error;
  }
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  if (options.required) throw hookValidationError(path.dirname(filePath), "Hermes profile config must be a YAML mapping");
  return {};
}

function stringEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function mergeHermesShellHooks(existingHooks: unknown, generatedHooks: HermesShellHooksConfig): HermesShellHooksConfig {
  const merged: HermesShellHooksConfig = {};
  for (const [eventName, entries] of Object.entries(recordValue(existingHooks))) {
    if (!Array.isArray(entries)) continue;
    const parsedEntries = entries.filter(isHermesShellHookConfig);
    if (parsedEntries.length > 0) merged[eventName] = parsedEntries;
  }
  for (const [eventName, entries] of Object.entries(generatedHooks)) {
    const existingEntries = merged[eventName] ?? [];
    merged[eventName] = dedupeHermesShellHooks([...existingEntries, ...entries.filter(isHermesShellHookConfig)]);
  }
  return merged;
}

function dedupeHermesShellHooks(entries: HermesShellHookConfig[]): HermesShellHookConfig[] {
  const seen = new Set<string>();
  const deduped: HermesShellHookConfig[] = [];
  for (const entry of entries) {
    const key = JSON.stringify([entry.matcher ?? null, entry.command, entry.timeout ?? null]);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}

function isHermesShellHookConfig(value: unknown): value is HermesShellHookConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.command !== "string" || record.command.trim().length === 0) return false;
  if (record.matcher !== undefined && typeof record.matcher !== "string") return false;
  if (record.timeout !== undefined && typeof record.timeout !== "number") return false;
  return true;
}

function isExpectedHook(entry: HermesShellHookConfig, expected: HermesShellHookConfig): boolean {
  return entry.command === expected.command && entry.matcher === expected.matcher && entry.timeout === expected.timeout;
}

function assertCommandPolicyMatcherCoversRequiredTools(entry: HermesShellHookConfig, profileDir: string): void {
  if (entry.matcher !== SYMPHONY_AGENT_COMMAND_POLICY_HOOK_MATCHER) {
    throw hookValidationError(
      profileDir,
      `generated command-policy hook matcher must be ${SYMPHONY_AGENT_COMMAND_POLICY_HOOK_MATCHER}; found ${entry.matcher ?? "<none>"}`,
    );
  }
  let matcher: RegExp;
  try {
    matcher = new RegExp(`^(?:${entry.matcher})$`);
  } catch (error) {
    throw hookValidationError(profileDir, `generated command-policy hook matcher is not a valid regex: ${errorMessage(error)}`);
  }
  for (const toolName of ["terminal", "execute_code"]) {
    if (!matcher.test(toolName)) throw hookValidationError(profileDir, `generated command-policy hook matcher does not cover ${toolName}`);
  }
  if (matcher.test("write_file")) {
    throw hookValidationError(profileDir, "generated command-policy hook matcher unexpectedly covers non-command-capable write_file");
  }
}

function commandPolicyHookSmokePayload(profileDir: string): Record<string, unknown> {
  return {
    hook_event_name: "post_tool_call",
    tool_name: "terminal",
    tool_input: { command: "git push origin HEAD" },
    session_id: "symphony-hook-validation",
    cwd: profileDir,
  };
}

interface SpawnWithInputResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  timeoutMs: number;
  error: Error | null;
}

function spawnWithInput(
  command: string,
  args: string[],
  input: string,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes?: number },
): Promise<SpawnWithInputResult> {
  const timeoutMs = options.timeoutMs;
  const maxOutputBytes = options.maxOutputBytes ?? 32 * 1024;
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const append = (current: string, chunk: Buffer): string => {
      if (Buffer.byteLength(current, "utf8") >= maxOutputBytes) return current;
      const next = current + chunk.toString("utf8");
      return Buffer.byteLength(next, "utf8") > maxOutputBytes ? next.slice(0, maxOutputBytes) : next;
    };
    const finish = (result: Omit<SpawnWithInputResult, "stdout" | "stderr" | "timedOut" | "timeoutMs">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr, timedOut, timeoutMs });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => finish({ exitCode: null, signal: null, error }));
    child.on("close", (exitCode, signal) => finish({ exitCode, signal, error: null }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

function hookValidationError(profileDir: string, message: string): Error {
  return new Error(`Hermes command-policy hook validation failed for profile ${profileDir}: ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function previewOutput(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 500) return normalized;
  return `${normalized.slice(0, 500)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const HERMES_HOOK_REGISTRATION_VALIDATION_PY = String.raw`
import json
import sys

expected_command = sys.argv[1]
expected_matcher = sys.argv[2] or None
expected_timeout = int(sys.argv[3])

from hermes_cli.config import load_config
from agent.shell_hooks import register_from_config, reset_for_tests

cfg = load_config()
if cfg.get("hooks_auto_accept") is not True:
    raise AssertionError("hooks_auto_accept is not true")

reset_for_tests()
registered = register_from_config(cfg, accept_hooks=True)
matching = [
    spec for spec in registered
    if spec.event == "pre_tool_call"
    and spec.command == expected_command
    and spec.matcher == expected_matcher
    and int(spec.timeout) == expected_timeout
    and spec.matches_tool("terminal")
    and spec.matches_tool("execute_code")
    and not spec.matches_tool("write_file")
]
if len(matching) != 1:
    summary = [
        {"event": spec.event, "matcher": spec.matcher, "command": spec.command, "timeout": spec.timeout}
        for spec in registered
    ]
    raise AssertionError(f"expected exactly one registered generated command-policy hook, found {len(matching)} among {summary!r}")

print(json.dumps({"ok": True, "registered": len(registered)}))
`;

function agentCommandPolicyHookNodeExecArgv(cliPath: string): string[] {
  return shouldIncludeNodeExecArgv(cliPath) ? ["--import", resolveTsxImportSpecifier(cliPath)] : [];
}

function resolveTsxImportSpecifier(cliPath: string): string {
  try {
    const requireFromCli = createRequire(pathToFileURL(path.resolve(cliPath)));
    return pathToFileURL(requireFromCli.resolve("tsx")).href;
  } catch {
    return "tsx";
  }
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=+@%-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function nonEmptyString(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

import { promises as fs } from "node:fs";
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
  return [process.execPath, ...args].map(shellQuote).join(" ");
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

async function readYamlObject(filePath: string): Promise<Record<string, unknown>> {
  let raw = "";
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return {};
  }
  const parsed = YAML.parse(raw);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
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

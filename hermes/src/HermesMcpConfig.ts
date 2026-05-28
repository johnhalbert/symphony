import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { McpSubprocessServerConfig } from "../../src/core/harness/McpSubprocessEnvironment.js";

export interface HermesMcpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
  timeout: number;
  connect_timeout: number;
}

export type HermesMcpServersConfig = Record<string, HermesMcpServerConfig>;

export interface WriteHermesMcpConfigOptions {
  profileDir: string;
  servers: Record<string, McpSubprocessServerConfig>;
  timeoutSeconds?: number;
  connectTimeoutSeconds?: number;
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
    mcp_servers: mcpServers,
  };
  await fs.mkdir(options.profileDir, { recursive: true });
  await fs.writeFile(configPath, YAML.stringify(next), "utf8");
  return mcpServers;
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

import type { ServiceConfig } from "../config/Config.js";
import type { AgentRunRole } from "../types.js";

export type McpSubprocessCommand = "completion-report-mcp" | "review-verdict-mcp" | "review-feedback-mcp";

export interface McpCliSpawnArgsInput {
  cliPath: string;
  command: McpSubprocessCommand;
  workflowPath: string;
  contextFile: string;
  execArgv?: string[];
}

export interface McpSubprocessServerConfigInput extends McpSubprocessEnvironmentInput {
  cliPath: string;
  workflowPath: string;
  contextFile: string;
  execArgv?: string[];
}

export interface McpSubprocessServerConfig {
  type: "stdio";
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface McpSubprocessEnvironmentInput {
  config: ServiceConfig;
  command: McpSubprocessCommand;
  parentEnv?: NodeJS.ProcessEnv;
}

const RUNTIME_BASELINE_ENV_KEYS = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "NODE_OPTIONS",
  "NODE_PATH",
] as const;

const ENV_REFERENCE_PATTERN = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;

export function buildMcpSubprocessEnvironment(input: McpSubprocessEnvironmentInput): Record<string, string> {
  const parentEnv = input.parentEnv ?? process.env;
  const env: Record<string, string> = {};
  addRuntimeBaseline(env, parentEnv);
  addRequiredParseDependencies(env, input.config);
  addCommandCapabilitySlice(env, input.config, input.command);
  return env;
}

export function buildMcpCliSpawnArgs(input: McpCliSpawnArgsInput): string[] {
  const execArgv = shouldIncludeNodeExecArgv(input.cliPath) ? (input.execArgv ?? process.execArgv) : [];
  return [
    ...execArgv,
    input.cliPath,
    input.command,
    "--workflow",
    input.workflowPath,
    "--context-file",
    input.contextFile,
  ];
}

export function buildMcpSubprocessServerConfig(input: McpSubprocessServerConfigInput): McpSubprocessServerConfig {
  return {
    type: "stdio",
    command: process.execPath,
    args: buildMcpCliSpawnArgs(input),
    cwd: input.config.workflowDir,
    env: buildMcpSubprocessEnvironment(input),
  };
}

export function shouldIncludeNodeExecArgv(cliPath: string): boolean {
  return /\.(?:c|m)?tsx?$/i.test(cliPath);
}

function addRuntimeBaseline(env: Record<string, string>, parentEnv: NodeJS.ProcessEnv): void {
  for (const key of RUNTIME_BASELINE_ENV_KEYS) {
    addIfString(env, key, parentEnv[key]);
  }
}

function addRequiredParseDependencies(env: Record<string, string>, config: ServiceConfig): void {
  const raw = config.raw;
  const trackerApiKeyRef = envReference(raw.tracker?.api_key);
  if (trackerApiKeyRef) {
    env[trackerApiKeyRef] = config.tracker.apiKey;
  } else if (raw.tracker?.api_key === undefined) {
    env.LINEAR_API_KEY = config.tracker.apiKey;
  }

  const trackerProjectSlugRef = envReference(raw.tracker?.project_slug);
  if (trackerProjectSlugRef) env[trackerProjectSlugRef] = config.tracker.projectSlug;

  const trackerAssigneeRef = envReference(raw.tracker?.assignee);
  if (trackerAssigneeRef) env[trackerAssigneeRef] = config.tracker.assignee ?? "";

  const workspaceRootRef = envReference(raw.workspace?.root);
  if (workspaceRootRef) env[workspaceRootRef] = config.workspace.root;

  const workspaceStateDirRef = envReference(raw.workspace?.state_dir);
  if (workspaceStateDirRef) env[workspaceStateDirRef] = config.workspace.stateDir;

  const sourcePathRef = envReference(raw.workspace?.source?.path);
  if (sourcePathRef) env[sourcePathRef] = config.workspace.source.path ?? "";

  const sourceRepositoryRef = envReference(raw.workspace?.source?.repository);
  if (sourceRepositoryRef) env[sourceRepositoryRef] = config.workspace.source.repository ?? "";

  const sourceCachePathRef = envReference(raw.workspace?.source?.cache_path);
  if (sourceCachePathRef) env[sourceCachePathRef] = config.workspace.source.cachePath ?? "";
}

function addCommandCapabilitySlice(
  env: Record<string, string>,
  config: ServiceConfig,
  command: McpSubprocessCommand,
): void {
  if (command === "completion-report-mcp" && config.github.publishPullRequests) {
    addGitHubParseRefs(env, config);
    addGitHubCapabilityEnvironment(env, config, "worker", "github.publication");
  }
  if (command === "review-feedback-mcp") {
    addGitHubParseRefs(env, config);
    addGitHubCapabilityEnvironment(env, config, "reviewer", "github.review_feedback_write");
  }
}

function addGitHubParseRefs(env: Record<string, string>, config: ServiceConfig): void {
  const rawGithub = config.raw.github;

  const ownerRef = envReference(rawGithub?.owner);
  if (ownerRef) env[ownerRef] = config.github.owner ?? "";

  const repoRef = envReference(rawGithub?.repo);
  if (repoRef) env[repoRef] = config.github.repo ?? "";

  const headOwnerRef = envReference(rawGithub?.head_owner);
  if (headOwnerRef) env[headOwnerRef] = config.github.headOwner ?? "";

  const apiBaseUrlRef = envReference(rawGithub?.api_base_url);
  if (apiBaseUrlRef) env[apiBaseUrlRef] = config.github.apiBaseUrl;
}

function addGitHubCapabilityEnvironment(
  env: Record<string, string>,
  config: ServiceConfig,
  role: AgentRunRole,
  capability: "github.publication" | "github.review_feedback_write",
): void {
  if (config.credentialProfiles.hasAssignment(role, capability)) {
    const credential = config.credentialProfiles.resolveForRole(role, capability);
    const profileName = credential?.profileName;
    const serialized = config.credentialProfiles.toJSON();
    const envVar = profileName === undefined || profileName === null ? undefined : serialized.profiles[profileName]?.source.name;
    if (envVar === undefined || credential?.source !== "profile") {
      throw new Error(`${role} ${capability} profile assignment could not be resolved`);
    }
    env[envVar] = credential.value;
    return;
  }

  const rawGithubToken = config.raw.github?.token;
  const rawGithubTokenRef = envReference(rawGithubToken);
  if (rawGithubTokenRef) {
    env[rawGithubTokenRef] = config.github.token ?? "";
    return;
  }

  if (typeof rawGithubToken === "string" && rawGithubToken.trim().length > 0) {
    return;
  }

  env.GITHUB_TOKEN = config.github.token ?? "";
}

function envReference(value: string | undefined): string | null {
  if (value === undefined) return null;
  return ENV_REFERENCE_PATTERN.exec(value)?.[1] ?? null;
}

function addIfString(env: Record<string, string>, key: string, value: string | undefined): void {
  if (typeof value === "string") env[key] = value;
}

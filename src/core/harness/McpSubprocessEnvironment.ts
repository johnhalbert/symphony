import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import {
  resolveProjectContextIdForConfig,
  serviceConfigForProjectContext,
  type GitHubAppConfig,
  type ServiceConfig,
} from "../config/Config.js";
import type { CredentialRole } from "../config/CredentialProfiles.js";
import { normalizeProjectContextId } from "../config/ProjectContexts.js";

export type McpSubprocessCommand =
  | "completion-report-mcp"
  | "merge-conflict-resolution-mcp"
  | "issue-breakdown-plan-mcp"
  | "operator-chat-mcp"
  | "review-verdict-mcp"
  | "review-feedback-mcp"
  | "transcript-recall-mcp";

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
  projectContextId?: string | null | undefined;
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
  "SYMPHONY_MCP_TRACE_FILE",
] as const;

const ENV_REFERENCE_PATTERN = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;

export function buildMcpSubprocessEnvironment(input: McpSubprocessEnvironmentInput): Record<string, string> {
  const parentEnv = input.parentEnv ?? process.env;
  const env: Record<string, string> = {};
  addRuntimeBaseline(env, parentEnv);
  addRequiredParseDependencies(env, input.config);
  addCommandCapabilitySlice(env, input.config, input.command, parentEnv, input.projectContextId);
  return env;
}

export function buildMcpCliSpawnArgs(input: McpCliSpawnArgsInput): string[] {
  const execArgv = shouldIncludeNodeExecArgv(input.cliPath) ? (input.execArgv ?? defaultNodeExecArgv(input.cliPath)) : [];
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

function defaultNodeExecArgv(cliPath: string): string[] {
  return ["--import", resolveTsxImportSpecifier(cliPath)];
}

function resolveTsxImportSpecifier(cliPath: string): string {
  try {
    const requireFromCli = createRequire(pathToFileURL(path.resolve(cliPath)));
    const resolved = requireFromCli.resolve("tsx");
    return pathToFileURL(resolved).href;
  } catch {
    return "tsx";
  }
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

  addWorkspaceParseRefs(env, raw.workspace, config.workspace);
  for (const rawContext of raw.project_contexts ?? []) {
    if (rawContext.enabled === false) continue;
    const context = config.projectContexts.byId.get(normalizeProjectContextId(rawContext.id));
    if (!context) continue;
    addWorkspaceParseRefs(env, rawContext.workspace, context.workspace);
  }
}

function addWorkspaceParseRefs(
  env: Record<string, string>,
  rawWorkspace: ServiceConfig["raw"]["workspace"] | undefined,
  workspace: ServiceConfig["workspace"],
): void {
  const workspaceRootRef = envReference(rawWorkspace?.root);
  if (workspaceRootRef) env[workspaceRootRef] = workspace.root;

  const workspaceStateDirRef = envReference(rawWorkspace?.state_dir);
  if (workspaceStateDirRef) env[workspaceStateDirRef] = workspace.stateDir;

  const sourcePathRef = envReference(rawWorkspace?.source?.path);
  if (sourcePathRef) env[sourcePathRef] = workspace.source.path ?? "";

  const sourceRepositoryRef = envReference(rawWorkspace?.source?.repository);
  if (sourceRepositoryRef) env[sourceRepositoryRef] = workspace.source.repository ?? "";

  const sourceBaseRefRef = envReference(rawWorkspace?.source?.base_ref);
  if (sourceBaseRefRef) env[sourceBaseRefRef] = workspace.source.baseRef ?? "";

  const sourceCachePathRef = envReference(rawWorkspace?.source?.cache_path);
  if (sourceCachePathRef) env[sourceCachePathRef] = workspace.source.cachePath ?? "";
}

function addCommandCapabilitySlice(
  env: Record<string, string>,
  config: ServiceConfig,
  command: McpSubprocessCommand,
  parentEnv: NodeJS.ProcessEnv,
  projectContextId?: string | null,
): void {
  const contextualConfig = serviceConfigForProjectContext(config, projectContextId);
  if (command === "completion-report-mcp" && contextualConfig.github.publishPullRequests) {
    addGitHubParseRefs(env, config, projectContextId);
    if (!(contextualConfig.github.operatorApproval?.requiredForPublication ?? false)) {
      addGitHubCapabilityEnvironment(env, config, parentEnv, "service", "github.publication", projectContextId);
    }
  }
  if (command === "review-feedback-mcp") {
    addGitHubParseRefs(env, config, projectContextId);
    addGitHubCapabilityEnvironment(env, config, parentEnv, "reviewer", "github.review_feedback_write", projectContextId);
  }
}

function addGitHubParseRefs(
  env: Record<string, string>,
  config: ServiceConfig,
  projectContextId?: string | null,
): void {
  const resolvedProjectContextId = resolveProjectContextIdForConfig(config, projectContextId);
  const contextualConfig = serviceConfigForProjectContext(config, resolvedProjectContextId);
  const rawGithub = rawGitHubConfigForProjectContext(config, resolvedProjectContextId);

  const ownerRef = envReference(rawGithub?.owner);
  if (ownerRef) env[ownerRef] = contextualConfig.github.owner ?? "";

  const repoRef = envReference(rawGithub?.repo);
  if (repoRef) env[repoRef] = contextualConfig.github.repo ?? "";

  const headOwnerRef = envReference(rawGithub?.head_owner);
  if (headOwnerRef) env[headOwnerRef] = contextualConfig.github.headOwner ?? "";

  const apiBaseUrlRef = envReference(rawGithub?.api_base_url);
  if (apiBaseUrlRef) env[apiBaseUrlRef] = contextualConfig.github.apiBaseUrl;
}

function addGitHubCapabilityEnvironment(
  env: Record<string, string>,
  config: ServiceConfig,
  parentEnv: NodeJS.ProcessEnv,
  role: CredentialRole,
  capability: "github.publication" | "github.review_feedback_write",
  projectContextId?: string | null,
): void {
  const resolvedProjectContextId = resolveProjectContextIdForConfig(config, projectContextId);
  const contextualConfig = serviceConfigForProjectContext(config, resolvedProjectContextId);
  const rawGithub = rawGitHubConfigForProjectContext(config, resolvedProjectContextId);

  if (contextualConfig.credentialProfiles.hasAssignment(role, capability, resolvedProjectContextId)) {
    const profile = contextualConfig.credentialProfiles.profileForRole(role, capability, resolvedProjectContextId);
    const credential = contextualConfig.credentialProfiles.resolveForRole(role, capability, resolvedProjectContextId);
    if (profile === null || credential?.source !== "profile") {
      throw new Error(`${role} ${capability} profile assignment could not be resolved`);
    }
    if (profile.kind === "github_app") {
      const rawProfile = config.raw.credential_profiles?.profiles?.[profile.name];
      if (rawProfile?.kind !== "github_app") {
        throw new Error(`${role} ${capability} GitHub App profile assignment could not be resolved`);
      }
      addGitHubAppProfileCapabilityEnvironment(env, profile.app, rawProfile, parentEnv);
      return;
    }
    if (credential.kind !== "static_token") {
      throw new Error(`${role} ${capability} static profile assignment could not be resolved`);
    }
    env[profile.envVar] = credential.value;
    return;
  }

  if (contextualConfig.github.app !== null) {
    addGitHubAppCapabilityEnvironment(env, contextualConfig.github.app, rawGithub?.app, parentEnv);
    return;
  }

  const rawGithubToken = rawGithub?.token;
  const rawGithubTokenRef = envReference(rawGithubToken);
  if (rawGithubTokenRef) {
    env[rawGithubTokenRef] = contextualConfig.github.token ?? "";
    if (contextualConfig.github.token !== null) return;
    addGitHubAppCapabilityEnvironment(env, contextualConfig.github.app, rawGithub?.app, parentEnv);
    return;
  }

  if (typeof rawGithubToken === "string" && rawGithubToken.trim().length > 0) {
    return;
  }

  if (contextualConfig.github.token !== null) {
    env.GITHUB_TOKEN = contextualConfig.github.token;
  }
}

function rawProjectContextForResolvedId(config: ServiceConfig, resolvedProjectContextId: string) {
  return (config.raw.project_contexts ?? []).find(
    (rawContext) => normalizeProjectContextId(rawContext.id) === resolvedProjectContextId,
  );
}

function rawGitHubConfigForProjectContext(config: ServiceConfig, resolvedProjectContextId: string) {
  const rawContext = rawProjectContextForResolvedId(config, resolvedProjectContextId);
  if (config.raw.github === undefined && rawContext?.github === undefined) return undefined;
  return {
    ...(config.raw.github ?? {}),
    ...(rawContext?.github ?? {}),
  };
}

interface RawGitHubAppEnvironmentSource {
  app_id?: string | undefined;
  client_id?: string | undefined;
  installation_id?: string | undefined;
  private_key?: string | undefined;
  private_key_path?: string | undefined;
}

function addGitHubAppProfileCapabilityEnvironment(
  env: Record<string, string>,
  app: GitHubAppConfig,
  rawApp: RawGitHubAppEnvironmentSource,
  parentEnv: NodeJS.ProcessEnv,
): void {
  addGitHubAppStringEnvironment(env, rawApp.app_id, "GITHUB_APP_ID", app.appId);
  addGitHubAppStringEnvironment(env, rawApp.client_id, "GITHUB_APP_CLIENT_ID", app.clientId);
  addGitHubAppStringEnvironment(env, rawApp.installation_id, "GITHUB_APP_INSTALLATION_ID", app.installationId);
  addGitHubAppPrivateKeyEnvironment(env, rawApp.private_key, app.privateKeyEnvVar, parentEnv);
  addGitHubAppStringEnvironment(env, rawApp.private_key_path, "GITHUB_APP_PRIVATE_KEY_PATH", app.privateKeyPath);
}

function addGitHubAppCapabilityEnvironment(
  env: Record<string, string>,
  app: GitHubAppConfig | null,
  rawApp: RawGitHubAppEnvironmentSource | undefined,
  parentEnv: NodeJS.ProcessEnv,
): void {
  if (app === null) return;

  addGitHubAppStringEnvironment(env, rawApp?.app_id, "GITHUB_APP_ID", app.appId);
  addGitHubAppStringEnvironment(env, rawApp?.client_id, "GITHUB_APP_CLIENT_ID", app.clientId);
  addGitHubAppStringEnvironment(env, rawApp?.installation_id, "GITHUB_APP_INSTALLATION_ID", app.installationId);
  addGitHubAppPrivateKeyEnvironment(env, rawApp?.private_key, app.privateKeyEnvVar, parentEnv);
  addGitHubAppStringEnvironment(env, rawApp?.private_key_path, "GITHUB_APP_PRIVATE_KEY_PATH", app.privateKeyPath);
}

function addGitHubAppStringEnvironment(
  env: Record<string, string>,
  rawValue: string | undefined,
  defaultEnvVar: string,
  normalizedValue: string | null,
): void {
  const explicitRef = envReference(rawValue);
  if (explicitRef) {
    env[explicitRef] = normalizedValue ?? "";
    return;
  }

  if (rawValue === undefined && normalizedValue !== null) {
    env[defaultEnvVar] = normalizedValue;
  }
}

function addGitHubAppPrivateKeyEnvironment(
  env: Record<string, string>,
  rawValue: string | undefined,
  privateKeyEnvVar: string | null,
  parentEnv: NodeJS.ProcessEnv,
): void {
  const explicitRef = envReference(rawValue);
  if (explicitRef) {
    env[explicitRef] = parentEnv[explicitRef] ?? "";
    return;
  }

  if (rawValue !== undefined) return;

  if (privateKeyEnvVar !== null) {
    env[privateKeyEnvVar] = parentEnv[privateKeyEnvVar] ?? "";
    return;
  }

  if (Object.prototype.hasOwnProperty.call(parentEnv, "GITHUB_APP_PRIVATE_KEY")) {
    env.GITHUB_APP_PRIVATE_KEY = parentEnv.GITHUB_APP_PRIVATE_KEY ?? "";
  }
}

function envReference(value: string | undefined): string | null {
  if (value === undefined) return null;
  return ENV_REFERENCE_PATTERN.exec(value)?.[1] ?? null;
}

function addIfString(env: Record<string, string>, key: string, value: string | undefined): void {
  if (typeof value === "string") env[key] = value;
}

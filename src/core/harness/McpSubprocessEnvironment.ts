import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import {
  resolveDefaultProjectContextCredentialProfiles,
  type GitHubAppConfig,
  type ServiceConfig,
} from "../config/Config.js";
import type { CredentialRole } from "../config/CredentialProfiles.js";

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
  addRequiredParseDependencies(env, input.config, parentEnv);
  addCommandCapabilitySlice(env, input.config, input.command, parentEnv);
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

function addRequiredParseDependencies(
  env: Record<string, string>,
  config: ServiceConfig,
  parentEnv: NodeJS.ProcessEnv,
): void {
  const raw = config.raw;
  addTrackerParseDependencies(env, raw.tracker, config.tracker, { includeDefaultApiKeyFallback: true });
  addWorkspaceParseDependencies(env, raw.workspace, config.workspace);

  if (projectContextsNeedDefaultGitHubParseDependencies(raw)) {
    addGitHubParseDependenciesFromParentEnv(env, raw.github, parentEnv);
  }

  const rawProjectContexts = raw.project_contexts ?? [];
  for (const [index, rawContext] of rawProjectContexts.entries()) {
    const context = config.projectContexts.contexts[index];
    if (!context) continue;
    addTrackerParseDependencies(env, rawContext.tracker, context.tracker);
    addWorkspaceParseDependencies(env, rawContext.workspace, context.workspace);
    addGitHubParseDependencies(env, rawContext.github, context.github);
  }
}

function addTrackerParseDependencies(
  env: Record<string, string>,
  rawTracker:
    | {
        api_key?: string | undefined;
        project_slug?: string | undefined;
        assignee?: string | undefined;
      }
    | undefined,
  tracker: {
    apiKey: string;
    projectSlug: string;
    assignee?: string | null;
  },
  options: { includeDefaultApiKeyFallback?: boolean } = {},
): void {
  const trackerApiKeyRef = envReference(rawTracker?.api_key);
  if (trackerApiKeyRef) {
    env[trackerApiKeyRef] = tracker.apiKey;
  } else if (options.includeDefaultApiKeyFallback && rawTracker?.api_key === undefined) {
    env.LINEAR_API_KEY = tracker.apiKey;
  }

  const trackerProjectSlugRef = envReference(rawTracker?.project_slug);
  if (trackerProjectSlugRef) env[trackerProjectSlugRef] = tracker.projectSlug;

  const trackerAssigneeRef = envReference(rawTracker?.assignee);
  if (trackerAssigneeRef) env[trackerAssigneeRef] = tracker.assignee ?? "";
}

function addWorkspaceParseDependencies(
  env: Record<string, string>,
  rawWorkspace:
    | {
        root?: string | undefined;
        state_dir?: string | undefined;
        source?: {
          path?: string | undefined;
          repository?: string | undefined;
          cache_path?: string | undefined;
        } | undefined;
      }
    | undefined,
  workspace: {
    root: string;
    stateDir: string;
    source: {
      path?: string;
      repository?: string;
      cachePath?: string;
    };
  },
): void {
  const workspaceRootRef = envReference(rawWorkspace?.root);
  if (workspaceRootRef) env[workspaceRootRef] = workspace.root;

  const workspaceStateDirRef = envReference(rawWorkspace?.state_dir);
  if (workspaceStateDirRef) env[workspaceStateDirRef] = workspace.stateDir;

  const sourcePathRef = envReference(rawWorkspace?.source?.path);
  if (sourcePathRef) env[sourcePathRef] = workspace.source.path ?? "";

  const sourceRepositoryRef = envReference(rawWorkspace?.source?.repository);
  if (sourceRepositoryRef) env[sourceRepositoryRef] = workspace.source.repository ?? "";

  const sourceCachePathRef = envReference(rawWorkspace?.source?.cache_path);
  if (sourceCachePathRef) env[sourceCachePathRef] = workspace.source.cachePath ?? "";
}

function addGitHubParseDependencies(
  env: Record<string, string>,
  rawGithub:
    | {
        owner?: string | undefined;
        repo?: string | undefined;
        head_owner?: string | undefined;
        api_base_url?: string | undefined;
      }
    | undefined,
  github: {
    owner: string | null;
    repo: string | null;
    headOwner: string | null;
    apiBaseUrl: string;
  },
): void {
  const ownerRef = envReference(rawGithub?.owner);
  if (ownerRef) env[ownerRef] = github.owner ?? "";

  const repoRef = envReference(rawGithub?.repo);
  if (repoRef) env[repoRef] = github.repo ?? "";

  const headOwnerRef = envReference(rawGithub?.head_owner);
  if (headOwnerRef) env[headOwnerRef] = github.headOwner ?? "";

  const apiBaseUrlRef = envReference(rawGithub?.api_base_url);
  if (apiBaseUrlRef) env[apiBaseUrlRef] = github.apiBaseUrl;
}

function addGitHubParseDependenciesFromParentEnv(
  env: Record<string, string>,
  rawGithub:
    | {
        owner?: string | undefined;
        repo?: string | undefined;
        head_owner?: string | undefined;
        api_base_url?: string | undefined;
      }
    | undefined,
  parentEnv: NodeJS.ProcessEnv,
): void {
  addEnvReferenceFromParentEnv(env, parentEnv, rawGithub?.owner);
  addEnvReferenceFromParentEnv(env, parentEnv, rawGithub?.repo);
  addEnvReferenceFromParentEnv(env, parentEnv, rawGithub?.head_owner);
  addEnvReferenceFromParentEnv(env, parentEnv, rawGithub?.api_base_url);
}

function projectContextsNeedDefaultGitHubParseDependencies(raw: ServiceConfig["raw"]): boolean {
  const defaultGithub = raw.github;
  const rawProjectContexts = raw.project_contexts ?? [];
  return rawProjectContexts.some(
    (rawContext) =>
      needsInheritedGitHubParseDependency(defaultGithub?.owner, rawContext.github?.owner) ||
      needsInheritedGitHubParseDependency(defaultGithub?.repo, rawContext.github?.repo) ||
      needsInheritedGitHubParseDependency(defaultGithub?.head_owner, rawContext.github?.head_owner) ||
      needsInheritedGitHubParseDependency(defaultGithub?.api_base_url, rawContext.github?.api_base_url),
  );
}

function needsInheritedGitHubParseDependency(defaultValue: string | undefined, contextValue: string | undefined): boolean {
  return envReference(defaultValue) !== null && contextValue === undefined;
}

function addCommandCapabilitySlice(
  env: Record<string, string>,
  config: ServiceConfig,
  command: McpSubprocessCommand,
  parentEnv: NodeJS.ProcessEnv,
): void {
  if (command === "completion-report-mcp" && config.github.publishPullRequests) {
    addGitHubParseRefs(env, config);
    if (!(config.github.operatorApproval?.requiredForPublication ?? false)) {
      addGitHubCapabilityEnvironment(env, config, parentEnv, "service", "github.publication");
    }
  }
  if (command === "review-feedback-mcp") {
    addGitHubParseRefs(env, config);
    addGitHubCapabilityEnvironment(env, config, parentEnv, "reviewer", "github.review_feedback_write");
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
  parentEnv: NodeJS.ProcessEnv,
  role: CredentialRole,
  capability: "github.publication" | "github.review_feedback_write",
): void {
  if (config.credentialProfiles.hasAssignment(role, capability)) {
    const profile = config.credentialProfiles.profileForRole(role, capability);
    const credential = config.credentialProfiles.resolveForRole(role, capability);
    if (profile === null || credential?.source !== "profile") {
      throw new Error(`${role} ${capability} profile assignment could not be resolved`);
    }
    if (profile.kind === "github_app") {
      const rawProfile = resolveDefaultProjectContextCredentialProfiles(
        config.raw,
        config.projectContexts.defaultContextId,
      )?.profiles?.[profile.name];
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

  if (config.github.app !== null) {
    addGitHubAppCapabilityEnvironment(env, config, parentEnv);
    return;
  }

  const rawGithubToken = config.raw.github?.token;
  const rawGithubTokenRef = envReference(rawGithubToken);
  if (rawGithubTokenRef) {
    env[rawGithubTokenRef] = config.github.token ?? "";
    if (config.github.token !== null) return;
    addGitHubAppCapabilityEnvironment(env, config, parentEnv);
    return;
  }

  if (typeof rawGithubToken === "string" && rawGithubToken.trim().length > 0) {
    return;
  }

  if (config.github.token !== null) {
    env.GITHUB_TOKEN = config.github.token;
  }
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
  config: ServiceConfig,
  parentEnv: NodeJS.ProcessEnv,
): void {
  const app = config.github.app;
  if (app === null) return;

  const rawApp = config.raw.github?.app;
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

function addEnvReferenceFromParentEnv(
  env: Record<string, string>,
  parentEnv: NodeJS.ProcessEnv,
  rawValue: string | undefined,
): void {
  const ref = envReference(rawValue);
  if (ref) env[ref] = parentEnv[ref] ?? "";
}

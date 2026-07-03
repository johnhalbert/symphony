import type { ServiceConfig, GitHubConfig, WorkflowProjectContext } from "../../core/config/Config.js";
import {
  resolveProjectContextCredentialView,
  type ProjectContextCredentialResolutionOptions,
} from "../../core/config/ProjectContextCredentialView.js";
import type { CredentialCapability, CredentialRole, ResolvedCredential } from "../../core/config/CredentialProfiles.js";
import { SymphonyError } from "../../core/errors.js";
import { GitHubAppInstallationTokenProvider } from "./GitHubAppInstallationTokenProvider.js";
import { GitHubPullRequestClient, type GitHubAuthTokenProvider } from "./GitHubPullRequestClient.js";

type FetchLike = typeof fetch;

export type GitHubCredentialCapability = Extract<CredentialCapability, `github.${string}`>;

export const GITHUB_CREDENTIAL_CAPABILITY_OWNERS: Readonly<Record<GitHubCredentialCapability, CredentialRole>> = {
  "github.discovery": "worker",
  "github.publication": "service",
  "github.review_evidence_read": "reviewer",
  "github.review_feedback_write": "reviewer",
  "github.merge": "service",
};

export interface ResolvedGitHubClientConfig {
  capability: GitHubCredentialCapability;
  role: CredentialRole;
  projectContextId: string;
  projectContextLabel: string;
  github: GitHubConfig;
  credential: ResolvedCredential | null;
  projectContext: WorkflowProjectContext;
}

export function resolveGitHubClientConfig(
  config: ServiceConfig,
  capability: GitHubCredentialCapability,
  options: ProjectContextCredentialResolutionOptions = {},
): ResolvedGitHubClientConfig {
  const view = resolveProjectContextCredentialView({
    config,
    projectContext: options.projectContext,
    env: options.env,
  });
  const role = GITHUB_CREDENTIAL_CAPABILITY_OWNERS[capability];
  if (!role) {
    throw new SymphonyError("config_validation_error", `Unsupported GitHub credential capability: ${capability}`);
  }

  const assignedRoles = view.credentialProfiles.assignmentRolesFor(capability);
  if (!view.credentialProfiles.hasAssignment(role, capability) && assignedRoles.length > 0) {
    throw new SymphonyError(
      "config_validation_error",
      `GitHub credential capability ${capability} is owned by ${role}, but is assigned only to ${assignedRoles.join(
        ", ",
      )}. Configure credential_profiles.roles.${role}.${capability} or remove the non-owning assignment to use legacy github.token/GITHUB_TOKEN.`,
    );
  }

  const credential = view.credentialProfiles.resolveForRole(role, capability);
  if (credential?.source === "profile" && credential.kind === "github_app") {
    return {
      capability,
      role,
      projectContextId: view.projectContextId,
      projectContextLabel: view.projectContext.label,
      github: {
        ...view.github,
        token: null,
        app: credential.app,
      },
      credential,
      projectContext: view.projectContext,
    };
  }

  const selectedStaticCredential = shouldUseGitHubAppByDefault(view.github, capability, credential) ? null : credential;
  return {
    capability,
    role,
    projectContextId: view.projectContextId,
    projectContextLabel: view.projectContext.label,
    github: {
      ...view.github,
      token: selectedStaticCredential?.value ?? null,
    },
    credential: selectedStaticCredential,
    projectContext: view.projectContext,
  };
}

export function resolveGitHubClientConfigForProjectContext(
  config: ServiceConfig,
  capability: GitHubCredentialCapability,
  projectContext?: ProjectContextCredentialResolutionOptions["projectContext"],
): ResolvedGitHubClientConfig {
  return resolveGitHubClientConfig(config, capability, { projectContext });
}

export function createGitHubPullRequestClientForCapability(
  config: ServiceConfig,
  capability: GitHubCredentialCapability,
  fetchImpl?: FetchLike,
  options: ProjectContextCredentialResolutionOptions = {},
): GitHubPullRequestClient {
  const resolved = resolveGitHubClientConfig(config, capability, options);
  return new GitHubPullRequestClient(
    resolved.github,
    fetchImpl,
    createGitHubAuthTokenProvider(resolved.github, fetchImpl),
  );
}

export function createGitHubPullRequestClientForProjectContext(
  config: ServiceConfig,
  capability: GitHubCredentialCapability,
  projectContext: ProjectContextCredentialResolutionOptions["projectContext"],
  fetchImpl?: FetchLike,
): GitHubPullRequestClient {
  return createGitHubPullRequestClientForCapability(config, capability, fetchImpl, { projectContext });
}

export function resolveGitHubProjectContext(
  config: ServiceConfig,
  projectContext?: ProjectContextCredentialResolutionOptions["projectContext"],
): WorkflowProjectContext {
  return resolveProjectContextCredentialView({ config, projectContext }).projectContext;
}

function createGitHubAuthTokenProvider(
  github: GitHubConfig,
  fetchImpl?: FetchLike,
): GitHubAuthTokenProvider | null {
  if (github.app === null) return null;
  return new GitHubAppInstallationTokenProvider(github.app, github.apiBaseUrl, fetchImpl);
}

function shouldUseGitHubAppByDefault(
  github: GitHubConfig,
  capability: GitHubCredentialCapability,
  credential: ResolvedCredential | null,
): boolean {
  if (github.app === null || credential?.source !== "legacy") return false;
  return (
    capability === "github.publication" ||
    capability === "github.review_feedback_write" ||
    capability === "github.merge"
  );
}

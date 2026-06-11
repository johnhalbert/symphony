import type { ServiceConfig, GitHubConfig } from "../../core/config/Config.js";
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
  github: GitHubConfig;
  credential: ResolvedCredential | null;
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
      github: {
        ...view.github,
        token: null,
        app: credential.app,
      },
      credential,
    };
  }

  const selectedStaticCredential = shouldUseGitHubAppByDefault(view.github, capability, credential) ? null : credential;
  return {
    capability,
    role,
    github: {
      ...view.github,
      token: selectedStaticCredential?.value ?? null,
    },
    credential: selectedStaticCredential,
  };
}

export function createGitHubPullRequestClientForCapability(
  config: ServiceConfig,
  capability: GitHubCredentialCapability,
  fetchImpl?: FetchLike,
  options: ProjectContextCredentialResolutionOptions = {},
): GitHubPullRequestClient {
  const resolved = resolveGitHubClientConfig(config, capability, options).github;
  return new GitHubPullRequestClient(resolved, fetchImpl, createGitHubAuthTokenProvider(resolved, fetchImpl));
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

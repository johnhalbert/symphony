import {
  resolveProjectContextIdForConfig,
  serviceConfigForProjectContext,
  type GitHubConfig,
  type ServiceConfig,
} from "../../core/config/Config.js";
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
  projectContextId?: string | null,
): ResolvedGitHubClientConfig {
  const role = GITHUB_CREDENTIAL_CAPABILITY_OWNERS[capability];
  if (!role) {
    throw new SymphonyError("config_validation_error", `Unsupported GitHub credential capability: ${capability}`);
  }

  const resolvedProjectContextId = resolveProjectContextIdForConfig(config, projectContextId);
  const contextualConfig = serviceConfigForProjectContext(config, resolvedProjectContextId);
  const assignedRoles = contextualConfig.credentialProfiles.assignmentRolesFor(capability, resolvedProjectContextId);
  if (!contextualConfig.credentialProfiles.hasAssignment(role, capability, resolvedProjectContextId) && assignedRoles.length > 0) {
    throw new SymphonyError(
      "config_validation_error",
      `GitHub credential capability ${capability} is owned by ${role}, but is assigned only to ${assignedRoles.join(
        ", ",
      )}. Configure credential_profiles.roles.${role}.${capability} or remove the non-owning assignment to use legacy github.token/GITHUB_TOKEN.`,
    );
  }

  const credential = contextualConfig.credentialProfiles.resolveForRole(role, capability, resolvedProjectContextId);
  if (credential?.source === "profile" && credential.kind === "github_app") {
    return {
      capability,
      role,
      github: {
        ...contextualConfig.github,
        token: null,
        app: credential.app,
      },
      credential,
    };
  }

  const selectedStaticCredential = shouldUseGitHubAppByDefault(contextualConfig.github, capability, credential)
    ? null
    : credential;
  return {
    capability,
    role,
    github: {
      ...contextualConfig.github,
      token: selectedStaticCredential?.value ?? null,
    },
    credential: selectedStaticCredential,
  };
}

export function createGitHubPullRequestClientForCapability(
  config: ServiceConfig,
  capability: GitHubCredentialCapability,
  fetchImpl?: FetchLike,
  projectContextId?: string | null,
): GitHubPullRequestClient {
  const resolved = resolveGitHubClientConfig(config, capability, projectContextId).github;
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

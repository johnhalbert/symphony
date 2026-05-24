import type { ServiceConfig, GitHubConfig } from "../../core/config/Config.js";
import type { CredentialCapability, CredentialRole, ResolvedCredential } from "../../core/config/CredentialProfiles.js";
import { SymphonyError } from "../../core/errors.js";
import { GitHubPullRequestClient } from "./GitHubPullRequestClient.js";

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
): ResolvedGitHubClientConfig {
  const role = GITHUB_CREDENTIAL_CAPABILITY_OWNERS[capability];
  if (!role) {
    throw new SymphonyError("config_validation_error", `Unsupported GitHub credential capability: ${capability}`);
  }

  const assignedRoles = config.credentialProfiles.assignmentRolesFor(capability);
  if (!config.credentialProfiles.hasAssignment(role, capability) && assignedRoles.length > 0) {
    throw new SymphonyError(
      "config_validation_error",
      `GitHub credential capability ${capability} is owned by ${role}, but is assigned only to ${assignedRoles.join(
        ", ",
      )}. Configure credential_profiles.roles.${role}.${capability} or remove the non-owning assignment to use legacy github.token/GITHUB_TOKEN.`,
    );
  }

  const credential = config.credentialProfiles.resolveForRole(role, capability);
  return {
    capability,
    role,
    github: {
      ...config.github,
      token: credential?.value ?? null,
    },
    credential,
  };
}

export function createGitHubPullRequestClientForCapability(
  config: ServiceConfig,
  capability: GitHubCredentialCapability,
  fetchImpl?: FetchLike,
): GitHubPullRequestClient {
  return new GitHubPullRequestClient(resolveGitHubClientConfig(config, capability).github, fetchImpl);
}

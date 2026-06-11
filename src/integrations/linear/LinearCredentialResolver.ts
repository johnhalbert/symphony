import type { ServiceConfig, TrackerConfig } from "../../core/config/Config.js";
import {
  resolveProjectContextCredentialView,
  type ProjectContextCredentialResolutionOptions,
} from "../../core/config/ProjectContextCredentialView.js";
import type { CredentialCapability, CredentialRole, ResolvedCredential } from "../../core/config/CredentialProfiles.js";
import { SymphonyError } from "../../core/errors.js";
import { LinearTrackerClient } from "./LinearTrackerClient.js";

type FetchLike = typeof fetch;

export type LinearCredentialCapability = Extract<CredentialCapability, `linear.${string}`>;

export const LINEAR_CREDENTIAL_CAPABILITY_OWNERS: Readonly<Record<LinearCredentialCapability, CredentialRole>> = {
  "linear.tracker": "worker",
  "linear.writeback": "service",
};

export interface ResolvedLinearClientConfig {
  capability: LinearCredentialCapability;
  role: CredentialRole;
  tracker: TrackerConfig;
  credential: ResolvedCredential | null;
}

export function resolveLinearClientConfig(
  config: ServiceConfig,
  capability: LinearCredentialCapability,
  options: ProjectContextCredentialResolutionOptions = {},
): ResolvedLinearClientConfig {
  const view = resolveProjectContextCredentialView({
    config,
    projectContext: options.projectContext,
    env: options.env,
  });
  const role = LINEAR_CREDENTIAL_CAPABILITY_OWNERS[capability];
  if (!role) {
    throw new SymphonyError("config_validation_error", `Unsupported Linear credential capability: ${capability}`);
  }

  const assignedRoles = view.credentialProfiles.assignmentRolesFor(capability);
  if (!view.credentialProfiles.hasAssignment(role, capability) && assignedRoles.length > 0) {
    throw new SymphonyError(
      "config_validation_error",
      `Linear credential capability ${capability} is owned by ${role}, but is assigned only to ${assignedRoles.join(
        ", ",
      )}. Configure credential_profiles.roles.${role}.${capability} or remove the non-owning assignment to use legacy tracker api key/LINEAR_API_KEY.`,
    );
  }

  const credential = view.credentialProfiles.resolveForRole(role, capability);
  return {
    capability,
    role,
    tracker: {
      ...view.tracker,
      apiKey: credential?.value ?? view.tracker.apiKey,
    },
    credential,
  };
}

export function createLinearTrackerClientForCapability(
  config: ServiceConfig,
  capability: LinearCredentialCapability,
  fetchImpl?: FetchLike,
  options: ProjectContextCredentialResolutionOptions = {},
): LinearTrackerClient {
  return new LinearTrackerClient(resolveLinearClientConfig(config, capability, options).tracker, fetchImpl);
}

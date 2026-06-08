import type { ServiceConfig, TrackerConfig } from "../../core/config/Config.js";
import type { CredentialCapability, CredentialRole, ResolvedCredential } from "../../core/config/CredentialProfiles.js";
import { SymphonyError } from "../../core/errors.js";
import { LinearTrackerClient } from "./LinearTrackerClient.js";
import { MultiProjectLinearTrackerClient } from "./MultiProjectLinearTrackerClient.js";

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
): ResolvedLinearClientConfig {
  const role = LINEAR_CREDENTIAL_CAPABILITY_OWNERS[capability];
  if (!role) {
    throw new SymphonyError("config_validation_error", `Unsupported Linear credential capability: ${capability}`);
  }

  const assignedRoles = config.credentialProfiles.assignmentRolesFor(capability);
  if (!config.credentialProfiles.hasAssignment(role, capability) && assignedRoles.length > 0) {
    throw new SymphonyError(
      "config_validation_error",
      `Linear credential capability ${capability} is owned by ${role}, but is assigned only to ${assignedRoles.join(
        ", ",
      )}. Configure credential_profiles.roles.${role}.${capability} or remove the non-owning assignment to use legacy tracker api key/LINEAR_API_KEY.`,
    );
  }

  const credential = config.credentialProfiles.resolveForRole(role, capability);
  return {
    capability,
    role,
    tracker: {
      ...config.tracker,
      apiKey: credential?.value ?? config.tracker.apiKey,
    },
    credential,
  };
}

export function createLinearTrackerClientForCapability(
  config: ServiceConfig,
  capability: LinearCredentialCapability,
  fetchImpl?: FetchLike,
): LinearTrackerClient | MultiProjectLinearTrackerClient {
  if ((config.projectContexts ?? []).length > 1) {
    return new MultiProjectLinearTrackerClient(config, (contextConfig) =>
      new LinearTrackerClient(resolveLinearClientConfig(contextConfig, capability).tracker, fetchImpl),
    );
  }
  return new LinearTrackerClient(resolveLinearClientConfig(config, capability).tracker, fetchImpl);
}

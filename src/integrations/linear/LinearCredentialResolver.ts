import type { ServiceConfig, TrackerConfig, WorkflowProjectContext } from "../../core/config/Config.js";
import type { CredentialCapability, CredentialRole, ResolvedCredential } from "../../core/config/CredentialProfiles.js";
import { normalizeProjectContextResolution, type ProjectContextResolution } from "../../core/config/ProjectContexts.js";
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
): ResolvedLinearClientConfig {
  return resolveLinearClientConfigForProjectContext(config, capability);
}

export function resolveLinearClientConfigForProjectContext(
  config: ServiceConfig,
  capability: LinearCredentialCapability,
  projectContext?: ProjectContextResolution,
): ResolvedLinearClientConfig {
  const role = LINEAR_CREDENTIAL_CAPABILITY_OWNERS[capability];
  if (!role) {
    throw new SymphonyError("config_validation_error", `Unsupported Linear credential capability: ${capability}`);
  }

  const context = resolveLinearProjectContext(config, projectContext);
  const credentialProfiles = context.credentialProfileRegistry;

  const assignedRoles = credentialProfiles.assignmentRolesFor(capability);
  if (!credentialProfiles.hasAssignment(role, capability) && assignedRoles.length > 0) {
    throw new SymphonyError(
      "config_validation_error",
      `Linear credential capability ${capability} is owned by ${role}, but is assigned only to ${assignedRoles.join(
        ", ",
      )}. Configure credential_profiles.roles.${role}.${capability} or remove the non-owning assignment to use legacy tracker api key/LINEAR_API_KEY.`,
    );
  }

  const credential = credentialProfiles.resolveForRole(role, capability);
  return {
    capability,
    role,
    tracker: {
      ...context.tracker,
      apiKey: credential?.value ?? context.tracker.apiKey,
    },
    credential,
  };
}

export function createLinearTrackerClientForCapability(
  config: ServiceConfig,
  capability: LinearCredentialCapability,
  fetchImpl?: FetchLike,
): LinearTrackerClient {
  return createLinearTrackerClientForProjectContext(config, capability, undefined, fetchImpl);
}

export function createLinearTrackerClientForProjectContext(
  config: ServiceConfig,
  capability: LinearCredentialCapability,
  projectContext: ProjectContextResolution | undefined,
  fetchImpl?: FetchLike,
): LinearTrackerClient {
  return new LinearTrackerClient(resolveLinearClientConfigForProjectContext(config, capability, projectContext).tracker, fetchImpl);
}

function resolveLinearProjectContext(
  config: ServiceConfig,
  projectContext?: ProjectContextResolution,
): WorkflowProjectContext {
  const projectContextId = normalizeProjectContextResolution(projectContext).projectContextId;
  return config.projectContexts.byId.get(projectContextId) ?? config.projectContexts.defaultContext;
}

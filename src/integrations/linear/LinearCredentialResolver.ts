import type { ServiceConfig, TrackerConfig, WorkflowProjectContext } from "../../core/config/Config.js";
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
  projectContextId: string;
  projectContextLabel: string;
  tracker: TrackerConfig;
  credential: ResolvedCredential | null;
  projectContext: WorkflowProjectContext;
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
    projectContextId: view.projectContextId,
    projectContextLabel: view.projectContext.label,
    tracker: {
      ...view.tracker,
      apiKey: credential?.value ?? view.tracker.apiKey,
    },
    credential,
    projectContext: view.projectContext,
  };
}

export function resolveLinearClientConfigForProjectContext(
  config: ServiceConfig,
  capability: LinearCredentialCapability,
  projectContext?: ProjectContextCredentialResolutionOptions["projectContext"],
): ResolvedLinearClientConfig {
  return resolveLinearClientConfig(config, capability, { projectContext });
}

export function createLinearTrackerClientForCapability(
  config: ServiceConfig,
  capability: LinearCredentialCapability,
  fetchImpl?: FetchLike,
  options: ProjectContextCredentialResolutionOptions = {},
): LinearTrackerClient {
  const resolved = resolveLinearClientConfig(config, capability, options);
  const projectContextMetadata = shouldStampTrackerProjectContextMetadata(config, resolved, options.projectContext)
    ? {
        projectContextId: resolved.projectContextId,
        projectContextLabel: resolved.projectContext.label,
        linearProjectSlug: resolved.projectContext.tracker.projectSlug,
      }
    : null;
  return new LinearTrackerClient(resolved.tracker, fetchImpl, projectContextMetadata);
}

function shouldStampTrackerProjectContextMetadata(
  config: ServiceConfig,
  resolved: ResolvedLinearClientConfig,
  requestedProjectContext: ProjectContextCredentialResolutionOptions["projectContext"],
): boolean {
  if (!requestedProjectContext) return false;
  const resolvedProjectSlug = normalizeProjectSlug(resolved.projectContext.tracker.projectSlug);
  if (resolvedProjectSlug === null) return true;
  return (
    config.projectContexts.enabledContexts.filter((context) => sameProjectSlug(context.tracker.projectSlug, resolvedProjectSlug)).length === 1
  );
}

function normalizeProjectSlug(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function sameProjectSlug(left: string | null | undefined, right: string | null | undefined): boolean {
  const normalizedLeft = normalizeProjectSlug(left);
  const normalizedRight = normalizeProjectSlug(right);
  return normalizedLeft !== null && normalizedRight !== null && normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
}

export function createLinearTrackerClientForProjectContext(
  config: ServiceConfig,
  capability: LinearCredentialCapability,
  projectContext: ProjectContextCredentialResolutionOptions["projectContext"],
  fetchImpl?: FetchLike,
): LinearTrackerClient {
  return createLinearTrackerClientForCapability(config, capability, fetchImpl, { projectContext });
}

export function resolveLinearProjectContext(
  config: ServiceConfig,
  projectContext?: ProjectContextCredentialResolutionOptions["projectContext"],
): WorkflowProjectContext {
  return resolveProjectContextCredentialView({ config, projectContext }).projectContext;
}

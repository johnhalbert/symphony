import type { Logger } from "../core/logging/StructuredLogger.js";
import type { AgentRunRole, TrackerStateLists } from "../core/types.js";
import type { ServiceConfig } from "../core/config/Config.js";
import type { CredentialCapability, CredentialRole, ResolvedCredential } from "../core/config/CredentialProfiles.js";
import { SymphonyError } from "../core/errors.js";
import { FileWritebackOutboxStore, WritebackProcessor } from "../core/writeback/WritebackOutbox.js";
import { createLinearTrackerClientForCapability } from "../integrations/linear/LinearCredentialResolver.js";

type FetchLike = typeof fetch;

export function createRuntimeTrackerClient(config: ServiceConfig, fetchImpl?: FetchLike) {
  return createLinearTrackerClientForCapability(config, "linear.tracker", fetchImpl);
}

export function createRuntimeWritebackProcessor(
  config: ServiceConfig,
  logger: Logger,
  fetchImpl?: FetchLike,
): WritebackProcessor | undefined {
  if (!config.writeback.enabled) return undefined;
  return new WritebackProcessor(
    new FileWritebackOutboxStore(config.workspace.stateDir),
    createLinearTrackerClientForCapability(config, "linear.writeback", fetchImpl),
    logger,
    config.writeback.maxBackoffMs,
  );
}

export function resolveCursorRuntimeApiKey(config: ServiceConfig, role: AgentRunRole): string | null {
  return resolveCursorRuntimeCredential(config, role)?.value ?? null;
}

export function resolveCursorRuntimeCredential(config: ServiceConfig, role: AgentRunRole): ResolvedCredential | null {
  enforceCapabilityOwner(config, role, "cursor.runtime", "CURSOR_API_KEY");
  return config.credentialProfiles.resolveForRole(role, "cursor.runtime");
}

export function resolveStatusMutationToken(config: ServiceConfig): string | null {
  return resolveStatusMutationCredential(config)?.value ?? null;
}

export function resolveStatusMutationCredential(config: ServiceConfig): ResolvedCredential | null {
  enforceCapabilityOwner(config, "worker", "server.open_workspace", "server.open_workspace_token");
  return config.credentialProfiles.resolveForRole("worker", "server.open_workspace");
}

export function resolveTrackerStateLists(config: ServiceConfig): TrackerStateLists {
  return {
    activeStates: config.tracker.activeStates,
    handoffStates: config.tracker.handoffStates,
    reviewStates: config.reviewLoop.reviewStates,
    blockedStates: config.reviewLoop.blockedStates,
    terminalStates: config.tracker.terminalStates,
  };
}

function enforceCapabilityOwner(
  config: ServiceConfig,
  owner: CredentialRole,
  capability: CredentialCapability,
  legacyFallbackLabel: string,
): void {
  const assignedRoles = config.credentialProfiles.assignmentRolesFor(capability);
  if (config.credentialProfiles.hasAssignment(owner, capability) || assignedRoles.length === 0) return;
  throw new SymphonyError(
    "config_validation_error",
    `Credential capability ${capability} is owned by ${owner}, but is assigned only to ${assignedRoles.join(
      ", ",
    )}. Configure credential_profiles.roles.${owner}.${capability} or remove the non-owning assignment to use legacy ${legacyFallbackLabel}.`,
  );
}

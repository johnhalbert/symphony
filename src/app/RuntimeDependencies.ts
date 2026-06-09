import type { Logger } from "../core/logging/StructuredLogger.js";
import type { AgentRunRole, TrackerStateLists } from "../core/types.js";
import { resolveProjectContextIdForConfig, type ServiceConfig } from "../core/config/Config.js";
import type { CredentialCapability, CredentialRole, ResolvedCredential } from "../core/config/CredentialProfiles.js";
import { SymphonyError, errorMessage } from "../core/errors.js";
import { FileIssueLifecycleStore, type IssueLifecycleStore } from "../core/persistence/IssueLifecycleStore.js";
import type { IssueBreakdownIssueLookupResult } from "../core/writeback/WritebackOutbox.js";
import { FileWritebackOutboxStore, WritebackProcessor } from "../core/writeback/WritebackOutbox.js";
import { createLinearTrackerClientForCapability } from "../integrations/linear/LinearCredentialResolver.js";

type FetchLike = typeof fetch;

export function createRuntimeTrackerClient(
  config: ServiceConfig,
  fetchImpl?: FetchLike,
  projectContextId?: string | null,
) {
  return createLinearTrackerClientForCapability(config, "linear.tracker", fetchImpl, projectContextId);
}

export function createRuntimeWritebackProcessor(
  configOrGetter: ServiceConfig | (() => ServiceConfig),
  logger: Logger,
  fetchImpl?: FetchLike,
  stores: {
    outboxStore?: FileWritebackOutboxStore;
    lifecycleStore?: Pick<IssueLifecycleStore, "get">;
  } = {},
  projectContextId?: string | null,
): WritebackProcessor | undefined {
  const getConfig = typeof configOrGetter === "function" ? configOrGetter : () => configOrGetter;
  const config = getConfig();
  if (!config.writeback.enabled) return undefined;
  return new WritebackProcessor(
    stores.outboxStore ?? new FileWritebackOutboxStore(config.workspace.stateDir),
    createLinearTrackerClientForCapability(config, "linear.writeback", fetchImpl, projectContextId),
    logger,
    config.writeback.maxBackoffMs,
    stores.lifecycleStore ?? new FileIssueLifecycleStore(config.workspace.stateDir),
    config.writeback.mode === "dry_run",
    {
      getConfig,
      resolveIssue: (issueId) => resolveIssueForBreakdownFreshness(issueId, getConfig, fetchImpl, projectContextId),
    },
  );
}

export async function resolveIssueForBreakdownFreshness(
  issueId: string,
  getConfig: () => ServiceConfig,
  fetchImpl?: FetchLike,
  projectContextId?: string | null,
): Promise<IssueBreakdownIssueLookupResult> {
  try {
    const tracker = createRuntimeTrackerClient(getConfig(), fetchImpl, projectContextId);
    const issue = (await tracker.fetchIssueStatesByIds([issueId]))[0];
    return issue ? { status: "ok", issue } : { status: "not_found" };
  } catch (error) {
    return { status: "transient_error", message: errorMessage(error) };
  }
}

export function resolveCursorRuntimeApiKey(
  config: ServiceConfig,
  role: AgentRunRole,
  projectContextId?: string | null,
): string | null {
  return resolveRuntimeApiKey(config, role, "cursor", projectContextId);
}

export function resolveCursorRuntimeCredential(
  config: ServiceConfig,
  role: AgentRunRole,
  projectContextId?: string | null,
): ResolvedCredential | null {
  return resolveRuntimeCredential(config, role, "cursor", projectContextId);
}

export function resolveRuntimeApiKey(
  config: ServiceConfig,
  role: AgentRunRole,
  harnessId: string,
  projectContextId?: string | null,
): string | null {
  return resolveRuntimeCredential(config, role, harnessId, projectContextId)?.value ?? null;
}

export function resolveRuntimeCredential(
  config: ServiceConfig,
  role: AgentRunRole,
  harnessId: string,
  projectContextId?: string | null,
): ResolvedCredential | null {
  const resolvedProjectContextId = resolveProjectContextIdForConfig(config, projectContextId);
  if (harnessId === "cursor") {
    enforceCapabilityOwner(config, role, "runtime.cursor", "CURSOR_API_KEY", resolvedProjectContextId);
    return (
      config.credentialProfiles.resolveForRole(role, "runtime.cursor", resolvedProjectContextId) ??
      config.credentialProfiles.resolveForRole(role, "cursor.runtime", resolvedProjectContextId)
    );
  }
  if (harnessId === "hermes") {
    enforceCapabilityOwner(
      config,
      role,
      "runtime.hermes",
      "runtime.hermes credential profile",
      resolvedProjectContextId,
    );
    return config.credentialProfiles.resolveForRole(role, "runtime.hermes", resolvedProjectContextId);
  }
  return null;
}

export function resolveStatusMutationToken(config: ServiceConfig, projectContextId?: string | null): string | null {
  return resolveStatusMutationCredential(config, projectContextId)?.value ?? null;
}

export function resolveStatusMutationCredential(
  config: ServiceConfig,
  projectContextId?: string | null,
): ResolvedCredential | null {
  const resolvedProjectContextId = resolveProjectContextIdForConfig(config, projectContextId);
  enforceCapabilityOwner(
    config,
    "worker",
    "server.open_workspace",
    "server.open_workspace_token",
    resolvedProjectContextId,
  );
  return config.credentialProfiles.resolveForRole("worker", "server.open_workspace", resolvedProjectContextId);
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
  projectContextId?: string | null,
): void {
  const assignedRoles = config.credentialProfiles.assignmentRolesFor(capability, projectContextId);
  if (config.credentialProfiles.hasAssignment(owner, capability, projectContextId) || assignedRoles.length === 0) return;
  throw new SymphonyError(
    "config_validation_error",
    `Credential capability ${capability} is owned by ${owner}, but is assigned only to ${assignedRoles.join(
      ", ",
    )}. Configure credential_profiles.roles.${owner}.${capability} or remove the non-owning assignment to use legacy ${legacyFallbackLabel}.`,
  );
}

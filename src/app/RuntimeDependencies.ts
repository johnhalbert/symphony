import type { Logger } from "../core/logging/StructuredLogger.js";
import type { AgentRunRole, TrackerStateLists } from "../core/types.js";
import type { ServiceConfig } from "../core/config/Config.js";
import { resolveProjectContextCredentialRegistry } from "../core/config/Config.js";
import type { CredentialCapability, CredentialRole, CredentialProfileRegistry, ResolvedCredential } from "../core/config/CredentialProfiles.js";
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
  const initialConfig = getConfig();
  if (!initialConfig.writeback.enabled) return undefined;
  const resolveProjectContextId = (operationProjectContextId?: string | null) => operationProjectContextId ?? projectContextId;
  const resolveTrackerWriter = (operationProjectContextId?: string | null) => {
    const currentConfig = getConfig();
    return createLinearTrackerClientForCapability(
      currentConfig,
      "linear.writeback",
      fetchImpl,
      resolveProjectContextId(operationProjectContextId),
    );
  };
  return new WritebackProcessor(
    stores.outboxStore ?? new FileWritebackOutboxStore(initialConfig.workspace.stateDir),
    resolveTrackerWriter(projectContextId),
    logger,
    initialConfig.writeback.maxBackoffMs,
    stores.lifecycleStore ?? new FileIssueLifecycleStore(initialConfig.workspace.stateDir),
    initialConfig.writeback.mode === "dry_run",
    {
      getConfig,
      resolveIssue: (issueId, operationProjectContextId) =>
        resolveIssueForBreakdownFreshness(
          issueId,
          getConfig,
          fetchImpl,
          resolveProjectContextId(operationProjectContextId),
        ),
    },
    resolveTrackerWriter,
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
  const credentialRegistry = getCredentialRegistry(config, projectContextId);
  if (harnessId === "cursor") {
    enforceCapabilityOwner(config, role, "runtime.cursor", "CURSOR_API_KEY", projectContextId);
    return (
      credentialRegistry.resolveForRole(role, "runtime.cursor") ?? credentialRegistry.resolveForRole(role, "cursor.runtime")
    );
  }
  if (harnessId === "hermes") {
    enforceCapabilityOwner(config, role, "runtime.hermes", "runtime.hermes credential profile", projectContextId);
    return credentialRegistry.resolveForRole(role, "runtime.hermes");
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
  const credentialRegistry = getCredentialRegistry(config, projectContextId);
  enforceCapabilityOwner(config, "worker", "server.open_workspace", "server.open_workspace_token", projectContextId);
  return credentialRegistry.resolveForRole("worker", "server.open_workspace");
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
  const credentialRegistry = getCredentialRegistry(config, projectContextId);
  const assignedRoles = credentialRegistry.assignmentRolesFor(capability);
  if (credentialRegistry.hasAssignment(owner, capability) || assignedRoles.length === 0) return;
  throw new SymphonyError(
    "config_validation_error",
    `Credential capability ${capability} is owned by ${owner}, but is assigned only to ${assignedRoles.join(
      ", ",
    )}. Configure credential_profiles.roles.${owner}.${capability} or remove the non-owning assignment to use legacy ${legacyFallbackLabel}.`,
  );
}

function getCredentialRegistry(
  config: ServiceConfig,
  projectContextId?: string | null,
): CredentialProfileRegistry {
  return resolveProjectContextCredentialRegistry(config, projectContextId);
}

import type { Logger } from "../core/logging/StructuredLogger.js";
import type { AgentRunRole, TrackerStateLists } from "../core/types.js";
import type { ServiceConfig } from "../core/config/Config.js";
import type { CredentialCapability, CredentialRole, ResolvedCredential } from "../core/config/CredentialProfiles.js";
import { SymphonyError, errorMessage } from "../core/errors.js";
import { FileIssueLifecycleStore, type IssueLifecycleStore } from "../core/persistence/IssueLifecycleStore.js";
import type { IssueBreakdownIssueLookupResult } from "../core/writeback/WritebackOutbox.js";
import { FileWritebackOutboxStore, WritebackProcessor } from "../core/writeback/WritebackOutbox.js";
import { createLinearTrackerClientForCapability } from "../integrations/linear/LinearCredentialResolver.js";

type FetchLike = typeof fetch;

export function createRuntimeTrackerClient(config: ServiceConfig, fetchImpl?: FetchLike) {
  return createLinearTrackerClientForCapability(config, "linear.tracker", fetchImpl);
}

export function createRuntimeWritebackProcessor(
  configOrGetter: ServiceConfig | (() => ServiceConfig),
  logger: Logger,
  fetchImpl?: FetchLike,
  stores: {
    outboxStore?: FileWritebackOutboxStore;
    lifecycleStore?: Pick<IssueLifecycleStore, "get">;
  } = {},
): WritebackProcessor | undefined {
  const getConfig = typeof configOrGetter === "function" ? configOrGetter : () => configOrGetter;
  const config = getConfig();
  if (!config.writeback.enabled) return undefined;
  return new WritebackProcessor(
    stores.outboxStore ?? new FileWritebackOutboxStore(config.workspace.stateDir),
    createLinearTrackerClientForCapability(config, "linear.writeback", fetchImpl),
    logger,
    config.writeback.maxBackoffMs,
    stores.lifecycleStore ?? new FileIssueLifecycleStore(config.workspace.stateDir),
    config.writeback.mode === "dry_run",
    {
      getConfig,
      resolveIssue: (issueId, projectContextId) => resolveIssueForBreakdownFreshness(issueId, projectContextId, getConfig, fetchImpl),
    },
  );
}

export async function resolveIssueForBreakdownFreshness(
  issueId: string,
  projectContextId: string | null | undefined,
  getConfig: () => ServiceConfig,
  fetchImpl?: FetchLike,
): Promise<IssueBreakdownIssueLookupResult> {
  try {
    const tracker = createRuntimeTrackerClient(getConfig(), fetchImpl);
    const issue = (await tracker.fetchIssueStatesByIds([issueId])).find((candidate) => candidate.projectContextId === (projectContextId ?? candidate.projectContextId));
    return issue ? { status: "ok", issue } : { status: "not_found" };
  } catch (error) {
    return { status: "transient_error", message: errorMessage(error) };
  }
}

export function resolveCursorRuntimeApiKey(config: ServiceConfig, role: AgentRunRole): string | null {
  return resolveRuntimeApiKey(config, role, "cursor");
}

export function resolveCursorRuntimeCredential(config: ServiceConfig, role: AgentRunRole): ResolvedCredential | null {
  return resolveRuntimeCredential(config, role, "cursor");
}

export function resolveRuntimeApiKey(config: ServiceConfig, role: AgentRunRole, harnessId: string): string | null {
  return resolveRuntimeCredential(config, role, harnessId)?.value ?? null;
}

export function resolveRuntimeCredential(
  config: ServiceConfig,
  role: AgentRunRole,
  harnessId: string,
): ResolvedCredential | null {
  if (harnessId === "cursor") {
    enforceCapabilityOwner(config, role, "runtime.cursor", "CURSOR_API_KEY");
    return (
      config.credentialProfiles.resolveForRole(role, "runtime.cursor") ??
      config.credentialProfiles.resolveForRole(role, "cursor.runtime")
    );
  }
  if (harnessId === "hermes") {
    enforceCapabilityOwner(config, role, "runtime.hermes", "runtime.hermes credential profile");
    return config.credentialProfiles.resolveForRole(role, "runtime.hermes");
  }
  return null;
}

export function resolveStatusMutationToken(config: ServiceConfig): string | null {
  return resolveStatusMutationCredential(config)?.value ?? null;
}

export function resolveStatusMutationCredential(config: ServiceConfig): ResolvedCredential | null {
  enforceCapabilityOwner(config, "worker", "server.open_workspace", "server.open_workspace_token");
  return config.credentialProfiles.resolveForRole("worker", "server.open_workspace");
}

export function resolveTrackerStateLists(config: ServiceConfig): TrackerStateLists {
  const contexts = config.projectContexts ?? [];
  if (contexts.length === 0) {
    return {
      activeStates: config.tracker.activeStates,
      handoffStates: config.tracker.handoffStates,
      reviewStates: config.reviewLoop.reviewStates,
      blockedStates: config.reviewLoop.blockedStates,
      terminalStates: config.tracker.terminalStates,
    };
  }
  return {
    activeStates: uniqueStrings(contexts.flatMap((context) => context.tracker.activeStates)),
    handoffStates: uniqueStrings(contexts.flatMap((context) => context.tracker.handoffStates)),
    reviewStates: uniqueStrings(contexts.flatMap((context) => context.reviewLoop.reviewStates)),
    blockedStates: uniqueStrings(contexts.flatMap((context) => context.reviewLoop.blockedStates)),
    terminalStates: uniqueStrings(contexts.flatMap((context) => context.tracker.terminalStates)),
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

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

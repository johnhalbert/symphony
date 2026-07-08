import type { Logger } from "../core/logging/StructuredLogger.js";
import type { AgentRunRole, TrackerStateLists } from "../core/types.js";
import type { ServiceConfig } from "../core/config/Config.js";
import { type CredentialCapability, type CredentialRole, type ResolvedCredential } from "../core/config/CredentialProfiles.js";
import { type ProjectContextResolution } from "../core/config/ProjectContexts.js";
import { resolveServiceConfigForProjectContext } from "../core/config/ProjectContextServiceConfig.js";
import { SymphonyError, errorMessage } from "../core/errors.js";
import { FileIssueLifecycleStore, type IssueLifecycleStore } from "../core/persistence/IssueLifecycleStore.js";
import type { IssueBreakdownIssueLookupResult, WritebackOutboxStore } from "../core/writeback/WritebackOutbox.js";
import { SqliteWritebackOutboxStore, WritebackProcessor } from "../core/writeback/WritebackOutbox.js";
import { createLinearTrackerClientForCapability } from "../integrations/linear/LinearCredentialResolver.js";
import {
  resolveProjectContextCredentialView,
  type ProjectContextCredentialResolutionOptions,
} from "../core/config/ProjectContextCredentialView.js";
import type { CredentialProfileRegistry } from "../core/config/CredentialProfiles.js";

type FetchLike = typeof fetch;

export function createRuntimeTrackerClient(
  config: ServiceConfig,
  fetchImpl?: FetchLike,
  projectContext?: ProjectContextResolution,
) {
  return createLinearTrackerClientForCapability(
    resolveServiceConfigForProjectContext(config, projectContext),
    "linear.tracker",
    fetchImpl,
    { projectContext },
  );
}

export function createRuntimeWritebackProcessor(
  configOrGetter: ServiceConfig | (() => ServiceConfig),
  logger: Logger,
  fetchImpl?: FetchLike,
  stores: {
    outboxStore?: WritebackOutboxStore;
    lifecycleStore?: Pick<IssueLifecycleStore, "get">;
  } = {},
): WritebackProcessor | undefined {
  const getConfig = typeof configOrGetter === "function" ? configOrGetter : () => configOrGetter;
  const config = getConfig();
  if (!config.writeback.enabled) return undefined;
  return new WritebackProcessor(
    stores.outboxStore ?? new SqliteWritebackOutboxStore(config.workspace.stateDir),
    createRuntimeWritebackClient(config, fetchImpl),
    logger,
    config.writeback.maxBackoffMs,
    stores.lifecycleStore ?? new FileIssueLifecycleStore(config.workspace.stateDir),
    config.writeback.mode === "dry_run",
    {
      getConfig: (projectContext) => resolveServiceConfigForProjectContext(getConfig(), projectContext),
      resolveIssue: (issueId, projectContext) =>
        resolveIssueForBreakdownFreshness(issueId, getConfig, projectContext, fetchImpl),
    },
    (projectContext) => createRuntimeWritebackClient(getConfig(), fetchImpl, projectContext),
  );
}

export async function resolveIssueForBreakdownFreshness(
  issueId: string,
  getConfig: () => ServiceConfig,
  projectContext?: ProjectContextResolution,
  fetchImpl?: FetchLike,
): Promise<IssueBreakdownIssueLookupResult> {
  try {
    const tracker = createRuntimeTrackerClient(getConfig(), fetchImpl, projectContext);
    const issue = (await tracker.fetchIssueStatesByIds([issueId]))[0];
    return issue ? { status: "ok", issue } : { status: "not_found" };
  } catch (error) {
    return { status: "transient_error", message: errorMessage(error) };
  }
}

export function createRuntimeWritebackClient(
  config: ServiceConfig,
  fetchImpl?: FetchLike,
  projectContext?: ProjectContextResolution,
) {
  return createLinearTrackerClientForCapability(
    resolveServiceConfigForProjectContext(config, projectContext),
    "linear.writeback",
    fetchImpl,
    { projectContext },
  );
}

export function resolveCursorRuntimeApiKey(config: ServiceConfig, role: AgentRunRole): string | null {
  return resolveRuntimeApiKey(config, role, "cursor");
}

export function resolveScopedCursorRuntimeApiKey(
  config: ServiceConfig,
  role: AgentRunRole,
  options: RuntimeDependencyResolutionOptions = {},
): string | null {
  return resolveRuntimeApiKey(config, role, "cursor", options);
}

export interface RuntimeDependencyResolutionOptions extends ProjectContextCredentialResolutionOptions {}

export function resolveCursorRuntimeCredential(
  config: ServiceConfig,
  role: AgentRunRole,
  options: RuntimeDependencyResolutionOptions = {},
): ResolvedCredential | null {
  return resolveRuntimeCredential(config, role, "cursor", options);
}

export function resolveRuntimeApiKey(
  config: ServiceConfig,
  role: AgentRunRole,
  harnessId: string,
  options: RuntimeDependencyResolutionOptions = {},
): string | null {
  return resolveRuntimeCredential(config, role, harnessId, options)?.value ?? null;
}

export function resolveRuntimeCredential(
  config: ServiceConfig,
  role: AgentRunRole,
  harnessId: string,
  options: RuntimeDependencyResolutionOptions = {},
): ResolvedCredential | null {
  const view = resolveProjectContextCredentialView({
    config,
    projectContext: options.projectContext,
    env: options.env,
  });
  if (harnessId === "cursor") {
    enforceCapabilityOwner(view.credentialProfiles, role, "runtime.cursor", "CURSOR_API_KEY");
    return (
      view.credentialProfiles.resolveForRole(role, "runtime.cursor") ??
      view.credentialProfiles.resolveForRole(role, "cursor.runtime")
    );
  }
  if (harnessId === "hermes") {
    enforceCapabilityOwner(view.credentialProfiles, role, "runtime.hermes", "runtime.hermes credential profile");
    return view.credentialProfiles.resolveForRole(role, "runtime.hermes");
  }
  return null;
}

export function resolveStatusMutationToken(
  config: ServiceConfig,
  options: RuntimeDependencyResolutionOptions = {},
): string | null {
  return resolveStatusMutationCredential(config, options)?.value ?? null;
}

export function resolveStatusMutationCredential(
  config: ServiceConfig,
  options: RuntimeDependencyResolutionOptions = {},
): ResolvedCredential | null {
  const view = resolveProjectContextCredentialView({
    config,
    projectContext: options.projectContext,
    env: options.env,
  });
  enforceCapabilityOwner(view.credentialProfiles, "worker", "server.open_workspace", "server.open_workspace_token");
  return view.credentialProfiles.resolveForRole("worker", "server.open_workspace");
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
  credentialProfiles: CredentialProfileRegistry,
  owner: CredentialRole,
  capability: CredentialCapability,
  legacyFallbackLabel: string,
): void {
  const assignedRoles = credentialProfiles.assignmentRolesFor(capability);
  if (credentialProfiles.hasAssignment(owner, capability) || assignedRoles.length === 0) return;
  throw new SymphonyError(
    "config_validation_error",
    `Credential capability ${capability} is owned by ${owner}, but is assigned only to ${assignedRoles.join(
      ", ",
    )}. Configure credential_profiles.roles.${owner}.${capability} or remove the non-owning assignment to use legacy ${legacyFallbackLabel}.`,
  );
}

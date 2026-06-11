import type { Logger } from "../core/logging/StructuredLogger.js";
import type { AgentRunRole, TrackerStateLists } from "../core/types.js";
import type { ServiceConfig } from "../core/config/Config.js";
import {
  resolveProjectContextCredentialView,
  type ProjectContextCredentialResolutionOptions,
} from "../core/config/ProjectContextCredentialView.js";
import type {
  CredentialCapability,
  CredentialProfileRegistry,
  CredentialRole,
  ResolvedCredential,
} from "../core/config/CredentialProfiles.js";
import { SymphonyError, errorMessage } from "../core/errors.js";
import { FileIssueLifecycleStore, type IssueLifecycleStore } from "../core/persistence/IssueLifecycleStore.js";
import type { IssueBreakdownIssueLookupResult } from "../core/writeback/WritebackOutbox.js";
import { FileWritebackOutboxStore, WritebackProcessor } from "../core/writeback/WritebackOutbox.js";
import { createLinearTrackerClientForCapability } from "../integrations/linear/LinearCredentialResolver.js";

type FetchLike = typeof fetch;

export interface RuntimeDependencyResolutionOptions extends ProjectContextCredentialResolutionOptions {}

export function createRuntimeTrackerClient(
  config: ServiceConfig,
  fetchImpl?: FetchLike,
  options: RuntimeDependencyResolutionOptions = {},
) {
  return createLinearTrackerClientForCapability(config, "linear.tracker", fetchImpl, options);
}

export function createRuntimeWritebackProcessor(
  configOrGetter: ServiceConfig | (() => ServiceConfig),
  logger: Logger,
  fetchImpl?: FetchLike,
  stores: {
    outboxStore?: FileWritebackOutboxStore;
    lifecycleStore?: Pick<IssueLifecycleStore, "get">;
  } = {},
  options: RuntimeDependencyResolutionOptions = {},
): WritebackProcessor | undefined {
  const getConfig = typeof configOrGetter === "function" ? configOrGetter : () => configOrGetter;
  const config = getConfig();
  if (!config.writeback.enabled) return undefined;
  const defaultWriter = createLinearTrackerClientForCapability(config, "linear.writeback", fetchImpl, options);
  return new WritebackProcessor(
    stores.outboxStore ?? new FileWritebackOutboxStore(config.workspace.stateDir),
    (record) => {
      const projectContext = record.projectContext ?? options.projectContext;
      if (!projectContext || projectContext.projectContextId === config.projectContexts.defaultContextId) {
        return defaultWriter;
      }
      return createLinearTrackerClientForCapability(getConfig(), "linear.writeback", fetchImpl, {
        projectContext,
        env: options.env,
      });
    },
    logger,
    config.writeback.maxBackoffMs,
    stores.lifecycleStore ?? new FileIssueLifecycleStore(config.workspace.stateDir),
    config.writeback.mode === "dry_run",
    {
      getConfig,
      resolveIssue: (issueId, projectContext) =>
        resolveIssueForBreakdownFreshness(issueId, getConfig, fetchImpl, {
          projectContext: projectContext ?? options.projectContext,
          env: options.env,
        }),
    },
  );
}

export async function resolveIssueForBreakdownFreshness(
  issueId: string,
  getConfig: () => ServiceConfig,
  fetchImpl?: FetchLike,
  options: RuntimeDependencyResolutionOptions = {},
): Promise<IssueBreakdownIssueLookupResult> {
  try {
    const tracker = createRuntimeTrackerClient(getConfig(), fetchImpl, options);
    const issue = (await tracker.fetchIssueStatesByIds([issueId]))[0];
    return issue ? { status: "ok", issue } : { status: "not_found" };
  } catch (error) {
    return { status: "transient_error", message: errorMessage(error) };
  }
}

export function resolveCursorRuntimeApiKey(
  config: ServiceConfig,
  role: AgentRunRole,
  options: RuntimeDependencyResolutionOptions = {},
): string | null {
  return resolveRuntimeApiKey(config, role, "cursor", options);
}

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

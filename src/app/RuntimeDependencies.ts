import type { Logger } from "../core/logging/StructuredLogger.js";
import type { AgentRunRole, TrackerStateLists } from "../core/types.js";
import type { ServiceConfig } from "../core/config/Config.js";
import {
  createCredentialProfileRegistry,
  type CredentialCapability,
  type CredentialRole,
  type ResolvedCredential,
} from "../core/config/CredentialProfiles.js";
import {
  LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
  normalizeProjectContextId,
  type ProjectContextResolution,
} from "../core/config/ProjectContexts.js";
import { SymphonyError, errorMessage } from "../core/errors.js";
import { FileIssueLifecycleStore, type IssueLifecycleStore } from "../core/persistence/IssueLifecycleStore.js";
import type { IssueBreakdownIssueLookupResult } from "../core/writeback/WritebackOutbox.js";
import { FileWritebackOutboxStore, WritebackProcessor } from "../core/writeback/WritebackOutbox.js";
import { createLinearTrackerClientForCapability } from "../integrations/linear/LinearCredentialResolver.js";

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
  );
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

export function resolveServiceConfigForProjectContext(
  config: ServiceConfig,
  projectContext?: ProjectContextResolution,
): ServiceConfig {
  if (!projectContext) return config;
  const requestedProjectContextId = normalizeProjectContextId(projectContext.projectContextId);
  const projectContextId =
    requestedProjectContextId === LEGACY_DEFAULT_PROJECT_CONTEXT_ID
      ? config.projectContexts.defaultContextId
      : requestedProjectContextId;
  if (projectContextId === config.projectContexts.defaultContextId) return config;

  const context = config.projectContexts.byId.get(projectContextId);
  if (!context) {
    throw new SymphonyError("config_validation_error", `Resolved project context "${projectContextId}" is not configured`);
  }

  return {
    ...config,
    tracker: context.tracker,
    workspace: context.workspace,
    github: context.github,
    reviewLoop: context.reviewLoop,
    issueBreakdown: context.issueBreakdown,
    agent: context.agent,
    credentialProfiles: createCredentialProfileRegistry({
      raw: context.credentialProfiles,
      env: config.environment,
      workflowDir: config.workflowDir,
      fallbacks: {
        githubToken: context.github.token,
        linearApiKey: context.tracker.apiKey,
        cursorRuntimeApiKey: null,
        openWorkspaceToken: config.server.openWorkspaceToken,
      },
    }),
  };
}

function createRuntimeWritebackClient(
  config: ServiceConfig,
  fetchImpl?: FetchLike,
  projectContext?: ProjectContextResolution,
) {
  return createLinearTrackerClientForCapability(
    resolveServiceConfigForProjectContext(config, projectContext),
    "linear.writeback",
    fetchImpl,
  );
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

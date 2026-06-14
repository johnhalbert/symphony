import { createCredentialProfileRegistry } from "./CredentialProfiles.js";
import type { ServiceConfig } from "./Config.js";
import {
  LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
  normalizeProjectContextId,
  type ProjectContextResolution,
} from "./ProjectContexts.js";
import { SymphonyError } from "../errors.js";

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

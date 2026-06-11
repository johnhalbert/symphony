import type { RawProjectContextConfig, ServiceConfig, WorkflowProjectContext } from "./Config.js";
import {
  createCredentialProfileRegistry,
  type CredentialProfileRegistry,
  type RawCredentialProfilesConfig,
} from "./CredentialProfiles.js";
import {
  LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
  normalizeProjectContextId,
  type ProjectContextResolution,
} from "./ProjectContexts.js";

export interface ProjectContextCredentialView {
  projectContextId: string;
  projectContext: WorkflowProjectContext;
  rawContext: RawProjectContextConfig | undefined;
  tracker: WorkflowProjectContext["tracker"];
  github: WorkflowProjectContext["github"];
  credentialProfiles: CredentialProfileRegistry;
  rawCredentialProfiles: RawCredentialProfilesConfig | undefined;
}

export interface ProjectContextCredentialResolutionOptions {
  projectContext?: ProjectContextResolution | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

export function resolveProjectContextCredentialView(input: {
  config: ServiceConfig;
  projectContext?: ProjectContextResolution | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}): ProjectContextCredentialView {
  const selected = resolveConfiguredProjectContext(input.config, input.projectContext);
  if (!selected) {
    const defaultContext = input.config.projectContexts.defaultContext;
    return {
      projectContextId: defaultContext.id,
      projectContext: defaultContext,
      rawContext: findRawProjectContext(input.config.raw.project_contexts, defaultContext.id),
      tracker: defaultContext.tracker,
      github: defaultContext.github,
      credentialProfiles: input.config.credentialProfiles,
      rawCredentialProfiles: defaultContext.credentialProfiles,
    };
  }

  return {
    projectContextId: selected.context.id,
    projectContext: selected.context,
    rawContext: selected.rawContext,
    tracker: selected.context.tracker,
    github: selected.context.github,
    credentialProfiles: createCredentialProfileRegistry({
      raw: selected.context.credentialProfiles,
      env: input.env ?? process.env,
      workflowDir: input.config.workflowDir,
      fallbacks: {
        githubToken: selected.context.github.token,
        linearApiKey: selected.context.tracker.apiKey,
        cursorRuntimeApiKey: (input.env ?? process.env).CURSOR_API_KEY ?? null,
        openWorkspaceToken: input.config.server.openWorkspaceToken,
      },
    }),
    rawCredentialProfiles: selected.context.credentialProfiles,
  };
}

function resolveConfiguredProjectContext(
  config: ServiceConfig,
  projectContext: ProjectContextResolution | undefined,
): {
  context: WorkflowProjectContext;
  rawContext: RawProjectContextConfig | undefined;
} | null {
  if (!projectContext) return null;

  const projectContextId = normalizeProjectContextId(projectContext.projectContextId);
  if (projectContextId === config.projectContexts.defaultContextId) return null;
  if (
    projectContextId === LEGACY_DEFAULT_PROJECT_CONTEXT_ID &&
    !config.projectContexts.byId.has(LEGACY_DEFAULT_PROJECT_CONTEXT_ID)
  ) {
    return null;
  }

  const context = config.projectContexts.byId.get(projectContextId);
  if (!context) {
    throw new Error(`Resolved project context "${projectContextId}" is not configured`);
  }

  return {
    context,
    rawContext: findRawProjectContext(config.raw.project_contexts, projectContextId),
  };
}

function findRawProjectContext(
  projectContexts: ServiceConfig["raw"]["project_contexts"] | undefined,
  projectContextId: string,
): RawProjectContextConfig | undefined {
  return projectContexts?.find((context) => normalizeProjectContextId(context.id) === projectContextId);
}

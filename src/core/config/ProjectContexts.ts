import type {
  AgentConfig,
  GitHubConfig,
  IssueBreakdownConfig,
  RawWorkflowConfig,
  ReviewLoopConfig,
  TrackerConfig,
  WorkspaceConfig,
  WorkspaceSourceConfig,
} from "./Config.js";

export const DEFAULT_PROJECT_CONTEXT_ID = "default";
export const DEFAULT_PROJECT_CONTEXT_LABEL = "Default";

export interface ProjectContextConfig {
  id: string;
  label: string;
  enabled: boolean;
  tracker: TrackerConfig;
  workspace: WorkspaceConfig;
  github: GitHubConfig;
  reviewLoop: ReviewLoopConfig;
  issueBreakdown: IssueBreakdownConfig;
  agent: AgentConfig;
  raw: RawWorkflowConfig;
}

export interface ProjectContextPublicMetadata {
  id: string;
  label: string;
  enabled: boolean;
  tracker: {
    kind: "linear";
    endpoint: string;
    projectSlug: string;
    assignee: string | null;
    activeStates: string[];
    handoffStates: string[];
    terminalStates: string[];
  };
  workspace: {
    root: string;
    stateDir: string;
    source: WorkspaceSourceConfig;
  };
  github: {
    owner: string | null;
    repo: string | null;
    headOwner: string | null;
    apiBaseUrl: string;
    publishPullRequests: boolean;
    tokenPresent: boolean;
    appConfigured: boolean;
  };
}

export function normalizeProjectContextId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
  if (normalized.length === 0) {
    throw new Error("Project context id must not be empty after normalization");
  }
  return normalized;
}

export function projectContextPublicMetadata(context: ProjectContextConfig): ProjectContextPublicMetadata {
  return {
    id: context.id,
    label: context.label,
    enabled: context.enabled,
    tracker: {
      kind: context.tracker.kind,
      endpoint: context.tracker.endpoint,
      projectSlug: context.tracker.projectSlug,
      assignee: context.tracker.assignee,
      activeStates: [...context.tracker.activeStates],
      handoffStates: [...context.tracker.handoffStates],
      terminalStates: [...context.tracker.terminalStates],
    },
    workspace: {
      root: context.workspace.root,
      stateDir: context.workspace.stateDir,
      source: { ...context.workspace.source },
    },
    github: {
      owner: context.github.owner,
      repo: context.github.repo,
      headOwner: context.github.headOwner,
      apiBaseUrl: context.github.apiBaseUrl,
      publishPullRequests: context.github.publishPullRequests,
      tokenPresent: context.github.token !== null,
      appConfigured: context.github.app !== null,
    },
  };
}

export function projectContextRegistryPublicMetadata(
  contexts: readonly ProjectContextConfig[] | undefined,
): ProjectContextPublicMetadata[] {
  return (contexts ?? []).map(projectContextPublicMetadata);
}

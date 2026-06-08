import type {
  AgentConfig,
  GitHubConfig,
  IssueBreakdownConfig,
  RawWorkflowConfig,
  ReviewLoopConfig,
  ServiceConfig,
  TrackerConfig,
  WorkspaceConfig,
} from "./Config.js";
import type { CredentialProfileRegistry } from "./CredentialProfiles.js";
import type { Issue } from "../types.js";

export const DEFAULT_PROJECT_CONTEXT_ID = "default";

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
  credentialProfiles: CredentialProfileRegistry;
  raw: RawWorkflowConfig;
}

export interface ProjectContextAttribution {
  projectContextId?: string | null;
  projectContextLabel?: string | null;
  trackerProjectSlug?: string | null;
}

export function normalizeProjectContextId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
  if (normalized.length === 0) {
    throw new Error("Project context id must contain at least one letter or number");
  }
  return normalized;
}

export function projectScopedKey(projectContextId: string, value: string): string {
  return `${projectContextId}--${value}`;
}

export function projectContextForId(config: ServiceConfig, projectContextId: string | null | undefined): ProjectContextConfig | null {
  if (!projectContextId) return defaultProjectContext(config);
  return (config.projectContexts ?? []).find((context) => context.id === projectContextId) ?? null;
}

export function defaultProjectContext(config: ServiceConfig): ProjectContextConfig {
  return (
    (config.projectContexts ?? []).find((context) => context.id === config.defaultProjectContextId) ??
    (config.projectContexts ?? [])[0] ?? {
      id: DEFAULT_PROJECT_CONTEXT_ID,
      label: "Default",
      enabled: true,
      tracker: config.tracker,
      workspace: config.workspace,
      github: config.github,
      reviewLoop: config.reviewLoop,
      issueBreakdown: config.issueBreakdown,
      agent: config.agent,
      credentialProfiles: config.credentialProfiles,
      raw: config.raw,
    }
  );
}

export function projectContextForIssue(
  config: ServiceConfig,
  issue: Pick<Issue, "projectContextId"> | ProjectContextAttribution,
): ProjectContextConfig {
  return projectContextForId(config, issue.projectContextId) ?? defaultProjectContext(config);
}

export function withProjectContextServiceConfig(
  config: ServiceConfig,
  projectContext: ProjectContextConfig | string | null | undefined,
): ServiceConfig {
  const resolved = typeof projectContext === "string" || projectContext == null
    ? projectContextForId(config, projectContext)
    : projectContext;
  const context = resolved ?? defaultProjectContext(config);
  return {
    ...config,
    tracker: context.tracker,
    workspace: context.workspace,
    github: context.github,
    reviewLoop: context.reviewLoop,
    issueBreakdown: context.issueBreakdown,
    agent: context.agent,
    credentialProfiles: context.credentialProfiles,
    raw: context.raw,
  };
}

export function contextLabel(input: ProjectContextAttribution): string {
  return input.projectContextLabel?.trim() || input.projectContextId?.trim() || DEFAULT_PROJECT_CONTEXT_ID;
}

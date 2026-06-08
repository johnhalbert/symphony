import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { SymphonyError } from "../errors.js";
import {
  rawCredentialRoleAssignmentsSchema,
  type CredentialCapability,
  type RawCredentialRoleAssignmentsConfig,
} from "./CredentialProfiles.js";
import type {
  AgentConfig,
  AgentHarnessKind,
  GitHubAppConfig,
  GitHubConfig,
  GitHubOperatorApprovalConfig,
  GitHubPullRequestHandoffConfig,
  IssueBreakdownConfig,
  ReviewLoopConfig,
  TrackerConfig,
  WorkspaceConfig,
  WorkspaceSourceConfig,
} from "./Config.js";

const stringArray = z.array(z.string());
const ENV_REFERENCE_PATTERN = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;
const DEFAULT_ACTIVE_STATES = ["Todo", "In Progress"];
const DEFAULT_TERMINAL_STATES = ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"];
const DEFAULT_GITHUB_APP_TOKEN_REFRESH_BUFFER_SECONDS = 300;

const rawTrackerSchema = z
  .object({
    kind: z.string().optional(),
    endpoint: z.string().optional(),
    api_key: z.string().optional(),
    project_slug: z.string().optional(),
    assignee: z.string().optional(),
    active_states: stringArray.optional(),
    handoff_states: stringArray.optional(),
    terminal_states: stringArray.optional(),
  })
  .passthrough();

const rawWorkspaceSchema = z
  .object({
    root: z.string().optional(),
    state_dir: z.string().optional(),
    source: z
      .object({
        kind: z.enum(["none", "copy", "git", "git_worktree"]).optional(),
        path: z.string().optional(),
        repository: z.string().optional(),
        ref: z.string().optional(),
        base_ref: z.string().optional(),
        branch_template: z.string().optional(),
        cache_path: z.string().optional(),
        cleanup: z.enum(["refuse_dirty", "force"]).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const rawGitHubSchema = z
  .object({
    owner: z.string().optional(),
    repo: z.string().optional(),
    token: z.string().optional(),
    app: z
      .object({
        app_id: z.string().optional(),
        client_id: z.string().optional(),
        installation_id: z.string().optional(),
        private_key: z.string().optional(),
        private_key_path: z.string().optional(),
        token_refresh_buffer_seconds: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
    head_owner: z.string().optional(),
    api_base_url: z.string().optional(),
    publish_pull_requests: z.boolean().optional(),
    operator_approval: z
      .object({
        required_for_publication: z.boolean().optional(),
        reject_policy: z.enum(["cancel", "fail"]).optional(),
        poll_interval_ms: z.number().int().positive().optional(),
        timeout_ms: z.number().int().nonnegative().nullable().optional(),
      })
      .passthrough()
      .optional(),
    pr_handoff: z
      .object({
        enabled: z.boolean().optional(),
        target_state: z.string().optional(),
        allow_drafts: z.boolean().optional(),
        required_checks: stringArray.optional(),
        no_ci: z
          .object({
            allowed: z.boolean().optional(),
            evidence: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const rawReviewLoopSchema = z
  .object({
    review_states: stringArray.optional(),
    blocked_states: stringArray.optional(),
    review_pass_state: z.string().optional(),
    reviewer_prompt: z.string().optional(),
    reviewer_prompt_extensions: stringArray.optional(),
    worker_prompt_extensions: stringArray.optional(),
    max_review_rounds: z.number().int().positive().optional(),
    max_incomplete_turns: z.number().int().positive().optional(),
    continuation_history_threshold: z.number().int().nonnegative().optional(),
    transcript_history_limit: z.number().int().nonnegative().optional(),
    pr_review_evidence_limit: z.number().int().positive().optional(),
  })
  .passthrough();

const rawIssueBreakdownSchema = z
  .object({
    enabled: z.boolean().optional(),
    cursor_mode: z.enum(["agent", "plan"]).optional(),
    prompt: z.string().optional(),
    planning_labels: stringArray.optional(),
    apply_to_linear: z
      .object({
        enabled: z.boolean().optional(),
        mode: z.enum(["child_issues"]).optional(),
      })
      .passthrough()
      .optional(),
    workspace_mode: z.enum(["none", "readonly_checkout"]).optional(),
    max_planning_failures: z.number().int().positive().optional(),
    max_planning_dispatch_retries: z.number().int().positive().optional(),
    planning_retry_base_ms: z.number().int().positive().optional(),
    planning_retry_max_ms: z.number().int().positive().optional(),
  })
  .passthrough();

const rawAgentSchema = z
  .object({
    harness: z.string().optional(),
    max_concurrent_agents: z.number().int().positive().optional(),
    max_turns: z.number().int().positive().optional(),
    max_retry_backoff_ms: z.number().int().positive().optional(),
    max_sdk_error_retries: z.number().int().nonnegative().optional(),
    max_infra_failures: z.number().int().positive().optional(),
    max_concurrent_agents_by_state: z.record(z.string(), z.number()).optional(),
    require_labels: stringArray.optional(),
    exclude_labels: stringArray.optional(),
    protected_paths: stringArray.optional(),
  })
  .passthrough();

const rawProjectContextCredentialProfilesSchema = z
  .object({
    roles: rawCredentialRoleAssignmentsSchema.optional(),
  })
  .strict();

export const rawProjectContextSchema = z
  .object({
    id: z.string(),
    label: z.string().optional(),
    enabled: z.boolean().optional(),
    tracker: rawTrackerSchema.optional(),
    workspace: rawWorkspaceSchema.optional(),
    github: rawGitHubSchema.optional(),
    review_loop: rawReviewLoopSchema.optional(),
    issue_breakdown: rawIssueBreakdownSchema.optional(),
    agent: rawAgentSchema.optional(),
    credential_profiles: rawProjectContextCredentialProfilesSchema.optional(),
  })
  .passthrough();

export const rawProjectContextsSchema = z.array(rawProjectContextSchema).min(1);

export type RawProjectContextConfig = z.infer<typeof rawProjectContextSchema>;
export type RawProjectContextTrackerConfig = z.infer<typeof rawTrackerSchema>;
export type RawProjectContextWorkspaceConfig = z.infer<typeof rawWorkspaceSchema>;
export type RawProjectContextGitHubConfig = z.infer<typeof rawGitHubSchema>;
export type RawProjectContextReviewLoopConfig = z.infer<typeof rawReviewLoopSchema>;
export type RawProjectContextIssueBreakdownConfig = z.infer<typeof rawIssueBreakdownSchema>;
export type RawProjectContextAgentConfig = z.infer<typeof rawAgentSchema>;

export interface RawProjectContextDefaults {
  tracker?: RawProjectContextTrackerConfig;
  workspace?: RawProjectContextWorkspaceConfig;
  github?: RawProjectContextGitHubConfig;
  review_loop?: RawProjectContextReviewLoopConfig;
  issue_breakdown?: RawProjectContextIssueBreakdownConfig;
  agent?: RawProjectContextAgentConfig;
  credential_profiles?: {
    roles?: RawCredentialRoleAssignmentsConfig;
  };
}

export const DEFAULT_PROJECT_CONTEXT_ID = "default";
export const DEFAULT_PROJECT_CONTEXT_LABEL = "Default";

export type ProjectContextId = string;
export type ProjectContextSource = "legacy_default" | "explicit";
export type ProjectContextRoutingSource = "candidate_poll" | "state_refresh" | "legacy_default" | "operator_request" | "replay";

export interface ProjectContextLinearProjectIdentity {
  kind: "linear";
  slug: string;
  endpoint: string;
}

export interface ProjectContextCodebaseIdentity {
  sourceKind: WorkspaceSourceConfig["kind"];
  label: string;
  workspaceRoot: string;
  stateDir: string;
  repository: string | null;
  path: string | null;
  baseRef: string | null;
}

export interface ProjectContextResolution {
  projectContextId: ProjectContextId;
  projectContextLabel: string;
  codebase: ProjectContextCodebaseIdentity;
  linearProject: ProjectContextLinearProjectIdentity;
  routingSource: ProjectContextRoutingSource;
  lockedAt: string;
}

export interface ProjectContextCredentialAssignments {
  worker: Partial<Record<CredentialCapability, string>>;
  reviewer: Partial<Record<CredentialCapability, string>>;
  service: Partial<Record<CredentialCapability, string>>;
}

export interface NormalizedProjectContext {
  id: ProjectContextId;
  label: string;
  enabled: boolean;
  source: ProjectContextSource;
  tracker: TrackerConfig;
  workspace: WorkspaceConfig;
  github: GitHubConfig;
  reviewLoop: ReviewLoopConfig;
  issueBreakdown: IssueBreakdownConfig;
  agent: AgentConfig;
  credentialProfiles: ProjectContextCredentialAssignments;
  linearProjectIdentity: ProjectContextLinearProjectIdentity;
  codebaseIdentity: ProjectContextCodebaseIdentity;
}

export interface ProjectContextRegistry {
  contexts: NormalizedProjectContext[];
  enabledContexts: NormalizedProjectContext[];
  defaultContextId: ProjectContextId;
  byId: Map<ProjectContextId, NormalizedProjectContext>;
}

export interface NormalizeProjectContextRegistryInput {
  rawProjectContexts: RawProjectContextConfig[] | undefined;
  rawDefaults: RawProjectContextDefaults;
  workflowDir: string;
  env: NodeJS.ProcessEnv;
  defaultIssueBreakdownPrompt: string;
}

export interface NormalizeProjectContextRegistryResult {
  registry: ProjectContextRegistry;
  contextRoleAssignments: Map<ProjectContextId, RawCredentialRoleAssignmentsConfig | undefined>;
}

export interface ProjectContextPublicMetadata {
  id: ProjectContextId;
  label: string;
  enabled: boolean;
  source: ProjectContextSource;
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
    app: PublicGitHubAppMetadata | null;
    operatorApproval?: GitHubOperatorApprovalConfig;
    prHandoff: GitHubPullRequestHandoffConfig;
  };
  reviewLoop: ReviewLoopConfig;
  issueBreakdown: IssueBreakdownConfig;
  agent: AgentConfig;
  credentialProfiles: ProjectContextCredentialAssignments;
  linearProjectIdentity: ProjectContextLinearProjectIdentity;
  codebaseIdentity: ProjectContextCodebaseIdentity;
}

interface PublicGitHubAppMetadata {
  appId: string | null;
  clientId: string | null;
  installationId: string | null;
  privateKey: { kind: "env"; name: string } | { kind: "inline"; redacted: true } | null;
  privateKeyPath: string | null;
  tokenRefreshBufferSeconds: number;
}

export function normalizeProjectContextRegistry(
  input: NormalizeProjectContextRegistryInput,
): NormalizeProjectContextRegistryResult {
  if (!input.rawProjectContexts || input.rawProjectContexts.length === 0) {
    const tracker = normalizeTrackerConfig(input.rawDefaults.tracker, input.env, {
      contextId: null,
      requireApiKey: true,
      requireProjectSlug: true,
    });
    const workspace = normalizeWorkspaceConfig(input.rawDefaults.workspace, input.workflowDir, input.env, {
      contextId: null,
      requireGitWorktreeDetails: true,
    });
    const reviewLoop = normalizeReviewLoopConfig(input.rawDefaults.review_loop, tracker.handoffStates);
    const github = normalizeGitHubConfig(input.rawDefaults.github, input.workflowDir, input.env, {
      contextId: null,
      handoffStates: tracker.handoffStates,
      reviewLoop,
    });
    const issueBreakdown = normalizeIssueBreakdownConfig(
      input.rawDefaults.issue_breakdown,
      workspace.source.kind,
      input.defaultIssueBreakdownPrompt,
      { contextId: null },
    );
    const agent = normalizeAgentConfig(input.rawDefaults.agent);
    validateStateBuckets({
      contextId: null,
      activeStates: tracker.activeStates,
      handoffStates: tracker.handoffStates,
      terminalStates: tracker.terminalStates,
      reviewStates: reviewLoop.reviewStates,
      blockedStates: reviewLoop.blockedStates,
      reviewPassState: reviewLoop.reviewPassState,
    });
    validatePullRequestHandoffPolicy({
      contextId: null,
      publishPullRequests: github.publishPullRequests,
      handoffStates: tracker.handoffStates,
      reviewStates: reviewLoop.reviewStates,
      blockedStates: reviewLoop.blockedStates,
      reviewPassState: reviewLoop.reviewPassState,
      prHandoff: github.prHandoff,
    });

    const context: NormalizedProjectContext = {
      id: DEFAULT_PROJECT_CONTEXT_ID,
      label: DEFAULT_PROJECT_CONTEXT_LABEL,
      enabled: true,
      source: "legacy_default",
      tracker,
      workspace,
      github,
      reviewLoop,
      issueBreakdown,
      agent,
      credentialProfiles: normalizeCredentialAssignments(input.rawDefaults.credential_profiles?.roles),
      linearProjectIdentity: {
        kind: "linear",
        slug: tracker.projectSlug,
        endpoint: tracker.endpoint,
      },
      codebaseIdentity: buildCodebaseIdentity(workspace),
    };
    return {
      registry: buildRegistry([context], DEFAULT_PROJECT_CONTEXT_ID),
      contextRoleAssignments: new Map(),
    };
  }

  const contexts: NormalizedProjectContext[] = [];
  const contextRoleAssignments = new Map<ProjectContextId, RawCredentialRoleAssignmentsConfig | undefined>();
  const seen = new Set<string>();
  for (const rawContext of input.rawProjectContexts) {
    const normalizedId = normalizeProjectContextId(rawContext.id);
    if (seen.has(normalizedId)) {
      throw new SymphonyError(
        "config_validation_error",
        `Duplicate project context id after normalization: "${normalizedId}"`,
      );
    }
    seen.add(normalizedId);
    const enabled = rawContext.enabled ?? true;
    const tracker = normalizeTrackerConfig(
      mergeConfigSection(input.rawDefaults.tracker, rawContext.tracker),
      input.env,
      { contextId: normalizedId, requireApiKey: enabled, requireProjectSlug: enabled },
    );
    const workspace = normalizeWorkspaceConfig(
      mergeConfigSection(input.rawDefaults.workspace, rawContext.workspace),
      input.workflowDir,
      input.env,
      { contextId: normalizedId, requireGitWorktreeDetails: enabled },
    );
    const reviewLoop = normalizeReviewLoopConfig(
      mergeConfigSection(input.rawDefaults.review_loop, rawContext.review_loop),
      tracker.handoffStates,
    );
    const github = normalizeGitHubConfig(
      mergeConfigSection(input.rawDefaults.github, rawContext.github),
      input.workflowDir,
      input.env,
      { contextId: normalizedId, handoffStates: tracker.handoffStates, reviewLoop },
    );
    const issueBreakdown = normalizeIssueBreakdownConfig(
      mergeConfigSection(input.rawDefaults.issue_breakdown, rawContext.issue_breakdown),
      workspace.source.kind,
      input.defaultIssueBreakdownPrompt,
      { contextId: normalizedId },
    );
    const agent = normalizeAgentConfig(mergeConfigSection(input.rawDefaults.agent, rawContext.agent));
    if (enabled) {
      validateWorkspaceSourceForEnabledContext(normalizedId, workspace.source);
      validateStateBuckets({
        contextId: normalizedId,
        activeStates: tracker.activeStates,
        handoffStates: tracker.handoffStates,
        terminalStates: tracker.terminalStates,
        reviewStates: reviewLoop.reviewStates,
        blockedStates: reviewLoop.blockedStates,
        reviewPassState: reviewLoop.reviewPassState,
      });
      validatePullRequestHandoffPolicy({
        contextId: normalizedId,
        publishPullRequests: github.publishPullRequests,
        handoffStates: tracker.handoffStates,
        reviewStates: reviewLoop.reviewStates,
        blockedStates: reviewLoop.blockedStates,
        reviewPassState: reviewLoop.reviewPassState,
        prHandoff: github.prHandoff,
      });
    }
    const credentialRoles = rawContext.credential_profiles?.roles;
    contextRoleAssignments.set(normalizedId, credentialRoles);
    contexts.push({
      id: normalizedId,
      label: normalizeOptionalConfigString(rawContext.label) ?? normalizedId,
      enabled,
      source: "explicit",
      tracker,
      workspace,
      github,
      reviewLoop,
      issueBreakdown,
      agent,
      credentialProfiles: normalizeCredentialAssignments(input.rawDefaults.credential_profiles?.roles, credentialRoles),
      linearProjectIdentity: {
        kind: "linear",
        slug: tracker.projectSlug,
        endpoint: tracker.endpoint,
      },
      codebaseIdentity: buildCodebaseIdentity(workspace),
    });
  }

  const enabledContexts = contexts.filter((context) => context.enabled);
  if (enabledContexts.length === 0) {
    throw new SymphonyError("config_validation_error", "At least one enabled project context is required");
  }
  const defaultContextId =
    enabledContexts.find((context) => context.id === DEFAULT_PROJECT_CONTEXT_ID)?.id ?? enabledContexts[0]!.id;
  return {
    registry: buildRegistry(contexts, defaultContextId),
    contextRoleAssignments,
  };
}

export function normalizeProjectContextId(value: string): ProjectContextId {
  const trimmed = value.trim().toLowerCase();
  const normalized = trimmed
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
  if (normalized.length === 0) {
    throw new SymphonyError("config_validation_error", "Project context id must not be empty after normalization");
  }
  return normalized;
}

export function projectContextPublicMetadata(context: NormalizedProjectContext): ProjectContextPublicMetadata {
  return {
    id: context.id,
    label: context.label,
    enabled: context.enabled,
    source: context.source,
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
      app: publicGitHubAppMetadata(context.github.app),
      ...(context.github.operatorApproval === undefined ? {} : { operatorApproval: context.github.operatorApproval }),
      prHandoff: context.github.prHandoff,
    },
    reviewLoop: context.reviewLoop,
    issueBreakdown: context.issueBreakdown,
    agent: context.agent,
    credentialProfiles: context.credentialProfiles,
    linearProjectIdentity: context.linearProjectIdentity,
    codebaseIdentity: context.codebaseIdentity,
  };
}

export function projectContextRegistryPublicMetadata(registry: ProjectContextRegistry): ProjectContextPublicMetadata[] {
  return registry.contexts.map(projectContextPublicMetadata);
}

function buildRegistry(contexts: NormalizedProjectContext[], defaultContextId: ProjectContextId): ProjectContextRegistry {
  const byId = new Map(contexts.map((context) => [context.id, context] as const));
  return {
    contexts,
    enabledContexts: contexts.filter((context) => context.enabled),
    defaultContextId,
    byId,
  };
}

function normalizeTrackerConfig(
  raw: RawProjectContextTrackerConfig | undefined,
  env: NodeJS.ProcessEnv,
  input: { contextId: string | null; requireApiKey: boolean; requireProjectSlug: boolean },
): TrackerConfig {
  const trackerKind = raw?.kind ?? "linear";
  if (trackerKind !== "linear") {
    throw contextConfigError(input.contextId, `Unsupported tracker kind: ${trackerKind}`);
  }
  const apiKey = resolveConfigString(raw?.api_key, env) ?? resolveConfigString("$LINEAR_API_KEY", env) ?? "";
  if (input.requireApiKey && apiKey.length === 0) {
    throw contextConfigError(input.contextId, "Linear API key is required");
  }
  const projectSlug = resolveConfigString(raw?.project_slug, env) ?? "";
  if (input.requireProjectSlug && projectSlug.length === 0) {
    throw contextConfigError(input.contextId, "Linear project slug is required");
  }
  const assignee = resolveConfigString(raw?.assignee, env) ?? resolveConfigString("$LINEAR_ASSIGNEE", env) ?? "";
  return {
    kind: "linear",
    endpoint: raw?.endpoint ?? "https://api.linear.app/graphql",
    apiKey,
    projectSlug,
    assignee: assignee.length === 0 ? null : assignee,
    activeStates: raw?.active_states ?? DEFAULT_ACTIVE_STATES,
    handoffStates: raw?.handoff_states ?? [],
    terminalStates: raw?.terminal_states ?? DEFAULT_TERMINAL_STATES,
  };
}

function normalizeWorkspaceConfig(
  raw: RawProjectContextWorkspaceConfig | undefined,
  workflowDir: string,
  env: NodeJS.ProcessEnv,
  input: { contextId: string | null; requireGitWorktreeDetails: boolean },
): WorkspaceConfig {
  const root = resolvePathValue(raw?.root ?? "symphony_workspaces", workflowDir, env);
  const stateDir = resolvePathValue(raw?.state_dir ?? ".symphony", root, env);
  const sourceKind = raw?.source?.kind ?? "none";
  const sourcePath = raw?.source?.path === undefined ? undefined : resolvePathValue(raw.source.path, workflowDir, env);
  const sourceCachePath =
    raw?.source?.cache_path === undefined ? undefined : resolvePathValue(raw.source.cache_path, workflowDir, env);
  const sourceRepository =
    raw?.source?.repository === undefined ? undefined : resolveRepositoryValue(raw.source.repository, workflowDir, env);

  if (input.requireGitWorktreeDetails && sourceKind === "git_worktree") {
    if (!raw?.source?.repository) {
      throw contextConfigError(input.contextId, "workspace.source.repository is required for git_worktree");
    }
    if (!raw?.source?.base_ref) {
      throw contextConfigError(input.contextId, "workspace.source.base_ref is required for git_worktree");
    }
  }

  return {
    root,
    stateDir,
    source: {
      kind: sourceKind,
      ...(sourcePath === undefined ? {} : { path: sourcePath }),
      ...(sourceRepository === undefined ? {} : { repository: sourceRepository }),
      ...(raw?.source?.ref === undefined ? {} : { ref: raw.source.ref }),
      ...(raw?.source?.base_ref === undefined ? {} : { baseRef: raw.source.base_ref }),
      ...(raw?.source?.branch_template === undefined ? {} : { branchTemplate: raw.source.branch_template }),
      ...(sourceCachePath === undefined ? {} : { cachePath: sourceCachePath }),
      ...(raw?.source?.cleanup === undefined ? {} : { cleanup: raw.source.cleanup }),
    },
  };
}

function normalizeGitHubConfig(
  raw: RawProjectContextGitHubConfig | undefined,
  workflowDir: string,
  env: NodeJS.ProcessEnv,
  input: { contextId: string | null; handoffStates: string[]; reviewLoop: ReviewLoopConfig },
): GitHubConfig {
  const owner = normalizeOptionalConfigString(resolveConfigString(raw?.owner, env));
  const repo = normalizeOptionalConfigString(resolveConfigString(raw?.repo, env));
  const token = normalizeOptionalConfigString(resolveConfigString(raw?.token, env) ?? resolveConfigString("$GITHUB_TOKEN", env));
  const publishPullRequests = raw?.publish_pull_requests ?? false;
  const operatorApproval: GitHubOperatorApprovalConfig = {
    requiredForPublication: raw?.operator_approval?.required_for_publication ?? false,
    rejectPolicy: raw?.operator_approval?.reject_policy ?? "cancel",
    pollIntervalMs: raw?.operator_approval?.poll_interval_ms ?? 2_000,
    timeoutMs: raw?.operator_approval?.timeout_ms ?? null,
  };
  const prHandoff = normalizePullRequestHandoff(raw, {
    publishPullRequests,
    handoffStates: input.handoffStates,
    reviewStates: input.reviewLoop.reviewStates,
  });
  return {
    owner,
    repo,
    token,
    app: normalizeGitHubAppConfig(raw?.app, workflowDir, env),
    headOwner: normalizeOptionalConfigString(resolveConfigString(raw?.head_owner, env)) ?? owner,
    apiBaseUrl: normalizeOptionalConfigString(resolveConfigString(raw?.api_base_url, env)) ?? "https://api.github.com",
    publishPullRequests,
    operatorApproval,
    prHandoff,
  };
}

function normalizeReviewLoopConfig(
  raw: RawProjectContextReviewLoopConfig | undefined,
  handoffStates: string[],
): ReviewLoopConfig {
  return {
    reviewStates: raw?.review_states ?? handoffStates,
    blockedStates: raw?.blocked_states ?? [],
    reviewPassState: raw?.review_pass_state ?? null,
    reviewerPromptTemplate: raw?.reviewer_prompt ?? null,
    reviewerPromptExtensions: normalizePromptExtensions(raw?.reviewer_prompt_extensions),
    workerPromptExtensions: normalizePromptExtensions(raw?.worker_prompt_extensions),
    maxReviewRounds: raw?.max_review_rounds ?? 3,
    maxIncompleteTurns: raw?.max_incomplete_turns ?? 3,
    continuationHistoryThreshold: raw?.continuation_history_threshold ?? 5,
    transcriptHistoryLimit: raw?.transcript_history_limit ?? raw?.continuation_history_threshold ?? 5,
    prReviewEvidenceLimit: raw?.pr_review_evidence_limit ?? 5,
  };
}

function normalizeIssueBreakdownConfig(
  raw: RawProjectContextIssueBreakdownConfig | undefined,
  workspaceSourceKind: WorkspaceSourceConfig["kind"],
  defaultIssueBreakdownPrompt: string,
  input: { contextId: string | null },
): IssueBreakdownConfig {
  const workspaceMode = raw?.workspace_mode ?? "none";
  if (workspaceMode === "readonly_checkout") {
    if (workspaceSourceKind !== "git_worktree") {
      throw contextConfigError(
        input.contextId,
        "issue_breakdown.workspace_mode readonly_checkout requires workspace.source.kind git_worktree",
      );
    }
    if (process.platform === "win32") {
      throw contextConfigError(
        input.contextId,
        "issue_breakdown.workspace_mode readonly_checkout is not supported on Windows; use workspace_mode none",
      );
    }
  }
  return {
    enabled: raw?.enabled ?? false,
    cursorMode: raw?.cursor_mode ?? "plan",
    promptTemplate: raw?.prompt ?? defaultIssueBreakdownPrompt,
    planningLabels: normalizeLabels(raw?.planning_labels),
    applyToLinear: {
      enabled: raw?.apply_to_linear?.enabled ?? false,
      mode: raw?.apply_to_linear?.mode ?? "child_issues",
    },
    workspaceMode,
    maxPlanningFailures: raw?.max_planning_failures ?? 3,
    maxPlanningDispatchRetries: raw?.max_planning_dispatch_retries ?? raw?.max_planning_failures ?? 3,
    planningRetryBaseMs: raw?.planning_retry_base_ms ?? 5_000,
    planningRetryMaxMs: raw?.planning_retry_max_ms ?? 60_000,
  };
}

function normalizeAgentConfig(raw: RawProjectContextAgentConfig | undefined): AgentConfig {
  return {
    harness: normalizeAgentHarness(raw?.harness),
    maxConcurrentAgents: raw?.max_concurrent_agents ?? 10,
    maxTurns: raw?.max_turns ?? 20,
    maxRetryBackoffMs: raw?.max_retry_backoff_ms ?? 300_000,
    maxSdkErrorRetries: raw?.max_sdk_error_retries ?? 2,
    maxInfraFailures: raw?.max_infra_failures ?? 3,
    maxConcurrentAgentsByState: normalizeStateLimitMap(raw?.max_concurrent_agents_by_state),
    requireLabels: normalizeLabels(raw?.require_labels),
    excludeLabels: normalizeLabels(raw?.exclude_labels),
    protectedPaths: (raw?.protected_paths ?? []).map((item) => item.trim()).filter((item) => item.length > 0),
  };
}

function normalizeCredentialAssignments(
  base: RawCredentialRoleAssignmentsConfig | undefined,
  override?: RawCredentialRoleAssignmentsConfig,
): ProjectContextCredentialAssignments {
  const merged = mergeRoleAssignments(base, override);
  return {
    worker: { ...(merged.worker ?? {}) },
    reviewer: { ...(merged.reviewer ?? {}) },
    service: { ...(merged.service ?? {}) },
  };
}

function mergeRoleAssignments(
  base: RawCredentialRoleAssignmentsConfig | undefined,
  override: RawCredentialRoleAssignmentsConfig | undefined,
): RawCredentialRoleAssignmentsConfig {
  return {
    ...(base ?? {}),
    ...(override ?? {}),
    worker: { ...(base?.worker ?? {}), ...(override?.worker ?? {}) },
    reviewer: { ...(base?.reviewer ?? {}), ...(override?.reviewer ?? {}) },
    service: { ...(base?.service ?? {}), ...(override?.service ?? {}) },
  };
}

function buildCodebaseIdentity(workspace: WorkspaceConfig): ProjectContextCodebaseIdentity {
  return {
    sourceKind: workspace.source.kind,
    label: buildCodebaseLabel(workspace),
    workspaceRoot: workspace.root,
    stateDir: workspace.stateDir,
    repository: workspace.source.repository ?? null,
    path: workspace.source.path ?? null,
    baseRef: workspace.source.baseRef ?? null,
  };
}

function buildCodebaseLabel(workspace: WorkspaceConfig): string {
  if (workspace.source.repository) return workspace.source.repository;
  if (workspace.source.path) return workspace.source.path;
  return workspace.root;
}

function validateWorkspaceSourceForEnabledContext(contextId: string, source: WorkspaceSourceConfig): void {
  if (source.kind === "none") {
    throw contextConfigError(contextId, "enabled project contexts require workspace.source.kind other than none");
  }
  if (source.kind === "copy" && !source.path) {
    throw contextConfigError(contextId, "workspace.source.path is required for copy project contexts");
  }
  if (source.kind === "git" && !source.repository) {
    throw contextConfigError(contextId, "workspace.source.repository is required for git project contexts");
  }
  if (source.kind === "git_worktree" && !source.repository) {
    throw contextConfigError(contextId, "workspace.source.repository is required for git_worktree project contexts");
  }
  if (source.kind === "git_worktree" && !source.baseRef) {
    throw contextConfigError(contextId, "workspace.source.base_ref is required for git_worktree project contexts");
  }
}

function publicGitHubAppMetadata(app: GitHubAppConfig | null): PublicGitHubAppMetadata | null {
  if (app === null) return null;
  return {
    appId: app.appId,
    clientId: app.clientId,
    installationId: app.installationId,
    privateKey:
      app.privateKeyEnvVar !== null
        ? { kind: "env", name: app.privateKeyEnvVar }
        : app.privateKey !== null
          ? { kind: "inline", redacted: true }
          : null,
    privateKeyPath: app.privateKeyPath,
    tokenRefreshBufferSeconds: app.tokenRefreshBufferSeconds,
  };
}

function mergeConfigSection<T>(base: T | undefined, override: T | undefined): T | undefined {
  if (base === undefined) return override;
  if (override === undefined) return base;
  if (Array.isArray(base) || Array.isArray(override)) return override;
  if (isRecord(base) && isRecord(override)) {
    const result: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(override)) {
      const existing = result[key];
      result[key] = mergeConfigSection(existing, value);
    }
    return result as T;
  }
  return override;
}

function normalizePullRequestHandoff(
  raw: RawProjectContextGitHubConfig | undefined,
  input: { publishPullRequests: boolean; handoffStates: string[]; reviewStates: string[] },
): GitHubPullRequestHandoffConfig {
  const rawPolicy = raw?.pr_handoff;
  const noCiEvidence = normalizeOptionalConfigString(rawPolicy?.no_ci?.evidence);
  if (rawPolicy?.no_ci?.allowed === true && noCiEvidence === null) {
    throw new SymphonyError(
      "config_validation_error",
      "github.pr_handoff.no_ci.evidence is required when github.pr_handoff.no_ci.allowed is true",
    );
  }
  return {
    enabled: rawPolicy?.enabled ?? input.publishPullRequests,
    targetState: normalizeOptionalConfigString(rawPolicy?.target_state) ?? input.handoffStates[0] ?? null,
    allowDrafts: rawPolicy?.allow_drafts ?? false,
    requiredChecks: normalizeRequiredChecks(rawPolicy?.required_checks ?? []),
    noCiAllowed: rawPolicy?.no_ci?.allowed ?? false,
    noCiEvidence,
  };
}

function validatePullRequestHandoffPolicy(input: {
  contextId: string | null;
  publishPullRequests: boolean;
  handoffStates: string[];
  reviewStates: string[];
  blockedStates: string[];
  reviewPassState: string | null;
  prHandoff: GitHubPullRequestHandoffConfig;
}): void {
  if (!input.prHandoff.enabled) return;
  if (!input.publishPullRequests) {
    throw contextConfigError(
      input.contextId,
      "github.pr_handoff.enabled requires github.publish_pull_requests until a service PR verifier is configured",
    );
  }
  if (input.prHandoff.targetState === null) {
    throw contextConfigError(input.contextId, "github.pr_handoff.target_state must resolve to a tracker.handoff_states value");
  }
  if (!input.handoffStates.some((state) => statesEqual(state, input.prHandoff.targetState ?? ""))) {
    throw contextConfigError(
      input.contextId,
      `github.pr_handoff.target_state must be listed in tracker.handoff_states: ${input.prHandoff.targetState}`,
    );
  }
  const reviewOverlap = overlappingStates(input.handoffStates, input.reviewStates);
  if (reviewOverlap.length > 0) {
    throw contextConfigError(
      input.contextId,
      `tracker.handoff_states must not overlap review_loop.review_states when github.pr_handoff is enabled: ${reviewOverlap.join(", ")}`,
    );
  }
  const blockedOverlap = overlappingStates(input.handoffStates, input.blockedStates);
  if (blockedOverlap.length > 0) {
    throw contextConfigError(
      input.contextId,
      `tracker.handoff_states must not overlap review_loop.blocked_states when github.pr_handoff is enabled: ${blockedOverlap.join(", ")}`,
    );
  }
  const passOverlap = input.reviewPassState === null ? [] : overlappingStates(input.handoffStates, [input.reviewPassState]);
  if (passOverlap.length > 0) {
    throw contextConfigError(
      input.contextId,
      `tracker.handoff_states must not overlap review_loop.review_pass_state when github.pr_handoff is enabled: ${passOverlap.join(", ")}`,
    );
  }
  if (input.prHandoff.requiredChecks.length === 0 && !input.prHandoff.noCiAllowed) {
    throw contextConfigError(
      input.contextId,
      "github.pr_handoff.required_checks is required when PR publication handoff is enabled unless github.pr_handoff.no_ci.allowed is true",
    );
  }
}

function validateStateBuckets(input: {
  contextId: string | null;
  activeStates: string[];
  handoffStates: string[];
  terminalStates: string[];
  reviewStates: string[];
  blockedStates: string[];
  reviewPassState: string | null;
}): void {
  const activeHandoffOverlap = overlappingStates(input.activeStates, input.handoffStates);
  if (activeHandoffOverlap.length > 0) {
    throw contextConfigError(
      input.contextId,
      `tracker.handoff_states must not overlap tracker.active_states: ${activeHandoffOverlap.join(", ")}`,
    );
  }
  const terminalHandoffOverlap = overlappingStates(input.terminalStates, input.handoffStates);
  if (terminalHandoffOverlap.length > 0) {
    throw contextConfigError(
      input.contextId,
      `tracker.handoff_states must not overlap tracker.terminal_states: ${terminalHandoffOverlap.join(", ")}`,
    );
  }
  const passStates = input.reviewPassState === null ? [] : [input.reviewPassState];
  const buckets = [
    ["tracker.active_states", input.activeStates],
    ["tracker.terminal_states", input.terminalStates],
    ["review_loop.blocked_states", input.blockedStates],
    ["review_loop.review_states", input.reviewStates],
    ["review_loop.review_pass_state", passStates],
  ] as const;
  for (let leftIndex = 0; leftIndex < buckets.length; leftIndex += 1) {
    const [leftName, leftStates] = buckets[leftIndex] ?? ["", []];
    for (let rightIndex = leftIndex + 1; rightIndex < buckets.length; rightIndex += 1) {
      const [rightName, rightStates] = buckets[rightIndex] ?? ["", []];
      const overlap = overlappingStates(leftStates, rightStates);
      if (overlap.length > 0) {
        throw contextConfigError(input.contextId, `${leftName} must not overlap ${rightName}: ${overlap.join(", ")}`);
      }
    }
  }
}

function normalizeGitHubAppConfig(
  rawApp: RawProjectContextGitHubConfig["app"],
  workflowDir: string,
  env: NodeJS.ProcessEnv,
): GitHubAppConfig | null {
  const appId = normalizeOptionalConfigString(resolveConfigString(rawApp?.app_id ?? "$GITHUB_APP_ID", env));
  const clientId = normalizeOptionalConfigString(resolveConfigString(rawApp?.client_id ?? "$GITHUB_APP_CLIENT_ID", env));
  const installationId = normalizeOptionalConfigString(
    resolveConfigString(rawApp?.installation_id ?? "$GITHUB_APP_INSTALLATION_ID", env),
  );
  const privateKey = normalizeGitHubAppPrivateKey(rawApp?.private_key, env);
  const privateKeyPath = normalizeGitHubAppPrivateKeyPath(rawApp?.private_key_path, workflowDir, env);
  const tokenRefreshBufferSeconds = rawApp?.token_refresh_buffer_seconds ?? DEFAULT_GITHUB_APP_TOKEN_REFRESH_BUFFER_SECONDS;
  const hasExplicitConfig = rawApp !== undefined;
  const hasEnvironmentConfig = Boolean(appId || installationId || privateKey.value || privateKey.envVar || privateKeyPath);
  if (!hasExplicitConfig && !hasEnvironmentConfig) return null;
  return {
    appId,
    clientId,
    installationId,
    privateKey: privateKey.value,
    privateKeyEnvVar: privateKey.envVar,
    privateKeyPath,
    tokenRefreshBufferSeconds,
  };
}

interface NormalizedGitHubAppPrivateKey {
  value: string | null;
  envVar: string | null;
}

function normalizeGitHubAppPrivateKey(value: string | undefined, env: NodeJS.ProcessEnv): NormalizedGitHubAppPrivateKey {
  if (value !== undefined) {
    const envReference = ENV_REFERENCE_PATTERN.exec(value.trim());
    if (envReference?.[1]) {
      return { value: null, envVar: envReference[1] };
    }
    return { value: normalizeOptionalConfigString(value), envVar: null };
  }
  return normalizeOptionalConfigString(env.GITHUB_APP_PRIVATE_KEY) === null
    ? { value: null, envVar: null }
    : { value: null, envVar: "GITHUB_APP_PRIVATE_KEY" };
}

function normalizeGitHubAppPrivateKeyPath(
  value: string | undefined,
  workflowDir: string,
  env: NodeJS.ProcessEnv,
): string | null {
  const rawPath = value ?? "$GITHUB_APP_PRIVATE_KEY_PATH";
  const resolvedPath = normalizeOptionalConfigString(resolveConfigString(rawPath, env));
  if (resolvedPath === null) return null;
  return resolvePathValue(resolvedPath, workflowDir, env);
}

function normalizeLabels(input: string[] | undefined): string[] {
  return [...new Set((input ?? []).map((label) => label.trim().toLowerCase()).filter((label) => label.length > 0))];
}

function normalizePromptExtensions(input: string[] | undefined): string[] {
  return (input ?? []).map((item) => item.trim()).filter((item) => item.length > 0);
}

function normalizeRequiredChecks(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function normalizeStateLimitMap(input: Record<string, number> | undefined): Map<string, number> {
  const result = new Map<string, number>();
  for (const [state, limit] of Object.entries(input ?? {})) {
    if (Number.isFinite(limit) && limit > 0) {
      result.set(state.toLowerCase(), Math.floor(limit));
    }
  }
  return result;
}

function normalizeAgentHarness(value: string | undefined): AgentHarnessKind {
  const harness = (value ?? "cursor").trim();
  if (harness.length > 0) return harness;
  throw new SymphonyError("config_validation_error", "agent.harness must be a nonempty runtime harness id");
}

function normalizeOptionalConfigString(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
}

function resolveConfigString(value: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (value === undefined) return undefined;
  const varMatch = ENV_REFERENCE_PATTERN.exec(value);
  if (varMatch) return env[varMatch[1] ?? ""] ?? "";
  return value;
}

function resolvePathValue(value: string, baseDir: string, env: NodeJS.ProcessEnv): string {
  const resolvedVariable = resolveConfigString(value, env) ?? "";
  const homeExpanded =
    resolvedVariable === "~" || resolvedVariable.startsWith(`~${path.sep}`)
      ? path.join(os.homedir(), resolvedVariable.slice(2))
      : resolvedVariable;
  return path.resolve(baseDir, homeExpanded);
}

function resolveRepositoryValue(value: string, baseDir: string, env: NodeJS.ProcessEnv): string {
  const resolved = resolveConfigString(value, env) ?? "";
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(resolved)) return resolved;
  if (/^[^/\\]+@[^:]+:.+/.test(resolved)) return resolved;
  return resolvePathValue(resolved, baseDir, env);
}

function contextConfigError(contextId: string | null, message: string): SymphonyError {
  return new SymphonyError(
    "config_validation_error",
    contextId === null ? message : `project context ${contextId}: ${message}`,
  );
}

function overlappingStates(left: string[], right: string[]): string[] {
  const rightSet = new Set(right.map((state) => state.toLowerCase()));
  return left.filter((state) => rightSet.has(state.toLowerCase()));
}

function statesEqual(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

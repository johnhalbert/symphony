import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { SymphonyError } from "../errors.js";
import type { IssueBoardColumnId, IssueBoardColumnMapping } from "../types.js";
import {
  createCredentialProfileRegistry,
  rawCredentialProfilesSchema,
  type CredentialProfileRegistry,
} from "./CredentialProfiles.js";

const stringArray = z.array(z.string());

const rawConfigSchema = z
  .object({
    tracker: z
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
      .passthrough()
      .optional(),
    review_loop: z
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
      .passthrough()
      .optional(),
    merge_policy: z
      .object({
        enabled: z.boolean().optional(),
        mode: z.enum(["disabled", "manual", "gated"]).optional(),
        source_states: stringArray.optional(),
        conflicts_state: z.string().optional(),
        max_conflict_fix_turns: z.number().int().positive().optional(),
        done_state: z.string().optional(),
        merge_method: z.enum(["merge", "squash", "rebase"]).optional(),
        required_checks: stringArray.optional(),
        missing_check_stabilization_ms: z.number().int().nonnegative().optional(),
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
    issue_board: z
      .object({
        columns: z
          .object({
            backlog: stringArray.optional(),
            todo: stringArray.optional(),
            progress: stringArray.optional(),
            review: stringArray.optional(),
            done: stringArray.optional(),
            canceled: stringArray.optional(),
          })
          .strict()
          .optional(),
      })
      .passthrough()
      .optional(),
    continuation_context: z
      .object({
        search_enabled: z.boolean().optional(),
        summarization_enabled: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    issue_breakdown: z
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
      .passthrough()
      .optional(),
    polling: z
      .object({
        interval_ms: z.number().int().positive().optional(),
      })
      .passthrough()
      .optional(),
    workspace: z
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
      .passthrough()
      .optional(),
    hooks: z
      .object({
        after_create: z.string().optional(),
        before_run: z.string().optional(),
        after_run: z.string().optional(),
        before_remove: z.string().optional(),
        timeout_ms: z.number().int().positive().optional(),
      })
      .passthrough()
      .optional(),
    agent: z
      .object({
        harness: z.string().optional(),
        max_concurrent_agents: z.number().int().positive().optional(),
        max_turns: z.number().int().positive().optional(),
        max_retry_backoff_ms: z.number().int().positive().optional(),
        max_sdk_error_retries: z.number().int().nonnegative().optional(),
        max_concurrent_agents_by_state: z.record(z.string(), z.number()).optional(),
        require_labels: stringArray.optional(),
        exclude_labels: stringArray.optional(),
        protected_paths: stringArray.optional(),
      })
      .passthrough()
      .optional(),
    cursor: z
      .object({
        model: z.string().optional(),
        mode: z.enum(["agent", "plan"]).optional(),
        model_params: z.record(z.string(), z.string()).optional(),
        setting_sources: z.array(z.string()).optional(),
        opener_command: z.string().optional(),
        allow_large_context: z.boolean().optional(),
        worker_agent_lifecycle: z.enum(["fresh_per_run", "resume_by_issue"]).optional(),
      })
      .passthrough()
      .optional(),
    server: z
      .object({
        port: z.number().int().min(0).optional(),
        host: z.string().optional(),
        open_workspace_token: z.string().optional(),
      })
      .passthrough()
      .optional(),
    writeback: z
      .object({
        enabled: z.boolean().optional(),
        mode: z.enum(["live", "dry_run"]).optional(),
        dispatch_state: z.string().optional(),
        max_backoff_ms: z.number().int().positive().optional(),
      })
      .passthrough()
      .optional(),
    github: z
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
      .passthrough()
      .optional(),
    credential_profiles: rawCredentialProfilesSchema.optional(),
  })
  .passthrough();

export type RawWorkflowConfig = z.infer<typeof rawConfigSchema>;

export interface TrackerConfig {
  kind: "linear";
  endpoint: string;
  apiKey: string;
  projectSlug: string;
  assignee: string | null;
  activeStates: string[];
  handoffStates: string[];
  terminalStates: string[];
}

export interface WorkspaceSourceConfig {
  kind: "none" | "copy" | "git" | "git_worktree";
  path?: string;
  repository?: string;
  ref?: string;
  baseRef?: string;
  branchTemplate?: string;
  cachePath?: string;
  cleanup?: "refuse_dirty" | "force";
}

export interface WorkspaceConfig {
  root: string;
  stateDir: string;
  source: WorkspaceSourceConfig;
}

export interface HookConfig {
  afterCreate: string | null;
  beforeRun: string | null;
  afterRun: string | null;
  beforeRemove: string | null;
  timeoutMs: number;
}

export interface AgentConfig {
  harness: AgentHarnessKind;
  maxConcurrentAgents: number;
  maxTurns: number;
  maxRetryBackoffMs: number;
  maxSdkErrorRetries: number;
  maxConcurrentAgentsByState: Map<string, number>;
  requireLabels: string[];
  excludeLabels: string[];
  protectedPaths: string[];
}

export type AgentHarnessKind = "cursor";

export type CursorSettingSource =
  | "project"
  | "user"
  | "team"
  | "mdm"
  | "plugins"
  | "all";

export interface CursorConfig {
  model: string;
  mode: CursorConversationMode | null;
  modelParams: CursorModelParameter[];
  settingSources: CursorSettingSource[];
  openerCommand: string | null;
  allowLargeContext: boolean;
  workerAgentLifecycle: CursorWorkerAgentLifecycle;
}

export type CursorConversationMode = "agent" | "plan";
export type CursorWorkerAgentLifecycle = "fresh_per_run" | "resume_by_issue";

export interface CursorModelParameter {
  id: string;
  value: string;
}

export interface ServerConfig {
  port: number | null;
  host: string;
  openWorkspaceToken: string | null;
}

export interface WritebackConfig {
  enabled: boolean;
  mode: "live" | "dry_run";
  dispatchState: string;
  maxBackoffMs: number;
}

export interface GitHubConfig {
  owner: string | null;
  repo: string | null;
  token: string | null;
  app: GitHubAppConfig | null;
  headOwner: string | null;
  apiBaseUrl: string;
  publishPullRequests: boolean;
  operatorApproval?: GitHubOperatorApprovalConfig;
  prHandoff: GitHubPullRequestHandoffConfig;
}

export interface GitHubAppConfig {
  appId: string | null;
  clientId: string | null;
  installationId: string | null;
  privateKey: string | null;
  privateKeyEnvVar: string | null;
  privateKeyPath: string | null;
  tokenRefreshBufferSeconds: number;
}

export interface GitHubOperatorApprovalConfig {
  requiredForPublication: boolean;
  rejectPolicy: "cancel" | "fail";
  pollIntervalMs: number;
  timeoutMs: number | null;
}

export interface GitHubPullRequestHandoffConfig {
  enabled: boolean;
  targetState: string | null;
  allowDrafts: boolean;
  requiredChecks: string[];
  noCiAllowed: boolean;
  noCiEvidence: string | null;
}

export interface ReviewLoopConfig {
  reviewStates: string[];
  blockedStates: string[];
  reviewPassState: string | null;
  reviewerPromptTemplate: string | null;
  reviewerPromptExtensions: string[];
  workerPromptExtensions: string[];
  maxReviewRounds: number;
  maxIncompleteTurns: number;
  continuationHistoryThreshold: number;
  transcriptHistoryLimit: number;
  prReviewEvidenceLimit: number;
}

export interface MergePolicyConfig {
  mode: "disabled" | "manual" | "gated";
  sourceStates: string[];
  conflictsState: string | null;
  maxConflictFixTurns: number;
  doneState: string;
  mergeMethod: "merge" | "squash" | "rebase";
  requiredChecks: string[];
  missingCheckStabilizationMs: number;
  noCiAllowed: boolean;
  noCiEvidence: string | null;
}

export interface ContinuationContextConfig {
  searchEnabled: boolean;
  summarizationEnabled: boolean;
}

export interface IssueBreakdownConfig {
  enabled: boolean;
  cursorMode: CursorConversationMode;
  promptTemplate: string;
  planningLabels: string[];
  applyToLinear: {
    enabled: boolean;
    mode: "child_issues";
  };
  workspaceMode: "none" | "readonly_checkout";
  maxPlanningFailures: number;
  maxPlanningDispatchRetries: number;
  planningRetryBaseMs: number;
  planningRetryMaxMs: number;
}

export interface IssueBoardConfig {
  columns: IssueBoardColumnMapping;
}

export interface ServiceConfig {
  workflowPath: string;
  workflowDir: string;
  tracker: TrackerConfig;
  polling: {
    intervalMs: number;
  };
  workspace: WorkspaceConfig;
  hooks: HookConfig;
  agent: AgentConfig;
  cursor: CursorConfig;
  server: ServerConfig;
  writeback: WritebackConfig;
  github: GitHubConfig;
  credentialProfiles: CredentialProfileRegistry;
  reviewLoop: ReviewLoopConfig;
  mergePolicy: MergePolicyConfig;
  issueBoard: IssueBoardConfig;
  continuationContext: ContinuationContextConfig;
  issueBreakdown: IssueBreakdownConfig;
  raw: RawWorkflowConfig;
}

const DEFAULT_ACTIVE_STATES = ["Todo", "In Progress"];
const DEFAULT_TERMINAL_STATES = ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"];
const VALID_CURSOR_SETTING_SOURCES = new Set<CursorSettingSource>([
  "project",
  "user",
  "team",
  "mdm",
  "plugins",
  "all",
]);
const VALID_AGENT_HARNESSES = new Set<AgentHarnessKind>(["cursor"]);
const DEFAULT_CURSOR_MODEL = "gpt-5.5";
const DEFAULT_CURSOR_MODEL_PARAMS: CursorModelParameter[] = [
  { id: "context", value: "272k" },
  { id: "reasoning", value: "extra-high" },
];
const DEFAULT_GITHUB_APP_TOKEN_REFRESH_BUFFER_SECONDS = 300;
const DEFAULT_ISSUE_BREAKDOWN_PROMPT = [
  "Break down {{ issue.identifier }} before implementation.",
  "",
  "Inspect the issue and repository context only. Do not edit files, create commits, push branches, comment on Linear, transition Linear state, or submit a completion report.",
  "",
  "Before ending the run, call submit_issue_breakdown_plan with a concise summary, an idempotencyKey, and proposedIssues[].",
  "Each proposed issue must include title, description, acceptanceCriteria[], dependencies[], and labels[].",
  "Symphony persists these proposals locally; do not create or modify Linear issues.",
].join("\n");

export function parseServiceConfig(rawInput: unknown, workflowPath: string, env = process.env): ServiceConfig {
  const parsed = rawConfigSchema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    throw new SymphonyError("config_validation_error", "Workflow config is invalid", parsed.error.flatten());
  }

  const raw = parsed.data;
  const workflowDir = path.dirname(path.resolve(workflowPath));
  const trackerKind = raw.tracker?.kind ?? "linear";
  if (trackerKind !== "linear") {
    throw new SymphonyError("unsupported_tracker_kind", `Unsupported tracker kind: ${trackerKind}`);
  }

  const trackerApiKey =
    resolveConfigString(raw.tracker?.api_key, env) ?? resolveConfigString("$LINEAR_API_KEY", env) ?? "";
  if (trackerApiKey.length === 0) {
    throw new SymphonyError("missing_tracker_api_key", "Linear API key is required");
  }

  const projectSlug = resolveConfigString(raw.tracker?.project_slug, env) ?? "";
  if (projectSlug.length === 0) {
    throw new SymphonyError("missing_tracker_project_slug", "Linear project slug is required");
  }
  const trackerAssignee =
    resolveConfigString(raw.tracker?.assignee, env) ?? resolveConfigString("$LINEAR_ASSIGNEE", env) ?? "";

  const workspaceRoot = resolvePathValue(raw.workspace?.root ?? "symphony_workspaces", workflowDir, env);
  const workspaceStateDir = resolvePathValue(raw.workspace?.state_dir ?? ".symphony", workspaceRoot, env);
  const sourceKind = raw.workspace?.source?.kind ?? "none";
  const sourcePath =
    raw.workspace?.source?.path === undefined
      ? undefined
      : resolvePathValue(raw.workspace.source.path, workflowDir, env);
  const sourceCachePath =
    raw.workspace?.source?.cache_path === undefined
      ? undefined
      : resolvePathValue(raw.workspace.source.cache_path, workflowDir, env);
  const sourceRepository =
    raw.workspace?.source?.repository === undefined
      ? undefined
      : resolveRepositoryValue(raw.workspace.source.repository, workflowDir, env);

  if (sourceKind === "git_worktree") {
    if (!raw.workspace?.source?.repository) {
      throw new SymphonyError("config_validation_error", "workspace.source.repository is required for git_worktree");
    }
    if (!raw.workspace?.source?.base_ref) {
      throw new SymphonyError("config_validation_error", "workspace.source.base_ref is required for git_worktree");
    }
  }
  const issueBreakdownWorkspaceMode = raw.issue_breakdown?.workspace_mode ?? "none";
  if (issueBreakdownWorkspaceMode === "readonly_checkout") {
    if (sourceKind !== "git_worktree") {
      throw new SymphonyError(
        "config_validation_error",
        "issue_breakdown.workspace_mode readonly_checkout requires workspace.source.kind git_worktree",
      );
    }
    if (process.platform === "win32") {
      throw new SymphonyError(
        "config_validation_error",
        "issue_breakdown.workspace_mode readonly_checkout is not supported on Windows; use workspace_mode none",
      );
    }
  }

  const workspaceSource: WorkspaceSourceConfig = {
    kind: sourceKind,
    ...(sourcePath === undefined ? {} : { path: sourcePath }),
    ...(sourceRepository === undefined ? {} : { repository: sourceRepository }),
    ...(raw.workspace?.source?.ref === undefined ? {} : { ref: raw.workspace.source.ref }),
    ...(raw.workspace?.source?.base_ref === undefined ? {} : { baseRef: raw.workspace.source.base_ref }),
    ...(raw.workspace?.source?.branch_template === undefined
      ? {}
      : { branchTemplate: raw.workspace.source.branch_template }),
    ...(sourceCachePath === undefined ? {} : { cachePath: sourceCachePath }),
    ...(raw.workspace?.source?.cleanup === undefined ? {} : { cleanup: raw.workspace.source.cleanup }),
  };

  const agentHarness = normalizeAgentHarness(raw.agent?.harness);
  const agentMaxTurns = raw.agent?.max_turns ?? 20;
  const activeStates = raw.tracker?.active_states ?? DEFAULT_ACTIVE_STATES;
  const handoffStates = raw.tracker?.handoff_states ?? [];
  const terminalStates = raw.tracker?.terminal_states ?? DEFAULT_TERMINAL_STATES;
  const githubOwner = normalizeOptionalConfigString(resolveConfigString(raw.github?.owner, env));
  const githubRepo = normalizeOptionalConfigString(resolveConfigString(raw.github?.repo, env));
  const githubToken = normalizeOptionalConfigString(
    resolveConfigString(raw.github?.token, env) ?? resolveConfigString("$GITHUB_TOKEN", env),
  );
  const githubApp = normalizeGitHubAppConfig(raw.github?.app, workflowDir, env);
  const githubHeadOwner = normalizeOptionalConfigString(resolveConfigString(raw.github?.head_owner, env)) ?? githubOwner;
  const publishPullRequests = raw.github?.publish_pull_requests ?? false;
  const githubOperatorApproval = {
    requiredForPublication: raw.github?.operator_approval?.required_for_publication ?? false,
    rejectPolicy: raw.github?.operator_approval?.reject_policy ?? "cancel",
    pollIntervalMs: raw.github?.operator_approval?.poll_interval_ms ?? 2_000,
    timeoutMs: raw.github?.operator_approval?.timeout_ms ?? null,
  };
  const cursorModel = raw.cursor?.model ?? DEFAULT_CURSOR_MODEL;
  const cursorModelParams = normalizeCursorModelParams(raw.cursor?.model_params);
  const cursorAllowLargeContext = raw.cursor?.allow_large_context ?? false;
  validateCursorModelPolicy(cursorModel, cursorModelParams, cursorAllowLargeContext);
  const cursorRuntimeApiKey = normalizeOptionalConfigString(resolveConfigString("$CURSOR_API_KEY", env));
  const serverOpenWorkspaceToken = resolveConfigString(raw.server?.open_workspace_token, env) ?? null;
  const credentialProfiles = createCredentialProfileRegistry({
    raw: raw.credential_profiles,
    env,
    fallbacks: {
      githubToken,
      linearApiKey: trackerApiKey,
      cursorRuntimeApiKey,
      openWorkspaceToken: serverOpenWorkspaceToken,
    },
  });
  const reviewStates = raw.review_loop?.review_states ?? handoffStates;
  const blockedStates = raw.review_loop?.blocked_states ?? [];
  const reviewPassState = raw.review_loop?.review_pass_state ?? null;
  const pullRequestHandoff = normalizePullRequestHandoff(raw, {
    publishPullRequests,
    handoffStates,
    reviewStates,
  });
  const mergePolicy = normalizeMergePolicy(raw, reviewPassState);
  validateStateBuckets({
    activeStates,
    handoffStates,
    terminalStates,
    reviewStates,
    blockedStates,
    reviewPassState,
  });
  validateMergePolicyStateBuckets({
    activeStates,
    handoffStates,
    terminalStates,
    reviewStates,
    blockedStates,
    reviewPassState,
    mergePolicy,
  });
  validatePullRequestHandoffPolicy({
    publishPullRequests,
    handoffStates,
    reviewStates,
    blockedStates,
    reviewPassState,
    prHandoff: pullRequestHandoff,
  });
  const issueBoard = normalizeIssueBoardColumns(raw, {
    activeStates,
    handoffStates,
    terminalStates,
    reviewStates,
    blockedStates,
    reviewPassState,
    mergePolicy,
  });

  return {
    workflowPath: path.resolve(workflowPath),
    workflowDir,
    tracker: {
      kind: "linear",
      endpoint: raw.tracker?.endpoint ?? "https://api.linear.app/graphql",
      apiKey: trackerApiKey,
      projectSlug,
      assignee: trackerAssignee.length === 0 ? null : trackerAssignee,
      activeStates,
      handoffStates,
      terminalStates,
    },
    polling: {
      intervalMs: raw.polling?.interval_ms ?? 30_000,
    },
    workspace: {
      root: workspaceRoot,
      stateDir: workspaceStateDir,
      source: workspaceSource,
    },
    hooks: {
      afterCreate: raw.hooks?.after_create ?? null,
      beforeRun: raw.hooks?.before_run ?? null,
      afterRun: raw.hooks?.after_run ?? null,
      beforeRemove: raw.hooks?.before_remove ?? null,
      timeoutMs: raw.hooks?.timeout_ms ?? 60_000,
    },
    agent: {
      harness: agentHarness,
      maxConcurrentAgents: raw.agent?.max_concurrent_agents ?? 10,
      maxTurns: agentMaxTurns,
      maxRetryBackoffMs: raw.agent?.max_retry_backoff_ms ?? 300_000,
      maxSdkErrorRetries: raw.agent?.max_sdk_error_retries ?? 2,
      maxConcurrentAgentsByState: normalizeStateLimitMap(raw.agent?.max_concurrent_agents_by_state),
      requireLabels: normalizeLabels(raw.agent?.require_labels),
      excludeLabels: normalizeLabels(raw.agent?.exclude_labels),
      protectedPaths: raw.agent?.protected_paths ?? [],
    },
    cursor: {
      model: cursorModel,
      mode: raw.cursor?.mode ?? null,
      modelParams: cursorModelParams,
      settingSources: normalizeCursorSettingSources(raw.cursor?.setting_sources),
      openerCommand: raw.cursor?.opener_command ?? null,
      allowLargeContext: cursorAllowLargeContext,
      workerAgentLifecycle: raw.cursor?.worker_agent_lifecycle ?? "fresh_per_run",
    },
    server: {
      port: raw.server?.port ?? null,
      host: raw.server?.host ?? "127.0.0.1",
      openWorkspaceToken: serverOpenWorkspaceToken,
    },
    writeback: {
      enabled: raw.writeback?.enabled ?? false,
      mode: raw.writeback?.mode ?? "dry_run",
      dispatchState: raw.writeback?.dispatch_state ?? "In Progress",
      maxBackoffMs: raw.writeback?.max_backoff_ms ?? 300_000,
    },
    github: {
      owner: githubOwner,
      repo: githubRepo,
      token: githubToken,
      app: githubApp,
      headOwner: githubHeadOwner,
      apiBaseUrl: normalizeOptionalConfigString(resolveConfigString(raw.github?.api_base_url, env)) ?? "https://api.github.com",
      publishPullRequests,
      operatorApproval: githubOperatorApproval,
      prHandoff: pullRequestHandoff,
    },
    credentialProfiles,
    reviewLoop: {
      reviewStates,
      blockedStates,
      reviewPassState,
      reviewerPromptTemplate: raw.review_loop?.reviewer_prompt ?? null,
      reviewerPromptExtensions: normalizePromptExtensions(raw.review_loop?.reviewer_prompt_extensions),
      workerPromptExtensions: normalizePromptExtensions(raw.review_loop?.worker_prompt_extensions),
      maxReviewRounds: raw.review_loop?.max_review_rounds ?? 3,
      maxIncompleteTurns: raw.review_loop?.max_incomplete_turns ?? 3,
      continuationHistoryThreshold: raw.review_loop?.continuation_history_threshold ?? 5,
      transcriptHistoryLimit: raw.review_loop?.transcript_history_limit ?? raw.review_loop?.continuation_history_threshold ?? 5,
      prReviewEvidenceLimit: raw.review_loop?.pr_review_evidence_limit ?? 5,
    },
    mergePolicy,
    issueBoard: {
      columns: issueBoard,
    },
    continuationContext: {
      searchEnabled: raw.continuation_context?.search_enabled ?? false,
      summarizationEnabled: raw.continuation_context?.summarization_enabled ?? false,
    },
    issueBreakdown: {
      enabled: raw.issue_breakdown?.enabled ?? false,
      cursorMode: raw.issue_breakdown?.cursor_mode ?? "plan",
      promptTemplate: raw.issue_breakdown?.prompt ?? DEFAULT_ISSUE_BREAKDOWN_PROMPT,
      planningLabels: normalizeLabels(raw.issue_breakdown?.planning_labels),
      applyToLinear: {
        enabled: raw.issue_breakdown?.apply_to_linear?.enabled ?? false,
        mode: raw.issue_breakdown?.apply_to_linear?.mode ?? "child_issues",
      },
      workspaceMode: issueBreakdownWorkspaceMode,
      maxPlanningFailures: raw.issue_breakdown?.max_planning_failures ?? 3,
      maxPlanningDispatchRetries:
        raw.issue_breakdown?.max_planning_dispatch_retries ?? raw.issue_breakdown?.max_planning_failures ?? 3,
      planningRetryBaseMs: raw.issue_breakdown?.planning_retry_base_ms ?? 5_000,
      planningRetryMaxMs: raw.issue_breakdown?.planning_retry_max_ms ?? 60_000,
    },
    raw,
  };
}

export function resolveConfigString(value: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (value === undefined) return undefined;
  const varMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
  if (varMatch) return env[varMatch[1] ?? ""] ?? "";
  return value;
}

export function resolvePathValue(value: string, baseDir: string, env: NodeJS.ProcessEnv): string {
  const resolvedVariable = resolveConfigString(value, env) ?? "";
  const homeExpanded =
    resolvedVariable === "~" || resolvedVariable.startsWith(`~${path.sep}`)
      ? path.join(os.homedir(), resolvedVariable.slice(2))
      : resolvedVariable;
  return path.resolve(baseDir, homeExpanded);
}

function normalizeGitHubAppConfig(
  rawApp: NonNullable<RawWorkflowConfig["github"]>["app"],
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
  const tokenRefreshBufferSeconds =
    rawApp?.token_refresh_buffer_seconds ?? DEFAULT_GITHUB_APP_TOKEN_REFRESH_BUFFER_SECONDS;

  const hasExplicitConfig = rawApp !== undefined;
  const hasEnvironmentConfig = Boolean(
    appId ||
      clientId ||
      installationId ||
      privateKey.value ||
      privateKey.envVar ||
      privateKeyPath ||
      env.GITHUB_APP_ID ||
      env.GITHUB_APP_CLIENT_ID ||
      env.GITHUB_APP_INSTALLATION_ID ||
      env.GITHUB_APP_PRIVATE_KEY ||
      env.GITHUB_APP_PRIVATE_KEY_PATH,
  );
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
    const envReference = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value.trim());
    if (envReference?.[1]) {
      return { value: null, envVar: envReference[1] };
    }
    return { value: normalizeOptionalConfigString(value), envVar: null };
  }
  return env.GITHUB_APP_PRIVATE_KEY === undefined
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

function normalizeStateLimitMap(input: Record<string, number> | undefined): Map<string, number> {
  const result = new Map<string, number>();
  for (const [state, limit] of Object.entries(input ?? {})) {
    if (Number.isFinite(limit) && limit > 0) {
      result.set(state.toLowerCase(), Math.floor(limit));
    }
  }
  return result;
}

function normalizeLabels(input: string[] | undefined): string[] {
  return [...new Set((input ?? []).map((label) => label.trim().toLowerCase()).filter((label) => label.length > 0))];
}

function normalizePromptExtensions(input: string[] | undefined): string[] {
  return (input ?? []).map((item) => item.trim()).filter((item) => item.length > 0);
}

function normalizeOptionalConfigString(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
}

function normalizeMergePolicy(raw: RawWorkflowConfig, reviewPassState: string | null): MergePolicyConfig {
  const rawPolicy = raw.merge_policy;
  const mode =
    rawPolicy?.mode ??
    (rawPolicy?.enabled === true ? "gated" : rawPolicy?.enabled === false ? "disabled" : "disabled");
  const noCiEvidence = normalizeOptionalConfigString(rawPolicy?.no_ci?.evidence);
  if (rawPolicy?.no_ci?.allowed === true && noCiEvidence === null) {
    throw new SymphonyError(
      "config_validation_error",
      "merge_policy.no_ci.evidence is required when merge_policy.no_ci.allowed is true",
    );
  }
  const requiredChecks = normalizeRequiredChecks(rawPolicy?.required_checks ?? []);
  return {
    mode,
    sourceStates: rawPolicy?.source_states ?? (reviewPassState === null ? [] : [reviewPassState]),
    conflictsState: normalizeOptionalConfigString(rawPolicy?.conflicts_state),
    maxConflictFixTurns: rawPolicy?.max_conflict_fix_turns ?? 3,
    doneState: rawPolicy?.done_state ?? "Done",
    mergeMethod: rawPolicy?.merge_method ?? "merge",
    requiredChecks,
    missingCheckStabilizationMs: rawPolicy?.missing_check_stabilization_ms ?? 60_000,
    noCiAllowed: rawPolicy?.no_ci?.allowed ?? false,
    noCiEvidence,
  };
}

function normalizePullRequestHandoff(
  raw: RawWorkflowConfig,
  input: { publishPullRequests: boolean; handoffStates: string[]; reviewStates: string[] },
): GitHubPullRequestHandoffConfig {
  const rawPolicy = raw.github?.pr_handoff;
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
  publishPullRequests: boolean;
  handoffStates: string[];
  reviewStates: string[];
  blockedStates: string[];
  reviewPassState: string | null;
  prHandoff: GitHubPullRequestHandoffConfig;
}): void {
  if (!input.prHandoff.enabled) return;
  if (!input.publishPullRequests) {
    throw new SymphonyError(
      "config_validation_error",
      "github.pr_handoff.enabled requires github.publish_pull_requests until a service PR verifier is configured",
    );
  }
  if (input.prHandoff.targetState === null) {
    throw new SymphonyError("config_validation_error", "github.pr_handoff.target_state must resolve to a tracker.handoff_states value");
  }
  if (!input.handoffStates.some((state) => statesEqual(state, input.prHandoff.targetState ?? ""))) {
    throw new SymphonyError(
      "config_validation_error",
      `github.pr_handoff.target_state must be listed in tracker.handoff_states: ${input.prHandoff.targetState}`,
    );
  }

  const reviewOverlap = overlappingStates(input.handoffStates, input.reviewStates);
  if (reviewOverlap.length > 0) {
    throw new SymphonyError(
      "config_validation_error",
      `tracker.handoff_states must not overlap review_loop.review_states when github.pr_handoff is enabled: ${reviewOverlap.join(", ")}`,
    );
  }
  const blockedOverlap = overlappingStates(input.handoffStates, input.blockedStates);
  if (blockedOverlap.length > 0) {
    throw new SymphonyError(
      "config_validation_error",
      `tracker.handoff_states must not overlap review_loop.blocked_states when github.pr_handoff is enabled: ${blockedOverlap.join(", ")}`,
    );
  }
  const passOverlap = input.reviewPassState === null ? [] : overlappingStates(input.handoffStates, [input.reviewPassState]);
  if (passOverlap.length > 0) {
    throw new SymphonyError(
      "config_validation_error",
      `tracker.handoff_states must not overlap review_loop.review_pass_state when github.pr_handoff is enabled: ${passOverlap.join(", ")}`,
    );
  }
  if (input.prHandoff.requiredChecks.length === 0 && !input.prHandoff.noCiAllowed) {
    throw new SymphonyError(
      "config_validation_error",
      "github.pr_handoff.required_checks is required when PR publication handoff is enabled unless github.pr_handoff.no_ci.allowed is true",
    );
  }
}

const ISSUE_BOARD_COLUMN_IDS: IssueBoardColumnId[] = ["backlog", "todo", "progress", "review", "done", "canceled"];

function normalizeIssueBoardColumns(
  raw: RawWorkflowConfig,
  input: {
    activeStates: string[];
    handoffStates: string[];
    terminalStates: string[];
    reviewStates: string[];
    blockedStates: string[];
    reviewPassState: string | null;
    mergePolicy: MergePolicyConfig;
  },
): IssueBoardColumnMapping {
  const defaults: IssueBoardColumnMapping = {
    backlog: ["Backlog"],
    todo: uniqueStateNames(input.activeStates.filter((state) => statesEqual(state, "Todo"))),
    progress: uniqueStateNames(
      [...input.activeStates, ...input.blockedStates].filter(
        (state) => !statesEqual(state, "Todo") && !statesEqual(state, "Backlog"),
      ),
    ),
    review: uniqueStateNames([
      ...input.handoffStates,
      ...input.reviewStates,
      ...(input.reviewPassState === null ? [] : [input.reviewPassState]),
      ...input.mergePolicy.sourceStates,
      ...(input.mergePolicy.conflictsState === null ? [] : [input.mergePolicy.conflictsState]),
    ]),
    done: uniqueStateNames([
      input.mergePolicy.doneState,
      ...input.terminalStates.filter((state) => statesEqual(state, "Done") || statesEqual(state, "Closed")),
    ]),
    canceled: uniqueStateNames(
      input.terminalStates.filter(
        (state) => statesEqual(state, "Cancelled") || statesEqual(state, "Canceled") || statesEqual(state, "Duplicate"),
      ),
    ),
  };

  const configured = raw.issue_board?.columns ?? {};
  const columns = Object.fromEntries(
    ISSUE_BOARD_COLUMN_IDS.map((column) => [column, uniqueStateNames(configured[column] ?? defaults[column])]),
  ) as IssueBoardColumnMapping;
  validateIssueBoardColumns(columns);
  return columns;
}

function validateIssueBoardColumns(columns: IssueBoardColumnMapping): void {
  const seen = new Map<string, { column: IssueBoardColumnId; state: string }>();
  for (const column of ISSUE_BOARD_COLUMN_IDS) {
    for (const state of columns[column]) {
      const key = state.toLowerCase();
      const existing = seen.get(key);
      if (existing) {
        throw new SymphonyError(
          "config_validation_error",
          `issue_board.columns must not map state ${state} to both ${existing.column} and ${column}`,
        );
      }
      seen.set(key, { column, state });
    }
  }
}

function normalizeRequiredChecks(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function uniqueStateNames(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function statesEqual(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function validateStateBuckets(input: {
  activeStates: string[];
  handoffStates: string[];
  terminalStates: string[];
  reviewStates: string[];
  blockedStates: string[];
  reviewPassState: string | null;
}): void {
  const { activeStates, handoffStates, terminalStates, reviewStates, blockedStates, reviewPassState } = input;
  const activeHandoffOverlap = overlappingStates(activeStates, handoffStates);
  if (activeHandoffOverlap.length > 0) {
    throw new SymphonyError(
      "config_validation_error",
      `tracker.handoff_states must not overlap tracker.active_states: ${activeHandoffOverlap.join(", ")}`,
    );
  }
  const terminalHandoffOverlap = overlappingStates(terminalStates, handoffStates);
  if (terminalHandoffOverlap.length > 0) {
    throw new SymphonyError(
      "config_validation_error",
      `tracker.handoff_states must not overlap tracker.terminal_states: ${terminalHandoffOverlap.join(", ")}`,
    );
  }

  const passStates = reviewPassState === null ? [] : [reviewPassState];
  const buckets = [
    ["tracker.active_states", activeStates],
    ["tracker.terminal_states", terminalStates],
    ["review_loop.blocked_states", blockedStates],
    ["review_loop.review_states", reviewStates],
    ["review_loop.review_pass_state", passStates],
  ] as const;

  for (let leftIndex = 0; leftIndex < buckets.length; leftIndex += 1) {
    const [leftName, leftStates] = buckets[leftIndex] ?? ["", []];
    for (let rightIndex = leftIndex + 1; rightIndex < buckets.length; rightIndex += 1) {
      const [rightName, rightStates] = buckets[rightIndex] ?? ["", []];
      const overlap = overlappingStates(leftStates, rightStates);
      if (overlap.length > 0) {
        throw new SymphonyError(
          "config_validation_error",
          `${leftName} must not overlap ${rightName}: ${overlap.join(", ")}`,
        );
      }
    }
  }
}

function validateMergePolicyStateBuckets(input: {
  activeStates: string[];
  handoffStates: string[];
  terminalStates: string[];
  reviewStates: string[];
  blockedStates: string[];
  reviewPassState: string | null;
  mergePolicy: MergePolicyConfig;
}): void {
  const { mergePolicy } = input;
  const conflictsState = mergePolicy.conflictsState;
  if (mergePolicy.mode === "disabled" || conflictsState === null) return;

  const conflictOverlaps: Array<[string, string[]]> = [
    ["tracker.active_states", input.activeStates],
    ["merge_policy.source_states", mergePolicy.sourceStates],
    ["merge_policy.done_state", [mergePolicy.doneState]],
    ["tracker.handoff_states", input.handoffStates],
    ["tracker.terminal_states", input.terminalStates],
    ["review_loop.blocked_states", input.blockedStates],
    ["review_loop.review_states", input.reviewStates],
    ["review_loop.review_pass_state", input.reviewPassState === null ? [] : [input.reviewPassState]],
  ];
  for (const [name, states] of conflictOverlaps) {
    const overlap = overlappingStates([conflictsState], states);
    if (overlap.length > 0) {
      throw new SymphonyError(
        "config_validation_error",
        `merge_policy.conflicts_state must not overlap ${name}: ${overlap.join(", ")}`,
      );
    }
  }
}

function overlappingStates(left: string[], right: string[]): string[] {
  const rightSet = new Set(right.map((state) => state.toLowerCase()));
  return left.filter((state) => rightSet.has(state.toLowerCase()));
}

function normalizeCursorSettingSources(values: string[] | undefined): CursorSettingSource[] {
  const requested = values ?? [];
  const filtered = requested.filter((value): value is CursorSettingSource =>
    VALID_CURSOR_SETTING_SOURCES.has(value as CursorSettingSource),
  );
  return filtered;
}

function normalizeCursorModelParams(values: Record<string, string> | undefined): CursorModelParameter[] {
  if (values === undefined) return [...DEFAULT_CURSOR_MODEL_PARAMS];
  return Object.entries(values)
    .filter(([id, value]) => id.length > 0 && value.length > 0)
    .map(([id, value]) => ({ id, value }));
}

function validateCursorModelPolicy(
  model: string,
  modelParams: CursorModelParameter[],
  allowLargeContext: boolean,
): void {
  if (model !== DEFAULT_CURSOR_MODEL) return;
  const context = modelParams.find((param) => param.id === "context")?.value;
  if (context === "1m" && allowLargeContext) return;
  if (context === "272k") return;
  if (context === "1m") {
    throw new SymphonyError(
      "config_validation_error",
      "cursor.model_params.context=1m requires cursor.allow_large_context: true",
    );
  }
  throw new SymphonyError(
    "config_validation_error",
    "cursor.model_params.context must be 272k for gpt-5.5 unless cursor.allow_large_context is true",
  );
}

function normalizeAgentHarness(value: string | undefined): AgentHarnessKind {
  const harness = value ?? "cursor";
  if (VALID_AGENT_HARNESSES.has(harness as AgentHarnessKind)) return harness as AgentHarnessKind;
  throw new SymphonyError("config_validation_error", `Unsupported agent harness: ${harness}`);
}

function resolveRepositoryValue(value: string, baseDir: string, env: NodeJS.ProcessEnv): string {
  const resolved = resolveConfigString(value, env) ?? "";
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(resolved)) return resolved;
  if (/^[^/\\]+@[^:]+:.+/.test(resolved)) return resolved;
  return resolvePathValue(resolved, baseDir, env);
}

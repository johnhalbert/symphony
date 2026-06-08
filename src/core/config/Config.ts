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
import {
  LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
  LEGACY_DEFAULT_PROJECT_CONTEXT_LABEL,
  buildProjectContextRegistry,
  defaultProjectContextLabel,
  normalizeProjectContextId,
  projectContextMetadataForPublicRead,
  type NormalizedProjectContext,
  type ProjectContextConfig,
  type ProjectContextRegistry,
} from "./ProjectContexts.js";

const stringArray = z.array(z.string());

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

const rawIssueBreakdownApplyToLinearSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: z.enum(["child_issues"]).optional(),
  })
  .passthrough();

const rawIssueBreakdownSchema = z
  .object({
    enabled: z.boolean().optional(),
    cursor_mode: z.enum(["agent", "plan"]).optional(),
    prompt: z.string().optional(),
    planning_labels: stringArray.optional(),
    apply_to_linear: rawIssueBreakdownApplyToLinearSchema.optional(),
    workspace_mode: z.enum(["none", "readonly_checkout"]).optional(),
    max_planning_failures: z.number().int().positive().optional(),
    max_planning_dispatch_retries: z.number().int().positive().optional(),
    planning_retry_base_ms: z.number().int().positive().optional(),
    planning_retry_max_ms: z.number().int().positive().optional(),
  })
  .passthrough();

const rawWorkspaceSourceSchema = z
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
  .passthrough();

const rawWorkspaceSchema = z
  .object({
    root: z.string().optional(),
    state_dir: z.string().optional(),
    source: rawWorkspaceSourceSchema.optional(),
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

const rawGitHubAppSchema = z
  .object({
    app_id: z.string().optional(),
    client_id: z.string().optional(),
    installation_id: z.string().optional(),
    private_key: z.string().optional(),
    private_key_path: z.string().optional(),
    token_refresh_buffer_seconds: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const rawGitHubOperatorApprovalSchema = z
  .object({
    required_for_publication: z.boolean().optional(),
    reject_policy: z.enum(["cancel", "fail"]).optional(),
    poll_interval_ms: z.number().int().positive().optional(),
    timeout_ms: z.number().int().nonnegative().nullable().optional(),
  })
  .passthrough();

const rawGitHubNoCiSchema = z
  .object({
    allowed: z.boolean().optional(),
    evidence: z.string().optional(),
  })
  .passthrough();

const rawGitHubPrHandoffSchema = z
  .object({
    enabled: z.boolean().optional(),
    target_state: z.string().optional(),
    allow_drafts: z.boolean().optional(),
    required_checks: stringArray.optional(),
    no_ci: rawGitHubNoCiSchema.optional(),
  })
  .passthrough();

const rawGitHubSchema = z
  .object({
    owner: z.string().optional(),
    repo: z.string().optional(),
    token: z.string().optional(),
    app: rawGitHubAppSchema.optional(),
    head_owner: z.string().optional(),
    api_base_url: z.string().optional(),
    publish_pull_requests: z.boolean().optional(),
    operator_approval: rawGitHubOperatorApprovalSchema.optional(),
    pr_handoff: rawGitHubPrHandoffSchema.optional(),
  })
  .passthrough();

const rawProjectContextSchema = z
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
    credential_profiles: rawCredentialProfilesSchema.optional(),
  })
  .passthrough();

const rawConfigSchema = z
  .object({
    tracker: rawTrackerSchema.optional(),
    review_loop: rawReviewLoopSchema.optional(),
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
    database: z
      .object({
        postgres: z
          .object({
            url: z.string().optional(),
            migrations_dir: z.string().optional(),
            migrations_table: z.string().optional(),
            ssl: z.boolean().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    issue_breakdown: rawIssueBreakdownSchema.optional(),
    polling: z
      .object({
        interval_ms: z.number().int().positive().optional(),
      })
      .passthrough()
      .optional(),
    workspace: rawWorkspaceSchema.optional(),
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
    agent: rawAgentSchema.optional(),
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
    hermes: z
      .object({
        upstream_root: z.string().optional(),
        python: z.string().optional(),
        templates_dir: z.string().optional(),
        state_dir: z.string().optional(),
        acp_binary_path: z.string().optional(),
        binary_path: z.string().optional(),
        acp_source_profile: z.string().optional(),
        source_profile: z.string().optional(),
        acp_profile_prefix: z.string().optional(),
        profile_name_prefix: z.string().optional(),
        auth: z
          .object({
            mode: z.enum(["managed_root"]).optional(),
            managed_root: z.string().optional(),
            bootstrap_from: z.string().optional(),
            providers: z.array(z.string()).min(1).optional(),
          })
          .passthrough()
          .optional(),
        runtime_credential_env: z.string().optional(),
        model: z.string().optional(),
        provider: z.string().optional(),
        worker_session_lifecycle: z.enum(["fresh_per_run", "reuse_by_issue"]).optional(),
        keep_profiles: z.enum(["always", "failed", "never"]).optional(),
        startup_timeout_ms: z.number().int().positive().optional(),
        request_timeout_ms: z.number().int().positive().optional(),
        shutdown_grace_ms: z.number().int().nonnegative().optional(),
        role_templates: z
          .object({
            worker: z.string().optional(),
            reviewer: z.string().optional(),
            planner: z.string().optional(),
            merge_conflict_resolution: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    hermes_acp: z
      .object({
        binary_path: z.string().optional(),
        source_profile: z.string().optional(),
        profile_prefix: z.string().optional(),
        profile_name_prefix: z.string().optional(),
        worker_session_lifecycle: z.enum(["fresh_per_run", "reuse_by_issue"]).optional(),
        keep_profiles: z.enum(["always", "failed", "never"]).optional(),
        startup_timeout_ms: z.number().int().positive().optional(),
        request_timeout_ms: z.number().int().positive().optional(),
        permission_timeout_ms: z.number().int().positive().optional(),
      })
      .passthrough()
      .optional(),
    server: z
      .object({
        port: z.number().int().min(0).optional(),
        host: z.string().optional(),
        open_workspace_token: z.string().optional(),
        web_assets_root: z.string().nullable().optional(),
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
    github: rawGitHubSchema.optional(),
    project_contexts: z.array(rawProjectContextSchema).min(1).optional(),
    credential_profiles: rawCredentialProfilesSchema.optional(),
  })
  .passthrough();

export type RawWorkflowConfig = z.infer<typeof rawConfigSchema>;
type RawProjectContextConfig = z.infer<typeof rawProjectContextSchema>;

export type WorkflowProjectContextConfig = ProjectContextConfig<
  RawWorkflowConfig["tracker"],
  RawWorkflowConfig["workspace"],
  RawWorkflowConfig["github"],
  RawWorkflowConfig["review_loop"],
  RawWorkflowConfig["issue_breakdown"],
  RawWorkflowConfig["agent"],
  RawWorkflowConfig["credential_profiles"]
>;

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
  maxInfraFailures: number;
  maxConcurrentAgentsByState: Map<string, number>;
  requireLabels: string[];
  excludeLabels: string[];
  protectedPaths: string[];
}

export type AgentHarnessKind = string;

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

export type HermesWorkerSessionLifecycle = "fresh_per_run" | "reuse_by_issue";
export type HermesProfileRetention = "always" | "failed" | "never";

export interface HermesRoleTemplatesConfig {
  worker: string;
  reviewer: string;
  planner: string;
  mergeConflictResolution: string;
}

export type HermesAuthMode = "managed_root";

export interface HermesAuthConfig {
  mode: HermesAuthMode;
  managedRoot: string;
  bootstrapFrom: string;
  providers: string[];
}

export interface HermesConfig {
  upstreamRoot: string;
  python: string | null;
  templatesDir: string;
  stateDir: string;
  acpBinaryPath: string | null;
  acpSourceProfile: string | null;
  acpProfilePrefix: string | null;
  auth: HermesAuthConfig;
  runtimeCredentialEnv: string;
  model: string | null;
  provider: string | null;
  workerSessionLifecycle: HermesWorkerSessionLifecycle;
  keepProfiles: HermesProfileRetention;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  shutdownGraceMs: number;
  roleTemplates: HermesRoleTemplatesConfig;
}

export interface HermesAcpConfig {
  binaryPath: string | null;
  sourceProfile: string | null;
  profilePrefix: string;
  workerSessionLifecycle: HermesWorkerSessionLifecycle;
  keepProfiles: HermesProfileRetention;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  permissionTimeoutMs: number;
}

export interface ServerConfig {
  port: number | null;
  host: string;
  openWorkspaceToken: string | null;
  webAssetsRoot: string | null;
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

export interface PostgresDatabaseConfig {
  connectionString: string | null;
  migrationsDir: string;
  migrationsTable: string;
  ssl: boolean;
}

export interface DatabaseConfig {
  postgres: PostgresDatabaseConfig;
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

export type WorkflowProjectContext = NormalizedProjectContext<
  TrackerConfig,
  WorkspaceConfig,
  GitHubConfig,
  ReviewLoopConfig,
  IssueBreakdownConfig,
  AgentConfig,
  RawWorkflowConfig["credential_profiles"]
>;

export type WorkflowProjectContextRegistry = ProjectContextRegistry<WorkflowProjectContext>;

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
  hermes: HermesConfig;
  hermesAcp: HermesAcpConfig;
  server: ServerConfig;
  writeback: WritebackConfig;
  github: GitHubConfig;
  credentialProfiles: CredentialProfileRegistry;
  reviewLoop: ReviewLoopConfig;
  mergePolicy: MergePolicyConfig;
  issueBoard: IssueBoardConfig;
  continuationContext: ContinuationContextConfig;
  database: DatabaseConfig;
  issueBreakdown: IssueBreakdownConfig;
  projectContexts: WorkflowProjectContextRegistry;
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
const DEFAULT_CURSOR_MODEL = "gpt-5.5";
const DEFAULT_CURSOR_MODEL_PARAMS: CursorModelParameter[] = [
  { id: "context", value: "272k" },
  { id: "reasoning", value: "extra-high" },
];
const DEFAULT_GITHUB_APP_TOKEN_REFRESH_BUFFER_SECONDS = 300;
const DEFAULT_HERMES_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_HERMES_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_HERMES_SHUTDOWN_GRACE_MS = 2_000;
const DEFAULT_HERMES_WORKER_SESSION_LIFECYCLE: HermesWorkerSessionLifecycle = "reuse_by_issue";
const DEFAULT_HERMES_PROFILE_RETENTION: HermesProfileRetention = "failed";
const DEFAULT_HERMES_ACP_PROFILE_PREFIX = "symphony";
const DEFAULT_ISSUE_BREAKDOWN_PROMPT = [
  "Break down {{ issue.identifier }} before implementation.",
  "",
  "Inspect the issue and repository context only. Do not edit files, create commits, push branches, comment on Linear, transition Linear state, or submit a completion report.",
  "",
  "Before ending the run, call submit_issue_breakdown_plan with a concise summary, an idempotencyKey, and proposedIssues[].",
  "Each proposed issue must include title, description, acceptanceCriteria[], dependencies[], and labels[].",
  "Each proposed issue description must use the agent-eligible issue contract section headings `Problem / Goal`, `Issue Contract`, `Touched Surfaces`, `Acceptance Criteria`, `Contract Checklist`, `Validation Requirements`, `Out Of Scope`, and `Promotion Readiness`; use the same headings for docs-only and implementation issues.",
  "In `Issue Contract`, include a fenced `json` block with a positive integer `schemaVersion`, a non-empty `contractVersion`, and a non-empty `requirements` array whose entries have stable unique `id` values and non-empty `requirement` text.",
  "Do not include secrets, tokens, private keys, or credential values in proposed issue descriptions. Do not add `dogfood-ready` automatically; leave readiness as an explicit Promotion Readiness decision for operator review.",
  "Symphony persists these proposals locally; do not create or modify Linear issues.",
].join("\n");

export function parseDatabaseConfig(rawInput: unknown, workflowPath: string, env = process.env): DatabaseConfig {
  const parsed = rawConfigSchema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    throw new SymphonyError("config_validation_error", "Workflow config is invalid", parsed.error.flatten());
  }
  const workflowDir = path.dirname(path.resolve(workflowPath));
  return normalizeDatabaseConfig(parsed.data, workflowDir, env);
}

export function parseServiceConfig(rawInput: unknown, workflowPath: string, env = process.env): ServiceConfig {
  const parsed = rawConfigSchema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    throw new SymphonyError("config_validation_error", "Workflow config is invalid", parsed.error.flatten());
  }

  const raw = parsed.data;
  const workflowDir = path.dirname(path.resolve(workflowPath));
  const projectContexts = normalizeWorkflowProjectContexts(raw, workflowDir, env);
  const defaultContext = projectContexts.defaultContext;
  const tracker = defaultContext.tracker;
  const workspace = defaultContext.workspace;
  const github = defaultContext.github;
  const reviewLoop = defaultContext.reviewLoop;
  const issueBreakdown = defaultContext.issueBreakdown;
  const agent = defaultContext.agent;

  const cursorModel = raw.cursor?.model ?? DEFAULT_CURSOR_MODEL;
  const cursorModelParams = normalizeCursorModelParams(raw.cursor?.model_params);
  const cursorAllowLargeContext = raw.cursor?.allow_large_context ?? false;
  validateCursorModelPolicy(cursorModel, cursorModelParams, cursorAllowLargeContext);
  const hermesUpstreamRoot =
    raw.hermes?.upstream_root === undefined
      ? path.resolve(workflowDir, "hermes/upstream-src")
      : resolvePathValue(raw.hermes.upstream_root, workflowDir, env);
  const hermesTemplatesDir =
    raw.hermes?.templates_dir === undefined
      ? path.resolve(workflowDir, "hermes/templates")
      : resolvePathValue(raw.hermes.templates_dir, workflowDir, env);
  const hermesStateDir =
    raw.hermes?.state_dir === undefined
      ? path.join(workspace.stateDir, "hermes")
      : resolvePathValue(raw.hermes.state_dir, workflowDir, env);
  const legacyHermesAcpBinaryPath = normalizeOptionalConfigString(
    resolveConfigString(raw.hermes?.acp_binary_path ?? raw.hermes?.binary_path, env),
  );
  const legacyHermesAcpSourceProfile = normalizeOptionalConfigString(
    resolveConfigString(raw.hermes?.acp_source_profile ?? raw.hermes?.source_profile, env),
  );
  const legacyHermesAcpProfilePrefix = normalizeOptionalConfigString(
    resolveConfigString(raw.hermes?.acp_profile_prefix ?? raw.hermes?.profile_name_prefix, env),
  );
  const hermesAcpBinaryPath = normalizeOptionalConfigString(
    resolveConfigString(raw.hermes_acp?.binary_path, env),
  ) ?? legacyHermesAcpBinaryPath;
  const hermesAcpSourceProfile = normalizeHermesAcpOptionalProfileName(
    normalizeOptionalConfigString(resolveConfigString(raw.hermes_acp?.source_profile, env)) ?? legacyHermesAcpSourceProfile,
    "hermes_acp.source_profile",
  );
  const hermesAcpProfilePrefix = normalizeHermesAcpProfileName(
    normalizeOptionalConfigString(
      resolveConfigString(raw.hermes_acp?.profile_prefix ?? raw.hermes_acp?.profile_name_prefix, env),
    ) ??
      legacyHermesAcpProfilePrefix ??
      DEFAULT_HERMES_ACP_PROFILE_PREFIX,
    "hermes_acp.profile_prefix",
  );
  const hermesAuthManagedRoot =
    raw.hermes?.auth?.managed_root === undefined
      ? path.join(hermesStateDir, "auth")
      : resolvePathValue(raw.hermes.auth.managed_root, workflowDir, env);
  const hermesAuthBootstrapFrom =
    raw.hermes?.auth?.bootstrap_from === undefined
      ? defaultHermesAuthBootstrapSource(env)
      : resolvePathValue(raw.hermes.auth.bootstrap_from, workflowDir, env);
  const hermesRuntimeCredentialEnv = normalizeEnvironmentVariableName(
    raw.hermes?.runtime_credential_env ?? "HERMES_API_KEY",
    "hermes.runtime_credential_env",
  );
  const hermesPython = normalizeOptionalConfigString(resolveConfigString(raw.hermes?.python, env));
  const hermesModel = normalizeOptionalConfigString(resolveConfigString(raw.hermes?.model, env));
  const hermesProvider = normalizeOptionalConfigString(resolveConfigString(raw.hermes?.provider, env));
  const hermesWorkerSessionLifecycle = raw.hermes?.worker_session_lifecycle ?? DEFAULT_HERMES_WORKER_SESSION_LIFECYCLE;
  const hermesKeepProfiles = raw.hermes?.keep_profiles ?? DEFAULT_HERMES_PROFILE_RETENTION;
  const hermesStartupTimeoutMs = raw.hermes?.startup_timeout_ms ?? DEFAULT_HERMES_STARTUP_TIMEOUT_MS;
  const hermesRequestTimeoutMs = raw.hermes?.request_timeout_ms ?? DEFAULT_HERMES_REQUEST_TIMEOUT_MS;
  const hermesShutdownGraceMs = raw.hermes?.shutdown_grace_ms ?? DEFAULT_HERMES_SHUTDOWN_GRACE_MS;
  const hermesAcpWorkerSessionLifecycle = raw.hermes_acp?.worker_session_lifecycle ?? hermesWorkerSessionLifecycle;
  const hermesAcpKeepProfiles = raw.hermes_acp?.keep_profiles ?? hermesKeepProfiles;
  const hermesAcpStartupTimeoutMs = raw.hermes_acp?.startup_timeout_ms ?? hermesStartupTimeoutMs;
  const hermesAcpRequestTimeoutMs = raw.hermes_acp?.request_timeout_ms ?? hermesRequestTimeoutMs;
  const hermesAcpPermissionTimeoutMs = raw.hermes_acp?.permission_timeout_ms ?? hermesAcpRequestTimeoutMs;
  const cursorRuntimeApiKey = normalizeOptionalConfigString(resolveConfigString("$CURSOR_API_KEY", env));
  const serverOpenWorkspaceToken = resolveConfigString(raw.server?.open_workspace_token, env) ?? null;
  const serverWebAssetsRoot = resolveOptionalPathValue(raw.server?.web_assets_root, workflowDir, env);
  const database = normalizeDatabaseConfig(raw, workflowDir, env);
  const credentialProfiles = createCredentialProfileRegistry({
    raw: raw.credential_profiles,
    env,
    workflowDir,
    fallbacks: {
      githubToken: github.token,
      linearApiKey: tracker.apiKey,
      cursorRuntimeApiKey,
      openWorkspaceToken: serverOpenWorkspaceToken,
    },
  });
  const mergePolicy = normalizeMergePolicy(raw, reviewLoop.reviewPassState);
  validateStateBuckets({
    activeStates: tracker.activeStates,
    handoffStates: tracker.handoffStates,
    terminalStates: tracker.terminalStates,
    reviewStates: reviewLoop.reviewStates,
    blockedStates: reviewLoop.blockedStates,
    reviewPassState: reviewLoop.reviewPassState,
  });
  validatePullRequestHandoffPolicy({
    publishPullRequests: github.publishPullRequests,
    handoffStates: tracker.handoffStates,
    reviewStates: reviewLoop.reviewStates,
    blockedStates: reviewLoop.blockedStates,
    reviewPassState: reviewLoop.reviewPassState,
    prHandoff: github.prHandoff,
  });
  const issueBoard = normalizeIssueBoardColumns(raw, {
    activeStates: tracker.activeStates,
    handoffStates: tracker.handoffStates,
    terminalStates: tracker.terminalStates,
    reviewStates: reviewLoop.reviewStates,
    blockedStates: reviewLoop.blockedStates,
    reviewPassState: reviewLoop.reviewPassState,
    mergePolicy,
  });

  return {
    workflowPath: path.resolve(workflowPath),
    workflowDir,
    tracker,
    polling: {
      intervalMs: raw.polling?.interval_ms ?? 30_000,
    },
    workspace,
    hooks: {
      afterCreate: raw.hooks?.after_create ?? null,
      beforeRun: raw.hooks?.before_run ?? null,
      afterRun: raw.hooks?.after_run ?? null,
      beforeRemove: raw.hooks?.before_remove ?? null,
      timeoutMs: raw.hooks?.timeout_ms ?? 60_000,
    },
    agent,
    cursor: {
      model: cursorModel,
      mode: raw.cursor?.mode ?? null,
      modelParams: cursorModelParams,
      settingSources: normalizeCursorSettingSources(raw.cursor?.setting_sources),
      openerCommand: raw.cursor?.opener_command ?? null,
      allowLargeContext: cursorAllowLargeContext,
      workerAgentLifecycle: raw.cursor?.worker_agent_lifecycle ?? "fresh_per_run",
    },
    hermes: {
      upstreamRoot: hermesUpstreamRoot,
      python: hermesPython,
      templatesDir: hermesTemplatesDir,
      stateDir: hermesStateDir,
      acpBinaryPath: legacyHermesAcpBinaryPath,
      acpSourceProfile: legacyHermesAcpSourceProfile,
      acpProfilePrefix: legacyHermesAcpProfilePrefix,
      auth: {
        mode: raw.hermes?.auth?.mode ?? "managed_root",
        managedRoot: hermesAuthManagedRoot,
        bootstrapFrom: hermesAuthBootstrapFrom,
        providers: normalizeHermesAuthProviders(raw.hermes?.auth?.providers),
      },
      runtimeCredentialEnv: hermesRuntimeCredentialEnv,
      model: hermesModel,
      provider: hermesProvider,
      workerSessionLifecycle: hermesWorkerSessionLifecycle,
      keepProfiles: hermesKeepProfiles,
      startupTimeoutMs: hermesStartupTimeoutMs,
      requestTimeoutMs: hermesRequestTimeoutMs,
      shutdownGraceMs: hermesShutdownGraceMs,
      roleTemplates: {
        worker: raw.hermes?.role_templates?.worker ?? "worker",
        reviewer: raw.hermes?.role_templates?.reviewer ?? "reviewer",
        planner: raw.hermes?.role_templates?.planner ?? "planner",
        mergeConflictResolution: raw.hermes?.role_templates?.merge_conflict_resolution ?? "worker",
      },
    },
    hermesAcp: {
      binaryPath: hermesAcpBinaryPath,
      sourceProfile: hermesAcpSourceProfile,
      profilePrefix: hermesAcpProfilePrefix,
      workerSessionLifecycle: hermesAcpWorkerSessionLifecycle,
      keepProfiles: hermesAcpKeepProfiles,
      startupTimeoutMs: hermesAcpStartupTimeoutMs,
      requestTimeoutMs: hermesAcpRequestTimeoutMs,
      permissionTimeoutMs: hermesAcpPermissionTimeoutMs,
    },
    server: {
      port: raw.server?.port ?? null,
      host: raw.server?.host ?? "127.0.0.1",
      openWorkspaceToken: serverOpenWorkspaceToken,
      webAssetsRoot: serverWebAssetsRoot,
    },
    writeback: {
      enabled: raw.writeback?.enabled ?? false,
      mode: raw.writeback?.mode ?? "dry_run",
      dispatchState: raw.writeback?.dispatch_state ?? "In Progress",
      maxBackoffMs: raw.writeback?.max_backoff_ms ?? 300_000,
    },
    github,
    credentialProfiles,
    reviewLoop,
    mergePolicy,
    issueBoard: {
      columns: issueBoard,
    },
    continuationContext: {
      searchEnabled: raw.continuation_context?.search_enabled ?? false,
      summarizationEnabled: raw.continuation_context?.summarization_enabled ?? false,
    },
    database,
    issueBreakdown,
    projectContexts,
    raw,
  };
}

function normalizeWorkflowProjectContexts(
  raw: RawWorkflowConfig,
  workflowDir: string,
  env: NodeJS.ProcessEnv,
): WorkflowProjectContextRegistry {
  const defaults: WorkflowProjectContextConfig = {
    id: LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
    label: LEGACY_DEFAULT_PROJECT_CONTEXT_LABEL,
    tracker: raw.tracker,
    workspace: raw.workspace,
    github: raw.github,
    review_loop: raw.review_loop,
    issue_breakdown: raw.issue_breakdown,
    agent: raw.agent,
    credential_profiles: raw.credential_profiles,
  };

  const contexts =
    raw.project_contexts?.map((context) =>
      normalizeWorkflowProjectContext(context, defaults, workflowDir, env, { requireExplicitWorkspaceSource: true }),
    ) ?? [normalizeLegacyWorkflowProjectContext(defaults, workflowDir, env)];

  try {
    return buildProjectContextRegistry(contexts);
  } catch (error) {
    throw new SymphonyError(
      "config_validation_error",
      error instanceof Error ? error.message : "Project contexts are invalid",
    );
  }
}

function normalizeLegacyWorkflowProjectContext(
  defaults: WorkflowProjectContextConfig,
  workflowDir: string,
  env: NodeJS.ProcessEnv,
): WorkflowProjectContext {
  return normalizeWorkflowProjectContext(
    {
      id: LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
      label: LEGACY_DEFAULT_PROJECT_CONTEXT_LABEL,
      enabled: true,
      tracker: defaults.tracker,
      workspace: defaults.workspace,
      github: defaults.github,
      review_loop: defaults.review_loop,
      issue_breakdown: defaults.issue_breakdown,
      agent: defaults.agent,
      credential_profiles: defaults.credential_profiles,
    },
    {},
    workflowDir,
    env,
    { requireExplicitWorkspaceSource: false },
  );
}

function normalizeWorkflowProjectContext(
  rawContext: RawProjectContextConfig,
  defaults: Partial<WorkflowProjectContextConfig>,
  workflowDir: string,
  env: NodeJS.ProcessEnv,
  options: { requireExplicitWorkspaceSource: boolean },
): WorkflowProjectContext {
  const contextPath = `project_contexts[${JSON.stringify(rawContext.id)}]`;
  let id: string;
  try {
    id = normalizeProjectContextId(rawContext.id);
  } catch (error) {
    throw new SymphonyError(
      "config_validation_error",
      `${contextPath}.id must contain at least one letter or number after normalization`,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }

  const enabled = rawContext.enabled ?? true;
  const label = normalizeOptionalConfigString(rawContext.label) ?? defaultProjectContextLabel(id);
  const merged = mergeWorkflowProjectContextDefaults(defaults, rawContext);
  const tracker = normalizeTrackerConfigForProjectContext(merged.tracker, env, { enabled, contextPath });
  const workspace = normalizeWorkspaceConfigForProjectContext(merged.workspace, workflowDir, env, {
    enabled,
    contextPath,
    requireExplicitWorkspaceSource: options.requireExplicitWorkspaceSource,
  });
  const reviewLoop = normalizeReviewLoopConfigForProjectContext(merged.review_loop, tracker);
  const github = normalizeGitHubConfigForProjectContext(
    merged.github,
    workflowDir,
    env,
    tracker.handoffStates,
    reviewLoop.reviewStates,
  );
  const issueBreakdown = normalizeIssueBreakdownConfigForProjectContext(
    merged.issue_breakdown,
    workspace.source.kind,
    contextPath,
    enabled,
  );
  const agent = normalizeAgentConfigForProjectContext(merged.agent);

  if (enabled) {
    validateStateBuckets({
      activeStates: tracker.activeStates,
      handoffStates: tracker.handoffStates,
      terminalStates: tracker.terminalStates,
      reviewStates: reviewLoop.reviewStates,
      blockedStates: reviewLoop.blockedStates,
      reviewPassState: reviewLoop.reviewPassState,
    });
    validatePullRequestHandoffPolicy({
      publishPullRequests: github.publishPullRequests,
      handoffStates: tracker.handoffStates,
      reviewStates: reviewLoop.reviewStates,
      blockedStates: reviewLoop.blockedStates,
      reviewPassState: reviewLoop.reviewPassState,
      prHandoff: github.prHandoff,
    });
  }

  return {
    id,
    label,
    enabled,
    tracker,
    workspace,
    github,
    reviewLoop,
    issueBreakdown,
    agent,
    credentialProfiles: merged.credential_profiles,
    publicMetadata: projectContextMetadataForPublicRead({ id, label, enabled, tracker, workspace }),
  };
}

function mergeWorkflowProjectContextDefaults(
  defaults: Partial<WorkflowProjectContextConfig>,
  context: RawProjectContextConfig,
): WorkflowProjectContextConfig {
  const tracker = mergeConfigObjects(defaults.tracker, context.tracker);
  const workspace = mergeWorkspaceDefaults(defaults.workspace, context.workspace);
  const github = mergeGitHubDefaults(defaults.github, context.github);
  const reviewLoop = mergeConfigObjects(defaults.review_loop, context.review_loop);
  const issueBreakdown = mergeIssueBreakdownDefaults(defaults.issue_breakdown, context.issue_breakdown);
  const agent = mergeAgentDefaults(defaults.agent, context.agent);
  const credentialProfiles = context.credential_profiles ?? defaults.credential_profiles;

  return {
    id: context.id,
    ...(context.label === undefined ? {} : { label: context.label }),
    ...(context.enabled === undefined ? {} : { enabled: context.enabled }),
    ...(tracker === undefined ? {} : { tracker }),
    ...(workspace === undefined ? {} : { workspace }),
    ...(github === undefined ? {} : { github }),
    ...(reviewLoop === undefined ? {} : { review_loop: reviewLoop }),
    ...(issueBreakdown === undefined ? {} : { issue_breakdown: issueBreakdown }),
    ...(agent === undefined ? {} : { agent }),
    ...(credentialProfiles === undefined ? {} : { credential_profiles: credentialProfiles }),
  };
}

function normalizeTrackerConfigForProjectContext(
  rawTracker: RawWorkflowConfig["tracker"],
  env: NodeJS.ProcessEnv,
  options: { enabled: boolean; contextPath: string },
): TrackerConfig {
  const trackerKind = rawTracker?.kind ?? "linear";
  if (trackerKind !== "linear") {
    throw new SymphonyError(
      "unsupported_tracker_kind",
      `${options.contextPath}.tracker.kind must be linear; received ${trackerKind}`,
    );
  }

  const apiKey = normalizeOptionalConfigString(
    resolveConfigString(rawTracker?.api_key, env) ?? resolveConfigString("$LINEAR_API_KEY", env),
  );
  if (options.enabled && apiKey === null) {
    throw new SymphonyError("missing_tracker_api_key", `${options.contextPath}.tracker.api_key is required`);
  }

  const projectSlug = normalizeOptionalConfigString(resolveConfigString(rawTracker?.project_slug, env));
  if (options.enabled && projectSlug === null) {
    throw new SymphonyError("missing_tracker_project_slug", `${options.contextPath}.tracker.project_slug is required`);
  }

  return {
    kind: "linear",
    endpoint: rawTracker?.endpoint ?? "https://api.linear.app/graphql",
    apiKey: apiKey ?? "",
    projectSlug: projectSlug ?? "",
    assignee:
      normalizeOptionalConfigString(resolveConfigString(rawTracker?.assignee, env)) ??
      normalizeOptionalConfigString(resolveConfigString("$LINEAR_ASSIGNEE", env)),
    activeStates: rawTracker?.active_states ?? DEFAULT_ACTIVE_STATES,
    handoffStates: rawTracker?.handoff_states ?? [],
    terminalStates: rawTracker?.terminal_states ?? DEFAULT_TERMINAL_STATES,
  };
}

function normalizeWorkspaceConfigForProjectContext(
  rawWorkspace: RawWorkflowConfig["workspace"],
  workflowDir: string,
  env: NodeJS.ProcessEnv,
  options: { enabled: boolean; contextPath: string; requireExplicitWorkspaceSource: boolean },
): WorkspaceConfig {
  const root = resolvePathValue(rawWorkspace?.root ?? "symphony_workspaces", workflowDir, env);
  const stateDir = resolvePathValue(rawWorkspace?.state_dir ?? ".symphony", root, env);
  const sourceKind = rawWorkspace?.source?.kind ?? "none";
  const sourcePath =
    rawWorkspace?.source?.path === undefined
      ? undefined
      : resolvePathValue(rawWorkspace.source.path, workflowDir, env);
  const sourceCachePath =
    rawWorkspace?.source?.cache_path === undefined
      ? undefined
      : resolvePathValue(rawWorkspace.source.cache_path, workflowDir, env);
  const sourceRepository =
    rawWorkspace?.source?.repository === undefined
      ? undefined
      : resolveRepositoryValue(rawWorkspace.source.repository, workflowDir, env);

  if (options.enabled && options.requireExplicitWorkspaceSource && sourceKind === "none") {
    throw new SymphonyError(
      "config_validation_error",
      `${options.contextPath}.workspace.source is required for enabled project contexts`,
    );
  }
  if (options.enabled && sourceKind === "git_worktree") {
    if (!rawWorkspace?.source?.repository) {
      throw new SymphonyError(
        "config_validation_error",
        `${options.contextPath}.workspace.source.repository is required for git_worktree`,
      );
    }
    if (!rawWorkspace?.source?.base_ref) {
      throw new SymphonyError(
        "config_validation_error",
        `${options.contextPath}.workspace.source.base_ref is required for git_worktree`,
      );
    }
  }

  return {
    root,
    stateDir,
    source: {
      kind: sourceKind,
      ...(sourcePath === undefined ? {} : { path: sourcePath }),
      ...(sourceRepository === undefined ? {} : { repository: sourceRepository }),
      ...(rawWorkspace?.source?.ref === undefined ? {} : { ref: rawWorkspace.source.ref }),
      ...(rawWorkspace?.source?.base_ref === undefined ? {} : { baseRef: rawWorkspace.source.base_ref }),
      ...(rawWorkspace?.source?.branch_template === undefined
        ? {}
        : { branchTemplate: rawWorkspace.source.branch_template }),
      ...(sourceCachePath === undefined ? {} : { cachePath: sourceCachePath }),
      ...(rawWorkspace?.source?.cleanup === undefined ? {} : { cleanup: rawWorkspace.source.cleanup }),
    },
  };
}

function normalizeGitHubConfigForProjectContext(
  rawGithub: RawWorkflowConfig["github"],
  workflowDir: string,
  env: NodeJS.ProcessEnv,
  handoffStates: string[],
  reviewStates: string[],
): GitHubConfig {
  const owner = normalizeOptionalConfigString(resolveConfigString(rawGithub?.owner, env));
  const repo = normalizeOptionalConfigString(resolveConfigString(rawGithub?.repo, env));
  const token = normalizeOptionalConfigString(
    resolveConfigString(rawGithub?.token, env) ?? resolveConfigString("$GITHUB_TOKEN", env),
  );
  const app = normalizeGitHubAppConfig(rawGithub?.app, workflowDir, env);
  const headOwner = normalizeOptionalConfigString(resolveConfigString(rawGithub?.head_owner, env)) ?? owner;
  const publishPullRequests = rawGithub?.publish_pull_requests ?? false;

  return {
    owner,
    repo,
    token,
    app,
    headOwner,
    apiBaseUrl: normalizeOptionalConfigString(resolveConfigString(rawGithub?.api_base_url, env)) ?? "https://api.github.com",
    publishPullRequests,
    operatorApproval: {
      requiredForPublication: rawGithub?.operator_approval?.required_for_publication ?? false,
      rejectPolicy: rawGithub?.operator_approval?.reject_policy ?? "cancel",
      pollIntervalMs: rawGithub?.operator_approval?.poll_interval_ms ?? 2_000,
      timeoutMs: rawGithub?.operator_approval?.timeout_ms ?? null,
    },
    prHandoff: normalizePullRequestHandoff(
      { github: rawGithub } as RawWorkflowConfig,
      { publishPullRequests, handoffStates, reviewStates },
    ),
  };
}

function normalizeReviewLoopConfigForProjectContext(
  rawReviewLoop: RawWorkflowConfig["review_loop"],
  tracker: TrackerConfig,
): ReviewLoopConfig {
  const reviewStates = rawReviewLoop?.review_states ?? tracker.handoffStates;
  return {
    reviewStates,
    blockedStates: rawReviewLoop?.blocked_states ?? [],
    reviewPassState: rawReviewLoop?.review_pass_state ?? null,
    reviewerPromptTemplate: rawReviewLoop?.reviewer_prompt ?? null,
    reviewerPromptExtensions: normalizePromptExtensions(rawReviewLoop?.reviewer_prompt_extensions),
    workerPromptExtensions: normalizePromptExtensions(rawReviewLoop?.worker_prompt_extensions),
    maxReviewRounds: rawReviewLoop?.max_review_rounds ?? 3,
    maxIncompleteTurns: rawReviewLoop?.max_incomplete_turns ?? 3,
    continuationHistoryThreshold: rawReviewLoop?.continuation_history_threshold ?? 5,
    transcriptHistoryLimit:
      rawReviewLoop?.transcript_history_limit ?? rawReviewLoop?.continuation_history_threshold ?? 5,
    prReviewEvidenceLimit: rawReviewLoop?.pr_review_evidence_limit ?? 5,
  };
}

function normalizeIssueBreakdownConfigForProjectContext(
  rawIssueBreakdown: RawWorkflowConfig["issue_breakdown"],
  sourceKind: WorkspaceSourceConfig["kind"],
  contextPath: string,
  enabled: boolean,
): IssueBreakdownConfig {
  const workspaceMode = rawIssueBreakdown?.workspace_mode ?? "none";
  if (enabled && workspaceMode === "readonly_checkout") {
    if (sourceKind !== "git_worktree") {
      throw new SymphonyError(
        "config_validation_error",
        `${contextPath}.issue_breakdown.workspace_mode readonly_checkout requires workspace.source.kind git_worktree`,
      );
    }
    if (process.platform === "win32") {
      throw new SymphonyError(
        "config_validation_error",
        "issue_breakdown.workspace_mode readonly_checkout is not supported on Windows; use workspace_mode none",
      );
    }
  }

  return {
    enabled: rawIssueBreakdown?.enabled ?? false,
    cursorMode: rawIssueBreakdown?.cursor_mode ?? "plan",
    promptTemplate: rawIssueBreakdown?.prompt ?? DEFAULT_ISSUE_BREAKDOWN_PROMPT,
    planningLabels: normalizeLabels(rawIssueBreakdown?.planning_labels),
    applyToLinear: {
      enabled: rawIssueBreakdown?.apply_to_linear?.enabled ?? false,
      mode: rawIssueBreakdown?.apply_to_linear?.mode ?? "child_issues",
    },
    workspaceMode,
    maxPlanningFailures: rawIssueBreakdown?.max_planning_failures ?? 3,
    maxPlanningDispatchRetries:
      rawIssueBreakdown?.max_planning_dispatch_retries ?? rawIssueBreakdown?.max_planning_failures ?? 3,
    planningRetryBaseMs: rawIssueBreakdown?.planning_retry_base_ms ?? 5_000,
    planningRetryMaxMs: rawIssueBreakdown?.planning_retry_max_ms ?? 60_000,
  };
}

function normalizeAgentConfigForProjectContext(rawAgent: RawWorkflowConfig["agent"]): AgentConfig {
  return {
    harness: normalizeAgentHarness(rawAgent?.harness),
    maxConcurrentAgents: rawAgent?.max_concurrent_agents ?? 10,
    maxTurns: rawAgent?.max_turns ?? 20,
    maxRetryBackoffMs: rawAgent?.max_retry_backoff_ms ?? 300_000,
    maxSdkErrorRetries: rawAgent?.max_sdk_error_retries ?? 2,
    maxInfraFailures: rawAgent?.max_infra_failures ?? 3,
    maxConcurrentAgentsByState: normalizeStateLimitMap(rawAgent?.max_concurrent_agents_by_state),
    requireLabels: normalizeLabels(rawAgent?.require_labels),
    excludeLabels: normalizeLabels(rawAgent?.exclude_labels),
    protectedPaths: rawAgent?.protected_paths ?? [],
  };
}

function mergeWorkspaceDefaults(
  base: RawWorkflowConfig["workspace"] | undefined,
  override: RawProjectContextConfig["workspace"] | undefined,
): RawWorkflowConfig["workspace"] | undefined {
  if (!base && !override) return undefined;
  return {
    ...base,
    ...override,
    source:
      base?.source === undefined && override?.source === undefined
        ? undefined
        : {
            ...base?.source,
            ...override?.source,
          },
  };
}

function mergeGitHubDefaults(
  base: RawWorkflowConfig["github"] | undefined,
  override: RawProjectContextConfig["github"] | undefined,
): RawWorkflowConfig["github"] | undefined {
  if (!base && !override) return undefined;
  return {
    ...base,
    ...override,
    app:
      base?.app === undefined && override?.app === undefined
        ? undefined
        : {
            ...base?.app,
            ...override?.app,
          },
    operator_approval:
      base?.operator_approval === undefined && override?.operator_approval === undefined
        ? undefined
        : {
            ...base?.operator_approval,
            ...override?.operator_approval,
          },
    pr_handoff:
      base?.pr_handoff === undefined && override?.pr_handoff === undefined
        ? undefined
        : {
            ...base?.pr_handoff,
            ...override?.pr_handoff,
            no_ci:
              base?.pr_handoff?.no_ci === undefined && override?.pr_handoff?.no_ci === undefined
                ? undefined
                : {
                    ...base?.pr_handoff?.no_ci,
                    ...override?.pr_handoff?.no_ci,
                  },
          },
  };
}

function mergeIssueBreakdownDefaults(
  base: RawWorkflowConfig["issue_breakdown"] | undefined,
  override: RawProjectContextConfig["issue_breakdown"] | undefined,
): RawWorkflowConfig["issue_breakdown"] | undefined {
  if (!base && !override) return undefined;
  return {
    ...base,
    ...override,
    apply_to_linear:
      base?.apply_to_linear === undefined && override?.apply_to_linear === undefined
        ? undefined
        : {
            ...base?.apply_to_linear,
            ...override?.apply_to_linear,
          },
  };
}

function mergeAgentDefaults(
  base: RawWorkflowConfig["agent"] | undefined,
  override: RawProjectContextConfig["agent"] | undefined,
): RawWorkflowConfig["agent"] | undefined {
  if (!base && !override) return undefined;
  return {
    ...base,
    ...override,
    max_concurrent_agents_by_state:
      base?.max_concurrent_agents_by_state === undefined && override?.max_concurrent_agents_by_state === undefined
        ? undefined
        : {
            ...base?.max_concurrent_agents_by_state,
            ...override?.max_concurrent_agents_by_state,
          },
  };
}

function mergeConfigObjects<T extends Record<string, unknown> | undefined>(base: T, override: T): T {
  if (!base && !override) return undefined as T;
  return {
    ...(base ?? {}),
    ...(override ?? {}),
  } as T;
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

function resolveOptionalPathValue(value: string | null | undefined, baseDir: string, env: NodeJS.ProcessEnv): string | null {
  if (value === null || value === undefined) return null;
  const resolved = normalizeOptionalConfigString(resolveConfigString(value, env));
  if (resolved === null) return null;
  return resolvePathValue(resolved, baseDir, env);
}

function normalizeDatabaseConfig(raw: RawWorkflowConfig, workflowDir: string, env: NodeJS.ProcessEnv): DatabaseConfig {
  const rawPostgres = raw.database?.postgres;
  const connectionString = normalizeOptionalConfigString(
    resolveConfigString(rawPostgres?.url ?? "$SYMPHONY_POSTGRES_URL", env),
  );
  const migrationsDir = resolvePathValue(rawPostgres?.migrations_dir ?? "migrations/postgres", workflowDir, env);
  const migrationsTable = normalizePostgresIdentifier(
    rawPostgres?.migrations_table ?? "symphony_schema_migrations",
    "database.postgres.migrations_table",
  );

  return {
    postgres: {
      connectionString,
      migrationsDir,
      migrationsTable,
      ssl: rawPostgres?.ssl ?? false,
    },
  };
}

function normalizePostgresIdentifier(value: string, configPath: string): string {
  const trimmed = value.trim();
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) return trimmed;
  throw new SymphonyError(
    "config_validation_error",
    `${configPath} must be a single PostgreSQL identifier using letters, numbers, and underscores`,
  );
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
    appId || installationId || privateKey.value || privateKey.envVar || privateKeyPath,
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

function normalizeHermesAcpOptionalProfileName(value: string | null, configPath: string): string | null {
  if (value === null) return null;
  return normalizeHermesAcpProfileName(value, configPath);
}

function normalizeHermesAcpProfileName(value: string, configPath: string): string {
  const trimmed = value.trim();
  if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(trimmed)) return trimmed;
  throw new SymphonyError(
    "config_validation_error",
    `${configPath} must be a valid host Hermes profile name using 1-64 letters, numbers, underscores, or dashes, starting with a letter or number`,
  );
}

function normalizeHermesAuthProviders(providers: string[] | undefined): string[] {
  const normalized = (providers ?? ["openai-codex"]).map((provider) => provider.trim()).filter((provider) => provider.length > 0);
  const unique = [...new Set(normalized)];
  if (unique.length > 0) return unique;
  throw new SymphonyError("config_validation_error", "hermes.auth.providers must include at least one nonempty provider id");
}

function defaultHermesAuthBootstrapSource(env: NodeJS.ProcessEnv): string {
  const configured = normalizeOptionalConfigString(resolveConfigString("$HERMES_HOME", env));
  if (configured) return path.resolve(configured);
  return path.join(os.homedir(), ".hermes");
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
  const harness = (value ?? "cursor").trim();
  if (harness.length > 0) return harness;
  throw new SymphonyError("config_validation_error", "agent.harness must be a nonempty runtime harness id");
}

function normalizeEnvironmentVariableName(value: string, configPath: string): string {
  const name = value.trim();
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return name;
  throw new SymphonyError("config_validation_error", `${configPath} must be a valid environment variable name`);
}

function resolveRepositoryValue(value: string, baseDir: string, env: NodeJS.ProcessEnv): string {
  const resolved = resolveConfigString(value, env) ?? "";
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(resolved)) return resolved;
  if (/^[^/\\]+@[^:]+:.+/.test(resolved)) return resolved;
  return resolvePathValue(resolved, baseDir, env);
}

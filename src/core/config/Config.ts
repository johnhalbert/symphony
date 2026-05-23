import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { SymphonyError } from "../errors.js";
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
        max_review_rounds: z.number().int().positive().optional(),
        max_incomplete_turns: z.number().int().positive().optional(),
        continuation_history_threshold: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
    merge_policy: z
      .object({
        enabled: z.boolean().optional(),
        mode: z.enum(["disabled", "manual", "gated"]).optional(),
        source_states: stringArray.optional(),
        done_state: z.string().optional(),
        merge_method: z.enum(["merge", "squash", "rebase"]).optional(),
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
    continuation_context: z
      .object({
        search_enabled: z.boolean().optional(),
        summarization_enabled: z.boolean().optional(),
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
        model_params: z.record(z.string(), z.string()).optional(),
        setting_sources: z.array(z.string()).optional(),
        opener_command: z.string().optional(),
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
        head_owner: z.string().optional(),
        api_base_url: z.string().optional(),
        publish_pull_requests: z.boolean().optional(),
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
  modelParams: CursorModelParameter[];
  settingSources: CursorSettingSource[];
  openerCommand: string | null;
}

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
  headOwner: string | null;
  apiBaseUrl: string;
  publishPullRequests: boolean;
}

export interface ReviewLoopConfig {
  reviewStates: string[];
  blockedStates: string[];
  reviewPassState: string | null;
  reviewerPromptTemplate: string | null;
  maxReviewRounds: number;
  maxIncompleteTurns: number;
  continuationHistoryThreshold: number;
}

export interface MergePolicyConfig {
  mode: "disabled" | "manual" | "gated";
  sourceStates: string[];
  doneState: string;
  mergeMethod: "merge" | "squash" | "rebase";
  requiredChecks: string[];
  noCiAllowed: boolean;
  noCiEvidence: string | null;
}

export interface ContinuationContextConfig {
  searchEnabled: boolean;
  summarizationEnabled: boolean;
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
  continuationContext: ContinuationContextConfig;
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
const DEFAULT_CURSOR_MODEL_PARAMS: CursorModelParameter[] = [{ id: "reasoning", value: "extra-high" }];

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
  const githubHeadOwner = normalizeOptionalConfigString(resolveConfigString(raw.github?.head_owner, env)) ?? githubOwner;
  const publishPullRequests = raw.github?.publish_pull_requests ?? false;
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
  const mergePolicy = normalizeMergePolicy(raw, reviewPassState);
  validateStateBuckets({
    activeStates,
    handoffStates,
    terminalStates,
    reviewStates,
    blockedStates,
    reviewPassState,
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
      maxConcurrentAgentsByState: normalizeStateLimitMap(raw.agent?.max_concurrent_agents_by_state),
      requireLabels: normalizeLabels(raw.agent?.require_labels),
      excludeLabels: normalizeLabels(raw.agent?.exclude_labels),
      protectedPaths: raw.agent?.protected_paths ?? [],
    },
    cursor: {
      model: raw.cursor?.model ?? DEFAULT_CURSOR_MODEL,
      modelParams: normalizeCursorModelParams(raw.cursor?.model_params),
      settingSources: normalizeCursorSettingSources(raw.cursor?.setting_sources),
      openerCommand: raw.cursor?.opener_command ?? null,
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
      headOwner: githubHeadOwner,
      apiBaseUrl: normalizeOptionalConfigString(resolveConfigString(raw.github?.api_base_url, env)) ?? "https://api.github.com",
      publishPullRequests,
    },
    credentialProfiles,
    reviewLoop: {
      reviewStates,
      blockedStates,
      reviewPassState,
      reviewerPromptTemplate: raw.review_loop?.reviewer_prompt ?? null,
      maxReviewRounds: raw.review_loop?.max_review_rounds ?? 3,
      maxIncompleteTurns: raw.review_loop?.max_incomplete_turns ?? 3,
      continuationHistoryThreshold: raw.review_loop?.continuation_history_threshold ?? 5,
    },
    mergePolicy,
    continuationContext: {
      searchEnabled: raw.continuation_context?.search_enabled ?? false,
      summarizationEnabled: raw.continuation_context?.summarization_enabled ?? false,
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
  return {
    mode,
    sourceStates: rawPolicy?.source_states ?? (reviewPassState === null ? [] : [reviewPassState]),
    doneState: rawPolicy?.done_state ?? "Done",
    mergeMethod: rawPolicy?.merge_method ?? "merge",
    requiredChecks: rawPolicy?.required_checks ?? [],
    noCiAllowed: rawPolicy?.no_ci?.allowed ?? false,
    noCiEvidence,
  };
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
  const requested = values ?? ["project", "user"];
  const filtered = requested.filter((value): value is CursorSettingSource =>
    VALID_CURSOR_SETTING_SOURCES.has(value as CursorSettingSource),
  );
  return filtered.length > 0 ? filtered : ["project", "user"];
}

function normalizeCursorModelParams(values: Record<string, string> | undefined): CursorModelParameter[] {
  if (values === undefined) return [...DEFAULT_CURSOR_MODEL_PARAMS];
  return Object.entries(values)
    .filter(([id, value]) => id.length > 0 && value.length > 0)
    .map(([id, value]) => ({ id, value }));
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

import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { SymphonyError } from "../errors.js";

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
        terminal_states: stringArray.optional(),
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
const DEFAULT_CURSOR_MODEL_PARAMS: CursorModelParameter[] = [{ id: "thinking", value: "xhigh" }];

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

  const projectSlug = raw.tracker?.project_slug ?? "";
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

  return {
    workflowPath: path.resolve(workflowPath),
    workflowDir,
    tracker: {
      kind: "linear",
      endpoint: raw.tracker?.endpoint ?? "https://api.linear.app/graphql",
      apiKey: trackerApiKey,
      projectSlug,
      assignee: trackerAssignee.length === 0 ? null : trackerAssignee,
      activeStates: raw.tracker?.active_states ?? DEFAULT_ACTIVE_STATES,
      terminalStates: raw.tracker?.terminal_states ?? DEFAULT_TERMINAL_STATES,
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
      openWorkspaceToken: raw.server?.open_workspace_token ?? null,
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

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { LinearWorkflowTeamStates } from "./integrations/linear/LinearTrackerClient.js";
import { createLinearTrackerClientForCapability } from "./integrations/linear/LinearCredentialResolver.js";
import { createGitHubPullRequestClientForCapability } from "./integrations/github/GitHubCredentialResolver.js";
import { WorkflowLoader } from "./core/workflow/WorkflowLoader.js";
import { errorMessage } from "./core/errors.js";
import type { ServiceConfig } from "./core/config/Config.js";
import { resolveCursorRuntimeApiKey } from "./app/RuntimeDependencies.js";
import { COMPLETION_REPORT_TOOL_NAME } from "./core/harness/CompletionReportMcpServer.js";
import { runSubprocessMcpToolExposureProbe } from "./core/harness/McpToolExposureProbe.js";
import { REVIEW_FEEDBACK_TOOL_NAME } from "./core/harness/ReviewFeedbackMcpServer.js";
import { REVIEW_VERDICT_TOOL_NAME } from "./core/harness/ReviewVerdictMcpServer.js";
import { CONTINUATION_CONTEXT_ROADMAP } from "./core/summarization/ContinuationContextRoadmap.js";

const execFileAsync = promisify(execFile);

export type DoctorStatus = "ok" | "warn" | "error";

export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  message: string;
}

export interface DoctorResult {
  ok: boolean;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  workflowPath: string;
  strict?: boolean | undefined;
  cliPath?: string | undefined;
}

export interface ReviewLoopDoctorCheckOptions {
  workflowPath: string;
  cliPath?: string | undefined;
  mcpToolLister?: McpToolLister;
  linearStateLister?: LinearStateLister;
}

export type McpToolServerCommand = "completion-report-mcp" | "review-verdict-mcp" | "review-feedback-mcp";

export type McpToolLister = (input: {
  command: McpToolServerCommand;
  config: ServiceConfig;
  workflowPath: string;
  cliPath: string;
}) => Promise<string[]>;

export type LinearStateLister = (input: { config: ServiceConfig }) => Promise<LinearWorkflowTeamStates[]>;

export async function runDoctor(options: DoctorOptions): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const workflowPath = path.resolve(options.workflowPath);
  const loader = new WorkflowLoader(workflowPath);

  try {
    const loaded = await loader.load();
    const config = loaded.serviceConfig;
    checks.push({ id: "workflow.parse", status: "ok", message: `Loaded ${workflowPath}` });
    checks.push(...cursorPolicyDoctorChecks(config));
    checks.push({
      id: "agent.concurrency",
      status: config.agent.maxConcurrentAgents === 1 ? "ok" : "warn",
      message: `max_concurrent_agents is ${config.agent.maxConcurrentAgents}`,
    });
    checks.push({
      id: "tracker.handoff",
      status: config.tracker.handoffStates.length > 0 ? "ok" : "warn",
      message:
        config.tracker.handoffStates.length > 0
          ? `handoff_states: ${config.tracker.handoffStates.join(", ")}`
          : "No handoff_states configured",
    });
    checks.push(...(await reviewLoopDoctorChecks(config, { workflowPath, cliPath: options.cliPath })));
    checks.push(...continuationContextDoctorChecks(config));

    await checkWritable(checks, "workspace.root", config.workspace.root);
    await checkWritable(checks, "workspace.state_dir", config.workspace.stateDir);
    await checkGit(checks);
    checks.push(await githubPublicationDoctorCheck(config));
    checks.push(await githubReviewFeedbackDoctorCheck(config));

    checks.push(cursorRuntimeDoctorCheck(config));

    const tracker = createLinearTrackerClientForCapability(config, "linear.tracker");
    try {
      const candidates = await tracker.fetchCandidateIssues();
      checks.push({
        id: "linear.candidates",
        status: candidates.length === 0 ? "ok" : "warn",
        message: `${candidates.length} candidate issue(s) currently match active states and assignee routing`,
      });
    } catch (error) {
      checks.push({ id: "linear.candidates", status: "error", message: errorMessage(error) });
    }
  } catch (error) {
    checks.push({ id: "workflow.parse", status: "error", message: errorMessage(error) });
  } finally {
    await loader.close();
  }

  const hasError = checks.some((check) => check.status === "error");
  const hasWarning = checks.some((check) => check.status === "warn");
  return { ok: !hasError && !(options.strict && hasWarning), checks };
}

export function formatDoctorResult(result: DoctorResult): string {
  return result.checks
    .map((check) => `[${check.status.toUpperCase()}] ${check.id}: ${check.message}`)
    .join("\n");
}

export function continuationContextDoctorChecks(config: ServiceConfig): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const enabled = [
    { configKey: "searchEnabled" as const, roadmap: CONTINUATION_CONTEXT_ROADMAP.search },
    { configKey: "summarizationEnabled" as const, roadmap: CONTINUATION_CONTEXT_ROADMAP.summarization },
  ];

  for (const item of enabled) {
    if (!config.continuationContext[item.configKey]) continue;
    if (item.roadmap.implementationStatus === "implemented") {
      checks.push({
        id: `continuation_context.${item.roadmap.capability}`,
        status: "ok",
        message: `${item.roadmap.flag} is enabled and ${item.roadmap.capability} is implemented`,
      });
      continue;
    }
    checks.push({
      id: `continuation_context.${item.roadmap.capability}`,
      status: "warn",
      message:
        `${item.roadmap.flag} is enabled, but ${item.roadmap.capability} is ${item.roadmap.implementationStatus}; ` +
        "keep roadmap issues in Backlog with dogfood-blocked and without dogfood-ready until a concrete implementation lands",
    });
  }

  return checks;
}

export function cursorPolicyDoctorChecks(config: ServiceConfig): DoctorCheck[] {
  const context = config.cursor.modelParams.find((param) => param.id === "context")?.value ?? "none";
  return [
    {
      id: "cursor.model",
      status: hasBaselineCursorModel(config.cursor.model, config.cursor.modelParams, config.cursor.allowLargeContext) ? "ok" : "warn",
      message:
        `Cursor model is ${config.cursor.model} with params ${formatModelParams(config.cursor.modelParams)}; ` +
        `large context opt-in is ${config.cursor.allowLargeContext ? "enabled" : "disabled"}`,
    },
    {
      id: "cursor.context",
      status: config.cursor.model === "gpt-5.5" && context === "272k" && !config.cursor.allowLargeContext ? "ok" : "warn",
      message:
        config.cursor.model === "gpt-5.5" && context === "272k" && !config.cursor.allowLargeContext
          ? "Managed Cursor runs are bounded to context=272k"
          : `Managed Cursor context policy is non-default: context=${context}, allow_large_context=${config.cursor.allowLargeContext}`,
    },
    {
      id: "cursor.setting_sources",
      status: config.cursor.settingSources.length === 0 ? "ok" : "warn",
      message:
        config.cursor.settingSources.length === 0
          ? "Managed Cursor runs do not load project/user setting sources by default"
          : `Managed Cursor runs load setting sources: ${config.cursor.settingSources.join(", ")}`,
    },
    {
      id: "cursor.mode",
      status: config.cursor.mode === null || config.cursor.mode === "agent" ? "ok" : "warn",
      message:
        config.cursor.mode === null
          ? "Managed Cursor runs use the SDK default conversation mode"
          : `Managed Cursor runs request ${config.cursor.mode} conversation mode`,
    },
  ];
}

function hasBaselineCursorModel(
  model: string,
  modelParams: Array<{ id: string; value: string }>,
  allowLargeContext: boolean,
): boolean {
  return (
    model === "gpt-5.5" &&
    !allowLargeContext &&
    modelParams.some((param) => param.id === "context" && param.value === "272k") &&
    modelParams.some((param) => param.id === "reasoning" && param.value === "extra-high")
  );
}

function formatModelParams(modelParams: Array<{ id: string; value: string }>): string {
  if (modelParams.length === 0) return "none";
  return modelParams.map((param) => `${param.id}=${param.value}`).join(", ");
}

async function checkWritable(checks: DoctorCheck[], id: string, directory: string): Promise<void> {
  const probe = path.join(directory, `.doctor-${randomUUID()}`);
  try {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(probe, "ok", "utf8");
    await fs.rm(probe, { force: true });
    checks.push({ id, status: "ok", message: `${directory} is writable` });
  } catch (error) {
    checks.push({ id, status: "error", message: errorMessage(error) });
  }
}

export async function reviewLoopDoctorChecks(
  config: ServiceConfig,
  options: ReviewLoopDoctorCheckOptions,
): Promise<DoctorCheck[]> {
  return [
    reviewLoopStateCheck(config),
    await linearStateAvailabilityCheck(config, options),
    blockedAvailabilityCheck(config),
    await mcpToolAvailabilityCheck(config, options),
    candidateIsolationCheck(config),
  ];
}

function reviewLoopStateCheck(config: ServiceConfig): DoctorCheck {
  if (config.reviewLoop.reviewStates.length === 0) {
    return { id: "review_loop.states", status: "error", message: "review_loop.review_states must include an agent review queue state" };
  }
  if (config.reviewLoop.reviewPassState === null) {
    return {
      id: "review_loop.states",
      status: "error",
      message: "review_loop.review_pass_state must name the configured pass destination for dogfood smoke",
    };
  }
  return {
    id: "review_loop.states",
    status: "ok",
    message: `review_states: ${config.reviewLoop.reviewStates.join(", ")}; pass destination: ${config.reviewLoop.reviewPassState}`,
  };
}

async function linearStateAvailabilityCheck(
  config: ServiceConfig,
  options: ReviewLoopDoctorCheckOptions,
): Promise<DoctorCheck> {
  const requiredStates = uniqueStates([
    ...config.tracker.handoffStates,
    ...config.reviewLoop.reviewStates,
    ...config.reviewLoop.blockedStates,
    ...(config.reviewLoop.reviewPassState === null ? [] : [config.reviewLoop.reviewPassState]),
  ]);
  if (requiredStates.length === 0) {
    return {
      id: "review_loop.linear_states",
      status: "warn",
      message: "No review-loop Linear states are configured to verify",
    };
  }

  const lister =
    options.linearStateLister ??
    ((input) => createLinearTrackerClientForCapability(input.config, "linear.tracker").fetchWorkflowStatesByTeam());
  try {
    const teamStates = await lister({ config });
    if (teamStates.length === 0) {
      return {
        id: "review_loop.linear_states",
        status: "error",
        message: "Linear project did not return any teams to verify review-loop states",
      };
    }

    const missingByTeam = teamStates
      .map((team) => ({
        team,
        missing: requiredStates.filter((state) => !stateIn(state, team.states)),
      }))
      .filter((item) => item.missing.length > 0);
    if (missingByTeam.length > 0) {
      return {
        id: "review_loop.linear_states",
        status: "error",
        message: `Linear teams are missing configured review-loop states: ${missingByTeam
          .map(
            (item) =>
              `${formatTeamStateLabel(item.team)} missing ${item.missing.join(", ")} (available: ${formatStateList(item.team.states)})`,
          )
          .join("; ")}`,
      };
    }
    return {
      id: "review_loop.linear_states",
      status: "ok",
      message: `Linear project teams have configured review-loop states: ${requiredStates.join(", ")} (${teamStates
        .map(formatTeamStateLabel)
        .join("; ")})`,
    };
  } catch (error) {
    return {
      id: "review_loop.linear_states",
      status: "error",
      message: `Could not verify Linear review-loop state availability: ${errorMessage(error)}`,
    };
  }
}

function blockedAvailabilityCheck(config: ServiceConfig): DoctorCheck {
  if (config.reviewLoop.blockedStates.length === 0) {
    return {
      id: "review_loop.blocked_state",
      status: "warn",
      message: "No review_loop.blocked_states configured; blocked escalations will comment but leave Linear state unchanged",
    };
  }
  return {
    id: "review_loop.blocked_state",
    status: "ok",
    message: `blocked_states: ${config.reviewLoop.blockedStates.join(", ")}`,
  };
}

async function mcpToolAvailabilityCheck(
  config: ServiceConfig,
  options: ReviewLoopDoctorCheckOptions,
): Promise<DoctorCheck> {
  if (!options.mcpToolLister) {
    if (!options.cliPath) {
      return {
        id: "review_loop.mcp_tools",
        status: "error",
        message: "Configured Cursor CLI could not list review-loop MCP tools: missing explicit cliPath",
      };
    }
    const stage = await runSubprocessMcpToolExposureProbe(config, { cliPath: options.cliPath });
    if (stage.status === "failure") {
      return {
        id: "review_loop.mcp_tools",
        status: "error",
        message: `Configured Cursor CLI MCP exposure failed (${stage.failureCode ?? "unknown"}): ${stage.message}`,
      };
    }
    return {
      id: "review_loop.mcp_tools",
      status: "ok",
      message: `Configured Cursor CLI exposes MCP tools: ${stage.results.map((result) => result.expectedTool).join(", ")}`,
    };
  }
  const lister = options.mcpToolLister;
  const expected = [
    { command: "completion-report-mcp" as const, tool: COMPLETION_REPORT_TOOL_NAME },
    { command: "review-verdict-mcp" as const, tool: REVIEW_VERDICT_TOOL_NAME },
    { command: "review-feedback-mcp" as const, tool: REVIEW_FEEDBACK_TOOL_NAME },
  ];
  try {
    const missing: string[] = [];
    for (const item of expected) {
      const tools = await lister({ command: item.command, config, workflowPath: options.workflowPath, cliPath: options.cliPath ?? "" });
      if (!tools.includes(item.tool)) missing.push(`${item.command}:${item.tool}`);
    }
    if (missing.length > 0) {
      return {
        id: "review_loop.mcp_tools",
        status: "error",
        message: `Configured Cursor CLI did not list required MCP tools: ${missing.join(", ")}`,
      };
    }
    return {
      id: "review_loop.mcp_tools",
      status: "ok",
      message: `Configured Cursor CLI lists MCP tools: ${expected.map((item) => item.tool).join(", ")}`,
    };
  } catch (error) {
    return {
      id: "review_loop.mcp_tools",
      status: "error",
      message: `Configured Cursor CLI could not list review-loop MCP tools: ${errorMessage(error)}`,
    };
  }
}

function candidateIsolationCheck(config: ServiceConfig): DoctorCheck {
  const reviewActiveOverlap = overlappingStates(config.reviewLoop.reviewStates, config.tracker.activeStates);
  const blockedActiveOverlap = overlappingStates(config.reviewLoop.blockedStates, config.tracker.activeStates);
  if (reviewActiveOverlap.length > 0 || blockedActiveOverlap.length > 0) {
    return {
      id: "review_loop.candidate_isolation",
      status: "error",
      message: `Review-loop states overlap worker candidates: ${[...reviewActiveOverlap, ...blockedActiveOverlap].join(", ")}`,
    };
  }
  if (config.agent.requireLabels.length === 0) {
    return {
      id: "review_loop.candidate_isolation",
      status: "warn",
      message: "No required dispatch labels configured; any routed active-state issue can become a candidate",
    };
  }
  return {
    id: "review_loop.candidate_isolation",
    status: "ok",
    message: `worker candidates require labels: ${config.agent.requireLabels.join(", ")}; review/blocked states are isolated from active states`,
  };
}

function overlappingStates(left: string[], right: string[]): string[] {
  return left.filter((state) => stateIn(state, right));
}

function uniqueStates(states: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const state of states) {
    const key = state.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(state);
  }
  return result;
}

function formatStateList(states: string[]): string {
  return states.length === 0 ? "none" : states.join(", ");
}

function formatTeamStateLabel(team: LinearWorkflowTeamStates): string {
  return team.teamName ? `${team.teamName} (${team.teamKey})` : team.teamKey;
}

function stateIn(state: string, states: string[]): boolean {
  return states.some((candidate) => candidate.toLowerCase() === state.toLowerCase());
}

async function checkGit(checks: DoctorCheck[]): Promise<void> {
  try {
    const result = await execFileAsync("git", ["--version"]);
    checks.push({ id: "git.binary", status: "ok", message: result.stdout.trim() });
  } catch (error) {
    checks.push({ id: "git.binary", status: "error", message: errorMessage(error) });
  }
}

export async function githubPublicationDoctorCheck(config: ServiceConfig): Promise<DoctorCheck> {
  if (!config.github.publishPullRequests) {
    return { id: "github.pr_publication", status: "ok", message: "PR publication is disabled" };
  }
  try {
    const github = createGitHubPullRequestClientForCapability(config, "github.publication");
    await github.checkRepositoryAccess();
    return {
      id: "github.pr_publication",
      status: "ok",
      message: githubAccessMessage("GitHub PR publication", config, github),
    };
  } catch (error) {
    return { id: "github.pr_publication", status: "error", message: `github.publication: ${errorMessage(error)}` };
  }
}

export async function githubReviewFeedbackDoctorCheck(config: ServiceConfig): Promise<DoctorCheck> {
  try {
    const github = createGitHubPullRequestClientForCapability(config, "github.review_feedback_write");
    await github.checkRepositoryAccess();
    return {
      id: "github.review_feedback_write",
      status: "ok",
      message: githubAccessMessage("GitHub PR review feedback", config, github),
    };
  } catch (error) {
    return { id: "github.review_feedback_write", status: "error", message: `github.review_feedback_write: ${errorMessage(error)}` };
  }
}

function githubAccessMessage(
  action: "GitHub PR publication" | "GitHub PR review feedback",
  config: ServiceConfig,
  github: ReturnType<typeof createGitHubPullRequestClientForCapability>,
): string {
  const base = `${action} can access ${config.github.owner}/${config.github.repo}`;
  const authDescription = github.authenticationDescription();
  return authDescription?.startsWith("GitHub App") ? `${base} using ${authDescription}` : base;
}

function cursorRuntimeDoctorCheck(config: ServiceConfig): DoctorCheck {
  try {
    const missing = (["worker", "reviewer"] as const).filter((role) => !resolveCursorRuntimeApiKey(config, role));
    if (missing.length === 0) {
      return { id: "env.cursor", status: "ok", message: "cursor.runtime credentials are available for worker and reviewer" };
    }
    return {
      id: "env.cursor",
      status: "warn",
      message: `cursor.runtime credentials are missing for ${missing.join(", ")}; SDK smoke cannot run`,
    };
  } catch (error) {
    return { id: "env.cursor", status: "error", message: `cursor.runtime: ${errorMessage(error)}` };
  }
}


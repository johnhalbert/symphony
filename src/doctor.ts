import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { LinearTrackerClient } from "./integrations/linear/LinearTrackerClient.js";
import { GitHubPullRequestClient } from "./integrations/github/GitHubPullRequestClient.js";
import { WorkflowLoader } from "./core/workflow/WorkflowLoader.js";
import { errorMessage } from "./core/errors.js";
import type { ServiceConfig } from "./core/config/Config.js";
import { COMPLETION_REPORT_TOOL_NAME } from "./core/harness/CompletionReportMcpServer.js";
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
}

export interface ReviewLoopDoctorCheckOptions {
  workflowPath: string;
  mcpToolLister?: McpToolLister;
  linearStateLister?: LinearStateLister;
}

export type McpToolServerCommand = "completion-report-mcp" | "review-verdict-mcp";

export type McpToolLister = (input: {
  command: McpToolServerCommand;
  config: ServiceConfig;
  workflowPath: string;
}) => Promise<string[]>;

export type LinearStateLister = (input: { config: ServiceConfig }) => Promise<string[]>;

export async function runDoctor(options: DoctorOptions): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const workflowPath = path.resolve(options.workflowPath);
  const loader = new WorkflowLoader(workflowPath);

  try {
    const loaded = await loader.load();
    const config = loaded.serviceConfig;
    checks.push({ id: "workflow.parse", status: "ok", message: `Loaded ${workflowPath}` });
    checks.push({
      id: "cursor.model",
      status: hasBaselineCursorModel(config.cursor.model, config.cursor.modelParams) ? "ok" : "warn",
      message: `Cursor model is ${config.cursor.model} with params ${formatModelParams(config.cursor.modelParams)}`,
    });
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
    checks.push(...(await reviewLoopDoctorChecks(config, { workflowPath })));
    checks.push(...continuationContextDoctorChecks(config));

    await checkWritable(checks, "workspace.root", config.workspace.root);
    await checkWritable(checks, "workspace.state_dir", config.workspace.stateDir);
    await checkGit(checks);
    await checkGitHubPublication(checks, config.github);

    if (process.env.CURSOR_API_KEY) {
      checks.push({ id: "env.cursor", status: "ok", message: "CURSOR_API_KEY is set" });
    } else {
      checks.push({ id: "env.cursor", status: "warn", message: "CURSOR_API_KEY is not set; SDK smoke cannot run" });
    }

    const tracker = new LinearTrackerClient(config.tracker);
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

function hasBaselineCursorModel(model: string, modelParams: Array<{ id: string; value: string }>): boolean {
  return model === "gpt-5.5" && modelParams.some((param) => param.id === "reasoning" && param.value === "extra-high");
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
  const missingHandoff = config.reviewLoop.reviewStates.filter((state) => !stateIn(state, config.tracker.handoffStates));
  if (missingHandoff.length > 0) {
    return {
      id: "review_loop.states",
      status: "warn",
      message: `review states are not tracker handoff states: ${missingHandoff.join(", ")}`,
    };
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

  const lister = options.linearStateLister ?? ((input) => new LinearTrackerClient(input.config.tracker).fetchWorkflowStateNames());
  try {
    const availableStates = await lister({ config });
    const missing = requiredStates.filter((state) => !stateIn(state, availableStates));
    if (missing.length > 0) {
      return {
        id: "review_loop.linear_states",
        status: "error",
        message: `Linear team is missing configured review-loop states: ${missing.join(", ")}. Available states: ${formatStateList(availableStates)}`,
      };
    }
    return {
      id: "review_loop.linear_states",
      status: "ok",
      message: `Linear team has configured review-loop states: ${requiredStates.join(", ")}`,
    };
  } catch (error) {
    return {
      id: "review_loop.linear_states",
      status: "warn",
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
  const lister = options.mcpToolLister ?? listMcpToolsViaConfiguredCli;
  const expected = [
    { command: "completion-report-mcp" as const, tool: COMPLETION_REPORT_TOOL_NAME },
    { command: "review-verdict-mcp" as const, tool: REVIEW_VERDICT_TOOL_NAME },
  ];
  try {
    const missing: string[] = [];
    for (const item of expected) {
      const tools = await lister({ command: item.command, config, workflowPath: options.workflowPath });
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

async function listMcpToolsViaConfiguredCli(input: {
  command: McpToolServerCommand;
  config: ServiceConfig;
  workflowPath: string;
}): Promise<string[]> {
  const cliPath = process.argv[1];
  if (!cliPath) throw new Error("Unable to determine current Symphony CLI path");
  const contextFile = path.join(input.config.workspace.stateDir, `.doctor-${input.command}-${randomUUID()}.json`);
  const args = [
    ...process.execArgv,
    cliPath,
    input.command,
    "--workflow",
    input.workflowPath,
    "--context-file",
    contextFile,
  ];
  return listMcpToolsViaCommand({
    command: process.execPath,
    args,
    cwd: input.config.workflowDir,
  });
}

async function listMcpToolsViaCommand(input: {
  command: string;
  args: string[];
  cwd: string;
}): Promise<string[]> {
  const child = spawn(input.command, input.args, {
    cwd: input.cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 5_000);

  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin.end(
    [
      jsonRpcMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      jsonRpcMessage({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    ].join(""),
  );

  await new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error("MCP tools/list timed out"));
        return;
      }
      if (code !== 0) {
        reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `MCP tools/list exited with ${code}`));
        return;
      }
      resolve();
    });
  });

  const toolsList = parseJsonRpcResponses(Buffer.concat(stdout)).find((response) => response.id === 2);
  if (!toolsList) throw new Error("MCP tools/list did not return a response");
  if (toolsList.error) throw new Error(toolsList.error.message);
  const result = asRecord(toolsList.result);
  return asRecordArray(result.tools)
    .map((tool) => tool.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
}

function jsonRpcMessage(message: unknown): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

interface JsonRpcResponse {
  id?: string | number | null;
  result?: unknown;
  error?: { message: string };
}

function parseJsonRpcResponses(output: Buffer): JsonRpcResponse[] {
  const responses: JsonRpcResponse[] = [];
  let buffer = output;
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return responses;
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const contentLength = Number(header.match(/content-length:\s*(\d+)/i)?.[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + contentLength;
    if (!Number.isInteger(contentLength) || buffer.length < bodyEnd) return responses;
    const body = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
    responses.push(JSON.parse(body) as JsonRpcResponse);
    buffer = buffer.subarray(bodyEnd);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new Error("Expected JSON-RPC record");
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value) && value.every((item) => typeof item === "object" && item !== null && !Array.isArray(item))) {
    return value as Array<Record<string, unknown>>;
  }
  throw new Error("Expected JSON-RPC record array");
}

async function checkGitHubPublication(checks: DoctorCheck[], github: { publishPullRequests: boolean; owner: string | null; repo: string | null; token: string | null; apiBaseUrl: string; headOwner: string | null }): Promise<void> {
  if (!github.publishPullRequests) {
    checks.push({ id: "github.pr_publication", status: "ok", message: "PR publication is disabled" });
    return;
  }
  if (!github.owner || !github.repo || !github.token) {
    checks.push({
      id: "github.pr_publication",
      status: "error",
      message: "GitHub owner, repo, and token are required when PR publication is enabled",
    });
    return;
  }
  try {
    await new GitHubPullRequestClient(github).checkRepositoryAccess();
    checks.push({
      id: "github.pr_publication",
      status: "ok",
      message: `GitHub PR publication can access ${github.owner}/${github.repo}`,
    });
  } catch (error) {
    checks.push({ id: "github.pr_publication", status: "error", message: errorMessage(error) });
  }
}

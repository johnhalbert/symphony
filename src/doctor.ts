import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { LinearTrackerClient } from "./integrations/linear/LinearTrackerClient.js";
import { GitHubPullRequestClient } from "./integrations/github/GitHubPullRequestClient.js";
import { WorkflowLoader } from "./core/workflow/WorkflowLoader.js";
import { errorMessage } from "./core/errors.js";

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

async function checkGit(checks: DoctorCheck[]): Promise<void> {
  try {
    const result = await execFileAsync("git", ["--version"]);
    checks.push({ id: "git.binary", status: "ok", message: result.stdout.trim() });
  } catch (error) {
    checks.push({ id: "git.binary", status: "error", message: errorMessage(error) });
  }
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

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRunContext } from "./AgentHarness.js";

export const SYMPHONY_AGENT_COMMAND_POLICY = "worker_reviewer_github_upstream_block";

const SHIM_TOOLS = ["git", "gh", "ssh", "curl"] as const;

export function workerReviewerGithubCommandPolicyEnv(ctx: Pick<AgentRunContext, "role">): Record<string, string> {
  if (ctx.role !== "worker" && ctx.role !== "reviewer") return {};
  return baseWorkerReviewerGithubCommandPolicyEnv(ctx.role);
}

export function workerReviewerGithubCommandPolicyProcessEnv(ctx: AgentRunContext): Record<string, string> {
  if (ctx.role !== "worker" && ctx.role !== "reviewer") return {};
  const env = baseWorkerReviewerGithubCommandPolicyEnv(ctx.role);
  const shimDir = ensureWorkerReviewerGithubPolicyShims(ctx);
  const existingPath = process.env.PATH ?? process.env.Path ?? "";
  const existingPythonPath = process.env.PYTHONPATH ?? "";
  const upstreamRoot = ctx.config.hermes.upstreamRoot;
  const askpassPath = path.join(shimDir, process.platform === "win32" ? "symphony-deny-askpass.cmd" : "symphony-deny-askpass");

  return {
    ...env,
    GIT_ASKPASS: askpassPath,
    SSH_ASKPASS: askpassPath,
    PATH: shimDir + (existingPath ? path.delimiter + existingPath : ""),
    PYTHONPATH: upstreamRoot + (existingPythonPath ? path.delimiter + existingPythonPath : ""),
    ...(process.platform === "win32" ? { PATHEXT: ensurePathextIncludesCmd(process.env.PATHEXT) } : {}),
  };
}

export async function withWorkerReviewerGithubCommandPolicyProcessEnv<T>(
  ctx: AgentRunContext,
  operation: () => Promise<T>,
): Promise<T> {
  const overlay = workerReviewerGithubCommandPolicyProcessEnv(ctx);
  if (Object.keys(overlay).length === 0) return operation();

  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overlay)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await operation();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function baseWorkerReviewerGithubCommandPolicyEnv(role: "worker" | "reviewer"): Record<string, string> {
  return {
    SYMPHONY_AGENT_COMMAND_POLICY,
    SYMPHONY_AGENT_ROLE: role,
    SYMPHONY_RUN_ROLE: role,
    HERMES_SYMPHONY_ROLE: role,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GH_PROMPT_DISABLED: "1",
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
    SSH_ASKPASS_REQUIRE: "never",
  };
}

function ensureWorkerReviewerGithubPolicyShims(ctx: AgentRunContext): string {
  const shimDir = path.join(
    ctx.config.workspace.stateDir || os.tmpdir(),
    "command-policy",
    safePathSegment(ctx.issue.identifier || ctx.issue.id || "issue"),
    ctx.role,
    "bin",
  );
  mkdirSync(shimDir, { recursive: true });
  const python = shellWord(ctx.config.hermes.python ?? "python");
  for (const tool of SHIM_TOOLS) {
    const posixPath = path.join(shimDir, tool);
    writeExecutable(
      posixPath,
      `#!/bin/sh\nexec ${python} -m tools.worker_github_policy ${shellWord(tool)} "$@"\n`,
    );
    const cmdPath = path.join(shimDir, `${tool}.cmd`);
    writeExecutable(cmdPath, `@echo off\r\n${cmdWord(ctx.config.hermes.python ?? "python")} -m tools.worker_github_policy ${tool} %*\r\n`);
  }
  writeExecutable(
    path.join(shimDir, "symphony-deny-askpass"),
    "#!/bin/sh\necho 'Symphony worker/reviewer command policy: interactive GitHub credentials are disabled.' >&2\nexit 1\n",
  );
  writeExecutable(
    path.join(shimDir, "symphony-deny-askpass.cmd"),
    "@echo off\r\necho Symphony worker/reviewer command policy: interactive GitHub credentials are disabled. 1>&2\r\nexit /b 1\r\n",
  );
  return shimDir;
}

function writeExecutable(filePath: string, content: string): void {
  writeFileSync(filePath, content, "utf8");
  try {
    chmodSync(filePath, 0o755);
  } catch {
    // Windows chmod support is best-effort; PATHEXT .cmd shims cover native shells.
  }
}

function ensurePathextIncludesCmd(value: string | undefined): string {
  const current = value || ".COM;.EXE;.BAT;.CMD";
  return current.toUpperCase().split(";").includes(".CMD") ? current : `${current};.CMD`;
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_") || "issue";
}

function shellWord(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function cmdWord(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

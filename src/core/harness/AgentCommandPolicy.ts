import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRunContext } from "./AgentHarness.js";

export const SYMPHONY_AGENT_COMMAND_POLICY = "worker_reviewer_github_upstream_block";

const SHIM_TOOLS = [
  "git",
  "gh",
  "ssh",
  "ssh-keyscan",
  "ssh-keygen",
  "ssh-add",
  "curl",
  "wget",
  "env",
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "python",
  "python3",
  "pythonw",
  "py",
  "pypy",
  "pypy3",
] as const;
const POLICY_SHELL_TOOLS = ["bash", "sh", "zsh", "dash", "ksh", "fish"] as const;
const REAL_TOOL_ENV_PREFIX = "SYMPHONY_REAL_";
const WORKER_REVIEWER_POLICY_ENV_KEYS = [
  "SYMPHONY_AGENT_COMMAND_POLICY",
  "SYMPHONY_AGENT_COMMAND_POLICY_DISABLED",
  "SYMPHONY_AGENT_ROLE",
  "SYMPHONY_RUN_ROLE",
  "HERMES_SYMPHONY_ROLE",
  "SYMPHONY_COMMAND_POLICY_SHIM_DIR",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "GIT_TERMINAL_PROMPT",
  "GCM_INTERACTIVE",
  "GH_PROMPT_DISABLED",
  "GIT_SSH_COMMAND",
  "SSH_ASKPASS_REQUIRE",
  "SHELL",
] as const;

export function workerReviewerGithubCommandPolicyEnv(ctx: Pick<AgentRunContext, "role">): Record<string, string> {
  if (ctx.role !== "worker" && ctx.role !== "reviewer") return {};
  return baseWorkerReviewerGithubCommandPolicyEnv(ctx.role);
}

export function workerReviewerGithubCommandPolicyProcessEnv(ctx: AgentRunContext): Record<string, string> {
  if (ctx.role !== "worker" && ctx.role !== "reviewer") return {};
  const env = baseWorkerReviewerGithubCommandPolicyEnv(ctx.role);
  const existingPath = process.env.PATH ?? process.env.Path ?? "";
  const shimDir = ensureWorkerReviewerGithubPolicyShims(ctx, existingPath);
  const existingPythonPath = process.env.PYTHONPATH ?? "";
  const upstreamRoot = ctx.config.hermes.upstreamRoot;
  const askpassPath = path.join(shimDir, process.platform === "win32" ? "symphony-deny-askpass.cmd" : "symphony-deny-askpass");
  const realTools = discoverRealToolEnv(existingPath);
  const policyShell = policyShellShimPath(shimDir, realTools);

  return {
    ...env,
    ...realTools,
    SYMPHONY_COMMAND_POLICY_SHIM_DIR: shimDir,
    GIT_ASKPASS: askpassPath,
    SSH_ASKPASS: askpassPath,
    PATH: shimDir + (existingPath ? path.delimiter + existingPath : ""),
    PYTHONPATH: upstreamRoot + (existingPythonPath ? path.delimiter + existingPythonPath : ""),
    ...(policyShell ? { SHELL: policyShell } : {}),
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

export function serviceOwnedGitCommandEnv(sourceEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...sourceEnv };
  const shimDir = sourceEnv.SYMPHONY_COMMAND_POLICY_SHIM_DIR;
  const effectivePath = sourceEnv.PATH ?? sourceEnv.Path;
  for (const key of WORKER_REVIEWER_POLICY_ENV_KEYS) delete env[key];
  for (const key of Object.keys(env)) {
    if (key.startsWith(REAL_TOOL_ENV_PREFIX)) delete env[key];
  }
  if (effectivePath !== undefined) {
    const cleanedPath = shimDir ? pathWithoutEntry(effectivePath, shimDir) : effectivePath;
    if (cleanedPath) {
      env.PATH = cleanedPath;
      if (process.platform === "win32") env.Path = cleanedPath;
    } else {
      delete env.PATH;
      delete env.Path;
    }
  }
  return env;
}

function pathWithoutEntry(value: string, removedEntry: string): string {
  return value
    .split(path.delimiter)
    .filter((entry) => entry.length > 0 && !samePathEntry(entry, removedEntry))
    .join(path.delimiter);
}

function samePathEntry(left: string, right: string): boolean {
  try {
    const resolvedLeft = path.resolve(left);
    const resolvedRight = path.resolve(right);
    return process.platform === "win32"
      ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
      : resolvedLeft === resolvedRight;
  } catch {
    return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
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

function ensureWorkerReviewerGithubPolicyShims(ctx: AgentRunContext, pathValue: string): string {
  const shimDir = path.join(
    ctx.config.workspace.stateDir || os.tmpdir(),
    "command-policy",
    safePathSegment(ctx.issue.identifier || ctx.issue.id || "issue"),
    ctx.role,
    "bin",
  );
  mkdirSync(shimDir, { recursive: true });
  const pythonCommand = policyShimPythonCommand(ctx, pathValue);
  const python = shellWord(pythonCommand);
  const policyScript = path.join(ctx.config.hermes.upstreamRoot, "tools", "worker_github_policy.py");
  const policyScriptShell = shellWord(policyScript);
  const policyScriptCmd = cmdWord(policyScript);
  for (const tool of SHIM_TOOLS) {
    const posixPath = path.join(shimDir, tool);
    writeExecutable(
      posixPath,
      `#!/bin/sh\nexport SYMPHONY_COMMAND_POLICY_SHIM_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec ${python} ${policyScriptShell} ${shellWord(tool)} "$@"\n`,
    );
    const cmdPath = path.join(shimDir, `${tool}.cmd`);
    writeExecutable(
      cmdPath,
      `@echo off\r\nset "SYMPHONY_COMMAND_POLICY_SHIM_DIR=%~dp0"\r\n${cmdWord(pythonCommand)} ${policyScriptCmd} ${tool} %*\r\n`,
    );
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

function discoverRealToolEnv(pathValue: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const tool of SHIM_TOOLS) {
    const real = findOnPath(tool, pathValue);
    if (real) result[realToolEnvName(tool)] = real;
  }
  return result;
}

function policyShimPythonCommand(ctx: AgentRunContext, pathValue: string): string {
  const configured = ctx.config.hermes.python ?? "python";
  if (path.isAbsolute(configured) || configured.includes(path.sep) || configured.includes("/")) return configured;
  return findOnPath(configured, pathValue) ?? configured;
}

function policyShellShimPath(shimDir: string, realTools: Record<string, string>): string | undefined {
  for (const shell of POLICY_SHELL_TOOLS) {
    if (realTools[realToolEnvName(shell)]) {
      return path.join(shimDir, process.platform === "win32" ? `${shell}.cmd` : shell);
    }
  }
  return undefined;
}

function realToolEnvName(tool: string): string {
  return `SYMPHONY_REAL_${tool.toUpperCase().replace(/-/g, "_")}`;
}

function findOnPath(tool: string, pathValue: string): string | null {
  const extensions = process.platform === "win32" ? windowsPathExtensions(tool) : [""];
  for (const entry of pathValue.split(path.delimiter)) {
    const directory = entry.trim().replace(/^"|"$/g, "");
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, tool + extension);
      if (isUsableFile(candidate)) return candidate;
    }
  }
  return null;
}

function windowsPathExtensions(tool: string): string[] {
  if (path.extname(tool)) return [""];
  const pathext = process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD";
  return ["", ...pathext.split(";").map((extension) => extension.trim().toLowerCase()).filter(Boolean)];
}

function isUsableFile(candidate: string): boolean {
  try {
    return existsSync(candidate) && statSync(candidate).isFile();
  } catch {
    return false;
  }
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

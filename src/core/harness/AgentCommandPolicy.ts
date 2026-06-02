import type { RedactedPreview } from "../transcript/TranscriptProjection.js";
import { isSensitivePreviewKey, sanitizedPreviewValue } from "../transcript/TranscriptProjection.js";
import type { AgentRunPhase, AgentRunRole } from "../types.js";

const DEFAULT_POLICY_PREVIEW_LENGTH = 500;
const MAX_POLICY_PREVIEW_REDACTION_DEPTH = 8;
const WINDOWS_EXECUTABLE_SUFFIXES = [".exe", ".cmd", ".bat", ".com", ".ps1"] as const;

const GIT_EXECUTABLES = new Set(["git", "git-lfs"]);
const GITHUB_CLI_EXECUTABLES = new Set(["gh", "github"]);
const SSH_EXECUTABLES = new Set(["ssh", "scp", "sftp", "plink"]);
const NETWORK_CLIENT_EXECUTABLES = new Set(["curl", "wget", "http", "https", "httpie"]);
const SHELL_EXECUTABLES = new Set(["bash", "sh", "zsh", "fish", "dash", "cmd", "powershell", "pwsh"]);
const INTERPRETER_EXECUTABLES = new Set([
  "node",
  "python",
  "python2",
  "python3",
  "perl",
  "ruby",
  "php",
  "deno",
  "tsx",
  "ts-node",
]);
const PACKAGE_SCRIPT_EXECUTABLES = new Set(["npm", "npx", "pnpm", "yarn", "bun", "bunx"]);

const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SENSITIVE_ASSIGNMENT_PATTERN =
  /(\b([A-Za-z_][A-Za-z0-9_]*)\b\s*=\s*)("(?:[^"\\]|\\.)*(?:"|$)|'(?:[^'\\]|\\.)*(?:'|$)|[^\s"',}]+)/g;
const REDACTED_ASSIGNMENT_VALUE = "[redacted]";

export type AgentCommandPolicySurface =
  | "terminal"
  | "shell"
  | "execute_code"
  | "acp_permission"
  | "gateway_pre_tool_call"
  | "subagent_tool_call"
  | "command_reducer";

export type AgentCommandPolicyOutcome = "allow" | "deny";

export type AgentCommandPolicyReasonKind =
  | "safe_local_inspection"
  | "upstream_github"
  | "unsafe_git_config"
  | "unsafe_environment"
  | "unknown_command"
  | "service_owned_not_applicable";

export type AgentCommandPolicyExecutableKind =
  | "git"
  | "github_cli"
  | "ssh"
  | "network_client"
  | "shell"
  | "interpreter"
  | "package_script"
  | "unknown"
  | "other";

export type AgentCommandPolicyCommandClass =
  | "safe_local_inspection"
  | "direct_upstream_git"
  | "github_cli_operation"
  | "github_transport"
  | "github_api_call"
  | "wrapped_or_nested_command"
  | "git_local_inspection_with_helper"
  | "unsafe_environment"
  | "unknown_or_malformed"
  | "service_owned_not_applicable";

export type AgentCommandPolicyUnsafeGitConfigSource =
  | "inline_env"
  | "inherited_env"
  | "inline_git_config"
  | "persisted_repo_config"
  | "persisted_user_config"
  | "unknown";

export type AgentCommandPolicyUnsafeGitConfigCategory =
  | "alias"
  | "pager"
  | "external_diff"
  | "credential_helper"
  | "hook"
  | "filter"
  | "signing_program"
  | "filesystem_monitor"
  | "transport_helper"
  | "ssh_command"
  | "other";

export type AgentCommandPolicyUnsafeGitConfigEffect =
  | "executes_helper"
  | "uses_credentials"
  | "contacts_remote"
  | "ambiguous";

export type AgentCommandPolicyPathStyle = "windows" | "posix" | "unc" | "bare" | "unknown";

export type AgentCommandPolicyRawInput =
  | {
      readonly kind: "command";
      readonly command: string;
      readonly params?: unknown;
    }
  | {
      readonly kind: "code";
      readonly code: string;
      readonly language?: string | null;
      readonly params?: unknown;
    }
  | {
      readonly kind: "tool_call";
      readonly toolName?: string | null;
      readonly params: unknown;
      readonly command?: string | null;
      readonly code?: string | null;
    };

export interface AgentCommandPolicyEnvironmentInput {
  readonly keysOnly?: readonly string[];
  readonly inherited?: Readonly<Record<string, string | undefined>>;
}

export interface AgentCommandPolicyInput {
  readonly attemptId?: string | null;
  readonly runId?: string | null;
  readonly issueId?: string | null;
  readonly role: AgentRunRole;
  readonly phase: AgentRunPhase;
  readonly surface: AgentCommandPolicySurface;
  readonly workingDirectory: string;
  readonly rawInput: AgentCommandPolicyRawInput;
  readonly environment?: AgentCommandPolicyEnvironmentInput;
}

export interface AgentCommandPolicyNormalizedExecutable {
  readonly raw: string | null;
  readonly normalizedExecutable: string | null;
  readonly basename: string | null;
  readonly executableKind: AgentCommandPolicyExecutableKind;
  readonly hadPathEvidence: boolean;
  readonly pathStyle: AgentCommandPolicyPathStyle;
}

export interface AgentCommandPolicyNormalizedCommand {
  readonly executable: string | null;
  readonly executableKind: AgentCommandPolicyExecutableKind;
  readonly argumentsPreview: string | null;
  readonly gitSubcommand: string | null;
  readonly targetHosts: readonly string[];
  readonly hasNestedCommand: boolean;
  readonly hasInlineEnvironment: boolean;
  readonly hasUnsafeGitConfig: boolean;
}

export interface AgentCommandPolicyUnsafeGitConfigFinding {
  readonly source: AgentCommandPolicyUnsafeGitConfigSource;
  readonly key: string;
  readonly category: AgentCommandPolicyUnsafeGitConfigCategory;
  readonly effect: AgentCommandPolicyUnsafeGitConfigEffect;
}

export interface AgentCommandPolicyAuditPayload {
  readonly redacted: true;
  readonly surface: AgentCommandPolicySurface;
  readonly role: AgentRunRole;
  readonly phase: AgentRunPhase;
  readonly outcome: AgentCommandPolicyOutcome;
  readonly reasonKind: AgentCommandPolicyReasonKind;
  readonly rawInputPreview: string | null;
  readonly rawInputPreviewTruncated: boolean;
  readonly rawInputPreviewRedacted: boolean;
  readonly normalizedExecutable: string | null;
  readonly executableKind: AgentCommandPolicyExecutableKind;
  readonly gitSubcommand: string | null;
  readonly commandClass: AgentCommandPolicyCommandClass;
  readonly inheritedEnvironmentKeys: readonly string[];
  readonly inlineEnvironmentKeys: readonly string[];
  readonly unsafeConfigCategories: readonly AgentCommandPolicyUnsafeGitConfigCategory[];
  readonly upstreamContactAttempted: boolean;
}

export interface AgentCommandPolicyDecision {
  readonly decisionId?: string | null;
  readonly attemptId?: string | null;
  readonly outcome: AgentCommandPolicyOutcome;
  readonly reasonKind: AgentCommandPolicyReasonKind;
  readonly commandClass: AgentCommandPolicyCommandClass;
  readonly message: string;
  readonly requiresCodeChange: boolean;
  readonly requiresUserOrServiceFix: boolean;
  readonly normalizedCommand: AgentCommandPolicyNormalizedCommand;
  readonly audit: AgentCommandPolicyAuditPayload;
}

export function evaluateAgentCommandPolicy(input: AgentCommandPolicyInput): AgentCommandPolicyDecision {
  const rawInputPreview = redactedAgentCommandPolicyPreview(rawInputPreviewValue(input.rawInput));
  const executableCandidate = extractAgentCommandPolicyExecutableCandidate(input.rawInput);
  const normalizedExecutable = normalizeAgentCommandPolicyExecutable(executableCandidate);
  const inlineEnvironmentKeys = extractAgentCommandPolicyInlineEnvironmentKeys(input.rawInput);
  const inheritedEnvironmentKeys = extractAgentCommandPolicyEnvironmentKeys(input.environment);
  const normalizedCommand: AgentCommandPolicyNormalizedCommand = {
    executable: normalizedExecutable.normalizedExecutable,
    executableKind: normalizedExecutable.executableKind,
    argumentsPreview: null,
    gitSubcommand: null,
    targetHosts: [],
    hasNestedCommand: false,
    hasInlineEnvironment: inlineEnvironmentKeys.length > 0,
    hasUnsafeGitConfig: false,
  };

  return {
    attemptId: input.attemptId ?? null,
    outcome: "deny",
    reasonKind: "unknown_command",
    commandClass: "unknown_or_malformed",
    message:
      "Blocked worker/reviewer command: this command policy foundation cannot yet prove the command is local-only and helper-free. Use safe local inspection once classified, or rely on Symphony service-owned GitHub workflow actions for publication, review, and writeback.",
    requiresCodeChange: false,
    requiresUserOrServiceFix: true,
    normalizedCommand,
    audit: {
      redacted: true,
      surface: input.surface,
      role: input.role,
      phase: input.phase,
      outcome: "deny",
      reasonKind: "unknown_command",
      rawInputPreview: rawInputPreview.preview,
      rawInputPreviewTruncated: rawInputPreview.truncated,
      rawInputPreviewRedacted: rawInputPreview.redacted,
      normalizedExecutable: normalizedExecutable.normalizedExecutable,
      executableKind: normalizedExecutable.executableKind,
      gitSubcommand: null,
      commandClass: "unknown_or_malformed",
      inheritedEnvironmentKeys,
      inlineEnvironmentKeys,
      unsafeConfigCategories: [],
      upstreamContactAttempted: false,
    },
  };
}

export function redactedAgentCommandPolicyPreview(
  value: unknown,
  maxLength = DEFAULT_POLICY_PREVIEW_LENGTH,
): RedactedPreview {
  const shellRedactedValue = redactSensitiveShellAssignmentsInPreviewValue(value);
  const preview = sanitizedPreviewValue(shellRedactedValue.value, maxLength);
  return shellRedactedValue.redacted ? { ...preview, redacted: true } : preview;
}

export function extractAgentCommandPolicyEnvironmentKeys(input?: AgentCommandPolicyEnvironmentInput): string[] {
  if (!input) return [];
  return sortedUniqueKeys([...(input.keysOnly ?? []), ...Object.keys(input.inherited ?? {})]);
}

export function extractAgentCommandPolicyInlineEnvironmentKeys(rawInput: AgentCommandPolicyRawInput): string[] {
  const command = commandTextFromRawInput(rawInput);
  if (!command) return [];

  const keys: string[] = [];
  for (const word of splitShellWords(command)) {
    if (!ENV_ASSIGNMENT_PATTERN.test(word)) break;
    const key = word.slice(0, word.indexOf("=")).trim();
    if (key.length > 0) keys.push(key);
  }
  return sortedUniqueKeys(keys);
}

export function extractAgentCommandPolicyExecutableCandidate(rawInput: AgentCommandPolicyRawInput): string | null {
  const command = commandTextFromRawInput(rawInput);
  if (!command) return null;

  for (const word of splitShellWords(command)) {
    if (ENV_ASSIGNMENT_PATTERN.test(word)) continue;
    return word;
  }
  return null;
}

export function normalizeAgentCommandPolicyExecutable(value: unknown): AgentCommandPolicyNormalizedExecutable {
  if (typeof value !== "string") return unknownExecutable(null);

  const raw = value;
  const unquoted = stripMatchingOuterQuotes(value.trim());
  if (!unquoted) return unknownExecutable(raw);

  const pathStyle = detectPathStyle(unquoted);
  const hadPathEvidence = pathStyle !== "bare" && pathStyle !== "unknown";
  const basename = executableBasename(unquoted);
  if (!basename) {
    return {
      raw,
      normalizedExecutable: null,
      basename: null,
      executableKind: "unknown",
      hadPathEvidence,
      pathStyle,
    };
  }

  const normalizedExecutable = stripWindowsExecutableSuffix(basename).toLowerCase();
  return {
    raw,
    normalizedExecutable,
    basename,
    executableKind: classifyExecutableKind(normalizedExecutable),
    hadPathEvidence,
    pathStyle,
  };
}

function rawInputPreviewValue(rawInput: AgentCommandPolicyRawInput): unknown {
  switch (rawInput.kind) {
    case "command":
      return rawInput.command;
    case "code":
      return rawInput.code;
    case "tool_call":
      return {
        toolName: rawInput.toolName,
        command: rawInput.command,
        code: rawInput.code,
        params: rawInput.params,
      };
  }
}

function redactSensitiveShellAssignmentsInPreviewValue(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): { value: unknown; redacted: boolean } {
  if (typeof value === "string") {
    return redactSensitiveShellAssignmentsInText(value);
  }
  if (value === null || typeof value !== "object") {
    return { value, redacted: false };
  }
  if (depth >= MAX_POLICY_PREVIEW_REDACTION_DEPTH || seen.has(value)) {
    return { value, redacted: false };
  }

  seen.add(value);
  if (Array.isArray(value)) {
    let redacted = false;
    const items = value.map((item) => {
      const result = redactSensitiveShellAssignmentsInPreviewValue(item, depth + 1, seen);
      redacted ||= result.redacted;
      return result.value;
    });
    return redacted ? { value: items, redacted } : { value, redacted: false };
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return { value, redacted: false };

  let redacted = false;
  const output: Record<string, unknown> = {};
  for (const [key, item] of entries) {
    const result = redactSensitiveShellAssignmentsInPreviewValue(item, depth + 1, seen);
    redacted ||= result.redacted;
    output[key] = result.value;
  }
  return redacted ? { value: output, redacted } : { value, redacted: false };
}

function redactSensitiveShellAssignmentsInText(value: string): { value: string; redacted: boolean } {
  const text = value.replace(
    SENSITIVE_ASSIGNMENT_PATTERN,
    (match: string, prefix: string, key: string, assignmentValue: string) =>
      redactSensitiveAssignment(match, prefix, key, assignmentValue),
  );
  return { value: text, redacted: text !== value };
}

function redactSensitiveAssignment(match: string, prefix: string, key: string, assignmentValue: string): string {
  if (!isSensitivePreviewKey(key)) return match;
  const quote = assignmentValue[0] === '"' || assignmentValue[0] === "'" ? assignmentValue[0] : "";
  if (!quote) return `${prefix}${REDACTED_ASSIGNMENT_VALUE}`;
  return `${prefix}${quote}${REDACTED_ASSIGNMENT_VALUE}${assignmentValue.endsWith(quote) ? quote : ""}`;
}

function commandTextFromRawInput(rawInput: AgentCommandPolicyRawInput): string | null {
  switch (rawInput.kind) {
    case "command":
      return rawInput.command;
    case "tool_call":
      return typeof rawInput.command === "string" ? rawInput.command : null;
    case "code":
      return null;
  }
}

function splitShellWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (const char of command.trim()) {
    if ((char === '"' || char === "'") && quote === null) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (/\s/.test(char) && quote === null) {
      if (current.length > 0) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current.length > 0) words.push(current);
  return words;
}

function stripMatchingOuterQuotes(value: string): string {
  let normalized = value;
  while (normalized.length >= 2) {
    const first = normalized[0];
    const last = normalized[normalized.length - 1];
    if ((first !== '"' && first !== "'") || first !== last) break;
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized;
}

function executableBasename(value: string): string | null {
  const withoutTrailingSeparators = value.replace(/[\\/]+$/g, "");
  if (!withoutTrailingSeparators) return null;
  const segments = withoutTrailingSeparators.split(/[\\/]+/).filter((segment) => segment.length > 0);
  return segments.at(-1) ?? null;
}

function detectPathStyle(value: string): AgentCommandPolicyPathStyle {
  if (!value) return "unknown";
  if (/^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(value)) return "unc";
  if (/^[A-Za-z]:(?:[\\/]|$)/.test(value) || value.includes("\\")) return "windows";
  if (value.startsWith("/") || value.includes("/")) return "posix";
  return "bare";
}

function stripWindowsExecutableSuffix(value: string): string {
  const lower = value.toLowerCase();
  const suffix = WINDOWS_EXECUTABLE_SUFFIXES.find((candidate) => lower.endsWith(candidate));
  return suffix ? value.slice(0, -suffix.length) : value;
}

function classifyExecutableKind(value: string): AgentCommandPolicyExecutableKind {
  if (!value) return "unknown";
  if (GIT_EXECUTABLES.has(value)) return "git";
  if (GITHUB_CLI_EXECUTABLES.has(value)) return "github_cli";
  if (SSH_EXECUTABLES.has(value)) return "ssh";
  if (NETWORK_CLIENT_EXECUTABLES.has(value)) return "network_client";
  if (SHELL_EXECUTABLES.has(value)) return "shell";
  if (INTERPRETER_EXECUTABLES.has(value)) return "interpreter";
  if (PACKAGE_SCRIPT_EXECUTABLES.has(value)) return "package_script";
  return "other";
}

function sortedUniqueKeys(keys: Iterable<unknown>): string[] {
  const byNormalizedKey = new Map<string, string>();
  for (const key of keys) {
    if (typeof key !== "string") continue;
    const trimmed = key.trim();
    if (!trimmed) continue;
    const normalized = trimmed.toUpperCase();
    if (!byNormalizedKey.has(normalized)) byNormalizedKey.set(normalized, trimmed);
  }
  return [...byNormalizedKey.values()].sort((left, right) => {
    const normalizedCompare = left.toUpperCase().localeCompare(right.toUpperCase());
    return normalizedCompare === 0 ? left.localeCompare(right) : normalizedCompare;
  });
}

function unknownExecutable(raw: string | null): AgentCommandPolicyNormalizedExecutable {
  return {
    raw,
    normalizedExecutable: null,
    basename: null,
    executableKind: "unknown",
    hadPathEvidence: false,
    pathStyle: "unknown",
  };
}

import type { RedactedPreview } from "../transcript/TranscriptProjection.js";
import { isSensitivePreviewKey, sanitizedPreviewValue } from "../transcript/TranscriptProjection.js";

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

const RESTRICTED_ROLES = new Set(["worker", "reviewer", "merge-conflict-repair-worker", "merge_conflict_repair_worker"]);
const LOCAL_INSPECTION_GIT_SUBCOMMANDS = new Set(["status", "diff", "log", "show", "branch", "blame"]);
const UPSTREAM_GIT_SUBCOMMANDS = new Set(["push", "pull", "fetch", "clone", "ls-remote"]);
const SHELL_OR_WRAPPER_EXECUTABLES = new Set([
  "bash",
  "cmd",
  "node",
  "npm",
  "npx",
  "pnpm",
  "powershell",
  "pwsh",
  "python",
  "python3",
  "sh",
  "tsx",
  "yarn",
  "zsh",
]);
const COMMAND_TEXT_KEYS = ["command", "cmd", "code"] as const;
const CREDENTIAL_ASSIGNMENT_KEY_PATTERN =
  "[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|CREDENTIAL|API_KEY|ACCESS_KEY)[A-Z0-9_]*";
const CREDENTIAL_ASSIGNMENT_WHOLE_QUOTED_PATTERN = new RegExp(
  `(["'])\\b(${CREDENTIAL_ASSIGNMENT_KEY_PATTERN})=(?:\\\\.|(?!\\1).)*\\1`,
  "gi",
);
const CREDENTIAL_ASSIGNMENT_QUOTED_VALUE_PATTERN = new RegExp(
  `\\b(${CREDENTIAL_ASSIGNMENT_KEY_PATTERN})=(?!<redacted>)(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`,
  "gi",
);
const CREDENTIAL_ASSIGNMENT_UNQUOTED_VALUE_PATTERN = new RegExp(
  `\\b(${CREDENTIAL_ASSIGNMENT_KEY_PATTERN})=(?!<redacted>)[^\\s]+`,
  "gi",
);

export type AgentCommandPolicySurface = string;
export type AgentCommandPolicyCommandSurface = AgentCommandPolicySurface;

export type AgentCommandPolicyOutcome = "allow" | "deny";

export type AgentCommandPolicyReasonKind =
  | "safe_local_inspection"
  | "upstream_github"
  | "unsafe_git_config"
  | "unsafe_environment"
  | "unknown_command"
  | "service_owned_not_applicable"
  | "local_only_inspection"
  | "role_not_restricted"
  | "direct_upstream_github"
  | "github_cli"
  | "github_host_reference"
  | "ambiguous_command"
  | "malformed_command"
  | "malformed_hook_payload"
  | "oversized_hook_payload"
  | "missing_hook_context"
  | "classifier_error";

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

export type AgentCommandPolicyCommandClass = string;

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

export type AgentCommandPolicyStructuredRawInput =
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

export type AgentCommandPolicyRawInput = AgentCommandPolicyStructuredRawInput | Record<string, unknown>;

export interface AgentCommandPolicyEnvironmentInput {
  readonly keysOnly?: readonly string[];
  readonly inherited?: Readonly<Record<string, string | undefined>>;
}

export interface AgentCommandPolicyEnvironmentSnapshot {
  keysOnly: string[];
}

export interface AgentCommandPolicyInput {
  attemptId?: string | null | undefined;
  runId?: string | null | undefined;
  issueId?: string | null | undefined;
  role: string;
  phase: string;
  surface: AgentCommandPolicySurface;
  workingDirectory: string;
  rawInput: AgentCommandPolicyRawInput;
  environment?: AgentCommandPolicyEnvironmentInput | undefined;
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
  readonly role: string;
  readonly phase: string;
  readonly commandClass: AgentCommandPolicyCommandClass;
  readonly inlineEnvironmentKeys: readonly string[];
  readonly unsafeConfigCategories: readonly AgentCommandPolicyUnsafeGitConfigCategory[];
  readonly upstreamContactAttempted: boolean;
  readonly outcome?: AgentCommandPolicyOutcome | undefined;
  readonly reasonKind?: AgentCommandPolicyReasonKind | undefined;
  readonly rawInputPreview?: string | null | undefined;
  readonly rawInputPreviewTruncated?: boolean | undefined;
  readonly rawInputPreviewRedacted?: boolean | undefined;
  readonly normalizedExecutable?: string | null | undefined;
  readonly executableKind?: AgentCommandPolicyExecutableKind | undefined;
  readonly inheritedEnvironmentKeys?: readonly string[] | undefined;
  readonly commandPreview?: string | undefined;
  readonly gitSubcommand?: string | null | undefined;
}

export interface AgentCommandPolicyDecisionBase {
  readonly decisionId?: string | null | undefined;
  readonly attemptId?: string | null | undefined;
  readonly outcome: AgentCommandPolicyOutcome;
  readonly reasonKind: AgentCommandPolicyReasonKind;
  readonly commandClass: AgentCommandPolicyCommandClass;
  readonly message: string;
  readonly requiresCodeChange?: boolean | undefined;
  readonly requiresUserOrServiceFix?: boolean | undefined;
  readonly normalizedCommand?: AgentCommandPolicyNormalizedCommand | undefined;
  readonly audit: AgentCommandPolicyAuditPayload;
}

export interface AgentCommandPolicyAllowDecision extends AgentCommandPolicyDecisionBase {
  readonly outcome: "allow";
}

export interface AgentCommandPolicyDenyDecision extends AgentCommandPolicyDecisionBase {
  readonly outcome: "deny";
}

export type AgentCommandPolicyDecision = AgentCommandPolicyAllowDecision | AgentCommandPolicyDenyDecision;
export type AgentCommandPolicyClassifier = (input: AgentCommandPolicyInput) => AgentCommandPolicyDecision | Promise<AgentCommandPolicyDecision>;

export type AgentCommandPolicyCommandTextKey = (typeof COMMAND_TEXT_KEYS)[number];

export type AgentCommandPolicyCommandTextExtraction =
  | { status: "ok"; command: string }
  | { status: "missing" }
  | { status: "malformed"; key: AgentCommandPolicyCommandTextKey }
  | { status: "ambiguous"; keys: AgentCommandPolicyCommandTextKey[] }
  | { status: "mismatched"; key: AgentCommandPolicyCommandTextKey; expectedKey: AgentCommandPolicyCommandTextKey };

type AgentCommandPolicyCommandTextFailure = Exclude<AgentCommandPolicyCommandTextExtraction, { status: "ok" }>;

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

export function classifyAgentCommand(input: AgentCommandPolicyInput): AgentCommandPolicyDecision {
  const commandExtraction = extractAgentCommandPolicyCommandText(input.rawInput, input.surface);
  const baseAudit = auditBase(
    input,
    commandExtraction.status === "ok" ? commandExtraction.command : undefined,
  );

  if (!isRestrictedAgentRole(input.role)) {
    return allowDecision(input, {
      ...baseAudit,
      commandClass: "role_not_restricted",
      upstreamContactAttempted: false,
    }, "role_not_restricted", "role_not_restricted", "Agent command policy is not applied to this role.");
  }

  if (commandExtraction.status !== "ok") {
    const commandClass = commandInputFailureCommandClass(commandExtraction);
    return denyDecision(
      input,
      {
        ...baseAudit,
        commandClass,
        upstreamContactAttempted: false,
      },
      commandInputFailureReasonKind(commandExtraction),
      commandClass,
      commandInputFailureMessage(commandExtraction),
    );
  }

  const command = commandExtraction.command;
  if (command.trim().length === 0) {
    return denyDecision(
      input,
      {
        ...baseAudit,
        commandClass: "malformed_command",
        upstreamContactAttempted: false,
      },
      "malformed_command",
      "malformed_command",
      "Blocked worker/reviewer command: command-capable hook payload did not include a command string. Use Symphony service-owned GitHub workflow actions for upstream GitHub activity.",
    );
  }

  const tokens = tokenizeCommandPreview(command);
  const inlineEnvironmentKeys = extractInlineEnvironmentKeys(tokens);
  const executableToken = firstExecutableToken(tokens);
  const normalizedExecutable = executableToken === null ? undefined : normalizeExecutableName(executableToken);
  const commandPreview = redactedCommandPreview(command);
  const audit = {
    ...baseAudit,
    commandPreview,
    inlineEnvironmentKeys,
    ...(normalizedExecutable === undefined ? {} : { normalizedExecutable }),
  } satisfies AgentCommandPolicyAuditPayload;

  if (referencesGitHubHost(command)) {
    return denyDecision(
      input,
      {
        ...audit,
        commandClass: "github_host_reference",
        upstreamContactAttempted: false,
      },
      "github_host_reference",
      "github_host_reference",
      "Blocked worker/reviewer command: direct GitHub host or API access is disallowed. Use Symphony service-owned GitHub workflow actions for publication, review, writeback, mergeability, and CI checks.",
    );
  }

  if (normalizedExecutable === "gh") {
    return denyDecision(
      input,
      {
        ...audit,
        commandClass: "github_cli",
        upstreamContactAttempted: false,
      },
      "github_cli",
      "github_cli",
      "Blocked worker/reviewer GitHub CLI command: agent-owned GitHub activity is disallowed. Use Symphony service-owned GitHub workflow actions instead.",
    );
  }

  if (normalizedExecutable === "git") {
    return classifyGitCommand(input, audit, tokens, command);
  }

  if (normalizedExecutable !== undefined && SHELL_OR_WRAPPER_EXECUTABLES.has(normalizedExecutable)) {
    return denyDecision(
      input,
      {
        ...audit,
        commandClass: "ambiguous_wrapper_command",
        upstreamContactAttempted: false,
      },
      "ambiguous_command",
      "ambiguous_wrapper_command",
      "Blocked worker/reviewer command: wrapper, shell, package, or interpreter commands are not classified as helper-free local inspection by this policy scaffold. Use direct local inspection commands or Symphony service-owned GitHub workflow actions.",
    );
  }

  return denyDecision(
    input,
    {
      ...audit,
      commandClass: "ambiguous_command",
      upstreamContactAttempted: false,
    },
    "ambiguous_command",
    "ambiguous_command",
    "Blocked worker/reviewer command: command is not classified as helper-free local inspection by this policy scaffold. Use direct local inspection commands or Symphony service-owned GitHub workflow actions.",
  );
}

export function buildFailClosedAgentCommandPolicyDecision(input: {
  role?: string | undefined;
  phase?: string | undefined;
  surface?: string | undefined;
  workingDirectory?: string | undefined;
  reasonKind: Extract<
    AgentCommandPolicyReasonKind,
    "malformed_hook_payload" | "oversized_hook_payload" | "missing_hook_context" | "classifier_error"
  >;
  commandClass: string;
  message: string;
}): AgentCommandPolicyDenyDecision {
  const role = input.role ?? "unknown";
  const phase = input.phase ?? "unknown";
  const surface = input.surface ?? "unknown";
  return denyDecision(
    {
      role,
      phase,
      surface,
      workingDirectory: input.workingDirectory ?? process.cwd(),
      rawInput: {},
      environment: { keysOnly: [] },
    },
    {
      redacted: true,
      surface,
      role,
      phase,
      commandClass: input.commandClass,
      inlineEnvironmentKeys: [],
      unsafeConfigCategories: [],
      upstreamContactAttempted: false,
    },
    input.reasonKind,
    input.commandClass,
    input.message,
  );
}

export function environmentKeysOnly(environment: Record<string, string | undefined>): string[] {
  return Object.keys(environment).sort((left, right) => left.localeCompare(right));
}

export function redactedCommandPreview(command: string, maxLength = 240): string {
  const redacted = command
    .replace(/(https?:\/\/)([^\s/@]+)@github\.com/gi, "$1<redacted>@github.com")
    .replace(CREDENTIAL_ASSIGNMENT_WHOLE_QUOTED_PATTERN, (_match: string, quote: string, key: string) => {
      return `${quote}${key}=<redacted>${quote}`;
    })
    .replace(CREDENTIAL_ASSIGNMENT_QUOTED_VALUE_PATTERN, (_match: string, key: string) => {
      return `${key}=<redacted>`;
    })
    .replace(CREDENTIAL_ASSIGNMENT_UNQUOTED_VALUE_PATTERN, (_match: string, key: string) => {
      return `${key}=<redacted>`;
    })
    .replace(/\b(?:ghp|github_pat)_[A-Za-z0-9_.-]+/g, "<redacted-github-token>");
  return redacted.length <= maxLength ? redacted : `${redacted.slice(0, maxLength - 1)}…`;
}

export function normalizeExecutableName(executable: string): string {
  const withoutQuotes = stripMatchingQuotes(executable.trim());
  const normalizedSeparators = withoutQuotes.replace(/\\/g, "/");
  const basename = normalizedSeparators.split("/").filter((part) => part.length > 0).pop() ?? normalizedSeparators;
  return basename.replace(/\.(?:exe|cmd|bat|ps1)$/i, "").toLowerCase();
}

function classifyGitCommand(
  input: AgentCommandPolicyInput,
  audit: AgentCommandPolicyAuditPayload,
  tokens: string[],
  command: string,
): AgentCommandPolicyDecision {
  const gitSubcommand = extractGitSubcommand(tokens);
  const gitAudit = {
    ...audit,
    ...(gitSubcommand === null ? {} : { gitSubcommand }),
  } satisfies AgentCommandPolicyAuditPayload;

  if (gitSubcommand === null) {
    return denyDecision(
      input,
      {
        ...gitAudit,
        commandClass: "malformed_git_command",
        upstreamContactAttempted: false,
      },
      "malformed_command",
      "malformed_git_command",
      "Blocked worker/reviewer Git command: no Git subcommand was provided. Use helper-free local inspection commands only.",
    );
  }

  if (UPSTREAM_GIT_SUBCOMMANDS.has(gitSubcommand) || isRemoteMutationCommand(tokens, gitSubcommand)) {
    return denyDecision(
      input,
      {
        ...gitAudit,
        commandClass: "direct_upstream_git_operation",
        upstreamContactAttempted: false,
      },
      "direct_upstream_github",
      "direct_upstream_git_operation",
      "Blocked worker/reviewer Git command: upstream GitHub contact or remote mutation is disallowed. Use Symphony service-owned GitHub workflow actions for publication, review, writeback, mergeability, and CI checks.",
    );
  }

  if (LOCAL_INSPECTION_GIT_SUBCOMMANDS.has(gitSubcommand) && !containsInlineUnsafeLocalGitOption(command)) {
    return allowDecision(
      input,
      {
        ...gitAudit,
        commandClass: "local_git_inspection",
        upstreamContactAttempted: false,
      },
      "local_only_inspection",
      "local_git_inspection",
      "Allowed helper-free local Git inspection command.",
    );
  }

  return denyDecision(
    input,
    {
      ...gitAudit,
      commandClass: "ambiguous_git_command",
      upstreamContactAttempted: false,
    },
    "ambiguous_command",
    "ambiguous_git_command",
    "Blocked worker/reviewer Git command: command is not classified as helper-free local inspection by this policy scaffold. Use direct local inspection commands or Symphony service-owned GitHub workflow actions.",
  );
}

function allowDecision(
  input: AgentCommandPolicyInput,
  audit: AgentCommandPolicyAuditPayload,
  reasonKind: AgentCommandPolicyReasonKind,
  commandClass: string,
  message: string,
): AgentCommandPolicyAllowDecision {
  return {
    outcome: "allow",
    reasonKind,
    commandClass,
    message,
    audit: {
      ...audit,
      role: input.role,
      phase: input.phase,
      surface: input.surface,
      commandClass,
    },
  };
}

function denyDecision(
  input: AgentCommandPolicyInput,
  audit: AgentCommandPolicyAuditPayload,
  reasonKind: AgentCommandPolicyReasonKind,
  commandClass: string,
  message: string,
): AgentCommandPolicyDenyDecision {
  return {
    outcome: "deny",
    reasonKind,
    commandClass,
    message,
    audit: {
      ...audit,
      role: input.role,
      phase: input.phase,
      surface: input.surface,
      commandClass,
    },
  };
}

function auditBase(input: AgentCommandPolicyInput, command: string | undefined): AgentCommandPolicyAuditPayload {
  return {
    redacted: true,
    surface: input.surface,
    role: input.role,
    phase: input.phase,
    commandClass: "unclassified",
    inlineEnvironmentKeys: [],
    unsafeConfigCategories: [],
    upstreamContactAttempted: false,
    ...(command === undefined ? {} : { commandPreview: redactedCommandPreview(command) }),
  };
}

function isRestrictedAgentRole(role: string): boolean {
  return RESTRICTED_ROLES.has(role);
}

export function extractAgentCommandPolicyCommandText(
  rawInput: Record<string, unknown>,
  surface: string,
): AgentCommandPolicyCommandTextExtraction {
  const presentKeys = COMMAND_TEXT_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(rawInput, key));
  if (presentKeys.length === 0) return { status: "missing" };
  if (presentKeys.length > 1) return { status: "ambiguous", keys: [...presentKeys] };

  const key = presentKeys[0];
  if (key === undefined) return { status: "missing" };
  const value = rawInput[key];
  if (typeof value !== "string") return { status: "malformed", key };

  const expectedKey = expectedCommandTextKeyForSurface(surface);
  if (expectedKey !== null && key !== expectedKey) {
    return { status: "mismatched", key, expectedKey };
  }

  return { status: "ok", command: value };
}

function expectedCommandTextKeyForSurface(surface: string): AgentCommandPolicyCommandTextKey | null {
  const normalized = surface.trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (normalized === "execute_code" || normalized === "code_execution") return "code";
  if (normalized === "terminal" || normalized === "terminal_execute" || normalized === "execute" || normalized === "shell") {
    return "command";
  }
  return null;
}

function commandInputFailureReasonKind(
  failure: AgentCommandPolicyCommandTextFailure,
): Extract<AgentCommandPolicyReasonKind, "ambiguous_command" | "malformed_command"> {
  return failure.status === "ambiguous" ? "ambiguous_command" : "malformed_command";
}

function commandInputFailureCommandClass(failure: AgentCommandPolicyCommandTextFailure): string {
  switch (failure.status) {
    case "ambiguous":
      return "ambiguous_command_input";
    case "mismatched":
      return "mismatched_command_input";
    case "malformed":
      return "malformed_command_input";
    case "missing":
      return "malformed_command";
  }
}

function commandInputFailureMessage(failure: AgentCommandPolicyCommandTextFailure): string {
  switch (failure.status) {
    case "ambiguous":
      return `Blocked worker/reviewer command: command-capable hook payload included multiple command-bearing fields (${failure.keys.join(", ")}) and cannot be safely classified. Use Symphony service-owned GitHub workflow actions for upstream GitHub activity.`;
    case "mismatched":
      return `Blocked worker/reviewer command: command-capable hook payload used '${failure.key}' for a tool surface that requires '${failure.expectedKey}'. Use Symphony service-owned GitHub workflow actions for upstream GitHub activity.`;
    case "malformed":
      return `Blocked worker/reviewer command: command-capable hook payload field '${failure.key}' was not a command string. Use Symphony service-owned GitHub workflow actions for upstream GitHub activity.`;
    case "missing":
      return "Blocked worker/reviewer command: command-capable hook payload did not include a command string. Use Symphony service-owned GitHub workflow actions for upstream GitHub activity.";
  }
}

function tokenizeCommandPreview(command: string): string[] {
  const matches = command.match(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\S+/g) ?? [];
  return matches.map(stripMatchingQuotes);
}

function extractInlineEnvironmentKeys(tokens: string[]): string[] {
  const keys: string[] = [];
  for (const token of tokens) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(token);
    if (match?.[1] === undefined) break;
    keys.push(match[1]);
  }
  return keys.sort((left, right) => left.localeCompare(right));
}

function firstExecutableToken(tokens: string[]): string | null {
  for (const token of tokens) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    return token;
  }
  return null;
}

function extractGitSubcommand(tokens: string[]): string | null {
  let sawGit = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (!sawGit) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
      if (normalizeExecutableName(token) === "git") {
        sawGit = true;
      }
      continue;
    }
    if (token === "-C" || token === "--git-dir" || token === "--work-tree" || token === "-c") {
      index += 1;
      continue;
    }
    if (token.startsWith("--git-dir=") || token.startsWith("--work-tree=") || token.startsWith("-c")) continue;
    if (token.startsWith("-")) continue;
    return token.toLowerCase();
  }
  return null;
}

function isRemoteMutationCommand(tokens: string[], gitSubcommand: string): boolean {
  if (gitSubcommand !== "remote") return false;
  const remoteIndex = tokens.findIndex((token) => token.toLowerCase() === "remote");
  const remoteAction = remoteIndex < 0 ? null : tokens[remoteIndex + 1]?.toLowerCase();
  return remoteAction === null || remoteAction === undefined
    ? false
    : ["add", "remove", "rename", "set-head", "set-url", "update"].includes(remoteAction);
}

function referencesGitHubHost(command: string): boolean {
  return /(?:^|[^A-Za-z0-9_.-])(?:https?:\/\/)?(?:api\.)?github\.com(?:[:/\s]|$)/i.test(command);
}

function containsInlineUnsafeLocalGitOption(command: string): boolean {
  return /(?:^|\s)--(?:ext-diff|textconv)(?:\s|=|$)/i.test(command);
}

function stripMatchingQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
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
  if (!isStructuredAgentCommandPolicyRawInput(rawInput)) return rawInput;
  switch (rawInput.kind) {
    case "command":
      return rawInput.command;
    case "code":
      return rawInput.code;
    case "tool_call":
      return {
        toolName: rawInput.toolName,
        command: rawInput.command ?? null,
        code: rawInput.code ?? null,
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
  if (isStructuredAgentCommandPolicyRawInput(rawInput)) {
    switch (rawInput.kind) {
      case "command":
        return rawInput.command;
      case "code":
        return null;
      case "tool_call": {
        const record = commandTextRecordFromRawInput(rawInput);
        const extraction = extractAgentCommandPolicyCommandText(record, String(rawInput.toolName ?? ""));
        return extraction.status === "ok" ? extraction.command : null;
      }
    }
  }

  const extraction = extractAgentCommandPolicyCommandText(rawInput, "");
  return extraction.status === "ok" ? extraction.command : null;
}

function commandTextRecordFromRawInput(rawInput: AgentCommandPolicyRawInput): Record<string, unknown> {
  if (!isStructuredAgentCommandPolicyRawInput(rawInput)) return isRecord(rawInput) ? rawInput : {};

  switch (rawInput.kind) {
    case "command":
      return { command: rawInput.command };
    case "code":
      return { code: rawInput.code };
    case "tool_call": {
      const record: Record<string, unknown> = {};
      if (rawInput.command !== undefined && rawInput.command !== null) record.command = rawInput.command;
      if (rawInput.code !== undefined && rawInput.code !== null) record.code = rawInput.code;
      if (isRecord(rawInput.params)) {
        for (const key of COMMAND_TEXT_KEYS) {
          if (!Object.prototype.hasOwnProperty.call(record, key) && Object.prototype.hasOwnProperty.call(rawInput.params, key)) {
            record[key] = rawInput.params[key];
          }
        }
      }
      return record;
    }
  }
}

function isStructuredAgentCommandPolicyRawInput(value: unknown): value is AgentCommandPolicyStructuredRawInput {
  if (!isRecord(value)) return false;
  if (value.kind === "command") return typeof value.command === "string";
  if (value.kind === "code") return typeof value.code === "string";
  if (value.kind === "tool_call") return Object.prototype.hasOwnProperty.call(value, "params");
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

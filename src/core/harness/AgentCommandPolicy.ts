export type AgentCommandPolicyOutcome = "allow" | "deny";

export type AgentCommandPolicyReasonKind =
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

export type AgentCommandPolicyCommandSurface = string;

export interface AgentCommandPolicyEnvironmentSnapshot {
  keysOnly: string[];
}

export interface AgentCommandPolicyInput {
  role: string;
  phase: string;
  surface: AgentCommandPolicyCommandSurface;
  workingDirectory: string;
  rawInput: Record<string, unknown>;
  environment: AgentCommandPolicyEnvironmentSnapshot;
  runId?: string | undefined;
  issueId?: string | undefined;
}

export interface AgentCommandPolicyAuditPayload {
  redacted: true;
  surface: AgentCommandPolicyCommandSurface;
  role: string;
  phase: string;
  commandClass: string;
  inlineEnvironmentKeys: string[];
  unsafeConfigCategories: string[];
  upstreamContactAttempted: boolean;
  commandPreview?: string;
  normalizedExecutable?: string;
  gitSubcommand?: string;
}

export interface AgentCommandPolicyDecisionBase {
  outcome: AgentCommandPolicyOutcome;
  reasonKind: AgentCommandPolicyReasonKind;
  commandClass: string;
  message: string;
  audit: AgentCommandPolicyAuditPayload;
}

export interface AgentCommandPolicyAllowDecision extends AgentCommandPolicyDecisionBase {
  outcome: "allow";
}

export interface AgentCommandPolicyDenyDecision extends AgentCommandPolicyDecisionBase {
  outcome: "deny";
}

export type AgentCommandPolicyDecision = AgentCommandPolicyAllowDecision | AgentCommandPolicyDenyDecision;

export type AgentCommandPolicyClassifier = (input: AgentCommandPolicyInput) => AgentCommandPolicyDecision | Promise<AgentCommandPolicyDecision>;

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

export type AgentCommandPolicyCommandTextKey = (typeof COMMAND_TEXT_KEYS)[number];

export type AgentCommandPolicyCommandTextExtraction =
  | { status: "ok"; command: string }
  | { status: "missing" }
  | { status: "malformed"; key: AgentCommandPolicyCommandTextKey }
  | { status: "ambiguous"; keys: AgentCommandPolicyCommandTextKey[] }
  | { status: "mismatched"; key: AgentCommandPolicyCommandTextKey; expectedKey: AgentCommandPolicyCommandTextKey };

type AgentCommandPolicyCommandTextFailure = Exclude<AgentCommandPolicyCommandTextExtraction, { status: "ok" }>;

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

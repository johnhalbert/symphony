import type { RedactedPreview } from "../transcript/TranscriptProjection.js";
import { isSensitivePreviewKey, sanitizedPreviewValue } from "../transcript/TranscriptProjection.js";

const DEFAULT_POLICY_PREVIEW_LENGTH = 500;
const MAX_POLICY_PREVIEW_REDACTION_DEPTH = 8;
const WINDOWS_EXECUTABLE_SUFFIXES = [".exe", ".cmd", ".bat", ".com", ".ps1"] as const;

const GIT_EXECUTABLES = new Set(["git", "git-lfs"]);
const GITHUB_CLI_EXECUTABLES = new Set(["gh", "github", "hub"]);
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
const UPSTREAM_GIT_SUBCOMMANDS = new Set([
  "clone",
  "fetch",
  "ls-remote",
  "pull",
  "push",
  "receive-pack",
  "remote-ext",
  "remote-fd",
  "send-pack",
  "upload-archive",
  "upload-pack",
]);
const GIT_REMOTE_UPSTREAM_SUBCOMMANDS = new Set(["prune", "update"]);
const GIT_UPSTREAM_CHECKOUT_SUBCOMMANDS = new Set(["checkout", "switch"]);
const SHELL_OR_WRAPPER_EXECUTABLES = new Set([
  ...SHELL_EXECUTABLES,
  ...INTERPRETER_EXECUTABLES,
  ...PACKAGE_SCRIPT_EXECUTABLES,
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
const COMMAND_PREVIEW_MAX_LENGTH = 240;
const REDACTED_VALUE = "[redacted]";
const REDACTED_GITHUB_TOKEN = "[redacted-github-token]";
const CLI_AUTH_OPTIONS_WITH_VALUE = new Set([
  "-a",
  "-b",
  "-U",
  "-u",
  "--api-key",
  "--apikey",
  "--auth",
  "--auth-token",
  "--bearer",
  "--cookie",
  "--ftp-password",
  "--ftp-user",
  "--http-password",
  "--http-user",
  "--oauth2-bearer",
  "--password",
  "--private-token",
  "--proxy-user",
  "--token",
  "--user",
  "--user-password",
]);
const CLI_AUTH_SHORT_OPTIONS_WITH_ATTACHED_VALUE = new Set(["-a", "-b", "-U", "-u"]);
const SENSITIVE_QUERY_PARAMETER_PATTERN =
  /([?&;](?:access[_-]?token|api[_-]?key|auth(?:entication)?[_-]?token|client[_-]?secret|credential|github[_-]?token|gh[_-]?token|id[_-]?token|jwt|oauth[_-]?token|password|passwd|private[_-]?token|refresh[_-]?token|secret|session|token|user[_-]?session)=)([^\s'"&;|]+)/giu;

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
  readonly targetHosts?: readonly string[] | undefined;
  readonly inheritedEnvironmentKeys?: readonly string[] | undefined;
  readonly commandPreview?: string | undefined;
  readonly gitSubcommand?: string | null | undefined;
  readonly hasNestedCommand?: boolean | undefined;
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
  return classifyAgentCommand(input);
}

export function classifyAgentCommand(input: AgentCommandPolicyInput): AgentCommandPolicyDecision {
  const commandExtraction = extractAgentCommandPolicyCommandText(input.rawInput, input.surface);
  const baseAudit = auditBase(
    input,
    commandExtraction.status === "ok" ? commandExtraction.command : undefined,
  );

  if (commandExtraction.status !== "ok") {
    if (!isRestrictedAgentRole(input.role)) {
      return allowDecision(input, {
        ...baseAudit,
        commandClass: "role_not_restricted",
        upstreamContactAttempted: false,
      }, "role_not_restricted", "role_not_restricted", "Agent command policy is not applied to this role.");
    }

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
  const parsed = parseCommandAttempt(command);
  const audit = auditForParsedCommand(baseAudit, parsed);

  if (!isRestrictedAgentRole(input.role)) {
    return allowDecision(input, {
      ...audit,
      commandClass: "role_not_restricted",
      upstreamContactAttempted: false,
    }, "role_not_restricted", "role_not_restricted", "Agent command policy is not applied to this role.");
  }

  if (command.trim().length === 0) {
    return denyDecision(
      input,
      {
        ...audit,
        commandClass: "unknown_command",
        upstreamContactAttempted: false,
      },
      "unknown_command",
      "unknown_command",
      "Blocked worker/reviewer command: command-capable hook payload did not include a command string. Use Symphony service-owned GitHub workflow actions for upstream GitHub activity.",
    );
  }

  if (parsed.normalizedExecutable === undefined) {
    return denyDecision(
      input,
      {
        ...audit,
        commandClass: "unknown_command",
        upstreamContactAttempted: false,
      },
      "unknown_command",
      "unknown_command",
      "Blocked worker/reviewer command: command content could not be classified before execution. Use local inspection that can be proven safe, or rely on Symphony service-owned GitHub workflow actions.",
    );
  }

  const upstreamClassification = classifyUpstreamGithubAttempt(parsed);
  if (upstreamClassification !== null) {
    return denyDecision(
      input,
      auditForUpstreamClassification(audit, upstreamClassification),
      "upstream_github",
      upstreamClassification.commandClass,
      "Blocked worker/reviewer upstream GitHub contact: direct GitHub activity is disallowed for worker/reviewer agents. Use Symphony service-owned workflow actions for publication, review, writeback, mergeability, and CI checks.",
    );
  }

  if (parsed.hasNestedCommand || isScriptWrapperAttempt(parsed)) {
    const commandClass = ambiguousNestedCommandClass(parsed);
    return denyDecision(
      input,
      {
        ...audit,
        commandClass,
        upstreamContactAttempted: false,
      },
      "ambiguous_command",
      commandClass,
      "Blocked worker/reviewer command: shell, wrapper, package, interpreter, script, or compound commands are not classified as helper-free local inspection. Use direct local inspection commands or Symphony service-owned GitHub workflow actions.",
    );
  }

  if (parsed.normalizedExecutable === "git") {
    return classifyGitCommand(input, audit, parsed.tokens, command);
  }

  if (SHELL_OR_WRAPPER_EXECUTABLES.has(parsed.normalizedExecutable)) {
    const commandClass = ambiguousNestedCommandClass(parsed);
    return denyDecision(
      input,
      {
        ...audit,
        commandClass,
        upstreamContactAttempted: false,
      },
      "ambiguous_command",
      commandClass,
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

interface ParsedCommandAttempt {
  readonly command: string;
  readonly tokens: string[];
  readonly executableToken?: string;
  readonly executableBasename?: string;
  readonly executablePathStyle?: AgentCommandPolicyPathStyle;
  readonly normalizedExecutable?: string;
  readonly executableKind?: AgentCommandPolicyExecutableKind;
  readonly gitSubcommand?: string;
  readonly targetHosts: readonly string[];
  readonly inlineEnvironmentKeys: readonly string[];
  readonly commandPreview: string;
  readonly hasNestedCommand: boolean;
}

function parseCommandAttempt(command: string): ParsedCommandAttempt {
  const tokens = tokenizeCommandPreview(command);
  return parseCommandAttemptFromTokens(tokens, command);
}

function parseCommandAttemptFromTokens(tokens: string[], command = tokens.join(" ")): ParsedCommandAttempt {
  const inlineEnvironmentKeys = extractInlineEnvironmentKeys(tokens);
  const executableToken = firstExecutableToken(tokens);
  const normalizedExecutableDetails =
    executableToken === null ? null : normalizeAgentCommandPolicyExecutable(executableToken);
  const normalizedExecutable = normalizedExecutableDetails?.normalizedExecutable ?? undefined;
  const gitSubcommand = normalizedExecutable === "git" ? extractGitSubcommand(tokens) : null;
  const executableKind = normalizedExecutableDetails?.executableKind;
  const executableBasename = normalizedExecutableDetails?.basename ?? undefined;
  const executablePathStyle = normalizedExecutableDetails?.pathStyle;

  const parsed = {
    command,
    tokens,
    ...(executableToken === null ? {} : { executableToken }),
    ...(executableBasename === undefined ? {} : { executableBasename }),
    ...(executablePathStyle === undefined ? {} : { executablePathStyle }),
    ...(normalizedExecutable === undefined ? {} : { normalizedExecutable }),
    ...(executableKind === undefined ? {} : { executableKind }),
    ...(gitSubcommand === null ? {} : { gitSubcommand }),
    targetHosts: extractGithubHosts(tokens),
    inlineEnvironmentKeys,
    commandPreview: redactedCommandPreview(command),
    hasNestedCommand: false,
  } satisfies ParsedCommandAttempt;

  return {
    ...parsed,
    hasNestedCommand: hasNestedCommandEvidence(parsed),
  };
}

function auditForParsedCommand(
  baseAudit: AgentCommandPolicyAuditPayload,
  parsed: ParsedCommandAttempt,
): AgentCommandPolicyAuditPayload {
  return {
    ...baseAudit,
    commandPreview: parsed.commandPreview,
    inlineEnvironmentKeys: parsed.inlineEnvironmentKeys,
    ...(parsed.normalizedExecutable === undefined ? {} : { normalizedExecutable: parsed.normalizedExecutable }),
    ...(parsed.executableKind === undefined ? {} : { executableKind: parsed.executableKind }),
    ...(parsed.gitSubcommand === undefined ? {} : { gitSubcommand: parsed.gitSubcommand }),
    ...(parsed.targetHosts.length === 0 ? {} : { targetHosts: parsed.targetHosts }),
    ...(parsed.hasNestedCommand ? { hasNestedCommand: true } : {}),
  };
}

interface UpstreamGithubClassification {
  readonly commandClass: string;
  readonly gitSubcommand?: string | null;
  readonly targetHosts?: readonly string[];
}

type ShellExecutionExpansionKind = "shell_substitution" | "process_substitution";

function classifyUpstreamGithubAttempt(parsed: ParsedCommandAttempt): UpstreamGithubClassification | null {
  return (
    classifyDirectUpstreamGithubAttempt(parsed, { includeGenericHostReference: false }) ??
    classifyDisguisedUpstreamGithubAttempt(parsed) ??
    classifyDirectUpstreamGithubAttempt(parsed, { includeGenericHostReference: true })
  );
}

function auditForUpstreamClassification(
  audit: AgentCommandPolicyAuditPayload,
  classification: UpstreamGithubClassification,
): AgentCommandPolicyAuditPayload {
  return {
    ...audit,
    commandClass: classification.commandClass,
    upstreamContactAttempted: false,
    ...(classification.gitSubcommand === undefined ? {} : { gitSubcommand: classification.gitSubcommand }),
    ...(classification.targetHosts === undefined || classification.targetHosts.length === 0
      ? {}
      : { targetHosts: sortedUniqueKeys([...(audit.targetHosts ?? []), ...classification.targetHosts]) }),
  };
}

function classifyDirectUpstreamGithubAttempt(
  parsed: ParsedCommandAttempt,
  options: { readonly includeGenericHostReference: boolean },
): UpstreamGithubClassification | null {
  const executable = parsed.normalizedExecutable;
  if (executable === undefined) {
    return null;
  }

  if (executable === "git") {
    if (parsed.gitSubcommand && UPSTREAM_GIT_SUBCOMMANDS.has(parsed.gitSubcommand)) {
      return {
        commandClass: `git_${parsed.gitSubcommand.replace(/-/g, "_")}`,
        gitSubcommand: parsed.gitSubcommand,
        targetHosts: parsed.targetHosts,
      };
    }

    const remoteAction = parsed.gitSubcommand === "remote" ? gitRemoteSubcommand(parsed.tokens) : null;
    if (remoteAction && GIT_REMOTE_UPSTREAM_SUBCOMMANDS.has(remoteAction)) {
      return {
        commandClass: `git_remote_${remoteAction}`,
        gitSubcommand: parsed.gitSubcommand ?? null,
        targetHosts: parsed.targetHosts,
      };
    }

    if (
      parsed.gitSubcommand &&
      GIT_UPSTREAM_CHECKOUT_SUBCOMMANDS.has(parsed.gitSubcommand) &&
      hasUpstreamCheckoutReference(parsed.tokens)
    ) {
      return {
        commandClass: "git_upstream_checkout",
        gitSubcommand: parsed.gitSubcommand,
        targetHosts: parsed.targetHosts,
      };
    }

    if (parsed.targetHosts.length > 0 && !parsed.hasNestedCommand) {
      return {
        commandClass: "git_github_transport",
        gitSubcommand: parsed.gitSubcommand ?? null,
        targetHosts: parsed.targetHosts,
      };
    }
  }

  if (GITHUB_CLI_EXECUTABLES.has(executable)) {
    return { commandClass: "github_cli", targetHosts: parsed.targetHosts };
  }

  if (SSH_EXECUTABLES.has(executable) && parsed.targetHosts.length > 0) {
    return { commandClass: `${executable}_github_transport`, targetHosts: parsed.targetHosts };
  }

  if (NETWORK_CLIENT_EXECUTABLES.has(executable) && parsed.targetHosts.length > 0) {
    return { commandClass: `${executable}_github_request`, targetHosts: parsed.targetHosts };
  }

  if (options.includeGenericHostReference && parsed.targetHosts.length > 0) {
    return { commandClass: "github_host_reference", targetHosts: parsed.targetHosts };
  }

  return null;
}

function classifyDisguisedUpstreamGithubAttempt(
  parsed: ParsedCommandAttempt,
  depth = 0,
): UpstreamGithubClassification | null {
  if (depth > 3) {
    return classifyVisibleCodeUpstreamGithubAttempt(parsed.command);
  }

  const compoundClassification = classifyCompoundCommandSegments(parsed, depth);
  if (compoundClassification !== null) return compoundClassification;

  const shellExpansionClassification = classifyShellExecutionExpansionUpstreamGithubAttempt(parsed);
  if (shellExpansionClassification !== null) return shellExpansionClassification;

  const visibleNestedClassification = classifyVisibleNestedCommandTokens(parsed, depth);
  if (visibleNestedClassification !== null) {
    return prefixNestedClassification(parsed, visibleNestedClassification);
  }

  for (const nestedCommandText of nestedCommandTextsForWrapper(parsed)) {
    const classification = classifyCommandTextForUpstream(nestedCommandText, depth + 1);
    if (classification !== null) return prefixNestedClassification(parsed, classification);
  }

  if (parsed.hasNestedCommand || isScriptWrapperAttempt(parsed)) {
    const codeClassification = classifyVisibleCodeUpstreamGithubAttempt(parsed.command);
    if (codeClassification !== null) return prefixNestedClassification(parsed, codeClassification);
  }

  return null;
}

function classifyCompoundCommandSegments(
  parsed: ParsedCommandAttempt,
  depth: number,
): UpstreamGithubClassification | null {
  const segments = splitCommandSegments(parsed.tokens);
  if (segments.length <= 1) return null;

  for (const segment of segments) {
    const classification = classifyCommandTokensForUpstream(segment, depth + 1);
    if (classification !== null) return prefixCommandClass("compound", classification);
  }

  return null;
}

function classifyShellExecutionExpansionUpstreamGithubAttempt(
  parsed: ParsedCommandAttempt,
): UpstreamGithubClassification | null {
  const expansionKind = shellExecutionExpansionKind(parsed.command);
  if (expansionKind === null) return null;

  const classification = classifyVisibleCodeUpstreamGithubAttempt(parsed.command);
  return classification === null ? null : prefixCommandClass(expansionKind, classification);
}

function classifyVisibleNestedCommandTokens(
  parsed: ParsedCommandAttempt,
  depth: number,
): UpstreamGithubClassification | null {
  for (let index = 1; index < parsed.tokens.length; index += 1) {
    const token = parsed.tokens[index];
    if (token === undefined || isShellControlOperator(token)) continue;

    const normalized = normalizeAgentCommandPolicyExecutable(token).normalizedExecutable;
    if (normalized && isDirectlyClassifiableUpstreamExecutable(normalized)) {
      const segmentTokens = tokensUntilControlOperator(parsed.tokens, index);
      const classification = classifyCommandTokensForUpstream(segmentTokens, depth + 1);
      if (classification !== null) return classification;
    }

    if (isPotentialNestedCommandText(token)) {
      const classification = classifyCommandTextForUpstream(token, depth + 1);
      if (classification !== null) return classification;
    }

    const githubHost = githubHostFromToken(token);
    if (githubHost !== null) {
      return { commandClass: "github_host_reference", targetHosts: [githubHost] };
    }
  }

  return null;
}

function classifyCommandTokensForUpstream(
  tokens: readonly string[],
  depth: number,
): UpstreamGithubClassification | null {
  if (tokens.length === 0) return null;
  const parsed = parseCommandAttemptFromTokens([...tokens]);
  return (
    classifyDirectUpstreamGithubAttempt(parsed, { includeGenericHostReference: false }) ??
    (depth > 3 ? null : classifyDisguisedUpstreamGithubAttempt(parsed, depth + 1)) ??
    classifyDirectUpstreamGithubAttempt(parsed, { includeGenericHostReference: true }) ??
    classifyVisibleCodeUpstreamGithubAttempt(parsed.command)
  );
}

function classifyCommandTextForUpstream(command: string, depth: number): UpstreamGithubClassification | null {
  const parsed = parseCommandAttempt(command);
  return (
    classifyDirectUpstreamGithubAttempt(parsed, { includeGenericHostReference: false }) ??
    (depth > 3 ? null : classifyDisguisedUpstreamGithubAttempt(parsed, depth + 1)) ??
    classifyDirectUpstreamGithubAttempt(parsed, { includeGenericHostReference: true }) ??
    classifyVisibleCodeUpstreamGithubAttempt(command)
  );
}

function classifyVisibleCodeUpstreamGithubAttempt(text: string): UpstreamGithubClassification | null {
  const tokens = tokenizeCommandPreview(text);
  const targetHosts = extractGithubHosts(tokens);

  for (const subcommand of UPSTREAM_GIT_SUBCOMMANDS) {
    if (containsExecutableAndWord(text, "git", subcommand)) {
      return {
        commandClass: `git_${subcommand.replace(/-/g, "_")}`,
        gitSubcommand: subcommand,
        targetHosts,
      };
    }
  }

  const remoteAction = gitRemoteActionInText(text);
  if (remoteAction !== null) {
    return { commandClass: `git_remote_${remoteAction}`, gitSubcommand: "remote", targetHosts };
  }

  for (const executable of GITHUB_CLI_EXECUTABLES) {
    if (containsExecutableWord(text, executable)) return { commandClass: "github_cli", targetHosts };
  }

  for (const executable of SSH_EXECUTABLES) {
    if (targetHosts.length > 0 && containsExecutableWord(text, executable)) {
      return { commandClass: `${executable}_github_transport`, targetHosts };
    }
  }

  for (const executable of NETWORK_CLIENT_EXECUTABLES) {
    if (targetHosts.length > 0 && containsExecutableWord(text, executable)) {
      return { commandClass: `${executable}_github_request`, targetHosts };
    }
  }

  return targetHosts.length > 0 ? { commandClass: "github_host_reference", targetHosts } : null;
}

function nestedCommandTextsForWrapper(parsed: ParsedCommandAttempt): string[] {
  switch (parsed.executableKind) {
    case "shell":
      return shellNestedCommandTexts(parsed.normalizedExecutable, parsed.tokens);
    case "interpreter":
      return interpreterNestedCommandTexts(parsed.tokens);
    case "package_script":
      return packageNestedCommandTexts(parsed.normalizedExecutable, parsed.tokens);
    default:
      return [];
  }
}

function shellNestedCommandTexts(executable: string | undefined, tokens: readonly string[]): string[] {
  const commandTexts: string[] = [];

  if (executable === "cmd") {
    for (let index = 1; index < tokens.length; index += 1) {
      const token = tokens[index]?.toLowerCase();
      if (token === "/c" || token === "/k" || token === "-c") {
        const nested = tokens.slice(index + 1).join(" ").trim();
        if (nested.length > 0) commandTexts.push(nested);
      }
    }
    return commandTexts;
  }

  if (executable === "powershell" || executable === "pwsh") {
    for (let index = 1; index < tokens.length; index += 1) {
      const token = tokens[index]?.toLowerCase();
      if (token === "-command" || token === "-c" || token === "/c") {
        const nested = tokens.slice(index + 1).join(" ").trim();
        if (nested.length > 0) commandTexts.push(nested);
      }
    }
    return commandTexts;
  }

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token !== undefined && token.startsWith("-") && token.toLowerCase().includes("c")) {
      const nested = tokens.slice(index + 1).join(" ").trim();
      if (nested.length > 0) commandTexts.push(nested);
    }
  }

  return commandTexts;
}

function interpreterNestedCommandTexts(tokens: readonly string[]): string[] {
  const commandTexts: string[] = [];
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]?.toLowerCase();
    if (token === "-c" || token === "-e" || token === "--eval") {
      const nested = tokens.slice(index + 1).join(" ").trim();
      if (nested.length > 0) commandTexts.push(nested);
    }
  }
  return commandTexts;
}

function packageNestedCommandTexts(executable: string | undefined, tokens: readonly string[]): string[] {
  if (executable === "npx" || executable === "bunx") return packageCommandAfterOptions(tokens, 1);

  if (executable === "npm" || executable === "pnpm" || executable === "yarn" || executable === "bun") {
    const actionIndex = firstPackageActionIndex(tokens);
    if (actionIndex < 0) return [];
    const action = tokens[actionIndex]?.toLowerCase();
    if (action === "exec" || action === "x" || action === "dlx") {
      return packageCommandAfterOptions(tokens, actionIndex + 1);
    }
  }

  return [];
}

function packageCommandAfterOptions(tokens: readonly string[], startIndex: number): string[] {
  for (let index = startIndex; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (token === "--") {
      const nested = tokens.slice(index + 1).join(" ").trim();
      return nested.length > 0 ? [nested] : [];
    }
    if (token.startsWith("-")) continue;
    const nested = tokens.slice(index).join(" ").trim();
    return nested.length > 0 ? [nested] : [];
  }
  return [];
}

function firstPackageActionIndex(tokens: readonly string[]): number {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (token === "--") return -1;
    if (token.startsWith("-")) continue;
    return index;
  }
  return -1;
}

function splitCommandSegments(tokens: readonly string[]): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];
  for (const token of tokens) {
    if (isShellControlOperator(token)) {
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
      continue;
    }
    current.push(token);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

function tokensUntilControlOperator(tokens: readonly string[], startIndex: number): string[] {
  const segment: string[] = [];
  for (let index = startIndex; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || isShellControlOperator(token)) break;
    segment.push(token);
  }
  return segment;
}

function prefixNestedClassification(
  parsed: ParsedCommandAttempt,
  classification: UpstreamGithubClassification,
): UpstreamGithubClassification {
  const prefix = nestedCommandClassPrefix(parsed);
  return prefix === "nested" ? classification : prefixCommandClass(prefix, classification);
}

function prefixCommandClass(
  prefix: string,
  classification: UpstreamGithubClassification,
): UpstreamGithubClassification {
  return { ...classification, commandClass: `${prefix}_${classification.commandClass}` };
}

function nestedCommandClassPrefix(parsed: ParsedCommandAttempt): string {
  switch (parsed.executableKind) {
    case "shell":
      return "shell_wrapped";
    case "interpreter":
      return "interpreter_wrapped";
    case "package_script":
      return "package_script_wrapped";
    default:
      return isScriptWrapperAttempt(parsed) ? "script_wrapped" : "nested";
  }
}

function ambiguousNestedCommandClass(parsed: ParsedCommandAttempt): string {
  const expansionKind = shellExecutionExpansionKind(parsed.command);
  if (expansionKind !== null) return `ambiguous_${expansionKind}_command`;

  if (commandHasShellControl(parsed.tokens)) return "ambiguous_compound_command";
  switch (parsed.executableKind) {
    case "shell":
      return "ambiguous_shell_wrapper_command";
    case "interpreter":
      return "ambiguous_interpreter_command";
    case "package_script":
      return "ambiguous_package_script";
    default:
      return isScriptWrapperAttempt(parsed) ? "ambiguous_script_wrapper" : "ambiguous_wrapper_command";
  }
}

function hasNestedCommandEvidence(parsed: ParsedCommandAttempt): boolean {
  return (
    shellExecutionExpansionKind(parsed.command) !== null ||
    commandHasShellControl(parsed.tokens) ||
    (parsed.normalizedExecutable !== undefined && SHELL_OR_WRAPPER_EXECUTABLES.has(parsed.normalizedExecutable)) ||
    isScriptWrapperAttempt(parsed)
  );
}

function shellExecutionExpansionKind(command: string): ShellExecutionExpansionKind | null {
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === undefined) continue;

    if (char === "\\" && quote !== "'") {
      index += 1;
      continue;
    }

    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }

    if (char === "'" && quote === null) {
      quote = "'";
      continue;
    }

    if (char === '"') {
      quote = quote === '"' ? null : '"';
      continue;
    }

    if (char === "`") return "shell_substitution";

    const next = command[index + 1];
    if (char === "$" && next === "(" && command[index + 2] !== "(") return "shell_substitution";
    if ((char === "<" || char === ">") && next === "(") return "process_substitution";
  }

  return null;
}

function commandHasShellControl(tokens: readonly string[]): boolean {
  return tokens.some((token) => isShellControlOperator(token));
}

function isScriptWrapperAttempt(parsed: ParsedCommandAttempt): boolean {
  const basename = parsed.executableBasename ?? parsed.executableToken ?? "";
  if (/\.(?:bash|bat|cmd|fish|ps1|sh|zsh)$/iu.test(basename)) return true;
  return parsed.executableKind === "other" && parsed.executablePathStyle !== undefined && parsed.executablePathStyle !== "bare";
}

function isDirectlyClassifiableUpstreamExecutable(executable: string): boolean {
  return (
    GIT_EXECUTABLES.has(executable) ||
    GITHUB_CLI_EXECUTABLES.has(executable) ||
    SSH_EXECUTABLES.has(executable) ||
    NETWORK_CLIENT_EXECUTABLES.has(executable)
  );
}

function isPotentialNestedCommandText(token: string): boolean {
  return /\s|[;&|]|\b(?:child_process|subprocess|system|exec(?:Sync)?|spawn|popen|urlopen|fetch)\b/iu.test(token);
}

function gitRemoteActionInText(text: string): string | null {
  const remoteActionPattern = /\bgit(?:\.exe)?\b[\s\S]{0,120}\bremote\b[\s\S]{0,80}\b(prune|update)\b/iu;
  const match = remoteActionPattern.exec(text);
  return match?.[1]?.toLowerCase() ?? null;
}

function containsExecutableAndWord(text: string, executable: string, word: string): boolean {
  return new RegExp(`${executableWordPattern(executable)}[\\s\\S]{0,120}${wordPattern(word)}`, "iu").test(text);
}

function containsExecutableWord(text: string, executable: string): boolean {
  return new RegExp(executableWordPattern(executable), "iu").test(text);
}

function executableWordPattern(executable: string): string {
  const escapedExecutable = escapeRegExp(executable);
  const suffix = executable === "git" ? "(?:\\.exe)?" : "";
  return `(?:^|[^A-Za-z0-9_.-])${escapedExecutable}${suffix}(?:$|[^A-Za-z0-9_.-])`;
}

function wordPattern(word: string): string {
  return `(?:^|[^A-Za-z0-9_.-])${escapeRegExp(word)}(?:$|[^A-Za-z0-9_.-])`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function gitRemoteSubcommand(tokens: readonly string[]): string | null {
  const remoteIndex = tokens.findIndex((token) => token.toLowerCase() === "remote");
  if (remoteIndex < 0) return null;

  for (let index = remoteIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || token === "--" || isShellControlOperator(token)) return null;
    if (token.startsWith("-")) continue;
    return token.toLowerCase();
  }

  return null;
}

function hasUpstreamCheckoutReference(tokens: readonly string[]): boolean {
  const checkoutIndex = tokens.findIndex((token) => {
    const normalized = token.toLowerCase();
    return normalized === "checkout" || normalized === "switch";
  });
  if (checkoutIndex < 0) return false;

  for (let index = checkoutIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || token === "--" || isShellControlOperator(token)) return false;
    if (token === "--track" || token === "--guess") return true;
    if (token.startsWith("-")) continue;
    if (/^(?:origin|upstream|remotes\/origin|remotes\/upstream)\//u.test(token)) return true;
  }

  return false;
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

export function redactedCommandPreview(command: string, maxLength = COMMAND_PREVIEW_MAX_LENGTH): string {
  if (command.length === 0) return "";

  const tokens = tokenizeCommandPreview(redactSensitiveCommandText(command));
  const redacted = redactSensitiveCommandTokens(tokens).join(" ");
  const preview = redactSensitiveCommandText(redacted);
  return preview.length <= maxLength ? preview : `${preview.slice(0, maxLength - 3)}...`;
}

function redactSensitiveCommandTokens(tokens: readonly string[]): string[] {
  const redacted: string[] = [];
  let atCommandStart = true;
  let redactNextAuthValue = false;

  for (const token of tokens) {
    if (isShellControlOperator(token)) {
      redacted.push(token);
      atCommandStart = true;
      redactNextAuthValue = false;
      continue;
    }

    if (redactNextAuthValue) {
      redacted.push(REDACTED_VALUE);
      redactNextAuthValue = false;
      atCommandStart = false;
      continue;
    }

    const environmentAssignment = parseEnvironmentAssignment(token);
    if (environmentAssignment && (atCommandStart || isSensitiveAssignmentKey(environmentAssignment.key))) {
      redacted.push(`${environmentAssignment.key}=${REDACTED_VALUE}`);
      continue;
    }

    const authOption = redactAuthOptionToken(token);
    redacted.push(authOption.token);
    redactNextAuthValue = authOption.redactNextValue;
    atCommandStart = false;
  }

  return redacted;
}

function parseEnvironmentAssignment(token: string): { readonly key: string } | null {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=.*$/u.exec(token);
  const key = match?.[1];
  return key ? { key } : null;
}

function redactAuthOptionToken(token: string): { readonly token: string; readonly redactNextValue: boolean } {
  const inlineValueSeparator = token.indexOf("=");
  if (inlineValueSeparator > 0) {
    const optionName = token.slice(0, inlineValueSeparator);
    if (CLI_AUTH_OPTIONS_WITH_VALUE.has(optionName)) {
      return { token: `${optionName}=${REDACTED_VALUE}`, redactNextValue: false };
    }
  }

  if (CLI_AUTH_OPTIONS_WITH_VALUE.has(token)) {
    return { token, redactNextValue: true };
  }

  for (const shortOption of CLI_AUTH_SHORT_OPTIONS_WITH_ATTACHED_VALUE) {
    if (token.startsWith(shortOption) && token.length > shortOption.length && !token.startsWith(`${shortOption}-`)) {
      return { token: `${shortOption}${REDACTED_VALUE}`, redactNextValue: false };
    }
  }

  return { token: redactSensitiveCommandText(token), redactNextValue: false };
}

function redactSensitiveCommandText(text: string): string {
  return text
    .replace(/\b(gh[oprsu]_[A-Za-z0-9_]{8,})\b/gu, REDACTED_GITHUB_TOKEN)
    .replace(/\b(github_pat_[A-Za-z0-9_]+)\b/gu, REDACTED_GITHUB_TOKEN)
    .replace(/(https?:\/\/)([^\s/@]+)@/giu, `$1${REDACTED_VALUE}@`)
    .replace(SENSITIVE_QUERY_PARAMETER_PATTERN, `$1${REDACTED_VALUE}`)
    .replace(/(Authorization:\s*(?:Basic|Bearer|token)\s+)[^\s'";|&]+/giu, `$1${REDACTED_VALUE}`)
    .replace(/(['"])(Cookie:\s*)[^'"\r\n]*\1/giu, `$1$2${REDACTED_VALUE}$1`)
    .replace(/\b(Cookie:\s*)[^\s'";|&]+/giu, `$1${REDACTED_VALUE}`)
    .replace(
      /((?:X-GitHub-Token|X-Hub-Signature(?:-256)?|Private-Token|Job-Token):\s*)[^\s'";|&]+/giu,
      `$1${REDACTED_VALUE}`,
    );
}

function isSensitiveAssignmentKey(key: string): boolean {
  const normalized = key.replace(/[-.]/gu, "_").toLowerCase();
  return /(?:^|_)(?:api_key|auth(?:orization)?|bearer|client_secret|credential|credentials|password|passwd|pat|private_key|secret|token)(?:_|$)/u.test(
    normalized,
  );
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
      outcome: "allow",
      reasonKind,
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
      outcome: "deny",
      reasonKind,
      commandClass,
    },
  };
}

function auditBase(input: AgentCommandPolicyInput, command: string | undefined): AgentCommandPolicyAuditPayload {
  const inheritedEnvironmentKeys = extractAgentCommandPolicyEnvironmentKeys(input.environment);
  return {
    redacted: true,
    surface: input.surface,
    role: input.role,
    phase: input.phase,
    commandClass: "unclassified",
    inlineEnvironmentKeys: [],
    unsafeConfigCategories: [],
    upstreamContactAttempted: false,
    ...(inheritedEnvironmentKeys.length === 0 ? {} : { inheritedEnvironmentKeys }),
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
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === undefined) continue;

    if (char === "\\" && quote !== "'") {
      const next = command[index + 1];
      if (next !== undefined && shouldBackslashEscape(next, quote)) {
        current += next;
        index += 1;
      } else {
        current += char;
      }
      continue;
    }

    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/u.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    if (char === ";" || char === "|" || char === "&") {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      const next = command[index + 1];
      if ((char === "|" || char === "&") && next === char) {
        tokens.push(`${char}${next}`);
        index += 1;
      } else {
        tokens.push(char);
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) tokens.push(current);
  return tokens;
}

function shouldBackslashEscape(char: string, quote: "'" | '"' | null): boolean {
  if (quote === '"') {
    return char === '"' || char === "\\" || char === "$" || char === "`";
  }
  return /\s/u.test(char) || char === "'" || char === '"' || char === ";" || char === "|" || char === "&";
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

function extractGithubHosts(tokens: readonly string[]): string[] {
  const hosts = new Set<string>();
  for (const token of tokens) {
    const host = githubHostFromToken(token);
    if (host !== null) hosts.add(host);
  }
  return [...hosts].sort();
}

function githubHostFromToken(token: string): string | null {
  const trimmed = token.trim().replace(/^[<({\[]+|[>)}\],.]+$/gu, "");
  if (trimmed.length === 0) return null;

  const urlHost = hostFromUrl(trimmed);
  if (urlHost !== null && isGithubHost(urlHost)) return urlHost;

  const scpLikeMatch = /^(?:[^@\s]+@)?([^:\s]+):[^\s]+$/u.exec(trimmed);
  const scpLikeHost = scpLikeMatch?.[1]?.toLowerCase();
  if (scpLikeHost && isGithubHost(scpLikeHost)) return scpLikeHost;

  const hostMatch = /(?:^|[^A-Za-z0-9.-])([A-Za-z0-9.-]*(?:githubusercontent\.com|github\.com))(?:$|[^A-Za-z0-9.-])/iu.exec(
    trimmed,
  );
  const host = hostMatch?.[1]?.toLowerCase();
  return host && isGithubHost(host) ? host : null;
}

function hostFromUrl(token: string): string | null {
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(token)) return null;

  try {
    return new URL(token).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isGithubHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.$/u, "");
  return (
    normalized === "github.com" ||
    normalized.endsWith(".github.com") ||
    normalized === "githubusercontent.com" ||
    normalized.endsWith(".githubusercontent.com")
  );
}

function isShellControlOperator(token: string): boolean {
  return token === ";" || token === "|" || token === "&" || token === "&&" || token === "||";
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

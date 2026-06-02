export type AgentCommandPolicyOutcome = "allow" | "deny";

export type AgentCommandPolicyReasonKind = "upstream_github" | "unknown_command" | "role_not_restricted";

export type AgentCommandPolicySurface =
  | "terminal"
  | "shell"
  | "acp_permission"
  | "gateway_pre_tool_call"
  | "subagent_tool_call"
  | "execute_code"
  | "command_reducer";

export interface AgentCommandPolicyInput {
  readonly runId?: string | null;
  readonly issueId?: string | null;
  readonly role: string;
  readonly phase?: string | null;
  readonly surface: AgentCommandPolicySurface;
  readonly workingDirectory: string;
  readonly rawInput: {
    readonly command?: string | null;
    readonly code?: string | null;
  };
  readonly environment?: {
    readonly keysOnly?: readonly string[];
  };
}

export interface AgentCommandPolicyDecision {
  readonly outcome: AgentCommandPolicyOutcome;
  readonly reasonKind: AgentCommandPolicyReasonKind;
  readonly commandClass: string;
  readonly message: string;
  readonly audit: AgentCommandPolicyAudit;
}

export interface AgentCommandPolicyAudit {
  readonly redacted: true;
  readonly surface: AgentCommandPolicySurface;
  readonly role: string;
  readonly phase?: string | null;
  readonly normalizedExecutable?: string;
  readonly gitSubcommand?: string;
  readonly targetHosts?: readonly string[];
  readonly commandPreview?: string;
  readonly inlineEnvironmentKeys?: readonly string[];
  readonly upstreamContactAttempted: false;
}

interface ParsedCommandAttempt {
  readonly command: string;
  readonly tokens: readonly string[];
  readonly executableToken?: string;
  readonly executableIndex?: number;
  readonly normalizedExecutable?: string;
  readonly gitSubcommand?: string;
  readonly gitSubcommandIndex?: number;
  readonly targetHosts: readonly string[];
  readonly inlineEnvironmentKeys: readonly string[];
  readonly commandPreview: string;
}

const RESTRICTED_AGENT_ROLES = new Set(["worker", "reviewer"]);

const DIRECT_UPSTREAM_GIT_SUBCOMMANDS = new Set([
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

const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "-c",
  "-C",
  "--config-env",
  "--exec-path",
  "--git-dir",
  "--html-path",
  "--namespace",
  "--super-prefix",
  "--work-tree",
]);

const GITHUB_CLI_EXECUTABLES = new Set(["gh", "hub"]);
const GITHUB_TRANSPORT_EXECUTABLES = new Set(["scp", "sftp", "ssh"]);
const GIT_REMOTE_UPSTREAM_SUBCOMMANDS = new Set(["prune", "update"]);
const GIT_UPSTREAM_CHECKOUT_SUBCOMMANDS = new Set(["checkout", "switch"]);
const GITHUB_NETWORK_EXECUTABLES = new Set([
  "aria2c",
  "curl",
  "http",
  "https",
  "wget",
]);

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

export function evaluateAgentCommandPolicy(input: AgentCommandPolicyInput): AgentCommandPolicyDecision {
  const parsed = parseCommandAttempt(input);

  if (!RESTRICTED_AGENT_ROLES.has(input.role)) {
    return buildDecision(input, parsed, {
      outcome: "allow",
      reasonKind: "role_not_restricted",
      commandClass: "role_not_restricted",
      message:
        "Agent command policy is scoped to worker and reviewer command surfaces; this role is not restricted by the worker/reviewer upstream GitHub boundary.",
    });
  }

  if (!parsed.executableToken || !parsed.normalizedExecutable) {
    return buildDecision(input, parsed, {
      outcome: "deny",
      reasonKind: "unknown_command",
      commandClass: "unknown_command",
      message:
        "Blocked worker/reviewer command: command content could not be classified before execution. Use local inspection that can be proven safe, or rely on Symphony service-owned GitHub workflow actions.",
    });
  }

  const upstreamClass = classifyDirectUpstreamGithubAttempt(parsed);
  if (upstreamClass) {
    return buildDecision(input, parsed, {
      outcome: "deny",
      reasonKind: "upstream_github",
      commandClass: upstreamClass,
      message:
        "Blocked worker/reviewer upstream GitHub command: direct GitHub activity is disallowed for worker/reviewer agents. Leave publication, PR updates, reviews, and writeback to Symphony's service-owned workflow.",
    });
  }

  return buildDecision(input, parsed, {
    outcome: "deny",
    reasonKind: "unknown_command",
    commandClass: "unclassified_command",
    message:
      "Blocked worker/reviewer command: the command is not yet classified as helper-free local inspection. Use a known local-only workflow or rely on Symphony service-owned GitHub workflow actions.",
  });
}

function classifyDirectUpstreamGithubAttempt(parsed: ParsedCommandAttempt): string | null {
  const executable = parsed.normalizedExecutable;
  if (!executable) {
    return null;
  }

  if (executable === "git") {
    if (parsed.gitSubcommand && DIRECT_UPSTREAM_GIT_SUBCOMMANDS.has(parsed.gitSubcommand)) {
      return `git_${parsed.gitSubcommand.replace(/-/g, "_")}`;
    }

    const remoteAction = parsed.gitSubcommand === "remote" ? gitRemoteSubcommand(parsed) : null;
    if (remoteAction && GIT_REMOTE_UPSTREAM_SUBCOMMANDS.has(remoteAction)) {
      return `git_remote_${remoteAction}`;
    }

    if (
      parsed.gitSubcommand &&
      GIT_UPSTREAM_CHECKOUT_SUBCOMMANDS.has(parsed.gitSubcommand) &&
      hasUpstreamCheckoutReference(parsed)
    ) {
      return "git_upstream_checkout";
    }

    if (parsed.targetHosts.length > 0) {
      return "git_github_transport";
    }
  }

  if (GITHUB_CLI_EXECUTABLES.has(executable)) {
    return "github_cli";
  }

  if (GITHUB_TRANSPORT_EXECUTABLES.has(executable) && parsed.targetHosts.length > 0) {
    return `${executable}_github_transport`;
  }

  if (GITHUB_NETWORK_EXECUTABLES.has(executable) && parsed.targetHosts.length > 0) {
    return `${executable}_github_request`;
  }

  if (parsed.targetHosts.length > 0) {
    return "github_host_reference";
  }

  return null;
}

function parseCommandAttempt(input: AgentCommandPolicyInput): ParsedCommandAttempt {
  const command = input.rawInput.command?.trim() ?? "";
  const tokens = tokenizeShellLike(command);
  const inlineEnvironment = collectLeadingEnvironmentAssignments(tokens);
  const executableIndex = firstExecutableIndex(tokens, inlineEnvironment.length);
  const executableToken = executableIndex === null ? undefined : tokens[executableIndex];
  const normalizedExecutable = executableToken ? normalizeExecutableName(executableToken) : undefined;
  const gitSubcommandInfo =
    normalizedExecutable === "git" && executableIndex !== null ? findGitSubcommand(tokens, executableIndex) : null;

  return {
    command,
    tokens,
    ...(executableToken ? { executableToken } : {}),
    ...(executableIndex !== null ? { executableIndex } : {}),
    ...(normalizedExecutable ? { normalizedExecutable } : {}),
    ...(gitSubcommandInfo?.subcommand ? { gitSubcommand: gitSubcommandInfo.subcommand } : {}),
    ...(gitSubcommandInfo?.index !== undefined ? { gitSubcommandIndex: gitSubcommandInfo.index } : {}),
    targetHosts: extractGithubHosts(tokens),
    inlineEnvironmentKeys: inlineEnvironment,
    commandPreview: redactCommandPreview(command),
  };
}

function buildDecision(
  input: AgentCommandPolicyInput,
  parsed: ParsedCommandAttempt,
  decision: Omit<AgentCommandPolicyDecision, "audit">,
): AgentCommandPolicyDecision {
  return {
    ...decision,
    audit: {
      redacted: true,
      surface: input.surface,
      role: input.role,
      ...(input.phase !== undefined ? { phase: input.phase } : {}),
      ...(parsed.normalizedExecutable ? { normalizedExecutable: parsed.normalizedExecutable } : {}),
      ...(parsed.gitSubcommand ? { gitSubcommand: parsed.gitSubcommand } : {}),
      ...(parsed.targetHosts.length > 0 ? { targetHosts: parsed.targetHosts } : {}),
      ...(parsed.commandPreview ? { commandPreview: parsed.commandPreview } : {}),
      ...(parsed.inlineEnvironmentKeys.length > 0 ? { inlineEnvironmentKeys: parsed.inlineEnvironmentKeys } : {}),
      upstreamContactAttempted: false,
    },
  };
}

function firstExecutableIndex(tokens: readonly string[], startIndex: number): number | null {
  for (let index = startIndex; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || isShellControlOperator(token)) {
      continue;
    }
    return index;
  }
  return null;
}

function collectLeadingEnvironmentAssignments(tokens: readonly string[]): string[] {
  const keys: string[] = [];
  for (const token of tokens) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=.*/u.exec(token);
    if (!match) {
      break;
    }
    const key = match[1];
    if (key) {
      keys.push(key);
    }
  }
  return keys;
}

function findGitSubcommand(
  tokens: readonly string[],
  executableIndex: number,
): { readonly subcommand: string; readonly index: number } | null {
  for (let index = executableIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token === "--" || isShellControlOperator(token)) {
      return null;
    }

    if (token.startsWith("-")) {
      const optionName = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
      if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(optionName) && !token.includes("=")) {
        index += 1;
      }
      continue;
    }

    return { subcommand: normalizeGitSubcommand(token), index };
  }

  return null;
}

function gitRemoteSubcommand(parsed: ParsedCommandAttempt): string | null {
  if (parsed.gitSubcommandIndex === undefined) {
    return null;
  }

  for (let index = parsed.gitSubcommandIndex + 1; index < parsed.tokens.length; index += 1) {
    const token = parsed.tokens[index];
    if (!token || token === "--" || isShellControlOperator(token)) {
      return null;
    }
    if (token.startsWith("-")) {
      continue;
    }
    return normalizeGitSubcommand(token);
  }

  return null;
}

function hasUpstreamCheckoutReference(parsed: ParsedCommandAttempt): boolean {
  if (parsed.gitSubcommandIndex === undefined) {
    return false;
  }

  for (let index = parsed.gitSubcommandIndex + 1; index < parsed.tokens.length; index += 1) {
    const token = parsed.tokens[index];
    if (!token || token === "--" || isShellControlOperator(token)) {
      return false;
    }
    if (token === "--track" || token === "--guess") {
      return true;
    }
    if (token.startsWith("-")) {
      continue;
    }
    if (/^(?:origin|upstream|remotes\/origin|remotes\/upstream)\//u.test(token)) {
      return true;
    }
  }

  return false;
}

function normalizeGitSubcommand(token: string): string {
  return token.trim().toLowerCase();
}

function normalizeExecutableName(token: string): string {
  const withoutQuotes = token.trim().replace(/^['"]|['"]$/gu, "");
  const normalizedSeparators = withoutQuotes.replace(/\\/gu, "/");
  const parts = normalizedSeparators.split("/").filter(Boolean);
  const basename = parts.at(-1) ?? normalizedSeparators;
  return basename.replace(/\.(?:exe|cmd|bat|ps1)$/iu, "").toLowerCase();
}

function tokenizeShellLike(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (!char) {
      continue;
    }

    if (char === "\\" && quote !== "'") {
      const next = command[index + 1];
      if (next && shouldBackslashEscape(next, quote)) {
        current += next;
        index += 1;
      } else {
        current += char;
      }
      continue;
    }

    if (quote) {
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
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    if (char === ";" || char === "|" || char === "&") {
      if (current) {
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

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function shouldBackslashEscape(char: string, quote: "'" | '"' | null): boolean {
  if (quote === '"') {
    return char === '"' || char === "\\" || char === "$" || char === "`";
  }
  return /\s/u.test(char) || char === "'" || char === '"' || char === ";" || char === "|" || char === "&";
}

function extractGithubHosts(tokens: readonly string[]): string[] {
  const hosts = new Set<string>();
  for (const token of tokens) {
    const host = githubHostFromToken(token);
    if (host) {
      hosts.add(host);
    }
  }
  return [...hosts].sort();
}

function githubHostFromToken(token: string): string | null {
  const trimmed = token.trim().replace(/^[<({\[]+|[>)}\],.]+$/gu, "");
  if (!trimmed) {
    return null;
  }

  const urlHost = hostFromUrl(trimmed);
  if (urlHost && isGithubHost(urlHost)) {
    return urlHost;
  }

  const scpLikeMatch = /^(?:[^@\s]+@)?([^:\s]+):[^\s]+$/u.exec(trimmed);
  const scpLikeHost = scpLikeMatch?.[1]?.toLowerCase();
  if (scpLikeHost && isGithubHost(scpLikeHost)) {
    return scpLikeHost;
  }

  const hostMatch = /(?:^|[^A-Za-z0-9.-])([A-Za-z0-9.-]*(?:githubusercontent\.com|github\.com))(?:$|[^A-Za-z0-9.-])/iu.exec(
    trimmed,
  );
  const host = hostMatch?.[1]?.toLowerCase();
  if (host && isGithubHost(host)) {
    return host;
  }

  return null;
}

function hostFromUrl(token: string): string | null {
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(token)) {
    return null;
  }

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

function redactCommandPreview(command: string): string {
  if (!command) {
    return "";
  }

  const tokens = tokenizeShellLike(redactSensitiveCommandText(command));
  const redacted = redactSensitiveCommandTokens(tokens).join(" ");
  const preview = redactSensitiveCommandText(redacted);

  return preview.length > COMMAND_PREVIEW_MAX_LENGTH
    ? `${preview.slice(0, COMMAND_PREVIEW_MAX_LENGTH - 3)}...`
    : preview;
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

function isShellControlOperator(token: string): boolean {
  return token === ";" || token === "|" || token === "&" || token === "&&" || token === "||";
}

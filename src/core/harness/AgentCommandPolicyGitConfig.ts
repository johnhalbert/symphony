import fs from "node:fs";
import path from "node:path";

import type {
  AgentCommandPolicyEnvironmentInput,
  AgentCommandPolicyUnsafeGitConfigCategory,
  AgentCommandPolicyUnsafeGitConfigEffect,
  AgentCommandPolicyUnsafeGitConfigFinding,
  AgentCommandPolicyUnsafeGitConfigSource,
} from "./AgentCommandPolicy.js";

interface PersistedGitConfigInspectionInput {
  readonly workingDirectory: string;
  readonly environment?: AgentCommandPolicyEnvironmentInput | undefined;
}

interface PersistedGitConfigFile {
  readonly path: string;
  readonly source: Extract<AgentCommandPolicyUnsafeGitConfigSource, "persisted_repo_config" | "persisted_user_config">;
}

interface ParsedGitConfigEntry {
  readonly key: string;
  readonly value: string | undefined;
}

const MAX_GIT_CONFIG_DISCOVERY_DEPTH = 64;
const MAX_GIT_CONFIG_BYTES = 1024 * 1024;
const GIT_CONFIG_KEY_PATTERN = /^([A-Za-z0-9_.-]+)\s*(?:=\s*(.*))?$/u;
const GIT_CONFIG_SECTION_PATTERN = /^\[([^\]]+)\]$/u;
const GIT_CONFIG_SECTION_WITH_SUBSECTION_PATTERN = /^([A-Za-z0-9_.-]+)(?:\s+"((?:\\.|[^"\\])*)")?$/u;
const DISABLED_CONFIG_VALUES = new Set(["", "0", "false", "no", "none", "off", "never"]);

export function inspectPersistedGitConfigForUnsafeEntries(
  input: PersistedGitConfigInspectionInput,
): AgentCommandPolicyUnsafeGitConfigFinding[] {
  const findings = new Map<string, AgentCommandPolicyUnsafeGitConfigFinding>();
  for (const configFile of persistedGitConfigFiles(input)) {
    const configText = readPersistedGitConfigText(configFile.path);
    if (configText.status === "missing") continue;
    if (configText.status === "error") {
      addFinding(findings, {
        source: configFile.source,
        key: "<unreadable>",
        category: "other",
        effect: "ambiguous",
      });
      continue;
    }

    for (const entry of parseGitConfigEntries(configText.text)) {
      const finding = unsafePersistedGitConfigFinding(entry, configFile.source);
      if (finding !== null) addFinding(findings, finding);
    }
  }

  return [...findings.values()].sort(compareUnsafeGitConfigFindings);
}

function persistedGitConfigFiles(input: PersistedGitConfigInspectionInput): PersistedGitConfigFile[] {
  return uniqueConfigFiles([
    ...persistedRepoGitConfigFiles(input.workingDirectory),
    ...persistedUserGitConfigFiles(input),
  ]);
}

function persistedRepoGitConfigFiles(workingDirectory: string): PersistedGitConfigFile[] {
  const configFiles: PersistedGitConfigFile[] = [];
  const startDirectory = path.resolve(workingDirectory);
  const startStat = statPath(startDirectory);
  if (startStat === null || !startStat.isDirectory()) return configFiles;

  let directory = startDirectory;

  for (let depth = 0; depth < MAX_GIT_CONFIG_DISCOVERY_DEPTH; depth += 1) {
    const dotGitPath = path.join(directory, ".git");
    const gitDirectory = resolveGitDirectory(dotGitPath, directory);
    if (gitDirectory !== null) {
      configFiles.push(...configFilesForGitDirectory(gitDirectory));
      break;
    }

    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  return configFiles;
}

function resolveGitDirectory(dotGitPath: string, worktreeDirectory: string): string | null {
  const stat = statPath(dotGitPath);
  if (stat === null) return null;
  if (stat.isDirectory()) return dotGitPath;
  if (!stat.isFile()) return null;

  const dotGitText = readSmallTextFile(dotGitPath);
  if (dotGitText === null) return null;
  const match = /^gitdir:\s*(.+)$/imu.exec(dotGitText);
  const rawGitDirectory = match?.[1]?.trim();
  if (!rawGitDirectory) return null;
  return resolveConfigPath(rawGitDirectory, worktreeDirectory);
}

function configFilesForGitDirectory(gitDirectory: string): PersistedGitConfigFile[] {
  const configFiles: PersistedGitConfigFile[] = [
    { path: path.join(gitDirectory, "config"), source: "persisted_repo_config" },
    { path: path.join(gitDirectory, "config.worktree"), source: "persisted_repo_config" },
  ];
  const commonDirectoryText = readSmallTextFile(path.join(gitDirectory, "commondir"));
  const commonDirectory = commonDirectoryText?.trim();
  if (commonDirectory) {
    const resolvedCommonDirectory = resolveConfigPath(commonDirectory, gitDirectory);
    configFiles.push({ path: path.join(resolvedCommonDirectory, "config"), source: "persisted_repo_config" });
  }
  return configFiles;
}

function persistedUserGitConfigFiles(input: PersistedGitConfigInspectionInput): PersistedGitConfigFile[] {
  const configFiles: PersistedGitConfigFile[] = [];
  const gitConfigGlobal = environmentValue(input.environment, "GIT_CONFIG_GLOBAL");
  if (gitConfigGlobal !== undefined && !isDisabledGlobalConfigPath(gitConfigGlobal)) {
    configFiles.push({
      path: resolveConfigPath(gitConfigGlobal, input.workingDirectory),
      source: "persisted_user_config",
    });
  }

  const homeDirectory = environmentValue(input.environment, "HOME") ?? environmentValue(input.environment, "USERPROFILE");
  const xdgConfigHome = environmentValue(input.environment, "XDG_CONFIG_HOME");
  if (homeDirectory !== undefined) {
    configFiles.push({ path: path.join(homeDirectory, ".gitconfig"), source: "persisted_user_config" });
    if (xdgConfigHome === undefined) {
      configFiles.push({
        path: path.join(homeDirectory, ".config", "git", "config"),
        source: "persisted_user_config",
      });
    }
  }
  if (xdgConfigHome !== undefined) {
    configFiles.push({ path: path.join(xdgConfigHome, "git", "config"), source: "persisted_user_config" });
  }

  return configFiles;
}

function readPersistedGitConfigText(
  configPath: string,
): { readonly status: "missing" } | { readonly status: "error" } | { readonly status: "ok"; readonly text: string } {
  const stat = statPath(configPath);
  if (stat === null) return { status: "missing" };
  if (!stat.isFile()) return { status: "error" };
  if (stat.size > MAX_GIT_CONFIG_BYTES) return { status: "error" };

  try {
    return { status: "ok", text: fs.readFileSync(configPath, "utf8") };
  } catch {
    return { status: "error" };
  }
}

function readSmallTextFile(filePath: string): string | null {
  const stat = statPath(filePath);
  if (stat === null || !stat.isFile() || stat.size > MAX_GIT_CONFIG_BYTES) return null;
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function statPath(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function parseGitConfigEntries(configText: string): ParsedGitConfigEntry[] {
  const entries: ParsedGitConfigEntry[] = [];
  let section: string | null = null;

  for (const rawLine of configText.split(/\r?\n/u)) {
    const trimmedLine = rawLine.trim();
    if (trimmedLine.length === 0 || trimmedLine.startsWith("#") || trimmedLine.startsWith(";")) continue;

    const sectionMatch = GIT_CONFIG_SECTION_PATTERN.exec(trimmedLine);
    if (sectionMatch !== null) {
      section = normalizeGitConfigSection(sectionMatch[1] ?? "");
      continue;
    }

    if (section === null) continue;
    const keyMatch = GIT_CONFIG_KEY_PATTERN.exec(trimmedLine);
    const rawName = keyMatch?.[1];
    if (rawName === undefined) {
      entries.push({ key: `${section}.<malformed>`, value: undefined });
      continue;
    }

    entries.push({
      key: `${section}.${rawName}`.toLowerCase(),
      value: normalizeConfigValue(keyMatch?.[2]),
    });
  }

  return entries;
}

function normalizeGitConfigSection(rawSection: string): string | null {
  const sectionMatch = GIT_CONFIG_SECTION_WITH_SUBSECTION_PATTERN.exec(rawSection.trim());
  const sectionName = sectionMatch?.[1]?.toLowerCase();
  if (sectionName === undefined) return null;
  const subsection = sectionMatch?.[2];
  if (subsection === undefined) return sectionName;
  return `${sectionName}.${unescapeGitConfigSubsection(subsection).toLowerCase()}`;
}

function unescapeGitConfigSubsection(value: string): string {
  return value.replace(/\\(["\\])/gu, "$1");
}

function normalizeConfigValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function unsafePersistedGitConfigFinding(
  entry: ParsedGitConfigEntry,
  source: Extract<AgentCommandPolicyUnsafeGitConfigSource, "persisted_repo_config" | "persisted_user_config">,
): AgentCommandPolicyUnsafeGitConfigFinding | null {
  const category = unsafePersistedGitConfigCategory(entry.key, entry.value);
  if (category === null) return null;
  return {
    source,
    key: redactedGitConfigKey(entry.key),
    category,
    effect: unsafePersistedGitConfigEffect(category),
  };
}

function unsafePersistedGitConfigCategory(
  key: string,
  value: string | undefined,
): AgentCommandPolicyUnsafeGitConfigCategory | null {
  if (key.endsWith(".<malformed>")) return "other";
  if (!hasSubstantiveConfigValue(value)) {
    return isAmbiguousConfigKey(key) ? "other" : null;
  }

  if (key.startsWith("alias.")) return "alias";
  if (key === "core.pager" || key.startsWith("pager.")) return "pager";
  if (key === "core.externaldiff" || key === "diff.external") return "external_diff";
  if (key.startsWith("diff.") && (key.endsWith(".command") || key.endsWith(".textconv"))) {
    return "external_diff";
  }
  if (key.startsWith("difftool.") && (key.endsWith(".cmd") || key.endsWith(".path") || key.endsWith(".trustexitcode"))) {
    return "external_diff";
  }
  if (key === "credential.helper" || key.startsWith("credential.")) return "credential_helper";
  if (key === "core.hookspath" || key.startsWith("hook.")) return "hook";
  if (key.startsWith("filter.")) return "filter";
  if (key === "gpg.program" || key === "gpg.ssh.program") return "signing_program";
  if (key === "core.fsmonitor" || key.startsWith("fsmonitor.")) return "filesystem_monitor";
  if (key === "core.sshcommand") return "ssh_command";
  if (key === "core.gitproxy") return "transport_helper";
  if (key.startsWith("protocol.") && (key.endsWith(".allow") || key === "protocol.allow")) {
    return "transport_helper";
  }
  if (key.startsWith("url.") && (key.endsWith(".insteadof") || key.endsWith(".pushinsteadof"))) {
    return "transport_helper";
  }
  if (isAmbiguousConfigKey(key)) return "other";

  return null;
}

function hasSubstantiveConfigValue(value: string | undefined): boolean {
  if (value === undefined) return true;
  return !DISABLED_CONFIG_VALUES.has(value.trim().toLowerCase());
}

function isAmbiguousConfigKey(key: string): boolean {
  return key === "include.path" || (key.startsWith("includeif.") && key.endsWith(".path"));
}

function unsafePersistedGitConfigEffect(
  category: AgentCommandPolicyUnsafeGitConfigCategory,
): AgentCommandPolicyUnsafeGitConfigEffect {
  if (category === "credential_helper") return "uses_credentials";
  if (category === "transport_helper" || category === "ssh_command") return "contacts_remote";
  if (category === "other") return "ambiguous";
  return "executes_helper";
}

function addFinding(
  findings: Map<string, AgentCommandPolicyUnsafeGitConfigFinding>,
  finding: AgentCommandPolicyUnsafeGitConfigFinding,
): void {
  findings.set(`${finding.source}\u0000${finding.key}\u0000${finding.category}\u0000${finding.effect}`, finding);
}

function compareUnsafeGitConfigFindings(
  left: AgentCommandPolicyUnsafeGitConfigFinding,
  right: AgentCommandPolicyUnsafeGitConfigFinding,
): number {
  return (
    left.source.localeCompare(right.source) ||
    left.key.localeCompare(right.key) ||
    left.category.localeCompare(right.category) ||
    left.effect.localeCompare(right.effect)
  );
}

function uniqueConfigFiles(configFiles: readonly PersistedGitConfigFile[]): PersistedGitConfigFile[] {
  const seen = new Set<string>();
  const unique: PersistedGitConfigFile[] = [];
  for (const configFile of configFiles) {
    const key = `${configFile.source}\u0000${path.resolve(configFile.path).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(configFile);
  }
  return unique;
}

function environmentValue(input: AgentCommandPolicyEnvironmentInput | undefined, wantedKey: string): string | undefined {
  const inherited = input?.inherited;
  if (inherited === undefined) return undefined;
  const normalizedWantedKey = wantedKey.toUpperCase();
  for (const [key, value] of Object.entries(inherited)) {
    if (key.trim().toUpperCase() !== normalizedWantedKey) continue;
    const trimmedValue = value?.trim();
    return trimmedValue === undefined || trimmedValue.length === 0 ? undefined : trimmedValue;
  }
  return undefined;
}

function resolveConfigPath(configPath: string, baseDirectory: string): string {
  if (isAbsoluteConfigPath(configPath)) return configPath;
  return path.resolve(baseDirectory, configPath);
}

function isAbsoluteConfigPath(configPath: string): boolean {
  return path.isAbsolute(configPath) || /^[A-Za-z]:[\\/]/u.test(configPath) || /^\\\\/u.test(configPath);
}

function isDisabledGlobalConfigPath(configPath: string): boolean {
  const normalized = configPath.trim().replace(/\\/gu, "/").toLowerCase();
  return normalized.length === 0 || normalized === "/dev/null" || normalized === "nul";
}

function redactedGitConfigKey(key: string): string {
  return key
    .replace(/(https?:\/\/)([^\s/@]+)@/giu, `$1[redacted]@`)
    .replace(/\b(?:gh[oprsu]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]+)\b/gu, "[redacted-github-token]");
}

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { SymphonyError } from "../../src/core/errors.js";

export type HermesProfileMaterializeMode = "reuse" | "fresh";
export type HermesProfileReuseMode = "reuse_by_issue" | "fresh_per_run";

export interface HermesProfileManagerOptions {
  templatesDir: string;
  stateDir: string;
}

export interface HermesProfileRequest {
  workspaceKey: string;
  role: string;
  phase: string;
  template: string;
  profileKey: string;
  mode: HermesProfileMaterializeMode;
}

export interface HermesAcpProfileNameRequest {
  workspaceKey: string;
  role: string;
  issueIdentifier: string;
  phase: string;
  reuseMode: HermesProfileReuseMode;
  freshLeaseId?: string | null;
}

export interface HermesProfile {
  profileDir: string;
  templateDir: string;
  profileKey: string;
  createdFresh: boolean;
}

const PROFILE_DIRS = ["memories", "sessions", "skills", "skins", "logs", "plans", "workspace", "cron", "home"] as const;
const MAX_HERMES_PROFILE_NAME_LENGTH = 64;
const PROFILE_NAME_HASH_LENGTH = 16;
const PROFILE_NAME_COLLISION_PREFIX = "sym";

// Mirrors the upstream Hermes profile-name/alias collision surfaces in
// hermes_cli.profiles so generated ACP profile names never land on the
// special default profile, Hermes subcommands, or common host command names.
const RESERVED_HERMES_PROFILE_NAMES = new Set([
  "hermes",
  "default",
  "test",
  "tmp",
  "root",
  "sudo",
  "chat",
  "model",
  "gateway",
  "setup",
  "whatsapp",
  "login",
  "logout",
  "status",
  "cron",
  "doctor",
  "dump",
  "config",
  "pairing",
  "skills",
  "tools",
  "mcp",
  "sessions",
  "insights",
  "version",
  "update",
  "uninstall",
  "profile",
  "plugins",
  "honcho",
  "acp",
  "git",
  "node",
  "npm",
  "npx",
  "python",
  "python3",
  "bash",
  "sh",
  "cmd",
  "powershell",
  "pwsh",
  "curl",
  "ssh",
]);

export class HermesProfileManager {
  constructor(private readonly options: HermesProfileManagerOptions) {}

  async materialize(request: HermesProfileRequest): Promise<HermesProfile> {
    const templateDir = this.resolveTemplateDir(request.template);
    const profileDir = this.resolveProfileDir(request);
    await this.assertTemplateDir(templateDir);
    assertPathInsideRoot(profileDir, this.options.stateDir);

    let createdFresh = false;
    if (request.mode === "fresh" || !(await pathExists(profileDir))) {
      if (await pathExists(profileDir)) {
        await fs.rm(profileDir, { recursive: true, force: true });
      }
      await fs.mkdir(path.dirname(profileDir), { recursive: true });
      await fs.cp(templateDir, profileDir, { recursive: true, force: true });
      createdFresh = true;
    }
    await ensureProfileShape(profileDir);
    await fs.writeFile(
      path.join(profileDir, ".symphony-hermes-profile.json"),
      `${JSON.stringify(
        {
          profileKey: request.profileKey,
          workspaceKey: request.workspaceKey,
          role: request.role,
          phase: request.phase,
          template: request.template,
          materializedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    return { profileDir, templateDir, profileKey: request.profileKey, createdFresh };
  }

  resolveTemplateDir(template: string): string {
    return path.resolve(path.isAbsolute(template) ? template : path.join(this.options.templatesDir, template));
  }

  resolveProfileDir(request: Pick<HermesProfileRequest, "workspaceKey" | "role" | "phase" | "profileKey">): string {
    return path.resolve(
      this.options.stateDir,
      "profiles",
      safeSegment(request.workspaceKey),
      safeSegment(request.role),
      safeSegment(request.phase),
      safeSegment(request.profileKey),
    );
  }

  private async assertTemplateDir(templateDir: string): Promise<void> {
    let stat;
    try {
      stat = await fs.stat(templateDir);
    } catch (error) {
      throw new SymphonyError("config_validation_error", `Hermes profile template does not exist: ${templateDir}`, error);
    }
    if (!stat.isDirectory()) {
      throw new SymphonyError("config_validation_error", `Hermes profile template is not a directory: ${templateDir}`);
    }
  }
}

export async function ensureProfileShape(profileDir: string): Promise<void> {
  await fs.mkdir(profileDir, { recursive: true });
  await Promise.all(PROFILE_DIRS.map((entry) => fs.mkdir(path.join(profileDir, entry), { recursive: true })));
}

export function hermesAcpProfileName(request: HermesAcpProfileNameRequest): string {
  const freshLeaseId = request.reuseMode === "fresh_per_run" ? nonEmptyString(request.freshLeaseId) : null;
  if (request.reuseMode === "fresh_per_run" && !freshLeaseId) {
    throw new SymphonyError("config_validation_error", "Fresh Hermes ACP profile names require a fresh lease id");
  }

  const rawComponents = {
    workspaceKey: request.workspaceKey,
    role: request.role,
    issueIdentifier: request.issueIdentifier,
    phase: request.phase,
    reuseMode: request.reuseMode,
    freshLeaseId,
  };
  const readableName = [
    PROFILE_NAME_COLLISION_PREFIX,
    profileNamePart(request.workspaceKey, "workspace"),
    profileNamePart(request.role, "role"),
    profileNamePart(request.issueIdentifier, "issue"),
    profileNamePart(request.phase, "phase"),
    profileNamePart(request.reuseMode, "mode"),
    ...(freshLeaseId ? [profileNamePart(freshLeaseId, "lease")] : []),
  ].join("_");

  return profileNameFromSource(readableName, JSON.stringify(rawComponents));
}

export function safeProfileKey(value: string): string {
  return profileNameFromSource(value, value);
}

function safeSegment(value: string): string {
  return safeProfileKey(value);
}

function profileNameFromSource(value: string, hashSource: string): string {
  const normalized = normalizeProfileNameStem(value);
  const candidate = RESERVED_HERMES_PROFILE_NAMES.has(normalized) ? `${PROFILE_NAME_COLLISION_PREFIX}_${normalized}` : normalized;
  return compactProfileName(candidate, hashSource);
}

function compactProfileName(candidate: string, hashSource: string): string {
  if (candidate.length <= MAX_HERMES_PROFILE_NAME_LENGTH && !RESERVED_HERMES_PROFILE_NAMES.has(candidate)) return candidate;

  const hash = createHash("sha256").update(hashSource).digest("hex").slice(0, PROFILE_NAME_HASH_LENGTH);
  const prefixLength = MAX_HERMES_PROFILE_NAME_LENGTH - hash.length - 1;
  const prefix = candidate.slice(0, prefixLength).replace(/[_-]+$/g, "") || "profile";
  const compact = `${prefix}_${hash}`;
  if (!RESERVED_HERMES_PROFILE_NAMES.has(compact)) return compact;
  return `${PROFILE_NAME_COLLISION_PREFIX}_${hash}`;
}

function profileNamePart(value: string, fallback: string): string {
  const normalized = normalizeProfileNameStem(value);
  return normalized === "profile" && !/[A-Za-z0-9]/.test(value) ? fallback : normalized;
}

function normalizeProfileNameStem(value: string): string {
  const normalized = String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/[_-]{2,}/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "");
  return normalized || "profile";
}

function nonEmptyString(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function assertPathInsideRoot(targetPath: string, rootPath: string): void {
  const root = path.resolve(rootPath);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new SymphonyError("config_validation_error", `Hermes profile path escapes state root: ${target}`);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

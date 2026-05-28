import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { SymphonyError } from "../../src/core/errors.js";

export type HermesProfileMaterializeMode = "reuse" | "fresh";

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

export interface HermesProfile {
  profileDir: string;
  templateDir: string;
  profileKey: string;
  createdFresh: boolean;
}

const PROFILE_DIRS = ["memories", "sessions", "skills", "skins", "logs", "plans", "workspace", "cron", "home"] as const;
const MAX_PROFILE_PATH_SEGMENT_LENGTH = 40;

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

export function safeProfileKey(value: string): string {
  return safeSegment(value);
}

function safeSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/_+/g, "_") || "profile";
  if (sanitized.length <= MAX_PROFILE_PATH_SEGMENT_LENGTH) return sanitized;
  const hash = createHash("sha256").update(sanitized).digest("hex").slice(0, 10);
  const prefixLength = MAX_PROFILE_PATH_SEGMENT_LENGTH - hash.length - 1;
  const prefix = sanitized.slice(0, prefixLength).replace(/[._-]+$/g, "") || "profile";
  return `${prefix}_${hash}`;
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

import { spawn } from "node:child_process";
import path from "node:path";
import { SymphonyError } from "../../src/core/errors.js";
import { assertPathInsideRoot, assertRealPathInsideRoot } from "../../src/core/workspace/WorkspaceManager.js";

export type CursorWorkspaceRootSource = string | readonly string[] | (() => string | readonly string[]);

export interface CursorWorkspaceOpenerOptions {
  workspaceRoot: CursorWorkspaceRootSource;
  openerCommand: string | null;
}

export class CursorWorkspaceOpener {
  constructor(private readonly options: CursorWorkspaceOpenerOptions) {}

  async open(workspacePath: string): Promise<void> {
    const absolutePath = path.resolve(workspacePath);
    const workspaceRoots = resolveWorkspaceRoots(this.options.workspaceRoot);
    if (workspaceRoots.length === 0) {
      throw new SymphonyError("config_validation_error", "No workspace roots configured for Cursor opener");
    }

    let validationError: unknown = null;
    let validated = false;
    for (const workspaceRoot of workspaceRoots) {
      try {
        assertPathInsideRoot(absolutePath, workspaceRoot);
        await assertRealPathInsideRoot(absolutePath, workspaceRoot);
        validated = true;
        break;
      } catch (error) {
        validationError = error;
      }
    }
    if (!validated) {
      throw validationError instanceof Error
        ? validationError
        : new SymphonyError("workspace_error", `Workspace path escapes workspace roots: ${absolutePath}`);
    }

    const command = this.options.openerCommand ?? defaultCursorCommand();
    if (!command) {
      throw new SymphonyError("config_validation_error", "No Cursor opener command configured for this platform");
    }
    await runDetached(command, [absolutePath]);
  }
}

function resolveWorkspaceRoots(source: CursorWorkspaceRootSource): string[] {
  const resolved = typeof source === "function" ? source() : source;
  const values = Array.isArray(resolved) ? resolved : [resolved];
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function defaultCursorCommand(): string | null {
  if (process.platform === "win32") return "cursor.cmd";
  return "cursor";
}

function runDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

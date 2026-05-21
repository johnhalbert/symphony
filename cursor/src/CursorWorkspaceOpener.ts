import { spawn } from "node:child_process";
import path from "node:path";
import { SymphonyError } from "../../src/core/errors.js";
import { assertPathInsideRoot, assertRealPathInsideRoot } from "../../src/core/workspace/WorkspaceManager.js";

export interface CursorWorkspaceOpenerOptions {
  workspaceRoot: string;
  openerCommand: string | null;
}

export class CursorWorkspaceOpener {
  constructor(private readonly options: CursorWorkspaceOpenerOptions) {}

  async open(workspacePath: string): Promise<void> {
    const absolutePath = path.resolve(workspacePath);
    assertPathInsideRoot(absolutePath, this.options.workspaceRoot);
    await assertRealPathInsideRoot(absolutePath, this.options.workspaceRoot);
    const command = this.options.openerCommand ?? defaultCursorCommand();
    if (!command) {
      throw new SymphonyError("config_validation_error", "No Cursor opener command configured for this platform");
    }
    await runDetached(command, [absolutePath]);
  }
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

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
let root: string;

describe("upstream Hermes HERMES_AUTH_HOME patch", () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-hermes-upstream-auth-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("routes auth store and lock paths through HERMES_AUTH_HOME", async () => {
    const profileHome = path.join(root, "profile-home");
    const authHome = path.join(root, "managed-auth");
    const upstreamRoot = path.resolve("hermes/upstream-src");
    const script = [
      "import json",
      "import pathlib",
      "import sys",
      "root = pathlib.Path(sys.argv[1]).resolve()",
      "sys.path.insert(0, str(root))",
      "from hermes_cli import auth",
      "print(json.dumps({'auth': str(auth._auth_file_path()), 'lock': str(auth._auth_lock_path())}))",
    ].join("\n");

    const result = await execFileAsync(process.platform === "win32" ? "python" : "python3", ["-c", script, upstreamRoot], {
      cwd: upstreamRoot,
      env: {
        ...process.env,
        HERMES_HOME: profileHome,
        HERMES_AUTH_HOME: authHome,
        HERMES_PYTHON_SRC_ROOT: upstreamRoot,
      },
    });
    const parsed = JSON.parse(result.stdout.trim()) as { auth: string; lock: string };

    expect(path.normalize(parsed.auth)).toBe(path.join(authHome, "auth.json"));
    expect(path.normalize(parsed.lock)).toBe(path.join(authHome, "auth.lock"));
  });
});

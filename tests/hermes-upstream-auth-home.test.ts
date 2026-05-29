import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("upstream Hermes HERMES_AUTH_HOME patch", () => {
  it("routes auth store and lock paths through HERMES_AUTH_HOME", async () => {
    const source = await readFile(path.resolve("hermes/upstream-src/hermes_cli/auth.py"), "utf8");

    expect(source).toContain('override = os.environ.get("HERMES_AUTH_HOME", "").strip()');
    expect(source).toMatch(/def _auth_home\(\) -> Path:[\s\S]*return Path\(override\)\.expanduser\(\)[\s\S]*return get_hermes_home\(\)/);
    expect(source).toMatch(/def _auth_file_path\(\) -> Path:\s+path = _auth_home\(\) \/ "auth\.json"/);
    expect(source).toMatch(/def _auth_lock_path\(\) -> Path:\s+return _auth_file_path\(\)\.with_suffix\("\.lock"\)/);
    expect(source).toMatch(/if os\.environ\.get\("HERMES_AUTH_HOME", ""\)\.strip\(\):\s+return None/);
  });
});

import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverHostHermes,
  hostHermesCommandEnvironment,
  parseHostHermesActiveProfile,
  type HostHermesCommandRunner,
} from "../hermes/src/HostHermesDiscovery.js";

describe("HostHermesDiscovery", () => {
  it("uses a configured binary and configured source profile without probing the active profile", async () => {
    const cwd = path.join(path.sep, "workspace");
    const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const runner: HostHermesCommandRunner = async (file, args, options) => {
      calls.push({ file, args: [...args], env: options.env });
      return { stdout: "Hermes 1.2.3\n", stderr: "" };
    };

    const result = await discoverHostHermes({
      binaryPath: "./bin/hermes",
      sourceProfile: "host-coder",
      cwd,
      env: { PATH: "/usr/bin", HERMES_HOME: "/vendored/hermes", HERMES_MODEL: "vendored-model" },
      runner,
    });

    expect(result).toMatchObject({
      ok: true,
      binary: {
        path: path.resolve(cwd, "./bin/hermes"),
        source: "config",
        versionText: "Hermes 1.2.3",
      },
      sourceProfile: {
        name: "host-coder",
        source: "config",
      },
      diagnostics: [],
    });
    expect(calls.map((call) => call.args)).toEqual([["--version"]]);
    expect(calls[0]?.env.HERMES_HOME).toBeUndefined();
    expect(calls[0]?.env.HERMES_MODEL).toBeUndefined();
  });

  it("finds the host hermes executable on PATH and falls back to the active host profile", async () => {
    const firstDir = path.join(path.sep, "missing-bin");
    const secondDir = path.join(path.sep, "host-bin");
    const expectedBinary = path.resolve(secondDir, "hermes");
    const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const runner: HostHermesCommandRunner = async (file, args, options) => {
      calls.push({ file, args: [...args], env: options.env });
      if (args[0] === "--version") return { stdout: "Hermes 2.0.0\n", stderr: "" };
      return {
        stdout: "\u001b[32m  Profile: host-active\u001b[0m\n  Home:    /home/user/.hermes/profiles/host-active\n",
        stderr: "",
      };
    };

    const result = await discoverHostHermes({
      env: {
        PATH: `${firstDir}${path.delimiter}${secondDir}`,
        HERMES_HOME: "/vendored/home",
        HERMES_AUTH_HOME: "/vendored/auth",
        HERMES_PYTHON_SRC_ROOT: "/vendored/src",
        PYTHONPATH: "/vendored/pythonpath",
        HERMES_MODEL: "vendored-model",
        HERMES_TUI_PROVIDER: "vendored-provider",
        KEEP_ME: "host-value",
      },
      runner,
      accessFile: async (candidatePath) => candidatePath === expectedBinary,
      platform: process.platform,
    });

    expect(result.ok).toBe(true);
    expect(result.binary).toMatchObject({ path: expectedBinary, source: "path", versionText: "Hermes 2.0.0" });
    expect(result.sourceProfile).toEqual({ name: "host-active", source: "active" });
    expect(calls.map((call) => call.args)).toEqual([["--version"], ["profile"]]);
    expect(calls.every((call) => call.file === expectedBinary)).toBe(true);
    expect(calls[0]?.env.KEEP_ME).toBe("host-value");
    for (const vendoredKey of [
      "HERMES_HOME",
      "HERMES_AUTH_HOME",
      "HERMES_PYTHON_SRC_ROOT",
      "PYTHONPATH",
      "HERMES_MODEL",
      "HERMES_TUI_PROVIDER",
    ]) {
      expect(calls[0]?.env[vendoredKey]).toBeUndefined();
    }
  });

  it("returns an actionable diagnostic when no host hermes binary is available", async () => {
    let runnerCalled = false;
    const result = await discoverHostHermes({
      sourceProfile: "configured-profile",
      env: { PATH: path.join(path.sep, "empty-bin") },
      accessFile: async () => false,
      runner: async () => {
        runnerCalled = true;
        return { stdout: "", stderr: "" };
      },
      platform: process.platform,
    });

    expect(runnerCalled).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.binary).toBeNull();
    expect(result.sourceProfile).toEqual({ name: "configured-profile", source: "config" });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "host_hermes_binary_missing",
        severity: "error",
        message: expect.stringContaining("Host Hermes executable was not found"),
      }),
    ]);
  });

  it("surfaces an unparseable active-profile probe as a typed diagnostic", async () => {
    const hostDir = path.join(path.sep, "host-bin");
    const expectedBinary = path.resolve(hostDir, "hermes");
    const result = await discoverHostHermes({
      env: { PATH: hostDir },
      accessFile: async (candidatePath) => candidatePath === expectedBinary,
      runner: async (_file, args) => {
        if (args[0] === "--version") return { stdout: "Hermes 2.0.0\n", stderr: "" };
        return { stdout: "Profile table without an active-profile line\n", stderr: "" };
      },
      platform: process.platform,
    });

    expect(result.ok).toBe(false);
    expect(result.binary).toMatchObject({ path: expectedBinary, source: "path" });
    expect(result.sourceProfile).toBeNull();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "host_hermes_active_profile_unparseable",
        severity: "error",
      }),
    ]);
  });

  it("preserves failed version probe output in a typed diagnostic", async () => {
    const result = await discoverHostHermes({
      binaryPath: "hermes",
      sourceProfile: "configured-profile",
      runner: async () => ({ stdout: "", stderr: "version boom\n", exitCode: 2 }),
    });

    expect(result.ok).toBe(false);
    expect(result.binary).toMatchObject({ path: "hermes", source: "config", versionText: "version boom" });
    expect(result.sourceProfile).toEqual({ name: "configured-profile", source: "config" });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "host_hermes_version_probe_failed",
        severity: "error",
        details: expect.objectContaining({ output: "version boom", exitCode: 2 }),
      }),
    ]);
  });

  it("strips vendored Hermes environment variables before host command execution", () => {
    const env = hostHermesCommandEnvironment({
      PATH: "/usr/bin",
      HERMES_HOME: "/vendored/home",
      hermes_auth_home: "/vendored/auth",
      HERMES_PYTHON_SRC_ROOT: "/vendored/src",
      PYTHONPATH: "/vendored/pythonpath",
      HERMES_MODEL: "vendored-model",
      HERMES_TUI_PROVIDER: "vendored-provider",
      KEEP_ME: "host-value",
    });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.KEEP_ME).toBe("host-value");
    expect(Object.keys(env).map((key) => key.toLowerCase())).not.toEqual(expect.arrayContaining(["hermes_home", "hermes_auth_home"]));
    expect(env.HERMES_PYTHON_SRC_ROOT).toBeUndefined();
    expect(env.PYTHONPATH).toBeUndefined();
    expect(env.HERMES_MODEL).toBeUndefined();
    expect(env.HERMES_TUI_PROVIDER).toBeUndefined();
  });

  it("parses the active host Hermes profile from the plain `hermes profile` output", () => {
    expect(parseHostHermesActiveProfile("\n  Profile: default\n  Home:    ~/.hermes\n")).toBe("default");
    expect(parseHostHermesActiveProfile("\u001b[36mActive profile: dogfood_worker\u001b[0m\n")).toBe("dogfood_worker");
    expect(parseHostHermesActiveProfile("No active profile line\n")).toBeNull();
  });
});

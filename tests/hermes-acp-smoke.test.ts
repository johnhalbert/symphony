import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildHermesAcpSmokeCommandPlan,
  buildHermesAcpSmokeProfileName,
  isDirectRun,
} from "../scripts/hermes-acp-smoke.js";

describe("Hermes ACP smoke command construction", () => {
  it("builds the required opt-in host Hermes ACP command sequence against a disposable clone", () => {
    const plan = buildHermesAcpSmokeCommandPlan({
      binaryPath: "/host/bin/hermes",
      sourceProfile: "operator-source",
      profileName: "symphony-smoke-123",
      cwd: "/repo/workspace",
      env: {
        PATH: "/bin",
        HERMES_HOME: "/tmp/vendored-home",
        HERMES_AUTH_HOME: "/tmp/managed-auth",
        HERMES_PYTHON_SRC_ROOT: "/tmp/vendored-src",
        HERMES_MODEL: "wrong-model",
        HERMES_TUI_PROVIDER: "wrong-provider",
        PYTHONPATH: "/tmp/pythonpath",
      },
    });

    expect(plan.version).toMatchObject({ file: "/host/bin/hermes", args: ["--version"], cwd: "/repo/workspace" });
    expect(plan.activeProfile.args).toEqual(["profile"]);
    expect(plan.hostAcpCheck.args).toEqual(["acp", "--check"]);
    expect(plan.sourceProfileAcpCheck.args).toEqual(["-p", "operator-source", "acp", "--check"]);
    expect(plan.createProfile.args).toEqual([
      "profile",
      "create",
      "symphony-smoke-123",
      "--clone",
      "--clone-from",
      "operator-source",
      "--no-alias",
    ]);
    expect(plan.clonedAcpCheck.args).toEqual(["-p", "symphony-smoke-123", "acp", "--check"]);
    expect(plan.launch).toMatchObject({ file: "/host/bin/hermes", args: ["-p", "symphony-smoke-123", "acp"], cwd: "/repo/workspace" });
    expect(plan.deleteProfile.args).toEqual(["profile", "delete", "symphony-smoke-123", "--yes"]);

    for (const entry of [
      plan.version,
      plan.activeProfile,
      plan.hostAcpCheck,
      plan.sourceProfileAcpCheck,
      plan.createProfile,
      plan.clonedAcpCheck,
      plan.launch,
      plan.deleteProfile,
    ]) {
      expect(entry.env).not.toHaveProperty("HERMES_HOME");
      expect(entry.env).not.toHaveProperty("HERMES_AUTH_HOME");
      expect(entry.env).not.toHaveProperty("HERMES_PYTHON_SRC_ROOT");
      expect(entry.env).not.toHaveProperty("HERMES_MODEL");
      expect(entry.env).not.toHaveProperty("HERMES_TUI_PROVIDER");
      expect(entry.env).not.toHaveProperty("PYTHONPATH");
      expect(entry.env.PATH).toBe("/bin");
    }
  });

  it("refuses to run the prompt smoke against the source profile itself", () => {
    expect(() =>
      buildHermesAcpSmokeCommandPlan({
        binaryPath: "/host/bin/hermes",
        sourceProfile: "default",
        profileName: "default",
        cwd: "/repo/workspace",
      }),
    ).toThrow("Host Hermes ACP smoke profile name must differ from the source profile");
  });

  it("generates normalized disposable profile names", () => {
    expect(buildHermesAcpSmokeProfileName({ prefix: "Smoke Prefix", runId: "RUN/123" })).toBe("smoke-prefix-run-123-f8fbe5c8cc");
  });

  it("does not treat test imports as direct CLI execution", () => {
    const scriptPath = path.resolve("scripts/hermes-acp-smoke.ts");
    const testPath = path.resolve("tests/hermes-acp-smoke.test.ts");
    const scriptUrl = pathToFileURL(scriptPath).href;
    expect(isDirectRun(scriptUrl, ["node", testPath])).toBe(false);
    expect(isDirectRun(scriptUrl, ["node", scriptPath])).toBe(true);
  });
});

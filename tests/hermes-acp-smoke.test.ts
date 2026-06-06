import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { ServiceConfig } from "../src/core/config/Config.js";
import {
  buildHermesAcpSmokeCommandPlan,
  buildHermesAcpSmokeProfileName,
  buildHermesAcpSmokeSuccessReport,
  contextualizeHermesAcpSmokeError,
  formatHermesAcpSmokeSkipReport,
  isDirectRun,
  resolveHermesAcpSmokeHostSettings,
  resolveHermesAcpSmokeProfileName,
  runRequiredSmokeCommand,
} from "../scripts/hermes-acp-smoke.js";

function serviceConfig(hermesAcp: Partial<ServiceConfig["hermesAcp"]> = {}): ServiceConfig {
  return {
    hermesAcp: {
      binaryPath: null,
      sourceProfile: null,
      profilePrefix: "symphony",
      workerSessionLifecycle: "reuse_by_issue",
      keepProfiles: "failed",
      startupTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
      permissionTimeoutMs: 1_000,
      ...hermesAcp,
    },
  } as ServiceConfig;
}

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

  it("uses canonical hermes_acp.profile_prefix when no CLI prefix is supplied", () => {
    const name = resolveHermesAcpSmokeProfileName(
      serviceConfig({ profilePrefix: "Configured Smoke Prefix" }),
      {},
      "operator-source",
    );

    expect(name).toMatch(/^configured-smoke-prefix-/);
  });

  it("lets CLI profile-prefix override the configured hermes_acp.profile_prefix", () => {
    const name = resolveHermesAcpSmokeProfileName(
      serviceConfig({ profilePrefix: "Configured Smoke Prefix" }),
      { profilePrefix: "CLI Smoke Prefix" },
      "operator-source",
    );

    expect(name).toMatch(/^cli-smoke-prefix-/);
  });

  it("lets explicit profile-name override generated profile prefixes", () => {
    const name = resolveHermesAcpSmokeProfileName(
      serviceConfig({ profilePrefix: "Configured Smoke Prefix" }),
      { profileName: "explicit-smoke-profile", profilePrefix: "CLI Smoke Prefix" },
      "operator-source",
    );

    expect(name).toMatch(/^explicit-smoke-profile-/);
    expect(name).not.toMatch(/^cli-smoke-prefix-/);
  });

  it("returns an actionable skip report instead of throwing when host Hermes is missing from PATH", async () => {
    const resolution = await resolveHermesAcpSmokeHostSettings(serviceConfig(), "/repo/workspace", 1_000, {}, {
      env: { PATH: "" },
      discoverHost: async () => ({
        ok: false,
        binary: null,
        sourceProfile: null,
        diagnostics: [
          {
            code: "host_hermes_binary_missing",
            severity: "error",
            message: "Host Hermes executable was not found on PATH. Configure `hermes_acp.binary_path` before enabling the smoke.",
          },
        ],
      }),
    });

    expect(resolution.status).toBe("skipped");
    if (resolution.status !== "skipped") throw new Error("expected skipped smoke resolution");
    expect(resolution.hostHermesBinary).toBe("hermes (PATH lookup)");
    expect(resolution.hostHermesBinarySource).toBe("path");
    expect(resolution.cloneProfileState).toBe("not_yet_allocated");
    expect(resolution.message).toContain("Host Hermes ACP smoke skipped");
    const rendered = formatHermesAcpSmokeSkipReport(resolution);
    expect(rendered).toContain("[smoke:hermes-acp] SKIPPED");
    expect(rendered).toContain("host_hermes_binary_missing");
    expect(rendered).toContain("clone profile: not yet allocated");
    expect(rendered).toContain("stderr tail: not captured; host Hermes command plan was not created");
  });

  it("returns an actionable skip report instead of throwing when a configured host Hermes binary is missing", async () => {
    const resolution = await resolveHermesAcpSmokeHostSettings(
      serviceConfig({ binaryPath: "/missing/hermes", sourceProfile: "operator-source" }),
      "/repo/workspace",
      1_000,
      {},
      {
        discoverHost: async (options) => {
          expect(options?.binaryPath).toBe("/missing/hermes");
          expect(options?.sourceProfile).toBe("operator-source");
          return {
            ok: false,
            binary: null,
            sourceProfile: { name: "operator-source", source: "config" },
            diagnostics: [
              {
                code: "host_hermes_binary_missing",
                severity: "error",
                message: "Configured host Hermes ACP binary /missing/hermes does not exist or is not executable.",
              },
            ],
          };
        },
      },
    );

    expect(resolution.status).toBe("skipped");
    if (resolution.status !== "skipped") throw new Error("expected skipped smoke resolution");
    expect(resolution.hostHermesBinary).toBe("/missing/hermes");
    expect(resolution.hostHermesBinarySource).toBe("config");
    expect(resolution.sourceProfile).toBe("operator-source");
    expect(formatHermesAcpSmokeSkipReport(resolution)).toContain("Configured host Hermes ACP binary /missing/hermes");
  });

  it("returns an actionable skip report when no source profile can be discovered", async () => {
    const resolution = await resolveHermesAcpSmokeHostSettings(serviceConfig(), "/repo/workspace", 1_000, {}, {
      discoverHost: async () => ({
        ok: false,
        binary: { path: "/host/bin/hermes", source: "path", versionText: "hermes 1.0.0" },
        sourceProfile: null,
        diagnostics: [
          {
            code: "host_hermes_active_profile_probe_failed",
            severity: "error",
            message: "Configure `hermes_acp.source_profile` explicitly or fix the host Hermes profile store.",
          },
        ],
      }),
    });

    expect(resolution.status).toBe("skipped");
    if (resolution.status !== "skipped") throw new Error("expected skipped smoke resolution");
    expect(resolution.hostHermesBinary).toBe("/host/bin/hermes");
    expect(resolution.sourceProfile).toBeNull();
    expect(resolution.sourceProfileSource).toBe("active");
    expect(formatHermesAcpSmokeSkipReport(resolution)).toContain("host_hermes_active_profile_probe_failed");
  });

  it.each([
    "host Hermes active ACP check",
    "host Hermes source profile ACP check",
    "host Hermes disposable ACP profile clone",
    "host Hermes disposable ACP profile check",
    "host Hermes disposable ACP profile delete",
    "host Hermes disposable ACP profile cleanup",
  ])("includes required context and bounded stderr tail for %s failures", async (phase) => {
    const stderr = Array.from({ length: 40 }, (_, index) => `stderr-${index + 1}`).join("\n");
    let caught: unknown;
    try {
      await runRequiredSmokeCommand(
        { label: phase, file: "/host/bin/hermes", args: ["acp", "--check"], cwd: "/repo/workspace", env: {} },
        async () => ({ exitCode: 2, stdout: "stdout-ok", stderr }),
        1_000,
        {
          phase,
          hostHermesBinary: "/host/bin/hermes",
          hostHermesBinarySource: "config",
          sourceProfile: "operator-source",
          sourceProfileSource: "config",
          cloneProfile: "symphony-smoke-123",
        },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain(`ACP phase: ${phase}`);
    expect(message).toContain("host Hermes binary: /host/bin/hermes");
    expect(message).toContain("host Hermes binary source: config");
    expect(message).toContain("source profile: operator-source");
    expect(message).toContain("source profile source: config");
    expect(message).toContain("clone profile: symphony-smoke-123");
    expect(message).toContain("stderr tail:");
    expect(message).toContain("stderr-40");
    expect(message.split("\n")).not.toContain("stderr-1");
  });

  it.each(["host Hermes ACP launch/session/prompt", "host Hermes active profile stability verification"])(
    "formats %s failures with required context",
    (phase) => {
      const error = contextualizeHermesAcpSmokeError(new Error("simulated failure"), {
        phase,
        hostHermesBinary: "/host/bin/hermes",
        hostHermesBinarySource: "path",
        sourceProfile: "operator-source",
        sourceProfileSource: "active",
        cloneProfile: "symphony-smoke-123",
        stderrTail: "last stderr line",
      });

      expect(error.message).toContain("simulated failure");
      expect(error.message).toContain(`ACP phase: ${phase}`);
      expect(error.message).toContain("host Hermes binary: /host/bin/hermes");
      expect(error.message).toContain("source profile: operator-source");
      expect(error.message).toContain("clone profile: symphony-smoke-123");
      expect(error.message).toContain("stderr tail: last stderr line");
    },
  );

  it("builds the operator-facing success report with emitted ACP response text evidence", () => {
    const report = buildHermesAcpSmokeSuccessReport({
      workflowPath: "/repo/WORKFLOW.md",
      configuredHarness: "hermes_acp",
      hostHermesBinary: "/host/bin/hermes",
      hostHermesBinarySource: "config",
      sourceProfile: "operator-source",
      sourceProfileSource: "config",
      disposableProfile: "symphony-smoke-123",
      disposableProfileDeleted: true,
      activeProfileUnchanged: true,
      expectedText: "Symphony Hermes ACP smoke OK",
      promptResult: {
        sessionId: "prompt-session-123",
        responseText: "Symphony Hermes ACP smoke OK\nwith extra confirmation",
        stopReason: "end_turn",
        diagnosticCount: 0,
        updateCount: 2,
      },
      tempRoot: null,
    });

    expect(report).toMatchObject({
      workflowPath: "/repo/WORKFLOW.md",
      configuredHarness: "hermes_acp",
      hostHermesBinary: "/host/bin/hermes",
      hostHermesBinarySource: "config",
      sourceProfile: "operator-source",
      sourceProfileSource: "config",
      disposableProfile: "symphony-smoke-123",
      disposableProfileDeleted: true,
      activeProfileUnchanged: true,
      promptExpectedText: "Symphony Hermes ACP smoke OK",
      promptResponseText: "Symphony Hermes ACP smoke OK with extra confirmation",
      promptSessionId: "prompt-session-123",
      promptStopReason: "end_turn",
      promptDiagnosticCount: 0,
      promptUpdateCount: 2,
    });
    expect(report).not.toHaveProperty("tempRoot");
  });

  it("does not treat test imports as direct CLI execution", () => {
    const scriptPath = path.resolve("scripts/hermes-acp-smoke.ts");
    const testPath = path.resolve("tests/hermes-acp-smoke.test.ts");
    const scriptUrl = pathToFileURL(scriptPath).href;
    expect(isDirectRun(scriptUrl, ["node", testPath])).toBe(false);
    expect(isDirectRun(scriptUrl, ["node", scriptPath])).toBe(true);
  });
});

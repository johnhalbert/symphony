import { describe, expect, it } from "vitest";
import {
  buildHostHermesAcpCreateProfileArgs,
  buildHostHermesAcpDeleteProfileArgs,
  buildHostHermesAcpLaunchArgs,
  buildHostHermesAcpProfileName,
  createHostHermesAcpProfileLease,
  hostHermesAcpCommandEnvironment,
  normalizeHostHermesAcpProfileName,
  parseHostHermesAcpActiveProfile,
  shouldDeleteHostHermesAcpProfile,
  type HostHermesAcpCommandOptions,
  type HostHermesAcpCommandResult,
} from "../hermes/src/HostHermesAcpProfileLease.js";

interface RecordedCommand {
  file: string;
  args: readonly string[];
  options: HostHermesAcpCommandOptions;
}

function commandRecorder(results: HostHermesAcpCommandResult[] | ((command: RecordedCommand) => HostHermesAcpCommandResult)) {
  const calls: RecordedCommand[] = [];
  const runner = async (
    file: string,
    args: readonly string[],
    options: HostHermesAcpCommandOptions,
  ): Promise<HostHermesAcpCommandResult> => {
    const command = { file, args: [...args], options: { ...options, env: { ...options.env } } };
    calls.push(command);
    if (typeof results === "function") return results(command);
    return results.shift() ?? { stdout: "", stderr: "", exitCode: 0 };
  };
  return { calls, runner };
}

describe("HostHermesAcpProfileLease", () => {
  it("generates deterministic Hermes-safe lower-case profile names within the Hermes limit", () => {
    const input = {
      workspaceKey: "Team/Workspace With Spaces",
      issueIdentifier: "ENG-137",
      role: "Worker",
      phase: "Implementation",
      attempt: 12,
      runId: `Run:${"x".repeat(120)}`,
    };

    const profileName = buildHostHermesAcpProfileName(input);

    expect(profileName).toBe(buildHostHermesAcpProfileName(input));
    expect(profileName.length).toBeLessThanOrEqual(64);
    expect(profileName).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
    expect(profileName).not.toBe("default");
  });

  it("avoids reserved profile names and detectable host command collisions", () => {
    const defaultSafeName = normalizeHostHermesAcpProfileName("default");
    const commandCollisionName = normalizeHostHermesAcpProfileName("node");

    expect(defaultSafeName).not.toBe("default");
    expect(normalizeHostHermesAcpProfileName("node", { reservedNames: [commandCollisionName] })).not.toBe(
      commandCollisionName,
    );
  });

  it("constructs create, launch, and delete commands for host Hermes ACP", () => {
    expect(buildHostHermesAcpCreateProfileArgs("run-profile", "host-profile")).toEqual([
      "profile",
      "create",
      "run-profile",
      "--clone",
      "--clone-from",
      "host-profile",
      "--no-alias",
    ]);
    expect(buildHostHermesAcpLaunchArgs("run-profile")).toEqual(["-p", "run-profile", "acp"]);
    expect(buildHostHermesAcpDeleteProfileArgs("run-profile")).toEqual(["profile", "delete", "run-profile", "--yes"]);
  });

  it("removes vendored Hermes env vars while preserving unrelated host env", () => {
    const env = hostHermesAcpCommandEnvironment({
      HERMES_HOME: "/vendored/home",
      hermes_auth_home: "/vendored/auth",
      HERMES_PYTHON_SRC_ROOT: "/vendored/src",
      PYTHONPATH: "/vendored/python",
      HERMES_MODEL: "model-from-vendored-profile",
      HERMES_TUI_PROVIDER: "provider-from-vendored-profile",
      PATH: "/usr/bin",
      CUSTOM_ENV: "kept",
    });

    expect(Object.keys(env).map((key) => key.toLowerCase())).not.toContain("hermes_home");
    expect(Object.keys(env).map((key) => key.toLowerCase())).not.toContain("hermes_auth_home");
    expect(Object.keys(env).map((key) => key.toLowerCase())).not.toContain("hermes_python_src_root");
    expect(env.PYTHONPATH).toBeUndefined();
    expect(env.HERMES_MODEL).toBeUndefined();
    expect(env.HERMES_TUI_PROVIDER).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.CUSTOM_ENV).toBe("kept");
  });

  it("creates a cloned profile, exposes the ACP launch command, and deletes disposable success profiles", async () => {
    const { calls, runner } = commandRecorder([{ stdout: "", stderr: "", exitCode: 0 }]);

    const lease = await createHostHermesAcpProfileLease({
      binaryPath: "/usr/local/bin/hermes",
      cwd: "/workspace",
      env: { PATH: "/usr/local/bin", HERMES_HOME: "/vendored" },
      profileName: "ENG-137 Worker Implementation",
      sourceProfile: "operator",
      runner,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe("/usr/local/bin/hermes");
    expect(calls[0]?.args).toEqual([
      "profile",
      "create",
      lease.profileName,
      "--clone",
      "--clone-from",
      "operator",
      "--no-alias",
    ]);
    expect(calls[0]?.options.env.HERMES_HOME).toBeUndefined();
    expect(lease.acpCommand).toMatchObject({
      file: "/usr/local/bin/hermes",
      args: ["-p", lease.profileName, "acp"],
      cwd: "/workspace",
    });
    expect(lease.acpCommand.env.HERMES_HOME).toBeUndefined();

    await expect(lease.dispose("succeeded")).resolves.toEqual({
      profileName: lease.profileName,
      reason: "deleted",
      deleted: true,
    });
    expect(calls[1]?.args).toEqual(["profile", "delete", lease.profileName, "--yes"]);
  });

  it("defaults source profile to active host Hermes profile and preserves failed-run profiles by default", async () => {
    const { calls, runner } = commandRecorder([
      { stdout: "\nActive profile: host-default\nPath: /home/me/.hermes\n", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
    ]);

    const lease = await createHostHermesAcpProfileLease({
      binaryPath: "hermes",
      cwd: "/workspace",
      profileName: "worker-run",
      runner,
    });

    expect(lease.sourceProfile).toBe("host-default");
    expect(calls[0]?.args).toEqual(["profile"]);
    expect(calls[1]?.args).toEqual([
      "profile",
      "create",
      lease.profileName,
      "--clone",
      "--clone-from",
      "host-default",
      "--no-alias",
    ]);
    await expect(lease.dispose("failed")).resolves.toEqual({
      profileName: lease.profileName,
      reason: "retained",
      deleted: false,
    });
    expect(calls).toHaveLength(2);
  });

  it("reuses an expected already-existing profile without deleting it as a disposable clone", async () => {
    const expectedProfileName = normalizeHostHermesAcpProfileName("worker-run");
    const { calls, runner } = commandRecorder([
      { stdout: "", stderr: `Profile '${expectedProfileName}' already exists.`, exitCode: 2 },
    ]);

    const lease = await createHostHermesAcpProfileLease({
      binaryPath: "hermes",
      cwd: "/workspace",
      profileName: "worker-run",
      sourceProfile: "operator",
      keepProfiles: "never",
      runner,
    });

    expect(lease.profileName).toBe(expectedProfileName);
    expect(calls.map((call) => call.args)).toEqual([
      ["profile", "create", expectedProfileName, "--clone", "--clone-from", "operator", "--no-alias"],
    ]);
    await expect(lease.dispose("succeeded")).resolves.toEqual({
      profileName: expectedProfileName,
      reason: "retained",
      deleted: false,
    });
    await expect(lease.dispose("succeeded")).resolves.toEqual({
      profileName: expectedProfileName,
      reason: "already_disposed",
      deleted: false,
    });
    expect(calls).toHaveLength(1);
  });

  it("rejects non-reusable profile create failures with command, exit code, and stderr diagnostics", async () => {
    const expectedProfileName = normalizeHostHermesAcpProfileName("worker-run");
    const { runner } = commandRecorder([
      { stdout: "", stderr: "Profile 'someone-else' already exists.", exitCode: 17 },
    ]);

    await expect(
      createHostHermesAcpProfileLease({
        binaryPath: "hermes",
        cwd: "/workspace",
        profileName: "worker-run",
        sourceProfile: "operator",
        runner,
      }),
    ).rejects.toThrow(
      new RegExp(
        `Host Hermes command failed with exit code 17: hermes profile create ${expectedProfileName} --clone --clone-from operator --no-alias.*someone-else`,
        "s",
      ),
    );
  });

  it("protects a configured source profile that matches the resolved lease profile from create and delete", async () => {
    const expectedProfileName = normalizeHostHermesAcpProfileName("worker-run");
    const { calls, runner } = commandRecorder([]);

    const lease = await createHostHermesAcpProfileLease({
      binaryPath: "hermes",
      cwd: "/workspace",
      profileName: "worker-run",
      sourceProfile: expectedProfileName,
      keepProfiles: "never",
      runner,
    });

    expect(lease.profileName).toBe(expectedProfileName);
    expect(lease.sourceProfile).toBe(expectedProfileName);
    expect(calls).toHaveLength(0);
    await expect(lease.dispose("succeeded")).resolves.toEqual({
      profileName: expectedProfileName,
      reason: "retained",
      deleted: false,
    });
    expect(calls).toHaveLength(0);
  });

  it("protects an active source profile that matches the resolved lease profile from clone and delete", async () => {
    const expectedProfileName = normalizeHostHermesAcpProfileName("active-worker-run");
    const { calls, runner } = commandRecorder([
      { stdout: `\nActive profile: ${expectedProfileName}\nPath: /home/me/.hermes\n`, stderr: "", exitCode: 0 },
    ]);

    const lease = await createHostHermesAcpProfileLease({
      binaryPath: "hermes",
      cwd: "/workspace",
      profileName: "active-worker-run",
      keepProfiles: "never",
      runner,
    });

    expect(lease.profileName).toBe(expectedProfileName);
    expect(lease.sourceProfile).toBe(expectedProfileName);
    expect(calls.map((call) => call.args)).toEqual([["profile"]]);
    await expect(lease.dispose("succeeded")).resolves.toEqual({
      profileName: expectedProfileName,
      reason: "retained",
      deleted: false,
    });
    expect(calls.map((call) => call.args)).toEqual([["profile"]]);
  });

  it("makes disposal idempotent after the first cleanup action", async () => {
    const { calls, runner } = commandRecorder([
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
    ]);

    const lease = await createHostHermesAcpProfileLease({
      binaryPath: "hermes",
      cwd: "/workspace",
      profileName: "worker-run",
      sourceProfile: "operator",
      keepProfiles: "never",
      runner,
    });

    await expect(lease.dispose("failed")).resolves.toMatchObject({ reason: "deleted", deleted: true });
    await expect(lease.dispose("failed")).resolves.toEqual({
      profileName: lease.profileName,
      reason: "already_disposed",
      deleted: false,
    });
    expect(calls.map((call) => call.args)).toEqual([
      ["profile", "create", lease.profileName, "--clone", "--clone-from", "operator", "--no-alias"],
      ["profile", "delete", lease.profileName, "--yes"],
    ]);
  });

  it("keeps failed profile deletion retryable until cleanup succeeds", async () => {
    const { calls, runner } = commandRecorder([
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "delete failed", exitCode: 23 },
      { stdout: "", stderr: "", exitCode: 0 },
    ]);

    const lease = await createHostHermesAcpProfileLease({
      binaryPath: "hermes",
      cwd: "/workspace",
      profileName: "worker-run",
      sourceProfile: "operator",
      keepProfiles: "never",
      runner,
    });

    await expect(lease.dispose("succeeded")).rejects.toThrow(/delete failed/);
    await expect(lease.dispose("succeeded")).resolves.toEqual({
      profileName: lease.profileName,
      reason: "deleted",
      deleted: true,
    });
    await expect(lease.dispose("succeeded")).resolves.toEqual({
      profileName: lease.profileName,
      reason: "already_disposed",
      deleted: false,
    });
    expect(calls.map((call) => call.args)).toEqual([
      ["profile", "create", lease.profileName, "--clone", "--clone-from", "operator", "--no-alias"],
      ["profile", "delete", lease.profileName, "--yes"],
      ["profile", "delete", lease.profileName, "--yes"],
    ]);
  });

  it("treats interrupted profile create commands as failures", async () => {
    const { runner } = commandRecorder([{ stdout: "", stderr: "terminated", exitCode: null }]);

    await expect(
      createHostHermesAcpProfileLease({
        binaryPath: "hermes",
        cwd: "/workspace",
        profileName: "worker-run",
        sourceProfile: "operator",
        runner,
      }),
    ).rejects.toThrow(/without an exit code.*terminated/s);
  });

  it("parses active profile output and applies retention policy boundaries", () => {
    expect(parseHostHermesAcpActiveProfile("\u001b[32mActive profile: work\u001b[0m\nPath: /tmp")).toBe("work");
    expect(parseHostHermesAcpActiveProfile("Path only")).toBeNull();
    expect(shouldDeleteHostHermesAcpProfile({ keepProfiles: "failed", terminalStatus: "failed" })).toBe(false);
    expect(shouldDeleteHostHermesAcpProfile({ keepProfiles: "failed", terminalStatus: "succeeded" })).toBe(true);
    expect(shouldDeleteHostHermesAcpProfile({ keepProfiles: "always", terminalStatus: "succeeded" })).toBe(false);
    expect(shouldDeleteHostHermesAcpProfile({ keepProfiles: "never", terminalStatus: "failed" })).toBe(true);
  });
});

#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { errorMessage } from "../src/core/errors.js";
import type { ServiceConfig } from "../src/core/config/Config.js";
import { WorkflowLoader } from "../src/core/workflow/WorkflowLoader.js";
import { redactTranscriptText, sanitizedPreviewValue } from "../src/core/transcript/TranscriptProjection.js";
import {
  discoverHostHermes,
  hostHermesCommandEnvironment,
  parseHostHermesActiveProfile,
  type HostHermesDiscoveryResult,
} from "../hermes/src/HostHermesDiscovery.js";
import {
  buildHostHermesAcpCreateProfileArgs,
  buildHostHermesAcpDeleteProfileArgs,
  buildHostHermesAcpLaunchCommand,
  hostHermesAcpCommandEnvironment,
  normalizeHostHermesAcpProfileName,
  type HostHermesAcpCommandOptions,
  type HostHermesAcpCommandResult,
  type HostHermesAcpCommandRunner,
  type HostHermesAcpProcessCommand,
} from "../hermes/src/HostHermesAcpProfileLease.js";
import { HostHermesAcpStdioJsonRpcFacade, type HostHermesAcpDiagnostic } from "../hermes/src/HostHermesAcpFacade.js";

const DEFAULT_EXPECTED_TEXT = "Symphony Hermes ACP smoke OK";
const DEFAULT_PROFILE_PREFIX = "symphony-smoke";
const TERMINAL_SETUP_AUTH_METHOD_ID = "hermes-setup";

export interface RawOptions {
  binaryPath?: string;
  sourceProfile?: string;
  profileName?: string;
  profilePrefix?: string;
  expect?: string;
  timeoutMs?: string;
  keepProfile?: boolean;
  keepTemp?: boolean;
}

export interface HermesAcpSmokeCommandPlanEntry {
  label: string;
  file: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface HermesAcpSmokeCommandPlan {
  version: HermesAcpSmokeCommandPlanEntry;
  activeProfile: HermesAcpSmokeCommandPlanEntry;
  hostAcpCheck: HermesAcpSmokeCommandPlanEntry;
  sourceProfileAcpCheck: HermesAcpSmokeCommandPlanEntry;
  createProfile: HermesAcpSmokeCommandPlanEntry;
  clonedAcpCheck: HermesAcpSmokeCommandPlanEntry;
  launch: HostHermesAcpProcessCommand;
  deleteProfile: HermesAcpSmokeCommandPlanEntry;
}

export interface HermesAcpPromptSmokeResult {
  sessionId: string;
  responseText: string;
  stopReason: string | null;
  diagnosticCount: number;
  updateCount: number;
}

export interface HermesAcpSmokeHostSettings {
  binaryPath: string;
  sourceProfile: string;
  discovery: HostHermesDiscoveryResult;
}

const program = new Command()
  .name("hermes-acp-smoke")
  .description(
    "Run an opt-in live smoke for host Hermes ACP without touching Linear, GitHub, tracked files, or vendored Hermes auth state",
  )
  .argument("[workflow]", "path to WORKFLOW.md", "WORKFLOW.md")
  .option("--binary-path <path>", "explicit host Hermes executable to use instead of hermes.acp_binary_path or PATH")
  .option("--source-profile <name>", "host Hermes source profile to clone instead of hermes.acp_source_profile or the active profile")
  .option("--profile-name <name>", "explicit disposable smoke profile name; must not already exist")
  .option("--profile-prefix <prefix>", "prefix for generated disposable smoke profile names", DEFAULT_PROFILE_PREFIX)
  .option("--expect <text>", "text that must appear in the ACP prompt response", DEFAULT_EXPECTED_TEXT)
  .option("--timeout-ms <ms>", "per-command and ACP request timeout", "120000")
  .option("--keep-profile", "leave the disposable cloned profile on disk for troubleshooting", false)
  .option("--keep-temp", "leave the temporary smoke workspace on disk for inspection", false);

export async function main(workflow: string, rawOptions: RawOptions): Promise<void> {
  const workflowPath = path.resolve(process.cwd(), workflow);
  const timeoutMs = parsePositiveInt(rawOptions.timeoutMs ?? "120000", "--timeout-ms");
  const expectedText = rawOptions.expect ?? DEFAULT_EXPECTED_TEXT;
  const loader = new WorkflowLoader(workflowPath);
  let tempRoot: string | null = null;
  let profileCreated = false;
  let profileDeleted = false;
  let cleanupError: unknown = null;
  let plan: HermesAcpSmokeCommandPlan | null = null;
  let primaryError: unknown = null;

  try {
    const loaded = await loader.load();
    const config = loaded.serviceConfig;
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-hermes-acp-smoke-"));
    const smokeWorkspace = path.join(tempRoot, "workspace");
    await fs.mkdir(smokeWorkspace, { recursive: true });

    if (config.agent.harness !== "hermes_acp") {
      console.warn(
        `[smoke:hermes-acp] workflow agent.harness is ${config.agent.harness}; continuing because this smoke validates host Hermes ACP setup independently`,
      );
    }

    const host = await resolveHermesAcpSmokeHostSettings(config, smokeWorkspace, timeoutMs, rawOptions);
    const profileName = smokeProfileName(config, rawOptions, host.sourceProfile);
    plan = buildHermesAcpSmokeCommandPlan({
      binaryPath: host.binaryPath,
      sourceProfile: host.sourceProfile,
      profileName,
      cwd: smokeWorkspace,
      env: process.env,
    });

    console.log("[smoke:hermes-acp] checking host Hermes version");
    await runRequiredSmokeCommand(plan.version, defaultHermesAcpSmokeCommandRunner, timeoutMs);

    console.log("[smoke:hermes-acp] recording active host Hermes profile before smoke");
    const activeProfileBefore = await probeActiveHostHermesProfile(plan.activeProfile, defaultHermesAcpSmokeCommandRunner, timeoutMs);

    console.log("[smoke:hermes-acp] checking active host Hermes ACP readiness");
    await runRequiredSmokeCommand(plan.hostAcpCheck, defaultHermesAcpSmokeCommandRunner, timeoutMs);

    console.log("[smoke:hermes-acp] checking source profile Hermes ACP readiness");
    await runRequiredSmokeCommand(plan.sourceProfileAcpCheck, defaultHermesAcpSmokeCommandRunner, timeoutMs);

    console.log(`[smoke:hermes-acp] cloning source profile ${host.sourceProfile} into disposable profile ${profileName}`);
    await runRequiredSmokeCommand(plan.createProfile, defaultHermesAcpSmokeCommandRunner, timeoutMs);
    profileCreated = true;

    console.log("[smoke:hermes-acp] checking disposable profile ACP readiness");
    await runRequiredSmokeCommand(plan.clonedAcpCheck, defaultHermesAcpSmokeCommandRunner, timeoutMs);

    console.log("[smoke:hermes-acp] starting ACP prompt smoke on disposable profile");
    const promptResult = await runHermesAcpPromptSmoke({
      command: plan.launch,
      cwd: smokeWorkspace,
      expectedText,
      timeoutMs,
    });

    if (!rawOptions.keepProfile) {
      console.log("[smoke:hermes-acp] deleting disposable profile");
      await runRequiredSmokeCommand(plan.deleteProfile, defaultHermesAcpSmokeCommandRunner, timeoutMs);
      profileDeleted = true;
    } else {
      console.warn(`[smoke:hermes-acp] keeping disposable profile ${profileName} because --keep-profile was set`);
    }

    console.log("[smoke:hermes-acp] verifying active/source host Hermes profile selection was not changed");
    const activeProfileAfter = await probeActiveHostHermesProfile(plan.activeProfile, defaultHermesAcpSmokeCommandRunner, timeoutMs);
    if (activeProfileAfter !== activeProfileBefore) {
      throw new Error(
        `Host Hermes active profile changed during smoke: before=${activeProfileBefore}, after=${activeProfileAfter}. The smoke must not mutate the source profile selection.`,
      );
    }

    console.log("[smoke:hermes-acp] OK");
    console.log(
      JSON.stringify(
        {
          workflowPath,
          configuredHarness: config.agent.harness,
          hostHermesBinary: host.binaryPath,
          hostHermesBinarySource: host.discovery.binary?.source ?? null,
          sourceProfile: host.sourceProfile,
          sourceProfileSource: host.discovery.sourceProfile?.source ?? null,
          disposableProfile: profileName,
          disposableProfileDeleted: profileDeleted,
          activeProfileUnchanged: true,
          promptSessionId: promptResult.sessionId,
          promptStopReason: promptResult.stopReason,
          promptDiagnosticCount: promptResult.diagnosticCount,
          promptUpdateCount: promptResult.updateCount,
          tempRoot: rawOptions.keepTemp ? tempRoot : undefined,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await loader.close();
    if (profileCreated && !profileDeleted && !rawOptions.keepProfile && plan) {
      try {
        await runRequiredSmokeCommand(plan.deleteProfile, defaultHermesAcpSmokeCommandRunner, timeoutMs);
      } catch (error) {
        cleanupError = error;
        console.error(`[smoke:hermes-acp] cleanup failed: ${redactForLog(errorMessage(error))}`);
      }
    }
    if (tempRoot && !rawOptions.keepTemp) {
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
    }
    if (!primaryError && cleanupError) throw cleanupError;
  }
}

export async function resolveHermesAcpSmokeHostSettings(
  config: ServiceConfig,
  cwd: string,
  timeoutMs: number,
  rawOptions: Pick<RawOptions, "binaryPath" | "sourceProfile">,
): Promise<HermesAcpSmokeHostSettings> {
  const configuredBinary = nonEmptyString(rawOptions.binaryPath) ?? rawHermesString(config, ["acp_binary_path", "binary_path"]);
  const configuredSource = nonEmptyString(rawOptions.sourceProfile) ?? rawHermesString(config, ["acp_source_profile", "source_profile"]);
  const discovery = await discoverHostHermes({
    ...(configuredBinary === null ? {} : { binaryPath: configuredBinary }),
    ...(configuredSource === null ? {} : { sourceProfile: configuredSource }),
    cwd,
    env: hostHermesCommandEnvironment(process.env),
    timeoutMs,
  });
  if (!discovery.ok || !discovery.binary?.path || !discovery.sourceProfile?.name) {
    const diagnostics = discovery.diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join("; ");
    throw new Error(diagnostics || "Host Hermes ACP discovery failed.");
  }
  return { binaryPath: discovery.binary.path, sourceProfile: discovery.sourceProfile.name, discovery };
}

export function buildHermesAcpSmokeCommandPlan(input: {
  binaryPath: string;
  sourceProfile: string;
  profileName: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): HermesAcpSmokeCommandPlan {
  const binaryPath = requireNonEmpty(input.binaryPath, "Host Hermes binary path");
  const sourceProfile = requireNonEmpty(input.sourceProfile, "Host Hermes ACP source profile");
  const profileName = requireNonEmpty(input.profileName, "Host Hermes ACP smoke profile name");
  if (profileName.toLowerCase() === sourceProfile.toLowerCase()) {
    throw new Error("Host Hermes ACP smoke profile name must differ from the source profile.");
  }
  const cwd = requireNonEmpty(input.cwd, "Host Hermes ACP smoke working directory");
  const env = hostHermesAcpCommandEnvironment(input.env ?? process.env);
  return {
    version: { label: "host Hermes version", file: binaryPath, args: ["--version"], cwd, env },
    activeProfile: { label: "host Hermes active profile", file: binaryPath, args: ["profile"], cwd, env },
    hostAcpCheck: { label: "host Hermes active ACP check", file: binaryPath, args: ["acp", "--check"], cwd, env },
    sourceProfileAcpCheck: {
      label: "host Hermes source profile ACP check",
      file: binaryPath,
      args: ["-p", sourceProfile, "acp", "--check"],
      cwd,
      env,
    },
    createProfile: {
      label: "host Hermes disposable ACP profile clone",
      file: binaryPath,
      args: buildHostHermesAcpCreateProfileArgs(profileName, sourceProfile),
      cwd,
      env,
    },
    clonedAcpCheck: {
      label: "host Hermes disposable ACP profile check",
      file: binaryPath,
      args: ["-p", profileName, "acp", "--check"],
      cwd,
      env,
    },
    launch: buildHostHermesAcpLaunchCommand({ binaryPath, profileName, cwd, env }),
    deleteProfile: {
      label: "host Hermes disposable ACP profile delete",
      file: binaryPath,
      args: buildHostHermesAcpDeleteProfileArgs(profileName),
      cwd,
      env,
    },
  };
}

export function buildHermesAcpSmokeProfileName(input: { prefix?: string | null; runId?: string | null }): string {
  const prefix = nonEmptyString(input.prefix) ?? DEFAULT_PROFILE_PREFIX;
  const runId = nonEmptyString(input.runId) ?? randomUUID();
  return normalizeHostHermesAcpProfileName(`${prefix}-${runId}`);
}

export async function runHermesAcpPromptSmoke(input: {
  command: HostHermesAcpProcessCommand;
  cwd: string;
  expectedText: string;
  timeoutMs: number;
}): Promise<HermesAcpPromptSmokeResult> {
  const client = HostHermesAcpStdioJsonRpcFacade.spawn(input.command, { requestTimeoutMs: input.timeoutMs });
  const diagnostics: HostHermesAcpDiagnostic[] = [];
  let updateCount = 0;
  let responseText = "";
  let activeSessionId: string | null = null;

  const removeSessionUpdateHandler = client.onNotification("session/update", (params) => {
    const event = hermesAcpSessionUpdateEvent(params);
    if (!event || (activeSessionId && event.sessionId && event.sessionId !== activeSessionId)) return;
    updateCount += 1;
    responseText += hermesAcpAgentMessageDelta(event.update);
  });
  const removePermissionHandler = client.onClientRequest("session/request_permission", () => ({ outcome: { outcome: "cancelled" } }));
  const onDiagnostic = (diagnostic: HostHermesAcpDiagnostic): void => {
    diagnostics.push(diagnostic);
  };
  client.on("diagnostic", onDiagnostic);

  try {
    const initializeResult = await client.request<Record<string, unknown>>(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "symphony-smoke", title: "Symphony Hermes ACP smoke", version: "0.1.0" },
      },
      { timeoutMs: input.timeoutMs },
    );
    const authMethod = selectNonTerminalAuthMethod(initializeResult);
    await client.request("authenticate", { methodId: authMethod.id }, { timeoutMs: input.timeoutMs });
    const session = await client.request<Record<string, unknown>>(
      "session/new",
      { cwd: input.cwd, mcpServers: [] },
      { timeoutMs: input.timeoutMs },
    );
    activeSessionId = nonEmptyString(session.sessionId) ?? nonEmptyString(session.session_id);
    if (!activeSessionId) throw new Error("Host Hermes ACP session/new did not return a sessionId.");

    const result = await client.request<Record<string, unknown> | null>(
      "session/prompt",
      {
        sessionId: activeSessionId,
        prompt: [
          {
            type: "text",
            text: `This is a Symphony Hermes ACP smoke. Reply with exactly: ${input.expectedText}. Do not edit files, call tools, or request permissions.`,
          },
        ],
      },
      { timeoutMs: input.timeoutMs },
    );
    const stopReason = nonEmptyString(result?.stopReason) ?? nonEmptyString(result?.stop_reason);
    if (stopReason && !["end_turn", "stop", "max_turn_requests"].includes(stopReason)) {
      throw new Error(`Host Hermes ACP prompt stopped with unsupported stop reason ${stopReason}.`);
    }
    if (input.expectedText.length > 0 && !responseText.includes(input.expectedText)) {
      const preview = sanitizedPreviewValue(redactForLog(responseText), 500).preview ?? "";
      throw new Error(`Host Hermes ACP smoke response did not contain expected text: ${input.expectedText}. Response preview: ${preview}`);
    }
    return {
      sessionId: activeSessionId,
      responseText,
      stopReason: stopReason ?? null,
      diagnosticCount: diagnostics.length,
      updateCount,
    };
  } catch (error) {
    const diagnosticSummary = diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join("; ");
    throw new Error(
      `Host Hermes ACP prompt smoke failed: ${redactForLog(errorMessage(error))}${diagnosticSummary ? `; diagnostics: ${redactForLog(diagnosticSummary)}` : ""}`,
    );
  } finally {
    removeSessionUpdateHandler();
    removePermissionHandler();
    client.off("diagnostic", onDiagnostic);
    client.kill("hermes_acp_smoke_complete");
  }
}

export async function runRequiredSmokeCommand(
  entry: HermesAcpSmokeCommandPlanEntry,
  runner: HostHermesAcpCommandRunner,
  timeoutMs: number,
): Promise<HostHermesAcpCommandResult> {
  const result = await runner(entry.file, entry.args, { cwd: entry.cwd, env: entry.env, timeoutMs });
  if (result.exitCode !== 0) {
    throw new Error(
      `${entry.label} failed with exit code ${result.exitCode ?? "unknown"}: ${formatCommand(entry)}${formatCommandOutput(result)}`,
    );
  }
  return result;
}

export function defaultHermesAcpSmokeCommandRunner(
  file: string,
  args: readonly string[],
  options: HostHermesAcpCommandOptions,
): Promise<HostHermesAcpCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { cwd: options.cwd, env: options.env, timeout: options.timeoutMs, windowsHide: true },
      (error, stdout, stderr) => {
        const stdoutText = commandOutputToString(stdout);
        const stderrText = commandOutputToString(stderr);
        if (error) {
          const commandError = error as NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals | string | null };
          if (typeof commandError.code === "number") {
            resolve({ stdout: stdoutText, stderr: stderrText, exitCode: commandError.code });
            return;
          }
          if (commandError.killed || commandError.signal) {
            resolve({ stdout: stdoutText, stderr: stderrText, exitCode: null });
            return;
          }
          Object.assign(error, { stdout: stdoutText, stderr: stderrText });
          reject(error);
          return;
        }
        resolve({ stdout: stdoutText, stderr: stderrText, exitCode: 0 });
      },
    );
  });
}

export async function probeActiveHostHermesProfile(
  entry: HermesAcpSmokeCommandPlanEntry,
  runner: HostHermesAcpCommandRunner,
  timeoutMs: number,
): Promise<string> {
  const result = await runRequiredSmokeCommand(entry, runner, timeoutMs);
  const activeProfile = parseHostHermesActiveProfile(`${result.stdout}\n${result.stderr}`);
  if (!activeProfile) throw new Error("Host Hermes active profile probe did not include a `Profile:` or `Active profile:` line.");
  return activeProfile;
}

function smokeProfileName(config: ServiceConfig, rawOptions: RawOptions, sourceProfile: string): string {
  const configured = nonEmptyString(rawOptions.profileName);
  const profileName = configured ?? buildHermesAcpSmokeProfileName({
    prefix: nonEmptyString(rawOptions.profilePrefix) ?? rawHermesString(config, ["acp_profile_prefix", "profile_name_prefix"]) ?? DEFAULT_PROFILE_PREFIX,
  });
  if (profileName.toLowerCase() === sourceProfile.toLowerCase()) {
    throw new Error("Refusing to use the source profile as the disposable Hermes ACP smoke profile.");
  }
  return normalizeHostHermesAcpProfileName(profileName);
}

function rawHermesString(config: ServiceConfig, keys: readonly string[]): string | null {
  const rawHermes = isRecord(config.raw.hermes) ? config.raw.hermes : {};
  for (const key of keys) {
    const value = nonEmptyString(rawHermes[key]);
    if (value) return value;
  }
  return null;
}

function selectNonTerminalAuthMethod(initializeResult: Record<string, unknown>): { id: string; label: string } {
  const authMethods = authMethodsFromInitializeResult(initializeResult);
  const selected = authMethods.find((method) => {
    const id = authMethodId(method);
    return id !== null && !isTerminalAuthMethod(method);
  });
  if (!selected) {
    throw new Error(
      "Host Hermes ACP initialize did not advertise a non-terminal provider auth method. Configure host Hermes provider credentials before running the ACP smoke.",
    );
  }
  const id = authMethodId(selected);
  if (!id) throw new Error("Host Hermes ACP selected auth method did not include an id.");
  return { id, label: authMethodLabel(selected) ?? id };
}

function authMethodsFromInitializeResult(initializeResult: Record<string, unknown>): Record<string, unknown>[] {
  const value = Array.isArray(initializeResult.authMethods)
    ? initializeResult.authMethods
    : Array.isArray(initializeResult.auth_methods)
      ? initializeResult.auth_methods
      : [];
  return value.filter(isRecord);
}

function authMethodId(method: Record<string, unknown>): string | null {
  return nonEmptyString(method.id) ?? nonEmptyString(method.methodId) ?? nonEmptyString(method.method_id);
}

function authMethodLabel(method: Record<string, unknown>): string | null {
  return nonEmptyString(method.name) ?? nonEmptyString(method.title) ?? nonEmptyString(method.description);
}

function isTerminalAuthMethod(method: Record<string, unknown>): boolean {
  const id = authMethodId(method);
  const type = nonEmptyString(method.type)?.toLowerCase() ?? "";
  return id === TERMINAL_SETUP_AUTH_METHOD_ID || type === "terminal" || type === "terminalauthmethod";
}

function hermesAcpSessionUpdateEvent(params: unknown): { sessionId: string | null; update: Record<string, unknown> } | null {
  if (!isRecord(params)) return null;
  const update = isRecord(params.update) ? params.update : {};
  return { sessionId: nonEmptyString(params.sessionId) ?? nonEmptyString(params.session_id), update };
}

function hermesAcpAgentMessageDelta(update: Record<string, unknown>): string {
  if (acpSessionUpdateKind(update) !== "agent_message_chunk") return "";
  return acpUpdateText(update);
}

function acpSessionUpdateKind(update: Record<string, unknown>): string {
  return nonEmptyString(update.sessionUpdate) ?? nonEmptyString(update.session_update) ?? "session_update";
}

function acpUpdateText(update: Record<string, unknown>): string {
  return (
    textFromContent(update.content) ??
    nonEmptyString(update.text) ??
    sanitizedPreviewValue(isRecord(update.content) || Array.isArray(update.content) ? update.content : update, 240).preview ??
    ""
  );
}

function textFromContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (isRecord(content)) return nonEmptyString(content.text) ?? nonEmptyString(content.content);
  if (!Array.isArray(content)) return null;
  const parts = content
    .map((part) => {
      if (typeof part === "string") return part;
      if (isRecord(part)) return nonEmptyString(part.text) ?? nonEmptyString(part.content) ?? "";
      return "";
    })
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join("") : null;
}

function formatCommand(entry: HermesAcpSmokeCommandPlanEntry): string {
  return [entry.file, ...entry.args].map(shellishQuote).join(" ");
}

function formatCommandOutput(result: HostHermesAcpCommandResult): string {
  const output = [result.stdout, result.stderr]
    .map((part) => redactForLog(part).trim())
    .filter((part) => part.length > 0)
    .join("\n");
  return output ? `\n${output}` : "";
}

function shellishQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function redactForLog(value: string): string {
  let redacted = redactTranscriptText(value).text;
  for (const [key, secret] of Object.entries(process.env)) {
    if (!secret || secret.length < 8 || !/[A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|AUTH)[A-Z0-9_]*/i.test(key)) continue;
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

function commandOutputToString(value: string | Buffer): string {
  return typeof value === "string" ? value : value.toString("utf8");
}

function parsePositiveInt(input: string, label: string): number {
  const value = Number(input);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function requireNonEmpty(value: string, label: string): string {
  const normalized = nonEmptyString(value);
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isDirectRun(moduleUrl: string, argv: readonly string[] = process.argv): boolean {
  const entry = argv[1];
  return typeof entry === "string" && moduleUrl === pathToFileURL(path.resolve(entry)).href;
}

if (isDirectRun(import.meta.url)) {
  program.parse(process.argv);
  void main(program.args[0] ?? "WORKFLOW.md", program.opts<RawOptions>()).catch((error) => {
    console.error(`[smoke:hermes-acp] ${redactForLog(errorMessage(error))}`);
    process.exitCode = 1;
  });
}

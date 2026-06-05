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
const COMMAND_OUTPUT_TAIL_LINES = 24;
const COMMAND_OUTPUT_TAIL_CHARS = 4_000;

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
  status: "ready";
  binaryPath: string;
  sourceProfile: string;
  discovery: HostHermesDiscoveryResult;
}

export interface HermesAcpSmokeSkipReport {
  status: "skipped";
  phase: string;
  message: string;
  hostHermesBinary: string;
  hostHermesBinarySource: string;
  sourceProfile: string | null;
  sourceProfileSource: string;
  cloneProfile: null;
  cloneProfileState: "not_yet_allocated";
  stderrTail: string;
  diagnostics: Array<{ code: string; severity: string; message: string }>;
}

export type HermesAcpSmokeHostResolution = HermesAcpSmokeHostSettings | HermesAcpSmokeSkipReport;

export interface HermesAcpSmokeSuccessReport {
  workflowPath: string;
  configuredHarness: string;
  hostHermesBinary: string;
  hostHermesBinarySource: string | null;
  sourceProfile: string;
  sourceProfileSource: string | null;
  disposableProfile: string;
  disposableProfileDeleted: boolean;
  activeProfileUnchanged: boolean;
  promptExpectedText: string;
  promptResponseText: string;
  promptSessionId: string;
  promptStopReason: string | null;
  promptDiagnosticCount: number;
  promptUpdateCount: number;
  tempRoot?: string;
}

export interface HermesAcpSmokeFailureContext {
  phase: string;
  hostHermesBinary?: string | null;
  hostHermesBinarySource?: string | null;
  sourceProfile?: string | null;
  sourceProfileSource?: string | null;
  cloneProfile?: string | null;
  stderrTail?: string | null;
}

export interface HermesAcpSmokeHostResolutionOptions {
  discoverHost?: typeof discoverHostHermes;
  env?: NodeJS.ProcessEnv;
}

export class HermesAcpSmokeFailure extends Error {
  readonly context: HermesAcpSmokeFailureContext;

  constructor(message: string, context: HermesAcpSmokeFailureContext) {
    super(`${message}\n${formatHermesAcpSmokeFailureContext(context)}`);
    this.name = "HermesAcpSmokeFailure";
    this.context = context;
  }
}

const program = new Command()
  .name("hermes-acp-smoke")
  .description(
    "Run an opt-in live smoke for host Hermes ACP without touching Linear, GitHub, tracked files, or vendored Hermes auth state",
  )
  .argument("[workflow]", "path to WORKFLOW.md", "WORKFLOW.md")
  .option("--binary-path <path>", "explicit host Hermes executable to use instead of hermes_acp.binary_path or PATH")
  .option("--source-profile <name>", "host Hermes source profile to clone instead of hermes_acp.source_profile or the active profile")
  .option("--profile-name <name>", "explicit disposable smoke profile name; must not already exist")
  .option("--profile-prefix <prefix>", "prefix for generated disposable smoke profile names; defaults to hermes_acp.profile_prefix")
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
  let config: ServiceConfig | null = null;
  let host: HermesAcpSmokeHostSettings | null = null;
  let profileName: string | null = null;
  let phase = "workflow load";
  const currentContext = (overrides: Partial<HermesAcpSmokeFailureContext> = {}): HermesAcpSmokeFailureContext => ({
    phase,
    hostHermesBinary: host?.binaryPath ?? null,
    hostHermesBinarySource: host?.discovery.binary?.source ?? null,
    sourceProfile: host?.sourceProfile ?? null,
    sourceProfileSource: host?.discovery.sourceProfile?.source ?? null,
    cloneProfile: profileName,
    ...overrides,
  });

  try {
    const loaded = await loader.load();
    config = loaded.serviceConfig;
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "symphony-hermes-acp-smoke-"));
    const smokeWorkspace = path.join(tempRoot, "workspace");
    await fs.mkdir(smokeWorkspace, { recursive: true });

    if (config.agent.harness !== "hermes_acp") {
      console.warn(
        `[smoke:hermes-acp] workflow agent.harness is ${config.agent.harness}; continuing because this smoke validates host Hermes ACP setup independently`,
      );
    }

    phase = "host Hermes discovery";
    const hostResolution = await resolveHermesAcpSmokeHostSettings(config, smokeWorkspace, timeoutMs, rawOptions);
    if (hostResolution.status === "skipped") {
      emitHermesAcpSmokeSkip(hostResolution);
      return;
    }
    host = hostResolution;
    profileName = resolveHermesAcpSmokeProfileName(config, rawOptions, host.sourceProfile);
    plan = buildHermesAcpSmokeCommandPlan({
      binaryPath: host.binaryPath,
      sourceProfile: host.sourceProfile,
      profileName,
      cwd: smokeWorkspace,
      env: process.env,
    });

    phase = plan.version.label;
    console.log("[smoke:hermes-acp] checking host Hermes version");
    await runRequiredSmokeCommand(plan.version, defaultHermesAcpSmokeCommandRunner, timeoutMs, currentContext({ phase }));

    phase = plan.activeProfile.label;
    console.log("[smoke:hermes-acp] recording active host Hermes profile before smoke");
    const activeProfileBefore = await probeActiveHostHermesProfile(
      plan.activeProfile,
      defaultHermesAcpSmokeCommandRunner,
      timeoutMs,
      currentContext({ phase }),
    );

    phase = plan.hostAcpCheck.label;
    console.log("[smoke:hermes-acp] checking active host Hermes ACP readiness");
    await runRequiredSmokeCommand(plan.hostAcpCheck, defaultHermesAcpSmokeCommandRunner, timeoutMs, currentContext({ phase }));

    phase = plan.sourceProfileAcpCheck.label;
    console.log("[smoke:hermes-acp] checking source profile Hermes ACP readiness");
    await runRequiredSmokeCommand(plan.sourceProfileAcpCheck, defaultHermesAcpSmokeCommandRunner, timeoutMs, currentContext({ phase }));

    phase = plan.createProfile.label;
    console.log(`[smoke:hermes-acp] cloning source profile ${host.sourceProfile} into disposable profile ${profileName}`);
    await runRequiredSmokeCommand(plan.createProfile, defaultHermesAcpSmokeCommandRunner, timeoutMs, currentContext({ phase }));
    profileCreated = true;

    phase = plan.clonedAcpCheck.label;
    console.log("[smoke:hermes-acp] checking disposable profile ACP readiness");
    await runRequiredSmokeCommand(plan.clonedAcpCheck, defaultHermesAcpSmokeCommandRunner, timeoutMs, currentContext({ phase }));

    phase = "host Hermes ACP launch/session/prompt";
    console.log("[smoke:hermes-acp] starting ACP prompt smoke on disposable profile");
    const promptResult = await runHermesAcpPromptSmoke({
      command: plan.launch,
      cwd: smokeWorkspace,
      expectedText,
      timeoutMs,
      failureContext: currentContext({ phase }),
    });

    if (!rawOptions.keepProfile) {
      phase = plan.deleteProfile.label;
      console.log("[smoke:hermes-acp] deleting disposable profile");
      await runRequiredSmokeCommand(plan.deleteProfile, defaultHermesAcpSmokeCommandRunner, timeoutMs, currentContext({ phase }));
      profileDeleted = true;
    } else {
      console.warn(`[smoke:hermes-acp] keeping disposable profile ${profileName} because --keep-profile was set`);
    }

    phase = "host Hermes active profile stability verification";
    console.log("[smoke:hermes-acp] verifying active/source host Hermes profile selection was not changed");
    const activeProfileAfter = await probeActiveHostHermesProfile(
      plan.activeProfile,
      defaultHermesAcpSmokeCommandRunner,
      timeoutMs,
      currentContext({ phase }),
    );
    if (activeProfileAfter !== activeProfileBefore) {
      throw contextualizeHermesAcpSmokeError(
        new Error(
          `Host Hermes active profile changed during smoke: before=${activeProfileBefore}, after=${activeProfileAfter}. The smoke must not mutate the source profile selection.`,
        ),
        currentContext({ phase }),
      );
    }

    console.log("[smoke:hermes-acp] OK");
    console.log(
      JSON.stringify(
        buildHermesAcpSmokeSuccessReport({
          workflowPath,
          configuredHarness: config.agent.harness,
          hostHermesBinary: host.binaryPath,
          hostHermesBinarySource: host.discovery.binary?.source ?? null,
          sourceProfile: host.sourceProfile,
          sourceProfileSource: host.discovery.sourceProfile?.source ?? null,
          disposableProfile: profileName,
          disposableProfileDeleted: profileDeleted,
          activeProfileUnchanged: true,
          expectedText,
          promptResult,
          tempRoot: rawOptions.keepTemp ? tempRoot : null,
        }),
        null,
        2,
      ),
    );
  } catch (error) {
    primaryError = error;
    throw contextualizeHermesAcpSmokeError(error, currentContext());
  } finally {
    await loader.close();
    if (profileCreated && !profileDeleted && !rawOptions.keepProfile && plan) {
      try {
        await runRequiredSmokeCommand(
          plan.deleteProfile,
          defaultHermesAcpSmokeCommandRunner,
          timeoutMs,
          currentContext({ phase: "host Hermes disposable ACP profile cleanup", cloneProfile: profileName }),
        );
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
  options: HermesAcpSmokeHostResolutionOptions = {},
): Promise<HermesAcpSmokeHostResolution> {
  const configuredBinary = nonEmptyString(rawOptions.binaryPath) ?? config.hermesAcp.binaryPath;
  const configuredSource = nonEmptyString(rawOptions.sourceProfile) ?? config.hermesAcp.sourceProfile;
  const discover = options.discoverHost ?? discoverHostHermes;
  const discovery = await discover({
    ...(configuredBinary === null ? {} : { binaryPath: configuredBinary }),
    ...(configuredSource === null ? {} : { sourceProfile: configuredSource }),
    cwd,
    env: hostHermesCommandEnvironment(options.env ?? process.env),
    timeoutMs,
  });
  if (!discovery.ok || !discovery.binary?.path || !discovery.sourceProfile?.name) {
    return buildHermesAcpSmokeSkipReport(discovery, { configuredBinary, configuredSource });
  }
  return { status: "ready", binaryPath: discovery.binary.path, sourceProfile: discovery.sourceProfile.name, discovery };
}

export function buildHermesAcpSmokeSkipReport(
  discovery: HostHermesDiscoveryResult,
  input: { configuredBinary: string | null; configuredSource: string | null },
): HermesAcpSmokeSkipReport {
  const diagnostics = discovery.diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
  }));
  const diagnosticSummary = diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join("; ");
  return {
    status: "skipped",
    phase: "host Hermes discovery",
    message:
      "Host Hermes ACP smoke skipped because host Hermes binary/profile prerequisites are unavailable. " +
      (diagnosticSummary ||
        "Install host Hermes, configure `hermes_acp.binary_path`, or configure `hermes_acp.source_profile` before treating this live ACP smoke as validated."),
    hostHermesBinary: discovery.binary?.path ?? input.configuredBinary ?? "hermes (PATH lookup)",
    hostHermesBinarySource: discovery.binary?.source ?? (input.configuredBinary ? "config" : "path"),
    sourceProfile: discovery.sourceProfile?.name ?? input.configuredSource,
    sourceProfileSource: discovery.sourceProfile?.source ?? (input.configuredSource ? "config" : "active"),
    cloneProfile: null,
    cloneProfileState: "not_yet_allocated",
    stderrTail: "not captured; host Hermes command plan was not created",
    diagnostics,
  };
}

export function formatHermesAcpSmokeSkipReport(report: HermesAcpSmokeSkipReport): string {
  return [
    `[smoke:hermes-acp] SKIPPED: ${report.message}`,
    `ACP phase: ${report.phase}`,
    `host Hermes binary: ${report.hostHermesBinary}`,
    `host Hermes binary source: ${report.hostHermesBinarySource}`,
    `source profile: ${report.sourceProfile ?? "not discovered"}`,
    `source profile source: ${report.sourceProfileSource}`,
    "clone profile: not yet allocated",
    `stderr tail: ${report.stderrTail}`,
    JSON.stringify(report, null, 2),
  ].join("\n");
}

export function buildHermesAcpSmokeSuccessReport(input: {
  workflowPath: string;
  configuredHarness: string;
  hostHermesBinary: string;
  hostHermesBinarySource: string | null;
  sourceProfile: string;
  sourceProfileSource: string | null;
  disposableProfile: string;
  disposableProfileDeleted: boolean;
  activeProfileUnchanged: boolean;
  expectedText: string;
  promptResult: HermesAcpPromptSmokeResult;
  tempRoot?: string | null;
}): HermesAcpSmokeSuccessReport {
  return {
    workflowPath: input.workflowPath,
    configuredHarness: input.configuredHarness,
    hostHermesBinary: input.hostHermesBinary,
    hostHermesBinarySource: input.hostHermesBinarySource,
    sourceProfile: input.sourceProfile,
    sourceProfileSource: input.sourceProfileSource,
    disposableProfile: input.disposableProfile,
    disposableProfileDeleted: input.disposableProfileDeleted,
    activeProfileUnchanged: input.activeProfileUnchanged,
    promptExpectedText: sanitizedPreviewValue(redactForLog(input.expectedText), 500).preview ?? "",
    promptResponseText: sanitizedPreviewValue(redactForLog(input.promptResult.responseText), 500).preview ?? "",
    promptSessionId: input.promptResult.sessionId,
    promptStopReason: input.promptResult.stopReason,
    promptDiagnosticCount: input.promptResult.diagnosticCount,
    promptUpdateCount: input.promptResult.updateCount,
    ...(input.tempRoot ? { tempRoot: input.tempRoot } : {}),
  };
}

function emitHermesAcpSmokeSkip(report: HermesAcpSmokeSkipReport): void {
  console.log(formatHermesAcpSmokeSkipReport(report));
}

export function contextualizeHermesAcpSmokeError(
  error: unknown,
  context: Partial<HermesAcpSmokeFailureContext>,
): HermesAcpSmokeFailure {
  if (error instanceof HermesAcpSmokeFailure) return error;
  return new HermesAcpSmokeFailure(redactForLog(errorMessage(error)), normalizeHermesAcpSmokeFailureContext(context));
}

export function formatHermesAcpSmokeFailureContext(context: Partial<HermesAcpSmokeFailureContext>): string {
  const normalized = normalizeHermesAcpSmokeFailureContext(context);
  return [
    "Host Hermes ACP smoke context:",
    `- ACP phase: ${normalized.phase}`,
    `- host Hermes binary: ${normalized.hostHermesBinary ?? "not discovered"}`,
    `- host Hermes binary source: ${normalized.hostHermesBinarySource ?? "unknown"}`,
    `- source profile: ${normalized.sourceProfile ?? "not discovered"}`,
    `- source profile source: ${normalized.sourceProfileSource ?? "unknown"}`,
    `- clone profile: ${normalized.cloneProfile ?? "not yet allocated"}`,
    `- stderr tail: ${normalized.stderrTail ?? "not captured for this phase"}`,
  ].join("\n");
}

function normalizeHermesAcpSmokeFailureContext(
  context: Partial<HermesAcpSmokeFailureContext>,
): HermesAcpSmokeFailureContext {
  return {
    phase: nonEmptyString(context.phase) ?? "unknown",
    hostHermesBinary: nonEmptyString(context.hostHermesBinary) ?? null,
    hostHermesBinarySource: nonEmptyString(context.hostHermesBinarySource) ?? null,
    sourceProfile: nonEmptyString(context.sourceProfile) ?? null,
    sourceProfileSource: nonEmptyString(context.sourceProfileSource) ?? null,
    cloneProfile: nonEmptyString(context.cloneProfile) ?? null,
    stderrTail: nonEmptyString(context.stderrTail) ?? null,
  };
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
  failureContext?: HermesAcpSmokeFailureContext;
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
    const stderrTail = boundedOutputTail(client.getLogTail());
    throw contextualizeHermesAcpSmokeError(
      new Error(
        `Host Hermes ACP prompt smoke failed: ${redactForLog(errorMessage(error))}${diagnosticSummary ? `; diagnostics: ${redactForLog(diagnosticSummary)}` : ""}`,
      ),
      {
        ...input.failureContext,
        phase: input.failureContext?.phase ?? "host Hermes ACP launch/session/prompt",
        hostHermesBinary: input.failureContext?.hostHermesBinary ?? input.command.file,
        cloneProfile: input.failureContext?.cloneProfile ?? profileFromLaunchCommand(input.command),
        stderrTail,
      },
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
  failureContext: Partial<HermesAcpSmokeFailureContext> = {},
): Promise<HostHermesAcpCommandResult> {
  const result = await runner(entry.file, entry.args, { cwd: entry.cwd, env: entry.env, timeoutMs });
  if (result.exitCode !== 0) {
    const stderrTail = boundedOutputTail(result.stderr);
    throw contextualizeHermesAcpSmokeError(
      new Error(`${entry.label} failed with exit code ${result.exitCode ?? "unknown"}: ${formatCommand(entry)}${formatCommandOutput(result)}`),
      {
        ...failureContext,
        phase: failureContext.phase ?? entry.label,
        hostHermesBinary: failureContext.hostHermesBinary ?? entry.file,
        stderrTail,
      },
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
  failureContext: Partial<HermesAcpSmokeFailureContext> = {},
): Promise<string> {
  const result = await runRequiredSmokeCommand(entry, runner, timeoutMs, failureContext);
  const activeProfile = parseHostHermesActiveProfile(`${result.stdout}\n${result.stderr}`);
  if (!activeProfile) {
    throw contextualizeHermesAcpSmokeError(
      new Error("Host Hermes active profile probe did not include a `Profile:` or `Active profile:` line."),
      {
        ...failureContext,
        phase: failureContext.phase ?? entry.label,
        hostHermesBinary: failureContext.hostHermesBinary ?? entry.file,
        stderrTail: boundedOutputTail(result.stderr),
      },
    );
  }
  return activeProfile;
}

export function resolveHermesAcpSmokeProfileName(
  config: Pick<ServiceConfig, "hermesAcp">,
  rawOptions: Pick<RawOptions, "profileName" | "profilePrefix">,
  sourceProfile: string,
): string {
  const configured = nonEmptyString(rawOptions.profileName);
  const profileName = configured ?? buildHermesAcpSmokeProfileName({
    prefix: nonEmptyString(rawOptions.profilePrefix) ?? config.hermesAcp.profilePrefix,
  });
  if (profileName.toLowerCase() === sourceProfile.toLowerCase()) {
    throw new Error("Refusing to use the source profile as the disposable Hermes ACP smoke profile.");
  }
  return normalizeHostHermesAcpProfileName(profileName);
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
  const stdoutTail = boundedOutputTail(result.stdout);
  const stderrTail = boundedOutputTail(result.stderr);
  const sections = [
    stdoutTail ? `stdout tail:\n${stdoutTail}` : null,
    `stderr tail:\n${stderrTail ?? "<empty>"}`,
  ].filter((section): section is string => section !== null);
  return `\n${sections.join("\n")}`;
}

function boundedOutputTail(value: string | null | undefined): string | null {
  const redacted = redactForLog(value ?? "").replace(/\r/g, "").trim();
  if (!redacted) return null;
  const lines = redacted.split("\n");
  const lineTail = lines.slice(Math.max(0, lines.length - COMMAND_OUTPUT_TAIL_LINES)).join("\n");
  return lineTail.length <= COMMAND_OUTPUT_TAIL_CHARS ? lineTail : lineTail.slice(lineTail.length - COMMAND_OUTPUT_TAIL_CHARS);
}

function profileFromLaunchCommand(command: HostHermesAcpProcessCommand): string | null {
  const profileFlagIndex = command.args.indexOf("-p");
  if (profileFlagIndex >= 0) return nonEmptyString(command.args[profileFlagIndex + 1]);
  const profileLongIndex = command.args.indexOf("--profile");
  if (profileLongIndex >= 0) return nonEmptyString(command.args[profileLongIndex + 1]);
  return null;
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

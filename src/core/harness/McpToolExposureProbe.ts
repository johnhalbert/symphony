import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Agent, type Run, type SDKAgent, type SettingSource } from "@cursor/sdk";
import type { CursorSettingSource, ServiceConfig } from "../config/Config.js";
import type { AgentRunContext } from "./AgentHarness.js";
import { COMPLETION_REPORT_TOOL_NAME, writeCompletionReportMcpContext } from "./CompletionReportMcpServer.js";
import {
  buildMcpSubprocessEnvironment,
  buildMcpSubprocessServerConfig,
  type McpSubprocessCommand,
} from "./McpSubprocessEnvironment.js";
import { REVIEW_FEEDBACK_TOOL_NAME, writeReviewFeedbackMcpContext } from "./ReviewFeedbackMcpServer.js";
import { REVIEW_VERDICT_TOOL_NAME, writeReviewVerdictMcpContext } from "./ReviewVerdictMcpServer.js";
import type { AgentRunRole, Issue, Workspace } from "../types.js";
import { errorMessage } from "../errors.js";
import { StructuredLogger } from "../logging/StructuredLogger.js";
import { resolveCursorRuntimeApiKey } from "../../app/RuntimeDependencies.js";
import {
  completionReportContextFilePath,
  cursorAgentCreateOptions,
  cursorAgentSendOptions,
  cursorRoleMcpServers,
  reviewFeedbackContextFilePath,
  reviewVerdictContextFilePath,
} from "../../../cursor/src/CursorHarness.js";

export type McpToolExposureStage = "subprocess" | "sdk";
export type McpToolExposureStatus = "success" | "failure" | "skipped";
export type SdkRoleStatus = "success" | "failure" | "partial" | "skipped";
export type McpToolExposureFailureCode =
  | "subprocess_spawn_list_failure"
  | "subprocess_missing_empty_name_mismatch"
  | "sdk_credentials_missing"
  | "sdk_startup_send_failure"
  | "sdk_stream_unsupported"
  | "sdk_stream_failure"
  | "sdk_stream_timeout"
  | "sdk_no_system_messages"
  | "sdk_system_tools_absent"
  | "sdk_system_tools_empty"
  | "sdk_system_tools_unnamed"
  | "sdk_system_tools_name_mismatch"
  | "sdk_wait_failure"
  | "sdk_wait_unsupported"
  | "unexpected_tool_call";

export interface McpToolExposureSpec {
  role: AgentRunRole;
  serverKey: "symphony" | "symphony_review_verdict" | "symphony_review_feedback";
  command: McpSubprocessCommand;
  expectedTool: string;
}

export interface McpToolExposureServerResult {
  role: AgentRunRole;
  serverKey: McpToolExposureSpec["serverKey"];
  command: McpSubprocessCommand;
  expectedTool: string;
  status: McpToolExposureStatus;
  failureCode: McpToolExposureFailureCode | null;
  message: string;
  rawToolNames: string[];
  normalizedToolNames: string[];
  envKeyNames: string[];
  sdkRoleRunRole?: AgentRunRole;
  sdkRoleRunIndex?: number;
}

export interface McpToolExposureStageResult {
  stage: McpToolExposureStage;
  status: McpToolExposureStatus;
  failureCode: McpToolExposureFailureCode | null;
  message: string;
  results: McpToolExposureServerResult[];
  sdkRoleRuns?: SdkRoleRunResult[];
}

export interface McpToolExposureProbeConfig {
  cliPath: string;
  liveSmokeEnabled: boolean;
  roles: AgentRunRole[];
  sdkTimeoutMs: number;
  waitTimeoutMs: number;
  postCancelWaitMs: number;
  agentCwd: string;
  mcpCwd: string;
  settingSources: CursorSettingSource[];
  cursorMode: string | null;
}

export interface McpToolExposureReport {
  version: 1;
  generatedAt: string;
  workflowPath: string;
  cliPath: string;
  liveSmokeEnabled: boolean;
  probeConfig: McpToolExposureProbeConfig;
  ok: boolean;
  stages: McpToolExposureStageResult[];
}

export interface McpToolExposureProbeOptions {
  config: ServiceConfig;
  cliPath: string;
  roles?: AgentRunRole[];
  liveSmokeEnabled?: boolean;
  sdkTimeoutMs?: number;
  waitTimeoutMs?: number;
  postCancelWaitMs?: number;
  sdkCwd?: string;
  mcpCwd?: string;
  settingSources?: CursorSettingSource[];
}

export interface SdkSystemToolExtraction {
  rawToolNames: string[];
  normalizedToolNames: string[];
  systemToolsCount: number;
  namedToolCount: number;
  unnamedToolObjectCount: number;
  malformedToolObjectCount: number;
}

export interface SdkToolDiagnostics {
  role: AgentRunRole;
  agentCwd: string;
  mcpCwd: string;
  settingSources: CursorSettingSource[];
  cursorMode: string | null;
  sdkTimeoutMs: number;
  waitTimeoutMs: number;
  postCancelWaitMs: number;
  supportsStream: boolean | null;
  supportsWait: boolean | null;
  streamStatus: "not_started" | "drained" | "unsupported" | "timeout" | "error" | "unexpected_tool_call";
  waitStatus: string | null;
  waitError: string | null;
  timedOut: boolean;
  cancelledAfterTimeout: boolean;
  startupSendError: string | null;
  unexpectedToolCall: string | null;
  systemMessageCount: number;
  systemToolPayloadCount: number;
  systemToolsCount: number;
  namedToolCount: number;
  unnamedToolObjectCount: number;
  malformedToolObjectCount: number;
  rawSystemToolPayloads: unknown[];
  rawToolNames: string[];
  normalizedToolNames: string[];
  mcpTraceFile: string | null;
  mcpTraceMethodsByServer: Record<string, string[]>;
  observedMessageTypes: string[];
  messageTypeCounts: Record<string, number>;
  streamError: string | null;
}

export interface SdkRoleRunResult {
  role: AgentRunRole;
  agentId: string | null;
  runId: string | null;
  primaryFailureCode: McpToolExposureFailureCode | null;
  roleStatus: SdkRoleStatus;
  sdkObservation: SdkToolDiagnostics;
}

export const MCP_TOOL_EXPOSURE_SPECS: readonly McpToolExposureSpec[] = [
  {
    role: "worker",
    serverKey: "symphony",
    command: "completion-report-mcp",
    expectedTool: COMPLETION_REPORT_TOOL_NAME,
  },
  {
    role: "reviewer",
    serverKey: "symphony_review_verdict",
    command: "review-verdict-mcp",
    expectedTool: REVIEW_VERDICT_TOOL_NAME,
  },
  {
    role: "reviewer",
    serverKey: "symphony_review_feedback",
    command: "review-feedback-mcp",
    expectedTool: REVIEW_FEEDBACK_TOOL_NAME,
  },
] as const;

export async function runMcpToolExposureProbe(options: McpToolExposureProbeOptions): Promise<McpToolExposureReport> {
  const roles = options.roles ?? ["worker", "reviewer"];
  const probeConfig: McpToolExposureProbeConfig = {
    cliPath: options.cliPath,
    liveSmokeEnabled: options.liveSmokeEnabled ?? process.env.SYMPHONY_MCP_EXPOSURE_SMOKE === "1",
    roles,
    sdkTimeoutMs: options.sdkTimeoutMs ?? 45_000,
    waitTimeoutMs: options.waitTimeoutMs ?? 5_000,
    postCancelWaitMs: options.postCancelWaitMs ?? 1_500,
    agentCwd: options.sdkCwd ?? options.config.workflowDir,
    mcpCwd: options.mcpCwd ?? options.config.workflowDir,
    settingSources: options.settingSources ?? options.config.cursor.settingSources,
    cursorMode: options.config.cursor.mode,
  };
  const subprocess = await runSubprocessMcpToolExposureProbe(options.config, {
    cliPath: probeConfig.cliPath,
    roles,
  });
  const sdk = await runSdkMcpToolExposureProbe(options.config, {
    cliPath: probeConfig.cliPath,
    roles,
    enabled: probeConfig.liveSmokeEnabled,
    timeoutMs: probeConfig.sdkTimeoutMs,
    waitTimeoutMs: probeConfig.waitTimeoutMs,
    postCancelWaitMs: probeConfig.postCancelWaitMs,
    cwd: probeConfig.agentCwd,
    mcpCwd: probeConfig.mcpCwd,
    settingSources: probeConfig.settingSources,
  });
  return reportFromStages(options.config, probeConfig, [subprocess, sdk]);
}

export async function runSubprocessMcpToolExposureProbe(
  config: ServiceConfig,
  options: { cliPath: string; roles?: AgentRunRole[] },
): Promise<McpToolExposureStageResult> {
  const results: McpToolExposureServerResult[] = [];
  const specs = specsForRoles(options.roles ?? ["worker", "reviewer"]);
  for (const spec of specs) {
    const contextFile = path.join(config.workspace.stateDir, ".mcp-exposure-probe", `${spec.command}-${randomUUID()}.json`);
    const env = buildMcpSubprocessEnvironment({ config, command: spec.command });
    try {
      const rawToolNames = await listMcpToolsViaCommand({
        command: process.execPath,
        args: buildMcpSubprocessServerConfig({
          config,
          command: spec.command,
          cliPath: options.cliPath,
          workflowPath: config.workflowPath,
          contextFile,
        }).args,
        cwd: config.workflowDir,
        env,
      });
      results.push(classifyToolListResult("subprocess", spec, rawToolNames, Object.keys(env)));
    } catch (error) {
      results.push({
        role: spec.role,
        serverKey: spec.serverKey,
        command: spec.command,
        expectedTool: spec.expectedTool,
        status: "failure",
        failureCode: "subprocess_spawn_list_failure",
        message: `Subprocess tools/list failed for ${spec.command}: ${redactSensitiveText(errorMessage(error))}`,
        rawToolNames: [],
        normalizedToolNames: [],
        envKeyNames: sortedKeys(env),
      });
    }
  }
  return summarizeStage("subprocess", results);
}

export async function runSdkMcpToolExposureProbe(
  config: ServiceConfig,
  options: {
    cliPath: string;
    roles?: AgentRunRole[];
    enabled: boolean;
    timeoutMs: number;
    waitTimeoutMs?: number;
    postCancelWaitMs?: number;
    cwd?: string;
    mcpCwd?: string;
    settingSources?: CursorSettingSource[];
  },
): Promise<McpToolExposureStageResult> {
  const specs = specsForRoles(options.roles ?? ["worker", "reviewer"]);
  const roleRunContext = {
    agentCwd: options.cwd ?? config.workflowDir,
    mcpCwd: options.mcpCwd ?? config.workflowDir,
    settingSources: options.settingSources ?? config.cursor.settingSources,
    sdkTimeoutMs: options.timeoutMs,
    waitTimeoutMs: options.waitTimeoutMs ?? 5_000,
    postCancelWaitMs: options.postCancelWaitMs ?? 1_500,
  };
  if (!options.enabled) {
    const sdkRoleRuns = uniqueRoles(specs).map((role) =>
      syntheticSdkRoleRun({
        role,
        roleStatus: "skipped",
        primaryFailureCode: null,
        message: "Live SDK probe skipped",
        ...roleRunContext,
      }),
    );
    return {
      stage: "sdk",
      status: "skipped",
      failureCode: null,
      message: "Live Cursor SDK MCP exposure smoke skipped because SYMPHONY_MCP_EXPOSURE_SMOKE is not 1",
      results: specs.map((spec) => {
        const roleRunIndex = sdkRoleRuns.findIndex((roleRun) => roleRun.role === spec.role);
        return skippedServerResult(spec, "Live SDK probe skipped", roleRunIndex);
      }),
      sdkRoleRuns,
    };
  }

  const roleApiKeys = new Map<AgentRunRole, string>();
  const missingRoles: AgentRunRole[] = [];
  try {
    for (const role of uniqueRoles(specs)) {
      const apiKey = resolveCursorRuntimeApiKey(config, role);
      if (apiKey) {
        roleApiKeys.set(role, apiKey);
      } else {
        missingRoles.push(role);
      }
    }
  } catch (error) {
    return missingCredentialsStage(specs, roleRunContext, `cursor.runtime: ${errorMessage(error)}`);
  }
  if (missingRoles.length > 0) {
    return missingCredentialsStage(
      specs,
      roleRunContext,
      `cursor.runtime credentials are missing for ${missingRoles.join(", ")}`,
    );
  }

  if (roleApiKeys.size === 0) {
    return missingCredentialsStage(specs, roleRunContext, "cursor.runtime credentials are missing");
  }

  const results: McpToolExposureServerResult[] = [];
  const sdkRoleRuns: SdkRoleRunResult[] = [];
  for (const role of uniqueRoles(specs)) {
    const apiKey = roleApiKeys.get(role);
    if (!apiKey) {
      throw new Error(`cursor.runtime credential unexpectedly missing for ${role}`);
    }
    const roleRunIndex = sdkRoleRuns.length;
    const roleProbe = await runSdkRoleProbe(config, {
      role,
      cliPath: options.cliPath,
      apiKey,
      timeoutMs: options.timeoutMs,
      waitTimeoutMs: roleRunContext.waitTimeoutMs,
      postCancelWaitMs: roleRunContext.postCancelWaitMs,
      cwd: roleRunContext.agentCwd,
      mcpCwd: roleRunContext.mcpCwd,
      settingSources: roleRunContext.settingSources,
      roleRunIndex,
    });
    sdkRoleRuns.push(roleProbe.roleRun);
    results.push(...roleProbe.results);
  }
  return summarizeStage("sdk", results, sdkRoleRuns);
}

function missingCredentialsStage(
  specs: readonly McpToolExposureSpec[],
  roleRunContext: {
    agentCwd: string;
    mcpCwd: string;
    settingSources: CursorSettingSource[];
    sdkTimeoutMs: number;
    waitTimeoutMs: number;
    postCancelWaitMs: number;
  },
  message: string,
): McpToolExposureStageResult {
  const sdkRoleRuns = uniqueRoles(specs).map((role) =>
    syntheticSdkRoleRun({
      role,
      roleStatus: "failure",
      primaryFailureCode: "sdk_credentials_missing",
      message,
      ...roleRunContext,
    }),
  );
  return {
    stage: "sdk",
    status: "failure",
    failureCode: "sdk_credentials_missing",
    message: `${message}; live Cursor SDK MCP exposure probe cannot run`,
    results: specs.map((spec) => {
      const roleRunIndex = sdkRoleRuns.findIndex((roleRun) => roleRun.role === spec.role);
      return failureServerResult(
        spec,
        "sdk_credentials_missing",
        message,
        [],
        roleRunIndex,
      );
    }),
    sdkRoleRuns,
  };
}

export function normalizeMcpToolName(rawName: string, specs: readonly McpToolExposureSpec[] = MCP_TOOL_EXPOSURE_SPECS): string | null {
  for (const spec of specs) {
    const acceptedNames = [
      spec.expectedTool,
      `${spec.serverKey}.${spec.expectedTool}`,
      `${spec.serverKey}:${spec.expectedTool}`,
      `${spec.serverKey}/${spec.expectedTool}`,
      `mcp_${spec.serverKey}_${spec.expectedTool}`,
      `${spec.command}.${spec.expectedTool}`,
      `${spec.command}:${spec.expectedTool}`,
      `${spec.command}/${spec.expectedTool}`,
      `mcp_${spec.command}_${spec.expectedTool}`,
    ];
    if (acceptedNames.includes(rawName)) return spec.expectedTool;
  }
  return null;
}

export function redactSensitiveText(input: string, extraSecrets: string[] = []): string {
  let redacted = input;
  const secrets = [...extraSecrets, ...sensitiveEnvValues()].filter((value) => value.length >= 8);
  for (const secret of secrets) {
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, "$1 [REDACTED]")
    .replace(/\b(cursor|sk|ghp|gho|ghu|ghs|github_pat|lin)_[A-Za-z0-9_=-]{12,}/gi, "[REDACTED]")
    .replace(/\b([A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|AUTH)[A-Z0-9_]*)=([^\s,;]+)/gi, "$1=[REDACTED]")
    .replace(/("?(?:token|api[_-]?key|secret|password|authorization)"?\s*:\s*)"[^"]+"/gi, "$1\"[REDACTED]\"");
}

export function classifyToolListResult(
  stage: Extract<McpToolExposureStage, "subprocess">,
  spec: McpToolExposureSpec,
  rawToolNames: string[],
  envKeyNames: string[] = [],
): McpToolExposureServerResult {
  const normalizedToolNames = unique(
    rawToolNames
      .map((name) => normalizeMcpToolName(name, [spec]))
      .filter((name): name is string => name !== null),
  );
  if (rawToolNames.length === 0) {
    return {
      role: spec.role,
      serverKey: spec.serverKey,
      command: spec.command,
      expectedTool: spec.expectedTool,
      status: "failure",
      failureCode: "subprocess_missing_empty_name_mismatch",
      message: `${stageLabel(stage)} exposed no MCP tools for ${spec.serverKey}`,
      rawToolNames,
      normalizedToolNames,
      envKeyNames: sortedKeysFromList(envKeyNames),
    };
  }
  if (!normalizedToolNames.includes(spec.expectedTool)) {
    return {
      role: spec.role,
      serverKey: spec.serverKey,
      command: spec.command,
      expectedTool: spec.expectedTool,
      status: "failure",
      failureCode: "subprocess_missing_empty_name_mismatch",
      message: `${stageLabel(stage)} did not expose ${spec.expectedTool} for ${spec.serverKey}; raw tools: ${rawToolNames.join(", ")}`,
      rawToolNames,
      normalizedToolNames,
      envKeyNames: sortedKeysFromList(envKeyNames),
    };
  }
  return {
    role: spec.role,
    serverKey: spec.serverKey,
    command: spec.command,
    expectedTool: spec.expectedTool,
    status: "success",
    failureCode: null,
    message: `${stageLabel(stage)} exposed ${spec.expectedTool} for ${spec.serverKey}`,
    rawToolNames,
    normalizedToolNames,
    envKeyNames: sortedKeysFromList(envKeyNames),
  };
}

export async function listMcpToolsViaCommand(input: {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
}): Promise<string[]> {
  const child = spawn(input.command, input.args, {
    cwd: input.cwd,
    env: input.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, input.timeoutMs ?? 5_000);

  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin.end(
    [
      jsonRpcMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "symphony-mcp-tool-exposure-probe", version: "0.1.0" },
        },
      }),
      jsonRpcMessage({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
      jsonRpcMessage({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    ].join(""),
  );

  await new Promise<void>((resolve, reject) => {
    child.on("error", (error) => reject(new Error(redactSensitiveText(error.message))));
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error("MCP tools/list timed out"));
        return;
      }
      if (code !== 0) {
        reject(new Error(redactSensitiveText(Buffer.concat(stderr).toString("utf8").trim() || `MCP tools/list exited with ${code}`)));
        return;
      }
      resolve();
    });
  });

  const toolsList = parseJsonRpcResponses(Buffer.concat(stdout)).find((response) => response.id === 2);
  if (!toolsList) throw new Error("MCP tools/list did not return a response");
  if (toolsList.error) throw new Error(redactSensitiveText(toolsList.error.message));
  const result = asRecord(toolsList.result);
  return asRecordArray(result.tools)
    .map((tool) => tool.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
}

interface SdkRoleProbeResult {
  roleRun: SdkRoleRunResult;
  results: McpToolExposureServerResult[];
}

async function runSdkRoleProbe(
  config: ServiceConfig,
  options: {
    role: AgentRunRole;
    cliPath: string;
    apiKey: string;
    timeoutMs: number;
    waitTimeoutMs: number;
    postCancelWaitMs: number;
    cwd: string;
    mcpCwd: string;
    settingSources: CursorSettingSource[];
    roleRunIndex: number;
  },
): Promise<SdkRoleProbeResult> {
  const roleSpecs = specsForRoles([options.role]);
  const ctx = probeAgentRunContext(config, options.role, options.cwd);
  await writeRoleContexts(ctx);
  const envKeyNamesByServer = new Map(
    roleSpecs.map((spec) => [
      spec.serverKey,
      sortedKeys(buildMcpSubprocessEnvironment({ config, command: spec.command })),
    ]),
  );
  const traceFile = path.join(config.workspace.stateDir, ".mcp-exposure-probe", `${options.role}-${randomUUID()}.trace.jsonl`);
  const previousTraceFile = process.env.SYMPHONY_MCP_TRACE_FILE;
  let agent: SDKAgent | null = null;
  let run: Run | null = null;
  try {
    await fs.mkdir(path.dirname(traceFile), { recursive: true });
    await fs.rm(traceFile, { force: true });
    process.env.SYMPHONY_MCP_TRACE_FILE = traceFile;
    const roleMcpServers = cursorRoleMcpServers(ctx, { cliPath: options.cliPath, mcpCwd: options.mcpCwd });
    const createOptions = cursorAgentCreateOptions(ctx, options.apiKey, { mcpServers: roleMcpServers });
    createOptions.local = {
      ...createOptions.local,
      settingSources: options.settingSources as SettingSource[],
    };
    agent = await Agent.create(createOptions);
    run = await agent.send(
      "Reply with the MCP tools you can see for this run. Do not call any tools.",
      cursorAgentSendOptions(ctx, { mcpServers: roleMcpServers }),
    );
  } catch (error) {
    const roleRun = sdkRoleRunFromObservation(
      options.role,
      agentId(agent),
      runId(run),
      sdkDiagnostics({
        role: options.role,
        agentCwd: options.cwd,
        mcpCwd: options.mcpCwd,
        settingSources: options.settingSources,
        cursorMode: config.cursor.mode,
        sdkTimeoutMs: options.timeoutMs,
        waitTimeoutMs: options.waitTimeoutMs,
        postCancelWaitMs: options.postCancelWaitMs,
        startupSendError: `Cursor SDK startup/send failed for ${options.role}: ${redactSensitiveText(
          errorMessage(error),
          [options.apiKey],
        )}`,
      }),
      roleSpecs,
    );
    roleRun.sdkObservation.mcpTraceFile = null;
    roleRun.sdkObservation.mcpTraceMethodsByServer = await readMcpTraceMethods(traceFile);
    await fs.rm(traceFile, { force: true });
    restoreMcpTraceEnv(previousTraceFile);
    await agent?.[Symbol.asyncDispose]().catch(() => undefined);
    return {
      roleRun,
      results: roleSpecs.map((spec) =>
        deriveSdkPerSpecResult(spec, roleRun, options.roleRunIndex, envKeyNamesByServer.get(spec.serverKey)),
      ),
    };
  }

  try {
    const observedRoleRun = await observeSdkRoleRun({
      role: options.role,
      agentId: agentId(agent),
      runId: runId(run),
      run,
      roleSpecs,
      agentCwd: options.cwd,
      mcpCwd: options.mcpCwd,
      settingSources: options.settingSources,
      cursorMode: config.cursor.mode,
      sdkTimeoutMs: options.timeoutMs,
      waitTimeoutMs: options.waitTimeoutMs,
      postCancelWaitMs: options.postCancelWaitMs,
      secrets: [options.apiKey],
    });
    observedRoleRun.sdkObservation.mcpTraceFile = null;
    observedRoleRun.sdkObservation.mcpTraceMethodsByServer = await readMcpTraceMethods(traceFile);
    await fs.rm(traceFile, { force: true });
    const roleRun = sdkRoleRunFromObservation(
      options.role,
      observedRoleRun.agentId,
      observedRoleRun.runId,
      observedRoleRun.sdkObservation,
      roleSpecs,
    );
    return {
      roleRun,
      results: roleSpecs.map((spec) =>
        deriveSdkPerSpecResult(spec, roleRun, options.roleRunIndex, envKeyNamesByServer.get(spec.serverKey)),
      ),
    };
  } finally {
    restoreMcpTraceEnv(previousTraceFile);
    await agent?.[Symbol.asyncDispose]().catch(() => undefined);
  }
}

export async function observeSdkRoleRun(input: {
  role: AgentRunRole;
  agentId: string | null;
  runId: string | null;
  run: Pick<Run, "stream" | "wait" | "cancel">;
  roleSpecs?: readonly McpToolExposureSpec[];
  agentCwd: string;
  mcpCwd: string;
  settingSources: CursorSettingSource[];
  cursorMode?: string | null;
  sdkTimeoutMs: number;
  waitTimeoutMs: number;
  postCancelWaitMs: number;
  secrets?: string[];
}): Promise<SdkRoleRunResult> {
  const observation = sdkDiagnostics({
    role: input.role,
    agentCwd: input.agentCwd,
    mcpCwd: input.mcpCwd,
    settingSources: input.settingSources,
    cursorMode: input.cursorMode ?? null,
    sdkTimeoutMs: input.sdkTimeoutMs,
    waitTimeoutMs: input.waitTimeoutMs,
    postCancelWaitMs: input.postCancelWaitMs,
  });
  if (typeof input.run.stream !== "function") {
    observation.supportsStream = false;
    observation.streamStatus = "unsupported";
    return sdkRoleRunFromObservation(input.role, input.agentId, input.runId, observation, input.roleSpecs);
  }

  observation.supportsStream = true;
  const streamOutcome = await settleWithTimeout(drainSdkStream(input.run, observation, input.secrets ?? []), input.sdkTimeoutMs);
  if (streamOutcome.status === "timeout") {
    observation.timedOut = true;
    observation.streamStatus = "timeout";
    await cancelAndWaitAfterAbnormalStream(input.run, observation, input.postCancelWaitMs, true, input.secrets ?? []);
    return sdkRoleRunFromObservation(input.role, input.agentId, input.runId, observation, input.roleSpecs);
  }
  if (streamOutcome.status === "rejected") {
    observation.streamStatus = "error";
    observation.streamError = redactSensitiveText(errorMessage(streamOutcome.error), input.secrets ?? []);
    return sdkRoleRunFromObservation(input.role, input.agentId, input.runId, observation, input.roleSpecs);
  }
  if (observation.unexpectedToolCall) {
    observation.streamStatus = "unexpected_tool_call";
    await cancelAndWaitAfterAbnormalStream(input.run, observation, input.postCancelWaitMs, false, input.secrets ?? []);
    return sdkRoleRunFromObservation(input.role, input.agentId, input.runId, observation, input.roleSpecs);
  }

  observation.streamStatus = "drained";
  await observeSdkWait(input.run, observation, input.waitTimeoutMs, input.secrets ?? []);
  return sdkRoleRunFromObservation(input.role, input.agentId, input.runId, observation, input.roleSpecs);
}

async function drainSdkStream(
  run: Pick<Run, "stream">,
  observation: SdkToolDiagnostics,
  secrets: string[],
): Promise<void> {
  for await (const message of run.stream()) {
    recordSdkMessage(observation, message);
    const unexpectedToolCall = sdkToolCallName(message);
    if (unexpectedToolCall) {
      observation.unexpectedToolCall = redactSensitiveText(unexpectedToolCall, secrets);
      return;
    }
    if (isRecord(message) && message.type === "system") {
      observation.systemMessageCount += 1;
      if (Object.prototype.hasOwnProperty.call(message, "tools")) {
        observation.systemToolPayloadCount += 1;
        pushBounded(observation.rawSystemToolPayloads, sanitizeDiagnosticPayload(message.tools, secrets), 5);
        const extracted = extractSdkSystemToolNames(message.tools);
        observation.systemToolsCount += extracted.systemToolsCount;
        observation.namedToolCount += extracted.namedToolCount;
        observation.unnamedToolObjectCount += extracted.unnamedToolObjectCount;
        observation.malformedToolObjectCount += extracted.malformedToolObjectCount;
        observation.rawToolNames = unique([...observation.rawToolNames, ...extracted.rawToolNames]);
        observation.normalizedToolNames = unique([...observation.normalizedToolNames, ...extracted.normalizedToolNames]);
      }
    }
  }
}

async function observeSdkWait(
  run: Pick<Run, "wait">,
  observation: SdkToolDiagnostics,
  timeoutMs: number,
  secrets: string[],
): Promise<void> {
  if (typeof run.wait !== "function") {
    observation.supportsWait = false;
    observation.waitStatus = "unsupported";
    return;
  }
  observation.supportsWait = true;
  const waitOutcome = await settleWithTimeout(run.wait(), timeoutMs);
  if (waitOutcome.status === "timeout") {
    observation.waitStatus = "timeout";
    observation.waitError = `timed out after ${timeoutMs}ms waiting for Cursor SDK run completion`;
    return;
  }
  if (waitOutcome.status === "rejected") {
    observation.waitStatus = "error";
    observation.waitError = redactSensitiveText(errorMessage(waitOutcome.error), secrets);
    return;
  }
  observation.waitStatus = sdkWaitStatus(waitOutcome.value);
  if (observation.waitStatus !== "finished") {
    observation.waitError = sdkWaitResultMessage(waitOutcome.value);
  }
}

async function cancelAndWaitAfterAbnormalStream(
  run: Pick<Run, "wait" | "cancel">,
  observation: SdkToolDiagnostics,
  postCancelWaitMs: number,
  cancelledAfterTimeout: boolean,
  secrets: string[],
): Promise<void> {
  if (typeof run.cancel === "function") {
    await run.cancel().catch((error: unknown) => {
      observation.waitError = redactSensitiveText(errorMessage(error), secrets);
    });
  }
  observation.cancelledAfterTimeout = cancelledAfterTimeout;
  if (typeof run.wait !== "function") {
    observation.supportsWait = false;
    observation.waitStatus = "unsupported";
    return;
  }
  observation.supportsWait = true;
  const waitOutcome = await settleWithTimeout(run.wait(), postCancelWaitMs);
  if (waitOutcome.status === "timeout") {
    observation.waitStatus = "timeout";
    observation.waitError = `timed out after ${postCancelWaitMs}ms waiting after Cursor SDK run cancellation`;
    return;
  }
  if (waitOutcome.status === "rejected") {
    observation.waitStatus = "error";
    observation.waitError = redactSensitiveText(errorMessage(waitOutcome.error), secrets);
    return;
  }
  observation.waitStatus = sdkWaitStatus(waitOutcome.value);
}

async function writeRoleContexts(ctx: AgentRunContext): Promise<void> {
  if (ctx.role === "worker") {
    await writeCompletionReportMcpContext(completionReportContextFilePath(ctx), {
      issue: ctx.issue,
      activeRunId: null,
      role: "worker",
      token: null,
      expectedToken: null,
      sessionId: null,
      workspacePath: ctx.workspace.path,
      workspace: ctx.workspace,
      phase: "implementation",
    });
    return;
  }
  await writeReviewVerdictMcpContext(reviewVerdictContextFilePath(ctx), {
    issue: ctx.issue,
    activeRunId: null,
    role: "reviewer",
    token: null,
    expectedToken: null,
    reviewer: null,
    phase: "review",
  });
  await writeReviewFeedbackMcpContext(reviewFeedbackContextFilePath(ctx), {
    issue: ctx.issue,
    activeRunId: null,
    role: "reviewer",
    token: null,
    expectedToken: null,
    reviewer: null,
    phase: "review",
  });
}

function probeAgentRunContext(config: ServiceConfig, role: AgentRunRole, cwd: string): AgentRunContext {
  const issue: Issue = {
    id: `mcp-exposure-probe-${role}`,
    identifier: role === "worker" ? "MCP-WORKER" : "MCP-REVIEWER",
    title: "MCP exposure probe",
    description: null,
    priority: null,
    state: role === "worker" ? "In Progress" : "In Review",
    branchName: null,
    url: null,
    assigneeId: null,
    assignedToWorker: role === "worker",
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
  };
  const workspace: Workspace = {
    path: cwd,
    workspaceKey: `mcp-exposure-probe-${role}`,
    createdNow: false,
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    sourceKind: "probe",
    repoPath: config.workflowDir,
    ...(config.workspace.source.baseRef === undefined ? {} : { baseRef: config.workspace.source.baseRef }),
  };
  return {
    issue,
    role,
    attempt: null,
    workspace,
    config,
    turnNumber: 0,
    abortSignal: new AbortController().signal,
    logger: new StructuredLogger(() => undefined),
  };
}

function summarizeStage(
  stage: McpToolExposureStage,
  results: McpToolExposureServerResult[],
  sdkRoleRuns?: SdkRoleRunResult[],
): McpToolExposureStageResult {
  const failure = results.find((result) => result.status === "failure");
  if (failure) {
    return {
      stage,
      status: "failure",
      failureCode: failure.failureCode,
      message: results
        .filter((result) => result.status === "failure")
        .map((result) => result.message)
        .join("; "),
      results,
      ...(sdkRoleRuns === undefined ? {} : { sdkRoleRuns }),
    };
  }
  if (results.every((result) => result.status === "skipped")) {
    return {
      stage,
      status: "skipped",
      failureCode: null,
      message: results[0]?.message ?? `${stageLabel(stage)} skipped`,
      results,
      ...(sdkRoleRuns === undefined ? {} : { sdkRoleRuns }),
    };
  }
  return {
    stage,
    status: "success",
    failureCode: null,
    message: `${stageLabel(stage)} exposed all expected Symphony MCP tools`,
    results,
    ...(sdkRoleRuns === undefined ? {} : { sdkRoleRuns }),
  };
}

function reportFromStages(
  config: ServiceConfig,
  probeConfig: McpToolExposureProbeConfig,
  stages: McpToolExposureStageResult[],
): McpToolExposureReport {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    workflowPath: config.workflowPath,
    cliPath: probeConfig.cliPath,
    liveSmokeEnabled: probeConfig.liveSmokeEnabled,
    probeConfig,
    ok: stages.every((stage) => stage.status !== "failure"),
    stages,
  };
}

function specsForRoles(roles: AgentRunRole[]): McpToolExposureSpec[] {
  const roleSet = new Set(roles);
  return MCP_TOOL_EXPOSURE_SPECS.filter((spec) => roleSet.has(spec.role));
}

function uniqueRoles(specs: readonly McpToolExposureSpec[]): AgentRunRole[] {
  return unique(specs.map((spec) => spec.role));
}

export function extractSdkSystemToolNames(tools: unknown): SdkSystemToolExtraction {
  const extraction: SdkSystemToolExtraction = {
    rawToolNames: [],
    normalizedToolNames: [],
    systemToolsCount: 0,
    namedToolCount: 0,
    unnamedToolObjectCount: 0,
    malformedToolObjectCount: 0,
  };
  if (!Array.isArray(tools)) {
    extraction.malformedToolObjectCount = 1;
    return extraction;
  }
  extraction.systemToolsCount = tools.length;
  for (const tool of tools) {
    if (typeof tool === "string") {
      const name = tool.trim();
      if (name.length === 0) {
        extraction.unnamedToolObjectCount += 1;
        continue;
      }
      extraction.rawToolNames.push(name);
      extraction.namedToolCount += 1;
      continue;
    }
    if (isRecord(tool)) {
      if (typeof tool.name === "string" && tool.name.trim().length > 0) {
        extraction.rawToolNames.push(tool.name.trim());
        extraction.namedToolCount += 1;
      } else {
        extraction.unnamedToolObjectCount += 1;
      }
      continue;
    }
    extraction.malformedToolObjectCount += 1;
  }
  extraction.rawToolNames = unique(extraction.rawToolNames);
  extraction.normalizedToolNames = unique(
    extraction.rawToolNames
      .map((name) => normalizeMcpToolName(name))
      .filter((name): name is string => name !== null),
  );
  return extraction;
}

export function classifySdkRoleFailureCode(
  observation: SdkToolDiagnostics,
  roleSpecs: readonly McpToolExposureSpec[] = specsForRoles([observation.role]),
): McpToolExposureFailureCode | null {
  if (observation.startupSendError) return "sdk_startup_send_failure";
  if (observation.supportsStream === false) return "sdk_stream_unsupported";
  if (observation.unexpectedToolCall) return "unexpected_tool_call";
  if (observation.timedOut || observation.streamStatus === "timeout") return "sdk_stream_timeout";
  if (observation.streamStatus === "error") return "sdk_stream_failure";
  if (
    roleSpecs.every((spec) => mcpTraceMethodsForSpec(observation, spec).includes("tools/list")) &&
    !isSdkWaitFailure(observation.waitStatus)
  ) {
    return null;
  }
  if (observation.systemMessageCount === 0) return "sdk_no_system_messages";
  if (observation.systemToolPayloadCount === 0) return "sdk_system_tools_absent";
  if (observation.systemToolsCount === 0 && observation.malformedToolObjectCount === 0) return "sdk_system_tools_empty";
  if (
    observation.rawToolNames.length === 0 &&
    observation.normalizedToolNames.length === 0 &&
    (observation.unnamedToolObjectCount > 0 || observation.malformedToolObjectCount > 0)
  ) {
    return "sdk_system_tools_unnamed";
  }
  if (isSdkWaitFailure(observation.waitStatus)) return "sdk_wait_failure";
  if (!roleSpecs.every((spec) => observation.normalizedToolNames.includes(spec.expectedTool))) {
    return "sdk_system_tools_name_mismatch";
  }
  if (observation.waitStatus === "unsupported") return null;
  return null;
}

export function classifySdkRoleObservation(
  observation: SdkToolDiagnostics,
  roleSpecs: readonly McpToolExposureSpec[] = specsForRoles([observation.role]),
): Pick<SdkRoleRunResult, "primaryFailureCode" | "roleStatus"> {
  const primaryFailureCode = classifySdkRoleFailureCode(observation, roleSpecs);
  if (primaryFailureCode === null) return { primaryFailureCode, roleStatus: "success" };
  if (hasNonFatalSdkDiscoveryFailure(primaryFailureCode)) {
    const successfulSpecs = roleSpecs.filter(
      (spec) => observation.normalizedToolNames.includes(spec.expectedTool) || mcpTraceMethodsForSpec(observation, spec).includes("tools/list"),
    );
    if (successfulSpecs.length > 0) {
      return {
        primaryFailureCode,
        roleStatus: "partial",
      };
    }
  }
  if (primaryFailureCode === "sdk_system_tools_name_mismatch") {
    const successfulSpecs = roleSpecs.filter((spec) => observation.normalizedToolNames.includes(spec.expectedTool));
    return {
      primaryFailureCode,
      roleStatus: successfulSpecs.length > 0 ? "partial" : "failure",
    };
  }
  return { primaryFailureCode, roleStatus: "failure" };
}

export function classifySdkDiagnosticsForSpec(
  spec: McpToolExposureSpec,
  observation: SdkToolDiagnostics,
): Pick<McpToolExposureServerResult, "status" | "failureCode" | "message" | "rawToolNames" | "normalizedToolNames"> {
  const primaryFailureCode = classifySdkRoleFailureCode(observation, specsForRoles([spec.role]));
  const tracedToolsList = mcpTraceMethodsForSpec(observation, spec).includes("tools/list");
  if (
    primaryFailureCode === null ||
    (primaryFailureCode === "sdk_system_tools_name_mismatch" && observation.normalizedToolNames.includes(spec.expectedTool)) ||
    (tracedToolsList && primaryFailureCode !== null && hasNonFatalSdkDiscoveryFailure(primaryFailureCode))
  ) {
    return {
      status: "success",
      failureCode: null,
      message: tracedToolsList
        ? `Cursor SDK MCP client requested tools/list from ${spec.serverKey}`
        : `Cursor SDK system.tools exposed ${spec.expectedTool} for ${spec.serverKey}`,
      rawToolNames: tracedToolsList ? [spec.expectedTool] : observation.rawToolNames,
      normalizedToolNames: tracedToolsList ? [spec.expectedTool] : observation.normalizedToolNames,
    };
  }
  return {
    status: "failure",
    failureCode: primaryFailureCode,
    message: sdkFailureMessage(spec, observation, primaryFailureCode),
    rawToolNames: observation.rawToolNames,
    normalizedToolNames: observation.normalizedToolNames,
  };
}

export function deriveSdkPerSpecResult(
  spec: McpToolExposureSpec,
  roleRun: SdkRoleRunResult,
  sdkRoleRunIndex: number,
  envKeyNames: string[] = [],
): McpToolExposureServerResult {
  const classified = classifySdkDiagnosticsForSpec(spec, roleRun.sdkObservation);
  return {
    role: spec.role,
    serverKey: spec.serverKey,
    command: spec.command,
    expectedTool: spec.expectedTool,
    status: classified.status,
    failureCode: classified.failureCode,
    message: classified.message,
    rawToolNames: classified.rawToolNames,
    normalizedToolNames: classified.normalizedToolNames,
    envKeyNames: sortedKeysFromList(envKeyNames),
    sdkRoleRunRole: roleRun.role,
    sdkRoleRunIndex,
  };
}

function sdkRoleRunFromObservation(
  role: AgentRunRole,
  agentIdValue: string | null,
  runIdValue: string | null,
  sdkObservation: SdkToolDiagnostics,
  roleSpecs: readonly McpToolExposureSpec[] = specsForRoles([role]),
): SdkRoleRunResult {
  const classified = classifySdkRoleObservation(sdkObservation, roleSpecs);
  return {
    role,
    agentId: agentIdValue,
    runId: runIdValue,
    primaryFailureCode: classified.primaryFailureCode,
    roleStatus: classified.roleStatus,
    sdkObservation,
  };
}

function syntheticSdkRoleRun(input: {
  role: AgentRunRole;
  roleStatus: SdkRoleStatus;
  primaryFailureCode: McpToolExposureFailureCode | null;
  message: string;
  agentCwd: string;
  mcpCwd: string;
  settingSources: CursorSettingSource[];
  cursorMode?: string | null;
  sdkTimeoutMs: number;
  waitTimeoutMs: number;
  postCancelWaitMs: number;
}): SdkRoleRunResult {
  const sdkObservation = sdkDiagnostics({
    role: input.role,
    agentCwd: input.agentCwd,
    mcpCwd: input.mcpCwd,
    settingSources: input.settingSources,
    cursorMode: input.cursorMode ?? null,
    sdkTimeoutMs: input.sdkTimeoutMs,
    waitTimeoutMs: input.waitTimeoutMs,
    postCancelWaitMs: input.postCancelWaitMs,
    startupSendError: input.primaryFailureCode === "sdk_credentials_missing" ? input.message : null,
  });
  return {
    role: input.role,
    agentId: null,
    runId: null,
    primaryFailureCode: input.primaryFailureCode,
    roleStatus: input.roleStatus,
    sdkObservation,
  };
}

function skippedServerResult(
  spec: McpToolExposureSpec,
  message: string,
  sdkRoleRunIndex?: number,
): McpToolExposureServerResult {
  return {
    role: spec.role,
    serverKey: spec.serverKey,
    command: spec.command,
    expectedTool: spec.expectedTool,
    status: "skipped",
    failureCode: null,
    message,
    rawToolNames: [],
    normalizedToolNames: [],
    envKeyNames: [],
    ...(sdkRoleRunIndex === undefined ? {} : { sdkRoleRunRole: spec.role, sdkRoleRunIndex }),
  };
}

function failureServerResult(
  spec: McpToolExposureSpec,
  failureCode: McpToolExposureFailureCode,
  message: string,
  envKeyNames: string[] = [],
  sdkRoleRunIndex?: number,
): McpToolExposureServerResult {
  return {
    role: spec.role,
    serverKey: spec.serverKey,
    command: spec.command,
    expectedTool: spec.expectedTool,
    status: "failure",
    failureCode,
    message,
    rawToolNames: [],
    normalizedToolNames: [],
    envKeyNames: sortedKeysFromList(envKeyNames),
    ...(sdkRoleRunIndex === undefined ? {} : { sdkRoleRunRole: spec.role, sdkRoleRunIndex }),
  };
}

function sdkDiagnostics(input: {
  role: AgentRunRole;
  agentCwd: string;
  mcpCwd: string;
  settingSources: CursorSettingSource[];
  cursorMode?: string | null;
  sdkTimeoutMs: number;
  waitTimeoutMs: number;
  postCancelWaitMs: number;
  startupSendError?: string | null;
}): SdkToolDiagnostics {
  return {
    role: input.role,
    agentCwd: input.agentCwd,
    mcpCwd: input.mcpCwd,
    settingSources: input.settingSources,
    cursorMode: input.cursorMode ?? null,
    sdkTimeoutMs: input.sdkTimeoutMs,
    waitTimeoutMs: input.waitTimeoutMs,
    postCancelWaitMs: input.postCancelWaitMs,
    supportsStream: null,
    supportsWait: null,
    streamStatus: "not_started",
    waitStatus: null,
    waitError: null,
    timedOut: false,
    cancelledAfterTimeout: false,
    startupSendError: input.startupSendError ?? null,
    unexpectedToolCall: null,
    systemMessageCount: 0,
    systemToolPayloadCount: 0,
    systemToolsCount: 0,
    namedToolCount: 0,
    unnamedToolObjectCount: 0,
    malformedToolObjectCount: 0,
    rawSystemToolPayloads: [],
    rawToolNames: [],
    normalizedToolNames: [],
    mcpTraceFile: null,
    mcpTraceMethodsByServer: {},
    observedMessageTypes: [],
    messageTypeCounts: {},
    streamError: null,
  };
}

function sdkFailureMessage(
  spec: McpToolExposureSpec,
  observation: SdkToolDiagnostics,
  failureCode: McpToolExposureFailureCode,
): string {
  switch (failureCode) {
    case "sdk_credentials_missing":
      return "CURSOR_API_KEY is not set";
    case "sdk_startup_send_failure":
      return observation.startupSendError ?? `Cursor SDK startup/send failed for ${spec.role}`;
    case "sdk_stream_unsupported":
      return "Cursor SDK run does not expose stream()";
    case "sdk_stream_failure":
      return `Cursor SDK stream failed for ${spec.role}: ${observation.streamError ?? "unknown stream error"}`;
    case "sdk_stream_timeout":
      return `Cursor SDK stream timed out after ${observation.sdkTimeoutMs}ms for ${spec.role}`;
    case "sdk_no_system_messages":
      return `Cursor SDK stream ended without system messages for ${spec.role}`;
    case "sdk_system_tools_absent":
      return `Cursor SDK system messages did not include a tools payload for ${spec.role}`;
    case "sdk_system_tools_empty":
      return `Cursor SDK system.tools payload was empty for ${spec.role}`;
    case "sdk_system_tools_unnamed":
      return `Cursor SDK system.tools payload had unnamed or malformed tools for ${spec.role}`;
    case "sdk_system_tools_name_mismatch":
      return `Cursor SDK did not expose ${spec.expectedTool} for ${spec.serverKey}; raw tools: ${formatListForMessage(
        observation.rawToolNames,
      )}`;
    case "sdk_wait_failure":
      return `Cursor SDK wait failed for ${spec.role}: ${observation.waitError ?? observation.waitStatus ?? "unknown wait error"}`;
    case "sdk_wait_unsupported":
      return "Cursor SDK run does not expose wait()";
    case "unexpected_tool_call":
      return `Cursor SDK attempted unexpected tool call: ${observation.unexpectedToolCall ?? "unknown"}`;
    case "subprocess_spawn_list_failure":
    case "subprocess_missing_empty_name_mismatch":
      return `Unexpected SDK failure code ${failureCode}`;
  }
}

async function readMcpTraceMethods(traceFile: string): Promise<Record<string, string[]>> {
  try {
    const content = await fs.readFile(traceFile, "utf8");
    const methodsByServer: Record<string, string[]> = {};
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed) || typeof parsed.server !== "string" || typeof parsed.method !== "string") continue;
      methodsByServer[parsed.server] = unique([...(methodsByServer[parsed.server] ?? []), parsed.method]);
    }
    return methodsByServer;
  } catch {
    return {};
  }
}

function restoreMcpTraceEnv(previousTraceFile: string | undefined): void {
  if (previousTraceFile === undefined) {
    delete process.env.SYMPHONY_MCP_TRACE_FILE;
  } else {
    process.env.SYMPHONY_MCP_TRACE_FILE = previousTraceFile;
  }
}

function mcpTraceMethodsForSpec(observation: SdkToolDiagnostics, spec: McpToolExposureSpec): string[] {
  return observation.mcpTraceMethodsByServer[mcpSdkServerNameForCommand(spec.command)] ?? [];
}

function mcpSdkServerNameForCommand(command: McpSubprocessCommand): string {
  switch (command) {
    case "completion-report-mcp":
      return "symphony-completion-report";
    case "merge-conflict-resolution-mcp":
      return "symphony-merge-conflict-resolution";
    case "issue-breakdown-plan-mcp":
      return "symphony-issue-breakdown-plan";
    case "review-verdict-mcp":
      return "symphony-review-verdict";
    case "review-feedback-mcp":
      return "symphony-review-feedback";
    case "transcript-recall-mcp":
      return "symphony-transcript-recall";
  }
}

function hasNonFatalSdkDiscoveryFailure(failureCode: McpToolExposureFailureCode): boolean {
  return (
    failureCode === "sdk_no_system_messages" ||
    failureCode === "sdk_system_tools_absent" ||
    failureCode === "sdk_system_tools_empty" ||
    failureCode === "sdk_system_tools_unnamed" ||
    failureCode === "sdk_system_tools_name_mismatch"
  );
}

function isSdkWaitFailure(waitStatus: string | null): boolean {
  return waitStatus !== null && waitStatus !== "finished" && waitStatus !== "unsupported";
}

function recordSdkMessage(observation: SdkToolDiagnostics, message: unknown): void {
  const messageType = sdkMessageType(message);
  observation.messageTypeCounts[messageType] = (observation.messageTypeCounts[messageType] ?? 0) + 1;
  if (!observation.observedMessageTypes.includes(messageType)) {
    observation.observedMessageTypes.push(messageType);
  }
}

function sdkMessageType(message: unknown): string {
  if (isRecord(message) && typeof message.type === "string" && message.type.length > 0) return message.type;
  if (message === null) return "null";
  if (Array.isArray(message)) return "array";
  return typeof message;
}

function sdkWaitStatus(value: unknown): string {
  if (isRecord(value) && typeof value.status === "string" && value.status.length > 0) return value.status;
  return "finished";
}

function sdkWaitResultMessage(value: unknown): string | null {
  if (isRecord(value)) {
    if (typeof value.result === "string" && value.result.length > 0) return value.result;
    if (typeof value.error === "string" && value.error.length > 0) return value.error;
  }
  return null;
}

type SettledWithTimeout<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; error: unknown }
  | { status: "timeout" };

async function settleWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<SettledWithTimeout<T>> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race<SettledWithTimeout<T>>([
      promise.then(
        (value) => ({ status: "fulfilled", value }) as const,
        (error: unknown) => ({ status: "rejected", error }) as const,
      ),
      new Promise<{ status: "timeout" }>((resolve) => {
        timeout = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function sanitizeDiagnosticPayload(value: unknown, secrets: string[]): unknown {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return value;
    const redacted = redactSensitiveText(json, secrets);
    if (redacted.length > 4_000) return `${redacted.slice(0, 4_000)}...[truncated]`;
    return JSON.parse(redacted) as unknown;
  } catch {
    return redactSensitiveText(String(value), secrets);
  }
}

function pushBounded<T>(values: T[], value: T, limit: number): void {
  if (values.length < limit) values.push(value);
}

function agentId(agent: SDKAgent | null): string | null {
  return isRecord(agent) && typeof agent.agentId === "string" ? agent.agentId : null;
}

function runId(run: Run | null): string | null {
  return isRecord(run) && typeof run.id === "string" ? run.id : null;
}

function formatListForMessage(values: string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}

function sdkToolCallName(message: unknown): string | null {
  if (!isRecord(message)) return null;
  if (message.type === "tool_call" && typeof message.name === "string") return message.name;
  if (message.type === "assistant" && isRecord(message.message) && Array.isArray(message.message.content)) {
    const toolUse = message.message.content.find((block) => isRecord(block) && block.type === "tool_use" && typeof block.name === "string");
    if (isRecord(toolUse) && typeof toolUse.name === "string") return toolUse.name;
  }
  return null;
}

function stageLabel(stage: McpToolExposureStage): string {
  return stage === "subprocess" ? "MCP subprocess tools/list" : "Cursor SDK MCP discovery";
}

function sortedKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).sort((left, right) => left.localeCompare(right));
}

function sortedKeysFromList(value: string[]): string[] {
  return unique(value).sort((left, right) => left.localeCompare(right));
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function sensitiveEnvValues(): string[] {
  return Object.entries(process.env)
    .filter(([key, value]) => value && /(TOKEN|KEY|SECRET|PASSWORD|AUTH)/i.test(key))
    .map(([, value]) => value)
    .filter((value): value is string => typeof value === "string");
}

function jsonRpcMessage(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

interface JsonRpcResponse {
  id?: string | number | null;
  result?: unknown;
  error?: { message: string };
}

function parseJsonRpcResponses(output: Buffer): JsonRpcResponse[] {
  return output
    .toString("utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as JsonRpcResponse);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new Error("Expected JSON-RPC record");
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value) && value.every((item) => isRecord(item))) {
    return value as Array<Record<string, unknown>>;
  }
  throw new Error("Expected JSON-RPC record array");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

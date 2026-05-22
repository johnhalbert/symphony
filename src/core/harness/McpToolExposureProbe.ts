import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Agent, type Run, type SDKAgent } from "@cursor/sdk";
import type { ServiceConfig } from "../config/Config.js";
import type { AgentRunContext } from "./AgentHarness.js";
import { COMPLETION_REPORT_TOOL_NAME, writeCompletionReportMcpContext } from "./CompletionReportMcpServer.js";
import {
  buildMcpSubprocessEnvironment,
  buildMcpSubprocessServerConfig,
  type McpSubprocessCommand,
  type McpSubprocessServerConfig,
} from "./McpSubprocessEnvironment.js";
import { REVIEW_FEEDBACK_TOOL_NAME, writeReviewFeedbackMcpContext } from "./ReviewFeedbackMcpServer.js";
import { REVIEW_VERDICT_TOOL_NAME, writeReviewVerdictMcpContext } from "./ReviewVerdictMcpServer.js";
import type { AgentRunRole, Issue, Workspace } from "../types.js";
import { errorMessage } from "../errors.js";
import { StructuredLogger } from "../logging/StructuredLogger.js";
import {
  completionReportContextFilePath,
  completionReportMcpServerConfig,
  cursorAgentCreateOptions,
  cursorModelSelection,
  reviewFeedbackContextFilePath,
  reviewFeedbackMcpServerConfig,
  reviewVerdictContextFilePath,
  reviewVerdictMcpServerConfig,
} from "../../../cursor/src/CursorHarness.js";

export type McpToolExposureStage = "subprocess" | "sdk";
export type McpToolExposureStatus = "success" | "failure" | "skipped";
export type McpToolExposureFailureCode =
  | "subprocess_spawn_list_failure"
  | "subprocess_missing_empty_name_mismatch"
  | "sdk_credentials_missing"
  | "sdk_startup_send_failure"
  | "sdk_init_timeout_no_tools_empty_tools_name_mismatch"
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
}

export interface McpToolExposureStageResult {
  stage: McpToolExposureStage;
  status: McpToolExposureStatus;
  failureCode: McpToolExposureFailureCode | null;
  message: string;
  results: McpToolExposureServerResult[];
}

export interface McpToolExposureReport {
  version: 1;
  generatedAt: string;
  workflowPath: string;
  cliPath: string;
  liveSmokeEnabled: boolean;
  ok: boolean;
  stages: McpToolExposureStageResult[];
}

export interface McpToolExposureProbeOptions {
  config: ServiceConfig;
  cliPath: string;
  roles?: AgentRunRole[];
  liveSmokeEnabled?: boolean;
  sdkTimeoutMs?: number;
  sdkCwd?: string;
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
  const subprocess = await runSubprocessMcpToolExposureProbe(options.config, {
    cliPath: options.cliPath,
    roles,
  });
  const sdk = await runSdkMcpToolExposureProbe(options.config, {
    cliPath: options.cliPath,
    roles,
    enabled: options.liveSmokeEnabled ?? process.env.SYMPHONY_MCP_EXPOSURE_SMOKE === "1",
    timeoutMs: options.sdkTimeoutMs ?? 45_000,
    ...(options.sdkCwd === undefined ? {} : { cwd: options.sdkCwd }),
  });
  return reportFromStages(options.config, options.cliPath, sdk.status !== "skipped", [subprocess, sdk]);
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
    cwd?: string;
  },
): Promise<McpToolExposureStageResult> {
  const specs = specsForRoles(options.roles ?? ["worker", "reviewer"]);
  if (!options.enabled) {
    return {
      stage: "sdk",
      status: "skipped",
      failureCode: null,
      message: "Live Cursor SDK MCP exposure smoke skipped because SYMPHONY_MCP_EXPOSURE_SMOKE is not 1",
      results: specs.map((spec) => skippedServerResult(spec, "Live SDK probe skipped")),
    };
  }

  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) {
    return {
      stage: "sdk",
      status: "failure",
      failureCode: "sdk_credentials_missing",
      message: "CURSOR_API_KEY is not set; live Cursor SDK MCP exposure probe cannot run",
      results: specs.map((spec) => failureServerResult(spec, "sdk_credentials_missing", "CURSOR_API_KEY is not set")),
    };
  }

  const results: McpToolExposureServerResult[] = [];
  for (const role of uniqueRoles(specs)) {
    results.push(
      ...(await runSdkRoleProbe(config, {
        role,
        cliPath: options.cliPath,
        apiKey,
        timeoutMs: options.timeoutMs,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      })),
    );
  }
  return summarizeStage("sdk", results);
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
  stage: McpToolExposureStage,
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
      failureCode:
        stage === "subprocess" ? "subprocess_missing_empty_name_mismatch" : "sdk_init_timeout_no_tools_empty_tools_name_mismatch",
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
      failureCode:
        stage === "subprocess" ? "subprocess_missing_empty_name_mismatch" : "sdk_init_timeout_no_tools_empty_tools_name_mismatch",
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
      jsonRpcMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
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

async function runSdkRoleProbe(
  config: ServiceConfig,
  options: { role: AgentRunRole; cliPath: string; apiKey: string; timeoutMs: number; cwd?: string },
): Promise<McpToolExposureServerResult[]> {
  const roleSpecs = specsForRoles([options.role]);
  const ctx = probeAgentRunContext(config, options.role, options.cwd ?? config.workflowDir);
  await writeRoleContexts(ctx);
  const envKeyNamesByServer = new Map(
    roleSpecs.map((spec) => [
      spec.serverKey,
      sortedKeys(buildMcpSubprocessEnvironment({ config, command: spec.command })),
    ]),
  );
  let agent: SDKAgent | null = null;
  let run: Run | null = null;
  try {
    agent = await Agent.create(cursorAgentCreateOptions(ctx, options.apiKey));
    run = await agent.send("Observe available tools, do not call any tools, and wait.", {
      model: cursorModelSelection(ctx),
      local: { force: true },
      mcpServers: roleMcpServers(ctx, options.cliPath),
    });
  } catch (error) {
    return roleSpecs.map((spec) =>
      failureServerResult(
        spec,
        "sdk_startup_send_failure",
        `Cursor SDK startup/send failed for ${options.role}: ${redactSensitiveText(errorMessage(error), [options.apiKey])}`,
        envKeyNamesByServer.get(spec.serverKey),
      ),
    );
  }

  try {
    const observed = await observeSdkTools(run, options.timeoutMs);
    if (observed.unexpectedToolCall) {
      await run.cancel();
      return roleSpecs.map((spec) =>
        failureServerResult(
          spec,
          "unexpected_tool_call",
          `Cursor SDK attempted unexpected tool call: ${observed.unexpectedToolCall}`,
          envKeyNamesByServer.get(spec.serverKey),
        ),
      );
    }
    return roleSpecs.map((spec) =>
      classifyToolListResult("sdk", spec, observed.rawToolNames, envKeyNamesByServer.get(spec.serverKey) ?? []),
    );
  } catch (error) {
    return roleSpecs.map((spec) =>
      failureServerResult(
        spec,
        "sdk_init_timeout_no_tools_empty_tools_name_mismatch",
        `Cursor SDK did not expose tools for ${options.role}: ${redactSensitiveText(errorMessage(error), [options.apiKey])}`,
        envKeyNamesByServer.get(spec.serverKey),
      ),
    );
  } finally {
    await run?.cancel().catch(() => undefined);
    await agent?.[Symbol.asyncDispose]().catch(() => undefined);
  }
}

async function observeSdkTools(run: Run, timeoutMs: number): Promise<{ rawToolNames: string[]; unexpectedToolCall: string | null }> {
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms waiting for Cursor SDK system.tools`)), timeoutMs);
  });
  return Promise.race([observeSdkToolsFromStream(run), timeout]);
}

async function observeSdkToolsFromStream(run: Run): Promise<{ rawToolNames: string[]; unexpectedToolCall: string | null }> {
  for await (const message of run.stream()) {
    const unexpectedToolCall = sdkToolCallName(message);
    if (unexpectedToolCall) return { rawToolNames: [], unexpectedToolCall };
    if (isRecord(message) && message.type === "system") {
      const rawToolNames = sdkSystemToolNames(message.tools);
      if (rawToolNames.length > 0) return { rawToolNames, unexpectedToolCall: null };
    }
  }
  return { rawToolNames: [], unexpectedToolCall: null };
}

function roleMcpServers(ctx: AgentRunContext, cliPath: string): Record<string, McpSubprocessServerConfig> {
  if (ctx.role === "worker") {
    return {
      symphony: completionReportMcpServerConfig(ctx, completionReportContextFilePath(ctx), { cliPath }),
    };
  }
  return {
    symphony_review_verdict: reviewVerdictMcpServerConfig(ctx, reviewVerdictContextFilePath(ctx), { cliPath }),
    symphony_review_feedback: reviewFeedbackMcpServerConfig(ctx, reviewFeedbackContextFilePath(ctx), { cliPath }),
  };
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

function summarizeStage(stage: McpToolExposureStage, results: McpToolExposureServerResult[]): McpToolExposureStageResult {
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
    };
  }
  if (results.every((result) => result.status === "skipped")) {
    return {
      stage,
      status: "skipped",
      failureCode: null,
      message: results[0]?.message ?? `${stageLabel(stage)} skipped`,
      results,
    };
  }
  return {
    stage,
    status: "success",
    failureCode: null,
    message: `${stageLabel(stage)} exposed all expected Symphony MCP tools`,
    results,
  };
}

function reportFromStages(
  config: ServiceConfig,
  cliPath: string,
  liveSmokeEnabled: boolean,
  stages: McpToolExposureStageResult[],
): McpToolExposureReport {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    workflowPath: config.workflowPath,
    cliPath,
    liveSmokeEnabled,
    ok: stages.every((stage) => stage.status !== "failure"),
    stages,
  };
}

function specsForRoles(roles: AgentRunRole[]): McpToolExposureSpec[] {
  const roleSet = new Set(roles);
  return MCP_TOOL_EXPOSURE_SPECS.filter((spec) => roleSet.has(spec.role));
}

function uniqueRoles(specs: McpToolExposureSpec[]): AgentRunRole[] {
  return unique(specs.map((spec) => spec.role));
}

function skippedServerResult(spec: McpToolExposureSpec, message: string): McpToolExposureServerResult {
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
  };
}

function failureServerResult(
  spec: McpToolExposureSpec,
  failureCode: McpToolExposureFailureCode,
  message: string,
  envKeyNames: string[] = [],
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
  };
}

function sdkSystemToolNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  return tools
    .map((tool) => {
      if (typeof tool === "string") return tool;
      if (isRecord(tool) && typeof tool.name === "string") return tool.name;
      return null;
    })
    .filter((name): name is string => name !== null && name.length > 0);
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
  return stage === "subprocess" ? "MCP subprocess tools/list" : "Cursor SDK system.tools";
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
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

interface JsonRpcResponse {
  id?: string | number | null;
  result?: unknown;
  error?: { message: string };
}

function parseJsonRpcResponses(output: Buffer): JsonRpcResponse[] {
  const responses: JsonRpcResponse[] = [];
  let buffer = output;
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return responses;
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const contentLength = Number(header.match(/content-length:\s*(\d+)/i)?.[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + contentLength;
    if (!Number.isInteger(contentLength) || buffer.length < bodyEnd) return responses;
    const body = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
    responses.push(JSON.parse(body) as JsonRpcResponse);
    buffer = buffer.subarray(bodyEnd);
  }
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

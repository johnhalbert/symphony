import fs from "node:fs";
import path from "node:path";

import {
  buildFailClosedAgentCommandPolicyDecision,
  classifyAgentCommand,
  environmentKeysOnly,
  type AgentCommandPolicyClassifier,
  type AgentCommandPolicyDecision,
  type AgentCommandPolicyEnvironmentInput,
  type AgentCommandPolicyInput,
} from "./AgentCommandPolicy.js";

export const AGENT_COMMAND_POLICY_HOOK_STDIN_MAX_BYTES = 1024 * 1024;

const TOOL_INPUT_WORKING_DIRECTORY_KEYS = [
  "workdir",
  "cwd",
  "workingDirectory",
  "working_directory",
] as const;
const LOCAL_GIT_CONFIG_ENVIRONMENT_VALUE_KEYS = new Set([
  "HOME",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
]);
const UNRESOLVED_HOOK_WORKING_DIRECTORY = "<unresolved_hermes_tool_working_directory>";
const UNTRUSTED_HOOK_WORKING_DIRECTORY_MESSAGE =
  "Blocked worker/reviewer command: the Hermes pre_tool_call hook did not provide a trustworthy effective terminal working directory, so local command policy could not inspect the correct repository context. Use Symphony service-owned GitHub workflow actions for upstream GitHub activity.";
const UNINSPECTABLE_HOOK_WORKING_DIRECTORY_MESSAGE =
  "Blocked worker/reviewer command: the effective terminal working directory is not an inspectable directory, so local Git configuration could not be verified before this tool call. Use Symphony service-owned GitHub workflow actions for upstream GitHub activity.";

export interface AgentCommandPolicyHookRunnerContext {
  role?: string | undefined;
  phase?: string | undefined;
  issueId?: string | undefined;
  runId?: string | undefined;
  journalPath?: string | undefined;
  workingDirectory?: string | undefined;
  environment?: Record<string, string | undefined> | undefined;
  classify?: AgentCommandPolicyClassifier | undefined;
}

export interface AgentCommandPolicyHookRunnerStdioOptions extends AgentCommandPolicyHookRunnerContext {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  errorOutput?: NodeJS.WritableStream;
  maxStdinBytes?: number | undefined;
}

export interface HermesPreToolCallHookPayload {
  hook_event_name?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  session_id?: unknown;
  cwd?: unknown;
  extra?: unknown;
}

export interface HermesHookBlockResponse {
  action: "block";
  message: string;
}

export interface AgentCommandPolicyHookDecisionJournalEntry {
  version: 1;
  recordedAt: string;
  runId: string | null;
  issueId: string | null;
  requestKind: string | null;
  toolCallId: string | null;
  permissionOutcome: string | null;
  hookAction: string | null;
  decision: AgentCommandPolicyDecision;
}

export interface AgentCommandPolicyHookEvaluation {
  decision: AgentCommandPolicyDecision;
  policyInput: AgentCommandPolicyInput | null;
  hookResponse: HermesHookBlockResponse | null;
  journalEntry: AgentCommandPolicyHookDecisionJournalEntry | null;
  stdout: string;
}

interface AgentCommandPolicyHookDecisionMetadata {
  runId: string | null;
  issueId: string | null;
  requestKind: string | null;
  toolCallId: string | null;
  permissionOutcome: string | null;
  hookAction: string | null;
}

export async function evaluateAgentCommandPolicyHookPayload(
  stdinText: string,
  context: AgentCommandPolicyHookRunnerContext = {},
): Promise<AgentCommandPolicyHookEvaluation> {
  const parsed = parseHookPayload(stdinText, context);
  if (parsed.status === "error") return evaluationFromDecision(parsed.decision, null, defaultHookDecisionMetadata(context, parsed.decision));

  const metadata = hookDecisionMetadata(parsed.payload, context);

  const policyInput = buildPolicyInput(parsed.payload, context);
  if (policyInput.status === "error") return evaluationFromDecision(policyInput.decision, null, withHookDecisionOutcome(metadata, policyInput.decision));

  const classify = context.classify ?? classifyAgentCommand;
  try {
    const decision = failClosedForUninspectableLocalGitInspection(
      await classify(policyInput.input),
      policyInput.input,
    );
    return evaluationFromDecision(decision, policyInput.input, withHookDecisionOutcome(metadata, decision));
  } catch {
    const decision = buildFailClosedAgentCommandPolicyDecision({
      role: policyInput.input.role,
      phase: policyInput.input.phase,
      surface: policyInput.input.surface,
      workingDirectory: policyInput.input.workingDirectory,
      reasonKind: "classifier_error",
      commandClass: "agent_command_policy_classifier_error",
      message:
        "Blocked worker/reviewer command: the Symphony agent command policy classifier failed before this tool call could be verified. Use Symphony service-owned GitHub workflow actions for upstream GitHub activity.",
    });
    return evaluationFromDecision(decision, policyInput.input, withHookDecisionOutcome(metadata, decision));
  }
}

export async function runAgentCommandPolicyHookStdio(
  options: AgentCommandPolicyHookRunnerStdioOptions = {},
): Promise<AgentCommandPolicyHookEvaluation> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const stdinPayload = await readBounded(
    input,
    options.maxStdinBytes ?? AGENT_COMMAND_POLICY_HOOK_STDIN_MAX_BYTES,
  );
  const evaluation =
    stdinPayload.status === "oversized"
      ? evaluationFromDecision(
          buildOversizedHookPayloadDecision(options, stdinPayload.maxBytes),
          null,
          defaultHookDecisionMetadata(options, buildOversizedHookPayloadDecision(options, stdinPayload.maxBytes)),
        )
      : await evaluateAgentCommandPolicyHookPayload(stdinPayload.text, options);
  if (options.journalPath && evaluation.journalEntry) {
    appendHookDecisionJournalEntry(options.journalPath, evaluation.journalEntry);
  }
  if (evaluation.stdout.length > 0) {
    output.write(evaluation.stdout);
  }
  return evaluation;
}

export function mapAgentCommandPolicyDecisionToHermesHookResponse(
  decision: AgentCommandPolicyDecision,
): HermesHookBlockResponse | null {
  if (decision.outcome === "allow") return null;
  return {
    action: "block",
    message: decision.message,
  };
}

function buildOversizedHookPayloadDecision(
  context: AgentCommandPolicyHookRunnerContext,
  maxBytes: number,
): AgentCommandPolicyDecision {
  return buildFailClosedAgentCommandPolicyDecision({
    role: context.role,
    phase: context.phase,
    surface: "unknown",
    workingDirectory: context.workingDirectory,
    reasonKind: "oversized_hook_payload",
    commandClass: "oversized_hermes_hook_payload",
    message: `Blocked worker/reviewer command: the Hermes pre_tool_call hook payload exceeded the maximum accepted size (${maxBytes} bytes). Use Symphony service-owned GitHub workflow actions for upstream GitHub activity.`,
  });
}

function parseHookPayload(
  stdinText: string,
  context: AgentCommandPolicyHookRunnerContext,
):
  | { status: "ok"; payload: HermesPreToolCallHookPayload }
  | { status: "error"; decision: AgentCommandPolicyDecision } {
  const trimmed = stdinText.trim();
  if (trimmed.length === 0) {
    return {
      status: "error",
      decision: buildFailClosedAgentCommandPolicyDecision({
        role: context.role,
        phase: context.phase,
        surface: "unknown",
        workingDirectory: context.workingDirectory,
        reasonKind: "malformed_hook_payload",
        commandClass: "missing_hermes_hook_payload",
        message:
          "Blocked worker/reviewer command: the Hermes pre_tool_call hook did not provide a JSON payload. Use Symphony service-owned GitHub workflow actions for upstream GitHub activity.",
      }),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return {
      status: "error",
      decision: buildFailClosedAgentCommandPolicyDecision({
        role: context.role,
        phase: context.phase,
        surface: "unknown",
        workingDirectory: context.workingDirectory,
        reasonKind: "malformed_hook_payload",
        commandClass: "malformed_hermes_hook_payload",
        message:
          "Blocked worker/reviewer command: the Hermes pre_tool_call hook payload was not valid JSON. Use Symphony service-owned GitHub workflow actions for upstream GitHub activity.",
      }),
    };
  }

  if (!isRecord(parsed)) {
    return {
      status: "error",
      decision: buildFailClosedAgentCommandPolicyDecision({
        role: context.role,
        phase: context.phase,
        surface: "unknown",
        workingDirectory: context.workingDirectory,
        reasonKind: "malformed_hook_payload",
        commandClass: "malformed_hermes_hook_payload",
        message:
          "Blocked worker/reviewer command: the Hermes pre_tool_call hook payload was not a JSON object. Use Symphony service-owned GitHub workflow actions for upstream GitHub activity.",
      }),
    };
  }

  return { status: "ok", payload: parsed };
}

function buildPolicyInput(
  payload: HermesPreToolCallHookPayload,
  context: AgentCommandPolicyHookRunnerContext,
):
  | { status: "ok"; input: AgentCommandPolicyInput }
  | { status: "error"; decision: AgentCommandPolicyDecision } {
  const hookEventName = stringValue(payload.hook_event_name);
  const toolName = stringValue(payload.tool_name);
  const role = nonEmptyString(context.role);
  const phase = nonEmptyString(context.phase);
  const workingDirectory = effectiveHookWorkingDirectory(payload, context);

  if (hookEventName !== "pre_tool_call") {
    return missingContextDecision({
      role,
      phase,
      surface: toolName ?? "unknown",
      workingDirectory: workingDirectory.workingDirectory,
      commandClass: "unsupported_hermes_hook_event",
      message:
        "Blocked worker/reviewer command: agent command policy hook was invoked for an unsupported Hermes hook event. Use Symphony service-owned GitHub workflow actions for upstream GitHub activity.",
    });
  }

  if (toolName === null) {
    return missingContextDecision({
      role,
      phase,
      surface: "unknown",
      workingDirectory: workingDirectory.workingDirectory,
      commandClass: "missing_hermes_tool_name",
      message:
        "Blocked worker/reviewer command: Hermes pre_tool_call payload did not identify the tool name. Use Symphony service-owned GitHub workflow actions for upstream GitHub activity.",
    });
  }

  if (role === null || phase === null) {
    return missingContextDecision({
      role,
      phase,
      surface: toolName,
      workingDirectory: workingDirectory.workingDirectory,
      commandClass: "missing_agent_command_policy_context",
      message:
        "Blocked worker/reviewer command: Symphony agent command policy context is incomplete. Use Symphony service-owned GitHub workflow actions for upstream GitHub activity.",
    });
  }

  if (workingDirectory.status === "error") {
    return missingContextDecision({
      role,
      phase,
      surface: toolName,
      workingDirectory: workingDirectory.workingDirectory,
      commandClass: workingDirectory.commandClass,
      message: workingDirectory.message,
    });
  }

  const rawInput = isRecord(payload.tool_input) ? payload.tool_input : {};
  const hookEnvironment = context.environment ?? process.env;
  const input: AgentCommandPolicyInput = {
    role,
    phase,
    surface: toolName,
    workingDirectory: workingDirectory.workingDirectory,
    rawInput,
    environment: buildHookPolicyEnvironment(hookEnvironment),
  };

  const runId = nonEmptyString(context.runId) ?? stringValue(payload.session_id);
  if (runId !== null) input.runId = runId;
  const issueId = nonEmptyString(context.issueId);
  if (issueId !== null) input.issueId = issueId;
  const toolCallId = hookToolCallId(payload.extra);
  if (toolCallId !== null) input.attemptId = toolCallId;

  return {
    status: "ok",
    input,
  };
}

type HookWorkingDirectoryResolution =
  | { status: "ok"; workingDirectory: string }
  | { status: "error"; workingDirectory: string; commandClass: string; message: string };

type HookToolWorkingDirectoryResolution =
  | { status: "absent" }
  | { status: "ok"; workingDirectory: string }
  | { status: "error"; commandClass: string; message: string };

function effectiveHookWorkingDirectory(
  payload: HermesPreToolCallHookPayload,
  context: AgentCommandPolicyHookRunnerContext,
): HookWorkingDirectoryResolution {
  const toolInputCwd = toolInputWorkingDirectory(payload.tool_input);
  if (toolInputCwd.status === "error") {
    return {
      status: "error",
      workingDirectory: UNRESOLVED_HOOK_WORKING_DIRECTORY,
      commandClass: toolInputCwd.commandClass,
      message: toolInputCwd.message,
    };
  }

  if (toolInputCwd.status === "ok" && isAbsoluteHookPath(toolInputCwd.workingDirectory)) {
    return { status: "ok", workingDirectory: path.normalize(toolInputCwd.workingDirectory) };
  }

  const baseDirectory = trustedHookBaseWorkingDirectory(payload, context);
  if (baseDirectory === null) {
    return {
      status: "error",
      workingDirectory: UNRESOLVED_HOOK_WORKING_DIRECTORY,
      commandClass:
        toolInputCwd.status === "ok"
          ? "unresolved_relative_hermes_tool_working_directory"
          : "missing_hermes_tool_working_directory_context",
      message: UNTRUSTED_HOOK_WORKING_DIRECTORY_MESSAGE,
    };
  }

  if (toolInputCwd.status === "ok") {
    return { status: "ok", workingDirectory: resolveWorkingDirectory(toolInputCwd.workingDirectory, baseDirectory) };
  }

  return { status: "ok", workingDirectory: baseDirectory };
}

function toolInputWorkingDirectory(toolInput: unknown): HookToolWorkingDirectoryResolution {
  if (!isRecord(toolInput)) return { status: "absent" };
  const presentKeys = TOOL_INPUT_WORKING_DIRECTORY_KEYS.filter((key) =>
    Object.prototype.hasOwnProperty.call(toolInput, key),
  );
  if (presentKeys.length === 0) return { status: "absent" };
  if (presentKeys.length > 1) {
    return {
      status: "error",
      commandClass: "ambiguous_hermes_tool_working_directory",
      message: UNTRUSTED_HOOK_WORKING_DIRECTORY_MESSAGE,
    };
  }

  const key = presentKeys[0];
  const rawValue = key === undefined ? undefined : toolInput[key];
  if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
    return {
      status: "error",
      commandClass: "malformed_hermes_tool_working_directory",
      message: UNTRUSTED_HOOK_WORKING_DIRECTORY_MESSAGE,
    };
  }

  return { status: "ok", workingDirectory: rawValue.trim() };
}

function resolveWorkingDirectory(candidate: string, baseDirectory: string): string {
  if (isAbsoluteHookPath(candidate)) return path.normalize(candidate);
  return path.resolve(baseDirectory, candidate);
}

function trustedHookBaseWorkingDirectory(
  payload: HermesPreToolCallHookPayload,
  context: AgentCommandPolicyHookRunnerContext,
): string | null {
  return trustedWorkingDirectoryValue(payload.cwd) ?? trustedWorkingDirectoryValue(context.workingDirectory);
}

function trustedWorkingDirectoryValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmedValue = value.trim();
  if (trimmedValue.length === 0 || !isAbsoluteHookPath(trimmedValue)) return null;
  return trimmedValue;
}

function isAbsoluteHookPath(filePath: string): boolean {
  return path.isAbsolute(filePath) || /^[A-Za-z]:[\\/]/u.test(filePath) || /^\\\\/u.test(filePath);
}

function buildHookPolicyEnvironment(
  environment: Record<string, string | undefined>,
): AgentCommandPolicyEnvironmentInput {
  const keysOnly = environmentKeysOnly(environment);
  const inherited = selectedLocalGitConfigEnvironmentValues(environment);
  return Object.keys(inherited).length === 0
    ? { keysOnly }
    : { keysOnly, inherited };
}

function selectedLocalGitConfigEnvironmentValues(
  environment: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const inherited: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (!LOCAL_GIT_CONFIG_ENVIRONMENT_VALUE_KEYS.has(key.trim().toUpperCase())) continue;
    if (value === undefined || value.trim().length === 0) continue;
    inherited[key] = value;
  }
  return inherited;
}

function failClosedForUninspectableLocalGitInspection(
  decision: AgentCommandPolicyDecision,
  input: AgentCommandPolicyInput,
): AgentCommandPolicyDecision {
  if (
    decision.outcome !== "allow" ||
    decision.reasonKind !== "local_only_inspection" ||
    decision.commandClass !== "local_git_inspection" ||
    isDirectory(input.workingDirectory)
  ) {
    return decision;
  }

  return buildFailClosedAgentCommandPolicyDecision({
    role: input.role,
    phase: input.phase,
    surface: input.surface,
    workingDirectory: input.workingDirectory,
    reasonKind: "missing_hook_context",
    commandClass: "uninspectable_hermes_tool_working_directory",
    message: UNINSPECTABLE_HOOK_WORKING_DIRECTORY_MESSAGE,
  });
}

function isDirectory(directoryPath: string): boolean {
  try {
    return fs.statSync(directoryPath).isDirectory();
  } catch {
    return false;
  }
}

function missingContextDecision(input: {
  role: string | null;
  phase: string | null;
  surface: string;
  workingDirectory: string;
  commandClass: string;
  message: string;
}): { status: "error"; decision: AgentCommandPolicyDecision } {
  return {
    status: "error",
    decision: buildFailClosedAgentCommandPolicyDecision({
      role: input.role ?? undefined,
      phase: input.phase ?? undefined,
      surface: input.surface,
      workingDirectory: input.workingDirectory,
      reasonKind: "missing_hook_context",
      commandClass: input.commandClass,
      message: input.message,
    }),
  };
}

function evaluationFromDecision(
  decision: AgentCommandPolicyDecision,
  policyInput: AgentCommandPolicyInput | null,
  metadata: AgentCommandPolicyHookDecisionMetadata,
): AgentCommandPolicyHookEvaluation {
  const hookResponse = mapAgentCommandPolicyDecisionToHermesHookResponse(decision);
  return {
    decision,
    policyInput,
    hookResponse,
    journalEntry: {
      version: 1,
      recordedAt: new Date().toISOString(),
      runId: metadata.runId,
      issueId: metadata.issueId,
      requestKind: metadata.requestKind,
      toolCallId: metadata.toolCallId,
      permissionOutcome: metadata.permissionOutcome,
      hookAction: metadata.hookAction,
      decision,
    },
    stdout: hookResponse === null ? "" : `${JSON.stringify(hookResponse)}\n`,
  };
}

function appendHookDecisionJournalEntry(journalPath: string, entry: AgentCommandPolicyHookDecisionJournalEntry): void {
  try {
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.appendFileSync(journalPath, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to append command policy decision journal at ${journalPath}: ${message}`);
  }
}

function hookDecisionMetadata(
  payload: HermesPreToolCallHookPayload,
  context: AgentCommandPolicyHookRunnerContext,
): AgentCommandPolicyHookDecisionMetadata {
  return {
    runId: nonEmptyString(context.runId) ?? stringValue(payload.session_id),
    issueId: nonEmptyString(context.issueId),
    requestKind: hookRequestKind(stringValue(payload.tool_name), stringValue(payload.hook_event_name)),
    toolCallId: hookToolCallId(payload.extra),
    permissionOutcome: null,
    hookAction: null,
  };
}

function defaultHookDecisionMetadata(
  context: AgentCommandPolicyHookRunnerContext,
  decision: AgentCommandPolicyDecision,
): AgentCommandPolicyHookDecisionMetadata {
  return withHookDecisionOutcome(
    {
      runId: nonEmptyString(context.runId),
      issueId: nonEmptyString(context.issueId),
      requestKind: null,
      toolCallId: null,
      permissionOutcome: null,
      hookAction: null,
    },
    decision,
  );
}

function withHookDecisionOutcome(
  metadata: AgentCommandPolicyHookDecisionMetadata,
  decision: AgentCommandPolicyDecision,
): AgentCommandPolicyHookDecisionMetadata {
  return {
    ...metadata,
    permissionOutcome: hookPermissionOutcome(decision),
    hookAction: decision.outcome === "deny" ? "block" : null,
  };
}

function hookPermissionOutcome(decision: AgentCommandPolicyDecision): string {
  if (decision.outcome === "allow") return "allowed";
  return decision.reasonKind === "malformed_hook_payload" ||
    decision.reasonKind === "oversized_hook_payload" ||
    decision.reasonKind === "missing_hook_context" ||
    decision.reasonKind === "classifier_error"
    ? "fail_closed"
    : "denied";
}

function hookRequestKind(toolName: string | null, hookEventName: string | null): string | null {
  if (toolName === "terminal") return "terminal_execute";
  if (toolName === "execute_code") return "execute_code";
  return hookEventName;
}

function hookToolCallId(extra: unknown): string | null {
  if (!isRecord(extra)) return null;
  return stringValue(extra.tool_call_id) ?? stringValue(extra.toolCallId);
}

type BoundedStdinReadResult =
  | { status: "ok"; text: string }
  | { status: "oversized"; maxBytes: number };

async function readBounded(input: NodeJS.ReadableStream, maxBytes: number): Promise<BoundedStdinReadResult> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let oversized = false;

  for await (const chunk of input as AsyncIterable<string | Buffer>) {
    if (oversized) continue;

    const chunkByteLength =
      typeof chunk === "string" ? Buffer.byteLength(chunk, "utf8") : chunk.byteLength;
    const nextTotalBytes = totalBytes + chunkByteLength;
    if (nextTotalBytes > maxBytes) {
      oversized = true;
      chunks.length = 0;
      continue;
    }

    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
    totalBytes = nextTotalBytes;
  }

  if (oversized) return { status: "oversized", maxBytes };
  return { status: "ok", text: Buffer.concat(chunks, totalBytes).toString("utf8") };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nonEmptyString(value: string | undefined): string | null {
  return value === undefined || value.trim().length === 0 ? null : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

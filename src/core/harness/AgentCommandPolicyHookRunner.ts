import {
  buildFailClosedAgentCommandPolicyDecision,
  classifyAgentCommand,
  environmentKeysOnly,
  type AgentCommandPolicyClassifier,
  type AgentCommandPolicyDecision,
  type AgentCommandPolicyInput,
} from "./AgentCommandPolicy.js";

export interface AgentCommandPolicyHookRunnerContext {
  role?: string | undefined;
  phase?: string | undefined;
  issueId?: string | undefined;
  runId?: string | undefined;
  workingDirectory?: string | undefined;
  environment?: Record<string, string | undefined> | undefined;
  classify?: AgentCommandPolicyClassifier | undefined;
}

export interface AgentCommandPolicyHookRunnerStdioOptions extends AgentCommandPolicyHookRunnerContext {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  errorOutput?: NodeJS.WritableStream;
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

export interface AgentCommandPolicyHookEvaluation {
  decision: AgentCommandPolicyDecision;
  policyInput: AgentCommandPolicyInput | null;
  hookResponse: HermesHookBlockResponse | null;
  stdout: string;
}

export async function evaluateAgentCommandPolicyHookPayload(
  stdinText: string,
  context: AgentCommandPolicyHookRunnerContext = {},
): Promise<AgentCommandPolicyHookEvaluation> {
  const parsed = parseHookPayload(stdinText, context);
  if (parsed.status === "error") return evaluationFromDecision(parsed.decision, null);

  const policyInput = buildPolicyInput(parsed.payload, context);
  if (policyInput.status === "error") return evaluationFromDecision(policyInput.decision, null);

  const classify = context.classify ?? classifyAgentCommand;
  try {
    const decision = await classify(policyInput.input);
    return evaluationFromDecision(decision, policyInput.input);
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
    return evaluationFromDecision(decision, policyInput.input);
  }
}

export async function runAgentCommandPolicyHookStdio(
  options: AgentCommandPolicyHookRunnerStdioOptions = {},
): Promise<AgentCommandPolicyHookEvaluation> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const stdinText = await readAll(input);
  const evaluation = await evaluateAgentCommandPolicyHookPayload(stdinText, options);
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
  const workingDirectory = stringValue(payload.cwd) ?? context.workingDirectory ?? process.cwd();

  if (hookEventName !== "pre_tool_call") {
    return missingContextDecision({
      role,
      phase,
      surface: toolName ?? "unknown",
      workingDirectory,
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
      workingDirectory,
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
      workingDirectory,
      commandClass: "missing_agent_command_policy_context",
      message:
        "Blocked worker/reviewer command: Symphony agent command policy context is incomplete. Use Symphony service-owned GitHub workflow actions for upstream GitHub activity.",
    });
  }

  const rawInput = isRecord(payload.tool_input) ? payload.tool_input : {};
  const input: AgentCommandPolicyInput = {
    role,
    phase,
    surface: toolName,
    workingDirectory,
    rawInput,
    environment: { keysOnly: environmentKeysOnly(context.environment ?? process.env) },
  };
  const runId = nonEmptyString(context.runId) ?? stringValue(payload.session_id);
  if (runId !== null) input.runId = runId;
  const issueId = nonEmptyString(context.issueId);
  if (issueId !== null) input.issueId = issueId;

  return {
    status: "ok",
    input,
  };
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
): AgentCommandPolicyHookEvaluation {
  const hookResponse = mapAgentCommandPolicyDecisionToHermesHookResponse(decision);
  return {
    decision,
    policyInput,
    hookResponse,
    stdout: hookResponse === null ? "" : `${JSON.stringify(hookResponse)}\n`,
  };
}

async function readAll(input: NodeJS.ReadableStream): Promise<string> {
  input.setEncoding("utf8");
  let body = "";
  for await (const chunk of input as AsyncIterable<string | Buffer>) {
    body += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  }
  return body;
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

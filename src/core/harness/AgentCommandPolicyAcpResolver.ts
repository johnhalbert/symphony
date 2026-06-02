import {
  classifyAgentCommand,
  environmentKeysOnly,
  type AgentCommandPolicyClassifier,
  type AgentCommandPolicyInput,
  type AgentCommandPolicyRawInput,
} from "./AgentCommandPolicy.js";
import type {
  HermesAcpPermissionResolver,
  HermesAcpPermissionResolverInput,
} from "../../../hermes/src/HermesAcpHarness.js";

export interface AgentCommandPolicyAcpResolverOptions {
  classify?: AgentCommandPolicyClassifier | undefined;
  environment?: Record<string, string | undefined> | undefined;
}

export type AgentCommandPolicyAcpResolverInputResult =
  | { status: "ok"; input: AgentCommandPolicyInput }
  | { status: "error"; reason: string };

export function createAgentCommandPolicyAcpResolver(
  options: AgentCommandPolicyAcpResolverOptions = {},
): HermesAcpPermissionResolver {
  const classify = options.classify ?? classifyAgentCommand;
  return async (input) => {
    if (input.request.requestKind !== "terminal_execute") {
      return { optionId: null, reason: "unsupported_agent_command_policy_permission_kind" };
    }

    const policyInput = buildAgentCommandPolicyInputForAcpPermission(input, {
      environment: options.environment ?? process.env,
    });
    if (policyInput.status === "error") return { optionId: null, reason: policyInput.reason };

    try {
      const decision = await classify(policyInput.input);
      if (decision.outcome === "deny") return { optionId: null, reason: decision.reasonKind };
      return { optionId: "allow_once", reason: decision.reasonKind };
    } catch {
      return { optionId: null, reason: "classifier_error" };
    }
  };
}

export function buildAgentCommandPolicyInputForAcpPermission(
  input: HermesAcpPermissionResolverInput,
  options: Pick<AgentCommandPolicyAcpResolverOptions, "environment"> = {},
): AgentCommandPolicyAcpResolverInputResult {
  if (input.request.requestKind !== "terminal_execute") {
    return { status: "error", reason: "unsupported_agent_command_policy_permission_kind" };
  }

  const phase = input.ctx.runPhase;
  if (!phase) return { status: "error", reason: "missing_agent_command_policy_context" };

  const rawInput = agentCommandPolicyRawInputFromAcpToolCall(input.request.toolCall);
  return {
    status: "ok",
    input: {
      attemptId: input.request.toolCallId,
      runId: input.runId,
      issueId: input.ctx.issue.id,
      role: input.ctx.role,
      phase,
      surface: "terminal_execute",
      workingDirectory: input.ctx.workspace.path,
      rawInput,
      environment: { keysOnly: environmentKeysOnly(options.environment ?? process.env) },
    },
  };
}

function agentCommandPolicyRawInputFromAcpToolCall(toolCall: Record<string, unknown> | null): AgentCommandPolicyRawInput {
  const commandRecord = commandRecordFromAcpToolCall(toolCall);
  if (commandRecord.status === "missing") return {};
  if (commandRecord.status === "ambiguous") return commandRecord.rawInput;
  return {
    kind: "command",
    command: commandRecord.command,
    params: toolCall,
  };
}

type AcpCommandRecordResult =
  | { status: "ok"; command: string }
  | { status: "ambiguous"; rawInput: Record<string, unknown> }
  | { status: "missing" };

function commandRecordFromAcpToolCall(toolCall: Record<string, unknown> | null): AcpCommandRecordResult {
  if (!toolCall) return { status: "missing" };

  const rawInput = recordField(toolCall, "rawInput", "raw_input");
  const commandFields = rawInput ? commandFieldsFromRecord(rawInput) : [];
  const topLevelFields = commandFieldsFromRecord(toolCall);
  const contentCommand = commandFromStructuredContent(unknownField(toolCall, "content"));

  const commandSources = [...commandFields, ...topLevelFields];
  if (contentCommand !== null) commandSources.push({ key: "content", value: contentCommand });

  if (commandSources.length === 0) return { status: "missing" };
  if (commandSources.length > 1) return { status: "ambiguous", rawInput: ambiguousCommandInput(commandSources) };
  return { status: "ok", command: commandSources[0]?.value ?? "" };
}

function commandFieldsFromRecord(record: Record<string, unknown>): Array<{ key: string; value: string }> {
  const fields: Array<{ key: string; value: string }> = [];
  for (const key of ["command", "cmd", "script"] as const) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const value = record[key];
    if (typeof value === "string") fields.push({ key, value });
    else fields.push({ key, value: "" });
  }
  return fields;
}

function ambiguousCommandInput(fields: Array<{ key: string; value: string }>): Record<string, unknown> {
  const rawInput: Record<string, unknown> = {};
  for (const [index, field] of fields.entries()) {
    const key = index === 0 ? "command" : "cmd";
    rawInput[key] = field.value;
  }
  return rawInput;
}

function commandFromStructuredContent(value: unknown): string | null {
  if (typeof value === "string") return nonEmptyString(value);
  if (Array.isArray(value)) {
    const commands = value.map(commandFromStructuredContent).filter((command): command is string => command !== null);
    return commands.length === 1 ? commands[0] ?? null : null;
  }
  if (!isRecord(value)) return null;
  return nonEmptyString(unknownField(value, "text", "command", "cmd", "script"));
}

function recordField(record: Record<string, unknown>, ...keys: string[]): Record<string, unknown> | null {
  const value = unknownField(record, ...keys);
  return isRecord(value) ? value : null;
}

function unknownField(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];
  }
  return undefined;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

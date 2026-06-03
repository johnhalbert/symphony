import {
  classifyAgentCommand,
  environmentKeysOnly,
  type AgentCommandPolicyClassifier,
  type AgentCommandPolicyDecision,
  type AgentCommandPolicyInput,
  type AgentCommandPolicyRawInput,
} from "./AgentCommandPolicy.js";
import type {
  HermesAcpPermissionDecision,
  HermesAcpPermissionOptionId,
} from "../../../hermes/src/HermesAcpPermissions.js";
import type {
  HermesAcpPermissionResolver,
  HermesAcpPermissionResolverInput,
} from "../../../hermes/src/HermesAcpHarness.js";

export type AgentCommandPolicyAcpAllowOptionId = Extract<
  HermesAcpPermissionOptionId,
  "allow_once" | "allow_session"
>;

export interface AgentCommandPolicyAcpOutcomeMapperOptions {
  allowOptionId?: AgentCommandPolicyAcpAllowOptionId | undefined;
}

export type AgentCommandPolicyAcpOutcomeMapper = (
  decision: AgentCommandPolicyDecision,
  options?: AgentCommandPolicyAcpOutcomeMapperOptions,
) => HermesAcpPermissionDecision;

export const DEFAULT_AGENT_COMMAND_POLICY_ACP_ALLOW_OPTION_ID: AgentCommandPolicyAcpAllowOptionId = "allow_once";
export const DEFAULT_AGENT_COMMAND_POLICY_ACP_FILE_EDIT_REASON = "file_edit_permission_allowed";

const AGENT_COMMAND_POLICY_ACP_ALLOW_OPTION_IDS = new Set<string>([
  "allow_once",
  "allow_session",
]);

export interface AgentCommandPolicyAcpResolverOptions {
  classify?: AgentCommandPolicyClassifier | undefined;
  environment?: Record<string, string | undefined> | undefined;
  allowOptionId?: AgentCommandPolicyAcpAllowOptionId | undefined;
  mapPolicyDecisionToAcpPermission?: AgentCommandPolicyAcpOutcomeMapper | undefined;
}

export type AgentCommandPolicyAcpResolverInputResult =
  | { status: "ok"; input: AgentCommandPolicyInput }
  | { status: "error"; reason: string };

export function createAgentCommandPolicyAcpResolver(
  options: AgentCommandPolicyAcpResolverOptions = {},
): HermesAcpPermissionResolver {
  const classify = options.classify ?? classifyAgentCommand;
  const mapPolicyDecisionToAcpPermission =
    options.mapPolicyDecisionToAcpPermission ?? mapAgentCommandPolicyDecisionToAcpPermissionDecision;
  return async (input) => {
    if (input.request.requestKind === "file_edit") {
      return { optionId: "allow_once", reason: DEFAULT_AGENT_COMMAND_POLICY_ACP_FILE_EDIT_REASON };
    }

    if (input.request.requestKind !== "terminal_execute") {
      return { optionId: null, reason: "unsupported_agent_command_policy_permission_kind" };
    }

    const policyInput = buildAgentCommandPolicyInputForAcpPermission(input, {
      environment: options.environment ?? process.env,
    });
    if (policyInput.status === "error") return { optionId: null, reason: policyInput.reason };

    try {
      const decision = await classify(policyInput.input);
      return mapPolicyDecisionToAcpPermission(decision, { allowOptionId: options.allowOptionId });
    } catch {
      return { optionId: null, reason: "classifier_error" };
    }
  };
}

export function mapAgentCommandPolicyDecisionToAcpPermissionDecision(
  decision: AgentCommandPolicyDecision,
  options: AgentCommandPolicyAcpOutcomeMapperOptions = {},
): HermesAcpPermissionDecision {
  if (decision.outcome === "deny") return { optionId: null, reason: decision.reasonKind };

  const allowOptionId = normalizeAgentCommandPolicyAcpAllowOptionId(
    options.allowOptionId ?? DEFAULT_AGENT_COMMAND_POLICY_ACP_ALLOW_OPTION_ID,
  );
  if (!allowOptionId) {
    return { optionId: null, reason: "unsupported_agent_command_policy_acp_allow_option" };
  }

  return { optionId: allowOptionId, reason: decision.reasonKind };
}

export const mapAgentCommandPolicyOutcomeToAcpPermissionDecision = mapAgentCommandPolicyDecisionToAcpPermissionDecision;

export function isAgentCommandPolicyAcpAllowOptionId(value: unknown): value is AgentCommandPolicyAcpAllowOptionId {
  return typeof value === "string" && AGENT_COMMAND_POLICY_ACP_ALLOW_OPTION_IDS.has(value);
}

function normalizeAgentCommandPolicyAcpAllowOptionId(value: unknown): AgentCommandPolicyAcpAllowOptionId | null {
  return isAgentCommandPolicyAcpAllowOptionId(value) ? value : null;
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

  const commandSources = [...commandFields, ...topLevelFields];
  const contentCommand = commandFromStructuredContent(unknownField(toolCall, "content"), {
    acceptPlainText: commandSources.length === 0,
  });
  if (contentCommand !== null) commandSources.push({ key: "content", value: contentCommand });

  if (commandSources.length === 0) return { status: "missing" };
  if (hasConflictingCommandSources(commandSources)) {
    return { status: "ambiguous", rawInput: ambiguousCommandInput(commandSources) };
  }
  return { status: "ok", command: commandSources[0]?.value ?? "" };
}

function hasConflictingCommandSources(fields: Array<{ key: string; value: string }>): boolean {
  const firstValue = fields[0]?.value;
  if (firstValue === undefined) return false;
  return fields.some((field) => field.value !== firstValue);
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

function commandFromStructuredContent(value: unknown, options: { acceptPlainText: boolean }): string | null {
  if (typeof value === "string") return commandFromStructuredContentText(value, options);
  if (Array.isArray(value)) {
    const commands = value
      .map((item) => commandFromStructuredContent(item, options))
      .filter((command): command is string => command !== null);
    return commands.length === 1 ? commands[0] ?? null : null;
  }
  if (!isRecord(value)) return null;
  const command = nonEmptyString(unknownField(value, "command", "cmd", "script"));
  if (command !== null) return command;
  const text = nonEmptyString(unknownField(value, "text"));
  return text === null ? null : commandFromStructuredContentText(text, options);
}

function commandFromStructuredContentText(value: string, options: { acceptPlainText: boolean }): string | null {
  const promptCommand = commandFromTerminalPromptText(value);
  if (promptCommand !== null) return promptCommand;
  return options.acceptPlainText ? nonEmptyString(value) : null;
}

function commandFromTerminalPromptText(value: string): string | null {
  const lines = value.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    const match = /^\$\s+(.+)$/u.exec(line);
    const command = nonEmptyString(match?.[1]);
    if (command !== null) return command;
  }
  return null;
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

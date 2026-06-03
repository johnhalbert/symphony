import path from "node:path";
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

export interface AgentCommandPolicyAcpFileEditDiff {
  path: string;
  oldText: string | null;
  newText: string;
  byteLength: number;
}

export interface AgentCommandPolicyAcpFileEditApprovalRequest {
  toolCallId: string;
  toolName: string | null;
  title: string | null;
  summary: string;
  workspacePath: string;
  affectedPaths: string[];
  diffs: AgentCommandPolicyAcpFileEditDiff[];
  rawInput: Record<string, unknown> | null;
}

export type AgentCommandPolicyAcpFileEditApprovalOutcome =
  | "approve"
  | "allow"
  | "deny"
  | "reject"
  | "cancel"
  | {
      outcome: "approve" | "allow" | "deny" | "reject" | "cancel";
      reason?: string | null | undefined;
    };

export type AgentCommandPolicyAcpFileEditApprovalResolver = (
  request: AgentCommandPolicyAcpFileEditApprovalRequest,
  input: HermesAcpPermissionResolverInput,
) => AgentCommandPolicyAcpFileEditApprovalOutcome | Promise<AgentCommandPolicyAcpFileEditApprovalOutcome>;

export const DEFAULT_AGENT_COMMAND_POLICY_ACP_ALLOW_OPTION_ID: AgentCommandPolicyAcpAllowOptionId = "allow_once";
export const DEFAULT_AGENT_COMMAND_POLICY_ACP_FILE_EDIT_REASON = "file_edit_permission_allowed";
export const DEFAULT_AGENT_COMMAND_POLICY_ACP_FILE_EDIT_DENY_REASON = "file_edit_permission_denied";
export const DEFAULT_AGENT_COMMAND_POLICY_ACP_FILE_EDIT_APPROVAL_BRIDGE_MISSING_REASON =
  "file_edit_approval_bridge_not_configured";
export const DEFAULT_AGENT_COMMAND_POLICY_ACP_MAX_FILE_EDIT_DIFF_BYTES = 1024 * 1024;

const AGENT_COMMAND_POLICY_ACP_ALLOW_OPTION_IDS = new Set<string>([
  "allow_once",
  "allow_session",
]);

export interface AgentCommandPolicyAcpResolverOptions {
  classify?: AgentCommandPolicyClassifier | undefined;
  environment?: Record<string, string | undefined> | undefined;
  allowOptionId?: AgentCommandPolicyAcpAllowOptionId | undefined;
  mapPolicyDecisionToAcpPermission?: AgentCommandPolicyAcpOutcomeMapper | undefined;
  fileEditApproval?: AgentCommandPolicyAcpFileEditApprovalResolver | undefined;
  maxFileEditDiffBytes?: number | undefined;
}

export type AgentCommandPolicyAcpResolverInputResult =
  | { status: "ok"; input: AgentCommandPolicyInput }
  | { status: "error"; reason: string };

export type AgentCommandPolicyAcpFileEditApprovalRequestResult =
  | { status: "ok"; request: AgentCommandPolicyAcpFileEditApprovalRequest }
  | { status: "error"; reason: string };

export function createAgentCommandPolicyAcpResolver(
  options: AgentCommandPolicyAcpResolverOptions = {},
): HermesAcpPermissionResolver {
  const classify = options.classify ?? classifyAgentCommand;
  const mapPolicyDecisionToAcpPermission =
    options.mapPolicyDecisionToAcpPermission ?? mapAgentCommandPolicyDecisionToAcpPermissionDecision;
  return async (input) => {
    if (input.request.malformedReason) return { optionId: null, reason: input.request.malformedReason };

    if (input.request.requestKind === "file_edit") {
      return resolveAgentCommandPolicyFileEditAcpPermission(input, options);
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

export function buildAgentCommandPolicyFileEditApprovalRequestForAcpPermission(
  input: HermesAcpPermissionResolverInput,
  options: Pick<AgentCommandPolicyAcpResolverOptions, "maxFileEditDiffBytes"> = {},
): AgentCommandPolicyAcpFileEditApprovalRequestResult {
  if (input.request.requestKind !== "file_edit") {
    return { status: "error", reason: "unsupported_agent_command_policy_permission_kind" };
  }

  const toolCall = input.request.toolCall;
  if (!toolCall) return { status: "error", reason: "missing_permission_tool_call" };

  const toolCallId = input.request.toolCallId;
  if (!toolCallId) return { status: "error", reason: "missing_permission_tool_call_id" };

  const workspacePath = nonEmptyString(input.ctx.workspace.path);
  if (!workspacePath) return { status: "error", reason: "missing_file_edit_workspace" };

  const diffsResult = fileEditDiffsFromAcpToolCall(toolCall);
  if (diffsResult.status === "error") return { status: "error", reason: diffsResult.reason };

  const maxDiffBytes = normalizeFileEditMaxDiffBytes(options.maxFileEditDiffBytes);
  const affectedPaths: string[] = [];
  const diffTargetPaths = new Set<string>();
  let totalBytes = 0;
  for (const diff of diffsResult.diffs) {
    const pathPolicy = validateFileEditPathWithinWorkspace(workspacePath, diff.path);
    if (pathPolicy.status === "error") return { status: "error", reason: pathPolicy.reason };
    if (!diffTargetPaths.has(pathPolicy.comparisonPath)) affectedPaths.push(diff.path);
    diffTargetPaths.add(pathPolicy.comparisonPath);
    totalBytes += diff.byteLength;
    if (totalBytes > maxDiffBytes) return { status: "error", reason: "file_edit_diff_too_large" };
  }

  const rawInput = recordField(toolCall, "rawInput", "raw_input");
  const rawInputTargetPaths = new Set<string>();
  for (const rawPath of fileEditRawInputPaths(rawInput)) {
    const pathPolicy = validateFileEditPathWithinWorkspace(workspacePath, rawPath);
    if (pathPolicy.status === "error") return { status: "error", reason: pathPolicy.reason };
    rawInputTargetPaths.add(pathPolicy.comparisonPath);
  }
  if (rawInputTargetPaths.size > 0 && !sameStringSet(rawInputTargetPaths, diffTargetPaths)) {
    return { status: "error", reason: "file_edit_target_path_mismatch" };
  }

  const title = nonEmptyString(unknownField(toolCall, "title"));
  const toolName = rawInput ? nonEmptyString(unknownField(rawInput, "tool", "toolName", "tool_name")) : null;
  return {
    status: "ok",
    request: {
      toolCallId,
      toolName,
      title,
      summary: title ?? `Approve edit: ${affectedPaths.join(", ")}`,
      workspacePath,
      affectedPaths,
      diffs: diffsResult.diffs,
      rawInput,
    },
  };
}

export function mapAgentCommandPolicyFileEditApprovalOutcomeToAcpPermissionDecision(
  outcome: AgentCommandPolicyAcpFileEditApprovalOutcome,
): HermesAcpPermissionDecision {
  const normalized = typeof outcome === "string" ? { outcome, reason: null } : outcome;
  const reason = normalized.reason ?? null;
  switch (normalized.outcome) {
    case "approve":
    case "allow":
      return { optionId: "allow_once", reason: reason ?? DEFAULT_AGENT_COMMAND_POLICY_ACP_FILE_EDIT_REASON };
    case "deny":
    case "reject":
      return { optionId: "deny", reason: reason ?? DEFAULT_AGENT_COMMAND_POLICY_ACP_FILE_EDIT_DENY_REASON };
    case "cancel":
      return { optionId: null, reason: reason ?? DEFAULT_AGENT_COMMAND_POLICY_ACP_FILE_EDIT_DENY_REASON };
  }
}

async function resolveAgentCommandPolicyFileEditAcpPermission(
  input: HermesAcpPermissionResolverInput,
  options: AgentCommandPolicyAcpResolverOptions,
): Promise<HermesAcpPermissionDecision> {
  const approvalRequest = buildAgentCommandPolicyFileEditApprovalRequestForAcpPermission(input, {
    maxFileEditDiffBytes: options.maxFileEditDiffBytes,
  });
  if (approvalRequest.status === "error") return { optionId: "deny", reason: approvalRequest.reason };

  try {
    if (!options.fileEditApproval) {
      return { optionId: "deny", reason: DEFAULT_AGENT_COMMAND_POLICY_ACP_FILE_EDIT_APPROVAL_BRIDGE_MISSING_REASON };
    }
    const outcome = await options.fileEditApproval(approvalRequest.request, input);
    return mapAgentCommandPolicyFileEditApprovalOutcomeToAcpPermissionDecision(outcome);
  } catch {
    return { optionId: "deny", reason: "file_edit_approval_error" };
  }
}

type AgentCommandPolicyAcpFileEditDiffsResult =
  | { status: "ok"; diffs: AgentCommandPolicyAcpFileEditDiff[] }
  | { status: "error"; reason: string };

type FileEditPathPolicyResult = { status: "ok"; comparisonPath: string } | { status: "error"; reason: string };

function fileEditDiffsFromAcpToolCall(toolCall: Record<string, unknown>): AgentCommandPolicyAcpFileEditDiffsResult {
  const content = unknownField(toolCall, "content");
  if (content === undefined || content === null) return { status: "error", reason: "missing_file_edit_diff" };

  const contentItems = Array.isArray(content) ? content : [content];
  if (contentItems.length === 0) return { status: "error", reason: "missing_file_edit_diff" };

  const diffs: AgentCommandPolicyAcpFileEditDiff[] = [];
  for (const item of contentItems) {
    const diffResult = fileEditDiffFromContentItem(item);
    if (diffResult.status === "error") return diffResult;
    diffs.push(diffResult.diff);
  }
  return diffs.length === 0 ? { status: "error", reason: "missing_file_edit_diff" } : { status: "ok", diffs };
}

function fileEditDiffFromContentItem(
  item: unknown,
): { status: "ok"; diff: AgentCommandPolicyAcpFileEditDiff } | { status: "error"; reason: string } {
  if (!isRecord(item)) return { status: "error", reason: "malformed_file_edit_diff" };

  const filePath = nonEmptyString(unknownField(item, "path", "file", "filePath", "file_path"));
  if (!filePath) return { status: "error", reason: "malformed_file_edit_diff" };

  const oldTextValue = fieldWithPresence(item, "oldText", "old_text");
  if (!oldTextValue.found) return { status: "error", reason: "malformed_file_edit_diff" };
  const oldText = oldTextValue.value === null ? null : typeof oldTextValue.value === "string" ? oldTextValue.value : undefined;
  if (oldText === undefined) return { status: "error", reason: "malformed_file_edit_diff" };

  const newTextValue = unknownField(item, "newText", "new_text");
  if (typeof newTextValue !== "string") return { status: "error", reason: "malformed_file_edit_diff" };

  return {
    status: "ok",
    diff: {
      path: filePath,
      oldText,
      newText: newTextValue,
      byteLength: fileEditTextByteLength(oldText) + fileEditTextByteLength(newTextValue),
    },
  };
}

function fileEditRawInputPaths(rawInput: Record<string, unknown> | null): string[] {
  if (!rawInput) return [];
  const paths: string[] = [];
  addFileEditRawInputPath(paths, unknownField(rawInput, "path", "file", "filePath", "file_path"));
  const args = recordField(rawInput, "arguments", "args");
  if (args) addFileEditRawInputPath(paths, unknownField(args, "path", "file", "filePath", "file_path"));
  return paths;
}

function addFileEditRawInputPath(paths: string[], value: unknown): void {
  const filePath = nonEmptyString(value);
  if (filePath) paths.push(filePath);
}

function validateFileEditPathWithinWorkspace(workspacePath: string, targetPath: string): FileEditPathPolicyResult {
  if (targetPath.includes("\0")) return { status: "error", reason: "invalid_file_edit_path" };
  const trimmedTargetPath = targetPath.trim();
  if (!trimmedTargetPath || trimmedTargetPath === ".") return { status: "error", reason: "invalid_file_edit_path" };

  const pathApi = pathApiForWorkspacePath(workspacePath, trimmedTargetPath);
  const workspaceRoot = pathApi.resolve(workspacePath);
  const absoluteTargetPath = pathApi.isAbsolute(trimmedTargetPath)
    ? pathApi.resolve(trimmedTargetPath)
    : pathApi.resolve(workspaceRoot, trimmedTargetPath);

  if (samePath(workspaceRoot, absoluteTargetPath, pathApi)) return { status: "error", reason: "invalid_file_edit_path" };
  return isPathInsideRoot(workspaceRoot, absoluteTargetPath, pathApi)
    ? { status: "ok", comparisonPath: pathForComparison(absoluteTargetPath, pathApi) }
    : { status: "error", reason: "file_edit_path_outside_workspace" };
}

function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function normalizeFileEditMaxDiffBytes(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_AGENT_COMMAND_POLICY_ACP_MAX_FILE_EDIT_DIFF_BYTES;
}

function fileEditTextByteLength(value: string | null): number {
  return value === null ? 0 : Buffer.byteLength(value, "utf8");
}

type PathApi = typeof path.posix;

function pathApiForWorkspacePath(workspacePath: string, targetPath: string): PathApi {
  return usesWindowsPathSemantics(workspacePath) || usesWindowsPathSemantics(targetPath) ? path.win32 : path.posix;
}

function usesWindowsPathSemantics(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/u.test(value) || value.includes("\\");
}

function samePath(left: string, right: string, pathApi: PathApi): boolean {
  return pathForComparison(left, pathApi) === pathForComparison(right, pathApi);
}

function isPathInsideRoot(root: string, candidate: string, pathApi: PathApi): boolean {
  const normalizedRoot = pathForComparison(root, pathApi);
  const normalizedCandidate = pathForComparison(candidate, pathApi);
  const rootWithSeparator = normalizedRoot.endsWith(pathApi.sep) ? normalizedRoot : `${normalizedRoot}${pathApi.sep}`;
  return normalizedCandidate.startsWith(rootWithSeparator);
}

function pathForComparison(value: string, pathApi: PathApi): string {
  const normalized = pathApi.normalize(value);
  return pathApi === path.win32 ? normalized.toLowerCase() : normalized;
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

type FieldWithPresenceResult = { found: true; value: unknown } | { found: false };

function fieldWithPresence(record: Record<string, unknown>, ...keys: string[]): FieldWithPresenceResult {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) return { found: true, value: record[key] };
  }
  return { found: false };
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

export type HermesAcpPermissionOptionId = "allow_once" | "allow_session" | "allow_always" | "deny" | "deny_always";

export type HermesAcpPermissionRequestKind = "terminal_execute" | "file_edit" | "unknown";

export interface HermesAcpPermissionOption {
  optionId: string;
  kind: string | null;
  name: string | null;
  raw: Record<string, unknown>;
}

export interface HermesAcpPermissionRequest {
  sessionId: string | null;
  toolCallId: string | null;
  toolKind: string | null;
  requestKind: HermesAcpPermissionRequestKind;
  toolCall: Record<string, unknown> | null;
  options: HermesAcpPermissionOption[];
  params: unknown;
  malformedReason: string | null;
}

export type HermesAcpPermissionDecision =
  | HermesAcpPermissionOptionId
  | string
  | { optionId?: string | null; option_id?: string | null; reason?: string | null }
  | null
  | undefined;

export type HermesAcpPermissionOutcome = "selected" | "cancelled";

export interface HermesAcpPermissionResolution {
  request: HermesAcpPermissionRequest;
  response: Record<string, unknown>;
  outcome: HermesAcpPermissionOutcome;
  selectedOptionId: string | null;
  reason: string;
}

const TERMINAL_PERMISSION_OPTION_IDS = new Set<string>(["allow_once", "allow_session", "allow_always", "deny", "deny_always"]);
const EDIT_PERMISSION_OPTION_IDS = new Set<string>(["allow_once", "deny"]);
const TERMINAL_TOOL_CALL_KINDS = new Set<string>(["execute", "terminal", "shell"]);
const EDIT_TOOL_CALL_KINDS = new Set<string>(["edit", "file_edit", "file-edit"]);

const REQUIRED_TERMINAL_PERMISSION_OPTION_IDS = ["allow_once", "allow_session", "deny"];
const REQUIRED_EDIT_PERMISSION_OPTION_IDS = ["allow_once", "deny"];

export function parseHermesAcpPermissionRequest(params: unknown): HermesAcpPermissionRequest {
  const paramsRecord = isRecord(params) ? params : null;
  const toolCall = paramsRecord ? recordField(paramsRecord, "toolCall", "tool_call") : null;
  const rawOptions = paramsRecord ? unknownField(paramsRecord, "options", "permissionOptions", "permission_options") : undefined;
  const options = Array.isArray(rawOptions) ? rawOptions.map(permissionOptionFromUnknown).filter((option): option is HermesAcpPermissionOption => option !== null) : [];
  const sessionId = paramsRecord ? nonEmptyString(unknownField(paramsRecord, "sessionId", "session_id")) : null;
  const toolCallId = toolCall ? nonEmptyString(unknownField(toolCall, "toolCallId", "tool_call_id", "id")) : null;
  const toolKind = toolCall ? nonEmptyString(unknownField(toolCall, "kind", "toolKind", "tool_kind"))?.toLowerCase() ?? null : null;
  const requestKind = classifyPermissionRequest(toolKind);

  return {
    sessionId,
    toolCallId,
    toolKind,
    requestKind,
    toolCall,
    options,
    params,
    malformedReason: permissionRequestMalformedReason({
      paramsRecord,
      rawOptions,
      options,
      sessionId,
      toolCall,
      toolCallId,
      toolKind,
      requestKind,
    }),
  };
}

export function resolveHermesAcpPermissionDecision(
  request: HermesAcpPermissionRequest,
  decision: HermesAcpPermissionDecision,
): HermesAcpPermissionResolution {
  if (request.malformedReason) return denyHermesAcpPermission(request, request.malformedReason);

  const selectedOptionId = permissionDecisionOptionId(decision);
  if (!selectedOptionId) return denyHermesAcpPermission(request, "no_permission_policy");
  if (!request.options.some((option) => option.optionId === selectedOptionId)) {
    return denyHermesAcpPermission(request, "permission_option_not_offered");
  }
  if (!isSupportedOptionForRequestKind(request.requestKind, selectedOptionId)) {
    return denyHermesAcpPermission(request, "permission_option_not_supported");
  }

  return selectHermesAcpPermissionOption(request, selectedOptionId, "permission_option_selected");
}

export function denyHermesAcpPermission(request: HermesAcpPermissionRequest, reason: string): HermesAcpPermissionResolution {
  return {
    request,
    response: { outcome: { outcome: "cancelled" } },
    outcome: "cancelled",
    selectedOptionId: null,
    reason,
  };
}

export function selectHermesAcpPermissionOption(
  request: HermesAcpPermissionRequest,
  optionId: string,
  reason: string,
): HermesAcpPermissionResolution {
  return {
    request,
    response: { outcome: { outcome: "selected", optionId } },
    outcome: "selected",
    selectedOptionId: optionId,
    reason,
  };
}

export function permissionDecisionOptionId(decision: HermesAcpPermissionDecision): string | null {
  if (typeof decision === "string") return nonEmptyString(decision);
  if (!isRecord(decision)) return null;
  return nonEmptyString(decision.optionId) ?? nonEmptyString(decision.option_id);
}

function permissionOptionFromUnknown(value: unknown): HermesAcpPermissionOption | null {
  if (!isRecord(value)) return null;
  const optionId = nonEmptyString(unknownField(value, "optionId", "option_id", "id"));
  if (!optionId) return null;
  return {
    optionId,
    kind: nonEmptyString(value.kind)?.toLowerCase() ?? null,
    name: nonEmptyString(unknownField(value, "name", "label", "title")),
    raw: value,
  };
}

function permissionRequestMalformedReason(input: {
  paramsRecord: Record<string, unknown> | null;
  rawOptions: unknown;
  options: HermesAcpPermissionOption[];
  sessionId: string | null;
  toolCall: Record<string, unknown> | null;
  toolCallId: string | null;
  toolKind: string | null;
  requestKind: HermesAcpPermissionRequestKind;
}): string | null {
  if (!input.paramsRecord) return "malformed_permission_request";
  if (!input.sessionId) return "missing_permission_session_id";
  if (!input.toolCall) return "missing_permission_tool_call";
  if (!input.toolKind) return "missing_permission_tool_call_kind";
  if (input.requestKind === "unknown") return "unsupported_permission_tool_call";
  if (!input.toolCallId) return "missing_permission_tool_call_id";
  if (!Array.isArray(input.rawOptions)) return "missing_permission_options";
  if (input.options.length !== input.rawOptions.length) return "malformed_permission_options";
  if (input.options.length === 0) return "missing_permission_options";
  if (hasDuplicateOptionIds(input.options)) return "duplicate_permission_options";
  if (!isSupportedPermissionOptionSet(input.requestKind, input.options)) return "unsupported_permission_options";
  if (!hasSupportedToolCallContent(input.requestKind, input.toolCall)) return "missing_permission_tool_call_content";
  return null;
}

function classifyPermissionRequest(toolKind: string | null): HermesAcpPermissionRequestKind {
  if (toolKind && EDIT_TOOL_CALL_KINDS.has(toolKind)) return "file_edit";
  if (toolKind && TERMINAL_TOOL_CALL_KINDS.has(toolKind)) return "terminal_execute";
  return "unknown";
}

function hasSupportedToolCallContent(
  requestKind: HermesAcpPermissionRequestKind,
  toolCall: Record<string, unknown>,
): boolean {
  if (requestKind === "terminal_execute") return hasTerminalToolCallContent(toolCall);
  if (requestKind === "file_edit") return hasEditToolCallContent(toolCall);
  return false;
}

function hasTerminalToolCallContent(toolCall: Record<string, unknown>): boolean {
  const rawInput = recordField(toolCall, "rawInput", "raw_input");
  if (rawInput && nonEmptyString(unknownField(rawInput, "command", "cmd", "script"))) return true;
  return hasNonEmptyStructuredContent(unknownField(toolCall, "content"));
}

function hasEditToolCallContent(toolCall: Record<string, unknown>): boolean {
  const rawInput = recordField(toolCall, "rawInput", "raw_input");
  if (rawInput) {
    if (nonEmptyString(unknownField(rawInput, "path", "file", "filePath", "file_path"))) return true;
    const args = recordField(rawInput, "arguments", "args");
    if (args && nonEmptyString(unknownField(args, "path", "file", "filePath", "file_path"))) return true;
    if (nonEmptyString(unknownField(rawInput, "tool", "toolName", "tool_name")) && args) return true;
  }
  return hasNonEmptyStructuredContent(unknownField(toolCall, "content"));
}

function hasNonEmptyStructuredContent(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(hasNonEmptyStructuredContent);
  if (!isRecord(value)) return false;
  return (
    nonEmptyString(unknownField(value, "text", "path", "oldText", "old_text", "newText", "new_text")) !== null ||
    hasNonEmptyStructuredContent(unknownField(value, "content", "diff"))
  );
}

function isSupportedPermissionOptionSet(
  requestKind: HermesAcpPermissionRequestKind,
  options: readonly HermesAcpPermissionOption[],
): boolean {
  const optionIds = new Set(options.map((option) => option.optionId));
  if (requestKind === "terminal_execute") {
    return (
      options.every((option) => TERMINAL_PERMISSION_OPTION_IDS.has(option.optionId)) &&
      REQUIRED_TERMINAL_PERMISSION_OPTION_IDS.every((optionId) => optionIds.has(optionId))
    );
  }
  if (requestKind === "file_edit") {
    return (
      options.every((option) => EDIT_PERMISSION_OPTION_IDS.has(option.optionId)) &&
      REQUIRED_EDIT_PERMISSION_OPTION_IDS.every((optionId) => optionIds.has(optionId))
    );
  }
  return false;
}

function isSupportedOptionForRequestKind(requestKind: HermesAcpPermissionRequestKind, optionId: string): boolean {
  if (requestKind === "terminal_execute") return TERMINAL_PERMISSION_OPTION_IDS.has(optionId);
  if (requestKind === "file_edit") return EDIT_PERMISSION_OPTION_IDS.has(optionId);
  return false;
}

function hasDuplicateOptionIds(options: readonly HermesAcpPermissionOption[]): boolean {
  const seen = new Set<string>();
  for (const option of options) {
    if (seen.has(option.optionId)) return true;
    seen.add(option.optionId);
  }
  return false;
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
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

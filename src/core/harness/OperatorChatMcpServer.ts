import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { SymphonyError } from "../errors.js";
import { FileOrchestratorConversationStore } from "../persistence/OrchestratorConversationStore.js";
import { WorkflowLoader } from "../workflow/WorkflowLoader.js";
import { runToolsetMcpServer, type SymphonyMcpToolDefinition } from "./McpSdkStdioServer.js";

export interface OperatorChatMcpContextFile {
  conversationId: string;
  activeRunId: string | null;
  sessionId: string | null;
  statusBaseUrl: string | null;
  mutationToken: string | null;
}

export async function writeOperatorChatMcpContext(
  filePath: string,
  context: OperatorChatMcpContextFile,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(context, null, 2)}\n`, "utf8");
}

export async function runOperatorChatMcpServer(options: {
  workflowPath: string;
  contextFile: string;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}): Promise<void> {
  const loader = new WorkflowLoader(options.workflowPath);
  try {
    const loaded = await loader.load();
    const config = loaded.serviceConfig;
    const context = await readOperatorChatMcpContext(options.contextFile);
    await runToolsetMcpServer({
      serverName: "symphony-operator-chat",
      version: "0.1.0",
      input: options.input,
      output: options.output,
      tools: operatorChatTools({
        context,
        stateDir: config.workspace.stateDir,
      }),
    });
  } finally {
    await loader.close();
  }
}

function operatorChatTools(input: { context: OperatorChatMcpContextFile; stateDir: string }): SymphonyMcpToolDefinition[] {
  const request = (toolName: string, args: unknown) => requestStatusApi(toolName, args, input.context, input.stateDir);
  return [
    {
      name: "get_dashboard",
      description: "Read the current Symphony dashboard projection.",
      inputSchema: objectSchema({
        refresh: { type: "boolean", description: "When true, request a fresh projection." },
      }),
      handler: (args) => request("get_dashboard", args),
    },
    {
      name: "list_issues",
      description: "Read the current Symphony issue board projection.",
      inputSchema: objectSchema({
        refresh: { type: "boolean", description: "When true, request a fresh projection." },
      }),
      handler: (args) => request("list_issues", args),
    },
    {
      name: "get_issue",
      description: "Read details for one Symphony issue.",
      inputSchema: objectSchema(
        {
          issueId: { type: "string", minLength: 1, description: "Issue id or identifier." },
        },
        ["issueId"],
      ),
      handler: (args) => request("get_issue", args),
    },
    {
      name: "get_issue_runs",
      description: "Read run history for one Symphony issue.",
      inputSchema: objectSchema(
        {
          issueId: { type: "string", minLength: 1, description: "Issue id or identifier." },
        },
        ["issueId"],
      ),
      handler: (args) => request("get_issue_runs", args),
    },
    {
      name: "get_run_transcript",
      description: "Read a page of a Symphony run transcript.",
      inputSchema: objectSchema(
        {
          runId: { type: "string", minLength: 1 },
          offset: { type: "integer", minimum: 0 },
          limit: { type: "integer", minimum: 1, maximum: 1000 },
        },
        ["runId"],
      ),
      handler: (args) => request("get_run_transcript", args),
    },
    {
      name: "get_orchestrator_chat",
      description: "Read the current dashboard operator chat projection.",
      inputSchema: objectSchema({
        conversationId: { type: "string", minLength: 1 },
        refresh: { type: "boolean" },
      }),
      handler: (args) => request("get_orchestrator_chat", args),
    },
    {
      name: "trigger_poll",
      description: "Ask Symphony to poll/reconcile now.",
      inputSchema: mutatingSchema({}),
      handler: (args) => request("trigger_poll", args),
    },
    {
      name: "pause_issue",
      description: "Pause orchestration for one issue.",
      inputSchema: mutatingSchema({
        issueId: { type: "string", minLength: 1, description: "Issue id or identifier." },
      }, ["issueId"]),
      handler: (args) => request("pause_issue", args),
    },
    {
      name: "resume_issue",
      description: "Resume orchestration for one paused issue.",
      inputSchema: mutatingSchema({
        issueId: { type: "string", minLength: 1, description: "Issue id or identifier." },
      }, ["issueId"]),
      handler: (args) => request("resume_issue", args),
    },
    {
      name: "cancel_issue",
      description: "Cancel the active run for one issue.",
      inputSchema: mutatingSchema({
        issueId: { type: "string", minLength: 1, description: "Issue id or identifier." },
      }, ["issueId"]),
      handler: (args) => request("cancel_issue", args),
    },
    {
      name: "clear_provider_gate",
      description: "Clear or resume a provider gate.",
      inputSchema: mutatingSchema(
        {
          gateId: { type: "string", minLength: 1 },
          resume: { type: "boolean", description: "When true, clear as an explicit resume action." },
        },
        ["gateId"],
      ),
      handler: (args) => request("clear_provider_gate", args),
    },
    {
      name: "request_issue_breakdown",
      description: "Queue an issue-breakdown planning run for one issue.",
      inputSchema: mutatingSchema({
        issueId: { type: "string", minLength: 1, description: "Issue id or identifier." },
      }, ["issueId"]),
      handler: (args) => request("request_issue_breakdown", args),
    },
    {
      name: "apply_issue_breakdown_plan",
      description: "Apply or preview the latest issue-breakdown plan for one issue.",
      inputSchema: mutatingSchema(
        {
          issueId: { type: "string", minLength: 1, description: "Issue id or identifier." },
          dryRun: { type: "boolean", description: "When true, preview without writing child issues." },
        },
        ["issueId"],
      ),
      handler: (args) => request("apply_issue_breakdown_plan", args),
    },
    {
      name: "resolve_approval",
      description: "Approve or reject a pending Symphony operator approval request.",
      inputSchema: mutatingSchema(
        {
          requestId: { type: "string", minLength: 1 },
          decision: { type: "string", enum: ["approve", "reject"] },
        },
        ["requestId", "decision"],
      ),
      handler: (args) => request("resolve_approval", args),
    },
  ];
}

async function requestStatusApi(
  toolName: string,
  args: unknown,
  context: OperatorChatMcpContextFile,
  stateDir: string,
): Promise<unknown> {
  const record = recordInput(args);
  const request = requestForTool(toolName, record, context);
  if (request.mutating) {
    const idempotencyKey = stringInput(record, "idempotencyKey");
    const replay = await readIdempotencyReplay(stateDir, toolName, idempotencyKey);
    if (replay) return { result: replay.result, replayed: true, idempotencyKey };
    const result = await fetchStatusJson(request, context);
    await writeIdempotencyReplay(stateDir, toolName, idempotencyKey, result);
    await appendAuditMessage(stateDir, context, toolName, request, result, idempotencyKey);
    return { result, replayed: false, idempotencyKey };
  }
  return fetchStatusJson(request, context);
}

function requestForTool(
  toolName: string,
  input: Record<string, unknown>,
  context: OperatorChatMcpContextFile,
): StatusRequest {
  switch (toolName) {
    case "get_dashboard":
      return get(`/api/v1/web/dashboard${input.refresh === true ? "?refresh=1" : ""}`);
    case "list_issues":
      return get(`/api/v1/web/issues${input.refresh === true ? "?refresh=1" : ""}`);
    case "get_issue":
      return get(`/api/v1/issues/${encodeURIComponent(stringInput(input, "issueId"))}`);
    case "get_issue_runs":
      return get(`/api/v1/issues/${encodeURIComponent(stringInput(input, "issueId"))}/runs`);
    case "get_run_transcript":
      return get(
        `/api/v1/runs/${encodeURIComponent(stringInput(input, "runId"))}/transcript${query({
          offset: numberInput(input, "offset"),
          limit: numberInput(input, "limit"),
        })}`,
      );
    case "get_orchestrator_chat":
      return get(
        `/api/v1/web/orchestrator-chat${query({
          conversationId: nonEmptyString(input.conversationId) ?? context.conversationId,
          refresh: input.refresh === true ? "1" : undefined,
        })}`,
      );
    case "trigger_poll":
      return post("/api/v1/refresh", {}, true);
    case "pause_issue":
      return post(`/api/v1/issues/${encodeURIComponent(stringInput(input, "issueId"))}/pause`, {}, true);
    case "resume_issue":
      return post(`/api/v1/issues/${encodeURIComponent(stringInput(input, "issueId"))}/resume`, {}, true);
    case "cancel_issue":
      return post(`/api/v1/issues/${encodeURIComponent(stringInput(input, "issueId"))}/cancel`, {}, true);
    case "clear_provider_gate": {
      const action = input.resume === true ? "resume" : "clear";
      return post(`/api/v1/provider-gates/${encodeURIComponent(stringInput(input, "gateId"))}/${action}`, {}, true);
    }
    case "request_issue_breakdown":
      return post(`/api/v1/issues/${encodeURIComponent(stringInput(input, "issueId"))}/planning-run`, {}, true);
    case "apply_issue_breakdown_plan":
      return post(
        `/api/v1/issues/${encodeURIComponent(stringInput(input, "issueId"))}/planning-run/apply`,
        { dryRun: input.dryRun !== false },
        true,
      );
    case "resolve_approval":
      return post(
        `/api/v1/approval-requests/${encodeURIComponent(stringInput(input, "requestId"))}`,
        { decision: approvalDecision(input.decision) },
        true,
      );
    default:
      throw new SymphonyError("invalid_request", `Unknown operator tool: ${toolName}`);
  }
}

interface StatusRequest {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  mutating: boolean;
}

function get(pathname: string): StatusRequest {
  return { method: "GET", path: pathname, mutating: false };
}

function post(pathname: string, body: unknown, mutating: boolean): StatusRequest {
  return { method: "POST", path: pathname, body, mutating };
}

async function fetchStatusJson(request: StatusRequest, context: OperatorChatMcpContextFile): Promise<unknown> {
  const baseUrl = context.statusBaseUrl?.trim();
  if (!baseUrl) {
    throw new SymphonyError("invalid_request", "Operator status API base URL is not available");
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  if (request.method === "POST") headers["Content-Type"] = "application/json";
  if (request.mutating && context.mutationToken) headers["X-Symphony-Token"] = context.mutationToken;
  const response = await fetch(new URL(request.path, baseUrl), {
    method: request.method,
    headers,
    ...(request.method === "POST" ? { body: JSON.stringify(request.body ?? {}) } : {}),
  });
  const text = await response.text();
  const body = text.trim().length === 0 ? null : safeJsonParse(text);
  if (!response.ok) {
    const message = errorMessageFromBody(body) ?? `Symphony status API returned HTTP ${response.status}`;
    throw new SymphonyError("invalid_request", message, body);
  }
  return body;
}

async function appendAuditMessage(
  stateDir: string,
  context: OperatorChatMcpContextFile,
  toolName: string,
  request: StatusRequest,
  result: unknown,
  idempotencyKey: string,
): Promise<void> {
  const store = new FileOrchestratorConversationStore(stateDir);
  await store.appendMessage({
    conversationId: context.conversationId,
    role: "server",
    body: `Operator tool ${toolName} completed.`,
    status: "completed",
    metadata: {
      source: "operator_chat_mcp",
      toolName,
      method: request.method,
      path: request.path,
      idempotencyKey,
      activeRunId: context.activeRunId,
      sessionId: context.sessionId,
      resultPreview: preview(result),
    },
    transcriptLinks: context.activeRunId ? [{ runId: context.activeRunId, eventType: "operator_tool_audit" }] : [],
  });
}

interface IdempotencyReplay {
  result: unknown;
}

async function readIdempotencyReplay(
  stateDir: string,
  toolName: string,
  idempotencyKey: string,
): Promise<IdempotencyReplay | null> {
  return readJsonIfExists<IdempotencyReplay>(idempotencyPath(stateDir, toolName, idempotencyKey));
}

async function writeIdempotencyReplay(
  stateDir: string,
  toolName: string,
  idempotencyKey: string,
  result: unknown,
): Promise<void> {
  const filePath = idempotencyPath(stateDir, toolName, idempotencyKey);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${JSON.stringify({ toolName, idempotencyKey, result, recordedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
}

function idempotencyPath(stateDir: string, toolName: string, idempotencyKey: string): string {
  const digest = createHash("sha256").update(`${toolName}:${idempotencyKey}`).digest("hex");
  return path.join(stateDir, "operator-chat-actions", `${digest}.json`);
}

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT") return null;
    throw error;
  }
}

async function readOperatorChatMcpContext(filePath: string): Promise<OperatorChatMcpContextFile> {
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as OperatorChatMcpContextFile;
  if (!parsed || typeof parsed.conversationId !== "string") {
    throw new SymphonyError("invalid_request", "Operator chat MCP context is invalid");
  }
  return {
    conversationId: parsed.conversationId,
    activeRunId: nonEmptyString(parsed.activeRunId),
    sessionId: nonEmptyString(parsed.sessionId),
    statusBaseUrl: nonEmptyString(parsed.statusBaseUrl),
    mutationToken: nonEmptyString(parsed.mutationToken),
  };
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required,
    properties,
  };
}

function mutatingSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return objectSchema(
    {
      ...properties,
      idempotencyKey: {
        type: "string",
        minLength: 1,
        description: "Stable key for this operator action. Reuse the same key only when retrying the same intended action.",
      },
    },
    [...required, "idempotencyKey"],
  );
}

function recordInput(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SymphonyError("invalid_request", "Tool input must be an object");
  }
  return value as Record<string, unknown>;
}

function stringInput(input: Record<string, unknown>, key: string): string {
  const value = nonEmptyString(input[key]);
  if (!value) throw new SymphonyError("invalid_request", `${key} is required`);
  return value;
}

function numberInput(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function approvalDecision(value: unknown): "approve" | "reject" {
  if (value === "approve" || value === "reject") return value;
  throw new SymphonyError("invalid_request", "decision must be approve or reject");
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function query(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const text = params.toString();
  return text.length > 0 ? `?${text}` : "";
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorMessageFromBody(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error === "object" && error !== null && !Array.isArray(error)) {
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" ? message : null;
  }
  return null;
}

function preview(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length <= 500 ? text : `${text.slice(0, 485)}...[truncated]`;
}

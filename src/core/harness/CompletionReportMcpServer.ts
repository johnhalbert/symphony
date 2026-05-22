import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  CompletionReportService,
  type CompletionReportActiveContext,
  type CompletionReportPullRequestPublisher,
} from "../CompletionReportService.js";
import { FileIssueLifecycleStore } from "../persistence/IssueLifecycleStore.js";
import { FileRunTranscriptStore } from "../persistence/RunTranscriptStore.js";
import type { Issue, Workspace } from "../types.js";
import { WorkflowLoader } from "../workflow/WorkflowLoader.js";
import { FileWritebackOutboxStore } from "../writeback/WritebackOutbox.js";
import { GitHubPullRequestClient } from "../../integrations/github/GitHubPullRequestClient.js";
import { errorMessage, SymphonyError } from "../errors.js";

export const COMPLETION_REPORT_TOOL_NAME = "submit_completion_report";

export interface CompletionReportMcpContextFile {
  issue: Issue;
  activeRunId: string | null;
  role: "worker";
  token?: string | null;
  expectedToken?: string | null;
  sessionId?: string | null;
  workspacePath: string | null;
  workspace: Workspace;
  phase: "implementation";
}

export async function writeCompletionReportMcpContext(
  filePath: string,
  context: CompletionReportMcpContextFile,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(context, null, 2)}\n`, "utf8");
}

export async function submitCompletionReportFromMcp(input: unknown, options: {
  workflowPath: string;
  contextFile: string;
  pullRequestPublisher?: CompletionReportPullRequestPublisher;
}): Promise<unknown> {
  const loadedContext = await readCompletionReportContext(options.contextFile);
  if (!loadedContext.activeRunId) {
    throw new SymphonyError("invalid_request", "Completion report context is not ready for the active run");
  }

  const loader = new WorkflowLoader(options.workflowPath);
  try {
    const loaded = await loader.load();
    const config = loaded.serviceConfig;
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const service = new CompletionReportService({
      config,
      lifecycleStore: new FileIssueLifecycleStore(config.workspace.stateDir),
      writebackOutbox: new FileWritebackOutboxStore(config.workspace.stateDir),
      runStore,
      pullRequestPublisher: options.pullRequestPublisher ?? new GitHubPullRequestClient(config.github),
    });
    const context: CompletionReportActiveContext = {
      issue: loadedContext.issue,
      activeRunId: loadedContext.activeRunId,
      role: loadedContext.role,
      token: loadedContext.token ?? null,
      expectedToken: loadedContext.expectedToken ?? null,
      sessionId: loadedContext.sessionId ?? null,
      workspacePath: loadedContext.workspacePath,
      workspace: loadedContext.workspace,
      phase: loadedContext.phase,
    };
    const result = await service.submit_completion_report(input, context);
    return {
      accepted: result.accepted,
      replayed: result.replayed,
      reportId: result.report.id,
      pullRequest: result.report.pullRequest,
      writebackOperationKeys: result.report.writebackOperationKeys,
    };
  } finally {
    await loader.close();
  }
}

export async function runCompletionReportMcpServer(options: {
  workflowPath: string;
  contextFile: string;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const server = new JsonRpcStdioServer(input, output);
  server.onRequest(async (request) => handleMcpRequest(request, options));
  await server.start();
}

async function handleMcpRequest(
  request: JsonRpcRequest,
  options: { workflowPath: string; contextFile: string },
): Promise<unknown> {
  if (request.method === "initialize") {
    return {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "symphony-completion-report", version: "0.1.0" },
    };
  }
  if (request.method === "tools/list") {
    return {
      tools: [
        {
          name: COMPLETION_REPORT_TOOL_NAME,
          description: "Submit a Symphony worker completion report for review handoff.",
          inputSchema: completionReportInputSchema(),
        },
      ],
    };
  }
  if (request.method === "tools/call") {
    const params = asRecord(request.params);
    if (params.name !== COMPLETION_REPORT_TOOL_NAME) {
      throw new SymphonyError("invalid_request", `Unknown tool: ${String(params.name)}`);
    }
    const result = await submitCompletionReportFromMcp(params.arguments, options);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  }
  if (request.method.startsWith("notifications/")) return null;
  throw new SymphonyError("invalid_request", `Unsupported MCP method: ${request.method}`);
}

async function readCompletionReportContext(filePath: string): Promise<CompletionReportMcpContextFile> {
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as CompletionReportMcpContextFile;
  if (!parsed.issue || !parsed.workspace || parsed.role !== "worker") {
    throw new SymphonyError("invalid_request", "Completion report MCP context is invalid");
  }
  return parsed;
}

function completionReportInputSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "runId",
      "issueId",
      "summary",
      "validationEvidence",
      "acceptanceChecklist",
      "changedFiles",
      "branchName",
      "pullRequest",
      "risks",
      "idempotencyKey",
    ],
    properties: {
      runId: { type: "string", minLength: 1 },
      issueId: { type: "string", minLength: 1 },
      summary: { type: "string", minLength: 1 },
      validationEvidence: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
      acceptanceChecklist: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["text", "satisfied", "evidence"],
          properties: {
            text: { type: "string", minLength: 1 },
            satisfied: { type: "boolean" },
            evidence: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
          },
        },
      },
      changedFiles: { type: "array", items: { type: "string", minLength: 1 } },
      branchName: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
      pullRequest: {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            additionalProperties: false,
            required: ["url", "number"],
            properties: {
              url: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
              number: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
              headSha: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
              branch: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
            },
          },
        ],
      },
      risks: { type: "array", items: { type: "string", minLength: 1 } },
      idempotencyKey: { type: "string", minLength: 1 },
    },
  };
}

interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

class JsonRpcStdioServer {
  private readonly emitter = new EventEmitter();
  private buffer = Buffer.alloc(0);

  constructor(
    private readonly input: NodeJS.ReadStream,
    private readonly output: NodeJS.WriteStream,
  ) {}

  onRequest(handler: (request: JsonRpcRequest) => Promise<unknown>): void {
    this.emitter.on("request", (request: JsonRpcRequest) => {
      void this.respond(request, handler);
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.input.on("data", (chunk: Buffer) => {
        try {
          this.buffer = Buffer.concat([this.buffer, chunk]);
          this.drainMessages();
        } catch (error) {
          reject(error);
        }
      });
      this.input.on("end", resolve);
      this.input.on("error", reject);
    });
  }

  private drainMessages(): void {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      const contentLength = parseContentLength(header);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;
      if (this.buffer.length < bodyEnd) return;
      const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
      this.buffer = this.buffer.subarray(bodyEnd);
      const request = JSON.parse(body) as JsonRpcRequest;
      if (request.id === undefined && request.method.startsWith("notifications/")) continue;
      this.emitter.emit("request", request);
    }
  }

  private async respond(request: JsonRpcRequest, handler: (request: JsonRpcRequest) => Promise<unknown>): Promise<void> {
    if (request.id === undefined) return;
    try {
      const result = await handler(request);
      this.write({ jsonrpc: "2.0", id: request.id, result });
    } catch (error) {
      this.write({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32000,
          message: errorMessage(error),
        },
      });
    }
  }

  private write(message: unknown): void {
    const body = JSON.stringify(message);
    this.output.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  }
}

function parseContentLength(header: string): number {
  const line = header.split(/\r?\n/).find((item) => item.toLowerCase().startsWith("content-length:"));
  const value = Number(line?.split(":")[1]?.trim());
  if (!Number.isInteger(value) || value < 0) throw new Error("Invalid MCP Content-Length header");
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

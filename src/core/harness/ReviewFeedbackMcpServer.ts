import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createGitHubPullRequestClientForCapability } from "../../integrations/github/GitHubCredentialResolver.js";
import { errorMessage, SymphonyError } from "../errors.js";
import { FileIssueLifecycleStore } from "../persistence/IssueLifecycleStore.js";
import {
  PullRequestReviewFeedbackService,
  reviewFeedbackInputSchema,
  type ReviewFeedbackActiveContext,
} from "../review/PullRequestReviewFeedbackService.js";
import type { Issue } from "../types.js";
import { WorkflowLoader } from "../workflow/WorkflowLoader.js";

export const REVIEW_FEEDBACK_TOOL_NAME = "submit_pull_request_review_feedback";

export interface ReviewFeedbackMcpContextFile {
  issue: Issue;
  activeRunId: string | null;
  role: "reviewer";
  token?: string | null;
  expectedToken?: string | null;
  reviewer?: string | null;
  phase: "review";
}

export async function writeReviewFeedbackMcpContext(
  filePath: string,
  context: ReviewFeedbackMcpContextFile,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(context, null, 2)}\n`, "utf8");
}

export async function submitReviewFeedbackFromMcp(input: unknown, options: {
  workflowPath: string;
  contextFile: string;
}): Promise<unknown> {
  const loadedContext = await readReviewFeedbackContext(options.contextFile);
  if (!loadedContext.activeRunId) {
    throw new SymphonyError("invalid_request", "Review feedback context is not ready for the active run");
  }

  const loader = new WorkflowLoader(options.workflowPath);
  try {
    const loaded = await loader.load();
    const config = loaded.serviceConfig;
    const service = new PullRequestReviewFeedbackService({
      config,
      lifecycleStore: new FileIssueLifecycleStore(config.workspace.stateDir),
      client: createGitHubPullRequestClientForCapability(config, "github.review_feedback_write"),
    });
    const context: ReviewFeedbackActiveContext = {
      issue: loadedContext.issue,
      activeRunId: loadedContext.activeRunId,
      role: loadedContext.role,
      token: loadedContext.token ?? null,
      expectedToken: loadedContext.expectedToken ?? null,
      reviewer: loadedContext.reviewer ?? null,
      phase: loadedContext.phase,
    };
    const result = await service.submit_pull_request_review_feedback(input, context);
    return {
      accepted: result.accepted,
      replayed: result.replayed,
      feedbackId: result.feedback.id,
      pullRequest: result.pullRequest,
      reviewUrl: result.reviewUrl,
      commentUrls: result.commentUrls,
      urls: result.urls,
    };
  } finally {
    await loader.close();
  }
}

export async function runReviewFeedbackMcpServer(options: {
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
      serverInfo: { name: "symphony-review-feedback", version: "0.1.0" },
    };
  }
  if (request.method === "tools/list") {
    return {
      tools: [
        {
          name: REVIEW_FEEDBACK_TOOL_NAME,
          description: "Submit reviewer-owned GitHub PR feedback for the active lifecycle-bound pull request.",
          inputSchema: reviewFeedbackInputSchema(),
        },
      ],
    };
  }
  if (request.method === "tools/call") {
    const params = asRecord(request.params);
    if (params.name !== REVIEW_FEEDBACK_TOOL_NAME) {
      throw new SymphonyError("invalid_request", `Unknown tool: ${String(params.name)}`);
    }
    const result = await submitReviewFeedbackFromMcp(params.arguments, options);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  }
  if (request.method.startsWith("notifications/")) return null;
  throw new SymphonyError("invalid_request", `Unsupported MCP method: ${request.method}`);
}

async function readReviewFeedbackContext(filePath: string): Promise<ReviewFeedbackMcpContextFile> {
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as ReviewFeedbackMcpContextFile;
  if (!parsed.issue || parsed.role !== "reviewer") {
    throw new SymphonyError("invalid_request", "Review feedback MCP context is invalid");
  }
  return parsed;
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

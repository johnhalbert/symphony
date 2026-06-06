import { appendFileSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { errorMessage } from "../errors.js";

export interface SymphonyMcpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (input: unknown) => Promise<unknown>;
}

export async function runSingleToolMcpServer(options: {
  serverName: string;
  version: string;
  tool: SymphonyMcpToolDefinition;
  input?: NodeJS.ReadStream | undefined;
  output?: NodeJS.WriteStream | undefined;
}): Promise<void> {
  await runToolsetMcpServer({
    serverName: options.serverName,
    version: options.version,
    tools: [options.tool],
    input: options.input,
    output: options.output,
  });
}

export async function runToolsetMcpServer(options: {
  serverName: string;
  version: string;
  tools: readonly SymphonyMcpToolDefinition[];
  input?: NodeJS.ReadStream | undefined;
  output?: NodeJS.WriteStream | undefined;
}): Promise<void> {
  const server = new Server(
    { name: options.serverName, version: options.version },
    { capabilities: { tools: {} } },
  );
  const tools = new Map(options.tools.map((tool) => [tool.name, tool]));
  const trace = (method: string): void => traceMcpRequest(options.serverName, method);
  server.oninitialized = () => trace("notifications/initialized");
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    trace("tools/list");
    return {
      tools: options.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Tool["inputSchema"],
      })),
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    trace("tools/call");
    const tool = tools.get(request.params.name);
    if (!tool) {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }
    try {
      const result = await tool.handler(request.params.arguments ?? {});
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result as Record<string, unknown>,
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: errorMessage(error) }],
      };
    }
  });
  const transport = new StdioServerTransport(
    options.input as Readable | undefined,
    options.output as Writable | undefined,
  );
  await server.connect(transport);
}

function traceMcpRequest(server: string, method: string): void {
  const traceFile = process.env.SYMPHONY_MCP_TRACE_FILE;
  if (!traceFile) return;
  const line = JSON.stringify({
    at: new Date().toISOString(),
    server,
    method,
  });
  try {
    appendFileSync(traceFile, `${line}\n`, "utf8");
  } catch {
    // Tracing is diagnostic-only; never break the MCP protocol path.
  }
}

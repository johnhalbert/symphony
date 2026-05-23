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
  const server = new Server(
    { name: options.serverName, version: options.version },
    { capabilities: { tools: {} } },
  );
  const trace = (method: string): void => traceMcpRequest(options.serverName, method);
  server.oninitialized = () => trace("notifications/initialized");
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    trace("tools/list");
    return {
      tools: [
        {
          name: options.tool.name,
          description: options.tool.description,
          inputSchema: options.tool.inputSchema as Tool["inputSchema"],
        },
      ],
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    trace("tools/call");
    if (request.params.name !== options.tool.name) {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }
    try {
      const result = await options.tool.handler(request.params.arguments ?? {});
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

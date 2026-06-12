import { promises as fs } from "node:fs";
import path from "node:path";
import { SymphonyError } from "../errors.js";
import { FileRunTranscriptStore } from "../persistence/RunTranscriptStore.js";
import { DEFAULT_RECALL_BUDGET, TranscriptRecallService } from "../recall/TranscriptRecallService.js";
import type { TranscriptRecallSearchResult } from "../recall/TranscriptRecallService.js";
import type { AgentRunPhase, AgentRunRole, Issue } from "../types.js";
import { WorkflowLoader } from "../workflow/WorkflowLoader.js";
import { runSingleToolMcpServer } from "./McpSdkStdioServer.js";

export const TRANSCRIPT_RECALL_TOOL_NAME = "search_transcript_context";

export interface TranscriptRecallMcpContextFile {
  issue: Issue;
  activeRunId: string | null;
  role: AgentRunRole;
  phase: AgentRunPhase;
}

export async function writeTranscriptRecallMcpContext(
  filePath: string,
  context: TranscriptRecallMcpContextFile,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(context, null, 2)}\n`, "utf8");
}

export async function searchTranscriptContextFromMcp(input: unknown, options: {
  workflowPath: string;
  contextFile: string;
  service?: TranscriptRecallService;
}): Promise<unknown> {
  const loadedContext = await readTranscriptRecallContext(options.contextFile);
  const parsed = recallInputFromMcp(input);
  const loader = new WorkflowLoader(options.workflowPath);
  try {
    const loaded = await loader.load();
    const runStore = new FileRunTranscriptStore(loaded.serviceConfig.workspace.stateDir);
    const service =
      options.service ??
      new TranscriptRecallService({
        runStore,
      });
    const priorUsage = await readRecallBudgetUsage(runStore, loadedContext.activeRunId);
    const remainingEvents = Math.max(DEFAULT_RECALL_BUDGET.maxEvents - priorUsage.returnedEvents, 0);
    const remainingChars = Math.max(DEFAULT_RECALL_BUDGET.maxChars - priorUsage.returnedChars, 0);
    const denied =
      priorUsage.calls >= DEFAULT_RECALL_BUDGET.maxCalls || remainingEvents <= 0 || remainingChars <= 0;
    const result = denied
      ? deniedRecallResult(loadedContext.issue, parsed.query)
      : await service.search({
          issue: loadedContext.issue,
          query: parsed.query,
          maxEvents: Math.min(parsed.maxEvents ?? DEFAULT_RECALL_BUDGET.maxEvents, remainingEvents),
          maxChars: Math.min(parsed.maxChars ?? DEFAULT_RECALL_BUDGET.maxChars, remainingChars),
        });
    await recordRecallTelemetry(runStore, loadedContext.activeRunId, result);
    return result;
  } finally {
    await loader.close();
  }
}

async function readRecallBudgetUsage(
  runStore: FileRunTranscriptStore,
  activeRunId: string | null,
): Promise<{ calls: number; returnedEvents: number; returnedChars: number }> {
  if (!activeRunId) return { calls: 0, returnedEvents: 0, returnedChars: 0 };
  const usage = { calls: 0, returnedEvents: 0, returnedChars: 0 };
  let offset = 0;
  do {
    const page = await runStore.readTranscript(activeRunId, { offset, limit: 1_000 });
    for (const event of page.events) {
      if (event.eventType !== "transcript_recall" || !isRecord(event.payload)) continue;
      usage.calls += 1;
      usage.returnedEvents += numberValue(event.payload.returnedEvents);
      usage.returnedChars += numberValue(event.payload.returnedChars);
    }
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  } while (true);
  return usage;
}

function deniedRecallResult(
  issue: Issue,
  query: string,
): TranscriptRecallSearchResult {
  return {
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    query,
    callsRemaining: 0,
    denied: true,
    truncated: true,
    returnedEvents: 0,
    returnedChars: 0,
    runs: [],
  };
}

async function recordRecallTelemetry(
  runStore: FileRunTranscriptStore,
  activeRunId: string | null,
  result: TranscriptRecallSearchResult,
): Promise<void> {
  if (!activeRunId) return;
  await runStore.appendEvent({
    runId: activeRunId,
    at: new Date().toISOString(),
    source: "orchestrator",
    eventType: "transcript_recall",
    message:
      `Transcript recall returned ${result.returnedEvents} event(s), ${result.returnedChars} char(s); ` +
      `truncated=${result.truncated}; denied=${result.denied}; callsRemaining=${result.callsRemaining}`,
    payload: {
      issueId: result.issueId,
      issueIdentifier: result.issueIdentifier,
      query: result.query,
      returnedEvents: result.returnedEvents,
      returnedChars: result.returnedChars,
      truncated: result.truncated,
      denied: result.denied,
      callsRemaining: result.callsRemaining,
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export async function runTranscriptRecallMcpServer(options: {
  workflowPath: string;
  contextFile: string;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}): Promise<void> {
  const loader = new WorkflowLoader(options.workflowPath);
  try {
    const loaded = await loader.load();
    const service = new TranscriptRecallService({
      runStore: new FileRunTranscriptStore(loaded.serviceConfig.workspace.stateDir),
    });
    await runSingleToolMcpServer({
      serverName: "symphony-transcript-recall",
      version: "0.1.0",
      input: options.input,
      output: options.output,
      tool: {
        name: TRANSCRIPT_RECALL_TOOL_NAME,
        description: "Search bounded Symphony transcript history for this issue. Read-only; returns bookends and match windows, never full transcripts.",
        inputSchema: recallInputSchema(),
        handler: (input) => searchTranscriptContextFromMcp(input, { ...options, service }),
      },
    });
  } finally {
    await loader.close();
  }
}

async function readTranscriptRecallContext(filePath: string): Promise<TranscriptRecallMcpContextFile> {
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as TranscriptRecallMcpContextFile;
  if (!parsed.issue || (parsed.role !== "worker" && parsed.role !== "reviewer")) {
    throw new SymphonyError("invalid_request", "Transcript recall MCP context is invalid");
  }
  return parsed;
}

function recallInputFromMcp(input: unknown): { query: string; maxEvents?: number; maxChars?: number } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new SymphonyError("invalid_request", "Transcript recall input must be an object");
  }
  const record = input as Record<string, unknown>;
  if (typeof record.query !== "string" || record.query.trim().length === 0) {
    throw new SymphonyError("invalid_request", "query is required");
  }
  return {
    query: record.query,
    ...(typeof record.maxEvents === "number" ? { maxEvents: record.maxEvents } : {}),
    ...(typeof record.maxChars === "number" ? { maxChars: record.maxChars } : {}),
  };
}

function recallInputSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: {
        type: "string",
        minLength: 1,
        description: "Search text to match against persisted transcript messages and payloads for this issue.",
      },
      maxEvents: {
        type: "integer",
        minimum: 1,
        maximum: 20,
        description: "Optional per-call event cap. The service also enforces its configured budget.",
      },
      maxChars: {
        type: "integer",
        minimum: 500,
        maximum: 6000,
        description: "Optional per-call character cap. The service also enforces its configured budget.",
      },
    },
  };
}

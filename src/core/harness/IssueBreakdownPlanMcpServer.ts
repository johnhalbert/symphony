import { promises as fs } from "node:fs";
import path from "node:path";
import {
  IssueBreakdownPlanService,
  type IssueBreakdownPlanActiveContext,
} from "../IssueBreakdownPlanService.js";
import { SymphonyError } from "../errors.js";
import { FileIssueLifecycleStore } from "../persistence/IssueLifecycleStore.js";
import { FileRunTranscriptStore } from "../persistence/RunTranscriptStore.js";
import type { Issue, Workspace } from "../types.js";
import { WorkflowLoader } from "../workflow/WorkflowLoader.js";
import { runSingleToolMcpServer } from "./McpSdkStdioServer.js";

export const ISSUE_BREAKDOWN_PLAN_TOOL_NAME = "submit_issue_breakdown_plan";

export interface IssueBreakdownPlanMcpContextFile {
  issue: Issue;
  activeRunId: string | null;
  role: "planner" | "worker";
  phase: "issue_breakdown";
  sourceIssueTriageReportId?: string | null;
  workspacePath: string | null;
  workspace: Workspace;
}

export async function writeIssueBreakdownPlanMcpContext(
  filePath: string,
  context: IssueBreakdownPlanMcpContextFile,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(context, null, 2)}\n`, "utf8");
}

export async function submitIssueBreakdownPlanFromMcp(
  input: unknown,
  options: { workflowPath: string; contextFile: string },
): Promise<unknown> {
  const loadedContext = await readIssueBreakdownPlanContext(options.contextFile);
  if (!loadedContext.activeRunId) {
    throw new SymphonyError("invalid_request", "Issue breakdown plan context is not ready for the active run");
  }

  const loader = new WorkflowLoader(options.workflowPath);
  try {
    const loaded = await loader.load();
    const config = loaded.serviceConfig;
    const service = new IssueBreakdownPlanService({
      config,
      lifecycleStore: new FileIssueLifecycleStore(config.workspace.stateDir),
      runStore: new FileRunTranscriptStore(config.workspace.stateDir),
    });
    const context: IssueBreakdownPlanActiveContext = {
      issue: loadedContext.issue,
      activeRunId: loadedContext.activeRunId,
      role: loadedContext.role,
      phase: loadedContext.phase,
      sourceIssueTriageReportId:
        loadedContext.sourceIssueTriageReportId ?? null,
    };
    const result = await service.submit_issue_breakdown_plan(issueBreakdownPlanInputFromMcp(input, context), context);
    return {
      accepted: result.accepted,
      replayed: result.replayed,
      planId: result.plan.id,
      finalDisposition: result.plan.finalDisposition,
      proposedIssueCount: result.plan.proposedIssues.length,
    };
  } finally {
    await loader.close();
  }
}

export async function runIssueBreakdownPlanMcpServer(options: {
  workflowPath: string;
  contextFile: string;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}): Promise<void> {
  await runSingleToolMcpServer({
    serverName: "symphony-issue-breakdown-plan",
    version: "0.1.0",
    input: options.input,
    output: options.output,
    tool: {
      name: ISSUE_BREAKDOWN_PLAN_TOOL_NAME,
      description: "Submit a validated Symphony issue breakdown plan.",
      inputSchema: issueBreakdownPlanInputSchema(),
      handler: (input) => submitIssueBreakdownPlanFromMcp(input, options),
    },
  });
}

async function readIssueBreakdownPlanContext(filePath: string): Promise<IssueBreakdownPlanMcpContextFile> {
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as IssueBreakdownPlanMcpContextFile;
  if (!parsed.issue || !parsed.workspace || (parsed.role !== "planner" && parsed.role !== "worker") || parsed.phase !== "issue_breakdown") {
    throw new SymphonyError("invalid_request", "Issue breakdown plan MCP context is invalid");
  }
  return parsed;
}

export function issueBreakdownPlanInputSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["finalDisposition", "summary", "proposedIssues", "idempotencyKey"],
    properties: {
      finalDisposition: {
        type: "string",
        minLength: 1,
        description:
          "Complete standalone final response for this planning run. Symphony stores this text untruncated and writes it verbatim to Linear; return the same text as the terminal assistant response after the handoff is accepted.",
      },
      summary: {
        type: "string",
        minLength: 1,
        description: "Concise summary of the proposed issue breakdown.",
      },
      proposedIssues: {
        type: "array",
        minItems: 1,
        description: "Proposed issues to create or refine later; Symphony only persists them locally.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "description", "acceptanceCriteria", "dependencies", "labels"],
          properties: {
            title: { type: "string", minLength: 1 },
            description: {
              type: "string",
              minLength: 1,
              description:
                "Agent-eligible issue description using the required headings, including a schema-v2 `Issue Contract` fenced `json` block with contractVersion, requirements, required relationships.blocks/blockedBy arrays, and optional reciprocal succession.",
            },
            acceptanceCriteria: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
            dependencies: { type: "array", items: { type: "string", minLength: 1 } },
            labels: { type: "array", items: { type: "string", minLength: 1 } },
          },
        },
      },
      idempotencyKey: {
        type: "string",
        minLength: 1,
        description: "Stable unique key for this issue breakdown plan so retries are safe.",
      },
    },
  };
}

function issueBreakdownPlanInputFromMcp(input: unknown, context: IssueBreakdownPlanActiveContext): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  return {
    ...input,
    runId: context.activeRunId,
    issueId: context.issue.id,
  };
}

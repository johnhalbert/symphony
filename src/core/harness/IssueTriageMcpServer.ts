import { promises as fs } from "node:fs";
import path from "node:path";
import {
  ISSUE_TRIAGE_BLOCKER_KINDS,
  ISSUE_TRIAGE_BLOCKER_NEXT_ACTORS,
  ISSUE_TRIAGE_BLOCKER_STATUSES,
  IssueTriageService,
  issueTriageTriggerFingerprint,
  type IssueTriageActiveContext,
} from "../IssueTriageService.js";
import { SymphonyError } from "../errors.js";
import { FileIssueLifecycleStore } from "../persistence/IssueLifecycleStore.js";
import { FileRunTranscriptStore } from "../persistence/RunTranscriptStore.js";
import type { Issue, Workspace } from "../types.js";
import { FileWritebackOutboxStore } from "../writeback/WritebackOutbox.js";
import { WorkflowLoader } from "../workflow/WorkflowLoader.js";
import { runSingleToolMcpServer } from "./McpSdkStdioServer.js";

export const ISSUE_TRIAGE_TOOL_NAME = "submit_issue_triage_report";

export interface IssueTriageMcpContextFile {
  issue: Issue;
  activeRunId: string | null;
  role: "triage";
  phase: "issue_triage";
  workspacePath: string | null;
  workspace: Workspace;
}

export async function writeIssueTriageMcpContext(filePath: string, context: IssueTriageMcpContextFile): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(context, null, 2)}\n`, "utf8");
}

export async function submitIssueTriageReportFromMcp(
  input: unknown,
  options: { workflowPath: string; contextFile: string },
): Promise<unknown> {
  const loadedContext = await readIssueTriageContext(options.contextFile);
  if (!loadedContext.activeRunId) {
    throw new SymphonyError("invalid_request", "Issue triage context is not ready for the active run");
  }

  const loader = new WorkflowLoader(options.workflowPath);
  try {
    const loaded = await loader.load();
    const config = loaded.serviceConfig;
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const lifecycle = await lifecycleStore.get(loadedContext.issue.id);
    if (!lifecycle) {
      throw new SymphonyError("invalid_request", "Issue triage requires an existing lifecycle record");
    }
    const service = new IssueTriageService({
      config,
      lifecycleStore,
      writebackOutbox: new FileWritebackOutboxStore(config.workspace.stateDir),
      runStore: new FileRunTranscriptStore(config.workspace.stateDir),
    });
    const context: IssueTriageActiveContext = {
      issue: loadedContext.issue,
      activeRunId: loadedContext.activeRunId,
      role: loadedContext.role,
      phase: loadedContext.phase,
    };
    const result = await service.submit_issue_triage_report(issueTriageReportInputFromMcp(input, context, lifecycle), context);
    return {
      accepted: result.accepted,
      replayed: result.replayed,
      reportId: result.report.id,
      disposition: result.report.disposition,
      confidence: result.report.confidence,
      blockers: result.report.blockers.map((blocker) => ({
        kind: blocker.kind,
        status: blocker.status,
        nextActor: blocker.nextActor,
        confidence: blocker.confidence,
      })),
    };
  } finally {
    await loader.close();
  }
}

export async function runIssueTriageMcpServer(options: {
  workflowPath: string;
  contextFile: string;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}): Promise<void> {
  await runSingleToolMcpServer({
    serverName: "symphony-issue-triage",
    version: "0.1.0",
    input: options.input,
    output: options.output,
    tool: {
      name: ISSUE_TRIAGE_TOOL_NAME,
      description: "Submit a read-only Symphony issue triage blocker report for a max-failure blocked issue.",
      inputSchema: issueTriageReportInputSchema(),
      handler: (input) => submitIssueTriageReportFromMcp(input, options),
    },
  });
}

async function readIssueTriageContext(filePath: string): Promise<IssueTriageMcpContextFile> {
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as IssueTriageMcpContextFile;
  if (!parsed.issue || !parsed.workspace || parsed.role !== "triage" || parsed.phase !== "issue_triage") {
    throw new SymphonyError("invalid_request", "Issue triage MCP context is invalid");
  }
  return parsed;
}

function issueTriageReportInputSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["summary", "blockers", "idempotencyKey"],
    properties: {
      summary: {
        type: "string",
        minLength: 1,
        description: "Concise explanation of why the issue hit the max-failure path.",
      },
      blockers: {
        type: "array",
        minItems: 1,
        description: "Exhaustive blocker list. Include active blockers and downstream blockers that will remain after higher-precedence blockers are fixed.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "status", "nextActor", "confidence", "summary", "evidence", "recommendedAction"],
          properties: {
            kind: {
              type: "string",
              enum: [...ISSUE_TRIAGE_BLOCKER_KINDS],
              description: "Blocker category. Report every supported blocker kind that is active or downstream.",
            },
            status: {
              type: "string",
              enum: [...ISSUE_TRIAGE_BLOCKER_STATUSES],
              description: "Use active for blockers that currently prevent progress; downstream for blockers that remain after higher-precedence active blockers are fixed.",
            },
            nextActor: {
              type: "string",
              enum: [...ISSUE_TRIAGE_BLOCKER_NEXT_ACTORS],
              description: "Actor that should handle this blocker.",
            },
            confidence: {
              type: "string",
              enum: ["high", "medium", "low"],
              description: "Confidence in this blocker classification.",
            },
            summary: {
              type: "string",
              minLength: 1,
              description: "Concise blocker-specific explanation.",
            },
            evidence: {
              type: "array",
              minItems: 1,
              items: { type: "string", minLength: 1 },
              description: "Specific evidence from lifecycle records, review findings, merge gate data, logs, or code inspection.",
            },
            recommendedAction: {
              type: "string",
              minLength: 1,
              description: "Concrete next action for this blocker.",
            },
          },
        },
      },
      idempotencyKey: {
        type: "string",
        minLength: 1,
        description: "Stable unique key for this triage report so retries are safe.",
      },
    },
  };
}

function issueTriageReportInputFromMcp(input: unknown, context: IssueTriageActiveContext, lifecycle: Parameters<typeof issueTriageTriggerFingerprint>[0]): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  return {
    ...input,
    runId: context.activeRunId,
    issueId: context.issue.id,
    triggerFingerprint: issueTriageTriggerFingerprint(lifecycle),
  };
}

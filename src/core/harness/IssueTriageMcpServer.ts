import { promises as fs } from "node:fs";
import path from "node:path";
import { ISSUE_TRIAGE_DISPOSITIONS, IssueTriageService, issueTriageTriggerFingerprint, type IssueTriageActiveContext } from "../IssueTriageService.js";
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
      description: "Submit a classify-only Symphony issue triage report for a max-failure blocked issue.",
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
    required: ["disposition", "confidence", "summary", "evidence", "recommendedAction", "idempotencyKey"],
    properties: {
      disposition: {
        type: "string",
        enum: [...ISSUE_TRIAGE_DISPOSITIONS],
        description: "Classification for the max-failure blocked issue.",
      },
      confidence: {
        type: "string",
        enum: ["high", "medium", "low"],
        description: "Confidence in the selected disposition.",
      },
      summary: {
        type: "string",
        minLength: 1,
        description: "Concise explanation of why the issue hit the max-failure path.",
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
        description: "Concrete next operator/system action. For decompose_issue, name the hidden scope that should become subissues.",
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

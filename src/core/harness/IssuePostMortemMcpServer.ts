import { promises as fs } from "node:fs";
import path from "node:path";
import {
  ISSUE_POST_MORTEM_COMPLETION_STATUSES,
  ISSUE_POST_MORTEM_FOLLOW_UP_KINDS,
  ISSUE_POST_MORTEM_FOLLOW_UP_PRIORITIES,
  ISSUE_POST_MORTEM_SPECIFICATION_CLASSIFICATIONS,
  ISSUE_POST_MORTEM_SPECIFICATION_QUALITIES,
  IssuePostMortemService,
  issuePostMortemTriggerFingerprint,
  type IssuePostMortemActiveContext,
} from "../IssuePostMortemService.js";
import { SymphonyError } from "../errors.js";
import { FileIssueLifecycleStore } from "../persistence/IssueLifecycleStore.js";
import { FileRunTranscriptStore } from "../persistence/RunTranscriptStore.js";
import type { Issue, Workspace } from "../types.js";
import { FileWritebackOutboxStore } from "../writeback/WritebackOutbox.js";
import { WorkflowLoader } from "../workflow/WorkflowLoader.js";
import { runSingleToolMcpServer } from "./McpSdkStdioServer.js";

export const ISSUE_POST_MORTEM_TOOL_NAME = "submit_issue_post_mortem_report";

export interface IssuePostMortemMcpContextFile {
  issue: Issue;
  activeRunId: string | null;
  role: "post_mortem";
  phase: "post_mortem";
  workspacePath: string | null;
  workspace: Workspace;
  manualDispatch?: boolean;
}

export async function writeIssuePostMortemMcpContext(
  filePath: string,
  context: IssuePostMortemMcpContextFile,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(context, null, 2)}\n`, "utf8");
}

export async function submitIssuePostMortemReportFromMcp(
  input: unknown,
  options: { workflowPath: string; contextFile: string },
): Promise<unknown> {
  const loadedContext = await readIssuePostMortemContext(options.contextFile);
  if (!loadedContext.activeRunId) {
    throw new SymphonyError("invalid_request", "Issue post-mortem context is not ready for the active run");
  }

  const loader = new WorkflowLoader(options.workflowPath);
  try {
    const loaded = await loader.load();
    const config = loaded.serviceConfig;
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const lifecycle = await lifecycleStore.get(loadedContext.issue.id);
    if (!lifecycle) {
      throw new SymphonyError("invalid_request", "Issue post-mortem requires an existing lifecycle record");
    }
    const service = new IssuePostMortemService({
      config,
      lifecycleStore,
      writebackOutbox: new FileWritebackOutboxStore(config.workspace.stateDir),
      runStore: new FileRunTranscriptStore(config.workspace.stateDir),
    });
    const context: IssuePostMortemActiveContext = {
      issue: loadedContext.issue,
      activeRunId: loadedContext.activeRunId,
      role: loadedContext.role,
      phase: loadedContext.phase,
      ...(loadedContext.manualDispatch === true ? { manualDispatch: true } : {}),
    };
    const result = await service.submit_issue_post_mortem_report(
      issuePostMortemReportInputFromMcp(input, context, lifecycle),
      context,
    );
    return {
      accepted: result.accepted,
      replayed: result.replayed,
      reportId: result.report.id,
      completionStatus: result.report.completionJudgment.status,
      specificationQuality: result.report.specificationAssessment.quality,
      followUpCandidateCount: result.report.followUpCandidates.length,
    };
  } finally {
    await loader.close();
  }
}

export async function runIssuePostMortemMcpServer(options: {
  workflowPath: string;
  contextFile: string;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}): Promise<void> {
  await runSingleToolMcpServer({
    serverName: "symphony-issue-post-mortem",
    version: "0.1.0",
    input: options.input,
    output: options.output,
    tool: {
      name: ISSUE_POST_MORTEM_TOOL_NAME,
      description: "Submit a read-only Symphony post-mortem report for a completed issue.",
      inputSchema: issuePostMortemReportInputSchema(),
      handler: (input) => submitIssuePostMortemReportFromMcp(input, options),
    },
  });
}

async function readIssuePostMortemContext(filePath: string): Promise<IssuePostMortemMcpContextFile> {
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as IssuePostMortemMcpContextFile;
  if (!parsed.issue || !parsed.workspace || parsed.role !== "post_mortem" || parsed.phase !== "post_mortem") {
    throw new SymphonyError("invalid_request", "Issue post-mortem MCP context is invalid");
  }
  return parsed;
}

function issuePostMortemReportInputSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "summary",
      "completionJudgment",
      "specificationAssessment",
      "reviewAssessment",
      "followUpCandidates",
      "processLessons",
      "idempotencyKey",
    ],
    properties: {
      summary: {
        type: "string",
        minLength: 1,
        description: "Concise post-mortem summary of the issue outcome and most important lessons.",
      },
      completionJudgment: {
        type: "object",
        additionalProperties: false,
        required: ["status", "rationale"],
        properties: {
          status: {
            type: "string",
            enum: [...ISSUE_POST_MORTEM_COMPLETION_STATUSES],
            description: "Whether Done appears valid, valid with follow-ups, or questionable.",
          },
          rationale: {
            type: "string",
            minLength: 1,
            description: "Evidence-backed rationale for the completion judgment.",
          },
        },
      },
      specificationAssessment: {
        type: "object",
        additionalProperties: false,
        required: ["quality", "classifications", "missingContractAreas", "speckitRecommended", "speckitRationale"],
        properties: {
          quality: { type: "string", enum: [...ISSUE_POST_MORTEM_SPECIFICATION_QUALITIES] },
          classifications: {
            type: "array",
            minItems: 1,
            items: { type: "string", enum: [...ISSUE_POST_MORTEM_SPECIFICATION_CLASSIFICATIONS] },
            description: "Specification shape classifications. Use multiple values when appropriate.",
          },
          missingContractAreas: {
            type: "array",
            items: { type: "string", minLength: 1 },
            description: "Contract lanes or scenario axes that should have been explicit. Empty when none.",
          },
          speckitRecommended: {
            type: "boolean",
            description: "Whether a Spec Kit specify/plan/tasks/analyze flow is recommended before follow-up work.",
          },
          speckitRationale: {
            type: "string",
            minLength: 1,
            description: "Reason for or against Spec Kit follow-up.",
          },
        },
      },
      reviewAssessment: {
        type: "object",
        additionalProperties: false,
        required: ["gateDecisionLooksValid", "missedGateFindings", "missedDiscoveryFindings"],
        properties: {
          gateDecisionLooksValid: {
            type: "boolean",
            description: "Whether the final pass/fail gate decision looks valid under the bounded reviewer standard.",
          },
          missedGateFindings: {
            type: "array",
            items: { type: "string", minLength: 1 },
            description: "Contract-entitled defects the final reviewer likely missed. Empty when none.",
          },
          missedDiscoveryFindings: {
            type: "array",
            items: { type: "string", minLength: 1 },
            description: "Non-gating hardening/scope discoveries the final reviewer likely missed. Empty when none.",
          },
        },
      },
      followUpCandidates: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "priority", "kind", "rationale", "readyForSpecKit", "suggestedIssueContract"],
          properties: {
            title: { type: "string", minLength: 1 },
            priority: { type: "string", enum: [...ISSUE_POST_MORTEM_FOLLOW_UP_PRIORITIES] },
            kind: { type: "string", enum: [...ISSUE_POST_MORTEM_FOLLOW_UP_KINDS] },
            rationale: { type: "string", minLength: 1 },
            readyForSpecKit: { type: "boolean" },
            suggestedIssueContract: {
              anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
              description: "Optional fenced-contract-ready issue body when the candidate is mature enough.",
            },
          },
        },
      },
      processLessons: {
        type: "array",
        items: { type: "string", minLength: 1 },
        description: "Actionable lessons about issue specification, review behavior, orchestration, or validation.",
      },
      idempotencyKey: {
        type: "string",
        minLength: 1,
        description: "Stable unique key for this post-mortem report so retries are safe.",
      },
    },
  };
}

function issuePostMortemReportInputFromMcp(
  input: unknown,
  context: IssuePostMortemActiveContext,
  lifecycle: Parameters<typeof issuePostMortemTriggerFingerprint>[0],
): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  return {
    ...input,
    runId: context.activeRunId,
    issueId: context.issue.id,
    triggerFingerprint: issuePostMortemTriggerFingerprint(lifecycle, context.issue),
  };
}

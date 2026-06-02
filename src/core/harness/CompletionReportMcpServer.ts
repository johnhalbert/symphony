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
import { StructuredLogger } from "../logging/StructuredLogger.js";
import { createGitHubPullRequestClientForCapability } from "../../integrations/github/GitHubCredentialResolver.js";
import { SymphonyError } from "../errors.js";
import { FileOperatorApprovalStore, OperatorApprovalService } from "../approval/OperatorApprovalService.js";
import { runSingleToolMcpServer } from "./McpSdkStdioServer.js";
import { createRuntimeWritebackProcessor } from "../../app/RuntimeDependencies.js";

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
    const logger = new StructuredLogger(() => undefined);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const writebackOutbox = new FileWritebackOutboxStore(config.workspace.stateDir);
    const writebackProcessor =
      config.writeback.enabled && (config.github.operatorApproval?.requiredForPublication ?? false)
        ? createRuntimeWritebackProcessor(() => config, logger, undefined, { outboxStore: writebackOutbox, lifecycleStore })
        : undefined;
    const operatorApproval = new OperatorApprovalService({
      config,
      store: new FileOperatorApprovalStore(config.workspace.stateDir),
      runStore,
    });
    const approvalRequiredForPublication = config.github.operatorApproval?.requiredForPublication ?? false;
    const pullRequestPublisher =
      options.pullRequestPublisher ??
      (config.github.publishPullRequests && !approvalRequiredForPublication
        ? createGitHubPullRequestClientForCapability(config, "github.publication")
        : undefined);
    const service = new CompletionReportService({
      config,
      lifecycleStore,
      writebackOutbox,
      ...(writebackProcessor === undefined ? {} : { writebackProcessor }),
      runStore,
      ...(pullRequestPublisher === undefined ? {} : { pullRequestPublisher }),
      operatorApproval,
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
    const result = await service.submit_completion_report(completionReportInputFromMcp(input, context), context);
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
  await runSingleToolMcpServer({
    serverName: "symphony-completion-report",
    version: "0.1.0",
    input: options.input,
    output: options.output,
    tool: {
      name: COMPLETION_REPORT_TOOL_NAME,
      description:
        "Submit a Symphony worker completion report for review handoff. For implementation runs, this is the publication handoff; leave changes uncommitted and unpushed so Symphony can perform the service-owned commit, push, and PR creation/reuse.",
      inputSchema: completionReportInputSchema(),
      handler: (input) => submitCompletionReportFromMcp(input, options),
    },
  });
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
      summary: {
        type: "string",
        minLength: 1,
        description: "Concise summary of the implementation completed in the active worker run.",
      },
      validationEvidence: {
        type: "array",
        minItems: 1,
        description: "Commands, checks, or manual verification performed before handoff.",
        items: { type: "string", minLength: 1 },
      },
      acceptanceChecklist: {
        type: "array",
        minItems: 1,
        description: "One item per acceptance criterion, including whether it is satisfied and the supporting evidence.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["text", "satisfied", "evidence"],
          properties: {
            text: { type: "string", minLength: 1, description: "Acceptance criterion text." },
            satisfied: { type: "boolean", description: "Whether the implementation satisfies this criterion." },
            evidence: {
              description: "Specific proof for the status, or null when no durable evidence is available.",
              anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
            },
          },
        },
      },
      changedFiles: {
        type: "array",
        description: "Files materially changed by the worker run.",
        items: { type: "string", minLength: 1 },
      },
      branchName: {
        description: "Current implementation branch, or null if no branch is available.",
        anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
      },
      pullRequest: {
        description: "Existing pull request reference if one is already known; otherwise null.",
        anyOf: [
          { type: "null" },
          {
            type: "object",
            additionalProperties: false,
            required: ["url", "number"],
            properties: {
              url: {
                description: "Pull request URL, or null when absent.",
                anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
              },
              number: {
                description: "Pull request number, or null when absent.",
                anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }],
              },
              headSha: {
                description: "Current pull request head SHA, or null when unknown.",
                anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
              },
              branch: {
                description: "Pull request head branch, or null when unknown.",
                anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
              },
            },
          },
        ],
      },
      risks: {
        type: "array",
        description: "Known risks, limitations, or follow-up concerns; use an empty array when none are known.",
        items: { type: "string", minLength: 1 },
      },
      idempotencyKey: {
        type: "string",
        minLength: 1,
        description: "Stable unique key for this completion report so retries are safe.",
      },
    },
  };
}

function completionReportInputFromMcp(input: unknown, context: CompletionReportActiveContext): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  return {
    ...input,
    runId: context.activeRunId,
    issueId: context.issue.id,
  };
}


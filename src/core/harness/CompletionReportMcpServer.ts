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
import { SqliteWritebackOutboxStore } from "../writeback/WritebackOutbox.js";
import { StructuredLogger } from "../logging/StructuredLogger.js";
import { createGitHubPullRequestClientForCapability } from "../../integrations/github/GitHubCredentialResolver.js";
import { SymphonyError } from "../errors.js";
import { FileOperatorApprovalStore, OperatorApprovalService } from "../approval/OperatorApprovalService.js";
import { runSingleToolMcpServer } from "./McpSdkStdioServer.js";
import {
  createRuntimeTrackerClient,
  createRuntimeWritebackProcessor,
} from "../../app/RuntimeDependencies.js";
import { SqliteIssueStateStore } from "../orchestration/SqliteIssueStateStore.js";
import { IssueLifecycleEvidenceRecorder } from "../orchestration/IssueLifecycleEvidenceRecorder.js";

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
  ignoreStateGate?: boolean;
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
  resolveIssuesByIds?: (issueIds: string[]) => Promise<Issue[]>;
}): Promise<unknown> {
  const loadedContext = await readCompletionReportContext(options.contextFile);
  if (!loadedContext.activeRunId) {
    throw new SymphonyError("invalid_request", "Completion report context is not ready for the active run");
  }

  const loader = new WorkflowLoader(options.workflowPath);
  let writebackOutbox: SqliteWritebackOutboxStore | null = null;
  let issueStateStore: SqliteIssueStateStore | null = null;
  try {
    const loaded = await loader.load();
    const config = loaded.serviceConfig;
    const logger = new StructuredLogger(() => undefined);
    const runStore = new FileRunTranscriptStore(config.workspace.stateDir);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    issueStateStore = new SqliteIssueStateStore(config.workspace.stateDir);
    const lifecycleEvidenceRecorder = new IssueLifecycleEvidenceRecorder({
      config,
      lifecycleStore,
      runStore,
      issueStateStore,
      logger,
    });
    writebackOutbox = new SqliteWritebackOutboxStore(config.workspace.stateDir);
    const writebackProcessor =
      config.writeback.enabled && (config.github.operatorApproval?.requiredForPublication ?? false)
        ? createRuntimeWritebackProcessor(() => config, logger, undefined, { outboxStore: writebackOutbox, lifecycleStore })
        : undefined;
    const operatorApproval = new OperatorApprovalService({
      config,
      store: new FileOperatorApprovalStore(config.workspace.stateDir),
      runStore,
    });
    const tracker = createRuntimeTrackerClient(config);
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
      resolveIssuesByIds:
        options.resolveIssuesByIds ??
        ((issueIds) => tracker.fetchIssueStatesByIds(issueIds)),
      recordLifecycleEvidence: (input) =>
        lifecycleEvidenceRecorder.record(input),
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
      ignoreStateGate: loadedContext.ignoreStateGate === true,
    };
    const result = await service.submit_completion_report(completionReportInputFromMcp(input, context), context);
    return {
      accepted: result.accepted,
      replayed: result.replayed,
      reportId: result.report.id,
      finalDisposition: result.report.finalDisposition,
      pullRequest: result.report.pullRequest,
      writebackOperationKeys: result.report.writebackOperationKeys,
    };
  } finally {
    await writebackOutbox?.close();
    await issueStateStore?.close();
    await loader.close();
  }
}

export async function runCompletionReportMcpServer(options: {
  workflowPath: string;
  contextFile: string;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  resolveIssuesByIds?: (issueIds: string[]) => Promise<Issue[]>;
}): Promise<void> {
  await runSingleToolMcpServer({
    serverName: "symphony-completion-report",
    version: "0.1.0",
    input: options.input,
    output: options.output,
    tool: {
      name: COMPLETION_REPORT_TOOL_NAME,
      description:
        "Submit a Symphony worker completion report for review handoff. Merge deliveries report green validation; accepted expected-red test artifacts report structured artifactEvidence. Leave changes uncommitted and unpushed so Symphony can perform the service-owned commit, push, and PR creation/reuse.",
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

export function completionReportInputSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "finalDisposition",
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
      finalDisposition: {
        type: "string",
        minLength: 1,
        description:
          "Complete standalone final response for this worker run. Symphony stores this text untruncated and writes it verbatim to Linear; return the same text as the terminal assistant response after the handoff is accepted.",
      },
      summary: {
        type: "string",
        minLength: 1,
        description:
          "Concise summary of the review-ready implementation or accepted test-artifact deliverable completed in the active worker run.",
      },
      validationEvidence: {
        type: "array",
        minItems: 1,
        description:
          "Commands, checks, or manual verification performed before handoff. Merge deliveries require successful evidence. An accepted expected-red test artifact may cite its intentional failure here only when artifactEvidence records the exact command and failure.",
        items: { type: "string", minLength: 1 },
      },
      acceptanceChecklist: {
        type: "array",
        minItems: 1,
        description:
          "One satisfied item per acceptance criterion. If the issue has a fenced JSON Issue Contract, include one item per requirement id and prove each with exact durable evidence. The completion report is rejected when any item is unsatisfied.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["text", "satisfied", "evidence"],
          properties: {
            text: {
              type: "string",
              minLength: 1,
              description: "Acceptance criterion text. Prefix with the Issue Contract requirement id, such as `REQ-001`, when available.",
            },
            satisfied: { type: "boolean", description: "Whether the implementation satisfies this criterion." },
            evidence: {
              description:
                "Specific proof for the status, or null when no durable evidence is available. Cite exact commands, emitted artifact fields, API responses, logs, tests, or file paths; for operator docs, prove the documented invocation produces the documented artifact.",
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
      artifactEvidence: {
        description:
          "Required only when the Issue Contract declares delivery.mode=accepted_artifact and artifact=expected_red_tests; omit it for merge delivery. Every testFiles entry must also appear in changedFiles.",
        type: "object",
        additionalProperties: false,
        required: ["kind", "command", "testFiles", "expectedFailure", "observedFailure", "exitCode"],
        properties: {
          kind: { type: "string", const: "expected_red_tests" },
          command: {
            type: "string",
            minLength: 1,
            description: "Exact deterministic command used to exercise the new tests.",
          },
          testFiles: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { type: "string", minLength: 1 },
            description: "New or changed test files that produced the expected failure.",
          },
          expectedFailure: {
            type: "string",
            minLength: 1,
            description: "Assertion or missing behavior the test contract expects to fail before implementation.",
          },
          observedFailure: {
            type: "string",
            minLength: 1,
            description:
              "Stable exact excerpt copied from command output that proves the intended assertion, not an unrelated setup or tooling error.",
          },
          exitCode: {
            type: "integer",
            minimum: 1,
            description: "Positive nonzero exit code returned by the expected-red command.",
          },
        },
      },
      dependencyArtifactResult: {
        description:
          "Required when Symphony seeded this workspace from a Dependency Artifact Checkpoint; proves the inherited expected-red command is green after implementation. Omit when no checkpoint was supplied.",
        type: "object",
        additionalProperties: false,
        required: ["artifactId", "command", "exitCode", "evidence"],
        properties: {
          artifactId: {
            type: "string",
            minLength: 1,
            description: "Artifact identifier from the injected Dependency Artifact Checkpoint.",
          },
          command: {
            type: "string",
            minLength: 1,
            description: "The inherited artifact's declared test command.",
          },
          exitCode: {
            type: "integer",
            const: 0,
            description: "Successful exit code from the inherited expected-red command after implementation.",
          },
          evidence: {
            type: "string",
            minLength: 1,
            description: "Concrete output or test summary proving the inherited tests now pass.",
          },
        },
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

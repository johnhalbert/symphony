import { promises as fs } from "node:fs";
import path from "node:path";
import {
  CompletionReportService,
  type CompletionReportActiveContext,
  type CompletionReportPullRequestPublisher,
} from "../CompletionReportService.js";
import { FileIssueLifecycleStore, type IssueLifecycleRecord } from "../persistence/IssueLifecycleStore.js";
import { FileRunTranscriptStore, type RunRecord } from "../persistence/RunTranscriptStore.js";
import { normalizeProjectContextResolution, type ProjectContextResolution } from "../config/ProjectContexts.js";
import type { Issue, Workspace } from "../types.js";
import { WorkflowLoader } from "../workflow/WorkflowLoader.js";
import { FileWritebackOutboxStore } from "../writeback/WritebackOutbox.js";
import { StructuredLogger } from "../logging/StructuredLogger.js";
import { createGitHubPullRequestClientForCapability } from "../../integrations/github/GitHubCredentialResolver.js";
import { SymphonyError } from "../errors.js";
import { FileOperatorApprovalStore, OperatorApprovalService } from "../approval/OperatorApprovalService.js";
import { runSingleToolMcpServer } from "./McpSdkStdioServer.js";
import { createRuntimeTrackerClient, createRuntimeWritebackProcessor } from "../../app/RuntimeDependencies.js";
import type { TrackerClient } from "../tracker/TrackerClient.js";

export const COMPLETION_REPORT_TOOL_NAME = "submit_completion_report";

export interface CompletionReportMcpContextFile {
  issue: Issue;
  projectContext?: ProjectContextResolution | undefined;
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

export interface CompletionReportMcpSubmitOptions {
  workflowPath: string;
  contextFile: string;
  pullRequestPublisher?: CompletionReportPullRequestPublisher;
  tracker?: Pick<TrackerClient, "fetchIssueStatesByIds">;
}

export async function submitCompletionReportFromMcp(input: unknown, options: CompletionReportMcpSubmitOptions): Promise<unknown> {
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
    const activeRun = await runStore.getRun(loadedContext.activeRunId);
    const lifecycle = await lifecycleStore.get(activeRun?.issueId ?? loadedContext.issue.id);
    validateCompletionReportMcpActiveContext({ context: loadedContext, input, activeRun, lifecycle });
    if (!activeRun || !lifecycle) {
      throw new SymphonyError("invalid_request", "Completion report MCP context does not match the active worker run");
    }
    const tracker = options.tracker ?? createRuntimeTrackerClient(config);
    const authoritativeIssue = await resolveAuthoritativeCompletionReportIssue(
      tracker,
      activeRun.issueId,
      activeRun.issueIdentifier,
    );
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
    const context = completionReportContextFromAuthoritativeState({
      context: loadedContext,
      activeRun,
      lifecycle,
      issue: authoritativeIssue,
    });
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

export async function runCompletionReportMcpServer(options: CompletionReportMcpSubmitOptions & {
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

async function resolveAuthoritativeCompletionReportIssue(
  tracker: Pick<TrackerClient, "fetchIssueStatesByIds">,
  issueId: string,
  issueIdentifier: string,
): Promise<Issue> {
  try {
    const issue = (await tracker.fetchIssueStatesByIds([issueId]))[0] ?? null;
    if (!issue) {
      throw new SymphonyError("tracker_error", "Completion report MCP could not load the authoritative issue state", {
        issueId,
        issueIdentifier,
      });
    }
    if (issue.id !== issueId || issue.identifier !== issueIdentifier) {
      throw new SymphonyError(
        "invalid_request",
        "Completion report MCP authoritative issue does not match the active worker run",
      );
    }
    return issue;
  } catch (error) {
    if (error instanceof SymphonyError) throw error;
    throw new SymphonyError("tracker_error", "Completion report MCP could not load the authoritative issue state", {
      issueId,
      issueIdentifier,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function completionReportContextFromAuthoritativeState(input: {
  context: CompletionReportMcpContextFile;
  activeRun: RunRecord;
  lifecycle: IssueLifecycleRecord;
  issue: Issue;
}): CompletionReportActiveContext {
  const { context, activeRun, lifecycle, issue } = input;
  return {
    issue,
    projectContext: activeRun.projectContext,
    activeRunId: activeRun.runId,
    role: context.role,
    token: context.token ?? null,
    expectedToken: context.expectedToken ?? null,
    sessionId: activeRun.sessionId ?? null,
    workspacePath: activeRun.workspacePath,
    workspace: {
      path: activeRun.workspacePath,
      workspaceKey: activeRun.workspaceKey,
      createdNow: context.workspace.createdNow,
      issueId: activeRun.issueId,
      issueIdentifier: activeRun.issueIdentifier,
      ...(activeRun.gitBranchName == null ? {} : { gitBranchName: activeRun.gitBranchName }),
      ...(activeRun.repoPath == null ? {} : { repoPath: activeRun.repoPath }),
      ...(activeRun.baseRef == null ? {} : { baseRef: activeRun.baseRef }),
    },
    phase: lifecycle.phase,
  };
}

function validateCompletionReportMcpActiveContext(input: {
  context: CompletionReportMcpContextFile;
  input: unknown;
  activeRun: RunRecord | null;
  lifecycle: IssueLifecycleRecord | null;
}): void {
  const { context, activeRun, lifecycle } = input;
  if (!activeRun || activeRun.role !== "worker") {
    throw new SymphonyError("invalid_request", "Completion report MCP context does not match the active worker run");
  }

  const mismatches: string[] = [];
  const allowsTerminalReplay = allowsTerminalCompletionReportReplay(input.lifecycle, input.input, activeRun.runId);
  if (!lifecycle || lifecycle.summaryPointers.lastRunId !== activeRun.runId) mismatches.push("summaryPointers.lastRunId");
  if (activeRun.runPhase !== "implementation") mismatches.push("runPhase");
  if (activeRun.status !== "running" && !allowsTerminalReplay) mismatches.push("status");
  if (activeRun.issueId !== context.issue.id) mismatches.push("issue.id");
  if (activeRun.issueIdentifier !== context.issue.identifier) mismatches.push("issue.identifier");
  if (activeRun.workspaceKey !== context.workspace.workspaceKey) mismatches.push("workspace.workspaceKey");
  if (activeRun.workspacePath !== context.workspace.path) mismatches.push("workspace.path");
  if (context.workspacePath !== null && activeRun.workspacePath !== context.workspacePath) mismatches.push("workspacePath");
  if (context.workspace.issueId !== activeRun.issueId) mismatches.push("workspace.issueId");
  if (context.workspace.issueIdentifier !== activeRun.issueIdentifier) mismatches.push("workspace.issueIdentifier");
  if (context.sessionId !== null && (activeRun.sessionId ?? null) !== context.sessionId) mismatches.push("sessionId");
  if ((context.workspace.gitBranchName ?? null) !== (activeRun.gitBranchName ?? null)) {
    mismatches.push("workspace.gitBranchName");
  }
  if ((context.workspace.repoPath ?? null) !== (activeRun.repoPath ?? null)) {
    mismatches.push("workspace.repoPath");
  }
  if ((context.workspace.baseRef ?? null) !== (activeRun.baseRef ?? null)) {
    mismatches.push("workspace.baseRef");
  }
  mismatches.push(...projectContextMismatches(context.projectContext, activeRun.projectContext));

  if (mismatches.length > 0) {
    throw new SymphonyError(
      "invalid_request",
      `Completion report MCP context does not match the active worker run (${mismatches.join(", ")})`,
    );
  }
}

function allowsTerminalCompletionReportReplay(
  lifecycle: IssueLifecycleRecord | null,
  input: unknown,
  runId: string,
): boolean {
  const idempotencyKey = completionReportIdempotencyKeyFromInput(input);
  if (!lifecycle || !idempotencyKey) return false;
  return lifecycle.completionReports.some(
    (report) => report.idempotencyKey === idempotencyKey && report.runId === runId && report.acceptedAt !== null,
  );
}

function completionReportIdempotencyKeyFromInput(input: unknown): string | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const idempotencyKey = (input as { idempotencyKey?: unknown }).idempotencyKey;
  return typeof idempotencyKey === "string" && idempotencyKey.trim().length > 0 ? idempotencyKey : null;
}

function projectContextMismatches(
  context: ProjectContextResolution | undefined,
  activeRunContext: ProjectContextResolution | undefined,
): string[] {
  const expected = normalizeProjectContextResolution(activeRunContext);
  const actual = normalizeProjectContextResolution(context);
  const mismatches: string[] = [];
  if (actual.projectContextId !== expected.projectContextId) mismatches.push("projectContext.projectContextId");
  if (actual.projectContextLabel !== expected.projectContextLabel) mismatches.push("projectContext.projectContextLabel");
  if (actual.linearProjectSlug !== expected.linearProjectSlug) mismatches.push("projectContext.linearProjectSlug");
  if (actual.routingSource !== expected.routingSource) mismatches.push("projectContext.routingSource");
  return mismatches;
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
        description:
          "One item per acceptance criterion. If the issue has a fenced JSON Issue Contract, include one item per requirement id and prove each with exact durable evidence.",
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


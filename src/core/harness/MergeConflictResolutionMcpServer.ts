import { promises as fs } from "node:fs";
import path from "node:path";
import {
  MergeConflictResolutionService,
  type MergeConflictResolutionActiveContext,
} from "../MergeConflictResolutionService.js";
import { FileIssueLifecycleStore } from "../persistence/IssueLifecycleStore.js";
import type { Issue, Workspace } from "../types.js";
import { WorkflowLoader } from "../workflow/WorkflowLoader.js";
import { FileWritebackOutboxStore } from "../writeback/WritebackOutbox.js";
import { SymphonyError } from "../errors.js";
import { runSingleToolMcpServer } from "./McpSdkStdioServer.js";

export const MERGE_CONFLICT_RESOLUTION_TOOL_NAME = "submit_merge_conflict_resolution";

export interface MergeConflictResolutionMcpContextFile {
  issue: Issue;
  activeRunId: string | null;
  role: "worker";
  token?: string | null;
  expectedToken?: string | null;
  sessionId?: string | null;
  workspacePath: string | null;
  workspace: Workspace;
  phase: "merge_conflict_resolution";
}

export async function writeMergeConflictResolutionMcpContext(
  filePath: string,
  context: MergeConflictResolutionMcpContextFile,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(context, null, 2)}\n`, "utf8");
}

export async function submitMergeConflictResolutionFromMcp(input: unknown, options: {
  workflowPath: string;
  contextFile: string;
}): Promise<unknown> {
  const loadedContext = await readMergeConflictResolutionContext(options.contextFile);
  if (!loadedContext.activeRunId) {
    throw new SymphonyError("invalid_request", "Merge conflict resolution context is not ready for the active run");
  }

  const loader = new WorkflowLoader(options.workflowPath);
  try {
    const loaded = await loader.load();
    const config = loaded.serviceConfig;
    const service = new MergeConflictResolutionService({
      config,
      lifecycleStore: new FileIssueLifecycleStore(config.workspace.stateDir),
      writebackOutbox: new FileWritebackOutboxStore(config.workspace.stateDir),
    });
    const context: MergeConflictResolutionActiveContext = {
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
    const result = await service.submit_merge_conflict_resolution(
      mergeConflictResolutionInputFromMcp(input, context),
      context,
    );
    return {
      accepted: result.accepted,
      replayed: result.replayed,
      reportId: result.report.id,
      resolutionStatus: result.report.resolutionStatus,
      mergeConflict: result.mergeConflict,
      writebackOperationKeys: result.writebackOperations.map((operation) => operation.idempotencyKey),
    };
  } finally {
    await loader.close();
  }
}

export async function runMergeConflictResolutionMcpServer(options: {
  workflowPath: string;
  contextFile: string;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}): Promise<void> {
  await runSingleToolMcpServer({
    serverName: "symphony-merge-conflict-resolution",
    version: "0.1.0",
    input: options.input,
    output: options.output,
    tool: {
      name: MERGE_CONFLICT_RESOLUTION_TOOL_NAME,
      description: "Submit a Symphony merge-conflict resolution report for a scoped conflict-fix worker.",
      inputSchema: mergeConflictResolutionInputSchema(),
      handler: (input) => submitMergeConflictResolutionFromMcp(input, options),
    },
  });
}

async function readMergeConflictResolutionContext(filePath: string): Promise<MergeConflictResolutionMcpContextFile> {
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as MergeConflictResolutionMcpContextFile;
  if (!parsed.issue || !parsed.workspace || parsed.role !== "worker" || parsed.phase !== "merge_conflict_resolution") {
    throw new SymphonyError("invalid_request", "Merge conflict resolution MCP context is invalid");
  }
  return parsed;
}

function mergeConflictResolutionInputSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "resolutionStatus",
      "summary",
      "validationEvidence",
      "changedFiles",
      "pullRequest",
      "previousHeadSha",
      "newHeadSha",
      "baseBranch",
      "baseHeadSha",
      "risks",
      "idempotencyKey",
    ],
    properties: {
      resolutionStatus: {
        type: "string",
        enum: ["resolved", "still_conflicted", "blocked"],
        description:
          "Whether the conflict-fix worker resolved the merge conflicts, they remain conflicted, or human intervention is now required.",
      },
      summary: { type: "string", minLength: 1 },
      validationEvidence: {
        type: "array",
        minItems: 1,
        items: { type: "string", minLength: 1 },
      },
      changedFiles: {
        type: "array",
        items: { type: "string", minLength: 1 },
      },
      pullRequest: {
        type: "object",
        additionalProperties: false,
        required: ["url", "number", "headSha", "branch"],
        properties: {
          url: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
          number: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
          headSha: { type: "string", minLength: 1 },
          branch: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
        },
      },
      previousHeadSha: {
        type: "string",
        minLength: 1,
        description: "PR head SHA from the mergeConflict.currentHeadSha field before this conflict-fix attempt.",
      },
      newHeadSha: {
        type: "string",
        minLength: 1,
        description: "PR head SHA after this conflict-fix attempt; must match pullRequest.headSha.",
      },
      baseBranch: {
        type: "string",
        minLength: 1,
        description: "GitHub PR base branch recorded in mergeConflict.baseBranch.",
      },
      baseHeadSha: {
        type: "string",
        minLength: 1,
        description: "GitHub PR base commit SHA recorded in mergeConflict.baseHeadSha.",
      },
      blockedReason: {
        anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
        description: "Required context when resolutionStatus is blocked.",
      },
      risks: {
        type: "array",
        items: { type: "string", minLength: 1 },
      },
      idempotencyKey: {
        type: "string",
        minLength: 1,
        description: "Stable unique key for this conflict-resolution report so retries are safe.",
      },
    },
  };
}

function mergeConflictResolutionInputFromMcp(input: unknown, context: MergeConflictResolutionActiveContext): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  return {
    ...input,
    runId: context.activeRunId,
    issueId: context.issue.id,
  };
}

import { promises as fs } from "node:fs";
import path from "node:path";
import { createGitHubPullRequestClientForCapability } from "../../integrations/github/GitHubCredentialResolver.js";
import { withProjectContextServiceConfig } from "../config/ProjectContexts.js";
import { SymphonyError } from "../errors.js";
import { FileIssueLifecycleStore } from "../persistence/IssueLifecycleStore.js";
import {
  PullRequestReviewFeedbackService,
  reviewFeedbackInputSchema,
  type ReviewFeedbackActiveContext,
} from "../review/PullRequestReviewFeedbackService.js";
import type { Issue } from "../types.js";
import { WorkflowLoader } from "../workflow/WorkflowLoader.js";
import { runSingleToolMcpServer } from "./McpSdkStdioServer.js";

export const REVIEW_FEEDBACK_TOOL_NAME = "submit_pull_request_review_feedback";

export interface ReviewFeedbackMcpContextFile {
  issue: Issue;
  activeRunId: string | null;
  role: "reviewer";
  token?: string | null;
  expectedToken?: string | null;
  reviewer?: string | null;
  phase: "review";
}

export async function writeReviewFeedbackMcpContext(
  filePath: string,
  context: ReviewFeedbackMcpContextFile,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(context, null, 2)}\n`, "utf8");
}

export async function submitReviewFeedbackFromMcp(input: unknown, options: {
  workflowPath: string;
  contextFile: string;
}): Promise<unknown> {
  const loadedContext = await readReviewFeedbackContext(options.contextFile);
  if (!loadedContext.activeRunId) {
    throw new SymphonyError("invalid_request", "Review feedback context is not ready for the active run");
  }

  const loader = new WorkflowLoader(options.workflowPath);
  try {
    const loaded = await loader.load();
    const config = withProjectContextServiceConfig(loaded.serviceConfig, loadedContext.issue.projectContextId);
    const service = new PullRequestReviewFeedbackService({
      config,
      lifecycleStore: new FileIssueLifecycleStore(config.workspace.stateDir),
      client: createGitHubPullRequestClientForCapability(config, "github.review_feedback_write"),
    });
    const context: ReviewFeedbackActiveContext = {
      issue: loadedContext.issue,
      activeRunId: loadedContext.activeRunId,
      role: loadedContext.role,
      token: loadedContext.token ?? null,
      expectedToken: loadedContext.expectedToken ?? null,
      reviewer: loadedContext.reviewer ?? null,
      phase: loadedContext.phase,
    };
    const result = await service.submit_pull_request_review_feedback(input, context);
    return {
      accepted: result.accepted,
      replayed: result.replayed,
      feedbackId: result.feedback.id,
      pullRequest: result.pullRequest,
      reviewUrl: result.reviewUrl,
      commentUrls: result.commentUrls,
      urls: result.urls,
    };
  } finally {
    await loader.close();
  }
}

export async function runReviewFeedbackMcpServer(options: {
  workflowPath: string;
  contextFile: string;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}): Promise<void> {
  await runSingleToolMcpServer({
    serverName: "symphony-review-feedback",
    version: "0.1.0",
    input: options.input,
    output: options.output,
    tool: {
      name: REVIEW_FEEDBACK_TOOL_NAME,
      description: "Submit reviewer-owned GitHub PR feedback for the active lifecycle-bound pull request.",
      inputSchema: reviewFeedbackInputSchema(),
      handler: (input) => submitReviewFeedbackFromMcp(input, options),
    },
  });
}

async function readReviewFeedbackContext(filePath: string): Promise<ReviewFeedbackMcpContextFile> {
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as ReviewFeedbackMcpContextFile;
  if (!parsed.issue || parsed.role !== "reviewer") {
    throw new SymphonyError("invalid_request", "Review feedback MCP context is invalid");
  }
  return parsed;
}


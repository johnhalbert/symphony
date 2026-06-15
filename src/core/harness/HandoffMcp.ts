import path from "node:path";
import type { AgentHarness, AgentRunContext, OperatorChatRunContext } from "./AgentHarness.js";
import { writeCompletionReportMcpContext } from "./CompletionReportMcpServer.js";
import { writeIssueBreakdownPlanMcpContext } from "./IssueBreakdownPlanMcpServer.js";
import { writeIssuePostMortemMcpContext } from "./IssuePostMortemMcpServer.js";
import { writeIssueTriageMcpContext } from "./IssueTriageMcpServer.js";
import { writeMergeConflictResolutionMcpContext } from "./MergeConflictResolutionMcpServer.js";
import {
  buildMcpSubprocessServerConfig,
  type McpSubprocessServerConfig,
} from "./McpSubprocessEnvironment.js";
import { writeOperatorChatMcpContext } from "./OperatorChatMcpServer.js";
import { writeReviewFeedbackMcpContext } from "./ReviewFeedbackMcpServer.js";
import { writeReviewVerdictMcpContext } from "./ReviewVerdictMcpServer.js";
import { writeTranscriptRecallMcpContext } from "./TranscriptRecallMcpServer.js";
import type { AgentRunPhase, AgentRunRole, Issue } from "../types.js";

export interface RuntimeHandoffPromptInput {
  issue: Issue;
  role?: AgentRunRole;
  workspacePath?: string | null;
  branchName?: string | null;
  repoPath?: string | null;
  baseRef?: string | null;
}

export function harnessSupportsContinuation(harness: Pick<AgentHarness, "capabilities" | "supportsContinuation">): boolean {
  return harness.capabilities?.continuation ?? harness.supportsContinuation ?? true;
}

export function harnessSupportsMcpHandoff(harness: Pick<AgentHarness, "capabilities">): boolean {
  return harness.capabilities?.mcpHandoff ?? true;
}

export function symphonyRoleMcpServers(
  ctx: AgentRunContext,
  options: { cliPath: string; mcpCwd?: string },
): Record<string, McpSubprocessServerConfig> {
  if (ctx.operatorChat) {
    return symphonyOperatorChatMcpServers(operatorChatRunContextFromAgentContext(ctx), options);
  }
  const applyCwd = (server: McpSubprocessServerConfig): McpSubprocessServerConfig =>
    options.mcpCwd === undefined ? server : { ...server, cwd: options.mcpCwd };
  if (ctx.role === "worker" && currentRunPhase(ctx) === "implementation") {
    return {
      symphony: applyCwd(completionReportMcpServerConfig(ctx, completionReportContextFilePath(ctx), options)),
      ...transcriptRecallMcpServerEntry(ctx, options, applyCwd),
    };
  }
  if (ctx.role === "worker" && currentRunPhase(ctx) === "merge_conflict_resolution") {
    return {
      symphony_conflicts: applyCwd(
        mergeConflictResolutionMcpServerConfig(ctx, mergeConflictResolutionContextFilePath(ctx), options),
      ),
      ...transcriptRecallMcpServerEntry(ctx, options, applyCwd),
    };
  }
  if ((ctx.role === "planner" || ctx.role === "worker") && currentRunPhase(ctx) === "issue_breakdown") {
    return {
      symphony_planning: applyCwd(issueBreakdownPlanMcpServerConfig(ctx, issueBreakdownPlanContextFilePath(ctx), options)),
      ...transcriptRecallMcpServerEntry(ctx, options, applyCwd),
    };
  }
  if (ctx.role === "triage" && currentRunPhase(ctx) === "issue_triage") {
    return {
      symphony_triage: applyCwd(issueTriageMcpServerConfig(ctx, issueTriageContextFilePath(ctx), options)),
      ...transcriptRecallMcpServerEntry(ctx, options, applyCwd),
    };
  }
  if (ctx.role === "post_mortem" && currentRunPhase(ctx) === "post_mortem") {
    return {
      symphony_post_mortem: applyCwd(issuePostMortemMcpServerConfig(ctx, issuePostMortemContextFilePath(ctx), options)),
      ...transcriptRecallMcpServerEntry(ctx, options, applyCwd),
    };
  }
  return {
    symphony_review_verdict: applyCwd(reviewVerdictMcpServerConfig(ctx, reviewVerdictContextFilePath(ctx), options)),
    symphony_review_feedback: applyCwd(reviewFeedbackMcpServerConfig(ctx, reviewFeedbackContextFilePath(ctx), options)),
    ...transcriptRecallMcpServerEntry(ctx, options, applyCwd),
  };
}

export function symphonyOperatorChatMcpServers(
  ctx: OperatorChatRunContext,
  options: { cliPath: string; mcpCwd?: string },
): Record<string, McpSubprocessServerConfig> {
  const server = operatorChatMcpServerConfig(ctx, operatorChatContextFilePath(ctx), options);
  return {
    symphony_operator: options.mcpCwd === undefined ? server : { ...server, cwd: options.mcpCwd },
  };
}

export async function writeInitialHandoffMcpContexts(ctx: AgentRunContext): Promise<void> {
  await writeHandoffMcpContexts(ctx, { activeRunId: null, sessionId: null });
}

export async function writeActiveHandoffMcpContexts(
  ctx: AgentRunContext,
  input: { activeRunId: string; sessionId: string },
): Promise<void> {
  await writeHandoffMcpContexts(ctx, input);
}

export async function writeInitialOperatorChatMcpContext(ctx: OperatorChatRunContext): Promise<void> {
  await writeOperatorChatMcpContext(operatorChatContextFilePath(ctx), {
    conversationId: ctx.conversationId,
    activeRunId: null,
    sessionId: null,
    statusBaseUrl: ctx.statusServer?.baseUrl ?? null,
    mutationToken: ctx.statusServer?.mutationToken ?? null,
  });
}

export async function writeActiveOperatorChatMcpContext(
  ctx: OperatorChatRunContext,
  input: { activeRunId: string; sessionId: string },
): Promise<void> {
  await writeOperatorChatMcpContext(operatorChatContextFilePath(ctx), {
    conversationId: ctx.conversationId,
    activeRunId: input.activeRunId,
    sessionId: input.sessionId,
    statusBaseUrl: ctx.statusServer?.baseUrl ?? null,
    mutationToken: ctx.statusServer?.mutationToken ?? null,
  });
}

export function renderOperatorChatMcpPrompt(input: { conversationId: string; statusBaseUrl: string | null }): string {
  return [
    "",
    "Symphony MCP operator tools:",
    `- Conversation: ${input.conversationId}`,
    `- Status API: ${input.statusBaseUrl ?? "unavailable"}`,
    "- Use the service-owned Symphony MCP tools for dashboard reads and lifecycle actions.",
    "- Mutating tools require an idempotencyKey. Reuse a key only when retrying the exact same intended action.",
    "- Do not request raw Linear, GitHub, filesystem, or host credentials. Symphony performs lifecycle operations through these tools.",
    "- For risky or irreversible operations, explain the intended action in the chat before using the tool.",
  ].join("\n");
}

export function renderCompletionMcpHandoffPrompt(input: RuntimeHandoffPromptInput): string {
  return [
    "",
    "Symphony MCP completion handoff:",
    `- Active issue: ${input.issue.identifier} (${input.issue.id})`,
    `- Active role: ${input.role ?? "worker"}`,
    `- Workspace path: ${input.workspacePath ?? "n/a"}`,
    `- Branch: ${input.branchName ?? input.issue.branchName ?? "n/a"}`,
    `- Repository path: ${input.repoPath ?? "n/a"}`,
    `- Base ref: ${input.baseRef ?? "n/a"}`,
    "- Before ending the run, call the submit_completion_report MCP tool with summary, validationEvidence, acceptanceChecklist, changedFiles, branchName, pullRequest, risks, and idempotencyKey.",
    "- If the issue description contains a fenced JSON Issue Contract, treat its requirements as the authoritative acceptance contract: include one acceptanceChecklist item for every requirement `id`, start the item text with that `id`, and mark it satisfied only when the evidence proves the exact required behavior.",
    "- Evidence must cite durable proof such as commands run, emitted artifact fields, API responses, logs, tests, or file paths. When the issue asks for operator instructions or recorded artifacts, verify that the documented command invocation actually produces the documented fields; do not rely on inferred behavior or nearby implementation details.",
    "- Leave implementation changes uncommitted and unpushed in the assigned worktree. Do not run git commit, git push, gh pr create, or gh pr edit; the allowed GitHub path is the Symphony service-owned GitHub workflow through submit_completion_report, and Symphony performs service-owned commit, push, and PR creation/reuse after the completion report is accepted.",
    "- The MCP server is scoped to this issue and the current runtime run; Symphony injects runId and issueId for you.",
    "- Do not comment on Linear, transition Linear state, or request broad Linear write credentials. Symphony handles writeback after the tool accepts the report.",
  ].join("\n");
}

export function renderReviewMcpHandoffPrompt(input: RuntimeHandoffPromptInput): string {
  return [
    "",
    "Symphony MCP review handoff:",
    `- Active issue: ${input.issue.identifier} (${input.issue.id})`,
    `- Active role: ${input.role ?? "reviewer"}`,
    `- Workspace path: ${input.workspacePath ?? "n/a"}`,
    `- Branch: ${input.branchName ?? input.issue.branchName ?? "n/a"}`,
    `- Repository path: ${input.repoPath ?? "n/a"}`,
    `- Base ref: ${input.baseRef ?? "n/a"}`,
    "- Use submit_pull_request_review_feedback for GitHub PR review feedback before submit_review_verdict; the allowed GitHub review-write path is the Symphony service-owned review feedback workflow against the lifecycle-bound PR.",
    "- Do not run gh pr review, gh pr comment, git push, direct GitHub API/curl writes, or otherwise write to GitHub directly from the reviewer command surface.",
    "- After submit_pull_request_review_feedback succeeds, pass the returned reviewUrl/commentUrls/urls into submit_review_verdict.evidence, then call submit_review_verdict before ending the run.",
    "- Use gateFindings only for contract-entitled defects that may block the worker. Put inferred scope, hidden matrix axes, sibling issue scope, future hardening, and out-of-scope observations in discoveryFindings; discoveryFindings do not make a verdict fail by themselves.",
    "- The MCP servers are scoped to this issue, active reviewer run, and lifecycle-bound PR; Symphony injects runId, issueId, PR number, repository, token, and commit identity when a tool needs them.",
    "- Do not comment on Linear, transition Linear state, or request broad Linear or GitHub credentials. Symphony handles review writeback after the tools accept the report.",
  ].join("\n");
}

export function renderIssueBreakdownMcpHandoffPrompt(input: RuntimeHandoffPromptInput): string {
  return [
    "",
    "Symphony MCP issue-breakdown handoff:",
    `- Active issue: ${input.issue.identifier} (${input.issue.id})`,
    `- Active role: ${input.role ?? "planner"}`,
    "- Active phase: issue_breakdown",
    "- Before ending the run, call the submit_issue_breakdown_plan MCP tool with summary, proposedIssues, and idempotencyKey.",
    "- Each proposed issue must include title, description, acceptanceCriteria, dependencies, and labels.",
    "- Each proposed issue description must use the required agent-eligible section headings: `Problem / Goal`, `Issue Contract`, `Touched Surfaces`, `Acceptance Criteria`, `Contract Checklist`, `Validation Requirements`, `Out Of Scope`, and `Promotion Readiness`.",
    "- In `Issue Contract`, include a fenced `json` block with a positive integer `schemaVersion`, a non-empty `contractVersion`, and a non-empty `requirements` array whose entries have stable unique `id` values and non-empty `requirement` text.",
    "- In `Touched Surfaces`, list the exact repo paths or globs for any protected or high-risk workflow areas. If a proposed issue touches protected workflow areas, keep \"Ready for `dogfood-ready`: no\", record a non-empty remaining blocker that explains the manual-only requirement, and do not include `dogfood-ready` in labels.",
    "- Use the same section names for docs-only and implementation issue drafts; do not include secrets, tokens, private keys, or credential values.",
    "- Do not include `dogfood-ready` automatically in proposed labels. Operators add readiness labels only after reviewing the contract checklist and validation plan.",
    "- Do not call submit_completion_report, comment on Linear, transition Linear state, or create child issues.",
    "- Symphony persists the plan locally and injects it into the later implementation prompt after validation.",
  ].join("\n");
}

export function renderIssueTriageMcpHandoffPrompt(input: RuntimeHandoffPromptInput): string {
  return [
    "",
    "Symphony MCP issue-triage handoff:",
    `- Active issue: ${input.issue.identifier} (${input.issue.id})`,
    "- Active role: triage",
    "- Active phase: issue_triage",
    `- Workspace path: ${input.workspacePath ?? "n/a"}`,
    `- Repository path: ${input.repoPath ?? "n/a"}`,
    `- Base ref: ${input.baseRef ?? "n/a"}`,
    "- Before ending the run, call the submit_issue_triage_report MCP tool with summary, blockers, and idempotencyKey.",
    "- This is classify-only triage. Inspect the lifecycle evidence and repository context as needed, but do not edit files, create commits, push branches, transition Linear state, comment on Linear, or create subissues.",
    "- Report an exhaustive blocker list. Include active blockers and downstream blockers that will remain after higher-precedence blockers are fixed.",
    "- Do not collapse blockers into one category. Lower-precedence PR, CI, merge, or review-gate blockers must not mask active implementation, validation, decomposition, or orchestration-context blockers.",
    "- Each blocker must include kind, status, nextActor, confidence, summary, evidence, and recommendedAction.",
    "- Evidence must name concrete lifecycle records, review findings, merge-gate facts, commands, logs, or code paths that support each blocker.",
    "- After the MCP tool accepts the report, Symphony publishes a service-owned Linear triage comment with the recommendation. Do not write to Linear directly.",
  ].join("\n");
}

export function renderIssuePostMortemMcpHandoffPrompt(input: RuntimeHandoffPromptInput): string {
  return [
    "",
    "Symphony MCP issue-post-mortem handoff:",
    `- Active issue: ${input.issue.identifier} (${input.issue.id})`,
    "- Active role: post_mortem",
    "- Active phase: post_mortem",
    `- Workspace path: ${input.workspacePath ?? "n/a"}`,
    `- Repository path: ${input.repoPath ?? "n/a"}`,
    `- Base ref: ${input.baseRef ?? "n/a"}`,
    "- Before ending the run, call the submit_issue_post_mortem_report MCP tool with summary, completionJudgment, specificationAssessment, reviewAssessment, followUpCandidates, processLessons, and idempotencyKey.",
    "- This is an exhaustive read-only post-mortem. Inspect the issue contract, lifecycle evidence, final worker report, final review, PR, tests, and repository context as needed.",
    "- Do not edit files, create commits, push branches, transition Linear state, comment on Linear, create subissues, or reopen work.",
    "- Keep the gate assessment bounded: missedGateFindings are only for defects that should have blocked Done under the explicit contract standard.",
    "- Put hardening opportunities, hidden scope, weak specifications, missing matrix lanes, and future work in followUpCandidates or missedDiscoveryFindings instead of treating them as retroactive gate failures.",
    "- Use speckitRecommended when the follow-up work should go through specify/plan/tasks/analyze before implementation.",
    "- After the MCP tool accepts the report, Symphony publishes a service-owned Linear post-mortem comment. Do not write to Linear directly.",
  ].join("\n");
}

export function renderMergeConflictResolutionMcpHandoffPrompt(input: RuntimeHandoffPromptInput): string {
  return [
    "",
    "Symphony MCP merge-conflict-resolution handoff:",
    `- Active issue: ${input.issue.identifier} (${input.issue.id})`,
    "- Active role: worker",
    "- Active phase: merge_conflict_resolution",
    `- Workspace path: ${input.workspacePath ?? "n/a"}`,
    `- Branch: ${input.branchName ?? input.issue.branchName ?? "n/a"}`,
    `- Repository path: ${input.repoPath ?? "n/a"}`,
    `- Base ref: ${input.baseRef ?? "n/a"}`,
    "- Before ending the run, call the submit_merge_conflict_resolution MCP tool with resolutionStatus, summary, validationEvidence, changedFiles, pullRequest, previousHeadSha, baseBranch, baseHeadSha, risks, idempotencyKey, and newHeadSha when known.",
    "- Use resolutionStatus=\"resolved\" only after the conflicted file contents are repaired; use resolutionStatus=\"still_conflicted\" when conflicts remain; use resolutionStatus=\"blocked\" when human intervention is required now.",
    "- Do not run git fetch, pull, merge, rebase, commit, push, or continue/abort/skip a rebase. Symphony owns the git choreography around this worktree.",
    "- previousHeadSha must match the current conflict head from the prompt. For service-prepared conflicts, omit newHeadSha or set it to null; otherwise newHeadSha must match pullRequest.headSha after your attempt.",
    "- The MCP server is scoped to this issue and current conflict-fix run; Symphony injects runId and issueId for you.",
  ].join("\n");
}

async function writeHandoffMcpContexts(
  ctx: AgentRunContext,
  input: { activeRunId: string | null; sessionId: string | null },
): Promise<void> {
  if (ctx.operatorChat) {
    await writeOperatorChatMcpContext(operatorChatContextFilePath(operatorChatRunContextFromAgentContext(ctx)), {
      conversationId: ctx.operatorChat.conversationId,
      activeRunId: input.activeRunId,
      sessionId: input.sessionId,
      statusBaseUrl: ctx.operatorChat.statusServer?.baseUrl ?? null,
      mutationToken: ctx.operatorChat.statusServer?.mutationToken ?? null,
    });
    return;
  }
  const phase = currentRunPhase(ctx);
  if (ctx.config.continuationContext.searchEnabled) {
    await writeTranscriptRecallMcpContext(transcriptRecallContextFilePath(ctx), {
      issue: ctx.issue,
      activeRunId: input.activeRunId,
      role: ctx.role,
      phase,
    });
  }
  if (ctx.role === "worker" && phase === "implementation") {
    await writeCompletionReportMcpContext(completionReportContextFilePath(ctx), {
      issue: ctx.issue,
      activeRunId: input.activeRunId,
      role: "worker",
      token: null,
      expectedToken: null,
      sessionId: input.sessionId,
      workspacePath: ctx.workspace.path,
      workspace: ctx.workspace,
      phase: "implementation",
      ...(ctx.manualDispatchIgnoreState === true ? { ignoreStateGate: true } : {}),
    });
    return;
  }
  if (ctx.role === "worker" && phase === "merge_conflict_resolution") {
    await writeMergeConflictResolutionMcpContext(mergeConflictResolutionContextFilePath(ctx), {
      issue: ctx.issue,
      activeRunId: input.activeRunId,
      role: "worker",
      token: null,
      expectedToken: null,
      sessionId: input.sessionId,
      workspacePath: ctx.workspace.path,
      workspace: ctx.workspace,
      phase: "merge_conflict_resolution",
      ...(ctx.manualDispatchIgnoreState === true ? { ignoreStateGate: true } : {}),
    });
    return;
  }
  if ((ctx.role === "planner" || ctx.role === "worker") && phase === "issue_breakdown") {
    await writeIssueBreakdownPlanMcpContext(issueBreakdownPlanContextFilePath(ctx), {
      issue: ctx.issue,
      activeRunId: input.activeRunId,
      role: ctx.role === "planner" ? "planner" : "worker",
      workspacePath: ctx.workspace.path,
      workspace: ctx.workspace,
      phase: "issue_breakdown",
    });
    return;
  }
  if (ctx.role === "triage" && phase === "issue_triage") {
    await writeIssueTriageMcpContext(issueTriageContextFilePath(ctx), {
      issue: ctx.issue,
      activeRunId: input.activeRunId,
      role: "triage",
      workspacePath: ctx.workspace.path,
      workspace: ctx.workspace,
      phase: "issue_triage",
      ...(ctx.manualDispatch === true ? { manualDispatch: true } : {}),
    });
    return;
  }
  if (ctx.role === "post_mortem" && phase === "post_mortem") {
    await writeIssuePostMortemMcpContext(issuePostMortemContextFilePath(ctx), {
      issue: ctx.issue,
      activeRunId: input.activeRunId,
      role: "post_mortem",
      workspacePath: ctx.workspace.path,
      workspace: ctx.workspace,
      phase: "post_mortem",
      ...(ctx.manualDispatch === true ? { manualDispatch: true } : {}),
    });
    return;
  }
  if (ctx.role !== "reviewer") return;
  await writeReviewVerdictMcpContext(reviewVerdictContextFilePath(ctx), {
    issue: ctx.issue,
    activeRunId: input.activeRunId,
    role: "reviewer",
    token: null,
    expectedToken: null,
    reviewer: input.sessionId,
    phase: "review",
    ...(ctx.manualDispatchIgnoreState === true ? { ignoreStateGate: true } : {}),
  });
  await writeReviewFeedbackMcpContext(reviewFeedbackContextFilePath(ctx), {
    issue: ctx.issue,
    activeRunId: input.activeRunId,
    role: "reviewer",
    token: null,
    expectedToken: null,
    reviewer: input.sessionId,
    phase: "review",
    ...(ctx.manualDispatchIgnoreState === true ? { ignoreStateGate: true } : {}),
  });
}

function transcriptRecallMcpServerEntry(
  ctx: AgentRunContext,
  options: { cliPath: string },
  applyCwd: (server: McpSubprocessServerConfig) => McpSubprocessServerConfig,
): Record<string, McpSubprocessServerConfig> {
  return ctx.config.continuationContext.searchEnabled
    ? {
        symphony_recall: applyCwd(transcriptRecallMcpServerConfig(ctx, transcriptRecallContextFilePath(ctx), options)),
      }
    : {};
}

export function completionReportMcpServerConfig(
  ctx: AgentRunContext,
  contextFile: string,
  options: { cliPath: string },
): McpSubprocessServerConfig {
  return buildMcpSubprocessServerConfig({
    config: ctx.config,
    command: "completion-report-mcp",
    cliPath: options.cliPath,
    workflowPath: ctx.config.workflowPath,
    contextFile,
  });
}

export function mergeConflictResolutionMcpServerConfig(
  ctx: AgentRunContext,
  contextFile: string,
  options: { cliPath: string },
): McpSubprocessServerConfig {
  return buildMcpSubprocessServerConfig({
    config: ctx.config,
    command: "merge-conflict-resolution-mcp",
    cliPath: options.cliPath,
    workflowPath: ctx.config.workflowPath,
    contextFile,
  });
}

export function issueBreakdownPlanMcpServerConfig(
  ctx: AgentRunContext,
  contextFile: string,
  options: { cliPath: string },
): McpSubprocessServerConfig {
  return buildMcpSubprocessServerConfig({
    config: ctx.config,
    command: "issue-breakdown-plan-mcp",
    cliPath: options.cliPath,
    workflowPath: ctx.config.workflowPath,
    contextFile,
  });
}

export function issueTriageMcpServerConfig(
  ctx: AgentRunContext,
  contextFile: string,
  options: { cliPath: string },
): McpSubprocessServerConfig {
  return buildMcpSubprocessServerConfig({
    config: ctx.config,
    command: "issue-triage-mcp",
    cliPath: options.cliPath,
    workflowPath: ctx.config.workflowPath,
    contextFile,
  });
}

export function issuePostMortemMcpServerConfig(
  ctx: AgentRunContext,
  contextFile: string,
  options: { cliPath: string },
): McpSubprocessServerConfig {
  return buildMcpSubprocessServerConfig({
    config: ctx.config,
    command: "issue-post-mortem-mcp",
    cliPath: options.cliPath,
    workflowPath: ctx.config.workflowPath,
    contextFile,
  });
}

export function reviewVerdictMcpServerConfig(
  ctx: AgentRunContext,
  contextFile: string,
  options: { cliPath: string },
): McpSubprocessServerConfig {
  return buildMcpSubprocessServerConfig({
    config: ctx.config,
    command: "review-verdict-mcp",
    cliPath: options.cliPath,
    workflowPath: ctx.config.workflowPath,
    contextFile,
  });
}

export function reviewFeedbackMcpServerConfig(
  ctx: AgentRunContext,
  contextFile: string,
  options: { cliPath: string },
): McpSubprocessServerConfig {
  return buildMcpSubprocessServerConfig({
    config: ctx.config,
    command: "review-feedback-mcp",
    cliPath: options.cliPath,
    workflowPath: ctx.config.workflowPath,
    contextFile,
  });
}

export function transcriptRecallMcpServerConfig(
  ctx: AgentRunContext,
  contextFile: string,
  options: { cliPath: string },
): McpSubprocessServerConfig {
  return buildMcpSubprocessServerConfig({
    config: ctx.config,
    command: "transcript-recall-mcp",
    cliPath: options.cliPath,
    workflowPath: ctx.config.workflowPath,
    contextFile,
  });
}

export function operatorChatMcpServerConfig(
  ctx: OperatorChatRunContext,
  contextFile: string,
  options: { cliPath: string },
): McpSubprocessServerConfig {
  return buildMcpSubprocessServerConfig({
    config: ctx.config,
    command: "operator-chat-mcp",
    cliPath: options.cliPath,
    workflowPath: ctx.config.workflowPath,
    contextFile,
  });
}

export function completionReportContextFilePath(ctx: AgentRunContext): string {
  return path.join(
    ctx.config.workspace.stateDir,
    "completion-report-mcp",
    `${safeFileName(ctx.issue.id)}-${ctx.turnNumber}.json`,
  );
}

export function mergeConflictResolutionContextFilePath(ctx: AgentRunContext): string {
  return path.join(
    ctx.config.workspace.stateDir,
    "merge-conflict-resolution-mcp",
    `${safeFileName(ctx.issue.id)}-${ctx.turnNumber}.json`,
  );
}

export function issueBreakdownPlanContextFilePath(ctx: AgentRunContext): string {
  return path.join(
    ctx.config.workspace.stateDir,
    "issue-breakdown-plan-mcp",
    `${safeFileName(ctx.issue.id)}-${ctx.turnNumber}.json`,
  );
}

export function issueTriageContextFilePath(ctx: AgentRunContext): string {
  return path.join(
    ctx.config.workspace.stateDir,
    "issue-triage-mcp",
    `${safeFileName(ctx.issue.id)}-${ctx.turnNumber}.json`,
  );
}

export function issuePostMortemContextFilePath(ctx: AgentRunContext): string {
  return path.join(
    ctx.config.workspace.stateDir,
    "issue-post-mortem-mcp",
    `${safeFileName(ctx.issue.id)}-${ctx.turnNumber}.json`,
  );
}

export function reviewVerdictContextFilePath(ctx: AgentRunContext): string {
  return path.join(
    ctx.config.workspace.stateDir,
    "review-verdict-mcp",
    `${safeFileName(ctx.issue.id)}-${ctx.turnNumber}.json`,
  );
}

export function reviewFeedbackContextFilePath(ctx: AgentRunContext): string {
  return path.join(
    ctx.config.workspace.stateDir,
    "review-feedback-mcp",
    `${safeFileName(ctx.issue.id)}-${ctx.turnNumber}.json`,
  );
}

export function transcriptRecallContextFilePath(ctx: AgentRunContext): string {
  return path.join(
    ctx.config.workspace.stateDir,
    "transcript-recall-mcp",
    `${safeFileName(ctx.issue.id)}-${ctx.role}-${ctx.turnNumber}.json`,
  );
}

export function operatorChatContextFilePath(ctx: OperatorChatRunContext): string {
  return path.join(
    ctx.config.workspace.stateDir,
    "operator-chat-mcp",
    `${safeFileName(ctx.conversationId)}-${ctx.turnNumber}.json`,
  );
}

export function currentRunPhase(ctx: AgentRunContext): AgentRunPhase {
  return ctx.runPhase ?? (ctx.role === "reviewer" ? "review" : ctx.role === "triage" ? "issue_triage" : ctx.role === "post_mortem" ? "post_mortem" : ctx.role === "planner" ? "issue_breakdown" : "implementation");
}

function operatorChatRunContextFromAgentContext(ctx: AgentRunContext): OperatorChatRunContext {
  if (!ctx.operatorChat) throw new Error("Agent context is not an operator chat context");
  return {
    conversationId: ctx.operatorChat.conversationId,
    messageId: ctx.operatorChat.messageId,
    workspace: ctx.workspace,
    config: ctx.config,
    turnNumber: ctx.turnNumber,
    abortSignal: ctx.abortSignal,
    logger: ctx.logger,
    statusServer: ctx.operatorChat.statusServer ?? null,
  };
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_") || "context";
}

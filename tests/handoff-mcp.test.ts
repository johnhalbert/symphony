import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRunContext } from "../src/core/harness/AgentHarness.js";
import {
  mergeConflictResolutionContextFilePath,
  renderCompletionMcpHandoffPrompt,
  renderIssueBreakdownMcpHandoffPrompt,
  renderReviewMcpHandoffPrompt,
  reviewVerdictContextFilePath,
  writeActiveHandoffMcpContexts,
} from "../src/core/harness/HandoffMcp.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import { issue, testConfig } from "./helpers.js";

describe("MCP handoff prompt rendering", () => {
  it("requires issue-breakdown proposals to include the agent-eligible issue contract", () => {
    const prompt = renderIssueBreakdownMcpHandoffPrompt({ issue: issue({ identifier: "ENG-1" }) });

    expect(prompt).toContain("Symphony MCP issue-breakdown handoff:");
    expect(prompt).toContain("Problem / Goal");
    expect(prompt).toContain("Issue Contract");
    expect(prompt).toContain("Contract Checklist");
    expect(prompt).toContain("Validation Requirements");
    expect(prompt).toContain("fenced `json` block");
    expect(prompt).toContain("stable unique `id` values");
    expect(prompt).toContain("exact repo paths or globs");
    expect(prompt).toContain("manual-only requirement");
    expect(prompt).toContain("Do not include `dogfood-ready` automatically");
    expect(prompt).toContain("do not include secrets, tokens, private keys, or credential values");
  });

  it("identifies submit_completion_report as the only allowed worker GitHub publication path", () => {
    const prompt = renderCompletionMcpHandoffPrompt({
      issue: issue({ id: "issue-1", identifier: "ENG-1", branchName: "symphony/ENG-1" }),
      role: "worker",
      workspacePath: "/workspace/ENG-1",
      repoPath: "/repo/symphony",
      baseRef: "origin/main",
    });

    expect(prompt).toContain("submit_completion_report");
    expect(prompt).toContain("Symphony service-owned GitHub workflow");
    expect(prompt).toContain("Do not run git commit");
    expect(prompt).toContain("git push");
    expect(prompt).toContain("gh pr create");
    expect(prompt).toContain("gh pr edit");
    expect(prompt).toContain("service-owned commit, push, and PR creation/reuse");
  });

  it("requires completion reports to map Issue Contract requirements to durable proof", () => {
    const prompt = renderCompletionMcpHandoffPrompt({
      issue: issue({ id: "issue-1", identifier: "ENG-1", branchName: "symphony/ENG-1" }),
      role: "worker",
      workspacePath: "/workspace/ENG-1",
      repoPath: "/repo/symphony",
      baseRef: "origin/main",
    });

    expect(prompt).toContain("fenced JSON Issue Contract");
    expect(prompt).toContain("one acceptanceChecklist item for every requirement `id`");
    expect(prompt).toContain("start the item text with that `id`");
    expect(prompt).toContain("documented command invocation actually produces the documented fields");
    expect(prompt).toContain("do not rely on inferred behavior");
  });

  it("identifies review-feedback MCP as the only allowed reviewer GitHub review-write path", () => {
    const prompt = renderReviewMcpHandoffPrompt({
      issue: issue({ id: "issue-1", identifier: "ENG-1", state: "In Review", branchName: "symphony/ENG-1" }),
      role: "reviewer",
      workspacePath: "/workspace/ENG-1",
      repoPath: "/repo/symphony",
      baseRef: "origin/main",
    });

    expect(prompt).toContain("submit_pull_request_review_feedback");
    expect(prompt).toContain("submit_review_verdict");
    expect(prompt).toContain("Symphony service-owned review feedback workflow");
    expect(prompt).toContain("lifecycle-bound PR");
    expect(prompt).toContain("Do not run gh pr review");
    expect(prompt).toContain("direct GitHub API/curl writes");
    expect(prompt).toContain("reviewUrl/commentUrls/urls");
  });
});

describe("MCP handoff context files", () => {
  it("writes project context into merge-conflict worker handoff payloads", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-handoff-mcp-"));
    try {
      const config = testConfig(root);
      config.mergePolicy.mode = "gated";
      config.mergePolicy.conflictsState = "Approved with Conflicts";
      const ctx = handoffContext(config, {
        role: "worker",
        issueState: "Approved with Conflicts",
        runPhase: "merge_conflict_resolution",
        projectContext: docsProjectContext,
      });

      await writeActiveHandoffMcpContexts(ctx, {
        activeRunId: "conflict-run-1",
        sessionId: "conflict-session-1",
      });

      const payload = JSON.parse(await readFile(mergeConflictResolutionContextFilePath(ctx), "utf8"));
      expect(payload).toMatchObject({
        activeRunId: "conflict-run-1",
        role: "worker",
        phase: "merge_conflict_resolution",
        projectContext: docsProjectContext,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes project context into reviewer verdict handoff payloads", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-handoff-mcp-"));
    try {
      const config = testConfig(root);
      const ctx = handoffContext(config, {
        role: "reviewer",
        issueState: "In Review",
        projectContext: docsProjectContext,
      });

      await writeActiveHandoffMcpContexts(ctx, {
        activeRunId: "review-run-1",
        sessionId: "reviewer-agent-1",
      });

      const payload = JSON.parse(await readFile(reviewVerdictContextFilePath(ctx), "utf8"));
      expect(payload).toMatchObject({
        activeRunId: "review-run-1",
        role: "reviewer",
        phase: "review",
        reviewer: "reviewer-agent-1",
        projectContext: docsProjectContext,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const docsProjectContext = {
  projectContextId: "docs-site",
  projectContextLabel: "Documentation Site",
  linearProjectSlug: "DOCS",
  routingSource: "candidate_poll",
} as const;

function handoffContext(
  config: ReturnType<typeof testConfig>,
  input: {
    role: "worker" | "reviewer";
    issueState: string;
    runPhase?: AgentRunContext["runPhase"];
    projectContext?: typeof docsProjectContext;
  },
): AgentRunContext {
  return {
    issue: issue({ state: input.issueState, branchName: "symphony/TEST-1" }),
    role: input.role,
    attempt: null,
    workspace: {
      path: "/tmp/workspace",
      workspaceKey: "TEST-1",
      createdNow: false,
      gitBranchName: "symphony/TEST-1",
      repoPath: "/repo",
      baseRef: "main",
    },
    config,
    turnNumber: 1,
    abortSignal: new AbortController().signal,
    logger: new StructuredLogger(() => undefined),
    ...(input.projectContext === undefined ? {} : { projectContext: input.projectContext }),
    ...(input.runPhase === undefined ? {} : { runPhase: input.runPhase }),
  };
}

import { describe, expect, it } from "vitest";
import {
  renderCompletionMcpHandoffPrompt,
  renderIssueBreakdownMcpHandoffPrompt,
  renderReviewMcpHandoffPrompt,
} from "../src/core/harness/HandoffMcp.js";
import { issue } from "./helpers.js";

describe("MCP handoff prompt rendering", () => {
  it("requires issue-breakdown proposals to include the agent-eligible issue contract", () => {
    const prompt = renderIssueBreakdownMcpHandoffPrompt({ issue: issue({ identifier: "ENG-1" }) });

    expect(prompt).toContain("Symphony MCP issue-breakdown handoff:");
    expect(prompt).toContain("Problem / Goal");
    expect(prompt).toContain("Contract Checklist");
    expect(prompt).toContain("Validation Requirements");
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

import { describe, expect, it } from "vitest";
import {
  renderCompletionMcpHandoffPrompt,
  renderIssueBreakdownMcpHandoffPrompt,
  renderIssuePostMortemMcpHandoffPrompt,
  renderIssueTriageMcpHandoffPrompt,
  renderMergeConflictResolutionMcpHandoffPrompt,
  renderReviewMcpHandoffPrompt,
} from "../src/core/harness/HandoffMcp.js";
import { issue } from "./helpers.js";

describe("MCP handoff prompt rendering", () => {
  it("requires every agent role to submit and echo a complete unexcerpted finalDisposition", () => {
    const input = { issue: issue({ identifier: "ENG-1" }) };
    const terminalHandoffs = [
      renderCompletionMcpHandoffPrompt(input),
      renderReviewMcpHandoffPrompt(input),
      renderIssueBreakdownMcpHandoffPrompt(input),
      renderIssueTriageMcpHandoffPrompt(input),
      renderIssuePostMortemMcpHandoffPrompt(input),
    ];
    const conflictHandoff = renderMergeConflictResolutionMcpHandoffPrompt(input);

    for (const prompt of terminalHandoffs) {
      expect(prompt).toContain("finalDisposition");
      expect(prompt).toContain("complete standalone final response");
      expect(prompt).toContain("no excerpting");
      expect(prompt).toContain("exact text as your terminal assistant response");
    }
    expect(conflictHandoff).toContain("finalDisposition");
    expect(conflictHandoff).toContain("complete standalone disposition");
    expect(conflictHandoff).toContain("no excerpting");
    expect(conflictHandoff).toContain("exact text as your terminal assistant response");
  });

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
    expect(prompt).toContain("delivery.mode=accepted_artifact");
    expect(prompt).toContain("structured artifactEvidence");
    expect(prompt).toContain("stable exact observedFailure excerpt copied");
    expect(prompt).toContain("positive nonzero exitCode");
    expect(prompt).toContain("Dependency Artifact Checkpoint");
    expect(prompt).toContain("dependencyArtifactResult");
    expect(prompt).toContain("exitCode=0");
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
    expect(prompt).toContain("Never call submit_pull_request_review_feedback with {}");
    expect(prompt).toContain('{"kind":"review","event":"APPROVE","body":"...","idempotencyKey":"..."}');
    expect(prompt).toContain("accepted expected-red artifact use event=COMMENT");
    expect(prompt).toContain("Do not use blocked merely because an accepted expected-red artifact awaits");
  });

  it("requires planners to declare accepted-artifact delivery and dependency ownership explicitly", () => {
    const prompt = renderIssueBreakdownMcpHandoffPrompt({ issue: issue({ identifier: "ENG-1" }) });

    expect(prompt).toContain('delivery: {"mode":"accepted_artifact","artifact":"expected_red_tests"}');
    expect(prompt).toContain("implementation sibling successors (children of the same decomposition parent)");
    expect(prompt).toContain("never children of the artifact issue");
    expect(prompt).toContain("make each directly depend on the test-artifact issue");
  });

  it("routes an accepted artifact stuck after pass to lifecycle reconciliation", () => {
    const prompt = renderIssueTriageMcpHandoffPrompt({ issue: issue({ identifier: "ENG-1" }) });

    expect(prompt).toContain("not blocked by its missing implementation");
    expect(prompt).toContain("failed artifact-completion transition");
    expect(prompt).toContain("recommend reconciliation");
  });

  it("treats completed unmerged artifacts as valid post-mortem completion", () => {
    const prompt = renderIssuePostMortemMcpHandoffPrompt({ issue: issue({ identifier: "ENG-1" }) });

    expect(prompt).toContain("completed_unmerged expected-red artifact");
    expect(prompt).toContain("intentional valid completion");
    expect(prompt).toContain("do not treat the missing merge or closed draft PR as a defect");
  });

  it("requires merge-conflict workers to continue when the MCP result prepares a follow-up conflict", () => {
    const prompt = renderMergeConflictResolutionMcpHandoffPrompt({
      issue: issue({ id: "issue-1", identifier: "ENG-1", branchName: "symphony/ENG-1" }),
      role: "worker",
      workspacePath: "/workspace/ENG-1",
      repoPath: "/repo/symphony",
      baseRef: "origin/main",
    });

    expect(prompt).toContain("submit_merge_conflict_resolution");
    expect(prompt).toContain("Inspect the MCP tool result before ending the run");
    expect(prompt).toContain("continuation.required=true");
    expect(prompt).toContain("continue repairing the newly prepared conflict");
  });
});

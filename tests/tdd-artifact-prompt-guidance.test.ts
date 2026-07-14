import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function prompt(relativePath: string): string {
  return readFileSync(new URL(`../prompts/${relativePath}`, import.meta.url), "utf8");
}

describe("TDD artifact prompt guidance", () => {
  it("keeps expected-red artifact workers inside the test deliverable", () => {
    const initial = prompt("worker/implementation/initial.md.liquid");
    const repair = prompt("worker/implementation/review_repair.md.liquid");

    expect(initial).toContain("delivery.mode");
    expect(initial).toContain("structured `artifactEvidence`");
    expect(initial).toContain("Dependency Artifact Checkpoint");
    expect(initial).toContain("`dependencyArtifactResult`");
    expect(repair).toContain("do not absorb its implementation successor");
  });

  it("passes correct expected-red artifacts without merge approval or sequencing block", () => {
    const reviewer = prompt("reviewer/review/exhaustive.md.liquid");

    expect(reviewer).toContain("Pass a correct accepted artifact");
    expect(reviewer).toContain("`COMMENT` review feedback, not `APPROVE`");
    expect(reviewer).toContain("Do not use blocked");
    expect(reviewer).not.toContain("use a `blocked` verdict for sequencing");
  });

  it("keeps planners and triage aligned with checkpoint completion", () => {
    const planner = prompt("planner/issue_breakdown/speckit_to_linear.md.liquid");
    const triage = prompt("triage/issue_blocked/classify.md.liquid");

    expect(planner).toContain('`delivery: {"mode":"accepted_artifact","artifact":"expected_red_tests"}`');
    expect(planner).toContain("implementation sibling successors (children of the same decomposition parent)");
    expect(planner).toContain("never children of the artifact issue");
    expect(planner).toContain("directly depend on the test issue");
    expect(triage).toContain("should be checkpointed");
    expect(triage).toContain("Recommend service reconciliation");
    expect(triage).not.toContain("Recommend waiting for or dispatching");
  });

  it("treats completed unmerged artifacts as valid post-mortem outcomes", () => {
    const postMortem = prompt("post_mortem/issue_done/analyze.md.liquid");

    expect(postMortem).toContain("`completed_unmerged`");
    expect(postMortem).toContain("Done without a merge is the intended valid completion");
    expect(postMortem).toContain("do not report the intentionally closed draft PR or missing merge as a completion defect");
  });
});

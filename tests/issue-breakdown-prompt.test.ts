import { describe, expect, it } from "vitest";
import { testConfig } from "./helpers.js";

describe("issue-breakdown planner prompt", () => {
  it("requires drafted child issues to use the agent-eligible contract without auto-promoting labels", () => {
    const config = testConfig("/tmp/symphony-issue-breakdown-prompt");

    expect(config.issueBreakdown.promptTemplate).toContain("Problem / Goal");
    expect(config.issueBreakdown.promptTemplate).toContain("Touched Surfaces");
    expect(config.issueBreakdown.promptTemplate).toContain("Contract Checklist");
    expect(config.issueBreakdown.promptTemplate).toContain("Validation Requirements");
    expect(config.issueBreakdown.promptTemplate).toContain("Do not include secrets, tokens, private keys, or credential values");
    expect(config.issueBreakdown.promptTemplate).toContain("Do not add `dogfood-ready` automatically");
  });
});

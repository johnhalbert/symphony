import { describe, expect, it } from "vitest";
import { renderIssueBreakdownMcpHandoffPrompt } from "../src/core/harness/HandoffMcp.js";
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
});

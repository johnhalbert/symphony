import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CONTINUATION_CONTEXT_ROADMAP } from "../src/core/summarization/ContinuationContextRoadmap.js";

describe("continuation context roadmap placeholders", () => {
  it("tracks implemented search separately from blocked summarization roadmap work", () => {
    expect(CONTINUATION_CONTEXT_ROADMAP.search.implementationStatus).toBe("implemented");
    expect(CONTINUATION_CONTEXT_ROADMAP.search.dispatchPolicy).toBe("no_orchestrator_dispatch");

    for (const entry of [CONTINUATION_CONTEXT_ROADMAP.summarization]) {
      expect(entry.implementationStatus).toBe("not_implemented");
      expect(entry.dispatchPolicy).toBe("no_orchestrator_dispatch");
      expect(entry.roadmapIssue.state).toBe("Backlog");
      expect(entry.roadmapIssue.labels).toContain("dogfood-blocked");
      expect(entry.roadmapIssue.labels).not.toContain("dogfood-ready");
      expect(entry.roadmapIssue.forbiddenLabels).toContain("dogfood-ready");
    }
  });

  it("does not import or schedule the roadmap placeholders from the orchestrator", async () => {
    const source = await readFile(new URL("../src/core/orchestrator/Orchestrator.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1] ?? "");

    expect(imports).not.toContain("../summarization/ContinuationContextRoadmap.js");
    expect(source).not.toContain("CONTINUATION_CONTEXT_ROADMAP");
    expect(source).not.toContain("ContinuationSearchProvider");
    expect(source).not.toContain("RichContinuationSummarizer");
    expect(source).not.toContain("continuationContext");
    expect(source).not.toContain("Backlog");
    expect(source).not.toContain("dogfood-blocked");
    expect(source).not.toContain("dogfood-ready");
  });
});

import { describe, expect, it } from "vitest";
import {
  DEFAULT_REVIEWER_REVIEW_LOOP_GUIDANCE,
  DEFAULT_WORKER_INVARIANT_REPAIR_GUIDANCE,
} from "../src/core/workflow/ReviewLoopPromptGuidance.js";

describe("review loop prompt guidance", () => {
  it("tells workers and reviewers how to handle missing issue contracts conservatively", () => {
    expect(DEFAULT_WORKER_INVARIANT_REPAIR_GUIDANCE).toContain("derive a conservative checklist");
    expect(DEFAULT_WORKER_INVARIANT_REPAIR_GUIDANCE).toContain("issue-authoring gap");
    expect(DEFAULT_REVIEWER_REVIEW_LOOP_GUIDANCE).toContain("keep gate authority narrow");
    expect(DEFAULT_REVIEWER_REVIEW_LOOP_GUIDANCE).toContain("authoring/decomposition signal");
  });
});

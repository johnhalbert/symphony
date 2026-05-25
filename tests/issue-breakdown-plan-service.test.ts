import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IssueBreakdownPlanService } from "../src/core/IssueBreakdownPlanService.js";
import { SymphonyError } from "../src/core/errors.js";
import { FileIssueLifecycleStore } from "../src/core/persistence/IssueLifecycleStore.js";
import { issue, testConfig } from "./helpers.js";

describe("IssueBreakdownPlanService", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-breakdown-plan-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("validates, persists, and replays structured issue breakdown plans", async () => {
    const config = testConfig(root);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const candidate = issue({ updatedAt: "2026-01-02T00:00:00Z" });
    const service = new IssueBreakdownPlanService({ config, lifecycleStore });
    const input = {
      runId: "run-plan-1",
      issueId: candidate.id,
      summary: "Split the work into child issues.",
      proposedIssues: [
        {
          title: "Build planning schema",
          description: "Add validated structured issue breakdown output.",
          acceptanceCriteria: ["Plans persist proposed issues."],
          dependencies: [],
          labels: ["planning"],
        },
      ],
      idempotencyKey: "plan-1",
    };

    const first = await service.submit_issue_breakdown_plan(input, {
      issue: candidate,
      activeRunId: "run-plan-1",
      role: "worker",
      phase: "issue_breakdown",
    });
    const second = await service.submit_issue_breakdown_plan(input, {
      issue: candidate,
      activeRunId: "run-plan-1",
      role: "worker",
      phase: "issue_breakdown",
    });
    const lifecycle = await lifecycleStore.get(candidate.id);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(lifecycle?.lastIssueBreakdownPlanId).toBe(first.plan.id);
    expect(lifecycle?.issueBreakdownPlans).toHaveLength(1);
    expect(lifecycle?.issueBreakdownPlans[0]?.proposedIssues[0]?.title).toBe("Build planning schema");
    expect(lifecycle?.summaryReferences[0]).toMatchObject({
      kind: "issue_breakdown_plan",
      planId: first.plan.id,
      summary: expect.stringContaining("Build planning schema"),
    });
  });

  it("rejects invalid schema and mismatched active run context", async () => {
    const config = testConfig(root);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const candidate = issue();
    const service = new IssueBreakdownPlanService({ config, lifecycleStore });

    await expect(
      service.submit_issue_breakdown_plan(
        {
          runId: "run-plan-1",
          issueId: candidate.id,
          summary: "Missing proposed issues.",
          proposedIssues: [],
          idempotencyKey: "plan-1",
        },
        { issue: candidate, activeRunId: "run-plan-1", role: "worker", phase: "issue_breakdown" },
      ),
    ).rejects.toBeInstanceOf(SymphonyError);

    await expect(
      service.submit_issue_breakdown_plan(
        {
          runId: "run-plan-1",
          issueId: candidate.id,
          summary: "Valid shape but wrong run.",
          proposedIssues: [
            {
              title: "Task",
              description: "Description",
              acceptanceCriteria: ["Done"],
              dependencies: [],
              labels: [],
            },
          ],
          idempotencyKey: "plan-2",
        },
        { issue: candidate, activeRunId: "different-run", role: "worker", phase: "issue_breakdown" },
      ),
    ).rejects.toBeInstanceOf(SymphonyError);
  });
});

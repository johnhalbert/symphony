import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IssueBreakdownPlanApplyService } from "../src/core/IssueBreakdownPlanApplyService.js";
import { IssueBreakdownPlanService } from "../src/core/IssueBreakdownPlanService.js";
import { FileIssueLifecycleStore } from "../src/core/persistence/IssueLifecycleStore.js";
import type { WritebackOperation, WritebackProcessor } from "../src/core/writeback/WritebackOutbox.js";
import type { NewWritebackOperation } from "../src/core/writeback/WritebackOutbox.js";
import { issue, testConfig } from "./helpers.js";

describe("IssueBreakdownPlanApplyService", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-breakdown-apply-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("applies fresh accepted plans through idempotent issue create writebacks", async () => {
    const config = testConfig(root);
    config.issueBreakdown.applyToLinear.enabled = true;
    config.writeback.enabled = true;
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const candidate = issue({ labels: ["planning"], updatedAt: "2026-01-02T00:00:00Z" });
    await new IssueBreakdownPlanService({ config, lifecycleStore }).submit_issue_breakdown_plan(
      {
        runId: "run-plan-1",
        issueId: candidate.id,
        summary: "Split into child issues.",
        proposedIssues: [
          {
            title: "Build child",
            description: "Implement the child issue.",
            acceptanceCriteria: ["Done"],
            dependencies: [],
            labels: ["planning"],
          },
        ],
        idempotencyKey: "plan-1",
      },
      { issue: candidate, activeRunId: "run-plan-1", role: "worker", phase: "issue_breakdown" },
    );
    const writeback = new CapturingWriteback();

    const result = await new IssueBreakdownPlanApplyService({ config, lifecycleStore, writeback }).applyLatestFreshPlan(candidate);
    const lifecycle = await lifecycleStore.get(candidate.id);

    expect(result.status).toBe("applied");
    expect(writeback.operations[0]).toMatchObject({
      kind: "issue_create",
      issueId: candidate.id,
      payload: { title: "Build child", parentIssueId: candidate.id, planId: expect.any(String) },
    });
    expect(writeback.operations[1]).toMatchObject({
      kind: "comment",
      issueId: candidate.id,
      payload: { body: expect.stringContaining("TEST-2"), issueBreakdownPlanId: expect.any(String) },
    });
    expect(lifecycle?.issueBreakdownPlans[0]?.applicationStatus).toBe("applied");
    expect(lifecycle?.issueBreakdownPlans[0]?.createdIssueRefs[0]).toMatchObject({
      id: "child-1",
      identifier: "TEST-2",
      status: "created",
    });
  });

  it("leaves local planning behavior unchanged when apply is disabled", async () => {
    const config = testConfig(root);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const candidate = issue({ updatedAt: "2026-01-02T00:00:00Z" });
    const result = await new IssueBreakdownPlanApplyService({ config, lifecycleStore }).applyLatestFreshPlan(candidate);

    expect(result.status).toBe("not_required");
  });

  it("previews fresh plans without enqueueing writebacks", async () => {
    const config = testConfig(root);
    config.issueBreakdown.applyToLinear.enabled = true;
    config.writeback.enabled = true;
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const candidate = issue({ labels: ["planning"], updatedAt: "2026-01-02T00:00:00Z" });
    await new IssueBreakdownPlanService({ config, lifecycleStore }).submit_issue_breakdown_plan(
      {
        runId: "run-plan-1",
        issueId: candidate.id,
        summary: "Split into child issues.",
        proposedIssues: [
          { title: "Build child", description: "Implement.", acceptanceCriteria: ["Done"], dependencies: [], labels: [] },
        ],
        idempotencyKey: "plan-1",
      },
      { issue: candidate, activeRunId: "run-plan-1", role: "worker", phase: "issue_breakdown" },
    );
    const writeback = new CapturingWriteback();

    const result = await new IssueBreakdownPlanApplyService({ config, lifecycleStore, writeback }).previewLatestFreshPlan(candidate);
    const lifecycle = await lifecycleStore.get(candidate.id);

    expect(result.status).toBe("preview");
    expect(writeback.operations).toEqual([]);
    expect(lifecycle?.issueBreakdownPlans[0]?.applicationStatus).toBe("not_requested");
  });

  it("durably blocks unresolved dependency references before enqueueing writebacks", async () => {
    const config = testConfig(root);
    config.issueBreakdown.applyToLinear.enabled = true;
    config.writeback.enabled = true;
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const candidate = issue({ labels: ["planning"], updatedAt: "2026-01-02T00:00:00Z" });
    await new IssueBreakdownPlanService({ config, lifecycleStore }).submit_issue_breakdown_plan(
      {
        runId: "run-plan-1",
        issueId: candidate.id,
        summary: "Split into child issues.",
        proposedIssues: [
          { title: "Build child", description: "Implement.", acceptanceCriteria: ["Done"], dependencies: ["Missing"], labels: [] },
        ],
        idempotencyKey: "plan-1",
      },
      { issue: candidate, activeRunId: "run-plan-1", role: "worker", phase: "issue_breakdown" },
    );
    const writeback = new CapturingWriteback();

    const result = await new IssueBreakdownPlanApplyService({ config, lifecycleStore, writeback }).applyLatestFreshPlan(candidate);
    const lifecycle = await lifecycleStore.get(candidate.id);

    expect(result.status).toBe("blocked");
    expect(writeback.operations).toEqual([]);
    expect(lifecycle?.issueBreakdownPlans[0]?.applicationStatus).toBe("blocked");
    expect(lifecycle?.issueBreakdownPlans[0]?.applicationBlockedReason).toContain("Missing");
  });
});

class CapturingWriteback implements Pick<WritebackProcessor, "enqueueAndProcess"> {
  readonly operations: NewWritebackOperation[] = [];

  async enqueueAndProcess(operation: NewWritebackOperation): Promise<WritebackOperation> {
    this.operations.push(operation);
    if (operation.kind !== "issue_create") {
      return {
        ...operation,
        status: "succeeded",
        attempt: 0,
        createdAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        nextAttemptAt: "2026-01-02T00:00:00.000Z",
        lastError: null,
        resultStatus: "applied",
        resultMessage: null,
        resultEvidence: null,
      };
    }
    return {
      ...operation,
      status: "succeeded",
      attempt: 0,
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      nextAttemptAt: "2026-01-02T00:00:00.000Z",
      lastError: null,
      resultStatus: "applied",
      resultMessage: null,
      resultEvidence: {
        kind: "issue_create",
        issue: { id: "child-1", identifier: "TEST-2", url: "https://linear.test/TEST-2" },
        issueCreateStatus: "created",
        parentIssueId: operation.payload.parentIssueId,
        dedupeKey: operation.payload.dedupeKey,
        payloadHash: operation.payload.payloadHash,
        unresolvedLabelNames: [],
      },
    };
  }
}

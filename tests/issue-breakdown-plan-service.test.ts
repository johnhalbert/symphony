import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  IssueBreakdownPlanService,
  issueBreakdownPlanFingerprintsMatch,
  latestFreshIssueBreakdownPlan,
} from "../src/core/IssueBreakdownPlanService.js";
import { SymphonyError } from "../src/core/errors.js";
import { FileIssueLifecycleStore } from "../src/core/persistence/IssueLifecycleStore.js";
import { agentEligibleIssueContract, issue, testConfig } from "./helpers.js";

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
          description: agentEligibleIssueContract(),
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
    const reloadedStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const reloadedService = new IssueBreakdownPlanService({ config, lifecycleStore: reloadedStore });
    const second = await reloadedService.submit_issue_breakdown_plan(input, {
      issue: candidate,
      activeRunId: "run-plan-1",
      role: "worker",
      phase: "issue_breakdown",
    });
    const lifecycle = await reloadedStore.get(candidate.id);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(lifecycle?.lastIssueBreakdownPlanId).toBe(first.plan.id);
    expect(lifecycle?.planningFailureCount).toBe(0);
    expect(lifecycle?.lastPlanningFailureRunId).toBeNull();
    expect(lifecycle?.issueBreakdownPlans).toHaveLength(1);
    expect(lifecycle?.issueBreakdownPlans[0]?.requestHash).not.toBe("");
    expect(lifecycle?.issueBreakdownPlans[0]?.issueContentFingerprint).not.toBe("");
    expect(lifecycle?.issueBreakdownPlans[0]?.proposedIssues[0]?.title).toBe("Build planning schema");
    expect(lifecycle?.summaryReferences[0]).toMatchObject({
      kind: "issue_breakdown_plan",
      planId: first.plan.id,
      summary: expect.stringContaining("Build planning schema"),
      issueContentFingerprint: first.plan.issueContentFingerprint,
    });
  });

  it("rejects idempotency key reuse across runs or changed payloads", async () => {
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
          description: agentEligibleIssueContract(),
          acceptanceCriteria: ["Plans persist proposed issues."],
          dependencies: [],
          labels: ["planning"],
        },
      ],
      idempotencyKey: "plan-1",
    };
    await service.submit_issue_breakdown_plan(input, {
      issue: candidate,
      activeRunId: "run-plan-1",
      role: "worker",
      phase: "issue_breakdown",
    });

    await expect(
      service.submit_issue_breakdown_plan(
        { ...input, runId: "run-plan-2" },
        { issue: candidate, activeRunId: "run-plan-2", role: "worker", phase: "issue_breakdown" },
      ),
    ).rejects.toMatchObject({ code: "conflict" });

    await expect(
      service.submit_issue_breakdown_plan(
        { ...input, summary: "Changed summary." },
        { issue: candidate, activeRunId: "run-plan-1", role: "worker", phase: "issue_breakdown" },
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("replays same-run submissions after issue drift but leaves freshness to dispatch", async () => {
    const config = testConfig(root);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const candidate = issue({ updatedAt: "2026-01-02T00:00:00Z", title: "Original title" });
    const service = new IssueBreakdownPlanService({ config, lifecycleStore });
    const input = {
      runId: "run-plan-1",
      issueId: candidate.id,
      summary: "Split the work into child issues.",
      proposedIssues: [
        {
          title: "Build planning schema",
          description: agentEligibleIssueContract(),
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
    const drifted = issue({
      ...candidate,
      title: "Edited after submit",
      updatedAt: "2026-01-02T00:05:00Z",
    });
    const replay = await service.submit_issue_breakdown_plan(input, {
      issue: drifted,
      activeRunId: "run-plan-1",
      role: "worker",
      phase: "issue_breakdown",
    });

    expect(replay.replayed).toBe(true);
    expect(replay.plan.runId).toBe("run-plan-1");
    expect(issueBreakdownPlanFingerprintsMatch(first.plan, { ...candidate, updatedAt: "2026-01-02T00:05:00Z" }, config)).toBe(
      true,
    );
    expect(issueBreakdownPlanFingerprintsMatch(first.plan, drifted, config)).toBe(false);
  });

  it("only treats the current non-stale plan as fresh", async () => {
    const config = testConfig(root);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const original = issue({ updatedAt: "2026-01-02T00:00:00Z", title: "Original title" });
    const changed = issue({
      ...original,
      title: "Changed title",
      updatedAt: "2026-01-02T00:05:00Z",
    });
    const service = new IssueBreakdownPlanService({ config, lifecycleStore });
    const planA = await service.submit_issue_breakdown_plan(
      {
        runId: "run-plan-a",
        issueId: original.id,
        summary: "Split original work.",
        proposedIssues: [
          { title: "Build original child", description: agentEligibleIssueContract(), acceptanceCriteria: ["Done"], dependencies: [], labels: [] },
        ],
        idempotencyKey: "plan-a",
      },
      { issue: original, activeRunId: "run-plan-a", role: "worker", phase: "issue_breakdown" },
    );
    const planB = await service.submit_issue_breakdown_plan(
      {
        runId: "run-plan-b",
        issueId: changed.id,
        summary: "Split changed work.",
        proposedIssues: [
          { title: "Build changed child", description: agentEligibleIssueContract(), acceptanceCriteria: ["Done"], dependencies: [], labels: [] },
        ],
        idempotencyKey: "plan-b",
      },
      { issue: changed, activeRunId: "run-plan-b", role: "worker", phase: "issue_breakdown" },
    );
    const lifecycle = await lifecycleStore.get(original.id);

    expect(lifecycle?.lastIssueBreakdownPlanId).toBe(planB.plan.id);
    expect(issueBreakdownPlanFingerprintsMatch(planA.plan, original, config)).toBe(true);
    expect(latestFreshIssueBreakdownPlan(lifecycle, original, config)).toBeNull();
    expect(latestFreshIssueBreakdownPlan(lifecycle, changed, config)?.id).toBe(planB.plan.id);

    await lifecycleStore.updateIssue(changed, {
      issueBreakdownPlans:
        lifecycle?.issueBreakdownPlans.map((plan) =>
          plan.id === planB.plan.id ? { ...plan, applicationStatus: "stale", applicationBlockedReason: "stale" } : plan,
        ) ?? [],
      lastIssueBreakdownPlanId: planB.plan.id,
    });
    const staleLifecycle = await lifecycleStore.get(original.id);
    expect(latestFreshIssueBreakdownPlan(staleLifecycle, changed, config)).toBeNull();

    await lifecycleStore.updateIssue(changed, {
      issueBreakdownPlans: staleLifecycle?.issueBreakdownPlans ?? [],
      lastIssueBreakdownPlanId: null,
    });
    const nullPointerLifecycle = await lifecycleStore.get(original.id);
    expect(latestFreshIssueBreakdownPlan(nullPointerLifecycle, original, config)).toBeNull();
  });

  it("rejects proposed issues that add dogfood-ready labels before persistence", async () => {
    const config = testConfig(root);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const candidate = issue();
    const service = new IssueBreakdownPlanService({ config, lifecycleStore });

    await expect(
      service.submit_issue_breakdown_plan(
        {
          runId: "run-plan-ready-label",
          issueId: candidate.id,
          summary: "Readiness labels are operator-owned.",
          proposedIssues: [
            {
              title: "Task",
              description: agentEligibleIssueContract(),
              acceptanceCriteria: ["Done"],
              dependencies: [],
              labels: ["dogfood-ready"],
            },
          ],
          idempotencyKey: "plan-ready-label",
        },
        { issue: candidate, activeRunId: "run-plan-ready-label", role: "worker", phase: "issue_breakdown" },
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(lifecycleStore.get(candidate.id)).resolves.toBeNull();
  });

  it("requires protected-surface proposed issues to stay manual-only with a blocker", async () => {
    const config = testConfig(root);
    config.agent.protectedPaths = ["docs/dogfood-runbook.md"];
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const candidate = issue();
    const service = new IssueBreakdownPlanService({ config, lifecycleStore });

    await expect(
      service.submit_issue_breakdown_plan(
        {
          runId: "run-plan-protected-ready",
          issueId: candidate.id,
          summary: "Protected path must not be agent-ready.",
          proposedIssues: [
            {
              title: "Task",
              description: agentEligibleIssueContract({
                touchedSurfaces: ["- [X] Docs only", "- docs/dogfood-runbook.md"],
                readyForDogfoodReady: "yes",
              }),
              acceptanceCriteria: ["Done"],
              dependencies: [],
              labels: [],
            },
          ],
          idempotencyKey: "plan-protected-ready",
        },
        { issue: candidate, activeRunId: "run-plan-protected-ready", role: "worker", phase: "issue_breakdown" },
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(lifecycleStore.get(candidate.id)).resolves.toBeNull();

    const accepted = await service.submit_issue_breakdown_plan(
      {
        runId: "run-plan-protected-manual",
        issueId: candidate.id,
        summary: "Protected path stays manual-only.",
        proposedIssues: [
          {
            title: "Task",
            description: agentEligibleIssueContract({
              touchedSurfaces: ["- [X] Docs only", "- docs/dogfood-runbook.md"],
              readyForDogfoodReady: "no",
              remainingBlocker: "Manual operator implementation required for protected surface.",
            }),
            acceptanceCriteria: ["Done"],
            dependencies: [],
            labels: [],
          },
        ],
        idempotencyKey: "plan-protected-manual",
      },
      { issue: candidate, activeRunId: "run-plan-protected-manual", role: "worker", phase: "issue_breakdown" },
    );

    expect(accepted.accepted).toBe(true);
    expect(accepted.replayed).toBe(false);
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

  it("rejects proposed issues with omitted dependencies before persistence", async () => {
    const config = testConfig(root);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const candidate = issue();
    const service = new IssueBreakdownPlanService({ config, lifecycleStore });

    await expect(
      service.submit_issue_breakdown_plan(
        {
          runId: "run-plan-1",
          issueId: candidate.id,
          summary: "Dependencies must be explicit.",
          proposedIssues: [
            {
              title: "Task",
              description: "Description",
              acceptanceCriteria: ["Done"],
              labels: [],
            },
          ],
          idempotencyKey: "plan-missing-dependencies",
        },
        { issue: candidate, activeRunId: "run-plan-1", role: "worker", phase: "issue_breakdown" },
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(lifecycleStore.get(candidate.id)).resolves.toBeNull();
  });

  it("rejects proposed issues with omitted labels before persistence", async () => {
    const config = testConfig(root);
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const candidate = issue();
    const service = new IssueBreakdownPlanService({ config, lifecycleStore });

    await expect(
      service.submit_issue_breakdown_plan(
        {
          runId: "run-plan-1",
          issueId: candidate.id,
          summary: "Labels must be explicit.",
          proposedIssues: [
            {
              title: "Task",
              description: "Description",
              acceptanceCriteria: ["Done"],
              dependencies: [],
            },
          ],
          idempotencyKey: "plan-missing-labels",
        },
        { issue: candidate, activeRunId: "run-plan-1", role: "worker", phase: "issue_breakdown" },
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(lifecycleStore.get(candidate.id)).resolves.toBeNull();
  });
});

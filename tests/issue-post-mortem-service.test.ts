import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  IssuePostMortemService,
  issuePostMortemTriggerFingerprint,
  shouldIssuePostMortemRun,
} from "../src/core/IssuePostMortemService.js";
import type {
  IssueCompletionReportRecord,
  IssueReviewVerdictRecord,
} from "../src/core/persistence/IssueLifecycleStore.js";
import { FileIssueLifecycleStore } from "../src/core/persistence/IssueLifecycleStore.js";
import { FileRunTranscriptStore } from "../src/core/persistence/RunTranscriptStore.js";
import { FileWritebackOutboxStore } from "../src/core/writeback/WritebackOutbox.js";
import type { Issue } from "../src/core/types.js";
import { issue, testConfig } from "./helpers.js";

describe("IssuePostMortemService", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-issue-post-mortem-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("accepts and replays a post-mortem report for a completed issue trigger", async () => {
    const config = testConfig(root);
    config.postMortem.enabled = true;
    config.postMortem.doneStates = ["Done"];
    config.writeback.enabled = true;
    const candidate = issue({ state: "Done" });
    const lifecycleStore = new FileIssueLifecycleStore(root);
    const writebackOutbox = new FileWritebackOutboxStore(root);
    const runStore = new FileRunTranscriptStore(root);
    const lifecycle = await seedCompletedLifecycle(lifecycleStore, candidate);
    const service = new IssuePostMortemService({ config, lifecycleStore, writebackOutbox, runStore });
    const input = reportInput("post-mortem-run-1", "postmortem-1", issuePostMortemTriggerFingerprint(lifecycle, candidate));

    const accepted = await service.submitIssuePostMortemReport(input, {
      issue: candidate,
      activeRunId: "post-mortem-run-1",
      role: "post_mortem",
      phase: "post_mortem",
    });
    const replayed = await service.submitIssuePostMortemReport(input, {
      issue: candidate,
      activeRunId: "post-mortem-run-1",
      role: "post_mortem",
      phase: "post_mortem",
    });

    expect(accepted.replayed).toBe(false);
    expect(replayed.replayed).toBe(true);
    expect(accepted.report.writebackOperationKeys).toEqual(["comment:issue-1:issue-post-mortem:postmortem-1"]);
    const writebacks = await writebackOutbox.list();
    expect(writebacks).toHaveLength(1);
    expect(writebacks[0]).toMatchObject({
      idempotencyKey: "comment:issue-1:issue-post-mortem:postmortem-1",
      kind: "comment",
      issueId: "issue-1",
      runId: "post-mortem-run-1",
    });
    const body = writebacks[0]?.kind === "comment" ? writebacks[0].payload.body : "";
    expect(body).toContain("## Symphony Post-Mortem");
    expect(body).toContain("Completion judgment:");
    expect(body).toContain("Specification assessment:");
    expect(body).toContain("Follow-up candidates:");
    await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
      lastPostMortemReportId: "issue-post-mortem-report:issue-1:postmortem-1",
      postMortemReports: [
        {
          runId: "post-mortem-run-1",
          completionJudgment: { status: "valid_with_followups" },
          specificationAssessment: {
            quality: "adequate",
            classifications: ["well_scoped"],
          },
          reviewAssessment: { gateDecisionLooksValid: true },
          writebackOperationKeys: ["comment:issue-1:issue-post-mortem:postmortem-1"],
        },
      ],
    });
  });

  it("does not allow another automatic report after the configured trigger attempt limit", async () => {
    const config = testConfig(root);
    config.postMortem.enabled = true;
    config.postMortem.doneStates = ["Done"];
    config.postMortem.maxAttemptsPerTrigger = 1;
    config.writeback.enabled = true;
    const candidate = issue({ state: "Done" });
    const lifecycleStore = new FileIssueLifecycleStore(root);
    const writebackOutbox = new FileWritebackOutboxStore(root);
    const lifecycle = await seedCompletedLifecycle(lifecycleStore, candidate);
    const service = new IssuePostMortemService({ config, lifecycleStore, writebackOutbox });
    const triggerFingerprint = issuePostMortemTriggerFingerprint(lifecycle, candidate);

    await service.submitIssuePostMortemReport(reportInput("post-mortem-run-1", "postmortem-1", triggerFingerprint), {
      issue: candidate,
      activeRunId: "post-mortem-run-1",
      role: "post_mortem",
      phase: "post_mortem",
    });
    const current = await lifecycleStore.get(candidate.id);

    expect(shouldIssuePostMortemRun(current, candidate, config)).toBe(false);
    await expect(
      service.submitIssuePostMortemReport(reportInput("post-mortem-run-2", "postmortem-2", triggerFingerprint), {
        issue: candidate,
        activeRunId: "post-mortem-run-2",
        role: "post_mortem",
        phase: "post_mortem",
      }),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: "Issue post-mortem is not currently eligible for this issue",
    });
  });

  it("allows manual post-mortem reports after the configured trigger attempt limit", async () => {
    const config = testConfig(root);
    config.postMortem.enabled = true;
    config.postMortem.doneStates = ["Done"];
    config.postMortem.maxAttemptsPerTrigger = 1;
    config.writeback.enabled = true;
    const candidate = issue({ state: "Done" });
    const lifecycleStore = new FileIssueLifecycleStore(root);
    const writebackOutbox = new FileWritebackOutboxStore(root);
    const lifecycle = await seedCompletedLifecycle(lifecycleStore, candidate);
    const service = new IssuePostMortemService({ config, lifecycleStore, writebackOutbox });
    const triggerFingerprint = issuePostMortemTriggerFingerprint(lifecycle, candidate);

    await service.submitIssuePostMortemReport(reportInput("post-mortem-run-1", "postmortem-1", triggerFingerprint), {
      issue: candidate,
      activeRunId: "post-mortem-run-1",
      role: "post_mortem",
      phase: "post_mortem",
    });
    const manual = await service.submitIssuePostMortemReport(reportInput("post-mortem-run-2", "postmortem-2", triggerFingerprint), {
      issue: candidate,
      activeRunId: "post-mortem-run-2",
      role: "post_mortem",
      phase: "post_mortem",
      manualDispatch: true,
    });

    expect(manual.replayed).toBe(false);
    await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
      postMortemReports: [{ runId: "post-mortem-run-1" }, { runId: "post-mortem-run-2" }],
    });
    await expect(writebackOutbox.list()).resolves.toHaveLength(2);
  });
});

async function seedCompletedLifecycle(lifecycleStore: FileIssueLifecycleStore, candidate: Issue) {
  const completion = completionReport(candidate);
  const verdict = passReviewVerdict(candidate);
  return lifecycleStore.ensureIssue(candidate, {
    phase: "terminal",
    lastCompletionReportId: completion.id,
    lastReviewVerdictId: verdict.id,
    completionReports: [completion],
    reviewVerdicts: [verdict],
  });
}

function completionReport(candidate: Issue): IssueCompletionReportRecord {
  return {
    id: "completion-report-1",
    idempotencyKey: "completion-1",
    runId: "worker-run-1",
    issueId: candidate.id,
    issueIdentifier: candidate.identifier,
    summary: "Implemented the requested behavior.",
    validationEvidence: ["npm test -- tests/status-api.test.ts"],
    acceptanceChecklist: [{ text: "Core behavior implemented", satisfied: true, evidence: "focused test passed" }],
    changedFiles: ["src/app/http.ts"],
    branchName: "symphony/TEST-1",
    pullRequest: null,
    risks: [],
    acceptedAt: "2026-01-01T00:00:00.000Z",
    writebackOperationKeys: [],
  };
}

function passReviewVerdict(candidate: Issue): IssueReviewVerdictRecord {
  return {
    id: "review-verdict-1",
    idempotencyKey: "review-1",
    runId: "reviewer-run-1",
    issueId: candidate.id,
    issueIdentifier: candidate.identifier,
    verdict: "pass",
    acceptanceResults: [{ text: "Core behavior implemented", satisfied: true, evidence: "reviewed diff and tests" }],
    findings: [],
    gateFindings: [],
    discoveryFindings: [],
    evidence: ["reviewed final worker output"],
    reviewer: "symphony-reviewer",
    submittedAt: "2026-01-01T00:10:00.000Z",
    writebackOperationKeys: [],
  };
}

function reportInput(runId: string, idempotencyKey: string, triggerFingerprint: string) {
  return {
    runId,
    issueId: "issue-1",
    triggerFingerprint,
    summary: "The issue reached Done with a valid implementation and one useful follow-up.",
    completionJudgment: {
      status: "valid_with_followups",
      rationale: "The final worker output and reviewer approval satisfy the written contract.",
    },
    specificationAssessment: {
      quality: "adequate",
      classifications: ["well_scoped"],
      missingContractAreas: [],
      speckitRecommended: false,
      speckitRationale: "No hidden matrix or decomposition need was found.",
    },
    reviewAssessment: {
      gateDecisionLooksValid: true,
      missedGateFindings: [],
      missedDiscoveryFindings: ["Add a broader regression around stale workspace lookup behavior."],
    },
    followUpCandidates: [
      {
        title: "Add stale workspace lookup regression",
        priority: "medium",
        kind: "test_gap",
        rationale: "The landed behavior is valid, but one adjacent stale-state scenario should be captured later.",
        readyForSpecKit: true,
        suggestedIssueContract: "Add a focused regression for stale workspace lookup without changing routing behavior.",
      },
    ],
    processLessons: ["The issue contract was good enough for implementation, but post-mortem found one follow-up test gap."],
    idempotencyKey,
  };
}

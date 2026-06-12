import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  IssueTriageService,
  issueTriageTriggerFingerprint,
  shouldIssueTriageRun,
} from "../src/core/IssueTriageService.js";
import { FileIssueLifecycleStore } from "../src/core/persistence/IssueLifecycleStore.js";
import { FileRunTranscriptStore } from "../src/core/persistence/RunTranscriptStore.js";
import { issue, testConfig } from "./helpers.js";

describe("IssueTriageService", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-issue-triage-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("accepts and replays a triage report for a max-failure blocked trigger", async () => {
    const config = testConfig(root);
    config.issueTriage.enabled = true;
    const candidate = issue({ state: "Blocked" });
    const lifecycleStore = new FileIssueLifecycleStore(root);
    const runStore = new FileRunTranscriptStore(root);
    const lifecycle = await lifecycleStore.ensureIssue(candidate, {
      phase: "blocked",
      reviewRound: 3,
      blockedReason: "max reviewer failures reached (3/3)",
    });
    const service = new IssueTriageService({ config, lifecycleStore, runStore });
    const input = {
      runId: "triage-run-1",
      issueId: candidate.id,
      triggerFingerprint: issueTriageTriggerFingerprint(lifecycle),
      disposition: "decompose_issue",
      confidence: "high",
      summary: "Review failures repeatedly exposed missing sibling API scope.",
      evidence: ["review-verdict:issue-1:verdict-3 finding names sibling API behavior"],
      recommendedAction: "Use SpecKit to decompose the hidden sibling API scope into blocking child issues.",
      idempotencyKey: "triage-1",
    };

    const accepted = await service.submitIssueTriageReport(input, {
      issue: candidate,
      activeRunId: "triage-run-1",
      role: "triage",
      phase: "issue_triage",
    });
    const replayed = await service.submitIssueTriageReport(input, {
      issue: candidate,
      activeRunId: "triage-run-1",
      role: "triage",
      phase: "issue_triage",
    });

    expect(accepted.replayed).toBe(false);
    expect(replayed.replayed).toBe(true);
    await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
      lastIssueTriageReportId: "issue-triage-report:issue-1:triage-1",
      issueTriageReports: [
        {
          disposition: "decompose_issue",
          confidence: "high",
          triggerFingerprint: input.triggerFingerprint,
        },
      ],
    });
  });

  it("does not allow another report after the configured trigger attempt limit", async () => {
    const config = testConfig(root);
    config.issueTriage.enabled = true;
    config.issueTriage.maxAttemptsPerTrigger = 1;
    const candidate = issue({ state: "Blocked" });
    const lifecycleStore = new FileIssueLifecycleStore(root);
    const lifecycle = await lifecycleStore.ensureIssue(candidate, {
      phase: "blocked",
      reviewRound: 3,
      blockedReason: "max reviewer failures reached (3/3)",
    });
    const service = new IssueTriageService({ config, lifecycleStore });
    const triggerFingerprint = issueTriageTriggerFingerprint(lifecycle);

    await service.submitIssueTriageReport(reportInput("triage-run-1", "triage-1", triggerFingerprint), {
      issue: candidate,
      activeRunId: "triage-run-1",
      role: "triage",
      phase: "issue_triage",
    });
    const current = await lifecycleStore.get(candidate.id);

    expect(shouldIssueTriageRun(current, config)).toBe(false);
    await expect(
      service.submitIssueTriageReport(reportInput("triage-run-2", "triage-2", triggerFingerprint), {
        issue: candidate,
        activeRunId: "triage-run-2",
        role: "triage",
        phase: "issue_triage",
      }),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: "Issue triage is not currently eligible for this issue",
    });
  });
});

function reportInput(runId: string, idempotencyKey: string, triggerFingerprint: string) {
  return {
    runId,
    issueId: "issue-1",
    triggerFingerprint,
    disposition: "implementation_repair",
    confidence: "medium",
    summary: "Worker missed a concrete reviewer finding.",
    evidence: ["review-verdict finding remained open"],
    recommendedAction: "Return to implementation with explicit reviewer finding context.",
    idempotencyKey,
  };
}

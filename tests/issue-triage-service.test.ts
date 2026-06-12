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
import { FileWritebackOutboxStore } from "../src/core/writeback/WritebackOutbox.js";
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
    config.writeback.enabled = true;
    const candidate = issue({ state: "Blocked" });
    const lifecycleStore = new FileIssueLifecycleStore(root);
    const runStore = new FileRunTranscriptStore(root);
    const writebackOutbox = new FileWritebackOutboxStore(root);
    const lifecycle = await lifecycleStore.ensureIssue(candidate, {
      phase: "blocked",
      reviewRound: 3,
      blockedReason: "max reviewer failures reached (3/3)",
    });
    const service = new IssueTriageService({ config, lifecycleStore, writebackOutbox, runStore });
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
    expect(accepted.report.writebackOperationKeys).toEqual(["comment:issue-1:issue-triage:triage-1"]);
    expect(replayed.report.writebackOperationKeys).toEqual(["comment:issue-1:issue-triage:triage-1"]);
    const writebacks = await writebackOutbox.list();
    expect(writebacks).toHaveLength(1);
    expect(writebacks[0]).toMatchObject({
      idempotencyKey: "comment:issue-1:issue-triage:triage-1",
      kind: "comment",
      issueId: "issue-1",
      runId: "triage-run-1",
    });
    expect(writebacks[0]?.kind === "comment" ? writebacks[0].payload.body : "").toContain("## Symphony Issue Triage");
    expect(writebacks[0]?.kind === "comment" ? writebacks[0].payload.body : "").toContain("Disposition: decompose_issue");
    expect(writebacks[0]?.kind === "comment" ? writebacks[0].payload.body : "").toContain("Confidence: high");
    expect(writebacks[0]?.kind === "comment" ? writebacks[0].payload.body : "").toContain("Recommended human action:");
    expect(writebacks[0]?.kind === "comment" ? writebacks[0].payload.body : "").toContain(input.recommendedAction);
    await expect(lifecycleStore.get(candidate.id)).resolves.toMatchObject({
      lastIssueTriageReportId: "issue-triage-report:issue-1:triage-1",
      issueTriageReports: [
        {
          disposition: "decompose_issue",
          confidence: "high",
          triggerFingerprint: input.triggerFingerprint,
          writebackOperationKeys: ["comment:issue-1:issue-triage:triage-1"],
        },
      ],
    });
  });

  it("does not allow another report after the configured trigger attempt limit", async () => {
    const config = testConfig(root);
    config.issueTriage.enabled = true;
    config.issueTriage.maxAttemptsPerTrigger = 1;
    config.writeback.enabled = true;
    const candidate = issue({ state: "Blocked" });
    const lifecycleStore = new FileIssueLifecycleStore(root);
    const writebackOutbox = new FileWritebackOutboxStore(root);
    const lifecycle = await lifecycleStore.ensureIssue(candidate, {
      phase: "blocked",
      reviewRound: 3,
      blockedReason: "max reviewer failures reached (3/3)",
    });
    const service = new IssueTriageService({ config, lifecycleStore, writebackOutbox });
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

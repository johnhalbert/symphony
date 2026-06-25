import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CompletionReportService, type CompletionReportActiveContext, type CompletionReportInput } from "../src/core/CompletionReportService.js";
import type {
  BaseRefVerificationInput,
  IssueBaseRefObservation,
} from "../src/core/BaseRefVerification.js";
import { SymphonyError } from "../src/core/errors.js";
import { FileIssueLifecycleStore, buildWorkerHandoffPacket, type IssueMergeGateState } from "../src/core/persistence/IssueLifecycleStore.js";
import { FileRunTranscriptStore } from "../src/core/persistence/RunTranscriptStore.js";
import { FileWritebackOutboxStore, type NewWritebackOperation, type WritebackOperation } from "../src/core/writeback/WritebackOutbox.js";
import { issue, testConfig } from "./helpers.js";
import type { OperatorApprovalRecord } from "../src/core/approval/OperatorApprovalService.js";
import type {
  CompletionReportPullRequestCheckResult,
  CompletionReportPullRequestPublication,
  CompletionReportPullRequestPublicationInput,
  CompletionReportPullRequestPublisher,
} from "../src/core/CompletionReportService.js";

describe("CompletionReportService", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-completion-report-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("accepts a worker completion report, records it, and enqueues review writebacks", async () => {
    const { service, lifecycleStore, outbox } = fixture();

    const result = await service.submit_completion_report(report(), context());

    expect(result.replayed).toBe(false);
    expect(result.writebackOperations).toHaveLength(2);
    const lifecycle = await lifecycleStore.get("issue-1");
    expect(lifecycle).toMatchObject({
      phase: "review",
      lastCompletionReportId: "completion-report:issue-1:idem-1",
      incompleteTurnCount: 0,
      completionReports: [
        {
          id: "completion-report:issue-1:idem-1",
          idempotencyKey: "idem-1",
          runId: "run-1",
          issueId: "issue-1",
          issueIdentifier: "TEST-1",
          summary: "Implemented the service contract.",
          changedFiles: ["src/core/CompletionReportService.ts"],
          branchName: "symphony/TEST-1",
          pullRequest: null,
          risks: ["Reviewer handler remains out of scope."],
        },
      ],
    });
    const operations = await outbox.list();
    const commentOperation = operations.find((operation) => operation.kind === "comment");
    const transitionOperation = operations.find((operation) => operation.kind === "transition");
    expect(operations).toHaveLength(2);
    expect(commentOperation).toMatchObject({
      kind: "comment",
      idempotencyKey: "comment:issue-1:run-1:completion-report:idem-1",
      payload: {
        dedupeKey: "run-1:completion-report:idem-1",
      },
    });
    expect(commentOperation?.kind === "comment" ? commentOperation.payload.body : "").toContain("Completion report:");
    expect(transitionOperation).toMatchObject({
      kind: "transition",
      idempotencyKey: "transition:issue-1:run-1:completion-report:idem-1:In Review",
      payload: {
        fromStates: ["In Progress"],
        toState: "In Review",
      },
    });
  });

  it("rejects completion reports with unsatisfied acceptance checklist items before review handoff", async () => {
    const { service, lifecycleStore, outbox } = fixture();

    await expect(
      service.submit_completion_report(
        report({
          acceptanceChecklist: [
            {
              text: "REQ-1 Required validation is complete.",
              satisfied: false,
              evidence: "Focused validation could not run in this worker environment.",
            },
          ],
        }),
        context(),
      ),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: "Completion report cannot be accepted with unsatisfied acceptance checklist items",
      details: {
        reasonCode: "unsatisfied_acceptance_checklist",
        rejectionId: "completion-report-rejection:issue-1:idem-1",
        reportId: "completion-report:issue-1:idem-1",
        unsatisfiedAcceptanceChecklist: [
          {
            text: "REQ-1 Required validation is complete.",
            evidence: "Focused validation could not run in this worker environment.",
          },
        ],
      },
    });

    const lifecycle = await lifecycleStore.get("issue-1");
    expect(lifecycle).toMatchObject({
      phase: "implementation",
      lastCompletionReportRejectionId: "completion-report-rejection:issue-1:idem-1",
      completionReportRejections: [
        {
          id: "completion-report-rejection:issue-1:idem-1",
          reportId: "completion-report:issue-1:idem-1",
          idempotencyKey: "idem-1",
          runId: "run-1",
          issueId: "issue-1",
          issueIdentifier: "TEST-1",
          reasonCode: "unsatisfied_acceptance_checklist",
          reason: "Completion report cannot be accepted with unsatisfied acceptance checklist items",
          summary: "Implemented the service contract.",
          acceptanceChecklist: [
            {
              text: "REQ-1 Required validation is complete.",
              satisfied: false,
              evidence: "Focused validation could not run in this worker environment.",
            },
          ],
          writebackOperationKeys: ["comment:issue-1:run-1:completion-report:idem-1:rejected"],
        },
      ],
    });
    const operations = await outbox.list();
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      kind: "comment",
      idempotencyKey: "comment:issue-1:run-1:completion-report:idem-1:rejected",
      payload: {
        dedupeKey: "run-1:completion-report:idem-1:rejected",
      },
    });
    const comment = operations[0]?.kind === "comment" ? operations[0].payload.body : "";
    expect(comment).toContain("## Symphony Completion Report");
    expect(comment).toContain("Status: rejected");
    expect(comment).toContain("Rejection reason:");
    expect(comment).toContain("Completion report cannot be accepted with unsatisfied acceptance checklist items");
    expect(comment).toContain("REQ-1 Required validation is complete.");
    expect(buildWorkerHandoffPacket(lifecycle!).lastCompletionReportRejection).toMatchObject({
      id: "completion-report-rejection:issue-1:idem-1",
      reasonCode: "unsatisfied_acceptance_checklist",
    });
    expect(buildWorkerHandoffPacket(lifecycle!).memo.entries.join("\n")).toContain("Latest completion report rejection");
  });

  it("supersedes an old-head merge gate on new-head completion and scrubs stale repair state", async () => {
    const { service, lifecycleStore, outbox } = fixture();
    await lifecycleStore.ensureIssue(context().issue, {
      phase: "implementation",
      reviewRound: 1,
      lastCompletionReportId: "completion-report:issue-1:head-a",
      lastReviewVerdictId: "review-verdict:issue-1:head-a-pass",
      summaryPointers: { ciStatus: "failure" },
      completionReports: [
        {
          id: "completion-report:issue-1:head-a",
          idempotencyKey: "head-a",
          runId: "worker-run-1",
          issueId: "issue-1",
          issueIdentifier: "TEST-1",
          summary: "Implemented head A.",
          validationEvidence: ["npm test"],
          acceptanceChecklist: [{ text: "Works", satisfied: true, evidence: "tests" }],
          changedFiles: ["src/index.ts"],
          branchName: "symphony/TEST-1",
          pullRequest: {
            url: "https://github.com/acme/symphony/pull/42",
            number: 42,
            headSha: "head-sha-1",
            branch: "symphony/TEST-1",
          },
          risks: [],
          acceptedAt: "2026-01-01T00:00:00.000Z",
          writebackOperationKeys: [],
        },
      ],
      reviewVerdicts: [
        {
          id: "review-verdict:issue-1:head-a-pass",
          idempotencyKey: "head-a-pass",
          runId: "review-run-1",
          issueId: "issue-1",
          issueIdentifier: "TEST-1",
          verdict: "pass",
          acceptanceResults: [{ text: "Head A reviewed", satisfied: true, evidence: "approved" }],
          findings: [],
          gateFindings: [],
          discoveryFindings: [],
          evidence: ["https://github.com/acme/symphony/pull/42#pullrequestreview-1"],
          reviewer: "reviewer-1",
          submittedAt: "2026-01-01T00:00:01.000Z",
          writebackOperationKeys: [],
        },
      ],
      reviewFeedback: [
        {
          id: "review-feedback:issue-1:review-run-1:approve",
          idempotencyKey: "head-a-approve",
          requestHash: "hash",
          runId: "review-run-1",
          issueId: "issue-1",
          issueIdentifier: "TEST-1",
          kind: "review",
          event: "APPROVE",
          body: "Approved.",
          pullRequest: {
            url: "https://github.com/acme/symphony/pull/42",
            number: 42,
            headSha: "head-sha-1",
            branch: "symphony/TEST-1",
          },
          reviewer: "reviewer-1",
          reviewUrl: "https://github.com/acme/symphony/pull/42#pullrequestreview-1",
          commentUrls: [],
          submittedAt: "2026-01-01T00:00:01.000Z",
        },
      ],
      mergeGate: mergeGate({
        headSha: "head-sha-1",
        repairRunId: "old-repair-run",
        repairReportId: "completion-report:issue-1:old-repair",
        checks: [
          {
            name: "test",
            outcome: "failing",
            rawStatus: "failure",
            conclusion: "failure",
            url: "https://ci.test/test",
            firstObservedAt: null,
            actionableSince: null,
          },
          {
            name: "typecheck",
            outcome: "missing_actionable",
            rawStatus: "missing",
            conclusion: null,
            url: null,
            firstObservedAt: "2026-01-01T00:00:00.000Z",
            actionableSince: "2026-01-01T00:05:00.000Z",
          },
        ],
      }),
    });

    await service.submitCompletionReport(
      report({
        pullRequest: {
          url: "https://github.com/acme/symphony/pull/42",
          number: 42,
          headSha: "head-sha-2",
          branch: "symphony/TEST-1",
        },
      }),
      context(),
    );

    const lifecycle = await lifecycleStore.get("issue-1");
    const operations = await outbox.list();
    expect(lifecycle?.phase).toBe("review");
    expect(lifecycle?.reviewRound).toBe(1);
    expect(lifecycle?.lastReviewVerdictId).toBeNull();
    expect(lifecycle?.reviewVerdicts.find((verdict) => verdict.id === "review-verdict:issue-1:head-a-pass")).toBeDefined();
    expect(lifecycle?.reviewFeedback).toHaveLength(1);
    expect(buildWorkerHandoffPacket(lifecycle!).lastReviewerOutput).toBeNull();
    expect(lifecycle?.summaryPointers.ciStatus).toBe("failure");
    expect(lifecycle?.summaryPointers.prHeadSha).toBe("head-sha-2");
    expect(lifecycle?.mergeGate).toMatchObject({
      status: "superseded",
      headSha: "head-sha-1",
      supersededByHeadSha: "head-sha-2",
      checks: [],
      repairRunId: null,
      repairReportId: null,
      blockerFingerprint: null,
      writebackOperationKeys: [],
    });
    expect(operations).toHaveLength(2);
    expect(operations.map((operation) => operation.idempotencyKey).some((key) => key.includes("head-superseded"))).toBe(false);
  });

  it("binds and replaces same-head merge gate repair completion IDs", async () => {
    const { service, lifecycleStore } = fixture();
    await lifecycleStore.ensureIssue(context().issue, {
      phase: "implementation",
      mergeGate: mergeGate({
        headSha: "head-sha-1",
        repairRunId: "run-1",
        repairReportId: "completion-report:issue-1:repair-1",
      }),
    });

    await service.submitCompletionReport(
      report({
        runId: "run-2",
        idempotencyKey: "repair-2",
        pullRequest: {
          url: "https://github.com/acme/symphony/pull/42",
          number: 42,
          headSha: "head-sha-1",
          branch: "symphony/TEST-1",
        },
      }),
      context({ activeRunId: "run-2" }),
    );

    const lifecycle = await lifecycleStore.get("issue-1");
    expect(lifecycle?.mergeGate).toMatchObject({
      status: "repair_dispatched",
      headSha: "head-sha-1",
      repairRunId: "run-2",
      repairReportId: "completion-report:issue-1:repair-2",
    });
  });

  it("requests a fresh PR head for no-change merge-gate repair completions", async () => {
    const publisher = new FakePublisher({
      action: "reused",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "head-sha-2",
      lastPushedAt: "2026-01-01T00:00:02Z",
      evidenceCursor: "repair-2",
    });
    const { service, lifecycleStore, runStore } = fixture({ publisher });
    await startRun(runStore);
    await lifecycleStore.ensureIssue(contextWithWorkspace().issue, {
      phase: "implementation",
      mergeGate: mergeGate({
        headSha: "head-sha-1",
        repairRunId: "run-1",
        repairReportId: null,
      }),
    });

    await service.submitCompletionReport(
      report({
        idempotencyKey: "repair-2",
        changedFiles: [],
        pullRequest: {
          url: "https://github.com/acme/symphony/pull/42",
          number: 42,
          headSha: "head-sha-1",
          branch: "symphony/TEST-1",
        },
      }),
      contextWithWorkspace(),
    );

    expect(publisher.inputs).toHaveLength(1);
    expect(publisher.inputs[0]).toMatchObject({
      evidenceCursor: "repair-2",
      forceEmptyCommit: true,
    });
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      phase: "review",
      summaryPointers: {
        prHeadSha: "head-sha-2",
      },
      mergeGate: {
        status: "superseded",
        headSha: "head-sha-1",
        supersededByHeadSha: "head-sha-2",
      },
    });
  });

  it("requests a fresh PR head for no-change completions against blocked merge gates", async () => {
    const publisher = new FakePublisher({
      action: "reused",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "head-sha-2",
      lastPushedAt: "2026-01-01T00:00:02Z",
      evidenceCursor: "repair-blocked",
    });
    const { service, lifecycleStore, runStore } = fixture({ publisher });
    await startRun(runStore);
    await lifecycleStore.ensureIssue(contextWithWorkspace().issue, {
      phase: "implementation",
      mergeGate: mergeGate({
        status: "blocked",
        headSha: "head-sha-1",
        repairRunId: "run-1",
        repairReportId: null,
      }),
    });

    await service.submitCompletionReport(
      report({
        idempotencyKey: "repair-blocked",
        changedFiles: [],
        pullRequest: {
          url: "https://github.com/acme/symphony/pull/42",
          number: 42,
          headSha: "head-sha-1",
          branch: "symphony/TEST-1",
        },
      }),
      contextWithWorkspace(),
    );

    expect(publisher.inputs).toHaveLength(1);
    expect(publisher.inputs[0]).toMatchObject({
      evidenceCursor: "repair-blocked",
      forceEmptyCommit: true,
    });
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      phase: "review",
      summaryPointers: {
        prHeadSha: "head-sha-2",
      },
      mergeGate: {
        status: "superseded",
        headSha: "head-sha-1",
        supersededByHeadSha: "head-sha-2",
      },
    });
  });

  it("replays duplicate reports without new lifecycle or writeback side effects", async () => {
    const { service, lifecycleStore, outbox } = fixture();

    const first = await service.submitCompletionReport(report(), context());
    const second = await service.submitCompletionReport(report({ summary: "Changed summary on replay." }), context());

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.report.summary).toBe("Implemented the service contract.");
    expect((await lifecycleStore.get("issue-1"))?.completionReports).toHaveLength(1);
    expect(await outbox.list()).toHaveLength(2);
  });

  it("publishes a new service-owned PR before accepting a completion report", async () => {
    const publisher = new FakePublisher({
      action: "created",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "idem-1",
    });
    const { service, lifecycleStore, outbox, runStore } = fixture({ publisher });
    await startRun(runStore);

    const result = await service.submitCompletionReport(report(), contextWithWorkspace());

    expect(result.report.pullRequest).toEqual({
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headSha: "abc123",
      branch: "symphony/TEST-1",
    });
    expect(publisher.inputs).toHaveLength(1);
    expect(publisher.inputs[0]).toMatchObject({
      workspacePath: "/tmp/workspace",
      branchName: "symphony/TEST-1",
      baseBranch: "main",
      evidenceCursor: "idem-1",
    });
    const comment = (await outbox.list()).find((operation) => operation.kind === "comment");
    expect(comment?.kind === "comment" ? comment.payload.body : "").toContain("https://github.com/acme/symphony/pull/42");
    expect(comment?.kind === "comment" ? comment.payload.body : "").toContain("PR head SHA: abc123");
    await expect(runStore.getRun("run-1")).resolves.toMatchObject({
      prUrl: "https://github.com/acme/symphony/pull/42",
      prNumber: 42,
      prHeadSha: "abc123",
      prBranch: "symphony/TEST-1",
      lastEvidenceCursor: "idem-1",
    });
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      phase: "review",
      summaryPointers: {
        prUrl: "https://github.com/acme/symphony/pull/42",
        prNumber: 42,
        prHeadSha: "abc123",
        prBranch: "symphony/TEST-1",
        lastEvidenceCursor: "idem-1",
      },
    });
  });

  it("blocks service-owned PR publication when base ref verification fails", async () => {
    const publisher = new BaseRefAwareFakePublisher({
      action: "created",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "idem-1",
    });
    const observation = baseRefObservation({
      classification: "branch_not_based_on_live_base",
      reason: "Worktree HEAD is not based on the live origin base",
    });
    const { service, lifecycleStore } = fixture({
      publisher,
      baseRefVerifier: {
        verify: async (_input: BaseRefVerificationInput) => observation,
      },
    });

    await expect(
      service.submitCompletionReport(report(), contextWithWorkspace()),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message:
        "base ref verification failed: worktree needs rebase over latest origin base",
    });

    expect(publisher.inputs).toHaveLength(0);
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      phase: "blocked",
      blockedReason:
        "base ref verification failed: worktree needs rebase over latest origin base",
      baseRefObservation: {
        classification: "branch_not_based_on_live_base",
        inputFingerprint: observation.inputFingerprint,
      },
    });
  });

  it("reuses a service-discovered PR and prevents duplicate publication on replay", async () => {
    const publisher = new FakePublisher({
      action: "reused",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "idem-1",
    });
    const { service, runStore, outbox } = fixture({ publisher });
    await startRun(runStore);

    const first = await service.submitCompletionReport(report(), contextWithWorkspace());
    const second = await service.submitCompletionReport(report({ summary: "Changed on replay." }), contextWithWorkspace());
    const transcript = await runStore.readTranscript("run-1");

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(publisher.inputs).toHaveLength(1);
    expect(await outbox.list()).toHaveLength(2);
    expect(transcript.events.filter((event) => event.eventType === "pr_opened")).toHaveLength(1);
  });

  it("rejects reused draft PRs when draft handoff is disabled", async () => {
    const publisher = new FakePublisher({
      action: "reused",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "idem-1",
      draft: true,
    });
    const { service, lifecycleStore, outbox, runStore } = fixture({ publisher });
    await startRun(runStore);

    await expect(service.submitCompletionReport(report(), contextWithWorkspace())).rejects.toMatchObject({
      code: "invalid_request",
    });

    expect(await lifecycleStore.get("issue-1")).toBeNull();
    expect(await outbox.list()).toHaveLength(0);
  });

  it("accepts service-owned PR handoff after configured required checks pass", async () => {
    const publisher = new FakePublisher(
      {
        action: "created",
        url: "https://github.com/acme/symphony/pull/42",
        number: 42,
        headBranch: "symphony/TEST-1",
        headSha: "abc123",
        lastPushedAt: "2026-01-01T00:00:01Z",
        evidenceCursor: "idem-1",
      },
      null,
      [{ name: "Typecheck and test", status: "success", conclusion: "success", url: null }],
    );
    const { service, outbox, runStore } = fixture({
      publisher,
      configure(config) {
        config.github.prHandoff.requiredChecks = ["Typecheck and test"];
      },
    });
    await startRun(runStore);

    await service.submitCompletionReport(report(), contextWithWorkspace());

    expect(publisher.checkInputs).toEqual([{ headSha: "abc123", requiredChecks: ["Typecheck and test"] }]);
    const comment = (await outbox.list()).find((operation) => operation.kind === "comment");
    expect(comment?.kind === "comment" ? comment.payload.body : "").toContain("Required checks: Typecheck and test");
    expect(comment?.kind === "comment" ? comment.payload.body : "").toContain("Passing checks: Typecheck and test");
  });

  it("rejects service-owned PR handoff while configured required checks are not passing", async () => {
    const publisher = new FakePublisher(
      {
        action: "created",
        url: "https://github.com/acme/symphony/pull/42",
        number: 42,
        headBranch: "symphony/TEST-1",
        headSha: "abc123",
        lastPushedAt: "2026-01-01T00:00:01Z",
        evidenceCursor: "idem-1",
      },
      null,
      [{ name: "Typecheck and test", status: "pending", conclusion: null, url: null }],
    );
    const { service, lifecycleStore, outbox, runStore } = fixture({
      publisher,
      configure(config) {
        config.github.prHandoff.requiredChecks = ["Typecheck and test"];
      },
    });
    await startRun(runStore);

    await expect(service.submitCompletionReport(report(), contextWithWorkspace())).rejects.toMatchObject({
      code: "invalid_request",
    });

    expect(publisher.checkInputs).toEqual([{ headSha: "abc123", requiredChecks: ["Typecheck and test"] }]);
    expect(await lifecycleStore.get("issue-1")).toBeNull();
    expect(await outbox.list()).toHaveLength(0);
  });

  it("rejects service-owned PR handoff when checks and no-CI evidence are absent", async () => {
    const publisher = new FakePublisher({
      action: "created",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "idem-1",
    });
    const { service, lifecycleStore, outbox, runStore } = fixture({
      publisher,
      configure(config) {
        config.github.prHandoff.requiredChecks = [];
        config.github.prHandoff.noCiAllowed = false;
        config.github.prHandoff.noCiEvidence = null;
      },
    });
    await startRun(runStore);

    await expect(service.submitCompletionReport(report(), contextWithWorkspace())).rejects.toMatchObject({
      code: "invalid_request",
    });

    expect(await lifecycleStore.get("issue-1")).toBeNull();
    expect(await outbox.list()).toHaveLength(0);
  });

  it("rejects completion handoff when service-owned PR publication fails", async () => {
    const publisher = new FakePublisher(null, new SymphonyError("tracker_error", "GitHub branch push failed"));
    const { service, lifecycleStore, outbox } = fixture({ publisher });

    await expect(service.submitCompletionReport(report(), contextWithWorkspace())).rejects.toMatchObject({
      code: "tracker_error",
    });

    expect(await lifecycleStore.get("issue-1")).toBeNull();
    expect(await outbox.list()).toHaveLength(0);
  });

  it("does not accept self-reported PR metadata as PR-driven handoff evidence", async () => {
    const { service, lifecycleStore, outbox } = fixture({
      configure(config) {
        config.github.prHandoff.enabled = true;
        config.tracker.handoffStates = ["Human Review"];
        config.github.prHandoff.targetState = "Human Review";
      },
    });

    await expect(
      service.submitCompletionReport(
        report({
          pullRequest: {
            url: "https://github.com/acme/symphony/pull/42",
            number: 42,
            headSha: "abc123",
            branch: "symphony/TEST-1",
          },
        }),
        contextWithWorkspace(),
      ),
    ).rejects.toMatchObject({
      code: "invalid_request",
    });

    expect(await lifecycleStore.get("issue-1")).toBeNull();
    expect(await outbox.list()).toHaveLength(0);
  });

  it("does not durably accept a report when enqueueing writebacks fails", async () => {
    const config = testConfig(root);
    config.writeback.enabled = true;
    config.writeback.dispatchState = "In Progress";
    config.reviewLoop.reviewStates = ["In Review"];
    const lifecycleStore = new FileIssueLifecycleStore(root);
    const failingOutbox = new FailingOutbox();
    const failingService = new CompletionReportService({ config, lifecycleStore, writebackOutbox: failingOutbox });

    await expect(failingService.submitCompletionReport(report(), context())).rejects.toThrow("enqueue failed");

    const afterFailure = await lifecycleStore.get("issue-1");
    expect(afterFailure?.phase).toBe("implementation");
    expect(afterFailure?.lastCompletionReportId).toBeNull();
    expect(afterFailure?.completionReports).toHaveLength(0);
    expect(failingOutbox.attempted).toBeGreaterThan(0);

    const outbox = new FileWritebackOutboxStore(root);
    const retryService = new CompletionReportService({ config, lifecycleStore, writebackOutbox: outbox });
    const retry = await retryService.submitCompletionReport(report(), context());

    expect(retry.replayed).toBe(false);
    expect(retry.writebackOperations).toHaveLength(2);
    expect((await lifecycleStore.get("issue-1"))?.completionReports).toHaveLength(1);
  });

  it("scopes publication approval setup drains to the report writeback keys", async () => {
    const config = testConfig(root);
    config.writeback.enabled = true;
    config.writeback.dispatchState = "In Progress";
    config.reviewLoop.blockedStates = ["Blocked"];
    config.github.publishPullRequests = true;
    config.github.owner = "acme";
    config.github.repo = "symphony";
    config.github.token = "github-token";
    config.github.operatorApproval!.requiredForPublication = true;
    const lifecycleStore = new FileIssueLifecycleStore(root);
    const runStore = new FileRunTranscriptStore(root);
    const outbox = new FileWritebackOutboxStore(root);
    await startRun(runStore);
    const siblingKey = "issue-create:issue-1:plan-1:0:hash";
    await outbox.enqueueOnce({
      idempotencyKey: siblingKey,
      kind: "issue_create",
      issueId: "issue-1",
      runId: "run-plan-1",
      payload: {
        parentIssueId: "issue-1",
        planId: "plan-1",
        proposedIssueIndex: 0,
        title: "Child issue",
        description: "Description",
        acceptanceCriteria: ["Done"],
        requestedLabels: ["planning"],
        dependencies: [],
        dedupeKey: "issue-breakdown:plan-1:0:hash",
        payloadHash: "hash",
      },
    });
    const processedKeyBatches: string[][] = [];
    const writebackProcessor = {
      async processDue(options: { idempotencyKeys?: readonly string[] } = {}) {
        const keys = [...(options.idempotencyKeys ?? [])];
        processedKeyBatches.push(keys);
        for (const key of keys) {
          const record = await outbox.get(key);
          if (record) await outbox.markSucceeded(record);
        }
      },
    };
    const service = new CompletionReportService({
      config,
      lifecycleStore,
      writebackOutbox: outbox,
      writebackProcessor,
      runStore,
      operatorApproval: {
        async requestPublicationApproval(input) {
          return approvalRecord(input.issueId, input.issueIdentifier, input.runId, input.evidenceCursor, input.action);
        },
        async waitForPublicationApprovalRequest(record) {
          return record;
        },
      },
    });

    await service.submitCompletionReport(report(), contextWithWorkspace());

    expect(processedKeyBatches).toHaveLength(1);
    expect(processedKeyBatches[0]).not.toContain(siblingKey);
    expect(processedKeyBatches[0]?.every((key) => key.includes("completion-report:idem-1"))).toBe(true);
    await expect(outbox.get(siblingKey)).resolves.toMatchObject({ status: "pending" });
  });

  it("rejects reports for a different active run", async () => {
    const { service } = fixture();

    await expect(service.submitCompletionReport(report({ runId: "run-2" }), context())).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("rejects reports outside the implementation state and phase", async () => {
    const { service, lifecycleStore } = fixture();
    await lifecycleStore.ensureIssue(issue({ state: "In Review" }), { phase: "review" });

    await expect(
      service.submitCompletionReport(report(), context({ issue: issue({ state: "In Review" }), phase: "review" })),
    ).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("rejects invalid role and token context", async () => {
    const { service } = fixture();

    await expect(service.submitCompletionReport(report(), context({ role: "reviewer" }))).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(service.submitCompletionReport(report(), context({ token: "wrong-token" }))).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("rejects ordinary completion reports from the configured merge conflicts state", async () => {
    const { service, lifecycleStore, outbox } = fixture({
      configure(config) {
        config.mergePolicy.mode = "gated";
        config.mergePolicy.conflictsState = "Approved with Conflicts";
        config.tracker.activeStates = ["Todo", "In Progress", "Approved with Conflicts"];
      },
    });

    await lifecycleStore.ensureIssue(issue({ state: "Approved with Conflicts" }), {
      phase: "merge_conflict_resolution",
    });

    await expect(
      service.submitCompletionReport(
        report(),
        context({ issue: issue({ state: "Approved with Conflicts", branchName: "symphony/TEST-1" }) }),
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(await outbox.list()).toHaveLength(0);
  });

  it("accepts a manual completion report with the issue state gate explicitly ignored", async () => {
    const { service, lifecycleStore, outbox } = fixture();

    const result = await service.submitCompletionReport(
      report(),
      context({
        issue: issue({ state: "In Review", branchName: "symphony/TEST-1" }),
        ignoreStateGate: true,
      }),
    );

    expect(result.replayed).toBe(false);
    expect(result.writebackOperations).toHaveLength(0);
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      phase: "review",
      lastCompletionReportId: "completion-report:issue-1:idem-1",
    });
    expect(await outbox.list()).toHaveLength(0);
  });

  it("rejects missing required report fields", async () => {
    const { service } = fixture();
    const { summary: _summary, ...missingSummary } = report();

    await expect(service.submitCompletionReport(missingSummary, context())).rejects.toBeInstanceOf(SymphonyError);
    await expect(service.submitCompletionReport(missingSummary, context())).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  function fixture(options: {
    publisher?: CompletionReportPullRequestPublisher;
    baseRefVerifier?: { verify(input: BaseRefVerificationInput): Promise<IssueBaseRefObservation> };
    configure?: (config: ReturnType<typeof testConfig>) => void;
  } = {}) {
    const config = testConfig(root);
    config.writeback.enabled = true;
    config.writeback.dispatchState = "In Progress";
    config.reviewLoop.reviewStates = ["In Review"];
    if (options.publisher) {
      config.github.publishPullRequests = true;
      config.github.prHandoff.enabled = true;
      config.tracker.handoffStates = ["Human Review"];
      config.github.prHandoff.targetState = "Human Review";
      config.github.prHandoff.noCiAllowed = true;
      config.github.prHandoff.noCiEvidence = "No CI configured in unit test";
      config.github.owner = "acme";
      config.github.repo = "symphony";
      config.github.token = "github-token";
    }
    options.configure?.(config);
    const lifecycleStore = new FileIssueLifecycleStore(root);
    const runStore = new FileRunTranscriptStore(root);
    const outbox = new FileWritebackOutboxStore(root);
    const service = new CompletionReportService({
      config,
      lifecycleStore,
      writebackOutbox: outbox,
      runStore,
      ...(options.publisher === undefined ? {} : { pullRequestPublisher: options.publisher }),
      ...(options.baseRefVerifier === undefined ? {} : { baseRefVerifier: options.baseRefVerifier }),
    });
    return { service, lifecycleStore, outbox, runStore };
  }
});

function report(overrides: Partial<CompletionReportInput> = {}): CompletionReportInput {
  return {
    runId: "run-1",
    issueId: "issue-1",
    summary: "Implemented the service contract.",
    validationEvidence: ["npm run typecheck", "npm test"],
    acceptanceChecklist: [
      {
        text: "Completion reports are persisted.",
        satisfied: true,
        evidence: "Lifecycle store records completionReports.",
      },
    ],
    changedFiles: ["src/core/CompletionReportService.ts"],
    branchName: "symphony/TEST-1",
    pullRequest: null,
    risks: ["Reviewer handler remains out of scope."],
    idempotencyKey: "idem-1",
    ...overrides,
  };
}

function context(overrides: Partial<CompletionReportActiveContext> = {}): CompletionReportActiveContext {
  return {
    issue: issue({ state: "In Progress", branchName: "symphony/TEST-1" }),
    activeRunId: "run-1",
    role: "worker",
    token: "worker-token",
    expectedToken: "worker-token",
    sessionId: "session-1",
    workspacePath: "/tmp/workspace",
    phase: "implementation",
    ...overrides,
  };
}

function contextWithWorkspace(overrides: Partial<CompletionReportActiveContext> = {}): CompletionReportActiveContext {
  return context({
    workspace: {
      path: "/tmp/workspace",
      workspaceKey: "TEST-1",
      createdNow: false,
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      gitBranchName: "symphony/TEST-1",
      repoPath: "/repo",
      baseRef: "main",
    },
    ...overrides,
  });
}

function mergeGate(overrides: Partial<IssueMergeGateState> = {}): IssueMergeGateState {
  return {
    id: "merge-gate:issue-1:pr-42:head-sha-1",
    status: "repair_dispatched",
    headSha: "head-sha-1",
    pullRequest: {
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headSha: "head-sha-1",
      branch: "symphony/TEST-1",
    },
    requiredChecks: ["test"],
    checks: [
      {
        name: "test",
        outcome: "failing",
        rawStatus: "failure",
        conclusion: "failure",
        url: "https://ci.test/test",
        firstObservedAt: null,
        actionableSince: null,
      },
    ],
    mergeability: null,
    reviewRound: 1,
    gateRunId: "worker-run-1",
    gateReportId: "completion-report:issue-1:report-1",
    repairRunId: null,
    repairReportId: null,
    blockerFingerprint: "head-sha-1:test:failure",
    writebackOperationKeys: [],
    supersededByHeadSha: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

async function startRun(runStore: FileRunTranscriptStore): Promise<void> {
  await runStore.startRun({
    runId: "run-1",
    sessionId: "session-1",
    agentId: "agent-1",
    role: "worker",
    issueId: "issue-1",
    issueIdentifier: "TEST-1",
    attempt: null,
    turnNumber: 1,
    prompt: "work",
    workspaceKey: "TEST-1",
    workspacePath: "/tmp/workspace",
    gitBranchName: "symphony/TEST-1",
    repoPath: "/repo",
    baseRef: "main",
  });
}

class FailingOutbox {
  attempted = 0;

  async enqueueOnce(_operation: NewWritebackOperation): Promise<WritebackOperation> {
    this.attempted += 1;
    throw new Error("enqueue failed");
  }

  async get(_idempotencyKey: string): Promise<WritebackOperation | null> {
    return null;
  }
}

class FakePublisher implements CompletionReportPullRequestPublisher {
  readonly inputs: CompletionReportPullRequestPublicationInput[] = [];
  readonly checkInputs: Array<{ headSha: string; requiredChecks: string[] }> = [];

  constructor(
    private readonly publication: CompletionReportPullRequestPublication | null,
    private readonly failure: Error | null = null,
    private readonly checks: CompletionReportPullRequestCheckResult[] = [],
  ) {}

  async publishPullRequest(
    input: CompletionReportPullRequestPublicationInput,
  ): Promise<CompletionReportPullRequestPublication> {
    this.inputs.push(input);
    if (this.failure) throw this.failure;
    if (!this.publication) throw new Error("missing fake publication");
    return this.publication;
  }

  async getRequiredCheckResults(input: {
    headSha: string;
    requiredChecks: string[];
  }): Promise<CompletionReportPullRequestCheckResult[]> {
    this.checkInputs.push(input);
    return this.checks;
  }
}

class BaseRefAwareFakePublisher extends FakePublisher {
  async getBranchHeadSha(_input: { branchName: string }): Promise<string> {
    return "base-sha";
  }

  async gitAuthHeader(): Promise<string> {
    return "AUTHORIZATION: bearer test-token";
  }
}

function baseRefObservation(
  overrides: Partial<IssueBaseRefObservation> = {},
): IssueBaseRefObservation {
  return {
    version: 1,
    inputFingerprint: "base-ref:fingerprint",
    classification: "ok",
    operation: "reconcile_completion_report_handoff",
    checkedAt: "2026-01-01T00:00:00.000Z",
    workspacePath: "/tmp/workspace",
    branchName: "symphony/TEST-1",
    baseRef: "main",
    normalizedBaseBranch: "main",
    localBaseRef: "refs/remotes/origin/main",
    githubBaseHeadSha: "base-sha",
    localBaseHeadShaBeforeFetch: "old-base-sha",
    localBaseHeadShaAfterFetch: "base-sha",
    worktreeHeadSha: "head-sha",
    localBaseIsAncestorOfHead: true,
    reason: null,
    error: null,
    ...overrides,
  };
}

function approvalRecord(
  issueId: string,
  issueIdentifier: string,
  runId: string,
  evidenceCursor: string,
  action: OperatorApprovalRecord["action"],
): OperatorApprovalRecord {
  return {
    requestId: `approval:${runId}:${evidenceCursor}`,
    status: "pending",
    issueId,
    issueIdentifier,
    runId,
    evidenceCursor,
    dedupeKey: `${runId}:${evidenceCursor}`,
    action,
    requestedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    resolvedAt: null,
    resolvedBy: null,
    decision: null,
    staleReason: null,
  };
}

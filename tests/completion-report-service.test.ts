import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CompletionReportService,
  verifyDependencyArtifactManifest,
  type CompletionReportActiveContext,
  type CompletionReportInput,
  type DependencyArtifactManifestVerificationInput,
} from "../src/core/CompletionReportService.js";
import type {
  BaseRefVerificationInput,
  IssueBaseRefObservation,
} from "../src/core/BaseRefVerification.js";
import { SymphonyError } from "../src/core/errors.js";
import { parseIssueContract } from "../src/core/IssueContractLint.js";
import {
  FileIssueLifecycleStore,
  buildWorkerHandoffPacket,
  type ExpectedRedArtifactEvidence,
  type IssueAcceptedArtifactRecord,
  type IssueMergeGateState,
  type IssueWorkspaceSeedRecord,
} from "../src/core/persistence/IssueLifecycleStore.js";
import { FileRunTranscriptStore } from "../src/core/persistence/RunTranscriptStore.js";
import { FileWritebackOutboxStore, type NewWritebackOperation, type WritebackOperation } from "../src/core/writeback/WritebackOutbox.js";
import { agentEligibleIssueContract, issue, testConfig } from "./helpers.js";
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
      lastCompletionReportId: "completion-report:issue-1:run-1:idem-1",
      incompleteTurnCount: 0,
      completionReports: [
        {
          id: "completion-report:issue-1:run-1:idem-1",
          idempotencyKey: "idem-1",
          runId: "run-1",
          issueId: "issue-1",
          issueIdentifier: "TEST-1",
          finalDisposition: report().finalDisposition,
          summary: "Implemented the service contract.",
          changedFiles: ["src/core/CompletionReportService.ts"],
          branchName: "symphony/TEST-1",
          pullRequest: null,
          acceptanceContext: {
            version: 1,
            runId: "run-1",
            branchName: "symphony/TEST-1",
            baseRef: null,
            baseHeadSha: null,
            worktreeHeadSha: null,
            pullRequestHeadSha: null,
            worktreeDirty: null,
          },
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
      lifecycleBinding: {
        kind: "completion_report",
        recordId: "completion-report:issue-1:run-1:idem-1",
      },
      payload: {
        dedupeKey: "run-1:completion-report:idem-1",
      },
    });
    expect(commentOperation?.kind === "comment" ? commentOperation.payload.body : "").toContain("Completion report:");
    expect(commentOperation?.kind === "comment" ? commentOperation.payload.body : "").toContain(report().finalDisposition);
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

  it("rejects disposition drift when an idempotent rejected completion report is retried", async () => {
    const { service, lifecycleStore, outbox } = fixture();
    const acceptanceChecklist = [
      {
        text: "REQ-1 Required validation is complete.",
        satisfied: false,
        evidence: "Focused validation could not run.",
      },
    ];
    const original = report({ acceptanceChecklist });
    const changedDisposition = "A corrected but different full worker disposition.";

    await expect(
      service.submitCompletionReport(original, context()),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      service.submitCompletionReport(
        report({ acceptanceChecklist, finalDisposition: changedDisposition }),
        context(),
      ),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "Rejected completion report idempotency key was reused with a different final disposition",
    });

    const lifecycle = await lifecycleStore.get("issue-1");
    expect(lifecycle?.completionReportRejections).toHaveLength(1);
    expect(lifecycle?.completionReportRejections[0]?.finalDisposition).toBe(original.finalDisposition);
    const operations = await outbox.list();
    expect(operations).toHaveLength(1);
    const body = operations[0]?.kind === "comment" ? operations[0].payload.body : "";
    expect(body).toContain(original.finalDisposition);
    expect(body).not.toContain(changedDisposition);
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
      repairReportId: "completion-report:issue-1:run-2:repair-2",
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
    const workspacePath = await createGitWorkspace(root);
    const { service, lifecycleStore, outbox } = fixture();
    const replayContext = contextWithWorkspace({
      workspacePath,
      issue: issue({ state: "In Progress", branchName: "main" }),
      workspace: workspaceForGitFixture(workspacePath),
    });

    const first = await service.submitCompletionReport(report({ branchName: "main" }), replayContext);
    const second = await service.submitCompletionReport(
      report({ branchName: "main", summary: "Changed summary on replay." }),
      replayContext,
    );

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.report.summary).toBe("Implemented the service contract.");
    expect((await lifecycleStore.get("issue-1"))?.completionReports).toHaveLength(1);
    expect(await outbox.list()).toHaveLength(2);
  });

  it("rejects canonical final disposition drift without replacing lifecycle or Linear writebacks", async () => {
    const workspacePath = await createGitWorkspace(root);
    const { service, lifecycleStore, outbox } = fixture();
    const replayContext = contextWithWorkspace({
      workspacePath,
      issue: issue({ state: "In Progress", branchName: "main" }),
      workspace: workspaceForGitFixture(workspacePath),
    });
    const original = report({ branchName: "main" });
    const changedDisposition = "A different canonical final disposition must not replace the accepted one.";

    await service.submitCompletionReport(original, replayContext);

    await expect(
      service.submitCompletionReport(
        report({ branchName: "main", finalDisposition: changedDisposition }),
        replayContext,
      ),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "Completion report idempotency key was reused with a different final disposition",
    });

    const lifecycle = await lifecycleStore.get("issue-1");
    expect(lifecycle?.completionReports).toHaveLength(1);
    expect(lifecycle?.completionReports[0]?.finalDisposition).toBe(original.finalDisposition);
    const operations = await outbox.list();
    expect(operations).toHaveLength(2);
    const comment = operations.find((operation) => operation.kind === "comment");
    expect(comment?.kind === "comment" ? comment.payload.body : "").toContain(original.finalDisposition);
    expect(comment?.kind === "comment" ? comment.payload.body : "").not.toContain(changedDisposition);
  });

  it("replays a finalized legacy report without synthesizing its missing final disposition", async () => {
    const workspacePath = await createGitWorkspace(root);
    const { service, lifecycleStore, outbox } = fixture();
    const replayContext = contextWithWorkspace({
      workspacePath,
      issue: issue({ state: "In Progress", branchName: "main" }),
      workspace: workspaceForGitFixture(workspacePath),
    });
    const input = report({ branchName: "main" });
    const accepted = await service.submitCompletionReport(input, replayContext);
    const legacyReport = { ...accepted.report };
    delete legacyReport.finalDisposition;
    await lifecycleStore.updateIssue(replayContext.issue, {
      completionReports: [legacyReport],
      lastCompletionReportId: legacyReport.id,
    });

    const replayed = await service.submitCompletionReport(input, replayContext);

    expect(replayed.replayed).toBe(true);
    expect(replayed.report).not.toHaveProperty("finalDisposition");
    const lifecycle = await lifecycleStore.get("issue-1");
    expect(lifecycle?.completionReports).toHaveLength(1);
    expect(lifecycle?.completionReports[0]).not.toHaveProperty("finalDisposition");
    expect(await outbox.list()).toHaveLength(2);
  });

  it("treats the same idempotency key from a later run with a changed PR head as a fresh completion", async () => {
    const { service, lifecycleStore, outbox } = fixture();
    const pullRequest = {
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headSha: "head-sha-1",
      branch: "symphony/TEST-1",
    };

    const first = await service.submitCompletionReport(report({ pullRequest }), context());
    const second = await service.submitCompletionReport(
      report({
        runId: "run-2",
        pullRequest: {
          ...pullRequest,
          headSha: "head-sha-2",
        },
      }),
      context({ activeRunId: "run-2" }),
    );

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(false);
    expect(second.report.id).toBe("completion-report:issue-1:run-2:idem-1");
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      lastCompletionReportId: "completion-report:issue-1:run-2:idem-1",
      completionReports: [
        {
          id: "completion-report:issue-1:run-1:idem-1",
          runId: "run-1",
          pullRequest: { headSha: "head-sha-1" },
        },
        {
          id: "completion-report:issue-1:run-2:idem-1",
          runId: "run-2",
          pullRequest: { headSha: "head-sha-2" },
        },
      ],
    });
    expect(await outbox.list()).toHaveLength(4);
  });

  it("does not replay a same-key later run when worktree authority is unavailable", async () => {
    const { service, lifecycleStore, outbox } = fixture();

    await service.submitCompletionReport(report(), context({ workspacePath: null, workspace: null }));
    const second = await service.submitCompletionReport(
      report({ runId: "run-2" }),
      context({ activeRunId: "run-2", workspacePath: null, workspace: null }),
    );

    expect(second.replayed).toBe(false);
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      lastCompletionReportId: "completion-report:issue-1:run-2:idem-1",
      completionReports: [
        { runId: "run-1", acceptanceContext: { worktreeDirty: null, worktreeHeadSha: null } },
        { runId: "run-2", acceptanceContext: { worktreeDirty: null, worktreeHeadSha: null } },
      ],
    });
    expect(await outbox.list()).toHaveLength(4);
  });

  it("captures dirty worktree state on fresh same-key later runs", async () => {
    const workspacePath = await createGitWorkspace(root);
    const { service, lifecycleStore } = fixture();
    const workspaceContext = () =>
      contextWithWorkspace({
        workspacePath,
        issue: issue({ state: "In Progress", branchName: "main" }),
        workspace: {
          path: workspacePath,
          workspaceKey: "TEST-1",
          createdNow: false,
          issueId: "issue-1",
          issueIdentifier: "TEST-1",
          gitBranchName: "main",
          repoPath: workspacePath,
          baseRef: "main",
        },
      });

    const first = await service.submitCompletionReport(report({ branchName: "main" }), workspaceContext());
    await writeFile(path.join(workspacePath, "tracked.txt"), "changed\n", "utf8");
    const second = await service.submitCompletionReport(
      report({ runId: "run-2", branchName: "main" }),
      { ...workspaceContext(), activeRunId: "run-2" },
    );

    expect(first.report.acceptanceContext).toMatchObject({
      branchName: "main",
      baseRef: "main",
      worktreeDirty: false,
      worktreeHeadSha: expect.any(String),
      baseHeadSha: expect.any(String),
    });
    expect(second.replayed).toBe(false);
    expect(second.report.acceptanceContext).toMatchObject({
      branchName: "main",
      baseRef: "main",
      worktreeDirty: true,
      worktreeHeadSha: first.report.acceptanceContext?.worktreeHeadSha,
      baseHeadSha: first.report.acceptanceContext?.baseHeadSha,
    });
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      lastCompletionReportId: "completion-report:issue-1:run-2:idem-1",
    });
  });

  it("requires structured expected-red evidence for accepted-artifact delivery", async () => {
    const { service } = fixture();

    await expect(
      service.submitCompletionReport(
        report(),
        context({ issue: acceptedArtifactIssue() }),
      ),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: "Accepted expected-red artifact delivery requires structured artifactEvidence",
    });
  });

  it("forbids expected-red evidence for merge delivery", async () => {
    const { service } = fixture();

    await expect(
      service.submitCompletionReport(
        report({
          artifactEvidence: expectedRedEvidence(),
          changedFiles: ["tests/new-behavior.test.ts"],
        }),
        context({
          issue: issue({
            state: "In Progress",
            branchName: "symphony/TEST-1",
            description: mergeIssueContract(),
          }),
        }),
      ),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: "artifactEvidence is only valid for an explicit accepted expected-red artifact delivery contract",
    });
  });

  it("requires every expected-red test file to be declared in changedFiles", async () => {
    const { service } = fixture();

    await expect(
      service.submitCompletionReport(
        report({
          artifactEvidence: expectedRedEvidence(),
          changedFiles: ["src/unrelated.ts"],
        }),
        context({ issue: acceptedArtifactIssue() }),
      ),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: "Every expected-red test file must be included in completion report changedFiles",
      details: { missingTestFiles: ["tests/new-behavior.test.ts"] },
    });
  });

  it("publishes accepted expected-red artifacts as draft PRs without generic PR handoff or green checks", async () => {
    const publisher = new FakePublisher(
      {
        action: "created",
        url: "https://github.com/acme/symphony/pull/42",
        number: 42,
        headBranch: "symphony/TEST-1",
        headSha: "abc123",
        lastPushedAt: "2026-01-01T00:00:01Z",
        evidenceCursor: "idem-1",
        draft: true,
      },
      null,
      [{ name: "Typecheck and test", status: "failure", conclusion: "failure", url: null }],
    );
    const { service, lifecycleStore, runStore } = fixture({
      publisher,
      configure(config) {
        config.github.prHandoff.enabled = false;
        config.github.prHandoff.requiredChecks = ["Typecheck and test"];
        config.github.prHandoff.noCiAllowed = false;
        config.github.prHandoff.noCiEvidence = null;
      },
    });
    await startRun(runStore);

    const result = await service.submitCompletionReport(
      report({
        artifactEvidence: expectedRedEvidence(),
        changedFiles: ["tests/new-behavior.test.ts"],
      }),
      contextWithWorkspace({ issue: acceptedArtifactIssue() }),
    );

    expect(publisher.inputs).toHaveLength(1);
    expect(publisher.inputs[0]).toMatchObject({ draft: true });
    expect(publisher.checkInputs).toEqual([]);
    expect(result.report).toMatchObject({
      pullRequest: {
        url: "https://github.com/acme/symphony/pull/42",
        number: 42,
        headSha: "abc123",
        branch: "symphony/TEST-1",
        draft: true,
      },
      contractSnapshot: {
        schemaVersion: 1,
        contractVersion: "2026-07-14.accepted-artifact",
        fingerprint: expect.any(String),
        delivery: { mode: "accepted_artifact", artifact: "expected_red_tests" },
      },
      artifactEvidence: expectedRedEvidence(),
    });
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      phase: "review",
      completionReports: [
        {
          pullRequest: {
            url: "https://github.com/acme/symphony/pull/42",
            number: 42,
            headSha: "abc123",
            branch: "symphony/TEST-1",
            draft: true,
          },
          contractSnapshot: {
            delivery: { mode: "accepted_artifact", artifact: "expected_red_tests" },
          },
          artifactEvidence: expectedRedEvidence(),
        },
      ],
    });
  });

  it("rejects an accepted expected-red artifact when the verified PR is not draft", async () => {
    const publisher = new FakePublisher({
      action: "created",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "idem-1",
      draft: false,
    });
    const { service, lifecycleStore, outbox } = fixture({ publisher });

    await expect(
      service.submitCompletionReport(
        report({
          artifactEvidence: expectedRedEvidence(),
          changedFiles: ["tests/new-behavior.test.ts"],
        }),
        contextWithWorkspace({ issue: acceptedArtifactIssue() }),
      ),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: "Accepted expected-red artifacts require a verified draft pull request handoff",
    });

    expect(publisher.inputs[0]).toMatchObject({ draft: true });
    expect(await lifecycleStore.get("issue-1")).toBeNull();
    expect(await outbox.list()).toHaveLength(0);
  });

  it("requires seeded implementations to prove the completed source artifact now passes", async () => {
    const { service, lifecycleStore } = fixture();
    const targetIssue = issue({ state: "In Progress", branchName: "symphony/TEST-1" });
    await lifecycleStore.ensureIssue(sourceArtifactIssue(), {
      phase: "terminal",
      acceptedArtifact: completedAcceptedArtifact(),
    });
    await lifecycleStore.ensureIssue(targetIssue, {
      phase: "implementation",
      workspaceSeed: preparedWorkspaceSeed(),
    });
    const targetContext = context({ issue: targetIssue });

    await expect(service.submitCompletionReport(report(), targetContext)).rejects.toMatchObject({
      code: "invalid_request",
      message: "Seeded implementation completion requires dependencyArtifactResult proving the inherited expected-red tests pass",
    });
    await expect(
      service.submitCompletionReport(
        report({
          dependencyArtifactResult: passingDependencyArtifactResult({ artifactId: "artifact:wrong" }),
        }),
        targetContext,
      ),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: "dependencyArtifactResult must match the seeded artifact id and declared expected-red command",
    });
    await expect(
      service.submitCompletionReport(
        report({
          dependencyArtifactResult: passingDependencyArtifactResult({ command: "npm test -- tests/other.test.ts" }),
        }),
        targetContext,
      ),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: "dependencyArtifactResult must match the seeded artifact id and declared expected-red command",
    });
    await expect(
      service.submitCompletionReport(
        {
          ...report(),
          dependencyArtifactResult: {
            ...passingDependencyArtifactResult(),
            exitCode: 1,
          },
        },
        targetContext,
      ),
    ).rejects.toMatchObject({ code: "invalid_request", message: "Completion report is invalid" });

    const result = await service.submitCompletionReport(
      report({ dependencyArtifactResult: passingDependencyArtifactResult() }),
      targetContext,
    );

    expect(result.report.dependencyArtifactResult).toEqual(passingDependencyArtifactResult());
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      phase: "review",
      completionReports: [
        { dependencyArtifactResult: passingDependencyArtifactResult() },
      ],
    });
  });

  it("verifies the inherited artifact manifest before accepting seeded completion", async () => {
    const verifierInputs: DependencyArtifactManifestVerificationInput[] = [];
    const { service, lifecycleStore } = fixture({
      dependencyArtifactManifestVerifier: async (input) => {
        verifierInputs.push(input);
      },
    });
    const source = sourceArtifactIssue();
    const target = liveSeededTarget(source);
    const artifact = completedAcceptedArtifact();
    await lifecycleStore.ensureIssue(source, {
      phase: "terminal",
      acceptedArtifact: artifact,
    });
    await lifecycleStore.ensureIssue(target, {
      phase: "implementation",
      workspaceSeed: preparedWorkspaceSeed(),
    });

    await service.submitCompletionReport(
      report({ dependencyArtifactResult: passingDependencyArtifactResult() }),
      context({ issue: target, workspacePath: "/tmp/seeded-worktree" }),
    );

    expect(verifierInputs).toEqual([
      {
        workspacePath: "/tmp/seeded-worktree",
        artifact: expect.objectContaining({ id: artifact.id }),
      },
    ]);
  });

  it("detects inherited artifact file changes in both the worktree and committed HEAD", async () => {
    const workspacePath = await createGitWorkspace(root);
    const testFile = "tests/new-behavior.test.ts";
    await mkdir(path.join(workspacePath, "tests"), { recursive: true });
    await writeFile(path.join(workspacePath, testFile), "test('reviewed', () => true);\n", "utf8");
    await git(["add", testFile], workspacePath);
    await git(
      [
        "-c",
        "user.name=Symphony Test",
        "-c",
        "user.email=symphony@example.test",
        "commit",
        "-m",
        "accepted tests",
      ],
      workspacePath,
    );
    const reviewedBlob = await gitOutput(
      ["rev-parse", `HEAD:${testFile}`],
      workspacePath,
    );
    const artifact: IssueAcceptedArtifactRecord = {
      ...completedAcceptedArtifact(),
      changedFiles: [testFile],
      fileManifest: [
        { path: testFile, status: "added", blobSha: reviewedBlob },
      ],
    };

    await expect(
      verifyDependencyArtifactManifest({ workspacePath, artifact }),
    ).resolves.toBeUndefined();

    await writeFile(path.join(workspacePath, testFile), "test('weakened', () => true);\n", "utf8");
    await expect(
      verifyDependencyArtifactManifest({ workspacePath, artifact }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "Inherited accepted-artifact files have uncommitted changes",
    });

    await git(["add", testFile], workspacePath);
    await git(
      [
        "-c",
        "user.name=Symphony Test",
        "-c",
        "user.email=symphony@example.test",
        "commit",
        "-m",
        "weaken tests",
      ],
      workspacePath,
    );
    await expect(
      verifyDependencyArtifactManifest({ workspacePath, artifact }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: `Inherited accepted-artifact file ${testFile} no longer matches the reviewed checkpoint`,
    });
  });

  it("rejects dependency completion evidence for a superseded accepted artifact", async () => {
    const { service, lifecycleStore } = fixture();
    const targetIssue = issue({ state: "In Progress", branchName: "symphony/TEST-1" });
    await lifecycleStore.ensureIssue(sourceArtifactIssue(), {
      phase: "terminal",
      acceptedArtifact: {
        ...completedAcceptedArtifact(),
        supersededAt: "2026-07-14T00:10:00.000Z",
        supersededBy: "issue_contract_or_head_drift",
        supersededReason: "The source contract changed after review.",
      },
    });
    await lifecycleStore.ensureIssue(targetIssue, {
      phase: "implementation",
      workspaceSeed: preparedWorkspaceSeed(),
    });

    await expect(
      service.submitCompletionReport(
        report({ dependencyArtifactResult: passingDependencyArtifactResult() }),
        context({ issue: targetIssue }),
      ),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: "Seeded implementation completion requires the matching completed accepted artifact checkpoint",
    });
  });

  it("defers seeded implementation completion when the accepted-artifact source is reopened", async () => {
    const reopenedSource = sourceArtifactIssue("In Progress");
    const liveTarget = liveSeededTarget(reopenedSource);
    const { service, lifecycleStore } = fixture({
      resolveIssuesByIds: async (ids) =>
        [liveTarget, reopenedSource].filter((candidate) =>
          ids.includes(candidate.id),
        ),
    });
    await lifecycleStore.ensureIssue(reopenedSource, {
      phase: "terminal",
      acceptedArtifact: completedAcceptedArtifact(),
    });
    await lifecycleStore.ensureIssue(liveTarget, {
      phase: "implementation",
      workspaceSeed: preparedWorkspaceSeed(),
    });

    await expect(
      service.submitCompletionReport(
        report({ dependencyArtifactResult: passingDependencyArtifactResult() }),
        context({ issue: liveTarget }),
      ),
    ).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining(
        "waiting for accepted-artifact source TEST-0 to become terminal again",
      ),
    });
    await expect(lifecycleStore.get(liveTarget.id)).resolves.toMatchObject({
      phase: "implementation",
      incompleteTurnCount: 0,
    });
  });

  it("rejects chaining an accepted-artifact source onto another accepted artifact", async () => {
    const { service, lifecycleStore } = fixture();
    const targetIssue = acceptedArtifactIssue();
    await lifecycleStore.ensureIssue(sourceArtifactIssue(), {
      phase: "terminal",
      acceptedArtifact: completedAcceptedArtifact(),
    });
    await lifecycleStore.ensureIssue(targetIssue, {
      phase: "implementation",
      workspaceSeed: preparedWorkspaceSeed(),
    });

    await expect(
      service.submitCompletionReport(
        report({
          artifactEvidence: expectedRedEvidence(),
          changedFiles: ["tests/new-behavior.test.ts"],
          dependencyArtifactResult: passingDependencyArtifactResult(),
        }),
        context({ issue: targetIssue }),
      ),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message:
        "Accepted-artifact source issues cannot themselves consume another accepted artifact; use a merge-delivery integration issue",
    });
  });

  it("rejects idempotent completion replay after the Issue Contract fingerprint changes", async () => {
    const { service, lifecycleStore } = fixture();
    const firstIssue = issue({
      state: "In Progress",
      branchName: "symphony/TEST-1",
      description: mergeIssueContract("2026-07-14.first"),
    });
    const first = await service.submitCompletionReport(report(), context({ issue: firstIssue }));
    const changedIssue = {
      ...firstIssue,
      description: mergeIssueContract("2026-07-14.changed"),
      updatedAt: "2026-07-14T01:00:00Z",
    };

    await expect(
      service.submitCompletionReport(report(), context({ issue: changedIssue })),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "Issue Contract changed after this completion report was persisted; submit a fresh completion report against the current contract",
      details: {
        previousFingerprint: first.report.contractSnapshot?.fingerprint,
        currentFingerprint: expect.any(String),
      },
    });
    expect((await lifecycleStore.get("issue-1"))?.completionReports).toHaveLength(1);
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
    const workspacePath = await createGitWorkspace(root);
    const headSha = await gitOutput(["rev-parse", "HEAD"], workspacePath);
    const publisher = new FakePublisher({
      action: "reused",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "main",
      headSha,
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "idem-1",
    });
    const { service, runStore, outbox } = fixture({ publisher });
    await startRun(runStore);
    const replayContext = contextWithWorkspace({
      workspacePath,
      issue: issue({ state: "In Progress", branchName: "main" }),
      workspace: workspaceForGitFixture(workspacePath),
    });

    const first = await service.submitCompletionReport(report({ branchName: "main" }), replayContext);
    const second = await service.submitCompletionReport(
      report({ branchName: "main", summary: "Changed on replay." }),
      replayContext,
    );
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
      code: "invalid_request",
      message: "Completion report could not publish the pull request: GitHub branch push failed",
      details: {
        reasonCode: "pull_request_publication_failed",
        rejectionId: "completion-report-rejection:issue-1:idem-1",
        reportId: "completion-report:issue-1:idem-1",
      },
    });

    const lifecycle = await lifecycleStore.get("issue-1");
    expect(lifecycle).toMatchObject({
      phase: "implementation",
      lastCompletionReportRejectionId: "completion-report-rejection:issue-1:idem-1",
      completionReportRejections: [
        {
          id: "completion-report-rejection:issue-1:idem-1",
          reasonCode: "pull_request_publication_failed",
          reason: "Completion report could not publish the pull request: GitHub branch push failed",
          writebackOperationKeys: ["comment:issue-1:run-1:completion-report:idem-1:rejected"],
        },
      ],
    });
    const operations = await outbox.list();
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      kind: "comment",
      idempotencyKey: "comment:issue-1:run-1:completion-report:idem-1:rejected",
    });
    const comment = operations[0]?.kind === "comment" ? operations[0].payload.body : "";
    expect(comment).toContain("Status: rejected");
    expect(comment).toContain("Completion report could not publish the pull request: GitHub branch push failed");
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

  it("fails closed when a pre-lifecycle retry finds different queued disposition intent", async () => {
    const config = testConfig(root);
    config.writeback.enabled = true;
    config.writeback.dispatchState = "In Progress";
    config.reviewLoop.reviewStates = ["In Review"];
    const lifecycleStore = new FileIssueLifecycleStore(root);
    const outbox = new FileWritebackOutboxStore(root);
    await outbox.enqueueOnce({
      idempotencyKey: "comment:issue-1:run-1:completion-report:idem-1",
      kind: "comment",
      issueId: "issue-1",
      runId: "run-1",
      payload: {
        dedupeKey: "run-1:completion-report:idem-1",
        body: "A different full final disposition was queued before the crash.",
      },
    });
    const service = new CompletionReportService({
      config,
      lifecycleStore,
      writebackOutbox: outbox,
    });

    await expect(
      service.submitCompletionReport(report(), context()),
    ).rejects.toThrow(/different intent/);

    const lifecycle = await lifecycleStore.get("issue-1");
    expect(lifecycle?.lastCompletionReportId).toBeNull();
    expect(lifecycle?.completionReports).toEqual([]);
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
    const finalDisposition =
      "Manual completion accepted outside the normal state gate.\n\nThe complete worker response remains visible without truncation.";

    const result = await service.submitCompletionReport(
      report({ finalDisposition }),
      context({
        issue: issue({ state: "In Review", branchName: "symphony/TEST-1" }),
        ignoreStateGate: true,
      }),
    );

    expect(result.replayed).toBe(false);
    expect(result.writebackOperations).toHaveLength(1);
    expect(result.writebackOperations[0]).toMatchObject({
      kind: "comment",
      lifecycleBinding: {
        kind: "completion_report",
        recordId: "completion-report:issue-1:run-1:idem-1",
      },
    });
    expect(
      result.writebackOperations[0]?.kind === "comment"
        ? result.writebackOperations[0].payload.body
        : "",
    ).toContain(finalDisposition);
    expect(result.writebackOperations.some((operation) => operation.kind === "transition"))
      .toBe(false);
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      phase: "review",
      lastCompletionReportId: "completion-report:issue-1:run-1:idem-1",
      completionReports: [
        expect.objectContaining({ finalDisposition }),
      ],
    });
    await expect(outbox.list()).resolves.toHaveLength(1);
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
    resolveIssuesByIds?: (issueIds: string[]) => Promise<ReturnType<typeof issue>[]>;
    dependencyArtifactManifestVerifier?: (
      input: DependencyArtifactManifestVerificationInput,
    ) => Promise<void>;
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
    const defaultSource = sourceArtifactIssue();
    const defaultTarget = liveSeededTarget(defaultSource);
    const service = new CompletionReportService({
      config,
      lifecycleStore,
      writebackOutbox: outbox,
      runStore,
      ...(options.publisher === undefined ? {} : { pullRequestPublisher: options.publisher }),
      ...(options.baseRefVerifier === undefined ? {} : { baseRefVerifier: options.baseRefVerifier }),
      resolveIssuesByIds:
        options.resolveIssuesByIds ??
        (async (ids) =>
          [defaultTarget, defaultSource].filter((candidate) =>
            ids.includes(candidate.id),
          )),
      dependencyArtifactManifestVerifier:
        options.dependencyArtifactManifestVerifier ?? (async () => undefined),
    });
    return { service, lifecycleStore, outbox, runStore };
  }
});

function report(overrides: Partial<CompletionReportInput> = {}): CompletionReportInput {
  return {
    runId: "run-1",
    issueId: "issue-1",
    finalDisposition:
      "Implemented the service contract and validated every acceptance criterion.\n\nValidation: typecheck and tests passed.\nRisks: reviewer handling remains explicitly out of scope.",
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

function acceptedArtifactIssue() {
  return issue({
    state: "In Progress",
    branchName: "symphony/TEST-1",
    description: agentEligibleIssueContract({
      issueContractContractVersion: "2026-07-14.accepted-artifact",
      issueContractDelivery: { mode: "accepted_artifact", artifact: "expected_red_tests" },
    }),
  });
}

function mergeIssueContract(contractVersion = "2026-07-14.merge"): string {
  return agentEligibleIssueContract({
    issueContractContractVersion: contractVersion,
    issueContractDelivery: { mode: "merge" },
  });
}

function expectedRedEvidence(
  overrides: Partial<ExpectedRedArtifactEvidence> = {},
): ExpectedRedArtifactEvidence {
  return {
    kind: "expected_red_tests",
    command: "npm test -- tests/new-behavior.test.ts",
    testFiles: ["tests/new-behavior.test.ts"],
    expectedFailure: "The implementation does not support the new behavior yet.",
    observedFailure: "Expected true, received false.",
    exitCode: 1,
    ...overrides,
  };
}

function sourceArtifactIssue(state = "Done") {
  return issue({
    id: "source-issue-1",
    identifier: "TEST-0",
    state,
    branchName: "symphony/TEST-0",
    description: agentEligibleIssueContract({
      issueContractContractVersion: "2026-07-14.source-artifact",
      issueContractDelivery: {
        mode: "accepted_artifact",
        artifact: "expected_red_tests",
      },
    }),
  });
}

function liveSeededTarget(source = sourceArtifactIssue()) {
  return issue({
    state: "In Progress",
    branchName: "symphony/TEST-1",
    blockedBy: [
      {
        id: source.id,
        identifier: source.identifier,
        state: source.state,
      },
    ],
  });
}

function completedAcceptedArtifact(): IssueAcceptedArtifactRecord {
  const parsedContract = parseIssueContract(sourceArtifactIssue().description);
  if (!parsedContract.valid) throw new Error("Source artifact test contract is invalid");
  return {
    version: 1,
    id: "accepted-artifact:source-issue-1:abc123",
    kind: "expected_red_tests",
    status: "completed_unmerged",
    sourceIssueId: "source-issue-1",
    sourceIssueIdentifier: "TEST-0",
    contractFingerprint: parsedContract.fingerprint,
    completionReportId: "completion-report:source-issue-1:run-source:report-source",
    reviewVerdictId: "review-verdict:source-issue-1:review-source:verdict-source",
    reviewFeedbackId: "review-feedback:source-issue-1:review-source:comment-source",
    repositoryFingerprint: "repo-fingerprint",
    pullRequest: {
      url: "https://github.com/acme/symphony/pull/41",
      number: 41,
      headSha: "source-head-sha",
      branch: "symphony/TEST-0",
      draft: true,
    },
    sourceBaseHeadSha: "source-base-sha",
    sourceHeadSha: "source-head-sha",
    baseRef: "main",
    changedFiles: ["tests/new-behavior.test.ts"],
    fileManifest: [
      {
        path: "tests/new-behavior.test.ts",
        status: "added",
        blobSha: "test-file-blob-sha",
      },
    ],
    artifactEvidence: expectedRedEvidence(),
    commentOperationKey: "comment:source-issue-1:accepted-artifact",
    doneTransitionOperationKey: "transition:source-issue-1:accepted-artifact:Done",
    acceptedAt: "2026-07-14T00:00:00.000Z",
    checkpointedAt: "2026-07-14T00:00:01.000Z",
    prClosedAt: "2026-07-14T00:00:02.000Z",
    completedAt: "2026-07-14T00:00:03.000Z",
  };
}

function preparedWorkspaceSeed(): IssueWorkspaceSeedRecord {
  return {
    version: 1,
    id: "workspace-seed:issue-1:accepted-artifact-source",
    kind: "accepted_artifact",
    status: "prepared",
    artifactId: completedAcceptedArtifact().id,
    sourceIssueId: "source-issue-1",
    sourceIssueIdentifier: "TEST-0",
    repositoryFingerprint: "repo-fingerprint",
    sourceBranch: "symphony/TEST-0",
    sourceHeadSha: "source-head-sha",
    sourceBaseHeadSha: "source-base-sha",
    configuredBaseRef: "main",
    preparedBaseHeadSha: "live-base-sha",
    preparedHeadSha: "prepared-target-head-sha",
    targetBranch: "symphony/TEST-1",
    conflictedFiles: [],
    plannedAt: "2026-07-14T00:01:00.000Z",
    preparedAt: "2026-07-14T00:01:01.000Z",
    failureReason: null,
  };
}

function passingDependencyArtifactResult(
  overrides: Partial<NonNullable<CompletionReportInput["dependencyArtifactResult"]>> = {},
): NonNullable<CompletionReportInput["dependencyArtifactResult"]> {
  return {
    artifactId: completedAcceptedArtifact().id,
    command: expectedRedEvidence().command,
    exitCode: 0,
    evidence: "Inherited expected-red suite passes after the implementation change.",
    ...overrides,
  };
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

async function createGitWorkspace(root: string): Promise<string> {
  const workspacePath = await mkdtemp(path.join(root, "git-workspace-"));
  await git(["init", "-b", "main"], workspacePath);
  await writeFile(path.join(workspacePath, "tracked.txt"), "initial\n", "utf8");
  await git(["add", "tracked.txt"], workspacePath);
  await git(["-c", "user.name=Symphony Test", "-c", "user.email=symphony@example.test", "commit", "-m", "initial"], workspacePath);
  return workspacePath;
}

function workspaceForGitFixture(workspacePath: string): NonNullable<CompletionReportActiveContext["workspace"]> {
  return {
    path: workspacePath,
    workspaceKey: "TEST-1",
    createdNow: false,
    issueId: "issue-1",
    issueIdentifier: "TEST-1",
    gitBranchName: "main",
    repoPath: workspacePath,
    baseRef: "main",
  };
}

async function git(args: string[], cwd: string): Promise<void> {
  await gitOutput(args, cwd);
}

function gitOutput(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    let stdout = "";
    const child = spawn("git", args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || `git ${args.join(" ")} failed with exit code ${code}`));
      }
    });
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

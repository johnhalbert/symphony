import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AcceptedArtifactService,
  type AcceptedArtifactGitHubClient,
} from "../src/core/AcceptedArtifactService.js";
import { SymphonyError } from "../src/core/errors.js";
import { parseIssueContractFromDescription } from "../src/core/IssueContractLint.js";
import { FileIssueLifecycleStore } from "../src/core/persistence/IssueLifecycleStore.js";
import type { PullRequestDetails } from "../src/integrations/github/GitHubPullRequestClient.js";
import { FileWritebackOutboxStore } from "../src/core/writeback/WritebackOutbox.js";
import { agentEligibleIssueContract, issue, testConfig } from "./helpers.js";

const BASE_SHA = "1".repeat(40);
const HEAD_SHA = "2".repeat(40);
const BLOB_SHA = "3".repeat(40);

describe("AcceptedArtifactService", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("checkpoints a reviewed expected-red artifact despite GitHub's provisional merge SHA", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-accepted-artifact-"));
    roots.push(root);
    const config = testConfig(root);
    config.writeback.enabled = true;
    config.reviewLoop.reviewStates = ["In Review"];
    config.workspace.source = {
      kind: "git_worktree",
      repository: "https://github.test/acme/symphony.git",
      baseRef: "main",
    };
    const sourceIssue = issue({
      state: "In Review",
      branchName: "symphony/TEST-1",
      blocks: [
        { id: "issue-2", identifier: "TEST-2", state: "Todo" },
      ],
      description: agentEligibleIssueContract({
        issueContractDelivery: { mode: "accepted_artifact", artifact: "expected_red_tests" },
      }),
    });
    const targetIssue = issue({
      id: "issue-2",
      identifier: "TEST-2",
      blockedBy: [
        { id: sourceIssue.id, identifier: sourceIssue.identifier, state: sourceIssue.state },
      ],
      description: agentEligibleIssueContract({
        issueContractRelationships: {
          blocks: [],
          blockedBy: ["TEST-1"],
          succession: {
            id: "test-expected-red-implementation",
            purpose: "expected_red_implementation",
            succeeds: { issue: "TEST-1" },
          },
        },
      }),
    });
    const contract = parseIssueContractFromDescription(sourceIssue.description);
    if (!contract) throw new Error("expected parsed Issue Contract");

    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    const outbox = new FileWritebackOutboxStore(config.workspace.stateDir);
    const report = {
      id: "completion-report-1",
      idempotencyKey: "completion-idem-1",
      runId: "worker-run-1",
      issueId: sourceIssue.id,
      issueIdentifier: sourceIssue.identifier,
      summary: "Added the expected-red tests.",
      validationEvidence: ["npm test exits 1 with the intended missing implementation assertion"],
      acceptanceChecklist: [{ text: "Tests express the contract", satisfied: true, evidence: "tests/feature.test.ts" }],
      changedFiles: ["tests/feature.test.ts"],
      branchName: "symphony/TEST-1",
      pullRequest: {
        url: "https://github.test/acme/symphony/pull/42",
        number: 42,
        headSha: HEAD_SHA,
        branch: "symphony/TEST-1",
        draft: true,
      },
      acceptanceContext: {
        version: 1 as const,
        capturedAt: "2026-07-14T01:00:00.000Z",
        runId: "worker-run-1",
        branchName: "symphony/TEST-1",
        baseRef: "main",
        baseHeadSha: BASE_SHA,
        worktreeHeadSha: HEAD_SHA,
        treeSha: "4".repeat(40),
        pullRequestHeadSha: HEAD_SHA,
        worktreeDirty: false,
        worktreeStatus: "clean" as const,
        unmergedFiles: [],
      },
      contractSnapshot: {
        schemaVersion: contract.schemaVersion,
        contractVersion: contract.contractVersion,
        fingerprint: contract.fingerprint,
        delivery: { mode: "accepted_artifact" as const, artifact: "expected_red_tests" as const },
      },
      artifactEvidence: {
        kind: "expected_red_tests" as const,
        command: "npm test -- tests/feature.test.ts",
        testFiles: ["tests/feature.test.ts"],
        expectedFailure: "implementation is not present",
        observedFailure: "expected enabled, received disabled",
        exitCode: 1,
      },
      dependencyArtifactResult: null,
      risks: [],
      acceptedAt: "2026-07-14T01:00:00.000Z",
      writebackOperationKeys: [],
    };
    const verdict = {
      id: "verdict-1",
      idempotencyKey: "verdict-idem-1",
      runId: "review-run-1",
      issueId: sourceIssue.id,
      issueIdentifier: sourceIssue.identifier,
      verdict: "pass" as const,
      passDisposition: "accepted_artifact" as const,
      acceptanceResults: [{ text: "Tests match the requirement", satisfied: true, evidence: "reviewed diff" }],
      findings: [],
      gateFindings: [],
      discoveryFindings: [],
      evidence: ["Reviewed expected-red assertion"],
      reviewer: "reviewer-1",
      submittedAt: "2026-07-14T02:00:00.000Z",
      writebackOperationKeys: [],
    };
    const feedback = {
      id: "feedback-1",
      idempotencyKey: "feedback-idem-1",
      requestHash: "request-hash-1",
      runId: "review-run-1",
      issueId: sourceIssue.id,
      issueIdentifier: sourceIssue.identifier,
      kind: "review" as const,
      event: "COMMENT" as const,
      body: "Expected-red artifact accepted.",
      pullRequest: report.pullRequest,
      reviewer: "reviewer-1",
      reviewUrl: "https://github.test/acme/symphony/pull/42#review-1",
      commentUrls: [],
      submittedAt: "2026-07-14T01:59:00.000Z",
    };
    await lifecycleStore.ensureIssue(sourceIssue, {
      phase: "passed",
      lastCompletionReportId: report.id,
      completionReports: [report],
      lastReviewVerdictId: verdict.id,
      reviewVerdicts: [verdict],
      reviewFeedback: [feedback],
    });

    const client = new FakeAcceptedArtifactGitHubClient();
    const service = new AcceptedArtifactService({
      config,
      lifecycleStore,
      writebackOutbox: outbox,
      client,
      resolveIssuesByIds: async (ids) =>
        [sourceIssue, targetIssue].filter(
          (candidate) =>
            ids.includes(candidate.id) || ids.includes(candidate.identifier),
        ),
      checkpointBuilder: {
        build: async (input) => {
          expect(input).toMatchObject({
            sourceBaseHeadSha: BASE_SHA,
            sourceHeadSha: HEAD_SHA,
            changedFiles: ["tests/feature.test.ts"],
          });
          return [{ path: "tests/feature.test.ts", status: "added", blobSha: BLOB_SHA }];
        },
      },
    });

    const completed = await service.completeAcceptedArtifact({ issue: sourceIssue, workspacePath: "/tmp/source" });

    expect(completed).toMatchObject({ status: "completed_unmerged", replayed: false, writebacksSettled: false });
    expect(client.closeCalls).toEqual([{ pullRequestNumber: 42, expectedHeadSha: HEAD_SHA }]);
    expect(completed.artifact).toMatchObject({
      status: "completed_unmerged",
      completionReportId: report.id,
      reviewVerdictId: verdict.id,
      reviewFeedbackId: feedback.id,
      successionId: "test-expected-red-implementation",
      sourceBaseHeadSha: BASE_SHA,
      sourceHeadSha: HEAD_SHA,
      fileManifest: [{ path: "tests/feature.test.ts", status: "added", blobSha: BLOB_SHA }],
      prClosedAt: expect.any(String),
      completedAt: expect.any(String),
    });
    expect(completed.writebackOperations).toHaveLength(2);
    expect(completed.writebackOperations.map((operation) => operation.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ acceptedArtifactId: completed.artifact.id }),
        expect.objectContaining({ acceptedArtifactId: completed.artifact.id, fromStates: ["In Review"], toState: "Done" }),
      ]),
    );
    await expect(lifecycleStore.get(sourceIssue.id)).resolves.toMatchObject({
      succession: {
        id: "test-expected-red-implementation",
        role: "succeeded",
        status: "checkpointed",
        artifactId: completed.artifact.id,
        workspaceSeedId: null,
      },
    });
    await expect(lifecycleStore.get(targetIssue.id)).resolves.toMatchObject({
      succession: {
        id: "test-expected-red-implementation",
        role: "successor",
        status: "checkpointed",
        artifactId: completed.artifact.id,
        workspaceSeedId: null,
      },
    });

    const replayed = await service.completeAcceptedArtifact({ issue: sourceIssue, workspacePath: null });
    expect(replayed.replayed).toBe(true);
    expect(replayed.artifact.id).toBe(completed.artifact.id);
    expect(client.closeCalls).toHaveLength(1);
    expect(await outbox.list()).toHaveLength(2);
    await expect(lifecycleStore.get(sourceIssue.id)).resolves.toMatchObject({
      succession: {
        status: "checkpointed",
        artifactId: completed.artifact.id,
      },
    });
    await expect(lifecycleStore.get(targetIssue.id)).resolves.toMatchObject({
      succession: {
        status: "checkpointed",
        artifactId: completed.artifact.id,
      },
    });

    client.setBranchFailure(new SymphonyError("not_found", "GitHub branch head lookup returned HTTP 404"));
    await expect(service.completeAcceptedArtifact({ issue: sourceIssue, workspacePath: null })).rejects.toMatchObject({
      category: "contract_or_head_drift",
      reason: "pull_request_or_branch_drift",
    });

    client.setBranchFailure(new SymphonyError("invalid_request", "GitHub PR inspection returned HTTP 401"));
    await expect(service.completeAcceptedArtifact({ issue: sourceIssue, workspacePath: null })).rejects.toMatchObject({
      category: "permanent_github_access_or_configuration",
      reason: "github_access_or_configuration",
    });

    client.setBranchFailure(new SymphonyError("tracker_error", "GitHub PR inspection returned HTTP 503"));
    await expect(service.completeAcceptedArtifact({ issue: sourceIssue, workspacePath: null })).rejects.toMatchObject({
      category: "transient",
      reason: "github_or_tracker_failure",
    });
    client.setBranchFailure(null);

    await lifecycleStore.updateIssue(sourceIssue, {
      acceptedArtifact: {
        ...completed.artifact,
        supersededAt: "2026-07-14T02:30:00.000Z",
        supersededBy: "fresh-review",
        supersededReason: "reviewed evidence drifted",
      },
    });
    client.reopen();
    const replaced = await service.completeAcceptedArtifact({
      issue: sourceIssue,
      workspacePath: "/tmp/source",
    });
    expect(replaced.replayed).toBe(false);
    expect(replaced.artifact).not.toHaveProperty("supersededAt");

    client.markMerged();
    await expect(service.completeAcceptedArtifact({ issue: sourceIssue, workspacePath: null })).rejects.toMatchObject({
      category: "unexpected_merged_or_irrecoverable_checkpoint",
      reason: "unexpected_merged_pull_request",
    });
  });

  it("fails closed when the current Issue Contract drifts after review", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-accepted-artifact-drift-"));
    roots.push(root);
    const config = testConfig(root);
    config.writeback.enabled = true;
    config.reviewLoop.reviewStates = ["In Review"];
    config.workspace.source = { kind: "git_worktree", repository: "repo", baseRef: "main" };
    const reviewedDescription = agentEligibleIssueContract({
      issueContractDelivery: { mode: "accepted_artifact", artifact: "expected_red_tests" },
    });
    const reviewed = parseIssueContractFromDescription(reviewedDescription);
    if (!reviewed) throw new Error("expected parsed Issue Contract");
    const changedIssue = issue({
      state: "In Review",
      description: agentEligibleIssueContract({ issueContractDelivery: { mode: "merge" } }),
    });
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    await lifecycleStore.ensureIssue(changedIssue, {
      phase: "passed",
      lastCompletionReportId: "report-1",
      completionReports: [
        {
          id: "report-1",
          idempotencyKey: "report-idem-1",
          runId: "run-1",
          issueId: changedIssue.id,
          issueIdentifier: changedIssue.identifier,
          summary: "Expected red tests",
          validationEvidence: ["red"],
          acceptanceChecklist: [{ text: "tests", satisfied: true, evidence: "tests" }],
          changedFiles: ["tests/feature.test.ts"],
          branchName: "branch",
          pullRequest: { url: null, number: 42, headSha: HEAD_SHA, branch: "branch", draft: true },
          contractSnapshot: {
            schemaVersion: reviewed.schemaVersion,
            contractVersion: reviewed.contractVersion,
            fingerprint: reviewed.fingerprint,
            delivery: { mode: "accepted_artifact", artifact: "expected_red_tests" },
          },
          artifactEvidence: {
            kind: "expected_red_tests",
            command: "npm test",
            testFiles: ["tests/feature.test.ts"],
            expectedFailure: "red",
            observedFailure: "red",
            exitCode: 1,
          },
          risks: [],
          acceptedAt: "2026-07-14T01:00:00.000Z",
          writebackOperationKeys: [],
        },
      ],
    });
    const service = new AcceptedArtifactService({
      config,
      lifecycleStore,
      writebackOutbox: new FileWritebackOutboxStore(config.workspace.stateDir),
      client: new FakeAcceptedArtifactGitHubClient(),
      resolveIssuesByIds: async (ids) =>
        ids.includes(changedIssue.id) ||
        ids.includes(changedIssue.identifier)
          ? [changedIssue]
          : [],
    });

    await expect(
      service.completeAcceptedArtifact({
        issue: changedIssue,
        workspacePath: "/tmp/source",
      }),
    ).rejects.toMatchObject({
      category: "contract_or_head_drift",
      reason: "contract_or_review_drift",
      message: expect.stringMatching(
        /no longer declares expected-red accepted-artifact delivery/,
      ),
    });
  });
});

class FakeAcceptedArtifactGitHubClient implements AcceptedArtifactGitHubClient {
  readonly closeCalls: Array<{ pullRequestNumber: number; expectedHeadSha: string }> = [];
  private state: "open" | "closed" = "open";
  private merged = false;
  private branchFailure: SymphonyError | null = null;

  markMerged(): void {
    this.state = "closed";
    this.merged = true;
  }

  reopen(): void {
    this.state = "open";
    this.merged = false;
  }

  setBranchFailure(error: SymphonyError | null): void {
    this.branchFailure = error;
  }

  async getPullRequest(): Promise<PullRequestDetails> {
    return {
      url: "https://github.test/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: HEAD_SHA,
      lastPushedAt: "2026-07-14T01:00:00.000Z",
      draft: true,
      state: this.state,
      merged: this.merged,
      mergeCommitSha: "5".repeat(40),
      mergedAt: this.merged ? "2026-07-14T03:00:00.000Z" : null,
      mergedBy: null,
      mergeable: null,
      mergeableState: "unknown",
      baseBranch: "main",
      baseHeadSha: BASE_SHA,
    };
  }

  async getBranchHeadSha(): Promise<string> {
    if (this.branchFailure) throw this.branchFailure;
    return HEAD_SHA;
  }

  async closePullRequest(input: { pullRequestNumber: number; expectedHeadSha: string }) {
    this.closeCalls.push(input);
    this.state = "closed";
    return { pullRequestNumber: input.pullRequestNumber, headSha: input.expectedHeadSha, state: "closed" as const, merged: false as const };
  }
}

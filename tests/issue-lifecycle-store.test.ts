import { promises as nodeFs } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseRefObservationInputFingerprint } from "../src/core/BaseRefVerification.js";
import { SymphonyError } from "../src/core/errors.js";
import {
  blockerProvenanceMatchesObservation,
  createBaseRefBlockerProvenance,
  createReviewFeedbackBaseRefProvenance,
} from "../src/core/BlockerProvenance.js";
import {
  buildWorkerHandoffPacket,
  FileIssueLifecycleStore,
  latestCurrentApprovalPassVerdict,
  latestCurrentCompletionReport,
  phaseForIssueState,
} from "../src/core/persistence/IssueLifecycleStore.js";
import { issue, testConfig } from "./helpers.js";

describe("FileIssueLifecycleStore", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-lifecycle-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("persists lifecycle records across store instances", async () => {
    const store = new FileIssueLifecycleStore(root);
    const first = await store.ensureIssue(issue(), {
      phase: "review",
      reviewRound: 2,
      incompleteTurnCount: 1,
      lastCompletionReportId: "report-1",
      summaryPointers: {
        workspaceKey: "TEST-1",
        workspacePath: "/tmp/TEST-1",
        branchName: "symphony/TEST-1",
        gitBranchName: "symphony/TEST-1",
        repoPath: "/repo",
        baseRef: "origin/main",
        lastRunId: "run-1",
        prUrl: "https://github.com/acme/repo/pull/7",
        prNumber: 7,
        ciStatus: "pending",
        lastPushedAt: "2026-01-01T00:00:00.000Z",
      },
      summaryReferences: [
        {
          id: "continuation-summary:issue-1:run-1",
          kind: "continuation_history",
          summary: "The worker inspected the issue and started implementation.",
          runIds: ["run-1"],
          transcriptEventCount: 3,
          transcriptPointers: ["/api/v1/runs/run-1/transcript"],
          statusApiPointers: ["/api/v1/issues/TEST-1"],
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const reloaded = new FileIssueLifecycleStore(root);
    const found = await reloaded.get("TEST-1");

    expect(first.createdAt).toBe(found?.createdAt);
    expect(found).toMatchObject({
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      phase: "review",
      reviewRound: 2,
      incompleteTurnCount: 1,
      lastCompletionReportId: "report-1",
      lastReviewVerdictId: null,
      blockedReason: null,
      completionReports: [],
      summaryReferences: [
        {
          id: "continuation-summary:issue-1:run-1",
          summary: "The worker inspected the issue and started implementation.",
          transcriptPointers: ["/api/v1/runs/run-1/transcript"],
          statusApiPointers: ["/api/v1/issues/TEST-1"],
        },
      ],
      summaryPointers: {
        workspaceKey: "TEST-1",
        workspacePath: "/tmp/TEST-1",
        branchName: "symphony/TEST-1",
        gitBranchName: "symphony/TEST-1",
        repoPath: "/repo",
        baseRef: "origin/main",
        lastRunId: "run-1",
        prUrl: "https://github.com/acme/repo/pull/7",
        prNumber: 7,
        ciStatus: "pending",
        lastPushedAt: "2026-01-01T00:00:00.000Z",
      },
    });
  });

  it("defaults missing review verdict submissions for legacy lifecycle records", async () => {
    const store = new FileIssueLifecycleStore(root);
    await store.ensureIssue(issue(), { phase: "review" });
    const recordPath = path.join(root, "issue-lifecycle", "issue-1.json");
    const raw = JSON.parse(await nodeFs.readFile(recordPath, "utf8")) as Record<string, unknown>;
    delete raw.reviewVerdictSubmissions;
    delete raw.acceptedArtifact;
    delete raw.acceptedArtifactValidationFailure;
    delete raw.workspaceSeed;
    await writeFile(recordPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

    const reloaded = new FileIssueLifecycleStore(root);

    await expect(reloaded.get("issue-1")).resolves.toMatchObject({
      reviewVerdictSubmissions: [],
      acceptedArtifact: null,
      acceptedArtifactValidationFailure: null,
      workspaceSeed: null,
    });
  });

  it("persists accepted-artifact validation failure accounting", async () => {
    const store = new FileIssueLifecycleStore(root);
    await store.ensureIssue(issue(), {
      acceptedArtifactValidationFailure: {
        version: 1,
        count: 2,
        limit: 3,
        category: "contract_or_head_drift",
        reason: "contract_or_review_drift",
        signature: "failure-signature",
        message: "Current Issue Contract changed after review",
        firstFailedAt: "2026-07-22T10:00:00.000Z",
        lastFailedAt: "2026-07-22T11:00:00.000Z",
        completionReportId: "report-2",
        reviewVerdictId: "verdict-2",
        liveContractFingerprint: "live-contract",
        reviewedContractFingerprint: "reviewed-contract",
        sourceHeadSha: "2".repeat(40),
      },
    });

    const found = await new FileIssueLifecycleStore(root).get("TEST-1");

    expect(found?.acceptedArtifactValidationFailure).toEqual({
      version: 1,
      count: 2,
      limit: 3,
      category: "contract_or_head_drift",
      reason: "contract_or_review_drift",
      signature: "failure-signature",
      message: "Current Issue Contract changed after review",
      firstFailedAt: "2026-07-22T10:00:00.000Z",
      lastFailedAt: "2026-07-22T11:00:00.000Z",
      completionReportId: "report-2",
      reviewVerdictId: "verdict-2",
      liveContractFingerprint: "live-contract",
      reviewedContractFingerprint: "reviewed-contract",
      sourceHeadSha: "2".repeat(40),
    });
    expect(found?.handoff.memo.entries).toContain(
      "Accepted-artifact validation failures: 2/3; latest contract_or_review_drift: Current Issue Contract changed after review",
    );
  });

  it("persists the generalized relationship graph separately from a bilateral succession record", async () => {
    const store = new FileIssueLifecycleStore(root);
    await store.ensureIssue(issue(), {
      relationshipState: {
        version: 1,
        issueId: "issue-1",
        issueIdentifier: "TEST-1",
        contractSchemaVersion: 2,
        contractFingerprint: "source-contract",
        contractBlocks: ["TEST-2", "TEST-9"],
        contractBlockedBy: [],
        trackerBlocks: [
          { id: "issue-2", identifier: "TEST-2", state: "Todo" },
          { id: "issue-9", identifier: "TEST-9", state: "Todo" },
        ],
        trackerBlockedBy: [],
        edges: [
          {
            type: "blocks",
            sourceIssueId: "issue-1",
            sourceIssueIdentifier: "TEST-1",
            targetIssueId: "issue-2",
            targetIssueIdentifier: "TEST-2",
            declared: true,
            observed: true,
          },
          {
            type: "blocks",
            sourceIssueId: "issue-1",
            sourceIssueIdentifier: "TEST-1",
            targetIssueId: "issue-9",
            targetIssueIdentifier: "TEST-9",
            declared: true,
            observed: true,
          },
        ],
        status: "valid",
        validationErrors: [],
        observedAt: "2026-07-23T10:00:00.000Z",
      },
      succession: {
        version: 1,
        id: "tdd-test-1",
        purpose: "expected_red_implementation",
        role: "succeeded",
        succeededIssue: {
          id: "issue-1",
          identifier: "TEST-1",
          contractFingerprint: "source-contract",
        },
        successorIssue: {
          id: "issue-2",
          identifier: "TEST-2",
          contractFingerprint: "target-contract",
        },
        linearBlockVerified: true,
        status: "agreed",
        artifactId: null,
        workspaceSeedId: null,
        mergeCommitSha: null,
        validationErrors: [],
        declaredAt: "2026-07-23T10:00:00.000Z",
        agreedAt: "2026-07-23T10:00:00.000Z",
        updatedAt: "2026-07-23T10:00:00.000Z",
      },
    });

    const found = await new FileIssueLifecycleStore(root).get("TEST-1");

    expect(found?.relationshipState?.edges).toHaveLength(2);
    expect(found?.relationshipState?.contractBlocks).toEqual(["TEST-2", "TEST-9"]);
    expect(found?.succession).toMatchObject({
      id: "tdd-test-1",
      succeededIssue: { identifier: "TEST-1" },
      successorIssue: { identifier: "TEST-2" },
    });
    expect(found?.succession?.successorIssue.identifier).not.toBe("TEST-9");
  });

  it("persists accepted-artifact contracts, evidence, disposition, and workspace seed state", async () => {
    const store = new FileIssueLifecycleStore(root);
    const contractSnapshot = {
      schemaVersion: 1,
      contractVersion: "2026-07-14",
      fingerprint: "contract-fingerprint",
      delivery: {
        mode: "accepted_artifact" as const,
        artifact: "expected_red_tests" as const,
      },
    };
    const artifactEvidence = {
      kind: "expected_red_tests" as const,
      command: "npm test -- implementation.test.ts",
      testFiles: ["tests/implementation.test.ts"],
      expectedFailure: "The implementation is not present yet.",
      observedFailure: "Expected true, received false.",
      exitCode: 1,
    };
    const dependencyArtifactResult = {
      artifactId: "artifact-1",
      command: "npm test -- implementation.test.ts",
      exitCode: 0,
      evidence: "The dependency implementation satisfies the accepted tests.",
    };
    const pullRequest = {
      url: "https://github.com/acme/repo/pull/7",
      number: 7,
      headSha: "source-head-sha",
      branch: "symphony/TEST-1",
      draft: true,
    };
    await store.ensureIssue(issue(), {
      phase: "terminal",
      lastCompletionReportId: "report-1",
      lastCompletionReportRejectionId: "rejection-1",
      lastReviewVerdictId: "verdict-1",
      completionReports: [
        {
          id: "report-1",
          idempotencyKey: "report-key-1",
          runId: "worker-run-1",
          issueId: "issue-1",
          issueIdentifier: "TEST-1",
          summary: "Added the expected-red tests.",
          validationEvidence: ["The targeted test fails for the expected reason."],
          acceptanceChecklist: [],
          changedFiles: ["tests/implementation.test.ts"],
          branchName: "symphony/TEST-1",
          pullRequest,
          contractSnapshot,
          artifactEvidence,
          dependencyArtifactResult,
          risks: [],
          acceptedAt: "2026-07-14T10:00:00.000Z",
          writebackOperationKeys: [],
        },
      ],
      completionReportRejections: [
        {
          id: "rejection-1",
          reportId: "rejected-report-1",
          idempotencyKey: "rejection-key-1",
          runId: "worker-run-0",
          issueId: "issue-1",
          issueIdentifier: "TEST-1",
          reasonCode: "unsatisfied_acceptance_checklist",
          reason: "Expected-red evidence was incomplete.",
          summary: "First report omitted the observed failure.",
          validationEvidence: [],
          acceptanceChecklist: [],
          changedFiles: ["tests/implementation.test.ts"],
          branchName: "symphony/TEST-1",
          pullRequest,
          contractSnapshot,
          artifactEvidence,
          dependencyArtifactResult,
          risks: [],
          rejectedAt: "2026-07-14T09:00:00.000Z",
          writebackOperationKeys: [],
        },
      ],
      reviewVerdicts: [
        {
          id: "verdict-1",
          idempotencyKey: "verdict-key-1",
          runId: "review-run-1",
          issueId: "issue-1",
          issueIdentifier: "TEST-1",
          verdict: "pass",
          passDisposition: "accepted_artifact",
          acceptanceResults: [],
          findings: [],
          gateFindings: [],
          discoveryFindings: [],
          evidence: ["Expected-red failure matches the contract."],
          reviewer: "reviewer",
          submittedAt: "2026-07-14T10:05:00.000Z",
          writebackOperationKeys: [],
        },
      ],
      reviewVerdictSubmissions: [
        {
          id: "submission-1",
          idempotencyKey: "submission-key-1",
          runId: "review-run-1",
          issueId: "issue-1",
          issueIdentifier: "TEST-1",
          verdict: "pass",
          passDisposition: "accepted_artifact",
          acceptanceResults: [],
          findings: [],
          gateFindings: [],
          discoveryFindings: [],
          evidence: ["Expected-red failure matches the contract."],
          reviewer: "reviewer",
          submittedAt: "2026-07-14T10:05:00.000Z",
          status: "applied",
          ignoreStateGate: false,
          acceptedVerdictId: "verdict-1",
          appliedAt: "2026-07-14T10:05:01.000Z",
          supersededAt: null,
          supersededReason: null,
        },
      ],
      reviewFeedback: [
        {
          id: "feedback-1",
          idempotencyKey: "feedback-key-1",
          requestHash: "feedback-request-hash",
          runId: "review-run-1",
          issueId: "issue-1",
          issueIdentifier: "TEST-1",
          kind: "review",
          event: "APPROVE",
          body: "Expected-red artifact approved.",
          pullRequest,
          reviewer: "reviewer",
          reviewUrl: "https://github.com/acme/repo/pull/7#pullrequestreview-1",
          commentUrls: [],
          submittedAt: "2026-07-14T10:05:30.000Z",
        },
      ],
      acceptedArtifact: {
        version: 1,
        id: "artifact-1",
        kind: "expected_red_tests",
        status: "completed_unmerged",
        sourceIssueId: "issue-1",
        sourceIssueIdentifier: "TEST-1",
        contractFingerprint: "contract-fingerprint",
        completionReportId: "report-1",
        reviewVerdictId: "verdict-1",
        reviewFeedbackId: "feedback-1",
        repositoryFingerprint: "repository-fingerprint",
        pullRequest,
        sourceBaseHeadSha: "source-base-sha",
        sourceHeadSha: "source-head-sha",
        baseRef: "origin/main",
        changedFiles: ["tests/implementation.test.ts"],
        fileManifest: [
          {
            path: "tests/implementation.test.ts",
            status: "added",
            blobSha: "blob-sha",
            mode: "100644",
          },
        ],
        artifactEvidence,
        commentOperationKey: "comment:artifact-1",
        doneTransitionOperationKey: "transition:artifact-1:done",
        acceptedAt: "2026-07-14T10:05:00.000Z",
        checkpointedAt: "2026-07-14T10:06:00.000Z",
        prClosedAt: "2026-07-14T10:07:00.000Z",
        completedAt: "2026-07-14T10:08:00.000Z",
      },
      workspaceSeed: {
        version: 1,
        id: "workspace-seed-1",
        kind: "accepted_artifact",
        status: "prepared",
        artifactId: "artifact-1",
        sourceIssueId: "issue-1",
        sourceIssueIdentifier: "TEST-1",
        repositoryFingerprint: "repository-fingerprint",
        sourceBranch: "symphony/TEST-1",
        sourceHeadSha: "source-head-sha",
        sourceBaseHeadSha: "source-base-sha",
        configuredBaseRef: "origin/main",
        preparedBaseHeadSha: "live-base-sha",
        preparedHeadSha: "prepared-head-sha",
        targetBranch: "symphony/TEST-2",
        conflictedFiles: [],
        absorbedPaths: ["tests/implementation.test.ts"],
        plannedAt: "2026-07-14T10:09:00.000Z",
        preparedAt: "2026-07-14T10:10:00.000Z",
        failureReason: null,
      },
    });

    const found = await new FileIssueLifecycleStore(root).get("TEST-1");

    expect(found?.completionReports[0]).toMatchObject({
      contractSnapshot,
      artifactEvidence,
      dependencyArtifactResult,
    });
    expect(found?.completionReportRejections[0]).toMatchObject({
      contractSnapshot,
      artifactEvidence,
      dependencyArtifactResult,
    });
    expect(found?.reviewVerdicts[0]).toMatchObject({ passDisposition: "accepted_artifact" });
    expect(found?.reviewVerdictSubmissions?.[0]).toMatchObject({ passDisposition: "accepted_artifact" });
    expect(found?.completionReports[0]?.pullRequest).toMatchObject({ draft: true });
    expect(found?.reviewFeedback[0]?.pullRequest).toMatchObject({ draft: true });
    expect(found?.acceptedArtifact).toMatchObject({
      id: "artifact-1",
      status: "completed_unmerged",
      fileManifest: [
        {
          path: "tests/implementation.test.ts",
          blobSha: "blob-sha",
          mode: "100644",
        },
      ],
    });
    expect(found?.workspaceSeed).toMatchObject({
      id: "workspace-seed-1",
      status: "prepared",
      preparedHeadSha: "prepared-head-sha",
      absorbedPaths: ["tests/implementation.test.ts"],
    });
  });

  it("does not project an accepted-artifact COMMENT verdict as merge approval", async () => {
    const store = new FileIssueLifecycleStore(root);
    const pullRequest = {
      url: "https://github.com/acme/repo/pull/7",
      number: 7,
      headSha: "source-head-sha",
      branch: "symphony/TEST-1",
      draft: true,
    };
    const record = await store.ensureIssue(issue(), {
      lastCompletionReportId: "report-1",
      completionReports: [
        {
          id: "report-1",
          idempotencyKey: "report-key-1",
          runId: "worker-run-1",
          issueId: "issue-1",
          issueIdentifier: "TEST-1",
          summary: "Added expected-red tests.",
          validationEvidence: ["The tests fail for the expected reason."],
          acceptanceChecklist: [],
          changedFiles: ["tests/implementation.test.ts"],
          branchName: "symphony/TEST-1",
          pullRequest,
          risks: [],
          acceptedAt: "2026-07-14T10:00:00.000Z",
          writebackOperationKeys: [],
        },
      ],
      reviewVerdicts: [
        {
          id: "verdict-1",
          idempotencyKey: "verdict-key-1",
          runId: "review-run-1",
          issueId: "issue-1",
          issueIdentifier: "TEST-1",
          verdict: "pass",
          passDisposition: "accepted_artifact",
          acceptanceResults: [],
          findings: [],
          gateFindings: [],
          discoveryFindings: [],
          evidence: ["Expected-red artifact accepted."],
          reviewer: "reviewer",
          submittedAt: "2026-07-14T10:05:00.000Z",
          writebackOperationKeys: [],
        },
      ],
      reviewFeedback: [
        {
          id: "feedback-1",
          idempotencyKey: "feedback-key-1",
          requestHash: "feedback-request-hash",
          runId: "review-run-1",
          issueId: "issue-1",
          issueIdentifier: "TEST-1",
          kind: "review",
          event: "COMMENT",
          body: "Expected-red artifact accepted.",
          pullRequest,
          reviewer: "reviewer",
          reviewUrl: "https://github.com/acme/repo/pull/7#pullrequestreview-1",
          commentUrls: [],
          submittedAt: "2026-07-14T10:05:30.000Z",
        },
      ],
    });

    expect(latestCurrentApprovalPassVerdict(record)).toBeNull();
  });

  it("persists accepted-artifact report supersession and never resurrects stale completion evidence", async () => {
    const store = new FileIssueLifecycleStore(root);
    const report = {
      id: "report-accepted-artifact",
      idempotencyKey: "report-accepted-artifact",
      runId: "worker-run-1",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      summary: "Added expected-red tests.",
      validationEvidence: ["The tests fail for the expected reason."],
      acceptanceChecklist: [],
      changedFiles: ["tests/implementation.test.ts"],
      branchName: "symphony/TEST-1",
      pullRequest: {
        url: "https://github.com/acme/repo/pull/7",
        number: 7,
        headSha: "source-head-sha",
        branch: "symphony/TEST-1",
        draft: true,
      },
      contractSnapshot: {
        schemaVersion: 1,
        contractVersion: "2026-07-14",
        fingerprint: "contract-fingerprint",
        delivery: {
          mode: "accepted_artifact" as const,
          artifact: "expected_red_tests" as const,
        },
      },
      risks: [],
      acceptedAt: "2026-07-14T10:00:00.000Z",
      writebackOperationKeys: [],
      supersededAt: "2026-07-14T11:00:00.000Z",
      supersededBy: "accepted_artifact_reopened",
      supersededReason: "The accepted artifact source checkpoint changed.",
    };
    await store.ensureIssue(issue(), {
      phase: "implementation",
      lastCompletionReportId: report.id,
      completionReports: [report],
    });

    const reloaded = await new FileIssueLifecycleStore(root).get("TEST-1");

    expect(reloaded?.completionReports[0]).toMatchObject({
      id: report.id,
      supersededAt: "2026-07-14T11:00:00.000Z",
      supersededBy: "accepted_artifact_reopened",
      supersededReason: "The accepted artifact source checkpoint changed.",
    });
    expect(latestCurrentCompletionReport(reloaded!)).toBeNull();

    const withoutCurrentPointer = await store.updateIssue(issue(), {
      lastCompletionReportId: null,
    });
    expect(withoutCurrentPointer.completionReports).toHaveLength(1);
    expect(latestCurrentCompletionReport(withoutCurrentPointer)).toBeNull();
  });


  it("tracks projection revisions for successful lifecycle writes only", async () => {
    const store = new FileIssueLifecycleStore(root);
    const events: Array<{ source: string; revision: number }> = [];
    store.onProjectionChanged(() => {
      throw new Error("listener failure must not affect durable writes");
    });
    const unsubscribe = store.onProjectionChanged((event) => events.push(event));

    expect(store.projectionRevision()).toBe(0);
    await expect(store.get("TEST-404")).resolves.toBeNull();
    await expect(store.list()).resolves.toEqual([]);
    expect(store.projectionRevision()).toBe(0);
    expect(events).toEqual([]);

    await store.ensureIssue(issue(), { phase: "review" });
    await store.updateIssue(issue(), { incompleteTurnCount: 1 });

    expect(store.projectionRevision()).toBe(2);
    expect(events).toEqual([
      { source: "lifecycle", revision: 1 },
      { source: "lifecycle", revision: 2 },
    ]);

    await expect(store.get("issue-1")).resolves.toMatchObject({ issueIdentifier: "TEST-1" });
    await expect(store.list()).resolves.toHaveLength(1);
    expect(store.projectionRevision()).toBe(2);
    expect(events).toHaveLength(2);

    unsubscribe();
    await store.ensureIssue(issue(), { phase: "blocked", blockedReason: "operator" });
    expect(store.projectionRevision()).toBe(3);
    expect(events).toHaveLength(2);
  });

  it("does not advance projection revisions when lifecycle writes fail", async () => {
    const store = new FileIssueLifecycleStore(root);
    const events: Array<{ source: string; revision: number }> = [];
    store.onProjectionChanged((event) => events.push(event));
    vi.spyOn(nodeFs, "writeFile").mockRejectedValueOnce(new Error("lifecycle disk full"));

    await expect(store.ensureIssue(issue())).rejects.toThrow("lifecycle disk full");
    expect(store.projectionRevision()).toBe(0);
    expect(events).toEqual([]);
  });

  it("returns null for missing lifecycle records", async () => {
    const store = new FileIssueLifecycleStore(root);
    await expect(store.get("TEST-404")).resolves.toBeNull();
  });

  it("persists merge metadata for status API consumers", async () => {
    const store = new FileIssueLifecycleStore(root);
    await store.ensureIssue(issue(), {
      merge: {
        id: "merge:issue-1:head-sha-1",
        pullRequest: {
          url: "https://github.com/acme/repo/pull/7",
          number: 7,
          headSha: "head-sha-1",
          branch: "symphony/TEST-1",
        },
        headSha: "head-sha-1",
        mergeCommitSha: "merge-sha-1",
        mergedAt: "2026-01-01T00:00:00.000Z",
        mergedBy: {
          login: "symphony-bot",
          profile: "github-merge",
          capability: "github.merge",
        },
        checkStatus: {
          requiredChecks: ["test"],
          passedChecks: ["test"],
          noCiEvidence: null,
        },
        mergeOperationKey: "github-merge:issue-1:7:head-sha-1",
        doneTransitionOperationKey: "transition:issue-1:merge:issue-1:head-sha-1:Done",
      },
    });

    await expect(store.get("issue-1")).resolves.toMatchObject({
      merge: {
        mergeCommitSha: "merge-sha-1",
        mergedBy: { capability: "github.merge", profile: "github-merge" },
        doneTransitionOperationKey: "transition:issue-1:merge:issue-1:head-sha-1:Done",
      },
    });
  });

  it("generates deterministic handoff contracts and memo from stored lifecycle evidence", async () => {
    const store = new FileIssueLifecycleStore(root);
    const record = await store.ensureIssue(issue(), {
      phase: "implementation",
      reviewRound: 1,
      lastCompletionReportId: "report-1",
      lastReviewVerdictId: "verdict-1",
      completionReports: [
        {
          id: "report-1",
          idempotencyKey: "report-key",
          runId: "worker-run-1",
          issueId: "issue-1",
          issueIdentifier: "TEST-1",
          summary: "Implemented the bounded context policy.",
          validationEvidence: ["npm test -- workflow"],
          acceptanceChecklist: [{ text: "Context is bounded", satisfied: true, evidence: "config test" }],
          changedFiles: ["src/core/config/Config.ts"],
          branchName: "symphony/TEST-1",
          pullRequest: { url: "https://github.com/acme/repo/pull/7", number: 7, headSha: "abc", branch: "symphony/TEST-1" },
          risks: ["None"],
          acceptedAt: "2026-01-01T00:00:00.000Z",
          writebackOperationKeys: ["op-1"],
        },
      ],
      reviewVerdicts: [
        {
          id: "verdict-1",
          idempotencyKey: "verdict-key",
          runId: "reviewer-run-1",
          issueId: "issue-1",
          issueIdentifier: "TEST-1",
          verdict: "fail",
          acceptanceResults: [{ text: "Add doctor coverage", satisfied: false, evidence: "missing test" }],
          findings: ["Add doctor coverage for unsafe setting sources."],
          gateFindings: [],
          discoveryFindings: [],
          evidence: ["tests/doctor.test.ts"],
          reviewer: "agent:run",
          submittedAt: "2026-01-01T00:01:00.000Z",
          writebackOperationKeys: ["op-2"],
        },
      ],
    });

    expect(record.handoff.lastWorkerOutput).toMatchObject({
      version: 1,
      reportId: "report-1",
      runId: "worker-run-1",
      summary: "Implemented the bounded context policy.",
    });
    expect(record.handoff.lastReviewerOutput).toMatchObject({
      version: 1,
      verdictId: "verdict-1",
      verdict: "fail",
      findings: ["Add doctor coverage for unsafe setting sources."],
    });
    expect(record.handoff.memo).toMatchObject({
      version: 1,
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      reviewRound: 1,
      sizeChars: expect.any(Number),
      openFindings: ["Add doctor coverage for unsafe setting sources."],
      lastWorkerRunId: "worker-run-1",
      lastReviewerRunId: "reviewer-run-1",
    });
    expect(buildWorkerHandoffPacket(record, "2026-01-01T00:02:00.000Z")).toMatchObject({
      version: 1,
      generatedAt: "2026-01-01T00:02:00.000Z",
      lastWorkerOutput: { reportId: "report-1" },
      lastReviewerOutput: { verdictId: "verdict-1" },
    });
  });

  it("surfaces corrupt lifecycle records", async () => {
    await mkdir(path.join(root, "issue-lifecycle"), { recursive: true });
    await writeFile(path.join(root, "issue-lifecycle", "issue-1.json"), "{nope", "utf8");
    const store = new FileIssueLifecycleStore(root);

    await expect(store.get("issue-1")).rejects.toBeInstanceOf(SymphonyError);
  });

  it("rejects invalid accepted-artifact lifecycle enums", async () => {
    const store = new FileIssueLifecycleStore(root);
    await store.ensureIssue(issue());
    const recordPath = path.join(root, "issue-lifecycle", "issue-1.json");
    const raw = JSON.parse(await nodeFs.readFile(recordPath, "utf8")) as Record<string, unknown>;
    raw.acceptedArtifact = {
      version: 1,
      kind: "expected_red_tests",
      status: "merged",
    };
    await writeFile(recordPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

    await expect(store.get("issue-1")).rejects.toMatchObject({
      code: "lifecycle_store_corrupt",
    });
  });

  it("rejects invalid accepted-artifact validation failure state", async () => {
    const store = new FileIssueLifecycleStore(root);
    await store.ensureIssue(issue());
    const recordPath = path.join(root, "issue-lifecycle", "issue-1.json");
    const raw = JSON.parse(
      await nodeFs.readFile(recordPath, "utf8"),
    ) as Record<string, unknown>;
    raw.acceptedArtifactValidationFailure = {
      version: 1,
      count: 0,
      limit: 3,
      category: "contract_or_head_drift",
      reason: "contract_or_review_drift",
      signature: "failure-signature",
      message: "invalid count",
      firstFailedAt: "2026-07-22T10:00:00.000Z",
      lastFailedAt: "2026-07-22T10:00:00.000Z",
      completionReportId: null,
      reviewVerdictId: null,
      liveContractFingerprint: "live-contract",
      reviewedContractFingerprint: null,
      sourceHeadSha: null,
    };
    await writeFile(recordPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

    await expect(store.get("issue-1")).rejects.toMatchObject({
      code: "lifecycle_store_corrupt",
    });
  });

  it.each([
    {
      name: "automated recovery without an actor",
      recoveryDisposition: {
        mode: "automated",
        nextActor: null,
        targetState: "In Progress",
        transitionOperationKey: null,
        transitionStatus: "not_required",
        reason: "invalid automated route",
      },
      message: "nextActor is required for automated recovery",
    },
    {
      name: "external recovery with an actor",
      recoveryDisposition: {
        mode: "external",
        nextActor: "worker",
        targetState: "Blocked",
        transitionOperationKey: null,
        transitionStatus: "not_required",
        reason: "invalid external route",
      },
      message: "nextActor must be null for external recovery",
    },
    {
      name: "pending recovery without an operation key",
      recoveryDisposition: {
        mode: "automated",
        nextActor: "worker",
        targetState: "In Progress",
        transitionOperationKey: null,
        transitionStatus: "pending",
        reason: "invalid pending route",
      },
      message: "transitionOperationKey is required when transitionStatus is pending",
    },
    {
      name: "not-required recovery with an operation key",
      recoveryDisposition: {
        mode: "external",
        nextActor: null,
        targetState: "Blocked",
        transitionOperationKey: "transition:issue-1:blocked",
        transitionStatus: "not_required",
        reason: "invalid no-op route",
      },
      message: "transitionOperationKey must be null when transitionStatus is not_required",
    },
  ])("rejects $name", async ({ recoveryDisposition, message }) => {
    const store = new FileIssueLifecycleStore(root);
    await store.ensureIssue(issue());
    const recordPath = path.join(root, "issue-lifecycle", "issue-1.json");
    const raw = JSON.parse(
      await nodeFs.readFile(recordPath, "utf8"),
    ) as Record<string, unknown>;
    raw.lastIssueTriageReportId = "issue-triage-report:issue-1:triage-1";
    raw.issueTriageReports = [
      {
        id: "issue-triage-report:issue-1:triage-1",
        idempotencyKey: "triage-1",
        requestHash: "request-hash-1",
        runId: "triage-run-1",
        issueId: "issue-1",
        issueIdentifier: "TEST-1",
        triggerFingerprint: "trigger-1",
        disposition: "implementation_repair",
        confidence: "high",
        summary: "A bounded repair remains.",
        evidence: ["review finding"],
        recommendedAction: "Apply the repair.",
        blockers: [
          {
            kind: "implementation_unsatisfied_requirements",
            status: "active",
            nextActor: "worker",
            confidence: "high",
            summary: "A bounded repair remains.",
            evidence: ["review finding"],
            recommendedAction: "Apply the repair.",
          },
        ],
        recoveryDisposition,
        submittedAt: "2026-01-01T00:00:00.000Z",
        writebackOperationKeys: [],
      },
    ];
    await writeFile(recordPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

    await expect(store.get("issue-1")).rejects.toMatchObject({
      code: "lifecycle_store_corrupt",
      message: expect.stringContaining(message),
    });
  });

  it("rejects unknown blocker provenance schema versions", async () => {
    const store = new FileIssueLifecycleStore(root);
    await store.ensureIssue(issue());
    const recordPath = path.join(root, "issue-lifecycle", "issue-1.json");
    const raw = JSON.parse(
      await nodeFs.readFile(recordPath, "utf8"),
    ) as Record<string, unknown>;
    raw.blockerProvenances = [{ version: 2 }];
    await writeFile(recordPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

    await expect(store.get("issue-1")).rejects.toMatchObject({
      code: "lifecycle_store_corrupt",
      message: expect.stringContaining(
        "blockerProvenances[0].version is invalid",
      ),
    });
  });

  it("persists exact pre-PR base-ref blocker provenance", async () => {
    const store = new FileIssueLifecycleStore(root);
    const candidate = issue();
    const sourceObservation = blockerObservation();
    const observation = {
      ...sourceObservation,
      operation: "dispatch_worker",
      inputFingerprint: baseRefObservationInputFingerprint({
        workspacePath: sourceObservation.workspacePath,
        branchName: sourceObservation.branchName,
        baseRef: sourceObservation.baseRef,
        operation: "dispatch_worker",
      }),
    };
    const provenance = createBaseRefBlockerProvenance({
      issue: candidate,
      runId: candidate.id,
      pullRequestNumber: null,
      pullRequestHeadSha: null,
      observation,
    });

    await store.ensureIssue(candidate, {
      phase: "blocked",
      baseRefObservation: observation,
      blockerProvenances: [provenance],
      activeBlockerProvenanceId: provenance.id,
    });

    const stored = await store.get(candidate.id);
    expect(stored).toMatchObject({
      activeBlockerProvenanceId: provenance.id,
      blockerProvenances: [
        expect.objectContaining({
          operation: "dispatch_worker",
          pullRequestNumber: null,
          pullRequestHeadSha: null,
        }),
      ],
    });
    const active = stored?.blockerProvenances?.find(
      (record) => record.id === stored.activeBlockerProvenanceId,
    );
    expect(active).toBeDefined();
    expect(
      blockerProvenanceMatchesObservation(active!, observation, {
        runId: candidate.id,
        pullRequestNumber: null,
        pullRequestHeadSha: null,
      }),
    ).toBe(true);
    expect(
      blockerProvenanceMatchesObservation(active!, {
        ...observation,
        checkedAt: "2026-01-01T00:00:01.000Z",
      }),
    ).toBe(false);
    expect(
      blockerProvenanceMatchesObservation(active!, {
        ...observation,
        githubBaseHeadSha: "base-head-2",
      }),
    ).toBe(false);
    expect(
      blockerProvenanceMatchesObservation(active!, observation, {
        pullRequestHeadSha: "stale-pr-head",
      }),
    ).toBe(false);
  });

  it.each([
    "recoveryKind",
    "initialObservationFingerprint",
    "initialClassification",
    "initialLiveBaseHeadSha",
    "initialWorktreeHeadSha",
  ])("rejects blocker provenance missing required %s", async (field) => {
    const store = new FileIssueLifecycleStore(root);
    const candidate = issue();
    const provenance = createReviewFeedbackBaseRefProvenance({
      issue: candidate,
      runId: "review-run-1",
      pullRequestNumber: 42,
      pullRequestHeadSha: "head-sha-1",
      observation: blockerObservation(),
    });
    await store.ensureIssue(candidate, {
      blockerProvenances: [provenance],
      activeBlockerProvenanceId: provenance.id,
    });
    const recordPath = path.join(root, "issue-lifecycle", "issue-1.json");
    const raw = JSON.parse(
      await nodeFs.readFile(recordPath, "utf8"),
    ) as Record<string, unknown>;
    const stored = (
      raw.blockerProvenances as Array<Record<string, unknown>>
    )[0]!;
    delete stored[field];
    await writeFile(recordPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

    await expect(store.get("issue-1")).rejects.toMatchObject({
      code: "lifecycle_store_corrupt",
      message: expect.stringContaining(field),
    });
  });

  it("rejects an active blocker provenance id that does not identify an unresolved record", async () => {
    const store = new FileIssueLifecycleStore(root);
    const candidate = issue();
    const provenance = createReviewFeedbackBaseRefProvenance({
      issue: candidate,
      runId: "review-run-1",
      pullRequestNumber: 42,
      pullRequestHeadSha: "head-sha-1",
      observation: blockerObservation(),
    });
    await store.ensureIssue(candidate, {
      blockerProvenances: [provenance],
      activeBlockerProvenanceId: provenance.id,
    });
    const recordPath = path.join(root, "issue-lifecycle", "issue-1.json");
    const raw = JSON.parse(await nodeFs.readFile(recordPath, "utf8")) as Record<string, unknown>;
    raw.activeBlockerProvenanceId = "blocker-provenance:missing";
    await writeFile(recordPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

    await expect(store.get("issue-1")).rejects.toMatchObject({
      code: "lifecycle_store_corrupt",
      message: expect.stringContaining("does not exist"),
    });
  });

  it("rejects an unfinished carried blocker without a conflicted service preparation", async () => {
    const store = new FileIssueLifecycleStore(root);
    const candidate = issue();
    const provenance = createReviewFeedbackBaseRefProvenance({
      issue: candidate,
      runId: "review-run-1",
      pullRequestNumber: 42,
      pullRequestHeadSha: "head-sha-1",
      observation: blockerObservation(),
    });
    await expect(
      store.ensureIssue(candidate, {
        phase: "merge_conflict_resolution",
        blockerProvenances: [provenance],
        activeBlockerProvenanceId: provenance.id,
        mergeConflict: {
        id: "merge-conflict:issue-1:head-sha-1",
        status: "open",
        resolutionStatus: "pending",
        pullRequest: {
          url: "https://github.com/acme/repo/pull/42",
          number: 42,
          headSha: "head-sha-1",
          branch: "symphony/TEST-1",
        },
        approvedHeadSha: "head-sha-1",
        currentHeadSha: "head-sha-1",
        resolvedHeadSha: null,
        baseBranch: "main",
        baseHeadSha: "base-head-1",
        sourceState: "In Review",
        conflictsState: "Approved with Conflicts",
        reason: "Base-ref repair conflicted",
        mergeableState: "dirty",
        blockerProvenanceId: provenance.id,
        servicePreparation: null,
        detectedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        fixTurnCount: 0,
        maxFixTurns: 3,
        lastConflictFixRunId: null,
        lastConflictResolutionReportId: null,
        attemptRunIds: [],
        writebackOperationKeys: [],
        blockedAt: null,
        blockedReason: null,
        },
      }),
    ).rejects.toMatchObject({
      code: "lifecycle_store_corrupt",
      message: expect.stringContaining("unfinished merge conflict has inconsistent blocker provenance"),
    });
    await expect(store.get("issue-1")).resolves.toBeNull();
  });

  it("keeps provenance valid when Linear changes an issue identifier", async () => {
    const store = new FileIssueLifecycleStore(root);
    const candidate = issue();
    const provenance = createReviewFeedbackBaseRefProvenance({
      issue: candidate,
      runId: "review-run-1",
      pullRequestNumber: 42,
      pullRequestHeadSha: "head-sha-1",
      observation: blockerObservation(),
    });
    await store.ensureIssue(candidate, {
      blockerProvenances: [provenance],
      activeBlockerProvenanceId: provenance.id,
    });

    await store.updateIssue(
      { id: candidate.id, identifier: "MOVED-1" },
      { phase: "blocked" },
    );

    await expect(store.get(candidate.id)).resolves.toMatchObject({
      issueIdentifier: "MOVED-1",
      activeBlockerProvenanceId: provenance.id,
      blockerProvenances: [
        expect.objectContaining({
          id: provenance.id,
          issueId: candidate.id,
          issueIdentifier: candidate.identifier,
        }),
      ],
    });
  });

  it("derives lifecycle phase from configured state buckets", () => {
    const config = testConfig(root);
    config.tracker.activeStates = ["Todo", "In Progress"];
    config.tracker.terminalStates = ["Done"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.reviewLoop.blockedStates = ["Blocked"];
    config.reviewLoop.reviewPassState = "Review Passed";

    expect(phaseForIssueState("In Progress", config)).toBe("implementation");
    expect(phaseForIssueState("In Review", config)).toBe("review");
    expect(phaseForIssueState("Review Passed", config)).toBe("passed");
    expect(phaseForIssueState("Blocked", config)).toBe("blocked");
    expect(phaseForIssueState("Done", config)).toBe("terminal");
  });
});

function blockerObservation() {
  return {
    version: 1 as const,
    inputFingerprint: "base-ref-observation-1",
    classification: "branch_not_based_on_live_base" as const,
    operation: "review_feedback",
    checkedAt: "2026-01-01T00:00:00.000Z",
    workspacePath: "/tmp/workspace",
    branchName: "symphony/TEST-1",
    baseRef: "origin/main",
    normalizedBaseBranch: "main",
    localBaseRef: "refs/remotes/origin/main",
    githubBaseHeadSha: "base-head-1",
    localBaseHeadShaBeforeFetch: "base-head-0",
    localBaseHeadShaAfterFetch: "base-head-1",
    worktreeHeadSha: "head-sha-1",
    localBaseIsAncestorOfHead: false,
    reason: "Worktree HEAD is not based on the live origin base",
    error: null,
  };
}

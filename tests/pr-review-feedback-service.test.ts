import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileIssueLifecycleStore, type IssueCompletionReportRecord } from "../src/core/persistence/IssueLifecycleStore.js";
import {
  boundPullRequestForLifecycle,
  PullRequestReviewFeedbackService,
  type PullRequestReviewFeedbackClient,
  type ReviewFeedbackActiveContext,
} from "../src/core/review/PullRequestReviewFeedbackService.js";
import type {
  PullRequestIssueCommentFeedbackInput,
  PullRequestReviewCommentFeedbackInput,
  PullRequestReviewFeedbackInput,
  PullRequestReviewFeedbackResult,
} from "../src/integrations/github/GitHubPullRequestClient.js";
import { issue, testConfig } from "./helpers.js";
import type { IssueBaseRefObservation } from "../src/core/BaseRefVerification.js";

describe("PullRequestReviewFeedbackService", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-pr-review-feedback-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("submits request-changes PR reviews against the lifecycle-bound PR and records returned URLs", async () => {
    const { service, lifecycleStore, client } = fixture();
    await seedLifecycle(lifecycleStore);

    const result = await service.submitPullRequestReviewFeedback(
      {
        kind: "review",
        event: "REQUEST_CHANGES",
        body: "Please cover the retry path.",
        comments: [{ path: "src/core/orchestrator/Orchestrator.ts", body: "Needs a test.", line: 42, side: "RIGHT" }],
        idempotencyKey: "feedback-1",
      },
      context(),
    );

    expect(client.calls).toEqual([
      {
        kind: "review",
        input: {
          pullRequestNumber: 42,
          headSha: "abc123",
          event: "REQUEST_CHANGES",
          body: "Please cover the retry path.",
          comments: [{ path: "src/core/orchestrator/Orchestrator.ts", body: "Needs a test.", line: 42, side: "RIGHT" }],
        },
      },
    ]);
    expect(result).toMatchObject({
      accepted: true,
      replayed: false,
      pullRequest: { number: 42, url: "https://github.com/acme/symphony/pull/42", headSha: "abc123" },
      reviewUrl: "https://github.com/acme/symphony/pull/42#pullrequestreview-9001",
      commentUrls: ["https://github.com/acme/symphony/pull/42#discussion_r9002"],
    });
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      reviewFeedback: [
        {
          id: "review-feedback:issue-1:review-run-1:feedback-1",
          kind: "review",
          event: "REQUEST_CHANGES",
          runId: "review-run-1",
          reviewer: "reviewer-agent:review-run-1",
          pullRequest: { number: 42, headSha: "abc123" },
        },
      ],
    });
  });

  it("supports approval reviews, review comments, and issue comments", async () => {
    const { service, lifecycleStore, client } = fixture();
    await seedLifecycle(lifecycleStore);

    await service.submitPullRequestReviewFeedback(
      { kind: "review", event: "APPROVE", body: "Looks good.", idempotencyKey: "approve-1" },
      context(),
    );
    await service.submitPullRequestReviewFeedback(
      { kind: "review_comment", body: "Inline note.", path: "src/index.ts", line: 12, side: "RIGHT", idempotencyKey: "inline-1" },
      context(),
    );
    await service.submitPullRequestReviewFeedback(
      { kind: "issue_comment", body: "High-level note.", idempotencyKey: "issue-comment-1" },
      context(),
    );

    expect(client.calls.map((call) => call.kind)).toEqual(["review", "review_comment", "issue_comment"]);
    expect(client.calls[0]).toMatchObject({ input: { event: "APPROVE", headSha: "abc123" } });
    expect(client.calls[1]).toMatchObject({ input: { path: "src/index.ts", line: 12, side: "RIGHT", headSha: "abc123" } });
    expect(client.calls[2]).toMatchObject({ input: { pullRequestNumber: 42, body: "High-level note." } });
  });

  it("rejects COMMENT whole-PR review events for new feedback submissions", async () => {
    const { service, lifecycleStore, client } = fixture();
    await seedLifecycle(lifecycleStore);

    await expect(
      service.submitPullRequestReviewFeedback(
        { kind: "review", event: "COMMENT", body: "Neutral whole-PR note.", idempotencyKey: "comment-1" },
        context(),
      ),
    ).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(client.calls).toHaveLength(0);
  });

  it("accepts COMMENT whole-PR review events for expected-red artifacts", async () => {
    const { service, lifecycleStore, client } = fixture();
    await seedLifecycle(lifecycleStore, { acceptedArtifact: true });

    await expect(
      service.submitPullRequestReviewFeedback(
        {
          kind: "review",
          event: "COMMENT",
          body: "Expected-red artifact accepted.",
          idempotencyKey: "artifact-comment-1",
        },
        context(),
      ),
    ).resolves.toMatchObject({ accepted: true });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({
      kind: "review",
      input: { event: "COMMENT", headSha: "abc123" },
    });
  });

  it("does not review a superseded accepted artifact or reuse its stale pull request", async () => {
    const { service, lifecycleStore, client } = fixture();
    await seedLifecycle(lifecycleStore, { acceptedArtifact: true });
    const lifecycle = await lifecycleStore.get("issue-1");
    const reopened = await lifecycleStore.updateIssue(
      issue({ state: "In Review", branchName: "symphony/TEST-1" }),
      {
        lastCompletionReportId: null,
        completionReports: lifecycle!.completionReports.map((report) => ({
          ...report,
          supersededAt: "2026-07-14T11:00:00.000Z",
          supersededBy: "accepted_artifact_reopened",
          supersededReason: "The accepted artifact source checkpoint changed.",
        })),
      },
    );

    expect(boundPullRequestForLifecycle(reopened)).toBeNull();
    await expect(
      service.submitPullRequestReviewFeedback(
        {
          kind: "review",
          event: "COMMENT",
          body: "Expected-red artifact accepted.",
          idempotencyKey: "artifact-comment-reopened",
        },
        context(),
      ),
    ).rejects.toThrow(/reserved for accepted expected-red artifacts/);
    expect(client.calls).toHaveLength(0);
  });

  it("includes schema validation paths in invalid review feedback errors", async () => {
    const { service, lifecycleStore, client } = fixture();
    await seedLifecycle(lifecycleStore);

    await expect(
      service.submitPullRequestReviewFeedback(
        { kind: "review_comment", body: "Inline note.", idempotencyKey: "inline-invalid" },
        context(),
      ),
    ).rejects.toThrow(/PR review feedback is invalid: .*path: Inline review comments require path.*line: Inline review comments require line.*side: Inline review comments require side/);
    expect(client.calls).toHaveLength(0);
  });

  it("rejects missing review feedback arguments with a targeted MCP payload message", async () => {
    const { service, lifecycleStore, client } = fixture();
    await seedLifecycle(lifecycleStore);

    await expect(service.submitPullRequestReviewFeedback({}, context())).rejects.toThrow(
      /PR review feedback arguments are required.*MCP supplies the active PR context only.*never call submit_pull_request_review_feedback with \{\}/,
    );
    expect(client.calls).toHaveLength(0);
  });

  it("replays matching idempotency keys without duplicate GitHub writes and rejects conflicting payloads", async () => {
    const { service, lifecycleStore, client } = fixture();
    await seedLifecycle(lifecycleStore);
    const payload = { kind: "issue_comment" as const, body: "High-level note.", idempotencyKey: "same-key" };

    const first = await service.submitPullRequestReviewFeedback(payload, context());
    const second = await service.submitPullRequestReviewFeedback(payload, context());

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.urls).toEqual(first.urls);
    expect(client.calls).toHaveLength(1);
    await expect(
      service.submitPullRequestReviewFeedback({ ...payload, body: "Different note." }, context()),
    ).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("rejects non-reviewer, inactive-run, non-review-state, and missing-PR submissions", async () => {
    const { service, lifecycleStore } = fixture();
    await seedLifecycle(lifecycleStore);

    await expect(service.submitPullRequestReviewFeedback(issueComment(), context({ role: "worker" }))).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      service.submitPullRequestReviewFeedback(issueComment(), context({ activeRunId: "other-run" })),
    ).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      service.submitPullRequestReviewFeedback(
        issueComment(),
        context({ issue: issue({ state: "In Progress", branchName: "symphony/TEST-1" }), phase: "implementation" }),
      ),
    ).rejects.toMatchObject({
      code: "invalid_request",
    });

    const emptyStore = new FileIssueLifecycleStore(path.join(root, "empty-state"));
    const emptyService = new PullRequestReviewFeedbackService({
      config: configured(),
      lifecycleStore: emptyStore,
      client: new RecordingFeedbackClient(),
    });
    await emptyStore.ensureIssue(issue({ state: "In Review", branchName: "symphony/TEST-1" }), {
      phase: "review",
      summaryPointers: { lastRunId: "review-run-1" },
    });
    await expect(emptyService.submitPullRequestReviewFeedback(issueComment(), context())).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("accepts reviewer feedback with the issue state gate explicitly ignored", async () => {
    const { service, lifecycleStore, client } = fixture();
    await seedLifecycle(lifecycleStore);

    const result = await service.submitPullRequestReviewFeedback(
      issueComment(),
      context({
        issue: issue({ state: "In Progress", branchName: "symphony/TEST-1" }),
        phase: "review",
        ignoreStateGate: true,
      }),
    );

    expect(result.accepted).toBe(true);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({
      kind: "issue_comment",
      input: { pullRequestNumber: 42, body: "High-level note." },
    });
  });

  it("fails closed when inline feedback lacks a lifecycle-bound head SHA", async () => {
    const { service, lifecycleStore, client } = fixture();
    await seedLifecycle(lifecycleStore, { headSha: null });

    await expect(
      service.submitPullRequestReviewFeedback(
        { kind: "review_comment", body: "Inline note.", path: "src/index.ts", line: 12, side: "RIGHT", idempotencyKey: "inline-1" },
        context(),
      ),
    ).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(client.calls).toHaveLength(0);
  });

  it("records review-feedback base failures with exact run and PR-head provenance", async () => {
    const config = configured();
    const lifecycleStore = new FileIssueLifecycleStore(root);
    const client = new RecordingFeedbackClient();
    const observation = baseRefFailureObservation();
    const service = new PullRequestReviewFeedbackService({
      config,
      lifecycleStore,
      client,
      baseRefVerifier: { verify: async () => observation },
    });
    await seedLifecycle(lifecycleStore);

    await expect(
      service.submitPullRequestReviewFeedback(
        {
          kind: "review",
          event: "REQUEST_CHANGES",
          body: "Unable to publish review feedback.",
          idempotencyKey: "base-ref-failure-1",
        },
        context(),
      ),
    ).rejects.toMatchObject({
      code: "invalid_request",
      details: {
        blockerProvenance: {
          code: "base_ref_drift",
          runId: "review-run-1",
          pullRequestNumber: 42,
          pullRequestHeadSha: "abc123",
        },
      },
    });

    const lifecycle = await lifecycleStore.get("issue-1");
    expect(lifecycle?.activeBlockerProvenanceId).toBe(
      lifecycle?.blockerProvenances?.[0]?.id,
    );
    expect(lifecycle?.blockerProvenances).toEqual([
      expect.objectContaining({
        code: "base_ref_drift",
        recoveryKind: "automatic_rebase",
        sourceKind: "base_ref_observation",
        initialObservationFingerprint: observation.inputFingerprint,
        initialClassification: "branch_not_based_on_live_base",
        sourceObservationFingerprint: observation.inputFingerprint,
        classification: "branch_not_based_on_live_base",
        operation: "review_feedback",
        runId: "review-run-1",
        pullRequestNumber: 42,
        pullRequestHeadSha: "abc123",
        liveBaseHeadSha: "base-sha-2",
        worktreeHeadSha: "abc123",
        observationAttempt: 1,
        lastObservedAt: observation.checkedAt,
        reviewVerdictId: null,
        resolvedAt: null,
      }),
    ]);
    expect(client.calls).toHaveLength(0);
  });

  it("updates one active provenance across repeated review-feedback base failures", async () => {
    const config = configured();
    const lifecycleStore = new FileIssueLifecycleStore(root);
    const client = new RecordingFeedbackClient();
    const firstObservation = baseRefFailureObservation();
    const secondObservation = baseRefFailureObservation({
      classification: "base_ref_fetch_failed",
      checkedAt: "2026-01-01T00:00:04.000Z",
      githubBaseHeadSha: "base-sha-3",
      localBaseHeadShaBeforeFetch: "base-sha-2",
      localBaseHeadShaAfterFetch: null,
      localBaseIsAncestorOfHead: null,
      reason: "Unable to fetch origin base ref",
      error: "git fetch failed",
    });
    const observations = [firstObservation, secondObservation];
    let observationIndex = 0;
    const service = new PullRequestReviewFeedbackService({
      config,
      lifecycleStore,
      client,
      baseRefVerifier: {
        verify: async () => observations[observationIndex++]!,
      },
    });
    await seedLifecycle(lifecycleStore);
    const feedback = {
      kind: "review" as const,
      event: "REQUEST_CHANGES" as const,
      body: "Unable to publish review feedback.",
      idempotencyKey: "base-ref-retry-failure-1",
    };

    await expect(
      service.submitPullRequestReviewFeedback(feedback, context()),
    ).rejects.toMatchObject({ code: "invalid_request" });
    const firstLifecycle = await lifecycleStore.get("issue-1");
    const provenanceId = firstLifecycle?.activeBlockerProvenanceId;

    await expect(
      service.submitPullRequestReviewFeedback(feedback, context()),
    ).rejects.toMatchObject({
      code: "invalid_request",
      details: {
        blockerProvenance: {
          id: provenanceId,
          initialClassification: "branch_not_based_on_live_base",
          classification: "base_ref_fetch_failed",
          observationAttempt: 2,
        },
      },
    });

    const lifecycle = await lifecycleStore.get("issue-1");
    expect(lifecycle?.activeBlockerProvenanceId).toBe(provenanceId);
    expect(lifecycle?.blockerProvenances).toHaveLength(1);
    expect(lifecycle?.blockerProvenances?.[0]).toMatchObject({
      id: provenanceId,
      code: "base_ref_verification_failure",
      recoveryKind: "automatic_recheck",
      initialObservationFingerprint: firstObservation.inputFingerprint,
      initialClassification: firstObservation.classification,
      initialLiveBaseHeadSha: firstObservation.githubBaseHeadSha,
      initialWorktreeHeadSha: firstObservation.worktreeHeadSha,
      sourceObservationFingerprint: secondObservation.inputFingerprint,
      classification: secondObservation.classification,
      liveBaseHeadSha: secondObservation.githubBaseHeadSha,
      worktreeHeadSha: secondObservation.worktreeHeadSha,
      observationAttempt: 2,
      createdAt: firstObservation.checkedAt,
      lastObservedAt: secondObservation.checkedAt,
      resolvedAt: null,
      resolution: null,
    });
    expect(client.calls).toHaveLength(0);
  });

  it("updates and resolves one provenance across fail-fail-ok review-feedback retries", async () => {
    const config = configured();
    const lifecycleStore = new FileIssueLifecycleStore(root);
    const client = new RecordingFeedbackClient();
    const firstObservation = baseRefFailureObservation();
    const secondObservation = baseRefFailureObservation({
      classification: "base_ref_fetch_failed",
      checkedAt: "2026-01-01T00:00:04.000Z",
      githubBaseHeadSha: "base-sha-3",
      localBaseHeadShaBeforeFetch: "base-sha-2",
      localBaseHeadShaAfterFetch: null,
      localBaseIsAncestorOfHead: null,
      reason: "Unable to fetch origin base ref",
      error: "git fetch failed",
    });
    const okObservation = baseRefFailureObservation({
      classification: "ok",
      checkedAt: "2026-01-01T00:00:05.000Z",
      githubBaseHeadSha: "base-sha-3",
      localBaseHeadShaBeforeFetch: "base-sha-3",
      localBaseHeadShaAfterFetch: "base-sha-3",
      localBaseIsAncestorOfHead: true,
      reason: null,
      error: null,
    });
    const observations = [firstObservation, secondObservation, okObservation];
    let observationIndex = 0;
    const service = new PullRequestReviewFeedbackService({
      config,
      lifecycleStore,
      client,
      baseRefVerifier: {
        verify: async () => observations[observationIndex++]!,
      },
    });
    await seedLifecycle(lifecycleStore);
    const feedback = {
      kind: "review" as const,
      event: "REQUEST_CHANGES" as const,
      body: "Unable to publish review feedback.",
      idempotencyKey: "base-ref-retry-success-1",
    };

    await expect(
      service.submitPullRequestReviewFeedback(feedback, context()),
    ).rejects.toMatchObject({ code: "invalid_request" });
    const firstLifecycle = await lifecycleStore.get("issue-1");
    const provenanceId = firstLifecycle?.activeBlockerProvenanceId;
    await expect(
      service.submitPullRequestReviewFeedback(feedback, context()),
    ).rejects.toMatchObject({ code: "invalid_request" });

    await expect(
      service.submitPullRequestReviewFeedback(feedback, context()),
    ).resolves.toMatchObject({ accepted: true, replayed: false });

    const lifecycle = await lifecycleStore.get("issue-1");
    expect(lifecycle).toMatchObject({
      phase: "review",
      blockedReason: null,
      activeBlockerProvenanceId: null,
      baseRefObservation: okObservation,
    });
    expect(lifecycle?.blockerProvenances).toHaveLength(1);
    expect(lifecycle?.blockerProvenances?.[0]).toMatchObject({
      id: provenanceId,
      recoveryKind: "automatic_recheck",
      initialObservationFingerprint: firstObservation.inputFingerprint,
      initialClassification: firstObservation.classification,
      initialLiveBaseHeadSha: firstObservation.githubBaseHeadSha,
      initialWorktreeHeadSha: firstObservation.worktreeHeadSha,
      sourceObservationFingerprint: okObservation.inputFingerprint,
      classification: "ok",
      liveBaseHeadSha: okObservation.githubBaseHeadSha,
      worktreeHeadSha: okObservation.worktreeHeadSha,
      observationAttempt: 3,
      createdAt: firstObservation.checkedAt,
      lastObservedAt: okObservation.checkedAt,
      resolvedAt: okObservation.checkedAt,
      resolution: "base_ref_recheck",
    });
    expect(client.calls).toHaveLength(1);
  });

  function fixture() {
    const config = configured();
    const lifecycleStore = new FileIssueLifecycleStore(root);
    const client = new RecordingFeedbackClient();
    const service = new PullRequestReviewFeedbackService({ config, lifecycleStore, client });
    return { service, lifecycleStore, client };
  }
});

class RecordingFeedbackClient implements PullRequestReviewFeedbackClient {
  readonly calls: Array<
    | { kind: "review"; input: PullRequestReviewFeedbackInput }
    | { kind: "review_comment"; input: PullRequestReviewCommentFeedbackInput }
    | { kind: "issue_comment"; input: PullRequestIssueCommentFeedbackInput }
  > = [];

  async getBranchHeadSha(): Promise<string> {
    return "base-sha-2";
  }

  async gitAuthHeader(): Promise<string> {
    return "AUTHORIZATION: basic test";
  }

  async submitPullRequestReviewFeedback(input: PullRequestReviewFeedbackInput): Promise<PullRequestReviewFeedbackResult> {
    this.calls.push({ kind: "review", input });
    return {
      reviewUrl: "https://github.com/acme/symphony/pull/42#pullrequestreview-9001",
      commentUrls: input.comments && input.comments.length > 0 ? ["https://github.com/acme/symphony/pull/42#discussion_r9002"] : [],
    };
  }

  async submitPullRequestReviewCommentFeedback(
    input: PullRequestReviewCommentFeedbackInput,
  ): Promise<PullRequestReviewFeedbackResult> {
    this.calls.push({ kind: "review_comment", input });
    return { reviewUrl: null, commentUrls: ["https://github.com/acme/symphony/pull/42#discussion_r9003"] };
  }

  async submitPullRequestIssueCommentFeedback(
    input: PullRequestIssueCommentFeedbackInput,
  ): Promise<PullRequestReviewFeedbackResult> {
    this.calls.push({ kind: "issue_comment", input });
    return { reviewUrl: null, commentUrls: ["https://github.com/acme/symphony/pull/42#issuecomment-9004"] };
  }
}

async function seedLifecycle(
  lifecycleStore: FileIssueLifecycleStore,
  options: { headSha?: string | null; acceptedArtifact?: boolean } = {},
): Promise<void> {
  const report = completionReportRecord(options.headSha === undefined ? "abc123" : options.headSha);
  if (options.acceptedArtifact === true) {
    report.contractSnapshot = {
      schemaVersion: 1,
      contractVersion: "accepted-artifact-review",
      fingerprint: "accepted-artifact-fingerprint",
      delivery: {
        mode: "accepted_artifact",
        artifact: "expected_red_tests",
      },
    };
  }
  await lifecycleStore.ensureIssue(issue({ state: "In Review", branchName: "symphony/TEST-1" }), {
    phase: "review",
    lastCompletionReportId: report.id,
    completionReports: [report],
    summaryPointers: {
      lastRunId: "review-run-1",
      prUrl: "https://github.com/acme/symphony/pull/41",
      prNumber: 41,
      prHeadSha: "summary-sha",
    },
  });
}

function completionReportRecord(headSha: string | null): IssueCompletionReportRecord {
  return {
    id: "completion-report-1",
    idempotencyKey: "report-1",
    runId: "worker-run-1",
    issueId: "issue-1",
    issueIdentifier: "TEST-1",
    summary: "Implemented the requested change.",
    validationEvidence: ["npm test"],
    acceptanceChecklist: [{ text: "Feedback is possible.", satisfied: true, evidence: "Tests passed." }],
    changedFiles: ["src/index.ts"],
    branchName: "symphony/TEST-1",
    pullRequest: {
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headSha,
      branch: "symphony/TEST-1",
    },
    risks: [],
    acceptedAt: "2026-01-01T00:00:00Z",
    writebackOperationKeys: [],
  };
}

function configured() {
  const config = testConfig("/tmp/symphony-pr-review-feedback");
  config.reviewLoop.reviewStates = ["In Review"];
  return config;
}

function context(overrides: Partial<ReviewFeedbackActiveContext> = {}): ReviewFeedbackActiveContext {
  return {
    issue: issue({ state: "In Review", branchName: "symphony/TEST-1" }),
    activeRunId: "review-run-1",
    role: "reviewer",
    token: "review-token",
    expectedToken: "review-token",
    reviewer: "reviewer-agent:review-run-1",
    phase: "review",
    ...overrides,
  };
}

function issueComment() {
  return { kind: "issue_comment" as const, body: "High-level note.", idempotencyKey: "issue-comment-1" };
}

function baseRefFailureObservation(
  overrides: Partial<IssueBaseRefObservation> = {},
): IssueBaseRefObservation {
  return {
    version: 1,
    inputFingerprint: "review-feedback-base-ref-fingerprint",
    classification: "branch_not_based_on_live_base",
    operation: "review_feedback",
    checkedAt: "2026-01-01T00:00:03.000Z",
    workspacePath: "/tmp/symphony-pr-review-feedback",
    branchName: "symphony/TEST-1",
    baseRef: "origin/main",
    normalizedBaseBranch: "main",
    localBaseRef: "refs/remotes/origin/main",
    githubBaseHeadSha: "base-sha-2",
    localBaseHeadShaBeforeFetch: "base-sha-1",
    localBaseHeadShaAfterFetch: "base-sha-2",
    worktreeHeadSha: "abc123",
    localBaseIsAncestorOfHead: false,
    reason: "Worktree HEAD is not based on the live origin base",
    error: null,
    ...overrides,
  };
}

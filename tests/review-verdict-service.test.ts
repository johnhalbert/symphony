import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SymphonyError } from "../src/core/errors.js";
import { createReviewFeedbackBaseRefProvenance } from "../src/core/BlockerProvenance.js";
import type { IssueBaseRefObservation } from "../src/core/BaseRefVerification.js";
import {
  FileIssueLifecycleStore,
  type IssueLifecycleRecord,
  type IssueMergeGateState,
  type IssueReviewFeedbackRecord,
} from "../src/core/persistence/IssueLifecycleStore.js";
import {
  formatWorkerMergeGatePromptResult,
  planReviewVerdictSubmissionApplication,
  ReviewVerdictService,
  type ReviewVerdictActiveContext,
  type ReviewVerdictInput,
} from "../src/core/ReviewVerdictService.js";
import { FileWritebackOutboxStore } from "../src/core/writeback/WritebackOutbox.js";
import { issue, testConfig } from "./helpers.js";

describe("ReviewVerdictService", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-review-verdict-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("accepts a fail verdict as a pending handoff submission", async () => {
    const { service, lifecycleStore, outbox } = fixture();
    await lifecycleStore.ensureIssue(issue({ state: "In Review" }), {
      phase: "review",
      reviewRound: 0,
    });

    const result = await service.submit_review_verdict(failVerdict(), context());

    expect(result.replayed).toBe(false);
    expect(result.handoffStatus).toBe("pending");
    expect(result.writebackOperations).toHaveLength(0);
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      phase: "review",
      reviewRound: 0,
      lastReviewVerdictId: null,
      reviewVerdicts: [],
      reviewVerdictSubmissions: [
        {
          id: "review-verdict:issue-1:verdict-1",
          idempotencyKey: "verdict-1",
          runId: "review-run-1",
          verdict: "fail",
          findings: ["Add a regression test for duplicate verdict handling."],
          evidence: ["https://github.com/acme/symphony/pull/42#discussion_r1"],
          status: "pending",
        },
      ],
    });

    expect(await outbox.list()).toHaveLength(0);
  });

  it("accepts a blocked verdict without burning reviewer failure budget", async () => {
    const { service, lifecycleStore, outbox } = fixture((config) => {
      config.reviewLoop.blockedStates = ["Blocked"];
    });
    await lifecycleStore.ensureIssue(issue({ state: "In Review" }), {
      phase: "review",
      reviewRound: 1,
    });

    const result = await service.submit_review_verdict(
      blockedVerdict({
        findings: ["Focused validation is unavailable to worker and reviewer command surfaces."],
      }),
      context(),
    );

    expect(result.replayed).toBe(false);
    expect(result.handoffStatus).toBe("pending");
    expect(result.writebackOperations).toHaveLength(0);
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      phase: "review",
      reviewRound: 1,
      blockedReason: null,
      lastReviewVerdictId: null,
      reviewVerdicts: [],
      reviewVerdictSubmissions: [
        {
          id: "review-verdict:issue-1:blocked-verdict-1",
          idempotencyKey: "blocked-verdict-1",
          runId: "review-run-1",
          verdict: "blocked",
          findings: ["Focused validation is unavailable to worker and reviewer command surfaces."],
          status: "pending",
        },
      ],
    });

    expect(await outbox.list()).toHaveLength(0);
  });

  it("automatically links a blocked verdict to matching Symphony blocker provenance", async () => {
    const { service, lifecycleStore } = fixture();
    const observation = reviewFeedbackBaseRefObservation();
    const provenance = createReviewFeedbackBaseRefProvenance({
      issue: issue({ state: "In Review" }),
      runId: "review-run-1",
      pullRequestNumber: 42,
      pullRequestHeadSha: "head-sha-1",
      observation,
    });
    const report = completionReport();
    await lifecycleStore.ensureIssue(issue({ state: "In Review" }), {
      phase: "review",
      lastCompletionReportId: report.id,
      completionReports: [report],
      baseRefObservation: observation,
      blockerProvenances: [provenance],
      activeBlockerProvenanceId: provenance.id,
      summaryPointers: {
        lastRunId: "review-run-1",
        prUrl: report.pullRequest?.url ?? null,
        prNumber: report.pullRequest?.number ?? null,
        prHeadSha: report.pullRequest?.headSha ?? null,
        prBranch: report.pullRequest?.branch ?? null,
      },
    });

    const result = await service.submit_review_verdict(
      blockedVerdict(),
      context(),
    );

    expect(result.verdict.blockerProvenanceId).toBe(provenance.id);
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      reviewVerdictSubmissions: [
        expect.objectContaining({
          id: "review-verdict:issue-1:blocked-verdict-1",
          blockerProvenanceId: provenance.id,
        }),
      ],
      blockerProvenances: [
        expect.objectContaining({
          id: provenance.id,
          reviewVerdictId: "review-verdict:issue-1:blocked-verdict-1",
        }),
      ],
    });
  });

  it("rejects blocked verdicts for failed validation without non-worker-owned evidence", async () => {
    const { service, lifecycleStore } = fixture();
    await lifecycleStore.ensureIssue(issue({ state: "In Review" }), {
      phase: "review",
    });

    await expect(
      service.submitReviewVerdict(
        blockedVerdict({
          acceptanceResults: [
            {
              text: "Validation requirement: npm run test:backend.",
              satisfied: false,
              evidence:
                "`npm run test:backend` exited 1 with failures in src/services/shared.test.ts.",
            },
          ],
          findings: [
            "Required `npm run test:backend` validation failed in files outside the PR diff.",
          ],
          evidence: ["reviewer observed failing tests"],
        }),
        context(),
      ),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message:
        "Blocked review verdicts for failed validation, tests, CI, or checks require discoveryFindings evidence proving the blocker is not worker-owned; use a fail verdict when the failure may be caused by the worker's changes.",
    });
  });

  it("rejects blocked failed-validation verdicts when evidence only says the file was unchanged", async () => {
    const { service, lifecycleStore } = fixture();
    await lifecycleStore.ensureIssue(issue({ state: "In Review" }), {
      phase: "review",
    });

    await expect(
      service.submitReviewVerdict(
        blockedVerdict({
          acceptanceResults: [
            {
              text: "Validation requirement: npm run test:backend.",
              satisfied: false,
              evidence:
                "`npm run test:backend` exited 1 with failures in src/services/shared.test.ts.",
            },
          ],
          findings: ["Backend validation failed in unchanged test files."],
          discoveryFindings: [
            discoveryFinding({
              relationship: "sibling_issue_scope",
              summary: "The failing test file is not in the PR diff.",
              discoveryReason:
                "Reviewer found only that src/services/shared.test.ts was not changed by this PR.",
              evidence: ["git diff --name-only did not list src/services/shared.test.ts."],
              suggestedDisposition: "operator_decision",
            }),
          ],
        }),
        context(),
      ),
    ).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("accepts blocked failed-validation verdicts with explicit sibling-scope evidence", async () => {
    const { service, lifecycleStore } = fixture();
    await lifecycleStore.ensureIssue(issue({ state: "In Review" }), {
      phase: "review",
    });

    await service.submitReviewVerdict(
      blockedVerdict({
        acceptanceResults: [
          {
            text: "Validation requirement: npm run test:backend.",
            satisfied: false,
            evidence:
              "`npm run test:backend` exited 1 because T020 generated-packet tests are still red.",
          },
        ],
        findings: [
          "Required `npm run test:backend` validation failed on explicit sibling T020 scope.",
        ],
        discoveryFindings: [
          discoveryFinding({
            relationship: "sibling_issue_scope",
            summary:
              "The red backend suite is blocked by explicit sibling T020 generated-packet scope.",
            discoveryReason:
              "The failure maps to T020, which is a sibling task outside this issue contract.",
            scenarioAxes: ["T020 generated-packet validation"],
            evidence: [
              "tasks.md assigns generated-packet persistence to T020.",
              "The current issue contract only owns review verdict submission behavior.",
            ],
            suggestedDisposition: "followup_issue",
          }),
        ],
      }),
      context(),
    );

    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      reviewVerdictSubmissions: [
        {
          idempotencyKey: "blocked-verdict-1",
          verdict: "blocked",
          discoveryFindings: [
            {
              relationship: "sibling_issue_scope",
              suggestedDisposition: "followup_issue",
            },
          ],
        },
      ],
    });
  });

  it("stores structured gate and discovery findings while deriving legacy findings from gate summaries", async () => {
    const { service, lifecycleStore } = fixture();
    await lifecycleStore.ensureIssue(issue({ state: "In Review" }), {
      phase: "review",
      reviewRound: 0,
    });

    await service.submitReviewVerdict(
      failVerdict({
        idempotencyKey: "verdict-structured-1",
        findings: ["Legacy summary that should not drive storage."],
        gateFindings: [
          gateFinding({
            summary: "Preserve explicit project context when resolving workspace fallbacks.",
            requirementIds: ["REQ-1"],
            contractAnchor: "Issue Contract > Requirements > REQ-1",
          }),
        ],
        discoveryFindings: [
          discoveryFinding({
            summary: "The sibling docs workspace fallback matrix may need its own follow-up.",
            relationship: "adjacent_sibling",
            suggestedDisposition: "followup_issue",
          }),
        ],
      }),
      context(),
    );

    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      reviewVerdicts: [],
      reviewVerdictSubmissions: [
        {
          idempotencyKey: "verdict-structured-1",
          status: "pending",
          findings: ["Preserve explicit project context when resolving workspace fallbacks."],
          gateFindings: [
            {
              summary: "Preserve explicit project context when resolving workspace fallbacks.",
              requirementIds: ["REQ-1"],
              contractAnchor: "Issue Contract > Requirements > REQ-1",
            },
          ],
          discoveryFindings: [
            {
              summary: "The sibling docs workspace fallback matrix may need its own follow-up.",
              relationship: "adjacent_sibling",
              suggestedDisposition: "followup_issue",
            },
          ],
        },
      ],
    });
  });

  it("defers review round increments until the handoff transition applies the verdict", async () => {
    const { service, lifecycleStore } = fixture();
    await lifecycleStore.ensureIssue(issue({ state: "In Review" }), {
      phase: "review",
      reviewRound: 1,
      summaryPointers: { lastRunId: "review-run-1" },
    });

    await service.submitReviewVerdict(failVerdict(), context());

    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      reviewRound: 1,
      reviewVerdictSubmissions: [
        {
          idempotencyKey: "verdict-1",
          status: "pending",
        },
      ],
    });
  });

  it("turns the reviewer failure ceiling into an internal triage checkpoint", async () => {
    const { service, lifecycleStore, config } = fixture((candidateConfig) => {
      candidateConfig.issueTriage.enabled = true;
      candidateConfig.reviewLoop.failureLimits.reviewerFailures = 1;
    });
    const candidate = issue({ state: "In Review" });
    await lifecycleStore.ensureIssue(candidate, {
      phase: "review",
      reviewRound: 0,
      reviewFeedback: [requestChangesFeedback()],
    });

    const submitted = await service.submitReviewVerdict(
      failVerdict(),
      context({ issue: candidate }),
    );
    const lifecycle = await lifecycleStore.get(candidate.id);
    if (lifecycle === null) throw new Error("expected lifecycle");
    const plan = planReviewVerdictSubmissionApplication({
      config,
      issue: candidate,
      lifecycle,
      submission: submitted.verdict,
    });

    expect(plan.patch).toMatchObject({
      phase: "blocked",
      reviewRound: 1,
      blockedReason: "max reviewer failures reached (1/1)",
    });
    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0]).toMatchObject({
      kind: "comment",
      lifecycleBinding: {
        kind: "review_verdict",
        recordId: submitted.verdict.id,
      },
    });
    expect(
      plan.operations[0]?.kind === "comment"
        ? plan.operations[0].payload.body
        : "",
    ).toContain("Status: paused in review, automated triage pending");
    expect(plan.operations.some((operation) => operation.kind === "transition"))
      .toBe(false);
  });

  it("accepts a manual fail verdict with the issue state gate explicitly ignored", async () => {
    const { service, lifecycleStore, outbox, config } = fixture();
    const candidate = issue({ state: "Todo", branchName: "symphony/TEST-1" });
    const finalDisposition =
      "Manual review failed outside the normal state gate.\n\nThe complete reviewer response remains visible without truncation.";
    await lifecycleStore.ensureIssue(candidate, {
      phase: "review",
      reviewRound: 0,
    });

    const result = await service.submitReviewVerdict(
      failVerdict({ finalDisposition }),
      context({
        issue: candidate,
        ignoreStateGate: true,
      }),
    );

    expect(result.replayed).toBe(false);
    expect(result.writebackOperations).toHaveLength(0);
    expect(result.handoffStatus).toBe("pending");
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      phase: "review",
      reviewRound: 0,
      lastReviewVerdictId: null,
      reviewVerdictSubmissions: [
        {
          idempotencyKey: "verdict-1",
          ignoreStateGate: true,
          status: "pending",
        },
      ],
    });
    expect(await outbox.list()).toHaveLength(0);

    const lifecycle = await lifecycleStore.get("issue-1");
    if (lifecycle === null) throw new Error("expected lifecycle");
    const plan = planReviewVerdictSubmissionApplication({
      config,
      issue: candidate,
      lifecycle,
      submission: result.verdict,
    });
    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0]).toMatchObject({
      kind: "comment",
      lifecycleBinding: {
        kind: "review_verdict",
        recordId: "review-verdict:issue-1:verdict-1",
      },
    });
    expect(
      plan.operations[0]?.kind === "comment"
        ? plan.operations[0].payload.body
        : "",
    ).toContain(finalDisposition);
    expect(plan.operations.some((operation) => operation.kind === "transition"))
      .toBe(false);
    expect(plan.verdict).toMatchObject({
      finalDisposition,
      writebackOperationKeys: [plan.operations[0]?.idempotencyKey],
    });
  });

  it("rejects a pass verdict when the active reviewer run has not approved the lifecycle-bound PR", async () => {
    const { service, lifecycleStore } = fixture();
    await lifecycleStore.ensureIssue(issue({ state: "In Review" }), {
      phase: "review",
      reviewRound: 1,
    });

    await expect(service.submitReviewVerdict(passVerdict(), context())).rejects.toMatchObject({
      code: "invalid_request",
      message:
        'Pass review verdict requires prior submit_pull_request_review_feedback with kind="review" and event="APPROVE" for the active reviewer run and lifecycle-bound PR.',
    });
  });

  it("rejects a pass verdict when feedback is non-approval or from a different run", async () => {
    const { service, lifecycleStore } = fixture();
    await lifecycleStore.ensureIssue(issue({ state: "In Review" }), {
      phase: "review",
      reviewRound: 1,
      reviewFeedback: [
        requestChangesFeedback(),
        issueCommentFeedback(),
        reviewCommentFeedback(),
        approvalFeedback({ runId: "other-review-run" }),
      ],
    });

    await expect(service.submitReviewVerdict(passVerdict(), context())).rejects.toMatchObject({
      code: "invalid_request",
      message:
        'Pass review verdict requires prior submit_pull_request_review_feedback with kind="review" and event="APPROVE" for the active reviewer run and lifecycle-bound PR.',
    });
  });

  it("accepts a pass verdict as a pending handoff submission", async () => {
    const { service, lifecycleStore, outbox } = fixture();
    await lifecycleStore.ensureIssue(issue({ state: "In Review" }), {
      phase: "review",
      reviewRound: 1,
      lastCompletionReportId: "completion-report:issue-1:report-1",
      completionReports: [completionReport()],
      summaryPointers: { prUrl: "https://github.com/acme/symphony/pull/42", prNumber: 42, prHeadSha: "head-sha-1" },
      reviewFeedback: [approvalFeedback()],
    });

    const result = await service.submitReviewVerdict(passVerdict(), context());

    expect(result.replayed).toBe(false);
    expect(result.handoffStatus).toBe("pending");
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      phase: "review",
      lastReviewVerdictId: null,
      reviewVerdicts: [],
      reviewVerdictSubmissions: [
        {
          id: "review-verdict:issue-1:verdict-pass-1",
          verdict: "pass",
          acceptanceResults: [{ text: "All acceptance criteria satisfied", satisfied: true }],
          status: "pending",
        },
      ],
    });
    expect(await outbox.list()).toHaveLength(0);
  });

  it("accepts a pass verdict with non-gating discovery findings", async () => {
    const { service, lifecycleStore } = fixture();
    await lifecycleStore.ensureIssue(issue({ state: "In Review" }), {
      phase: "review",
      reviewRound: 1,
      lastCompletionReportId: "completion-report:issue-1:report-1",
      completionReports: [completionReport()],
      summaryPointers: { prUrl: "https://github.com/acme/symphony/pull/42", prNumber: 42, prHeadSha: "head-sha-1" },
      reviewFeedback: [approvalFeedback()],
    });

    await service.submitReviewVerdict(
      passVerdict({
        idempotencyKey: "verdict-pass-with-discovery",
        discoveryFindings: [
          discoveryFinding({
            summary: "A broader stale-cache matrix would be useful hardening outside this contract.",
            relationship: "future_hardening",
            suggestedDisposition: "followup_issue",
          }),
        ],
      }),
      context(),
    );

    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      phase: "review",
      reviewVerdicts: [],
      reviewVerdictSubmissions: [
        {
          idempotencyKey: "verdict-pass-with-discovery",
          verdict: "pass",
          findings: [],
          gateFindings: [],
          status: "pending",
          discoveryFindings: [
            {
              summary: "A broader stale-cache matrix would be useful hardening outside this contract.",
              relationship: "future_hardening",
              suggestedDisposition: "followup_issue",
            },
          ],
        },
      ],
    });
  });

  it("rejects a pass verdict when the accepted-artifact completion report was superseded", async () => {
    const { service, lifecycleStore } = fixture();
    const report = completionReport({
      contractSnapshot: {
        schemaVersion: 1,
        contractVersion: "accepted-artifact-review",
        fingerprint: "accepted-artifact-fingerprint",
        delivery: {
          mode: "accepted_artifact",
          artifact: "expected_red_tests",
        },
      },
      supersededAt: "2026-07-14T11:00:00.000Z",
      supersededBy: "accepted_artifact_reopened",
      supersededReason: "The accepted artifact source checkpoint changed.",
    });
    await lifecycleStore.ensureIssue(issue({ state: "In Review" }), {
      phase: "review",
      reviewRound: 1,
      lastCompletionReportId: report.id,
      completionReports: [report],
      summaryPointers: {
        prUrl: "https://github.com/acme/symphony/pull/42",
        prNumber: 42,
        prHeadSha: "head-sha-1",
      },
      reviewFeedback: [approvalFeedback()],
    });

    await expect(
      service.submitReviewVerdict(passVerdict(), context()),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      reviewVerdicts: [],
      reviewVerdictSubmissions: [],
    });
  });

  it("accepts a fail verdict with same-run request-changes or comment-only feedback", async () => {
    const { service, lifecycleStore } = fixture();
    await lifecycleStore.ensureIssue(issue({ state: "In Review" }), {
      phase: "review",
      reviewFeedback: [requestChangesFeedback(), issueCommentFeedback(), reviewCommentFeedback()],
    });

    const result = await service.submitReviewVerdict(failVerdict(), context());

    expect(result.replayed).toBe(false);
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      phase: "review",
      reviewRound: 0,
      reviewVerdictSubmissions: [
        {
          idempotencyKey: "verdict-1",
          status: "pending",
        },
      ],
    });
  });

  it("rejects a fail verdict after same-run approval feedback", async () => {
    const { service, lifecycleStore } = fixture();
    await lifecycleStore.ensureIssue(issue({ state: "In Review" }), {
      phase: "review",
      reviewFeedback: [approvalFeedback()],
    });

    await expect(service.submitReviewVerdict(failVerdict(), context())).rejects.toMatchObject({
      code: "invalid_request",
      message:
        "Fail review verdict cannot follow APPROVE review feedback in the same reviewer run; submit a pass verdict or start a fresh review run.",
    });
  });

  it("replays duplicate verdicts without new lifecycle or writeback side effects", async () => {
    const { service, lifecycleStore, outbox } = fixture();
    await lifecycleStore.ensureIssue(issue({ state: "In Review" }), {
      phase: "review",
    });

    const first = await service.submitReviewVerdict(failVerdict(), context());
    const second = await service.submitReviewVerdict(
      failVerdict({ findings: ["Changed finding on replay."] }),
      context({ issue: issue({ state: "In Progress" }), phase: "implementation" }),
    );

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.verdict.findings).toEqual(["Add a regression test for duplicate verdict handling."]);
    expect((await lifecycleStore.get("issue-1"))?.reviewVerdicts).toHaveLength(0);
    expect((await lifecycleStore.get("issue-1"))?.reviewVerdictSubmissions).toHaveLength(1);
    expect(await outbox.list()).toHaveLength(0);
  });

  it("rejects canonical reviewer disposition drift on same-run replay", async () => {
    const { service, lifecycleStore } = fixture();
    await lifecycleStore.ensureIssue(issue({ state: "In Review" }), {
      phase: "review",
    });
    const original = failVerdict();
    const changedDisposition = "A corrected but different full reviewer disposition.";

    await service.submitReviewVerdict(original, context());

    await expect(
      service.submitReviewVerdict(
        failVerdict({ finalDisposition: changedDisposition }),
        context(),
      ),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "Review verdict idempotency key was reused with a different final disposition",
    });
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      reviewVerdictSubmissions: [
        expect.objectContaining({ finalDisposition: original.finalDisposition }),
      ],
    });
  });

  it("rejects review verdict idempotency key reuse from another reviewer run", async () => {
    const { service, lifecycleStore } = fixture();
    await lifecycleStore.ensureIssue(issue({ state: "In Review" }), {
      phase: "review",
    });

    await service.submitReviewVerdict(failVerdict(), context());

    await expect(
      service.submitReviewVerdict(
        failVerdict({ runId: "review-run-2", findings: ["Changed finding from another run."] }),
        context({ activeRunId: "review-run-2" }),
      ),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "Review verdict idempotency key was already used by another run",
    });
  });

  it("rejects verdict calls from the wrong role, run, or state", async () => {
    const { service, lifecycleStore } = fixture();
    await lifecycleStore.ensureIssue(issue({ state: "In Review" }), {
      phase: "review",
    });

    await expect(service.submitReviewVerdict(failVerdict(), context({ role: "worker" }))).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(service.submitReviewVerdict(failVerdict({ runId: "other-run" }), context())).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      service.submitReviewVerdict(failVerdict(), context({ issue: issue({ state: "In Progress" }), phase: "implementation" })),
    ).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("rejects invalid verdict payloads", async () => {
    const { service, lifecycleStore } = fixture();
    await lifecycleStore.ensureIssue(issue({ state: "In Review" }), {
      phase: "review",
    });

    await expect(service.submitReviewVerdict(failVerdict({ findings: [] }), context())).rejects.toBeInstanceOf(
      SymphonyError,
    );
    await expect(service.submitReviewVerdict(failVerdict({ findings: [] }), context())).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      service.submitReviewVerdict(failVerdict({ findings: [], gateFindings: [], discoveryFindings: [discoveryFinding()] }), context()),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: "Fail review verdicts require at least one gate finding or legacy finding",
    });
    await expect(
      service.submitReviewVerdict(passVerdict({ gateFindings: [gateFinding()] }), context()),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: "Pass review verdicts cannot include gate findings",
    });
  });

  it("formats merge-gate repair prompts with missing-check stabilization history", () => {
    const result = formatWorkerMergeGatePromptResult(
      lifecycle({
        mergeGate: mergeGate({
          checks: [
            {
              name: "typecheck",
              outcome: "missing_actionable",
              rawStatus: "missing",
              conclusion: null,
              url: null,
              firstObservedAt: "2026-01-01T00:00:00.000Z",
              actionableSince: "2026-01-01T00:05:00.000Z",
            },
            {
              name: "lint",
              outcome: "missing_observed",
              rawStatus: "missing",
              conclusion: null,
              url: null,
              firstObservedAt: "2026-01-01T00:00:01.000Z",
              actionableSince: null,
            },
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
        }),
      }),
    );

    expect(result?.kind).toBe("repair");
    expect(result?.text).toContain(
      "- typecheck: missing_actionable; firstObservedAt: 2026-01-01T00:00:00.000Z; actionableSince: 2026-01-01T00:05:00.000Z",
    );
    expect(result?.text).toContain("- lint: missing_observed; firstObservedAt: 2026-01-01T00:00:01.000Z; actionableSince: n/a");
    expect(result?.text).toContain("- test: failing / failure (https://ci.test/test)");
    expect(result?.text).not.toContain("- test: failing / failure (https://ci.test/test); firstObservedAt");
    expect(result?.text).toContain("leave the final implementation changes uncommitted and unpushed");
    expect(result?.text).toContain("Do not run git commit, git push");
    expect(result?.text).not.toContain("commit and push the repaired branch");
  });

  it("formats conflicted merge-gate repair prompts without claiming conflict preparation", () => {
    const result = formatWorkerMergeGatePromptResult(
      lifecycle({
        mergeGate: mergeGate({
          mergeability: {
            status: "conflicted",
            pullRequest: { url: "https://github.com/acme/symphony/pull/42", number: 42, headSha: "head-sha-1", branch: "symphony/TEST-1" },
            mergeable: false,
            mergeableState: "dirty",
            reason: "Pull request branch is out of date",
            baseBranch: "main",
            baseHeadSha: "base-sha-1",
            observedBaseHeadSha: null,
            checkedAt: "2026-01-01T00:00:02.000Z",
          },
        }),
      }),
    );

    expect(result?.kind).toBe("repair");
    expect(result?.text).toContain("not generated from a service-prepared merge-conflict session");
    expect(result?.text).toContain("Do not run git fetch");
    expect(result?.text).toContain("configured merge-conflict state is required");
    expect(result?.text).not.toContain("Symphony prepares merge-conflict worktrees");
    expect(result?.text).not.toContain("Symphony performs service-owned git and PR publication actions");
    expect(result?.text).not.toContain("reconcile the lifecycle-bound PR changes with origin/main");
    expect(result?.text).not.toContain("commit and push the repaired branch");
  });

  it("warns without stale repair details when a merge gate belongs to an older PR head", () => {
    const result = formatWorkerMergeGatePromptResult(
      lifecycle({
        summaryPointers: { prHeadSha: "head-sha-2" },
        mergeGate: mergeGate({
          headSha: "head-sha-1",
          repairRunId: "repair-run-1",
          repairReportId: "completion-report:issue-1:repair-1",
          blockerFingerprint: "head-sha-1:test:failure",
        }),
      }),
    );

    expect(result?.kind).toBe("stale_warning");
    expect(result?.text).toContain("## Symphony Merge Gate Head Advanced");
    expect(result?.text).toContain("Current PR head SHA: head-sha-2");
    expect(result?.text).not.toContain("## Symphony Merge Gate Repair");
    expect(result?.text).not.toContain("test: failing / failure");
    expect(result?.text).not.toContain("Repair round");
    expect(result?.text).not.toContain("Blocker fingerprint");
    expect(result?.text).not.toContain("completion-report:issue-1:repair-1");
  });

  it("warns for a persisted superseded same-PR gate bound to the current head", () => {
    const result = formatWorkerMergeGatePromptResult(
      lifecycle({
        summaryPointers: { prHeadSha: "head-sha-2" },
        mergeGate: mergeGate({
          status: "superseded",
          headSha: "head-sha-1",
          checks: [],
          repairRunId: null,
          repairReportId: null,
          blockerFingerprint: null,
          supersededByHeadSha: "head-sha-2",
        }),
      }),
    );

    expect(result?.kind).toBe("stale_warning");
    expect(result?.text).toContain("## Symphony Merge Gate Head Advanced");
    expect(result?.text).not.toContain("## Symphony Merge Gate Repair");
  });

  function fixture(configure: (config: ReturnType<typeof testConfig>) => void = () => undefined) {
    const config = testConfig(root);
    config.writeback.enabled = true;
    config.writeback.dispatchState = "In Progress";
    config.reviewLoop.reviewStates = ["In Review"];
    config.reviewLoop.reviewPassState = "Ready to Merge";
    configure(config);
    const lifecycleStore = new FileIssueLifecycleStore(root);
    const outbox = new FileWritebackOutboxStore(root);
    const service = new ReviewVerdictService({ config, lifecycleStore, writebackOutbox: outbox });
    return { service, lifecycleStore, outbox, config };
  }
});

function lifecycle(
  overrides: Omit<Partial<IssueLifecycleRecord>, "summaryPointers"> & {
    summaryPointers?: Partial<IssueLifecycleRecord["summaryPointers"]>;
  } = {},
): IssueLifecycleRecord {
  const { summaryPointers: summaryPointerOverrides, ...recordOverrides } = overrides;
  return {
    issueId: "issue-1",
    issueIdentifier: "TEST-1",
    phase: "implementation",
    reviewRound: 1,
    incompleteTurnCount: 0,
    lastIssueBreakdownPlanId: null,
    planningFailureCount: 0,
    planningDispatchRetryCount: 0,
    lastPlanningFailureRunId: null,
    lastPlanningFailureAt: null,
    lastIssueTriageReportId: null,
    lastPostMortemReportId: null,
    lastCompletionReportId: null,
    lastCompletionReportRejectionId: null,
    lastReviewVerdictId: null,
    blockedReason: null,
    summaryPointers: {
      workspaceKey: null,
      workspacePath: null,
      branchName: "symphony/TEST-1",
      gitBranchName: "symphony/TEST-1",
      repoPath: "/repo",
      baseRef: "main",
      lastRunId: null,
      prUrl: "https://github.com/acme/symphony/pull/42",
      prNumber: 42,
      prHeadSha: "head-sha-1",
      prBranch: "symphony/TEST-1",
      ciStatus: null,
      lastPushedAt: null,
      lastEvidenceCursor: null,
      ...summaryPointerOverrides,
    },
    summaryReferences: [],
    issueBreakdownPlans: [],
    completionReports: [],
    completionReportRejections: [],
    reviewVerdicts: [],
    reviewFeedback: [],
    issueTriageReports: [],
    postMortemReports: [],
    reviewEvidence: { pullRequest: null, lastIngestedCursor: null, lastWorkerEvidenceCursor: null, items: [], updatedAt: null },
    mergeGate: mergeGate(),
    mergeConflict: null,
    mergeConflictResolutionReports: [],
    merge: null,
    handoff: {
      version: 1,
      memo: {
        version: 1,
        issueId: "issue-1",
        issueIdentifier: "TEST-1",
        updatedAt: "2026-01-01T00:00:00.000Z",
        reviewRound: 1,
        incompleteTurnCount: 0,
        sizeChars: 0,
        entries: [],
        openFindings: [],
        pointers: {
          workspaceKey: null,
          workspacePath: null,
          branchName: "symphony/TEST-1",
          gitBranchName: "symphony/TEST-1",
          repoPath: "/repo",
          baseRef: "main",
          lastRunId: null,
          prUrl: "https://github.com/acme/symphony/pull/42",
          prNumber: 42,
          prHeadSha: "head-sha-1",
          prBranch: "symphony/TEST-1",
          ciStatus: null,
          lastPushedAt: null,
          lastEvidenceCursor: null,
        },
        lastWorkerRunId: null,
        lastReviewerRunId: null,
      },
      lastWorkerOutput: null,
      lastReviewerOutput: null,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...recordOverrides,
  };
}

function mergeGate(overrides: Partial<IssueMergeGateState> = {}): IssueMergeGateState {
  return {
    id: "merge-gate:issue-1:pr-42:head-sha-1",
    status: "repair_dispatched",
    headSha: "head-sha-1",
    pullRequest: { url: "https://github.com/acme/symphony/pull/42", number: 42, headSha: "head-sha-1", branch: "symphony/TEST-1" },
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
    updatedAt: "2026-01-01T00:00:01.000Z",
    ...overrides,
  };
}

function approvalFeedback(overrides: Partial<IssueReviewFeedbackRecord> = {}): IssueReviewFeedbackRecord {
  return reviewFeedback({
    kind: "review",
    event: "APPROVE",
    body: "Looks good.",
    reviewUrl: "https://github.com/acme/symphony/pull/42#pullrequestreview-1",
    commentUrls: [],
    ...overrides,
  });
}

function requestChangesFeedback(overrides: Partial<IssueReviewFeedbackRecord> = {}): IssueReviewFeedbackRecord {
  return reviewFeedback({
    id: "review-feedback:issue-1:review-run-1:request-changes-1",
    idempotencyKey: "request-changes-1",
    kind: "review",
    event: "REQUEST_CHANGES",
    body: "Please update the tests.",
    reviewUrl: "https://github.com/acme/symphony/pull/42#pullrequestreview-2",
    commentUrls: [],
    ...overrides,
  });
}

function issueCommentFeedback(overrides: Partial<IssueReviewFeedbackRecord> = {}): IssueReviewFeedbackRecord {
  return reviewFeedback({
    id: "review-feedback:issue-1:review-run-1:issue-comment-1",
    idempotencyKey: "issue-comment-1",
    kind: "issue_comment",
    event: null,
    body: "High-level note.",
    reviewUrl: null,
    commentUrls: ["https://github.com/acme/symphony/pull/42#issuecomment-1"],
    ...overrides,
  });
}

function reviewCommentFeedback(overrides: Partial<IssueReviewFeedbackRecord> = {}): IssueReviewFeedbackRecord {
  return reviewFeedback({
    id: "review-feedback:issue-1:review-run-1:review-comment-1",
    idempotencyKey: "review-comment-1",
    kind: "review_comment",
    event: null,
    body: "Inline note.",
    reviewUrl: null,
    commentUrls: ["https://github.com/acme/symphony/pull/42#discussion_r1"],
    ...overrides,
  });
}

function reviewFeedback(overrides: Partial<IssueReviewFeedbackRecord> = {}): IssueReviewFeedbackRecord {
  return {
    id: "review-feedback:issue-1:review-run-1:approve-1",
    idempotencyKey: "approve-1",
    requestHash: "request-hash",
    runId: "review-run-1",
    issueId: "issue-1",
    issueIdentifier: "TEST-1",
    kind: "review",
    event: "APPROVE",
    body: "Looks good.",
    pullRequest: { url: "https://github.com/acme/symphony/pull/42", number: 42, headSha: "head-sha-1", branch: "symphony/TEST-1" },
    reviewer: "reviewer-1",
    reviewUrl: "https://github.com/acme/symphony/pull/42#pullrequestreview-1",
    commentUrls: [],
    submittedAt: "2026-01-01T00:00:02.000Z",
    ...overrides,
  };
}

function completionReport(
  overrides: Partial<IssueLifecycleRecord["completionReports"][number]> = {},
): IssueLifecycleRecord["completionReports"][number] {
  return {
    id: "completion-report:issue-1:report-1",
    idempotencyKey: "report-1",
    runId: "worker-run-1",
    issueId: "issue-1",
    issueIdentifier: "TEST-1",
    summary: "Implemented the requested change.",
    validationEvidence: ["npm test"],
    acceptanceChecklist: [],
    changedFiles: ["src/index.ts"],
    branchName: "symphony/TEST-1",
    pullRequest: {
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headSha: "head-sha-1",
      branch: "symphony/TEST-1",
    },
    risks: [],
    acceptedAt: "2026-01-01T00:00:01.000Z",
    writebackOperationKeys: [],
    ...overrides,
  };
}

function reviewFeedbackBaseRefObservation(): IssueBaseRefObservation {
  return {
    version: 1,
    inputFingerprint: "review-feedback-base-ref-fingerprint",
    classification: "branch_not_based_on_live_base",
    operation: "review_feedback",
    checkedAt: "2026-01-01T00:00:02.000Z",
    workspacePath: "/repo",
    branchName: "symphony/TEST-1",
    baseRef: "origin/main",
    normalizedBaseBranch: "main",
    localBaseRef: "refs/remotes/origin/main",
    githubBaseHeadSha: "base-sha-2",
    localBaseHeadShaBeforeFetch: "base-sha-1",
    localBaseHeadShaAfterFetch: "base-sha-2",
    worktreeHeadSha: "head-sha-1",
    localBaseIsAncestorOfHead: false,
    reason: "Worktree HEAD is not based on the live origin base",
    error: null,
  };
}

function failVerdict(overrides: Partial<ReviewVerdictInput> = {}): ReviewVerdictInput {
  return {
    runId: "review-run-1",
    issueId: "issue-1",
    finalDisposition: "Review failed because the implementation still needs a bounded repair.",
    verdict: "fail",
    acceptanceResults: [
      {
        text: "Duplicate verdicts are idempotent",
        satisfied: false,
        evidence: "No duplicate test was present.",
      },
    ],
    findings: ["Add a regression test for duplicate verdict handling."],
    discoveryFindings: [],
    evidence: ["https://github.com/acme/symphony/pull/42#discussion_r1"],
    idempotencyKey: "verdict-1",
    ...overrides,
  };
}

function passVerdict(overrides: Partial<ReviewVerdictInput> = {}): ReviewVerdictInput {
  return {
    runId: "review-run-1",
    issueId: "issue-1",
    finalDisposition: "Review passed because all acceptance criteria are satisfied.",
    verdict: "pass",
    acceptanceResults: [
      {
        text: "All acceptance criteria satisfied",
        satisfied: true,
        evidence: "Reviewer verified the PR.",
      },
    ],
    findings: [],
    discoveryFindings: [],
    evidence: ["https://github.com/acme/symphony/pull/42#pullrequestreview-1"],
    idempotencyKey: "verdict-pass-1",
    ...overrides,
  };
}

function blockedVerdict(overrides: Partial<ReviewVerdictInput> = {}): ReviewVerdictInput {
  return {
    runId: "review-run-1",
    issueId: "issue-1",
    finalDisposition: "Review is blocked by a non-worker-owned validation constraint.",
    verdict: "blocked",
    acceptanceResults: [
      {
        text: "Required validation evidence is available",
        satisfied: false,
        evidence: "The worker and reviewer command surfaces cannot execute the required validation.",
      },
    ],
    findings: ["Focused validation is unavailable to worker and reviewer command surfaces."],
    gateFindings: [],
    discoveryFindings: [],
    evidence: ["reviewer observed command-policy denial"],
    idempotencyKey: "blocked-verdict-1",
    ...overrides,
  };
}

function gateFinding(
  overrides: Partial<NonNullable<ReviewVerdictInput["gateFindings"]>[number]> = {},
): NonNullable<ReviewVerdictInput["gateFindings"]>[number] {
  return {
    summary: "Add a regression test for duplicate verdict handling.",
    requirementIds: ["REQ-1"],
    contractAnchor: "Issue Contract > Requirements > REQ-1",
    scenario: "Duplicate review verdict submission",
    scenarioEntitlement: "explicit_requirement",
    observedFailure: "The PR has no duplicate verdict regression coverage.",
    currentIssueOwnership: "The issue contract names idempotent duplicate handling as required behavior.",
    boundedRepair: "Add focused duplicate verdict regression coverage.",
    evidence: ["https://github.com/acme/symphony/pull/42#discussion_r1"],
    ...overrides,
  };
}

function discoveryFinding(
  overrides: Partial<NonNullable<ReviewVerdictInput["discoveryFindings"]>[number]> = {},
): NonNullable<ReviewVerdictInput["discoveryFindings"]>[number] {
  return {
    summary: "Sibling workflow coverage may need separate hardening.",
    importance: "medium",
    relationship: "adjacent_sibling",
    discoveryReason: "Review found a nearby scenario that is related but not explicitly owned by this issue contract.",
    suggestedDisposition: "operator_decision",
    scenarioAxes: ["sibling workflow", "fallback state"],
    evidence: ["https://github.com/acme/symphony/pull/42#discussion_r2"],
    ownerIssueIdentifier: null,
    ...overrides,
  };
}

function context(overrides: Partial<ReviewVerdictActiveContext> = {}): ReviewVerdictActiveContext {
  return {
    issue: issue({ state: "In Review", branchName: "symphony/TEST-1" }),
    activeRunId: "review-run-1",
    role: "reviewer",
    token: "review-token",
    expectedToken: "review-token",
    reviewer: "reviewer-1",
    phase: "review",
    ...overrides,
  };
}

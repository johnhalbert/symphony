import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SymphonyError } from "../src/core/errors.js";
import { FileIssueLifecycleStore } from "../src/core/persistence/IssueLifecycleStore.js";
import { ReviewVerdictService, type ReviewVerdictActiveContext, type ReviewVerdictInput } from "../src/core/ReviewVerdictService.js";
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

  it("accepts a fail verdict, records requested revisions, and routes the issue back to implementation", async () => {
    const { service, lifecycleStore, outbox } = fixture();
    await lifecycleStore.ensureIssue(issue({ state: "In Review" }), {
      phase: "review",
      reviewRound: 0,
    });

    const result = await service.submit_review_verdict(failVerdict(), context());

    expect(result.replayed).toBe(false);
    expect(result.writebackOperations).toHaveLength(2);
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      phase: "implementation",
      reviewRound: 1,
      lastReviewVerdictId: "review-verdict:issue-1:verdict-1",
      reviewVerdicts: [
        {
          id: "review-verdict:issue-1:verdict-1",
          idempotencyKey: "verdict-1",
          runId: "review-run-1",
          verdict: "fail",
          findings: ["Add a regression test for duplicate verdict handling."],
          evidence: ["https://github.com/acme/symphony/pull/42#discussion_r1"],
        },
      ],
    });

    const operations = await outbox.list();
    const comment = operations.find((operation) => operation.kind === "comment");
    const transition = operations.find((operation) => operation.kind === "transition");
    expect(comment?.kind === "comment" ? comment.payload.body : "").toContain("Symphony review failed");
    expect(comment?.kind === "comment" ? comment.payload.body : "").toContain(
      "Add a regression test for duplicate verdict handling.",
    );
    expect(comment?.kind === "comment" ? comment.payload.body : "").toContain("[ ] Duplicate verdicts are idempotent");
    expect(comment?.kind === "comment" ? comment.payload.body : "").toContain(
      "https://github.com/acme/symphony/pull/42#discussion_r1",
    );
    expect(transition).toMatchObject({
      idempotencyKey: "transition:issue-1:review-run-1:review-verdict-fail:In Progress",
      kind: "transition",
      payload: {
        fromStates: ["In Review"],
        toState: "In Progress",
      },
    });
  });

  it("does not double count a fail verdict for a reviewer run already recorded by dispatch", async () => {
    const { service, lifecycleStore } = fixture();
    await lifecycleStore.ensureIssue(issue({ state: "In Review" }), {
      phase: "review",
      reviewRound: 1,
      summaryPointers: { lastRunId: "review-run-1" },
    });

    await service.submitReviewVerdict(failVerdict(), context());

    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      reviewRound: 1,
    });
  });

  it("accepts a pass verdict, records verified completion, and applies configured pass behavior", async () => {
    const { service, lifecycleStore, outbox } = fixture();
    await lifecycleStore.ensureIssue(issue({ state: "In Review" }), {
      phase: "review",
      reviewRound: 1,
    });

    const result = await service.submitReviewVerdict(passVerdict(), context());

    expect(result.replayed).toBe(false);
    await expect(lifecycleStore.get("issue-1")).resolves.toMatchObject({
      phase: "passed",
      lastReviewVerdictId: "review-verdict:issue-1:verdict-pass-1",
      reviewVerdicts: [
        {
          id: "review-verdict:issue-1:verdict-pass-1",
          verdict: "pass",
          acceptanceResults: [{ text: "All acceptance criteria satisfied", satisfied: true }],
        },
      ],
    });
    expect((await outbox.list()).find((operation) => operation.kind === "transition")).toMatchObject({
      idempotencyKey: "transition:issue-1:review-run-1:review-verdict-pass:Ready to Merge",
      payload: { toState: "Ready to Merge" },
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
    expect((await lifecycleStore.get("issue-1"))?.reviewVerdicts).toHaveLength(1);
    expect(await outbox.list()).toHaveLength(2);
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
  });

  function fixture() {
    const config = testConfig(root);
    config.writeback.enabled = true;
    config.writeback.dispatchState = "In Progress";
    config.reviewLoop.reviewStates = ["In Review"];
    config.reviewLoop.reviewPassState = "Ready to Merge";
    const lifecycleStore = new FileIssueLifecycleStore(root);
    const outbox = new FileWritebackOutboxStore(root);
    const service = new ReviewVerdictService({ config, lifecycleStore, writebackOutbox: outbox });
    return { service, lifecycleStore, outbox };
  }
});

function failVerdict(overrides: Partial<ReviewVerdictInput> = {}): ReviewVerdictInput {
  return {
    runId: "review-run-1",
    issueId: "issue-1",
    verdict: "fail",
    acceptanceResults: [
      {
        text: "Duplicate verdicts are idempotent",
        satisfied: false,
        evidence: "No duplicate test was present.",
      },
    ],
    findings: ["Add a regression test for duplicate verdict handling."],
    evidence: ["https://github.com/acme/symphony/pull/42#discussion_r1"],
    idempotencyKey: "verdict-1",
    ...overrides,
  };
}

function passVerdict(overrides: Partial<ReviewVerdictInput> = {}): ReviewVerdictInput {
  return {
    runId: "review-run-1",
    issueId: "issue-1",
    verdict: "pass",
    acceptanceResults: [
      {
        text: "All acceptance criteria satisfied",
        satisfied: true,
        evidence: "Reviewer verified the PR.",
      },
    ],
    findings: [],
    evidence: ["https://github.com/acme/symphony/pull/42#pullrequestreview-1"],
    idempotencyKey: "verdict-pass-1",
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

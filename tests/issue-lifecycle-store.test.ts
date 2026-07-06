import { promises as nodeFs } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SymphonyError } from "../src/core/errors.js";
import {
  buildWorkerHandoffPacket,
  FileIssueLifecycleStore,
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
    await writeFile(recordPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

    const reloaded = new FileIssueLifecycleStore(root);

    await expect(reloaded.get("issue-1")).resolves.toMatchObject({
      reviewVerdictSubmissions: [],
    });
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

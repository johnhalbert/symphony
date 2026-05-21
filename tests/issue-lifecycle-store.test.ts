import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SymphonyError } from "../src/core/errors.js";
import { FileIssueLifecycleStore, phaseForIssueState } from "../src/core/persistence/IssueLifecycleStore.js";
import { issue, testConfig } from "./helpers.js";

describe("FileIssueLifecycleStore", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-lifecycle-"));
  });

  afterEach(async () => {
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
        lastRunId: "run-1",
      },
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
      summaryPointers: {
        workspaceKey: "TEST-1",
        workspacePath: "/tmp/TEST-1",
        branchName: "symphony/TEST-1",
        lastRunId: "run-1",
      },
    });
  });

  it("returns null for missing lifecycle records", async () => {
    const store = new FileIssueLifecycleStore(root);
    await expect(store.get("TEST-404")).resolves.toBeNull();
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

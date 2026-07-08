import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  submitMergeConflictResolutionFromMcp,
  writeMergeConflictResolutionMcpContext,
} from "../src/core/harness/MergeConflictResolutionMcpServer.js";
import { FileIssueLifecycleStore } from "../src/core/persistence/IssueLifecycleStore.js";
import { SqliteWritebackOutboxStore } from "../src/core/writeback/WritebackOutbox.js";
import { issue } from "./helpers.js";

const docsProjectContext = {
  projectContextId: "docs-site",
  projectContextLabel: "Documentation Site",
  linearProjectSlug: "DOCS",
  routingSource: "candidate_poll",
} as const;

describe("merge conflict resolution MCP handoff", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-merge-conflict-mcp-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("submits a conflict-fix report through MCP and preserves project context on blocked writebacks", async () => {
    const stateDir = path.join(root, "state");
    const workflowPath = path.join(root, "WORKFLOW.md");
    const contextFile = path.join(root, "merge-conflict-context.json");
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    const candidate = issue({ state: "Approved with Conflicts", branchName: "symphony/TEST-1", projectContext: docsProjectContext });
    await writeFile(workflowPath, workflow(stateDir), "utf8");
    await lifecycleStore.ensureIssue(candidate, {
      projectContext: docsProjectContext,
      phase: "merge_conflict_resolution",
      mergeConflict: mergeConflictRecord({ fixTurnCount: 2 }),
    });
    await writeMergeConflictResolutionMcpContext(contextFile, {
      issue: candidate,
      projectContext: docsProjectContext,
      activeRunId: "conflict-run-1",
      role: "worker",
      token: null,
      expectedToken: null,
      sessionId: "worker-agent:conflict-run-1",
      workspacePath: "/tmp/workspace",
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
      phase: "merge_conflict_resolution",
    });

    const result = await submitMergeConflictResolutionFromMcp(
      resolutionReport({ idempotencyKey: "still-1", resolutionStatus: "still_conflicted" }),
      { workflowPath, contextFile },
    );

    expect(result).toMatchObject({
      accepted: true,
      replayed: false,
      reportId: "merge-conflict-resolution:issue-1:still-1",
      resolutionStatus: "still_conflicted",
    });
    await expect(lifecycleStore.get("TEST-1")).resolves.toMatchObject({
      phase: "blocked",
      blockedReason: "merge conflicts remain unresolved (3/3 conflict-fix attempts)",
      projectContext: docsProjectContext,
      mergeConflict: {
        status: "blocked",
        resolutionStatus: "blocked",
        fixTurnCount: 3,
        attemptRunIds: ["conflict-run-1"],
        blockedReason: "merge conflicts remain unresolved (3/3 conflict-fix attempts)",
      },
      mergeConflictResolutionReports: [
        expect.objectContaining({
          id: "merge-conflict-resolution:issue-1:still-1",
          resolutionStatus: "still_conflicted",
          projectContext: docsProjectContext,
        }),
      ],
    });
    const outbox = await listWritebacks(stateDir);
    expect(outbox.find((operation) => operation.kind === "comment")).toMatchObject({
      kind: "comment",
      runId: "conflict-run-1",
      projectContext: docsProjectContext,
    });
    expect(outbox.find((operation) => operation.kind === "transition")).toMatchObject({
      kind: "transition",
      runId: "conflict-run-1",
      projectContext: docsProjectContext,
      payload: { toState: "Blocked" },
    });
  });
});

async function listWritebacks(stateDir: string) {
  const store = new SqliteWritebackOutboxStore(stateDir);
  try {
    return await store.list();
  } finally {
    await store.close();
  }
}

function workflow(stateDir: string): string {
  return `---
tracker:
  kind: linear
  api_key: linear-test-key
  project_slug: TEST
  active_states:
    - Todo
    - In Progress
    - Approved with Conflicts
writeback:
  enabled: true
  mode: dry_run
  dispatch_state: In Progress
review_loop:
  blocked_states:
    - Blocked
workspace:
  root: "${slash(path.join(path.dirname(stateDir), "workspaces"))}"
  state_dir: "${slash(stateDir)}"
merge_policy:
  mode: gated
  conflicts_state: Approved with Conflicts
  max_conflict_fix_turns: 3
project_contexts:
  - id: default
    label: Default
    tracker:
      project_slug: TEST
    workspace:
      source:
        kind: copy
        path: "${slash(path.join(path.dirname(stateDir), "workspaces"))}"
  - id: docs-site
    label: Documentation Site
    tracker:
      project_slug: DOCS
    workspace:
      source:
        kind: copy
        path: "${slash(path.join(path.dirname(stateDir), "workspaces"))}"
---
Work on {{ issue.identifier }}.
`;
}

function slash(value: string): string {
  return value.replace(/\\/g, "/");
}

function resolutionReport(input: {
  idempotencyKey?: string;
  resolutionStatus: "resolved" | "still_conflicted" | "blocked";
}) {
  return {
    summary: "Resolved merge conflicts.",
    validationEvidence: ["npm test"],
    changedFiles: ["src/index.ts"],
    pullRequest: {
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headSha: "head-sha-1",
      branch: "symphony/TEST-1",
    },
    previousHeadSha: "head-sha-1",
    newHeadSha: "head-sha-1",
    baseBranch: "main",
    baseHeadSha: "base-sha-1",
    risks: [],
    resolutionStatus: input.resolutionStatus,
    idempotencyKey: input.idempotencyKey ?? "resolve-1",
  };
}

function mergeConflictRecord(input: { fixTurnCount: number }) {
  return {
    id: "merge-conflict:issue-1:head-sha-1",
    status: "open" as const,
    resolutionStatus: "pending" as const,
    pullRequest: {
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headSha: "head-sha-1",
      branch: "symphony/TEST-1",
    },
    approvedHeadSha: "head-sha-1",
    currentHeadSha: "head-sha-1",
    resolvedHeadSha: null,
    baseBranch: "main",
    baseHeadSha: "base-sha-1",
    sourceState: "Ready to Merge",
    conflictsState: "Approved with Conflicts",
    reason: "Pull request has merge conflicts with the base branch",
    mergeableState: "dirty",
    servicePreparation: null,
    detectedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    fixTurnCount: input.fixTurnCount,
    maxFixTurns: 3,
    lastConflictFixRunId: null,
    lastConflictResolutionReportId: null,
    attemptRunIds: [],
    writebackOperationKeys: [],
    blockedAt: null,
    blockedReason: null,
  };
}

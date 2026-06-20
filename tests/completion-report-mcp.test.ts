import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CompletionReportPullRequestPublication,
  CompletionReportPullRequestPublicationInput,
  CompletionReportPullRequestPublisher,
} from "../src/core/CompletionReportService.js";
import {
  COMPLETION_REPORT_TOOL_NAME,
  runCompletionReportMcpServer,
  submitCompletionReportFromMcp,
  writeCompletionReportMcpContext,
} from "../src/core/harness/CompletionReportMcpServer.js";
import { FileIssueLifecycleStore } from "../src/core/persistence/IssueLifecycleStore.js";
import { FileRunTranscriptStore } from "../src/core/persistence/RunTranscriptStore.js";
import { FileWritebackOutboxStore } from "../src/core/writeback/WritebackOutbox.js";
import { issue } from "./helpers.js";

const docsProjectContext = {
  projectContextId: "docs",
  projectContextLabel: "Documentation Site",
  linearProjectSlug: "DOCS",
  routingSource: "candidate_poll",
} as const;

const apiProjectContext = {
  projectContextId: "api",
  projectContextLabel: "API Service",
  linearProjectSlug: "API",
  routingSource: "candidate_poll",
} as const;

describe("completion report MCP handoff", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-completion-mcp-"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("submits a worker completion report through CompletionReportService before review writeback", async () => {
    const stateDir = path.join(root, "state");
    const workflowPath = path.join(root, "WORKFLOW.md");
    const contextFile = path.join(root, "context.json");
    await writeFile(workflowPath, workflow(stateDir), "utf8");
    const runStore = new FileRunTranscriptStore(stateDir);
    await runStore.startRun({
      runId: "run-1",
      sessionId: "agent-1:run-1",
      agentId: "agent-1",
      role: "worker",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      projectContext: docsProjectContext,
      attempt: null,
      turnNumber: 1,
      prompt: "work",
      workspaceKey: "TEST-1",
      workspacePath: "/tmp/workspace",
      gitBranchName: "symphony/TEST-1",
      repoPath: "/repo",
      baseRef: "main",
    });
    await new FileIssueLifecycleStore(stateDir).ensureIssue(issue({ state: "In Progress", branchName: "symphony/TEST-1" }), {
      projectContext: docsProjectContext,
      phase: "implementation",
      summaryPointers: { lastRunId: "run-1" },
    });
    await writeCompletionReportMcpContext(contextFile, {
      issue: issue({ state: "In Progress", branchName: "symphony/TEST-1" }),
      projectContext: docsProjectContext,
      activeRunId: "run-1",
      role: "worker",
      token: null,
      expectedToken: null,
      sessionId: "agent-1:run-1",
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
      phase: "implementation",
    });
    const publisher = new FakePublisher({
      action: "created",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headBranch: "symphony/TEST-1",
      headSha: "abc123",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "idem-1",
    });

    const result = await submitCompletionReportFromMcp(
      report(),
      mcpOptions(workflowPath, contextFile, { pullRequestPublisher: publisher }),
    );

    expect(result).toMatchObject({
      accepted: true,
      replayed: false,
      reportId: "completion-report:issue-1:idem-1",
      pullRequest: {
        url: "https://github.com/acme/symphony/pull/42",
        number: 42,
        headSha: "abc123",
        branch: "symphony/TEST-1",
      },
    });
    expect(publisher.inputs).toHaveLength(1);
    expect(publisher.inputs[0]).toMatchObject({
      branchName: "symphony/TEST-1",
      baseBranch: "main",
      title: "TEST-1: Do work",
      evidenceCursor: "idem-1",
    });
    expect(publisher.inputs[0]?.body).toContain("Issue: TEST-1");
    const outbox = await new FileWritebackOutboxStore(stateDir).list();
    const comment = outbox.find((operation) => operation.kind === "comment");
    const transition = outbox.find((operation) => operation.kind === "transition");
    expect(comment).toMatchObject({
      kind: "comment",
      projectContext: docsProjectContext,
    });
    expect(comment?.kind === "comment" ? comment.payload.body : "").toContain(
      "https://github.com/acme/symphony/pull/42",
    );
    expect(transition).toMatchObject({
      kind: "transition",
      projectContext: docsProjectContext,
      payload: { toState: "Human Review" },
    });
    await expect(new FileIssueLifecycleStore(stateDir).get("TEST-1")).resolves.toMatchObject({
      phase: "review",
      projectContext: docsProjectContext,
      completionReports: [expect.objectContaining({ projectContext: docsProjectContext })],
      summaryPointers: {
        prUrl: "https://github.com/acme/symphony/pull/42",
        prNumber: 42,
        prHeadSha: "abc123",
        prBranch: "symphony/TEST-1",
        lastEvidenceCursor: "idem-1",
      },
    });
    await expect(runStore.getRun("run-1")).resolves.toMatchObject({
      prUrl: "https://github.com/acme/symphony/pull/42",
      prNumber: 42,
      prHeadSha: "abc123",
      prBranch: "symphony/TEST-1",
      lastEvidenceCursor: "idem-1",
    });
  });

  it("rejects completion report MCP submission when the persisted lifecycle phase is no longer implementation", async () => {
    const stateDir = path.join(root, "state");
    const workflowPath = path.join(root, "WORKFLOW.md");
    const contextFile = path.join(root, "context.json");
    await writeFile(workflowPath, workflow(stateDir), "utf8");
    const runStore = new FileRunTranscriptStore(stateDir);
    await runStore.startRun({
      runId: "run-stale-lifecycle-phase",
      sessionId: "agent-1:run-stale-lifecycle-phase",
      agentId: "agent-1",
      role: "worker",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      projectContext: docsProjectContext,
      attempt: null,
      turnNumber: 1,
      prompt: "work",
      workspaceKey: "TEST-1",
      workspacePath: "/tmp/workspace",
      gitBranchName: "symphony/TEST-1",
      repoPath: "/repo",
      baseRef: "main",
    });
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    await lifecycleStore.ensureIssue(issue({ state: "In Progress", branchName: "symphony/TEST-1" }), {
      projectContext: docsProjectContext,
      phase: "review",
      summaryPointers: { lastRunId: "run-stale-lifecycle-phase" },
    });
    await writeCompletionReportMcpContext(contextFile, {
      issue: issue({
        state: "In Progress",
        branchName: "symphony/TEST-1",
        title: "FORGED TITLE FROM WORKER CONTEXT",
      }),
      projectContext: docsProjectContext,
      activeRunId: "run-stale-lifecycle-phase",
      role: "worker",
      token: null,
      expectedToken: null,
      sessionId: "agent-1:run-stale-lifecycle-phase",
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
      phase: "implementation",
    });
    const publisher = new FakePublisher({
      action: "created",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headSha: "abc123",
      headBranch: "symphony/TEST-1",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "stale-phase-idem",
    });

    await expect(
      submitCompletionReportFromMcp(
        report("stale-lifecycle-phase-idem"),
        mcpOptions(workflowPath, contextFile, {
          pullRequestPublisher: publisher,
          tracker: fakeTracker(issue({ state: "In Progress", branchName: "symphony/TEST-1" })),
        }),
      ),
    ).rejects.toThrow("Completion report cannot be accepted while lifecycle phase is review");
    expect(publisher.inputs).toEqual([]);
    await expect(new FileWritebackOutboxStore(stateDir).list()).resolves.toEqual([]);
    await expect(lifecycleStore.get("TEST-1")).resolves.toMatchObject({
      phase: "review",
      lastCompletionReportId: null,
      completionReports: [],
      summaryPointers: { lastRunId: "run-stale-lifecycle-phase" },
    });
  });

  it("uses authoritative tracker issue metadata for PR publication instead of worker-supplied MCP issue fields", async () => {
    const stateDir = path.join(root, "state");
    const workflowPath = path.join(root, "WORKFLOW.md");
    const contextFile = path.join(root, "context.json");
    await writeFile(workflowPath, workflow(stateDir), "utf8");
    const runStore = new FileRunTranscriptStore(stateDir);
    await runStore.startRun({
      runId: "run-authoritative-issue-metadata",
      sessionId: "agent-1:run-authoritative-issue-metadata",
      agentId: "agent-1",
      role: "worker",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      projectContext: docsProjectContext,
      attempt: null,
      turnNumber: 1,
      prompt: "work",
      workspaceKey: "TEST-1",
      workspacePath: "/tmp/workspace",
      gitBranchName: "symphony/TEST-1",
      repoPath: "/repo",
      baseRef: "main",
    });
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    await lifecycleStore.ensureIssue(issue({ state: "In Progress", branchName: "symphony/TEST-1" }), {
      projectContext: docsProjectContext,
      phase: "implementation",
      summaryPointers: { lastRunId: "run-authoritative-issue-metadata" },
    });
    await writeCompletionReportMcpContext(contextFile, {
      issue: issue({
        state: "In Review",
        branchName: "forged-branch",
        title: "FORGED TITLE FROM WORKER CONTEXT",
      }),
      projectContext: docsProjectContext,
      activeRunId: "run-authoritative-issue-metadata",
      role: "worker",
      token: null,
      expectedToken: null,
      sessionId: "agent-1:run-authoritative-issue-metadata",
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
      phase: "implementation",
    });
    const publisher = new FakePublisher({
      action: "created",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headSha: "abc123",
      headBranch: "symphony/TEST-1",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "authoritative-issue-idem",
    });

    const result = await submitCompletionReportFromMcp(
      report("authoritative-issue-idem"),
      mcpOptions(workflowPath, contextFile, {
        pullRequestPublisher: publisher,
        tracker: fakeTracker(issue({ state: "In Progress", branchName: "symphony/TEST-1", title: "Do work" })),
      }),
    );

    expect(result).toMatchObject({
      accepted: true,
      replayed: false,
      reportId: "completion-report:issue-1:authoritative-issue-idem",
    });
    expect(publisher.inputs).toHaveLength(1);
    expect(publisher.inputs[0]).toMatchObject({
      branchName: "symphony/TEST-1",
      title: "TEST-1: Do work",
    });
    expect(publisher.inputs[0]?.title).not.toContain("FORGED TITLE FROM WORKER CONTEXT");
    expect(publisher.inputs[0]?.body).toContain("Issue: TEST-1");
    expect(publisher.inputs[0]?.body).not.toContain("FORGED TITLE FROM WORKER CONTEXT");
  });

  it("ignores forged completion report branchName when lifecycle summaryPointers own the service branch", async () => {
    const stateDir = path.join(root, "state");
    const workflowPath = path.join(root, "WORKFLOW.md");
    const contextFile = path.join(root, "context.json");
    await writeFile(workflowPath, workflow(stateDir), "utf8");
    const runStore = new FileRunTranscriptStore(stateDir);
    await runStore.startRun({
      runId: "run-branch-fallback",
      sessionId: "agent-1:run-branch-fallback",
      agentId: "agent-1",
      role: "worker",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      projectContext: docsProjectContext,
      attempt: null,
      turnNumber: 1,
      prompt: "work",
      workspaceKey: "TEST-1",
      workspacePath: "/tmp/workspace",
      repoPath: "/repo",
      baseRef: "main",
    });
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    await lifecycleStore.ensureIssue(issue({ state: "In Progress", branchName: null }), {
      projectContext: docsProjectContext,
      phase: "implementation",
      summaryPointers: {
        lastRunId: "run-branch-fallback",
        branchName: "service-owned-branch",
        gitBranchName: "service-owned-branch",
      },
    });
    await writeCompletionReportMcpContext(contextFile, {
      issue: issue({ state: "In Progress", branchName: null }),
      projectContext: docsProjectContext,
      activeRunId: "run-branch-fallback",
      role: "worker",
      token: null,
      expectedToken: null,
      sessionId: "agent-1:run-branch-fallback",
      workspacePath: "/tmp/workspace",
      workspace: {
        path: "/tmp/workspace",
        workspaceKey: "TEST-1",
        createdNow: false,
        issueId: "issue-1",
        issueIdentifier: "TEST-1",
        repoPath: "/repo",
        baseRef: "main",
      },
      phase: "implementation",
    });
    const publisher = new FakePublisher({
      action: "created",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headSha: "abc123",
      headBranch: "service-owned-branch",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "branch-fallback-idem",
    });

    const result = await submitCompletionReportFromMcp(
      { ...report("branch-fallback-idem"), branchName: "forged-report-branch" },
      mcpOptions(workflowPath, contextFile, {
        pullRequestPublisher: publisher,
        tracker: fakeTracker(issue({ state: "In Progress", branchName: null, title: "Do work" })),
      }),
    );

    expect(result).toMatchObject({
      accepted: true,
      replayed: false,
      reportId: "completion-report:issue-1:branch-fallback-idem",
    });
    expect(publisher.inputs).toHaveLength(1);
    expect(publisher.inputs[0]).toMatchObject({
      branchName: "service-owned-branch",
      title: "TEST-1: Do work",
    });
    expect(publisher.inputs[0]?.branchName).not.toBe("forged-report-branch");
    await expect(lifecycleStore.get("TEST-1")).resolves.toMatchObject({
      phase: "review",
      summaryPointers: {
        branchName: "service-owned-branch",
        gitBranchName: "service-owned-branch",
        prBranch: "service-owned-branch",
        lastEvidenceCursor: "branch-fallback-idem",
      },
    });
  });

  it("rejects completion report MCP submission when the authoritative issue state is no longer the active implementation state", async () => {
    const stateDir = path.join(root, "state");
    const workflowPath = path.join(root, "WORKFLOW.md");
    const contextFile = path.join(root, "context.json");
    await writeFile(workflowPath, workflow(stateDir), "utf8");
    const runStore = new FileRunTranscriptStore(stateDir);
    await runStore.startRun({
      runId: "run-authoritative-issue-state",
      sessionId: "agent-1:run-authoritative-issue-state",
      agentId: "agent-1",
      role: "worker",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      projectContext: docsProjectContext,
      attempt: null,
      turnNumber: 1,
      prompt: "work",
      workspaceKey: "TEST-1",
      workspacePath: "/tmp/workspace",
      gitBranchName: "symphony/TEST-1",
      repoPath: "/repo",
      baseRef: "main",
    });
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    await lifecycleStore.ensureIssue(issue({ state: "In Progress", branchName: "symphony/TEST-1" }), {
      projectContext: docsProjectContext,
      phase: "implementation",
      summaryPointers: { lastRunId: "run-authoritative-issue-state" },
    });
    await writeCompletionReportMcpContext(contextFile, {
      issue: issue({ state: "In Progress", branchName: "symphony/TEST-1" }),
      projectContext: docsProjectContext,
      activeRunId: "run-authoritative-issue-state",
      role: "worker",
      token: null,
      expectedToken: null,
      sessionId: "agent-1:run-authoritative-issue-state",
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
      phase: "implementation",
    });
    const publisher = new FakePublisher({
      action: "created",
      url: "https://github.com/acme/symphony/pull/42",
      number: 42,
      headSha: "abc123",
      headBranch: "symphony/TEST-1",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "authoritative-state-idem",
    });

    await expect(
      submitCompletionReportFromMcp(
        report("authoritative-state-idem"),
        mcpOptions(workflowPath, contextFile, {
          pullRequestPublisher: publisher,
          tracker: fakeTracker(issue({ state: "In Review", branchName: "symphony/TEST-1" })),
        }),
      ),
    ).rejects.toThrow("Completion report requires the issue to be in the active implementation state");
    expect(publisher.inputs).toEqual([]);
    await expect(new FileWritebackOutboxStore(stateDir).list()).resolves.toEqual([]);
    await expect(lifecycleStore.get("TEST-1")).resolves.toMatchObject({
      phase: "implementation",
      lastCompletionReportId: null,
      completionReports: [],
      summaryPointers: { lastRunId: "run-authoritative-issue-state" },
    });
  });

  it("rejects completion report MCP submission when the issue context does not match the active run", async () => {
    const stateDir = path.join(root, "state");
    const workflowPath = path.join(root, "WORKFLOW.md");
    const contextFile = path.join(root, "context.json");
    await writeFile(workflowPath, workflow(stateDir, false), "utf8");
    const runStore = new FileRunTranscriptStore(stateDir);
    await runStore.startRun({
      runId: "run-issue-mismatch",
      sessionId: "agent-1:run-issue-mismatch",
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
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    await lifecycleStore.ensureIssue(issue({ state: "In Progress", branchName: "symphony/TEST-1" }), {
      phase: "implementation",
      summaryPointers: { lastRunId: "run-issue-mismatch" },
    });
    await writeCompletionReportMcpContext(contextFile, {
      issue: issue({ id: "issue-2", identifier: "TEST-2", state: "In Progress", branchName: "symphony/TEST-1" }),
      activeRunId: "run-issue-mismatch",
      role: "worker",
      token: null,
      expectedToken: null,
      sessionId: "agent-1:run-issue-mismatch",
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
      phase: "implementation",
    });

    await expect(
      submitCompletionReportFromMcp(report("context-issue-mismatch"), mcpOptions(workflowPath, contextFile)),
    ).rejects.toThrow("Completion report MCP context does not match the active worker run");
    await expect(new FileWritebackOutboxStore(stateDir).list()).resolves.toEqual([]);
    await expect(lifecycleStore.get("TEST-1")).resolves.toMatchObject({
      phase: "implementation",
      summaryPointers: { lastRunId: "run-issue-mismatch" },
      completionReports: [],
    });
  });

  it("rejects completion report MCP submission when the project context does not match the active run", async () => {
    const stateDir = path.join(root, "state");
    const workflowPath = path.join(root, "WORKFLOW.md");
    const contextFile = path.join(root, "context.json");
    await writeFile(workflowPath, workflow(stateDir, false), "utf8");
    const runStore = new FileRunTranscriptStore(stateDir);
    await runStore.startRun({
      runId: "run-project-context-mismatch",
      sessionId: "agent-1:run-project-context-mismatch",
      agentId: "agent-1",
      role: "worker",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      projectContext: docsProjectContext,
      attempt: null,
      turnNumber: 1,
      prompt: "work",
      workspaceKey: "TEST-1",
      workspacePath: "/tmp/workspace",
      gitBranchName: "symphony/TEST-1",
      repoPath: "/repo",
      baseRef: "main",
    });
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    await lifecycleStore.ensureIssue(issue({ state: "In Progress", branchName: "symphony/TEST-1" }), {
      projectContext: docsProjectContext,
      phase: "implementation",
      summaryPointers: { lastRunId: "run-project-context-mismatch" },
    });
    await writeCompletionReportMcpContext(contextFile, {
      issue: issue({ state: "In Progress", branchName: "symphony/TEST-1" }),
      projectContext: apiProjectContext,
      activeRunId: "run-project-context-mismatch",
      role: "worker",
      token: null,
      expectedToken: null,
      sessionId: "agent-1:run-project-context-mismatch",
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
      phase: "implementation",
    });

    await expect(
      submitCompletionReportFromMcp(report("context-project-mismatch"), mcpOptions(workflowPath, contextFile)),
    ).rejects.toThrow("Completion report MCP context does not match the active worker run");
    await expect(new FileWritebackOutboxStore(stateDir).list()).resolves.toEqual([]);
    await expect(lifecycleStore.get("TEST-1")).resolves.toMatchObject({
      phase: "implementation",
      projectContext: docsProjectContext,
      summaryPointers: { lastRunId: "run-project-context-mismatch" },
      completionReports: [],
    });
  });

  it("accepts completion report MCP submission when only same-context metadata drifts and preserves the service-owned context", async () => {
    const stateDir = path.join(root, "state");
    const workflowPath = path.join(root, "WORKFLOW.md");
    const contextFile = path.join(root, "context.json");
    await writeFile(workflowPath, workflow(stateDir, false), "utf8");
    const runStore = new FileRunTranscriptStore(stateDir);
    await runStore.startRun({
      runId: "run-project-context-field-mismatch",
      sessionId: "agent-1:run-project-context-field-mismatch",
      agentId: "agent-1",
      role: "worker",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      projectContext: docsProjectContext,
      attempt: null,
      turnNumber: 1,
      prompt: "work",
      workspaceKey: "TEST-1",
      workspacePath: "/tmp/workspace",
      gitBranchName: "symphony/TEST-1",
      repoPath: "/repo",
      baseRef: "main",
    });
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    await lifecycleStore.ensureIssue(issue({ state: "In Progress", branchName: "symphony/TEST-1" }), {
      projectContext: docsProjectContext,
      phase: "implementation",
      summaryPointers: { lastRunId: "run-project-context-field-mismatch" },
    });
    await writeCompletionReportMcpContext(contextFile, {
      issue: issue({ state: "In Progress", branchName: "symphony/TEST-1" }),
      projectContext: {
        projectContextId: docsProjectContext.projectContextId,
        projectContextLabel: "Documentation Site Drift",
        linearProjectSlug: "DOCS-ALT",
        routingSource: "state_refresh",
      },
      activeRunId: "run-project-context-field-mismatch",
      role: "worker",
      token: null,
      expectedToken: null,
      sessionId: "agent-1:run-project-context-field-mismatch",
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
      phase: "implementation",
    });

    const result = await submitCompletionReportFromMcp(
      report("context-project-fields-drift-accepted"),
      mcpOptions(workflowPath, contextFile),
    );
    expect(result).toMatchObject({
      accepted: true,
      replayed: false,
      reportId: "completion-report:issue-1:context-project-fields-drift-accepted",
    });
    const outbox = await new FileWritebackOutboxStore(stateDir).list();
    expect(outbox.find((operation) => operation.kind === "transition")).toMatchObject({
      projectContext: docsProjectContext,
      payload: { toState: "In Review" },
    });
    await expect(lifecycleStore.get("TEST-1")).resolves.toMatchObject({
      phase: "review",
      projectContext: docsProjectContext,
      summaryPointers: { lastRunId: "run-project-context-field-mismatch" },
      completionReports: [expect.objectContaining({ projectContext: docsProjectContext })],
    });
  });

  it("rejects completion report MCP submission when activeRunId is swapped to a completed sibling run", async () => {
    const stateDir = path.join(root, "state");
    const workflowPath = path.join(root, "WORKFLOW.md");
    const contextFile = path.join(root, "context.json");
    await writeFile(workflowPath, workflow(stateDir, false), "utf8");
    const runStore = new FileRunTranscriptStore(stateDir);
    await runStore.startRun({
      runId: "run-old",
      sessionId: "agent-old:run-old",
      agentId: "agent-old",
      role: "worker",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      projectContext: docsProjectContext,
      attempt: null,
      turnNumber: 1,
      prompt: "work",
      workspaceKey: "TEST-1",
      workspacePath: "/tmp/workspace",
      gitBranchName: "symphony/TEST-1",
      repoPath: "/repo",
      baseRef: "main",
    });
    await runStore.updateRun("run-old", { status: "succeeded", completedAt: new Date().toISOString() });
    await runStore.startRun({
      runId: "run-current",
      sessionId: "agent-current:run-current",
      agentId: "agent-current",
      role: "worker",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      projectContext: docsProjectContext,
      attempt: null,
      turnNumber: 2,
      prompt: "work",
      workspaceKey: "TEST-1",
      workspacePath: "/tmp/workspace",
      gitBranchName: "symphony/TEST-1",
      repoPath: "/repo",
      baseRef: "main",
    });
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    await lifecycleStore.ensureIssue(issue({ state: "In Progress", branchName: "symphony/TEST-1" }), {
      projectContext: docsProjectContext,
      phase: "implementation",
      summaryPointers: { lastRunId: "run-current" },
    });
    await writeCompletionReportMcpContext(contextFile, {
      issue: issue({ state: "In Progress", branchName: "symphony/TEST-1" }),
      projectContext: docsProjectContext,
      activeRunId: "run-old",
      role: "worker",
      token: null,
      expectedToken: null,
      sessionId: "agent-current:run-current",
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
      phase: "implementation",
    });

    await expect(
      submitCompletionReportFromMcp(report("context-alt-run-mismatch"), mcpOptions(workflowPath, contextFile)),
    ).rejects.toThrow("Completion report MCP context does not match the active worker run");
    await expect(new FileWritebackOutboxStore(stateDir).list()).resolves.toEqual([]);
    await expect(lifecycleStore.get("TEST-1")).resolves.toMatchObject({
      phase: "implementation",
      projectContext: docsProjectContext,
      summaryPointers: { lastRunId: "run-current" },
      completionReports: [],
    });
    await expect(runStore.getRun("run-old")).resolves.toMatchObject({ status: "succeeded" });
    await expect(runStore.getRun("run-current")).resolves.toMatchObject({ status: "running" });
  });

  it("rejects completion report MCP submission when activeRunId targets a non-implementation worker run", async () => {
    const stateDir = path.join(root, "state");
    const workflowPath = path.join(root, "WORKFLOW.md");
    const contextFile = path.join(root, "context.json");
    await writeFile(workflowPath, workflow(stateDir, false), "utf8");
    const runStore = new FileRunTranscriptStore(stateDir);
    await runStore.startRun({
      runId: "run-merge-repair",
      sessionId: "agent-1:run-merge-repair",
      agentId: "agent-1",
      role: "worker",
      runPhase: "merge_conflict_resolution",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      projectContext: docsProjectContext,
      attempt: null,
      turnNumber: 1,
      prompt: "work",
      workspaceKey: "TEST-1",
      workspacePath: "/tmp/workspace",
      gitBranchName: "symphony/TEST-1",
      repoPath: "/repo",
      baseRef: "main",
    });
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    await lifecycleStore.ensureIssue(issue({ state: "In Progress", branchName: "symphony/TEST-1" }), {
      projectContext: docsProjectContext,
      phase: "implementation",
      summaryPointers: { lastRunId: "run-merge-repair" },
    });
    await writeCompletionReportMcpContext(contextFile, {
      issue: issue({ state: "In Progress", branchName: "symphony/TEST-1" }),
      projectContext: docsProjectContext,
      activeRunId: "run-merge-repair",
      role: "worker",
      token: null,
      expectedToken: null,
      sessionId: "agent-1:run-merge-repair",
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
      phase: "implementation",
    });

    await expect(
      submitCompletionReportFromMcp(report("context-run-phase-mismatch"), mcpOptions(workflowPath, contextFile)),
    ).rejects.toThrow("Completion report MCP context does not match the active worker run");
    await expect(new FileWritebackOutboxStore(stateDir).list()).resolves.toEqual([]);
    await expect(lifecycleStore.get("TEST-1")).resolves.toMatchObject({
      phase: "implementation",
      projectContext: docsProjectContext,
      summaryPointers: { lastRunId: "run-merge-repair" },
      completionReports: [],
    });
  });

  it("replays duplicate completion report MCP submission after the originating run completes", async () => {
    const stateDir = path.join(root, "state");
    const workflowPath = path.join(root, "WORKFLOW.md");
    const contextFile = path.join(root, "context.json");
    await writeFile(workflowPath, workflow(stateDir, false), "utf8");
    const runStore = new FileRunTranscriptStore(stateDir);
    await runStore.startRun({
      runId: "run-replay-after-completion",
      sessionId: "agent-1:run-replay-after-completion",
      agentId: "agent-1",
      role: "worker",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      projectContext: docsProjectContext,
      attempt: null,
      turnNumber: 1,
      prompt: "work",
      workspaceKey: "TEST-1",
      workspacePath: "/tmp/workspace",
      gitBranchName: "symphony/TEST-1",
      repoPath: "/repo",
      baseRef: "main",
    });
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    await lifecycleStore.ensureIssue(issue({ state: "In Progress", branchName: "symphony/TEST-1" }), {
      projectContext: docsProjectContext,
      phase: "implementation",
      summaryPointers: { lastRunId: "run-replay-after-completion" },
    });
    await writeCompletionReportMcpContext(contextFile, {
      issue: issue({ state: "In Progress", branchName: "symphony/TEST-1" }),
      projectContext: docsProjectContext,
      activeRunId: "run-replay-after-completion",
      role: "worker",
      token: null,
      expectedToken: null,
      sessionId: "agent-1:run-replay-after-completion",
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
      phase: "implementation",
    });

    const first = await submitCompletionReportFromMcp(
      report("replay-after-completion"),
      mcpOptions(workflowPath, contextFile),
    );
    await runStore.updateRun("run-replay-after-completion", { status: "succeeded", completedAt: new Date().toISOString() });
    const second = await submitCompletionReportFromMcp(
      report("replay-after-completion"),
      mcpOptions(workflowPath, contextFile),
    );
    await lifecycleStore.ensureIssue(issue({ state: "In Review", branchName: "symphony/TEST-1" }), {
      summaryPointers: { lastRunId: "run-review-1" },
    });
    const third = await submitCompletionReportFromMcp(
      report("replay-after-completion"),
      mcpOptions(workflowPath, contextFile),
    );
    const fourth = await submitCompletionReportFromMcp(
      report("replay-after-completion"),
      mcpOptions(workflowPath, contextFile, {
        tracker: {
          async fetchIssueStatesByIds(_issueIds: string[]): Promise<ReturnType<typeof issue>[]> {
            throw new Error("tracker unavailable");
          },
        },
      }),
    );
    const fifth = await submitCompletionReportFromMcp(
      report("replay-after-completion"),
      mcpOptions(workflowPath, contextFile, {
        tracker: {
          async fetchIssueStatesByIds(_issueIds: string[]): Promise<ReturnType<typeof issue>[]> {
            return [];
          },
        },
      }),
    );

    expect(first).toMatchObject({ accepted: true, replayed: false });
    expect(second).toMatchObject({
      accepted: true,
      replayed: true,
      reportId: "completion-report:issue-1:replay-after-completion",
    });
    expect(third).toMatchObject({
      accepted: true,
      replayed: true,
      reportId: "completion-report:issue-1:replay-after-completion",
    });
    expect(fourth).toMatchObject({
      accepted: true,
      replayed: true,
      reportId: "completion-report:issue-1:replay-after-completion",
    });
    expect(fifth).toMatchObject({
      accepted: true,
      replayed: true,
      reportId: "completion-report:issue-1:replay-after-completion",
    });
    await expect(new FileWritebackOutboxStore(stateDir).list()).resolves.toHaveLength(2);
    await expect(lifecycleStore.get("TEST-1")).resolves.toMatchObject({
      phase: "review",
      lastCompletionReportId: "completion-report:issue-1:replay-after-completion",
      summaryPointers: { lastRunId: "run-review-1" },
      completionReports: [
        expect.objectContaining({ runId: "run-replay-after-completion", idempotencyKey: "replay-after-completion" }),
      ],
    });
  });

  it("fails closed for pending completion report MCP replays when the tracker cannot load authoritative issue state", async () => {
    const stateDir = path.join(root, "state");
    const workflowPath = path.join(root, "WORKFLOW.md");
    const contextFile = path.join(root, "context.json");
    await writeFile(workflowPath, workflow(stateDir, false), "utf8");
    const runStore = new FileRunTranscriptStore(stateDir);
    await runStore.startRun({
      runId: "run-pending-replay",
      sessionId: "agent-1:run-pending-replay",
      agentId: "agent-1",
      role: "worker",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      projectContext: docsProjectContext,
      attempt: null,
      turnNumber: 1,
      prompt: "work",
      workspaceKey: "TEST-1",
      workspacePath: "/tmp/workspace",
      gitBranchName: "symphony/TEST-1",
      repoPath: "/repo",
      baseRef: "main",
    });
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    await lifecycleStore.ensureIssue(issue({ state: "In Progress", branchName: "symphony/TEST-1", title: "Authoritative title" }), {
      projectContext: docsProjectContext,
      phase: "blocked",
      blockedReason: "publication approval setup incomplete",
      lastCompletionReportId: "completion-report:issue-1:pending-replay",
      summaryPointers: {
        lastRunId: "run-pending-replay",
        workspacePath: "/tmp/workspace",
        workspaceKey: "TEST-1",
        repoPath: "/repo",
        baseRef: "main",
        branchName: "symphony/TEST-1",
        issueTitle: "Authoritative title",
        gitBranchName: "symphony/TEST-1",
      },
      completionReports: [
        {
          id: "completion-report:issue-1:pending-replay",
          idempotencyKey: "pending-replay",
          runId: "run-pending-replay",
          issueId: "issue-1",
          issueIdentifier: "TEST-1",
          projectContext: docsProjectContext,
          summary: "Implemented the service contract.",
          validationEvidence: ["npm test"],
          acceptanceChecklist: [
            {
              text: "Completion reports are persisted.",
              satisfied: true,
              evidence: "Lifecycle store records completionReports.",
            },
          ],
          changedFiles: ["src/core/CompletionReportService.ts"],
          branchName: "forged-report-branch",
          pullRequest: null,
          risks: [],
          acceptedAt: "2026-01-01T00:00:00.000Z",
          writebackOperationKeys: [],
        },
      ],
    });
    await writeCompletionReportMcpContext(contextFile, {
      issue: issue({ state: "In Progress", branchName: "symphony/TEST-1", title: "FORGED TITLE FROM CALLER" }),
      projectContext: docsProjectContext,
      activeRunId: "run-pending-replay",
      role: "worker",
      token: null,
      expectedToken: null,
      sessionId: "agent-1:run-pending-replay",
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
      phase: "implementation",
    });

    await expect(
      submitCompletionReportFromMcp(
        report("pending-replay"),
        mcpOptions(workflowPath, contextFile, {
          tracker: {
            async fetchIssueStatesByIds(_issueIds: string[]): Promise<ReturnType<typeof issue>[]> {
              throw new Error("tracker unavailable");
            },
          },
        }),
      ),
    ).rejects.toThrow("Completion report MCP could not load the authoritative issue state");
    await expect(
      submitCompletionReportFromMcp(
        report("pending-replay"),
        mcpOptions(workflowPath, contextFile, {
          tracker: {
            async fetchIssueStatesByIds(_issueIds: string[]): Promise<ReturnType<typeof issue>[]> {
              return [];
            },
          },
        }),
      ),
    ).rejects.toThrow("Completion report MCP could not load the authoritative issue state");
    await expect(new FileWritebackOutboxStore(stateDir).list()).resolves.toEqual([]);
    await expect(lifecycleStore.get("TEST-1")).resolves.toMatchObject({
      phase: "blocked",
      blockedReason: "publication approval setup incomplete",
      lastCompletionReportId: "completion-report:issue-1:pending-replay",
      summaryPointers: {
        lastRunId: "run-pending-replay",
        issueTitle: "Authoritative title",
      },
      completionReports: [
        expect.objectContaining({ idempotencyKey: "pending-replay", writebackOperationKeys: [] }),
      ],
    });
  });  it("uses service GitHub publication profile for default PR publication", async () => {
    const stateDir = path.join(root, "state");
    const workflowPath = path.join(root, "WORKFLOW.md");
    const contextFile = path.join(root, "context.json");
    const workspace = await initPublishRepo(root, { remote: true });
    await writeFile(path.join(workspace, "feature.txt"), "changed\n", "utf8");
    await writeFile(workflowPath, workflowWithPublicationProfile(stateDir), "utf8");
    vi.stubEnv("GITHUB_PUBLICATION_TOKEN", "publication-token");
    const runStore = new FileRunTranscriptStore(stateDir);
    await runStore.startRun({
      runId: "run-publication-profile",
      sessionId: "agent-1:run-publication-profile",
      agentId: "agent-1",
      role: "worker",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      attempt: null,
      turnNumber: 1,
      prompt: "work",
      workspaceKey: "TEST-1",
      workspacePath: workspace,
      gitBranchName: "symphony/TEST-1",
      repoPath: workspace,
      baseRef: "main",
    });
    await new FileIssueLifecycleStore(stateDir).ensureIssue(issue({ state: "In Progress", branchName: "symphony/TEST-1" }), {
      phase: "implementation",
      summaryPointers: { lastRunId: "run-publication-profile" },
    });
    await writeCompletionReportMcpContext(contextFile, {
      issue: issue({ state: "In Progress", branchName: "symphony/TEST-1" }),
      activeRunId: "run-publication-profile",
      role: "worker",
      token: "handoff-token",
      expectedToken: "handoff-token",
      sessionId: "agent-1:run-publication-profile",
      workspacePath: workspace,
      workspace: {
        path: workspace,
        workspaceKey: "TEST-1",
        createdNow: false,
        issueId: "issue-1",
        issueIdentifier: "TEST-1",
        gitBranchName: "symphony/TEST-1",
        repoPath: workspace,
        baseRef: "main",
      },
      phase: "implementation",
    });
    const authorizations: string[] = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      authorizations.push(String((init?.headers as Record<string, string> | undefined)?.authorization));
      if (init?.method === "POST") {
        return jsonResponse(
          {
            html_url: "https://github.com/acme/symphony/pull/43",
            number: 43,
            head: {
              ref: "symphony/TEST-1",
              sha: "remote-created-sha",
              repo: { pushed_at: "2026-01-01T00:00:01Z" },
            },
          },
          201,
        );
      }
      expect(url.pathname).toBe("/repos/acme/symphony/pulls");
      return jsonResponse([]);
    });

    const result = await submitCompletionReportFromMcp(
      report("publication-profile-idem"),
      mcpOptions(workflowPath, contextFile),
    );

    expect(result).toMatchObject({
      accepted: true,
      replayed: false,
      pullRequest: {
        url: "https://github.com/acme/symphony/pull/43",
        number: 43,
        branch: "symphony/TEST-1",
      },
    });
    expect(authorizations).toEqual(["Bearer publication-token", "Bearer publication-token"]);
  });

  it("uses the active project context GitHub publication profile for direct PR publication", async () => {
    const stateDir = path.join(root, "state");
    const workflowPath = path.join(root, "WORKFLOW.md");
    const contextFile = path.join(root, "context.json");
    const workspace = await initPublishRepo(root, { remote: true });
    await writeFile(path.join(workspace, "feature.txt"), "changed\n", "utf8");
    await writeFile(workflowPath, workflowWithProjectContextPublicationProfile(stateDir), "utf8");
    vi.stubEnv("GITHUB_PUBLICATION_TOKEN", "publication-token");
    vi.stubEnv("DOCS_GITHUB_PUBLICATION_TOKEN", "docs-publication-token");
    const runStore = new FileRunTranscriptStore(stateDir);
    await runStore.startRun({
      runId: "run-docs-publication-profile",
      sessionId: "agent-1:run-docs-publication-profile",
      agentId: "agent-1",
      role: "worker",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      projectContext: docsProjectContext,
      attempt: null,
      turnNumber: 1,
      prompt: "work",
      workspaceKey: "TEST-1",
      workspacePath: workspace,
      gitBranchName: "symphony/TEST-1",
      repoPath: workspace,
      baseRef: "main",
    });
    await new FileIssueLifecycleStore(stateDir).ensureIssue(issue({ state: "In Progress", branchName: "symphony/TEST-1" }), {
      projectContext: docsProjectContext,
      phase: "implementation",
      summaryPointers: { lastRunId: "run-docs-publication-profile" },
    });
    await writeCompletionReportMcpContext(contextFile, {
      issue: issue({ state: "In Progress", branchName: "symphony/TEST-1" }),
      projectContext: docsProjectContext,
      activeRunId: "run-docs-publication-profile",
      role: "worker",
      token: "handoff-token",
      expectedToken: "handoff-token",
      sessionId: "agent-1:run-docs-publication-profile",
      workspacePath: workspace,
      workspace: {
        path: workspace,
        workspaceKey: "TEST-1",
        createdNow: false,
        issueId: "issue-1",
        issueIdentifier: "TEST-1",
        gitBranchName: "symphony/TEST-1",
        repoPath: workspace,
        baseRef: "main",
      },
      phase: "implementation",
    });
    const requests: Array<{ authorization: string; path: string; method: string }> = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({
        authorization: String((init?.headers as Record<string, string> | undefined)?.authorization),
        path: url.pathname,
        method: init?.method ?? "GET",
      });
      if (init?.method === "POST") {
        return jsonResponse(
          {
            html_url: "https://github.com/acme/docs-site/pull/43",
            number: 43,
            head: {
              ref: "symphony/TEST-1",
              sha: "remote-created-sha",
              repo: { pushed_at: "2026-01-01T00:00:01Z" },
            },
          },
          201,
        );
      }
      return jsonResponse([]);
    });

    const result = await submitCompletionReportFromMcp(
      report("docs-publication-profile-idem"),
      mcpOptions(workflowPath, contextFile),
    );

    expect(result).toMatchObject({
      accepted: true,
      replayed: false,
      pullRequest: {
        url: "https://github.com/acme/docs-site/pull/43",
        number: 43,
        branch: "symphony/TEST-1",
      },
    });
    expect(requests).toEqual([
      {
        authorization: "Bearer docs-publication-token",
        path: "/repos/acme/docs-site/pulls",
        method: "GET",
      },
      {
        authorization: "Bearer docs-publication-token",
        path: "/repos/acme/docs-site/pulls",
        method: "POST",
      },
    ]);
  });

  it("exposes a documented stdio MCP tool and submits without caller-supplied run identity", async () => {
    const stateDir = path.join(root, "state");
    const workflowPath = path.join(root, "WORKFLOW.md");
    const contextFile = path.join(root, "context.json");
    await writeFile(workflowPath, workflow(stateDir, false), "utf8");
    const runStore = new FileRunTranscriptStore(stateDir);
    await runStore.startRun({
      runId: "run-stdio-1",
      sessionId: "agent-stdio:run-stdio-1",
      agentId: "agent-stdio",
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
    await new FileIssueLifecycleStore(stateDir).ensureIssue(issue({ state: "In Progress", branchName: "symphony/TEST-1" }), {
      phase: "implementation",
      summaryPointers: { lastRunId: "run-stdio-1" },
    });
    await writeCompletionReportMcpContext(contextFile, {
      issue: issue({ state: "In Progress", branchName: "symphony/TEST-1" }),
      activeRunId: "run-stdio-1",
      role: "worker",
      sessionId: "agent-stdio:run-stdio-1",
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
      phase: "implementation",
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const responses = collectJsonRpcResponses(output);
    const server = runCompletionReportMcpServer({
      ...mcpOptions(workflowPath, contextFile),
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    });

    writeJsonRpc(input, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "symphony-test-client", version: "0.1.0" },
      },
    });
    writeJsonRpc(input, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    writeJsonRpc(input, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const toolsList = await waitForResponse(responses, 2);
    const tool = asRecordArray(asRecord(toolsList.result).tools)[0];
    if (!tool) throw new Error("Expected completion report MCP tool");
    const schema = asRecord(tool.inputSchema);
    expect(tool.name).toBe(COMPLETION_REPORT_TOOL_NAME);
    expect(tool.description).toContain("completion report");
    expect(schema.required).toEqual([
      "summary",
      "validationEvidence",
      "acceptanceChecklist",
      "changedFiles",
      "branchName",
      "pullRequest",
      "risks",
      "idempotencyKey",
    ]);
    expect(asRecord(asRecord(schema.properties).summary).description).toContain("implementation");

    writeJsonRpc(input, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: COMPLETION_REPORT_TOOL_NAME, arguments: { idempotencyKey: "missing-summary" } },
    });
    await expect(waitForResponse(responses, 3)).resolves.toMatchObject({
      result: {
        isError: true,
        content: [{ text: expect.stringContaining("Completion report is invalid") }],
      },
    });

    writeJsonRpc(input, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: COMPLETION_REPORT_TOOL_NAME, arguments: report("stdio-idem-1") },
    });
    await expect(waitForResponse(responses, 4)).resolves.toMatchObject({
      result: {
        structuredContent: {
          accepted: true,
          replayed: false,
          reportId: "completion-report:issue-1:stdio-idem-1",
        },
      },
    });
    input.end();
    await server;
    await expect(new FileIssueLifecycleStore(stateDir).get("TEST-1")).resolves.toMatchObject({
      phase: "review",
      lastCompletionReportId: "completion-report:issue-1:stdio-idem-1",
      completionReports: [
        {
          runId: "run-stdio-1",
          issueId: "issue-1",
        },
      ],
    });
  });
  it("falls back to the report branchName when service-owned branch metadata is unavailable", async () => {
    const stateDir = path.join(root, "state");
    const workflowPath = path.join(root, "WORKFLOW.md");
    const contextFile = path.join(root, "context.json");
    await writeFile(workflowPath, workflow(stateDir), "utf8");
    const runStore = new FileRunTranscriptStore(stateDir);
    await runStore.startRun({
      runId: "run-report-branch-fallback",
      sessionId: "agent-1:run-report-branch-fallback",
      agentId: "agent-1",
      role: "worker",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      projectContext: docsProjectContext,
      attempt: null,
      turnNumber: 1,
      prompt: "work",
      workspaceKey: "TEST-1",
      workspacePath: "/tmp/workspace",
      repoPath: "/repo",
      baseRef: "main",
    });
    const lifecycleStore = new FileIssueLifecycleStore(stateDir);
    await lifecycleStore.ensureIssue(issue({ state: "In Progress", branchName: null }), {
      projectContext: docsProjectContext,
      phase: "implementation",
      summaryPointers: { lastRunId: "run-report-branch-fallback" },
    });
    await writeCompletionReportMcpContext(contextFile, {
      issue: issue({ state: "In Progress", branchName: null }),
      projectContext: docsProjectContext,
      activeRunId: "run-report-branch-fallback",
      role: "worker",
      token: null,
      expectedToken: null,
      sessionId: "agent-1:run-report-branch-fallback",
      workspacePath: "/tmp/workspace",
      workspace: {
        path: "/tmp/workspace",
        workspaceKey: "TEST-1",
        createdNow: false,
        issueId: "issue-1",
        issueIdentifier: "TEST-1",
        repoPath: "/repo",
        baseRef: "main",
      },
      phase: "implementation",
    });
    const publisher = new FakePublisher({
      action: "created",
      url: "https://github.com/acme/symphony/pull/44",
      number: 44,
      headSha: "def456",
      headBranch: "report-only-branch",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "report-branch-idem",
    });

    await submitCompletionReportFromMcp(
      { ...report("report-branch-idem"), branchName: "report-only-branch" },
      mcpOptions(workflowPath, contextFile, {
        pullRequestPublisher: publisher,
        tracker: fakeTracker(issue({ state: "In Progress", branchName: null, title: "Do work" })),
      }),
    );

    expect(publisher.inputs).toHaveLength(1);
    expect(publisher.inputs[0]).toMatchObject({
      branchName: "report-only-branch",
      title: "TEST-1: Do work",
    });
    await expect(lifecycleStore.get("TEST-1")).resolves.toMatchObject({
      summaryPointers: {
        branchName: null,
        gitBranchName: null,
        prBranch: "report-only-branch",
        lastEvidenceCursor: "report-branch-idem",
      },
    });
  });

  it("uses the active run project context for authoritative tracker lookups", async () => {
    const stateDir = path.join(root, "state");
    const workflowPath = path.join(root, "WORKFLOW.md");
    const contextFile = path.join(root, "context.json");
    await writeFile(workflowPath, workflowWithProjectContextPublicationProfile(stateDir), "utf8");
    vi.stubEnv("GITHUB_PUBLICATION_TOKEN", "publication-token");
    vi.stubEnv("DOCS_GITHUB_PUBLICATION_TOKEN", "docs-publication-token");
    const runStore = new FileRunTranscriptStore(stateDir);
    await runStore.startRun({
      runId: "run-active-context-tracker",
      sessionId: "agent-1:run-active-context-tracker",
      agentId: "agent-1",
      role: "worker",
      issueId: "issue-1",
      issueIdentifier: "TEST-1",
      projectContext: docsProjectContext,
      attempt: null,
      turnNumber: 1,
      prompt: "work",
      workspaceKey: "TEST-1",
      workspacePath: "/tmp/workspace",
      gitBranchName: "symphony/TEST-1",
      repoPath: "/repo",
      baseRef: "main",
    });
    await new FileIssueLifecycleStore(stateDir).ensureIssue(issue({ state: "In Progress", branchName: "symphony/TEST-1" }), {
      projectContext: docsProjectContext,
      phase: "implementation",
      summaryPointers: {
        lastRunId: "run-active-context-tracker",
        branchName: "symphony/TEST-1",
        gitBranchName: "symphony/TEST-1",
      },
    });
    await writeCompletionReportMcpContext(contextFile, {
      issue: issue({ state: "In Progress", branchName: "symphony/TEST-1" }),
      projectContext: docsProjectContext,
      activeRunId: "run-active-context-tracker",
      role: "worker",
      token: null,
      expectedToken: null,
      sessionId: "agent-1:run-active-context-tracker",
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
      phase: "implementation",
    });
    const publisher = new FakePublisher({
      action: "created",
      url: "https://github.com/acme/docs-site/pull/45",
      number: 45,
      headSha: "ghi789",
      headBranch: "symphony/TEST-1",
      lastPushedAt: "2026-01-01T00:00:01Z",
      evidenceCursor: "active-context-tracker-idem",
    });
    const authorizations: string[] = [];
    vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
      authorizations.push(String((init?.headers as Record<string, string> | undefined)?.authorization));
      return jsonResponse({
        data: {
          issues: {
            nodes: [
              {
                id: "issue-1",
                identifier: "TEST-1",
                title: "Do work",
                description: null,
                priority: null,
                branchName: "symphony/TEST-1",
                url: null,
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-01T00:00:00Z",
                state: { name: "In Progress" },
                assignee: null,
                delegate: null,
                labels: { nodes: [] },
                inverseRelations: { nodes: [] },
              },
            ],
          },
        },
      });
    });

    const result = await submitCompletionReportFromMcp(
      report("active-context-tracker-idem"),
      mcpOptions(workflowPath, contextFile, {
        tracker: undefined,
        pullRequestPublisher: publisher,
      }),
    );

    expect(result).toMatchObject({
      accepted: true,
      replayed: false,
      reportId: "completion-report:issue-1:active-context-tracker-idem",
    });
    expect(authorizations).toEqual(["docs-linear-test-key"]);
  });




});
function workflow(stateDir: string, publishPullRequests = true): string {
  return `---
tracker:
  kind: linear
  api_key: linear-test-key
  project_slug: TEST
  active_states:
    - Todo
    - In Progress
  handoff_states:
    - Human Review
writeback:
  enabled: true
  mode: dry_run
  dispatch_state: In Progress
review_loop:
  review_states:
    - In Review
workspace:
  root: "${slash(path.join(path.dirname(stateDir), "workspaces"))}"
  state_dir: "${slash(stateDir)}"
github:
  owner: acme
  repo: symphony
  token: github-token
  publish_pull_requests: ${publishPullRequests}
  pr_handoff:
    enabled: ${publishPullRequests}
    target_state: Human Review
    no_ci:
      allowed: true
      evidence: No CI configured in MCP test
project_contexts:
  - id: default
    label: Default
    tracker:
      project_slug: TEST
    workspace:
      source:
        kind: copy
        path: "${slash(path.join(path.dirname(stateDir), "workspaces"))}"
  - id: docs
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

function workflowWithPublicationProfile(stateDir: string): string {
  return `---
tracker:
  kind: linear
  api_key: linear-test-key
  project_slug: TEST
  active_states:
    - Todo
    - In Progress
  handoff_states:
    - Human Review
writeback:
  enabled: true
  mode: dry_run
  dispatch_state: In Progress
review_loop:
  review_states:
    - In Review
workspace:
  root: "${slash(path.join(path.dirname(stateDir), "workspaces"))}"
  state_dir: "${slash(stateDir)}"
github:
  owner: acme
  repo: symphony
  token: legacy-github-token
  api_base_url: https://api.github.test
  publish_pull_requests: true
  pr_handoff:
    enabled: true
    target_state: Human Review
    no_ci:
      allowed: true
      evidence: No CI configured in MCP test
credential_profiles:
  profiles:
    publication:
      value: $GITHUB_PUBLICATION_TOKEN
      capabilities:
        - github.publication
  roles:
    service:
      github.publication: publication
---
Work on {{ issue.identifier }}.
`;
}

function workflowWithProjectContextPublicationProfile(stateDir: string): string {
  return `---
tracker:
  kind: linear
  api_key: linear-test-key
  project_slug: TEST
  active_states:
    - Todo
    - In Progress
  handoff_states:
    - Human Review
writeback:
  enabled: true
  mode: dry_run
  dispatch_state: In Progress
review_loop:
  review_states:
    - In Review
workspace:
  root: "${slash(path.join(path.dirname(stateDir), "workspaces"))}"
  state_dir: "${slash(stateDir)}"
github:
  owner: acme
  repo: symphony
  token: legacy-github-token
  api_base_url: https://api.github.test
  publish_pull_requests: true
  pr_handoff:
    enabled: true
    target_state: Human Review
    no_ci:
      allowed: true
      evidence: No CI configured in MCP test
credential_profiles:
  profiles:
    publication:
      value: $GITHUB_PUBLICATION_TOKEN
      capabilities:
        - github.publication
  roles:
    service:
      github.publication: publication
project_contexts:
  - id: docs
    label: Documentation Site
    tracker:
      api_key: docs-linear-test-key
      project_slug: DOCS
    workspace:
      source:
        kind: copy
        path: "${slash(path.join(path.dirname(stateDir), "workspaces"))}"
    github:
      owner: acme
      repo: docs-site
      token: docs-legacy-github-token
      api_base_url: https://api.github.test
      publish_pull_requests: true
      pr_handoff:
        enabled: true
        target_state: Human Review
        no_ci:
          allowed: true
          evidence: No CI configured in MCP test
    credential_profiles:
      profiles:
        docs-publication:
          value: $DOCS_GITHUB_PUBLICATION_TOKEN
          capabilities:
            - github.publication
      roles:
        service:
          github.publication: docs-publication
---
Work on {{ issue.identifier }}.
`;
}

function report(idempotencyKey = "idem-1") {
  return {
    summary: "Implemented the service contract.",
    validationEvidence: ["npm test"],
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
    risks: [],
    idempotencyKey,
  };
}

function mcpOptions(
  workflowPath: string,
  contextFile: string,
  overrides: Record<string, unknown> = {},
): {
  workflowPath: string;
  contextFile: string;
  tracker: { fetchIssueStatesByIds(issueIds: string[]): Promise<ReturnType<typeof issue>[]> };
  pullRequestPublisher?: CompletionReportPullRequestPublisher;
} {
  return {
    workflowPath,
    contextFile,
    tracker: fakeTracker(),
    ...(overrides as { pullRequestPublisher?: CompletionReportPullRequestPublisher; tracker?: ReturnType<typeof fakeTracker> }),
  };
}

function fakeTracker(latestIssue = issue({ state: "In Progress", branchName: "symphony/TEST-1" })) {
  return {
    async fetchIssueStatesByIds(issueIds: string[]) {
      return issueIds.some((candidate) => candidate === latestIssue.id || candidate === latestIssue.identifier)
        ? [latestIssue]
        : [];
    },
  };
}

function slash(value: string): string {
  return value.replace(/\\/g, "/");
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function initPublishRepo(root: string, options: { remote?: boolean } = {}): Promise<string> {
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await git(["init"], workspace);
  await git(["checkout", "-b", "main"], workspace);
  await writeFile(path.join(workspace, "README.md"), "hello\n", "utf8");
  await git(["add", "README.md"], workspace);
  await git(["-c", "user.name=Symphony Test", "-c", "user.email=symphony@example.com", "commit", "-m", "initial"], workspace);
  if (options.remote) {
    const remote = path.join(root, "remote.git");
    await git(["init", "--bare", remote], root);
    await git(["remote", "add", "origin", remote], workspace);
  }
  await git(["checkout", "-b", "symphony/TEST-1"], workspace);
  return workspace;
}

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`git exited with ${code}: ${stderr}`));
    });
  });
}

class FakePublisher implements CompletionReportPullRequestPublisher {
  readonly inputs: CompletionReportPullRequestPublicationInput[] = [];

  constructor(private readonly publication: CompletionReportPullRequestPublication) {}

  async publishPullRequest(
    input: CompletionReportPullRequestPublicationInput,
  ): Promise<CompletionReportPullRequestPublication> {
    this.inputs.push(input);
    return this.publication;
  }
}

interface JsonRpcResponse {
  id?: string | number | null;
  result?: unknown;
  error?: {
    message: string;
  };
}

function writeJsonRpc(input: PassThrough, message: unknown): void {
  input.write(`${JSON.stringify(message)}\n`);
}

function collectJsonRpcResponses(output: PassThrough): JsonRpcResponse[] {
  const responses: JsonRpcResponse[] = [];
  let buffer = "";
  output.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    while (true) {
      const lineEnd = buffer.indexOf("\n");
      if (lineEnd < 0) return;
      const line = buffer.slice(0, lineEnd).replace(/\r$/, "");
      buffer = buffer.slice(lineEnd + 1);
      if (line.trim()) responses.push(JSON.parse(line) as JsonRpcResponse);
    }
  });
  return responses;
}

async function waitForResponse(responses: JsonRpcResponse[], id: string | number): Promise<JsonRpcResponse> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const response = responses.find((item) => item.id === id);
    if (response) return response;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for JSON-RPC response ${id}`);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new Error("Expected JSON-RPC record");
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value) && value.every((item) => typeof item === "object" && item !== null && !Array.isArray(item))) {
    return value as Array<Record<string, unknown>>;
  }
  throw new Error("Expected JSON-RPC record array");
}

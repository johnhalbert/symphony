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

    const result = await submitCompletionReportFromMcp(report(), {
      workflowPath,
      contextFile,
      pullRequestPublisher: publisher,
    });

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
      evidenceCursor: "idem-1",
    });
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
      submitCompletionReportFromMcp(report("context-issue-mismatch"), {
        workflowPath,
        contextFile,
      }),
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
      submitCompletionReportFromMcp(report("context-project-mismatch"), {
        workflowPath,
        contextFile,
      }),
    ).rejects.toThrow("Completion report MCP context does not match the active worker run");
    await expect(new FileWritebackOutboxStore(stateDir).list()).resolves.toEqual([]);
    await expect(lifecycleStore.get("TEST-1")).resolves.toMatchObject({
      phase: "implementation",
      projectContext: docsProjectContext,
      summaryPointers: { lastRunId: "run-project-context-mismatch" },
      completionReports: [],
    });
  });

  it("rejects completion report MCP submission when service-owned project context fields drift for the same project context id", async () => {
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

    await expect(
      submitCompletionReportFromMcp(report("context-project-fields-mismatch"), {
        workflowPath,
        contextFile,
      }),
    ).rejects.toThrow("Completion report MCP context does not match the active worker run");
    await expect(new FileWritebackOutboxStore(stateDir).list()).resolves.toEqual([]);
    await expect(lifecycleStore.get("TEST-1")).resolves.toMatchObject({
      phase: "implementation",
      projectContext: docsProjectContext,
      summaryPointers: { lastRunId: "run-project-context-field-mismatch" },
      completionReports: [],
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
      submitCompletionReportFromMcp(report("context-alt-run-mismatch"), {
        workflowPath,
        contextFile,
      }),
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
      submitCompletionReportFromMcp(report("context-run-phase-mismatch"), {
        workflowPath,
        contextFile,
      }),
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

    const first = await submitCompletionReportFromMcp(report("replay-after-completion"), {
      workflowPath,
      contextFile,
    });
    await runStore.updateRun("run-replay-after-completion", { status: "succeeded", completedAt: new Date().toISOString() });
    const second = await submitCompletionReportFromMcp(report("replay-after-completion"), {
      workflowPath,
      contextFile,
    });

    expect(first).toMatchObject({ accepted: true, replayed: false });
    expect(second).toMatchObject({
      accepted: true,
      replayed: true,
      reportId: "completion-report:issue-1:replay-after-completion",
    });
    await expect(new FileWritebackOutboxStore(stateDir).list()).resolves.toHaveLength(2);
    await expect(lifecycleStore.get("TEST-1")).resolves.toMatchObject({
      phase: "review",
      lastCompletionReportId: "completion-report:issue-1:replay-after-completion",
      summaryPointers: { lastRunId: "run-replay-after-completion" },
      completionReports: [
        expect.objectContaining({ runId: "run-replay-after-completion", idempotencyKey: "replay-after-completion" }),
      ],
    });
  });

  it("uses service GitHub publication profile for default PR publication", async () => {
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

    const result = await submitCompletionReportFromMcp(report("publication-profile-idem"), {
      workflowPath,
      contextFile,
    });

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
      workflowPath,
      contextFile,
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

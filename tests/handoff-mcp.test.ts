import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseServiceConfig } from "../src/core/config/Config.js";
import type { AgentRunContext } from "../src/core/harness/AgentHarness.js";
import {
  completionReportContextFilePath,
  completionReportMcpServerConfig,
  mergeConflictResolutionContextFilePath,
  renderCompletionMcpHandoffPrompt,
  renderIssueBreakdownMcpHandoffPrompt,
  renderReviewMcpHandoffPrompt,
  reviewFeedbackContextFilePath,
  reviewFeedbackMcpServerConfig,
  reviewVerdictContextFilePath,
  reviewVerdictMcpServerConfig,
  writeActiveHandoffMcpContexts,
} from "../src/core/harness/HandoffMcp.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import { issue, multiProjectWorkflowConfig, projectContextFixture, testConfig } from "./helpers.js";

describe("MCP handoff prompt rendering", () => {
  it("requires issue-breakdown proposals to include the agent-eligible issue contract", () => {
    const prompt = renderIssueBreakdownMcpHandoffPrompt({ issue: issue({ identifier: "ENG-1" }) });

    expect(prompt).toContain("Symphony MCP issue-breakdown handoff:");
    expect(prompt).toContain("Problem / Goal");
    expect(prompt).toContain("Issue Contract");
    expect(prompt).toContain("Contract Checklist");
    expect(prompt).toContain("Validation Requirements");
    expect(prompt).toContain("fenced `json` block");
    expect(prompt).toContain("stable unique `id` values");
    expect(prompt).toContain("exact repo paths or globs");
    expect(prompt).toContain("manual-only requirement");
    expect(prompt).toContain("Do not include `dogfood-ready` automatically");
    expect(prompt).toContain("do not include secrets, tokens, private keys, or credential values");
  });

  it("identifies submit_completion_report as the only allowed worker GitHub publication path", () => {
    const prompt = renderCompletionMcpHandoffPrompt({
      issue: issue({ id: "issue-1", identifier: "ENG-1", branchName: "symphony/ENG-1" }),
      role: "worker",
      workspacePath: "/workspace/ENG-1",
      repoPath: "/repo/symphony",
      baseRef: "origin/main",
    });

    expect(prompt).toContain("submit_completion_report");
    expect(prompt).toContain("Symphony service-owned GitHub workflow");
    expect(prompt).toContain("Do not run git commit");
    expect(prompt).toContain("git push");
    expect(prompt).toContain("gh pr create");
    expect(prompt).toContain("gh pr edit");
    expect(prompt).toContain("service-owned commit, push, and PR creation/reuse");
  });

  it("requires completion reports to map Issue Contract requirements to durable proof", () => {
    const prompt = renderCompletionMcpHandoffPrompt({
      issue: issue({ id: "issue-1", identifier: "ENG-1", branchName: "symphony/ENG-1" }),
      role: "worker",
      workspacePath: "/workspace/ENG-1",
      repoPath: "/repo/symphony",
      baseRef: "origin/main",
    });

    expect(prompt).toContain("fenced JSON Issue Contract");
    expect(prompt).toContain("one acceptanceChecklist item for every requirement `id`");
    expect(prompt).toContain("start the item text with that `id`");
    expect(prompt).toContain("documented command invocation actually produces the documented fields");
    expect(prompt).toContain("do not rely on inferred behavior");
  });

  it("identifies review-feedback MCP as the only allowed reviewer GitHub review-write path", () => {
    const prompt = renderReviewMcpHandoffPrompt({
      issue: issue({ id: "issue-1", identifier: "ENG-1", state: "In Review", branchName: "symphony/ENG-1" }),
      role: "reviewer",
      workspacePath: "/workspace/ENG-1",
      repoPath: "/repo/symphony",
      baseRef: "origin/main",
    });

    expect(prompt).toContain("submit_pull_request_review_feedback");
    expect(prompt).toContain("submit_review_verdict");
    expect(prompt).toContain("Symphony service-owned review feedback workflow");
    expect(prompt).toContain("lifecycle-bound PR");
    expect(prompt).toContain("Do not run gh pr review");
    expect(prompt).toContain("direct GitHub API/curl writes");
    expect(prompt).toContain("reviewUrl/commentUrls/urls");
    expect(prompt).toContain("Never call submit_pull_request_review_feedback with {}");
    expect(prompt).toContain('{"kind":"review","event":"APPROVE","body":"...","idempotencyKey":"..."}');
  });
});

describe("MCP handoff context files", () => {
  it("writes project context into merge-conflict worker handoff payloads", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-handoff-mcp-"));
    try {
      const config = multiProjectHandoffConfig(root);
      config.mergePolicy.mode = "gated";
      config.mergePolicy.conflictsState = "Approved with Conflicts";
      const ctx = handoffContext(config, {
        role: "worker",
        issueState: "Approved with Conflicts",
        runPhase: "merge_conflict_resolution",
        projectContext: docsProjectContext,
        issueOverrides: {
          projectContextId: "docs",
          projectContextLabel: "Documentation Site",
          linearProjectIdentity: { kind: "linear", slug: "DOCS", id: "linear-project-docs" },
          routingSource: "candidate_poll",
        },
      });

      await writeActiveHandoffMcpContexts(ctx, {
        activeRunId: "conflict-run-1",
        sessionId: "conflict-session-1",
      });

      const payload = JSON.parse(await readFile(mergeConflictResolutionContextFilePath(ctx), "utf8"));
      expect(payload).toMatchObject({
        activeRunId: "conflict-run-1",
        role: "worker",
        phase: "merge_conflict_resolution",
        projectContext: docsProjectContext,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes project context into reviewer verdict handoff payloads", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-handoff-mcp-"));
    try {
      const config = multiProjectHandoffConfig(root);
      const ctx = handoffContext(config, {
        role: "reviewer",
        issueState: "In Review",
        projectContext: docsProjectContext,
        issueOverrides: {
          projectContextId: "docs",
          projectContextLabel: "Documentation Site",
          linearProjectIdentity: { kind: "linear", slug: "DOCS", id: "linear-project-docs" },
          routingSource: "candidate_poll",
        },
      });

      await writeActiveHandoffMcpContexts(ctx, {
        activeRunId: "review-run-1",
        sessionId: "reviewer-agent-1",
      });

      const payload = JSON.parse(await readFile(reviewVerdictContextFilePath(ctx), "utf8"));
      expect(payload).toMatchObject({
        activeRunId: "review-run-1",
        role: "reviewer",
        phase: "review",
        reviewer: "reviewer-agent-1",
        projectContext: docsProjectContext,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("sanitizes nested issue.projectContext in completion-report handoff payloads when top-level ctx.projectContext is omitted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-handoff-mcp-"));
    try {
      const config = multiProjectHandoffConfig(root);
      const ctx = handoffContext(config, {
        role: "worker",
        issueState: "In Progress",
        issueOverrides: {
          projectContextId: "docs",
          projectContextLabel: "Documentation Site",
          linearProjectIdentity: { kind: "linear", slug: "DOCS", id: "linear-project-docs" },
          routingSource: "candidate_poll",
          projectContext: symphonyProjectContext,
        },
      });

      expect(() =>
        completionReportMcpServerConfig(ctx, "/tmp/completion-context.json", { cliPath: "/repo/dist/cli.js" }),
      ).not.toThrow();
      await writeActiveHandoffMcpContexts(ctx, {
        activeRunId: "worker-run-nested-issue-1",
        sessionId: "worker-session-nested-issue-1",
      });

      const payload = JSON.parse(await readFile(completionReportContextFilePath(ctx), "utf8"));
      expect(payload.projectContext).toEqual(docsProjectContext);
      expect(payload.issue.projectContext).toEqual(docsProjectContext);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("sanitizes nested issue.projectContext in review-verdict handoff payloads when top-level ctx.projectContext is omitted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-handoff-mcp-"));
    try {
      const config = multiProjectHandoffConfig(root);
      const ctx = handoffContext(config, {
        role: "reviewer",
        issueState: "In Review",
        issueOverrides: {
          projectContextId: "docs",
          projectContextLabel: "Documentation Site",
          linearProjectIdentity: { kind: "linear", slug: "DOCS", id: "linear-project-docs" },
          routingSource: "candidate_poll",
          projectContext: symphonyProjectContext,
        },
      });

      expect(() =>
        reviewVerdictMcpServerConfig(ctx, "/tmp/review-verdict-context.json", { cliPath: "/repo/dist/cli.js" }),
      ).not.toThrow();
      await writeActiveHandoffMcpContexts(ctx, {
        activeRunId: "review-run-nested-issue-1",
        sessionId: "reviewer-agent-nested-issue-1",
      });

      const payload = JSON.parse(await readFile(reviewVerdictContextFilePath(ctx), "utf8"));
      expect(payload.projectContext).toEqual(docsProjectContext);
      expect(payload.issue.projectContext).toEqual(docsProjectContext);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("sanitizes nested issue.projectContext in review-feedback handoff payloads when top-level ctx.projectContext is omitted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-handoff-mcp-"));
    try {
      const config = multiProjectHandoffConfig(root);
      const ctx = handoffContext(config, {
        role: "reviewer",
        issueState: "In Review",
        issueOverrides: {
          projectContextId: "docs",
          projectContextLabel: "Documentation Site",
          linearProjectIdentity: { kind: "linear", slug: "DOCS", id: "linear-project-docs" },
          routingSource: "candidate_poll",
          projectContext: symphonyProjectContext,
        },
      });

      expect(() =>
        reviewFeedbackMcpServerConfig(ctx, "/tmp/review-feedback-context.json", { cliPath: "/repo/dist/cli.js" }),
      ).not.toThrow();
      await writeActiveHandoffMcpContexts(ctx, {
        activeRunId: "review-run-nested-issue-2",
        sessionId: "reviewer-agent-nested-issue-2",
      });

      const payload = JSON.parse(await readFile(reviewFeedbackContextFilePath(ctx), "utf8"));
      expect(payload.projectContext).toEqual(docsProjectContext);
      expect(payload.issue.projectContext).toEqual(docsProjectContext);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves the service-owned resolved project context when completion-report handoff metadata drifts within the same projectContextId", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-handoff-mcp-"));
    try {
      const config = multiProjectHandoffConfig(root);
      const ctx = handoffContext(config, {
        role: "worker",
        issueState: "In Progress",
        projectContext: tamperedDocsProjectContext,
        issueOverrides: {
          projectContextId: "docs",
          projectContextLabel: "Documentation Site",
          linearProjectIdentity: { kind: "linear", slug: "DOCS", id: "linear-project-docs" },
          routingSource: "candidate_poll",
        },
      });

      expect(() =>
        completionReportMcpServerConfig(ctx, "/tmp/completion-context.json", { cliPath: "/repo/dist/cli.js" }),
      ).not.toThrow();
      await writeActiveHandoffMcpContexts(ctx, {
        activeRunId: "worker-run-same-id-1",
        sessionId: "worker-session-same-id-1",
      });

      const payload = JSON.parse(await readFile(completionReportContextFilePath(ctx), "utf8"));
      expect(payload.projectContext).toEqual(docsProjectContext);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves the service-owned resolved project context when review-verdict handoff metadata drifts within the same projectContextId", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-handoff-mcp-"));
    try {
      const config = multiProjectHandoffConfig(root);
      const ctx = handoffContext(config, {
        role: "reviewer",
        issueState: "In Review",
        projectContext: tamperedDocsProjectContext,
        issueOverrides: {
          projectContextId: "docs",
          projectContextLabel: "Documentation Site",
          linearProjectIdentity: { kind: "linear", slug: "DOCS", id: "linear-project-docs" },
          routingSource: "candidate_poll",
        },
      });

      expect(() =>
        reviewVerdictMcpServerConfig(ctx, "/tmp/review-verdict-context.json", { cliPath: "/repo/dist/cli.js" }),
      ).not.toThrow();
      await writeActiveHandoffMcpContexts(ctx, {
        activeRunId: "review-run-same-id-1",
        sessionId: "reviewer-agent-same-id-1",
      });

      const payload = JSON.parse(await readFile(reviewVerdictContextFilePath(ctx), "utf8"));
      expect(payload.projectContext).toEqual(docsProjectContext);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves the service-owned resolved project context when review-feedback handoff metadata drifts within the same projectContextId", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-handoff-mcp-"));
    try {
      const config = multiProjectHandoffConfig(root);
      const ctx = handoffContext(config, {
        role: "reviewer",
        issueState: "In Review",
        projectContext: tamperedDocsProjectContext,
        issueOverrides: {
          projectContextId: "docs",
          projectContextLabel: "Documentation Site",
          linearProjectIdentity: { kind: "linear", slug: "DOCS", id: "linear-project-docs" },
          routingSource: "candidate_poll",
        },
      });

      expect(() =>
        reviewFeedbackMcpServerConfig(ctx, "/tmp/review-feedback-context.json", { cliPath: "/repo/dist/cli.js" }),
      ).not.toThrow();
      await writeActiveHandoffMcpContexts(ctx, {
        activeRunId: "review-run-same-id-2",
        sessionId: "reviewer-agent-same-id-2",
      });

      const payload = JSON.parse(await readFile(reviewFeedbackContextFilePath(ctx), "utf8"));
      expect(payload.projectContext).toEqual(docsProjectContext);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves the active review-feedback run context when service-owned routing metadata drifts within the same projectContextId", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-handoff-mcp-"));
    try {
      const config = multiProjectHandoffConfig(root);
      const ctx = handoffContext(config, {
        role: "reviewer",
        issueState: "In Review",
        projectContext: docsProjectContext,
        issueOverrides: {
          projectContextId: "docs",
          projectContextLabel: "Documentation Site",
          linearProjectIdentity: { kind: "linear", slug: "DOCS", id: "linear-project-docs" },
          routingSource: "state_refresh",
        },
      });

      expect(() =>
        reviewFeedbackMcpServerConfig(ctx, "/tmp/review-feedback-context.json", { cliPath: "/repo/dist/cli.js" }),
      ).not.toThrow();
      await writeActiveHandoffMcpContexts(ctx, {
        activeRunId: "review-run-feedback-routing-drift-1",
        sessionId: "reviewer-agent-feedback-routing-drift-1",
      });

      const verdictPayload = JSON.parse(await readFile(reviewVerdictContextFilePath(ctx), "utf8"));
      const feedbackPayload = JSON.parse(await readFile(reviewFeedbackContextFilePath(ctx), "utf8"));
      expect(verdictPayload.projectContext).toEqual(stateRefreshDocsProjectContext);
      expect(verdictPayload.issue.projectContext).toEqual(stateRefreshDocsProjectContext);
      expect(feedbackPayload.projectContext).toEqual(docsProjectContext);
      expect(feedbackPayload.issue.projectContext).toEqual(docsProjectContext);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects completion-report handoff data when the requested project context conflicts with the service-owned resolved issue context", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-handoff-mcp-"));
    try {
      const config = multiProjectHandoffConfig(root);
      const ctx = handoffContext(config, {
        role: "worker",
        issueState: "In Progress",
        projectContext: {
          projectContextId: "docs",
          projectContextLabel: "Documentation Site",
          linearProjectSlug: "DOCS",
          routingSource: "candidate_poll",
        },
        issueOverrides: {
          projectContextId: "symphony",
          projectContextLabel: "Symphony",
          linearProjectIdentity: { kind: "linear", slug: "SYMPHONY", id: "linear-project-symphony" },
          routingSource: "candidate_poll",
          projectContext: docsProjectContext,
        },
      });

      expect(() =>
        completionReportMcpServerConfig(ctx, "/tmp/completion-context.json", { cliPath: "/repo/dist/cli.js" }),
      ).toThrow("Completion report MCP handoff project context does not match the service-owned resolved issue context");
      await expect(
        writeActiveHandoffMcpContexts(ctx, {
          activeRunId: "worker-run-1",
          sessionId: "worker-session-1",
        }),
      ).rejects.toMatchObject({
        code: "invalid_request",
        message: "Completion report MCP handoff project context does not match the service-owned resolved issue context",
      });
      await expect(readFile(completionReportContextFilePath(ctx), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects review-verdict handoff data when the requested project context conflicts with the service-owned resolved issue context", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-handoff-mcp-"));
    try {
      const config = multiProjectHandoffConfig(root);
      const ctx = handoffContext(config, {
        role: "reviewer",
        issueState: "In Review",
        projectContext: {
          projectContextId: "docs",
          projectContextLabel: "Documentation Site",
          linearProjectSlug: "DOCS",
          routingSource: "candidate_poll",
        },
        issueOverrides: {
          projectContextId: "symphony",
          projectContextLabel: "Symphony",
          linearProjectIdentity: { kind: "linear", slug: "SYMPHONY", id: "linear-project-symphony" },
          routingSource: "candidate_poll",
          projectContext: docsProjectContext,
        },
      });

      expect(() =>
        reviewVerdictMcpServerConfig(ctx, "/tmp/review-verdict-context.json", { cliPath: "/repo/dist/cli.js" }),
      ).toThrow("Review verdict MCP handoff project context does not match the service-owned resolved issue context");
      await expect(
        writeActiveHandoffMcpContexts(ctx, {
          activeRunId: "review-run-2",
          sessionId: "reviewer-agent-2",
        }),
      ).rejects.toMatchObject({
        code: "invalid_request",
        message: "Review MCP handoff project context does not match the service-owned resolved issue context",
      });
      await expect(readFile(reviewVerdictContextFilePath(ctx), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(reviewFeedbackContextFilePath(ctx), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects review-feedback handoff data when the requested project context conflicts with the service-owned resolved issue context", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-handoff-mcp-"));
    try {
      const config = multiProjectHandoffConfig(root);
      const ctx = handoffContext(config, {
        role: "reviewer",
        issueState: "In Review",
        projectContext: {
          projectContextId: "docs",
          projectContextLabel: "Documentation Site",
          linearProjectSlug: "DOCS",
          routingSource: "candidate_poll",
        },
        issueOverrides: {
          projectContextId: "symphony",
          projectContextLabel: "Symphony",
          linearProjectIdentity: { kind: "linear", slug: "SYMPHONY", id: "linear-project-symphony" },
          routingSource: "candidate_poll",
          projectContext: docsProjectContext,
        },
      });

      expect(() =>
        reviewFeedbackMcpServerConfig(ctx, "/tmp/review-feedback-context.json", { cliPath: "/repo/dist/cli.js" }),
      ).toThrow("Review feedback MCP handoff project context does not match the service-owned resolved issue context");
      await expect(
        writeActiveHandoffMcpContexts(ctx, {
          activeRunId: "review-run-3",
          sessionId: "reviewer-agent-3",
        }),
      ).rejects.toMatchObject({
        code: "invalid_request",
        message: "Review MCP handoff project context does not match the service-owned resolved issue context",
      });
      await expect(readFile(reviewFeedbackContextFilePath(ctx), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects completion-report handoff data when the service-owned issue routing becomes stale", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-handoff-mcp-"));
    try {
      const config = multiProjectHandoffConfig(root);
      const ctx = handoffContext(config, {
        role: "worker",
        issueState: "In Progress",
        projectContext: docsProjectContext,
        issueOverrides: {
          projectContextId: "docs",
          projectContextLabel: "Documentation Site",
          linearProjectIdentity: { kind: "linear", slug: "SYMPHONY", id: "linear-project-symphony" },
          routingSource: "state_refresh",
        },
      });

      expect(() =>
        completionReportMcpServerConfig(ctx, "/tmp/completion-context.json", { cliPath: "/repo/dist/cli.js" }),
      ).toThrow("Completion report MCP handoff project context could not be resolved from the service-owned issue context");
      await expect(
        writeActiveHandoffMcpContexts(ctx, {
          activeRunId: "worker-run-stale-routing-1",
          sessionId: "worker-session-stale-routing-1",
        }),
      ).rejects.toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining(
          "Completion report MCP handoff project context could not be resolved from the service-owned issue context",
        ),
      });
      await expect(readFile(completionReportContextFilePath(ctx), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects review-verdict handoff data when the service-owned issue routing becomes stale", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-handoff-mcp-"));
    try {
      const config = multiProjectHandoffConfig(root);
      const ctx = handoffContext(config, {
        role: "reviewer",
        issueState: "In Review",
        projectContext: docsProjectContext,
        issueOverrides: {
          projectContextId: "docs",
          projectContextLabel: "Documentation Site",
          linearProjectIdentity: { kind: "linear", slug: "SYMPHONY", id: "linear-project-symphony" },
          routingSource: "state_refresh",
        },
      });

      expect(() =>
        reviewVerdictMcpServerConfig(ctx, "/tmp/review-verdict-context.json", { cliPath: "/repo/dist/cli.js" }),
      ).toThrow("Review verdict MCP handoff project context could not be resolved from the service-owned issue context");
      await expect(
        writeActiveHandoffMcpContexts(ctx, {
          activeRunId: "review-run-stale-routing-1",
          sessionId: "reviewer-agent-stale-routing-1",
        }),
      ).rejects.toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining("Review MCP handoff project context could not be resolved from the service-owned issue context"),
      });
      await expect(readFile(reviewVerdictContextFilePath(ctx), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(reviewFeedbackContextFilePath(ctx), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects review-feedback handoff data when the service-owned issue routing becomes stale", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-handoff-mcp-"));
    try {
      const config = multiProjectHandoffConfig(root);
      const ctx = handoffContext(config, {
        role: "reviewer",
        issueState: "In Review",
        projectContext: docsProjectContext,
        issueOverrides: {
          projectContextId: "docs",
          projectContextLabel: "Documentation Site",
          linearProjectIdentity: { kind: "linear", slug: "SYMPHONY", id: "linear-project-symphony" },
          routingSource: "state_refresh",
        },
      });

      expect(() =>
        reviewFeedbackMcpServerConfig(ctx, "/tmp/review-feedback-context.json", { cliPath: "/repo/dist/cli.js" }),
      ).toThrow("Review feedback MCP handoff project context could not be resolved from the service-owned issue context");
      await expect(
        writeActiveHandoffMcpContexts(ctx, {
          activeRunId: "review-run-stale-routing-2",
          sessionId: "reviewer-agent-stale-routing-2",
        }),
      ).rejects.toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining("Review MCP handoff project context could not be resolved from the service-owned issue context"),
      });
      await expect(readFile(reviewFeedbackContextFilePath(ctx), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("forwards resolved project context into completion-report MCP server env selection", async () => {
    const sourceEnv = {
      LINEAR_API_KEY: "linear-secret",
      SYMPHONY_GITHUB_OWNER: "acme",
      SYMPHONY_GITHUB_REPO: "symphony",
      SYMPHONY_GITHUB_HEAD_OWNER: "sym-owner",
      SYMPHONY_GITHUB_API_BASE_URL: "https://api.github.sym.test",
      SYMPHONY_GITHUB_PUBLICATION_TOKEN: "symphony-publication-secret",
      DOCS_GITHUB_OWNER: "acme-docs",
      DOCS_GITHUB_REPO: "docs-site",
      DOCS_GITHUB_HEAD_OWNER: "docs-owner",
      DOCS_GITHUB_API_BASE_URL: "https://api.github.docs.test",
      DOCS_GITHUB_PUBLICATION_TOKEN: "docs-publication-secret",
    };
    const rawConfig = multiProjectWorkflowConfig({
      projectContexts: [
        projectContextFixture({
          id: "symphony",
          label: "Symphony",
          projectSlug: "SYMPHONY",
          repository: ".",
          github: {
            owner: "$SYMPHONY_GITHUB_OWNER",
            repo: "$SYMPHONY_GITHUB_REPO",
            head_owner: "$SYMPHONY_GITHUB_HEAD_OWNER",
            api_base_url: "$SYMPHONY_GITHUB_API_BASE_URL",
            publish_pull_requests: true,
            pr_handoff: { enabled: false },
          },
          credential_profiles: {
            profiles: {
              publication: { value: "$SYMPHONY_GITHUB_PUBLICATION_TOKEN", capabilities: ["github.publication"] },
            },
            roles: {
              service: { "github.publication": "publication" },
            },
          },
        }),
        projectContextFixture({
          id: "docs",
          label: "Documentation Site",
          projectSlug: "DOCS",
          repository: "../docs-site",
          github: {
            owner: "$DOCS_GITHUB_OWNER",
            repo: "$DOCS_GITHUB_REPO",
            head_owner: "$DOCS_GITHUB_HEAD_OWNER",
            api_base_url: "$DOCS_GITHUB_API_BASE_URL",
            publish_pull_requests: true,
            pr_handoff: { enabled: false },
          },
          credential_profiles: {
            profiles: {
              publication: { value: "$DOCS_GITHUB_PUBLICATION_TOKEN", capabilities: ["github.publication"] },
            },
            roles: {
              service: { "github.publication": "publication" },
            },
          },
        }),
      ],
    });
    const config = parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", sourceEnv);
    const ctx = handoffContext(config, {
      role: "worker",
      issueState: "In Progress",
      projectContext: {
        projectContextId: "docs",
        projectContextLabel: "Documentation Site",
        linearProjectSlug: "DOCS",
        routingSource: "candidate_poll",
      },
    });

    const prior = {
      LINEAR_API_KEY: process.env.LINEAR_API_KEY,
      SYMPHONY_GITHUB_OWNER: process.env.SYMPHONY_GITHUB_OWNER,
      SYMPHONY_GITHUB_REPO: process.env.SYMPHONY_GITHUB_REPO,
      SYMPHONY_GITHUB_HEAD_OWNER: process.env.SYMPHONY_GITHUB_HEAD_OWNER,
      SYMPHONY_GITHUB_API_BASE_URL: process.env.SYMPHONY_GITHUB_API_BASE_URL,
      SYMPHONY_GITHUB_PUBLICATION_TOKEN: process.env.SYMPHONY_GITHUB_PUBLICATION_TOKEN,
      DOCS_GITHUB_OWNER: process.env.DOCS_GITHUB_OWNER,
      DOCS_GITHUB_REPO: process.env.DOCS_GITHUB_REPO,
      DOCS_GITHUB_HEAD_OWNER: process.env.DOCS_GITHUB_HEAD_OWNER,
      DOCS_GITHUB_API_BASE_URL: process.env.DOCS_GITHUB_API_BASE_URL,
      DOCS_GITHUB_PUBLICATION_TOKEN: process.env.DOCS_GITHUB_PUBLICATION_TOKEN,
    };
    Object.assign(process.env, sourceEnv);
    try {
      const server = completionReportMcpServerConfig(ctx, "/tmp/completion-context.json", { cliPath: "/repo/dist/cli.js" });
      expect(server.env).toMatchObject({
        DOCS_GITHUB_OWNER: "acme-docs",
        DOCS_GITHUB_REPO: "docs-site",
        DOCS_GITHUB_HEAD_OWNER: "docs-owner",
        DOCS_GITHUB_API_BASE_URL: "https://api.github.docs.test",
        DOCS_GITHUB_PUBLICATION_TOKEN: "docs-publication-secret",
      });
      expect(server.env).not.toHaveProperty("SYMPHONY_GITHUB_PUBLICATION_TOKEN");
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});

const docsProjectContext = {
  projectContextId: "docs",
  projectContextLabel: "Documentation Site",
  linearProjectSlug: "DOCS",
  routingSource: "candidate_poll",
} as const;

const symphonyProjectContext = {
  projectContextId: "symphony",
  projectContextLabel: "Symphony",
  linearProjectSlug: "SYMPHONY",
  routingSource: "candidate_poll",
} as const;

const tamperedDocsProjectContext = {
  projectContextId: "docs",
  projectContextLabel: "MALICIOUS LABEL",
  linearProjectSlug: "WRONG",
  routingSource: "operator_request",
} as const;

const stateRefreshDocsProjectContext = {
  projectContextId: "docs",
  projectContextLabel: "Documentation Site",
  linearProjectSlug: "DOCS",
  routingSource: "state_refresh",
} as const;

function multiProjectHandoffConfig(root: string): AgentRunContext["config"] {
  return parseServiceConfig(multiProjectWorkflowConfig(), path.join(root, "WORKFLOW.md"), {
    LINEAR_API_KEY: "linear-test-key",
  });
}

function handoffContext(
  config: AgentRunContext["config"],
  input: {
    role: "worker" | "reviewer";
    issueState: string;
    runPhase?: AgentRunContext["runPhase"];
    projectContext?: AgentRunContext["projectContext"];
    issueOverrides?: Partial<AgentRunContext["issue"]>;
  },
): AgentRunContext {
  return {
    issue: issue({ state: input.issueState, branchName: "symphony/TEST-1", ...(input.issueOverrides ?? {}) }),
    role: input.role,
    attempt: null,
    workspace: {
      path: "/tmp/workspace",
      workspaceKey: "TEST-1",
      createdNow: false,
      gitBranchName: "symphony/TEST-1",
      repoPath: "/repo",
      baseRef: "main",
    },
    config,
    turnNumber: 1,
    abortSignal: new AbortController().signal,
    logger: new StructuredLogger(() => undefined),
    ...(input.projectContext === undefined ? {} : { projectContext: input.projectContext }),
    ...(input.runPhase === undefined ? {} : { runPhase: input.runPhase }),
  };
}

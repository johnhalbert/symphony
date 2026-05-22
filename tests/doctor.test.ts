import { afterEach, describe, expect, it, vi } from "vitest";
import { parseServiceConfig } from "../src/core/config/Config.js";
import { continuationContextDoctorChecks, githubPublicationDoctorCheck, reviewLoopDoctorChecks } from "../src/doctor.js";
import { testConfig } from "./helpers.js";

describe("doctor review-loop checks", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("validates review state, blocked state, MCP tools, and candidate isolation", async () => {
    const config = testConfig("/tmp/symphony-doctor");
    config.tracker.activeStates = ["Todo", "In Progress"];
    config.tracker.handoffStates = ["In Review"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.reviewLoop.blockedStates = ["Blocked"];
    config.reviewLoop.reviewPassState = "Ready to Merge";
    config.agent.requireLabels = ["dogfood-ready"];

    await expect(
      reviewLoopDoctorChecks(config, {
        workflowPath: "/tmp/symphony-doctor/WORKFLOW.md",
        mcpToolLister: async ({ command }) =>
          command === "completion-report-mcp" ? ["submit_completion_report"] : ["submit_review_verdict"],
        linearStateLister: async () => ["Todo", "In Progress", "In Review", "Blocked", "Ready to Merge", "Done"],
      }),
    ).resolves.toEqual([
      {
        id: "review_loop.states",
        status: "ok",
        message: "review_states: In Review; pass destination: Ready to Merge",
      },
      {
        id: "review_loop.linear_states",
        status: "ok",
        message: "Linear team has configured review-loop states: In Review, Blocked, Ready to Merge",
      },
      {
        id: "review_loop.blocked_state",
        status: "ok",
        message: "blocked_states: Blocked",
      },
      {
        id: "review_loop.mcp_tools",
        status: "ok",
        message: "Configured Cursor CLI lists MCP tools: submit_completion_report, submit_review_verdict",
      },
      {
        id: "review_loop.candidate_isolation",
        status: "ok",
        message:
          "worker candidates require labels: dogfood-ready; review/blocked states are isolated from active states",
      },
    ]);
  });

  it("warns when Blocked or required dispatch labels are missing", async () => {
    const config = testConfig("/tmp/symphony-doctor");
    config.tracker.activeStates = ["Todo", "In Progress"];
    config.tracker.handoffStates = ["In Review"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.reviewLoop.blockedStates = [];
    config.agent.requireLabels = [];

    config.reviewLoop.reviewPassState = "Ready to Merge";

    const checks = await reviewLoopDoctorChecks(config, {
      workflowPath: "/tmp/symphony-doctor/WORKFLOW.md",
      mcpToolLister: async ({ command }) =>
        command === "completion-report-mcp" ? ["submit_completion_report"] : ["submit_review_verdict"],
      linearStateLister: async () => ["Todo", "In Progress", "In Review", "Ready to Merge", "Done"],
    });

    expect(checks).toContainEqual({
      id: "review_loop.blocked_state",
      status: "warn",
      message: "No review_loop.blocked_states configured; blocked escalations will comment but leave Linear state unchanged",
    });
    expect(checks).toContainEqual({
      id: "review_loop.candidate_isolation",
      status: "warn",
      message: "No required dispatch labels configured; any routed active-state issue can become a candidate",
    });
  });

  it("errors when the dogfood pass destination is not configured", async () => {
    const config = testConfig("/tmp/symphony-doctor");
    config.tracker.handoffStates = ["In Review"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.reviewLoop.reviewPassState = null;

    const checks = await reviewLoopDoctorChecks(config, {
      workflowPath: "/tmp/symphony-doctor/WORKFLOW.md",
      mcpToolLister: async ({ command }) =>
        command === "completion-report-mcp" ? ["submit_completion_report"] : ["submit_review_verdict"],
      linearStateLister: async () => ["Todo", "In Progress", "In Review", "Blocked", "Done"],
    });

    expect(checks).toContainEqual({
      id: "review_loop.states",
      status: "error",
      message: "review_loop.review_pass_state must name the configured pass destination for dogfood smoke",
    });
  });

  it("errors when the configured CLI cannot list both MCP tools", async () => {
    const config = testConfig("/tmp/symphony-doctor");
    config.tracker.handoffStates = ["In Review"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.reviewLoop.reviewPassState = "Ready to Merge";

    const checks = await reviewLoopDoctorChecks(config, {
      workflowPath: "/tmp/symphony-doctor/WORKFLOW.md",
      mcpToolLister: async ({ command }) =>
        command === "completion-report-mcp" ? ["submit_completion_report"] : ["unexpected_tool"],
      linearStateLister: async () => ["Todo", "In Progress", "In Review", "Blocked", "Ready to Merge", "Done"],
    });

    expect(checks).toContainEqual({
      id: "review_loop.mcp_tools",
      status: "error",
      message: "Configured Cursor CLI did not list required MCP tools: review-verdict-mcp:submit_review_verdict",
    });
  });

  it("errors when configured review pass state is absent from Linear workflow states", async () => {
    const config = testConfig("/tmp/symphony-doctor");
    config.tracker.handoffStates = ["In Review"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.reviewLoop.blockedStates = ["Blocked"];
    config.reviewLoop.reviewPassState = "Ready to Merge";

    const checks = await reviewLoopDoctorChecks(config, {
      workflowPath: "/tmp/symphony-doctor/WORKFLOW.md",
      mcpToolLister: async ({ command }) =>
        command === "completion-report-mcp" ? ["submit_completion_report"] : ["submit_review_verdict"],
      linearStateLister: async () => ["Blocked", "Todo", "Duplicate", "Canceled", "Backlog", "In Progress", "Done", "In Review"],
    });

    expect(checks).toContainEqual({
      id: "review_loop.linear_states",
      status: "error",
      message:
        "Linear team is missing configured review-loop states: Ready to Merge. Available states: Blocked, Todo, Duplicate, Canceled, Backlog, In Progress, Done, In Review",
    });
  });

  it("warns when Linear state availability cannot be checked", async () => {
    const config = testConfig("/tmp/symphony-doctor");
    config.tracker.handoffStates = ["In Review"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.reviewLoop.blockedStates = ["Blocked"];
    config.reviewLoop.reviewPassState = "Ready to Merge";

    const checks = await reviewLoopDoctorChecks(config, {
      workflowPath: "/tmp/symphony-doctor/WORKFLOW.md",
      mcpToolLister: async ({ command }) =>
        command === "completion-report-mcp" ? ["submit_completion_report"] : ["submit_review_verdict"],
      linearStateLister: async () => {
        throw new Error("Linear API unavailable");
      },
    });

    expect(checks).toContainEqual({
      id: "review_loop.linear_states",
      status: "warn",
      message: "Could not verify Linear review-loop state availability: Linear API unavailable",
    });
  });

  it("warns when continuation context placeholder flags are enabled", () => {
    const config = testConfig("/tmp/symphony-doctor");
    config.continuationContext.searchEnabled = true;
    config.continuationContext.summarizationEnabled = true;

    expect(continuationContextDoctorChecks(config)).toEqual([
      {
        id: "continuation_context.search",
        status: "warn",
        message:
          "continuation_context.search_enabled is enabled, but search is not_implemented; keep roadmap issues in Backlog with dogfood-blocked and without dogfood-ready until a concrete implementation lands",
      },
      {
        id: "continuation_context.summarization",
        status: "warn",
        message:
          "continuation_context.summarization_enabled is enabled, but summarization is not_implemented; keep roadmap issues in Backlog with dogfood-blocked and without dogfood-ready until a concrete implementation lands",
      },
    ]);
  });

  it("does not warn for default-off continuation context placeholder flags", () => {
    const config = testConfig("/tmp/symphony-doctor");

    expect(continuationContextDoctorChecks(config)).toEqual([]);
  });

  it("validates GitHub publication with the resolved worker publication profile", async () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        github: {
          owner: "acme",
          repo: "symphony",
          token: "legacy-github-token",
          api_base_url: "https://api.github.test",
          publish_pull_requests: true,
        },
        credential_profiles: {
          profiles: {
            publication: { value: "$GITHUB_PUBLICATION_TOKEN", capabilities: ["github.publication"] },
          },
          roles: {
            worker: {
              "github.publication": "publication",
            },
          },
        },
      },
      "/tmp/symphony-doctor/WORKFLOW.md",
      {
        LINEAR_API_KEY: "linear-secret",
        GITHUB_PUBLICATION_TOKEN: "publication-secret",
      },
    );
    const authorizations: string[] = [];
    vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
      authorizations.push(String((init?.headers as Record<string, string> | undefined)?.authorization));
      return new Response(JSON.stringify({ id: 1 }), { status: 200, headers: { "content-type": "application/json" } });
    });

    await expect(githubPublicationDoctorCheck(config)).resolves.toEqual({
      id: "github.pr_publication",
      status: "ok",
      message: "GitHub PR publication can access acme/symphony",
    });
    expect(authorizations).toEqual(["Bearer publication-secret"]);
  });

  it("reports publication capability assignment failures", async () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        github: {
          owner: "acme",
          repo: "symphony",
          token: "legacy-github-token",
          publish_pull_requests: true,
        },
        credential_profiles: {
          profiles: {
            publication: { value: "$GITHUB_PUBLICATION_TOKEN", capabilities: ["github.publication"] },
          },
          roles: {
            reviewer: {
              "github.publication": "publication",
            },
          },
        },
      },
      "/tmp/symphony-doctor/WORKFLOW.md",
      {
        LINEAR_API_KEY: "linear-secret",
        GITHUB_PUBLICATION_TOKEN: "publication-secret",
      },
    );

    await expect(githubPublicationDoctorCheck(config)).resolves.toMatchObject({
      id: "github.pr_publication",
      status: "error",
      message: expect.stringContaining("github.publication"),
    });
    await expect(githubPublicationDoctorCheck(config)).resolves.toMatchObject({
      message: expect.stringContaining("credential_profiles.roles.worker.github.publication"),
    });
  });
});

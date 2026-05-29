import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseServiceConfig } from "../src/core/config/Config.js";
import { HermesAuthManager } from "../hermes/src/HermesAuthManager.js";
import {
  continuationContextDoctorChecks,
  cursorPolicyDoctorChecks,
  githubPublicationDoctorCheck,
  githubReviewFeedbackDoctorCheck,
  hermesAuthDoctorChecks,
  hermesLiveRuntimeDoctorCheck,
  hermesRuntimeDoctorChecks,
  reviewLoopDoctorChecks,
  runtimeCredentialDoctorCheck,
  runtimeHarnessDoctorChecks,
} from "../src/doctor.js";
import { testConfig } from "./helpers.js";
import type { GatewayEvent, HermesGatewayClient, HermesGatewayEnvironment } from "../hermes/src/GatewayFacade.js";

describe("doctor review-loop checks", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reports bounded Cursor policy and ambient setting-source warnings", () => {
    const bounded = testConfig("/tmp/symphony-doctor");
    expect(cursorPolicyDoctorChecks(bounded)).toEqual([
      {
        id: "cursor.model",
        status: "ok",
        message: "Cursor model is gpt-5.5 with params context=272k, reasoning=extra-high; large context opt-in is disabled",
      },
      {
        id: "cursor.context",
        status: "ok",
        message: "Managed Cursor runs are bounded to context=272k",
      },
      {
        id: "cursor.setting_sources",
        status: "ok",
        message: "Managed Cursor runs do not load project/user setting sources by default",
      },
      {
        id: "cursor.mode",
        status: "ok",
        message: "Managed Cursor runs use the SDK default conversation mode",
      },
    ]);

    const ambient = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        cursor: {
          model_params: { context: "272k", reasoning: "extra-high" },
          setting_sources: ["project", "user"],
        },
      },
      "/tmp/symphony-doctor/WORKFLOW.md",
      { LINEAR_API_KEY: "secret" },
    );

    expect(cursorPolicyDoctorChecks(ambient)).toContainEqual({
      id: "cursor.setting_sources",
      status: "warn",
      message: "Managed Cursor runs load setting sources: project, user",
    });
    ambient.cursor.mode = "plan";
    expect(cursorPolicyDoctorChecks(ambient)).toContainEqual({
      id: "cursor.mode",
      status: "warn",
      message: "Managed Cursor runs request plan conversation mode",
    });
  });

  it("runs Hermes runtime checks without assuming Cursor policy", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        agent: { harness: "hermes" },
        hermes: {
          state_dir: "/tmp/hermes-state",
          model: "hermes-test-model",
          provider: "openai",
          role_templates: { reviewer: "fresh-reviewer" },
        },
      },
      "/tmp/symphony-doctor/WORKFLOW.md",
      { LINEAR_API_KEY: "secret" },
    );

    expect(runtimeHarnessDoctorChecks(config)).toEqual([
      { id: "runtime.harness", status: "ok", message: "Runtime harness is hermes" },
      {
        id: "hermes.runtime",
        status: "ok",
        message: "Hermes provider is openai; model is hermes-test-model",
      },
      {
        id: "hermes.profiles",
        status: "ok",
        message:
          `state_dir: ${config.hermes.stateDir}; templates: worker=worker, reviewer=fresh-reviewer, planner=planner; worker lifecycle is reuse_by_issue; profile retention is failed`,
      },
    ]);
    expect(hermesRuntimeDoctorChecks(config)[0]).toMatchObject({ id: "hermes.runtime", status: "ok" });
  });

  it("errors when Hermes dogfood would run without an explicit model", async () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        agent: { harness: "hermes" },
        hermes: {
          provider: "openai-codex",
        },
      },
      "/tmp/symphony-doctor/WORKFLOW.md",
      { LINEAR_API_KEY: "secret" },
    );

    expect(hermesRuntimeDoctorChecks(config)).toContainEqual({
      id: "hermes.runtime",
      status: "error",
      message:
        "hermes.model is required when agent.harness is hermes so the upstream gateway cannot fall back to an unrelated default model",
    });
    await expect(hermesLiveRuntimeDoctorCheck(config, { cliPath: "/tmp/symphony-doctor/src/cli.ts" })).resolves.toEqual({
      id: "hermes.live_runtime",
      status: "error",
      message: "Hermes live runtime check requires hermes.model before starting the gateway",
    });
  });

  it("runs the opt-in Hermes live runtime doctor check with a gateway session and tools.list", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-doctor-hermes-live-"));
    try {
      await writeHermesTemplates(root);
      const clients: DoctorFakeHermesGatewayClient[] = [];
      const config = parseServiceConfig(
        {
          tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
          workspace: { root: path.join(root, "workspaces"), state_dir: path.join(root, "state") },
          agent: { harness: "hermes" },
          hermes: {
            upstream_root: path.join(root, "upstream"),
            templates_dir: path.join(root, "templates"),
            state_dir: path.join(root, "state", "hermes"),
            provider: "openai-codex",
            model: "gpt-5-test",
            auth: { managed_root: path.join(root, "auth") },
          },
        },
        path.join(root, "WORKFLOW.md"),
        { LINEAR_API_KEY: "secret" },
      );

      await expect(
        hermesLiveRuntimeDoctorCheck(config, {
          cliPath: path.join(root, "cli.ts"),
          hermesGatewayFactory: (env) => {
            const client = new DoctorFakeHermesGatewayClient(env);
            clients.push(client);
            return client;
          },
        }),
      ).resolves.toEqual({
        id: "hermes.live_runtime",
        status: "ok",
        message: "Hermes gateway session exposes required Symphony MCP tools for worker and reviewer profiles",
      });
      expect(clients).toHaveLength(2);
      expect(clients.flatMap((client) => client.requests.map((request) => request.method))).toContain("tools.list");
      expect(clients.every((client) => client.env.authHome === config.hermes.auth.managedRoot)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("checks Hermes-owned auth for openai-codex without requiring runtime.hermes credentials", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-doctor-hermes-auth-"));
    try {
      const bootstrapFrom = path.join(root, "local-hermes");
      await mkdir(bootstrapFrom, { recursive: true });
      await writeFile(
        path.join(bootstrapFrom, "auth.json"),
        JSON.stringify({
          version: 1,
          active_provider: "openai-codex",
          providers: {
            "openai-codex": {
              tokens: { access_token: "access-token", refresh_token: "refresh-token" },
              last_refresh: "2026-05-27T00:00:00Z",
              auth_mode: "chatgpt",
            },
          },
        }),
        "utf8",
      );
      const config = parseServiceConfig(
        {
          tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
          agent: { harness: "hermes" },
          hermes: {
            upstream_root: path.resolve("hermes/upstream-src"),
            state_dir: path.join(root, "state", "hermes"),
            provider: "openai-codex",
            auth: { bootstrap_from: bootstrapFrom },
          },
        },
        path.join(root, "WORKFLOW.md"),
        { LINEAR_API_KEY: "secret" },
      );

      await expect(
        hermesAuthDoctorChecks(config, {
          hermesAuthManagerFactory: (options) => {
            const realManager = new HermesAuthManager(options);
            return {
              prepare: (providers) => realManager.prepare(providers),
              validateOpenAiCodex: async () => ({
                provider: "openai-codex",
                source: "hermes-auth-store",
                authMode: "chatgpt",
              }),
            };
          },
        }),
      ).resolves.toEqual([
        {
          id: "hermes.auth_root",
          status: "ok",
          message: `Hermes managed auth root is ready at ${config.hermes.auth.managedRoot}; bootstrap source is ${bootstrapFrom}`,
        },
        {
          id: "hermes.auth.openai-codex",
          status: "ok",
          message: "Hermes managed auth for openai-codex is available from bootstrapped",
        },
        {
          id: "hermes.auth.openai-codex.resolve",
          status: "ok",
          message: "Hermes Python resolved openai-codex auth via hermes-auth-store",
        },
      ]);
      expect(runtimeCredentialDoctorCheck(config)).toEqual({
        id: "env.hermes",
        status: "ok",
        message: `Hermes provider openai-codex uses managed Hermes auth at ${config.hermes.auth.managedRoot}`,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps API-key Hermes providers on the legacy runtime.hermes credential check", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        agent: { harness: "hermes" },
        hermes: {
          provider: "openai-api",
        },
      },
      "/tmp/symphony-doctor/WORKFLOW.md",
      { LINEAR_API_KEY: "secret" },
    );

    expect(runtimeCredentialDoctorCheck(config)).toMatchObject({
      id: "env.hermes",
      status: "warn",
    });
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
        mcpToolLister: async ({ command }) => mcpToolsFor(command),
        linearStateLister: async () => [linearTeam(["Todo", "In Progress", "In Review", "Blocked", "Ready to Merge", "Done"])],
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
        message: "Linear project teams have configured review-loop states: In Review, Blocked, Ready to Merge (Engineering (ENG))",
      },
      {
        id: "review_loop.blocked_state",
        status: "ok",
        message: "blocked_states: Blocked",
      },
      {
        id: "review_loop.mcp_tools",
        status: "ok",
        message:
          "Configured MCP subprocess runner lists tools: submit_completion_report, submit_review_verdict, submit_pull_request_review_feedback",
      },
      {
        id: "review_loop.candidate_isolation",
        status: "ok",
        message:
          "worker candidates require labels: dogfood-ready; review/blocked states are isolated from active states",
      },
    ]);
  });

  it("allows PR handoff states to differ from reviewer-agent states", async () => {
    const config = testConfig("/tmp/symphony-doctor");
    config.tracker.activeStates = ["Todo", "In Progress"];
    config.tracker.handoffStates = ["Human Review"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.reviewLoop.blockedStates = ["Blocked"];
    config.reviewLoop.reviewPassState = "Ready to Merge";
    config.github.prHandoff.enabled = true;
    config.github.prHandoff.targetState = "Human Review";
    config.agent.requireLabels = ["dogfood-ready"];

    const checks = await reviewLoopDoctorChecks(config, {
      workflowPath: "/tmp/symphony-doctor/WORKFLOW.md",
      mcpToolLister: async ({ command }) => mcpToolsFor(command),
      linearStateLister: async () => [linearTeam(["Todo", "In Progress", "Human Review", "In Review", "Blocked", "Ready to Merge", "Done"])],
    });

    expect(checks).toContainEqual({
      id: "review_loop.states",
      status: "ok",
      message: "review_states: In Review; pass destination: Ready to Merge",
    });
    expect(checks).toContainEqual({
      id: "review_loop.linear_states",
      status: "ok",
      message: "Linear project teams have configured review-loop states: Human Review, In Review, Blocked, Ready to Merge (Engineering (ENG))",
    });
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
      mcpToolLister: async ({ command }) => mcpToolsFor(command),
      linearStateLister: async () => [linearTeam(["Todo", "In Progress", "In Review", "Ready to Merge", "Done"])],
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
      mcpToolLister: async ({ command }) => mcpToolsFor(command),
      linearStateLister: async () => [linearTeam(["Todo", "In Progress", "In Review", "Blocked", "Done"])],
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
        command === "review-verdict-mcp" ? ["unexpected_tool"] : mcpToolsFor(command),
      linearStateLister: async () => [linearTeam(["Todo", "In Progress", "In Review", "Blocked", "Ready to Merge", "Done"])],
    });

    expect(checks).toContainEqual({
      id: "review_loop.mcp_tools",
      status: "error",
      message: "Configured MCP subprocess runner did not list required tools: review-verdict-mcp:submit_review_verdict",
    });
  });

  it("reports missing explicit cliPath for default MCP exposure checks", async () => {
    const config = testConfig("/tmp/symphony-doctor");
    config.tracker.handoffStates = ["In Review"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.reviewLoop.reviewPassState = "Ready to Merge";

    const checks = await reviewLoopDoctorChecks(config, {
      workflowPath: "/tmp/symphony-doctor/WORKFLOW.md",
      linearStateLister: async () => [linearTeam(["Todo", "In Progress", "In Review", "Blocked", "Ready to Merge", "Done"])],
    });

    expect(checks).toContainEqual({
      id: "review_loop.mcp_tools",
      status: "error",
      message: "Configured MCP subprocess runner could not list review-loop MCP tools: missing explicit cliPath",
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
      mcpToolLister: async ({ command }) => mcpToolsFor(command),
      linearStateLister: async () => [linearTeam(["Blocked", "Todo", "Duplicate", "Canceled", "Backlog", "In Progress", "Done", "In Review"])],
    });

    expect(checks).toContainEqual({
      id: "review_loop.linear_states",
      status: "error",
      message:
        "Linear teams are missing configured review-loop states: Engineering (ENG) missing Ready to Merge (available: Blocked, Todo, Duplicate, Canceled, Backlog, In Progress, Done, In Review)",
    });
  });

  it("errors when one project team is missing configured review-loop states", async () => {
    const config = testConfig("/tmp/symphony-doctor");
    config.tracker.handoffStates = ["In Review"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.reviewLoop.blockedStates = ["Blocked"];
    config.reviewLoop.reviewPassState = "Ready to Merge";

    const checks = await reviewLoopDoctorChecks(config, {
      workflowPath: "/tmp/symphony-doctor/WORKFLOW.md",
      mcpToolLister: async ({ command }) => mcpToolsFor(command),
      linearStateLister: async () => [
        linearTeam(["In Review", "Blocked", "Ready to Merge"], { teamKey: "ENG", teamName: "Engineering" }),
        linearTeam(["In Review", "Blocked"], { teamKey: "OPS", teamName: "Operations" }),
      ],
    });

    expect(checks).toContainEqual({
      id: "review_loop.linear_states",
      status: "error",
      message:
        "Linear teams are missing configured review-loop states: Operations (OPS) missing Ready to Merge (available: In Review, Blocked)",
    });
  });

  it("errors when Linear state availability cannot be checked", async () => {
    const config = testConfig("/tmp/symphony-doctor");
    config.tracker.handoffStates = ["In Review"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.reviewLoop.blockedStates = ["Blocked"];
    config.reviewLoop.reviewPassState = "Ready to Merge";

    const checks = await reviewLoopDoctorChecks(config, {
      workflowPath: "/tmp/symphony-doctor/WORKFLOW.md",
      mcpToolLister: async ({ command }) => mcpToolsFor(command),
      linearStateLister: async () => {
        throw new Error("Linear API unavailable");
      },
    });

    expect(checks).toContainEqual({
      id: "review_loop.linear_states",
      status: "error",
      message: "Could not verify Linear review-loop state availability: Linear API unavailable",
    });
  });

  it("errors when Linear pagination makes state availability inconclusive", async () => {
    const config = testConfig("/tmp/symphony-doctor");
    config.tracker.handoffStates = ["In Review"];
    config.reviewLoop.reviewStates = ["In Review"];
    config.reviewLoop.blockedStates = ["Blocked"];
    config.reviewLoop.reviewPassState = "Ready to Merge";

    const checks = await reviewLoopDoctorChecks(config, {
      workflowPath: "/tmp/symphony-doctor/WORKFLOW.md",
      mcpToolLister: async ({ command }) => mcpToolsFor(command),
      linearStateLister: async () => {
        throw new Error("Linear project TEST teams pagination reported next page without endCursor");
      },
    });

    expect(checks).toContainEqual({
      id: "review_loop.linear_states",
      status: "error",
      message:
        "Could not verify Linear review-loop state availability: Linear project TEST teams pagination reported next page without endCursor",
    });
  });

  it("warns when no review-loop Linear states are configured to verify", async () => {
    const config = testConfig("/tmp/symphony-doctor");
    config.tracker.handoffStates = [];
    config.reviewLoop.reviewStates = [];
    config.reviewLoop.blockedStates = [];
    config.reviewLoop.reviewPassState = null;

    const checks = await reviewLoopDoctorChecks(config, {
      workflowPath: "/tmp/symphony-doctor/WORKFLOW.md",
      mcpToolLister: async ({ command }) => mcpToolsFor(command),
      linearStateLister: async () => {
        throw new Error("should not verify when no states are configured");
      },
    });

    expect(checks).toContainEqual({
      id: "review_loop.linear_states",
      status: "warn",
      message: "No review-loop Linear states are configured to verify",
    });
  });

  it("reports implemented search and warns for placeholder summarization", () => {
    const config = testConfig("/tmp/symphony-doctor");
    config.continuationContext.searchEnabled = true;
    config.continuationContext.summarizationEnabled = true;

    expect(continuationContextDoctorChecks(config)).toEqual([
      {
        id: "continuation_context.search",
        status: "ok",
        message: "continuation_context.search_enabled is enabled and search is implemented",
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

  it("validates GitHub publication with the resolved service publication profile", async () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        github: {
          owner: "acme",
          repo: "symphony",
          token: "legacy-github-token",
          app: {
            app_id: "12345",
            installation_id: "67890",
            private_key: "not-a-real-private-key-publication-profile-should-win",
          },
          api_base_url: "https://api.github.test",
          publish_pull_requests: true,
          pr_handoff: { enabled: false },
        },
        credential_profiles: {
          profiles: {
            publication: { value: "$GITHUB_PUBLICATION_TOKEN", capabilities: ["github.publication"] },
          },
          roles: {
            service: {
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
      message: "GitHub PR publication can access acme/symphony using static GitHub token profile publication",
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
          pr_handoff: { enabled: false },
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
      message: expect.stringContaining("credential_profiles.roles.service.github.publication"),
    });
  });

  it("validates GitHub review feedback with the resolved reviewer feedback profile", async () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        github: {
          owner: "acme",
          repo: "symphony",
          token: "legacy-github-token",
          app: {
            app_id: "12345",
            installation_id: "67890",
            private_key: "not-a-real-private-key-feedback-profile-should-win",
          },
          api_base_url: "https://api.github.test",
        },
        credential_profiles: {
          profiles: {
            feedback: { value: "$GITHUB_FEEDBACK_TOKEN", capabilities: ["github.review_feedback_write"] },
          },
          roles: {
            reviewer: {
              "github.review_feedback_write": "feedback",
            },
          },
        },
      },
      "/tmp/symphony-doctor/WORKFLOW.md",
      {
        LINEAR_API_KEY: "linear-secret",
        GITHUB_FEEDBACK_TOKEN: "feedback-secret",
      },
    );
    const authorizations: string[] = [];
    vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
      authorizations.push(String((init?.headers as Record<string, string> | undefined)?.authorization));
      return new Response(JSON.stringify({ id: 1 }), { status: 200, headers: { "content-type": "application/json" } });
    });

    await expect(githubReviewFeedbackDoctorCheck(config)).resolves.toEqual({
      id: "github.review_feedback_write",
      status: "ok",
      message: "GitHub PR review feedback can access acme/symphony using static GitHub token profile feedback",
    });
    expect(authorizations).toEqual(["Bearer feedback-secret"]);
  });

  it("reports missing app-backed reviewer feedback profile config with the profile name", async () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        github: {
          owner: "acme",
          repo: "symphony",
          api_base_url: "https://api.github.test",
        },
        credential_profiles: {
          profiles: {
            feedback: {
              kind: "github_app",
              app_id: "$GITHUB_REVIEW_APP_ID",
              installation_id: "$GITHUB_REVIEW_APP_INSTALLATION_ID",
              private_key_path: "$GITHUB_REVIEW_APP_PRIVATE_KEY_PATH",
              capabilities: ["github.review_feedback_write"],
            },
          },
          roles: {
            reviewer: {
              "github.review_feedback_write": "feedback",
            },
          },
        },
      },
      "/tmp/symphony-doctor/WORKFLOW.md",
      { LINEAR_API_KEY: "linear-secret" },
    );
    vi.stubGlobal("fetch", async () => {
      throw new Error("fetch should not be called for missing app profile config");
    });

    await expect(githubReviewFeedbackDoctorCheck(config)).resolves.toEqual({
      id: "github.review_feedback_write",
      status: "error",
      message:
        "github.review_feedback_write: GitHub App profile feedback for github.review_feedback_write is missing app_id",
    });
  });
});

function mcpToolsFor(command: string): string[] {
  if (command === "completion-report-mcp") return ["submit_completion_report"];
  if (command === "review-verdict-mcp") return ["submit_review_verdict"];
  if (command === "review-feedback-mcp") return ["submit_pull_request_review_feedback"];
  return [];
}

function linearTeam(
  states: string[],
  overrides: { teamId?: string; teamKey?: string; teamName?: string | null } = {},
): { teamId: string; teamKey: string; teamName: string | null; states: string[] } {
  return {
    teamId: overrides.teamId ?? "team-eng",
    teamKey: overrides.teamKey ?? "ENG",
    teamName: overrides.teamName ?? "Engineering",
    states,
  };
}

class DoctorFakeHermesGatewayClient extends EventEmitter implements HermesGatewayClient {
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];

  constructor(readonly env: HermesGatewayEnvironment) {
    super();
  }

  on(event: "event", listener: (event: GatewayEvent) => void): this;
  on(event: "exit", listener: (code: number | null) => void): this;
  on(event: "event" | "exit", listener: ((event: GatewayEvent) => void) | ((code: number | null) => void)): this {
    return super.on(event, listener);
  }

  off(event: "event", listener: (event: GatewayEvent) => void): this;
  off(event: "exit", listener: (code: number | null) => void): this;
  off(event: "event" | "exit", listener: ((event: GatewayEvent) => void) | ((code: number | null) => void)): this {
    return super.off(event, listener);
  }

  drain(): void {
    return;
  }

  async request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.requests.push({ method, params });
    if (method === "session.create") return { session_id: "doctor-session" } as T;
    if (method === "tools.list") {
      return {
        toolsets: [
          {
            name: "mcp-symphony",
            tools: [
              "mcp_symphony_submit_completion_report",
              "mcp_symphony_review_verdict_submit_review_verdict",
              "mcp_symphony_review_feedback_submit_pull_request_review_feedback",
            ],
          },
        ],
      } as T;
    }
    return { ok: true } as T;
  }

  kill(): void {
    return;
  }

  getLogTail(): string {
    return "";
  }
}

async function writeHermesTemplates(root: string): Promise<void> {
  for (const template of ["worker", "reviewer", "planner"]) {
    const templateDir = path.join(root, "templates", template);
    await mkdir(templateDir, { recursive: true });
    await writeFile(path.join(templateDir, "SOUL.md"), `${template} soul\n`, "utf8");
    await writeFile(path.join(templateDir, "config.yaml"), "memory_enabled: false\n", "utf8");
  }
}

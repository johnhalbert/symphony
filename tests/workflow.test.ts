import { describe, expect, it } from "vitest";
import { parseServiceConfig } from "../src/core/config/Config.js";
import { SymphonyError } from "../src/core/errors.js";
import { PromptRenderer } from "../src/core/workflow/PromptRenderer.js";
import { parseWorkflowFile } from "../src/core/workflow/WorkflowLoader.js";
import { issue } from "./helpers.js";

describe("workflow loading and prompt rendering", () => {
  it("parses YAML front matter and markdown body", () => {
    const workflow = parseWorkflowFile(
      `---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: TEST
---
Work on {{ issue.identifier }}.`,
      "/repo/WORKFLOW.md",
    );

    expect(workflow.config.tracker?.project_slug).toBe("TEST");
    expect(workflow.promptTemplate).toBe("Work on {{ issue.identifier }}.");
  });

  it("resolves typed config defaults and env indirection", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "$LINEAR_PROJECT_SLUG" },
      },
      "/repo/WORKFLOW.md",
      { LINEAR_API_KEY: "secret", LINEAR_ASSIGNEE: "me", LINEAR_PROJECT_SLUG: "TEST" },
    );

    expect(config.tracker.apiKey).toBe("secret");
    expect(config.tracker.projectSlug).toBe("TEST");
    expect(config.tracker.assignee).toBe("me");
    expect(config.agent.harness).toBe("cursor");
    expect(config.cursor.model).toBe("gpt-5.5");
    expect(config.cursor.modelParams).toEqual([
      { id: "context", value: "272k" },
      { id: "reasoning", value: "extra-high" },
    ]);
    expect(config.cursor.settingSources).toEqual([]);
    expect(config.cursor.allowLargeContext).toBe(false);
    expect(config.cursor.workerAgentLifecycle).toBe("fresh_per_run");
    expect(config.github).toEqual({
      owner: null,
      repo: null,
      token: null,
      headOwner: null,
      apiBaseUrl: "https://api.github.com",
      publishPullRequests: false,
      operatorApproval: {
        requiredForPublication: false,
        rejectPolicy: "cancel",
        pollIntervalMs: 2000,
        timeoutMs: null,
      },
    });
    expect(config.continuationContext).toEqual({
      searchEnabled: false,
      summarizationEnabled: false,
    });
    expect(config.mergePolicy).toEqual({
      mode: "disabled",
      sourceStates: [],
      doneState: "Done",
      mergeMethod: "merge",
      requiredChecks: [],
      noCiAllowed: false,
      noCiEvidence: null,
    });
    expect(config.issueBoard.columns).toEqual({
      backlog: ["Backlog"],
      todo: ["Todo"],
      progress: ["In Progress"],
      review: [],
      done: ["Done", "Closed"],
      canceled: ["Cancelled", "Canceled", "Duplicate"],
    });
    expect(config.workspace.stateDir.replace(/\\/g, "/")).toMatch(/\/repo\/symphony_workspaces\/\.symphony$/);
  });

  it("parses handoff states and dispatch label guardrails", () => {
    const config = parseServiceConfig(
      {
        tracker: {
          kind: "linear",
          api_key: "$LINEAR_API_KEY",
          project_slug: "TEST",
          active_states: ["Todo", "In Progress"],
          handoff_states: ["In Review"],
          terminal_states: ["Done"],
        },
        agent: {
          require_labels: ["Dogfood-Ready"],
          exclude_labels: ["Safety-Blocked"],
          protected_paths: ["src/core/orchestrator/**"],
        },
        writeback: {
          enabled: true,
          mode: "live",
          dispatch_state: "In Progress",
          max_backoff_ms: 60_000,
        },
        review_loop: {
          review_states: ["In Review"],
          blocked_states: ["Blocked"],
          review_pass_state: "Review Passed",
          reviewer_prompt: "Review {{ issue.identifier }}",
          max_review_rounds: 4,
          max_incomplete_turns: 2,
          continuation_history_threshold: 7,
        },
        merge_policy: {
          mode: "gated",
          source_states: ["Review Passed"],
          done_state: "Done",
          merge_method: "squash",
          required_checks: ["test"],
          no_ci: { allowed: false },
        },
        continuation_context: {
          search_enabled: true,
          summarization_enabled: true,
        },
      },
      "/repo/WORKFLOW.md",
      { LINEAR_API_KEY: "secret" },
    );

    expect(config.tracker.handoffStates).toEqual(["In Review"]);
    expect(config.agent.requireLabels).toEqual(["dogfood-ready"]);
    expect(config.agent.excludeLabels).toEqual(["safety-blocked"]);
    expect(config.agent.protectedPaths).toEqual(["src/core/orchestrator/**"]);
    expect(config.writeback).toMatchObject({
      enabled: true,
      mode: "live",
      dispatchState: "In Progress",
      maxBackoffMs: 60_000,
    });
    expect(config.reviewLoop).toEqual({
      reviewStates: ["In Review"],
      blockedStates: ["Blocked"],
      reviewPassState: "Review Passed",
      reviewerPromptTemplate: "Review {{ issue.identifier }}",
      maxReviewRounds: 4,
      maxIncompleteTurns: 2,
      continuationHistoryThreshold: 7,
      transcriptHistoryLimit: 7,
      prReviewEvidenceLimit: 5,
    });
    expect(config.continuationContext).toEqual({
      searchEnabled: true,
      summarizationEnabled: true,
    });
    expect(config.mergePolicy).toEqual({
      mode: "gated",
      sourceStates: ["Review Passed"],
      doneState: "Done",
      mergeMethod: "squash",
      requiredChecks: ["test"],
      noCiAllowed: false,
      noCiEvidence: null,
    });
    expect(config.issueBoard.columns).toEqual({
      backlog: ["Backlog"],
      todo: ["Todo"],
      progress: ["In Progress", "Blocked"],
      review: ["In Review", "Review Passed"],
      done: ["Done"],
      canceled: [],
    });
  });

  it("parses configurable issue board columns and rejects duplicate state mappings", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        issue_board: {
          columns: {
            backlog: ["Backlog"],
            todo: ["Ready"],
            progress: ["Doing"],
            review: ["Reviewing"],
            done: ["Shipped"],
            canceled: ["Won't Do"],
          },
        },
      },
      "/repo/WORKFLOW.md",
      { LINEAR_API_KEY: "secret" },
    );

    expect(config.issueBoard.columns).toEqual({
      backlog: ["Backlog"],
      todo: ["Ready"],
      progress: ["Doing"],
      review: ["Reviewing"],
      done: ["Shipped"],
      canceled: ["Won't Do"],
    });
    expect(() =>
      parseServiceConfig(
        {
          tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
          issue_board: {
            columns: {
              backlog: ["Todo"],
            },
          },
        },
        "/repo/WORKFLOW.md",
        { LINEAR_API_KEY: "secret" },
      ),
    ).toThrow("issue_board.columns must not map state Todo to both backlog and todo");
  });

  it("requires explicit no-CI evidence when no-CI is allowed", () => {
    expect(() =>
      parseServiceConfig(
        {
          tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
          merge_policy: {
            mode: "gated",
            no_ci: { allowed: true },
          },
        },
        "/repo/WORKFLOW.md",
        { LINEAR_API_KEY: "secret" },
      ),
    ).toThrow(SymphonyError);
  });

  it("normalizes merge policy required checks before gating", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        merge_policy: {
          mode: "gated",
          required_checks: [" test ", "test", " ", "typecheck"],
        },
      },
      "/repo/WORKFLOW.md",
      { LINEAR_API_KEY: "secret" },
    );

    expect(config.mergePolicy.requiredChecks).toEqual(["test", "typecheck"]);
  });

  it("treats blank-only required checks as no configured checks", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        merge_policy: {
          mode: "gated",
          required_checks: [" ", "\t"],
        },
      },
      "/repo/WORKFLOW.md",
      { LINEAR_API_KEY: "secret" },
    );

    expect(config.mergePolicy.requiredChecks).toEqual([]);
  });

  it("rejects handoff states that overlap active or terminal states", () => {
    expect(() =>
      parseServiceConfig(
        {
          tracker: {
            kind: "linear",
            api_key: "$LINEAR_API_KEY",
            project_slug: "TEST",
            active_states: ["Todo", "In Review"],
            handoff_states: ["In Review"],
          },
        },
        "/repo/WORKFLOW.md",
        { LINEAR_API_KEY: "secret" },
      ),
    ).toThrow(SymphonyError);
  });

  it("rejects review-loop state bucket overlaps", () => {
    expect(() =>
      parseServiceConfig(
        {
          tracker: {
            kind: "linear",
            api_key: "$LINEAR_API_KEY",
            project_slug: "TEST",
            active_states: ["Todo", "In Progress"],
            terminal_states: ["Done"],
          },
          review_loop: {
            review_states: ["In Review"],
            blocked_states: ["Blocked"],
            review_pass_state: "Done",
          },
        },
        "/repo/WORKFLOW.md",
        { LINEAR_API_KEY: "secret" },
      ),
    ).toThrow(SymphonyError);

    expect(() =>
      parseServiceConfig(
        {
          tracker: {
            kind: "linear",
            api_key: "$LINEAR_API_KEY",
            project_slug: "TEST",
            active_states: ["Todo", "Blocked"],
          },
          review_loop: {
            blocked_states: ["Blocked"],
          },
        },
        "/repo/WORKFLOW.md",
        { LINEAR_API_KEY: "secret" },
      ),
    ).toThrow(SymphonyError);
  });

  it("allows non-default cursor model params to be overridden", () => {
    const configured = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        cursor: { model: "composer-2.5", model_params: { reasoning: "high" } },
      },
      "/repo/WORKFLOW.md",
      { LINEAR_API_KEY: "secret" },
    );

    expect(configured.cursor.model).toBe("composer-2.5");
    expect(configured.cursor.modelParams).toEqual([{ id: "reasoning", value: "high" }]);
  });

  it("requires bounded gpt-5.5 context unless large context is explicitly allowed", () => {
    expect(() =>
      parseServiceConfig(
        {
          tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
          cursor: { model_params: {} },
        },
        "/repo/WORKFLOW.md",
        { LINEAR_API_KEY: "secret" },
      ),
    ).toThrow("cursor.model_params.context must be 272k");
    expect(() =>
      parseServiceConfig(
        {
          tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
          cursor: { model_params: { context: "1m", reasoning: "extra-high" } },
        },
        "/repo/WORKFLOW.md",
        { LINEAR_API_KEY: "secret" },
      ),
    ).toThrow("cursor.model_params.context=1m requires cursor.allow_large_context");

    const largeContext = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        cursor: {
          allow_large_context: true,
          model_params: { context: "1m", reasoning: "extra-high" },
          setting_sources: [],
          worker_agent_lifecycle: "resume_by_issue",
        },
      },
      "/repo/WORKFLOW.md",
      { LINEAR_API_KEY: "secret" },
    );

    expect(largeContext.cursor.modelParams).toEqual([
      { id: "context", value: "1m" },
      { id: "reasoning", value: "extra-high" },
    ]);
    expect(largeContext.cursor.allowLargeContext).toBe(true);
    expect(largeContext.cursor.settingSources).toEqual([]);
    expect(largeContext.cursor.workerAgentLifecycle).toBe("resume_by_issue");
  });

  it("parses git worktree workspace config", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        workspace: {
          root: "./workspaces",
          state_dir: "./state",
          source: {
            kind: "git_worktree",
            repository: "./repo",
            base_ref: "main",
            branch_template: "symphony/{{ issue.identifier }}",
            cleanup: "force",
          },
        },
      },
      "/repo/WORKFLOW.md",
      { LINEAR_API_KEY: "secret" },
    );

    expect(config.workspace.root.replace(/\\/g, "/")).toMatch(/\/repo\/workspaces$/);
    expect(config.workspace.stateDir.replace(/\\/g, "/")).toMatch(/\/repo\/workspaces\/state$/);
    expect(config.workspace.source).toMatchObject({
      kind: "git_worktree",
      baseRef: "main",
      branchTemplate: "symphony/{{ issue.identifier }}",
      cleanup: "force",
    });
    expect(config.workspace.source.repository?.replace(/\\/g, "/")).toMatch(/\/repo\/repo$/);
  });

  it("parses GitHub PR discovery config with env indirection", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        github: {
          owner: "octo-org",
          repo: "symphony",
          token: "$GITHUB_TOKEN",
          head_owner: "fork-owner",
          api_base_url: "https://github.example/api/v3",
        },
      },
      "/repo/WORKFLOW.md",
      { LINEAR_API_KEY: "secret", GITHUB_TOKEN: "github-secret" },
    );

    expect(config.github).toEqual({
      owner: "octo-org",
      repo: "symphony",
      token: "github-secret",
      headOwner: "fork-owner",
      apiBaseUrl: "https://github.example/api/v3",
      publishPullRequests: false,
      operatorApproval: {
        requiredForPublication: false,
        rejectPolicy: "cancel",
        pollIntervalMs: 2000,
        timeoutMs: null,
      },
    });
  });

  it("leaves GitHub PR discovery disabled when token or repo config is missing", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        github: {
          owner: "octo-org",
          repo: "symphony",
          token: "$GITHUB_TOKEN",
        },
      },
      "/repo/WORKFLOW.md",
      { LINEAR_API_KEY: "secret" },
    );

    expect(config.github).toMatchObject({
      owner: "octo-org",
      repo: "symphony",
      token: null,
      headOwner: "octo-org",
      apiBaseUrl: "https://api.github.com",
    });
  });

  it("ignores obsolete Hermes blocks and rejects Hermes harness selection", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        hermes: {
          command: "hermes",
          home: "$HERMES_HOME",
          env: { HERMES_PROVIDER: "openai" },
        },
      },
      "/repo/WORKFLOW.md",
      { LINEAR_API_KEY: "secret", HERMES_HOME: "/tmp/hermes-home" },
    );

    expect(config.agent.harness).toBe("cursor");
    expect("hermes" in config).toBe(false);

    expect(() =>
      parseServiceConfig(
        {
          tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
          agent: { harness: "hermes", max_turns: 1 },
        },
        "/repo/WORKFLOW.md",
        { LINEAR_API_KEY: "secret" },
      ),
    ).toThrow(SymphonyError);
  });

  it("fails strict prompt rendering on unknown variables", async () => {
    const renderer = new PromptRenderer();
    await expect(renderer.render("{{ issue.nope }}", { issue: issue(), attempt: null })).rejects.toBeInstanceOf(
      SymphonyError,
    );
  });
});

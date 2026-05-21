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
    expect(config.cursor.modelParams).toEqual([{ id: "reasoning", value: "extra-high" }]);
    expect(config.cursor.settingSources).toEqual(["project", "user"]);
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
      },
      "/repo/WORKFLOW.md",
      { LINEAR_API_KEY: "secret" },
    );

    expect(config.tracker.handoffStates).toEqual(["In Review"]);
    expect(config.agent.requireLabels).toEqual(["dogfood-ready"]);
    expect(config.agent.excludeLabels).toEqual(["safety-blocked"]);
    expect(config.agent.protectedPaths).toEqual(["src/core/orchestrator/**"]);
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

  it("allows cursor model params to be overridden or disabled", () => {
    const configured = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        cursor: { model: "composer-2.5", model_params: { reasoning: "high" } },
      },
      "/repo/WORKFLOW.md",
      { LINEAR_API_KEY: "secret" },
    );
    const disabled = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        cursor: { model_params: {} },
      },
      "/repo/WORKFLOW.md",
      { LINEAR_API_KEY: "secret" },
    );

    expect(configured.cursor.model).toBe("composer-2.5");
    expect(configured.cursor.modelParams).toEqual([{ id: "reasoning", value: "high" }]);
    expect(disabled.cursor.modelParams).toEqual([]);
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

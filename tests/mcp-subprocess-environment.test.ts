import { describe, expect, it } from "vitest";
import { parseServiceConfig } from "../src/core/config/Config.js";
import {
  buildMcpCliSpawnArgs,
  buildMcpSubprocessEnvironment,
  buildMcpSubprocessServerConfig,
  shouldIncludeNodeExecArgv,
} from "../src/core/harness/McpSubprocessEnvironment.js";

describe("MCP subprocess environment", () => {
  it("includes Node execArgv for TypeScript CLI entrypoints only", () => {
    expect(shouldIncludeNodeExecArgv("/repo/src/cli.ts")).toBe(true);
    expect(shouldIncludeNodeExecArgv("/repo/src/cli.tsx")).toBe(true);
    expect(shouldIncludeNodeExecArgv("/repo/dist/cli.js")).toBe(false);

    expect(
      buildMcpCliSpawnArgs({
        cliPath: "/repo/src/cli.ts",
        command: "completion-report-mcp",
        workflowPath: "/repo/WORKFLOW.md",
        contextFile: "/tmp/context.json",
        execArgv: ["--import", "tsx"],
      }),
    ).toEqual([
      "--import",
      "tsx",
      "/repo/src/cli.ts",
      "completion-report-mcp",
      "--workflow",
      "/repo/WORKFLOW.md",
      "--context-file",
      "/tmp/context.json",
    ]);
    expect(
      buildMcpCliSpawnArgs({
        cliPath: "/repo/dist/cli.js",
        command: "completion-report-mcp",
        workflowPath: "/repo/WORKFLOW.md",
        contextFile: "/tmp/context.json",
        execArgv: ["--import", "tsx"],
      }),
    ).toEqual([
      "/repo/dist/cli.js",
      "completion-report-mcp",
      "--workflow",
      "/repo/WORKFLOW.md",
      "--context-file",
      "/tmp/context.json",
    ]);
  });

  it("builds MCP server configs with an explicit cliPath and env key slice", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        workspace: { root: "/workspaces" },
      },
      "/repo/WORKFLOW.md",
      { LINEAR_API_KEY: "linear-secret" },
    );

    const server = buildMcpSubprocessServerConfig({
      config,
      command: "review-verdict-mcp",
      cliPath: "/repo/dist/cli.js",
      workflowPath: "/repo/WORKFLOW.md",
      contextFile: "/tmp/review-context.json",
      execArgv: ["--import", "tsx"],
    });

    expect(server).toMatchObject({
      type: "stdio",
      command: process.execPath,
      env: { LINEAR_API_KEY: "linear-secret" },
    });
    expect(server.cwd).toBe(config.workflowDir);
    expect(server.args).toEqual([
      "/repo/dist/cli.js",
      "review-verdict-mcp",
      "--workflow",
      "/repo/WORKFLOW.md",
      "--context-file",
      "/tmp/review-context.json",
    ]);
  });

  it("keeps worker publication disabled env to runtime baseline and closed parse dependencies", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "$LINEAR_PROJECT_SLUG" },
        github: {
          owner: "acme",
          repo: "symphony",
          publish_pull_requests: false,
        },
        server: { open_workspace_token: "$OPEN_WORKSPACE_TOKEN" },
      },
      "/repo/WORKFLOW.md",
      {
        LINEAR_API_KEY: "linear-secret",
        LINEAR_PROJECT_SLUG: "TEST",
        GITHUB_TOKEN: "decoy-github-secret",
        CURSOR_API_KEY: "cursor-secret",
        OPEN_WORKSPACE_TOKEN: "open-secret",
      },
    );

    const env = buildMcpSubprocessEnvironment({
      config,
      command: "completion-report-mcp",
      parentEnv: {
        PATH: "/bin",
        GITHUB_TOKEN: "decoy-parent-github-secret",
        CURSOR_API_KEY: "cursor-parent-secret",
      },
    });

    expect(env).toMatchObject({
      PATH: "/bin",
      LINEAR_API_KEY: "linear-secret",
      LINEAR_PROJECT_SLUG: "TEST",
    });
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
    expect(env).not.toHaveProperty("CURSOR_API_KEY");
    expect(env).not.toHaveProperty("OPEN_WORKSPACE_TOKEN");
  });

  it("injects only the legacy GitHub publication fallback when PR publication is enabled without profiles", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        github: {
          owner: "acme",
          repo: "symphony",
          publish_pull_requests: true,
          pr_handoff: { enabled: false },
        },
      },
      "/repo/WORKFLOW.md",
      {
        LINEAR_API_KEY: "linear-secret",
        GITHUB_TOKEN: "legacy-github-secret",
      },
    );

    const env = buildMcpSubprocessEnvironment({
      config,
      command: "completion-report-mcp",
      parentEnv: { PATH: "/bin", GITHUB_TOKEN: "decoy-parent-github-secret" },
    });

    expect(env.GITHUB_TOKEN).toBe("legacy-github-secret");
    expect(githubEnvKeys(env)).toEqual(["GITHUB_TOKEN"]);
  });

  it("prefers the assigned worker publication profile and excludes a decoy parent GITHUB_TOKEN", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        github: {
          owner: "acme",
          repo: "symphony",
          publish_pull_requests: true,
          pr_handoff: { enabled: false },
        },
        credential_profiles: {
          profiles: {
            publication: { value: "$GITHUB_PUBLICATION_TOKEN", capabilities: ["github.publication"] },
            feedback: { value: "$GITHUB_FEEDBACK_TOKEN", capabilities: ["github.review_feedback_write"] },
          },
          roles: {
            worker: {
              "github.publication": "publication",
            },
            reviewer: {
              "github.review_feedback_write": "feedback",
            },
          },
        },
      },
      "/repo/WORKFLOW.md",
      {
        LINEAR_API_KEY: "linear-secret",
        GITHUB_TOKEN: "decoy-github-secret",
        GITHUB_PUBLICATION_TOKEN: "publication-secret",
        GITHUB_FEEDBACK_TOKEN: "feedback-secret",
      },
    );

    const env = buildMcpSubprocessEnvironment({
      config,
      command: "completion-report-mcp",
      parentEnv: { PATH: "/bin", GITHUB_TOKEN: "decoy-parent-github-secret" },
    });

    expect(env.GITHUB_PUBLICATION_TOKEN).toBe("publication-secret");
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
    expect(env).not.toHaveProperty("GITHUB_FEEDBACK_TOKEN");
    expect(githubEnvKeys(env)).toEqual(["GITHUB_PUBLICATION_TOKEN"]);
  });

  it("includes env-backed GitHub publication metadata refs without leaking decoy credentials", () => {
    const rawConfig = {
      tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
      github: {
        owner: "$GITHUB_OWNER",
        repo: "$GITHUB_REPO",
        head_owner: "$GITHUB_HEAD_OWNER",
        api_base_url: "$GITHUB_API_BASE_URL",
        token: "$CUSTOM_GITHUB_TOKEN",
        publish_pull_requests: true,
        pr_handoff: { enabled: false },
      },
    } as const;
    const config = parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", {
      LINEAR_API_KEY: "linear-secret",
      GITHUB_OWNER: "acme",
      GITHUB_REPO: "symphony",
      GITHUB_HEAD_OWNER: "john",
      GITHUB_API_BASE_URL: "https://api.github.test",
      CUSTOM_GITHUB_TOKEN: "custom-github-secret",
      GITHUB_TOKEN: "decoy-github-secret",
      CURSOR_API_KEY: "cursor-secret",
    });

    const env = buildMcpSubprocessEnvironment({
      config,
      command: "completion-report-mcp",
      parentEnv: { PATH: "/bin", GITHUB_TOKEN: "decoy-parent-github-secret", CURSOR_API_KEY: "cursor-parent-secret" },
    });

    expect(env).toMatchObject({
      GITHUB_OWNER: "acme",
      GITHUB_REPO: "symphony",
      GITHUB_HEAD_OWNER: "john",
      GITHUB_API_BASE_URL: "https://api.github.test",
      CUSTOM_GITHUB_TOKEN: "custom-github-secret",
    });
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
    expect(env).not.toHaveProperty("CURSOR_API_KEY");

    const childConfig = parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", env);
    expect(childConfig.github).toMatchObject({
      owner: "acme",
      repo: "symphony",
      headOwner: "john",
      apiBaseUrl: "https://api.github.test",
      token: "custom-github-secret",
      publishPullRequests: true,
    });
  });

  it("keeps profile credentials exclusive while carrying env-backed GitHub metadata refs", () => {
    const rawConfig = {
      tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
      github: {
        owner: "$GITHUB_OWNER",
        repo: "$GITHUB_REPO",
        publish_pull_requests: true,
        pr_handoff: { enabled: false },
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
    } as const;
    const config = parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", {
      LINEAR_API_KEY: "linear-secret",
      GITHUB_OWNER: "acme",
      GITHUB_REPO: "symphony",
      GITHUB_PUBLICATION_TOKEN: "publication-secret",
      GITHUB_TOKEN: "decoy-github-secret",
    });

    const env = buildMcpSubprocessEnvironment({
      config,
      command: "completion-report-mcp",
      parentEnv: { PATH: "/bin", GITHUB_TOKEN: "decoy-parent-github-secret" },
    });

    expect(env).toMatchObject({
      GITHUB_OWNER: "acme",
      GITHUB_REPO: "symphony",
      GITHUB_PUBLICATION_TOKEN: "publication-secret",
    });
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
    expect(env).not.toHaveProperty("CUSTOM_GITHUB_TOKEN");

    const childConfig = parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", env);
    expect(childConfig.credentialProfiles.resolveForRole("worker", "github.publication")).toMatchObject({
      source: "profile",
      value: "publication-secret",
    });
    expect(childConfig.github).toMatchObject({
      owner: "acme",
      repo: "symphony",
      token: null,
    });
  });

  it("injects only a custom github.token environment reference for publication", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        github: {
          owner: "acme",
          repo: "symphony",
          token: "$CUSTOM_GITHUB_TOKEN",
          publish_pull_requests: true,
          pr_handoff: { enabled: false },
        },
      },
      "/repo/WORKFLOW.md",
      {
        LINEAR_API_KEY: "linear-secret",
        CUSTOM_GITHUB_TOKEN: "custom-github-secret",
        GITHUB_TOKEN: "decoy-github-secret",
      },
    );

    const env = buildMcpSubprocessEnvironment({
      config,
      command: "completion-report-mcp",
      parentEnv: { PATH: "/bin", GITHUB_TOKEN: "decoy-parent-github-secret" },
    });

    expect(env.CUSTOM_GITHUB_TOKEN).toBe("custom-github-secret");
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
    expect(githubEnvKeys(env)).toEqual(["CUSTOM_GITHUB_TOKEN"]);
  });

  it("uses inline literal github.token values without injecting GitHub env vars", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        github: {
          owner: "acme",
          repo: "symphony",
          token: "literal-github-secret",
          publish_pull_requests: true,
          pr_handoff: { enabled: false },
        },
      },
      "/repo/WORKFLOW.md",
      {
        LINEAR_API_KEY: "linear-secret",
        GITHUB_TOKEN: "decoy-github-secret",
      },
    );

    const env = buildMcpSubprocessEnvironment({
      config,
      command: "completion-report-mcp",
      parentEnv: { PATH: "/bin", GITHUB_TOKEN: "decoy-parent-github-secret" },
    });

    expect(githubEnvKeys(env)).toEqual([]);
  });

  it("keeps reviewer verdict MCP free of GitHub credentials even when reviewer profiles are configured", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        github: {
          owner: "acme",
          repo: "symphony",
          token: "$CUSTOM_GITHUB_TOKEN",
          publish_pull_requests: true,
          pr_handoff: { enabled: false },
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
      "/repo/WORKFLOW.md",
      {
        LINEAR_API_KEY: "linear-secret",
        CUSTOM_GITHUB_TOKEN: "custom-github-secret",
        GITHUB_FEEDBACK_TOKEN: "feedback-secret",
        GITHUB_TOKEN: "decoy-github-secret",
      },
    );

    const env = buildMcpSubprocessEnvironment({
      config,
      command: "review-verdict-mcp",
      parentEnv: { PATH: "/bin", GITHUB_TOKEN: "decoy-parent-github-secret" },
    });

    expect(githubEnvKeys(env)).toEqual([]);
  });

  it("injects reviewer feedback profile credentials and metadata only for review feedback MCP", () => {
    const rawConfig = {
      tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
      github: {
        owner: "$GITHUB_OWNER",
        repo: "$GITHUB_REPO",
        head_owner: "$GITHUB_HEAD_OWNER",
        api_base_url: "$GITHUB_API_BASE_URL",
        token: "$PUBLICATION_TOKEN_REF",
        publish_pull_requests: true,
        pr_handoff: { enabled: false },
      },
      credential_profiles: {
        profiles: {
          publication: { value: "$GITHUB_PUBLICATION_TOKEN", capabilities: ["github.publication"] },
          feedback: { value: "$GITHUB_FEEDBACK_TOKEN", capabilities: ["github.review_feedback_write"] },
          reviewRead: { value: "$GITHUB_REVIEW_READ_TOKEN", capabilities: ["github.review_evidence_read"] },
        },
        roles: {
          worker: {
            "github.publication": "publication",
          },
          reviewer: {
            "github.review_feedback_write": "feedback",
            "github.review_evidence_read": "reviewRead",
          },
        },
      },
    } as const;
    const config = parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", {
      LINEAR_API_KEY: "linear-secret",
      GITHUB_OWNER: "acme",
      GITHUB_REPO: "symphony",
      GITHUB_HEAD_OWNER: "john",
      GITHUB_API_BASE_URL: "https://api.github.test",
      PUBLICATION_TOKEN_REF: "publication-ref-secret",
      GITHUB_PUBLICATION_TOKEN: "publication-secret",
      GITHUB_FEEDBACK_TOKEN: "feedback-secret",
      GITHUB_REVIEW_READ_TOKEN: "review-read-secret",
      GITHUB_TOKEN: "decoy-github-secret",
    });

    const env = buildMcpSubprocessEnvironment({
      config,
      command: "review-feedback-mcp",
      parentEnv: { PATH: "/bin", GITHUB_TOKEN: "decoy-parent-github-secret" },
    });

    expect(env).toMatchObject({
      GITHUB_OWNER: "acme",
      GITHUB_REPO: "symphony",
      GITHUB_HEAD_OWNER: "john",
      GITHUB_API_BASE_URL: "https://api.github.test",
      GITHUB_FEEDBACK_TOKEN: "feedback-secret",
    });
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
    expect(env).not.toHaveProperty("GITHUB_PUBLICATION_TOKEN");
    expect(env).not.toHaveProperty("GITHUB_REVIEW_READ_TOKEN");
    expect(env).not.toHaveProperty("PUBLICATION_TOKEN_REF");
    expect(githubEnvKeys(env)).toEqual([
      "GITHUB_API_BASE_URL",
      "GITHUB_FEEDBACK_TOKEN",
      "GITHUB_HEAD_OWNER",
      "GITHUB_OWNER",
      "GITHUB_REPO",
    ]);
  });

  it("carries the closed parse dependencies needed for child config parsing", () => {
    const rawConfig = {
      tracker: {
        kind: "linear",
        api_key: "$LINEAR_PROFILED_KEY",
        project_slug: "$LINEAR_PROJECT_SLUG",
        assignee: "$LINEAR_ASSIGNEE",
      },
      workspace: {
        root: "$WORKSPACE_ROOT",
        state_dir: "$WORKSPACE_STATE_DIR",
        source: {
          kind: "git_worktree",
          path: "$WORKSPACE_SOURCE_PATH",
          repository: "$WORKSPACE_REPOSITORY",
          base_ref: "main",
          cache_path: "$WORKSPACE_CACHE_PATH",
        },
      },
      github: {
        owner: "acme",
        repo: "symphony",
        publish_pull_requests: false,
      },
    } as const;
    const config = parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", {
      LINEAR_PROFILED_KEY: "linear-secret",
      LINEAR_PROJECT_SLUG: "TEST",
      LINEAR_ASSIGNEE: "john",
      WORKSPACE_ROOT: "/tmp/symphony-workspaces",
      WORKSPACE_STATE_DIR: "/tmp/symphony-state",
      WORKSPACE_SOURCE_PATH: "/tmp/source",
      WORKSPACE_REPOSITORY: "/tmp/repo",
      WORKSPACE_CACHE_PATH: "/tmp/cache",
      GITHUB_TOKEN: "decoy-github-secret",
      CURSOR_API_KEY: "cursor-secret",
    });

    const env = buildMcpSubprocessEnvironment({
      config,
      command: "review-verdict-mcp",
      parentEnv: { PATH: "/bin" },
    });

    expect(env).toMatchObject({
      LINEAR_PROFILED_KEY: "linear-secret",
      LINEAR_PROJECT_SLUG: "TEST",
      LINEAR_ASSIGNEE: "john",
      WORKSPACE_ROOT: config.workspace.root,
      WORKSPACE_STATE_DIR: config.workspace.stateDir,
      WORKSPACE_SOURCE_PATH: config.workspace.source.path,
      WORKSPACE_REPOSITORY: config.workspace.source.repository,
      WORKSPACE_CACHE_PATH: config.workspace.source.cachePath,
    });
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
    expect(env).not.toHaveProperty("CURSOR_API_KEY");

    const childConfig = parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", env);
    expect(childConfig.tracker).toMatchObject(config.tracker);
    expect(childConfig.workspace).toEqual(config.workspace);
  });

  it("reports missing assigned publication profile secrets without falling back to legacy GITHUB_TOKEN", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        github: {
          owner: "acme",
          repo: "symphony",
          publish_pull_requests: true,
          pr_handoff: { enabled: false },
        },
        credential_profiles: {
          profiles: {
            publication: { value: "$MISSING_GITHUB_PUBLICATION_TOKEN", capabilities: ["github.publication"] },
          },
          roles: {
            worker: {
              "github.publication": "publication",
            },
          },
        },
      },
      "/repo/WORKFLOW.md",
      {
        LINEAR_API_KEY: "linear-secret",
        GITHUB_TOKEN: "legacy-github-secret",
      },
    );

    expect(() =>
      buildMcpSubprocessEnvironment({
        config,
        command: "completion-report-mcp",
        parentEnv: { PATH: "/bin", GITHUB_TOKEN: "decoy-parent-github-secret" },
      }),
    ).toThrow(/MISSING_GITHUB_PUBLICATION_TOKEN/);
  });
});

function githubEnvKeys(env: Record<string, string>): string[] {
  return Object.keys(env)
    .filter((key) => key.includes("GITHUB"))
    .sort();
}

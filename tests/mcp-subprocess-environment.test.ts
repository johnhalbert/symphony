import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { parseServiceConfig } from "../src/core/config/Config.js";
import {
  buildMcpCliSpawnArgs,
  buildMcpSubprocessEnvironment,
  buildMcpSubprocessServerConfig,
  shouldIncludeNodeExecArgv,
} from "../src/core/harness/McpSubprocessEnvironment.js";
import { multiProjectWorkflowConfig, projectContextFixture } from "./helpers.js";

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
    expect(
      buildMcpCliSpawnArgs({
        cliPath: "/repo/src/cli.ts",
        command: "completion-report-mcp",
        workflowPath: "/repo/WORKFLOW.md",
        contextFile: "/tmp/context.json",
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
  });

  it("resolves the default tsx import relative to the CLI entrypoint", async () => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-mcp-cli-"));
    const cliPath = path.join(fixtureRoot, "src", "cli.ts");
    const loaderPath = path.join(fixtureRoot, "node_modules", "tsx", "dist", "loader.mjs");
    const packagePath = path.join(fixtureRoot, "node_modules", "tsx", "package.json");

    try {
      await mkdir(path.dirname(cliPath), { recursive: true });
      await mkdir(path.dirname(loaderPath), { recursive: true });
      await writeFile(cliPath, "", "utf8");
      await writeFile(loaderPath, "export {};\n", "utf8");
      await writeFile(
        packagePath,
        JSON.stringify(
          {
            name: "tsx",
            version: "0.0.0-test",
            type: "module",
            exports: { ".": "./dist/loader.mjs" },
          },
          null,
          2,
        ),
        "utf8",
      );

      const loaderUrl = pathToFileURL(loaderPath).href;

      expect(
        buildMcpCliSpawnArgs({
          cliPath,
          command: "completion-report-mcp",
          workflowPath: path.join(fixtureRoot, "WORKFLOW.md"),
          contextFile: path.join(fixtureRoot, ".tmp", "context.json"),
        }).slice(0, 2),
      ).toEqual(["--import", loaderUrl]);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
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

  it("prefers the assigned service publication profile and excludes a decoy parent GITHUB_TOKEN", () => {
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
            service: {
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
  it.each(["completion-report-mcp", "review-feedback-mcp"] as const)(
    "carries default GitHub App env credentials through %s and preserves path fallback",
    (command) => {
      const rawConfig = {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        github: {
          owner: "$GITHUB_OWNER",
          repo: "$GITHUB_REPO",
          publish_pull_requests: true,
          pr_handoff: { enabled: false },
        },
      } as const;
      const sourceEnv = {
        LINEAR_API_KEY: "linear-secret",
        GITHUB_OWNER: "acme",
        GITHUB_REPO: "symphony",
        GITHUB_APP_ID: "12345",
        GITHUB_APP_CLIENT_ID: "Iv1.client-id",
        GITHUB_APP_INSTALLATION_ID: "67890",
        GITHUB_APP_PRIVATE_KEY: "",
        GITHUB_APP_PRIVATE_KEY_PATH: "/secrets/github-app-private-key.pem",
      };
      const config = parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", sourceEnv);
      const resolvedKeyPath = config.github.app?.privateKeyPath;

      const env = buildMcpSubprocessEnvironment({
        config,
        command,
        parentEnv: {
          PATH: "/bin",
          ...sourceEnv,
          GITHUB_TOKEN: "decoy-parent-github-secret",
          CURSOR_API_KEY: "cursor-parent-secret",
        },
      });

      expect(env).toMatchObject({
        GITHUB_OWNER: "acme",
        GITHUB_REPO: "symphony",
        GITHUB_APP_ID: "12345",
        GITHUB_APP_CLIENT_ID: "Iv1.client-id",
        GITHUB_APP_INSTALLATION_ID: "67890",
        GITHUB_APP_PRIVATE_KEY: "",
        GITHUB_APP_PRIVATE_KEY_PATH: resolvedKeyPath,
      });
      expect(env).not.toHaveProperty("GITHUB_TOKEN");
      expect(env).not.toHaveProperty("CURSOR_API_KEY");
      expect(githubEnvKeys(env)).toEqual([
        "GITHUB_APP_CLIENT_ID",
        "GITHUB_APP_ID",
        "GITHUB_APP_INSTALLATION_ID",
        "GITHUB_APP_PRIVATE_KEY",
        "GITHUB_APP_PRIVATE_KEY_PATH",
        "GITHUB_OWNER",
        "GITHUB_REPO",
      ]);

      const childConfig = parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", env);
      expect(childConfig.github).toMatchObject({
        owner: "acme",
        repo: "symphony",
        token: null,
        publishPullRequests: true,
        app: {
          appId: "12345",
          clientId: "Iv1.client-id",
          installationId: "67890",
          privateKey: null,
          privateKeyEnvVar: null,
          privateKeyPath: resolvedKeyPath,
          tokenRefreshBufferSeconds: 300,
        },
      });
    },
  );

  it.each([
    {
      name: "top-level github.token ref",
      github: { token: "$GITHUB_TOKEN" },
      sourceEnv: { GITHUB_TOKEN: "legacy-github-secret" },
    },
    {
      name: "ambient GITHUB_TOKEN fallback",
      github: {},
      sourceEnv: { GITHUB_TOKEN: "ambient-github-secret" },
    },
  ])("carries App refs and withholds non-empty legacy tokens for $name", (scenario) => {
    for (const command of ["completion-report-mcp", "review-feedback-mcp"] as const) {
      const rawConfig = {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        github: {
          owner: "$GITHUB_OWNER",
          repo: "$GITHUB_REPO",
          publish_pull_requests: true,
          pr_handoff: { enabled: false },
          ...scenario.github,
        },
      } as const;
      const sourceEnv = {
        LINEAR_API_KEY: "linear-secret",
        GITHUB_OWNER: "acme",
        GITHUB_REPO: "symphony",
        GITHUB_APP_ID: "12345",
        GITHUB_APP_CLIENT_ID: "Iv1.client-id",
        GITHUB_APP_INSTALLATION_ID: "67890",
        GITHUB_APP_PRIVATE_KEY: "",
        GITHUB_APP_PRIVATE_KEY_PATH: "/secrets/github-app-private-key.pem",
        ...scenario.sourceEnv,
      };
      const config = parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", sourceEnv);
      expect(config.github.token).toMatch(/github-secret$/);
      expect(config.github.app).not.toBeNull();
      const resolvedKeyPath = config.github.app?.privateKeyPath;

      const env = buildMcpSubprocessEnvironment({
        config,
        command,
        parentEnv: {
          PATH: "/bin",
          ...sourceEnv,
          GITHUB_TOKEN: "decoy-parent-github-secret",
          CURSOR_API_KEY: "cursor-parent-secret",
        },
      });

      expect(env).toMatchObject({
        GITHUB_OWNER: "acme",
        GITHUB_REPO: "symphony",
        GITHUB_APP_ID: "12345",
        GITHUB_APP_CLIENT_ID: "Iv1.client-id",
        GITHUB_APP_INSTALLATION_ID: "67890",
        GITHUB_APP_PRIVATE_KEY: "",
        GITHUB_APP_PRIVATE_KEY_PATH: resolvedKeyPath,
      });
      expect(env).not.toHaveProperty("GITHUB_TOKEN");
      expect(env).not.toHaveProperty("CURSOR_API_KEY");

      const childConfig = parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", env);
      expect(childConfig.github).toMatchObject({
        owner: "acme",
        repo: "symphony",
        token: null,
        publishPullRequests: true,
        app: {
          appId: "12345",
          clientId: "Iv1.client-id",
          installationId: "67890",
          privateKey: null,
          privateKeyEnvVar: null,
          privateKeyPath: resolvedKeyPath,
          tokenRefreshBufferSeconds: 300,
        },
      });
    }
  });

  it("carries custom GitHub App refs for review feedback without propagating an empty static token ref", () => {
    const rawConfig = {
      tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
      github: {
        owner: "$GITHUB_OWNER",
        repo: "$GITHUB_REPO",
        token: "$EMPTY_GITHUB_TOKEN",
        publish_pull_requests: true,
        pr_handoff: { enabled: false },
        app: {
          app_id: "$CUSTOM_APP_ID",
          client_id: "$CUSTOM_APP_CLIENT_ID",
          installation_id: "$CUSTOM_APP_INSTALLATION_ID",
          private_key: "$CUSTOM_APP_PRIVATE_KEY",
          private_key_path: "$CUSTOM_APP_PRIVATE_KEY_PATH",
        },
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
    } as const;
    const sourceEnv = {
      LINEAR_API_KEY: "linear-secret",
      GITHUB_OWNER: "acme",
      GITHUB_REPO: "symphony",
      EMPTY_GITHUB_TOKEN: "",
      CUSTOM_APP_ID: "app-123",
      CUSTOM_APP_CLIENT_ID: "Iv1.custom-client",
      CUSTOM_APP_INSTALLATION_ID: "install-456",
      CUSTOM_APP_PRIVATE_KEY: "fake-custom-app-private-key-value",
      CUSTOM_APP_PRIVATE_KEY_PATH: "/secrets/custom-github-app-private-key.pem",
      GITHUB_PUBLICATION_TOKEN: "publication-secret",
      GITHUB_TOKEN: "decoy-github-secret",
    };
    const config = parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", sourceEnv);
    const resolvedKeyPath = config.github.app?.privateKeyPath;

    const env = buildMcpSubprocessEnvironment({
      config,
      command: "review-feedback-mcp",
      parentEnv: { PATH: "/bin", ...sourceEnv, GITHUB_TOKEN: "decoy-parent-github-secret" },
    });

    expect(env).toMatchObject({
      GITHUB_OWNER: "acme",
      GITHUB_REPO: "symphony",
      CUSTOM_APP_ID: "app-123",
      CUSTOM_APP_CLIENT_ID: "Iv1.custom-client",
      CUSTOM_APP_INSTALLATION_ID: "install-456",
      CUSTOM_APP_PRIVATE_KEY: "fake-custom-app-private-key-value",
      CUSTOM_APP_PRIVATE_KEY_PATH: resolvedKeyPath,
    });
    expect(env).not.toHaveProperty("EMPTY_GITHUB_TOKEN");
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
    expect(env).not.toHaveProperty("GITHUB_PUBLICATION_TOKEN");
    expect(githubEnvKeys(env)).toEqual(["GITHUB_OWNER", "GITHUB_REPO"]);

    const childConfig = parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", env);
    expect(childConfig.github).toMatchObject({
      owner: "acme",
      repo: "symphony",
      token: null,
      app: {
        appId: "app-123",
        clientId: "Iv1.custom-client",
        installationId: "install-456",
        privateKey: null,
        privateKeyEnvVar: "CUSTOM_APP_PRIVATE_KEY",
        privateKeyPath: resolvedKeyPath,
      },
    });
  });


  it("keeps service publication profile credentials exclusive while carrying env-backed GitHub metadata refs", () => {
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
          service: {
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
    expect(childConfig.credentialProfiles.resolveForRole("service", "github.publication")).toMatchObject({
      source: "profile",
      value: "publication-secret",
    });
    expect(childConfig.github).toMatchObject({
      owner: "acme",
      repo: "symphony",
      token: null,
    });
  });

  it("injects only the selected GitHub App profile refs for completion and review-feedback MCP", () => {
    const rawConfig = {
      tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
      github: {
        owner: "$GITHUB_OWNER",
        repo: "$GITHUB_REPO",
        head_owner: "$GITHUB_HEAD_OWNER",
        publish_pull_requests: true,
        pr_handoff: { enabled: false },
      },
      credential_profiles: {
        profiles: {
          publication: {
            kind: "github_app",
            app_id: "$GITHUB_PUBLICATION_APP_ID",
            client_id: "$GITHUB_PUBLICATION_APP_CLIENT_ID",
            installation_id: "$GITHUB_PUBLICATION_APP_INSTALLATION_ID",
            private_key_path: "$GITHUB_PUBLICATION_APP_PRIVATE_KEY_PATH",
            capabilities: ["github.publication", "github.merge"],
          },
          feedback: {
            kind: "github_app",
            app_id: "$GITHUB_REVIEW_APP_ID",
            client_id: "$GITHUB_REVIEW_APP_CLIENT_ID",
            installation_id: "$GITHUB_REVIEW_APP_INSTALLATION_ID",
            private_key_path: "$GITHUB_REVIEW_APP_PRIVATE_KEY_PATH",
            capabilities: ["github.review_feedback_write"],
          },
        },
        roles: {
          service: {
            "github.publication": "publication",
            "github.merge": "publication",
          },
          reviewer: {
            "github.review_feedback_write": "feedback",
          },
        },
      },
    } as const;
    const sourceEnv = {
      LINEAR_API_KEY: "linear-secret",
      GITHUB_OWNER: "acme",
      GITHUB_REPO: "symphony",
      GITHUB_HEAD_OWNER: "john",
      GITHUB_PUBLICATION_APP_ID: "111",
      GITHUB_PUBLICATION_APP_CLIENT_ID: "Iv1.publication",
      GITHUB_PUBLICATION_APP_INSTALLATION_ID: "222",
      GITHUB_PUBLICATION_APP_PRIVATE_KEY_PATH: "/secrets/publication.pem",
      GITHUB_REVIEW_APP_ID: "333",
      GITHUB_REVIEW_APP_CLIENT_ID: "Iv1.review",
      GITHUB_REVIEW_APP_INSTALLATION_ID: "444",
      GITHUB_REVIEW_APP_PRIVATE_KEY_PATH: "/secrets/reviewer.pem",
      GITHUB_TOKEN: "decoy-github-secret",
    };
    const config = parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", sourceEnv);
    const publicationKeyPath = config.credentialProfiles.resolveForRole("service", "github.publication")?.app?.privateKeyPath;
    const reviewerKeyPath = config.credentialProfiles.resolveForRole("reviewer", "github.review_feedback_write")?.app?.privateKeyPath;

    const completionEnv = buildMcpSubprocessEnvironment({
      config,
      command: "completion-report-mcp",
      parentEnv: { PATH: "/bin", ...sourceEnv },
    });
    expect(completionEnv).toMatchObject({
      GITHUB_OWNER: "acme",
      GITHUB_REPO: "symphony",
      GITHUB_HEAD_OWNER: "john",
      GITHUB_PUBLICATION_APP_ID: "111",
      GITHUB_PUBLICATION_APP_CLIENT_ID: "Iv1.publication",
      GITHUB_PUBLICATION_APP_INSTALLATION_ID: "222",
      GITHUB_PUBLICATION_APP_PRIVATE_KEY_PATH: publicationKeyPath,
    });
    expect(completionEnv).not.toHaveProperty("GITHUB_REVIEW_APP_ID");
    expect(completionEnv).not.toHaveProperty("GITHUB_REVIEW_APP_PRIVATE_KEY_PATH");
    expect(completionEnv).not.toHaveProperty("GITHUB_TOKEN");

    const completionChildConfig = parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", completionEnv);
    expect(completionChildConfig.credentialProfiles.resolveForRole("service", "github.publication")).toMatchObject({
      kind: "github_app",
      app: { appId: "111", clientId: "Iv1.publication", installationId: "222", privateKeyPath: publicationKeyPath },
    });

    const reviewEnv = buildMcpSubprocessEnvironment({
      config,
      command: "review-feedback-mcp",
      parentEnv: { PATH: "/bin", ...sourceEnv },
    });
    expect(reviewEnv).toMatchObject({
      GITHUB_OWNER: "acme",
      GITHUB_REPO: "symphony",
      GITHUB_HEAD_OWNER: "john",
      GITHUB_REVIEW_APP_ID: "333",
      GITHUB_REVIEW_APP_CLIENT_ID: "Iv1.review",
      GITHUB_REVIEW_APP_INSTALLATION_ID: "444",
      GITHUB_REVIEW_APP_PRIVATE_KEY_PATH: reviewerKeyPath,
    });
    expect(reviewEnv).not.toHaveProperty("GITHUB_PUBLICATION_APP_ID");
    expect(reviewEnv).not.toHaveProperty("GITHUB_PUBLICATION_APP_PRIVATE_KEY_PATH");
    expect(reviewEnv).not.toHaveProperty("GITHUB_TOKEN");

    const reviewChildConfig = parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", reviewEnv);
    expect(reviewChildConfig.credentialProfiles.resolveForRole("reviewer", "github.review_feedback_write")).toMatchObject({
      kind: "github_app",
      app: { appId: "333", clientId: "Iv1.review", installationId: "444", privateKeyPath: reviewerKeyPath },
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

  it("does not expose publication credentials to completion report MCP when publication approval is required", () => {
    const rawConfig = {
      tracker: {
        kind: "linear",
        api_key: "$LINEAR_API_KEY",
        project_slug: "TEST",
        handoff_states: ["Human Review"],
      },
      review_loop: {
        review_states: ["In Review"],
      },
      github: {
        owner: "$GITHUB_OWNER",
        repo: "$GITHUB_REPO",
        api_base_url: "$GITHUB_API_BASE_URL",
        token: "$CUSTOM_GITHUB_TOKEN",
        publish_pull_requests: true,
        pr_handoff: {
          target_state: "Human Review",
          required_checks: ["Typecheck and test"],
        },
        operator_approval: {
          required_for_publication: true,
        },
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
    } as const;
    const config = parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", {
      LINEAR_API_KEY: "linear-secret",
      GITHUB_OWNER: "acme",
      GITHUB_REPO: "symphony",
      GITHUB_API_BASE_URL: "https://api.github.test",
      CUSTOM_GITHUB_TOKEN: "custom-github-secret",
      GITHUB_PUBLICATION_TOKEN: "publication-secret",
      GITHUB_APP_ID: "12345",
      GITHUB_APP_CLIENT_ID: "Iv1.client-id",
      GITHUB_APP_INSTALLATION_ID: "67890",
      GITHUB_APP_PRIVATE_KEY: "fake-app-key-that-must-not-leak",
      GITHUB_APP_PRIVATE_KEY_PATH: "/secrets/github-app-private-key.pem",
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
      GITHUB_API_BASE_URL: "https://api.github.test",
    });
    expect(env).not.toHaveProperty("CUSTOM_GITHUB_TOKEN");
    expect(env).not.toHaveProperty("GITHUB_PUBLICATION_TOKEN");
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
    expect(githubEnvKeys(env)).toEqual(["GITHUB_API_BASE_URL", "GITHUB_OWNER", "GITHUB_REPO"]);
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
          service: {
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
          base_ref: "$WORKSPACE_BASE_REF",
          branch_template: "$WORKSPACE_BRANCH_TEMPLATE",
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
      WORKSPACE_BASE_REF: "origin/release",
      WORKSPACE_BRANCH_TEMPLATE: "symphony/{{ issue.identifier }}",
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
      WORKSPACE_BASE_REF: config.workspace.source.baseRef,
      WORKSPACE_BRANCH_TEMPLATE: config.workspace.source.branchTemplate,
      WORKSPACE_CACHE_PATH: config.workspace.source.cachePath,
    });
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
    expect(env).not.toHaveProperty("CURSOR_API_KEY");

    const childConfig = parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", env);
    expect(childConfig.tracker).toMatchObject(config.tracker);
    expect(childConfig.workspace).toEqual(config.workspace);
  });

  it("exports resolved git refs needed for child config parsing", () => {
    const rawConfig = {
      tracker: {
        kind: "linear",
        api_key: "$LINEAR_PROFILED_KEY",
        project_slug: "$LINEAR_PROJECT_SLUG",
      },
      workspace: {
        root: "$WORKSPACE_ROOT",
        source: {
          kind: "git",
          repository: "$WORKSPACE_REPOSITORY",
          ref: "$WORKSPACE_SOURCE_REF",
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
      WORKSPACE_ROOT: "/tmp/symphony-workspaces",
      WORKSPACE_REPOSITORY: "/tmp/repo",
      WORKSPACE_SOURCE_REF: "feature/docs",
    });

    const env = buildMcpSubprocessEnvironment({
      config,
      command: "review-verdict-mcp",
      parentEnv: { PATH: "/bin" },
    });

    expect(env).toMatchObject({
      WORKSPACE_REPOSITORY: config.workspace.source.repository,
      WORKSPACE_SOURCE_REF: config.workspace.source.ref,
    });

    const childConfig = parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", env);
    expect(childConfig.workspace).toEqual(config.workspace);
  });

  it("preserves inherited top-level git_worktree parse refs when the default context overrides them", () => {
    const rawConfig = {
      tracker: {
        kind: "linear",
        api_key: "$LINEAR_PROFILED_KEY",
        project_slug: "$ROOT_PROJECT",
        assignee: "$ROOT_ASSIGNEE",
      },
      workspace: {
        root: "$ROOT_WORKSPACE_ROOT",
        state_dir: "$ROOT_STATE_DIR",
        source: {
          kind: "git_worktree",
          path: "$ROOT_SOURCE_PATH",
          repository: "$ROOT_REPOSITORY",
          base_ref: "$ROOT_BASE_REF",
          branch_template: "$ROOT_BRANCH_TEMPLATE",
          cache_path: "$ROOT_CACHE_PATH",
        },
      },
      project_contexts: [
        {
          id: "symphony",
          tracker: {
            kind: "linear",
            project_slug: "$DEFAULT_PROJECT",
            assignee: "$DEFAULT_ASSIGNEE",
          },
          workspace: {
            root: "$DEFAULT_WORKSPACE_ROOT",
            state_dir: "$DEFAULT_STATE_DIR",
            source: {
              kind: "git_worktree",
              path: "$DEFAULT_SOURCE_PATH",
              repository: "$DEFAULT_REPOSITORY",
              base_ref: "$DEFAULT_BASE_REF",
              branch_template: "$DEFAULT_BRANCH_TEMPLATE",
              cache_path: "$DEFAULT_CACHE_PATH",
            },
          },
        },
        {
          id: "docs",
        },
      ],
      github: {
        owner: "acme",
        repo: "symphony",
        publish_pull_requests: false,
      },
    } as const;
    const sourceEnv = {
      LINEAR_PROFILED_KEY: "linear-secret",
      ROOT_PROJECT: "ROOT",
      ROOT_ASSIGNEE: "root-user",
      ROOT_WORKSPACE_ROOT: "/tmp/root/workspaces",
      ROOT_STATE_DIR: "/tmp/root/state",
      ROOT_SOURCE_PATH: "/tmp/root/source",
      ROOT_REPOSITORY: "/tmp/root/repo",
      ROOT_BASE_REF: "origin/main",
      ROOT_BRANCH_TEMPLATE: "root/{{ issue.identifier }}",
      ROOT_CACHE_PATH: "/tmp/root/cache",
      DEFAULT_PROJECT: "SYM",
      DEFAULT_ASSIGNEE: "sym-user",
      DEFAULT_WORKSPACE_ROOT: "/tmp/sym/workspaces",
      DEFAULT_STATE_DIR: "/tmp/sym/state",
      DEFAULT_SOURCE_PATH: "/tmp/sym/source",
      DEFAULT_REPOSITORY: "/tmp/sym/repo",
      DEFAULT_BASE_REF: "origin/symphony-main",
      DEFAULT_BRANCH_TEMPLATE: "sym/{{ issue.identifier }}",
      DEFAULT_CACHE_PATH: "/tmp/sym/cache",
    };
    const config = parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", sourceEnv);

    expect(config.topLevelDefaults).toBeDefined();
    expect(config.workspace.source.baseRef).toBe("origin/symphony-main");
    expect(config.projectContexts.byId.get("docs")?.workspace.source.baseRef).toBe("origin/main");

    const env = buildMcpSubprocessEnvironment({
      config,
      command: "issue-breakdown-plan-mcp",
      parentEnv: { PATH: "/bin" },
    });

    expect(env).toMatchObject({
      ROOT_PROJECT: config.topLevelDefaults?.tracker.projectSlug,
      ROOT_ASSIGNEE: config.topLevelDefaults?.tracker.assignee,
      ROOT_WORKSPACE_ROOT: config.topLevelDefaults?.workspace.root,
      ROOT_STATE_DIR: config.topLevelDefaults?.workspace.stateDir,
      ROOT_SOURCE_PATH: config.topLevelDefaults?.workspace.source.path,
      ROOT_REPOSITORY: config.topLevelDefaults?.workspace.source.repository,
      ROOT_BASE_REF: config.topLevelDefaults?.workspace.source.baseRef,
      ROOT_BRANCH_TEMPLATE: config.topLevelDefaults?.workspace.source.branchTemplate,
      ROOT_CACHE_PATH: config.topLevelDefaults?.workspace.source.cachePath,
      DEFAULT_PROJECT: config.projectContexts.byId.get("symphony")?.tracker.projectSlug,
      DEFAULT_ASSIGNEE: config.projectContexts.byId.get("symphony")?.tracker.assignee,
      DEFAULT_WORKSPACE_ROOT: config.projectContexts.byId.get("symphony")?.workspace.root,
      DEFAULT_STATE_DIR: config.projectContexts.byId.get("symphony")?.workspace.stateDir,
      DEFAULT_SOURCE_PATH: config.projectContexts.byId.get("symphony")?.workspace.source.path,
      DEFAULT_REPOSITORY: config.projectContexts.byId.get("symphony")?.workspace.source.repository,
      DEFAULT_BASE_REF: config.projectContexts.byId.get("symphony")?.workspace.source.baseRef,
      DEFAULT_BRANCH_TEMPLATE: config.projectContexts.byId.get("symphony")?.workspace.source.branchTemplate,
      DEFAULT_CACHE_PATH: config.projectContexts.byId.get("symphony")?.workspace.source.cachePath,
    });
    expect(env.ROOT_BASE_REF).toBe("origin/main");
    expect(env.ROOT_BASE_REF).not.toBe(config.workspace.source.baseRef);
    expect(env.ROOT_BRANCH_TEMPLATE).toBe("root/{{ issue.identifier }}");
    expect(env.ROOT_BRANCH_TEMPLATE).not.toBe(config.workspace.source.branchTemplate);
    expect(env.ROOT_SOURCE_PATH).toBe(config.topLevelDefaults?.workspace.source.path);
    expect(env.ROOT_SOURCE_PATH).not.toBe(config.workspace.source.path);

    const childConfig = parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", env);
    expect(childConfig.workspace).toEqual(config.workspace);
    expect(childConfig.projectContexts.byId.get("symphony")).toEqual(config.projectContexts.byId.get("symphony"));
    expect(childConfig.projectContexts.byId.get("docs")).toEqual(config.projectContexts.byId.get("docs"));
  });

  it("preserves inherited top-level git refs when the default context overrides them", () => {
    const rawConfig = {
      tracker: {
        kind: "linear",
        api_key: "$LINEAR_PROFILED_KEY",
        project_slug: "$ROOT_PROJECT",
      },
      workspace: {
        root: "$ROOT_WORKSPACE_ROOT",
        source: {
          kind: "git",
          repository: "$ROOT_REPOSITORY",
          ref: "$ROOT_REF",
        },
      },
      project_contexts: [
        {
          id: "symphony",
          workspace: {
            source: {
              kind: "git",
              repository: "$DEFAULT_REPOSITORY",
              ref: "$DEFAULT_REF",
            },
          },
        },
        {
          id: "docs",
        },
      ],
      github: {
        owner: "acme",
        repo: "symphony",
        publish_pull_requests: false,
      },
    } as const;
    const sourceEnv = {
      LINEAR_PROFILED_KEY: "linear-secret",
      ROOT_PROJECT: "ROOT",
      ROOT_WORKSPACE_ROOT: "/tmp/root/workspaces",
      ROOT_REPOSITORY: "/tmp/root/repo",
      ROOT_REF: "refs/heads/root-main",
      DEFAULT_REPOSITORY: "/tmp/sym/repo",
      DEFAULT_REF: "refs/heads/symphony-main",
    };
    const config = parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", sourceEnv);

    expect(config.topLevelDefaults).toBeDefined();
    expect(config.workspace.source.ref).toBe("refs/heads/symphony-main");
    expect(config.projectContexts.byId.get("docs")?.workspace.source.ref).toBe("refs/heads/root-main");

    const env = buildMcpSubprocessEnvironment({
      config,
      command: "review-verdict-mcp",
      parentEnv: { PATH: "/bin" },
    });

    expect(env).toMatchObject({
      ROOT_PROJECT: config.topLevelDefaults?.tracker.projectSlug,
      ROOT_WORKSPACE_ROOT: config.topLevelDefaults?.workspace.root,
      ROOT_REPOSITORY: config.topLevelDefaults?.workspace.source.repository,
      ROOT_REF: config.topLevelDefaults?.workspace.source.ref,
      DEFAULT_REPOSITORY: config.projectContexts.byId.get("symphony")?.workspace.source.repository,
      DEFAULT_REF: config.projectContexts.byId.get("symphony")?.workspace.source.ref,
    });
    expect(env.ROOT_REF).toBe("refs/heads/root-main");
    expect(env.ROOT_REF).not.toBe(config.workspace.source.ref);

    const childConfig = parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", env);
    expect(childConfig.workspace).toEqual(config.workspace);
    expect(childConfig.projectContexts.byId.get("symphony")).toEqual(config.projectContexts.byId.get("symphony"));
    expect(childConfig.projectContexts.byId.get("docs")).toEqual(config.projectContexts.byId.get("docs"));
  });

  it("carries project-context parse dependencies needed for child config parsing", () => {
    const rawConfig = {
      tracker: {
        kind: "linear",
        api_key: "$LINEAR_PROFILED_KEY",
        project_slug: "$LINEAR_PROJECT_SLUG",
      },
      workspace: {
        root: "$WORKSPACE_ROOT",
        source: {
          kind: "git_worktree",
          repository: "$WORKSPACE_REPOSITORY",
          base_ref: "main",
        },
      },
      project_contexts: [
        {
          id: "docs",
          tracker: {
            kind: "linear",
            api_key: "$DOCS_LINEAR_KEY",
            project_slug: "$DOCS_LINEAR_PROJECT",
            assignee: "$DOCS_LINEAR_ASSIGNEE",
          },
          workspace: {
            root: "$DOCS_WORKSPACE_ROOT",
            state_dir: "$DOCS_WORKSPACE_STATE_DIR",
            source: {
              kind: "git_worktree",
              path: "$DOCS_WORKSPACE_SOURCE_PATH",
              repository: "$DOCS_WORKSPACE_REPOSITORY",
              base_ref: "$DOCS_WORKSPACE_BASE_REF",
              branch_template: "$DOCS_WORKSPACE_BRANCH_TEMPLATE",
              cache_path: "$DOCS_WORKSPACE_CACHE_PATH",
            },
          },
          github: {
            owner: "$DOCS_GITHUB_OWNER",
            repo: "$DOCS_GITHUB_REPO",
            head_owner: "$DOCS_GITHUB_HEAD_OWNER",
            api_base_url: "$DOCS_GITHUB_API_BASE_URL",
          },
        },
      ],
      github: {
        owner: "acme",
        repo: "symphony",
        publish_pull_requests: false,
      },
    } as const;
    const sourceEnv = {
      LINEAR_PROFILED_KEY: "linear-secret",
      LINEAR_PROJECT_SLUG: "TEST",
      WORKSPACE_ROOT: "/tmp/symphony-workspaces",
      WORKSPACE_REPOSITORY: "/tmp/repo",
      DOCS_LINEAR_KEY: "docs-linear-secret",
      DOCS_LINEAR_PROJECT: "DOCS",
      DOCS_LINEAR_ASSIGNEE: "writer",
      DOCS_WORKSPACE_ROOT: "/tmp/docs-workspaces",
      DOCS_WORKSPACE_STATE_DIR: "/tmp/docs-state",
      DOCS_WORKSPACE_SOURCE_PATH: "/tmp/docs/source",
      DOCS_WORKSPACE_REPOSITORY: "/tmp/docs/repo",
      DOCS_WORKSPACE_BASE_REF: "origin/docs-main",
      DOCS_WORKSPACE_BRANCH_TEMPLATE: "docs/{{ issue.identifier }}",
      DOCS_WORKSPACE_CACHE_PATH: "/tmp/docs/cache",
      DOCS_GITHUB_OWNER: "acme-docs",
      DOCS_GITHUB_REPO: "docs-site",
      DOCS_GITHUB_HEAD_OWNER: "john",
      DOCS_GITHUB_API_BASE_URL: "https://api.github.docs.test",
    };
    const config = parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", sourceEnv);

    const env = buildMcpSubprocessEnvironment({
      config,
      command: "issue-breakdown-plan-mcp",
      parentEnv: { PATH: "/bin" },
    });

    expect(env).toMatchObject({
      DOCS_LINEAR_KEY: "docs-linear-secret",
      DOCS_LINEAR_PROJECT: "DOCS",
      DOCS_LINEAR_ASSIGNEE: "writer",
      DOCS_WORKSPACE_ROOT: config.projectContexts.byId.get("docs")?.workspace.root,
      DOCS_WORKSPACE_STATE_DIR: config.projectContexts.byId.get("docs")?.workspace.stateDir,
      DOCS_WORKSPACE_SOURCE_PATH: config.projectContexts.byId.get("docs")?.workspace.source.path,
      DOCS_WORKSPACE_REPOSITORY: config.projectContexts.byId.get("docs")?.workspace.source.repository,
      DOCS_WORKSPACE_BASE_REF: config.projectContexts.byId.get("docs")?.workspace.source.baseRef,
      DOCS_WORKSPACE_BRANCH_TEMPLATE: config.projectContexts.byId.get("docs")?.workspace.source.branchTemplate,
      DOCS_WORKSPACE_CACHE_PATH: config.projectContexts.byId.get("docs")?.workspace.source.cachePath,
      DOCS_GITHUB_OWNER: "acme-docs",
      DOCS_GITHUB_REPO: "docs-site",
      DOCS_GITHUB_HEAD_OWNER: "john",
      DOCS_GITHUB_API_BASE_URL: "https://api.github.docs.test",
    });

    const childConfig = parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", env);
    const expectedDocsContext = config.projectContexts.byId.get("docs");
    expect(expectedDocsContext).toBeDefined();
    expect(childConfig.projectContexts.byId.get("docs")).toMatchObject(expectedDocsContext!);
  });

  it("keeps non-GitHub MCPs free of default GitHub parse refs while preserving explicit project-context refs", () => {
    const rawConfig = {
      tracker: {
        kind: "linear",
        api_key: "$LINEAR_PROFILED_KEY",
        project_slug: "$LINEAR_PROJECT_SLUG",
      },
      workspace: {
        root: "$WORKSPACE_ROOT",
        source: {
          kind: "git_worktree",
          repository: "$WORKSPACE_REPOSITORY",
          base_ref: "main",
        },
      },
      github: {
        owner: "$GITHUB_OWNER",
        repo: "$GITHUB_REPO",
        head_owner: "$GITHUB_HEAD_OWNER",
        api_base_url: "$GITHUB_API_BASE_URL",
        publish_pull_requests: false,
      },
      project_contexts: [
        {
          id: "docs",
          tracker: {
            kind: "linear",
            api_key: "$DOCS_LINEAR_KEY",
            project_slug: "$DOCS_LINEAR_PROJECT",
          },
          workspace: {
            root: "$DOCS_WORKSPACE_ROOT",
            state_dir: "$DOCS_WORKSPACE_STATE_DIR",
            source: {
              kind: "git_worktree",
              path: "$DOCS_WORKSPACE_SOURCE_PATH",
              repository: "$DOCS_WORKSPACE_REPOSITORY",
              base_ref: "main",
              cache_path: "$DOCS_WORKSPACE_CACHE_PATH",
            },
          },
          github: {
            owner: "$DOCS_GITHUB_OWNER",
            repo: "$DOCS_GITHUB_REPO",
            head_owner: "$DOCS_GITHUB_HEAD_OWNER",
            api_base_url: "$DOCS_GITHUB_API_BASE_URL",
          },
        },
      ],
    } as const;
    const sourceEnv = {
      LINEAR_PROFILED_KEY: "linear-secret",
      LINEAR_PROJECT_SLUG: "TEST",
      WORKSPACE_ROOT: "/tmp/symphony-workspaces",
      WORKSPACE_REPOSITORY: "/tmp/repo",
      GITHUB_OWNER: "acme",
      GITHUB_REPO: "symphony",
      GITHUB_HEAD_OWNER: "john",
      GITHUB_API_BASE_URL: "https://api.github.test",
      DOCS_LINEAR_KEY: "docs-linear-secret",
      DOCS_LINEAR_PROJECT: "DOCS",
      DOCS_WORKSPACE_ROOT: "/tmp/docs-workspaces",
      DOCS_WORKSPACE_STATE_DIR: "/tmp/docs-state",
      DOCS_WORKSPACE_SOURCE_PATH: "/tmp/docs/source",
      DOCS_WORKSPACE_REPOSITORY: "/tmp/docs/repo",
      DOCS_WORKSPACE_CACHE_PATH: "/tmp/docs/cache",
      DOCS_GITHUB_OWNER: "acme-docs",
      DOCS_GITHUB_REPO: "docs-site",
      DOCS_GITHUB_HEAD_OWNER: "john",
      DOCS_GITHUB_API_BASE_URL: "https://api.github.docs.test",
    };
    const config = parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", sourceEnv);

    const env = buildMcpSubprocessEnvironment({
      config,
      command: "issue-breakdown-plan-mcp",
      parentEnv: { PATH: "/bin", ...sourceEnv, GITHUB_TOKEN: "decoy-parent-github-secret" },
    });

    expect(env).toMatchObject({
      DOCS_GITHUB_OWNER: "acme-docs",
      DOCS_GITHUB_REPO: "docs-site",
      DOCS_GITHUB_HEAD_OWNER: "john",
      DOCS_GITHUB_API_BASE_URL: "https://api.github.docs.test",
    });
    expect(env).not.toHaveProperty("GITHUB_OWNER");
    expect(env).not.toHaveProperty("GITHUB_REPO");
    expect(env).not.toHaveProperty("GITHUB_HEAD_OWNER");
    expect(env).not.toHaveProperty("GITHUB_API_BASE_URL");
    expect(env).not.toHaveProperty("GITHUB_TOKEN");

    const childConfig = parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", env);
    const expectedDocsContext = config.projectContexts.byId.get("docs");
    expect(expectedDocsContext).toBeDefined();
    expect(childConfig.projectContexts.byId.get("docs")).toMatchObject(expectedDocsContext!);
  });

  it.each([
    {
      command: "completion-report-mcp",
      role: "service",
      capability: "github.publication",
      envVar: "GITHUB_PUBLICATION_TOKEN",
      excludedEnvVar: "GITHUB_FEEDBACK_TOKEN",
      expectedSecret: "publication-secret",
      profileName: "publication",
    },
    {
      command: "review-feedback-mcp",
      role: "reviewer",
      capability: "github.review_feedback_write",
      envVar: "GITHUB_FEEDBACK_TOKEN",
      excludedEnvVar: "GITHUB_PUBLICATION_TOKEN",
      expectedSecret: "feedback-secret",
      profileName: "feedback",
    },
  ] as const)(
    "exports default project-context credential profiles through %s and preserves child reparse attribution",
    ({ command, role, capability, envVar, excludedEnvVar, expectedSecret, profileName }) => {
      const rawConfig = multiProjectWorkflowConfig({
        projectContexts: [
          projectContextFixture({
            id: "symphony",
            label: "Symphony",
            projectSlug: "SYMPHONY",
            repository: ".",
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
                service: { "github.publication": "publication" },
                reviewer: { "github.review_feedback_write": "feedback" },
              },
            },
          }),
          projectContextFixture({ id: "docs", label: "Documentation Site", projectSlug: "DOCS", repository: "../docs-site" }),
        ],
      });
      const sourceEnv = {
        LINEAR_API_KEY: "linear-secret",
        GITHUB_PUBLICATION_TOKEN: "publication-secret",
        GITHUB_FEEDBACK_TOKEN: "feedback-secret",
      };
      const config = parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", sourceEnv);

      const env = buildMcpSubprocessEnvironment({
        config,
        command,
        parentEnv: { PATH: "/bin", GITHUB_TOKEN: "decoy-parent-github-secret" },
      });

      expect(env[envVar]).toBe(expectedSecret);
      expect(env).not.toHaveProperty(excludedEnvVar);
      expect(env).not.toHaveProperty("GITHUB_TOKEN");

      const childConfig = parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", env);
      expect(childConfig.credentialProfiles.assignmentRolesFor(capability)).toEqual([role]);
      expect(childConfig.credentialProfiles.resolveForRole(role, capability)).toMatchObject({
        source: "profile",
        profileName,
        value: expectedSecret,
      });
    },
  );

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
            service: {
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

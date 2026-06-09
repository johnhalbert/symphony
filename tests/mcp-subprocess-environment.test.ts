import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { parseServiceConfig, serviceConfigForProjectContext } from "../src/core/config/Config.js";
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

  it("carries project-context workspace parse dependencies needed for child config parsing", () => {
    const rawConfig = {
      tracker: {
        kind: "linear",
        api_key: "$LINEAR_API_KEY",
        project_slug: "DEFAULT",
      },
      workspace: {
        root: "/tmp/default-workspaces",
        state_dir: "/tmp/default-state",
        source: {
          kind: "git_worktree",
          repository: "../default-site",
          base_ref: "origin/main",
        },
      },
      github: {
        owner: "acme",
        repo: "default-site",
        publish_pull_requests: false,
      },
      project_contexts: [
        {
          id: "default",
          enabled: false,
          tracker: { project_slug: "LEGACY" },
          workspace: {
            source: {
              kind: "git_worktree",
              repository: "../legacy-site",
              base_ref: "origin/main",
            },
          },
        },
        {
          id: "docs",
          tracker: { project_slug: "DOCS" },
          workspace: {
            root: "$DOCS_WORKSPACE_ROOT",
            state_dir: "$DOCS_WORKSPACE_STATE_DIR",
            source: {
              kind: "git_worktree",
              repository: "$DOCS_WORKSPACE_REPOSITORY",
              base_ref: "$DOCS_WORKSPACE_BASE_REF",
              cache_path: "$DOCS_WORKSPACE_CACHE_PATH",
            },
          },
        },
      ],
    } as const;
    const config = parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", {
      LINEAR_API_KEY: "linear-secret",
      DOCS_WORKSPACE_ROOT: "/tmp/docs-workspaces",
      DOCS_WORKSPACE_STATE_DIR: "/tmp/docs-state",
      DOCS_WORKSPACE_REPOSITORY: "/tmp/docs-repo",
      DOCS_WORKSPACE_BASE_REF: "origin/docs-main",
      DOCS_WORKSPACE_CACHE_PATH: "/tmp/docs-cache",
    });
    const issueConfig = serviceConfigForProjectContext(config, "default");

    expect(config.projectContexts.defaultContextId).toBe("docs");

    const env = buildMcpSubprocessEnvironment({
      config,
      command: "review-verdict-mcp",
      projectContextId: "default",
      parentEnv: { PATH: "/bin" },
    });

    expect(env).toMatchObject({
      DOCS_WORKSPACE_ROOT: issueConfig.workspace.root,
      DOCS_WORKSPACE_STATE_DIR: issueConfig.workspace.stateDir,
      DOCS_WORKSPACE_REPOSITORY: issueConfig.workspace.source.repository,
      DOCS_WORKSPACE_BASE_REF: issueConfig.workspace.source.baseRef,
      DOCS_WORKSPACE_CACHE_PATH: issueConfig.workspace.source.cachePath,
    });

    const childConfig = parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", env);
    expect(serviceConfigForProjectContext(childConfig, "default").workspace).toEqual(issueConfig.workspace);
  });

  it("uses project-context publication profile assignments for completion-report MCP children", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "DEFAULT" },
        workspace: {
          source: {
            kind: "git_worktree",
            repository: "../default-site",
            base_ref: "origin/main",
          },
        },
        github: { owner: "acme", repo: "default-site", token: "$DEFAULT_GITHUB_TOKEN", publish_pull_requests: false },
        credential_profiles: {
          profiles: {
            "docs-publication": {
              value: "$DOCS_PUBLICATION_TOKEN",
              capabilities: ["github.publication"],
            },
          },
        },
        project_contexts: [
          {
            id: "default",
            enabled: false,
            tracker: { project_slug: "LEGACY" },
            workspace: {
              source: {
                kind: "git_worktree",
                repository: "../legacy-site",
                base_ref: "origin/main",
              },
            },
          },
          {
            id: "docs",
            tracker: { project_slug: "DOCS" },
            workspace: {
              source: {
                kind: "git_worktree",
                repository: "../docs-site",
                base_ref: "origin/main",
              },
            },
            github: {
              owner: "acme-docs",
              repo: "docs-site",
              token: "$DOCS_GITHUB_TOKEN",
              publish_pull_requests: true,
              pr_handoff: { enabled: false },
            },
            credential_profiles: {
              roles: {
                service: {
                  "github.publication": "docs-publication",
                },
              },
            },
          },
        ],
      },
      "/repo/WORKFLOW.md",
      {
        LINEAR_API_KEY: "linear-secret",
        DEFAULT_GITHUB_TOKEN: "default-github-secret",
        DOCS_GITHUB_TOKEN: "docs-github-secret",
        DOCS_PUBLICATION_TOKEN: "docs-publication-secret",
      },
    );

    const env = buildMcpSubprocessEnvironment({
      config,
      command: "completion-report-mcp",
      projectContextId: "default",
      parentEnv: { PATH: "/bin", GITHUB_TOKEN: "decoy-parent-github-secret" },
    });

    expect(config.projectContexts.defaultContextId).toBe("docs");
    expect(env).toMatchObject({
      DOCS_PUBLICATION_TOKEN: "docs-publication-secret",
    });
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
    expect(env).not.toHaveProperty("DOCS_GITHUB_TOKEN");
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

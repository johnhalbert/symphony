import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import chokidar, { type FSWatcher } from "chokidar";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { parseDatabaseConfig, parseServiceConfig } from "../src/core/config/Config.js";
import {
  LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
  LEGACY_DEFAULT_PROJECT_CONTEXT_LABEL,
  LEGACY_DEFAULT_PROJECT_CONTEXT_ROUTING_SOURCE,
} from "../src/core/config/ProjectContexts.js";
import { SymphonyError } from "../src/core/errors.js";
import { PromptRenderer } from "../src/core/workflow/PromptRenderer.js";
import { WorkflowLoader, parseWorkflowFile, type WorkflowReloadEvent } from "../src/core/workflow/WorkflowLoader.js";
import { issue, multiProjectWorkflowConfig, multiProjectWorkflowDocument, projectContextFixture } from "./helpers.js";

const WORKFLOW_RELOAD_SECRET_VALUES = [
  "root-gh-secret",
  "docs-gh-secret",
  "docs-linear-secret",
  "repo-secret",
  "x-access-token",
  "https://x-access-token:repo-secret@example.com/org/docs.git",
] as const;

function workflowReloadTopLevelConfig() {
  return {
    github: { token: "$ROOT_GITHUB_TOKEN" },
    workspace: {
      source: { kind: "none" as const },
    },
  };
}

function workflowReloadDocument(options: {
  promptTemplate: string;
  docsContextWorkspaceSource?: boolean;
}): string {
  const docsContextWorkspaceSource = options.docsContextWorkspaceSource ?? true;
  return multiProjectWorkflowDocument({
    promptTemplate: options.promptTemplate,
    topLevel: workflowReloadTopLevelConfig(),
    projectContexts: [
      projectContextFixture({
        id: "symphony",
        label: "Symphony",
        projectSlug: "SYMPHONY",
        repository: ".",
      }),
      projectContextFixture({
        id: "Docs Site",
        label: "Documentation Site",
        projectSlug: "DOCS",
        repository: "$DOCS_REPOSITORY",
        tracker: { api_key: "$DOCS_LINEAR_API_KEY" },
        github: { token: "$DOCS_GITHUB_TOKEN" },
        ...(docsContextWorkspaceSource
          ? {}
          : {
              workspace: {
                root: "./docs-workspaces",
                source: null,
              },
            }),
      }),
    ],
  });
}

function workflowReloadEnvFile(): string {
  return [
    "LINEAR_API_KEY=linear-secret",
    "ROOT_GITHUB_TOKEN=root-gh-secret",
    "DOCS_LINEAR_API_KEY=docs-linear-secret",
    "DOCS_GITHUB_TOKEN=docs-gh-secret",
    "DOCS_REPOSITORY=https://x-access-token:repo-secret@example.com/org/docs.git",
    "",
  ].join("\n");
}

function expectWorkflowReloadErrorToRedactSecrets(serializedError: string): void {
  for (const secret of WORKFLOW_RELOAD_SECRET_VALUES) {
    expect(serializedError).not.toContain(secret);
  }
}

function mockWorkflowWatcher(): { triggerChange: () => void; restore: () => void } {
  let changeHandler: (() => void) | null = null;
  const fakeWatcher = {
    on(event: string, handler: () => void) {
      if (event === "change") changeHandler = handler;
      return fakeWatcher;
    },
    close: vi.fn(async () => undefined),
  } as unknown as FSWatcher;
  const watchSpy = vi.spyOn(chokidar, "watch").mockReturnValue(fakeWatcher);
  return {
    triggerChange: () => {
      if (!changeHandler) throw new Error("Expected workflow change handler");
      changeHandler();
    },
    restore: () => {
      watchSpy.mockRestore();
    },
  };
}

async function waitForWorkflowReloadEvent(events: WorkflowReloadEvent[]): Promise<WorkflowReloadEvent> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const event = events[0];
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for workflow reload event");
}

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

  it("parses two named project contexts with distinct codebases and Linear projects from workflow front matter", () => {
    const workflow = parseWorkflowFile(
      multiProjectWorkflowDocument({
        projectContexts: [
          projectContextFixture({ id: "api", label: "API", projectSlug: "API", repository: "../api-repo" }),
          projectContextFixture({
            id: "docs",
            label: "Documentation Site",
            projectSlug: "DOCS",
            repository: "../docs-site",
          }),
        ],
        promptTemplate: "Route {{ issue.identifier }}.",
      }),
      "/repo/WORKFLOW.md",
    );
    const rawConfig = workflow.config as ReturnType<typeof multiProjectWorkflowConfig>;
    const config = parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", { LINEAR_API_KEY: "secret" });

    expect(workflow.promptTemplate).toBe("Route {{ issue.identifier }}.");
    expect(rawConfig.tracker?.api_key).toBe("$LINEAR_API_KEY");
    expect(rawConfig.project_contexts.map((context) => context.id)).toEqual(["api", "docs"]);
    expect(rawConfig.project_contexts.map((context) => context.tracker?.project_slug)).toEqual(["API", "DOCS"]);
    expect(rawConfig.project_contexts.map((context) => context.workspace?.source?.repository)).toEqual([
      "../api-repo",
      "../docs-site",
    ]);
    expect(config.projectContexts.defaultContextId).toBe("api");
    expect(config.projectContexts.contexts.map((context) => context.id)).toEqual(["api", "docs"]);
    expect(config.projectContexts.byId.get("api")).toMatchObject({
      id: "api",
      tracker: { projectSlug: "API" },
      workspace: { source: { repository: path.resolve("/repo", "../api-repo") } },
    });
    expect(config.projectContexts.byId.get("docs")).toMatchObject({
      id: "docs",
      tracker: { projectSlug: "DOCS" },
      workspace: { source: { repository: path.resolve("/repo", "../docs-site") } },
    });
  });

  it("rejects empty project_contexts arrays at the raw config schema boundary", () => {
    expect.assertions(2);

    try {
      parseServiceConfig(
        {
          tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
          project_contexts: [],
        },
        "/repo/WORKFLOW.md",
        { LINEAR_API_KEY: "secret" },
      );
    } catch (error) {
      expect(error).toBeInstanceOf(SymphonyError);
      expect((error as SymphonyError).details).toEqual({
        formErrors: [],
        fieldErrors: {
          project_contexts: ["Too small: expected array to have >=1 items"],
        },
      });
    }
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
    expect(config.agent.maxSdkErrorRetries).toBe(2);
    expect(config.cursor.model).toBe("gpt-5.5");
    expect(config.cursor.mode).toBeNull();
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
      app: null,
      headOwner: null,
      apiBaseUrl: "https://api.github.com",
      publishPullRequests: false,
      operatorApproval: {
        requiredForPublication: false,
        rejectPolicy: "cancel",
        pollIntervalMs: 2000,
        timeoutMs: null,
      },
      prHandoff: {
        enabled: false,
        targetState: null,
        allowDrafts: false,
        requiredChecks: [],
        noCiAllowed: false,
        noCiEvidence: null,
      },
    });
    expect(config.continuationContext).toEqual({
      searchEnabled: false,
      summarizationEnabled: false,
    });
    expect(config.database).toEqual({
      postgres: {
        connectionString: null,
        migrationsDir: path.resolve("/repo/migrations/postgres"),
        migrationsTable: "symphony_schema_migrations",
        ssl: false,
      },
    });
    expect(config.server).toEqual({
      port: null,
      host: "127.0.0.1",
      openWorkspaceToken: null,
      webAssetsRoot: null,
    });
    expect(config.issueBreakdown).toEqual({
      enabled: false,
      cursorMode: "plan",
      promptTemplate: expect.stringContaining("Break down {{ issue.identifier }}"),
      planningLabels: [],
      applyToLinear: {
        enabled: false,
        mode: "child_issues",
      },
      workspaceMode: "none",
      maxPlanningFailures: 3,
      maxPlanningDispatchRetries: 3,
      planningRetryBaseMs: 5_000,
      planningRetryMaxMs: 60_000,
    });
    expect(config.reviewLoop.reviewerPromptExtensions).toEqual([]);
    expect(config.reviewLoop.workerPromptExtensions).toEqual([]);
    expect(config.mergePolicy).toEqual({
      mode: "disabled",
      sourceStates: [],
      conflictsState: null,
      maxConflictFixTurns: 3,
      doneState: "Done",
      mergeMethod: "merge",
      requiredChecks: [],
      missingCheckStabilizationMs: 60_000,
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

  it("parses database-only config for migration commands without requiring tracker credentials", () => {
    const database = parseDatabaseConfig(
      {
        database: { postgres: { migrations_dir: "db/migrations" } },
      },
      "/repo/WORKFLOW.md",
      {},
    );

    expect(database).toEqual({
      postgres: {
        connectionString: null,
        migrationsDir: path.resolve("/repo/db/migrations"),
        migrationsTable: "symphony_schema_migrations",
        ssl: false,
      },
    });
  });

  it("parses optional Postgres database config without requiring a connection string", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        database: {
          postgres: {
            url: "$TEST_POSTGRES_URL",
            migrations_dir: "db/migrations",
            migrations_table: "symphony_migrations_test",
            ssl: true,
          },
        },
      },
      "/repo/WORKFLOW.md",
      { LINEAR_API_KEY: "secret", TEST_POSTGRES_URL: "postgres-url-from-env" },
    );

    expect(config.database.postgres).toEqual({
      connectionString: "postgres-url-from-env",
      migrationsDir: path.resolve("/repo/db/migrations"),
      migrationsTable: "symphony_migrations_test",
      ssl: true,
    });

    const absent = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
      },
      "/repo/WORKFLOW.md",
      { LINEAR_API_KEY: "secret" },
    );
    expect(absent.database.postgres.connectionString).toBeNull();
  });

  it("rejects unsafe Postgres migration metadata table names", () => {
    expect(() =>
      parseServiceConfig(
        {
          tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
          database: { postgres: { migrations_table: "symphony.schema_migrations" } },
        },
        "/repo/WORKFLOW.md",
        { LINEAR_API_KEY: "secret" },
      ),
    ).toThrow("database.postgres.migrations_table must be a single PostgreSQL identifier");
  });

  it("loads workflow-local .env values for runtime config resolution", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-workflow-env-"));
    try {
      const workflowPath = path.join(root, "WORKFLOW.md");
      await writeFile(
        path.join(root, ".env"),
        [
          "WORKFLOW_TEST_LINEAR_API_KEY=linear-secret",
          "WORKFLOW_TEST_LINEAR_PROJECT=TEST",
          "WORKFLOW_TEST_GITHUB=github-secret",
          "WORKFLOW_TEST_WORKSPACE=workspace-secret",
          "WORKFLOW_TEST_WEB_ASSETS=dist-web",
          "",
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        workflowPath,
        `---
tracker:
  kind: linear
  api_key: $WORKFLOW_TEST_LINEAR_API_KEY
  project_slug: $WORKFLOW_TEST_LINEAR_PROJECT
github:
  token: $WORKFLOW_TEST_GITHUB
server:
  open_workspace_token: $WORKFLOW_TEST_WORKSPACE
  web_assets_root: $WORKFLOW_TEST_WEB_ASSETS
---
Work on {{ issue.identifier }}.
`,
        "utf8",
      );

      const loaded = await new WorkflowLoader(workflowPath).load();

      expect(loaded.serviceConfig.tracker.apiKey).toBe("linear-secret");
      expect(loaded.serviceConfig.tracker.projectSlug).toBe("TEST");
      expect(loaded.serviceConfig.github.token).toBe("github-secret");
      expect(loaded.serviceConfig.server.openWorkspaceToken).toBe("workspace-secret");
      expect(loaded.serviceConfig.server.webAssetsRoot?.replace(/\\/g, "/")).toMatch(/\/dist-web$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("emits successful reload events and refreshes the last good workflow state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-workflow-reload-success-"));
    const workflowPath = path.join(root, "WORKFLOW.md");
    const loader = new WorkflowLoader(workflowPath);
    const events: WorkflowReloadEvent[] = [];
    const watcher = mockWorkflowWatcher();
    try {
      await writeFile(path.join(root, ".env"), workflowReloadEnvFile(), "utf8");
      await writeFile(workflowPath, workflowReloadDocument({ promptTemplate: "Initial prompt." }), "utf8");

      const initiallyLoaded = await loader.load();
      loader.watch((event) => {
        events.push(event);
      });

      await writeFile(workflowPath, workflowReloadDocument({ promptTemplate: "Updated prompt." }), "utf8");
      watcher.triggerChange();
      const event = await waitForWorkflowReloadEvent(events);

      expect(initiallyLoaded.definition.promptTemplate).toBe("Initial prompt.");
      expect(event.error).toBeNull();
      expect(event.loaded?.definition.promptTemplate).toBe("Updated prompt.");
      expect(loader.getLastGood()?.definition.promptTemplate).toBe("Updated prompt.");
    } finally {
      watcher.restore();
      await loader.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports project-context reload validation failures for missing workspace sources with redacted metadata only", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-workflow-reload-error-"));
    const workflowPath = path.join(root, "WORKFLOW.md");
    const loader = new WorkflowLoader(workflowPath);
    const events: WorkflowReloadEvent[] = [];
    const watcher = mockWorkflowWatcher();
    try {
      await writeFile(path.join(root, ".env"), workflowReloadEnvFile(), "utf8");
      await writeFile(workflowPath, workflowReloadDocument({ promptTemplate: "Initial prompt." }), "utf8");

      await loader.load();
      loader.watch((event) => {
        events.push(event);
      });

      await writeFile(
        workflowPath,
        workflowReloadDocument({
          promptTemplate: "Broken prompt.",
          docsContextWorkspaceSource: false,
        }),
        "utf8",
      );
      watcher.triggerChange();
      const event = await waitForWorkflowReloadEvent(events);
      const serializedError = JSON.stringify({
        message: event.error?.message,
        code: event.error?.code,
        details: event.error?.details,
      });

      expect(event.loaded).toBeNull();
      expect(event.error).toBeInstanceOf(SymphonyError);
      expect(event.error?.code).toBe("config_validation_error");
      expect(event.error?.message).toBe('Workflow reload validation failed for project_contexts["Docs Site"]: invalid workspace.source');
      expect(event.error?.details).toEqual({
        reason: "invalid_project_context_configuration",
        projectContexts: [
          {
            contextPath: 'project_contexts["Docs Site"]',
            rawId: "Docs Site",
            projectContextId: "docs-site",
            projectContextLabel: "Documentation Site",
            enabled: true,
          },
        ],
        projectContextFieldPaths: ["workspace.source"],
      });
      expect(loader.getLastGood()?.definition.promptTemplate).toBe("Initial prompt.");
      expectWorkflowReloadErrorToRedactSecrets(serializedError);
    } finally {
      watcher.restore();
      await loader.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports malformed project-context field types during reload with context-specific redacted metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-workflow-reload-schema-error-"));
    const workflowPath = path.join(root, "WORKFLOW.md");
    const loader = new WorkflowLoader(workflowPath);
    const events: WorkflowReloadEvent[] = [];
    const watcher = mockWorkflowWatcher();
    try {
      await writeFile(path.join(root, ".env"), workflowReloadEnvFile(), "utf8");
      await writeFile(workflowPath, workflowReloadDocument({ promptTemplate: "Initial prompt." }), "utf8");

      await loader.load();
      loader.watch((event) => {
        events.push(event);
      });

      await writeFile(
        workflowPath,
        multiProjectWorkflowDocument({
          promptTemplate: "Broken prompt.",
          topLevel: workflowReloadTopLevelConfig(),
          projectContexts: [
            projectContextFixture({
              id: "symphony",
              label: "Symphony",
              projectSlug: "SYMPHONY",
              repository: ".",
            }),
            {
              ...projectContextFixture({
                id: "Docs Site",
                label: "Documentation Site",
                projectSlug: "DOCS",
                repository: "$DOCS_REPOSITORY",
                tracker: { api_key: "$DOCS_LINEAR_API_KEY" },
                github: { token: "$DOCS_GITHUB_TOKEN" },
              }),
              enabled: 123 as unknown as boolean,
            },
          ],
        }),
        "utf8",
      );
      watcher.triggerChange();
      const event = await waitForWorkflowReloadEvent(events);
      const serializedError = JSON.stringify({
        message: event.error?.message,
        code: event.error?.code,
        details: event.error?.details,
      });

      expect(event.loaded).toBeNull();
      expect(event.error).toBeInstanceOf(SymphonyError);
      expect(event.error?.code).toBe("config_validation_error");
      expect(event.error?.message).toBe('Workflow reload validation failed for project_contexts["Docs Site"]: invalid enabled');
      expect(event.error?.details).toEqual({
        reason: "invalid_project_context_configuration",
        projectContexts: [
          {
            contextPath: 'project_contexts["Docs Site"]',
            rawId: "Docs Site",
            projectContextId: "docs-site",
            projectContextLabel: "Documentation Site",
            enabled: null,
          },
        ],
        projectContextFieldPaths: ["enabled"],
      });
      expect(loader.getLastGood()?.definition.promptTemplate).toBe("Initial prompt.");
      expectWorkflowReloadErrorToRedactSecrets(serializedError);
    } finally {
      watcher.restore();
      await loader.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not surface dynamic agent state keys from Zod-derived reload field paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-workflow-reload-agent-state-key-redaction-"));
    const workflowPath = path.join(root, "WORKFLOW.md");
    const loader = new WorkflowLoader(workflowPath);
    const events: WorkflowReloadEvent[] = [];
    const watcher = mockWorkflowWatcher();
    try {
      await writeFile(path.join(root, ".env"), workflowReloadEnvFile(), "utf8");
      await writeFile(workflowPath, workflowReloadDocument({ promptTemplate: "Initial prompt." }), "utf8");

      await loader.load();
      loader.watch((event) => {
        events.push(event);
      });

      await writeFile(
        workflowPath,
        multiProjectWorkflowDocument({
          promptTemplate: "Broken prompt.",
          topLevel: workflowReloadTopLevelConfig(),
          projectContexts: [
            projectContextFixture({
              id: "symphony",
              label: "Symphony",
              projectSlug: "SYMPHONY",
              repository: ".",
            }),
            projectContextFixture({
              id: "Docs Site",
              label: "Documentation Site",
              projectSlug: "DOCS",
              repository: "$DOCS_REPOSITORY",
              tracker: { api_key: "$DOCS_LINEAR_API_KEY" },
              github: { token: "$DOCS_GITHUB_TOKEN" },
              agent: {
                max_concurrent_agents_by_state: {
                  "prod.secret": "nope" as unknown as number,
                },
              },
            }),
          ],
        }),
        "utf8",
      );
      watcher.triggerChange();
      const event = await waitForWorkflowReloadEvent(events);
      const serializedError = JSON.stringify({
        message: event.error?.message,
        code: event.error?.code,
        details: event.error?.details,
      });

      expect(event.loaded).toBeNull();
      expect(event.error).toBeInstanceOf(SymphonyError);
      expect(event.error?.code).toBe("config_validation_error");
      expect(event.error?.message).toBe(
        'Workflow reload validation failed for project_contexts["Docs Site"]: invalid agent.max_concurrent_agents_by_state',
      );
      expect(event.error?.details).toEqual({
        reason: "invalid_project_context_configuration",
        projectContexts: [
          {
            contextPath: 'project_contexts["Docs Site"]',
            rawId: "Docs Site",
            projectContextId: "docs-site",
            projectContextLabel: "Documentation Site",
            enabled: true,
          },
        ],
        projectContextFieldPaths: ["agent.max_concurrent_agents_by_state"],
      });
      expect(serializedError).not.toContain("prod.secret");
      expect(loader.getLastGood()?.definition.promptTemplate).toBe("Initial prompt.");
      expectWorkflowReloadErrorToRedactSecrets(serializedError);
    } finally {
      watcher.restore();
      await loader.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not surface dynamic credential-profile role keys from Zod-derived reload field paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-workflow-reload-credential-role-key-redaction-"));
    const workflowPath = path.join(root, "WORKFLOW.md");
    const loader = new WorkflowLoader(workflowPath);
    const events: WorkflowReloadEvent[] = [];
    const watcher = mockWorkflowWatcher();
    try {
      await writeFile(path.join(root, ".env"), workflowReloadEnvFile(), "utf8");
      await writeFile(workflowPath, workflowReloadDocument({ promptTemplate: "Initial prompt." }), "utf8");

      await loader.load();
      loader.watch((event) => {
        events.push(event);
      });

      await writeFile(
        workflowPath,
        multiProjectWorkflowDocument({
          promptTemplate: "Broken prompt.",
          topLevel: workflowReloadTopLevelConfig(),
          projectContexts: [
            projectContextFixture({
              id: "symphony",
              label: "Symphony",
              projectSlug: "SYMPHONY",
              repository: ".",
            }),
            projectContextFixture({
              id: "Docs Site",
              label: "Documentation Site",
              projectSlug: "DOCS",
              repository: "$DOCS_REPOSITORY",
              tracker: { api_key: "$DOCS_LINEAR_API_KEY" },
              github: { token: "$DOCS_GITHUB_TOKEN" },
              credential_profiles: {
                roles: {
                  worker: {
                    "top.secret.profile": 123 as unknown as string,
                  },
                },
              },
            }),
          ],
        }),
        "utf8",
      );
      watcher.triggerChange();
      const event = await waitForWorkflowReloadEvent(events);
      const serializedError = JSON.stringify({
        message: event.error?.message,
        code: event.error?.code,
        details: event.error?.details,
      });

      expect(event.loaded).toBeNull();
      expect(event.error).toBeInstanceOf(SymphonyError);
      expect(event.error?.code).toBe("config_validation_error");
      expect(event.error?.message).toBe(
        'Workflow reload validation failed for project_contexts["Docs Site"]: invalid credential_profiles.roles.worker',
      );
      expect(event.error?.details).toEqual({
        reason: "invalid_project_context_configuration",
        projectContexts: [
          {
            contextPath: 'project_contexts["Docs Site"]',
            rawId: "Docs Site",
            projectContextId: "docs-site",
            projectContextLabel: "Documentation Site",
            enabled: true,
          },
        ],
        projectContextFieldPaths: ["credential_profiles.roles.worker"],
      });
      expect(serializedError).not.toContain("top.secret.profile");
      expect(loader.getLastGood()?.definition.promptTemplate).toBe("Initial prompt.");
      expectWorkflowReloadErrorToRedactSecrets(serializedError);
    } finally {
      watcher.restore();
      await loader.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports default-project-context credential profile registry reload failures with scoped redacted metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-workflow-reload-default-context-credential-profiles-"));
    const workflowPath = path.join(root, "WORKFLOW.md");
    const loader = new WorkflowLoader(workflowPath);
    const events: WorkflowReloadEvent[] = [];
    const watcher = mockWorkflowWatcher();
    try {
      await writeFile(path.join(root, ".env"), workflowReloadEnvFile(), "utf8");
      await writeFile(workflowPath, workflowReloadDocument({ promptTemplate: "Initial prompt." }), "utf8");

      await loader.load();
      loader.watch((event) => {
        events.push(event);
      });

      await writeFile(
        workflowPath,
        multiProjectWorkflowDocument({
          promptTemplate: "Broken prompt.",
          topLevel: workflowReloadTopLevelConfig(),
          projectContexts: [
            projectContextFixture({
              id: "symphony",
              label: "Symphony",
              projectSlug: "SYMPHONY",
              repository: ".",
              credential_profiles: {
                roles: {
                  worker: {
                    "github.discovery": "top.secret.profile",
                  },
                },
              },
            }),
            projectContextFixture({
              id: "Docs Site",
              label: "Documentation Site",
              projectSlug: "DOCS",
              repository: "$DOCS_REPOSITORY",
              tracker: { api_key: "$DOCS_LINEAR_API_KEY" },
              github: { token: "$DOCS_GITHUB_TOKEN" },
            }),
          ],
        }),
        "utf8",
      );
      watcher.triggerChange();
      const event = await waitForWorkflowReloadEvent(events);
      const serializedError = JSON.stringify({
        message: event.error?.message,
        code: event.error?.code,
        details: event.error?.details,
      });

      expect(event.loaded).toBeNull();
      expect(event.error).toBeInstanceOf(SymphonyError);
      expect(event.error?.code).toBe("config_validation_error");
      expect(event.error?.message).toBe(
        'Workflow reload validation failed for project_contexts["symphony"]: invalid credential_profiles.roles.worker',
      );
      expect(event.error?.details).toEqual({
        reason: "invalid_project_context_configuration",
        projectContexts: [
          {
            contextPath: 'project_contexts["symphony"]',
            rawId: "symphony",
            projectContextId: "symphony",
            projectContextLabel: "Symphony",
            enabled: true,
          },
        ],
        projectContextFieldPaths: ["credential_profiles.roles.worker"],
      });
      expect(serializedError).not.toContain("top.secret.profile");
      expect(loader.getLastGood()?.definition.promptTemplate).toBe("Initial prompt.");
      expectWorkflowReloadErrorToRedactSecrets(serializedError);
    } finally {
      watcher.restore();
      await loader.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports sibling project-context validator failures during reload with context-specific redacted metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-workflow-reload-state-bucket-error-"));
    const workflowPath = path.join(root, "WORKFLOW.md");
    const loader = new WorkflowLoader(workflowPath);
    const events: WorkflowReloadEvent[] = [];
    const watcher = mockWorkflowWatcher();
    try {
      await writeFile(path.join(root, ".env"), workflowReloadEnvFile(), "utf8");
      await writeFile(workflowPath, workflowReloadDocument({ promptTemplate: "Initial prompt." }), "utf8");

      await loader.load();
      loader.watch((event) => {
        events.push(event);
      });

      await writeFile(
        workflowPath,
        multiProjectWorkflowDocument({
          promptTemplate: "Broken prompt.",
          topLevel: workflowReloadTopLevelConfig(),
          projectContexts: [
            projectContextFixture({
              id: "symphony",
              label: "Symphony",
              projectSlug: "SYMPHONY",
              repository: ".",
            }),
            projectContextFixture({
              id: "Docs Site",
              label: "Documentation Site",
              projectSlug: "DOCS",
              repository: "$DOCS_REPOSITORY",
              tracker: {
                api_key: "$DOCS_LINEAR_API_KEY",
                handoff_states: ["In Progress"],
              },
              github: { token: "$DOCS_GITHUB_TOKEN" },
            }),
          ],
        }),
        "utf8",
      );
      watcher.triggerChange();
      const event = await waitForWorkflowReloadEvent(events);
      const serializedError = JSON.stringify({
        message: event.error?.message,
        code: event.error?.code,
        details: event.error?.details,
      });

      expect(event.loaded).toBeNull();
      expect(event.error).toBeInstanceOf(SymphonyError);
      expect(event.error?.code).toBe("config_validation_error");
      expect(event.error?.message).toBe(
        'Workflow reload validation failed for project_contexts["Docs Site"]: invalid tracker.handoff_states, tracker.active_states',
      );
      expect(event.error?.details).toEqual({
        reason: "invalid_project_context_configuration",
        projectContexts: [
          {
            contextPath: 'project_contexts["Docs Site"]',
            rawId: "Docs Site",
            projectContextId: "docs-site",
            projectContextLabel: "Documentation Site",
            enabled: true,
          },
        ],
        projectContextFieldPaths: ["tracker.handoff_states", "tracker.active_states"],
      });
      expect(loader.getLastGood()?.definition.promptTemplate).toBe("Initial prompt.");
      expectWorkflowReloadErrorToRedactSecrets(serializedError);
    } finally {
      watcher.restore();
      await loader.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not treat overlapping state values as project-context field paths during reload sanitization", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-workflow-reload-state-value-redaction-"));
    const workflowPath = path.join(root, "WORKFLOW.md");
    const loader = new WorkflowLoader(workflowPath);
    const events: WorkflowReloadEvent[] = [];
    const watcher = mockWorkflowWatcher();
    try {
      await writeFile(path.join(root, ".env"), workflowReloadEnvFile(), "utf8");
      await writeFile(workflowPath, workflowReloadDocument({ promptTemplate: "Initial prompt." }), "utf8");

      await loader.load();
      loader.watch((event) => {
        events.push(event);
      });

      await writeFile(
        workflowPath,
        multiProjectWorkflowDocument({
          promptTemplate: "Broken prompt.",
          topLevel: workflowReloadTopLevelConfig(),
          projectContexts: [
            projectContextFixture({
              id: "symphony",
              label: "Symphony",
              projectSlug: "SYMPHONY",
              repository: ".",
            }),
            projectContextFixture({
              id: "Docs Site",
              label: "Documentation Site",
              projectSlug: "DOCS",
              repository: "$DOCS_REPOSITORY",
              tracker: {
                api_key: "$DOCS_LINEAR_API_KEY",
                active_states: ["prod.secret"],
                handoff_states: ["prod.secret"],
              },
              github: { token: "$DOCS_GITHUB_TOKEN" },
            }),
          ],
        }),
        "utf8",
      );
      watcher.triggerChange();
      const event = await waitForWorkflowReloadEvent(events);
      const serializedError = JSON.stringify({
        message: event.error?.message,
        code: event.error?.code,
        details: event.error?.details,
      });

      expect(event.loaded).toBeNull();
      expect(event.error).toBeInstanceOf(SymphonyError);
      expect(event.error?.code).toBe("config_validation_error");
      expect(event.error?.message).toBe(
        'Workflow reload validation failed for project_contexts["Docs Site"]: invalid tracker.handoff_states, tracker.active_states',
      );
      expect(event.error?.details).toEqual({
        reason: "invalid_project_context_configuration",
        projectContexts: [
          {
            contextPath: 'project_contexts["Docs Site"]',
            rawId: "Docs Site",
            projectContextId: "docs-site",
            projectContextLabel: "Documentation Site",
            enabled: true,
          },
        ],
        projectContextFieldPaths: ["tracker.handoff_states", "tracker.active_states"],
      });
      expect(serializedError).not.toContain("prod.secret");
      expect(loader.getLastGood()?.definition.promptTemplate).toBe("Initial prompt.");
      expectWorkflowReloadErrorToRedactSecrets(serializedError);
    } finally {
      watcher.restore();
      await loader.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports duplicate normalized project-context ids during reload with redacted metadata only", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-workflow-reload-duplicate-context-error-"));
    const workflowPath = path.join(root, "WORKFLOW.md");
    const loader = new WorkflowLoader(workflowPath);
    const events: WorkflowReloadEvent[] = [];
    const watcher = mockWorkflowWatcher();
    try {
      await writeFile(path.join(root, ".env"), workflowReloadEnvFile(), "utf8");
      await writeFile(workflowPath, workflowReloadDocument({ promptTemplate: "Initial prompt." }), "utf8");

      await loader.load();
      loader.watch((event) => {
        events.push(event);
      });

      await writeFile(
        workflowPath,
        multiProjectWorkflowDocument({
          promptTemplate: "Broken prompt.",
          topLevel: workflowReloadTopLevelConfig(),
          projectContexts: [
            projectContextFixture({
              id: "symphony",
              label: "Symphony",
              projectSlug: "SYMPHONY",
              repository: ".",
            }),
            projectContextFixture({
              id: "Docs Site",
              label: "Documentation Site",
              projectSlug: "DOCS",
              repository: "$DOCS_REPOSITORY",
              tracker: { api_key: "$DOCS_LINEAR_API_KEY" },
              github: { token: "$DOCS_GITHUB_TOKEN" },
            }),
            projectContextFixture({
              id: "docs_site",
              label: "Docs Site Mirror",
              projectSlug: "DOCS_MIRROR",
              repository: "$DOCS_REPOSITORY",
              tracker: { api_key: "$DOCS_LINEAR_API_KEY" },
              github: { token: "$DOCS_GITHUB_TOKEN" },
            }),
          ],
        }),
        "utf8",
      );
      watcher.triggerChange();
      const event = await waitForWorkflowReloadEvent(events);
      const serializedError = JSON.stringify({
        message: event.error?.message,
        code: event.error?.code,
        details: event.error?.details,
      });

      expect(event.loaded).toBeNull();
      expect(event.error).toBeInstanceOf(SymphonyError);
      expect(event.error?.code).toBe("config_validation_error");
      expect(event.error?.message).toBe(
        'Workflow reload validation failed for project_contexts["Docs Site"], project_contexts["docs_site"]: duplicate normalized project context id',
      );
      expect(event.error?.details).toEqual({
        reason: "duplicate_project_context_id",
        projectContexts: [
          {
            contextPath: 'project_contexts["Docs Site"]',
            rawId: "Docs Site",
            projectContextId: "docs-site",
            projectContextLabel: "Documentation Site",
            enabled: true,
          },
          {
            contextPath: 'project_contexts["docs_site"]',
            rawId: "docs_site",
            projectContextId: "docs-site",
            projectContextLabel: "Docs Site Mirror",
            enabled: true,
          },
        ],
        duplicateProjectContextId: "docs-site",
      });
      expect(loader.getLastGood()?.definition.promptTemplate).toBe("Initial prompt.");
      expectWorkflowReloadErrorToRedactSecrets(serializedError);
    } finally {
      watcher.restore();
      await loader.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps duplicate raw project context ids distinguishable in reload validation metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "symphony-workflow-reload-duplicate-raw-id-error-"));
    const workflowPath = path.join(root, "WORKFLOW.md");
    const loader = new WorkflowLoader(workflowPath);
    const events: WorkflowReloadEvent[] = [];
    const watcher = mockWorkflowWatcher();
    try {
      await writeFile(path.join(root, ".env"), workflowReloadEnvFile(), "utf8");
      await writeFile(workflowPath, workflowReloadDocument({ promptTemplate: "Initial prompt." }), "utf8");

      await loader.load();
      loader.watch((event) => {
        events.push(event);
      });

      await writeFile(
        workflowPath,
        multiProjectWorkflowDocument({
          promptTemplate: "Broken prompt.",
          topLevel: workflowReloadTopLevelConfig(),
          projectContexts: [
            projectContextFixture({
              id: "symphony",
              label: "Symphony",
              projectSlug: "SYMPHONY",
              repository: ".",
            }),
            projectContextFixture({
              id: "docs",
              label: "Documentation Site",
              projectSlug: "DOCS",
              repository: "$DOCS_REPOSITORY",
              tracker: { api_key: "$DOCS_LINEAR_API_KEY" },
              github: { token: "$DOCS_GITHUB_TOKEN" },
            }),
            projectContextFixture({
              id: "docs",
              label: "Docs Site Mirror",
              projectSlug: "DOCS_MIRROR",
              repository: "$DOCS_REPOSITORY",
              tracker: { api_key: "$DOCS_LINEAR_API_KEY" },
              github: { token: "$DOCS_GITHUB_TOKEN" },
            }),
          ],
        }),
        "utf8",
      );
      watcher.triggerChange();
      const event = await waitForWorkflowReloadEvent(events);
      const serializedError = JSON.stringify({
        message: event.error?.message,
        code: event.error?.code,
        details: event.error?.details,
      });

      expect(event.loaded).toBeNull();
      expect(event.error).toBeInstanceOf(SymphonyError);
      expect(event.error?.code).toBe("config_validation_error");
      expect(event.error?.message).toBe(
        "Workflow reload validation failed for project_contexts[1], project_contexts[2]: duplicate normalized project context id",
      );
      expect(event.error?.details).toEqual({
        reason: "duplicate_project_context_id",
        projectContexts: [
          {
            contextPath: "project_contexts[1]",
            rawId: "docs",
            projectContextId: "docs",
            projectContextLabel: "Documentation Site",
            enabled: true,
          },
          {
            contextPath: "project_contexts[2]",
            rawId: "docs",
            projectContextId: "docs",
            projectContextLabel: "Docs Site Mirror",
            enabled: true,
          },
        ],
        duplicateProjectContextId: "docs",
      });
      expect(loader.getLastGood()?.definition.promptTemplate).toBe("Initial prompt.");
      expectWorkflowReloadErrorToRedactSecrets(serializedError);
    } finally {
      watcher.restore();
      await loader.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parses bounded SDK retry and infrastructure failure configuration", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        agent: { max_sdk_error_retries: 4, max_infra_failures: 1 },
      },
      "/repo/WORKFLOW.md",
      { LINEAR_API_KEY: "secret" },
    );

    expect(config.agent.maxSdkErrorRetries).toBe(4);
    expect(config.agent.maxInfraFailures).toBe(1);
    expect(() =>
      parseServiceConfig(
        {
          tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
          agent: { max_sdk_error_retries: -1 },
        },
        "/repo/WORKFLOW.md",
        { LINEAR_API_KEY: "secret" },
      ),
    ).toThrow(SymphonyError);
    expect(() =>
      parseServiceConfig(
        {
          tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
          agent: { max_infra_failures: 0 },
        },
        "/repo/WORKFLOW.md",
        { LINEAR_API_KEY: "secret" },
      ),
    ).toThrow(SymphonyError);
  });

  it("parses PR handoff policy for human review transitions", () => {
    const config = parseServiceConfig(
      {
        tracker: {
          kind: "linear",
          api_key: "$LINEAR_API_KEY",
          project_slug: "TEST",
          handoff_states: ["Human Review"],
        },
        github: {
          publish_pull_requests: true,
          pr_handoff: {
            target_state: "Human Review",
            allow_drafts: true,
            required_checks: ["Typecheck and test"],
            no_ci: { allowed: false },
          },
        },
        review_loop: {
          review_states: ["In Review"],
        },
      },
      "/repo/WORKFLOW.md",
      { LINEAR_API_KEY: "secret" },
    );

    expect(config.github.prHandoff).toEqual({
      enabled: true,
      targetState: "Human Review",
      allowDrafts: true,
      requiredChecks: ["Typecheck and test"],
      noCiAllowed: false,
      noCiEvidence: null,
    });
  });

  it("rejects PR handoff policies that collapse human and agent review queues", () => {
    expect(() =>
      parseServiceConfig(
        {
          tracker: {
            kind: "linear",
            api_key: "$LINEAR_API_KEY",
            project_slug: "TEST",
            handoff_states: ["In Review"],
          },
          review_loop: {
            review_states: ["In Review"],
          },
          github: {
            publish_pull_requests: true,
            pr_handoff: {
              enabled: true,
              target_state: "In Review",
              required_checks: ["Typecheck and test"],
            },
          },
        },
        "/repo/WORKFLOW.md",
        { LINEAR_API_KEY: "secret" },
      ),
    ).toThrow("tracker.handoff_states must not overlap review_loop.review_states");
  });

  it("rejects PR handoff targets outside tracker handoff states", () => {
    expect(() =>
      parseServiceConfig(
        {
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
            publish_pull_requests: true,
            pr_handoff: {
              enabled: true,
              target_state: "In Review",
              required_checks: ["Typecheck and test"],
            },
          },
        },
        "/repo/WORKFLOW.md",
        { LINEAR_API_KEY: "secret" },
      ),
    ).toThrow("github.pr_handoff.target_state must be listed in tracker.handoff_states");
  });

  it("requires explicit handoff checks for published PR handoff policies", () => {
    expect(() =>
      parseServiceConfig(
        {
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
            publish_pull_requests: true,
            pr_handoff: {
              enabled: true,
              target_state: "Human Review",
            },
          },
        },
        "/repo/WORKFLOW.md",
        { LINEAR_API_KEY: "secret" },
      ),
    ).toThrow("github.pr_handoff.required_checks is required");
  });

  it("validates implicit PR handoff when PR publication is enabled", () => {
    expect(() =>
      parseServiceConfig(
        {
          tracker: {
            kind: "linear",
            api_key: "$LINEAR_API_KEY",
            project_slug: "TEST",
            handoff_states: ["Human Review"],
          },
          github: {
            publish_pull_requests: true,
          },
        },
        "/repo/WORKFLOW.md",
        { LINEAR_API_KEY: "secret" },
      ),
    ).toThrow("tracker.handoff_states must not overlap review_loop.review_states");
  });

  it("requires checks or no-CI evidence for implicit PR handoff", () => {
    expect(() =>
      parseServiceConfig(
        {
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
            publish_pull_requests: true,
          },
        },
        "/repo/WORKFLOW.md",
        { LINEAR_API_KEY: "secret" },
      ),
    ).toThrow("github.pr_handoff.required_checks is required");
  });

  it("rejects PR handoff states that collapse into the reviewer pass state", () => {
    expect(() =>
      parseServiceConfig(
        {
          tracker: {
            kind: "linear",
            api_key: "$LINEAR_API_KEY",
            project_slug: "TEST",
            handoff_states: ["Ready to Merge"],
          },
          review_loop: {
            review_states: ["In Review"],
            review_pass_state: "Ready to Merge",
          },
          github: {
            publish_pull_requests: true,
            pr_handoff: {
              enabled: true,
              target_state: "Ready to Merge",
              required_checks: ["Typecheck and test"],
            },
          },
        },
        "/repo/WORKFLOW.md",
        { LINEAR_API_KEY: "secret" },
      ),
    ).toThrow("tracker.handoff_states must not overlap review_loop.review_pass_state");
  });

  it("rejects PR handoff without service-owned PR publication", () => {
    expect(() =>
      parseServiceConfig(
        {
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
            publish_pull_requests: false,
            pr_handoff: {
              enabled: true,
              target_state: "Human Review",
              required_checks: ["Typecheck and test"],
            },
          },
        },
        "/repo/WORKFLOW.md",
        { LINEAR_API_KEY: "secret" },
      ),
    ).toThrow("github.pr_handoff.enabled requires github.publish_pull_requests");
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
          reviewer_prompt_extensions: [" Check database transactions. ", " ", "Check API boundaries."],
          worker_prompt_extensions: [" Fix shared invariants. ", "\t", "Validate replay."],
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
        issue_breakdown: {
          enabled: true,
          cursor_mode: "plan",
          prompt: "Plan {{ issue.identifier }}",
          planning_labels: ["Planning"],
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
      reviewerPromptExtensions: ["Check database transactions.", "Check API boundaries."],
      workerPromptExtensions: ["Fix shared invariants.", "Validate replay."],
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
    expect(config.issueBreakdown).toEqual({
      enabled: true,
      cursorMode: "plan",
      promptTemplate: "Plan {{ issue.identifier }}",
      planningLabels: ["planning"],
      applyToLinear: {
        enabled: false,
        mode: "child_issues",
      },
      workspaceMode: "none",
      maxPlanningFailures: 3,
      maxPlanningDispatchRetries: 3,
      planningRetryBaseMs: 5_000,
      planningRetryMaxMs: 60_000,
    });
    expect(config.mergePolicy).toEqual({
      mode: "gated",
      sourceStates: ["Review Passed"],
      conflictsState: null,
      maxConflictFixTurns: 3,
      doneState: "Done",
      mergeMethod: "squash",
      requiredChecks: ["test"],
      missingCheckStabilizationMs: 60_000,
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

  it("rejects readonly issue breakdown workspaces unless a non-Windows git worktree source can enforce them", () => {
    expect(() =>
      parseServiceConfig(
        {
          tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
          workspace: {
            source: { kind: "copy", path: "/repo" },
          },
          issue_breakdown: {
            workspace_mode: "readonly_checkout",
          },
        },
        "/repo/WORKFLOW.md",
        { LINEAR_API_KEY: "secret" },
      ),
    ).toThrow("readonly_checkout requires workspace.source.kind git_worktree");

    const parseGitWorktreeReadonly = () =>
      parseServiceConfig(
        {
          tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
          workspace: {
            source: {
              kind: "git_worktree",
              repository: "/repo",
              base_ref: "main",
            },
          },
          issue_breakdown: {
            workspace_mode: "readonly_checkout",
          },
        },
        "/repo/WORKFLOW.md",
        { LINEAR_API_KEY: "secret" },
      );

    if (process.platform === "win32") {
      expect(parseGitWorktreeReadonly).toThrow("readonly_checkout is not supported on Windows");
    } else {
      expect(parseGitWorktreeReadonly().issueBreakdown.workspaceMode).toBe("readonly_checkout");
    }
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

  it("parses legacy merge conflict states without adding them to normal board routing", () => {
    const config = parseServiceConfig(
      {
        tracker: {
          kind: "linear",
          api_key: "$LINEAR_API_KEY",
          project_slug: "TEST",
          active_states: ["Todo", "In Progress"],
        },
        review_loop: { review_states: ["In Review"], review_pass_state: "Ready to Merge" },
        merge_policy: {
          mode: "gated",
          source_states: ["Ready to Merge"],
          conflicts_state: "Approved with Conflicts",
        },
      },
      "/repo/WORKFLOW.md",
      { LINEAR_API_KEY: "secret" },
    );

    expect(config.mergePolicy.conflictsState).toBe("Approved with Conflicts");
    expect(config.tracker.activeStates).not.toContain("Approved with Conflicts");
    expect(config.issueBoard.columns.progress).not.toContain("Approved with Conflicts");
    expect(config.issueBoard.columns.review).not.toContain("Approved with Conflicts");
  });

  it("accepts legacy merge conflict states that overlap normal lifecycle buckets because new routing ignores them", () => {
    expect(
      parseServiceConfig(
        {
          tracker: {
            kind: "linear",
            api_key: "$LINEAR_API_KEY",
            project_slug: "TEST",
            active_states: ["Todo", "In Progress"],
          },
          review_loop: { review_states: ["In Review"], review_pass_state: "Ready to Merge" },
          merge_policy: {
            mode: "gated",
            source_states: ["Ready to Merge"],
            conflicts_state: "In Progress",
          },
        },
        "/repo/WORKFLOW.md",
        { LINEAR_API_KEY: "secret" },
      ),
    ).toMatchObject({ mergePolicy: { conflictsState: "In Progress" } });
    expect(
      parseServiceConfig(
        {
          tracker: {
            kind: "linear",
            api_key: "$LINEAR_API_KEY",
            project_slug: "TEST",
            active_states: ["Todo", "In Progress"],
          },
          review_loop: { review_states: ["In Review"], blocked_states: ["Blocked"], review_pass_state: "Ready to Merge" },
          merge_policy: {
            mode: "gated",
            source_states: ["Ready to Merge"],
            conflicts_state: "Ready to Merge",
          },
        },
        "/repo/WORKFLOW.md",
        { LINEAR_API_KEY: "secret" },
      ),
    ).toMatchObject({ mergePolicy: { conflictsState: "Ready to Merge" } });
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

  it("parses explicit Cursor conversation modes and rejects unsupported modes", () => {
    const planMode = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        cursor: { mode: "plan" },
      },
      "/repo/WORKFLOW.md",
      { LINEAR_API_KEY: "secret" },
    );
    const agentMode = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        cursor: { mode: "agent" },
      },
      "/repo/WORKFLOW.md",
      { LINEAR_API_KEY: "secret" },
    );

    expect(planMode.cursor.mode).toBe("plan");
    expect(agentMode.cursor.mode).toBe("agent");
    expect(() =>
      parseServiceConfig(
        {
          tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
          cursor: { mode: "ask" },
        },
        "/repo/WORKFLOW.md",
        { LINEAR_API_KEY: "secret" },
      ),
    ).toThrow(SymphonyError);
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
      app: null,
      headOwner: "fork-owner",
      apiBaseUrl: "https://github.example/api/v3",
      publishPullRequests: false,
      operatorApproval: {
        requiredForPublication: false,
        rejectPolicy: "cancel",
        pollIntervalMs: 2000,
        timeoutMs: null,
      },
      prHandoff: {
        enabled: false,
        targetState: null,
        allowDrafts: false,
        requiredChecks: [],
        noCiAllowed: false,
        noCiEvidence: null,
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

  it("parses Hermes runtime config while preserving Cursor as the default harness", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        hermes: {
          state_dir: "$HERMES_HOME",
          model: "$HERMES_MODEL",
          provider: "openai",
          role_templates: { reviewer: "fresh-reviewer" },
        },
      },
      "/repo/WORKFLOW.md",
      { LINEAR_API_KEY: "secret", HERMES_HOME: "/tmp/hermes-home", HERMES_MODEL: "hermes-test-model" },
    );

    expect(config.agent.harness).toBe("cursor");
    expect(config.hermes.stateDir.replace(/\\/g, "/")).toMatch(/\/tmp\/hermes-home$/);
    expect(config.hermes).toMatchObject({
      model: "hermes-test-model",
      provider: "openai",
      workerSessionLifecycle: "reuse_by_issue",
      keepProfiles: "failed",
      runtimeCredentialEnv: "HERMES_API_KEY",
      auth: {
        mode: "managed_root",
        providers: ["openai-codex"],
      },
      roleTemplates: {
        worker: "worker",
        reviewer: "fresh-reviewer",
        planner: "planner",
        mergeConflictResolution: "worker",
      },
    });
    expect(config.hermes.auth.managedRoot.replace(/\\/g, "/")).toMatch(/\/tmp\/hermes-home\/auth$/);
    expect(config.hermes.auth.bootstrapFrom.replace(/\\/g, "/")).toMatch(/\/tmp\/hermes-home$/);
    expect(config.hermes.acpBinaryPath).toBeNull();
    expect(config.hermes.acpSourceProfile).toBeNull();
    expect(config.hermes.acpProfilePrefix).toBeNull();
    expect(config.hermesAcp).toEqual({
      binaryPath: null,
      sourceProfile: null,
      profilePrefix: "symphony",
      workerSessionLifecycle: "reuse_by_issue",
      keepProfiles: "failed",
      startupTimeoutMs: 15_000,
      requestTimeoutMs: 120_000,
      permissionTimeoutMs: 120_000,
    });

    const hermesConfig = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        agent: { harness: "hermes", max_turns: 1 },
        hermes: {
          auth: {
            managed_root: "$SYMPHONY_HERMES_AUTH",
            bootstrap_from: "local-hermes-auth",
            providers: ["openai-codex"],
          },
        },
      },
      "/repo/WORKFLOW.md",
      { LINEAR_API_KEY: "secret", SYMPHONY_HERMES_AUTH: "/tmp/symphony-hermes-auth" },
    );
    expect(hermesConfig.agent.harness).toBe("hermes");
    expect(hermesConfig.hermes.auth.managedRoot.replace(/\\/g, "/")).toMatch(/\/tmp\/symphony-hermes-auth$/);
    expect(hermesConfig.hermes.auth.bootstrapFrom.replace(/\\/g, "/")).toMatch(/\/repo\/local-hermes-auth$/);
  });

  it("keeps hermes_acp config isolated from Hermes TUI runtime config", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        agent: { harness: "hermes" },
        hermes: {
          upstream_root: "$HERMES_TUI_UPSTREAM",
          templates_dir: "hermes-tui-templates",
          state_dir: "$HERMES_TUI_STATE",
          python: "python-tui",
          provider: "openai-codex",
          model: "gpt-5.5-tui",
          worker_session_lifecycle: "reuse_by_issue",
          keep_profiles: "failed",
          startup_timeout_ms: 22_000,
          request_timeout_ms: 33_000,
          auth: {
            managed_root: "$HERMES_TUI_AUTH_ROOT",
            bootstrap_from: "local-hermes-auth",
            providers: ["openai-codex"],
          },
        },
        hermes_acp: {
          binary_path: "$HOST_HERMES_BINARY",
          source_profile: "$HOST_HERMES_SOURCE_PROFILE",
          profile_prefix: "host-acp",
          worker_session_lifecycle: "fresh_per_run",
          keep_profiles: "always",
          startup_timeout_ms: 5_000,
          request_timeout_ms: 6_000,
          permission_timeout_ms: 7_000,
        },
      },
      "/repo/WORKFLOW.md",
      {
        LINEAR_API_KEY: "secret",
        HERMES_TUI_UPSTREAM: "/srv/symphony/hermes-upstream",
        HERMES_TUI_STATE: "/srv/symphony/hermes-tui-state",
        HERMES_TUI_AUTH_ROOT: "/srv/symphony/hermes-tui-auth",
        HOST_HERMES_BINARY: "/opt/host-hermes/bin/hermes",
        HOST_HERMES_SOURCE_PROFILE: "dogfood-host",
      },
    );

    expect(config.agent.harness).toBe("hermes");
    expect(config.hermes).toMatchObject({
      python: "python-tui",
      provider: "openai-codex",
      model: "gpt-5.5-tui",
      workerSessionLifecycle: "reuse_by_issue",
      keepProfiles: "failed",
      startupTimeoutMs: 22_000,
      requestTimeoutMs: 33_000,
      acpBinaryPath: null,
      acpSourceProfile: null,
      acpProfilePrefix: null,
      auth: {
        mode: "managed_root",
        providers: ["openai-codex"],
      },
    });
    expect(config.hermes.upstreamRoot.replace(/\\/g, "/")).toMatch(/\/srv\/symphony\/hermes-upstream$/);
    expect(config.hermes.templatesDir.replace(/\\/g, "/")).toMatch(/\/repo\/hermes-tui-templates$/);
    expect(config.hermes.stateDir.replace(/\\/g, "/")).toMatch(/\/srv\/symphony\/hermes-tui-state$/);
    expect(config.hermes.auth.managedRoot.replace(/\\/g, "/")).toMatch(/\/srv\/symphony\/hermes-tui-auth$/);
    expect(config.hermes.auth.bootstrapFrom.replace(/\\/g, "/")).toMatch(/\/repo\/local-hermes-auth$/);
    expect(config.hermesAcp).toEqual({
      binaryPath: "/opt/host-hermes/bin/hermes",
      sourceProfile: "dogfood-host",
      profilePrefix: "host-acp",
      workerSessionLifecycle: "fresh_per_run",
      keepProfiles: "always",
      startupTimeoutMs: 5_000,
      requestTimeoutMs: 6_000,
      permissionTimeoutMs: 7_000,
    });
  });

  it("parses hermes_acp host harness defaults, overrides, and legacy compatibility aliases", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        agent: { harness: "hermes_acp" },
        hermes: {
          state_dir: "managed-hermes",
          model: "gpt-test",
          acp_binary_path: "/legacy/should-not-win",
          acp_source_profile: "legacy-should-not-win",
          acp_profile_prefix: "legacy-should-not-win",
          worker_session_lifecycle: "reuse_by_issue",
          keep_profiles: "failed",
          request_timeout_ms: 33_000,
        },
        hermes_acp: {
          binary_path: "$HOST_HERMES_BINARY",
          source_profile: "$HOST_HERMES_SOURCE_PROFILE",
          profile_name_prefix: "sym-alias",
          profile_prefix: "sym-test",
          worker_session_lifecycle: "fresh_per_run",
          keep_profiles: "always",
          startup_timeout_ms: 5_000,
          request_timeout_ms: 6_000,
          permission_timeout_ms: 7_000,
        },
      },
      "/repo/WORKFLOW.md",
      {
        LINEAR_API_KEY: "secret",
        HOST_HERMES_BINARY: "/opt/hermes/bin/hermes",
        HOST_HERMES_SOURCE_PROFILE: "dogfood",
      },
    );

    expect(config.hermesAcp).toEqual({
      binaryPath: "/opt/hermes/bin/hermes",
      sourceProfile: "dogfood",
      profilePrefix: "sym-test",
      workerSessionLifecycle: "fresh_per_run",
      keepProfiles: "always",
      startupTimeoutMs: 5_000,
      requestTimeoutMs: 6_000,
      permissionTimeoutMs: 7_000,
    });
    expect(config.hermes.stateDir.replace(/\\/g, "/")).toMatch(/\/repo\/managed-hermes$/);
    expect(config.hermes.acpBinaryPath).toBe("/legacy/should-not-win");
    expect(config.hermes.acpSourceProfile).toBe("legacy-should-not-win");
    expect(config.hermes.acpProfilePrefix).toBe("legacy-should-not-win");
    expect(config.hermes.workerSessionLifecycle).toBe("reuse_by_issue");
    expect(config.hermes.keepProfiles).toBe("failed");
    expect(config.hermes.requestTimeoutMs).toBe(33_000);

    const legacy = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        agent: { harness: "hermes_acp" },
        hermes: {
          acp_binary_path: "/legacy/hermes",
          acp_source_profile: "legacy-source",
          acp_profile_prefix: "legacy-prefix",
          startup_timeout_ms: 1_000,
          request_timeout_ms: 2_000,
          worker_session_lifecycle: "fresh_per_run",
          keep_profiles: "never",
        },
      },
      "/repo/WORKFLOW.md",
      { LINEAR_API_KEY: "secret" },
    );
    expect(legacy.hermesAcp).toEqual({
      binaryPath: "/legacy/hermes",
      sourceProfile: "legacy-source",
      profilePrefix: "legacy-prefix",
      workerSessionLifecycle: "fresh_per_run",
      keepProfiles: "never",
      startupTimeoutMs: 1_000,
      requestTimeoutMs: 2_000,
      permissionTimeoutMs: 2_000,
    });
    expect(legacy.hermes).toMatchObject({
      acpBinaryPath: "/legacy/hermes",
      acpSourceProfile: "legacy-source",
      acpProfilePrefix: "legacy-prefix",
    });

    const profileNameAlias = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        hermes_acp: { profile_name_prefix: "alias-prefix" },
      },
      "/repo/WORKFLOW.md",
      { LINEAR_API_KEY: "secret" },
    );
    expect(profileNameAlias.hermesAcp.profilePrefix).toBe("alias-prefix");
  });

  it("rejects invalid hermes_acp timeouts and profile names", () => {
    const base = { tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" } };
    for (const hermesAcp of [
      { startup_timeout_ms: 0 },
      { request_timeout_ms: -1 },
      { permission_timeout_ms: 1.5 },
      { worker_session_lifecycle: "reuse" },
      { keep_profiles: "sometimes" },
    ]) {
      expect(() => parseServiceConfig({ ...base, hermes_acp: hermesAcp }, "/repo/WORKFLOW.md", { LINEAR_API_KEY: "secret" })).toThrow(
        "Workflow config is invalid",
      );
    }

    expect(() =>
      parseServiceConfig({ ...base, hermes_acp: { source_profile: "bad profile" } }, "/repo/WORKFLOW.md", {
        LINEAR_API_KEY: "secret",
      }),
    ).toThrow("hermes_acp.source_profile must be a valid host Hermes profile name");
    expect(() =>
      parseServiceConfig({ ...base, hermes_acp: { profile_prefix: "../bad" } }, "/repo/WORKFLOW.md", {
        LINEAR_API_KEY: "secret",
      }),
    ).toThrow("hermes_acp.profile_prefix must be a valid host Hermes profile name");
  });

  it("parses the canonical workflow with current Hermes dogfood defaults", async () => {
    const workflowPath = path.resolve("WORKFLOW.md");
    const parsed = parseWorkflowFile(await readFile(workflowPath, "utf8"), workflowPath);
    const config = parseServiceConfig(parsed.config, workflowPath, {
      LINEAR_API_KEY: "linear-secret",
      LINEAR_PROJECT_SLUG: "TEST",
      LINEAR_ASSIGNEE: "me",
      GITHUB_PUBLICATION_TOKEN: "publication-secret",
      GITHUB_FEEDBACK_TOKEN: "feedback-secret",
      GITHUB_APP_ID: "12345",
      GITHUB_APP_CLIENT_ID: "Iv1.client-id",
      GITHUB_APP_INSTALLATION_ID: "67890",
      GITHUB_APP_PRIVATE_KEY_PATH: "/tmp/github-app-private-key.pem",
      SYMPHONY_WORKSPACE_TOKEN: "workspace-secret",
    });

    const rawGithub = parsed.config.github as { pr_handoff?: { enabled?: unknown } } | undefined;
    const rawHermes = parsed.config.hermes as {
      model?: unknown;
      worker_session_lifecycle?: unknown;
      keep_profiles?: unknown;
    } | undefined;

    expect(config.agent.harness).toBe("hermes");
    expect(config.agent.maxConcurrentAgents).toBe(5);
    expect(config.agent.maxTurns).toBe(1);
    expect(config.mergePolicy.mode).toBe("gated");
    expect(config.continuationContext.searchEnabled).toBe(false);
    expect(rawGithub?.pr_handoff?.enabled).toBeTypeOf("boolean");
    expect(config.github.prHandoff.enabled).toBe(rawGithub?.pr_handoff?.enabled);
    expect(config.github.token).toBeNull();
    expect(config.github.app).toMatchObject({
      appId: "12345",
      clientId: "Iv1.client-id",
      installationId: "67890",
    });
    expect(config.github.app?.privateKeyPath?.replace(/\\/g, "/")).toMatch(/\/tmp\/github-app-private-key\.pem$/);
    expect(config.server.openWorkspaceToken).toBe("workspace-secret");
    expect(config.hermes.provider).toBe("openai-codex");
    expect(rawHermes?.model).toBe("gpt-5.4");
    expect(config.hermes.model).toBe(rawHermes?.model);
    expect(config.hermes.auth).toMatchObject({
      mode: "managed_root",
      providers: ["openai-codex"],
    });
    expect(rawHermes?.worker_session_lifecycle).toBe("fresh_per_run");
    expect(config.hermes.workerSessionLifecycle).toBe(rawHermes?.worker_session_lifecycle);
    expect(rawHermes?.keep_profiles).toBe("failed");
    expect(config.hermes.keepProfiles).toBe(rawHermes?.keep_profiles);
    expect(config.agent.protectedPaths).toContain("hermes/src/**");
    const expectedReasoningEffortByTemplate = new Map([
      ["worker", "xhigh"],
      ["reviewer", "xhigh"],
      ["planner", "xhigh"],
    ]);
    for (const [template, expectedReasoningEffort] of expectedReasoningEffortByTemplate) {
      const templateConfig = YAML.parse(
        await readFile(path.resolve("hermes", "templates", template, "config.yaml"), "utf8"),
      ) as { agent?: { reasoning_effort?: unknown } };
      expect(templateConfig.agent?.reasoning_effort).toBe(expectedReasoningEffort);
    }
  });

  it("fails strict prompt rendering on unknown variables", async () => {
    const renderer = new PromptRenderer();
    await expect(renderer.render("{{ issue.nope }}", { issue: issue(), attempt: null })).rejects.toBeInstanceOf(
      SymphonyError,
    );
  });
});

describe("project context workflow contracts", () => {
  it("normalizes legacy single-project workflows without project_contexts into one default context", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        workspace: { root: "./workspaces" },
        github: { owner: "acme", repo: "symphony", token: "$GITHUB_TOKEN" },
        review_loop: { review_states: ["In Review"], max_review_rounds: 5 },
        polling: { interval_ms: 60_000 },
        agent: { max_concurrent_agents: 2, max_turns: 1 },
      },
      "/repo/WORKFLOW.md",
      { LINEAR_API_KEY: "linear-test-key", GITHUB_TOKEN: "github-test-token" },
    );

    expect(config.projectContexts.contexts).toHaveLength(1);
    expect(config.projectContexts.defaultContextId).toBe(LEGACY_DEFAULT_PROJECT_CONTEXT_ID);
    expect(config.projectContexts.defaultContext).toMatchObject({
      id: LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
      label: LEGACY_DEFAULT_PROJECT_CONTEXT_LABEL,
      source: LEGACY_DEFAULT_PROJECT_CONTEXT_ROUTING_SOURCE,
      tracker: { projectSlug: "TEST" },
      github: { owner: "acme", repo: "symphony", token: "github-test-token" },
      reviewLoop: { reviewStates: ["In Review"], maxReviewRounds: 5 },
      agent: { maxConcurrentAgents: 2, maxTurns: 1 },
    });
    expect(config.projectContexts.defaultContext.publicMetadata).toMatchObject({
      id: LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
      label: LEGACY_DEFAULT_PROJECT_CONTEXT_LABEL,
      linearProjectSlug: "TEST",
    });
  });

  it("normalizes project context ids into safe workflow identifiers", () => {
    const config = parseServiceConfig(
      multiProjectWorkflowConfig({
        projectContexts: [
          projectContextFixture({
            id: "Docs Site",
            label: "Documentation Site",
            projectSlug: "DOCS",
            repository: "../docs-site",
          }),
          projectContextFixture({
            id: "ops_portal",
            label: "Ops Portal",
            projectSlug: "OPS",
            repository: "../ops-portal",
          }),
        ],
      }),
      "/repo/WORKFLOW.md",
      { LINEAR_API_KEY: "secret" },
    );

    expect(config.projectContexts.contexts.map((context) => context.id)).toEqual(["docs-site", "ops-portal"]);
    expect(config.projectContexts.defaultContextId).toBe("docs-site");
    expect(config.projectContexts.byId.get("docs-site")).toMatchObject({
      id: "docs-site",
      label: "Documentation Site",
      tracker: { projectSlug: "DOCS" },
      workspace: { source: { repository: path.resolve("/repo", "../docs-site") } },
    });
    expect(config.projectContexts.byId.get("ops-portal")).toMatchObject({
      id: "ops-portal",
      label: "Ops Portal",
      tracker: { projectSlug: "OPS" },
      workspace: { source: { repository: path.resolve("/repo", "../ops-portal") } },
    });
  });

  it("allows three named project contexts when two share a codebase but target different Linear projects", () => {
    const config = parseServiceConfig(
      multiProjectWorkflowConfig({
        projectContexts: [
          projectContextFixture({
            id: "Docs Authoring",
            label: "Docs Authoring",
            projectSlug: "DOCS_AUTHORING",
            repository: "../docs-site",
          }),
          projectContextFixture({
            id: "Docs Release",
            label: "Docs Release",
            projectSlug: "DOCS_RELEASE",
            repository: "../docs-site",
          }),
          projectContextFixture({
            id: "Ops Portal",
            label: "Ops Portal",
            projectSlug: "OPS",
            repository: "../ops-portal",
          }),
        ],
      }),
      "/repo/WORKFLOW.md",
      { LINEAR_API_KEY: "secret" },
    );

    expect(config.projectContexts.contexts.map((context) => context.id)).toEqual([
      "docs-authoring",
      "docs-release",
      "ops-portal",
    ]);
    expect(config.projectContexts.defaultContextId).toBe("docs-authoring");

    const docsAuthoring = config.projectContexts.byId.get("docs-authoring");
    const docsRelease = config.projectContexts.byId.get("docs-release");
    const opsPortal = config.projectContexts.byId.get("ops-portal");

    expect(docsAuthoring).toMatchObject({
      id: "docs-authoring",
      label: "Docs Authoring",
      tracker: { projectSlug: "DOCS_AUTHORING" },
      workspace: { source: { repository: path.resolve("/repo", "../docs-site") } },
    });
    expect(docsRelease).toMatchObject({
      id: "docs-release",
      label: "Docs Release",
      tracker: { projectSlug: "DOCS_RELEASE" },
      workspace: { source: { repository: path.resolve("/repo", "../docs-site") } },
    });
    expect(opsPortal).toMatchObject({
      id: "ops-portal",
      label: "Ops Portal",
      tracker: { projectSlug: "OPS" },
      workspace: { source: { repository: path.resolve("/repo", "../ops-portal") } },
    });
    expect(docsAuthoring?.workspace.source.repository).toBe(docsRelease?.workspace.source.repository);
    expect(docsAuthoring?.tracker.projectSlug).not.toBe(docsRelease?.tracker.projectSlug);
  });

  it("rejects duplicate project context ids after normalization", () => {
    expect(() =>
      parseServiceConfig(
        multiProjectWorkflowConfig({
          projectContexts: [
            projectContextFixture({
              id: "Docs Site",
              projectSlug: "DOCS",
              repository: "../docs-site",
            }),
            projectContextFixture({
              id: "docs_site",
              projectSlug: "DOCS2",
              repository: "../docs-site-v2",
            }),
          ],
        }),
        "/repo/WORKFLOW.md",
        { LINEAR_API_KEY: "secret" },
      ),
    ).toThrowError("Duplicate project context id: docs-site");
  });

  it("keeps duplicate raw project context ids distinguishable in parse-time validation metadata", () => {
    expect.assertions(3);

    try {
      parseServiceConfig(
        multiProjectWorkflowConfig({
          projectContexts: [
            projectContextFixture({
              id: "docs",
              projectSlug: "DOCS",
              repository: "../docs-site",
            }),
            projectContextFixture({
              id: "docs",
              projectSlug: "DOCS2",
              repository: "../docs-site-v2",
            }),
          ],
        }),
        "/repo/WORKFLOW.md",
        { LINEAR_API_KEY: "secret" },
      );
    } catch (error) {
      expect(error).toBeInstanceOf(SymphonyError);
      expect((error as SymphonyError).message).toBe("Duplicate project context id: docs");
      expect((error as SymphonyError).details).toEqual({
        projectContextPaths: ["project_contexts[0]", "project_contexts[1]"],
        duplicateProjectContextId: "docs",
      });
    }
  });

  it.each(["!!!", "   ", "___"])(
    "rejects project context ids without letters or numbers after normalization for %j",
    (rawId) => {
      expect(() =>
        parseServiceConfig(
          multiProjectWorkflowConfig({
            projectContexts: [
              projectContextFixture({
                id: rawId,
                projectSlug: "DOCS",
                repository: "../docs-site",
              }),
            ],
          }),
          "/repo/WORKFLOW.md",
          { LINEAR_API_KEY: "secret" },
        ),
      ).toThrowError(
        `project_contexts[${JSON.stringify(rawId)}].id must contain at least one letter or number after normalization`,
      );
    },
  );

  it("allows disabled project contexts to omit tracker and workspace source", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear" },
        project_contexts: [
          {
            id: "symphony",
            tracker: {
              api_key: "$SYMPHONY_LINEAR_API_KEY",
              project_slug: "SYMPHONY",
            },
            workspace: {
              source: {
                kind: "git_worktree",
                repository: ".",
                base_ref: "origin/main",
              },
            },
          },
          {
            id: "Disabled Docs",
            enabled: false,
          },
        ],
      },
      "/repo/WORKFLOW.md",
      { SYMPHONY_LINEAR_API_KEY: "symphony-linear-secret" },
    );

    expect(config.projectContexts.defaultContextId).toBe("symphony");
    expect(config.projectContexts.byId.get("disabled-docs")).toMatchObject({
      id: "disabled-docs",
      enabled: false,
      tracker: { projectSlug: "" },
      workspace: { source: { kind: "none" } },
    });
  });

  it.each([
    {
      label: "missing tracker",
      rawConfig: {
        tracker: { kind: "linear" },
        workspace: {
          source: {
            kind: "git_worktree",
            repository: ".",
            base_ref: "origin/main",
          },
        },
        project_contexts: [
          {
            id: "Docs Site",
          },
        ],
      },
      env: {},
      expectedMessage: 'project_contexts["Docs Site"].tracker.api_key is required',
    },
    {
      label: "missing tracker project slug",
      rawConfig: {
        tracker: { kind: "linear" },
        workspace: {
          source: {
            kind: "git_worktree",
            repository: ".",
            base_ref: "origin/main",
          },
        },
        project_contexts: [
          {
            id: "Docs Site",
            tracker: { api_key: "$DOCS_LINEAR_API_KEY" },
          },
        ],
      },
      env: { DOCS_LINEAR_API_KEY: "docs-linear-secret" },
      expectedMessage: 'project_contexts["Docs Site"].tracker.project_slug is required',
    },
    {
      label: "missing workspace source",
      rawConfig: {
        tracker: { kind: "linear" },
        project_contexts: [
          {
            id: "Docs Site",
            tracker: {
              api_key: "$DOCS_LINEAR_API_KEY",
              project_slug: "DOCS",
            },
            workspace: {
              root: "./docs-workspaces",
            },
          },
        ],
      },
      env: { DOCS_LINEAR_API_KEY: "docs-linear-secret" },
      expectedMessage: 'project_contexts["Docs Site"].workspace.source is required for enabled project contexts',
    },
    {
      label: "missing git_worktree repository",
      rawConfig: {
        tracker: { kind: "linear" },
        project_contexts: [
          {
            id: "Docs Site",
            tracker: {
              api_key: "$DOCS_LINEAR_API_KEY",
              project_slug: "DOCS",
            },
            workspace: {
              root: "./docs-workspaces",
              source: {
                kind: "git_worktree",
                base_ref: "origin/main",
              },
            },
          },
        ],
      },
      env: { DOCS_LINEAR_API_KEY: "docs-linear-secret" },
      expectedMessage: 'project_contexts["Docs Site"].workspace.source.repository is required for git_worktree',
    },
    {
      label: "missing git_worktree base ref",
      rawConfig: {
        tracker: { kind: "linear" },
        project_contexts: [
          {
            id: "Docs Site",
            tracker: {
              api_key: "$DOCS_LINEAR_API_KEY",
              project_slug: "DOCS",
            },
            workspace: {
              root: "./docs-workspaces",
              source: {
                kind: "git_worktree",
                repository: "../docs-site",
              },
            },
          },
        ],
      },
      env: { DOCS_LINEAR_API_KEY: "docs-linear-secret" },
      expectedMessage: 'project_contexts["Docs Site"].workspace.source.base_ref is required for git_worktree',
    },
  ])("rejects enabled project contexts with $label", ({ rawConfig, env, expectedMessage }) => {
    expect(() => parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", env)).toThrowError(expectedMessage);
  });

  it("normalizes three configured project contexts within the performance budget without network calls", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const rawConfig = multiProjectWorkflowConfig({
        projectContexts: [
          projectContextFixture({
            id: "Docs Site",
            label: "Documentation Site",
            projectSlug: "DOCS",
            repository: "../shared-platform",
          }),
          projectContextFixture({
            id: "ops_portal",
            label: "Ops Portal",
            projectSlug: "OPS",
            repository: "../shared-platform",
          }),
          projectContextFixture({
            id: "Status Board",
            label: "Status Board",
            projectSlug: "STATUS",
            repository: "../status-board",
          }),
        ],
      });
      const env = { LINEAR_API_KEY: "secret" };
      const warmup = parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", env);
      expect(warmup.projectContexts.contexts.map((context) => context.id)).toEqual([
        "docs-site",
        "ops-portal",
        "status-board",
      ]);
      expect(warmup.projectContexts.defaultContextId).toBe("docs-site");

      const iterations = 200;
      const startedAt = performance.now();
      let lastConfig = warmup;
      for (let index = 0; index < iterations; index += 1) {
        lastConfig = parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", env);
      }
      const averageMs = (performance.now() - startedAt) / iterations;

      expect(lastConfig.projectContexts.contexts).toHaveLength(3);
      expect(lastConfig.projectContexts.byId.get("docs-site")).toMatchObject({
        id: "docs-site",
        tracker: { projectSlug: "DOCS" },
      });
      expect(lastConfig.projectContexts.byId.get("ops-portal")).toMatchObject({
        id: "ops-portal",
        tracker: { projectSlug: "OPS" },
      });
      expect(lastConfig.projectContexts.byId.get("status-board")).toMatchObject({
        id: "status-board",
        tracker: { projectSlug: "STATUS" },
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(averageMs).toBeLessThan(20);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("project context redaction", () => {
  it("summarizes configured project contexts without leaking secret values", () => {
    const config = parseServiceConfig(
      multiProjectWorkflowConfig({
        topLevel: {
          github: { token: "$ROOT_GITHUB_TOKEN" },
        },
        projectContexts: [
          projectContextFixture({ id: "symphony", label: "Symphony", projectSlug: "SYMPHONY", repository: "." }),
          projectContextFixture({
            id: "docs",
            label: "Documentation Site",
            projectSlug: "DOCS",
            repository: "$DOCS_REPOSITORY",
            github: { token: "$DOCS_GITHUB_TOKEN" },
          }),
        ],
      }),
      "/repo/WORKFLOW.md",
      {
        LINEAR_API_KEY: "linear-secret",
        ROOT_GITHUB_TOKEN: "root-gh-secret",
        DOCS_GITHUB_TOKEN: "docs-gh-secret",
        DOCS_REPOSITORY: "https://x-access-token:repo-secret@example.com/org/docs.git",
      },
    );

    const metadata = config.projectContexts.contexts.map((context) => ({
      id: context.id,
      label: context.label,
      enabled: context.enabled,
      tracker: {
        projectSlug: context.tracker.projectSlug,
        apiKeyPresent: context.tracker.apiKey !== "",
      },
      workspace: {
        source: {
          kind: context.workspace.source.kind,
          pathConfigured: context.workspace.source.path != null,
          repositoryConfigured: context.workspace.source.repository != null,
          refConfigured: context.workspace.source.ref != null,
          baseRefConfigured: context.workspace.source.baseRef != null,
          branchTemplateConfigured: context.workspace.source.branchTemplate != null,
          cachePathConfigured: context.workspace.source.cachePath != null,
          cleanup: context.workspace.source.cleanup,
        },
      },
      github: { tokenPresent: context.github.token !== null },
    }));
    const serialized = JSON.stringify(metadata);

    expect(config.projectContexts.defaultContextId).toBe("symphony");
    expect(metadata.map((context) => context.id)).toEqual(["symphony", "docs"]);
    expect(metadata[0]).toMatchObject({
      id: "symphony",
      label: "Symphony",
      tracker: { projectSlug: "SYMPHONY", apiKeyPresent: true },
      github: { tokenPresent: true },
    });
    expect(metadata[1]).toMatchObject({
      id: "docs",
      label: "Documentation Site",
      workspace: {
        source: {
          kind: "git_worktree",
          pathConfigured: false,
          repositoryConfigured: true,
          refConfigured: false,
          baseRefConfigured: true,
          branchTemplateConfigured: true,
          cachePathConfigured: false,
          cleanup: "refuse_dirty",
        },
      },
      github: { tokenPresent: true },
    });
    expect(serialized).not.toContain("linear-secret");
    expect(serialized).not.toContain("root-gh-secret");
    expect(serialized).not.toContain("docs-gh-secret");
    expect(serialized).not.toContain("repo-secret");
    expect(serialized).not.toContain("x-access-token");
    expect(serialized).not.toContain("https://x-access-token:repo-secret@example.com/org/docs.git");
  });

  it.each([
    {
      label: "missing project slug",
      rawConfig: {
        tracker: { kind: "linear" },
        workspace: {
          source: {
            kind: "git_worktree",
            repository: ".",
            base_ref: "origin/main",
          },
        },
        project_contexts: [
          {
            id: "Docs Site",
            tracker: { api_key: "$DOCS_LINEAR_API_KEY" },
            github: { token: "$DOCS_GITHUB_TOKEN" },
          },
        ],
      },
      env: {
        DOCS_LINEAR_API_KEY: "docs-linear-secret",
        DOCS_GITHUB_TOKEN: "docs-github-secret",
      },
      expectedMessage: 'project_contexts["Docs Site"].tracker.project_slug is required',
      forbiddenSecrets: ["docs-linear-secret", "docs-github-secret"],
    },
    {
      label: "missing workspace source",
      rawConfig: {
        tracker: { kind: "linear" },
        project_contexts: [
          {
            id: "Docs Site",
            tracker: {
              api_key: "$DOCS_LINEAR_API_KEY",
              project_slug: "DOCS",
            },
            github: { token: "$DOCS_GITHUB_TOKEN" },
            workspace: {
              root: "./docs-workspaces",
            },
          },
        ],
      },
      env: {
        DOCS_LINEAR_API_KEY: "docs-linear-secret",
        DOCS_GITHUB_TOKEN: "docs-github-secret",
      },
      expectedMessage: 'project_contexts["Docs Site"].workspace.source is required for enabled project contexts',
      forbiddenSecrets: ["docs-linear-secret", "docs-github-secret"],
    },
  ])("reports $label validation errors without leaking secret values", ({ rawConfig, env, expectedMessage, forbiddenSecrets }) => {
    let thrown: unknown;
    try {
      parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", env);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SymphonyError);
    const message = (thrown as Error).message;
    expect(message).toBe(expectedMessage);
    for (const secret of forbiddenSecrets) {
      expect(message).not.toContain(secret);
    }
  });

  it("allows disabled project contexts to remain incomplete", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear" },
        project_contexts: [
          {
            id: "symphony",
            tracker: {
              api_key: "$SYMPHONY_LINEAR_API_KEY",
              project_slug: "SYMPHONY",
            },
            workspace: {
              source: {
                kind: "git_worktree",
                repository: ".",
                base_ref: "origin/main",
              },
            },
          },
          {
            id: "docs",
            enabled: false,
          },
        ],
      },
      "/repo/WORKFLOW.md",
      {
        SYMPHONY_LINEAR_API_KEY: "symphony-linear-secret",
      },
    );

    expect(config.projectContexts.defaultContextId).toBe("symphony");
    expect(config.projectContexts.contexts).toHaveLength(2);
    expect(config.projectContexts.byId.get("docs")).toMatchObject({
      id: "docs",
      enabled: false,
      workspace: { source: { kind: "none" } },
    });
  });

  it.each([
    {
      label: "copy source without path",
      rawConfig: {
        tracker: { kind: "linear" },
        project_contexts: [
          {
            id: "symphony",
            tracker: {
              api_key: "$SYMPHONY_LINEAR_API_KEY",
              project_slug: "SYMPHONY",
            },
            workspace: {
              source: {
                kind: "git_worktree",
                repository: ".",
                base_ref: "origin/main",
              },
            },
          },
          {
            id: "Docs Site",
            tracker: {
              api_key: "$DOCS_LINEAR_API_KEY",
              project_slug: "DOCS",
            },
            workspace: {
              source: {
                kind: "copy",
              },
            },
          },
        ],
      },
      env: {
        SYMPHONY_LINEAR_API_KEY: "symphony-linear-secret",
        DOCS_LINEAR_API_KEY: "docs-linear-secret",
      },
      expectedMessage: 'project_contexts["Docs Site"].workspace.source.path is required for copy',
    },
    {
      label: "git source without repository",
      rawConfig: {
        tracker: { kind: "linear" },
        project_contexts: [
          {
            id: "symphony",
            tracker: {
              api_key: "$SYMPHONY_LINEAR_API_KEY",
              project_slug: "SYMPHONY",
            },
            workspace: {
              source: {
                kind: "git_worktree",
                repository: ".",
                base_ref: "origin/main",
              },
            },
          },
          {
            id: "Docs Site",
            tracker: {
              api_key: "$DOCS_LINEAR_API_KEY",
              project_slug: "DOCS",
            },
            workspace: {
              source: {
                kind: "git",
              },
            },
          },
        ],
      },
      env: {
        SYMPHONY_LINEAR_API_KEY: "symphony-linear-secret",
        DOCS_LINEAR_API_KEY: "docs-linear-secret",
      },
      expectedMessage: 'project_contexts["Docs Site"].workspace.source.repository is required for git',
    },
    {
      label: "git_worktree source with unresolved repository env",
      rawConfig: {
        tracker: { kind: "linear" },
        project_contexts: [
          {
            id: "symphony",
            tracker: {
              api_key: "$SYMPHONY_LINEAR_API_KEY",
              project_slug: "SYMPHONY",
            },
            workspace: {
              source: {
                kind: "git_worktree",
                repository: ".",
                base_ref: "origin/main",
              },
            },
          },
          {
            id: "Docs Site",
            tracker: {
              api_key: "$DOCS_LINEAR_API_KEY",
              project_slug: "DOCS",
            },
            workspace: {
              source: {
                kind: "git_worktree",
                repository: "$DOCS_REPOSITORY",
                base_ref: "$DOCS_BASE_REF",
              },
            },
          },
        ],
      },
      env: {
        SYMPHONY_LINEAR_API_KEY: "symphony-linear-secret",
        DOCS_LINEAR_API_KEY: "docs-linear-secret",
        DOCS_BASE_REF: "origin/main",
      },
      expectedMessage: 'project_contexts["Docs Site"].workspace.source.repository is required for git_worktree',
    },
  ])("rejects enabled project contexts with insufficient $label", ({ rawConfig, env, expectedMessage }) => {
    expect(() => parseServiceConfig(rawConfig, "/repo/WORKFLOW.md", env)).toThrowError(expectedMessage);
  });
});

import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseServiceConfig } from "../src/core/config/Config.js";
import {
  LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
  LEGACY_DEFAULT_PROJECT_CONTEXT_LABEL,
  LEGACY_DEFAULT_PROJECT_CONTEXT_ROUTING_SOURCE,
  buildProjectContextRegistry,
  defaultProjectContextLabel,
  normalizeProjectContextId,
  normalizeProjectContextResolution,
  projectContextMetadataForPublicRead,
  projectContextResolutionFromIssue,
} from "../src/core/config/ProjectContexts.js";
import { multiProjectWorkflowConfig, projectContextFixture } from "./helpers.js";

describe("project context normalization", () => {
  it("normalizes ids, labels, and default routing metadata", () => {
    expect(normalizeProjectContextId(" Docs Site ")).toBe("docs-site");
    expect(defaultProjectContextLabel("docs-site")).toBe("Docs Site");
    expect(
      normalizeProjectContextResolution({
        projectContextId: " Docs Site ",
        linearProjectSlug: "DOCS",
        routingSource: " candidate_poll ",
      }),
    ).toEqual({
      projectContextId: "docs-site",
      projectContextLabel: "Docs Site",
      linearProjectSlug: "DOCS",
      routingSource: "candidate_poll",
    });
    expect(normalizeProjectContextResolution(undefined)).toEqual({
      projectContextId: LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
      projectContextLabel: LEGACY_DEFAULT_PROJECT_CONTEXT_LABEL,
      linearProjectSlug: null,
      routingSource: LEGACY_DEFAULT_PROJECT_CONTEXT_ROUTING_SOURCE,
    });
  });

  it("derives normalized project context metadata from routed issue payloads", () => {
    expect(
      projectContextResolutionFromIssue({
        projectContextId: " Docs Site ",
        projectContextLabel: "Documentation Site",
        linearProjectIdentity: { slug: "DOCS" },
        routingSource: " candidate_poll ",
      }),
    ).toEqual({
      projectContextId: "docs-site",
      projectContextLabel: "Documentation Site",
      linearProjectSlug: "DOCS",
      routingSource: "candidate_poll",
    });
  });

  it("builds registries and prefers the legacy default id when present", () => {
    const registry = buildProjectContextRegistry([
      { id: "docs", enabled: true },
      { id: LEGACY_DEFAULT_PROJECT_CONTEXT_ID, enabled: true },
      { id: "ops", enabled: false },
    ]);

    expect(registry.defaultContextId).toBe(LEGACY_DEFAULT_PROJECT_CONTEXT_ID);
    expect(registry.enabledContexts.map((context) => context.id)).toEqual(["docs", LEGACY_DEFAULT_PROJECT_CONTEXT_ID]);
    expect(registry.byId.get("ops")).toMatchObject({ enabled: false });
  });

  it("exposes public metadata for configured project contexts", () => {
    expect(
      projectContextMetadataForPublicRead({
        id: "docs",
        label: "Documentation Site",
        enabled: true,
        tracker: { projectSlug: "DOCS" },
        workspace: {
          root: "./docs-workspaces",
          source: {
            kind: "git_worktree",
            repository: "../docs-site",
            path: "packages/site",
          },
        },
      }),
    ).toEqual({
      id: "docs",
      label: "Documentation Site",
      enabled: true,
      linearProjectSlug: "DOCS",
      workspaceRoot: "./docs-workspaces",
      workspaceSourceKind: "git_worktree",
      repository: "../docs-site",
      path: "packages/site",
    });
  });

  it("synthesizes a legacy default context when project_contexts is omitted", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        workspace: { root: "./workspaces" },
        polling: { interval_ms: 60_000 },
        agent: { max_concurrent_agents: 2, max_turns: 1 },
      },
      "/repo/WORKFLOW.md",
      { LINEAR_API_KEY: "linear-test-key" },
    );

    expect(config.projectContexts.defaultContextId).toBe(LEGACY_DEFAULT_PROJECT_CONTEXT_ID);
    expect(config.projectContexts.defaultContext).toMatchObject({
      id: LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
      label: LEGACY_DEFAULT_PROJECT_CONTEXT_LABEL,
      tracker: { projectSlug: "TEST" },
      publicMetadata: {
        linearProjectSlug: "TEST",
      },
    });
  });

  it("skips readonly checkout issue-breakdown validation for disabled project contexts", () => {
    const config = parseServiceConfig(
      multiProjectWorkflowConfig({
        projectContexts: [
          projectContextFixture({ id: "symphony", label: "Symphony", projectSlug: "SYMPHONY", repository: "." }),
          projectContextFixture({
            id: "docs",
            label: "Documentation Site",
            enabled: false,
            workspace: { source: null },
            issue_breakdown: { workspace_mode: "readonly_checkout" },
          }),
        ],
      }),
      "/repo/WORKFLOW.md",
      { LINEAR_API_KEY: "linear-test-key" },
    );

    expect(config.projectContexts.byId.get("docs")).toMatchObject({
      enabled: false,
      issueBreakdown: { workspaceMode: "readonly_checkout" },
    });
  });

  it("parses multi-project workflow contexts and projects the default context into legacy fields", () => {
    const config = parseServiceConfig(
      multiProjectWorkflowConfig({
        projectContexts: [
          projectContextFixture({ id: "symphony", label: "Symphony", projectSlug: "SYMPHONY", repository: "." }),
          projectContextFixture({ id: "docs", label: "Documentation Site", projectSlug: "DOCS", repository: "../docs-site" }),
        ],
      }),
      "/repo/WORKFLOW.md",
      { LINEAR_API_KEY: "linear-test-key" },
    );

    expect(config.projectContexts.defaultContextId).toBe("symphony");
    expect(config.projectContexts.contexts.map((context) => context.id)).toEqual(["symphony", "docs"]);
    const docsContext = config.projectContexts.byId.get("docs");
    expect(docsContext).toMatchObject({
      label: "Documentation Site",
      tracker: { projectSlug: "DOCS" },
      publicMetadata: {
        linearProjectSlug: "DOCS",
      },
    });
    expect(docsContext?.publicMetadata.repository).toMatch(/docs-site$/i);
    expect(config.tracker.projectSlug).toBe("SYMPHONY");
    expect(config.workspace.source?.repository).toMatch(/repo$/i);
  });

  it("merges top-level project defaults into explicit contexts before applying context overrides", () => {
    const config = parseServiceConfig(
      multiProjectWorkflowConfig({
        topLevel: {
          workspace: {
            root: "./global-workspaces",
            state_dir: "./global-state",
            source: {
              kind: "git_worktree",
              repository: "$DEFAULT_REPOSITORY",
              base_ref: "$DEFAULT_BASE_REF",
              branch_template: "$DEFAULT_BRANCH_TEMPLATE",
              cache_path: "$DEFAULT_CACHE_PATH",
              cleanup: "force",
            },
          },
          github: {
            owner: "top-owner",
            repo: "top-repo",
            head_owner: "top-head",
            api_base_url: "https://example.invalid/api",
            app: {
              app_id: "123",
              installation_id: "456",
              private_key_path: "./keys/root.pem",
            },
            operator_approval: {
              reject_policy: "fail",
              poll_interval_ms: 1234,
            },
          },
          review_loop: {
            reviewer_prompt_extensions: ["top-reviewer"],
            max_incomplete_turns: 5,
          },
          issue_breakdown: {
            enabled: true,
            planning_labels: ["global-planning"],
            apply_to_linear: {
              enabled: true,
            },
            workspace_mode: "none",
          },
          agent: {
            harness: "hermes",
            max_turns: 7,
            max_concurrent_agents_by_state: {
              Todo: 2,
            },
            protected_paths: ["global/**"],
          },
        },
        projectContexts: [
          projectContextFixture({ id: "symphony", label: "Symphony", projectSlug: "SYMPHONY", repository: "." }),
          projectContextFixture({
            id: "docs",
            label: "Documentation Site",
            projectSlug: "DOCS",
            workspaceRoot: "./docs-workspaces",
            stateDir: "./docs-state",
            repository: null,
            baseRef: null,
            branchTemplate: null,
            workspace: {
              source: {
                repository: "../docs-site",
                branch_template: "$DOCS_BRANCH_TEMPLATE",
              },
            },
            github: {
              repo: "docs-site",
              operator_approval: {
                required_for_publication: true,
              },
            },
            review_loop: {
              worker_prompt_extensions: ["docs-worker"],
            },
            issue_breakdown: {
              apply_to_linear: {
                enabled: false,
              },
              planning_labels: ["docs-planning"],
            },
            agent: {
              max_turns: 3,
              max_concurrent_agents_by_state: {
                Review: 1,
              },
              protected_paths: ["docs/**"],
            },
          }),
        ],
      }),
      "/repo/WORKFLOW.md",
      {
        LINEAR_API_KEY: "linear-test-key",
        DEFAULT_REPOSITORY: ".",
        DEFAULT_BASE_REF: "origin/release",
        DEFAULT_BRANCH_TEMPLATE: "global/{{ issue.identifier }}",
        DEFAULT_CACHE_PATH: "./cache/shared",
        DOCS_BRANCH_TEMPLATE: "docs/{{ issue.identifier }}",
      },
    );

    const docsContext = config.projectContexts.byId.get("docs");
    expect(docsContext).toMatchObject({
      workspace: {
        root: path.resolve("/repo", "./docs-workspaces"),
        stateDir: path.resolve("/repo", "./docs-workspaces", "./docs-state"),
        source: {
          kind: "git_worktree",
          repository: path.resolve("/repo", "../docs-site"),
          baseRef: "origin/release",
          branchTemplate: "docs/{{ issue.identifier }}",
          cachePath: path.resolve("/repo", "./cache/shared"),
        },
      },
      github: {
        owner: "top-owner",
        repo: "docs-site",
        headOwner: "top-head",
        apiBaseUrl: "https://example.invalid/api",
        operatorApproval: {
          requiredForPublication: true,
          rejectPolicy: "fail",
          pollIntervalMs: 1234,
        },
        app: {
          appId: "123",
          installationId: "456",
          privateKeyPath: path.resolve("/repo", "./keys/root.pem"),
        },
      },
      reviewLoop: {
        reviewerPromptExtensions: ["top-reviewer"],
        workerPromptExtensions: ["docs-worker"],
        maxIncompleteTurns: 5,
      },
      issueBreakdown: {
        enabled: true,
        planningLabels: ["docs-planning"],
        applyToLinear: {
          enabled: false,
          mode: "child_issues",
        },
        workspaceMode: "none",
      },
      agent: {
        harness: "hermes",
        maxTurns: 3,
        protectedPaths: ["docs/**"],
      },
    });
    expect(docsContext?.workspace.source.cleanup).toBe("refuse_dirty");
    expect(docsContext?.agent.maxConcurrentAgentsByState).toEqual(
      new Map([
        ["todo", 2],
        ["review", 1],
      ]),
    );
  });

  it("drops inherited git_worktree workspace.source fields when explicit contexts switch source kinds", () => {
    const config = parseServiceConfig(
      multiProjectWorkflowConfig({
        topLevel: {
          workspace: {
            source: {
              kind: "git_worktree",
              repository: ".",
              base_ref: "origin/release",
              branch_template: "global/{{ issue.identifier }}",
              cache_path: "./cache/shared",
              cleanup: "force",
            },
          },
        },
        projectContexts: [
          projectContextFixture({ id: "symphony", label: "Symphony", projectSlug: "SYMPHONY", repository: "." }),
          projectContextFixture({
            id: "docs-copy",
            label: "Docs Copy",
            projectSlug: "DOCS_COPY",
            repository: null,
            baseRef: null,
            branchTemplate: null,
            workspace: {
              source: {
                kind: "copy",
                path: "./docs-src",
              },
            },
          }),
          projectContextFixture({
            id: "docs-git",
            label: "Docs Git",
            projectSlug: "DOCS_GIT",
            repository: null,
            baseRef: null,
            branchTemplate: null,
            workspace: {
              source: {
                kind: "git",
                repository: "../docs-repo",
                ref: "feature/docs",
              },
            },
          }),
        ],
      }),
      "/repo/WORKFLOW.md",
      { LINEAR_API_KEY: "linear-test-key" },
    );

    const copyContext = config.projectContexts.byId.get("docs-copy");
    const gitContext = config.projectContexts.byId.get("docs-git");

    expect(copyContext?.workspace.source).toEqual({
      kind: "copy",
      path: path.resolve("/repo", "./docs-src"),
      cleanup: "refuse_dirty",
    });
    expect(copyContext?.publicMetadata).toEqual({
      id: "docs-copy",
      label: "Docs Copy",
      enabled: true,
      linearProjectSlug: "DOCS_COPY",
      workspaceRoot: path.resolve("/repo", "./symphony_workspaces"),
      workspaceSourceKind: "copy",
      repository: null,
      path: path.resolve("/repo", "./docs-src"),
    });

    expect(gitContext?.workspace.source).toEqual({
      kind: "git",
      repository: path.resolve("/repo", "../docs-repo"),
      ref: "feature/docs",
      cleanup: "refuse_dirty",
    });
    expect(gitContext?.publicMetadata).toEqual({
      id: "docs-git",
      label: "Docs Git",
      enabled: true,
      linearProjectSlug: "DOCS_GIT",
      workspaceRoot: path.resolve("/repo", "./symphony_workspaces"),
      workspaceSourceKind: "git",
      repository: path.resolve("/repo", "../docs-repo"),
      path: null,
    });
  });

  it("projects default-context credential profiles into the legacy service credential registry", () => {
    const config = parseServiceConfig(
      multiProjectWorkflowConfig({
        projectContexts: [
          projectContextFixture({
            id: "symphony",
            label: "Symphony",
            projectSlug: "SYMPHONY",
            repository: ".",
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
      }),
      "/repo/WORKFLOW.md",
      {
        LINEAR_API_KEY: "linear-test-key",
        GITHUB_PUBLICATION_TOKEN: "publication-secret",
        GITHUB_FEEDBACK_TOKEN: "feedback-secret",
      },
    );

    expect(config.credentialProfiles.assignmentRolesFor("github.publication")).toEqual(["service"]);
    expect(config.credentialProfiles.assignmentRolesFor("github.review_feedback_write")).toEqual(["reviewer"]);
    expect(config.credentialProfiles.resolveForRole("service", "github.publication")).toMatchObject({
      source: "profile",
      profileName: "publication",
      value: "publication-secret",
    });
    expect(config.credentialProfiles.resolveForRole("reviewer", "github.review_feedback_write")).toMatchObject({
      source: "profile",
      profileName: "feedback",
      value: "feedback-secret",
    });
  });
});

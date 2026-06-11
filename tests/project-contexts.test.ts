import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseServiceConfig, type RawProjectContextConfig } from "../src/core/config/Config.js";
import {
  LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
  LEGACY_DEFAULT_PROJECT_CONTEXT_LABEL,
  LEGACY_DEFAULT_PROJECT_CONTEXT_ROUTING_SOURCE,
  buildProjectContextRegistry,
  defaultProjectContextLabel,
  normalizeLegacyDefaultProjectContext,
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

  it.each(["!!!", " --- ", "___", "   "])(
    "rejects direct context ids without letters or numbers after normalization for %j",
    (rawId) => {
      expect(() => normalizeProjectContextId(rawId)).toThrowError(
        "Project context id must contain at least one letter or number after normalization",
      );
    },
  );

  it.each(["!!!", " --- ", "___"])(
    "rejects routed project context ids that normalize to an empty identifier for %j",
    (rawId) => {
      expect(() =>
        normalizeProjectContextResolution({
          projectContextId: rawId,
        }),
      ).toThrowError("Project context id must contain at least one letter or number after normalization");
      expect(() =>
        projectContextResolutionFromIssue({
          projectContextId: rawId,
          routingSource: "candidate_poll",
        }),
      ).toThrowError("Project context id must contain at least one letter or number after normalization");
    },
  );

  it("rejects whitespace-only explicit routed project context ids even when other routed metadata is present", () => {
    const routedResolution = {
      projectContextId: "   ",
      projectContextLabel: "Documentation Site",
      linearProjectSlug: "DOCS",
      routingSource: "candidate_poll",
    };

    expect(() => normalizeProjectContextResolution(routedResolution)).toThrowError(
      "Project context id must contain at least one letter or number after normalization",
    );
    expect(() => projectContextResolutionFromIssue(routedResolution)).toThrowError(
      "Project context id must contain at least one letter or number after normalization",
    );
    expect(() =>
      projectContextResolutionFromIssue({
        projectContext: routedResolution,
      }),
    ).toThrowError("Project context id must contain at least one letter or number after normalization");
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

  it("normalizes legacy top-level config into an explicit default project context", () => {
    expect(
      normalizeLegacyDefaultProjectContext({
        tracker: { kind: "linear", project_slug: "TEST" },
        workspace: { root: "./workspaces" },
        github: { owner: "acme", repo: "symphony" },
        review_loop: { review_states: ["In Review"] },
      }),
    ).toEqual({
      id: LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
      label: LEGACY_DEFAULT_PROJECT_CONTEXT_LABEL,
      enabled: true,
      tracker: { kind: "linear", project_slug: "TEST" },
      workspace: { root: "./workspaces" },
      github: { owner: "acme", repo: "symphony" },
      review_loop: { review_states: ["In Review"] },
    });
  });

  it("synthesizes a legacy default context when project_contexts is omitted", () => {
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

    expect(config.projectContexts.defaultContextId).toBe(LEGACY_DEFAULT_PROJECT_CONTEXT_ID);
    expect(config.projectContexts.defaultContext).toMatchObject({
      id: LEGACY_DEFAULT_PROJECT_CONTEXT_ID,
      label: LEGACY_DEFAULT_PROJECT_CONTEXT_LABEL,
      source: "legacy_default",
      tracker: { projectSlug: "TEST" },
      github: { owner: "acme", repo: "symphony", token: "github-test-token" },
      reviewLoop: { reviewStates: ["In Review"], maxReviewRounds: 5 },
      publicMetadata: {
        linearProjectSlug: "TEST",
      },
    });
    expect(config.github).toMatchObject({ owner: "acme", repo: "symphony", token: "github-test-token" });
    expect(config.reviewLoop).toMatchObject({ reviewStates: ["In Review"], maxReviewRounds: 5 });
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
        topLevel: {
          tracker: { project_slug: "LEGACY" },
          workspace: {
            root: "./legacy-workspaces",
            source: {
              repository: "../legacy-repo",
              base_ref: "origin/release",
              branch_template: "legacy/{{ issue.identifier }}",
            },
          },
          github: {
            owner: "legacy-owner",
            repo: "legacy-repo",
            api_base_url: "https://api.github.legacy.test",
          },
          review_loop: {
            review_states: ["Legacy Review"],
            review_pass_state: "Legacy Ready",
          },
          issue_breakdown: {
            planning_labels: ["legacy-plan"],
            workspace_mode: "none",
          },
        },
        projectContexts: [
          projectContextFixture({
            id: "symphony",
            label: "Symphony",
            projectSlug: "SYMPHONY",
            workspaceRoot: "./symphony-workspaces",
            repository: ".",
            github: {
              owner: "context-owner",
              repo: "context-repo",
              api_base_url: "https://api.github.context.test",
            },
            review_loop: {
              review_states: ["Context Review"],
              review_pass_state: "Context Ready",
            },
            issue_breakdown: {
              planning_labels: ["context-plan"],
              workspace_mode: "none",
            },
          }),
          projectContextFixture({
            id: "docs",
            label: "Documentation Site",
            projectSlug: "DOCS",
            repository: "../docs-site",
            github: {
              owner: "docs-owner",
              repo: "docs-repo",
              api_base_url: "https://api.github.docs.test",
            },
            review_loop: {
              review_states: ["Docs Review"],
              review_pass_state: "Docs Ready",
            },
            issue_breakdown: {
              planning_labels: ["docs-plan"],
              workspace_mode: "none",
            },
          }),
        ],
      }),
      "/repo/WORKFLOW.md",
      { LINEAR_API_KEY: "linear-test-key" },
    );

    expect(config.projectContexts.defaultContextId).toBe("symphony");
    expect(config.projectContexts.contexts.map((context) => context.id)).toEqual(["symphony", "docs"]);

    const defaultContext = config.projectContexts.defaultContext;
    const docsContext = config.projectContexts.byId.get("docs");

    expect(defaultContext).toMatchObject({
      tracker: { projectSlug: "SYMPHONY" },
      github: {
        owner: "context-owner",
        repo: "context-repo",
        apiBaseUrl: "https://api.github.context.test",
      },
      reviewLoop: {
        reviewStates: ["Context Review"],
        reviewPassState: "Context Ready",
      },
      issueBreakdown: {
        planningLabels: ["context-plan"],
        workspaceMode: "none",
      },
    });

    expect(docsContext).toMatchObject({
      label: "Documentation Site",
      source: "explicit",
      tracker: { projectSlug: "DOCS" },
      github: {
        owner: "docs-owner",
        repo: "docs-repo",
        apiBaseUrl: "https://api.github.docs.test",
      },
      reviewLoop: {
        reviewStates: ["Docs Review"],
        reviewPassState: "Docs Ready",
      },
      issueBreakdown: {
        planningLabels: ["docs-plan"],
        workspaceMode: "none",
      },
      publicMetadata: {
        linearProjectSlug: "DOCS",
      },
    });

    expect(docsContext?.publicMetadata.repository).toMatch(/docs-site$/i);
    expect(config.tracker).toEqual(defaultContext.tracker);
    expect(config.workspace).toEqual(defaultContext.workspace);
    expect(config.github).toEqual(defaultContext.github);
    expect(config.reviewLoop).toEqual(defaultContext.reviewLoop);
    expect(config.issueBreakdown).toEqual(defaultContext.issueBreakdown);
    expect(config.tracker.projectSlug).toBe("SYMPHONY");
    expect(config.workspace.source?.repository).toMatch(/repo$/i);
    expect(config.workspace.source?.repository).not.toMatch(/legacy-repo$/i);
    expect(config.github.owner).toBe("context-owner");
    expect(config.github.repo).toBe("context-repo");
    expect(config.github.apiBaseUrl).toBe("https://api.github.context.test");
    expect(config.reviewLoop.reviewStates).toEqual(["Context Review"]);
    expect(config.reviewLoop.reviewPassState).toBe("Context Ready");
    expect(config.issueBreakdown.planningLabels).toEqual(["context-plan"]);
    expect(config.issueBreakdown.workspaceMode).toBe("none");
  });

  it("keeps raw project_contexts alongside the normalized project context registry", () => {
    const config = parseServiceConfig(
      multiProjectWorkflowConfig({
        projectContexts: [
          projectContextFixture({
            id: " Docs Site ",
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
      { LINEAR_API_KEY: "linear-test-key" },
    );

    const rawContexts = config.raw.project_contexts;
    expect(rawContexts).toHaveLength(2);

    const rawDefaultContext: RawProjectContextConfig = rawContexts![0]!;
    expect(rawDefaultContext.id).toBe(" Docs Site ");
    expect(rawDefaultContext.workspace?.source?.repository).toBe("../docs-site");

    expect(config.projectContexts.defaultContextId).toBe("docs-site");
    expect(config.projectContexts.defaultContext.id).toBe("docs-site");
    expect(config.projectContexts.byId.get("docs-site")).toMatchObject({
      label: "Documentation Site",
      tracker: { projectSlug: "DOCS" },
      workspace: { source: { repository: expect.stringMatching(/docs-site$/i) } },
    });
    expect(config.projectContexts.byId.get("ops-portal")).toMatchObject({
      label: "Ops Portal",
      tracker: { projectSlug: "OPS" },
      workspace: { source: { repository: expect.stringMatching(/ops-portal$/i) } },
    });
  });

  it("keeps raw project_contexts alongside the normalized project context registry", () => {
    const config = parseServiceConfig(
      multiProjectWorkflowConfig({
        projectContexts: [
          projectContextFixture({
            id: " Docs Site ",
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
      { LINEAR_API_KEY: "linear-test-key" },
    );

    const rawContexts = config.raw.project_contexts;
    expect(rawContexts).toHaveLength(2);

    const rawDefaultContext: RawProjectContextConfig = rawContexts![0]!;
    expect(rawDefaultContext.id).toBe(" Docs Site ");
    expect(rawDefaultContext.workspace?.source?.repository).toBe("../docs-site");

    expect(config.projectContexts.defaultContextId).toBe("docs-site");
    expect(config.projectContexts.defaultContext.id).toBe("docs-site");
    expect(config.projectContexts.byId.get("docs-site")).toMatchObject({
      label: "Documentation Site",
      tracker: { projectSlug: "DOCS" },
      workspace: { source: { repository: expect.stringMatching(/docs-site$/i) } },
    });
    expect(config.projectContexts.byId.get("ops-portal")).toMatchObject({
      label: "Ops Portal",
      tracker: { projectSlug: "OPS" },
      workspace: { source: { repository: expect.stringMatching(/ops-portal$/i) } },
    });
  });

  it("keeps raw project_contexts alongside the normalized project context registry", () => {
    const config = parseServiceConfig(
      multiProjectWorkflowConfig({
        projectContexts: [
          projectContextFixture({
            id: " Docs Site ",
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
      { LINEAR_API_KEY: "linear-test-key" },
    );

    const rawContexts = config.raw.project_contexts;
    expect(rawContexts).toHaveLength(2);

    const rawDefaultContext: RawProjectContextConfig = rawContexts![0]!;
    expect(rawDefaultContext.id).toBe(" Docs Site ");
    expect(rawDefaultContext.workspace?.source?.repository).toBe("../docs-site");

    expect(config.projectContexts.defaultContextId).toBe("docs-site");
    expect(config.projectContexts.defaultContext.id).toBe("docs-site");
    expect(config.projectContexts.byId.get("docs-site")).toMatchObject({
      label: "Documentation Site",
      tracker: { projectSlug: "DOCS" },
      workspace: { source: { repository: expect.stringMatching(/docs-site$/i) } },
    });
    expect(config.projectContexts.byId.get("ops-portal")).toMatchObject({
      label: "Ops Portal",
      tracker: { projectSlug: "OPS" },
      workspace: { source: { repository: expect.stringMatching(/ops-portal$/i) } },
    });
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
              path: "$DEFAULT_SOURCE_PATH",
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
                path: "$DOCS_SOURCE_PATH",
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
        DEFAULT_SOURCE_PATH: "./default-source",
        DEFAULT_REPOSITORY: ".",
        DEFAULT_BASE_REF: "origin/release",
        DEFAULT_BRANCH_TEMPLATE: "global/{{ issue.identifier }}",
        DEFAULT_CACHE_PATH: "./cache/shared",
        DOCS_SOURCE_PATH: "./docs-source",
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
          path: path.resolve("/repo", "./docs-source"),
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
    expect(docsContext?.publicMetadata.path).toBe(path.resolve("/repo", "./docs-source"));
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

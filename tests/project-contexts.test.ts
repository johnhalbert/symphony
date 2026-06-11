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

  it("omits credential-bearing values from public metadata helpers", () => {
    const secretBearingContext = {
      id: "docs",
      label: "Documentation Site",
      enabled: true,
      tracker: {
        projectSlug: "DOCS",
        api_key: "linear-secret",
      },
      workspace: {
        root: "./docs-workspaces",
        credential_profiles: { publication: "github-secret" },
        source: {
          kind: "git_worktree",
          repository: "../docs-site",
          path: "packages/site",
          private_key: "ssh-private-key",
        },
      },
      github: {
        token: "github-secret",
      },
    };

    const metadata = projectContextMetadataForPublicRead(secretBearingContext);

    expect(metadata).toEqual({
      id: "docs",
      label: "Documentation Site",
      enabled: true,
      linearProjectSlug: "DOCS",
      workspaceRoot: "./docs-workspaces",
      workspaceSourceKind: "git_worktree",
      repository: "../docs-site",
      path: "packages/site",
    });
    expect(Object.keys(metadata).sort()).toEqual([
      "enabled",
      "id",
      "label",
      "linearProjectSlug",
      "path",
      "repository",
      "workspaceRoot",
      "workspaceSourceKind",
    ]);
    expect(metadata).not.toHaveProperty("api_key");
    expect(metadata).not.toHaveProperty("credential_profiles");
    expect(metadata).not.toHaveProperty("token");
    expect(JSON.stringify(metadata)).not.toContain("linear-secret");
    expect(JSON.stringify(metadata)).not.toContain("github-secret");
    expect(JSON.stringify(metadata)).not.toContain("ssh-private-key");
  });

  it("keeps resolved credential values out of normalized public metadata", () => {
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
        ],
      }),
      "/repo/WORKFLOW.md",
      {
        LINEAR_API_KEY: "linear-test-key",
        GITHUB_PUBLICATION_TOKEN: "publication-secret",
        GITHUB_FEEDBACK_TOKEN: "feedback-secret",
      },
    );

    const publicMetadata = config.projectContexts.defaultContext.publicMetadata;
    expect(publicMetadata).toMatchObject({
      id: "symphony",
      label: "Symphony",
      enabled: true,
      linearProjectSlug: "SYMPHONY",
      workspaceSourceKind: "git_worktree",
      path: null,
    });
    expect(publicMetadata.repository).toMatch(/repo$/i);
    expect(publicMetadata.workspaceRoot).toMatch(/symphony_workspaces$/i);
    expect(Object.keys(publicMetadata).sort()).toEqual([
      "enabled",
      "id",
      "label",
      "linearProjectSlug",
      "path",
      "repository",
      "workspaceRoot",
      "workspaceSourceKind",
    ]);
    expect(publicMetadata).not.toHaveProperty("credentialProfiles");
    expect(publicMetadata).not.toHaveProperty("token");
    expect(JSON.stringify(publicMetadata)).not.toContain("linear-test-key");
    expect(JSON.stringify(publicMetadata)).not.toContain("publication-secret");
    expect(JSON.stringify(publicMetadata)).not.toContain("feedback-secret");
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

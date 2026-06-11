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

  it("merges default and project-context credential profile registries per context", () => {
    const config = parseServiceConfig(
      multiProjectWorkflowConfig({
        topLevel: {
          credential_profiles: {
            profiles: {
              publication: { value: "$DEFAULT_PUBLICATION_TOKEN", capabilities: ["github.publication"] },
              tracker: { value: "$DEFAULT_TRACKER_TOKEN", capabilities: ["linear.tracker"] },
            },
            roles: {
              service: { "github.publication": "publication" },
              worker: { "linear.tracker": "tracker" },
            },
          },
        },
        projectContexts: [
          projectContextFixture({ id: "symphony", label: "Symphony", projectSlug: "SYMPHONY", repository: "." }),
          projectContextFixture({
            id: "docs",
            label: "Documentation Site",
            projectSlug: "DOCS",
            repository: "../docs-site",
            credential_profiles: {
              profiles: {
                publication: { value: "$DOCS_PUBLICATION_TOKEN", capabilities: ["github.publication"] },
              },
              roles: {
                service: { "github.publication": "publication" },
              },
            },
          }),
        ],
      }),
      "/repo/WORKFLOW.md",
      {
        LINEAR_API_KEY: "legacy-linear-secret",
        DEFAULT_PUBLICATION_TOKEN: "default-publication-secret",
        DEFAULT_TRACKER_TOKEN: "default-tracker-secret",
        DOCS_PUBLICATION_TOKEN: "docs-publication-secret",
      },
    );

    expect(config.credentialProfiles.resolveForRole("service", "github.publication")).toMatchObject({
      value: "default-publication-secret",
      profileName: "publication",
    });
    expect(config.credentialProfileRegistries.get("docs")?.resolveForRole("service", "github.publication")).toMatchObject({
      value: "docs-publication-secret",
      profileName: "publication",
    });
    expect(config.credentialProfileRegistries.get("docs")?.resolveForRole("worker", "linear.tracker")).toMatchObject({
      value: "default-tracker-secret",
      profileName: "tracker",
    });
  });

  it("inherits unspecified github_app profile fields from the default context when a project context overrides the same profile name", () => {
    const config = parseServiceConfig(
      multiProjectWorkflowConfig({
        topLevel: {
          credential_profiles: {
            profiles: {
              publication: {
                kind: "github_app",
                app_id: "$DEFAULT_PUBLICATION_APP_ID",
                client_id: "$DEFAULT_PUBLICATION_APP_CLIENT_ID",
                installation_id: "$DEFAULT_PUBLICATION_APP_INSTALLATION_ID",
                private_key_path: "$DEFAULT_PUBLICATION_APP_PRIVATE_KEY_PATH",
                token_refresh_buffer_seconds: 123,
                capabilities: ["github.publication"],
              },
            },
            roles: {
              service: { "github.publication": "publication" },
            },
          },
        },
        projectContexts: [
          projectContextFixture({ id: "symphony", label: "Symphony", projectSlug: "SYMPHONY", repository: "." }),
          projectContextFixture({
            id: "docs",
            label: "Documentation Site",
            projectSlug: "DOCS",
            repository: "../docs-site",
            credential_profiles: {
              profiles: {
                publication: {
                  kind: "github_app",
                  installation_id: "$DOCS_PUBLICATION_APP_INSTALLATION_ID",
                  capabilities: ["github.publication"],
                },
              },
              roles: {
                service: { "github.publication": "publication" },
              },
            },
          }),
        ],
      }),
      "/repo/WORKFLOW.md",
      {
        LINEAR_API_KEY: "legacy-linear-secret",
        DEFAULT_PUBLICATION_APP_ID: "111",
        DEFAULT_PUBLICATION_APP_CLIENT_ID: "Iv1.default-publication",
        DEFAULT_PUBLICATION_APP_INSTALLATION_ID: "222",
        DEFAULT_PUBLICATION_APP_PRIVATE_KEY_PATH: "/secrets/default-publication.pem",
        DOCS_PUBLICATION_APP_INSTALLATION_ID: "333",
      },
    );

    expect(config.credentialProfileRegistries.get("docs")?.resolveForRole("service", "github.publication")).toMatchObject({
      kind: "github_app",
      profileName: "publication",
      app: {
        appId: "111",
        clientId: "Iv1.default-publication",
        installationId: "333",
        privateKeyPath: expect.stringContaining("default-publication.pem"),
        tokenRefreshBufferSeconds: 123,
      },
    });
  });

  it("allows project contexts to clear inherited credential assignments and profile definitions", () => {
    const config = parseServiceConfig(
      multiProjectWorkflowConfig({
        topLevel: {
          github: { owner: "acme", repo: "symphony", token: "$DEFAULT_GITHUB_TOKEN" },
          tracker: { kind: "linear", api_key: "$DEFAULT_LINEAR_TOKEN", project_slug: "SYMPHONY" },
          credential_profiles: {
            profiles: {
              publication: { value: "$DEFAULT_PUBLICATION_TOKEN", capabilities: ["github.publication"] },
              tracker: { value: "$DEFAULT_TRACKER_TOKEN", capabilities: ["linear.tracker"] },
              writeback: { value: "$DEFAULT_WRITEBACK_TOKEN", capabilities: ["linear.writeback"] },
            },
            roles: {
              service: { "github.publication": "publication", "linear.writeback": "writeback" },
              worker: { "linear.tracker": "tracker" },
            },
          },
        },
        projectContexts: [
          projectContextFixture({ id: "symphony", label: "Symphony", projectSlug: "SYMPHONY", repository: "." }),
          projectContextFixture({
            id: "docs",
            label: "Documentation Site",
            projectSlug: "DOCS",
            repository: "../docs-site",
            github: { owner: "acme", repo: "docs-site", token: "$DOCS_GITHUB_TOKEN" },
            tracker: { api_key: "$DOCS_LINEAR_TOKEN", project_slug: "DOCS" },
            credential_profiles: {
              profiles: {
                publication: null,
                writeback: null,
              },
              roles: {
                service: {},
              },
            },
          }),
        ],
      }),
      "/repo/WORKFLOW.md",
      {
        LINEAR_API_KEY: "legacy-linear-secret",
        DEFAULT_GITHUB_TOKEN: "default-github-secret",
        DEFAULT_LINEAR_TOKEN: "default-linear-secret",
        DEFAULT_PUBLICATION_TOKEN: "default-publication-secret",
        DEFAULT_TRACKER_TOKEN: "default-tracker-secret",
        DEFAULT_WRITEBACK_TOKEN: "default-writeback-secret",
        DOCS_GITHUB_TOKEN: "docs-github-secret",
        DOCS_LINEAR_TOKEN: "docs-linear-secret",
      },
    );

    const docsRegistry = config.credentialProfileRegistries.get("docs");
    expect(config.credentialProfiles.resolveForRole("service", "github.publication")).toMatchObject({
      source: "profile",
      profileName: "publication",
      value: "default-publication-secret",
    });
    expect(docsRegistry?.assignmentRolesFor("github.publication")).toEqual([]);
    expect(docsRegistry?.assignmentRolesFor("linear.writeback")).toEqual([]);
    expect(docsRegistry?.resolveForRole("service", "github.publication")).toMatchObject({
      source: "legacy",
      profileName: null,
      value: "docs-github-secret",
    });
    expect(docsRegistry?.resolveForRole("service", "linear.writeback")).toMatchObject({
      source: "legacy",
      profileName: null,
      value: "docs-linear-secret",
    });
    expect(docsRegistry?.resolveForRole("worker", "linear.tracker")).toMatchObject({
      source: "profile",
      profileName: "tracker",
      value: "default-tracker-secret",
    });
    expect(docsRegistry?.toJSON().profiles).not.toHaveProperty("publication");
    expect(docsRegistry?.toJSON().profiles).not.toHaveProperty("writeback");
  });
});

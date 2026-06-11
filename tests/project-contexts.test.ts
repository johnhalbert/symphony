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

  it("preserves repository URLs without embedded credentials in public metadata", () => {
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
            repository: "https://example.com/acme/docs-site.git",
            path: "packages/site",
          },
        },
      }),
    ).toMatchObject({
      repository: "https://example.com/acme/docs-site.git",
      workspaceSourceKind: "git_worktree",
    });
  });

  it("omits sibling secrets and sanitizes credential-bearing repository values from public metadata helpers", () => {
    const repositoryCases = [
      {
        name: "HTTPS embedded userinfo URL",
        repository: "https://token:secret@example.com/acme/docs-site.git",
        expected: "https://[redacted]@example.com/acme/docs-site.git",
        leakedSubstring: "token:secret@example.com",
      },
      {
        name: "generic FTP embedded userinfo URL",
        repository: "ftp://token:secret@example.com/acme/docs-site.git",
        expected: "ftp://[redacted]@example.com/acme/docs-site.git",
        leakedSubstring: "token:secret@example.com",
      },
      {
        name: "generic custom-scheme embedded userinfo URL",
        repository: "custom://token:secret@example.com/acme/docs-site.git",
        expected: "custom://[redacted]@example.com/acme/docs-site.git",
        leakedSubstring: "token:secret@example.com",
      },
      {
        name: "password containing at-sign in URL userinfo",
        repository: "https://token:pa@ss@example.com/acme/docs-site.git",
        expected: "https://[redacted]@example.com/acme/docs-site.git",
        leakedSubstring: "ss@example.com",
      },
      {
        name: "raw question mark in HTTPS URL userinfo",
        repository: "https://token:pa?ss@example.com/acme/docs-site.git",
        expected: "https://[redacted]@example.com/acme/docs-site.git",
        leakedSubstring: "token:pa",
      },
      {
        name: "raw question mark in generic FTP URL userinfo",
        repository: "ftp://token:pa?ss@example.com/acme/docs-site.git",
        expected: "ftp://[redacted]@example.com/acme/docs-site.git",
        leakedSubstring: "token:pa",
      },
      {
        name: "raw question mark in username-only HTTPS URL userinfo",
        repository: "https://user?name@example.com/acme/docs-site.git",
        expected: "https://[redacted]@example.com/acme/docs-site.git",
        leakedSubstring: "https://user",
      },
      {
        name: "raw question mark in pathless HTTPS URL userinfo",
        repository: "https://token:pa?ss@example.com",
        expected: "https://[redacted]@example.com",
        leakedSubstring: "token:pa",
      },
      {
        name: "raw question mark in pathless generic FTP URL userinfo",
        repository: "ftp://token:pa?ss@example.com",
        expected: "ftp://[redacted]@example.com",
        leakedSubstring: "token:pa",
      },
      {
        name: "raw question mark in pathless username-only HTTPS URL userinfo",
        repository: "https://user?name@example.com",
        expected: "https://[redacted]@example.com",
        leakedSubstring: "https://user",
      },
      {
        name: "raw hash in HTTPS URL userinfo",
        repository: "https://token:pa#ss@example.com/acme/docs-site.git",
        expected: "https://[redacted]@example.com/acme/docs-site.git",
        leakedSubstring: "token:pa",
      },
      {
        name: "raw hash in generic custom-scheme URL userinfo",
        repository: "custom://token:pa#ss@example.com/acme/docs-site.git",
        expected: "custom://[redacted]@example.com/acme/docs-site.git",
        leakedSubstring: "token:pa",
      },
      {
        name: "raw hash in pathless HTTPS URL userinfo",
        repository: "https://token:pa#ss@example.com",
        expected: "https://[redacted]@example.com",
        leakedSubstring: "token:pa",
      },
      {
        name: "raw hash in pathless generic custom-scheme URL userinfo",
        repository: "custom://token:pa#ss@example.com",
        expected: "custom://[redacted]@example.com",
        leakedSubstring: "token:pa",
      },
      {
        name: "pathless host-like query-before-at URL",
        repository: "https://example.com?foo@bar",
        expected: "https://example.com",
        leakedSubstring: "foo@bar",
      },
      {
        name: "pathless single-label host-like query-before-at URL",
        repository: "https://intranet?foo@bar",
        expected: "https://intranet",
        leakedSubstring: "foo@bar",
      },
      {
        name: "pathless single-label host-like fragment-before-at URL",
        repository: "https://intranet#foo@bar",
        expected: "https://intranet",
        leakedSubstring: "foo@bar",
      },
      {
        name: "pathless single-label host-like query-before-at FTP URL",
        repository: "ftp://gitlab?foo@bar",
        expected: "ftp://gitlab",
        leakedSubstring: "foo@bar",
      },
      {
        name: "raw question mark in pathless single-label username-only HTTPS URL userinfo",
        repository: "https://user?name@host",
        expected: "https://[redacted]@host",
        leakedSubstring: "https://user",
      },
      {
        name: "raw hash in pathless single-label username-only HTTPS URL userinfo",
        repository: "https://user#name@host",
        expected: "https://[redacted]@host",
        leakedSubstring: "https://user",
      },
      {
        name: "raw question mark in pathless single-label username-only generic FTP URL userinfo",
        repository: "ftp://user?name@host",
        expected: "ftp://[redacted]@host",
        leakedSubstring: "ftp://user",
      },
      {
        name: "raw hash in pathless single-label username-only generic custom-scheme URL userinfo",
        repository: "custom://user#name@host",
        expected: "custom://[redacted]@host",
        leakedSubstring: "custom://user",
      },
      {
        name: "raw question mark in pathless single-label username-only HTTPS URL userinfo with host port",
        repository: "https://user?name@host:8443",
        expected: "https://[redacted]@host:8443",
        leakedSubstring: "https://user",
      },
      {
        name: "query token URL",
        repository: "https://example.com/acme/docs-site.git?access_token=secret",
        expected: "https://example.com/acme/docs-site.git",
        leakedSubstring: "access_token=secret",
      },
      {
        name: "fragment token URL",
        repository: "https://example.com/acme/docs-site.git#token=secret",
        expected: "https://example.com/acme/docs-site.git",
        leakedSubstring: "token=secret",
      },
      {
        name: "SCP-style remote",
        repository: "secret-user@example.com:acme/docs-site.git",
        expected: "[redacted]@example.com:acme/docs-site.git",
        leakedSubstring: "secret-user@example.com",
      },
      {
        name: "SCP-style remote with whitespace in username",
        repository: "secret user@example.com:acme/docs-site.git",
        expected: "[redacted]@example.com:acme/docs-site.git",
        leakedSubstring: "secret user@example.com",
      },
      {
        name: "SCP-style remote with multiple at-signs in username",
        repository: "secret@user@example.com:acme/docs-site.git",
        expected: "[redacted]@example.com:acme/docs-site.git",
        leakedSubstring: "user@example.com",
      },
      {
        name: "SCP-style remote with query token",
        repository: "secret-user@example.com:acme/docs-site.git?access_token=secret",
        expected: "[redacted]@example.com:acme/docs-site.git",
        leakedSubstring: "access_token=secret",
      },
      {
        name: "SCP-style remote with whitespace username and fragment token",
        repository: "secret user@example.com:acme/docs-site.git#token=secret",
        expected: "[redacted]@example.com:acme/docs-site.git",
        leakedSubstring: "token=secret",
      },
    ] as const;

    for (const repositoryCase of repositoryCases) {
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
            repository: repositoryCase.repository,
            path: "packages/site",
            private_key: "ssh-private-key",
          },
        },
        github: {
          token: "github-secret",
        },
      };
      const metadata = projectContextMetadataForPublicRead(secretBearingContext);

      expect(metadata, repositoryCase.name).toEqual({
        id: "docs",
        label: "Documentation Site",
        enabled: true,
        linearProjectSlug: "DOCS",
        workspaceRoot: "./docs-workspaces",
        workspaceSourceKind: "git_worktree",
        repository: repositoryCase.expected,
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

      const serializedMetadata = JSON.stringify(metadata);
      expect(serializedMetadata).not.toContain("linear-secret");
      expect(serializedMetadata).not.toContain("github-secret");
      expect(serializedMetadata).not.toContain("ssh-private-key");
      expect(serializedMetadata).not.toContain(repositoryCase.leakedSubstring);
    }
  });

  it("keeps resolved credential values out of normalized public metadata", () => {
    const repositoryCases = [
      {
        name: "plain HTTPS repository",
        repository: "https://example.com/acme/symphony.git",
        expected: "https://example.com/acme/symphony.git",
        leakedSubstring: null,
      },
      {
        name: "HTTPS embedded userinfo URL",
        repository: "https://token:secret@example.com/acme/symphony.git",
        expected: "https://[redacted]@example.com/acme/symphony.git",
        leakedSubstring: "token:secret@example.com",
      },
      {
        name: "generic FTP embedded userinfo URL",
        repository: "ftp://token:secret@example.com/acme/symphony.git",
        expected: "ftp://[redacted]@example.com/acme/symphony.git",
        leakedSubstring: "token:secret@example.com",
      },
      {
        name: "generic custom-scheme embedded userinfo URL",
        repository: "custom://token:secret@example.com/acme/symphony.git",
        expected: "custom://[redacted]@example.com/acme/symphony.git",
        leakedSubstring: "token:secret@example.com",
      },
      {
        name: "password containing at-sign in URL userinfo",
        repository: "https://token:pa@ss@example.com/acme/symphony.git",
        expected: "https://[redacted]@example.com/acme/symphony.git",
        leakedSubstring: "ss@example.com",
      },
      {
        name: "raw question mark in HTTPS URL userinfo",
        repository: "https://token:pa?ss@example.com/acme/symphony.git",
        expected: "https://[redacted]@example.com/acme/symphony.git",
        leakedSubstring: "token:pa",
      },
      {
        name: "raw question mark in generic FTP URL userinfo",
        repository: "ftp://token:pa?ss@example.com/acme/symphony.git",
        expected: "ftp://[redacted]@example.com/acme/symphony.git",
        leakedSubstring: "token:pa",
      },
      {
        name: "raw question mark in username-only HTTPS URL userinfo",
        repository: "https://user?name@example.com/acme/symphony.git",
        expected: "https://[redacted]@example.com/acme/symphony.git",
        leakedSubstring: "https://user",
      },
      {
        name: "raw question mark in pathless HTTPS URL userinfo",
        repository: "https://token:pa?ss@example.com",
        expected: "https://[redacted]@example.com",
        leakedSubstring: "token:pa",
      },
      {
        name: "raw question mark in pathless generic FTP URL userinfo",
        repository: "ftp://token:pa?ss@example.com",
        expected: "ftp://[redacted]@example.com",
        leakedSubstring: "token:pa",
      },
      {
        name: "raw question mark in pathless username-only HTTPS URL userinfo",
        repository: "https://user?name@example.com",
        expected: "https://[redacted]@example.com",
        leakedSubstring: "https://user",
      },
      {
        name: "raw hash in HTTPS URL userinfo",
        repository: "https://token:pa#ss@example.com/acme/symphony.git",
        expected: "https://[redacted]@example.com/acme/symphony.git",
        leakedSubstring: "token:pa",
      },
      {
        name: "raw hash in generic custom-scheme URL userinfo",
        repository: "custom://token:pa#ss@example.com/acme/symphony.git",
        expected: "custom://[redacted]@example.com/acme/symphony.git",
        leakedSubstring: "token:pa",
      },
      {
        name: "raw hash in pathless HTTPS URL userinfo",
        repository: "https://token:pa#ss@example.com",
        expected: "https://[redacted]@example.com",
        leakedSubstring: "token:pa",
      },
      {
        name: "raw hash in pathless generic custom-scheme URL userinfo",
        repository: "custom://token:pa#ss@example.com",
        expected: "custom://[redacted]@example.com",
        leakedSubstring: "token:pa",
      },
      {
        name: "pathless host-like query-before-at URL",
        repository: "https://example.com?foo@bar",
        expected: "https://example.com",
        leakedSubstring: "foo@bar",
      },
      {
        name: "pathless single-label host-like query-before-at URL",
        repository: "https://intranet?foo@bar",
        expected: "https://intranet",
        leakedSubstring: "foo@bar",
      },
      {
        name: "pathless single-label host-like fragment-before-at URL",
        repository: "https://intranet#foo@bar",
        expected: "https://intranet",
        leakedSubstring: "foo@bar",
      },
      {
        name: "pathless single-label host-like query-before-at FTP URL",
        repository: "ftp://gitlab?foo@bar",
        expected: "ftp://gitlab",
        leakedSubstring: "foo@bar",
      },
      {
        name: "raw question mark in pathless single-label username-only HTTPS URL userinfo",
        repository: "https://user?name@host",
        expected: "https://[redacted]@host",
        leakedSubstring: "https://user",
      },
      {
        name: "raw hash in pathless single-label username-only HTTPS URL userinfo",
        repository: "https://user#name@host",
        expected: "https://[redacted]@host",
        leakedSubstring: "https://user",
      },
      {
        name: "raw question mark in pathless single-label username-only generic FTP URL userinfo",
        repository: "ftp://user?name@host",
        expected: "ftp://[redacted]@host",
        leakedSubstring: "ftp://user",
      },
      {
        name: "raw hash in pathless single-label username-only generic custom-scheme URL userinfo",
        repository: "custom://user#name@host",
        expected: "custom://[redacted]@host",
        leakedSubstring: "custom://user",
      },
      {
        name: "raw question mark in pathless single-label username-only HTTPS URL userinfo with host port",
        repository: "https://user?name@host:8443",
        expected: "https://[redacted]@host:8443",
        leakedSubstring: "https://user",
      },
      {
        name: "query token URL",
        repository: "https://example.com/acme/symphony.git?access_token=secret",
        expected: "https://example.com/acme/symphony.git",
        leakedSubstring: "access_token=secret",
      },
      {
        name: "fragment token URL",
        repository: "https://example.com/acme/symphony.git#token=secret",
        expected: "https://example.com/acme/symphony.git",
        leakedSubstring: "token=secret",
      },
      {
        name: "SCP-style remote",
        repository: "secret-user@example.com:acme/symphony.git",
        expected: "[redacted]@example.com:acme/symphony.git",
        leakedSubstring: "secret-user@example.com",
      },
      {
        name: "SCP-style remote with whitespace in username",
        repository: "secret user@example.com:acme/symphony.git",
        expected: "[redacted]@example.com:acme/symphony.git",
        leakedSubstring: "secret user@example.com",
      },
      {
        name: "SCP-style remote with multiple at-signs in username",
        repository: "secret@user@example.com:acme/symphony.git",
        expected: "[redacted]@example.com:acme/symphony.git",
        leakedSubstring: "user@example.com",
      },
      {
        name: "SCP-style remote with query token",
        repository: "secret-user@example.com:acme/symphony.git?access_token=secret",
        expected: "[redacted]@example.com:acme/symphony.git",
        leakedSubstring: "access_token=secret",
      },
      {
        name: "SCP-style remote with whitespace username and fragment token",
        repository: "secret user@example.com:acme/symphony.git#token=secret",
        expected: "[redacted]@example.com:acme/symphony.git",
        leakedSubstring: "token=secret",
      },
    ] as const;

    for (const repositoryCase of repositoryCases) {
      const config = parseServiceConfig(
        multiProjectWorkflowConfig({
          projectContexts: [
            projectContextFixture({
              id: "symphony",
              label: "Symphony",
              projectSlug: "SYMPHONY",
              repository: "$REPO_URL",
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
          REPO_URL: repositoryCase.repository,
          GITHUB_PUBLICATION_TOKEN: "publication-secret",
          GITHUB_FEEDBACK_TOKEN: "feedback-secret",
        },
      );

      const context = config.projectContexts.defaultContext;
      const publicMetadata = context.publicMetadata;
      expect(publicMetadata, repositoryCase.name).toMatchObject({
        id: "symphony",
        label: "Symphony",
        enabled: true,
        linearProjectSlug: "SYMPHONY",
        workspaceSourceKind: "git_worktree",
        repository: repositoryCase.expected,
        path: null,
      });
      expect(context.workspace.source.repository, repositoryCase.name).toBe(repositoryCase.repository);
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

      const serializedMetadata = JSON.stringify(publicMetadata);
      expect(serializedMetadata).not.toContain("linear-test-key");
      expect(serializedMetadata).not.toContain("publication-secret");
      expect(serializedMetadata).not.toContain("feedback-secret");
      if (repositoryCase.leakedSubstring !== null) {
        expect(serializedMetadata).not.toContain(repositoryCase.leakedSubstring);
      }
    }
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

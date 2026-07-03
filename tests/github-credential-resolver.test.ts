import { describe, expect, it } from "vitest";
import { parseServiceConfig } from "../src/core/config/Config.js";
import { SymphonyError } from "../src/core/errors.js";
import {
  createGitHubPullRequestClientForCapability,
  createGitHubPullRequestClientForProjectContext,
  type GitHubCredentialCapability,
  resolveGitHubClientConfig,
  resolveGitHubClientConfigForProjectContext,
  resolveGitHubProjectContext,
} from "../src/integrations/github/GitHubCredentialResolver.js";

describe("GitHub credential resolver", () => {
  it("falls back to the legacy GitHub token when no capability profile is assigned", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        github: { owner: "acme", repo: "symphony" },
      },
      "/repo/WORKFLOW.md",
      {
        LINEAR_API_KEY: "linear-secret",
        GITHUB_TOKEN: "legacy-github-secret",
      },
    );

    for (const capability of githubCapabilities()) {
      const resolved = resolveGitHubClientConfig(config, capability);
      expect(resolved.github.token).toBe("legacy-github-secret");
      expect(resolved.credential).toMatchObject({
        role: expectedRole(capability),
        capability,
        source: "legacy",
        profileName: null,
      });
    }
  });

  it("ignores optional App client-id-only environment when falling back to legacy tokens", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        github: { owner: "acme", repo: "symphony" },
      },
      "/repo/WORKFLOW.md",
      {
        LINEAR_API_KEY: "linear-secret",
        GITHUB_TOKEN: "legacy-github-secret",
        GITHUB_APP_CLIENT_ID: "Iv1.client-only",
      },
    );

    const resolved = resolveGitHubClientConfig(config, "github.review_feedback_write");
    expect(config.github.app).toBeNull();
    expect(resolved.github.token).toBe("legacy-github-secret");
    expect(resolved.github.app).toBeNull();
    expect(resolved.credential).toMatchObject({ source: "legacy" });
  });

  it("selects separate profile tokens per GitHub operation", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        github: { owner: "acme", repo: "symphony", token: "legacy-github-token" },
        credential_profiles: {
          profiles: {
            discovery: { value: "$GITHUB_DISCOVERY_TOKEN", capabilities: ["github.discovery"] },
            publication: { value: "$GITHUB_PUBLICATION_TOKEN", capabilities: ["github.publication"] },
            "review-read": {
              value: "$GITHUB_REVIEW_READ_TOKEN",
              capabilities: ["github.review_evidence_read"],
            },
            "feedback-write": {
              value: "$GITHUB_FEEDBACK_WRITE_TOKEN",
              capabilities: ["github.review_feedback_write"],
            },
            merge: {
              value: "$GITHUB_MERGE_TOKEN",
              capabilities: ["github.merge"],
            },
          },
          roles: {
            worker: {
              "github.discovery": "discovery",
            },
            reviewer: {
              "github.review_evidence_read": "review-read",
              "github.review_feedback_write": "feedback-write",
            },
            service: {
              "github.publication": "publication",
              "github.merge": "merge",
            },
          },
        },
      },
      "/repo/WORKFLOW.md",
      {
        LINEAR_API_KEY: "linear-secret",
        GITHUB_DISCOVERY_TOKEN: "discovery-token",
        GITHUB_PUBLICATION_TOKEN: "publication-token",
        GITHUB_REVIEW_READ_TOKEN: "review-read-token",
        GITHUB_FEEDBACK_WRITE_TOKEN: "feedback-write-token",
        GITHUB_MERGE_TOKEN: "merge-token",
      },
    );

    expect(resolveGitHubClientConfig(config, "github.discovery").github.token).toBe("discovery-token");
    expect(resolveGitHubClientConfig(config, "github.publication").github.token).toBe("publication-token");
    expect(resolveGitHubClientConfig(config, "github.review_evidence_read").github.token).toBe("review-read-token");
    expect(resolveGitHubClientConfig(config, "github.review_feedback_write").github.token).toBe("feedback-write-token");
    expect(resolveGitHubClientConfig(config, "github.merge").github.token).toBe("merge-token");
  });

  it("defaults service publication, service merge, and review-feedback to App auth over legacy GitHub tokens", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        github: {
          owner: "acme",
          repo: "symphony",
          token: "$GITHUB_TOKEN",
          app: { app_id: "12345", installation_id: "67890", private_key: "fake-private-key" },
        },
      },
      "/repo/WORKFLOW.md",
      {
        LINEAR_API_KEY: "linear-secret",
        GITHUB_TOKEN: "legacy-github-secret",
      },
    );

    for (const capability of ["github.publication", "github.review_feedback_write", "github.merge"] as const) {
      const resolved = resolveGitHubClientConfig(config, capability);
      expect(resolved.github.token).toBeNull();
      expect(resolved.github.app).not.toBeNull();
      expect(resolved.credential).toBeNull();
    }
  });

  it("selects app-backed profiles per GitHub operation", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        github: {
          owner: "acme",
          repo: "symphony",
          token: "$GITHUB_TOKEN",
          app: { app_id: "global-app", installation_id: "global-install", private_key: "global-key" },
        },
        credential_profiles: {
          profiles: {
            publication: {
              kind: "github_app",
              app_id: "$GITHUB_PUBLICATION_APP_ID",
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
            reviewer: { "github.review_feedback_write": "feedback" },
          },
        },
      },
      "/repo/WORKFLOW.md",
      {
        LINEAR_API_KEY: "linear-secret",
        GITHUB_TOKEN: "legacy-github-secret",
        GITHUB_PUBLICATION_APP_ID: "111",
        GITHUB_PUBLICATION_APP_INSTALLATION_ID: "222",
        GITHUB_PUBLICATION_APP_PRIVATE_KEY_PATH: "/secrets/publication.pem",
        GITHUB_REVIEW_APP_ID: "333",
        GITHUB_REVIEW_APP_CLIENT_ID: "Iv1.review",
        GITHUB_REVIEW_APP_INSTALLATION_ID: "444",
        GITHUB_REVIEW_APP_PRIVATE_KEY_PATH: "/secrets/reviewer.pem",
      },
    );

    expect(resolveGitHubClientConfig(config, "github.publication")).toMatchObject({
      github: { token: null, app: { appId: "111", installationId: "222" } },
      credential: { kind: "github_app", source: "profile", profileName: "publication" },
    });
    expect(resolveGitHubClientConfig(config, "github.merge")).toMatchObject({
      github: { token: null, app: { appId: "111", installationId: "222" } },
      credential: { kind: "github_app", source: "profile", profileName: "publication" },
    });
    expect(resolveGitHubClientConfig(config, "github.review_feedback_write")).toMatchObject({
      github: { token: null, app: { appId: "333", clientId: "Iv1.review", installationId: "444" } },
      credential: { kind: "github_app", source: "profile", profileName: "feedback" },
    });
  });

  it("keeps explicit capability profile tokens ahead of App auth", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        github: {
          owner: "acme",
          repo: "symphony",
          token: "$GITHUB_TOKEN",
          app: { app_id: "12345", installation_id: "67890", private_key: "fake-private-key" },
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
      },
      "/repo/WORKFLOW.md",
      {
        LINEAR_API_KEY: "linear-secret",
        GITHUB_TOKEN: "legacy-github-secret",
        GITHUB_PUBLICATION_TOKEN: "publication-token",
        GITHUB_FEEDBACK_TOKEN: "feedback-token",
      },
    );

    expect(resolveGitHubClientConfig(config, "github.publication")).toMatchObject({
      github: { token: "publication-token" },
      credential: { source: "profile", value: "publication-token" },
    });
    expect(resolveGitHubClientConfig(config, "github.review_feedback_write")).toMatchObject({
      github: { token: "feedback-token" },
      credential: { source: "profile", value: "feedback-token" },
    });
  });

  it("reports missing publication tokens through the publication client", async () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        github: { owner: "acme", repo: "symphony", publish_pull_requests: true, pr_handoff: { enabled: false } },
      },
      "/repo/WORKFLOW.md",
      { LINEAR_API_KEY: "linear-secret" },
    );

    await expect(
      createGitHubPullRequestClientForCapability(config, "github.publication").checkRepositoryAccess(),
    ).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("resolves context-specific GitHub publication credentials while inheriting omitted capabilities", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        workspace: { root: "/repo/workspaces", state_dir: "/repo/state" },
        github: { owner: "acme", repo: "symphony", token: "legacy-github-token" },
        credential_profiles: {
          profiles: {
            publication: {
              value: "$GLOBAL_GITHUB_PUBLICATION_TOKEN",
              capabilities: ["github.publication", "github.merge"],
            },
          },
          roles: {
            service: {
              "github.publication": "publication",
              "github.merge": "publication",
            },
          },
        },
        project_contexts: [
          {
            id: "symphony",
            tracker: { project_slug: "SYMPHONY" },
            workspace: { source: { kind: "git", repository: "." } },
            credential_profiles: {
              profiles: {
                publication: { value: "$SYMPHONY_GITHUB_PUBLICATION_TOKEN" },
              },
            },
          },
          {
            id: "docs",
            tracker: { project_slug: "DOCS" },
            workspace: { source: { kind: "git", repository: "../docs-site" } },
            credential_profiles: {
              profiles: {
                publication: { value: "$DOCS_GITHUB_PUBLICATION_TOKEN" },
              },
            },
          },
        ],
      },
      "/repo/WORKFLOW.md",
      {
        LINEAR_API_KEY: "linear-secret",
        GLOBAL_GITHUB_PUBLICATION_TOKEN: "global-publication-token",
        SYMPHONY_GITHUB_PUBLICATION_TOKEN: "symphony-publication-token",
        DOCS_GITHUB_PUBLICATION_TOKEN: "docs-publication-token",
      },
    );

    const symphonyContext = {
      projectContextId: "symphony",
      projectContextLabel: "Symphony",
      linearProjectSlug: "SYMPHONY",
      routingSource: "test",
    } as const;
    const docsContext = {
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      linearProjectSlug: "DOCS",
      routingSource: "test",
    } as const;
    const contextEnv = {
      LINEAR_API_KEY: "linear-secret",
      GLOBAL_GITHUB_PUBLICATION_TOKEN: "global-publication-token",
      SYMPHONY_GITHUB_PUBLICATION_TOKEN: "symphony-publication-token",
      DOCS_GITHUB_PUBLICATION_TOKEN: "docs-publication-token",
    };

    expect(resolveGitHubClientConfig(config, "github.publication", { projectContext: symphonyContext, env: contextEnv })).toMatchObject({
      github: { token: "symphony-publication-token" },
      credential: { source: "profile", profileName: "publication", value: "symphony-publication-token" },
    });
    expect(resolveGitHubClientConfig(config, "github.publication", { projectContext: docsContext, env: contextEnv })).toMatchObject({
      github: { token: "docs-publication-token" },
      credential: { source: "profile", profileName: "publication", value: "docs-publication-token" },
    });
    expect(resolveGitHubClientConfig(config, "github.merge", { projectContext: docsContext, env: contextEnv })).toMatchObject({
      github: { token: "docs-publication-token" },
      credential: { source: "profile", profileName: "publication", value: "docs-publication-token" },
    });
  });

  it("resolves context-specific GitHub settings for publication, review evidence, feedback, and merge capabilities", () => {
    const { config, docsContext, contextEnv } = contextSpecificGitHubFixture();

    // When project_contexts is configured, implicit resolution uses the registry default context.
    expect(resolveGitHubProjectContext(config)).toMatchObject({
      id: "docs",
      label: "Documentation Site",
      github: {
        owner: "acme-docs",
        repo: "docs-site",
        headOwner: "docs-head-owner",
        apiBaseUrl: "https://api.docs.github.test",
      },
    });
    expect(resolveGitHubProjectContext(config, docsContext)).toMatchObject({
      id: "docs",
      label: "Documentation Site",
      github: {
        owner: "acme-docs",
        repo: "docs-site",
        headOwner: "docs-head-owner",
        apiBaseUrl: "https://api.docs.github.test",
      },
    });
    expect(resolveGitHubClientConfig(config, "github.publication")).toMatchObject({
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      github: {
        owner: "acme-docs",
        repo: "docs-site",
        headOwner: "docs-head-owner",
        apiBaseUrl: "https://api.docs.github.test",
        token: "docs-publication-token",
      },
      credential: { source: "profile", profileName: "publication", value: "docs-publication-token" },
    });
    expect(resolveGitHubClientConfigForProjectContext(config, "github.publication", docsContext)).toMatchObject({
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      github: {
        owner: "acme-docs",
        repo: "docs-site",
        headOwner: "docs-head-owner",
        apiBaseUrl: "https://api.docs.github.test",
        token: "docs-publication-token",
      },
      credential: { source: "profile", profileName: "publication", value: "docs-publication-token" },
      projectContext: {
        id: "docs",
        label: "Documentation Site",
      },
    });
    expect(resolveGitHubClientConfig(config, "github.review_evidence_read", { projectContext: docsContext, env: contextEnv })).toMatchObject({
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      github: {
        owner: "acme-docs",
        repo: "docs-site",
        headOwner: "docs-head-owner",
        apiBaseUrl: "https://api.docs.github.test",
        token: "docs-review-read-token",
      },
      credential: { source: "profile", profileName: "review-read", value: "docs-review-read-token" },
    });
    expect(resolveGitHubClientConfig(config, "github.review_feedback_write", { projectContext: docsContext, env: contextEnv })).toMatchObject({
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      github: {
        owner: "acme-docs",
        repo: "docs-site",
        headOwner: "docs-head-owner",
        apiBaseUrl: "https://api.docs.github.test",
        token: "docs-feedback-token",
      },
      credential: { source: "profile", profileName: "feedback-write", value: "docs-feedback-token" },
    });
    expect(resolveGitHubClientConfig(config, "github.merge", { projectContext: docsContext, env: contextEnv })).toMatchObject({
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      github: {
        owner: "acme-docs",
        repo: "docs-site",
        headOwner: "docs-head-owner",
        apiBaseUrl: "https://api.docs.github.test",
        token: "docs-merge-token",
      },
      credential: { source: "profile", profileName: "merge", value: "docs-merge-token" },
    });
  });

  it("creates GitHub clients that call the resolved project-context repository for publication, review evidence, feedback, and merge", async () => {
    const { config, docsContext } = contextSpecificGitHubFixture();

    const publicationRequests: Array<{ host: string; path: string; authorization: string; method: string }> = [];
    await createGitHubPullRequestClientForProjectContext(
      config,
      "github.publication",
      docsContext,
      async (input, init) => {
        const url = new URL(String(input));
        publicationRequests.push({
          host: url.host,
          path: url.pathname,
          authorization: String((init?.headers as Record<string, string> | undefined)?.authorization),
          method: init?.method ?? "GET",
        });
        return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
      },
    ).checkRepositoryAccess();
    expect(publicationRequests).toEqual([
      {
        host: "api.docs.github.test",
        path: "/repos/acme-docs/docs-site",
        authorization: "Bearer docs-publication-token",
        method: "GET",
      },
    ]);

    const reviewEvidenceRequests: Array<{ host: string; path: string; authorization: string; method: string; body: string | null }> = [];
    await createGitHubPullRequestClientForProjectContext(
      config,
      "github.review_evidence_read",
      docsContext,
      async (input, init) => {
        const url = new URL(String(input));
        const body = typeof init?.body === "string" ? init.body : null;
        reviewEvidenceRequests.push({
          host: url.host,
          path: url.pathname,
          authorization: String((init?.headers as Record<string, string> | undefined)?.authorization),
          method: init?.method ?? "GET",
          body,
        });
        if (url.pathname === "/graphql") {
          return new Response(
            JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: [],
                    },
                  },
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
      },
    ).listPullRequestReviewEvidence({ pullRequestNumber: 42 });
    expect(reviewEvidenceRequests.map((request) => ({
      host: request.host,
      path: request.path,
      authorization: request.authorization,
      method: request.method,
    }))).toEqual([
      {
        host: "api.docs.github.test",
        path: "/repos/acme-docs/docs-site/pulls/42/reviews",
        authorization: "Bearer docs-review-read-token",
        method: "GET",
      },
      {
        host: "api.docs.github.test",
        path: "/repos/acme-docs/docs-site/pulls/42/comments",
        authorization: "Bearer docs-review-read-token",
        method: "GET",
      },
      {
        host: "api.docs.github.test",
        path: "/repos/acme-docs/docs-site/issues/42/comments",
        authorization: "Bearer docs-review-read-token",
        method: "GET",
      },
      {
        host: "api.docs.github.test",
        path: "/graphql",
        authorization: "Bearer docs-review-read-token",
        method: "POST",
      },
    ]);
    expect(reviewEvidenceRequests[3]?.body).toContain('"owner":"acme-docs"');
    expect(reviewEvidenceRequests[3]?.body).toContain('"repo":"docs-site"');

    const reviewFeedbackRequests: Array<{ host: string; path: string; authorization: string; method: string }> = [];
    await createGitHubPullRequestClientForProjectContext(
      config,
      "github.review_feedback_write",
      docsContext,
      async (input, init) => {
        const url = new URL(String(input));
        reviewFeedbackRequests.push({
          host: url.host,
          path: url.pathname,
          authorization: String((init?.headers as Record<string, string> | undefined)?.authorization),
          method: init?.method ?? "GET",
        });
        return new Response(JSON.stringify({ html_url: "https://github.com/acme-docs/docs-site/pull/42#pullrequestreview-1", comments: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    ).submitPullRequestReviewFeedback({
      pullRequestNumber: 42,
      headSha: "head-sha-1",
      event: "COMMENT",
      body: "Looks good.",
    });
    expect(reviewFeedbackRequests).toEqual([
      {
        host: "api.docs.github.test",
        path: "/repos/acme-docs/docs-site/pulls/42/reviews",
        authorization: "Bearer docs-feedback-token",
        method: "POST",
      },
    ]);

    const mergeRequests: Array<{ host: string; path: string; authorization: string; method: string }> = [];
    await createGitHubPullRequestClientForProjectContext(
      config,
      "github.merge",
      docsContext,
      async (input, init) => {
        const url = new URL(String(input));
        mergeRequests.push({
          host: url.host,
          path: url.pathname,
          authorization: String((init?.headers as Record<string, string> | undefined)?.authorization),
          method: init?.method ?? "GET",
        });
        return new Response(
          JSON.stringify({
            number: 42,
            html_url: "https://github.com/acme-docs/docs-site/pull/42",
            state: "open",
            draft: false,
            mergeable: true,
            mergeable_state: "clean",
            merged: false,
            base: { ref: "main", sha: "base-sha-1" },
            head: { ref: "docs/TEST-1", sha: "head-sha-1", repo: { pushed_at: "2026-01-01T00:00:01Z" } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    ).getPullRequest({ pullRequestNumber: 42 });
    expect(mergeRequests).toEqual([
      {
        host: "api.docs.github.test",
        path: "/repos/acme-docs/docs-site/pulls/42",
        authorization: "Bearer docs-merge-token",
        method: "GET",
      },
    ]);
  });

  it("rejects wrong-role-only GitHub assignments before legacy fallback", () => {
    for (const capability of githubCapabilities()) {
      const owner = expectedRole(capability);
      const wrongRole = owner === "worker" ? "reviewer" : "worker";
      const config = parseServiceConfig(
        {
          tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
          github: { owner: "acme", repo: "symphony", token: "legacy-github-token" },
          credential_profiles: {
            profiles: {
              wrong: { value: "$WRONG_ROLE_TOKEN", capabilities: [capability] },
            },
            roles: {
              [wrongRole]: {
                [capability]: "wrong",
              },
            },
          },
        },
        "/repo/WORKFLOW.md",
        {
          LINEAR_API_KEY: "linear-secret",
          WRONG_ROLE_TOKEN: "wrong-role-secret",
        },
      );

      expect(() => resolveGitHubClientConfig(config, capability)).toThrow(SymphonyError);
      expect(() => resolveGitHubClientConfig(config, capability)).toThrow(
        `credential_profiles.roles.${owner}.${capability}`,
      );
    }
  });
});

function contextSpecificGitHubFixture() {
  const contextEnv = {
    LINEAR_API_KEY: "linear-secret",
    GLOBAL_GITHUB_PUBLICATION_TOKEN: "global-publication-token",
    GLOBAL_GITHUB_REVIEW_READ_TOKEN: "global-review-read-token",
    GLOBAL_GITHUB_FEEDBACK_TOKEN: "global-feedback-token",
    GLOBAL_GITHUB_MERGE_TOKEN: "global-merge-token",
    DOCS_GITHUB_PUBLICATION_TOKEN: "docs-publication-token",
    DOCS_GITHUB_REVIEW_READ_TOKEN: "docs-review-read-token",
    DOCS_GITHUB_FEEDBACK_TOKEN: "docs-feedback-token",
    DOCS_GITHUB_MERGE_TOKEN: "docs-merge-token",
  };

  const config = parseServiceConfig(
    {
      tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
      workspace: { root: "/repo/workspaces", state_dir: "/repo/state" },
      github: {
        owner: "acme",
        repo: "symphony",
        token: "legacy-github-token",
        api_base_url: "https://api.github.test",
      },
      credential_profiles: {
        profiles: {
          publication: { value: "$GLOBAL_GITHUB_PUBLICATION_TOKEN", capabilities: ["github.publication"] },
          "review-read": { value: "$GLOBAL_GITHUB_REVIEW_READ_TOKEN", capabilities: ["github.review_evidence_read"] },
          "feedback-write": {
            value: "$GLOBAL_GITHUB_FEEDBACK_TOKEN",
            capabilities: ["github.review_feedback_write"],
          },
          merge: { value: "$GLOBAL_GITHUB_MERGE_TOKEN", capabilities: ["github.merge"] },
        },
        roles: {
          reviewer: {
            "github.review_evidence_read": "review-read",
            "github.review_feedback_write": "feedback-write",
          },
          service: {
            "github.publication": "publication",
            "github.merge": "merge",
          },
        },
      },
      project_contexts: [
        {
          id: "docs",
          label: "Documentation Site",
          tracker: { project_slug: "DOCS" },
          workspace: { source: { kind: "git", repository: "../docs-site" } },
          github: {
            owner: "acme-docs",
            repo: "docs-site",
            head_owner: "docs-head-owner",
            api_base_url: "https://api.docs.github.test",
          },
          credential_profiles: {
            profiles: {
              publication: { value: "$DOCS_GITHUB_PUBLICATION_TOKEN" },
              "review-read": { value: "$DOCS_GITHUB_REVIEW_READ_TOKEN" },
              "feedback-write": { value: "$DOCS_GITHUB_FEEDBACK_TOKEN" },
              merge: { value: "$DOCS_GITHUB_MERGE_TOKEN" },
            },
          },
        },
      ],
    },
    "/repo/WORKFLOW.md",
    contextEnv,
  );

  const docsContext = {
    projectContextId: "docs",
    projectContextLabel: "Documentation Site",
    linearProjectSlug: "DOCS",
    routingSource: "test",
  } as const;

  return { config, docsContext, contextEnv };
}

function githubCapabilities(): GitHubCredentialCapability[] {
  return [
    "github.discovery",
    "github.publication",
    "github.review_evidence_read",
    "github.review_feedback_write",
    "github.merge",
  ];
}

function expectedRole(capability: GitHubCredentialCapability): "worker" | "reviewer" | "service" {
  if (capability === "github.publication" || capability === "github.merge") return "service";
  return capability === "github.discovery" ? "worker" : "reviewer";
}

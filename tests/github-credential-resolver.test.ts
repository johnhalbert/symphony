import { describe, expect, it } from "vitest";
import { parseServiceConfig } from "../src/core/config/Config.js";
import { SymphonyError } from "../src/core/errors.js";
import {
  createGitHubPullRequestClientForCapability,
  type GitHubCredentialCapability,
  resolveGitHubClientConfig,
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

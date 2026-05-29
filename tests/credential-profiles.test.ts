import { describe, expect, it } from "vitest";
import { parseServiceConfig } from "../src/core/config/Config.js";
import { SymphonyError } from "../src/core/errors.js";

describe("credential profile config", () => {
  it("resolves named profiles by role and capability without serializing secrets", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        github: { token: "legacy-github-token" },
        server: { open_workspace_token: "$OPEN_WORKSPACE_TOKEN" },
        credential_profiles: {
          profiles: {
            "github-read": {
              value: "$GITHUB_READ_TOKEN",
              capabilities: ["github.discovery", "github.review_evidence_read"],
            },
            "github-publish": {
              value: "$GITHUB_PUBLISH_TOKEN",
              capabilities: ["github.publication"],
            },
            "github-feedback": {
              value: "$GITHUB_FEEDBACK_TOKEN",
              capabilities: ["github.review_feedback_write"],
            },
            "github-merge": {
              value: "$GITHUB_MERGE_TOKEN",
              capabilities: ["github.merge"],
            },
            "linear-read": {
              value: "$LINEAR_READ_TOKEN",
              capabilities: ["linear.tracker"],
            },
            "linear-write": {
              value: "$LINEAR_WRITE_TOKEN",
              capabilities: ["linear.writeback"],
            },
            "cursor-runtime": {
              value: "$CURSOR_PROFILE_TOKEN",
              capabilities: ["runtime.cursor"],
            },
            "workspace-open": {
              value: "$WORKSPACE_OPEN_TOKEN",
              capabilities: ["server.open_workspace"],
            },
          },
          roles: {
            worker: {
              "github.discovery": "github-read",
              "linear.writeback": "linear-write",
              "runtime.cursor": "cursor-runtime",
              "server.open_workspace": "workspace-open",
            },
            reviewer: {
              "github.review_evidence_read": "github-read",
              "github.review_feedback_write": "github-feedback",
              "linear.tracker": "linear-read",
              "linear.writeback": "linear-write",
              "runtime.cursor": "cursor-runtime",
            },
            service: {
              "github.publication": "github-publish",
              "github.merge": "github-merge",
              "linear.writeback": "linear-write",
            },
          },
        },
      },
      "/repo/WORKFLOW.md",
      {
        LINEAR_API_KEY: "legacy-linear-token",
        GITHUB_READ_TOKEN: "github-read-secret",
        GITHUB_PUBLISH_TOKEN: "github-publish-secret",
        GITHUB_FEEDBACK_TOKEN: "github-feedback-secret",
        GITHUB_MERGE_TOKEN: "github-merge-secret",
        LINEAR_READ_TOKEN: "linear-read-secret",
        LINEAR_WRITE_TOKEN: "linear-write-secret",
        CURSOR_PROFILE_TOKEN: "cursor-profile-secret",
        OPEN_WORKSPACE_TOKEN: "legacy-open-secret",
        WORKSPACE_OPEN_TOKEN: "workspace-open-secret",
      },
    );

    expect(config.credentialProfiles.resolveForRole("worker", "github.discovery")).toMatchObject({
      value: "github-read-secret",
      source: "profile",
      profileName: "github-read",
    });
    expect(config.credentialProfiles.resolveForRole("service", "github.publication")).toMatchObject({
      value: "github-publish-secret",
      source: "profile",
      profileName: "github-publish",
    });
    expect(config.credentialProfiles.resolveForRole("reviewer", "github.review_feedback_write")).toMatchObject({
      value: "github-feedback-secret",
      source: "profile",
      profileName: "github-feedback",
    });
    expect(config.credentialProfiles.resolveForRole("service", "github.merge")).toMatchObject({
      value: "github-merge-secret",
      source: "profile",
      profileName: "github-merge",
    });
    expect(config.credentialProfiles.resolveForRole("worker", "server.open_workspace")).toMatchObject({
      value: "workspace-open-secret",
      source: "profile",
      profileName: "workspace-open",
    });
    expect(config.credentialProfiles.resolveForRole("worker", "runtime.cursor")).toMatchObject({
      value: "cursor-profile-secret",
      source: "profile",
      profileName: "cursor-runtime",
    });
    expect(config.credentialProfiles.resolveForRole("worker", "cursor.runtime")).toMatchObject({
      value: "cursor-profile-secret",
      source: "profile",
      profileName: "cursor-runtime",
    });
    expect(config.credentialProfiles.capabilitiesForRole("reviewer")).toEqual([
      "github.review_evidence_read",
      "github.review_feedback_write",
      "linear.tracker",
      "linear.writeback",
      "runtime.cursor",
    ]);
    expect(config.credentialProfiles.capabilitiesForRole("service")).toEqual([
      "github.publication",
      "github.merge",
      "linear.writeback",
    ]);

    const serialized = JSON.stringify(config.credentialProfiles);
    expect(serialized).toContain("GITHUB_READ_TOKEN");
    expect(serialized).not.toContain("github-read-secret");
    expect(serialized).not.toContain("workspace-open-secret");
  });

  it("rejects capabilities outside the closed inventory", () => {
    expect(() =>
      parseServiceConfig(
        {
          tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
          credential_profiles: {
            profiles: {
              bad: {
                value: "$BAD_TOKEN",
                capabilities: ["github.not_real"],
              },
            },
          },
        },
        "/repo/WORKFLOW.md",
        { LINEAR_API_KEY: "linear-secret" },
      ),
    ).toThrow(SymphonyError);

    expect(() =>
      parseServiceConfig(
        {
          tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
          credential_profiles: {
            profiles: {
              good: {
                value: "$GOOD_TOKEN",
                capabilities: ["github.discovery"],
              },
            },
            roles: {
              worker: {
                "github.not_real": "good",
              },
            },
          },
        },
        "/repo/WORKFLOW.md",
        { LINEAR_API_KEY: "linear-secret", GOOD_TOKEN: "good-secret" },
      ),
    ).toThrow(SymphonyError);
  });

  it("accepts explicit static-token profiles and app-backed GitHub profiles without serializing secrets", () => {
    const secretPrivateKey = "profile-private-key-secret-material";
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        credential_profiles: {
          profiles: {
            publication: {
              kind: "github_app",
              app_id: "$GITHUB_PUBLICATION_APP_ID",
              client_id: "$GITHUB_PUBLICATION_APP_CLIENT_ID",
              installation_id: "$GITHUB_PUBLICATION_APP_INSTALLATION_ID",
              private_key: "$GITHUB_PUBLICATION_APP_PRIVATE_KEY",
              capabilities: ["github.publication", "github.merge"],
            },
            feedback: {
              kind: "github_app",
              app_id: "$GITHUB_REVIEW_APP_ID",
              installation_id: "$GITHUB_REVIEW_APP_INSTALLATION_ID",
              private_key_path: "$GITHUB_REVIEW_APP_PRIVATE_KEY_PATH",
              capabilities: ["github.review_feedback_write"],
            },
            discovery: {
              kind: "static_token",
              value: "$GITHUB_DISCOVERY_TOKEN",
              capabilities: ["github.discovery"],
            },
          },
          roles: {
            worker: { "github.discovery": "discovery" },
            reviewer: { "github.review_feedback_write": "feedback" },
            service: {
              "github.publication": "publication",
              "github.merge": "publication",
            },
          },
        },
      },
      "/repo/WORKFLOW.md",
      {
        LINEAR_API_KEY: "linear-secret",
        GITHUB_PUBLICATION_APP_ID: "111",
        GITHUB_PUBLICATION_APP_CLIENT_ID: "Iv1.publication",
        GITHUB_PUBLICATION_APP_INSTALLATION_ID: "222",
        GITHUB_PUBLICATION_APP_PRIVATE_KEY: secretPrivateKey,
        GITHUB_REVIEW_APP_ID: "333",
        GITHUB_REVIEW_APP_INSTALLATION_ID: "444",
        GITHUB_REVIEW_APP_PRIVATE_KEY_PATH: "/secrets/reviewer.pem",
        GITHUB_DISCOVERY_TOKEN: "discovery-secret",
      },
    );

    expect(config.credentialProfiles.resolveForRole("service", "github.publication")).toMatchObject({
      kind: "github_app",
      source: "profile",
      profileName: "publication",
      app: {
        appId: "111",
        clientId: "Iv1.publication",
        installationId: "222",
        privateKeyEnvVar: "GITHUB_PUBLICATION_APP_PRIVATE_KEY",
      },
    });
    expect(config.credentialProfiles.resolveForRole("service", "github.merge")).toMatchObject({
      kind: "github_app",
      profileName: "publication",
    });
    expect(config.credentialProfiles.resolveForRole("worker", "github.discovery")).toMatchObject({
      kind: "static_token",
      value: "discovery-secret",
      profileName: "discovery",
    });

    const serialized = JSON.stringify(config.credentialProfiles);
    expect(serialized).toContain("GITHUB_PUBLICATION_APP_PRIVATE_KEY");
    expect(serialized).toContain("reviewer.pem");
    expect(serialized).not.toContain(secretPrivateKey);
    expect(serialized).not.toContain("discovery-secret");
  });

  it("rejects GitHub App profiles assigned to non-GitHub capabilities", () => {
    expect(() =>
      parseServiceConfig(
        {
          tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
          credential_profiles: {
            profiles: {
              bad: {
                kind: "github_app",
                app_id: "$GITHUB_APP_ID",
                installation_id: "$GITHUB_APP_INSTALLATION_ID",
                private_key_path: "$GITHUB_APP_PRIVATE_KEY_PATH",
                capabilities: ["linear.writeback"],
              },
            },
          },
        },
        "/repo/WORKFLOW.md",
        {
          LINEAR_API_KEY: "linear-secret",
          GITHUB_APP_ID: "111",
          GITHUB_APP_INSTALLATION_ID: "222",
          GITHUB_APP_PRIVATE_KEY_PATH: "/secrets/app.pem",
        },
      ),
    ).toThrow(/kind github_app only supports github\.\*/);
  });

  it("keeps legacy fallbacks when profiles are absent", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        server: { open_workspace_token: "$OPEN_WORKSPACE_TOKEN" },
      },
      "/repo/WORKFLOW.md",
      {
        LINEAR_API_KEY: "legacy-linear-secret",
        GITHUB_TOKEN: "legacy-github-secret",
        CURSOR_API_KEY: "legacy-cursor-secret",
        OPEN_WORKSPACE_TOKEN: "legacy-open-secret",
      },
    );

    expect(config.credentialProfiles.resolveForRole("worker", "github.discovery")).toMatchObject({
      value: "legacy-github-secret",
      source: "legacy",
      profileName: null,
    });
    expect(config.credentialProfiles.resolveForRole("service", "github.publication")?.value).toBe(
      "legacy-github-secret",
    );
    expect(config.credentialProfiles.resolveForRole("reviewer", "github.review_evidence_read")?.value).toBe(
      "legacy-github-secret",
    );
    expect(config.credentialProfiles.resolveForRole("reviewer", "github.review_feedback_write")?.value).toBe(
      "legacy-github-secret",
    );
    expect(config.credentialProfiles.resolveForRole("service", "github.merge")?.value).toBe("legacy-github-secret");
    expect(config.credentialProfiles.resolveForRole("service", "linear.writeback")?.value).toBe("legacy-linear-secret");
    expect(config.credentialProfiles.resolveForRole("worker", "linear.tracker")?.value).toBe("legacy-linear-secret");
    expect(config.credentialProfiles.resolveForRole("worker", "linear.writeback")?.value).toBe(
      "legacy-linear-secret",
    );
    expect(config.credentialProfiles.resolveForRole("worker", "runtime.cursor")?.value).toBe("legacy-cursor-secret");
    expect(config.credentialProfiles.resolveForRole("worker", "cursor.runtime")?.value).toBe("legacy-cursor-secret");
    expect(config.credentialProfiles.resolveForRole("worker", "server.open_workspace")?.value).toBe(
      "legacy-open-secret",
    );
  });

  it("requires profile values to be environment references and redacts secret material from errors", () => {
    const literalSecret = "literal-secret-value";
    expect(() =>
      parseServiceConfig(
        {
          tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
          credential_profiles: {
            profiles: {
              bad: {
                value: literalSecret,
                capabilities: ["github.discovery"],
              },
            },
          },
        },
        "/repo/WORKFLOW.md",
        { LINEAR_API_KEY: "linear-secret" },
      ),
    ).toThrow(/must reference an environment variable/);

    try {
      parseServiceConfig(
        {
          tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
          credential_profiles: {
            profiles: {
              "github-read": {
                value: "$GITHUB_PROFILE_TOKEN",
                capabilities: ["github.discovery"],
              },
            },
            roles: {
              worker: {
                "github.publication": "github-read",
              },
            },
          },
        },
        "/repo/WORKFLOW.md",
        { LINEAR_API_KEY: "linear-secret", GITHUB_PROFILE_TOKEN: "resolved-github-secret" },
      );
      throw new Error("Expected config parsing to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SymphonyError);
      expect(error instanceof Error ? error.message : String(error)).not.toContain("resolved-github-secret");
    }
  });

  it("reports unset explicit profile environment variables without exposing other secret values", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        credential_profiles: {
          profiles: {
            "github-read": {
              value: "$MISSING_GITHUB_PROFILE_TOKEN",
              capabilities: ["github.discovery"],
            },
          },
          roles: {
            worker: {
              "github.discovery": "github-read",
            },
          },
        },
      },
      "/repo/WORKFLOW.md",
      { LINEAR_API_KEY: "linear-secret", GITHUB_TOKEN: "legacy-github-secret" },
    );

    expect(() => config.credentialProfiles.resolveForRole("worker", "github.discovery")).toThrow(
      /MISSING_GITHUB_PROFILE_TOKEN/,
    );
    try {
      config.credentialProfiles.resolveForRole("worker", "github.discovery");
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).not.toContain("legacy-github-secret");
    }
  });

  it("does not treat MCP handoff tokens as external service credentials", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        server: { open_workspace_token: "$OPEN_WORKSPACE_TOKEN" },
        completion_report: {
          token: "$COMPLETION_HANDOFF_TOKEN",
          expectedToken: "$COMPLETION_EXPECTED_TOKEN",
        },
        review_verdict: {
          token: "$REVIEW_HANDOFF_TOKEN",
          expectedToken: "$REVIEW_EXPECTED_TOKEN",
        },
      },
      "/repo/WORKFLOW.md",
      {
        LINEAR_API_KEY: "linear-secret",
        GITHUB_TOKEN: "github-secret",
        OPEN_WORKSPACE_TOKEN: "open-workspace-secret",
        COMPLETION_HANDOFF_TOKEN: "completion-handoff-secret",
        COMPLETION_EXPECTED_TOKEN: "completion-expected-secret",
        REVIEW_HANDOFF_TOKEN: "review-handoff-secret",
        REVIEW_EXPECTED_TOKEN: "review-expected-secret",
      },
    );

    expect(config.credentialProfiles.resolveForRole("worker", "github.discovery")?.value).toBe("github-secret");
    expect(config.credentialProfiles.resolveForRole("worker", "server.open_workspace")?.value).toBe(
      "open-workspace-secret",
    );
    expect(JSON.stringify(config.credentialProfiles)).not.toContain("handoff-secret");
    expect(JSON.stringify(config.credentialProfiles)).not.toContain("expected-secret");
  });
});

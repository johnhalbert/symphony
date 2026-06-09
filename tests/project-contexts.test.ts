import { describe, expect, it } from "vitest";
import { parseServiceConfig } from "../src/core/config/Config.js";
import { projectContextRegistryPublicMetadata } from "../src/core/config/ProjectContexts.js";
import { multiProjectWorkflowConfig, projectContextFixture } from "./helpers.js";

describe("ProjectContexts", () => {
  it("normalizes legacy top-level config into a default context", () => {
    const config = parseServiceConfig(
      {
        tracker: {
          kind: "linear",
          api_key: "$LINEAR_API_KEY",
          project_slug: "TEST",
        },
      },
      "/repo/WORKFLOW.md",
      { LINEAR_API_KEY: "linear-secret" },
    );

    expect(config.projectContexts.defaultContextId).toBe("default");
    expect(config.projectContexts.contexts).toHaveLength(1);
    expect(config.projectContexts.contexts[0]).toMatchObject({
      id: "default",
      label: "Default",
      source: "legacy_default",
      linearProjectIdentity: { slug: "TEST" },
      codebaseIdentity: { sourceKind: "none" },
    });
  });

  it("produces redacted public metadata for configured project contexts", () => {
    const config = parseServiceConfig(
      multiProjectWorkflowConfig({
        topLevel: {
          github: { token: "$ROOT_GITHUB_TOKEN" },
          credential_profiles: {
            profiles: {
              "shared-gh": {
                value: "$SHARED_GITHUB_TOKEN",
                capabilities: ["github.discovery"],
              },
            },
            roles: {
              worker: {
                "github.discovery": "shared-gh",
              },
            },
          },
        },
        projectContexts: [
          projectContextFixture({
            id: "symphony",
            label: "Symphony",
            projectSlug: "SYMPHONY",
            repository: ".",
          }),
        ],
      }),
      "/repo/WORKFLOW.md",
      {
        LINEAR_API_KEY: "linear-secret",
        ROOT_GITHUB_TOKEN: "root-gh-secret",
        SHARED_GITHUB_TOKEN: "shared-gh-secret",
      },
    );

    const metadata = projectContextRegistryPublicMetadata(config.projectContexts);
    const serialized = JSON.stringify(metadata);

    expect(serialized).not.toContain("root-gh-secret");
    expect(serialized).not.toContain("shared-gh-secret");
    expect(metadata[0]).toMatchObject({
      id: "symphony",
      github: { tokenPresent: true },
      credentialProfiles: {
        worker: {
          "github.discovery": "shared-gh",
        },
      },
    });
  });
});

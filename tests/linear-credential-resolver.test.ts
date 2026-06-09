import { describe, expect, it } from "vitest";
import { parseServiceConfig } from "../src/core/config/Config.js";
import { SymphonyError } from "../src/core/errors.js";
import { resolveLinearClientConfig } from "../src/integrations/linear/LinearCredentialResolver.js";
import { multiProjectWorkflowConfig, projectContextFixture } from "./helpers.js";

describe("Linear credential resolver", () => {
  it("binds tracker reads to the worker linear.tracker profile", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LEGACY_LINEAR_TOKEN", project_slug: "TEST" },
        credential_profiles: {
          profiles: {
            "linear-worker-read": {
              value: "$LINEAR_WORKER_READ_TOKEN",
              capabilities: ["linear.tracker"],
            },
          },
          roles: {
            worker: {
              "linear.tracker": "linear-worker-read",
            },
          },
        },
      },
      "/repo/WORKFLOW.md",
      {
        LEGACY_LINEAR_TOKEN: "legacy-linear-secret",
        LINEAR_WORKER_READ_TOKEN: "linear-worker-read-secret",
      },
    );

    const resolved = resolveLinearClientConfig(config, "linear.tracker");

    expect(resolved.role).toBe("worker");
    expect(resolved.credential).toMatchObject({
      role: "worker",
      capability: "linear.tracker",
      source: "profile",
      profileName: "linear-worker-read",
    });
    expect(resolved.tracker.apiKey).toBe("linear-worker-read-secret");
  });

  it("rejects wrong-role-only tracker assignments before legacy fallback", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        credential_profiles: {
          profiles: {
            wrong: {
              value: "$LINEAR_WRONG_TOKEN",
              capabilities: ["linear.tracker"],
            },
          },
          roles: {
            service: {
              "linear.tracker": "wrong",
            },
          },
        },
      },
      "/repo/WORKFLOW.md",
      {
        LINEAR_API_KEY: "legacy-linear-secret",
        LINEAR_WRONG_TOKEN: "wrong-role-secret",
      },
    );

    expect(() => resolveLinearClientConfig(config, "linear.tracker")).toThrow(SymphonyError);
    expect(() => resolveLinearClientConfig(config, "linear.tracker")).toThrow(
      "credential_profiles.roles.worker.linear.tracker",
    );
  });

  it("binds writeback to the service linear.writeback profile", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_READ_TOKEN", project_slug: "TEST" },
        credential_profiles: {
          profiles: {
            "linear-service-write": {
              value: "$LINEAR_SERVICE_WRITE_TOKEN",
              capabilities: ["linear.writeback"],
            },
          },
          roles: {
            service: {
              "linear.writeback": "linear-service-write",
            },
          },
        },
      },
      "/repo/WORKFLOW.md",
      {
        LINEAR_READ_TOKEN: "linear-read-secret",
        LINEAR_SERVICE_WRITE_TOKEN: "linear-service-write-secret",
      },
    );

    const resolved = resolveLinearClientConfig(config, "linear.writeback");

    expect(config.tracker.apiKey).toBe("linear-read-secret");
    expect(resolved.role).toBe("service");
    expect(resolved.credential).toMatchObject({
      role: "service",
      capability: "linear.writeback",
      source: "profile",
      profileName: "linear-service-write",
    });
    expect(resolved.tracker.apiKey).toBe("linear-service-write-secret");
  });

  it("rejects wrong-role-only writeback assignments before legacy fallback", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
        credential_profiles: {
          profiles: {
            wrong: {
              value: "$LINEAR_WRONG_TOKEN",
              capabilities: ["linear.writeback"],
            },
          },
          roles: {
            worker: {
              "linear.writeback": "wrong",
            },
          },
        },
      },
      "/repo/WORKFLOW.md",
      {
        LINEAR_API_KEY: "legacy-linear-secret",
        LINEAR_WRONG_TOKEN: "wrong-role-secret",
      },
    );

    expect(() => resolveLinearClientConfig(config, "linear.writeback")).toThrow(SymphonyError);
    expect(() => resolveLinearClientConfig(config, "linear.writeback")).toThrow(
      "credential_profiles.roles.service.linear.writeback",
    );
  });

  it("keeps legacy fallback only through service writeback resolution", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "TEST" },
      },
      "/repo/WORKFLOW.md",
      { LINEAR_API_KEY: "legacy-linear-secret" },
    );

    const resolved = resolveLinearClientConfig(config, "linear.writeback");

    expect(resolved.role).toBe("service");
    expect(resolved.credential).toMatchObject({
      role: "service",
      capability: "linear.writeback",
      source: "legacy",
      profileName: null,
    });
    expect(resolved.tracker.apiKey).toBe("legacy-linear-secret");
  });

  it("resolves project-context-specific Linear credentials and tracker metadata", () => {
    const config = parseServiceConfig(
      multiProjectWorkflowConfig({
        topLevel: {
          tracker: { kind: "linear", api_key: "$DEFAULT_LINEAR_TOKEN", project_slug: "SYMPHONY" },
          credential_profiles: {
            profiles: {
              tracker: { value: "$DEFAULT_TRACKER_TOKEN", capabilities: ["linear.tracker"] },
              writeback: { value: "$DEFAULT_WRITEBACK_TOKEN", capabilities: ["linear.writeback"] },
            },
            roles: {
              worker: { "linear.tracker": "tracker" },
              service: { "linear.writeback": "writeback" },
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
            tracker: { api_key: "$DOCS_LINEAR_TOKEN", project_slug: "DOCS" },
            credential_profiles: {
              profiles: {
                tracker: { value: "$DOCS_TRACKER_TOKEN", capabilities: ["linear.tracker"] },
              },
              roles: {
                worker: { "linear.tracker": "tracker" },
              },
            },
          }),
        ],
      }),
      "/repo/WORKFLOW.md",
      {
        DEFAULT_LINEAR_TOKEN: "default-linear-secret",
        DEFAULT_TRACKER_TOKEN: "default-tracker-secret",
        DEFAULT_WRITEBACK_TOKEN: "default-writeback-secret",
        DOCS_LINEAR_TOKEN: "docs-linear-secret",
        DOCS_TRACKER_TOKEN: "docs-tracker-secret",
      },
    );

    expect(resolveLinearClientConfig(config, "linear.tracker")).toMatchObject({
      tracker: { projectSlug: "SYMPHONY", apiKey: "default-tracker-secret" },
      credential: { source: "profile", profileName: "tracker", value: "default-tracker-secret" },
    });
    expect(resolveLinearClientConfig(config, "linear.tracker", "docs")).toMatchObject({
      tracker: { projectSlug: "DOCS", apiKey: "docs-tracker-secret" },
      credential: { source: "profile", profileName: "tracker", value: "docs-tracker-secret" },
    });
    expect(resolveLinearClientConfig(config, "linear.writeback", "docs")).toMatchObject({
      tracker: { projectSlug: "DOCS", apiKey: "default-writeback-secret" },
      credential: { source: "profile", profileName: "writeback", value: "default-writeback-secret" },
    });
  });
});

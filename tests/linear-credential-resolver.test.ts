import { describe, expect, it } from "vitest";
import { parseServiceConfig } from "../src/core/config/Config.js";
import { SymphonyError } from "../src/core/errors.js";
import { resolveLinearClientConfig } from "../src/integrations/linear/LinearCredentialResolver.js";

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

  it("resolves project-context linear credentials from per-context role assignments", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$DEFAULT_LINEAR_TOKEN", project_slug: "DEFAULT" },
        workspace: {
          source: {
            kind: "git_worktree",
            repository: "../default-site",
            base_ref: "origin/main",
          },
        },
        credential_profiles: {
          profiles: {
            "docs-tracker": {
              value: "$DOCS_TRACKER_TOKEN",
              capabilities: ["linear.tracker"],
            },
            "docs-writeback": {
              value: "$DOCS_WRITEBACK_TOKEN",
              capabilities: ["linear.writeback"],
            },
          },
        },
        project_contexts: [
          {
            id: "default",
            enabled: false,
            tracker: { project_slug: "LEGACY" },
            workspace: {
              source: {
                kind: "git_worktree",
                repository: "../legacy-site",
                base_ref: "origin/main",
              },
            },
          },
          {
            id: "docs",
            tracker: {
              api_key: "$DOCS_LINEAR_TOKEN",
              project_slug: "DOCS",
            },
            workspace: {
              source: {
                kind: "git_worktree",
                repository: "../docs-site",
                base_ref: "origin/main",
              },
            },
            credential_profiles: {
              roles: {
                worker: {
                  "linear.tracker": "docs-tracker",
                },
                service: {
                  "linear.writeback": "docs-writeback",
                },
              },
            },
          },
        ],
      },
      "/repo/WORKFLOW.md",
      {
        DEFAULT_LINEAR_TOKEN: "default-linear-secret",
        DOCS_LINEAR_TOKEN: "docs-linear-legacy-secret",
        DOCS_TRACKER_TOKEN: "docs-tracker-secret",
        DOCS_WRITEBACK_TOKEN: "docs-writeback-secret",
      },
    );

    expect(config.projectContexts.defaultContextId).toBe("docs");
    expect(resolveLinearClientConfig(config, "linear.tracker", "docs")).toMatchObject({
      tracker: { projectSlug: "DOCS", apiKey: "docs-tracker-secret" },
      credential: { profileName: "docs-tracker", source: "profile" },
    });
    expect(resolveLinearClientConfig(config, "linear.writeback", "docs")).toMatchObject({
      tracker: { projectSlug: "DOCS", apiKey: "docs-writeback-secret" },
      credential: { profileName: "docs-writeback", source: "profile" },
    });
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
});

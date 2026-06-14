import { describe, expect, it } from "vitest";
import { parseServiceConfig } from "../src/core/config/Config.js";
import { normalizeProjectContextResolution } from "../src/core/config/ProjectContexts.js";
import { SymphonyError } from "../src/core/errors.js";
import { resolveLinearClientConfig, resolveLinearClientConfigForProjectContext } from "../src/integrations/linear/LinearCredentialResolver.js";

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

  it("resolves service writeback credentials and project slug from the addressed project context", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$DEFAULT_LINEAR_READ_TOKEN", project_slug: "TEST" },
        workspace: { root: "/repo/workspaces", state_dir: "/repo/state" },
        credential_profiles: {
          profiles: {
            "default-writeback": {
              value: "$DEFAULT_LINEAR_WRITEBACK_TOKEN",
              capabilities: ["linear.writeback"],
            },
          },
          roles: {
            service: {
              "linear.writeback": "default-writeback",
            },
          },
        },
        project_contexts: [
          {
            id: "default",
            workspace: {
              source: { kind: "git_worktree", repository: "/repo", base_ref: "origin/main" },
            },
          },
          {
            id: "docs",
            tracker: { api_key: "$DOCS_LINEAR_READ_TOKEN", project_slug: "DOCS" },
            workspace: {
              source: { kind: "git_worktree", repository: "/repo", base_ref: "origin/main" },
            },
            credential_profiles: {
              profiles: {
                "docs-writeback": {
                  value: "$DOCS_LINEAR_WRITEBACK_TOKEN",
                  capabilities: ["linear.writeback"],
                },
              },
              roles: {
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
        DEFAULT_LINEAR_READ_TOKEN: "default-read-secret",
        DEFAULT_LINEAR_WRITEBACK_TOKEN: "default-writeback-secret",
        DOCS_LINEAR_READ_TOKEN: "docs-read-secret",
        DOCS_LINEAR_WRITEBACK_TOKEN: "docs-writeback-secret",
      },
    );

    const resolved = resolveLinearClientConfigForProjectContext(config, "linear.writeback", {
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      linearProjectSlug: "DOCS",
      routingSource: "explicit",
    });

    expect(resolved.role).toBe("service");
    expect(resolved.tracker.projectSlug).toBe("DOCS");
    expect(resolved.tracker.apiKey).toBe("docs-writeback-secret");
    expect(resolved.credential).toMatchObject({
      role: "service",
      capability: "linear.writeback",
      source: "profile",
      profileName: "docs-writeback",
    });
    expect(resolveLinearClientConfig(config, "linear.writeback").tracker.projectSlug).toBe("TEST");
  });

  it("fails closed for explicit unknown project contexts during writeback resolution", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$DEFAULT_LINEAR_READ_TOKEN", project_slug: "TEST" },
        workspace: { root: "/repo/workspaces", state_dir: "/repo/state" },
        credential_profiles: {
          profiles: {
            "default-writeback": {
              value: "$DEFAULT_LINEAR_WRITEBACK_TOKEN",
              capabilities: ["linear.writeback"],
            },
          },
          roles: {
            service: {
              "linear.writeback": "default-writeback",
            },
          },
        },
      },
      "/repo/WORKFLOW.md",
      {
        DEFAULT_LINEAR_READ_TOKEN: "default-read-secret",
        DEFAULT_LINEAR_WRITEBACK_TOKEN: "default-writeback-secret",
      },
    );

    expect(() =>
      resolveLinearClientConfigForProjectContext(config, "linear.writeback", {
        projectContextId: "docs",
        projectContextLabel: "Documentation Site",
        linearProjectSlug: "DOCS",
        routingSource: "explicit",
      }),
    ).toThrow('Resolved project context "docs" is not configured');
    expect(resolveLinearClientConfig(config, "linear.writeback").tracker.projectSlug).toBe("TEST");
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

  it("resolves context-specific tracker credentials and inherits non-overridden writeback assignments", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LEGACY_LINEAR_TOKEN", project_slug: "TEST" },
        workspace: { root: "/repo/workspaces", state_dir: "/repo/state" },
        credential_profiles: {
          profiles: {
            publication: { value: "$GLOBAL_LINEAR_WRITEBACK_TOKEN", capabilities: ["linear.writeback"] },
            tracker: { value: "$GLOBAL_LINEAR_TRACKER_TOKEN", capabilities: ["linear.tracker"] },
          },
          roles: {
            worker: { "linear.tracker": "tracker" },
            service: { "linear.writeback": "publication" },
          },
        },
        project_contexts: [
          {
            id: "symphony",
            tracker: { project_slug: "SYMPHONY" },
            workspace: { source: { kind: "git", repository: "." } },
            credential_profiles: {
              profiles: {
                tracker: { value: "$SYMPHONY_LINEAR_TRACKER_TOKEN" },
              },
            },
          },
          {
            id: "docs",
            tracker: { project_slug: "DOCS" },
            workspace: { source: { kind: "git", repository: "../docs-site" } },
            credential_profiles: {
              profiles: {
                tracker: { value: "$DOCS_LINEAR_TRACKER_TOKEN" },
              },
            },
          },
        ],
      },
      "/repo/WORKFLOW.md",
      {
        LEGACY_LINEAR_TOKEN: "legacy-linear-secret",
        GLOBAL_LINEAR_TRACKER_TOKEN: "global-linear-tracker-secret",
        GLOBAL_LINEAR_WRITEBACK_TOKEN: "global-linear-writeback-secret",
        SYMPHONY_LINEAR_TRACKER_TOKEN: "symphony-linear-tracker-secret",
        DOCS_LINEAR_TRACKER_TOKEN: "docs-linear-tracker-secret",
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
      LEGACY_LINEAR_TOKEN: "legacy-linear-secret",
      GLOBAL_LINEAR_TRACKER_TOKEN: "global-linear-tracker-secret",
      GLOBAL_LINEAR_WRITEBACK_TOKEN: "global-linear-writeback-secret",
      SYMPHONY_LINEAR_TRACKER_TOKEN: "symphony-linear-tracker-secret",
      DOCS_LINEAR_TRACKER_TOKEN: "docs-linear-tracker-secret",
    };

    expect(resolveLinearClientConfig(config, "linear.tracker", { projectContext: symphonyContext, env: contextEnv })).toMatchObject({
      credential: { source: "profile", profileName: "tracker", value: "symphony-linear-tracker-secret" },
      tracker: { apiKey: "symphony-linear-tracker-secret" },
    });
    expect(resolveLinearClientConfig(config, "linear.tracker", { projectContext: docsContext, env: contextEnv })).toMatchObject({
      credential: { source: "profile", profileName: "tracker", value: "docs-linear-tracker-secret" },
      tracker: { apiKey: "docs-linear-tracker-secret" },
    });
    expect(resolveLinearClientConfig(config, "linear.writeback", { projectContext: docsContext, env: contextEnv })).toMatchObject({
      credential: { source: "profile", profileName: "publication", value: "global-linear-writeback-secret" },
      tracker: { apiKey: "global-linear-writeback-secret" },
    });
  });

  it("maps legacy-default project-context routing to the configured default context", () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LEGACY_LINEAR_TOKEN", project_slug: "TEST" },
        workspace: { root: "/repo/workspaces", state_dir: "/repo/state" },
        credential_profiles: {
          profiles: {
            publication: { value: "$GLOBAL_LINEAR_WRITEBACK_TOKEN", capabilities: ["linear.writeback"] },
          },
          roles: {
            service: { "linear.writeback": "publication" },
          },
        },
        project_contexts: [
          {
            id: "docs",
            tracker: { project_slug: "DOCS" },
            workspace: { source: { kind: "git", repository: "../docs-site" } },
            credential_profiles: {
              profiles: {
                publication: { value: "$DOCS_LINEAR_WRITEBACK_TOKEN" },
              },
            },
          },
          {
            id: "symphony",
            tracker: { project_slug: "TEST" },
            workspace: { source: { kind: "git", repository: "." } },
            credential_profiles: {
              profiles: {
                publication: { value: "$SYMPHONY_LINEAR_WRITEBACK_TOKEN" },
              },
            },
          },
        ],
      },
      "/repo/WORKFLOW.md",
      {
        LEGACY_LINEAR_TOKEN: "legacy-linear-secret",
        GLOBAL_LINEAR_WRITEBACK_TOKEN: "global-linear-writeback-secret",
        DOCS_LINEAR_WRITEBACK_TOKEN: "docs-linear-writeback-secret",
        SYMPHONY_LINEAR_WRITEBACK_TOKEN: "symphony-linear-writeback-secret",
      },
    );

    expect(
      resolveLinearClientConfig(config, "linear.writeback", {
        projectContext: normalizeProjectContextResolution(undefined),
        env: {
          LEGACY_LINEAR_TOKEN: "legacy-linear-secret",
          GLOBAL_LINEAR_WRITEBACK_TOKEN: "global-linear-writeback-secret",
          DOCS_LINEAR_WRITEBACK_TOKEN: "docs-linear-writeback-secret",
          SYMPHONY_LINEAR_WRITEBACK_TOKEN: "symphony-linear-writeback-secret",
        },
      }),
    ).toMatchObject({
      credential: { source: "profile", profileName: "publication", value: "docs-linear-writeback-secret" },
      tracker: { apiKey: "docs-linear-writeback-secret" },
    });
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

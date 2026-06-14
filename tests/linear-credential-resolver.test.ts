import { describe, expect, it } from "vitest";
import { parseServiceConfig } from "../src/core/config/Config.js";
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

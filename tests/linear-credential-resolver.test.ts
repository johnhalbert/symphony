import { describe, expect, it } from "vitest";
import { parseServiceConfig } from "../src/core/config/Config.js";
import { SymphonyError } from "../src/core/errors.js";
import { resolveLinearClientConfig } from "../src/integrations/linear/LinearCredentialResolver.js";

describe("Linear credential resolver", () => {
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
});

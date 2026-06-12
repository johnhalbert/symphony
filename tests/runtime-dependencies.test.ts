import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseServiceConfig } from "../src/core/config/Config.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import {
  createRuntimeTrackerClient,
  createRuntimeWritebackProcessor,
  resolveCursorRuntimeApiKey,
  resolveRuntimeCredential,
  resolveStatusMutationToken,
} from "../src/app/RuntimeDependencies.js";

let root: string;

describe("runtime dependency credential wiring", () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-runtime-deps-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("uses the worker linear.tracker profile for runtime tracker reads", async () => {
    const config = runtimeConfig();
    const authorizations: string[] = [];

    await createRuntimeTrackerClient(config, async (_input, init) => {
      authorizations.push(String((init?.headers as Record<string, string> | undefined)?.authorization));
      return jsonResponse({ data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } });
    }).fetchCandidateIssues();

    expect(authorizations).toEqual(["linear-tracker-secret"]);
  });

  it("uses the service linear.writeback profile for runtime writeback processing", async () => {
    const config = runtimeConfig();
    const authorizations: string[] = [];
    const processor = createRuntimeWritebackProcessor(
      config,
      new StructuredLogger(() => undefined),
      async (_input, init) => {
        authorizations.push(String((init?.headers as Record<string, string> | undefined)?.authorization));
        const body = JSON.parse(String(init?.body)) as { query?: string };
        if (body.query?.includes("issueUpdate")) {
          return jsonResponse({ data: { issueUpdate: { success: true } } });
        }
        return jsonResponse({
          data: {
            issue: {
              id: "issue-1",
              identifier: "TEST-1",
              state: { id: "state-ready", name: "Ready to Merge" },
              team: { states: { nodes: [{ id: "state-done", name: "Done" }] } },
              comments: { nodes: [] },
            },
          },
        });
      },
    );

    await processor?.enqueueAndProcess({
      kind: "transition",
      idempotencyKey: "transition:issue-1:Done",
      issueId: "issue-1",
      payload: { toState: "Done", fromStates: ["Ready to Merge"] },
    });

    expect(authorizations).toEqual(["linear-writeback-secret", "linear-writeback-secret"]);
  });

  it("selects service writeback credentials per operation project context in runtime writeback processing", async () => {
    const config = multiProjectRuntimeConfig();
    const authorizations: string[] = [];
    const docsProjectContext = {
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      linearProjectSlug: "DOCS",
      routingSource: "explicit",
    };
    const processor = createRuntimeWritebackProcessor(
      config,
      new StructuredLogger(() => undefined),
      async (_input, init) => {
        authorizations.push(String((init?.headers as Record<string, string> | undefined)?.authorization));
        const body = JSON.parse(String(init?.body)) as { query?: string };
        if (body.query?.includes("issueUpdate")) {
          return jsonResponse({ data: { issueUpdate: { success: true } } });
        }
        return jsonResponse({
          data: {
            issue: {
              id: "issue-1",
              identifier: "TEST-1",
              state: { id: "state-ready", name: "Ready to Merge" },
              team: { states: { nodes: [{ id: "state-done", name: "Done" }] } },
              comments: { nodes: [] },
            },
          },
        });
      },
    );

    await processor?.enqueueAndProcess({
      kind: "transition",
      idempotencyKey: "transition:issue-1:Done",
      issueId: "issue-1",
      payload: { toState: "Done", fromStates: ["Ready to Merge"] },
    });
    await processor?.enqueueAndProcess({
      kind: "transition",
      idempotencyKey: "transition:issue-2:Done",
      issueId: "issue-2",
      projectContext: docsProjectContext,
      payload: { toState: "Done", fromStates: ["Ready to Merge"] },
    });

    expect(authorizations).toEqual([
      "default-writeback-secret",
      "default-writeback-secret",
      "docs-writeback-secret",
      "docs-writeback-secret",
    ]);
  });

  it("rejects wrong-role-only service writeback assignments in runtime writeback construction", () => {
    const config = runtimeConfig({
      credentialProfiles: {
        profiles: {
          wrong: { value: "$WRONG_LINEAR_WRITEBACK_TOKEN", capabilities: ["linear.writeback"] },
        },
        roles: {
          worker: { "linear.writeback": "wrong" },
        },
      },
      env: { WRONG_LINEAR_WRITEBACK_TOKEN: "wrong-writeback-secret" },
    });

    expect(() => createRuntimeWritebackProcessor(config, new StructuredLogger(() => undefined))).toThrow(
      /linear\.writeback is owned by service/,
    );
  });

  it("resolves status mutation auth from the worker server.open_workspace profile", () => {
    const config = runtimeConfig();

    expect(config.server.openWorkspaceToken).toBe("legacy-open-secret");
    expect(resolveStatusMutationToken(config)).toBe("open-workspace-secret");
  });

  it("rejects wrong-role-only server.open_workspace assignments before legacy fallback", () => {
    const config = runtimeConfig({
      credentialProfiles: {
        profiles: {
          wrong: { value: "$WRONG_OPEN_WORKSPACE_TOKEN", capabilities: ["server.open_workspace"] },
        },
        roles: {
          service: { "server.open_workspace": "wrong" },
        },
      },
      env: { WRONG_OPEN_WORKSPACE_TOKEN: "wrong-open-secret" },
    });

    expect(() => resolveStatusMutationToken(config)).toThrow(/server\.open_workspace is owned by worker/);
  });

  it("resolves runtime.cursor per active role and keeps cursor.runtime as a legacy alias", () => {
    const config = runtimeConfig();
    expect(resolveCursorRuntimeApiKey(config, "worker")).toBe("worker-cursor-secret");
    expect(resolveCursorRuntimeApiKey(config, "reviewer")).toBe("reviewer-cursor-secret");
    expect(resolveRuntimeCredential(config, "worker", "cursor")).toMatchObject({
      capability: "runtime.cursor",
      value: "worker-cursor-secret",
    });

    const legacyAlias = runtimeConfig({
      credentialProfiles: {
        profiles: {
          legacy: { value: "$LEGACY_CURSOR_PROFILE_TOKEN", capabilities: ["cursor.runtime"] },
        },
        roles: {
          worker: { "cursor.runtime": "legacy" },
        },
      },
      env: { LEGACY_CURSOR_PROFILE_TOKEN: "legacy-alias-secret" },
    });
    expect(resolveCursorRuntimeApiKey(legacyAlias, "worker")).toBe("legacy-alias-secret");

    const wrongRole = runtimeConfig({
      credentialProfiles: {
        profiles: {
          wrong: { value: "$WRONG_CURSOR_TOKEN", capabilities: ["runtime.cursor"] },
        },
        roles: {
          service: { "runtime.cursor": "wrong" },
        },
      },
      env: { WRONG_CURSOR_TOKEN: "wrong-cursor-secret" },
    });

    expect(() => resolveCursorRuntimeApiKey(wrongRole, "worker")).toThrow(/runtime\.cursor is owned by worker/);
  });

  it("resolves runtime.hermes per active role without falling back to Cursor credentials", () => {
    const config = runtimeConfig({
      credentialProfiles: {
        profiles: {
          "worker-hermes": { value: "$WORKER_HERMES_TOKEN", capabilities: ["runtime.hermes"] },
          "reviewer-hermes": { value: "$REVIEWER_HERMES_TOKEN", capabilities: ["runtime.hermes"] },
        },
        roles: {
          worker: { "runtime.hermes": "worker-hermes" },
          reviewer: { "runtime.hermes": "reviewer-hermes" },
        },
      },
      env: {
        WORKER_HERMES_TOKEN: "worker-hermes-secret",
        REVIEWER_HERMES_TOKEN: "reviewer-hermes-secret",
      },
    });

    expect(resolveRuntimeCredential(config, "worker", "hermes")).toMatchObject({
      capability: "runtime.hermes",
      value: "worker-hermes-secret",
    });
    expect(resolveRuntimeCredential(config, "reviewer", "hermes")).toMatchObject({
      capability: "runtime.hermes",
      value: "reviewer-hermes-secret",
    });
    expect(resolveRuntimeCredential(runtimeConfig(), "worker", "hermes")).toBeNull();

    const wrongRole = runtimeConfig({
      credentialProfiles: {
        profiles: {
          wrong: { value: "$WRONG_HERMES_TOKEN", capabilities: ["runtime.hermes"] },
        },
        roles: {
          service: { "runtime.hermes": "wrong" },
        },
      },
      env: { WRONG_HERMES_TOKEN: "wrong-hermes-secret" },
    });

    expect(() => resolveRuntimeCredential(wrongRole, "worker", "hermes")).toThrow(/runtime\.hermes is owned by worker/);
  });
});

function runtimeConfig(
  overrides: {
    credentialProfiles?: Record<string, unknown>;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  return parseServiceConfig(
    {
      tracker: { kind: "linear", api_key: "$LEGACY_LINEAR_TOKEN", project_slug: "TEST" },
      workspace: { root, state_dir: path.join(root, "state") },
      writeback: { enabled: true, mode: "live" },
      server: { open_workspace_token: "$LEGACY_OPEN_WORKSPACE_TOKEN" },
      credential_profiles:
        overrides.credentialProfiles ?? {
          profiles: {
            "linear-tracker": { value: "$LINEAR_TRACKER_TOKEN", capabilities: ["linear.tracker"] },
            "linear-writeback": { value: "$LINEAR_WRITEBACK_TOKEN", capabilities: ["linear.writeback"] },
            "worker-cursor": { value: "$WORKER_CURSOR_TOKEN", capabilities: ["runtime.cursor"] },
            "reviewer-cursor": { value: "$REVIEWER_CURSOR_TOKEN", capabilities: ["runtime.cursor"] },
            "open-workspace": { value: "$OPEN_WORKSPACE_PROFILE_TOKEN", capabilities: ["server.open_workspace"] },
          },
          roles: {
            worker: {
              "linear.tracker": "linear-tracker",
              "runtime.cursor": "worker-cursor",
              "server.open_workspace": "open-workspace",
            },
            reviewer: {
              "runtime.cursor": "reviewer-cursor",
            },
            service: {
              "linear.writeback": "linear-writeback",
            },
          },
        },
    },
    path.join(root, "WORKFLOW.md"),
    {
      LEGACY_LINEAR_TOKEN: "legacy-linear-secret",
      LINEAR_TRACKER_TOKEN: "linear-tracker-secret",
      LINEAR_WRITEBACK_TOKEN: "linear-writeback-secret",
      CURSOR_API_KEY: "legacy-cursor-secret",
      WORKER_CURSOR_TOKEN: "worker-cursor-secret",
      REVIEWER_CURSOR_TOKEN: "reviewer-cursor-secret",
      LEGACY_OPEN_WORKSPACE_TOKEN: "legacy-open-secret",
      OPEN_WORKSPACE_PROFILE_TOKEN: "open-workspace-secret",
      ...overrides.env,
    },
  );
}


function multiProjectRuntimeConfig() {
  return parseServiceConfig(
    {
      tracker: { kind: "linear", api_key: "$DEFAULT_LINEAR_READ_TOKEN", project_slug: "TEST" },
      workspace: { root, state_dir: path.join(root, "state") },
      writeback: { enabled: true, mode: "live" },
      credential_profiles: {
        profiles: {
          "default-writeback": { value: "$DEFAULT_LINEAR_WRITEBACK_TOKEN", capabilities: ["linear.writeback"] },
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
            source: { kind: "git_worktree", repository: ".", base_ref: "origin/main" },
          },
        },
        {
          id: "docs",
          tracker: { api_key: "$DOCS_LINEAR_READ_TOKEN", project_slug: "DOCS" },
          workspace: {
            source: { kind: "git_worktree", repository: ".", base_ref: "origin/main" },
          },
          credential_profiles: {
            profiles: {
              "docs-writeback": { value: "$DOCS_LINEAR_WRITEBACK_TOKEN", capabilities: ["linear.writeback"] },
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
    path.join(root, "WORKFLOW.md"),
    {
      DEFAULT_LINEAR_READ_TOKEN: "default-read-secret",
      DEFAULT_LINEAR_WRITEBACK_TOKEN: "default-writeback-secret",
      DOCS_LINEAR_READ_TOKEN: "docs-read-secret",
      DOCS_LINEAR_WRITEBACK_TOKEN: "docs-writeback-secret",
    },
  );
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentEligibleIssueContract } from "./helpers.js";
import { parseServiceConfig, type ServiceConfig } from "../src/core/config/Config.js";
import { issueBreakdownConfigFingerprint, issueContentFingerprint } from "../src/core/IssueBreakdownPlanService.js";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import { FileIssueLifecycleStore, type IssueBreakdownPlanRecord } from "../src/core/persistence/IssueLifecycleStore.js";
import type { Issue } from "../src/core/types.js";
import { writebackIdentityKey } from "../src/core/writeback/WritebackOutbox.js";
import {
  createRuntimeTrackerClient,
  createRuntimeWritebackClient,
  createRuntimeWritebackProcessor,
  resolveCursorRuntimeApiKey,
  resolveRuntimeCredential,
  resolveStatusMutationToken,
} from "../src/app/RuntimeDependencies.js";

let root: string;
const docsProjectContext = {
  projectContextId: "docs",
  projectContextLabel: "Documentation Site",
  linearProjectSlug: "DOCS",
  routingSource: "candidate_poll",
} as const;

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

  it("uses the selected project-context tracker profile and slug for scoped runtime tracker reads", async () => {
    const config = scopedRuntimeConfig();
    const seen: Array<{ authorization: string; projectSlug: string | null }> = [];

    await createRuntimeTrackerClient(config, async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { variables?: { projectSlug?: string } };
      seen.push({
        authorization: String((init?.headers as Record<string, string> | undefined)?.authorization),
        projectSlug: body.variables?.projectSlug ?? null,
      });
      return jsonResponse({ data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } });
    }, docsProjectContext).fetchCandidateIssues();

    expect(seen).toEqual([{ authorization: "docs-tracker-secret", projectSlug: "DOCS" }]);
  });

  it("uses the selected project-context legacy tracker config and slug when no scoped tracker profile exists", async () => {
    const config = scopedRuntimeConfig({ includeRootTrackerProfile: false, includeDocsTrackerProfile: false });
    const seen: Array<{ authorization: string; projectSlug: string | null }> = [];

    await createRuntimeTrackerClient(config, async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { variables?: { projectSlug?: string } };
      seen.push({
        authorization: String((init?.headers as Record<string, string> | undefined)?.authorization),
        projectSlug: body.variables?.projectSlug ?? null,
      });
      return jsonResponse({ data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } });
    }, docsProjectContext).fetchCandidateIssues();

    expect(seen).toEqual([{ authorization: "docs-legacy-linear-secret", projectSlug: "DOCS" }]);
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

  it("routes issue breakdown freshness lookup by operation project context in runtime writeback processing", async () => {
    const config = multiProjectRuntimeConfig();
    const docsProjectContext = explicitProjectContext("docs", "DOCS");
    const docsContext = config.projectContexts.byId.get("docs");
    if (!docsContext) throw new Error("expected docs project context");
    docsContext.issueBreakdown.planningLabels = ["docs-planning"];

    const docsIssue = issueFixture({
      id: "issue-docs-parent",
      identifier: "DOCS-1",
      title: "Docs parent",
      labels: ["planning"],
      updatedAt: "2026-01-03T00:00:00.000Z",
    });
    const docsConfig = runtimeConfigForProjectContext(config, docsProjectContext);
    const operationKey = "issue-create:issue-docs-parent:plan-docs:0:hash";
    const lifecycleStore = new FileIssueLifecycleStore(config.workspace.stateDir);
    await lifecycleStore.ensureIssue(
      { id: docsIssue.id, identifier: docsIssue.identifier },
      {
        projectContext: docsProjectContext,
        issueBreakdownPlans: [issueBreakdownPlanRecord({ config: docsConfig, issue: docsIssue, planId: "plan-docs", operationKey })],
        lastIssueBreakdownPlanId: "plan-docs",
      },
    );

    const calls: Array<{ authorization: string; query: string }> = [];
    const processor = createRuntimeWritebackProcessor(
      config,
      new StructuredLogger(() => undefined),
      async (_input, init) => {
        const authorization = String((init?.headers as Record<string, string> | undefined)?.authorization);
        const body = JSON.parse(String(init?.body)) as { query?: string };
        const query = body.query ?? "";
        calls.push({ authorization, query });
        if (query.includes("SymphonyIssueStates")) {
          return jsonResponse({
            data: {
              issues: {
                nodes: [linearIssueStateNode(docsIssue)],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          });
        }
        if (query.includes("SymphonyIssueCreateContext")) {
          return jsonResponse({
            data: {
              issue: {
                id: docsIssue.id,
                identifier: docsIssue.identifier,
                team: { id: "team-docs", labels: { nodes: [] } },
                project: { id: "project-docs" },
                children: { nodes: [] },
              },
            },
          });
        }
        if (query.includes("issueCreate")) {
          return jsonResponse({
            data: {
              issueCreate: {
                success: true,
                issue: { id: "child-1", identifier: "DOCS-2", url: "https://linear.example/DOCS-2" },
              },
            },
          });
        }
        throw new Error(`unexpected query: ${query}`);
      },
      { lifecycleStore },
    );

    const result = await processor?.enqueueAndProcess({
      kind: "issue_create",
      idempotencyKey: operationKey,
      issueId: docsIssue.id,
      runId: "run-plan-docs",
      projectContext: docsProjectContext,
      payload: {
        parentIssueId: docsIssue.id,
        title: "Docs child",
        description: agentEligibleIssueContract(),
        acceptanceCriteria: ["Docs child created"],
        requestedLabels: [],
        dependencies: [],
        dedupeKey: "issue-breakdown:plan-docs:0:hash",
        payloadHash: "hash",
        planId: "plan-docs",
        proposedIssueIndex: 0,
      },
    });

    expect(result).toMatchObject({ status: "succeeded" });
    expect(calls.map((call) => call.authorization)).toEqual([
      "docs-read-secret",
      "docs-writeback-secret",
      "docs-writeback-secret",
    ]);
    expect(calls[0]?.query).toContain("SymphonyIssueStates");
    expect(calls[1]?.query).toContain("SymphonyIssueCreateContext");
    expect(calls[2]?.query).toContain("issueCreate");
  });

  it("fails closed for explicit unknown project contexts before runtime writeback execution", async () => {
    const config = runtimeConfig();
    const authorizations: string[] = [];
    const processor = createRuntimeWritebackProcessor(
      config,
      new StructuredLogger(() => undefined),
      async (_input, init) => {
        authorizations.push(String((init?.headers as Record<string, string> | undefined)?.authorization));
        return jsonResponse({ data: { issueUpdate: { success: true } } });
      },
    );

    const result = await processor?.enqueueAndProcess({
      kind: "transition",
      idempotencyKey: "transition:issue-unknown:Done",
      issueId: "issue-unknown",
      projectContext: explicitProjectContext("docs", "DOCS"),
      payload: { toState: "Done", fromStates: ["Ready to Merge"] },
    });

    expect(result).toMatchObject({ status: "retrying" });
    expect(result?.lastError).toContain('Resolved project context "docs" is not configured');
    expect(authorizations).toEqual([]);
  });

  it("uses the selected project-context linear.writeback profile for scoped writeback drains", async () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LEGACY_LINEAR_TOKEN", project_slug: "SYM" },
        workspace: {
          root,
          state_dir: path.join(root, "state"),
          source: { kind: "copy", path: root },
        },
        writeback: { enabled: true, mode: "live" },
        credential_profiles: {
          profiles: {
            "linear-tracker": { value: "$LINEAR_TRACKER_TOKEN", capabilities: ["linear.tracker"] },
            "linear-writeback": { value: "$LINEAR_WRITEBACK_TOKEN", capabilities: ["linear.writeback"] },
          },
          roles: {
            worker: { "linear.tracker": "linear-tracker" },
            service: { "linear.writeback": "linear-writeback" },
          },
        },
        project_contexts: [
          {
            id: "symphony",
            label: "Symphony",
            tracker: { project_slug: "SYM" },
            workspace: { source: { kind: "copy", path: root } },
          },
          {
            id: "docs",
            label: "Documentation Site",
            tracker: { api_key: "$DOCS_LEGACY_LINEAR_TOKEN", project_slug: "DOCS" },
            workspace: { source: { kind: "copy", path: root } },
            credential_profiles: {
              profiles: {
                "docs-tracker": { value: "$DOCS_TRACKER_TOKEN", capabilities: ["linear.tracker"] },
                "docs-writeback": { value: "$DOCS_WRITEBACK_TOKEN", capabilities: ["linear.writeback"] },
              },
              roles: {
                worker: { "linear.tracker": "docs-tracker" },
                service: { "linear.writeback": "docs-writeback" },
              },
            },
          },
        ],
      },
      path.join(root, "WORKFLOW.md"),
      {
        LEGACY_LINEAR_TOKEN: "legacy-linear-secret",
        LINEAR_TRACKER_TOKEN: "linear-tracker-secret",
        LINEAR_WRITEBACK_TOKEN: "linear-writeback-secret",
        DOCS_LEGACY_LINEAR_TOKEN: "docs-legacy-linear-secret",
        DOCS_TRACKER_TOKEN: "docs-tracker-secret",
        DOCS_WRITEBACK_TOKEN: "docs-writeback-secret",
      },
    );
    const authorizations: string[] = [];
    const processor = createRuntimeWritebackProcessor(
      config,
      new StructuredLogger(() => undefined),
      async (_input, init) => {
        authorizations.push(String((init?.headers as Record<string, string> | undefined)?.authorization));
        return jsonResponse({ data: { issueUpdate: { success: true } } });
      },
    );

    await processor?.enqueueAndProcess({
      kind: "transition",
      idempotencyKey: "transition:issue-docs-1:In Review",
      issueId: "issue-docs-1",
      projectContext: {
        projectContextId: "docs",
        projectContextLabel: "Documentation Site",
        linearProjectSlug: "DOCS",
        routingSource: "candidate_poll",
      },
      payload: { toState: "In Review", fromStates: ["In Progress"] },
    });

    expect(authorizations).toEqual(["docs-writeback-secret"]);
  });

  it("treats legacy default project context as the configured runtime default for scoped writeback drains", async () => {
    const config = parseServiceConfig(
      {
        tracker: { kind: "linear", api_key: "$LEGACY_LINEAR_TOKEN", project_slug: "SYM" },
        workspace: {
          root,
          state_dir: path.join(root, "state"),
          source: { kind: "copy", path: root },
        },
        writeback: { enabled: true, mode: "live" },
        credential_profiles: {
          profiles: {
            "linear-tracker": { value: "$LINEAR_TRACKER_TOKEN", capabilities: ["linear.tracker"] },
            "linear-writeback": { value: "$LINEAR_WRITEBACK_TOKEN", capabilities: ["linear.writeback"] },
          },
          roles: {
            worker: { "linear.tracker": "linear-tracker" },
            service: { "linear.writeback": "linear-writeback" },
          },
        },
        project_contexts: [
          {
            id: "symphony",
            label: "Symphony",
            tracker: { project_slug: "SYM" },
            workspace: { source: { kind: "copy", path: root } },
          },
          {
            id: "docs",
            label: "Documentation Site",
            tracker: { api_key: "$DOCS_LEGACY_LINEAR_TOKEN", project_slug: "DOCS" },
            workspace: { source: { kind: "copy", path: root } },
            credential_profiles: {
              profiles: {
                "docs-tracker": { value: "$DOCS_TRACKER_TOKEN", capabilities: ["linear.tracker"] },
                "docs-writeback": { value: "$DOCS_WRITEBACK_TOKEN", capabilities: ["linear.writeback"] },
              },
              roles: {
                worker: { "linear.tracker": "docs-tracker" },
                service: { "linear.writeback": "docs-writeback" },
              },
            },
          },
        ],
      },
      path.join(root, "WORKFLOW.md"),
      {
        LEGACY_LINEAR_TOKEN: "legacy-linear-secret",
        LINEAR_TRACKER_TOKEN: "linear-tracker-secret",
        LINEAR_WRITEBACK_TOKEN: "linear-writeback-secret",
        DOCS_LEGACY_LINEAR_TOKEN: "docs-legacy-linear-secret",
        DOCS_TRACKER_TOKEN: "docs-tracker-secret",
        DOCS_WRITEBACK_TOKEN: "docs-writeback-secret",
      },
    );
    const authorizations: string[] = [];
    const processor = createRuntimeWritebackProcessor(
      config,
      new StructuredLogger(() => undefined),
      async (_input, init) => {
        authorizations.push(String((init?.headers as Record<string, string> | undefined)?.authorization));
        return jsonResponse({ data: { issueUpdate: { success: true } } });
      },
    );

    await processor?.enqueueAndProcess({
      kind: "transition",
      idempotencyKey: "transition:issue-symphony-1:In Review",
      issueId: "issue-symphony-1",
      payload: { toState: "In Review", fromStates: ["In Progress"] },
    });

    expect(authorizations).toEqual(["linear-writeback-secret"]);
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

  it("uses the selected project-context writeback profile and slug for scoped runtime writeback clients", async () => {
    const config = scopedRuntimeConfig();
    const seen: Array<{ authorization: string; projectSlug: string | null }> = [];

    await createRuntimeWritebackClient(config, async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { variables?: { projectSlug?: string } };
      seen.push({
        authorization: String((init?.headers as Record<string, string> | undefined)?.authorization),
        projectSlug: body.variables?.projectSlug ?? null,
      });
      return jsonResponse({ data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } });
    }, docsProjectContext).fetchCandidateIssues();

    expect(seen).toEqual([{ authorization: "docs-writeback-secret", projectSlug: "DOCS" }]);
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

function scopedRuntimeConfig(
  options: {
    includeRootTrackerProfile?: boolean;
    includeDocsTrackerProfile?: boolean;
    includeDocsWritebackProfile?: boolean;
  } = {},
) {
  const includeRootTrackerProfile = options.includeRootTrackerProfile ?? true;
  const includeDocsTrackerProfile = options.includeDocsTrackerProfile ?? true;
  const includeDocsWritebackProfile = options.includeDocsWritebackProfile ?? true;

  const docsProfiles: Record<string, unknown> = {};
  const docsWorkerRoles: Record<string, string> = {};
  const docsServiceRoles: Record<string, string> = {};
  if (includeDocsTrackerProfile) {
    docsProfiles["docs-tracker"] = { value: "$DOCS_TRACKER_TOKEN", capabilities: ["linear.tracker"] };
    docsWorkerRoles["linear.tracker"] = "docs-tracker";
  }
  if (includeDocsWritebackProfile) {
    docsProfiles["docs-writeback"] = { value: "$DOCS_WRITEBACK_TOKEN", capabilities: ["linear.writeback"] };
    docsServiceRoles["linear.writeback"] = "docs-writeback";
  }

  return parseServiceConfig(
    {
      tracker: { kind: "linear", api_key: "$LEGACY_LINEAR_TOKEN", project_slug: "SYM" },
      workspace: {
        root,
        state_dir: path.join(root, "state"),
        source: { kind: "copy", path: root },
      },
      writeback: { enabled: true, mode: "live" },
      credential_profiles: {
        profiles: {
          ...(includeRootTrackerProfile
            ? { "linear-tracker": { value: "$LINEAR_TRACKER_TOKEN", capabilities: ["linear.tracker"] } }
            : {}),
          "linear-writeback": { value: "$LINEAR_WRITEBACK_TOKEN", capabilities: ["linear.writeback"] },
        },
        roles: {
          ...(includeRootTrackerProfile ? { worker: { "linear.tracker": "linear-tracker" } } : {}),
          service: { "linear.writeback": "linear-writeback" },
        },
      },
      project_contexts: [
        {
          id: "symphony",
          label: "Symphony",
          tracker: { project_slug: "SYM" },
          workspace: { source: { kind: "copy", path: root } },
        },
        {
          id: "docs",
          label: "Documentation Site",
          tracker: { api_key: "$DOCS_LEGACY_LINEAR_TOKEN", project_slug: "DOCS" },
          workspace: { source: { kind: "copy", path: root } },
          ...(Object.keys(docsProfiles).length === 0
            ? {}
            : {
                credential_profiles: {
                  profiles: docsProfiles,
                  roles: {
                    ...(Object.keys(docsWorkerRoles).length === 0 ? {} : { worker: docsWorkerRoles }),
                    ...(Object.keys(docsServiceRoles).length === 0 ? {} : { service: docsServiceRoles }),
                  },
                },
              }),
        },
      ],
    },
    path.join(root, "WORKFLOW.md"),
    {
      LEGACY_LINEAR_TOKEN: "legacy-linear-secret",
      LINEAR_TRACKER_TOKEN: "linear-tracker-secret",
      LINEAR_WRITEBACK_TOKEN: "linear-writeback-secret",
      DOCS_LEGACY_LINEAR_TOKEN: "docs-legacy-linear-secret",
      DOCS_TRACKER_TOKEN: "docs-tracker-secret",
      DOCS_WRITEBACK_TOKEN: "docs-writeback-secret",
    },
  );
}

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

function explicitProjectContext(projectContextId: string, linearProjectSlug: string) {
  return {
    projectContextId,
    projectContextLabel: projectContextId === "docs" ? "Documentation Site" : projectContextId,
    linearProjectSlug,
    routingSource: "explicit",
  };
}

function runtimeConfigForProjectContext(config: ServiceConfig, projectContext = explicitProjectContext("docs", "DOCS")): ServiceConfig {
  const context = config.projectContexts.byId.get(projectContext.projectContextId);
  if (!context) {
    throw new Error(`expected configured project context ${projectContext.projectContextId}`);
  }
  if (context.id === config.projectContexts.defaultContextId) {
    return config;
  }
  return {
    ...config,
    tracker: context.tracker,
    workspace: context.workspace,
    agent: context.agent,
    issueBreakdown: context.issueBreakdown,
    github: context.github,
    reviewLoop: context.reviewLoop,
    credentialProfiles: context.credentialProfileRegistry,
  };
}

function issueFixture(overrides: Partial<Issue> = {}): Issue {
  return {
    id: overrides.id ?? "issue-1",
    identifier: overrides.identifier ?? "TEST-1",
    title: overrides.title ?? "Parent issue",
    description: overrides.description ?? "Parent issue description",
    priority: overrides.priority ?? 0,
    labels: overrides.labels ?? ["planning"],
    blockedBy: overrides.blockedBy ?? [],
    state: overrides.state ?? "Todo",
    assigneeId: overrides.assigneeId ?? null,
    delegateId: overrides.delegateId ?? null,
    assignedToWorker: overrides.assignedToWorker ?? true,
    branchName: overrides.branchName ?? null,
    url: overrides.url ?? null,
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
  };
}

function linearIssueStateNode(issue: Issue) {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    branchName: issue.branchName,
    url: issue.url,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    state: { name: issue.state },
    assignee: issue.assigneeId ? { id: issue.assigneeId } : null,
    delegate: issue.delegateId ? { id: issue.delegateId } : null,
    labels: { nodes: issue.labels.map((name) => ({ name })) },
    inverseRelations: { nodes: [] },
  };
}

function issueBreakdownPlanRecord(input: {
  config: ServiceConfig;
  issue: Issue;
  planId: string;
  operationKey: string;
}): IssueBreakdownPlanRecord {
  return {
    id: input.planId,
    idempotencyKey: `${input.planId}:idem`,
    requestHash: `${input.planId}:request`,
    runId: "run-plan-docs",
    issueId: input.issue.id,
    issueIdentifier: input.issue.identifier,
    projectContext: explicitProjectContext("docs", "DOCS"),
    summary: "Split docs work into a child issue.",
    proposedIssues: [
      {
        title: "Docs child",
        description: agentEligibleIssueContract(),
        acceptanceCriteria: ["Docs child created"],
        dependencies: [],
        labels: [],
      },
    ],
    transcriptPointers: [],
    statusApiPointers: [],
    issueUpdatedAt: input.issue.updatedAt,
    issueContentFingerprint: issueContentFingerprint(input.issue),
    configFingerprint: issueBreakdownConfigFingerprint(input.config),
    cursorMode: input.config.issueBreakdown.cursorMode,
    acceptedAt: "2026-01-03T00:00:00.000Z",
    applicationStatus: "pending",
    applicationOperationKeys: [writebackIdentityKey(input.operationKey, explicitProjectContext("docs", "DOCS"))],
    createdIssueRefs: [],
    appliedAt: null,
    applicationBlockedReason: null,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

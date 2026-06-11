import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseServiceConfig } from "../src/core/config/Config.js";
import {
  resolveProjectContextForIssue,
  type ProjectContextRoutingResult,
  type ProjectContextResolution,
} from "../src/core/config/ProjectContexts.js";
import { FileIssueLifecycleStore } from "../src/core/persistence/IssueLifecycleStore.js";
import {
  issue,
  multiProjectWorkflowConfig,
  projectContextFixture,
  trackerIssue,
  type TestProjectContextFixture,
} from "./helpers.js";

describe("project context routing contract", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-project-context-routing-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("resolves the single enabled context match from tracked Linear project metadata", () => {
    const config = projectConfig([
      projectContextFixture({ id: "symphony", label: "Symphony", projectSlug: "SYMPHONY", repository: "." }),
      projectContextFixture({ id: "docs", label: "Documentation Site", projectSlug: "DOCS" }),
    ]);

    const result = resolveProjectContextForIssue(
      {
        ...issue({ id: "issue-docs-1", identifier: "DOCS-1" }),
        linearProjectIdentity: { slug: "DOCS" },
        routingSource: "candidate_poll",
      },
      config.projectContexts,
    );

    expect(expectResolvedProjectContext(result)).toEqual({
      projectContextId: "docs",
      projectContextLabel: "Documentation Site",
      linearProjectSlug: "DOCS",
      routingSource: "candidate_poll",
    });
  });

  it("fails closed when no enabled context matches the issue", () => {
    const config = projectConfig([
      projectContextFixture({ id: "symphony", label: "Symphony", projectSlug: "SYMPHONY", repository: "." }),
      projectContextFixture({ id: "docs", label: "Documentation Site", projectSlug: "DOCS" }),
    ]);

    const result = resolveProjectContextForIssue(
      {
        ...issue({ id: "issue-ops-1", identifier: "OPS-1" }),
        linearProjectIdentity: { slug: "OPS" },
        routingSource: "candidate_poll",
      },
      config.projectContexts,
    );

    expect(result).toMatchObject({
      kind: "problem",
      problem: {
        reason: "missing_context",
        issueId: "issue-ops-1",
        issueIdentifier: "OPS-1",
        candidateContextIds: [],
      },
    });
  });

  it("fails closed when more than one enabled context matches the issue", () => {
    const config = projectConfig([
      projectContextFixture({ id: "docs", label: "Documentation Site", projectSlug: "DOCS" }),
      projectContextFixture({ id: "docs-staging", label: "Documentation Staging", projectSlug: "DOCS" }),
    ]);

    const result = resolveProjectContextForIssue(
      {
        ...issue({ id: "issue-docs-2", identifier: "DOCS-2" }),
        linearProjectIdentity: { slug: "DOCS" },
        routingSource: "candidate_poll",
      },
      config.projectContexts,
    );

    expect(result).toMatchObject({
      kind: "problem",
      problem: {
        reason: "ambiguous_context",
        issueId: "issue-docs-2",
        issueIdentifier: "DOCS-2",
        candidateContextIds: ["docs", "docs-staging"],
      },
    });
  });

  it("fails closed when the only matching context is disabled", () => {
    const config = projectConfig([
      projectContextFixture({ id: "symphony", label: "Symphony", projectSlug: "SYMPHONY", repository: "." }),
      projectContextFixture({ id: "docs", label: "Documentation Site", projectSlug: "DOCS", enabled: false }),
    ]);

    const result = resolveProjectContextForIssue(
      {
        ...issue({ id: "issue-docs-3", identifier: "DOCS-3" }),
        linearProjectIdentity: { slug: "DOCS" },
        routingSource: "candidate_poll",
      },
      config.projectContexts,
    );

    expect(result).toMatchObject({
      kind: "problem",
      problem: {
        reason: "disabled_context",
        issueId: "issue-docs-3",
        issueIdentifier: "DOCS-3",
        candidateContextIds: ["docs"],
      },
    });
  });

  it.each(["replay", "state_refresh"] as const)(
    "preserves explicit project context metadata for %s sources even after config drift",
    (routingSource) => {
      const config = projectConfig([
        projectContextFixture({ id: "symphony", label: "Symphony", projectSlug: "SYMPHONY", repository: "." }),
      ]);

      const result = resolveProjectContextForIssue(
        trackerIssue({
          id: `issue-${routingSource}`,
          identifier: `DOCS-${routingSource.toUpperCase()}`,
          projectContextId: "docs",
          projectContextLabel: "Documentation Site",
          linearProjectSlug: "DOCS",
          routingSource,
        }),
        config.projectContexts,
      );

      expect(expectResolvedProjectContext(result)).toEqual({
        projectContextId: "docs",
        projectContextLabel: "Documentation Site",
        linearProjectSlug: "DOCS",
        routingSource,
      });
    },
  );

  it("reuses persisted project context after config reload disables the original context", async () => {
    const lifecycleStore = new FileIssueLifecycleStore(root);
    const initialConfig = projectConfig([
      projectContextFixture({ id: "symphony", label: "Symphony", projectSlug: "SYMPHONY", repository: "." }),
      projectContextFixture({ id: "docs", label: "Documentation Site", projectSlug: "DOCS" }),
    ]);
    const candidate = {
      ...issue({ id: "issue-docs-persisted", identifier: "DOCS-9" }),
      linearProjectIdentity: { slug: "DOCS" },
      routingSource: "candidate_poll",
    };

    const firstResolution = expectResolvedProjectContext(
      resolveProjectContextForIssue(candidate, initialConfig.projectContexts),
    );
    await lifecycleStore.ensureIssue(issue({ id: candidate.id, identifier: candidate.identifier }), {
      phase: "implementation",
      projectContext: firstResolution,
    });

    const reloadedStore = new FileIssueLifecycleStore(root);
    const reloadedRecord = await reloadedStore.get(candidate.identifier);
    const persistedContext = reloadedRecord?.projectContext;
    expect(persistedContext).toBeDefined();
    if (!persistedContext) {
      throw new Error("Expected persisted project context after initial lifecycle write");
    }
    const reloadedConfig = projectConfig([
      projectContextFixture({ id: "symphony", label: "Symphony", projectSlug: "SYMPHONY", repository: "." }),
      projectContextFixture({ id: "docs", label: "Documentation Site", projectSlug: "DOCS", enabled: false }),
    ]);

    const reusedResolution = resolveProjectContextForIssue(
      issue({ id: candidate.id, identifier: candidate.identifier, updatedAt: "2026-01-02T00:00:00Z" }),
      reloadedConfig.projectContexts,
      { persistedContext },
    );

    expect(expectResolvedProjectContext(reusedResolution)).toEqual(firstResolution);
  });
});

function projectConfig(projectContexts: TestProjectContextFixture[]): ReturnType<typeof parseServiceConfig> {
  return parseServiceConfig(
    multiProjectWorkflowConfig({ projectContexts }),
    "/repo/WORKFLOW.md",
    { LINEAR_API_KEY: "linear-test-key" },
  );
}

function expectResolvedProjectContext(result: ProjectContextRoutingResult): ProjectContextResolution {
  expect(result.kind).toBe("resolved");
  if (result.kind !== "resolved") {
    throw new Error(`Expected resolved project context, received ${result.problem.reason}`);
  }
  return result.projectContext;
}

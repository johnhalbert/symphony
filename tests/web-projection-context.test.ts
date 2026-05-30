import { describe, expect, it } from "vitest";
import {
  createWebProjectionCacheKey,
  createWebProjectionCacheMetadata,
  createWebProjectionFingerprint,
  isWebProjectionRefreshRequested,
  shouldForceWebProjectionRefresh,
  webProjectionAliasesFromValues,
  webProjectionIssueKeyAliases,
  type WebProjectionContext,
  type WebProjectionSourceIndex,
} from "../src/app/WebProjectionContext.js";

type AssertFalse<T extends false> = T;
type SourceIndexRequiresTranscriptEvents = WebProjectionSourceIndex extends { transcriptEvents: readonly unknown[] } ? true : false;
const sourceIndexDoesNotRequireTranscriptEvents: AssertFalse<SourceIndexRequiresTranscriptEvents> = false;

describe("WebProjectionContext contracts and cache key utilities", () => {
  it("normalizes issue key aliases by trimming, dropping empty values, deduping, and preserving stable field order", () => {
    const aliases = webProjectionIssueKeyAliases(
      {
        issueId: " issue-id-1 ",
        issueIdentifier: " ENG-1 ",
        workspaceKey: "   ",
        runId: null,
        sessionId: " session-1 ",
      },
      {
        issueId: "issue-id-1",
        issueIdentifier: "ENG-1",
        workspaceKey: " ws-1 ",
        runId: " run-1 ",
        sessionId: "session-1",
      },
      {
        issueId: undefined,
        issueIdentifier: "ENG-1",
        workspaceKey: "ws-1",
        runId: "run-1",
        sessionId: "",
      },
    );

    expect(aliases).toEqual(["issue-id-1", "ENG-1", "session-1", "ws-1", "run-1"]);
    expect(webProjectionIssueKeyAliases(
      {
        issueId: " issue-id-1 ",
        issueIdentifier: " ENG-1 ",
        workspaceKey: "   ",
        runId: null,
        sessionId: " session-1 ",
      },
      {
        issueId: "issue-id-1",
        issueIdentifier: "ENG-1",
        workspaceKey: " ws-1 ",
        runId: " run-1 ",
        sessionId: "session-1",
      },
      {
        issueId: undefined,
        issueIdentifier: "ENG-1",
        workspaceKey: "ws-1",
        runId: "run-1",
        sessionId: "",
      },
    )).toEqual(aliases);
  });

  it("normalizes free-form alias lists for cache key construction", () => {
    expect(webProjectionAliasesFromValues([" ENG-1 ", null, "", "issue-id-1", "ENG-1", undefined, " session-1 "])).toEqual([
      "ENG-1",
      "issue-id-1",
      "session-1",
    ]);
  });

  it("creates deterministic cache keys with trimmed aliases and sorted dimensions", () => {
    const first = createWebProjectionCacheKey({
      namespace: " web/issues ",
      aliases: [" ENG-1 ", "", "ENG-1", " issue-id-1 "],
      dimensions: {
        state: [" Todo ", "In Review", "Todo"],
        refresh: false,
        empty: "   ",
        cursor: null,
        page: 2,
      },
    });
    const second = createWebProjectionCacheKey({
      namespace: "web/issues",
      aliases: ["ENG-1", "issue-id-1"],
      dimensions: {
        page: 2,
        cursor: null,
        empty: undefined,
        refresh: false,
        state: ["Todo", "In Review"],
      },
    });

    expect(first).toBe("web%2Fissues|aliases=ENG-1,issue-id-1|page=2|refresh=false|state=Todo,In%20Review");
    expect(second).toBe(first);
  });

  it("recognizes forced refresh query semantics without treating other values as refresh requests", () => {
    expect(isWebProjectionRefreshRequested("1")).toBe(true);
    expect(isWebProjectionRefreshRequested(" true ")).toBe(true);
    expect(isWebProjectionRefreshRequested(true)).toBe(true);
    expect(isWebProjectionRefreshRequested(1)).toBe(true);
    expect(isWebProjectionRefreshRequested("0")).toBe(false);
    expect(isWebProjectionRefreshRequested("false")).toBe(false);
    expect(isWebProjectionRefreshRequested(false)).toBe(false);
    expect(shouldForceWebProjectionRefresh({ refresh: "false", forceRefresh: true })).toBe(true);
  });

  it("allows a shared source index and context without hydrating full transcript event arrays", () => {
    expect(sourceIndexDoesNotRequireTranscriptEvents).toBe(false);

    const sourceIndex = {
      generatedAt: "2026-01-01T00:00:00.000Z",
      runtime: {
        generatedAt: "2026-01-01T00:00:00.000Z",
        snapshot: { running: [] },
        runningByAlias: new Map<string, never>(),
      },
      trackerIssues: {
        fetchedStateKey: "Todo,In Progress,In Review",
        issues: [],
        byAlias: new Map<string, never>(),
      },
      runs: {
        runs: [],
        byAlias: new Map<string, readonly never[]>(),
        latestByAlias: new Map<string, never>(),
        transcriptEventCountsByRunId: new Map<string, number | null>([["run-1", 3]]),
      },
      workspaces: {
        workspaces: [],
        byAlias: new Map<string, never>(),
      },
      lifecycles: {
        records: [],
        byAlias: new Map<string, never>(),
      },
      transcript: {
        hydration: "excluded",
        eventCountsByRunId: new Map<string, number | null>([["run-1", 3]]),
      },
      durableSourceRevisions: [],
    } satisfies WebProjectionSourceIndex;

    const context: WebProjectionContext<typeof sourceIndex> = {
      metadata: createWebProjectionCacheMetadata({
        builtAt: "2026-01-01T00:00:00.000Z",
        maxAgeMs: 1_000,
        fingerprint: createWebProjectionFingerprint({
          runtimeGeneratedAt: "2026-01-01T00:00:00.000Z",
          issueBoardStates: ["Todo", "In Progress", "In Review"],
          issueBoardColumns: ["todo", "progress", "review"],
          durableSourceRevisions: [{ source: "runs", revision: "run-1", observedAt: "2026-01-01T00:00:00.000Z" }],
        }),
      }),
      sourceIndex,
      projections: {},
    };

    expect(context.metadata).toMatchObject({
      builtAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:00:01.000Z",
      maxAgeMs: 1_000,
    });
    expect(context.sourceIndex.transcript).toEqual({
      hydration: "excluded",
      eventCountsByRunId: new Map<string, number | null>([["run-1", 3]]),
    });
    expect("events" in context.sourceIndex.transcript).toBe(false);
  });
});

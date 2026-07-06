import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqliteMergeQueueStore } from "../src/core/orchestration/SqliteMergeQueueStore.js";

describe("SqliteMergeQueueStore", () => {
  let root: string;
  const stores: SqliteMergeQueueStore[] = [];

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-merge-queue-"));
  });

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()));
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 25,
    });
  });

  it("claims, blocks other issues, releases only the active issue, and persists history", async () => {
    const store = new SqliteMergeQueueStore(root);
    stores.push(store);

    await expect(store.getCurrent()).resolves.toMatchObject({
      activeIssueId: null,
      sequence: 0,
    });

    const first = await store.claim(issue("issue-1", "TEST-1"), "ready");
    expect(first).toMatchObject({
      status: "claimed",
      snapshot: {
        activeIssueId: "issue-1",
        activeIssueIdentifier: "TEST-1",
        sequence: 1,
        reason: "ready",
      },
    });
    expect(first.snapshot.leaseId).toMatch(/^merge-queue-lease:/);
    await expect(
      access(path.join(root, "merge-queue.sqlite")),
    ).resolves.toBeUndefined();

    await expect(
      store.claim(issue("issue-1", "TEST-1"), "same"),
    ).resolves.toMatchObject({
      status: "already_active",
      snapshot: { activeIssueId: "issue-1", sequence: 1 },
    });
    await expect(
      store.claim(issue("issue-2", "TEST-2"), "blocked"),
    ).resolves.toMatchObject({
      status: "blocked_by_active_issue",
      snapshot: { activeIssueId: "issue-1", sequence: 1 },
    });
    await expect(
      store.releaseIfActive(issue("issue-2", "TEST-2"), "wrong"),
    ).resolves.toMatchObject({
      status: "not_active_issue",
      snapshot: { activeIssueId: "issue-1", sequence: 1 },
    });

    await expect(
      store.releaseIfActive(issue("issue-1", "TEST-1"), "done"),
    ).resolves.toMatchObject({
      status: "released",
      snapshot: {
        activeIssueId: null,
        leaseId: null,
        sequence: 2,
        reason: "done",
      },
    });

    const reloaded = new SqliteMergeQueueStore(root);
    stores.push(reloaded);
    await expect(reloaded.getCurrent()).resolves.toMatchObject({
      activeIssueId: null,
      sequence: 2,
      reason: "done",
    });
    await expect(reloaded.listHistory()).resolves.toMatchObject([
      {
        event: "claim",
        issueId: "issue-1",
        activeIssueId: "issue-1",
        sequence: 1,
      },
      {
        event: "release",
        issueId: "issue-1",
        activeIssueId: null,
        sequence: 2,
      },
    ]);
  });

  it("allows only one winner when two store instances race to claim", async () => {
    const firstStore = new SqliteMergeQueueStore(root);
    const secondStore = new SqliteMergeQueueStore(root);
    stores.push(firstStore, secondStore);

    const results = await Promise.all([
      firstStore.claim(issue("issue-1", "TEST-1"), "race"),
      secondStore.claim(issue("issue-2", "TEST-2"), "race"),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      "blocked_by_active_issue",
      "claimed",
    ]);
    const current = await firstStore.getCurrent();
    expect(current.activeIssueId).toMatch(/^issue-[12]$/);
    expect(current.sequence).toBe(1);
    await expect(firstStore.listHistory()).resolves.toHaveLength(1);
  });
});

function issue(id: string, identifier: string) {
  return { id, identifier };
}

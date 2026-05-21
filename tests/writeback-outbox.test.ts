import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StructuredLogger } from "../src/core/logging/StructuredLogger.js";
import type { TrackerCommentInput, TrackerTransitionInput, TrackerWriteResult, TrackerWriter } from "../src/core/tracker/TrackerWriter.js";
import { FileWritebackOutboxStore, WritebackProcessor } from "../src/core/writeback/WritebackOutbox.js";

describe("FileWritebackOutboxStore", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "symphony-writeback-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("enqueues idempotently and processes due operations", async () => {
    const store = new FileWritebackOutboxStore(root);
    const writer = new FakeWriter();
    const processor = new WritebackProcessor(store, writer, new StructuredLogger(() => undefined), 300_000);

    await processor.enqueueAndProcess({
      idempotencyKey: "transition:issue-1:dispatch",
      kind: "transition",
      issueId: "issue-1",
      payload: { fromStates: ["Todo"], toState: "In Progress" },
    });
    await processor.enqueueAndProcess({
      idempotencyKey: "transition:issue-1:dispatch",
      kind: "transition",
      issueId: "issue-1",
      payload: { fromStates: ["Todo"], toState: "In Progress" },
    });

    const records = await store.list();
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe("succeeded");
    expect(writer.transitions).toHaveLength(1);
  });
});

class FakeWriter implements TrackerWriter {
  readonly transitions: TrackerTransitionInput[] = [];
  readonly comments: TrackerCommentInput[] = [];

  async transitionIssueState(input: TrackerTransitionInput): Promise<TrackerWriteResult> {
    this.transitions.push(input);
    return { status: "applied" };
  }

  async createIssueComment(input: TrackerCommentInput): Promise<TrackerWriteResult> {
    this.comments.push(input);
    return { status: "applied" };
  }
}

import type { IssueLifecycleRecord } from "./IssueLifecycleStore.js";
import type { RunTranscriptStore } from "./RunTranscriptStore.js";

export async function appendLaneMemoTelemetry(
  runStore: Pick<RunTranscriptStore, "appendEvent"> | undefined,
  runId: string | null | undefined,
  lifecycle: IssueLifecycleRecord,
  source: string,
): Promise<void> {
  if (!runStore || !runId) return;
  await runStore.appendEvent({
    runId,
    at: new Date().toISOString(),
    source: "orchestrator",
    eventType: "lane_memo_updated",
    message: `Lane memo updated by ${source} (${lifecycle.handoff.memo.sizeChars} char(s))`,
    payload: {
      issueId: lifecycle.issueId,
      issueIdentifier: lifecycle.issueIdentifier,
      source,
      reviewRound: lifecycle.handoff.memo.reviewRound,
      incompleteTurnCount: lifecycle.handoff.memo.incompleteTurnCount,
      memoSizeChars: lifecycle.handoff.memo.sizeChars,
      entries: lifecycle.handoff.memo.entries.length,
      openFindings: lifecycle.handoff.memo.openFindings.length,
    },
  });
}

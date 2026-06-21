import {
  createIssueHistorySnapshotId,
  createTransitionId,
  type IssueCurrentStateSnapshot,
  type IssueHistorySnapshot,
  type IssueTransitionRequest,
  type TransitionRuleset,
} from "./IssueOrchestrationState.js";

export class IssueOrchestrationEngine {
  private readonly rulesets: TransitionRuleset[];

  constructor(rulesets: readonly TransitionRuleset[]) {
    this.rulesets = [...rulesets].sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
  }

  registeredRulesets(): readonly TransitionRuleset[] {
    return this.rulesets;
  }

  decide(
    snapshot: IssueCurrentStateSnapshot,
    history: readonly IssueHistorySnapshot[],
  ): IssueHistorySnapshot | null {
    for (const ruleset of this.rulesets) {
      const request = ruleset.evaluate(snapshot, history);
      if (request === null) continue;
      return issueHistorySnapshotFromRequest(snapshot, request, ruleset);
    }
    return null;
  }

  replay(history: readonly IssueHistorySnapshot[]): IssueHistoryReplayResult[] {
    return history.map((snapshot, index) => {
      if (snapshot.snapshotKind === "evidence" || snapshot.transitionKind === "record_evidence") {
        return {
          historySnapshotId: snapshot.historySnapshotId,
          replayable: false,
          matched: true,
          expectedTransitionKind: snapshot.transitionKind,
          expectedRulesetId: snapshot.rulesetId,
          expectedRulesetVersion: normalizeRulesetVersion(snapshot),
          expectedRulesetFingerprint: normalizeRulesetFingerprint(snapshot),
          expectedReason: snapshot.reason,
          actualTransitionKind: null,
          actualRulesetId: null,
          actualRulesetVersion: null,
          actualRulesetFingerprint: null,
          actualReason: null,
        };
      }
      const actual = this.decide(snapshot, history.slice(0, index));
      const matched =
        actual !== null &&
        actual.transitionKind === snapshot.transitionKind &&
        actual.rulesetId === snapshot.rulesetId &&
        actual.rulesetVersion === normalizeRulesetVersion(snapshot) &&
        actual.rulesetFingerprint === normalizeRulesetFingerprint(snapshot) &&
        actual.reason === snapshot.reason;
      return {
        historySnapshotId: snapshot.historySnapshotId,
        replayable: true,
        matched,
        expectedTransitionKind: snapshot.transitionKind,
        expectedRulesetId: snapshot.rulesetId,
        expectedReason: snapshot.reason,
        actualTransitionKind: actual?.transitionKind ?? null,
      actualRulesetId: actual?.rulesetId ?? null,
      expectedRulesetVersion: normalizeRulesetVersion(snapshot),
      actualRulesetVersion: actual?.rulesetVersion ?? null,
      expectedRulesetFingerprint: normalizeRulesetFingerprint(snapshot),
      actualRulesetFingerprint: actual?.rulesetFingerprint ?? null,
      actualReason: actual?.reason ?? null,
    };
  });
  }
}

function normalizeRulesetVersion(snapshot: IssueHistorySnapshot): string {
  return typeof snapshot.rulesetVersion === "string" && snapshot.rulesetVersion.length > 0 ? snapshot.rulesetVersion : "legacy";
}

function normalizeRulesetFingerprint(snapshot: IssueHistorySnapshot): string {
  return typeof snapshot.rulesetFingerprint === "string" && snapshot.rulesetFingerprint.length > 0
    ? snapshot.rulesetFingerprint
    : `${snapshot.rulesetId}@legacy:${snapshot.rulesetPriority}`;
}

export interface IssueHistoryReplayResult {
  historySnapshotId: string;
  replayable: boolean;
  matched: boolean;
  expectedTransitionKind: string;
  expectedRulesetId: string;
  expectedRulesetVersion: string;
  expectedRulesetFingerprint: string;
  expectedReason: string | null;
  actualTransitionKind: string | null;
  actualRulesetId: string | null;
  actualRulesetVersion: string | null;
  actualRulesetFingerprint: string | null;
  actualReason: string | null;
}

export function issueHistorySnapshotFromRequest(
  snapshot: IssueCurrentStateSnapshot,
  request: IssueTransitionRequest,
  ruleset: Pick<TransitionRuleset, "id" | "priority" | "version" | "fingerprint">,
): IssueHistorySnapshot {
  assertFlatTransitionRequest(request);
  const { actions: _actions, errors: _errors, transitionId, reason, ...requestFields } = request as IssueTransitionRequest & {
    actions?: unknown;
    errors?: unknown;
  };
  return {
    ...snapshot,
    ...requestFields,
    snapshotKind: request.transitionKind === "record_evidence" ? "evidence" : "transition",
    historySnapshotId: createIssueHistorySnapshotId(),
    transitionKind: request.transitionKind,
    transitionId: transitionId ?? createTransitionId(request.transitionKind),
    rulesetId: ruleset.id,
    rulesetVersion: ruleset.version ?? "unversioned",
    rulesetFingerprint: ruleset.fingerprint ?? `${ruleset.id}@${ruleset.version ?? "unversioned"}:${ruleset.priority}`,
    rulesetPriority: ruleset.priority,
    reason: reason ?? null,
    actions: [],
    errors: [],
  };
}

function assertFlatTransitionRequest(request: IssueTransitionRequest): void {
  if (Object.prototype.hasOwnProperty.call(request, "current")) {
    throw new Error("Issue transition requests must not contain a nested current object");
  }
  if (Object.prototype.hasOwnProperty.call(request, "transitionRequest")) {
    throw new Error("Issue transition requests must be flattened into the history snapshot");
  }
}

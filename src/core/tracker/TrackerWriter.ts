export interface TrackerTransitionInput {
  issueId: string;
  toState: string;
  fromStates?: string[];
  reason?: string;
}

export interface TrackerCommentInput {
  issueId: string;
  body: string;
  dedupeKey: string;
}

export interface TrackerIssueCreateInput {
  parentIssueId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  requestedLabels: string[];
  dependencies: string[];
  dedupeKey: string;
  payloadHash: string;
}

export interface TrackerIssueRef {
  id: string;
  identifier: string | null;
  url: string | null;
}

export interface TrackerWriteEvidence {
  kind: "issue_create";
  issue: TrackerIssueRef | null;
  issueCreateStatus: "created" | "verified" | "conflict" | "dry_run";
  parentIssueId: string;
  dedupeKey: string;
  payloadHash: string;
  unresolvedLabelNames: string[];
  message?: string;
}

export interface TrackerWriteResult {
  status: "applied" | "verified" | "skipped" | "dry_run";
  message?: string;
  evidence?: TrackerWriteEvidence;
}

export interface TrackerWriter {
  transitionIssueState(input: TrackerTransitionInput): Promise<TrackerWriteResult>;
  createIssueComment(input: TrackerCommentInput): Promise<TrackerWriteResult>;
  createIssueFromPlan?(input: TrackerIssueCreateInput): Promise<TrackerWriteResult>;
}

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

export interface TrackerWriteResult {
  status: "applied" | "verified" | "skipped" | "dry_run";
  message?: string;
}

export interface TrackerWriter {
  transitionIssueState(input: TrackerTransitionInput): Promise<TrackerWriteResult>;
  createIssueComment(input: TrackerCommentInput): Promise<TrackerWriteResult>;
}

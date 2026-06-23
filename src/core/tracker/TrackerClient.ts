import type { Issue } from "../types.js";

export interface FetchIssuesByStatesOptions {
  applyRouting?: boolean;
}

export interface TrackerClient {
  fetchCandidateIssues(): Promise<Issue[]>;
  fetchIssuesByStates(stateNames: string[], options?: FetchIssuesByStatesOptions): Promise<Issue[]>;
  fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]>;
}

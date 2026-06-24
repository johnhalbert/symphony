import type { Issue } from "../types.js";

export interface FetchIssuesByStatesOptions {
  applyRouting?: boolean;
}

export interface TrackerIssueCandidateFilterBranch {
  id: string;
  stateNames: string[];
  requireLabels?: string[];
  excludeLabels?: string[];
  requireAssignedToWorker?: boolean;
  requireNoOpenBlockers?: boolean;
  requireNoChildren?: boolean;
}

export interface TrackerIssueCandidateFilterInput {
  branches: TrackerIssueCandidateFilterBranch[];
}

export interface TrackerClient {
  fetchCandidateIssues(): Promise<Issue[]>;
  fetchIssuesByStates(stateNames: string[], options?: FetchIssuesByStatesOptions): Promise<Issue[]>;
  fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]>;
  fetchIssueCandidatesByFilter?(input: TrackerIssueCandidateFilterInput): Promise<Issue[]>;
}

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
  excludeIssueIds?: string[];
}

export interface TrackerIssueCandidatePageInput
  extends TrackerIssueCandidateFilterInput {
  first?: number;
  after?: string | null;
}

export interface TrackerIssueCandidatePage {
  issues: Issue[];
  pageInfo: {
    hasNextPage: boolean;
    endCursor: string | null;
  };
}

export interface TrackerClient {
  fetchCandidateIssues(): Promise<Issue[]>;
  fetchIssuesByStates(stateNames: string[], options?: FetchIssuesByStatesOptions): Promise<Issue[]>;
  fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]>;
  fetchIssueCandidatesByFilter?(input: TrackerIssueCandidateFilterInput): Promise<Issue[]>;
  fetchIssueCandidatePageByFilter?(input: TrackerIssueCandidatePageInput): Promise<TrackerIssueCandidatePage>;
}

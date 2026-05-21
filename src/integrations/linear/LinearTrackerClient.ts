import type { TrackerConfig } from "../../core/config/Config.js";
import { SymphonyError } from "../../core/errors.js";
import type { TrackerClient } from "../../core/tracker/TrackerClient.js";
import type { TrackerCommentInput, TrackerTransitionInput, TrackerWriteResult, TrackerWriter } from "../../core/tracker/TrackerWriter.js";
import type { Issue, IssueBlockerRef } from "../../core/types.js";

type FetchLike = typeof fetch;

interface LinearGraphQlResponse<T> {
  data?: T;
  errors?: unknown[];
}

interface LinearPageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface LinearRelationNode {
  type?: unknown;
  issue?: {
    id?: unknown;
    identifier?: unknown;
    state?: { name?: unknown } | null;
  } | null;
}

interface LinearIssueNode {
  id?: unknown;
  identifier?: unknown;
  title?: unknown;
  description?: unknown;
  priority?: unknown;
  branchName?: unknown;
  url?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  state?: {
    name?: unknown;
  } | null;
  assignee?: {
    id?: unknown;
  } | null;
  labels?: {
    nodes?: Array<{ name?: unknown }>;
  } | null;
  inverseRelations?: {
    nodes?: LinearRelationNode[];
  } | null;
}

interface LinearWorkflowStateNode {
  id?: unknown;
  name?: unknown;
}

interface LinearIssueWriteContext {
  id?: unknown;
  identifier?: unknown;
  state?: { id?: unknown; name?: unknown } | null;
  team?: { states?: { nodes?: LinearWorkflowStateNode[] } } | null;
  comments?: { nodes?: Array<{ id?: unknown; body?: unknown }> } | null;
}

export interface AssigneeFilter {
  matchValues: Set<string>;
}

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  priority
  branchName
  url
  createdAt
  updatedAt
  state { name }
  assignee { id }
  labels { nodes { name } }
  inverseRelations { nodes { type issue { id identifier state { name } } } }
`;

const VIEWER_QUERY = `
  query SymphonyLinearViewer {
    viewer { id }
  }
`;

const CANDIDATE_QUERY = `
  query SymphonyCandidateIssues($projectSlug: String!, $activeStates: [String!], $after: String) {
    issues(
      first: 50,
      after: $after,
      filter: {
        project: { slugId: { eq: $projectSlug } },
        state: { name: { in: $activeStates } }
      }
    ) {
      nodes { ${ISSUE_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const ISSUES_BY_STATES_QUERY = `
  query SymphonyIssuesByStates($projectSlug: String!, $states: [String!], $after: String) {
    issues(
      first: 50,
      after: $after,
      filter: {
        project: { slugId: { eq: $projectSlug } },
        state: { name: { in: $states } }
      }
    ) {
      nodes { ${ISSUE_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const ISSUE_STATES_QUERY = `
  query SymphonyIssueStates($ids: [ID!]) {
    issues(filter: { id: { in: $ids } }) {
      nodes {
        id
        identifier
        title
        description
        priority
        branchName
        url
        createdAt
        updatedAt
        state { name }
        assignee { id }
        labels { nodes { name } }
        inverseRelations { nodes { type issue { id identifier state { name } } } }
      }
    }
  }
`;

const ISSUE_WRITE_CONTEXT_QUERY = `
  query SymphonyIssueWriteContext($id: String!) {
    issue(id: $id) {
      id
      identifier
      state { id name }
      team { states { nodes { id name } } }
      comments(first: 50) { nodes { id body } }
    }
  }
`;

const ISSUE_UPDATE_MUTATION = `
  mutation SymphonyIssueUpdate($id: String!, $stateId: String!) {
    issueUpdate(id: $id, input: { stateId: $stateId }) {
      success
      issue { id identifier state { id name } updatedAt }
    }
  }
`;

const COMMENT_CREATE_MUTATION = `
  mutation SymphonyCommentCreate($input: CommentCreateInput!) {
    commentCreate(input: $input) {
      success
      comment { id body createdAt }
    }
  }
`;

export class LinearTrackerClient implements TrackerClient, TrackerWriter {
  constructor(
    private readonly config: TrackerConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async fetchCandidateIssues(): Promise<Issue[]> {
    const assigneeFilter = await this.routingAssigneeFilter();
    return this.fetchPagedIssues(
      CANDIDATE_QUERY,
      {
        projectSlug: this.config.projectSlug,
        activeStates: this.config.activeStates,
      },
      assigneeFilter,
    );
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    if (stateNames.length === 0) return [];
    return this.fetchPagedIssues(ISSUES_BY_STATES_QUERY, {
      projectSlug: this.config.projectSlug,
      states: stateNames,
    });
  }

  async fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]> {
    if (issueIds.length === 0) return [];
    const assigneeFilter = await this.routingAssigneeFilter();
    const response = await this.graphql<{ issues: { nodes: LinearIssueNode[] } }>(ISSUE_STATES_QUERY, {
      ids: issueIds,
    });
    return response.issues.nodes
      .map((node) => normalizeIssue(node, assigneeFilter))
      .filter((issue): issue is Issue => issue !== null);
  }

  async transitionIssueState(input: TrackerTransitionInput): Promise<TrackerWriteResult> {
    const context = await this.fetchIssueWriteContext(input.issueId);
    const currentState = asString(context.state?.name);
    if (!currentState) throw new SymphonyError("tracker_error", `Linear issue ${input.issueId} is missing state`);
    if (sameName(currentState, input.toState)) {
      return { status: "skipped", message: `Issue is already in ${input.toState}` };
    }
    if (input.fromStates && input.fromStates.length > 0 && !input.fromStates.some((state) => sameName(state, currentState))) {
      return {
        status: "skipped",
        message: `Current state ${currentState} is outside allowed sources: ${input.fromStates.join(", ")}`,
      };
    }
    const targetState = context.team?.states?.nodes?.find((state) => sameName(asString(state.name) ?? "", input.toState));
    const stateId = asString(targetState?.id);
    if (!stateId) throw new SymphonyError("tracker_error", `Linear state not found: ${input.toState}`);
    const response = await this.graphql<{ issueUpdate: { success?: unknown } }>(ISSUE_UPDATE_MUTATION, {
      id: input.issueId,
      stateId,
    });
    if (response.issueUpdate.success !== true) {
      throw new SymphonyError("tracker_error", `Linear issueUpdate did not report success for ${input.issueId}`);
    }
    return input.reason === undefined ? { status: "applied" } : { status: "applied", message: input.reason };
  }

  async createIssueComment(input: TrackerCommentInput): Promise<TrackerWriteResult> {
    const marker = commentMarker(input.dedupeKey);
    const context = await this.fetchIssueWriteContext(input.issueId);
    if ((context.comments?.nodes ?? []).some((comment) => asString(comment.body)?.includes(marker))) {
      return { status: "skipped", message: `Comment already exists for ${input.dedupeKey}` };
    }
    const response = await this.graphql<{ commentCreate: { success?: unknown } }>(COMMENT_CREATE_MUTATION, {
      input: {
        issueId: input.issueId,
        body: `${input.body}\n\n${marker}`,
        doNotSubscribeToIssue: true,
      },
    });
    if (response.commentCreate.success !== true) {
      throw new SymphonyError("tracker_error", `Linear commentCreate did not report success for ${input.issueId}`);
    }
    return { status: "applied" };
  }

  private async fetchPagedIssues(
    query: string,
    variables: Record<string, unknown>,
    assigneeFilter: AssigneeFilter | null = null,
  ): Promise<Issue[]> {
    const issues: Issue[] = [];
    let after: string | null = null;

    do {
      const response: { issues: { nodes: LinearIssueNode[]; pageInfo: LinearPageInfo } } =
        await this.graphql<{ issues: { nodes: LinearIssueNode[]; pageInfo: LinearPageInfo } }>(
        query,
        { ...variables, after },
      );
      issues.push(
        ...response.issues.nodes
          .map((node) => normalizeIssue(node, assigneeFilter))
          .filter((issue): issue is Issue => issue !== null),
      );

      const pageInfo = response.issues.pageInfo;
      if (pageInfo.hasNextPage && !pageInfo.endCursor) {
        throw new SymphonyError("tracker_error", "Linear pagination reported next page without endCursor");
      }
      after = pageInfo.hasNextPage ? pageInfo.endCursor : null;
    } while (after);

    return issues;
  }

  private async routingAssigneeFilter(): Promise<AssigneeFilter | null> {
    const assignee = this.config.assignee?.trim();
    if (!assignee) return null;
    if (assignee.toLowerCase() !== "me") {
      return { matchValues: new Set([assignee]) };
    }

    const response = await this.graphql<{ viewer: { id?: unknown } }>(VIEWER_QUERY, {});
    const viewerId = asString(response.viewer.id);
    if (!viewerId) {
      throw new SymphonyError("tracker_error", "Linear viewer identity is missing");
    }
    return { matchValues: new Set([viewerId]) };
  }

  private async fetchIssueWriteContext(issueId: string): Promise<LinearIssueWriteContext> {
    const response = await this.graphql<{ issue?: LinearIssueWriteContext | null }>(ISSUE_WRITE_CONTEXT_QUERY, {
      id: issueId,
    });
    if (!response.issue) throw new SymphonyError("tracker_error", `Linear issue not found: ${issueId}`);
    return response.issue;
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await this.fetchImpl(this.config.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: this.config.apiKey,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      throw new SymphonyError("tracker_error", `Linear API returned HTTP ${response.status}`);
    }

    const body = (await response.json()) as LinearGraphQlResponse<T>;
    if (body.errors && body.errors.length > 0) {
      throw new SymphonyError("tracker_error", "Linear GraphQL errors", body.errors);
    }
    if (!body.data) {
      throw new SymphonyError("tracker_error", "Linear response missing data");
    }
    return body.data;
  }
}

export function normalizeIssue(node: LinearIssueNode, assigneeFilter: AssigneeFilter | null = null): Issue | null {
  const id = asString(node.id);
  const identifier = asString(node.identifier);
  const title = asString(node.title);
  const state = asString(node.state?.name);
  if (!id || !identifier || !title || !state) return null;
  const assigneeId = asNullableString(node.assignee?.id);

  return {
    id,
    identifier,
    title,
    description: asNullableString(node.description),
    priority: Number.isInteger(node.priority) ? (node.priority as number) : null,
    state,
    branchName: asNullableString(node.branchName),
    url: asNullableString(node.url),
    assigneeId,
    assignedToWorker: assignedToWorker(assigneeId, assigneeFilter),
    labels: normalizeLabels(node.labels?.nodes),
    blockedBy: normalizeBlockers(node.inverseRelations?.nodes),
    createdAt: asNullableString(node.createdAt),
    updatedAt: asNullableString(node.updatedAt),
  };
}

function normalizeLabels(nodes: Array<{ name?: unknown }> | undefined): string[] {
  return (nodes ?? []).map((node) => asString(node.name)?.toLowerCase()).filter((label): label is string => !!label);
}

function normalizeBlockers(nodes: LinearRelationNode[] | undefined): IssueBlockerRef[] {
  if (!Array.isArray(nodes)) return [];
  return nodes
    .filter((node) => asString(node.type)?.toLowerCase() === "blocks")
    .map((node) => ({
      id: asNullableString(node.issue?.id),
      identifier: asNullableString(node.issue?.identifier),
      state: asNullableString(node.issue?.state?.name),
    }));
}

function assignedToWorker(assigneeId: string | null, assigneeFilter: AssigneeFilter | null): boolean {
  if (!assigneeFilter) return true;
  return assigneeId !== null && assigneeFilter.matchValues.has(assigneeId);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function sameName(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function commentMarker(dedupeKey: string): string {
  return `<!-- symphony-writeback:${dedupeKey} -->`;
}

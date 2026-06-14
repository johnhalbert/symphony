import type { TrackerConfig } from "../../core/config/Config.js";
import { SymphonyError } from "../../core/errors.js";
import type { TrackerClient } from "../../core/tracker/TrackerClient.js";
import type {
  TrackerCommentInput,
  TrackerIssueCreateInput,
  TrackerIssueRelationInput,
  TrackerIssueRef,
  TrackerTransitionInput,
  TrackerWriteResult,
  TrackerWriter,
} from "../../core/tracker/TrackerWriter.js";
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

interface LinearPageInfoNode {
  hasNextPage?: unknown;
  endCursor?: unknown;
}

interface LinearConnection<T> {
  nodes?: T[];
  pageInfo?: LinearPageInfoNode | null;
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
  delegate?: {
    id?: unknown;
  } | null;
  labels?: {
    nodes?: Array<{ name?: unknown }>;
  } | null;
  project?: {
    id?: unknown;
    slugId?: unknown;
  } | null;
  inverseRelations?: {
    nodes?: LinearRelationNode[];
  } | null;
}

interface LinearWorkflowStateNode {
  id?: unknown;
  name?: unknown;
}

interface LinearWorkflowTeamNode {
  id?: unknown;
  key?: unknown;
  name?: unknown;
  states?: LinearConnection<LinearWorkflowStateNode> | null;
}

interface LinearWorkflowTeamDescriptor {
  teamId: string;
  teamKey: string;
  teamName: string | null;
}

interface LinearIssueWriteContext {
  id?: unknown;
  identifier?: unknown;
  state?: { id?: unknown; name?: unknown } | null;
  team?: { states?: { nodes?: LinearWorkflowStateNode[] } } | null;
  comments?: { nodes?: Array<{ id?: unknown; body?: unknown }> } | null;
}

interface LinearIssueLabelNode {
  id?: unknown;
  name?: unknown;
}

interface LinearIssueCreateContext {
  id?: unknown;
  identifier?: unknown;
  team?: { id?: unknown; labels?: { nodes?: LinearIssueLabelNode[] } | null } | null;
  project?: { id?: unknown } | null;
  children?: {
    nodes?: Array<{
      id?: unknown;
      identifier?: unknown;
      title?: unknown;
      description?: unknown;
      url?: unknown;
      parent?: { id?: unknown } | null;
    }>;
  } | null;
}

interface LinearIssueRelationContext {
  id?: unknown;
  relations?: {
    nodes?: Array<{
      type?: unknown;
      relatedIssue?: { id?: unknown } | null;
    }>;
  } | null;
}

export interface AssigneeFilter {
  matchValues: Set<string>;
}

export interface LinearWorkflowTeamStates {
  teamId: string;
  teamKey: string;
  teamName: string | null;
  states: string[];
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
  delegate { id }
  labels { nodes { name } }
  project { id slugId }
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
      nodes { ${ISSUE_FIELDS} }
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

const ISSUE_CREATE_CONTEXT_QUERY = `
  query SymphonyIssueCreateContext($id: String!) {
    issue(id: $id) {
      id
      identifier
      team { id labels(first: 100) { nodes { id name } } }
      project { id }
      children(first: 100) { nodes { id identifier title description url parent { id } } }
    }
  }
`;

const PROJECT_WORKFLOW_STATES_QUERY = `
  query SymphonyProjectWorkflowStates($projectSlug: String!, $teamsAfter: String) {
    projects(first: 1, filter: { slugId: { eq: $projectSlug } }) {
      nodes {
        id
        name
        teams(first: 25, after: $teamsAfter) {
          nodes {
            id
            key
            name
            states(first: 100) {
              nodes {
                id
                name
              }
              pageInfo { hasNextPage endCursor }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

const TEAM_WORKFLOW_STATES_QUERY = `
  query SymphonyTeamWorkflowStates($teamId: String!, $statesAfter: String) {
    team(id: $teamId) {
      id
      key
      name
      states(first: 100, after: $statesAfter) {
        nodes {
          id
          name
        }
        pageInfo { hasNextPage endCursor }
      }
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

const ISSUE_CREATE_MUTATION = `
  mutation SymphonyIssueCreate($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue { id identifier url }
    }
  }
`;

const ISSUE_RELATION_CONTEXT_QUERY = `
  query SymphonyIssueRelationContext($id: String!) {
    issue(id: $id) {
      id
      relations(first: 100) { nodes { type relatedIssue { id } } }
    }
  }
`;

const ISSUE_RELATION_CREATE_MUTATION = `
  mutation SymphonyIssueRelationCreate($input: IssueRelationCreateInput!) {
    issueRelationCreate(input: $input) {
      success
      issueRelation { id type }
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

  async fetchWorkflowStatesByTeam(): Promise<LinearWorkflowTeamStates[]> {
    const results: LinearWorkflowTeamStates[] = [];
    let teamsAfter: string | null = null;

    do {
      const response = await this.graphql<{
        projects: {
          nodes: Array<{
            id?: unknown;
            name?: unknown;
            teams?: LinearConnection<LinearWorkflowTeamNode> | null;
          }>;
        };
      }>(PROJECT_WORKFLOW_STATES_QUERY, {
        projectSlug: this.config.projectSlug,
        teamsAfter,
      });
      const projects = response.projects.nodes;
      if (projects.length === 0) {
        throw new SymphonyError("tracker_error", `Linear project not found for slug ${this.config.projectSlug}`);
      }

      const project = projects[0];
      const teamConnection = project?.teams;
      const teams = teamConnection?.nodes;
      if (!Array.isArray(teams)) {
        throw new SymphonyError("tracker_error", `Linear project ${this.config.projectSlug} teams are missing from response`);
      }

      for (const teamNode of teams) {
        const team = this.normalizeWorkflowTeam(teamNode);
        results.push({
          ...team,
          states: await this.fetchCompleteWorkflowStateNamesForTeam(team, teamNode.states),
        });
      }

      const pageInfo = normalizePageInfo(teamConnection?.pageInfo, `Linear project ${this.config.projectSlug} teams`);
      teamsAfter = pageInfo.hasNextPage ? pageInfo.endCursor : null;
    } while (teamsAfter);

    if (results.length === 0) {
      throw new SymphonyError("tracker_error", `Linear project ${this.config.projectSlug} has no teams`);
    }

    return results;
  }

  async fetchWorkflowStateNames(): Promise<string[]> {
    const teams = await this.fetchWorkflowStatesByTeam();
    return uniqueStrings(teams.flatMap((team) => team.states));
  }

  async transitionIssueState(input: TrackerTransitionInput): Promise<TrackerWriteResult> {
    const context = await this.fetchIssueWriteContext(input.issueId);
    const currentState = asString(context.state?.name);
    if (!currentState) throw new SymphonyError("tracker_error", `Linear issue ${input.issueId} is missing state`);
    if (sameName(currentState, input.toState)) {
      return { status: "verified", message: `Issue is already in ${input.toState}` };
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
      return { status: "verified", message: `Comment already exists for ${input.dedupeKey}` };
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

  async createIssueFromPlan(input: TrackerIssueCreateInput): Promise<TrackerWriteResult> {
    const marker = issueBreakdownMarker(input.dedupeKey, input.payloadHash);
    const context = await this.fetchIssueCreateContext(input.parentIssueId);
    const existing = (context.children?.nodes ?? []).filter((child) => asString(child.description)?.includes(marker));
    const matchingChildren = existing.filter(
      (child) => asString(child.title) === input.title && asString(child.parent?.id) === input.parentIssueId,
    );
    if (matchingChildren.length === 1) {
      return issueCreateResult("verified", input, issueRefFromNode(matchingChildren[0] ?? {}));
    }
    if (existing.length > 0) {
      return {
        status: "skipped",
        message: `Issue breakdown child marker conflict for ${input.dedupeKey}`,
        evidence: {
          kind: "issue_create",
          issue: null,
          issueCreateStatus: "conflict",
          parentIssueId: input.parentIssueId,
          dedupeKey: input.dedupeKey,
          payloadHash: input.payloadHash,
          unresolvedLabelNames: input.requestedLabels,
          message: "Marker exists on a non-child, wrong-title, or duplicate Linear issue",
        },
      };
    }

    const teamId = asString(context.team?.id);
    if (!teamId) throw new SymphonyError("tracker_error", `Linear issue ${input.parentIssueId} is missing team`);
    const resolvedLabels = resolveIssueCreateLabels(input.requestedLabels, context.team?.labels?.nodes ?? []);
    if (resolvedLabels.conflicts.length > 0) {
      return {
        status: "skipped",
        message: `Linear label resolution is ambiguous: ${resolvedLabels.conflicts.join(", ")}`,
        evidence: {
          kind: "issue_create",
          issue: null,
          issueCreateStatus: "conflict",
          parentIssueId: input.parentIssueId,
          dedupeKey: input.dedupeKey,
          payloadHash: input.payloadHash,
          unresolvedLabelNames: [...resolvedLabels.unresolved, ...resolvedLabels.conflicts],
          message: "Ambiguous Linear label names",
        },
      };
    }
    if (resolvedLabels.unresolved.length > 0) {
      return {
        status: "skipped",
        message: `Linear label resolution failed: ${resolvedLabels.unresolved.join(", ")}`,
        evidence: {
          kind: "issue_create",
          issue: null,
          issueCreateStatus: "conflict",
          parentIssueId: input.parentIssueId,
          dedupeKey: input.dedupeKey,
          payloadHash: input.payloadHash,
          unresolvedLabelNames: resolvedLabels.unresolved,
          message: "Unresolved Linear label names",
        },
      };
    }

    const response = await this.graphql<{ issueCreate: { success?: unknown; issue?: { id?: unknown; identifier?: unknown; url?: unknown } | null } }>(
      ISSUE_CREATE_MUTATION,
      {
        input: {
          teamId,
          parentId: input.parentIssueId,
          title: input.title,
          description: renderIssueCreateDescription(input, marker, resolvedLabels.unresolved),
          ...(asString(context.project?.id) ? { projectId: asString(context.project?.id) } : {}),
          ...(resolvedLabels.labelIds.length > 0 ? { labelIds: resolvedLabels.labelIds } : {}),
        },
      },
    );
    if (response.issueCreate.success !== true || !response.issueCreate.issue) {
      throw new SymphonyError("tracker_error", `Linear issueCreate did not report success for ${input.parentIssueId}`);
    }
    return issueCreateResult("created", input, issueRefFromNode(response.issueCreate.issue));
  }

  async createIssueRelation(input: TrackerIssueRelationInput): Promise<TrackerWriteResult> {
    const context = await this.fetchIssueRelationContext(input.sourceIssueId);
    const existing = (context.relations?.nodes ?? []).some(
      (relation) =>
        asString(relation.type)?.toLowerCase() === input.type &&
        asString(relation.relatedIssue?.id) === input.targetIssueId,
    );
    if (existing) return { status: "verified", message: `Issue relation already exists for ${input.dedupeKey}` };
    const response = await this.graphql<{ issueRelationCreate: { success?: unknown } }>(ISSUE_RELATION_CREATE_MUTATION, {
      input: {
        issueId: input.sourceIssueId,
        relatedIssueId: input.targetIssueId,
        type: input.type,
      },
    });
    if (response.issueRelationCreate.success !== true) {
      throw new SymphonyError("tracker_error", `Linear issueRelationCreate did not report success for ${input.sourceIssueId}`);
    }
    return { status: "applied", message: input.dedupeKey };
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

  private async fetchIssueCreateContext(issueId: string): Promise<LinearIssueCreateContext> {
    const response = await this.graphql<{ issue?: LinearIssueCreateContext | null }>(ISSUE_CREATE_CONTEXT_QUERY, {
      id: issueId,
    });
    if (!response.issue) throw new SymphonyError("tracker_error", `Linear issue not found: ${issueId}`);
    return response.issue;
  }

  private async fetchIssueRelationContext(issueId: string): Promise<LinearIssueRelationContext> {
    const response = await this.graphql<{ issue?: LinearIssueRelationContext | null }>(ISSUE_RELATION_CONTEXT_QUERY, {
      id: issueId,
    });
    if (!response.issue) throw new SymphonyError("tracker_error", `Linear issue not found: ${issueId}`);
    return response.issue;
  }

  private normalizeWorkflowTeam(team: LinearWorkflowTeamNode): LinearWorkflowTeamDescriptor {
    const teamId = asString(team.id);
    const teamKey = asString(team.key);
    const teamName = asNullableString(team.name);
    if (!teamId || !teamKey) {
      throw new SymphonyError("tracker_error", `Linear project ${this.config.projectSlug} includes a team without id/key`);
    }
    return { teamId, teamKey, teamName };
  }

  private async fetchCompleteWorkflowStateNamesForTeam(
    team: LinearWorkflowTeamDescriptor,
    initialConnection: LinearConnection<LinearWorkflowStateNode> | null | undefined,
  ): Promise<string[]> {
    const states: string[] = [];
    let connection = initialConnection;
    let statesAfter: string | null = null;

    do {
      const stateNodes = connection?.nodes;
      if (!Array.isArray(stateNodes)) {
        throw new SymphonyError("tracker_error", `Linear team ${formatTeam(team.teamKey, team.teamName)} workflow states are missing from response`);
      }

      states.push(...stateNodes.map((state) => asString(state.name)).filter((state): state is string => state !== null));
      const pageInfo = normalizePageInfo(connection?.pageInfo, `Linear team ${formatTeam(team.teamKey, team.teamName)} workflow states`);
      statesAfter = pageInfo.hasNextPage ? pageInfo.endCursor : null;
      if (statesAfter) {
        const response = await this.graphql<{ team?: LinearWorkflowTeamNode | null }>(TEAM_WORKFLOW_STATES_QUERY, {
          teamId: team.teamId,
          statesAfter,
        });
        if (!response.team) {
          throw new SymphonyError("tracker_error", `Linear team ${formatTeam(team.teamKey, team.teamName)} not found while paginating workflow states`);
        }
        connection = response.team.states;
      }
    } while (statesAfter);

    const uniqueStates = uniqueStrings(states);
    if (uniqueStates.length === 0) {
      throw new SymphonyError("tracker_error", `Linear team ${formatTeam(team.teamKey, team.teamName)} has no workflow states`);
    }
    return uniqueStates;
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
  const delegateId = asNullableString(node.delegate?.id);
  const linearProjectSlug = asNullableString(node.project?.slugId);
  const linearProjectId = asNullableString(node.project?.id);

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
    delegateId,
    assignedToWorker: assignedToWorker(assigneeId, delegateId, assigneeFilter),
    labels: normalizeLabels(node.labels?.nodes),
    blockedBy: normalizeBlockers(node.inverseRelations?.nodes),
    createdAt: asNullableString(node.createdAt),
    updatedAt: asNullableString(node.updatedAt),
    ...(linearProjectSlug
      ? {
          linearProjectIdentity: {
            kind: "linear",
            slug: linearProjectSlug,
            ...(linearProjectId === null ? {} : { id: linearProjectId }),
          },
        }
      : {}),
  } as Issue;
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

function assignedToWorker(
  assigneeId: string | null,
  delegateId: string | null,
  assigneeFilter: AssigneeFilter | null,
): boolean {
  if (!assigneeFilter) return true;
  return [assigneeId, delegateId].some((routeId) => routeId !== null && assigneeFilter.matchValues.has(routeId));
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

function formatTeam(teamKey: string, teamName: string | null): string {
  return teamName ? `${teamName} (${teamKey})` : teamKey;
}

function normalizePageInfo(pageInfo: LinearPageInfoNode | null | undefined, subject: string): LinearPageInfo {
  if (
    !pageInfo ||
    typeof pageInfo.hasNextPage !== "boolean" ||
    !(typeof pageInfo.endCursor === "string" || pageInfo.endCursor === null)
  ) {
    throw new SymphonyError("tracker_error", `${subject} pagination metadata is missing from response`);
  }
  if (pageInfo.hasNextPage && !pageInfo.endCursor) {
    throw new SymphonyError("tracker_error", `${subject} pagination reported next page without endCursor`);
  }
  return { hasNextPage: pageInfo.hasNextPage, endCursor: pageInfo.endCursor };
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function commentMarker(dedupeKey: string): string {
  return `<!-- symphony-writeback:${dedupeKey} -->`;
}

function issueBreakdownMarker(dedupeKey: string, payloadHash: string): string {
  return `<!-- symphony-issue-breakdown:${dedupeKey}:${payloadHash} -->`;
}

function issueCreateResult(
  status: "created" | "verified",
  input: TrackerIssueCreateInput,
  issueRef: TrackerIssueRef,
): TrackerWriteResult {
  return {
    status: status === "created" ? "applied" : "verified",
    evidence: {
      kind: "issue_create",
      issue: issueRef,
      issueCreateStatus: status,
      parentIssueId: input.parentIssueId,
      dedupeKey: input.dedupeKey,
      payloadHash: input.payloadHash,
      unresolvedLabelNames: [],
    },
  };
}

function issueRefFromNode(node: { id?: unknown; identifier?: unknown; url?: unknown }): TrackerIssueRef {
  const id = asString(node.id);
  if (!id) throw new SymphonyError("tracker_error", "Linear issue create response is missing issue id");
  return {
    id,
    identifier: asNullableString(node.identifier),
    url: asNullableString(node.url),
  };
}

function resolveIssueCreateLabels(
  requestedLabels: string[],
  availableLabels: LinearIssueLabelNode[],
): { labelIds: string[]; unresolved: string[]; conflicts: string[] } {
  const requested = uniqueStrings(requestedLabels.map((label) => label.trim()).filter((label) => label.length > 0));
  const byName = new Map<string, Array<{ id: string; name: string }>>();
  for (const label of availableLabels) {
    const id = asString(label.id);
    const name = asString(label.name);
    if (!id || !name) continue;
    const key = name.toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), { id, name }]);
  }
  const labelIds: string[] = [];
  const unresolved: string[] = [];
  const conflicts: string[] = [];
  for (const label of requested) {
    const matches = byName.get(label.toLowerCase()) ?? [];
    if (matches.length === 0) {
      unresolved.push(label);
    } else if (matches.length > 1) {
      conflicts.push(label);
    } else {
      labelIds.push(matches[0]?.id ?? "");
    }
  }
  return { labelIds: labelIds.filter((id) => id.length > 0), unresolved, conflicts };
}

function renderIssueCreateDescription(input: TrackerIssueCreateInput, marker: string, unresolvedLabels: string[]): string {
  return [
    input.description,
    "",
    "Acceptance criteria:",
    ...input.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    "",
    `Dependencies: ${input.dependencies.length === 0 ? "None" : input.dependencies.join(", ")}`,
    `Requested labels: ${input.requestedLabels.length === 0 ? "None" : input.requestedLabels.join(", ")}`,
    ...(unresolvedLabels.length === 0 ? [] : [`Unresolved labels: ${unresolvedLabels.join(", ")}`]),
    "",
    marker,
  ].join("\n");
}

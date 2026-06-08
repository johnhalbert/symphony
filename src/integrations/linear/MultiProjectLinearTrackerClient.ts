import { defaultProjectContext, withProjectContextServiceConfig, type ProjectContextConfig } from "../../core/config/ProjectContexts.js";
import type { ServiceConfig } from "../../core/config/Config.js";
import type { TrackerClient } from "../../core/tracker/TrackerClient.js";
import type {
  TrackerCommentInput,
  TrackerIssueCreateInput,
  TrackerIssueRelationInput,
  TrackerTransitionInput,
  TrackerWriteResult,
  TrackerWriter,
} from "../../core/tracker/TrackerWriter.js";
import type { Issue } from "../../core/types.js";
import { LinearTrackerClient, type LinearWorkflowTeamStates } from "./LinearTrackerClient.js";

type IssueCollectionAmbiguityMode = "drop" | "throw";

export class MultiProjectLinearTrackerClient implements TrackerClient, TrackerWriter {
  constructor(
    private readonly config: ServiceConfig,
    private readonly clientFactory: (config: ServiceConfig) => LinearTrackerClient,
  ) {}

  async fetchCandidateIssues(): Promise<Issue[]> {
    return this.collectIssues((context, client) => client.fetchCandidateIssues(), "drop");
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    return this.collectIssues((context, client) => client.fetchIssuesByStates(stateNames), "drop");
  }

  async fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]> {
    return this.collectIssues((context, client) => client.fetchIssueStatesByIds(issueIds), "throw");
  }

  async fetchWorkflowStatesByTeam(): Promise<LinearWorkflowTeamStates[]> {
    const teams = await Promise.all(this.projectContexts().map((context) => this.clientFactoryFor(context).fetchWorkflowStatesByTeam()));
    const merged = new Map<string, LinearWorkflowTeamStates>();
    for (const teamSet of teams) {
      for (const team of teamSet) {
        const key = `${team.teamId}:${team.teamKey}`;
        const existing = merged.get(key);
        if (!existing) {
          merged.set(key, { ...team, states: [...team.states] });
          continue;
        }
        existing.states = Array.from(new Set([...existing.states, ...team.states]));
      }
    }
    return [...merged.values()];
  }

  async fetchWorkflowStateNames(): Promise<string[]> {
    const teams = await this.fetchWorkflowStatesByTeam();
    return Array.from(new Set(teams.flatMap((team) => team.states)));
  }

  transitionIssueState(input: TrackerTransitionInput): Promise<TrackerWriteResult> {
    return this.clientForWriteInput(input.projectContextId).transitionIssueState(input);
  }

  createIssueComment(input: TrackerCommentInput): Promise<TrackerWriteResult> {
    return this.clientForWriteInput(input.projectContextId).createIssueComment(input);
  }

  createIssueFromPlan(input: TrackerIssueCreateInput): Promise<TrackerWriteResult> {
    return this.clientForWriteInput(input.projectContextId).createIssueFromPlan?.(input) ?? Promise.resolve({ status: "skipped" });
  }

  createIssueRelation(input: TrackerIssueRelationInput): Promise<TrackerWriteResult> {
    return this.clientForWriteInput(input.projectContextId).createIssueRelation?.(input) ?? Promise.resolve({ status: "skipped" });
  }

  private projectContexts(): ProjectContextConfig[] {
    const contexts = (this.config.projectContexts ?? []).filter((context) => context.enabled !== false);
    return contexts.length > 0 ? contexts : [defaultProjectContext(this.config)];
  }

  private async collectIssues(
    fetcher: (context: ProjectContextConfig, client: LinearTrackerClient) => Promise<Issue[]>,
    ambiguityMode: IssueCollectionAmbiguityMode,
  ): Promise<Issue[]> {
    const issues = await Promise.all(
      this.projectContexts().map(async (context) =>
        (await fetcher(context, this.clientFactoryFor(context))).map((issue) => this.decorateIssue(issue, context)),
      ),
    );
    return this.resolveCollectedIssues(issues.flat(), ambiguityMode);
  }

  private resolveCollectedIssues(issues: Issue[], ambiguityMode: IssueCollectionAmbiguityMode): Issue[] {
    const grouped = new Map<string, Issue[]>();
    for (const issue of issues) {
      const bucket = grouped.get(issue.id);
      if (bucket) {
        bucket.push(issue);
      } else {
        grouped.set(issue.id, [issue]);
      }
    }

    const resolved: Issue[] = [];
    const ambiguities: string[] = [];
    for (const group of grouped.values()) {
      const resolution = this.resolveIssueGroup(group);
      if (resolution.status === "resolved") {
        resolved.push(resolution.issue);
        continue;
      }
      ambiguities.push(resolution.message);
    }

    if (ambiguityMode === "throw" && ambiguities.length > 0) {
      throw new Error(`Ambiguous project context resolution for Linear issues: ${ambiguities.join("; ")}`);
    }

    return resolved;
  }

  private resolveIssueGroup(issues: Issue[]): { status: "resolved"; issue: Issue } | { status: "ambiguous"; message: string } {
    const byContext = new Map<string, Issue>();
    for (const issue of issues) {
      const contextId = issue.projectContextId?.trim();
      if (!contextId) {
        return { status: "ambiguous", message: `${issue.identifier ?? issue.id} (${issue.id}) has no resolved project context` };
      }
      if (!byContext.has(contextId)) byContext.set(contextId, issue);
    }

    const resolved = [...byContext.values()];
    if (resolved.length === 1) return { status: "resolved", issue: resolved[0]! };

    const issue = resolved[0]!;
    const contexts = resolved.map((candidate) => candidate.projectContextId ?? "<missing>").sort().join(", ");
    return {
      status: "ambiguous",
      message: `${issue.identifier ?? issue.id} (${issue.id}) matched multiple project contexts: ${contexts}`,
    };
  }

  private clientForWriteInput(projectContextId: string | null | undefined): LinearTrackerClient {
    return this.clientFactoryFor(this.projectContextForWrite(projectContextId));
  }

  private projectContextForWrite(projectContextId: string | null | undefined): ProjectContextConfig {
    const contexts = this.projectContexts();
    const resolvedId = projectContextId?.trim();
    if (resolvedId) {
      const match = contexts.find((context) => context.id === resolvedId);
      if (!match) {
        throw new Error(`Unknown or disabled project context for tracker writeback: ${resolvedId}`);
      }
      return match;
    }
    if (contexts.length === 1) return contexts[0]!;
    throw new Error(`Tracker writeback requires an explicit project context when ${contexts.length} project contexts are enabled`);
  }

  private clientFactoryFor(context: ProjectContextConfig): LinearTrackerClient {
    return this.clientFactory(withProjectContextServiceConfig(this.config, context));
  }

  private decorateIssue(issue: Issue, context: ProjectContextConfig): Issue {
    return {
      ...issue,
      projectContextId: context.id,
      projectContextLabel: context.label,
      trackerProjectSlug: context.tracker.projectSlug,
    };
  }
}

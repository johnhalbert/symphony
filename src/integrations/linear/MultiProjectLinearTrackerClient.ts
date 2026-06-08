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

export class MultiProjectLinearTrackerClient implements TrackerClient, TrackerWriter {
  constructor(
    private readonly config: ServiceConfig,
    private readonly clientFactory: (config: ServiceConfig) => LinearTrackerClient,
  ) {}

  async fetchCandidateIssues(): Promise<Issue[]> {
    const issues = await Promise.all(
      this.projectContexts().map(async (context) =>
        (await this.clientFactoryFor(context).fetchCandidateIssues()).map((issue) => this.decorateIssue(issue, context)),
      ),
    );
    return issues.flat();
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    const issues = await Promise.all(
      this.projectContexts().map(async (context) =>
        (await this.clientFactoryFor(context).fetchIssuesByStates(stateNames)).map((issue) => this.decorateIssue(issue, context)),
      ),
    );
    return issues.flat();
  }

  async fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]> {
    const issues = await Promise.all(
      this.projectContexts().map(async (context) =>
        (await this.clientFactoryFor(context).fetchIssueStatesByIds(issueIds)).map((issue) => this.decorateIssue(issue, context)),
      ),
    );
    const seen = new Set<string>();
    return issues
      .flat()
      .filter((issue) => {
        if (seen.has(issue.id)) return false;
        seen.add(issue.id);
        return true;
      });
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
    return this.defaultClient().transitionIssueState(input);
  }

  createIssueComment(input: TrackerCommentInput): Promise<TrackerWriteResult> {
    return this.defaultClient().createIssueComment(input);
  }

  createIssueFromPlan(input: TrackerIssueCreateInput): Promise<TrackerWriteResult> {
    return this.defaultClient().createIssueFromPlan?.(input) ?? Promise.resolve({ status: "skipped" });
  }

  createIssueRelation(input: TrackerIssueRelationInput): Promise<TrackerWriteResult> {
    return this.defaultClient().createIssueRelation?.(input) ?? Promise.resolve({ status: "skipped" });
  }

  private projectContexts(): ProjectContextConfig[] {
    const contexts = (this.config.projectContexts ?? []).filter((context) => context.enabled !== false);
    return contexts.length > 0 ? contexts : [defaultProjectContext(this.config)];
  }

  private defaultClient(): LinearTrackerClient {
    return this.clientFactoryFor(defaultProjectContext(this.config));
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

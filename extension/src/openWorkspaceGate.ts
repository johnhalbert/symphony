import type { StateSummary } from "./connectionState";
import type { DashboardSections, DashboardViewState, WorkspaceContext } from "./dashboardTypes";

export function isUsableWorkspaceContext(workspace: WorkspaceContext | null | undefined): boolean {
  return Boolean(workspace && (workspace.path || workspace.workspaceKey));
}

export function mutationPolicyBlockedReason(summary: Pick<StateSummary, "mutationsRequireToken" | "tokenConfigured">): string | null {
  if (summary.mutationsRequireToken === null) return "Mutation policy unavailable.";
  if (summary.mutationsRequireToken && !summary.tokenConfigured) return "Configure symphony.token to enable.";
  return null;
}

export function resolveWorkspaceContextForIssueKey(sections: DashboardSections | null, issueKey: string): WorkspaceContext | null {
  const key = issueKey.trim();
  if (!sections || !key) return null;

  for (const session of sections.activeSessions.data.sessions) {
    if (matchesIssueKey(key, session.issueKey, session.issueIdentifier)) return session.workspace;
  }

  for (const row of sections.operatorQueues.data.running) {
    if (matchesIssueKey(key, row.issueKey, row.issueIdentifier)) return row.workspace;
  }
  for (const row of sections.operatorQueues.data.paused) {
    if (matchesIssueKey(key, row.issueKey, row.issueIdentifier)) return row.workspace;
  }
  for (const row of sections.operatorQueues.data.orphaned) {
    if (matchesIssueKey(key, row.issueKey, row.issueIdentifier)) return row.workspace;
  }

  if (sections.board.status === "ready") {
    for (const issue of sections.board.data.issues) {
      if (matchesIssueKey(key, issue.issueKey, issue.issueIdentifier)) return issue.workspace;
    }
  }

  if (sections.workspaces.status === "ready") {
    for (const row of sections.workspaces.data.rows) {
      if (matchesIssueKey(key, row.issueKey, row.issueIdentifier)) {
        return {
          workspaceKey: row.workspaceKey,
          issueId: row.issueKey,
          issueIdentifier: row.issueIdentifier,
          path: row.path,
          sourceKind: row.sourceKind,
          branchName: row.branchName,
        };
      }
    }
  }

  return null;
}

export function openWorkspaceDisabledReason(
  issueKey: string | null,
  workspace: WorkspaceContext | null,
  summary: Pick<StateSummary, "mutationsRequireToken" | "tokenConfigured">,
): string | null {
  if (!issueKey?.trim()) return "Missing issue key.";
  if (!isUsableWorkspaceContext(workspace)) return "No workspace context.";
  return mutationPolicyBlockedReason(summary);
}

export function openWorkspaceProviderBlockedReason(state: DashboardViewState | null, issueKey: string, token: string): string | null {
  if (!state) return "Dashboard state unavailable.";
  if (state.connection.kind !== "connected") return "Dashboard state unavailable.";
  if (!issueKey.trim()) return "Missing issue key.";

  const mutationBlocked = mutationPolicyBlockedReason({
    mutationsRequireToken: state.connection.summary.mutationsRequireToken,
    tokenConfigured: token.trim().length > 0,
  });
  if (mutationBlocked) return mutationBlocked;

  const workspace = resolveWorkspaceContextForIssueKey(state.sections, issueKey);
  if (!isUsableWorkspaceContext(workspace)) return "No workspace context.";

  return null;
}

function matchesIssueKey(key: string, issueKey: string | null, issueIdentifier: string | null): boolean {
  return issueKey === key || issueIdentifier === key;
}

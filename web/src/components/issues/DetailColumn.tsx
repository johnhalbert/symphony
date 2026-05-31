import type { IssueModel } from "../../types/symphony";
import { Avatar, Icon, Label, Priority, STATUS_LABEL, StatusIcon } from "../common";
import { useReferenceData } from "../../data/referenceDataContext";
import { referenceDisplayName } from "../../data/referenceData";

interface DetailColumnProps {
  issue: IssueModel | null;
  issueId?: string | null;
  loading?: boolean;
  error?: string | null;
  emptyMessage?: string;
  onClose: () => void;
}

function priorityLabel(priority: IssueModel["priority"]): string {
  if (priority === "urgent") return "Urgent";
  return { 0: "None", 1: "Low", 2: "Medium", 3: "High" }[priority] ?? "Unknown";
}

export function DetailColumn({
  issue,
  issueId = issue?.id ?? null,
  loading = false,
  error = null,
  emptyMessage = "Select an issue to inspect details.",
  onClose,
}: DetailColumnProps) {
  const { users } = useReferenceData();

  if (loading || error || !issue) {
    const hasSelection = Boolean(issueId);
    return (
      <div className="issues__col">
        {hasSelection ? (
          <div className="colhead">
            <h3 style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--text-3)" }}>{issueId}</h3>
            <div className="grow" />
            <button className="icon-btn" title="Close" type="button" onClick={onClose}>
              {Icon.close()}
            </button>
          </div>
        ) : null}
        <div className="detail">
          {loading ? <div className="view-loading">Loading issue detail…</div> : null}
          {!loading && error ? <div className="view-error">Unable to load issue detail: {error}</div> : null}
          {!loading && !error ? <div className="view-empty">{emptyMessage}</div> : null}
        </div>
      </div>
    );
  }

  const assigneeName = referenceDisplayName(issue.assignee, users[issue.assignee]);

  return (
    <div className="issues__col">
      <div className="colhead">
        <h3 style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--text-3)" }}>{issue.id}</h3>
        <div className="grow" />
        <button className="icon-btn" title="Open in Linear" type="button">
          {Icon.link()}
        </button>
        <button className="icon-btn" title="More" type="button">
          {Icon.more()}
        </button>
        <button className="icon-btn" title="Close" type="button" onClick={onClose}>
          {Icon.close()}
        </button>
      </div>
      <div className="detail">
        <div className="detail__head">
          <div className="detail__crumbs">
            <span>Symphony</span>
            <span style={{ color: "var(--text-4)" }}>/</span>
            <span>{issue.project}</span>
            <span style={{ color: "var(--text-4)" }}>/</span>
            <span>{issue.cycle}</span>
            <div className="grow" />
          </div>
          <h1 className="detail__title">{issue.title}</h1>
          <div className="detail__actions">
            <button className="btn" type="button">
              <StatusIcon state={issue.status} />
              {STATUS_LABEL[issue.status]}
            </button>
            <button className="btn" type="button">
              <Priority level={issue.priority} />
              {priorityLabel(issue.priority)}
            </button>
            <button className="btn" type="button">
              <Avatar user={issue.assignee} /> {assigneeName}
            </button>
          </div>
        </div>
        <div className="detail__body">
          <div className="detail__section">
            <h4>Properties</h4>
            <div className="props">
              <span className="k">Status</span>
              <span className="v">
                <StatusIcon state={issue.status} />
                {STATUS_LABEL[issue.status]}
              </span>
              <span className="k">Priority</span>
              <span className="v">
                <Priority level={issue.priority} />
                {priorityLabel(issue.priority)}
              </span>
              <span className="k">Assignee</span>
              <span className="v">
                <Avatar user={issue.assignee} />
                {assigneeName}
              </span>
              <span className="k">Labels</span>
              <span className="v">
                {issue.labels.map((label) => (
                  <Label key={label} name={label} />
                ))}
              </span>
              <span className="k">Project</span>
              <span className="v">{issue.project}</span>
              <span className="k">Cycle</span>
              <span className="v">{issue.cycle}</span>
            </div>
          </div>
          <div className="detail__section">
            <h4>Description</h4>
            <div className="markdown">
              {(issue.desc || ["No description."]).map((paragraph, index) => (
                <p key={index}>{paragraph}</p>
              ))}
            </div>
          </div>
          <div className="detail__section">
            <h4>Symphony</h4>
            <div className="symphony-block">
              <div className="row">
                <span className="k">Workspace</span>
                <span className="v">{issue.workspace || "not assigned"}</span>
              </div>
              <div className="row">
                <span className="k">Session</span>
                <span className="v">{issue.session || "none"}</span>
              </div>
              <div className="row">
                <span className="k">Agent</span>
                <span className="v">{issue.agent || "none"}</span>
              </div>
              <div className="row">
                <span className="k">PR / CI</span>
                <span className="v">
                  {issue.pr || "no PR"} · {issue.ci || "pending"}
                </span>
              </div>
            </div>
          </div>
          <div className="detail__section">
            <h4>Activity</h4>
            {(issue.activity || []).length ? (
              (issue.activity || []).map((item) => (
                <div className="log-row" key={`${item.t}-${item.verb}-${item.val}`}>
                  <span className="dot" />
                  <span className="t">{item.t}</span>
                  <span className="verb">{item.verb}</span>
                  <span className="v">{item.val}</span>
                </div>
              ))
            ) : (
              <div className="view-empty">No issue activity available.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

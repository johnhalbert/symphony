import type { IssueModel } from "../../types/symphony";
import { Avatar, Icon, Label, Priority } from "../common";

export function IssueCard({
  issue,
  selected,
  onSelect,
}: {
  issue: IssueModel;
  selected: boolean;
  onSelect: (issueId: string) => void;
}) {
  const hasAgent = Boolean(issue.agent);
  return (
    <button
      className="card"
      data-selected={selected}
      onClick={() => onSelect(issue.id)}
      style={hasAgent ? { boxShadow: "inset 2px 0 0 var(--accent)", textAlign: "left" } : { textAlign: "left" }}
      type="button"
    >
      <div className="card__top">
        <span>{issue.id}</span>
        <Priority level={issue.priority} />
        <div className="grow" />
        {issue.pr ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--link)" }}>
            <span style={{ width: 11, height: 11, display: "inline-block" }}>{Icon.pr()}</span>
            {issue.pr}
          </span>
        ) : null}
      </div>
      <div className="card__title">{issue.title}</div>
      <div className="card__bottom">
        <div className="labels">
          {issue.labels.slice(0, 2).map((label) => (
            <Label key={label} name={label} />
          ))}
        </div>
        <div className="grow" />
        {hasAgent ? (
          <span className="card__agent">
            <span className="pulse-dot" />
            {issue.agent}
          </span>
        ) : null}
        <Avatar user={issue.assignee} />
      </div>
    </button>
  );
}

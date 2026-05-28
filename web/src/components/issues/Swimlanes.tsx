import type { IssueBoardModel, IssueModel } from "../../types/symphony";
import { Icon, StatusIcon } from "../common";
import { IssueCard } from "./IssueCard";

export function Swimlanes({
  board,
  selectedId,
  onSelect,
}: {
  board: IssueBoardModel;
  selectedId: string;
  onSelect: (issueId: string) => void;
}) {
  return (
    <div className="issues__col">
      <div className="colhead">
        <h3>{board.cycleLabel}</h3>
        <span className="count" style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-3)" }}>
          {board.cycleDateRange}
        </span>
        <div className="grow" />
        <button className="btn btn--ghost" type="button" style={{ padding: "3px 8px" }}>
          Group: status
        </button>
        <button className="icon-btn" type="button">
          {Icon.filter()}
        </button>
      </div>
      <div className="swimlanes">
        <Swimlane title="Todo" state="todo" items={board.lanes.todo} selectedId={selectedId} onSelect={onSelect} />
        <Swimlane title="In Progress" state="progress" items={board.lanes.progress} selectedId={selectedId} onSelect={onSelect} />
        <Swimlane title="In Review" state="review" items={board.lanes.review} selectedId={selectedId} onSelect={onSelect} />
      </div>
    </div>
  );
}

function Swimlane({
  title,
  state,
  items,
  selectedId,
  onSelect,
}: {
  title: string;
  state: string;
  items: IssueModel[];
  selectedId: string;
  onSelect: (issueId: string) => void;
}) {
  return (
    <div className="swim">
      <div className="swim__head">
        <h4>
          <StatusIcon state={state} />
          {title}
          <span className="count">{items.length}</span>
        </h4>
        <div className="grow" />
        <button className="icon-btn" type="button">
          {Icon.plus()}
        </button>
      </div>
      <div className="swim__body">
        {items.map((issue) => (
          <IssueCard key={issue.id} issue={issue} selected={issue.id === selectedId} onSelect={onSelect} />
        ))}
      </div>
    </div>
  );
}

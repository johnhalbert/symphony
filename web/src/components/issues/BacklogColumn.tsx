import { useMemo, useState } from "react";
import { useReferenceData } from "../../data/referenceDataContext";
import type { IssueModel } from "../../types/symphony";
import { Avatar, Icon, Priority, StatusIcon, UnavailableButton } from "../common";

export function BacklogColumn({
  backlog,
  selectedId,
  onSelect,
}: {
  backlog: IssueModel[];
  selectedId: string;
  onSelect: (issueId: string) => void;
}) {
  const { labels } = useReferenceData();
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return backlog;
    return backlog.filter((issue) =>
      [issue.id, issue.title, issue.project, issue.cycle, ...issue.labels].some((value) => value.toLowerCase().includes(needle)),
    );
  }, [backlog, query]);

  return (
    <div className="issues__col">
      <div className="colhead">
        <h3>
          Backlog <span className="count">{filtered.length}</span>
        </h3>
        <div className="grow" />
        <UnavailableButton className="icon-btn" title="Filter unavailable: use the search field below; no toolbar filter command route exists." unavailableLabel="Filter">
          {Icon.filter()}
        </UnavailableButton>
        <UnavailableButton className="icon-btn" unavailableLabel="Sort" unavailableReason="issue sorting is not backed by an API command route yet">
          {Icon.sort()}
        </UnavailableButton>
        <UnavailableButton className="icon-btn" unavailableLabel="New issue" unavailableReason="issue creation is unavailable until the backend exposes a command route">
          {Icon.plus()}
        </UnavailableButton>
      </div>
      <div style={{ minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <div className="backlog__search">
          <div className="field">
            {Icon.search()}
            <input placeholder="Filter by title, label, project..." value={query} onChange={(event) => setQuery(event.target.value)} />
            <span className="kbd">/</span>
          </div>
        </div>
        <div className="backlog__body">
          {filtered.map((issue) => (
            <button
              className="backlog__item"
              data-selected={issue.id === selectedId}
              key={issue.id}
              onClick={() => onSelect(issue.id)}
              style={{ textAlign: "left", width: "100%" }}
              type="button"
            >
              <StatusIcon state={issue.status} />
              <div className="ttl">
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span className="id">{issue.id}</span>
                  <Priority level={issue.priority} />
                </div>
                <span className="t">{issue.title}</span>
              </div>
              <div className="right">
                {issue.labels.slice(0, 1).map((label) => (
                  <span
                    key={label}
                    className="swatch-dot"
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: 999,
                      background: labels[label]?.color || "var(--text-4)",
                    }}
                  />
                ))}
                <Avatar user={issue.assignee} />
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

import { type CSSProperties, useEffect, useMemo, useState } from "react";
import type { IssueBoardModel, IssuesVariant } from "../../types/symphony";
import { BacklogColumn } from "./BacklogColumn";
import { DetailColumn } from "./DetailColumn";
import { Swimlanes } from "./Swimlanes";

export function resolveSelectedIssueId(
  currentSelectedId: string,
  board: Pick<IssueBoardModel, "issues" | "selectedIssueId">,
): string {
  if (currentSelectedId && board.issues.some((issue) => issue.id === currentSelectedId)) return currentSelectedId;
  return board.selectedIssueId;
}

export function IssuesView({
  board,
  variant = "balanced",
  detailDefaultOpen = true,
}: {
  board: IssueBoardModel;
  variant?: IssuesVariant;
  detailDefaultOpen?: boolean;
}) {
  const [selectedId, setSelectedId] = useState(board.selectedIssueId);
  const [detailOpen, setDetailOpen] = useState(detailDefaultOpen);

  useEffect(() => {
    setSelectedId((currentSelectedId) => resolveSelectedIssueId(currentSelectedId, board));
  }, [board.issues, board.selectedIssueId]);

  const selectedIssue = useMemo(() => board.issues.find((issue) => issue.id === selectedId) ?? null, [board.issues, selectedId]);
  const columns = variant === "detail-heavy" ? "240px minmax(0, 1fr) 480px" : "280px minmax(0, 1fr) 400px";
  const closedColumns = `${columns.split(" ").slice(0, 2).join(" ")} 0`;
  const layoutStyle = {
    "--issues-columns": columns,
    "--issues-columns-closed": closedColumns,
  } as CSSProperties;

  function selectIssue(issueId: string) {
    setSelectedId(issueId);
    setDetailOpen(true);
  }

  return (
    <div
      className="issues"
      data-detail={detailOpen}
      style={layoutStyle}
    >
      <BacklogColumn backlog={board.backlog} selectedId={selectedId} onSelect={selectIssue} />
      <Swimlanes board={board} selectedId={selectedId} onSelect={selectIssue} />
      {detailOpen ? <DetailColumn issue={selectedIssue} onClose={() => setDetailOpen(false)} /> : null}
    </div>
  );
}

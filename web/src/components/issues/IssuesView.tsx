import { type CSSProperties, useEffect, useState } from "react";
import { useIssueDetail } from "../../hooks/useSymphonyData";
import type { IssueBoardModel, IssuesVariant } from "../../types/symphony";
import { BacklogColumn } from "./BacklogColumn";
import { DetailColumn } from "./DetailColumn";
import { Swimlanes } from "./Swimlanes";

export function resolveSelectedIssueId(
  currentSelectedId: string,
  board: Pick<IssueBoardModel, "issues" | "selectedIssueId">,
): string {
  if (currentSelectedId && board.issues.some((issue) => issue.id === currentSelectedId)) return currentSelectedId;
  if (board.selectedIssueId && board.issues.some((issue) => issue.id === board.selectedIssueId)) return board.selectedIssueId;
  return board.issues[0]?.id ?? "";
}

export function IssuesView({
  board,
  variant = "balanced",
  detailDefaultOpen = true,
  refreshToken,
}: {
  board: IssueBoardModel;
  variant?: IssuesVariant;
  detailDefaultOpen?: boolean;
  refreshToken?: unknown;
}) {
  const [selectedId, setSelectedId] = useState(board.selectedIssueId);
  const [detailOpen, setDetailOpen] = useState(detailDefaultOpen);

  useEffect(() => {
    setSelectedId((currentSelectedId) => resolveSelectedIssueId(currentSelectedId, board));
  }, [board.issues, board.selectedIssueId]);

  const effectiveSelectedId = resolveSelectedIssueId(selectedId, board);
  const selectedDetailId = detailOpen && effectiveSelectedId ? effectiveSelectedId : null;
  const issueDetail = useIssueDetail(selectedDetailId, refreshToken);
  const detailEmptyMessage = board.issues.length === 0
    ? "No issue detail is available because the current issue projection is empty."
    : selectedDetailId
      ? "Issue detail not found or unavailable."
      : undefined;
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
      <BacklogColumn backlog={board.backlog} selectedId={effectiveSelectedId} onSelect={selectIssue} />
      <Swimlanes board={board} selectedId={effectiveSelectedId} onSelect={selectIssue} />
      {detailOpen ? (
        <DetailColumn
          issue={issueDetail.data?.issue ?? null}
          workspace={issueDetail.data?.workspace ?? null}
          issueId={selectedDetailId}
          loading={Boolean(selectedDetailId) && issueDetail.loading}
          error={issueDetail.error}
          emptyMessage={detailEmptyMessage}
          onClose={() => setDetailOpen(false)}
        />
      ) : null}
    </div>
  );
}

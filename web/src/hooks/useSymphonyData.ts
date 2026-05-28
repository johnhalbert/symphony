import { useCallback } from "react";
import { useDataSource } from "../data/dataSourceContext";
import { useAsyncResource } from "./useAsyncResource";

export function useReferenceData() {
  const dataSource = useDataSource();
  return useAsyncResource(useCallback(() => dataSource.getReferenceData(), [dataSource]), [dataSource]);
}

export function useDashboard() {
  const dataSource = useDataSource();
  return useAsyncResource(useCallback(() => dataSource.getDashboard(), [dataSource]), [dataSource]);
}

export function useIssueBoard() {
  const dataSource = useDataSource();
  return useAsyncResource(useCallback(() => dataSource.getIssueBoard(), [dataSource]), [dataSource]);
}

export function useIssueDetail(issueId: string | null) {
  const dataSource = useDataSource();
  return useAsyncResource(
    useCallback(() => (issueId ? dataSource.getIssueDetail(issueId) : Promise.resolve(null)), [dataSource, issueId]),
    [dataSource, issueId],
  );
}

export function useHistory() {
  const dataSource = useDataSource();
  return useAsyncResource(useCallback(() => dataSource.getHistory(), [dataSource]), [dataSource]);
}

export function useTranscript(sessionId: string | null) {
  const dataSource = useDataSource();
  return useAsyncResource(
    useCallback(() => (sessionId ? dataSource.getTranscript(sessionId) : Promise.resolve([])), [dataSource, sessionId]),
    [dataSource, sessionId],
  );
}

export function useSidebar() {
  const dataSource = useDataSource();
  return useAsyncResource(useCallback(() => dataSource.getSidebar(), [dataSource]), [dataSource]);
}

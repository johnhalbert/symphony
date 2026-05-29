import { useCallback, useEffect, useState } from "react";
import { useDataSource } from "../data/dataSourceContext";
import { useAsyncResource } from "./useAsyncResource";
import type { IssueDetailModel, Loadable } from "../types/symphony";

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

export function useIssueDetail(issueId: string | null): Loadable<IssueDetailModel | null> {
  const dataSource = useDataSource();
  const normalizedIssueId = issueId || null;
  const [state, setState] = useState<Loadable<IssueDetailModel | null> & { issueId: string | null }>({
    issueId: normalizedIssueId,
    data: null,
    loading: Boolean(normalizedIssueId),
    error: null,
  });

  useEffect(() => {
    let active = true;
    if (!normalizedIssueId) {
      setState({ issueId: null, data: null, loading: false, error: null });
      return () => {
        active = false;
      };
    }

    setState({ issueId: normalizedIssueId, data: null, loading: true, error: null });
    dataSource
      .getIssueDetail(normalizedIssueId)
      .then((data) => {
        if (active) setState({ issueId: normalizedIssueId, data, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (!active) return;
        const message = error instanceof Error ? error.message : String(error);
        setState({ issueId: normalizedIssueId, data: null, loading: false, error: message });
      });

    return () => {
      active = false;
    };
  }, [dataSource, normalizedIssueId]);

  if (state.issueId !== normalizedIssueId) {
    return { data: null, loading: Boolean(normalizedIssueId), error: null };
  }

  return { data: state.data, loading: state.loading, error: state.error };
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

export function useOrchestratorChat() {
  const dataSource = useDataSource();
  return useAsyncResource(useCallback(() => dataSource.getOrchestratorChat(), [dataSource]), [dataSource]);
}

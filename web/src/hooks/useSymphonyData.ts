import { useCallback, useEffect, useState } from "react";
import { useDataSource } from "../data/dataSourceContext";
import { useAsyncResource } from "./useAsyncResource";
import type { ChatMessage, IssueDetailModel, Loadable, TranscriptMessage } from "../types/symphony";

interface SymphonyResourceOptions {
  enabled?: boolean;
}

export function useReferenceData(options: SymphonyResourceOptions = {}) {
  const dataSource = useDataSource();
  return useAsyncResource(useCallback((signal?: AbortSignal) => dataSource.getReferenceData(signal), [dataSource]), [dataSource], options);
}

export function useDashboard(options: SymphonyResourceOptions = {}) {
  const dataSource = useDataSource();
  return useAsyncResource(useCallback((signal?: AbortSignal) => dataSource.getDashboard(signal), [dataSource]), [dataSource], options);
}

export function useIssueBoard(options: SymphonyResourceOptions = {}) {
  const dataSource = useDataSource();
  return useAsyncResource(useCallback((signal?: AbortSignal) => dataSource.getIssueBoard(signal), [dataSource]), [dataSource], options);
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

    const controller = new AbortController();
    setState({ issueId: normalizedIssueId, data: null, loading: true, error: null });
    dataSource
      .getIssueDetail(normalizedIssueId, controller.signal)
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
      controller.abort();
    };
  }, [dataSource, normalizedIssueId]);

  if (state.issueId !== normalizedIssueId) {
    return { data: null, loading: Boolean(normalizedIssueId), error: null };
  }

  return { data: state.data, loading: state.loading, error: state.error };
}

export function useHistory(options: SymphonyResourceOptions = {}) {
  const dataSource = useDataSource();
  return useAsyncResource(useCallback((signal?: AbortSignal) => dataSource.getHistory(signal), [dataSource]), [dataSource], options);
}

export function useTranscript(sessionId: string | null): Loadable<TranscriptMessage[]> {
  const dataSource = useDataSource();
  const normalizedSessionId = sessionId || null;
  const [state, setState] = useState<Loadable<TranscriptMessage[]> & { sessionId: string | null }>({
    sessionId: normalizedSessionId,
    data: normalizedSessionId ? null : [],
    loading: Boolean(normalizedSessionId),
    error: null,
  });

  useEffect(() => {
    let active = true;
    if (!normalizedSessionId) {
      setState({ sessionId: null, data: [], loading: false, error: null });
      return () => {
        active = false;
      };
    }

    const controller = new AbortController();
    setState({ sessionId: normalizedSessionId, data: null, loading: true, error: null });
    dataSource
      .getTranscript(normalizedSessionId, controller.signal)
      .then((data) => {
        if (active) setState({ sessionId: normalizedSessionId, data, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (!active) return;
        const message = error instanceof Error ? error.message : String(error);
        setState({ sessionId: normalizedSessionId, data: null, loading: false, error: message });
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [dataSource, normalizedSessionId]);

  if (state.sessionId !== normalizedSessionId) {
    return { data: normalizedSessionId ? null : [], loading: Boolean(normalizedSessionId), error: null };
  }

  return { data: state.data, loading: state.loading, error: state.error };
}

export function useSidebar(options: SymphonyResourceOptions = {}) {
  const dataSource = useDataSource();
  return useAsyncResource(useCallback((signal?: AbortSignal) => dataSource.getSidebar(signal), [dataSource]), [dataSource], options);
}

export function useOrchestratorChat(options: SymphonyResourceOptions = {}) {
  const dataSource = useDataSource();
  const enabled = options.enabled ?? true;
  const [state, setState] = useState<Loadable<ChatMessage[]> & { enabled: boolean }>({
    data: null,
    loading: enabled,
    error: null,
    enabled,
  });

  useEffect(() => {
    if (!enabled) {
      setState((current) => ({ data: current.data, loading: false, error: null, enabled: false }));
      return;
    }

    let active = true;
    const controller = new AbortController();
    setState((current) => ({ data: current.data, loading: true, error: null, enabled: true }));
    dataSource
      .getOrchestratorChat(controller.signal)
      .then((data) => {
        if (active) setState({ data, loading: false, error: null, enabled: true });
      })
      .catch((error: unknown) => {
        if (!active) return;
        const message = error instanceof Error ? error.message : String(error);
        setState({ data: null, loading: false, error: message, enabled: true });
      });

    const unsubscribe = dataSource.subscribeOrchestratorChat?.(
      (data) => {
        if (active) setState({ data, loading: false, error: null, enabled: true });
      },
      (message) => {
        if (active) setState((current) => ({ data: current.data, loading: false, error: message, enabled: true }));
      },
    );

    return () => {
      active = false;
      controller.abort();
      unsubscribe?.();
    };
  }, [dataSource, enabled]);

  if (enabled && !state.enabled) return { data: state.data, loading: true, error: null };
  return { data: state.data, loading: state.loading, error: state.error };
}
